"use strict";

const { runWithConcurrency } = require("../local-artifact-concurrency");

const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");

const DEFAULT_FRAME_RETRIES = 2;

const DEFAULT_RETRY_DELAY_MS = 2_000;

const SNOWFALL_DERIVED_PARAMETER_KEYS = new Set(
  NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.kind === "snowfallDerived").map((entry) => entry.key),
);

const RUN_MAX_ACCUMULATION_PARAMETER_KEYS = new Set(["gustRunMax", "updraftHelicity2to5kmRunMax"]);

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

module.exports = {
  DEFAULT_FRAME_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  GlobalPersistQueue,
  RUN_MAX_ACCUMULATION_PARAMETER_KEYS,
  SNOWFALL_DERIVED_PARAMETER_KEYS,
  buildFrameRenderTasks,
  buildGlobalFrameQueue,
  buildLatestStatesWithGlobalFrameQueue,
  canStartFrameTaskWithDependencies,
  clampInt,
  compareGlobalFrameTasks,
  configureRunMaxFrameDependency,
  configureSnowfallFrameDependency,
  emitGlobalFrameFailure,
  emitGlobalProgress,
  logGlobalQueueProgress,
  markFrameTaskDependencyComplete,
  markGlobalFrameRecovered,
  modelQueueWeight,
  orderFramesForGlobalQueue,
  parseBooleanOption,
  previousDependencyHour,
  previousRunMaxDependencyHour,
  processGlobalFrameTask,
  runGlobalFrameTaskQueue,
  sleepMs,
  takeNextReadyTask,
};
