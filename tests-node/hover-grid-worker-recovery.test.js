"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");
const { buildHoverGridBinaryRaw } = require("../scripts/lib/hover-grid-binary");

function loadArtifactClient() {
  const entry = path.join(__dirname, "..", "next", "src", "core", "artifact-client.ts");
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    define: {
      "import.meta.url": JSON.stringify("http://127.0.0.1/assets/artifact-client.js"),
      "import.meta.env.VITE_ARTIFACT_BASE_URL": "undefined",
      "import.meta.env.VITE_IMAGE_OBJECT_URL_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_DECODED_IMAGE_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_HOVER_GRID_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_PARSED_PAYLOAD_CACHE_MAX_ENTRIES": "undefined",
      "import.meta.env.DEV": "false",
    },
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function binaryFrame(hour = 1) {
  return {
    hour,
    validHourKey: `frame-${hour}`,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    layers: {},
    hoverGridKey: `hover/frame-${hour}.bin.br`,
    hoverGridBytes: 100,
    hoverGridSchemaVersion: 3,
  };
}

function rawPayload(values = [100, 200, 300, 400]) {
  return buildHoverGridBinaryRaw({
    schemaVersion: 3,
    rows: 2,
    cols: 2,
    variables: {
      temperature: {
        scale: 0.05,
        offset: 0,
        missing: -32768,
        values: Int16Array.from(values),
      },
    },
  });
}

function exactArrayBuffer(bytes) {
  return Uint8Array.from(bytes).buffer;
}

class WorkerHarness {
  static instances = [];
  static mode = "crash";

  constructor() {
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
    WorkerHarness.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message, transfer) {
    const owned = structuredClone(message, { transfer });
    this.messages.push(owned);
    if (WorkerHarness.mode === "crash") {
      queueMicrotask(() => {
        this.emit("error", {
          message: "intentional crash after ownership transfer",
          preventDefault() {},
        });
      });
    } else if (WorkerHarness.mode === "empty") {
      queueMicrotask(() => this.respondWithEmptyResult());
    }
  }

  respondWithEmptyResult() {
    const message = this.messages.shift();
    assert.ok(message);
    this.emit("message", {
      data: {
        type: "result",
        protocolVersion: 1,
        id: message.id,
        payload: { schemaVersion: 1, rows: 0, cols: 0, variables: {} },
      },
    });
  }

  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }

  terminate() {
    this.terminated = true;
  }

  static reset(mode = "crash") {
    WorkerHarness.instances = [];
    WorkerHarness.mode = mode;
  }
}

function installWorkerHarness(mode) {
  const original = globalThis.Worker;
  WorkerHarness.reset(mode);
  globalThis.Worker = WorkerHarness;
  return () => {
    if (original === undefined) {
      delete globalThis.Worker;
    } else {
      globalThis.Worker = original;
    }
  };
}

test("crash after transfer performs exactly one refetch and recovers exact weather on the main thread", async () => {
  const restore = installWorkerHarness("crash");
  const originalFetch = globalThis.fetch;
  try {
    const client = loadArtifactClient();
    const raw = rawPayload();
    const returnedBuffers = [];
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      const buffer = exactArrayBuffer(raw);
      returnedBuffers.push(buffer);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buffer,
      };
    };

    const payload = await client.fetchHoverGridPayload(binaryFrame(10));
    assert.equal(requests, 2, "one initial request plus one bounded recovery refetch");
    assert.equal(returnedBuffers[0].byteLength, 0, "the crashed worker lost the first transferred owner");
    assert.ok(returnedBuffers[1].byteLength > 0);
    assert.deepEqual(Array.from(payload.variables.temperature.values), [100, 200, 300, 400]);
    assert.strictEqual(payload.variables.temperature.values.buffer, returnedBuffers[1]);
    assert.equal(WorkerHarness.instances.length, 1, "the crashed worker is circuit-broken");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("recovery rejects stale MVH3 bytes declared as schema 4 before cache admission", async () => {
  const restore = installWorkerHarness("crash");
  const originalFetch = globalThis.fetch;
  try {
    const client = loadArtifactClient();
    const raw3 = rawPayload();
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => exactArrayBuffer(raw3),
      };
    };
    const item = { ...binaryFrame(10), hoverGridSchemaVersion: 4 };
    await assert.rejects(client.fetchHoverGridPayload(item), /request declared 4, payload decoded as 3/);
    assert.equal(requests, 2);
    assert.equal(client.getCachedHoverGridPayload(client.resolveHoverGridRequestUrls(item)[0]), null);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("recovery fetch failure stops at two attempts and rejects instead of caching blank weather", async () => {
  const restore = installWorkerHarness("crash");
  const originalFetch = globalThis.fetch;
  try {
    const client = loadArtifactClient();
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      if (requests === 1) {
        const buffer = exactArrayBuffer(rawPayload());
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => buffer,
        };
      }
      return {
        ok: false,
        status: 503,
      };
    };

    const item = binaryFrame(11);
    await assert.rejects(
      client.fetchHoverGridPayload(item),
      /Hover grid recovery request failed \(503\) after worker ownership loss/,
    );
    assert.equal(requests, 2);
    const key = client.resolveHoverGridRequestUrls(item)[0];
    assert.equal(client.getCachedHoverGridPayload(key), null, "failed recovery must not cache an empty payload");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("empty worker output plus invalid recovery rejects and never caches blank weather", async () => {
  const restore = installWorkerHarness("empty");
  const originalFetch = globalThis.fetch;
  try {
    const client = loadArtifactClient();
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      const buffer =
        requests === 1 ? exactArrayBuffer(rawPayload()) : Uint8Array.from(Buffer.from("not-hover-grid")).buffer;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buffer,
      };
    };

    const item = binaryFrame(13);
    await assert.rejects(
      client.fetchHoverGridPayload(item),
      /Hover grid recovery payload decoded to an unusable result/,
    );
    assert.equal(requests, 2, "malformed worker output still has a one-refetch ceiling");
    const key = client.resolveHoverGridRequestUrls(item)[0];
    assert.equal(client.getCachedHoverGridPayload(key), null);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("shared consumers preserve per-caller abort semantics after the buffer transfers", async () => {
  const restore = installWorkerHarness("hold");
  const originalFetch = globalThis.fetch;
  try {
    const client = loadArtifactClient();
    let requests = 0;
    let returnedBuffer;
    globalThis.fetch = async () => {
      requests += 1;
      returnedBuffer = exactArrayBuffer(rawPayload());
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => returnedBuffer,
      };
    };

    const first = new AbortController();
    const second = new AbortController();
    const item = binaryFrame(12);
    const firstPromise = client.fetchHoverGridPayload(item, { signal: first.signal });
    const secondPromise = client.fetchHoverGridPayload(item, { signal: second.signal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    assert.equal(returnedBuffer.byteLength, 0);

    first.abort();
    await assert.rejects(firstPromise, (error) => error?.name === "AbortError");
    assert.equal(WorkerHarness.instances[0].messages.length, 1, "remaining consumer keeps shared decode alive");

    second.abort();
    await assert.rejects(secondPromise, (error) => error?.name === "AbortError");
    assert.equal(requests, 1, "an abort is not mistaken for ownership loss and does not refetch");

    // Let the worker's already-owned task return so its timeout is cleared;
    // the result is intentionally discarded because every consumer left.
    WorkerHarness.instances[0].respondWithEmptyResult();
    await Promise.resolve();
    assert.equal(client.getCachedHoverGridPayload(client.resolveHoverGridRequestUrls(item)[0]), null);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});
