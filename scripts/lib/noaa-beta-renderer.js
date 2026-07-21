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
const {
  DETAILED_SYNOPTIC_STYLE,
  DETAILED_SYNOPTIC_STYLE_VERSION,
  HOVER_GRID_SCHEMA_VERSION,
  SYNOPTIC_STYLE_VERSION,
  VIEW_CONFIG,
} = require("./modelview-runtime");
const {
  CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY,
  EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY,
  NOAA_NAM_PARAMETER_CATALOG,
  SCALES: NOAA_RENDER_SCALES,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
  normalizeSciencePrototypeIds,
  resolveNoaaNamParameterCatalog,
} = require("./noaa-nam-parameter-catalog");
const {
  calculatePointDcapeJkg,
  buildNoaaPointSounding,
  buildPointSoundingAnalysisRows,
  buildPointSoundingIndices,
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
  snowfallEntryHasAvailableData,
  sumSnowfallGrids,
  transformGridAffine,
  warmFreezingRainAccumulationRunPlanner,
} = require("./noaa-beta/winter");
const {
  buildCobbProfileSources,
  buildKucheraProfileSources,
  buildPletcherRfFeatures,
  buildWesternLinearFeatures,
  calculateCobbLayerSlr,
  calculateCobbSlr,
  calculateCobbSlrFromSources,
  calculateKucheraRatio,
  calculateWarmestProfileTempC,
  calculateWarmestProfileTempCFromSources,
  predictLinearSlr,
  predictRandomForest,
} = require("./noaa-beta/slr-methods");
const {
  buildSelectedParameterAvailability,
  hasColocatedFiniteGridData,
  hasFiniteGridData,
  hasGrid,
  renderedLayerHasValidData,
  setParameterAvailability,
} = require("./noaa-beta/parameter-availability");
const { SOURCE_PROVENANCE_SCHEMA_VERSION, buildFrameSourceProvenance } = require("./noaa-beta/source-provenance");
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
  getFrameSourceProvenanceSources,
  getFrameTemporalProvenanceDerivations,
  getSelectedRecordPlan,
  materializeSelectedGrib,
  parseNoaaIdx,
  parseWgribSimpleInventory,
  readOrFetchNoaaContentLengthCached,
  readOrFetchNoaaIdxRecordsCached,
  resolveMainDecodeRegridPayloadHash,
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
  resolveForecastHourCompletionIdentity,
  resolveForecastHourRosterIdentity,
} = require("./noaa-beta/forecast-hour-roster");
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
  encodeLayerOrEmptyDeferred,
  encodeRawPng,
  findReflectivityPrecipTypeColorOffset,
  findStepColorOffset,
  getCatalogRenderOptions,
  interpolateStops,
  maskPressureLevelGridBelowTerrain,
  releaseFrameLocalRasterCaches,
  renderCatalogParameterLayer,
  renderPrecipRateTypeGrid,
  renderReflectivityPrecipTypeGrid,
  renderReflectivityVariants,
  renderScalarGrid,
  resolveCatalogPressureLevelMb,
  resolveCatalogSourceGrid,
  COLOR_MAPS,
} = require("./noaa-beta/raster");
const { parseAccumulationHours, parseAccumulationWindow } = require("./noaa-beta/records");
const {
  calculateReducedProfileDcapeFromSources,
  DERIVED_PROFILE_METHODOLOGY_VERSION,
  EFFECTIVE_PARCEL_SOURCE_STEP_HPA,
  PROFILE_DERIVED_AVAILABILITY_KEYS,
  buildProfileDerivedGrids,
  buildSurfaceThermoDerivedGrids,
  calculateEffectiveLayerBunkersMotionFromRows,
  calculateEffectiveLayerScpValue,
  calculateParcelCapeCinForSource,
  calculatePressureStepParcelCapeCinForSource,
  isEffectiveLayerCellActive,
} = require("./noaa-beta/severe");
const {
  buildDerivedGridCacheContext,
  readDerivedGridCache,
  scheduleDerivedGridCacheWrite,
} = require("./noaa-beta/derived-grid-cache");
const { activeParcelKernelId } = require("./noaa-beta/parcel-kernel");
const { buildProfileDerivedGridsParallel } = require("./noaa-beta/derived-parallel");
const { createCompressor, getSharedCompressPool, resolveCompressThreads } = require("./noaa-beta/compress-pool");
const { profileDecodeKey, standardProfileDecodeKey } = require("./noaa-beta/profile-access");
const {
  logPressureInterpolationFraction,
  updateScratchPressureBrackets,
  interpolateProfileWindRows,
  interpolateProfilePressureRows,
  interpolateProfileWindAtPressureRows,
  interpolateProfileThermoAtPressureRows,
  calculateBunkersMotionFromRows,
} = require("./noaa-beta/profile-wind");
const { remapSouthNorthLinearLatGridToMercatorRows, buildGridDistributionStats } = require("./noaa-beta/grid-ops");
const { createTransparentPng } = require("./noaa-beta/png-encode");
const { RD_OVER_CP, boltonThetaE, wetBulbTemperatureC, wetBulbTemperatureCAtPressure } = require("./noaa-beta/thermo");
const { MPS_TO_KT, MPS_TO_MPH, MM_TO_IN, clamp, incrementProfileCounter } = require("./noaa-beta/util");

const EARTH_OMEGA_RAD_S = 7.2921e-5;
const EARTH_RADIUS_M = 6371000;
const REFLECTIVITY_LAYER_KEYS = Object.freeze(["reflectivityComposite", "reflectivity1km"]);
const LEGACY_REFLECTIVITY_LAYER_KEY = "reflectivity";
const REFLECTIVITY_PRECIP_TYPE_LAYER_KEY = "reflectivity1kmPrecipType";
const SYNOPTIC_DETAILED_MAX_COLS = 360;
const SYNOPTIC_DETAILED_MAX_ROWS = 224;
const REALIZED_PRECIP_ACCUMULATION_KEYS = Symbol("realizedPrecipAccumulationKeys");

