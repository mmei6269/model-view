"use strict";

// Winter renderer semantics pinned after the renderer audit:
//  1. Learned SLR methods (Pletcher RF, western linear) may skip a trace
//     liquid chunk only while the cell's RUNNING skipped-liquid total stays
//     below the 0.1in/60 visibility floor — the old per-chunk skip could omit
//     unbounded accumulated snow (4 trace chunks x SLR 20 = 0.128in), breaking
//     plan.md's bounded-heuristic rule.
//  2. Sparse (activeIndices) and dense visits of the same liquid grid must
//     produce the same FRAM/SLR grids: invalid SLR marks a cell NaN in both
//     modes, and the FRAM null-vs-grid decision is descriptor-based so an
//     all-failed environment can no longer flip the return shape with grid-wide
//     snow coverage.
//  3. FRAM multi-hour chunks weight per-hour surface environments exactly, and
//     a cell with a missing environment segment is unknown (NaN), never zero.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const {
  MAX_SNOW_TO_LIQUID_RATIO,
  MIN_VISIBLE_SNOW_LIQUID_IN,
  SNOWFALL_RENDER_THRESHOLD_IN,
  buildIntervalSnowfallGridsForEntries,
  buildSnowRfConusSnowfallGrid,
  buildWesternLinearSnowfallGrid,
} = require(path.join(ROOT, "scripts/lib/noaa-beta/winter-slr-grids.js"));
const { buildFramIceGrids, buildFramIceGridsFromChunks, calculateFramIceLiquidRatio } = require(
  path.join(ROOT, "scripts/lib/noaa-beta/winter-fram.js"),
);
const { buildLiquidChunkDescriptors } = require(path.join(ROOT, "scripts/lib/noaa-beta/winter-sparse.js"));
const { latLonForGridIndex, predictLinearSlr, predictRandomForest } = require(
  path.join(ROOT, "scripts/lib/noaa-beta/slr-methods.js"),
);
const { loadSnowRfModel, loadWesternLinearSlrModel } = require(path.join(ROOT, "scripts/lib/noaa-beta/selection.js"));
const { wetBulbTemperatureC } = require(path.join(ROOT, "scripts/lib/noaa-beta/thermo.js"));
const { MPS_TO_KT } = require(path.join(ROOT, "scripts/lib/noaa-beta/util.js"));
const { SNOW_PROFILE_LEVELS } = require(path.join(ROOT, "scripts/lib/noaa-nam-parameter-catalog"));

const BOUNDS = { west: -105, east: -104, south: 39, north: 40 };
const TRACE_LIQUID_IN = 0.001;

function f32(value) {
  return new Float32Array([value])[0];
}

// Constant-value winter profile: every AGL interpolation returns tmpK / windMps
// exactly, so feature vectors are known without re-deriving the interpolation.
function buildWinterProfile(cellCount, tmpKPerCell = 260) {
  const perCell = (value) =>
    new Float32Array(cellCount)
      .fill(typeof value === "function" ? 0 : value)
      .map((_, index) => (typeof value === "function" ? value(index) : value));
  const decoded = {
    profileSurfaceHeight: perCell(1500),
    temperature2m: perCell(tmpKPerCell),
    humidity2m: perCell(90),
    windU10m: perCell(5),
    windV10m: perCell(0),
  };
  let heightM = 1600;
  for (const level of SNOW_PROFILE_LEVELS) {
    decoded[`profileHgt${level}`] = perCell(heightM);
    decoded[`profileTmp${level}`] = perCell(tmpKPerCell);
    decoded[`profileRh${level}`] = perCell(90);
    decoded[`profileU${level}`] = perCell(5);
    decoded[`profileV${level}`] = perCell(0);
    heightM += 250;
  }
  return decoded;
}

function buildIntervalWesternSnowfall(liquids) {
  return buildIntervalSnowfallGridsForEntries({
    entries: [{ key: "snowWesternLinear" }],
    chunkDescriptors: liquids.map((liquid, index) => ({
      chunk: { key: `chunk${index}`, profileHour: index + 1 },
      liquidIn: new Float32Array([liquid]),
      activeIndices: null,
    })),
    profilesByHour: new Map(),
    decoded: buildWinterProfile(1),
    bounds: BOUNDS,
    width: 1,
    height: 1,
  }).get("snowWesternLinear");
}

function assertGridSame(actual, expected, message) {
  assert.ok(actual, `${message}: grid missing`);
  assert.equal(actual.length, expected.length, `${message}: length`);
  for (let index = 0; index < expected.length; index += 1) {
    const same =
      Object.is(actual[index], expected[index]) || (Number.isNaN(actual[index]) && Number.isNaN(expected[index]));
    assert.ok(same, `${message}: cell ${index} is ${actual[index]}, expected ${expected[index]}`);
  }
}

