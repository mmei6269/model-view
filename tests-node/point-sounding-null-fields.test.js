"use strict";

// Optional point-sounding level fields (dwpt, uKt, vKt) are stored as null
// when their source records are absent (or RH <= 0 for derived dewpoints).
// The level/interpolation helpers must propagate that null as missing —
// Number(null) === 0 previously fabricated 0 C dewpoints and 0 kt winds into
// derived indices (K-index, totals, shear, SHIP/STP terms) instead of
// failing closed like the rest of the point path.

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  interpolateHeightForWetBulbZero,
  interpolateProfileValueByHeight,
  interpolateProfileValueByPressure,
  levelValueByPressure,
} = require("../scripts/lib/noaa-beta/point-sounding");

function level(press, hght, temp, extra = {}) {
  return { press, hght, temp, dwpt: null, rh: null, uKt: null, vKt: null, ...extra };
}

test("levelValueByPressure treats null optional fields as missing, not 0", () => {
  const levels = [level(500, 5700, -12)];
  assert.equal(Number.isNaN(levelValueByPressure(levels, 500, "uKt")), true);
  assert.equal(Number.isNaN(levelValueByPressure(levels, 500, "dwpt")), true);
  assert.equal(levelValueByPressure(levels, 500, "temp"), -12);
});

test("interpolateProfileValueByPressure skips null-field levels instead of fabricating 0", () => {
  // 850 mb level exists but has a null dewpoint; its neighbors carry real
  // dewpoints. The exact-match path must not return 0 C, and the bracketing
  // interpolation must use the finite neighbors.
  const levels = [level(925, 750, 18, { dwpt: 14 }), level(850, 1450, 14), level(700, 3000, 4, { dwpt: -6 })];
  const dwpt850 = interpolateProfileValueByPressure(levels, 850, "dwpt");
  assert.equal(Number.isFinite(dwpt850), true);
  assert.equal(dwpt850 > -6 && dwpt850 < 14, true, `interpolated dewpoint ${dwpt850} should sit between neighbors`);
  assert.notEqual(dwpt850, 0);
  // With no finite dewpoints anywhere, the result is missing.
  const dry = [level(925, 750, 18), level(850, 1450, 14)];
  assert.equal(Number.isNaN(interpolateProfileValueByPressure(dry, 850, "dwpt")), true);
});

test("interpolateProfileValueByHeight skips null-wind levels instead of interpolating calm", () => {
  const levels = [
    level(1000, 100, 20, { uKt: 10, vKt: 0 }),
    level(925, 750, 18), // null winds — record missing from idx
    level(850, 1450, 14, { uKt: 30, vKt: 0 }),
  ];
  const u = interpolateProfileValueByHeight(levels, 750, "uKt");
  assert.equal(Number.isFinite(u), true);
  assert.equal(u > 10 && u < 30, true, `wind ${u} must interpolate across the null level, not through a calm 0`);
});

test("interpolateHeightForWetBulbZero ignores levels with null dewpoints", () => {
  // Only the two levels with real dewpoints straddle the wet-bulb zero; the
  // null-dwpt level between them must not contribute a fabricated wet bulb.
  const levels = [level(1000, 100, 6, { dwpt: 4 }), level(925, 750, 2), level(850, 1450, -4, { dwpt: -6 })];
  const wbz = interpolateHeightForWetBulbZero(levels);
  assert.equal(Number.isFinite(wbz), true);
  assert.equal(wbz > 100 && wbz < 1450, true);
  const allNull = [level(1000, 100, 6), level(850, 1450, -4)];
  assert.equal(Number.isNaN(interpolateHeightForWetBulbZero(allNull)), true);
});
