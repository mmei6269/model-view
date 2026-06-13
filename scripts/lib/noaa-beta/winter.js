"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sleep } = require("../local-artifact-options");
const { HOVER_GRID_SCHEMA_VERSION } = require("../modelview-runtime");
const { NOAA_NAM_PARAMETER_CATALOG, SNOW_PROFILE_LEVELS } = require("../noaa-nam-parameter-catalog");
const { MM_TO_IN, MPS_TO_KT, M_TO_IN, clamp01, clampInt, incrementProfileCounter } = require("./util");
const { dewpointFromTempRhK, wetBulbTemperatureC } = require("./thermo");
const { float32ArrayViewFromBuffer, smoothFiniteNonnegativeGrid } = require("./grid-ops");
const { createTransparentPng } = require("./png-encode");
const {
  PROFILE_SURFACE_DECODE_KEYS,
  profileDecodeKey,
  profileSpeedAtLevel,
  profileValue,
  resolveProfileGrid,
  standardProfileDecodeKey,
  surfaceDewpointK,
} = require("./profile-access");
const {
  CATALOG_VERSION,
  SELECTED_GRIB_CACHE_DIRNAME,
  decodeSelectedRecordsToGrids,
  getNoaaRecordsForHour,
  getSelectedRecordPlan,
  materializeSelectedGrib,
  readDecodedRecordsForKeyedRecords,
  readRegisteredProfileGrids,
  readRegisteredSourceGrid,
  registerProfileGrids,
  registerSourceGrid,
  selectedGribSharedCacheDir,
  selectedPrecipRecordIdentity,
  selectedRecordDecodeCacheKey,
} = require("./grib-source");
const { encodeLayerOrEmpty, getCatalogRenderOptions, renderScalarGrid } = require("./raster");
const {
  findRecord,
  isSurfaceAccumulatedFreezingRainRecord,
  isSurfaceAccumulatedSnowWaterRecord,
  isSurfacePrecipAccumulationRecord,
  isSurfacePrecipRecord,
  parseAccumulationHours,
  parseAccumulationWindow,
  recordsMatch,
} = require("./records");
const {
  GRID_CACHE_LOCK_POLL_MS,
  GRID_CACHE_LOCK_TIMEOUT_MS,
  cacheMetadataPayloadMatches,
  cacheMetadataWithPayload,
  directCacheMetadataPayloadMatches,
  mapWithConcurrency,
  padHour,
  pathExists,
  recordProfileStage,
  releaseGridCacheLock,
  sanitizePathToken,
  tryAcquireGridCacheLock,
  waitForCachedGrid,
} = require("./cache-io");
const { buildNoaaGribUrl } = require("./model-config");
const {
  FRAM_FLAT_ICE_KEY,
  FRAM_RADIAL_ICE_KEY,
  FREEZING_RAIN_LIQUID_TOTAL_KEY,
  PLETCHER_RF_FEATURE_KEYS,
  PROFILE_SURFACE_SELECTORS,
  SNOW_MASK_TYPE_KEYS,
  SNOW_SOURCE_SELECTORS,
  WESTERN_LINEAR_FEATURE_KEYS,
  findExactAverageSnowMaskRecords,
  hasCompletePhaseMaskRecordSet,
  loadSnowRfModel,
  loadWesternLinearSlrModel,
  profileSelector,
  snowArtifactCacheIdentity,
} = require("./selection");
const {
  buildCobbProfileSources,
  buildKucheraProfileSources,
  buildPletcherRfFeatures,
  buildWesternLinearFeatures,
  calculateCobbSlrFromSources,
  calculateKucheraRatio,
  calculateWarmestProfileTempCFromSources,
  createAglProfileScratch,
  predictLinearSlr,
  predictRandomForest,
} = require("./slr-methods");
const {
  composePrecipAccumulationGrid,
  ensureSelectedRecordByteRangesForHour,
  metadataFanoutConcurrency,
  resolveAvailableForecastHours,
} = require("./accumulation");
const { buildHoverGridArtifact, buildHoverGridVariables, recordHoverValueCount } = require("./hover");

const PROFILE_GRID_PROMISE_CACHE = new Map();

