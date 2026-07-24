"use strict";

// Regression tests for cache-write containment in the precip, snow-liquid,
// profile, and cumulative-snowfall grid writers (audit finding: a transient
// ENOSPC/EACCES/rename error rejected up through mapWithConcurrency and failed
// the whole frame, and orphaned `<cachePath>.tmp-<pid>-<rand>` files). Cache
// writes are best-effort by design — the fixed contract mirrors
// writeCachedFloatGrid: warn, clean up temp files, return false.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  precipSourceGridCachePath,
  probeCachedPrecipSourceGrid,
  readCachedPrecipSourceGrid,
  writeCachedPrecipSourceGrid,
} = require("../scripts/lib/noaa-beta/accumulation");
const {
  probeCachedSnowLiquidSourceGrid,
  readCachedSnowLiquidSourceGrid,
  snowLiquidSourceGridCachePath,
  writeCachedSnowLiquidSourceGrid,
} = require("../scripts/lib/noaa-beta/winter-source-grids");
const { readCachedProfileGrids, writeCachedProfileGrids } = require("../scripts/lib/noaa-beta/winter-profile-decode");
const {
  readCachedCumulativeSnowfallGrids,
  writeCachedCumulativeSnowfallGrids,
} = require("../scripts/lib/noaa-beta/winter-snowfall-cache");
// Both the profile-grid and cumulative-snowfall waits probe with the shared
// cache-io sidecar probe (their identical local copies were removed).
const { probeCachedGridSidecar } = require("../scripts/lib/noaa-beta/cache-io");

const WIDTH = 2;
const HEIGHT = 2;

const PRECIP_REF = {
  hour: 3,
  sourceKey: "precip:3:APCP",
  record: { record: "APCP", offset: 4096, param: "APCP", level: "surface", forecast: "0-3 hour acc", line: "12" },
};

const SNOW_LIQUID_REF = {
  hour: 3,
  kind: "direct",
  sourceKey: "snowlq:3:APCP",
  record: { record: "APCP", offset: 8192, param: "APCP", level: "surface", forecast: "0-3 hour acc", line: "13" },
  maskRecords: {},
  maskSamples: [],
};

const PROFILE_PAYLOAD = {
  version: "test-profile-v1",
  hour: 3,
  width: WIDTH,
  height: HEIGHT,
  records: { hgt: { record: "1" }, tmp2m: { record: "2" } },
};

const SNOWFALL_PAYLOAD = { version: "test-snowfall-v1", targetHour: 6, width: WIDTH, height: HEIGHT, entries: [] };

function makeGrid(cellCount) {
  const grid = new Float32Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    grid[index] = index * 0.5;
  }
  return grid;
}

function makeSourceContext(sourceGridCacheDir) {
  return {
    sourceGridCacheDir,
    modelKey: "gfs",
    modelConfig: { productKey: "gfs-op" },
    date: "20260718",
    cycle: "00",
    width: WIDTH,
    height: HEIGHT,
    bounds: { west: -100, south: 30, east: -90, north: 40 },
    availableHours: [0, 3, 6],
    decodeConcurrency: 1,
  };
}

async function listTmpEntries(dir) {
  const entries = await fs.promises.readdir(dir).catch(() => []);
  return entries.filter((name) => name.includes(".tmp-"));
}

async function makeBlockedCacheDir(t, prefix) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  // The cache dir's parent is a regular file, so mkdir fails.
  const blocker = path.join(dir, "blocker");
  await fs.promises.writeFile(blocker, "not a directory");
  return { dir, blockedCacheDir: path.join(blocker, "cache") };
}

test("writeCachedPrecipSourceGrid persists a readable grid and returns true", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-precip-write-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const context = makeSourceContext(path.join(dir, "cache"));
  const grid = makeGrid(WIDTH * HEIGHT);
  assert.equal(await probeCachedPrecipSourceGrid(PRECIP_REF, context), false);
  assert.equal(await writeCachedPrecipSourceGrid(PRECIP_REF, grid, context), true);

  const roundTripped = await readCachedPrecipSourceGrid(PRECIP_REF, context);
  assert.ok(roundTripped instanceof Float32Array);
  assert.deepEqual(Array.from(roundTripped), Array.from(grid));
  assert.equal(await probeCachedPrecipSourceGrid(PRECIP_REF, context), true);
  const cachePath = precipSourceGridCachePath(PRECIP_REF, context);
  assert.deepEqual(await listTmpEntries(path.dirname(cachePath)), []);
});

