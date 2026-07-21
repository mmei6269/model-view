"use strict";

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_ARTIFACT_PREFIX,
  DEFAULT_CACHE_ROOT,
  DEFAULT_REFLECTIVITY_GATES,
  DEFAULT_VIEW_KEY,
  LOCAL_SOURCE_NAME,
  MODEL_CONFIG,
  VIEW_CONFIG,
  buildLatestPointer,
  buildManifestTemplate,
  resolveCacheRoot,
} = require("./modelview-runtime");
const { AsyncSemaphore, runWithConcurrency } = require("./local-artifact-concurrency");
const {
  applyRenderedFrameToManifestFrame,
  buildEmptyHoverGridArtifact,
  buildEmptySynopticVectorPayload,
  collectFrameArtifactKeys,
  collectFrameByteRefs,
  createTransparentPng,
  mergeManifestWithTemplate,
  mergeParameterAvailability,
  normalizeParameterAvailability,
  normalizeRenderedFrameArtifacts,
} = require("./local-artifact-manifest");
const { inferHoverGridFormatFromKey, mergeHoverGridPayloads } = require("./hover-grid-binary");
const { pathExists, readJsonIfExists, writeBufferAtomic, writeJsonAtomic } = require("./local-artifact-io");
const { FrameStatIndex } = require("./local-artifact-stat-index");
const { getNoaaNamParameterMetadata } = require("./noaa-nam-parameter-catalog");
const { mergeFrameSourceProvenance, normalizeFrameSourceProvenance } = require("./noaa-beta/source-provenance");
const {
  clampInt,
  emitProgress,
  padHour,
  parseBooleanOption,
  parseOptionalNumber,
  sleep,
} = require("./local-artifact-options");

// Identity keys for run-constant latestMetadata objects shipped to frame
// workers. Keys follow object identity: any refreshed/replaced metadata
// object gets a fresh key, so workers can cache by key safely.
const LATEST_METADATA_IDENTITY_KEYS = new WeakMap();

// Bounded parallelism for multi-frame completeness sweeps
// (applyManifestArtifactCompleteness / areFramesCompleteForState). Each frame
// probes its own directory, so sweeps stay I/O-bound; 8 matches the default
// frame-build concurrency flavor without flooding the disk on serve polls.
const DEFAULT_COMPLETENESS_SWEEP_CONCURRENCY = 8;

let nextLatestMetadataIdentity = 0;
function latestMetadataIdentityKey(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  let key = LATEST_METADATA_IDENTITY_KEYS.get(metadata);
  if (!key) {
    nextLatestMetadataIdentity += 1;
    key = `latest-metadata-${process.pid}-${nextLatestMetadataIdentity}`;
    LATEST_METADATA_IDENTITY_KEYS.set(metadata, key);
  }
  return key;
}

class LocalArtifactRuntime {
  constructor(options = {}) {
    this.cacheRoot = resolveCacheRoot(options.cacheRoot || DEFAULT_CACHE_ROOT);
    this.artifactRoot = path.join(this.cacheRoot, "artifacts");
    this.artifactPrefix = String(options.artifactPrefix || DEFAULT_ARTIFACT_PREFIX).trim() || DEFAULT_ARTIFACT_PREFIX;
    this.sourceName = String(options.sourceName || LOCAL_SOURCE_NAME).trim() || LOCAL_SOURCE_NAME;
    this.defaultViewKey = String(options.defaultViewKey || DEFAULT_VIEW_KEY).trim() || DEFAULT_VIEW_KEY;
    this.reflectivityGates =
      Array.isArray(options.reflectivityGates) && options.reflectivityGates.length > 0
        ? options.reflectivityGates.map((value) => Number(value)).filter(Number.isFinite)
        : [...DEFAULT_REFLECTIVITY_GATES];
    this.latestMetadataTtlMs = Number.isFinite(options.latestMetadataTtlMs)
      ? Math.max(0, Number(options.latestMetadataTtlMs))
      : 60_000;
    this.fetchLatestMetadata = options.fetchLatestMetadata || missingMetadataProvider;
    this.renderFrameArtifacts = options.renderFrameArtifacts || missingFrameRenderer;
    this.renderWidthOverride = Number.isFinite(options.renderWidth) ? Number(options.renderWidth) : null;
    this.renderHeightOverride = Number.isFinite(options.renderHeight) ? Number(options.renderHeight) : null;
    this.pngCompressionLevel = Number.isFinite(options.pngCompressionLevel) ? Number(options.pngCompressionLevel) : 1;
    this.pngFilterType = Number.isFinite(options.pngFilterType) ? Number(options.pngFilterType) : 0;
    this.workerCount = clampInt(options.workerCount, 1, 96, 4);
    this.artifactWriteConcurrency = clampInt(options.artifactWriteConcurrency, 0, 256, 0);
    this.artifactWriteSemaphore =
      this.artifactWriteConcurrency > 0 ? new AsyncSemaphore(this.artifactWriteConcurrency) : null;
    this.stateCache = new Map();
    this.stateLoads = new Map();
    this.frameRenders = new Map();
    // Short-TTL cache of completeness-applied manifests keyed by
    // `${model}|${run}|${view}` -> { mtimeMs, etag, manifest, cachedAt }. Keyed on
    // the manifest file's mtime AND a short TTL so a frame finishing render (new
    // .complete.json marker, unchanged manifest mtime) still re-surfaces within a
    // poll or two while an idle run avoids re-running hundreds of fs ops per poll.
    this.manifestCompletenessCache = new Map();
    this.manifestCompletenessTtlMs = Number.isFinite(options.manifestCompletenessTtlMs)
      ? Math.max(0, Number(options.manifestCompletenessTtlMs))
      : 2_000;
    this.completenessSweepConcurrency = clampInt(
      options.completenessSweepConcurrency,
      1,
      64,
      DEFAULT_COMPLETENESS_SWEEP_CONCURRENCY,
    );
    this.stats = {
      latestFetches: 0,
      buildRuns: 0,
      buildFrames: 0,
      manifestWrites: 0,
      frameRenderRequests: 0,
      frameRenders: 0,
      frameRenderCacheHits: 0,
      frameRenderErrors: 0,
      staleRunPrunes: 0,
      assetWrites: 0,
      artifactWriteConcurrency: this.artifactWriteConcurrency,
    };
  }

  async init() {
    await fs.promises.mkdir(this.artifactRoot, { recursive: true });
  }

  async close() {
    // Kept for callers that close the runtime after a build.
  }

  getStats() {
    return {
      cacheRoot: this.cacheRoot,
      artifactRoot: this.artifactRoot,
      artifactPrefix: this.artifactPrefix,
      sourceName: this.sourceName,
      defaultViewKey: this.defaultViewKey,
      workerCount: this.workerCount,
      ...this.stats,
    };
  }

  async getLatestPointer(modelKey, viewKey = this.defaultViewKey) {
    const state = await this.ensureLatestState(modelKey, viewKey);
    return {
      model: state.manifest.model,
      run: state.manifest.run,
      view: state.manifest.view,
      generatedAt: state.latestPointer.generatedAt,
      manifestKey: state.latestPointer.manifestKey,
      frameCount: state.latestPointer.frameCount,
    };
  }

