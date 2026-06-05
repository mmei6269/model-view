#!/usr/bin/env node

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { FrameWorkerPool, runWithConcurrency } = require("./lib/local-artifact-concurrency");
const { LocalArtifactRuntime } = require("./lib/local-artifact-runtime");
const { NOAA_NAM_PARAMETER_CATALOG } = require("./lib/noaa-nam-parameter-catalog");
const {
  NOAA_BETA_MODEL_CONFIG,
  NOAA_BETA_MODEL_KEYS,
  NOAA_BETA_SOURCE_NAME,
  buildNoaaGribUrl,
  ensureWgrib2Available,
  getNoaaGribModelConfig,
  getNoaaGribRendererSignature,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
  parseNoaaIdx,
  selectNoaaNamParameterRecords,
} = require("./lib/noaa-beta-renderer");
const {
  DEFAULT_ARTIFACT_PREFIX,
  DEFAULT_REFLECTIVITY_GATES,
  DEFAULT_VIEW_KEY,
  MODEL_CONFIG,
  VIEW_CONFIG,
  formatRunIdFromReference,
} = require("./lib/modelview-runtime");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_CACHE_ROOT = path.join(ROOT_DIR, "output/noaa-beta-cache");
const DEFAULT_LOCAL_WGRIB2_PATH = path.join(ROOT_DIR, "output/noaa-beta-tools/bin/wgrib2");
const DEFAULT_NOAA_WORKER_PATH = path.join(ROOT_DIR, "scripts/noaa-beta-frame-worker.js");
const DEFAULT_HOURS = [0, 3, 6];
const DEFAULT_FRAME_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const FRAME_PROGRESS_STARTS = new Map();
const SNOWFALL_DERIVED_PARAMETER_KEYS = new Set(
  NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.kind === "snowfallDerived").map((entry) => entry.key),
);
const RUN_MAX_ACCUMULATION_PARAMETER_KEYS = new Set(["gustRunMax", "updraftHelicity2to5kmRunMax"]);

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

async function buildLatestStatesWithGlobalFrameQueue(runtime, models, viewKey, options = {}) {
  const frameConcurrency = clampInt(options.frameConcurrency, 1, 96, Math.max(1, models.length));
  const frameRetries = clampInt(options.frameRetries ?? options.frameRetryCount, 0, 5, DEFAULT_FRAME_RETRIES);
  const retryDelayMs = clampInt(options.retryDelayMs, 0, 60_000, DEFAULT_RETRY_DELAY_MS);
  const retryFrameConcurrency = clampInt(
    options.retryFrameConcurrency,
    1,
    frameConcurrency,
    Math.max(1, Math.min(frameConcurrency, Math.ceil(frameConcurrency / 2))),
  );
  const forceFrames = parseBooleanOption(options.forceFrames ?? options.force, false);
  const persistManifestEachFrame = parseBooleanOption(options.persistManifestEachFrame, false);
  const failFast = parseBooleanOption(options.failFast, false);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const stateEntries = new Array(models.length);
  const persistQueueEnabled = parseBooleanOption(options.persistQueueEnabled, false);
  const persistQueue = persistQueueEnabled
    ? new GlobalPersistQueue({
        concurrency: clampInt(options.persistConcurrency, 1, 32, 4),
        backlogLimit: clampInt(options.persistBacklog, 1, 192, Math.max(frameConcurrency, 16)),
        failFast,
      })
    : null;
  const splitSnowfallFrames = !persistQueue;
  const defaultSnowPersistConcurrency = 6;
  const snowPersistQueue = splitSnowfallFrames
    ? new GlobalPersistQueue({
        concurrency: clampInt(options.snowPersistConcurrency, 1, 32, defaultSnowPersistConcurrency),
        backlogLimit: clampInt(
          options.snowPersistBacklog,
          1,
          192,
          Math.max(frameConcurrency, defaultSnowPersistConcurrency * 4),
        ),
        failFast,
      })
    : null;

  await runWithConcurrency(models, Math.min(models.length, 4), async (modelKey, index) => {
    const state = await runtime.ensureLatestState(modelKey, viewKey, { forceRefresh: true });
    const targetFrames = state.manifest.frames.filter(Boolean);
    const entry = {
      index,
      modelKey,
      viewKey: state.viewKey,
      state,
      targetFrames,
      totalFrames: targetFrames.length,
      built: 0,
      reused: 0,
      failed: 0,
      completed: 0,
      active: 0,
      failedFrames: new Map(),
      finishedFrameHours: new Set(),
      completedBaseHours: new Set(),
      completedDeltaHours: new Set(),
      completedSnowPrefixHours: new Set(),
      completedRunMaxPrefixHours: new Set(),
    };
    configureSnowfallFrameDependency(entry);
    configureRunMaxFrameDependency(entry);
    stateEntries[index] = entry;
    runtime.stats.buildRuns += 1;
    emitGlobalProgress(onProgress, {
      type: "build-start",
      modelKey: state.modelKey,
      viewKey: state.viewKey,
      runId: state.runId,
      totalFrames: targetFrames.length,
      built: entry.built,
      reused: entry.reused,
      failed: entry.failed,
      completed: entry.completed,
      active: entry.active,
    });
  });

  await runWithConcurrency(stateEntries.filter(Boolean), Math.min(models.length, 4), async (entry) => {
    await runtime.prefetchFrameInputsForState(entry.state, entry.targetFrames, { onProgress });
  });

  const initialTasks = buildFrameRenderTasks(buildGlobalFrameQueue(stateEntries.filter(Boolean)), {
    splitSnowfall: splitSnowfallFrames,
  });
  await runGlobalFrameTaskQueue(
    initialTasks,
    frameConcurrency,
    (task) =>
      processGlobalFrameTask(runtime, task.entry, task.frame, {
        retryAttempt: 0,
        forceFrames,
        persistManifestEachFrame,
        persistQueue,
        snowPersistQueue,
        failFast,
        onProgress,
        task,
      }),
    {
      label: "initial",
      entries: stateEntries.filter(Boolean),
      profileFrames: options.profileFrames,
      workerPoolStats: options.workerPoolStats,
      persistQueueStats: persistQueue
        ? () => persistQueue.getStats()
        : snowPersistQueue
          ? () => snowPersistQueue.getStats()
          : null,
      canStartTask: canStartFrameTaskWithDependencies,
      onTaskFinished: markFrameTaskDependencyComplete,
    },
  );
  if (persistQueue) {
    await persistQueue.drain();
  }
  if (snowPersistQueue) {
    await snowPersistQueue.drain();
  }

  for (let retryAttempt = 1; retryAttempt <= frameRetries; retryAttempt += 1) {
    const retryEntries = stateEntries
      .filter((entry) => entry.failedFrames.size > 0)
      .map((entry) => ({
        ...entry,
        sourceEntry: entry,
        queueFrames: Array.from(entry.failedFrames.values()).map((failure) => failure.frame),
      }));
    const retryTasks = buildFrameRenderTasks(buildGlobalFrameQueue(retryEntries), {
      splitSnowfall: splitSnowfallFrames,
    });
    if (retryTasks.length === 0) {
      break;
    }
    const delayMs = retryDelayMs * retryAttempt;
    for (const entry of retryEntries) {
      emitGlobalProgress(onProgress, {
        type: "retry-start",
        modelKey: entry.modelKey,
        viewKey: entry.viewKey,
        runId: entry.state.runId,
        totalFrames: entry.totalFrames,
        failedFrames: entry.queueFrames.length,
        retryAttempt,
        maxRetries: frameRetries,
        delayMs,
        frameConcurrency: retryFrameConcurrency,
        built: entry.built,
        reused: entry.reused,
        failed: entry.failed,
        completed: entry.completed,
        active: entry.active,
      });
    }
    if (delayMs > 0) {
      await sleepMs(delayMs);
    }
    for (const task of retryTasks) {
      task.entry.state.primaryOmPrefetchFailures?.delete(Number(task.frame.hour));
    }
    await runWithConcurrency(retryEntries, Math.min(retryEntries.length, 4), async (entry) => {
      await runtime.prefetchFrameInputsForState(entry.state, entry.queueFrames, {
        onProgress,
        concurrency: Math.max(1, Math.min(4, retryFrameConcurrency)),
      });
    });
    await runGlobalFrameTaskQueue(
      retryTasks,
      retryFrameConcurrency,
      (task) =>
        processGlobalFrameTask(runtime, task.entry, task.frame, {
          retryAttempt,
          forceFrames,
          persistManifestEachFrame,
          persistQueue,
          snowPersistQueue,
          failFast,
          onProgress,
          task,
        }),
      {
        label: `retry-${retryAttempt}`,
        entries: stateEntries.filter(Boolean),
        profileFrames: options.profileFrames,
        workerPoolStats: options.workerPoolStats,
        persistQueueStats: persistQueue
          ? () => persistQueue.getStats()
          : snowPersistQueue
            ? () => snowPersistQueue.getStats()
            : null,
        canStartTask: canStartFrameTaskWithDependencies,
        onTaskFinished: markFrameTaskDependencyComplete,
      },
    );
    if (persistQueue) {
      await persistQueue.drain();
    }
    if (snowPersistQueue) {
      await snowPersistQueue.drain();
    }
  }
  if (snowPersistQueue) {
    await snowPersistQueue.drain();
  }

  const results = new Array(models.length);
  await runWithConcurrency(stateEntries.filter(Boolean), Math.min(models.length, 4), async (entry) => {
    const targetFramesComplete = await runtime.areFramesCompleteForState(entry.state, entry.targetFrames);
    entry.failed = entry.failedFrames.size;
    if (entry.built > 0 || entry.failed > 0 || targetFramesComplete) {
      entry.state.manifest.generatedAt = new Date().toISOString();
      entry.state.manifest.source = runtime.sourceName;
      entry.state.latestPointer.generatedAt = entry.state.manifest.generatedAt;
      entry.state.latestPointer.frameCount = entry.state.manifest.frames.length;
      await runtime.writeManifestState(
        entry.state.modelKey,
        entry.state.viewKey,
        entry.state.runId,
        entry.state.manifest,
        entry.state.latestPointer,
      );
    }
    emitGlobalProgress(onProgress, {
      type: "build-complete",
      modelKey: entry.state.modelKey,
      viewKey: entry.state.viewKey,
      runId: entry.state.runId,
      totalFrames: entry.totalFrames,
      built: entry.built,
      reused: entry.reused,
      failed: entry.failed,
      completed: entry.completed,
      active: entry.active,
    });
    results[entry.index] = {
      modelKey: entry.state.modelKey,
      viewKey: entry.state.viewKey,
      runId: entry.state.runId,
      frameCount: entry.targetFrames.length,
      built: entry.built,
      reused: entry.reused,
      failed: entry.failed,
      latestPointer: entry.state.latestPointer,
      manifest: entry.state.manifest,
    };
  });
  return results;
}

