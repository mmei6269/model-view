"use strict";

// Engagement tests for the mapWithConcurrency shared abort flag (audit
// finding: when one runner rejected, surviving runners kept pulling and
// awaiting the whole remaining item list before Promise.all settled). After
// the fix, surviving runners stop pulling new items once a rejection occurs;
// result-by-index ordering and rejection propagation are unchanged.

const assert = require("node:assert/strict");
const test = require("node:test");

const { mapWithConcurrency } = require("../scripts/lib/noaa-beta/cache-io");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("run-resolution re-exports the one abort-aware mapWithConcurrency, not a stale twin", () => {
  // The abort fix must not silently fork: run-resolution used to carry an
  // identical same-named copy without the abort flag, so callers importing
  // from there (e.g. the server's run-annotation fanouts) kept the
  // detached-work behavior this suite pins.
  assert.equal(require("../scripts/lib/noaa-build/run-resolution").mapWithConcurrency, mapWithConcurrency);
});

test("mapWithConcurrency returns results by index for the happy path", async () => {
  const items = Array.from({ length: 12 }, (_, index) => index);
  const out = await mapWithConcurrency(items, 4, async (item) => {
    await sleep((item % 3) * 5);
    return item * 2;
  });
  assert.deepEqual(
    out,
    items.map((item) => item * 2),
  );
});

test("mapWithConcurrency handles empty and non-array input", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency(null, 4, async () => 1), []);
});

test("mapWithConcurrency propagates the worker rejection", async () => {
  const items = Array.from({ length: 6 }, (_, index) => index);
  await assert.rejects(
    mapWithConcurrency(items, 2, async (item) => {
      if (item === 2) {
        throw new Error(`boom-${item}`);
      }
      await sleep(5);
      return item;
    }),
    /boom-2/,
  );
});

test("mapWithConcurrency stops pulling new items after a runner rejects", async () => {
  const items = Array.from({ length: 10 }, (_, index) => index);
  const started = [];
  await assert.rejects(
    mapWithConcurrency(items, 2, async (item) => {
      started.push(item);
      if (item === 0) {
        await sleep(15);
        throw new Error("boom");
      }
      await sleep(50);
      return item;
    }),
    /boom/,
  );
  // Let any abandoned runners settle: without the abort flag the surviving
  // runner would keep draining the list and start every remaining item.
  await sleep(240);
  assert.deepEqual(
    [...started].sort((left, right) => left - right),
    [0, 1],
  );
});