test("learned SLR trace skip follows the running skipped-liquid total", () => {
  assert.ok(TRACE_LIQUID_IN <= MIN_VISIBLE_SNOW_LIQUID_IN, "fixture liquid must be sub-visible");
  const model = loadWesternLinearSlrModel();
  const slr = Math.min(60, Math.max(1, predictLinearSlr(model, [260, 260, 5, 5])));
  assert.ok(Number.isFinite(slr) && slr > 0, "fixture SLR must be valid");

  // A single sub-visible chunk is skipped: its snow cannot reach 0.1in.
  assert.equal(buildIntervalWesternSnowfall([TRACE_LIQUID_IN])[0], 0);
  // The second chunk crosses the running-total floor and computes normally.
  assert.ok(
    Math.abs(buildIntervalWesternSnowfall([TRACE_LIQUID_IN, TRACE_LIQUID_IN])[0] - TRACE_LIQUID_IN * slr) < 1e-6,
  );
  // Four trace chunks: only the first stays omitted (bounded <= 0.1in at the cap).
  const quad = buildIntervalWesternSnowfall([TRACE_LIQUID_IN, TRACE_LIQUID_IN, TRACE_LIQUID_IN, TRACE_LIQUID_IN]);
  assert.ok(Math.abs(quad[0] - 3 * TRACE_LIQUID_IN * slr) < 1e-6);
  // Above-floor liquid computes immediately without touching the tracker.
  assert.ok(Math.abs(buildIntervalWesternSnowfall([0.01])[0] - 0.01 * slr) < 1e-6);
  // A trace chunk after visible snow is still governed by its own running total.
  assert.ok(Math.abs(buildIntervalWesternSnowfall([0.01, TRACE_LIQUID_IN])[0] - 0.01 * slr) < 1e-6);
});

test("learned SLR trace skip does not round source-f32 liquid below the visibility floor", () => {
  const model = loadWesternLinearSlrModel();
  const slr = Math.min(60, Math.max(1, predictLinearSlr(model, [260, 260, 5, 5])));
  const boundaryChunk = f32(MIN_VISIBLE_SNOW_LIQUID_IN / 12);
  const liquids = new Array(23).fill(boundaryChunk);

  // The first 11 chunks remain safely sub-visible at the maximum allowed SLR,
  // but including the 12th crosses the threshold. A Float32 running total
  // rounds that crossing down and incorrectly skips one extra chunk.
  assert.ok(11 * boundaryChunk * MAX_SNOW_TO_LIQUID_RATIO < SNOWFALL_RENDER_THRESHOLD_IN);
  assert.ok(12 * boundaryChunk * MAX_SNOW_TO_LIQUID_RATIO > SNOWFALL_RENDER_THRESHOLD_IN);

  const snow = buildIntervalWesternSnowfall(liquids);
  assert.ok(Math.abs(snow[0] - 12 * boundaryChunk * slr) < 1e-6);
});

test("learned RF trace skip follows the running skipped-liquid total", () => {
  const model = loadSnowRfModel("conus");
  assert.ok(model, "conus RF artifact must load");
  const latLon = latLonForGridIndex(0, BOUNDS, 1, 1);
  const features = [
    ...new Array(8).fill(5),
    ...new Array(8).fill(260),
    ...new Array(8).fill(90),
    1500,
    latLon.lat,
    latLon.lon,
  ];
  const slr = Math.min(60, Math.max(1, predictRandomForest(model, features)));
  assert.ok(Number.isFinite(slr) && slr > 0, "fixture RF SLR must be valid");

  const build = (liquids) =>
    buildIntervalSnowfallGridsForEntries({
      entries: [{ key: "snowRfConus" }],
      chunkDescriptors: liquids.map((liquid, index) => ({
        chunk: { key: `chunk${index}`, profileHour: index + 1 },
        liquidIn: new Float32Array([liquid]),
        activeIndices: null,
      })),
      profilesByHour: new Map(),
      decoded: buildWinterProfile(1),
      bounds: BOUNDS,
      width: 1,
      height: 1,
    }).get("snowRfConus");

  assert.equal(build([TRACE_LIQUID_IN])[0], 0);
  assert.ok(Math.abs(build([TRACE_LIQUID_IN, TRACE_LIQUID_IN])[0] - TRACE_LIQUID_IN * slr) < 1e-6);
});

