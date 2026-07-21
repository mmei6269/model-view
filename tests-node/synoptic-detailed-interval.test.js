"use strict";

// Task S1 (map QA update set §1): detailed-mode isobars densify to a 2 hPa
// minor interval (major stays 8) via a derived style at the render call site —
// the shared style JSON is public-mirrored and shape-frozen, so simple mode
// must keep reading 4/8 hPa from it untouched. These tests drive the renderer
// with both the shared style and the derived style over an analytic low, pin
// the level cadence and major/minor classification, and require the renderer
// entry point to export the derived style it actually uses.

const assert = require("node:assert/strict");
const test = require("node:test");
const { renderSynopticArtifacts } = require("../scripts/lib/synoptic-render.js");
const { loadSynopticStyle } = require("../scripts/lib/synoptic-style.js");

const BOUNDS = Object.freeze({ north: 53, south: 21, west: -129, east: -63 });
const COLS = 120;
const ROWS = 80;

// ~998 hPa low on a 1016 hPa field: 1016 - 18*exp(-((x-cx)^2+(y-cy)^2)/(2*20^2)).
function buildLowField() {
  const values = new Float32Array(COLS * ROWS);
  const cx = COLS / 2;
  const cy = ROWS / 2;
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      const dSq = (x - cx) ** 2 + (y - cy) ** 2;
      values[y * COLS + x] = 1016 - 18 * Math.exp(-dSq / (2 * 20 ** 2));
    }
  }
  return values;
}

function renderDetailedWithStyle(style) {
  return renderSynopticArtifacts({
    pressureGrid: { values: buildLowField(), cols: COLS, rows: ROWS },
    thicknessGrid: null,
    targetBounds: BOUNDS,
    width: 960,
    height: 640,
    detailMode: "detailed",
    style,
    drawImage: false,
  });
}

function deriveMslp2Style(style) {
  return {
    ...style,
    styleVersion: `${style.styleVersion}+mslp2`,
    mslp: { ...style.mslp, minorIntervalHpa: 2 },
  };
}

test("derived +mslp2 style renders 2 hPa minors with 8 hPa majors; shared style stays 4 hPa", () => {
  const sharedStyle = loadSynopticStyle();
  const derived = renderDetailedWithStyle(deriveMslp2Style(sharedStyle));
  const shared = renderDetailedWithStyle(sharedStyle);

  const derivedLevels = [...new Set(derived.vector.isobars.lines.map((line) => line.value))];
  assert.ok(derivedLevels.length > 0, "derived run should produce isobars");
  // (a) at least one off-4 level proves the 2 hPa cadence is active.
  assert.ok(
    derivedLevels.some((level) => level % 4 === 2),
    `expected a level ≡ 2 (mod 4), got ${derivedLevels.sort((a, b) => a - b)}`,
  );
  // (b) every level sits on the 2 hPa lattice.
  for (const level of derivedLevels) {
    assert.equal(level % 2, 0, `level ${level} off the 2 hPa lattice`);
  }
  // (c) 8 hPa multiples classify major, everything else minor.
  for (const line of derived.vector.isobars.lines) {
    assert.equal(
      line.kind,
      line.value % 8 === 0 ? "mslp-major" : "mslp-minor",
      `level ${line.value} misclassified as ${line.kind}`,
    );
  }
  // Derived vectors are stamped so stale caches are distinguishable.
  assert.equal(derived.vector.styleVersion, `${sharedStyle.styleVersion}+mslp2`);

  // (d) the un-derived run stays on the shared 4 hPa lattice.
  const sharedLevels = [...new Set(shared.vector.isobars.lines.map((line) => line.value))];
  assert.ok(sharedLevels.length > 0, "shared-style run should produce isobars");
  for (const level of sharedLevels) {
    assert.equal(level % 4, 0, `shared-style level ${level} off the 4 hPa lattice`);
  }

  // (e) deriving must not mutate the frozen shared style. Assert on the SAME
  // reference we derived from — a fresh loadSynopticStyle() could re-parse
  // and mask a mutation of the original object.
  assert.equal(sharedStyle.mslp.minorIntervalHpa, 4, "shared style was mutated by the derived copy");
});

// ── Task S3 (map QA update set §6b): height contours on the detailed grid ────
// renderHeightContourLayer fed height fields through the 25x15-ish simple
// resample while MSLP-detailed renders from the <=360x224 capped grid; real
// troughs were flattened away. The layer must now build the same detailed-cap
// grid. Artifact keys/manifest shape stay unchanged (still one vector per
// level) and the PNG raster stays on (encodeLayerOrEmpty consumes layer.rgba).

const HEIGHT_COLS = 400;
const HEIGHT_ROWS = 240;

// 500 mb heights (dam): poleward gradient plus a full-wave trough/ridge.
function buildTroughField() {
  const values = new Float32Array(HEIGHT_COLS * HEIGHT_ROWS);
  for (let y = 0; y < HEIGHT_ROWS; y += 1) {
    for (let x = 0; x < HEIGHT_COLS; x += 1) {
      values[y * HEIGHT_COLS + x] =
        576 - 30 * (y / (HEIGHT_ROWS - 1)) + 9 * Math.sin((x / (HEIGHT_COLS - 1)) * Math.PI * 2);
    }
  }
  return values;
}

function longestLineVertexCount(vector) {
  const { decodeVectorLinePoints } = require("../scripts/lib/vector-encoding.js");
  return Math.max(0, ...(vector?.lines || []).map((line) => decodeVectorLinePoints(line).length));
}

