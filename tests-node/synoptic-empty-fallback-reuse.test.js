"use strict";

// Backlog #30 (renderer audit pass 2): when the simple synoptic raster came
// back empty, the renderer fell back to a detailed render for the PNG layer —
// and ran the ENTIRE detailed contour pipeline a second time with identical
// inputs (smoothing, marching squares, contour post-processing, vector
// encoding, labels; only drawImage differed). The detailed pass now renders
// exactly once, choosing drawImage up front from the same gate predicate
// (synopticSimple.visibleCount > 0). drawImage gates raster painting only, so
// vectors/centers/PNG bytes are unchanged. These tests pin both halves: a
// call-count spy proves the single detailed render, and a replay of the old
// call sequence proves the persisted artifacts still equal the pre-change
// bytes on a flat-ish fallback field, a normal field, and a missing-pressure
// field.

const assert = require("node:assert/strict");
const test = require("node:test");

// Spy wiring must precede the renderer require: noaa-beta-renderer binds
// renderSynopticArtifacts at module load, so wrap the export first and force a
// fresh renderer instance that picks up the wrapper. node --test isolates
// each test file in its own process, so the patch cannot leak elsewhere.
const synopticRender = require("../scripts/lib/synoptic-render.js");
const originalRenderSynopticArtifacts = synopticRender.renderSynopticArtifacts;
const renderCalls = [];
synopticRender.renderSynopticArtifacts = function (args) {
  const result = originalRenderSynopticArtifacts(args);
  renderCalls.push({ args, result });
  return result;
};
const rendererPath = require.resolve("../scripts/lib/noaa-beta-renderer.js");
delete require.cache[rendererPath];
const {
  _testBuildRenderedArtifacts: buildRenderedArtifacts,
  _testSynchronizeSynopticArtifactCenters: synchronizeSynopticArtifactCenters,
} = require("../scripts/lib/noaa-beta-renderer.js");
const { encodeLayerOrEmpty } = require("../scripts/lib/noaa-beta/raster.js");
const { createTransparentPng } = require("../scripts/lib/noaa-beta/png-encode.js");

const BOUNDS = Object.freeze({ north: 53, south: 21, west: -129, east: -63 });
const WIDTH = 720;
const HEIGHT = 448;
const PNG_COMPRESSION_LEVEL = 1;
const PNG_FILTER_TYPE = 0;

// ~1003 hPa dip, 6 px sigma on a 1017 hPa background: the 18x10 simple grid
// resamples the feature away (paints zero pixels) while the 360x224 detailed
// grid resolves it — the costly fallback case from the audit.
function buildTightDipField() {
  const values = new Float32Array(WIDTH * HEIGHT).fill(1017);
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const dSq = (x - cx) ** 2 + (y - cy) ** 2;
      values[y * WIDTH + x] = 1017 - 14 * Math.exp(-dSq / (2 * 6 ** 2));
    }
  }
  return values;
}

function buildBroadLowField() {
  const values = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const dSq = (x - WIDTH * 0.4) ** 2 + (y - HEIGHT * 0.5) ** 2;
      values[y * WIDTH + x] = 1012 + 10 * (y / HEIGHT) - 22 * Math.exp(-dSq / (2 * 140 ** 2));
    }
  }
  return values;
}

function buildBroadThicknessField() {
  const values = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      values[y * WIDTH + x] = 510 + 60 * (y / (HEIGHT - 1)) + 6 * Math.sin((x / WIDTH) * Math.PI * 4);
    }
  }
  return values;
}

const FLAT_THICKNESS_DAM = new Float32Array(WIDTH * HEIGHT).fill(546);

function buildDecoded(pressureHpa, thicknessDam) {
  const decoded = {
    temperature2m: new Float32Array(WIDTH * HEIGHT).fill(288),
  };
  if (pressureHpa) {
    decoded.pressureMsl = pressureHpa.map((value) => value * 100);
  }
  if (thicknessDam) {
    decoded.height1000 = new Float32Array(WIDTH * HEIGHT).fill(120);
    decoded.height500 = thicknessDam.map((value) => 120 + value * 10);
  }
  return decoded;
}