test("FRAM sparse and dense visits return identical grids with a valid environment", () => {
  const liquid = new Float32Array([0.2, 0, Number.NaN, 0, 0, 0, 0, 0]);
  const chunks = [{ key: "chunk", startHour: 0, endHour: 1, profileHour: 1 }];
  const liquidByChunk = new Map([["chunk", liquid]]);
  const environment = {
    temperature2m: new Float32Array(8).fill(268.15),
    dewpoint2m: new Float32Array(8).fill(268.15),
    windU10m: new Float32Array(8).fill(5),
    windV10m: new Float32Array(8).fill(0),
  };
  const base = {
    chunks,
    liquidByChunk,
    profilesByHour: new Map([[1, environment]]),
    decoded: {},
    width: 8,
    height: 1,
  };
  const sparse = buildFramIceGridsFromChunks({
    ...base,
    chunkDescriptors: buildLiquidChunkDescriptors({ chunks, liquidByChunk, width: 8, height: 1, threshold: 0 }),
  });
  const dense = buildFramIceGridsFromChunks({
    ...base,
    chunkDescriptors: [{ chunk: chunks[0], liquidIn: liquid, activeIndices: null }],
  });

  assert.ok(sparse.flat && dense.flat, "both modes must return grids");
  assert.ok(sparse.flat[0] > 0, "the liquid cell accretes ice");
  assertGridSame(sparse.flat, dense.flat, "FRAM flat sparse vs dense");
  assertGridSame(sparse.radial, dense.radial, "FRAM radial sparse vs dense");
});

test("FRAM sparse and dense visits return identical grids when every active cell fails", () => {
  const liquid = new Float32Array([0.2, 0, Number.NaN, 0, 0, 0, 0, 0]);
  const chunks = [{ key: "chunk", startHour: 0, endHour: 1, profileHour: 1 }];
  const liquidByChunk = new Map([["chunk", liquid]]);
  const base = { chunks, liquidByChunk, profilesByHour: new Map(), decoded: {}, width: 8, height: 1 };
  const sparse = buildFramIceGridsFromChunks({
    ...base,
    chunkDescriptors: buildLiquidChunkDescriptors({ chunks, liquidByChunk, width: 8, height: 1, threshold: 0 }),
  });
  const dense = buildFramIceGridsFromChunks({
    ...base,
    chunkDescriptors: [{ chunk: chunks[0], liquidIn: liquid, activeIndices: null }],
  });

  // Descriptor present in both modes: same return shape (grids), and the only
  // finite cells are the unvisited/zero-liquid zeros; positive and unknown
  // liquid cells are NaN because the environment is missing.
  assert.ok(sparse.flat && dense.flat, "all-fail environment must not flip the return shape by visit mode");
  const expected = new Float32Array(8).fill(0);
  expected[0] = Number.NaN;
  expected[2] = Number.NaN;
  assertGridSame(sparse.flat, expected, "FRAM all-fail sparse flat");
  assertGridSame(dense.flat, expected, "FRAM all-fail dense flat");
  assertGridSame(sparse.radial, expected, "FRAM all-fail sparse radial");
  assertGridSame(dense.radial, expected, "FRAM all-fail dense radial");
});

test("single-shot western-linear grids match between sparse and dense visits, including invalid SLR", () => {
  const cellCount = 8;
  // Cell 1 is warm enough that the regression goes non-positive: unknown, not 0.
  const decoded = buildWinterProfile(cellCount, (index) => (index === 1 ? 300 : 260));
  const liquid = new Float32Array([0.05, 0.02, 0, Number.NaN, 0.03, 0.1, TRACE_LIQUID_IN, 0.04]);
  const activeIndices = new Uint32Array([0, 1, 3, 4, 5, 6, 7]);
  const base = { decoded, snowLiquidIn: liquid, bounds: BOUNDS, width: cellCount, height: 1 };
  const dense = buildWesternLinearSnowfallGrid({ ...base, activeIndices: null });
  const sparse = buildWesternLinearSnowfallGrid({ ...base, activeIndices });

  const model = loadWesternLinearSlrModel();
  const expected = new Float32Array(cellCount).fill(0);
  for (let index = 0; index < cellCount; index += 1) {
    const cellLiquid = liquid[index];
    if (!Number.isFinite(cellLiquid)) {
      expected[index] = Number.NaN;
      continue;
    }
    if (cellLiquid <= MIN_VISIBLE_SNOW_LIQUID_IN) {
      expected[index] = 0;
      continue;
    }
    const tmpK = index === 1 ? 300 : 260;
    const slr = predictLinearSlr(model, [tmpK, tmpK, 5, 5]);
    expected[index] = Number.isFinite(slr) && slr > 0 ? cellLiquid * Math.min(60, Math.max(1, slr)) : Number.NaN;
  }
  assert.ok(Number.isNaN(expected[1]), "fixture must exercise the invalid-SLR branch");
  assertGridSame(dense, expected, "western dense vs expected");
  assertGridSame(sparse, expected, "western sparse vs expected");
});

