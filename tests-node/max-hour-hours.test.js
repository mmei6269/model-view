"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildForecastHourPolicy,
  buildFullHoursForModel,
  parseHours,
  resolveHoursByModel,
} = require("../scripts/lib/noaa-build/run-resolution");

test("--max-hour filters a full run to the prefix of each model's hour list", () => {
  const hours = resolveHoursByModel({ args: { full: true, "max-hour": "6" }, models: ["hrrr", "gfs"] });
  assert.deepEqual(hours.hrrr, [0, 1, 2, 3, 4, 5, 6], "hourly model keeps every hour through the cap");
  assert.deepEqual(hours.gfs, [0, 3, 6], "3-hourly model keeps its native cadence through the cap");
});

test("--max-hour leaves full runs untouched when at or above the model horizon", () => {
  const full = buildFullHoursForModel("hrrr");
  const hours = resolveHoursByModel({
    args: { full: true, "max-hour": String(full[full.length - 1]) },
    models: ["hrrr"],
  });
  assert.deepEqual(hours.hrrr, full);
});

test("--max-hour also caps an explicit hours list", () => {
  const hours = resolveHoursByModel({ args: { hours: "0,3,6,9,12", "max-hour": "7" }, models: ["nam"] });
  assert.deepEqual(hours.nam, [0, 3, 6]);
});

test("--max-hour that empties a model's hour list throws instead of building nothing", () => {
  assert.throws(
    () => resolveHoursByModel({ args: { hours: "6,9", "max-hour": "3" }, models: ["nam"] }),
    /leaves no forecast hours/,
  );
});

test("--max-hour rejects non-integer and bare-flag values", () => {
  assert.throws(() => resolveHoursByModel({ args: { full: true, "max-hour": "abc" }, models: ["hrrr"] }), /max-hour/);
  assert.throws(() => resolveHoursByModel({ args: { full: true, "max-hour": "-1" }, models: ["hrrr"] }), /max-hour/);
  assert.throws(() => resolveHoursByModel({ args: { full: true, "max-hour": true }, models: ["hrrr"] }), /max-hour/);
});

test("parseHours throws on invalid tokens instead of silently altering the roster", () => {
  // A typo'd token used to be dropped (fewer frames than requested)…
  assert.throws(() => parseHours("0,3,6x"), /Invalid forecast hour '6x' in --hours/);
  // …negative hours were dropped too…
  assert.throws(() => parseHours("12,-6"), /Invalid forecast hour '-6' in --hours/);
  // …and fractional hours were silently rounded.
  assert.throws(() => parseHours("1.7"), /Invalid forecast hour '1\.7' in --hours/);
  // A bare --hours (boolean true) asks for a value instead of parsing 'true'.
  assert.throws(() => parseHours(true), /--hours requires a value/);
});

test("parseHours ignores empty tokens instead of turning them into hour 0", () => {
  assert.deepEqual(parseHours("3,,6"), [3, 6], "a doubled comma must not inject F000");
  assert.deepEqual(parseHours("0,3,6,"), [0, 3, 6], "trailing comma stays legal");
  assert.deepEqual(parseHours(" 0 , 3 ,6"), [0, 3, 6], "whitespace around tokens stays legal");
  assert.throws(() => parseHours(",,"), /No forecast hours selected/);
});

test("hour parse errors name the offending flag and env var", () => {
  assert.throws(
    () => resolveHoursByModel({ args: { hours: "0,x" }, models: ["nam"] }),
    /Invalid forecast hour 'x' in --hours \(or MODELVIEW_NOAA_BETA_HOURS\)/,
  );
  assert.throws(
    () => resolveHoursByModel({ args: { "hours-nam": "0,zz" }, models: ["nam"] }),
    /Invalid forecast hour 'zz' in --hours-nam \(or MODELVIEW_NOAA_NAM_HOURS\)/,
  );
});

