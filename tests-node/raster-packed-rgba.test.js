"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createContinuousColorLookup,
  createStepColorLookup,
  renderReflectivityGateLayers,
  renderScalarGrid,
  renderWindSpeedLayer,
} = require("../scripts/lib/noaa-beta/raster");

test("native packed RGBA stores match the byte-store fallback exactly", () => {
  const values = buildValues(32_771);
  const continuous = createContinuousColorLookup({
    stops: [
      [0, [10, 20, 30, 0]],
      [0.25, [70, 90, 110, 0.4]],
      [0.7, [140, 130, 80, 0.8]],
      [1, [250, 240, 230, 1]],
    ],
    min: -60,
    max: 120,
    alpha: 0.91,
    size: 257,
  });
  const step = createStepColorLookup(
    [
      [-30, [0, 0, 0, 0]],
      [-7, [20, 60, 120, 0.4]],
      [3, [30, 180, 90, 0.7]],
      [19, [230, 210, 40, 0.9]],
      [47, [210, 40, 20, 1]],
    ],
    0.87,
  );

  for (const options of [
    { colorLookup: continuous },
    { colorLookup: continuous, transformScale: 1.8, transformOffset: -17.5 },
    { colorLookup: continuous, transformValue: (value) => value * 0.75 + 3 },
    { colorLookup: step, minVisible: -30 },
    { colorLookup: step, minVisible: -30, transformScale: 0.5, transformOffset: 4 },
    { colorLookup: step, minVisible: -30, transformValue: (value) => value * 1.25 - 2 },
  ]) {
    const packed = renderScalarGrid({ values, width: values.length, height: 1, ...options });
    const fallback = renderScalarGrid({
      values,
      width: values.length,
      height: 1,
      ...options,
      colorLookup: withMisalignedColors(options.colorLookup),
    });
    assert.equal(packed.visibleCount, fallback.visibleCount);
    assert.equal(packed.validCount, fallback.validCount);
    assert.deepEqual(packed.rgba, fallback.rgba);
  }
});

test("packed wind and reflectivity-gate stores match misaligned byte fallbacks", () => {
  const values = buildValues(16_381);
  const reversed = Float32Array.from(values).reverse();
  const continuous = createContinuousColorLookup({
    stops: [
      [0, [0, 0, 0, 0]],
      [0.5, [30, 170, 220, 0.8]],
      [1, [250, 80, 20, 1]],
    ],
    min: 0,
    max: 150,
    alpha: 0.9,
  });
  const step = createStepColorLookup(
    [
      [-30, [0, 0, 0, 0]],
      [0, [20, 80, 160, 0.5]],
      [10, [30, 190, 80, 0.75]],
      [20, [240, 210, 30, 0.9]],
      [30, [220, 40, 20, 1]],
    ],
    0.9,
  );

  for (const colorLookup of [continuous, step]) {
    const options = {
      uValues: values,
      vValues: reversed,
      multiplier: 1.3,
      width: values.length,
      height: 1,
      minVisible: 0,
    };
    const packed = renderWindSpeedLayer({ ...options, colorLookup });
    const fallback = renderWindSpeedLayer({ ...options, colorLookup: withMisalignedColors(colorLookup) });
    assert.equal(packed.visibleCount, fallback.visibleCount);
    assert.deepEqual(packed.rgba, fallback.rgba);
  }

  const packedGates = renderReflectivityGateLayers({
    values,
    width: values.length,
    height: 1,
    colorLookup: step,
    gates: [10, 15, 20],
  });
  const fallbackGates = renderReflectivityGateLayers({
    values,
    width: values.length,
    height: 1,
    colorLookup: withMisalignedColors(step),
    gates: [10, 15, 20],
  });
  assert.equal(packedGates.length, fallbackGates.length);
  for (let index = 0; index < packedGates.length; index += 1) {
    assert.equal(packedGates[index].visibleCount, fallbackGates[index].visibleCount);
    assert.equal(packedGates[index].validCount, fallbackGates[index].validCount);
    assert.deepEqual(packedGates[index].rgba, fallbackGates[index].rgba);
  }
});

function withMisalignedColors(lookup) {
  const storage = new Uint8Array(lookup.colors.length + 1);
  storage.set(lookup.colors, 1);
  return { ...lookup, colors: storage.subarray(1) };
}

function buildValues(length) {
  const values = new Float32Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    values[index] = index % 211 === 0 ? Number.NaN : ((state >>> 0) / 0xffffffff) * 240 - 90;
  }
  values[1] = Number.POSITIVE_INFINITY;
  values[2] = Number.NEGATIVE_INFINITY;
  values[3] = -30;
  values[4] = 0;
  values[5] = 120;
  return values;
}