function catalogCategorySet(catalog) {
  const set = new Set();
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (entry && entry.category) {
      set.add(entry.category);
    }
  }
  return set;
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
  derivedCellConcurrency = 1,
  compressThreads = 1,
  hoverGridFormat = latestMetadata?.hoverGridFormat || "binary",
  renderMode = "all",
  renderSelection = null,
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
  const forecastHourRosterIdentity = resolveForecastHourRosterIdentity(latestMetadata, {
    modelKey: resolvedModelKey,
  });
  const forecastHourCompletionIdentity = resolveForecastHourCompletionIdentity(latestMetadata, {
    modelKey: resolvedModelKey,
  });
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
    forecastHourRosterIdentity,
    forecastHourCompletionIdentity,
  });
  const indexCacheContext = buildNoaaIndexCacheContext({
    modelKey: resolvedModelKey,
    date,
    cycle,
    rawCacheDir,
  });
  const selectedCatalog = filterCatalogForRenderMode(
    resolveNoaaNamParameterCatalog(renderSelection),
    renderMode,
    renderSelection,
  );
  const selectedCategories = catalogCategorySet(selectedCatalog);
  let stageStartedAt = performance.now();
  const records = await readOrFetchNoaaIdxRecordsCached(`${gribUrl}.idx`, indexCacheContext, hour, renderProfile);
  recordProfileStage(renderProfile, "indexMs", stageStartedAt);
  stageStartedAt = performance.now();
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
    let mainGribPath = null;
    let mainRegridBinPayloadHashes = null;
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
      // Collect the regrid-bin payload hashes of exactly the frame's main
      // decode; they pin the decoded grids for the derived-grid cache key.
      decodeSession.collectRegridBinPayloadHashes = [];
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
      mainGribPath = gribPath;
      mainRegridBinPayloadHashes = decodeSession.collectRegridBinPayloadHashes;
      decodeSession.collectRegridBinPayloadHashes = null;
      if (mainRegridBinPayloadHashes.length === 0 && decodeSession.lastRecordCacheAllBulkDecoded === true) {
        // The decode was served entirely from bulk-seeded run-local registry
        // entries; rebuild the regrid-bin payload hash the bulk path would
        // have recorded so the derived-grid cache still engages on warm
        // in-process paths.
        const reconstructed = await resolveMainDecodeRegridPayloadHash({
          gribPath,
          wgrib2Path,
          bounds: view.bounds,
          width,
          height,
          decodeSession,
        });
        if (reconstructed) {
          mainRegridBinPayloadHashes = [reconstructed];
        }
      }
    }
    // The "decodeMs" stage recorded from this reset spans the grid-construction
    // phase that follows the main decode (precip accumulation, winter, and
    // derived grids); the main GRIB decode itself is profiled only by its
    // sub-stages (wgribRegridMs, wgribExportMs, binaryReadMs, gridMapMs).
    stageStartedAt = performance.now();
    if (!precomputeOnlyRender) {
      const precipAccumulationGrids = await buildPrecipAccumulationGrids({
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
      applyRealizedPrecipAccumulationGrids(decoded, precipAccumulationGrids);
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
      // Freezing-rain + snow-delta inputs are winter-category compute. When the
      // render selection excludes winter, skip them so no winter bytes are
      // fetched/decoded; with no selection selectedCategories always holds
      // "winter" here (base mode keeps every non-snowfallDerived winter entry:
      // wetBulbZeroHeight/freezingRainLiquidTotal/snowDepth/snowWaterEq/
      // framFlatIce/framRadialIce/snowHrrrAsnow), preserving today's behavior.
      if (selectedCategories.has("winter")) {
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
      }
    } else if (selectedCategories.has("winter")) {
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
      // Derived-grid disk cache: the profile-derived severe products are a
      // pure function of the main decode (pinned by its regrid-bin payload
      // hashes), the methodology/catalog versions, and the requested
      // product set. A hit restores the exact Float32 bytes the compute
      // path would produce; anything else recomputes and persists.
      const availableForDerived = new Set(selection?.availableParameters || []);
      const derivedProducts = PROFILE_DERIVED_AVAILABILITY_KEYS.filter((key) => availableForDerived.has(key));
      const derivedCacheContext =
        mainGribPath &&
        Array.isArray(mainRegridBinPayloadHashes) &&
        mainRegridBinPayloadHashes.length > 0 &&
        mainRegridBinPayloadHashes.every(Boolean)
          ? buildDerivedGridCacheContext({
              gribPath: mainGribPath,
              regridBinPayloadHashes: mainRegridBinPayloadHashes,
              methodologyVersion: `${DERIVED_PROFILE_METHODOLOGY_VERSION}+parcel-${activeParcelKernelId()}`,
              catalogVersion: CATALOG_VERSION,
              products: derivedProducts,
              cellCount: width * height,
            })
          : null;
      let precomputedProfileDerived = null;
      if (derivedCacheContext) {
        precomputedProfileDerived = await readDerivedGridCache(derivedCacheContext);
        incrementProfileCounter(
          renderProfile,
          precomputedProfileDerived ? "derivedGridCacheHits" : "derivedGridCacheMisses",
        );
      }
      let parallelProfileDerived = null;
      if (!precomputedProfileDerived && derivedCellConcurrency > 1 && derivedProducts.length > 0) {
        const derivedStartedAt = performance.now();
        parallelProfileDerived = await computeParallelProfileDerived({
          decoded,
          availableParameters: selection?.availableParameters || [],
          cellCount: width * height,
          concurrency: derivedCellConcurrency,
        });
        if (parallelProfileDerived) {
          precomputedProfileDerived = parallelProfileDerived.outputs;
          renderProfile.effectiveDiagnosticsCandidateCount = parallelProfileDerived.candidateCount;
          renderProfile.derivedParallelChunks = parallelProfileDerived.chunkCount;
          renderProfile.derivedParallelWorkers = parallelProfileDerived.workerCount;
          recordProfileStage(renderProfile, "derivedGridParallelMs", derivedStartedAt);
        }
      }
      const profileDerivedCapture = derivedCacheContext && !precomputedProfileDerived ? {} : null;
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
          precomputedProfileDerived,
          profileDerivedCapture,
        }),
      );
      const derivedGridsToPersist =
        profileDerivedCapture?.grids ||
        (parallelProfileDerived && derivedCacheContext ? parallelProfileDerived.outputs : null);
      if (derivedGridsToPersist && Object.keys(derivedGridsToPersist).length > 0 && derivedCacheContext) {
        // tmp+rename makes the write safe to overlap with the rest of the
        // frame, and it only feeds future builds, so it stays off the frame
        // hot path. Frame workers drain all scheduled writes before reporting
        // completion, so pool shutdown cannot strand a temporary file.
        void scheduleDerivedGridCacheWrite(derivedCacheContext, derivedGridsToPersist);
      }
    }
    recordProfileStage(renderProfile, "decodeMs", stageStartedAt);

    stageStartedAt = performance.now();
    // Compression pool: PNG deflate + hover gzip run on helper threads and
    // overlap the raster/quantize work; a dead/absent pool degrades per call
    // to the identical inline codec. Snow/prefix parts keep inline encodes
    // (few small layers; not worth the round trip). Layer encodes submit the
    // shared png-encode scanline scratch (released right after the synchronous
    // submit clone) via layerEncodeContext; hover keeps the plain compressor.
    const compressCounters = { jobs: 0, fallbacks: 0 };
    const compressEnabled = resolveCompressThreads(compressThreads) > 0;
    const compressPool = compressEnabled ? getSharedCompressPool(compressThreads) : null;
    const compress = compressEnabled ? createCompressor(compressPool, compressCounters) : null;
    const layerEncodeContext = compressEnabled ? { pool: compressPool, counters: compressCounters } : null;
    const renderedArtifacts =
      renderMode === "snow-delta" || renderMode === "snow-prefix" || renderMode === "runmax-prefix"
        ? buildSnowDeltaRenderedArtifacts({ framePlan })
        : renderMode === "snow"
          ? buildSnowRenderedArtifacts({
              decoded,
              selection,
              framePlan,
              bounds: view.bounds,
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
              sciencePrototypes: normalizeSciencePrototypeIds(renderSelection),
              compress,
              layerEncodeContext,
            });
    if (renderedArtifacts.pendingEncodes) {
      // Only the codec time the pool could not hide behind the render work
      // above; the scanline/pack passes already ran on this thread.
      const compressWaitStartedAt = performance.now();
      await Promise.all(renderedArtifacts.pendingEncodes);
      recordProfileStage(renderProfile, "compressWaitMs", compressWaitStartedAt);
    }
    delete renderedArtifacts.pendingEncodes;
    if (compress) {
      renderProfile.compressPoolJobs = compressCounters.jobs;
      renderProfile.compressPoolFallbacks = compressCounters.fallbacks;
    }
    recordProfileStage(renderProfile, "artifactsMs", stageStartedAt);
    const sourceProvenance = buildFrameSourceProvenance({
      gribUrl,
      idxUrl: `${gribUrl}.idx`,
      selection,
      bounds: view.bounds,
      width,
      height,
      renderMode,
      toolRef: latestMetadata?.sourceProvenanceCatalog?.tools?.[0]?.id || null,
      sourceInputs: getFrameSourceProvenanceSources(decodeSession),
      temporalDerivations: getFrameTemporalProvenanceDerivations(decodeSession),
      parameterAvailability: renderedArtifacts.parameterAvailability,
    });
    renderedArtifacts.sourceProvenance = sourceProvenance;
    renderedArtifacts.renderProfile = finalizeNoaaRenderProfile(renderProfile);
    // Recorded on the finalized profile so the provenance/finalize tail above
    // lands inside totalMs instead of in no stage at all.
    recordProfileStage(renderedArtifacts.renderProfile, "totalMs", totalStartedAt);
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
  sciencePrototypes = [],
  compress = null,
  layerEncodeContext = null,
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
      width,
      height,
    });
  const getHeightDamGrid = (entry) =>
    resolveCachedHeightDamGrid({
      entry,
      decoded,
      cache: heightDamGridCache,
      width,
      height,
    });
  const precipAccumulationFiniteCounts = new Map();
  const precipAccumulationIn = buildPrecipAccumulationInGrids(decoded, precipAccumulationFiniteCounts);
  const precipIn = precipAccumulationIn.precip || null;
  const snowfallIn = buildSnowfallInGrids({ decoded, selection, bounds, modelKey, width, height });
  const reflectivityCompositeDbz = decoded.reflectivityComposite || decoded.reflectivity || null;
  const reflectivity1kmDbz = decoded.reflectivity1km || null;
  const pressureHpaStats = { finiteCount: 0 };
  const pressureHpa = transformGridAffine(decoded.pressureMsl, 0.01, 0, null, pressureHpaStats);
  const height500 = decoded.height500 || null;
  const height1000 = decoded.height1000 || null;
  const thicknessStats = { finiteCount: 0 };
  const thicknessDam = buildThicknessGrid(height500, height1000, thicknessStats);
  const emptyPng = createTransparentPng(width, height, pngCompressionLevel, pngFilterType);
  const layers = {};
  const parameterAvailability = buildSelectedParameterAvailability(selection);
  for (const entry of selection?.catalog || []) {
    if (entry?.kind === "precipAccumulation") {
      // The hasFiniteGridData inclusion scan is folded into
      // buildPrecipAccumulationInGrids: its transformGridAffine tallied
      // Number.isFinite on the stored f32 value of every cell — the removed
      // scan's exact predicate — and nothing between the build above and
      // this loop writes into those grids (only fresh arrays are allocated
      // in between). hasGrid keeps the O(1) length gate the scan did first.
      const values = precipAccumulationIn[entry.key];
      setParameterAvailability(
        parameterAvailability,
        entry.key,
        hasGrid(values, width, height) && (precipAccumulationFiniteCounts.get(entry.key) || 0) > 0,
      );
    }
  }
  const hoverValueCounts = new Map();
  // PNG deflate and hover gzip are deterministic pure functions of
  // (bytes, level); the compression pool runs them on helper threads so they
  // overlap the remaining raster/quantize work instead of serializing after
  // it. `compress` serves the hover artifact (null = inline sync codecs, the
  // exact pre-pool behavior); layer PNGs go through `layerEncodeContext`
  // ({pool, counters} or null), which builds each layer's scanlines in the
  // shared png-encode scratch slot and releases it right after the pool's
  // synchronous submit clone. Deferred descriptors resolve when the caller
  // awaits the returned pendingEncodes, before anything reads them.
  const pendingEncodes = [];
  const deferLayerEncode = (layer) => {
    const { descriptor, pending } = encodeLayerOrEmptyDeferred(
      layer,
      emptyPng,
      width,
      height,
      pngCompressionLevel,
      pngFilterType,
      layerEncodeContext,
    );
    if (pending) {
      pendingEncodes.push(pending);
    }
    return descriptor;
  };
  const encodeTrackedLayer = (key, layer) => {
    recordHoverValueCount(hoverValueCounts, key, layer);
    return deferLayerEncode(layer);
  };
  const contourVectors = {};
  const availableParameters = new Set(selection?.availableParameters || []);
  const hasExplicitAvailableParameters = Array.isArray(selection?.availableParameters);
  const isEntryAvailable = (entry) => !hasExplicitAvailableParameters || availableParameters.has(entry.key);
  recordProfileStage(profile, "artifactPrepMs", stageStartedAt);

  stageStartedAt = performance.now();
  const temperatureLayer = renderScalarGrid({
    values: temperatureF,
    width,
    height,
    ...CORE_LAYER_RENDER_OPTIONS.temperature,
  });
  setParameterAvailability(parameterAvailability, "temperature", renderedLayerHasValidData(temperatureLayer));
  layers.temperature = encodeTrackedLayer("temperature", temperatureLayer);

  const windLayer = renderScalarGrid({
    values: windMph,
    width,
    height,
    ...CORE_LAYER_RENDER_OPTIONS.wind,
  });
  setParameterAvailability(parameterAvailability, "wind", renderedLayerHasValidData(windLayer));
  layers.wind = encodeTrackedLayer("wind", windLayer);

  const precipLayer = renderScalarGrid({
    values: precipIn,
    width,
    height,
    ...CORE_LAYER_RENDER_OPTIONS.precip,
  });
  setParameterAvailability(parameterAvailability, "precip", renderedLayerHasValidData(precipLayer));
  layers.precip = encodeTrackedLayer("precip", precipLayer);

  for (const [layerKey, values] of Object.entries(precipAccumulationIn)) {
    if (layerKey === "precip") {
      continue;
    }
    const layer = renderScalarGrid({
      values,
      width,
      height,
      ...CORE_LAYER_RENDER_OPTIONS.precip,
    });
    setParameterAvailability(parameterAvailability, layerKey, renderedLayerHasValidData(layer));
    layers[layerKey] = encodeTrackedLayer(layerKey, layer);
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
    encodeLayer: deferLayerEncode,
  });
  reflectivityVariantsByLayer.reflectivityComposite = reflectivityVariants;
  layers.reflectivityComposite = pickDefaultReflectivityArtifact(reflectivityVariants) || encodeRawPng(emptyPng);
  layers.reflectivity = layers.reflectivityComposite;
  // One inclusion scan serves both keys: hasFiniteGridData is a pure read of
  // the grid, the reflectivity renders above only read values, and the sole
  // statement between the two uses is setParameterAvailability (which writes
  // solely to parameterAvailability), so a second scan would recompute the
  // identical result.
  const reflectivityCompositeAvailable = hasFiniteGridData(reflectivityCompositeDbz, width, height);
  setParameterAvailability(parameterAvailability, "reflectivityComposite", reflectivityCompositeAvailable);
  setParameterAvailability(parameterAvailability, "reflectivity", reflectivityCompositeAvailable);

  if (reflectivity1kmDbz) {
    const reflectivity1kmVariants = renderReflectivityVariants({
      values: reflectivity1kmDbz,
      width,
      height,
      reflectivityGates,
      emptyPng,
      pngCompressionLevel,
      pngFilterType,
      encodeLayer: deferLayerEncode,
    });
    reflectivityVariantsByLayer.reflectivity1km = reflectivity1kmVariants;
    layers.reflectivity1km = pickDefaultReflectivityArtifact(reflectivity1kmVariants) || encodeRawPng(emptyPng);
  }
  setParameterAvailability(
    parameterAvailability,
    "reflectivity1km",
    hasFiniteGridData(reflectivity1kmDbz, width, height),
  );
  if (selection.availableParameters?.includes(REFLECTIVITY_PRECIP_TYPE_LAYER_KEY)) {
    const precipTypeAvailable = hasColocatedFiniteGridData(
      [
        reflectivity1kmDbz,
        decoded.precipTypeRain,
        decoded.precipTypeSnow,
        decoded.precipTypeFreezingRain,
        decoded.precipTypeIcePellets,
      ],
      width,
      height,
    );
    setParameterAvailability(parameterAvailability, REFLECTIVITY_PRECIP_TYPE_LAYER_KEY, precipTypeAvailable);
    layers[REFLECTIVITY_PRECIP_TYPE_LAYER_KEY] = deferLayerEncode(
      renderReflectivityPrecipTypeGrid({
        reflectivityDbz: reflectivity1kmDbz,
        rain: decoded.precipTypeRain,
        snow: decoded.precipTypeSnow,
        freezingRain: decoded.precipTypeFreezingRain,
        sleet: decoded.precipTypeIcePellets,
        width,
        height,
      }),
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
      const precipRateTypeAvailable = hasColocatedFiniteGridData(
        [
          decoded?.[entry.rateKey],
          decoded?.[entry.precipTypeKeys?.rain],
          decoded?.[entry.precipTypeKeys?.snow],
          decoded?.[entry.precipTypeKeys?.freezingRain],
          decoded?.[entry.precipTypeKeys?.sleet],
        ],
        width,
        height,
      );
      setParameterAvailability(parameterAvailability, entry.key, precipRateTypeAvailable);
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
        layers[entry.key] = deferLayerEncode(layer);
      }
      continue;
    }
    if (entry.kind === "snowfallDerived" || entry.kind === "snowfallDirect") {
      const values = smoothSnowfallPresentationGrid(snowfallIn[entry.key], { modelKey, width, height });
      setParameterAvailability(
        parameterAvailability,
        entry.key,
        snowfallEntryHasAvailableData({ entry, decoded, values, width, height }),
      );
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
      const heightDam = getHeightDamGrid(entry);
      const values = heightDam?.values || null;
      // The hasFiniteGridData inclusion scan is folded into
      // resolveCachedHeightDamGrid: its transformGridAffine tallied
      // Number.isFinite on the stored f32 value of every cell of this very
      // grid — the removed scan's exact predicate — and the grid is only
      // read (never written) between build and here, including on cache hits
      // (renderHeightContourLayer below wraps or resamples into fresh
      // arrays). hasGrid keeps the O(1) length gate the scan did first.
      setParameterAvailability(
        parameterAvailability,
        entry.key,
        hasGrid(values, width, height) && (heightDam?.finiteCount || 0) > 0,
      );
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
        layers[entry.key] = deferLayerEncode(contourLayer);
      }
      continue;
    }
    const layer = renderCatalogParameterLayer({
      entry,
      decoded,
      modelKey,
      width,
      height,
      getWindSpeedGrid,
    });
    if (!layer) {
      if (entry.key === "cloudCeiling" && hasConclusiveNoCloudCeilingEvidence(decoded.cloudCover, width, height)) {
        setParameterAvailability(parameterAvailability, entry.key, true);
      } else {
        setParameterAvailability(parameterAvailability, entry.key, false);
      }
      continue;
    }
    const layerAvailable =
      entry.key === "cloudCeiling"
        ? renderedLayerHasValidData(layer) || hasConclusiveNoCloudCeilingEvidence(decoded.cloudCover, width, height)
        : renderedLayerHasValidData(layer);
    setParameterAvailability(parameterAvailability, entry.key, layerAvailable);
    layers[entry.key] = encodeTrackedLayer(entry.key, layer);
  }
  recordProfileStage(profile, "catalogPngMs", stageStartedAt);

  stageStartedAt = performance.now();
  const detailedPressurePayload = buildSynopticDetailGridPayload(pressureHpa, width, height);
  const detailedThicknessPayload = buildSynopticDetailGridPayload(thicknessDam, width, height);
  // The simple pass owns the one canonical H/L analysis, now run on its own
  // bounded ~50 km grid and refined against display-resolution MSLP. The
  // detailed pass renders contours only; its center roster is synchronized
  // below so the density toggle cannot change the meteorological analysis.
  const displayPressurePayload = gridPayload(pressureHpa, width, height);
  const centerValidationMode = sciencePrototypes.includes("rowAwareCenterValidation") ? "row-aware-diagnostic" : "off";
  const synopticSimple = renderSynopticArtifacts({
    pressureGrid: displayPressurePayload,
    thicknessGrid: gridPayload(thicknessDam, width, height),
    targetBounds: bounds,
    width,
    height,
    modelKey,
    detailMode: "simple",
    style: SYNOPTIC_STYLE,
    centerValidationMode,
  });
  // The simple raster doubles as the fallback gate: when it paints nothing,
  // the detailed artifacts supply the PNG layer instead. Render the detailed
  // pass exactly once — vectors only when the simple image survives, vectors
  // plus raster when the fallback needs them — so the empty-simple case no
  // longer repeats the whole detailed contour pipeline. The gate predicate is
  // unchanged (visibleCount > 0 on the same simple render), and drawImage
  // gates raster painting only, so the detailed vector payload is identical
  // either way.
  const simpleHasSynopticImage = synopticSimple.visibleCount > 0;
  const synopticDetailed = renderSynopticArtifacts({
    pressureGrid: detailedPressurePayload,
    thicknessGrid: detailedThicknessPayload,
    refinementPressureGrid: displayPressurePayload,
    targetBounds: bounds,
    width,
    height,
    modelKey,
    detailMode: "detailed",
    style: DETAILED_SYNOPTIC_STYLE,
    drawImage: !simpleHasSynopticImage,
    detectCenters: false,
    centerValidationMode,
  });
  const synopticImage = simpleHasSynopticImage ? synopticSimple : synopticDetailed;
  // Detail mode changes contour density only. Use the bounded physical-scale
  // analysis as the single H/L roster for both vector payloads and the frame
  // manifest so toggling detail cannot make pressure centers pop or change.
  const canonicalSynopticCenters = synchronizeSynopticArtifactCenters(synopticSimple.centers, [
    synopticSimple,
    synopticDetailed,
  ]);
  // The hasFiniteGridData inclusion scans are folded into the builders: both
  // tallied Number.isFinite on the stored f32 value of every cell — the
  // removed scans' exact predicate — and every consumer between the builds
  // and this point only reads the grids (the synoptic payloads wrap them or
  // resample into fresh arrays; the synoptic renders never write into their
  // inputs), so the tallies still describe the grids at this point. hasGrid
  // keeps the O(1) length gate the scans did first.
  const synopticIsobarsAvailable = hasGrid(pressureHpa, width, height) && pressureHpaStats.finiteCount > 0;
  const synopticThicknessAvailable = hasGrid(thicknessDam, width, height) && thicknessStats.finiteCount > 0;
  setParameterAvailability(parameterAvailability, "synopticIsobars", synopticIsobarsAvailable);
  setParameterAvailability(parameterAvailability, "synopticThickness", synopticThicknessAvailable);
  setParameterAvailability(parameterAvailability, "synoptic", synopticIsobarsAvailable || synopticThicknessAvailable);
  layers.synoptic = deferLayerEncode(synopticImage);
  recordProfileStage(profile, "synopticMs", stageStartedAt);

  stageStartedAt = performance.now();
  const hoverVariables = buildHoverGridVariables({
    decoded,
    selection,
    modelKey,
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
    compress,
  });
  if (hoverGrid?.pending) {
    pendingEncodes.push(hoverGrid.pending);
  }
  if (profile && hoverGrid?.diagnostics) {
    profile.hoverQuantization = hoverGrid.diagnostics;
  }
  recordProfileStage(profile, "hoverGridMs", stageStartedAt);
  // The hover pass is the last consumer of the shared masked-grid copies.
  releaseFrameLocalRasterCaches(decoded);

  return {
    pendingEncodes: pendingEncodes.length > 0 ? pendingEncodes : null,
    hour: Number(framePlan.hour),
    validHourKey: String(framePlan.validTime),
    synopticCenters: canonicalSynopticCenters,
    synopticVectors: {
      simple: synopticSimple.vector || createEmptySynopticVectorPayload(),
      detailed: synopticDetailed.vector || createEmptySynopticVectorPayload(DETAILED_SYNOPTIC_STYLE_VERSION),
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
    parameterAvailability,
    layers,
  };
}

