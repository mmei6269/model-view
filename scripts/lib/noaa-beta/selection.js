"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  NOAA_NAM_PARAMETER_CATALOG,
  RENDER_CATEGORY_IDS,
  SNOW_PROFILE_LEVELS,
  SUPPORT_SELECTORS,
  normalizeSciencePrototypeIds,
} = require("../noaa-nam-parameter-catalog");
const { MPS_TO_MPH } = require("./util");
const { PROFILE_SURFACE_DECODE_KEYS, profileDecodeKey, standardProfileDecodeKey } = require("./profile-access");
const { selectedRecordDecodeCacheKey } = require("./selected-grib");
const {
  PLETCHER_RF_FEATURE_KEYS,
  SNOW_RF_COMPILER_ID,
  inspectCompiledSnowRfModel,
  normalizeRfTree,
  normalizeSnowRfModel,
} = require("./snow-rf-compiler");
const {
  DEFAULT_BINARY_PATH: DEFAULT_SNOW_RF_BINARY_PATH,
  DEFAULT_MANIFEST_PATH: DEFAULT_SNOW_RF_MANIFEST_PATH,
  DEFAULT_SOURCE_PATH: DEFAULT_SNOW_RF_SOURCE_PATH,
  SNOW_RF_ASSET_MATERIALIZATION_PHASES,
  SNOW_RF_ASSET_ORACLES,
  SNOW_RF_SOURCE_IDENTITY,
  buildSnowRfCompilerClosure,
  createSnowRfLoadedState,
  materializeSnowRfAsset,
} = require("./snow-rf-asset");
const {
  findRecord,
  isSurfaceAccumulatedFreezingRainRecord,
  isSurfaceAccumulatedSnowWaterRecord,
  isSurfacePrecipAccumulationRecord,
  isSurfacePrecipRecord,
  parseAccumulationWindow,
  parseAverageWindow,
} = require("./records");

const SNOW_RF_MODEL_CACHE = new Map();

const SNOW_RF_MODEL_PATH_CACHE = new Map();

const SNOW_ARTIFACT_IDENTITY_CACHE = new Map();

const SNOW_RF_LOAD_STATE_CACHE = new Map();

const SNOW_RF_LOAD_FAILURE_CACHE = new Set();

const SNOW_RF_ASSET_ENV = "MODELVIEW_NOAA_SNOW_RF_ASSET";

const SNOW_RF_CUSTOM_PATH_ENV = "MODELVIEW_SNOW_RF_CONUS_PATH";

const SNOW_RF_COMMON_LOAD_PHASES = Object.freeze(["identityOnlySourceCaptureNs", "modelSourceCaptureNs"]);
const SNOW_RF_SOURCE_STREAM_CHUNK_BYTES = 8 * 1024 * 1024;

const SNOW_RF_JSON_LOAD_PHASES = Object.freeze(["jsonParseNs", "strictCompileNs", "graphValidateNs"]);

const SNOW_RF_TYPED_READ_PHASES = Object.freeze(["manifestReadNs", "manifestParseNs", "binaryReadNs"]);

const SNOW_RF_TYPED_ATTEMPT_PHASES = Object.freeze([
  ...SNOW_RF_TYPED_READ_PHASES,
  ...SNOW_RF_ASSET_MATERIALIZATION_PHASES,
]);

let warnedAboutUnknownSnowRfMode = false;

let snowRfStartupConfiguration = null;

const warnedSnowRfLoadFailures = new Set();

const warnedSnowRfAutoFallbackPaths = new Set();

const snowRfLoadsInFlight = new Map();

const FREEZING_RAIN_LIQUID_TOTAL_KEY = "freezingRainLiquidTotal";

const FRAM_FLAT_ICE_KEY = "framFlatIce";

const FRAM_RADIAL_ICE_KEY = "framRadialIce";

const SELECTION_DECODE_DEPENDENCY_SCHEMA_VERSION = "noaa-selection-decode-dependencies-v2";

const SELECTION_SUPPORT_PRODUCT = "$selection-support";

const SELECTION_DECODE_DEPENDENCY_ROLES = Object.freeze(["direct", "profile", "source", "support"]);

const SNOW_SOURCE_SELECTORS = Object.freeze({
  snow: Object.freeze({ param: "CSNOW", level: "surface" }),
  rain: Object.freeze({ param: "CRAIN", level: "surface" }),
  freezingRain: Object.freeze({ param: "CFRZR", level: "surface" }),
  icePellets: Object.freeze({ param: "CICEP", level: "surface" }),
});

const RUN_MAX_ACCUMULATION_SOURCES = Object.freeze({
  gustRunMax: Object.freeze({
    sourceKey: "gust",
    selector: Object.freeze({ param: "GUST", level: "surface" }),
    multiplier: MPS_TO_MPH,
  }),
  updraftHelicity2to5kmRunMax: Object.freeze({
    sourceKey: "updraftHelicity2to5km1h",
    selector: Object.freeze({ param: "MXUPHL", level: "5000-2000 m above ground", statistic: "maximum" }),
    multiplier: 1,
  }),
});

const SNOW_MASK_TYPE_KEYS = Object.freeze(["snow", "rain", "freezingRain", "icePellets"]);

const POINT_SOUNDING_PROFILE_LEVELS = Object.freeze([...SNOW_PROFILE_LEVELS, 250, 200, 150, 100]);

const POINT_SOUNDING_PROFILE_VARIABLES = Object.freeze(["HGT", "TMP", "RH", "DPT", "UGRD", "VGRD"]);

const POINT_SOUNDING_DIRECT_SELECTORS = Object.freeze({
  mslp: Object.freeze({ param: "PRMSL", level: "mean sea level" }),
  pblHeight: Object.freeze({ param: "HPBL", level: "surface" }),
  pwat: Object.freeze({ param: "PWAT", levelPattern: /entire atmosphere/i }),
  // UPP defines its 20,000 m no-ceiling sentinel from total cloud cover.
  // Point soundings bypass the map regrid, so retain TCDC alongside HGT to
  // establish the no-ceiling state independently of the sentinel value.
  cloudCover: Object.freeze({ param: "TCDC", levelPattern: /entire atmosphere/i }),
  cloudCeiling: Object.freeze({ param: "HGT", level: "cloud ceiling" }),
  wetBulbZeroHeight: Object.freeze({ param: "HGT", level: "lowest level of the wet bulb zero" }),
  lclHeight: Object.freeze({ param: "HGT", level: "level of adiabatic condensation from sfc" }),
  cape0to3km: Object.freeze({ param: "CAPE", level: "3000-0 m above ground" }),
  sbcape: Object.freeze({ param: "CAPE", level: "surface" }),
  sbcin: Object.freeze({ param: "CIN", level: "surface" }),
  mlcape: Object.freeze({ param: "CAPE", level: "90-0 mb above ground" }),
  mlcin: Object.freeze({ param: "CIN", level: "90-0 mb above ground" }),
  mucape: Object.freeze({ param: "CAPE", level: "255-0 mb above ground" }),
  mucapeNam: Object.freeze({ param: "CAPE", level: "180-0 mb above ground" }),
  srh0to1km: Object.freeze({ param: "HLCY", level: "1000-0 m above ground" }),
  srh0to3km: Object.freeze({ param: "HLCY", level: "3000-0 m above ground" }),
  updraftHelicity2to5km: Object.freeze({
    param: "MXUPHL",
    level: "5000-2000 m above ground",
    statistic: "maximum",
  }),
  maxHailSize: Object.freeze({ param: "HAIL", levelPattern: /entire atmosphere/i }),
});

const WESTERN_LINEAR_FEATURE_KEYS = Object.freeze(["T04K", "T24K", "SPD04K", "SPD24K"]);

const CURRENT_UI_SELECTORS = Object.freeze({
  temperature2m: { param: "TMP", level: "2 m above ground", required: true },
  windU10m: { param: "UGRD", level: "10 m above ground", required: true },
  windV10m: { param: "VGRD", level: "10 m above ground", required: true },
  precip: { param: "APCP", level: "surface", required: false },
  reflectivityComposite: { param: "REFC", level: null, levelPattern: /entire atmosphere/i, required: false },
  reflectivity1km: { param: "REFD", level: "1000 m above ground", required: false },
  reflectivity: { param: "REFC", level: null, levelPattern: /entire atmosphere/i, required: false },
  pressureMsl: { param: "PRMSL", level: "mean sea level", required: false },
  height500: { param: "HGT", level: "500 mb", required: false },
  height1000: { param: "HGT", level: "1000 mb", required: false },
  cape: { param: "CAPE", level: null, required: false },
});

const PROFILE_SURFACE_SELECTORS = Object.freeze({
  HGT: Object.freeze({ param: "HGT", level: "surface" }),
  TMP: CURRENT_UI_SELECTORS.temperature2m,
  RH: Object.freeze({ param: "RH", level: "2 m above ground" }),
  DPT: Object.freeze({ param: "DPT", level: "2 m above ground" }),
  SPFH: Object.freeze({ param: "SPFH", level: "2 m above ground" }),
  PRES: Object.freeze({ param: "PRES", level: "surface" }),
  UGRD: CURRENT_UI_SELECTORS.windU10m,
  VGRD: CURRENT_UI_SELECTORS.windV10m,
});

// A nullish selection is the "render everything at full tier" sentinel: the
// filter must return exactly the pre-selection per-mode list so a no-flags
// build stays byte-identical to today (spec exactness constraint).
function normalizeRenderSelection(selection) {
  if (!selection || typeof selection !== "object") {
    return null;
  }
  const sciencePrototypes = normalizeSciencePrototypeIds(selection);
  const categorySource = selection.categories && typeof selection.categories === "object" ? selection.categories : null;
  if (!categorySource && sciencePrototypes.length === 0) {
    return null;
  }
  const categories = {};
  for (const id of RENDER_CATEGORY_IDS) {
    const raw = categorySource?.[id];
    if (raw === true) {
      categories[id] = { enabled: true, tier: "full" };
    } else if (raw === false) {
      categories[id] = { enabled: false, tier: "full" };
    } else if (raw == null) {
      categories[id] = { enabled: true, tier: "full" };
    } else if (typeof raw === "object") {
      const tier = raw.tier === "simple" ? "simple" : "full";
      categories[id] = { enabled: raw.enabled !== false, tier };
    } else {
      categories[id] = { enabled: true, tier: "full" };
    }
  }
  return {
    categories,
    ...(sciencePrototypes.length > 0 ? { sciencePrototypes } : {}),
  };
}

