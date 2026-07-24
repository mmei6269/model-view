"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PNG } = require("pngjs");

const {
  ArtifactEncodeAdmissionGate,
  ArtifactEncodeCoordinator,
} = require("../scripts/lib/noaa-beta/artifact-encode-coordinator");
const { CompressPool, compressSync, createCompressor } = require("../scripts/lib/noaa-beta/compress-pool");
const { buildHoverGridArtifact, buildHoverGridVariables } = require("../scripts/lib/noaa-beta/hover");
const { createTransparentPng } = require("../scripts/lib/noaa-beta/png-encode");
const { renderReflectivityVariants } = require("../scripts/lib/noaa-beta/raster");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../scripts/lib/noaa-nam-parameter-catalog");
const { _testBuildRenderedArtifacts: buildRenderedArtifacts } = require("../scripts/lib/noaa-beta-renderer");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("artifact coordinator admits a bounded FIFO set and queues start functions before raw construction", async () => {
  const coordinator = new ArtifactEncodeCoordinator(2);
  const controls = Array.from({ length: 5 }, () => deferred());
  const started = [];
  const jobs = controls.map((control, index) =>
    coordinator.schedule(() => {
      started.push(index);
      return control.promise;
    }, `job-${index}`),
  );
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(coordinator.telemetry(), {
    maxActive: 2,
    checkpoints: 0,
    backpressureMs: 0,
    peakActive: 2,
    peakQueued: 3,
    submitted: 5,
  });

  controls[0].resolve("zero");
  await jobs[0];
  assert.deepEqual(started, [0, 1, 2]);
  controls[1].resolve("one");
  controls[2].resolve("two");
  await Promise.all([jobs[1], jobs[2]]);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  controls[3].resolve("three");
  controls[4].resolve("four");
  await coordinator.drain();
  assert.deepEqual(await Promise.all(jobs), ["zero", "one", "two", "three", "four"]);
  assert.equal(coordinator.telemetry().peakActive, 2);
});

test("coordinator and shared gate sever admitted start closures before codec settlement", async () => {
  const coordinator = new ArtifactEncodeCoordinator(1);
  const firstControl = deferred();
  const secondControl = deferred();
  const first = coordinator.schedule(() => firstControl.promise, "first");
  const second = coordinator.schedule(() => secondControl.promise, "second");
  assert.equal([...coordinator.active.values()][0].start, null);
  assert.equal(typeof coordinator.queue[0].start, "function", "queued work must retain its not-yet-invoked start");

  firstControl.resolve("first");
  await first;
  assert.equal([...coordinator.active.values()][0].start, null);
  secondControl.resolve("second");
  assert.equal(await second, "second");

  const gate = new ArtifactEncodeAdmissionGate(1);
  const gateControl = deferred();
  let admittedEntry = null;
  gate.queue.shift = function captureShiftedEntry() {
    admittedEntry = Array.prototype.shift.call(this);
    return admittedEntry;
  };
  const gated = gate.run(() => gateControl.promise);
  assert.ok(admittedEntry);
  assert.equal(admittedEntry.start, null);
  gateControl.resolve("gated");
  assert.equal(await gated, "gated");
});

test("artifact coordinator drains all work and reports the earliest submission failure", async () => {
  const coordinator = new ArtifactEncodeCoordinator(1);
  const late = deferred();
  const first = coordinator.schedule(() => late.promise, "first");
  const second = coordinator.schedule(() => Promise.reject(new Error("second failed")), "second");
  const third = coordinator.schedule(() => Promise.reject(new Error("third failed")), "third");
  void first.catch(() => {});
  void second.catch(() => {});
  void third.catch(() => {});
  late.resolve("ok");
  await assert.rejects(coordinator.drain(), (error) => {
    assert.equal(error.message, "second failed");
    assert.equal(error.artifactEncodeOrdinal, 2);
    assert.equal(error.artifactEncodeLabel, "second");
    return true;
  });
  assert.equal(coordinator.telemetry().submitted, 3);
  assert.equal(coordinator.telemetry().peakActive, 1);
});

test("artifact coordinator chooses the earliest ordinal after out-of-order failures cross a checkpoint", async () => {
  const coordinator = new ArtifactEncodeCoordinator(2);
  const firstControl = deferred();
  const secondControl = deferred();
  const first = coordinator.schedule(() => firstControl.promise, "first");
  const second = coordinator.schedule(() => secondControl.promise, "second");
  void first.catch(() => {});
  void second.catch(() => {});
  const checkpoint = coordinator.waitForCapacity();
  secondControl.reject(new Error("second failed first"));
  await checkpoint;
  firstControl.reject(new Error("first failed later"));
  await assert.rejects(coordinator.drain(), (error) => {
    assert.equal(error.message, "first failed later");
    assert.equal(error.artifactEncodeOrdinal, 1);
    return true;
  });
});