test("writeCachedPrecipSourceGrid returns false and warns when the cache dir cannot be created", async (t) => {
  const { dir, blockedCacheDir } = await makeBlockedCacheDir(t, "wx-precip-write-");
  const context = makeSourceContext(blockedCacheDir);

  const warn = t.mock.method(console, "warn", () => {});
  await assert.doesNotReject(async () => {
    assert.equal(await writeCachedPrecipSourceGrid(PRECIP_REF, makeGrid(WIDTH * HEIGHT), context), false);
  });
  assert.ok(warn.mock.callCount() >= 1, "expected a console.warn on cache-write failure");
  assert.match(String(warn.mock.calls[0].arguments[0]), /cache write failed/);
  assert.deepEqual(await listTmpEntries(dir), []);
});

test("writeCachedPrecipSourceGrid cleans up temp files when the final rename fails", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-precip-write-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  // The body destination exists as a directory: the tmp writes succeed, the
  // rename onto it fails, and the tmp pair must not be orphaned.
  const context = makeSourceContext(path.join(dir, "cache"));
  const cachePath = precipSourceGridCachePath(PRECIP_REF, context);
  await fs.promises.mkdir(cachePath, { recursive: true });

  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(await writeCachedPrecipSourceGrid(PRECIP_REF, makeGrid(WIDTH * HEIGHT), context), false);
  assert.ok(warn.mock.callCount() >= 1, "expected a console.warn on cache-write failure");
  assert.deepEqual(await listTmpEntries(path.dirname(cachePath)), []);
  assert.equal(fs.existsSync(`${cachePath}.json`), false);
});

test("writeCachedSnowLiquidSourceGrid persists a readable grid and returns true", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-snowlq-write-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const context = makeSourceContext(path.join(dir, "cache"));
  const grid = makeGrid(WIDTH * HEIGHT);
  assert.equal(await probeCachedSnowLiquidSourceGrid(SNOW_LIQUID_REF, context), false);
  assert.equal(await writeCachedSnowLiquidSourceGrid(SNOW_LIQUID_REF, grid, context), true);

  const roundTripped = await readCachedSnowLiquidSourceGrid(SNOW_LIQUID_REF, context);
  assert.ok(roundTripped instanceof Float32Array);
  assert.deepEqual(Array.from(roundTripped), Array.from(grid));
  assert.equal(await probeCachedSnowLiquidSourceGrid(SNOW_LIQUID_REF, context), true);
  const cachePath = snowLiquidSourceGridCachePath(SNOW_LIQUID_REF, context);
  assert.deepEqual(await listTmpEntries(path.dirname(cachePath)), []);
});

test("writeCachedSnowLiquidSourceGrid returns false and warns when the cache dir cannot be created", async (t) => {
  const { dir, blockedCacheDir } = await makeBlockedCacheDir(t, "wx-snowlq-write-");
  const context = makeSourceContext(blockedCacheDir);

  const warn = t.mock.method(console, "warn", () => {});
  await assert.doesNotReject(async () => {
    assert.equal(await writeCachedSnowLiquidSourceGrid(SNOW_LIQUID_REF, makeGrid(WIDTH * HEIGHT), context), false);
  });
  assert.ok(warn.mock.callCount() >= 1, "expected a console.warn on cache-write failure");
  assert.match(String(warn.mock.calls[0].arguments[0]), /cache write failed/);
  assert.deepEqual(await listTmpEntries(dir), []);
});

test("writeCachedSnowLiquidSourceGrid cleans up temp files when the final rename fails", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-snowlq-write-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const context = makeSourceContext(path.join(dir, "cache"));
  const cachePath = snowLiquidSourceGridCachePath(SNOW_LIQUID_REF, context);
  await fs.promises.mkdir(cachePath, { recursive: true });

  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(await writeCachedSnowLiquidSourceGrid(SNOW_LIQUID_REF, makeGrid(WIDTH * HEIGHT), context), false);
  assert.ok(warn.mock.callCount() >= 1, "expected a console.warn on cache-write failure");
  assert.deepEqual(await listTmpEntries(path.dirname(cachePath)), []);
  assert.equal(fs.existsSync(`${cachePath}.json`), false);
});

test("writeCachedProfileGrids persists readable grids and returns true", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-profile-write-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "nested", "profile");
  const decoded = { tmp2m: makeGrid(WIDTH * HEIGHT), hgt: makeGrid(WIDTH * HEIGHT).fill(7) };
  assert.equal(await probeCachedGridSidecar(cachePath, PROFILE_PAYLOAD), false);
  assert.equal(await writeCachedProfileGrids(cachePath, PROFILE_PAYLOAD, decoded), true);

  const roundTripped = await readCachedProfileGrids(cachePath, PROFILE_PAYLOAD);
  assert.deepEqual(Array.from(roundTripped.tmp2m), Array.from(decoded.tmp2m));
  assert.deepEqual(Array.from(roundTripped.hgt), Array.from(decoded.hgt));
  assert.equal(await probeCachedGridSidecar(cachePath, PROFILE_PAYLOAD), true);
  assert.deepEqual(await listTmpEntries(path.dirname(cachePath)), []);
});

