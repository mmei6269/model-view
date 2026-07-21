"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

function loadModule(entryName = "frame-prefetch.ts", objectUrlLimitMb) {
  const entry = path.join(__dirname, "..", "next", "src", "core", entryName);
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    define: {
      "import.meta.env.VITE_ARTIFACT_BASE_URL": "undefined",
      "import.meta.env.VITE_IMAGE_OBJECT_URL_CACHE_LIMIT_MB":
        objectUrlLimitMb === undefined ? "undefined" : JSON.stringify(objectUrlLimitMb),
      "import.meta.env.VITE_DECODED_IMAGE_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_HOVER_GRID_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_PARSED_PAYLOAD_CACHE_MAX_ENTRIES": "2",
      "import.meta.env.VITE_DISABLE_LATEST_RUN_MEMORY_WARMUP": "undefined",
      "import.meta.env.DEV": "false",
    },
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function frame(hour) {
  return {
    hour,
    validHourKey: `frame-${hour}`,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    layers: {},
    synopticVectorKeys: { simple: `vectors/synoptic-f${String(hour).padStart(3, "0")}.json` },
    synopticVectorBytes: { simple: 100 },
  };
}

function contourFrame(hour) {
  return {
    hour,
    validHourKey: `frame-${hour}`,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    layers: {},
    contourVectorRefs: {
      height500: { key: `vectors/height500-f${String(hour).padStart(3, "0")}.json`, bytes: 100 },
    },
  };
}

function weatherFrame(hour) {
  return {
    hour,
    validHourKey: `frame-${hour}`,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    layers: {},
    weatherVectorRefs: {
      precip: { key: `vectors/weather-f${String(hour).padStart(3, "0")}.json`, bytes: 100 },
    },
  };
}

function rasterFrame(hour) {
  return {
    hour,
    validHourKey: `frame-${hour}`,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    layers: {
      temperature: { key: `raster/temperature-f${String(hour).padStart(3, "0")}.png`, bytes: 64 },
    },
  };
}

function dataRasterFrame(hour) {
  return {
    ...rasterFrame(hour),
    layers: {
      temperature: { key: "", bytes: 64, url: "data:image/png;base64,AAAA" },
    },
  };
}

async function exerciseEviction(frames, activeLayer) {
  const client = loadModule();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ schemaVersion: 1, features: [] }),
  });
  const engine = new client.FramePrefetchEngine();
  engine.configure({
    cacheKey: `eviction-${activeLayer}`,
    frames,
    activeLayers: new Set([activeLayer]),
    currentHour: 0,
    synopticDetailMode: "simple",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return client.getCachedFramePrefetchState(frames[0], new Set([activeLayer]));
}

test("parsed-vector LRU eviction invalidates prefetch readiness", async () => {
  const frames = [frame(0), frame(1), frame(2)];
  assert.equal(
    await exerciseEviction(frames, "synoptic"),
    "loading",
    "an evicted vector must be eligible for rewarming instead of remaining falsely loaded",
  );
});

test("contour-vector LRU eviction invalidates prefetch readiness", async () => {
  assert.equal(await exerciseEviction([contourFrame(0), contourFrame(1), contourFrame(2)], "height500"), "loading");
});

test("weather-vector LRU eviction invalidates prefetch readiness", async () => {
  assert.equal(await exerciseEviction([weatherFrame(0), weatherFrame(1), weatherFrame(2)], "precip"), "loading");
});

test("a raster completion cannot restore readiness after its object URL was evicted", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalImage = globalThis.Image;
  const originalCreateObjectUrl = globalThis.URL.createObjectURL;
  const originalRevokeObjectUrl = globalThis.URL.revokeObjectURL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalImage === undefined) {
      delete globalThis.Image;
    } else {
      globalThis.Image = originalImage;
    }
    globalThis.URL.createObjectURL = originalCreateObjectUrl;
    globalThis.URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  const revoked = new Set();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    blob: async () => ({ size: 64 }),
  });
  globalThis.URL.createObjectURL = () => "blob:test/raster-eviction";
  globalThis.URL.revokeObjectURL = (url) => revoked.add(url);
  globalThis.Image = class FakeImage {
    set src(value) {
      queueMicrotask(() => {
        if (revoked.has(value)) {
          this.onerror?.(new Error(`revoked object URL: ${value}`));
          return;
        }
        this.onload?.();
      });
    }
  };

  // One byte is below the fetched blob's size, so insertion immediately
  // evicts the object URL while the decode-prefetch completion is unwinding.
  const client = loadModule("frame-prefetch.ts", 1 / (1024 * 1024));
  const frame = rasterFrame(0);
  const activeLayers = new Set(["temperature"]);
  const engine = new client.FramePrefetchEngine();
  engine.configure({
    cacheKey: "raster-eviction",
    frames: [frame],
    activeLayers,
    currentHour: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    client.getCachedFramePrefetchState(frame, activeLayers),
    "loading",
    "an evicted raster must not be marked loaded by its late completion",
  );
});

test("a successful data-URL raster remains ready without an object-URL cache entry", async (t) => {
  const originalImage = globalThis.Image;
  t.after(() => {
    if (originalImage === undefined) {
      delete globalThis.Image;
    } else {
      globalThis.Image = originalImage;
    }
  });
  globalThis.Image = class FakeImage {
    set src(_value) {
      queueMicrotask(() => this.onload?.());
    }
  };

  const client = loadModule();
  const frame = dataRasterFrame(0);
  const activeLayers = new Set(["temperature"]);
  const engine = new client.FramePrefetchEngine();
  engine.configure({
    cacheKey: "data-raster",
    frames: [frame],
    activeLayers,
    currentHour: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.getCachedFramePrefetchState(frame, activeLayers), "loaded");
});

test("latest-run completion bookkeeping rewarms a parsed vector after LRU eviction", async () => {
  const cache = loadModule("latest-run-memory-cache.ts");
  const requests = new Map();
  globalThis.fetch = async (url) => {
    const key = String(url);
    requests.set(key, (requests.get(key) || 0) + 1);
    return { ok: true, status: 200, json: async () => ({ schemaVersion: 1, features: [] }) };
  };
  const frames = [frame(0), frame(1), frame(2)];
  const plan = {
    modelKey: "gfs",
    viewKey: "conus",
    manifest: { model: "gfs", view: "conus", run: "20260711-0000Z", generatedAt: "now", frames },
    anchorHour: 0,
    activeLayers: ["synoptic"],
    reflectivityGate: 15,
    synopticDetailMode: "simple",
  };
  cache.startLatestRunMemoryWarmup(plan);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const firstUrl = [...requests.keys()].find((url) => url.includes("synoptic-f000"));
  assert.ok(firstUrl);
  assert.equal(requests.get(firstUrl), 1);

  cache.startLatestRunMemoryWarmup({ ...plan, anchorHour: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.get(firstUrl), 2, "evicted completion must not suppress the next warmup");
});
