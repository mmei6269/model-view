"use strict";

const { Worker } = require("worker_threads");
const { clampInt } = require("./local-artifact-options");

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
  constructor({ workerPath, size }) {
    this.workerPath = workerPath;
    this.size = clampInt(size, 1, 48, 2);
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
    };
    worker.on("message", (message) => this.handleMessage(state, message));
    worker.on("error", (error) => this.handleWorkerError(state, error));
    worker.on("exit", (code) => {
      if (this.isClosed) {
        return;
      }
      if (code !== 0) {
        this.handleWorkerError(state, new Error(`Worker exited with code ${code}`));
      }
    });
    return state;
  }

  run(payload) {
    if (this.isClosed) {
      return Promise.reject(new Error("Worker pool is closed."));
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
    if (this.isClosed) {
      return;
    }
    for (const state of this.workers) {
      if (state.busy) {
        continue;
      }
      const next = this.queue.shift();
      if (!next) {
        break;
      }
      state.busy = true;
      state.activeJob = next;
      state.worker.postMessage({
        type: "render-frame",
        id: next.id,
        payload: next.payload,
      });
    }
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

  handleWorkerError(state, error) {
    const err = error instanceof Error ? error : new Error(String(error || "worker-error"));
    if (state.activeJob) {
      state.activeJob.reject(err);
      state.activeJob = null;
    }
    state.busy = false;
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      queued.reject(err);
    }
  }

  getStats() {
    const busy = this.workers.filter((state) => state.busy).length;
    return {
      size: this.size,
      busy,
      idle: Math.max(0, this.size - busy),
      queued: this.queue.length,
      closed: this.isClosed,
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
  reviveFrameArtifacts,
  runWithConcurrency,
};