  async getManifest(modelKey, runId, viewKey = this.defaultViewKey) {
    const state = await this.ensureLatestState(modelKey, viewKey);
    if (String(runId || "").trim() !== state.runId) {
      return null;
    }
    return state.manifest;
  }

  async readLatestPointerFromDisk(modelKey, viewKey = this.defaultViewKey) {
    return readJsonIfExists(this.getLatestPointerStoragePath(modelKey, viewKey));
  }

  async readManifestFromDisk(modelKey, runId, viewKey = this.defaultViewKey) {
    const manifest = await readJsonIfExists(this.getManifestStoragePath(modelKey, runId, viewKey));
    if (!manifest) {
      return null;
    }
    refreshManifestParameterMetadata(manifest);
    return this.applyManifestArtifactCompleteness(modelKey, runId, viewKey, manifest);
  }

  async readManifestWithEtag(modelKey, runId, viewKey = this.defaultViewKey) {
    const manifestPath = this.getManifestStoragePath(modelKey, runId, viewKey);
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.promises.stat(manifestPath)).mtimeMs;
    } catch {
      return null;
    }
    const cacheKey = `${modelKey}|${runId}|${viewKey}`;
    const cached = this.manifestCompletenessCache.get(cacheKey);
    if (cached && cached.mtimeMs === mtimeMs && Date.now() - cached.cachedAt < this.manifestCompletenessTtlMs) {
      return { manifest: cached.manifest, etag: cached.etag };
    }
    const manifest = await this.readManifestFromDisk(modelKey, runId, viewKey);
    if (!manifest) {
      return null;
    }
    // ETag folds mtime + the derived per-hour completeness so a marker landing
    // (which changes hourStatus without touching the manifest file) still yields
    // a fresh tag and defeats a stale 304. The catalog-metadata stamp does the
    // same for serve-time parameter refreshes: upgrading the app (new legend
    // data) must invalidate manifests cached against the old metadata.
    const statusStamp = JSON.stringify(manifest.hourStatus || {});
    const etag = `"${mtimeMs.toString(36)}-${hashString(statusStamp).toString(36)}-${catalogMetadataStamp().toString(36)}"`;
    this.manifestCompletenessCache.set(cacheKey, { mtimeMs, etag, manifest, cachedAt: Date.now() });
    return { manifest, etag };
  }

  async buildLatestState(modelKey, viewKey = this.defaultViewKey, options = {}) {
    const state = await this.ensureLatestState(modelKey, viewKey, { forceRefresh: true });
    const maxHoursPerModel = parseOptionalNumber(options.maxHoursPerModel, null);
    const frameConcurrency = clampInt(options.frameConcurrency, 1, 64, Math.min(8, Math.max(1, this.workerCount || 4)));
    const persistManifestEachFrame = parseBooleanOption(options.persistManifestEachFrame, false);
    const failFast = parseBooleanOption(options.failFast, false);
    const forceFrames = parseBooleanOption(options.forceFrames ?? options.force, false);
    const frameRetries = failFast ? 0 : clampInt(options.frameRetries ?? options.frameRetryCount, 0, 5, 2);
    const retryDelayMs = clampInt(options.retryDelayMs, 0, 60_000, 2_000);
    const retryFrameConcurrency = clampInt(
      options.retryFrameConcurrency,
      1,
      frameConcurrency,
      Math.max(1, Math.min(2, Math.ceil(frameConcurrency / 4))),
    );
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    // Only frames in this build's plan are targets; union-merged frames from
    // earlier builds of the same run stay in the manifest without re-rendering.
    const targetFrames = state.manifest.frames.filter(
      (frame) =>
        state.framePlanByHour.has(Number(frame.hour)) &&
        (maxHoursPerModel === null || Number(frame.hour) <= maxHoursPerModel),
    );
    let built = 0;
    let reused = 0;
    let failed = 0;
    let completed = 0;
    let active = 0;
    const failedFrames = new Map();
    this.stats.buildRuns += 1;
    emitProgress(onProgress, {
      type: "build-start",
      modelKey: state.modelKey,
      viewKey: state.viewKey,
      runId: state.runId,
      totalFrames: targetFrames.length,
      built,
      reused,
      failed,
      completed,
      active,
    });

    const markFrameRecovered = (frame) => {
      const hour = Number(frame.hour);
      if (failedFrames.delete(hour)) {
        failed = Math.max(0, failed - 1);
      }
    };

    const emitFrameFailure = (frame, framePlan, error, activeCount, retryAttempt, countFailure) => {
      const hour = Number(frame.hour);
      const errorMessage = String(error?.message || error);
      if (countFailure) {
        failed += 1;
        completed += 1;
      }
      failedFrames.set(hour, { frame, error: errorMessage });
      state.manifest.hourStatus[String(frame.hour)] = "error";
      emitProgress(onProgress, {
        type: "frame-error",
        modelKey: state.modelKey,
        viewKey: state.viewKey,
        runId: state.runId,
        totalFrames: targetFrames.length,
        built,
        reused,
        failed,
        completed,
        active: activeCount,
        hour,
        validTime: framePlan?.validTime || frame.validHourKey,
        retryAttempt,
        error: errorMessage,
      });
      if (failFast) {
        throw new Error(errorMessage);
      }
    };

    const processFrame = async (frame, retryAttempt = 0) => {
      const framePlan = state.framePlanByHour.get(Number(frame.hour));
      // Per-invocation index: the completeness probe and the byte refresh share
      // one directory listing. Each retry attempt re-indexes, so a frame that
      // finished persisting between attempts is seen exactly as fresh per-key
      // probes would see it.
      const statIndex = this.createFrameStatIndex();
      if (!forceFrames && (await this.isFrameCompleteForState(state, frame, { statIndex }))) {
        state.manifest.hourStatus[String(frame.hour)] = "loaded";
        await this.refreshFrameArtifactBytes(frame, {
          statIndex,
          frameDir: this.getFrameDirectory(state.modelKey, state.runId, state.viewKey, frame.hour),
        });
        this.stats.frameRenderCacheHits += 1;
        if (retryAttempt > 0) {
          markFrameRecovered(frame);
        }
        reused += 1;
        if (retryAttempt === 0) {
          completed += 1;
        }
        emitProgress(onProgress, {
          type: "frame-reused",
          modelKey: state.modelKey,
          viewKey: state.viewKey,
          runId: state.runId,
          totalFrames: targetFrames.length,
          built,
          reused,
          failed,
          completed,
          active,
          hour: Number(frame.hour),
          validTime: framePlan?.validTime || frame.validHourKey,
          retryAttempt,
        });
        return true;
      }
      active += 1;
      emitProgress(onProgress, {
        type: "frame-start",
        modelKey: state.modelKey,
        viewKey: state.viewKey,
        runId: state.runId,
        totalFrames: targetFrames.length,
        built,
        reused,
        failed,
        completed,
        active,
        hour: Number(frame.hour),
        validTime: framePlan?.validTime || frame.validHourKey,
        retryAttempt,
      });
      try {
        const renderedFrame = await this.ensureFrameRenderedForState(state, frame, {
          forceFrames,
          persistManifestEachFrame,
        });
        const renderProfile = renderedFrame?.__renderProfile || null;
        if (retryAttempt > 0) {
          markFrameRecovered(frame);
        }
        built += 1;
        if (retryAttempt === 0) {
          completed += 1;
        }
        this.stats.buildFrames += 1;
        emitProgress(onProgress, {
          type: "frame-complete",
          modelKey: state.modelKey,
          viewKey: state.viewKey,
          runId: state.runId,
          totalFrames: targetFrames.length,
          built,
          reused,
          failed,
          completed,
          active: Math.max(0, active - 1),
          hour: Number(frame.hour),
          validTime: framePlan?.validTime || frame.validHourKey,
          retryAttempt,
          renderProfile,
        });
        return true;
      } catch (error) {
        emitFrameFailure(frame, framePlan, error, Math.max(0, active - 1), retryAttempt, retryAttempt === 0);
        return false;
      } finally {
        active = Math.max(0, active - 1);
      }
    };

    await runWithConcurrency(targetFrames, frameConcurrency, (frame) => processFrame(frame, 0));

    for (let retryAttempt = 1; retryAttempt <= frameRetries && failedFrames.size > 0; retryAttempt += 1) {
      const retryFrames = Array.from(failedFrames.values()).map((entry) => entry.frame);
      const delayMs = retryDelayMs * retryAttempt;
      emitProgress(onProgress, {
        type: "retry-start",
        modelKey: state.modelKey,
        viewKey: state.viewKey,
        runId: state.runId,
        totalFrames: targetFrames.length,
        failedFrames: retryFrames.length,
        retryAttempt,
        maxRetries: frameRetries,
        delayMs,
        frameConcurrency: retryFrameConcurrency,
        built,
        reused,
        failed,
        completed,
        active,
      });
      if (delayMs > 0) {
        await sleep(delayMs);
      }

      await runWithConcurrency(retryFrames, retryFrameConcurrency, (frame) => processFrame(frame, retryAttempt));
    }

    const targetFramesComplete = await this.areFramesCompleteForState(state, targetFrames);
    const manifestToWrite =
      targetFramesComplete && maxHoursPerModel !== null
        ? buildManifestForFrames(state.manifest, targetFrames)
        : state.manifest;
    if (built > 0 || failed > 0 || targetFramesComplete) {
      state.manifest.generatedAt = new Date().toISOString();
      state.manifest.source = this.sourceName;
      manifestToWrite.generatedAt = state.manifest.generatedAt;
      manifestToWrite.source = state.manifest.source;
      state.latestPointer.generatedAt = state.manifest.generatedAt;
      state.latestPointer.frameCount = manifestToWrite.frames.length;
      await this.writeManifestState(state.modelKey, state.viewKey, state.runId, manifestToWrite, state.latestPointer);
      state.manifest = manifestToWrite;
      state.frameByHour = new Map(manifestToWrite.frames.map((frame) => [Number(frame.hour), frame]));
    }
    emitProgress(onProgress, {
      type: "build-complete",
      modelKey: state.modelKey,
      viewKey: state.viewKey,
      runId: state.runId,
      totalFrames: targetFrames.length,
      built,
      reused,
      failed,
      completed,
      active,
    });
    return {
      modelKey: state.modelKey,
      viewKey: state.viewKey,
      runId: state.runId,
      frameCount: targetFrames.length,
      built,
      reused,
      failed,
      latestPointer: state.latestPointer,
      manifest: state.manifest,
    };
  }

  async ensureFrameRendered(modelKey, runId, viewKey, hour, options = {}) {
    const state = await this.ensureLatestState(modelKey, viewKey);
    if (String(runId || "").trim() !== state.runId) {
      throw new Error(`Run '${runId}' is no longer current for ${modelKey}/${viewKey}.`);
    }
    const frame = state.frameByHour.get(Number(hour));
    if (!frame) {
      throw new Error(`Unknown frame hour '${hour}' for ${modelKey}/${viewKey}.`);
    }
    return this.ensureFrameRenderedForState(state, frame, options);
  }

  async ensureFrameRenderedForState(state, frame, options = {}) {
    const hour = Number(frame?.hour);
    if (!Number.isFinite(hour)) {
      throw new Error(`Unknown frame hour '${frame?.hour}' for ${state.modelKey}/${state.viewKey}.`);
    }
    const forceFrame = parseBooleanOption(options.forceFrame ?? options.forceFrames ?? options.force, false);
    const statIndex = this.createFrameStatIndex();
    if (!forceFrame && (await this.isFrameCompleteForState(state, frame, { statIndex }))) {
      state.manifest.hourStatus[String(frame.hour)] = "loaded";
      await this.refreshFrameArtifactBytes(frame, {
        statIndex,
        frameDir: this.getFrameDirectory(state.modelKey, state.runId, state.viewKey, frame.hour),
      });
      this.stats.frameRenderCacheHits += 1;
      return frame;
    }
    const renderKey = `${state.modelKey}|${state.runId}|${state.viewKey}|${hour}`;
    const inFlight = this.frameRenders.get(renderKey);
    if (inFlight) {
      return inFlight;
    }
    this.stats.frameRenderRequests += 1;
    const request = this.renderAndPersistFrame(state, frame, options)
      .catch((error) => {
        this.stats.frameRenderErrors += 1;
        throw error;
      })
      .finally(() => {
        this.frameRenders.delete(renderKey);
      });
    this.frameRenders.set(renderKey, request);
    return request;
  }

  async ensureLatestState(modelKey, viewKey = this.defaultViewKey, options = {}) {
    const stateKey = `${modelKey}|${viewKey}`;
    const forceRefresh = Boolean(options.forceRefresh);
    const cached = this.stateCache.get(stateKey);
    if (!forceRefresh && cached && Date.now() - cached.checkedAt < this.latestMetadataTtlMs) {
      return cached;
    }
    const inFlight = !forceRefresh ? this.stateLoads.get(stateKey) : null;
    if (inFlight) {
      return inFlight;
    }
    const request = this.loadLatestState(modelKey, viewKey).finally(() => {
      this.stateLoads.delete(stateKey);
    });
    this.stateLoads.set(stateKey, request);
    return request;
  }

  async loadLatestState(modelKey, viewKey) {
    if (!MODEL_CONFIG[modelKey]) {
      throw new Error(`Unsupported model '${modelKey}'.`);
    }
    if (!VIEW_CONFIG[viewKey]) {
      throw new Error(`Unsupported view '${viewKey}'.`);
    }
    await this.init();
    this.stats.latestFetches += 1;
    const latestMetadata = await this.fetchLatestMetadata({
      modelKey,
      viewKey,
    });
    const runId = latestMetadata.runId;
    const template = buildManifestTemplate({
      modelKey,
      viewKey,
      runId,
      referenceTime: latestMetadata.referenceTime,
      validTimes: latestMetadata.validTimes,
      artifactPrefix: this.artifactPrefix,
      renderWidth: this.getRenderWidth(viewKey),
      renderHeight: this.getRenderHeight(viewKey),
      reflectivityGates: this.reflectivityGates,
      parameterKeys: latestMetadata.parameterKeys || latestMetadata.parameterOrder || null,
      parameters: latestMetadata.parameters || null,
      parameterOrder: latestMetadata.parameterOrder || latestMetadata.parameterKeys || null,
      hoverGridFormat: latestMetadata.hoverGridFormat || null,
      renderSelection: latestMetadata.renderSelection || null,
      // The build's resolved roster (e.g. the GFS hourly-through-F120 tier)
      // must drive the frame plan; the model's configured step only guards
      // legacy metadata that carries no roster.
      forecastHours: Array.isArray(latestMetadata.forecastHourRoster?.hours)
        ? latestMetadata.forecastHourRoster.hours
        : null,
    });
    const manifestPath = this.getManifestStoragePath(modelKey, runId, viewKey);
    const existingManifest = await readJsonIfExists(manifestPath);
    const manifest = mergeManifestWithTemplate(existingManifest, template);
    applyLatestMetadataToManifest(manifest, latestMetadata, this.sourceName);
    await this.applyManifestArtifactCompleteness(modelKey, runId, viewKey, manifest, latestMetadata);
    const latestPointer = buildLatestPointer({
      modelKey,
      runId,
      viewKey,
      frameCount: manifest.frames.length,
    });
    await this.writeManifestState(modelKey, viewKey, runId, manifest, latestPointer);
    const state = {
      modelKey,
      viewKey,
      runId,
      latestMetadata,
      manifest,
      manifestPath,
      latestPointer,
      checkedAt: Date.now(),
      frameByHour: new Map(manifest.frames.map((frame) => [Number(frame.hour), frame])),
      framePlanByHour: new Map(
        template.frames.map((frame) => [
          Number(frame.hour),
          {
            hour: Number(frame.hour),
            validTime: String(frame.validHourKey),
          },
        ]),
      ),
    };
    this.stateCache.set(`${modelKey}|${viewKey}`, state);
    return state;
  }

  async renderAndPersistFrame(state, frame, options = {}) {
    const normalized = await this.renderFrameArtifactsForState(state, frame, options);
    return this.persistRenderedFrameForState(state, frame, normalized, options);
  }

  async renderFrameArtifactsForState(state, frame, options = {}) {
    this.stats.frameRenders += 1;
    // Union-merged frames can predate this build's plan; fall back to the
    // frame's own valid time so on-demand renders keep working.
    const framePlan = state.framePlanByHour.get(Number(frame.hour)) || {
      hour: Number(frame.hour),
      validTime: String(frame.validHourKey),
    };
    const renderParams = {
      modelKey: state.modelKey,
      viewKey: state.viewKey,
      latestMetadata: state.latestMetadata,
      // Identity key for run-constant metadata: the worker pool ships the
      // metadata once per worker per key and workers cache it, so per-frame
      // structured clones carry only this string. A refreshed metadata
      // object gets a new key automatically.
      latestMetadataKey: latestMetadataIdentityKey(state.latestMetadata),
      framePlan,
      pngCompressionLevel: this.pngCompressionLevel,
      pngFilterType: this.pngFilterType,
      reflectivityGates: this.reflectivityGates,
      renderWidth: frame.cols,
      renderHeight: frame.rows,
      renderMode: options.renderMode || "all",
      renderSelection: options.renderSelection || null,
    };
    const rendered = await this.renderFrameArtifacts(renderParams);
    if (options.normalize === false) {
      return rendered;
    }
    return normalizeRenderedFrameArtifacts(rendered, frame, this.reflectivityGates);
  }

  async persistRenderedFrameForState(state, frame, normalized, options = {}) {
    const persistStartedAt = performance.now();
    await this.persistFrameArtifacts(state, frame, normalized, options);
    if (normalized.renderProfile?.stages) {
      normalized.renderProfile.stages.persistMs = roundMs(performance.now() - persistStartedAt);
    }
    const renderedFrame = state.frameByHour.get(Number(frame.hour)) || frame;
    attachFrameRenderProfile(renderedFrame, normalized.renderProfile);
    attachFrameSourceProvenance(
      renderedFrame,
      mergeFrameSourceProvenance(renderedFrame.__sourceProvenance, normalized.sourceProvenance),
    );
    return renderedFrame;
  }

  async persistFrameArtifacts(state, frame, rendered, options = {}) {
    const partialFrame = parseBooleanOption(options.partialFrame, false);
    const framePlan = state.framePlanByHour.get(Number(frame.hour));
    const frameDir = this.getFrameDirectory(state.modelKey, state.runId, state.viewKey, frame.hour);
    await fs.promises.mkdir(frameDir, { recursive: true });
    const frameMarkerPath = this.getFrameMarkerPath(state.modelKey, state.runId, state.viewKey, frame.hour);
    await fs.promises.unlink(frameMarkerPath).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
    const frameArtifactWriteOptions = { ensureDir: false, atomic: false };
    const frameMarkerWriteOptions = { ensureDir: false };
    const writes = [];
    const queuedWritePaths = new Set();
    let artifactWriteBytes = 0;
    const queueBufferWrite = (targetPath, body) => {
      if (!targetPath || queuedWritePaths.has(targetPath)) {
        return;
      }
      queuedWritePaths.add(targetPath);
      artifactWriteBytes += byteLengthOfArtifactBody(body);
      writes.push(this.runArtifactWrite(() => writeBufferAtomic(targetPath, body, frameArtifactWriteOptions)));
    };
    const queueJsonWrite = (targetPath, payload) => {
      const body = Buffer.from(JSON.stringify(payload));
      if (!targetPath || queuedWritePaths.has(targetPath)) {
        return body.length;
      }
      queuedWritePaths.add(targetPath);
      artifactWriteBytes += body.length;
      writes.push(this.runArtifactWrite(() => writeBufferAtomic(targetPath, body, frameArtifactWriteOptions)));
      return body.length;
    };
    const renderedLayers = rendered?.layers || {};
    const renderedReflectivityVariants = rendered?.reflectivityVariants || {};
    const renderedReflectivityVariantsByLayer = rendered?.reflectivityVariantsByLayer || {};
    for (const [layerKey, ref] of Object.entries(frame.layers || {})) {
      if (isReflectivityLayerKey(layerKey)) {
        continue;
      }
      const artifact = renderedLayers[layerKey];
      if (!artifact) {
        continue;
      }
      const targetPath = this.getArtifactStoragePath(ref.key);
      queueBufferWrite(targetPath, artifact.body);
    }
    for (const [variantKey, ref] of Object.entries(frame.reflectivityVariants || {})) {
      const artifact = renderedReflectivityVariants[variantKey];
      if (!artifact) {
        continue;
      }
      const targetPath = this.getArtifactStoragePath(ref.key);
      queueBufferWrite(targetPath, artifact.body);
    }
    for (const [layerKey, variants] of Object.entries(frame.reflectivityVariantsByLayer || {})) {
      const renderedVariants = renderedReflectivityVariantsByLayer?.[layerKey] || {};
      for (const [variantKey, ref] of Object.entries(variants || {})) {
        const artifact = renderedVariants[variantKey];
        if (!artifact) {
          continue;
        }
        const targetPath = this.getArtifactStoragePath(ref.key);
        queueBufferWrite(targetPath, artifact.body);
      }
    }
    if (rendered?.synopticVectors) {
      const simpleVectorPath = this.getArtifactStoragePath(frame.synopticVectorKeys.simple);
      const detailedVectorPath = this.getArtifactStoragePath(frame.synopticVectorKeys.detailed);
      rendered.synopticVectorBytes = {
        simple: queueJsonWrite(simpleVectorPath, rendered.synopticVectors.simple),
        detailed: queueJsonWrite(detailedVectorPath, rendered.synopticVectors.detailed),
      };
    }
    if (rendered?.contourVectors) {
      for (const [layerKey, payload] of Object.entries(rendered.contourVectors || {})) {
        const ref = frame.contourVectorRefs?.[layerKey];
        if (!ref?.key || !payload) {
          continue;
        }
        ref.bytes = queueJsonWrite(this.getArtifactStoragePath(ref.key), payload);
      }
    }
    if (rendered?.weatherVectors) {
      for (const [layerKey, payload] of Object.entries(rendered.weatherVectors || {})) {
        const ref = frame.weatherVectorRefs?.[layerKey];
        if (!ref?.key || !payload) {
          continue;
        }
        ref.bytes = queueJsonWrite(this.getArtifactStoragePath(ref.key), payload);
      }
    }
    if (rendered?.hoverGrid?.body) {
      const supplementalHoverGridName = normalizeSupplementalHoverGridName(options.supplementalHoverGridName);
      if (supplementalHoverGridName) {
        const supplementalKey = buildSupplementalHoverGridKey(frame.hoverGridKey, supplementalHoverGridName);
        const supplementalBody = rendered.hoverGrid.body;
        const supplementalPath = this.getArtifactStoragePath(supplementalKey);
        rendered.hoverGridSupplemental = {
          ...(rendered.hoverGridSupplemental || {}),
          [supplementalHoverGridName]: {
            key: supplementalKey,
            bytes: byteLengthOfArtifactBody(supplementalBody),
            schemaVersion: Number(rendered.hoverGridSchemaVersion) || Number(rendered.hoverGrid.schemaVersion) || 0,
          },
        };
        delete rendered.hoverGrid;
        queueBufferWrite(supplementalPath, supplementalBody);
      } else {
        const hoverGridPath = this.getArtifactStoragePath(frame.hoverGridKey);
        let hoverGridBody = rendered.hoverGrid.body;
        if (options.mergeHoverGrid) {
          hoverGridBody = await this.mergeHoverGridArtifactBody(hoverGridPath, hoverGridBody, frame.hoverGridKey);
          rendered.hoverGrid = {
            ...rendered.hoverGrid,
            body: hoverGridBody,
            bytes: hoverGridBody.length,
          };
        }
        queueBufferWrite(hoverGridPath, hoverGridBody);
      }
    }
    if (rendered.renderProfile) {
      rendered.renderProfile.artifactWriteCount = writes.length;
      rendered.renderProfile.artifactWriteBytes = artifactWriteBytes;
    }
    await Promise.all(writes);
    this.stats.assetWrites += writes.length;
    if (partialFrame) {
      applyRenderedFrameToManifestFrame(frame, rendered);
      await this.refreshFrameArtifactBytes(frame);
      return;
    }
    const markerParameterAvailability = mergeParameterAvailability(
      frame.parameterAvailability,
      rendered?.parameterAvailability,
    );
    const markerSourceProvenance = mergeFrameSourceProvenance(
      frame.__sourceProvenance,
      rendered?.sourceProvenance || rendered?.renderProfile?.sourceProvenance,
    );
    const markerRenderProfile = {
      ...(rendered?.renderProfile && typeof rendered.renderProfile === "object" ? rendered.renderProfile : {}),
    };
    // Provenance is a single top-level marker sidecar. Older profiles also
    // embedded the identical object, doubling forensic metadata bytes.
    delete markerRenderProfile.sourceProvenance;
    await this.runArtifactWrite(() =>
      writeJsonAtomic(
        frameMarkerPath,
        {
          renderedAt: new Date().toISOString(),
          modelKey: state.modelKey,
          viewKey: state.viewKey,
          runId: state.runId,
          hour: frame.hour,
          validTime: framePlan?.validTime || frame.validHourKey,
          openDataModel: state.latestMetadata.openDataModel,
          runPath: state.latestMetadata.runPath,
          rendererSignature: state.latestMetadata.rendererSignature || null,
          parameterAvailability: normalizeParameterAvailability(markerParameterAvailability),
          sourceProvenance: normalizeFrameSourceProvenance(markerSourceProvenance),
          renderProfile: markerRenderProfile,
        },
        frameMarkerWriteOptions,
      ),
    );
    if (
      rendered?.hoverGrid ||
      rendered?.hoverGridSupplemental ||
      rendered?.synopticVectors ||
      rendered?.weatherVectors ||
      rendered?.pressureUploadMeta ||
      rendered?.parameterAvailability
    ) {
      applyRenderedFrameToManifestFrame(frame, rendered);
    }
    const needsSupplementalBaseRefresh = Boolean(rendered?.hoverGridSupplemental && !rendered?.hoverGrid);
    if (needsSupplementalBaseRefresh || parseBooleanOption(options.refreshFrameArtifactBytesAfterWrite, false)) {
      await this.refreshFrameArtifactBytes(frame);
    }
    state.manifest.hourStatus[String(frame.hour)] = "loaded";
    state.manifest.generatedAt = new Date().toISOString();
    applyLatestMetadataToManifest(state.manifest, state.latestMetadata, this.sourceName);
    state.latestPointer.generatedAt = state.manifest.generatedAt;
    state.latestPointer.frameCount = state.manifest.frames.length;
    if (parseBooleanOption(options.persistManifestEachFrame, false)) {
      await this.writeManifestState(state.modelKey, state.viewKey, state.runId, state.manifest, state.latestPointer);
    }
  }

  async mergeHoverGridArtifactBody(targetPath, incomingBody, hoverGridKey) {
    try {
      const existingBody = await fs.promises.readFile(targetPath);
      return mergeHoverGridPayloads(existingBody, incomingBody, {
        format: inferHoverGridFormatFromKey(hoverGridKey),
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return incomingBody;
      }
      throw error;
    }
  }

  runArtifactWrite(task) {
    if (this.artifactWriteSemaphore) {
      return this.artifactWriteSemaphore.run(task);
    }
    return task();
  }

  createFrameStatIndex() {
    // Sweep-scoped by contract: never cache one across sweeps. The next sweep
    // (TTL poll, retry attempt, build-end check) re-reads every directory —
    // the same freshness boundary per-key probes had.
    return new FrameStatIndex();
  }

  // Artifact presence for one key. Keys from buildFrameAssetKeySet are direct
  // children of their frame directory, so a sweep index answers them from one
  // readdir; a key escaping the frame dir keeps the per-key probe it had.
  async frameArtifactExists(frameDir, key, statIndex) {
    const storagePath = this.getArtifactStoragePath(key);
    if (statIndex && frameDir && path.dirname(storagePath) === frameDir) {
      return statIndex.has(frameDir, path.basename(storagePath));
    }
    return pathExists(storagePath);
  }

  // Stat for one key: fs.Stats on success, null on any failure — the exact
  // contract refreshFrameArtifactBytes has always read sizes from.
  async statFrameArtifact(frameDir, key, statIndex) {
    const storagePath = this.getArtifactStoragePath(key);
    if (statIndex && frameDir && path.dirname(storagePath) === frameDir) {
      return statIndex.stat(frameDir, path.basename(storagePath));
    }
    try {
      return await fs.promises.stat(storagePath);
    } catch {
      return null;
    }
  }

  async applyManifestArtifactCompleteness(modelKey, runId, viewKey, manifest, latestMetadata = null) {
    if (!manifest || !Array.isArray(manifest.frames)) {
      return manifest;
    }
    manifest.hourStatus =
      manifest.hourStatus && typeof manifest.hourStatus === "object" ? { ...manifest.hourStatus } : {};
    const expectedOpenDataModel =
      latestMetadata?.openDataModel || manifest.openDataModel || MODEL_CONFIG[modelKey]?.openDataModel || "";
    // One sweep-scoped stat index: each frame directory is listed once and
    // entry stats are memoized per path, replacing the per-key access/stat
    // probes. Mutations are strictly per frame (hourStatus key, frame byte
    // fields, marker-merged availability), so bounded parallelism across frame
    // dirs leaves the manifest byte-identical — hourStatus keys are canonical
    // integers and serialize in ascending numeric order regardless of worker
    // completion order.
    const statIndex = this.createFrameStatIndex();
    await runWithConcurrency(manifest.frames, this.completenessSweepConcurrency, async (frame) => {
      const hourKey = String(frame.hour);

      const complete = await this.isFrameComplete(modelKey, runId, viewKey, frame, {
        expectedOpenDataModel,
        expectedRendererSignature: latestMetadata?.rendererSignature,
        statIndex,
      });
      if (complete) {
        manifest.hourStatus[hourKey] = "loaded";

        await this.refreshFrameArtifactBytes(frame, {
          statIndex,
          frameDir: this.getFrameDirectory(modelKey, runId, viewKey, frame.hour),
        });
      } else if (manifest.hourStatus[hourKey] === "error" || manifest.hourStatus[hourKey] === "unavailable") {
        return;
      } else {
        manifest.hourStatus[hourKey] = "pending";
      }
    });
    return manifest;
  }

  async isFrameCompleteForState(state, frame, options = {}) {
    return this.isFrameComplete(state.modelKey, state.runId, state.viewKey, frame, {
      expectedOpenDataModel: state.latestMetadata?.openDataModel || MODEL_CONFIG[state.modelKey]?.openDataModel || "",
      expectedRendererSignature: state.latestMetadata?.rendererSignature,
      statIndex: options.statIndex || null,
    });
  }

  async areFramesCompleteForState(state, frames) {
    if (!Array.isArray(frames) || frames.length === 0) {
      return false;
    }
    // Probe one bounded batch at a time, each frame on a throwaway copy: the
    // marker availability merge feeds key collection, so it cannot be
    // deferred past the probe. Results are replayed on the real frames in
    // order through the first incomplete frame inclusive — the exact mutation
    // window of the old sequential early-exit loop. Batching keeps directory
    // reads parallel while ensuring an early miss launches at most one batch,
    // rather than eagerly probing an entire 209-frame GFS horizon. A shallow
    // copy is full isolation: the probe's only frame write is the
    // parameterAvailability ASSIGNMENT in mergeMarkerParameterAvailability
    // (always a freshly merged object, never an in-place edit), so cloning
    // the byte refs, hover maps, and provenance of 209 GFS frames per sweep
    // would buy nothing.
    const statIndex = this.createFrameStatIndex();
    const expectedOpenDataModel =
      state.latestMetadata?.openDataModel || MODEL_CONFIG[state.modelKey]?.openDataModel || "";
    const batchSize = Math.min(this.completenessSweepConcurrency, frames.length);
    for (let offset = 0; offset < frames.length; offset += batchSize) {
      const batch = frames.slice(offset, offset + batchSize);
      const probes = new Array(batch.length);
      await runWithConcurrency(batch, batchSize, async (frame, index) => {
        probes[index] = await this.probeFrameComplete(
          state.modelKey,
          state.runId,
          state.viewKey,
          { ...frame },
          {
            expectedOpenDataModel,
            expectedRendererSignature: state.latestMetadata?.rendererSignature,
            statIndex,
          },
        );
      });
      for (let index = 0; index < batch.length; index += 1) {
        mergeMarkerParameterAvailability(frames[offset + index], probes[index].availabilityMarker);
        if (!probes[index].complete) {
          return false;
        }
      }
    }
    return true;
  }

  async listRunManifests(modelKey, viewKey = this.defaultViewKey) {
    const manifestsDir = path.join(this.artifactRoot, "manifests", modelKey);
    if (!(await pathExists(manifestsDir))) {
      return [];
    }
    const latestPointer = await readJsonIfExists(this.getLatestPointerStoragePath(modelKey, viewKey));
    const suffix = `--${viewKey}.json`;
    const runIds = (await fs.promises.readdir(manifestsDir))
      .filter((entry) => entry.endsWith(suffix) && !entry.startsWith("latest--"))
      .map((entry) => entry.slice(0, -suffix.length))
      .filter(Boolean)
      .sort()
      .reverse();
    const runs = [];
    for (const runId of runIds) {
      const manifest = await this.readManifestFromDisk(modelKey, runId, viewKey);
      if (!manifest) {
        continue;
      }
      const hourStatus = manifest.hourStatus && typeof manifest.hourStatus === "object" ? manifest.hourStatus : {};
      const loadedFrameCount = manifest.frames.filter((frame) => hourStatus[String(frame.hour)] === "loaded").length;
      const pointer = buildLatestPointer({
        modelKey,
        runId,
        viewKey,
        frameCount: manifest.frames.length,
      });
      pointer.generatedAt = manifest.generatedAt || pointer.generatedAt;
      runs.push({
        ...pointer,
        loadedFrameCount,
        complete: loadedFrameCount === manifest.frames.length && manifest.frames.length > 0,
        latest: latestPointer?.run === runId,
      });
    }
    return runs;
  }

  // Completeness probe: marker fetch + artifact presence. Returns the
  // decision plus the marker exactly when it passed the identity gates — the
  // point at which the availability merge fires — so parallel sweeps probing
  // on clones can replay that merge onto the real frames in order. Note the
  // merge must precede collectFrameArtifactKeys: an "unavailable" stamp
  // narrows the probed key set.
  async probeFrameComplete(modelKey, runId, viewKey, frame, options = {}) {
    const hour = Number(frame?.hour);
    if (!Number.isFinite(hour)) {
      return { complete: false, availabilityMarker: null };
    }
    const markerPath = this.getFrameMarkerPath(modelKey, runId, viewKey, hour);
    let marker = null;
    try {
      marker = await readJsonIfExists(markerPath);
    } catch {
      // Treat unreadable markers as incomplete frames.
    }
    if (!marker) {
      return { complete: false, availabilityMarker: null };
    }
    const expectedOpenDataModel = String(options.expectedOpenDataModel || "").trim();
    const markerOpenDataModel = String(marker.openDataModel || "").trim();
    if (expectedOpenDataModel && markerOpenDataModel && markerOpenDataModel !== expectedOpenDataModel) {
      return { complete: false, availabilityMarker: null };
    }
    const expectedRendererSignature = String(options.expectedRendererSignature || "").trim();
    const markerRendererSignature = String(marker.rendererSignature || "").trim();
    if (expectedRendererSignature && markerRendererSignature !== expectedRendererSignature) {
      return { complete: false, availabilityMarker: null };
    }
    mergeMarkerParameterAvailability(frame, marker);
    const keys = collectFrameArtifactKeys(frame);
    if (keys.length === 0) {
      return { complete: false, availabilityMarker: marker };
    }
    const frameDir = this.getFrameDirectory(modelKey, runId, viewKey, hour);
    const statIndex = options.statIndex || null;
    for (const key of keys) {
      if (!(await this.frameArtifactExists(frameDir, key, statIndex))) {
        return { complete: false, availabilityMarker: marker };
      }
    }
    return { complete: true, availabilityMarker: marker };
  }

  async isFrameComplete(modelKey, runId, viewKey, frame, options = {}) {
    const probe = await this.probeFrameComplete(modelKey, runId, viewKey, frame, options);
    return probe.complete;
  }

  async refreshFrameArtifactBytes(frame, options = {}) {
    const statIndex = options.statIndex || null;
    const frameDir = typeof options.frameDir === "string" ? options.frameDir : null;
    const statByKey = (key) => this.statFrameArtifact(frameDir, key, statIndex);
    for (const ref of collectFrameByteRefs(frame)) {
      const stat = await statByKey(ref.key);
      ref.bytes = stat ? stat.size : 0;
    }
    frame.synopticVectorBytes = frame.synopticVectorBytes || {};
    for (const mode of ["simple", "detailed"]) {
      const key = frame.synopticVectorKeys?.[mode] || (mode === "simple" ? frame.synopticVectorKey : null);
      if (!key) {
        continue;
      }
      const stat = await statByKey(key);
      frame.synopticVectorBytes[mode] = stat ? stat.size : 0;
    }
    if (frame.hoverGridKey) {
      const stat = await statByKey(frame.hoverGridKey);
      frame.hoverGridBytes = stat ? stat.size : 0;
    }
    for (const ref of Object.values(frame.hoverGridSupplemental || {})) {
      if (!ref?.key) {
        continue;
      }
      const stat = await statByKey(ref.key);
      ref.bytes = stat ? stat.size : 0;
    }
  }

  async writeManifestState(modelKey, viewKey, runId, manifest, latestPointer) {
    const manifestPath = this.getManifestStoragePath(modelKey, runId, viewKey);
    const latestPointerPath = this.getLatestPointerStoragePath(modelKey, viewKey);
    await writeJsonAtomic(manifestPath, manifest);
    this.stats.manifestWrites += 1;
    if (!(await this.shouldAdvanceLatestPointer(modelKey, viewKey, runId, manifest))) {
      return;
    }
    await writeJsonAtomic(latestPointerPath, latestPointer);
    this.stats.manifestWrites += 1;
  }

  // latest--<view>.json advances to a different run only once that run is
  // usably complete. A missing pointer is bootstrapped immediately, and the
  // run the pointer already names keeps refreshing so progressive builds of
  // the current latest run stay live. In-progress runs remain selectable
  // through their run manifests and listRunManifests regardless.
  async shouldAdvanceLatestPointer(modelKey, viewKey, runId, manifest) {
    // A corrupt pointer file must not abort the build: treat an unreadable or
    // unparseable pointer as missing so the current run bootstraps over it.
    let existingPointer = null;
    try {
      existingPointer = await readJsonIfExists(this.getLatestPointerStoragePath(modelKey, viewKey));
    } catch {
      existingPointer = null;
    }
    if (!existingPointer || String(existingPointer.run || "") === String(runId || "")) {
      return true;
    }
    // Accepted edge: explicitly rebuilding an OLD completed run re-takes the
    // pointer from a newer run. Production flow always resolves the current
    // run first, so this is unreachable in normal operation.
    return isManifestUsablyComplete(manifest);
  }

  async pruneStaleRuns(modelKey, activeRunId) {
    const manifestsDir = path.join(this.artifactRoot, "manifests", modelKey);
    const artifactsDir = path.join(this.artifactRoot, this.artifactPrefix, modelKey);
    if (await pathExists(manifestsDir)) {
      const entries = await fs.promises.readdir(manifestsDir);
      await Promise.all(
        entries.map(async (entry) => {
          if (entry.startsWith(`${activeRunId}--`) || entry.startsWith("latest--")) {
            return;
          }
          await fs.promises.rm(path.join(manifestsDir, entry), { force: true });
        }),
      );
    }
    if (await pathExists(artifactsDir)) {
      const entries = await fs.promises.readdir(artifactsDir);
      await Promise.all(
        entries.map(async (entry) => {
          if (entry === activeRunId) {
            return;
          }
          await fs.promises.rm(path.join(artifactsDir, entry), { recursive: true, force: true });
        }),
      );
    }
    this.stats.staleRunPrunes += 1;
  }

  getRenderWidth(viewKey) {
    return Number.isFinite(this.renderWidthOverride) ? this.renderWidthOverride : VIEW_CONFIG[viewKey].width;
  }

  getRenderHeight(viewKey) {
    return Number.isFinite(this.renderHeightOverride) ? this.renderHeightOverride : VIEW_CONFIG[viewKey].height;
  }

  getManifestStoragePath(modelKey, runId, viewKey) {
    return path.join(this.artifactRoot, "manifests", modelKey, `${runId}--${viewKey}.json`);
  }

  getLatestPointerStoragePath(modelKey, viewKey) {
    return path.join(this.artifactRoot, "manifests", modelKey, `latest--${viewKey}.json`);
  }

  getArtifactStoragePath(key) {
    return path.join(this.artifactRoot, String(key || "").replace(/^\/+/, ""));
  }

  getFrameDirectory(modelKey, runId, viewKey, hour) {
    return path.join(this.artifactRoot, this.artifactPrefix, modelKey, runId, viewKey, padHour(hour));
  }

  getFrameMarkerPath(modelKey, runId, viewKey, hour) {
    return path.join(this.getFrameDirectory(modelKey, runId, viewKey, hour), ".complete.json");
  }
}

