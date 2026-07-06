"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
const { AsyncSemaphore } = require("../scripts/lib/local-artifact-concurrency");
const { planPrefetchTasks, warmFrameSounding } = require("../scripts/lib/noaa-build/prefetch-soundings");

const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURE_CACHE_ROOT = path.join(REPO_ROOT, "output/noaa-beta-cache");
const FIXTURE_MANIFEST = path.join(FIXTURE_CACHE_ROOT, "artifacts/manifests/nam3km/20260702-1200Z--conus.json");
const WGRIB2_PATH = path.join(REPO_ROOT, "output/noaa-beta-tools/bin/wgrib2");

function makeRuntime() {
  return new LocalArtifactRuntime({
    cacheRoot: FIXTURE_CACHE_ROOT,
    artifactPrefix: "tiles",
    sourceName: "noaa-beta",
  });
}

test("planPrefetchTasks enumerates every warmable hour (all but data-gated) with in-bounds centers", async (t) => {
  if (!fs.existsSync(FIXTURE_MANIFEST)) {
    t.skip("nam3km selected-grib-v2 fixture manifest not present");
    return;
  }
  const runtime = makeRuntime();
  await runtime.init();
  const manifest = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, "utf8"));
  // Raw-GRIB warming works for any manifest frame, rendered or not — only
  // data-gated (unavailable) hours are unwarmable. Gating on "loaded" made
  // the prefetch silently skip frames mid-re-render.
  const warmableHours = manifest.frames
    .map((frame) => Number(frame.hour))
    .filter((hour) => Number.isFinite(hour) && (manifest.hourStatus || {})[String(hour)] !== "unavailable")
    .sort((a, b) => a - b);

  const tasks = await planPrefetchTasks({
    runtime,
    models: ["nam3km"],
    view: "conus",
    runsMode: "all",
  });
  const nam3kmTasks = tasks.filter((task) => task.modelKey === "nam3km" && task.runId === "20260702-1200Z");
  assert.deepEqual(
    nam3kmTasks.map((task) => task.hour).sort((a, b) => a - b),
    warmableHours,
    "one task per warmable hour",
  );
  // Each center sits inside its frame bounds.
  const frameByHour = new Map(manifest.frames.map((frame) => [Number(frame.hour), frame]));
  for (const task of nam3kmTasks) {
    const bounds = frameByHour.get(task.hour).bounds;
    assert.ok(task.lat <= bounds.north && task.lat >= bounds.south, "lat in bounds");
    assert.ok(task.lon >= bounds.west && task.lon <= bounds.east, "lon in bounds");
  }
});

test("planPrefetchTasks --runs=latest uses readLatestPointerFromDisk", async (t) => {
  if (!fs.existsSync(FIXTURE_MANIFEST)) {
    t.skip("nam3km selected-grib-v2 fixture manifest not present");
    return;
  }
  const runtime = makeRuntime();
  await runtime.init();
  const latest = await runtime.readLatestPointerFromDisk("nam3km", "conus");
  const tasks = await planPrefetchTasks({
    runtime,
    models: ["nam3km"],
    view: "conus",
    runsMode: "latest",
  });
  assert.ok(tasks.length > 0, "latest run has loaded frames to prefetch");
  for (const task of tasks) {
    assert.equal(task.runId, latest.run, "only the latest run is planned");
  }
});