test("artifact coordinator reports frozen codec errors without mutating or masking them", async () => {
  const coordinator = new ArtifactEncodeCoordinator(1);
  const frozen = Object.freeze(new Error("frozen codec failure"));
  const job = coordinator.schedule(() => Promise.reject(frozen), "frozen");
  void job.catch(() => {});
  await assert.rejects(coordinator.drain(), (error) => {
    assert.equal(error.message, "frozen codec failure");
    assert.equal(error.artifactEncodeOrdinal, 1);
    assert.equal(error.artifactEncodeLabel, "frozen");
    assert.strictEqual(error.cause, frozen);
    return true;
  });
  assert.equal(Object.hasOwn(frozen, "artifactEncodeOrdinal"), false);
});

test("renderer dispatches one core PNG then hover within the first two codec jobs and returns settled bodies", async () => {
  const dispatches = [];
  const pool = {
    dead: false,
    maxPending: 2,
    submit(kind, buffer, level) {
      dispatches.push(kind);
      return new Promise((resolve) => {
        setImmediate(() => resolve(compressSync(kind, buffer, level)));
      });
    },
    submitShared(kind, buffer, level) {
      return this.submit(kind, buffer, level);
    },
    canUseSharedInput() {
      return true;
    },
  };
  const counters = { jobs: 0, fallbacks: 0 };
  const profile = { stages: {} };
  const artifacts = await buildRenderedArtifacts({
    decoded: { temperature2m: new Float32Array([300, 300, 300, 300]) },
    selection: { catalog: [], availableParameters: [], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: [10, 15, 20],
    pngCompressionLevel: 1,
    pngFilterType: 0,
    hoverGridFormat: "binary",
    profile,
    compress: createCompressor(pool, counters),
    layerEncodeContext: { pool, counters },
  });
  assert.equal(dispatches[0], "png-idat");
  assert.ok(dispatches.slice(0, 2).includes("brotli"), `first two dispatches were ${dispatches.slice(0, 2)}`);
  assert.ok(Buffer.isBuffer(artifacts.layers.temperature.body));
  assert.ok(Buffer.isBuffer(artifacts.hoverGrid.body));
  assert.equal(artifacts.pendingEncodes, undefined);
  assert.ok(profile.artifactEncodeCheckpoints > 0);
  assert.equal(profile.artifactEncodePeakActive, 2);
  assert.ok(profile.artifactEncodePeakQueued <= 2);
  assert.ok(profile.stages.artifactBackpressureMs >= 0);
  assert.ok(profile.stages.compressWaitMs >= 0);
});

test("early tracked-grid shape gate reproduces legacy late hover for full and malformed wind grids", () => {
  const catalog = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => ["temperature", "wind"].includes(entry.key));
  const selection = { catalog, availableParameters: ["temperature", "wind"] };
  const temperatureF = new Float32Array([50, 51, 52, 53]);
  const fullWind = new Float32Array([10, 20, 30, 40]);
  const shared = {
    decoded: {},
    selection,
    temperatureF,
    width: 2,
    height: 2,
    preDeltaEncode: false,
  };
  const compare = (windMph, lateWindCount) => {
    const early = buildHoverGridVariables({
      ...shared,
      windMph,
      hoverValueCounts: new Map([["temperature", 4]]),
      requireTrackedGridShape: true,
    });
    const late = buildHoverGridVariables({
      ...shared,
      windMph,
      hoverValueCounts: new Map([
        ["temperature", 4],
        ["wind", lateWindCount],
      ]),
    });
    const earlyBody = buildHoverGridArtifact({
      width: 2,
      height: 2,
      variables: early,
      format: "binary",
    }).body;
    const lateBody = buildHoverGridArtifact({
      width: 2,
      height: 2,
      variables: late,
      format: "binary",
    }).body;
    assert.deepEqual(Object.keys(early), Object.keys(late));
    assert.deepEqual(earlyBody, lateBody);
  };
  compare(fullWind, 4);
  compare(fullWind.subarray(0, 2), 0);
});

test("real one- and two-thread pools keep coordinator work out of pool waiters and preserve exact bytes", async () => {
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
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: [10, 15, 20],
    pngCompressionLevel: 1,
    pngFilterType: 0,
    hoverGridFormat: "binary",
  };
  const inline = await buildRenderedArtifacts(frame);
  for (const threads of [1, 2]) {
    const pool = new CompressPool(threads, threads);
    const counters = { jobs: 0, fallbacks: 0 };
    try {
      const pooled = await buildRenderedArtifacts({
        ...frame,
        profile: { stages: {} },
        compress: createCompressor(pool, counters),
        layerEncodeContext: { pool, counters },
      });
      assert.equal(pool.waiters.length, 0, `${threads}-thread coordinator must not create pool waiters`);
      assert.deepEqual(Object.keys(pooled.layers), Object.keys(inline.layers));
      for (const key of Object.keys(inline.layers)) {
        assert.deepEqual(pooled.layers[key].body, inline.layers[key].body, `${threads}-thread ${key}`);
      }
      assert.deepEqual(pooled.hoverGrid.body, inline.hoverGrid.body, `${threads}-thread hover`);
      assert.equal(counters.fallbacks, 0);
      assert.ok(counters.jobs > 0);
    } finally {
      pool.markDead(new Error("test done"));
    }
  }
});