async function processGlobalFrameTask(runtime, entry, frame, options = {}) {
  const state = entry.state;
  const framePlan = state.framePlanByHour.get(Number(frame.hour));
  const task = options.task || {};
  const renderPart = task.renderPart || "all";
  const renderMode = task.renderMode || "all";
  const partialFrame = renderPart === "base" && task.completesFrame === false;
  const deltaOnlyFrame = renderPart === "snow-delta";
  const prefixOnlyFrame = renderPart === "snow-prefix";
  const runMaxPrefixOnlyFrame = renderPart === "runmax-prefix";
  const hour = Number(frame.hour);
  const retryAttempt = Math.max(0, Math.round(Number(options.retryAttempt) || 0));
  if (entry.finishedFrameHours?.has(hour) || (retryAttempt === 0 && entry.failedFrames?.has(hour))) {
    return true;
  }
  const forceFrames = parseBooleanOption(options.forceFrames ?? options.force, false);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const prefetchFailure = state.primaryOmPrefetchFailures?.get(hour);
  if (prefetchFailure && (forceFrames || !(await runtime.isFrameCompleteForState(state, frame)))) {
    emitGlobalFrameFailure(entry, frame, framePlan, prefetchFailure, retryAttempt, retryAttempt === 0, onProgress);
    if (options.failFast) {
      throw new Error(prefetchFailure);
    }
    return false;
  }
  if (!forceFrames && (await runtime.isFrameCompleteForState(state, frame))) {
    state.manifest.hourStatus[String(frame.hour)] = "loaded";
    await runtime.refreshFrameArtifactBytes(frame);
    runtime.stats.frameRenderCacheHits += 1;
    markGlobalFrameRecovered(entry, frame);
    entry.finishedFrameHours?.add(hour);
    entry.completedBaseHours?.add(hour);
    entry.reused += 1;
    if (retryAttempt === 0) {
      entry.completed += 1;
    }
    emitGlobalProgress(onProgress, {
      type: "frame-reused",
      modelKey: state.modelKey,
      viewKey: state.viewKey,
      runId: state.runId,
      totalFrames: entry.totalFrames,
      built: entry.built,
      reused: entry.reused,
      failed: entry.failed,
      completed: entry.completed,
      active: entry.active,
      hour: Number(frame.hour),
      validTime: framePlan?.validTime || frame.validHourKey,
      retryAttempt,
      renderPart,
    });
    return true;
  }

  entry.active += 1;
  emitGlobalProgress(onProgress, {
    type: "frame-start",
    modelKey: state.modelKey,
    viewKey: state.viewKey,
    runId: state.runId,
    totalFrames: entry.totalFrames,
    built: entry.built,
    reused: entry.reused,
    failed: entry.failed,
    completed: entry.completed,
    active: entry.active,
    hour: Number(frame.hour),
    validTime: framePlan?.validTime || frame.validHourKey,
    retryAttempt,
    renderPart,
  });
  try {
    if (deltaOnlyFrame || prefixOnlyFrame || runMaxPrefixOnlyFrame) {
      const rendered = await runtime.renderFrameArtifactsForState(state, frame, {
        forceFrames,
        persistManifestEachFrame: options.persistManifestEachFrame,
        renderMode,
        normalize: false,
      });
      if (deltaOnlyFrame) {
        entry.completedDeltaHours?.add(hour);
      }
      if (prefixOnlyFrame) {
        entry.completedSnowPrefixHours?.add(hour);
      }
      if (runMaxPrefixOnlyFrame) {
        entry.completedRunMaxPrefixHours?.add(hour);
      }
      emitGlobalProgress(onProgress, {
        type: "frame-part-complete",
        modelKey: state.modelKey,
        viewKey: state.viewKey,
        runId: state.runId,
        totalFrames: entry.totalFrames,
        built: entry.built,
        reused: entry.reused,
        failed: entry.failed,
        completed: entry.completed,
        active: Math.max(0, entry.active - 1),
        hour: Number(frame.hour),
        validTime: framePlan?.validTime || frame.validHourKey,
        retryAttempt,
        renderPart,
        renderProfile: rendered?.renderProfile || null,
      });
    } else if (options.persistQueue && typeof runtime.renderFrameArtifactsForState === "function") {
      const normalized = await runtime.renderFrameArtifactsForState(state, frame, {
        forceFrames,
        persistManifestEachFrame: options.persistManifestEachFrame,
        renderMode,
        normalize: !partialFrame,
      });
      await options.persistQueue.enqueue(async () => {
        try {
          const renderedFrame = await runtime.persistRenderedFrameForState(state, frame, normalized, {
            persistManifestEachFrame: options.persistManifestEachFrame,
            partialFrame,
            supplementalHoverGridName: renderPart === "snow" ? "snow" : null,
          });
          if (partialFrame) {
            entry.completedBaseHours?.add(hour);
            const renderProfile = renderedFrame?.__renderProfile || null;
            emitGlobalProgress(onProgress, {
              type: "frame-part-complete",
              modelKey: state.modelKey,
              viewKey: state.viewKey,
              runId: state.runId,
              totalFrames: entry.totalFrames,
              built: entry.built,
              reused: entry.reused,
              failed: entry.failed,
              completed: entry.completed,
              active: entry.active,
              hour: Number(frame.hour),
              validTime: framePlan?.validTime || frame.validHourKey,
              retryAttempt,
              renderPart,
              renderProfile,
            });
            return;
          }
          const renderProfile = renderedFrame?.__renderProfile || null;
          markGlobalFrameRecovered(entry, frame);
          entry.finishedFrameHours?.add(hour);
          entry.built += 1;
          if (retryAttempt === 0) {
            entry.completed += 1;
          }
          runtime.stats.buildFrames += 1;
          emitGlobalProgress(onProgress, {
            type: "frame-complete",
            modelKey: state.modelKey,
            viewKey: state.viewKey,
            runId: state.runId,
            totalFrames: entry.totalFrames,
            built: entry.built,
            reused: entry.reused,
            failed: entry.failed,
            completed: entry.completed,
            active: entry.active,
            hour: Number(frame.hour),
            validTime: framePlan?.validTime || frame.validHourKey,
            retryAttempt,
            renderPart,
            renderProfile,
          });
        } catch (error) {
          emitGlobalFrameFailure(entry, frame, framePlan, error, retryAttempt, retryAttempt === 0, onProgress);
          if (options.failFast) {
            throw error;
          }
        }
      });
    } else {
      let renderedFrame = null;
      if (
        renderPart === "snow" &&
        options.snowPersistQueue &&
        typeof runtime.renderFrameArtifactsForState === "function"
      ) {
        const rendered = await runtime.renderFrameArtifactsForState(state, frame, {
          forceFrames,
          persistManifestEachFrame: options.persistManifestEachFrame,
          renderMode,
          normalize: false,
        });
        await options.snowPersistQueue.enqueue(async () => {
          try {
            const persistedFrame = await runtime.persistRenderedFrameForState(state, frame, rendered, {
              persistManifestEachFrame: options.persistManifestEachFrame,
              supplementalHoverGridName: "snow",
            });
            const renderProfile = persistedFrame?.__renderProfile || null;
            markGlobalFrameRecovered(entry, frame);
            entry.finishedFrameHours?.add(hour);
            entry.built += 1;
            if (retryAttempt === 0) {
              entry.completed += 1;
            }
            runtime.stats.buildFrames += 1;
            emitGlobalProgress(onProgress, {
              type: "frame-complete",
              modelKey: state.modelKey,
              viewKey: state.viewKey,
              runId: state.runId,
              totalFrames: entry.totalFrames,
              built: entry.built,
              reused: entry.reused,
              failed: entry.failed,
              completed: entry.completed,
              active: entry.active,
              hour: Number(frame.hour),
              validTime: framePlan?.validTime || frame.validHourKey,
              retryAttempt,
              renderPart,
              renderProfile,
            });
          } catch (error) {
            emitGlobalFrameFailure(entry, frame, framePlan, error, retryAttempt, retryAttempt === 0, onProgress);
            if (options.failFast) {
              throw error;
            }
          }
        });
        return true;
      }
      if (partialFrame) {
        const rendered = await runtime.renderFrameArtifactsForState(state, frame, {
          forceFrames,
          persistManifestEachFrame: options.persistManifestEachFrame,
          renderMode,
          normalize: false,
        });
        renderedFrame = await runtime.persistRenderedFrameForState(state, frame, rendered, {
          persistManifestEachFrame: options.persistManifestEachFrame,
          partialFrame: true,
        });
        entry.completedBaseHours?.add(hour);
      } else {
        renderedFrame = await runtime.ensureFrameRenderedForState(state, frame, {
          forceFrames,
          persistManifestEachFrame: options.persistManifestEachFrame,
          renderMode,
          normalize: renderPart === "all",
          supplementalHoverGridName: renderPart === "snow" ? "snow" : null,
        });
      }
      if (partialFrame) {
        const renderProfile = renderedFrame?.__renderProfile || null;
        emitGlobalProgress(onProgress, {
          type: "frame-part-complete",
          modelKey: state.modelKey,
          viewKey: state.viewKey,
          runId: state.runId,
          totalFrames: entry.totalFrames,
          built: entry.built,
          reused: entry.reused,
          failed: entry.failed,
          completed: entry.completed,
          active: Math.max(0, entry.active - 1),
          hour: Number(frame.hour),
          validTime: framePlan?.validTime || frame.validHourKey,
          retryAttempt,
          renderPart,
          renderProfile,
        });
        return true;
      }
      const renderProfile = renderedFrame?.__renderProfile || null;
      markGlobalFrameRecovered(entry, frame);
      entry.finishedFrameHours?.add(hour);
      entry.built += 1;
      if (retryAttempt === 0) {
        entry.completed += 1;
      }
      runtime.stats.buildFrames += 1;
      emitGlobalProgress(onProgress, {
        type: "frame-complete",
        modelKey: state.modelKey,
        viewKey: state.viewKey,
        runId: state.runId,
        totalFrames: entry.totalFrames,
        built: entry.built,
        reused: entry.reused,
        failed: entry.failed,
        completed: entry.completed,
        active: Math.max(0, entry.active - 1),
        hour: Number(frame.hour),
        validTime: framePlan?.validTime || frame.validHourKey,
        retryAttempt,
        renderPart,
        renderProfile,
      });
    }
    return true;
  } catch (error) {
    emitGlobalFrameFailure(entry, frame, framePlan, error, retryAttempt, retryAttempt === 0, onProgress);
    if (options.failFast) {
      throw error;
    }
    return false;
  } finally {
    entry.active = Math.max(0, entry.active - 1);
  }
}

