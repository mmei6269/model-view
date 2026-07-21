"use strict";

// Backlog #43 (2026-07-18): the H/L climb field (Gaussian + NaN re-mask) is
// computed on padded per-candidate patches instead of the full display grid.
// Every climb-field read in refineCenterAgainstField stays inside the closed
// Euclidean disc of radius travelPx around the candidate's clamped seed (seed
// tap, no-data rescue ring scan, hill-climb neighborhood), so a patch padded
// by kernel radius R = max(1, ceil(sigmaPx * 2.6)) plus a 2 px safety is
// bit-identical to the full-grid blur across the whole disc: out-of-patch
// kernel taps are skipped (weights renormalized) exactly like out-of-grid
// taps, and the blit shrinks by R on every side that is not a grid edge.
// These tests pin that byte-identity cell-for-cell, the identical refined
// rosters, patch dedupe, the zero-candidate no-blur guarantee, and the
// mostly-covered fallback to the full-grid blur.

const assert = require("node:assert/strict");
const test = require("node:test");
const { _testCenterRefinement } = require("../scripts/lib/synoptic-render.js");

const { buildCenterRefinementContext, refineCenterAgainstField, resolveClimbFieldForSeed } = _testCenterRefinement;

const BOUNDS = Object.freeze({ north: 53, south: 21, west: -129, east: -63 });
const COLS = 800;
const ROWS = 490;
const DETECTION_COLS = 118; // ~50 km analysis grid over CONUS
const DETECTION_ROWS = 72;

// Planted systems: interior low, high clipped by the west grid edge, low
// adjacent to a NaN block (native-domain style) occupying x >= NAN_START_COL.
const NAN_START_COL = 690;
const SYSTEMS = [
  { x: 400, y: 245, amp: -18, sigmaPx: 60 },
  { x: 6, y: 240, amp: 15, sigmaPx: 40 },
  { x: 660, y: 130, amp: -12, sigmaPx: 35 },
];

function buildField(cols, rows) {
  const values = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      let value = 1015;
      for (const system of SYSTEMS) {
        const dx = x - system.x;
        const dy = y - system.y;
        value += system.amp * Math.exp(-(dx * dx + dy * dy) / (2 * system.sigmaPx * system.sigmaPx));
      }
      values[y * cols + x] = x >= NAN_START_COL ? Number.NaN : value;
    }
  }
  return values;
}

function buildContext(
  values,
  cols,
  rows,
  modelKey = "gfs",
  detectionCols = DETECTION_COLS,
  detectionRows = DETECTION_ROWS,
) {
  const context = buildCenterRefinementContext({
    grid: { values, cols, rows },
    bounds: BOUNDS,
    modelKey,
    detectionCols,
    detectionRows,
  });
  assert.ok(context, "refinement context expected for a finite grid");
  return context;
}

// Display-pixel seeds exercised by the suite: interior, west-edge, adjacent
// to the NaN block, inside the NaN block (rescue path), grid corner.
const SEEDS = [
  { x: 400, y: 245 },
  { x: 6, y: 240 },
  { x: 660, y: 130 },
  { x: 695, y: 130 },
  { x: 0, y: 0 },
];

function detectionCandidate(seed, kind, context) {
  return {
    kind,
    x: (seed.x / (context.cols - 1)) * (context.detectionCols - 1),
    y: (seed.y / (context.rows - 1)) * (context.detectionRows - 1),
    value: 1000,
    prominence: 8,
    score: 10,
  };
}

for (const modelKey of ["gfs", "nam"]) {
  test(`patch blur matches the full-grid blur cell-for-cell across every blit rect (${modelKey})`, () => {
    const values = buildField(COLS, ROWS);
    const patchContext = buildContext(values, COLS, ROWS, modelKey);
    const fullContext = buildContext(values, COLS, ROWS, modelKey);
    const full = fullContext.climbValues; // forced full-grid build
    assert.equal(fullContext.climbBuildStats.fullBuilds, 1);

    const scratch = resolveClimbFieldForSeed(patchContext, SEEDS[0].x, SEEDS[0].y);
    for (const seed of SEEDS.slice(1)) {
      assert.strictEqual(
        resolveClimbFieldForSeed(patchContext, seed.x, seed.y),
        scratch,
        "patch path must return one shared scratch field",
      );
    }
    assert.equal(patchContext.climbBuildStats.fullBuilds, 0, "patch path must not fall back here");
    assert.ok(patchContext.climbBuildStats.patchBuilds >= SEEDS.length - 1, "expected per-seed patches");

    const { travelPx } = patchContext;
    assert.ok(patchContext.climbSigmaPx > 0, `${modelKey} pre-smooth must apply on this grid`);
    // Strongest statement: every blitted rect is bit-identical to the full
    // blur. The read discs are a subset of the rect union (proven padding),
    // and disc membership is asserted below for one interior and one
    // NaN-adjacent seed to pin the read bound itself.
    for (const rect of patchContext.climbPatchState.rects) {
      for (let y = rect.y0; y <= rect.y1; y += 1) {
        for (let x = rect.x0; x <= rect.x1; x += 1) {
          const index = y * COLS + x;
          assert.ok(
            Object.is(scratch[index], full[index]),
            `${modelKey} cell (${x},${y}): patch ${scratch[index]} != full ${full[index]}`,
          );
        }
      }
    }
    for (const seed of [SEEDS[0], SEEDS[3]]) {
      for (let dy = -travelPx; dy <= travelPx; dy += 1) {
        for (let dx = -travelPx; dx <= travelPx; dx += 1) {
          if (dx * dx + dy * dy > travelPx * travelPx) {
            continue;
          }
          const x = seed.x + dx;
          const y = seed.y + dy;
          if (x < 0 || y < 0 || x >= COLS || y >= ROWS) {
            continue;
          }
          const index = y * COLS + x;
          assert.ok(
            Object.is(scratch[index], full[index]),
            `${modelKey} read-disc cell (${x},${y}) around (${seed.x},${seed.y}) differs`,
          );
        }
      }
    }
  });
}

