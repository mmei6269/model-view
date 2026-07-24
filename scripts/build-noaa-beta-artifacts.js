#!/usr/bin/env node

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadDotEnv, resolveCacheRootEnv } = require("./lib/env-config");

const ROOT_DIR = path.resolve(__dirname, "..");

// Compression and artifact-key defaults are resolved while renderer modules
// load. Bootstrap the CLI environment before importing them so the parent and
// subsequently spawned frame workers cannot disagree about codec or level.
if (require.main === module) {
  loadDotEnv(path.join(ROOT_DIR, ".env"));
}

const {
  FRAME_WORKER_STARTUP_RECEIPT_TYPE,
  FrameWorkerPool,
  runWithConcurrency,
} = require("./lib/local-artifact-concurrency");
const { LocalArtifactRuntime } = require("./lib/local-artifact-runtime");
const { NOAA_BETA_SOURCE_NAME, ensureWgrib2Available, getNoaaNamParameterOrder } = require("./lib/noaa-beta-renderer");
const { buildCatalogColorLookupBenchmarkReceipt } = require("./lib/noaa-beta/catalog-color-lookup-asset");
const { SNOW_RF_STARTUP_RECEIPT_TYPE, initializeSnowRfBenchmarkRole } = require("./lib/noaa-beta/snow-rf-role-receipt");
const { STATIC_CONTINUOUS_COLOR_LOOKUP_STATE } = require("./lib/noaa-beta/raster");
const {
  DEFAULT_ARTIFACT_PREFIX,
  DEFAULT_REFLECTIVITY_GATES,
  DEFAULT_VIEW_KEY,
  VIEW_CONFIG,
} = require("./lib/modelview-runtime");
const {
  DEFAULT_FRAME_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  buildFrameRenderTasks,
  buildGlobalFrameQueue,
  buildLatestStatesWithGlobalFrameQueue,
  canStartFrameTaskWithDependencies,
  clampInt,
  markFrameTaskDependencyComplete,
  parseBooleanOption,
  runGlobalFrameTaskQueue,
} = require("./lib/noaa-build/frame-queue");
const {
  buildFullHoursForModel,
  buildNoaaModelMetadata,
  buildNoaaNamMetadata,
  formatHoursByModel,
  isFullRunRequest,
  parseHours,
  referenceTimeFromRun,
  resolveAvailableNoaaHours,
  resolveHoursByModel,
  resolveModels,
  resolveNoaaBaseUrls,
  resolveNoaaModelRun,
  resolveNoaaParameterSetForRun,
  resolveNoaaParameterSetFromIdxTexts,
  selectNoaaParameterProbeHours,
} = require("./lib/noaa-build/run-resolution");
const { parseRenderSelectionFromArgs } = require("./lib/noaa-build/render-selection-args");
const { getWgrib2ProvenanceIdentity } = require("./lib/noaa-beta/grib-source");
const { filterNoaaForecastHoursForCycle } = require("./lib/noaa-beta/model-config");
const { buildRunSourceProvenanceCatalog } = require("./lib/noaa-beta/source-provenance");

const DEFAULT_CACHE_ROOT = path.join(ROOT_DIR, "output/noaa-beta-cache");
const DEFAULT_LOCAL_WGRIB2_PATH = path.join(ROOT_DIR, "output/noaa-beta-tools/bin/wgrib2");
const DEFAULT_NOAA_WORKER_PATH = path.join(ROOT_DIR, "scripts/noaa-beta-frame-worker.js");
const BENCHMARK_RECEIPT_ENV = "MODELVIEW_NOAA_BENCHMARK_RECEIPTS";
const BENCHMARK_RECEIPT_FD = 3;
const BENCHMARK_RECEIPT_MAGIC = Buffer.from("MVBR");
// Snow-RF receipts carry 500 region commitments (~90 KB canonical JSON);
// keep this in step with the harness's per-receipt parse cap.
const MAX_BENCHMARK_RECEIPT_BYTES = 256 * 1024;
const FRAME_PROGRESS_STARTS = new Map();

function formatCycleHorizonCapMessage(modelKey, run, cycleAwareHours) {
  const prefix = `[noaa-beta] ${modelKey} ${run.date} ${run.cycle}Z cycle horizon`;
  if (!Array.isArray(cycleAwareHours) || cycleAwareHours.length === 0) {
    return `${prefix} removed all requested hours`;
  }
  return `${prefix} capped at F${String(cycleAwareHours.at(-1)).padStart(3, "0")}`;
}

// Mirrors resolveHoursByModel's precedence for the two channels a user can
// request custom hours through: a per-model --hours-<model> /
// MODELVIEW_NOAA_<MODEL>_HOURS always means custom hours, and the global
// --hours / MODELVIEW_NOAA_BETA_HOURS does unless it spells "full" (fullRun),
// where the roster is a computed default rather than a user-picked list.
function modelHasExplicitHoursRequest({ args, modelKey, fullRun, env = process.env }) {
  const envKey = `MODELVIEW_NOAA_${modelKey.toUpperCase()}_HOURS`;
  if (args[`hours-${modelKey}`] || env[envKey]) {
    return true;
  }
  return Boolean(!fullRun && (args.hours || env.MODELVIEW_NOAA_BETA_HOURS));
}

