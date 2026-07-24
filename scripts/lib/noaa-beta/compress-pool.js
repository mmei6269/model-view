"use strict";

// Compression helper pool for render workers. PNG IDAT deflate and hover
// gzip/Brotli are deterministic pure functions of (bytes, level), but they ran
// inline on the frame worker's JS thread — ~1.65s of a warm serial frame
// serialized with raster/quantize work that needs only ~0.9s of that window.
// The pool moves those codec calls onto helper threads so they overlap the
// remaining render work; outputs are byte-identical because the helpers run
// the exact same codec entry points on the same bytes.
//
// Transport contract:
//   - submit() is the generic API. It always structured-clones its input, so
//     arbitrary callers retain fallback bytes and mutation isolation.
//   - submitOwned() is reserved for renderer-owned PNG scanline leases. An
//     exact ArrayBuffer is transferred to the helper and transferred back
//     with the result. Owned jobs are admitted immediately or rejected while
//     still attached; they are never parked in the generic waiter queue.
//   - submitShared() accepts a bounded SharedArrayBuffer or SAB-backed view.
//     Hover packing publishes a nonzero-offset immutable wire view inside its
//     growable owner, so explicit offset/length fields keep both worker and
//     inline fallback on the same exact range without another full-body copy.
// Every failure falls back at the renderer boundary. A dead pool stays dead
// for the process; detached/lost owned inputs are discarded and reconstructed
// from the renderer's immutable RGBA/index owner.
// MODELVIEW_NOAA_COMPRESS_THREADS=0 (or --compress-threads=0) disables the
// pool entirely; MODELVIEW_NOAA_TEST_COMPRESS_SPAWN_ERROR is the test-only
// spawn fault-injection hook (mirrors the derived pool's).
//
// Backpressure: at most maxPending jobs (default 2x thread count, clamped
// 1..64, MODELVIEW_NOAA_COMPRESS_MAX_PENDING) may be in flight — dispatched
// to a worker but not settled. submit() past the cap parks the caller's
// promise on a FIFO wait queue instead of queueing another worker message;
// the parked job snapshots its input synchronously (Buffer.from) because the
// png-encode caller releases its shared scanline scratch the moment submit
// returns — the parked copy freezes the exact bytes today's synchronous
// postMessage clone would see. Completions drain waiters in submit order, so
// each caller still settles with its own job's bytes. markDead rejects
// in-flight jobs AND parked waiters, releasing every waiter into the same
// per-call inline fallback (identical counters) — a dead pool never
// deadlocks submitters.

const path = require("path");
const zlib = require("zlib");
const { Worker } = require("worker_threads");
const { deflatePngIdatSync } = require("./deflate-backend");
const { clampInt } = require("./util");

const COMPRESS_WORKER_PATH = path.resolve(__dirname, "../../noaa-beta-compress-worker.js");
const COMPRESS_PROTOCOL_VERSION = 3;
const COMPRESS_REQUEST_TYPE = "compress";
const COMPRESS_RESULT_TYPE = "compress-result";
const INPUT_MODE_CLONE = "clone";
const INPUT_MODE_OWNED = "owned-array-buffer";
const INPUT_MODE_SHARED = "shared-array-buffer";
const SHARED_INPUT_COMPRESSORS = new WeakSet();
const SHARED_COUNTER_OWNERS = new WeakMap();

function compressSync(kind, buffer, level) {
  if (kind === "gzip") {
    return zlib.gzipSync(buffer, { level: clampInt(level, 0, 9, 1) });
  }
  if (kind === "brotli") {
    return zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: clampInt(level, 0, 11, 0),
      },
    });
  }
  return deflatePngIdatSync(buffer, clampInt(level, 0, 9, 1));
}

