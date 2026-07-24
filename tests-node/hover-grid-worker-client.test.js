"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");
const { buildHoverGridBinaryRaw } = require("../scripts/lib/hover-grid-binary");

function loadBundledModule(entry) {
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    define: {
      "import.meta.url": JSON.stringify("http://127.0.0.1/assets/hover-grid-worker-client.js"),
    },
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

const parser = loadBundledModule(path.join(__dirname, "..", "next", "src", "core", "hover-grid-payload.ts"));

function rawPayload(values = [11, 22, 33, 44], schemaVersion = 3) {
  return buildHoverGridBinaryRaw({
    schemaVersion,
    rows: 2,
    cols: 2,
    variables: {
      temperature: {
        scale: 0.05,
        offset: 0,
        missing: -32768,
        values: Int16Array.from(values),
      },
      wind: {
        scale: 0.1,
        offset: 0,
        missing: -32768,
        values: Int16Array.from(values.map((value) => value + 100)),
      },
    },
  });
}

function exactArrayBuffer(bytes) {
  return Uint8Array.from(bytes).buffer;
}

class ControlledWorker {
  static instances = [];
  static autoRespond = false;

  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.listeners = new Map();
    this.pending = [];
    this.terminated = false;
    ControlledWorker.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message, transfer) {
    if (this.terminated) {
      throw new Error("worker terminated");
    }
    const ownedMessage = structuredClone(message, { transfer });
    this.pending.push(ownedMessage);
    if (ControlledWorker.autoRespond) {
      queueMicrotask(() => this.respondNext());
    }
  }

  respondNext(overrides = {}) {
    const message = this.pending.shift();
    assert.ok(message, "expected a queued worker message");
    const payload = parser.normalizeOwnedBinaryHoverGridPayload(message.buffer);
    const backings = [
      ...new Set(
        Object.values(payload.variables)
          .filter(Boolean)
          .map((variable) => variable.values.buffer),
      ),
    ];
    const response = structuredClone(
      {
        type: "result",
        protocolVersion: 1,
        id: message.id,
        payload,
        ...overrides,
      },
      { transfer: backings },
    );
    this.emit("message", { data: response });
  }

  respondPayload(payload, overrides = {}) {
    const message = this.pending.shift();
    assert.ok(message, "expected a queued worker message");
    const backings = [
      ...new Set(
        Object.values(payload.variables || {})
          .filter(Boolean)
          .map((variable) => variable.values)
          .filter((values) => ArrayBuffer.isView(values) && values.buffer instanceof ArrayBuffer)
          .map((values) => values.buffer),
      ),
    ];
    const response = structuredClone(
      {
        type: "result",
        protocolVersion: 1,
        id: message.id,
        payload,
        ...overrides,
      },
      { transfer: backings },
    );
    this.emit("message", { data: response });
  }

  crash(message = "intentional worker crash") {
    this.emit("error", {
      message,
      preventDefault() {},
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

  static reset() {
    ControlledWorker.instances = [];
    ControlledWorker.autoRespond = false;
  }
}

function loadClient() {
  return loadBundledModule(path.join(__dirname, "..", "next", "src", "core", "hover-grid-worker-client.ts"));
}

function installControlledWorker() {
  const original = globalThis.Worker;
  ControlledWorker.reset();
  globalThis.Worker = ControlledWorker;
  return () => {
    if (original === undefined) {
      delete globalThis.Worker;
    } else {
      globalThis.Worker = original;
    }
  };
}

test("persistent worker round trip preserves exact canonical values and one backing owner", async () => {
  const restore = installControlledWorker();
  try {
    ControlledWorker.autoRespond = true;
    const client = loadClient();
    client.prewarmHoverGridPayloadWorker();
    const firstInput = exactArrayBuffer(rawPayload());
    const first = await client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(firstInput);
    assert.equal(firstInput.byteLength, 0, "page input ownership is transferred");
    assert.deepEqual(Array.from(first.variables.temperature.values), [11, 22, 33, 44]);
    assert.deepEqual(Array.from(first.variables.wind.values), [111, 122, 133, 144]);
    assert.strictEqual(first.variables.temperature.values.buffer, first.variables.wind.values.buffer);

    const secondInput = exactArrayBuffer(rawPayload([5, 6, 7, 8]));
    const second = await client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(secondInput);
    assert.deepEqual(Array.from(second.variables.temperature.values), [5, 6, 7, 8]);
    assert.equal(ControlledWorker.instances.length, 1, "worker is persistent across payloads");
    assert.equal(ControlledWorker.instances[0].options.type, "module");
  } finally {
    restore();
  }
});

test("persistent worker round trip accepts canonical MVH4 and preserves exact gradient2d values", async () => {
  const restore = installControlledWorker();
  try {
    ControlledWorker.autoRespond = true;
    const client = loadClient();
    const input = exactArrayBuffer(rawPayload([-32768, 32767, -12345, 23456], 4));
    const payload = await client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(input);

    assert.equal(input.byteLength, 0);
    assert.equal(payload.schemaVersion, 4);
    assert.deepEqual(Array.from(payload.variables.temperature.values), [-32768, 32767, -12345, 23456]);
    assert.deepEqual(Array.from(payload.variables.wind.values), [-32668, -32669, -12245, 23556]);
    assert.strictEqual(payload.variables.temperature.values.buffer, payload.variables.wind.values.buffer);
  } finally {
    restore();
  }
});

test("persistent worker accepts canonical empty MVH3 and MVH4 protocol payloads", async () => {
  const restore = installControlledWorker();
  try {
    ControlledWorker.autoRespond = true;
    const client = loadClient();
    const raw4 = buildHoverGridBinaryRaw({ schemaVersion: 4, rows: 2, cols: 3, variables: {} });
    const input4 = exactArrayBuffer(raw4);
    const payload4 = await client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(input4);
    assert.equal(input4.byteLength, 0);
    assert.deepEqual(payload4, { schemaVersion: 4, rows: 2, cols: 3, variables: {} });

    const raw3 = buildHoverGridBinaryRaw({ schemaVersion: 3, rows: 2, cols: 3, variables: {} });
    const input3 = exactArrayBuffer(raw3);
    const payload3 = await client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(input3);
    assert.equal(input3.byteLength, 0);
    assert.deepEqual(payload3, { schemaVersion: 3, rows: 2, cols: 3, variables: {} });
  } finally {
    restore();
  }
});

test("only one owned buffer is transferred at a time and queued aborts retain ownership", async () => {
  const restore = installControlledWorker();
  try {
    const client = loadClient();
    const firstInput = exactArrayBuffer(rawPayload());
    const secondInput = exactArrayBuffer(rawPayload([1, 2, 3, 4]));
    const queuedAbort = new AbortController();
    const firstPromise = client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(firstInput);
    const secondPromise = client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(secondInput, queuedAbort.signal);
    assert.equal(firstInput.byteLength, 0);
    assert.ok(secondInput.byteLength > 0, "queued buffer stays page-owned until the worker is idle");
    assert.equal(ControlledWorker.instances[0].pending.length, 1);

    queuedAbort.abort();
    await assert.rejects(secondPromise, (error) => error?.name === "AbortError");
    assert.ok(secondInput.byteLength > 0, "aborted queued work was never transferred");

    ControlledWorker.instances[0].respondNext();
    const first = await firstPromise;
    assert.deepEqual(Array.from(first.variables.temperature.values), [11, 22, 33, 44]);
    assert.equal(ControlledWorker.instances[0].pending.length, 0);
  } finally {
    restore();
  }
});

test("admission retains at most one page-owned queued buffer and decodes overflow in place", async () => {
  const restore = installControlledWorker();
  try {
    const client = loadClient();
    const inputs = Array.from({ length: 8 }, (_, index) =>
      exactArrayBuffer(rawPayload([index, index + 1, index + 2, index + 3])),
    );
    const promises = inputs.map((input) => client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(input));
    const worker = ControlledWorker.instances[0];

    assert.equal(inputs[0].byteLength, 0, "only the active owner transfers immediately");
    assert.ok(inputs[1].byteLength > 0, "one queued owner remains page-owned");
    assert.ok(
      inputs.slice(2).every((input) => input.byteLength > 0),
      "overflow owners are consumed in place instead of joining the retained FIFO",
    );
    assert.equal(worker.pending.length, 1, "worker has exactly one active request");

    worker.respondNext();
    await Promise.resolve();
    assert.equal(inputs[1].byteLength, 0, "the sole queued owner transfers after the active result");
    assert.equal(worker.pending.length, 1);
    worker.respondNext();

    const payloads = await Promise.all(promises);
    for (let index = 0; index < payloads.length; index += 1) {
      assert.deepEqual(Array.from(payloads[index].variables.temperature.values), [
        index,
        index + 1,
        index + 2,
        index + 3,
      ]);
    }
    assert.equal(worker.pending.length, 0);
  } finally {
    restore();
  }
});

test("active abort rejects immediately but does not admit another owner until the result is discarded", async () => {
  const restore = installControlledWorker();
  try {
    const client = loadClient();
    const activeAbort = new AbortController();
    const firstInput = exactArrayBuffer(rawPayload());
    const secondInput = exactArrayBuffer(rawPayload([8, 7, 6, 5]));
    const firstPromise = client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(firstInput, activeAbort.signal);
    const secondPromise = client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(secondInput);
    activeAbort.abort();
    await assert.rejects(firstPromise, (error) => error?.name === "AbortError");
    assert.ok(secondInput.byteLength > 0, "second owner remains queued while aborted worker work finishes");

    const worker = ControlledWorker.instances[0];
    worker.respondNext();
    await Promise.resolve();
    assert.equal(secondInput.byteLength, 0, "next owner transfers only after the discarded result returns");
    worker.respondNext();
    const second = await secondPromise;
    assert.deepEqual(Array.from(second.variables.temperature.values), [8, 7, 6, 5]);
  } finally {
    restore();
  }
});

test("a crash marks only the active transfer lost, disables the worker, and preserves queued owners", async () => {
  const restore = installControlledWorker();
  try {
    const client = loadClient();
    const lostInput = exactArrayBuffer(rawPayload());
    const queuedInput = exactArrayBuffer(rawPayload([4, 3, 2, 1]));
    const lostPromise = client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(lostInput);
    const queuedPromise = client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(queuedInput);
    const worker = ControlledWorker.instances[0];
    assert.equal(lostInput.byteLength, 0);
    assert.ok(queuedInput.byteLength > 0);

    worker.crash();
    await assert.rejects(
      lostPromise,
      (error) => client.isHoverGridWorkerOwnershipLostError(error) && error.ownershipLost === true,
    );
    const queued = await queuedPromise;
    assert.strictEqual(
      queued.variables.temperature.values.buffer,
      queuedInput,
      "queued owner falls back in place without a refetch",
    );
    assert.deepEqual(Array.from(queued.variables.temperature.values), [4, 3, 2, 1]);

    const laterInput = exactArrayBuffer(rawPayload([9, 8, 7, 6]));
    const later = await client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(laterInput);
    assert.strictEqual(later.variables.temperature.values.buffer, laterInput);
    assert.equal(ControlledWorker.instances.length, 1, "crashed worker stays circuit-broken for this session");
  } finally {
    restore();
  }
});

test("empty, malformed-view, and stale worker results fail closed after ownership transfer", async () => {
  const restore = installControlledWorker();
  try {
    const cases = [
      {
        label: "empty",
        respond(worker) {
          worker.respondPayload({ schemaVersion: 1, rows: 0, cols: 0, variables: {} });
        },
      },
      {
        label: "malformed view",
        respond(worker) {
          worker.respondPayload({
            schemaVersion: 3,
            rows: 2,
            cols: 2,
            variables: {
              temperature: {
                scale: 1,
                offset: 0,
                missing: -32768,
                values: new Uint8Array(4),
              },
            },
          });
        },
      },
      {
        label: "unsupported future schema",
        respond(worker) {
          const values = Int16Array.from([1, 2, 3, 4]);
          worker.respondPayload({
            schemaVersion: 5,
            rows: 2,
            cols: 2,
            variables: {
              temperature: {
                scale: 1,
                offset: 0,
                missing: -32768,
                values,
              },
            },
          });
        },
      },
      {
        label: "nonpositive scale",
        respond(worker) {
          worker.respondPayload({
            schemaVersion: 4,
            rows: 1,
            cols: 1,
            variables: {
              temperature: {
                scale: 0,
                offset: 0,
                missing: -32768,
                values: new Int16Array([1]),
              },
            },
          });
        },
      },
      {
        label: "fractional missing sentinel",
        respond(worker) {
          worker.respondPayload({
            schemaVersion: 4,
            rows: 1,
            cols: 1,
            variables: {
              temperature: {
                scale: 1,
                offset: 0,
                missing: -1.5,
                values: new Int16Array([1]),
              },
            },
          });
        },
      },
      {
        label: "stale id",
        respond(worker) {
          worker.respondNext({ id: 999_999 });
        },
      },
    ];

    for (const probe of cases) {
      ControlledWorker.reset();
      const client = loadClient();
      const input = exactArrayBuffer(rawPayload());
      const pending = client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(input);
      const worker = ControlledWorker.instances[0];
      probe.respond(worker);
      await assert.rejects(pending, (error) => client.isHoverGridWorkerOwnershipLostError(error), probe.label);
      assert.equal(input.byteLength, 0, `${probe.label}: input ownership was transferred`);
      assert.equal(worker.terminated, true, `${probe.label}: invalid worker is circuit-broken`);
    }
  } finally {
    restore();
  }
});

test("SSR/no-Worker fallback decodes the exclusively owned input in place", async () => {
  const original = globalThis.Worker;
  delete globalThis.Worker;
  try {
    const client = loadClient();
    const input = exactArrayBuffer(rawPayload([21, 22, 23, 24]));
    const result = await client.normalizeOwnedBinaryHoverGridPayloadOffMainThread(input);
    assert.strictEqual(result.variables.temperature.values.buffer, input);
    assert.deepEqual(Array.from(result.variables.temperature.values), [21, 22, 23, 24]);
  } finally {
    if (original !== undefined) {
      globalThis.Worker = original;
    }
  }
});
