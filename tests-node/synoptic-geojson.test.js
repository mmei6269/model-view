"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");
const { encodeVectorLine, decodeVectorLinePoints } = require("../scripts/lib/vector-encoding.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Real payloads snapshotted from the artifact cache (renderer output, not hand
// written): output/noaa-beta-cache/artifacts/tiles/nam3km/20260707-1800Z/conus/020/
//   synoptic-vector-simple.json  -> synoptic-vector-simple.nam3km-20260707-1800Z-f020.json
//   height500-contours.json      -> height500-contours.nam3km-20260707-1800Z-f020.json
// (styleVersion v4-operational-contrast; isobars at 4-hPa steps with
// mslp-major on 8-hPa multiples, thickness at 6-dam steps with thickness-major
// on 12-dam multiples, height-500 at 6-dam steps with height-500-major on
// 12-dam multiples.)
function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

const SYNOPTIC_FIXTURE = "synoptic-vector-simple.nam3km-20260707-1800Z-f020.json";
const HEIGHT_FIXTURE = "height500-contours.nam3km-20260707-1800Z-f020.json";

// ── Module under test ─────────────────────────────────────────────────────────
// The pure conversion module is TypeScript; bundle it (it pulls in the equally
// pure vector-encoding + synoptic style config) with esbuild and evaluate in a
// throwaway CJS context — the repo pattern for testing client TS from node
// (see render-category-client-parity.test.js).
function loadModule() {
  const entry = path.join(__dirname, "..", "next", "src", "components", "map-panel", "synoptic-geojson.ts");
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

const mod = loadModule();

function coords(feature) {
  return feature.geometry.coordinates;
}

// CONUS payload: every position must be [lon, lat] — lon deep negative,
// lat mid-positive; a [lat, lon] swap would put value 21..53 in slot 0.
function assertLonLatOrder(fc) {
  for (const feature of fc.features) {
    for (const position of coords(feature)) {
      assert.ok(position[0] >= -135 && position[0] <= -60, `lon out of range: ${position}`);
      assert.ok(position[1] >= 20 && position[1] <= 55, `lat out of range: ${position}`);
    }
  }
}

// ── Real-payload conversion: isobars ─────────────────────────────────────────

test("isobar features: count, kind, value/label, [lon,lat] order", () => {
  const payload = loadFixture(SYNOPTIC_FIXTURE);
  const { isobars } = mod.buildSynopticFeatureCollections(payload);

  // Fixture isobar lines are full polylines (no 2-point raw segments), so
  // stitching passes them through 1:1.
  assert.equal(isobars.type, "FeatureCollection");
  assert.equal(isobars.features.length, payload.isobars.lines.length);
  for (const feature of isobars.features) {
    assert.equal(feature.type, "Feature");
    assert.equal(feature.geometry.type, "LineString");
    assert.equal(feature.properties.kind, "isobar");
    assert.ok(Number.isFinite(feature.properties.value));
    assert.equal(feature.properties.label, String(feature.properties.value));
    assert.equal(typeof feature.properties.emphasis, "boolean");
    assert.ok(coords(feature).length >= 2);
  }
  assertLonLatOrder(isobars);

  // Same set of pressure values as the payload carries.
  const values = new Set(isobars.features.map((f) => f.properties.value));
  assert.deepEqual([...values].sort(), [...new Set(payload.isobars.lines.map((l) => l.value))].sort());
});

test("isobar emphasis follows the payload major classification (8-hPa multiples)", () => {
  const payload = loadFixture(SYNOPTIC_FIXTURE);
  const { isobars } = mod.buildSynopticFeatureCollections(payload);
  assert.ok(isobars.features.some((f) => f.properties.emphasis));
  assert.ok(isobars.features.some((f) => !f.properties.emphasis));
  for (const feature of isobars.features) {
    assert.equal(
      feature.properties.emphasis,
      feature.properties.value % 8 === 0,
      `isobar ${feature.properties.value} emphasis mismatch`,
    );
    assert.equal(feature.properties.emphasis, feature.properties.major);
  }
});

test("isobar emphasis falls back to the 8-hPa rule when kind is missing (pre-v3 payloads)", () => {
  const line = (value) =>
    encodeVectorLine({ value }, [
      [30, -100],
      [31, -101],
      [32, -103],
    ]);
  const payload = { lines: [line(1008), line(1010)] };
  const { isobars } = mod.buildSynopticFeatureCollections(payload);
  assert.equal(isobars.features.length, 2);
  const byValue = new Map(isobars.features.map((f) => [f.properties.value, f]));
  assert.equal(byValue.get(1008).properties.emphasis, true);
  assert.equal(byValue.get(1010).properties.emphasis, false);
});

// ── Real-payload conversion: thickness ───────────────────────────────────────

test("thickness features: kind, warm band on an all->540 summer payload", () => {
  const payload = loadFixture(SYNOPTIC_FIXTURE);
  const { thickness } = mod.buildSynopticFeatureCollections(payload);
  assert.equal(thickness.features.length, payload.thickness.lines.length);
  for (const feature of thickness.features) {
    assert.equal(feature.properties.kind, "thickness");
    assert.equal(feature.properties.label, String(feature.properties.value));
    // Fixture values are 564..582 dam — all above the 540 boundary.
    assert.equal(feature.properties.band, "warm");
    assert.equal(feature.properties.emphasis, false);
    assert.equal(feature.properties.major, feature.properties.value % 12 === 0);
  }
  assertLonLatOrder(thickness);
});

test("thickness band + 540 emphasis (synthetic payload through the real encoder)", () => {
  const line = (kind, value) =>
    encodeVectorLine({ kind, value }, [
      [40, -100],
      [41, -102],
      [42, -104],
      [43, -106],
    ]);
  const payload = {
    thickness: {
      lines: [
        line("thickness-minor", 534),
        line("thickness-540", 540),
        line("thickness-minor", 546),
        line("thickness-major", 552),
      ],
    },
  };
  const { thickness } = mod.buildSynopticFeatureCollections(payload);
  assert.equal(thickness.features.length, 4);
  const byValue = new Map(thickness.features.map((f) => [f.properties.value, f.properties]));
  assert.equal(byValue.get(534).band, "cold");
  assert.equal(byValue.get(540).band, "boundary");
  assert.equal(byValue.get(546).band, "warm");
  assert.equal(byValue.get(552).band, "warm");
  // Emphasis = the 540 critical-thickness line only; major = 12-dam multiples.
  assert.deepEqual(
    thickness.features.map((f) => f.properties.emphasis),
    thickness.features.map((f) => f.properties.value === 540),
  );
  assert.equal(byValue.get(540).major, true);
  assert.equal(byValue.get(552).major, true);
  assert.equal(byValue.get(534).major, false);
});

// ── Geometry: ring closure + stitching ───────────────────────────────────────

test("closed rings stay exactly closed through decode + smoothing", () => {
  const ring = [
    [40, -100],
    [42, -98],
    [44, -100],
    [42, -102],
    [41, -101.5],
    [40, -100],
  ];
  const payload = { isobars: { lines: [encodeVectorLine({ kind: "mslp-major", value: 1000 }, ring)] } };
  const { isobars } = mod.buildSynopticFeatureCollections(payload);
  assert.equal(isobars.features.length, 1);
  const positions = coords(isobars.features[0]);
  // Smoothing ran (Chaikin corner cutting adds vertices)…
  assert.ok(positions.length > ring.length);
  // …and the ring is still exactly closed, first === last.
  assert.deepEqual(positions[0], positions[positions.length - 1]);
});

test("open lines stay open and keep their endpoints", () => {
  const open = [
    [30, -110],
    [32, -108],
    [34, -107],
    [36, -105],
  ];
  const payload = { isobars: { lines: [encodeVectorLine({ kind: "mslp-minor", value: 1004 }, open)] } };
  const { isobars } = mod.buildSynopticFeatureCollections(payload);
  const positions = coords(isobars.features[0]);
  assert.deepEqual(positions[0], [-110, 30]);
  assert.deepEqual(positions[positions.length - 1], [-105, 36]);
  assert.notDeepEqual(positions[0], positions[positions.length - 1]);
});

test("2-point raw segments stitch into one chain per value", () => {
  // Marching-squares style raw segments A-B, B-C, C-D of the same level
  // (grouping key: kind|value|color|dash) must merge into a single feature.
  const seg = (a, b) => ({ kind: "mslp-major", value: 1016, points: [a, b] });
  const A = [40, -110];
  const B = [41, -109];
  const C = [42, -108];
  const D = [43, -107];
  const payload = { isobars: { lines: [seg(A, B), seg(B, C), seg(C, D)] } };
  const { isobars } = mod.buildSynopticFeatureCollections(payload);
  assert.equal(isobars.features.length, 1);
  const positions = coords(isobars.features[0]);
  // Open Chaikin smoothing preserves the chain's endpoints exactly.
  assert.deepEqual(positions[0], [A[1], A[0]]);
  assert.deepEqual(positions[positions.length - 1], [D[1], D[0]]);
});

// ── Height contours ───────────────────────────────────────────────────────────

test("height contour features: count, kind, palette color, emphasis, [lon,lat]", () => {
  const payload = loadFixture(HEIGHT_FIXTURE);
  const fc = mod.buildHeightContourFeatureCollection(payload);
  assert.equal(fc.features.length, payload.lines.length);
  for (const feature of fc.features) {
    assert.equal(feature.properties.kind, "height");
    assert.ok(Number.isFinite(feature.properties.value));
    assert.equal(feature.properties.label, String(feature.properties.value));
    // Payload palette color travels on the feature (analysts' colors).
    assert.equal(feature.properties.color, "#171717");
    // height-500-major kinds sit on 2x-interval (12 dam) multiples.
    assert.equal(feature.properties.emphasis, feature.properties.value % 12 === 0);
    assert.equal(feature.properties.emphasis, feature.properties.major);
  }
  assertLonLatOrder(fc);
});

test("height contour geometry is smoothed but interpolates every decoded payload vertex", () => {
  const payload = loadFixture(HEIGHT_FIXTURE);
  const fc = mod.buildHeightContourFeatureCollection(payload);
  for (let index = 0; index < payload.lines.length; index += 1) {
    const decoded = decodeVectorLinePoints(payload.lines[index]);
    const positions = coords(fc.features[index]);
    // The payload ships coarse polylines (segments up to ~4.3 deg with ~33 deg
    // corners in this fixture) — the conversion now subdivides them…
    assert.ok(positions.length > decoded.length, `line ${index} was not subdivided`);
    // …with an INTERPOLATORY scheme: every original vertex survives exactly.
    assertContainsOriginalVertices(positions, decoded);
  }
  assert.deepEqual(coords(fc.features[0])[0], [
    decodeVectorLinePoints(payload.lines[0])[0][1],
    decodeVectorLinePoints(payload.lines[0])[0][0],
  ]);
});

test("height emphasis falls back to the 2x-interval rule when kind is missing", () => {
  const line = (value) =>
    encodeVectorLine({ value }, [
      [45, -100],
      [46, -101],
    ]);
  const payload = { contourIntervalDam: 3, lines: [line(300), line(303)] };
  const fc = mod.buildHeightContourFeatureCollection(payload);
  const byValue = new Map(fc.features.map((f) => [f.properties.value, f.properties]));
  assert.equal(byValue.get(300).emphasis, true); // 300 % 6 === 0
  assert.equal(byValue.get(303).emphasis, false);
});

// ── H/L pressure-center point features (Task 4.3 symbol layers) ──────────────

test("center features from the real payload: kinds, glyphs, values, [lon,lat] order", () => {
  const payload = loadFixture(SYNOPTIC_FIXTURE);
  const { highs, lows } = mod.buildSynopticCenterFeatureCollections(payload.centers);
  assert.equal(highs.type, "FeatureCollection");
  assert.equal(highs.features.length, payload.centers.highs.length);
  assert.equal(lows.features.length, payload.centers.lows.length);
  for (const feature of [...highs.features, ...lows.features]) {
    assert.equal(feature.type, "Feature");
    assert.equal(feature.geometry.type, "Point");
    const [lon, lat] = feature.geometry.coordinates;
    assert.ok(lon >= -135 && lon <= -60, `lon out of range: ${lon}`);
    assert.ok(lat >= 20 && lat <= 55, `lat out of range: ${lat}`);
    assert.ok(Number.isFinite(feature.properties.value));
    assert.equal(feature.properties.valueText, String(feature.properties.value));
  }
  for (const feature of highs.features) {
    assert.equal(feature.properties.kind, "high");
    assert.equal(feature.properties.label, "H");
  }
  for (const feature of lows.features) {
    assert.equal(feature.properties.kind, "low");
    assert.equal(feature.properties.label, "L");
  }
});

test("center sortKey = negated MSLP anomaly |value - 1013.25| (strongest centers place first)", () => {
  const centers = {
    highs: [
      { lat: 40, lon: -100, valueHpa: 1040 },
      { lat: 45, lon: -90, valueHpa: 1018 },
    ],
    lows: [
      { lat: 35, lon: -95, valueHpa: 985 },
      { lat: 30, lon: -85, valueHpa: 1008 },
    ],
  };
  const { highs, lows } = mod.buildSynopticCenterFeatureCollections(centers);
  const byValue = (fc) => new Map(fc.features.map((f) => [f.properties.value, f.properties.sortKey]));
  const highKeys = byValue(highs);
  const lowKeys = byValue(lows);
  // Exact formula: sortKey = -(|valueHpa - 1013.25|); maplibre places
  // ascending symbol-sort-key first, so the deepest anomaly wins collisions.
  assert.equal(highKeys.get(1040), -(1040 - 1013.25));
  assert.equal(highKeys.get(1018), -(1018 - 1013.25));
  assert.equal(lowKeys.get(985), -(1013.25 - 985));
  assert.equal(lowKeys.get(1008), -(1013.25 - 1008));
  // Deeper low sorts before the weak low; stronger high before the weak high.
  assert.ok(lowKeys.get(985) < lowKeys.get(1008));
  assert.ok(highKeys.get(1040) < highKeys.get(1018));
});

test("center values are rounded for display; sortKey uses the raw value", () => {
  const centers = { highs: [{ lat: 40, lon: -100, valueHpa: 1023.6 }], lows: [] };
  const { highs } = mod.buildSynopticCenterFeatureCollections(centers);
  assert.equal(highs.features.length, 1);
  assert.equal(highs.features[0].properties.value, 1024);
  assert.equal(highs.features[0].properties.valueText, "1024");
  assert.equal(highs.features[0].properties.sortKey, -(1023.6 - 1013.25));
});

test("center features: malformed entries dropped, empty/missing input yields empty collections", () => {
  const centers = {
    highs: [
      { lat: Number.NaN, lon: -100, valueHpa: 1020 },
      { lat: 40, lon: -100, valueHpa: Number.POSITIVE_INFINITY },
      { lat: 41, lon: -101, valueHpa: 1022 },
    ],
    lows: [{ lat: 35, lon: undefined, valueHpa: 1000 }],
  };
  const { highs, lows } = mod.buildSynopticCenterFeatureCollections(centers);
  assert.equal(highs.features.length, 1);
  assert.equal(highs.features[0].properties.value, 1022);
  assert.deepEqual(lows.features, []);
  for (const input of [null, undefined, {}]) {
    const out = mod.buildSynopticCenterFeatureCollections(input);
    assert.deepEqual(out.highs.features, []);
    assert.deepEqual(out.lows.features, []);
  }
});

test("present-empty vector centers remain authoritative over manifest fallback", () => {
  const fallback = {
    highs: [{ lat: 40, lon: -100, valueHpa: 1024 }],
    lows: [{ lat: 35, lon: -95, valueHpa: 996 }],
  };
  const presentEmpty = { highs: [], lows: [] };
  assert.strictEqual(mod.resolveSynopticCenters(presentEmpty, fallback), presentEmpty);
  assert.strictEqual(mod.resolveSynopticCenters(null, fallback), fallback);
  assert.strictEqual(mod.resolveSynopticCenters(undefined, fallback), fallback);
  assert.equal(mod.resolveSynopticCenters(undefined, null), null);
});

test("explicit center normalization distinguishes omitted from present-empty payload rosters", () => {
  assert.equal(mod.normalizeExplicitSynopticCenters(null), undefined);
  assert.equal(mod.normalizeExplicitSynopticCenters({}), undefined);
  assert.deepEqual(mod.normalizeExplicitSynopticCenters({ centers: { highs: [], lows: [] } }), {
    highs: [],
    lows: [],
  });
  assert.deepEqual(
    mod.normalizeExplicitSynopticCenters({
      centers: {
        highs: [{ lat: 40, lon: -100, valueHpa: 1024 }],
        lows: [{ lat: Number.NaN, lon: -95, valueHpa: 996 }],
      },
    }),
    { highs: [{ lat: 40, lon: -100, valueHpa: 1024 }], lows: [] },
  );
});

// ── Geographic-space smoothing (Task 4.3 owner round 2) ──────────────────────
// The payload polylines are coarse (this fixture's height contours carry 16–32
// vertices across CONUS, corners up to ~33 deg; "simple" synoptic lines up to
// ~69 deg) and rendered geometry must stay smooth at the app's max zoom
// (native z13). The conversion smooths with iterated midpoint Catmull-Rom
// subdivision (interpolatory 4-point scheme) in geographic space. Metrics
// below measure in a cos(lat)-scaled local plane (true ground proportions).

function planeOf(positions) {
  const meanLat = positions.reduce((sum, p) => sum + p[1], 0) / positions.length;
  const lonScale = Math.cos((meanLat * Math.PI) / 180);
  return ([lon, lat]) => [lon * lonScale, lat];
}

// Max interior turn angle (deg): deviation from straight-through at each vertex.
function maxTurnDeg(positions) {
  const toPlane = planeOf(positions);
  const pts = positions.map(toPlane);
  let max = 0;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const a = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
    const b = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]];
    const na = Math.hypot(a[0], a[1]);
    const nb = Math.hypot(b[0], b[1]);
    if (na < 1e-12 || nb < 1e-12) {
      continue;
    }
    const cos = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (na * nb)));
    max = Math.max(max, (Math.acos(cos) * 180) / Math.PI);
  }
  return max;
}