class CompressPool {
  constructor(threads, maxPending = null) {
    this.dead = false;
    this.nextJobId = 1;
    // A separate never-reused BigInt token prevents a delayed duplicate from
    // settling a different job even if tests or extreme process lifetime wrap
    // the compact numeric id (ABA protection).
    this.nextJobToken = 1n;
    this.pendingById = new Map();
    this.waiters = [];
    this.maxPending = resolveCompressMaxPending(maxPending, threads);
    this.workers = [];
    this.nextWorkerIndex = 0;
    // Returned PNG scanline owners are retained here for reuse. The free +
    // checked-out total can never exceed maxPending, matching the global
    // artifact admission budget. Different raster sizes replace a free slab
    // instead of growing a per-size cache.
    this.ownedInputFree = [];
    this.ownedInputLeases = new Set();
    this.ownedInputPeak = 0;
    this.ownedInputPeakBytes = 0;
    if (process.env.MODELVIEW_NOAA_TEST_COMPRESS_SPAWN_ERROR) {
      throw new Error("test-injected compress worker spawn failure");
    }
    for (let index = 0; index < threads; index += 1) {
      const worker = new Worker(COMPRESS_WORKER_PATH);
      worker.unref();
      worker.on("message", (message) => this._onMessage(message));
      worker.on("messageerror", (error) =>
        this._onWorkerFailure(
          error instanceof Error ? error : new Error(`compress worker message error: ${String(error)}`),
        ),
      );
      worker.on("error", (error) => this._onWorkerFailure(error));
      worker.on("exit", (code) => {
        // Any exit is unexpected (helpers live for the process lifetime, and a
        // terminate() can report code 0); an unmarked death would strand
        // in-flight jobs and all future submits. Mirrors FrameWorkerPool.
        this._onWorkerFailure(new Error(`compress worker exited with code ${code}`));
      });
      this.workers.push(worker);
    }
  }

  _onMessage(message) {
    const pending = this.pendingById.get(message?.id);
    if (!pending) {
      return;
    }
    if (message?.token !== pending.token) {
      // A delayed duplicate/stale response is benign. The current job with
      // the reused numeric id remains pending for its own token.
      return;
    }
    if (
      message?.type !== COMPRESS_RESULT_TYPE ||
      message.protocolVersion !== COMPRESS_PROTOCOL_VERSION ||
      message.inputMode !== pending.inputMode ||
      (pending.inputMode === INPUT_MODE_SHARED &&
        (message.inputByteOffset !== pending.sharedRange.byteOffset ||
          message.inputByteLength !== pending.sharedRange.byteLength)) ||
      typeof message.ok !== "boolean"
    ) {
      this.markDead(new Error(`compress worker protocol violation for job ${String(message?.id)}`));
      return;
    }
    if (pending.inputMode === INPUT_MODE_OWNED) {
      if (message.ok && message.body === message.input) {
        // A codec body must never alias the slab returned for recycling. If
        // it did, the next lease checkout could overwrite a caller's already
        // resolved IDAT bytes. The current worker always allocates a distinct
        // output, but fail closed on future/malformed protocol peers.
        this.markDead(new Error(`compress worker aliased owned input for job ${message.id}`));
        return;
      }
      if (
        !(message.input instanceof ArrayBuffer) ||
        message.input.byteLength !== pending.ownedLease.byteLength ||
        !this._restoreOwnedInput(pending.ownedLease, message.input)
      ) {
        this.markDead(new Error(`compress worker lost owned input for job ${message.id}`));
        return;
      }
    }
    if (message.ok && (!(message.body instanceof ArrayBuffer) || message.body.byteLength === 0)) {
      this.markDead(new Error(`compress worker returned an invalid body for job ${message.id}`));
      return;
    }
    this.pendingById.delete(message.id);
    if (message.ok) {
      const body = Buffer.from(message.body);
      pending.resolve(
        pending.inputMode === INPUT_MODE_OWNED
          ? {
              body,
              lease: pending.ownedLease,
            }
          : body,
      );
    } else {
      const error = new Error(message.error || "compress worker failure");
      error.code = "ERR_COMPRESS_WORKER";
      pending.reject(error);
    }
    this._drainWaiters();
  }

