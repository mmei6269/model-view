"use strict";

const path = require("path");
const { HOVER_GRID_ENCODING, HOVER_GRID_SCHEMA_VERSION } = require("../modelview-runtime");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { M_TO_IN, incrementProfileCounter } = require("./util");
const { createTransparentPng } = require("./png-encode");
const { registerTemporalProvenanceDerivation, selectedGribSharedCacheDir } = require("./grib-source");
const { encodeLayerOrEmpty, getCatalogRenderOptions, renderScalarGrid } = require("./raster");
const {
  buildSelectedParameterAvailability,
  hasFiniteGridData,
  setParameterAvailability,
} = require("./parameter-availability");
const { padHour, recordProfileStage } = require("./cache-io");
const {
  resolveForecastHourRosterIdentity,
  resolveForecastHourSamplingTierFromMetadata,
} = require("./forecast-hour-roster");
const { FRAM_FLAT_ICE_KEY, FRAM_RADIAL_ICE_KEY, FREEZING_RAIN_LIQUID_TOTAL_KEY } = require("./selection");
const { composePrecipAccumulationGrid, resolveAvailableForecastHours } = require("./accumulation");
const { buildHoverGridArtifact, buildHoverGridVariables, recordHoverValueCount } = require("./hover");
const {
  SPARSE_ACTIVE_GRID_MAX_FRACTION,
  activeDescriptorCellCount,
  activeGridVisitIndicesGreaterThan,
  activeVisitCount,
  activeVisitIndex,
  buildLiquidChunkDescriptors,
  buildSnowfallLiquidInByChunk,
  hasIncompleteLiquidChunks,
  sumLiquidChunksIn,
} = require("./winter-sparse");
const {
  buildCumulativeSnowLiquidPlan,
  buildSnowLiquidIntervalSumPlan,
  buildSnowMaskSamplesForInterval,
  compareFreezingRainLiquidIntervalPriority,
  compareSnowLiquidEndingIntervalPriority,
  compareSnowLiquidIntervalPriority,
  compareSnowLiquidPathIntervalPriority,
  compareSnowfallLiquidChunkPriority,
  findExactSnowLiquidInterval,
  findSnowLiquidIntervalPath,
  findSnowfallLiquidChunkPath,
  getDirectFreezingRainLiquidIntervalsForHour,
  getFreezingRainLiquidIntervalsForHour,
  getSnowLiquidIntervalsForHour,
  mergeWeightedSnowLiquidTerms,
  resolveDirectFreezingRainLiquidChunksForWindow,
  resolveDirectFreezingRainLiquidChunksForWindowUncached,
  resolveFreezingRainLiquidChunksForWindow,
  resolveFreezingRainLiquidChunksForWindowUncached,
  resolveSnowLiquidTotalPlan,
  resolveSnowfallLiquidChunksForWindow,
  resolveSnowfallLiquidChunksForWindowUncached,
  snowLiquidSourceKey,
  snowLiquidTerm,
  snowfallLiquidChunkFromTerms,
  snowfallLiquidChunkKindRank,
  warmFreezingRainAccumulationRunPlanner,
} = require("./winter-liquid-planning");
const {
  SNOW_LIQUID_GRID_CACHE_VERSION,
  buildFreezingRainLiquidSourceGridOverrides,
  buildSnowLiquidSourceGridOverrides,
  calculateIntervalPhaseFraction,
  calculatePhaseMaskFraction,
  composePhaseMaskedPrecipGrid,
  composePhaseMaskedPrecipGridGeneric,
  composeSingleSamplePhaseMaskedPrecipGrid,
  decodeHourFanoutConcurrency,
  decodeSnowLiquidHourSources,
  decodeSnowLiquidHourSourcesWithLock,
  decodeSnowLiquidSourceGrids,
  decodedGridForRecord,
  maskValueAt,
  readCachedSnowLiquidHourSources,
  readCachedSnowLiquidSourceGrid,
  snowLiquidSourceGridCachePath,
  snowLiquidSourceGridCachePayload,
  snowLiquidSourceHourLockPath,
  snowMaskSampleIdentity,
  waitForCachedSnowLiquidHourSources,
  writeCachedSnowLiquidSourceGrid,
  zeroGridForFiniteSource,
} = require("./winter-source-grids");
const {
  PROFILE_GRID_CACHE_VERSION,
  PROFILE_GRID_PROMISE_CACHE,
  addPressureProfileRecordsForEntry,
  addProfileRecord,
  addProfileRecordsForEntries,
  addSurfaceProfileRecords,
  buildSnowfallProfileInputForEntry,
  buildUnionedProfileDecodeRequest,
  decodeIntervalSnowfallProfiles,
  decodeLazySnowfallProfileGrids,
  decodeProfileRecordsForHour,
  decodeProfileRecordsForHourExact,
  decodeSnowfallProfileGridsForHour,
  enqueueUnionedProfileDecode,
  expectedSnowfallProfileRecordKeys,
  materializeDecodedProfileGridsForHour,
  profileDecodeUnionBatchKey,
  profileGridCachePath,
  profileGridCachePayload,
  profileSelectedGribCacheDir,
  readCachedProfileGrids,
  readOrDecodeCachedProfileGrids,
  runUnionedProfileDecodeBatch,
  scheduleProfileDecodeUnionFlush,
  shouldUnionProfileDecode,
  writeCachedProfileGrids,
  writeFloatGridEntriesBinary,
} = require("./winter-profile-decode");
const {
  MAX_SNOW_TO_LIQUID_RATIO,
  MIN_VISIBLE_SNOW_LIQUID_IN,
  SNOWFALL_PRESENTATION_SMOOTHING_BY_MODEL,
  SNOWFALL_RENDER_THRESHOLD_IN,
  SNOW_LIQUID_TOTAL_KEY,
  addIntervalSnowfallValueForState,
  buildCobbSnowfallGrid,
  buildIntervalSnowfallGridsForEntries,
  buildKucheraSnowfallGrid,
  buildSnowLiquidTotalInGrid,
  buildSnowRfConusSnowfallGrid,
  buildSnowfallGridForEntry,
  buildWesternLinearSnowfallGrid,
  createIntervalSnowfallEntryState,
  createSnowFeatureScratch,
  hasGridValueGreaterThan,
  isSupportedIntervalSnowfallEntry,
  multiplySnowLiquidByRatio,
  shouldIncludeGrid,
  smoothSnowfallPresentationGrid,
  smoothSnowfallPresentationGrids,
  transformGridAffine,
} = require("./winter-slr-grids");
const {
  addFramSurfaceRecords,
  buildFramEnvironmentByHour,
  buildFramIceGrids,
  buildFramIceGridsFromChunks,
  buildFramOutputProvenance,
  buildFramProfileProvenance,
  calculateFramIceLiquidRatio,
  decodeFramSurfaceGridsForHour,
  decodeFramSurfaceProfiles,
  framEnvironmentSegmentsForChunk,
  framProfileHoursForChunk,
} = require("./winter-fram");
const {
  SNOWFALL_CUMULATIVE_GRID_CACHE_VERSION,
  SNOWFALL_CUMULATIVE_GRID_LOCK_MIN_HOUR,
  SNOWFALL_CUMULATIVE_PROMISE_CACHE,
  SNOWFALL_DELTA_GRID_CACHE_VERSION,
  SNOWFALL_DELTA_PROMISE_CACHE,
  buildCachedCumulativeSnowfallGrids,
  buildCachedDeltaSnowfallGrids,
  buildCachedIterativeCumulativeSnowfallGrids,
  buildDeltaSnowfallGrids,
  buildUnknownSnowfallDeltaGrids,
  computeCumulativeSnowfallGrids,
  computeIterativeCumulativeSnowfallGrids,
  cumulativeSnowfallCacheKey,
  cumulativeSnowfallCachePayload,
  cumulativeSnowfallGridCachePath,
  deltaSnowfallCacheKey,
  deltaSnowfallCachePayload,
  deltaSnowfallChunkIdentity,
  deltaSnowfallGridCachePath,
  mergeCumulativeSnowfallGrids,
  readCachedCumulativeSnowfallGrids,
  readCachedCumulativeSnowfallGridsForHour,
  readOrComputeCachedCumulativeSnowfallGrids,
  releaseSnowfallCumulativeGridLock,
  resolveSnowfallAccumulationStep,
  sumSnowfallGrids,
  tryAcquireSnowfallCumulativeGridLock,
  waitForCachedCumulativeSnowfallGrids,
  writeCachedCumulativeSnowfallGrids,
} = require("./winter-snowfall-cache");

