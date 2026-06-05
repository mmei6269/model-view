#!/usr/bin/env node

"use strict";

const { parentPort } = require("worker_threads");
const { renderNoaaGribFrame } = require("./lib/noaa-beta-renderer");

if (!parentPort) {
  throw new Error("noaa-beta-frame-worker must run as a worker thread.");
}

parentPort.on("message", async (message) => {
  if (!message || message.type !== "render-frame") {
    return;
  }
  const id = message.id;
  const payload = message.payload || {};
  try {
    const frameArtifacts = await renderNoaaGribFrame(payload);
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
});

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
      synopticCenters: frameArtifacts.synopticCenters || { highs: [], lows: [] },
      synopticVector: frameArtifacts.synopticVector || null,
      synopticVectors: frameArtifacts.synopticVectors || null,
      contourVectors: frameArtifacts.contourVectors || null,
      synopticStyleVersion: frameArtifacts.synopticStyleVersion || null,
      synopticStyleVersions: frameArtifacts.synopticStyleVersions || null,
      pressureUploadMeta: frameArtifacts.pressureUploadMeta || null,
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