  // Freed in-flight slots are refilled from the FIFO wait queue. Each parked
  // job already holds its synchronous input snapshot, so dispatching it later
  // is byte-identical to having queued the worker message at submit time.
  _drainWaiters() {
    while (!this.dead && this.waiters.length > 0 && this.pendingById.size < this.maxPending) {
      const waiter = this.waiters.shift();
      this._dispatchClone(waiter.kind, waiter.input, waiter.level).then(waiter.resolve, waiter.reject);
    }
  }

  _onWorkerFailure(error) {
    // A dead helper rejects everything in flight; submitters fall back to
    // the inline codec (they retained their input copies). The pool is
    // marked dead so later jobs go straight inline.
    this.markDead(error);
  }

  markDead(error) {
    if (this.dead) {
      return;
    }
    this.dead = true;
    const reason = error instanceof Error ? error : new Error(String(error));
    const pending = Array.from(this.pendingById.values());
    this.pendingById.clear();
    for (const entry of pending) {
      if (entry.inputMode === INPUT_MODE_OWNED) {
        this._loseOwnedInput(entry.ownedLease);
      }
      entry.reject(reason);
    }
    // Parked (backpressured) submitters are released into their inline
    // fallback too; a dead pool must never leave waiters hanging.
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(reason);
    }
    for (const worker of this.workers) {
      worker.terminate().catch(() => {});
    }
    this.workers = [];
    // A dead pool never reuses a slab, even one returned by a job that
    // completed just before another helper died.
    this.ownedInputFree = [];
    for (const lease of this.ownedInputLeases) {
      if (lease.state === "attached") {
        lease.state = "orphaned-attached";
      } else {
        lease.state = "lost";
        lease.buffer = null;
      }
    }
    this.ownedInputLeases.clear();
  }

  submit(kind, buffer, level) {
    if (this.dead || this.workers.length === 0) {
      return Promise.reject(new Error("compress pool is not available"));
    }
    if (this.pendingById.size >= this.maxPending) {
      // Backpressure: park until a completion frees an in-flight slot (or the
      // pool dies). The input is snapshotted NOW, synchronously: callers such
      // as deflatePngIdatViaPool release their shared scanline scratch as soon
      // as submit returns, so deferring the copy to dispatch time could
      // deflate overwritten scratch bytes.
      const input = snapshotGenericInput(buffer);
      return new Promise((resolve, reject) => {
        this.waiters.push({ kind, input, level, resolve, reject });
      });
    }
    // Structured clone copies ordinary ArrayBuffers synchronously, but SABs
    // remain shared. Generic callers have not opted into the renderer's
    // immutable shared-input ABI, so isolate SAB-backed inputs first.
    return this._dispatchClone(kind, isolateGenericSharedInput(buffer), level);
  }

  _dispatchClone(kind, buffer, level) {
    return this._dispatch({
      kind,
      input: buffer,
      inputMode: INPUT_MODE_CLONE,
      level,
    });
  }

  // Returns an exact owned ArrayBuffer lease or null when the global
  // admission budget has already checked out maxPending slabs. Callers build
  // scanlines only after acquiring this lease, so no transferred owner can
  // ever live in the pool's generic wait queue.
  acquireOwnedInput(byteLength) {
    if (this.dead || this.workers.length === 0) {
      return null;
    }
    const size = normalizeOwnedInputSize(byteLength);
    let buffer;
    const matchingIndex = this.ownedInputFree.findIndex((candidate) => candidate.byteLength === size);
    if (matchingIndex >= 0) {
      buffer = this.ownedInputFree.splice(matchingIndex, 1)[0];
    } else if (this.ownedInputFree.length > 0) {
      // Bound the cache by replacing one idle size rather than retaining a
      // slab for every raster dimension encountered by a long-lived worker.
      this.ownedInputFree.pop();
      buffer = new ArrayBuffer(size);
    } else if (this.ownedInputLeases.size < this.maxPending) {
      buffer = new ArrayBuffer(size);
    } else {
      return null;
    }
    const lease = {
      pool: this,
      byteLength: size,
      buffer,
      state: "attached",
    };
    this.ownedInputLeases.add(lease);
    this.ownedInputPeak = Math.max(this.ownedInputPeak, this.ownedInputLeases.size);
    this.ownedInputPeakBytes = Math.max(this.ownedInputPeakBytes, this._ownedInputLiveBytes());
    return lease;
  }

  releaseOwnedInput(lease) {
    if (!this.ownedInputLeases.has(lease)) {
      return false;
    }
    this.ownedInputLeases.delete(lease);
    const reusable =
      !this.dead &&
      lease?.pool === this &&
      lease.state === "attached" &&
      lease.buffer instanceof ArrayBuffer &&
      lease.buffer.byteLength === lease.byteLength;
    if (reusable) {
      this.ownedInputFree.push(lease.buffer);
      // Defensive bound: malformed direct callers cannot grow the recycler
      // beyond the same cap that constrains in-flight codec jobs.
      while (this.ownedInputFree.length > this.maxPending) {
        this.ownedInputFree.pop();
      }
    }
    lease.state = reusable ? "released" : "discarded";
    lease.buffer = null;
    return reusable;
  }

  submitOwned(kind, lease, level) {
    if (
      !this.ownedInputLeases.has(lease) ||
      lease?.pool !== this ||
      lease.state !== "attached" ||
      !(lease.buffer instanceof ArrayBuffer) ||
      lease.buffer.byteLength !== lease.byteLength
    ) {
      return Promise.reject(new Error("compress owned input lease is not attached"));
    }
    if (this.dead || this.workers.length === 0) {
      return Promise.reject(new Error("compress pool is not available"));
    }
    if (this.pendingById.size >= this.maxPending || this.waiters.length > 0) {
      return Promise.reject(new Error("compress pool has no immediate owned-input admission"));
    }
    return this._dispatch({
      kind,
      input: lease.buffer,
      inputMode: INPUT_MODE_OWNED,
      level,
      ownedLease: lease,
      transferList: [lease.buffer],
    });
  }

  submitShared(kind, buffer, level) {
    if (this.dead || this.workers.length === 0) {
      return Promise.reject(new Error("compress pool is not available"));
    }
    if (this.pendingById.size >= this.maxPending || this.waiters.length > 0) {
      return Promise.reject(new Error("compress pool has no immediate shared-input admission"));
    }
    const sharedRange = normalizeSharedInputRange(buffer);
    return this._submitSharedRange(kind, sharedRange, level);
  }

  // Renderer-private companion for createCompressor.shared: that boundary
  // already normalized and retained the immutable range for inline fallback,
  // so dispatch the exact same descriptor instead of rereading a GSAB size.
  _submitSharedRange(kind, sharedRange, level) {
    if (this.dead || this.workers.length === 0) {
      return Promise.reject(new Error("compress pool is not available"));
    }
    if (this.pendingById.size >= this.maxPending || this.waiters.length > 0) {
      return Promise.reject(new Error("compress pool has no immediate shared-input admission"));
    }
    return this._dispatch({
      kind,
      input: sharedRange.buffer,
      inputMode: INPUT_MODE_SHARED,
      level,
      sharedRange,
    });
  }

  canUseSharedInput() {
    return !this.dead && this.workers.length > 0;
  }

  _dispatch({ kind, input, inputMode, level, ownedLease = null, sharedRange = null, transferList = undefined }) {
    const id = this._allocateJobId();
    const token = this.nextJobToken;
    this.nextJobToken += 1n;
    const worker = this.workers[this.nextWorkerIndex % this.workers.length];
    this.nextWorkerIndex += 1;
    return new Promise((resolve, reject) => {
      this.pendingById.set(id, { inputMode, ownedLease, sharedRange, token, resolve, reject });
      try {
        worker.postMessage(
          {
            type: COMPRESS_REQUEST_TYPE,
            protocolVersion: COMPRESS_PROTOCOL_VERSION,
            id,
            token,
            inputMode,
            kind,
            input,
            level,
            ...(sharedRange
              ? {
                  inputByteOffset: sharedRange.byteOffset,
                  inputByteLength: sharedRange.byteLength,
                }
              : {}),
          },
          transferList,
        );
        if (ownedLease) {
          ownedLease.state = "in-flight";
        }
      } catch (error) {
        this.pendingById.delete(id);
        if (ownedLease) {
          if (ownedLease.buffer instanceof ArrayBuffer && ownedLease.buffer.byteLength === ownedLease.byteLength) {
            ownedLease.state = "attached";
          } else {
            this._loseOwnedInput(ownedLease);
          }
        }
        this._drainWaiters();
        reject(error);
      }
    });
  }

  _allocateJobId() {
    // At most pending.size candidates can be occupied, so inspecting one more
    // id must find a free slot without an unbounded/constant-condition loop.
    const candidateCount = this.pendingById.size + 1;
    let id = this.nextJobId;
    for (let candidate = 0; candidate < candidateCount; candidate += 1) {
      if (!Number.isSafeInteger(id) || id < 1 || id >= Number.MAX_SAFE_INTEGER) {
        id = 1;
      }
      this.nextJobId = id + 1;
      if (!this.pendingById.has(id)) {
        return id;
      }
      id = this.nextJobId;
    }
    throw new Error("compress pool could not allocate a job id");
  }

  _restoreOwnedInput(lease, buffer) {
    if (!this.ownedInputLeases.has(lease) || lease.state !== "in-flight") {
      return false;
    }
    lease.buffer = buffer;
    lease.state = "attached";
    return true;
  }

  _loseOwnedInput(lease) {
    if (!lease) {
      return;
    }
    this.ownedInputLeases.delete(lease);
    lease.buffer = null;
    lease.state = "lost";
  }

  ownedInputTelemetry() {
    const checkedOutBytes = Array.from(this.ownedInputLeases, (lease) => lease.byteLength).reduce(
      (sum, value) => sum + value,
      0,
    );
    const freeBytes = this.ownedInputFree.reduce((sum, buffer) => sum + buffer.byteLength, 0);
    return {
      checkedOut: this.ownedInputLeases.size,
      checkedOutBytes,
      free: this.ownedInputFree.length,
      freeBytes,
      liveBytes: checkedOutBytes + freeBytes,
      peakCheckedOut: this.ownedInputPeak,
      peakLiveBytes: this.ownedInputPeakBytes,
      maxPending: this.maxPending,
    };
  }

  _ownedInputLiveBytes() {
    const checkedOutBytes = Array.from(this.ownedInputLeases, (lease) => lease.byteLength).reduce(
      (sum, value) => sum + value,
      0,
    );
    return checkedOutBytes + this.ownedInputFree.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  }
}

