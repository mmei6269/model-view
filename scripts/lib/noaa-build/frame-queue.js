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
  // Selective render scope; null keeps today's render-everything behavior.
  const renderSelection = options.renderSelection || null;
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
    // Target only this build's planned hours; union-merged frames from earlier
    // builds of the same run stay in the manifest without re-rendering.
    const targetFrames = state.manifest.frames.filter(
      (frame) => frame && state.framePlanByHour.has(Number(frame.hour)),
    );
    const entry = {
      index,
      modelKey,
      viewKey: state.viewKey,
      state,
      targetFrames,
      // Counts only this build's planned frames, not the full union-merged manifest.
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

  const initialTasks = buildFrameRenderTasks(buildGlobalFrameQueue(stateEntries.filter(Boolean)), {
    splitSnowfall: splitSnowfallFrames,
  });
  const inputPrefetch = startFrameInputPrefetch(runtime, initialTasks, {
    ...(options.inputPrefetch || {}),
    dispatchWidth: frameConcurrency,
    forceFrames,
    renderSelection,
  });
  try {
    await runGlobalFrameTaskQueue(
      initialTasks,
      frameConcurrency,
      (task) =>
        processGlobalFrameTask(runtime, task.entry, task.frame, {
          retryAttempt: 0,
          forceFrames,
          renderSelection,
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
        // Warm-first dispatch: defer cold main frames while the pump warms
        // them, so compute slots stay on warm work. Retries below stay FIFO
        // (by then inputs are cached or persistently failing).
        taskPriority: inputPrefetch ? inputPrefetch.taskPriority : null,
        onTaskFinished: markFrameTaskDependencyComplete,
      },
    );
  } finally {
    if (inputPrefetch) {
      // Stop even when the queue throws (failFast): a long-lived process
      // must not keep downloading for a build that already failed. In-flight
      // prefetches check the stop flag between stages and never lock-wait,
      // so the settle is normally a few seconds at most — but a stalled
      // network read must not hold the build (or a failFast error) hostage,
      // hence the bounded wait.
      inputPrefetch.stop();
      let settleTimer = null;
      const settled = await Promise.race([
        inputPrefetch.done.then(() => true),
        new Promise((resolve) => {
          settleTimer = setTimeout(() => resolve(false), 30_000);
          settleTimer.unref?.();
        }),
      ]);
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      const stats = inputPrefetch.stats;
      if (stats.prefetched > 0 || stats.failed > 0 || !settled) {
        console.log(
          `[noaa-beta] input prefetch: prefetched=${stats.prefetched} skipped=${stats.skipped} failed=${stats.failed}${settled ? "" : " (still settling; continuing)"}`,
        );
      }
    }
  }
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
      task.retryAttempt = retryAttempt;
    }
    for (const entry of retryEntries) {
      rearmFrameDependencyGatesForRetry(
        entry,
        entry.queueFrames.map((frame) => frame.hour),
      );
    }
    await runGlobalFrameTaskQueue(
      retryTasks,
      retryFrameConcurrency,
      (task) =>
        processGlobalFrameTask(runtime, task.entry, task.frame, {
          retryAttempt,
          forceFrames,
          renderSelection,
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
  const prefixOnlyFrame = renderPart === "snow-prefix";
  const runMaxPrefixOnlyFrame = renderPart === "runmax-prefix";
  const hour = Number(frame.hour);
  const retryAttempt = Math.max(0, Math.round(Number(options.retryAttempt) || 0));
  const currentFailure = entry.failedFrames?.get(hour);
  const failedThisAttempt =
    currentFailure && Math.max(0, Math.round(Number(currentFailure.retryAttempt) || 0)) === retryAttempt;
  if (entry.finishedFrameHours?.has(hour) || failedThisAttempt) {
    return true;
  }
  const forceFrames = parseBooleanOption(options.forceFrames ?? options.force, false);
  const renderSelection = options.renderSelection || null;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  // Per-invocation index: the reuse probe and the byte refresh share one
  // directory listing; each task invocation re-indexes so freshness matches
  // the per-key probes it replaces. Duck-typed runtimes without the factory
  // keep the per-key path.
  const statIndex = typeof runtime.createFrameStatIndex === "function" ? runtime.createFrameStatIndex() : null;
  if (!forceFrames && (await runtime.isFrameCompleteForState(state, frame, { statIndex }))) {
    state.manifest.hourStatus[String(frame.hour)] = "loaded";
    // The frameDir hint only feeds the stat index; duck-typed runtimes
    // without the factory keep the optionless per-key refresh and are never
    // required to implement getFrameDirectory.
    await runtime.refreshFrameArtifactBytes(
      frame,
      statIndex
        ? { statIndex, frameDir: runtime.getFrameDirectory(state.modelKey, state.runId, state.viewKey, frame.hour) }
        : {},
    );
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
    if (prefixOnlyFrame || runMaxPrefixOnlyFrame) {
      const rendered = await runtime.renderFrameArtifactsForState(state, frame, {
        forceFrames,
        persistManifestEachFrame: options.persistManifestEachFrame,
        renderMode,
        renderSelection,
        normalize: false,
      });
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
        renderSelection,
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
          renderSelection,
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
          renderSelection,
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
          renderSelection,
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
  // Once one part fails in an attempt, every remaining part of that hour is
  // skipped by processGlobalFrameTask. Fast-path only failures stamped with
  // THIS task's attempt: an older failure must flow through the real gates so
  // the retry can run base/snow-prefix/snow in order, while a fresh retry
  // failure must release the parked sibling parts so they can drain as skips.
  const taskAttempt = Math.max(0, Math.round(Number(task?.retryAttempt) || 0));
  const failure = Number.isFinite(hour) ? task.entry?.failedFrames?.get(hour) : null;
  const failedThisAttempt = failure && Math.max(0, Math.round(Number(failure.retryAttempt) || 0)) === taskAttempt;
  if (Number.isFinite(hour) && (task.entry?.finishedFrameHours?.has(hour) || failedThisAttempt)) {
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

// Retried hours must pass through the real dependency gates again, but the
// initial pass marked every part of a failed hour complete (onTaskFinished
// runs in the runner's finally even for failed and skipped tasks). Re-arm the
// gates for exactly the hours being retried; earlier successful hours keep
// their marks so chain gates (previous snow/runmax hour) stay satisfied.
function rearmFrameDependencyGatesForRetry(entry, hours) {
  for (const hour of hours) {
    const rounded = Math.round(Number(hour));
    if (!Number.isFinite(rounded)) {
      continue;
    }
    entry.completedBaseHours?.delete(rounded);
    entry.completedDeltaHours?.delete(rounded);
    entry.completedSnowPrefixHours?.delete(rounded);
    entry.completedRunMaxPrefixHours?.delete(rounded);
    entry.completedDependencyHours?.delete(rounded);
  }
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
  entry.failedFrames.set(hour, { frame, error: errorMessage, retryAttempt });
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

// Background main-GRIB prefetch: walks the queue-ordered main tasks
// (renderMode all/base — exactly one per frame; snow/prefix parts never
// materialize the main GRIB) and warms the content-addressed selected-GRIB
// cache ahead of worker dispatch, so the network runs while earlier frames
// compute instead of alternating fetch waves with compute waves. The worker
// fetch path is unchanged and authoritative: every pump failure is
// swallowed and counted, and prefetch/worker races settle through the
// selected-GRIB locks. Besides warming the cache, the controller is the
// warm-first dispatch oracle — taskPriority tells the queue which main
// frames cost no network right now. Returns a controller ({stop, done,
// stats, warmedTaskKeys, taskPriority}) or null when disabled or the
// prefetch module is unavailable.
function startFrameInputPrefetch(runtime, tasks, options = {}) {
  const concurrency = clampInt(options.concurrency, 0, 16, 0);
  if (concurrency < 1) {
    return null;
  }
  let prefetchFrameMainGribInput = options._prefetchImpl || null;
  if (!prefetchFrameMainGribInput) {
    try {
      ({ prefetchFrameMainGribInput } = require("./input-prefetch"));
    } catch (error) {
      // The module ships in-repo, so a load failure is always a regression
      // (e.g. the CATALOG_VERSION guard tripping). Stay fail-safe — a build
      // without prefetch is merely slower — but never silently: the only
      // other symptom is a missing summary line nobody would miss.
      console.warn(`[noaa-beta] input prefetch disabled: module load failed: ${String(error?.message || error)}`);
      return null;
    }
  }
  let mainTasks = (Array.isArray(tasks) ? tasks : []).filter(
    (task) => task && (task.renderMode === "all" || task.renderMode === "base"),
  );
  if (mainTasks.length === 0) {
    return null;
  }
  // The first ~dispatchWidth main tasks go straight to frame workers, which
  // fetch them concurrently with this pump; prefetching those first would
  // park every pump slot in a lock-wait behind a worker's own download.
  // Start the pump just past the initial dispatch wave and circle back to
  // the head tasks last (by then they are complete and skip cheaply).
  const dispatchWidth = clampInt(options.dispatchWidth, 0, mainTasks.length, 0);
  if (dispatchWidth > 0 && dispatchWidth < mainTasks.length) {
    mainTasks = mainTasks.slice(dispatchWidth).concat(mainTasks.slice(0, dispatchWidth));
  }
  // The workers' totalRangeFetchConcurrency budget is enforced by per-worker
  // allowances that cannot span this main-process pump, so the pump rides on
  // top of that budget at up to concurrency x 3 connections (24 at the
  // default 8 slots, against the 72-connection default worker budget and
  // its 128 cap). That is not additive in steady state: warm-first dispatch
  // routes most fetching THROUGH the pump, so pump connections replace
  // worker connections rather than stack on them — overlap is confined to
  // the cold first wave and pump-failure fallbacks.
  const rangeFetchConcurrency = Math.min(3, clampInt(options.rangeFetchConcurrency, 1, 64, 1));
  const warmTaskKey = (task) => `${task?.entry?.index ?? "?"}:${Math.round(Number(task?.frame?.hour))}`;
  const controller = {
    stopped: false,
    stats: { prefetched: 0, skipped: 0, failed: 0 },
    warmedTaskKeys: new Set(),
  };
  controller.stop = () => {
    controller.stopped = true;
  };
  // Dispatch priority for warm-first scheduling: 0 = start freely (part
  // tasks and dependency chains keep their natural order; main frames whose
  // selected GRIB the pump has warmed, or that are already finished, cost
  // no network), 1 = cold main frame (defer while preferred work exists —
  // the pump is likely already downloading it). Reuse-eligible frames the
  // pump has not probed yet are labeled cold until their probe lands; that
  // only delays a cheap task, never blocks it.
  controller.taskPriority = (task) => {
    if (!task || (task.renderMode !== "all" && task.renderMode !== "base")) {
      return 0;
    }
    const hour = Math.round(Number(task?.frame?.hour));
    if (task.entry?.finishedFrameHours?.has(hour)) {
      return 0;
    }
    return controller.warmedTaskKeys.has(warmTaskKey(task)) ? 0 : 1;
  };
  controller.done = runWithConcurrency(mainTasks, concurrency, async (task) => {
    if (controller.stopped) {
      return;
    }
    const entry = task.entry;
    const frame = task.frame;
    const hour = Math.round(Number(frame?.hour));
    try {
      if (entry.finishedFrameHours?.has(hour)) {
        controller.stats.skipped += 1;
        return;
      }
      const statIndex = typeof runtime.createFrameStatIndex === "function" ? runtime.createFrameStatIndex() : null;
      if (!options.forceFrames && (await runtime.isFrameCompleteForState(entry.state, frame, { statIndex }))) {
        // Complete on disk: the render task will reuse it without fetching,
        // so it dispatches as warm work.
        controller.warmedTaskKeys.add(warmTaskKey(task));
        controller.stats.skipped += 1;
        return;
      }
      if (controller.stopped) {
        return;
      }
      const warmed = await prefetchFrameMainGribInput({
        latestMetadata: entry.state.latestMetadata,
        modelKey: entry.modelKey,
        hour,
        renderMode: task.renderMode,
        renderSelection: options.renderSelection || null,
        rawCacheDir: options.rawCacheDir || null,
        noaaBaseUrl: options.noaaBaseUrls?.[entry.modelKey] || null,
        rangeFetchConcurrency,
        shouldStop: () => controller.stopped,
      });
      if (warmed) {
        controller.warmedTaskKeys.add(warmTaskKey(task));
        controller.stats.prefetched += 1;
      } else {
        // Declined without warming: missing metadata, a stop request, or a
        // lock already held by whoever is fetching these bytes right now.
        controller.stats.skipped += 1;
      }
    } catch {
      controller.stats.failed += 1;
    }
  }).catch(() => {});
  return controller;
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
  const taskPriority = typeof options.taskPriority === "function" ? options.taskPriority : null;
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
    warmPicks: 0,
    coldPicks: 0,
  };
  logGlobalQueueProgress(metrics, options, true);
  // A worker throw fails the whole queue (Promise.all rejects), so every
  // other runner must stop dispatching new frames: a long-lived process must
  // not keep downloading and rendering for a build that already failed.
  // In-flight tasks finish; parked runners wake via the thrower's finally.
  let aborted = false;
  const runners = Array.from({ length: workerCount }, async () => {
    while (!aborted && metrics.completed < metrics.total) {
      const current = takeNextReadyTask(pending, canStartTask, metrics.active, taskPriority);
      if (!current) {
        if (pending.length === 0) {
          break;
        }
        await waitForReadyChange();
        continue;
      }
      if (taskPriority && (current.task?.renderMode === "all" || current.task?.renderMode === "base")) {
        if (taskPriority(current.task) === 0) {
          metrics.warmPicks += 1;
        } else {
          metrics.coldPicks += 1;
        }
      }
      metrics.started += 1;
      metrics.active += 1;
      try {
        await worker(current.task, current.index);
      } catch (error) {
        aborted = true;
        throw error;
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

function takeNextReadyTask(pending, canStartTask, activeCount, taskPriority) {
  if (!Array.isArray(pending) || pending.length === 0) {
    return null;
  }
  // Warm-first dispatch: among ready tasks, prefer priority 0 (part tasks,
  // dependency chains, and main frames whose input the prefetch pump has
  // already warmed) over priority 1 (cold main frames). Picking a cold main
  // parks a compute slot in a network fetch the pump could run concurrently;
  // deferring it keeps CPUs on warm work while the pump drains the network.
  // Deferred, never starved: when no preferred task is ready, the first
  // ready task is taken regardless of priority. Exact old-FIFO degradation
  // holds only when no taskPriority hook is installed (pump disabled); a
  // live pump that never warms anything (no cache root, declined locks)
  // still prefers ready part tasks over earlier cold mains — an accepted,
  // order-safe reordering (dependency gates are consulted per candidate).
  let firstReadyIndex = -1;
  for (let index = 0; index < pending.length; index += 1) {
    const task = pending[index];
    if (canStartTask && !canStartTask(task)) {
      continue;
    }
    if (firstReadyIndex < 0) {
      firstReadyIndex = index;
    }
    if (!taskPriority || taskPriority(task) === 0) {
      const picked = pending.splice(index, 1)[0];
      return { task: picked, index: picked?.queueIndex ?? index };
    }
  }
  if (firstReadyIndex >= 0) {
    const task = pending.splice(firstReadyIndex, 1)[0];
    return { task, index: task?.queueIndex ?? firstReadyIndex };
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
  const dispatchLabel =
    metrics.warmPicks + metrics.coldPicks > 0 ? ` dispatch=warm:${metrics.warmPicks}/cold:${metrics.coldPicks}` : "";
  console.log(
    `[noaa-beta] frame queue ${metrics.label} active=${metrics.active}/${metrics.concurrency} queued=${Math.max(0, metrics.total - metrics.started)} completed=${metrics.completed}/${metrics.total}${workerLabel}${persistLabel} built=${built} reused=${reused} failed=${failed}${dispatchLabel}${byModel ? ` byModel=${byModel}` : ""}`,
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
  startFrameInputPrefetch,
  canStartFrameTaskWithDependencies,
  clampInt,
  compareGlobalFrameTasks,
  configureRunMaxFrameDependency,
  configureSnowfallFrameDependency,
  emitGlobalFrameFailure,
  rearmFrameDependencyGatesForRetry,
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