function configureSnowfallFrameDependency(entry) {
  const parameterOrder = Array.isArray(entry?.state?.latestMetadata?.parameterOrder)
    ? entry.state.latestMetadata.parameterOrder
    : [];
  entry.hasSnowfallFrameDependency = parameterOrder.some((key) => SNOWFALL_DERIVED_PARAMETER_KEYS.has(key));
  entry.snowfallDependencyFrameHours = (entry.targetFrames || [])
    .map((frame) => Math.round(Number(frame.hour)))
    .filter((hour) => Number.isFinite(hour))
    .sort((left, right) => left - right);
  entry.completedDependencyHours = new Set();
}

function configureRunMaxFrameDependency(entry) {
  const parameterOrder = Array.isArray(entry?.state?.latestMetadata?.parameterOrder)
    ? entry.state.latestMetadata.parameterOrder
    : [];
  entry.hasRunMaxFrameDependency = parameterOrder.some((key) => RUN_MAX_ACCUMULATION_PARAMETER_KEYS.has(key));
  entry.runMaxDependencyFrameHours = (entry.targetFrames || [])
    .map((frame) => Math.round(Number(frame.hour)))
    .filter((hour) => Number.isFinite(hour) && hour > 0)
    .sort((left, right) => left - right);
}

function canStartFrameTaskWithDependencies(task) {
  const hour = Math.round(Number(task?.frame?.hour));
  if (Number.isFinite(hour) && (task.entry?.finishedFrameHours?.has(hour) || task.entry?.failedFrames?.has(hour))) {
    return true;
  }
  if (task?.renderPart === "snow-delta") {
    return true;
  }
  if (task?.renderPart === "runmax-prefix") {
    if (!task?.entry?.hasRunMaxFrameDependency) {
      return true;
    }
    const previousHour = previousRunMaxDependencyHour(task.entry, hour);
    return previousHour === null || task.entry.completedRunMaxPrefixHours?.has(previousHour);
  }
  if (
    task?.entry?.hasRunMaxFrameDependency &&
    Number.isFinite(hour) &&
    hour > 0 &&
    !task.entry?.completedRunMaxPrefixHours?.has(hour)
  ) {
    return false;
  }
  if (task?.renderPart === "snow-prefix") {
    if (!task.entry?.completedBaseHours?.has(hour) || !task.entry?.completedDeltaHours?.has(hour)) {
      return false;
    }
    const previousHour = previousDependencyHour(task.entry, hour);
    return (
      previousHour === null ||
      task.entry.completedSnowPrefixHours?.has(previousHour) ||
      task.entry.completedDependencyHours?.has(previousHour)
    );
  }
  if (
    task?.renderPart === "snow" &&
    (!task.entry?.completedBaseHours?.has(hour) || !task.entry?.completedSnowPrefixHours?.has(hour))
  ) {
    return false;
  }
  if (!task?.entry?.hasSnowfallFrameDependency) {
    return true;
  }
  if (!Number.isFinite(hour) || hour <= 0) {
    return true;
  }
  if (task?.renderPart === "base") {
    return true;
  }
  const previousHour = previousDependencyHour(task.entry, hour);
  return previousHour === null || task.entry.completedDependencyHours?.has(previousHour);
}

