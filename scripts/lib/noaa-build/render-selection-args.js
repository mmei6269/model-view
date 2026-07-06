"use strict";

const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { selectionAllows } = require("../noaa-beta/selection");

// The 7 merged render categories (design §1.1), in panel display order.
const RENDER_CATEGORY_IDS = ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"];
// Only these two categories accept a simple/full compute tier (design §1.2).
const TIERED_CATEGORY_IDS = new Set(["severe", "winter"]);
const RENDER_TIERS = new Set(["simple", "full"]);

function parseCategoryList(raw) {
  const tokens = String(raw || "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  const seen = new Set();
  for (const token of tokens) {
    if (!RENDER_CATEGORY_IDS.includes(token)) {
      throw new Error(`unknown render category '${token}'. Allowed: ${RENDER_CATEGORY_IDS.join(", ")}.`);
    }
    seen.add(token);
  }
  return seen;
}

function parseTier(raw, categoryId) {
  if (raw === undefined || raw === null || raw === "") {
    return "full";
  }
  const tier = String(raw).trim().toLowerCase();
  if (!RENDER_TIERS.has(tier)) {
    throw new Error(`invalid ${categoryId} tier '${raw}'. Allowed: simple, full.`);
  }
  return tier;
}

function parseRenderSelectionFromArgs(args, { models, view, run } = {}) {
  const source = args || {};
  const hasCategories = source.categories !== undefined;
  const hasSevereTier = source["severe-tier"] !== undefined;
  const hasWinterTier = source["winter-tier"] !== undefined;
  if (!hasCategories && !hasSevereTier && !hasWinterTier) {
    return null;
  }
  // When any selection flag is present, an absent --categories means "all on".
  const enabled = hasCategories ? parseCategoryList(source.categories) : new Set(RENDER_CATEGORY_IDS);
  const severeTier = parseTier(source["severe-tier"], "severe");
  const winterTier = parseTier(source["winter-tier"], "winter");
  return {
    models: Array.isArray(models) ? models : [],
    view: view || null,
    run: run || null,
    categories: {
      surface: enabled.has("surface"),
      precip: enabled.has("precip"),
      radar: enabled.has("radar"),
      cloud: enabled.has("cloud"),
      upperAir: enabled.has("upperAir"),
      severe: { enabled: enabled.has("severe"), tier: severeTier },
      winter: { enabled: enabled.has("winter"), tier: winterTier },
    },
  };
}

function resolveRenderSelectionKeys(selection, catalog = NOAA_NAM_PARAMETER_CATALOG) {
  const list = Array.isArray(catalog) ? catalog : NOAA_NAM_PARAMETER_CATALOG;
  return list
    .filter((entry) => selectionAllows(selection, entry))
    .map((entry) => entry.key)
    .sort();
}

module.exports = {
  RENDER_CATEGORY_IDS,
  TIERED_CATEGORY_IDS,
  parseRenderSelectionFromArgs,
  resolveRenderSelectionKeys,
};