test("refined centers are identical between patch and full-blur paths (interior, edge, NaN rescue)", () => {
  const values = buildField(COLS, ROWS);
  const patchContext = buildContext(values, COLS, ROWS);
  const fullContext = buildContext(values, COLS, ROWS);
  fullContext.climbValues; // force the full-grid build up front

  const kinds = ["low", "high", "low", "low", "high"];
  const refinedPatch = SEEDS.map((seed, index) =>
    refineCenterAgainstField(detectionCandidate(seed, kinds[index], patchContext), patchContext, kinds[index]),
  );
  const refinedFull = SEEDS.map((seed, index) =>
    refineCenterAgainstField(detectionCandidate(seed, kinds[index], fullContext), fullContext, kinds[index]),
  );

  assert.equal(patchContext.climbBuildStats.fullBuilds, 0, "common case must stay on patches");
  assert.equal(patchContext.climbBuildStats.patchBuilds, SEEDS.length, "well-separated seeds build one patch each");
  assert.deepEqual(refinedPatch, refinedFull);
});

test("adjacent seeds share one patch (blit-rect containment dedupe)", () => {
  const values = buildField(COLS, ROWS);
  const patchContext = buildContext(values, COLS, ROWS);
  const fullContext = buildContext(values, COLS, ROWS);
  fullContext.climbValues;

  const nearA = { x: 400, y: 245 };
  const nearB = { x: 401, y: 245 }; // inside patch A's safety margin
  const refinedA = refineCenterAgainstField(detectionCandidate(nearA, "low", patchContext), patchContext, "low");
  const refinedB = refineCenterAgainstField(detectionCandidate(nearB, "low", patchContext), patchContext, "low");
  assert.equal(patchContext.climbBuildStats.patchBuilds, 1, "second seed must reuse the first patch");

  const fullA = refineCenterAgainstField(detectionCandidate(nearA, "low", fullContext), fullContext, "low");
  const fullB = refineCenterAgainstField(detectionCandidate(nearB, "low", fullContext), fullContext, "low");
  assert.deepEqual([refinedA, refinedB], [fullA, fullB]);
});

test("zero candidates compute no blur at all", () => {
  const values = buildField(COLS, ROWS);
  const context = buildContext(values, COLS, ROWS);
  // Detection never samples the climb field; with no candidates nothing may
  // trigger any blur (stats are the spy: both build counters stay at zero).
  assert.strictEqual(context.climbPatchState, null);
  assert.deepEqual(context.climbBuildStats, { fullBuilds: 0, patchBuilds: 0, patchedCells: 0 });
});

test("no-presmooth grids refine against the raw field with no blur", () => {
  // Coarse grid: pre-smooth sigma drops below the 0.45 px floor, so the climb
  // field IS the raw field and no blur of any kind may run.
  const coarseCols = 100;
  const coarseRows = 60;
  const values = buildField(coarseCols, coarseRows);
  const context = buildContext(values, coarseCols, coarseRows);
  assert.equal(context.climbSigmaPx, 0, "coarse grid must not pre-smooth");
  const seed = { x: 50, y: 30 };
  const refined = refineCenterAgainstField(detectionCandidate(seed, "low", context), context, "low");
  assert.deepEqual(context.climbBuildStats, { fullBuilds: 0, patchBuilds: 0, patchedCells: 0 });
  assert.strictEqual(context.climbPatchState, null);
  assert.ok(Number.isFinite(refined.value));
});

test("candidates tiling the grid fall back to one full-grid blur with identical results", () => {
  // Small-region bounds make travelPx huge relative to the grid: a single
  // patch already exceeds the half-grid fallback threshold.
  const tightBounds = { north: 26, south: 21, west: -100, east: -95 };
  const cols = 120;
  const rows = 90;
  const values = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const dx = x - 60;
      const dy = y - 45;
      values[y * cols + x] = 1015 - 15 * Math.exp(-(dx * dx + dy * dy) / (2 * 20 * 20));
    }
  }
  const buildTight = () =>
    buildCenterRefinementContext({
      grid: { values, cols, rows },
      bounds: tightBounds,
      modelKey: "gfs",
      detectionCols: 12,
      detectionRows: 9,
    });
  const patchContext = buildTight();
  const fullContext = buildTight();
  fullContext.climbValues;
  assert.ok(patchContext.climbSigmaPx > 0, "pre-smooth must apply here");

  const seed = { x: 55, y: 40 };
  const candidate = (context) => detectionCandidate(seed, "low", context);
  const refinedPatch = refineCenterAgainstField(candidate(patchContext), patchContext, "low");
  const refinedFull = refineCenterAgainstField(candidate(fullContext), fullContext, "low");
  assert.equal(patchContext.climbBuildStats.patchBuilds, 0, "oversized patch must not be built");
  assert.equal(patchContext.climbBuildStats.fullBuilds, 1, "fallback must build the full grid once");
  assert.deepEqual(refinedPatch, refinedFull);
});