function previousDependencyHour(entry, hour) {
  const hours = Array.isArray(entry?.snowfallDependencyFrameHours) ? entry.snowfallDependencyFrameHours : [];
  let previous = null;
  for (const candidate of hours) {
    if (candidate >= hour) {
      break;
    }
    previous = candidate;
  }
  return previous;
}

function previousRunMaxDependencyHour(entry, hour) {
  const hours = Array.isArray(entry?.runMaxDependencyFrameHours) ? entry.runMaxDependencyFrameHours : [];
  let previous = null;
  for (const candidate of hours) {
    if (candidate >= hour) {
      break;
    }
    previous = candidate;
  }
  return previous;
}

function markFrameTaskDependencyComplete(task) {
  const hour = Math.round(Number(task?.frame?.hour));
  if (!Number.isFinite(hour)) {
    return;
  }
  if (task?.completesBaseDependency) {
    task.entry?.completedBaseHours?.add(hour);
  }
  if (task?.completesDeltaDependency) {
    task.entry?.completedDeltaHours?.add(hour);
  }
  if (task?.completesSnowPrefixDependency || task?.completesFrame) {
    task.entry?.completedSnowPrefixHours?.add(hour);
  }
  if (task?.completesRunMaxPrefixDependency || task?.completesFrame) {
    task.entry?.completedRunMaxPrefixHours?.add(hour);
  }
  if (
    task?.completesFrame ||
    task?.completesSnowDependency ||
    (task?.completesFrame === undefined && task?.completesSnowDependency === undefined)
  ) {
    task.entry?.completedDependencyHours?.add(hour);
  }
}