function selectionAllows(selection, entry) {
  const normalized = selection && selection.categories ? normalizeRenderSelection(selection) : null;
  if (!normalized) {
    return true;
  }
  const category = normalized.categories[entry?.category];
  if (!category || !category.enabled) {
    return false;
  }
  if (entry?.costTier === "simple") {
    return true;
  }
  return category.tier === "full";
}

function filterCatalogForRenderMode(catalog, renderMode, selection) {
  const list = Array.isArray(catalog) ? catalog : NOAA_NAM_PARAMETER_CATALOG;
  let modeList;
  if (renderMode === "base") {
    modeList = list.filter((entry) => entry.kind !== "snowfallDerived");
  } else if (renderMode === "runmax-prefix") {
    modeList = list.filter((entry) => Boolean(RUN_MAX_ACCUMULATION_SOURCES[entry.key]));
  } else if (renderMode === "snow" || renderMode === "snow-delta" || renderMode === "snow-prefix") {
    modeList = list.filter((entry) => entry.kind === "snowfallDerived");
  } else {
    modeList = list;
  }
  const normalizedSelection = normalizeRenderSelection(selection);
  if (!normalizedSelection) {
    // Preserve object identity + order of the pre-selection path exactly.
    return modeList;
  }
  return modeList.filter((entry) => selectionAllows(normalizedSelection, entry));
}

function selectSnowfallDerivedParameterRecords(records, options = {}) {
  return selectNoaaNamParameterRecords(records, {
    catalog: NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.kind === "snowfallDerived"),
    modelKey: options.modelKey,
    targetHour: options.targetHour,
    renderMode: "snow-delta",
  });
}

function selectPointSoundingRecords(records) {
  const selected = {};
  const addRecord = (key, selector) => {
    const record = findRecord(records, selector);
    if (record && key && !selected[key]) {
      selected[key] = record;
    }
    return record;
  };

  addRecord("surfaceHeight", PROFILE_SURFACE_SELECTORS.HGT);
  addRecord("surfacePressure", PROFILE_SURFACE_SELECTORS.PRES);
  addRecord("surfaceTmp", PROFILE_SURFACE_SELECTORS.TMP);
  addRecord("surfaceDpt", PROFILE_SURFACE_SELECTORS.DPT);
  addRecord("surfaceRh", PROFILE_SURFACE_SELECTORS.RH);
  addRecord("surfaceU", PROFILE_SURFACE_SELECTORS.UGRD);
  addRecord("surfaceV", PROFILE_SURFACE_SELECTORS.VGRD);
  for (const [key, selector] of Object.entries(POINT_SOUNDING_DIRECT_SELECTORS)) {
    addRecord(`direct${key[0].toUpperCase()}${key.slice(1)}`, selector);
  }

  const availableLevels = [];
  for (const level of POINT_SOUNDING_PROFILE_LEVELS) {
    let levelAvailable = false;
    for (const variable of POINT_SOUNDING_PROFILE_VARIABLES) {
      const record = addRecord(`profile${variable}${level}`, profileSelector(variable, level));
      levelAvailable = levelAvailable || Boolean(record);
    }
    if (levelAvailable) {
      availableLevels.push(level);
    }
  }

  return { records: selected, availableLevels };
}

function mergeSelectedNoaaRecords(primary, supplemental) {
  const out = [];
  const seen = new Set();
  const add = (record) => {
    if (!record) {
      return;
    }
    const key = `${record.record || ""}\u0000${record.offset || ""}\u0000${record.param || ""}\u0000${record.level || ""}\u0000${
      record.forecast || ""
    }`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(record);
  };
  for (const record of primary || []) {
    add(record);
  }
  for (const record of supplemental || []) {
    add(record);
  }
  return out;
}

function selectNamAwphysRecords(records) {
  const selected = {};
  const missingRequired = [];
  for (const [key, selector] of Object.entries(CURRENT_UI_SELECTORS)) {
    const record = findRecord(records, selector);
    if (record) {
      selected[key] = record;
    } else if (selector.required) {
      missingRequired.push(`${selector.param}:${selector.level || "*"}`);
    }
  }
  return {
    records: selected,
    missingRequired,
  };
}

// options.renderMode is accepted for interface compatibility: call sites pass
// it, but the mode acts only through the pre-filtered options.catalog (see
// filterCatalogForRenderMode), so this function never reads it.
function selectNoaaNamParameterRecords(records, catalogOrOptions = NOAA_NAM_PARAMETER_CATALOG) {
  const options = Array.isArray(catalogOrOptions) ? { catalog: catalogOrOptions } : catalogOrOptions || {};
  const catalog = Array.isArray(options.catalog) ? options.catalog : NOAA_NAM_PARAMETER_CATALOG;
  const modelKey = normalizeSelectionModelKey(options.modelKey);
  const targetHour = Number.isFinite(Number(options.targetHour)) ? Number(options.targetHour) : null;
  const selected = {};
  const dependencyOwners = new Map();
  const missingRequired = [];
  const availableParameters = [];
  const missingOptionalParameters = [];
  const includeRecord = (key, selector, target = selected, dependency = null, targetOwners = dependencyOwners) => {
    if (key && target?.[key]) {
      addSelectionDecodeDependencyOwner(targetOwners, key, dependency);
      return target[key];
    }
    if (key && target !== selected && selected?.[key]) {
      target[key] = selected[key];
      addSelectionDecodeDependencyOwner(targetOwners, key, dependency);
      return selected[key];
    }
    const record = findRecord(records, selector);
    if (record) {
      target[key] = record;
      addSelectionDecodeDependencyOwner(targetOwners, key, dependency);
    }
    return record;
  };

  for (const [key, selector] of Object.entries(SUPPORT_SELECTORS)) {
    includeRecord(key, selector, selected, {
      product: SELECTION_SUPPORT_PRODUCT,
      role: "support",
    });
  }

  for (const entry of catalog) {
    const required = Boolean(entry.required);
    if (!isCatalogEntryApplicableToModel(entry, modelKey)) {
      // "Definitionally not produced for this model" is not "missing
      // required data": missingRequired hard-fails the build with an error
      // naming records that were never expected for this model. Inapplicable
      // entries are simply absent parameters.
      missingOptionalParameters.push(entry.key);
      continue;
    }
    const staged = { ...selected };
    const stagedOwners = new Map();
    const includeStagedRecord = (key, selector, role = "direct") =>
      includeRecord(
        key,
        selector,
        staged,
        {
          product: entry.key,
          role,
        },
        stagedOwners,
      );
    let available;
    if (entry.kind === "wind") {
      const uRecord = includeStagedRecord(entry.uKey, entry.uSelector, "direct");
      const vRecord = includeStagedRecord(entry.vKey, entry.vSelector, "direct");
      available = Boolean(uRecord && vRecord);
    } else if (entry.kind === "reflectivityPrecipType") {
      const reflectivityRecord = includeStagedRecord(entry.reflectivityKey, entry.reflectivitySelector, "direct");
      const precipTypeEntries = Object.entries(entry.precipTypeKeys || {});
      const precipTypeRecords = precipTypeEntries.map(([typeKey, recordKey]) =>
        includeStagedRecord(recordKey, entry.precipTypeSelectors?.[typeKey], "direct"),
      );
      available = Boolean(reflectivityRecord && precipTypeRecords.length > 0 && precipTypeRecords.every(Boolean));
    } else if (entry.kind === "precipRateType") {
      const rateRecord = includeStagedRecord(entry.rateKey, entry.rateSelector, "direct");
      const precipTypeEntries = Object.entries(entry.precipTypeKeys || {});
      const precipTypeRecords = precipTypeEntries.map(([typeKey, recordKey]) =>
        includeStagedRecord(recordKey, entry.precipTypeSelectors?.[typeKey], "direct"),
      );
      available = Boolean(rateRecord && precipTypeRecords.length > 0 && precipTypeRecords.every(Boolean));
    } else if (entry.kind === "precipAccumulation") {
      // Deliberately not gated by entry.minForecastHour: these entries declare
      // minForecastHour 1, and gating them would drop precip/precip3h/.../
      // precipTotal from F000 availability, changing rendered output beyond
      // the intended snowfallDirect fix (verified against the live catalog).
      available = records.some((record) => isSurfacePrecipRecord(record));
    } else if (isFreezingRainDerivedAccumulationEntry(entry)) {
      available = includeFreezingRainDerivedAccumulationRecords(entry, records, includeStagedRecord, staged, {
        targetHour,
        recordDependency(key, role) {
          addSelectionDecodeDependencyOwner(stagedOwners, key, {
            product: entry.key,
            role,
          });
        },
      });
    } else if (entry.kind === "derivedScalar" || entry.kind === "derivedAccumulation") {
      available = includeDerivedParameterRecords(entry, records, includeStagedRecord, staged, { targetHour });
    } else if (entry.kind === "snowfallDerived") {
      available = includeSnowfallDerivedRecords(entry, records, includeStagedRecord, staged, { targetHour });
    } else if (entry.kind === "snowfallDirect") {
      // Below minForecastHour the direct accumulation record is a trivially
      // zero 0-0-hour window; gating here keeps it out of `staged` entirely so
      // it is neither offered as available nor selected for decode.
      available =
        !isBelowMinForecastHour(entry, targetHour) &&
        Boolean(includeStagedRecord(entry.inputKey, entry.selector, "direct"));
    } else {
      const record = includeStagedRecord(entry.inputKey, entry.selector, "direct");
      available = Boolean(record && includeCatalogSourceSelectorRecords(entry, includeStagedRecord, staged));
    }
    if (available) {
      Object.assign(selected, staged);
      mergeSelectionDecodeDependencyOwners(dependencyOwners, stagedOwners);
      availableParameters.push(entry.key);
    } else if (required) {
      missingRequired.push(entry.key);
    } else {
      missingOptionalParameters.push(entry.key);
    }
  }

  addPressureTerrainSupportDependencies({
    catalog,
    availableParameters,
    selected,
    dependencyOwners,
  });

  const selection = {
    records: selected,
    missingRequired,
    availableParameters,
    missingOptionalParameters,
    catalog,
  };
  selection.decodeDependencies = buildSelectionDecodeDependencies(selection, dependencyOwners);
  return selection;
}