test("pool-scoped admission prevents two concurrent frame coordinators from exceeding the shared cap", async () => {
  const pool = {
    dead: false,
    maxPending: 2,
    active: 0,
    overflow: 0,
    peakActive: 0,
    submit(kind, buffer, level) {
      if (this.active >= this.maxPending) {
        this.overflow += 1;
      }
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      return new Promise((resolve) => {
        setImmediate(() => {
          const body = compressSync(kind, buffer, level);
          this.active -= 1;
          resolve(body);
        });
      });
    },
    submitShared(kind, buffer, level) {
      return this.submit(kind, buffer, level);
    },
    canUseSharedInput() {
      return true;
    },
  };
  const frame = {
    decoded: {
      temperature2m: new Float32Array([300, 301, 302, 303]),
      windU10m: new Float32Array([1, 2, 3, 4]),
      windV10m: new Float32Array([4, 3, 2, 1]),
    },
    selection: { catalog: [], availableParameters: [], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: [10, 15, 20],
    pngCompressionLevel: 1,
    pngFilterType: 0,
    hoverGridFormat: "binary",
  };
  const build = (hour) => {
    const counters = { jobs: 0, fallbacks: 0 };
    return buildRenderedArtifacts({
      ...frame,
      framePlan: { hour, validTime: `2026-07-11T${String(hour).padStart(2, "0")}:00:00Z` },
      profile: { stages: {} },
      compress: createCompressor(pool, counters),
      layerEncodeContext: { pool, counters },
    });
  };
  const [first, second] = await Promise.all([build(6), build(7)]);
  assert.equal(pool.overflow, 0);
  assert.equal(pool.peakActive, 2);
  assert.notStrictEqual(first.layers.temperature, second.layers.temperature);
  assert.deepEqual(first.layers.temperature.body, second.layers.temperature.body);
  assert.deepEqual(first.hoverGrid.body, second.hoverGrid.body);
});

test("normal three-gate reflectivity keeps codec overlap instead of forcing a phase drain", async () => {
  const submissions = [];
  const pool = {
    dead: false,
    maxPending: 2,
    active: 0,
    submit(kind, buffer, level) {
      const control = deferred();
      const submission = {
        activeBefore: this.active,
        control,
        kind,
      };
      submissions.push(submission);
      this.active += 1;
      return control.promise.then(() => {
        this.active -= 1;
        return compressSync(kind, buffer, level);
      });
    },
    submitShared(kind, buffer, level) {
      return this.submit(kind, buffer, level);
    },
    canUseSharedInput() {
      return true;
    },
  };
  const counters = { jobs: 0, fallbacks: 0 };
  const build = buildRenderedArtifacts({
    decoded: {
      temperature2m: new Float32Array([300, 301, 302, 303]),
      windU10m: new Float32Array([1, 2, 3, 4]),
      windV10m: new Float32Array([4, 3, 2, 1]),
      precip: new Float32Array([1, 1, 1, 1]),
      reflectivityComposite: new Float32Array([20, 25, 30, 35]),
    },
    selection: { catalog: [], availableParameters: [], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: [10, 15, 20],
    pngCompressionLevel: 1,
    pngFilterType: 0,
    hoverGridFormat: "binary",
    profile: { stages: {} },
    compress: createCompressor(pool, counters),
    layerEncodeContext: { pool, counters },
  });
  // Temperature + hover start immediately. Resolve one job at a time so a
  // phase-wide idle barrier would be observable as activeBefore === 0 on the
  // first reflectivity submission (ordinal four).
  for (let index = 0; index < 6; index += 1) {
    for (let attempt = 0; attempt < 20 && submissions.length <= index; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(submissions[index], `missing codec submission ${index + 1}`);
    submissions[index].control.resolve();
  }
  const artifacts = await build;
  assert.deepEqual(
    submissions.map((entry) => entry.kind),
    ["png-idat", "brotli", "png-idat", "png-idat", "png-idat", "png-idat"],
  );
  assert.equal(submissions[3].activeBefore, 1, "first reflectivity encode must overlap prior codec work");
  assert.equal(pool.active, 0);
  assert.ok(Buffer.isBuffer(artifacts.reflectivityVariants.dbz10.body));
  assert.ok(Buffer.isBuffer(artifacts.reflectivityVariants.dbz15.body));
  assert.ok(Buffer.isBuffer(artifacts.reflectivityVariants.dbz20.body));
});

test("cooperative reflectivity encoding bounds arbitrary gate rosters", async () => {
  const pool = {
    dead: false,
    maxPending: 1,
    submit(kind, buffer, level) {
      return new Promise((resolve) => {
        setImmediate(() => resolve(compressSync(kind, buffer, level)));
      });
    },
    submitShared(kind, buffer, level) {
      return this.submit(kind, buffer, level);
    },
    canUseSharedInput() {
      return true;
    },
  };
  const counters = { jobs: 0, fallbacks: 0 };
  const profile = { stages: {} };
  const gates = Array.from({ length: 24 }, (_, index) => index);
  const artifacts = await buildRenderedArtifacts({
    decoded: {
      temperature2m: new Float32Array([300, 300, 300, 300]),
      reflectivityComposite: new Float32Array([30, 30, 30, 30]),
    },
    selection: { catalog: [], availableParameters: [], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: gates,
    pngCompressionLevel: 1,
    pngFilterType: 0,
    hoverGridFormat: "binary",
    profile,
    compress: createCompressor(pool, counters),
    layerEncodeContext: { pool, counters },
  });
  const expectedKeys = gates.map((gate) => `dbz${gate}`);
  assert.deepEqual(Object.keys(artifacts.reflectivityVariants), expectedKeys);
  assert.equal(profile.artifactEncodePeakActive, 1);
  assert.ok(profile.artifactEncodePeakQueued <= 1);
  const reference = renderReflectivityVariants({
    values: new Float32Array([30, 30, 30, 30]),
    width: 2,
    height: 2,
    reflectivityGates: gates,
    emptyPng: createTransparentPng(2, 2, 1, 0),
    pngCompressionLevel: 1,
    pngFilterType: 0,
  });
  for (const key of expectedKeys) {
    const indexedBody = artifacts.reflectivityVariants[key].body;
    const rgbaBody = reference[key].body;
    assert.equal(indexedBody[25], 3, `${key}: production body must be indexed color`);
    assert.equal(rgbaBody[25], 6, `${key}: independent oracle must stay RGBA`);
    assert.deepEqual(PNG.sync.read(indexedBody).data, PNG.sync.read(rgbaBody).data, `${key}: decoded RGBA`);
  }
});

test("worker death drains active, pool-gated, and frame-queued work with exact inline fallbacks", async () => {
  const frame = {
    decoded: {
      temperature2m: new Float32Array([300, 301, 302, 303]),
      windU10m: new Float32Array([1, 2, 3, 4]),
      windV10m: new Float32Array([4, 3, 2, 1]),
      reflectivityComposite: new Float32Array([20, 25, 30, 35]),
    },
    selection: { catalog: [], availableParameters: [], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: [10, 15, 20],
    pngCompressionLevel: 1,
    pngFilterType: 0,
    hoverGridFormat: "binary",
  };
  const inline = await buildRenderedArtifacts(frame);
  assert.equal(
    inline.layers.reflectivityComposite.body[25],
    3,
    "worker-death oracle must include a real indexed PNG job",
  );
  const pool = new CompressPool(1, 1);
  const build = (hour) => {
    const counters = { jobs: 0, fallbacks: 0 };
    return {
      counters,
      promise: buildRenderedArtifacts({
        ...frame,
        framePlan: { hour, validTime: `2026-07-11T${String(hour).padStart(2, "0")}:00:00Z` },
        profile: { stages: {} },
        compress: createCompressor(pool, counters),
        layerEncodeContext: { pool, counters },
      }),
    };
  };
  const first = build(6);
  const second = build(7);
  for (let attempt = 0; attempt < 20 && pool.pendingById.size === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(pool.pendingById.size, 1);
  assert.equal(pool.waiters.length, 0, "pool-scoped gate must keep the second frame outside submit");
  await pool.workers[0].terminate();
  const results = await Promise.all([first.promise, second.promise]);
  for (const result of results) {
    assert.deepEqual(Object.keys(result.layers), Object.keys(inline.layers));
    for (const key of Object.keys(inline.layers)) {
      assert.ok(Buffer.isBuffer(result.layers[key].body), `${key} descriptor must be settled`);
      assert.deepEqual(result.layers[key].body, inline.layers[key].body, key);
    }
    assert.deepEqual(result.hoverGrid.body, inline.hoverGrid.body);
  }
  assert.equal(pool.waiters.length, 0);
  assert.equal(pool.pendingById.size, 0);
  assert.ok(first.counters.fallbacks >= 2);
  assert.ok(second.counters.fallbacks >= 2);
});