function emitGlobalFrameFailure(entry, frame, framePlan, error, retryAttempt, countFailure, onProgress) {
  const hour = Number(frame.hour);
  const errorMessage = String(error?.message || error);
  if (countFailure && !entry.failedFrames.has(hour)) {
    entry.failed += 1;
    entry.completed += 1;
  }
  entry.failedFrames.set(hour, { frame, error: errorMessage });
  entry.state.manifest.hourStatus[String(frame.hour)] = "error";
  emitGlobalProgress(onProgress, {
    type: "frame-error",
    modelKey: entry.state.modelKey,
    viewKey: entry.state.viewKey,
    runId: entry.state.runId,
    totalFrames: entry.totalFrames,
    built: entry.built,
    reused: entry.reused,
    failed: entry.failed,
    completed: entry.completed,
    active: Math.max(0, entry.active - 1),
    hour,
    validTime: framePlan?.validTime || frame.validHourKey,
    retryAttempt,
    error: errorMessage,
  });
}

function markGlobalFrameRecovered(entry, frame) {
  const hour = Number(frame.hour);
  if (entry.failedFrames.delete(hour)) {
    entry.failed = Math.max(0, entry.failed - 1);
  }
}

function emitGlobalProgress(onProgress, event) {
  if (typeof onProgress === "function") {
    onProgress(event);
  }
}

function buildGlobalFrameQueue(entries) {
  const queueEntries = (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const frames = entry?.queueFrames || entry?.targetFrames || entry?.frames || [];
      const sourceEntry = entry?.sourceEntry || entry;
      return {
        entry: sourceEntry,
        modelKey: sourceEntry?.modelKey || entry?.modelKey || "",
        index: Number.isFinite(Number(sourceEntry?.index)) ? Number(sourceEntry.index) : 0,
        frames: frames.filter(Boolean),
      };
    })
    .filter((entry) => entry.frames.length > 0);
  const totalFrames = queueEntries.reduce((sum, entry) => sum + entry.frames.length, 0);
  if (totalFrames === 0) {
    return [];
  }
  const tasks = [];
  for (const entry of queueEntries) {
    const frames = orderFramesForGlobalQueue(entry.frames);
    const stride = totalFrames / frames.length;
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex];
      tasks.push({
        entry: entry.entry,
        modelKey: entry.modelKey,
        frame,
        hour: Number(frame.hour),
        sortKey: (frameIndex + 0.5) * stride,
        modelIndex: entry.index,
        frameIndex,
      });
    }
  }
  return tasks.sort(compareGlobalFrameTasks);
}

function buildFrameRenderTasks(tasks, options = {}) {
  const splitSnowfall = parseBooleanOption(options.splitSnowfall, true);
  const out = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const hour = Math.round(Number(task?.frame?.hour));
    const canSplit = splitSnowfall && task?.entry?.hasSnowfallFrameDependency && Number.isFinite(hour) && hour > 0;
    const canPrecomputeRunMax = task?.entry?.hasRunMaxFrameDependency && Number.isFinite(hour) && hour > 0;
    if (canPrecomputeRunMax) {
      out.push({
        ...task,
        renderPart: "runmax-prefix",
        renderMode: "runmax-prefix",
        completesFrame: false,
        completesRunMaxPrefixDependency: true,
        completesSnowDependency: false,
        sortKey: task.sortKey - 0.03,
      });
    }
    if (!canSplit) {
      out.push({
        ...task,
        renderPart: "all",
        renderMode: "all",
        completesFrame: true,
        completesSnowDependency: true,
      });
      continue;
    }
    out.push({
      ...task,
      renderPart: "base",
      renderMode: "base",
      completesFrame: false,
      completesBaseDependency: true,
      completesDeltaDependency: true,
      completesSnowDependency: false,
      sortKey: task.sortKey - 0.02,
    });
    out.push({
      ...task,
      renderPart: "snow-prefix",
      renderMode: "snow-prefix",
      completesFrame: false,
      completesSnowPrefixDependency: true,
      completesSnowDependency: true,
      sortKey: task.sortKey - 0.01,
    });
    out.push({
      ...task,
      renderPart: "snow",
      renderMode: "snow",
      completesFrame: true,
      completesSnowDependency: true,
      sortKey: task.sortKey + 0.01,
    });
  }
  return out.sort(compareGlobalFrameTasks);
}

function orderFramesForGlobalQueue(frames) {
  const ordered = [...frames].sort((left, right) => Number(left.hour) - Number(right.hour));
  // Later forecast hours tend to have heavier accumulation work; leave cheaper early hours for the tail.
  return ordered.reverse();
}

function compareGlobalFrameTasks(left, right) {
  const sortDelta = left.sortKey - right.sortKey;
  if (Math.abs(sortDelta) > 1e-9) {
    return sortDelta;
  }
  const countDelta = modelQueueWeight(right.entry) - modelQueueWeight(left.entry);
  if (countDelta !== 0) {
    return countDelta;
  }
  const modelDelta = left.modelIndex - right.modelIndex;
  if (modelDelta !== 0) {
    return modelDelta;
  }
  return left.frameIndex - right.frameIndex;
}

function modelQueueWeight(entry) {
  return Number(entry?.totalFrames || entry?.targetFrames?.length || entry?.frames?.length || 0);
}

class GlobalPersistQueue {
  constructor({ concurrency = 4, backlogLimit = 48, failFast = false } = {}) {
    this.concurrency = clampInt(concurrency, 1, 32, 4);
    this.backlogLimit = clampInt(backlogLimit, this.concurrency, 192, Math.max(this.concurrency, 48));
    this.failFast = Boolean(failFast);
    this.queue = [];
    this.active = 0;
    this.scheduled = 0;
    this.completed = 0;
    this.failed = 0;
    this.errors = [];
    this.waiters = [];
  }

  async enqueue(task) {
    while (this.active + this.queue.length >= this.backlogLimit) {
      await this.waitForChange();
    }
    this.queue.push(task);
    this.scheduled += 1;
    this.pump();
  }