function addSelectionDecodeDependencyOwner(ownersByKey, key, dependency) {
  const normalizedKey = String(key || "");
  const product = String(dependency?.product || "");
  const role = String(dependency?.role || "");
  if (!normalizedKey || !product || !SELECTION_DECODE_DEPENDENCY_ROLES.includes(role)) {
    return;
  }
  const owners = ownersByKey.get(normalizedKey) || new Map();
  owners.set(`${product}\u0000${role}`, { product, role });
  ownersByKey.set(normalizedKey, owners);
}

function mergeSelectionDecodeDependencyOwners(target, source) {
  for (const [key, sourceOwners] of source || []) {
    for (const owner of sourceOwners.values()) {
      addSelectionDecodeDependencyOwner(target, key, owner);
    }
  }
}

function addPressureTerrainSupportDependencies({ catalog, availableParameters, selected, dependencyOwners }) {
  const available = new Set(availableParameters || []);
  for (const entry of catalog || []) {
    if (!available.has(entry?.key)) {
      continue;
    }
    for (const level of selectionCatalogPressureLevelsMb(entry)) {
      const standardHeightKey = standardProfileDecodeKey("HGT", level);
      const profileHeightKey = profileDecodeKey("HGT", level);
      const heightKey = selected?.[standardHeightKey]
        ? standardHeightKey
        : selected?.[profileHeightKey]
          ? profileHeightKey
          : null;
      if (!heightKey) {
        continue;
      }
      // Raster and derived-grid builders consume these grids implicitly for
      // below-terrain masks. This includes pressure levels declared through
      // sourceSelectors (frontogenesis and relative vorticity), not only a
      // catalog entry's direct selector. Support ownership guarantees a
      // restored severe/profile sidecar cannot prune a still-live mask.
      addSelectionDecodeDependencyOwner(dependencyOwners, heightKey, {
        product: entry.key,
        role: "support",
      });
    }
  }
}

function selectionCatalogPressureLevelMb(entry) {
  return selectionCatalogPressureLevelsMb(entry)[0] ?? Number.NaN;
}

function selectionCatalogPressureLevelsMb(entry) {
  const levels = new Set();
  const directLevel = Number(entry?.contourLevelMb);
  if (Number.isFinite(directLevel) && directLevel > 0) {
    levels.add(Math.round(directLevel));
  }
  const selectors = [
    entry?.selector,
    entry?.uSelector,
    entry?.vSelector,
    ...(Array.isArray(entry?.sourceSelectors) ? entry.sourceSelectors.map((source) => source?.selector) : []),
  ];
  for (const selector of selectors) {
    const match = String(selector?.level || "").match(/^\s*(\d+(?:\.\d+)?)\s*mb\s*$/i);
    if (match) {
      levels.add(Math.round(Number(match[1])));
    }
  }
  return [...levels].sort((left, right) => left - right);
}

function buildSelectionDecodeDependencies(selection, ownersByKey) {
  const products = Array.from(new Set((selection?.availableParameters || []).map(String))).sort();
  const records = Object.keys(selection?.records || {})
    .sort()
    .map((key) => {
      const owners = Array.from(ownersByKey.get(key)?.values() || []).sort(compareSelectionDependencyOwners);
      return { key, owners };
    });
  const decodeDependencies = {
    schemaVersion: SELECTION_DECODE_DEPENDENCY_SCHEMA_VERSION,
    products,
    records,
  };
  return {
    ...decodeDependencies,
    selectionIdentity: selectionDecodeDependencyIdentity(selection, decodeDependencies),
  };
}

function compareSelectionDependencyOwners(left, right) {
  return compareSelectionStrings(left.product, right.product) || compareSelectionStrings(left.role, right.role);
}

function compareSelectionStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function selectionDecodeDependencyIdentity(selection, decodeDependencies = selection?.decodeDependencies) {
  if (!selection || !decodeDependencies) {
    return null;
  }
  const payload = {
    schemaVersion: decodeDependencies.schemaVersion,
    products: decodeDependencies.products,
    dependencyRecords: decodeDependencies.records,
    selectedRecords: Object.keys(selection.records || {})
      .sort()
      .map((key) => ({ key, decodeIdentity: selectedRecordDecodeCacheKey(selection.records[key]) })),
    availableParameters: Array.from(new Set((selection.availableParameters || []).map(String))).sort(),
    missingRequired: Array.from(new Set((selection.missingRequired || []).map(String))).sort(),
    missingOptionalParameters: Array.from(new Set((selection.missingOptionalParameters || []).map(String))).sort(),
    catalogProducts: (selection.catalog || [])
      .map((entry) => ({ key: String(entry?.key || ""), kind: String(entry?.kind || "") }))
      .sort(
        (left, right) => compareSelectionStrings(left.key, right.key) || compareSelectionStrings(left.kind, right.kind),
      ),
  };
  return crypto.createHash("sha256").update(stableSelectionJson(payload)).digest("hex");
}

function stableSelectionJson(value) {
  return JSON.stringify(stableSelectionValue(value));
}

function stableSelectionValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (value instanceof RegExp) {
    return { $regex: value.source, $flags: value.flags };
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return Array.from(value, stableSelectionValue);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined && typeof value[key] !== "function") {
        out[key] = stableSelectionValue(value[key]);
      }
    }
    return out;
  }
  return String(value);
}

function includeCatalogSourceSelectorRecords(entry, includeRecord, selected) {
  const sourceSelectors = Array.isArray(entry?.sourceSelectors) ? entry.sourceSelectors : [];
  const sourceAvailability = new Map();
  let requiredSourcesAvailable = true;
  for (const source of sourceSelectors) {
    const key = source?.key;
    const selector = source?.selector;
    if (!key || !selector) {
      if (source?.required !== false) {
        requiredSourcesAvailable = false;
      }
      continue;
    }
    const record = includeRecord(key, selector, "source");
    const available = Boolean(record || selected?.[key]);
    sourceAvailability.set(key, available);
    if (source.required !== false && !available) {
      requiredSourcesAvailable = false;
    }
  }
  const anyGroupsAvailable = (entry?.anySourceKeyGroups || []).every((groupKeys) =>
    groupKeys.some((key) => Boolean(sourceAvailability.get(key) || selected?.[key])),
  );
  return requiredSourcesAvailable && anyGroupsAvailable;
}

function normalizeSelectionModelKey(modelKey) {
  const value = String(modelKey || "")
    .trim()
    .toLowerCase();
  return value || null;
}

function isCatalogEntryApplicableToModel(entry, modelKey) {
  const models = Array.isArray(entry?.models) ? entry.models : [];
  if (models.length === 0 || !modelKey) {
    return true;
  }
  return models.includes(modelKey);
}

// Shared minimum-forecast-hour gate: an entry declaring minForecastHour is
// definitionally empty below that hour (e.g. a 0-0-hour accumulation window),
// so it must not be offered as available there. An entry without a finite
// minForecastHour is never gated.
function isBelowMinForecastHour(entry, targetHour) {
  const minForecastHour = Number(entry?.minForecastHour);
  return Number.isFinite(targetHour) && Number.isFinite(minForecastHour) && targetHour < minForecastHour;
}

function includeDerivedParameterRecords(entry, records, includeRecord, selected, options = {}) {
  if (isBelowMinForecastHour(entry, options.targetHour)) {
    return false;
  }

  let directAvailable = false;
  if (entry?.directSelector && entry?.directInputKey) {
    directAvailable = Boolean(includeRecord(entry.directInputKey, entry.directSelector, "direct"));
  }

  const sourceSelectors = Array.isArray(entry?.sourceSelectors) ? entry.sourceSelectors : [];
  const sourceAvailability = new Map();
  let requiredSourcesAvailable = true;
  for (const source of sourceSelectors) {
    const key = source?.key;
    const selector = source?.selector;
    if (!key || !selector) {
      if (source?.required !== false) {
        requiredSourcesAvailable = false;
      }
      continue;
    }
    const record = includeRecord(key, selector, "source");
    const available = Boolean(record || selected?.[key]);
    sourceAvailability.set(key, available);
    if (source.required !== false && !available) {
      requiredSourcesAvailable = false;
    }
  }

  const anyGroupsAvailable = (entry?.anySourceKeyGroups || []).every((groupKeys) =>
    groupKeys.some((key) => Boolean(sourceAvailability.get(key) || selected?.[key])),
  );
  const variables = Array.isArray(entry?.profileVariables) ? entry.profileVariables : [];
  let profileAvailable = true;
  if (variables.length > 0) {
    const surfaceHeight = includeRecord(PROFILE_SURFACE_DECODE_KEYS.HGT, PROFILE_SURFACE_SELECTORS.HGT, "profile");
    if (entry?.surfaceHeightRequired && !surfaceHeight) {
      profileAvailable = false;
    } else {
      profileAvailable = hasSnowfallProfileRecords(entry, variables, records, includeRecord, selected);
    }
  }

  return directAvailable || (requiredSourcesAvailable && anyGroupsAvailable && profileAvailable);
}

function includeSnowfallDerivedRecords(entry, records, includeRecord, selected, options = {}) {
  if (isBelowMinForecastHour(entry, options.targetHour)) {
    return false;
  }
  if (entry?.artifactRequired && !isSnowArtifactReady(entry)) {
    return false;
  }
  const hasSnowLiquidSource = hasSnowfallLiquidCandidateRecords(records);
  if (!hasSnowLiquidSource) {
    return false;
  }
  const variables = Array.isArray(entry?.profileVariables) ? entry.profileVariables : [];
  if (variables.length === 0) {
    return true;
  }
  const surfaceHeight = includeRecord(PROFILE_SURFACE_DECODE_KEYS.HGT, PROFILE_SURFACE_SELECTORS.HGT, "profile");
  if (entry?.surfaceHeightRequired && !surfaceHeight) {
    return false;
  }
  return hasSnowfallProfileRecords(entry, variables, records, includeRecord, selected);
}

