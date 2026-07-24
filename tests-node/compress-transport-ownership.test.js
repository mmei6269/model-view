"use strict";

// Pass 11 transport ownership contract. These tests intentionally exercise
// seams below the renderer's happy path: exact transferred owners, bounded
// recycling across changing sizes, generic contention, postMessage failure,
// worker death after detachment, malformed/stale protocol replies, immutable
// SAB publication/lifetime, and global coordinator admission.

const assert = require("node:assert/strict");
const { Worker } = require("node:worker_threads");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  COMPRESS_PROTOCOL_VERSION,
  CompressPool,
  _normalizeSharedInputRange,
  compressSync,
  createCompressor,
} = require("../scripts/lib/noaa-beta/compress-pool");
const {
  ArtifactEncodeCoordinator,
  getArtifactEncodeAdmissionGate,
} = require("../scripts/lib/noaa-beta/artifact-encode-coordinator");
const { finalizeNoaaRenderProfile } = require("../scripts/lib/noaa-beta/decode-session");
const { buildHoverGridBinaryRaw } = require("../scripts/lib/hover-grid-binary");
const { buildHoverGridArtifact } = require("../scripts/lib/noaa-beta/hover");
const {
  _encodeTrustedRgbaPngFilter0ViaPool,
  encodeRgbaPngFilter0,
  encodeRgbaPngFilter0ViaPool,
} = require("../scripts/lib/noaa-beta/png-encode");
const { _testBuildRenderedArtifacts: buildRenderedArtifacts } = require("../scripts/lib/noaa-beta-renderer");
const { encodeLayerOrEmptyDeferred } = require("../scripts/lib/noaa-beta/raster");
const { HOVER_GRID_SCHEMA_VERSION } = require("../scripts/lib/modelview-runtime");

function patternBuffer(bytes, seed = 0) {
  const out = Buffer.allocUnsafe(bytes);
  for (let index = 0; index < bytes; index += 1) {
    out[index] = (index * 31 + seed * 17 + ((index >> 4) % 11)) & 255;
  }
  return out;
}

function patternRgba(width, height, seed = 0) {
  return patternBuffer(width * height * 4, seed);
}

