const test = require("node:test");
const assert = require("node:assert/strict");
const { getNoaaNamParameterMetadata } = require("../scripts/lib/noaa-nam-parameter-catalog");

// The 7 render categories the UI exposes, mirrored from spec §1.1. This test
// guards that the client taxonomy stays coherent with the server catalog's
// per-entry `category` stamp (added in Phase A1). If A1 renamed a category or
// re-binned a group, this fails loudly.
const CLIENT_CATEGORY_IDS = ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"];

test("every non-hidden catalog entry maps to one of the 7 client categories", () => {
  const metadata = getNoaaNamParameterMetadata();
  const seen = new Set();
  for (const entry of Object.values(metadata)) {
    assert.ok(entry.category, `entry ${entry.key} is missing a category stamp`);
    assert.ok(
      CLIENT_CATEGORY_IDS.includes(entry.category),
      `entry ${entry.key} has unknown category ${entry.category}`,
    );
    seen.add(entry.category);
  }
  // Non-tiered families that must always be present.
  for (const id of ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]) {
    assert.ok(seen.has(id), `no catalog entry mapped to category ${id}`);
  }
});

test("named heavy keys carry costTier full and named cheap keys carry costTier simple", () => {
  const metadata = getNoaaNamParameterMetadata();
  // NOTE: the drafted brief listed snowKuchera as heavy; per the owner decision
  // recorded in .superpowers/sdd/progress.md ("winter simple KEEPS Kuchera",
  // 6-key FULL_TIER_KEYS) and the landed A.1 guard test, Kuchera is simple.
  const heavy = [
    "effectiveLayerSupercellCompositeParameter",
    "effectiveLayerSignificantTornadoParameter",
    "dcape",
    "snowRfConus",
    "snowWesternLinear",
    "snowCobb",
  ];
  const cheap = [
    "snowKuchera",
    "sbcape",
    "srh0to1km",
    "bulkShear0to6km",
    "supercellCompositeParameter",
    "snow10to1",
    "snowDepth",
    "wetBulbZeroHeight",
  ];
  for (const key of heavy) {
    assert.equal(metadata[key]?.costTier, "full", `${key} should be full-tier`);
  }
  for (const key of cheap) {
    assert.equal(metadata[key]?.costTier, "simple", `${key} should be simple-tier`);
  }
});
