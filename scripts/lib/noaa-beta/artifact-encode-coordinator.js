"use strict";

const { performance } = require("perf_hooks");

// Frame-local admission controller for renderer codec work. It deliberately
// queues start functions, not prepared PNG scanlines: a queued layer therefore
// retains only its immutable RGBA/index owner and constructs the shared filter-0
// scratch after a helper slot is available. Hover compression uses the same
// budget, so a large hover body cannot hide behind an unbounded PNG waiter
// queue.
class ArtifactEncodeCoordinator {
  constructor(maxActive = 1, { admissionGate = null } = {}) {
    this.maxActive = clampPositiveInt(maxActive, 1);
    this.admissionGate = admissionGate;
    this.nextOrdinal = 1;
    this.queue = [];
    this.active = new Map();
    this.allSettlements = [];
    this.firstError = null;
    this.checkpoints = 0;
    this.backpressureMs = 0;
    this.peakActive = 0;
    this.peakQueued = 0;
  }

  schedule(start, label = "artifact") {
    if (typeof start !== "function") {
      throw new TypeError("artifact encode work requires a start function");
    }
    const ordinal = this.nextOrdinal;
    this.nextOrdinal += 1;
    let resolveConsumer;
    let rejectConsumer;
    const consumer = new Promise((resolve, reject) => {
      resolveConsumer = resolve;
      rejectConsumer = reject;
    });
    // Own the rejection in the same turn that creates the promise. Callers
    // still receive the original rejecting promise, while the coordinator's
    // settlement path can always be drained without an unhandled rejection.
    void consumer.catch(() => {});
    const entry = {
      ordinal,
      label: String(label || "artifact"),
      start,
      resolveConsumer,
      rejectConsumer,
      settlement: null,
    };
    this.queue.push(entry);
    this._pump();
    return consumer;
  }

  _pump() {
    while (this.queue.length > 0 && this.active.size < this.maxActive) {
      const entry = this.queue.shift();
      // Consume the closure at admission. Direct hover starts can capture
      // decoded source grids, which must not remain reachable through the
      // active bookkeeping entry for the entire codec settlement.
      const start = entry.start;
      entry.start = null;
      let work;
      try {
        // Start synchronously once admitted. Pool submission therefore clones
        // the scratch before this call returns, just as the direct path does.
        work =
          this.admissionGate && typeof this.admissionGate.run === "function" ? this.admissionGate.run(start) : start();
      } catch (error) {
        work = Promise.reject(error);
      }
      const settlement = Promise.resolve(work).then(
        (value) => this._settle(entry, null, value),
        (error) => this._settle(entry, error),
      );
      entry.settlement = settlement;
      this.active.set(entry.ordinal, entry);
      this.allSettlements.push(settlement);
      this.peakActive = Math.max(this.peakActive, this.active.size);
    }
    this.peakQueued = Math.max(this.peakQueued, this.queue.length);
  }

  _settle(entry, error, value) {
    this.active.delete(entry.ordinal);
    if (error) {
      if (!this.firstError || entry.ordinal < this.firstError.ordinal) {
        this.firstError = { ordinal: entry.ordinal, label: entry.label, error: normalizeError(error) };
      }
      entry.rejectConsumer(error);
    } else {
      entry.resolveConsumer(value);
    }
    this._pump();
  }

  async waitForCapacity() {
    if (this.queue.length === 0 && this.active.size < this.maxActive) {
      return false;
    }
    const startedAt = performance.now();
    this.checkpoints += 1;
    do {
      const settlements = Array.from(this.active.values(), (entry) => entry.settlement).filter(Boolean);
      if (settlements.length === 0) {
        // The only way to have queued work and no active work is a synchronous
        // start failure. Pump once so its rejected settlement can be observed.
        this._pump();
        continue;
      }
      await Promise.race(settlements);
    } while (this.queue.length > 0);
    this.backpressureMs += performance.now() - startedAt;
    return true;
  }

