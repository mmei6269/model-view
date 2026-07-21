"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  filterNoaaForecastHoursForCycle,
  getNoaaMaxForecastHourForCycle,
} = require("../scripts/lib/noaa-beta/model-config");
const { buildForecastHourPolicy, buildFullHoursForModel } = require("../scripts/lib/noaa-build/run-resolution");

test("HRRR standard cycles end at F018 and six-hourly cycles extend to F048", () => {
  assert.equal(getNoaaMaxForecastHourForCycle("hrrr", "05"), 18);
  assert.equal(getNoaaMaxForecastHourForCycle("hrrr", "06"), 48);
  assert.deepEqual(
    buildFullHoursForModel("hrrr", { cycle: "05" }),
    Array.from({ length: 19 }, (_, hour) => hour),
  );
  assert.equal(buildFullHoursForModel("hrrr", { cycle: "06" }).at(-1), 48);
  assert.equal(filterNoaaForecastHoursForCycle("hrrr", "23", buildFullHoursForModel("hrrr")).at(-1), 18);
});

test("cycle filtering leaves non-HRRR configured horizons unchanged", () => {
  assert.equal(getNoaaMaxForecastHourForCycle("nam3km", "00"), 60);
  assert.deepEqual(filterNoaaForecastHoursForCycle("nam3km", "05", [0, 18, 60]), [0, 18, 60]);
});

test("NAM default tier is explicit while full-horizon opt-in follows official cadence", () => {
  assert.deepEqual(
    buildFullHoursForModel("nam"),
    Array.from({ length: 37 }, (_, hour) => hour),
  );
  const official = buildFullHoursForModel("nam", { officialHorizon: true });
  assert.deepEqual(official.slice(34, 41), [34, 35, 36, 39, 42, 45, 48]);
  assert.equal(official.length, 53);
  assert.equal(official.at(-1), 84);
});

test("NAM forecast-hour policy describes actual coverage rather than only its last hour", () => {
  const short = buildFullHoursForModel("nam");
  const official = buildFullHoursForModel("nam", { officialHorizon: true });
  const shortSparse = buildForecastHourPolicy("nam", [0, 3, 6]);
  assert.equal(shortSparse.policy, "configured-sparse");
  assert.match(shortSparse.disclosure, /not a contiguous prefix/);
  assert.equal(buildForecastHourPolicy("nam", short).policy, "configured-short-f000-f036");

  const through48 = official.filter((hour) => hour <= 48);
  const extended = buildForecastHourPolicy("nam", through48);
  assert.equal(extended.policy, "official-cadence-prefix");
  assert.match(extended.disclosure, /not the complete 53-frame F084 horizon/);

  const full = buildForecastHourPolicy("nam", official);
  assert.equal(full.policy, "official-f000-f084");
  assert.match(full.disclosure, /Complete official NAM horizon/);

  const sparse = buildForecastHourPolicy("nam", [0, 12, 48]);
  assert.equal(sparse.policy, "configured-sparse");
  assert.match(sparse.disclosure, /3 frames through F048/);
  assert.match(sparse.cadence, /custom sparse roster/);
});

test("GFS optional temporal tier is hourly through F120 and three-hourly thereafter", () => {
  const defaultHours = buildFullHoursForModel("gfs");
  const hourlyTier = buildFullHoursForModel("gfs", { gfsHourlyThrough120: true });
  assert.equal(defaultHours.length, 129);
  assert.deepEqual(defaultHours.slice(0, 4), [0, 3, 6, 9]);
  assert.equal(hourlyTier.length, 209);
  assert.deepEqual(hourlyTier.slice(118, 125), [118, 119, 120, 123, 126, 129, 132]);
  assert.equal(hourlyTier.at(-1), 384);

  const policy = buildForecastHourPolicy("gfs", hourlyTier);
  assert.equal(policy.policy, "hourly-f000-f120-then-3h-f123-f384");
  assert.equal(policy.frameCount, 209);
  assert.match(policy.disclosure, /209 frames/);
  assert.match(buildForecastHourPolicy("gfs", defaultHours).disclosure, /adds 80 frames/);
  const oneFrameTier = buildForecastHourPolicy("gfs", [0], { gfsHourlyThrough120: true });
  assert.equal(oneFrameTier.policy, "hourly-through-f120-cadence-prefix");
  assert.match(oneFrameTier.cadence, /hourly F000-F120/);
  const sparseDefault = buildForecastHourPolicy("gfs", [0, 6, 12]);
  assert.equal(sparseDefault.policy, "configured-sparse");
  assert.match(sparseDefault.disclosure, /not a contiguous prefix/);
  const sparseHourly = buildForecastHourPolicy("gfs", [0, 1, 3], { gfsHourlyThrough120: true });
  assert.equal(sparseHourly.policy, "configured-sparse");
  assert.match(sparseHourly.cadence, /custom sparse roster/);
});

const { canonicalForecastHoursForTier } = require("../scripts/lib/noaa-beta/forecast-hour-roster");
const {
  _testApplyCycleHorizonFilter,
  _testFormatCycleHorizonCapMessage,
  _testModelHasExplicitHoursRequest,
} = require("../scripts/build-noaa-beta-artifacts");

