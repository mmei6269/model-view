"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { loadParcelKernelVariant } = require("../scripts/lib/noaa-beta/parcel-kernel");
const severe = require("../scripts/lib/noaa-beta/severe");

// Validation contract for the f32x4 SIMD origin scan (owner-approved
// relaxed tolerance, 2026-07-12). Measured on this exact seed:
// 33,417/33,417 layered-classification agreement, zero base/top row flips,
// max |dCAPE| 0.071 J/kg, max |dCIN| 0.012 J/kg, base/top within 1.3e-4 m
// (f32 rounding of identical row heights), EL within 0.43 m (interpolated
// crossing). Assertion bounds below sit ~5-10x above those measurements so
// the test tolerates FP-environment variation while still catching any
// semantic regression by orders of magnitude.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildProfile(rand) {
  const rowCount = 5 + Math.floor(rand() * 16);
  const rows = [];
  let height = 0;
  let pressure = 950 + rand() * 90;
  let temp = 270 + rand() * 40;
  for (let index = 0; index < rowCount; index += 1) {
    const spread = rand() * 25;
    rows.push({ height, pressure, temp, dewpoint: rand() < 0.05 ? Number.NaN : temp - spread });
    height += 50 + rand() * 900;
    pressure -= 5 + rand() * 60;
    temp -= rand() * 9 - 0.5;
    if (pressure <= 110) {
      break;
    }
  }
  return rows;
}

test("f32x4 origin scan matches the JS f64 scan within the documented tolerance", () => {
  const kernel = loadParcelKernelVariant("wasm-f32");
  assert.ok(kernel, "tracked parcel-kernel.wasm must load for SIMD WASM parity coverage");
  const jsScratch = severe.createEffectiveDiagnosticsScratch(24, { useKernel: false });
  const rand = mulberry32(0xf00d);
  let layered = 0;
  let nulls = 0;
  let rowFlips = 0;
  let maxCapeDelta = 0;
  let maxCinDelta = 0;
  let maxBoundDelta = 0;
  let maxElDelta = 0;
  for (let trial = 0; trial < 40000; trial += 1) {
    const rows = buildProfile(rand);
    for (let index = 0; index < rows.length; index += 1) {
      jsScratch.heights[index] = rows[index].height;
      jsScratch.pressure[index] = rows[index].pressure;
      jsScratch.temp[index] = rows[index].temp;
      jsScratch.dewpoint[index] = rows[index].dewpoint;
      jsScratch.u[index] = 0;
      jsScratch.v[index] = 0;
      kernel.views.heights[index] = rows[index].height;
      kernel.views.pressure[index] = rows[index].pressure;
      kernel.views.temp[index] = rows[index].temp;
      kernel.views.dewpoint[index] = rows[index].dewpoint;
    }
    const expected = severe.calculateEffectiveParcelLayerFromRows(jsScratch, rows.length);
    const found = kernel.runOriginScan(rows.length, 300, 25, 4000, 100, -250);
    assert.equal(Boolean(found), Boolean(expected), `trial ${trial}: layered classification must agree`);
    if (!expected) {
      nulls += 1;
      continue;
    }
    layered += 1;
    const out = kernel.views.out;
    if (Math.abs(out[1] - expected.baseAglM) > 0.5 || Math.abs(out[2] - expected.topAglM) > 0.5) {
      rowFlips += 1;
      continue;
    }
    maxBoundDelta = Math.max(maxBoundDelta, Math.abs(out[1] - expected.baseAglM), Math.abs(out[2] - expected.topAglM));
    maxCapeDelta = Math.max(maxCapeDelta, Math.abs(out[3] - expected.muCapeJkg));
    maxCinDelta = Math.max(maxCinDelta, Math.abs(out[4] - expected.muCinJkg));
    if (Number.isFinite(expected.muElAglM)) {
      maxElDelta = Math.max(maxElDelta, Math.abs(out[5] - expected.muElAglM));
    }
  }
  assert.ok(layered > 10000, `layered sample too small: ${layered}`);
  assert.ok(nulls > 2000, `null sample too small: ${nulls}`);
  assert.ok(rowFlips / layered <= 0.001, `base/top row flips ${rowFlips}/${layered} exceed 0.1%`);
  assert.ok(maxCapeDelta <= 0.5, `max |dCAPE| ${maxCapeDelta} J/kg exceeds 0.5`);
  assert.ok(maxCinDelta <= 0.1, `max |dCIN| ${maxCinDelta} J/kg exceeds 0.1`);
  assert.ok(maxBoundDelta <= 0.01, `max base/top delta ${maxBoundDelta} m exceeds 0.01`);
  assert.ok(maxElDelta <= 5, `max EL delta ${maxElDelta} m exceeds 5`);
});

