"use strict";

const path = require("path");

const SHARED_CONFIG = require("../../shared/modelview-config.json");
const SYNOPTIC_STYLE = require("../../shared/synoptic-style-v1.json");

const DEFAULT_CACHE_ROOT = path.resolve(__dirname, "../../output/noaa-beta-cache");
const DEFAULT_ARTIFACT_PREFIX = process.env.MODELVIEW_ARTIFACT_PREFIX || "tiles";
const DEFAULT_VIEW_KEY = "conus";
const DEFAULT_REFLECTIVITY_GATES = [10, 15, 20];
const LOCAL_SOURCE_NAME = "noaa-grib2-beta";
const MANIFEST_SCHEMA_VERSION = Number(SHARED_CONFIG.manifestSchemaVersion) || 4;
const SYNOPTIC_STYLE_VERSION = String(SYNOPTIC_STYLE.styleVersion || "v1-operational-contrast");
const HOVER_GRID_SCHEMA_VERSION = 1;
const LAYER_CONTENT_TYPE = "image/png";
const JSON_CONTENT_TYPE = "application/json";
const DEFAULT_REFLECTIVITY_LAYER_KEY = "reflectivity";
const REFLECTIVITY_LAYER_KEYS = Object.freeze(["reflectivityComposite", "reflectivity1km"]);

const MODEL_CONFIG = Object.freeze({
  gfs: Object.freeze({
    label: "GFS",
    openDataModel: "noaa-gfs-pgrb2-0p25",
    maxHour: 384,
    frameStepHours: 3,
  }),
  nam: Object.freeze({
    label: "NAM",
    openDataModel: "noaa-nam-awphys",
    maxHour: 84,
  }),
  nam3km: Object.freeze({
    label: "NAM 3km",
    openDataModel: "noaa-nam-conusnest",
    maxHour: 60,
  }),
  hrrr: Object.freeze({
    label: "HRRR",
    openDataModel: "noaa-hrrr-wrfprs",
    maxHour: 48,
  }),
});

const VIEW_CONFIG = Object.freeze({
  conus: Object.freeze({
    label: "CONUS",
    bounds: Object.freeze({ north: 53, south: 21, west: -129, east: -63 }),
    width: 1600,
    height: 980,
  }),
  na: Object.freeze({
    label: "NA",
    bounds: Object.freeze({ north: 74, south: 7, west: -170, east: -45 }),
    width: 1600,
    height: 960,
  }),
});

const LAYER_ORDER = Array.isArray(SHARED_CONFIG.layerOrder)
  ? SHARED_CONFIG.layerOrder
  : ["temperature", "wind", "precip", "reflectivity", "synoptic"];

function buildManifestTemplate({
  modelKey,
  viewKey = DEFAULT_VIEW_KEY,
  runId,
  referenceTime,
  validTimes,
  artifactPrefix = DEFAULT_ARTIFACT_PREFIX,
  renderWidth,
  renderHeight,
  reflectivityGates = DEFAULT_REFLECTIVITY_GATES,
  parameterKeys = null,
  parameters = null,
  parameterOrder = null,
  hoverGridFormat = null,
}) {
  const model = MODEL_CONFIG[modelKey];
  const view = VIEW_CONFIG[viewKey];
  if (!model) {
    throw new Error(`Unsupported model '${modelKey}'. Supported: ${Object.keys(MODEL_CONFIG).join(", ")}`);
  }
  if (!view) {
    throw new Error(`Unsupported view '${viewKey}'. Supported: ${Object.keys(VIEW_CONFIG).join(", ")}`);
  }
  const width = Number.isFinite(renderWidth) ? Number(renderWidth) : view.width;
  const height = Number.isFinite(renderHeight) ? Number(renderHeight) : view.height;
  const frames = buildFramePlan({
    validTimes,
    referenceTime,
    maxHour: model.maxHour,
    hourStep: model.frameStepHours || 1,
  });
  const manifestFrames = frames.map((framePlan) =>
    buildManifestFrame({
      modelKey,
      runId,
      viewKey,
      framePlan,
      referenceTime,
      artifactPrefix,
      width,
      height,
      reflectivityGates,
      parameterKeys,
      hoverGridFormat,
    }),
  );
  const hourStatus = {};
  for (const frame of manifestFrames) {
    hourStatus[String(frame.hour)] = "pending";
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    model: modelKey,
    run: runId,
    view: viewKey,
    generatedAt: new Date().toISOString(),
    source: LOCAL_SOURCE_NAME,
    referenceTime,
    openDataModel: model.openDataModel,
    parameters: normalizeParameterMetadata(parameters),
    parameterOrder: normalizeParameterOrder(parameterOrder, parameterKeys),
    hourStatus,
    frames: manifestFrames,
  };
}

