"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const zlib = require("zlib");
const { PNG } = require("pngjs");
const REFLECTIVITY_PRECIP_TYPE_COLORS = require("../../shared/reflectivity-precip-type-colors.json");
const PLANNED_COLOR_MAPS = require("../../shared/noaa-beta-planned-color-maps.json");
const { loadColorMaps } = require("./color-maps");
const { sleep } = require("./local-artifact-options");
const { rowToLatMercator } = require("./mercator");
const { loadSynopticStyle } = require("./synoptic-style");
const {
  buildHeightContourLevels,
  marchingSquares,
  marchingSquaresMany,
  renderHeightContourArtifacts,
  renderSynopticArtifacts,
} = require("./synoptic-render");
const { HOVER_GRID_SCHEMA_VERSION, SYNOPTIC_STYLE_VERSION, VIEW_CONFIG } = require("./modelview-runtime");
const { encodeHoverGridBinaryPayload } = require("./hover-grid-binary");
const {
  NOAA_NAM_PARAMETER_CATALOG,
  SCALES: NOAA_RENDER_SCALES,
  EFFECTIVE_LAYER_PROFILE_LEVELS,
  SNOW_PROFILE_LEVELS,
  SUPPORT_SELECTORS,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
} = require("./noaa-nam-parameter-catalog");

const NOAA_BETA_SOURCE_NAME = "noaa-grib2-beta";
const NOAA_NAM_BASE_URL = "https://noaa-nam-pds.s3.amazonaws.com";
const NOAA_GFS_BASE_URL = "https://noaa-gfs-bdp-pds.s3.amazonaws.com";
const NOAA_HRRR_BASE_URL = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com";
const HOVER_GRID_MISSING_VALUE = -32768;
const HOVER_GRID_GZIP_LEVEL = 1;
const DEFAULT_WGRIB2_PATH = "wgrib2";
const MPS_TO_KT = 1.943844;
const MPS_TO_MPH = 2.2369362920544;
const MM_TO_IN = 1 / 25.4;
const M_TO_IN = 39.3701;
const M_TO_FT = 3.280839895;
const PRATE_KG_M2_S_TO_IN_HR = 3600 / 25.4;
const EARTH_OMEGA_RAD_S = 7.2921e-5;
const EARTH_RADIUS_M = 6371000;
const RD_OVER_CP = 0.2854;
const CP_OVER_RD = 1 / RD_OVER_CP;
const GRAVITY_M_S2 = 9.80665;
const EPSILON = 0.622;
const RD_DRY_AIR_J_KG_K = 287.05;
const CP_DRY_AIR_J_KG_K = 1004;
const LATENT_HEAT_VAPORIZATION_J_KG = 2.5e6;
const REFLECTIVITY_LAYER_KEYS = Object.freeze(["reflectivityComposite", "reflectivity1km"]);
const LEGACY_REFLECTIVITY_LAYER_KEY = "reflectivity";
const REFLECTIVITY_PRECIP_TYPE_LAYER_KEY = "reflectivity1kmPrecipType";
const PRECIP_TYPE_REGRID_PATTERN = ":(CRAIN|CSNOW|CFRZR|CICEP):";
const PRECIP_TYPE_DECODE_KEYS = new Set([
  "precipTypeRain",
  "precipTypeSnow",
  "precipTypeFreezingRain",
  "precipTypeIcePellets",
]);
const NOAA_INDEX_TEXT_CACHE = new Map();
const NOAA_INDEX_CONTENT_LENGTH_CACHE = new Map();
const NOAA_INDEX_RECORD_CACHE = new Map();
const NOAA_RECORD_INDEX_SYMBOL = Symbol("noaaRecordIndex");
const TRANSPARENT_PNG_CACHE = new Map();
const SNOW_RF_MODEL_CACHE = new Map();
const SNOW_ARTIFACT_IDENTITY_CACHE = new Map();
const PROFILE_GRID_PROMISE_CACHE = new Map();
const RUN_MAX_GRID_PROMISE_CACHE = new Map();
const RUN_MAX_SOURCE_GRID_PROMISE_CACHE = new Map();
const SNOWFALL_DELTA_PROMISE_CACHE = new Map();
const SNOWFALL_CUMULATIVE_PROMISE_CACHE = new Map();
const WORKER_ROW_REMAP_CACHE = new Map();
const RUN_LOCAL_CACHE_STORES = new Map();
const SELECTED_GRIB_CACHE_DIRNAME = "selected-grib-v2";
const SELECTED_GRIB_CACHE_METADATA_VERSION = 2;
const SELECTED_GRIB_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const SELECTED_GRIB_LOCK_POLL_MS = 100;
const ROW_REMAP_CACHE_MAX_ENTRIES = 128;
const RUN_LOCAL_CACHE_MAX_RUNS = 8;
const RUN_LOCAL_DECODED_RECORD_GRID_MAX_ENTRIES = 192;
const RUN_LOCAL_SOURCE_GRID_MAX_ENTRIES = 192;
const RUN_LOCAL_PROFILE_GRID_MAX_ENTRIES = 192;
const PRECIP_ACCUM_GRID_CACHE_VERSION = "precip-accum-grid-v2";
const SNOW_LIQUID_GRID_CACHE_VERSION = "snow-liquid-grid-v4";
const PROFILE_GRID_CACHE_VERSION = "derived-profile-grid-v1";
const RUN_MAX_GRID_CACHE_VERSION = "run-max-grid-v1";
const SNOWFALL_DELTA_GRID_CACHE_VERSION = "snowfall-delta-grid-v4";
const SNOWFALL_CUMULATIVE_GRID_CACHE_VERSION = "snowfall-cumulative-grid-v4";
const SNOWFALL_CUMULATIVE_GRID_LOCK_MIN_HOUR = 6;
const SNOWFALL_CUMULATIVE_GRID_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const SNOWFALL_CUMULATIVE_GRID_LOCK_POLL_MS = 100;
const GRID_CACHE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const GRID_CACHE_LOCK_POLL_MS = 100;
const SNOW_LIQUID_TOTAL_KEY = "snowLiquidTotal";
const FREEZING_RAIN_LIQUID_TOTAL_KEY = "freezingRainLiquidTotal";
const FRAM_FLAT_ICE_KEY = "framFlatIce";
const FRAM_RADIAL_ICE_KEY = "framRadialIce";
const SNOWFALL_DERIVED_INTERVALS_READY_KEY = "snowfallDerivedIntervalsReady";
const SNOWFALL_DERIVED_GRID_KEY_PREFIX = "snowfallDerivedIn";
const SNOWFALL_RENDER_THRESHOLD_IN = 0.1;
const MAX_SNOW_TO_LIQUID_RATIO = 60;
const MIN_VISIBLE_SNOW_LIQUID_IN = SNOWFALL_RENDER_THRESHOLD_IN / MAX_SNOW_TO_LIQUID_RATIO;
const SPARSE_ACTIVE_GRID_MAX_FRACTION = 0.45;
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
const PRECIP_RATE_TYPE_LOOKUPS = buildPrecipRateTypeLookups(PLANNED_COLOR_MAPS?.maps?.precipRateByTypeInHr);
const SNOWFALL_PRESENTATION_SMOOTHING_BY_MODEL = Object.freeze({
  gfs: Object.freeze({ passes: 2 }),
});
const SNOWFALL_PRESENTATION_SMOOTHING_KERNEL = Object.freeze([1, 4, 6, 4, 1]);
const FRONTOGENESIS_PRESENTATION_SMOOTHING_PASSES = 4;
const EFFECTIVE_INFLOW_MIN_CAPE_JKG = 100;
const EFFECTIVE_INFLOW_MIN_CIN_JKG = -250;
const EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG = EFFECTIVE_INFLOW_MIN_CAPE_JKG;
const EFFECTIVE_PARCEL_SOURCE_DEPTH_HPA = 300;
const EFFECTIVE_PARCEL_SOURCE_STEP_HPA = 25;
const EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M = 4000;
const EFFECTIVE_MIN_EBWD_LAYER_DEPTH_M = 1000;
const EFFECTIVE_MAX_EBWD_LAYER_DEPTH_M = 6000;
const DRY_ADIABATIC_LAPSE_K_M = 0.0098;
const MOIST_ADIABATIC_MAX_STEP_M = 300;
const PARCEL_INTEGRATION_STEP_HPA = 1;
const PARCEL_CIN_TOP_PRESSURE_HPA = 500;
const MOIST_LIFT_CONVERGENCE_C = 0.1;
const BUNKERS_RIGHT_MOVER_DEVIATION_MPS = 7.5;
const MIXED_LAYER_PARCEL_DEPTH_HPA = 100;
const PROFILE_VARIABLE_PREFIX = Object.freeze({
  TMP: "profileTmp",
  HGT: "profileHgt",
  RH: "profileRh",
  DPT: "profileDpt",
  SPFH: "profileSpfh",
  PRES: "profilePres",
  VVEL: "profileVvel",
  UGRD: "profileU",
  VGRD: "profileV",
});
const PROFILE_SURFACE_DECODE_KEYS = Object.freeze({
  HGT: "profileSurfaceHeight",
  TMP: "temperature2m",
  RH: "humidity2m",
  DPT: "dewpoint2m",
  SPFH: "derivedSpecificHumidity2m",
  PRES: "derivedSurfacePressure",
  UGRD: "windU10m",
  VGRD: "windV10m",
});
const KUCHERA_PROFILE_LEVELS = Object.freeze(SNOW_PROFILE_LEVELS.filter((level) => level >= 500));
const COBB_PROFILE_LEVELS = Object.freeze(SNOW_PROFILE_LEVELS.filter((level) => level >= 300 && level <= 925));
const DERIVED_DIAGNOSTIC_PROFILE_LEVELS = Object.freeze([1000, 925, 850, 700, 500, 300]);
const POINT_SOUNDING_CACHE_VERSION = "point-sounding-selected-v1";
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
const PLETCHER_RF_AGL_LEVELS = Object.freeze([300, 600, 900, 1200, 1500, 1800, 2100, 2400]);
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
const WESTERN_LINEAR_WEST_OF_LON = -103;
const WESTERN_LINEAR_MIN_ELEVATION_M = 1000;
const COBB_TTHRESH = Object.freeze([-24, -21, -19, -16, -12, -10, -8, -7, -5, -3, 0]);
const COBB_C1 = Object.freeze([8, 12, 21, 30, 19, 9, 8, 9, 13, 6, 2]);
const COBB_C2 = Object.freeze([-0.0017, 3.5034, 4.9065, -0.465, -4.7608, -2.0799, 0.3122, 2.0127, -0.7004, -3.711, 0]);
const COBB_C3 = Object.freeze([0, 1.1684, -0.4668, -1.0679, -0.1594, 1.2318, 0.363, 1.3375, -2.6941, 1.1888, 0]);
const COBB_C4 = Object.freeze([0.1298, -0.2725, -0.0573, 0.0865, 0.1855, -0.1931, 0.3249, -0.6719, 0.6472, -0.1321, 0]);
const SYNOPTIC_DETAILED_MAX_COLS = 360;
const SYNOPTIC_DETAILED_MAX_ROWS = 224;

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

const CATALOG_VERSION = "noaa-grib2-catalog-v4";

const NOAA_BETA_MODEL_CONFIG = Object.freeze({
  gfs: Object.freeze({
    key: "gfs",
    label: "GFS",
    openDataModel: "noaa-gfs-pgrb2-0p25",
    baseUrl: NOAA_GFS_BASE_URL,
    productKey: "pgrb2-0p25",
    cycleHours: [0, 6, 12, 18],
    buildUrl: ({ baseUrl, date, cycle, hour }) => {
      const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_GFS_BASE_URL);
      return `${normalizedBase}/gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.pgrb2.0p25.f${padHour(hour)}`;
    },
  }),
  nam: Object.freeze({
    key: "nam",
    label: "NAM",
    openDataModel: "noaa-nam-awphys",
    baseUrl: NOAA_NAM_BASE_URL,
    productKey: "awphys",
    cycleHours: [0, 6, 12, 18],
    buildUrl: ({ baseUrl, date, cycle, hour }) => {
      const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_NAM_BASE_URL);
      return `${normalizedBase}/nam.${date}/nam.t${cycle}z.awphys${padTwoDigitHour(hour)}.tm00.grib2`;
    },
  }),
  nam3km: Object.freeze({
    key: "nam3km",
    label: "NAM 3km",
    openDataModel: "noaa-nam-conusnest",
    baseUrl: NOAA_NAM_BASE_URL,
    productKey: "conusnest-hires",
    cycleHours: [0, 6, 12, 18],
    buildUrl: ({ baseUrl, date, cycle, hour }) => {
      const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_NAM_BASE_URL);
      return `${normalizedBase}/nam.${date}/nam.t${cycle}z.conusnest.hiresf${padTwoDigitHour(hour)}.tm00.grib2`;
    },
  }),
  hrrr: Object.freeze({
    key: "hrrr",
    label: "HRRR",
    openDataModel: "noaa-hrrr-wrfprs",
    baseUrl: NOAA_HRRR_BASE_URL,
    productKey: "wrfprs",
    cycleHours: Array.from({ length: 24 }, (_, hour) => hour),
    buildUrl: ({ baseUrl, date, cycle, hour }) => {
      const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_HRRR_BASE_URL);
      return `${normalizedBase}/hrrr.${date}/conus/hrrr.t${cycle}z.wrfprsf${padTwoDigitHour(hour)}.grib2`;
    },
  }),
});

const NOAA_BETA_MODEL_KEYS = Object.freeze(Object.keys(NOAA_BETA_MODEL_CONFIG));

function createFrameDecodeSession(profile = null) {
  return {
    profile,
    runCache: null,
    selectedGribPromises: new Map(),
    decodedGridPromises: new Map(),
    decodedRecordGrids: createBoundedRunCacheMap(RUN_LOCAL_DECODED_RECORD_GRID_MAX_ENTRIES),
    sourceGridRegistry: createBoundedRunCacheMap(RUN_LOCAL_SOURCE_GRID_MAX_ENTRIES),
    profileGridRegistry: createBoundedRunCacheMap(RUN_LOCAL_PROFILE_GRID_MAX_ENTRIES),
    profileDecodeBatches: new Map(),
    rowMaps: new Map(),
    parsedRecords: new Map(),
    selectedPlans: new Map(),
    counters: {
      selectedGribPromiseHits: 0,
      decodedGridPromiseHits: 0,
      decodedRecordGridHits: 0,
      rowMapHits: 0,
      rowMapMisses: 0,
    },
  };
}

function attachRunLocalDecodeSession(decodeSession, context) {
  if (!decodeSession) {
    return null;
  }
  const runCache = getRunLocalCache(context);
  decodeSession.runCache = runCache;
  decodeSession.decodedRecordGrids = runCache.decodedRecordGrids;
  decodeSession.sourceGridRegistry = runCache.sourceGridRegistry;
  decodeSession.profileGridRegistry = runCache.profileGridRegistry;
  return runCache;
}

function getRunLocalCache(context) {
  const key = runLocalCacheKey(context);
  let cache = RUN_LOCAL_CACHE_STORES.get(key);
  if (cache) {
    cache.lastUsed = Date.now();
    RUN_LOCAL_CACHE_STORES.delete(key);
    RUN_LOCAL_CACHE_STORES.set(key, cache);
    return cache;
  }
  cache = {
    key,
    lastUsed: Date.now(),
    decodedRecordGrids: createBoundedRunCacheMap(RUN_LOCAL_DECODED_RECORD_GRID_MAX_ENTRIES),
    sourceGridRegistry: createBoundedRunCacheMap(RUN_LOCAL_SOURCE_GRID_MAX_ENTRIES),
    profileGridRegistry: createBoundedRunCacheMap(RUN_LOCAL_PROFILE_GRID_MAX_ENTRIES),
  };
  RUN_LOCAL_CACHE_STORES.set(key, cache);
  pruneRunLocalCaches();
  return cache;
}

function runLocalCacheKey(context) {
  return JSON.stringify({
    modelKey: context?.modelKey || "",
    productKey: context?.modelConfig?.productKey || "",
    baseUrl: normalizeBaseUrl(context?.baseUrl || ""),
    date: context?.date || "",
    cycle: context?.cycle || "",
  });
}

function createBoundedRunCacheMap(maxEntries) {
  const map = new Map();
  map.maxEntries = Math.max(1, Math.round(Number(maxEntries) || 1));
  return map;
}

function boundedRunCacheGet(cache, key) {
  if (!cache || !cache.has(key)) {
    return null;
  }
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function boundedRunCacheSet(cache, key, value) {
  if (!cache || !key || !value) {
    return;
  }
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  const maxEntries = Math.max(1, Math.round(Number(cache.maxEntries) || 1));
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function pruneRunLocalCaches() {
  while (RUN_LOCAL_CACHE_STORES.size > RUN_LOCAL_CACHE_MAX_RUNS) {
    const oldestKey = RUN_LOCAL_CACHE_STORES.keys().next().value;
    RUN_LOCAL_CACHE_STORES.delete(oldestKey);
  }
}

async function renderNoaaNamAwphysFrame({
  modelKey = "nam",
  latestMetadata,
  framePlan,
  viewKey = "conus",
  renderWidth,
  renderHeight,
  reflectivityGates = [10, 15, 20],
  noaaBaseUrl = NOAA_NAM_BASE_URL,
  wgrib2Path = DEFAULT_WGRIB2_PATH,
  rawCacheDir = null,
  tempRoot = os.tmpdir(),
  pngCompressionLevel = 1,
  pngFilterType = 0,
  rangeFetchConcurrency = 8,
  rangeFetchLimiter = null,
  decodeConcurrency = 1,
  hoverGridFormat = latestMetadata?.hoverGridFormat || "binary",
}) {
  return renderNoaaGribFrame({
    modelKey,
    latestMetadata,
    framePlan,
    viewKey,
    renderWidth,
    renderHeight,
    reflectivityGates,
    noaaBaseUrl,
    wgrib2Path,
    rawCacheDir,
    tempRoot,
    pngCompressionLevel,
    pngFilterType,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    hoverGridFormat,
  });
}

async function renderNoaaGribFrame({
  modelKey,
  latestMetadata,
  framePlan,
  viewKey = "conus",
  renderWidth,
  renderHeight,
  reflectivityGates = [10, 15, 20],
  noaaBaseUrl = null,
  wgrib2Path = DEFAULT_WGRIB2_PATH,
  rawCacheDir = null,
  tempRoot = os.tmpdir(),
  pngCompressionLevel = 1,
  pngFilterType = 0,
  rangeFetchConcurrency = 8,
  rangeFetchLimiter = null,
  decodeConcurrency = 1,
  hoverGridFormat = latestMetadata?.hoverGridFormat || "binary",
  renderMode = "all",
}) {
  const renderProfile = createNoaaRenderProfile();
  const decodeSession = createFrameDecodeSession(renderProfile);
  const totalStartedAt = performance.now();
  const noaa = latestMetadata?.noaa || {};
  const resolvedModelKey = normalizeNoaaModelKey(modelKey || latestMetadata?.modelKey || noaa.model || "nam");
  const modelConfig = getNoaaGribModelConfig(resolvedModelKey);
  const date = String(noaa.date || "").trim();
  const cycle = String(noaa.cycle || "").padStart(2, "0");
  const resolvedBaseUrl = noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl;
  const hour = Number(framePlan?.hour);
  if (!/^\d{8}$/.test(date) || !/^\d{2}$/.test(cycle) || !Number.isFinite(hour)) {
    throw new Error(`NOAA ${modelConfig.label} beta render is missing date, cycle, or forecast hour metadata.`);
  }

  const view = VIEW_CONFIG[viewKey];
  if (!view) {
    throw new Error(`Unsupported view '${viewKey}'.`);
  }
  const width = Number.isFinite(renderWidth) ? Number(renderWidth) : view.width;
  const height = Number.isFinite(renderHeight) ? Number(renderHeight) : view.height;
  const gribUrl = buildNoaaGribUrl({
    modelKey: resolvedModelKey,
    baseUrl: resolvedBaseUrl,
    date,
    cycle,
    hour,
  });
  attachRunLocalDecodeSession(decodeSession, {
    modelKey: resolvedModelKey,
    modelConfig,
    baseUrl: resolvedBaseUrl,
    date,
    cycle,
  });
  const indexCacheContext = buildNoaaIndexCacheContext({
    modelKey: resolvedModelKey,
    date,
    cycle,
    rawCacheDir,
  });
  const selectedCatalog = filterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, renderMode);
  let stageStartedAt = performance.now();
  const indexText = await readOrFetchNoaaIdxTextCached(`${gribUrl}.idx`, indexCacheContext, hour, renderProfile);
  recordProfileStage(renderProfile, "indexMs", stageStartedAt);
  stageStartedAt = performance.now();
  const records = parseNoaaIdx(indexText, null);
  const selection = selectNoaaNamParameterRecords(records, {
    catalog: selectedCatalog,
    modelKey: resolvedModelKey,
    targetHour: hour,
    renderMode,
  });
  if (selection.missingRequired.length > 0) {
    throw new Error(`NOAA ${modelConfig.label} beta missing required records: ${selection.missingRequired.join(", ")}`);
  }

  recordProfileStage(renderProfile, "selectMs", stageStartedAt);
  const tempDir = await fs.promises.mkdtemp(
    path.join(tempRoot, `noaa-${resolvedModelKey}-${date}-${cycle}-${padHour(hour)}-`),
  );
  try {
    const precomputeOnlyRender =
      renderMode === "snow" ||
      renderMode === "snow-delta" ||
      renderMode === "snow-prefix" ||
      renderMode === "runmax-prefix";
    let decoded = {};
    if (!precomputeOnlyRender) {
      stageStartedAt = performance.now();
      await ensureSelectedRecordByteRangesForHour({
        context: {
          modelKey: resolvedModelKey,
          baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
          date,
          cycle,
          sourceIndexCacheDir: indexCacheContext.sourceIndexCacheDir,
          recordsByHour: new Map([[hour, records]]),
        },
        hour,
        selectedRecords: Object.values(selection.records).filter(Boolean),
        gribUrl,
        profile: renderProfile,
      });
      recordProfileStage(renderProfile, "headMs", stageStartedAt);
      const selectedPlan = getSelectedRecordPlan(Object.values(selection.records).filter(Boolean), decodeSession);
      renderProfile.selectedRecordGroups = selectedPlan.groups.length;
      stageStartedAt = performance.now();
      const gribPath = await materializeSelectedGrib({
        modelKey: resolvedModelKey,
        productKey: modelConfig.productKey,
        gribUrl,
        recordGroups: selectedPlan.groups,
        rawCacheDir,
        date,
        cycle,
        hour,
        cacheVersion: CATALOG_VERSION,
        rangeFetchConcurrency,
        rangeFetchLimiter,
        profile: renderProfile,
        decodeSession,
      });
      recordProfileStage(renderProfile, "materializeMs", stageStartedAt);
      stageStartedAt = performance.now();
      decoded = await decodeSelectedRecordsToGrids({
        gribPath,
        selectedPlan,
        selection,
        hour,
        tempDir,
        wgrib2Path,
        bounds: view.bounds,
        width,
        height,
        decodeConcurrency,
        profile: renderProfile,
        decodeSession,
      });
    }
    stageStartedAt = performance.now();
    if (!precomputeOnlyRender) {
      Object.assign(
        decoded,
        await buildPrecipAccumulationGrids({
          modelKey: resolvedModelKey,
          modelConfig,
          baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
          date,
          cycle,
          targetHour: hour,
          currentRecords: records,
          latestMetadata,
          rawCacheDir,
          tempDir,
          wgrib2Path,
          bounds: view.bounds,
          width,
          height,
          rangeFetchConcurrency,
          rangeFetchLimiter,
          decodeConcurrency,
          decoded,
          selection,
          profile: renderProfile,
          decodeSession,
        }),
      );
      Object.assign(
        decoded,
        await buildRunMaxAccumulationGrids({
          modelKey: resolvedModelKey,
          modelConfig,
          baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
          date,
          cycle,
          targetHour: hour,
          currentRecords: records,
          latestMetadata,
          rawCacheDir,
          tempDir,
          wgrib2Path,
          bounds: view.bounds,
          width,
          height,
          rangeFetchConcurrency,
          rangeFetchLimiter,
          decodeConcurrency,
          decoded,
          selection,
          profile: renderProfile,
          decodeSession,
        }),
      );
    }
    if (renderMode === "runmax-prefix") {
      await buildRunMaxPrefixOnlyGrids({
        modelKey: resolvedModelKey,
        modelConfig,
        baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
        date,
        cycle,
        targetHour: hour,
        currentRecords: records,
        latestMetadata,
        rawCacheDir,
        tempDir,
        wgrib2Path,
        bounds: view.bounds,
        width,
        height,
        rangeFetchConcurrency,
        rangeFetchLimiter,
        decodeConcurrency,
        decoded,
        selection,
        profile: renderProfile,
        decodeSession,
      });
    } else if (renderMode === "snow-delta") {
      await buildSnowfallDeltaOnlyGrids({
        modelKey: resolvedModelKey,
        modelConfig,
        baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
        date,
        cycle,
        targetHour: hour,
        currentRecords: records,
        latestMetadata,
        rawCacheDir,
        tempDir,
        wgrib2Path,
        bounds: view.bounds,
        width,
        height,
        rangeFetchConcurrency,
        rangeFetchLimiter,
        decodeConcurrency,
        decoded,
        selection,
        profile: renderProfile,
        decodeSession,
      });
    } else if (renderMode === "snow-prefix") {
      await buildSnowfallCumulativePrefixOnlyGrids({
        modelKey: resolvedModelKey,
        modelConfig,
        baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
        date,
        cycle,
        targetHour: hour,
        currentRecords: records,
        latestMetadata,
        rawCacheDir,
        tempDir,
        wgrib2Path,
        bounds: view.bounds,
        width,
        height,
        rangeFetchConcurrency,
        rangeFetchLimiter,
        decodeConcurrency,
        decoded,
        selection,
        profile: renderProfile,
        decodeSession,
      });
    } else if (renderMode === "base") {
      const snowSelection = selectSnowfallDerivedParameterRecords(records, {
        modelKey: resolvedModelKey,
        targetHour: hour,
      });
      const [freezingRain] = await Promise.all([
        buildFreezingRainAccumulationGrids({
          modelKey: resolvedModelKey,
          modelConfig,
          baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
          date,
          cycle,
          targetHour: hour,
          currentRecords: records,
          latestMetadata,
          rawCacheDir,
          tempDir,
          wgrib2Path,
          bounds: view.bounds,
          width,
          height,
          rangeFetchConcurrency,
          rangeFetchLimiter,
          decodeConcurrency,
          decoded,
          selection,
          profile: renderProfile,
          decodeSession,
          profileDecodeUnion: true,
        }),
        buildSnowfallDeltaOnlyGrids({
          modelKey: resolvedModelKey,
          modelConfig,
          baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
          date,
          cycle,
          targetHour: hour,
          currentRecords: records,
          latestMetadata,
          rawCacheDir,
          tempDir,
          wgrib2Path,
          bounds: view.bounds,
          width,
          height,
          rangeFetchConcurrency,
          rangeFetchLimiter,
          decodeConcurrency,
          decoded,
          selection: snowSelection,
          profile: renderProfile,
          decodeSession,
          profileDecodeUnion: true,
        }),
      ]);
      Object.assign(decoded, freezingRain);
    } else if (renderMode !== "base") {
      Object.assign(
        decoded,
        await buildWinterDerivedInputGrids({
          modelKey: resolvedModelKey,
          modelConfig,
          baseUrl: noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl,
          date,
          cycle,
          targetHour: hour,
          currentRecords: records,
          latestMetadata,
          rawCacheDir,
          tempDir,
          wgrib2Path,
          bounds: view.bounds,
          width,
          height,
          rangeFetchConcurrency,
          rangeFetchLimiter,
          decodeConcurrency,
          decoded,
          selection,
          profile: renderProfile,
          decodeSession,
        }),
      );
    }
    if (!precomputeOnlyRender) {
      Object.assign(
        decoded,
        buildDerivedParameterGrids({
          decoded,
          selection,
          bounds: view.bounds,
          modelKey: resolvedModelKey,
          width,
          height,
          profile: renderProfile,
        }),
      );
    }
    recordProfileStage(renderProfile, "decodeMs", stageStartedAt);

    stageStartedAt = performance.now();
    const renderedArtifacts =
      renderMode === "snow-delta" || renderMode === "snow-prefix" || renderMode === "runmax-prefix"
        ? buildSnowDeltaRenderedArtifacts({ framePlan })
        : renderMode === "snow"
          ? buildSnowRenderedArtifacts({
              decoded,
              selection,
              framePlan,
              modelKey: resolvedModelKey,
              width,
              height,
              pngCompressionLevel,
              pngFilterType,
              hoverGridFormat,
              profile: renderProfile,
            })
          : buildRenderedArtifacts({
              decoded,
              selection,
              framePlan,
              bounds: view.bounds,
              modelKey: resolvedModelKey,
              width,
              height,
              reflectivityGates,
              pngCompressionLevel,
              pngFilterType,
              hoverGridFormat,
              profile: renderProfile,
            });
    recordProfileStage(renderProfile, "artifactsMs", stageStartedAt);
    recordProfileStage(renderProfile, "totalMs", totalStartedAt);
    renderedArtifacts.renderProfile = finalizeNoaaRenderProfile(renderProfile);
    return renderedArtifacts;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

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

function buildSnowRenderedArtifacts({
  decoded,
  selection,
  framePlan,
  modelKey,
  width,
  height,
  pngCompressionLevel,
  pngFilterType,
  hoverGridFormat = "binary",
  profile = null,
}) {
  let stageStartedAt = performance.now();
  const snowfallIn = buildSnowfallInGrids({ decoded, selection, modelKey, width, height });
  const emptyPng = createTransparentPng(width, height, pngCompressionLevel, pngFilterType);
  const layers = {};
  const hoverValueCounts = new Map();
  const encodeTrackedLayer = (key, layer) => {
    recordHoverValueCount(hoverValueCounts, key, layer);
    return encodeLayerOrEmpty(layer, emptyPng, width, height, pngCompressionLevel, pngFilterType);
  };
  recordProfileStage(profile, "artifactPrepMs", stageStartedAt);

  stageStartedAt = performance.now();
  for (const entry of selection.catalog || NOAA_NAM_PARAMETER_CATALOG) {
    if (entry.kind !== "snowfallDerived") {
      continue;
    }
    const values = snowfallIn[entry.key];
    if (!values) {
      continue;
    }
    layers[entry.key] = encodeTrackedLayer(
      entry.key,
      renderScalarGrid({
        values,
        width,
        height,
        ...getCatalogRenderOptions(entry),
      }),
    );
  }
  recordProfileStage(profile, "catalogPngMs", stageStartedAt);

  stageStartedAt = performance.now();
  const hoverVariables = buildHoverGridVariables({
    decoded,
    selection,
    snowfallIn,
    width,
    height,
    hoverValueCounts,
  });
  const hoverGrid = buildHoverGridArtifact({
    width,
    height,
    variables: hoverVariables,
    format: hoverGridFormat,
  });
  recordProfileStage(profile, "hoverGridMs", stageStartedAt);

  return {
    hour: Number(framePlan.hour),
    validHourKey: String(framePlan.validTime),
    hoverGrid,
    hoverGridSchemaVersion: HOVER_GRID_SCHEMA_VERSION,
    layers,
  };
}

function buildSnowDeltaRenderedArtifacts({ framePlan }) {
  return {
    hour: Number(framePlan.hour),
    validHourKey: String(framePlan.validTime),
    layers: {},
  };
}

function buildRenderedArtifacts({
  decoded,
  selection,
  framePlan,
  bounds,
  modelKey,
  width,
  height,
  reflectivityGates,
  pngCompressionLevel,
  pngFilterType,
  hoverGridFormat = "binary",
  profile = null,
}) {
  let stageStartedAt = performance.now();
  const temperatureF = transformGridAffine(decoded.temperature2m, 9 / 5, -459.67);
  const windMph = buildWindSpeedGrid(decoded.windU10m, decoded.windV10m, MPS_TO_MPH);
  const windSpeedGridCache = new Map([["wind", windMph]]);
  const heightDamGridCache = new Map();
  const getWindSpeedGrid = (entry) =>
    resolveCachedWindSpeedGrid({
      entry,
      decoded,
      cache: windSpeedGridCache,
    });
  const getHeightDamGrid = (entry) =>
    resolveCachedHeightDamGrid({
      entry,
      decoded,
      cache: heightDamGridCache,
    });
  const precipAccumulationIn = buildPrecipAccumulationInGrids(decoded);
  const precipIn = precipAccumulationIn.precip || transformGridAffine(decoded.precip, MM_TO_IN, 0, 0);
  const snowfallIn = buildSnowfallInGrids({ decoded, selection, bounds, modelKey, width, height });
  const reflectivityCompositeDbz = decoded.reflectivityComposite || decoded.reflectivity || null;
  const reflectivity1kmDbz = decoded.reflectivity1km || null;
  const pressureHpa = transformGridAffine(decoded.pressureMsl, 0.01);
  const height500 = decoded.height500 || null;
  const height1000 = decoded.height1000 || null;
  const thicknessDam = buildThicknessGrid(height500, height1000);
  const emptyPng = createTransparentPng(width, height, pngCompressionLevel, pngFilterType);
  const layers = {};
  const hoverValueCounts = new Map();
  const encodeTrackedLayer = (key, layer) => {
    recordHoverValueCount(hoverValueCounts, key, layer);
    return encodeLayerOrEmpty(layer, emptyPng, width, height, pngCompressionLevel, pngFilterType);
  };
  const contourVectors = {};
  const availableParameters = new Set(selection?.availableParameters || []);
  const isEntryAvailable = (entry) => availableParameters.size === 0 || availableParameters.has(entry.key);
  recordProfileStage(profile, "artifactPrepMs", stageStartedAt);

  stageStartedAt = performance.now();
  layers.temperature = encodeTrackedLayer(
    "temperature",
    renderScalarGrid({
      values: temperatureF,
      width,
      height,
      ...CORE_LAYER_RENDER_OPTIONS.temperature,
    }),
  );

  layers.wind = encodeTrackedLayer(
    "wind",
    renderScalarGrid({
      values: windMph,
      width,
      height,
      ...CORE_LAYER_RENDER_OPTIONS.wind,
    }),
  );

  layers.precip = encodeTrackedLayer(
    "precip",
    renderScalarGrid({
      values: precipIn,
      width,
      height,
      ...CORE_LAYER_RENDER_OPTIONS.precip,
    }),
  );

  for (const [layerKey, values] of Object.entries(precipAccumulationIn)) {
    if (layerKey === "precip") {
      continue;
    }
    layers[layerKey] = encodeTrackedLayer(
      layerKey,
      renderScalarGrid({
        values,
        width,
        height,
        ...CORE_LAYER_RENDER_OPTIONS.precip,
      }),
    );
  }

  const reflectivityVariantsByLayer = {};
  const reflectivityVariants = renderReflectivityVariants({
    values: reflectivityCompositeDbz,
    width,
    height,
    reflectivityGates,
    emptyPng,
    pngCompressionLevel,
    pngFilterType,
  });
  reflectivityVariantsByLayer.reflectivityComposite = reflectivityVariants;
  layers.reflectivityComposite = pickDefaultReflectivityArtifact(reflectivityVariants) || encodeRawPng(emptyPng);
  layers.reflectivity = layers.reflectivityComposite;

  if (reflectivity1kmDbz) {
    const reflectivity1kmVariants = renderReflectivityVariants({
      values: reflectivity1kmDbz,
      width,
      height,
      reflectivityGates,
      emptyPng,
      pngCompressionLevel,
      pngFilterType,
    });
    reflectivityVariantsByLayer.reflectivity1km = reflectivity1kmVariants;
    layers.reflectivity1km = pickDefaultReflectivityArtifact(reflectivity1kmVariants) || encodeRawPng(emptyPng);
  }
  if (selection.availableParameters?.includes(REFLECTIVITY_PRECIP_TYPE_LAYER_KEY)) {
    layers[REFLECTIVITY_PRECIP_TYPE_LAYER_KEY] = encodeLayerOrEmpty(
      renderReflectivityPrecipTypeGrid({
        reflectivityDbz: reflectivity1kmDbz,
        rain: decoded.precipTypeRain,
        snow: decoded.precipTypeSnow,
        freezingRain: decoded.precipTypeFreezingRain,
        sleet: decoded.precipTypeIcePellets,
        width,
        height,
      }),
      emptyPng,
      width,
      height,
      pngCompressionLevel,
      pngFilterType,
    );
  }
  recordProfileStage(profile, "corePngMs", stageStartedAt);

  stageStartedAt = performance.now();
  for (const entry of selection.catalog || NOAA_NAM_PARAMETER_CATALOG) {
    if (!isEntryAvailable(entry)) {
      continue;
    }
    if (entry.kind === "reflectivityPrecipType") {
      continue;
    }
    if (layers[entry.key] || isReflectivityLayerKey(entry.key)) {
      continue;
    }
    if (entry.kind === "precipRateType") {
      const layer = renderPrecipRateTypeGrid({
        precipRate: decoded?.[entry.rateKey],
        rain: decoded?.[entry.precipTypeKeys?.rain],
        snow: decoded?.[entry.precipTypeKeys?.snow],
        freezingRain: decoded?.[entry.precipTypeKeys?.freezingRain],
        sleet: decoded?.[entry.precipTypeKeys?.sleet],
        width,
        height,
      });
      if (layer) {
        layers[entry.key] = encodeLayerOrEmpty(layer, emptyPng, width, height, pngCompressionLevel, pngFilterType);
      }
      continue;
    }
    if (entry.kind === "snowfallDerived" || entry.kind === "snowfallDirect") {
      const values = snowfallIn[entry.key];
      if (values) {
        layers[entry.key] = encodeTrackedLayer(
          entry.key,
          renderScalarGrid({
            values,
            width,
            height,
            ...getCatalogRenderOptions(entry),
          }),
        );
      }
      continue;
    }
    if (entry.kind === "heightContour") {
      const values = getHeightDamGrid(entry);
      const contourLayer = renderHeightContourLayer({
        entry,
        values,
        bounds,
        modelKey,
        width,
        height,
      });
      if (contourLayer) {
        contourVectors[entry.key] = contourLayer.vector;
        layers[entry.key] = encodeLayerOrEmpty(
          contourLayer,
          emptyPng,
          width,
          height,
          pngCompressionLevel,
          pngFilterType,
        );
      }
      continue;
    }
    const layer = renderCatalogParameterLayer({
      entry,
      decoded,
      selection,
      width,
      height,
      getWindSpeedGrid,
    });
    if (!layer) {
      continue;
    }
    layers[entry.key] = encodeTrackedLayer(entry.key, layer);
  }
  recordProfileStage(profile, "catalogPngMs", stageStartedAt);

  stageStartedAt = performance.now();
  const detailedPressurePayload = buildSynopticDetailGridPayload(pressureHpa, width, height);
  const detailedThicknessPayload = buildSynopticDetailGridPayload(thicknessDam, width, height);
  const synopticSimple = renderSynopticArtifacts({
    pressureGrid: gridPayload(pressureHpa, width, height),
    thicknessGrid: gridPayload(thicknessDam, width, height),
    targetBounds: bounds,
    width,
    height,
    modelKey,
    detailMode: "simple",
    style: SYNOPTIC_STYLE,
  });
  let synopticDetailed = renderSynopticArtifacts({
    pressureGrid: detailedPressurePayload,
    thicknessGrid: detailedThicknessPayload,
    targetBounds: bounds,
    width,
    height,
    modelKey,
    detailMode: "detailed",
    style: SYNOPTIC_STYLE,
    drawImage: false,
  });
  let synopticImage = synopticSimple.visibleCount > 0 ? synopticSimple : null;
  if (!synopticImage) {
    synopticDetailed = renderSynopticArtifacts({
      pressureGrid: detailedPressurePayload,
      thicknessGrid: detailedThicknessPayload,
      targetBounds: bounds,
      width,
      height,
      modelKey,
      detailMode: "detailed",
      style: SYNOPTIC_STYLE,
    });
    synopticImage = synopticDetailed;
  }
  layers.synoptic = encodeLayerOrEmpty(synopticImage, emptyPng, width, height, pngCompressionLevel, pngFilterType);
  recordProfileStage(profile, "synopticMs", stageStartedAt);

  stageStartedAt = performance.now();
  const hoverVariables = buildHoverGridVariables({
    decoded,
    selection,
    temperatureF,
    windMph,
    precipIn,
    precipAccumulationIn,
    snowfallIn,
    reflectivityCompositeDbz,
    reflectivity1kmDbz,
    pressureHpa,
    width,
    height,
    getWindSpeedGrid,
    hoverValueCounts,
  });
  const hoverGrid = buildHoverGridArtifact({
    width,
    height,
    variables: hoverVariables,
    format: hoverGridFormat,
  });
  recordProfileStage(profile, "hoverGridMs", stageStartedAt);

  return {
    hour: Number(framePlan.hour),
    validHourKey: String(framePlan.validTime),
    synopticCenters: synopticImage.centers || { highs: [], lows: [] },
    synopticVectors: {
      simple: synopticSimple.vector || createEmptySynopticVectorPayload(),
      detailed: synopticDetailed.vector || createEmptySynopticVectorPayload(),
    },
    pressureUploadMeta: {
      source: pressureHpa ? "om-grid" : "none",
      inputRows: pressureHpa ? height : null,
      inputCols: pressureHpa ? width : null,
      hoverRows: height,
      hoverCols: width,
      fullResolutionInput: Boolean(pressureHpa),
    },
    hoverGrid,
    hoverGridSchemaVersion: HOVER_GRID_SCHEMA_VERSION,
    reflectivityVariants,
    reflectivityVariantsByLayer,
    contourVectors,
    layers,
  };
}

async function buildNoaaPointSounding({
  modelKey,
  runId = null,
  date = null,
  cycle = null,
  hour,
  lat,
  lon,
  noaaBaseUrl = null,
  wgrib2Path = DEFAULT_WGRIB2_PATH,
  rawCacheDir = null,
  tempRoot = os.tmpdir(),
  rangeFetchConcurrency = 4,
  rangeFetchLimiter = null,
}) {
  const resolvedModelKey = normalizeNoaaModelKey(modelKey);
  const modelConfig = getNoaaGribModelConfig(resolvedModelKey);
  const runParts = resolvePointSoundingRunParts({ runId, date, cycle });
  const targetHour = Math.round(Number(hour));
  const targetLat = Number(lat);
  const targetLon = normalizeLongitudeForRequest(lon);
  if (!runParts || !Number.isFinite(targetHour) || targetHour < 0) {
    throw new Error("Point sounding request is missing a valid run or forecast hour.");
  }
  if (!Number.isFinite(targetLat) || !Number.isFinite(targetLon)) {
    throw new Error("Point sounding request is missing a valid latitude/longitude.");
  }

  const resolvedBaseUrl = noaaBaseUrl || modelConfig.baseUrl;
  const gribUrl = buildNoaaGribUrl({
    modelKey: resolvedModelKey,
    baseUrl: resolvedBaseUrl,
    date: runParts.date,
    cycle: runParts.cycle,
    hour: targetHour,
  });
  const profile = createNoaaRenderProfile();
  const decodeSession = createFrameDecodeSession(profile);
  attachRunLocalDecodeSession(decodeSession, {
    modelKey: resolvedModelKey,
    modelConfig,
    baseUrl: resolvedBaseUrl,
    date: runParts.date,
    cycle: runParts.cycle,
  });

  const indexCacheContext = buildNoaaIndexCacheContext({
    modelKey: resolvedModelKey,
    date: runParts.date,
    cycle: runParts.cycle,
    rawCacheDir,
  });
  let stageStartedAt = performance.now();
  const indexText = await readOrFetchNoaaIdxTextCached(`${gribUrl}.idx`, indexCacheContext, targetHour, profile);
  recordProfileStage(profile, "indexMs", stageStartedAt);
  const records = parseNoaaIdx(indexText, null);
  const soundingSelection = selectPointSoundingRecords(records);
  const renderedSelection = selectNoaaNamParameterRecords(records, {
    catalog: NOAA_NAM_PARAMETER_CATALOG,
    modelKey: resolvedModelKey,
    targetHour,
  });
  let selectedRecords = Object.values(renderedSelection.records || {}).filter(Boolean);
  let selectedCacheVersion = CATALOG_VERSION;
  if (selectedRecords.length > 0) {
    const mergedRecords = mergeSelectedNoaaRecords(
      selectedRecords,
      Object.values(soundingSelection.records).filter(Boolean),
    );
    if (mergedRecords.length !== selectedRecords.length) {
      selectedRecords = mergedRecords;
      selectedCacheVersion = POINT_SOUNDING_CACHE_VERSION;
    }
  } else {
    selectedRecords = Object.values(soundingSelection.records).filter(Boolean);
    selectedCacheVersion = POINT_SOUNDING_CACHE_VERSION;
  }
  if (selectedRecords.length === 0) {
    throw new Error(`No point sounding records were available for ${modelConfig.label} f${padHour(targetHour)}.`);
  }

  stageStartedAt = performance.now();
  await ensureSelectedRecordByteRangesForHour({
    context: {
      modelKey: resolvedModelKey,
      baseUrl: resolvedBaseUrl,
      date: runParts.date,
      cycle: runParts.cycle,
      sourceIndexCacheDir: indexCacheContext.sourceIndexCacheDir,
      recordsByHour: new Map([[targetHour, records]]),
    },
    hour: targetHour,
    selectedRecords,
    gribUrl,
    profile,
  });
  recordProfileStage(profile, "headMs", stageStartedAt);

  const selectedPlan = getSelectedRecordPlan(selectedRecords, decodeSession);
  const tempDir = await fs.promises.mkdtemp(
    path.join(tempRoot, `noaa-sounding-${resolvedModelKey}-${runParts.date}-${runParts.cycle}-${padHour(targetHour)}-`),
  );
  try {
    stageStartedAt = performance.now();
    const gribPath = await materializeSelectedGrib({
      modelKey: resolvedModelKey,
      productKey: modelConfig.productKey,
      gribUrl,
      recordGroups: selectedPlan.groups,
      rawCacheDir,
      date: runParts.date,
      cycle: runParts.cycle,
      hour: targetHour,
      cacheVersion: selectedCacheVersion,
      rangeFetchConcurrency,
      rangeFetchLimiter,
      profile,
      decodeSession,
    });
    recordProfileStage(profile, "materializeMs", stageStartedAt);

    stageStartedAt = performance.now();
    const output = await runCommand(wgrib2Path, [
      gribPath,
      "-s",
      "-lon",
      String(roundForCommand(targetLon)),
      String(roundForCommand(targetLat)),
    ]);
    recordProfileStage(profile, "pointExtractMs", stageStartedAt);
    const sampled = parsePointSoundingLonOutput(output.stdout);
    return buildPointSoundingPayload({
      modelKey: resolvedModelKey,
      modelConfig,
      date: runParts.date,
      cycle: runParts.cycle,
      hour: targetHour,
      requestLat: targetLat,
      requestLon: targetLon,
      selectedRecordCount: selectedRecords.length,
      sampled,
      selection: soundingSelection,
      renderProfile: finalizeNoaaRenderProfile(profile),
    });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolvePointSoundingRunParts({ runId, date, cycle }) {
  const explicitDate = String(date || "").trim();
  const explicitCycle = String(cycle || "")
    .trim()
    .padStart(2, "0");
  if (/^\d{8}$/.test(explicitDate) && /^\d{2}$/.test(explicitCycle)) {
    return { date: explicitDate, cycle: explicitCycle };
  }
  const match = String(runId || "")
    .trim()
    .match(/^(\d{8})-(\d{2})00Z$/);
  return match ? { date: match[1], cycle: match[2] } : null;
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

function parsePointSoundingLonOutput(text) {
  const values = new Map();
  let sampleLat = Number.NaN;
  let sampleLon = Number.NaN;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(":");
    const param = String(parts[3] || "").trim();
    const level = String(parts[4] || "").trim();
    const valueMatch = line.match(/(?:^|[,\s])val=([^,\s]+)/);
    if (!param || !level || !valueMatch) {
      continue;
    }
    const value = Number(valueMatch[1]);
    if (!Number.isFinite(value) || Math.abs(value) > 9e19) {
      continue;
    }
    values.set(pointSoundingValueKey(param, level), value);
    const lonMatch = line.match(/(?:^|[:,\s])lon=([^,\s]+)/);
    const latMatch = line.match(/(?:^|[:,\s])lat=([^,\s]+)/);
    if (lonMatch) {
      sampleLon = normalizeLongitudeForDisplay(Number(lonMatch[1]));
    }
    if (latMatch) {
      sampleLat = Number(latMatch[1]);
    }
  }
  return { values, sampleLat, sampleLon };
}

function buildPointSoundingPayload({
  modelKey,
  modelConfig,
  date,
  cycle,
  hour,
  requestLat,
  requestLon,
  selectedRecordCount,
  sampled,
  selection,
  renderProfile,
}) {
  const values = sampled.values || new Map();
  const warnings = [];
  const surface = buildPointSoundingSurface(values);
  const direct = buildPointSoundingDirectDiagnostics(values, surface);
  if (!Number.isFinite(surface.press)) {
    warnings.push("Surface pressure was unavailable; pressure-level rows are shown without a plotted surface parcel.");
  }
  const levels = [];
  if (isUsableSoundingLevel(surface)) {
    levels.push(surface);
  }
  for (const level of selection.availableLevels || POINT_SOUNDING_PROFILE_LEVELS) {
    const profileLevel = buildPointSoundingPressureLevel(values, level, surface.press);
    if (profileLevel) {
      levels.push(profileLevel);
    }
  }
  levels.sort((left, right) => Number(right.press) - Number(left.press));
  const dedupedLevels = dedupePointSoundingLevels(levels);
  if (dedupedLevels.length < 3) {
    warnings.push("Only a shallow profile was available at this point.");
  }
  const analysisRows = buildPointSoundingAnalysisRows(dedupedLevels);
  const parcelDiagnostics = buildPointSoundingParcelDiagnostics(analysisRows);

  return {
    schemaVersion: 1,
    source: "noaa-grib2-point",
    model: modelKey,
    modelLabel: modelConfig.label,
    run: formatNoaaRunId(date, cycle),
    referenceTime: referenceTimeIsoFromNoaaRun(date, cycle),
    forecastHour: Math.round(Number(hour)),
    validTime: validTimeIsoFromNoaaRun(date, cycle, hour),
    lat: roundNullable(requestLat, 4),
    lon: roundNullable(requestLon, 4),
    sampleLat: roundNullable(sampled.sampleLat, 4),
    sampleLon: roundNullable(sampled.sampleLon, 4),
    selectedRecordCount,
    surface: buildPointSoundingSurfaceSummary(surface, direct),
    levels: dedupedLevels,
    parcelTrace: buildPointSoundingParcelTrace(analysisRows, parcelDiagnostics),
    indices: buildPointSoundingIndices(dedupedLevels, direct, analysisRows, parcelDiagnostics),
    warnings,
    renderProfile,
  };
}

function buildPointSoundingDirectDiagnostics(values, surface) {
  const surfaceHeightM = Number(surface?.hght);
  const mslpPa = pointSoundingValue(values, "PRMSL", "mean sea level");
  const lclMsl = pointSoundingValue(values, "HGT", "level of adiabatic condensation from sfc");
  const wetBulbZeroMsl = pointSoundingValue(values, "HGT", "lowest level of the wet bulb zero");
  const cloudCeilingMsl = pointSoundingValue(values, "HGT", "cloud ceiling");
  const direct = {
    mslpHpa: Number.isFinite(mslpPa) ? mslpPa / 100 : Number.NaN,
    pblHeightM: pointSoundingValue(values, "HPBL", "surface"),
    pwatMm: pointSoundingValueByLevelPattern(values, "PWAT", /entire atmosphere/i),
    cloudCeilingM:
      Number.isFinite(cloudCeilingMsl) && Number.isFinite(surfaceHeightM)
        ? Math.max(0, cloudCeilingMsl - surfaceHeightM)
        : cloudCeilingMsl,
    wetBulbZeroM: wetBulbZeroMsl,
    lclM:
      Number.isFinite(lclMsl) && Number.isFinite(surfaceHeightM) ? Math.max(0, lclMsl - surfaceHeightM) : Number.NaN,
    cape0to3kmJkg: pointSoundingValue(values, "CAPE", "3000-0 m above ground"),
    sbcapeJkg: pointSoundingValue(values, "CAPE", "surface"),
    sbcinJkg: pointSoundingValue(values, "CIN", "surface"),
    mlcapeJkg: pointSoundingValue(values, "CAPE", "90-0 mb above ground"),
    mlcinJkg: pointSoundingValue(values, "CIN", "90-0 mb above ground"),
    mucapeJkg: finiteOrNumber(
      pointSoundingValue(values, "CAPE", "255-0 mb above ground"),
      pointSoundingValue(values, "CAPE", "180-0 mb above ground"),
    ),
    srh0to1kmM2S2: pointSoundingValue(values, "HLCY", "1000-0 m above ground"),
    srh0to3kmM2S2: pointSoundingValue(values, "HLCY", "3000-0 m above ground"),
    updraftHelicity2to5kmM2S2: pointSoundingValue(values, "MXUPHL", "5000-2000 m above ground"),
    maxHailSizeIn: pointSoundingValueByLevelPattern(values, "HAIL", /entire atmosphere/i) * M_TO_IN,
  };
  return direct;
}

function buildPointSoundingSurfaceSummary(surface, direct) {
  return {
    pressureHpa: roundNullable(surface?.press, 1),
    heightM: roundNullable(surface?.hght, 0),
    temperatureC: roundNullable(surface?.temp, 1),
    dewpointC: roundNullable(surface?.dwpt, 1),
    rhPct: roundNullable(surface?.rh, 0),
    windDirDeg: roundNullable(surface?.wdir, 0),
    windSpeedKt: roundNullable(surface?.wspd, 1),
    mslpHpa: roundNullable(direct?.mslpHpa, 1),
  };
}

function buildPointSoundingSurface(values) {
  const tempC = kelvinToCelsius(pointSoundingValue(values, "TMP", "2 m above ground"));
  const rhPct = pointSoundingValue(values, "RH", "2 m above ground");
  const dptC = finiteOrNumber(
    kelvinToCelsius(pointSoundingValue(values, "DPT", "2 m above ground")),
    dewpointCFromTemperatureRh(tempC, rhPct),
  );
  const wind = windComponentsToMeteorological(
    pointSoundingValue(values, "UGRD", "10 m above ground"),
    pointSoundingValue(values, "VGRD", "10 m above ground"),
  );
  const pressurePa = pointSoundingValue(values, "PRES", "surface");
  return normalizePointSoundingLevel({
    source: "surface",
    press: Number.isFinite(pressurePa) ? pressurePa / 100 : Number.NaN,
    hght: pointSoundingValue(values, "HGT", "surface"),
    temp: tempC,
    dwpt: dptC,
    rh: rhPct,
    ...wind,
  });
}

function buildPointSoundingPressureLevel(values, pressureHpa, surfacePressureHpa) {
  const pressure = Math.round(Number(pressureHpa));
  if (!Number.isFinite(pressure) || pressure <= 0) {
    return null;
  }
  if (Number.isFinite(surfacePressureHpa) && pressure > surfacePressureHpa + 1) {
    return null;
  }
  if (Number.isFinite(surfacePressureHpa) && Math.abs(pressure - surfacePressureHpa) < 2) {
    return null;
  }
  const levelName = `${pressure} mb`;
  const tempC = kelvinToCelsius(pointSoundingValue(values, "TMP", levelName));
  const rhPct = pointSoundingValue(values, "RH", levelName);
  const dptC = finiteOrNumber(
    kelvinToCelsius(pointSoundingValue(values, "DPT", levelName)),
    dewpointCFromTemperatureRh(tempC, rhPct),
  );
  const wind = windComponentsToMeteorological(
    pointSoundingValue(values, "UGRD", levelName),
    pointSoundingValue(values, "VGRD", levelName),
  );
  const level = normalizePointSoundingLevel({
    source: "pressure",
    press: pressure,
    hght: pointSoundingValue(values, "HGT", levelName),
    temp: tempC,
    dwpt: dptC,
    rh: rhPct,
    ...wind,
  });
  return isUsableSoundingLevel(level) ? level : null;
}

function normalizePointSoundingLevel(level) {
  return {
    source: level.source || "pressure",
    press: roundNullable(level.press, 1),
    hght: roundNullable(level.hght, 1),
    temp: roundNullable(level.temp, 1),
    dwpt: roundNullable(level.dwpt, 1),
    rh: roundNullable(level.rh, 0),
    wdir: roundNullable(level.wdir, 0),
    wspd: roundNullable(level.wspd, 1),
    uKt: roundNullable(level.uKt, 1),
    vKt: roundNullable(level.vKt, 1),
  };
}

function isUsableSoundingLevel(level) {
  return Number.isFinite(level?.press) && Number.isFinite(level?.temp) && Number.isFinite(level?.hght);
}

function dedupePointSoundingLevels(levels) {
  const out = [];
  const seen = new Set();
  for (const level of levels) {
    const key = `${Math.round(Number(level.press) * 10)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(level);
  }
  return out;
}

function buildPointSoundingIndices(levels, direct = {}, analysisRows = null, precomputedParcelDiagnostics = null) {
  const usable = (Array.isArray(levels) ? levels : [])
    .filter((level) => Number.isFinite(level.hght))
    .sort((left, right) => Number(left.hght) - Number(right.hght));
  const surface = usable.find((level) => level.source === "surface") || null;
  const freezingLevelM = interpolateHeightForTemperature(usable, 0);
  const minus10CHeightM = interpolateHeightForTemperature(usable, -10);
  const minus20CHeightM = interpolateHeightForTemperature(usable, -20);
  const minus30CHeightM = interpolateHeightForTemperature(usable, -30);
  const wetBulbZeroM = finiteOrNumber(direct?.wetBulbZeroM, interpolateHeightForWetBulbZero(usable));
  const temp700 = interpolateProfileValueByPressure(levels, 700, "temp");
  const temp500 = interpolateProfileValueByPressure(levels, 500, "temp");
  const temp850 = interpolateProfileValueByPressure(levels, 850, "temp");
  const temp3km = surface ? interpolateProfileValueByHeight(usable, Number(surface.hght) + 3000, "temp") : Number.NaN;
  const temp6km = surface ? interpolateProfileValueByHeight(usable, Number(surface.hght) + 6000, "temp") : Number.NaN;
  const dewpoint850 = interpolateProfileValueByPressure(levels, 850, "dwpt");
  const dewpoint700 = interpolateProfileValueByPressure(levels, 700, "dwpt");
  const hgt700 = interpolateProfileValueByPressure(levels, 700, "hght");
  const hgt500 = interpolateProfileValueByPressure(levels, 500, "hght");
  const hgt850 = interpolateProfileValueByPressure(levels, 850, "hght");
  const tv700 = virtualTemperatureCAtPressure(levels, 700);
  const tv500 = virtualTemperatureCAtPressure(levels, 500);
  const tv850 = virtualTemperatureCAtPressure(levels, 850);
  const tvSurface = surface
    ? virtualTemperatureC(Number(surface.temp), Number(surface.dwpt), Number(surface.press))
    : Number.NaN;
  const tv3km = surface ? virtualTemperatureCAtHeight(usable, Number(surface.hght) + 3000) : Number.NaN;
  const tv6km = surface ? virtualTemperatureCAtHeight(usable, Number(surface.hght) + 6000) : Number.NaN;
  const lapse700to500 =
    Number.isFinite(temp700) && Number.isFinite(temp500) && Number.isFinite(hgt700) && Number.isFinite(hgt500)
      ? ((temp700 - temp500) / Math.max(1, hgt500 - hgt700)) * 1000
      : Number.NaN;
  const lapse850to500 =
    Number.isFinite(temp850) && Number.isFinite(temp500) && Number.isFinite(hgt850) && Number.isFinite(hgt500)
      ? ((temp850 - temp500) / Math.max(1, hgt500 - hgt850)) * 1000
      : Number.NaN;
  const lapse0to3km =
    surface && Number.isFinite(temp3km) ? ((Number(surface.temp) - temp3km) / 3000) * 1000 : Number.NaN;
  const lapse3to6km =
    Number.isFinite(temp3km) && Number.isFinite(temp6km) ? ((temp3km - temp6km) / 3000) * 1000 : Number.NaN;
  const lapse700to500Tv =
    Number.isFinite(tv700) && Number.isFinite(tv500) && Number.isFinite(hgt700) && Number.isFinite(hgt500)
      ? ((tv700 - tv500) / Math.max(1, hgt500 - hgt700)) * 1000
      : Number.NaN;
  const lapse850to500Tv =
    Number.isFinite(tv850) && Number.isFinite(tv500) && Number.isFinite(hgt850) && Number.isFinite(hgt500)
      ? ((tv850 - tv500) / Math.max(1, hgt500 - hgt850)) * 1000
      : Number.NaN;
  const lapse0to3kmTv =
    Number.isFinite(tvSurface) && Number.isFinite(tv3km) ? ((tvSurface - tv3km) / 3000) * 1000 : Number.NaN;
  const lapse3to6kmTv = Number.isFinite(tv3km) && Number.isFinite(tv6km) ? ((tv3km - tv6km) / 3000) * 1000 : Number.NaN;
  const shear0to1km = pointSoundingLayerShearKt(usable, surface, 1000);
  const shear0to3km = pointSoundingLayerShearKt(usable, surface, 3000);
  const shear0to6km = pointSoundingLayerShearKt(usable, surface, 6000);
  const shear0to8km = pointSoundingLayerShearKt(usable, surface, 8000);
  const shearSurfaceTo500 = pointSoundingPressureShearKt(usable, surface, 500);
  const maxWind = usable.reduce(
    (max, level) => (Number.isFinite(level.wspd) && Number(level.wspd) > max ? Number(level.wspd) : max),
    Number.NEGATIVE_INFINITY,
  );
  const kIndex =
    Number.isFinite(temp850) &&
    Number.isFinite(temp700) &&
    Number.isFinite(temp500) &&
    Number.isFinite(dewpoint850) &&
    Number.isFinite(dewpoint700)
      ? temp850 - temp500 + dewpoint850 - (temp700 - dewpoint700)
      : Number.NaN;
  const totalTotals =
    Number.isFinite(temp850) && Number.isFinite(dewpoint850) && Number.isFinite(temp500)
      ? temp850 + dewpoint850 - 2 * temp500
      : Number.NaN;
  const verticalTotals = Number.isFinite(temp850) && Number.isFinite(temp500) ? temp850 - temp500 : Number.NaN;
  const crossTotals = Number.isFinite(dewpoint850) && Number.isFinite(temp500) ? dewpoint850 - temp500 : Number.NaN;
  const rows = Array.isArray(analysisRows) ? analysisRows : buildPointSoundingAnalysisRows(usable);
  const parcelDiagnostics = precomputedParcelDiagnostics || buildPointSoundingParcelDiagnostics(rows);
  const lclM = finiteOrNumber(parcelDiagnostics.surfaceLclM, direct?.lclM);
  const sbcapeJkg = finiteOrNumber(parcelDiagnostics.surfaceCapeJkg, direct?.sbcapeJkg);
  const sbcinJkg = finiteOrNumber(parcelDiagnostics.surfaceCinJkg, direct?.sbcinJkg);
  const mlcapeJkg = finiteOrNumber(parcelDiagnostics.mixedLayerCapeJkg, direct?.mlcapeJkg);
  const mlcinJkg = finiteOrNumber(parcelDiagnostics.mixedLayerCinJkg, direct?.mlcinJkg);
  const mucapeJkg = finiteOrNumber(parcelDiagnostics.mostUnstableCapeJkg, direct?.mucapeJkg);
  const mucinJkg = parcelDiagnostics.mostUnstableCinJkg;
  const stormDiagnostics = buildPointSoundingStormDiagnostics(rows, direct, {
    surface,
    sbcapeJkg,
    sbcinJkg,
    mucapeJkg,
    mlcapeJkg,
    mlcinJkg,
    lclM,
  });
  const liftedIndexC = calculateLiftedIndexC(rows, 0);
  const showalterIndexC = calculateShowalterIndexC(rows);
  const calculatedPwatMm = calculatePrecipitableWaterMm(usable);
  const dcapeJkg = calculatePointDcapeJkg(usable);
  const srh0to1km = finiteOrNumber(stormDiagnostics.srh0to1kmM2S2, direct?.srh0to1kmM2S2);
  const srh0to3km = finiteOrNumber(stormDiagnostics.srh0to3kmM2S2, direct?.srh0to3kmM2S2);
  const ehi0to1 =
    Number.isFinite(sbcapeJkg) && Number.isFinite(srh0to1km) ? (sbcapeJkg * srh0to1km) / 160000 : Number.NaN;
  const ehi0to3 =
    Number.isFinite(sbcapeJkg) && Number.isFinite(srh0to3km) ? (sbcapeJkg * srh0to3km) / 160000 : Number.NaN;
  const fixedStp = calculatePointFixedStp({
    sbcapeJkg,
    lclM,
    srh0to1kmM2S2: srh0to1km,
    shear0to6kmKt: shear0to6km,
  });
  const scpProxy = calculatePointScp({
    mucapeJkg,
    srh0to3kmM2S2: srh0to3km,
    effectiveBulkShearKt: shear0to6km,
    mucinJkg: Number.NaN,
  });
  const scpEffective = calculatePointScp({
    mucapeJkg,
    srh0to3kmM2S2: stormDiagnostics.effectiveSrhM2S2,
    effectiveBulkShearKt: stormDiagnostics.effectiveBulkShearKt,
    mucinJkg: finiteOrNumber(stormDiagnostics.muCinJkg, mucinJkg),
  });
  const effectiveStp = calculatePointEffectiveStp({
    mlcapeJkg,
    mlcinJkg,
    mixedLayerLclM: stormDiagnostics.mixedLayerLclM,
    effectiveSrhM2S2: stormDiagnostics.effectiveSrhM2S2,
    effectiveBulkShearKt: stormDiagnostics.effectiveBulkShearKt,
    effectiveBaseM: stormDiagnostics.effectiveBaseM,
  });
  const surfaceThetaE =
    surface && Number.isFinite(surface.temp) && Number.isFinite(surface.dwpt) && Number.isFinite(surface.press)
      ? boltonThetaE(Number(surface.temp) + 273.15, Number(surface.dwpt) + 273.15, Number(surface.press))
      : Number.NaN;
  return {
    surfacePressureHpa: roundNullable(surface?.press, 1),
    surfaceHeightM: roundNullable(surface?.hght, 0),
    surfaceTempC: roundNullable(surface?.temp, 1),
    surfaceDewpointC: roundNullable(surface?.dwpt, 1),
    surfaceRhPct: roundNullable(surface?.rh, 0),
    surfaceWindDirDeg: roundNullable(surface?.wdir, 0),
    surfaceWindKt: roundNullable(surface?.wspd, 1),
    mslpHpa: roundNullable(direct?.mslpHpa, 1),
    pblHeightM: roundNullable(direct?.pblHeightM, 0),
    cloudCeilingM: roundNullable(direct?.cloudCeilingM, 0),
    surfaceThetaEK: roundNullable(surfaceThetaE, 1),
    pwatMm: roundNullable(finiteOrNumber(direct?.pwatMm, calculatedPwatMm), 1),
    lclM: roundNullable(lclM, 0),
    mixedLayerLclM: roundNullable(finiteOrNumber(stormDiagnostics.mixedLayerLclM, parcelDiagnostics.mixedLayerLclM), 0),
    mixedLayerLiftedIndexC: roundNullable(parcelDiagnostics.mixedLayerLiftedIndexC, 1),
    mixedLayerLfcM: roundNullable(parcelDiagnostics.mixedLayerLfcM, 0),
    mixedLayerElM: roundNullable(parcelDiagnostics.mixedLayerElM, 0),
    lfcM: roundNullable(parcelDiagnostics.surfaceLfcM, 0),
    elM: roundNullable(parcelDiagnostics.surfaceElM, 0),
    temp0CHeightM: roundNullable(freezingLevelM, 0),
    temp0CHeightFt: roundNullable(freezingLevelM * M_TO_FT, 0),
    tempMinus10CHeightM: roundNullable(minus10CHeightM, 0),
    tempMinus10CHeightFt: roundNullable(minus10CHeightM * M_TO_FT, 0),
    tempMinus20CHeightM: roundNullable(minus20CHeightM, 0),
    tempMinus20CHeightFt: roundNullable(minus20CHeightM * M_TO_FT, 0),
    tempMinus30CHeightM: roundNullable(minus30CHeightM, 0),
    tempMinus30CHeightFt: roundNullable(minus30CHeightM * M_TO_FT, 0),
    freezingLevelM: roundNullable(freezingLevelM, 0),
    wetBulbZeroM: roundNullable(wetBulbZeroM, 0),
    lapseRate700to500CPerKm: roundNullable(lapse700to500, 1),
    lapseRate850to500CPerKm: roundNullable(lapse850to500, 1),
    lapseRate0to3kmCPerKm: roundNullable(lapse0to3km, 1),
    lapseRate3to6kmCPerKm: roundNullable(lapse3to6km, 1),
    virtualLapseRate700to500CPerKm: roundNullable(lapse700to500Tv, 1),
    virtualLapseRate850to500CPerKm: roundNullable(lapse850to500Tv, 1),
    virtualLapseRate0to3kmCPerKm: roundNullable(lapse0to3kmTv, 1),
    virtualLapseRate3to6kmCPerKm: roundNullable(lapse3to6kmTv, 1),
    kIndexC: roundNullable(kIndex, 1),
    totalTotalsC: roundNullable(totalTotals, 1),
    verticalTotalsC: roundNullable(verticalTotals, 1),
    crossTotalsC: roundNullable(crossTotals, 1),
    liftedIndexC: roundNullable(liftedIndexC, 1),
    showalterIndexC: roundNullable(showalterIndexC, 1),
    cape0to3kmJkg: roundNullable(direct?.cape0to3kmJkg, 0),
    sbcapeJkg: roundNullable(sbcapeJkg, 0),
    sbcinJkg: roundNullable(sbcinJkg, 0),
    mlcapeJkg: roundNullable(mlcapeJkg, 0),
    mlcinJkg: roundNullable(mlcinJkg, 0),
    mucapeJkg: roundNullable(mucapeJkg, 0),
    mucinJkg: roundNullable(mucinJkg, 0),
    mostUnstableLclM: roundNullable(parcelDiagnostics.mostUnstableLclM, 0),
    mostUnstableLiftedIndexC: roundNullable(parcelDiagnostics.mostUnstableLiftedIndexC, 1),
    mostUnstableLfcM: roundNullable(parcelDiagnostics.mostUnstableLfcM, 0),
    mostUnstableElM: roundNullable(parcelDiagnostics.mostUnstableElM, 0),
    dcapeJkg: roundNullable(dcapeJkg, 0),
    shear0to1kmKt: roundNullable(shear0to1km, 0),
    shear0to3kmKt: roundNullable(shear0to3km, 0),
    shear0to6kmKt: roundNullable(shear0to6km, 0),
    shear0to8kmKt: roundNullable(shear0to8km, 0),
    shearSurfaceTo500mbKt: roundNullable(shearSurfaceTo500, 0),
    srh0to1kmM2S2: roundNullable(srh0to1km, 0),
    srh0to3kmM2S2: roundNullable(srh0to3km, 0),
    profileSrh0to1kmM2S2: roundNullable(stormDiagnostics.srh0to1kmM2S2, 0),
    profileSrh0to3kmM2S2: roundNullable(stormDiagnostics.srh0to3kmM2S2, 0),
    modelSrh0to1kmM2S2: roundNullable(direct?.srh0to1kmM2S2, 0),
    modelSrh0to3kmM2S2: roundNullable(direct?.srh0to3kmM2S2, 0),
    effectiveSrhM2S2: roundNullable(stormDiagnostics.effectiveSrhM2S2, 0),
    effectiveBulkShearKt: roundNullable(stormDiagnostics.effectiveBulkShearKt, 0),
    effectiveBaseM: roundNullable(stormDiagnostics.effectiveBaseM, 0),
    effectiveTopM: roundNullable(stormDiagnostics.effectiveTopM, 0),
    effectiveLayerMuCapeJkg: roundNullable(stormDiagnostics.muCapeJkg, 0),
    effectiveLayerMuCinJkg: roundNullable(stormDiagnostics.muCinJkg, 0),
    meanWind0to6kmDirDeg: roundNullable(stormDiagnostics.meanWind0to6kmDirDeg, 0),
    meanWind0to6kmKt: roundNullable(stormDiagnostics.meanWind0to6kmKt, 0),
    bunkersRightDirDeg: roundNullable(stormDiagnostics.bunkersRightDirDeg, 0),
    bunkersRightKt: roundNullable(stormDiagnostics.bunkersRightKt, 0),
    bunkersLeftDirDeg: roundNullable(stormDiagnostics.bunkersLeftDirDeg, 0),
    bunkersLeftKt: roundNullable(stormDiagnostics.bunkersLeftKt, 0),
    bunkersMethod: stormDiagnostics.bunkersMethod || null,
    corfidiUpshearDirDeg: roundNullable(stormDiagnostics.corfidiUpshearDirDeg, 0),
    corfidiUpshearKt: roundNullable(stormDiagnostics.corfidiUpshearKt, 0),
    corfidiDownshearDirDeg: roundNullable(stormDiagnostics.corfidiDownshearDirDeg, 0),
    corfidiDownshearKt: roundNullable(stormDiagnostics.corfidiDownshearKt, 0),
    stormRelativeWind0to2kmKt: roundNullable(stormDiagnostics.stormRelativeWind0to2kmKt, 0),
    stormRelativeWind4to6kmKt: roundNullable(stormDiagnostics.stormRelativeWind4to6kmKt, 0),
    ehi0to1km: roundNullable(ehi0to1, 2),
    ehi0to3km: roundNullable(ehi0to3, 2),
    supercellComposite: roundNullable(scpProxy, 1),
    supercellCompositeProxy: roundNullable(scpProxy, 1),
    supercellCompositeEffective: roundNullable(scpEffective, 1),
    significantTornadoFixed: roundNullable(fixedStp, 1),
    significantTornadoEffective: roundNullable(effectiveStp, 1),
    updraftHelicity2to5kmM2S2: roundNullable(direct?.updraftHelicity2to5kmM2S2, 0),
    maxHailSizeIn: roundNullable(direct?.maxHailSizeIn, 2),
    maxWindKt: roundNullable(Number.isFinite(maxWind) ? maxWind : Number.NaN, 0),
  };
}

function buildPointSoundingParcelTrace(rows, parcelDiagnostics = null) {
  const usable = (Array.isArray(rows) ? rows : [])
    .filter(
      (row) =>
        Number.isFinite(row.pressureHpa) &&
        Number.isFinite(row.heightAglM) &&
        Number.isFinite(row.tempK) &&
        Number.isFinite(row.dewpointK),
    )
    .sort((left, right) => Number(left.heightAglM) - Number(right.heightAglM));
  if (usable.length < 3) {
    return null;
  }
  const diagnostics = parcelDiagnostics || buildPointSoundingParcelDiagnostics(usable);
  const selected = selectPointSoundingParcelTraceSource(usable, diagnostics);
  if (!selected?.row) {
    return null;
  }
  const source = selected.row;
  const scratch = createPointSoundingScratch(usable.length);
  const rowCount = fillPointSoundingScratch(usable, scratch);
  prepareEffectiveParcelSegments(scratch, rowCount);
  const parcelResult = selected.parcel || calculatePressureStepParcelCapeCinForSource(scratch, rowCount, source);
  const liftedIndexC = calculateLiftedIndexForPointSoundingSource(usable, source);
  const levels = [];
  if (Number.isFinite(source.pressureHpa) && Number.isFinite(source.tempK)) {
    levels.push({
      press: roundNullable(source.pressureHpa, 1),
      temp: roundNullable(kelvinToCelsius(source.tempK), 1),
    });
  }
  for (const row of usable) {
    if (
      Number(row.pressureHpa) > Number(source.pressureHpa) + 1 ||
      Number(row.heightAglM) < Number(source.heightAglM) - 1
    ) {
      continue;
    }
    const parcelTempK = calculateParcelTemperatureAtPressureK(source, row.pressureHpa, row.heightAglM);
    if (!Number.isFinite(parcelTempK)) {
      continue;
    }
    if (levels.some((level) => Math.abs(Number(level.press) - Number(row.pressureHpa)) < 0.6)) {
      continue;
    }
    levels.push({
      press: roundNullable(row.pressureHpa, 1),
      temp: roundNullable(kelvinToCelsius(parcelTempK), 1),
    });
  }
  if (levels.length < 2) {
    return null;
  }
  return {
    type: selected.type,
    label: `${selected.type} Parcel`,
    sourcePressureHpa: roundNullable(source.pressureHpa, 1),
    sourceHeightM: roundNullable(source.heightAglM, 0),
    sourceTemperatureC: roundNullable(kelvinToCelsius(source.tempK), 1),
    sourceDewpointC: roundNullable(kelvinToCelsius(source.dewpointK), 1),
    capeJkg: roundNullable(parcelResult?.capeJkg, 0),
    cinJkg: roundNullable(parcelResult?.cinJkg, 0),
    lclM: roundNullable(parcelResult?.lclAglM, 0),
    lfcM: roundNullable(parcelResult?.lfcAglM, 0),
    elM: roundNullable(parcelResult?.elAglM, 0),
    liftedIndexC: roundNullable(liftedIndexC, 1),
    levels,
  };
}

function selectPointSoundingParcelTraceSource(rows, diagnostics = {}) {
  const surface = rows?.[0];
  if (!surface) {
    return null;
  }
  const sbcape = Number(diagnostics?.surfaceCapeJkg);
  const mlcape = Number(diagnostics?.mixedLayerCapeJkg);
  const mucape = Number(diagnostics?.mostUnstableCapeJkg);
  const sfcScore = Number.isFinite(sbcape) ? sbcape : Number.NEGATIVE_INFINITY;
  const mlScore = Number.isFinite(mlcape) ? mlcape : Number.NEGATIVE_INFINITY;
  const muScore = Number.isFinite(mucape) ? mucape : Number.NEGATIVE_INFINITY;
  if (muScore > Math.max(sfcScore, mlScore, 0) + 100) {
    const source = diagnostics?.mostUnstableSource || findMostUnstablePointSoundingRow(rows);
    if (source) {
      return { type: "MU", row: source, parcel: diagnostics?.mostUnstableParcel || null };
    }
  }
  if (mlScore > Math.max(sfcScore, 0) + 100) {
    const source = diagnostics?.mixedLayerSource || buildMixedLayerPointSoundingSourceRow(rows);
    if (source) {
      return { type: "ML", row: source, parcel: diagnostics?.mixedLayerParcel || null };
    }
  }
  return { type: "SFC", row: surface, parcel: diagnostics?.surfaceParcel || null };
}

function findMostUnstablePointSoundingRow(rows) {
  const scratch = createPointSoundingScratch(Array.isArray(rows) ? rows.length : 0);
  const rowCount = fillPointSoundingScratch(rows, scratch);
  return findMostUnstablePointSoundingSourceFromScratch(scratch, rowCount);
}

function findMostUnstablePointSoundingSourceFromScratch(scratch, rowCount) {
  const surfacePressure = Number(scratch?.pressure?.[0]);
  if (!Number.isFinite(surfacePressure) || rowCount < 2) {
    return null;
  }
  const pressureFloor = Math.max(findTopPressureHpaForScratch(scratch, rowCount), surfacePressure - 300);
  let best = null;
  let bestThetaE = Number.NEGATIVE_INFINITY;
  for (let pressure = surfacePressure; pressure >= pressureFloor; pressure -= PARCEL_INTEGRATION_STEP_HPA) {
    const sample = interpolateProfileThermoAtPressureRows(scratch, rowCount, pressure);
    if (!sample || Number(sample.heightAglM) > EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M) {
      continue;
    }
    const thetaE = boltonThetaE(sample.tempK, sample.dewpointK, pressure);
    if (Number.isFinite(thetaE) && thetaE > bestThetaE) {
      bestThetaE = thetaE;
      best = {
        source: "mostUnstable",
        pressureHpa: pressure,
        heightAglM: sample.heightAglM,
        heightMslM: Number.NaN,
        tempK: sample.tempK,
        dewpointK: sample.dewpointK,
      };
    }
  }
  return best;
}

function buildMixedLayerPointSoundingSourceRow(rows) {
  const surface = rows?.[0];
  if (!surface) {
    return null;
  }
  const scratch = createPointSoundingScratch(rows.length);
  const rowCount = fillPointSoundingScratch(rows, scratch);
  const source = buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount);
  if (!source) {
    return null;
  }
  return {
    ...source,
    source: "mixedLayer",
    heightMslM: surface.heightMslM,
    uMps: surface.uMps,
    vMps: surface.vMps,
  };
}

function buildPointSoundingAnalysisRows(levels) {
  const usable = (Array.isArray(levels) ? levels : [])
    .filter((level) => Number.isFinite(level.hght) && Number.isFinite(level.press))
    .sort((left, right) => Number(left.hght) - Number(right.hght));
  const surface = usable.find((level) => level.source === "surface") || null;
  const surfaceHeight = Number(surface?.hght);
  if (!surface || !Number.isFinite(surfaceHeight)) {
    return [];
  }
  return usable
    .map((level) => {
      const tempC = finiteOptionalNumber(level.temp);
      const dewpointC = finiteOptionalNumber(level.dwpt);
      const uKt = finiteOptionalNumber(level.uKt);
      const vKt = finiteOptionalNumber(level.vKt);
      const heightAglM = Number(level.hght) - (Number.isFinite(surfaceHeight) ? surfaceHeight : 0);
      return {
        source: level.source || "pressure",
        pressureHpa: Number(level.press),
        heightAglM: level.source === "surface" ? 0 : Math.max(0, heightAglM),
        heightMslM: Number(level.hght),
        tempK: Number.isFinite(tempC) ? tempC + 273.15 : Number.NaN,
        dewpointK: Number.isFinite(dewpointC) ? dewpointC + 273.15 : Number.NaN,
        uMps: Number.isFinite(uKt) ? uKt / MPS_TO_KT : Number.NaN,
        vMps: Number.isFinite(vKt) ? vKt / MPS_TO_KT : Number.NaN,
      };
    })
    .filter(
      (row) =>
        Number.isFinite(row.pressureHpa) &&
        Number.isFinite(row.heightAglM) &&
        Number.isFinite(row.tempK) &&
        Number.isFinite(row.dewpointK),
    )
    .sort((left, right) => left.heightAglM - right.heightAglM);
}

function createPointSoundingScratch(rowCount) {
  const size = Math.max(4, Number(rowCount) || 0);
  return {
    heights: new Float64Array(size),
    u: new Float64Array(size),
    v: new Float64Array(size),
    pressure: new Float64Array(size),
    temp: new Float64Array(size),
    dewpoint: new Float64Array(size),
    segmentValid: new Uint8Array(size),
    segmentDz: new Float64Array(size),
    segmentMidHeight: new Float64Array(size),
    segmentMidPressure: new Float64Array(size),
    segmentEnvVirtualTemp: new Float64Array(size),
  };
}

function fillPointSoundingScratch(rows, scratch) {
  let rowCount = 0;
  for (const row of rows || []) {
    if (!Number.isFinite(row.heightAglM) || !Number.isFinite(row.pressureHpa)) {
      continue;
    }
    scratch.heights[rowCount] = row.heightAglM;
    scratch.pressure[rowCount] = row.pressureHpa;
    scratch.temp[rowCount] = row.tempK;
    scratch.dewpoint[rowCount] = row.dewpointK;
    scratch.u[rowCount] = row.uMps;
    scratch.v[rowCount] = row.vMps;
    rowCount += 1;
  }
  sortEffectiveDiagnosticsRowsByHeight(scratch, rowCount);
  return rowCount;
}

function buildPointSoundingParcelDiagnostics(rows) {
  const scratch = createPointSoundingScratch(rows.length);
  const rowCount = fillPointSoundingScratch(rows, scratch);
  const out = {
    surfaceCapeJkg: Number.NaN,
    surfaceCinJkg: Number.NaN,
    surfaceLclM: Number.NaN,
    surfaceLfcM: Number.NaN,
    surfaceElM: Number.NaN,
    mixedLayerCapeJkg: Number.NaN,
    mixedLayerCinJkg: Number.NaN,
    mixedLayerLclM: Number.NaN,
    mixedLayerLfcM: Number.NaN,
    mixedLayerElM: Number.NaN,
    mixedLayerLiftedIndexC: Number.NaN,
    mostUnstableCapeJkg: Number.NaN,
    mostUnstableCinJkg: Number.NaN,
    mostUnstableLclM: Number.NaN,
    mostUnstableLfcM: Number.NaN,
    mostUnstableElM: Number.NaN,
    mostUnstableLiftedIndexC: Number.NaN,
    surfaceParcel: null,
    mixedLayerParcel: null,
    mixedLayerSource: null,
    mostUnstableParcel: null,
    mostUnstableSource: null,
  };
  if (rowCount < 3) {
    return out;
  }
  prepareEffectiveParcelSegments(scratch, rowCount);
  out.surfaceLclM = calculateParcelLclAglM({
    pressureHpa: scratch.pressure[0],
    heightAglM: scratch.heights[0],
    tempK: scratch.temp[0],
    dewpointK: scratch.dewpoint[0],
  });
  const surfaceParcel = calculateParcelCapeCinFromRows(scratch, rowCount, 0, { pressureStep: true });
  if (surfaceParcel) {
    out.surfaceParcel = surfaceParcel;
    out.surfaceCapeJkg = surfaceParcel.capeJkg;
    out.surfaceCinJkg = surfaceParcel.cinJkg;
    out.surfaceLclM = finiteOrNumber(surfaceParcel.lclAglM, out.surfaceLclM);
    out.surfaceLfcM = surfaceParcel.lfcAglM;
    out.surfaceElM = surfaceParcel.elAglM;
  }
  const mixedLayerSource = buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount);
  const mixedLayerParcel = mixedLayerSource
    ? calculatePressureStepParcelCapeCinForSource(scratch, rowCount, mixedLayerSource)
    : null;
  if (mixedLayerSource && mixedLayerParcel) {
    out.mixedLayerSource = mixedLayerSource;
    out.mixedLayerParcel = mixedLayerParcel;
    out.mixedLayerCapeJkg = mixedLayerParcel.capeJkg;
    out.mixedLayerCinJkg = mixedLayerParcel.cinJkg;
    out.mixedLayerLclM = mixedLayerParcel.lclAglM;
    out.mixedLayerLfcM = mixedLayerParcel.lfcAglM;
    out.mixedLayerElM = mixedLayerParcel.elAglM;
    out.mixedLayerLiftedIndexC = calculateLiftedIndexForPointSoundingSource(rows, mixedLayerSource);
  }
  const mostUnstableSource = findMostUnstablePointSoundingSourceFromScratch(scratch, rowCount);
  const mostUnstableParcel = mostUnstableSource
    ? calculatePressureStepParcelCapeCinForSource(scratch, rowCount, mostUnstableSource)
    : null;
  if (mostUnstableSource && mostUnstableParcel) {
    out.mostUnstableSource = mostUnstableSource;
    out.mostUnstableParcel = mostUnstableParcel;
    out.mostUnstableCapeJkg = mostUnstableParcel.capeJkg;
    out.mostUnstableCinJkg = mostUnstableParcel.cinJkg;
    out.mostUnstableLclM = mostUnstableParcel.lclAglM;
    out.mostUnstableLfcM = mostUnstableParcel.lfcAglM;
    out.mostUnstableElM = mostUnstableParcel.elAglM;
    out.mostUnstableLiftedIndexC = calculateLiftedIndexForPointSoundingSource(rows, mostUnstableSource);
  }
  return out;
}

function buildPointSoundingStormDiagnostics(rows, direct = {}, options = {}) {
  const scratch = createPointSoundingScratch(rows.length);
  const rowCount = fillPointSoundingScratch(rows, scratch);
  const out = {};
  if (rowCount < 2) {
    return out;
  }
  prepareEffectiveParcelSegments(scratch, rowCount);
  const meanWind0to6km = calculatePointSoundingMeanWindInLayerFromRows(scratch, rowCount, 0, 6000);
  if (meanWind0to6km) {
    const mean = windComponentsToMeteorological(meanWind0to6km.u, meanWind0to6km.v);
    out.meanWind0to6kmDirDeg = mean.wdir;
    out.meanWind0to6kmKt = mean.wspd;
  }
  const corfidi = calculateCorfidiMcsMotionFromRows(scratch, rowCount);
  if (corfidi) {
    const upshear = windComponentsToMeteorological(corfidi.upshear.u, corfidi.upshear.v);
    const downshear = windComponentsToMeteorological(corfidi.downshear.u, corfidi.downshear.v);
    out.corfidiUpshearDirDeg = upshear.wdir;
    out.corfidiUpshearKt = upshear.wspd;
    out.corfidiDownshearDirDeg = downshear.wdir;
    out.corfidiDownshearKt = downshear.wspd;
  }
  const layer = calculateEffectiveParcelLayerFromRows(scratch, rowCount, { pressureStep: true });
  let activeBunkersRight = null;
  let activeBunkersLeft = null;
  let activeBunkersMethod = "";
  if (layer && Number.isFinite(layer.baseAglM) && Number.isFinite(layer.topAglM)) {
    out.effectiveBaseM = layer.baseAglM;
    out.effectiveTopM = layer.topAglM;
    out.muCapeJkg = layer.muCapeJkg;
    out.muCinJkg = layer.muCinJkg;
    const effectiveBunkers = calculateEffectiveLayerBunkersMotionFromRows(scratch, rowCount, layer);
    if (effectiveBunkers?.right && effectiveBunkers?.left) {
      activeBunkersRight = effectiveBunkers.right;
      activeBunkersLeft = effectiveBunkers.left;
      activeBunkersMethod = "effective";
    }
  }
  const fixedBunkers = calculateBunkersMotionFromRows(scratch, rowCount);
  if (fixedBunkers?.right && fixedBunkers?.left) {
    if (!activeBunkersRight || !activeBunkersLeft) {
      activeBunkersRight = fixedBunkers.right;
      activeBunkersLeft = fixedBunkers.left;
      activeBunkersMethod = "fixed-0-6km";
    }
  }
  if (activeBunkersRight) {
    const motion = windComponentsToMeteorological(activeBunkersRight.u, activeBunkersRight.v);
    out.bunkersRightDirDeg = motion.wdir;
    out.bunkersRightKt = motion.wspd;
    out.bunkersMethod = activeBunkersMethod;
    out.srh0to1kmM2S2 = calculateStormRelativeHelicityFromRows(scratch, rowCount, 0, 1000, activeBunkersRight);
    out.srh0to3kmM2S2 = calculateStormRelativeHelicityFromRows(scratch, rowCount, 0, 3000, activeBunkersRight);
    out.stormRelativeWind0to2kmKt = calculateStormRelativeMeanWindKt(scratch, rowCount, 0, 2000, activeBunkersRight);
    out.stormRelativeWind4to6kmKt = calculateStormRelativeMeanWindKt(scratch, rowCount, 4000, 6000, activeBunkersRight);
  }
  if (activeBunkersLeft) {
    const motion = windComponentsToMeteorological(activeBunkersLeft.u, activeBunkersLeft.v);
    out.bunkersLeftDirDeg = motion.wdir;
    out.bunkersLeftKt = motion.wspd;
  }
  if (layer && Number.isFinite(layer.baseAglM) && Number.isFinite(layer.topAglM)) {
    const windAtBase = interpolateProfileWindRows(scratch, rowCount, layer.baseAglM);
    const muElAglM = Number.isFinite(layer.muElAglM) ? layer.muElAglM : layer.topAglM;
    const ebwdTopAglM = Math.min(
      layer.baseAglM + EFFECTIVE_MAX_EBWD_LAYER_DEPTH_M,
      Math.max(
        layer.baseAglM + EFFECTIVE_MIN_EBWD_LAYER_DEPTH_M,
        layer.baseAglM + 0.5 * Math.max(0, muElAglM - layer.baseAglM),
      ),
    );
    const windAtEbwdTop = interpolateProfileWindRows(scratch, rowCount, ebwdTopAglM);
    if (windAtBase && windAtEbwdTop) {
      out.effectiveBulkShearKt = Math.hypot(windAtEbwdTop.u - windAtBase.u, windAtEbwdTop.v - windAtBase.v) * MPS_TO_KT;
    }
    if (activeBunkersRight) {
      out.effectiveSrhM2S2 = calculateStormRelativeHelicityFromRows(
        scratch,
        rowCount,
        layer.baseAglM,
        Math.max(layer.topAglM, layer.baseAglM + 1),
        activeBunkersRight,
      );
    }
  }
  out.mixedLayerLclM = calculatePointSoundingMixedLayerLclMFromRows(scratch, rowCount);
  if (
    !Number.isFinite(out.effectiveBaseM) &&
    Number.isFinite(options.sbcapeJkg) &&
    Number.isFinite(options.sbcinJkg) &&
    options.sbcapeJkg >= EFFECTIVE_INFLOW_MIN_CAPE_JKG &&
    options.sbcinJkg >= EFFECTIVE_INFLOW_MIN_CIN_JKG
  ) {
    out.effectiveBaseM = 0;
    out.effectiveTopM = Number.NaN;
  }
  return out;
}

function calculateEffectiveLayerBunkersMotionFromRows(scratch, rowCount, layer) {
  const baseAglM = Number(layer?.baseAglM);
  const muElAglM = Number(layer?.muElAglM);
  const muCapeJkg = Number(layer?.muCapeJkg);
  if (
    !Number.isFinite(baseAglM) ||
    !Number.isFinite(muElAglM) ||
    !Number.isFinite(muCapeJkg) ||
    muCapeJkg <= EFFECTIVE_INFLOW_MIN_CAPE_JKG ||
    muElAglM <= baseAglM + 500
  ) {
    return null;
  }
  const topAglM = baseAglM + (muElAglM - baseAglM) * 0.65;
  if (topAglM < 3000 || baseAglM > topAglM) {
    return null;
  }
  return calculateBunkersMotionFromRows(scratch, rowCount, {
    meanBottomAglM: baseAglM,
    meanTopAglM: topAglM,
    shearBottomAglM: baseAglM,
    shearTopAglM: topAglM,
    pressureWeightedMean: true,
  });
}

function calculateStormRelativeMeanWindKt(scratch, rowCount, bottomAglM, topAglM, stormMotion) {
  const meanWind = calculatePointSoundingMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM);
  if (!meanWind || !stormMotion) {
    return Number.NaN;
  }
  return Math.hypot(meanWind.u - stormMotion.u, meanWind.v - stormMotion.v) * MPS_TO_KT;
}

function pointSoundingLayerShearKt(levels, surface, topAglM) {
  if (!surface || !Number.isFinite(surface.hght) || !Number.isFinite(surface.uKt) || !Number.isFinite(surface.vKt)) {
    return Number.NaN;
  }
  const targetHeight = Number(surface.hght) + Number(topAglM);
  const uTop = interpolateProfileValueByHeight(levels, targetHeight, "uKt");
  const vTop = interpolateProfileValueByHeight(levels, targetHeight, "vKt");
  return Number.isFinite(uTop) && Number.isFinite(vTop)
    ? Math.hypot(uTop - Number(surface.uKt), vTop - Number(surface.vKt))
    : Number.NaN;
}

function pointSoundingPressureShearKt(levels, surface, pressureHpa) {
  if (!surface || !Number.isFinite(surface.uKt) || !Number.isFinite(surface.vKt)) {
    return Number.NaN;
  }
  const uTop = levelValueByPressure(levels, pressureHpa, "uKt");
  const vTop = levelValueByPressure(levels, pressureHpa, "vKt");
  return Number.isFinite(uTop) && Number.isFinite(vTop)
    ? Math.hypot(uTop - Number(surface.uKt), vTop - Number(surface.vKt))
    : Number.NaN;
}

function calculatePrecipitableWaterMm(levels) {
  const profile = (Array.isArray(levels) ? levels : [])
    .filter((level) => Number.isFinite(level.press) && Number.isFinite(level.dwpt))
    .sort((left, right) => Number(right.press) - Number(left.press));
  let total = 0;
  for (let index = 1; index < profile.length; index += 1) {
    const lower = profile[index - 1];
    const upper = profile[index];
    const qLower = specificHumidityFromDewpointC(Number(lower.dwpt), Number(lower.press));
    const qUpper = specificHumidityFromDewpointC(Number(upper.dwpt), Number(upper.press));
    const dpPa = Math.abs((Number(lower.press) - Number(upper.press)) * 100);
    if (!Number.isFinite(qLower) || !Number.isFinite(qUpper) || !Number.isFinite(dpPa)) {
      continue;
    }
    total += ((qLower + qUpper) / 2) * (dpPa / GRAVITY_M_S2);
  }
  return Number.isFinite(total) && total > 0 ? total : Number.NaN;
}

function specificHumidityFromDewpointC(dewpointC, pressureHpa) {
  const mixingRatio = mixingRatioFromDewpointK(Number(dewpointC) + 273.15, pressureHpa);
  return Number.isFinite(mixingRatio) ? mixingRatio / (1 + mixingRatio) : Number.NaN;
}

function interpolateHeightForWetBulbZero(levels) {
  const wetBulbLevels = (Array.isArray(levels) ? levels : [])
    .map((level) => ({
      hght: Number(level.hght),
      wetBulb: wetBulbTemperatureC(Number(level.temp) + 273.15, Number(level.dwpt) + 273.15),
    }))
    .filter((level) => Number.isFinite(level.hght) && Number.isFinite(level.wetBulb))
    .sort((left, right) => left.hght - right.hght);
  for (let index = 1; index < wetBulbLevels.length; index += 1) {
    const lower = wetBulbLevels[index - 1];
    const upper = wetBulbLevels[index];
    if ((lower.wetBulb >= 0 && upper.wetBulb <= 0) || (lower.wetBulb <= 0 && upper.wetBulb >= 0)) {
      const t = (0 - lower.wetBulb) / Math.max(1e-9, upper.wetBulb - lower.wetBulb);
      return lower.hght + (upper.hght - lower.hght) * clamp01(t);
    }
  }
  return Number.NaN;
}

function calculateLiftedIndexC(rows, sourceRow) {
  const env500 = pointSoundingRowAtPressure(rows, 500);
  const source = rows?.[sourceRow || 0];
  return calculateLiftedIndexForPointSoundingSource(rows, source, env500);
}

function calculateShowalterIndexC(rows) {
  const source850 = pointSoundingRowAtPressure(rows, 850);
  const env500 = pointSoundingRowAtPressure(rows, 500);
  const parcelTemp500K = calculateParcelTemperatureAtPressureK(source850, 500, env500?.heightAglM);
  return env500 && Number.isFinite(parcelTemp500K) ? env500.tempK - parcelTemp500K : Number.NaN;
}

function pointSoundingRowAtPressure(rows, pressureHpa) {
  const profile = (Array.isArray(rows) ? rows : [])
    .filter((row) => Number.isFinite(row.pressureHpa) && Number.isFinite(row.heightAglM))
    .sort((left, right) => Number(right.pressureHpa) - Number(left.pressureHpa));
  for (let index = 1; index < profile.length; index += 1) {
    const lower = profile[index - 1];
    const upper = profile[index];
    if (
      (lower.pressureHpa >= pressureHpa && upper.pressureHpa <= pressureHpa) ||
      (lower.pressureHpa <= pressureHpa && upper.pressureHpa >= pressureHpa)
    ) {
      const t = logPressureInterpolationFraction(pressureHpa, lower.pressureHpa, upper.pressureHpa);
      return {
        pressureHpa,
        heightAglM: lower.heightAglM + (upper.heightAglM - lower.heightAglM) * clamp01(t),
        tempK: lower.tempK + (upper.tempK - lower.tempK) * clamp01(t),
        dewpointK: lower.dewpointK + (upper.dewpointK - lower.dewpointK) * clamp01(t),
      };
    }
  }
  return null;
}

function calculateParcelTemperatureAtPressureK(source, targetPressureHpa, _targetHeightAglM) {
  if (
    !source ||
    !Number.isFinite(source.pressureHpa) ||
    !Number.isFinite(source.tempK) ||
    !Number.isFinite(source.dewpointK) ||
    !Number.isFinite(targetPressureHpa) ||
    targetPressureHpa <= 0 ||
    targetPressureHpa > source.pressureHpa + 1
  ) {
    return Number.NaN;
  }
  const sourceDewpointK = Math.min(source.dewpointK, source.tempK);
  const lclTempK = boltonLclTemperatureK(source.tempK, sourceDewpointK);
  if (!Number.isFinite(lclTempK)) {
    return Number.NaN;
  }
  const lclPressure = source.pressureHpa * Math.pow(lclTempK / source.tempK, CP_OVER_RD);
  if (!Number.isFinite(lclPressure)) {
    return Number.NaN;
  }
  if (targetPressureHpa >= lclPressure) {
    return source.tempK * Math.pow(targetPressureHpa / source.pressureHpa, RD_OVER_CP);
  }
  return moistLiftTemperatureK(lclPressure, lclTempK, targetPressureHpa);
}

function calculatePointDcapeJkg(levels) {
  const usable = (Array.isArray(levels) ? levels : [])
    .filter((level) => Number.isFinite(level.hght) && Number.isFinite(level.temp) && Number.isFinite(level.rh))
    .sort((left, right) => Number(left.hght) - Number(right.hght));
  const surface = usable.find((level) => level.source === "surface") || null;
  if (!surface || usable.length < 3) {
    return Number.NaN;
  }
  let source = null;
  let sourceThetaE = Number.POSITIVE_INFINITY;
  for (const level of usable) {
    const pressure = Number(level.press);
    if (!Number.isFinite(pressure) || pressure < 500 || pressure > 800 || Number(level.hght) <= Number(surface.hght)) {
      continue;
    }
    const tempK = Number(level.temp) + 273.15;
    const dewpointK = Number(level.dwpt) + 273.15;
    const wetBulbK = wetBulbTemperatureC(tempK, dewpointK) + 273.15;
    const thetaE = boltonThetaE(tempK, dewpointK, pressure);
    if (!Number.isFinite(wetBulbK) || !Number.isFinite(thetaE) || thetaE >= sourceThetaE) {
      continue;
    }
    sourceThetaE = thetaE;
    source = { heightM: Number(level.hght), wetBulbK };
  }
  if (!source) {
    return Number.NaN;
  }
  let energy = 0;
  for (let index = 1; index < usable.length; index += 1) {
    const lower = usable[index - 1];
    const upper = usable[index];
    if (
      Number(lower.hght) < Number(surface.hght) ||
      Number(upper.hght) > source.heightM ||
      Number(upper.hght) <= Number(surface.hght)
    ) {
      continue;
    }
    const dz = Number(upper.hght) - Number(lower.hght);
    const midHeight = (Number(upper.hght) + Number(lower.hght)) / 2;
    const envTempK = (Number(upper.temp) + 273.15 + (Number(lower.temp) + 273.15)) / 2;
    const parcelTempK = source.wetBulbK + DRY_ADIABATIC_LAPSE_K_M * Math.max(0, source.heightM - midHeight);
    const buoyancy = (GRAVITY_M_S2 * (envTempK - parcelTempK)) / Math.max(180, envTempK);
    if (Number.isFinite(buoyancy) && buoyancy > 0 && Number.isFinite(dz) && dz > 1) {
      energy += buoyancy * dz;
    }
  }
  return Number.isFinite(energy) ? Math.min(4000, energy) : Number.NaN;
}

function calculatePointFixedStp({ sbcapeJkg, lclM, srh0to1kmM2S2, shear0to6kmKt }) {
  if (![sbcapeJkg, lclM, srh0to1kmM2S2, shear0to6kmKt].every(Number.isFinite)) {
    return Number.NaN;
  }
  const shearMs = Math.max(0, shear0to6kmKt) / MPS_TO_KT;
  const shearTerm = shearMs < 12.5 ? 0 : clamp(shearMs / 20, 0, 1.5);
  const lclTerm = clamp((2000 - lclM) / 1000, 0, 1);
  return Math.max(0, (Math.max(0, sbcapeJkg) / 1500) * (Math.max(0, srh0to1kmM2S2) / 150) * shearTerm * lclTerm);
}

function calculatePointScp({ mucapeJkg, srh0to3kmM2S2, effectiveBulkShearKt }) {
  if (![mucapeJkg, srh0to3kmM2S2, effectiveBulkShearKt].every(Number.isFinite)) {
    return Number.NaN;
  }
  const shearMs = Math.max(0, effectiveBulkShearKt) / MPS_TO_KT;
  const shearTerm = shearMs < 10 ? 0 : clamp(shearMs / 20, 0, 1);
  return Math.max(0, (Math.max(0, mucapeJkg) / 1000) * (Math.max(0, srh0to3kmM2S2) / 50) * shearTerm);
}

function calculatePointEffectiveStp({
  mlcapeJkg,
  mlcinJkg,
  mixedLayerLclM,
  effectiveSrhM2S2,
  effectiveBulkShearKt,
  effectiveBaseM,
}) {
  if (![mlcapeJkg, mlcinJkg, mixedLayerLclM, effectiveSrhM2S2, effectiveBulkShearKt].every(Number.isFinite)) {
    return Number.NaN;
  }
  if (Number.isFinite(effectiveBaseM) && effectiveBaseM > 0) {
    return 0;
  }
  const shearMs = Math.max(0, effectiveBulkShearKt) / MPS_TO_KT;
  const shearTerm = shearMs < 12.5 ? 0 : clamp(shearMs / 20, 0, 1.5);
  const lclTerm = clamp((2000 - mixedLayerLclM) / 1000, 0, 1);
  const cinTerm = mlcinJkg > -50 ? 1 : clamp((mlcinJkg + 200) / 150, 0, 1);
  return Math.max(
    0,
    (Math.max(0, mlcapeJkg) / 1500) * (Math.max(0, effectiveSrhM2S2) / 150) * shearTerm * lclTerm * cinTerm,
  );
}

function pointSoundingValue(values, param, level) {
  const value = values?.get(pointSoundingValueKey(param, level));
  return Number.isFinite(value) ? value : Number.NaN;
}

function pointSoundingValueByLevelPattern(values, param, pattern) {
  if (!values || !pattern) {
    return Number.NaN;
  }
  for (const [key, value] of values.entries()) {
    const [entryParam, entryLevel] = String(key).split("\u0000");
    if (entryParam === param && pattern.test(entryLevel || "") && Number.isFinite(value)) {
      return value;
    }
  }
  return Number.NaN;
}

function pointSoundingValueKey(param, level) {
  return `${String(param || "").trim()}\u0000${String(level || "").trim()}`;
}

function windComponentsToMeteorological(uMps, vMps) {
  const u = Number(uMps);
  const v = Number(vMps);
  if (!Number.isFinite(u) || !Number.isFinite(v)) {
    return { wdir: Number.NaN, wspd: Number.NaN, uKt: Number.NaN, vKt: Number.NaN };
  }
  const speedKt = Math.hypot(u, v) * MPS_TO_KT;
  const direction = (Math.atan2(-u, -v) * 180) / Math.PI;
  return {
    wdir: (direction + 360) % 360,
    wspd: speedKt,
    uKt: u * MPS_TO_KT,
    vKt: v * MPS_TO_KT,
  };
}

function dewpointCFromTemperatureRh(tempC, rhPct) {
  const temp = Number(tempC);
  const rh = Number(rhPct);
  if (!Number.isFinite(temp) || !Number.isFinite(rh) || rh <= 0) {
    return Number.NaN;
  }
  const clampedRh = Math.max(1, Math.min(100, rh));
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(clampedRh / 100) + (a * temp) / (b + temp);
  return (b * gamma) / (a - gamma);
}

function interpolateHeightForTemperature(levels, targetTempC) {
  const target = Number(targetTempC);
  if (!Number.isFinite(target)) {
    return Number.NaN;
  }
  for (let index = 1; index < levels.length; index += 1) {
    const lower = levels[index - 1];
    const upper = levels[index];
    const lowerTemp = Number(lower.temp);
    const upperTemp = Number(upper.temp);
    if (!Number.isFinite(lowerTemp) || !Number.isFinite(upperTemp)) {
      continue;
    }
    if ((lowerTemp >= target && upperTemp <= target) || (lowerTemp <= target && upperTemp >= target)) {
      const t = (target - lowerTemp) / Math.max(1e-9, upperTemp - lowerTemp);
      return Number(lower.hght) + (Number(upper.hght) - Number(lower.hght)) * Math.max(0, Math.min(1, t));
    }
  }
  return Number.NaN;
}

function levelValueByPressure(levels, pressureHpa, key) {
  const target = Number(pressureHpa);
  const level = (Array.isArray(levels) ? levels : []).find((entry) => Math.abs(Number(entry.press) - target) < 0.6);
  const value = level ? Number(level[key]) : Number.NaN;
  return Number.isFinite(value) ? value : Number.NaN;
}

function interpolateProfileValueByPressure(levels, pressureHpa, key) {
  const target = Number(pressureHpa);
  if (!Number.isFinite(target) || target <= 0) {
    return Number.NaN;
  }
  const exact = levelValueByPressure(levels, target, key);
  if (Number.isFinite(exact)) {
    return exact;
  }
  const profile = (Array.isArray(levels) ? levels : [])
    .map((level) => ({ pressure: Number(level.press), value: Number(level[key]) }))
    .filter((level) => Number.isFinite(level.pressure) && level.pressure > 0 && Number.isFinite(level.value))
    .sort((left, right) => right.pressure - left.pressure);
  for (let index = 1; index < profile.length; index += 1) {
    const lower = profile[index - 1];
    const upper = profile[index];
    const brackets =
      (lower.pressure >= target && upper.pressure <= target) || (lower.pressure <= target && upper.pressure >= target);
    if (!brackets) {
      continue;
    }
    const t = logPressureInterpolationFraction(target, lower.pressure, upper.pressure);
    return lower.value + (upper.value - lower.value) * clamp01(t);
  }
  return Number.NaN;
}

function logPressureInterpolationFraction(targetPressureHpa, lowerPressureHpa, upperPressureHpa) {
  const target = Number(targetPressureHpa);
  const lower = Number(lowerPressureHpa);
  const upper = Number(upperPressureHpa);
  if (![target, lower, upper].every(Number.isFinite) || target <= 0 || lower <= 0 || upper <= 0) {
    return Number.NaN;
  }
  const denominator = Math.log(upper) - Math.log(lower);
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return Number.NaN;
  }
  return (Math.log(target) - Math.log(lower)) / denominator;
}

function virtualTemperatureCAtPressure(levels, pressureHpa) {
  const pressure = Number(pressureHpa);
  const tempC = interpolateProfileValueByPressure(levels, pressure, "temp");
  const dewpointC = interpolateProfileValueByPressure(levels, pressure, "dwpt");
  return virtualTemperatureC(tempC, dewpointC, pressure);
}

function virtualTemperatureCAtHeight(levels, targetHeightM) {
  const tempC = interpolateProfileValueByHeight(levels, targetHeightM, "temp");
  const dewpointC = interpolateProfileValueByHeight(levels, targetHeightM, "dwpt");
  const pressureHpa = interpolateProfilePressureByHeight(levels, targetHeightM);
  return virtualTemperatureC(tempC, dewpointC, pressureHpa);
}

function virtualTemperatureC(tempC, dewpointC, pressureHpa) {
  const tempK = Number(tempC) + 273.15;
  const dewpointK = Number(dewpointC) + 273.15;
  const pressure = Number(pressureHpa);
  if (![tempK, dewpointK, pressure].every(Number.isFinite) || pressure <= 0) {
    return Number.NaN;
  }
  const mixingRatio = mixingRatioFromDewpointK(dewpointK, pressure);
  const virtualTempK = virtualTemperatureK(tempK, mixingRatio);
  return Number.isFinite(virtualTempK) ? virtualTempK - 273.15 : Number.NaN;
}

function interpolateProfilePressureByHeight(levels, targetHeightM) {
  const target = Number(targetHeightM);
  if (!Number.isFinite(target)) {
    return Number.NaN;
  }
  let lower = null;
  for (const level of levels) {
    const height = Number(level.hght);
    const pressure = Number(level.press);
    if (!Number.isFinite(height) || !Number.isFinite(pressure) || pressure <= 0) {
      continue;
    }
    if (height === target) {
      return pressure;
    }
    if (height < target) {
      lower = { height, pressure };
      continue;
    }
    if (!lower) {
      return Number.NaN;
    }
    const t = (target - lower.height) / Math.max(1e-9, height - lower.height);
    return Math.exp(Math.log(lower.pressure) + (Math.log(pressure) - Math.log(lower.pressure)) * clamp01(t));
  }
  return Number.NaN;
}

function interpolateProfileValueByHeight(levels, targetHeightM, key) {
  const target = Number(targetHeightM);
  if (!Number.isFinite(target)) {
    return Number.NaN;
  }
  let lower = null;
  for (const level of levels) {
    const height = Number(level.hght);
    const value = Number(level[key]);
    if (!Number.isFinite(height) || !Number.isFinite(value)) {
      continue;
    }
    if (height === target) {
      return value;
    }
    if (height < target) {
      lower = { height, value };
      continue;
    }
    if (!lower) {
      return Number.NaN;
    }
    const t = (target - lower.height) / Math.max(1e-9, height - lower.height);
    return lower.value + (value - lower.value) * Math.max(0, Math.min(1, t));
  }
  return Number.NaN;
}

function formatNoaaRunId(date, cycle) {
  return `${String(date).slice(0, 8)}-${String(cycle).padStart(2, "0")}00Z`;
}

function referenceTimeIsoFromNoaaRun(date, cycle) {
  return validTimeIsoFromNoaaRun(date, cycle, 0);
}

function validTimeIsoFromNoaaRun(date, cycle, hour) {
  const text = String(date || "");
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const cycleHour = Number(cycle);
  const forecastHour = Number(hour);
  if (![year, month, day, cycleHour, forecastHour].every(Number.isFinite)) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, cycleHour + forecastHour, 0, 0)).toISOString();
}

function normalizeLongitudeForRequest(value) {
  const lon = Number(value);
  if (!Number.isFinite(lon)) {
    return Number.NaN;
  }
  return lon > 180 ? lon - 360 : lon;
}

function normalizeLongitudeForDisplay(value) {
  const lon = Number(value);
  if (!Number.isFinite(lon)) {
    return Number.NaN;
  }
  return lon > 180 ? lon - 360 : lon;
}

function roundForCommand(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function roundNullable(value, digits = 1) {
  const num = finiteOptionalNumber(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  const factor = 10 ** Math.max(0, Math.round(Number(digits) || 0));
  return Math.round(num * factor) / factor;
}

function finiteOptionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return Number.NaN;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : Number.NaN;
}

function finiteOrNumber(...values) {
  for (const value of values) {
    const num = finiteOptionalNumber(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return Number.NaN;
}

function parseNoaaIdx(text, totalBytes = null) {
  const rows = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(":");
      const record = String(parts[0] || "").trim();
      const offset = Number(parts[1]);
      return {
        line,
        record,
        recordNumber: Number(record),
        offset,
        dateToken: String(parts[2] || ""),
        param: String(parts[3] || ""),
        level: String(parts[4] || ""),
        forecast: String(parts[5] || ""),
        extra: parts.slice(6).join(":"),
      };
    })
    .filter((entry) => entry.record && Number.isFinite(entry.offset));

  rows.sort((left, right) => left.offset - right.offset);
  for (const entry of rows) {
    entry.accumulationWindow = parseAccumulationWindow(entry);
    entry.averageWindow = parseAverageWindow(entry);
    entry.selectorKey = noaaRecordSelectorKey(entry.param, entry.level);
  }
  assignNoaaIdxByteRanges(rows, totalBytes);
  indexNoaaRecords(rows);
  return rows;
}

function assignNoaaIdxByteRanges(rows, totalBytes = null) {
  const resolvedTotalBytes = Number(totalBytes);
  for (let index = 0; index < rows.length; ) {
    const offset = rows[index].offset;
    let nextIndex = index + 1;
    while (nextIndex < rows.length && rows[nextIndex].offset === offset) {
      nextIndex += 1;
    }
    const nextOffset = nextIndex < rows.length ? rows[nextIndex].offset : resolvedTotalBytes;
    const endExclusive = Number.isFinite(nextOffset) ? nextOffset : resolvedTotalBytes;
    for (let current = index; current < nextIndex; current += 1) {
      rows[current].endExclusive =
        Number.isFinite(endExclusive) && endExclusive > rows[current].offset ? endExclusive : null;
      rows[current].byteLength = rows[current].endExclusive ? rows[current].endExclusive - rows[current].offset : null;
      rows[current].rangeHeader = rows[current].endExclusive
        ? `bytes=${rows[current].offset}-${rows[current].endExclusive - 1}`
        : null;
    }
    index = nextIndex;
  }
  return rows;
}

function repairNoaaIdxFinalRecordRanges(rows, totalBytes) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return rows;
  }
  const resolvedTotalBytes = Number(totalBytes);
  if (!Number.isFinite(resolvedTotalBytes) || resolvedTotalBytes <= 0) {
    return rows;
  }
  return assignNoaaIdxByteRanges(rows, resolvedTotalBytes);
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

function profileDecodeKey(variable, level) {
  const prefix = PROFILE_VARIABLE_PREFIX[variable] || `profile${String(variable || "").toLowerCase()}`;
  return `${prefix}${Math.round(Number(level))}`;
}

function profileSelector(variable, level) {
  return {
    param: String(variable || "").toUpperCase(),
    level: `${Math.round(Number(level))} mb`,
  };
}

function findRecord(records, selector) {
  if (!Array.isArray(records) || !selector) {
    return null;
  }
  const index = getNoaaRecordIndex(records);
  if (selector.level && !selector.levelPattern) {
    const exact = index.byParamLevel.get(noaaRecordSelectorKey(selector.param, selector.level));
    return exact?.[0] || null;
  }
  const source = index.byParam.get(String(selector.param || "")) || [];
  const candidates = source.filter((record) => {
    if (record.param !== selector.param) {
      return false;
    }
    if (selector.level && record.level !== selector.level) {
      return false;
    }
    if (selector.levelPattern && !selector.levelPattern.test(record.level)) {
      return false;
    }
    return true;
  });
  if (selector.param === "CAPE" && !selector.level && !selector.levelPattern) {
    return (
      candidates.find((record) => /180-0 mb above ground|surface|255-0 mb above ground/i.test(record.level)) ||
      candidates[0] ||
      null
    );
  }
  return candidates[0] || null;
}

function noaaRecordSelectorKey(param, level) {
  return `${String(param || "")}\u0000${String(level || "")}`;
}

function indexNoaaRecords(records) {
  if (!Array.isArray(records)) {
    return null;
  }
  const byParam = new Map();
  const byParamLevel = new Map();
  for (const record of records) {
    const param = String(record?.param || "");
    const paramGroup = byParam.get(param) || [];
    paramGroup.push(record);
    byParam.set(param, paramGroup);
    const exactKey = noaaRecordSelectorKey(param, record?.level);
    const exactGroup = byParamLevel.get(exactKey) || [];
    exactGroup.push(record);
    byParamLevel.set(exactKey, exactGroup);
  }
  const index = { byParam, byParamLevel };
  try {
    Object.defineProperty(records, NOAA_RECORD_INDEX_SYMBOL, {
      value: index,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // If the array is non-extensible, callers still get the returned index.
  }
  return index;
}

function getNoaaRecordIndex(records) {
  return (
    records?.[NOAA_RECORD_INDEX_SYMBOL] || indexNoaaRecords(records) || { byParam: new Map(), byParamLevel: new Map() }
  );
}

function buildSelectedRecordPlan(records) {
  const sortedRecords = uniqueRecords(records).sort((left, right) => {
    const offsetDelta = left.offset - right.offset;
    if (offsetDelta !== 0) {
      return offsetDelta;
    }
    return compareRecordIds(left.record, right.record);
  });
  const groups = [];
  const groupByRange = new Map();
  for (const record of sortedRecords) {
    const rangeKey = `${record.offset}|${record.rangeHeader || ""}`;
    let group = groupByRange.get(rangeKey);
    if (!group) {
      group = {
        offset: record.offset,
        rangeHeader: record.rangeHeader,
        byteLength: record.byteLength,
        records: [],
      };
      groupByRange.set(rangeKey, group);
      groups.push(group);
    }
    group.records.push(record);
  }

  const recordIndexByOriginalRecord = new Map();
  groups.forEach((group, groupIndex) => {
    const messageIndex = groupIndex + 1;
    for (const record of group.records) {
      const submessage = String(record.record || "").match(/\.(\d+)$/)?.[1];
      recordIndexByOriginalRecord.set(
        record.record,
        submessage ? `${messageIndex}.${submessage}` : String(messageIndex),
      );
    }
  });

  return {
    groups,
    records: sortedRecords,
    recordIndexByOriginalRecord,
  };
}

function getSelectedRecordPlan(records, decodeSession = null) {
  const selectedRecords = (Array.isArray(records) ? records : []).filter(Boolean);
  if (!decodeSession?.selectedPlans) {
    return buildSelectedRecordPlan(selectedRecords);
  }
  const key = selectedRecords
    .map((record) => selectedRecordDecodeCacheKey(record))
    .sort()
    .join("|");
  const cached = decodeSession.selectedPlans.get(key);
  if (cached) {
    incrementProfileCounter(decodeSession.profile, "selectedPlanCacheHits");
    return cached;
  }
  const plan = buildSelectedRecordPlan(selectedRecords);
  decodeSession.selectedPlans.set(key, plan);
  return plan;
}

function compareRecordIds(left, right) {
  const leftParts = String(left || "")
    .split(".")
    .map((part) => Number(part));
  const rightParts = String(right || "")
    .split(".")
    .map((part) => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : -1;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : -1;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function parseAccumulationHours(record) {
  const window = parseAccumulationWindow(record);
  return window ? Math.max(0, window.endHour - window.startHour) : null;
}

function parseAccumulationWindow(record) {
  const text = `${record?.forecast || ""} ${record?.extra || ""} ${record?.line || ""}`;
  const hourRange = text.match(/(\d+)\s*-\s*(\d+)\s*hour\s+acc/i);
  if (hourRange) {
    return {
      startHour: Math.max(0, Number(hourRange[1])),
      endHour: Math.max(0, Number(hourRange[2])),
    };
  }
  const dayRange = text.match(/(\d+)\s*-\s*(\d+)\s*day\s+acc/i);
  if (dayRange) {
    return {
      startHour: Math.max(0, Number(dayRange[1]) * 24),
      endHour: Math.max(0, Number(dayRange[2]) * 24),
    };
  }
  return null;
}

function parseAverageWindow(record) {
  const text = `${record?.forecast || ""} ${record?.extra || ""} ${record?.line || ""}`;
  const hourRange = text.match(/(\d+)\s*-\s*(\d+)\s*hour\s+ave/i);
  if (hourRange) {
    return {
      startHour: Math.max(0, Number(hourRange[1])),
      endHour: Math.max(0, Number(hourRange[2])),
    };
  }
  const dayRange = text.match(/(\d+)\s*-\s*(\d+)\s*day\s+ave/i);
  if (dayRange) {
    return {
      startHour: Math.max(0, Number(dayRange[1]) * 24),
      endHour: Math.max(0, Number(dayRange[2]) * 24),
    };
  }
  return null;
}

function isSurfacePrecipRecord(record) {
  return record?.param === "APCP" && record?.level === "surface";
}

function isSurfacePrecipAccumulationRecord(record) {
  const window = isSurfacePrecipRecord(record) ? parseAccumulationWindow(record) : null;
  return Boolean(window && window.endHour > window.startHour);
}

function isSurfaceAccumulatedSnowWaterRecord(record) {
  const window = record?.param === "WEASD" && record?.level === "surface" ? parseAccumulationWindow(record) : null;
  return Boolean(window && window.endHour > window.startHour);
}

function isSurfaceAccumulatedFreezingRainRecord(record) {
  const window = record?.param === "FRZR" && record?.level === "surface" ? parseAccumulationWindow(record) : null;
  return Boolean(window && window.endHour > window.startHour);
}

async function buildPrecipAccumulationGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
}) {
  const entries = getPrecipAccumulationEntries();
  if (entries.length === 0) {
    return {};
  }
  const availableHours = resolveAvailableForecastHours(latestMetadata, targetHour, modelKey);
  const context = {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    availableHours,
    availableHourSet: new Set(availableHours),
    recordsByHour: new Map([[Number(targetHour), currentRecords || []]]),
    intervalsByHour: new Map(),
    intervalSumPlanCache: new Map(),
    cumulativePlanCache: new Map(),
    precipAccumulationPlanCache: new Map(),
    runAccumulationPlannerReady: false,
    runAccumulationPlansByKey: new Map(),
    sourceGridOverrides: buildPrecipSourceGridOverrides({ targetHour, decoded, selection }),
    sourceGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "precip-accum-grids") : null,
    sourceGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
    profile,
    decodeSession,
  };
  let stageStartedAt = performance.now();
  const warmedPlans = await warmPrecipAccumulationRunPlanner(context);
  const plans = {};
  const sourceRefs = [];
  for (const entry of entries) {
    const plan = warmedPlans?.has(entry.key)
      ? warmedPlans.get(entry.key)
      : await resolvePrecipAccumulationPlan(entry, context);
    if (!plan) {
      continue;
    }
    plans[entry.key] = plan;
    sourceRefs.push(...plan.terms);
  }
  recordProfileStage(profile, "precipAccumPlanMs", stageStartedAt);
  if (Object.keys(plans).length === 0) {
    return {};
  }
  if (profile) {
    profile.precipAccumSourceRefs = sourceRefs.length;
  }
  stageStartedAt = performance.now();
  const sourceGrids = await decodePrecipAccumulationSourceGrids(sourceRefs, context);
  recordProfileStage(profile, "precipAccumSourceMs", stageStartedAt);
  const out = {};
  stageStartedAt = performance.now();
  for (const [key, plan] of Object.entries(plans)) {
    const grid = composePrecipAccumulationGrid(plan.terms, sourceGrids, width, height);
    if (grid) {
      out[key] = grid;
    }
  }
  recordProfileStage(profile, "precipAccumComposeMs", stageStartedAt);
  return out;
}

function getPrecipAccumulationEntries() {
  return NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.kind === "precipAccumulation");
}

async function buildWinterDerivedInputGrids(options) {
  const baseDecoded = options.decoded || {};
  const [freezingRain, intervalSnowfall] = await Promise.all([
    buildFreezingRainAccumulationGrids({
      ...options,
      decoded: baseDecoded,
    }),
    buildIntervalSnowfallAccumulationGrids({
      ...options,
      decoded: baseDecoded,
    }),
  ]);
  if (intervalSnowfall[SNOWFALL_DERIVED_INTERVALS_READY_KEY]) {
    return { ...freezingRain, ...intervalSnowfall };
  }
  const snowLiquid = await buildSnowLiquidAccumulationGrids({
    ...options,
    decoded: baseDecoded,
  });
  const decoded = { ...baseDecoded, ...freezingRain, ...snowLiquid };
  const lazyProfiles = await decodeLazySnowfallProfileGrids({
    ...options,
    hour: options.targetHour,
    records: options.currentRecords,
    decoded: { ...decoded, ...intervalSnowfall },
  });
  return { ...freezingRain, ...snowLiquid, ...intervalSnowfall, ...lazyProfiles };
}

async function buildRunMaxAccumulationGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
}) {
  const available = new Set(selection?.availableParameters || []);
  const entries = Object.entries(RUN_MAX_ACCUMULATION_SOURCES).filter(([key]) => available.has(key));
  const target = Math.round(Number(targetHour));
  if (entries.length === 0 || !Number.isFinite(target) || target <= 0) {
    return {};
  }
  const context = {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour: target,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    availableHours: resolveAvailableForecastHours(latestMetadata, target, modelKey),
    recordsByHour: new Map([[target, currentRecords || []]]),
    sourceGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "run-max-source-grids") : null,
    sourceGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    cumulativeGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "run-max-cumulative-grids") : null,
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
    profile,
    decodeSession,
  };
  const startedAt = performance.now();
  const pairs = await mapWithConcurrency(entries, Math.min(entries.length, 2), async ([key, source]) => {
    const grid = await readOrBuildCachedRunMaxGrid({ key, source, hour: target, context, decoded });
    return grid ? [key, grid] : null;
  });
  recordProfileStage(profile, "runMaxAccumMs", startedAt);
  return Object.fromEntries(pairs.filter(Boolean));
}

async function buildRunMaxPrefixOnlyGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
}) {
  const available = new Set(selection?.availableParameters || []);
  const entries = Object.entries(RUN_MAX_ACCUMULATION_SOURCES).filter(([key]) => available.has(key));
  const target = Math.round(Number(targetHour));
  if (entries.length === 0 || !Number.isFinite(target) || target <= 0) {
    return new Map();
  }
  const context = {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour: target,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    availableHours: resolveAvailableForecastHours(latestMetadata, target, modelKey),
    recordsByHour: new Map([[target, currentRecords || []]]),
    sourceGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "run-max-source-grids") : null,
    sourceGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    cumulativeGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "run-max-cumulative-grids") : null,
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
    profile,
    decodeSession,
  };
  const startedAt = performance.now();
  await mapWithConcurrency(entries, Math.min(entries.length, 2), ([key, source]) =>
    buildCachedIterativeRunMaxGrid({ key, source, hour: target, context, decoded }),
  );
  recordProfileStage(profile, "runMaxAccumMs", startedAt);
  return new Map();
}

async function readOrBuildCachedRunMaxGrid({ key, source, hour, context, decoded }) {
  return buildCachedIterativeRunMaxGrid({ key, source, hour, context, decoded });
}

async function buildCachedIterativeRunMaxGrid({ key, source, hour, context, decoded }) {
  return readOrComputeCachedRunMaxGrid({
    key,
    source,
    hour,
    context,
    compute: async ({ target, targetRecord, cellCount }) => {
      const previousHour = previousRunMaxSourceHour(context, target);
      let previousGrid = null;
      if (previousHour !== null) {
        previousGrid =
          (await readCachedRunMaxGridForHour({ key, source, hour: previousHour, context, countHit: true })) ||
          (await buildCachedIterativeRunMaxGrid({ key, source, hour: previousHour, context, decoded }));
      }
      const sourceGrid = await readOrDecodeRunMaxSourceGrid({
        key,
        source,
        hour: target,
        record: targetRecord,
        context,
        decoded,
      });
      return composeRunMaxGrid([previousGrid, sourceGrid], cellCount);
    },
  });
}

async function readOrComputeCachedRunMaxGrid({ key, source, hour, context, compute }) {
  const target = Math.round(Number(hour));
  if (!Number.isFinite(target) || target <= 0) {
    return null;
  }
  const targetRecord = await findRunMaxSourceRecord(source, target, context);
  const payload = runMaxCumulativeGridPayload({ key, source, hour: target, record: targetRecord, context });
  const cachePath = runMaxGridCachePath(context.cumulativeGridCacheDir, payload, context);
  const cacheKey = cachePath || crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const existing = RUN_MAX_GRID_PROMISE_CACHE.get(cacheKey);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    const cellCount = Math.round(Number(context.width) * Number(context.height));
    const cached = await readCachedFloatGrid(cachePath, payload, cellCount);
    if (cached) {
      incrementProfileCounter(context.profile, "runMaxGridCacheHits");
      return cached;
    }
    const build = async () => {
      incrementProfileCounter(context.profile, "runMaxGridCacheMisses");
      const grid = await compute({ target, targetRecord, cellCount });
      if (grid) {
        await writeCachedFloatGrid(cachePath, payload, grid);
      }
      return grid;
    };
    if (!cachePath) {
      return build();
    }
    const lockPath = `${cachePath}.lock`;
    const lockHandle = await tryAcquireGridCacheLock(lockPath, payload);
    if (!lockHandle) {
      const waited = await waitForCachedGrid({
        cachePath,
        payload,
        lockPath,
        context,
        read: (targetPath, expectedPayload) => readCachedFloatGrid(targetPath, expectedPayload, cellCount),
        timeoutCounter: "runMaxGridLockTimeouts",
      });
      if (waited) {
        incrementProfileCounter(context.profile, "runMaxGridCacheHits");
        return waited;
      }
      return build();
    }
    try {
      const cachedAfterLock = await readCachedFloatGrid(cachePath, payload, cellCount);
      if (cachedAfterLock) {
        incrementProfileCounter(context.profile, "runMaxGridCacheHits");
        return cachedAfterLock;
      }
      return build();
    } finally {
      await releaseGridCacheLock(lockPath, lockHandle);
    }
  })().finally(() => {
    RUN_MAX_GRID_PROMISE_CACHE.delete(cacheKey);
  });
  RUN_MAX_GRID_PROMISE_CACHE.set(cacheKey, promise);
  return promise;
}

async function readCachedRunMaxGridForHour({ key, source, hour, context, countHit = false }) {
  const target = Math.round(Number(hour));
  if (!Number.isFinite(target) || target <= 0) {
    return null;
  }
  const targetRecord = await findRunMaxSourceRecord(source, target, context);
  const payload = runMaxCumulativeGridPayload({ key, source, hour: target, record: targetRecord, context });
  const cachePath = runMaxGridCachePath(context.cumulativeGridCacheDir, payload, context);
  const cellCount = Math.round(Number(context.width) * Number(context.height));
  const cached = await readCachedFloatGrid(cachePath, payload, cellCount);
  if (cached && countHit) {
    incrementProfileCounter(context.profile, "runMaxGridCacheHits");
  }
  return cached;
}

function previousRunMaxSourceHour(context, targetHour) {
  let previous = null;
  for (const hour of context.availableHours || []) {
    const candidate = Math.round(Number(hour));
    if (Number.isFinite(candidate) && candidate > 0 && candidate < targetHour) {
      previous = candidate;
    }
  }
  return previous;
}

async function findRunMaxSourceRecord(source, hour, context) {
  const records = await getNoaaRecordsForHour(context, hour);
  return findRecord(records || [], source.selector);
}

async function readOrDecodeRunMaxSourceGrid({ key, source, hour, record, context, decoded }) {
  const target = Math.round(Number(hour));
  const cellCount = Math.round(Number(context.width) * Number(context.height));
  if (target === Math.round(Number(context.targetHour)) && decoded?.[source.sourceKey]) {
    return transformRunMaxSourceGrid(decoded[source.sourceKey], source.multiplier, cellCount);
  }
  if (!record) {
    return null;
  }
  const payload = runMaxSourceGridPayload({ key, source, hour: target, record, context });
  const cachePath = runMaxGridCachePath(context.sourceGridCacheDir, payload, context);
  const cacheKey = cachePath || crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const existing = RUN_MAX_SOURCE_GRID_PROMISE_CACHE.get(cacheKey);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    const cached = await readCachedFloatGrid(cachePath, payload, cellCount);
    if (cached) {
      incrementProfileCounter(context.profile, "runMaxSourceCacheHits");
      return cached;
    }
    const build = async () => {
      incrementProfileCounter(context.profile, "runMaxSourceCacheMisses");
      const grid = await decodeRunMaxSourceGridForHour({ source, hour: target, record, context });
      if (grid) {
        await writeCachedFloatGrid(cachePath, payload, grid);
      }
      return grid;
    };
    if (!cachePath) {
      return build();
    }
    const lockPath = `${cachePath}.lock`;
    const lockHandle = await tryAcquireGridCacheLock(lockPath, payload);
    if (!lockHandle) {
      const waited = await waitForCachedGrid({
        cachePath,
        payload,
        lockPath,
        context,
        read: (targetPath, expectedPayload) => readCachedFloatGrid(targetPath, expectedPayload, cellCount),
        timeoutCounter: "runMaxSourceLockTimeouts",
      });
      if (waited) {
        incrementProfileCounter(context.profile, "runMaxSourceCacheHits");
        return waited;
      }
      return build();
    }
    try {
      const cachedAfterLock = await readCachedFloatGrid(cachePath, payload, cellCount);
      if (cachedAfterLock) {
        incrementProfileCounter(context.profile, "runMaxSourceCacheHits");
        return cachedAfterLock;
      }
      return build();
    } finally {
      await releaseGridCacheLock(lockPath, lockHandle);
    }
  })().finally(() => {
    RUN_MAX_SOURCE_GRID_PROMISE_CACHE.delete(cacheKey);
  });
  RUN_MAX_SOURCE_GRID_PROMISE_CACHE.set(cacheKey, promise);
  return promise;
}

async function decodeRunMaxSourceGridForHour({ source, hour, record, context }) {
  const cached = readDecodedRecordsForKeyedRecords({
    recordsByKey: { [source.sourceKey]: record },
    hour,
    context,
  });
  if (cached?.[source.sourceKey]) {
    return transformRunMaxSourceGrid(
      cached[source.sourceKey],
      source.multiplier,
      Math.round(Number(context.width) * Number(context.height)),
    );
  }
  await ensureSelectedRecordByteRangesForHour({
    context,
    hour,
    selectedRecords: [record],
    profile: context.profile,
  });
  const selectedPlan = getSelectedRecordPlan([record], context.decodeSession);
  const gribPath = await materializeSelectedGrib({
    modelKey: context.modelKey,
    productKey: context.modelConfig.productKey,
    gribUrl: buildNoaaGribUrl({
      modelKey: context.modelKey,
      baseUrl: context.baseUrl,
      date: context.date,
      cycle: context.cycle,
      hour,
    }),
    recordGroups: selectedPlan.groups,
    rawCacheDir: context.sourceGribCacheDir || path.join(context.tempDir, SELECTED_GRIB_CACHE_DIRNAME),
    date: context.date,
    cycle: context.cycle,
    hour,
    cacheVersion: CATALOG_VERSION,
    rangeFetchConcurrency: context.rangeFetchConcurrency,
    rangeFetchLimiter: context.rangeFetchLimiter,
    profile: null,
    decodeSession: context.decodeSession,
  });
  const decodeTempDir = await fs.promises.mkdtemp(path.join(context.tempDir, `run-max-${padHour(hour)}-`));
  try {
    const decoded = await decodeSelectedRecordsToGrids({
      gribPath,
      selectedPlan,
      selection: { records: { [source.sourceKey]: record }, catalog: [] },
      hour,
      tempDir: decodeTempDir,
      wgrib2Path: context.wgrib2Path,
      bounds: context.bounds,
      width: context.width,
      height: context.height,
      decodeConcurrency: context.decodeConcurrency,
      profile: null,
      decodeSession: context.decodeSession,
    });
    return transformRunMaxSourceGrid(
      decoded?.[source.sourceKey],
      source.multiplier,
      Math.round(Number(context.width) * Number(context.height)),
    );
  } finally {
    await fs.promises.rm(decodeTempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function transformRunMaxSourceGrid(values, multiplier, cellCount) {
  if (!values) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  const factor = Number.isFinite(Number(multiplier)) ? Number(multiplier) : 1;
  for (let index = 0; index < cellCount; index += 1) {
    const value = Number(values[index]);
    out[index] = Number.isFinite(value) ? Math.max(0, value * factor) : Number.NaN;
  }
  return out;
}

function composeRunMaxGrid(grids, cellCount) {
  const sources = (Array.isArray(grids) ? grids : []).filter(Boolean);
  if (sources.length === 0) {
    return null;
  }
  if (sources.length === 1) {
    return composeSingleRunMaxGrid(sources[0], cellCount);
  }
  if (sources.length === 2) {
    return composeTwoRunMaxGrids(sources[0], sources[1], cellCount);
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  let finiteCount = 0;
  for (const values of sources) {
    for (let index = 0; index < cellCount; index += 1) {
      const value = Number(values[index]);
      if (!Number.isFinite(value)) {
        continue;
      }
      if (!Number.isFinite(out[index]) || value > out[index]) {
        out[index] = value;
      }
      finiteCount += 1;
    }
  }
  return finiteCount > 0 ? out : null;
}

function composeSingleRunMaxGrid(values, cellCount) {
  const out = new Float32Array(cellCount).fill(Number.NaN);
  let finiteCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }
    out[index] = value;
    finiteCount += 1;
  }
  return finiteCount > 0 ? out : null;
}

function composeTwoRunMaxGrids(left, right, cellCount) {
  const out = new Float32Array(cellCount).fill(Number.NaN);
  let finiteCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    const leftFinite = Number.isFinite(leftValue);
    const rightFinite = Number.isFinite(rightValue);
    if (leftFinite && rightFinite) {
      out[index] = Math.max(leftValue, rightValue);
      finiteCount += 2;
    } else if (leftFinite) {
      out[index] = leftValue;
      finiteCount += 1;
    } else if (rightFinite) {
      out[index] = rightValue;
      finiteCount += 1;
    }
  }
  return finiteCount > 0 ? out : null;
}

function runMaxCumulativeGridPayload({ key, source, hour, record, context }) {
  return {
    version: RUN_MAX_GRID_CACHE_VERSION,
    mode: "cumulative",
    key,
    sourceKey: source.sourceKey,
    multiplier: source.multiplier,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    hour: Math.round(Number(hour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    record: selectedPrecipRecordIdentity(record),
  };
}

function runMaxSourceGridPayload({ key, source, hour, record, context }) {
  return {
    version: RUN_MAX_GRID_CACHE_VERSION,
    mode: "source",
    key,
    sourceKey: source.sourceKey,
    multiplier: source.multiplier,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    hour: Math.round(Number(hour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    record: selectedPrecipRecordIdentity(record),
  };
}

function runMaxGridCachePath(cacheDir, payload, context) {
  if (!cacheDir || !payload) {
    return null;
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(payload.hour)}-${sanitizePathToken(payload.key)}-${hash}`,
  );
}

async function readCachedFloatGrid(cachePath, expectedPayload, cellCount) {
  if (!cachePath) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    if (!cacheMetadataPayloadMatches(metadata, expectedPayload)) {
      return null;
    }
    const body = await fs.promises.readFile(`${cachePath}.bin`);
    if (body.length !== cellCount * 4) {
      return null;
    }
    return float32ArrayViewFromBuffer(body, 0, body.byteLength);
  } catch {
    return null;
  }
}

function float32ArrayViewFromBuffer(body, byteOffset = 0, byteLength = null) {
  if (!Buffer.isBuffer(body)) {
    return null;
  }
  const resolvedOffset = Math.max(0, Number(byteOffset) || 0);
  const resolvedLength = Number.isFinite(Number(byteLength)) ? Number(byteLength) : body.byteLength - resolvedOffset;
  if (resolvedLength < 0 || resolvedOffset + resolvedLength > body.byteLength || resolvedLength % 4 !== 0) {
    return null;
  }
  const absoluteOffset = body.byteOffset + resolvedOffset;
  if (absoluteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(body.buffer, absoluteOffset, resolvedLength / 4);
  }
  const copy = body.subarray(resolvedOffset, resolvedOffset + resolvedLength);
  const arrayBuffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
  return new Float32Array(arrayBuffer);
}

async function writeCachedFloatGrid(cachePath, payload, values) {
  if (!cachePath || !values) {
    return;
  }
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.promises.writeFile(tmp, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
  await fs.promises.writeFile(`${tmp}.json`, JSON.stringify(cacheMetadataWithPayload(payload)));
  await fs.promises.rename(tmp, `${cachePath}.bin`);
  await fs.promises.rename(`${tmp}.json`, `${cachePath}.json`);
}

function cachePayloadJson(payload) {
  return JSON.stringify(payload || {});
}

function cachePayloadHashFromJson(json) {
  return crypto.createHash("sha256").update(json).digest("hex");
}

function cachePayloadDescriptor(payload) {
  const payloadJson = cachePayloadJson(payload);
  return { payload, payloadJson, payloadHash: cachePayloadHashFromJson(payloadJson) };
}

function cacheMetadataWithPayload(payload, extra = {}) {
  const descriptor = cachePayloadDescriptor(payload);
  return { payload, payloadHash: descriptor.payloadHash, ...extra };
}

function cacheMetadataPayloadMatches(metadata, expectedPayload) {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const expected = cachePayloadDescriptor(expectedPayload);
  if (metadata.payloadHash && metadata.payloadHash === expected.payloadHash) {
    return true;
  }
  return cachePayloadJson(metadata.payload) === expected.payloadJson;
}

function directCacheMetadataPayloadMatches(metadata, expectedPayload) {
  if (metadata?.payload && metadata?.payloadHash) {
    return cacheMetadataPayloadMatches(metadata, expectedPayload);
  }
  return cachePayloadJson(metadata) === cachePayloadJson(expectedPayload);
}

async function buildSnowLiquidAccumulationGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
}) {
  const needsSnowLiquid = (selection?.availableParameters || []).some((key) => {
    const entry = NOAA_NAM_PARAMETER_CATALOG.find((candidate) => candidate.key === key);
    return entry?.kind === "snowfallDerived";
  });
  if (!needsSnowLiquid) {
    return {};
  }
  const target = Math.round(Number(targetHour));
  if (!Number.isFinite(target) || target <= 0) {
    return {};
  }
  const availableHours = resolveAvailableForecastHours(latestMetadata, targetHour, modelKey);
  const context = {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour: target,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    availableHours,
    availableHourSet: new Set(availableHours),
    recordsByHour: new Map([[target, currentRecords || []]]),
    snowLiquidIntervalsByHour: new Map(),
    snowLiquidCumulativePlanCache: new Map(),
    snowLiquidIntervalSumPlanCache: new Map(),
    snowfallLiquidChunksByWindow: new Map(),
    sourceGridOverrides: buildSnowLiquidSourceGridOverrides({
      targetHour: target,
      decoded,
      selection,
      records: currentRecords,
    }),
    sourceGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "snow-liquid-grids") : null,
    sourceGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    profileGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "derived-profile-grids") : null,
    profileSelectedGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
    profile,
    decodeSession,
  };
  let stageStartedAt = performance.now();
  const plan = await resolveSnowLiquidTotalPlan(context);
  recordProfileStage(profile, "snowLiquidPlanMs", stageStartedAt);
  if (!plan || plan.terms.length === 0) {
    return {};
  }
  if (profile) {
    profile.snowLiquidSourceRefs = plan.terms.length;
  }
  stageStartedAt = performance.now();
  const sourceGrids = await decodeSnowLiquidSourceGrids(plan.terms, context);
  recordProfileStage(profile, "snowLiquidSourceMs", stageStartedAt);
  stageStartedAt = performance.now();
  const grid = composePrecipAccumulationGrid(plan.terms, sourceGrids, width, height);
  sourceGrids.clear();
  recordProfileStage(profile, "snowLiquidComposeMs", stageStartedAt);
  return grid ? { [SNOW_LIQUID_TOTAL_KEY]: grid } : {};
}

async function buildFreezingRainAccumulationGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
  profileDecodeUnion = false,
}) {
  const available = new Set(selection?.availableParameters || []);
  const needsLiquid = available.has(FREEZING_RAIN_LIQUID_TOTAL_KEY);
  const needsFram = available.has(FRAM_FLAT_ICE_KEY) || available.has(FRAM_RADIAL_ICE_KEY);
  if (!needsLiquid && !needsFram) {
    return {};
  }
  const target = Math.round(Number(targetHour));
  if (!Number.isFinite(target) || target <= 0) {
    return {};
  }
  const availableHours = resolveAvailableForecastHours(latestMetadata, targetHour, modelKey);
  const context = {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour: target,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    availableHours,
    availableHourSet: new Set(availableHours),
    recordsByHour: new Map([[target, currentRecords || []]]),
    freezingRainLiquidIntervalsByHour: new Map(),
    freezingRainDirectIntervalsByHour: new Map(),
    freezingRainDirectChunksByWindow: new Map(),
    freezingRainLiquidChunksByWindow: new Map(),
    freezingRainAccumulationPlannerReady: false,
    freezingRainAccumulationChunksByTarget: null,
    sourceProfilePrefix: "freezingRainLiquid",
    sourceGridOverrides: buildFreezingRainLiquidSourceGridOverrides({
      targetHour: target,
      decoded,
      selection,
      records: currentRecords,
    }),
    sourceGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "freezing-rain-liquid-grids") : null,
    sourceGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    profileGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "derived-profile-grids") : null,
    profileSelectedGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
    profile,
    decodeSession,
    profileDecodeUnion,
  };
  let stageStartedAt = performance.now();
  let chunks = await resolveDirectFreezingRainLiquidChunksForWindow(context, 0, target);
  if (chunks.length === 0) {
    chunks =
      (await warmFreezingRainAccumulationRunPlanner(context, target)) ||
      (await resolveFreezingRainLiquidChunksForWindow(context, 0, target));
  }
  recordProfileStage(profile, "freezingRainLiquidPlanMs", stageStartedAt);
  if (chunks.length === 0) {
    return {};
  }
  const sourceRefs = chunks.flatMap((chunk) => chunk.terms);
  if (profile) {
    profile.freezingRainLiquidSourceRefs = sourceRefs.length;
  }
  stageStartedAt = performance.now();
  const sourceGrids = await decodeSnowLiquidSourceGrids(sourceRefs, context);
  recordProfileStage(profile, "freezingRainLiquidSourceMs", stageStartedAt);
  const liquidByChunk = buildSnowfallLiquidInByChunk(chunks, sourceGrids, width, height);
  sourceGrids.clear();
  const activeChunkDescriptors = needsFram
    ? buildLiquidChunkDescriptors({
        chunks,
        liquidByChunk,
        width,
        height,
        threshold: 0,
      })
    : [];
  const out = {};
  const liquidTotal = needsLiquid || needsFram ? sumLiquidChunksIn(chunks, liquidByChunk, width, height) : null;
  if (needsLiquid && liquidTotal) {
    out[FREEZING_RAIN_LIQUID_TOTAL_KEY] = liquidTotal;
  }
  const activeChunks = activeChunkDescriptors.map((descriptor) => descriptor.chunk);
  if (needsFram && activeChunks.length > 0) {
    const framChunksByKey = new Map(
      activeChunks.map((chunk) => {
        const framChunk = { ...chunk, profileHours: framProfileHoursForChunk(chunk, context) };
        return [chunk.key, framChunk];
      }),
    );
    const framChunkDescriptors = activeChunkDescriptors.map((descriptor) => ({
      ...descriptor,
      chunk: framChunksByKey.get(descriptor.chunk?.key) || descriptor.chunk,
    }));
    const framChunks = Array.from(framChunksByKey.values());
    stageStartedAt = performance.now();
    const profilesByHour = await decodeFramSurfaceProfiles({ chunks: framChunks, context, decoded });
    recordProfileStage(profile, "framProfileMs", stageStartedAt);
    const fram = buildFramIceGridsFromChunks({
      chunks: framChunks,
      chunkDescriptors: framChunkDescriptors,
      liquidByChunk,
      profilesByHour,
      decoded,
      width,
      height,
    });
    if (fram.flat) {
      out[FRAM_FLAT_ICE_KEY] = fram.flat;
    }
    if (fram.radial) {
      out[FRAM_RADIAL_ICE_KEY] = fram.radial;
    }
    profilesByHour.clear();
  } else if (needsFram && liquidTotal) {
    const zeroIce = zeroGridForFiniteSource(liquidTotal);
    if (available.has(FRAM_FLAT_ICE_KEY)) {
      out[FRAM_FLAT_ICE_KEY] = zeroIce;
    }
    if (available.has(FRAM_RADIAL_ICE_KEY)) {
      out[FRAM_RADIAL_ICE_KEY] = zeroIce;
    }
  }
  liquidByChunk.clear();
  return out;
}

async function buildIntervalSnowfallAccumulationGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
}) {
  const entries = getAvailableSnowfallDerivedEntries(selection);
  if (entries.length === 0) {
    return {};
  }
  const target = Math.round(Number(targetHour));
  if (!Number.isFinite(target) || target <= 0) {
    return {};
  }
  const availableHours = resolveAvailableForecastHours(latestMetadata, targetHour, modelKey);
  const context = {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour: target,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    availableHours,
    availableHourSet: new Set(availableHours),
    recordsByHour: new Map([[target, currentRecords || []]]),
    snowLiquidIntervalsByHour: new Map(),
    snowLiquidCumulativePlanCache: new Map(),
    snowLiquidIntervalSumPlanCache: new Map(),
    sourceGridOverrides: buildSnowLiquidSourceGridOverrides({
      targetHour: target,
      decoded,
      selection,
      records: currentRecords,
    }),
    sourceGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "snow-liquid-grids") : null,
    sourceGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    profileGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "derived-profile-grids") : null,
    profileSelectedGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    deltaGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "snowfall-delta-grids") : null,
    cumulativeGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "snowfall-cumulative-grids") : null,
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
    profile,
    decodeSession,
  };
  let stageStartedAt = performance.now();
  const cumulative = await buildCachedCumulativeSnowfallGrids({ entries, targetHour: target, context, decoded });
  recordProfileStage(profile, "snowfallCumulativeMs", stageStartedAt);
  const out = {};
  let hasGrid = false;
  for (const entry of entries) {
    const grid = cumulative.get(entry.key);
    if (grid) {
      out[snowfallDerivedGridKey(entry.key)] = grid;
      hasGrid = true;
    }
  }
  if (hasGrid) {
    out[SNOWFALL_DERIVED_INTERVALS_READY_KEY] = true;
  }
  return out;
}

async function buildSnowfallDeltaOnlyGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
  profileDecodeUnion = false,
}) {
  const entries = getAvailableSnowfallDerivedEntries(selection);
  const target = Math.round(Number(targetHour));
  if (entries.length === 0 || !Number.isFinite(target) || target <= 0) {
    return new Map();
  }
  const context = buildSnowfallAccumulationContext({
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour: target,
    currentRecords,
    latestMetadata,
    rawCacheDir,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    decoded,
    selection,
    profile,
    decodeSession,
    profileDecodeUnion,
  });
  const step = await resolveSnowfallAccumulationStep(context, target);
  if (!step) {
    return new Map();
  }
  let stageStartedAt = performance.now();
  const delta = await buildCachedDeltaSnowfallGrids({ entries, step, context, decoded });
  recordProfileStage(profile, "snowfallDeltaMs", stageStartedAt);
  return delta;
}

async function buildSnowfallCumulativePrefixOnlyGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
}) {
  const entries = getAvailableSnowfallDerivedEntries(selection);
  const target = Math.round(Number(targetHour));
  if (entries.length === 0 || !Number.isFinite(target) || target <= 0) {
    return new Map();
  }
  const context = buildSnowfallAccumulationContext({
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour: target,
    currentRecords,
    latestMetadata,
    rawCacheDir,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    decoded,
    selection,
    profile,
    decodeSession,
  });
  const stageStartedAt = performance.now();
  const cumulative = await buildCachedIterativeCumulativeSnowfallGrids({
    entries,
    targetHour: target,
    context,
    decoded,
  });
  recordProfileStage(profile, "snowfallCumulativeMs", stageStartedAt);
  return cumulative;
}

function buildSnowfallAccumulationContext({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
  profileDecodeUnion = false,
}) {
  const availableHours = resolveAvailableForecastHours(latestMetadata, targetHour, modelKey);
  return {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    availableHours,
    availableHourSet: new Set(availableHours),
    recordsByHour: new Map([[targetHour, currentRecords || []]]),
    snowLiquidIntervalsByHour: new Map(),
    snowLiquidCumulativePlanCache: new Map(),
    snowLiquidIntervalSumPlanCache: new Map(),
    snowfallLiquidChunksByWindow: new Map(),
    sourceGridOverrides: buildSnowLiquidSourceGridOverrides({
      targetHour,
      decoded,
      selection,
      records: currentRecords,
    }),
    sourceGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "snow-liquid-grids") : null,
    sourceGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    profileGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "derived-profile-grids") : null,
    profileSelectedGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    deltaGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "snowfall-delta-grids") : null,
    cumulativeGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "snowfall-cumulative-grids") : null,
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
    profile,
    decodeSession,
    profileDecodeUnion,
  };
}

function getAvailableSnowfallDerivedEntries(selection) {
  const available = new Set(selection?.availableParameters || []);
  return NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.kind === "snowfallDerived" && available.has(entry.key));
}

async function buildCachedCumulativeSnowfallGrids({ entries, targetHour, context, decoded }) {
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour) || hour <= 0) {
    return new Map();
  }
  const payload = cumulativeSnowfallCachePayload({ entries, targetHour: hour, context });
  const cachePath = cumulativeSnowfallGridCachePath(payload, context);
  const cacheKey = cachePath || cumulativeSnowfallCacheKey(payload);
  const cached = SNOWFALL_CUMULATIVE_PROMISE_CACHE.get(cacheKey);
  if (cached) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
    return cached;
  }
  const promise = readOrComputeCachedCumulativeSnowfallGrids({
    payload,
    cachePath,
    context,
    compute: () => computeCumulativeSnowfallGrids({ entries, targetHour: hour, context, decoded }),
  }).finally(() => {
    SNOWFALL_CUMULATIVE_PROMISE_CACHE.delete(cacheKey);
  });
  SNOWFALL_CUMULATIVE_PROMISE_CACHE.set(cacheKey, promise);
  return promise;
}

async function buildCachedIterativeCumulativeSnowfallGrids({ entries, targetHour, context, decoded }) {
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour) || hour <= 0) {
    return new Map();
  }
  const payload = cumulativeSnowfallCachePayload({ entries, targetHour: hour, context });
  const cachePath = cumulativeSnowfallGridCachePath(payload, context);
  const cacheKey = cachePath || cumulativeSnowfallCacheKey(payload);
  const cached = SNOWFALL_CUMULATIVE_PROMISE_CACHE.get(cacheKey);
  if (cached) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
    return cached;
  }
  const promise = readOrComputeCachedCumulativeSnowfallGrids({
    payload,
    cachePath,
    context,
    compute: () => computeIterativeCumulativeSnowfallGrids({ entries, targetHour: hour, context, decoded }),
  }).finally(() => {
    SNOWFALL_CUMULATIVE_PROMISE_CACHE.delete(cacheKey);
  });
  SNOWFALL_CUMULATIVE_PROMISE_CACHE.set(cacheKey, promise);
  return promise;
}

async function buildCachedDeltaSnowfallGrids({ entries, step, context, decoded }) {
  if (!step || !Array.isArray(step.chunks) || step.chunks.length === 0) {
    return new Map();
  }
  const payload = deltaSnowfallCachePayload({ entries, step, context });
  const cachePath = deltaSnowfallGridCachePath(payload, context);
  const cacheKey = cachePath || deltaSnowfallCacheKey(payload);
  const cached = SNOWFALL_DELTA_PROMISE_CACHE.get(cacheKey);
  if (cached) {
    incrementProfileCounter(context.profile, "snowfallDeltaCacheHits");
    return cached;
  }
  const promise = (async () => {
    const cachedDelta = await readCachedCumulativeSnowfallGrids(cachePath, payload);
    if (cachedDelta) {
      incrementProfileCounter(context.profile, "snowfallDeltaCacheHits");
      return cachedDelta;
    }
    if (cachePath) {
      const lockPath = `${cachePath}.lock`;
      const lockHandle = await tryAcquireGridCacheLock(lockPath, payload);
      if (!lockHandle) {
        const waited = await waitForCachedGrid({
          cachePath,
          payload,
          lockPath,
          context,
          read: readCachedCumulativeSnowfallGrids,
          timeoutCounter: "snowfallDeltaLockTimeouts",
        });
        if (waited) {
          incrementProfileCounter(context.profile, "snowfallDeltaCacheHits");
          return waited;
        }
      } else {
        try {
          const cachedAfterLock = await readCachedCumulativeSnowfallGrids(cachePath, payload);
          if (cachedAfterLock) {
            incrementProfileCounter(context.profile, "snowfallDeltaCacheHits");
            return cachedAfterLock;
          }
          incrementProfileCounter(context.profile, "snowfallDeltaCacheMisses");
          const computed = await buildDeltaSnowfallGrids({ entries, chunks: step.chunks, context, decoded });
          await writeCachedCumulativeSnowfallGrids(cachePath, payload, computed);
          return computed;
        } finally {
          await releaseGridCacheLock(lockPath, lockHandle);
        }
      }
    }
    incrementProfileCounter(context.profile, "snowfallDeltaCacheMisses");
    const computed = await buildDeltaSnowfallGrids({ entries, chunks: step.chunks, context, decoded });
    await writeCachedCumulativeSnowfallGrids(cachePath, payload, computed);
    return computed;
  })().finally(() => {
    SNOWFALL_DELTA_PROMISE_CACHE.delete(cacheKey);
  });
  SNOWFALL_DELTA_PROMISE_CACHE.set(cacheKey, promise);
  return promise;
}

function deltaSnowfallCachePayload({ entries, step, context }) {
  return {
    version: SNOWFALL_DELTA_GRID_CACHE_VERSION,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    startHour: Math.round(Number(step.startHour)),
    targetHour: Math.round(Number(step.endHour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    entries: entries
      .map((entry) => ({
        key: entry.key,
        methodVersion: entry.methodVersion || null,
        artifactRequired: entry.artifactRequired || null,
        artifact: snowArtifactCacheIdentity(entry.artifactRequired),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    chunks: (step.chunks || []).map(deltaSnowfallChunkIdentity),
  };
}

function deltaSnowfallChunkIdentity(chunk) {
  return {
    key: chunk?.key || "",
    kind: chunk?.kind || "",
    startHour: Math.round(Number(chunk?.startHour)),
    endHour: Math.round(Number(chunk?.endHour)),
    profileHour: Math.round(Number(chunk?.profileHour)),
    terms: (chunk?.terms || []).map((term) => ({
      sourceKey: term?.sourceKey || "",
      kind: term?.kind || "",
      hour: Math.round(Number(term?.hour)),
      weight: Number(term?.weight) || 0,
      record: selectedPrecipRecordIdentity(term?.record),
      maskRecords: Object.fromEntries(
        Object.entries(term?.maskRecords || {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, record]) => [key, selectedPrecipRecordIdentity(record)]),
      ),
      maskSamples: (term?.maskSamples || []).map(snowMaskSampleIdentity),
    })),
  };
}

function snowMaskSampleIdentity(sample) {
  return {
    hour: Math.round(Number(sample?.hour)),
    weight: Number(sample?.weight) || 0,
    snow: selectedPrecipRecordIdentity(sample?.snow),
    rain: selectedPrecipRecordIdentity(sample?.rain),
    freezingRain: selectedPrecipRecordIdentity(sample?.freezingRain),
    icePellets: selectedPrecipRecordIdentity(sample?.icePellets),
  };
}

function deltaSnowfallCacheKey(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function deltaSnowfallGridCachePath(payload, context) {
  const cacheDir = context?.deltaGridCacheDir;
  if (!cacheDir || !payload) {
    return null;
  }
  const hash = deltaSnowfallCacheKey(payload).slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(payload.targetHour)}-${hash}`,
  );
}

function cumulativeSnowfallCachePayload({ entries, targetHour, context }) {
  return {
    version: SNOWFALL_CUMULATIVE_GRID_CACHE_VERSION,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    targetHour: Math.round(Number(targetHour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    entries: entries
      .map((entry) => ({
        key: entry.key,
        methodVersion: entry.methodVersion || null,
        artifactRequired: entry.artifactRequired || null,
        artifact: snowArtifactCacheIdentity(entry.artifactRequired),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function cumulativeSnowfallCacheKey(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function cumulativeSnowfallGridCachePath(payload, context) {
  const cacheDir = context?.cumulativeGridCacheDir;
  if (!cacheDir || !payload) {
    return null;
  }
  const hash = cumulativeSnowfallCacheKey(payload).slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(payload.targetHour)}-${hash}`,
  );
}

async function readOrComputeCachedCumulativeSnowfallGrids({ payload, cachePath, context, compute }) {
  const cached = await readCachedCumulativeSnowfallGrids(cachePath, payload);
  if (cached) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
    return cached;
  }
  if (!cachePath) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheMisses");
    return compute();
  }
  if (Number(payload?.targetHour) < SNOWFALL_CUMULATIVE_GRID_LOCK_MIN_HOUR) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheMisses");
    const computed = await compute();
    await writeCachedCumulativeSnowfallGrids(cachePath, payload, computed);
    return computed;
  }
  const lockPath = `${cachePath}.lock`;
  const lockHandle = await tryAcquireSnowfallCumulativeGridLock(lockPath, payload);
  if (!lockHandle) {
    const waited = await waitForCachedCumulativeSnowfallGrids(cachePath, payload, context);
    if (waited) {
      incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
      return waited;
    }
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheMisses");
    return compute();
  }
  try {
    const cachedAfterLock = await readCachedCumulativeSnowfallGrids(cachePath, payload);
    if (cachedAfterLock) {
      incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
      return cachedAfterLock;
    }
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheMisses");
    const computed = await compute();
    await writeCachedCumulativeSnowfallGrids(cachePath, payload, computed);
    return computed;
  } finally {
    await releaseSnowfallCumulativeGridLock(lockPath, lockHandle);
  }
}

async function waitForCachedCumulativeSnowfallGrids(cachePath, payload, context) {
  const startedAt = performance.now();
  const lockPath = `${cachePath}.lock`;
  while (performance.now() - startedAt < SNOWFALL_CUMULATIVE_GRID_LOCK_TIMEOUT_MS) {
    await sleep(SNOWFALL_CUMULATIVE_GRID_LOCK_POLL_MS + Math.round(Math.random() * 40));
    const cached = await readCachedCumulativeSnowfallGrids(cachePath, payload);
    if (cached) {
      return cached;
    }
    const lockExists = await pathExists(lockPath);
    if (!lockExists) {
      return null;
    }
  }
  incrementProfileCounter(context.profile, "snowfallCumulativeLockTimeouts");
  return null;
}

async function tryAcquireSnowfallCumulativeGridLock(lockPath, payload) {
  try {
    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    const handle = await fs.promises.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), payload }));
    return handle;
  } catch (error) {
    if (error?.code === "EEXIST") {
      return null;
    }
    throw error;
  }
}

async function releaseSnowfallCumulativeGridLock(lockPath, handle) {
  await handle.close().catch(() => {});
  await fs.promises.rm(lockPath, { force: true }).catch(() => {});
}

async function waitForCachedGrid({ cachePath, payload, lockPath, context, read, timeoutCounter }) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < GRID_CACHE_LOCK_TIMEOUT_MS) {
    await sleep(GRID_CACHE_LOCK_POLL_MS + Math.round(Math.random() * 40));
    const cached = await read(cachePath, payload);
    if (cached) {
      return cached;
    }
    const lockExists = await pathExists(lockPath);
    if (!lockExists) {
      return null;
    }
  }
  if (timeoutCounter) {
    incrementProfileCounter(context.profile, timeoutCounter);
  }
  return null;
}

async function tryAcquireGridCacheLock(lockPath, payload) {
  try {
    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    const handle = await fs.promises.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), payload }));
    return handle;
  } catch (error) {
    if (error?.code === "EEXIST") {
      if (await removeStaleGridCacheLock(lockPath)) {
        return tryAcquireGridCacheLock(lockPath, payload);
      }
      return null;
    }
    throw error;
  }
}

async function releaseGridCacheLock(lockPath, handle) {
  await handle.close().catch(() => {});
  await fs.promises.rm(lockPath, { force: true }).catch(() => {});
}

async function removeStaleGridCacheLock(lockPath) {
  try {
    const stat = await fs.promises.stat(lockPath);
    if (Date.now() - stat.mtimeMs < GRID_CACHE_LOCK_TIMEOUT_MS) {
      return false;
    }
    await fs.promises.rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readCachedCumulativeSnowfallGrids(cachePath, expectedPayload) {
  if (!cachePath) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    if (!cacheMetadataPayloadMatches(metadata, expectedPayload)) {
      return null;
    }
    const body = await fs.promises.readFile(`${cachePath}.bin`);
    const out = new Map();
    for (const grid of metadata.grids || []) {
      const byteOffset = Number(grid.byteOffset);
      const byteLength = Number(grid.byteLength);
      const key = grid.key;
      if (
        !key ||
        !Number.isFinite(byteOffset) ||
        !Number.isFinite(byteLength) ||
        byteOffset < 0 ||
        byteLength < 0 ||
        byteOffset + byteLength > body.byteLength ||
        byteOffset % 4 !== 0 ||
        byteLength % 4 !== 0
      ) {
        return null;
      }
      out.set(key, float32ArrayViewFromBuffer(body, byteOffset, byteLength));
    }
    return out;
  } catch {
    return null;
  }
}

async function writeCachedCumulativeSnowfallGrids(cachePath, payload, grids) {
  if (!cachePath || !(grids instanceof Map)) {
    return;
  }
  const entries = Array.from(grids.entries()).filter(([, values]) => values instanceof Float32Array);
  const gridMetadata = [];
  let byteOffset = 0;
  for (const [key, values] of entries) {
    const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    gridMetadata.push({ key, byteOffset, byteLength: body.byteLength });
    byteOffset += body.byteLength;
  }
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFloatGridEntriesBinary(`${tmp}.bin`, entries);
  await fs.promises.writeFile(
    `${tmp}.json`,
    JSON.stringify(cacheMetadataWithPayload(payload, { grids: gridMetadata })),
  );
  await fs.promises.rename(`${tmp}.bin`, `${cachePath}.bin`);
  await fs.promises.rename(`${tmp}.json`, `${cachePath}.json`);
}

async function writeFloatGridEntriesBinary(filePath, entries) {
  const handle = await fs.promises.open(filePath, "w");
  try {
    for (const [, values] of entries) {
      if (!(values instanceof Float32Array)) {
        continue;
      }
      const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
      await handle.write(body, 0, body.byteLength);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function computeCumulativeSnowfallGrids({ entries, targetHour, context, decoded }) {
  const step = await resolveSnowfallAccumulationStep(context, targetHour);
  if (!step) {
    return new Map();
  }
  const previous =
    step.startHour > 0
      ? await buildCachedCumulativeSnowfallGrids({ entries, targetHour: step.startHour, context, decoded })
      : new Map();
  const delta = await buildCachedDeltaSnowfallGrids({ entries, step, context, decoded });
  return mergeCumulativeSnowfallGrids({ entries, previous, delta, width: context.width, height: context.height });
}

async function computeIterativeCumulativeSnowfallGrids({ entries, targetHour, context, decoded }) {
  const step = await resolveSnowfallAccumulationStep(context, targetHour);
  if (!step) {
    return new Map();
  }
  let previous = new Map();
  if (step.startHour > 0) {
    previous =
      (await readCachedCumulativeSnowfallGridsForHour({
        entries,
        targetHour: step.startHour,
        context,
        countHit: true,
      })) || (await buildCachedCumulativeSnowfallGrids({ entries, targetHour: step.startHour, context, decoded }));
  }
  const delta = await buildCachedDeltaSnowfallGrids({ entries, step, context, decoded });
  return mergeCumulativeSnowfallGrids({ entries, previous, delta, width: context.width, height: context.height });
}

async function readCachedCumulativeSnowfallGridsForHour({ entries, targetHour, context, countHit = false }) {
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour) || hour <= 0) {
    return null;
  }
  const payload = cumulativeSnowfallCachePayload({ entries, targetHour: hour, context });
  const cachePath = cumulativeSnowfallGridCachePath(payload, context);
  const cached = await readCachedCumulativeSnowfallGrids(cachePath, payload);
  if (cached && countHit) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
  }
  return cached;
}

async function resolveSnowfallAccumulationStep(context, targetHour) {
  const target = Math.round(Number(targetHour));
  if (!Number.isFinite(target) || target <= 0) {
    return null;
  }
  const starts = context.availableHours
    .map((hour) => Math.round(Number(hour)))
    .filter((hour) => Number.isFinite(hour) && hour >= 0 && hour < target)
    .sort((left, right) => right - left);
  for (const startHour of starts) {
    const chunks = await resolveSnowfallLiquidChunksForWindow(context, startHour, target);
    if (chunks.length > 0) {
      if (startHour > 0) {
        const prefixChunks = await resolveSnowfallLiquidChunksForWindow(context, 0, startHour);
        if (prefixChunks.length === 0) {
          continue;
        }
      }
      return { startHour, endHour: target, chunks };
    }
  }
  return null;
}

async function buildDeltaSnowfallGrids({ entries, chunks, context, decoded }) {
  const sourceRefs = chunks.flatMap((chunk) => chunk.terms);
  const sourceGrids = await decodeSnowLiquidSourceGrids(sourceRefs, context);
  const liquidByChunk = buildSnowfallLiquidInByChunk(chunks, sourceGrids, context.width, context.height);
  sourceGrids.clear();
  const cellCount = Number(context.width) * Number(context.height);
  if (chunks.some((chunk) => !liquidByChunk.get(chunk.key) || liquidByChunk.get(chunk.key).length !== cellCount)) {
    liquidByChunk.clear();
    return buildUnknownSnowfallDeltaGrids(entries, cellCount);
  }
  const snowfallChunkDescriptors = buildLiquidChunkDescriptors({
    chunks,
    liquidByChunk,
    width: context.width,
    height: context.height,
    threshold: 0,
  });
  const positiveChunks = snowfallChunkDescriptors
    .filter((descriptor) => Number(descriptor.positiveCount) > 0)
    .map((descriptor) => descriptor.chunk);
  if (context.profile) {
    context.profile.snowfallIntervalCount = (Number(context.profile.snowfallIntervalCount) || 0) + chunks.length;
    context.profile.snowfallIntervalActiveCount =
      (Number(context.profile.snowfallIntervalActiveCount) || 0) + positiveChunks.length;
    context.profile.snowfallIntervalActiveCells =
      (Number(context.profile.snowfallIntervalActiveCells) || 0) +
      snowfallChunkDescriptors.reduce(
        (total, descriptor) => total + activeDescriptorCellCount(descriptor, context.width * context.height),
        0,
      );
    context.profile.snowfallIntervalSourceRefs =
      (Number(context.profile.snowfallIntervalSourceRefs) || 0) +
      chunks.reduce((total, chunk) => total + chunk.terms.length, 0);
  }
  if (snowfallChunkDescriptors.length === 0) {
    liquidByChunk.clear();
    return new Map();
  }
  let profilesByHour = null;
  try {
    profilesByHour = await decodeIntervalSnowfallProfiles({
      entries,
      chunks: positiveChunks,
      context,
      decoded,
    });
    return buildIntervalSnowfallGridsForEntries({
      entries,
      chunkDescriptors: snowfallChunkDescriptors,
      profilesByHour,
      decoded,
      bounds: context.bounds,
      width: context.width,
      height: context.height,
    });
  } finally {
    liquidByChunk.clear();
    profilesByHour?.clear?.();
  }
}

function buildUnknownSnowfallDeltaGrids(entries, cellCount) {
  const out = new Map();
  if (!Array.isArray(entries) || !Number.isFinite(cellCount) || cellCount <= 0) {
    return out;
  }
  for (const entry of entries) {
    if (entry?.key) {
      out.set(entry.key, new Float32Array(cellCount).fill(Number.NaN));
    }
  }
  return out;
}

function mergeCumulativeSnowfallGrids({ entries, previous, delta, width, height }) {
  const cellCount = Number(width) * Number(height);
  const out = new Map();
  if (!Number.isFinite(cellCount) || cellCount <= 0) {
    return out;
  }
  for (const entry of entries) {
    const previousGrid = previous.get(entry.key);
    const deltaGrid = delta.get(entry.key);
    if (previousGrid && deltaGrid) {
      out.set(entry.key, sumSnowfallGrids(previousGrid, deltaGrid, cellCount));
    } else if (previousGrid) {
      out.set(entry.key, previousGrid);
    } else if (deltaGrid) {
      out.set(entry.key, deltaGrid);
    }
  }
  return out;
}

function sumSnowfallGrids(previousGrid, deltaGrid, cellCount) {
  if (!previousGrid || !deltaGrid || previousGrid.length !== cellCount || deltaGrid.length !== cellCount) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const previous = Number(previousGrid[index]);
    const delta = Number(deltaGrid[index]);
    if (Number.isFinite(previous) && Number.isFinite(delta)) {
      out[index] = Math.max(0, previous) + Math.max(0, delta);
    }
  }
  return out;
}

async function decodeLazySnowfallProfileGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  hour,
  records,
  decoded,
  selection,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  profile = null,
  decodeSession = null,
}) {
  const available = new Set(selection?.availableParameters || []);
  const lazyEntries = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => {
    return entry.kind === "snowfallDerived" && entry.lazyProfile && available.has(entry.key);
  });
  const snowLiquidIn = buildSnowLiquidTotalInGrid(decoded, width, height);
  if (lazyEntries.length === 0 || !hasGridValueGreaterThan(snowLiquidIn, MIN_VISIBLE_SNOW_LIQUID_IN)) {
    return {};
  }
  const recordsByKey = {};
  const addRecord = (key, record) => {
    if (record && !decoded?.[key] && !recordsByKey[key]) {
      recordsByKey[key] = record;
    }
  };
  addProfileRecordsForEntries({ entries: lazyEntries, records, decoded, addRecord, skipDecoded: true });
  return decodeProfileRecordsForHour({
    recordsByKey,
    hour,
    context: {
      modelKey,
      modelConfig,
      baseUrl,
      date,
      cycle,
      tempDir,
      wgrib2Path,
      bounds,
      width,
      height,
      rangeFetchConcurrency,
      rangeFetchLimiter,
      decodeConcurrency,
      profileGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "derived-profile-grids") : null,
      profileSelectedGribCacheDir: selectedGribSharedCacheDir(rawCacheDir) || path.join(tempDir, "selected-grib-v2"),
      profile,
      decodeSession,
    },
  });
}

async function decodeProfileRecordsForHour({ recordsByKey, hour, context }) {
  const selectedRecords = Object.values(recordsByKey || {}).filter(Boolean);
  if (selectedRecords.length === 0) {
    return {};
  }
  const registered = readRegisteredProfileGrids({ recordsByKey, hour, context });
  if (registered) {
    return registered;
  }
  if (shouldUnionProfileDecode(context)) {
    const payload = profileGridCachePayload({ recordsByKey, hour, context });
    const cachePath = profileGridCachePath(payload, context);
    const cached = await readCachedProfileGrids(cachePath, payload);
    if (cached) {
      incrementProfileCounter(context.profile, "profileGridCacheHits");
      registerProfileGrids({ recordsByKey, hour, context, decoded: cached });
      return cached;
    }
    return enqueueUnionedProfileDecode({ recordsByKey, hour, context });
  }
  return decodeProfileRecordsForHourExact({ recordsByKey, hour, context });
}

async function decodeProfileRecordsForHourExact({ recordsByKey, hour, context }) {
  const selectedRecords = Object.values(recordsByKey || {}).filter(Boolean);
  if (selectedRecords.length === 0) {
    return {};
  }
  const registered = readRegisteredProfileGrids({ recordsByKey, hour, context });
  if (registered) {
    return registered;
  }
  const payload = profileGridCachePayload({ recordsByKey, hour, context });
  const decoded = await readOrDecodeCachedProfileGrids(payload, context, async () => {
    const decodedCached = readDecodedRecordsForKeyedRecords({ recordsByKey, hour, context });
    if (decodedCached) {
      return decodedCached;
    }
    await ensureSelectedRecordByteRangesForHour({
      context,
      hour,
      selectedRecords,
      profile: context.profile,
    });
    const selectedPlan = getSelectedRecordPlan(selectedRecords, context.decodeSession);
    const gribPath = await materializeSelectedGrib({
      modelKey: context.modelKey,
      productKey: context.modelConfig.productKey,
      gribUrl: buildNoaaGribUrl({
        modelKey: context.modelKey,
        baseUrl: context.baseUrl,
        date: context.date,
        cycle: context.cycle,
        hour,
      }),
      recordGroups: selectedPlan.groups,
      rawCacheDir: context.profileSelectedGribCacheDir || path.join(context.tempDir, "derived-profile-raw"),
      date: context.date,
      cycle: context.cycle,
      hour,
      cacheVersion: CATALOG_VERSION,
      rangeFetchConcurrency: context.rangeFetchConcurrency,
      rangeFetchLimiter: context.rangeFetchLimiter,
      profile: null,
      decodeSession: context.decodeSession,
    });
    const decodeTempDir = await fs.promises.mkdtemp(path.join(context.tempDir, `profile-${padHour(hour)}-`));
    const startedAt = performance.now();
    try {
      const decoded = await decodeSelectedRecordsToGrids({
        gribPath,
        selectedPlan,
        selection: { records: recordsByKey, catalog: [] },
        hour,
        tempDir: decodeTempDir,
        wgrib2Path: context.wgrib2Path,
        bounds: context.bounds,
        width: context.width,
        height: context.height,
        decodeConcurrency: context.decodeConcurrency,
        profile: null,
        decodeSession: context.decodeSession,
      });
      if (context.profile) {
        context.profile.profileRecordCount = (Number(context.profile.profileRecordCount) || 0) + selectedRecords.length;
      }
      return decoded;
    } finally {
      recordProfileStage(context.profile, "profileDecodeMs", startedAt);
      await fs.promises.rm(decodeTempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  registerProfileGrids({ recordsByKey, hour, context, decoded });
  return decoded;
}

function shouldUnionProfileDecode(context) {
  return Boolean(context?.decodeSession) && context.profileDecodeUnion !== false;
}

function enqueueUnionedProfileDecode({ recordsByKey, hour, context }) {
  const session = context.decodeSession;
  const batchKey = profileDecodeUnionBatchKey({ hour, context });
  let batch = session.profileDecodeBatches.get(batchKey);
  if (!batch) {
    batch = { hour, context, requests: [], scheduled: false };
    session.profileDecodeBatches.set(batchKey, batch);
  }
  const promise = new Promise((resolve, reject) => {
    batch.requests.push({ recordsByKey, resolve, reject });
  });
  if (!batch.scheduled) {
    batch.scheduled = true;
    scheduleProfileDecodeUnionFlush(() => runUnionedProfileDecodeBatch(session, batch));
  }
  return promise;
}

function scheduleProfileDecodeUnionFlush(callback) {
  if (typeof setImmediate === "function") {
    setImmediate(callback);
  } else {
    setTimeout(callback, 0);
  }
}

function profileDecodeUnionBatchKey({ hour, context }) {
  return JSON.stringify({
    modelKey: context?.modelKey || "",
    productKey: context?.modelConfig?.productKey || "",
    date: context?.date || "",
    cycle: context?.cycle || "",
    hour: Math.round(Number(hour)),
    width: context?.width,
    height: context?.height,
    bounds: context?.bounds || null,
    profileGridCacheDir: context?.profileGridCacheDir || "",
    profileSelectedGribCacheDir: profileSelectedGribCacheDir(context) || "",
  });
}

async function runUnionedProfileDecodeBatch(session, batch) {
  const batchKey = profileDecodeUnionBatchKey({ hour: batch.hour, context: batch.context });
  session.profileDecodeBatches.delete(batchKey);
  const requests = batch.requests.splice(0);
  const union = buildUnionedProfileDecodeRequest(requests);
  try {
    const decoded = await decodeProfileRecordsForHourExact({
      recordsByKey: union.recordsByKey,
      hour: batch.hour,
      context: { ...batch.context, profileDecodeUnion: false },
    });
    for (const request of requests) {
      const subset = {};
      const keyMap = union.requestKeyMaps.get(request) || new Map();
      for (const [requestedKey, unionKey] of keyMap) {
        if (decoded?.[unionKey]) {
          subset[requestedKey] = decoded[unionKey];
        }
      }
      request.resolve(subset);
    }
  } catch (error) {
    for (const request of requests) {
      request.reject(error);
    }
  }
}

function buildUnionedProfileDecodeRequest(requests) {
  const recordsByKey = {};
  const identityByKey = new Map();
  const requestKeyMaps = new Map();
  let conflictIndex = 0;
  const addRecord = (requestedKey, record) => {
    const identity = selectedRecordDecodeCacheKey(record);
    const existingIdentity = identityByKey.get(requestedKey);
    if (!existingIdentity || existingIdentity === identity) {
      recordsByKey[requestedKey] = record;
      identityByKey.set(requestedKey, identity);
      return requestedKey;
    }
    let unionKey;
    do {
      conflictIndex += 1;
      unionKey = `${requestedKey}__union${conflictIndex}`;
    } while (recordsByKey[unionKey]);
    recordsByKey[unionKey] = record;
    identityByKey.set(unionKey, identity);
    return unionKey;
  };
  for (const request of requests) {
    const keyMap = new Map();
    for (const [requestedKey, record] of Object.entries(request.recordsByKey || {})) {
      if (!record) {
        continue;
      }
      keyMap.set(requestedKey, addRecord(requestedKey, record));
    }
    requestKeyMaps.set(request, keyMap);
  }
  return { recordsByKey, requestKeyMaps };
}

function addProfileRecordsForEntries({ entries, records, decoded = null, addRecord, skipDecoded = false }) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0 || typeof addRecord !== "function") {
    return;
  }
  addSurfaceProfileRecords({ entries: list, records, decoded, addRecord, skipDecoded });
  for (const entry of list) {
    addPressureProfileRecordsForEntry({ entry, records, decoded, addRecord, skipDecoded });
  }
}

function addPressureProfileRecordsForEntry({ entry, records, decoded = null, addRecord, skipDecoded = false }) {
  if (!entry || typeof addRecord !== "function") {
    return;
  }
  for (const variable of entry.profileVariables || []) {
    for (const level of entry.profileLevels || SNOW_PROFILE_LEVELS) {
      const standardKey = standardProfileDecodeKey(variable, level);
      const profileKey = profileDecodeKey(variable, level);
      if (skipDecoded && ((standardKey && decoded?.[standardKey]) || decoded?.[profileKey])) {
        continue;
      }
      addProfileRecord({ addRecord, key: profileKey, record: findRecord(records, profileSelector(variable, level)) });
    }
  }
}

function profileSelectedGribCacheDir(context) {
  if (context?.profileSelectedGribCacheDir) {
    return context.profileSelectedGribCacheDir;
  }
  if (context?.sourceGribCacheDir) {
    return selectedGribSharedCacheDir(context.sourceGribCacheDir);
  }
  return context?.tempDir ? path.join(context.tempDir, SELECTED_GRIB_CACHE_DIRNAME) : null;
}

/*
 * The code below is shared by snowfall today and by future profile-derived
 * diagnostics such as DCAPE, effective shear, and terrain-aware lapse rates.
 */
async function materializeDecodedProfileGridsForHour({ recordsByKey, hour, context }) {
  return decodeProfileRecordsForHour({
    recordsByKey,
    hour,
    context: {
      ...context,
      profileSelectedGribCacheDir: profileSelectedGribCacheDir(context),
      profileDecodeUnion: context?.profileDecodeUnion !== false,
    },
  });
}

function buildSnowfallLiquidInByChunk(chunks, sourceGrids, width, height) {
  const out = new Map();
  for (const chunk of chunks) {
    const liquidIn = composePrecipAccumulationGrid(chunk.terms, sourceGrids, width, height, {
      outputScale: MM_TO_IN,
    });
    out.set(chunk.key, liquidIn);
  }
  return out;
}

async function decodeIntervalSnowfallProfiles({ entries, chunks, context, decoded }) {
  const profileEntries = entries.filter(
    (entry) => Array.isArray(entry.profileVariables) && entry.profileVariables.length > 0,
  );
  if (profileEntries.length === 0) {
    return new Map();
  }
  const profileHours = Array.from(new Set(chunks.map((chunk) => chunk.profileHour))).sort(
    (left, right) => left - right,
  );
  const pairs = await mapWithConcurrency(profileHours, decodeHourFanoutConcurrency(context, 6), async (hour) => {
    const records = await getNoaaRecordsForHour(context, hour);
    const baseDecoded = hour === context.targetHour ? decoded : {};
    const profileDecoded = await decodeSnowfallProfileGridsForHour({
      entries: profileEntries,
      hour,
      records,
      context,
      decoded: baseDecoded,
    });
    return [hour, { ...baseDecoded, ...profileDecoded }];
  });
  return new Map(pairs.filter(Boolean));
}

async function decodeSnowfallProfileGridsForHour({ entries, hour, records, context, decoded = null }) {
  const recordsByKey = {};
  const addRecord = (key, record) => {
    if (record && !decoded?.[key] && !recordsByKey[key]) {
      recordsByKey[key] = record;
    }
  };
  addProfileRecordsForEntries({ entries, records, decoded, addRecord, skipDecoded: true });
  return materializeDecodedProfileGridsForHour({ recordsByKey, hour, context });
}

async function decodeFramSurfaceProfiles({ chunks, context, decoded }) {
  const profileHours = Array.from(new Set((chunks || []).flatMap((chunk) => framProfileHoursForChunk(chunk, context))))
    .filter((hour) => Number.isFinite(Number(hour)))
    .sort((left, right) => left - right);
  if (profileHours.length === 0) {
    return new Map();
  }
  const pairs = await mapWithConcurrency(profileHours, decodeHourFanoutConcurrency(context, 6), async (hour) => {
    const records = await getNoaaRecordsForHour(context, hour);
    const baseDecoded = hour === context.targetHour ? decoded || {} : {};
    const profileDecoded = await decodeFramSurfaceGridsForHour({
      hour,
      records,
      context,
      decoded: baseDecoded,
    });
    return [hour, { ...baseDecoded, ...profileDecoded }];
  });
  return new Map(pairs.filter(Boolean));
}

function framProfileHoursForChunk(chunk, context = null) {
  const start = Math.round(Number(chunk?.startHour));
  const end = Math.round(Number(chunk?.endHour ?? chunk?.profileHour));
  const explicit = Array.isArray(chunk?.profileHours)
    ? chunk.profileHours.map((hour) => Math.round(Number(hour))).filter(Number.isFinite)
    : [];
  if (explicit.length > 0) {
    return Array.from(new Set(explicit)).sort((left, right) => left - right);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    const fallback = Math.round(Number(chunk?.profileHour));
    return Number.isFinite(fallback) ? [fallback] : [];
  }
  const source = Array.isArray(context?.availableHours) ? context.availableHours : [];
  const hours = source
    .map((hour) => Math.round(Number(hour)))
    .filter((hour) => Number.isFinite(hour) && hour > start && hour <= end)
    .sort((left, right) => left - right);
  if (!hours.includes(end)) {
    hours.push(end);
    hours.sort((left, right) => left - right);
  }
  return Array.from(new Set(hours));
}

async function decodeFramSurfaceGridsForHour({ hour, records, context, decoded = null }) {
  const recordsByKey = {};
  const addRecord = (key, record) => {
    if (record && !decoded?.[key] && !recordsByKey[key]) {
      recordsByKey[key] = record;
    }
  };
  addFramSurfaceRecords({ records, addRecord });
  return materializeDecodedProfileGridsForHour({ recordsByKey, hour, context });
}

function addFramSurfaceRecords({ records, addRecord }) {
  for (const variable of ["TMP", "DPT", "RH", "UGRD", "VGRD"]) {
    const key = PROFILE_SURFACE_DECODE_KEYS[variable];
    const selector = PROFILE_SURFACE_SELECTORS[variable];
    if (key && selector) {
      addProfileRecord({ addRecord, key, record: findRecord(records, selector) });
    }
  }
}

function profileGridCachePayload({ recordsByKey, hour, context }) {
  return {
    version: PROFILE_GRID_CACHE_VERSION,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    hour: Math.round(Number(hour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    records: Object.fromEntries(
      Object.entries(recordsByKey || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, record]) => [key, selectedPrecipRecordIdentity(record)]),
    ),
  };
}

function profileGridCachePath(payload, context) {
  const cacheDir = context?.profileGridCacheDir;
  if (!cacheDir || !payload) {
    return null;
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(payload.hour)}-${hash}`,
  );
}

async function readOrDecodeCachedProfileGrids(payload, context, decode) {
  const cachePath = profileGridCachePath(payload, context);
  const cacheKey = cachePath || crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const existing = PROFILE_GRID_PROMISE_CACHE.get(cacheKey);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    const cached = await readCachedProfileGrids(cachePath, payload);
    if (cached) {
      incrementProfileCounter(context.profile, "profileGridCacheHits");
      return cached;
    }
    if (cachePath) {
      const lockPath = `${cachePath}.lock`;
      const lockHandle = await tryAcquireGridCacheLock(lockPath, payload);
      if (!lockHandle) {
        const waited = await waitForCachedGrid({
          cachePath,
          payload,
          lockPath,
          context,
          read: readCachedProfileGrids,
          timeoutCounter: "profileGridLockTimeouts",
        });
        if (waited) {
          incrementProfileCounter(context.profile, "profileGridCacheHits");
          return waited;
        }
      } else {
        try {
          const cachedAfterLock = await readCachedProfileGrids(cachePath, payload);
          if (cachedAfterLock) {
            incrementProfileCounter(context.profile, "profileGridCacheHits");
            return cachedAfterLock;
          }
          incrementProfileCounter(context.profile, "profileGridCacheMisses");
          const decoded = await decode();
          await writeCachedProfileGrids(cachePath, payload, decoded);
          return decoded;
        } finally {
          await releaseGridCacheLock(lockPath, lockHandle);
        }
      }
    }
    incrementProfileCounter(context.profile, "profileGridCacheMisses");
    const decoded = await decode();
    await writeCachedProfileGrids(cachePath, payload, decoded);
    return decoded;
  })().finally(() => {
    PROFILE_GRID_PROMISE_CACHE.delete(cacheKey);
  });
  PROFILE_GRID_PROMISE_CACHE.set(cacheKey, promise);
  return promise;
}

async function readCachedProfileGrids(cachePath, expectedPayload) {
  if (!cachePath) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    if (!cacheMetadataPayloadMatches(metadata, expectedPayload)) {
      return null;
    }
    const body = await fs.promises.readFile(`${cachePath}.bin`);
    const out = {};
    for (const grid of metadata.grids || []) {
      const byteOffset = Number(grid.byteOffset);
      const byteLength = Number(grid.byteLength);
      const key = grid.key;
      if (
        !key ||
        !Number.isFinite(byteOffset) ||
        !Number.isFinite(byteLength) ||
        byteOffset < 0 ||
        byteLength < 0 ||
        byteOffset + byteLength > body.byteLength ||
        byteOffset % 4 !== 0 ||
        byteLength % 4 !== 0
      ) {
        return null;
      }
      out[key] = float32ArrayViewFromBuffer(body, byteOffset, byteLength);
    }
    return out;
  } catch {
    return null;
  }
}

async function writeCachedProfileGrids(cachePath, payload, decoded) {
  if (!cachePath || !decoded || typeof decoded !== "object") {
    return;
  }
  const entries = Object.entries(decoded).filter(([, values]) => values instanceof Float32Array);
  if (entries.length === 0) {
    return;
  }
  const grids = [];
  let byteOffset = 0;
  for (const [key, values] of entries) {
    const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    grids.push({ key, byteOffset, byteLength: body.byteLength });
    byteOffset += body.byteLength;
  }
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFloatGridEntriesBinary(`${tmp}.bin`, entries);
  await fs.promises.writeFile(`${tmp}.json`, JSON.stringify(cacheMetadataWithPayload(payload, { grids })));
  await fs.promises.rename(`${tmp}.bin`, `${cachePath}.bin`);
  await fs.promises.rename(`${tmp}.json`, `${cachePath}.json`);
}

function incrementProfileCounter(profile, key) {
  if (!profile || !key) {
    return;
  }
  profile[key] = (Number(profile[key]) || 0) + 1;
}

function addSurfaceProfileRecords({ entries, records, decoded = null, addRecord, skipDecoded = false }) {
  const variables = new Set(entries.flatMap((entry) => entry.profileVariables || []));
  addProfileRecord({
    addRecord,
    key: PROFILE_SURFACE_DECODE_KEYS.HGT,
    record: findRecord(records, PROFILE_SURFACE_SELECTORS.HGT),
    decoded,
    skipDecoded,
  });
  for (const variable of variables) {
    const key = PROFILE_SURFACE_DECODE_KEYS[variable];
    const selector = PROFILE_SURFACE_SELECTORS[variable];
    if (!key || !selector) {
      continue;
    }
    addProfileRecord({ addRecord, key, record: findRecord(records, selector), decoded, skipDecoded });
  }
}

function addProfileRecord({ addRecord, key, record, decoded = null, skipDecoded = false }) {
  if (!record || !key || typeof addRecord !== "function") {
    return;
  }
  if (skipDecoded && decoded?.[key]) {
    return;
  }
  addRecord(key, record);
}

function buildLiquidChunkDescriptors({ chunks, liquidByChunk, width, height, threshold = 0 }) {
  const cellCount = Number(width) * Number(height);
  if (!Number.isFinite(cellCount) || cellCount <= 0 || !Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }
  const out = [];
  for (const chunk of chunks) {
    const liquidIn = liquidByChunk?.get(chunk.key);
    if (!liquidIn || liquidIn.length !== cellCount) {
      continue;
    }
    const active = activeGridVisitIndicesGreaterThan(liquidIn, threshold);
    if (active.positiveCount > 0 || active.missingCount > 0) {
      out.push({
        chunk,
        liquidIn,
        activeIndices: active.indices,
        positiveCount: active.positiveCount,
        missingCount: active.missingCount,
      });
    }
  }
  return out;
}

function activeGridVisitIndicesGreaterThan(values, threshold) {
  if (!values) {
    return { indices: new Uint32Array(0), positiveCount: 0, missingCount: 0 };
  }
  const resolvedThreshold = Number.isFinite(Number(threshold)) ? Number(threshold) : 0;
  const denseLimit = Math.max(1, Math.floor(values.length * SPARSE_ACTIVE_GRID_MAX_FRACTION));
  let indices = new Uint32Array(Math.min(denseLimit, 4096));
  let indexCount = 0;
  let positiveCount = 0;
  let missingCount = 0;
  let overflowed = false;
  const trackIndex = (index) => {
    if (overflowed) {
      return;
    }
    if (indexCount >= denseLimit) {
      overflowed = true;
      return;
    }
    if (indexCount >= indices.length) {
      const next = new Uint32Array(Math.min(denseLimit, indices.length * 2));
      next.set(indices);
      indices = next;
    }
    indices[indexCount] = index;
    indexCount += 1;
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (Number.isFinite(value) && value > resolvedThreshold) {
      positiveCount += 1;
      trackIndex(index);
    } else if (!Number.isFinite(value)) {
      missingCount += 1;
      trackIndex(index);
    }
  }
  const activeCount = positiveCount + missingCount;
  return {
    indices: overflowed && activeCount > 0 ? null : indices.slice(0, indexCount),
    positiveCount,
    missingCount,
  };
}

function activeDescriptorCellCount(descriptor, cellCount) {
  return descriptor?.activeIndices === null ? cellCount : descriptor?.activeIndices?.length || 0;
}

function activeVisitCount(activeIndices, fallbackCount) {
  return activeIndices === null ? fallbackCount : activeIndices?.length || 0;
}

function activeVisitIndex(activeIndices, visitIndex) {
  return activeIndices === null ? visitIndex : activeIndices[visitIndex];
}

function buildIntervalSnowfallGrid({
  entry,
  chunks,
  chunkDescriptors = null,
  liquidByChunk,
  profilesByHour,
  decoded,
  bounds,
  width,
  height,
}) {
  const cellCount = Number(width) * Number(height);
  if (!Number.isFinite(cellCount) || cellCount <= 0) {
    return null;
  }
  const descriptors = Array.isArray(chunkDescriptors)
    ? chunkDescriptors
    : buildLiquidChunkDescriptors({ chunks, liquidByChunk, width, height, threshold: 0 });
  if (descriptors.length === 0) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(0);
  let hasChunk = false;
  for (const descriptor of descriptors) {
    const { chunk, liquidIn, activeIndices } = descriptor;
    if (!liquidIn || activeDescriptorCellCount(descriptor, cellCount) === 0) {
      return null;
    }
    const profileDecoded = profilesByHour.get(chunk.profileHour) || decoded;
    const added = addSnowfallGridForEntryToAccumulator({
      entry,
      out,
      decoded: profileDecoded,
      snowLiquidIn: liquidIn,
      activeIndices,
      bounds,
      width,
      height,
    });
    if (!added) {
      return null;
    }
    hasChunk = true;
  }
  return hasChunk ? out : null;
}

function buildIntervalSnowfallGridsForEntries({
  entries,
  chunkDescriptors,
  profilesByHour,
  decoded,
  bounds,
  width,
  height,
}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry?.key) : [];
  const descriptors = Array.isArray(chunkDescriptors) ? chunkDescriptors : [];
  const cellCount = Number(width) * Number(height);
  const out = new Map();
  if (list.length === 0 || descriptors.length === 0 || !Number.isFinite(cellCount) || cellCount <= 0) {
    return out;
  }
  const grids = new Map();
  for (const entry of list) {
    if (isSupportedIntervalSnowfallEntry(entry)) {
      grids.set(entry.key, new Float32Array(cellCount).fill(0));
    }
  }
  if (grids.size === 0) {
    return out;
  }
  const statesByDecoded = new WeakMap();
  let primitiveDecodedStates = null;

  for (const descriptor of descriptors) {
    const { chunk, liquidIn, activeIndices } = descriptor;
    if (!liquidIn || activeDescriptorCellCount(descriptor, cellCount) === 0) {
      return new Map();
    }
    const profileDecoded = profilesByHour.get(chunk.profileHour) || decoded;
    const states = getIntervalSnowfallEntryStates(profileDecoded);
    if (states.length !== grids.size) {
      return new Map();
    }
    const visitCount = activeVisitCount(activeIndices, cellCount);
    for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
      const index = activeVisitIndex(activeIndices, visitIndex);
      const liquid = Number(liquidIn[index]);
      if (!Number.isFinite(liquid)) {
        for (const state of states) {
          state.out[index] = Number.NaN;
        }
        continue;
      }
      if (liquid <= 0) {
        continue;
      }
      for (const state of states) {
        addIntervalSnowfallValueForState(state, index, liquid);
      }
    }
  }

  for (const [key, values] of grids) {
    out.set(key, values);
  }
  return out;

  function getIntervalSnowfallEntryStates(profileDecoded) {
    if (profileDecoded && typeof profileDecoded === "object") {
      const cached = statesByDecoded.get(profileDecoded);
      if (cached) {
        return cached;
      }
      const states = buildIntervalSnowfallEntryStates({
        entries: list,
        decoded: profileDecoded,
        bounds,
        width,
        height,
      });
      statesByDecoded.set(profileDecoded, states);
      return states;
    }
    if (!primitiveDecodedStates) {
      primitiveDecodedStates = buildIntervalSnowfallEntryStates({
        entries: list,
        decoded: profileDecoded || {},
        bounds,
        width,
        height,
      });
    }
    return primitiveDecodedStates;
  }

  function buildIntervalSnowfallEntryStates({ entries: stateEntries, decoded: profileDecoded, bounds, width, height }) {
    const states = [];
    for (const entry of stateEntries) {
      const outGrid = grids.get(entry.key);
      if (!outGrid) {
        continue;
      }
      const state = createIntervalSnowfallEntryState({
        entry,
        out: outGrid,
        decoded: profileDecoded,
        bounds,
        width,
        height,
      });
      if (!state) {
        return [];
      }
      states.push(state);
    }
    return states;
  }
}

function isSupportedIntervalSnowfallEntry(entry) {
  return (
    entry?.key === "snow10to1" ||
    entry?.key === "snowKuchera" ||
    entry?.key === "snowCobb" ||
    entry?.key === "snowRfConus" ||
    entry?.key === "snowWesternLinear"
  );
}

function createIntervalSnowfallEntryState({ entry, out, decoded, bounds, width, height }) {
  if (entry.key === "snow10to1") {
    return { key: entry.key, out, kind: "ratio", ratio: 10 };
  }
  if (entry.key === "snowKuchera") {
    return { key: entry.key, out, kind: "kuchera", sources: buildKucheraProfileSources(decoded) };
  }
  if (entry.key === "snowCobb") {
    return { key: entry.key, out, kind: "cobb", sources: buildCobbProfileSources(decoded) };
  }
  if (entry.key === "snowRfConus") {
    const model = loadSnowRfModel("conus");
    return model
      ? {
          key: entry.key,
          out,
          kind: "snowRfConus",
          model,
          decoded,
          bounds,
          width,
          height,
          scratch: createSnowFeatureScratch(PLETCHER_RF_FEATURE_KEYS.length, ["SPD", "TMP", "RH"]),
        }
      : null;
  }
  if (entry.key === "snowWesternLinear") {
    const model = loadWesternLinearSlrModel();
    return model
      ? {
          key: entry.key,
          out,
          kind: "snowWesternLinear",
          model,
          decoded,
          bounds,
          width,
          height,
          scratch: createSnowFeatureScratch(WESTERN_LINEAR_FEATURE_KEYS.length, ["TMP", "SPD"]),
        }
      : null;
  }
  return null;
}

function addIntervalSnowfallValueForState(state, index, liquid) {
  if (!state || Number.isNaN(state.out[index])) {
    return;
  }
  if (state.kind === "ratio") {
    state.out[index] += Math.max(0, liquid * state.ratio);
    return;
  }
  if (state.kind === "kuchera") {
    const ratio = calculateKucheraRatio(calculateWarmestProfileTempCFromSources(state.sources, index));
    state.out[index] = Number.isFinite(ratio) && ratio > 0 ? state.out[index] + liquid * ratio : Number.NaN;
    return;
  }
  if (state.kind === "cobb") {
    const ratio = calculateCobbSlrFromSources(state.sources, index);
    state.out[index] = Number.isFinite(ratio) && ratio > 0 ? state.out[index] + liquid * ratio : Number.NaN;
    return;
  }
  if (state.kind === "snowRfConus") {
    if (liquid <= MIN_VISIBLE_SNOW_LIQUID_IN) {
      return;
    }
    const features = buildPletcherRfFeatures({
      decoded: state.decoded,
      index,
      bounds: state.bounds,
      width: state.width,
      height: state.height,
      scratch: state.scratch,
    });
    if (!features) {
      state.out[index] = Number.NaN;
      return;
    }
    const slr = predictRandomForest(state.model, features);
    state.out[index] =
      Number.isFinite(slr) && slr > 0
        ? state.out[index] + liquid * Math.min(MAX_SNOW_TO_LIQUID_RATIO, Math.max(1, slr))
        : Number.NaN;
    return;
  }
  if (state.kind === "snowWesternLinear") {
    if (liquid <= MIN_VISIBLE_SNOW_LIQUID_IN) {
      return;
    }
    const features = buildWesternLinearFeatures({
      decoded: state.decoded,
      index,
      bounds: state.bounds,
      width: state.width,
      height: state.height,
      scratch: state.scratch,
    });
    if (!features) {
      state.out[index] = Number.NaN;
      return;
    }
    const slr = predictLinearSlr(state.model, features);
    state.out[index] =
      Number.isFinite(slr) && slr > 0
        ? state.out[index] + liquid * Math.min(MAX_SNOW_TO_LIQUID_RATIO, Math.max(1, slr))
        : Number.NaN;
  }
}

function buildSnowfallGridForEntry({ entry, decoded, snowLiquidIn, activeIndices = null, bounds, width, height }) {
  if (entry.key === "snow10to1") {
    return multiplySnowLiquidByRatio(snowLiquidIn, 10, activeIndices);
  }
  if (entry.key === "snowKuchera") {
    return buildKucheraSnowfallGrid(decoded, snowLiquidIn, width, height, { activeIndices });
  }
  if (entry.key === "snowCobb") {
    return buildCobbSnowfallGrid(decoded, snowLiquidIn, width, height, { activeIndices });
  }
  if (entry.key === "snowRfConus") {
    return buildSnowRfConusSnowfallGrid({ decoded, snowLiquidIn, activeIndices, bounds, width, height });
  }
  if (entry.key === "snowWesternLinear") {
    return buildWesternLinearSnowfallGrid({ decoded, snowLiquidIn, activeIndices, bounds, width, height });
  }
  return null;
}

function addSnowfallGridForEntryToAccumulator({
  entry,
  out,
  decoded,
  snowLiquidIn,
  activeIndices,
  bounds,
  width,
  height,
}) {
  if (!out || !snowLiquidIn || activeIndices === undefined) {
    return false;
  }
  if (entry.key === "snow10to1") {
    addRatioSnowfallToAccumulator({ out, snowLiquidIn, ratio: 10, activeIndices });
    return true;
  }
  if (entry.key === "snowKuchera") {
    addKucheraSnowfallToAccumulator({ out, decoded, snowLiquidIn, activeIndices });
    return true;
  }
  if (entry.key === "snowCobb") {
    addCobbSnowfallToAccumulator({ out, decoded, snowLiquidIn, activeIndices });
    return true;
  }
  if (entry.key === "snowRfConus") {
    return addSnowRfConusSnowfallToAccumulator({ out, decoded, snowLiquidIn, activeIndices, bounds, width, height });
  }
  if (entry.key === "snowWesternLinear") {
    return addWesternLinearSnowfallToAccumulator({ out, decoded, snowLiquidIn, activeIndices, bounds, width, height });
  }
  return false;
}

async function resolveSnowLiquidTotalPlan(context) {
  const endHour = Math.round(Number(context.targetHour));
  if (!Number.isFinite(endHour) || endHour <= 0 || !context.availableHourSet.has(endHour)) {
    return null;
  }
  const cumulative = await buildCumulativeSnowLiquidPlan(context, endHour);
  if (cumulative.length > 0) {
    return { terms: cumulative };
  }
  const summed = await buildSnowLiquidIntervalSumPlan(context, 0, endHour);
  return summed.length > 0 ? { terms: summed.map((interval) => snowLiquidTerm(interval, 1)) } : null;
}

async function buildCumulativeSnowLiquidPlan(context, endHour) {
  const targetHour = Math.round(Number(endHour));
  if (!Number.isFinite(targetHour) || targetHour <= 0 || !context.availableHourSet.has(targetHour)) {
    return [];
  }
  const cacheKey = String(targetHour);
  if (context.snowLiquidCumulativePlanCache?.has(cacheKey)) {
    return context.snowLiquidCumulativePlanCache.get(cacheKey);
  }
  let terms = [];
  const directWeasd = await findExactSnowLiquidInterval(context, 0, targetHour, { kind: "weasd" });
  if (directWeasd) {
    terms = [snowLiquidTerm(directWeasd, 1)];
  } else {
    const intervals = await getSnowLiquidIntervalsForHour(context, targetHour);
    const candidates = intervals
      .filter(
        (interval) => interval.endHour === targetHour && interval.startHour >= 0 && interval.startHour < targetHour,
      )
      .sort(compareSnowLiquidEndingIntervalPriority);
    for (const interval of candidates) {
      const prefix = interval.startHour === 0 ? [] : await buildCumulativeSnowLiquidPlan(context, interval.startHour);
      if (interval.startHour === 0 || prefix.length > 0) {
        terms = mergeWeightedSnowLiquidTerms(prefix, [snowLiquidTerm(interval, 1)]);
        break;
      }
    }
    if (terms.length === 0) {
      const summed = await buildSnowLiquidIntervalSumPlan(context, 0, targetHour);
      terms = summed.map((interval) => snowLiquidTerm(interval, 1));
    }
  }
  context.snowLiquidCumulativePlanCache?.set(cacheKey, terms);
  return terms;
}

async function findExactSnowLiquidInterval(context, startHour, endHour, options = {}) {
  const intervals = await getSnowLiquidIntervalsForHour(context, endHour);
  const kind = options.kind ? String(options.kind) : null;
  return (
    intervals
      .filter(
        (interval) =>
          interval.startHour === startHour && interval.endHour === endHour && (!kind || interval.kind === kind),
      )
      .sort(compareSnowLiquidIntervalPriority)[0] || null
  );
}

async function buildSnowLiquidIntervalSumPlan(context, startHour, endHour) {
  const cacheKey = `${Math.round(Number(startHour))}:${Math.round(Number(endHour))}`;
  if (context.snowLiquidIntervalSumPlanCache?.has(cacheKey)) {
    return context.snowLiquidIntervalSumPlanCache.get(cacheKey);
  }
  const intervals = [];
  for (const hour of context.availableHours.filter((candidate) => candidate > startHour && candidate <= endHour)) {
    intervals.push(...(await getSnowLiquidIntervalsForHour(context, hour)));
  }
  const usable = intervals.filter((interval) => {
    return interval.startHour >= startHour && interval.endHour <= endHour && interval.endHour > interval.startHour;
  });
  const terms = findSnowLiquidIntervalPath(usable, startHour, endHour);
  context.snowLiquidIntervalSumPlanCache?.set(cacheKey, terms);
  return terms;
}

async function resolveSnowfallLiquidChunks(context, endHour) {
  return resolveSnowfallLiquidChunksForWindow(context, 0, endHour);
}

async function resolveSnowfallLiquidChunksForWindow(context, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const targetHour = Math.round(Number(endHour));
  const cacheKey = `${start}:${targetHour}`;
  if (context?.snowfallLiquidChunksByWindow?.has(cacheKey)) {
    return context.snowfallLiquidChunksByWindow.get(cacheKey);
  }
  const promise = resolveSnowfallLiquidChunksForWindowUncached(context, start, targetHour).catch((error) => {
    context?.snowfallLiquidChunksByWindow?.delete(cacheKey);
    throw error;
  });
  context?.snowfallLiquidChunksByWindow?.set(cacheKey, promise);
  return promise;
}

async function resolveSnowfallLiquidChunksForWindowUncached(context, start, targetHour) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(targetHour) ||
    start < 0 ||
    targetHour <= start ||
    !context.availableHourSet.has(targetHour)
  ) {
    return [];
  }
  const candidates = [];
  const cumulativeWeasdByHour = new Map();
  const sourceHours = context.availableHours.filter((candidate) => {
    return candidate <= targetHour && (candidate > start || (start > 0 && candidate === start));
  });
  const intervalsByHour = await mapWithConcurrency(sourceHours, metadataFanoutConcurrency(context, 8), async (hour) => [
    hour,
    await getSnowLiquidIntervalsForHour(context, hour),
  ]);
  for (const [hour, intervals] of intervalsByHour) {
    const directWeasd = intervals
      .filter((interval) => interval.kind === "weasd" && interval.startHour === 0 && interval.endHour === hour)
      .sort(compareSnowLiquidIntervalPriority)[0];
    if (directWeasd) {
      cumulativeWeasdByHour.set(hour, directWeasd);
    }
    if (hour <= start) {
      continue;
    }
    for (const interval of intervals) {
      if (interval.startHour < start || interval.endHour > targetHour || interval.endHour <= interval.startHour) {
        continue;
      }
      candidates.push(
        snowfallLiquidChunkFromTerms({
          kind: interval.kind,
          startHour: interval.startHour,
          endHour: interval.endHour,
          terms: [snowLiquidTerm(interval, 1)],
        }),
      );
    }
  }
  const cumulativeHours =
    cumulativeWeasdByHour.has(start) || start === 0
      ? [
          start,
          ...Array.from(cumulativeWeasdByHour.keys())
            .filter((hour) => hour > start)
            .sort((left, right) => left - right),
        ]
      : [];
  for (let index = 1; index < cumulativeHours.length; index += 1) {
    const startHour = cumulativeHours[index - 1];
    const chunkEndHour = cumulativeHours[index];
    const endInterval = cumulativeWeasdByHour.get(chunkEndHour);
    if (!endInterval) {
      continue;
    }
    const terms = [snowLiquidTerm(endInterval, 1)];
    if (startHour > 0) {
      const startInterval = cumulativeWeasdByHour.get(startHour);
      if (!startInterval) {
        continue;
      }
      terms.push(snowLiquidTerm(startInterval, -1));
    }
    candidates.push(
      snowfallLiquidChunkFromTerms({
        kind: "weasdDelta",
        startHour,
        endHour: chunkEndHour,
        terms,
      }),
    );
  }
  return findSnowfallLiquidChunkPath(candidates, start, targetHour);
}

function snowfallLiquidChunkFromTerms({ kind, startHour, endHour, terms }) {
  const start = Math.round(Number(startHour));
  const end = Math.round(Number(endHour));
  return {
    key: `snowfall-liquid:${kind}:${start}-${end}:${terms.map((term) => `${term.sourceKey}:${term.weight}`).join("|")}`,
    kind,
    startHour: start,
    endHour: end,
    profileHour: end,
    terms,
  };
}

async function getSnowLiquidIntervalsForHour(context, hour) {
  const targetHour = Math.round(Number(hour));
  if (!context.availableHourSet.has(targetHour)) {
    return [];
  }
  if (context.snowLiquidIntervalsByHour?.has(targetHour)) {
    return context.snowLiquidIntervalsByHour.get(targetHour);
  }
  const records = await getNoaaRecordsForHour(context, targetHour);
  const intervals = [];
  for (const record of records) {
    if (!isSurfaceAccumulatedSnowWaterRecord(record) && !isSurfacePrecipRecord(record)) {
      continue;
    }
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour < window.startHour) {
      continue;
    }
    if (isSurfaceAccumulatedSnowWaterRecord(record)) {
      intervals.push({
        kind: "weasd",
        hour: targetHour,
        record,
        startHour: window.startHour,
        endHour: window.endHour,
      });
    } else {
      const intervalMaskRecords = findExactAverageSnowMaskRecords(records, window.startHour, window.endHour);
      const maskSamples = intervalMaskRecords
        ? []
        : await buildSnowMaskSamplesForInterval(context, window.startHour, window.endHour);
      if (!intervalMaskRecords && maskSamples.length === 0) {
        continue;
      }
      intervals.push({
        kind: "apcpSnow",
        hour: targetHour,
        record,
        maskTargetKey: "snow",
        maskRecords: intervalMaskRecords || null,
        maskSamples,
        startHour: window.startHour,
        endHour: window.endHour,
      });
    }
  }
  context.snowLiquidIntervalsByHour?.set(targetHour, intervals);
  return intervals;
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

async function buildSnowMaskSamplesForInterval(context, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const end = Math.round(Number(endHour));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [];
  }
  const sampleHours = context.availableHours
    .map((hour) => Math.round(Number(hour)))
    .filter((hour) => Number.isFinite(hour) && hour > start && hour <= end)
    .sort((left, right) => left - right);
  if (!sampleHours.includes(end) && context.availableHourSet.has(end)) {
    sampleHours.push(end);
    sampleHours.sort((left, right) => left - right);
  }
  const sampled = await mapWithConcurrency(sampleHours, metadataFanoutConcurrency(context, 8), async (sampleHour) => {
    const records = await getNoaaRecordsForHour(context, sampleHour);
    const maskRecords = {
      snow: findRecord(records, SNOW_SOURCE_SELECTORS.snow),
      rain: findRecord(records, SNOW_SOURCE_SELECTORS.rain),
      freezingRain: findRecord(records, SNOW_SOURCE_SELECTORS.freezingRain),
      icePellets: findRecord(records, SNOW_SOURCE_SELECTORS.icePellets),
    };
    return hasCompletePhaseMaskRecordSet(maskRecords) ? { hour: sampleHour, maskRecords } : null;
  });
  if (sampled.length === 0 || sampled.some((sample) => !sample)) {
    return [];
  }
  const out = [];
  let previousHour = start;
  for (const sample of sampled) {
    out.push({
      hour: sample.hour,
      weight: Math.max(0, sample.hour - previousHour),
      ...sample.maskRecords,
    });
    previousHour = sample.hour;
  }
  return previousHour === end ? out : [];
}

function hasCompletePhaseMaskRecordSet(maskRecords) {
  return SNOW_MASK_TYPE_KEYS.every((key) => Boolean(maskRecords?.[key]));
}

async function resolveDirectFreezingRainLiquidChunksForWindow(context, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const targetHour = Math.round(Number(endHour));
  const cacheKey = `${start}:${targetHour}`;
  if (context?.freezingRainDirectChunksByWindow?.has(cacheKey)) {
    return context.freezingRainDirectChunksByWindow.get(cacheKey);
  }
  const promise = resolveDirectFreezingRainLiquidChunksForWindowUncached(context, start, targetHour).catch((error) => {
    context?.freezingRainDirectChunksByWindow?.delete(cacheKey);
    throw error;
  });
  context?.freezingRainDirectChunksByWindow?.set(cacheKey, promise);
  return promise;
}

async function resolveDirectFreezingRainLiquidChunksForWindowUncached(context, start, targetHour) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(targetHour) ||
    start < 0 ||
    targetHour <= start ||
    !context.availableHourSet.has(targetHour)
  ) {
    return [];
  }
  const targetIntervals = await getDirectFreezingRainLiquidIntervalsForHour(context, targetHour);
  if (
    !targetIntervals.some((interval) => {
      return interval.startHour >= start && interval.endHour === targetHour && interval.endHour > interval.startHour;
    })
  ) {
    return [];
  }
  const sourceHours = context.availableHours.filter((candidate) => {
    return candidate <= targetHour && (candidate > start || (start > 0 && candidate === start));
  });
  const intervalsByHour = await mapWithConcurrency(sourceHours, metadataFanoutConcurrency(context, 8), async (hour) => [
    hour,
    await getDirectFreezingRainLiquidIntervalsForHour(context, hour),
  ]);
  const candidates = [];
  const cumulativeFrzrByHour = new Map();
  for (const [hour, intervals] of intervalsByHour) {
    const directFrzr = intervals
      .filter((interval) => interval.kind === "frzr" && interval.startHour === 0 && interval.endHour === hour)
      .sort(compareFreezingRainLiquidIntervalPriority)[0];
    if (directFrzr) {
      cumulativeFrzrByHour.set(hour, directFrzr);
    }
    if (hour <= start) {
      continue;
    }
    for (const interval of intervals) {
      if (interval.startHour < start || interval.endHour > targetHour || interval.endHour <= interval.startHour) {
        continue;
      }
      candidates.push(
        snowfallLiquidChunkFromTerms({
          kind: interval.kind,
          startHour: interval.startHour,
          endHour: interval.endHour,
          terms: [snowLiquidTerm(interval, 1)],
        }),
      );
    }
  }
  const cumulativeHours =
    cumulativeFrzrByHour.has(start) || start === 0
      ? [
          start,
          ...Array.from(cumulativeFrzrByHour.keys())
            .filter((hour) => hour > start)
            .sort((left, right) => left - right),
        ]
      : [];
  for (let index = 1; index < cumulativeHours.length; index += 1) {
    const startHour = cumulativeHours[index - 1];
    const chunkEndHour = cumulativeHours[index];
    const endInterval = cumulativeFrzrByHour.get(chunkEndHour);
    if (!endInterval) {
      continue;
    }
    const terms = [snowLiquidTerm(endInterval, 1)];
    if (startHour > 0) {
      const startInterval = cumulativeFrzrByHour.get(startHour);
      if (!startInterval) {
        continue;
      }
      terms.push(snowLiquidTerm(startInterval, -1));
    }
    candidates.push(
      snowfallLiquidChunkFromTerms({
        kind: "frzrDelta",
        startHour,
        endHour: chunkEndHour,
        terms,
      }),
    );
  }
  return findSnowfallLiquidChunkPath(candidates, start, targetHour);
}

async function resolveFreezingRainLiquidChunksForWindow(context, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const targetHour = Math.round(Number(endHour));
  const cacheKey = `${start}:${targetHour}`;
  if (context?.freezingRainLiquidChunksByWindow?.has(cacheKey)) {
    return context.freezingRainLiquidChunksByWindow.get(cacheKey);
  }
  const promise = resolveFreezingRainLiquidChunksForWindowUncached(context, start, targetHour).catch((error) => {
    context?.freezingRainLiquidChunksByWindow?.delete(cacheKey);
    throw error;
  });
  context?.freezingRainLiquidChunksByWindow?.set(cacheKey, promise);
  return promise;
}

async function resolveFreezingRainLiquidChunksForWindowUncached(context, start, targetHour) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(targetHour) ||
    start < 0 ||
    targetHour <= start ||
    !context.availableHourSet.has(targetHour)
  ) {
    return [];
  }
  const candidates = [];
  const cumulativeFrzrByHour = new Map();
  const sourceHours = context.availableHours.filter((candidate) => {
    return candidate <= targetHour && (candidate > start || (start > 0 && candidate === start));
  });
  const intervalsByHour = await mapWithConcurrency(sourceHours, metadataFanoutConcurrency(context, 8), async (hour) => [
    hour,
    await getFreezingRainLiquidIntervalsForHour(context, hour),
  ]);
  for (const [hour, intervals] of intervalsByHour) {
    const directFrzr = intervals
      .filter((interval) => interval.kind === "frzr" && interval.startHour === 0 && interval.endHour === hour)
      .sort(compareFreezingRainLiquidIntervalPriority)[0];
    if (directFrzr) {
      cumulativeFrzrByHour.set(hour, directFrzr);
    }
    if (hour <= start) {
      continue;
    }
    for (const interval of intervals) {
      if (interval.startHour < start || interval.endHour > targetHour || interval.endHour <= interval.startHour) {
        continue;
      }
      candidates.push(
        snowfallLiquidChunkFromTerms({
          kind: interval.kind,
          startHour: interval.startHour,
          endHour: interval.endHour,
          terms: [snowLiquidTerm(interval, 1)],
        }),
      );
    }
  }
  const cumulativeHours =
    cumulativeFrzrByHour.has(start) || start === 0
      ? [
          start,
          ...Array.from(cumulativeFrzrByHour.keys())
            .filter((hour) => hour > start)
            .sort((left, right) => left - right),
        ]
      : [];
  for (let index = 1; index < cumulativeHours.length; index += 1) {
    const startHour = cumulativeHours[index - 1];
    const chunkEndHour = cumulativeHours[index];
    const endInterval = cumulativeFrzrByHour.get(chunkEndHour);
    if (!endInterval) {
      continue;
    }
    const terms = [snowLiquidTerm(endInterval, 1)];
    if (startHour > 0) {
      const startInterval = cumulativeFrzrByHour.get(startHour);
      if (!startInterval) {
        continue;
      }
      terms.push(snowLiquidTerm(startInterval, -1));
    }
    candidates.push(
      snowfallLiquidChunkFromTerms({
        kind: "frzrDelta",
        startHour,
        endHour: chunkEndHour,
        terms,
      }),
    );
  }
  return findSnowfallLiquidChunkPath(candidates, start, targetHour);
}

async function warmFreezingRainAccumulationRunPlanner(context, targetHour) {
  if (!context) {
    return [];
  }
  if (context.freezingRainAccumulationPlannerReady) {
    return context.freezingRainAccumulationChunksByTarget || [];
  }
  context.freezingRainAccumulationPlannerReady = true;
  const target = Math.round(Number(targetHour ?? context.targetHour));
  if (!Number.isFinite(target) || target <= 0) {
    context.freezingRainAccumulationChunksByTarget = [];
    return [];
  }
  const chunks = await resolveFreezingRainLiquidChunksForWindow(context, 0, target);
  context.freezingRainAccumulationChunksByTarget = chunks;
  return chunks;
}

async function getFreezingRainLiquidIntervalsForHour(context, hour) {
  const targetHour = Math.round(Number(hour));
  if (!context.availableHourSet.has(targetHour)) {
    return [];
  }
  if (context.freezingRainLiquidIntervalsByHour?.has(targetHour)) {
    return context.freezingRainLiquidIntervalsByHour.get(targetHour);
  }
  const directIntervals = await getDirectFreezingRainLiquidIntervalsForHour(context, targetHour);
  const directWindowKeys = new Set(directIntervals.map((interval) => `${interval.startHour}:${interval.endHour}`));
  const records = await getNoaaRecordsForHour(context, targetHour);
  const intervals = [...directIntervals];
  for (const record of records) {
    if (!isSurfacePrecipRecord(record)) {
      continue;
    }
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour < window.startHour) {
      continue;
    }
    if (directWindowKeys.has(`${window.startHour}:${window.endHour}`)) {
      continue;
    }
    const intervalMaskRecords = findExactAverageSnowMaskRecords(records, window.startHour, window.endHour);
    const maskSamples = intervalMaskRecords
      ? []
      : await buildSnowMaskSamplesForInterval(context, window.startHour, window.endHour);
    if (!intervalMaskRecords && maskSamples.length === 0) {
      continue;
    }
    intervals.push({
      kind: "apcpFreezingRain",
      hour: targetHour,
      record,
      maskTargetKey: "freezingRain",
      maskRecords: intervalMaskRecords || null,
      maskSamples,
      startHour: window.startHour,
      endHour: window.endHour,
    });
  }
  intervals.sort(compareFreezingRainLiquidIntervalPriority);
  context.freezingRainLiquidIntervalsByHour?.set(targetHour, intervals);
  return intervals;
}

async function getDirectFreezingRainLiquidIntervalsForHour(context, hour) {
  const targetHour = Math.round(Number(hour));
  if (!context.availableHourSet.has(targetHour)) {
    return [];
  }
  if (context.freezingRainDirectIntervalsByHour?.has(targetHour)) {
    return context.freezingRainDirectIntervalsByHour.get(targetHour);
  }
  const records = await getNoaaRecordsForHour(context, targetHour);
  const intervals = [];
  for (const record of records) {
    if (!isSurfaceAccumulatedFreezingRainRecord(record)) {
      continue;
    }
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour < window.startHour) {
      continue;
    }
    intervals.push({
      kind: "frzr",
      hour: targetHour,
      record,
      startHour: window.startHour,
      endHour: window.endHour,
    });
  }
  intervals.sort(compareFreezingRainLiquidIntervalPriority);
  context.freezingRainDirectIntervalsByHour?.set(targetHour, intervals);
  return intervals;
}

function compareFreezingRainLiquidIntervalPriority(left, right) {
  const leftKind = left?.kind === "frzr" ? 0 : 1;
  const rightKind = right?.kind === "frzr" ? 0 : 1;
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  return (right?.endHour || 0) - (left?.endHour || 0);
}

function compareSnowLiquidIntervalPriority(left, right) {
  const leftKind = left?.kind === "weasd" ? 0 : 1;
  const rightKind = right?.kind === "weasd" ? 0 : 1;
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  return (right?.endHour || 0) - (left?.endHour || 0);
}

function compareSnowLiquidEndingIntervalPriority(left, right) {
  const leftKind = left?.kind === "weasd" ? 0 : 1;
  const rightKind = right?.kind === "weasd" ? 0 : 1;
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  if (left?.kind === "weasd" && right?.kind === "weasd") {
    return (left?.startHour || 0) - (right?.startHour || 0);
  }
  return (right?.startHour || 0) - (left?.startHour || 0);
}

function compareSnowLiquidPathIntervalPriority(left, right) {
  const leftKind = left?.kind === "weasd" ? 0 : 1;
  const rightKind = right?.kind === "weasd" ? 0 : 1;
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  if (left?.kind === "weasd" && right?.kind === "weasd") {
    return (right?.endHour || 0) - (left?.endHour || 0);
  }
  return (left?.endHour || 0) - (right?.endHour || 0);
}

function findSnowLiquidIntervalPath(intervals, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const end = Math.round(Number(endHour));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [];
  }
  const byStart = new Map();
  for (const interval of intervals || []) {
    const intervalStart = Math.round(Number(interval?.startHour));
    const intervalEnd = Math.round(Number(interval?.endHour));
    if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) {
      continue;
    }
    const group = byStart.get(intervalStart) || [];
    group.push(interval);
    byStart.set(intervalStart, group);
  }
  for (const group of byStart.values()) {
    group.sort(compareSnowLiquidPathIntervalPriority);
  }
  const memo = new Map();
  const search = (cursor) => {
    if (cursor === end) {
      return [];
    }
    if (cursor > end) {
      return null;
    }
    if (memo.has(cursor)) {
      return memo.get(cursor);
    }
    for (const interval of byStart.get(cursor) || []) {
      if (interval.endHour > end) {
        continue;
      }
      const tail = search(interval.endHour);
      if (tail) {
        const path = [interval, ...tail];
        memo.set(cursor, path);
        return path;
      }
    }
    memo.set(cursor, null);
    return null;
  };
  return search(start) || [];
}

function compareSnowfallLiquidChunkPriority(left, right) {
  const leftKind = snowfallLiquidChunkKindRank(left?.kind);
  const rightKind = snowfallLiquidChunkKindRank(right?.kind);
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  const leftDuration = Math.max(0, (left?.endHour || 0) - (left?.startHour || 0));
  const rightDuration = Math.max(0, (right?.endHour || 0) - (right?.startHour || 0));
  if (leftDuration !== rightDuration) {
    return leftDuration - rightDuration;
  }
  return (left?.endHour || 0) - (right?.endHour || 0);
}

function snowfallLiquidChunkKindRank(kind) {
  if (kind === "weasdDelta" || kind === "frzrDelta") {
    return 0;
  }
  if (kind === "weasd" || kind === "frzr") {
    return 1;
  }
  if (kind === "apcpSnow" || kind === "apcpFreezingRain") {
    return 2;
  }
  return 3;
}

function findSnowfallLiquidChunkPath(chunks, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const end = Math.round(Number(endHour));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [];
  }
  const byStart = new Map();
  for (const chunk of chunks || []) {
    if (!chunk || chunk.startHour < start || chunk.endHour > end || chunk.endHour <= chunk.startHour) {
      continue;
    }
    const group = byStart.get(chunk.startHour) || [];
    group.push(chunk);
    byStart.set(chunk.startHour, group);
  }
  for (const group of byStart.values()) {
    group.sort(compareSnowfallLiquidChunkPriority);
  }
  const memo = new Map();
  const search = (cursor) => {
    if (cursor === end) {
      return [];
    }
    if (cursor > end) {
      return null;
    }
    if (memo.has(cursor)) {
      return memo.get(cursor);
    }
    for (const chunk of byStart.get(cursor) || []) {
      const tail = search(chunk.endHour);
      if (tail) {
        const path = [chunk, ...tail];
        memo.set(cursor, path);
        return path;
      }
    }
    memo.set(cursor, null);
    return null;
  };
  return search(start) || [];
}

function mergeWeightedSnowLiquidTerms(...termLists) {
  const merged = new Map();
  for (const terms of termLists) {
    for (const term of terms || []) {
      const weight = Number(term.weight) || 0;
      if (!term?.sourceKey || weight === 0) {
        continue;
      }
      const existing = merged.get(term.sourceKey);
      if (existing) {
        existing.weight += weight;
      } else {
        merged.set(term.sourceKey, { ...term, weight });
      }
    }
  }
  return Array.from(merged.values()).filter((term) => Math.abs(Number(term.weight) || 0) > 1e-9);
}

function snowLiquidTerm(interval, weight) {
  return {
    sourceKey: snowLiquidSourceKey(interval),
    kind: interval.kind,
    hour: interval.hour,
    record: interval.record,
    maskTargetKey: interval.maskTargetKey || null,
    maskRecords: interval.maskRecords || null,
    maskSamples: interval.maskSamples || null,
    weight,
  };
}

function snowLiquidSourceKey(interval) {
  const mask = interval?.maskRecords || {};
  const maskToken = ["snow", "rain", "freezingRain", "icePellets"].map((key) => mask[key]?.record || "").join(".");
  const sampleToken = (interval?.maskSamples || [])
    .map(
      (sample) =>
        `${Math.round(Number(sample?.hour))}:${Number(sample?.weight) || 0}:${[
          "snow",
          "rain",
          "freezingRain",
          "icePellets",
        ]
          .map((key) => sample?.[key]?.record || "")
          .join(".")}`,
    )
    .join("|");
  return `snow-liquid:${interval?.kind || "unknown"}:${interval?.maskTargetKey || ""}:${Math.round(Number(interval?.hour))}:${
    interval?.record?.record || ""
  }:${interval?.record?.forecast || ""}:${maskToken}:${sampleToken}`;
}

async function decodeSnowLiquidSourceGrids(sourceRefs, context) {
  const unique = new Map();
  for (const ref of sourceRefs) {
    if (!unique.has(ref.sourceKey)) {
      unique.set(ref.sourceKey, ref);
    }
  }
  const out = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;
  const prefix = context.sourceProfilePrefix || "snowLiquid";
  for (const [sourceKey, values] of context.sourceGridOverrides?.entries() || []) {
    const ref = unique.get(sourceKey);
    if (ref && values) {
      out.set(sourceKey, values);
      registerSourceGrid({
        family: "snowLiquid",
        payload: snowLiquidSourceGridCachePayload(ref, context),
        context,
        values,
      });
      unique.delete(sourceKey);
      cacheHits += 1;
    }
  }
  const registeredPairs = await mapWithConcurrency(
    [...unique.entries()],
    metadataFanoutConcurrency(context, 16),
    async ([sourceKey, ref]) => [
      sourceKey,
      await readRegisteredSourceGrid({
        family: "snowLiquid",
        payload: snowLiquidSourceGridCachePayload(ref, context),
        context,
        counterKey: `${prefix}SourceRegistryHits`,
      }),
    ],
  );
  for (const [sourceKey, registered] of registeredPairs) {
    if (registered && unique.has(sourceKey)) {
      out.set(sourceKey, registered);
      unique.delete(sourceKey);
      cacheHits += 1;
    }
  }
  const cachedPairs = await mapWithConcurrency(
    [...unique.entries()],
    metadataFanoutConcurrency(context, 16),
    async ([sourceKey, ref]) => [sourceKey, await readCachedSnowLiquidSourceGrid(ref, context)],
  );
  for (const [sourceKey, cached] of cachedPairs) {
    if (cached && unique.has(sourceKey)) {
      const ref = unique.get(sourceKey);
      out.set(sourceKey, cached);
      registerSourceGrid({
        family: "snowLiquid",
        payload: snowLiquidSourceGridCachePayload(ref, context),
        context,
        values: cached,
      });
      unique.delete(sourceKey);
      cacheHits += 1;
    }
  }
  const byHour = new Map();
  for (const ref of unique.values()) {
    const group = byHour.get(ref.hour) || [];
    group.push(ref);
    byHour.set(ref.hour, group);
  }
  await mapWithConcurrency([...byHour.entries()], decodeHourFanoutConcurrency(context, 6), async ([hour, refs]) => {
    let refsToDecode = refs;
    const lockPath = snowLiquidSourceHourLockPath(hour, context);
    const lockHandle = lockPath ? await tryAcquireGridCacheLock(lockPath, { hour, count: refs.length }) : null;
    if (lockPath && !lockHandle) {
      const waited = await waitForCachedSnowLiquidHourSources(refs, context, lockPath);
      for (const [key, values] of waited.entries()) {
        out.set(key, values);
        const ref = refs.find((candidate) => candidate.sourceKey === key) || null;
        if (ref) {
          registerSourceGrid({
            family: "snowLiquid",
            payload: snowLiquidSourceGridCachePayload(ref, context),
            context,
            values,
          });
        }
      }
      cacheHits += waited.size;
      refsToDecode = refs.filter((ref) => !waited.has(ref.sourceKey));
    }
    if (refsToDecode.length === 0) {
      return;
    }
    const decodeLockHandle =
      lockHandle || (lockPath ? await tryAcquireGridCacheLock(lockPath, { hour, count: refsToDecode.length }) : null);
    const decodedResult = decodeLockHandle
      ? await decodeSnowLiquidHourSourcesWithLock(hour, refsToDecode, context, lockPath, decodeLockHandle)
      : {
          grids: await decodeSnowLiquidHourSources(hour, refsToDecode, context),
          decodedKeys: new Set(refsToDecode.map((ref) => ref.sourceKey)),
          cacheHits: 0,
          cacheMisses: refsToDecode.length,
        };
    cacheHits += decodedResult.cacheHits;
    cacheMisses += decodedResult.cacheMisses;
    const writes = [];
    for (const [key, values] of decodedResult.grids.entries()) {
      out.set(key, values);
      const ref = refs.find((candidate) => candidate.sourceKey === key) || null;
      if (ref) {
        registerSourceGrid({
          family: "snowLiquid",
          payload: snowLiquidSourceGridCachePayload(ref, context),
          context,
          values,
        });
      }
      if (ref && decodedResult.decodedKeys.has(key)) {
        writes.push({ ref, values });
      }
    }
    await mapWithConcurrency(writes, metadataFanoutConcurrency(context, 8), ({ ref, values }) =>
      writeCachedSnowLiquidSourceGrid(ref, values, context),
    );
  });
  if (context.profile) {
    context.profile[`${prefix}SourceCount`] = cacheHits + cacheMisses;
    context.profile[`${prefix}GridCacheHits`] = cacheHits;
    context.profile[`${prefix}GridCacheMisses`] = cacheMisses;
  }
  return out;
}

async function decodeSnowLiquidHourSourcesWithLock(hour, refs, context, lockPath, lockHandle) {
  try {
    const cached = await readCachedSnowLiquidHourSources(refs, context);
    const refsToDecode = refs.filter((ref) => !cached.has(ref.sourceKey));
    if (refsToDecode.length === 0) {
      return { grids: cached, decodedKeys: new Set(), cacheHits: cached.size, cacheMisses: 0 };
    }
    const decoded = await decodeSnowLiquidHourSources(hour, refsToDecode, context);
    const decodedKeys = new Set();
    for (const [key, values] of decoded.entries()) {
      cached.set(key, values);
      decodedKeys.add(key);
    }
    return {
      grids: cached,
      decodedKeys,
      cacheHits: cached.size - decodedKeys.size,
      cacheMisses: refsToDecode.length,
    };
  } finally {
    await releaseGridCacheLock(lockPath, lockHandle);
  }
}

async function decodeSnowLiquidHourSources(hour, refs, context) {
  const recordsByHour = new Map();
  const keyByHourRecord = new Map();
  const decodeKeysBySource = new Map();
  const assignRecordKey = (record, suffix, sourceHour = hour) => {
    if (!record) {
      return null;
    }
    const resolvedHour = Math.round(Number(sourceHour));
    const identity = `${resolvedHour}:${record.record || `${record.param}:${record.level}:${record.forecast}`}`;
    if (keyByHourRecord.has(identity)) {
      return keyByHourRecord.get(identity);
    }
    const recordsByKey = recordsByHour.get(resolvedHour) || {};
    const key = `snowLiquid${padHour(resolvedHour)}_${Object.keys(recordsByKey).length}_${suffix}`;
    keyByHourRecord.set(identity, key);
    recordsByKey[key] = record;
    recordsByHour.set(resolvedHour, recordsByKey);
    return key;
  };
  for (const ref of refs) {
    const decodeKeys = { water: assignRecordKey(ref.record, ref.kind === "weasd" ? "weasd" : "apcp") };
    if (ref.maskTargetKey) {
      const samples =
        Array.isArray(ref.maskSamples) && ref.maskSamples.length > 0
          ? ref.maskSamples
          : [{ hour, weight: 1, ...(ref.maskRecords || {}) }];
      decodeKeys.maskSamples = samples.map((sample, index) => ({
        weight: Number(sample?.weight) || 0,
        snow: assignRecordKey(sample?.snow, `sample${index}_snow`, sample?.hour),
        rain: assignRecordKey(sample?.rain, `sample${index}_rain`, sample?.hour),
        freezingRain: assignRecordKey(sample?.freezingRain, `sample${index}_freezingRain`, sample?.hour),
        icePellets: assignRecordKey(sample?.icePellets, `sample${index}_icePellets`, sample?.hour),
      }));
    }
    decodeKeysBySource.set(ref.sourceKey, decodeKeys);
  }
  const decoded = {};
  await mapWithConcurrency(
    [...recordsByHour.entries()],
    decodeHourFanoutConcurrency(context, 6),
    async ([sourceHour, recordsByKey]) => {
      const selectedRecords = Object.values(recordsByKey).filter(Boolean);
      if (selectedRecords.length === 0) {
        return;
      }
      const cached = readDecodedRecordsForKeyedRecords({
        recordsByKey,
        hour: sourceHour,
        context,
        categoricalPrecipTypeInterpolation: false,
      });
      if (cached) {
        Object.assign(decoded, cached);
        return;
      }
      await ensureSelectedRecordByteRangesForHour({
        context,
        hour: sourceHour,
        selectedRecords,
        profile: context.profile,
      });
      const selectedPlan = getSelectedRecordPlan(selectedRecords, context.decodeSession);
      const selection = { records: recordsByKey, catalog: [] };
      const gribUrl = buildNoaaGribUrl({
        modelKey: context.modelKey,
        baseUrl: context.baseUrl,
        date: context.date,
        cycle: context.cycle,
        hour: sourceHour,
      });
      const gribPath = await materializeSelectedGrib({
        modelKey: context.modelKey,
        productKey: context.modelConfig.productKey,
        gribUrl,
        recordGroups: selectedPlan.groups,
        rawCacheDir: context.sourceGribCacheDir || path.join(context.tempDir, SELECTED_GRIB_CACHE_DIRNAME),
        date: context.date,
        cycle: context.cycle,
        hour: sourceHour,
        cacheVersion: CATALOG_VERSION,
        rangeFetchConcurrency: context.rangeFetchConcurrency,
        rangeFetchLimiter: context.rangeFetchLimiter,
        profile: null,
        decodeSession: context.decodeSession,
      });
      const decodeTempDir = await fs.promises.mkdtemp(
        path.join(context.tempDir, `snow-liquid-${padHour(sourceHour)}-`),
      );
      Object.assign(
        decoded,
        await decodeSelectedRecordsToGrids({
          gribPath,
          selectedPlan,
          selection,
          hour: sourceHour,
          tempDir: decodeTempDir,
          wgrib2Path: context.wgrib2Path,
          bounds: context.bounds,
          width: context.width,
          height: context.height,
          decodeConcurrency: context.decodeConcurrency,
          categoricalPrecipTypeInterpolation: false,
          profile: null,
          decodeSession: context.decodeSession,
        }).finally(() => fs.promises.rm(decodeTempDir, { recursive: true, force: true }).catch(() => {})),
      );
    },
  );
  const out = new Map();
  for (const ref of refs) {
    const decodeKeys = decodeKeysBySource.get(ref.sourceKey) || {};
    if (!ref.maskTargetKey) {
      if (decoded[decodeKeys.water]) {
        out.set(ref.sourceKey, decoded[decodeKeys.water]);
      }
      continue;
    }
    const grid = composePhaseMaskedPrecipGrid({
      precipMm: decoded[decodeKeys.water],
      maskSamples: (decodeKeys.maskSamples || []).map((sample) => ({
        weight: sample.weight,
        snow: decoded[sample.snow],
        rain: decoded[sample.rain],
        freezingRain: decoded[sample.freezingRain],
        icePellets: decoded[sample.icePellets],
      })),
      targetType: ref.maskTargetKey || "snow",
      width: context.width,
      height: context.height,
    });
    if (grid) {
      out.set(ref.sourceKey, grid);
    }
  }
  return out;
}

function composeSnowMaskedPrecipGrid(options) {
  return composePhaseMaskedPrecipGrid({ ...options, targetType: "snow" });
}

function composePhaseMaskedPrecipGrid({
  precipMm,
  snow,
  rain,
  freezingRain,
  icePellets,
  maskSamples,
  targetType = "snow",
  width,
  height,
}) {
  const cellCount = Number(width) * Number(height);
  const samples =
    Array.isArray(maskSamples) && maskSamples.length > 0
      ? maskSamples
      : [{ weight: 1, snow, rain, freezingRain, icePellets }];
  if (!precipMm || precipMm.length !== cellCount || samples.length === 0) {
    return null;
  }
  if (samples.length === 1) {
    return composeSingleSamplePhaseMaskedPrecipGrid({
      precipMm,
      sample: samples[0],
      targetType,
      cellCount,
    });
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const precip = Number(precipMm[index]);
    if (!Number.isFinite(precip)) {
      continue;
    }
    if (precip <= 0) {
      out[index] = 0;
      continue;
    }
    const phaseFraction = calculateIntervalPhaseFraction(samples, index, cellCount, targetType);
    if (!Number.isFinite(phaseFraction)) {
      continue;
    }
    if (phaseFraction <= 0) {
      out[index] = 0;
      continue;
    }
    out[index] = precip * phaseFraction;
  }
  return out;
}

function composeSingleSamplePhaseMaskedPrecipGrid({ precipMm, sample, targetType, cellCount }) {
  const snowValues = sample?.snow;
  const rainValues = sample?.rain;
  const freezingRainValues = sample?.freezingRain;
  const icePelletsValues = sample?.icePellets;
  if (
    !snowValues ||
    snowValues.length !== cellCount ||
    !rainValues ||
    rainValues.length !== cellCount ||
    !freezingRainValues ||
    freezingRainValues.length !== cellCount ||
    !icePelletsValues ||
    icePelletsValues.length !== cellCount
  ) {
    return composePhaseMaskedPrecipGridGeneric({ precipMm, samples: [sample], targetType, cellCount });
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  const targetValues =
    targetType === "freezingRain"
      ? freezingRainValues
      : targetType === "rain"
        ? rainValues
        : targetType === "icePellets"
          ? icePelletsValues
          : snowValues;
  for (let index = 0; index < cellCount; index += 1) {
    const precip = Number(precipMm[index]);
    if (!Number.isFinite(precip)) {
      continue;
    }
    if (precip <= 0) {
      out[index] = 0;
      continue;
    }
    const snow = Number(snowValues[index]);
    const rain = Number(rainValues[index]);
    const freezingRain = Number(freezingRainValues[index]);
    const icePellets = Number(icePelletsValues[index]);
    if (
      !Number.isFinite(snow) ||
      !Number.isFinite(rain) ||
      !Number.isFinite(freezingRain) ||
      !Number.isFinite(icePellets)
    ) {
      continue;
    }
    const targetValue = Number(targetValues[index]);
    const phaseAmount = Number.isFinite(targetValue) ? clamp01(targetValue) : 0;
    if (phaseAmount <= 0) {
      out[index] = 0;
      continue;
    }
    const activeTotal = clamp01(snow) + clamp01(rain) + clamp01(freezingRain) + clamp01(icePellets);
    out[index] = activeTotal > 0 ? precip * Math.max(0, Math.min(1, phaseAmount / activeTotal)) : 0;
  }
  return out;
}

function composePhaseMaskedPrecipGridGeneric({ precipMm, samples, targetType, cellCount }) {
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const precip = Number(precipMm[index]);
    if (!Number.isFinite(precip)) {
      continue;
    }
    if (precip <= 0) {
      out[index] = 0;
      continue;
    }
    const phaseFraction = calculateIntervalPhaseFraction(samples, index, cellCount, targetType);
    if (!Number.isFinite(phaseFraction)) {
      continue;
    }
    if (phaseFraction <= 0) {
      out[index] = 0;
      continue;
    }
    out[index] = precip * phaseFraction;
  }
  return out;
}

function calculateIntervalPhaseFraction(samples, index, cellCount, targetType = "snow") {
  let weightedPhase = 0;
  let totalWeight = 0;
  for (const sample of samples || []) {
    const weight = Number(sample?.weight);
    const resolvedWeight = Number.isFinite(weight) && weight > 0 ? weight : 1;
    const fraction = calculatePhaseMaskFraction(sample, index, cellCount, targetType);
    if (!Number.isFinite(fraction)) {
      continue;
    }
    weightedPhase += fraction * resolvedWeight;
    totalWeight += resolvedWeight;
  }
  return totalWeight > 0 ? weightedPhase / totalWeight : Number.NaN;
}

function calculatePhaseMaskFraction(sample, index, cellCount, targetType = "snow") {
  const snow = maskValueAt(sample?.snow, index, cellCount);
  const rain = maskValueAt(sample?.rain, index, cellCount);
  const freezingRain = maskValueAt(sample?.freezingRain, index, cellCount);
  const icePellets = maskValueAt(sample?.icePellets, index, cellCount);
  let activeTotal = 0;
  let validCount = 0;
  if (Number.isFinite(snow)) {
    activeTotal += clamp01(snow);
    validCount += 1;
  }
  if (Number.isFinite(rain)) {
    activeTotal += clamp01(rain);
    validCount += 1;
  }
  if (Number.isFinite(freezingRain)) {
    activeTotal += clamp01(freezingRain);
    validCount += 1;
  }
  if (Number.isFinite(icePellets)) {
    activeTotal += clamp01(icePellets);
    validCount += 1;
  }
  if (validCount !== SNOW_MASK_TYPE_KEYS.length) {
    return Number.NaN;
  }
  let targetValue;
  if (targetType === "freezingRain") {
    targetValue = freezingRain;
  } else if (targetType === "rain") {
    targetValue = rain;
  } else if (targetType === "icePellets") {
    targetValue = icePellets;
  } else {
    targetValue = snow;
  }
  const phaseAmount = Number.isFinite(targetValue) ? clamp01(targetValue) : 0;
  if (phaseAmount <= 0) {
    return 0;
  }
  return activeTotal > 0 ? Math.max(0, Math.min(1, phaseAmount / activeTotal)) : 0;
}

function maskValueAt(values, index, cellCount) {
  if (!values || values.length !== cellCount) {
    return Number.NaN;
  }
  const value = Number(values[index]);
  return Number.isFinite(value) ? value : Number.NaN;
}

function buildSnowLiquidSourceGridOverrides({ targetHour, decoded, selection, records }) {
  const out = new Map();
  if (!decoded || !selection?.records || !Array.isArray(records)) {
    return out;
  }
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour)) {
    return out;
  }
  for (const record of records) {
    if (!isSurfaceAccumulatedSnowWaterRecord(record) && !isSurfacePrecipAccumulationRecord(record)) {
      continue;
    }
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour !== hour) {
      continue;
    }
    if (isSurfaceAccumulatedSnowWaterRecord(record)) {
      const values = decodedGridForRecord(decoded, selection, record);
      if (values) {
        out.set(snowLiquidSourceKey({ kind: "weasd", hour, record }), values);
      }
      continue;
    }
    // APCP+ptype snowfall masks need bilinear, fractional treatment. The main
    // frame decode keeps precip-type fields categorical for display, so decode
    // these snow-liquid sources separately instead of reusing display masks.
  }
  return out;
}

function buildFreezingRainLiquidSourceGridOverrides({ targetHour, decoded, selection, records }) {
  const out = new Map();
  if (!decoded || !selection?.records || !Array.isArray(records)) {
    return out;
  }
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour)) {
    return out;
  }
  for (const record of records) {
    if (!isSurfaceAccumulatedFreezingRainRecord(record)) {
      continue;
    }
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour !== hour) {
      continue;
    }
    const values = decodedGridForRecord(decoded, selection, record);
    if (values) {
      out.set(snowLiquidSourceKey({ kind: "frzr", hour, record }), values);
    }
  }
  return out;
}

function sumLiquidChunksIn(chunks, liquidByChunk, width, height) {
  const cellCount = Number(width) * Number(height);
  if (!Number.isFinite(cellCount) || cellCount <= 0 || !Array.isArray(chunks) || chunks.length === 0) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(0);
  let hasFinite = false;
  for (const chunk of chunks) {
    const values = liquidByChunk.get(chunk.key);
    if (!values || values.length !== cellCount) {
      return null;
    }
    for (let index = 0; index < cellCount; index += 1) {
      if (Number.isNaN(out[index])) {
        continue;
      }
      const value = Number(values[index]);
      if (Number.isFinite(value)) {
        out[index] += Math.max(0, value);
        hasFinite = true;
      } else {
        out[index] = Number.NaN;
      }
    }
  }
  return hasFinite ? out : null;
}

function zeroGridForFiniteSource(values) {
  const out = new Float32Array(values?.length || 0).fill(Number.NaN);
  for (let index = 0; index < out.length; index += 1) {
    if (Number.isFinite(Number(values[index]))) {
      out[index] = 0;
    }
  }
  return out;
}

function decodedGridForRecord(decoded, selection, record) {
  if (!record || !decoded || !selection?.records) {
    return null;
  }
  for (const [key, selectedRecord] of Object.entries(selection.records)) {
    if (recordsMatch(selectedRecord, record) && decoded[key]) {
      return decoded[key];
    }
  }
  return null;
}

function recordsMatch(left, right) {
  if (!left || !right) {
    return false;
  }
  return (
    left === right ||
    (left.record === right.record &&
      left.param === right.param &&
      left.level === right.level &&
      left.forecast === right.forecast)
  );
}

function snowLiquidSourceGridCachePath(ref, context) {
  const cacheDir = context?.sourceGridCacheDir;
  if (!cacheDir || !ref?.record) {
    return null;
  }
  const payload = snowLiquidSourceGridCachePayload(ref, context);
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(ref.hour)}-${hash}.f32`,
  );
}

function snowLiquidSourceGridCachePayload(ref, context) {
  return {
    version: SNOW_LIQUID_GRID_CACHE_VERSION,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    hour: Math.round(Number(ref.hour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    kind: ref.kind,
    maskTargetKey: ref.maskTargetKey || null,
    record: selectedPrecipRecordIdentity(ref.record),
    maskRecords: Object.fromEntries(
      Object.entries(ref.maskRecords || {}).map(([key, record]) => [key, selectedPrecipRecordIdentity(record)]),
    ),
    maskSamples: (ref.maskSamples || []).map(snowMaskSampleIdentity),
  };
}

function snowLiquidSourceHourLockPath(hour, context) {
  const cacheDir = context?.sourceGridCacheDir;
  if (!cacheDir) {
    return null;
  }
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(hour)}.lock`,
  );
}

async function waitForCachedSnowLiquidHourSources(refs, context, lockPath) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < GRID_CACHE_LOCK_TIMEOUT_MS) {
    await sleep(GRID_CACHE_LOCK_POLL_MS + Math.round(Math.random() * 40));
    const cached = await readCachedSnowLiquidHourSources(refs, context);
    if (cached.size === refs.length) {
      return cached;
    }
    const lockExists = await pathExists(lockPath);
    if (!lockExists) {
      return cached;
    }
  }
  incrementProfileCounter(context.profile, "snowLiquidGridLockTimeouts");
  return readCachedSnowLiquidHourSources(refs, context);
}

async function readCachedSnowLiquidHourSources(refs, context) {
  const pairs = await mapWithConcurrency(refs, metadataFanoutConcurrency(context, 16), async (ref) => [
    ref.sourceKey,
    await readCachedSnowLiquidSourceGrid(ref, context),
  ]);
  const out = new Map();
  for (const [sourceKey, cached] of pairs) {
    if (cached) {
      out.set(sourceKey, cached);
    }
  }
  return out;
}

async function readCachedSnowLiquidSourceGrid(ref, context) {
  const cachePath = snowLiquidSourceGridCachePath(ref, context);
  if (!cachePath) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    const expected = snowLiquidSourceGridCachePayload(ref, context);
    if (!directCacheMetadataPayloadMatches(metadata, expected)) {
      return null;
    }
    const body = await fs.promises.readFile(cachePath);
    const expectedBytes = Number(context.width) * Number(context.height) * 4;
    if (body.length !== expectedBytes) {
      return null;
    }
    return float32ArrayViewFromBuffer(body, 0, body.byteLength);
  } catch {
    return null;
  }
}

async function writeCachedSnowLiquidSourceGrid(ref, values, context) {
  const cachePath = snowLiquidSourceGridCachePath(ref, context);
  if (!cachePath || !values || values.length !== Number(context.width) * Number(context.height)) {
    return;
  }
  const metadata = snowLiquidSourceGridCachePayload(ref, context);
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpJson = `${tmp}.json`;
  const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  await fs.promises.writeFile(tmp, body);
  await fs.promises.writeFile(tmpJson, JSON.stringify(cacheMetadataWithPayload(metadata)));
  await fs.promises.rename(tmp, cachePath);
  await fs.promises.rename(tmpJson, `${cachePath}.json`);
}

function resolveAvailableForecastHours(latestMetadata, targetHour, modelKey = null) {
  const candidates = latestMetadata?.rawLatest?.hours || latestMetadata?.noaa?.hours || latestMetadata?.hours || [];
  const hours = Array.isArray(candidates)
    ? candidates.map((hour) => Math.round(Number(hour))).filter((hour) => Number.isFinite(hour) && hour >= 0)
    : [];
  hours.push(...buildPrecipSourceForecastHours(modelKey || latestMetadata?.modelKey, targetHour));
  if (!hours.includes(Number(targetHour))) {
    hours.push(Number(targetHour));
  }
  if (!hours.includes(0)) {
    hours.push(0);
  }
  return Array.from(new Set(hours)).sort((left, right) => left - right);
}

function buildPrecipSourceForecastHours(modelKey, targetHour) {
  const target = Math.max(0, Math.round(Number(targetHour)));
  if (!Number.isFinite(target)) {
    return [];
  }
  const normalizedModel = String(modelKey || "").toLowerCase();
  const hours = [];
  if (normalizedModel === "gfs") {
    const hourlyLimit = Math.min(target, 120);
    for (let hour = 0; hour <= hourlyLimit; hour += 1) {
      hours.push(hour);
    }
    for (let hour = 123; hour <= target; hour += 3) {
      hours.push(hour);
    }
    return hours;
  }
  for (let hour = 0; hour <= target; hour += 1) {
    hours.push(hour);
  }
  return hours;
}

async function warmPrecipAccumulationRunPlanner(context) {
  if (!context) {
    return new Map();
  }
  if (context.runAccumulationPlannerReady) {
    return context.runAccumulationPlansByKey || new Map();
  }
  context.runAccumulationPlannerReady = true;
  const plans = context.runAccumulationPlansByKey || new Map();
  context.runAccumulationPlansByKey = plans;
  for (const entry of getPrecipAccumulationEntries()) {
    const plan = await resolvePrecipAccumulationPlan(entry, context);
    plans.set(entry.key, plan);
  }
  return plans;
}

async function resolvePrecipAccumulationPlan(entry, context) {
  const cacheKey = precipAccumulationPlanCacheKey(entry, context);
  if (cacheKey && context?.precipAccumulationPlanCache?.has(cacheKey)) {
    return context.precipAccumulationPlanCache.get(cacheKey);
  }
  const plan = await resolvePrecipAccumulationPlanUncached(entry, context);
  if (cacheKey) {
    context?.precipAccumulationPlanCache?.set(cacheKey, plan);
  }
  return plan;
}

function precipAccumulationPlanCacheKey(entry, context) {
  const key = entry?.key || "";
  const endHour = Math.round(Number(context?.targetHour));
  if (!key || !Number.isFinite(endHour)) {
    return null;
  }
  return [
    key,
    entry?.accumulationMode || "",
    Number.isFinite(Number(entry?.accumulationWindowHours)) ? Math.round(Number(entry.accumulationWindowHours)) : "",
    endHour,
  ].join(":");
}

async function resolvePrecipAccumulationPlanUncached(entry, context) {
  const endHour = Math.round(Number(context.targetHour));
  const isTotal = entry.accumulationMode === "total";
  const windowHours = Number(entry.accumulationWindowHours);
  if (!Number.isFinite(endHour) || endHour <= 0) {
    return null;
  }
  if (!isTotal && !Number.isFinite(windowHours)) {
    return null;
  }
  const startHour = isTotal ? 0 : Math.max(0, endHour - windowHours);
  if (!context.availableHourSet.has(endHour)) {
    return null;
  }

  const direct = await findExactPrecipInterval(context, startHour, endHour);
  if (direct) {
    return { terms: [precipTerm(direct, 1)] };
  }

  const cumulativeEnd = await buildCumulativePrecipPlan(context, endHour);
  if (cumulativeEnd.length > 0) {
    if (startHour === 0) {
      return { terms: cumulativeEnd };
    }
    const cumulativeStart = await buildCumulativePrecipPlan(context, startHour);
    if (cumulativeStart.length > 0) {
      return {
        terms: mergeWeightedPrecipTerms(
          cumulativeEnd,
          cumulativeStart.map((term) => ({ ...term, weight: -term.weight })),
        ),
      };
    }
  }

  const summed = await buildPrecipIntervalSumPlan(context, startHour, endHour);
  return summed.length > 0 ? { terms: summed.map((interval) => precipTerm(interval, 1)) } : null;
}

async function buildCumulativePrecipPlan(context, endHour) {
  const targetHour = Math.round(Number(endHour));
  if (!Number.isFinite(targetHour) || targetHour <= 0 || !context.availableHourSet.has(targetHour)) {
    return [];
  }
  const cacheKey = String(targetHour);
  if (context.cumulativePlanCache?.has(cacheKey)) {
    return context.cumulativePlanCache.get(cacheKey);
  }
  let terms = [];
  const direct = await findExactPrecipInterval(context, 0, targetHour);
  if (direct) {
    terms = [precipTerm(direct, 1)];
  } else {
    const endingInterval = await findBestPrecipIntervalEndingAt(context, targetHour);
    if (endingInterval) {
      const prefix = await buildCumulativePrecipPlan(context, endingInterval.startHour);
      if (prefix.length > 0 || endingInterval.startHour === 0) {
        terms = mergeWeightedPrecipTerms(prefix, [precipTerm(endingInterval, 1)]);
      }
    }
    if (terms.length === 0) {
      const summed = await buildPrecipIntervalSumPlan(context, 0, targetHour);
      terms = summed.map((interval) => precipTerm(interval, 1));
    }
  }
  context.cumulativePlanCache?.set(cacheKey, terms);
  return terms;
}

function mergeWeightedPrecipTerms(...termLists) {
  const merged = new Map();
  for (const terms of termLists) {
    for (const term of terms || []) {
      const weight = Number(term.weight) || 0;
      if (!term?.sourceKey || weight === 0) {
        continue;
      }
      const existing = merged.get(term.sourceKey);
      if (existing) {
        existing.weight += weight;
      } else {
        merged.set(term.sourceKey, { ...term, weight });
      }
    }
  }
  return Array.from(merged.values()).filter((term) => Math.abs(Number(term.weight) || 0) > 1e-9);
}

function precipTerm(interval, weight) {
  return {
    sourceKey: precipSourceKey(interval.hour, interval.record),
    hour: interval.hour,
    record: interval.record,
    weight,
  };
}

async function findExactPrecipInterval(context, startHour, endHour) {
  const intervals = await getPrecipIntervalsForHour(context, endHour);
  return intervals.find((interval) => interval.startHour === startHour && interval.endHour === endHour) || null;
}

async function findBestPrecipIntervalEndingAt(context, endHour) {
  const targetHour = Math.round(Number(endHour));
  if (!Number.isFinite(targetHour) || targetHour <= 0) {
    return null;
  }
  const intervals = await getPrecipIntervalsForHour(context, targetHour);
  return (
    intervals
      .filter(
        (interval) => interval.endHour === targetHour && interval.startHour >= 0 && interval.startHour < targetHour,
      )
      .sort((left, right) => left.startHour - right.startHour)[0] || null
  );
}

async function buildPrecipIntervalSumPlan(context, startHour, endHour) {
  const cacheKey = `${Math.round(Number(startHour))}:${Math.round(Number(endHour))}`;
  if (context.intervalSumPlanCache?.has(cacheKey)) {
    return context.intervalSumPlanCache.get(cacheKey);
  }
  const hours = context.availableHours.filter((hour) => hour > startHour && hour <= endHour);
  const intervals = [];
  for (const hour of hours) {
    intervals.push(...(await getPrecipIntervalsForHour(context, hour)));
  }
  const usable = intervals.filter((interval) => {
    return interval.startHour >= startHour && interval.endHour <= endHour && interval.endHour > interval.startHour;
  });
  const terms = [];
  let cursor = startHour;
  while (cursor < endHour) {
    const candidates = usable
      .filter((interval) => interval.startHour === cursor && interval.endHour > cursor)
      .sort((left, right) => right.endHour - left.endHour);
    const selected = candidates[0] || null;
    if (!selected) {
      context.intervalSumPlanCache?.set(cacheKey, []);
      return [];
    }
    terms.push(selected);
    cursor = selected.endHour;
  }
  const resolved = cursor === endHour ? terms : [];
  context.intervalSumPlanCache?.set(cacheKey, resolved);
  return resolved;
}

async function getPrecipIntervalsForHour(context, hour) {
  const targetHour = Math.round(Number(hour));
  if (!context.availableHourSet.has(targetHour)) {
    return [];
  }
  if (context.intervalsByHour?.has(targetHour)) {
    return context.intervalsByHour.get(targetHour);
  }
  const records = await getNoaaRecordsForHour(context, targetHour);
  const intervals = records
    .filter(isSurfacePrecipRecord)
    .map((record) => {
      const window = parseAccumulationWindow(record);
      if (!window || window.endHour < window.startHour) {
        return null;
      }
      return {
        hour: targetHour,
        record,
        startHour: window.startHour,
        endHour: window.endHour,
      };
    })
    .filter(Boolean);
  context.intervalsByHour?.set(targetHour, intervals);
  return intervals;
}

async function getNoaaRecordsForHour(context, hour) {
  const targetHour = Math.round(Number(hour));
  if (context.recordsByHour.has(targetHour)) {
    return context.recordsByHour.get(targetHour);
  }
  const gribUrl = buildNoaaGribUrl({
    modelKey: context.modelKey,
    baseUrl: context.baseUrl,
    date: context.date,
    cycle: context.cycle,
    hour: targetHour,
  });
  const idxUrl = `${gribUrl}.idx`;
  const sessionKey = `${idxUrl}|unrepaired`;
  let promise = context.decodeSession?.parsedRecords?.get(sessionKey) || NOAA_INDEX_RECORD_CACHE.get(idxUrl);
  if (!promise) {
    promise = readOrFetchNoaaIdxTextCached(idxUrl, context, targetHour)
      .then((text) => parseNoaaIdx(text, null))
      .catch((error) => {
        NOAA_INDEX_RECORD_CACHE.delete(idxUrl);
        context.decodeSession?.parsedRecords?.delete(sessionKey);
        throw error;
      });
    NOAA_INDEX_RECORD_CACHE.set(idxUrl, promise);
    context.decodeSession?.parsedRecords?.set(sessionKey, promise);
  }
  const records = await promise;
  context.recordsByHour.set(targetHour, records);
  return records;
}

async function ensureSelectedRecordByteRangesForHour({
  context,
  hour,
  selectedRecords,
  gribUrl = null,
  profile = null,
}) {
  const selected = (Array.isArray(selectedRecords) ? selectedRecords : []).filter(Boolean);
  if (selected.length === 0 || selected.every((record) => record.rangeHeader)) {
    return;
  }
  const targetHour = Math.round(Number(hour));
  if (!Number.isFinite(targetHour)) {
    return;
  }
  let records = context?.recordsByHour?.get(targetHour) || null;
  if (!records && context?.recordsByHour) {
    records = await getNoaaRecordsForHour(context, targetHour);
  }
  if (!records) {
    records = selected;
  }
  const resolvedGribUrl =
    gribUrl ||
    buildNoaaGribUrl({
      modelKey: context.modelKey,
      baseUrl: context.baseUrl,
      date: context.date,
      cycle: context.cycle,
      hour: targetHour,
    });
  const totalBytes = await readOrFetchNoaaContentLengthCached(resolvedGribUrl, context, targetHour, profile);
  repairNoaaIdxFinalRecordRanges(records, totalBytes);
}

function buildNoaaIndexCacheContext({ modelKey, date, cycle, rawCacheDir }) {
  return {
    modelKey,
    date,
    cycle,
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
  };
}

async function readOrFetchNoaaIdxTextCached(idxUrl, context, hour, profile = null) {
  const key = String(idxUrl || "");
  let promise = NOAA_INDEX_TEXT_CACHE.get(key);
  if (promise) {
    incrementProfileCounter(profile, "indexCacheHits");
    return promise;
  }
  promise = readOrFetchNoaaIdxText(idxUrl, context, hour, profile).catch((error) => {
    NOAA_INDEX_TEXT_CACHE.delete(key);
    throw error;
  });
  NOAA_INDEX_TEXT_CACHE.set(key, promise);
  return promise;
}

async function readOrFetchNoaaIdxText(idxUrl, context, hour, profile = null) {
  const cachePath = noaaIdxCachePath(idxUrl, context, hour);
  if (cachePath) {
    try {
      const cached = await fs.promises.readFile(cachePath, "utf8");
      if (cached.trim()) {
        incrementProfileCounter(profile, "indexCacheHits");
        return cached;
      }
    } catch {
      // Fall through to network fetch.
    }
  }
  const lockPath = cachePath ? `${cachePath}.lock` : null;
  const lockHandle = lockPath ? await tryAcquireGridCacheLock(lockPath, { idxUrl, hour }) : null;
  if (lockPath && !lockHandle) {
    const waited = await waitForCachedNoaaIdxText(cachePath, lockPath);
    if (waited) {
      incrementProfileCounter(profile, "indexCacheHits");
      return waited;
    }
  } else if (lockHandle) {
    try {
      const cachedAfterLock = await fs.promises.readFile(cachePath, "utf8").catch(() => "");
      if (cachedAfterLock.trim()) {
        incrementProfileCounter(profile, "indexCacheHits");
        return cachedAfterLock;
      }
      return await fetchAndWriteNoaaIdxText({ idxUrl, cachePath, profile });
    } finally {
      await releaseGridCacheLock(lockPath, lockHandle);
    }
  }
  return fetchAndWriteNoaaIdxText({ idxUrl, cachePath, profile });
}

async function fetchAndWriteNoaaIdxText({ idxUrl, cachePath, profile = null }) {
  incrementProfileCounter(profile, "indexCacheMisses");
  const text = await fetchText(idxUrl);
  if (cachePath && text.trim()) {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, cachePath);
  }
  return text;
}

async function waitForCachedNoaaIdxText(cachePath, lockPath) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < GRID_CACHE_LOCK_TIMEOUT_MS) {
    await sleep(GRID_CACHE_LOCK_POLL_MS + Math.round(Math.random() * 40));
    try {
      const cached = await fs.promises.readFile(cachePath, "utf8");
      if (cached.trim()) {
        return cached;
      }
    } catch {
      // Keep waiting while the writer owns the lock.
    }
    if (!(await pathExists(lockPath))) {
      return null;
    }
  }
  return null;
}

async function readOrFetchNoaaContentLengthCached(gribUrl, context, hour, profile = null) {
  const key = String(gribUrl || "");
  let promise = NOAA_INDEX_CONTENT_LENGTH_CACHE.get(key);
  if (promise) {
    incrementProfileCounter(profile, "contentLengthCacheHits");
    return promise;
  }
  promise = readOrFetchNoaaContentLength(gribUrl, context, hour, profile).catch((error) => {
    NOAA_INDEX_CONTENT_LENGTH_CACHE.delete(key);
    throw error;
  });
  NOAA_INDEX_CONTENT_LENGTH_CACHE.set(key, promise);
  return promise;
}

async function readOrFetchNoaaContentLength(gribUrl, context, hour, profile = null) {
  const metadataPath = noaaIdxMetadataCachePath(`${gribUrl}.idx`, context, hour);
  if (metadataPath) {
    try {
      const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
      const totalBytes = Number(metadata?.totalBytes);
      if (Number.isFinite(totalBytes) && totalBytes > 0) {
        incrementProfileCounter(profile, "contentLengthCacheHits");
        return totalBytes;
      }
    } catch {
      // Fall through to HEAD.
    }
  }
  incrementProfileCounter(profile, "contentLengthCacheMisses");
  const totalBytes = await fetchContentLength(gribUrl);
  if (metadataPath) {
    await fs.promises.mkdir(path.dirname(metadataPath), { recursive: true });
    const tmp = `${metadataPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.promises.writeFile(
      tmp,
      JSON.stringify({
        version: 1,
        gribUrl,
        idxUrl: `${gribUrl}.idx`,
        totalBytes,
      }),
    );
    await fs.promises.rename(tmp, metadataPath);
  }
  return totalBytes;
}

function noaaIdxCachePath(idxUrl, context, hour) {
  const cacheDir = context?.sourceIndexCacheDir;
  if (!cacheDir || !idxUrl) {
    return null;
  }
  const hash = crypto.createHash("sha256").update(String(idxUrl)).digest("hex").slice(0, 16);
  const hourToken = Number.isFinite(Number(hour)) ? padHour(hour) : "unknown";
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${hourToken}-${hash}.idx`,
  );
}

function noaaIdxMetadataCachePath(idxUrl, context, hour) {
  const cachePath = noaaIdxCachePath(idxUrl, context, hour);
  return cachePath ? `${cachePath}.meta.json` : null;
}

function clearNoaaIndexCachesForTest() {
  NOAA_INDEX_TEXT_CACHE.clear();
  NOAA_INDEX_CONTENT_LENGTH_CACHE.clear();
  NOAA_INDEX_RECORD_CACHE.clear();
}

async function decodePrecipAccumulationSourceGrids(sourceRefs, context) {
  const unique = new Map();
  for (const ref of sourceRefs) {
    if (!unique.has(ref.sourceKey)) {
      unique.set(ref.sourceKey, ref);
    }
  }
  const out = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const [sourceKey, values] of context.sourceGridOverrides?.entries() || []) {
    const ref = unique.get(sourceKey);
    if (ref && values) {
      out.set(sourceKey, values);
      registerSourceGrid({
        family: "precipAccum",
        payload: precipSourceGridCachePayload(ref, context),
        context,
        values,
      });
      unique.delete(sourceKey);
      cacheHits += 1;
    }
  }
  const registeredPairs = await mapWithConcurrency(
    [...unique.entries()],
    metadataFanoutConcurrency(context, 16),
    async ([sourceKey, ref]) => [
      sourceKey,
      await readRegisteredSourceGrid({
        family: "precipAccum",
        payload: precipSourceGridCachePayload(ref, context),
        context,
        counterKey: "precipAccumSourceRegistryHits",
      }),
    ],
  );
  for (const [sourceKey, registered] of registeredPairs) {
    if (registered && unique.has(sourceKey)) {
      out.set(sourceKey, registered);
      unique.delete(sourceKey);
      cacheHits += 1;
    }
  }
  const cachedPairs = await mapWithConcurrency(
    [...unique.entries()],
    metadataFanoutConcurrency(context, 16),
    async ([sourceKey, ref]) => [sourceKey, await readCachedPrecipSourceGrid(ref, context)],
  );
  for (const [sourceKey, cached] of cachedPairs) {
    if (cached && unique.has(sourceKey)) {
      const ref = unique.get(sourceKey);
      out.set(sourceKey, cached);
      registerSourceGrid({
        family: "precipAccum",
        payload: precipSourceGridCachePayload(ref, context),
        context,
        values: cached,
      });
      unique.delete(sourceKey);
      cacheHits += 1;
    }
  }
  const byHour = new Map();
  for (const ref of unique.values()) {
    const group = byHour.get(ref.hour) || [];
    group.push(ref);
    byHour.set(ref.hour, group);
  }
  await mapWithConcurrency(
    [...byHour.entries()],
    Math.min(Math.max(1, Number(context.decodeConcurrency) || 1), 4),
    async ([hour, refs]) => {
      let refsToDecode = refs;
      const lockPath = precipSourceHourLockPath(hour, context);
      const lockHandle = lockPath ? await tryAcquireGridCacheLock(lockPath, { hour, count: refs.length }) : null;
      if (lockPath && !lockHandle) {
        const waited = await waitForCachedPrecipHourSources(refs, context, lockPath);
        for (const [key, values] of waited.entries()) {
          out.set(key, values);
          const ref = refs.find((candidate) => candidate.sourceKey === key) || null;
          if (ref) {
            registerSourceGrid({
              family: "precipAccum",
              payload: precipSourceGridCachePayload(ref, context),
              context,
              values,
            });
          }
        }
        cacheHits += waited.size;
        refsToDecode = refs.filter((ref) => !waited.has(ref.sourceKey));
      }
      if (refsToDecode.length === 0) {
        return;
      }
      const decodeLockHandle =
        lockHandle || (lockPath ? await tryAcquireGridCacheLock(lockPath, { hour, count: refsToDecode.length }) : null);
      const decodedResult = decodeLockHandle
        ? await decodePrecipAccumulationHourSourcesWithLock(hour, refsToDecode, context, lockPath, decodeLockHandle)
        : {
            grids: await decodePrecipAccumulationHourSources(hour, refsToDecode, context),
            decodedKeys: new Set(refsToDecode.map((ref) => ref.sourceKey)),
            cacheHits: 0,
            cacheMisses: refsToDecode.length,
          };
      cacheHits += decodedResult.cacheHits;
      cacheMisses += decodedResult.cacheMisses;
      const writes = [];
      for (const [key, values] of decodedResult.grids.entries()) {
        out.set(key, values);
        const ref = refs.find((candidate) => candidate.sourceKey === key) || null;
        if (ref) {
          registerSourceGrid({
            family: "precipAccum",
            payload: precipSourceGridCachePayload(ref, context),
            context,
            values,
          });
        }
        if (ref && decodedResult.decodedKeys.has(key)) {
          writes.push({ ref, values });
        }
      }
      await mapWithConcurrency(writes, metadataFanoutConcurrency(context, 8), ({ ref, values }) =>
        writeCachedPrecipSourceGrid(ref, values, context),
      );
    },
  );
  if (context.profile) {
    context.profile.precipAccumSourceCount = cacheHits + cacheMisses;
    context.profile.precipAccumGridCacheHits = cacheHits;
    context.profile.precipAccumGridCacheMisses = cacheMisses;
  }
  return out;
}

async function decodePrecipAccumulationHourSourcesWithLock(hour, refs, context, lockPath, lockHandle) {
  try {
    const cached = await readCachedPrecipHourSources(refs, context);
    const refsToDecode = refs.filter((ref) => !cached.has(ref.sourceKey));
    if (refsToDecode.length === 0) {
      return { grids: cached, decodedKeys: new Set(), cacheHits: cached.size, cacheMisses: 0 };
    }
    const decoded = await decodePrecipAccumulationHourSources(hour, refsToDecode, context);
    const decodedKeys = new Set();
    for (const [key, values] of decoded.entries()) {
      cached.set(key, values);
      decodedKeys.add(key);
    }
    return {
      grids: cached,
      decodedKeys,
      cacheHits: cached.size - decodedKeys.size,
      cacheMisses: refsToDecode.length,
    };
  } finally {
    await releaseGridCacheLock(lockPath, lockHandle);
  }
}

async function decodePrecipAccumulationHourSources(hour, refs, context) {
  const records = refs.map((ref) => ref.record);
  const recordsByKey = Object.fromEntries(refs.map((ref) => [ref.sourceKey, ref.record]));
  const cached = readDecodedRecordsForKeyedRecords({ recordsByKey, hour, context });
  if (cached) {
    return new Map(Object.entries(cached));
  }
  await ensureSelectedRecordByteRangesForHour({
    context,
    hour,
    selectedRecords: records,
    profile: context.profile,
  });
  const selectedPlan = getSelectedRecordPlan(records, context.decodeSession);
  const selection = {
    records: recordsByKey,
    catalog: [],
  };
  const gribUrl = buildNoaaGribUrl({
    modelKey: context.modelKey,
    baseUrl: context.baseUrl,
    date: context.date,
    cycle: context.cycle,
    hour,
  });
  const gribPath = await materializeSelectedGrib({
    modelKey: context.modelKey,
    productKey: context.modelConfig.productKey,
    gribUrl,
    recordGroups: selectedPlan.groups,
    rawCacheDir: context.sourceGribCacheDir || path.join(context.tempDir, SELECTED_GRIB_CACHE_DIRNAME),
    date: context.date,
    cycle: context.cycle,
    hour,
    cacheVersion: CATALOG_VERSION,
    rangeFetchConcurrency: context.rangeFetchConcurrency,
    rangeFetchLimiter: context.rangeFetchLimiter,
    profile: null,
    decodeSession: context.decodeSession,
  });
  const decodeTempDir = await fs.promises.mkdtemp(path.join(context.tempDir, `precip-accum-${padHour(hour)}-`));
  const decoded = await decodeSelectedRecordsToGrids({
    gribPath,
    selectedPlan,
    selection,
    hour,
    tempDir: decodeTempDir,
    wgrib2Path: context.wgrib2Path,
    bounds: context.bounds,
    width: context.width,
    height: context.height,
    decodeConcurrency: context.decodeConcurrency,
    profile: null,
    decodeSession: context.decodeSession,
  }).finally(() => fs.promises.rm(decodeTempDir, { recursive: true, force: true }).catch(() => {}));
  return new Map(Object.entries(decoded));
}

function composePrecipAccumulationGrid(terms, sourceGrids, width, height, options = {}) {
  const cellCount = width * height;
  if (!Array.isArray(terms) || terms.length === 0) {
    return null;
  }
  const sources = terms.map((term) => ({
    weight: Number(term.weight) || 0,
    values: sourceGrids.get(term.sourceKey),
  }));
  if (sources.some((source) => !source.values || source.values.length !== cellCount)) {
    return null;
  }
  const outputScale = Number.isFinite(Number(options.outputScale)) ? Number(options.outputScale) : 1;
  if (sources.length === 1) {
    return composeSinglePrecipAccumulationGrid(sources[0], cellCount, outputScale);
  }
  if (sources.length === 2) {
    return composeTwoPrecipAccumulationGrid(sources[0], sources[1], cellCount, outputScale);
  }
  return composeManyPrecipAccumulationGrid(sources, cellCount, outputScale);
}

function composeSinglePrecipAccumulationGrid(source, cellCount, outputScale = 1) {
  const out = new Float32Array(cellCount);
  const values = source.values;
  const weight = source.weight;
  for (let index = 0; index < cellCount; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      out[index] = Number.NaN;
      continue;
    }
    const total = value * weight;
    out[index] = Math.max(0, total) * outputScale;
  }
  return out;
}

function composeTwoPrecipAccumulationGrid(left, right, cellCount, outputScale = 1) {
  const out = new Float32Array(cellCount);
  const leftValues = left.values;
  const rightValues = right.values;
  const leftWeight = left.weight;
  const rightWeight = right.weight;
  for (let index = 0; index < cellCount; index += 1) {
    const leftValue = Number(leftValues[index]);
    const rightValue = Number(rightValues[index]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      out[index] = Number.NaN;
      continue;
    }
    out[index] = Math.max(0, leftValue * leftWeight + rightValue * rightWeight) * outputScale;
  }
  return out;
}

function composeManyPrecipAccumulationGrid(sources, cellCount, outputScale = 1) {
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    let total = 0;
    let valid = true;
    for (const source of sources) {
      const value = Number(source.values[index]);
      if (!Number.isFinite(value)) {
        valid = false;
        break;
      }
      total += value * source.weight;
    }
    if (valid) {
      out[index] = Math.max(0, total) * outputScale;
    }
  }
  return out;
}

function precipSourceKey(hour, record) {
  return `precip:${Math.round(Number(hour))}:${record?.record || ""}:${record?.forecast || ""}`;
}

function buildPrecipSourceGridOverrides({ targetHour, decoded, selection }) {
  const out = new Map();
  if (!decoded || !selection?.records) {
    return out;
  }
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour)) {
    return out;
  }
  for (const [key, record] of Object.entries(selection.records)) {
    const values = decoded[key];
    if (isSurfacePrecipRecord(record) && values) {
      out.set(precipSourceKey(hour, record), values);
    }
  }
  return out;
}

function precipSourceGridCachePath(ref, context) {
  const cacheDir = context?.sourceGridCacheDir;
  if (!cacheDir || !ref?.record) {
    return null;
  }
  const payload = precipSourceGridCachePayload(ref, context);
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(ref.hour)}-${hash}.f32`,
  );
}

function precipSourceGridCachePayload(ref, context) {
  return {
    version: PRECIP_ACCUM_GRID_CACHE_VERSION,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    hour: Math.round(Number(ref.hour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    record: selectedPrecipRecordIdentity(ref.record),
  };
}

function precipSourceHourLockPath(hour, context) {
  const cacheDir = context?.sourceGridCacheDir;
  if (!cacheDir) {
    return null;
  }
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(hour)}.lock`,
  );
}

async function waitForCachedPrecipHourSources(refs, context, lockPath) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < GRID_CACHE_LOCK_TIMEOUT_MS) {
    await sleep(GRID_CACHE_LOCK_POLL_MS + Math.round(Math.random() * 40));
    const cached = await readCachedPrecipHourSources(refs, context);
    if (cached.size === refs.length) {
      return cached;
    }
    const lockExists = await pathExists(lockPath);
    if (!lockExists) {
      return cached;
    }
  }
  incrementProfileCounter(context.profile, "precipAccumGridLockTimeouts");
  return readCachedPrecipHourSources(refs, context);
}

async function readCachedPrecipHourSources(refs, context) {
  const pairs = await mapWithConcurrency(refs, metadataFanoutConcurrency(context, 16), async (ref) => [
    ref.sourceKey,
    await readCachedPrecipSourceGrid(ref, context),
  ]);
  const out = new Map();
  for (const [sourceKey, cached] of pairs) {
    if (cached) {
      out.set(sourceKey, cached);
    }
  }
  return out;
}

function selectedPrecipRecordIdentity(record) {
  return {
    record: record?.record || "",
    offset: Number(record?.offset),
    param: record?.param || "",
    level: record?.level || "",
    forecast: record?.forecast || "",
    line: record?.line || "",
  };
}

async function readCachedPrecipSourceGrid(ref, context) {
  const cachePath = precipSourceGridCachePath(ref, context);
  if (!cachePath) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    const expected = precipSourceGridCachePayload(ref, context);
    if (!directCacheMetadataPayloadMatches(metadata, expected)) {
      return null;
    }
    const body = await fs.promises.readFile(cachePath);
    const expectedBytes = Number(context.width) * Number(context.height) * 4;
    if (body.length !== expectedBytes) {
      return null;
    }
    return float32ArrayViewFromBuffer(body, 0, body.byteLength);
  } catch {
    return null;
  }
}

async function writeCachedPrecipSourceGrid(ref, values, context) {
  const cachePath = precipSourceGridCachePath(ref, context);
  if (!cachePath || !values || values.length !== Number(context.width) * Number(context.height)) {
    return;
  }
  const metadata = precipSourceGridCachePayload(ref, context);
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpJson = `${tmp}.json`;
  const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  await fs.promises.writeFile(tmp, body);
  await fs.promises.writeFile(tmpJson, JSON.stringify(cacheMetadataWithPayload(metadata)));
  await fs.promises.rename(tmp, cachePath);
  await fs.promises.rename(tmpJson, `${cachePath}.json`);
}

function selectedGribRecordsHash(groups) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(selectedGribRecordManifest(groups)))
    .digest("hex")
    .slice(0, 24);
}

function buildNoaaGribUrl({ modelKey = "nam", baseUrl = null, date, cycle, hour }) {
  const config = getNoaaGribModelConfig(modelKey);
  const normalizedDate = String(date || "").trim();
  const normalizedCycle = String(cycle || "").padStart(2, "0");
  return config.buildUrl({
    baseUrl: baseUrl || config.baseUrl,
    date: normalizedDate,
    cycle: normalizedCycle,
    hour,
  });
}

function buildNoaaNamAwphysUrl({ baseUrl = NOAA_NAM_BASE_URL, date, cycle, hour }) {
  return buildNoaaGribUrl({ modelKey: "nam", baseUrl, date, cycle, hour });
}

function getNoaaGribModelConfig(modelKey = "nam") {
  const normalized = normalizeNoaaModelKey(modelKey);
  return NOAA_BETA_MODEL_CONFIG[normalized];
}

function normalizeNoaaModelKey(modelKey = "nam") {
  const key = String(modelKey || "nam")
    .trim()
    .toLowerCase();
  if (!NOAA_BETA_MODEL_CONFIG[key]) {
    throw new Error(`Unsupported NOAA beta model '${modelKey}'. Supported: ${NOAA_BETA_MODEL_KEYS.join(", ")}`);
  }
  return key;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function selectedGribSharedCacheDir(rawCacheDir) {
  if (!rawCacheDir) {
    return null;
  }
  const base = path.basename(String(rawCacheDir));
  if (base === SELECTED_GRIB_CACHE_DIRNAME) {
    return rawCacheDir;
  }
  if (base.endsWith("-selected") || base.endsWith("-raw")) {
    return path.join(path.dirname(rawCacheDir), SELECTED_GRIB_CACHE_DIRNAME);
  }
  return path.join(rawCacheDir, SELECTED_GRIB_CACHE_DIRNAME);
}

async function ensureWgrib2Available(wgrib2Path = DEFAULT_WGRIB2_PATH) {
  try {
    const result = await runCommand(wgrib2Path, ["-version"], { allowNonZero: true });
    const output = `${result.stdout || ""} ${result.stderr || ""}`;
    if (!/\d+\.\d+/.test(output)) {
      throw new Error(`unexpected version output '${output.trim()}'`);
    }
  } catch (error) {
    throw new Error(
      `NOAA beta renderer requires '${wgrib2Path}' on PATH. Install wgrib2, then rerun the command. Original error: ${String(error?.message || error)}`,
    );
  }
}

async function materializeSelectedGrib({
  modelKey = "nam",
  productKey = "grib",
  gribUrl,
  recordGroups,
  rawCacheDir,
  date,
  cycle,
  hour,
  cacheVersion = "current-ui",
  rangeFetchConcurrency = 8,
  rangeFetchLimiter = null,
  profile = null,
  decodeSession = null,
}) {
  const groups = Array.isArray(recordGroups) ? recordGroups : [];
  if (groups.length === 0) {
    throw new Error(`No NOAA GRIB records selected for ${gribUrl}`);
  }
  for (const group of groups) {
    if (!group.rangeHeader) {
      throw new Error(`NOAA GRIB index row is missing byte range at offset ${group.offset}`);
    }
  }
  const descriptor = selectedGribCacheDescriptor({
    modelKey,
    productKey,
    gribUrl,
    groups,
    rawCacheDir,
    date,
    cycle,
    hour,
    cacheVersion,
  });
  const promiseKey = descriptor.cachePath || descriptor.identityKey;
  const existing = decodeSession?.selectedGribPromises?.get(promiseKey);
  if (existing) {
    incrementDecodeSessionCounter(decodeSession, "selectedGribPromiseHits");
    return existing;
  }
  const promise = materializeSelectedGribUncached({
    descriptor,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    profile,
  }).finally(() => {
    if (!descriptor.cachePath) {
      decodeSession?.selectedGribPromises?.delete(promiseKey);
    }
  });
  decodeSession?.selectedGribPromises?.set(promiseKey, promise);
  return promise;
}

async function materializeSelectedGribUncached({ descriptor, rangeFetchConcurrency, rangeFetchLimiter, profile }) {
  const { cachePath, gribUrl, groups } = descriptor;
  const cachedPath = cachePath ? await readCachedSelectedGribPath(cachePath, descriptor) : null;
  if (cachedPath) {
    if (profile) {
      profile.selectedGribCacheHit = true;
    }
    incrementProfileCounter(profile, "selectedGribCacheHits");
    return cachedPath;
  }
  if (profile) {
    profile.selectedGribCacheHit = false;
  }
  incrementProfileCounter(profile, "selectedGribCacheMisses");

  if (!cachePath) {
    const tempPath = path.join(
      os.tmpdir(),
      `noaa-selected-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.grib2`,
    );
    await writeSelectedGribRangeFile({
      targetPath: tempPath,
      gribUrl,
      groups,
      rangeFetchConcurrency,
      rangeFetchLimiter,
      profile,
      atomic: false,
    });
    return tempPath;
  }

  const lockPath = `${cachePath}.lock`;
  const lockHandle = await tryAcquireGridCacheLock(lockPath, selectedGribLockPayload(descriptor));
  if (!lockHandle) {
    incrementProfileCounter(profile, "selectedGribLockWaits");
    const waited = await waitForCachedSelectedGrib(cachePath, descriptor, lockPath);
    if (waited) {
      if (profile) {
        profile.selectedGribCacheHit = true;
      }
      incrementProfileCounter(profile, "selectedGribCacheHits");
      return waited;
    }
  } else {
    try {
      const cachedAfterLock = await readCachedSelectedGribPath(cachePath, descriptor);
      if (cachedAfterLock) {
        if (profile) {
          profile.selectedGribCacheHit = true;
        }
        incrementProfileCounter(profile, "selectedGribCacheHits");
        return cachedAfterLock;
      }
      return await writeCachedSelectedGrib({ descriptor, rangeFetchConcurrency, rangeFetchLimiter, profile });
    } finally {
      await releaseGridCacheLock(lockPath, lockHandle);
    }
  }

  return writeCachedSelectedGrib({ descriptor, rangeFetchConcurrency, rangeFetchLimiter, profile });
}

function selectedGribCacheDescriptor({
  modelKey,
  productKey,
  gribUrl,
  groups,
  rawCacheDir,
  date,
  cycle,
  hour,
  cacheVersion,
}) {
  const records = selectedGribRecordManifest(groups);
  const recordsJson = JSON.stringify(records);
  const selectedHash = crypto.createHash("sha256").update(recordsJson).digest("hex").slice(0, 24);
  const urlHash = crypto
    .createHash("sha256")
    .update(String(gribUrl || ""))
    .digest("hex")
    .slice(0, 16);
  const versionToken = sanitizePathToken(cacheVersion || CATALOG_VERSION);
  const cacheRoot = selectedGribSharedCacheDir(rawCacheDir);
  const cachePath = cacheRoot
    ? path.join(
        cacheRoot,
        sanitizePathToken(modelKey),
        String(date),
        String(cycle),
        sanitizePathToken(productKey),
        `${padHour(hour)}-${versionToken}-${selectedHash}-${urlHash}.grib2`,
      )
    : null;
  return {
    cachePath,
    gribUrl,
    groups,
    records,
    recordsJson,
    selectedHash,
    urlHash,
    modelKey,
    productKey,
    date,
    cycle,
    hour: Math.round(Number(hour)),
    cacheVersion,
    identityKey: JSON.stringify({ gribUrl, selectedHash, modelKey, productKey, date, cycle, hour, cacheVersion }),
  };
}

function selectedGribLockPayload(descriptor) {
  return {
    version: SELECTED_GRIB_CACHE_METADATA_VERSION,
    gribUrl: descriptor.gribUrl,
    selectedHash: descriptor.selectedHash,
    urlHash: descriptor.urlHash,
    modelKey: descriptor.modelKey,
    productKey: descriptor.productKey,
    date: descriptor.date,
    cycle: descriptor.cycle,
    hour: descriptor.hour,
  };
}

async function readCachedSelectedGribPath(cachePath, descriptor) {
  try {
    const metadata = await readSelectedGribMetadata(cachePath);
    if (!selectedGribMetadataMatches(metadata, descriptor)) {
      return null;
    }
    const stat = await fs.promises.stat(cachePath);
    if (stat.size !== Number(metadata.selectedBytes)) {
      return null;
    }
    if (metadata.sha256) {
      const sha256 = await hashFileSha256(cachePath);
      if (sha256 !== metadata.sha256) {
        return null;
      }
    }
    return cachePath;
  } catch {
    return null;
  }
}

async function readSelectedGribMetadata(cachePath) {
  const readyPath = `${cachePath}.ready.json`;
  try {
    return JSON.parse(await fs.promises.readFile(readyPath, "utf8"));
  } catch {
    return JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
  }
}

function selectedGribMetadataMatches(metadata, descriptor) {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  if (metadata.url !== descriptor.gribUrl || metadata.selectedHash !== descriptor.selectedHash) {
    return false;
  }
  if (metadata.urlHash && metadata.urlHash !== descriptor.urlHash) {
    return false;
  }
  return JSON.stringify(metadata.records || []) === descriptor.recordsJson;
}

async function waitForCachedSelectedGrib(cachePath, descriptor, lockPath) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < SELECTED_GRIB_LOCK_TIMEOUT_MS) {
    await sleep(SELECTED_GRIB_LOCK_POLL_MS + Math.round(Math.random() * 40));
    const cached = await readCachedSelectedGribPath(cachePath, descriptor);
    if (cached) {
      return cached;
    }
    if (!(await pathExists(lockPath))) {
      return null;
    }
  }
  return null;
}

async function writeCachedSelectedGrib({ descriptor, rangeFetchConcurrency, rangeFetchLimiter, profile }) {
  const { cachePath } = descriptor;
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await writeSelectedGribRangeFile({
    targetPath: tmp,
    gribUrl: descriptor.gribUrl,
    groups: descriptor.groups,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    profile,
    atomic: false,
  });
  const metadata = {
    version: SELECTED_GRIB_CACHE_METADATA_VERSION,
    url: descriptor.gribUrl,
    urlHash: descriptor.urlHash,
    selectedHash: descriptor.selectedHash,
    rangeRequestCount: descriptor.groups.length,
    rangeFetchConcurrency: clampInt(rangeFetchConcurrency, 1, descriptor.groups.length, 1),
    selectedBytes: result.bytes,
    sha256: result.sha256,
    records: descriptor.records,
  };
  const metadataTmp = `${tmp}.json`;
  const readyTmp = `${tmp}.ready.json`;
  const stageStartedAt = performance.now();
  await fs.promises.writeFile(metadataTmp, JSON.stringify(metadata));
  await fs.promises.writeFile(readyTmp, JSON.stringify(metadata));
  await fs.promises.rename(tmp, cachePath);
  await fs.promises.rename(metadataTmp, `${cachePath}.json`);
  await fs.promises.rename(readyTmp, `${cachePath}.ready.json`);
  recordProfileStage(profile, "selectedGribWriteMs", stageStartedAt);
  return cachePath;
}

async function writeSelectedGribRangeFile({
  targetPath,
  gribUrl,
  groups,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  profile,
}) {
  const offsets = [];
  let cursor = 0;
  for (const group of groups) {
    const byteLength = selectedGribGroupByteLength(group);
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
      throw new Error(`NOAA GRIB selected record is missing byte length for ${group.rangeHeader}`);
    }
    offsets.push(cursor);
    cursor += byteLength;
  }
  const stageStartedAt = performance.now();
  const handle = await fs.promises.open(targetPath, "w");
  try {
    await mapWithConcurrency(groups, rangeFetchConcurrency, async (group, index) => {
      const chunk = await fetchRangeChunk({ gribUrl, group, rangeFetchLimiter, profile });
      const expectedBytes = selectedGribGroupByteLength(group);
      if (chunk.length !== expectedBytes) {
        throw new Error(
          `NOAA byte-range ${group.rangeHeader} returned ${chunk.length} bytes; expected ${expectedBytes}.`,
        );
      }
      await handle.write(chunk, 0, chunk.length, offsets[index]);
    });
  } finally {
    await handle.close().catch(() => {});
  }
  recordProfileStage(profile, "rangeFetchMs", stageStartedAt);
  const hashStartedAt = performance.now();
  const sha256 = await hashFileSha256(targetPath);
  recordProfileStage(profile, "rangeConcatMs", hashStartedAt);
  if (profile) {
    profile.selectedBytes = cursor;
  }
  return { bytes: cursor, sha256 };
}

function selectedGribGroupByteLength(group) {
  const byteLength = Number(group?.byteLength ?? group?.records?.[0]?.byteLength);
  return Number.isFinite(byteLength) && byteLength > 0 ? byteLength : null;
}

async function hashFileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function fetchRangeChunk({ gribUrl, group, rangeFetchLimiter, profile = null }) {
  const run = async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(gribUrl, { headers: { Range: group.rangeHeader } });
        if (response.status === 206) {
          return Buffer.from(await response.arrayBuffer());
        }
        const error = new Error(`Expected byte-range response for ${gribUrl}, got HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      } catch (error) {
        lastError = error;
        if (attempt >= 3 || !isRetryableRangeFetchError(error)) {
          throw error;
        }
        recordRangeFetchRetry(profile, error);
        await sleep(250 * attempt);
      }
    }
    throw lastError || new Error(`NOAA byte-range request failed for ${gribUrl}`);
  };
  return typeof rangeFetchLimiter === "function" ? rangeFetchLimiter(run) : run();
}

function isRetryableRangeFetchError(error) {
  const status = Number(error?.status);
  if (status === 429 || status >= 500) {
    return true;
  }
  return !Number.isFinite(status);
}

function createNoaaRenderProfile() {
  return {
    stages: {},
    selectedRecordGroups: 0,
    selectedBytes: 0,
    selectedGribCacheHit: false,
    rangeFetchRetries: 0,
    rangeFetchRetryStatuses: {},
  };
}

function recordProfileStage(profile, key, startedAt) {
  if (!profile || !key || !Number.isFinite(startedAt)) {
    return;
  }
  profile.stages[key] = roundMs(performance.now() - startedAt);
}

function recordRangeFetchRetry(profile, error) {
  if (!profile) {
    return;
  }
  profile.rangeFetchRetries += 1;
  const status = Number(error?.status);
  const key = Number.isFinite(status) ? String(status) : "network";
  profile.rangeFetchRetryStatuses[key] = (profile.rangeFetchRetryStatuses[key] || 0) + 1;
}

function finalizeNoaaRenderProfile(profile) {
  if (!profile) {
    return null;
  }
  const out = {
    selectedRecordGroups: Number(profile.selectedRecordGroups) || 0,
    selectedBytes: Number(profile.selectedBytes) || 0,
    selectedGribCacheHit: Boolean(profile.selectedGribCacheHit),
    selectedGribCacheHits: Number(profile.selectedGribCacheHits) || 0,
    selectedGribCacheMisses: Number(profile.selectedGribCacheMisses) || 0,
    selectedGribLockWaits: Number(profile.selectedGribLockWaits) || 0,
    selectedGribPromiseHits: Number(profile.selectedGribPromiseHits) || 0,
    selectedPlanCacheHits: Number(profile.selectedPlanCacheHits) || 0,
    decodedGridPromiseHits: Number(profile.decodedGridPromiseHits) || 0,
    decodedRecordGridHits: Number(profile.decodedRecordGridHits) || 0,
    sourceGridRegistryHits: Number(profile.sourceGridRegistryHits) || 0,
    precipAccumSourceRegistryHits: Number(profile.precipAccumSourceRegistryHits) || 0,
    snowLiquidSourceRegistryHits: Number(profile.snowLiquidSourceRegistryHits) || 0,
    freezingRainLiquidSourceRegistryHits: Number(profile.freezingRainLiquidSourceRegistryHits) || 0,
    profileGridRegistryHits: Number(profile.profileGridRegistryHits) || 0,
    rowMapHits: Number(profile.rowMapHits) || 0,
    rowMapMisses: Number(profile.rowMapMisses) || 0,
    indexCacheHits: Number(profile.indexCacheHits) || 0,
    indexCacheMisses: Number(profile.indexCacheMisses) || 0,
    contentLengthCacheHits: Number(profile.contentLengthCacheHits) || 0,
    contentLengthCacheMisses: Number(profile.contentLengthCacheMisses) || 0,
    rangeFetchRetries: Number(profile.rangeFetchRetries) || 0,
    precipAccumSourceRefs: Number(profile.precipAccumSourceRefs) || 0,
    precipAccumSourceCount: Number(profile.precipAccumSourceCount) || 0,
    precipAccumGridCacheHits: Number(profile.precipAccumGridCacheHits) || 0,
    precipAccumGridCacheMisses: Number(profile.precipAccumGridCacheMisses) || 0,
    precipAccumGridLockTimeouts: Number(profile.precipAccumGridLockTimeouts) || 0,
    runMaxGridCacheHits: Number(profile.runMaxGridCacheHits) || 0,
    runMaxGridCacheMisses: Number(profile.runMaxGridCacheMisses) || 0,
    runMaxSourceCacheHits: Number(profile.runMaxSourceCacheHits) || 0,
    runMaxSourceCacheMisses: Number(profile.runMaxSourceCacheMisses) || 0,
    runMaxGridLockTimeouts: Number(profile.runMaxGridLockTimeouts) || 0,
    runMaxSourceLockTimeouts: Number(profile.runMaxSourceLockTimeouts) || 0,
    snowLiquidSourceRefs: Number(profile.snowLiquidSourceRefs) || 0,
    snowLiquidSourceCount: Number(profile.snowLiquidSourceCount) || 0,
    snowLiquidGridCacheHits: Number(profile.snowLiquidGridCacheHits) || 0,
    snowLiquidGridCacheMisses: Number(profile.snowLiquidGridCacheMisses) || 0,
    snowLiquidGridLockTimeouts: Number(profile.snowLiquidGridLockTimeouts) || 0,
    snowfallIntervalCount: Number(profile.snowfallIntervalCount) || 0,
    snowfallIntervalActiveCount: Number(profile.snowfallIntervalActiveCount) || 0,
    snowfallIntervalSourceRefs: Number(profile.snowfallIntervalSourceRefs) || 0,
    snowfallCumulativeCacheHits: Number(profile.snowfallCumulativeCacheHits) || 0,
    snowfallCumulativeCacheMisses: Number(profile.snowfallCumulativeCacheMisses) || 0,
    snowfallCumulativeLockTimeouts: Number(profile.snowfallCumulativeLockTimeouts) || 0,
    snowfallDeltaCacheHits: Number(profile.snowfallDeltaCacheHits) || 0,
    snowfallDeltaCacheMisses: Number(profile.snowfallDeltaCacheMisses) || 0,
    snowfallDeltaLockTimeouts: Number(profile.snowfallDeltaLockTimeouts) || 0,
    profileRecordCount: Number(profile.profileRecordCount) || 0,
    profileGridCacheHits: Number(profile.profileGridCacheHits) || 0,
    profileGridCacheMisses: Number(profile.profileGridCacheMisses) || 0,
    profileGridLockTimeouts: Number(profile.profileGridLockTimeouts) || 0,
    dcapeStats: profile.dcapeStats || null,
    stages: {},
  };
  if (profile.rangeFetchRetries > 0) {
    out.rangeFetchRetryStatuses = { ...profile.rangeFetchRetryStatuses };
  }
  for (const [key, value] of Object.entries(profile.stages || {})) {
    if (Number.isFinite(value)) {
      out.stages[key] = roundMs(value);
    }
  }
  return out;
}

function roundMs(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function metadataFanoutConcurrency(context, cap = 8) {
  const decodeConcurrency = Math.max(1, Number(context?.decodeConcurrency) || 1);
  return Math.min(Math.max(4, decodeConcurrency * 2), Math.max(1, Number(cap) || 8));
}

function decodeHourFanoutConcurrency(context, cap = 6) {
  const decodeConcurrency = Math.max(1, Number(context?.decodeConcurrency) || 1);
  return Math.min(decodeConcurrency, Math.max(1, Number(cap) || 6));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  if (list.length === 0) {
    return out;
  }
  const workerCount = clampInt(concurrency, 1, list.length, 1);
  let index = 0;
  const runners = Array.from({ length: workerCount }, async () => {
    while (index < list.length) {
      const current = index;
      index += 1;
      out[current] = await worker(list[current], current);
    }
  });
  await Promise.all(runners);
  return out;
}

function selectedGribRecordManifest(groups) {
  return groups.flatMap((group) =>
    group.records.map((record) => ({
      record: record.record,
      param: record.param,
      level: record.level,
      forecast: record.forecast,
      rangeHeader: group.rangeHeader,
      byteLength: record.byteLength,
    })),
  );
}

async function decodeSelectedRecordsToGrids({
  gribPath,
  selectedPlan,
  selection,
  hour = null,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  decodeConcurrency = 1,
  categoricalPrecipTypeInterpolation = true,
  profile = null,
  decodeSession = null,
}) {
  const cacheKey = decodeSession
    ? decodedSelectionCacheKey({ gribPath, selection, bounds, width, height, categoricalPrecipTypeInterpolation })
    : null;
  const existing = cacheKey ? decodeSession.decodedGridPromises.get(cacheKey) : null;
  if (existing) {
    incrementDecodeSessionCounter(decodeSession, "decodedGridPromiseHits");
    return existing;
  }
  const recordCached = readDecodedSelectionFromRecordCache({
    selection,
    hour,
    bounds,
    width,
    height,
    categoricalPrecipTypeInterpolation,
    decodeSession,
  });
  if (recordCached) {
    return recordCached;
  }
  const promise = (async () => {
    try {
      return await decodeSelectedRecordsBulk({
        gribPath,
        selectedPlan,
        selection,
        hour,
        tempDir,
        wgrib2Path,
        bounds,
        width,
        height,
        categoricalPrecipTypeInterpolation,
        profile,
        decodeSession,
      });
    } catch (error) {
      if (process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE === "1") {
        throw error;
      }
      return decodeSelectedRecordsLegacy({
        gribPath,
        selectedPlan,
        selection,
        hour,
        tempDir,
        wgrib2Path,
        bounds,
        width,
        height,
        decodeConcurrency,
        categoricalPrecipTypeInterpolation,
        profile,
        decodeSession,
      });
    }
  })();
  if (cacheKey) {
    decodeSession.decodedGridPromises.set(cacheKey, promise);
  }
  return promise;
}

function decodedSelectionCacheKey({ gribPath, selection, bounds, width, height, categoricalPrecipTypeInterpolation }) {
  return JSON.stringify({
    gribPath,
    bounds,
    width,
    height,
    categoricalPrecipTypeInterpolation: Boolean(categoricalPrecipTypeInterpolation),
    records: Object.fromEntries(
      Object.entries(selection?.records || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, record]) => [key, selectedRecordDecodeCacheKey(record)]),
    ),
  });
}

function readDecodedSelectionFromRecordCache({
  selection,
  hour = null,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation,
  decodeSession,
}) {
  const cache = decodeSession?.decodedRecordGrids;
  const records = Object.entries(selection?.records || {}).filter(([, record]) => Boolean(record));
  if (!cache || records.length === 0) {
    return null;
  }
  const decoded = {};
  for (const [key, record] of records) {
    const rowInterpolation = decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation);
    const values = boundedRunCacheGet(
      cache,
      decodedRecordGridCacheKey({ record, hour, bounds, width, height, rowInterpolation }),
    );
    if (!values) {
      return null;
    }
    decoded[key] = values;
  }
  incrementDecodeSessionCounter(decodeSession, "decodedRecordGridHits");
  return decoded;
}

function writeDecodedRecordGridCache({
  record,
  values,
  hour = null,
  bounds,
  width,
  height,
  rowInterpolation,
  decodeSession,
}) {
  const cache = decodeSession?.decodedRecordGrids;
  if (!cache || !record || !(values instanceof Float32Array)) {
    return;
  }
  boundedRunCacheSet(
    cache,
    decodedRecordGridCacheKey({ record, hour, bounds, width, height, rowInterpolation }),
    values,
  );
}

function readDecodedRecordsForKeyedRecords({
  recordsByKey,
  hour = null,
  context,
  categoricalPrecipTypeInterpolation = true,
}) {
  return readDecodedSelectionFromRecordCache({
    selection: { records: recordsByKey || {} },
    hour: hour ?? context?.targetHour ?? null,
    bounds: context?.bounds,
    width: context?.width,
    height: context?.height,
    categoricalPrecipTypeInterpolation,
    decodeSession: context?.decodeSession,
  });
}

async function readRegisteredSourceGrid({ family, payload, context, counterKey = "sourceGridRegistryHits" }) {
  const cache = context?.decodeSession?.sourceGridRegistry;
  if (!cache || !family || !payload) {
    return null;
  }
  const cached = boundedRunCacheGet(cache, sourceGridRegistryKey(family, payload));
  if (!cached) {
    return null;
  }
  const values = typeof cached.then === "function" ? await cached : cached;
  if (!(values instanceof Float32Array)) {
    return null;
  }
  incrementProfileCounter(context.profile, counterKey);
  return values;
}

function registerSourceGrid({ family, payload, context, values }) {
  const cache = context?.decodeSession?.sourceGridRegistry;
  if (!cache || !family || !payload || !(values instanceof Float32Array)) {
    return;
  }
  boundedRunCacheSet(cache, sourceGridRegistryKey(family, payload), values);
}

function sourceGridRegistryKey(family, payload) {
  return `${family}:${cachePayloadHashFromJson(cachePayloadJson(payload))}`;
}

function readRegisteredProfileGrids({ recordsByKey, hour, context }) {
  const entries = Object.entries(recordsByKey || {}).filter(([, record]) => Boolean(record));
  if (entries.length === 0) {
    return null;
  }
  const cache = context?.decodeSession?.profileGridRegistry;
  const out = {};
  if (cache) {
    let allProfileRegistered = true;
    for (const [key, record] of entries) {
      const values = boundedRunCacheGet(cache, profileGridRegistryKey({ record, hour, context }));
      if (!(values instanceof Float32Array)) {
        allProfileRegistered = false;
        break;
      }
      out[key] = values;
    }
    if (allProfileRegistered) {
      incrementProfileCounter(context.profile, "profileGridRegistryHits");
      return out;
    }
  }
  const decodedCached = readDecodedRecordsForKeyedRecords({ recordsByKey, hour, context });
  if (decodedCached) {
    registerProfileGrids({ recordsByKey, hour, context, decoded: decodedCached });
    return decodedCached;
  }
  return null;
}

function registerProfileGrids({ recordsByKey, hour, context, decoded }) {
  const cache = context?.decodeSession?.profileGridRegistry;
  if (!cache || !decoded || typeof decoded !== "object") {
    return;
  }
  for (const [key, record] of Object.entries(recordsByKey || {})) {
    const values = decoded[key];
    if (!(values instanceof Float32Array)) {
      continue;
    }
    boundedRunCacheSet(cache, profileGridRegistryKey({ record, hour, context }), values);
    writeDecodedRecordGridCache({
      record,
      values,
      hour,
      bounds: context.bounds,
      width: context.width,
      height: context.height,
      rowInterpolation: "bilinear",
      decodeSession: context.decodeSession,
    });
  }
}

function profileGridRegistryKey({ record, hour, context }) {
  return JSON.stringify({
    hour: Math.round(Number(hour)),
    record: selectedPrecipRecordIdentity(record),
    bounds: context?.bounds,
    width: context?.width,
    height: context?.height,
    rowInterpolation: "bilinear",
  });
}

function decodedRecordGridCacheKey({ record, hour = null, bounds, width, height, rowInterpolation }) {
  return JSON.stringify({
    hour: Number.isFinite(Number(hour)) ? Math.round(Number(hour)) : null,
    record: selectedRecordDecodeCacheKey(record),
    bounds,
    width,
    height,
    rowInterpolation: String(rowInterpolation || "bilinear"),
  });
}

function incrementDecodeSessionCounter(session, key) {
  if (!session?.counters || !key) {
    return;
  }
  session.counters[key] = (Number(session.counters[key]) || 0) + 1;
  incrementProfileCounter(session.profile, key);
}

async function decodeSelectedRecordsBulk({
  gribPath,
  selectedPlan = null,
  selection,
  hour = null,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation = true,
  profile,
  decodeSession = null,
}) {
  const gridPath = path.join(tempDir, "selected-regridded.grib2");
  const binPath = path.join(tempDir, "selected-regridded.bin");
  await fs.promises.rm(gridPath, { force: true }).catch(() => {});
  await fs.promises.rm(binPath, { force: true }).catch(() => {});
  let stageStartedAt = performance.now();
  await runCommand(
    wgrib2Path,
    buildNoaaRegridArgs({
      gribPath,
      gridPath,
      bounds,
      width,
      height,
      useCategoricalPrecipTypeInterpolation: Boolean(categoricalPrecipTypeInterpolation),
    }),
  );
  recordProfileStage(profile, "wgribRegridMs", stageStartedAt);
  stageStartedAt = performance.now();
  const inventoryText = (
    await runCommand(wgrib2Path, [gridPath, "-s", "-order", "we:sn", "-no_header", "-bin", binPath])
  ).stdout;
  recordProfileStage(profile, "wgribExportMs", stageStartedAt);
  const inventory = parseWgribSimpleInventory(inventoryText);
  if (inventory.length === 0) {
    throw new Error("Bulk NOAA decode produced an empty regridded inventory.");
  }
  stageStartedAt = performance.now();
  const binStat = await fs.promises.stat(binPath);
  recordProfileStage(profile, "binaryReadMs", stageStartedAt);
  const fieldBytes = width * height * 4;
  if (binStat.size < inventory.length * fieldBytes) {
    throw new Error(`Bulk NOAA binary has ${binStat.size} bytes; expected at least ${inventory.length * fieldBytes}.`);
  }
  const decoded = {};
  const usedRecordNumbers = new Set();
  const regriddedRecordBySource = new Map();
  const regriddedInventoryIndex = buildBulkDecodedRecordIndex(inventory);
  const selectedRecordIndex = selectedPlan?.recordIndexByOriginalRecord || null;
  const decodedGridByRecord = new Map();
  const requiredKeys = requiredDecodeKeys(selection.catalog || NOAA_NAM_PARAMETER_CATALOG);
  stageStartedAt = performance.now();
  const binHandle = await fs.promises.open(binPath, "r");
  try {
    for (const [key, sourceRecord] of Object.entries(selection.records || {})) {
      if (!sourceRecord) {
        continue;
      }
      const sourceRecordKey = selectedRecordDecodeCacheKey(sourceRecord);
      const rowInterpolation = decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation);
      let regriddedRecord = regriddedRecordBySource.get(sourceRecordKey);
      if (!regriddedRecord) {
        regriddedRecord =
          takeBulkDecodedRecordBySelectedPlan(
            regriddedInventoryIndex,
            selectedRecordIndex,
            sourceRecord,
            usedRecordNumbers,
          ) || takeBulkDecodedRecord(regriddedInventoryIndex, sourceRecord, usedRecordNumbers);
        if (regriddedRecord) {
          usedRecordNumbers.add(bulkDecodedRecordOrdinal(regriddedRecord));
          regriddedRecordBySource.set(sourceRecordKey, regriddedRecord);
        }
      }
      if (!regriddedRecord) {
        if (requiredKeys.has(key)) {
          throw new Error(`Bulk NOAA decode is missing required regridded record for ${key}.`);
        }
        continue;
      }
      const fieldOrdinal = bulkDecodedRecordOrdinal(regriddedRecord);
      const gridCacheKey = `${fieldOrdinal}:${rowInterpolation}`;
      let values = decodedGridByRecord.get(gridCacheKey);
      if (!values) {
        values = await decodeBinaryGridFileSlice({
          fileHandle: binHandle,
          byteOffset: (fieldOrdinal - 1) * fieldBytes,
          fieldBytes,
          bounds,
          width,
          height,
          rowInterpolation,
          rowMapCache: decodeSession?.rowMaps,
          decodeSession,
        });
        decodedGridByRecord.set(gridCacheKey, values);
        writeDecodedRecordGridCache({
          record: sourceRecord,
          values,
          hour,
          bounds,
          width,
          height,
          rowInterpolation,
          decodeSession,
        });
      }
      decoded[key] = values;
    }
  } finally {
    await binHandle.close().catch(() => {});
  }
  recordProfileStage(profile, "gridMapMs", stageStartedAt);
  return decoded;
}

function selectedRecordDecodeCacheKey(record) {
  return JSON.stringify(selectedPrecipRecordIdentity(record));
}

function decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation = true) {
  return categoricalPrecipTypeInterpolation && PRECIP_TYPE_DECODE_KEYS.has(key) ? "nearest" : "bilinear";
}

function parseWgribSimpleInventory(text) {
  const rows = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(":");
    const record = String(parts[0] || "").trim();
    const recordNumber = Number(record);
    if (!record) {
      continue;
    }
    rows.push({
      line,
      record,
      recordNumber,
      fieldOrdinal: rows.length + 1,
      offset: Number(parts[1]),
      dateToken: String(parts[2] || ""),
      param: String(parts[3] || ""),
      level: String(parts[4] || ""),
      forecast: String(parts[5] || ""),
      extra: parts.slice(6).join(":"),
    });
  }
  return rows;
}

function buildBulkDecodedRecordIndex(records) {
  const exact = new Map();
  const byParamLevel = new Map();
  const byRecord = new Map();
  for (const record of records || []) {
    const recordKey = String(record?.record || "");
    const recordQueue = byRecord.get(recordKey) || [];
    recordQueue.push(record);
    byRecord.set(recordKey, recordQueue);
    const exactKey = bulkDecodedRecordExactKey(record);
    const exactQueue = exact.get(exactKey) || [];
    exactQueue.push(record);
    exact.set(exactKey, exactQueue);
    const fallbackKey = bulkDecodedRecordParamLevelKey(record);
    const fallbackQueue = byParamLevel.get(fallbackKey) || [];
    fallbackQueue.push(record);
    byParamLevel.set(fallbackKey, fallbackQueue);
  }
  return { byRecord, exact, byParamLevel };
}

function takeBulkDecodedRecordBySelectedPlan(index, selectedRecordIndex, sourceRecord, usedRecordNumbers) {
  const mappedRecord = selectedRecordIndex?.get(sourceRecord?.record);
  if (!mappedRecord) {
    return null;
  }
  return takeFirstUnusedRecord(
    index.byRecord.get(String(mappedRecord)),
    usedRecordNumbers,
    (record) => bulkDecodedRecordExactKey(record) === bulkDecodedRecordExactKey(sourceRecord),
  );
}

function takeBulkDecodedRecord(index, sourceRecord, usedRecordNumbers) {
  return (
    takeFirstUnusedRecord(index.exact.get(bulkDecodedRecordExactKey(sourceRecord)), usedRecordNumbers) ||
    takeFirstUnusedRecord(index.byParamLevel.get(bulkDecodedRecordParamLevelKey(sourceRecord)), usedRecordNumbers) ||
    null
  );
}

function takeFirstUnusedRecord(queue, usedRecordNumbers, predicate = null) {
  if (typeof predicate === "function") {
    const matchIndex = Array.isArray(queue)
      ? queue.findIndex((record) => !usedRecordNumbers.has(bulkDecodedRecordOrdinal(record)) && predicate(record))
      : -1;
    return matchIndex >= 0 ? queue.splice(matchIndex, 1)[0] : null;
  }
  while (Array.isArray(queue) && queue.length > 0) {
    const record = queue.shift();
    const ordinal = bulkDecodedRecordOrdinal(record);
    if (!usedRecordNumbers.has(ordinal)) {
      return record;
    }
  }
  return null;
}

function bulkDecodedRecordOrdinal(record) {
  const ordinal = Number(record?.fieldOrdinal);
  if (Number.isFinite(ordinal) && ordinal >= 1) {
    return Math.round(ordinal);
  }
  const recordNumber = Number(record?.recordNumber);
  return Number.isFinite(recordNumber) && recordNumber >= 1 ? Math.floor(recordNumber) : 1;
}

function bulkDecodedRecordExactKey(record) {
  return `${record?.param || ""}\u0000${record?.level || ""}\u0000${record?.forecast || ""}`;
}

function bulkDecodedRecordParamLevelKey(record) {
  return `${record?.param || ""}\u0000${record?.level || ""}`;
}

function requiredDecodeKeys(catalog) {
  const keys = new Set();
  for (const entry of catalog || []) {
    if (!entry?.required) {
      continue;
    }
    if (entry.kind === "wind") {
      keys.add(entry.uKey);
      keys.add(entry.vKey);
    } else if (entry.inputKey) {
      keys.add(entry.inputKey);
    }
  }
  return keys;
}

async function decodeSelectedRecordsLegacy({
  gribPath,
  selectedPlan,
  selection,
  hour = null,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  decodeConcurrency = 1,
  categoricalPrecipTypeInterpolation = true,
  profile = null,
  decodeSession = null,
}) {
  const stageStartedAt = performance.now();
  const decoded = {};
  const skippedDecodeKeys = new Set();
  const resolvedDecodeConcurrency = clampInt(decodeConcurrency, 1, 8, 1);
  const windEntries = (selection.catalog || []).filter(
    (entry) => entry.kind === "wind" && selection.records[entry.uKey] && selection.records[entry.vKey],
  );
  await mapWithConcurrency(windEntries, resolvedDecodeConcurrency, async (entry) => {
    try {
      const pairDecoded = await decodeWindPairToGrids({
        gribPath,
        tempDir,
        wgrib2Path,
        bounds,
        width,
        height,
        level: entry.uSelector.level,
        outputUKey: entry.uKey,
        outputVKey: entry.vKey,
      });
      Object.assign(decoded, pairDecoded);
      for (const key of [entry.uKey, entry.vKey]) {
        writeDecodedRecordGridCache({
          record: selection.records[key],
          values: pairDecoded[key],
          hour,
          bounds,
          width,
          height,
          rowInterpolation: "bilinear",
          decodeSession,
        });
      }
    } catch (error) {
      if (entry.required) {
        throw error;
      }
      skippedDecodeKeys.add(entry.uKey);
      skippedDecodeKeys.add(entry.vKey);
    }
  });
  const scalarDecodeTasks = Object.entries(selection.records)
    .map(([key, record]) => {
      if (!record || skippedDecodeKeys.has(key) || decoded[key]) {
        return null;
      }
      const partialIndex = selectedPlan.recordIndexByOriginalRecord.get(record.record);
      return partialIndex ? { key, record, recordIndex: partialIndex } : null;
    })
    .filter(Boolean);
  const scalarGridPromisesByRecord = new Map();
  await mapWithConcurrency(scalarDecodeTasks, resolvedDecodeConcurrency, async ({ key, record, recordIndex }) => {
    const rowInterpolation = decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation);
    const gridCacheKey = `${recordIndex}:${rowInterpolation}`;
    let gridPromise = scalarGridPromisesByRecord.get(gridCacheKey);
    if (!gridPromise) {
      gridPromise = decodeRecordToGrid({
        gribPath,
        recordIndex,
        key,
        tempDir,
        wgrib2Path,
        bounds,
        width,
        height,
        categoricalPrecipTypeInterpolation,
      });
      scalarGridPromisesByRecord.set(gridCacheKey, gridPromise);
    }
    const values = await gridPromise;
    decoded[key] = values;
    writeDecodedRecordGridCache({
      record,
      values,
      hour,
      bounds,
      width,
      height,
      rowInterpolation,
      decodeSession,
    });
  });
  recordProfileStage(profile, "legacyDecodeMs", stageStartedAt);
  return decoded;
}

async function decodeWindPairToGrids({
  gribPath,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  level = "10 m above ground",
  outputUKey = "windU10m",
  outputVKey = "windV10m",
}) {
  const safeName = String(outputUKey || "wind").replace(/[^a-zA-Z0-9_-]+/g, "-");
  const gridPath = path.join(tempDir, `${safeName}-pair.grib2`);
  const dlon = (bounds.east - bounds.west) / Math.max(1, width - 1);
  const dlat = (bounds.north - bounds.south) / Math.max(1, height - 1);
  await fs.promises.rm(gridPath, { force: true }).catch(() => {});
  await runCommand(wgrib2Path, [
    gribPath,
    "-match",
    `:(UGRD|VGRD):${escapeWgrib2MatchLiteral(level)}:`,
    "-new_grid_winds",
    "earth",
    "-new_grid_interpolation",
    "bilinear",
    "-new_grid",
    "latlon",
    `${bounds.west}:${width}:${dlon}`,
    `${bounds.south}:${height}:${dlat}`,
    gridPath,
  ]);
  return {
    [outputUKey]: await decodeRegriddedRecordToGrid({
      gridPath,
      recordIndex: "1",
      binPath: path.join(tempDir, `${outputUKey}.bin`),
      wgrib2Path,
      bounds,
      width,
      height,
    }),
    [outputVKey]: await decodeRegriddedRecordToGrid({
      gridPath,
      recordIndex: "2",
      binPath: path.join(tempDir, `${outputVKey}.bin`),
      wgrib2Path,
      bounds,
      width,
      height,
    }),
  };
}

function escapeWgrib2MatchLiteral(value) {
  return String(value || "").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function decodeRecordToGrid({
  gribPath,
  recordIndex,
  key,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation = true,
}) {
  const gridPath = path.join(tempDir, `${key}.grib2`);
  const binPath = path.join(tempDir, `${key}.bin`);
  await fs.promises.rm(gridPath, { force: true }).catch(() => {});
  await fs.promises.rm(binPath, { force: true }).catch(() => {});
  await runCommand(
    wgrib2Path,
    buildNoaaRegridArgs({
      gribPath,
      recordIndex,
      gridPath,
      bounds,
      width,
      height,
      interpolation: categoricalPrecipTypeInterpolation && PRECIP_TYPE_DECODE_KEYS.has(key) ? "neighbor" : "bilinear",
    }),
  );
  return decodeRegriddedRecordToGrid({
    gridPath,
    recordIndex: "1",
    binPath,
    wgrib2Path,
    bounds,
    width,
    height,
    rowInterpolation: categoricalPrecipTypeInterpolation && PRECIP_TYPE_DECODE_KEYS.has(key) ? "nearest" : "bilinear",
  });
}

function buildNoaaRegridArgs({
  gribPath,
  recordIndex = null,
  gridPath,
  bounds,
  width,
  height,
  interpolation = "bilinear",
  useCategoricalPrecipTypeInterpolation = false,
}) {
  const dlon = (bounds.east - bounds.west) / Math.max(1, width - 1);
  const dlat = (bounds.north - bounds.south) / Math.max(1, height - 1);
  const args = [gribPath];
  if (recordIndex !== null && recordIndex !== undefined) {
    args.push("-d", String(recordIndex));
  }
  args.push("-new_grid_winds", "earth", "-new_grid_interpolation", interpolation);
  if (useCategoricalPrecipTypeInterpolation) {
    args.push("-if", PRECIP_TYPE_REGRID_PATTERN, "-new_grid_interpolation", "neighbor", "-fi");
  }
  args.push("-new_grid", "latlon", `${bounds.west}:${width}:${dlon}`, `${bounds.south}:${height}:${dlat}`, gridPath);
  return args;
}

async function decodeRegriddedRecordToGrid({
  gridPath,
  recordIndex,
  binPath,
  wgrib2Path,
  bounds,
  width,
  height,
  rowInterpolation = "bilinear",
}) {
  await fs.promises.rm(binPath, { force: true }).catch(() => {});
  await runCommand(wgrib2Path, [gridPath, "-d", String(recordIndex), "-order", "we:sn", "-no_header", "-bin", binPath]);
  const expectedBytes = width * height * 4;
  const body = await fs.promises.readFile(binPath);
  if (body.length !== expectedBytes) {
    throw new Error(`Decoded NOAA grid has ${body.length} bytes; expected ${expectedBytes}.`);
  }
  return decodeSouthNorthBinaryGridBuffer({ body, byteOffset: 0, bounds, width, height, rowInterpolation });
}

async function decodeBinaryGridFileSlice({
  fileHandle,
  byteOffset,
  fieldBytes,
  bounds,
  width,
  height,
  rowInterpolation = "bilinear",
  rowMapCache = null,
  decodeSession = null,
}) {
  const body = Buffer.allocUnsafe(fieldBytes);
  const { bytesRead } = await fileHandle.read(body, 0, fieldBytes, byteOffset);
  if (bytesRead !== fieldBytes) {
    throw new Error(`Decoded NOAA binary slice read ${bytesRead} bytes; expected ${fieldBytes}.`);
  }
  return decodeSouthNorthBinaryGridBuffer({
    body,
    byteOffset: 0,
    bounds,
    width,
    height,
    rowInterpolation,
    rowMapCache,
    decodeSession,
  });
}

function decodeBinaryGridBuffer({ body, byteOffset, bounds, width, height, rowInterpolation = "bilinear" }) {
  const expectedBytes = width * height * 4;
  if (byteOffset < 0 || byteOffset + expectedBytes > body.length) {
    throw new Error(`Decoded NOAA binary offset ${byteOffset} is outside ${body.length} bytes.`);
  }
  return decodeSouthNorthBinaryGridBuffer({ body, byteOffset, bounds, width, height, rowInterpolation });
}

function decodeSouthNorthBinaryGridBuffer({
  body,
  byteOffset,
  bounds,
  width,
  height,
  rowInterpolation = "bilinear",
  rowMapCache = null,
  decodeSession = null,
}) {
  const total = width * height;
  const absoluteOffset = body.byteOffset + byteOffset;
  if (absoluteOffset % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return decodeSouthNorthBinaryGridBufferUnaligned({
      body,
      byteOffset,
      bounds,
      width,
      height,
      rowInterpolation,
      rowMapCache,
      decodeSession,
    });
  }
  const source = new Float32Array(body.buffer, absoluteOffset, total);
  return remapSouthNorthLinearLatGridToMercatorRows(source, width, height, bounds, rowInterpolation, {
    rowMapCache,
    decodeSession,
  });
}

function decodeSouthNorthBinaryGridBufferUnaligned({
  body,
  byteOffset,
  bounds,
  width,
  height,
  rowInterpolation = "bilinear",
  rowMapCache = null,
  decodeSession = null,
}) {
  const total = width * height;
  const source = new Float32Array(total);
  for (let index = 0; index < total; index += 1) {
    source[index] = body.readFloatLE(byteOffset + index * 4);
  }
  return remapSouthNorthLinearLatGridToMercatorRows(source, width, height, bounds, rowInterpolation, {
    rowMapCache,
    decodeSession,
  });
}

function remapSouthNorthLinearLatGridToMercatorRows(
  values,
  width,
  height,
  bounds,
  rowInterpolation = "bilinear",
  options = {},
) {
  if (!values || values.length !== width * height || !bounds) {
    return values;
  }
  const rowMap = getMercatorRowRemapTable({
    width,
    height,
    bounds,
    rowInterpolation,
    rowMapCache: options.rowMapCache,
    decodeSession: options.decodeSession,
  });
  if (!rowMap) {
    return sanitizeGridValues(values);
  }
  if (rowMap.mode === "nearest") {
    return remapSouthNorthLinearLatGridToMercatorRowsNearest(values, width, height, rowMap);
  }
  const out = new Float32Array(width * height).fill(Number.NaN);
  for (let y = 0; y < height; y += 1) {
    const base0 = rowMap.base0[y];
    const base1 = rowMap.base1[y];
    if (base0 < 0 || base1 < 0) {
      continue;
    }
    const ty = rowMap.weight[y];
    const outBase = y * width;
    for (let x = 0; x < width; x += 1) {
      const lower = normalizeGribFloat(values[base0 + x]);
      const upper = normalizeGribFloat(values[base1 + x]);
      if (Number.isFinite(lower) && Number.isFinite(upper)) {
        out[outBase + x] = lower * (1 - ty) + upper * ty;
      } else if (Number.isFinite(lower)) {
        out[outBase + x] = lower;
      } else if (Number.isFinite(upper)) {
        out[outBase + x] = upper;
      }
    }
  }
  return out;
}

function remapSouthNorthLinearLatGridToMercatorRowsNearest(values, width, height, rowMap) {
  const out = new Float32Array(width * height).fill(Number.NaN);
  for (let y = 0; y < height; y += 1) {
    const base = rowMap.base[y];
    if (base < 0) {
      continue;
    }
    const outBase = y * width;
    for (let x = 0; x < width; x += 1) {
      out[outBase + x] = normalizeGribFloat(values[base + x]);
    }
  }
  return out;
}

function getMercatorRowRemapTable({
  width,
  height,
  bounds,
  rowInterpolation = "bilinear",
  rowMapCache = null,
  decodeSession = null,
}) {
  const north = Number(bounds?.north);
  const south = Number(bounds?.south);
  const latSpan = north - south;
  if (!Number.isFinite(north) || !Number.isFinite(south) || Math.abs(latSpan) < 1e-9) {
    return null;
  }
  const mode = isNearestRowInterpolation(rowInterpolation) ? "nearest" : "bilinear";
  const cache = rowMapCache || WORKER_ROW_REMAP_CACHE;
  const key = `${mode}:${Math.round(Number(width))}x${Math.round(Number(height))}:${bounds.west},${bounds.east},${bounds.south},${bounds.north}`;
  const cached = cache.get(key);
  if (cached) {
    incrementDecodeSessionCounter(decodeSession, "rowMapHits");
    return cached;
  }
  incrementDecodeSessionCounter(decodeSession, "rowMapMisses");
  const table =
    mode === "nearest"
      ? buildNearestMercatorRowRemapTable({ width, height, bounds, south, latSpan })
      : buildBilinearMercatorRowRemapTable({ width, height, bounds, south, latSpan });
  cache.set(key, table);
  trimMapToMaxEntries(cache, ROW_REMAP_CACHE_MAX_ENTRIES);
  return table;
}

function buildBilinearMercatorRowRemapTable({ width, height, bounds, south, latSpan }) {
  const base0 = new Int32Array(height);
  const base1 = new Int32Array(height);
  const weight = new Float64Array(height);
  base0.fill(-1);
  base1.fill(-1);
  weight.fill(Number.NaN);
  for (let y = 0; y < height; y += 1) {
    const lat = rowToLatMercator(y, height, bounds);
    const sourceY = ((lat - south) / latSpan) * (height - 1);
    if (!Number.isFinite(sourceY)) {
      continue;
    }
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(sourceY)));
    const y1 = Math.max(0, Math.min(height - 1, y0 + 1));
    base0[y] = y0 * width;
    base1[y] = y1 * width;
    weight[y] = Math.max(0, Math.min(1, sourceY - y0));
  }
  return { mode: "bilinear", base0, base1, weight };
}

function buildNearestMercatorRowRemapTable({ width, height, bounds, south, latSpan }) {
  const base = new Int32Array(height);
  base.fill(-1);
  for (let y = 0; y < height; y += 1) {
    const lat = rowToLatMercator(y, height, bounds);
    const sourceY = ((lat - south) / latSpan) * (height - 1);
    if (!Number.isFinite(sourceY)) {
      continue;
    }
    const sourceRow = Math.max(0, Math.min(height - 1, Math.round(sourceY)));
    base[y] = sourceRow * width;
  }
  return { mode: "nearest", base };
}

function trimMapToMaxEntries(map, maxEntries) {
  const limit = Math.max(1, Number(maxEntries) || 1);
  while (map.size > limit) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

function isNearestRowInterpolation(rowInterpolation) {
  const normalized = String(rowInterpolation || "").toLowerCase();
  return normalized === "nearest" || normalized === "neighbor";
}

function sanitizeGridValues(values) {
  const out = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    out[index] = normalizeGribFloat(values[index]);
  }
  return out;
}

function normalizeGribFloat(value) {
  return Number.isFinite(value) && Math.abs(value) < 1e19 ? value : Number.NaN;
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NOAA request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

async function fetchContentLength(url) {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`NOAA HEAD request failed (${response.status}) for ${url}`);
  }
  const length = Number(response.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0) {
    throw new Error(`NOAA response is missing content-length for ${url}`);
  }
  return length;
}

function renderScalarGrid({
  values,
  width,
  height,
  normalize,
  stops,
  minVisible,
  maxVisible,
  visibleRange,
  alpha = 1,
  alphaForValue = null,
  colorForValue = null,
  colorLookup = null,
  transformValue = null,
  transformScale = null,
  transformOffset = 0,
  transformMin = null,
}) {
  if (
    colorLookup?.kind === "continuous" &&
    typeof alphaForValue !== "function" &&
    typeof colorForValue !== "function"
  ) {
    return renderScalarGridContinuous({
      values,
      width,
      height,
      minVisible,
      maxVisible,
      visibleRange,
      colorLookup,
      transformValue,
      transformScale,
      transformOffset,
      transformMin,
    });
  }
  if (colorLookup?.kind === "step" && typeof alphaForValue !== "function" && typeof colorForValue !== "function") {
    return renderScalarGridStep({
      values,
      width,
      height,
      minVisible,
      maxVisible,
      visibleRange,
      colorLookup,
      transformValue,
      transformScale,
      transformOffset,
      transformMin,
    });
  }

  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (!values || values.length !== cellCount) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  let visibleCount = 0;
  let validCount = 0;
  const transform = typeof transformValue === "function" ? transformValue : null;
  const affineTransform = buildAffineTransformState(transformScale, transformOffset, transformMin);
  const hasAffineTransform = Boolean(affineTransform);
  const affineScale = hasAffineTransform ? affineTransform.scale : 1;
  const affineOffset = hasAffineTransform ? affineTransform.offset : 0;
  const affineHasMin = hasAffineTransform && affineTransform.hasMin;
  const affineMin = affineHasMin ? affineTransform.min : 0;
  for (let index = 0; index < values.length; index += 1) {
    let value = values[index];
    if (transform) {
      value = transform(value);
    } else if (hasAffineTransform) {
      value = value * affineScale + affineOffset;
      if (affineHasMin && value < affineMin) {
        value = affineMin;
      }
    }
    if (value === value) {
      validCount += 1;
    }
    if (!isValueInVisibleRange(value, minVisible, maxVisible, visibleRange)) {
      continue;
    }
    const color =
      typeof colorForValue === "function" ? colorForValue(value) : interpolateStops(stops, normalize(value));
    const resolvedAlpha = typeof alphaForValue === "function" ? alphaForValue(value) : alpha;
    const stopAlpha = Number.isFinite(color?.[3]) ? color[3] : 1;
    if (!color || resolvedAlpha <= 0 || stopAlpha <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = clampInt(resolvedAlpha * stopAlpha * 255, 0, 255, 0);
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridContinuous({
  values,
  width,
  height,
  minVisible,
  maxVisible,
  visibleRange,
  colorLookup,
  transformValue = null,
  transformScale = null,
  transformOffset = 0,
  transformMin = null,
}) {
  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (!values || values.length !== cellCount || !colorLookup?.colors) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const transform = typeof transformValue === "function" ? transformValue : null;
  const affineTransform = buildAffineTransformState(transformScale, transformOffset, transformMin);
  if (transform) {
    return renderScalarGridContinuousFunction({
      rgba,
      values,
      cellCount,
      colorLookup,
      visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
      transform,
    });
  }
  if (affineTransform) {
    return renderScalarGridContinuousAffine({
      rgba,
      values,
      cellCount,
      colorLookup,
      visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
      affineTransform,
    });
  }
  return renderScalarGridContinuousRaw({
    rgba,
    values,
    cellCount,
    colorLookup,
    visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
  });
}

function renderScalarGridContinuousRaw({ rgba, values, cellCount, colorLookup, visible }) {
  const colors = colorLookup.colors;
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = values[index];
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    const position =
      colorLookup.log && value > 0
        ? (Math.log(value) - colorLookup.logMin) * colorLookup.logScale
        : (value - colorLookup.min) * colorLookup.scale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridContinuousAffine({ rgba, values, cellCount, colorLookup, visible, affineTransform }) {
  const hasAffineTransform = Boolean(affineTransform);
  const affineScale = hasAffineTransform ? affineTransform.scale : 1;
  const affineOffset = hasAffineTransform ? affineTransform.offset : 0;
  const affineHasMin = hasAffineTransform && affineTransform.hasMin;
  const affineMin = affineHasMin ? affineTransform.min : 0;
  const colors = colorLookup.colors;
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    let value = values[index];
    value = value * affineScale + affineOffset;
    if (affineHasMin && value < affineMin) {
      value = affineMin;
    }
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    const position =
      colorLookup.log && value > 0
        ? (Math.log(value) - colorLookup.logMin) * colorLookup.logScale
        : (value - colorLookup.min) * colorLookup.scale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridContinuousFunction({ rgba, values, cellCount, colorLookup, visible, transform }) {
  const colors = colorLookup.colors;
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = transform(values[index]);
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    const position =
      colorLookup.log && value > 0
        ? (Math.log(value) - colorLookup.logMin) * colorLookup.logScale
        : (value - colorLookup.min) * colorLookup.scale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridStep({
  values,
  width,
  height,
  minVisible,
  maxVisible,
  visibleRange,
  colorLookup,
  transformValue = null,
  transformScale = null,
  transformOffset = 0,
  transformMin = null,
}) {
  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (!values || values.length !== cellCount || !colorLookup?.colors || !colorLookup?.thresholds) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const transform = typeof transformValue === "function" ? transformValue : null;
  const affineTransform = buildAffineTransformState(transformScale, transformOffset, transformMin);
  if (transform) {
    return renderScalarGridStepFunction({
      rgba,
      values,
      cellCount,
      colorLookup,
      visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
      transform,
    });
  }
  if (affineTransform) {
    return renderScalarGridStepAffine({
      rgba,
      values,
      cellCount,
      colorLookup,
      visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
      affineTransform,
    });
  }
  return renderScalarGridStepRaw({
    rgba,
    values,
    cellCount,
    colorLookup,
    visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
  });
}

function renderScalarGridStepRaw({ rgba, values, cellCount, colorLookup, visible }) {
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = values[index];
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    let selected;
    if (uniformScale > 0) {
      selected = Math.floor((value - uniformStart) * uniformScale);
      if (selected < 0) {
        selected = 0;
      } else if (selected >= thresholdCount) {
        selected = thresholdCount - 1;
      }
    } else {
      selected = 0;
      let low = 1;
      let high = thresholdCount - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (value < thresholds[mid]) {
          high = mid - 1;
        } else {
          selected = mid;
          low = mid + 1;
        }
      }
    }
    const colorOffset = selected * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridStepAffine({ rgba, values, cellCount, colorLookup, visible, affineTransform }) {
  const hasAffineTransform = Boolean(affineTransform);
  const affineScale = hasAffineTransform ? affineTransform.scale : 1;
  const affineOffset = hasAffineTransform ? affineTransform.offset : 0;
  const affineHasMin = hasAffineTransform && affineTransform.hasMin;
  const affineMin = affineHasMin ? affineTransform.min : 0;
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    let value = values[index];
    value = value * affineScale + affineOffset;
    if (affineHasMin && value < affineMin) {
      value = affineMin;
    }
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    let selected;
    if (uniformScale > 0) {
      selected = Math.floor((value - uniformStart) * uniformScale);
      if (selected < 0) {
        selected = 0;
      } else if (selected >= thresholdCount) {
        selected = thresholdCount - 1;
      }
    } else {
      selected = 0;
      let low = 1;
      let high = thresholdCount - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (value < thresholds[mid]) {
          high = mid - 1;
        } else {
          selected = mid;
          low = mid + 1;
        }
      }
    }
    const colorOffset = selected * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridStepFunction({ rgba, values, cellCount, colorLookup, visible, transform }) {
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = transform(values[index]);
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    let selected;
    if (uniformScale > 0) {
      selected = Math.floor((value - uniformStart) * uniformScale);
      if (selected < 0) {
        selected = 0;
      } else if (selected >= thresholdCount) {
        selected = thresholdCount - 1;
      }
    } else {
      selected = 0;
      let low = 1;
      let high = thresholdCount - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (value < thresholds[mid]) {
          high = mid - 1;
        } else {
          selected = mid;
          low = mid + 1;
        }
      }
    }
    const colorOffset = selected * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function buildAffineTransformState(transformScale, transformOffset, transformMin) {
  const hasScale = hasFiniteTransformOption(transformScale);
  const hasOffset = hasFiniteTransformOption(transformOffset) && Number(transformOffset) !== 0;
  const hasMin = hasFiniteTransformOption(transformMin);
  if (!hasScale && !hasOffset && !hasMin) {
    return null;
  }
  return {
    scale: hasScale ? Number(transformScale) : 1,
    offset: hasOffset ? Number(transformOffset) : 0,
    min: Number(transformMin),
    hasMin,
  };
}

function hasFiniteTransformOption(value) {
  if (value === null || value === undefined || value === "") {
    return false;
  }
  return Number.isFinite(Number(value));
}

function isValueInVisibleRange(value, minVisible, maxVisible, visibleRange) {
  if (!Number.isFinite(value)) {
    return false;
  }
  const rangeMin = Array.isArray(visibleRange) ? Number(visibleRange[0]) : Number.NaN;
  const rangeMax = Array.isArray(visibleRange) ? Number(visibleRange[1]) : Number.NaN;
  const min = Number.isFinite(rangeMin) ? rangeMin : minVisible;
  const max = Number.isFinite(rangeMax) ? rangeMax : maxVisible;
  if (Number.isFinite(min) && value < min) {
    return false;
  }
  if (Number.isFinite(max) && value > max) {
    return false;
  }
  return true;
}

function resolveVisibleBounds(minVisible, maxVisible, visibleRange) {
  const rangeMin = Array.isArray(visibleRange) ? Number(visibleRange[0]) : Number.NaN;
  const rangeMax = Array.isArray(visibleRange) ? Number(visibleRange[1]) : Number.NaN;
  return {
    min: Number.isFinite(rangeMin) ? rangeMin : minVisible,
    max: Number.isFinite(rangeMax) ? rangeMax : maxVisible,
  };
}

function encodeLayerOrEmpty(layer, emptyPng, width, height, compressionLevel, filterType) {
  if (!layer || layer.visibleCount <= 0) {
    return encodeRawPng(emptyPng);
  }
  return encodeRawPng(encodeRgbaPng(layer.rgba, width, height, compressionLevel, filterType));
}

function recordHoverValueCount(counts, key, layer) {
  if (!counts || !key || !Number.isFinite(Number(layer?.validCount))) {
    return;
  }
  counts.set(key, Math.max(0, Math.round(Number(layer.validCount))));
}

function hasKnownEmptyHoverValues(counts, key) {
  return counts instanceof Map && counts.get(key) === 0;
}

function encodeRawPng(body) {
  return {
    body,
    bytes: body.length,
    contentType: "image/png",
  };
}

function encodeRgbaPng(rgba, width, height, compressionLevel = 1, filterType = 0) {
  if (Number(filterType) === 0) {
    return encodeRgbaPngFilter0(rgba, width, height, compressionLevel);
  }
  const png = new PNG({ width, height });
  png.data = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png, {
    colorType: 6,
    inputHasAlpha: true,
    compressionLevel,
    filterType,
  });
}

function encodeRgbaPngFilter0(rgba, width, height, compressionLevel = 1) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const rowBytes = cols * 4;
  const imageBytes = rowBytes * rows;
  const source = toBufferView(rgba);
  if (source.length < imageBytes) {
    throw new Error(`Cannot encode RGBA PNG: expected ${imageBytes} bytes, received ${source.length}.`);
  }
  const raw = Buffer.alloc(Math.max(0, (rowBytes + 1) * rows));
  for (let row = 0; row < rows; row += 1) {
    const sourceOffset = row * rowBytes;
    const targetOffset = row * (rowBytes + 1);
    raw[targetOffset] = 0;
    source.copy(raw, targetOffset + 1, sourceOffset, sourceOffset + rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cols, 0);
  ihdr.writeUInt32BE(rows, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw, {
    level: clampInt(compressionLevel, 0, 9, 1),
  });
  return Buffer.concat([PNG_SIGNATURE, createPngChunk("IHDR", ihdr), createPngChunk("IDAT", idat), PNG_IEND_CHUNK]);
}

function toBufferView(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(value || []);
}

function createTransparentPng(width, height, compressionLevel = 1, filterType = 0) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const resolvedCompressionLevel = clampInt(compressionLevel, 0, 9, 1);
  const resolvedFilterType = Math.round(Number(filterType) || 0);
  const cacheKey = `${cols}x${rows}:${resolvedCompressionLevel}:${resolvedFilterType}`;
  const cached = TRANSPARENT_PNG_CACHE.get(cacheKey);
  if (cached) {
    return Buffer.from(cached);
  }
  const body = encodeRgbaPng(
    Buffer.alloc(Math.max(0, cols * rows * 4)),
    cols,
    rows,
    resolvedCompressionLevel,
    resolvedFilterType,
  );
  TRANSPARENT_PNG_CACHE.set(cacheKey, body);
  return Buffer.from(body);
}

function renderReflectivityVariants({
  values,
  width,
  height,
  reflectivityGates,
  emptyPng,
  pngCompressionLevel,
  pngFilterType,
}) {
  const variants = {};
  for (const gate of reflectivityGates) {
    const gateDbz = Math.round(Number(gate));
    if (!Number.isFinite(gateDbz)) {
      continue;
    }
    variants[`dbz${gateDbz}`] = encodeLayerOrEmpty(
      renderScalarGrid({
        values,
        width,
        height,
        ...CORE_LAYER_RENDER_OPTIONS.reflectivity,
        minVisible: gateDbz,
      }),
      emptyPng,
      width,
      height,
      pngCompressionLevel,
      pngFilterType,
    );
  }
  return variants;
}

function renderReflectivityPrecipTypeGrid({ reflectivityDbz, rain, snow, freezingRain, sleet, width, height }) {
  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (
    !reflectivityDbz ||
    reflectivityDbz.length !== cellCount ||
    !rain ||
    rain.length !== cellCount ||
    !snow ||
    snow.length !== cellCount ||
    !freezingRain ||
    freezingRain.length !== cellCount ||
    !sleet ||
    sleet.length !== cellCount
  ) {
    return { rgba, visibleCount: 0 };
  }
  const freezingRainLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.freezing_rain;
  const sleetLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.sleet;
  const snowLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.snow;
  const rainLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.rain;
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const dbz = reflectivityDbz[index];
    if (dbz !== dbz) {
      continue;
    }
    let lookup = null;
    if (freezingRain[index] >= 0.5) {
      lookup = freezingRainLookup;
    } else if (sleet[index] >= 0.5) {
      lookup = sleetLookup;
    } else if (snow[index] >= 0.5) {
      lookup = snowLookup;
    } else if (rain[index] >= 0.5) {
      lookup = rainLookup;
    }
    if (!lookup) {
      continue;
    }
    const colorOffset = findReflectivityPrecipTypeColorOffset(lookup, dbz);
    const colors = lookup.colors;
    if (colorOffset < 0 || !colors || colors[colorOffset + 3] <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = colors[colorOffset + 3];
    visibleCount += 1;
  }
  return { rgba, visibleCount };
}

function renderPrecipRateTypeGrid({ precipRate, rain, snow, freezingRain, sleet, width, height }) {
  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (
    !precipRate ||
    precipRate.length !== cellCount ||
    !rain ||
    rain.length !== cellCount ||
    !snow ||
    snow.length !== cellCount ||
    !freezingRain ||
    freezingRain.length !== cellCount ||
    !sleet ||
    sleet.length !== cellCount
  ) {
    return { rgba, visibleCount: 0 };
  }
  const freezingRainLookup = PRECIP_RATE_TYPE_LOOKUPS.freezing_rain;
  const sleetLookup = PRECIP_RATE_TYPE_LOOKUPS.sleet;
  const snowLookup = PRECIP_RATE_TYPE_LOOKUPS.snow;
  const rainLookup = PRECIP_RATE_TYPE_LOOKUPS.rain;
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const rateInHr = precipRate[index] * PRATE_KG_M2_S_TO_IN_HR;
    if (!(rateInHr >= 0.01)) {
      continue;
    }
    let lookup = null;
    if (freezingRain[index] >= 0.5) {
      lookup = freezingRainLookup;
    } else if (sleet[index] >= 0.5) {
      lookup = sleetLookup;
    } else if (snow[index] >= 0.5) {
      lookup = snowLookup;
    } else if (rain[index] >= 0.5) {
      lookup = rainLookup;
    }
    if (!lookup) {
      continue;
    }
    const colorOffset = findStepColorOffset(lookup, rateInHr);
    const colors = lookup.colors;
    if (colorOffset < 0 || !colors || colors[colorOffset + 3] <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = colors[colorOffset + 3];
    visibleCount += 1;
  }
  return { rgba, visibleCount };
}

function findReflectivityPrecipTypeColorOffset(lookup, dbz) {
  const thresholds = lookup?.thresholds;
  const maxes = lookup?.maxes;
  const count = Number(lookup?.count) || 0;
  if (!thresholds || !maxes || count <= 0) {
    return -1;
  }
  let selected = 0;
  let low = 1;
  let high = count - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (dbz < thresholds[mid]) {
      high = mid - 1;
    } else {
      selected = mid;
      low = mid + 1;
    }
  }
  if (selected === count - 1) {
    return selected * 4;
  }
  return dbz < maxes[selected] ? selected * 4 : -1;
}

function findStepColorOffset(lookup, value) {
  const thresholds = lookup?.thresholds;
  const count = Number(lookup?.count) || 0;
  if (!thresholds || count <= 0 || !Number.isFinite(value)) {
    return -1;
  }
  let selected = 0;
  let low = 1;
  let high = count - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (value < thresholds[mid]) {
      high = mid - 1;
    } else {
      selected = mid;
      low = mid + 1;
    }
  }
  return selected * 4;
}

function pickDefaultReflectivityArtifact(variants) {
  return variants?.dbz15 || variants?.dbz20 || variants?.dbz10 || null;
}

function isReflectivityLayerKey(layerKey) {
  return layerKey === LEGACY_REFLECTIVITY_LAYER_KEY || REFLECTIVITY_LAYER_KEYS.includes(layerKey);
}

function buildHoverGridVariables({
  decoded,
  selection,
  temperatureF,
  windMph,
  precipIn,
  precipAccumulationIn,
  snowfallIn,
  reflectivityCompositeDbz,
  reflectivity1kmDbz,
  pressureHpa,
  width,
  height,
  getWindSpeedGrid = null,
  hoverValueCounts = null,
}) {
  const rawCellCount = Number(width) * Number(height);
  const cellCount = Number.isFinite(rawCellCount) && rawCellCount > 0 ? Math.round(rawCellCount) : 0;
  const variables = {};
  const availableParameters = new Set(selection?.availableParameters || []);
  const isAvailable = (entry) => availableParameters.size === 0 || availableParameters.has(entry.key);
  const addVariable = (key, values, unit, transformValue = null) => {
    if (hasKnownEmptyHoverValues(hoverValueCounts, key)) {
      return;
    }
    const variable = quantizeHoverGridVariable(values, resolveHoverQuantizeScale(unit), cellCount, transformValue);
    addHoverGridVariable(variables, key, variable);
  };

  for (const entry of selection?.catalog || NOAA_NAM_PARAMETER_CATALOG) {
    if (!entry || entry.hidden || !isAvailable(entry)) {
      continue;
    }
    if (entry.key === "temperature") {
      addVariable(entry.key, temperatureF, entry.unit);
      continue;
    }
    if (entry.key === "wind") {
      addVariable(entry.key, windMph, entry.unit);
      continue;
    }
    if (entry.key === "precip") {
      addVariable(entry.key, precipIn, entry.unit);
      continue;
    }
    if (entry.key === "reflectivityComposite") {
      addVariable(entry.key, reflectivityCompositeDbz, entry.unit);
      continue;
    }
    if (entry.key === "reflectivity1km") {
      addVariable(entry.key, reflectivity1kmDbz, entry.unit);
      continue;
    }
    if (entry.kind === "precipAccumulation") {
      addVariable(entry.key, precipAccumulationIn?.[entry.key], entry.unit);
      continue;
    }
    if (entry.kind === "snowfallDerived" || entry.kind === "snowfallDirect") {
      addVariable(entry.key, snowfallIn?.[entry.key], entry.unit);
      continue;
    }
    if (entry.kind === "reflectivityPrecipType") {
      // The precip-type layer uses the same reflectivity value as the 1 km AGL reflectivity layer.
      continue;
    }
    if (entry.kind === "precipRateType") {
      addVariable(entry.key, decoded?.[entry.rateKey], entry.unit, {
        transformScale: PRATE_KG_M2_S_TO_IN_HR,
        transformMin: 0,
      });
      continue;
    }
    if (entry.kind === "wind") {
      if (hasKnownEmptyHoverValues(hoverValueCounts, entry.key)) {
        continue;
      }
      const speedGrid = typeof getWindSpeedGrid === "function" ? getWindSpeedGrid(entry) : null;
      if (speedGrid) {
        addVariable(entry.key, speedGrid, entry.unit);
      } else {
        addHoverGridVariable(
          variables,
          entry.key,
          quantizeHoverWindGridVariable({
            uValues: decoded?.[entry.uKey],
            vValues: decoded?.[entry.vKey],
            multiplier: entry.transform === "windKt" ? MPS_TO_KT : MPS_TO_MPH,
            scale: resolveHoverQuantizeScale(entry.unit),
            cellCount,
          }),
        );
      }
      continue;
    }
    const source = resolveCatalogSourceGrid(entry, decoded, width, height);
    if (!source) {
      continue;
    }
    addVariable(entry.key, source, entry.unit, resolveHoverTransformValue(entry, selection));
  }

  addHoverGridVariable(variables, "pressureHpa", quantizeHoverGridVariable(pressureHpa, 0.05, cellCount));
  return variables;
}

function addHoverGridVariable(variables, key, variable) {
  if (!key || !(variable?.values instanceof Int16Array) || Number(variable.validCount) <= 0) {
    return;
  }
  variables[key] = variable;
}

function resolveHoverTransformValue(entry, selection) {
  if (!entry || !entry.transform || entry.transform === "identity") {
    return null;
  }
  if (entry.transform === "precipRate") {
    const divisor = parseAccumulationHours(selection?.records?.[entry.inputKey]) || 1;
    return {
      transformScale: MM_TO_IN / divisor,
      transformMin: 0,
    };
  }
  return resolveCatalogAffineTransform(entry.transform) || resolveCatalogTransformValue(entry, selection);
}

function resolveHoverQuantizeScale(unit) {
  const normalized = String(unit || "").trim();
  if (normalized === "F" || normalized === "C" || normalized === "hPa") {
    return 0.05;
  }
  if (normalized === "in") {
    return 0.01;
  }
  if (normalized === "in/hr") {
    return 0.001;
  }
  if (
    normalized === "%" ||
    normalized === "mph" ||
    normalized === "kt" ||
    normalized === "dBZ" ||
    normalized === "mi" ||
    normalized === "mm"
  ) {
    return 0.1;
  }
  if (normalized === "ft") {
    return 5;
  }
  if (normalized === "m" || normalized === "J/kg" || normalized === "m2/s2") {
    return 1;
  }
  return 0.1;
}

function buildHoverGridArtifact({ width, height, variables = {}, format = "json" }) {
  const normalizedVariables = {};
  for (const [key, variable] of Object.entries(variables || {})) {
    if (key && variable?.values instanceof Int16Array) {
      normalizedVariables[key] = variable;
    }
  }
  if (String(format || "").toLowerCase() === "binary") {
    const body = encodeHoverGridBinaryPayload({
      schemaVersion: HOVER_GRID_SCHEMA_VERSION,
      rows: height,
      cols: width,
      variables: normalizedVariables,
      gzipLevel: HOVER_GRID_GZIP_LEVEL,
    });
    return {
      body,
      bytes: body.length,
      contentType: "application/octet-stream",
      contentEncoding: "gzip",
      schemaVersion: HOVER_GRID_SCHEMA_VERSION,
    };
  }
  const payload = {
    schemaVersion: HOVER_GRID_SCHEMA_VERSION,
    rows: height,
    cols: width,
    variables: Object.fromEntries(
      Object.entries(normalizedVariables).map(([key, variable]) => [key, hoverGridVariableToJson(variable)]),
    ),
  };
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: HOVER_GRID_GZIP_LEVEL });
  return {
    body,
    bytes: body.length,
    contentType: "application/json",
    contentEncoding: "gzip",
    schemaVersion: HOVER_GRID_SCHEMA_VERSION,
  };
}

function hoverGridVariableToJson(variable) {
  const values = variable?.values instanceof Int16Array ? variable.values : new Int16Array(0);
  return {
    scale: Number.isFinite(Number(variable?.scale)) ? Number(variable.scale) : 1,
    offset: Number.isFinite(Number(variable?.offset)) ? Number(variable.offset) : 0,
    missing: Number.isFinite(Number(variable?.missing)) ? Number(variable.missing) : HOVER_GRID_MISSING_VALUE,
    data: Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64"),
  };
}

function quantizeHoverGridVariable(values, scale, cellCount, transformValue = null) {
  const total = Math.max(0, Number(cellCount) || Number(values?.length) || 0);
  const sourceLength = Math.min(total, Number(values?.length) || 0);
  const resolvedScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  if (!values || total <= 0 || sourceLength <= 0) {
    return emptyHoverGridVariable(resolvedScale);
  }
  const encoded = new Int16Array(total);
  const quantizeMultiplier = 1 / resolvedScale;
  const transform = typeof transformValue === "function" ? transformValue : null;
  const affineTransform =
    transformValue && typeof transformValue === "object"
      ? buildAffineTransformState(
          transformValue.transformScale,
          transformValue.transformOffset,
          transformValue.transformMin,
        )
      : null;
  const validCount = transform
    ? quantizeHoverFunctionValues(encoded, values, sourceLength, quantizeMultiplier, transform)
    : affineTransform
      ? quantizeHoverAffineValues(encoded, values, sourceLength, quantizeMultiplier, affineTransform)
      : quantizeHoverRawValues(encoded, values, sourceLength, quantizeMultiplier);
  if (sourceLength < total) {
    encoded.fill(HOVER_GRID_MISSING_VALUE, sourceLength);
  }
  return {
    scale: resolvedScale,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: encoded,
    validCount,
  };
}

function quantizeHoverRawValues(encoded, values, sourceLength, quantizeMultiplier) {
  let validCount = 0;
  for (let index = 0; index < sourceLength; index += 1) {
    const value = values[index];
    if (value !== value) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      continue;
    }
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
    validCount += 1;
  }
  return validCount;
}

function quantizeHoverAffineValues(encoded, values, sourceLength, quantizeMultiplier, affineTransform) {
  const affineScale = affineTransform.scale;
  const affineOffset = affineTransform.offset;
  const affineHasMin = affineTransform.hasMin;
  const affineMin = affineHasMin ? affineTransform.min : 0;
  let validCount = 0;
  for (let index = 0; index < sourceLength; index += 1) {
    let value = values[index] * affineScale + affineOffset;
    if (affineHasMin && value < affineMin) {
      value = affineMin;
    }
    if (value !== value) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      continue;
    }
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
    validCount += 1;
  }
  return validCount;
}

function quantizeHoverFunctionValues(encoded, values, sourceLength, quantizeMultiplier, transform) {
  let validCount = 0;
  for (let index = 0; index < sourceLength; index += 1) {
    const value = transform(values[index]);
    if (value !== value) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      continue;
    }
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
    validCount += 1;
  }
  return validCount;
}

function quantizeHoverWindGridVariable({ uValues, vValues, multiplier = MPS_TO_MPH, scale, cellCount }) {
  const total = Math.max(0, Number(cellCount) || Number(uValues?.length) || Number(vValues?.length) || 0);
  const resolvedScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  if (!uValues || !vValues || uValues.length !== vValues.length) {
    return emptyHoverGridVariable(resolvedScale);
  }
  const sourceLength = Math.min(total, uValues.length, vValues.length);
  if (total <= 0 || sourceLength <= 0) {
    return emptyHoverGridVariable(resolvedScale);
  }
  const encoded = new Int16Array(total);
  const quantizeMultiplier = 1 / resolvedScale;
  let validCount = 0;
  for (let index = 0; index < sourceLength; index += 1) {
    const u = uValues[index];
    const v = vValues[index];
    if (u !== u || v !== v) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      continue;
    }
    const value = Math.sqrt(u * u + v * v) * multiplier;
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
    validCount += 1;
  }
  if (sourceLength < total) {
    encoded.fill(HOVER_GRID_MISSING_VALUE, sourceLength);
  }
  return {
    scale: resolvedScale,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: encoded,
    validCount,
  };
}

function emptyHoverGridVariable(scale) {
  return {
    scale,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: new Int16Array(0),
    validCount: 0,
  };
}

function transformGridAffine(values, scale = 1, offset = 0, min = null) {
  if (!values) {
    return null;
  }
  const resolvedScale = Number.isFinite(Number(scale)) ? Number(scale) : 1;
  const resolvedOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  const hasMin = Number.isFinite(Number(min));
  const resolvedMin = hasMin ? Number(min) : 0;
  const out = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    let value = values[index] * resolvedScale + resolvedOffset;
    if (hasMin && value < resolvedMin) {
      value = resolvedMin;
    }
    out[index] = value === value ? value : Number.NaN;
  }
  return out;
}

function buildWindSpeedGrid(uValues, vValues, multiplier = MPS_TO_KT) {
  if (!uValues || !vValues || uValues.length !== vValues.length) {
    return null;
  }
  const out = new Float32Array(uValues.length);
  for (let index = 0; index < out.length; index += 1) {
    const u = uValues[index];
    const v = vValues[index];
    if (u === u && v === v) {
      out[index] = Math.sqrt(u * u + v * v) * multiplier;
    } else {
      out[index] = Number.NaN;
    }
  }
  return out;
}

function renderWindSpeedLayer({
  uValues,
  vValues,
  multiplier = MPS_TO_KT,
  width,
  height,
  colorLookup,
  minVisible,
  maxVisible,
  visibleRange,
}) {
  const cellCount = width * height;
  if (!uValues || !vValues || uValues.length !== cellCount || vValues.length !== cellCount) {
    return null;
  }
  if (colorLookup?.kind === "step") {
    return renderWindSpeedStepLayer({
      uValues,
      vValues,
      multiplier,
      width,
      height,
      colorLookup,
      minVisible,
      maxVisible,
      visibleRange,
    });
  }
  return renderWindSpeedContinuousLayer({
    uValues,
    vValues,
    multiplier,
    width,
    height,
    colorLookup,
    minVisible,
    maxVisible,
    visibleRange,
  });
}

function renderWindSpeedContinuousLayer({
  uValues,
  vValues,
  multiplier,
  width,
  height,
  colorLookup,
  minVisible,
  maxVisible,
  visibleRange,
}) {
  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (!colorLookup?.colors) {
    return { rgba, visibleCount: 0 };
  }
  const colors = colorLookup.colors;
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  const visible = resolveVisibleBounds(minVisible, maxVisible, visibleRange);
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const u = uValues[index];
    const v = vValues[index];
    if (u !== u || v !== v) {
      continue;
    }
    const value = Math.sqrt(u * u + v * v) * multiplier;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    const position =
      colorLookup.log && value > 0
        ? (Math.log(value) - colorLookup.logMin) * colorLookup.logScale
        : (value - colorLookup.min) * colorLookup.scale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount };
}

function renderWindSpeedStepLayer({
  uValues,
  vValues,
  multiplier,
  width,
  height,
  colorLookup,
  minVisible,
  maxVisible,
  visibleRange,
}) {
  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (!colorLookup?.colors || !colorLookup?.thresholds) {
    return { rgba, visibleCount: 0 };
  }
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  const visible = resolveVisibleBounds(minVisible, maxVisible, visibleRange);
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const u = uValues[index];
    const v = vValues[index];
    if (u !== u || v !== v) {
      continue;
    }
    const value = Math.sqrt(u * u + v * v) * multiplier;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    let selected;
    if (uniformScale > 0) {
      selected = Math.floor((value - uniformStart) * uniformScale);
      if (selected < 0) {
        selected = 0;
      } else if (selected >= thresholdCount) {
        selected = thresholdCount - 1;
      }
    } else {
      selected = 0;
      let low = 1;
      let high = thresholdCount - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (value < thresholds[mid]) {
          high = mid - 1;
        } else {
          selected = mid;
          low = mid + 1;
        }
      }
    }
    const colorOffset = selected * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount };
}

function buildPrecipAccumulationInGrids(decoded) {
  const out = {};
  for (const entry of getPrecipAccumulationEntries()) {
    const values = decoded?.[entry.key];
    if (!values) {
      continue;
    }
    out[entry.key] = transformGridAffine(values, MM_TO_IN, 0, 0);
  }
  return out;
}

function buildSnowfallInGrids({ decoded, selection, bounds, modelKey, width, height }) {
  const out = {};
  const availableParameters = new Set(selection?.availableParameters || []);
  const cellCount = Number(width) * Number(height);
  if (!Number.isFinite(cellCount) || cellCount <= 0) {
    return out;
  }
  const smoothOutput = () => smoothSnowfallPresentationGrids(out, { modelKey, width, height });
  if (availableParameters.has("snowHrrrAsnow") && decoded?.snowHrrrAsnow) {
    const asnowIn = transformGridAffine(decoded.snowHrrrAsnow, M_TO_IN, 0, 0);
    if (shouldIncludeGrid(asnowIn)) {
      out.snowHrrrAsnow = asnowIn;
    }
  }
  const derivedEntries = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => {
    return entry.kind === "snowfallDerived" && availableParameters.has(entry.key);
  });
  if (derivedEntries.length === 0) {
    return smoothOutput();
  }
  for (const entry of derivedEntries) {
    const precomputed = decoded?.[snowfallDerivedGridKey(entry.key)];
    if (precomputed) {
      addVisibleSnowfallGrid(out, entry.key, precomputed);
    }
  }
  const needsLiquidDerived = derivedEntries.some((entry) => {
    return !decoded?.[snowfallDerivedGridKey(entry.key)] && !decoded?.[SNOWFALL_DERIVED_INTERVALS_READY_KEY];
  });
  if (!needsLiquidDerived) {
    return smoothOutput();
  }
  const snowLiquidIn = buildSnowLiquidTotalInGrid(decoded, width, height);
  if (!hasGridValueGreaterThan(snowLiquidIn, MIN_VISIBLE_SNOW_LIQUID_IN)) {
    return smoothOutput();
  }
  const activeSnowLiquidIndices = activeGridVisitIndicesGreaterThan(snowLiquidIn, 0).indices;
  for (const entry of derivedEntries) {
    if (!decoded?.[snowfallDerivedGridKey(entry.key)] && !decoded?.[SNOWFALL_DERIVED_INTERVALS_READY_KEY]) {
      addVisibleSnowfallGrid(
        out,
        entry.key,
        buildSnowfallGridForEntry({
          entry,
          decoded,
          snowLiquidIn,
          activeIndices: activeSnowLiquidIndices,
          bounds,
          width,
          height,
        }),
      );
    }
  }
  return smoothOutput();
}

function buildDerivedParameterGrids({ decoded, selection, bounds, width, height, profile = null }) {
  const startedAt = performance.now();
  const out = {};
  const cellCount = Math.round(Number(width) * Number(height));
  const available = new Set(selection?.availableParameters || []);
  if (!decoded || !Number.isFinite(cellCount) || cellCount <= 0) {
    recordProfileStage(profile, "derivedGridMs", startedAt);
    return out;
  }

  const addGrid = (key, values, options = {}) => {
    if (!available.has(key) || !values) {
      return;
    }
    const visibleThreshold = Number(options.visibleThreshold);
    if (!options.includeEmpty && !shouldIncludeGrid(values, visibleThreshold)) {
      return;
    }
    out[key] = values;
  };
  const addComputedGrid = (key, builder, options = {}) => {
    if (!available.has(key)) {
      return;
    }
    addGrid(key, builder(), options);
  };

  addComputedGrid("relativeVorticity700", () =>
    buildRelativeVorticityGrid(decoded.absoluteVorticity700, bounds, width, height),
  );
  addComputedGrid("relativeVorticity500", () =>
    buildRelativeVorticityGrid(decoded.absoluteVorticity500, bounds, width, height),
  );
  addComputedGrid("lapseRate700to500", () =>
    buildLayerLapseRateGrid(decoded.temp700, decoded.temp500, decoded.height700, decoded.height500),
  );

  const surfaceThermo = buildSurfaceThermoDerivedGrids(decoded, available, cellCount);
  addGrid("surfaceBasedLclHeight", surfaceThermo.surfaceBasedLclHeight, { visibleThreshold: 0 });
  addGrid("surfaceThetaE", surfaceThermo.surfaceThetaE);

  const profileDerived = buildProfileDerivedGrids(decoded, available, cellCount, profile);
  addGrid("lapseRate0to3km", profileDerived.lapseRate0to3km);
  addGrid("bulkShear0to6km", profileDerived.bulkShear0to6km, { visibleThreshold: 9.99 });
  addGrid("effectiveBulkShear", profileDerived.effectiveBulkShear, { visibleThreshold: 9.99 });
  addComputedGrid("frontogenesis850", () => buildFrontogenesisGrid(decoded, 850, bounds, width, height));
  addComputedGrid("frontogenesis700", () => buildFrontogenesisGrid(decoded, 700, bounds, width, height));

  const freezingRainLiquid =
    decoded?.[FREEZING_RAIN_LIQUID_TOTAL_KEY]?.length === cellCount
      ? decoded[FREEZING_RAIN_LIQUID_TOTAL_KEY]
      : buildFreezingRainLiquidInGrid(decoded);
  addGrid(FREEZING_RAIN_LIQUID_TOTAL_KEY, freezingRainLiquid, {
    includeEmpty: decoded?.[FREEZING_RAIN_LIQUID_TOTAL_KEY]?.length === cellCount,
  });
  const framFlat = decoded?.[FRAM_FLAT_ICE_KEY]?.length === cellCount ? decoded[FRAM_FLAT_ICE_KEY] : null;
  const framRadial = decoded?.[FRAM_RADIAL_ICE_KEY]?.length === cellCount ? decoded[FRAM_RADIAL_ICE_KEY] : null;
  addGrid(FRAM_FLAT_ICE_KEY, framFlat, { includeEmpty: Boolean(framFlat) });
  addGrid(FRAM_RADIAL_ICE_KEY, framRadial, { includeEmpty: Boolean(framRadial) });
  if (!framFlat && !framRadial && freezingRainLiquid && hasGridValueGreaterThan(freezingRainLiquid, 0)) {
    const fram = buildFramIceGrids(decoded, selection, freezingRainLiquid, cellCount);
    addGrid(FRAM_FLAT_ICE_KEY, fram.flat);
    addGrid(FRAM_RADIAL_ICE_KEY, fram.radial);
  }

  addComputedGrid(
    "gustRunMax",
    () => decoded.gustRunMax || buildRunMaxCurrentGrid(decoded.gust, MPS_TO_MPH, cellCount),
    {
      visibleThreshold: 14.99,
    },
  );
  addComputedGrid(
    "updraftHelicity2to5kmRunMax",
    () => decoded.updraftHelicity2to5kmRunMax || buildRunMaxCurrentGrid(decoded.updraftHelicity2to5km1h, 1, cellCount),
    {
      visibleThreshold: 4.99,
    },
  );

  addComputedGrid(
    "supercellCompositeParameter",
    () => buildScpGrid(decoded, profileDerived.effectiveBulkShear, cellCount),
    {
      visibleThreshold: 0.099,
    },
  );
  addComputedGrid(
    "significantTornadoParameter",
    () => buildStpGrid(decoded, surfaceThermo.surfaceBasedLclHeight, profileDerived.bulkShear0to6km, cellCount),
    {
      visibleThreshold: 0.099,
    },
  );
  addComputedGrid(
    "effectiveLayerSupercellCompositeParameter",
    () =>
      profileDerived.effectiveLayerSupercellCompositeParameter ||
      buildEffectiveLayerScpGrid(decoded, profileDerived.effectiveLayerDiagnostics, cellCount),
    {
      visibleThreshold: 0.099,
    },
  );
  addComputedGrid(
    "effectiveLayerSignificantTornadoParameter",
    () =>
      profileDerived.effectiveLayerSignificantTornadoParameter ||
      buildEffectiveLayerStpGrid(decoded, profileDerived.effectiveLayerDiagnostics, cellCount),
    {
      visibleThreshold: 0.099,
    },
  );
  const dcape = profileDerived.dcape;
  addGrid("dcape", dcape, { visibleThreshold: 99.9 });
  if (profile && dcape) {
    profile.dcapeStats = buildGridDistributionStats(dcape, { clampMax: 2500 });
  }

  recordProfileStage(profile, "derivedGridMs", startedAt);
  return out;
}

function buildRelativeVorticityGrid(absoluteVorticity, bounds, width, height) {
  if (!absoluteVorticity) {
    return null;
  }
  const cols = Math.max(1, Math.round(Number(width) || 1));
  const rows = Math.max(1, Math.round(Number(height) || 1));
  const cellCount = cols * rows;
  const coriolisByRow = buildCoriolisByRow(bounds, rows);
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let y = 0; y < rows; y += 1) {
    const coriolis = coriolisByRow[y];
    if (!Number.isFinite(coriolis)) {
      continue;
    }
    const rowOffset = y * cols;
    for (let x = 0; x < cols; x += 1) {
      const index = rowOffset + x;
      const absolute = Number(absoluteVorticity[index]);
      if (Number.isFinite(absolute)) {
        out[index] = (absolute - coriolis) * 100000;
      }
    }
  }
  return out;
}

function buildCoriolisByRow(bounds, rows) {
  const out = new Float64Array(Math.max(0, rows));
  out.fill(Number.NaN);
  for (let y = 0; y < rows; y += 1) {
    const lat = bounds ? rowToLatMercator(y, rows, bounds) : Number.NaN;
    if (Number.isFinite(lat)) {
      out[y] = 2 * EARTH_OMEGA_RAD_S * Math.sin((lat * Math.PI) / 180);
    }
  }
  return out;
}

function buildLayerLapseRateGrid(lowerTempK, upperTempK, lowerHeightM, upperHeightM) {
  if (!lowerTempK || !upperTempK || !lowerHeightM || !upperHeightM) {
    return null;
  }
  const cellCount = Math.min(lowerTempK.length, upperTempK.length, lowerHeightM.length, upperHeightM.length);
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const lowerT = Number(lowerTempK[index]);
    const upperT = Number(upperTempK[index]);
    const lowerZ = Number(lowerHeightM[index]);
    const upperZ = Number(upperHeightM[index]);
    const depthKm = (upperZ - lowerZ) / 1000;
    if (!Number.isFinite(lowerT) || !Number.isFinite(upperT) || !Number.isFinite(depthKm) || depthKm <= 0.05) {
      continue;
    }
    out[index] = (lowerT - upperT) / depthKm;
  }
  return out;
}

function buildSurfaceThermoDerivedGrids(decoded, available, cellCount) {
  const needsLcl = available.has("surfaceBasedLclHeight") || available.has("significantTornadoParameter");
  const needsThetaE = available.has("surfaceThetaE");
  const out = {};
  if (!needsLcl && !needsThetaE) {
    return out;
  }
  const directLcl = decoded?.surfaceBasedLclHeightDirect || null;
  const tempKGrid = decoded?.temperature2m;
  if (!tempKGrid && !directLcl) {
    return out;
  }
  const lcl = needsLcl ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const thetaE = needsThetaE ? new Float32Array(cellCount).fill(Number.NaN) : null;
  for (let index = 0; index < cellCount; index += 1) {
    const directLclValue = directLcl ? Number(directLcl[index]) : Number.NaN;
    const surfaceHeightM = gridValue(decoded?.profileSurfaceHeight, index);
    if (lcl && Number.isFinite(directLclValue) && Number.isFinite(surfaceHeightM)) {
      lcl[index] = Math.max(0, directLclValue - surfaceHeightM);
    }
    const tempK = Number(tempKGrid?.[index]);
    let dewpointK = Number.NaN;
    const needsDewpoint = Boolean(thetaE || (lcl && !Number.isFinite(lcl[index])));
    if (needsDewpoint) {
      dewpointK = surfaceDewpointK(decoded, index);
    }
    if (lcl && !Number.isFinite(lcl[index]) && Number.isFinite(tempK) && Number.isFinite(dewpointK)) {
      const lclTempK = dewpointK <= tempK + 0.5 ? boltonLclTemperatureK(tempK, dewpointK) : Number.NaN;
      if (Number.isFinite(lclTempK)) {
        lcl[index] = Math.max(0, (tempK - lclTempK) / 0.0098);
      }
    }
    if (thetaE) {
      const pressureHpa = surfacePressureHpa(decoded, index);
      const value = boltonThetaE(tempK, dewpointK, pressureHpa);
      if (Number.isFinite(value)) {
        thetaE[index] = value;
      }
    }
  }
  if (lcl) {
    out.surfaceBasedLclHeight = lcl;
  }
  if (thetaE) {
    out.surfaceThetaE = thetaE;
  }
  return out;
}

function buildProfileDerivedGrids(decoded, available, cellCount, profile = null) {
  const needsLapse = available.has("lapseRate0to3km");
  const needsLegacyScp = available.has("supercellCompositeParameter");
  const needsEffectiveLayerScp = available.has("effectiveLayerSupercellCompositeParameter");
  const needsEffectiveLayerStp = available.has("effectiveLayerSignificantTornadoParameter");
  const needsBulk = available.has("bulkShear0to6km") || available.has("significantTornadoParameter");
  const needsEffective = available.has("effectiveBulkShear") || needsLegacyScp;
  const needsEffectiveDiagnostics = needsEffectiveLayerScp || needsEffectiveLayerStp;
  const needsDcape = available.has("dcape");
  const out = {};
  if (!needsLapse && !needsBulk && !needsEffective && !needsEffectiveDiagnostics && !needsDcape) {
    return out;
  }
  const lapse = needsLapse ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const bulk = needsBulk ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const effective = needsEffective ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const dcape = needsDcape ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const effectiveLayerScp = needsEffectiveLayerScp ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const effectiveLayerStp = needsEffectiveLayerStp ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const sources = buildDerivedProfileSources(decoded);
  const effectiveCandidateCells = needsEffectiveDiagnostics
    ? buildEffectiveDiagnosticsCandidateCells(decoded, cellCount, {
        needsScp: needsEffectiveLayerScp,
        needsStp: needsEffectiveLayerStp,
        profile,
      })
    : null;
  const effectiveSources = effectiveCandidateCells ? buildEffectiveLayerProfileSources(decoded) : null;
  const effectiveScratch = effectiveSources ? createEffectiveDiagnosticsScratch(effectiveSources.length) : null;
  const dcapeScratch = needsDcape
    ? {
        heights: new Float64Array(sources.length + 1),
        temps: new Float64Array(sources.length + 1),
      }
    : null;

  for (let index = 0; index < cellCount; index += 1) {
    const wantsEffectiveDiagnosticsCandidate = Boolean(
      needsEffectiveDiagnostics &&
      effectiveScratch &&
      isEffectiveDiagnosticsCandidateCell(effectiveCandidateCells, index),
    );
    const wantsEffectiveCandidate = Boolean(effective && isEffectiveLayerCellActive(decoded, index));
    if (!needsLapse && !needsBulk && !needsDcape && !wantsEffectiveCandidate && !wantsEffectiveDiagnosticsCandidate) {
      continue;
    }

    const elevation = profileValue(decoded, "HGT", "surface", index);
    if (!Number.isFinite(elevation)) {
      continue;
    }

    const surfaceTemp = needsLapse || needsDcape ? profileValue(decoded, "TMP", "surface", index) : Number.NaN;
    const surfaceWind =
      needsBulk || wantsEffectiveCandidate || wantsEffectiveDiagnosticsCandidate
        ? surfaceWindVector(decoded, index)
        : null;
    const wantsLapse = Boolean(lapse && Number.isFinite(surfaceTemp));
    const wantsBulk = Boolean(bulk && surfaceWind);
    const wantsDcape = Boolean(dcape && Number.isFinite(surfaceTemp));
    const wantsEffective = Boolean(wantsEffectiveCandidate && surfaceWind);
    const wantsEffectiveDiagnostics = Boolean(wantsEffectiveDiagnosticsCandidate && surfaceWind);
    if (!wantsLapse && !wantsBulk && !wantsDcape && !wantsEffective && !wantsEffectiveDiagnostics) {
      continue;
    }

    if (wantsLapse) {
      const temp3km = interpolateDerivedProfileColumn(sources, "TMP", index, 3000, elevation, surfaceTemp);
      if (Number.isFinite(surfaceTemp) && Number.isFinite(temp3km)) {
        lapse[index] = (surfaceTemp - temp3km) / 3;
      }
    }
    if (wantsBulk) {
      const shear = calculateBulkShearKtFromSources(sources, index, elevation, 6000, surfaceWind);
      if (Number.isFinite(shear)) {
        bulk[index] = shear;
      }
    }
    if (wantsEffective) {
      const shear = Number.isFinite(bulk?.[index])
        ? bulk[index]
        : calculateBulkShearKtFromSources(sources, index, elevation, 6000, surfaceWind);
      if (Number.isFinite(shear)) {
        effective[index] = shear;
      }
    }
    if (wantsDcape) {
      const value = calculateReducedProfileDcapeFromSources(sources, index, elevation, surfaceTemp, dcapeScratch);
      if (Number.isFinite(value)) {
        dcape[index] = Math.max(0, value);
      }
    }
    if (wantsEffectiveDiagnostics) {
      const products = calculateEffectiveLayerProductsFromSources(
        decoded,
        effectiveSources,
        index,
        elevation,
        surfaceWind,
        effectiveScratch,
        {
          needsScp: needsEffectiveLayerScp,
          needsStp: needsEffectiveLayerStp,
        },
      );
      if (products) {
        if (effectiveLayerScp && Number.isFinite(products.scp)) {
          effectiveLayerScp[index] = products.scp;
        }
        if (effectiveLayerStp && Number.isFinite(products.stp)) {
          effectiveLayerStp[index] = products.stp;
        }
      }
    }
  }
  if (lapse) {
    out.lapseRate0to3km = lapse;
  }
  if (bulk) {
    out.bulkShear0to6km = bulk;
  }
  if (effective) {
    out.effectiveBulkShear = effective;
  }
  if (dcape) {
    out.dcape = dcape;
  }
  if (effectiveLayerScp) {
    out.effectiveLayerSupercellCompositeParameter = effectiveLayerScp;
  }
  if (effectiveLayerStp) {
    out.effectiveLayerSignificantTornadoParameter = effectiveLayerStp;
  }
  return out;
}

function buildEffectiveDiagnosticsCandidateCells(decoded, cellCount, options = {}) {
  const count = Math.max(0, Math.round(Number(cellCount) || 0));
  if (count <= 0) {
    return null;
  }
  const needsScp = Boolean(options?.needsScp);
  const needsStp = Boolean(options?.needsStp);
  const profile = options?.profile || null;
  const mask = new Uint8Array(count);
  let candidateCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (!hasEffectiveDiagnosticsCandidateCape(decoded, index, { needsScp, needsStp })) {
      continue;
    }
    mask[index] = 1;
    candidateCount += 1;
  }
  if (profile) {
    profile.effectiveDiagnosticsCandidateCount = candidateCount;
  }
  return candidateCount > 0 ? { mask, count: candidateCount } : null;
}

function hasEffectiveDiagnosticsCandidateCape(decoded, index, options = {}) {
  const mucape = gridValue(decoded?.mucape, index);
  const mlcape = gridValue(decoded?.mlcape, index);
  const sbcape = gridValue(decoded?.sbcape, index);
  if (options?.needsScp && mucape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG) {
    return true;
  }
  if (!options?.needsStp) {
    return false;
  }
  const mlcin = gridValue(decoded?.mlcin, index);
  if (!(mlcape > 0) || (Number.isFinite(mlcin) && mlcin <= -200)) {
    return false;
  }
  return (
    mucape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG ||
    mlcape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG ||
    sbcape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG
  );
}

function isEffectiveDiagnosticsCandidateCell(candidateCells, index) {
  if (!candidateCells) {
    return false;
  }
  return candidateCells.mask?.[index] === 1;
}

function createEffectiveDiagnosticsScratch(sourceCount) {
  const size = Math.max(4, sourceCount + 2);
  return {
    heights: new Float64Array(size),
    u: new Float64Array(size),
    v: new Float64Array(size),
    pressure: new Float64Array(size),
    temp: new Float64Array(size),
    dewpoint: new Float64Array(size),
    segmentValid: new Uint8Array(size),
    segmentDz: new Float64Array(size),
    segmentMidHeight: new Float64Array(size),
    segmentMidPressure: new Float64Array(size),
    segmentEnvVirtualTemp: new Float64Array(size),
  };
}

function calculateEffectiveLayerDiagnosticsFromSources(decoded, sources, index, elevation, surfaceWind, scratch) {
  const rowCount = fillEffectiveDiagnosticsProfileRows(decoded, sources, index, elevation, surfaceWind, scratch);
  if (rowCount < 3) {
    return null;
  }
  const layer = calculateEffectiveParcelLayerFromRows(scratch, rowCount);
  if (!layer || !Number.isFinite(layer.baseAglM) || !Number.isFinite(layer.topAglM)) {
    return null;
  }
  const baseAglM = layer.baseAglM;
  const topAglM = Math.max(layer.topAglM, baseAglM + 1);
  const windAtBase = interpolateProfileWindRows(scratch, rowCount, baseAglM);
  if (!windAtBase) {
    return null;
  }

  const muElAglM = Number.isFinite(layer.muElAglM) ? layer.muElAglM : topAglM;
  const ebwdTopAglM = Math.min(
    baseAglM + EFFECTIVE_MAX_EBWD_LAYER_DEPTH_M,
    Math.max(baseAglM + EFFECTIVE_MIN_EBWD_LAYER_DEPTH_M, baseAglM + 0.5 * Math.max(0, muElAglM - baseAglM)),
  );
  const windAtEbwdTop = interpolateProfileWindRows(scratch, rowCount, ebwdTopAglM);
  const stormMotion =
    calculateEffectiveLayerBunkersMotionFromRows(scratch, rowCount, layer)?.right ||
    calculateBunkersMotionFromRows(scratch, rowCount)?.right;
  if (!windAtEbwdTop || !stormMotion) {
    return null;
  }
  const esrh = calculateStormRelativeHelicityFromRows(scratch, rowCount, baseAglM, topAglM, stormMotion);
  const ebwdKt = Math.hypot(windAtEbwdTop.u - windAtBase.u, windAtEbwdTop.v - windAtBase.v) * MPS_TO_KT;
  const mixedLayerLclM = calculateMixedLayerLclMFromRows(scratch, rowCount);
  if (!Number.isFinite(esrh) || !Number.isFinite(ebwdKt)) {
    return null;
  }
  return {
    baseAglM,
    topAglM,
    ebwdKt,
    esrh,
    mixedLayerLclM,
    muCapeJkg: layer.muCapeJkg,
    muCinJkg: layer.muCinJkg,
  };
}

function calculateEffectiveLayerProductsFromSources(
  decoded,
  sources,
  index,
  elevation,
  surfaceWind,
  scratch,
  options = {},
) {
  const rowCount = fillEffectiveDiagnosticsProfileRows(decoded, sources, index, elevation, surfaceWind, scratch);
  if (rowCount < 3) {
    return null;
  }
  const layer = calculateEffectiveParcelLayerFromRows(scratch, rowCount);
  if (!layer || !Number.isFinite(layer.baseAglM) || !Number.isFinite(layer.topAglM)) {
    return null;
  }
  const needsScp = Boolean(options?.needsScp);
  const needsStp = Boolean(options?.needsStp);
  const products = {};
  const baseAglM = layer.baseAglM;
  const canShortCircuitStp = needsStp && !needsScp && baseAglM > 0;
  if (canShortCircuitStp) {
    products.stp = 0;
    return products;
  }

  const topAglM = Math.max(layer.topAglM, baseAglM + 1);
  const windAtBase = interpolateProfileWindRows(scratch, rowCount, baseAglM);
  if (!windAtBase) {
    return null;
  }
  const muElAglM = Number.isFinite(layer.muElAglM) ? layer.muElAglM : topAglM;
  const ebwdTopAglM = Math.min(
    baseAglM + EFFECTIVE_MAX_EBWD_LAYER_DEPTH_M,
    Math.max(baseAglM + EFFECTIVE_MIN_EBWD_LAYER_DEPTH_M, baseAglM + 0.5 * Math.max(0, muElAglM - baseAglM)),
  );
  const windAtEbwdTop = interpolateProfileWindRows(scratch, rowCount, ebwdTopAglM);
  const stormMotion =
    calculateEffectiveLayerBunkersMotionFromRows(scratch, rowCount, layer)?.right ||
    calculateBunkersMotionFromRows(scratch, rowCount)?.right;
  if (!windAtEbwdTop || !stormMotion) {
    return null;
  }
  const esrh = calculateStormRelativeHelicityFromRows(scratch, rowCount, baseAglM, topAglM, stormMotion);
  const ebwdKt = Math.hypot(windAtEbwdTop.u - windAtBase.u, windAtEbwdTop.v - windAtBase.v) * MPS_TO_KT;
  if (!Number.isFinite(esrh) || !Number.isFinite(ebwdKt)) {
    return null;
  }
  if (needsScp) {
    products.scp = calculateEffectiveLayerScpValue(decoded, index, layer, esrh, ebwdKt);
  }
  if (needsStp) {
    products.stp =
      baseAglM > 0
        ? 0
        : calculateEffectiveLayerStpValue(
            decoded,
            index,
            esrh,
            ebwdKt,
            calculateMixedLayerLclMFromRows(scratch, rowCount),
          );
  }
  return products;
}

function fillEffectiveDiagnosticsProfileRows(decoded, sources, index, elevation, surfaceWind, scratch) {
  let rowCount = 0;
  const addRow = (heightAglM, u, v, pressureHpa, tempK, dewpointK) => {
    if (!Number.isFinite(heightAglM) || !Number.isFinite(u) || !Number.isFinite(v)) {
      return;
    }
    const row = rowCount;
    scratch.heights[row] = heightAglM;
    scratch.u[row] = u;
    scratch.v[row] = v;
    scratch.pressure[row] = Number.isFinite(pressureHpa) ? pressureHpa : Number.NaN;
    scratch.temp[row] = Number.isFinite(tempK) ? tempK : Number.NaN;
    scratch.dewpoint[row] = Number.isFinite(dewpointK) ? dewpointK : Number.NaN;
    rowCount += 1;
  };

  const surfacePressure = surfacePressureHpa(decoded, index);
  const surfaceTemp = profileValue(decoded, "TMP", "surface", index);
  const surfaceDewpoint = surfaceDewpointK(decoded, index);
  addRow(0, surfaceWind.u, surfaceWind.v, surfacePressure, surfaceTemp, surfaceDewpoint);

  for (const source of sources) {
    const heightMsl = gridValue(source.hgt, index);
    const u = gridValue(source.u, index);
    const v = gridValue(source.v, index);
    const heightAglM = heightMsl - elevation;
    if (!Number.isFinite(heightAglM) || heightAglM <= 0 || heightAglM > 16000) {
      continue;
    }
    const tempK = gridValue(source.tmp, index);
    const rh = gridValue(source.rh, index);
    const dewpointK = dewpointFromTempRhK(tempK, rh);
    addRow(heightAglM, u, v, Number(source.level), tempK, dewpointK);
  }
  sortEffectiveDiagnosticsRowsByHeight(scratch, rowCount);
  return rowCount;
}

function sortEffectiveDiagnosticsRowsByHeight(scratch, count) {
  for (let index = 1; index < count; index += 1) {
    const height = scratch.heights[index];
    const u = scratch.u[index];
    const v = scratch.v[index];
    const pressure = scratch.pressure[index];
    const temp = scratch.temp[index];
    const dewpoint = scratch.dewpoint[index];
    let cursor = index - 1;
    while (cursor >= 0 && scratch.heights[cursor] > height) {
      scratch.heights[cursor + 1] = scratch.heights[cursor];
      scratch.u[cursor + 1] = scratch.u[cursor];
      scratch.v[cursor + 1] = scratch.v[cursor];
      scratch.pressure[cursor + 1] = scratch.pressure[cursor];
      scratch.temp[cursor + 1] = scratch.temp[cursor];
      scratch.dewpoint[cursor + 1] = scratch.dewpoint[cursor];
      cursor -= 1;
    }
    scratch.heights[cursor + 1] = height;
    scratch.u[cursor + 1] = u;
    scratch.v[cursor + 1] = v;
    scratch.pressure[cursor + 1] = pressure;
    scratch.temp[cursor + 1] = temp;
    scratch.dewpoint[cursor + 1] = dewpoint;
  }
}

function calculateEffectiveParcelLayerFromRows(scratch, rowCount, options = {}) {
  const surfacePressure = scratch.pressure[0];
  if (!Number.isFinite(surfacePressure)) {
    return null;
  }
  prepareEffectiveParcelSegments(scratch, rowCount);
  const pressureFloor = surfacePressure - EFFECTIVE_PARCEL_SOURCE_DEPTH_HPA;
  let inLayer = false;
  let baseAglM = Number.NaN;
  let topAglM = Number.NaN;
  let muCapeJkg = Number.NEGATIVE_INFINITY;
  let muCinJkg = Number.NaN;
  let muElAglM = Number.NaN;
  let lastScannedSourcePressure = Number.NaN;

  for (let row = 0; row < rowCount; row += 1) {
    const height = scratch.heights[row];
    const pressure = scratch.pressure[row];
    const temp = scratch.temp[row];
    const dewpoint = scratch.dewpoint[row];
    if (
      !Number.isFinite(height) ||
      height > EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M ||
      !Number.isFinite(pressure) ||
      !Number.isFinite(temp) ||
      !Number.isFinite(dewpoint)
    ) {
      continue;
    }
    if (pressure < pressureFloor) {
      break;
    }
    if (
      Number.isFinite(lastScannedSourcePressure) &&
      lastScannedSourcePressure - pressure < EFFECTIVE_PARCEL_SOURCE_STEP_HPA
    ) {
      continue;
    }
    lastScannedSourcePressure = pressure;
    const parcel = calculateParcelCapeCinFromRows(scratch, rowCount, row, options);
    if (!parcel || !Number.isFinite(parcel.capeJkg) || !Number.isFinite(parcel.cinJkg)) {
      if (inLayer) {
        break;
      }
      continue;
    }
    if (parcel.capeJkg > muCapeJkg) {
      muCapeJkg = parcel.capeJkg;
      muCinJkg = parcel.cinJkg;
      muElAglM = parcel.elAglM;
    }
    const effective = parcel.capeJkg >= EFFECTIVE_INFLOW_MIN_CAPE_JKG && parcel.cinJkg >= EFFECTIVE_INFLOW_MIN_CIN_JKG;
    if (effective) {
      if (!inLayer) {
        baseAglM = Math.max(0, height);
        inLayer = true;
      }
    } else if (inLayer) {
      topAglM = Math.max(baseAglM, height);
      break;
    }
  }
  if (!Number.isFinite(baseAglM) || !Number.isFinite(topAglM) || !Number.isFinite(muCapeJkg)) {
    return null;
  }
  return {
    baseAglM,
    topAglM,
    muCapeJkg: Math.max(0, muCapeJkg),
    muCinJkg,
    muElAglM,
  };
}

function prepareEffectiveParcelSegments(scratch, rowCount) {
  if (!scratch?.segmentValid) {
    return;
  }
  scratch.segmentValid.fill(0, 0, Math.max(0, rowCount));
  for (let row = 1; row < rowCount; row += 1) {
    const lowerHeight = scratch.heights[row - 1];
    const upperHeight = scratch.heights[row];
    const lowerPressure = scratch.pressure[row - 1];
    const upperPressure = scratch.pressure[row];
    const lowerTemp = scratch.temp[row - 1];
    const upperTemp = scratch.temp[row];
    const lowerDewpoint = scratch.dewpoint[row - 1];
    const upperDewpoint = scratch.dewpoint[row];
    const dz = upperHeight - lowerHeight;
    if (
      !Number.isFinite(dz) ||
      dz <= 1 ||
      !Number.isFinite(lowerPressure) ||
      !Number.isFinite(upperPressure) ||
      lowerPressure <= 0 ||
      upperPressure <= 0 ||
      !Number.isFinite(lowerTemp) ||
      !Number.isFinite(upperTemp) ||
      !Number.isFinite(lowerDewpoint) ||
      !Number.isFinite(upperDewpoint)
    ) {
      continue;
    }
    const midPressure = Math.exp((Math.log(lowerPressure) + Math.log(upperPressure)) / 2);
    const envTemp = (lowerTemp + upperTemp) / 2;
    const envDewpoint = (lowerDewpoint + upperDewpoint) / 2;
    const envMixingRatio = mixingRatioFromDewpointK(envDewpoint, midPressure);
    const envVirtualTemp = virtualTemperatureK(envTemp, envMixingRatio);
    if (!Number.isFinite(midPressure) || !Number.isFinite(envVirtualTemp)) {
      continue;
    }
    scratch.segmentValid[row] = 1;
    scratch.segmentDz[row] = dz;
    scratch.segmentMidHeight[row] = (lowerHeight + upperHeight) / 2;
    scratch.segmentMidPressure[row] = midPressure;
    scratch.segmentEnvVirtualTemp[row] = envVirtualTemp;
  }
}

function calculateParcelCapeCinFromRows(scratch, rowCount, sourceRow, options = {}) {
  const source = {
    pressureHpa: scratch.pressure[sourceRow],
    heightAglM: scratch.heights[sourceRow],
    tempK: scratch.temp[sourceRow],
    dewpointK: scratch.dewpoint[sourceRow],
  };
  return options?.pressureStep
    ? calculatePressureStepParcelCapeCinForSource(scratch, rowCount, source)
    : calculateParcelCapeCinForSource(scratch, rowCount, source);
}

function calculateParcelCapeCinForSource(scratch, rowCount, source) {
  return calculateSegmentParcelCapeCinForSource(scratch, rowCount, source);
}

function calculateSegmentParcelCapeCinForSource(scratch, rowCount, source) {
  const sourcePressure = Number(source?.pressureHpa);
  const sourceHeight = Number(source?.heightAglM);
  const sourceTemp = Number(source?.tempK);
  const rawSourceDewpoint = Number(source?.dewpointK);
  const sourceDewpoint = Math.min(rawSourceDewpoint, sourceTemp);
  if (
    !Number.isFinite(sourcePressure) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(sourceTemp) ||
    !Number.isFinite(rawSourceDewpoint) ||
    sourcePressure <= 100 ||
    rawSourceDewpoint > sourceTemp + 0.5
  ) {
    return null;
  }
  const lclTempK = boltonLclTemperatureK(sourceTemp, sourceDewpoint);
  const sourceVaporPressure = vaporPressureHpa(sourceDewpoint);
  if (!Number.isFinite(lclTempK) || !Number.isFinite(sourceVaporPressure)) {
    return null;
  }
  const lclPressure = sourcePressure * Math.pow(lclTempK / sourceTemp, CP_OVER_RD);
  const sourceMixingRatio = mixingRatioFromVaporPressureHpa(sourceVaporPressure, sourcePressure);
  if (!Number.isFinite(lclPressure) || !Number.isFinite(sourceMixingRatio)) {
    return null;
  }
  const lclHeight = sourceHeight + Math.max(0, sourceTemp - lclTempK) / DRY_ADIABATIC_LAPSE_K_M;

  let cape = 0;
  let cin = 0;
  let positiveSeen = false;
  let previousBuoyancy = Number.NaN;
  let previousHeight = sourceHeight;
  let lfcAglM = Number.NaN;
  let elAglM = Number.NaN;
  let saturatedParcelTemp = lclTempK;
  let saturatedParcelHeight = lclHeight;
  for (let row = 1; row < rowCount; row += 1) {
    if (!scratch.segmentValid?.[row]) {
      continue;
    }
    const midHeight = scratch.segmentMidHeight[row];
    const midPressure = scratch.segmentMidPressure[row];
    const envVirtualTemp = scratch.segmentEnvVirtualTemp[row];
    const dz = scratch.segmentDz[row];
    if (midHeight <= sourceHeight + 1 || midPressure > sourcePressure + 1) {
      continue;
    }
    let parcelTemp;
    if (midPressure >= lclPressure || midHeight <= lclHeight) {
      parcelTemp = sourceTemp * Math.pow(midPressure / sourcePressure, RD_OVER_CP);
    } else {
      parcelTemp = integrateMoistParcelTemperatureK(saturatedParcelTemp, saturatedParcelHeight, midHeight, midPressure);
      if (Number.isFinite(parcelTemp)) {
        saturatedParcelTemp = parcelTemp;
        saturatedParcelHeight = midHeight;
      }
    }
    const parcelMixingRatio =
      midPressure >= lclPressure ? sourceMixingRatio : saturationMixingRatioHpa(parcelTemp, midPressure);
    const parcelVirtualTemp = virtualTemperatureK(parcelTemp, parcelMixingRatio);
    if (!Number.isFinite(envVirtualTemp) || !Number.isFinite(parcelVirtualTemp)) {
      continue;
    }
    const buoyancy = (GRAVITY_M_S2 * (parcelVirtualTemp - envVirtualTemp)) / Math.max(180, envVirtualTemp);
    const energy = buoyancy * dz;
    const isAtOrAboveLcl = midHeight >= lclHeight - 1 || midPressure <= lclPressure + 0.1;
    if (Number.isFinite(energy)) {
      if (energy > 0 && isAtOrAboveLcl) {
        if (!positiveSeen) {
          const crossingHeight =
            Number.isFinite(previousBuoyancy) && previousBuoyancy <= 0
              ? previousHeight +
                (midHeight - previousHeight) * clamp01(-previousBuoyancy / Math.max(1e-9, buoyancy - previousBuoyancy))
              : previousHeight < lclHeight
                ? lclHeight
                : midHeight;
          lfcAglM = Math.max(lclHeight, crossingHeight);
        }
        cape += energy;
        positiveSeen = true;
        elAglM = scratch.heights[row];
      } else if (!positiveSeen && energy < 0) {
        cin += energy;
      } else if (Number.isFinite(previousBuoyancy) && previousBuoyancy > 0 && buoyancy <= 0) {
        const fraction = previousBuoyancy / Math.max(1e-9, previousBuoyancy - buoyancy);
        elAglM = previousHeight + (midHeight - previousHeight) * clamp01(fraction);
      }
    }
    previousBuoyancy = buoyancy;
    previousHeight = midHeight;
  }
  return {
    capeJkg: Math.max(0, cape),
    cinJkg: Math.min(0, cin),
    lclAglM: Number.isFinite(lclHeight) ? lclHeight : Number.NaN,
    lfcAglM: Number.isFinite(lfcAglM) ? lfcAglM : Number.NaN,
    elAglM: Number.isFinite(elAglM) ? elAglM : Number.NaN,
  };
}

function calculatePressureStepParcelCapeCinForSource(scratch, rowCount, source) {
  const sourcePressure = Number(source?.pressureHpa);
  const sourceHeight = Number(source?.heightAglM);
  const sourceTemp = Number(source?.tempK);
  const rawSourceDewpoint = Number(source?.dewpointK);
  const sourceDewpoint = Math.min(rawSourceDewpoint, sourceTemp);
  if (
    !Number.isFinite(sourcePressure) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(sourceTemp) ||
    !Number.isFinite(rawSourceDewpoint) ||
    sourcePressure <= 100 ||
    rawSourceDewpoint > sourceTemp + 0.5
  ) {
    return null;
  }
  const lclTempK = boltonLclTemperatureK(sourceTemp, sourceDewpoint);
  const sourceVaporPressure = vaporPressureHpa(sourceDewpoint);
  if (!Number.isFinite(lclTempK) || !Number.isFinite(sourceVaporPressure)) {
    return null;
  }
  const lclPressure = sourcePressure * Math.pow(lclTempK / sourceTemp, CP_OVER_RD);
  const sourceMixingRatio = mixingRatioFromVaporPressureHpa(sourceVaporPressure, sourcePressure);
  if (!Number.isFinite(lclPressure) || !Number.isFinite(sourceMixingRatio)) {
    return null;
  }
  const lclHeight = calculateLclHeightForSourceRows(scratch, rowCount, {
    pressureHpa: sourcePressure,
    heightAglM: sourceHeight,
    tempK: sourceTemp,
    lclTempK,
    lclPressure,
  });
  const samples = buildParcelBuoyancySamples(scratch, rowCount, {
    sourcePressure,
    sourceTemp,
    sourceMixingRatio,
    lclPressure,
    lclTempK,
  });
  let cape = 0;
  let cin = 0;
  let positiveSeen = false;
  let lfcAglM = Number.NaN;
  let elAglM = Number.NaN;
  for (let index = 1; index < samples.length; index += 1) {
    const lower = samples[index - 1];
    const upper = samples[index];
    const dz = upper.heightAglM - lower.heightAglM;
    if (!Number.isFinite(dz) || dz <= 0) {
      continue;
    }
    if (!Number.isFinite(lower.buoyancyMps2) || !Number.isFinite(upper.buoyancyMps2)) {
      continue;
    }
    const energy = ((lower.buoyancyMps2 + upper.buoyancyMps2) / 2) * dz;
    const isAtOrAboveLcl = upper.pressureHpa <= lclPressure + 1e-6 || upper.heightAglM >= lclHeight - 1;
    if (Number.isFinite(energy)) {
      if (energy > 0 && isAtOrAboveLcl) {
        if (!positiveSeen) {
          const crossingHeight = interpolateBuoyancyZeroHeight(lower, upper, lclHeight);
          lfcAglM = Math.max(lclHeight, crossingHeight);
        }
        cape += energy;
        positiveSeen = true;
      } else if (!positiveSeen && energy < 0 && upper.pressureHpa >= PARCEL_CIN_TOP_PRESSURE_HPA) {
        cin += energy;
      }
      if (
        positiveSeen &&
        Number.isFinite(lower.buoyancyMps2) &&
        Number.isFinite(upper.buoyancyMps2) &&
        lower.buoyancyMps2 > 0 &&
        upper.buoyancyMps2 <= 0
      ) {
        elAglM = interpolateBuoyancyZeroHeight(lower, upper, lclHeight);
      }
    }
  }
  return {
    capeJkg: Math.max(0, cape),
    cinJkg: Math.min(0, cin),
    lclAglM: Number.isFinite(lclHeight) ? lclHeight : Number.NaN,
    lfcAglM: Number.isFinite(lfcAglM) ? lfcAglM : Number.NaN,
    elAglM: Number.isFinite(elAglM) ? elAglM : Number.NaN,
  };
}

function calculateLclHeightForSourceRows(scratch, rowCount, source) {
  const lclPressure = Number(source?.lclPressure);
  const lclTempK = Number(source?.lclTempK);
  const sourceHeight = Number(source?.heightAglM);
  const sourceTemp = Number(source?.tempK);
  const interpolated = interpolateProfileThermoAtPressureRows(scratch, rowCount, lclPressure);
  if (interpolated && Number.isFinite(interpolated.heightAglM)) {
    return Math.max(0, interpolated.heightAglM);
  }
  return Number.isFinite(sourceHeight) && Number.isFinite(sourceTemp) && Number.isFinite(lclTempK)
    ? Math.max(0, sourceHeight + Math.max(0, sourceTemp - lclTempK) / DRY_ADIABATIC_LAPSE_K_M)
    : Number.NaN;
}

function buildParcelBuoyancySamples(scratch, rowCount, parcel) {
  const sourcePressure = Number(parcel?.sourcePressure);
  const sourceTemp = Number(parcel?.sourceTemp);
  const sourceMixingRatio = Number(parcel?.sourceMixingRatio);
  const lclPressure = Number(parcel?.lclPressure);
  const lclTempK = Number(parcel?.lclTempK);
  const topPressure = findTopPressureHpaForScratch(scratch, rowCount);
  if (
    !Number.isFinite(sourcePressure) ||
    !Number.isFinite(sourceTemp) ||
    !Number.isFinite(sourceMixingRatio) ||
    !Number.isFinite(lclPressure) ||
    !Number.isFinite(lclTempK) ||
    !Number.isFinite(topPressure) ||
    topPressure >= sourcePressure
  ) {
    return [];
  }
  const pressures = [];
  const addPressure = (pressure) => {
    const value = Number(pressure);
    if (!Number.isFinite(value) || value > sourcePressure + 1e-6 || value < topPressure - 1e-6) {
      return;
    }
    if (pressures.some((existing) => Math.abs(existing - value) < 1e-6)) {
      return;
    }
    pressures.push(value);
  };
  addPressure(sourcePressure);
  addPressure(topPressure);
  addPressure(lclPressure);
  for (
    let pressure = Math.floor(sourcePressure);
    pressure >= Math.ceil(topPressure);
    pressure -= PARCEL_INTEGRATION_STEP_HPA
  ) {
    addPressure(pressure);
  }
  for (let row = 0; row < rowCount; row += 1) {
    addPressure(scratch.pressure[row]);
  }
  pressures.sort((left, right) => right - left);

  let saturatedPressure = lclPressure;
  let saturatedTemp = lclTempK;
  const samples = [];
  for (const pressure of pressures) {
    const env = interpolateProfileThermoAtPressureRows(scratch, rowCount, pressure);
    if (!env || !Number.isFinite(env.heightAglM) || !Number.isFinite(env.tempK) || !Number.isFinite(env.dewpointK)) {
      continue;
    }
    const envMixingRatio = mixingRatioFromDewpointK(Math.min(env.dewpointK, env.tempK), pressure);
    const envVirtualTemp = virtualTemperatureK(env.tempK, envMixingRatio);
    let parcelTemp = Number.NaN;
    let parcelMixingRatio = Number.NaN;
    if (pressure >= lclPressure) {
      parcelTemp = sourceTemp * Math.pow(pressure / sourcePressure, RD_OVER_CP);
      parcelMixingRatio = sourceMixingRatio;
    } else {
      parcelTemp = moistLiftTemperatureK(saturatedPressure, saturatedTemp, pressure);
      if (Number.isFinite(parcelTemp)) {
        saturatedPressure = pressure;
        saturatedTemp = parcelTemp;
      }
      parcelMixingRatio = saturationMixingRatioHpa(parcelTemp, pressure);
    }
    const parcelVirtualTemp = virtualTemperatureK(parcelTemp, parcelMixingRatio);
    if (!Number.isFinite(envVirtualTemp) || !Number.isFinite(parcelVirtualTemp)) {
      continue;
    }
    samples.push({
      pressureHpa: pressure,
      heightAglM: env.heightAglM,
      buoyancyMps2: (GRAVITY_M_S2 * (parcelVirtualTemp - envVirtualTemp)) / Math.max(180, envVirtualTemp),
    });
  }
  return samples.sort((left, right) => left.heightAglM - right.heightAglM);
}

function findTopPressureHpaForScratch(scratch, rowCount) {
  let topPressure = Number.POSITIVE_INFINITY;
  for (let row = 0; row < rowCount; row += 1) {
    const pressure = Number(scratch?.pressure?.[row]);
    if (Number.isFinite(pressure) && pressure > 0 && pressure < topPressure) {
      topPressure = pressure;
    }
  }
  return Number.isFinite(topPressure) ? topPressure : Number.NaN;
}

function interpolateBuoyancyZeroHeight(lower, upper, fallbackHeight) {
  const lowerBuoyancy = Number(lower?.buoyancyMps2);
  const upperBuoyancy = Number(upper?.buoyancyMps2);
  const lowerHeight = Number(lower?.heightAglM);
  const upperHeight = Number(upper?.heightAglM);
  if (
    Number.isFinite(lowerBuoyancy) &&
    Number.isFinite(upperBuoyancy) &&
    Number.isFinite(lowerHeight) &&
    Number.isFinite(upperHeight) &&
    Math.abs(upperBuoyancy - lowerBuoyancy) > 1e-9
  ) {
    return lowerHeight + (upperHeight - lowerHeight) * clamp01(-lowerBuoyancy / (upperBuoyancy - lowerBuoyancy));
  }
  return Number.isFinite(fallbackHeight) ? fallbackHeight : Number.isFinite(upperHeight) ? upperHeight : Number.NaN;
}

function calculateLiftedIndexForPointSoundingSource(rows, source, precomputedEnv500 = null) {
  const env500 = precomputedEnv500 || pointSoundingRowAtPressure(rows, 500);
  if (!env500) {
    return Number.NaN;
  }
  const envMixingRatio = mixingRatioFromDewpointK(Math.min(env500.dewpointK, env500.tempK), 500);
  const envVirtualTemp500K = virtualTemperatureK(env500.tempK, envMixingRatio);
  const parcelVirtualTemp500K = calculateParcelVirtualTemperatureAtPressureK(source, 500);
  return Number.isFinite(envVirtualTemp500K) && Number.isFinite(parcelVirtualTemp500K)
    ? envVirtualTemp500K - parcelVirtualTemp500K
    : Number.NaN;
}

function calculateParcelVirtualTemperatureAtPressureK(source, targetPressureHpa) {
  if (
    !source ||
    !Number.isFinite(source.pressureHpa) ||
    !Number.isFinite(source.tempK) ||
    !Number.isFinite(source.dewpointK) ||
    !Number.isFinite(targetPressureHpa) ||
    targetPressureHpa <= 0 ||
    targetPressureHpa > source.pressureHpa + 1
  ) {
    return Number.NaN;
  }
  const sourceDewpointK = Math.min(source.dewpointK, source.tempK);
  const parcelTempK = calculateParcelTemperatureAtPressureK(source, targetPressureHpa);
  const lclTempK = boltonLclTemperatureK(source.tempK, sourceDewpointK);
  const lclPressure = source.pressureHpa * Math.pow(lclTempK / source.tempK, CP_OVER_RD);
  if (![parcelTempK, lclPressure].every(Number.isFinite)) {
    return Number.NaN;
  }
  const mixingRatio =
    targetPressureHpa >= lclPressure
      ? mixingRatioFromDewpointK(sourceDewpointK, source.pressureHpa)
      : saturationMixingRatioHpa(parcelTempK, targetPressureHpa);
  return virtualTemperatureK(parcelTempK, mixingRatio);
}

function moistLiftTemperatureK(startPressureHpa, startTempK, targetPressureHpa) {
  const startPressure = Number(startPressureHpa);
  const targetPressure = Number(targetPressureHpa);
  const startTempC = kelvinToCelsius(startTempK);
  if (
    !Number.isFinite(startPressure) ||
    !Number.isFinite(targetPressure) ||
    !Number.isFinite(startTempC) ||
    startPressure <= 0 ||
    targetPressure <= 0
  ) {
    return Number.NaN;
  }
  const thetaC = potentialTemperatureC(startPressure, startTempC, 1000);
  const saturatedThetaC = thetaC - wobusCorrectionC(thetaC) + wobusCorrectionC(startTempC);
  const liftedC = saturatedLiftTemperatureC(targetPressure, saturatedThetaC);
  return Number.isFinite(liftedC) ? liftedC + 273.15 : Number.NaN;
}

function potentialTemperatureC(pressureHpa, tempC, referencePressureHpa = 1000) {
  const pressure = Number(pressureHpa);
  const referencePressure = Number(referencePressureHpa);
  const tempK = Number(tempC) + 273.15;
  if (!Number.isFinite(pressure) || !Number.isFinite(referencePressure) || !Number.isFinite(tempK) || pressure <= 0) {
    return Number.NaN;
  }
  return tempK * Math.pow(referencePressure / pressure, RD_OVER_CP) - 273.15;
}

function saturatedLiftTemperatureC(pressureHpa, saturatedThetaC) {
  const pressure = Number(pressureHpa);
  const theta = Number(saturatedThetaC);
  if (!Number.isFinite(pressure) || !Number.isFinite(theta) || pressure <= 0) {
    return Number.NaN;
  }
  if (Math.abs(pressure - 1000) <= 0.001) {
    return theta;
  }
  const pressurePower = Math.pow(pressure / 1000, RD_OVER_CP);
  let error = 999;
  let previousTemp = Number.NaN;
  let previousEval = Number.NaN;
  let temp = Number.NaN;
  let evalValue = Number.NaN;
  let rate = 1;
  for (let iteration = 0; iteration < 80 && Math.abs(error) > MOIST_LIFT_CONVERGENCE_C; iteration += 1) {
    if (error === 999) {
      previousTemp = (theta + 273.15) * pressurePower - 273.15;
      previousEval = wobusCorrectionC(previousTemp) - wobusCorrectionC(theta);
      rate = 1;
    } else {
      const deltaEval = evalValue - previousEval;
      if (!Number.isFinite(deltaEval) || Math.abs(deltaEval) < 1e-9) {
        return Number.NaN;
      }
      rate = (temp - previousTemp) / deltaEval;
      previousTemp = temp;
      previousEval = evalValue;
    }
    temp = previousTemp - previousEval * rate;
    evalValue = (temp + 273.15) / pressurePower - 273.15;
    evalValue += wobusCorrectionC(temp) - wobusCorrectionC(evalValue) - theta;
    error = evalValue * rate;
  }
  return Number.isFinite(temp) && Number.isFinite(error) ? temp - error : Number.NaN;
}

function wobusCorrectionC(tempC) {
  const t = Number(tempC) - 20;
  if (!Number.isFinite(t)) {
    return Number.NaN;
  }
  if (t <= 0) {
    const polynomial =
      1 +
      t *
        (-8.841660499999999e-3 +
          t * (1.4714143e-4 + t * (-9.671989000000001e-7 + t * (-3.2607217e-8 + t * -3.8598073e-10))));
    return 15.13 / Math.pow(polynomial, 4);
  }
  let polynomial =
    t * (4.9618922e-7 + t * (-6.1059365e-9 + t * (3.9401551e-11 + t * (-1.2588129e-13 + t * 1.668828e-16))));
  polynomial = 1 + t * (3.6182989e-3 + t * (-1.3603273e-5 + polynomial));
  return 29.93 / Math.pow(polynomial, 4) + 0.96 * t - 14.8;
}

function integrateMoistParcelTemperatureK(startTempK, startHeightM, targetHeightM, pressureHpa) {
  if (
    !Number.isFinite(startTempK) ||
    !Number.isFinite(startHeightM) ||
    !Number.isFinite(targetHeightM) ||
    !Number.isFinite(pressureHpa)
  ) {
    return Number.NaN;
  }
  const dz = Math.max(0, targetHeightM - startHeightM);
  if (dz <= 0) {
    return startTempK;
  }
  const steps = Math.max(1, Math.ceil(dz / MOIST_ADIABATIC_MAX_STEP_M));
  const stepDz = dz / steps;
  let tempK = startTempK;
  for (let step = 0; step < steps; step += 1) {
    const lapseRate = moistAdiabaticLapseRateKPerM(tempK, pressureHpa);
    if (!Number.isFinite(lapseRate)) {
      return Number.NaN;
    }
    tempK -= lapseRate * stepDz;
  }
  return tempK;
}

function moistAdiabaticLapseRateKPerM(tempK, pressureHpa) {
  const saturationMixingRatio = saturationMixingRatioHpa(tempK, pressureHpa);
  if (!Number.isFinite(tempK) || !Number.isFinite(saturationMixingRatio)) {
    return Number.NaN;
  }
  const latentTerm = (LATENT_HEAT_VAPORIZATION_J_KG * saturationMixingRatio) / (RD_DRY_AIR_J_KG_K * tempK);
  const denominator =
    CP_DRY_AIR_J_KG_K +
    (LATENT_HEAT_VAPORIZATION_J_KG * LATENT_HEAT_VAPORIZATION_J_KG * saturationMixingRatio * EPSILON) /
      (RD_DRY_AIR_J_KG_K * tempK * tempK);
  if (!Number.isFinite(latentTerm) || !Number.isFinite(denominator) || denominator <= 0) {
    return Number.NaN;
  }
  return (GRAVITY_M_S2 * (1 + latentTerm)) / denominator;
}

function mixingRatioFromDewpointK(dewpointK, pressureHpa) {
  return mixingRatioFromVaporPressureHpa(vaporPressureHpa(dewpointK), pressureHpa);
}

function saturationMixingRatioHpa(tempK, pressureHpa) {
  return mixingRatioFromVaporPressureHpa(vaporPressureHpa(tempK), pressureHpa);
}

function mixingRatioFromVaporPressureHpa(vaporPressure, pressureHpa) {
  const pressure = Number(pressureHpa);
  const e = Number(vaporPressure);
  if (!Number.isFinite(pressure) || !Number.isFinite(e) || pressure <= 0 || e <= 0 || e >= pressure) {
    return Number.NaN;
  }
  return (EPSILON * e) / (pressure - e);
}

function virtualTemperatureK(tempK, mixingRatio) {
  return Number.isFinite(tempK) && Number.isFinite(mixingRatio)
    ? (tempK * (1 + mixingRatio / EPSILON)) / (1 + mixingRatio)
    : Number.NaN;
}

function interpolateProfileWindRows(scratch, rowCount, targetHeight) {
  if (!Number.isFinite(targetHeight) || rowCount <= 0) {
    return null;
  }
  let lowerRow = -1;
  for (let row = 0; row < rowCount; row += 1) {
    const height = scratch.heights[row];
    const u = scratch.u[row];
    const v = scratch.v[row];
    if (!Number.isFinite(height) || !Number.isFinite(u) || !Number.isFinite(v)) {
      continue;
    }
    if (height === targetHeight) {
      return { u, v };
    }
    if (height < targetHeight) {
      lowerRow = row;
      continue;
    }
    if (lowerRow < 0) {
      return null;
    }
    const lowerHeight = scratch.heights[lowerRow];
    const fraction = (targetHeight - lowerHeight) / Math.max(1e-9, height - lowerHeight);
    return {
      u: scratch.u[lowerRow] + (u - scratch.u[lowerRow]) * clamp01(fraction),
      v: scratch.v[lowerRow] + (v - scratch.v[lowerRow]) * clamp01(fraction),
    };
  }
  return null;
}

function calculateMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM) {
  const pressureCoordinateMean = calculatePressureCoordinateMeanWindInHeightLayerFromRows(
    scratch,
    rowCount,
    bottomAglM,
    topAglM,
  );
  if (pressureCoordinateMean) {
    return pressureCoordinateMean;
  }
  return calculateHeightMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM);
}

function calculateHeightMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM) {
  if (!Number.isFinite(bottomAglM) || !Number.isFinite(topAglM) || topAglM <= bottomAglM) {
    return null;
  }
  let previousHeight = bottomAglM;
  let previousWind = interpolateProfileWindRows(scratch, rowCount, bottomAglM);
  if (!previousWind) {
    return null;
  }
  let sumU = 0;
  let sumV = 0;
  let totalDepth = 0;
  const addSegment = (nextHeight, nextWind) => {
    const dz = nextHeight - previousHeight;
    if (Number.isFinite(dz) && dz > 0) {
      sumU += ((previousWind.u + nextWind.u) / 2) * dz;
      sumV += ((previousWind.v + nextWind.v) / 2) * dz;
      totalDepth += dz;
    }
    previousHeight = nextHeight;
    previousWind = nextWind;
  };
  for (let row = 0; row < rowCount; row += 1) {
    const height = scratch.heights[row];
    if (!Number.isFinite(height) || height <= bottomAglM || height >= topAglM) {
      continue;
    }
    addSegment(height, { u: scratch.u[row], v: scratch.v[row] });
  }
  const topWind = interpolateProfileWindRows(scratch, rowCount, topAglM);
  if (!topWind) {
    return null;
  }
  addSegment(topAglM, topWind);
  return totalDepth > 0 ? { u: sumU / totalDepth, v: sumV / totalDepth } : null;
}

function calculatePressureCoordinateMeanWindInHeightLayerFromRows(
  scratch,
  rowCount,
  bottomAglM,
  topAglM,
  options = {},
) {
  const bottomPressure = interpolateProfilePressureRows(scratch, rowCount, bottomAglM);
  const topPressure = interpolateProfilePressureRows(scratch, rowCount, topAglM);
  return calculateMeanWindByPressureFromRows(scratch, rowCount, bottomPressure, topPressure, options);
}

function calculatePointSoundingMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM) {
  return calculateMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM);
}

function calculateCorfidiMcsMotionFromRows(scratch, rowCount) {
  const surfacePressure = scratch.pressure?.[0];
  if (!Number.isFinite(surfacePressure) || rowCount < 3) {
    return null;
  }
  const deepBottomPressure = surfacePressure < 850 ? surfacePressure : 850;
  const deepMean = calculateMeanWindByPressureFromRows(scratch, rowCount, deepBottomPressure, 300);
  const pressureAt1p5km = interpolateProfilePressureRows(scratch, rowCount, 1500);
  const lowMean = calculateMeanWindByPressureFromRows(scratch, rowCount, surfacePressure, pressureAt1p5km);
  if (!deepMean || !lowMean) {
    return null;
  }
  const upshear = {
    u: deepMean.u - lowMean.u,
    v: deepMean.v - lowMean.v,
  };
  return {
    upshear,
    downshear: {
      u: deepMean.u + upshear.u,
      v: deepMean.v + upshear.v,
    },
  };
}

function calculateMeanWindByPressureFromRows(scratch, rowCount, bottomPressureHpa, topPressureHpa, options = {}) {
  const bottomPressure = Number(bottomPressureHpa);
  const topPressure = Number(topPressureHpa);
  if (!Number.isFinite(bottomPressure) || !Number.isFinite(topPressure) || bottomPressure <= topPressure) {
    return null;
  }
  const pressureWeighted = Boolean(options?.pressureWeighted);
  const samples = [];
  const addSample = (sample) => {
    if (!sample || !Number.isFinite(sample.pressureHpa) || !Number.isFinite(sample.u) || !Number.isFinite(sample.v)) {
      return;
    }
    if (sample.pressureHpa > bottomPressure + 1e-6 || sample.pressureHpa < topPressure - 1e-6) {
      return;
    }
    if (samples.some((existing) => Math.abs(existing.pressureHpa - sample.pressureHpa) < 1e-6)) {
      return;
    }
    samples.push(sample);
  };
  const bottomWind = interpolateProfileWindAtPressureRows(scratch, rowCount, bottomPressure);
  const topWind = interpolateProfileWindAtPressureRows(scratch, rowCount, topPressure);
  if (!isFiniteWindVector(bottomWind) || !isFiniteWindVector(topWind)) {
    return null;
  }
  addSample({ pressureHpa: bottomPressure, ...bottomWind });
  for (let row = 0; row < rowCount; row += 1) {
    const pressure = scratch.pressure[row];
    if (!Number.isFinite(pressure) || pressure >= bottomPressure || pressure <= topPressure) {
      continue;
    }
    addSample({ pressureHpa: pressure, u: scratch.u[row], v: scratch.v[row] });
  }
  addSample({ pressureHpa: topPressure, ...topWind });
  samples.sort((left, right) => right.pressureHpa - left.pressureHpa);
  let sumU = 0;
  let sumV = 0;
  let totalWeight = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const lower = samples[index - 1];
    const upper = samples[index];
    const dp = lower.pressureHpa - upper.pressureHpa;
    if (!Number.isFinite(dp) || dp <= 0) {
      continue;
    }
    const midPressure = (lower.pressureHpa + upper.pressureHpa) / 2;
    const mid = interpolateProfileWindAtPressureRows(scratch, rowCount, midPressure);
    const segmentWeight = pressureWeighted ? ((lower.pressureHpa + 4 * midPressure + upper.pressureHpa) / 6) * dp : dp;
    if (mid) {
      if (pressureWeighted) {
        sumU += ((lower.u * lower.pressureHpa + 4 * mid.u * midPressure + upper.u * upper.pressureHpa) / 6) * dp;
        sumV += ((lower.v * lower.pressureHpa + 4 * mid.v * midPressure + upper.v * upper.pressureHpa) / 6) * dp;
      } else {
        sumU += ((lower.u + 4 * mid.u + upper.u) / 6) * dp;
        sumV += ((lower.v + 4 * mid.v + upper.v) / 6) * dp;
      }
    } else {
      if (pressureWeighted) {
        sumU += ((lower.u * lower.pressureHpa + upper.u * upper.pressureHpa) / 2) * dp;
        sumV += ((lower.v * lower.pressureHpa + upper.v * upper.pressureHpa) / 2) * dp;
      } else {
        sumU += ((lower.u + upper.u) / 2) * dp;
        sumV += ((lower.v + upper.v) / 2) * dp;
      }
    }
    totalWeight += segmentWeight;
  }
  return totalWeight > 0 ? { u: sumU / totalWeight, v: sumV / totalWeight } : null;
}

function isFiniteWindVector(wind) {
  return Boolean(wind && Number.isFinite(wind.u) && Number.isFinite(wind.v));
}

function interpolateProfilePressureRows(scratch, rowCount, targetHeight) {
  if (!Number.isFinite(targetHeight) || rowCount <= 0) {
    return Number.NaN;
  }
  let lowerRow = -1;
  for (let row = 0; row < rowCount; row += 1) {
    const height = scratch.heights[row];
    const pressure = scratch.pressure[row];
    if (!Number.isFinite(height) || !Number.isFinite(pressure) || pressure <= 0) {
      continue;
    }
    if (height === targetHeight) {
      return pressure;
    }
    if (height < targetHeight) {
      lowerRow = row;
      continue;
    }
    if (lowerRow < 0) {
      return Number.NaN;
    }
    const lowerHeight = scratch.heights[lowerRow];
    const lowerPressure = scratch.pressure[lowerRow];
    if (!Number.isFinite(lowerHeight) || !Number.isFinite(lowerPressure) || lowerPressure <= 0) {
      return Number.NaN;
    }
    const fraction = (targetHeight - lowerHeight) / Math.max(1e-9, height - lowerHeight);
    return Math.exp(Math.log(lowerPressure) + (Math.log(pressure) - Math.log(lowerPressure)) * clamp01(fraction));
  }
  return Number.NaN;
}

function interpolateProfileWindAtPressureRows(scratch, rowCount, targetPressureHpa) {
  const targetPressure = Number(targetPressureHpa);
  if (!Number.isFinite(targetPressure) || targetPressure <= 0 || rowCount <= 0) {
    return null;
  }
  for (let row = 0; row < rowCount; row += 1) {
    if (Math.abs(Number(scratch.pressure[row]) - targetPressure) < 1e-6) {
      const u = scratch.u[row];
      const v = scratch.v[row];
      return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
    }
  }
  for (let row = 1; row < rowCount; row += 1) {
    const lowerPressure = scratch.pressure[row - 1];
    const upperPressure = scratch.pressure[row];
    if (
      !Number.isFinite(lowerPressure) ||
      !Number.isFinite(upperPressure) ||
      lowerPressure <= 0 ||
      upperPressure <= 0
    ) {
      continue;
    }
    const brackets =
      (lowerPressure >= targetPressure && upperPressure <= targetPressure) ||
      (lowerPressure <= targetPressure && upperPressure >= targetPressure);
    if (!brackets) {
      continue;
    }
    const lowerU = scratch.u[row - 1];
    const lowerV = scratch.v[row - 1];
    const upperU = scratch.u[row];
    const upperV = scratch.v[row];
    if (![lowerU, lowerV, upperU, upperV].every(Number.isFinite)) {
      continue;
    }
    const fraction = logPressureInterpolationFraction(targetPressure, lowerPressure, upperPressure);
    const t = clamp01(fraction);
    return {
      u: lowerU + (upperU - lowerU) * t,
      v: lowerV + (upperV - lowerV) * t,
    };
  }
  return null;
}

function interpolateProfileThermoAtPressureRows(scratch, rowCount, targetPressureHpa) {
  const targetPressure = Number(targetPressureHpa);
  if (!Number.isFinite(targetPressure) || targetPressure <= 0 || rowCount <= 0) {
    return null;
  }
  for (let row = 0; row < rowCount; row += 1) {
    if (Math.abs(Number(scratch.pressure[row]) - targetPressure) < 1e-6) {
      return {
        pressureHpa: targetPressure,
        heightAglM: scratch.heights[row],
        tempK: scratch.temp[row],
        dewpointK: scratch.dewpoint[row],
      };
    }
  }
  for (let row = 1; row < rowCount; row += 1) {
    const lowerPressure = scratch.pressure[row - 1];
    const upperPressure = scratch.pressure[row];
    if (
      !Number.isFinite(lowerPressure) ||
      !Number.isFinite(upperPressure) ||
      lowerPressure <= 0 ||
      upperPressure <= 0
    ) {
      continue;
    }
    const brackets =
      (lowerPressure >= targetPressure && upperPressure <= targetPressure) ||
      (lowerPressure <= targetPressure && upperPressure >= targetPressure);
    if (!brackets) {
      continue;
    }
    const fraction = logPressureInterpolationFraction(targetPressure, lowerPressure, upperPressure);
    const t = clamp01(fraction);
    return {
      pressureHpa: targetPressure,
      heightAglM: scratch.heights[row - 1] + (scratch.heights[row] - scratch.heights[row - 1]) * t,
      tempK: scratch.temp[row - 1] + (scratch.temp[row] - scratch.temp[row - 1]) * t,
      dewpointK: scratch.dewpoint[row - 1] + (scratch.dewpoint[row] - scratch.dewpoint[row - 1]) * t,
    };
  }
  return null;
}

function calculateBunkersMotionFromRows(scratch, rowCount, options = {}) {
  const meanBottomAglM = Number.isFinite(options?.meanBottomAglM) ? Number(options.meanBottomAglM) : 0;
  const meanTopAglM = Number.isFinite(options?.meanTopAglM) ? Number(options.meanTopAglM) : 6000;
  const shearBottomAglM = Number.isFinite(options?.shearBottomAglM) ? Number(options.shearBottomAglM) : 0;
  const shearTopAglM = Number.isFinite(options?.shearTopAglM) ? Number(options.shearTopAglM) : 6000;
  if (meanTopAglM <= meanBottomAglM || shearTopAglM <= shearBottomAglM + 500) {
    return null;
  }
  const meanWind = calculatePressureCoordinateMeanWindInHeightLayerFromRows(
    scratch,
    rowCount,
    meanBottomAglM,
    meanTopAglM,
    {
      pressureWeighted: Boolean(options?.pressureWeightedMean),
    },
  );
  const windsLo = calculatePressureCoordinateMeanWindInHeightLayerFromRows(
    scratch,
    rowCount,
    shearBottomAglM,
    shearBottomAglM + 500,
  );
  const windsHi = calculatePressureCoordinateMeanWindInHeightLayerFromRows(
    scratch,
    rowCount,
    shearTopAglM - 500,
    shearTopAglM,
  );
  if (!meanWind || !windsLo || !windsHi) {
    return null;
  }
  const shearU = windsHi.u - windsLo.u;
  const shearV = windsHi.v - windsLo.v;
  const shearMagnitude = Math.hypot(shearU, shearV);
  if (!Number.isFinite(shearMagnitude) || shearMagnitude < 1e-6) {
    return null;
  }
  return {
    right: {
      u: meanWind.u + (BUNKERS_RIGHT_MOVER_DEVIATION_MPS * shearV) / shearMagnitude,
      v: meanWind.v - (BUNKERS_RIGHT_MOVER_DEVIATION_MPS * shearU) / shearMagnitude,
    },
    left: {
      u: meanWind.u - (BUNKERS_RIGHT_MOVER_DEVIATION_MPS * shearV) / shearMagnitude,
      v: meanWind.v + (BUNKERS_RIGHT_MOVER_DEVIATION_MPS * shearU) / shearMagnitude,
    },
  };
}

function calculateStormRelativeHelicityFromRows(scratch, rowCount, bottomAglM, topAglM, stormMotion) {
  if (!stormMotion || !Number.isFinite(bottomAglM) || !Number.isFinite(topAglM) || topAglM <= bottomAglM) {
    return Number.NaN;
  }
  let previousWind = interpolateProfileWindRows(scratch, rowCount, bottomAglM);
  if (!previousWind) {
    return Number.NaN;
  }
  let helicity = 0;
  const addPoint = (nextWind) => {
    helicity +=
      (nextWind.u - stormMotion.u) * (previousWind.v - stormMotion.v) -
      (previousWind.u - stormMotion.u) * (nextWind.v - stormMotion.v);
    previousWind = nextWind;
  };
  for (let row = 0; row < rowCount; row += 1) {
    const height = scratch.heights[row];
    if (!Number.isFinite(height) || height <= bottomAglM || height >= topAglM) {
      continue;
    }
    addPoint({ u: scratch.u[row], v: scratch.v[row] });
  }
  const topWind = interpolateProfileWindRows(scratch, rowCount, topAglM);
  if (!topWind) {
    return Number.NaN;
  }
  addPoint(topWind);
  return helicity;
}

function buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount) {
  const mixedLayer = calculateMixedLayerParcelPropertiesFromScratch(scratch, rowCount);
  if (!mixedLayer) {
    return null;
  }
  return {
    source: "mixedLayer",
    pressureHpa: mixedLayer.pressureHpa,
    heightAglM: 0,
    heightMslM: Number.NaN,
    tempK: mixedLayer.tempK,
    dewpointK: mixedLayer.dewpointK,
    uMps: scratch.u?.[0],
    vMps: scratch.v?.[0],
  };
}

function calculateMixedLayerParcelPropertiesFromScratch(scratch, rowCount, depthHpa = MIXED_LAYER_PARCEL_DEPTH_HPA) {
  const surfacePressure = Number(scratch.pressure?.[0]);
  if (!Number.isFinite(surfacePressure) || surfacePressure <= depthHpa + 100 || rowCount < 2) {
    return null;
  }
  const topPressure = surfacePressure - depthHpa;
  const samples = [];
  const addSample = (sample) => {
    if (
      !sample ||
      !Number.isFinite(sample.pressureHpa) ||
      !Number.isFinite(sample.thetaK) ||
      !Number.isFinite(sample.mixingRatio)
    ) {
      return;
    }
    if (sample.pressureHpa > surfacePressure + 1e-6 || sample.pressureHpa < topPressure - 1e-6) {
      return;
    }
    if (samples.some((existing) => Math.abs(existing.pressureHpa - sample.pressureHpa) < 1e-6)) {
      return;
    }
    samples.push(sample);
  };
  const surfaceSample = mixedLayerSampleAtPressure(scratch, rowCount, surfacePressure);
  const topSample = mixedLayerSampleAtPressure(scratch, rowCount, topPressure);
  if (!surfaceSample || !topSample) {
    return null;
  }
  addSample(surfaceSample);
  for (let row = 0; row < rowCount; row += 1) {
    const pressure = scratch.pressure[row];
    if (!Number.isFinite(pressure) || pressure >= surfacePressure || pressure <= topPressure) {
      continue;
    }
    addSample(mixedLayerSampleFromValues(pressure, scratch.temp[row], scratch.dewpoint[row]));
  }
  addSample(topSample);
  samples.sort((left, right) => right.pressureHpa - left.pressureHpa);
  let thetaIntegral = 0;
  let mixingRatioIntegral = 0;
  let totalDp = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const lower = samples[index - 1];
    const upper = samples[index];
    const dp = lower.pressureHpa - upper.pressureHpa;
    if (!Number.isFinite(dp) || dp <= 0) {
      continue;
    }
    const midPressure = (lower.pressureHpa + upper.pressureHpa) / 2;
    const mid = mixedLayerSampleAtPressure(scratch, rowCount, midPressure);
    if (mid) {
      thetaIntegral += ((lower.thetaK + 4 * mid.thetaK + upper.thetaK) / 6) * dp;
      mixingRatioIntegral += ((lower.mixingRatio + 4 * mid.mixingRatio + upper.mixingRatio) / 6) * dp;
    } else {
      thetaIntegral += ((lower.thetaK + upper.thetaK) / 2) * dp;
      mixingRatioIntegral += ((lower.mixingRatio + upper.mixingRatio) / 2) * dp;
    }
    totalDp += dp;
  }
  if (totalDp <= 0) {
    return null;
  }
  const meanTheta = thetaIntegral / totalDp;
  const meanMixingRatio = mixingRatioIntegral / totalDp;
  const parcelTemp = meanTheta * Math.pow(surfacePressure / 1000, RD_OVER_CP);
  const vaporPressure = (meanMixingRatio * surfacePressure) / (EPSILON + meanMixingRatio);
  const parcelDewpoint = dewpointFromVaporPressureHpa(vaporPressure);
  if (!Number.isFinite(parcelTemp) || !Number.isFinite(parcelDewpoint)) {
    return null;
  }
  return {
    pressureHpa: surfacePressure,
    tempK: parcelTemp,
    dewpointK: parcelDewpoint,
  };
}

function mixedLayerSampleAtPressure(scratch, rowCount, pressureHpa) {
  const sample = interpolateProfileThermoAtPressureRows(scratch, rowCount, pressureHpa);
  if (!sample || !Number.isFinite(sample.tempK) || !Number.isFinite(sample.dewpointK)) {
    return null;
  }
  return mixedLayerSampleFromValues(sample.pressureHpa, sample.tempK, sample.dewpointK);
}

function mixedLayerSampleFromValues(pressureHpa, tempK, dewpointK) {
  const pressure = Number(pressureHpa);
  const temp = Number(tempK);
  const dewpoint = Math.min(Number(dewpointK), temp);
  const mixingRatio = mixingRatioFromDewpointK(dewpoint, pressure);
  const theta = temp * Math.pow(1000 / pressure, RD_OVER_CP);
  if (!Number.isFinite(mixingRatio) || !Number.isFinite(theta)) {
    return null;
  }
  return {
    pressureHpa: pressure,
    thetaK: theta,
    mixingRatio,
  };
}

function calculateParcelLclAglM(source) {
  const sourceHeight = Number(source?.heightAglM);
  const sourceTemp = Number(source?.tempK);
  const sourceDewpoint = Math.min(Number(source?.dewpointK), sourceTemp);
  if (!Number.isFinite(sourceHeight) || !Number.isFinite(sourceTemp) || !Number.isFinite(sourceDewpoint)) {
    return Number.NaN;
  }
  const lclTemp = boltonLclTemperatureK(sourceTemp, sourceDewpoint);
  return Number.isFinite(lclTemp)
    ? Math.max(0, sourceHeight + (sourceTemp - lclTemp) / DRY_ADIABATIC_LAPSE_K_M)
    : Number.NaN;
}

function calculatePointSoundingMixedLayerLclMFromRows(scratch, rowCount) {
  return calculateParcelLclAglM(buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount));
}

function calculateMixedLayerLclMFromRows(scratch, rowCount) {
  return calculateParcelLclAglM(buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount));
}

function dewpointFromVaporPressureHpa(vaporPressure) {
  if (!Number.isFinite(vaporPressure) || vaporPressure <= 0) {
    return Number.NaN;
  }
  const logRatio = Math.log(vaporPressure / 6.112);
  return 273.15 + (243.5 * logRatio) / (17.67 - logRatio);
}

function buildDerivedProfileSources(decoded) {
  return DERIVED_DIAGNOSTIC_PROFILE_LEVELS.map((level) => ({
    level,
    hgt: profileDataGrid(decoded, "HGT", level),
    tmp: profileDataGrid(decoded, "TMP", level),
    rh: profileDataGrid(decoded, "RH", level),
    u: profileDataGrid(decoded, "UGRD", level),
    v: profileDataGrid(decoded, "VGRD", level),
  }));
}

function buildEffectiveLayerProfileSources(decoded) {
  return EFFECTIVE_LAYER_PROFILE_LEVELS.map((level) => ({
    level,
    hgt: profileDataGrid(decoded, "HGT", level),
    tmp: profileDataGrid(decoded, "TMP", level),
    rh: profileDataGrid(decoded, "RH", level),
    u: profileDataGrid(decoded, "UGRD", level),
    v: profileDataGrid(decoded, "VGRD", level),
  }));
}

function profileDataGrid(decoded, variable, level) {
  if (!decoded) {
    return null;
  }
  return decoded[profileDecodeKey(variable, level)] || decoded[standardProfileDecodeKey(variable, level)] || null;
}

function surfaceWindVector(decoded, index) {
  const u = profileValue(decoded, "UGRD", "surface", index);
  const v = profileValue(decoded, "VGRD", "surface", index);
  return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
}

function interpolateDerivedProfileColumn(
  sources,
  variable,
  index,
  aglMeters,
  elevation,
  surfaceValue = Number.NaN,
  options = {},
) {
  const targetHeight = elevation + aglMeters;
  const requireUpperBracket = options.requireUpperBracket !== false;
  let lowerHeight = Number.NaN;
  let lowerValue = Number.NaN;
  if (Number.isFinite(surfaceValue)) {
    if (elevation === targetHeight) {
      return surfaceValue;
    }
    if (elevation < targetHeight) {
      lowerHeight = elevation;
      lowerValue = surfaceValue;
    }
  }
  for (const source of sources) {
    const currentHeight = gridValue(source.hgt, index);
    const currentValue = derivedProfileSourceValue(source, variable, index);
    if (!Number.isFinite(currentHeight) || currentHeight <= elevation || !Number.isFinite(currentValue)) {
      continue;
    }
    if (currentHeight === targetHeight) {
      return currentValue;
    }
    if (currentHeight < targetHeight) {
      lowerHeight = currentHeight;
      lowerValue = currentValue;
      continue;
    }
    if (!Number.isFinite(lowerHeight) || !Number.isFinite(lowerValue)) {
      return currentValue;
    }
    const t = (targetHeight - lowerHeight) / Math.max(1e-9, currentHeight - lowerHeight);
    return lowerValue + (currentValue - lowerValue) * Math.max(0, Math.min(1, t));
  }
  return requireUpperBracket ? Number.NaN : Number.isFinite(lowerValue) ? lowerValue : Number.NaN;
}

function derivedProfileSourceValue(source, variable, index) {
  if (variable === "TMP") {
    return gridValue(source.tmp, index);
  }
  if (variable === "RH") {
    return gridValue(source.rh, index);
  }
  if (variable === "UGRD") {
    return gridValue(source.u, index);
  }
  if (variable === "VGRD") {
    return gridValue(source.v, index);
  }
  return Number.NaN;
}

function calculateBulkShearKtFromSources(sources, index, elevation, topAglM, surfaceWind) {
  if (!Number.isFinite(elevation) || !surfaceWind) {
    return Number.NaN;
  }
  const topU = interpolateDerivedProfileColumn(sources, "UGRD", index, topAglM, elevation, surfaceWind.u);
  const topV = interpolateDerivedProfileColumn(sources, "VGRD", index, topAglM, elevation, surfaceWind.v);
  if (!Number.isFinite(topU) || !Number.isFinite(topV)) {
    return Number.NaN;
  }
  return Math.hypot(topU - surfaceWind.u, topV - surfaceWind.v) * MPS_TO_KT;
}

function buildFrontogenesisGrid(decoded, level, bounds, width, height) {
  const temp = decoded?.[`temp${level}`];
  const u = decoded?.[`wind${level}U`];
  const v = decoded?.[`wind${level}V`];
  if (!temp || !u || !v || width < 3 || height < 3) {
    return null;
  }
  const cols = Math.round(Number(width));
  const rows = Math.round(Number(height));
  const cellCount = cols * rows;
  const theta = new Float32Array(cellCount).fill(Number.NaN);
  const thetaMultiplier = Math.pow(1000 / level, RD_OVER_CP);
  for (let index = 0; index < cellCount; index += 1) {
    const tempK = Number(temp[index]);
    if (Number.isFinite(tempK)) {
      theta[index] = tempK * thetaMultiplier;
    }
  }

  const out = new Float32Array(cellCount).fill(Number.NaN);
  const spacingRows = buildFiniteDifferenceSpacingRows(bounds, cols, rows);
  if (!spacingRows) {
    return out;
  }
  for (let y = 1; y < rows - 1; y += 1) {
    const dx2 = spacingRows.dx2[y];
    const dy2 = spacingRows.dy2[y];
    if (!Number.isFinite(dx2) || !Number.isFinite(dy2)) {
      continue;
    }
    for (let x = 1; x < cols - 1; x += 1) {
      const index = y * cols + x;
      const dThetaDx = centralDiffX(theta, x, y, cols, dx2);
      const dThetaDy = centralDiffY(theta, x, y, cols, dy2);
      const dUdx = centralDiffX(u, x, y, cols, dx2);
      const dUdy = centralDiffY(u, x, y, cols, dy2);
      const dVdx = centralDiffX(v, x, y, cols, dx2);
      const dVdy = centralDiffY(v, x, y, cols, dy2);
      const gradientMagnitude = Math.hypot(dThetaDx, dThetaDy);
      if (
        !Number.isFinite(gradientMagnitude) ||
        gradientMagnitude < 1e-12 ||
        !Number.isFinite(dUdx) ||
        !Number.isFinite(dUdy) ||
        !Number.isFinite(dVdx) ||
        !Number.isFinite(dVdy)
      ) {
        continue;
      }
      const stretching = dUdx - dVdy;
      const shearing = dVdx + dUdy;
      const numerator = (dThetaDx * dThetaDx - dThetaDy * dThetaDy) * stretching + 2 * dThetaDx * dThetaDy * shearing;
      out[index] = (-0.5 * numerator * 100000 * 10800) / gradientMagnitude;
    }
  }
  return out;
}

function buildFiniteDifferenceSpacingRows(bounds, cols, rows) {
  const west = Number(bounds?.west);
  const east = Number(bounds?.east);
  if (!Number.isFinite(west) || !Number.isFinite(east)) {
    return null;
  }
  const lonStepRad = Math.abs(((east - west) * Math.PI) / 180 / Math.max(1, cols - 1));
  const dx2 = new Float64Array(Math.max(0, rows));
  const dy2 = new Float64Array(Math.max(0, rows));
  dx2.fill(Number.NaN);
  dy2.fill(Number.NaN);
  for (let y = 1; y < rows - 1; y += 1) {
    const centerLat = rowToLatMercator(y, rows, bounds);
    const northLat = rowToLatMercator(y - 1, rows, bounds);
    const southLat = rowToLatMercator(y + 1, rows, bounds);
    if (!Number.isFinite(centerLat) || !Number.isFinite(northLat) || !Number.isFinite(southLat)) {
      continue;
    }
    dx2[y] = Math.max(1, 2 * EARTH_RADIUS_M * Math.cos((centerLat * Math.PI) / 180) * lonStepRad);
    dy2[y] = Math.max(1, EARTH_RADIUS_M * Math.abs(((northLat - southLat) * Math.PI) / 180));
  }
  return { dx2, dy2 };
}

function centralDiffX(values, x, y, cols, dx2) {
  const left = Number(values[y * cols + x - 1]);
  const right = Number(values[y * cols + x + 1]);
  return Number.isFinite(left) && Number.isFinite(right) ? (right - left) / dx2 : Number.NaN;
}

function centralDiffY(values, x, y, cols, dy2) {
  const north = Number(values[(y - 1) * cols + x]);
  const south = Number(values[(y + 1) * cols + x]);
  return Number.isFinite(north) && Number.isFinite(south) ? (north - south) / dy2 : Number.NaN;
}

function buildFreezingRainLiquidInGrid(decoded) {
  if (decoded?.freezingRainLiquidTotalDirect) {
    return transformGridAffine(decoded.freezingRainLiquidTotalDirect, MM_TO_IN, 0, 0);
  }
  return null;
}

function buildFramIceGrids(decoded, selection, liquidIn, cellCount) {
  const flat = new Float32Array(cellCount).fill(Number.NaN);
  const radial = new Float32Array(cellCount).fill(Number.NaN);
  const accumulationHours = parseAccumulationHours(selection?.records?.precip) || 1;
  for (let index = 0; index < cellCount; index += 1) {
    const liquid = Number(liquidIn?.[index]);
    if (!Number.isFinite(liquid) || liquid <= 0) {
      flat[index] = 0;
      radial[index] = 0;
      continue;
    }
    const tempK = profileValue(decoded, "TMP", "surface", index);
    const dewpointK = surfaceDewpointK(decoded, index);
    const wetBulbC = wetBulbTemperatureC(tempK, dewpointK);
    const windKt = profileSpeedAtLevel(decoded, "surface", index) * MPS_TO_KT;
    if (!Number.isFinite(wetBulbC) || !Number.isFinite(windKt)) {
      continue;
    }
    const rateInHr = liquid / Math.max(1 / 60, accumulationHours);
    const ilr = calculateFramIceLiquidRatio(rateInHr, wetBulbC, windKt);
    if (!Number.isFinite(ilr)) {
      continue;
    }
    flat[index] = liquid * ilr;
    radial[index] = flat[index] * 0.394;
  }
  return { flat, radial };
}

function buildFramIceGridsFromChunks({
  chunks,
  chunkDescriptors = null,
  liquidByChunk,
  profilesByHour,
  decoded,
  width,
  height,
}) {
  const cellCount = Number(width) * Number(height);
  const flat = new Float32Array(cellCount).fill(0);
  const radial = new Float32Array(cellCount).fill(0);
  if (!Number.isFinite(cellCount) || cellCount <= 0 || !Array.isArray(chunks) || chunks.length === 0) {
    return { flat: null, radial: null };
  }
  const descriptors = Array.isArray(chunkDescriptors)
    ? chunkDescriptors
    : buildLiquidChunkDescriptors({ chunks, liquidByChunk, width, height, threshold: 0 });
  if (descriptors.length === 0) {
    return { flat: null, radial: null };
  }
  const environmentByHour = buildFramEnvironmentByHour({
    chunkDescriptors: descriptors,
    profilesByHour,
    decoded,
    cellCount,
  });
  let hasFinite = false;
  for (const descriptor of descriptors) {
    const { chunk, liquidIn: liquidGrid, activeIndices } = descriptor;
    if (!liquidGrid || liquidGrid.length !== cellCount) {
      return { flat: null, radial: null };
    }
    const durationHours = Math.max(1 / 60, Math.max(0, Number(chunk.endHour) - Number(chunk.startHour)));
    const environmentSegments = framEnvironmentSegmentsForChunk(chunk, profilesByHour, durationHours);
    const visitCount = activeVisitCount(activeIndices, cellCount);
    for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
      const index = activeVisitIndex(activeIndices, visitIndex);
      if (Number.isNaN(flat[index])) {
        continue;
      }
      const liquid = Number(liquidGrid[index]);
      if (!Number.isFinite(liquid)) {
        flat[index] = Number.NaN;
        radial[index] = Number.NaN;
        continue;
      }
      if (liquid <= 0) {
        hasFinite = true;
        continue;
      }
      let flatIce = 0;
      let validWeight = 0;
      let missingEnvironment = false;
      for (const segment of environmentSegments) {
        const environment = environmentByHour.get(segment.hour);
        const wetBulbC = environment?.wetBulbC?.[index];
        const windKt = environment?.windKt?.[index];
        const ilr = calculateFramIceLiquidRatio(liquid / durationHours, wetBulbC, windKt);
        if (!Number.isFinite(ilr)) {
          missingEnvironment = true;
          break;
        }
        flatIce += liquid * segment.weight * ilr;
        validWeight += segment.weight;
      }
      if (missingEnvironment || validWeight <= 0) {
        flat[index] = Number.NaN;
        radial[index] = Number.NaN;
        continue;
      }
      flat[index] += flatIce;
      radial[index] += flatIce * 0.394;
      hasFinite = true;
    }
  }
  return hasFinite ? { flat, radial } : { flat: null, radial: null };
}

function buildFramEnvironmentByHour({ chunkDescriptors, profilesByHour, decoded, cellCount }) {
  const indicesByHour = new Map();
  const denseHours = new Set();
  for (const descriptor of chunkDescriptors || []) {
    for (const hour of framProfileHoursForChunk(descriptor?.chunk)) {
      if (!Number.isFinite(Number(hour))) {
        continue;
      }
      if (descriptor.activeIndices === null) {
        denseHours.add(hour);
        indicesByHour.delete(hour);
        continue;
      }
      if (denseHours.has(hour)) {
        continue;
      }
      const group = indicesByHour.get(hour) || new Set();
      for (let visitIndex = 0; visitIndex < descriptor.activeIndices.length; visitIndex += 1) {
        group.add(descriptor.activeIndices[visitIndex]);
      }
      indicesByHour.set(hour, group);
    }
  }
  const out = new Map();
  for (const hour of denseHours) {
    indicesByHour.set(hour, null);
  }
  for (const [hour, activeIndexSet] of indicesByHour.entries()) {
    const profileDecoded = profilesByHour?.get(hour) || decoded || {};
    const wetBulbC = new Float32Array(cellCount).fill(Number.NaN);
    const windKt = new Float32Array(cellCount).fill(Number.NaN);
    const visitCount = activeIndexSet === null ? cellCount : activeIndexSet.size;
    const sparseIndices = activeIndexSet === null ? null : Array.from(activeIndexSet);
    for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
      const index = sparseIndices ? sparseIndices[visitIndex] : visitIndex;
      const tempK = profileValue(profileDecoded, "TMP", "surface", index);
      const dewpointK = surfaceDewpointK(profileDecoded, index);
      const wetBulb = wetBulbTemperatureC(tempK, dewpointK);
      const wind = profileSpeedAtLevel(profileDecoded, "surface", index) * MPS_TO_KT;
      if (Number.isFinite(wetBulb)) {
        wetBulbC[index] = wetBulb;
      }
      if (Number.isFinite(wind)) {
        windKt[index] = wind;
      }
    }
    out.set(hour, { wetBulbC, windKt });
  }
  return out;
}

function framEnvironmentSegmentsForChunk(chunk, profilesByHour, durationHours) {
  const start = Math.round(Number(chunk?.startHour));
  const end = Math.round(Number(chunk?.endHour ?? chunk?.profileHour));
  const totalDuration = Math.max(1 / 60, Number(durationHours));
  let previousHour = Number.isFinite(start) ? start : end;
  const segments = [];
  for (const hour of framProfileHoursForChunk(chunk)) {
    if (!profilesByHour?.has(hour)) {
      continue;
    }
    const duration = Math.max(0, Number(hour) - previousHour);
    previousHour = Number(hour);
    if (duration <= 0) {
      continue;
    }
    segments.push({ hour, weight: duration / totalDuration });
  }
  if (segments.length === 0) {
    const fallback = Math.round(Number(chunk?.profileHour ?? end));
    if (Number.isFinite(fallback)) {
      segments.push({ hour: fallback, weight: 1 });
    }
  }
  return segments;
}

function calculateFramIceLiquidRatio(precipRateInHr, wetBulbC, windKt) {
  const rate = Number(precipRateInHr);
  const wetBulb = Number(wetBulbC);
  const wind = Number(windKt);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(wetBulb) || !Number.isFinite(wind)) {
    return Number.NaN;
  }
  const rateForRegression = Math.max(0.02, rate);
  const wetBulbForRegression = Math.max(-7, wetBulb);
  const ilrP = 0.1395 * Math.pow(rateForRegression, -0.541);
  const ilrTw =
    -0.0071 * wetBulbForRegression * wetBulbForRegression * wetBulbForRegression -
    0.1039 * wetBulbForRegression * wetBulbForRegression -
    0.3904 * wetBulbForRegression +
    0.5545;
  const ilrV = 0.0014 * wind * wind + 0.0027 * wind + 0.7574;
  let ilr;
  if (wetBulbForRegression > -0.35) {
    ilr = 0.7 * ilrP + 0.29 * ilrTw + 0.01 * ilrV;
  } else if (wind > 12) {
    ilr = 0.73 * ilrP + 0.01 * ilrTw + 0.26 * ilrV;
  } else {
    ilr = 0.79 * ilrP + 0.2 * ilrTw + 0.01 * ilrV;
  }
  return Number.isFinite(ilr) ? Math.max(0, ilr) : Number.NaN;
}

function buildRunMaxCurrentGrid(values, multiplier, cellCount) {
  if (!values) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const value = Number(values[index]);
    out[index] = Number.isFinite(value) ? Math.max(0, value * multiplier) : Number.NaN;
  }
  return out;
}

function isEffectiveLayerCellActive(decoded, index) {
  return (
    effectiveLayerCandidateActive(decoded?.mlcape, decoded?.mlcin, index) ||
    effectiveLayerCandidateActive(decoded?.sbcape, decoded?.sbcin, index)
  );
}

function effectiveLayerCandidateActive(capeGrid, cinGrid, index) {
  const cape = Number(capeGrid?.[index]);
  const cin = Number(cinGrid?.[index]);
  return (
    Number.isFinite(cape) &&
    cape >= EFFECTIVE_INFLOW_MIN_CAPE_JKG &&
    Number.isFinite(cin) &&
    cin >= EFFECTIVE_INFLOW_MIN_CIN_JKG
  );
}

function buildScpGrid(decoded, effectiveBulkShear, cellCount) {
  const mucape = decoded?.mucape || decoded?.sbcape || decoded?.mlcape;
  const srh = decoded?.srh0to3km;
  if (!mucape || !srh || !effectiveBulkShear) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const capeTerm = Math.max(0, Number(mucape[index])) / 1000;
    const srhTerm = Math.max(0, Number(srh[index])) / 50;
    const shearMs = Math.max(0, Number(effectiveBulkShear[index])) / MPS_TO_KT;
    const shearTerm = shearMs < 10 ? 0 : clamp(shearMs / 20, 0, 1);
    const scp = capeTerm * srhTerm * shearTerm;
    if (Number.isFinite(scp)) {
      out[index] = Math.max(0, scp);
    }
  }
  return out;
}

function buildStpGrid(decoded, lclM, bulkShear0to6km, cellCount) {
  const sbcape = decoded?.sbcape;
  const srh = decoded?.srh0to1km;
  if (!sbcape || !srh || !bulkShear0to6km || !lclM) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const capeTerm = Math.max(0, Number(sbcape[index])) / 1500;
    const shearMs = Math.max(0, Number(bulkShear0to6km[index])) / MPS_TO_KT;
    const shearTerm = shearMs < 12.5 ? 0 : clamp(shearMs / 20, 0, 1.5);
    const srhTerm = Math.max(0, Number(srh[index])) / 150;
    const lclTerm = clamp((2000 - Number(lclM[index])) / 1000, 0, 1);
    const stp = capeTerm * shearTerm * srhTerm * lclTerm;
    if (Number.isFinite(stp)) {
      out[index] = Math.max(0, stp);
    }
  }
  return out;
}

function buildEffectiveLayerScpGrid(decoded, effectiveDiagnostics, cellCount) {
  const mucape = decoded?.mucape || effectiveDiagnostics?.muCapeJkg;
  const esrh = effectiveDiagnostics?.esrh;
  const ebwdKt = effectiveDiagnostics?.ebwdKt;
  if (!mucape || !esrh || !ebwdKt) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const capeTerm = Math.max(0, Number(mucape[index])) / 1000;
    const srhTerm = Math.max(0, Number(esrh[index])) / 50;
    const ebwdMs = Math.max(0, Number(ebwdKt[index])) / MPS_TO_KT;
    const shearTerm = ebwdMs < 10 ? 0 : clamp(ebwdMs / 20, 0, 1);
    const scp = capeTerm * srhTerm * shearTerm;
    if (Number.isFinite(scp)) {
      out[index] = Math.max(0, scp);
    }
  }
  return out;
}

function calculateEffectiveLayerScpValue(decoded, index, effectiveLayer, esrh, ebwdKt) {
  const mucape = decoded?.mucape ? gridValue(decoded.mucape, index) : Number(effectiveLayer?.muCapeJkg);
  const capeTerm = Math.max(0, mucape) / 1000;
  const srhTerm = Math.max(0, Number(esrh)) / 50;
  const ebwdMs = Math.max(0, Number(ebwdKt)) / MPS_TO_KT;
  const shearTerm = ebwdMs < 10 ? 0 : clamp(ebwdMs / 20, 0, 1);
  const scp = capeTerm * srhTerm * shearTerm;
  return Number.isFinite(scp) ? Math.max(0, scp) : Number.NaN;
}

function buildEffectiveLayerStpGrid(decoded, effectiveDiagnostics, cellCount) {
  const mlcape = decoded?.mlcape;
  const mlcin = decoded?.mlcin;
  const baseAglM = effectiveDiagnostics?.baseAglM;
  const esrh = effectiveDiagnostics?.esrh;
  const ebwdKt = effectiveDiagnostics?.ebwdKt;
  const mixedLayerLclM = effectiveDiagnostics?.mixedLayerLclM;
  if (!mlcape || !mlcin || !baseAglM || !esrh || !ebwdKt || !mixedLayerLclM) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    if (Number(baseAglM[index]) > 0) {
      out[index] = 0;
      continue;
    }
    const capeTerm = Math.max(0, Number(mlcape[index])) / 1500;
    const lclTerm = clamp((2000 - Number(mixedLayerLclM[index])) / 1000, 0, 1);
    const srhTerm = Math.max(0, Number(esrh[index])) / 150;
    const ebwdMs = Math.max(0, Number(ebwdKt[index])) / MPS_TO_KT;
    const shearTerm = ebwdMs < 12.5 ? 0 : clamp(ebwdMs / 20, 0, 1.5);
    const cin = Number(mlcin[index]);
    const cinTerm = cin > -50 ? 1 : clamp((cin + 200) / 150, 0, 1);
    const stp = capeTerm * lclTerm * srhTerm * shearTerm * cinTerm;
    if (Number.isFinite(stp)) {
      out[index] = Math.max(0, stp);
    }
  }
  return out;
}

function calculateEffectiveLayerStpValue(decoded, index, esrh, ebwdKt, mixedLayerLclM) {
  const mlcape = gridValue(decoded?.mlcape, index);
  const mlcin = gridValue(decoded?.mlcin, index);
  const capeTerm = Math.max(0, mlcape) / 1500;
  const lclTerm = clamp((2000 - Number(mixedLayerLclM)) / 1000, 0, 1);
  const srhTerm = Math.max(0, Number(esrh)) / 150;
  const ebwdMs = Math.max(0, Number(ebwdKt)) / MPS_TO_KT;
  const shearTerm = ebwdMs < 12.5 ? 0 : clamp(ebwdMs / 20, 0, 1.5);
  const cinTerm = mlcin > -50 ? 1 : clamp((mlcin + 200) / 150, 0, 1);
  const stp = capeTerm * lclTerm * srhTerm * shearTerm * cinTerm;
  return Number.isFinite(stp) ? Math.max(0, stp) : Number.NaN;
}

function calculateReducedProfileDcapeFromSources(sources, index, elevation, surfaceTemp, scratch) {
  if (!Number.isFinite(surfaceTemp) || !scratch?.heights || !scratch?.temps) {
    return Number.NaN;
  }
  const surfaceHeight = Number.isFinite(elevation) ? elevation : 0;
  let sourceLevel = Number.NaN;
  let sourceHeight = Number.NaN;
  let sourceWetBulbK = Number.NaN;
  let sourceThetaE = Number.POSITIVE_INFINITY;
  for (const source of sources) {
    const level = Number(source.level);
    if (!Number.isFinite(level) || level < 500 || level > 800) {
      continue;
    }
    const tempK = gridValue(source.tmp, index);
    const height = gridValue(source.hgt, index);
    const rh = gridValue(source.rh, index);
    if (!Number.isFinite(tempK) || !Number.isFinite(height) || height <= surfaceHeight || !Number.isFinite(rh)) {
      continue;
    }
    const dewpointK = dewpointFromTempRhK(tempK, rh);
    const wetBulbK = wetBulbTemperatureC(tempK, dewpointK) + 273.15;
    const thetaE = boltonThetaE(tempK, dewpointK, level);
    if (!Number.isFinite(wetBulbK) || !Number.isFinite(thetaE) || thetaE >= sourceThetaE) {
      continue;
    }
    sourceLevel = level;
    sourceHeight = height;
    sourceWetBulbK = wetBulbK;
    sourceThetaE = thetaE;
  }
  if (!Number.isFinite(sourceLevel) || !Number.isFinite(sourceHeight) || !Number.isFinite(sourceWetBulbK)) {
    return Number.NaN;
  }

  const rowHeights = scratch.heights;
  const rowTemps = scratch.temps;
  let rowCount = 0;
  rowHeights[rowCount] = surfaceHeight;
  rowTemps[rowCount] = surfaceTemp;
  rowCount += 1;
  for (const source of sources) {
    const level = Number(source.level);
    const height = gridValue(source.hgt, index);
    const tempK = gridValue(source.tmp, index);
    if (
      Number.isFinite(level) &&
      Number.isFinite(height) &&
      Number.isFinite(tempK) &&
      level >= sourceLevel &&
      level <= 1000 &&
      height >= surfaceHeight &&
      height <= sourceHeight
    ) {
      rowHeights[rowCount] = height;
      rowTemps[rowCount] = tempK;
      rowCount += 1;
    }
  }
  sortPairedRowsByHeight(rowHeights, rowTemps, rowCount);

  let energy = 0;
  for (let row = 1; row < rowCount; row += 1) {
    const lowerHeight = rowHeights[row - 1];
    const upperHeight = rowHeights[row];
    const dz = upperHeight - lowerHeight;
    if (!Number.isFinite(dz) || dz <= 1) {
      continue;
    }
    const midHeight = (lowerHeight + upperHeight) / 2;
    const envTemp = (rowTemps[row - 1] + rowTemps[row]) / 2;
    const parcelTemp = sourceWetBulbK + 0.0098 * Math.max(0, sourceHeight - midHeight);
    const buoyancy = (GRAVITY_M_S2 * (envTemp - parcelTemp)) / Math.max(180, envTemp);
    if (Number.isFinite(buoyancy) && buoyancy > 0) {
      energy += buoyancy * dz;
    }
  }
  return Number.isFinite(energy) ? Math.min(4000, energy) : Number.NaN;
}

function sortPairedRowsByHeight(heights, temps, count) {
  for (let index = 1; index < count; index += 1) {
    const height = heights[index];
    const temp = temps[index];
    let cursor = index - 1;
    while (cursor >= 0 && heights[cursor] > height) {
      heights[cursor + 1] = heights[cursor];
      temps[cursor + 1] = temps[cursor];
      cursor -= 1;
    }
    heights[cursor + 1] = height;
    temps[cursor + 1] = temp;
  }
}

function surfaceDewpointK(decoded, index) {
  const direct = gridValue(decoded?.dewpoint2m, index);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const tempK = profileValue(decoded, "TMP", "surface", index);
  const rh = profileValue(decoded, "RH", "surface", index);
  return dewpointFromTempRhK(tempK, rh);
}

function dewpointFromTempRhK(tempK, rhPct) {
  if (!Number.isFinite(tempK) || !Number.isFinite(rhPct) || rhPct <= 0) {
    return Number.NaN;
  }
  const tempC = tempK - 273.15;
  const rh = clamp(Number(rhPct), 1, 100);
  const gamma = Math.log(rh / 100) + (17.625 * tempC) / (243.04 + tempC);
  return 273.15 + (243.04 * gamma) / (17.625 - gamma);
}

function boltonLclTemperatureK(tempK, dewpointK) {
  if (!Number.isFinite(tempK) || !Number.isFinite(dewpointK) || dewpointK <= 0) {
    return Number.NaN;
  }
  return 56 + 1 / (1 / (dewpointK - 56) + Math.log(tempK / dewpointK) / 800);
}

function boltonThetaE(tempK, dewpointK, pressureHpa) {
  const pressure = Number(pressureHpa);
  if (!Number.isFinite(tempK) || !Number.isFinite(dewpointK) || !Number.isFinite(pressure) || pressure <= 100) {
    return Number.NaN;
  }
  const e = vaporPressureHpa(dewpointK);
  if (!Number.isFinite(e) || e <= 0 || e >= pressure) {
    return Number.NaN;
  }
  const mixingRatio = (EPSILON * e) / (pressure - e);
  const lclTemp = boltonLclTemperatureK(tempK, dewpointK);
  if (!Number.isFinite(mixingRatio) || !Number.isFinite(lclTemp)) {
    return Number.NaN;
  }
  const dryTheta = tempK * Math.pow(1000 / (pressure - e), RD_OVER_CP * (1 - 0.28 * mixingRatio));
  return dryTheta * Math.exp((3376 / lclTemp - 2.54) * mixingRatio * (1 + 0.81 * mixingRatio));
}

function vaporPressureHpa(dewpointK) {
  if (!Number.isFinite(dewpointK)) {
    return Number.NaN;
  }
  const dewpointC = dewpointK - 273.15;
  return 6.112 * Math.exp((17.67 * dewpointC) / (dewpointC + 243.5));
}

function surfacePressureHpa(decoded, index) {
  const surfacePressure = gridValue(decoded?.derivedSurfacePressure, index);
  if (Number.isFinite(surfacePressure) && surfacePressure > 1000) {
    return surfacePressure / 100;
  }
  const mslp = gridValue(decoded?.pressureMsl, index);
  if (!Number.isFinite(mslp)) {
    return Number.NaN;
  }
  const mslpHpa = mslp / 100;
  const elevation = profileValue(decoded, "HGT", "surface", index);
  const tempK = profileValue(decoded, "TMP", "surface", index);
  if (!Number.isFinite(elevation) || !Number.isFinite(tempK) || elevation <= 1) {
    return mslpHpa;
  }
  const lapseRate = 0.0065;
  const denominator = tempK + lapseRate * elevation;
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return mslpHpa;
  }
  return mslpHpa * Math.pow(1 - (lapseRate * elevation) / denominator, 5.257);
}

function wetBulbTemperatureC(tempK, dewpointK) {
  if (!Number.isFinite(tempK) || !Number.isFinite(dewpointK)) {
    return Number.NaN;
  }
  const tempC = tempK - 273.15;
  const rh = relativeHumidityFromTempDewpoint(tempK, dewpointK);
  if (!Number.isFinite(rh)) {
    return Number.NaN;
  }
  return (
    tempC * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) +
    Math.atan(tempC + rh) -
    Math.atan(rh - 1.676331) +
    0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) -
    4.686035
  );
}

function relativeHumidityFromTempDewpoint(tempK, dewpointK) {
  const e = vaporPressureHpa(dewpointK);
  const es = vaporPressureHpa(tempK);
  return Number.isFinite(e) && Number.isFinite(es) && es > 0 ? clamp((100 * e) / es, 1, 100) : Number.NaN;
}

function shouldIncludeGrid(values, visibleThreshold) {
  if (!values) {
    return false;
  }
  const hasVisibleThreshold = Number.isFinite(visibleThreshold);
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (!hasVisibleThreshold || value > visibleThreshold) {
      return true;
    }
  }
  return false;
}

function buildGridDistributionStats(values, options = {}) {
  if (!values) {
    return null;
  }
  const finite = [];
  let topClampCount = 0;
  const clampMax = Number(options.clampMax);
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }
    finite.push(value);
    if (Number.isFinite(clampMax) && value >= clampMax) {
      topClampCount += 1;
    }
  }
  if (finite.length === 0) {
    return { finiteCount: 0 };
  }
  finite.sort((left, right) => left - right);
  const percentile = (p) => finite[Math.min(finite.length - 1, Math.max(0, Math.round((finite.length - 1) * p)))];
  return {
    finiteCount: finite.length,
    min: roundTo(percentile(0), 1),
    p50: roundTo(percentile(0.5), 1),
    p90: roundTo(percentile(0.9), 1),
    p99: roundTo(percentile(0.99), 1),
    max: roundTo(finite[finite.length - 1], 1),
    topClampPct: roundTo((100 * topClampCount) / finite.length, 3),
  };
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, Math.max(0, Math.round(decimals || 0)));
  return Number.isFinite(value) ? Math.round(value * factor) / factor : Number.NaN;
}

function snowfallDerivedGridKey(key) {
  return `${SNOWFALL_DERIVED_GRID_KEY_PREFIX}:${key}`;
}

function addVisibleSnowfallGrid(out, key, values) {
  if (shouldIncludeGrid(values)) {
    out[key] = values;
  }
}

function smoothSnowfallPresentationGrids(grids, { modelKey, width, height }) {
  const entries = Object.entries(grids || {});
  if (entries.length === 0) {
    return grids || {};
  }
  const out = {};
  for (const [key, values] of entries) {
    out[key] = smoothSnowfallPresentationGrid(values, { modelKey, width, height });
  }
  return out;
}

function smoothSnowfallPresentationGrid(values, { modelKey, width, height }) {
  const settings = SNOWFALL_PRESENTATION_SMOOTHING_BY_MODEL[String(modelKey || "").toLowerCase()];
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const cellCount = cols * rows;
  if (!settings || !values || values.length !== cellCount || cellCount <= 0) {
    return values;
  }
  const passes = clampInt(settings.passes, 0, 4, 0);
  if (passes <= 0) {
    return values;
  }
  return smoothFiniteNonnegativeGrid(values, cols, rows, passes);
}

function buildFrontogenesisPresentationGrid(values, width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const cellCount = cols * rows;
  if (!values || values.length !== cellCount || cellCount <= 0) {
    return values;
  }
  const positive = new Float32Array(cellCount).fill(Number.NaN);
  let hasPositive = false;
  for (let index = 0; index < cellCount; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }
    const frontogenesis = Math.max(0, value);
    positive[index] = frontogenesis;
    if (frontogenesis > 0) {
      hasPositive = true;
    }
  }
  return hasPositive
    ? smoothFiniteNonnegativeGrid(positive, cols, rows, FRONTOGENESIS_PRESENTATION_SMOOTHING_PASSES)
    : positive;
}

function smoothFiniteNonnegativeGrid(values, width, height, passes) {
  const kernel = SNOWFALL_PRESENTATION_SMOOTHING_KERNEL;
  const radius = Math.floor(kernel.length / 2);
  let current = values;
  for (let pass = 0; pass < passes; pass += 1) {
    const horizontal = new Float32Array(current.length).fill(Number.NaN);
    const out = new Float32Array(current.length).fill(Number.NaN);
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = rowOffset + x;
        if (!Number.isFinite(values[index])) {
          continue;
        }
        horizontal[index] = smoothFiniteKernelSample(current, index, 1, x, width, radius, kernel);
      }
    }
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = rowOffset + x;
        if (!Number.isFinite(values[index])) {
          continue;
        }
        const smoothed = smoothFiniteKernelSample(horizontal, index, width, y, height, radius, kernel);
        out[index] = Number.isFinite(smoothed) ? Math.max(0, smoothed) : Number.NaN;
      }
    }
    current = out;
  }
  return current;
}

function smoothFiniteKernelSample(values, centerIndex, stride, coordinate, limit, radius, kernel) {
  let weighted = 0;
  let weightTotal = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const sampleCoordinate = coordinate + offset;
    if (sampleCoordinate < 0 || sampleCoordinate >= limit) {
      continue;
    }
    const value = Number(values[centerIndex + offset * stride]);
    if (!Number.isFinite(value)) {
      continue;
    }
    const weight = Number(kernel[offset + radius]) || 0;
    weighted += value * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weighted / weightTotal : Number.NaN;
}

function hasGridValueGreaterThan(values, threshold) {
  if (!values) {
    return false;
  }
  const resolvedThreshold = Number.isFinite(Number(threshold)) ? Number(threshold) : 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (Number.isFinite(value) && value > resolvedThreshold) {
      return true;
    }
  }
  return false;
}

function buildSnowLiquidTotalInGrid(decoded, width, height) {
  const cellCount = Number(width) * Number(height);
  if (!Number.isFinite(cellCount) || cellCount <= 0) {
    return null;
  }
  if (decoded?.[SNOW_LIQUID_TOTAL_KEY]?.length === cellCount) {
    return transformGridAffine(decoded[SNOW_LIQUID_TOTAL_KEY], MM_TO_IN, 0, 0);
  }
  return null;
}

function multiplySnowLiquidByRatio(snowLiquidIn, ratio, activeIndices = null) {
  if (!snowLiquidIn) {
    return null;
  }
  const sparse = activeIndices && typeof activeIndices.length === "number";
  const out = new Float32Array(snowLiquidIn.length).fill(sparse ? 0 : Number.NaN);
  const indices = sparse ? activeIndices : null;
  const ratioIsGrid = ratio && typeof ratio.length === "number";
  const fixedRatio = Number(ratio);
  const visitCount = sparse ? indices.length : snowLiquidIn.length;
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = sparse ? indices[visitIndex] : visitIndex;
    const liquid = Number(snowLiquidIn[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= 0) {
      out[index] = 0;
      continue;
    }
    const localRatio = ratioIsGrid ? Number(ratio[index]) : fixedRatio;
    if (!Number.isFinite(localRatio) || localRatio <= 0) {
      out[index] = Number.NaN;
      continue;
    }
    out[index] = liquid * localRatio;
  }
  return out;
}

function addRatioSnowfallToAccumulator({ out, snowLiquidIn, ratio, activeIndices }) {
  const ratioIsGrid = ratio && typeof ratio.length === "number";
  const fixedRatio = Number(ratio);
  const visitCount = activeVisitCount(activeIndices, snowLiquidIn.length);
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = activeVisitIndex(activeIndices, visitIndex);
    if (Number.isNaN(out[index])) {
      continue;
    }
    const liquid = Number(snowLiquidIn[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= 0) {
      continue;
    }
    const localRatio = ratioIsGrid ? Number(ratio[index]) : fixedRatio;
    if (!Number.isFinite(localRatio) || localRatio <= 0) {
      out[index] = Number.NaN;
      continue;
    }
    out[index] += Math.max(0, liquid * localRatio);
  }
}

function buildKucheraSnowfallGrid(decoded, snowLiquidIn, width, height, options = {}) {
  const cellCount = Number(width) * Number(height);
  const sparse = options.activeIndices && typeof options.activeIndices.length === "number";
  const out = new Float32Array(cellCount).fill(sparse ? 0 : Number.NaN);
  const activeIndices = sparse ? options.activeIndices : null;
  const sources = buildKucheraProfileSources(decoded);
  const visitCount = sparse ? activeIndices.length : cellCount;
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = sparse ? activeIndices[visitIndex] : visitIndex;
    const liquid = Number(snowLiquidIn?.[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= 0) {
      out[index] = 0;
      continue;
    }
    const ratio = calculateKucheraRatio(calculateWarmestProfileTempCFromSources(sources, index));
    if (Number.isFinite(ratio) && ratio > 0) {
      out[index] = liquid * ratio;
    } else {
      out[index] = Number.NaN;
    }
  }
  return out;
}

function calculateWarmestProfileTempC(decoded, index) {
  return calculateWarmestProfileTempCFromSources(buildKucheraProfileSources(decoded), index);
}

function buildKucheraProfileSources(decoded) {
  return {
    surfaceHeight: resolveProfileGrid(decoded, "HGT", "surface"),
    surfaceTemp: resolveProfileGrid(decoded, "TMP", "surface"),
    levels: KUCHERA_PROFILE_LEVELS.map((level) => ({
      temp: resolveProfileGrid(decoded, "TMP", level),
      height: resolveProfileGrid(decoded, "HGT", level),
    })),
  };
}

function calculateWarmestProfileTempCFromSources(sources, index) {
  let maxTempC = Number.NEGATIVE_INFINITY;
  const surfaceHeight = gridValue(sources?.surfaceHeight, index);
  for (const level of sources?.levels || []) {
    const tempK = gridValue(level.temp, index);
    const heightM = gridValue(level.height, index);
    if (!Number.isFinite(tempK) || !Number.isFinite(heightM)) {
      continue;
    }
    if (Number.isFinite(surfaceHeight) && heightM <= surfaceHeight) {
      continue;
    }
    maxTempC = Math.max(maxTempC, tempK - 273.15);
  }
  const surfaceTempK = gridValue(sources?.surfaceTemp, index);
  if (Number.isFinite(surfaceTempK)) {
    maxTempC = Math.max(maxTempC, surfaceTempK - 273.15);
  }
  return Number.isFinite(maxTempC) ? maxTempC : Number.NaN;
}

function addKucheraSnowfallToAccumulator({ out, decoded, snowLiquidIn, activeIndices }) {
  const sources = buildKucheraProfileSources(decoded);
  const visitCount = activeVisitCount(activeIndices, snowLiquidIn.length);
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = activeVisitIndex(activeIndices, visitIndex);
    if (Number.isNaN(out[index])) {
      continue;
    }
    const liquid = Number(snowLiquidIn?.[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= 0) {
      continue;
    }
    const ratio = calculateKucheraRatio(calculateWarmestProfileTempCFromSources(sources, index));
    out[index] = Number.isFinite(ratio) && ratio > 0 ? out[index] + liquid * ratio : Number.NaN;
  }
}

function calculateKucheraRatio(maxTempC) {
  if (!Number.isFinite(maxTempC)) {
    return Number.NaN;
  }
  const ratio = maxTempC > -2 ? 12 + 2 * (-2 - maxTempC) : 12 + (-2 - maxTempC);
  return Math.max(3, Math.min(50, ratio));
}

function buildCobbSnowfallGrid(decoded, snowLiquidIn, width, height, options = {}) {
  const cellCount = Number(width) * Number(height);
  const sparse = options.activeIndices && typeof options.activeIndices.length === "number";
  const out = new Float32Array(cellCount).fill(sparse ? 0 : Number.NaN);
  const activeIndices = sparse ? options.activeIndices : null;
  const sources = buildCobbProfileSources(decoded);
  const visitCount = sparse ? activeIndices.length : cellCount;
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = sparse ? activeIndices[visitIndex] : visitIndex;
    const liquid = Number(snowLiquidIn?.[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= 0) {
      out[index] = 0;
      continue;
    }
    const ratio = calculateCobbSlrFromSources(sources, index);
    if (Number.isFinite(ratio) && ratio > 0) {
      out[index] = liquid * ratio;
    } else {
      out[index] = Number.NaN;
    }
  }
  return out;
}

function calculateCobbSlr(decoded, index) {
  return calculateCobbSlrFromSources(buildCobbProfileSources(decoded), index);
}

function buildCobbProfileSources(decoded) {
  return {
    surfaceHeight: resolveProfileGrid(decoded, "HGT", "surface"),
    levels: COBB_PROFILE_LEVELS.map((level) => ({
      level,
      pressurePa: level * 100,
      temp: resolveProfileGrid(decoded, "TMP", level),
      height: resolveProfileGrid(decoded, "HGT", level),
      rh: resolveProfileGrid(decoded, "RH", level),
      omega: resolveProfileGrid(decoded, "VVEL", level),
    })),
  };
}

function calculateCobbSlrFromSources(sources, index) {
  const surfaceHeight = gridValue(sources?.surfaceHeight, index);
  let slrWeightedSum = 0;
  let weightSum = 0;
  for (const level of sources?.levels || []) {
    const tempK = gridValue(level.temp, index);
    const heightM = gridValue(level.height, index);
    const rhPct = gridValue(level.rh, index);
    const omega = gridValue(level.omega, index);
    if (!Number.isFinite(tempK) || !Number.isFinite(heightM) || !Number.isFinite(rhPct) || !Number.isFinite(omega)) {
      continue;
    }
    if (Number.isFinite(surfaceHeight) && heightM <= surfaceHeight) {
      continue;
    }
    const density = level.pressurePa / (287.058 * tempK);
    let wCmSec = -100 * (omega / 9.8 / density);
    if (!Number.isFinite(wCmSec)) {
      continue;
    }
    if (wCmSec < 0) {
      continue;
    }
    const sqrtW = Math.sqrt(Math.max(0, wCmSec));
    const cloudyWeight = rhPct >= 80 ? sqrtW : sqrtW * ((rhPct * rhPct) / 6400);
    if (!Number.isFinite(cloudyWeight) || cloudyWeight <= 0) {
      continue;
    }
    const tempC = tempK - 273.15;
    const layerSlr = calculateCobbLayerSlr(tempC);
    if (!Number.isFinite(layerSlr)) {
      continue;
    }
    slrWeightedSum += layerSlr * cloudyWeight;
    weightSum += cloudyWeight;
  }
  const slr = weightSum > 0 ? slrWeightedSum / weightSum : Number.NaN;
  return Number.isFinite(slr) && slr > 0 && slr <= 50 ? slr : Number.NaN;
}

function addCobbSnowfallToAccumulator({ out, decoded, snowLiquidIn, activeIndices }) {
  const sources = buildCobbProfileSources(decoded);
  const visitCount = activeVisitCount(activeIndices, snowLiquidIn.length);
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = activeVisitIndex(activeIndices, visitIndex);
    if (Number.isNaN(out[index])) {
      continue;
    }
    const liquid = Number(snowLiquidIn?.[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= 0) {
      continue;
    }
    const ratio = calculateCobbSlrFromSources(sources, index);
    out[index] = Number.isFinite(ratio) && ratio > 0 ? out[index] + liquid * ratio : Number.NaN;
  }
}

function calculateCobbLayerSlr(tempC) {
  let total = 0;
  let count = 0;
  for (let offset = 0; offset < 3; offset += 1) {
    const value = calculateCobbLayerSlrAtTemp(tempC + offset);
    if (Number.isFinite(value)) {
      total += value;
      count += 1;
    }
  }
  return count > 0 ? total / count : Number.NaN;
}

function calculateCobbLayerSlrAtTemp(tempC) {
  if (!Number.isFinite(tempC)) {
    return Number.NaN;
  }
  if (tempC < COBB_TTHRESH[0]) {
    return COBB_C1[0];
  }
  if (tempC >= COBB_TTHRESH[COBB_TTHRESH.length - 1]) {
    return tempC > 3 ? 0 : Number.NaN;
  }
  let selected = -1;
  for (let index = 0; index < COBB_TTHRESH.length - 1; index += 1) {
    if (COBB_TTHRESH[index] <= tempC && tempC < COBB_TTHRESH[index + 1]) {
      selected = index;
      break;
    }
  }
  if (selected < 0) {
    return Number.NaN;
  }
  const tdiff = tempC - COBB_TTHRESH[selected];
  return (
    COBB_C1[selected] +
    COBB_C2[selected] * tdiff +
    COBB_C3[selected] * tdiff * tdiff +
    COBB_C4[selected] * tdiff * tdiff * tdiff
  );
}

function profileValue(decoded, variable, level, index) {
  return gridValue(resolveProfileGrid(decoded, variable, level), index);
}

function standardProfileDecodeKey(variable, level) {
  const normalizedLevel = Math.round(Number(level));
  if (!Number.isFinite(normalizedLevel)) {
    return null;
  }
  if (variable === "TMP") {
    return `temp${normalizedLevel}`;
  }
  if (variable === "HGT") {
    return `height${normalizedLevel}`;
  }
  if (variable === "RH") {
    return `rh${normalizedLevel}`;
  }
  if (variable === "UGRD") {
    return `wind${normalizedLevel}U`;
  }
  if (variable === "VGRD") {
    return `wind${normalizedLevel}V`;
  }
  if (variable === "VVEL") {
    return `verticalVelocity${normalizedLevel}`;
  }
  return null;
}

function gridValue(values, index) {
  const value = values ? Number(values[index]) : Number.NaN;
  return Number.isFinite(value) ? value : Number.NaN;
}

function resolveProfileGrid(decoded, variable, level) {
  if (!decoded) {
    return null;
  }
  if (level === "surface") {
    return decoded[PROFILE_SURFACE_DECODE_KEYS[variable]] || null;
  }
  const primary = decoded[profileDecodeKey(variable, level)];
  if (primary) {
    return primary;
  }
  const fallbackKey = standardProfileDecodeKey(variable, level);
  return fallbackKey ? decoded[fallbackKey] || null : null;
}

function buildSnowRfConusSnowfallGrid({ decoded, snowLiquidIn, activeIndices = null, bounds, width, height }) {
  const model = loadSnowRfModel("conus");
  if (!model || !snowLiquidIn) {
    return null;
  }
  const cellCount = Number(width) * Number(height);
  const sparse = activeIndices && typeof activeIndices.length === "number";
  const out = new Float32Array(cellCount).fill(sparse ? 0 : Number.NaN);
  const visitCount = sparse ? activeIndices.length : cellCount;
  const featureScratch = createSnowFeatureScratch(PLETCHER_RF_FEATURE_KEYS.length, ["SPD", "TMP", "RH"]);
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = sparse ? activeIndices[visitIndex] : visitIndex;
    const liquid = Number(snowLiquidIn[index]);
    if (!Number.isFinite(liquid) || liquid <= MIN_VISIBLE_SNOW_LIQUID_IN) {
      out[index] = Number.isFinite(liquid) ? 0 : Number.NaN;
      continue;
    }
    const features = buildPletcherRfFeatures({ decoded, index, bounds, width, height, scratch: featureScratch });
    if (!features) {
      out[index] = Number.NaN;
      continue;
    }
    const slr = predictRandomForest(model, features);
    if (Number.isFinite(slr) && slr > 0) {
      out[index] = liquid * Math.min(MAX_SNOW_TO_LIQUID_RATIO, Math.max(1, slr));
    }
  }
  return out;
}

function addSnowRfConusSnowfallToAccumulator({ out, decoded, snowLiquidIn, activeIndices, bounds, width, height }) {
  const model = loadSnowRfModel("conus");
  if (!model || !snowLiquidIn) {
    return false;
  }
  const visitCount = activeVisitCount(activeIndices, snowLiquidIn.length);
  const featureScratch = createSnowFeatureScratch(PLETCHER_RF_FEATURE_KEYS.length, ["SPD", "TMP", "RH"]);
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = activeVisitIndex(activeIndices, visitIndex);
    if (Number.isNaN(out[index])) {
      continue;
    }
    const liquid = Number(snowLiquidIn[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= MIN_VISIBLE_SNOW_LIQUID_IN) {
      continue;
    }
    const features = buildPletcherRfFeatures({ decoded, index, bounds, width, height, scratch: featureScratch });
    if (!features) {
      out[index] = Number.NaN;
      continue;
    }
    const slr = predictRandomForest(model, features);
    out[index] =
      Number.isFinite(slr) && slr > 0
        ? out[index] + liquid * Math.min(MAX_SNOW_TO_LIQUID_RATIO, Math.max(1, slr))
        : Number.NaN;
  }
  return true;
}

function buildWesternLinearSnowfallGrid({ decoded, snowLiquidIn, activeIndices = null, bounds, width, height }) {
  const model = loadWesternLinearSlrModel();
  if (!model || !snowLiquidIn) {
    return null;
  }
  const cellCount = Number(width) * Number(height);
  const sparse = activeIndices && typeof activeIndices.length === "number";
  const out = new Float32Array(cellCount).fill(sparse ? 0 : Number.NaN);
  const visitCount = sparse ? activeIndices.length : cellCount;
  const featureScratch = createSnowFeatureScratch(WESTERN_LINEAR_FEATURE_KEYS.length, ["TMP", "SPD"]);
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = sparse ? activeIndices[visitIndex] : visitIndex;
    const liquid = Number(snowLiquidIn[index]);
    if (!Number.isFinite(liquid) || liquid <= MIN_VISIBLE_SNOW_LIQUID_IN) {
      out[index] = Number.isFinite(liquid) ? 0 : Number.NaN;
      continue;
    }
    const features = buildWesternLinearFeatures({ decoded, index, bounds, width, height, scratch: featureScratch });
    if (!features) {
      out[index] = Number.NaN;
      continue;
    }
    const slr = predictLinearSlr(model, features);
    if (Number.isFinite(slr) && slr > 0) {
      out[index] = liquid * Math.min(MAX_SNOW_TO_LIQUID_RATIO, Math.max(1, slr));
    }
  }
  return out;
}

function addWesternLinearSnowfallToAccumulator({ out, decoded, snowLiquidIn, activeIndices, bounds, width, height }) {
  const model = loadWesternLinearSlrModel();
  if (!model || !snowLiquidIn) {
    return false;
  }
  const visitCount = activeVisitCount(activeIndices, snowLiquidIn.length);
  const featureScratch = createSnowFeatureScratch(WESTERN_LINEAR_FEATURE_KEYS.length, ["TMP", "SPD"]);
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = activeVisitIndex(activeIndices, visitIndex);
    if (Number.isNaN(out[index])) {
      continue;
    }
    const liquid = Number(snowLiquidIn[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= MIN_VISIBLE_SNOW_LIQUID_IN) {
      continue;
    }
    const features = buildWesternLinearFeatures({ decoded, index, bounds, width, height, scratch: featureScratch });
    if (!features) {
      out[index] = Number.NaN;
      continue;
    }
    const slr = predictLinearSlr(model, features);
    out[index] =
      Number.isFinite(slr) && slr > 0
        ? out[index] + liquid * Math.min(MAX_SNOW_TO_LIQUID_RATIO, Math.max(1, slr))
        : Number.NaN;
  }
  return true;
}

function buildPletcherRfFeatures({ decoded, index, bounds, width, height, scratch = null }) {
  const elevation = profileValue(decoded, "HGT", "surface", index);
  if (!Number.isFinite(elevation)) {
    return null;
  }
  const profile = buildAglProfileColumns(decoded, index, elevation, ["SPD", "TMP", "RH"], {
    scratch: scratch?.profile,
  });
  if (!profile) {
    return null;
  }
  const features =
    Array.isArray(scratch?.features) && scratch.features.length === PLETCHER_RF_FEATURE_KEYS.length
      ? scratch.features
      : new Array(PLETCHER_RF_FEATURE_KEYS.length);
  let featureIndex = 0;
  for (const agl of PLETCHER_RF_AGL_LEVELS) {
    features[featureIndex] = interpolateAglProfileColumn(profile, "SPD", agl, elevation);
    featureIndex += 1;
  }
  for (const agl of PLETCHER_RF_AGL_LEVELS) {
    features[featureIndex] = interpolateAglProfileColumn(profile, "TMP", agl, elevation);
    featureIndex += 1;
  }
  for (const agl of PLETCHER_RF_AGL_LEVELS) {
    features[featureIndex] = interpolateAglProfileColumn(profile, "RH", agl, elevation);
    featureIndex += 1;
  }
  const latLon = latLonForGridIndex(index, bounds, width, height);
  features[featureIndex] = elevation;
  features[featureIndex + 1] = latLon.lat;
  features[featureIndex + 2] = latLon.lon;
  return features.every(Number.isFinite) ? features : null;
}

function buildWesternLinearFeatures({ decoded, index, bounds, width, height, scratch = null }) {
  const elevation = profileValue(decoded, "HGT", "surface", index);
  const latLon = latLonForGridIndex(index, bounds, width, height);
  if (!isWesternLinearEligiblePixel({ elevation, latLon })) {
    return null;
  }
  const profile = buildAglProfileColumns(decoded, index, elevation, ["TMP", "SPD"], {
    scratch: scratch?.profile,
  });
  if (!profile) {
    return null;
  }
  const features =
    Array.isArray(scratch?.features) && scratch.features.length === WESTERN_LINEAR_FEATURE_KEYS.length
      ? scratch.features
      : new Array(WESTERN_LINEAR_FEATURE_KEYS.length);
  features[0] = interpolateAglProfileColumn(profile, "TMP", 400, elevation);
  features[1] = interpolateAglProfileColumn(profile, "TMP", 2400, elevation);
  features[2] = interpolateAglProfileColumn(profile, "SPD", 400, elevation);
  features[3] = interpolateAglProfileColumn(profile, "SPD", 2400, elevation);
  return features.every(Number.isFinite) ? features : null;
}

function isWesternLinearEligiblePixel({ elevation, latLon }) {
  return (
    Number.isFinite(elevation) &&
    elevation >= WESTERN_LINEAR_MIN_ELEVATION_M &&
    Number.isFinite(latLon?.lon) &&
    latLon.lon <= WESTERN_LINEAR_WEST_OF_LON
  );
}

function buildAglProfileColumns(decoded, index, elevation, variables, options = {}) {
  if (!Number.isFinite(elevation)) {
    return null;
  }
  const wanted = Array.from(new Set(Array.isArray(variables) ? variables : []));
  const profileLevels =
    Array.isArray(options.levels) && options.levels.length > 0 ? options.levels : SNOW_PROFILE_LEVELS;
  const profile = resolveAglProfileScratch(options.scratch, wanted, profileLevels.length + 1);
  profile.count = 0;

  const surfaceValues =
    profile.values instanceof Float64Array && profile.values.length >= wanted.length
      ? profile.values
      : new Array(wanted.length);
  let hasSurfaceValue = false;
  for (let wantedIndex = 0; wantedIndex < wanted.length; wantedIndex += 1) {
    const value = profileColumnValue(decoded, wanted[wantedIndex], "surface", index);
    surfaceValues[wantedIndex] = value;
    hasSurfaceValue = hasSurfaceValue || Number.isFinite(value);
  }
  if (hasSurfaceValue) {
    appendAglProfileRow(profile, wanted, elevation, surfaceValues);
  }

  for (const level of profileLevels) {
    const heightM = profileValue(decoded, "HGT", level, index);
    if (!Number.isFinite(heightM) || heightM <= elevation) {
      continue;
    }
    const values = surfaceValues;
    for (let wantedIndex = 0; wantedIndex < wanted.length; wantedIndex += 1) {
      values[wantedIndex] = profileColumnValue(decoded, wanted[wantedIndex], level, index);
    }
    appendAglProfileRow(profile, wanted, heightM, values);
  }
  if (profile.count === 0) {
    return null;
  }
  return profile;
}

function appendAglProfileRow(profile, wanted, height, values) {
  const row = profile.count;
  if (row >= profile.heights.length) {
    return;
  }
  profile.heights[row] = height;
  for (let wantedIndex = 0; wantedIndex < wanted.length; wantedIndex += 1) {
    profile[wanted[wantedIndex]][row] = Number(values[wantedIndex]);
  }
  profile.count = row + 1;
}

function createSnowFeatureScratch(featureCount, variables) {
  return {
    features: new Array(Math.max(0, Math.round(Number(featureCount) || 0))),
    profile: createAglProfileScratch(variables),
  };
}

function createAglProfileScratch(variables, size = SNOW_PROFILE_LEVELS.length + 1) {
  const wanted = Array.from(new Set(Array.isArray(variables) ? variables : []));
  const count = Math.max(1, Math.round(Number(size) || SNOW_PROFILE_LEVELS.length + 1));
  const scratch = {
    heights: new Float64Array(count),
    values: new Float64Array(Math.max(1, wanted.length)),
    count: 0,
  };
  for (const variable of wanted) {
    scratch[variable] = new Float64Array(count);
  }
  return scratch;
}

function resolveAglProfileScratch(candidate, variables, size) {
  const wanted = Array.from(new Set(Array.isArray(variables) ? variables : []));
  const count = Math.max(1, Math.round(Number(size) || SNOW_PROFILE_LEVELS.length + 1));
  const hasUsableScratch =
    candidate &&
    candidate.heights instanceof Float64Array &&
    candidate.heights.length >= count &&
    candidate.values instanceof Float64Array &&
    candidate.values.length >= wanted.length &&
    wanted.every((variable) => candidate[variable] instanceof Float64Array && candidate[variable].length >= count);
  if (hasUsableScratch) {
    return candidate;
  }
  return createAglProfileScratch(wanted, count);
}

function profileColumnValue(decoded, variable, level, index) {
  if (variable === "SPD") {
    return profileSpeedAtLevel(decoded, level, index);
  }
  if (variable === "UGRD" || variable === "VGRD" || variable === "TMP" || variable === "RH") {
    return profileValue(decoded, variable, level, index);
  }
  return Number.NaN;
}

function interpolateAglProfileColumn(profile, variable, aglMeters, elevation) {
  const heights = profile?.heights;
  const values = profile?.[variable];
  const heightsUsable = Array.isArray(heights) || ArrayBuffer.isView(heights);
  const valuesUsable = Array.isArray(values) || ArrayBuffer.isView(values);
  if (!profile || !heightsUsable || !valuesUsable) {
    return Number.NaN;
  }
  const count = Math.min(
    Number.isFinite(Number(profile.count)) ? Math.max(0, Math.round(Number(profile.count))) : heights.length,
    heights.length,
    values.length,
  );
  const targetHeight = elevation + aglMeters;
  let lowerHeight = Number.NaN;
  let lowerValue = Number.NaN;
  for (let index = 0; index < count; index += 1) {
    const currentHeight = Number(heights[index]);
    const currentValue = Number(values[index]);
    if (!Number.isFinite(currentHeight) || !Number.isFinite(currentValue)) {
      continue;
    }
    if (currentHeight === targetHeight) {
      return currentValue;
    }
    if (currentHeight < targetHeight) {
      lowerHeight = currentHeight;
      lowerValue = currentValue;
      continue;
    }
    if (!Number.isFinite(lowerHeight) || !Number.isFinite(lowerValue)) {
      return Number.NaN;
    }
    const t = (targetHeight - lowerHeight) / Math.max(1e-9, currentHeight - lowerHeight);
    return lowerValue + (currentValue - lowerValue) * Math.max(0, Math.min(1, t));
  }
  return Number.NaN;
}

function profileSpeedAtLevel(decoded, level, index) {
  const u = profileValue(decoded, "UGRD", level, index);
  const v = profileValue(decoded, "VGRD", level, index);
  return Number.isFinite(u) && Number.isFinite(v) ? Math.hypot(u, v) : Number.NaN;
}

function latLonForGridIndex(index, bounds, width, height) {
  const cols = Math.max(1, Math.round(Number(width) || 1));
  const rows = Math.max(1, Math.round(Number(height) || 1));
  const x = index % cols;
  const y = Math.floor(index / cols);
  const west = Number(bounds?.west);
  const east = Number(bounds?.east);
  const lon =
    Number.isFinite(west) && Number.isFinite(east) ? west + (x / Math.max(1, cols - 1)) * (east - west) : Number.NaN;
  return {
    lat: bounds ? rowToLatMercator(y, rows, bounds) : Number.NaN,
    lon,
  };
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
  return path.resolve(__dirname, "../../tools/noaa-beta", artifactRequired);
}

function resolveSnowRfArtifactPath(kind) {
  if (kind === "conus" && process.env.MODELVIEW_SNOW_RF_CONUS_PATH) {
    return process.env.MODELVIEW_SNOW_RF_CONUS_PATH;
  }
  return path.resolve(__dirname, "../../tools/noaa-beta/snow-rf/conus-rf.json");
}

function resolveWesternLinearArtifactPath() {
  if (process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH) {
    return process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH;
  }
  return path.resolve(__dirname, "../../tools/noaa-beta/snow-rf/western-linear-v1c.json");
}

function loadSnowRfModel(kind) {
  const artifactPath = resolveSnowRfArtifactPath(kind);
  const cacheKey = snowModelCacheKey(artifactPath);
  if (SNOW_RF_MODEL_CACHE.has(cacheKey)) {
    return SNOW_RF_MODEL_CACHE.get(cacheKey);
  }
  try {
    const model = normalizeSnowRfModel(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
    SNOW_RF_MODEL_CACHE.set(cacheKey, model);
    return model;
  } catch {
    SNOW_RF_MODEL_CACHE.set(cacheKey, null);
    return null;
  }
}

function loadWesternLinearSlrModel() {
  const artifactPath = resolveWesternLinearArtifactPath();
  const cacheKey = snowModelCacheKey(artifactPath);
  if (SNOW_RF_MODEL_CACHE.has(cacheKey)) {
    return SNOW_RF_MODEL_CACHE.get(cacheKey);
  }
  try {
    const model = normalizeWesternLinearSlrModel(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
    SNOW_RF_MODEL_CACHE.set(cacheKey, model);
    return model;
  } catch {
    SNOW_RF_MODEL_CACHE.set(cacheKey, null);
    return null;
  }
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
  return { featureKeys, coefficients, intercept };
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
  return { childrenLeft, childrenRight, feature, threshold, value };
}

function numericArray(values) {
  const source = Array.isArray(values) || ArrayBuffer.isView(values) ? Array.from(values) : [];
  return source
    .map((value) => (Array.isArray(value) ? Number(value.flat(Infinity)[0]) : Number(value)))
    .filter((value) => Number.isFinite(value));
}

function predictRandomForest(model, features) {
  if (!model?.trees?.length || !Array.isArray(features)) {
    return Number.NaN;
  }
  let total = 0;
  let count = 0;
  for (const tree of model.trees) {
    const value = predictRfTree(tree, features);
    if (Number.isFinite(value)) {
      total += value;
      count += 1;
    }
  }
  return count > 0 ? total / count : Number.NaN;
}

function predictLinearSlr(model, features) {
  if (!model?.coefficients?.length || !Array.isArray(features)) {
    return Number.NaN;
  }
  let value = Number(model.intercept);
  if (!Number.isFinite(value) || features.length !== model.coefficients.length) {
    return Number.NaN;
  }
  for (let index = 0; index < model.coefficients.length; index += 1) {
    const feature = Number(features[index]);
    const coefficient = Number(model.coefficients[index]);
    if (!Number.isFinite(feature) || !Number.isFinite(coefficient)) {
      return Number.NaN;
    }
    value += coefficient * feature;
  }
  return value;
}

function predictRfTree(tree, features) {
  let node = 0;
  for (let depth = 0; depth < 4096; depth += 1) {
    const left = tree.childrenLeft[node];
    const right = tree.childrenRight[node];
    if (left < 0 || right < 0) {
      return tree.value[node];
    }
    const featureIndex = tree.feature[node];
    const featureValue = features[featureIndex];
    if (!Number.isFinite(featureValue)) {
      return Number.NaN;
    }
    node = featureValue <= tree.threshold[node] ? left : right;
    if (!Number.isInteger(node) || node < 0 || node >= tree.value.length) {
      return Number.NaN;
    }
  }
  return Number.NaN;
}

function buildThicknessGrid(height500, height1000) {
  if (!height500 || !height1000 || height500.length !== height1000.length) {
    return null;
  }
  const out = new Float32Array(height500.length).fill(Number.NaN);
  for (let index = 0; index < out.length; index += 1) {
    const z500 = Number(height500[index]);
    const z1000 = Number(height1000[index]);
    if (z500 === z500 && z1000 === z1000) {
      out[index] = (z500 - z1000) / 10;
    }
  }
  return out;
}

function renderCatalogParameterLayer({ entry, decoded, selection, width, height, getWindSpeedGrid = null }) {
  if (!entry || !decoded) {
    return null;
  }
  const renderOptions = getCatalogRenderOptions(entry);
  if (entry.kind === "wind") {
    const values = typeof getWindSpeedGrid === "function" ? getWindSpeedGrid(entry) : null;
    if (values) {
      return renderScalarGrid({
        values,
        width,
        height,
        ...renderOptions,
      });
    }
    return renderWindSpeedLayer({
      uValues: decoded[entry.uKey],
      vValues: decoded[entry.vKey],
      multiplier: entry.transform === "windMph" ? MPS_TO_MPH : MPS_TO_KT,
      width,
      height,
      ...renderOptions,
    });
  }
  if (entry.kind === "heightContour") {
    return null;
  }
  const source = resolveCatalogSourceGrid(entry, decoded, width, height);
  if (!source) {
    return null;
  }
  const values = resolveCatalogPresentationGrid(entry, source, width, height);
  const transformOptions = resolveCatalogTransformOptions(entry, selection);
  return renderScalarGrid({
    values,
    width,
    height,
    ...transformOptions,
    ...renderOptions,
  });
}

function resolveCatalogSourceGrid(entry, decoded, width, height) {
  const source = decoded?.[entry?.inputKey];
  if (!source) {
    return null;
  }
  if (entry?.key === "cloudCeiling") {
    return buildAglHeightMetersGrid(source, decoded?.profileSurfaceHeight, width, height);
  }
  return source;
}

function buildAglHeightMetersGrid(heightMslMeters, surfaceHeightMeters, width, height) {
  const cellCount = Math.round(Number(width) * Number(height));
  if (
    !Number.isFinite(cellCount) ||
    cellCount <= 0 ||
    !heightMslMeters ||
    !surfaceHeightMeters ||
    heightMslMeters.length !== cellCount ||
    surfaceHeightMeters.length !== cellCount
  ) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const heightMsl = Number(heightMslMeters[index]);
    const surfaceHeight = Number(surfaceHeightMeters[index]);
    if (Number.isFinite(heightMsl) && Number.isFinite(surfaceHeight)) {
      out[index] = Math.max(0, heightMsl - surfaceHeight);
    }
  }
  return out;
}

function resolveCatalogPresentationGrid(entry, values, width, height) {
  if (entry?.key === "frontogenesis850" || entry?.key === "frontogenesis700") {
    return buildFrontogenesisPresentationGrid(values, width, height);
  }
  return values;
}

function resolveCachedWindSpeedGrid({ entry, decoded, cache }) {
  const key = entry?.key;
  if (!key) {
    return null;
  }
  if (cache?.has(key)) {
    return cache.get(key);
  }
  const values = buildWindSpeedGrid(
    decoded?.[entry.uKey],
    decoded?.[entry.vKey],
    entry.transform === "windMph" ? MPS_TO_MPH : MPS_TO_KT,
  );
  cache?.set(key, values);
  return values;
}

function resolveCachedHeightDamGrid({ entry, decoded, cache }) {
  const key = entry?.key;
  if (!key) {
    return null;
  }
  if (cache?.has(key)) {
    return cache.get(key);
  }
  const source = decoded?.[entry.inputKey];
  const values = source ? transformGridAffine(source, 0.1) : null;
  cache?.set(key, values);
  return values;
}

function renderHeightContourLayer({ entry, values, bounds, modelKey, width, height }) {
  if (!entry || !values) {
    return null;
  }
  const rendered = renderHeightContourArtifacts({
    heightGrid: gridPayload(values, width, height),
    targetBounds: bounds,
    width,
    height,
    modelKey,
    levelMb: entry.contourLevelMb,
    intervalDam: entry.contourIntervalDam,
    detailMode: "simple",
    style: SYNOPTIC_STYLE,
  });
  return rendered?.vector ? rendered : null;
}

function resolveCatalogTransformOptions(entry, selection) {
  if (!entry || !entry.transform || entry.transform === "identity") {
    return {};
  }
  if (entry.transform === "precipRate") {
    const divisor = parseAccumulationHours(selection?.records?.[entry.inputKey]) || 1;
    return {
      transformScale: 1 / divisor,
      transformMin: 0,
    };
  }
  const affine = resolveCatalogAffineTransform(entry.transform);
  if (affine) {
    return affine;
  }
  return {
    transformValue: (value) => applyCatalogTransform(value, entry.transform),
  };
}

function applyCatalogTransform(value, transform) {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  if (transform === "kelvinToFahrenheit") {
    return kelvinToFahrenheit(value);
  }
  if (transform === "kelvinToCelsius") {
    return kelvinToCelsius(value);
  }
  if (transform === "pascalToHpa") {
    return pascalToHpa(value);
  }
  if (transform === "kgKgToGkg") {
    return value * 1000;
  }
  if (transform === "metersToMiles") {
    return value / 1609.344;
  }
  if (transform === "metersToFeet") {
    return value * 3.28084;
  }
  if (transform === "metersToDam") {
    return value * 0.1;
  }
  if (transform === "metersToInches") {
    return value * 39.3701;
  }
  if (transform === "kgM2ToWaterInches") {
    return value / 25.4;
  }
  if (transform === "absoluteVorticity1e5") {
    return value * 100000;
  }
  if (transform === "paSToDPaS") {
    return value * 10;
  }
  if (transform === "metersPerSecondToKnots") {
    return value * MPS_TO_KT;
  }
  if (transform === "metersPerSecondToMph") {
    return value * MPS_TO_MPH;
  }
  return value;
}

function resolveCatalogAffineTransform(transform) {
  if (transform === "kelvinToFahrenheit") {
    return {
      transformScale: 9 / 5,
      transformOffset: -459.67,
    };
  }
  if (transform === "kelvinToCelsius") {
    return {
      transformOffset: -273.15,
    };
  }
  if (transform === "pascalToHpa") {
    return {
      transformScale: 0.01,
    };
  }
  if (transform === "kgKgToGkg") {
    return {
      transformScale: 1000,
    };
  }
  if (transform === "metersToMiles") {
    return {
      transformScale: 1 / 1609.344,
    };
  }
  if (transform === "metersToFeet") {
    return {
      transformScale: 3.28084,
    };
  }
  if (transform === "metersToDam") {
    return {
      transformScale: 0.1,
    };
  }
  if (transform === "metersToInches") {
    return {
      transformScale: 39.3701,
    };
  }
  if (transform === "kgM2ToWaterInches") {
    return {
      transformScale: 1 / 25.4,
    };
  }
  if (transform === "absoluteVorticity1e5") {
    return {
      transformScale: 100000,
    };
  }
  if (transform === "paSToDPaS") {
    return {
      transformScale: 10,
    };
  }
  if (transform === "metersPerSecondToKnots") {
    return {
      transformScale: MPS_TO_KT,
    };
  }
  if (transform === "metersPerSecondToMph") {
    return {
      transformScale: MPS_TO_MPH,
    };
  }
  return null;
}

function resolveCatalogTransformValue(entry, selection) {
  if (!entry || !entry.transform || entry.transform === "identity") {
    return null;
  }
  if (entry.transform === "precipRate") {
    const divisor = parseAccumulationHours(selection.records?.[entry.inputKey]) || 1;
    return (value) => (Number.isFinite(value) ? Math.max(0, value) / divisor : Number.NaN);
  }
  if (entry.transform === "kelvinToFahrenheit") {
    return kelvinToFahrenheit;
  }
  if (entry.transform === "kelvinToCelsius") {
    return kelvinToCelsius;
  }
  if (entry.transform === "pascalToHpa") {
    return pascalToHpa;
  }
  if (entry.transform === "kgKgToGkg") {
    return (value) => (Number.isFinite(value) ? value * 1000 : Number.NaN);
  }
  if (entry.transform === "metersToMiles") {
    return (value) => (Number.isFinite(value) ? value / 1609.344 : Number.NaN);
  }
  if (entry.transform === "metersToFeet") {
    return (value) => (Number.isFinite(value) ? value * 3.28084 : Number.NaN);
  }
  if (entry.transform === "metersToInches") {
    return (value) => (Number.isFinite(value) ? value * 39.3701 : Number.NaN);
  }
  if (entry.transform === "kgM2ToWaterInches") {
    return (value) => (Number.isFinite(value) ? value / 25.4 : Number.NaN);
  }
  if (entry.transform === "absoluteVorticity1e5") {
    return (value) => (Number.isFinite(value) ? value * 100000 : Number.NaN);
  }
  if (entry.transform === "paSToDPaS") {
    return (value) => (Number.isFinite(value) ? value * 10 : Number.NaN);
  }
  if (entry.transform === "metersPerSecondToKnots") {
    return (value) => (Number.isFinite(value) ? value * MPS_TO_KT : Number.NaN);
  }
  if (entry.transform === "metersPerSecondToMph") {
    return (value) => (Number.isFinite(value) ? value * MPS_TO_MPH : Number.NaN);
  }
  return (value) => applyCatalogTransform(value, entry.transform);
}

function resolveCatalogScale(entry) {
  return (
    NOAA_RENDER_SCALES[entry?.scale] || {
      min: 0,
      max: 1,
      alpha: 0.82,
      legendStops: [
        [0, [40, 90, 140]],
        [1, [220, 80, 80]],
      ],
    }
  );
}

function getCatalogRenderOptions(entry) {
  return CATALOG_RENDER_OPTIONS.get(entry?.key) || buildCatalogRenderOptions(entry);
}

function buildCatalogRenderOptions(entry) {
  const scale = resolveCatalogScale(entry);
  const alpha = Number.isFinite(scale.alpha) ? Number(scale.alpha) : 0.82;
  const colorLookup =
    scale?.lookup === "step" && Array.isArray(scale.valueStops)
      ? createStepColorLookup(scale.valueStops, alpha)
      : createContinuousColorLookup({
          stops: normalizeColorStops(resolveCatalogStops(entry, scale), REFLECTIVITY_STOPS),
          min: scale?.min ?? 0,
          max: scale?.max ?? 1,
          log: Boolean(scale?.log),
          alpha,
          size: scale?.lookupSize,
        });
  return Object.freeze({
    colorLookup,
    minVisible: Number.isFinite(scale.minVisible) ? Number(scale.minVisible) : null,
    maxVisible: Number.isFinite(scale.maxVisible) ? Number(scale.maxVisible) : null,
    visibleRange: Array.isArray(scale.visibleRange) ? scale.visibleRange : null,
  });
}

function resolveCatalogStops(entry, scale) {
  return scale.legendStops || [];
}

function gridPayload(values, cols, rows) {
  return values ? { values, cols, rows } : null;
}

function buildSynopticDetailGridPayload(values, width, height) {
  if (!values) {
    return null;
  }
  const sourceCols = Math.max(0, Math.round(Number(width) || 0));
  const sourceRows = Math.max(0, Math.round(Number(height) || 0));
  if (sourceCols < 2 || sourceRows < 2 || values.length < sourceCols * sourceRows) {
    return gridPayload(values, width, height);
  }
  const scale = Math.min(1, SYNOPTIC_DETAILED_MAX_COLS / sourceCols, SYNOPTIC_DETAILED_MAX_ROWS / sourceRows);
  const targetCols = Math.max(2, Math.round(sourceCols * scale));
  const targetRows = Math.max(2, Math.round(sourceRows * scale));
  if (targetCols === sourceCols && targetRows === sourceRows) {
    return gridPayload(values, sourceCols, sourceRows);
  }
  return {
    values: resampleGridBilinear(values, sourceCols, sourceRows, targetCols, targetRows),
    cols: targetCols,
    rows: targetRows,
  };
}

function resampleGridBilinear(values, sourceCols, sourceRows, targetCols, targetRows) {
  const out = new Float32Array(targetCols * targetRows).fill(Number.NaN);
  for (let y = 0; y < targetRows; y += 1) {
    const gy = (y / Math.max(1, targetRows - 1)) * (sourceRows - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(sourceRows - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < targetCols; x += 1) {
      const gx = (x / Math.max(1, targetCols - 1)) * (sourceCols - 1);
      const x0 = Math.floor(gx);
      const x1 = Math.min(sourceCols - 1, x0 + 1);
      const tx = gx - x0;
      out[y * targetCols + x] = sampleGridBilinear(values, sourceCols, x0, x1, y0, y1, tx, ty);
    }
  }
  return out;
}

function sampleGridBilinear(values, cols, x0, x1, y0, y1, tx, ty) {
  const i00 = y0 * cols + x0;
  const i10 = y0 * cols + x1;
  const i01 = y1 * cols + x0;
  const i11 = y1 * cols + x1;
  const v00 = Number(values[i00]);
  const v10 = Number(values[i10]);
  const v01 = Number(values[i01]);
  const v11 = Number(values[i11]);
  if (!Number.isFinite(v00) || !Number.isFinite(v10) || !Number.isFinite(v01) || !Number.isFinite(v11)) {
    return Number.NaN;
  }
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

function createEmptySynopticVectorPayload() {
  return {
    styleVersion: SYNOPTIC_STYLE_VERSION,
    isobars: { lines: [], labels: [] },
    thickness: { lines: [], labels: [] },
    centers: { highs: [], lows: [] },
  };
}

function interpolateStops(stops, position) {
  if (!Array.isArray(stops) || stops.length === 0) {
    return null;
  }
  const t = clamp01(position);
  const samePositionEpsilon = 1e-12;
  if (t <= stops[0][0]) {
    let lastAtStart = 0;
    while (
      lastAtStart + 1 < stops.length &&
      Math.abs(Number(stops[lastAtStart + 1][0]) - Number(stops[0][0])) <= samePositionEpsilon
    ) {
      lastAtStart += 1;
    }
    if (lastAtStart > 0) {
      return stops[lastAtStart][1];
    }
    return stops[0][1];
  }
  for (let index = 1; index < stops.length; index += 1) {
    const [rightPosition, rightColor] = stops[index];
    const [leftPosition, leftColor] = stops[index - 1];
    if (t <= rightPosition) {
      if (Math.abs(t - rightPosition) <= samePositionEpsilon) {
        let lastAtPosition = index;
        while (
          lastAtPosition + 1 < stops.length &&
          Math.abs(Number(stops[lastAtPosition + 1][0]) - Number(rightPosition)) <= samePositionEpsilon
        ) {
          lastAtPosition += 1;
        }
        return stops[lastAtPosition][1];
      }
      const span = Math.max(1e-9, rightPosition - leftPosition);
      const local = (t - leftPosition) / span;
      return interpolateRgbaColors(leftColor, rightColor, local);
    }
  }
  return stops[stops.length - 1][1];
}

function interpolateRgbaColors(leftColor, rightColor, local) {
  const leftAlpha = Number.isFinite(leftColor?.[3]) ? clamp01(leftColor[3]) : 1;
  const rightAlpha = Number.isFinite(rightColor?.[3]) ? clamp01(rightColor[3]) : 1;
  const alpha = lerp(leftAlpha, rightAlpha, local);
  if (alpha <= 1e-9) {
    const source = local < 0.5 ? leftColor : rightColor;
    return [clampInt(source?.[0], 0, 255, 0), clampInt(source?.[1], 0, 255, 0), clampInt(source?.[2], 0, 255, 0), 0];
  }
  return [
    clampInt(lerpPremultipliedChannel(leftColor, leftAlpha, rightColor, rightAlpha, local, 0, alpha), 0, 255, 0),
    clampInt(lerpPremultipliedChannel(leftColor, leftAlpha, rightColor, rightAlpha, local, 1, alpha), 0, 255, 0),
    clampInt(lerpPremultipliedChannel(leftColor, leftAlpha, rightColor, rightAlpha, local, 2, alpha), 0, 255, 0),
    alpha,
  ];
}

function lerpPremultipliedChannel(leftColor, leftAlpha, rightColor, rightAlpha, local, channel, alpha) {
  const left = clampInt(leftColor?.[channel], 0, 255, 0) * leftAlpha;
  const right = clampInt(rightColor?.[channel], 0, 255, 0) * rightAlpha;
  return lerp(left, right, local) / alpha;
}

function createContinuousColorLookup({ stops, min = 0, max = 1, log = false, alpha = 1, size = COLOR_LOOKUP_SIZE }) {
  const resolvedStops = normalizeColorStops(stops, REFLECTIVITY_STOPS);
  const bucketCount = clampInt(size, 2, 65536, COLOR_LOOKUP_SIZE);
  const colors = new Uint8Array(bucketCount * 4);
  const alphaMultiplier = Number.isFinite(alpha) ? alpha : 1;
  for (let index = 0; index < bucketCount; index += 1) {
    const position = bucketCount <= 1 ? 0 : index / (bucketCount - 1);
    const color = interpolateStops(resolvedStops, position) || [0, 0, 0, 0];
    const offset = index * 4;
    colors[offset] = clampInt(color[0], 0, 255, 0);
    colors[offset + 1] = clampInt(color[1], 0, 255, 0);
    colors[offset + 2] = clampInt(color[2], 0, 255, 0);
    colors[offset + 3] = clampInt((Number.isFinite(color[3]) ? color[3] : 1) * alphaMultiplier * 255, 0, 255, 0);
  }
  const resolvedMin = Number(min);
  const resolvedMax = Number(max);
  const safeMin = Number.isFinite(resolvedMin) ? resolvedMin : 0;
  const safeMax = Number.isFinite(resolvedMax) ? resolvedMax : safeMin + 1;
  const safeLogMin = Math.max(1e-6, safeMin);
  const safeLogMax = Math.max(safeLogMin * 1.01, safeMax);
  return Object.freeze({
    kind: "continuous",
    colors,
    size: bucketCount,
    min: safeMin,
    max: safeMax,
    scale: 1 / Math.max(1e-9, safeMax - safeMin),
    log: Boolean(log),
    logMin: Math.log(safeLogMin),
    logScale: 1 / Math.max(1e-9, Math.log(safeLogMax) - Math.log(safeLogMin)),
  });
}

function createStepColorLookup(valueStops, alpha = 1) {
  const rows = Array.isArray(valueStops)
    ? valueStops
        .map((stop) => {
          const value = Number(stop?.[0]);
          const color = stop?.[1];
          return Number.isFinite(value) && Array.isArray(color) ? [value, color] : null;
        })
        .filter(Boolean)
        .sort((left, right) => left[0] - right[0])
    : [];
  const thresholds = new Float64Array(rows.length);
  const colors = new Uint8Array(rows.length * 4);
  const alphaMultiplier = Number.isFinite(alpha) ? alpha : 1;
  for (let index = 0; index < rows.length; index += 1) {
    const [value, color] = rows[index];
    const offset = index * 4;
    thresholds[index] = value;
    colors[offset] = clampInt(color[0], 0, 255, 0);
    colors[offset + 1] = clampInt(color[1], 0, 255, 0);
    colors[offset + 2] = clampInt(color[2], 0, 255, 0);
    colors[offset + 3] = clampInt((Number.isFinite(color[3]) ? color[3] : 1) * alphaMultiplier * 255, 0, 255, 0);
  }
  const uniform = detectUniformStepThresholds(thresholds);
  return Object.freeze({
    kind: "step",
    thresholds,
    colors,
    uniformStart: uniform?.start ?? null,
    uniformScale: uniform?.scale ?? 0,
  });
}

function detectUniformStepThresholds(thresholds) {
  if (!thresholds || thresholds.length < 3) {
    return null;
  }
  const start = thresholds[0];
  const step = thresholds[1] - thresholds[0];
  if (!Number.isFinite(start) || !Number.isFinite(step) || step <= 0) {
    return null;
  }
  const epsilon = Math.max(1e-9, Math.abs(step) * 1e-6);
  for (let index = 2; index < thresholds.length; index += 1) {
    if (Math.abs(thresholds[index] - thresholds[index - 1] - step) > epsilon) {
      return null;
    }
  }
  return { start, scale: 1 / step };
}

function buildPngCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function pngCrc32(type, data) {
  let crc = 0xffffffff;
  for (let index = 0; index < type.length; index += 1) {
    crc = PNG_CRC_TABLE[(crc ^ type[index]) & 255] ^ (crc >>> 8);
  }
  for (let index = 0; index < data.length; index += 1) {
    crc = PNG_CRC_TABLE[(crc ^ data[index]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const out = Buffer.allocUnsafe(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  typeBuffer.copy(out, 4);
  payload.copy(out, 8);
  out.writeUInt32BE(pngCrc32(typeBuffer, payload), 8 + payload.length);
  return out;
}

function normalizeColorStops(stops, fallback) {
  const source = Array.isArray(stops) && stops.length >= 2 ? stops : fallback;
  return source.map(([position, rgb]) => [
    clamp01(position),
    [
      clampInt(rgb?.[0], 0, 255, 0),
      clampInt(rgb?.[1], 0, 255, 0),
      clampInt(rgb?.[2], 0, 255, 0),
      Number.isFinite(Number(rgb?.[3])) ? clamp01(Number(rgb[3])) : 1,
    ],
  ]);
}

function buildReflectivityPrecipTypeLookups(source) {
  const types = source?.precipTypes || {};
  const out = {};
  for (const [typeKey, type] of Object.entries(types)) {
    const bins = Array.isArray(type?.bins)
      ? type.bins
          .map((bin) => {
            const color = normalizeRgbaBytes(bin?.webColor?.rgb, bin?.webColor?.alpha);
            const minDbz = nullableFiniteNumber(bin?.minDbzInclusive);
            const maxDbz = nullableFiniteNumber(bin?.maxDbzExclusive);
            return {
              minDbz,
              maxDbz,
              rgba: color,
            };
          })
          .sort((left, right) => {
            const leftMin = Number.isFinite(left.minDbz) ? left.minDbz : Number.NEGATIVE_INFINITY;
            const rightMin = Number.isFinite(right.minDbz) ? right.minDbz : Number.NEGATIVE_INFINITY;
            return leftMin - rightMin;
          })
      : [];
    const thresholds = new Float64Array(bins.length);
    const maxes = new Float64Array(bins.length);
    const colors = new Uint8Array(bins.length * 4);
    for (let index = 0; index < bins.length; index += 1) {
      const bin = bins[index];
      thresholds[index] = Number.isFinite(bin.minDbz) ? bin.minDbz : Number.NEGATIVE_INFINITY;
      maxes[index] = Number.isFinite(bin.maxDbz) ? bin.maxDbz : Number.POSITIVE_INFINITY;
      const offset = index * 4;
      colors[offset] = bin.rgba[0];
      colors[offset + 1] = bin.rgba[1];
      colors[offset + 2] = bin.rgba[2];
      colors[offset + 3] = bin.rgba[3];
    }
    out[typeKey] = Object.freeze({
      bins: Object.freeze(bins),
      thresholds,
      maxes,
      colors,
      count: bins.length,
    });
  }
  return Object.freeze(out);
}

function buildPrecipRateTypeLookups(source) {
  const types = source?.types || {};
  const out = {};
  for (const [typeKey, type] of Object.entries(types)) {
    const rows = Array.isArray(type?.valueStops)
      ? type.valueStops
          .map((stop) => {
            const threshold = Number(stop?.[0]);
            const color = normalizeRgbaBytes(stop?.[1], stop?.[2]);
            return Number.isFinite(threshold) ? { threshold, color } : null;
          })
          .filter(Boolean)
          .sort((left, right) => left.threshold - right.threshold)
      : [];
    const thresholds = new Float64Array(rows.length);
    const colors = new Uint8Array(rows.length * 4);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const offset = index * 4;
      thresholds[index] = row.threshold;
      colors[offset] = row.color[0];
      colors[offset + 1] = row.color[1];
      colors[offset + 2] = row.color[2];
      colors[offset + 3] = row.color[3];
    }
    out[typeKey] = Object.freeze({
      thresholds,
      colors,
      count: rows.length,
    });
  }
  return Object.freeze(out);
}

function nullableFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeRgbaBytes(rgb, alpha) {
  const source = Array.isArray(rgb) ? rgb : [0, 0, 0];
  const numericAlpha = Number(alpha);
  return Object.freeze([
    clampInt(source[0], 0, 255, 0),
    clampInt(source[1], 0, 255, 0),
    clampInt(source[2], 0, 255, 0),
    clampInt((Number.isFinite(numericAlpha) ? clamp01(numericAlpha) : 0) * 255, 0, 255, 0),
  ]);
}

function getNoaaGribRendererSignature() {
  const payload = {
    renderer: "noaa-grib2-beta-v40-true-1h-precip",
    hoverGridFormat: "binary-full-resolution",
    hoverGridVariables: {
      mode: "catalog-parameter-keys",
      parameterOrder: getNoaaNamParameterOrder(),
      support: ["pressureHpa"],
      quantization: "unit-v1",
    },
    models: NOAA_BETA_MODEL_KEYS.map((modelKey) => {
      const config = NOAA_BETA_MODEL_CONFIG[modelKey];
      return {
        key: config.key,
        openDataModel: config.openDataModel,
        productKey: config.productKey,
      };
    }),
    colorMaps: {
      temperatureF: COLOR_MAPS.temperatureF.normalizedRgbaStops || COLOR_MAPS.temperatureF.normalizedStops,
      temperature850C: COLOR_MAPS.temperature850C.normalizedRgbaStops || COLOR_MAPS.temperature850C.normalizedStops,
      temperature700C: COLOR_MAPS.temperature700C.normalizedRgbaStops || COLOR_MAPS.temperature700C.normalizedStops,
      temperature500C: COLOR_MAPS.temperature500C.normalizedRgbaStops || COLOR_MAPS.temperature500C.normalizedStops,
      windMph: COLOR_MAPS.windMph.normalizedRgbaStops || COLOR_MAPS.windMph.normalizedStops,
      wind850Kt: COLOR_MAPS.wind850Kt.normalizedRgbaStops || COLOR_MAPS.wind850Kt.normalizedStops,
      wind700Kt: COLOR_MAPS.wind700Kt.normalizedRgbaStops || COLOR_MAPS.wind700Kt.normalizedStops,
      wind500Kt: COLOR_MAPS.wind500Kt.normalizedRgbaStops || COLOR_MAPS.wind500Kt.normalizedStops,
      wind250Kt: COLOR_MAPS.wind250Kt.normalizedRgbaStops || COLOR_MAPS.wind250Kt.normalizedStops,
      windGustMph: COLOR_MAPS.windGustMph.normalizedRgbaStops || COLOR_MAPS.windGustMph.normalizedStops,
      cloudCoverPct: COLOR_MAPS.cloudCoverPct.normalizedRgbaStops || COLOR_MAPS.cloudCoverPct.normalizedStops,
      precipIn: COLOR_MAPS.precipIn.normalizedRgbaStops || COLOR_MAPS.precipIn.normalizedStops,
      reflectivityDbz: COLOR_MAPS.reflectivityDbz.normalizedRgbaStops || COLOR_MAPS.reflectivityDbz.normalizedStops,
      visibilityMi: COLOR_MAPS.visibilityMi.normalizedRgbaStops || COLOR_MAPS.visibilityMi.normalizedStops,
      dewPointF: COLOR_MAPS.dewPointF.normalizedRgbaStops || COLOR_MAPS.dewPointF.normalizedStops,
      humidityPct: COLOR_MAPS.humidityPct.normalizedRgbaStops || COLOR_MAPS.humidityPct.normalizedStops,
      windBelowMinHex: COLOR_MAPS.windBelowMinHex,
      windBelowMinMph: COLOR_MAPS.windBelowMinMph,
      windGustBelowMinHex: COLOR_MAPS.windGustBelowMinHex,
      windGustBelowMinMph: COLOR_MAPS.windGustBelowMinMph,
      reflectivityPrecipType: REFLECTIVITY_PRECIP_TYPE_COLORS.precipTypes,
      snowDepthIn: NOAA_RENDER_SCALES.snowDepthIn?.legendStops,
      snowfallIn: NOAA_RENDER_SCALES.snowfallIn?.legendStops,
      heightContourDam: NOAA_RENDER_SCALES.heightContourDam?.legendStops,
      plannedDirect: {
        absoluteVorticity1e5S1: NOAA_RENDER_SCALES.absoluteVorticity1e5S1?.legendStops,
        verticalVelocityDPaS: NOAA_RENDER_SCALES.verticalVelocityDPaS?.legendStops,
        precipRateType: PLANNED_COLOR_MAPS?.maps?.precipRateByTypeInHr?.types,
        stormRelativeHelicityM2S2: NOAA_RENDER_SCALES.stormRelativeHelicityM2S2?.legendStops,
        updraftHelicity2to5kmM2S2: NOAA_RENDER_SCALES.updraftHelicity2to5kmM2S2?.legendStops,
        capeJkg: NOAA_RENDER_SCALES.capeJkg?.legendStops,
        cinJkg: NOAA_RENDER_SCALES.cinJkg?.legendStops,
        dcapeJkg: NOAA_RENDER_SCALES.dcapeJkg?.legendStops,
        relativeVorticity1e5S1: NOAA_RENDER_SCALES.relativeVorticity1e5S1?.legendStops,
        lapseRateCKm: NOAA_RENDER_SCALES.lapseRateCKm?.legendStops,
        surfaceThetaEK: NOAA_RENDER_SCALES.surfaceThetaEK?.legendStops,
        frontogenesisCPer100Km3Hr: NOAA_RENDER_SCALES.frontogenesisCPer100Km3Hr?.legendStops,
        supercellCompositeParameter: NOAA_RENDER_SCALES.supercellCompositeParameter?.legendStops,
        significantTornadoParameter: NOAA_RENDER_SCALES.significantTornadoParameter?.legendStops,
        surfaceBasedLclM: NOAA_RENDER_SCALES.surfaceBasedLclM?.legendStops,
        freezingRainIceIn: NOAA_RENDER_SCALES.freezingRainIceIn?.legendStops,
        framIceIn: NOAA_RENDER_SCALES.framIceIn?.legendStops,
      },
    },
    parameters: getNoaaNamParameterMetadata(),
    parameterOrder: getNoaaNamParameterOrder(),
    snowArtifacts: NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.artifactRequired).map((entry) => ({
      key: entry.key,
      artifact: snowArtifactCacheIdentity(entry.artifactRequired),
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

function getNoaaNamRendererSignature() {
  return getNoaaGribRendererSignature();
}

function kelvinToFahrenheit(value) {
  return Number.isFinite(value) ? ((value - 273.15) * 9) / 5 + 32 : Number.NaN;
}

function kelvinToCelsius(value) {
  return Number.isFinite(value) ? value - 273.15 : Number.NaN;
}

function pascalToHpa(value) {
  return Number.isFinite(value) ? value / 100 : Number.NaN;
}

function uniqueRecords(records) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    if (!record || seen.has(record.record)) {
      continue;
    }
    seen.add(record.record);
    out.push(record);
  }
  return out;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowNonZero) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function padHour(hour) {
  return String(Math.max(0, Math.round(Number(hour) || 0))).padStart(3, "0");
}

function padTwoDigitHour(hour) {
  return String(Math.max(0, Math.round(Number(hour) || 0))).padStart(2, "0");
}

function sanitizePathToken(value) {
  return String(value || "grib").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return Number.NaN;
  }
  return Math.max(min, Math.min(max, num));
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(num)));
}

function lerp(left, right, t) {
  return left + (right - left) * t;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CRC_TABLE = buildPngCrcTable();
const PNG_IEND_CHUNK = createPngChunk("IEND", Buffer.alloc(0));
const COLOR_LOOKUP_SIZE = 4096;
const COLOR_MAPS = loadColorMaps();
const TEMPERATURE_STOPS = COLOR_MAPS.temperatureF.normalizedStops;
const WIND_STOPS = COLOR_MAPS.windMph.normalizedRgbaStops || COLOR_MAPS.windMph.normalizedStops;
const PRECIP_VALUE_STOPS = COLOR_MAPS.precipIn.valueStops.map(([value, rgb, alpha]) => {
  const color = [...rgb];
  if (Number.isFinite(Number(alpha))) {
    color.push(Number(alpha));
  }
  return [value, color];
});
const REFLECTIVITY_VALUE_STOPS = COLOR_MAPS.reflectivityDbz.valueStops.map(([value, rgb, alpha]) => {
  const color = [...rgb];
  if (Number.isFinite(Number(alpha))) {
    color.push(Number(alpha));
  }
  return [value, color];
});
const REFLECTIVITY_STOPS = COLOR_MAPS.reflectivityDbz.normalizedRgbaStops || COLOR_MAPS.reflectivityDbz.normalizedStops;
const REFLECTIVITY_PRECIP_TYPE_LOOKUPS = buildReflectivityPrecipTypeLookups(REFLECTIVITY_PRECIP_TYPE_COLORS);
const CORE_LAYER_RENDER_OPTIONS = Object.freeze({
  temperature: Object.freeze({
    colorLookup: createContinuousColorLookup({
      stops: TEMPERATURE_STOPS,
      min: COLOR_MAPS.temperatureF.min,
      max: COLOR_MAPS.temperatureF.max,
      alpha: 0.95,
    }),
    minVisible: null,
    maxVisible: null,
    visibleRange: null,
  }),
  wind: Object.freeze({
    colorLookup: createContinuousColorLookup({
      stops: WIND_STOPS,
      min: COLOR_MAPS.windMph.min,
      max: COLOR_MAPS.windMph.max,
      alpha: 0.9,
    }),
    minVisible: COLOR_MAPS.windMph.min,
    maxVisible: null,
    visibleRange: null,
  }),
  precip: Object.freeze({
    colorLookup: createStepColorLookup(PRECIP_VALUE_STOPS, 1),
    minVisible: 0.01,
    maxVisible: null,
    visibleRange: null,
  }),
  reflectivity: Object.freeze({
    colorLookup: createStepColorLookup(REFLECTIVITY_VALUE_STOPS, 1),
    maxVisible: null,
    visibleRange: null,
  }),
});
const CATALOG_RENDER_OPTIONS = new Map(
  NOAA_NAM_PARAMETER_CATALOG.map((entry) => [entry.key, buildCatalogRenderOptions(entry)]),
);
const SYNOPTIC_STYLE = loadSynopticStyle();

module.exports = {
  CURRENT_UI_SELECTORS,
  NOAA_NAM_PARAMETER_CATALOG,
  NOAA_BETA_SOURCE_NAME,
  NOAA_BETA_MODEL_CONFIG,
  NOAA_BETA_MODEL_KEYS,
  NOAA_GFS_BASE_URL,
  NOAA_HRRR_BASE_URL,
  NOAA_NAM_BASE_URL,
  buildNoaaGribUrl,
  buildNoaaNamAwphysUrl,
  ensureWgrib2Available,
  getNoaaGribModelConfig,
  getNoaaGribRendererSignature,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
  getNoaaNamRendererSignature,
  _testBuildNoaaRegridArgs: buildNoaaRegridArgs,
  _testBuildNoaaIndexCacheContext: buildNoaaIndexCacheContext,
  _testClearNoaaIndexCaches: clearNoaaIndexCachesForTest,
  _testReadOrFetchNoaaContentLengthCached: readOrFetchNoaaContentLengthCached,
  _testReadOrFetchNoaaIdxTextCached: readOrFetchNoaaIdxTextCached,
  _testRepairNoaaIdxFinalRecordRanges: repairNoaaIdxFinalRecordRanges,
  _testSelectedGribRecordsHash: selectedGribRecordsHash,
  _testBuildSelectedRecordPlan: buildSelectedRecordPlan,
  _testParseWgribSimpleInventory: parseWgribSimpleInventory,
  _testBuildBulkDecodedRecordIndex: buildBulkDecodedRecordIndex,
  _testTakeBulkDecodedRecordBySelectedPlan: takeBulkDecodedRecordBySelectedPlan,
  _testBulkDecodedRecordOrdinal: bulkDecodedRecordOrdinal,
  _testBuildHeightContourLevels: buildHeightContourLevels,
  _testMarchingSquares: marchingSquares,
  _testMarchingSquaresMany: marchingSquaresMany,
  _testRenderHeightContourArtifacts: renderHeightContourArtifacts,
  _testCalculateCobbSlr: calculateCobbSlr,
  _testCalculateKucheraRatio: calculateKucheraRatio,
  _testCalculateWarmestProfileTempC: calculateWarmestProfileTempC,
  _testLoadSnowRfModel: loadSnowRfModel,
  _testLoadWesternLinearSlrModel: loadWesternLinearSlrModel,
  _testSnowArtifactCacheIdentity: snowArtifactCacheIdentity,
  _testBuildPletcherRfFeatures: buildPletcherRfFeatures,
  _testBuildWesternLinearFeatures: buildWesternLinearFeatures,
  _testPredictLinearSlr: predictLinearSlr,
  _testPredictRandomForest: predictRandomForest,
  _testComposeSnowMaskedPrecipGrid: composeSnowMaskedPrecipGrid,
  _testComposePhaseMaskedPrecipGrid: composePhaseMaskedPrecipGrid,
  _testCalculateFramIceLiquidRatio: calculateFramIceLiquidRatio,
  _testBuildFramIceGridsFromChunks: buildFramIceGridsFromChunks,
  _testResolveFreezingRainLiquidChunks: resolveFreezingRainLiquidChunksForWindow,
  _testSmoothSnowfallPresentationGrid: smoothSnowfallPresentationGrid,
  _testResolveSnowfallLiquidChunks: resolveSnowfallLiquidChunks,
  _testBuildIntervalSnowfallGrid: buildIntervalSnowfallGrid,
  _testBuildIntervalSnowfallGridsForEntries: buildIntervalSnowfallGridsForEntries,
  _testSumSnowfallGrids: sumSnowfallGrids,
  _testComposePrecipAccumulationGrid: composePrecipAccumulationGrid,
  _testActiveGridVisitIndicesGreaterThan: activeGridVisitIndicesGreaterThan,
  _testBuildSnowfallInGrids: buildSnowfallInGrids,
  _testSnowfallDerivedGridKey: snowfallDerivedGridKey,
  _testProfileDecodeKey: profileDecodeKey,
  _testProfileSelector: profileSelector,
  _testStandardProfileDecodeKey: standardProfileDecodeKey,
  _testProfileGridCachePayload: profileGridCachePayload,
  _testResolvePrecipAccumulationPlan: resolvePrecipAccumulationPlan,
  _testWarmPrecipAccumulationRunPlanner: warmPrecipAccumulationRunPlanner,
  _testWarmFreezingRainAccumulationRunPlanner: warmFreezingRainAccumulationRunPlanner,
  _testResolveSnowLiquidTotalPlan: resolveSnowLiquidTotalPlan,
  _testCreateContinuousColorLookup: createContinuousColorLookup,
  _testInterpolateStops: interpolateStops,
  _testBuildReflectivityPrecipTypeLookups: buildReflectivityPrecipTypeLookups,
  _testBuildPrecipRateTypeLookups: buildPrecipRateTypeLookups,
  _testBuildDerivedParameterGrids: buildDerivedParameterGrids,
  _testFilterCatalogForRenderMode: filterCatalogForRenderMode,
  _testComposeRunMaxGrid: composeRunMaxGrid,
  _testEffectiveLayerCellActive: isEffectiveLayerCellActive,
  _testBoltonThetaE: boltonThetaE,
  _testBuildRelativeVorticityGrid: buildRelativeVorticityGrid,
  _testBuildFrontogenesisGrid: buildFrontogenesisGrid,
  _testBuildFrontogenesisPresentationGrid: buildFrontogenesisPresentationGrid,
  _testBuildScpGrid: buildScpGrid,
  _testBuildStpGrid: buildStpGrid,
  _testBuildEffectiveLayerScpGrid: buildEffectiveLayerScpGrid,
  _testBuildEffectiveLayerStpGrid: buildEffectiveLayerStpGrid,
  _testEffectiveParcelSourceStepHpa: EFFECTIVE_PARCEL_SOURCE_STEP_HPA,
  _testBuildPointSoundingIndices: buildPointSoundingIndices,
  _testBuildPointSoundingAnalysisRows: buildPointSoundingAnalysisRows,
  _testBuildPointSoundingParcelDiagnostics: buildPointSoundingParcelDiagnostics,
  _testCalculateEffectiveLayerBunkersMotionFromRows: calculateEffectiveLayerBunkersMotionFromRows,
  _testCalculateBunkersMotionFromRows: calculateBunkersMotionFromRows,
  _testCalculateLiftedIndexForPointSoundingSource: calculateLiftedIndexForPointSoundingSource,
  _testCalculatePointScp: calculatePointScp,
  _testCalculateParcelCapeCinForSource: calculateParcelCapeCinForSource,
  _testCalculatePressureStepParcelCapeCinForSource: calculatePressureStepParcelCapeCinForSource,
  _testBuildParcelBuoyancySamples: buildParcelBuoyancySamples,
  _testLogPressureInterpolationFraction: logPressureInterpolationFraction,
  _testInterpolateProfileWindRows: interpolateProfileWindRows,
  _testInterpolateProfilePressureRows: interpolateProfilePressureRows,
  _testBuildGridDistributionStats: buildGridDistributionStats,
  _testResolveCatalogSourceGrid: resolveCatalogSourceGrid,
  _testFindReflectivityPrecipTypeColorOffset: findReflectivityPrecipTypeColorOffset,
  _testFindStepColorOffset: findStepColorOffset,
  _testRenderScalarGrid: renderScalarGrid,
  _testRenderPrecipRateTypeGrid: renderPrecipRateTypeGrid,
  _testRemapSouthNorthLinearLatGridToMercatorRows: remapSouthNorthLinearLatGridToMercatorRows,
  parseAccumulationHours,
  parseAccumulationWindow,
  buildNoaaPointSounding,
  parseNoaaIdx,
  renderNoaaGribFrame,
  renderNoaaNamAwphysFrame,
  selectNoaaNamParameterRecords,
  selectNamAwphysRecords,
};
