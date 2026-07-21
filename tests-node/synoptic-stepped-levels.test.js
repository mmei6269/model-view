"use strict";

// Regression tests for the buildSteppedLevels level-count cap (audit finding:
// unlike its sibling buildHeightContourLevels, it had no maxLevels guard, so a
// mis-scaled field — e.g. Pa instead of hPa, span ~90,000 — produced tens of
// thousands of contour levels and a data-driven multi-minute frame stall).
// The cap must be invisible for every plausible real field: MSLP and
// thickness level counts sit far below 512, so byte parity holds.

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildHeightContourLevels, _testLevels } = require("../scripts/lib/synoptic-render.js");
const { buildSteppedLevels } = _testLevels;

test("buildSteppedLevels is unchanged for a realistic MSLP range", () => {
  // 960..1044 hPa at the shared style's 4-hPa minor interval: 22 levels.
  const levels = buildSteppedLevels(960, 1044, 4);
  assert.deepEqual(
    levels,
    Array.from({ length: 22 }, (_, index) => 960 + index * 4),
  );
});

test("buildSteppedLevels is unchanged for a realistic thickness range", () => {
  // 474..594 dam at the 6-dam minor interval: 21 levels.
  const levels = buildSteppedLevels(474, 594, 6);
  assert.deepEqual(
    levels,
    Array.from({ length: 21 }, (_, index) => 474 + index * 6),
  );
});

test("buildSteppedLevels keeps a complete roster exactly at the cap boundary", () => {
  // Exactly 512 levels available: none may be dropped.
  const levels = buildSteppedLevels(0, 511 * 4, 4);
  assert.equal(levels.length, 512);
  assert.equal(levels[levels.length - 1], 511 * 4);
});

test("buildSteppedLevels caps a pathological Pa-scale range at 512 levels", () => {
  // MSLP delivered in Pa instead of hPa: span ~90,000 at interval 4 would be
  // ~22,500 levels without the guard.
  const levels = buildSteppedLevels(0, 90000, 4);
  assert.equal(levels.length, 512);
  assert.equal(levels[0], 0);
  assert.equal(levels[levels.length - 1], 511 * 4);
  for (let index = 1; index < levels.length; index += 1) {
    assert.equal(levels[index] - levels[index - 1], 4);
  }
});

test("buildSteppedLevels truncation matches the buildHeightContourLevels sibling", () => {
  // Same guard, same semantics: keep the first 512 levels from the start.
  assert.deepEqual(buildSteppedLevels(0, 90000, 4), buildHeightContourLevels(0, 90000, 4));
  assert.deepEqual(buildSteppedLevels(0, 513 * 4, 4), buildHeightContourLevels(0, 513 * 4, 4));
});

test("buildSteppedLevels keeps its degenerate-input contract", () => {
  assert.deepEqual(buildSteppedLevels(1044, 960, 4), []);
  assert.deepEqual(buildSteppedLevels(960, 1044, 0), []);
  assert.deepEqual(buildSteppedLevels(Number.NaN, 1044, 4), []);
});
