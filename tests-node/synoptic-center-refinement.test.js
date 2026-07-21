"use strict";

// Task 4.5 (owner-blessed renderer accuracy change, spec §8a.6): H/L pressure
// centers are DETECTED on the smoothed prepared grid but REFINED — position and
// value — against the full-resolution display MSLP field. These tests drive the
// pipeline with analytic Gaussian systems whose true extremum is known exactly,
// pin the legacy downsample bias the fix removes, and cover dedupe-after-
// refinement, rounding-at-emit, and degenerate fields. The companion manifest
// test pins the empty-`synopticCenters` stomp fix (split snow renders must not
// clear fields they did not produce).

const assert = require("node:assert/strict");
const test = require("node:test");
const { renderSynopticArtifacts, _testCenterRefinement } = require("../scripts/lib/synoptic-render.js");
const { _testSynchronizeSynopticArtifactCenters } = require("../scripts/lib/noaa-beta-renderer.js");
const { rowToLatMercator } = require("../scripts/lib/mercator.js");
const { applyRenderedFrameToManifestFrame } = require("../scripts/lib/local-artifact-manifest.js");
const { serializeFrameArtifacts } = require("../scripts/noaa-beta-frame-worker.js");

// CONUS view geometry (scripts/lib/modelview-runtime.js) at a reduced-but-
// production-shaped resolution: fine 1024x640 display grid; the "simple"
// detection grid derived from it is 18x10 (resolveSimpleGridSize floor), the
// synthetic "detailed" grid is 256x160.
const BOUNDS = Object.freeze({ north: 53, south: 21, west: -129, east: -63 });
const FINE_COLS = 1024;
const FINE_ROWS = 640;
const SIMPLE_COLS = 18;
const SIMPLE_ROWS = 10;
const DETAIL_COLS = 256;
const DETAIL_ROWS = 160;
const MODEL_KEY = "nam3km"; // 30 km detection smoothing sigma in shared style

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
function buildGaussianField(cols, rows, background, systems) {
  const values = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y += 1) {
    const lat = rowToLatMercator(y, rows, BOUNDS);
    for (let x = 0; x < cols; x += 1) {
      const lon = colToLon(x, cols);
      let value = background;
      for (const system of systems) {
        const d = haversineKm(lat, lon, system.lat, system.lon);
        value += system.amp * Math.exp(-(d * d) / (2 * system.sigmaKm * system.sigmaKm));
      }
      values[y * cols + x] = value;
    }
  }
  return values;
}

function analyticValue(lat, lon, background, systems) {
  let value = background;
  for (const system of systems) {
    const d = haversineKm(lat, lon, system.lat, system.lon);
    value += system.amp * Math.exp(-(d * d) / (2 * system.sigmaKm * system.sigmaKm));
  }
  return value;
}

// Most extreme value any node of a coarse grid can carry for the analytic
// field (bilinear downsampling of a smooth field samples ~the node positions).
function coarseNodeExtremum(cols, rows, background, systems, kind) {
  let best = null;
  for (let y = 0; y < rows; y += 1) {
    const lat = rowToLatMercator(y, rows, BOUNDS);
    for (let x = 0; x < cols; x += 1) {
      const value = analyticValue(lat, colToLon(x, cols), background, systems);
      if (best === null || (kind === "low" ? value < best : value > best)) {
        best = value;
      }
    }
  }
  return best;
}

function renderSimple(fineValues, overrides = {}) {
  return renderSynopticArtifacts({
    pressureGrid: { values: fineValues, cols: FINE_COLS, rows: FINE_ROWS },
    thicknessGrid: null,
    targetBounds: BOUNDS,
    width: FINE_COLS,
    height: FINE_ROWS,
    modelKey: MODEL_KEY,
    detailMode: "simple",
    drawImage: false,
    ...overrides,
  });
}

