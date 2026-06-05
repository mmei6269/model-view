"use strict";

const zlib = require("zlib");
const { PNG } = require("pngjs");
const { HOVER_GRID_SCHEMA_VERSION, SYNOPTIC_STYLE_VERSION } = require("./modelview-runtime");
const { encodeHoverGridBinaryPayload, inferHoverGridFormatFromKey } = require("./hover-grid-binary");

const HOVER_GRID_MISSING_VALUE = -32768;
const LEGACY_REFLECTIVITY_LAYER_KEY = "reflectivity";
const REFLECTIVITY_LAYER_KEYS = Object.freeze(["reflectivityComposite", "reflectivity1km"]);
const EMPTY_PNG_CACHE = new Map();
const EMPTY_HOVER_GRID_CACHE = new Map();

function mergeManifestWithTemplate(existingManifest, template) {
  if (!existingManifest || existingManifest.run !== template.run || existingManifest.view !== template.view) {
    return template;
  }
  const existingByHour = new Map((existingManifest.frames || []).map((frame) => [Number(frame.hour), frame]));
  const frames = template.frames.map((frame) => mergeFrameRecord(existingByHour.get(Number(frame.hour)), frame));
  const existingHourStatus =
    existingManifest.hourStatus && typeof existingManifest.hourStatus === "object" ? existingManifest.hourStatus : {};
  const hourStatus = {};
  for (const frame of frames) {
    hourStatus[String(frame.hour)] = normalizeHourStatus(existingHourStatus[String(frame.hour)]);
  }
  return {
    ...template,
    generatedAt: existingManifest.generatedAt || template.generatedAt,
    frames,
    hourStatus,
  };
}

function normalizeHourStatus(status) {
  const value = String(status || "").trim();
  if (
    value === "loaded" ||
    value === "loading" ||
    value === "error" ||
    value === "pending" ||
    value === "unavailable"
  ) {
    return value;
  }
  return "pending";
}

function mergeFrameRecord(existingFrame, templateFrame) {
  if (!existingFrame) {
    return templateFrame;
  }
  return {
    ...templateFrame,
    synopticCenters: existingFrame.synopticCenters || templateFrame.synopticCenters,
    synopticVectorBytes: mergeSynopticVectorBytes(existingFrame.synopticVectorBytes, templateFrame.synopticVectorBytes),
    synopticStyleVersion: existingFrame.synopticStyleVersion || templateFrame.synopticStyleVersion,
    synopticStyleVersions: existingFrame.synopticStyleVersions || templateFrame.synopticStyleVersions,
    contourVectorRefs: mergeLayerRefs(existingFrame.contourVectorRefs, templateFrame.contourVectorRefs),
    weatherVectorRefs: mergeLayerRefs(existingFrame.weatherVectorRefs, templateFrame.weatherVectorRefs),
    pressureUploadMeta: existingFrame.pressureUploadMeta || templateFrame.pressureUploadMeta,
    hoverGridBytes: Number(existingFrame.hoverGridBytes) || Number(templateFrame.hoverGridBytes) || 0,
    hoverGridSchemaVersion: Number(existingFrame.hoverGridSchemaVersion) || templateFrame.hoverGridSchemaVersion,
    hoverGridSupplemental: mergeHoverGridSupplementalRefs(
      existingFrame.hoverGridSupplemental,
      templateFrame.hoverGridSupplemental,
    ),
    layers: mergeLayerRefs(existingFrame.layers, templateFrame.layers),
    reflectivityVariants: mergeLayerRefs(existingFrame.reflectivityVariants, templateFrame.reflectivityVariants),
    reflectivityVariantsByLayer: mergeLayerRefGroups(
      existingFrame.reflectivityVariantsByLayer,
      templateFrame.reflectivityVariantsByLayer,
    ),
  };
}

function mergeSynopticVectorBytes(existingBytes, templateBytes) {
  return {
    simple: Number(existingBytes?.simple) || Number(templateBytes?.simple) || 0,
    detailed: Number(existingBytes?.detailed) || Number(templateBytes?.detailed) || 0,
  };
}

function mergeLayerRefs(existingRefs, templateRefs) {
  const out = {};
  for (const [key, value] of Object.entries(templateRefs || {})) {
    const existing = existingRefs?.[key];
    out[key] = existing ? { ...value, bytes: Number(existing.bytes) || 0 } : value;
  }
  return out;
}

