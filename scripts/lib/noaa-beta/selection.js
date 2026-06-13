"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { NOAA_NAM_PARAMETER_CATALOG, SNOW_PROFILE_LEVELS, SUPPORT_SELECTORS } = require("../noaa-nam-parameter-catalog");
const { MPS_TO_MPH } = require("./util");
const { PROFILE_SURFACE_DECODE_KEYS, profileDecodeKey, standardProfileDecodeKey } = require("./profile-access");
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

const FREEZING_RAIN_LIQUID_TOTAL_KEY = "freezingRainLiquidTotal";

const FRAM_FLAT_ICE_KEY = "framFlatIce";

const FRAM_RADIAL_ICE_KEY = "framRadialIce";

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
    selector: Object.freeze({ param: "MXUPHL", level: "5000-2000 m above ground" }),
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
  updraftHelicity2to5km: Object.freeze({ param: "MXUPHL", level: "5000-2000 m above ground" }),
  maxHailSize: Object.freeze({ param: "HAIL", levelPattern: /entire atmosphere/i }),
});

const PLETCHER_RF_FEATURE_KEYS = Object.freeze([
  "SPD03K",
  "SPD06K",
  "SPD09K",
  "SPD12K",
  "SPD15K",
  "SPD18K",
  "SPD21K",
  "SPD24K",
  "T03K",
  "T06K",
  "T09K",
  "T12K",
  "T15K",
  "T18K",
  "T21K",
  "T24K",
  "R03K",
  "R06K",
  "R09K",
  "R12K",
  "R15K",
  "R18K",
  "R21K",
  "R24K",
  "elev",
  "lat",
  "lon",
]);

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

