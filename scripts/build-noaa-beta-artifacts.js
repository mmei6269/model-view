#!/usr/bin/env node

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { FrameWorkerPool, runWithConcurrency } = require("./lib/local-artifact-concurrency");
const { LocalArtifactRuntime } = require("./lib/local-artifact-runtime");
const { NOAA_NAM_PARAMETER_CATALOG } = require("./lib/noaa-nam-parameter-catalog");
const { NOAA_BETA_SOURCE_NAME, ensureWgrib2Available, getNoaaNamParameterOrder } = require("./lib/noaa-beta-renderer");
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

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_CACHE_ROOT = path.join(ROOT_DIR, "output/noaa-beta-cache");
const DEFAULT_LOCAL_WGRIB2_PATH = path.join(ROOT_DIR, "output/noaa-beta-tools/bin/wgrib2");
const DEFAULT_NOAA_WORKER_PATH = path.join(ROOT_DIR, "scripts/noaa-beta-frame-worker.js");
const FRAME_PROGRESS_STARTS = new Map();

async function main() {
  loadDotEnv(path.join(ROOT_DIR, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const models = resolveModels(args.models || args.model || process.env.MODELVIEW_NOAA_BETA_MODELS || "nam");
  const viewKey = String(args.view || DEFAULT_VIEW_KEY).trim() || DEFAULT_VIEW_KEY;
  if (!VIEW_CONFIG[viewKey]) {
    throw new Error(`Unsupported view '${viewKey}'. Supported: ${Object.keys(VIEW_CONFIG).join(", ")}`);
  }

  const fullRun = isFullRunRequest(args);
  const capAvailableHours =
    fullRun &&
    !parseBooleanOption(args["require-full-horizon"] || process.env.MODELVIEW_NOAA_REQUIRE_FULL_HORIZON, false);
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
  } = resolveParallelism({ args, resources, models });
  const cacheRoot = path.resolve(
    String(args["cache-root"] || process.env.MODELVIEW_NOAA_BETA_CACHE_ROOT || DEFAULT_CACHE_ROOT),
  );
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
    if (capAvailableHours) {
      hours = await resolveAvailableNoaaHours({ modelKey, noaaBaseUrl, run, hours });
      hoursByModel[modelKey] = hours;
    }
    const parameterSet = await resolveNoaaParameterSetForRun({ modelKey, noaaBaseUrl, run, hours });
    latestMetadataByModel.set(modelKey, buildNoaaModelMetadata({ modelKey, run, hours, noaaBaseUrl, ...parameterSet }));
  });
  const fullParameterOrder = getNoaaNamParameterOrder();
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
  const rawCacheDir = path.join(cacheRoot, "raw-noaa");
  const noaaWorkerPool = new FrameWorkerPool({
    workerPath: String(args["worker-script"] || process.env.MODELVIEW_NOAA_WORKER_SCRIPT || DEFAULT_NOAA_WORKER_PATH),
    size: workerCount,
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
      }),
  });

  await runtime.init();
  try {
    console.log(
      `[noaa-beta] resources cpu=${resources.cpuCount} mem=${resources.memGb.toFixed(1)}GB free=${resources.freeGb.toFixed(1)}GB scheduler=${globalFrameQueue ? "global-frame-queue" : "per-model"} model-concurrency=${modelConcurrency} frame-concurrency=${frameConcurrency} global-frame-concurrency=${globalFrameConcurrency} global-persist-queue=${globalPersistQueue} global-persist-concurrency=${globalPersistConcurrency} global-persist-backlog=${globalPersistBacklog} snow-persist-concurrency=${snowPersistConcurrency} snow-persist-backlog=${snowPersistBacklog} artifact-write-concurrency=${artifactWriteConcurrency || "off"} worker-count=${workerCount} total-frame-concurrency=${totalFrameConcurrency} decode-concurrency=${decodeConcurrency} total-decode-concurrency=${totalDecodeConcurrency} range-concurrency=${rangeFetchConcurrency} total-range-concurrency=${totalRangeFetchConcurrency} persist-manifest-each-frame=${persistManifestEachFrame} run-offset=${runOffset}`,
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
        frameConcurrency: globalFrameConcurrency,
        frameRetries,
        retryDelayMs,
        retryFrameConcurrency: Math.max(retryFrameConcurrency, Math.min(workerCount, globalFrameConcurrency)),
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
          retryFrameConcurrency,
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
  const frameConcurrency = clampInt(
    numberFlag(args["frame-concurrency"], process.env.MODELVIEW_NOAA_FRAME_CONCURRENCY, defaultFrameConcurrency),
    1,
    64,
    Math.min(defaultFrameConcurrency, totalFrameConcurrency),
  );
  const workerCount = clampInt(
    numberFlag(args["worker-count"], process.env.MODELVIEW_NOAA_WORKER_COUNT, defaultWorkerCount),
    1,
    48,
    defaultWorkerCount,
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
  };
}

function resolveNoaaNamRun({ noaaBaseUrl, date, cycle, hours }) {
  return resolveNoaaModelRun({ modelKey: "nam", noaaBaseUrl, date, cycle, hours });
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
    "materializeMs",
    "rangeFetchMs",
    "selectedGribWriteMs",
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
    "wgribRegridMs",
    "wgribExportMs",
    "gridMapMs",
    "artifactsMs",
    "artifactPrepMs",
    "corePngMs",
    "catalogPngMs",
    "synopticMs",
    "hoverGridMs",
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
  const value = Number(candidate);
  return Number.isFinite(value) ? value : fallback;
}

function parseReflectivityGates(raw) {
  const gates = String(raw || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => value === 10 || value === 15 || value === 20);
  return gates.length > 0 ? Array.from(new Set(gates)).sort((left, right) => left - right) : [10, 15, 20];
}

function defaultWgrib2Path() {
  return fs.existsSync(DEFAULT_LOCAL_WGRIB2_PATH) ? DEFAULT_LOCAL_WGRIB2_PATH : "wgrib2";
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

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
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
  parseHours,
  parseReflectivityGates,
  referenceTimeFromRun,
  resolveNoaaParameterSetFromIdxText,
  resolveNoaaParameterSetFromIdxTexts,
  resolveParallelism,
  resolveHoursByModel,
  resolveModels,
  resolveNoaaModelRun,
  resolveNoaaNamRun,
  selectNoaaParameterProbeHours,
};