test("--gfs-hourly-through-120 opts only GFS into the 209-frame mixed cadence", () => {
  const resolved = resolveHoursByModel({
    args: { full: true, "gfs-hourly-through-120": true },
    models: ["gfs", "nam3km"],
  });
  assert.equal(resolved.gfs.length, 209);
  assert.deepEqual(resolved.gfs.slice(119, 123), [119, 120, 123, 126]);
  assert.deepEqual(resolved.nam3km, buildFullHoursForModel("nam3km"));
});

test("--gfs-hourly-through-120 rejects a model selection without GFS", () => {
  assert.throws(
    () =>
      resolveHoursByModel({
        args: { full: true, "gfs-hourly-through-120": true },
        models: ["hrrr", "nam3km"],
      }),
    /requires 'gfs' in --models/i,
  );
});

test("--gfs-hourly-through-120 rejects a default or custom sparse roster without full-run expansion", () => {
  assert.throws(
    () =>
      resolveHoursByModel({
        args: { "gfs-hourly-through-120": true },
        models: ["gfs"],
      }),
    /requires --full/i,
  );
  assert.throws(
    () =>
      resolveHoursByModel({
        args: { hours: "0,1,2,3", "gfs-hourly-through-120": true },
        models: ["gfs"],
      }),
    /explicit custom hours already derive their cadence identity/i,
  );

  const explicit = resolveHoursByModel({ args: { hours: "0,1,2,3" }, models: ["gfs"] });
  assert.deepEqual(explicit.gfs, [0, 1, 2, 3]);
  assert.equal(
    buildForecastHourPolicy("gfs", explicit.gfs).policy,
    "hourly-through-f120-cadence-prefix",
    "a genuine explicit hourly prefix is identified from its roster without the expansion flag",
  );
});

test("--full with an explicit global --hours list throws instead of silently discarding the list", () => {
  assert.throws(
    () => resolveHoursByModel({ args: { full: true, hours: "0,3,6" }, models: ["nam"] }),
    /--full contradicts an explicit global --hours list/,
  );
  assert.throws(
    () => resolveHoursByModel({ args: { "full-run": true, hours: "0,3,6" }, models: ["nam"] }),
    /--full contradicts an explicit global --hours list/,
  );
  // The per-model spelling stays legal under a full run…
  const perModel = resolveHoursByModel({ args: { full: true, "hours-nam": "0,3,6" }, models: ["nam"] });
  assert.deepEqual(perModel.nam, [0, 3, 6]);
  // …and '--hours=full' stays a legal full-run spelling.
  assert.equal(resolveHoursByModel({ args: { hours: "full" }, models: ["nam"] }).nam.length, 37);
});

test("'--hours=full' overrides a lingering MODELVIEW_NOAA_BETA_HOURS while bare --full still hard-fails", (t) => {
  const original = process.env.MODELVIEW_NOAA_BETA_HOURS;
  process.env.MODELVIEW_NOAA_BETA_HOURS = "0,3,6";
  t.after(() => {
    if (original === undefined) {
      delete process.env.MODELVIEW_NOAA_BETA_HOURS;
    } else {
      process.env.MODELVIEW_NOAA_BETA_HOURS = original;
    }
  });
  // The render server spawns builders with --hours=full and env: process.env:
  // the explicit flag overrides the env default through ordinary
  // flag-over-env precedence, so an operator's exported roster never
  // hard-fails every server-spawned build.
  const resolved = resolveHoursByModel({ args: { hours: "full" }, models: ["nam"] });
  assert.equal(resolved.nam.length, 37, "the explicit full spelling wins over the env default");
  // A CLI user's bare --full still fails loud: silently discarding the env
  // roster would render hours of compute the variable was set to prevent.
  assert.throws(
    () => resolveHoursByModel({ args: { full: true }, models: ["nam"] }),
    /--full contradicts an explicit global --hours list \(or MODELVIEW_NOAA_BETA_HOURS\)/,
  );
  // Without any full-run request the env default still applies.
  assert.deepEqual(resolveHoursByModel({ args: {}, models: ["nam"] }).nam, [0, 3, 6]);
});