const SNOWFALL_DELTA_PROMISE_CACHE = new Map();

const SNOWFALL_CUMULATIVE_PROMISE_CACHE = new Map();

const SNOW_LIQUID_GRID_CACHE_VERSION = "snow-liquid-grid-v4";

const PROFILE_GRID_CACHE_VERSION = "derived-profile-grid-v1";

const SNOWFALL_DELTA_GRID_CACHE_VERSION = "snowfall-delta-grid-v4";

const SNOWFALL_CUMULATIVE_GRID_CACHE_VERSION = "snowfall-cumulative-grid-v4";

const SNOWFALL_CUMULATIVE_GRID_LOCK_MIN_HOUR = 6;

const SNOWFALL_CUMULATIVE_GRID_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

const SNOWFALL_CUMULATIVE_GRID_LOCK_POLL_MS = 100;

const SNOW_LIQUID_TOTAL_KEY = "snowLiquidTotal";

const SNOWFALL_DERIVED_INTERVALS_READY_KEY = "snowfallDerivedIntervalsReady";

const SNOWFALL_DERIVED_GRID_KEY_PREFIX = "snowfallDerivedIn";

const SNOWFALL_RENDER_THRESHOLD_IN = 0.1;

const MAX_SNOW_TO_LIQUID_RATIO = 60;

const MIN_VISIBLE_SNOW_LIQUID_IN = SNOWFALL_RENDER_THRESHOLD_IN / MAX_SNOW_TO_LIQUID_RATIO;

const SPARSE_ACTIVE_GRID_MAX_FRACTION = 0.45;

const SNOWFALL_PRESENTATION_SMOOTHING_BY_MODEL = Object.freeze({
  gfs: Object.freeze({ passes: 2 }),
});

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