function filterCatalogForRenderMode(catalog, renderMode) {
  const list = Array.isArray(catalog) ? catalog : NOAA_NAM_PARAMETER_CATALOG;
  if (renderMode === "base") {
    return list.filter((entry) => entry.kind !== "snowfallDerived");
  }
  if (renderMode === "runmax-prefix") {
    return list.filter((entry) => Boolean(RUN_MAX_ACCUMULATION_SOURCES[entry.key]));
  }
  if (renderMode === "snow" || renderMode === "snow-delta" || renderMode === "snow-prefix") {
    return list.filter((entry) => entry.kind === "snowfallDerived");
  }
  return list;
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

function selectNoaaNamParameterRecords(records, catalogOrOptions = NOAA_NAM_PARAMETER_CATALOG) {
  const options = Array.isArray(catalogOrOptions) ? { catalog: catalogOrOptions } : catalogOrOptions || {};
  const catalog = Array.isArray(options.catalog) ? options.catalog : NOAA_NAM_PARAMETER_CATALOG;
  const modelKey = normalizeSelectionModelKey(options.modelKey);
  const targetHour = Number.isFinite(Number(options.targetHour)) ? Number(options.targetHour) : null;
  const selected = {};
  const missingRequired = [];
  const availableParameters = [];
  const missingOptionalParameters = [];
  const includeRecord = (key, selector, target = selected) => {
    if (key && target?.[key]) {
      return target[key];
    }
    if (key && target !== selected && selected?.[key]) {
      target[key] = selected[key];
      return selected[key];
    }
    const record = findRecord(records, selector);
    if (record) {
      target[key] = record;
    }
    return record;
  };

  for (const [key, selector] of Object.entries(SUPPORT_SELECTORS)) {
    includeRecord(key, selector);
  }

  for (const entry of catalog) {
    const required = Boolean(entry.required);
    if (!isCatalogEntryApplicableToModel(entry, modelKey)) {
      if (required) {
        missingRequired.push(entry.key);
      } else {
        missingOptionalParameters.push(entry.key);
      }
      continue;
    }
    const staged = { ...selected };
    const includeStagedRecord = (key, selector) => includeRecord(key, selector, staged);
    let available;
    if (entry.kind === "wind") {
      const uRecord = includeStagedRecord(entry.uKey, entry.uSelector);
      const vRecord = includeStagedRecord(entry.vKey, entry.vSelector);
      available = Boolean(uRecord && vRecord);
    } else if (entry.kind === "reflectivityPrecipType") {
      const reflectivityRecord = includeStagedRecord(entry.reflectivityKey, entry.reflectivitySelector);
      const precipTypeEntries = Object.entries(entry.precipTypeKeys || {});
      const precipTypeRecords = precipTypeEntries.map(([typeKey, recordKey]) =>
        includeStagedRecord(recordKey, entry.precipTypeSelectors?.[typeKey]),
      );
      available = Boolean(reflectivityRecord && precipTypeRecords.length > 0 && precipTypeRecords.every(Boolean));
    } else if (entry.kind === "precipRateType") {
      const rateRecord = includeStagedRecord(entry.rateKey, entry.rateSelector);
      const precipTypeEntries = Object.entries(entry.precipTypeKeys || {});
      const precipTypeRecords = precipTypeEntries.map(([typeKey, recordKey]) =>
        includeStagedRecord(recordKey, entry.precipTypeSelectors?.[typeKey]),
      );
      available = Boolean(rateRecord && precipTypeRecords.length > 0 && precipTypeRecords.every(Boolean));
    } else if (entry.kind === "precipAccumulation") {
      available = records.some((record) => isSurfacePrecipRecord(record));
    } else if (isFreezingRainDerivedAccumulationEntry(entry)) {
      available = includeFreezingRainDerivedAccumulationRecords(entry, records, includeStagedRecord, staged, {
        targetHour,
      });
    } else if (entry.kind === "derivedScalar" || entry.kind === "derivedAccumulation") {
      available = includeDerivedParameterRecords(entry, records, includeStagedRecord, staged, { targetHour });
    } else if (entry.kind === "snowfallDerived") {
      available = includeSnowfallDerivedRecords(entry, records, includeStagedRecord, staged, { targetHour });
    } else if (entry.kind === "snowfallDirect") {
      const record = includeStagedRecord(entry.inputKey, entry.selector);
      available = Boolean(record);
    } else {
      const record = includeStagedRecord(entry.inputKey, entry.selector);
      available = Boolean(record && includeCatalogSourceSelectorRecords(entry, includeStagedRecord, staged));
    }
    if (available) {
      Object.assign(selected, staged);
      availableParameters.push(entry.key);
    } else if (required) {
      missingRequired.push(entry.key);
    } else {
      missingOptionalParameters.push(entry.key);
    }
  }

  return {
    records: selected,
    missingRequired,
    availableParameters,
    missingOptionalParameters,
    catalog,
  };
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
    const record = includeRecord(key, selector);
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

function includeDerivedParameterRecords(entry, records, includeRecord, selected, options = {}) {
  const minForecastHour = Number(entry?.minForecastHour);
  if (Number.isFinite(options.targetHour) && Number.isFinite(minForecastHour) && options.targetHour < minForecastHour) {
    return false;
  }

  let directAvailable = false;
  if (entry?.directSelector && entry?.directInputKey) {
    directAvailable = Boolean(includeRecord(entry.directInputKey, entry.directSelector));
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
    const record = includeRecord(key, selector);
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
    const surfaceHeight = includeRecord(PROFILE_SURFACE_DECODE_KEYS.HGT, PROFILE_SURFACE_SELECTORS.HGT);
    if (entry?.surfaceHeightRequired && !surfaceHeight) {
      profileAvailable = false;
    } else {
      profileAvailable = hasSnowfallProfileRecords(entry, variables, records, includeRecord, selected);
    }
  }

  return directAvailable || (requiredSourcesAvailable && anyGroupsAvailable && profileAvailable);
}

function includeSnowfallDerivedRecords(entry, records, includeRecord, selected, options = {}) {
  if (Number.isFinite(options.targetHour) && options.targetHour <= 0) {
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
  const surfaceHeight = includeRecord(PROFILE_SURFACE_DECODE_KEYS.HGT, PROFILE_SURFACE_SELECTORS.HGT);
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
  if (Number.isFinite(options.targetHour) && options.targetHour <= 0) {
    return false;
  }
  const directRecord = findSurfaceAccumulatedFreezingRainRecord(records, options.targetHour);
  if (directRecord && entry.key === FREEZING_RAIN_LIQUID_TOTAL_KEY && entry?.directInputKey) {
    selected[entry.directInputKey] = directRecord;
  }
  const liquidSourceAvailable = Boolean(directRecord) || hasPhaseMaskedPrecipAccumulationCandidate(records);
  if (!liquidSourceAvailable) {
    return false;
  }
  if (entry.key === FREEZING_RAIN_LIQUID_TOTAL_KEY) {
    return true;
  }
  const temperature = includeRecord("temperature2m", PROFILE_SURFACE_SELECTORS.TMP);
  const dewpoint = includeRecord("dewpoint2m", PROFILE_SURFACE_SELECTORS.DPT);
  const humidity = includeRecord("humidity2m", PROFILE_SURFACE_SELECTORS.RH);
  const windU = includeRecord("windU10m", PROFILE_SURFACE_SELECTORS.UGRD);
  const windV = includeRecord("windV10m", PROFILE_SURFACE_SELECTORS.VGRD);
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
    return existingRecord;
  }
  const selector = profileSelector(variable, level);
  if (lazyProfile) {
    return findRecord(records, selector);
  }
  return includeRecord(profileDecodeKey(variable, level), selector);
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

function snowArtifactCacheIdentity(artifactRequired) {
  if (!artifactRequired) {
    return null;
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
  if (kind === "conus" && process.env.MODELVIEW_SNOW_RF_CONUS_PATH) {
    return process.env.MODELVIEW_SNOW_RF_CONUS_PATH;
  }
  return path.resolve(__dirname, "../../../tools/noaa-beta/snow-rf/conus-rf.json");
}

function resolveWesternLinearArtifactPath() {
  if (process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH) {
    return process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH;
  }
  return path.resolve(__dirname, "../../../tools/noaa-beta/snow-rf/western-linear-v1c.json");
}

function loadSnowRfModel(kind) {
  const artifactPath = resolveSnowRfArtifactPath(kind);
  // Model artifacts are immutable for the lifetime of a render process (the
  // renderer signature is also computed once per build), so the per-call
  // statSync freshness key only needs to run on the first load per path.
  if (SNOW_RF_MODEL_PATH_CACHE.has(artifactPath)) {
    return SNOW_RF_MODEL_PATH_CACHE.get(artifactPath);
  }
  const cacheKey = snowModelCacheKey(artifactPath);
  let model;
  if (SNOW_RF_MODEL_CACHE.has(cacheKey)) {
    model = SNOW_RF_MODEL_CACHE.get(cacheKey);
  } else {
    try {
      model = normalizeSnowRfModel(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
    } catch {
      model = null;
    }
    SNOW_RF_MODEL_CACHE.set(cacheKey, model);
  }
  SNOW_RF_MODEL_PATH_CACHE.set(artifactPath, model);
  return model;
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
    try {
      model = normalizeWesternLinearSlrModel(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
    } catch {
      model = null;
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

function normalizeSnowRfModel(raw) {
  const featureKeys = Array.isArray(raw?.featureKeys) ? raw.featureKeys.map(String) : [];
  if (featureKeys.length !== PLETCHER_RF_FEATURE_KEYS.length) {
    return null;
  }
  for (let index = 0; index < PLETCHER_RF_FEATURE_KEYS.length; index += 1) {
    if (featureKeys[index] !== PLETCHER_RF_FEATURE_KEYS[index]) {
      return null;
    }
  }
  const trees = Array.isArray(raw?.trees) ? raw.trees.map(normalizeRfTree).filter(Boolean) : [];
  return trees.length > 0 ? { featureKeys, trees } : null;
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

function normalizeRfTree(tree) {
  const childrenLeft = numericArray(tree?.childrenLeft || tree?.children_left);
  const childrenRight = numericArray(tree?.childrenRight || tree?.children_right);
  const feature = numericArray(tree?.feature);
  const threshold = numericArray(tree?.threshold);
  const value = numericArray(tree?.value);
  const length = childrenLeft.length;
  if (
    length === 0 ||
    childrenRight.length !== length ||
    feature.length !== length ||
    threshold.length !== length ||
    value.length !== length
  ) {
    return null;
  }
  // Typed storage keeps traversal reads on compact contiguous arrays; the
  // node indices are integral and thresholds/values are the same doubles, so
  // predictions are bit-identical to the plain-array form (covered by the
  // sklearn fixture test).
  return {
    childrenLeft: Int32Array.from(childrenLeft),
    childrenRight: Int32Array.from(childrenRight),
    feature: Int32Array.from(feature),
    threshold: Float64Array.from(threshold),
    value: Float64Array.from(value),
  };
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
  SNOW_ARTIFACT_IDENTITY_CACHE,
  SNOW_MASK_TYPE_KEYS,
  SNOW_RF_MODEL_CACHE,
  SNOW_RF_MODEL_PATH_CACHE,
  SNOW_SOURCE_SELECTORS,
  WESTERN_LINEAR_FEATURE_KEYS,
  currentPhaseMaskRecords,
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
  loadWesternLinearSlrModel,
  mergeSelectedNoaaRecords,
  normalizeRfTree,
  normalizeSelectionModelKey,
  normalizeSnowRfModel,
  normalizeWesternLinearSlrModel,
  numericArray,
  profileSelector,
  resolveProfileRecord,
  resolveSnowArtifactPath,
  resolveSnowRfArtifactPath,
  resolveWesternLinearArtifactPath,
  selectNamAwphysRecords,
  selectNoaaNamParameterRecords,
  selectPointSoundingRecords,
  selectSnowfallDerivedParameterRecords,
  snowArtifactCacheIdentity,
  snowModelCacheKey,
};
