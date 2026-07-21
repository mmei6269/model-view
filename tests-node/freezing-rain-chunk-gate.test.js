"use strict";

// The freezing-rain/FRAM builder must treat an incomplete liquid chunk set as
// unknown: when any chunk's liquid grid fails to compose, no freezing-rain
// liquid or FRAM output may be emitted (a partial sum would render
// underestimated ice as valid data — plan.md's NaN-as-unknown rule). The
// snowfall-delta path has carried this gate for months; this suite pins the
// FRAM-side gate added after an audit found it missing, using the
// MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK fault-injection hook with a healthy-run
// engagement control so the assertions can never go vacuous.

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const winter = require(path.join(ROOT, "scripts/lib/noaa-beta/winter.js"));
const { getNoaaGribModelConfig } = require(path.join(ROOT, "scripts/lib/noaa-beta/model-config.js"));

const TARGET_HOUR = 6;
const WIDTH = 2;
const HEIGHT = 1;
const CELLS = WIDTH * HEIGHT;

function buildScenario() {
  // One direct cumulative FRZR record covering 0-6h; its decoded grid arrives
  // through the source-grid override path, so the healthy run is hermetic.
  const frzrRecord = {
    record: "1",
    param: "FRZR",
    level: "surface",
    forecast: "0-6 hour acc fcst",
  };
  const decoded = {
    freezingRain: new Float32Array([2.5, 0]),
    temperature2m: new Float32Array([268.15, 268.15]),
    dewpoint2m: new Float32Array([267.15, 267.15]),
    humidity2m: new Float32Array([90, 90]),
    windU10m: new Float32Array([5, 5]),
    windV10m: new Float32Array([0, 0]),
  };
  return {
    modelKey: "hrrr",
    modelConfig: getNoaaGribModelConfig("hrrr"),
    baseUrl: "https://noaa.invalid/",
    date: "20260101",
    cycle: "00",
    targetHour: TARGET_HOUR,
    currentRecords: [frzrRecord],
    latestMetadata: { hours: [0, TARGET_HOUR] },
    rawCacheDir: null,
    tempDir: null,
    wgrib2Path: null,
    bounds: null,
    width: WIDTH,
    height: HEIGHT,
    rangeFetchConcurrency: 1,
    rangeFetchLimiter: null,
    decodeConcurrency: 1,
    decoded,
    selection: {
      availableParameters: ["freezingRainLiquidTotal", "framFlatIce", "framRadialIce"],
      records: { freezingRain: frzrRecord },
    },
    profile: { stages: {} },
  };
}

test("healthy chunk set emits freezing-rain liquid and FRAM grids (engagement control)", async () => {
  delete process.env.MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK;
  const scenario = buildScenario();
  const out = await winter.buildFreezingRainAccumulationGrids(scenario);
  assert.ok(out.freezingRainLiquidTotal instanceof Float32Array, "liquid total should be emitted");
  assert.ok(Math.abs(out.freezingRainLiquidTotal[0] - 2.5 * 0.0393700787) < 1e-6, "liquid total converts mm to inches");
  assert.ok(out.framFlatIce instanceof Float32Array, "FRAM flat ice should be emitted");
  assert.ok(out.framRadialIce instanceof Float32Array, "FRAM radial ice should be emitted");
  assert.ok(out.framFlatIce[0] > 0, "cold windy cell with liquid should accrete ice");
  assert.equal(scenario.profile.freezingRainLiquidChunkGaps, undefined, "no gap counted on the healthy path");
});

test("incomplete chunk set omits freezing-rain liquid and FRAM outputs entirely", async (t) => {
  process.env.MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK = "1";
  t.after(() => {
    delete process.env.MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK;
  });
  const scenario = buildScenario();
  const out = await winter.buildFreezingRainAccumulationGrids(scenario);
  assert.deepStrictEqual(Object.keys(out), [], "no outputs may be built from a partial chunk set");
  assert.equal(scenario.profile.freezingRainLiquidChunkGaps, 1, "the gate must record the gap (engagement proof)");
});

test("hasIncompleteLiquidChunks matches the missing/short/complete cases", () => {
  const chunkA = { key: "a" };
  const chunkB = { key: "b" };
  const full = new Float32Array(CELLS);
  const short = new Float32Array(CELLS - 1);
  const complete = new Map([
    ["a", full],
    ["b", full],
  ]);
  assert.equal(winter.hasIncompleteLiquidChunks([chunkA, chunkB], complete, CELLS), false);
  assert.equal(winter.hasIncompleteLiquidChunks([chunkA, chunkB], new Map([["a", full]]), CELLS), true);
  assert.equal(
    winter.hasIncompleteLiquidChunks(
      [chunkA, chunkB],
      new Map([
        ["a", full],
        ["b", short],
      ]),
      CELLS,
    ),
    true,
  );
  assert.equal(
    winter.hasIncompleteLiquidChunks(
      [chunkA, chunkB],
      new Map([
        ["a", full],
        ["b", null],
      ]),
      CELLS,
    ),
    true,
  );
});
