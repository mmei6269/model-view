"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildManifestTemplate } = require("../scripts/lib/modelview-runtime");
const { RENDER_CATEGORY_IDS } = require("../scripts/lib/noaa-nam-parameter-catalog");

const BASE = {
  modelKey: "hrrr",
  viewKey: "conus",
  runId: "2026070300",
  referenceTime: "2026-07-03T00:00:00Z",
  validTimes: ["2026-07-03T00:00:00Z", "2026-07-03T01:00:00Z"],
  renderWidth: 100,
  renderHeight: 100,
};

test("no renderSelection: manifest omits the field (byte-identical default)", () => {
  const manifest = buildManifestTemplate({ ...BASE });
  assert.equal("renderSelection" in manifest, false);
});

test("null renderSelection is treated as no selection (field omitted)", () => {
  const manifest = buildManifestTemplate({ ...BASE, renderSelection: null });
  assert.equal("renderSelection" in manifest, false);
});

test("partial selection records categories + builtAt", () => {
  const categories = {};
  for (const id of RENDER_CATEGORY_IDS) categories[id] = { enabled: true, tier: "full" };
  categories.winter = { enabled: false, tier: "full" };
  categories.severe = { enabled: true, tier: "simple" };
  const before = Date.now();
  const manifest = buildManifestTemplate({ ...BASE, renderSelection: { categories } });
  assert.ok(manifest.renderSelection, "renderSelection present");
  assert.equal(manifest.renderSelection.categories.winter.enabled, false);
  assert.equal(manifest.renderSelection.categories.severe.tier, "simple");
  assert.equal(manifest.renderSelection.categories.surface.enabled, true);
  const builtAt = Date.parse(manifest.renderSelection.builtAt);
  assert.ok(Number.isFinite(builtAt) && builtAt >= before, "builtAt is a fresh ISO timestamp");
  // Every canonical category id is recorded (normalized), not just the ones passed.
  for (const id of RENDER_CATEGORY_IDS) {
    assert.ok(manifest.renderSelection.categories[id], `category ${id} recorded`);
  }
});

test("full-selection manifest equals default manifest except for the additive renderSelection field", () => {
  const categories = {};
  for (const id of RENDER_CATEGORY_IDS) categories[id] = { enabled: true, tier: "full" };
  const withSel = buildManifestTemplate({ ...BASE, renderSelection: { categories } });
  const withoutSel = buildManifestTemplate({ ...BASE });
  const { renderSelection, generatedAt: g1, ...withSelRest } = withSel;
  const { generatedAt: g2, ...withoutSelRest } = withoutSel;
  assert.ok(renderSelection, "full selection still records the field");
  assert.deepEqual(withSelRest, withoutSelRest, "only renderSelection (+ generatedAt clock) differs");
});
