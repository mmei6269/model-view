"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  NOAA_NAM_PARAMETER_CATALOG,
  GROUP_TO_CATEGORY,
  RENDER_CATEGORY_IDS,
  getNoaaNamParameterMetadata,
} = require("../scripts/lib/noaa-nam-parameter-catalog.js");

const VALID_CATEGORIES = new Set(["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]);

// Locked owner cuts (spec §1.2, decision 1, commit ec2a192): the authored full-tier set is
// EXACTLY these 6 keys. Severe simple drops effective SCP/STP AND dcape; winter simple drops
// only the three ML/Cobb SLR products (RF, Western-Linear, Cobb) and KEEPS Kuchera. Verified
// against the real catalog on app-completion.
const FULL_TIER_KEYS = [
  "snowRfConus",
  "snowWesternLinear",
  "snowCobb",
  "effectiveLayerSupercellCompositeParameter",
  "effectiveLayerSignificantTornadoParameter",
  "dcape",
];
const SIMPLE_TIER_KEYS = [
  "snowKuchera", // owner exception: deep profile but stays simple (decision 1)
  "bulkShear0to6km",
  "supercellCompositeParameter",
  "significantTornadoParameter",
  "effectiveBulkShear",
  "lapseRate0to3km",
  "snow10to1",
  "wetBulbZeroHeight",
  "surfaceThetaE",
  "surfaceBasedLclHeight",
  "sbcape",
  "srh0to3km",
];

test("RENDER_CATEGORY_IDS is exactly the 7 owner categories", () => {
  assert.deepEqual([...RENDER_CATEGORY_IDS], ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]);
});

test("GROUP_TO_CATEGORY maps every catalog group to a valid category", () => {
  const groups = new Set(NOAA_NAM_PARAMETER_CATALOG.map((entry) => entry.group));
  for (const group of groups) {
    assert.ok(Object.prototype.hasOwnProperty.call(GROUP_TO_CATEGORY, group), `no mapping for group ${group}`);
    assert.ok(
      VALID_CATEGORIES.has(GROUP_TO_CATEGORY[group]),
      `group ${group} maps to invalid category ${GROUP_TO_CATEGORY[group]}`,
    );
  }
});

test("every catalog entry gets a valid category from the 7", () => {
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    assert.ok(VALID_CATEGORIES.has(entry.category), `entry ${entry.key} has invalid category ${entry.category}`);
  }
});

test("category is exactly GROUP_TO_CATEGORY of the entry group", () => {
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    assert.equal(entry.category, GROUP_TO_CATEGORY[entry.group], `entry ${entry.key} category mismatch`);
  }
});

test("named full-tier keys are costTier full", () => {
  const byKey = new Map(NOAA_NAM_PARAMETER_CATALOG.map((entry) => [entry.key, entry]));
  for (const key of FULL_TIER_KEYS) {
    const entry = byKey.get(key);
    assert.ok(entry, `expected catalog to contain ${key}`);
    assert.equal(entry.costTier, "full", `${key} should be full tier`);
  }
});

test("named simple-tier keys are costTier simple (incl. the Kuchera exception)", () => {
  const byKey = new Map(NOAA_NAM_PARAMETER_CATALOG.map((entry) => [entry.key, entry]));
  for (const key of SIMPLE_TIER_KEYS) {
    const entry = byKey.get(key);
    assert.ok(entry, `expected catalog to contain ${key}`);
    assert.equal(entry.costTier, "simple", `${key} should be simple tier`);
  }
});

test("snowKuchera is explicitly simple despite its deep profile", () => {
  const kuchera = NOAA_NAM_PARAMETER_CATALOG.find((entry) => entry.key === "snowKuchera");
  assert.ok(kuchera, "expected catalog to contain snowKuchera");
  assert.ok(
    kuchera.profileLevels && kuchera.profileLevels.length > 6,
    "guard: Kuchera has a deep profile the bare heuristic would flag",
  );
  assert.equal(kuchera.costTier, "simple", "owner decision 1: Kuchera stays simple");
});

test("exactly the six authored keys are full tier", () => {
  const fullKeys = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.costTier === "full")
    .map((entry) => entry.key)
    .sort();
  assert.deepEqual(fullKeys, [...FULL_TIER_KEYS].sort());
});

test("metadata surfaces category and costTier for every entry", () => {
  const metadata = getNoaaNamParameterMetadata();
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    if (entry.hidden) {
      continue;
    }
    const meta = metadata[entry.key];
    assert.ok(meta, `metadata missing ${entry.key}`);
    assert.equal(meta.category, entry.category, `metadata category mismatch for ${entry.key}`);
    assert.equal(meta.costTier, entry.costTier, `metadata costTier mismatch for ${entry.key}`);
  }
});