test("warmFrameSounding on an already-cached frame issues ZERO network calls", async (t) => {
  if (!fs.existsSync(FIXTURE_MANIFEST)) {
    t.skip("nam3km selected-grib-v2 fixture manifest not present");
    return;
  }
  if (!fs.existsSync(WGRIB2_PATH)) {
    t.skip("wgrib2 binary not present; warmFrameSounding requires it to extract the point");
    return;
  }
  const runtime = makeRuntime();
  await runtime.init();
  const [task] = await planPrefetchTasks({
    runtime,
    models: ["nam3km"],
    view: "conus",
    runsMode: "latest",
  });
  assert.ok(task, "at least one loaded nam3km frame to warm");

  // First warm populates the raw caches (idx, content-length, selected-grib).
  // Requires the on-disk selected-grib-v2/idx fixtures for this frame — network-free
  // only if those are present; otherwise this call would fetch, so guard on it.
  const rawCacheDir = path.join(FIXTURE_CACHE_ROOT, "raw-noaa");
  const first = await warmFrameSounding(task, {
    rawCacheDir,
    wgrib2Path: WGRIB2_PATH,
    rangeFetchLimiter: new AsyncSemaphore(1),
  });
  if (first.status === "failed") {
    t.skip(`frame not fully cached in fixture (${first.error}); cannot assert idempotent no-network path`);
    return;
  }

  // Second warm must be network-free: any global.fetch or limiter use throws.
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async (...fetchArgs) => {
    fetchCalls += 1;
    throw new Error(`unexpected network fetch during cached warm: ${fetchArgs[0]}`);
  };
  const throwingLimiter = {
    run() {
      throw new Error("unexpected range fetch during cached warm");
    },
  };
  try {
    const second = await warmFrameSounding(task, {
      rawCacheDir,
      wgrib2Path: WGRIB2_PATH,
      rangeFetchLimiter: throwingLimiter,
    });
    assert.equal(second.status, "alreadyCached", "cached frame reports alreadyCached");
    assert.equal(fetchCalls, 0, "no network fetch on a cached frame");
  } finally {
    global.fetch = originalFetch;
  }
});

test("prefetch CLI exits non-zero with a clear warning when the runs selection matches nothing", async () => {
  // A typo'd --runs (or an upstream run that was never built) matches no on-disk
  // manifest: tasks=0 must be a loud failure, never a silent exit-0 no-op.
  const emptyCacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prefetch-empty-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "scripts/prefetch-point-soundings.js"),
        "--models=nam3km",
        "--view=conus",
        "--runs=20000101-0000Z",
        `--cache-root=${emptyCacheRoot}`,
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.notEqual(result.status, 0, "tasks=0 exits non-zero");
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /no loaded frames matched; nothing to prefetch/, "clear warning printed");
    assert.match(output, /tasks=0/, "summary reports zero tasks");
  } finally {
    await fs.promises.rm(emptyCacheRoot, { recursive: true, force: true });
  }
});

test("warmFrameSounding never persists parcel diagnostics (raw-only cache)", async (t) => {
  // The prefetch core must not write any parcel-diagnostic artifact: it only calls
  // buildNoaaPointSounding, which warms the raw selected-grib cache. Assert via an
  // injected buildSounding spy that no diagnostics-bearing cache write is requested.
  let capturedOptions = null;
  const fakeTask = { modelKey: "nam3km", runId: "20260702-1200Z", hour: 0, lat: 37, lon: -96 };
  const result = await warmFrameSounding(fakeTask, {
    rawCacheDir: "/tmp/does-not-matter",
    wgrib2Path: "/bin/false",
    buildSounding: async (options) => {
      capturedOptions = options;
      // Mimic buildNoaaPointSounding: returns a payload, warms raw cache only.
      return { renderProfile: { selectedGribCacheHit: false, selectedBytes: 1234 } };
    },
  });
  assert.equal(result.status, "warmed");
  assert.equal(result.bytes, 1234);
  // No parcel/diagnostic flag is passed down; buildNoaaPointSounding computes on demand.
  assert.equal("persistParcelDiagnostics" in capturedOptions, false);
  assert.equal("precomputeDiagnostics" in capturedOptions, false);
  assert.equal(capturedOptions.modelKey, "nam3km");
  assert.equal(capturedOptions.runId, "20260702-1200Z");
  assert.equal(capturedOptions.hour, 0);
});

test("parseRunsMode preserves run-id case (lowercased ids fail point-sounding run validation)", () => {
  const { parseRunsMode } = require("../scripts/prefetch-point-soundings");
  assert.deepEqual(parseRunsMode("20260703-2100Z"), { runsMode: "list", runIds: ["20260703-2100Z"] });
  assert.deepEqual(parseRunsMode("LATEST"), { runsMode: "latest", runIds: null });
  assert.deepEqual(parseRunsMode("20260703-2100Z,20260703-1800Z").runIds, ["20260703-2100Z", "20260703-1800Z"]);
});