const SNOWFALL_DERIVED_INTERVALS_READY_KEY = "snowfallDerivedIntervalsReady";

const SNOWFALL_DERIVED_GRID_KEY_PREFIX = "snowfallDerivedIn";

function buildSnowRenderedArtifacts({
  decoded,
  selection,
  framePlan,
  bounds,
  modelKey,
  width,
  height,
  pngCompressionLevel,
  pngFilterType,
  hoverGridFormat = "binary",
  profile = null,
}) {
  let stageStartedAt = performance.now();
  const snowfallIn = buildSnowfallInGrids({ decoded, selection, bounds, modelKey, width, height });
  const emptyPng = createTransparentPng(width, height, pngCompressionLevel, pngFilterType);
  const layers = {};
  const parameterAvailability = buildSelectedParameterAvailability(selection);
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
    const values = smoothSnowfallPresentationGrid(snowfallIn[entry.key], { modelKey, width, height });
    setParameterAvailability(
      parameterAvailability,
      entry.key,
      snowfallEntryHasAvailableData({ entry, decoded, values, width, height }),
    );
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
    modelKey,
    snowfallIn,
    width,
    height,
    hoverValueCounts,
    preDeltaEncode: HOVER_GRID_ENCODING.preDeltaEncode && String(hoverGridFormat || "").toLowerCase() === "binary",
    preGradient:
      HOVER_GRID_ENCODING.predictor === "gradient2d" && String(hoverGridFormat || "").toLowerCase() === "binary",
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
    parameterAvailability,
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
    forecastHourRosterIdentity: resolveForecastHourRosterIdentity(latestMetadata, { modelKey }),
    forecastHourSamplingTier: resolveForecastHourSamplingTierFromMetadata(latestMetadata, { modelKey }),
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
  registerTemporalProvenanceDerivation(decodeSession, {
    family: "snow-liquid-accumulation",
    outputKey: SNOW_LIQUID_TOTAL_KEY,
    targetHour: target,
    terms: plan.terms,
  });
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
    forecastHourRosterIdentity: resolveForecastHourRosterIdentity(latestMetadata, { modelKey }),
    forecastHourSamplingTier: resolveForecastHourSamplingTierFromMetadata(latestMetadata, { modelKey }),
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
  registerTemporalProvenanceDerivation(decodeSession, {
    family: "freezing-rain-liquid-accumulation",
    outputKey: FREEZING_RAIN_LIQUID_TOTAL_KEY,
    targetHour: target,
    terms: sourceRefs,
  });
  if (profile) {
    profile.freezingRainLiquidSourceRefs = sourceRefs.length;
  }
  stageStartedAt = performance.now();
  const sourceGrids = await decodeSnowLiquidSourceGrids(sourceRefs, context);
  recordProfileStage(profile, "freezingRainLiquidSourceMs", stageStartedAt);
  const liquidByChunk = buildSnowfallLiquidInByChunk(chunks, sourceGrids, width, height);
  sourceGrids.clear();
  if (process.env.MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK && chunks.length > 0) {
    // Test-only fault injection: simulate a chunk whose liquid grid failed to
    // compose, so the completeness gate below stays regression-testable.
    liquidByChunk.delete(chunks[0].key);
  }
  if (hasIncompleteLiquidChunks(chunks, liquidByChunk, width * height)) {
    // A dropped chunk means the accumulation window is unknown, not zero. The
    // liquid total below is already strict; FRAM must not be built from the
    // surviving subset either (it would render underestimated ice as valid),
    // and the fram-ice provenance must not claim complete input coverage.
    incrementProfileCounter(profile, "freezingRainLiquidChunkGaps");
    console.warn(
      `[noaa-beta] freezing-rain liquid chunk set incomplete for F${padHour(target)}; omitting freezing-rain liquid and FRAM outputs as unknown`,
    );
    liquidByChunk.clear();
    return {};
  }
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
    const framProfileProvenance = await buildFramProfileProvenance({
      chunks: framChunks,
      profilesByHour,
      context,
    });
    const framOutputProvenance = buildFramOutputProvenance({
      sourceRefs,
      profileProvenance: framProfileProvenance,
      requiresProfile: true,
    });
    for (const outputKey of [FRAM_FLAT_ICE_KEY, FRAM_RADIAL_ICE_KEY].filter((key) => available.has(key))) {
      registerTemporalProvenanceDerivation(decodeSession, {
        family: "fram-ice-accumulation",
        outputKey,
        targetHour: target,
        terms: framOutputProvenance.terms,
        inputCoverage: framOutputProvenance.inputCoverage,
      });
    }
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
    const framOutputProvenance = buildFramOutputProvenance({
      sourceRefs,
      requiresProfile: false,
    });
    for (const outputKey of [FRAM_FLAT_ICE_KEY, FRAM_RADIAL_ICE_KEY].filter((key) => available.has(key))) {
      registerTemporalProvenanceDerivation(decodeSession, {
        family: "fram-ice-accumulation",
        outputKey,
        targetHour: target,
        terms: framOutputProvenance.terms,
        inputCoverage: framOutputProvenance.inputCoverage,
      });
    }
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
    forecastHourRosterIdentity: resolveForecastHourRosterIdentity(latestMetadata, { modelKey }),
    forecastHourSamplingTier: resolveForecastHourSamplingTierFromMetadata(latestMetadata, { modelKey }),
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
    forecastHourRosterIdentity: resolveForecastHourRosterIdentity(latestMetadata, { modelKey }),
    forecastHourSamplingTier: resolveForecastHourSamplingTierFromMetadata(latestMetadata, { modelKey }),
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

function buildSnowfallInGrids({ decoded, selection, bounds, width, height }) {
  const out = {};
  const availableParameters = new Set(selection?.availableParameters || []);
  const cellCount = Number(width) * Number(height);
  if (!Number.isFinite(cellCount) || cellCount <= 0) {
    return out;
  }
  if (availableParameters.has("snowHrrrAsnow") && decoded?.snowHrrrAsnow) {
    const asnowStats = { finiteCount: 0 };
    const asnowIn = transformGridAffine(decoded.snowHrrrAsnow, M_TO_IN, 0, 0, asnowStats);
    // shouldIncludeGrid(asnowIn) is folded into the builder: with no
    // visibleThreshold it returns true iff some cell passes
    // Number.isFinite(Number(values[index])) — the exact predicate the
    // builder tallied on the stored f32 value of every cell of this same,
    // untouched grid (shouldIncludeGrid applies no length gate, so no
    // hasGrid term is needed here).
    if (asnowStats.finiteCount > 0) {
      out.snowHrrrAsnow = asnowIn;
    }
  }
  const derivedEntries = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => {
    return entry.kind === "snowfallDerived" && availableParameters.has(entry.key);
  });
  if (derivedEntries.length === 0) {
    return out;
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
    return out;
  }
  const snowLiquidStats = { finiteCount: 0 };
  const snowLiquidIn = buildSnowLiquidTotalInGrid(decoded, width, height, snowLiquidStats);
  // hasFiniteGridData(snowLiquidIn, width, height) is folded into the
  // builder: it tallied Number.isFinite on the stored f32 value of every
  // cell — the scan's exact predicate — and it only returns a grid whose
  // length equals cellCount === width * height > 0, so the scan's hasGrid
  // length gate always passes when a grid comes back (and a null grid maps
  // to the zero tally). The grid is freshly allocated above, so nothing
  // could have mutated it since.
  if (!(snowLiquidStats.finiteCount > 0)) {
    return out;
  }
  // Even a dry/trace finite source is a scientifically valid value. The PNG
  // may remain transparent below the 0.1 in display threshold, but hover must
  // retain 0 or the raw sub-threshold accumulation instead of reporting "--".
  // Sparse visitation makes the all-zero path allocation-only; learned
  // methods retain their existing trace shortcut and do no feature inference.
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
  return out;
}