// The marker-availability merge a completeness check applies once the marker
// passes the identity gates. Probe-based sweeps replay it in frame order
// after parallel read-only probes, preserving the sequential mutation window.
function mergeMarkerParameterAvailability(frame, marker) {
  if (marker?.parameterAvailability && typeof marker.parameterAvailability === "object") {
    frame.parameterAvailability = mergeParameterAvailability(frame.parameterAvailability, marker.parameterAvailability);
  }
}

function applyLatestMetadataToManifest(manifest, latestMetadata, sourceName = LOCAL_SOURCE_NAME) {
  if (!manifest || typeof manifest !== "object") {
    return manifest;
  }
  manifest.source = sourceName;
  const openDataModel = String(latestMetadata?.openDataModel || "").trim();
  if (openDataModel) {
    manifest.openDataModel = openDataModel;
    for (const frame of manifest.frames || []) {
      frame.modelToken = openDataModel;
    }
  }
  if (latestMetadata?.parameters && typeof latestMetadata.parameters === "object") {
    manifest.parameters = latestMetadata.parameters;
  }
  if (latestMetadata?.rendererSignature) {
    manifest.rendererSignature = String(latestMetadata.rendererSignature);
  }
  if (latestMetadata?.forecastHourPolicy && typeof latestMetadata.forecastHourPolicy === "object") {
    manifest.forecastHourPolicy = { ...latestMetadata.forecastHourPolicy };
  }
  if (latestMetadata?.forecastHourRoster && typeof latestMetadata.forecastHourRoster === "object") {
    manifest.forecastHourRoster = {
      ...latestMetadata.forecastHourRoster,
      hours: Array.isArray(latestMetadata.forecastHourRoster.hours) ? [...latestMetadata.forecastHourRoster.hours] : [],
    };
  }
  if (latestMetadata?.sourceProvenanceCatalog && typeof latestMetadata.sourceProvenanceCatalog === "object") {
    manifest.sourceProvenanceCatalog = latestMetadata.sourceProvenanceCatalog;
  }
  if (Array.isArray(latestMetadata?.parameterOrder)) {
    manifest.parameterOrder = latestMetadata.parameterOrder;
  } else if (Array.isArray(latestMetadata?.parameterKeys)) {
    manifest.parameterOrder = latestMetadata.parameterKeys;
  }
  return manifest;
}