function buildManifestFrame({
  modelKey,
  runId,
  viewKey,
  framePlan,
  referenceTime,
  artifactPrefix,
  width,
  height,
  reflectivityGates = DEFAULT_REFLECTIVITY_GATES,
  parameterKeys = null,
  hoverGridFormat = null,
}) {
  const view = VIEW_CONFIG[viewKey];
  const assetKeys = buildFrameAssetKeySet({
    artifactPrefix,
    modelKey,
    runId,
    viewKey,
    hour: framePlan.hour,
    reflectivityGates,
    parameterKeys,
    hoverGridFormat,
  });
  return {
    hour: framePlan.hour,
    validHourKey: framePlan.validTime,
    bounds: view.bounds,
    cols: width,
    rows: height,
    modelToken: MODEL_CONFIG[modelKey].openDataModel,
    referenceTime,
    synopticCenters: { highs: [], lows: [] },
    synopticVectorKey: assetKeys.synopticVectorKeys.simple,
    synopticVectorKeys: assetKeys.synopticVectorKeys,
    synopticVectorBytes: {
      simple: 0,
      detailed: 0,
    },
    contourVectorRefs: assetKeys.contourVectorRefs,
    synopticStyleVersion: SYNOPTIC_STYLE_VERSION,
    synopticStyleVersions: {
      simple: SYNOPTIC_STYLE_VERSION,
      detailed: SYNOPTIC_STYLE_VERSION,
    },
    weatherVectorRefs: assetKeys.weatherVectorRefs,
    pressureUploadMeta: {
      source: "none",
      inputRows: null,
      inputCols: null,
      hoverRows: height,
      hoverCols: width,
      fullResolutionInput: false,
    },
    hoverGridKey: assetKeys.hoverGridKey,
    hoverGridBytes: 0,
    hoverGridSchemaVersion: HOVER_GRID_SCHEMA_VERSION,
    reflectivityVariants: assetKeys.reflectivityVariants,
    reflectivityVariantsByLayer: assetKeys.reflectivityVariantsByLayer,
    layers: assetKeys.layers,
  };
}

