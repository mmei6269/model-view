"use strict";

// Task S2 (map QA update set §6a): H/L center detection gates in PHYSICAL
// kilometres, not fixed grid-cell counts. The legacy 9x9 disc / 3-5 ring /
// 6-cell same-kind spacing meant ~1000 km windows on the ~250 km simple grid
// but ~64 km on the ~16 km detailed grid — the two modes detected on wildly
// different synoptic scales. These tests run the SAME analytic field through
// a coarse (25x15) and a fine (200x120) detection grid and require identical
// system rosters: a 350 km low pair merges to one system on both (same-kind
// minimum 450 km), a low 900 km away stays distinct, and a sub-prominence
// 1.2 hPa dimple is rejected on both.

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  _testCenterAnalysis,
  _testCenterDetection,
  _testCenterValidation,
  _testSmoothing,
} = require("../scripts/lib/synoptic-render.js");
const { loadSynopticStyle } = require("../scripts/lib/synoptic-style.js");
const { rowToLatMercator } = require("../scripts/lib/mercator.js");

const BOUNDS = Object.freeze({ north: 53, south: 21, west: -129, east: -63 });
// Production-shaped detection grids: simple mode prepares ~25x15 (~250 km
// cells) from the display grid; the detailed cap yields ~16-30 km cells.
const COARSE = Object.freeze({ cols: 25, rows: 15 });
const FINE = Object.freeze({ cols: 200, rows: 120 });

const KM_PER_DEG_LON_40N = 111 * Math.cos((40 * Math.PI) / 180);

// Three equal-depth 8 hPa lows along 40N: A, B 350 km east of A (must merge
// with A under the 450 km same-kind minimum), C 900 km east of the pair
// (measured from B, its nearest member — distinct from both). Plus a 1.2 hPa
// dimple below the 1.8 hPa prominence threshold, far from everything else.
const LOW_A = { lat: 40, lon: -100, amp: -8, sigmaKm: 150 };
const LOW_B = { lat: 40, lon: -100 + 350 / KM_PER_DEG_LON_40N, amp: -8, sigmaKm: 150 };
const LOW_C = { lat: 40, lon: -100 + (350 + 900) / KM_PER_DEG_LON_40N, amp: -8, sigmaKm: 150 };
const DIMPLE = { lat: 30, lon: -115, amp: -1.2, sigmaKm: 100 };
const BACKGROUND = 1016;
const SYSTEMS = [LOW_A, LOW_B, LOW_C, DIMPLE];

test("production center-only grid resolves the 200 km locality at ~50 km while staying bounded", () => {
  const size = _testCenterAnalysis.resolveCenterAnalysisGridSize(BOUNDS, 1600, 980);
  const spacingKm = _testCenterDetection.estimateGridSpacingKm(BOUNDS, size.cols, size.rows);
  const simpleContourCells = COARSE.cols * COARSE.rows;
  assert.ok(spacingKm >= 42 && spacingKm <= 58, `expected ~50 km cells, got ${spacingKm.toFixed(1)} km`);
  assert.ok(size.cols <= _testCenterAnalysis.maxCols);
  assert.ok(size.rows <= _testCenterAnalysis.maxRows);
  assert.ok(
    size.cols * size.rows <= _testCenterAnalysis.maxCols * _testCenterAnalysis.maxRows,
    "center-only analysis must retain its fixed compute bound",
  );
  assert.ok(
    size.cols * size.rows > simpleContourCells * 4,
    "center analysis must not collapse back to the coarse 25x15 contour grid",
  );
});

test("center prominence fallback is consistently 1.8 hPa when a style omits the setting", () => {
  assert.equal(_testCenterDetection.defaultProminenceMinHpa, 1.8);
  assert.equal(_testCenterDetection.resolveCenterProminenceThreshold({ centers: {} }), 1.8);
  const cols = 41;
  const rows = 41;
  const values = new Float32Array(cols * rows).fill(1013);
  values[20 * cols + 20] = 1015;
  const centers = _testCenterDetection.detectPressureCenters(
    values,
    cols,
    rows,
    { centers: { maxMarkersByBucket: { z4_6: 12 } } },
    null,
    50,
  );
  assert.equal(centers.filter((center) => center.kind === "high").length, 1, "2.0 hPa must clear the 1.8 fallback");
});

