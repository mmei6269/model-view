"use strict";

const zlib = require("zlib");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { MPS_TO_KT, MPS_TO_MPH } = require("./util");
const {
  PRATE_KG_M2_S_TO_IN_HR,
  buildAffineTransformState,
  resolveCatalogSourceGrid,
  resolveHoverTransformValue,
} = require("./raster");
const { encodeHoverGridBinaryPayload } = require("../hover-grid-binary");
const { HOVER_GRID_SCHEMA_VERSION } = require("../modelview-runtime");

const HOVER_GRID_MISSING_VALUE = -32768;

const HOVER_GRID_GZIP_LEVEL = 1;

function recordHoverValueCount(counts, key, layer) {
  if (!counts || !key || !Number.isFinite(Number(layer?.validCount))) {
    return;
  }
  counts.set(key, Math.max(0, Math.round(Number(layer.validCount))));
}

function hasKnownEmptyHoverValues(counts, key) {
  return counts instanceof Map && counts.get(key) === 0;
}

function buildHoverGridVariables({
  decoded,
  selection,
  temperatureF,
  windMph,
  precipIn,
  precipAccumulationIn,
  snowfallIn,
  reflectivityCompositeDbz,
  reflectivity1kmDbz,
  pressureHpa,
  width,
  height,
  getWindSpeedGrid = null,
  hoverValueCounts = null,
}) {
  const rawCellCount = Number(width) * Number(height);
  const cellCount = Number.isFinite(rawCellCount) && rawCellCount > 0 ? Math.round(rawCellCount) : 0;
  const variables = {};
  const availableParameters = new Set(selection?.availableParameters || []);
  const isAvailable = (entry) => availableParameters.size === 0 || availableParameters.has(entry.key);
  const addVariable = (key, values, unit, transformValue = null) => {
    if (hasKnownEmptyHoverValues(hoverValueCounts, key)) {
      return;
    }
    const variable = quantizeHoverGridVariable(values, resolveHoverQuantizeScale(unit), cellCount, transformValue);
    addHoverGridVariable(variables, key, variable);
  };

  for (const entry of selection?.catalog || NOAA_NAM_PARAMETER_CATALOG) {
    if (!entry || entry.hidden || !isAvailable(entry)) {
      continue;
    }
    if (entry.key === "temperature") {
      addVariable(entry.key, temperatureF, entry.unit);
      continue;
    }
    if (entry.key === "wind") {
      addVariable(entry.key, windMph, entry.unit);
      continue;
    }
    if (entry.key === "precip") {
      addVariable(entry.key, precipIn, entry.unit);
      continue;
    }
    if (entry.key === "reflectivityComposite") {
      addVariable(entry.key, reflectivityCompositeDbz, entry.unit);
      continue;
    }
    if (entry.key === "reflectivity1km") {
      addVariable(entry.key, reflectivity1kmDbz, entry.unit);
      continue;
    }
    if (entry.kind === "precipAccumulation") {
      addVariable(entry.key, precipAccumulationIn?.[entry.key], entry.unit);
      continue;
    }
    if (entry.kind === "snowfallDerived" || entry.kind === "snowfallDirect") {
      addVariable(entry.key, snowfallIn?.[entry.key], entry.unit);
      continue;
    }
    if (entry.kind === "reflectivityPrecipType") {
      // The precip-type layer uses the same reflectivity value as the 1 km AGL reflectivity layer.
      continue;
    }
    if (entry.kind === "precipRateType") {
      addVariable(entry.key, decoded?.[entry.rateKey], entry.unit, {
        transformScale: PRATE_KG_M2_S_TO_IN_HR,
        transformMin: 0,
      });
      continue;
    }
    if (entry.kind === "wind") {
      if (hasKnownEmptyHoverValues(hoverValueCounts, entry.key)) {
        continue;
      }
      const speedGrid = typeof getWindSpeedGrid === "function" ? getWindSpeedGrid(entry) : null;
      if (speedGrid) {
        addVariable(entry.key, speedGrid, entry.unit);
      } else {
        addHoverGridVariable(
          variables,
          entry.key,
          quantizeHoverWindGridVariable({
            uValues: decoded?.[entry.uKey],
            vValues: decoded?.[entry.vKey],
            multiplier: entry.transform === "windKt" ? MPS_TO_KT : MPS_TO_MPH,
            scale: resolveHoverQuantizeScale(entry.unit),
            cellCount,
          }),
        );
      }
      continue;
    }
    const source = resolveCatalogSourceGrid(entry, decoded, width, height);
    if (!source) {
      continue;
    }
    addVariable(entry.key, source, entry.unit, resolveHoverTransformValue(entry, selection));
  }

  addHoverGridVariable(variables, "pressureHpa", quantizeHoverGridVariable(pressureHpa, 0.05, cellCount));
  return variables;
}

