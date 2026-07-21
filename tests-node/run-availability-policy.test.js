"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { shouldCapAvailableHours } = require("../scripts/build-noaa-beta-artifacts");
const {
  buildFullHoursForModel,
  resolveAvailableNoaaHours,
  resolveNoaaModelRun,
} = require("../scripts/lib/noaa-build/run-resolution");

test("picked still-uploading runs cap gracefully even for an official full-horizon request", () => {
  assert.equal(shouldCapAvailableHours({ fullRun: true, requireFullHorizon: true, explicitRun: true }), true);
  assert.equal(shouldCapAvailableHours({ fullRun: true, requireFullHorizon: false, explicitRun: true }), true);
});

test("latest full-horizon requests still require a completed run before selection", () => {
  assert.equal(shouldCapAvailableHours({ fullRun: true, requireFullHorizon: true, explicitRun: false }), false);
  assert.equal(shouldCapAvailableHours({ fullRun: true, requireFullHorizon: false, explicitRun: false }), true);
  assert.equal(shouldCapAvailableHours({ fullRun: false, requireFullHorizon: false, explicitRun: true }), false);
});

test("explicit full-horizon run probes NOAA and resolves the contiguous published prefix", async (t) => {
  const originalFetch = global.fetch;
  const probedHours = [];
  global.fetch = async (url, options) => {
    assert.equal(options?.method, "HEAD");
    const hour = Number(String(url).match(/f(\d{2})\.grib2\.idx$/)?.[1]);
    probedHours.push(hour);
    return { ok: hour <= 6 };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  const requested = buildFullHoursForModel("hrrr", { cycle: "05" });
  const run = await resolveNoaaModelRun({
    modelKey: "hrrr",
    date: "20260711",
    cycle: "05",
    hours: requested,
    requireAllHours: false,
  });
  assert.deepEqual(run, { date: "20260711", cycle: "05" }, "picked run remains exact");
  assert.equal(shouldCapAvailableHours({ fullRun: true, requireFullHorizon: true, explicitRun: true }), true);
  const available = await resolveAvailableNoaaHours({ modelKey: "hrrr", run, hours: requested });
  assert.deepEqual(available, [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(probedHours.includes(7), "the first unpublished hour is actually probed");
});