  pump() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(task)
        .catch((error) => {
          this.failed += 1;
          this.errors.push(error);
        })
        .finally(() => {
          this.active = Math.max(0, this.active - 1);
          this.completed += 1;
          this.notifyWaiters();
          this.pump();
        });
    }
  }

  async drain() {
    while (this.active > 0 || this.queue.length > 0) {
      await this.waitForChange();
    }
    if (this.failFast && this.errors.length > 0) {
      throw this.errors[0];
    }
  }

  waitForChange() {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  notifyWaiters() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  getStats() {
    return {
      concurrency: this.concurrency,
      active: this.active,
      queued: this.queue.length,
      pending: this.active + this.queue.length,
      backlogLimit: this.backlogLimit,
      scheduled: this.scheduled,
      completed: this.completed,
      failed: this.failed,
    };
  }
}

async function runGlobalFrameTaskQueue(tasks, concurrency, worker, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) {
    return;
  }
  const workerCount = clampInt(concurrency, 1, list.length, 1);
  const pending = [...list];
  const canStartTask = typeof options.canStartTask === "function" ? options.canStartTask : null;
  const onTaskFinished = typeof options.onTaskFinished === "function" ? options.onTaskFinished : null;
  const waiters = [];
  const notifyWaiters = () => {
    const current = waiters.splice(0);
    for (const waiter of current) {
      waiter();
    }
  };
  const waitForReadyChange = () => new Promise((resolve) => waiters.push(resolve));
  const metrics = {
    label: options.label || "frames",
    total: list.length,
    started: 0,
    completed: 0,
    active: 0,
    concurrency: workerCount,
    lastLoggedAt: 0,
  };
  logGlobalQueueProgress(metrics, options, true);
  const runners = Array.from({ length: workerCount }, async () => {
    while (metrics.completed < metrics.total) {
      const current = takeNextReadyTask(pending, canStartTask, metrics.active);
      if (!current) {
        if (pending.length === 0) {
          break;
        }
        await waitForReadyChange();
        continue;
      }
      metrics.started += 1;
      metrics.active += 1;
      try {
        await worker(current.task, current.index);
      } finally {
        if (onTaskFinished) {
          onTaskFinished(current.task, current.index);
        }
        metrics.active = Math.max(0, metrics.active - 1);
        metrics.completed += 1;
        notifyWaiters();
        logGlobalQueueProgress(metrics, options, false);
      }
    }
  });
  await Promise.all(runners);
  logGlobalQueueProgress(metrics, options, true);
}

function takeNextReadyTask(pending, canStartTask, activeCount) {
  if (!Array.isArray(pending) || pending.length === 0) {
    return null;
  }
  const readyIndex = canStartTask ? pending.findIndex((task) => canStartTask(task)) : 0;
  if (readyIndex >= 0) {
    const task = pending.splice(readyIndex, 1)[0];
    return { task, index: task?.queueIndex ?? readyIndex };
  }
  if (activeCount <= 0) {
    const task = pending.shift();
    return { task, index: task?.queueIndex ?? 0 };
  }
  return null;
}

function logGlobalQueueProgress(metrics, options = {}, force = false) {
  if (!options.profileFrames) {
    return;
  }
  const now = Date.now();
  if (!force && metrics.completed < metrics.total && now - metrics.lastLoggedAt < 15_000) {
    return;
  }
  metrics.lastLoggedAt = now;
  const entries = Array.isArray(options.entries) ? options.entries : [];
  const built = entries.reduce((sum, entry) => sum + entry.built, 0);
  const reused = entries.reduce((sum, entry) => sum + entry.reused, 0);
  const failed = entries.reduce((sum, entry) => sum + entry.failed, 0);
  const byModel = entries
    .map((entry) => `${entry.modelKey}:${entry.built + entry.reused}/${entry.totalFrames}`)
    .join(" ");
  const workerStats = typeof options.workerPoolStats === "function" ? options.workerPoolStats() : null;
  const workerLabel = workerStats
    ? ` workers=${workerStats.busy}/${workerStats.size} workerQueue=${workerStats.queued}`
    : "";
  const persistStats = typeof options.persistQueueStats === "function" ? options.persistQueueStats() : null;
  const persistLabel = persistStats
    ? ` persist=${persistStats.active}/${persistStats.concurrency} persistQueue=${persistStats.queued}/${persistStats.backlogLimit} persisted=${persistStats.completed}/${persistStats.scheduled}`
    : "";
  console.log(
    `[noaa-beta] frame queue ${metrics.label} active=${metrics.active}/${metrics.concurrency} queued=${Math.max(0, metrics.total - metrics.started)} completed=${metrics.completed}/${metrics.total}${workerLabel}${persistLabel} built=${built} reused=${reused} failed=${failed}${byModel ? ` byModel=${byModel}` : ""}`,
  );
}

function sleepMs(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delay));
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

function isFullRunRequest(args) {
  const globalRaw = args.hours || process.env.MODELVIEW_NOAA_BETA_HOURS || "";
  return (
    parseBooleanOption(args.full || args["full-run"] || process.env.MODELVIEW_NOAA_FULL_RUN, false) ||
    String(globalRaw).trim().toLowerCase() === "full"
  );
}

function resolveHoursByModel({ args, models, fullRun = isFullRunRequest(args) }) {
  const globalRaw = args.hours || process.env.MODELVIEW_NOAA_BETA_HOURS || "";
  const commonHours = !fullRun && globalRaw ? parseHours(globalRaw) : null;
  const out = {};
  for (const modelKey of models) {
    const envKey = `MODELVIEW_NOAA_${modelKey.toUpperCase()}_HOURS`;
    const modelRaw = args[`hours-${modelKey}`] || process.env[envKey] || "";
    const hours = modelRaw
      ? parseHours(modelRaw)
      : fullRun
        ? buildFullHoursForModel(modelKey)
        : commonHours || parseHours(DEFAULT_HOURS.join(","));
    validateHoursForModel(hours, modelKey);
    out[modelKey] = hours;
  }
  return out;
}

function buildFullHoursForModel(modelKey) {
  const config = MODEL_CONFIG[modelKey] || {};
  const maxHour = Number(config.maxHour);
  const step = Math.max(1, Math.round(Number(config.frameStepHours) || 1));
  if (!Number.isFinite(maxHour) || maxHour < 0) {
    throw new Error(`Cannot build full forecast hour list for '${modelKey}'.`);
  }
  const hours = [];
  for (let hour = 0; hour <= maxHour; hour += step) {
    hours.push(hour);
  }
  return hours;
}

function formatHoursByModel(hoursByModel, models) {
  const values = models.map((modelKey) => `${modelKey}:${(hoursByModel[modelKey] || []).join(",")}`);
  return values.join(" ");
}