function addHoverGridVariable(variables, key, variable) {
  if (!key || !(variable?.values instanceof Int16Array) || Number(variable.validCount) <= 0) {
    return;
  }
  variables[key] = variable;
}

function resolveHoverQuantizeScale(unit) {
  const normalized = String(unit || "").trim();
  if (normalized === "F" || normalized === "C" || normalized === "hPa") {
    return 0.05;
  }
  if (normalized === "in") {
    return 0.01;
  }
  if (normalized === "in/hr") {
    return 0.001;
  }
  if (
    normalized === "%" ||
    normalized === "mph" ||
    normalized === "kt" ||
    normalized === "dBZ" ||
    normalized === "mi" ||
    normalized === "mm"
  ) {
    return 0.1;
  }
  if (normalized === "ft") {
    return 5;
  }
  if (normalized === "m" || normalized === "J/kg" || normalized === "m2/s2") {
    return 1;
  }
  return 0.1;
}

function buildHoverGridArtifact({ width, height, variables = {}, format = "json" }) {
  const normalizedVariables = {};
  for (const [key, variable] of Object.entries(variables || {})) {
    if (key && variable?.values instanceof Int16Array) {
      normalizedVariables[key] = variable;
    }
  }
  if (String(format || "").toLowerCase() === "binary") {
    const body = encodeHoverGridBinaryPayload({
      schemaVersion: HOVER_GRID_SCHEMA_VERSION,
      rows: height,
      cols: width,
      variables: normalizedVariables,
      gzipLevel: HOVER_GRID_GZIP_LEVEL,
    });
    return {
      body,
      bytes: body.length,
      contentType: "application/octet-stream",
      contentEncoding: "gzip",
      schemaVersion: HOVER_GRID_SCHEMA_VERSION,
    };
  }
  const payload = {
    schemaVersion: HOVER_GRID_SCHEMA_VERSION,
    rows: height,
    cols: width,
    variables: Object.fromEntries(
      Object.entries(normalizedVariables).map(([key, variable]) => [key, hoverGridVariableToJson(variable)]),
    ),
  };
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: HOVER_GRID_GZIP_LEVEL });
  return {
    body,
    bytes: body.length,
    contentType: "application/json",
    contentEncoding: "gzip",
    schemaVersion: HOVER_GRID_SCHEMA_VERSION,
  };
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