test("row-aware center validation catches high-latitude locality differences without changing the roster", () => {
  const bounds = { north: 75, south: 25, west: -140, east: -60 };
  const cols = 101;
  const rows = 81;
  let y = 0;
  let closest = Number.POSITIVE_INFINITY;
  for (let row = 0; row < rows; row += 1) {
    const delta = Math.abs(rowToLatMercator(row, rows, bounds) - 70);
    if (delta < closest) {
      closest = delta;
      y = row;
    }
  }
  const x = 42;
  const strongerX = x + 5;
  const values = new Float32Array(cols * rows).fill(1013);
  values[y * cols + x] = 1016;
  values[y * cols + strongerX] = 1017;
  const validation = _testCenterValidation.validateCenterCandidateRowAware({
    values,
    width: cols,
    height: rows,
    bounds,
    candidate: { kind: "high", x, y, value: 1016 },
    prominenceThreshold: 1.8,
  });
  const lon = bounds.west + (x / (cols - 1)) * (bounds.east - bounds.west);
  const strongerLon = bounds.west + (strongerX / (cols - 1)) * (bounds.east - bounds.west);
  const lat = rowToLatMercator(y, rows, bounds);
  assert.ok(_testCenterValidation.greatCircleDistanceKm(lat, lon, lat, strongerLon) < 200);
  assert.equal(validation.localExtremum, false);
  assert.equal(validation.passesAllChecks, false);
  assert.equal(validation.diagnosticOnly, true);
  assert.equal(validation.localCoverageMeets60Pct, true);
  assert.ok(validation.localCoverageFraction >= 0.6);

  const edgeValues = new Float32Array(cols * rows).fill(1013);
  edgeValues[x] = 1016;
  const edgeValidation = _testCenterValidation.validateCenterCandidateRowAware({
    values: edgeValues,
    width: cols,
    height: rows,
    bounds,
    candidate: { kind: "high", x, y: 0, value: 1016 },
    prominenceThreshold: 1.8,
  });
  assert.equal(edgeValidation.localCoverageMeets60Pct, false);
  assert.ok(edgeValidation.localCoverageFraction < 0.6);
  assert.equal(edgeValidation.passesAllChecks, false, "edge coverage is part of the diagnostic aggregate");

  const style = loadSynopticStyle();
  const field = buildGaussianField(FINE.cols, FINE.rows, SYSTEMS);
  const spacingKm = _testCenterDetection.estimateGridSpacingKm(BOUNDS, FINE.cols, FINE.rows);
  const ordinary = _testCenterDetection.detectPressureCenters(field, FINE.cols, FINE.rows, style, null, spacingKm);
  const diagnosed = _testCenterDetection.detectPressureCenters(field, FINE.cols, FINE.rows, style, null, spacingKm, {
    mode: "row-aware-diagnostic",
    bounds: BOUNDS,
  });
  const stripDiagnostic = (center) => {
    const { rowAwareValidation, ...rest } = center;
    return rest;
  };
  assert.deepEqual(diagnosed.map(stripDiagnostic), ordinary, "diagnostic mode must not reject or reprioritize centers");
  assert.ok(diagnosed.every((center) => center.rowAwareValidation?.diagnosticOnly === true));
});

function colToLon(x, cols) {
  return BOUNDS.west + (x / (cols - 1)) * (BOUNDS.east - BOUNDS.west);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Analytic field: background plus great-circle Gaussians (amp<0 -> low).
function buildGaussianField(cols, rows, systems) {
  const values = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y += 1) {
    const lat = rowToLatMercator(y, rows, BOUNDS);
    for (let x = 0; x < cols; x += 1) {
      const lon = colToLon(x, cols);
      let value = BACKGROUND;
      for (const system of systems) {
        const d = haversineKm(lat, lon, system.lat, system.lon);
        value += system.amp * Math.exp(-(d * d) / (2 * system.sigmaKm * system.sigmaKm));
      }
      values[y * cols + x] = value;
    }
  }
  return values;
}

function detectLows(grid) {
  const { detectPressureCenters, estimateGridSpacingKm } = _testCenterDetection;
  const spacingKm = estimateGridSpacingKm(BOUNDS, grid.cols, grid.rows);
  const centers = detectPressureCenters(
    buildGaussianField(grid.cols, grid.rows, SYSTEMS),
    grid.cols,
    grid.rows,
    loadSynopticStyle(),
    null,
    spacingKm,
  );
  return centers
    .filter((center) => center.kind === "low")
    .map((center) => ({
      ...center,
      lat: rowToLatMercator(center.y, grid.rows, BOUNDS),
      lon: colToLon(center.x, grid.cols),
    }));
}

function distanceToKm(low, system) {
  return haversineKm(low.lat, low.lon, system.lat, system.lon);
}