function renderDetailed(detailValues, overrides = {}) {
  return renderSynopticArtifacts({
    pressureGrid: { values: detailValues, cols: DETAIL_COLS, rows: DETAIL_ROWS },
    thicknessGrid: null,
    targetBounds: BOUNDS,
    width: FINE_COLS,
    height: FINE_ROWS,
    modelKey: MODEL_KEY,
    detailMode: "detailed",
    drawImage: false,
    ...overrides,
  });
}

// ── Simple path: full-resolution refinement recovers the downsample bias ─────

// One broad low and one broad high, each centered mid-cell of the 18x10
// detection grid (worst-case node quantization).
const SIMPLE_LOW = { lat: rowToLatMercator(4.5, SIMPLE_ROWS, BOUNDS), lon: -96, amp: -20, sigmaKm: 250 };
const SIMPLE_HIGH = {
  lat: rowToLatMercator(4.5, SIMPLE_ROWS, BOUNDS),
  lon: BOUNDS.west + (13.5 / (SIMPLE_COLS - 1)) * (BOUNDS.east - BOUNDS.west),
  amp: 17.6,
  sigmaKm: 250,
};
const SIMPLE_BG = 1020;
const SIMPLE_SYSTEMS = [SIMPLE_LOW, SIMPLE_HIGH];

test("simple-mode centers refine to the full-resolution extremum (value and position)", () => {
  const fine = buildGaussianField(FINE_COLS, FINE_ROWS, SIMPLE_BG, SIMPLE_SYSTEMS);
  const result = renderSimple(fine);

  assert.equal(result.centers.lows.length, 1, "exactly one low expected");
  assert.equal(result.centers.highs.length, 1, "exactly one high expected");
  const low = result.centers.lows[0];
  const high = result.centers.highs[0];

  // True extrema: 1000.0 low core, 1037.6 high core (raw pixel within ~3 km of
  // the analytic center, value error << 0.1 hPa). Rounded only at emit.
  assert.equal(low.valueHpa, 1000, `low value ${low.valueHpa} != true core 1000`);
  assert.equal(high.valueHpa, 1038, `high value ${high.valueHpa} != round(1037.6)`);
  assert.ok(Number.isFinite(low.prominenceHpa) && low.prominenceHpa > 0, "low quality must be finite");
  assert.ok(Number.isFinite(high.prominenceHpa) && high.prominenceHpa > 0, "high quality must be finite");
  assert.equal(result.vector.method.methodVersion, "synoptic-mslp-thickness-automated-centers-v3");
  assert.deepEqual(result.vector.method.isobars, {
    minorIntervalHpa: 4,
    majorIntervalHpa: 8,
    presentationSmoothing: "model-dependent Gaussian smoothing",
  });
  assert.equal(result.vector.method.thickness.minorIntervalDam, 6);
  assert.equal(result.vector.method.thickness.majorIntervalDam, 12);
  assert.equal(result.vector.method.thickness.emphasisDam, 540);
  assert.match(result.vector.method.thickness.emphasisRole, /not a deterministic/i);
  assert.equal(result.vector.method.centers.maxPerKind, 12);
  assert.equal(result.vector.method.centers.detailInvariant, true);
  assert.equal(result.vector.method.centers.analysisGridTargetSpacingKm, 50);
  assert.deepEqual(result.vector.method.centers.analysisGridMaxShape, [80, 128]);
  assert.match(result.vector.method.centers.classification, /automated model-guidance/i);

  const lowErrKm = haversineKm(low.lat, low.lon, SIMPLE_LOW.lat, SIMPLE_LOW.lon);
  const highErrKm = haversineKm(high.lat, high.lon, SIMPLE_HIGH.lat, SIMPLE_HIGH.lon);
  assert.ok(lowErrKm <= 15, `low position error ${lowErrKm.toFixed(1)} km > 15 km`);
  assert.ok(highErrKm <= 15, `high position error ${highErrKm.toFixed(1)} km > 15 km`);
});

