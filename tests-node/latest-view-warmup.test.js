"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

function loadModule() {
  const entry = path.join(__dirname, "..", "next", "src", "core", "latest-run-memory-cache.ts");
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    define: {
      "import.meta.env.VITE_ARTIFACT_BASE_URL": "undefined",
      "import.meta.env.VITE_IMAGE_OBJECT_URL_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_DECODED_IMAGE_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_HOVER_GRID_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_PARSED_PAYLOAD_CACHE_MAX_ENTRIES": "undefined",
      "import.meta.env.VITE_DISABLE_LATEST_RUN_MEMORY_WARMUP": "undefined",
      "import.meta.env.DEV": "false",
    },
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function plan(overrides = {}) {
  return {
    viewKey: "conus",
    anchorValidTimeIso: "2026-07-11T00:00:00Z",
    forceRefresh: false,
    activeLayers: [],
    reflectivityGate: 15,
    synopticDetailMode: "simple",
    ...overrides,
  };
}

function response(status, payload = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test("rapid anchor churn shares one discovery burst and failed models retry after bounded backoff", async () => {
  const cache = loadModule();
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  const requests = [];
  Date.now = () => now;
  global.fetch = async (url) => {
    requests.push(String(url));
    return response(404);
  };
  try {
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        cache.warmLatestViewMemoryCache(
          plan({ anchorValidTimeIso: `2026-07-11T${String(index % 24).padStart(2, "0")}:00:00Z` }),
        ),
      ),
    );
    const latestRequests = () => requests.filter((url) => /\/manifests\/(gfs|nam|nam3km|hrrr)\/latest\.json/.test(url));
    assert.equal(latestRequests().length, 4, "one in-flight probe per model serves the whole anchor burst");

    await cache.warmLatestViewMemoryCache(plan());
    assert.equal(latestRequests().length, 4, "a recent deterministic absence is negatively cached");

    now += 60_001;
    await cache.warmLatestViewMemoryCache(plan());
    assert.equal(latestRequests().length, 8, "every failed model is eligible again after the 60-second backoff");
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("force refresh bypasses negative backoff and observes later successful run changes", async () => {
  const cache = loadModule();
  const originalFetch = global.fetch;
  let gfsRun = null;
  const requests = [];
  global.fetch = async (url) => {
    const requestUrl = String(url);
    requests.push(requestUrl);
    if (/\/manifests\/gfs\/latest\.json/.test(requestUrl) && gfsRun) {
      return response(200, { manifestKey: `manifests/gfs/${gfsRun}.json` });
    }
    const runMatch = requestUrl.match(/\/manifests\/gfs\/(run-[ab])\.json/);
    if (runMatch) {
      return response(200, {
        schemaVersion: 4,
        model: "gfs",
        run: runMatch[1],
        view: "conus",
        generatedAt: "2026-07-11T00:00:00Z",
        referenceTime: "2026-07-11T00:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: {},
        frames: [],
      });
    }
    return response(404);
  };
  try {
    await cache.warmLatestViewMemoryCache(plan());

    gfsRun = "run-a";
    await cache.warmLatestViewMemoryCache(plan({ forceRefresh: true }));
    assert.equal(
      requests.some((url) => /\/manifests\/gfs\/run-a\.json/.test(url)),
      true,
    );

    gfsRun = "run-b";
    await cache.warmLatestViewMemoryCache(plan({ forceRefresh: true }));
    assert.equal(
      requests.some((url) => /\/manifests\/gfs\/run-b\.json/.test(url)),
      true,
      "a later successful latest pointer is not hidden by the prior failure cache",
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("same-anchor background warmup retries a transient task after bounded backoff", async () => {
  const cache = loadModule();
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  let requests = 0;
  Date.now = () => now;
  global.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      throw new TypeError("transient vector failure");
    }
    return response(200, { schemaVersion: 1, features: [] });
  };
  const warmupPlan = {
    modelKey: "hrrr",
    viewKey: "conus",
    manifest: {
      model: "hrrr",
      view: "conus",
      run: "20260711-0000Z",
      generatedAt: "2026-07-11T00:00:00Z",
      frames: [
        {
          hour: 0,
          validHourKey: "2026-07-11T00:00:00Z",
          bounds: { north: 53, south: 21, west: -129, east: -63 },
          layers: {},
          synopticVectorKeys: { simple: "vectors/synoptic-f000.json" },
          synopticVectorBytes: { simple: 100 },
        },
      ],
    },
    anchorHour: 0,
    activeLayers: ["synoptic"],
    reflectivityGate: 15,
    synopticDetailMode: "simple",
  };

  try {
    cache.startLatestRunMemoryWarmup(warmupPlan);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);

    cache.startLatestRunMemoryWarmup(warmupPlan);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1, "same-anchor calls respect the transient-failure backoff");

    now += 15_001;
    cache.startLatestRunMemoryWarmup(warmupPlan);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 2, "the same anchor becomes retryable after the bounded backoff");
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
  }
});