test("coarse and fine grids agree on the low roster: 350 km pair merges, 900 km system stays distinct", () => {
  const coarseLows = detectLows(COARSE);
  const fineLows = detectLows(FINE);

  assert.equal(
    coarseLows.length,
    fineLows.length,
    `coarse grid found ${coarseLows.length} lows, fine grid ${fineLows.length} — km gating must make them agree`,
  );
  // The A/B pair (350 km apart) collapses to one system under the 450 km
  // same-kind minimum; C (900 km from B, 1250 km from A) stays its own system.
  assert.equal(coarseLows.length, 2, `expected pair-merged A/B plus distinct C, got ${coarseLows.length} lows`);

  for (const lows of [coarseLows, fineLows]) {
    const nearPair = lows.filter((low) => distanceToKm(low, LOW_A) <= 400 || distanceToKm(low, LOW_B) <= 400);
    const nearC = lows.filter((low) => distanceToKm(low, LOW_C) <= 300);
    assert.equal(nearPair.length, 1, `expected exactly one low on the A/B pair, got ${nearPair.length}`);
    assert.equal(nearC.length, 1, `expected exactly one low at C, got ${nearC.length}`);
  }
});

test("a 1.2 hPa dimple below the prominence threshold is rejected on both grids", () => {
  for (const grid of [COARSE, FINE]) {
    const lows = detectLows(grid);
    for (const low of lows) {
      assert.ok(
        distanceToKm(low, DIMPLE) > 300,
        `${grid.cols}x${grid.rows} grid marked the sub-prominence dimple as a low (${distanceToKm(low, DIMPLE).toFixed(0)} km away)`,
      );
    }
  }
});

// ── Met-review fix 1: strict-extremum locality + synoptic-scale roster merit ──
// Real failing case (NAM 20260710-00Z f003): the 1007 hPa New England low has
// genuine ~2.2 hPa closure, but a deeper cell of the SEPARATE Quebec trough
// sits ~390 km north — inside a 400 km strict-extremum disc — so the low never
// became a candidate on the detailed grid. The strict-extremum disc tests
// LOCALITY only (~200 km); multi-system separation is curation's job (450 km
// same-kind minimum). Roster RANKING, in turn, must weigh synoptic-scale
// merit: mesoscale terrain-reduction bullseyes carry large raw prominence but
// collapse on a ~120 km-smoothed field, while real broad systems survive.

test("real NAM f003 crop: the New England low is detected on the detailed grid", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { renderSynopticArtifacts } = require("../scripts/lib/synoptic-render.js");
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "mslp-detailed.nam-20260710-0000Z-f003-ne.json"), "utf8"),
  );
  const values = Float32Array.from(fixture.values.map((v) => (v === null ? NaN : v)));
  const result = renderSynopticArtifacts({
    pressureGrid: { values, cols: fixture.cols, rows: fixture.rows },
    thicknessGrid: null,
    targetBounds: fixture.bounds,
    width: 1100,
    height: 1110,
    modelKey: "nam",
    detailMode: "detailed",
    drawImage: false,
  });
  // Simple-mode marker position for this system: L 1007 at 43.62,-70.35.
  const near = result.centers.lows.filter((low) => haversineKm(low.lat, low.lon, 43.62, -70.35) <= 100);
  assert.equal(
    near.length,
    1,
    `expected the New England low within 100 km of 43.62,-70.35; lows: ${result.centers.lows
      .map((low) => `${low.valueHpa}@${low.lat.toFixed(1)},${low.lon.toFixed(1)}`)
      .join(" ")}`,
  );
  assert.ok(Math.abs(near[0].valueHpa - 1007) <= 1, `NE low value ${near[0].valueHpa} != ~1007`);
});

test("roster ranking prefers broad synoptic systems over mesoscale terrain bullseyes", () => {
  const { detectPressureCenters, estimateGridSpacingKm } = _testCenterDetection;
  // Anchor high (tallest -> owns the injected global max), a narrow terrain
  // bullseye with big RAW prominence, and a modest broad synoptic high.
  const anchor = { lat: 44, lon: -76, amp: 5, sigmaKm: 300 };
  const bullseye = { lat: 41, lon: -112, amp: 4, sigmaKm: 50 };
  const broad = { lat: 33, lon: -95, amp: 3.5, sigmaKm: 300 };
  const values = buildGaussianField(FINE.cols, FINE.rows, [anchor, bullseye, broad]);
  const spacingKm = estimateGridSpacingKm(BOUNDS, FINE.cols, FINE.rows);
  const highs = detectPressureCenters(values, FINE.cols, FINE.rows, loadSynopticStyle(), null, spacingKm).filter(
    (center) => center.kind === "high",
  );
  const indexNear = (system) =>
    highs.findIndex(
      (center) =>
        haversineKm(
          rowToLatMercator(center.y, FINE.rows, BOUNDS),
          colToLon(center.x, FINE.cols),
          system.lat,
          system.lon,
        ) <= 200,
    );
  const bullseyeIndex = indexNear(bullseye);
  const broadIndex = indexNear(broad);
  // Detection gate unchanged: the bullseye still passes 1.8 hPa over 300-500 km.
  assert.ok(bullseyeIndex >= 0, "bullseye must still pass the raw detection gate");
  assert.ok(broadIndex >= 0, "broad system must be detected");
  // Ranking (and therefore the 12-marker cap) must order by synoptic merit.
  assert.ok(
    broadIndex < bullseyeIndex,
    `broad system (index ${broadIndex}) must outrank the terrain bullseye (index ${bullseyeIndex})`,
  );
});