test("opt-in row-aware validation is disclosed and serialized per marker without becoming a rejection gate", () => {
  const fineValues = buildGaussianField(FINE_COLS, FINE_ROWS, 1015, [SIMPLE_LOW, SIMPLE_HIGH]);
  const result = renderSimple(fineValues, { centerValidationMode: "row-aware-diagnostic" });
  const validationMethod = result.vector.method.centers.rowAwareValidation;
  assert.equal(validationMethod.methodVersion, "row-aware-center-validation-diagnostic-v1");
  assert.equal(validationMethod.mode, "diagnostic-only");
  assert.equal(validationMethod.effectOnRoster, "none");
  assert.equal(validationMethod.rosterDistanceEvaluation, "final refined and deduplicated emitted marker roster");
  const centers = [...result.centers.highs, ...result.centers.lows];
  assert.equal(centers.length, 2);
  for (const center of centers) {
    assert.equal(center.rowAwareValidation.methodVersion, validationMethod.methodVersion);
    assert.equal(center.rowAwareValidation.diagnosticOnly, true);
    assert.equal(center.rowAwareValidation.rosterEvaluatedAt, "final refined emitted roster");
    assert.equal(typeof center.rowAwareValidation.rosterSeparationPass, "boolean");
    assert.equal(typeof center.rowAwareValidation.passesAllChecks, "boolean");
    assert.ok(center.rowAwareValidation.finiteLocalSamples > 0);
    assert.ok(center.rowAwareValidation.finiteAnnulusSamples >= 8);
  }
});

test("simple-mode refinement recovers value no coarse detection node carries (legacy bias pin)", () => {
  const fine = buildGaussianField(FINE_COLS, FINE_ROWS, SIMPLE_BG, SIMPLE_SYSTEMS);
  const result = renderSimple(fine);

  // The legacy pipeline emitted the best 18x10 node value. Mid-cell cores sit
  // ~a half-cell diagonal (~260 km) from every node, so the coarse grid is
  // biased several hPa less extreme — the bias the owner reported.
  const coarseLowBound = coarseNodeExtremum(SIMPLE_COLS, SIMPLE_ROWS, SIMPLE_BG, SIMPLE_SYSTEMS, "low");
  const coarseHighBound = coarseNodeExtremum(SIMPLE_COLS, SIMPLE_ROWS, SIMPLE_BG, SIMPLE_SYSTEMS, "high");
  assert.ok(coarseLowBound - 1000 > 4, `expected >4 hPa legacy low bias, got ${(coarseLowBound - 1000).toFixed(2)}`);
  assert.ok(
    1037.6 - coarseHighBound > 4,
    `expected >4 hPa legacy high bias, got ${(1037.6 - coarseHighBound).toFixed(2)}`,
  );

  const low = result.centers.lows[0];
  const high = result.centers.highs[0];
  assert.ok(
    low.valueHpa < coarseLowBound - 3,
    `refined low ${low.valueHpa} did not beat coarse bound ${coarseLowBound}`,
  );
  assert.ok(
    high.valueHpa > coarseHighBound + 3,
    `refined high ${high.valueHpa} did not beat coarse bound ${coarseHighBound}`,
  );
});

// ── Detailed path: same treatment; without the full grid the bias reproduces ─

// Narrow low centered mid-cell of the 256x160 detailed grid: the detail-grid
// resample alone loses ~2 hPa of depth (the investigation's dominant detailed
// mechanism).
const DETAIL_LOW = { lat: rowToLatMercator(80.5, DETAIL_ROWS, BOUNDS), lon: -96, amp: -16, sigmaKm: 30 };
const DETAIL_BG = 1016;