function collectFrameArtifactKeys(frame) {
  const keys = [];
  for (const ref of collectFrameByteRefs(frame)) {
    keys.push(ref.key);
  }
  if (frame?.synopticVectorKeys?.simple) {
    keys.push(frame.synopticVectorKeys.simple);
  } else if (frame?.synopticVectorKey) {
    keys.push(frame.synopticVectorKey);
  }
  if (frame?.synopticVectorKeys?.detailed) {
    keys.push(frame.synopticVectorKeys.detailed);
  }
  if (frame?.hoverGridKey) {
    keys.push(frame.hoverGridKey);
  }
  for (const ref of Object.values(frame?.contourVectorRefs || {})) {
    if (ref?.key) {
      keys.push(ref.key);
    }
  }
  for (const ref of Object.values(frame?.weatherVectorRefs || {})) {
    if (ref?.key) {
      keys.push(ref.key);
    }
  }
  for (const ref of Object.values(frame?.hoverGridSupplemental || {})) {
    if (ref?.key && Number(ref.bytes) > 0) {
      keys.push(ref.key);
    }
  }
  return keys.filter((key, index) => key && keys.indexOf(key) === index);
}

function collectFrameByteRefs(frame) {
  const refs = [];
  for (const ref of Object.values(frame?.layers || {})) {
    if (ref?.key) {
      refs.push(ref);
    }
  }
  for (const ref of Object.values(frame?.reflectivityVariants || {})) {
    if (ref?.key) {
      refs.push(ref);
    }
  }
  for (const variants of Object.values(frame?.reflectivityVariantsByLayer || {})) {
    for (const ref of Object.values(variants || {})) {
      if (ref?.key) {
        refs.push(ref);
      }
    }
  }
  for (const ref of Object.values(frame?.contourVectorRefs || {})) {
    if (ref?.key) {
      refs.push(ref);
    }
  }
  for (const ref of Object.values(frame?.weatherVectorRefs || {})) {
    if (ref?.key) {
      refs.push(ref);
    }
  }
  return refs;
}

function applyRenderedFrameToManifestFrame(frame, rendered) {
  frame.synopticCenters = rendered.synopticCenters || { highs: [], lows: [] };
  frame.pressureUploadMeta = rendered.pressureUploadMeta || {
    source: "none",
    inputRows: null,
    inputCols: null,
    hoverRows: frame.rows,
    hoverCols: frame.cols,
    fullResolutionInput: false,
  };
  if (rendered.hoverGrid) {
    frame.hoverGridSchemaVersion = Number(rendered.hoverGridSchemaVersion) || HOVER_GRID_SCHEMA_VERSION;
    frame.hoverGridBytes = Number(rendered.hoverGrid?.bytes) || Number(rendered.hoverGrid?.body?.length) || 0;
  }
  if (rendered.hoverGridSupplemental && typeof rendered.hoverGridSupplemental === "object") {
    frame.hoverGridSupplemental = mergeHoverGridSupplementalRefs(
      rendered.hoverGridSupplemental,
      frame.hoverGridSupplemental,
    );
  }
  frame.synopticVectorBytes = {
    simple: Number(rendered.synopticVectorBytes?.simple) || byteLengthJson(rendered.synopticVectors?.simple),
    detailed: Number(rendered.synopticVectorBytes?.detailed) || byteLengthJson(rendered.synopticVectors?.detailed),
  };
  for (const [layerKey, ref] of Object.entries(frame.contourVectorRefs || {})) {
    const payload = rendered.contourVectors?.[layerKey];
    if (!payload) {
      continue;
    }
    ref.bytes = byteLengthJson(payload);
  }
  for (const [layerKey, ref] of Object.entries(frame.weatherVectorRefs || {})) {
    const payload = rendered.weatherVectors?.[layerKey];
    if (!payload) {
      continue;
    }
    ref.bytes = byteLengthJson(payload);
  }
  for (const [layerKey, ref] of Object.entries(frame.layers || {})) {
    const artifact = rendered.layers[layerKey];
    if (!artifact) {
      continue;
    }
    ref.bytes = Number(artifact.bytes) || artifact.body.length;
  }
  for (const [variantKey, ref] of Object.entries(frame.reflectivityVariants || {})) {
    const artifact = rendered.reflectivityVariants[variantKey];
    if (!artifact) {
      continue;
    }
    ref.bytes = Number(artifact.bytes) || artifact.body.length;
  }
  for (const [layerKey, variants] of Object.entries(frame.reflectivityVariantsByLayer || {})) {
    const renderedVariants = rendered.reflectivityVariantsByLayer?.[layerKey] || {};
    for (const [variantKey, ref] of Object.entries(variants || {})) {
      const artifact = renderedVariants[variantKey];
      if (!artifact) {
        continue;
      }
      ref.bytes = Number(artifact.bytes) || artifact.body.length;
    }
  }
}