function normalizeOwnedInputSize(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new RangeError(`invalid owned compress input size '${String(value)}'`);
  }
  return numeric;
}

function normalizeSharedInputRange(value) {
  const buffer =
    value instanceof SharedArrayBuffer
      ? value
      : ArrayBuffer.isView(value) && value.buffer instanceof SharedArrayBuffer
        ? value.buffer
        : null;
  if (!buffer) {
    throw new TypeError("shared compress input must be a SharedArrayBuffer or a view backed by one");
  }
  const byteOffset = value instanceof SharedArrayBuffer ? 0 : Number(value.byteOffset);
  const byteLength = value instanceof SharedArrayBuffer ? value.byteLength : Number(value.byteLength);
  const end = byteOffset + byteLength;
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    !Number.isSafeInteger(end) ||
    end > buffer.byteLength
  ) {
    throw new RangeError("shared compress input range is unsafe or outside its current backing");
  }
  return {
    buffer,
    byteOffset,
    byteLength,
    backingByteLength: buffer.byteLength,
    maxByteLength: Number(buffer.maxByteLength) || buffer.byteLength,
  };
}

function isolateGenericSharedInput(value) {
  if (value instanceof SharedArrayBuffer || (ArrayBuffer.isView(value) && value.buffer instanceof SharedArrayBuffer)) {
    return snapshotGenericInput(value);
  }
  return value;
}

