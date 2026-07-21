"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { prefetchFrameMainGribInput } = require("../scripts/lib/noaa-build/input-prefetch");
const { startFrameInputPrefetch } = require("../scripts/lib/noaa-build/frame-queue");
const { _testResolveInputPrefetchConcurrency } = require("../scripts/build-noaa-beta-artifacts");

const IDX_TEXT = [
  "1:0:d=2026071412:TMP:2 m above ground:6 hour fcst:",
  "2:1000:d=2026071412:DPT:2 m above ground:6 hour fcst:",
  "3:2000:d=2026071412:UGRD:10 m above ground:6 hour fcst:",
  "4:3000:d=2026071412:VGRD:10 m above ground:6 hour fcst:",
  "5:4000:d=2026071412:ZZZZ:not a real level:6 hour fcst:",
  "",
].join("\n");

function installFetchMock(counters) {
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const range = options.headers?.Range || options.headers?.range;
    if (target.endsWith(".idx")) {
      counters.idx += 1;
      return {
        ok: true,
        status: 200,
        text: async () => IDX_TEXT,
        headers: { get: () => null },
      };
    }
    if (range) {
      counters.ranges += 1;
      const match = /^bytes=(\d+)-(\d+)$/.exec(String(range));
      assert.ok(match, `well-formed Range header, got '${range}'`);
      const length = Number(match[2]) - Number(match[1]) + 1;
      counters.rangeBytes += length;
      const body = Buffer.alloc(length, 0x47);
      return {
        ok: true,
        status: 206,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? String(length) : null) },
      };
    }
    counters.other += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "content-length" ? "5000" : null) },
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return () => {
    global.fetch = original;
  };
}

test("prefetchFrameMainGribInput materializes the selected GRIB cold and warm-skips without new network", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "input-prefetch-test-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const counters = { idx: 0, ranges: 0, rangeBytes: 0, other: 0 };
  const restoreFetch = installFetchMock(counters);
  t.after(restoreFetch);

  const latestMetadata = {
    noaa: { date: "20260714", cycle: "12", baseUrl: "https://example.invalid/models" },
  };
  const cold = await prefetchFrameMainGribInput({
    latestMetadata,
    modelKey: "nam",
    hour: 6,
    renderMode: "all",
    rawCacheDir: root,
    rangeFetchConcurrency: 2,
  });
  assert.ok(cold, "cold prefetch returns a cache path");
  // The path must live in the SAME content-addressed namespace the frame
  // workers read (catalog version token in the filename). The first cut of
  // this module imported CATALOG_VERSION from the wrong module, silently
  // got undefined, fell back to the "current-ui" default token, and every
  // prefetch landed at a path no worker ever reads — doubling cold
  // downloads while all unit assertions still passed.
  assert.match(path.basename(cold), /noaa-grib2-catalog-v/, "prefetch path uses the worker cache namespace");
  assert.doesNotMatch(path.basename(cold), /current-ui/, "prefetch path must not fork into the default namespace");
  assert.ok(fs.existsSync(cold), "selected GRIB file exists");
  assert.ok(fs.existsSync(`${cold}.ready.json`), "ready sidecar exists");
  const sidecar = JSON.parse(fs.readFileSync(`${cold}.ready.json`, "utf8"));
  assert.equal(fs.statSync(cold).size, Number(sidecar.selectedBytes), "file size matches sidecar");
  assert.equal(counters.idx, 1, "one idx fetch");
  assert.ok(counters.ranges > 0, "byte ranges fetched");
  assert.equal(counters.other, 0, "cold prefetch issues no non-range, non-idx requests");
  assert.equal(fs.statSync(cold).size, counters.rangeBytes, "cache file holds exactly the fetched range bytes");

  // Every "no network" stage below must pin ALL request classes, not just
  // the range counter: a regression that re-fetches the .idx (or any other
  // URL) during a warm/probe/lock/stop pass would otherwise slip through.
  const networkAfterCold = { idx: counters.idx, ranges: counters.ranges, other: counters.other };
  const networkNow = () => ({ idx: counters.idx, ranges: counters.ranges, other: counters.other });
  const warm = await prefetchFrameMainGribInput({
    latestMetadata,
    modelKey: "nam",
    hour: 6,
    renderMode: "all",
    rawCacheDir: root,
    rangeFetchConcurrency: 2,
  });
  assert.equal(warm, cold, "warm prefetch resolves the same cache path");
  assert.deepEqual(networkNow(), networkAfterCold, "warm prefetch performs no network requests of any kind");

  // Prove the LIGHT probe (path + sidecar size only) is what short-circuits,
  // not materializeSelectedGrib's own hash-verified cache read: corrupt the
  // sidecar's sha256 while keeping the size intact. The verified path would
  // reject this file and re-download; the light probe must still skip (the
  // frame worker remains the authoritative verifier).
  fs.writeFileSync(`${cold}.ready.json`, JSON.stringify({ ...sidecar, sha256: "0".repeat(64) }));
  const probeOnly = await prefetchFrameMainGribInput({
    latestMetadata,
    modelKey: "nam",
    hour: 6,
    renderMode: "all",
    rawCacheDir: root,
    rangeFetchConcurrency: 2,
  });
  assert.equal(probeOnly, cold, "light probe short-circuits without hash verification");
  assert.deepEqual(networkNow(), networkAfterCold, "no network of any kind even with an unverifiable sidecar hash");
  fs.writeFileSync(`${cold}.ready.json`, JSON.stringify(sidecar));

  // A held lock means someone else is downloading these bytes right now:
  // decline instead of parking in the lock wait. (Remove the cache file so
  // the probe misses and the lock check is actually reached.)
  fs.rmSync(cold);
  fs.writeFileSync(`${cold}.lock`, JSON.stringify({ pid: process.pid }));
  try {
    const declined = await prefetchFrameMainGribInput({
      latestMetadata,
      modelKey: "nam",
      hour: 6,
      renderMode: "all",
      rawCacheDir: root,
      rangeFetchConcurrency: 2,
    });
    assert.equal(declined, null, "held lock declines the prefetch");
    assert.deepEqual(networkNow(), networkAfterCold, "no network of any kind behind a held lock");
  } finally {
    fs.rmSync(`${cold}.lock`, { force: true });
  }

  // shouldStop is consulted between stages.
  const stopped = await prefetchFrameMainGribInput({
    latestMetadata,
    modelKey: "nam",
    hour: 6,
    renderMode: "all",
    rawCacheDir: root,
    rangeFetchConcurrency: 2,
    shouldStop: () => true,
  });
  assert.equal(stopped, null, "stop request declines before any network stage");
  assert.deepEqual(networkNow(), networkAfterCold, "no network of any kind after a stop request");
});