// ── S2 fix round: strided disc must keep the ±1 ring ──────────────────────────
// With stride >= 2 a pure stride lattice contains no offset with |dx| or |dy|
// == 1, so a cell ADJACENT to the true extremum saw only far samples and
// passed the strict-extremum test — false-positive candidates beside every
// real center. The disc must always retain the eight ±1 offsets, making the
// strict-extremum property stride-independent.

test("strided disc unconditionally retains the ±1 adjacent ring", () => {
  const disc = _testCenterDetection.offsetsWithinRadius(13, true, 3);
  for (const [dx, dy] of [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ]) {
    assert.ok(
      disc.some((offset) => offset.dx === dx && offset.dy === dy),
      `strided disc must retain ±1 offset (${dx},${dy})`,
    );
  }
  // Outside the ring the stride lattice applies: (2,0) skipped, (3,0) kept.
  assert.ok(!disc.some((offset) => offset.dx === 2 && offset.dy === 0));
  assert.ok(disc.some((offset) => offset.dx === 3 && offset.dy === 0));
});

test("near-edge peak is detected AT its apex; adjacent cells stay rejected under stride", () => {
  const { detectPressureCenters } = _testCenterDetection;
  const cols = 200;
  const rows = 80;
  const spacingKm = 16; // detailed-grid scale: radius round(200/16) = 13, stride 3
  const radius = 13;
  // Peak P1's apex sits one row inside the old full-disc scan inset
  // (y = radius - 1): pre-fix it was never scanned and produced no marker at
  // all; with partial-disc scanning the apex is admitted (quorum holds — only
  // the dy = -13 disc column is clipped) and the retained ±1 ring still
  // rejects every apex-adjacent cell, so the marker lands exactly ON the
  // apex. Taller peak P2 owns the injected global maximum, keeping the
  // injection away from P1.
  const P1 = { x: 60, y: radius - 1, amp: 10 };
  const P2 = { x: 160, y: 40, amp: 15 };
  const values = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const d1Sq = (x - P1.x) ** 2 + (y - P1.y) ** 2;
      const d2Sq = (x - P2.x) ** 2 + (y - P2.y) ** 2;
      values[y * cols + x] = 1010 + P1.amp * Math.exp(-d1Sq / (2 * 8 ** 2)) + P2.amp * Math.exp(-d2Sq / (2 * 8 ** 2));
    }
  }
  const apex = values[P1.y * cols + P1.x];
  const adjacent = values[(P1.y + 1) * cols + P1.x];
  assert.ok(apex - adjacent > 0.03, `fixture too flat: apex-adjacent gap ${(apex - adjacent).toFixed(4)}`);

  const centers = detectPressureCenters(values, cols, rows, loadSynopticStyle(), null, spacingKm);
  const nearP1 = centers.filter(
    (center) => center.kind === "high" && Math.hypot(center.x - P1.x, center.y - P1.y) <= 6,
  );
  assert.equal(nearP1.length, 1, `expected exactly one high at P1, got ${nearP1.length}`);
  assert.ok(
    nearP1[0].x === P1.x && nearP1[0].y === P1.y,
    `marker must sit ON the apex (got ${nearP1[0]?.x},${nearP1[0]?.y}; the ±1 ring rejects neighbors)`,
  );
  assert.ok(
    centers.some((center) => center.kind === "high" && Math.hypot(center.x - P2.x, center.y - P2.y) <= 2),
    "true extremum P2 must still be detected",
  );
});

