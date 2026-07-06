"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizePointSoundingLevel,
  windComponentsToMeteorological,
} = require("../scripts/lib/noaa-beta/point-sounding");

test("calm wind components produce no meteorological direction", () => {
  const calm = windComponentsToMeteorological(0, 0);
  assert.equal(calm.wspd, 0);
  assert.equal(calm.uKt, 0);
  assert.equal(calm.vKt, 0);
  assert.equal(Number.isNaN(calm.wdir), true);
});

test("calm wind serializes as null direction and zero speed", () => {
  const level = normalizePointSoundingLevel({
    source: "surface",
    press: 1000,
    hght: 10,
    temp: 20,
    dwpt: 15,
    rh: 73,
    ...windComponentsToMeteorological(0, 0),
  });
  assert.equal(level.wdir, null);
  assert.equal(level.wspd, 0);
  assert.equal(level.uKt, 0);
  assert.equal(level.vKt, 0);
});

test("non-calm wind directions are unchanged", () => {
  const north = windComponentsToMeteorological(0, -5);
  assert.equal(north.wdir, 0);
  assert.ok(Math.abs(north.wspd - 5 * 1.943844) < 1e-2);
  assert.equal(north.vKt, -north.wspd);
  const east = windComponentsToMeteorological(-5, 0);
  assert.equal(east.wdir, 90);
  const south = windComponentsToMeteorological(0, 5);
  assert.equal(south.wdir, 180);
  const west = windComponentsToMeteorological(5, 0);
  assert.equal(west.wdir, 270);
});
