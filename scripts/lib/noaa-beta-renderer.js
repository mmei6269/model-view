"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const REFLECTIVITY_PRECIP_TYPE_COLORS = require("../../shared/reflectivity-precip-type-colors.json");
const PLANNED_COLOR_MAPS = require("../../shared/noaa-beta-planned-color-maps.json");
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
const {
  NOAA_NAM_PARAMETER_CATALOG,
  SCALES: NOAA_RENDER_SCALES,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
} = require("./noaa-nam-parameter-catalog");
const {
  calculatePointDcapeJkg,
  buildNoaaPointSounding,
  buildPointSoundingAnalysisRows,
  buildPointSoundingIndices,
  buildPointSoundingParcelDiagnostics,
  calculateLiftedIndexForPointSoundingSource,
  calculatePointScp,
} = require("./noaa-beta/point-sounding");
const {
  MAX_SNOW_TO_LIQUID_RATIO,
  MIN_VISIBLE_SNOW_LIQUID_IN,
  activeDescriptorCellCount,
  activeGridVisitIndicesGreaterThan,
  activeVisitCount,
  activeVisitIndex,
  buildFramIceGrids,
  buildFramIceGridsFromChunks,
  buildFreezingRainAccumulationGrids,
  buildIntervalSnowfallGridsForEntries,
  buildLiquidChunkDescriptors,
  buildSnowDeltaRenderedArtifacts,
  buildSnowRenderedArtifacts,
  buildSnowfallCumulativePrefixOnlyGrids,
  buildSnowfallDeltaOnlyGrids,
  buildSnowfallInGrids,
  buildWinterDerivedInputGrids,
  calculateFramIceLiquidRatio,
  composePhaseMaskedPrecipGrid,
  createSnowFeatureScratch,
  hasGridValueGreaterThan,
  profileGridCachePayload,
  resolveFreezingRainLiquidChunksForWindow,
  resolveSnowLiquidTotalPlan,
  resolveSnowfallLiquidChunksForWindow,
  shouldIncludeGrid,
  smoothSnowfallPresentationGrid,
  snowfallDerivedGridKey,
  sumSnowfallGrids,
  transformGridAffine,
  warmFreezingRainAccumulationRunPlanner,
} = require("./noaa-beta/winter");
const {
  buildCobbProfileSources,
  buildKucheraProfileSources,
  buildPletcherRfFeatures,
  buildWesternLinearFeatures,
  calculateCobbSlr,
  calculateCobbSlrFromSources,
  calculateKucheraRatio,
  calculateWarmestProfileTempC,
  calculateWarmestProfileTempCFromSources,
  predictLinearSlr,
  predictRandomForest,
} = require("./noaa-beta/slr-methods");
const {
  buildPrecipAccumulationGrids,
  buildRunMaxAccumulationGrids,
  buildRunMaxPrefixOnlyGrids,
  composePrecipAccumulationGrid,
  composeRunMaxGrid,
  ensureSelectedRecordByteRangesForHour,
  getPrecipAccumulationEntries,
  resolvePrecipAccumulationPlan,
  warmPrecipAccumulationRunPlanner,
} = require("./noaa-beta/accumulation");
const {
  CURRENT_UI_SELECTORS,
  FRAM_FLAT_ICE_KEY,
  FRAM_RADIAL_ICE_KEY,
  FREEZING_RAIN_LIQUID_TOTAL_KEY,
  PLETCHER_RF_FEATURE_KEYS,
  WESTERN_LINEAR_FEATURE_KEYS,
  filterCatalogForRenderMode,
  loadSnowRfModel,
  loadWesternLinearSlrModel,
  profileSelector,
  selectNamAwphysRecords,
  selectNoaaNamParameterRecords,
  selectSnowfallDerivedParameterRecords,
  snowArtifactCacheIdentity,
} = require("./noaa-beta/selection");
const {
  CATALOG_VERSION,
  DEFAULT_WGRIB2_PATH,
  buildBulkDecodedRecordIndex,
  buildNoaaRegridArgs,
  buildSelectedRecordPlan,
  bulkDecodedRecordOrdinal,
  clearNoaaIndexCachesForTest,
  decodeSelectedRecordsToGrids,
  ensureWgrib2Available,
  getSelectedRecordPlan,
  materializeSelectedGrib,
  parseNoaaIdx,
  parseWgribSimpleInventory,
  readOrFetchNoaaContentLengthCached,
  readOrFetchNoaaIdxTextCached,
  repairNoaaIdxFinalRecordRanges,
  selectedGribRecordsHash,
  takeBulkDecodedRecordBySelectedPlan,
  createNoaaRenderProfile,
  finalizeNoaaRenderProfile,
  createFrameDecodeSession,
  attachRunLocalDecodeSession,
  buildNoaaIndexCacheContext,
} = require("./noaa-beta/grib-source");
const {
  NOAA_BETA_MODEL_CONFIG,
  NOAA_BETA_MODEL_KEYS,
  NOAA_BETA_SOURCE_NAME,
  NOAA_GFS_BASE_URL,
  NOAA_HRRR_BASE_URL,
  NOAA_NAM_BASE_URL,
  buildNoaaGribUrl,
  buildNoaaNamAwphysUrl,
  getNoaaGribModelConfig,
  normalizeNoaaModelKey,
} = require("./noaa-beta/model-config");
const { padHour, recordProfileStage } = require("./noaa-beta/cache-io");
const { buildHoverGridArtifact, buildHoverGridVariables, recordHoverValueCount } = require("./noaa-beta/hover");
const {
  CORE_LAYER_RENDER_OPTIONS,
  buildFrontogenesisPresentationGrid,
  buildPrecipRateTypeLookups,
  buildReflectivityPrecipTypeLookups,
  createContinuousColorLookup,
  encodeLayerOrEmpty,
  encodeRawPng,
  findReflectivityPrecipTypeColorOffset,
  findStepColorOffset,
  getCatalogRenderOptions,
  interpolateStops,
  renderCatalogParameterLayer,
  renderPrecipRateTypeGrid,
  renderReflectivityPrecipTypeGrid,
  renderReflectivityVariants,
  renderScalarGrid,
  resolveCatalogSourceGrid,
  COLOR_MAPS,
} = require("./noaa-beta/raster");
const { parseAccumulationHours, parseAccumulationWindow } = require("./noaa-beta/records");
const {
  calculateReducedProfileDcapeFromSources,
  EFFECTIVE_PARCEL_SOURCE_STEP_HPA,
  buildParcelBuoyancySamples,
  buildProfileDerivedGrids,
  buildSurfaceThermoDerivedGrids,
  calculateEffectiveLayerBunkersMotionFromRows,
  calculateParcelCapeCinForSource,
  calculatePressureStepParcelCapeCinForSource,
  isEffectiveLayerCellActive,
} = require("./noaa-beta/severe");
const { profileDecodeKey, standardProfileDecodeKey } = require("./noaa-beta/profile-access");
const {
  logPressureInterpolationFraction,
  updateScratchPressureBrackets,
  interpolateProfileWindRows,
  interpolateProfilePressureRows,
  interpolateProfileWindAtPressureRows,
  interpolateProfileThermoAtPressureRows,
  calculateMeanWindByPressureFromRows,
  calculateBunkersMotionFromRows,
} = require("./noaa-beta/profile-wind");
const { remapSouthNorthLinearLatGridToMercatorRows, buildGridDistributionStats } = require("./noaa-beta/grid-ops");
const { createTransparentPng } = require("./noaa-beta/png-encode");
const { RD_OVER_CP, boltonThetaE, wetBulbTemperatureC, wetBulbTemperatureCAtPressure } = require("./noaa-beta/thermo");
const { MPS_TO_KT, MPS_TO_MPH, MM_TO_IN, clamp } = require("./noaa-beta/util");