function exactArrayBuffer(value) {
  const bytes = Buffer.from(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function validWorkerResponse(request, body, overrides = {}) {
  return {
    type: "compress-result",
    protocolVersion: COMPRESS_PROTOCOL_VERSION,
    id: request.id,
    token: request.token,
    inputMode: request.inputMode,
    ok: true,
    body: exactArrayBuffer(body),
    ...(request.inputMode === "shared-array-buffer"
      ? {
          inputByteOffset: request.inputByteOffset,
          inputByteLength: request.inputByteLength,
        }
      : {}),
    ...overrides,
  };
}

function hoverVariables(seed = 0) {
  return {
    temperature: {
      scale: 0.1,
      offset: -100,
      missing: -32768,
      values: Int16Array.from({ length: 32 }, (_, index) => ((index * 97 + seed * 13) % 2000) - 1000),
    },
  };
}

test("owned transfer returns exact standalone slabs and one recycler stays globally bounded across sizes", async () => {
  const pool = new CompressPool(1, 2);
  try {
    const first = pool.acquireOwnedInput(7);
    const second = pool.acquireOwnedInput(13);
    assert.ok(first.buffer instanceof ArrayBuffer);
    assert.equal(first.buffer.byteLength, 7);
    const firstView = Buffer.from(first.buffer);
    assert.strictEqual(firstView.buffer, first.buffer);
    assert.equal(firstView.byteOffset, 0);
    assert.equal(firstView.byteLength, first.buffer.byteLength, "small slabs must not expose pooled Buffer backing");
    firstView.set(patternBuffer(7, 1));
    Buffer.from(second.buffer).set(patternBuffer(13, 2));
    assert.equal(pool.acquireOwnedInput(17), null, "free + checked-out owner count is capped by maxPending");

    const firstExpected = compressSync("png-idat", patternBuffer(7, 1), 1);
    const secondExpected = compressSync("png-idat", patternBuffer(13, 2), 1);
    const firstPending = pool.submitOwned("png-idat", first, 1);
    const secondPending = pool.submitOwned("png-idat", second, 1);
    assert.equal(first.state, "in-flight");
    assert.equal(first.buffer.byteLength, 0, "postMessage transfer must detach synchronously");
    assert.equal(pool.waiters.length, 0, "owned inputs never enter generic waiters");

    const [firstResult, secondResult] = await Promise.all([firstPending, secondPending]);
    assert.deepEqual(firstResult.body, firstExpected);
    assert.deepEqual(secondResult.body, secondExpected);
    assert.equal(firstResult.lease.state, "attached");
    assert.equal(firstResult.lease.buffer.byteLength, 7);
    assert.equal(pool.releaseOwnedInput(firstResult.lease), true);
    assert.equal(pool.releaseOwnedInput(secondResult.lease), true);

    const resizedFirst = pool.acquireOwnedInput(19);
    const resizedSecond = pool.acquireOwnedInput(23);
    assert.equal(pool.acquireOwnedInput(29), null);
    assert.deepEqual(
      pool.ownedInputTelemetry(),
      {
        checkedOut: 2,
        checkedOutBytes: 42,
        free: 0,
        freeBytes: 0,
        liveBytes: 42,
        peakCheckedOut: 2,
        peakLiveBytes: 42,
        maxPending: 2,
      },
      "changing dimensions replace idle slabs instead of creating a cache per size",
    );
    pool.releaseOwnedInput(resizedFirst);
    pool.releaseOwnedInput(resizedSecond);
    const released = pool.ownedInputTelemetry();
    assert.equal(released.checkedOut + released.free, 2);
    assert.equal(released.liveBytes, 42);
  } finally {
    pool.markDead(new Error("test done"));
  }
});

test("generic cap contention rejects owned work while its ArrayBuffer stays attached and unqueued", async () => {
  const pool = new CompressPool(1, 1);
  const inFlight = pool.submit("gzip", patternBuffer(8 * 1024 * 1024, 3), 9);
  const parked = pool.submit("gzip", patternBuffer(4096, 4), 1);
  void inFlight.catch(() => {});
  void parked.catch(() => {});
  const lease = pool.acquireOwnedInput(31);
  Buffer.from(lease.buffer).set(patternBuffer(31, 5));
  try {
    assert.equal(pool.pendingById.size, 1);
    assert.equal(pool.waiters.length, 1);
    await assert.rejects(pool.submitOwned("png-idat", lease, 1), /no immediate owned-input admission/);
    assert.equal(lease.state, "attached");
    assert.equal(lease.buffer.byteLength, 31);
    assert.deepEqual(Buffer.from(lease.buffer), patternBuffer(31, 5));
    assert.equal(pool.waiters.length, 1, "rejected owner must not join or disturb generic FIFO waiters");
    assert.equal(pool.releaseOwnedInput(lease), true);
  } finally {
    pool.markDead(new Error("cancel generic contention"));
    await Promise.allSettled([inFlight, parked]);
  }
});

test("generic SAB inputs are synchronously isolated for immediate, parked, and fallback paths", async (t) => {
  await t.test("direct SAB and SAB subview dispatch as ordinary immutable snapshots", async () => {
    for (const fixture of [
      {
        name: "direct",
        makeInput(shared) {
          return shared;
        },
        expectedOffset: 0,
        expectedLength: 96,
      },
      {
        name: "subview",
        makeInput(shared) {
          return new Uint8Array(shared, 17, 61);
        },
        expectedOffset: 17,
        expectedLength: 61,
      },
    ]) {
      const pool = new CompressPool(1, 1);
      const shared = new SharedArrayBuffer(96);
      const sharedBytes = new Uint8Array(shared);
      sharedBytes.set(patternBuffer(sharedBytes.length, fixture.name.length));
      const expectedInput = Buffer.from(
        sharedBytes.subarray(fixture.expectedOffset, fixture.expectedOffset + fixture.expectedLength),
      );
      let request;
      pool.workers[0].postMessage = (message) => {
        request = message;
      };
      try {
        const pending = pool.submit("gzip", fixture.makeInput(shared), 1);
        assert.ok(request);
        assert.equal(request.input.buffer instanceof SharedArrayBuffer, false);
        assert.equal(request.input.byteLength, fixture.expectedLength);
        sharedBytes.fill(0xee);
        pool._onMessage(validWorkerResponse(request, compressSync("gzip", request.input, 1)));
        assert.deepEqual(await pending, compressSync("gzip", expectedInput, 1), fixture.name);
      } finally {
        pool.markDead(new Error("test done"));
      }
    }
  });

  await t.test("parked SAB subview snapshots before FIFO admission", async () => {
    const pool = new CompressPool(1, 1);
    const requests = [];
    pool.workers[0].postMessage = (message) => {
      requests.push(message);
    };
    const blockerInput = patternBuffer(32, 21);
    const blocker = pool.submit("gzip", blockerInput, 1);
    const shared = new SharedArrayBuffer(128);
    const sharedBytes = new Uint8Array(shared);
    sharedBytes.set(patternBuffer(sharedBytes.length, 22));
    const subview = new Uint8Array(shared, 23, 73);
    const expectedInput = Buffer.from(subview);
    const parked = pool.submit("gzip", subview, 1);
    try {
      assert.equal(pool.waiters.length, 1);
      assert.equal(pool.waiters[0].input.buffer instanceof SharedArrayBuffer, false);
      assert.deepEqual(pool.waiters[0].input, expectedInput);
      sharedBytes.fill(0xdd);

      pool._onMessage(validWorkerResponse(requests[0], compressSync("gzip", requests[0].input, 1)));
      assert.deepEqual(await blocker, compressSync("gzip", blockerInput, 1));
      assert.equal(requests.length, 2);
      pool._onMessage(validWorkerResponse(requests[1], compressSync("gzip", requests[1].input, 1)));
      assert.deepEqual(await parked, compressSync("gzip", expectedInput, 1));
    } finally {
      pool.markDead(new Error("test done"));
      await Promise.allSettled([blocker, parked]);
    }
  });

  await t.test("worker-death fallback retains the same SAB subview snapshot", async () => {
    const pool = new CompressPool(1, 1);
    const counters = { jobs: 0, fallbacks: 0 };
    const compress = createCompressor(pool, counters);
    const shared = new SharedArrayBuffer(144);
    const sharedBytes = new Uint8Array(shared);
    sharedBytes.set(patternBuffer(sharedBytes.length, 23));
    const subview = new Uint8Array(shared, 29, 79);
    const expected = compressSync("gzip", Buffer.from(subview), 1);
    let request;
    pool.workers[0].postMessage = (message) => {
      request = message;
    };
    try {
      const pending = compress("gzip", subview, 1);
      assert.ok(request);
      assert.equal(request.input.buffer instanceof SharedArrayBuffer, false);
      sharedBytes.fill(0xcc);
      pool.markDead(new Error("synthetic worker death after generic clone"));
      assert.deepEqual(await pending, expected);
      assert.equal(counters.jobs, 0);
      assert.equal(counters.fallbacks, 1);
    } finally {
      pool.markDead(new Error("test done"));
    }
  });
});

test("protocol v3 compresses exact nonzero SAB ranges for fixed and growable owners", async (t) => {
  for (const fixture of [
    {
      name: "fixed",
      createOwner: () => new SharedArrayBuffer(128),
    },
    {
      name: "growable with post-dispatch suffix growth",
      createOwner: () => new SharedArrayBuffer(128, { maxByteLength: 256 }),
    },
  ]) {
    await t.test(fixture.name, async () => {
      const pool = new CompressPool(1, 1);
      const owner = fixture.createOwner();
      const bytes = new Uint8Array(owner);
      bytes.fill(0xa5);
      const expected = patternBuffer(61, fixture.name.length);
      bytes.set(expected, 17);
      const range = Buffer.from(owner, 17, expected.length);
      let request = null;
      const postMessage = pool.workers[0].postMessage.bind(pool.workers[0]);
      pool.workers[0].postMessage = (message, transferList) => {
        request = message;
        return postMessage(message, transferList);
      };
      try {
        const pending = pool.submitShared("gzip", range, 1);
        assert.ok(request);
        assert.strictEqual(request.input, owner);
        assert.equal(request.inputByteOffset, 17);
        assert.equal(request.inputByteLength, 61);
        if (owner.growable) {
          owner.grow(224);
          new Uint8Array(owner, 128).fill(0x5a);
        }
        const body = await pending;
        assert.deepEqual(zlib.gunzipSync(body), expected);
      } finally {
        pool.markDead(new Error("test done"));
      }
    });
  }
});

test("protocol v3 rejects mismatched response ranges and worker-side malformed requests", async (t) => {
  await t.test("pool validates the echoed range against the originally submitted view", async () => {
    const pool = new CompressPool(1, 1);
    const owner = new SharedArrayBuffer(96);
    const range = Buffer.from(owner, 13, 47);
    let request;
    pool.workers[0].postMessage = (message) => {
      request = message;
    };
    const pending = pool.submitShared("gzip", range, 1);
    void pending.catch(() => {});
    pool._onMessage(
      validWorkerResponse(request, compressSync("gzip", range, 1), {
        inputByteOffset: request.inputByteOffset + 1,
      }),
    );
    await assert.rejects(pending, /protocol violation/);
    assert.equal(pool.dead, true);
  });

  await t.test("worker independently validates safe current-backing bounds", async () => {
    const worker = new Worker(require.resolve("../scripts/noaa-beta-compress-worker.js"));
    const owner = new SharedArrayBuffer(128, { maxByteLength: 256 });
    const request = (id, inputByteOffset, inputByteLength) =>
      new Promise((resolve, reject) => {
        const onError = (error) => {
          worker.off("message", onMessage);
          reject(error);
        };
        const onMessage = (message) => {
          worker.off("error", onError);
          resolve(message);
        };
        worker.once("error", onError);
        worker.once("message", onMessage);
        worker.postMessage({
          type: "compress",
          protocolVersion: COMPRESS_PROTOCOL_VERSION,
          id,
          token: BigInt(id),
          inputMode: "shared-array-buffer",
          kind: "gzip",
          input: owner,
          inputByteOffset,
          inputByteLength,
          level: 1,
        });
      });
    try {
      let id = 1;
      for (const [inputByteOffset, inputByteLength] of [
        [-1, 1],
        [0.5, 1],
        [0, -1],
        [Number.MAX_SAFE_INTEGER, 1],
        [120, 9],
        [200, 1],
      ]) {
        const response = await request(id, inputByteOffset, inputByteLength);
        id += 1;
        assert.equal(response.ok, false);
        assert.match(response.error, /range is unsafe|current backing/);
        assert.equal(response.inputByteOffset, inputByteOffset);
        assert.equal(response.inputByteLength, inputByteLength);
      }
      const empty = await request(id, 128, 0);
      assert.equal(empty.ok, true);
      assert.deepEqual(zlib.gunzipSync(Buffer.from(empty.body)), Buffer.alloc(0));
    } finally {
      await worker.terminate();
    }
  });
});

test("shared subview inline fallback excludes poisoned backing bytes and reports view/owner/max telemetry", async () => {
  const owner = new SharedArrayBuffer(128, { maxByteLength: 256 });
  const bytes = new Uint8Array(owner);
  bytes.fill(0xd3);
  const expected = patternBuffer(61, 27);
  bytes.set(expected, 19);
  const view = Buffer.from(owner, 19, expected.length);
  let submitted = null;
  const pool = {
    dead: false,
    canUseSharedInput: () => true,
    submitShared(_kind, raw) {
      submitted = raw;
      return Promise.reject(new Error("synthetic shared range rejection"));
    },
  };
  const counters = { jobs: 0, fallbacks: 0 };
  const compress = createCompressor(pool, counters);
  const body = await compress.shared("gzip", view, 1);
  assert.strictEqual(submitted, view);
  assert.deepEqual(zlib.gunzipSync(body), expected);
  assert.notDeepEqual(zlib.gunzipSync(body), Buffer.from(owner));
  assert.deepEqual(_normalizeSharedInputRange(view), {
    buffer: owner,
    byteOffset: 19,
    byteLength: 61,
    backingByteLength: 128,
    maxByteLength: 256,
  });
  assert.equal(counters.sharedInputJobs || 0, 0);
  assert.equal(counters.sharedInputBytes || 0, 0);
  assert.equal(counters.sharedInputFallbacks, 1);
  assert.equal(counters.sharedInputViewBytes, 61);
  assert.equal(counters.sharedInputBackingBytes, 128);
  assert.equal(counters.sharedInputMaxBytes, 256);
  assert.equal(counters.sharedInputUniqueOwners, 1);
  assert.equal(counters.transportPeakLiveBytes, 128);
  assert.equal(counters.transportLiveBytes, 0);
  assert.throws(() => _normalizeSharedInputRange(Buffer.alloc(1)), /SharedArrayBuffer/);
});

test("public deferred RGBA snapshots before coordinator admission", async () => {
  const width = 11;
  const height = 7;
  const rgba = patternRgba(width, height, 24);
  const expected = encodeRgbaPngFilter0(rgba, width, height, 1);
  const admission = deferred();
  const pool = {
    dead: false,
    submit(kind, raw, level) {
      return Promise.resolve(compressSync(kind, raw, level));
    },
  };
  const layer = { rgba, visibleCount: 1, validCount: width * height };
  const { descriptor, pending } = encodeLayerOrEmptyDeferred(layer, Buffer.from("empty"), width, height, 1, 0, {
    pool,
    counters: null,
    coordinator: {
      schedule(encode) {
        return admission.promise.then(encode);
      },
    },
  });
  rgba.fill(0xbb);
  admission.resolve();
  await pending;
  assert.deepEqual(descriptor.body, expected);
});

test("postMessage throw preserves an attached owner; post-transfer throw marks it permanently lost", async (t) => {
  await t.test("throw before transfer", async () => {
    const pool = new CompressPool(1, 1);
    const lease = pool.acquireOwnedInput(37);
    const expected = patternBuffer(37, 6);
    Buffer.from(lease.buffer).set(expected);
    pool.workers[0].postMessage = () => {
      throw new Error("synthetic post failure");
    };
    try {
      await assert.rejects(pool.submitOwned("png-idat", lease, 1), /synthetic post failure/);
      assert.equal(lease.state, "attached");
      assert.deepEqual(Buffer.from(lease.buffer), expected);
      assert.equal(pool.pendingById.size, 0);
      assert.equal(pool.releaseOwnedInput(lease), true);
    } finally {
      pool.markDead(new Error("test done"));
    }
  });

  await t.test("throw after detachment", async () => {
    const pool = new CompressPool(1, 1);
    const lease = pool.acquireOwnedInput(41);
    pool.workers[0].postMessage = (message) => {
      structuredClone(message.input, { transfer: [message.input] });
      throw new Error("synthetic post failure after transfer");
    };
    try {
      await assert.rejects(pool.submitOwned("png-idat", lease, 1), /after transfer/);
      assert.equal(lease.state, "lost");
      assert.equal(lease.buffer, null);
      assert.equal(pool.ownedInputTelemetry().checkedOut, 0);
      assert.equal(pool.releaseOwnedInput(lease), false, "lost slabs are never recycled");
    } finally {
      pool.markDead(new Error("test done"));
    }
  });
});

test("trusted PNG post failure compresses attached scanlines in place; generic options can never opt into transfer", async () => {
  const width = 17;
  const height = 9;
  const rgba = patternRgba(width, height, 7);
  let released = 0;
  const attachedFailurePool = {
    dead: false,
    acquireOwnedInput(byteLength) {
      return {
        pool: this,
        byteLength,
        buffer: new ArrayBuffer(byteLength),
        state: "attached",
      };
    },
    submitOwned() {
      throw new Error("synthetic attached submit failure");
    },
    releaseOwnedInput(lease) {
      released += 1;
      lease.state = "released";
      lease.buffer = null;
      return true;
    },
  };
  const trustedCounters = { jobs: 0, fallbacks: 0 };
  const trusted = await _encodeTrustedRgbaPngFilter0ViaPool(
    rgba,
    width,
    height,
    1,
    attachedFailurePool,
    trustedCounters,
  );
  assert.deepEqual(trusted, encodeRgbaPngFilter0(rgba, width, height, 1));
  assert.equal(released, 1);
  assert.equal(trustedCounters.fallbacks, 1);
  assert.equal(trustedCounters.ownedInputRebuilds || 0, 0, "attached scanlines are compressed without rebuilding");
  assert.equal(trustedCounters.transportLiveBytes, 0);

  let genericSubmits = 0;
  const genericPool = {
    dead: false,
    acquireOwnedInput() {
      assert.fail("generic PNG API must not acquire a transferable owner");
    },
    submit(kind, raw, level) {
      genericSubmits += 1;
      return Promise.resolve(compressSync(kind, raw, level));
    },
  };
  const generic = await encodeRgbaPngFilter0ViaPool(rgba, width, height, 1, genericPool, null, {
    rgbaIsImmutableUntilSettled: true,
  });
  assert.deepEqual(generic, encodeRgbaPngFilter0(rgba, width, height, 1));
  assert.equal(genericSubmits, 1, "legacy-looking trust flags retain the generic clone ABI");
});

test("worker death after PNG transfer rebuilds exact bytes once and never recycles the lost slab", async () => {
  const pool = new CompressPool(1, 1);
  const counters = { jobs: 0, fallbacks: 0 };
  const width = 512;
  const height = 384;
  const rgba = patternRgba(width, height, 8);
  const expected = encodeRgbaPngFilter0(rgba, width, height, 1);
  const pending = _encodeTrustedRgbaPngFilter0ViaPool(rgba, width, height, 1, pool, counters);
  assert.equal(pool.pendingById.size, 1);
  const pendingLease = [...pool.ownedInputLeases][0];
  assert.equal(pendingLease.state, "in-flight");
  assert.equal(pendingLease.buffer.byteLength, 0);
  pool.markDead(new Error("synthetic worker death after transfer"));
  assert.deepEqual(await pending, expected);
  assert.equal(counters.jobs, 0);
  assert.equal(counters.fallbacks, 1);
  assert.equal(counters.ownedInputFallbacks, 1);
  assert.equal(counters.ownedInputRebuilds, 1);
  assert.equal(counters.transportLiveBytes, 0);
  assert.equal(pendingLease.state, "lost");
  assert.equal(pool.ownedInputTelemetry().liveBytes, 0);
});

test("concurrent owned jobs settle exactly once on worker death and rebuild from independent immutable sources", async () => {
  const pool = new CompressPool(2, 2);
  const counters = { jobs: 0, fallbacks: 0 };
  const width = 384;
  const height = 256;
  const sources = [patternRgba(width, height, 9), patternRgba(width, height, 10)];
  const expected = sources.map((rgba) => encodeRgbaPngFilter0(rgba, width, height, 1));
  const settlements = [0, 0];
  const pending = sources.map((rgba, index) =>
    _encodeTrustedRgbaPngFilter0ViaPool(rgba, width, height, 1, pool, counters).then((body) => {
      settlements[index] += 1;
      return body;
    }),
  );
  assert.equal(pool.pendingById.size, 2);
  pool.markDead(new Error("synthetic concurrent death"));
  const actual = await Promise.all(pending);
  assert.deepEqual(actual, expected);
  assert.deepEqual(settlements, [1, 1]);
  assert.equal(counters.fallbacks, 2);
  assert.equal(counters.ownedInputRebuilds, 2);
  assert.equal(counters.transportLiveBytes, 0);
  assert.equal(pool.waiters.length, 0);
  assert.equal(pool.ownedInputTelemetry().liveBytes, 0);
});

test("worker messageerror rejects pending ownership exactly once and leaves no reusable slab", async () => {
  const pool = new CompressPool(1, 1);
  const lease = pool.acquireOwnedInput(53);
  const pending = pool.submitOwned("png-idat", lease, 1);
  let settlements = 0;
  void pending.catch(() => {
    settlements += 1;
  });
  assert.equal(lease.state, "in-flight");
  pool.workers[0].emit("messageerror", new Error("synthetic undeliverable response"));
  await assert.rejects(pending, /synthetic undeliverable response/);
  await Promise.resolve();
  assert.equal(settlements, 1);
  assert.equal(pool.dead, true);
  assert.equal(lease.state, "lost");
  assert.equal(pool.ownedInputTelemetry().liveBytes, 0);
});

test("worker codec errors return owned slabs, while malformed returned slabs and outputs fail the pool closed", async (t) => {
  await t.test("valid codec error returns the input owner", async () => {
    const pool = new CompressPool(1, 1);
    const lease = pool.acquireOwnedInput(43);
    const expected = patternBuffer(43, 11);
    Buffer.from(lease.buffer).set(expected);
    try {
      await assert.rejects(pool.submitOwned("unknown-kind", lease, 1), (error) => {
        assert.equal(error.code, "ERR_COMPRESS_WORKER");
        return true;
      });
      assert.equal(pool.dead, false);
      assert.equal(lease.state, "attached");
      assert.deepEqual(Buffer.from(lease.buffer), expected);
      assert.equal(pool.releaseOwnedInput(lease), true);
    } finally {
      pool.markDead(new Error("test done"));
    }
  });

  await t.test("wrong-size owner return", async () => {
    const pool = new CompressPool(1, 1);
    let request;
    pool.workers[0].postMessage = (message) => {
      request = message;
    };
    const lease = pool.acquireOwnedInput(47);
    const pending = pool.submitOwned("png-idat", lease, 1);
    void pending.catch(() => {});
    pool._onMessage(
      validWorkerResponse(request, Buffer.from("body"), {
        input: new ArrayBuffer(46),
      }),
    );
    await assert.rejects(pending, /lost owned input/);
    assert.equal(pool.dead, true);
    assert.equal(lease.state, "lost");
    assert.equal(pool.releaseOwnedInput(lease), false);
  });

  await t.test("owned success cannot alias its recyclable input as the returned body", async () => {
    const pool = new CompressPool(1, 1);
    let request;
    pool.workers[0].postMessage = (message) => {
      request = message;
    };
    const lease = pool.acquireOwnedInput(49);
    Buffer.from(lease.buffer).set(patternBuffer(49, 19));
    const pending = pool.submitOwned("png-idat", lease, 1);
    void pending.catch(() => {});
    pool._onMessage({
      type: "compress-result",
      protocolVersion: COMPRESS_PROTOCOL_VERSION,
      id: request.id,
      token: request.token,
      inputMode: request.inputMode,
      ok: true,
      body: request.input,
      input: request.input,
    });
    await assert.rejects(pending, /aliased owned input/);
    assert.equal(pool.dead, true);
    assert.equal(lease.state, "lost");
    assert.equal(pool.releaseOwnedInput(lease), false);
    assert.equal(pool.ownedInputTelemetry().liveBytes, 0);
  });

  await t.test("non-ArrayBuffer output and wrong protocol version", async (subtest) => {
    for (const fixture of [
      {
        name: "invalid output view",
        response: (request) =>
          validWorkerResponse(request, Buffer.from("unused"), {
            body: Uint8Array.from([1, 2, 3]),
          }),
        pattern: /invalid body/,
      },
      {
        name: "empty output buffer",
        response: (request) =>
          validWorkerResponse(request, Buffer.from("unused"), {
            body: new ArrayBuffer(0),
          }),
        pattern: /invalid body/,
      },
      {
        name: "protocol mismatch",
        response: (request) =>
          validWorkerResponse(request, Buffer.from("unused"), {
            protocolVersion: COMPRESS_PROTOCOL_VERSION + 1,
          }),
        pattern: /protocol violation/,
      },
    ]) {
      await subtest.test(fixture.name, async () => {
        const pool = new CompressPool(1, 1);
        let request;
        pool.workers[0].postMessage = (message) => {
          request = message;
        };
        const pending = pool.submit("gzip", Buffer.from("probe"), 1);
        void pending.catch(() => {});
        pool._onMessage(fixture.response(request));
        await assert.rejects(pending, fixture.pattern);
        assert.equal(pool.dead, true);
      });
    }
  });
});

test("tokenized protocol ignores duplicate and ABA-stale replies after numeric id reuse", async () => {
  const pool = new CompressPool(1, 2);
  const requests = [];
  pool.workers[0].postMessage = (message) => {
    requests.push(message);
  };
  try {
    const firstInput = Buffer.from("first");
    const first = pool.submit("gzip", firstInput, 1);
    const firstRequest = requests[0];
    const firstBody = zlib.gzipSync(firstInput, { level: 1 });
    pool._onMessage(validWorkerResponse(firstRequest, firstBody));
    assert.deepEqual(await first, firstBody);
    pool._onMessage(validWorkerResponse(firstRequest, firstBody));

    pool.nextJobId = firstRequest.id;
    const secondInput = Buffer.from("second");
    let secondSettled = false;
    const second = pool.submit("gzip", secondInput, 1).then((body) => {
      secondSettled = true;
      return body;
    });
    const secondRequest = requests[1];
    assert.equal(secondRequest.id, firstRequest.id, "fixture must reuse the compact numeric id");
    assert.notEqual(secondRequest.token, firstRequest.token, "ABA guard token must never be reused");

    pool._onMessage(validWorkerResponse(firstRequest, firstBody));
    await Promise.resolve();
    assert.equal(secondSettled, false, "stale reply must not settle the current same-id job");
    assert.equal(pool.pendingById.size, 1);

    const secondBody = zlib.gzipSync(secondInput, { level: 1 });
    pool._onMessage(validWorkerResponse(secondRequest, secondBody));
    assert.deepEqual(await second, secondBody);
    assert.equal(pool.pendingById.size, 0);
  } finally {
    pool.markDead(new Error("test done"));
  }
});

test("hover generic callbacks retain Buffer ABI; trusted compressor publishes one immutable exact SAB", async () => {
  const variables = hoverVariables(12);
  const inline = buildHoverGridArtifact({
    width: 32,
    height: 1,
    variables,
    format: "binary",
  });
  let genericRaw = null;
  const generic = buildHoverGridArtifact({
    width: 32,
    height: 1,
    variables,
    format: "binary",
    compress(kind, raw, level) {
      genericRaw = raw;
      return Promise.resolve(compressSync(kind, raw, level));
    },
  });
  await generic.pending;
  assert.ok(Buffer.isBuffer(genericRaw));
  assert.equal(genericRaw.buffer instanceof SharedArrayBuffer, false);
  assert.deepEqual(generic.body, inline.body);

  const control = deferred();
  let sharedRaw = null;
  let publishedSnapshot = null;
  const fakePool = {
    dead: false,
    maxPending: 1,
    canUseSharedInput: () => true,
    submitShared(kind, raw, level) {
      sharedRaw = raw;
      publishedSnapshot = Buffer.from(raw);
      return control.promise.then(() => compressSync(kind, raw, level));
    },
    submit() {
      assert.fail("trusted hover must not call the generic clone transport");
    },
  };
  const counters = { jobs: 0, fallbacks: 0 };
  const trusted = buildHoverGridArtifact({
    width: 32,
    height: 1,
    variables,
    format: "binary",
    compress: createCompressor(fakePool, counters),
  });
  assert.ok(Buffer.isBuffer(sharedRaw));
  assert.ok(sharedRaw.buffer instanceof SharedArrayBuffer);
  assert.equal(sharedRaw.byteOffset, 0);
  assert.equal(sharedRaw.byteLength, sharedRaw.buffer.byteLength);
  assert.deepEqual(
    sharedRaw,
    buildHoverGridBinaryRaw({
      schemaVersion: HOVER_GRID_SCHEMA_VERSION,
      rows: 1,
      cols: 32,
      variables,
    }),
    "submit observes a completely published canonical raw container",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(Buffer.from(sharedRaw), publishedSnapshot, "producer must never mutate the SAB after publication");
  assert.ok(counters.transportLiveBytes > 0, "the retained owner is live until settlement");
  control.resolve();
  await trusted.pending;
  assert.deepEqual(trusted.body, inline.body);
  assert.equal(counters.sharedInputJobs, 1);
  assert.equal(counters.cloneInputJobs || 0, 0);
  assert.equal(counters.sharedInputBytes, publishedSnapshot.length);
  assert.equal(counters.transportPeakLiveBytes, publishedSnapshot.length);
  assert.equal(counters.transportLiveBytes, 0);
  assert.equal("sharedInputFree" in fakePool, false, "hover has no persistent giant-body recycler");
});

test("shared worker rejection/death falls back from the retained SAB exactly once", async () => {
  const variables = hoverVariables(13);
  const inline = buildHoverGridArtifact({
    width: 32,
    height: 1,
    variables,
    format: "binary",
  });
  let submittedRaw;
  const fakePool = {
    dead: false,
    canUseSharedInput: () => true,
    submitShared(_kind, raw) {
      submittedRaw = raw;
      return Promise.reject(new Error("synthetic shared worker death"));
    },
  };
  const counters = { jobs: 0, fallbacks: 0 };
  const artifact = buildHoverGridArtifact({
    width: 32,
    height: 1,
    variables,
    format: "binary",
    compress: createCompressor(fakePool, counters),
  });
  await artifact.pending;
  assert.ok(submittedRaw.buffer instanceof SharedArrayBuffer);
  assert.deepEqual(artifact.body, inline.body);
  assert.equal(counters.jobs, 0);
  assert.equal(counters.fallbacks, 1);
  assert.equal(counters.sharedInputFallbacks, 1);
  assert.equal(counters.transportLiveBytes, 0);
});

test("trusted hover builds one exact SAB even when the helper is unavailable before packing", async (t) => {
  const variables = hoverVariables(131);
  const expectedRaw = buildHoverGridBinaryRaw({
    schemaVersion: HOVER_GRID_SCHEMA_VERSION,
    rows: 1,
    cols: 32,
    variables,
  });
  const inline = buildHoverGridArtifact({
    width: 32,
    height: 1,
    variables,
    format: "binary",
  });

  for (const fixture of [
    { name: "spawn failure / null pool", pool: null },
    {
      name: "pool already dead",
      pool: {
        dead: true,
        canUseSharedInput: () => false,
        submitShared() {
          assert.fail("an already-dead pool must be skipped");
        },
      },
    },
  ]) {
    await t.test(fixture.name, async () => {
      const counters = { jobs: 0, fallbacks: 0 };
      const compress = createCompressor(fixture.pool, counters);
      const compressShared = compress.shared;
      let publishedRaw = null;
      compress.shared = (...args) => {
        publishedRaw = args[1];
        return compressShared(...args);
      };
      const artifact = buildHoverGridArtifact({
        width: 32,
        height: 1,
        variables,
        format: "binary",
        compress,
      });
      await artifact.pending;
      assert.ok(Buffer.isBuffer(publishedRaw));
      assert.ok(publishedRaw.buffer instanceof SharedArrayBuffer);
      assert.equal(publishedRaw.byteOffset, 0);
      assert.equal(publishedRaw.byteLength, publishedRaw.buffer.byteLength);
      assert.deepEqual(publishedRaw, expectedRaw);
      assert.deepEqual(artifact.body, inline.body);
      assert.equal(counters.jobs, 0);
      assert.equal(counters.fallbacks, 1);
      assert.equal(counters.sharedInputFallbacks, 1);
      assert.equal(counters.cloneInputJobs || 0, 0);
      assert.equal(counters.transportLiveBytes, 0);
    });
  }
});

test("two frame coordinators cannot build or submit a second SAB before shared global admission", async () => {
  const controls = [];
  const submissions = [];
  const fakePool = {
    dead: false,
    maxPending: 1,
    canUseSharedInput: () => true,
    submitShared(kind, raw, level) {
      const control = deferred();
      controls.push(control);
      submissions.push({ kind, raw, level });
      return control.promise.then(() => compressSync(kind, raw, level));
    },
  };
  const compress = createCompressor(fakePool, { jobs: 0, fallbacks: 0 });
  const gate = getArtifactEncodeAdmissionGate(fakePool, 1);
  const firstCoordinator = new ArtifactEncodeCoordinator(1, { admissionGate: gate });
  const secondCoordinator = new ArtifactEncodeCoordinator(1, { admissionGate: gate });
  const first = buildHoverGridArtifact({
    width: 32,
    height: 1,
    variables: hoverVariables(14),
    format: "binary",
    compress,
    coordinator: firstCoordinator,
  });
  const second = buildHoverGridArtifact({
    width: 32,
    height: 1,
    variables: hoverVariables(15),
    format: "binary",
    compress,
    coordinator: secondCoordinator,
  });
  assert.equal(submissions.length, 1, "second frame remains a start function, not a prebuilt 225 MB SAB");
  assert.equal(second.body, null);
  assert.ok(Number.isFinite(first.packDurationMs));
  assert.equal(second.packDurationMs, undefined, "deferred packing time is absent until global admission");
  controls[0].resolve();
  await first.pending;
  for (let attempt = 0; attempt < 10 && submissions.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(submissions.length, 2);
  assert.ok(Number.isFinite(second.packDurationMs), "deferred packing reports its CPU time after admission");
  assert.ok(submissions.every(({ raw }) => raw.buffer instanceof SharedArrayBuffer));
  assert.notStrictEqual(submissions[0].raw.buffer, submissions[1].raw.buffer);
  controls[1].resolve();
  await second.pending;
  assert.ok(Buffer.isBuffer(first.body));
  assert.ok(Buffer.isBuffer(second.body));
});

test("renderer-private gate engages owned PNG + shared hover with exact artifacts and peak accounting", async () => {
  const frame = {
    decoded: {
      temperature2m: new Float32Array([300, 301, 302, 303]),
      windU10m: new Float32Array([1, 2, 3, 4]),
      windV10m: new Float32Array([4, 3, 2, 1]),
      pressureMsl: new Float32Array([101000, 101100, 101200, 101300]),
    },
    selection: { catalog: [], availableParameters: [], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "hrrr",
    width: 2,
    height: 2,
    reflectivityGates: [10, 15, 20],
    pngCompressionLevel: 1,
    pngFilterType: 0,
    hoverGridFormat: "binary",
  };
  const inline = await buildRenderedArtifacts(frame);
  const pool = new CompressPool(1, 2);
  const counters = { jobs: 0, fallbacks: 0 };
  try {
    const pooled = await buildRenderedArtifacts({
      ...frame,
      profile: { stages: {} },
      compress: createCompressor(pool, counters),
      layerEncodeContext: { pool, counters },
    });
    assert.deepEqual(Object.keys(pooled.layers), Object.keys(inline.layers));
    for (const key of Object.keys(inline.layers)) {
      assert.deepEqual(pooled.layers[key].body, inline.layers[key].body, key);
    }
    assert.deepEqual(pooled.hoverGrid.body, inline.hoverGrid.body);
    assert.ok(counters.ownedInputJobs > 0, "renderer PNGs must use transferred owners");
    assert.equal(counters.sharedInputJobs, 1, "renderer hover must use direct SAB input");
    assert.equal(counters.cloneInputJobs || 0, 0);
    assert.equal(counters.fallbacks, 0);
    assert.equal(counters.transportLiveBytes, 0);
    assert.ok(counters.transportPeakLiveBytes > 0);
    assert.equal(pool.waiters.length, 0);
    const recycler = pool.ownedInputTelemetry();
    assert.ok(recycler.free <= pool.maxPending);
    assert.ok(recycler.checkedOut + recycler.free <= pool.maxPending);
  } finally {
    pool.markDead(new Error("test done"));
  }
});

test("renderer owns the derived hover-profile rejection in the scheduling turn", async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      buildRenderedArtifacts({
        decoded: {
          temperature2m: new Float32Array([300, 301, 302, 303]),
          windU10m: new Float32Array([1, 2, 3, 4]),
          windV10m: new Float32Array([4, 3, 2, 1]),
          pressureMsl: new Float32Array([101000, 101100, 101200, 101300]),
        },
        selection: { catalog: [], availableParameters: [], records: {} },
        framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
        bounds: { north: 53, south: 21, west: -129, east: -63 },
        modelKey: "hrrr",
        width: 2,
        height: 2,
        reflectivityGates: [10, 15, 20],
        pngCompressionLevel: 1,
        pngFilterType: 0,
        hoverGridFormat: "binary",
        profile: { stages: {} },
        compress() {
          return Promise.reject(new Error("synthetic hover compression rejection"));
        },
      }),
      /synthetic hover compression rejection/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("finalized production profile preserves transport engagement, failure, and peak-byte telemetry", () => {
  const finalized = finalizeNoaaRenderProfile({
    compressPoolJobs: 5,
    compressPoolFallbacks: 2,
    compressOwnedInputJobs: 4,
    compressOwnedInputBytes: 1234,
    compressOwnedInputFallbacks: 1,
    compressOwnedInputRebuilds: 1,
    compressSharedInputJobs: 1,
    compressSharedInputBytes: 5678,
    compressSharedInputViewBytes: 5678,
    compressSharedInputBackingBytes: 6000,
    compressSharedInputMaxBytes: 7000,
    compressSharedInputUniqueOwners: 1,
    compressSharedInputFallbacks: 1,
    compressTransportRetainedLiveBytes: 1234,
    compressTransportPeakLiveBytes: 6912,
    hoverArena: { viewBytes: 5678, backingBytes: 6000, uniqueOwners: 1 },
    hoverArenaFallbackReason: "disabled",
    stages: {},
  });
  assert.deepEqual(
    {
      compressPoolJobs: finalized.compressPoolJobs,
      compressPoolFallbacks: finalized.compressPoolFallbacks,
      compressOwnedInputJobs: finalized.compressOwnedInputJobs,
      compressOwnedInputBytes: finalized.compressOwnedInputBytes,
      compressOwnedInputFallbacks: finalized.compressOwnedInputFallbacks,
      compressOwnedInputRebuilds: finalized.compressOwnedInputRebuilds,
      compressSharedInputJobs: finalized.compressSharedInputJobs,
      compressSharedInputBytes: finalized.compressSharedInputBytes,
      compressSharedInputViewBytes: finalized.compressSharedInputViewBytes,
      compressSharedInputBackingBytes: finalized.compressSharedInputBackingBytes,
      compressSharedInputMaxBytes: finalized.compressSharedInputMaxBytes,
      compressSharedInputUniqueOwners: finalized.compressSharedInputUniqueOwners,
      compressSharedInputFallbacks: finalized.compressSharedInputFallbacks,
      compressTransportRetainedLiveBytes: finalized.compressTransportRetainedLiveBytes,
      compressTransportPeakLiveBytes: finalized.compressTransportPeakLiveBytes,
      hoverArena: finalized.hoverArena,
      hoverArenaFallbackReason: finalized.hoverArenaFallbackReason,
    },
    {
      compressPoolJobs: 5,
      compressPoolFallbacks: 2,
      compressOwnedInputJobs: 4,
      compressOwnedInputBytes: 1234,
      compressOwnedInputFallbacks: 1,
      compressOwnedInputRebuilds: 1,
      compressSharedInputJobs: 1,
      compressSharedInputBytes: 5678,
      compressSharedInputViewBytes: 5678,
      compressSharedInputBackingBytes: 6000,
      compressSharedInputMaxBytes: 7000,
      compressSharedInputUniqueOwners: 1,
      compressSharedInputFallbacks: 1,
      compressTransportRetainedLiveBytes: 1234,
      compressTransportPeakLiveBytes: 6912,
      hoverArena: { viewBytes: 5678, backingBytes: 6000, uniqueOwners: 1 },
      hoverArenaFallbackReason: "disabled",
    },
  );
});