test("prefetchFrameMainGribInput declines without a shared cache root instead of downloading to temp files", async () => {
  const counters = { idx: 0, ranges: 0, rangeBytes: 0, other: 0 };
  const restoreFetch = installFetchMock(counters);
  try {
    const result = await prefetchFrameMainGribInput({
      latestMetadata: { noaa: { date: "20260714", cycle: "12", baseUrl: "https://example.invalid/models" } },
      modelKey: "nam",
      hour: 6,
      renderMode: "all",
      rawCacheDir: null,
      rangeFetchConcurrency: 2,
    });
    assert.equal(result, null, "no cache root -> nothing to warm");
    assert.equal(counters.idx + counters.ranges + counters.other, 0, "and zero network");
  } finally {
    restoreFetch();
  }
});

test("input prefetch concurrency resolves defaults, off states, and fails closed on garbage", () => {
  assert.equal(_testResolveInputPrefetchConcurrency(undefined), 8);
  assert.equal(_testResolveInputPrefetchConcurrency(true), 8);
  assert.equal(_testResolveInputPrefetchConcurrency("auto"), 8);
  assert.equal(_testResolveInputPrefetchConcurrency(""), 8);
  assert.equal(_testResolveInputPrefetchConcurrency("off"), 0);
  assert.equal(_testResolveInputPrefetchConcurrency("0"), 0);
  assert.equal(_testResolveInputPrefetchConcurrency("5"), 5);
  assert.equal(_testResolveInputPrefetchConcurrency(5), 5);
  assert.equal(_testResolveInputPrefetchConcurrency("12"), 12);
  assert.equal(_testResolveInputPrefetchConcurrency("64"), 16);
  // House boolean vocabulary keeps its meaning (parseBooleanOption parity).
  assert.equal(_testResolveInputPrefetchConcurrency("true"), 8);
  assert.equal(_testResolveInputPrefetchConcurrency("on"), 8);
  assert.equal(_testResolveInputPrefetchConcurrency("yes"), 8);
  assert.equal(_testResolveInputPrefetchConcurrency("false"), 0);
  assert.equal(_testResolveInputPrefetchConcurrency("no"), 0);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.equal(_testResolveInputPrefetchConcurrency("fast"), 0);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unrecognized --input-prefetch/);
});