test("writeCachedProfileGrids returns false and warns when the cache dir cannot be created", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-profile-write-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, "blocker");
  await fs.promises.writeFile(blocker, "not a directory");
  const cachePath = path.join(blocker, "profile");

  const warn = t.mock.method(console, "warn", () => {});
  await assert.doesNotReject(async () => {
    assert.equal(
      await writeCachedProfileGrids(
        cachePath,
        { ...PROFILE_PAYLOAD, records: { tmp2m: PROFILE_PAYLOAD.records.tmp2m } },
        { tmp2m: makeGrid(WIDTH * HEIGHT) },
      ),
      false,
    );
  });
  assert.ok(warn.mock.callCount() >= 1, "expected a console.warn on cache-write failure");
  assert.match(String(warn.mock.calls[0].arguments[0]), /cache write failed/);
  assert.deepEqual(await listTmpEntries(dir), []);
});

test("writeCachedProfileGrids cleans up temp files when the final rename fails", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-profile-write-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "profile");
  await fs.promises.mkdir(`${cachePath}.bin`);

  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(
    await writeCachedProfileGrids(
      cachePath,
      { ...PROFILE_PAYLOAD, records: { tmp2m: PROFILE_PAYLOAD.records.tmp2m } },
      { tmp2m: makeGrid(WIDTH * HEIGHT) },
    ),
    false,
  );
  assert.ok(warn.mock.callCount() >= 1, "expected a console.warn on cache-write failure");
  assert.deepEqual(await listTmpEntries(dir), []);
  assert.equal(fs.existsSync(`${cachePath}.json`), false);
});

test("writeCachedCumulativeSnowfallGrids persists readable grids and returns true", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-snowfall-write-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "nested", "snowfall");
  const grids = new Map([["snowKuchera", makeGrid(WIDTH * HEIGHT)]]);
  assert.equal(await probeCachedGridSidecar(cachePath, SNOWFALL_PAYLOAD), false);
  assert.equal(await writeCachedCumulativeSnowfallGrids(cachePath, SNOWFALL_PAYLOAD, grids), true);

  const roundTripped = await readCachedCumulativeSnowfallGrids(cachePath, SNOWFALL_PAYLOAD);
  assert.deepEqual(Array.from(roundTripped.get("snowKuchera")), Array.from(grids.get("snowKuchera")));
  assert.equal(await probeCachedGridSidecar(cachePath, SNOWFALL_PAYLOAD), true);
  assert.deepEqual(await listTmpEntries(path.dirname(cachePath)), []);
});

test("writeCachedCumulativeSnowfallGrids returns false and warns when the cache dir cannot be created", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-snowfall-write-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, "blocker");
  await fs.promises.writeFile(blocker, "not a directory");
  const cachePath = path.join(blocker, "snowfall");

  const warn = t.mock.method(console, "warn", () => {});
  await assert.doesNotReject(async () => {
    assert.equal(
      await writeCachedCumulativeSnowfallGrids(
        cachePath,
        SNOWFALL_PAYLOAD,
        new Map([["snowKuchera", makeGrid(WIDTH * HEIGHT)]]),
      ),
      false,
    );
  });
  assert.ok(warn.mock.callCount() >= 1, "expected a console.warn on cache-write failure");
  assert.match(String(warn.mock.calls[0].arguments[0]), /cache write failed/);
  assert.deepEqual(await listTmpEntries(dir), []);
});

test("writeCachedCumulativeSnowfallGrids cleans up temp files when the final rename fails", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-snowfall-write-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "snowfall");
  await fs.promises.mkdir(`${cachePath}.bin`);

  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(
    await writeCachedCumulativeSnowfallGrids(
      cachePath,
      SNOWFALL_PAYLOAD,
      new Map([["snowKuchera", makeGrid(WIDTH * HEIGHT)]]),
    ),
    false,
  );
  assert.ok(warn.mock.callCount() >= 1, "expected a console.warn on cache-write failure");
  assert.deepEqual(await listTmpEntries(dir), []);
  assert.equal(fs.existsSync(`${cachePath}.json`), false);
});

test("grid probes return false when the sidecar payload does not match", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-probe-mismatch-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "snowfall");
  const grids = new Map([["snowKuchera", makeGrid(WIDTH * HEIGHT)]]);
  assert.equal(await writeCachedCumulativeSnowfallGrids(cachePath, SNOWFALL_PAYLOAD, grids), true);
  assert.equal(await probeCachedGridSidecar(cachePath, SNOWFALL_PAYLOAD), true);
  // A payload for a different target hour must not probe (or read) as a hit.
  const otherPayload = { ...SNOWFALL_PAYLOAD, targetHour: 9 };
  assert.equal(await probeCachedGridSidecar(cachePath, otherPayload), false);
  assert.equal(await readCachedCumulativeSnowfallGrids(cachePath, otherPayload), null);
});
