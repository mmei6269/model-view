"use strict";

const { Worker } = require("worker_threads");
const { clampInt } = require("./local-artifact-options");

// Capacity of the frame worker's hydrated-metadata LRU. The pool maintains
// a per-worker mirror of that LRU (same insert/refresh/evict transitions on
// the same ordered message stream), so both sides always agree on which
// keys the worker still holds; a desynced set would strip payloads whose
// metadata the worker already evicted.
const WORKER_METADATA_LRU_MAX_ENTRIES = 8;

async function runWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  const workerCount = clampInt(concurrency, 1, items.length, 1);
  let index = 0;
  const runners = Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

class AsyncSemaphore {
  constructor(limit) {
    this.limit = Math.max(1, Math.round(Number(limit) || 1));
    this.active = 0;
    this.waiters = [];
  }

  async run(task) {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

class FrameWorkerPool {
  constructor({ workerPath, size, maxRespawns }) {
    this.workerPath = workerPath;
    this.size = clampInt(size, 1, 48, 2);
    this.maxRespawns = clampInt(maxRespawns, 0, 64, 3);
    this.respawnsUsed = 0;
    this.failure = null;
    this.queue = [];
    this.workers = [];
    this.nextJobId = 1;
    this.isClosed = false;
    for (let i = 0; i < this.size; i += 1) {
      this.workers.push(this.createWorkerState());
    }
  }

  createWorkerState() {
    const worker = new Worker(this.workerPath);
    const state = {
      worker,
      busy: false,
      activeJob: null,
      dead: false,
      // LRU mirror of the worker's hydrated-metadata cache; a fresh
      // respawned worker starts empty so it is re-hydrated.
      sentMetadataKeys: new Map(),
    };
    worker.on("message", (message) => this.handleMessage(state, message));
    worker.on("error", (error) => this.handleWorkerDeath(state, error));
    worker.on("exit", (code) => {
      // Any exit before close() is unexpected; even code 0 strands the in-flight job.
      this.handleWorkerDeath(state, new Error(`Worker exited with code ${code}`));
    });
    return state;
  }

  run(payload) {
    if (this.isClosed) {
      return Promise.reject(new Error("Worker pool is closed."));
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: this.nextJobId++,
        payload,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  pump() {
    if (this.isClosed || this.failure) {
      return;
    }
    for (const state of this.workers) {
      if (state.busy || state.dead) {
        continue;
      }
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      state.busy = true;
      state.activeJob = next;
      state.worker.postMessage(this.buildJobMessage(state, next));
    }
  }

  buildJobMessage(state, job) {
    const payload = job.payload;
    const metadataKey = payload?.latestMetadataKey;
    // Run-constant latestMetadata is structured-cloned to each worker once
    // per identity key instead of once per frame; the worker caches it by
    // key in an LRU that this mirror replays transition-for-transition on
    // the same ordered message stream. Message ordering per worker
    // guarantees the hydrating message is processed before any message
    // that omits the metadata. Retried jobs re-enter via run() with their
    // full payload, so a respawned worker (fresh mirror) is re-hydrated.
    if (!metadataKey || !payload?.latestMetadata) {
      return { type: "render-frame", id: job.id, payload };
    }
    const mirror = state.sentMetadataKeys;
    if (mirror.has(metadataKey)) {
      // Matches the worker's refresh-on-use so eviction order stays aligned.
      mirror.delete(metadataKey);
      mirror.set(metadataKey, true);
      const { latestMetadata, ...rest } = payload;
      void latestMetadata;
      return { type: "render-frame", id: job.id, payload: rest };
    }
    mirror.set(metadataKey, true);
    while (mirror.size > WORKER_METADATA_LRU_MAX_ENTRIES) {
      mirror.delete(mirror.keys().next().value);
    }
    return { type: "render-frame", id: job.id, payload };
  }

  handleMessage(state, message) {
    if (!state.activeJob) {
      return;
    }
    const job = state.activeJob;
    if (message?.id !== job.id) {
      return;
    }
    state.activeJob = null;
    state.busy = false;
    if (message?.ok) {
      try {
        job.resolve(reviveFrameArtifacts(message.frameArtifacts));
      } catch (error) {
        job.reject(error);
      }
    } else {
      job.reject(new Error(String(message?.error || "worker-frame-render-failed")));
    }
    this.pump();
  }

  handleWorkerDeath(state, error) {
    if (state.dead || this.isClosed) {
      return;
    }
    state.dead = true;
    const err = error instanceof Error ? error : new Error(String(error || "worker-error"));
    const index = this.workers.indexOf(state);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
    state.worker.terminate().catch(() => undefined);
    if (state.activeJob) {
      const job = state.activeJob;
      state.activeJob = null;
      state.busy = false;
      job.reject(new Error(`Frame worker died mid-job (job ${job.id}): ${err.message}`));
    }
    if (this.respawnsUsed < this.maxRespawns) {
      this.respawnsUsed += 1;
      console.warn(
        `[frame-worker-pool] worker died (${err.message}); respawning (${this.respawnsUsed}/${this.maxRespawns})`,
      );
      this.workers.push(this.createWorkerState());
      this.pump();
      return;
    }
    this.failure = new Error(
      `Frame worker pool respawn budget exhausted (${this.maxRespawns} respawns); last worker error: ${err.message}`,
    );
    console.error(`[frame-worker-pool] ${this.failure.message}`);
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      queued.reject(this.failure);
    }
  }

  getStats() {
    const busy = this.workers.filter((state) => state.busy).length;
    return {
      size: this.size,
      busy,
      idle: Math.max(0, this.workers.length - busy),
      queued: this.queue.length,
      closed: this.isClosed,
      respawnsUsed: this.respawnsUsed,
    };
  }

  async close() {
    this.isClosed = true;
    const terminations = this.workers.map((state) => state.worker.terminate().catch(() => undefined));
    await Promise.all(terminations);
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      job.reject(new Error("Worker pool closed."));
    }
  }
}

function reviveFrameArtifacts(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const layers = {};
  const reflectivityVariants = {};
  const reflectivityVariantsByLayer = {};
  let hoverGrid = null;
  for (const [name, layer] of Object.entries(raw.layers || {})) {
    const body = reviveBodyBuffer(layer?.body);
    if (!layer || !body) {
      continue;
    }
    layers[name] = {
      ...layer,
      body,
    };
  }
  for (const [name, layer] of Object.entries(raw.reflectivityVariants || {})) {
    const body = reviveBodyBuffer(layer?.body);
    if (!layer || !body) {
      continue;
    }
    reflectivityVariants[name] = {
      ...layer,
      body,
    };
  }
  for (const [layerKey, variants] of Object.entries(raw.reflectivityVariantsByLayer || {})) {
    const revivedVariants = {};
    for (const [name, layer] of Object.entries(variants || {})) {
      const body = reviveBodyBuffer(layer?.body);
      if (!layer || !body) {
        continue;
      }
      revivedVariants[name] = {
        ...layer,
        body,
      };
    }
    reflectivityVariantsByLayer[layerKey] = revivedVariants;
  }
  const hoverBody = reviveBodyBuffer(raw.hoverGrid?.body);
  if (hoverBody) {
    hoverGrid = {
      ...raw.hoverGrid,
      body: hoverBody,
    };
  }
  return {
    ...raw,
    layers,
    reflectivityVariants,
    reflectivityVariantsByLayer,
    hoverGrid,
  };
}

function reviveBodyBuffer(body) {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  return null;
}

module.exports = {
  AsyncSemaphore,
  FrameWorkerPool,
  WORKER_METADATA_LRU_MAX_ENTRIES,
  reviveFrameArtifacts,
  runWithConcurrency,
};