test("single-shot RF grids match between sparse and dense visits", () => {
  const cellCount = 8;
  const decoded = buildWinterProfile(cellCount);
  const liquid = new Float32Array([0.05, 0, 0.03, Number.NaN, 0.02, 0.01, 0.04, TRACE_LIQUID_IN]);
  const activeIndices = new Uint32Array([0, 2, 3, 4, 5, 6, 7]);
  const base = { decoded, snowLiquidIn: liquid, bounds: BOUNDS, width: cellCount, height: 1 };
  const dense = buildSnowRfConusSnowfallGrid({ ...base, activeIndices: null });
  const sparse = buildSnowRfConusSnowfallGrid({ ...base, activeIndices });

  assert.ok(dense && sparse, "RF model must produce grids");
  assert.ok(dense[0] > 0, "fixture must produce RF snow");
  assertGridSame(sparse, dense, "RF sparse vs dense");
});

test("FRAM multi-hour chunks weight per-hour environments exactly", () => {
  const liquid = new Float32Array([0.5, 0.5]);
  const coldProfile = {
    temperature2m: new Float32Array([268.15, 268.15]),
    dewpoint2m: new Float32Array([268.15, 268.15]),
    windU10m: new Float32Array([5, 5]),
    windV10m: new Float32Array([0, 0]),
  };
  const warmProfile = {
    temperature2m: new Float32Array([272.95, 272.95]),
    dewpoint2m: new Float32Array([272.95, 272.95]),
    // Cell 1 loses its warm-hour wind: that segment's environment is unknown.
    windU10m: new Float32Array([5, Number.NaN]),
    windV10m: new Float32Array([0, 0]),
  };
  const chunk = { key: "chunk", startHour: 0, endHour: 2, profileHour: 2, profileHours: [1, 2] };
  const result = buildFramIceGridsFromChunks({
    chunks: [chunk],
    chunkDescriptors: [{ chunk, liquidIn: liquid, activeIndices: null }],
    liquidByChunk: new Map([["chunk", liquid]]),
    profilesByHour: new Map([
      [1, coldProfile],
      [2, warmProfile],
    ]),
    decoded: {},
    width: 2,
    height: 1,
  });

  const rateInHr = 0.5 / 2;
  const coldIlr = calculateFramIceLiquidRatio(rateInHr, wetBulbTemperatureC(f32(268.15), f32(268.15)), 5 * MPS_TO_KT);
  const warmIlr = calculateFramIceLiquidRatio(rateInHr, wetBulbTemperatureC(f32(272.95), f32(272.95)), 5 * MPS_TO_KT);
  assert.ok(
    Number.isFinite(coldIlr) && Number.isFinite(warmIlr) && coldIlr !== warmIlr,
    "fixture must split the segments",
  );
  const expected = 0.5 * (0.5 * coldIlr + 0.5 * warmIlr);
  assert.ok(Math.abs(result.flat[0] - expected) < 1e-6, `flat ${result.flat[0]} vs ${expected}`);
  assert.ok(Math.abs(result.radial[0] - expected * 0.394) < 1e-6, "radial is 0.394 x flat");
  assert.ok(Number.isNaN(result.flat[1]), "a missing environment segment makes the cell unknown");
  assert.ok(Number.isNaN(result.radial[1]), "radial follows flat");
});

test("FRAM single-shot fallback keeps non-finite liquid unknown", () => {
  const decoded = {
    temperature2m: new Float32Array([268.15, 268.15, 268.15]),
    dewpoint2m: new Float32Array([268.15, 268.15, 268.15]),
    windU10m: new Float32Array([5, 5, 5]),
    windV10m: new Float32Array([0, 0, 0]),
  };
  const liquid = new Float32Array([Number.NaN, 0, 0.5]);
  const result = buildFramIceGrids(decoded, { records: {} }, liquid, 3);

  assert.ok(Number.isNaN(result.flat[0]), "non-finite liquid is unknown, not zero");
  assert.ok(Number.isNaN(result.radial[0]), "radial follows flat");
  assert.equal(result.flat[1], 0, "zero liquid stays zero ice");
  assert.ok(result.flat[2] > 0, "positive liquid accretes ice");
});
