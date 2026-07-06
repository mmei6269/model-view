"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  RENDER_CATEGORY_IDS,
  TIERED_CATEGORY_IDS,
  parseRenderSelectionFromArgs,
  resolveRenderSelectionKeys,
} = require("../scripts/lib/noaa-build/render-selection-args");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../scripts/lib/noaa-nam-parameter-catalog");

const CONTEXT = { models: ["nam3km"], view: "conus", run: "latest" };

test("no selection flags returns null (today's all/full behavior)", () => {
  assert.equal(parseRenderSelectionFromArgs({}, CONTEXT), null);
  assert.equal(parseRenderSelectionFromArgs({ force: true, view: "conus" }, CONTEXT), null);
});

test("exposes the 7 merged categories and the two tiered ones", () => {
  assert.deepEqual(RENDER_CATEGORY_IDS, ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]);
  assert.equal(TIERED_CATEGORY_IDS.has("severe"), true);
  assert.equal(TIERED_CATEGORY_IDS.has("winter"), true);
  assert.equal(TIERED_CATEGORY_IDS.has("surface"), false);
});

test("an unknown --categories token throws (non-zero exit in main)", () => {
  assert.throws(
    () => parseRenderSelectionFromArgs({ categories: "surface,bogus" }, CONTEXT),
    /unknown render category 'bogus'/i,
  );
});

test("an invalid --severe-tier throws", () => {
  assert.throws(
    () => parseRenderSelectionFromArgs({ categories: "severe", "severe-tier": "cheap" }, CONTEXT),
    /invalid severe tier 'cheap'/i,
  );
});

test("--categories allowlists the named categories; omitted categories are off", () => {
  const selection = parseRenderSelectionFromArgs(
    { categories: "surface,precip,severe", "severe-tier": "simple" },
    CONTEXT,
  );
  assert.deepEqual(selection.models, ["nam3km"]);
  assert.equal(selection.view, "conus");
  assert.equal(selection.run, "latest");
  assert.deepEqual(selection.categories, {
    surface: true,
    precip: true,
    radar: false,
    cloud: false,
    upperAir: false,
    severe: { enabled: true, tier: "simple" },
    winter: { enabled: false, tier: "full" },
  });
});

test("tiers default to full when the flag is omitted", () => {
  const selection = parseRenderSelectionFromArgs({ categories: "severe,winter" }, CONTEXT);
  assert.equal(selection.categories.severe.tier, "full");
  assert.equal(selection.categories.winter.tier, "full");
});

test("resolveRenderSelectionKeys drops severe full-only keys when severe tier is simple", () => {
  const selection = parseRenderSelectionFromArgs({ categories: "severe", "severe-tier": "simple" }, CONTEXT);
  const keys = resolveRenderSelectionKeys(selection, NOAA_NAM_PARAMETER_CATALOG);
  // simple severe drops the effective-layer composites and DCAPE (owner decision 1)
  assert.equal(keys.includes("dcape"), false);
  assert.equal(keys.includes("effectiveLayerSupercellCompositeParameter"), false);
  assert.equal(keys.includes("effectiveLayerSignificantTornadoParameter"), false);
  // but keeps the cheap direct/composite severe fields
  assert.equal(keys.includes("supercellCompositeParameter"), true);
  assert.equal(keys.includes("bulkShear0to6km"), true);
  // and omits an off category entirely
  assert.equal(
    keys.some((key) => {
      const entry = NOAA_NAM_PARAMETER_CATALOG.find((candidate) => candidate.key === key);
      return entry && entry.category === "winter";
    }),
    false,
  );
});

test("full severe tier keeps the heavy keys", () => {
  const selection = parseRenderSelectionFromArgs({ categories: "severe", "severe-tier": "full" }, CONTEXT);
  const keys = resolveRenderSelectionKeys(selection, NOAA_NAM_PARAMETER_CATALOG);
  assert.equal(keys.includes("dcape"), true);
  assert.equal(keys.includes("effectiveLayerSupercellCompositeParameter"), true);
});