async function resolveAvailableNoaaHours({ modelKey, noaaBaseUrl, run, hours }) {
  const requestedHours = Array.isArray(hours) ? hours : [];
  const checks = await mapWithConcurrency(
    requestedHours,
    Math.min(16, Math.max(1, requestedHours.length)),
    async (hour) => ({
      hour,
      available: await noaaForecastHourExists({ modelKey, noaaBaseUrl, run, hour }),
    }),
  );
  const availableHours = [];
  for (const check of checks) {
    if (!check.available) {
      break;
    }
    availableHours.push(check.hour);
  }
  if (availableHours.length === 0) {
    throw new Error(`No available NOAA ${modelKey} forecast hours for ${run.date} ${run.cycle}Z.`);
  }
  if (availableHours.length < requestedHours.length) {
    const lastHour = availableHours[availableHours.length - 1];
    const nextHour = requestedHours[availableHours.length];
    console.log(
      `[noaa-beta] ${modelKey} ${run.date} ${run.cycle}Z capped at F${padHour(lastHour)}; F${padHour(nextHour)} is not published yet`,
    );
  }
  return availableHours;
}

async function noaaForecastHourExists({ modelKey, noaaBaseUrl, run, hour }) {
  const url = `${buildNoaaGribUrl({
    modelKey,
    baseUrl: noaaBaseUrl,
    date: run.date,
    cycle: run.cycle,
    hour,
  })}.idx`;
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
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

async function resolveNoaaModelRun({
  modelKey = "nam",
  noaaBaseUrl,
  date,
  cycle,
  hours,
  runOffset = 0,
  requireAllHours = false,
}) {
  const resolvedModelKey = normalizeNoaaModelKey(modelKey);
  if (date !== undefined || cycle !== undefined) {
    const normalizedDate = normalizeDate(date);
    const normalizedCycle = normalizeCycle(cycle, resolvedModelKey);
    return { date: normalizedDate, cycle: normalizedCycle };
  }
  const selectedRunOffset = clampInt(runOffset, 0, 24, 0);
  const candidates = buildRecentCycleCandidates(resolvedModelKey);
  const selectedHours = Array.isArray(hours) && hours.length > 0 ? hours : [0];
  const probeHours = requireAllHours
    ? Array.from(new Set([selectedHours[0] || 0, selectedHours[selectedHours.length - 1] || 0]))
    : [selectedHours[0] || 0];
  let availableIndex = 0;
  for (const candidate of candidates) {
    try {
      const responses = await Promise.all(
        probeHours.map((hour) =>
          fetch(
            `${buildNoaaGribUrl({
              modelKey: resolvedModelKey,
              baseUrl: noaaBaseUrl,
              date: candidate.date,
              cycle: candidate.cycle,
              hour,
            })}.idx`,
            { method: "HEAD" },
          ),
        ),
      );
      if (responses.every((response) => response.ok)) {
        if (availableIndex < selectedRunOffset) {
          availableIndex += 1;
          continue;
        }
        return candidate;
      }
    } catch {
      // Keep trying older cycles.
    }
  }
  throw new Error(
    `Unable to find a recent NOAA ${getNoaaGribModelConfig(resolvedModelKey).label} run. Try passing --date=YYYYMMDD --cycle=HH.`,
  );
}

function resolveNoaaNamRun({ noaaBaseUrl, date, cycle, hours }) {
  return resolveNoaaModelRun({ modelKey: "nam", noaaBaseUrl, date, cycle, hours });
}

async function resolveNoaaParameterSetForRun({ modelKey = "nam", noaaBaseUrl, run, hours }) {
  const probeHours = selectNoaaParameterProbeHours(hours);
  const indexTexts = await mapWithConcurrency(probeHours, Math.min(4, probeHours.length), async (hour) => {
    const idxUrl = `${buildNoaaGribUrl({
      modelKey,
      baseUrl: noaaBaseUrl,
      date: run.date,
      cycle: run.cycle,
      hour,
    })}.idx`;
    const response = await fetch(idxUrl);
    if (!response.ok) {
      throw new Error(`NOAA parameter probe failed (${response.status}) for ${idxUrl}`);
    }
    return response.text();
  });
  return resolveNoaaParameterSetFromIdxTexts(indexTexts, { modelKey });
}

function resolveNoaaParameterSetFromIdxText(indexText, options = {}) {
  return resolveNoaaParameterSetFromIdxTexts([indexText], options);
}

function resolveNoaaParameterSetFromIdxTexts(indexTexts, options = {}) {
  const selections = (Array.isArray(indexTexts) ? indexTexts : [])
    .map((indexText) => selectNoaaNamParameterRecords(parseNoaaIdx(indexText, null), { modelKey: options.modelKey }))
    .filter(Boolean);
  const availableParameters = new Set();
  for (const selection of selections) {
    for (const key of selection.availableParameters || []) {
      availableParameters.add(key);
    }
  }
  const requiredParameters = new Set(
    NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.required).map((entry) => entry.key),
  );
  const parameters = getNoaaNamParameterMetadata();
  const parameterOrder = getNoaaNamParameterOrder();
  const removeParameter = (key) => {
    delete parameters[key];
  };
  const unavailable = parameterOrder.filter((key) => !availableParameters.has(key) && !requiredParameters.has(key));
  unavailable.forEach(removeParameter);
  return {
    parameters,
    parameterOrder: parameterOrder.filter((key) => !unavailable.includes(key)),
  };
}

function selectNoaaParameterProbeHours(hours) {
  const orderedHours = Array.from(
    new Set(
      (Array.isArray(hours) ? hours : [])
        .map((hour) => Math.round(Number(hour)))
        .filter((hour) => Number.isFinite(hour) && hour >= 0),
    ),
  ).sort((left, right) => left - right);
  if (orderedHours.length === 0) {
    return [0];
  }
  const maxHour = orderedHours[orderedHours.length - 1];
  const selected = new Set([orderedHours[0], maxHour]);
  for (const anchor of [0, 1, 3, 6, 12, 24, 36, 48]) {
    const atOrAfter = orderedHours.find((hour) => hour >= anchor);
    if (Number.isFinite(atOrAfter)) {
      selected.add(atOrAfter);
    }
  }
  return Array.from(selected).sort((left, right) => left - right);
}

