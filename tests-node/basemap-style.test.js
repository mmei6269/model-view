"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

// Durable guards for the MapLibre basemap styles (Task 4.3r3 review finding):
//
// 1. Light/dark layer parity as (id, type) PAIRS. The engine's theme switch
//    keeps its derived layer-id sets and anchor insertion points across
//    styles, and basemapLabelLayerIds filters on layer.type === "symbol" —
//    so id-only parity (what the DEV-only verifyThemeLayerIdParity console
//    guard checks) is not enough: a layer that kept its id but changed type
//    between flavors would silently break the Labels toggle.
// 2. Committed snapshots of BOTH themes' kept-layer output (dark since
//    4.3r3; light added in Task 5.2 per the 5.1 review handoff), so any
//    future flavor-knob edit (or @protomaps/basemaps bump) that drifts
//    either style fails this suite with a diff naming the drifted layer.

// ── Module under test ─────────────────────────────────────────────────────────
// basemap-style.ts is client TypeScript (imports @protomaps/basemaps and
// maplibre-gl types); bundle it with esbuild and evaluate in a throwaway CJS
// context — the repo pattern for testing client TS from node (see
// synoptic-geojson.test.js / render-category-client-parity.test.js).
function loadModule() {
  const entry = path.join(__dirname, "..", "next", "src", "core", "map-engine", "basemap-style.ts");
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

// The pmtiles URL only lands in style.sources, never in the layer list; any
// placeholder works for these assertions.
const PMTILES_URL = "http://localhost/basemap/basemap.pmtiles";

// buildThemedStyle fails loudly through console.error (unmatched drop
// patterns, non-vendored font stacks); building both styles must be silent.
function buildBothStylesExpectingSilence() {
  const errors = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    return {
      dark: mod.buildDarkStyle(PMTILES_URL),
      light: mod.buildLightStyle(PMTILES_URL),
      errors,
    };
  } finally {
    console.error = original;
  }
}

// ── Light/dark parity ─────────────────────────────────────────────────────────

test("light and dark styles expose identical (id, type) layer pairs, in order", () => {
  const { dark, light, errors } = buildBothStylesExpectingSilence();
  assert.deepEqual(errors, [], "style generation hit a fail-loud console.error guard");

  const pairs = (style) => style.layers.map((layer) => ({ id: layer.id, type: layer.type }));
  assert.deepEqual(pairs(light), pairs(dark));
  assert.ok(dark.layers.length > 0, "generated styles must not be empty");

  // The parity above is exactly what makes the engine's derived id sets
  // theme-neutral; pin that consequence directly.
  assert.deepEqual(mod.basemapLabelLayerIds(light), mod.basemapLabelLayerIds(dark));
  assert.deepEqual(mod.basemapRoadLayerIds(light), mod.basemapRoadLayerIds(dark));
  assert.deepEqual(mod.basemapPlaceLabelLayerIds(light), mod.basemapPlaceLabelLayerIds(dark));
  assert.deepEqual(mod.basemapBoundaryLayerIds(light), mod.basemapBoundaryLayerIds(dark));
  assert.ok(mod.basemapLabelLayerIds(dark).length > 0, "no symbol layers — label toggle would be a no-op");
  assert.ok(mod.verifyThemeLayerIdParity(light, dark));
});

// ── Basemap boundary layer ids (Map QA E2) ────────────────────────────────────
// The engine's setBasemapBoundaries verb (visibility/width/color) governs
// exactly these layers: the generated style draws admin boundaries as two
// line layers — boundaries_country (admin<=2) and boundaries (admin>2). The
// EXACT-set pin fails if a @protomaps/basemaps bump renames or splits them,
// which is precisely when the verb's id set must be re-derived.
test("basemapBoundaryLayerIds returns exactly the two boundary line layers", () => {
  const light = mod.buildLightStyle(PMTILES_URL);
  const ids = mod.basemapBoundaryLayerIds(light);
  assert.deepEqual(new Set(ids), new Set(["boundaries_country", "boundaries"]));
  const byId = new Map(light.layers.map((layer) => [layer.id, layer]));
  for (const id of ids) {
    assert.equal(byId.get(id).type, "line", `boundary layer "${id}" must be a line layer`);
  }
});

// ── Kept-layer snapshots (both themes) ────────────────────────────────────────
// Snapshot choice: the FULL kept-layer array (id/type/source/source-layer/
// filter/minzoom/maxzoom/paint/layout), stable-stringified with sorted keys.
// At ~208 KB per theme (~416 KB total, measured 2026-07-09) the
// pin-the-whole-array decision still holds: layer-set drift is exactly what
// this suite exists to catch, and a lossy "key props only" projection would
// buy nothing and cost blind spots (e.g. a filter or zoom-ramp drift).
// Layers only — the style-level envelope (glyphs/sprite/sources) embeds
// window.location.origin and the pmtiles URL, which are
// environment-dependent.
//
// To regenerate after an INTENTIONAL flavor/tuning edit:
//   UPDATE_BASEMAP_STYLE_SNAPSHOT=1 node --test tests-node/basemap-style.test.js
// then review the fixture diff in git (tests-node/fixtures/ is prettier-ignored).
const SNAPSHOTS = [
  { theme: "dark", build: () => mod.buildDarkStyle(PMTILES_URL), file: "basemap-style.dark-layers.json" },
  { theme: "light", build: () => mod.buildLightStyle(PMTILES_URL), file: "basemap-style.light-layers.json" },
];

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

for (const { theme, build, file } of SNAPSHOTS) {
  test(`${theme} kept-layer output matches the committed snapshot`, () => {
    const style = build();
    const actual = sortKeysDeep(style.layers);
    const snapshotPath = path.join(__dirname, "fixtures", file);
    if (process.env.UPDATE_BASEMAP_STYLE_SNAPSHOT) {
      fs.writeFileSync(snapshotPath, `${stableStringify(style.layers)}\n`);
    }
    const expected = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

    // Compare the id list first, then layer-by-layer, so a drift fails with a
    // diff scoped to the layer that changed instead of a 208 KB object dump.
    assert.deepEqual(
      actual.map((layer) => layer.id),
      expected.map((layer) => layer.id),
      `${theme} style layer id list drifted from the committed snapshot`,
    );
    const expectedById = new Map(expected.map((layer) => [layer.id, layer]));
    for (const layer of actual) {
      assert.deepEqual(
        layer,
        expectedById.get(layer.id),
        `${theme} layer "${layer.id}" drifted from the committed snapshot`,
      );
    }
    assert.equal(actual.length, expected.length);
  });
}
