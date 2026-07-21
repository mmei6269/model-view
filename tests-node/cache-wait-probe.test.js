"use strict";

// Tests for the sidecar-probe restructure of the grid-cache lock waits (audit
// finding: the poll loops re-read full multi-MB grid bodies every ~120ms).
// The probe gates on the small JSON sidecar only, so the body is read and
// validated once it reports ready; payload validation before use, byte
// identity of the returned grid, and fail-open-to-recompute are preserved.
// Also covers the stale-lock regression: the cumulative-snowfall lock helpers
// are aliases of the shared cache-io lock helpers, which remove stale locks.
// 2026-07-18 (backlog #44): the shared probeCachedGridSidecar probe now backs
// the run-max accumulation waits and the snowfall delta/cumulative waits —
// pinned here.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cacheMetadataPayloadMatches,
  probeCachedGridSidecar,
  readCachedFloatGrid,
  releaseGridCacheLock,
  tryAcquireGridCacheLock,
  waitForCachedGrid,
  writeCachedFloatGrid,
} = require("../scripts/lib/noaa-beta/cache-io");
const {
  buildCachedDeltaSnowfallGrids,
  deltaSnowfallCachePayload,
  deltaSnowfallGridCachePath,
  releaseSnowfallCumulativeGridLock,
  tryAcquireSnowfallCumulativeGridLock,
  writeCachedCumulativeSnowfallGrids,
} = require("../scripts/lib/noaa-beta/winter-snowfall-cache");