function fakeTask(modelKey, hour, renderMode, entry) {
  return {
    entry,
    frame: { hour },
    renderMode,
    renderPart: renderMode,
  };
}

function fakeEntry(modelKey) {
  return {
    modelKey,
    state: { latestMetadata: { noaa: { date: "20260714", cycle: "12" } } },
    finishedFrameHours: new Set(),
  };
}

test("startFrameInputPrefetch pulls only main tasks in order, honors skips, failures, and stop", async () => {
  const entry = fakeEntry("hrrr");
  const tasks = [
    fakeTask("hrrr", 1, "runmax-prefix", entry),
    fakeTask("hrrr", 1, "base", entry),
    fakeTask("hrrr", 1, "snow-prefix", entry),
    fakeTask("hrrr", 1, "snow", entry),
    fakeTask("hrrr", 2, "base", entry),
    fakeTask("hrrr", 3, "all", entry),
    fakeTask("hrrr", 4, "base", entry),
  ];
  const calls = [];
  const requests = [];
  const runtime = {
    // Hour 2 is already complete on disk; hour 4 is finished in this build.
    isFrameCompleteForState: async (state, frame) => Number(frame.hour) === 2,
  };
  entry.finishedFrameHours.add(4);
  const renderSelection = { categories: { severe: true } };
  const controller = startFrameInputPrefetch(runtime, tasks, {
    concurrency: 1,
    forceFrames: false,
    rawCacheDir: "/tmp/prefetch-forwarding-test",
    noaaBaseUrls: { hrrr: "https://example.invalid/hrrr" },
    rangeFetchConcurrency: 5,
    renderSelection,
    _prefetchImpl: async (request) => {
      calls.push(`${request.renderMode}:${request.hour}`);
      requests.push(request);
      if (Number(request.hour) === 3) {
        throw new Error("synthetic prefetch failure");
      }
      return "/warmed/path.grib2";
    },
  });
  assert.ok(controller, "controller returned");
  await controller.done;
  assert.deepEqual(calls, ["base:1", "all:3"], "only main tasks, in queue order, minus skips");
  assert.deepEqual(controller.stats, { prefetched: 1, skipped: 2, failed: 1 });
  // Forwarding contract: every field the real prefetch needs must arrive
  // intact — a silently dropped key here is exactly how the forked-cache
  // double-download bug class re-enters with green tests.
  const request = requests[0];
  assert.equal(request.latestMetadata, entry.state.latestMetadata, "metadata object forwarded by identity");
  assert.equal(request.modelKey, "hrrr");
  assert.equal(request.rawCacheDir, "/tmp/prefetch-forwarding-test");
  assert.equal(request.noaaBaseUrl, "https://example.invalid/hrrr", "per-model base URL resolved from the map");
  // The pump rides on top of the workers' totalRangeFetchConcurrency budget,
  // so its per-slot range width is capped at 3 regardless of the per-worker
  // value it is handed.
  assert.equal(request.rangeFetchConcurrency, 3);
  assert.equal(request.renderSelection, renderSelection, "render selection forwarded by identity");
  assert.equal(typeof request.shouldStop, "function", "cooperative stop hook forwarded");
});

test("startFrameInputPrefetch counts a declined (null) warm as skipped, not prefetched", async () => {
  const entry = fakeEntry("nam");
  const tasks = [fakeTask("nam", 1, "all", entry), fakeTask("nam", 2, "all", entry)];
  const controller = startFrameInputPrefetch({ isFrameCompleteForState: async () => false }, tasks, {
    concurrency: 1,
    forceFrames: false,
    _prefetchImpl: async (request) => (Number(request.hour) === 1 ? "/warmed.grib2" : null),
  });
  await controller.done;
  assert.deepEqual(controller.stats, { prefetched: 1, skipped: 1, failed: 0 });
});