/*
 * The code below is shared by snowfall and by the profile-derived
 * diagnostics: DCAPE, effective shear, and terrain-aware lapse rates.
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

function buildPrecipAccumulationInGrids(decoded, finiteCounts = null) {
  const out = {};
  const realizedKeys = decoded?.[REALIZED_PRECIP_ACCUMULATION_KEYS];
  for (const entry of getPrecipAccumulationEntries()) {
    if (realizedKeys instanceof Set && !realizedKeys.has(entry.key)) {
      continue;
    }
    const values = decoded?.[entry.key];
    if (!values) {
      continue;
    }
    const stats = finiteCounts ? { finiteCount: 0 } : null;
    out[entry.key] = transformGridAffine(values, MM_TO_IN, 0, 0, stats);
    if (stats) {
      finiteCounts.set(entry.key, stats.finiteCount);
    }
  }
  return out;
}

function applyRealizedPrecipAccumulationGrids(decoded, grids) {
  if (!decoded || typeof decoded !== "object") {
    return decoded;
  }
  const realized = grids && typeof grids === "object" ? grids : {};
  decoded[REALIZED_PRECIP_ACCUMULATION_KEYS] = new Set(Object.keys(realized));
  Object.assign(decoded, realized);
  return decoded;
}

function hasConclusiveNoCloudCeilingEvidence(cloudCover, width, height) {
  const expected = Math.max(0, Math.round(Number(width) * Number(height)));
  if (!cloudCover || expected <= 0 || Number(cloudCover.length) !== expected) {
    return false;
  }
  for (let index = 0; index < expected; index += 1) {
    const value = Number(cloudCover[index]);
    if (!Number.isFinite(value) || value >= 50) {
      return false;
    }
  }
  return true;
}

function buildDerivedParameterGrids({
  decoded,
  selection,
  bounds,
  width,
  height,
  profile = null,
  precomputedProfileDerived = null,
  profileDerivedCapture = null,
}) {
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

  // Per-frame geometry tables (backlog #17): the two relative-vorticity
  // builders share one Coriolis table and the two frontogenesis builders
  // share one finite-difference spacing table; previously each product
  // rebuilt an identical table. bounds/width/height are fixed for the frame
  // and the builders are pure functions of them, so a shared table holds the
  // same doubles each builder would have computed for itself. Tables are
  // built lazily on first use so unselected products still cost nothing, and
  // the row-count expressions below replicate the consumers' own formulas
  // exactly (buildRelativeVorticityGrid clamps with Math.max(1, ...),
  // buildFrontogenesisGrid does not) so the hoisted inputs are identical.
  let frameCoriolisByRow = null;
  const sharedCoriolisByRow = () => {
    if (!frameCoriolisByRow) {
      frameCoriolisByRow = buildCoriolisByRow(bounds, Math.max(1, Math.round(Number(height) || 1)));
    }
    return frameCoriolisByRow;
  };
  let frameSpacingRows;
  const sharedSpacingRows = () => {
    if (frameSpacingRows === undefined) {
      frameSpacingRows = buildFiniteDifferenceSpacingRows(
        bounds,
        Math.round(Number(width)),
        Math.round(Number(height)),
      );
    }
    return frameSpacingRows;
  };

  addComputedGrid("relativeVorticity700", () =>
    buildRelativeVorticityGrid(
      maskPressureLevelGridBelowTerrain(decoded.absoluteVorticity700, decoded, 700, width, height),
      bounds,
      width,
      height,
      sharedCoriolisByRow(),
    ),
  );
  addComputedGrid("relativeVorticity500", () =>
    buildRelativeVorticityGrid(
      maskPressureLevelGridBelowTerrain(decoded.absoluteVorticity500, decoded, 500, width, height),
      bounds,
      width,
      height,
      sharedCoriolisByRow(),
    ),
  );
  addComputedGrid("lapseRate700to500", () =>
    buildLayerLapseRateGrid(
      decoded.temp700,
      decoded.temp500,
      decoded.height700,
      decoded.height500,
      decoded.profileSurfaceHeight,
    ),
  );

  const surfaceThermo = buildSurfaceThermoDerivedGrids(decoded, available, cellCount);
  addGrid("surfaceBasedLclHeight", surfaceThermo.surfaceBasedLclHeight, { visibleThreshold: 0 });
  addGrid("surfaceThetaE", surfaceThermo.surfaceThetaE);

  const profileDerived = precomputedProfileDerived || buildProfileDerivedGrids(decoded, available, cellCount, profile);
  if (profileDerivedCapture && !precomputedProfileDerived) {
    profileDerivedCapture.grids = profileDerived;
  }
  addGrid("lapseRate0to3km", profileDerived.lapseRate0to3km);
  addGrid("bulkShear0to6km", profileDerived.bulkShear0to6km, { visibleThreshold: 9.99 });
  addGrid("effectiveBulkShear", profileDerived.effectiveBulkShear, { visibleThreshold: 9.99 });
  addComputedGrid("frontogenesis850", () =>
    buildFrontogenesisGrid(decoded, 850, bounds, width, height, sharedSpacingRows()),
  );
  addComputedGrid("frontogenesis700", () =>
    buildFrontogenesisGrid(decoded, 700, bounds, width, height, sharedSpacingRows()),
  );

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
    () => profileDerived.effectiveLayerSupercellCompositeParameter,
    {
      visibleThreshold: 0.099,
    },
  );
  addComputedGrid(
    "effectiveLayerSignificantTornadoParameter",
    () => profileDerived.effectiveLayerSignificantTornadoParameter,
    {
      visibleThreshold: 0.099,
    },
  );
  addGrid(EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY, profileDerived[EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY], {
    visibleThreshold: 0.099,
  });
  const dcape = profileDerived.dcape;
  addGrid("dcape", dcape, { visibleThreshold: 99.9 });
  const dcape21LevelCam = profileDerived[CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY];
  addGrid(CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY, dcape21LevelCam, { visibleThreshold: 99.9 });
  if (profile && dcape) {
    profile.dcapeStats = buildGridDistributionStats(dcape, { clampMax: 2500 });
  }
  if (profile && dcape21LevelCam) {
    profile.dcape21LevelCamPrototypeStats = buildGridDistributionStats(dcape21LevelCam, { clampMax: 2500 });
  }

  recordProfileStage(profile, "derivedGridMs", startedAt);
  return out;
}

function buildRelativeVorticityGrid(absoluteVorticity, bounds, width, height, coriolisByRow = null) {
  if (!absoluteVorticity) {
    return null;
  }
  const cols = Math.max(1, Math.round(Number(width) || 1));
  const rows = Math.max(1, Math.round(Number(height) || 1));
  const cellCount = cols * rows;
  // Reuse the caller's per-frame table when hoisted (same inputs to a pure
  // builder, so the same doubles); compute our own otherwise.
  const coriolisTable = coriolisByRow || buildCoriolisByRow(bounds, rows);
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let y = 0; y < rows; y += 1) {
    const coriolis = coriolisTable[y];
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

function buildLayerLapseRateGrid(lowerTempK, upperTempK, lowerHeightM, upperHeightM, surfaceHeightM = null) {
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
    const terrainZ = Number(surfaceHeightM?.[index]);
    const depthKm = (upperZ - lowerZ) / 1000;
    if (
      !Number.isFinite(lowerT) ||
      !Number.isFinite(upperT) ||
      !Number.isFinite(depthKm) ||
      depthKm <= 0.05 ||
      (Number.isFinite(terrainZ) && (lowerZ <= terrainZ || upperZ <= terrainZ))
    ) {
      continue;
    }
    out[index] = (lowerT - upperT) / depthKm;
  }
  return out;
}

function buildFrontogenesisGrid(decoded, level, bounds, width, height, spacingRows = null) {
  const temp = maskPressureLevelGridBelowTerrain(decoded?.[`temp${level}`], decoded, level, width, height);
  const u = maskPressureLevelGridBelowTerrain(decoded?.[`wind${level}U`], decoded, level, width, height);
  const v = maskPressureLevelGridBelowTerrain(decoded?.[`wind${level}V`], decoded, level, width, height);
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
  // Reuse the caller's per-frame spacing table when hoisted (same inputs to
  // a pure builder, so the same doubles); compute our own otherwise.
  const spacing = spacingRows || buildFiniteDifferenceSpacingRows(bounds, cols, rows);
  if (!spacing) {
    return out;
  }
  for (let y = 1; y < rows - 1; y += 1) {
    const dx2 = spacing.dx2[y];
    const dy2 = spacing.dy2[y];
    if (!Number.isFinite(dx2) || !Number.isFinite(dy2)) {
      continue;
    }
    for (let x = 1; x < cols - 1; x += 1) {
      const index = y * cols + x;
      if (!Number.isFinite(theta[index]) || !Number.isFinite(u[index]) || !Number.isFinite(v[index])) {
        continue;
      }
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
  // Row latitudes are needed at y-1, y, and y+1 of every interior row, so a
  // direct implementation calls the Mercator row projection three times per
  // row with overlapping arguments. Tabulate it once instead: rowToLatMercator
  // is pure in (row, rows, bounds), so latByRow[i] is exactly the double the
  // corresponding call would have returned, and every consumer below reads
  // the same values as before. Every entry is written by this loop (the
  // projection itself yields NaN for degenerate inputs), so the table needs
  // no NaN prefill.
  const latByRow = new Float64Array(Math.max(0, rows));
  for (let y = 0; y < rows; y += 1) {
    latByRow[y] = rowToLatMercator(y, rows, bounds);
  }
  const dx2 = new Float64Array(Math.max(0, rows));
  const dy2 = new Float64Array(Math.max(0, rows));
  // Rows 0 and rows-1 (and any row with a non-finite latitude) are never
  // assigned below, so the NaN prefill is load-bearing here.
  dx2.fill(Number.NaN);
  dy2.fill(Number.NaN);
  for (let y = 1; y < rows - 1; y += 1) {
    const centerLat = latByRow[y];
    const northLat = latByRow[y - 1];
    const southLat = latByRow[y + 1];
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
  // Every cell is assigned in the loop below (non-finite inputs get an
  // explicit NaN), so the NaN prefill was redundant.
  const out = new Float32Array(cellCount);
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

function buildEffectiveLayerScpGrid(_decoded, effectiveDiagnostics, cellCount) {
  // Use the internally parcel-scanned MU CAPE/CIN pair. A separately decoded
  // model MUCAPE field does not guarantee that its most-unstable parcel is the
  // parcel whose CIN was retained by this diagnostic scan.
  const mucape = effectiveDiagnostics?.muCapeJkg;
  const mucin = effectiveDiagnostics?.muCinJkg;
  const esrh = effectiveDiagnostics?.esrh;
  const ebwdKt = effectiveDiagnostics?.ebwdKt;
  if (!mucape || !mucin || !esrh || !ebwdKt) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const capeTerm = Math.max(0, Number(mucape[index])) / 1000;
    const srhTerm = Math.max(0, Number(esrh[index])) / 50;
    const ebwdMs = Math.max(0, Number(ebwdKt[index])) / MPS_TO_KT;
    const shearTerm = ebwdMs < 10 ? 0 : clamp(ebwdMs / 20, 0, 1);
    const cin = Number(mucin[index]);
    const cinTerm = cin > -40 ? 1 : clamp(-40 / cin, 0, 1);
    const scp = capeTerm * srhTerm * shearTerm * cinTerm;
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

function buildThicknessGrid(height500, height1000, stats = null) {
  if (!height500 || !height1000 || height500.length !== height1000.length) {
    return null;
  }
  // Every cell is assigned in the loop below, so the NaN prefill was
  // redundant.
  const out = new Float32Array(height500.length);
  let finiteCount = 0;
  for (let index = 0; index < out.length; index += 1) {
    const z500 = Number(height500[index]);
    const z1000 = Number(height1000[index]);
    out[index] = z500 === z500 && z1000 === z1000 ? (z500 - z1000) / 10 : Number.NaN;
    // Read back from the stored f32 cell so the tally matches an independent
    // Number.isFinite scan of the returned grid on every input.
    if (stats && Number.isFinite(out[index])) {
      finiteCount += 1;
    }
  }
  if (stats) {
    stats.finiteCount = finiteCount;
  }
  return out;
}

function resolveCachedWindSpeedGrid({ entry, decoded, cache, width, height }) {
  const key = entry?.key;
  if (!key) {
    return null;
  }
  if (cache?.has(key)) {
    return cache.get(key);
  }
  const speed = buildWindSpeedGrid(
    decoded?.[entry.uKey],
    decoded?.[entry.vKey],
    entry.transform === "windMph" ? MPS_TO_MPH : MPS_TO_KT,
  );
  const values = maskPressureLevelGridBelowTerrain(speed, decoded, resolveCatalogPressureLevelMb(entry), width, height);
  cache?.set(key, values);
  return values;
}

function resolveCachedHeightDamGrid({ entry, decoded, cache, width, height }) {
  const key = entry?.key;
  if (!key) {
    return null;
  }
  if (cache?.has(key)) {
    return cache.get(key);
  }
  const source = decoded?.[entry.inputKey];
  const masked = maskPressureLevelGridBelowTerrain(source, decoded, entry.contourLevelMb, width, height);
  // The transform already visits every cell, and its output is exactly the
  // array returned and cached here, so its finite tally (taken on the stored
  // f32 values) is the count a hasFiniteGridData scan of the returned grid
  // would make; the caller can therefore skip that rescan.
  const stats = { finiteCount: 0 };
  const values = masked ? transformGridAffine(masked, 0.1, 0, null, stats) : null;
  const resolved = { values, finiteCount: stats.finiteCount };
  cache?.set(key, resolved);
  return resolved;
}

function renderHeightContourLayer({ entry, values, bounds, modelKey, width, height }) {
  if (!entry || !values) {
    return null;
  }
  // Height contours render from the same <=360x224 detailed-cap grid as
  // MSLP-detailed (audit 2026-07-09, §6b): the 25x15-ish simple resample
  // flattened real troughs. drawImage stays on — the caller encodes the PNG
  // raster via encodeLayerOrEmpty alongside the vector.
  const rendered = renderHeightContourArtifacts({
    heightGrid: buildSynopticDetailGridPayload(values, width, height),
    targetBounds: bounds,
    width,
    height,
    modelKey,
    levelMb: entry.contourLevelMb,
    intervalDam: entry.contourIntervalDam,
    detailMode: "detailed",
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

// Defensive fallback (renderSynopticArtifacts always returns a vector); the
// stamp still tracks the mode so a fallback payload reads truthfully.
function createEmptySynopticVectorPayload(styleVersion = SYNOPTIC_STYLE_VERSION) {
  return {
    styleVersion,
    isobars: { lines: [], labels: [] },
    thickness: { lines: [], labels: [] },
    centers: { highs: [], lows: [] },
  };
}

function synchronizeSynopticArtifactCenters(canonicalCenters, artifacts) {
  const centers = {
    highs: Array.isArray(canonicalCenters?.highs) ? canonicalCenters.highs : [],
    lows: Array.isArray(canonicalCenters?.lows) ? canonicalCenters.lows : [],
  };
  for (const artifact of artifacts || []) {
    if (!artifact || typeof artifact !== "object") {
      continue;
    }
    artifact.centers = centers;
    if (artifact.vector && typeof artifact.vector === "object") {
      artifact.vector.centers = centers;
    }
  }
  return centers;
}

// Frame completion must track the resolved gate roster: the gates select
// which dbz<gate> variant artifacts a frame writes, so rebuilding with
// different gates must not reuse completion markers from a previous roster.
// Ordering is normalized so equivalent spellings hash identically.
function normalizeSignatureReflectivityGates(reflectivityGates) {
  if (!Array.isArray(reflectivityGates) || reflectivityGates.length === 0) {
    return null;
  }
  const gates = Array.from(
    new Set(reflectivityGates.map((value) => Math.round(Number(value))).filter(Number.isFinite)),
  ).sort((left, right) => left - right);
  return gates.length > 0 ? gates : null;
}

// raster.js resolves paint behavior from these exact SCALES fields through
// CATALOG_RENDER_OPTIONS (alpha, lookup routing and size, min/max, visible
// bounds) and from entry transforms, but the legend-focused payload entries
// below omit them — changing any of them moves paint bytes without moving
// the signature. Digesting the fields from the same registries the paint
// path reads keeps the two from drifting.
function buildCatalogScaleSignaturePayload() {
  const scaleKeys = Array.from(new Set(NOAA_NAM_PARAMETER_CATALOG.map((entry) => entry?.scale).filter(Boolean))).sort();
  const scales = {};
  for (const key of scaleKeys) {
    const scale = NOAA_RENDER_SCALES[key] || {};
    scales[key] = {
      min: scale.min ?? null,
      max: scale.max ?? null,
      alpha: scale.alpha ?? null,
      minVisible: scale.minVisible ?? null,
      maxVisible: scale.maxVisible ?? null,
      visibleRange: scale.visibleRange ?? null,
      lookup: scale.lookup ?? null,
      lookupSize: scale.lookupSize ?? null,
      log: scale.log ?? null,
      valueStops: scale.valueStops ?? null,
    };
  }
  const entryTransforms = {};
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    if (entry?.transform && entry.transform !== "identity") {
      entryTransforms[entry.key] = String(entry.transform);
    }
  }
  return { scales, entryTransforms };
}

function getNoaaGribRendererSignature(
  renderSelection = null,
  { forecastHourRosterIdentity = null, wgrib2ToolRef = null, reflectivityGates = null } = {},
) {
  const sciencePrototypes = normalizeSciencePrototypeIds(renderSelection);
  const gates = normalizeSignatureReflectivityGates(reflectivityGates);
  const payload = {
    // MUST move whenever renderer OUTPUT changes — local-artifact-runtime
    // treats a matching signature as frame-complete, so a stale version keeps
    // stale artifacts on rebuild. v41: map-QA synoptic round (2 hPa detailed
    // isobars, km-based center detection with locality/merit/edge fixes,
    // detailed-grid height contours, simple-mode smoothing skip, model-capped
    // refinement precision). v42 added explicit per-frame availability and
    // realized-window precipitation semantics. v43 adds a bounded forensic
    // source-provenance sidecar to render profiles and completion markers.
    // v44 moves the canonical H/L analysis off the coarse simple-contour grid
    // onto the bounded ~50 km physical-scale center grid.
    // v45 records exact selected-source/temporal lineage and references one
    // run-level versioned/SHA-256 wgrib2 identity (provenance schema v2).
    // v46 binds completion to a stable sampling-tier identity for canonical
    // prefixes, so appending future published hours does not rebuild common
    // frames. Regular custom cadences get their own stable identity; irregular
    // selections bind their exact roster instead. v47 additionally binds
    // frame completion to the exact SHA-256 wgrib2 tool reference so an
    // executable change cannot reuse markers whose toolRef belongs to an old
    // run-level provenance catalog. v48 binds completion to the resolved
    // reflectivity-gate roster and to the byte-affecting catalog scale fields
    // (alpha, min/max, visible bounds, lookup routing and size, entry
    // transforms), so a gates or scale-tuning change cannot reuse stale
    // artifacts. v49 invalidates learned-snowfall output after making the
    // accumulated trace-liquid visibility bound conservative at f32 edges.
    renderer: "noaa-grib2-beta-v49-trace-liquid-bound",
    ...(sciencePrototypes.length > 0 ? { sciencePrototypes } : {}),
    ...(forecastHourRosterIdentity ? { forecastHourRosterIdentity: String(forecastHourRosterIdentity) } : {}),
    ...(wgrib2ToolRef ? { wgrib2ToolRef: String(wgrib2ToolRef) } : {}),
    ...(gates ? { reflectivityGates: gates } : {}),
    parameterAvailabilitySchema: "explicit-available-unavailable-v1",
    sourceProvenanceSchemaVersion: SOURCE_PROVENANCE_SCHEMA_VERSION,
    hoverGridFormat: "binary-full-resolution",
    hoverGridVariables: {
      mode: "catalog-parameter-keys",
      parameterOrder: getNoaaNamParameterOrder(renderSelection),
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
    catalogScales: buildCatalogScaleSignaturePayload(),
    parameters: getNoaaNamParameterMetadata(renderSelection),
    parameterOrder: getNoaaNamParameterOrder(renderSelection),
    snowArtifacts: NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.artifactRequired).map((entry) => ({
      key: entry.key,
      artifact: snowArtifactCacheIdentity(entry.artifactRequired),
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

const SYNOPTIC_STYLE = loadSynopticStyle();
// DETAILED_SYNOPTIC_STYLE (2 hPa minor / +mslp2 marker) is defined in
// modelview-runtime — the single source shared with the manifest stamp.

// Failure containment for the intra-frame parallel derived path. Correctness
// invariant: parallelism is an optimization over the byte-identical serial
// compute, so ANY parallel-path failure (sub-worker spawn pressure, crash
// mid-job, merge mismatch) must degrade to serial by returning null — never
// fail a frame that serial compute would render.
async function computeParallelProfileDerived({ decoded, availableParameters, cellCount, concurrency }) {
  try {
    return await buildProfileDerivedGridsParallel({ decoded, availableParameters, cellCount, concurrency });
  } catch (error) {
    console.warn(`[noaa-beta] derived parallel path failed; using serial: ${String(error?.message || error)}`);
    return null;
  }
}

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
  filterCatalogForRenderMode,
  getNoaaGribModelConfig,
  getNoaaGribRendererSignature,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
  _testBuildNoaaRegridArgs: buildNoaaRegridArgs,
  _testComputeParallelProfileDerived: computeParallelProfileDerived,
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
  _testRenderHeightContourLayer: renderHeightContourLayer,
  _testDetailedSynopticStyle: DETAILED_SYNOPTIC_STYLE,
  _testSynchronizeSynopticArtifactCenters: synchronizeSynopticArtifactCenters,
  _testCalculateCobbSlr: calculateCobbSlr,
  _testCalculateCobbLayerSlr: calculateCobbLayerSlr,
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
  _testBuildSnowRenderedArtifacts: buildSnowRenderedArtifacts,
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
  _testCatalogCategorySet: catalogCategorySet,
  _testComposeRunMaxGrid: composeRunMaxGrid,
  _testEffectiveLayerCellActive: isEffectiveLayerCellActive,
  _testBoltonThetaE: boltonThetaE,
  _testBuildRelativeVorticityGrid: buildRelativeVorticityGrid,
  _testBuildFrontogenesisGrid: buildFrontogenesisGrid,
  _testBuildFrontogenesisPresentationGrid: buildFrontogenesisPresentationGrid,
  _testBuildFiniteDifferenceSpacingRows: buildFiniteDifferenceSpacingRows,
  _testBuildCoriolisByRow: buildCoriolisByRow,
  _testBuildRunMaxCurrentGrid: buildRunMaxCurrentGrid,
  _testBuildScpGrid: buildScpGrid,
  _testBuildStpGrid: buildStpGrid,
  _testBuildEffectiveLayerScpGrid: buildEffectiveLayerScpGrid,
  _testBuildEffectiveLayerStpGrid: buildEffectiveLayerStpGrid,
  _testEffectiveParcelSourceStepHpa: EFFECTIVE_PARCEL_SOURCE_STEP_HPA,
  _testBuildPointSoundingIndices: buildPointSoundingIndices,
  _testBuildPointSoundingAnalysisRows: buildPointSoundingAnalysisRows,
  _testCalculateEffectiveLayerBunkersMotionFromRows: calculateEffectiveLayerBunkersMotionFromRows,
  _testCalculateEffectiveLayerScpValue: calculateEffectiveLayerScpValue,
  _testCalculateBunkersMotionFromRows: calculateBunkersMotionFromRows,
  _testCalculateLiftedIndexForPointSoundingSource: calculateLiftedIndexForPointSoundingSource,
  _testWetBulbTemperatureC: wetBulbTemperatureC,
  _testCalculateReducedProfileDcapeFromSources: calculateReducedProfileDcapeFromSources,
  _testCalculatePointDcapeJkg: calculatePointDcapeJkg,
  _testWetBulbTemperatureCAtPressure: wetBulbTemperatureCAtPressure,
  _testCalculatePointScp: calculatePointScp,
  _testCalculateParcelCapeCinForSource: calculateParcelCapeCinForSource,
  _testCalculatePressureStepParcelCapeCinForSource: calculatePressureStepParcelCapeCinForSource,
  _testLogPressureInterpolationFraction: logPressureInterpolationFraction,
  _testInterpolateProfileWindRows: interpolateProfileWindRows,
  _testInterpolateProfilePressureRows: interpolateProfilePressureRows,
  _testInterpolateProfileWindAtPressureRows: interpolateProfileWindAtPressureRows,
  _testInterpolateProfileThermoAtPressureRows: interpolateProfileThermoAtPressureRows,
  _testUpdateScratchPressureBrackets: updateScratchPressureBrackets,
  _testBuildGridDistributionStats: buildGridDistributionStats,
  _testBuildRenderedArtifacts: buildRenderedArtifacts,
  _testBuildPrecipAccumulationInGrids: buildPrecipAccumulationInGrids,
  _testBuildThicknessGrid: buildThicknessGrid,
  _testResolveCachedHeightDamGrid: resolveCachedHeightDamGrid,
  _testApplyRealizedPrecipAccumulationGrids: applyRealizedPrecipAccumulationGrids,
  _testHasConclusiveNoCloudCeilingEvidence: hasConclusiveNoCloudCeilingEvidence,
  _testResolveCatalogSourceGrid: resolveCatalogSourceGrid,
  _testMaskPressureLevelGridBelowTerrain: maskPressureLevelGridBelowTerrain,
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
  selectNoaaNamParameterRecords,
  selectNamAwphysRecords,
};
