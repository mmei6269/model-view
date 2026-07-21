"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

function loadModule() {
  const entry = path.join(__dirname, "..", "next", "src", "core", "frame-prefetch.ts");
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
      "import.meta.env.DEV": "false",
    },
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function frame(hour) {
  const padded = String(hour).padStart(3, "0");
  return {
    hour,
    validHourKey: `2026-07-11T${padded}:00:00Z`,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    layers: {
      height500: { key: `raster/height500-f${padded}.png`, bytes: 100 },
      synoptic: { key: `raster/synoptic-f${padded}.png`, bytes: 100 },
    },
    contourVectorRefs: {
      height500: { key: `vector/height500-f${padded}.json`, bytes: 100 },
    },
    synopticVectorKeys: { simple: `vector/synoptic-f${padded}.json` },
    synopticVectorBytes: { simple: 100 },
    hoverGridKey: `hover/f${padded}.bin.gz`,
    hoverGridBytes: 75_000_000,
    hoverGridSchemaVersion: 3,
  };
}

test("frame prefetch excludes hover grids and prioritizes selected-frame vectors", () => {
  const { buildTieredTasks } = loadModule();
  const frames = [frame(0), frame(6), frame(12)];
  const tasks = buildTieredTasks(frames, new Set(["height500", "synoptic"]), 6, 15, "simple", 1);

  assert.equal(
    tasks.some((task) => task.kind === "hover"),
    false,
  );
  assert.deepEqual(
    tasks
      .slice(0, 2)
      .map((task) => [task.frame.hour, task.kind])
      .sort(),
    [
      [6, "contour-vector"],
      [6, "vector"],
    ],
  );
  assert.equal(tasks.filter((task) => task.kind === "contour-vector").length, 3);
  assert.equal(tasks.filter((task) => task.kind === "vector").length, 3);
});

test("rebuilding the plan re-anchors selected and adjacent work", () => {
  const { buildTieredTasks } = loadModule();
  const frames = [frame(0), frame(6), frame(12)];
  const active = new Set(["height500", "synoptic"]);
  const firstPlan = buildTieredTasks(frames, active, 0, 15, "simple", 1);
  const movedPlan = buildTieredTasks(frames, active, 12, 15, "simple", 2);

  assert.equal(firstPlan[0].frame.hour, 0);
  assert.equal(movedPlan[0].frame.hour, 12);
  assert.equal(movedPlan[0].revision, 2);
});

test("prefetch skips explicit unavailable raster/vector placeholders but preserves legacy refs", () => {
  const { buildTieredTasks } = loadModule();
  const unavailable = {
    ...frame(6),
    parameterAvailability: { height500: "unavailable", synoptic: "unavailable" },
  };
  assert.deepEqual(buildTieredTasks([unavailable], new Set(["height500", "synoptic"]), 6), []);

  const legacyTasks = buildTieredTasks([frame(6)], new Set(["height500", "synoptic"]), 6);
  assert.equal(
    legacyTasks.some((task) => task.kind === "contour-vector"),
    true,
  );
  assert.equal(
    legacyTasks.some((task) => task.kind === "vector"),
    true,
  );
});