// A run is usably complete when every frame in its manifest is marker-verified
// as loaded: builds set hourStatus per persisted frame, and loadLatestState
// re-derives it from .complete.json markers plus on-disk artifacts.
function isManifestUsablyComplete(manifest) {
  const frames = Array.isArray(manifest?.frames) ? manifest.frames : [];
  if (frames.length === 0) {
    return false;
  }
  const hourStatus = manifest?.hourStatus && typeof manifest.hourStatus === "object" ? manifest.hourStatus : {};
  return frames.every((frame) => hourStatus[String(frame.hour)] === "loaded");
}

let cachedCatalogMetadata = null;
let cachedCatalogMetadataStamp = null;

function catalogMetadata() {
  if (!cachedCatalogMetadata) {
    cachedCatalogMetadata = getNoaaNamParameterMetadata();
  }
  return cachedCatalogMetadata;
}

function catalogMetadataStamp() {
  if (cachedCatalogMetadataStamp === null) {
    cachedCatalogMetadataStamp = hashString(JSON.stringify(catalogMetadata()));
  }
  return cachedCatalogMetadataStamp;
}

// PRESENTATION metadata only. Behavioral and provenance fields
// (minForecastHour, accumulationMode/WindowHours, category, costTier,
// methodVersion, derivation, applicability, formulaReference, sourceNote,
// artifactRequired) describe how the ARTIFACTS ON DISK were built and gated —
// overlaying current catalog values onto old runs would hide parameters whose
// rendered layers exist, or claim a method version the frames were never
// computed with.
const PRESENTATION_METADATA_FIELDS = Object.freeze([
  "label",
  "unit",
  "thresholdNote",
  "legendTicks",
  "legendTickPositions",
  "legendStops",
  "legendType",
  "legendDisplayScale",
  "precipTypeLegend",
  "precipRateTypeLegend",
  "contourIntervalDam",
  "contourLevelMb",
]);