function quantizeHoverGridVariable(values, scale, cellCount, transformValue = null) {
  const total = Math.max(0, Number(cellCount) || Number(values?.length) || 0);
  const sourceLength = Math.min(total, Number(values?.length) || 0);
  const resolvedScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  if (!values || total <= 0 || sourceLength <= 0) {
    return emptyHoverGridVariable(resolvedScale);
  }
  const encoded = new Int16Array(total);
  const quantizeMultiplier = 1 / resolvedScale;
  const transform = typeof transformValue === "function" ? transformValue : null;
  const affineTransform =
    transformValue && typeof transformValue === "object"
      ? buildAffineTransformState(
          transformValue.transformScale,
          transformValue.transformOffset,
          transformValue.transformMin,
        )
      : null;
  const validCount = transform
    ? quantizeHoverFunctionValues(encoded, values, sourceLength, quantizeMultiplier, transform)
    : affineTransform
      ? quantizeHoverAffineValues(encoded, values, sourceLength, quantizeMultiplier, affineTransform)
      : quantizeHoverRawValues(encoded, values, sourceLength, quantizeMultiplier);
  if (sourceLength < total) {
    encoded.fill(HOVER_GRID_MISSING_VALUE, sourceLength);
  }
  return {
    scale: resolvedScale,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: encoded,
    validCount,
  };
}

function quantizeHoverRawValues(encoded, values, sourceLength, quantizeMultiplier) {
  let validCount = 0;
  for (let index = 0; index < sourceLength; index += 1) {
    const value = values[index];
    if (value !== value) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      continue;
    }
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
    validCount += 1;
  }
  return validCount;
}

function quantizeHoverAffineValues(encoded, values, sourceLength, quantizeMultiplier, affineTransform) {
  const affineScale = affineTransform.scale;
  const affineOffset = affineTransform.offset;
  const affineHasMin = affineTransform.hasMin;
  const affineMin = affineHasMin ? affineTransform.min : 0;
  let validCount = 0;
  for (let index = 0; index < sourceLength; index += 1) {
    let value = values[index] * affineScale + affineOffset;
    if (affineHasMin && value < affineMin) {
      value = affineMin;
    }
    if (value !== value) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      continue;
    }
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
    validCount += 1;
  }
  return validCount;
}

function quantizeHoverFunctionValues(encoded, values, sourceLength, quantizeMultiplier, transform) {
  let validCount = 0;
  for (let index = 0; index < sourceLength; index += 1) {
    const value = transform(values[index]);
    if (value !== value) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      continue;
    }
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
    validCount += 1;
  }
  return validCount;
}

function quantizeHoverWindGridVariable({ uValues, vValues, multiplier = MPS_TO_MPH, scale, cellCount }) {
  const total = Math.max(0, Number(cellCount) || Number(uValues?.length) || Number(vValues?.length) || 0);
  const resolvedScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  if (!uValues || !vValues || uValues.length !== vValues.length) {
    return emptyHoverGridVariable(resolvedScale);
  }
  const sourceLength = Math.min(total, uValues.length, vValues.length);
  if (total <= 0 || sourceLength <= 0) {
    return emptyHoverGridVariable(resolvedScale);
  }
  const encoded = new Int16Array(total);
  const quantizeMultiplier = 1 / resolvedScale;
  let validCount = 0;
  for (let index = 0; index < sourceLength; index += 1) {
    const u = uValues[index];
    const v = vValues[index];
    if (u !== u || v !== v) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      continue;
    }
    const value = Math.sqrt(u * u + v * v) * multiplier;
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
    validCount += 1;
  }
  if (sourceLength < total) {
    encoded.fill(HOVER_GRID_MISSING_VALUE, sourceLength);
  }
  return {
    scale: resolvedScale,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: encoded,
    validCount,
  };
}

function emptyHoverGridVariable(scale) {
  return {
    scale,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: new Int16Array(0),
    validCount: 0,
  };
}

module.exports = {
  HOVER_GRID_GZIP_LEVEL,
  HOVER_GRID_MISSING_VALUE,
  addHoverGridVariable,
  buildHoverGridArtifact,
  buildHoverGridVariables,
  emptyHoverGridVariable,
  hasKnownEmptyHoverValues,
  hoverGridVariableToJson,
  quantizeHoverAffineValues,
  quantizeHoverFunctionValues,
  quantizeHoverGridVariable,
  quantizeHoverRawValues,
  quantizeHoverWindGridVariable,
  recordHoverValueCount,
  resolveHoverQuantizeScale,
};
