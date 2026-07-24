"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getMercatorRowRemapTable,
  remapSouthNorthLinearLatGridToMercatorRows,
} = require("../scripts/lib/noaa-beta/grid-ops");

const BOUNDS = Object.freeze({ west: -126, east: -66, south: 23, north: 51 });

test("bounded remap predicate is bit-exact with the finite/sentinel reference", () => {
  const random = createRandom(0x5eeda11);
  const special = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -0,
    1e19,
    -1e19,
    1e20,
    -1e20,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
  ];

  for (const mode of ["bilinear", "nearest"]) {
    for (let trial = 0; trial < 64; trial += 1) {
      const width = 2 + (trial % 23);
      const height = 2 + ((trial * 7) % 19);
      const values = new Float32Array(width * height);
      for (let index = 0; index < values.length; index += 1) {
        values[index] = index % 29 === 0 ? special[(index + trial) % special.length] : (random() - 0.5) * 200_000;
      }

      const expected = referenceRemap(values, width, height, BOUNDS, mode);
      const actual = remapSouthNorthLinearLatGridToMercatorRows(values, width, height, BOUNDS, mode);
      assert.equal(actual.length, expected.length);
      for (let index = 0; index < actual.length; index += 1) {
        assert.ok(
          Object.is(actual[index], expected[index]),
          `${mode} trial ${trial} cell ${index}: expected ${expected[index]}, got ${actual[index]}`,
        );
      }
    }
  }
});

function referenceRemap(values, width, height, bounds, mode) {
  const rowMap = getMercatorRowRemapTable({ width, height, bounds, rowInterpolation: mode });
  const out = new Float32Array(width * height);
  if (rowMap.mode === "nearest") {
    for (let y = 0; y < height; y += 1) {
      const base = rowMap.base[y];
      const outBase = y * width;
      if (base < 0) {
        out.fill(Number.NaN, outBase, outBase + width);
        continue;
      }
      for (let x = 0; x < width; x += 1) {
        const raw = values[base + x];
        out[outBase + x] = Number.isFinite(raw) && Math.abs(raw) < 1e19 ? raw : Number.NaN;
      }
    }
    return out;
  }

  for (let y = 0; y < height; y += 1) {
    const base0 = rowMap.base0[y];
    const base1 = rowMap.base1[y];
    const outBase = y * width;
    if (base0 < 0 || base1 < 0) {
      out.fill(Number.NaN, outBase, outBase + width);
      continue;
    }
    const ty = rowMap.weight[y];
    const tyComplement = 1 - ty;
    for (let x = 0; x < width; x += 1) {
      const lowerRaw = values[base0 + x];
      const upperRaw = values[base1 + x];
      const lowerUsable = Number.isFinite(lowerRaw) && Math.abs(lowerRaw) < 1e19;
      const upperUsable = Number.isFinite(upperRaw) && Math.abs(upperRaw) < 1e19;
      out[outBase + x] =
        lowerUsable && upperUsable
          ? lowerRaw * tyComplement + upperRaw * ty
          : lowerUsable
            ? lowerRaw
            : upperUsable
              ? upperRaw
              : Number.NaN;
    }
  }
  return out;
}

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