function buildFrameAssetKeySet({
  artifactPrefix = DEFAULT_ARTIFACT_PREFIX,
  modelKey,
  runId,
  viewKey,
  hour,
  reflectivityGates = DEFAULT_REFLECTIVITY_GATES,
  parameterKeys = null,
  hoverGridFormat = null,
}) {
  const hourKey = padHour(hour);
  const frameBase = `${artifactPrefix}/${modelKey}/${runId}/${viewKey}/${hourKey}`;
  const layers = {};
  const reflectivityLayerKeys = [];
  const contourVectorRefs = {};
  const weatherVectorRefs = {};
  for (const layerKey of normalizeFrameLayerKeys(parameterKeys)) {
    if (isWeatherVectorLayerKey(layerKey)) {
      weatherVectorRefs[layerKey] = createFrameLayerRef(`${frameBase}/${layerKey}-vectors.json`, 0, JSON_CONTENT_TYPE);
      continue;
    }
    if (isReflectivityLayerKey(layerKey)) {
      if (layerKey === DEFAULT_REFLECTIVITY_LAYER_KEY && reflectivityLayerKeys.includes("reflectivityComposite")) {
        continue;
      }
      if (!reflectivityLayerKeys.includes(layerKey)) {
        reflectivityLayerKeys.push(layerKey);
      }
      continue;
    }
    if (isHeightContourLayerKey(layerKey)) {
      contourVectorRefs[layerKey] = createFrameLayerRef(`${frameBase}/${layerKey}-contours.json`, 0, JSON_CONTENT_TYPE);
    }
    layers[layerKey] = createFrameLayerRef(`${frameBase}/${layerKey}.png`);
  }
  layers.synoptic = layers.synoptic || createFrameLayerRef(`${frameBase}/synoptic.png`);
  if (reflectivityLayerKeys.length === 0) {
    reflectivityLayerKeys.push(DEFAULT_REFLECTIVITY_LAYER_KEY);
  }
  const reflectivityVariantsByLayer = {};
  for (const layerKey of reflectivityLayerKeys) {
    const variants = {};
    const fileStem = reflectivityFileStem(layerKey);
    for (const gate of reflectivityGates) {
      const gateValue = Number(gate);
      if (!Number.isFinite(gateValue)) {
        continue;
      }
      variants[`dbz${Math.round(gateValue)}`] = createFrameLayerRef(
        `${frameBase}/${fileStem}-g${Math.round(gateValue)}.png`,
      );
    }
    reflectivityVariantsByLayer[layerKey] = variants;
    layers[layerKey] = pickDefaultReflectivityRef(variants) || createFrameLayerRef(`${frameBase}/${fileStem}-g15.png`);
  }
  const reflectivityVariants =
    reflectivityVariantsByLayer.reflectivityComposite ||
    reflectivityVariantsByLayer.reflectivity ||
    reflectivityVariantsByLayer[reflectivityLayerKeys[0]] ||
    {};
  layers.reflectivity =
    pickDefaultReflectivityRef(reflectivityVariants) || createFrameLayerRef(`${frameBase}/reflectivity-g15.png`);
  const hoverGridExtension = normalizeHoverGridFormat(hoverGridFormat) === "binary" ? "bin" : "json";
  return {
    frameBase,
    layers,
    reflectivityVariants,
    reflectivityVariantsByLayer,
    synopticVectorKeys: {
      simple: `${frameBase}/synoptic-vector-simple.json`,
      detailed: `${frameBase}/synoptic-vector-detailed.json`,
    },
    contourVectorRefs,
    weatherVectorRefs,
    hoverGridKey: `${frameBase}/hover-grid.${hoverGridExtension}.gz`,
  };
}

function buildFramePlan({ validTimes, referenceTime, maxHour, hourStep = 1, maxHoursPerModel }) {
  const baseMs = Date.parse(referenceTime);
  const out = [];
  const step = Math.max(1, Math.min(24, Math.round(Number(hourStep) || 1)));
  for (const validTime of Array.isArray(validTimes) ? validTimes : []) {
    const validMs = Date.parse(validTime);
    if (!Number.isFinite(baseMs) || !Number.isFinite(validMs)) {
      continue;
    }
    const hour = Math.round((validMs - baseMs) / (60 * 60 * 1000));
    if (hour < 0 || hour > maxHour) {
      continue;
    }
    if (hour % step !== 0) {
      continue;
    }
    out.push({ hour, validTime });
  }
  out.sort((a, b) => a.hour - b.hour);
  if (Number.isFinite(maxHoursPerModel)) {
    return out.filter((frame) => frame.hour <= maxHoursPerModel);
  }
  return out;
}

function normalizeHoverGridFormat(format) {
  return String(format || "")
    .trim()
    .toLowerCase() === "binary"
    ? "binary"
    : "json";
}