test("startFrameInputPrefetch stop() halts further pulls and forceFrames bypasses the completeness skip", async () => {
  const entry = fakeEntry("gfs");
  const tasks = [1, 2, 3, 4, 5, 6].map((hour) => fakeTask("gfs", hour, "all", entry));
  const calls = [];
  let controller = null;
  const runtime = {
    isFrameCompleteForState: async () => {
      throw new Error("forceFrames must skip the completeness check entirely");
    },
  };
  controller = startFrameInputPrefetch(runtime, tasks, {
    concurrency: 1,
    forceFrames: true,
    _prefetchImpl: async (request) => {
      calls.push(Number(request.hour));
      if (calls.length === 2) {
        controller.stop();
      }
      return "/warmed.grib2";
    },
  });
  assert.ok(controller, "controller returned");
  await controller.done;
  assert.deepEqual(calls, [1, 2], "no pulls after stop()");
  assert.equal(controller.stats.prefetched, 2);
});

test("startFrameInputPrefetch disables cleanly on zero concurrency or empty task lists", () => {
  const entry = fakeEntry("nam");
  assert.equal(
    startFrameInputPrefetch({}, [fakeTask("nam", 1, "all", entry)], { concurrency: 0, _prefetchImpl: async () => {} }),
    null,
  );
  assert.equal(
    startFrameInputPrefetch({}, [fakeTask("nam", 1, "snow", entry)], { concurrency: 3, _prefetchImpl: async () => {} }),
    null,
    "snow-only task lists have no main GRIBs to prefetch",
  );
});

test("startFrameInputPrefetch rotates past the initial dispatch wave and circles back", async () => {
  const entry = fakeEntry("hrrr");
  const tasks = [1, 2, 3, 4, 5, 6].map((hour) => fakeTask("hrrr", hour, "all", entry));
  const calls = [];
  const controller = startFrameInputPrefetch({ isFrameCompleteForState: async () => false }, tasks, {
    concurrency: 1,
    dispatchWidth: 2,
    forceFrames: false,
    _prefetchImpl: async (request) => {
      calls.push(Number(request.hour));
      return "/warmed.grib2";
    },
  });
  await controller.done;
  assert.deepEqual(calls, [3, 4, 5, 6, 1, 2], "pump starts after the dispatch wave, head tasks last");
});

test("startFrameInputPrefetch respects its concurrency bound", async () => {
  const entry = fakeEntry("nam3km");
  const tasks = Array.from({ length: 12 }, (_, i) => fakeTask("nam3km", i + 1, "all", entry));
  let inFlight = 0;
  let maxInFlight = 0;
  const controller = startFrameInputPrefetch({ isFrameCompleteForState: async () => false }, tasks, {
    concurrency: 3,
    forceFrames: false,
    _prefetchImpl: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return "/warmed.grib2";
    },
  });
  await controller.done;
  assert.equal(controller.stats.prefetched, 12);
  assert.ok(maxInFlight <= 3, `at most 3 in flight (saw ${maxInFlight})`);
  assert.ok(maxInFlight >= 2, `parallelism actually used (saw ${maxInFlight})`);
});