function snapshotGenericInput(value) {
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
    return Buffer.from(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  throw new TypeError("generic compress input must be an ArrayBuffer view");
}

let sharedPool = null;
let sharedPoolThreads = 0;
let poolFailureWarned = false;

function resolveCompressThreads(value) {
  return clampInt(value, 0, 4, 1);
}

// In-flight cap for backpressure: default 2x the (clamped) thread count so
// every worker can have one job running plus one queued, clamped to 1..64.
// Blank/unset values take the default; MODELVIEW_NOAA_COMPRESS_MAX_PENDING
// overrides it for the shared pool.
function resolveCompressMaxPending(value, threads) {
  const fallback = Math.max(1, resolveCompressThreads(threads) * 2);
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return clampInt(value, 1, 64, fallback);
}

// One pool per render-worker process, created lazily at the first frame that
// asks for one. Thread-count differences after creation keep the first pool
// (bytes are identical either way; only overlap changes).
function getSharedCompressPool(threads) {
  const resolved = resolveCompressThreads(threads);
  if (resolved <= 0) {
    return null;
  }
  if (sharedPool && !sharedPool.dead) {
    return sharedPool;
  }
  if (sharedPool?.dead) {
    return null;
  }
  try {
    sharedPool = new CompressPool(resolved, process.env.MODELVIEW_NOAA_COMPRESS_MAX_PENDING);
    sharedPoolThreads = resolved;
  } catch (error) {
    warnPoolFailure(error);
    sharedPool = { dead: true };
    return null;
  }
  return sharedPool;
}

function warnPoolFailure(error) {
  if (poolFailureWarned) {
    return;
  }
  poolFailureWarned = true;
  console.warn(`[noaa-beta] compression pool unavailable; compressing inline: ${String(error?.message || error)}`);
}

// The renderer-facing compressor: async, byte-identical to the inline codec,
// and containment-complete. counters.jobs / counters.fallbacks feed the
// render profile (compressPoolJobs / compressPoolFallbacks).
function createCompressor(pool, counters = null) {
  const compress = async function compress(kind, buffer, level) {
    // Retain one immutable owner for the complete generic operation. Besides
    // preventing SAB mutation races, this guarantees that a later worker
    // failure and inline fallback consume the same bytes postMessage saw.
    const input = snapshotGenericInput(buffer);
    if (pool && !pool.dead) {
      try {
        const body = await pool.submit(kind, input, level);
        if (counters) {
          counters.jobs += 1;
          counters.cloneInputJobs = (Number(counters.cloneInputJobs) || 0) + 1;
          counters.cloneInputBytes = (Number(counters.cloneInputBytes) || 0) + input.byteLength;
        }
        return body;
      } catch (error) {
        warnPoolFailure(error);
      }
    }
    if (counters) {
      counters.fallbacks += 1;
    }
    return compressSync(kind, input, level);
  };
  // Renderer-owned hover bodies are packed directly into one immutable SAB.
  // The property keeps the generic callable API backwards-compatible while
  // making the no-clone path explicit at its only trusted call site.
  compress.shared = async function compressShared(kind, buffer, level) {
    const sharedRange = normalizeSharedInputRange(buffer);
    beginSharedTransportInput(counters, sharedRange, pool);
    try {
      if (pool && !pool.dead && typeof pool.submitShared === "function") {
        try {
          const body =
            typeof pool._submitSharedRange === "function"
              ? await pool._submitSharedRange(kind, sharedRange, level)
              : await pool.submitShared(kind, buffer, level);
          if (counters) {
            counters.jobs += 1;
            counters.sharedInputJobs = (Number(counters.sharedInputJobs) || 0) + 1;
            counters.sharedInputBytes = (Number(counters.sharedInputBytes) || 0) + sharedRange.byteLength;
          }
          return body;
        } catch (error) {
          warnPoolFailure(error);
        }
      }
      if (counters) {
        counters.fallbacks += 1;
        counters.sharedInputFallbacks = (Number(counters.sharedInputFallbacks) || 0) + 1;
      }
      return compressSync(kind, Buffer.from(sharedRange.buffer, sharedRange.byteOffset, sharedRange.byteLength), level);
    } finally {
      endSharedTransportInput(counters, sharedRange, pool);
    }
  };
  compress.canUseSharedInput = () =>
    Boolean(pool && !pool.dead && typeof pool.submitShared === "function" && pool.canUseSharedInput());
  SHARED_INPUT_COMPRESSORS.add(compress);
  return compress;
}

function isSharedInputCompressor(value) {
  return typeof value === "function" && SHARED_INPUT_COMPRESSORS.has(value) && typeof value.shared === "function";
}

function beginSharedTransportInput(counters, sharedRange, pool) {
  if (!counters) {
    return;
  }
  counters.sharedInputViewBytes = (Number(counters.sharedInputViewBytes) || 0) + sharedRange.byteLength;
  counters.sharedInputBackingBytes = (Number(counters.sharedInputBackingBytes) || 0) + sharedRange.backingByteLength;
  counters.sharedInputMaxBytes = (Number(counters.sharedInputMaxBytes) || 0) + sharedRange.maxByteLength;
  recordSharedInputOwner(counters, sharedRange.buffer);
  counters.transportSharedLiveBytes = (Number(counters.transportSharedLiveBytes) || 0) + sharedRange.backingByteLength;
  refreshTransportMemory(counters, pool);
}

function endSharedTransportInput(counters, sharedRange, pool) {
  if (!counters) {
    return;
  }
  counters.transportSharedLiveBytes = Math.max(
    0,
    (Number(counters.transportSharedLiveBytes) || 0) - sharedRange.backingByteLength,
  );
  refreshTransportMemory(counters, pool);
}

function recordSharedInputOwner(counters, owner) {
  let owners = SHARED_COUNTER_OWNERS.get(counters);
  if (!owners) {
    owners = new WeakSet();
    SHARED_COUNTER_OWNERS.set(counters, owners);
  }
  if (!owners.has(owner)) {
    owners.add(owner);
    counters.sharedInputUniqueOwners = (Number(counters.sharedInputUniqueOwners) || 0) + 1;
  }
}

function refreshTransportMemory(counters, pool) {
  const ownedActiveBytes = Number(counters.transportOwnedActiveBytes) || 0;
  const sharedLiveBytes = Number(counters.transportSharedLiveBytes) || 0;
  const ownedRetainedBytes =
    typeof pool?.ownedInputTelemetry === "function"
      ? Number(pool.ownedInputTelemetry().liveBytes) || 0
      : ownedActiveBytes;
  counters.transportLiveBytes = ownedActiveBytes + sharedLiveBytes;
  counters.transportRetainedLiveBytes = ownedRetainedBytes + sharedLiveBytes;
  counters.transportPeakLiveBytes = Math.max(
    Number(counters.transportPeakLiveBytes) || 0,
    counters.transportRetainedLiveBytes,
  );
}

function _testResetSharedCompressPool() {
  if (sharedPool && typeof sharedPool.markDead === "function") {
    sharedPool.markDead(new Error("test reset"));
  }
  sharedPool = null;
  sharedPoolThreads = 0;
  poolFailureWarned = false;
}

module.exports = {
  _normalizeSharedInputRange: normalizeSharedInputRange,
  COMPRESS_PROTOCOL_VERSION,
  CompressPool,
  compressSync,
  createCompressor,
  getSharedCompressPool,
  isSharedInputCompressor,
  resolveCompressMaxPending,
  resolveCompressThreads,
  _testResetSharedCompressPool,
  _testSharedPoolThreads: () => sharedPoolThreads,
};