function decodeHourFanoutConcurrency(context, cap = 6) {
  const decodeConcurrency = Math.max(1, Number(context?.decodeConcurrency) || 1);
  return Math.min(decodeConcurrency, Math.max(1, Number(cap) || 6));
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
    // Grid resolution is hoisted out of the dense cell loop; the per-cell
    // reads below replicate gridValue/surfaceDewpointK/profileSpeedAtLevel
    // exactly (Number conversion, finite normalization, direct-dewpoint
    // preference, and hypot order are unchanged).
    const tempGrid = resolveProfileGrid(profileDecoded, "TMP", "surface");
    const rhGrid = resolveProfileGrid(profileDecoded, "RH", "surface");
    const directDewpointGrid = profileDecoded?.dewpoint2m || null;
    const uGrid = resolveProfileGrid(profileDecoded, "UGRD", "surface");
    const vGrid = resolveProfileGrid(profileDecoded, "VGRD", "surface");
    const wetBulbC = new Float32Array(cellCount).fill(Number.NaN);
    const windKt = new Float32Array(cellCount).fill(Number.NaN);
    const visitCount = activeIndexSet === null ? cellCount : activeIndexSet.size;
    const sparseIndices = activeIndexSet === null ? null : Array.from(activeIndexSet);
    for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
      const index = sparseIndices ? sparseIndices[visitIndex] : visitIndex;
      const tempRaw = tempGrid ? Number(tempGrid[index]) : Number.NaN;
      const tempK = Number.isFinite(tempRaw) ? tempRaw : Number.NaN;
      let dewpointK = directDewpointGrid ? Number(directDewpointGrid[index]) : Number.NaN;
      if (!Number.isFinite(dewpointK)) {
        const rhRaw = rhGrid ? Number(rhGrid[index]) : Number.NaN;
        dewpointK = dewpointFromTempRhK(tempK, Number.isFinite(rhRaw) ? rhRaw : Number.NaN);
      }
      const wetBulb = wetBulbTemperatureC(tempK, dewpointK);
      const uRaw = uGrid ? Number(uGrid[index]) : Number.NaN;
      const vRaw = vGrid ? Number(vGrid[index]) : Number.NaN;
      const u = Number.isFinite(uRaw) ? uRaw : Number.NaN;
      const v = Number.isFinite(vRaw) ? vRaw : Number.NaN;
      const wind = (Number.isFinite(u) && Number.isFinite(v) ? Math.hypot(u, v) : Number.NaN) * MPS_TO_KT;
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

function createSnowFeatureScratch(featureCount, variables) {
  return {
    features: new Array(Math.max(0, Math.round(Number(featureCount) || 0))),
    profile: createAglProfileScratch(variables),
  };
}

module.exports = {
  MAX_SNOW_TO_LIQUID_RATIO,
  MIN_VISIBLE_SNOW_LIQUID_IN,
  PROFILE_GRID_CACHE_VERSION,
  PROFILE_GRID_PROMISE_CACHE,
  SNOWFALL_CUMULATIVE_GRID_CACHE_VERSION,
  SNOWFALL_CUMULATIVE_GRID_LOCK_MIN_HOUR,
  SNOWFALL_CUMULATIVE_GRID_LOCK_POLL_MS,
  SNOWFALL_CUMULATIVE_GRID_LOCK_TIMEOUT_MS,
  SNOWFALL_CUMULATIVE_PROMISE_CACHE,
  SNOWFALL_DELTA_GRID_CACHE_VERSION,
  SNOWFALL_DELTA_PROMISE_CACHE,
  SNOWFALL_DERIVED_GRID_KEY_PREFIX,
  SNOWFALL_DERIVED_INTERVALS_READY_KEY,
  SNOWFALL_PRESENTATION_SMOOTHING_BY_MODEL,
  SNOWFALL_RENDER_THRESHOLD_IN,
  SNOW_LIQUID_GRID_CACHE_VERSION,
  SNOW_LIQUID_TOTAL_KEY,
  SPARSE_ACTIVE_GRID_MAX_FRACTION,
  activeDescriptorCellCount,
  activeGridVisitIndicesGreaterThan,
  activeVisitCount,
  activeVisitIndex,
  addFramSurfaceRecords,
  addIntervalSnowfallValueForState,
  addPressureProfileRecordsForEntry,
  addProfileRecord,
  addProfileRecordsForEntries,
  addSurfaceProfileRecords,
  addVisibleSnowfallGrid,
  buildCachedCumulativeSnowfallGrids,
  buildCachedDeltaSnowfallGrids,
  buildCachedIterativeCumulativeSnowfallGrids,
  buildCobbSnowfallGrid,
  buildCumulativeSnowLiquidPlan,
  buildDeltaSnowfallGrids,
  buildFramEnvironmentByHour,
  buildFramIceGrids,
  buildFramIceGridsFromChunks,
  buildFreezingRainAccumulationGrids,
  buildFreezingRainLiquidSourceGridOverrides,
  buildIntervalSnowfallAccumulationGrids,
  buildIntervalSnowfallGridsForEntries,
  buildKucheraSnowfallGrid,
  buildLiquidChunkDescriptors,
  buildSnowDeltaRenderedArtifacts,
  buildSnowLiquidAccumulationGrids,
  buildSnowLiquidIntervalSumPlan,
  buildSnowLiquidSourceGridOverrides,
  buildSnowLiquidTotalInGrid,
  buildSnowMaskSamplesForInterval,
  buildSnowRenderedArtifacts,
  buildSnowRfConusSnowfallGrid,
  buildSnowfallAccumulationContext,
  buildSnowfallCumulativePrefixOnlyGrids,
  buildSnowfallDeltaOnlyGrids,
  buildSnowfallGridForEntry,
  buildSnowfallInGrids,
  buildSnowfallLiquidInByChunk,
  buildUnionedProfileDecodeRequest,
  buildUnknownSnowfallDeltaGrids,
  buildWesternLinearSnowfallGrid,
  buildWinterDerivedInputGrids,
  calculateFramIceLiquidRatio,
  calculateIntervalPhaseFraction,
  calculatePhaseMaskFraction,
  compareFreezingRainLiquidIntervalPriority,
  compareSnowLiquidEndingIntervalPriority,
  compareSnowLiquidIntervalPriority,
  compareSnowLiquidPathIntervalPriority,
  compareSnowfallLiquidChunkPriority,
  composePhaseMaskedPrecipGrid,
  composePhaseMaskedPrecipGridGeneric,
  composeSingleSamplePhaseMaskedPrecipGrid,
  computeCumulativeSnowfallGrids,
  computeIterativeCumulativeSnowfallGrids,
  createIntervalSnowfallEntryState,
  createSnowFeatureScratch,
  cumulativeSnowfallCacheKey,
  cumulativeSnowfallCachePayload,
  cumulativeSnowfallGridCachePath,
  decodeFramSurfaceGridsForHour,
  decodeFramSurfaceProfiles,
  decodeHourFanoutConcurrency,
  decodeIntervalSnowfallProfiles,
  decodeLazySnowfallProfileGrids,
  decodeProfileRecordsForHour,
  decodeProfileRecordsForHourExact,
  decodeSnowLiquidHourSources,
  decodeSnowLiquidHourSourcesWithLock,
  decodeSnowLiquidSourceGrids,
  decodeSnowfallProfileGridsForHour,
  decodedGridForRecord,
  deltaSnowfallCacheKey,
  deltaSnowfallCachePayload,
  deltaSnowfallChunkIdentity,
  deltaSnowfallGridCachePath,
  enqueueUnionedProfileDecode,
  findExactSnowLiquidInterval,
  findSnowLiquidIntervalPath,
  findSnowfallLiquidChunkPath,
  framEnvironmentSegmentsForChunk,
  framProfileHoursForChunk,
  getAvailableSnowfallDerivedEntries,
  getDirectFreezingRainLiquidIntervalsForHour,
  getFreezingRainLiquidIntervalsForHour,
  getSnowLiquidIntervalsForHour,
  hasGridValueGreaterThan,
  isSupportedIntervalSnowfallEntry,
  maskValueAt,
  materializeDecodedProfileGridsForHour,
  mergeCumulativeSnowfallGrids,
  mergeWeightedSnowLiquidTerms,
  multiplySnowLiquidByRatio,
  profileDecodeUnionBatchKey,
  profileGridCachePath,
  profileGridCachePayload,
  profileSelectedGribCacheDir,
  readCachedCumulativeSnowfallGrids,
  readCachedCumulativeSnowfallGridsForHour,
  readCachedProfileGrids,
  readCachedSnowLiquidHourSources,
  readCachedSnowLiquidSourceGrid,
  readOrComputeCachedCumulativeSnowfallGrids,
  readOrDecodeCachedProfileGrids,
  releaseSnowfallCumulativeGridLock,
  resolveDirectFreezingRainLiquidChunksForWindow,
  resolveDirectFreezingRainLiquidChunksForWindowUncached,
  resolveFreezingRainLiquidChunksForWindow,
  resolveFreezingRainLiquidChunksForWindowUncached,
  resolveSnowLiquidTotalPlan,
  resolveSnowfallAccumulationStep,
  resolveSnowfallLiquidChunksForWindow,
  resolveSnowfallLiquidChunksForWindowUncached,
  runUnionedProfileDecodeBatch,
  scheduleProfileDecodeUnionFlush,
  shouldIncludeGrid,
  shouldUnionProfileDecode,
  smoothSnowfallPresentationGrid,
  smoothSnowfallPresentationGrids,
  snowLiquidSourceGridCachePath,
  snowLiquidSourceGridCachePayload,
  snowLiquidSourceHourLockPath,
  snowLiquidSourceKey,
  snowLiquidTerm,
  snowMaskSampleIdentity,
  snowfallDerivedGridKey,
  snowfallLiquidChunkFromTerms,
  snowfallLiquidChunkKindRank,
  sumLiquidChunksIn,
  sumSnowfallGrids,
  transformGridAffine,
  tryAcquireSnowfallCumulativeGridLock,
  waitForCachedCumulativeSnowfallGrids,
  waitForCachedSnowLiquidHourSources,
  warmFreezingRainAccumulationRunPlanner,
  writeCachedCumulativeSnowfallGrids,
  writeCachedProfileGrids,
  writeCachedSnowLiquidSourceGrid,
  writeFloatGridEntriesBinary,
  zeroGridForFiniteSource,
};