function hasSnowfallLiquidCandidateRecords(records) {
  return records.some(isSurfaceAccumulatedSnowWaterRecord) || hasPhaseMaskedPrecipAccumulationCandidate(records);
}

function hasPhaseMaskedPrecipAccumulationCandidate(records) {
  const precipRecords = records.filter(isSurfacePrecipAccumulationRecord);
  if (precipRecords.length === 0) {
    return false;
  }
  const currentPhaseMasks = currentPhaseMaskRecords(records);
  return precipRecords.some((record) => {
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour <= window.startHour) {
      return false;
    }
    return Boolean(
      findExactAverageSnowMaskRecords(records, window.startHour, window.endHour) ||
      hasCompletePhaseMaskRecordSet(currentPhaseMasks),
    );
  });
}

function currentPhaseMaskRecords(records) {
  return {
    snow: findRecord(records, SNOW_SOURCE_SELECTORS.snow),
    rain: findRecord(records, SNOW_SOURCE_SELECTORS.rain),
    freezingRain: findRecord(records, SNOW_SOURCE_SELECTORS.freezingRain),
    icePellets: findRecord(records, SNOW_SOURCE_SELECTORS.icePellets),
  };
}

function isFreezingRainDerivedAccumulationEntry(entry) {
  return (
    entry?.kind === "derivedAccumulation" &&
    (entry.key === FREEZING_RAIN_LIQUID_TOTAL_KEY ||
      entry.key === FRAM_FLAT_ICE_KEY ||
      entry.key === FRAM_RADIAL_ICE_KEY)
  );
}

function includeFreezingRainDerivedAccumulationRecords(entry, records, includeRecord, selected, options = {}) {
  if (isBelowMinForecastHour(entry, options.targetHour)) {
    return false;
  }
  const directRecord = findSurfaceAccumulatedFreezingRainRecord(records, options.targetHour);
  if (directRecord && entry.key === FREEZING_RAIN_LIQUID_TOTAL_KEY && entry?.directInputKey) {
    selected[entry.directInputKey] = directRecord;
    options.recordDependency?.(entry.directInputKey, "direct");
  }
  const liquidSourceAvailable = Boolean(directRecord) || hasPhaseMaskedPrecipAccumulationCandidate(records);
  if (!liquidSourceAvailable) {
    return false;
  }
  if (entry.key === FREEZING_RAIN_LIQUID_TOTAL_KEY) {
    return true;
  }
  const temperature = includeRecord("temperature2m", PROFILE_SURFACE_SELECTORS.TMP, "source");
  const dewpoint = includeRecord("dewpoint2m", PROFILE_SURFACE_SELECTORS.DPT, "source");
  const humidity = includeRecord("humidity2m", PROFILE_SURFACE_SELECTORS.RH, "source");
  const windU = includeRecord("windU10m", PROFILE_SURFACE_SELECTORS.UGRD, "source");
  const windV = includeRecord("windV10m", PROFILE_SURFACE_SELECTORS.VGRD, "source");
  return Boolean(
    temperature && (dewpoint || humidity || selected?.dewpoint2m || selected?.humidity2m) && windU && windV,
  );
}

function hasSnowfallProfileRecords(entry, variables, records, includeRecord, selected) {
  const lazyProfile = Boolean(entry?.lazyProfile);
  const profileLevels = entry.profileLevels || SNOW_PROFILE_LEVELS;
  const requireCompleteProfile = Boolean(entry?.surfaceHeightRequired || entry?.completeProfileRequired);
  const profileCounts = new Map(variables.map((variable) => [variable, 0]));
  for (const variable of variables) {
    for (const level of profileLevels) {
      const record = resolveProfileRecord({
        variable,
        level,
        lazyProfile,
        records,
        selected,
        includeRecord,
      });
      if (!record && requireCompleteProfile) {
        return false;
      }
      if (record) {
        profileCounts.set(variable, (profileCounts.get(variable) || 0) + 1);
      }
    }
  }
  return variables.every((variable) => (profileCounts.get(variable) || 0) > 0);
}

function findSurfaceAccumulatedFreezingRainRecord(records, targetHour = null) {
  const target = Math.round(Number(targetHour));
  const hasTarget = targetHour !== null && targetHour !== undefined && Number.isFinite(target);
  const candidates = (Array.isArray(records) ? records : [])
    .filter((record) => {
      if (!isSurfaceAccumulatedFreezingRainRecord(record)) {
        return false;
      }
      if (!hasTarget) {
        return true;
      }
      const window = parseAccumulationWindow(record);
      return Boolean(window && window.endHour === target);
    })
    .sort((left, right) => {
      const leftWindow = parseAccumulationWindow(left);
      const rightWindow = parseAccumulationWindow(right);
      const leftDuration = (leftWindow?.endHour || 0) - (leftWindow?.startHour || 0);
      const rightDuration = (rightWindow?.endHour || 0) - (rightWindow?.startHour || 0);
      return rightDuration - leftDuration;
    });
  return candidates[0] || null;
}

function resolveProfileRecord({ variable, level, lazyProfile, records, selected, includeRecord }) {
  const standardKey = standardProfileDecodeKey(variable, level);
  const existingRecord = standardKey && selected?.[standardKey] ? selected[standardKey] : null;
  if (existingRecord) {
    includeRecord(standardKey, profileSelector(variable, level), "profile");
    return existingRecord;
  }
  const selector = profileSelector(variable, level);
  if (lazyProfile) {
    return findRecord(records, selector);
  }
  return includeRecord(profileDecodeKey(variable, level), selector, "profile");
}

function profileSelector(variable, level) {
  return {
    param: String(variable || "").toUpperCase(),
    level: `${Math.round(Number(level))} mb`,
  };
}