test("f32 DCAPE port matches the JS reduced-profile DCAPE within the documented tolerance", () => {
  const kernel = loadParcelKernelVariant("wasm-f32");
  assert.ok(kernel?.dcape, "tracked parcel-kernel.wasm must expose the f32 DCAPE parity port");
  // Measured on this seed: 40,000/40,000 valid-classification agreement,
  // max |delta| 0.008 J/kg, zero source-layer flips. On real frames the
  // documented residual is ~0.16% of cells at +-1 J/kg (hover quantization
  // edges) and ~3-4 cells per 1.57M-cell frame flipping between near-tied
  // (~1e-5 relative) 100-mb source layers - both physically valid choices.
  const rand = mulberry32(0xdca9e);
  const LEVELS = [1000, 925, 850, 700, 500, 300];
  const dcapeScratch = {
    heights: new Float64Array(8),
    temps: new Float64Array(8),
    pressures: new Float64Array(8),
    dewpoints: new Float64Array(8),
    thetaE: new Float64Array(8),
  };
  let bothValued = 0;
  let maxDelta = 0;
  for (let trial = 0; trial < 40000; trial += 1) {
    const elevation = rand() * 2200;
    const surfaceTemp = 272 + rand() * 36;
    const surfacePressure = 1015 - elevation * 0.11 + rand() * 10;
    const sources = LEVELS.map((level) => {
      const approxHeight = Math.max(elevation + 10, (1013 - level) * 9.2 + rand() * 300 - 150);
      return {
        level,
        hgt: new Float64Array([approxHeight]),
        tmp: new Float64Array([300 - approxHeight * 0.0065 + rand() * 8 - 4]),
        rh: new Float64Array([2 + rand() * 96]),
        u: null,
        v: null,
      };
    });
    if (rand() < 0.1) {
      sources[1].rh = null;
    }
    if (rand() < 0.05) {
      sources[2].hgt = new Float64Array([Number.NaN]);
    }
    const jsValue = severe.calculateReducedProfileDcapeFromSources(
      sources,
      0,
      elevation,
      surfaceTemp,
      surfacePressure,
      dcapeScratch,
    );
    const port = kernel.dcape;
    let count = 0;
    for (const source of sources) {
      port.levels[count] = Number(source.level);
      port.hgt[count] = source.hgt ? source.hgt[0] : Number.NaN;
      port.tmp[count] = source.tmp ? source.tmp[0] : Number.NaN;
      port.rh[count] = source.rh ? source.rh[0] : Number.NaN;
      count += 1;
    }
    const kernelValue = port.compute(count, elevation, surfaceTemp, surfacePressure, 400, 100);
    assert.equal(
      Number.isFinite(kernelValue),
      Number.isFinite(jsValue),
      `trial ${trial}: DCAPE validity classification must agree`,
    );
    if (!Number.isFinite(jsValue)) {
      continue;
    }
    bothValued += 1;
    const delta = Math.abs(Math.max(0, jsValue) - Math.max(0, kernelValue));
    maxDelta = Math.max(maxDelta, delta);
  }
  assert.ok(bothValued > 20000, `valued sample too small: ${bothValued}`);
  assert.ok(maxDelta <= 0.5, `max DCAPE delta ${maxDelta} J/kg exceeds 0.5`);
});
