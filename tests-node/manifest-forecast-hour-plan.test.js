"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
const { buildManifestTemplate } = require("../scripts/lib/modelview-runtime");
const { buildNoaaModelMetadata } = require("../scripts/lib/noaa-build/run-resolution");
const { canonicalForecastHoursForTier } = require("../scripts/lib/noaa-beta/forecast-hour-roster");

const GFS_REFERENCE_TIME = "2026-07-11T00:00:00Z";

function validTimesForHours(hours) {
  const baseMs = Date.parse(GFS_REFERENCE_TIME);
  return hours.map((hour) => new Date(baseMs + hour * 3600 * 1000).toISOString().replace(/\.000Z$/, "Z"));
}

function gfsTemplateInput(hours, extra = {}) {
  return {
    modelKey: "gfs",
    viewKey: "conus",
    runId: "20260711-0000Z",
    referenceTime: GFS_REFERENCE_TIME,
    validTimes: validTimesForHours(hours),
    renderWidth: 100,
    renderHeight: 100,
    ...extra,
  };
}

const HOURLY_TIER_HOURS = canonicalForecastHoursForTier("gfs", "hourly-through-f120");

test("hourly-tier roster hours override the configured GFS 3-hourly frame step", () => {
  const manifest = buildManifestTemplate(gfsTemplateInput(HOURLY_TIER_HOURS, { forecastHours: HOURLY_TIER_HOURS }));
  const frameHours = manifest.frames.map((frame) => Number(frame.hour));
  assert.equal(frameHours.length, 209, "all 209 hourly-tier frames survive the plan");
  assert.ok(frameHours.includes(1), "F001 is planned");
  assert.ok(frameHours.includes(2), "F002 is planned");
  assert.ok(frameHours.includes(119), "F119 is planned");
  assert.ok(!frameHours.includes(121), "the 3-hourly tail does not fabricate F121");
  assert.ok(frameHours.includes(123), "the 3-hourly tail keeps F123");
  assert.ok(frameHours.includes(384), "the roster still reaches F384");
});

test("metadata without a forecast-hour roster keeps the legacy configured step", () => {
  const manifest = buildManifestTemplate(gfsTemplateInput(HOURLY_TIER_HOURS));
  const frameHours = manifest.frames.map((frame) => Number(frame.hour));
  assert.equal(frameHours.length, 129, "legacy GFS metadata still plans the 3-hourly cadence");
  assert.ok(!frameHours.includes(1), "no hourly frame leaks into a legacy plan");
});

test("roster hours cannot fabricate frames beyond validTimes and ignore junk entries", () => {
  const hours = [0, 1, 2, 3];
  const manifest = buildManifestTemplate(
    gfsTemplateInput(hours, { forecastHours: [0, 1, 2, 3, 6, Number.NaN, "junk", -4] }),
  );
  const frameHours = manifest.frames.map((frame) => Number(frame.hour));
  assert.deepEqual(frameHours, [0, 1, 2, 3], "only hours with real valid times are planned");
});

test("an empty or invalid roster falls back to the configured step", () => {
  const hours = [0, 1, 2, 3, 6];
  for (const forecastHours of [[], null, "not-an-array"]) {
    const manifest = buildManifestTemplate(gfsTemplateInput(hours, { forecastHours }));
    const frameHours = manifest.frames.map((frame) => Number(frame.hour));
    assert.deepEqual(frameHours, [0, 3, 6], "degenerate rosters behave like legacy metadata");
  }
});

test("loadLatestState plans hourly-tier frames from the metadata forecast-hour roster", async (t) => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-hourly-plan-"));
  t.after(() => fs.promises.rm(cacheRoot, { recursive: true, force: true }));
  const metadata = buildNoaaModelMetadata({
    modelKey: "gfs",
    run: { date: "20260711", cycle: "00" },
    hours: HOURLY_TIER_HOURS,
    gfsHourlyThrough120: true,
  });
  const runtime = new LocalArtifactRuntime({
    cacheRoot,
    fetchLatestMetadata: async () => metadata,
  });
  const state = await runtime.ensureLatestState("gfs", "conus");
  assert.equal(state.manifest.frames.length, 209, "manifest carries every hourly-tier frame");
  assert.ok(state.framePlanByHour.has(1), "F001 is a render target");
  assert.ok(state.framePlanByHour.has(119), "F119 is a render target");
  assert.ok(!state.framePlanByHour.has(122), "no frame is fabricated between 3-hourly tail hours");
});
