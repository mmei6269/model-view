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
  normalizeRenderedFrameArtifacts,
} = require("./local-artifact-manifest");
const { inferHoverGridFormatFromKey, mergeHoverGridPayloads } = require("./hover-grid-binary");
const { pathExists, readJsonIfExists, writeBufferAtomic, writeJsonAtomic } = require("./local-artifact-io");
const {
  clampInt,
  emitProgress,
  padHour,
  parseBooleanOption,
  parseOptionalNumber,
  sleep,
} = require("./local-artifact-options");

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
    this.prefetchFrameInput = typeof options.prefetchFrameInput === "function" ? options.prefetchFrameInput : null;
    this.stateCache = new Map();
    this.stateLoads = new Map();
    this.frameRenders = new Map();
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
    return this.applyManifestArtifactCompleteness(modelKey, runId, viewKey, manifest);
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
    const retryPrefetchConcurrency = clampInt(
      options.retryPrefetchConcurrency ?? options.retryOmPrefetchConcurrency,
      1,
      retryFrameConcurrency,
      retryFrameConcurrency,
    );
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const targetFrames = state.manifest.frames.filter(
      (frame) => maxHoursPerModel === null || Number(frame.hour) <= maxHoursPerModel,
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
      const prefetchFailure = state.primaryOmPrefetchFailures?.get(Number(frame.hour));
      if (prefetchFailure && (forceFrames || !(await this.isFrameCompleteForState(state, frame)))) {
        emitFrameFailure(frame, framePlan, prefetchFailure, active, retryAttempt, retryAttempt === 0);
        return false;
      }
      if (!forceFrames && (await this.isFrameCompleteForState(state, frame))) {
        state.manifest.hourStatus[String(frame.hour)] = "loaded";
        await this.refreshFrameArtifactBytes(frame);
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

    await this.prefetchFrameInputsForState(state, targetFrames, { onProgress });
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
        prefetchConcurrency: retryPrefetchConcurrency,
        built,
        reused,
        failed,
        completed,
        active,
      });
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      for (const frame of retryFrames) {
        state.primaryOmPrefetchFailures?.delete(Number(frame.hour));
      }

      await this.prefetchFrameInputsForState(state, retryFrames, {
        onProgress,
        concurrency: retryPrefetchConcurrency,
      });

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

  async prefetchFrameInputsForState(state, frames, options = {}) {
    if (!this.prefetchFrameInput || !Array.isArray(frames) || frames.length === 0) {
      return;
    }
    await this.prefetchFrameInput({ state, frames, options });
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
    if (!forceFrame && (await this.isFrameCompleteForState(state, frame))) {
      state.manifest.hourStatus[String(frame.hour)] = "loaded";
      await this.refreshFrameArtifactBytes(frame);
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
      primaryOmPrefetchFailures: new Map(),
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
    const framePlan = state.framePlanByHour.get(Number(frame.hour));
    const renderParams = {
      modelKey: state.modelKey,
      viewKey: state.viewKey,
      latestMetadata: state.latestMetadata,
      framePlan,
      pngCompressionLevel: this.pngCompressionLevel,
      pngFilterType: this.pngFilterType,
      reflectivityGates: this.reflectivityGates,
      renderWidth: frame.cols,
      renderHeight: frame.rows,
      renderMode: options.renderMode || "all",
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
          renderProfile: rendered.renderProfile || null,
        },
        frameMarkerWriteOptions,
      ),
    );
    if (
      rendered?.hoverGrid ||
      rendered?.hoverGridSupplemental ||
      rendered?.synopticVectors ||
      rendered?.weatherVectors ||
      rendered?.pressureUploadMeta
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

  async applyManifestArtifactCompleteness(modelKey, runId, viewKey, manifest, latestMetadata = null) {
    if (!manifest || !Array.isArray(manifest.frames)) {
      return manifest;
    }
    manifest.hourStatus =
      manifest.hourStatus && typeof manifest.hourStatus === "object" ? { ...manifest.hourStatus } : {};
    const expectedOpenDataModel =
      latestMetadata?.openDataModel || manifest.openDataModel || MODEL_CONFIG[modelKey]?.openDataModel || "";
    for (const frame of manifest.frames) {
      const hourKey = String(frame.hour);

      const complete = await this.isFrameComplete(modelKey, runId, viewKey, frame, {
        expectedOpenDataModel,
        expectedRendererSignature: latestMetadata?.rendererSignature,
      });
      if (complete) {
        manifest.hourStatus[hourKey] = "loaded";

        await this.refreshFrameArtifactBytes(frame);
      } else if (manifest.hourStatus[hourKey] === "error" || manifest.hourStatus[hourKey] === "unavailable") {
        continue;
      } else {
        manifest.hourStatus[hourKey] = "pending";
      }
    }
    return manifest;
  }

  async isFrameCompleteForState(state, frame) {
    return this.isFrameComplete(state.modelKey, state.runId, state.viewKey, frame, {
      expectedOpenDataModel: state.latestMetadata?.openDataModel || MODEL_CONFIG[state.modelKey]?.openDataModel || "",
      expectedRendererSignature: state.latestMetadata?.rendererSignature,
    });
  }

  async areFramesCompleteForState(state, frames) {
    if (!Array.isArray(frames) || frames.length === 0) {
      return false;
    }
    for (const frame of frames) {
      if (!(await this.isFrameCompleteForState(state, frame))) {
        return false;
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

  async isFrameComplete(modelKey, runId, viewKey, frame, options = {}) {
    const hour = Number(frame?.hour);
    if (!Number.isFinite(hour)) {
      return false;
    }
    const markerPath = this.getFrameMarkerPath(modelKey, runId, viewKey, hour);
    let marker = null;
    try {
      marker = await readJsonIfExists(markerPath);
    } catch {
      // Treat unreadable markers as incomplete frames.
    }
    if (!marker) {
      return false;
    }
    const expectedOpenDataModel = String(options.expectedOpenDataModel || "").trim();
    const markerOpenDataModel = String(marker.openDataModel || "").trim();
    if (expectedOpenDataModel && markerOpenDataModel && markerOpenDataModel !== expectedOpenDataModel) {
      return false;
    }
    const expectedRendererSignature = String(options.expectedRendererSignature || "").trim();
    const markerRendererSignature = String(marker.rendererSignature || "").trim();
    if (expectedRendererSignature && markerRendererSignature !== expectedRendererSignature) {
      return false;
    }
    const keys = collectFrameArtifactKeys(frame);
    if (keys.length === 0) {
      return false;
    }
    for (const key of keys) {
      if (!(await pathExists(this.getArtifactStoragePath(key)))) {
        return false;
      }
    }
    return true;
  }

  async refreshFrameArtifactBytes(frame) {
    for (const ref of collectFrameByteRefs(frame)) {
      const filePath = this.getArtifactStoragePath(ref.key);
      try {
        const stat = await fs.promises.stat(filePath);
        ref.bytes = stat.size;
      } catch {
        ref.bytes = 0;
      }
    }
    frame.synopticVectorBytes = frame.synopticVectorBytes || {};
    for (const mode of ["simple", "detailed"]) {
      const key = frame.synopticVectorKeys?.[mode] || (mode === "simple" ? frame.synopticVectorKey : null);
      if (!key) {
        continue;
      }
      try {
        const stat = await fs.promises.stat(this.getArtifactStoragePath(key));
        frame.synopticVectorBytes[mode] = stat.size;
      } catch {
        frame.synopticVectorBytes[mode] = 0;
      }
    }
    if (frame.hoverGridKey) {
      try {
        const stat = await fs.promises.stat(this.getArtifactStoragePath(frame.hoverGridKey));
        frame.hoverGridBytes = stat.size;
      } catch {
        frame.hoverGridBytes = 0;
      }
    }
    for (const ref of Object.values(frame.hoverGridSupplemental || {})) {
      if (!ref?.key) {
        continue;
      }
      try {
        const stat = await fs.promises.stat(this.getArtifactStoragePath(ref.key));
        ref.bytes = stat.size;
      } catch {
        ref.bytes = 0;
      }
    }
  }

  async writeManifestState(modelKey, viewKey, runId, manifest, latestPointer) {
    const manifestPath = this.getManifestStoragePath(modelKey, runId, viewKey);
    const latestPointerPath = this.getLatestPointerStoragePath(modelKey, viewKey);
    await writeJsonAtomic(manifestPath, manifest);
    await writeJsonAtomic(latestPointerPath, latestPointer);
    this.stats.manifestWrites += 2;
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
  if (Array.isArray(latestMetadata?.parameterOrder)) {
    manifest.parameterOrder = latestMetadata.parameterOrder;
  } else if (Array.isArray(latestMetadata?.parameterKeys)) {
    manifest.parameterOrder = latestMetadata.parameterKeys;
  }
  return manifest;
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
  normalizeRenderedFrameArtifacts,
};
