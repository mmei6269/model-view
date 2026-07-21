"use strict";

// minForecastHour gating: an entry that declares minForecastHour is
// definitionally empty below that hour (a 0-0-hour accumulation window is
// trivially zero), so selection must not offer it as available there. The
// snowfallDirect branch used to skip this gate, which made snowHrrrAsnow
// (catalog minForecastHour: 1) available at HRRR F000 while its min-1
// snowfall siblings were correctly omitted.

const assert = require("node:assert/strict");
const test = require("node:test");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../scripts/lib/noaa-nam-parameter-catalog");
const { parseNoaaIdx } = require("../scripts/lib/noaa-beta/idx-source");
const { selectNoaaNamParameterRecords } = require("../scripts/lib/noaa-beta/selection");

const SNOW_HRRR_ASNOW_ENTRY = NOAA_NAM_PARAMETER_CATALOG.find((entry) => entry.key === "snowHrrrAsnow");

test("snowHrrrAsnow is gated off at F000 and available from F001", () => {
  assert.equal(SNOW_HRRR_ASNOW_ENTRY.minForecastHour, 1, "catalog pin: this test guards a min-1 entry");
  const catalog = [SNOW_HRRR_ASNOW_ENTRY];
  const asnowIdx = (hour) =>
    [
      `1:0:d=2026071700:TMP:2 m above ground:${hour} hour fcst:`,
      `2:100:d=2026071700:UGRD:10 m above ground:${hour} hour fcst:`,
      `3:200:d=2026071700:VGRD:10 m above ground:${hour} hour fcst:`,
      `4:300:d=2026071700:ASNOW:surface:0-${hour} hour acc fcst:`,
    ].join("\n");

  const f000 = selectNoaaNamParameterRecords(parseNoaaIdx(asnowIdx(0), 1000), {
    catalog,
    modelKey: "hrrr",
    targetHour: 0,
  });
  assert.ok(!f000.availableParameters.includes("snowHrrrAsnow"));
  assert.ok(f000.missingOptionalParameters.includes("snowHrrrAsnow"));
  assert.equal(f000.records.snowHrrrAsnow, undefined, "the gated 0-0 ASNOW record must not be selected for decode");

  const f001 = selectNoaaNamParameterRecords(parseNoaaIdx(asnowIdx(1), 1000), {
    catalog,
    modelKey: "hrrr",
    targetHour: 1,
  });
  assert.ok(f001.availableParameters.includes("snowHrrrAsnow"));
  assert.ok(f001.records.snowHrrrAsnow);
});

test("the shared min-hour gate honors entry.minForecastHour on the formerly hardcoded kinds", () => {
  const catalog = [
    { key: "snowProbe", kind: "snowfallDerived", minForecastHour: 2, profileVariables: [] },
    { key: "freezingRainLiquidTotal", kind: "derivedAccumulation", minForecastHour: 2, directInputKey: "frzrDirect" },
  ];
  const winterIdx = (hour) =>
    [
      `1:0:d=2026071700:WEASD:surface:0-${hour} hour acc fcst:`,
      `2:100:d=2026071700:FRZR:surface:0-${hour} hour acc fcst:`,
    ].join("\n");

  // Below minForecastHour both entries gate off even though usable records exist.
  const below = selectNoaaNamParameterRecords(parseNoaaIdx(winterIdx(1), 1000), {
    catalog,
    modelKey: "hrrr",
    targetHour: 1,
  });
  assert.ok(!below.availableParameters.includes("snowProbe"));
  assert.ok(!below.availableParameters.includes("freezingRainLiquidTotal"));

  // At minForecastHour both become available.
  const at = selectNoaaNamParameterRecords(parseNoaaIdx(winterIdx(2), 1000), {
    catalog,
    modelKey: "hrrr",
    targetHour: 2,
  });
  assert.ok(at.availableParameters.includes("snowProbe"));
  assert.ok(at.availableParameters.includes("freezingRainLiquidTotal"));
});
