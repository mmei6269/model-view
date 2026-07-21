"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CORE_LAYER_RENDER_OPTIONS,
  EMPTY_SCALAR_LAYER_RGBA,
  encodeLayerOrEmpty,
  renderReflectivityGateLayers,
  renderReflectivityVariants,
  renderScalarGrid,
} = require("../scripts/lib/noaa-beta/raster");
const { encodeRgbaPng } = require("../scripts/lib/noaa-beta/png-encode");

// Oracle: the pre-fusion implementation, one full renderScalarGrid pass per
// gate. Kept inline here so the fused path in raster.js is always pinned
// against the straightforward per-gate loop it replaced.
function renderReflectivityVariantsUnfused({
  values,
  width,
  height,
  reflectivityGates,
  emptyPng,
  pngCompressionLevel,
  pngFilterType,
  encodeLayer = null,
}) {
  const encode =
    encodeLayer || ((layer) => encodeLayerOrEmpty(layer, emptyPng, width, height, pngCompressionLevel, pngFilterType));
  const variants = {};
  for (const gate of reflectivityGates) {
    const gateDbz = Math.round(Number(gate));
    if (!Number.isFinite(gateDbz)) {
      continue;
    }
    variants[`dbz${gateDbz}`] = encode(
      renderScalarGrid({
        values,
        width,
        height,
        ...CORE_LAYER_RENDER_OPTIONS.reflectivity,
        minVisible: gateDbz,
      }),
    );
  }
  return variants;
}

function assertVariantsEqual(actual, expected, label) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected), `${label}: variant key order`);
  for (const key of Object.keys(expected)) {
    const actualLayer = actual[key];
    const expectedLayer = expected[key];
    assert.equal(actualLayer.visibleCount, expectedLayer.visibleCount, `${label}:${key}: visibleCount`);
    assert.equal(actualLayer.validCount, expectedLayer.validCount, `${label}:${key}: validCount`);
    assert.equal(actualLayer.rgba.length, expectedLayer.rgba.length, `${label}:${key}: rgba length`);
    assert.ok(actualLayer.rgba.equals(expectedLayer.rgba), `${label}:${key}: rgba bytes`);
  }
}

function fusedVsUnfused({ values, width, height, reflectivityGates }, label) {
  const fused = renderReflectivityVariants({
    values,
    width,
    height,
    reflectivityGates,
    encodeLayer: (layer) => layer,
  });
  const unfused = renderReflectivityVariantsUnfused({
    values,
    width,
    height,
    reflectivityGates,
    encodeLayer: (layer) => layer,
  });
  assertVariantsEqual(fused, unfused, label);
}

test("fused gate layers match per-gate renders on threshold edge cases", () => {
  // Covers: exact gate values, exact step-stop thresholds, just-below-gate,
  // NaN/Infinity, sub-palette values (bucket-0 alpha 0), above-max clamp,
  // zero and negative dBZ.
  const values = Float64Array.from([
    10,
    15,
    20,
    7.5,
    12.5,
    9.99,
    10.01,
    14.99,
    15.01,
    19.99,
    20.01,
    72.5,
    75,
    100,
    7.49,
    0,
    -10,
    -999,
    NaN,
    Infinity,
    -Infinity,
    32.5,
    45,
    8,
    11,
    16,
    21,
    30,
    40,
    50,
    60,
    70,
  ]);
  fusedVsUnfused({ values, width: 8, height: 4, reflectivityGates: [10, 15, 20] }, "edge-grid");
});

test("fused gate layers match per-gate renders on a deterministic pseudo-random grid", () => {
  const width = 64;
  const height = 40;
  let state = 0x5eed1234;
  const values = new Float32Array(width * height);
  for (let index = 0; index < values.length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const roll = state / 0x7fffffff;
    if (roll < 0.08) {
      values[index] = NaN;
    } else if (roll < 0.16) {
      // Exact stop thresholds and gate values land on bucket boundaries.
      values[index] = 7.5 + 2.5 * Math.floor(roll * 1000);
    } else {
      values[index] = -20 + roll * 120;
    }
  }
  fusedVsUnfused({ values, width, height, reflectivityGates: [10, 15, 20] }, "random-grid");
});

test("fused pass matches per-gate renders for a second source grid shape", () => {
  const width = 17;
  const height = 9;
  const values = new Float64Array(width * height);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = index % 7 === 0 ? NaN : ((index * 13) % 90) - 5;
  }
  fusedVsUnfused({ values, width, height, reflectivityGates: [10, 15, 20] }, "second-source");
});