test("an unknown cycle never masquerades as a specific HRRR cycle", () => {
  // Number(undefined) is NaN (used to silently cap extended runs at F018) and
  // Number(null) is 0 (used to read as the 00Z extended cycle). Unknown must
  // assume the full cadence so hours are never silently dropped.
  assert.equal(getNoaaMaxForecastHourForCycle("hrrr", undefined), 48);
  assert.equal(getNoaaMaxForecastHourForCycle("hrrr", null), 48);
  assert.equal(getNoaaMaxForecastHourForCycle("hrrr", ""), 48);
  assert.equal(getNoaaMaxForecastHourForCycle("hrrr", "latest"), 48);
  assert.deepEqual(filterNoaaForecastHoursForCycle("hrrr", "latest", [0, 18, 19, 48]), [0, 18, 19, 48]);
  assert.deepEqual(filterNoaaForecastHoursForCycle("hrrr", undefined, [0, 18, 19, 48]), [0, 18, 19, 48]);
  assert.equal(canonicalForecastHoursForTier("hrrr", "operational-cadence", undefined).at(-1), 48);
  assert.equal(canonicalForecastHoursForTier("hrrr", "operational-cadence", null).at(-1), 48);
  assert.equal(canonicalForecastHoursForTier("hrrr", "operational-cadence", "latest").at(-1), 48);
  // Known cycles keep their real horizons.
  assert.equal(canonicalForecastHoursForTier("hrrr", "operational-cadence", "05").at(-1), 18);
  assert.equal(canonicalForecastHoursForTier("hrrr", "operational-cadence", "06").at(-1), 48);
});

test("cycle-horizon cap log states when every requested hour was removed", () => {
  const run = { date: "20260711", cycle: "05" };
  assert.match(_testFormatCycleHorizonCapMessage("hrrr", run, [0, 1, 2]), /capped at F002/);
  const emptied = _testFormatCycleHorizonCapMessage("hrrr", run, []);
  assert.match(emptied, /removed all requested hours/);
  assert.doesNotMatch(emptied, /Fundefined/);
});

test("cycle filter emptying an explicitly requested roster fails the build instead of going zero-frame", () => {
  const run = { date: "20260711", cycle: "05" };
  const logs = [];
  const log = (message) => logs.push(String(message));
  // HRRR 05Z ends at F018: an explicit roster entirely past the horizon must
  // throw, naming the model, cycle, and requested hours.
  assert.throws(
    () => _testApplyCycleHorizonFilter({ modelKey: "hrrr", run, hours: [24, 30, 36], explicitHours: true, log }),
    (error) =>
      /hrrr 20260711 05Z/.test(error.message) &&
      /\(24,30,36\)/.test(error.message) &&
      /--hours-hrrr/.test(error.message),
  );
  assert.match(logs[0], /removed all requested hours/, "the cap log still fires before the throw");
  // Default rosters keep the historical log-and-proceed behavior.
  logs.length = 0;
  assert.deepEqual(
    _testApplyCycleHorizonFilter({ modelKey: "hrrr", run, hours: [24, 30, 36], explicitHours: false, log }),
    [],
  );
  assert.match(logs[0], /removed all requested hours/);
  // A partial trim of an explicit roster logs the cap and proceeds.
  logs.length = 0;
  assert.deepEqual(
    _testApplyCycleHorizonFilter({ modelKey: "hrrr", run, hours: [0, 12, 24], explicitHours: true, log }),
    [0, 12],
  );
  assert.match(logs[0], /capped at F012/);
  // An untrimmed roster neither logs nor throws.
  logs.length = 0;
  assert.deepEqual(
    _testApplyCycleHorizonFilter({ modelKey: "hrrr", run, hours: [0, 6, 12], explicitHours: true, log }),
    [0, 6, 12],
  );
  assert.deepEqual(logs, []);
});

test("explicit hour-request detection mirrors resolveHoursByModel precedence", () => {
  const detect = (args, fullRun, env = {}) =>
    _testModelHasExplicitHoursRequest({ args, modelKey: "hrrr", fullRun, env });
  assert.equal(detect({ "hours-hrrr": "24,30" }, false), true);
  assert.equal(detect({ hours: "24,30" }, false), true);
  assert.equal(detect({}, false, { MODELVIEW_NOAA_HRRR_HOURS: "24,30" }), true);
  assert.equal(detect({}, false, { MODELVIEW_NOAA_BETA_HOURS: "24,30" }), true);
  // A per-model roster stays explicit even under --full.
  assert.equal(detect({ full: true, "hours-hrrr": "24,30" }, true), true);
  // Defaults and full-run computed rosters are not user-picked hour lists.
  assert.equal(detect({}, false), false);
  assert.equal(detect({ hours: "full" }, true), false);
  assert.equal(detect({ full: true }, true, { MODELVIEW_NOAA_BETA_HOURS: "full" }), false);
});
