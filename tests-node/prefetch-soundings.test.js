"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
const { planPrefetchTasks, warmFrameSounding } = require("../scripts/lib/noaa-build/prefetch-soundings");
const { clearNoaaIndexCachesForTest } = require("../scripts/lib/noaa-beta/grib-source");

const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURE_RUN = "20260702-1200Z";

async function makeRuntime(t) {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prefetch-soundings-"));
  t.after(() => fs.promises.rm(cacheRoot, { recursive: true, force: true }));
  const runtime = new LocalArtifactRuntime({
    cacheRoot,
    artifactPrefix: "tiles",
    sourceName: "noaa-beta",
  });
  await runtime.init();
  return runtime;
}

async function writeManifest(runtime, runId, frames, hourStatus) {
  const manifest = {
    schemaVersion: 1,
    model: "nam3km",
    run: runId,
    view: "conus",
    generatedAt: "2026-07-02T12:00:00.000Z",
    parameters: {},
    frames,
    hourStatus,
  };
  const manifestPath = runtime.getManifestStoragePath("nam3km", runId, "conus");
  await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest));
  return manifest;
}

async function writeLatestPointer(runtime, runId) {
  const pointer = {
    model: "nam3km",
    run: runId,
    view: "conus",
    generatedAt: "2026-07-02T12:00:00.000Z",
    manifestKey: `manifests/nam3km/${runId}--conus.json`,
    frameCount: 1,
  };
  const pointerPath = runtime.getLatestPointerStoragePath("nam3km", "conus");
  await fs.promises.mkdir(path.dirname(pointerPath), { recursive: true });
  await fs.promises.writeFile(pointerPath, JSON.stringify(pointer));
}