// ── Met-review fix 2: partial-disc detection near domain edges ────────────────
// The km-based disc grew the fine-grid scan inset to ~radius cells, so
// landfalling/offshore systems got no marker until their core crossed the
// inset and popped into existence mid-animation; only the single global
// extremum was margin-injected. Cells whose full ±1 ring is in-domain are now
// scanned with whatever disc samples exist, gated by a >=60% finite-sample
// quorum (plus the existing ringCount >= 8 annulus floor).

test("a secondary low ~175 km inside the west edge is detected on the fine grid", () => {
  const { detectPressureCenters, estimateGridSpacingKm } = _testCenterDetection;
  // Primary low owns the injected global minimum; the shallower secondary low
  // near the edge must be found by DETECTION (injection cannot rescue it).
  const primary = { lat: 40, lon: -100, amp: -14, sigmaKm: 300 };
  const secondary = { lat: 37, lon: -129 + 175 / (111 * Math.cos((37 * Math.PI) / 180)), amp: -8, sigmaKm: 200 };
  const values = buildGaussianField(FINE.cols, FINE.rows, [primary, secondary]);
  const spacingKm = estimateGridSpacingKm(BOUNDS, FINE.cols, FINE.rows);
  const lows = detectPressureCenters(values, FINE.cols, FINE.rows, loadSynopticStyle(), null, spacingKm).filter(
    (center) => center.kind === "low",
  );
  const nearSecondary = lows.filter(
    (low) =>
      haversineKm(
        rowToLatMercator(low.y, FINE.rows, BOUNDS),
        colToLon(low.x, FINE.cols),
        secondary.lat,
        secondary.lon,
      ) <= 100,
  );
  assert.equal(nearSecondary.length, 1, `expected the near-edge secondary low, got ${nearSecondary.length}`);
});

test("a boundary-hugging ridge cell at the literal edge row is not admitted", () => {
  const { detectPressureCenters, estimateGridSpacingKm } = _testCenterDetection;
  // Flat field with a one-cell +6 hPa spike ON the edge row: the spike cell
  // has no full ±1 ring (never scanned) and its in-domain neighbors see the
  // spike above them, so nothing near it may become a high.
  const values = new Float32Array(FINE.cols * FINE.rows).fill(1013);
  const spike = { x: 100, y: 0 };
  values[spike.y * FINE.cols + spike.x] = 1019;
  const spacingKm = estimateGridSpacingKm(BOUNDS, FINE.cols, FINE.rows);
  const highs = detectPressureCenters(values, FINE.cols, FINE.rows, loadSynopticStyle(), null, spacingKm).filter(
    (center) => center.kind === "high",
  );
  for (const high of highs) {
    assert.ok(
      Math.hypot(high.x - spike.x, high.y - spike.y) > 5,
      `edge-row spike must not produce a high (got one at ${high.x},${high.y})`,
    );
  }
});

// ── Task S4 (map QA update set §6c): honest simple-mode smoothing ─────────────
// On the ~250 km simple grid every per-model sigma (30-60 km) lands far below
// the 0.6-cell kernel floor: the policy is inert, yet the floor-clamped
// Gaussian still ran — silent extra smoothing the style never asked for. When
// the raw sigma is sub-floor the field must pass through untouched (the 64x
// downsample has already low-passed far beyond the policy); at or above the
// floor the kernel must still run.

test("sub-floor sigma skips the Gaussian entirely; meaningful sigma still smooths", () => {
  const { smoothPressureField, smoothHeightContourField } = _testSmoothing;
  const style = loadSynopticStyle();

  // ~250 km cells, gfs sigma 60 km -> 0.24 cells: policy inert, pass-through.
  const coarseValues = buildGaussianField(COARSE.cols, COARSE.rows, SYSTEMS);
  assert.equal(
    smoothPressureField(coarseValues, COARSE.cols, COARSE.rows, BOUNDS, "gfs", style),
    coarseValues,
    "sub-floor sigma must return the input field unchanged (same reference)",
  );
  assert.equal(
    smoothHeightContourField(coarseValues, COARSE.cols, COARSE.rows, BOUNDS, "gfs", style),
    coarseValues,
    "height smoothing must take the same sub-floor skip",
  );

  // ~30 km cells, gfs sigma 60 km -> 2.0 cells: the kernel must still run.
  const fineValues = buildGaussianField(FINE.cols, FINE.rows, SYSTEMS);
  const smoothed = smoothPressureField(fineValues, FINE.cols, FINE.rows, BOUNDS, "gfs", style);
  assert.notEqual(smoothed, fineValues, "above-floor sigma must produce a new smoothed field");
  const changed = smoothed.some((value, index) => Math.abs(value - fineValues[index]) > 1e-3);
  assert.ok(changed, "above-floor smoothing should actually move values");
});
