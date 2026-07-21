"use strict";

// Builder flag-resolution contracts pinned after an audit found three silent
// failures: blank flag/env values resolved to 0 (collapsing the build to one
// worker from a blank .env template line), --total-frame-concurrency was
// inert for scheduling (its cap sat in clampInt's unreachable non-finite
// fallback slot), and the global queue raised an explicit retry throttle to
// pool width.

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  _testNumberFlag: numberFlag,
  _testIsExplicitNumberFlag: isExplicitNumberFlag,
  _testResolveBuilderCacheRoot: resolveBuilderCacheRoot,
  resolveParallelism,
} = require("../scripts/build-noaa-beta-artifacts");

const ROOT_DIR = path.resolve(__dirname, "..");

const RESOURCES = { cpuCount: 18, memGb: 128, freeGb: 32 };
const MODELS = ["gfs", "nam", "nam3km", "hrrr"];

function withEnv(pairs, run) {
  const saved = {};
  for (const [key, value] of Object.entries(pairs)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("numberFlag treats blank and bare-boolean spellings as unset", () => {
  assert.equal(numberFlag(undefined, undefined, 7), 7);
  assert.equal(numberFlag("", undefined, 7), 7);
  assert.equal(numberFlag("   ", undefined, 7), 7);
  assert.equal(numberFlag(undefined, "", 7), 7);
  assert.equal(numberFlag(true, undefined, 7), 7);
  assert.equal(numberFlag(false, undefined, 7), 7);
  assert.equal(numberFlag("0", undefined, 7), 0);
  assert.equal(numberFlag("12", undefined, 7), 12);
  assert.equal(numberFlag(undefined, "12", 7), 12);
  assert.equal(numberFlag("garbage", undefined, 7), 7);
});

test("isExplicitNumberFlag matches numberFlag's notion of supplied", () => {
  assert.equal(isExplicitNumberFlag(undefined), false);
  assert.equal(isExplicitNumberFlag(""), false);
  assert.equal(isExplicitNumberFlag("  "), false);
  assert.equal(isExplicitNumberFlag(true), false);
  assert.equal(isExplicitNumberFlag("garbage"), false);
  assert.equal(isExplicitNumberFlag("4"), true);
  assert.equal(isExplicitNumberFlag(4), true);
});

test("blank concurrency env vars keep the defaults instead of collapsing to 1", () => {
  const parallelism = withEnv({ MODELVIEW_NOAA_WORKER_COUNT: "", MODELVIEW_NOAA_FRAME_CONCURRENCY: "" }, () =>
    resolveParallelism({ args: {}, resources: RESOURCES, models: MODELS }),
  );
  assert.equal(parallelism.workerCount, 18);
  assert.equal(parallelism.frameConcurrency, 24);
});

test("--total-frame-concurrency caps the frame and worker defaults", () => {
  const throttled = resolveParallelism({
    args: { "total-frame-concurrency": "4" },
    resources: RESOURCES,
    models: MODELS,
  });
  assert.equal(throttled.totalFrameConcurrency, 4);
  assert.equal(throttled.frameConcurrency, 4);
  assert.equal(throttled.workerCount, 4);

  const withExplicitWorkers = resolveParallelism({
    args: { "total-frame-concurrency": "4", "worker-count": "10" },
    resources: RESOURCES,
    models: MODELS,
  });
  assert.equal(withExplicitWorkers.workerCount, 10, "an explicit worker-count still wins over the cap");

  const unthrottled = resolveParallelism({ args: {}, resources: RESOURCES, models: MODELS });
  assert.equal(unthrottled.workerCount, 18);
  assert.equal(unthrottled.frameConcurrency, 24);
});

test("a relative cache root anchors on the repo root regardless of the invoking cwd", (t) => {
  // The builder used to resolve a relative MODELVIEW_CACHE_ROOT/--cache-root
  // against process.cwd() while prune-render-cache/noaa-update anchor on the
  // repo root, forking the cache namespace for direct `node scripts/...`
  // invocations from a foreign cwd (.env.example ships the relative value
  // `output/noaa-beta-cache`). Prove cwd is irrelevant by resolving from a
  // temp directory.
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  process.chdir(os.tmpdir());
  const expected = path.join(ROOT_DIR, "output", "noaa-beta-cache");
  assert.equal(resolveBuilderCacheRoot("output/noaa-beta-cache", {}), expected, "relative --cache-root flag");
  assert.equal(
    resolveBuilderCacheRoot(undefined, { MODELVIEW_CACHE_ROOT: "output/noaa-beta-cache" }),
    expected,
    "relative MODELVIEW_CACHE_ROOT",
  );
  assert.equal(resolveBuilderCacheRoot(undefined, {}), expected, "unset env keeps the absolute default");
  const absolute = path.join(os.tmpdir(), "wx-absolute-cache-root");
  assert.equal(resolveBuilderCacheRoot(absolute, {}), absolute, "absolute paths pass through unchanged");
  assert.equal(
    resolveBuilderCacheRoot(undefined, { MODELVIEW_CACHE_ROOT: absolute }),
    absolute,
    "absolute env paths pass through unchanged",
  );
});

test("explicit retry-frame-concurrency is reported explicit; defaults are not", () => {
  const explicit = resolveParallelism({
    args: { "retry-frame-concurrency": "1" },
    resources: RESOURCES,
    models: MODELS,
  });
  assert.equal(explicit.retryFrameConcurrency, 1);
  assert.equal(explicit.retryFrameConcurrencyExplicit, true);

  const defaulted = resolveParallelism({ args: {}, resources: RESOURCES, models: MODELS });
  assert.equal(defaulted.retryFrameConcurrencyExplicit, false);

  const blank = withEnv({ MODELVIEW_NOAA_RETRY_FRAME_CONCURRENCY: "" }, () =>
    resolveParallelism({ args: {}, resources: RESOURCES, models: MODELS }),
  );
  assert.equal(blank.retryFrameConcurrencyExplicit, false, "a blank env spelling is not an explicit throttle");
});