  async waitForIdle() {
    if (this.queue.length === 0 && this.active.size === 0) {
      return false;
    }
    const startedAt = performance.now();
    this.checkpoints += 1;
    while (this.queue.length > 0 || this.active.size > 0) {
      this._pump();
      const settlements = Array.from(this.active.values(), (entry) => entry.settlement).filter(Boolean);
      if (settlements.length === 0) {
        break;
      }
      await Promise.race(settlements);
    }
    this.backpressureMs += performance.now() - startedAt;
    return true;
  }

  async drain({ throwOnError = true } = {}) {
    const startedAt = performance.now();
    while (this.queue.length > 0 || this.active.size > 0) {
      this._pump();
      const settlements = Array.from(this.active.values(), (entry) => entry.settlement).filter(Boolean);
      if (settlements.length === 0) {
        break;
      }
      await Promise.all(settlements);
    }
    // Include settlements appended by _pump while an earlier wave resolved.
    await Promise.all(this.allSettlements);
    const waitMs = performance.now() - startedAt;
    if (throwOnError) {
      this.throwIfFailed();
    }
    return waitMs;
  }

  throwIfFailed() {
    if (!this.firstError) {
      return;
    }
    throw createCoordinatorError(this.firstError);
  }

  telemetry() {
    return {
      maxActive: this.maxActive,
      checkpoints: this.checkpoints,
      backpressureMs: this.backpressureMs,
      peakActive: this.peakActive,
      peakQueued: this.peakQueued,
      submitted: this.nextOrdinal - 1,
    };
  }
}

// A render worker normally processes one frame at a time, but direct callers
// and tests may build multiple frames concurrently against the same helper
// pool. Each frame keeps its own coordinator/counters while this pool-scoped
// gate reserves the real global pending budget before a frame constructs PNG
// scanlines. Thus N frame-local coordinators still cannot enter
// CompressPool.submit beyond maxPending and trigger its full-buffer waiter
// snapshots.
class ArtifactEncodeAdmissionGate {
  constructor(maxActive = 1) {
    this.maxActive = clampPositiveInt(maxActive, 1);
    this.active = 0;
    this.queue = [];
  }

  run(start) {
    return new Promise((resolve, reject) => {
      this.queue.push({ start, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    while (this.active < this.maxActive && this.queue.length > 0) {
      const entry = this.queue.shift();
      // As above, retain a local only for invocation and sever the queued
      // entry's potentially large source graph before asynchronous work.
      const start = entry.start;
      entry.start = null;
      this.active += 1;
      let work;
      try {
        work = start();
      } catch (error) {
        work = Promise.reject(error);
      }
      Promise.resolve(work).then(
        (value) => this._settle(entry, null, value),
        (error) => this._settle(entry, error),
      );
    }
  }

  _settle(entry, error, value) {
    this.active = Math.max(0, this.active - 1);
    if (error) {
      entry.reject(error);
    } else {
      entry.resolve(value);
    }
    this._pump();
  }
}

const POOL_ADMISSION_GATES = new WeakMap();

function getArtifactEncodeAdmissionGate(pool, maxActive = null) {
  if (!pool || (typeof pool !== "object" && typeof pool !== "function")) {
    return null;
  }
  let gate = POOL_ADMISSION_GATES.get(pool);
  if (!gate) {
    gate = new ArtifactEncodeAdmissionGate(maxActive ?? pool.maxPending ?? 1);
    POOL_ADMISSION_GATES.set(pool, gate);
  }
  return gate;
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function createCoordinatorError(failure) {
  const source = normalizeError(failure?.error);
  const error = new Error(source.message, { cause: source });
  error.name = source.name || "Error";
  if (source.stack) {
    error.stack = source.stack;
  }
  if (source.code !== undefined) {
    error.code = source.code;
  }
  error.artifactEncodeOrdinal = failure.ordinal;
  error.artifactEncodeLabel = failure.label;
  return error;
}

function clampPositiveInt(value, fallback) {
  const numeric = Math.floor(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

module.exports = {
  ArtifactEncodeAdmissionGate,
  ArtifactEncodeCoordinator,
  getArtifactEncodeAdmissionGate,
};