// Serve-time refresh: manifest parameter metadata is a build-time snapshot of
// the catalog. Legend fixes must not require re-rendering hundreds of GB of
// artifacts, so every read overlays the CURRENT catalog's presentation fields
// onto the keys the manifest already carries. Keys are never added: selective
// builds filter deselected parameters out of the manifest, and that gating
// must survive the refresh. Values are cloned so a caller mutating a served
// manifest can never corrupt the shared catalog cache.
function refreshManifestParameterMetadata(manifest) {
  const parameters = manifest?.parameters;
  if (!parameters || typeof parameters !== "object") {
    return;
  }
  const metadata = catalogMetadata();
  for (const key of Object.keys(parameters)) {
    const fresh = metadata[key];
    const entry = parameters[key];
    if (!fresh || !entry || typeof entry !== "object") {
      continue;
    }
    for (const field of PRESENTATION_METADATA_FIELDS) {
      if (fresh[field] === undefined) {
        delete entry[field];
      } else {
        entry[field] = structuredClone(fresh[field]);
      }
    }
  }
}

function hashString(text) {
  let hash = 5381;
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function byteLengthOfArtifactBody(body) {
  if (!body) {
    return 0;
  }
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
    return Number(body.byteLength) || 0;
  }
  if (body instanceof ArrayBuffer) {
    return Number(body.byteLength) || 0;
  }
  return Buffer.byteLength(String(body));
}