test("height contour layer renders from the detailed-cap grid, not the 25x15 simple resample", () => {
  const {
    _testRenderHeightContourArtifacts,
    _testRenderHeightContourLayer,
  } = require("../scripts/lib/noaa-beta-renderer.js");
  const values = buildTroughField();
  const base = {
    heightGrid: { values, cols: HEIGHT_COLS, rows: HEIGHT_ROWS },
    targetBounds: BOUNDS,
    width: HEIGHT_COLS,
    height: HEIGHT_ROWS,
    modelKey: "gfs",
    levelMb: 500,
    intervalDam: 6,
    drawImage: false,
  };
  const simple = _testRenderHeightContourArtifacts({ ...base, detailMode: "simple" });
  const detailed = _testRenderHeightContourArtifacts({ ...base, detailMode: "detailed" });
  const simpleLongest = longestLineVertexCount(simple.vector);
  const detailedLongest = longestLineVertexCount(detailed.vector);
  assert.ok(simpleLongest > 0, "simple render should produce contours");
  // Mechanism pin: the detailed grid actually resolves more of the trough.
  assert.ok(
    detailedLongest >= 3 * simpleLongest,
    `detailed longest ${detailedLongest} < 3x simple longest ${simpleLongest}`,
  );

  const layer = _testRenderHeightContourLayer({
    entry: { key: "height500", kind: "heightContour", contourLevelMb: 500, contourIntervalDam: 6 },
    values,
    bounds: BOUNDS,
    modelKey: "gfs",
    width: HEIGHT_COLS,
    height: HEIGHT_ROWS,
  });
  assert.ok(layer?.vector, "layer should render a vector payload");
  const layerLongest = longestLineVertexCount(layer.vector);
  assert.ok(
    layerLongest >= 3 * simpleLongest,
    `layer longest ${layerLongest} < 3x simple longest ${simpleLongest} — still on the simple grid`,
  );
  assert.equal(layer.vector.contourLevelMb, 500);
  assert.equal(layer.vector.contourIntervalDam, 6);
  // The PNG raster stays on: the caller encodes layer.rgba via encodeLayerOrEmpty.
  assert.ok(layer.rgba instanceof Uint8Array && layer.rgba.length === HEIGHT_COLS * HEIGHT_ROWS * 4);
  assert.ok(layer.visibleCount > 0, "raster pass should paint contour pixels");
});

test("noaa-beta-renderer exposes the detailed-mode derived style it renders with", () => {
  const { _testDetailedSynopticStyle } = require("../scripts/lib/noaa-beta-renderer.js");
  assert.ok(_testDetailedSynopticStyle, "noaa-beta-renderer must export _testDetailedSynopticStyle");
  assert.equal(_testDetailedSynopticStyle.mslp.minorIntervalHpa, 2);
  assert.equal(_testDetailedSynopticStyle.mslp.majorIntervalHpa, 8);
  assert.ok(
    String(_testDetailedSynopticStyle.styleVersion).endsWith("+mslp2"),
    `styleVersion ${_testDetailedSynopticStyle.styleVersion} missing the +mslp2 marker`,
  );
  assert.equal(_testDetailedSynopticStyle.styleVersion, `${loadSynopticStyle().styleVersion}+mslp2`);
});

// ── Integration: the manifest stamp must be truthful about detailed artifacts ─
// The manifest's synopticStyleVersions.detailed field is the operator-facing
// way to tell rebuilt 2 hPa detailed vectors from stale 4 hPa ones, so it must
// carry the same +mslp2 marker the detailed vector payloads carry. The derived
// style lives in modelview-runtime (required BY noaa-beta-renderer) as the
// single source for both the render style and the manifest stamp.

test("manifest frames stamp synopticStyleVersions.detailed with +mslp2 from the single source", () => {
  const runtime = require("../scripts/lib/modelview-runtime.js");
  const renderer = require("../scripts/lib/noaa-beta-renderer.js");
  const manifest = require("../scripts/lib/local-artifact-manifest.js");

  assert.equal(runtime.DETAILED_SYNOPTIC_STYLE_VERSION, `${runtime.SYNOPTIC_STYLE_VERSION}+mslp2`);
  assert.equal(runtime.DETAILED_SYNOPTIC_STYLE?.mslp?.minorIntervalHpa, 2);
  // Single source: the renderer's detailed style IS the runtime export.
  assert.equal(renderer._testDetailedSynopticStyle, runtime.DETAILED_SYNOPTIC_STYLE);

  const frame = runtime.buildManifestFrame({
    modelKey: "gfs",
    runId: "20260709-1200Z",
    viewKey: "conus",
    framePlan: { hour: 0, validTime: "2026-07-09T12:00:00Z" },
    referenceTime: "2026-07-09T12:00:00.000Z",
    artifactPrefix: "tiles",
    width: 64,
    height: 40,
  });
  assert.equal(frame.synopticStyleVersions.detailed, runtime.DETAILED_SYNOPTIC_STYLE_VERSION);
  assert.ok(
    frame.synopticStyleVersions.detailed.endsWith("+mslp2"),
    `manifest detailed stamp ${frame.synopticStyleVersions.detailed} missing +mslp2`,
  );
  assert.equal(frame.synopticStyleVersions.simple, runtime.SYNOPTIC_STYLE_VERSION);
  assert.ok(!frame.synopticStyleVersions.simple.includes("+mslp2"), "simple stamp must stay unsuffixed");

  // Empty-fallback vector payloads normalize per mode: a detailed slot filled
  // by the fallback must still read as a detailed-style artifact.
  const normalized = manifest.normalizeRenderedFrameArtifacts(null, frame, [10, 15, 20]);
  assert.equal(normalized.synopticVectors.detailed.styleVersion, runtime.DETAILED_SYNOPTIC_STYLE_VERSION);
  assert.equal(normalized.synopticVectors.simple.styleVersion, runtime.SYNOPTIC_STYLE_VERSION);
});