function pointSegmentDistance(p, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
}

// One-sided Hausdorff: max over smoothed vertices of distance to the original
// polyline (both in the same cos(lat)-scaled plane).
function maxDeviationFrom(originalPositions, smoothedPositions) {
  const toPlane = planeOf(originalPositions);
  const original = originalPositions.map(toPlane);
  let max = 0;
  for (const raw of smoothedPositions) {
    const p = toPlane(raw);
    let min = Infinity;
    for (let i = 0; i < original.length - 1; i += 1) {
      min = Math.min(min, pointSegmentDistance(p, original[i], original[i + 1]));
    }
    max = Math.max(max, min);
  }
  return max;
}

function maxSegmentLength(positions) {
  const toPlane = planeOf(positions);
  const pts = positions.map(toPlane);
  let max = 0;
  for (let i = 1; i < pts.length; i += 1) {
    max = Math.max(max, Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return max;
}

// Interpolation check: every original vertex must survive exactly, except
// consecutive near-duplicates (<= 1e-4 deg of their predecessor), which the
// dedupe pass may legitimately drop.
function assertContainsOriginalVertices(smoothedPositions, decodedLatLonPoints) {
  const smoothedSet = new Set(smoothedPositions.map((p) => `${p[0]},${p[1]}`));
  for (let i = 0; i < decodedLatLonPoints.length; i += 1) {
    const [lat, lon] = decodedLatLonPoints[i];
    if (smoothedSet.has(`${lon},${lat}`)) {
      continue;
    }
    const prev = decodedLatLonPoints[i - 1];
    const isDupe = prev && Math.abs(prev[0] - lat) <= 1e-4 && Math.abs(prev[1] - lon) <= 1e-4;
    assert.ok(isDupe, `original vertex [${lat}, ${lon}] missing from the smoothed line`);
  }
}

test("height contours: smoothing brings max turn angle under the smoothness target", () => {
  const payload = loadFixture(HEIGHT_FIXTURE);
  const fc = mod.buildHeightContourFeatureCollection(payload);
  for (let index = 0; index < payload.lines.length; index += 1) {
    const decoded = decodeVectorLinePoints(payload.lines[index]).map(([lat, lon]) => [lon, lat]);
    const before = maxTurnDeg(decoded);
    const after = maxTurnDeg(coords(fc.features[index]));
    // Fixture corners run 9.6..32.5 deg; the subdivided line must sit under
    // the documented 6-deg perceptual target (with the original as a floor
    // for lines that were already smooth).
    assert.ok(
      after <= Math.max(6, before),
      `line ${index}: maxTurn ${after.toFixed(1)} deg (was ${before.toFixed(1)})`,
    );
    assert.ok(after <= 6 || before <= 6, `line ${index}: still jagged at ${after.toFixed(1)} deg`);
  }
});

test("synoptic isobars/thickness get the same geographic smoothing", () => {
  const payload = loadFixture(SYNOPTIC_FIXTURE);
  const { isobars, thickness } = mod.buildSynopticFeatureCollections(payload);
  for (const feature of [...isobars.features, ...thickness.features]) {
    const after = maxTurnDeg(coords(feature));
    assert.ok(after <= 6, `${feature.properties.kind} ${feature.properties.value}: maxTurn ${after.toFixed(1)} deg`);
  }
});

test("smoothed lines stay within the accuracy bound (<= 0.25 x local segment span)", () => {
  const payload = loadFixture(HEIGHT_FIXTURE);
  const fc = mod.buildHeightContourFeatureCollection(payload);
  for (let index = 0; index < payload.lines.length; index += 1) {
    const decoded = decodeVectorLinePoints(payload.lines[index]).map(([lat, lon]) => [lon, lat]);
    const deviation = maxDeviationFrom(decoded, coords(fc.features[index]));
    const bound = 0.25 * maxSegmentLength(decoded);
    assert.ok(
      deviation <= bound,
      `line ${index}: deviation ${deviation.toFixed(4)} deg exceeds bound ${bound.toFixed(4)} deg`,
    );
  }
  // Same bound for the synoptic families.
  const synoptic = loadFixture(SYNOPTIC_FIXTURE);
  const { isobars } = mod.buildSynopticFeatureCollections(synoptic);
  for (let index = 0; index < isobars.features.length; index += 1) {
    const positions = coords(isobars.features[index]);
    const original = decodeVectorLinePoints(synoptic.isobars.lines[index]).map(([lat, lon]) => [lon, lat]);
    const deviation = maxDeviationFrom(original, positions);
    assert.ok(deviation <= 0.25 * maxSegmentLength(original), `isobar ${index} deviates ${deviation.toFixed(4)} deg`);
  }
});

test("closed height rings stay exactly closed through smoothing", () => {
  const ring = [
    [40, -100],
    [42, -97],
    [44, -100],
    [42, -103],
    [40, -100],
  ];
  const payload = { contourIntervalDam: 6, lines: [encodeVectorLine({ kind: "height-500-major", value: 588 }, ring)] };
  const fc = mod.buildHeightContourFeatureCollection(payload);
  const positions = coords(fc.features[0]);
  assert.ok(positions.length > ring.length);
  assert.deepEqual(positions[0], positions[positions.length - 1]);
  assert.ok(maxTurnDeg(positions) <= 20, `synthetic square ring still sharp: ${maxTurnDeg(positions).toFixed(1)}`);
});

test("straight and short lines pass through smoothing untouched", () => {
  const straight = [
    [30, -110],
    [32, -108],
    [34, -106],
    [36, -104],
  ];
  const two = [
    [30, -110],
    [31, -109],
  ];
  const payload = {
    contourIntervalDam: 6,
    lines: [
      encodeVectorLine({ kind: "height-500-minor", value: 570, width: 1 }, straight),
      encodeVectorLine({ kind: "height-500-minor", value: 576, width: 1 }, two),
    ],
  };
  const fc = mod.buildHeightContourFeatureCollection(payload);
  // Collinear vertices: no corners above the target, so no subdivision.
  assert.equal(coords(fc.features[0]).length, straight.length);
  assert.equal(coords(fc.features[1]).length, two.length);
});

test("smoothing respects the per-line point budget on pathological zigzags", () => {
  const zigzag = [];
  for (let i = 0; i < 1500; i += 1) {
    zigzag.push([40 + (i % 2 === 0 ? 0 : 0.4), -120 + i * 0.05]);
  }
  const payload = {
    contourIntervalDam: 6,
    lines: [encodeVectorLine({ kind: "height-500-minor", value: 564 }, zigzag)],
  };
  const fc = mod.buildHeightContourFeatureCollection(payload);
  const positions = coords(fc.features[0]);
  assert.ok(positions.length >= zigzag.length, "budget must never drop original vertices");
  // CONTOUR_SMOOTH_MAX_POINTS = 4096 (+1 closure slot for rings).
  assert.ok(positions.length <= 4097, `point budget exceeded: ${positions.length}`);
});

// ── Empty / malformed payloads ────────────────────────────────────────────────

test("empty and malformed payloads produce empty collections", () => {
  for (const payload of [null, undefined, {}]) {
    const { isobars, thickness } = mod.buildSynopticFeatureCollections(payload);
    assert.deepEqual(isobars.features, []);
    assert.deepEqual(thickness.features, []);
    assert.deepEqual(mod.buildHeightContourFeatureCollection(payload).features, []);
  }
  // Lines with no decodable points or a single point are dropped.
  const junk = {
    isobars: {
      lines: [
        { kind: "mslp-major", value: 1000 },
        { kind: "mslp-minor", value: 996, points: [[40, -100]] },
      ],
    },
  };
  assert.deepEqual(mod.buildSynopticFeatureCollections(junk).isobars.features, []);
  // Lines without a finite value are dropped (properties.value is contractual).
  const noValue = {
    isobars: {
      lines: [
        {
          kind: "mslp-major",
          points: [
            [40, -100],
            [41, -101],
          ],
        },
      ],
    },
  };
  assert.deepEqual(mod.buildSynopticFeatureCollections(noValue).isobars.features, []);
});

// ── Style-class splits (layer routing) ────────────────────────────────────────

test("splitSynopticStyleClasses routes features into the seven line-layer classes", () => {
  const line = (kind, value) =>
    encodeVectorLine({ kind, value }, [
      [40, -100],
      [41, -102],
      [42, -104],
    ]);
  const payload = {
    isobars: { lines: [line("mslp-minor", 1012), line("mslp-major", 1016)] },
    thickness: {
      lines: [
        line("thickness-minor", 528),
        line("thickness-major", 528),
        line("thickness-540", 540),
        line("thickness-minor", 546),
        line("thickness-major", 552),
      ],
    },
  };
  const split = mod.splitSynopticStyleClasses(mod.buildSynopticFeatureCollections(payload));
  assert.equal(split.isobars.features.length, 1);
  assert.equal(split.isobarsMajor.features.length, 1);
  assert.equal(split.thicknessCold.features.length, 1);
  assert.equal(split.thicknessColdMajor.features.length, 1);
  assert.equal(split.thicknessWarm.features.length, 1);
  assert.equal(split.thicknessWarmMajor.features.length, 1);
  assert.equal(split.thicknessBoundary.features.length, 1);
  // Every class is a FeatureCollection even when empty.
  const empty = mod.splitSynopticStyleClasses(mod.buildSynopticFeatureCollections(null));
  for (const fc of Object.values(empty)) {
    assert.equal(fc.type, "FeatureCollection");
    assert.deepEqual(fc.features, []);
  }
});

test("splitHeightContourClasses separates minor and major contours", () => {
  const payload = loadFixture(HEIGHT_FIXTURE);
  const fc = mod.buildHeightContourFeatureCollection(payload);
  const { minor, major } = mod.splitHeightContourClasses(fc);
  assert.equal(minor.features.length + major.features.length, fc.features.length);
  assert.ok(major.features.every((f) => f.properties.emphasis));
  assert.ok(minor.features.every((f) => !f.properties.emphasis));
  assert.ok(major.features.length > 0);
  assert.ok(minor.features.length > 0);
});