// Per-frame memo of the dry-frame snowfall availability verdict, attached
// non-enumerably to the frame-local decoded object.
const DRY_SNOW_LIQUID_AVAILABILITY = Symbol("drySnowLiquidAvailability");

function snowfallEntryHasAvailableData({ entry, decoded, values, width, height }) {
  if (hasFiniteGridData(values, width, height)) {
    return true;
  }
  if (entry?.kind === "snowfallDirect") {
    return hasFiniteGridData(decoded?.[entry.inputKey], width, height);
  }
  if (entry?.kind !== "snowfallDerived") {
    return false;
  }
  const precomputed = decoded?.[snowfallDerivedGridKey(entry.key)];
  if (hasFiniteGridData(precomputed, width, height)) {
    // Presentation intentionally omits a valid dry/zero cumulative field.
    return true;
  }
  // The dry-frame verdict is identical for every snowfallDerived entry, so
  // it is evaluated once per frame; previously each of the five derived
  // entries rebuilt and double-scanned the full liquid grid on dry frames.
  let dryVerdict = decoded[DRY_SNOW_LIQUID_AVAILABILITY];
  if (dryVerdict === undefined) {
    const snowLiquidStats = { finiteCount: 0 };
    const snowLiquidIn = buildSnowLiquidTotalInGrid(decoded, width, height, snowLiquidStats);
    // hasFiniteGridData(snowLiquidIn, width, height) is folded into the
    // builder (same identity proof as in buildSnowfallInGrids above).
    // The on-demand path also intentionally omits dry/trace fields. A finite
    // liquid grid below the render threshold is still scientifically valid zero.
    dryVerdict =
      snowLiquidStats.finiteCount > 0 ? !hasGridValueGreaterThan(snowLiquidIn, MIN_VISIBLE_SNOW_LIQUID_IN) : false;
    Object.defineProperty(decoded, DRY_SNOW_LIQUID_AVAILABILITY, {
      value: dryVerdict,
      enumerable: false,
      configurable: true,
    });
  }
  return dryVerdict;
}

function snowfallDerivedGridKey(key) {
  return `${SNOWFALL_DERIVED_GRID_KEY_PREFIX}:${key}`;
}

function addVisibleSnowfallGrid(out, key, values) {
  if (shouldIncludeGrid(values)) {
    out[key] = values;
  }
}

module.exports = {
  MAX_SNOW_TO_LIQUID_RATIO,
  MIN_VISIBLE_SNOW_LIQUID_IN,
  PROFILE_GRID_CACHE_VERSION,
  PROFILE_GRID_PROMISE_CACHE,
  SNOWFALL_CUMULATIVE_GRID_CACHE_VERSION,
  SNOWFALL_CUMULATIVE_GRID_LOCK_MIN_HOUR,
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
  buildFramOutputProvenance,
  buildFramProfileProvenance,
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
  snowfallEntryHasAvailableData,
  buildSnowfallLiquidInByChunk,
  hasIncompleteLiquidChunks,
  buildSnowfallProfileInputForEntry,
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
  expectedSnowfallProfileRecordKeys,
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