test("same-plan re-anchoring preserves in-flight requests and grants the selected hour one urgent slot", async () => {
  const { FramePrefetchEngine } = loadModule();
  const originalFetch = global.fetch;
  const requests = [];
  let abortCount = 0;
  global.fetch = (url, options = {}) =>
    new Promise((_resolve, reject) => {
      requests.push(String(url));
      options.signal?.addEventListener(
        "abort",
        () => {
          abortCount += 1;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });

  const engine = new FramePrefetchEngine();
  const frames = Array.from({ length: 16 }, (_, index) => frame(index * 6));
  const plan = {
    cacheKey: "gfs|run|height500",
    frames,
    activeLayers: new Set(["height500"]),
    currentHour: 0,
  };
  try {
    engine.configure(plan);
    await new Promise((resolve) => setImmediate(resolve));
    const initialRequestCount = requests.length;
    assert.ok(initialRequestCount > 0);

    engine.configure({ ...plan, currentHour: 90 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(abortCount, 0, "priority-only re-anchor must not abort active fetches");
    assert.equal(
      requests.length,
      initialRequestCount + 1,
      "one bounded urgent request may bypass saturated background work",
    );
    assert.equal(
      requests.slice(initialRequestCount).some((url) => url.includes("f090")),
      true,
      "the bounded extra slot belongs to the newly selected hour",
    );

    engine.configure({ ...plan, cacheKey: "gfs|new-run|height500", currentHour: 90 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(abortCount, initialRequestCount + 1, "a genuinely different plan aborts every obsolete request");
  } finally {
    engine.stop();
    global.fetch = originalFetch;
  }
});

test("moving onto a transiently failed hour retries only that task without abort churn", async () => {
  const { FramePrefetchEngine } = loadModule();
  const originalFetch = global.fetch;
  const requestCountByUrl = new Map();
  let abortCount = 0;
  global.fetch = (url, options = {}) => {
    const requestUrl = String(url);
    const count = (requestCountByUrl.get(requestUrl) || 0) + 1;
    requestCountByUrl.set(requestUrl, count);
    if (requestUrl.includes("synoptic-f000.json")) {
      if (count === 1) {
        return Promise.reject(new TypeError("transient network failure"));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ schemaVersion: 1, features: [] }),
      });
    }
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          abortCount += 1;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  };

  const vectorFrames = Array.from({ length: 13 }, (_, hour) => ({ ...frame(hour), layers: {} }));
  const statuses = new Map();
  const engine = new FramePrefetchEngine();
  const plan = {
    cacheKey: "hrrr|run|synoptic|transient-retry",
    frames: vectorFrames,
    activeLayers: new Set(["synoptic"]),
    currentHour: 6,
    synopticDetailMode: "simple",
    onStatus: (hour, status) => statuses.set(hour, status),
  };

  try {
    engine.configure(plan);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statuses.get(0), "error");

    engine.configure({ ...plan, currentHour: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const failedUrl = Array.from(requestCountByUrl.keys()).find((url) => url.includes("synoptic-f000.json"));
    assert.ok(failedUrl);
    assert.equal(requestCountByUrl.get(failedUrl), 2, "selected failed task receives one bounded retry");
    assert.equal(statuses.get(0), "loaded");
    assert.equal(abortCount, 0, "retrying the selected failure preserves unrelated requests");
  } finally {
    engine.stop();
    global.fetch = originalFetch;
  }
});

test("same-plan same-anchor configure does not recursively pump cached status callbacks", () => {
  const { FramePrefetchEngine, buildTieredTasks, markFramePrefetchCacheKeyLoaded } = loadModule();
  const frames = Array.from({ length: 64 }, (_, index) => frame(index * 6));
  const activeLayers = new Set(["height500"]);
  for (const task of buildTieredTasks(frames, activeLayers, 0)) {
    markFramePrefetchCacheKeyLoaded(task.cacheKey);
  }

  const engine = new FramePrefetchEngine();
  let callbackDepth = 0;
  let maxCallbackDepth = 0;
  let callbackCount = 0;
  const plan = {
    cacheKey: "gfs|run|height500|cached",
    frames,
    activeLayers,
    currentHour: 0,
    onStatus: () => {
      callbackDepth += 1;
      maxCallbackDepth = Math.max(maxCallbackDepth, callbackDepth);
      callbackCount += 1;
      engine.configure(plan);
      callbackDepth -= 1;
    },
  };

  try {
    engine.configure(plan);
    assert.equal(callbackCount, frames.length);
    assert.equal(maxCallbackDepth, 1, "an identical configure must not re-enter the cached-task pump");
  } finally {
    engine.stop();
  }
});

test("global cache subscribers receive one notification per completion burst", async () => {
  const { markFramePrefetchCacheKeyLoaded, subscribeFramePrefetchCacheChanges } = loadModule();
  let notifications = 0;
  const unsubscribe = subscribeFramePrefetchCacheChanges(() => {
    notifications += 1;
  });
  try {
    markFramePrefetchCacheKeyLoaded("layer|burst-a");
    markFramePrefetchCacheKeyLoaded("layer|burst-b");
    markFramePrefetchCacheKeyLoaded("layer|burst-c");
    assert.equal(notifications, 0, "the burst is deferred instead of synchronously rerendering subscribers");
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(notifications, 1);

    markFramePrefetchCacheKeyLoaded("layer|later");
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(notifications, 2, "a later cache change remains observable to already-mounted panels");
  } finally {
    unsubscribe();
  }
});

test("engine completion notifies other panels through the batched cache channel", async () => {
  const { FramePrefetchEngine, getCachedFramePrefetchState, subscribeFramePrefetchCacheChanges } = loadModule();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ schemaVersion: 1, features: [] }),
  });

  const vectorOnlyFrame = { ...frame(0), layers: {} };
  const activeLayers = new Set(["synoptic"]);
  const engine = new FramePrefetchEngine();
  let notifications = 0;
  const unsubscribe = subscribeFramePrefetchCacheChanges(() => {
    notifications += 1;
  });

  try {
    engine.configure({
      cacheKey: "cross-panel-recovery",
      frames: [vectorOnlyFrame],
      activeLayers,
      currentHour: 0,
      synopticDetailMode: "simple",
    });
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal(getCachedFramePrefetchState(vectorOnlyFrame, activeLayers), "loaded");
    assert.equal(notifications, 1, "an independent panel must observe the successful retry");
  } finally {
    unsubscribe();
    engine.stop();
    global.fetch = originalFetch;
  }
});