const EARTH_OMEGA_RAD_S = 7.2921e-5;
const EARTH_RADIUS_M = 6371000;
const REFLECTIVITY_LAYER_KEYS = Object.freeze(["reflectivityComposite", "reflectivity1km"]);
const LEGACY_REFLECTIVITY_LAYER_KEY = "reflectivity";
const REFLECTIVITY_PRECIP_TYPE_LAYER_KEY = "reflectivity1kmPrecipType";
const SYNOPTIC_DETAILED_MAX_COLS = 360;
const SYNOPTIC_DETAILED_MAX_ROWS = 224;

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

/*
 * The code below is shared by snowfall today and by future profile-derived
 * diagnostics such as DCAPE, effective shear, and terrain-aware lapse rates.
 */

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

async function resolveSnowfallLiquidChunks(context, endHour) {
  return resolveSnowfallLiquidChunksForWindow(context, 0, endHour);
}

function composeSnowMaskedPrecipGrid(options) {
  return composePhaseMaskedPrecipGrid({ ...options, targetType: "snow" });
}

function pickDefaultReflectivityArtifact(variants) {
  return variants?.dbz15 || variants?.dbz20 || variants?.dbz10 || null;
}

function isReflectivityLayerKey(layerKey) {
  return layerKey === LEGACY_REFLECTIVITY_LAYER_KEY || REFLECTIVITY_LAYER_KEYS.includes(layerKey);
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
  // Every cell is assigned in the loop below, so the NaN prefill was
  // redundant.
  const theta = new Float32Array(cellCount);
  const thetaMultiplier = Math.pow(1000 / level, RD_OVER_CP);
  for (let index = 0; index < cellCount; index += 1) {
    const tempK = Number(temp[index]);
    theta[index] = Number.isFinite(tempK) ? tempK * thetaMultiplier : Number.NaN;
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
      const divergence = dUdx + dVdy;
      const stretching = dUdx - dVdy;
      const shearing = dVdx + dUdy;
      const deformationTerm =
        (dThetaDx * dThetaDx - dThetaDy * dThetaDy) * stretching + 2 * dThetaDx * dThetaDy * shearing;
      const divergenceTerm = gradientMagnitude * gradientMagnitude * divergence;
      out[index] = (-0.5 * (deformationTerm + divergenceTerm) * 100000 * 10800) / gradientMagnitude;
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

function buildScpGrid(decoded, effectiveBulkShear, cellCount) {
  // SCP is defined with MUCAPE; omit the product rather than silently
  // substituting SBCAPE/MLCAPE when the MU field is unavailable.
  const mucape = decoded?.mucape;
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

function buildThicknessGrid(height500, height1000) {
  if (!height500 || !height1000 || height500.length !== height1000.length) {
    return null;
  }
  // Every cell is assigned in the loop below, so the NaN prefill was
  // redundant.
  const out = new Float32Array(height500.length);
  for (let index = 0; index < out.length; index += 1) {
    const z500 = Number(height500[index]);
    const z1000 = Number(height1000[index]);
    out[index] = z500 === z500 && z1000 === z1000 ? (z500 - z1000) / 10 : Number.NaN;
  }
  return out;
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
  // Every cell is assigned in the loop below (sampleGridBilinear returns NaN
  // for unusable taps), so the NaN prefill was redundant.
  const out = new Float32Array(targetCols * targetRows);
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
  _testBuildFiniteDifferenceSpacingRows: buildFiniteDifferenceSpacingRows,
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
  _testWetBulbTemperatureC: wetBulbTemperatureC,
  _testCalculateReducedProfileDcapeFromSources: calculateReducedProfileDcapeFromSources,
  _testCalculatePointDcapeJkg: calculatePointDcapeJkg,
  _testWetBulbTemperatureCAtPressure: wetBulbTemperatureCAtPressure,
  _testCalculatePointScp: calculatePointScp,
  _testCalculateParcelCapeCinForSource: calculateParcelCapeCinForSource,
  _testCalculatePressureStepParcelCapeCinForSource: calculatePressureStepParcelCapeCinForSource,
  _testBuildParcelBuoyancySamples: buildParcelBuoyancySamples,
  _testLogPressureInterpolationFraction: logPressureInterpolationFraction,
  _testInterpolateProfileWindRows: interpolateProfileWindRows,
  _testInterpolateProfilePressureRows: interpolateProfilePressureRows,
  _testInterpolateProfileWindAtPressureRows: interpolateProfileWindAtPressureRows,
  _testInterpolateProfileThermoAtPressureRows: interpolateProfileThermoAtPressureRows,
  _testUpdateScratchPressureBrackets: updateScratchPressureBrackets,
  _testCalculateMeanWindByPressureFromRows: calculateMeanWindByPressureFromRows,
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
