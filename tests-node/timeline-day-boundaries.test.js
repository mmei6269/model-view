"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

// Bundle (not just transpile) the client-side TS helper so its ../core/time and
// ../config/timezone imports are inlined, then evaluate it in a throwaway CJS
// module context (same vm pattern as keyboard-shortcut-guard.test.js). The raw
// .ts is never require()d directly.
function loadTrackModule() {
  const entry = path.join(__dirname, "..", "next", "src", "components", "timeline-track.ts");
  const built = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
  });
  const code = built.outputFiles[0].text;
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${code}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

test("emits exactly one tick at a UTC day crossing", () => {
  const { computeDayBoundaryTicks } = loadTrackModule();
  const validTimes = ["2026-07-01T18:00:00Z", "2026-07-01T21:00:00Z", "2026-07-02T00:00:00Z", "2026-07-02T03:00:00Z"];
  const ticks = computeDayBoundaryTicks(validTimes, "UTC");
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].index, 2);
  assert.ok(ticks[0].positionPercent > 0 && ticks[0].positionPercent < 100);
  // Same proportional mapping the track fill uses: (index / (len - 1)) * 100.
  assert.ok(Math.abs(ticks[0].positionPercent - (2 / 3) * 100) < 1e-9);
  assert.equal(typeof ticks[0].label, "string");
  assert.ok(ticks[0].label.length > 0);
});

test("emits no ticks for a same-day sequence", () => {
  const { computeDayBoundaryTicks } = loadTrackModule();
  const validTimes = ["2026-07-01T06:00:00Z", "2026-07-01T12:00:00Z", "2026-07-01T18:00:00Z"];
  assert.deepEqual(computeDayBoundaryTicks(validTimes, "UTC"), []);
});

test("day boundary follows the selected zone, not UTC", () => {
  const { computeDayBoundaryTicks } = loadTrackModule();
  // 02z-06z on Jul 2 is a single UTC day but crosses local midnight in New
  // York (Jul 1 22:00 EDT -> Jul 2 00:00 EDT -> Jul 2 02:00 EDT).
  const validTimes = ["2026-07-02T02:00:00Z", "2026-07-02T04:00:00Z", "2026-07-02T06:00:00Z"];
  assert.equal(computeDayBoundaryTicks(validTimes, "UTC").length, 0);
  const ticks = computeDayBoundaryTicks(validTimes, "America/New_York");
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].index, 1);
});

test("returns no ticks for empty or single-frame timelines", () => {
  const { computeDayBoundaryTicks } = loadTrackModule();
  assert.deepEqual(computeDayBoundaryTicks([], "UTC"), []);
  assert.deepEqual(computeDayBoundaryTicks(["2026-07-02T00:00:00Z"], "UTC"), []);
});