function buildNoaaModelMetadata({
  modelKey = "nam",
  run,
  hours,
  noaaBaseUrl,
  parameters = null,
  parameterOrder = null,
}) {
  const resolvedModelKey = normalizeNoaaModelKey(modelKey);
  const modelConfig = getNoaaGribModelConfig(resolvedModelKey);
  const baseUrl = String(noaaBaseUrl || modelConfig.baseUrl)
    .trim()
    .replace(/\/+$/, "");
  const referenceTime = referenceTimeFromRun(run);
  const runId = formatRunIdFromReference(referenceTime);
  const validTimes = hours.map((hour) => addHours(referenceTime, hour));
  return {
    modelKey: resolvedModelKey,
    openDataModel: modelConfig.openDataModel,
    latestUrl: `${buildNoaaGribUrl({
      modelKey: resolvedModelKey,
      baseUrl,
      date: run.date,
      cycle: run.cycle,
      hour: 0,
    })}.idx`,
    referenceTime,
    runId,
    runPath: `${resolvedModelKey}.${run.date}/${modelConfig.productKey}.t${run.cycle}z`,
    validTimes,
    crsWkt: null,
    sourceBounds: VIEW_CONFIG.conus.bounds,
    rawLatest: {
      source: NOAA_BETA_SOURCE_NAME,
      model: resolvedModelKey,
      date: run.date,
      cycle: run.cycle,
      hours,
    },
    noaa: {
      model: resolvedModelKey,
      baseUrl,
      date: run.date,
      cycle: run.cycle,
      product: modelConfig.productKey,
    },
    rendererSignature: getNoaaGribRendererSignature(),
    hoverGridFormat: "binary",
    parameters: parameters || getNoaaNamParameterMetadata(),
    parameterOrder: parameterOrder || getNoaaNamParameterOrder(),
    parameterKeys: parameterOrder || getNoaaNamParameterOrder(),
  };
}

function buildNoaaNamMetadata({ modelKey = "nam", run, hours, noaaBaseUrl }) {
  return buildNoaaModelMetadata({ modelKey, run, hours, noaaBaseUrl });
}

function buildRecentCycleCandidates(modelKey = "nam") {
  const modelConfig = getNoaaGribModelConfig(modelKey);
  const cycleHours = new Set((modelConfig.cycleHours || [0, 6, 12, 18]).map((hour) => Number(hour)));
  const nowMs = Date.now();
  const candidates = [];
  const seen = new Set();
  for (let hourOffset = 0; hourOffset <= 72; hourOffset += 1) {
    const date = new Date(nowMs - hourOffset * 60 * 60 * 1000);
    const cycleHour = date.getUTCHours();
    if (!cycleHours.has(cycleHour)) {
      continue;
    }
    const ymd = [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ].join("");
    const cycle = String(cycleHour).padStart(2, "0");
    const key = `${ymd}-${cycle}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ date: ymd, cycle });
    }
  }
  return candidates;
}

function referenceTimeFromRun(run) {
  const date = normalizeDate(run.date);
  const cycle = normalizeCycle(run.cycle);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${cycle}:00:00Z`;
}

function addHours(referenceTime, hour) {
  const date = new Date(Date.parse(referenceTime) + (Number(hour) || 0) * 60 * 60 * 1000);
  return date.toISOString().replace(".000Z", "Z");
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{8}$/.test(text)) {
    throw new Error("Expected NOAA date as YYYYMMDD.");
  }
  return text;
}

function normalizeCycle(value, modelKey = null) {
  const text = String(value || "").padStart(2, "0");
  if (!/^\d{2}$/.test(text) || Number(text) < 0 || Number(text) > 23) {
    throw new Error("Expected NOAA cycle as HH, 00 through 23.");
  }
  if (modelKey) {
    const config = getNoaaGribModelConfig(modelKey);
    const cycleHour = Number(text);
    if (!(config.cycleHours || []).includes(cycleHour)) {
      const supported = (config.cycleHours || []).map((hour) => String(hour).padStart(2, "0")).join(", ");
      throw new Error(`Expected NOAA ${config.label} cycle as one of ${supported}.`);
    }
  }
  return text;
}

function parseHours(raw) {
  const hours = String(raw || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.round(value));
  const unique = Array.from(new Set(hours)).sort((left, right) => left - right);
  if (unique.length === 0) {
    throw new Error("No forecast hours selected. Use --hours=0,3,6.");
  }
  return unique;
}

function validateHoursForModel(hours, modelKey) {
  const maxHour = MODEL_CONFIG[modelKey]?.maxHour;
  if (!Number.isFinite(maxHour)) {
    return;
  }
  const outOfRange = hours.find((hour) => hour > maxHour);
  if (outOfRange !== undefined) {
    throw new Error(`${modelKey} forecast hour ${outOfRange} exceeds max hour ${maxHour}.`);
  }
}

function resolveModels(raw) {
  const requested = String(raw || "nam")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const models = [];
  for (const token of requested) {
    const expanded = token === "all" || token === "noaa" ? NOAA_BETA_MODEL_KEYS : [token];
    for (const modelKey of expanded) {
      const normalized = normalizeNoaaModelKey(modelKey);
      if (!models.includes(normalized)) {
        models.push(normalized);
      }
    }
  }
  if (models.length === 0) {
    throw new Error(`No NOAA beta models selected. Supported: ${NOAA_BETA_MODEL_KEYS.join(", ")}`);
  }
  return models;
}

function normalizeNoaaModelKey(modelKey) {
  const key = String(modelKey || "")
    .trim()
    .toLowerCase();
  if (!NOAA_BETA_MODEL_CONFIG[key]) {
    throw new Error(`Unsupported NOAA beta model '${modelKey}'. Supported: ${NOAA_BETA_MODEL_KEYS.join(", ")}`);
  }
  return key;
}

function resolveNoaaBaseUrls(args, models) {
  const sharedNamBaseUrl = args["noaa-base-url"] || process.env.MODELVIEW_NOAA_BASE_URL || null;
  const out = {};
  for (const modelKey of NOAA_BETA_MODEL_KEYS) {
    const config = getNoaaGribModelConfig(modelKey);
    const envKey = `MODELVIEW_NOAA_${modelKey.toUpperCase()}_BASE_URL`;
    const argKey = `${modelKey}-base-url`;
    const raw =
      args[argKey] ||
      process.env[envKey] ||
      ((modelKey === "nam" || modelKey === "nam3km") && sharedNamBaseUrl ? sharedNamBaseUrl : null) ||
      config.baseUrl;
    out[modelKey] = String(raw || config.baseUrl)
      .trim()
      .replace(/\/+$/, "");
  }
  for (const modelKey of models) {
    if (!out[modelKey]) {
      throw new Error(`No NOAA base URL configured for '${modelKey}'.`);
    }
  }
  return out;
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

function parseBooleanOption(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(num)));
}

function padHour(hour) {
  return String(Math.max(0, Math.round(Number(hour) || 0))).padStart(3, "0");
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