function findExactAverageSnowMaskRecords(records, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const end = Math.round(Number(endHour));
  if (!Array.isArray(records) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  const out = {};
  for (const key of SNOW_MASK_TYPE_KEYS) {
    const record = findAverageRecordForWindow(records, SNOW_SOURCE_SELECTORS[key], start, end);
    if (!record) {
      return null;
    }
    out[key] = record;
  }
  return out;
}

function findAverageRecordForWindow(records, selector, startHour, endHour) {
  if (!selector) {
    return null;
  }
  return (
    records.find((record) => {
      if (record.param !== selector.param || record.level !== selector.level) {
        return false;
      }
      const window = parseAverageWindow(record);
      return Boolean(window && window.startHour === startHour && window.endHour === endHour);
    }) || null
  );
}

function hasCompletePhaseMaskRecordSet(maskRecords) {
  return SNOW_MASK_TYPE_KEYS.every((key) => Boolean(maskRecords?.[key]));
}

function isSnowArtifactReady(entry) {
  if (!entry?.artifactRequired) {
    return true;
  }
  if (entry.artifactRequired === "snow-rf/conus-rf.json") {
    return Boolean(loadSnowRfModel("conus"));
  }
  if (entry.artifactRequired === "snow-rf/western-linear-v1c.json") {
    return Boolean(loadWesternLinearSlrModel());
  }
  const identity = snowArtifactCacheIdentity(entry.artifactRequired);
  return Boolean(identity?.sha256);
}

function snowArtifactCacheIdentity(artifactRequired, options) {
  if (!artifactRequired) {
    return null;
  }
  if (artifactRequired === "snow-rf/conus-rf.json") {
    const state = loadSnowRfState("conus", options);
    return state?.sourceIdentity || { artifactRequired, sha256: null, bytes: 0 };
  }
  const artifactPath = resolveSnowArtifactPath(artifactRequired);
  if (!artifactPath) {
    return { artifactRequired, sha256: null, bytes: 0 };
  }
  try {
    const stat = fs.statSync(artifactPath);
    const cacheKey = `${artifactPath}:${stat.size}:${stat.mtimeMs}`;
    if (SNOW_ARTIFACT_IDENTITY_CACHE.has(cacheKey)) {
      return SNOW_ARTIFACT_IDENTITY_CACHE.get(cacheKey);
    }
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
    const identity = { artifactRequired, sha256, bytes: stat.size };
    SNOW_ARTIFACT_IDENTITY_CACHE.set(cacheKey, identity);
    return identity;
  } catch {
    return { artifactRequired, sha256: null, bytes: 0 };
  }
}

function resolveSnowArtifactPath(artifactRequired) {
  if (artifactRequired === "snow-rf/conus-rf.json") {
    return resolveSnowRfArtifactPath("conus");
  }
  if (artifactRequired === "snow-rf/western-linear-v1c.json") {
    return resolveWesternLinearArtifactPath();
  }
  if (!artifactRequired) {
    return null;
  }
  return path.resolve(__dirname, "../../../tools/noaa-beta", artifactRequired);
}

function resolveSnowRfArtifactPath(kind) {
  if (kind === "conus" && process.env[SNOW_RF_CUSTOM_PATH_ENV]) {
    return process.env[SNOW_RF_CUSTOM_PATH_ENV];
  }
  return path.resolve(__dirname, "../../../tools/noaa-beta/snow-rf/conus-rf.json");
}

function resolveWesternLinearArtifactPath() {
  if (process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH) {
    return process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH;
  }
  return path.resolve(__dirname, "../../../tools/noaa-beta/snow-rf/western-linear-v1c.json");
}

function resolveSnowRfAssetMode(value = process.env[SNOW_RF_ASSET_ENV], { warn = console.warn } = {}) {
  const requested = value === undefined || value === null || value === "" ? "auto" : String(value);
  const normalized = requested.trim().toLowerCase();
  if (normalized === "auto" || normalized === "off" || normalized === "required") {
    return normalized;
  }
  if (!warnedAboutUnknownSnowRfMode) {
    warnedAboutUnknownSnowRfMode = true;
    warn(
      `[noaa-beta] ${SNOW_RF_ASSET_ENV} must be 'auto', 'off', or 'required'; ` +
        `received ${JSON.stringify(value)}. Loading the complete Snow-RF model from JSON.`,
    );
  }
  return "off";
}

function resolveSnowRfLoadConfiguration({
  mode = process.env[SNOW_RF_ASSET_ENV],
  customPath = process.env[SNOW_RF_CUSTOM_PATH_ENV],
  manifestPath = DEFAULT_SNOW_RF_MANIFEST_PATH,
  binaryPath = DEFAULT_SNOW_RF_BINARY_PATH,
  warn = console.warn,
  configurationOrigin = "explicit-resolution",
} = {}) {
  const requestedMode = mode === undefined || mode === null || mode === "" ? "auto" : String(mode);
  const resolvedMode = resolveSnowRfAssetMode(mode, { warn });
  const customPathPresent = customPath !== undefined && customPath !== null && String(customPath) !== "";
  const sourcePath = customPathPresent ? path.resolve(String(customPath)) : DEFAULT_SNOW_RF_SOURCE_PATH;
  return Object.freeze({
    requestedMode,
    resolvedMode,
    sourceKind: customPathPresent ? "custom" : "bundled",
    customPathPresent,
    sourcePath,
    manifestPath: path.resolve(manifestPath),
    binaryPath: path.resolve(binaryPath),
    configurationOrigin,
  });
}

function resolveSnowRfLoadConfigurationForRequest(options, warn) {
  const explicitOverride =
    options.useCache === false ||
    ["mode", "customPath", "manifestPath", "binaryPath"].some((key) => Object.hasOwn(options, key));
  if (!explicitOverride) {
    snowRfStartupConfiguration ??= resolveSnowRfLoadConfiguration({
      mode: process.env[SNOW_RF_ASSET_ENV],
      customPath: process.env[SNOW_RF_CUSTOM_PATH_ENV],
      manifestPath: DEFAULT_SNOW_RF_MANIFEST_PATH,
      binaryPath: DEFAULT_SNOW_RF_BINARY_PATH,
      warn,
      configurationOrigin: "startup-env",
    });
    return snowRfStartupConfiguration;
  }
  return resolveSnowRfLoadConfiguration({
    mode: Object.hasOwn(options, "mode") ? options.mode : process.env[SNOW_RF_ASSET_ENV],
    customPath: Object.hasOwn(options, "customPath") ? options.customPath : process.env[SNOW_RF_CUSTOM_PATH_ENV],
    manifestPath: Object.hasOwn(options, "manifestPath") ? options.manifestPath : DEFAULT_SNOW_RF_MANIFEST_PATH,
    binaryPath: Object.hasOwn(options, "binaryPath") ? options.binaryPath : DEFAULT_SNOW_RF_BINARY_PATH,
    warn,
    configurationOrigin: "explicit-override",
  });
}

function captureSnowRfSource(configuration, { retainBytes = true } = {}) {
  const descriptor = fs.openSync(configuration.sourcePath, "r");
  let before;
  let after;
  let bytes = null;
  let byteLength = 0;
  let sourceSha256;
  const nestedPhases = [];
  let primaryError = null;
  try {
    before = stableSnowRfSourceStat(fs.fstatSync(descriptor, { bigint: true }));
    if (retainBytes) {
      bytes = runSnowRfNestedPhase(nestedPhases, "sourceReadNs", () => fs.readFileSync(descriptor));
      byteLength = bytes.byteLength;
      sourceSha256 = runSnowRfNestedPhase(nestedPhases, "sourceHashNs", () =>
        crypto.createHash("sha256").update(bytes).digest("hex"),
      );
    } else {
      // Identity-only captures stream through one bounded scratch so no
      // whole-file buffer is ever allocated: the sealed B-mode memory-delta
      // ceilings leave no room for a transient copy of the 26 MB source. The
      // chunked read+hash loop is attributed to sourceReadNs; the digest
      // finalization is the sourceHashNs interval.
      const hash = crypto.createHash("sha256");
      const scratch = Buffer.allocUnsafe(SNOW_RF_SOURCE_STREAM_CHUNK_BYTES);
      runSnowRfNestedPhase(nestedPhases, "sourceReadNs", () => {
        for (;;) {
          const read = fs.readSync(descriptor, scratch, 0, scratch.byteLength, null);
          if (read <= 0) {
            break;
          }
          hash.update(scratch.subarray(0, read));
          byteLength += read;
        }
      });
      sourceSha256 = runSnowRfNestedPhase(nestedPhases, "sourceHashNs", () => hash.digest("hex"));
    }
    after = stableSnowRfSourceStat(fs.fstatSync(descriptor, { bigint: true }));
  } catch (error) {
    primaryError = error;
  }
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    primaryError = primaryError
      ? new AggregateError(
          [primaryError, error],
          `Snow-RF source capture and descriptor close failed for ${configuration.sourcePath}.`,
        )
      : error;
  }
  if (primaryError) {
    throw primaryError;
  }
  if (!sameSnowRfFileStat(before, after) || BigInt(byteLength) !== BigInt(before.size)) {
    throw new Error("Snow-RF source descriptor identity changed around its captured read.");
  }
  const identity = Object.freeze({
    artifactRequired: SNOW_RF_SOURCE_IDENTITY.artifactRequired,
    sha256: sourceSha256,
    bytes: byteLength,
  });
  return Object.freeze({
    sourceKind: configuration.sourceKind,
    resolvedPath: configuration.sourcePath,
    bytes: retainBytes ? bytes : null,
    identity,
    descriptorIdentity: Object.freeze(before),
    nestedPhases: Object.freeze(nestedPhases),
  });
}

function captureSnowRfAssetFile(filePath, label) {
  const resolvedPath = path.resolve(filePath);
  let descriptor = null;
  let pathBefore;
  let descriptorBefore;
  let descriptorAfter;
  let pathAfter;
  let bytes;
  let primaryError = null;
  try {
    pathBefore = stableSnowRfFileStat(fs.lstatSync(resolvedPath, { bigint: true }), `${label} path`);
    descriptor = fs.openSync(resolvedPath, "r");
    descriptorBefore = stableSnowRfFileStat(fs.fstatSync(descriptor, { bigint: true }), `${label} descriptor`);
    if (!sameSnowRfFileStat(pathBefore, descriptorBefore)) {
      throw new Error(`Snow-RF ${label} path identity changed before its captured read.`);
    }
    bytes = fs.readFileSync(descriptor);
    descriptorAfter = stableSnowRfFileStat(fs.fstatSync(descriptor, { bigint: true }), `${label} descriptor`);
    pathAfter = stableSnowRfFileStat(fs.lstatSync(resolvedPath, { bigint: true }), `${label} path`);
  } catch (error) {
    primaryError = error;
  }
  if (descriptor !== null) {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      primaryError = primaryError
        ? new AggregateError([primaryError, error], `Snow-RF ${label} capture and descriptor close both failed.`)
        : error;
    }
  }
  if (primaryError) {
    throw primaryError;
  }
  if (
    !sameSnowRfFileStat(pathBefore, descriptorBefore) ||
    !sameSnowRfFileStat(descriptorBefore, descriptorAfter) ||
    !sameSnowRfFileStat(descriptorAfter, pathAfter) ||
    BigInt(bytes.byteLength) !== BigInt(descriptorBefore.size)
  ) {
    throw new Error(`Snow-RF ${label} path or descriptor identity changed around its captured read.`);
  }
  return bytes;
}

function runSnowRfNestedPhase(phases, name, action) {
  const startNs = process.hrtime.bigint();
  let result;
  let primaryError = null;
  try {
    result = action();
  } catch (error) {
    primaryError = error;
  }
  const endNs = process.hrtime.bigint();
  phases.push(snapshotSnowRfTimingPhase(name, startNs, endNs));
  if (primaryError) {
    throw primaryError;
  }
  return result;
}

function stableSnowRfSourceStat(stat) {
  return stableSnowRfFileStat(stat, "source descriptor");
}