function frameArgs(decoded) {
  return {
    decoded,
    selection: { catalog: [], availableParameters: [], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: BOUNDS,
    modelKey: "gfs",
    width: WIDTH,
    height: HEIGHT,
    reflectivityGates: [15],
    pngCompressionLevel: PNG_COMPRESSION_LEVEL,
    pngFilterType: PNG_FILTER_TYPE,
  };
}

async function renderFrame(decoded) {
  renderCalls.length = 0;
  const artifacts = buildRenderedArtifacts(frameArgs(decoded));
  if (artifacts.pendingEncodes) {
    await Promise.all(artifacts.pendingEncodes);
  }
  const simpleCalls = renderCalls.filter((call) => call.args.detailMode === "simple");
  const detailedCalls = renderCalls.filter((call) => call.args.detailMode === "detailed");
  return { artifacts, simpleCalls, detailedCalls };
}

// The pre-change algorithm, replayed on the SAME call arguments the merged
// path used: detailed vectors always rendered with drawImage:false, and only
// an empty simple raster (visibleCount === 0, the unchanged gate) triggered
// the second detailed render with the image on. synchronizeSynopticArtifact
// Centers overwrites artifact.centers/vector.centers, so the replay applies
// it to its own artifacts exactly like the old call site did.
function replayPreChangeArtifacts(simpleArgs, detailedArgs) {
  const simple = originalRenderSynopticArtifacts(simpleArgs);
  let detailed = originalRenderSynopticArtifacts({ ...detailedArgs, drawImage: false });
  let image = simple.visibleCount > 0 ? simple : null;
  if (!image) {
    detailed = originalRenderSynopticArtifacts({ ...detailedArgs });
    image = detailed;
  }
  const centers = synchronizeSynopticArtifactCenters(simple.centers, [simple, detailed]);
  const emptyPng = createTransparentPng(WIDTH, HEIGHT, PNG_COMPRESSION_LEVEL, PNG_FILTER_TYPE);
  const expectedLayer = encodeLayerOrEmpty(image, emptyPng, WIDTH, HEIGHT, PNG_COMPRESSION_LEVEL, PNG_FILTER_TYPE);
  return {
    pngBody: expectedLayer.body,
    vectorSimple: JSON.stringify(simple.vector),
    vectorDetailed: JSON.stringify(detailed.vector),
    centers: JSON.stringify(centers),
    simpleVisibleCount: simple.visibleCount,
  };
}

function assertArtifactsMatchPreChange(actual, simpleCalls, detailedCalls) {
  assert.equal(simpleCalls.length, 1, "expected exactly one simple render");
  assert.equal(detailedCalls.length, 1, "expected exactly one detailed render");
  const expected = replayPreChangeArtifacts(simpleCalls[0].args, detailedCalls[0].args);
  assert.ok(
    Buffer.isBuffer(actual.artifacts.layers.synoptic.body) && actual.artifacts.layers.synoptic.body.length > 0,
    "synoptic layer should carry a PNG body",
  );
  assert.ok(
    actual.artifacts.layers.synoptic.body.equals(expected.pngBody),
    "synoptic PNG layer differs from the pre-change bytes",
  );
  assert.equal(
    JSON.stringify(actual.artifacts.synopticVectors.simple),
    expected.vectorSimple,
    "simple vector payload differs from the pre-change bytes",
  );
  assert.equal(
    JSON.stringify(actual.artifacts.synopticVectors.detailed),
    expected.vectorDetailed,
    "detailed vector payload differs from the pre-change bytes",
  );
  assert.equal(
    JSON.stringify(actual.artifacts.synopticCenters),
    expected.centers,
    "canonical center roster differs from the pre-change bytes",
  );
  return expected;
}

test("simple-empty fallback: detailed renderer runs once and reuses it for vectors and PNG", async () => {
  const actual = await renderFrame(buildDecoded(buildTightDipField(), FLAT_THICKNESS_DAM));
  const expected = assertArtifactsMatchPreChange(actual, actual.simpleCalls, actual.detailedCalls);
  // Mechanism pin: the fallback branch really was taken — the simple raster
  // painted nothing, so the single detailed render must have drawn the image
  // (old code re-rendered with drawImage defaulting to true here).
  assert.equal(expected.simpleVisibleCount, 0, "test field must drive the simple-empty fallback");
  assert.notEqual(
    actual.detailedCalls[0].args.drawImage,
    false,
    "fallback detailed render must paint the raster in the same single pass",
  );
});

test("normal field: detailed renderer runs once with vectors only (drawImage false)", async () => {
  const actual = await renderFrame(buildDecoded(buildBroadLowField(), buildBroadThicknessField()));
  const expected = assertArtifactsMatchPreChange(actual, actual.simpleCalls, actual.detailedCalls);
  assert.ok(expected.simpleVisibleCount > 0, "test field must keep the simple raster non-empty");
  assert.equal(actual.detailedCalls[0].args.drawImage, false, "non-fallback detailed render must stay vectors-only");
});

test("missing pressure: single detailed render, empty artifacts match pre-change bytes", async () => {
  const actual = await renderFrame(buildDecoded(null, buildBroadThicknessField()));
  const expected = assertArtifactsMatchPreChange(actual, actual.simpleCalls, actual.detailedCalls);
  assert.equal(expected.simpleVisibleCount, 0, "missing pressure must yield an empty simple raster");
  assert.equal(actual.artifacts.synopticVectors.detailed.lines.length, 0);
});