test("gate parsing preserves rounding, strings, duplicates, skips, and key order", () => {
  const width = 4;
  const height = 2;
  const values = Float64Array.from([12, 18, 25, 5, NaN, 10, 15, 20]);
  fusedVsUnfused(
    {
      values,
      width,
      height,
      reflectivityGates: [20, 10.4, "15", 10, "bogus", NaN, Infinity],
    },
    "messy-gates",
  );
  const fused = renderReflectivityVariants({
    values,
    width,
    height,
    reflectivityGates: [20, 10.4, "15", 10, "bogus", NaN, Infinity],
    encodeLayer: (layer) => layer,
  });
  assert.deepEqual(Object.keys(fused), ["dbz20", "dbz10", "dbz15"]);
});

test("empty gate list yields no variants", () => {
  const fused = renderReflectivityVariants({
    values: Float64Array.from([30, 40]),
    width: 2,
    height: 1,
    reflectivityGates: [],
    encodeLayer: (layer) => layer,
  });
  assert.deepEqual(fused, {});
});

test("invalid grids produce the shared empty scalar layer per gate", () => {
  for (const values of [null, undefined, Float64Array.from([1, 2, 3])]) {
    const fused = renderReflectivityVariants({
      values,
      width: 4,
      height: 2,
      reflectivityGates: [10, 15],
      encodeLayer: (layer) => layer,
    });
    for (const key of Object.keys(fused)) {
      assert.equal(fused[key].visibleCount, 0);
      assert.equal(fused[key].validCount, 0);
      assert.equal(fused[key].rgba, EMPTY_SCALAR_LAYER_RGBA);
    }
  }
});

test("renderReflectivityGateLayers matches per-gate renderScalarGrid output directly", () => {
  const width = 6;
  const height = 3;
  const values = Float64Array.from([9, 10, 11, 14, 15, 16, 19, 20, 21, NaN, 7.5, 80, -3, 12.5, 0, 55, 22.5, 8]);
  const gates = [10, 15, 20];
  const layers = renderReflectivityGateLayers({
    values,
    width,
    height,
    colorLookup: CORE_LAYER_RENDER_OPTIONS.reflectivity.colorLookup,
    gates,
  });
  assert.equal(layers.length, gates.length);
  for (let index = 0; index < gates.length; index += 1) {
    const expected = renderScalarGrid({
      values,
      width,
      height,
      ...CORE_LAYER_RENDER_OPTIONS.reflectivity,
      minVisible: gates[index],
    });
    assert.equal(layers[index].visibleCount, expected.visibleCount, `gate ${gates[index]}: visibleCount`);
    assert.equal(layers[index].validCount, expected.validCount, `gate ${gates[index]}: validCount`);
    assert.ok(layers[index].rgba.equals(expected.rgba), `gate ${gates[index]}: rgba bytes`);
  }
});

test("default encode path produces identical PNG descriptors for fused and unfused variants", () => {
  const width = 8;
  const height = 4;
  const values = Float64Array.from([
    10,
    15,
    20,
    7.5,
    12.5,
    9.99,
    10.01,
    14.99,
    15.01,
    19.99,
    20.01,
    72.5,
    75,
    100,
    7.49,
    0,
    -10,
    -999,
    NaN,
    Infinity,
    -Infinity,
    32.5,
    45,
    8,
    11,
    16,
    21,
    30,
    40,
    50,
    60,
    70,
  ]);
  const emptyPng = encodeRgbaPng(Buffer.alloc(width * height * 4), width, height, 1, 0);
  const options = {
    values,
    width,
    height,
    reflectivityGates: [10, 15, 20],
    emptyPng,
    pngCompressionLevel: 1,
    pngFilterType: 0,
  };
  const fused = renderReflectivityVariants(options);
  const unfused = renderReflectivityVariantsUnfused(options);
  assert.deepEqual(Object.keys(fused), Object.keys(unfused));
  for (const key of Object.keys(unfused)) {
    assert.equal(fused[key].bytes, unfused[key].bytes, `${key}: bytes`);
    assert.equal(fused[key].contentType, unfused[key].contentType, `${key}: contentType`);
    assert.ok(fused[key].body.equals(unfused[key].body), `${key}: PNG body bytes`);
  }
});
