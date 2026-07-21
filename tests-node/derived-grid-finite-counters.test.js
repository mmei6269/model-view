"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { NOAA_NAM_PARAMETER_CATALOG } = require("../scripts/lib/noaa-nam-parameter-catalog.js");
const {
  _testBuildPrecipAccumulationInGrids: buildPrecipAccumulationInGrids,
  _testBuildRenderedArtifacts: buildRenderedArtifacts,
  _testBuildThicknessGrid: buildThicknessGrid,
  _testResolveCachedHeightDamGrid: resolveCachedHeightDamGrid,
} = require("../scripts/lib/noaa-beta-renderer.js");
const { M_TO_IN } = require("../scripts/lib/noaa-beta/util.js");
const { hasFiniteGridData, hasGrid } = require("../scripts/lib/noaa-beta/parameter-availability.js");
const {
  SNOW_LIQUID_TOTAL_KEY,
  buildSnowfallInGrids,
  snowfallEntryHasAvailableData,
} = require("../scripts/lib/noaa-beta/winter.js");
const {
  buildSnowLiquidTotalInGrid,
  shouldIncludeGrid,
  transformGridAffine,
} = require("../scripts/lib/noaa-beta/winter-slr-grids.js");

const NAN = Number.NaN;

// The independent full-grid scans the builders' counters replaced. Tests below
// assert the folded counter reproduces each scan exactly.
function independentFiniteCount(values) {
  let count = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (Number.isFinite(Number(values[index]))) {
      count += 1;
    }
  }
  return count;
}

const EDGE_GRIDS = {
  allNaN: () => new Float32Array([NAN, NAN, NAN, NAN, NAN, NAN]),
  allFinite: () => new Float32Array([0, -0, 1, 2.5, 100, 1e-45]),
  // Mixed per the predicate's exact rule: -0 is finite, ±Infinity and NaN are
  // not, and 1e39 is f64-finite but rounds to Infinity when stored as f32.
  mixed: () => new Float32Array([NAN, -0, Infinity, -Infinity, 3.5, 1e39]),
  onlyNonFinite: () => new Float32Array([Infinity, -Infinity, NAN]),
};

for (const [name, makeGrid] of Object.entries(EDGE_GRIDS)) {
  test(`transformGridAffine finite tally equals the independent scan (${name})`, () => {
    for (const [scale, offset, min] of [
      [1, 0, null],
      [0.01, 0, null],
      [9 / 5, -459.67, null],
      [M_TO_IN, 0, 0],
    ]) {
      const input = makeGrid();
      const stats = { finiteCount: 0 };
      const counted = transformGridAffine(input, scale, offset, min, stats);
      const plain = transformGridAffine(input, scale, offset, min);
      assert.deepEqual([...counted], [...plain], "returned grid must not change when stats are collected");
      assert.equal(stats.finiteCount, independentFiniteCount(counted));
      // The folded call-site expression must reproduce hasFiniteGridData.
      for (const [width, height] of [
        [counted.length, 1],
        [counted.length + 1, 1],
        [0, 0],
      ]) {
        assert.equal(
          hasGrid(counted, width, height) && stats.finiteCount > 0,
          hasFiniteGridData(counted, width, height),
          `width=${width} height=${height}`,
        );
      }
    }
  });
}

test("transformGridAffine min clamp is applied before the finite tally", () => {
  const stats = { finiteCount: 0 };
  const out = transformGridAffine(new Float32Array([-5, NAN, 2]), 1, 0, 0, stats);
  assert.equal(out[0], 0, "clamped value is finite and counted");
  assert.equal(stats.finiteCount, 2);
  assert.equal(stats.finiteCount, independentFiniteCount(out));
});

test("transformGridAffine leaves stats untouched when the source is missing", () => {
  const stats = { finiteCount: 7 };
  assert.equal(transformGridAffine(null, 1, 0, null, stats), null);
  assert.equal(stats.finiteCount, 7, "no grid built, no tally written");
});

for (const [name, makePair] of Object.entries({
  allNaN: () => [new Float32Array([NAN, NAN, NAN, NAN]), new Float32Array([NAN, NAN, NAN, NAN])],
  allFinite: () => [new Float32Array([5400, 5400, -0, 1e39]), new Float32Array([1000, 900, 800, 700])],
  mixed: () => [new Float32Array([5400, NAN, Infinity, -0]), new Float32Array([1000, 900, 700, NAN])],
})) {
  test(`buildThicknessGrid finite tally equals the independent scan (${name})`, () => {
    const [z500, z1000] = makePair();
    const stats = { finiteCount: 0 };
    const counted = buildThicknessGrid(z500, z1000, stats);
    const plain = buildThicknessGrid(z500, z1000);
    assert.deepEqual([...counted], [...plain], "returned grid must not change when stats are collected");
    assert.equal(stats.finiteCount, independentFiniteCount(counted));
    assert.equal(hasGrid(counted, 2, 2) && stats.finiteCount > 0, hasFiniteGridData(counted, 2, 2));
  });
}