test("materializeSelectedGrib onLockContention=decline resolves null under a held lock, fetches once released", async (t) => {
  // The pump's .lock pre-probe is racy by design; losing the probe-to-acquire
  // race must not park a prefetch slot in the 10-minute poll loop or reach
  // the unlocked last-resort fetch. "decline" is the warmer's contract:
  // contention means the bytes are already being fetched by someone else.
  const { materializeSelectedGrib, selectedGribCacheDescriptor } = require("../scripts/lib/noaa-beta/grib-source");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-decline-test-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const counters = { idx: 0, ranges: 0, rangeBytes: 0, other: 0 };
  const restoreFetch = installFetchMock(counters);
  t.after(restoreFetch);

  const shared = {
    modelKey: "nam",
    productKey: "grib",
    gribUrl: "https://example.invalid/models/nam.t12z.awphys06.grib2",
    rawCacheDir: root,
    date: "20260714",
    cycle: "12",
    hour: 6,
    cacheVersion: "noaa-grib2-catalog-v4",
  };
  const groups = [
    {
      offset: 0,
      rangeHeader: "bytes=0-999",
      records: [{ record: 1, param: "TMP", level: "2 m above ground", forecast: "6 hour fcst", byteLength: 1000 }],
    },
  ];
  const descriptor = selectedGribCacheDescriptor({ ...shared, groups });
  assert.ok(descriptor.cachePath, "descriptor resolves a cache path");
  fs.mkdirSync(path.dirname(descriptor.cachePath), { recursive: true });
  fs.writeFileSync(`${descriptor.cachePath}.lock`, JSON.stringify({ pid: 99999, payload: "held-by-another-build" }));

  const declined = await materializeSelectedGrib({
    ...shared,
    recordGroups: groups,
    rangeFetchConcurrency: 2,
    onLockContention: "decline",
  });
  assert.equal(declined, null, "contended decline resolves null immediately");
  assert.deepEqual(
    { idx: counters.idx, ranges: counters.ranges, other: counters.other },
    { idx: 0, ranges: 0, other: 0 },
    "no network of any kind while another process holds the lock",
  );

  fs.rmSync(`${descriptor.cachePath}.lock`);
  const materialized = await materializeSelectedGrib({
    ...shared,
    recordGroups: groups,
    rangeFetchConcurrency: 2,
    onLockContention: "decline",
  });
  assert.equal(materialized, descriptor.cachePath, "decline mode still materializes when uncontended");
  assert.ok(counters.ranges > 0, "bytes fetched once the lock is gone");
});

test("pump warms flip taskPriority from cold to warm; parts and finished hours are always warm", async () => {
  const entry = { ...fakeEntry("hrrr"), index: 0 };
  const tasks = [1, 2, 3].map((hour) => fakeTask("hrrr", hour, "all", entry));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = startFrameInputPrefetch(
    { isFrameCompleteForState: async (state, frame) => Number(frame.hour) === 3 },
    tasks,
    {
      concurrency: 1,
      forceFrames: false,
      _prefetchImpl: async (request) => {
        await gate;
        return Number(request.hour) === 2 ? null : "/warmed.grib2";
      },
    },
  );
  // Before any warm lands: parts dispatch freely, cold mains are deferred,
  // finished hours cost no network.
  assert.equal(controller.taskPriority(fakeTask("hrrr", 1, "snow-prefix", entry)), 0);
  assert.equal(controller.taskPriority(tasks[0]), 1);
  entry.finishedFrameHours.add(9);
  assert.equal(controller.taskPriority(fakeTask("hrrr", 9, "all", entry)), 0);
  release();
  await controller.done;
  assert.equal(controller.taskPriority(tasks[0]), 0, "warmed main becomes preferred");
  assert.equal(controller.taskPriority(tasks[1]), 1, "declined warm stays cold");
  assert.equal(controller.taskPriority(tasks[2]), 0, "complete-on-disk frame dispatches as warm");
});

test("runGlobalFrameTaskQueue defers cold mains while preferred work exists but never starves them", async () => {
  const { runGlobalFrameTaskQueue } = require("../scripts/lib/noaa-build/frame-queue");
  const entry = { index: 0, finishedFrameHours: new Set() };
  const mk = (hour, renderMode) => ({ entry, frame: { hour }, renderMode, renderPart: renderMode, queueIndex: hour });
  const warm = new Set([2, 4]);
  const priority = (task) => (task.renderMode === "all" && !warm.has(Number(task.frame.hour)) ? 1 : 0);
  const order = [];
  await runGlobalFrameTaskQueue(
    [mk(1, "all"), mk(2, "all"), mk(3, "all"), mk(4, "all")],
    1,
    async (task) => {
      order.push(Number(task.frame.hour));
    },
    { taskPriority: priority },
  );
  assert.deepEqual(order, [2, 4, 1, 3], "warm mains first, cold mains deferred but not starved");

  // Without a priority hook the queue is exactly the old FIFO.
  const fifoOrder = [];
  await runGlobalFrameTaskQueue(
    [mk(1, "all"), mk(2, "all"), mk(3, "all")],
    1,
    async (task) => {
      fifoOrder.push(Number(task.frame.hour));
    },
    {},
  );
  assert.deepEqual(fifoOrder, [1, 2, 3]);
});

