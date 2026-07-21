"use strict";

// Point-sounding scratch rows can carry NaN winds (a level whose UGRD/VGRD
// record is absent passes the height/pressure-only scratch fill), and one
// such row must not NaN-poison layer means or SRH — the sibling accumulators
// (interpolateProfileWindRows, calculateMeanWindByPressureFromRows) already
// skip windless rows. Gridded scratch fill rejects non-finite winds upstream,
// so these guards are point-path-only by construction (16-frame golden
// parity holds).

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calculateHeightMeanWindInLayerFromRows,
  calculateStormRelativeHelicityFromRows,
} = require("../scripts/lib/noaa-beta/profile-wind");

function scratchFromRows(rows) {
  const scratch = {
    heights: new Float64Array(rows.length),
    pressure: new Float64Array(rows.length),
    u: new Float64Array(rows.length),
    v: new Float64Array(rows.length),
  };
  rows.forEach(([height, pressure, u, v], index) => {
    scratch.heights[index] = height;
    scratch.pressure[index] = pressure;
    scratch.u[index] = u;
    scratch.v[index] = v;
  });
  return scratch;
}

const FINITE_ROWS = [
  [0, 1000, 5, 0],
  [500, 950, 10, 2],
  [1500, 850, 20, 4],
  [3000, 700, 30, 6],
];

test("a windless interior row does not NaN-poison the height layer mean", () => {
  const clean = scratchFromRows(FINITE_ROWS);
  const poisoned = scratchFromRows([
    FINITE_ROWS[0],
    FINITE_ROWS[1],
    [1000, 900, Number.NaN, Number.NaN],
    FINITE_ROWS[2],
    FINITE_ROWS[3],
  ]);
  const cleanMean = calculateHeightMeanWindInLayerFromRows(clean, 4, 0, 3000);
  const poisonedMean = calculateHeightMeanWindInLayerFromRows(poisoned, 5, 0, 3000);
  assert.ok(cleanMean && Number.isFinite(cleanMean.u) && Number.isFinite(cleanMean.v));
  assert.ok(poisonedMean, "layer mean must survive a windless row");
  assert.ok(
    Number.isFinite(poisonedMean.u) && Number.isFinite(poisonedMean.v),
    `mean must be finite, got ${JSON.stringify(poisonedMean)}`,
  );
  // The windless row carries no wind information; the trapezoid spans the
  // gap, so the result matches the same profile without that row.
  assert.equal(poisonedMean.u, cleanMean.u);
  assert.equal(poisonedMean.v, cleanMean.v);
});

test("a windless interior row does not NaN-poison storm-relative helicity", () => {
  const storm = { u: 8, v: 3 };
  const clean = scratchFromRows(FINITE_ROWS);
  const poisoned = scratchFromRows([
    FINITE_ROWS[0],
    FINITE_ROWS[1],
    [1000, 900, Number.NaN, Number.NaN],
    FINITE_ROWS[2],
    FINITE_ROWS[3],
  ]);
  const cleanSrh = calculateStormRelativeHelicityFromRows(clean, 4, 0, 3000, storm);
  const poisonedSrh = calculateStormRelativeHelicityFromRows(poisoned, 5, 0, 3000, storm);
  assert.ok(Number.isFinite(cleanSrh));
  assert.ok(Number.isFinite(poisonedSrh), `SRH must be finite, got ${poisonedSrh}`);
  assert.equal(poisonedSrh, cleanSrh);
});

test("all-finite profiles are computed exactly as before (engagement control)", () => {
  const scratch = scratchFromRows(FINITE_ROWS);
  const mean = calculateHeightMeanWindInLayerFromRows(scratch, 4, 0, 3000);
  // Hand-computed trapezoid over segments (0,500,1500,3000):
  // u: (7.5*500 + 15*1000 + 25*1500) / 3000 = (3750+15000+37500)/3000 = 18.75
  // v: (1*500 + 3*1000 + 5*1500) / 3000 = (500+3000+7500)/3000 ≈ 3.6667
  assert.ok(Math.abs(mean.u - 18.75) < 1e-12);
  assert.ok(Math.abs(mean.v - 11000 / 3000) < 1e-12);
});
