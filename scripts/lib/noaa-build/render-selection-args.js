"use strict";

const { SCIENCE_PROTOTYPE_IDS, resolveNoaaNamParameterCatalog } = require("../noaa-nam-parameter-catalog");
const { selectionAllows } = require("../noaa-beta/selection");

// The 7 merged render categories (design §1.1), in panel display order.
const RENDER_CATEGORY_IDS = ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"];
// Only these two categories accept a simple/full compute tier (design §1.2).
const TIERED_CATEGORY_IDS = new Set(["severe", "winter"]);
const RENDER_TIERS = new Set(["simple", "full"]);
const CAM_SCIENCE_PROTOTYPE_MODELS = new Set(["hrrr", "nam3km"]);

function parseSciencePrototypeList(raw) {
  const tokens = String(raw || "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  const allowed = new Set(SCIENCE_PROTOTYPE_IDS);
  const seen = new Set();
  for (const token of tokens) {
    if (!allowed.has(token)) {
      throw new Error(`unknown science prototype '${token}'. Allowed: ${SCIENCE_PROTOTYPE_IDS.join(", ")}.`);
    }
    seen.add(token);
  }
  return SCIENCE_PROTOTYPE_IDS.filter((id) => seen.has(id));
}

function parseCategoryList(raw) {
  const tokens = String(raw || "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  // Only called when --categories is present (see parseRenderSelectionFromArgs):
  // an explicitly empty list would allowlist nothing and build a degenerate
  // floor-placeholders-only catalog that can still advance the latest pointer —
  // the exact failure the render server rejects before spawn. Omitting the
  // flag entirely is the supported way to build all categories.
  if (tokens.length === 0) {
    throw new Error(
      `--categories was provided but names no categories (got '${raw}'). ` +
        `Pass at least one of: ${RENDER_CATEGORY_IDS.join(", ")} — or omit the flag to enable all categories.`,
    );
  }
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
  const hasSciencePrototypes = source["science-prototypes"] !== undefined;
  if (!hasCategories && !hasSevereTier && !hasWinterTier && !hasSciencePrototypes) {
    return null;
  }
  // When any selection flag is present, an absent --categories means "all on".
  const enabled = hasCategories ? parseCategoryList(source.categories) : new Set(RENDER_CATEGORY_IDS);
  const severeTier = parseTier(source["severe-tier"], "severe");
  const winterTier = parseTier(source["winter-tier"], "winter");
  const sciencePrototypes = hasSciencePrototypes ? parseSciencePrototypeList(source["science-prototypes"]) : [];
  validateSciencePrototypePrerequisites({ sciencePrototypes, models, enabled, severeTier });
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
    ...(sciencePrototypes.length > 0 ? { sciencePrototypes } : {}),
  };
}

function validateSciencePrototypePrerequisites({ sciencePrototypes, models, enabled, severeTier }) {
  const selectedModels = new Set(
    (Array.isArray(models) ? models : []).map((model) =>
      String(model || "")
        .trim()
        .toLowerCase(),
    ),
  );
  const severeFull = enabled.has("severe") && severeTier === "full";
  if (
    sciencePrototypes.includes("camDcape21Level") &&
    ![...selectedModels].some((model) => CAM_SCIENCE_PROTOTYPE_MODELS.has(model))
  ) {
    throw new Error("science prototype 'camDcape21Level' requires a selected CAM model (hrrr or nam3km).");
  }
  for (const id of ["camDcape21Level", "effectiveStp100mbReduced"]) {
    if (sciencePrototypes.includes(id) && !severeFull) {
      throw new Error(`science prototype '${id}' requires the Severe category at full tier.`);
    }
  }
  // rowAwareCenterValidation has no category gate: the renderer always builds
  // core synoptic support and runs center detection for every selection.
}

function resolveRenderSelectionKeys(selection, catalog = null) {
  const list = Array.isArray(catalog) ? catalog : resolveNoaaNamParameterCatalog(selection);
  return list
    .filter((entry) => selectionAllows(selection, entry))
    .map((entry) => entry.key)
    .sort();
}

module.exports = {
  RENDER_CATEGORY_IDS,
  TIERED_CATEGORY_IDS,
  parseSciencePrototypeList,
  parseRenderSelectionFromArgs,
  resolveRenderSelectionKeys,
};
