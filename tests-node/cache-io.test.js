"use strict";

// Regression tests for writeCachedFloatGrid error containment (audit finding:
// cache-persist failures used to reject through the caller and fail the whole
// frame, and orphaned `<cachePath>.tmp-<pid>-<rand>`/`.json` files). Cache
// writes are best-effort by design — the fixed contract mirrors
// writeDerivedGridCache: warn, clean up temp files, return false.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { readCachedFloatGrid, writeCachedFloatGrid } = require("../scripts/lib/noaa-beta/cache-io");

const PAYLOAD = Object.freeze({ family: "run-maximum", outputKey: "gust", hour: 12 });

function makeGrid(cellCount) {
  const grid = new Float32Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    grid[index] = index * 0.5;
  }
  return grid;
}

async function listTmpEntries(dir) {
  const entries = await fs.promises.readdir(dir).catch(() => []);
  return entries.filter((name) => name.includes(".tmp-"));
}

test("writeCachedFloatGrid persists a readable grid and returns true", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-cache-io-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const cachePath = path.join(dir, "nested", "grid");
  const grid = makeGrid(16);
  assert.equal(await writeCachedFloatGrid(cachePath, PAYLOAD, grid), true);

  const roundTripped = await readCachedFloatGrid(cachePath, PAYLOAD, 16);
  assert.ok(roundTripped instanceof Float32Array);
  assert.deepEqual(Array.from(roundTripped), Array.from(grid));
  assert.deepEqual(await listTmpEntries(path.dirname(cachePath)), []);
});

test("writeCachedFloatGrid returns false and warns when the cache dir cannot be created", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-cache-io-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  // The cache path's parent "directory" is a regular file, so mkdir fails.
  const blocker = path.join(dir, "blocker");
  await fs.promises.writeFile(blocker, "not a directory");
  const cachePath = path.join(blocker, "grid");

  const warn = t.mock.method(console, "warn", () => {});
  await assert.doesNotReject(async () => {
    assert.equal(await writeCachedFloatGrid(cachePath, PAYLOAD, makeGrid(8)), false);
  });
  assert.ok(warn.mock.callCount() >= 1, "expected a console.warn on cache-write failure");
  assert.match(String(warn.mock.calls[0].arguments[0]), /cache write failed/);
  assert.ok(String(warn.mock.calls[0].arguments[0]).includes(cachePath));
  assert.deepEqual(await listTmpEntries(dir), []);
});

test("writeCachedFloatGrid cleans up temp files when the final rename fails", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-cache-io-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  // `${cachePath}.bin` exists as a directory: the tmp writes succeed, the
  // rename onto it fails, and the tmp pair must not be orphaned.
  const cachePath = path.join(dir, "grid");
  await fs.promises.mkdir(`${cachePath}.bin`);

  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(await writeCachedFloatGrid(cachePath, PAYLOAD, makeGrid(8)), false);
  assert.ok(warn.mock.callCount() >= 1, "expected a console.warn on cache-write failure");
  assert.deepEqual(await listTmpEntries(dir), []);
  // The metadata half must not have landed either (rename pair aborted).
  assert.equal(fs.existsSync(`${cachePath}.json`), false);
});

test("writeCachedFloatGrid returns false for missing cachePath or values", async () => {
  assert.equal(await writeCachedFloatGrid(null, PAYLOAD, makeGrid(4)), false);
  assert.equal(await writeCachedFloatGrid("/nonexistent/never-used", PAYLOAD, null), false);
});
