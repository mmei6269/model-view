"use strict";

// Compression helper pool for render workers. PNG IDAT deflate and hover
// gzip are deterministic pure functions of (bytes, level), but they ran
// inline on the frame worker's JS thread — ~1.65s of a warm serial frame
// serialized with raster/quantize work that needs only ~0.9s of that window.
// The pool moves those codec calls onto helper threads so they overlap the
// remaining render work; outputs are byte-identical because the helpers run
// the exact same codec entry points on the same bytes.
//
// Containment contract: inputs are structured-clone copies (never
// transferred), so every failure — spawn failure, worker death mid-job,
// unknown-kind protocol errors — falls back to the identical inline codec
// call and counts a fallback. A dead pool stays dead for the process; the
// render path never fails because compression offload failed.
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

function compressSync(kind, buffer, level) {
  if (kind === "gzip") {
    return zlib.gzipSync(buffer, { level: clampInt(level, 0, 9, 1) });
  }
  return deflatePngIdatSync(buffer, clampInt(level, 0, 9, 1));
}

class CompressPool {
  constructor(threads, maxPending = null) {
    this.dead = false;
    this.nextJobId = 1;
    this.pendingById = new Map();
    this.waiters = [];
    this.maxPending = resolveCompressMaxPending(maxPending, threads);
    this.workers = [];
    this.nextWorkerIndex = 0;
    if (process.env.MODELVIEW_NOAA_TEST_COMPRESS_SPAWN_ERROR) {
      throw new Error("test-injected compress worker spawn failure");
    }
    for (let index = 0; index < threads; index += 1) {
      const worker = new Worker(COMPRESS_WORKER_PATH);
      worker.unref();
      worker.on("message", (message) => this._onMessage(message));
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
    this.pendingById.delete(message.id);
    if (message.ok) {
      pending.resolve(Buffer.from(message.body));
    } else {
      pending.reject(new Error(message.error || "compress worker failure"));
    }
    this._drainWaiters();
  }

  // Freed in-flight slots are refilled from the FIFO wait queue. Each parked
  // job already holds its synchronous input snapshot, so dispatching it later
  // is byte-identical to having queued the worker message at submit time.
  _drainWaiters() {
    while (!this.dead && this.waiters.length > 0 && this.pendingById.size < this.maxPending) {
      const waiter = this.waiters.shift();
      this._dispatch(waiter.kind, waiter.input, waiter.level).then(waiter.resolve, waiter.reject);
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
      const input = Buffer.from(buffer);
      return new Promise((resolve, reject) => {
        this.waiters.push({ kind, input, level, resolve, reject });
      });
    }
    return this._dispatch(kind, buffer, level);
  }

  _dispatch(kind, buffer, level) {
    const id = this.nextJobId;
    this.nextJobId += 1;
    const worker = this.workers[this.nextWorkerIndex % this.workers.length];
    this.nextWorkerIndex += 1;
    return new Promise((resolve, reject) => {
      this.pendingById.set(id, { resolve, reject });
      try {
        // Structured clone (no transfer list): the caller keeps its buffer
        // for the inline fallback if this worker dies mid-job.
        worker.postMessage({ type: "compress", id, kind, input: buffer, level });
      } catch (error) {
        this.pendingById.delete(id);
        reject(error);
      }
    });
  }
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
  return async function compress(kind, buffer, level) {
    if (pool && !pool.dead) {
      try {
        const body = await pool.submit(kind, buffer, level);
        if (counters) {
          counters.jobs += 1;
        }
        return body;
      } catch (error) {
        warnPoolFailure(error);
      }
    }
    if (counters) {
      counters.fallbacks += 1;
    }
    return compressSync(kind, buffer, level);
  };
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
  CompressPool,
  compressSync,
  createCompressor,
  getSharedCompressPool,
  resolveCompressMaxPending,
  resolveCompressThreads,
  _testResetSharedCompressPool,
  _testSharedPoolThreads: () => sharedPoolThreads,
};