test("warm-first wiring flows from the pump into the initial queue dispatch (end-to-end seam)", async (t) => {
  // Regression net for the buildLatestStatesWithGlobalFrameQueue call site
  // (taskPriority: inputPrefetch ? inputPrefetch.taskPriority : null): the
  // review's mutation check showed dropping that option passed every suite,
  // because the unit tests cover each half of the seam in isolation. This
  // drives the REAL runtime + queue + pump together; broken wiring yields
  // plain FIFO [0, 1, 2] instead of the warm jump.
  const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
  const { buildLatestStatesWithGlobalFrameQueue } = require("../scripts/lib/noaa-build/frame-queue");
  const { buildNoaaModelMetadata } = require("../scripts/lib/noaa-build/run-resolution");
  const { parseRenderSelectionFromArgs } = require("../scripts/lib/noaa-build/render-selection-args");
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warm-first-seam-"));
  t.after(() => fs.promises.rm(cacheRoot, { recursive: true, force: true }));
  // Surface-only selection drops the snowfall hour-chain (which would fix
  // main order entirely); NAM keeps its runmax-prefix chain, which is good:
  // the test then also proves part tasks and dependency gates keep their
  // order under warm-first. Task sort is newest-hour-first ([2, 1, 0]), so
  // warming hour 0 — naturally dispatched LAST — makes warm-first and FIFO
  // produce different orders.
  const renderSelection = parseRenderSelectionFromArgs(
    { categories: "surface" },
    { models: ["nam"], view: "conus", run: "latest" },
  );
  const metadata = buildNoaaModelMetadata({
    modelKey: "nam",
    run: { date: "20260701", cycle: "00" },
    hours: [0, 1, 2],
    noaaBaseUrl: "https://example.invalid/nam",
    renderSelection,
  });
  let releasePump;
  const pumpGate = new Promise((resolve) => {
    releasePump = resolve;
  });
  let pumpAllDone;
  const pumpDone = new Promise((resolve) => {
    pumpAllDone = resolve;
  });
  let pumpCalls = 0;
  const order = [];
  const logs = [];
  const runtime = new LocalArtifactRuntime({
    cacheRoot,
    sourceName: "noaa-beta-test",
    renderWidth: 8,
    renderHeight: 8,
    fetchLatestMetadata: async () => metadata,
    renderFrameArtifacts: async (params) => {
      order.push(`${params.renderMode}:${Number(params.framePlan.hour)}`);
      if (order.length === 1) {
        // Hold the first (cold FIFO) render until the pump has processed
        // every task, so the second pick sees the warm/cold split.
        releasePump();
        await pumpDone;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {};
    },
  });
  await runtime.init();
  const originalLog = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    await buildLatestStatesWithGlobalFrameQueue(runtime, ["nam"], "conus", {
      frameConcurrency: 1,
      frameRetries: 0,
      profileFrames: true,
      renderSelection,
      // Keep every frame a single renderMode "all" task (no snowfall part
      // splitting) so the dispatch order below is purely the main-frame
      // warm/cold decision.
      persistQueueEnabled: true,
      inputPrefetch: {
        concurrency: 1,
        _prefetchImpl: async (request) => {
          await pumpGate;
          pumpCalls += 1;
          const warmed = Number(request.hour) === 0 ? "/warmed.grib2" : null;
          if (pumpCalls === 3) {
            // Resolve a beat later so the pump's own continuation records
            // the warm key before the held render resumes.
            setTimeout(pumpAllDone, 20);
          }
          return warmed;
        },
      },
    });
  } finally {
    console.log = originalLog;
  }
  // Natural (FIFO) order is [prefix:1, prefix:2, all:2, all:1, all:0] —
  // prefixes first via the runmax chain, then mains newest-first. The pump
  // warms only hour 0, so warm-first must jump all:0 ahead of the cold
  // all:2/all:1 the moment the prefixes finish; broken wiring (the
  // taskPriority option dropped at the call site) reproduces plain FIFO.
  assert.deepEqual(
    order,
    ["runmax-prefix:1", "runmax-prefix:2", "all:0", "all:2", "all:1"],
    "warm all:0 dispatches ahead of cold mains; chains keep their order",
  );
  assert.ok(
    logs.some((line) => /dispatch=warm:1\/cold:2/.test(line)),
    `queue log reports the warm/cold pick mix (frame-queue lines: ${logs.filter((l) => l.includes("frame queue")).join(" | ")})`,
  );
});