// The cycle filter trimming a default roster is routine (HRRR standard
// cycles end at F018) and keeps the historical log-and-proceed behavior. But
// EMPTYING an explicitly requested roster means the user asked only for
// hours this cycle cannot serve; proceeding would "succeed" with a zero-frame
// model build, so fail loudly instead (the --max-hour empty-roster check in
// resolveHoursByModel is the precedent).
function applyCycleHorizonFilter({ modelKey, run, hours, explicitHours, log = console.log }) {
  const cycleAwareHours = filterNoaaForecastHoursForCycle(modelKey, run.cycle, hours);
  if (cycleAwareHours.length !== hours.length) {
    log(formatCycleHorizonCapMessage(modelKey, run, cycleAwareHours));
  }
  if (cycleAwareHours.length === 0 && explicitHours) {
    throw new Error(
      `${modelKey} ${run.date} ${run.cycle}Z cycle horizon removed all explicitly requested hours (${hours.join(",")}); ` +
        `request hours within this cycle's horizon or drop the --hours/--hours-${modelKey} override.`,
    );
  }
  return cycleAwareHours;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const models = resolveModels(args.models || args.model || process.env.MODELVIEW_NOAA_BETA_MODELS || "nam");
  const viewKey = String(args.view || DEFAULT_VIEW_KEY).trim() || DEFAULT_VIEW_KEY;
  if (!VIEW_CONFIG[viewKey]) {
    throw new Error(`Unsupported view '${viewKey}'. Supported: ${Object.keys(VIEW_CONFIG).join(", ")}`);
  }
  // Selective render scope (design §1.4). null ⇒ all categories/full tier (today's byte-identical output).
  const renderSelection = parseRenderSelectionFromArgs(args, {
    models,
    view: viewKey,
    run: args.run || "latest",
  });
  if (renderSelection) {
    const enabledCategories = Object.entries(renderSelection.categories)
      .filter(([, value]) => (typeof value === "object" ? value.enabled : value))
      .map(([id, value]) => (typeof value === "object" ? `${id}:${value.tier}` : id));
    console.log(`[noaa-beta] render selection categories=${enabledCategories.join(",") || "(none)"}`);
    if (renderSelection.sciencePrototypes?.length) {
      console.log(`[noaa-beta] science prototypes=${renderSelection.sciencePrototypes.join(",")}`);
    }
  }

  const fullRun = isFullRunRequest(args);
  const requireFullHorizon = parseBooleanOption(
    args["require-full-horizon"] || process.env.MODELVIEW_NOAA_REQUIRE_FULL_HORIZON,
    false,
  );
  const gfsHourlyThrough120 = parseBooleanOption(
    args["gfs-hourly-through-120"] || process.env.MODELVIEW_NOAA_GFS_HOURLY_THROUGH_120,
    false,
  );
  const explicitRun = args.date !== undefined || args.cycle !== undefined;
  const capAvailableHours = shouldCapAvailableHours({ fullRun, requireFullHorizon, explicitRun });
  const hoursByModel = resolveHoursByModel({ args, models, fullRun });
  const runOffset = clampInt(numberFlag(args["run-offset"], process.env.MODELVIEW_NOAA_RUN_OFFSET, 0), 0, 24, 0);
  const resources = getResourceSnapshot();
  const {
    modelConcurrency,
    frameConcurrency,
    workerCount,
    totalFrameConcurrency,
    rangeFetchConcurrency,
    totalRangeFetchConcurrency,
    decodeConcurrency,
    totalDecodeConcurrency,
    frameRetries,
    retryDelayMs,
    retryFrameConcurrency,
    retryFrameConcurrencyExplicit,
  } = resolveParallelism({ args, resources, models });
  // Intra-frame derived-grid parallelism is a latency tool for builds whose
  // planned frame count leaves cores idle (interactive/selective builds,
  // short rosters). The default "auto" resolves once rosters are final —
  // see resolveDerivedCellConcurrency; builds with at least a pool-width of
  // frames, and builds with explicit frame throttles, resolve to 1 (off,
  // exactly the pre-auto behavior).
  const derivedCellConcurrencyInput =
    args["derived-cell-concurrency"] !== undefined
      ? args["derived-cell-concurrency"]
      : process.env.MODELVIEW_NOAA_DERIVED_CELL_CONCURRENCY;
  // Compression helper threads are resolved after the final frame rosters so
  // auto can spend genuinely idle cores without multiplying helpers across a
  // saturated outer pool. Explicit 0-4 values retain the old force-override
  // contract.
  const compressThreadsInput =
    args["compress-threads"] !== undefined ? args["compress-threads"] : process.env.MODELVIEW_NOAA_COMPRESS_THREADS;
  const compressThreadsExplicit = hasExplicitOptionValue(compressThreadsInput);
  const explicitFrameThrottle =
    isExplicitNumberFlag(args["worker-count"]) ||
    isExplicitNumberFlag(args["total-frame-concurrency"]) ||
    isExplicitNumberFlag(process.env.MODELVIEW_NOAA_WORKER_COUNT) ||
    isExplicitNumberFlag(process.env.MODELVIEW_NOAA_TOTAL_FRAME_CONCURRENCY);
  const explicitCompressionFrameThrottle =
    explicitFrameThrottle ||
    isExplicitNumberFlag(args["frame-concurrency"]) ||
    isExplicitNumberFlag(args["global-frame-concurrency"]) ||
    isExplicitNumberFlag(process.env.MODELVIEW_NOAA_FRAME_CONCURRENCY) ||
    isExplicitNumberFlag(process.env.MODELVIEW_NOAA_GLOBAL_FRAME_CONCURRENCY);
  // Background main-GRIB prefetch keeps the network busy while workers
  // compute (cold builds otherwise alternate fetch waves with compute
  // waves). Cache-warming only — the worker fetch path is unchanged and
  // authoritative — so it defaults on; 0/"off" disables, unrecognized
  // values warn and disable.
  const inputPrefetchConcurrency = resolveInputPrefetchConcurrency(
    args["input-prefetch"] !== undefined ? args["input-prefetch"] : process.env.MODELVIEW_NOAA_INPUT_PREFETCH,
  );
  const cacheRoot = resolveBuilderCacheRoot(args["cache-root"]);
  const artifactPrefix = String(
    args["artifact-prefix"] || process.env.MODELVIEW_ARTIFACT_PREFIX || DEFAULT_ARTIFACT_PREFIX,
  ).trim();
  const noaaBaseUrls = resolveNoaaBaseUrls(args, models);
  const wgrib2Path = String(args.wgrib2 || process.env.WGRIB2 || defaultWgrib2Path()).trim() || "wgrib2";
  const reflectivityGates = parseReflectivityGates(
    args["reflectivity-gates"] || process.env.MODELVIEW_REFLECTIVITY_GATES || DEFAULT_REFLECTIVITY_GATES.join(","),
  );
  const forceFrames = parseBooleanOption(args.force || process.env.MODELVIEW_NOAA_FORCE_RENDER, false);
  const profileFrames = parseBooleanOption(
    args.profile || args["profile-frames"] || process.env.MODELVIEW_NOAA_PROFILE,
    false,
  );
  const writeBenchmarkReceipt = createBenchmarkReceiptWriter();
  if (writeBenchmarkReceipt) {
    if (!profileFrames) {
      throw new Error(`${BENCHMARK_RECEIPT_ENV}=1 requires frame profiling.`);
    }
    writeBenchmarkReceipt(
      buildCatalogColorLookupBenchmarkReceipt(STATIC_CONTINUOUS_COLOR_LOOKUP_STATE, {
        role: "builder-main",
        spawnOrdinal: 0,
      }),
    );
    writeBenchmarkReceipt(
      initializeSnowRfBenchmarkRole({
        role: "builder-main",
        spawnOrdinal: 0,
        threadId: 0,
      }),
    );
  }
  const globalFrameQueue =
    models.length > 1 &&
    parseBooleanOption(args["global-frame-queue"] ?? process.env.MODELVIEW_NOAA_GLOBAL_FRAME_QUEUE, true);
  const globalFrameConcurrency = clampInt(
    numberFlag(
      args["global-frame-concurrency"],
      process.env.MODELVIEW_NOAA_GLOBAL_FRAME_CONCURRENCY,
      Math.max(frameConcurrency, workerCount * 2),
    ),
    1,
    96,
    Math.max(frameConcurrency, workerCount * 2),
  );
  // The global queue historically raised retry concurrency to pool width;
  // keep that as its DEFAULT, but an explicit --retry-frame-concurrency /
  // MODELVIEW_NOAA_RETRY_FRAME_CONCURRENCY wins — a user throttling retries
  // during NOMADS throttling means it. The per-model path always honored the
  // resolved value; both schedulers now agree on explicit flags.
  const effectiveRetryFrameConcurrency =
    globalFrameQueue && !retryFrameConcurrencyExplicit
      ? Math.max(retryFrameConcurrency, Math.min(workerCount, globalFrameConcurrency))
      : retryFrameConcurrency;
  const persistManifestEachFrame = parseBooleanOption(
    args["persist-manifest-each-frame"] ?? process.env.MODELVIEW_NOAA_PERSIST_MANIFEST_EACH_FRAME,
    !globalFrameQueue,
  );
  const globalPersistQueue =
    globalFrameQueue &&
    parseBooleanOption(args["global-persist-queue"] ?? process.env.MODELVIEW_NOAA_GLOBAL_PERSIST_QUEUE, false);
  const defaultGlobalPersistConcurrency = Math.max(2, Math.min(8, Math.ceil(workerCount / 3)));
  const globalPersistConcurrency = clampInt(
    numberFlag(
      args["global-persist-concurrency"],
      process.env.MODELVIEW_NOAA_GLOBAL_PERSIST_CONCURRENCY,
      defaultGlobalPersistConcurrency,
    ),
    1,
    32,
    defaultGlobalPersistConcurrency,
  );
  const defaultGlobalPersistBacklog = Math.max(globalFrameConcurrency, globalPersistConcurrency * 4);
  const globalPersistBacklog = clampInt(
    numberFlag(
      args["global-persist-backlog"],
      process.env.MODELVIEW_NOAA_GLOBAL_PERSIST_BACKLOG,
      defaultGlobalPersistBacklog,
    ),
    globalPersistConcurrency,
    192,
    defaultGlobalPersistBacklog,
  );
  const defaultSnowPersistConcurrency = globalPersistConcurrency;
  const snowPersistConcurrency = clampInt(
    numberFlag(
      args["snow-persist-concurrency"],
      process.env.MODELVIEW_NOAA_SNOW_PERSIST_CONCURRENCY,
      defaultSnowPersistConcurrency,
    ),
    1,
    32,
    defaultSnowPersistConcurrency,
  );
  const defaultSnowPersistBacklog = Math.max(globalFrameConcurrency, snowPersistConcurrency * 4);
  const snowPersistBacklog = clampInt(
    numberFlag(
      args["snow-persist-backlog"],
      process.env.MODELVIEW_NOAA_SNOW_PERSIST_BACKLOG,
      defaultSnowPersistBacklog,
    ),
    snowPersistConcurrency,
    192,
    defaultSnowPersistBacklog,
  );
  const defaultArtifactWriteConcurrency = 0;
  const artifactWriteConcurrency = clampInt(
    numberFlag(
      args["artifact-write-concurrency"],
      process.env.MODELVIEW_ARTIFACT_WRITE_CONCURRENCY,
      defaultArtifactWriteConcurrency,
    ),
    0,
    256,
    defaultArtifactWriteConcurrency,
  );
  const renderWidth = parseOptionalNumber(args.width, null);
  const renderHeight = parseOptionalNumber(args.height, null);

  await ensureWgrib2Available(wgrib2Path);
  const sourceProvenanceCatalog = buildRunSourceProvenanceCatalog({
    toolIdentity: await getWgrib2ProvenanceIdentity(wgrib2Path),
  });
  const latestMetadataByModel = new Map();
  await runWithConcurrency(models, Math.min(models.length, 4), async (modelKey) => {
    const noaaBaseUrl = noaaBaseUrls[modelKey];
    let hours = hoursByModel[modelKey];
    const run = await resolveNoaaModelRun({
      modelKey,
      noaaBaseUrl,
      date: args.date,
      cycle: args.cycle,
      hours,
      runOffset,
      requireAllHours: !capAvailableHours,
    });
    hours = applyCycleHorizonFilter({
      modelKey,
      run,
      hours,
      explicitHours: modelHasExplicitHoursRequest({ args, modelKey, fullRun }),
    });
    hoursByModel[modelKey] = hours;
    if (capAvailableHours) {
      hours = await resolveAvailableNoaaHours({ modelKey, noaaBaseUrl, run, hours });
      hoursByModel[modelKey] = hours;
    }
    const parameterSet = await resolveNoaaParameterSetForRun({
      modelKey,
      noaaBaseUrl,
      run,
      hours,
      renderSelection,
    });
    latestMetadataByModel.set(
      modelKey,
      buildNoaaModelMetadata({
        modelKey,
        run,
        hours,
        noaaBaseUrl,
        ...parameterSet,
        renderSelection,
        gfsHourlyThrough120,
        sourceProvenanceCatalog,
        reflectivityGates,
      }),
    );
  });
  const fullParameterOrder = getNoaaNamParameterOrder(renderSelection);
  for (const modelKey of models) {
    const metadata = latestMetadataByModel.get(modelKey);
    const parameterOrder = Array.isArray(metadata?.parameterOrder) ? metadata.parameterOrder : [];
    const filtered = fullParameterOrder.filter((key) => !parameterOrder.includes(key));
    console.log(
      `[noaa-beta] ${modelKey}/${viewKey} parameters=${parameterOrder.length}/${fullParameterOrder.length}${
        filtered.length > 0 ? ` filtered=${filtered.join(",")}` : ""
      }`,
    );
  }
  // Rosters are final here (capAvailableHours may have shrunk them), so the
  // auto rule sees the frame count the queue will actually run.
  const plannedFrameCount = models.reduce(
    (sum, modelKey) => sum + (Array.isArray(hoursByModel[modelKey]) ? hoursByModel[modelKey].length : 0),
    0,
  );
  const derivedCellConcurrency = resolveDerivedCellConcurrency({
    input: derivedCellConcurrencyInput,
    cpuCount: resources.cpuCount,
    totalFrameConcurrency,
    workerCount,
    plannedFrameCount,
    explicitFrameThrottle,
  });
  const compressThreads = resolveCompressThreadsForBuild({
    input: compressThreadsInput,
    inputExplicit: compressThreadsExplicit,
    cpuCount: resources.cpuCount,
    freeGb: resources.freeGb,
    totalFrameConcurrency,
    workerCount,
    plannedFrameCount,
    explicitFrameThrottle: explicitCompressionFrameThrottle,
  });
  const rawCacheDir = path.join(cacheRoot, "raw-noaa");
  const noaaWorkerPool = new FrameWorkerPool({
    workerPath: String(args["worker-script"] || process.env.MODELVIEW_NOAA_WORKER_SCRIPT || DEFAULT_NOAA_WORKER_PATH),
    size: workerCount,
    requireStartupReceipt: Boolean(writeBenchmarkReceipt),
    requiredStartupReceiptTypes: writeBenchmarkReceipt
      ? [FRAME_WORKER_STARTUP_RECEIPT_TYPE, SNOW_RF_STARTUP_RECEIPT_TYPE]
      : undefined,
    onStartupReceipt: writeBenchmarkReceipt,
  });

  const runtime = new LocalArtifactRuntime({
    cacheRoot,
    artifactPrefix,
    sourceName: NOAA_BETA_SOURCE_NAME,
    reflectivityGates,
    renderWidth,
    renderHeight,
    artifactWriteConcurrency,
    fetchLatestMetadata: async ({ modelKey }) => {
      const latestMetadata = latestMetadataByModel.get(modelKey);
      if (!latestMetadata) {
        throw new Error(`No NOAA beta metadata prepared for model '${modelKey}'.`);
      }
      return latestMetadata;
    },
    renderFrameArtifacts: (params) =>
      noaaWorkerPool.run({
        ...params,
        noaaBaseUrl: noaaBaseUrls[params.modelKey],
        wgrib2Path,
        rawCacheDir,
        rangeFetchConcurrency,
        decodeConcurrency,
        derivedCellConcurrency,
        compressThreads,
      }),
  });

  await runtime.init();
  try {
    console.log(
      `[noaa-beta] resources cpu=${resources.cpuCount} mem=${resources.memGb.toFixed(1)}GB free=${resources.freeGb.toFixed(1)}GB scheduler=${globalFrameQueue ? "global-frame-queue" : "per-model"} model-concurrency=${modelConcurrency} frame-concurrency=${frameConcurrency} global-frame-concurrency=${globalFrameConcurrency} global-persist-queue=${globalPersistQueue} global-persist-concurrency=${globalPersistConcurrency} global-persist-backlog=${globalPersistBacklog} snow-persist-concurrency=${snowPersistConcurrency} snow-persist-backlog=${snowPersistBacklog} artifact-write-concurrency=${artifactWriteConcurrency || "off"} worker-count=${workerCount} total-frame-concurrency=${totalFrameConcurrency} derived-cell-concurrency=${derivedCellConcurrency} compress-threads=${compressThreads} decode-concurrency=${decodeConcurrency} total-decode-concurrency=${totalDecodeConcurrency} range-concurrency=${rangeFetchConcurrency} total-range-concurrency=${totalRangeFetchConcurrency} persist-manifest-each-frame=${persistManifestEachFrame} run-offset=${runOffset}`,
    );
    console.log(
      `[noaa-beta] building models=${models.join(",")} view=${viewKey} hours=${formatHoursByModel(hoursByModel, models)} cache=${cacheRoot}`,
    );
    let results;
    if (globalFrameQueue) {
      for (const modelKey of models) {
        const latestMetadata = latestMetadataByModel.get(modelKey);
        console.log(`[noaa-beta] ${modelKey}/${viewKey} run=${latestMetadata.runId} start`);
      }
      results = await buildLatestStatesWithGlobalFrameQueue(runtime, models, viewKey, {
        renderSelection,
        inputPrefetch: {
          concurrency: inputPrefetchConcurrency,
          rawCacheDir,
          noaaBaseUrls,
          rangeFetchConcurrency,
        },
        frameConcurrency: globalFrameConcurrency,
        frameRetries,
        retryDelayMs,
        retryFrameConcurrency: effectiveRetryFrameConcurrency,
        forceFrames,
        persistManifestEachFrame,
        persistQueueEnabled: globalPersistQueue,
        persistConcurrency: globalPersistConcurrency,
        persistBacklog: globalPersistBacklog,
        snowPersistConcurrency,
        snowPersistBacklog,
        profileFrames,
        workerPoolStats: () => noaaWorkerPool.getStats(),
        onProgress: (event) => logNoaaProgress(event.modelKey, event, { profileFrames }),
      });
      for (const summary of results.filter(Boolean)) {
        console.log(
          `[noaa-beta] ${summary.modelKey}/${summary.viewKey} run=${summary.runId} complete built=${summary.built} reused=${summary.reused} failed=${summary.failed}`,
        );
      }
    } else {
      results = new Array(models.length);
      await runWithConcurrency(models, modelConcurrency, async (modelKey, index) => {
        const latestMetadata = latestMetadataByModel.get(modelKey);
        console.log(`[noaa-beta] ${modelKey}/${viewKey} run=${latestMetadata.runId} start`);
        const [summary] = await buildLatestStatesWithGlobalFrameQueue(runtime, [modelKey], viewKey, {
          renderSelection,
          inputPrefetch: {
            concurrency: inputPrefetchConcurrency,
            rawCacheDir,
            noaaBaseUrls,
            rangeFetchConcurrency,
          },
          frameConcurrency,
          frameRetries,
          retryDelayMs,
          retryFrameConcurrency,
          forceFrames,
          persistManifestEachFrame,
          persistQueueEnabled: false,
          snowPersistConcurrency,
          snowPersistBacklog,
          profileFrames,
          workerPoolStats: () => noaaWorkerPool.getStats(),
          onProgress: (event) => logNoaaProgress(modelKey, event, { profileFrames }),
        });
        results[index] = summary;
        console.log(
          `[noaa-beta] ${modelKey}/${viewKey} run=${summary.runId} complete built=${summary.built} reused=${summary.reused} failed=${summary.failed}`,
        );
      });
    }
    console.log(
      JSON.stringify(
        {
          models,
          view: viewKey,
          hoursByModel,
          cacheRoot,
          source: NOAA_BETA_SOURCE_NAME,
          resources,
          modelConcurrency,
          frameConcurrency,
          workerCount,
          totalFrameConcurrency,
          derivedCellConcurrency,
          compressThreads,
          globalFrameQueue,
          globalFrameConcurrency,
          globalPersistQueue,
          globalPersistConcurrency,
          globalPersistBacklog,
          snowPersistConcurrency,
          snowPersistBacklog,
          artifactWriteConcurrency,
          decodeConcurrency,
          totalDecodeConcurrency,
          rangeFetchConcurrency,
          totalRangeFetchConcurrency,
          frameRetries,
          retryFrameConcurrency: effectiveRetryFrameConcurrency,
          persistManifestEachFrame,
          forceFrames,
          profileFrames,
          capAvailableHours,
          results: results.filter(Boolean).map((summary) => ({
            model: summary.modelKey,
            view: summary.viewKey,
            run: summary.runId,
            frameCount: summary.frameCount,
            built: summary.built,
            reused: summary.reused,
            failed: summary.failed,
            manifestKey: summary.latestPointer.manifestKey,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await runtime.close();
    await noaaWorkerPool.close();
  }
}

// Intra-frame derived parallelism is byte-identical to serial compute
// (identical code over disjoint cell ranges), so "auto" is purely a core
// budgeting question. Auto engages ONLY when the planned frame count is
// what leaves cores idle (fewer frames than the frame-worker pool is wide):
// a full build keeps its pool saturated for its whole duration and resolves
// to 1 on every machine — including hosts with more cores than the pool cap,
// where the extra cores were never this feature's to spend. An explicit
// --worker-count / --total-frame-concurrency is a user statement about
// machine footprint, so auto never spends cores the user withheld — combine
// an explicit throttle with an explicit --derived-cell-concurrency=N to get
// both. Explicit numbers force a mode; "off"/"false"/"no"/"" disable (empty
// string kept the pre-auto off semantics) and "true"/"on"/"yes" mean auto —
// the same boolean vocabulary resolveInputPrefetchConcurrency honors, so the
// two knobs never read the same spelling differently; anything unrecognized
// warns and stays off.
// Input prefetch is a pure cache warmer (see startFrameInputPrefetch in
// scripts/lib/noaa-build/frame-queue.js), so its only knob is how many
// frames' selected GRIBs may download concurrently ahead of the workers.
// The default of 8 slots is sized so one compute wave's worth of frames can
// be warmed during that wave (3 range connections per slot, 24 total): at 3
// slots the pump warmed ~3 frames per wave while 18 workers consumed 18, so
// most of every wave still fell back to synchronized cold worker fetches.
// One boolean-WORD vocabulary for both build-parallelism knobs:
// true/on/yes mean auto, false/no mean off, and anything else passes
// through for numeric/garbage handling. Unlike parseBooleanOption, the
// digits "1"/"0" are NOT booleans here — they are numeric values by
// design ("1" = one unit/serial, "0" = zero/off per each resolver's
// numeric contract), pinned by the resolver tests. The empty string is
// deliberately NOT normalized here either — the two knobs diverge on it
// (derived keeps the pre-auto off semantics, prefetch treats set-but-empty
// as auto) and each resolver owns that decision explicitly.
function normalizeParallelismOption(input) {
  const raw = input === undefined || input === null || input === true ? "auto" : String(input).trim().toLowerCase();
  if (raw === "true" || raw === "on" || raw === "yes") {
    return "auto";
  }
  if (raw === "false" || raw === "no") {
    return "off";
  }
  return raw;
}

function resolveInputPrefetchConcurrency(input) {
  const mode = normalizeParallelismOption(input);
  if (mode === "auto" || mode === "") {
    return 8;
  }
  if (mode === "off") {
    return 0;
  }
  const numeric = Number(mode);
  if (Number.isFinite(numeric)) {
    return clampInt(numeric, 0, 16, 0);
  }
  console.warn(
    `[noaa-beta] unrecognized --input-prefetch / MODELVIEW_NOAA_INPUT_PREFETCH value '${input}'; input prefetch disabled (use 0-16, "auto", or "off")`,
  );
  return 0;
}

// Brotli q0 changed the compression-pool crossover. One helper is now
// neutral for a serial build and materially regressive under saturation;
// two helpers remain a latency win only while at most about half the cores
// are occupied by main frames. Resolve this once per build because each
// frame-worker isolate retains its first compression pool for its lifetime.
function resolveCompressThreadsForBuild({
  input,
  inputExplicit = false,
  cpuCount,
  freeGb,
  totalFrameConcurrency,
  workerCount,
  plannedFrameCount,
  explicitFrameThrottle = false,
}) {
  const mode = normalizeParallelismOption(input);
  if (mode === "off" || mode === "0") {
    return 0;
  }
  if (mode !== "auto" && mode !== "") {
    const numeric = Number(mode);
    if (Number.isFinite(numeric)) {
      return clampInt(numeric, 0, 4, 0);
    }
    console.warn(
      `[noaa-beta] unrecognized --compress-threads / MODELVIEW_NOAA_COMPRESS_THREADS value '${input}'; compression helpers stay off (use "auto", "off", or 0-4)`,
    );
    return 0;
  }

  // A blank template value is the default auto policy, matching the old
  // blank-means-default numberFlag contract. Do not spend cores that an outer
  // frame throttle explicitly withheld unless the user also explicitly asks
  // for compression auto/helpers.
  if (explicitFrameThrottle && !inputExplicit) {
    return 0;
  }
  const cores = Math.max(1, Math.floor(Number(cpuCount) || 1));
  const activeMainFrames = Math.max(
    1,
    Math.min(
      Math.max(1, Math.floor(Number(plannedFrameCount) || 1)),
      Math.max(1, Math.floor(Number(totalFrameConcurrency) || 1)),
      Math.max(1, Math.floor(Number(workerCount) || 1)),
    ),
  );
  // The measured 18-core boundary was 8 frames winning and 12 losing; keep
  // the unmeasured 9-frame midpoint on the conservative inline side.
  const helperFrameLimit = Math.max(1, Math.floor((cores - 1) / 2));
  if (activeMainFrames > helperFrameLimit) {
    return 0;
  }

  // Helper inputs/fallback sources raised RSS by roughly 1.5 GiB per active
  // producer in the measured crossover matrix. Preserve an 8 GiB operating
  // reserve; unknown memory telemetry does not disable an otherwise measured
  // latency win.
  const availableGb = Number(freeGb);
  const requiredFreeGb = 8 + activeMainFrames * 1.5;
  if (Number.isFinite(availableGb) && availableGb < requiredFreeGb) {
    return 0;
  }
  return 2;
}

function resolveDerivedCellConcurrency({
  input,
  cpuCount,
  totalFrameConcurrency,
  workerCount,
  plannedFrameCount,
  explicitFrameThrottle,
}) {
  const mode = normalizeParallelismOption(input);
  if (mode === "off" || mode === "") {
    return 1;
  }
  const poolWidth = Math.max(1, Math.min(totalFrameConcurrency, workerCount));
  if (mode !== "auto") {
    const numeric = Number(mode);
    if (Number.isFinite(numeric)) {
      const value = clampInt(numeric, 1, 16, 1);
      // Explicit values are honored verbatim (a throttled pool plus an
      // explicit sub-pool width is a sanctioned combination), but flag the
      // regime where the multiplication oversubscribes the machine: a
      // saturated frame pool times per-frame sub-pools is value x workers
      // threads, which auto would never spend.
      if (value > 1 && plannedFrameCount >= poolWidth && value * workerCount > cpuCount) {
        console.warn(
          `[noaa-beta] explicit --derived-cell-concurrency=${value} with a saturated frame pool (${plannedFrameCount} frames, pool width ${poolWidth}) can spawn ${value} sub-workers in each of ${workerCount} frame workers (${value * workerCount} threads on ${cpuCount} cores); auto picks 1 in this regime`,
        );
      }
      return value;
    }
    console.warn(
      `[noaa-beta] unrecognized --derived-cell-concurrency value '${input}'; intra-frame derived parallelism stays off (use "auto", "off", or 1-16)`,
    );
    return 1;
  }
  if (explicitFrameThrottle) {
    return 1;
  }
  if (!(plannedFrameCount >= 1) || plannedFrameCount >= poolWidth) {
    return 1;
  }
  // Pull-based chunk dispatch scales cleanly onto efficiency cores (measured
  // parallel-stage 591 -> 330 ms going 8 -> 16 on a 6P+12E machine), so the
  // cap matches the explicit-override clamp rather than stopping at 8.
  return clampInt(Math.floor(cpuCount / plannedFrameCount), 1, 16, 1);
}

function resolveParallelism({ args, resources, models }) {
  const defaultTotalFrameConcurrency = Math.max(1, Math.min(32, Math.ceil(resources.cpuCount * 1.33)));
  const defaultWorkerCount = Math.min(18, defaultTotalFrameConcurrency);
  const defaultModelConcurrency = Math.max(1, Math.min(models.length, Math.max(1, Math.ceil(resources.cpuCount / 4))));
  const defaultFrameConcurrency = defaultTotalFrameConcurrency;
  const defaultTotalRangeFetchConcurrency = Math.max(8, Math.min(128, resources.cpuCount * 4));
  const totalFrameConcurrency = clampInt(
    numberFlag(
      args["total-frame-concurrency"],
      process.env.MODELVIEW_NOAA_TOTAL_FRAME_CONCURRENCY,
      defaultTotalFrameConcurrency,
    ),
    1,
    64,
    defaultTotalFrameConcurrency,
  );
  const modelConcurrency = clampInt(
    numberFlag(args["model-concurrency"], process.env.MODELVIEW_NOAA_MODEL_CONCURRENCY, defaultModelConcurrency),
    1,
    models.length,
    defaultModelConcurrency,
  );
  // --total-frame-concurrency is a machine-footprint statement: unless the
  // user also sets the finer knobs explicitly, it must cap the frame and
  // worker defaults (the old code put the cap in clampInt's non-finite
  // fallback slot, which numberFlag's finite default made unreachable — the
  // flag scheduled nothing).
  const cappedFrameConcurrencyDefault = Math.min(defaultFrameConcurrency, totalFrameConcurrency);
  const cappedWorkerCountDefault = Math.min(defaultWorkerCount, totalFrameConcurrency);
  const frameConcurrency = clampInt(
    numberFlag(args["frame-concurrency"], process.env.MODELVIEW_NOAA_FRAME_CONCURRENCY, cappedFrameConcurrencyDefault),
    1,
    64,
    cappedFrameConcurrencyDefault,
  );
  const workerCount = clampInt(
    numberFlag(args["worker-count"], process.env.MODELVIEW_NOAA_WORKER_COUNT, cappedWorkerCountDefault),
    1,
    48,
    cappedWorkerCountDefault,
  );
  const totalRangeFetchConcurrency = clampInt(
    numberFlag(
      args["total-range-concurrency"],
      process.env.MODELVIEW_NOAA_TOTAL_RANGE_CONCURRENCY,
      defaultTotalRangeFetchConcurrency,
    ),
    1,
    256,
    defaultTotalRangeFetchConcurrency,
  );
  const defaultRangeFetchConcurrency = Math.max(1, Math.ceil(totalRangeFetchConcurrency / workerCount));
  const rangeFetchConcurrency = clampInt(
    numberFlag(args["range-concurrency"], process.env.MODELVIEW_NOAA_RANGE_CONCURRENCY, defaultRangeFetchConcurrency),
    1,
    64,
    defaultRangeFetchConcurrency,
  );
  const defaultDecodeConcurrency = Math.max(
    1,
    Math.min(3, Math.ceil(resources.cpuCount / Math.max(1, Math.ceil(workerCount / 2)))),
  );
  const decodeConcurrency = clampInt(
    numberFlag(args["decode-concurrency"], process.env.MODELVIEW_NOAA_DECODE_CONCURRENCY, defaultDecodeConcurrency),
    1,
    8,
    defaultDecodeConcurrency,
  );
  const frameRetries = clampInt(
    numberFlag(args["frame-retries"], process.env.MODELVIEW_FRAME_RETRIES, DEFAULT_FRAME_RETRIES),
    0,
    5,
    DEFAULT_FRAME_RETRIES,
  );
  const retryDelayMs = clampInt(
    numberFlag(args["retry-delay-ms"], process.env.MODELVIEW_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
    0,
    60_000,
    DEFAULT_RETRY_DELAY_MS,
  );
  const retryFrameConcurrencyExplicit =
    isExplicitNumberFlag(args["retry-frame-concurrency"]) ||
    isExplicitNumberFlag(process.env.MODELVIEW_NOAA_RETRY_FRAME_CONCURRENCY);
  const retryFrameConcurrency = clampInt(
    numberFlag(
      args["retry-frame-concurrency"],
      process.env.MODELVIEW_NOAA_RETRY_FRAME_CONCURRENCY,
      Math.max(1, Math.min(2, Math.ceil(frameConcurrency / 3))),
    ),
    1,
    frameConcurrency,
    1,
  );
  return {
    modelConcurrency,
    frameConcurrency,
    workerCount,
    totalFrameConcurrency,
    rangeFetchConcurrency,
    totalRangeFetchConcurrency: workerCount * rangeFetchConcurrency,
    decodeConcurrency,
    totalDecodeConcurrency: workerCount * decodeConcurrency,
    frameRetries,
    retryDelayMs,
    retryFrameConcurrency,
    retryFrameConcurrencyExplicit,
  };
}

function resolveNoaaParameterSetFromIdxText(indexText, options = {}) {
  return resolveNoaaParameterSetFromIdxTexts([indexText], options);
}

function getResourceSnapshot() {
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  const memGb = os.totalmem() / 1024 ** 3;
  const freeGb = os.freemem() / 1024 ** 3;
  return {
    cpuCount,
    memGb: Number(memGb.toFixed(1)),
    freeGb: Number(freeGb.toFixed(1)),
  };
}

function logNoaaProgress(modelKey, event, options = {}) {
  if (!event) {
    return;
  }
  const loggedAtMs = Date.now();
  const loggedAt = formatLogTime(new Date(loggedAtMs));
  const profileSuffix = options.profileFrames ? formatRenderProfile(event.renderProfile) : "";
  const hour = Number.isFinite(event.hour) ? `F${String(Math.round(event.hour)).padStart(3, "0")}` : "frame";
  const label = formatFrameProgressLabel(modelKey, event, hour);
  const progressKey = frameProgressKey(modelKey, event, hour);
  const validLabel = event.validTime ? ` valid=${event.validTime}` : "";
  if (event.type === "frame-start") {
    const retryLabel = event.retryAttempt ? ` retry ${event.retryAttempt}` : "";
    FRAME_PROGRESS_STARTS.set(progressKey, loggedAtMs);
    console.log(`[noaa-beta] ${label}${retryLabel} start=${loggedAt}${validLabel}`);
  } else if (event.type === "frame-complete") {
    const retryLabel = event.retryAttempt ? ` retry ${event.retryAttempt}` : "";
    const elapsedLabel = formatFrameElapsed(progressKey, loggedAtMs, event.renderProfile);
    FRAME_PROGRESS_STARTS.delete(progressKey);
    console.log(
      `[noaa-beta] ${label}${retryLabel} complete finish=${loggedAt}${elapsedLabel}${validLabel}${profileSuffix}`,
    );
  } else if (event.type === "frame-part-complete") {
    const retryLabel = event.retryAttempt ? ` retry ${event.retryAttempt}` : "";
    const elapsedLabel = formatFrameElapsed(progressKey, loggedAtMs, event.renderProfile);
    FRAME_PROGRESS_STARTS.delete(progressKey);
    console.log(
      `[noaa-beta] ${label}${retryLabel} partial finish=${loggedAt}${elapsedLabel}${validLabel}${profileSuffix}`,
    );
  } else if (event.type === "frame-reused") {
    const retryLabel = event.retryAttempt ? ` retry ${event.retryAttempt}` : "";
    console.log(`[noaa-beta] ${label}${retryLabel} reused at=${loggedAt}${validLabel}`);
  } else if (event.type === "frame-error") {
    const retryLabel = event.retryAttempt ? ` retry ${event.retryAttempt}` : "";
    const elapsedLabel = formatFrameElapsed(progressKey, loggedAtMs, event.renderProfile);
    FRAME_PROGRESS_STARTS.delete(progressKey);
    console.warn(
      `[noaa-beta] ${label}${retryLabel} error finish=${loggedAt}${elapsedLabel}${validLabel}: ${event.error}`,
    );
  } else if (event.type === "retry-start") {
    console.warn(
      `[noaa-beta] ${formatFrameProgressLabel(modelKey, event, "frames")} retry ${event.retryAttempt}/${event.maxRetries} at=${loggedAt}: ${event.failedFrames} failed frame(s) in ${event.delayMs}ms`,
    );
  }
}

function frameProgressKey(modelKey, event, hour) {
  return [
    modelKey || event?.modelKey || "",
    event?.runId || "",
    event?.viewKey || "",
    hour,
    event?.renderPart && event.renderPart !== "all" ? event.renderPart : "",
    Math.max(0, Math.round(Number(event?.retryAttempt) || 0)),
  ].join("|");
}

function formatFrameProgressLabel(modelKey, event, hour) {
  const runLabel = event?.runId ? `/${event.runId}` : "";
  const partLabel = event?.renderPart && event.renderPart !== "all" ? ` ${event.renderPart}` : "";
  return `${modelKey || event?.modelKey || "model"}${runLabel} ${hour}${partLabel}`;
}

function formatFrameElapsed(progressKey, loggedAtMs, renderProfile) {
  const startedAtMs = FRAME_PROGRESS_STARTS.get(progressKey);
  if (Number.isFinite(startedAtMs)) {
    return ` elapsed=${formatDurationMs(loggedAtMs - startedAtMs)}`;
  }
  const fallbackMs = Number(renderProfile?.stages?.totalMs || 0) + Number(renderProfile?.stages?.persistMs || 0);
  return fallbackMs > 0 ? ` elapsed=${formatDurationMs(fallbackMs)}` : "";
}

function formatLogTime(date) {
  return [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join(":");
}

function formatDurationMs(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value - minutes * 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function formatRenderProfile(profile) {
  if (!profile?.stages || typeof profile.stages !== "object") {
    return "";
  }
  const stages = profile.stages;
  const orderedStageKeys = [
    "totalMs",
    "indexMs",
    "headMs",
    "selectedGribPackProbeMs",
    "materializeMs",
    "rangeFetchMs",
    "selectedGribWriteMs",
    "derivedCacheReadMs",
    "decodeMs",
    "precipAccumPlanMs",
    "precipAccumSourceMs",
    "precipAccumComposeMs",
    "runMaxAccumMs",
    "snowLiquidPlanMs",
    "snowLiquidSourceMs",
    "snowLiquidComposeMs",
    "snowfallDeltaMs",
    "snowfallCumulativeMs",
    "profileDecodeMs",
    "derivedGridMs",
    "derivedGridParallelMs",
    "wgribRegridMs",
    "wgribExportMs",
    "gridMapMs",
    "regridBinPersistMs",
    "artifactsMs",
    "artifactPrepMs",
    "corePngMs",
    "catalogPngMs",
    "synopticMs",
    "hoverGridMs",
    "artifactBackpressureMs",
    "compressWaitMs",
    "persistMs",
  ];
  const parts = [];
  for (const key of orderedStageKeys) {
    const value = Number(stages[key]);
    if (Number.isFinite(value)) {
      parts.push(`${profileStageLabel(key)}=${value.toFixed(1)}ms`);
    }
  }
  if (profile.selectedGribCacheHit) {
    parts.push("raw=cache");
  } else if (Number.isFinite(Number(profile.selectedBytes)) && Number(profile.selectedBytes) > 0) {
    parts.push(`raw=${formatBytes(profile.selectedBytes)}`);
  }
  if (Number(profile.precipAccumSourceCount) > 0) {
    parts.push(
      `apcpSrc=${profile.precipAccumSourceCount}`,
      `apcpCache=${profile.precipAccumGridCacheHits}/${profile.precipAccumSourceCount}`,
    );
  }
  appendHitMissCounter(parts, "regridBin", profile.regridBinCacheHits, profile.regridBinCacheMisses);
  appendPositiveCounter(parts, "fastPackProbes", profile.selectedGribFastPackProbes);
  appendPositiveCounter(parts, "fastPackMetadataHits", profile.selectedGribFastPackMetadataHits);
  appendPositiveCounter(parts, "hashBypasses", profile.selectedGribHashBypasses);
  if (Number(profile.selectedGribHashBypassBytes) > 0) {
    parts.push(`hashBypassBytes=${Number(profile.selectedGribHashBypassBytes)}`);
  }
  appendPositiveCounter(parts, "fastPackFallbacks", profile.selectedGribFastPackFallbacks);
  appendPositiveCounter(parts, "verifyHashes", profile.selectedGribVerifyHashes);
  if (Number(profile.selectedGribVerifyHashBytes) > 0) {
    parts.push(`verifyHashBytes=${Number(profile.selectedGribVerifyHashBytes)}`);
  }
  appendPositiveCounter(parts, "regridBinWriteFailures", profile.regridBinCacheWriteFailures);
  appendPositiveCounter(parts, "regridBinCorruptions", profile.regridBinCacheCorruptions);
  const regridPackEntriesRead = Number(profile.regridBinPackEntriesRead) || 0;
  const regridPackEntriesSkipped = Number(profile.regridBinPackEntriesSkipped) || 0;
  if (regridPackEntriesRead + regridPackEntriesSkipped > 0) {
    parts.push(`regridFields=${regridPackEntriesRead}/${regridPackEntriesRead + regridPackEntriesSkipped}`);
  }
  const regridPackBytesRead = Number(profile.regridBinPackBytesRead) || 0;
  const regridPackBytesSkipped = Number(profile.regridBinPackBytesSkipped) || 0;
  if (regridPackBytesRead + regridPackBytesSkipped > 0) {
    parts.push(`regridBytes=${regridPackBytesRead}/${regridPackBytesRead + regridPackBytesSkipped}`);
  }
  appendHitMissCounter(parts, "regridSparse", profile.regridBinSparseHits, profile.regridBinSparseDeclines);
  appendHitMissCounter(parts, "derivedGrids", profile.derivedGridCacheHits, profile.derivedGridCacheMisses);
  appendHitMissCounter(
    parts,
    "supplementalCache",
    profile.supplementalDerivedGridCacheHits,
    profile.supplementalDerivedGridCacheMisses,
  );
  if (Number(profile.derivedParallelChunks) > 0) {
    parts.push(`derivedParallel=${profile.derivedParallelChunks}chunks/${profile.derivedParallelWorkers}workers`);
  }
  appendPositiveCounter(parts, "bulkDecodeFallbacks", profile.bulkDecodeFallbacks);
  appendHitMissCounter(parts, "runMaxCache", profile.runMaxGridCacheHits, profile.runMaxGridCacheMisses);
  appendHitMissCounter(parts, "runMaxSrcCache", profile.runMaxSourceCacheHits, profile.runMaxSourceCacheMisses);
  appendPositiveCounter(parts, "recordGridHits", profile.decodedRecordGridHits);
  appendPositiveCounter(parts, "sourceRegistryHits", profile.sourceGridRegistryHits);
  appendPositiveCounter(parts, "profileRegistryHits", profile.profileGridRegistryHits);
  appendPositiveCounter(parts, "apcpRegistryHits", profile.precipAccumSourceRegistryHits);
  appendPositiveCounter(parts, "snowLiquidRegistryHits", profile.snowLiquidSourceRegistryHits);
  appendPositiveCounter(parts, "frzrLiquidRegistryHits", profile.freezingRainLiquidSourceRegistryHits);
  appendPositiveCounter(parts, "runMaxLockTimeouts", profile.runMaxGridLockTimeouts);
  appendPositiveCounter(parts, "runMaxSrcLockTimeouts", profile.runMaxSourceLockTimeouts);
  appendSnowfallProfileCounters(parts, profile);
  appendDcapeStats(parts, profile);
  if (Number(profile.artifactWriteCount) > 0) {
    parts.push(`writes=${profile.artifactWriteCount}`);
  }
  if (Number(profile.artifactWriteBytes) > 0) {
    parts.push(`writeBytes=${formatBytes(profile.artifactWriteBytes)}`);
  }
  if (Number(profile.rangeFetchRetries) > 0) {
    parts.push(`rangeRetries=${profile.rangeFetchRetries}`);
  }
  return parts.length > 0 ? ` profile ${parts.join(" ")}` : "";
}

function profileStageLabel(key) {
  if (key === "totalMs") {
    return "wall";
  }
  if (key === "snowfallDeltaMs") {
    return "snowDelta";
  }
  if (key === "snowfallCumulativeMs") {
    return "snowfallCumulative";
  }
  if (key === "profileDecodeMs") {
    return "profileDecode";
  }
  return String(key || "").replace(/Ms$/, "");
}

function appendDcapeStats(parts, profile) {
  const stats = profile?.dcapeStats;
  if (!stats || Number(stats.finiteCount) <= 0) {
    return;
  }
  parts.push(
    `dcape=${stats.min}/${stats.p50}/${stats.p90}/${stats.p99}/${stats.max}Jkg`,
    `dcapeClamp=${Number(stats.topClampPct || 0).toFixed(3)}%`,
  );
}

function appendSnowfallProfileCounters(parts, profile) {
  if (Number(profile.snowLiquidSourceCount) > 0) {
    parts.push(
      `snowLiquidSrc=${profile.snowLiquidSourceCount}`,
      `snowLiquidCache=${profile.snowLiquidGridCacheHits}/${profile.snowLiquidSourceCount}`,
    );
  }
  if (Number(profile.freezingRainLiquidSourceCount) > 0) {
    parts.push(
      `frzrLiquidSrc=${profile.freezingRainLiquidSourceCount}`,
      `frzrLiquidCache=${profile.freezingRainLiquidGridCacheHits}/${profile.freezingRainLiquidSourceCount}`,
    );
  }
  if (Number(profile.snowfallIntervalCount) > 0) {
    parts.push(
      `snowIntervals=${profile.snowfallIntervalActiveCount || 0}/${profile.snowfallIntervalCount}`,
      `snowIntervalSrc=${profile.snowfallIntervalSourceRefs || 0}`,
    );
  }
  appendHitMissCounter(
    parts,
    "snowCumCache",
    profile.snowfallCumulativeCacheHits,
    profile.snowfallCumulativeCacheMisses,
  );
  appendHitMissCounter(parts, "snowDeltaCache", profile.snowfallDeltaCacheHits, profile.snowfallDeltaCacheMisses);
  appendHitMissCounter(parts, "profileCache", profile.profileGridCacheHits, profile.profileGridCacheMisses);
  appendPositiveCounter(parts, "compressJobs", profile.compressPoolJobs);
  appendPositiveCounter(parts, "compressFallbacks", profile.compressPoolFallbacks);
  appendPositiveCounter(parts, "compressOwnedJobs", profile.compressOwnedInputJobs);
  appendPositiveCounter(parts, "compressOwnedBytes", profile.compressOwnedInputBytes);
  appendPositiveCounter(parts, "compressOwnedFallbacks", profile.compressOwnedInputFallbacks);
  appendPositiveCounter(parts, "compressOwnedRebuilds", profile.compressOwnedInputRebuilds);
  appendPositiveCounter(parts, "compressSharedJobs", profile.compressSharedInputJobs);
  appendPositiveCounter(parts, "compressSharedBytes", profile.compressSharedInputBytes);
  appendNonNegativeCounter(parts, "compressSharedInputViewBytes", profile.compressSharedInputViewBytes);
  appendNonNegativeCounter(parts, "compressSharedInputBackingBytes", profile.compressSharedInputBackingBytes);
  appendNonNegativeCounter(parts, "compressSharedInputMaxBytes", profile.compressSharedInputMaxBytes);
  appendNonNegativeCounter(parts, "compressSharedInputUniqueOwners", profile.compressSharedInputUniqueOwners);
  appendPositiveCounter(parts, "compressSharedFallbacks", profile.compressSharedInputFallbacks);
  appendPositiveCounter(parts, "compressTransportRetainedBytes", profile.compressTransportRetainedLiveBytes);
  appendPositiveCounter(parts, "compressTransportPeakBytes", profile.compressTransportPeakLiveBytes);
  const hoverArena = profile.hoverArena;
  if (hoverArena && typeof hoverArena === "object") {
    appendNonNegativeCounter(parts, "hoverArenaVariables", hoverArena.variables);
    appendNonNegativeCounter(parts, "hoverArenaCells", hoverArena.cells);
    appendNonNegativeCounter(parts, "hoverArenaPlaneBytes", hoverArena.planeBytes);
    appendNonNegativeCounter(parts, "hoverArenaHeaderReserveBytes", hoverArena.headerReserveBytes);
    appendNonNegativeCounter(parts, "hoverArenaViewOffsetBytes", hoverArena.viewOffsetBytes);
    appendNonNegativeCounter(parts, "hoverArenaViewBytes", hoverArena.viewBytes);
    appendNonNegativeCounter(parts, "hoverArenaBackingBytes", hoverArena.backingBytes);
    appendNonNegativeCounter(parts, "hoverArenaMaxBytes", hoverArena.maxBytes);
    appendNonNegativeCounter(parts, "hoverArenaBackingSlackBytes", hoverArena.backingSlackBytes);
    appendNonNegativeCounter(parts, "hoverArenaSpeculativeTailBytes", hoverArena.speculativeTailBytes);
    appendNonNegativeCounter(parts, "hoverArenaUniqueOwners", hoverArena.uniqueOwners);
    appendNonNegativeCounter(parts, "hoverArenaCopyBytes", hoverArena.copyBytes);
  }
  appendStringCounter(parts, "hoverArenaFallbackReason", profile.hoverArenaFallbackReason);
  appendPositiveCounter(parts, "indexedJobs", profile.indexedPngJobs);
  appendPositiveCounter(parts, "indexedRawBytes", profile.indexedPngRawBytes);
  appendPositiveCounter(parts, "indexedRawSaved", profile.indexedPngRgbaRawBytesAvoided);
  appendPositiveCounter(parts, "artifactCheckpoints", profile.artifactEncodeCheckpoints);
  appendPositiveCounter(parts, "artifactPeakActive", profile.artifactEncodePeakActive);
  appendPositiveCounter(parts, "artifactPeakQueued", profile.artifactEncodePeakQueued);
  appendPositiveCounter(parts, "artifactSubmitted", profile.artifactEncodeSubmitted);
  appendPositiveCounter(parts, "frzrChunkGaps", profile.freezingRainLiquidChunkGaps);
  appendPositiveCounter(parts, "snowLiquidLockTimeouts", profile.snowLiquidGridLockTimeouts);
  appendPositiveCounter(parts, "snowCumLockTimeouts", profile.snowfallCumulativeLockTimeouts);
  appendPositiveCounter(parts, "snowDeltaLockTimeouts", profile.snowfallDeltaLockTimeouts);
  appendPositiveCounter(parts, "profileLockTimeouts", profile.profileGridLockTimeouts);
}

function appendHitMissCounter(parts, label, hits, misses) {
  const hitCount = Number(hits) || 0;
  const missCount = Number(misses) || 0;
  if (hitCount > 0 || missCount > 0) {
    parts.push(`${label}=${hitCount}/${hitCount + missCount}`);
  }
}

function appendPositiveCounter(parts, label, value) {
  const count = Number(value) || 0;
  if (count > 0) {
    parts.push(`${label}=${count}`);
  }
}

function appendNonNegativeCounter(parts, label, value) {
  if (value === null || value === undefined || value === "") {
    return;
  }
  const count = Number(value);
  if (Number.isFinite(count) && count >= 0) {
    parts.push(`${label}=${count}`);
  }
}

function appendStringCounter(parts, label, value) {
  const text = String(value ?? "").trim();
  if (text) {
    parts.push(`${label}=${encodeURIComponent(text)}`);
  }
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0B";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)}${units[unitIndex]}`;
}

function numberFlag(argValue, envValue, fallback) {
  const candidate = argValue ?? envValue;
  // A blank value (`--worker-count=`, `KEY=` in .env) or a bare valueless
  // flag (argv yields boolean true) means "unset", not Number("")=0 or
  // Number(true)=1 — matching parseBooleanOption's fallback-on-blank
  // contract. A blank .env template line must not collapse the build to one
  // worker.
  if (candidate === undefined || candidate === null || typeof candidate === "boolean") {
    return fallback;
  }
  const text = String(candidate).trim();
  if (text === "") {
    return fallback;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

// The explicit-throttle and explicit-retry contracts key off whether the user
// actually supplied a number, under the same notion of "supplied" numberFlag
// uses (blank and bare-boolean spellings are unset).
function isExplicitNumberFlag(value) {
  if (value === undefined || value === null || typeof value === "boolean") {
    return false;
  }
  const text = String(value).trim();
  return text !== "" && Number.isFinite(Number(text));
}

function hasExplicitOptionValue(value) {
  if (value === undefined || value === null || typeof value === "boolean") {
    return false;
  }
  return String(value).trim() !== "";
}

function parseReflectivityGates(raw) {
  const gates = String(raw || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => value === 10 || value === 15 || value === 20);
  return gates.length > 0 ? Array.from(new Set(gates)).sort((left, right) => left - right) : [10, 15, 20];
}

function shouldCapAvailableHours({ fullRun, requireFullHorizon, explicitRun }) {
  return Boolean(fullRun && (!requireFullHorizon || explicitRun));
}

// A relative cache root (.env.example ships MODELVIEW_CACHE_ROOT=output/...)
// must name the same directory regardless of the invoking cwd: anchor it on
// the repo root, matching prune-render-cache.js and noaa-update.js, so a
// builder started from a foreign cwd can never fork the cache namespace away
// from the pruner's retention/budget logic. Absolute paths pass through
// path.resolve unchanged.
function resolveBuilderCacheRoot(cacheRootArg, env = process.env) {
  return path.resolve(ROOT_DIR, String(cacheRootArg || resolveCacheRootEnv(env) || DEFAULT_CACHE_ROOT));
}

function defaultWgrib2Path() {
  return fs.existsSync(DEFAULT_LOCAL_WGRIB2_PATH) ? DEFAULT_LOCAL_WGRIB2_PATH : "wgrib2";
}

function createBenchmarkReceiptWriter(env = process.env, descriptor = BENCHMARK_RECEIPT_FD) {
  if (env?.[BENCHMARK_RECEIPT_ENV] !== "1") {
    return null;
  }
  return (receipt) => {
    const body = Buffer.from(JSON.stringify(receipt));
    if (body.byteLength === 0 || body.byteLength > MAX_BENCHMARK_RECEIPT_BYTES) {
      throw new Error(`Benchmark receipt is outside the 1-${MAX_BENCHMARK_RECEIPT_BYTES} byte framing limit.`);
    }
    const frame = Buffer.allocUnsafe(BENCHMARK_RECEIPT_MAGIC.byteLength + 4 + body.byteLength);
    BENCHMARK_RECEIPT_MAGIC.copy(frame, 0);
    frame.writeUInt32BE(body.byteLength, BENCHMARK_RECEIPT_MAGIC.byteLength);
    body.copy(frame, BENCHMARK_RECEIPT_MAGIC.byteLength + 4);
    writeDescriptorFully(descriptor, frame);
  };
}

function writeDescriptorFully(descriptor, buffer) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = fs.writeSync(descriptor, buffer, offset, buffer.byteLength - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error("Benchmark receipt sideband accepted zero bytes.");
    }
    offset += written;
  }
}

function parseOptionalNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const trimmed = token.slice(2);
    const eq = trimmed.indexOf("=");
    if (eq >= 0) {
      args[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[trimmed] = true;
      continue;
    }
    args[trimmed] = next;
    index += 1;
  }
  return args;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  buildNoaaModelMetadata,
  buildNoaaNamMetadata,
  buildFullHoursForModel,
  buildGlobalFrameQueue,
  _testBuildFrameRenderTasks: buildFrameRenderTasks,
  _testRunGlobalFrameTaskQueue: runGlobalFrameTaskQueue,
  _testCanStartFrameTaskWithDependencies: canStartFrameTaskWithDependencies,
  _testMarkFrameTaskDependencyComplete: markFrameTaskDependencyComplete,
  _testFormatCycleHorizonCapMessage: formatCycleHorizonCapMessage,
  _testApplyCycleHorizonFilter: applyCycleHorizonFilter,
  _testModelHasExplicitHoursRequest: modelHasExplicitHoursRequest,
  _testResolveBuilderCacheRoot: resolveBuilderCacheRoot,
  _testResolveDerivedCellConcurrency: resolveDerivedCellConcurrency,
  _testResolveCompressThreadsForBuild: resolveCompressThreadsForBuild,
  _testResolveInputPrefetchConcurrency: resolveInputPrefetchConcurrency,
  _testFormatRenderProfile: formatRenderProfile,
  _testCreateBenchmarkReceiptWriter: createBenchmarkReceiptWriter,
  _testNumberFlag: numberFlag,
  _testIsExplicitNumberFlag: isExplicitNumberFlag,
  parseArgs,
  parseHours,
  parseReflectivityGates,
  referenceTimeFromRun,
  resolveNoaaParameterSetFromIdxText,
  resolveNoaaParameterSetFromIdxTexts,
  resolveParallelism,
  shouldCapAvailableHours,
  resolveHoursByModel,
  resolveModels,
  resolveNoaaModelRun,
  selectNoaaParameterProbeHours,
};