async function writeWgrib2Stub(t) {
  const stubDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prefetch-wgrib2-"));
  t.after(() => fs.promises.rm(stubDir, { recursive: true, force: true }));
  const stubPath = path.join(stubDir, "wgrib2-test-stub");
  await fs.promises.writeFile(
    stubPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("-grid")) {
  process.stdout.write("lat-lon grid winds(N/S)\\n");
} else if (args.includes("-lon")) {
  process.stdout.write("1:0:d=2026070212:HGT:surface:anl:lon=-96 lat=37 val=100\\n");
} else {
  process.stderr.write(\`unexpected wgrib2 arguments: \${args.join(" ")}\\n\`);
  process.exitCode = 2;
}
`,
  );
  await fs.promises.chmod(stubPath, 0o755);
  return stubPath;
}

test("planPrefetchTasks enumerates every warmable hour (all but data-gated) with in-bounds centers", async (t) => {
  const runtime = await makeRuntime(t);
  const manifest = await writeManifest(
    runtime,
    FIXTURE_RUN,
    [
      { hour: 0, bounds: { north: 50, south: 20, west: -125, east: -65 } },
      { hour: 1, bounds: { north: 49, south: 21, west: -124, east: -66 } },
      { hour: 2, bounds: { north: 48, south: 22, west: -123, east: -67 } },
      { hour: 3, bounds: { north: 47, south: 23, west: -122, east: -68 } },
    ],
    { 0: "loaded", 1: "pending", 2: "error", 3: "unavailable" },
  );
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
  const nam3kmTasks = tasks.filter((task) => task.modelKey === "nam3km" && task.runId === FIXTURE_RUN);
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
  const runtime = await makeRuntime(t);
  const olderRun = "20260702-0600Z";
  const frame = { hour: 0, bounds: { north: 50, south: 20, west: -125, east: -65 } };
  await writeManifest(runtime, olderRun, [frame], { 0: "loaded" });
  await writeManifest(runtime, FIXTURE_RUN, [frame], { 0: "loaded" });
  await writeLatestPointer(runtime, olderRun);
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
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "prefetch-raw-cache-"));
  t.after(() => fs.promises.rm(cacheRoot, { recursive: true, force: true }));
  const rawCacheDir = path.join(cacheRoot, "raw-noaa");
  const wgrib2Path = await writeWgrib2Stub(t);
  const task = { modelKey: "nam3km", runId: FIXTURE_RUN, hour: 0, lat: 37, lon: -96 };
  const idxText = "1:0:d=2026070212:HGT:surface:anl:\n";
  const gribBytes = Buffer.from("GRIB");
  const originalFetch = global.fetch;
  try {
    let firstFetchCalls = 0;
    let firstLimiterCalls = 0;
    global.fetch = async (url, options = {}) => {
      firstFetchCalls += 1;
      if (String(url).endsWith(".idx")) {
        return { ok: true, status: 200, text: async () => idxText };
      }
      if (options.method === "HEAD") {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name) => (String(name).toLowerCase() === "content-length" ? String(gribBytes.length) : null),
          },
        };
      }
      assert.equal(options.headers?.Range, "bytes=0-3", "the selected record is fetched by byte range");
      return {
        status: 206,
        headers: { get: (name) => (String(name).toLowerCase() === "content-range" ? "bytes 0-3/4" : null) },
        arrayBuffer: async () =>
          gribBytes.buffer.slice(gribBytes.byteOffset, gribBytes.byteOffset + gribBytes.byteLength),
      };
    };
    const first = await warmFrameSounding(task, {
      rawCacheDir,
      wgrib2Path,
      rangeFetchLimiter: {
        async run(operation) {
          firstLimiterCalls += 1;
          return operation();
        },
      },
    });
    assert.equal(first.status, "warmed", first.error);
    assert.equal(first.bytes, gribBytes.length);
    assert.equal(firstFetchCalls, 3, "idx, content-length, and one selected byte range were fetched");
    assert.equal(firstLimiterCalls, 1, "the AsyncSemaphore-style limiter wraps the range fetch");

    // Exercise the on-disk idx/content-length caches rather than relying on their
    // process-local promise memoization for the second warm.
    clearNoaaIndexCachesForTest();
    let fetchCalls = 0;
    global.fetch = async (...fetchArgs) => {
      fetchCalls += 1;
      throw new Error(`unexpected network fetch during cached warm: ${fetchArgs[0]}`);
    };
    const second = await warmFrameSounding(task, {
      rawCacheDir,
      wgrib2Path,
      rangeFetchLimiter: {
        run() {
          throw new Error("unexpected range fetch during cached warm");
        },
      },
    });
    assert.equal(second.status, "alreadyCached", "cached frame reports alreadyCached");
    assert.equal(fetchCalls, 0, "no network fetch on a cached frame");
  } finally {
    global.fetch = originalFetch;
    clearNoaaIndexCachesForTest();
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

test("parseHoursArg throws on invalid tokens instead of warming every loaded hour", () => {
  const { parseHoursArg } = require("../scripts/prefetch-point-soundings");
  // null (= warm all hours) stays the meaning of an omitted flag only.
  assert.equal(parseHoursArg(undefined), null);
  assert.equal(parseHoursArg(null), null);
  assert.equal(parseHoursArg(""), null);
  assert.deepEqual(parseHoursArg("6,0,3"), [6, 0, 3]);
  // Empty tokens (trailing/doubled commas) are ignored, not turned into F000.
  assert.deepEqual(parseHoursArg("3,,6,"), [3, 6]);
  // A provided-but-invalid flag must not collapse into the all-hours plan.
  assert.throws(() => parseHoursArg("abc"), /Invalid forecast hour 'abc' in --hours/);
  assert.throws(() => parseHoursArg("3,-1"), /Invalid forecast hour '-1' in --hours/);
  assert.throws(() => parseHoursArg("1.5"), /Invalid forecast hour '1\.5' in --hours/);
  assert.throws(() => parseHoursArg(",,"), /--hours was provided but names no forecast hours/);
  assert.throws(() => parseHoursArg(true), /--hours requires a value/);
});
