#!/usr/bin/env node

"use strict";

const { parentPort } = require("worker_threads");
const { renderNoaaGribFrame } = require("./lib/noaa-beta-renderer");
const { drainDerivedGridCacheWrites } = require("./lib/noaa-beta/derived-grid-cache");
const { prewarmDerivedWorkerPool } = require("./lib/noaa-beta/derived-parallel");
const { WORKER_METADATA_LRU_MAX_ENTRIES } = require("./lib/local-artifact-concurrency");

if (parentPort) {
  parentPort.on("message", handleWorkerMessage);
}

// Run-constant latestMetadata hydrated once per identity key by the pool
// (see FrameWorkerPool.buildJobMessage); subsequent frame payloads carry
// only the key. The pool mirrors this LRU's transitions exactly, so the
// shared capacity constant and the refresh/evict order below must stay in
// lockstep with buildJobMessage.
const HYDRATED_METADATA_BY_KEY = new Map();

const HYDRATED_METADATA_MAX_ENTRIES = WORKER_METADATA_LRU_MAX_ENTRIES;

function resolvePayloadLatestMetadata(payload) {
  const key = payload.latestMetadataKey;
  if (!key) {
    return payload.latestMetadata;
  }
  if (payload.latestMetadata) {
    if (HYDRATED_METADATA_BY_KEY.has(key)) {
      HYDRATED_METADATA_BY_KEY.delete(key);
    }
    HYDRATED_METADATA_BY_KEY.set(key, payload.latestMetadata);
    while (HYDRATED_METADATA_BY_KEY.size > HYDRATED_METADATA_MAX_ENTRIES) {
      HYDRATED_METADATA_BY_KEY.delete(HYDRATED_METADATA_BY_KEY.keys().next().value);
    }
    return payload.latestMetadata;
  }
  const cached = HYDRATED_METADATA_BY_KEY.get(key);
  if (!cached) {
    throw new Error(`Frame worker is missing hydrated run metadata for key '${key}'.`);
  }
  // Refresh LRU position so an active run's metadata is never evicted by
  // occasional frames from other models.
  HYDRATED_METADATA_BY_KEY.delete(key);
  HYDRATED_METADATA_BY_KEY.set(key, cached);
  return cached;
}

async function handleWorkerMessage(message) {
  if (!message || message.type !== "render-frame") {
    return;
  }
  const id = message.id;
  const payload = message.payload || {};
  try {
    const derivedCellConcurrency = Number(payload.derivedCellConcurrency) || 1;
    const renderMode = payload.renderMode || "all";
    if (derivedCellConcurrency > 1 && (renderMode === "all" || renderMode === "base")) {
      // Overlap sub-worker spawn + wasm compile with fetch/decode; failures
      // here are non-fatal (the derived stage re-detects dead workers and
      // the renderer falls back to serial compute). Snow/prefix part
      // selections strip every profile-derived product, so those payloads
      // can never reach the parallel path — warming a pool for them would
      // hold idle sub-worker threads for the rest of the build.
      void prewarmDerivedWorkerPool(derivedCellConcurrency);
    }
    payload.latestMetadata = resolvePayloadLatestMetadata(payload);
    const frameArtifacts = await renderNoaaGribFrame(payload);
    await drainDerivedGridCacheWrites();
    const serialized = serializeFrameArtifacts(frameArtifacts);
    parentPort.postMessage(
      {
        id,
        ok: true,
        frameArtifacts: serialized.frameArtifacts,
      },
      serialized.transferList,
    );
  } catch (error) {
    // Rendering can fail after scheduling a cache write. Drain that write
    // before reporting the failure so the pool cannot terminate this worker
    // while it still owns a temporary cache artifact.
    await drainDerivedGridCacheWrites();
    const modelKey = payload.modelKey || "unknown-model";
    const hour = Number.isFinite(Number(payload.framePlan?.hour))
      ? `F${String(Math.max(0, Math.round(Number(payload.framePlan.hour)))).padStart(3, "0")}`
      : "unknown-hour";
    const validTime = payload.framePlan?.validTime ? ` ${payload.framePlan.validTime}` : "";
    parentPort.postMessage({
      id,
      ok: false,
      error: `${modelKey} ${hour}${validTime}: ${String(error && error.message ? error.message : error)}`,
    });
  }
}