const CELL_COUNT = 4;
const PAYLOAD = Object.freeze({ family: "test", hour: 12 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeGrid(cellCount) {
  const grid = new Float32Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    grid[index] = index * 0.5;
  }
  return grid;
}

async function sidecarProbe(targetPath, expectedPayload) {
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${targetPath}.json`, "utf8"));
    return cacheMetadataPayloadMatches(metadata, expectedPayload);
  } catch {
    return false;
  }
}

test("waitForCachedGrid returns the cached grid with byte identity once the sidecar probes ready", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-wait-probe-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "grid");
  const lockPath = `${cachePath}.lock`;
  const grid = makeGrid(CELL_COUNT);
  assert.equal(await writeCachedFloatGrid(cachePath, PAYLOAD, grid), true);
  await fs.promises.writeFile(lockPath, JSON.stringify({ pid: process.pid }));

  let readCalls = 0;
  const waited = await waitForCachedGrid({
    cachePath,
    payload: PAYLOAD,
    lockPath,
    context: { profile: {} },
    read: async (targetPath, expectedPayload) => {
      readCalls += 1;
      return readCachedFloatGrid(targetPath, expectedPayload, CELL_COUNT);
    },
    probe: sidecarProbe,
    timeoutCounter: "testLockTimeouts",
  });
  assert.ok(waited instanceof Float32Array);
  assert.deepEqual(Array.from(waited), Array.from(grid));
  assert.equal(readCalls, 1);
});

test("waitForCachedGrid polls sidecars without reading bodies and fails open when the lock clears", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-wait-probe-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "grid");
  const lockPath = `${cachePath}.lock`;
  await fs.promises.writeFile(lockPath, JSON.stringify({ pid: process.pid }));

  let readCalls = 0;
  const waiting = waitForCachedGrid({
    cachePath,
    payload: PAYLOAD,
    lockPath,
    context: { profile: {} },
    read: async (targetPath, expectedPayload) => {
      readCalls += 1;
      return readCachedFloatGrid(targetPath, expectedPayload, CELL_COUNT);
    },
    probe: sidecarProbe,
    timeoutCounter: "testLockTimeouts",
  });
  // No cache entry ever lands; once the writer's lock clears the wait must
  // fail open (null → caller recomputes) without ever reading a grid body.
  await sleep(350);
  await fs.promises.rm(lockPath, { force: true });
  assert.equal(await waiting, null);
  assert.equal(readCalls, 0);
});

test("waitForCachedGrid keeps validating payload hash before use when the sidecar mismatches", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-wait-probe-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "grid");
  const lockPath = `${cachePath}.lock`;
  assert.equal(await writeCachedFloatGrid(cachePath, PAYLOAD, makeGrid(CELL_COUNT)), true);
  await fs.promises.writeFile(lockPath, JSON.stringify({ pid: process.pid }));

  const otherPayload = { family: "test", hour: 13 };
  let readCalls = 0;
  const waiting = waitForCachedGrid({
    cachePath,
    payload: otherPayload,
    lockPath,
    context: { profile: {} },
    read: async (targetPath, expectedPayload) => {
      readCalls += 1;
      return readCachedFloatGrid(targetPath, expectedPayload, CELL_COUNT);
    },
    probe: sidecarProbe,
    timeoutCounter: "testLockTimeouts",
  });
  await sleep(350);
  await fs.promises.rm(lockPath, { force: true });
  assert.equal(await waiting, null);
  assert.equal(readCalls, 0);
});

test("waitForCachedGrid still rejects a corrupt body after a ready probe", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-wait-probe-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "grid");
  const lockPath = `${cachePath}.lock`;
  assert.equal(await writeCachedFloatGrid(cachePath, PAYLOAD, makeGrid(CELL_COUNT)), true);
  // Truncate the body: the sidecar probes ready, but the full read must
  // refuse the corrupt grid instead of returning it.
  await fs.promises.truncate(`${cachePath}.bin`, 4);
  await fs.promises.writeFile(lockPath, JSON.stringify({ pid: process.pid }));

  let readCalls = 0;
  const waiting = waitForCachedGrid({
    cachePath,
    payload: PAYLOAD,
    lockPath,
    context: { profile: {} },
    read: async (targetPath, expectedPayload) => {
      readCalls += 1;
      return readCachedFloatGrid(targetPath, expectedPayload, CELL_COUNT);
    },
    probe: sidecarProbe,
    timeoutCounter: "testLockTimeouts",
  });
  await sleep(350);
  await fs.promises.rm(lockPath, { force: true });
  assert.equal(await waiting, null);
  assert.ok(readCalls >= 1, "expected the full read to run after a ready probe");
});

test("cumulative snowfall lock helpers are the shared cache-io lock helpers", () => {
  assert.equal(tryAcquireSnowfallCumulativeGridLock, tryAcquireGridCacheLock);
  assert.equal(releaseSnowfallCumulativeGridLock, releaseGridCacheLock);
});

test("cumulative snowfall lock acquisition removes a crashed worker's stale lock", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-stale-lock-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const lockPath = path.join(dir, "grid.lock");
  await fs.promises.writeFile(lockPath, JSON.stringify({ pid: 999999 }));
  const stale = new Date(Date.now() - 11 * 60 * 1000);
  await fs.promises.utimes(lockPath, stale, stale);

  const handle = await tryAcquireSnowfallCumulativeGridLock(lockPath, { hour: 12 });
  assert.ok(handle, "expected acquisition to succeed over a stale lock");
  await releaseSnowfallCumulativeGridLock(lockPath, handle);
  assert.equal(fs.existsSync(lockPath), false);

  // A fresh lock held by another process must still block acquisition.
  const first = await tryAcquireSnowfallCumulativeGridLock(lockPath, { hour: 12 });
  assert.ok(first);
  assert.equal(await tryAcquireSnowfallCumulativeGridLock(lockPath, { hour: 12 }), null);
  await releaseSnowfallCumulativeGridLock(lockPath, first);
});

test("probeCachedGridSidecar reports sidecar readiness without touching the grid body", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-sidecar-probe-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "grid");
  assert.equal(await probeCachedGridSidecar(null, PAYLOAD), false);
  assert.equal(await probeCachedGridSidecar(cachePath, PAYLOAD), false);

  const grid = makeGrid(CELL_COUNT);
  assert.equal(await writeCachedFloatGrid(cachePath, PAYLOAD, grid), true);
  assert.equal(await probeCachedGridSidecar(cachePath, PAYLOAD), true);

  // A payload for a different hour must not report ready.
  assert.equal(await probeCachedGridSidecar(cachePath, { family: "test", hour: 13 }), false);

  // The probe checks the sidecar only: with the body gone it still reports
  // ready, and the full read remains the validator that refuses the entry.
  await fs.promises.rm(`${cachePath}.bin`);
  assert.equal(await probeCachedGridSidecar(cachePath, PAYLOAD), true);
  assert.equal(await readCachedFloatGrid(cachePath, PAYLOAD, CELL_COUNT), null);

  // Corrupt sidecar JSON never reports ready.
  await fs.promises.writeFile(`${cachePath}.json`, "{not json");
  assert.equal(await probeCachedGridSidecar(cachePath, PAYLOAD), false);
});

test("snowfall delta wait probes the sidecar and returns byte-identical grids once published", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-delta-wait-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const context = {
    modelKey: "gfs",
    modelConfig: { productKey: "gfs-op" },
    date: "20260718",
    cycle: "00",
    width: 2,
    height: 2,
    bounds: { west: -100, south: 30, east: -90, north: 40 },
    availableHours: [0, 3, 6],
    deltaGridCacheDir: path.join(dir, "delta"),
    profile: {},
    decodeSession: null,
  };
  const entries = [{ key: "snowKuchera" }];
  const step = {
    startHour: 3,
    endHour: 6,
    chunks: [{ key: "chunk", kind: "interval", startHour: 3, endHour: 6, profileHour: 6, terms: [] }],
  };
  const payload = deltaSnowfallCachePayload({ entries, step, context });
  const cachePath = deltaSnowfallGridCachePath(payload, context);
  const lockPath = `${cachePath}.lock`;
  // Hold the writer's lock so the consumer falls into the probe-gated wait.
  const lockHandle = await tryAcquireGridCacheLock(lockPath, payload);
  assert.ok(lockHandle, "expected to hold the delta grid lock");

  let binReads = 0;
  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = async (...args) => {
    if (String(args[0]) === `${cachePath}.bin`) {
      binReads += 1;
    }
    return originalReadFile.apply(fs.promises, args);
  };
  t.after(() => {
    fs.promises.readFile = originalReadFile;
  });

  const waiting = buildCachedDeltaSnowfallGrids({ entries, step, context, decoded: null });
  // Several polls pass with nothing published: no body reads may happen.
  await sleep(350);
  assert.equal(binReads, 0, "no grid body reads while the sidecar is absent");
  const grids = new Map([["snowKuchera", makeGrid(CELL_COUNT)]]);
  assert.equal(await writeCachedCumulativeSnowfallGrids(cachePath, payload, grids, context), true);
  const waited = await waiting;
  await releaseGridCacheLock(lockPath, lockHandle);

  assert.ok(waited instanceof Map);
  assert.deepEqual(Array.from(waited.get("snowKuchera")), Array.from(grids.get("snowKuchera")));
  assert.equal(binReads, 1, "the body is read once, after the sidecar probes ready");
});