function byteLengthJson(payload) {
  if (!payload || typeof payload !== "object") {
    return 0;
  }
  return Buffer.byteLength(JSON.stringify(payload));
}

function normalizeRenderedFrameArtifacts(rendered, frame, reflectivityGates) {
  const width = Number(frame.cols);
  const height = Number(frame.rows);
  const transparentPng = createTransparentPng(width, height);
  const emptyHoverGrid = buildEmptyHoverGridArtifact(width, height, inferHoverGridFormatFromKey(frame?.hoverGridKey));
  const emptyVector = buildEmptySynopticVectorPayload();
  const rawLayers = rendered?.layers || {};
  const rawVariants = rendered?.reflectivityVariants || {};
  const rawVariantsByLayer = rendered?.reflectivityVariantsByLayer || {};
  const layers = {};
  const expectedLayerKeys = Object.keys(frame?.layers || {});
  if (expectedLayerKeys.length === 0) {
    expectedLayerKeys.push("temperature", "wind", "precip", "synoptic", "reflectivity");
  }
  for (const layerKey of expectedLayerKeys) {
    if (isReflectivityLayerKey(layerKey)) {
      continue;
    }
    layers[layerKey] = normalizePngArtifact(rawLayers[layerKey], transparentPng);
  }
  const expectedReflectivityLayerKeys = collectExpectedReflectivityLayerKeys(frame);
  const reflectivityVariantsByLayer = {};
  for (const layerKey of expectedReflectivityLayerKeys) {
    const sourceVariants =
      rawVariantsByLayer[layerKey] ||
      (layerKey === "reflectivityComposite" ? rawVariants : null) ||
      (layerKey === "reflectivity" ? rawVariants : null) ||
      {};
    const variants = normalizeReflectivityVariantGroup(sourceVariants, reflectivityGates, transparentPng);
    reflectivityVariantsByLayer[layerKey] = variants;
    layers[layerKey] =
      normalizeOptionalPngArtifact(rawLayers[layerKey]) ||
      pickDefaultReflectivityArtifact(variants) ||
      normalizePngArtifact(null, transparentPng);
  }
  const reflectivityVariants =
    reflectivityVariantsByLayer.reflectivityComposite ||
    reflectivityVariantsByLayer.reflectivity ||
    normalizeReflectivityVariantGroup(rawVariants, reflectivityGates, transparentPng);
  layers.reflectivity =
    normalizeOptionalPngArtifact(rawLayers.reflectivity) ||
    pickDefaultReflectivityArtifact(reflectivityVariants) ||
    normalizePngArtifact(null, transparentPng);
  return {
    hour: Number(rendered?.hour) || Number(frame.hour),
    validHourKey: String(rendered?.validHourKey || frame.validHourKey),
    synopticCenters: rendered?.synopticCenters || { highs: [], lows: [] },
    synopticVectors: {
      simple: normalizeSynopticVectorPayload(
        rendered?.synopticVectors?.simple || rendered?.synopticVector || null,
        emptyVector,
      ),
      detailed: normalizeSynopticVectorPayload(
        rendered?.synopticVectors?.detailed || rendered?.synopticVector || null,
        emptyVector,
      ),
    },
    contourVectors: normalizeContourVectorPayloads(rendered?.contourVectors, frame?.contourVectorRefs),
    weatherVectors: normalizeWeatherVectorPayloads(rendered?.weatherVectors, frame?.weatherVectorRefs),
    pressureUploadMeta: rendered?.pressureUploadMeta || {
      source: "none",
      inputRows: null,
      inputCols: null,
      hoverRows: height,
      hoverCols: width,
      fullResolutionInput: false,
    },
    hoverGrid: normalizeHoverGridArtifact(rendered?.hoverGrid, emptyHoverGrid),
    hoverGridSchemaVersion: Number(rendered?.hoverGridSchemaVersion) || HOVER_GRID_SCHEMA_VERSION,
    renderProfile: rendered?.renderProfile || null,
    reflectivityVariants,
    reflectivityVariantsByLayer,
    layers,
  };
}

