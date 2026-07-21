"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

// Durable guards for the display-settings schema (Map QA E3): the v5 fields
// backing the exclusive border modes — boundaries.basemapWidthScale and
// boundaries.basemapColor — must default, clamp, and reject invalid input,
// and a legacy v4 payload (which lacks them entirely) must normalize to the
// defaults instead of leaking undefined into the engine verb.

// ── Module under test ─────────────────────────────────────────────────────────
// display.ts is client TypeScript; bundle it with esbuild and evaluate in a
// throwaway CJS context — the repo pattern for testing client TS from node
// (see basemap-style.test.js / synoptic-geojson.test.js).
function loadModule() {
  const entry = path.join(__dirname, "..", "next", "src", "config", "display.ts");
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

const mod = loadModule();

// A stored v4-era boundaries payload: every pre-v5 field, none of the v5
// ones; `overrides` layers the case under test on top.
function v4Payload(boundaryOverrides = {}) {
  return {
    preset: "custom",
    basemap: "light",
    boundaries: {
      mode: "basemap",
      countryOpacity: 55,
      countryWeight: 1.2,
      stateOpacity: 32,
      stateWeight: 0.55,
      color: "#94a3b8",
      ...boundaryOverrides,
    },
  };
}

test("legacy v4 payload without the v5 basemap-boundary fields normalizes to defaults", () => {
  const settings = mod.normalizeDisplaySettings(v4Payload());
  assert.equal(settings.boundaries.basemapWidthScale, 1);
  assert.equal(settings.boundaries.basemapColor, "auto");
});

test("basemapWidthScale clamps to the 0.5-3 slider range and rejects non-numbers", () => {
  assert.equal(mod.normalizeDisplaySettings(v4Payload({ basemapWidthScale: 9 })).boundaries.basemapWidthScale, 3);
  assert.equal(mod.normalizeDisplaySettings(v4Payload({ basemapWidthScale: 0.1 })).boundaries.basemapWidthScale, 0.5);
  assert.equal(mod.normalizeDisplaySettings(v4Payload({ basemapWidthScale: 1.8 })).boundaries.basemapWidthScale, 1.8);
  assert.equal(mod.normalizeDisplaySettings(v4Payload({ basemapWidthScale: "wide" })).boundaries.basemapWidthScale, 1);
});

test("basemapColor accepts auto and #rrggbb; anything else falls back to auto", () => {
  assert.equal(mod.normalizeDisplaySettings(v4Payload({ basemapColor: "auto" })).boundaries.basemapColor, "auto");
  // Valid hex normalizes through the same lowercasing as the sibling color.
  assert.equal(mod.normalizeDisplaySettings(v4Payload({ basemapColor: "#22D3EE" })).boundaries.basemapColor, "#22d3ee");
  assert.equal(mod.normalizeDisplaySettings(v4Payload({ basemapColor: "chartreuse" })).boundaries.basemapColor, "auto");
  assert.equal(mod.normalizeDisplaySettings(v4Payload({ basemapColor: 7 })).boundaries.basemapColor, "auto");
});

test("schema version is 5 (v5 = basemap-boundary width/color + exclusive border modes)", () => {
  assert.equal(mod.DISPLAY_SCHEMA_VERSION, 5);
});