function stableSnowRfFileStat(stat, label) {
  if (!stat.isFile()) {
    throw new Error(`Snow-RF ${label} must reference a regular file.`);
  }
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    links: String(stat.nlink),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameSnowRfFileStat(left, right) {
  return (
    left?.device === right?.device &&
    left?.inode === right?.inode &&
    left?.mode === right?.mode &&
    left?.links === right?.links &&
    left?.uid === right?.uid &&
    left?.gid === right?.gid &&
    left?.size === right?.size &&
    left?.mtimeNs === right?.mtimeNs &&
    left?.ctimeNs === right?.ctimeNs
  );
}

function createSnowRfLoadTimeline() {
  const phases = [];
  const memorySnapshots = [captureSnowRfMemorySnapshot("before")];
  const loaderStartNs = process.hrtime.bigint();
  let cursor = loaderStartNs;
  let finished = false;

  function runPhase(name, action, { nestedPhasesFromResult = false } = {}) {
    if (finished) {
      throw new Error("Snow-RF loader timing is already complete.");
    }
    const startNs = cursor;
    let result;
    let primaryError = null;
    try {
      result = action();
    } catch (error) {
      primaryError = error;
    }
    memorySnapshots.push(captureSnowRfMemorySnapshot(`after:${name}`));
    const endNs = process.hrtime.bigint();
    const nestedPhases =
      !primaryError && nestedPhasesFromResult
        ? snapshotSnowRfNestedPhases(result?.nestedPhases, name, startNs, endNs)
        : [];
    phases.push(snapshotSnowRfTimingPhase(name, startNs, endNs, nestedPhases));
    cursor = endNs;
    if (primaryError) {
      throw primaryError;
    }
    return result;
  }

  function appendAssetInstrumentation(instrumentation) {
    if (finished) {
      throw new Error("Snow-RF loader timing is already complete.");
    }
    if (
      !instrumentation ||
      !Array.isArray(instrumentation.phases) ||
      !Array.isArray(instrumentation.memorySnapshots) ||
      instrumentation.phases.length !== instrumentation.memorySnapshots.length
    ) {
      throw new Error("Snow-RF asset instrumentation is incomplete.");
    }
    for (let index = 0; index < instrumentation.phases.length; index += 1) {
      const phase = snapshotExternalSnowRfTimingPhase(instrumentation.phases[index]);
      const expectedName = SNOW_RF_ASSET_MATERIALIZATION_PHASES[index];
      if (phase.name !== expectedName || phase.startNs !== cursor.toString()) {
        throw new Error(`Snow-RF asset instrumentation is noncontiguous at ${phase.name}.`);
      }
      const memory = snapshotExternalSnowRfMemory(instrumentation.memorySnapshots[index]);
      if (memory.label !== `after:${phase.name}`) {
        throw new Error(`Snow-RF asset memory snapshot is misordered at ${phase.name}.`);
      }
      phases.push(phase);
      memorySnapshots.push(memory);
      cursor = BigInt(phase.endNs);
    }
  }

  function finish(expectedPhaseNames) {
    if (finished || phases.length === 0) {
      throw new Error("Snow-RF loader timing cannot be completed in its current state.");
    }
    finished = true;
    const loaderEndNs = cursor;
    validateSnowRfTimingPartition({
      loaderStartNs,
      loaderEndNs,
      phases,
      memorySnapshots,
      expectedPhaseNames,
    });
    return Object.freeze({
      loaderTotalNs: (loaderEndNs - loaderStartNs).toString(),
      loader: Object.freeze({
        startNs: loaderStartNs.toString(),
        endNs: loaderEndNs.toString(),
      }),
      phases: Object.freeze(phases.slice()),
      memorySnapshots: Object.freeze(memorySnapshots.slice()),
    });
  }

  return Object.freeze({
    appendAssetInstrumentation,
    currentBoundaryNs: () => cursor,
    finish,
    phaseNames: () => Object.freeze(phases.map((phase) => phase.name)),
    runPhase,
  });
}

function snapshotSnowRfNestedPhases(value, parentName, parentStartNs, parentEndNs) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0]?.name !== "sourceReadNs" ||
    value[1]?.name !== "sourceHashNs"
  ) {
    throw new Error(`Snow-RF ${parentName} nested timing roster is invalid.`);
  }
  const snapshots = value.map((phase) => {
    const snapshot = snapshotExternalSnowRfNestedInterval(phase);
    const startNs = BigInt(snapshot.startNs);
    const endNs = BigInt(snapshot.endNs);
    if (startNs < parentStartNs || endNs > parentEndNs) {
      throw new Error(`Snow-RF ${parentName}.${snapshot.name} lies outside its parent phase.`);
    }
    return snapshot;
  });
  if (BigInt(snapshots[0].endNs) > BigInt(snapshots[1].startNs)) {
    throw new Error(`Snow-RF ${parentName} nested timing intervals overlap or are out of order.`);
  }
  return Object.freeze(snapshots);
}

function snapshotSnowRfTimingPhase(name, startNs, endNs, nestedPhases = []) {
  if (typeof startNs !== "bigint" || typeof endNs !== "bigint" || startNs < 0n || endNs < startNs) {
    throw new Error(`Snow-RF phase ${name} has invalid monotonic boundaries.`);
  }
  return Object.freeze({
    name,
    startNs: startNs.toString(),
    endNs: endNs.toString(),
    durationNs: (endNs - startNs).toString(),
    nestedPhases: Object.freeze(Array.from(nestedPhases)),
  });
}

function snapshotExternalSnowRfTimingPhase(phase) {
  const name = phase?.name;
  const startNs = canonicalSnowRfNanoseconds(phase?.startNs, `${String(name)}.startNs`);
  const endNs = canonicalSnowRfNanoseconds(phase?.endNs, `${String(name)}.endNs`);
  const durationNs = canonicalSnowRfNanoseconds(phase?.durationNs, `${String(name)}.durationNs`);
  if (endNs < startNs || durationNs !== endNs - startNs) {
    throw new Error(`Snow-RF external phase ${String(name)} has inconsistent arithmetic.`);
  }
  return snapshotSnowRfTimingPhase(String(name), startNs, endNs);
}

function snapshotExternalSnowRfNestedInterval(phase) {
  const name = phase?.name;
  const startNs = canonicalSnowRfNanoseconds(phase?.startNs, `${String(name)}.startNs`);
  const endNs = canonicalSnowRfNanoseconds(phase?.endNs, `${String(name)}.endNs`);
  const durationNs = canonicalSnowRfNanoseconds(phase?.durationNs, `${String(name)}.durationNs`);
  if (endNs < startNs || durationNs !== endNs - startNs) {
    throw new Error(`Snow-RF nested phase ${String(name)} has inconsistent arithmetic.`);
  }
  return Object.freeze({
    name: String(name),
    startNs: startNs.toString(),
    endNs: endNs.toString(),
    durationNs: durationNs.toString(),
  });
}