test("detailed-mode centers: legacy bias without refinement grid, true core with it", () => {
  const fine = buildGaussianField(FINE_COLS, FINE_ROWS, DETAIL_BG, [DETAIL_LOW]);
  const detail = buildGaussianField(DETAIL_COLS, DETAIL_ROWS, DETAIL_BG, [DETAIL_LOW]);

  // A: no full-resolution grid supplied — values are grid-bound, the refined
  // value cannot beat the best detail node (>=2 hPa less deep than truth).
  const legacy = renderDetailed(detail);
  assert.equal(legacy.centers.lows.length, 1);
  assert.ok(
    legacy.centers.lows[0].valueHpa >= 1002,
    `unrefined detailed low ${legacy.centers.lows[0].valueHpa} should carry the >=2 hPa resample bias`,
  );

  // B: with the display-resolution field the true 1000.0 core is recovered.
  const refined = renderDetailed(detail, {
    refinementPressureGrid: { values: fine, cols: FINE_COLS, rows: FINE_ROWS },
  });
  assert.equal(refined.centers.lows.length, 1);
  const low = refined.centers.lows[0];
  assert.equal(low.valueHpa, 1000, `refined detailed low ${low.valueHpa} != true core 1000`);
  const errKm = haversineKm(low.lat, low.lon, DETAIL_LOW.lat, DETAIL_LOW.lon);
  assert.ok(errKm <= 15, `detailed position error ${errKm.toFixed(1)} km > 15 km`);
});

test("simple and detailed modes agree on refined centers for the same field", () => {
  const fine = buildGaussianField(FINE_COLS, FINE_ROWS, SIMPLE_BG, SIMPLE_SYSTEMS);
  const detail = buildGaussianField(DETAIL_COLS, DETAIL_ROWS, SIMPLE_BG, SIMPLE_SYSTEMS);

  const simple = renderSimple(fine);
  const detailed = renderDetailed(detail, {
    refinementPressureGrid: { values: fine, cols: FINE_COLS, rows: FINE_ROWS },
  });

  assert.equal(simple.centers.lows.length, 1);
  assert.equal(detailed.centers.lows.length, 1);
  assert.equal(simple.centers.lows[0].valueHpa, detailed.centers.lows[0].valueHpa);
  const dKm = haversineKm(
    simple.centers.lows[0].lat,
    simple.centers.lows[0].lon,
    detailed.centers.lows[0].lat,
    detailed.centers.lows[0].lon,
  );
  assert.ok(dKm <= 25, `simple/detailed refined lows disagree by ${dKm.toFixed(1)} km`);
});

test("frame artifacts use one exact H/L roster in simple and detailed modes", () => {
  const canonical = {
    highs: [{ lat: 41, lon: -107, valueHpa: 1028, prominenceHpa: 4.1 }],
    lows: [],
  };
  const simple = { centers: canonical, vector: { centers: canonical } };
  const detailed = {
    centers: { highs: [], lows: [{ lat: 39, lon: -94, valueHpa: 998, prominenceHpa: 5.2 }] },
    vector: { centers: { highs: [], lows: [] } },
  };

  const synchronized = _testSynchronizeSynopticArtifactCenters(canonical, [simple, detailed]);
  assert.deepEqual(synchronized, canonical);
  assert.strictEqual(simple.centers, synchronized);
  assert.strictEqual(simple.vector.centers, synchronized);
  assert.strictEqual(detailed.centers, synchronized);
  assert.strictEqual(detailed.vector.centers, synchronized);
});

// ── Rounding at emit ──────────────────────────────────────────────────────────

test("center values round (not truncate) at emit only", () => {
  // Core exactly on a fine pixel: raw minimum is exactly 1000.6.
  const system = {
    lat: rowToLatMercator(320, FINE_ROWS, BOUNDS),
    lon: colToLon(512, FINE_COLS),
    amp: -19.4,
    sigmaKm: 250,
  };
  const fine = buildGaussianField(FINE_COLS, FINE_ROWS, SIMPLE_BG, [system]);
  const result = renderSimple(fine);
  assert.equal(result.centers.lows.length, 1);
  assert.equal(result.centers.lows[0].valueHpa, 1001, "1000.6 must round to 1001, not truncate to 1000");
});

// ── Dedupe after refinement ──────────────────────────────────────────────────