function mergeLayerRefGroups(existingGroups, templateGroups) {
  const out = {};
  for (const [key, value] of Object.entries(templateGroups || {})) {
    out[key] = mergeLayerRefs(existingGroups?.[key], value);
  }
  return out;
}

function mergeHoverGridSupplementalRefs(existingRefs, templateRefs) {
  const out = {};
  for (const [key, value] of Object.entries(templateRefs || {})) {
    if (value?.key) {
      out[key] = {
        key: value.key,
        bytes: Number(value.bytes) || 0,
        schemaVersion: Number(value.schemaVersion) || HOVER_GRID_SCHEMA_VERSION,
      };
    }
  }
  for (const [key, value] of Object.entries(existingRefs || {})) {
    if (value?.key) {
      out[key] = {
        key: value.key,
        bytes: Number(value.bytes) || 0,
        schemaVersion: Number(value.schemaVersion) || HOVER_GRID_SCHEMA_VERSION,
      };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function collectExpectedReflectivityLayerKeys(frame) {
  const keys = new Set();
  for (const key of Object.keys(frame?.reflectivityVariantsByLayer || {})) {
    if (isReflectivityLayerKey(key)) {
      keys.add(key);
    }
  }
  for (const key of Object.keys(frame?.layers || {})) {
    if (isReflectivityLayerKey(key)) {
      keys.add(key);
    }
  }
  if (frame?.reflectivityVariants && Object.keys(frame.reflectivityVariants).length > 0) {
    keys.add(LEGACY_REFLECTIVITY_LAYER_KEY);
  }
  if (keys.size === 0) {
    keys.add(LEGACY_REFLECTIVITY_LAYER_KEY);
  }
  return Array.from(keys);
}

function normalizeReflectivityVariantGroup(rawVariants, reflectivityGates, transparentPng) {
  const variants = {};
  for (const gate of reflectivityGates) {
    const variantKey = `dbz${Math.round(Number(gate))}`;
    variants[variantKey] = normalizePngArtifact(rawVariants?.[variantKey], transparentPng);
  }
  return variants;
}

function pickDefaultReflectivityArtifact(variants) {
  return variants?.dbz15 || variants?.dbz20 || variants?.dbz10 || null;
}

function isReflectivityLayerKey(layerKey) {
  return layerKey === LEGACY_REFLECTIVITY_LAYER_KEY || REFLECTIVITY_LAYER_KEYS.includes(layerKey);
}

function normalizePngArtifact(artifact, fallbackBody) {
  if (artifact?.body) {
    const body = Buffer.isBuffer(artifact.body) ? artifact.body : Buffer.from(artifact.body);
    return {
      body,
      bytes: Number(artifact.bytes) || body.length,
      contentType: artifact.contentType || "image/png",
    };
  }
  return {
    body: fallbackBody,
    bytes: fallbackBody.length,
    contentType: "image/png",
  };
}

function normalizeOptionalPngArtifact(artifact) {
  if (!artifact?.body) {
    return null;
  }
  const body = Buffer.isBuffer(artifact.body) ? artifact.body : Buffer.from(artifact.body);
  return {
    body,
    bytes: Number(artifact.bytes) || body.length,
    contentType: artifact.contentType || "image/png",
  };
}

function normalizeSynopticVectorPayload(payload, fallback) {
  if (payload && typeof payload === "object") {
    return payload;
  }
  return fallback;
}

function normalizeContourVectorPayloads(payloads, refs) {
  const out = {};
  for (const layerKey of Object.keys(refs || {})) {
    const payload = payloads?.[layerKey];
    out[layerKey] =
      payload && typeof payload === "object"
        ? payload
        : {
            styleVersion: SYNOPTIC_STYLE_VERSION,
            layerType: "height-contour",
            lines: [],
            labels: [],
          };
  }
  return out;
}

function normalizeWeatherVectorPayloads(payloads, refs) {
  const out = {};
  for (const layerKey of Object.keys(refs || {})) {
    const payload = payloads?.[layerKey];
    out[layerKey] =
      payload && typeof payload === "object"
        ? payload
        : {
            schemaVersion: 1,
            layerType: layerKey,
            unit: "kt",
            vectors: [],
          };
  }
  return out;
}

function normalizeHoverGridArtifact(artifact, fallbackArtifact) {
  if (artifact?.body) {
    const body = Buffer.isBuffer(artifact.body) ? artifact.body : Buffer.from(artifact.body);
    return {
      body,
      bytes: Number(artifact.bytes) || body.length,
      contentType: artifact.contentType || "application/json",
      contentEncoding: artifact.contentEncoding || "gzip",
      schemaVersion: Number(artifact.schemaVersion) || HOVER_GRID_SCHEMA_VERSION,
    };
  }
  return fallbackArtifact;
}

function buildEmptySynopticVectorPayload() {
  return {
    styleVersion: SYNOPTIC_STYLE_VERSION,
    isobars: { lines: [], labels: [] },
    thickness: { lines: [], labels: [] },
    centers: { highs: [], lows: [] },
  };
}

function createTransparentPng(width, height) {
  const key = `${Number(width)}x${Number(height)}`;
  const cached = EMPTY_PNG_CACHE.get(key);
  if (cached) {
    return cached;
  }
  const png = new PNG({ width, height });
  png.data = Buffer.alloc(Math.max(0, width * height * 4));
  const body = PNG.sync.write(png, {
    colorType: 6,
    inputHasAlpha: true,
    compressionLevel: 1,
    filterType: 0,
  });
  EMPTY_PNG_CACHE.set(key, body);
  return body;
}

function buildEmptyHoverGridArtifact(width, height, format = "json") {
  const cacheKey = `${Number(width)}x${Number(height)}:${format}`;
  const cached = EMPTY_HOVER_GRID_CACHE.get(cacheKey);
  if (cached) {
    return { ...cached };
  }
  const cellCount = Math.max(0, Number(width) * Number(height));
  const missing = new Int16Array(cellCount).fill(HOVER_GRID_MISSING_VALUE);
  const variable = {
    scale: 1,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: missing,
  };
  const variables = {
    temperatureF: variable,
    windKt: variable,
    precipMm: variable,
    reflectivityCompositeDbz: variable,
    reflectivity1kmDbz: variable,
    capeJkg: variable,
    pressureHpa: variable,
  };
  if (format === "binary") {
    const body = encodeHoverGridBinaryPayload({
      schemaVersion: HOVER_GRID_SCHEMA_VERSION,
      rows: Number(height),
      cols: Number(width),
      variables,
    });
    const artifact = {
      body,
      bytes: body.length,
      contentType: "application/octet-stream",
      contentEncoding: "gzip",
      schemaVersion: HOVER_GRID_SCHEMA_VERSION,
    };
    EMPTY_HOVER_GRID_CACHE.set(cacheKey, artifact);
    return { ...artifact };
  }
  const payload = {
    schemaVersion: HOVER_GRID_SCHEMA_VERSION,
    rows: Number(height),
    cols: Number(width),
    variables: {
      temperatureF: hoverGridVariableToJson(variable),
      windKt: hoverGridVariableToJson(variable),
      precipMm: hoverGridVariableToJson(variable),
      capeJkg: hoverGridVariableToJson(variable),
      pressureHpa: hoverGridVariableToJson(variable),
    },
  };
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  const artifact = {
    body,
    bytes: body.length,
    contentType: "application/json",
    contentEncoding: "gzip",
    schemaVersion: HOVER_GRID_SCHEMA_VERSION,
  };
  EMPTY_HOVER_GRID_CACHE.set(cacheKey, artifact);
  return { ...artifact };
}

function hoverGridVariableToJson(variable) {
  const values = variable?.values instanceof Int16Array ? variable.values : new Int16Array(0);
  return {
    scale: Number.isFinite(Number(variable?.scale)) ? Number(variable.scale) : 1,
    offset: Number.isFinite(Number(variable?.offset)) ? Number(variable.offset) : 0,
    missing: Number.isFinite(Number(variable?.missing)) ? Number(variable.missing) : HOVER_GRID_MISSING_VALUE,
    data: Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64"),
  };
}

module.exports = {
  applyRenderedFrameToManifestFrame,
  buildEmptyHoverGridArtifact,
  buildEmptySynopticVectorPayload,
  collectFrameArtifactKeys,
  collectFrameByteRefs,
  createTransparentPng,
  mergeManifestWithTemplate,
  normalizeHourStatus,
  normalizeRenderedFrameArtifacts,
};
