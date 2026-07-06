"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { NOAA_NAM_PARAMETER_CATALOG, RENDER_CATEGORY_IDS } = require("../scripts/lib/noaa-nam-parameter-catalog");
const {
  filterCatalogForRenderMode,
  selectionAllows,
  normalizeRenderSelection,
} = require("../scripts/lib/noaa-beta/selection");

// A fully-enabled, full-tier selection: the explicit form of "today".
function fullSelection() {
  const categories = {};
  for (const id of RENDER_CATEGORY_IDS) {
    categories[id] = { enabled: true, tier: "full" };
  }
  return { categories };
}

test("normalizeRenderSelection returns null for the no-selection sentinel", () => {
  assert.equal(normalizeRenderSelection(undefined), null);
  assert.equal(normalizeRenderSelection(null), null);
  assert.equal(normalizeRenderSelection("nope"), null);
});

test("selectionAllows: nullish selection allows every entry", () => {
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    assert.equal(selectionAllows(null, entry), true, `null should allow ${entry.key}`);
    assert.equal(selectionAllows(undefined, entry), true, `undefined should allow ${entry.key}`);
  }
});

test("no selection returns EXACTLY today's per-mode list (byte-identical default guard)", () => {
  for (const mode of ["all", "base", "snow", "snow-delta", "snow-prefix", "runmax-prefix"]) {
    const twoArg = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, mode);
    const threeArgUndefined = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, mode, undefined);
    const threeArgNull = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, mode, null);
    const withFull = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, mode, fullSelection());
    const baseKeys = twoArg.map((e) => e.key);
    assert.deepEqual(
      threeArgUndefined.map((e) => e.key),
      baseKeys,
      `${mode}: undefined must equal 2-arg`,
    );
    assert.deepEqual(
      threeArgNull.map((e) => e.key),
      baseKeys,
      `${mode}: null must equal 2-arg`,
    );
    assert.deepEqual(
      withFull.map((e) => e.key),
      baseKeys,
      `${mode}: all-on/full-tier must equal 2-arg`,
    );
    // Same object identities, in the same order (no re-wrapping of entries).
    assert.deepEqual(threeArgUndefined, twoArg);
  }
});

test("disabling a category omits exactly that category's keys", () => {
  const sel = fullSelection();
  sel.categories.winter = { enabled: false, tier: "full" };
  const filtered = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "all", sel);
  assert.ok(
    filtered.every((e) => e.category !== "winter"),
    "winter entries must be gone",
  );
  const expected = NOAA_NAM_PARAMETER_CATALOG.filter((e) => e.category !== "winter").map((e) => e.key);
  assert.deepEqual(
    filtered.map((e) => e.key),
    expected,
  );
});

test("severe simple tier keeps simple severe, drops full-only severe (dcape, effective-layer SCP/STP)", () => {
  const sel = fullSelection();
  sel.categories.severe = { enabled: true, tier: "simple" };
  const keys = new Set(filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "all", sel).map((e) => e.key));
  for (const dropped of [
    "dcape",
    "effectiveLayerSupercellCompositeParameter",
    "effectiveLayerSignificantTornadoParameter",
  ]) {
    assert.equal(keys.has(dropped), false, `${dropped} must be dropped in severe simple`);
  }
  for (const kept of [
    "sbcape",
    "srh0to1km",
    "bulkShear0to6km",
    "supercellCompositeParameter",
    "significantTornadoParameter",
  ]) {
    assert.equal(keys.has(kept), true, `${kept} must be kept in severe simple`);
  }
});

test("winter simple tier drops only the 3 authored full-only snow keys, keeps Kuchera + cheap winter keys", () => {
  const sel = fullSelection();
  sel.categories.winter = { enabled: true, tier: "simple" };
  const keys = new Set(filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "all", sel).map((e) => e.key));
  // Owner-authored FULL_TIER_KEYS winter set (spec §1.2/§1.3, commit ec2a192): 3 keys, NOT snowKuchera.
  for (const dropped of ["snowRfConus", "snowWesternLinear", "snowCobb"]) {
    assert.equal(keys.has(dropped), false, `${dropped} must be dropped in winter simple`);
  }
  // snowKuchera is the explicit owner exception: kept in simple despite its deep profile.
  for (const kept of [
    "snowKuchera",
    "snow10to1",
    "framFlatIce",
    "framRadialIce",
    "freezingRainLiquidTotal",
    "snowHrrrAsnow",
  ]) {
    assert.equal(keys.has(kept), true, `${kept} must be kept in winter simple`);
  }
});

test("mode split composes with selection: base + winter-off still excludes winter", () => {
  const sel = fullSelection();
  sel.categories.winter = { enabled: false, tier: "full" };
  const filtered = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "base", sel);
  // base already drops snowfallDerived; winter-off additionally removes other winter (freezing rain) entries.
  assert.ok(filtered.every((e) => e.kind !== "snowfallDerived"));
  assert.ok(filtered.every((e) => e.category !== "winter"));
});

const {
  filterCatalogForRenderMode: filterCatalogFromRenderer,
  _testCatalogCategorySet,
  _testBuildDerivedParameterGrids,
} = require("../scripts/lib/noaa-beta-renderer");

test("renderer re-exports the selection-aware filter (same choke point)", () => {
  const sel = { categories: {} };
  for (const id of RENDER_CATEGORY_IDS) sel.categories[id] = { enabled: true, tier: "full" };
  sel.categories.winter = { enabled: false, tier: "full" };
  const rendererKeys = filterCatalogFromRenderer(NOAA_NAM_PARAMETER_CATALOG, "all", sel).map((e) => e.key);
  const selectionKeys = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "all", sel).map((e) => e.key);
  assert.deepEqual(rendererKeys, selectionKeys);
});

test("_testCatalogCategorySet reports which winter builders may run", () => {
  const full = _testCatalogCategorySet(filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "base"));
  assert.equal(full.has("winter"), true, "default base build includes winter (freezing rain) entries");

  const sel = { categories: {} };
  for (const id of RENDER_CATEGORY_IDS) sel.categories[id] = { enabled: true, tier: "full" };
  sel.categories.winter = { enabled: false, tier: "full" };
  const winterOff = _testCatalogCategorySet(filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "base", sel));
  assert.equal(winterOff.has("winter"), false, "winter-off subset drops the winter category → builders gated off");
});

test("severe simple: dcape + effective-layer keys absent from derived output (compute gated by availableParameters)", () => {
  // Simulate the selection that renders after filtering: build a decoded/selection
  // where the heavy keys are NOT in availableParameters, and confirm the derived
  // builder never emits them. (Full end-to-end is covered by the byte-parity step.)
  const decoded = { gust: new Float32Array(4) };
  const selection = { availableParameters: ["gust"] }; // dcape / effective-layer intentionally excluded
  const out = _testBuildDerivedParameterGrids({
    decoded,
    selection,
    bounds: { north: 50, south: 20, west: -130, east: -60 },
    width: 2,
    height: 2,
  });
  assert.equal("dcape" in out, false);
  assert.equal("effectiveLayerSupercellCompositeParameter" in out, false);
  assert.equal("effectiveLayerSignificantTornadoParameter" in out, false);
});