test("candidates refining onto the same extremum collapse to one center", () => {
  assert.ok(_testCenterRefinement, "synoptic-render must export _testCenterRefinement for these tests");
  const { buildCenterRefinementContext, refineCenterAgainstField, dedupeRefinedCenters } = _testCenterRefinement;

  const fine = buildGaussianField(FINE_COLS, FINE_ROWS, SIMPLE_BG, [SIMPLE_LOW]);
  const context = buildCenterRefinementContext({
    grid: { values: fine, cols: FINE_COLS, rows: FINE_ROWS },
    bounds: BOUNDS,
    modelKey: MODEL_KEY,
    detectionCols: SIMPLE_COLS,
    detectionRows: SIMPLE_ROWS,
  });
  assert.ok(context, "refinement context expected for a finite grid");

  // Two detection-grid candidates flanking the same low.
  const a = { kind: "low", x: 8, y: 4, value: 1008, prominence: 9, score: 12 };
  const b = { kind: "low", x: 9, y: 5, value: 1009, prominence: 8, score: 10 };
  const refinedA = refineCenterAgainstField(a, context, "low");
  const refinedB = refineCenterAgainstField(b, context, "low");

  const latA = rowToLatMercator((refinedA.y / (SIMPLE_ROWS - 1)) * (FINE_ROWS - 1), FINE_ROWS, BOUNDS);
  const latB = rowToLatMercator((refinedB.y / (SIMPLE_ROWS - 1)) * (FINE_ROWS - 1), FINE_ROWS, BOUNDS);
  const lonA = colToLon((refinedA.x / (SIMPLE_COLS - 1)) * (FINE_COLS - 1), FINE_COLS);
  const lonB = colToLon((refinedB.x / (SIMPLE_COLS - 1)) * (FINE_COLS - 1), FINE_COLS);
  const separationKm = haversineKm(latA, lonA, latB, lonB);
  assert.ok(separationKm <= 20, `both candidates should land on the shared core, got ${separationKm.toFixed(1)} km`);

  const deduped = dedupeRefinedCenters([refinedA, refinedB], context);
  assert.equal(deduped.length, 1, "same-extremum candidates must dedupe to one center");
  assert.equal(deduped[0].score, 12, "dedupe keeps the higher-scored candidate");
});

// ── Degenerate fields ────────────────────────────────────────────────────────

test("degenerate fields do not crash and emit no false refined centers", () => {
  // Null / missing grid.
  const emptyResult = renderSimple(null, { pressureGrid: null });
  assert.deepEqual(emptyResult.centers, { highs: [], lows: [] });

  // All-NaN grid.
  const nanValues = new Float32Array(FINE_COLS * FINE_ROWS).fill(Number.NaN);
  const nanResult = renderSimple(nanValues);
  assert.deepEqual(nanResult.centers, { highs: [], lows: [] });

  // Uniform and monotonic fields have no closed pressure center. A domain-wide
  // global min/max is not sufficient evidence for an H/L marker.
  const flat = new Float32Array(FINE_COLS * FINE_ROWS).fill(1013);
  const flatResult = renderSimple(flat);
  assert.deepEqual(flatResult.centers, { highs: [], lows: [] });

  const monotonic = new Float32Array(FINE_COLS * FINE_ROWS);
  for (let y = 0; y < FINE_ROWS; y += 1) {
    for (let x = 0; x < FINE_COLS; x += 1) {
      monotonic[y * FINE_COLS + x] = 995 + x * 0.01 + y * 0.02;
    }
  }
  const monotonicResult = renderSimple(monotonic);
  assert.deepEqual(monotonicResult.centers, { highs: [], lows: [] });
});

