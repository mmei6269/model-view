"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ACTION_CATEGORY_IDS,
  buildBuilderArgv,
  targetHoursForMaxHour,
} = require("../scripts/lib/local-artifact-server");

function selection(overrides = {}) {
  return {
    models: ["hrrr"],
    view: "conus",
    run: "latest",
    categories: [...ACTION_CATEGORY_IDS],
    severeTier: "full",
    winterTier: "full",
    maxHour: null,
    tuning: null,
    ...overrides,
  };
}

test("render argv makes the UI full-horizon promise explicit", () => {
  // --hours=full, never bare --full: the explicit --hours flag overrides a
  // lingering MODELVIEW_NOAA_BETA_HOURS in the server's inherited env, where
  // --full would trip resolveHoursByModel's contradiction guard and fail
  // every spawned build.
  assert.deepEqual(buildBuilderArgv(selection()), [
    "--models=hrrr",
    "--view=conus",
    "--hours=full",
    "--require-full-horizon",
  ]);
});

test("short prefixes can use a partially published run", () => {
  const argv = buildBuilderArgv(selection({ maxHour: 24 }));
  assert.ok(argv.includes("--max-hour=24"));
  assert.ok(!argv.includes("--require-full-horizon"));
});

test("NAM caps beyond F036 use the official mixed-cadence schedule", () => {
  const argv = buildBuilderArgv(selection({ models: ["nam"], maxHour: 48 }));
  assert.ok(argv.includes("--max-hour=48"));
  assert.ok(argv.includes("--require-full-horizon"));

  const shortArgv = buildBuilderArgv(selection({ models: ["nam"], maxHour: 36 }));
  assert.ok(!shortArgv.includes("--require-full-horizon"));
});

test("NAM progress denominators follow the same official cadence as full-horizon argv", () => {
  const through48 = targetHoursForMaxHour("nam", 48);
  assert.equal(through48.length, 41);
  assert.deepEqual(through48.slice(-4), [39, 42, 45, 48]);

  const full = targetHoursForMaxHour("nam", 84);
  assert.equal(full.length, 53);
  assert.deepEqual(full.slice(-4), [75, 78, 81, 84]);
});

test("HRRR progress denominators follow the selected run's cycle horizon", () => {
  assert.equal(targetHoursForMaxHour("hrrr", 48, "05").length, 19, "05Z is an 18-hour off-cycle run");
  assert.equal(targetHoursForMaxHour("hrrr", 48, "06").length, 49, "06Z is a 48-hour extension run");
  assert.equal(targetHoursForMaxHour("hrrr", 12, "05").length, 13, "explicit caps still apply within the cycle");
  assert.equal(
    targetHoursForMaxHour("hrrr", 48, null),
    null,
    "latest has no known cycle, so builder output must establish its denominator",
  );
});

test("optional GFS hourly-through-F120 tier is explicit in argv and progress cadence", () => {
  const argv = buildBuilderArgv(selection({ models: ["gfs"], maxHour: 126, gfsTemporalTier: "hourly-through-120" }));
  assert.ok(argv.includes("--gfs-hourly-through-120"));
  const hours = targetHoursForMaxHour("gfs", 126, "00", "hourly-through-120");
  assert.equal(hours.length, 123);
  assert.deepEqual(hours.slice(-4), [119, 120, 123, 126]);
  assert.ok(!buildBuilderArgv(selection({ models: ["gfs"] })).includes("--gfs-hourly-through-120"));
});

test("opt-in science prototype ids are forwarded as one stable builder flag", () => {
  const argv = buildBuilderArgv(
    selection({
      models: ["hrrr"],
      sciencePrototypes: ["effectiveStp100mbReduced", "camDcape21Level"],
    }),
  );
  assert.ok(argv.includes("--science-prototypes=camDcape21Level,effectiveStp100mbReduced"));
});