function normalizeFrameLayerKeys(parameterKeys) {
  const fallback = ["temperature", "wind", "precip", "synoptic", "reflectivity"];
  const out = [];
  const push = (value) => {
    const key = String(value || "").trim();
    if (!key || out.includes(key)) {
      return;
    }
    out.push(key);
  };
  const source = Array.isArray(parameterKeys) && parameterKeys.length > 0 ? parameterKeys : fallback;
  source.forEach(push);
  fallback.forEach(push);
  return out;
}

function normalizeParameterMetadata(parameters) {
  if (!parameters || typeof parameters !== "object") {
    return undefined;
  }
  const out = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    out[key] = { ...value, key: String(value.key || key) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeParameterOrder(parameterOrder, parameterKeys) {
  const source =
    Array.isArray(parameterOrder) && parameterOrder.length > 0
      ? parameterOrder
      : Array.isArray(parameterKeys)
        ? parameterKeys
        : [];
  const out = [];
  for (const key of source) {
    const value = String(key || "").trim();
    if (value && value !== "synoptic" && !out.includes(value)) {
      out.push(value);
    }
  }
  return out.length > 0 ? out : undefined;
}

function createFrameLayerRef(key, bytes = 0, contentType = LAYER_CONTENT_TYPE) {
  return {
    key,
    bytes: Number.isFinite(bytes) ? Number(bytes) : 0,
    contentType,
    url: null,
  };
}

function isReflectivityLayerKey(layerKey) {
  return layerKey === DEFAULT_REFLECTIVITY_LAYER_KEY || REFLECTIVITY_LAYER_KEYS.includes(layerKey);
}

function isHeightContourLayerKey(layerKey) {
  return /^height(?:850|700|500|300|250)$/.test(String(layerKey || ""));
}

function isWeatherVectorLayerKey(layerKey) {
  void layerKey;
  return false;
}

function reflectivityFileStem(layerKey) {
  if (layerKey === "reflectivityComposite") {
    return "reflectivity-composite";
  }
  if (layerKey === "reflectivity1km") {
    return "reflectivity-1km";
  }
  return "reflectivity";
}

function pickDefaultReflectivityRef(variants) {
  return variants?.dbz15 || variants?.dbz20 || variants?.dbz10 || null;
}

function buildLatestPointer({ modelKey, runId, viewKey = DEFAULT_VIEW_KEY, frameCount = 0 }) {
  return {
    model: modelKey,
    run: runId,
    view: viewKey,
    generatedAt: new Date().toISOString(),
    manifestKey: buildManifestRequestKey(modelKey, runId, viewKey),
    frameCount: Number.isFinite(frameCount) ? Number(frameCount) : 0,
  };
}

function buildManifestRequestKey(modelKey, runId, viewKey = DEFAULT_VIEW_KEY) {
  return `manifests/${modelKey}/${runId}.json?view=${encodeURIComponent(viewKey)}`;
}

function formatRunIdFromReference(referenceTime) {
  const date = new Date(referenceTime);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  return `${year}${month}${day}-${hour}00Z`;
}

function resolveCacheRoot(cacheRoot) {
  return path.resolve(cacheRoot || DEFAULT_CACHE_ROOT);
}

function padHour(hour) {
  return String(Math.max(0, Math.round(Number(hour) || 0))).padStart(3, "0");
}

module.exports = {
  DEFAULT_ARTIFACT_PREFIX,
  DEFAULT_CACHE_ROOT,
  DEFAULT_REFLECTIVITY_GATES,
  DEFAULT_VIEW_KEY,
  HOVER_GRID_SCHEMA_VERSION,
  LAYER_ORDER,
  LOCAL_SOURCE_NAME,
  MANIFEST_SCHEMA_VERSION,
  MODEL_CONFIG,
  SYNOPTIC_STYLE_VERSION,
  VIEW_CONFIG,
  buildFrameAssetKeySet,
  buildFramePlan,
  buildLatestPointer,
  buildManifestFrame,
  buildManifestRequestKey,
  buildManifestTemplate,
  formatRunIdFromReference,
  resolveCacheRoot,
};