test("seeds inside a no-data region rescue to the nearest real data before climbing", () => {
  // Native model domains can end inside the view (NAM3km SE Atlantic corner):
  // the downsampled detection grid extends into the no-data zone via partial
  // bilinear taps, so a detected/injected node can sit where the display field
  // is NaN. The refined marker must sit on real data at the field's edge
  // extremum, not report an extrapolated value at an undefined position.
  const { buildCenterRefinementContext, refineCenterAgainstField } = _testCenterRefinement;
  const fine = buildGaussianField(FINE_COLS, FINE_ROWS, SIMPLE_BG, [SIMPLE_HIGH]);
  // Mask everything east of the high's core: the true reachable maximum of the
  // remaining field is on the mask boundary column.
  const maskStartCol = Math.round((14 / (SIMPLE_COLS - 1)) * (FINE_COLS - 1));
  for (let y = 0; y < FINE_ROWS; y += 1) {
    for (let x = maskStartCol; x < FINE_COLS; x += 1) {
      fine[y * FINE_COLS + x] = Number.NaN;
    }
  }
  const context = buildCenterRefinementContext({
    grid: { values: fine, cols: FINE_COLS, rows: FINE_ROWS },
    bounds: BOUNDS,
    modelKey: MODEL_KEY,
    detectionCols: SIMPLE_COLS,
    detectionRows: SIMPLE_ROWS,
  });
  // Candidate seeded inside the NaN zone (detection column 15). Production
  // candidates now always carry finite prominence and score.
  const seeded = { kind: "high", x: 15, y: 4.5, value: 1030, prominence: 4, score: 6 };
  const refined = refineCenterAgainstField(seeded, context, "high");
  const refinedCol = Math.round((refined.x / (SIMPLE_COLS - 1)) * (FINE_COLS - 1));
  assert.ok(refinedCol < maskStartCol, `refined position must sit on real data (col ${refinedCol})`);
  const refinedRow = Math.round((refined.y / (SIMPLE_ROWS - 1)) * (FINE_ROWS - 1));
  const rawAtRefined = fine[refinedRow * FINE_COLS + refinedCol];
  assert.ok(Number.isFinite(rawAtRefined), "refined center must carry a hover-readable raw value");
  assert.ok(Math.abs(refined.value - rawAtRefined) < 1e-3, "value must come from the raw field at the position");
  // The reachable maximum sits on the boundary column at the high's latitude.
  let boundaryMax = -Infinity;
  for (let y = 0; y < FINE_ROWS; y += 1) {
    const v = fine[y * FINE_COLS + maskStartCol - 1];
    if (Number.isFinite(v) && v > boundaryMax) boundaryMax = v;
  }
  assert.ok(refined.value >= boundaryMax - 0.05, `refined ${refined.value} should reach boundary max ${boundaryMax}`);
});

test("refinement climbs around missing-data regions", () => {
  const fine = buildGaussianField(FINE_COLS, FINE_ROWS, SIMPLE_BG, [SIMPLE_LOW]);
  // NaN band along the northern edge (outside-domain style masking).
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < FINE_COLS; x += 1) {
      fine[y * FINE_COLS + x] = Number.NaN;
    }
  }
  const result = renderSimple(fine);
  assert.equal(result.centers.lows.length, 1);
  assert.equal(result.centers.lows[0].valueHpa, 1000);
});

// ── Task S5 (map QA update set §6d): model-honest refinement precision ───────
// The display grid bilinearly upsamples the model's native field, and display-
// resolution wiggles (interpolation/terrain-reduction ripple) are not physics.
// The climb pre-smooth must scale with the model's NATIVE grid spacing: a GFS
// (~27 km) center must not chase a ±0.05 hPa display-scale ripple away from
// the native-field minimum, while the 3 km nests keep the tuned 6 km
// pre-smooth the machinery was built around.

const NATIVE_COLS = 217; // ~27 km GFS-like native spacing over CONUS
const NATIVE_ROWS = 132;
const GFS_NATIVE_KM = 27;
const RIPPLE_LOW = { lat: 38.5, lon: -97.3, amp: -18, sigmaKm: 450 };
const RIPPLE_AMP_HPA = 0.05;
const RIPPLE_WAVELENGTH_PX = 10; // ~56 km at display resolution