function serializeFrameArtifacts(frameArtifacts) {
  if (!frameArtifacts) {
    return { frameArtifacts: null, transferList: [] };
  }
  const layers = {};
  const reflectivityVariants = {};
  const reflectivityVariantsByLayer = {};
  let hoverGrid = null;
  const transferList = [];
  const transferredBuffers = new Set();
  for (const [layerName, layer] of Object.entries(frameArtifacts.layers || {})) {
    if (!layer || !Buffer.isBuffer(layer.body)) {
      continue;
    }
    layers[layerName] = serializeBinaryArtifact(layer, "image/png", transferList, transferredBuffers);
  }
  for (const [variantName, layer] of Object.entries(frameArtifacts.reflectivityVariants || {})) {
    if (!layer || !Buffer.isBuffer(layer.body)) {
      continue;
    }
    reflectivityVariants[variantName] = serializeBinaryArtifact(layer, "image/png", transferList, transferredBuffers);
  }
  for (const [layerName, variants] of Object.entries(frameArtifacts.reflectivityVariantsByLayer || {})) {
    const serializedVariants = {};
    for (const [variantName, layer] of Object.entries(variants || {})) {
      if (!layer || !Buffer.isBuffer(layer.body)) {
        continue;
      }
      serializedVariants[variantName] = serializeBinaryArtifact(layer, "image/png", transferList, transferredBuffers);
    }
    reflectivityVariantsByLayer[layerName] = serializedVariants;
  }
  if (frameArtifacts.hoverGrid && Buffer.isBuffer(frameArtifacts.hoverGrid.body)) {
    hoverGrid = {
      ...serializeBinaryArtifact(frameArtifacts.hoverGrid, "application/json", transferList, transferredBuffers),
      contentEncoding: frameArtifacts.hoverGrid.contentEncoding || "gzip",
      schemaVersion: frameArtifacts.hoverGrid.schemaVersion || 1,
    };
  }
  return {
    transferList,
    frameArtifacts: {
      hour: frameArtifacts.hour,
      validHourKey: frameArtifacts.validHourKey,
      bounds: frameArtifacts.bounds,
      cols: frameArtifacts.cols,
      rows: frameArtifacts.rows,
      modelToken: frameArtifacts.modelToken,
      referenceTime: frameArtifacts.referenceTime || null,
      // Pass absence through as null: partial renders (snow part of a split
      // frame) produce no centers, and fabricating an empty object here made
      // the manifest merge treat it as authoritative, clearing the centers the
      // base render had written (empty-synopticCenters manifest bug).
      synopticCenters: frameArtifacts.synopticCenters || null,
      synopticVector: frameArtifacts.synopticVector || null,
      synopticVectors: frameArtifacts.synopticVectors || null,
      contourVectors: frameArtifacts.contourVectors || null,
      synopticStyleVersion: frameArtifacts.synopticStyleVersion || null,
      synopticStyleVersions: frameArtifacts.synopticStyleVersions || null,
      pressureUploadMeta: frameArtifacts.pressureUploadMeta || null,
      sourceProvenance: frameArtifacts.sourceProvenance || null,
      parameterAvailability:
        frameArtifacts.parameterAvailability && typeof frameArtifacts.parameterAvailability === "object"
          ? { ...frameArtifacts.parameterAvailability }
          : null,
      hoverGrid,
      hoverGridSchemaVersion: frameArtifacts.hoverGridSchemaVersion || hoverGrid?.schemaVersion || null,
      renderProfile: frameArtifacts.renderProfile || null,
      reflectivityVariants,
      reflectivityVariantsByLayer,
      layers,
    },
  };
}

function serializeBinaryArtifact(artifact, fallbackContentType, transferList, transferredBuffers) {
  let bodyBuffer;
  if (artifact.body.byteOffset === 0 && artifact.body.byteLength === artifact.body.buffer.byteLength) {
    bodyBuffer = artifact.body.buffer;
  } else {
    bodyBuffer = Uint8Array.from(artifact.body).buffer;
  }
  if (!transferredBuffers.has(bodyBuffer)) {
    transferredBuffers.add(bodyBuffer);
    transferList.push(bodyBuffer);
  }
  return {
    bytes: artifact.bytes,
    contentType: artifact.contentType || fallbackContentType,
    body: bodyBuffer,
  };
}

module.exports = { serializeFrameArtifacts };
