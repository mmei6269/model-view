"use strict";

// Focused contract for the masked f64x2 smoothing path. The general kernel
// suite covers production routing; this file stresses the cases that make
// smoothGrid leave its all-finite fast path while requiring bit-for-bit
// parity with the scalar finite-skip algorithm.

const assert = require("node:assert/strict");
const test = require("node:test");

const { smoothFiniteNonnegativeGrid } = require("../scripts/lib/noaa-beta/grid-ops");
const { getParcelKernel } = require("../scripts/lib/noaa-beta/parcel-kernel");

const WEIGHTS = Object.freeze([1, 4, 6, 4, 1]);

function scalarSample(values, centerIndex, stride, coordinate, limit) {
  let weighted = 0;
  let weightTotal = 0;
  for (let offset = -2; offset <= 2; offset += 1) {
    const sampleCoordinate = coordinate + offset;
    if (sampleCoordinate < 0 || sampleCoordinate >= limit) {
      continue;
    }
    const value = Number(values[centerIndex + offset * stride]);
    if (!Number.isFinite(value)) {
      continue;
    }
    const weight = WEIGHTS[offset + 2];
    weighted += value * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weighted / weightTotal : Number.NaN;
}

function scalarReference(input, width, height, passes) {
  const mask = input;
  let current = input;
  for (let pass = 0; pass < passes; pass += 1) {
    const horizontal = new Float32Array(input.length);
    const out = new Float32Array(input.length);
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = rowOffset + x;
        horizontal[index] = Number.isFinite(mask[index]) ? scalarSample(current, index, 1, x, width) : Number.NaN;
      }
    }
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = rowOffset + x;
        if (!Number.isFinite(mask[index])) {
          out[index] = Number.NaN;
          continue;
        }
        const smoothed = scalarSample(horizontal, index, width, y, height);
        out[index] = Number.isFinite(smoothed) ? Math.max(0, smoothed) : Number.NaN;
      }
    }
    current = out;
  }
  return current;
}

function assertSameBits(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  const actualBits = new Uint32Array(actual.buffer, actual.byteOffset, actual.length);
  const expectedBits = new Uint32Array(expected.buffer, expected.byteOffset, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.equal(
      actualBits[index],
      expectedBits[index],
      `${label}: bit mismatch at ${index}; actual=${actual[index]} expected=${expected[index]}`,
    );
  }
}

function adversarialGrid(width, height) {
  const grid = new Float32Array(width * height);
  const palette = [
    -0,
    0,
    1.401298464324817e-45,
    -1.401298464324817e-45,
    1,
    -1,
    17.25,
    -31.5,
    3.4028234663852886e38,
    -3.4028234663852886e38,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let index = 0; index < grid.length; index += 1) {
    grid[index] = palette[(index * 7 + Math.floor(index / Math.max(1, width)) * 3) % palette.length];
  }
  if (grid.length > 2) {
    // Noncanonical NaN payloads must still be treated as missing and must not
    // leak their payload through the canonical output stores.
    new Uint32Array(grid.buffer)[grid.length >> 1] = 0x7fc12345;
  }
  return grid;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("masked smoothing SIMD is bit-exact on adversarial boundaries and values", () => {
  const port = getParcelKernel()?.smooth;
  assert.ok(port, "default WASM smoothing port must be present");
  const originalRun = port.run;
  let runCount = 0;
  port.run = (...args) => {
    runCount += 1;
    return originalRun(...args);
  };
  try {
    let caseCount = 0;
    for (const [width, height] of [
      [1, 1],
      [2, 3],
      [3, 2],
      [4, 4],
      [5, 5],
      [6, 7],
      [7, 6],
      [17, 13],
      [18, 14],
    ]) {
      for (const passes of [1, 2, 4]) {
        const grid = adversarialGrid(width, height);
        const original = grid.slice();
        const actual = smoothFiniteNonnegativeGrid(grid, width, height, passes);
        const expected = scalarReference(original, width, height, passes);
        const label = `${width}x${height} passes=${passes}`;
        assertSameBits(actual, expected, label);
        assertSameBits(grid, original, `${label}: input`);
        caseCount += 1;
      }
    }
    assert.equal(runCount, caseCount, "every adversarial case must engage the WASM port");
  } finally {
    port.run = originalRun;
  }
});

test("masked smoothing SIMD matches the scalar oracle on randomized masks", () => {
  const random = mulberry32(0x16f64f2);
  for (let trial = 0; trial < 240; trial += 1) {
    const width = 3 + Math.floor(random() * 45);
    const height = 3 + Math.floor(random() * 39);
    const passes = 1 + Math.floor(random() * 4);
    const grid = new Float32Array(width * height);
    for (let index = 0; index < grid.length; index += 1) {
      const choice = random();
      grid[index] =
        choice < 0.11
          ? Number.NaN
          : choice < 0.13
            ? Number.POSITIVE_INFINITY
            : choice < 0.15
              ? Number.NEGATIVE_INFINITY
              : choice < 0.19
                ? -0
                : Math.fround((random() - 0.42) * 80);
    }
    // Force every case through the nonfinite-mask path rather than relying on
    // a random draw to do so.
    grid[trial % grid.length] = Number.NaN;
    const actual = smoothFiniteNonnegativeGrid(grid, width, height, passes);
    const expected = scalarReference(grid.slice(), width, height, passes);
    assertSameBits(actual, expected, `trial=${trial} ${width}x${height} passes=${passes}`);
  }
});