function nativeArgminNode(native) {
  let best = { value: Infinity, x: 0, y: 0 };
  for (let y = 0; y < NATIVE_ROWS; y += 1) {
    for (let x = 0; x < NATIVE_COLS; x += 1) {
      const value = native[y * NATIVE_COLS + x];
      if (value < best.value) {
        best = { value, x, y };
      }
    }
  }
  return best;
}

// Bilinear upsample of the native field to display resolution plus a 1-D
// cosine ripple in x, phased so a trough column passes through troughPx.
function buildRippledDisplayGrid(native, troughPx) {
  const out = new Float32Array(FINE_COLS * FINE_ROWS);
  for (let y = 0; y < FINE_ROWS; y += 1) {
    const gy = (y / (FINE_ROWS - 1)) * (NATIVE_ROWS - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(NATIVE_ROWS - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < FINE_COLS; x += 1) {
      const gx = (x / (FINE_COLS - 1)) * (NATIVE_COLS - 1);
      const x0 = Math.floor(gx);
      const x1 = Math.min(NATIVE_COLS - 1, x0 + 1);
      const tx = gx - x0;
      const top = native[y0 * NATIVE_COLS + x0] * (1 - tx) + native[y0 * NATIVE_COLS + x1] * tx;
      const bottom = native[y1 * NATIVE_COLS + x0] * (1 - tx) + native[y1 * NATIVE_COLS + x1] * tx;
      out[y * FINE_COLS + x] =
        top * (1 - ty) + bottom * ty - RIPPLE_AMP_HPA * Math.cos((2 * Math.PI * (x - troughPx)) / RIPPLE_WAVELENGTH_PX);
    }
  }
  return out;
}

function refineRippledLow(modelKey) {
  const { buildCenterRefinementContext, refineCenterAgainstField } = _testCenterRefinement;
  const native = buildGaussianField(NATIVE_COLS, NATIVE_ROWS, SIMPLE_BG, [RIPPLE_LOW]);
  const nativeMin = nativeArgminNode(native);
  const minPxX = (nativeMin.x / (NATIVE_COLS - 1)) * (FINE_COLS - 1);
  const minPxY = (nativeMin.y / (NATIVE_ROWS - 1)) * (FINE_ROWS - 1);
  // Trough column ON the native minimum: the ripple cannot legitimately move
  // the answer, so any drift away from the node is pure ripple-chasing.
  const display = buildRippledDisplayGrid(native, minPxX);
  const context = buildCenterRefinementContext({
    grid: { values: display, cols: FINE_COLS, rows: FINE_ROWS },
    bounds: BOUNDS,
    modelKey,
    detectionCols: SIMPLE_COLS,
    detectionRows: SIMPLE_ROWS,
  });
  const seed = {
    kind: "low",
    x: Math.round((minPxX / (FINE_COLS - 1)) * (SIMPLE_COLS - 1)),
    y: Math.round((minPxY / (FINE_ROWS - 1)) * (SIMPLE_ROWS - 1)),
    value: nativeMin.value,
    prominence: 8,
    score: 10,
  };
  const refined = refineCenterAgainstField(seed, context, "low");
  const lat = rowToLatMercator((refined.y / (SIMPLE_ROWS - 1)) * (FINE_ROWS - 1), FINE_ROWS, BOUNDS);
  const lon = colToLon((refined.x / (SIMPLE_COLS - 1)) * (FINE_COLS - 1), FINE_COLS);
  const nativeMinLat = rowToLatMercator(nativeMin.y, NATIVE_ROWS, BOUNDS);
  const nativeMinLon = colToLon(nativeMin.x, NATIVE_COLS);
  return { errKm: haversineKm(lat, lon, nativeMinLat, nativeMinLon), context };
}

test("GFS refinement lands within one native cell of the coarse-field minimum, not on a ripple", () => {
  const { errKm } = refineRippledLow("gfs");
  assert.ok(
    errKm <= GFS_NATIVE_KM,
    `gfs refined center ${errKm.toFixed(1)} km from the native minimum — chased the display ripple`,
  );
});

test("pre-smooth scales with native spacing for GFS; nam3km keeps the tuned 6 km machinery", () => {
  const gfs = refineRippledLow("gfs").context;
  const nam3km = refineRippledLow("nam3km").context;
  // snapRadiusPx ≈ 2·presmooth-sigma-px pins the sigma actually applied:
  // gfs 13.5 km (native 27 / 2) -> 2.39 px -> snap 5; nam3km stays at the
  // 6 km artifact floor -> 1.06 px -> snap 2, exactly the pre-S5 behavior
  // (the rest of this suite runs nam3km end-to-end and must stay green).
  assert.equal(gfs.snapRadiusPx, 5, "gfs snap radius must follow the native-spacing pre-smooth");
  assert.equal(nam3km.snapRadiusPx, 2, "nam3km pre-smooth must stay at the tuned 6 km floor");
});

// ── Manifest: split-frame snow persist must not stomp synoptic fields ────────

test("applyRenderedFrameToManifestFrame preserves fields absent from a partial render", () => {
  const frame = {
    hour: 12,
    rows: 980,
    cols: 1600,
    synopticCenters: { highs: [{ lat: 41, lon: -107, valueHpa: 1028, prominenceHpa: 4.1 }], lows: [] },
    pressureUploadMeta: { source: "om-grid", fullResolutionInput: true },
    synopticVectorBytes: { simple: 10393, detailed: 101392 },
    layers: {},
  };
  // Shape of the snow render part (buildSnowRenderedArtifacts): no synoptic
  // fields at all — the historical stomp emptied 60/61 manifest frames.
  const snowRendered = {
    hour: 12,
    validHourKey: "2026-07-08T06:00:00Z",
    layers: {},
    hoverGridSupplemental: { snow: { key: "tiles/x/012/hover-grid-snow.bin.gz", bytes: 1234, schemaVersion: 4 } },
  };
  applyRenderedFrameToManifestFrame(frame, snowRendered);
  assert.equal(frame.synopticCenters.highs.length, 1, "snow part must not clear synopticCenters");
  assert.equal(frame.pressureUploadMeta.source, "om-grid", "snow part must not clear pressureUploadMeta");
  assert.deepEqual(frame.synopticVectorBytes, { simple: 10393, detailed: 101392 });

  // A render that does carry centers still overwrites.
  const fullRendered = {
    hour: 12,
    validHourKey: "2026-07-08T06:00:00Z",
    layers: {},
    synopticCenters: { highs: [], lows: [{ lat: 40, lon: -100, valueHpa: 999, prominenceHpa: 6 }] },
    pressureUploadMeta: { source: "om-grid", fullResolutionInput: true },
    synopticVectors: { simple: { centers: {} }, detailed: { centers: {} } },
  };
  applyRenderedFrameToManifestFrame(frame, fullRendered);
  assert.equal(frame.synopticCenters.lows.length, 1);
  assert.equal(frame.synopticCenters.highs.length, 0);
});

test("frame worker serialization passes synopticCenters absence through as null", () => {
  // The worker used to fabricate `{ highs: [], lows: [] }` for renders that
  // produced no centers (the snow part of a split frame), making the manifest
  // merge treat the empty object as authoritative and clear the base render's
  // centers on 60 of 61 frames of a full run.
  const snowShaped = serializeFrameArtifacts({
    hour: 12,
    validHourKey: "2026-07-08T06:00:00Z",
    layers: {},
  });
  assert.equal(snowShaped.frameArtifacts.synopticCenters, null);

  const fullShaped = serializeFrameArtifacts({
    hour: 12,
    validHourKey: "2026-07-08T06:00:00Z",
    layers: {},
    synopticCenters: { highs: [{ lat: 41, lon: -107, valueHpa: 1029, prominenceHpa: 4.1 }], lows: [] },
  });
  assert.equal(fullShaped.frameArtifacts.synopticCenters.highs.length, 1);
});