test("buildThicknessGrid rejects mismatched inputs without touching stats", () => {
  const stats = { finiteCount: 3 };
  assert.equal(buildThicknessGrid(new Float32Array(4), new Float32Array(3), stats), null);
  assert.equal(buildThicknessGrid(null, new Float32Array(3), stats), null);
  assert.equal(stats.finiteCount, 3, "no grid built, no tally written");
});

test("buildPrecipAccumulationInGrids per-key tallies equal independent scans", () => {
  const entries = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.kind === "precipAccumulation");
  assert.ok(entries.length > 0, "catalog must define precipitation accumulation entries");
  const gridsByKey = {
    0: new Float32Array([NAN, NAN, NAN, NAN]),
    1: new Float32Array([0, -0, 0, 0]),
    2: new Float32Array([NAN, Infinity, 2, -Infinity]),
  };
  const decoded = {};
  for (const [index, entry] of entries.entries()) {
    decoded[entry.key] = gridsByKey[index % 3];
  }
  const finiteCounts = new Map();
  const counted = buildPrecipAccumulationInGrids(decoded, finiteCounts);
  const plain = buildPrecipAccumulationInGrids(decoded);
  assert.deepEqual(Object.keys(counted), Object.keys(plain));
  for (const entry of entries) {
    assert.deepEqual([...counted[entry.key]], [...plain[entry.key]], `${entry.key} grid must not change`);
    assert.equal(finiteCounts.get(entry.key), independentFiniteCount(counted[entry.key]), entry.key);
    // The folded call-site expression must reproduce hasFiniteGridData,
    // including length-mismatch and absent-grid cases.
    for (const [width, height] of [
      [2, 2],
      [3, 2],
    ]) {
      const values = counted[entry.key];
      assert.equal(
        hasGrid(values, width, height) && (finiteCounts.get(entry.key) || 0) > 0,
        hasFiniteGridData(values, width, height),
        `${entry.key} width=${width} height=${height}`,
      );
    }
  }
  assert.equal(hasGrid(counted.missing, 2, 2) && (finiteCounts.get("missing") || 0) > 0, false);
  assert.equal(hasFiniteGridData(counted.missing, 2, 2), false);
});

for (const [name, makeGrid] of Object.entries(EDGE_GRIDS)) {
  test(`buildSnowLiquidTotalInGrid finite tally equals the independent scan (${name})`, () => {
    const grid = makeGrid();
    const stats = { finiteCount: 0 };
    const counted = buildSnowLiquidTotalInGrid({ [SNOW_LIQUID_TOTAL_KEY]: grid }, grid.length, 1, stats);
    assert.ok(counted instanceof Float32Array);
    assert.equal(stats.finiteCount, independentFiniteCount(counted));
    assert.equal(stats.finiteCount > 0, hasFiniteGridData(counted, grid.length, 1));
  });
}

test("buildSnowLiquidTotalInGrid leaves stats untouched on null results", () => {
  for (const decoded of [
    {},
    { [SNOW_LIQUID_TOTAL_KEY]: new Float32Array(3) }, // wrong length
  ]) {
    const stats = { finiteCount: 5 };
    assert.equal(buildSnowLiquidTotalInGrid(decoded, 2, 2, stats), null);
    assert.equal(stats.finiteCount, 5, "no grid built, no tally written");
    assert.equal(hasFiniteGridData(null, 2, 2), false);
  }
  const stats = { finiteCount: 0 };
  assert.equal(buildSnowLiquidTotalInGrid({ [SNOW_LIQUID_TOTAL_KEY]: new Float32Array(4) }, 0, 0, stats), null);
  assert.equal(stats.finiteCount, 0);
});

test("resolveCachedHeightDamGrid tally equals the independent scan, with and without masking", () => {
  const entry = { key: "height500", inputKey: "height500", contourLevelMb: 500 };
  const mixed = new Float32Array([5400, NAN, -0, Infinity, 1e39, 5000, NAN, 5300, 5200]);
  const decoded = { height500: mixed };
  const cache = new Map();
  const resolved = resolveCachedHeightDamGrid({ entry, decoded, cache, width: 3, height: 3 });
  assert.ok(resolved.values instanceof Float32Array);
  assert.equal(resolved.finiteCount, independentFiniteCount(resolved.values));
  assert.equal(hasGrid(resolved.values, 3, 3) && resolved.finiteCount > 0, hasFiniteGridData(resolved.values, 3, 3));
  assert.equal(
    resolveCachedHeightDamGrid({ entry, decoded, cache, width: 3, height: 3 }),
    resolved,
    "cache hit returns the same resolved entry",
  );

  // Below-terrain masking: every cell below terrain becomes NaN before the
  // transform, so the tally must drop to zero exactly like the scan would.
  const maskedDecoded = {
    height500: mixed,
    profileSurfaceHeight: new Float32Array(9).fill(99999),
  };
  const masked = resolveCachedHeightDamGrid({ entry, decoded: maskedDecoded, cache: new Map(), width: 3, height: 3 });
  assert.equal(masked.finiteCount, 0);
  assert.equal(masked.finiteCount, independentFiniteCount(masked.values));
  assert.equal(hasGrid(masked.values, 3, 3) && masked.finiteCount > 0, hasFiniteGridData(masked.values, 3, 3));

  const missing = resolveCachedHeightDamGrid({ entry, decoded: {}, cache: new Map(), width: 3, height: 3 });
  assert.deepEqual(missing, { values: null, finiteCount: 0 });
  assert.equal(hasFiniteGridData(missing.values, 3, 3), false);
});