function canonicalSnowRfNanoseconds(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Snow-RF ${label} must be canonical nonnegative integer nanoseconds.`);
  }
  return BigInt(value);
}

function captureSnowRfMemorySnapshot(label) {
  const memory = process.memoryUsage();
  return snapshotExternalSnowRfMemory({
    label,
    captureNs: process.hrtime.bigint().toString(),
    ...memory,
  });
}

function snapshotExternalSnowRfMemory(memory) {
  const snapshot = {
    label: String(memory?.label),
    captureNs: String(memory?.captureNs),
    rss: memory?.rss,
    heapTotal: memory?.heapTotal,
    heapUsed: memory?.heapUsed,
    external: memory?.external,
    arrayBuffers: memory?.arrayBuffers,
  };
  for (const key of ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"]) {
    if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] < 0) {
      throw new Error(`Snow-RF memory snapshot ${snapshot.label}.${key} is invalid.`);
    }
  }
  canonicalSnowRfNanoseconds(snapshot.captureNs, `${snapshot.label}.captureNs`);
  return Object.freeze(snapshot);
}

function validateSnowRfTimingPartition({ loaderStartNs, loaderEndNs, phases, memorySnapshots, expectedPhaseNames }) {
  if (memorySnapshots.length !== phases.length + 1 || memorySnapshots[0].label !== "before") {
    throw new Error("Snow-RF loader memory snapshot roster is incomplete.");
  }
  if (canonicalSnowRfNanoseconds(memorySnapshots[0].captureNs, "before.captureNs") > loaderStartNs) {
    throw new Error("Snow-RF before memory snapshot lies after the loader start.");
  }
  if (
    !Array.isArray(expectedPhaseNames) ||
    expectedPhaseNames.length !== phases.length ||
    expectedPhaseNames.some((name, index) => phases[index]?.name !== name)
  ) {
    throw new Error("Snow-RF loader phase roster does not match its effective mode.");
  }
  let cursor = loaderStartNs;
  let durationTotal = 0n;
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    const startNs = canonicalSnowRfNanoseconds(phase.startNs, `${phase.name}.startNs`);
    const endNs = canonicalSnowRfNanoseconds(phase.endNs, `${phase.name}.endNs`);
    const durationNs = canonicalSnowRfNanoseconds(phase.durationNs, `${phase.name}.durationNs`);
    if (
      startNs !== cursor ||
      endNs < startNs ||
      durationNs !== endNs - startNs ||
      !Array.isArray(phase.nestedPhases) ||
      memorySnapshots[index + 1].label !== `after:${phase.name}`
    ) {
      throw new Error(`Snow-RF loader phase partition is invalid at ${phase.name}.`);
    }
    const expectedNestedNames = index < SNOW_RF_COMMON_LOAD_PHASES.length ? ["sourceReadNs", "sourceHashNs"] : [];
    if (
      phase.nestedPhases.length !== expectedNestedNames.length ||
      expectedNestedNames.some((name, nestedIndex) => phase.nestedPhases[nestedIndex]?.name !== name)
    ) {
      throw new Error(`Snow-RF loader nested phase roster is invalid at ${phase.name}.`);
    }
    const memoryCaptureNs = canonicalSnowRfNanoseconds(
      memorySnapshots[index + 1].captureNs,
      `${memorySnapshots[index + 1].label}.captureNs`,
    );
    if (memoryCaptureNs < startNs || memoryCaptureNs > endNs) {
      throw new Error(`Snow-RF memory snapshot lies outside phase ${phase.name}.`);
    }
    let nestedCursor = startNs;
    for (const nested of phase.nestedPhases) {
      const nestedStartNs = canonicalSnowRfNanoseconds(nested.startNs, `${phase.name}.${nested.name}.startNs`);
      const nestedEndNs = canonicalSnowRfNanoseconds(nested.endNs, `${phase.name}.${nested.name}.endNs`);
      const nestedDurationNs = canonicalSnowRfNanoseconds(nested.durationNs, `${phase.name}.${nested.name}.durationNs`);
      if (
        nestedStartNs < startNs ||
        nestedStartNs < nestedCursor ||
        nestedEndNs > endNs ||
        nestedEndNs < nestedStartNs ||
        nestedDurationNs !== nestedEndNs - nestedStartNs
      ) {
        throw new Error(`Snow-RF nested phase partition is invalid at ${phase.name}.${nested.name}.`);
      }
      nestedCursor = nestedEndNs;
    }
    durationTotal += durationNs;
    cursor = endNs;
  }
  if (cursor !== loaderEndNs || durationTotal !== loaderEndNs - loaderStartNs) {
    throw new Error("Snow-RF loader timing total is inconsistent.");
  }
}

function snapshotSnowRfFallbackTypedPrefix(timeline) {
  const phaseNames = timeline.phaseNames();
  const prefix = phaseNames.slice(SNOW_RF_COMMON_LOAD_PHASES.length);
  if (
    prefix.length === 0 ||
    prefix.length > SNOW_RF_TYPED_ATTEMPT_PHASES.length ||
    prefix.some((name, index) => name !== SNOW_RF_TYPED_ATTEMPT_PHASES[index])
  ) {
    throw new Error("Snow-RF auto fallback must retain one exact nonempty typed-attempt phase prefix.");
  }
  return Object.freeze(prefix);
}

function emitDeferredSnowRfWarnings(warn, warnings) {
  const errors = [];
  for (const message of warnings) {
    try {
      warn(message);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Multiple deferred Snow-RF warning callbacks failed.");
  }
}

function loadSnowRfState(kind, options = {}) {
  if (kind !== "conus") {
    return null;
  }
  const warn = Object.hasOwn(options, "warn") ? options.warn : console.warn;
  if (typeof warn !== "function") {
    throw new Error("Snow-RF loader warning sink must be a function.");
  }
  const deferredWarnings = [];
  const configuration = resolveSnowRfLoadConfigurationForRequest(options, (message) => {
    deferredWarnings.push(message);
  });
  if (configuration.customPathPresent && configuration.resolvedMode === "required") {
    const error = new Error(
      `${SNOW_RF_ASSET_ENV}=required conflicts with the present ${SNOW_RF_CUSTOM_PATH_ENV} override.`,
    );
    error.code = "ERR_NOAA_SNOW_RF_REQUIRED";
    error.reasonCode = "custom-path-conflict";
    throw error;
  }
  const cacheKey = snowRfLoadConfigurationCacheKey(configuration);
  const useCache = options.useCache !== false;
  if (useCache && SNOW_RF_LOAD_STATE_CACHE.has(cacheKey)) {
    const cached = SNOW_RF_LOAD_STATE_CACHE.get(cacheKey);
    emitDeferredSnowRfWarnings(warn, deferredWarnings);
    return cached;
  }
  if (useCache && SNOW_RF_LOAD_FAILURE_CACHE.has(cacheKey)) {
    emitDeferredSnowRfWarnings(warn, deferredWarnings);
    return null;
  }
  const activeLoad = snowRfLoadsInFlight.get(cacheKey);
  if (activeLoad) {
    if (!activeLoad.completed) {
      throw new Error("Snow-RF loader was re-entered before atomic state completion.");
    }
    emitDeferredSnowRfWarnings(warn, deferredWarnings);
    return activeLoad.result;
  }
  const loadFlight = { completed: false, result: undefined };
  snowRfLoadsInFlight.set(cacheKey, loadFlight);
  const completeLoad = (result) => {
    loadFlight.result = result;
    loadFlight.completed = true;
    emitDeferredSnowRfWarnings(warn, deferredWarnings);
    return result;
  };

  const timeline = createSnowRfLoadTimeline();
  // When the typed asset will be attempted, the model-source capture also
  // streams: its bytes are only ever needed by the JSON path, and the auto
  // fallback re-reads them under an identity gate instead of holding a 26 MB
  // buffer across the typed attempt.
  const shouldAttemptAsset =
    configuration.sourceKind === "bundled" &&
    (configuration.resolvedMode === "auto" || configuration.resolvedMode === "required");
  try {
    let identityCapture;
    let modelCapture;
    try {
      identityCapture = timeline.runPhase(
        SNOW_RF_COMMON_LOAD_PHASES[0],
        () => captureSnowRfSource(configuration, { retainBytes: false }),
        { nestedPhasesFromResult: true },
      );
      modelCapture = timeline.runPhase(
        SNOW_RF_COMMON_LOAD_PHASES[1],
        () => captureSnowRfSource(configuration, { retainBytes: !shouldAttemptAsset }),
        { nestedPhasesFromResult: true },
      );
    } catch (error) {
      if (configuration.resolvedMode === "required") {
        throw wrapRequiredSnowRfFailure(error, "source-capture-failed");
      }
      return completeLoad(
        handleSnowRfJsonLoadFailure({
          configuration,
          cacheKey,
          error,
          useCache,
          warn: (message) => deferredWarnings.push(message),
        }),
      );
    }
    if (!sameSnowRfSourceIdentity(identityCapture.identity, modelCapture.identity)) {
      const error = new Error("Snow-RF identity-only and model-source captures do not match.");
      if (configuration.resolvedMode === "required") {
        throw wrapRequiredSnowRfFailure(error, "source-capture-mismatch");
      }
      return completeLoad(
        handleSnowRfJsonLoadFailure({
          configuration,
          cacheKey,
          error,
          useCache,
          warn: (message) => deferredWarnings.push(message),
        }),
      );
    }

    let model;
    let metrics;
    let compilerClosureSha256 = null;
    let typedAssetIdentity = null;
    let effectiveMode = "json";
    let fallbackUsed = false;
    let fallbackReasonCode = null;
    let fallbackTypedPhaseNames = null;
    if (shouldAttemptAsset) {
      let assetInstrumentation = null;
      try {
        const manifestBytes = timeline.runPhase(SNOW_RF_TYPED_READ_PHASES[0], () => {
          if (!sameSnowRfSourceIdentity(modelCapture.identity, SNOW_RF_SOURCE_IDENTITY)) {
            throw new Error("Bundled Snow-RF source identity does not match the asset manifest source.");
          }
          return captureSnowRfAssetFile(configuration.manifestPath, "asset manifest");
        });
        let manifestSha256 = null;
        const manifest = timeline.runPhase(SNOW_RF_TYPED_READ_PHASES[1], () => {
          manifestSha256 = crypto.createHash("sha256").update(manifestBytes).digest("hex");
          try {
            return JSON.parse(manifestBytes.toString("utf8"));
          } catch (error) {
            throw new Error(`Snow-RF asset manifest is not valid JSON: ${error.message}`, {
              cause: error,
            });
          }
        });
        const binaryBytes = timeline.runPhase(SNOW_RF_TYPED_READ_PHASES[2], () => {
          const capturedBinary = captureSnowRfAssetFile(configuration.binaryPath, "asset binary");
          typedAssetIdentity = createSnowRfTypedAssetIdentity({
            manifest,
            manifestBytes,
            manifestSha256,
            binaryBytes: capturedBinary,
          });
          return capturedBinary;
        });
        model = materializeSnowRfAsset({
          manifest,
          binaryBytes,
          phaseStartNs: timeline.currentBoundaryNs(),
          onInstrumentation(instrumentation) {
            assetInstrumentation = instrumentation;
            timeline.appendAssetInstrumentation(instrumentation);
          },
        });
        if (!assetInstrumentation?.completed || !assetInstrumentation.modelMetrics) {
          throw new Error("Snow-RF typed asset completed without validated instrumentation.");
        }
        metrics = assetInstrumentation.modelMetrics;
        compilerClosureSha256 = manifest.compiler.closure.sha256;
        effectiveMode = "typed-asset";
      } catch (error) {
        if (configuration.resolvedMode === "required") {
          throw wrapRequiredSnowRfFailure(error, classifySnowRfAssetFailure(error));
        }
        fallbackUsed = true;
        fallbackReasonCode = classifySnowRfAssetFailure(error);
        fallbackTypedPhaseNames = snapshotSnowRfFallbackTypedPrefix(timeline);
        if (!warnedSnowRfAutoFallbackPaths.has(configuration.sourcePath)) {
          warnedSnowRfAutoFallbackPaths.add(configuration.sourcePath);
          deferredWarnings.push(
            `[noaa-beta] Snow-RF typed-asset validation failed; loading the complete model from JSON. ${error.message}`,
          );
        }
      }
    }

    if (!model) {
      let raw = null;
      let compilerClosure = null;
      try {
        raw = timeline.runPhase(SNOW_RF_JSON_LOAD_PHASES[0], () => {
          let jsonBytes = modelCapture.bytes;
          if (jsonBytes === null) {
            // The typed-asset attempt streamed both source captures, so the
            // auto fallback re-reads the source and refuses to model bytes
            // whose identity no longer matches the captured one.
            const fallbackCapture = captureSnowRfSource(configuration, { retainBytes: true });
            if (!sameSnowRfSourceIdentity(fallbackCapture.identity, modelCapture.identity)) {
              throw new Error("Snow-RF fallback source no longer matches its captured identity.");
            }
            jsonBytes = fallbackCapture.bytes;
          }
          return JSON.parse(jsonBytes.toString("utf8"));
        });
        model = timeline.runPhase(SNOW_RF_JSON_LOAD_PHASES[1], () => {
          const compiled = normalizeSnowRfModel(raw);
          if (!compiled) {
            throw new Error("Snow-RF JSON failed strict model validation.");
          }
          compilerClosure = buildSnowRfCompilerClosure();
          return freezeSnowRfModelDescriptors(compiled);
        });
        raw = null;
        metrics = timeline.runPhase(SNOW_RF_JSON_LOAD_PHASES[2], () => {
          const inspected = inspectCompiledSnowRfModel(model);
          if (!inspected) {
            throw new Error("Snow-RF loaded model failed final graph validation.");
          }
          return inspected;
        });
        compilerClosureSha256 = compilerClosure.sha256;
      } catch (error) {
        return completeLoad(
          handleSnowRfJsonLoadFailure({
            configuration,
            cacheKey,
            error,
            useCache,
            warn: (message) => deferredWarnings.push(message),
          }),
        );
      }
    }

    if (!metrics) {
      const error = new Error("Snow-RF loaded model failed final graph validation.");
      if (configuration.resolvedMode === "required") {
        throw wrapRequiredSnowRfFailure(error, "graph-validation-failed");
      }
      return completeLoad(
        handleSnowRfJsonLoadFailure({
          configuration,
          cacheKey,
          error,
          useCache,
          warn: (message) => deferredWarnings.push(message),
        }),
      );
    }
    const sourceIdentity = identityCapture.identity;
    identityCapture = null;
    modelCapture = null;
    const expectedPhaseNames =
      effectiveMode === "typed-asset"
        ? [...SNOW_RF_COMMON_LOAD_PHASES, ...SNOW_RF_TYPED_ATTEMPT_PHASES]
        : fallbackUsed
          ? [...SNOW_RF_COMMON_LOAD_PHASES, ...fallbackTypedPhaseNames, ...SNOW_RF_JSON_LOAD_PHASES]
          : [...SNOW_RF_COMMON_LOAD_PHASES, ...SNOW_RF_JSON_LOAD_PHASES];
    const timing = timeline.finish(expectedPhaseNames);
    const treatmentState = createSnowRfLoadedState({
      configuration: {
        requestedMode: configuration.requestedMode,
        resolvedMode: configuration.resolvedMode,
        sourceKind: configuration.sourceKind,
        customPathPresent: configuration.customPathPresent,
        configurationOrigin: configuration.configurationOrigin,
      },
      model,
      identity: {
        source: sourceIdentity,
        compilerId: SNOW_RF_COMPILER_ID,
        compilerClosureSha256,
        asset: effectiveMode === "typed-asset" ? typedAssetIdentity : null,
        ...metrics,
      },
      status: {
        effectiveMode,
        fallbackUsed,
        fallbackReasonCode,
      },
      timing,
    });
    const published = Object.freeze({
      model,
      sourceIdentity,
      treatmentState,
    });
    if (useCache) {
      SNOW_RF_LOAD_STATE_CACHE.set(cacheKey, published);
    }
    return completeLoad(published);
  } finally {
    if (snowRfLoadsInFlight.get(cacheKey) === loadFlight) {
      snowRfLoadsInFlight.delete(cacheKey);
    }
  }
}

function createSnowRfTypedAssetIdentity({ manifest, manifestBytes, manifestSha256, binaryBytes }) {
  if (
    !Buffer.isBuffer(manifestBytes) ||
    !/^[0-9a-f]{64}$/.test(manifestSha256) ||
    !Buffer.isBuffer(binaryBytes) ||
    binaryBytes.byteLength !== SNOW_RF_ASSET_ORACLES.binaryBytes ||
    manifest?.binary?.sha256 !== SNOW_RF_ASSET_ORACLES.binarySha256
  ) {
    throw new Error("Snow-RF typed asset cannot publish an incomplete raw-file identity.");
  }
  return Object.freeze({
    manifest: Object.freeze({
      bytes: manifestBytes.byteLength,
      sha256: manifestSha256,
      schemaVersion: manifest.schemaVersion,
      format: manifest.format,
      endian: manifest.endian,
      compilerId: manifest.compiler.id,
      closureSha256: manifest.compiler.closure.sha256,
    }),
    binary: Object.freeze({
      bytes: binaryBytes.byteLength,
      sha256: manifest.binary.sha256,
    }),
  });
}

function loadSnowRfModel(kind, options) {
  return loadSnowRfState(kind, options)?.model || null;
}

function wrapRequiredSnowRfFailure(error, reasonCode) {
  const strictError = new Error(`Strict Snow-RF typed-asset loading failed: ${String(error?.message || error)}`, {
    cause: error,
  });
  strictError.code = "ERR_NOAA_SNOW_RF_REQUIRED";
  strictError.reasonCode = reasonCode;
  return strictError;
}

function freezeSnowRfModelDescriptors(model) {
  for (const tree of model.trees) {
    Object.freeze(tree);
  }
  Object.freeze(model.featureKeys);
  Object.freeze(model.trees);
  return Object.freeze(model);
}

function handleSnowRfJsonLoadFailure({ configuration, cacheKey, error, useCache, warn }) {
  if (useCache) {
    SNOW_RF_LOAD_FAILURE_CACHE.add(cacheKey);
  }
  if (!warnedSnowRfLoadFailures.has(configuration.sourcePath)) {
    warnedSnowRfLoadFailures.add(configuration.sourcePath);
    const reason = error ? `: ${String(error?.message || error)}` : " (failed validation)";
    warn(`[noaa-beta] snowRfConus model unavailable at ${configuration.sourcePath}${reason}`);
  }
  return null;
}

function snowRfLoadConfigurationCacheKey(configuration) {
  return JSON.stringify([
    configuration.requestedMode,
    configuration.resolvedMode,
    configuration.sourceKind,
    configuration.customPathPresent,
    configuration.sourcePath,
    configuration.manifestPath,
    configuration.binaryPath,
    configuration.configurationOrigin,
  ]);
}

function classifySnowRfAssetFailure(error) {
  if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EISDIR") {
    return "asset-read-failed";
  }
  if (/manifest is not valid JSON/i.test(String(error?.message || ""))) {
    return "manifest-json-invalid";
  }
  if (/little-endian host/i.test(String(error?.message || ""))) {
    return "unsupported-host-endian";
  }
  return "asset-validation-failed";
}

function sameSnowRfSourceIdentity(left, right) {
  return (
    left?.artifactRequired === right?.artifactRequired && left?.sha256 === right?.sha256 && left?.bytes === right?.bytes
  );
}

function resetSnowRfLoaderForTest() {
  SNOW_RF_LOAD_STATE_CACHE.clear();
  SNOW_RF_LOAD_FAILURE_CACHE.clear();
  snowRfLoadsInFlight.clear();
  warnedSnowRfLoadFailures.clear();
  warnedSnowRfAutoFallbackPaths.clear();
  warnedAboutUnknownSnowRfMode = false;
  snowRfStartupConfiguration = null;
}

function loadWesternLinearSlrModel() {
  const artifactPath = resolveWesternLinearArtifactPath();
  if (SNOW_RF_MODEL_PATH_CACHE.has(artifactPath)) {
    return SNOW_RF_MODEL_PATH_CACHE.get(artifactPath);
  }
  const cacheKey = snowModelCacheKey(artifactPath);
  let model;
  if (SNOW_RF_MODEL_CACHE.has(cacheKey)) {
    model = SNOW_RF_MODEL_CACHE.get(cacheKey);
  } else {
    let loadError = null;
    try {
      model = normalizeWesternLinearSlrModel(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
    } catch (error) {
      loadError = error;
      model = null;
    }
    if (!model) {
      // Runs once per artifact path; a null model silently drops snowWesternLinear grids downstream.
      const reason = loadError ? `: ${String(loadError?.message || loadError)}` : " (failed validation)";
      console.warn(`[noaa-beta] snowWesternLinear model unavailable at ${artifactPath}${reason}`);
    }
    SNOW_RF_MODEL_CACHE.set(cacheKey, model);
  }
  SNOW_RF_MODEL_PATH_CACHE.set(artifactPath, model);
  return model;
}

function snowModelCacheKey(artifactPath) {
  try {
    const stat = fs.statSync(artifactPath);
    return `${artifactPath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${artifactPath}:missing`;
  }
}

function normalizeWesternLinearSlrModel(raw) {
  const featureKeys = Array.isArray(raw?.featureKeys) ? raw.featureKeys.map(String) : [];
  if (featureKeys.length !== WESTERN_LINEAR_FEATURE_KEYS.length) {
    return null;
  }
  for (let index = 0; index < WESTERN_LINEAR_FEATURE_KEYS.length; index += 1) {
    if (featureKeys[index] !== WESTERN_LINEAR_FEATURE_KEYS[index]) {
      return null;
    }
  }
  const coefficients = numericArray(raw?.coefficients);
  const intercept = Number(raw?.intercept);
  if (coefficients.length !== WESTERN_LINEAR_FEATURE_KEYS.length || !Number.isFinite(intercept)) {
    return null;
  }
  return { featureKeys, coefficients: Float64Array.from(coefficients), intercept };
}

function numericArray(values) {
  const source = Array.isArray(values) || ArrayBuffer.isView(values) ? Array.from(values) : [];
  return source
    .map((value) => (Array.isArray(value) ? Number(value.flat(Infinity)[0]) : Number(value)))
    .filter((value) => Number.isFinite(value));
}

module.exports = {
  CURRENT_UI_SELECTORS,
  FRAM_FLAT_ICE_KEY,
  FRAM_RADIAL_ICE_KEY,
  FREEZING_RAIN_LIQUID_TOTAL_KEY,
  PLETCHER_RF_FEATURE_KEYS,
  POINT_SOUNDING_DIRECT_SELECTORS,
  POINT_SOUNDING_PROFILE_LEVELS,
  POINT_SOUNDING_PROFILE_VARIABLES,
  PROFILE_SURFACE_SELECTORS,
  RUN_MAX_ACCUMULATION_SOURCES,
  SELECTION_DECODE_DEPENDENCY_ROLES,
  SELECTION_DECODE_DEPENDENCY_SCHEMA_VERSION,
  SELECTION_SUPPORT_PRODUCT,
  SNOW_ARTIFACT_IDENTITY_CACHE,
  SNOW_MASK_TYPE_KEYS,
  SNOW_RF_ASSET_ENV,
  SNOW_RF_CUSTOM_PATH_ENV,
  SNOW_RF_LOAD_FAILURE_CACHE,
  SNOW_RF_LOAD_STATE_CACHE,
  SNOW_RF_MODEL_CACHE,
  SNOW_RF_MODEL_PATH_CACHE,
  SNOW_SOURCE_SELECTORS,
  WESTERN_LINEAR_FEATURE_KEYS,
  currentPhaseMaskRecords,
  captureSnowRfSource,
  classifySnowRfAssetFailure,
  filterCatalogForRenderMode,
  findAverageRecordForWindow,
  findExactAverageSnowMaskRecords,
  findSurfaceAccumulatedFreezingRainRecord,
  hasCompletePhaseMaskRecordSet,
  hasPhaseMaskedPrecipAccumulationCandidate,
  hasSnowfallLiquidCandidateRecords,
  hasSnowfallProfileRecords,
  includeCatalogSourceSelectorRecords,
  includeDerivedParameterRecords,
  includeFreezingRainDerivedAccumulationRecords,
  includeSnowfallDerivedRecords,
  isCatalogEntryApplicableToModel,
  isFreezingRainDerivedAccumulationEntry,
  isSnowArtifactReady,
  loadSnowRfModel,
  loadSnowRfState,
  loadWesternLinearSlrModel,
  mergeSelectedNoaaRecords,
  normalizeRfTree,
  normalizeRenderSelection,
  normalizeSelectionModelKey,
  normalizeSnowRfModel,
  normalizeWesternLinearSlrModel,
  numericArray,
  profileSelector,
  resolveProfileRecord,
  resolveSnowArtifactPath,
  resolveSnowRfAssetMode,
  resolveSnowRfArtifactPath,
  resolveSnowRfLoadConfiguration,
  resolveWesternLinearArtifactPath,
  selectNamAwphysRecords,
  selectNoaaNamParameterRecords,
  selectionCatalogPressureLevelMb,
  selectionDecodeDependencyIdentity,
  selectionAllows,
  selectPointSoundingRecords,
  selectSnowfallDerivedParameterRecords,
  snowArtifactCacheIdentity,
  snowRfLoadConfigurationCacheKey,
  snowModelCacheKey,
  _resetSnowRfLoaderForTest: resetSnowRfLoaderForTest,
};