function normalizeSupplementalHoverGridName(name) {
  const value = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return value || null;
}

function buildSupplementalHoverGridKey(baseKey, name) {
  const key = String(baseKey || "").trim();
  const suffix = normalizeSupplementalHoverGridName(name);
  if (!key || !suffix) {
    return key;
  }
  const replaced = key.replace(/\/hover-grid(\.[^/.]+)?\.gz$/i, `/hover-grid-${suffix}$1.gz`);
  return replaced === key ? `${key}.${suffix}` : replaced;
}

function buildManifestForFrames(manifest, frames) {
  const selectedHours = new Set(frames.map((frame) => String(frame.hour)));
  const hourStatus = {};
  for (const [hour, status] of Object.entries(manifest.hourStatus || {})) {
    if (selectedHours.has(String(hour))) {
      hourStatus[hour] = status;
    }
  }
  return {
    ...manifest,
    frames: manifest.frames.filter((frame) => selectedHours.has(String(frame.hour))),
    hourStatus,
  };
}

function attachFrameRenderProfile(frame, renderProfile) {
  if (!frame || !renderProfile) {
    return;
  }
  Object.defineProperty(frame, "__renderProfile", {
    value: renderProfile,
    enumerable: false,
    configurable: true,
  });
}

function attachFrameSourceProvenance(frame, provenance) {
  if (!frame || !provenance) {
    return;
  }
  Object.defineProperty(frame, "__sourceProvenance", {
    value: provenance,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function roundMs(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

async function missingMetadataProvider() {
  throw new Error("LocalArtifactRuntime requires a fetchLatestMetadata provider for artifact builds.");
}

async function missingFrameRenderer() {
  throw new Error("LocalArtifactRuntime requires a renderFrameArtifacts provider for frame builds.");
}

function isReflectivityLayerKey(layerKey) {
  return layerKey === "reflectivity" || layerKey === "reflectivityComposite" || layerKey === "reflectivity1km";
}

module.exports = {
  LocalArtifactRuntime,
  applyRenderedFrameToManifestFrame,
  buildEmptyHoverGridArtifact,
  buildEmptySynopticVectorPayload,
  createTransparentPng,
  isManifestUsablyComplete,
  normalizeRenderedFrameArtifacts,
};