test("buildSnowfallInGrids snowHrrrAsnow gate matches the removed shouldIncludeGrid scan", () => {
  const selection = { catalog: [], availableParameters: ["snowHrrrAsnow"] };
  const bounds = { north: 41, south: 39, west: -100, east: -99 };
  for (const [name, makeGrid] of Object.entries(EDGE_GRIDS)) {
    const input = makeGrid();
    const snowfallIn = buildSnowfallInGrids({
      decoded: { snowHrrrAsnow: input },
      selection,
      bounds,
      width: input.length,
      height: 1,
    });
    // Independent recompute of the removed scan on an independently built grid.
    const expectedGrid = transformGridAffine(input, M_TO_IN, 0, 0);
    const expectedIncluded = shouldIncludeGrid(expectedGrid);
    assert.equal(Boolean(snowfallIn.snowHrrrAsnow), expectedIncluded, name);
    if (expectedIncluded) {
      assert.deepEqual([...snowfallIn.snowHrrrAsnow], [...expectedGrid], name);
    }
  }
});

test("buildSnowfallInGrids snow-liquid gate keeps all-NaN frames empty", () => {
  const selection = { catalog: [], availableParameters: ["snow10to1"] };
  const bounds = { north: 41, south: 39, west: -100, east: -99 };
  const empty = buildSnowfallInGrids({
    decoded: { [SNOW_LIQUID_TOTAL_KEY]: new Float32Array([NAN, NAN, NAN, NAN]) },
    selection,
    bounds,
    width: 2,
    height: 2,
  });
  assert.deepEqual(Object.keys(empty), []);
  const dry = buildSnowfallInGrids({
    decoded: { [SNOW_LIQUID_TOTAL_KEY]: new Float32Array([0, 0, 0, 0]) },
    selection,
    bounds,
    width: 2,
    height: 2,
  });
  assert.ok(dry.snow10to1 instanceof Float32Array, "finite dry-zero liquid still derives a grid");
});

test("snowfallEntryHasAvailableData dry verdict treats non-finite-only liquid as missing", () => {
  const entry = NOAA_NAM_PARAMETER_CATALOG.find((candidate) => candidate.key === "snow10to1");
  assert.ok(entry);
  const verdict = (grid) =>
    snowfallEntryHasAvailableData({
      entry,
      decoded: { [SNOW_LIQUID_TOTAL_KEY]: grid },
      values: null,
      width: grid.length,
      height: 1,
    });
  assert.equal(verdict(new Float32Array([NAN, NAN])), false, "all-NaN liquid is not available");
  assert.equal(verdict(new Float32Array([Infinity, Infinity])), false, "infinities are not finite liquid");
  // The min=0 clamp turns -Infinity into finite 0 before finiteness is
  // judged — the removed hasFiniteGridData scan saw the identical grid.
  assert.equal(verdict(new Float32Array([Infinity, -Infinity])), true, "clamped -Infinity is finite dry zero");
  assert.equal(verdict(new Float32Array([NAN, -0])), true, "finite dry-zero liquid stays available");
  assert.equal(verdict(new Float32Array([Infinity, 0])), true, "one finite dry cell is enough");
});

test("reflectivity availability reuses one scan for both layer keys", () => {
  const render = (reflectivityComposite) =>
    buildRenderedArtifacts({
      decoded: { reflectivityComposite },
      selection: { catalog: [], availableParameters: [], records: {} },
      framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
      bounds: { north: 53, south: 21, west: -129, east: -63 },
      modelKey: "gfs",
      width: 2,
      height: 2,
      reflectivityGates: [15],
      pngCompressionLevel: 1,
      pngFilterType: 0,
    });
  const missing = render(new Float32Array([NAN, NAN, NAN, NAN]));
  assert.equal(missing.parameterAvailability.reflectivityComposite, "unavailable");
  assert.equal(missing.parameterAvailability.reflectivity, "unavailable");
  const present = render(new Float32Array([NAN, 20, NAN, NAN]));
  assert.equal(present.parameterAvailability.reflectivityComposite, "available");
  assert.equal(present.parameterAvailability.reflectivity, "available");
  const absent = render(null);
  assert.equal(absent.parameterAvailability.reflectivityComposite, "unavailable");
  assert.equal(absent.parameterAvailability.reflectivity, "unavailable");
});
