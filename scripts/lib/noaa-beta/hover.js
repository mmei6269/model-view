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
const { buildHoverGridBinaryRaw, encodeHoverGridBinaryPayload } = require("../hover-grid-binary");
const { HOVER_GRID_SCHEMA_VERSION } = require("../modelview-runtime");
const { getParcelKernel } = require("./parcel-kernel");

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
  modelKey = null,
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
  const hasExplicitAvailableParameters = Array.isArray(selection?.availableParameters);
  const isAvailable = (entry) => !hasExplicitAvailableParameters || availableParameters.has(entry.key);
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
    const source = resolveCatalogSourceGrid(entry, decoded, width, height, modelKey);
    if (!source) {
      continue;
    }
    addVariable(entry.key, source, entry.unit, resolveHoverTransformValue(entry));
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

function buildHoverGridArtifact({ width, height, variables = {}, format = "json", compress = null }) {
  const normalizedVariables = {};
  for (const [key, variable] of Object.entries(variables || {})) {
    if (key && variable?.values instanceof Int16Array) {
      normalizedVariables[key] = variable;
    }
  }
  const diagnostics = summarizeHoverQuantization(normalizedVariables);
  if (String(format || "").toLowerCase() === "binary") {
    const artifact = {
      body: null,
      bytes: 0,
      contentType: "application/octet-stream",
      contentEncoding: "gzip",
      schemaVersion: HOVER_GRID_SCHEMA_VERSION,
      diagnostics,
    };
    if (compress) {
      // Pool path: pack + delta stay on this thread (they own the wasm
      // kernel), only the final gzip runs on the compression helper. Bytes
      // identical to the sync path (same raw region, same codec, same
      // level); the caller awaits `pending` before consuming `body`.
      const raw = buildHoverGridBinaryRaw({
        schemaVersion: HOVER_GRID_SCHEMA_VERSION,
        rows: height,
        cols: width,
        variables: normalizedVariables,
      });
      artifact.pending = compress("gzip", raw, HOVER_GRID_GZIP_LEVEL).then((body) => {
        artifact.body = body;
        artifact.bytes = body.length;
        delete artifact.pending;
      });
      return artifact;
    }
    const body = encodeHoverGridBinaryPayload({
      schemaVersion: HOVER_GRID_SCHEMA_VERSION,
      rows: height,
      cols: width,
      variables: normalizedVariables,
      gzipLevel: HOVER_GRID_GZIP_LEVEL,
    });
    artifact.body = body;
    artifact.bytes = body.length;
    return artifact;
  }
  const payload = {
    schemaVersion: HOVER_GRID_SCHEMA_VERSION,
    diagnostics,
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
    diagnostics,
  };
}

function hoverGridVariableToJson(variable) {
  const values = variable?.values instanceof Int16Array ? variable.values : new Int16Array(0);
  return {
    scale: Number.isFinite(Number(variable?.scale)) ? Number(variable.scale) : 1,
    offset: Number.isFinite(Number(variable?.offset)) ? Number(variable.offset) : 0,
    missing: Number.isFinite(Number(variable?.missing)) ? Number(variable.missing) : HOVER_GRID_MISSING_VALUE,
    clampCount: Math.max(0, Number(variable?.clampCount) || 0),
    nonFiniteCount: Math.max(0, Number(variable?.nonFiniteCount) || 0),
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
  const quantizationStats = { clampCount: 0, nonFiniteCount: Math.max(0, total - sourceLength) };
  // The wasm quantizer is an EXACT f64 port of the raw/affine loops below
  // (same widened-f32 reads, multiply/round/clamp order, and stats); the
  // function-transform path and non-Float32Array sources keep the JS loops.
  const quantizeKernel = !transform && values instanceof Float32Array ? getParcelKernel()?.quantize : null;
  const validCount = quantizeKernel
    ? quantizeHoverValuesKernel(
        quantizeKernel,
        encoded,
        values,
        sourceLength,
        quantizeMultiplier,
        affineTransform,
        quantizationStats,
      )
    : transform
      ? quantizeHoverFunctionValues(encoded, values, sourceLength, quantizeMultiplier, transform, quantizationStats)
      : affineTransform
        ? quantizeHoverAffineValues(
            encoded,
            values,
            sourceLength,
            quantizeMultiplier,
            affineTransform,
            quantizationStats,
          )
        : quantizeHoverRawValues(encoded, values, sourceLength, quantizeMultiplier, quantizationStats);
  if (sourceLength < total) {
    encoded.fill(HOVER_GRID_MISSING_VALUE, sourceLength);
  }
  return {
    scale: resolvedScale,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: encoded,
    validCount,
    ...quantizationStats,
  };
}

// Chunked driver for the kernel's exact raw/affine quantizers: copies the
// Float32Array source through the kernel's input view, runs the wasm loop,
// and copies the Int16 chunk back into `encoded`, accumulating the same
// validCount/clampCount/nonFiniteCount the JS loops produce.
function quantizeHoverValuesKernel(
  quantizeKernel,
  encoded,
  values,
  sourceLength,
  quantizeMultiplier,
  affineTransform,
  stats,
) {
  const chunk = quantizeKernel.chunk;
  let validCount = 0;
  for (let start = 0; start < sourceLength; start += chunk) {
    const count = Math.min(chunk, sourceLength - start);
    quantizeKernel.inA.set(values.subarray(start, start + count));
    if (affineTransform) {
      quantizeKernel.affine(
        count,
        quantizeMultiplier,
        affineTransform.scale,
        affineTransform.offset,
        affineTransform.hasMin ? 1 : 0,
        affineTransform.hasMin ? affineTransform.min : 0,
      );
    } else {
      quantizeKernel.raw(count, quantizeMultiplier);
    }
    encoded.set(quantizeKernel.out.subarray(0, count), start);
    validCount += quantizeKernel.stats[0];
    if (stats) {
      stats.clampCount += quantizeKernel.stats[1];
      stats.nonFiniteCount += quantizeKernel.stats[2];
    }
  }
  return validCount;
}

// Chunked driver for the kernel's exact wind-speed quantizer (u/v pairs).
function quantizeHoverWindValuesKernel(
  quantizeKernel,
  encoded,
  uValues,
  vValues,
  sourceLength,
  quantizeMultiplier,
  speedMultiplier,
) {
  const chunk = quantizeKernel.chunk;
  let validCount = 0;
  let clampCount = 0;
  let nonFiniteCount = 0;
  for (let start = 0; start < sourceLength; start += chunk) {
    const count = Math.min(chunk, sourceLength - start);
    quantizeKernel.inA.set(uValues.subarray(start, start + count));
    quantizeKernel.inB.set(vValues.subarray(start, start + count));
    quantizeKernel.wind(count, quantizeMultiplier, speedMultiplier);
    encoded.set(quantizeKernel.out.subarray(0, count), start);
    validCount += quantizeKernel.stats[0];
    clampCount += quantizeKernel.stats[1];
    nonFiniteCount += quantizeKernel.stats[2];
  }
  return { validCount, clampCount, nonFiniteCount };
}

function quantizeHoverRawValues(encoded, values, sourceLength, quantizeMultiplier, stats = null) {
  let validCount = 0;
  for (let index = 0; index < sourceLength; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      if (stats) stats.nonFiniteCount += 1;
      continue;
    }
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    if (stats && (quantized < -32767 || quantized > 32767)) stats.clampCount += 1;
    encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
    validCount += 1;
  }
  return validCount;
}

function quantizeHoverAffineValues(encoded, values, sourceLength, quantizeMultiplier, affineTransform, stats = null) {
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
    if (!Number.isFinite(value)) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      if (stats) stats.nonFiniteCount += 1;
      continue;
    }
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    if (stats && (quantized < -32767 || quantized > 32767)) stats.clampCount += 1;
    encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
    validCount += 1;
  }
  return validCount;
}

function quantizeHoverFunctionValues(encoded, values, sourceLength, quantizeMultiplier, transform, stats = null) {
  let validCount = 0;
  for (let index = 0; index < sourceLength; index += 1) {
    const value = transform(values[index]);
    if (!Number.isFinite(value)) {
      encoded[index] = HOVER_GRID_MISSING_VALUE;
      if (stats) stats.nonFiniteCount += 1;
      continue;
    }
    const quantized = Math.floor(value * quantizeMultiplier + 0.5);
    if (stats && (quantized < -32767 || quantized > 32767)) stats.clampCount += 1;
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
  let clampCount = 0;
  let nonFiniteCount = Math.max(0, total - sourceLength);
  const quantizeKernel =
    uValues instanceof Float32Array && vValues instanceof Float32Array ? getParcelKernel()?.quantize : null;
  if (quantizeKernel) {
    const kernelStats = quantizeHoverWindValuesKernel(
      quantizeKernel,
      encoded,
      uValues,
      vValues,
      sourceLength,
      quantizeMultiplier,
      multiplier,
    );
    validCount = kernelStats.validCount;
    clampCount = kernelStats.clampCount;
    nonFiniteCount += kernelStats.nonFiniteCount;
  } else {
    for (let index = 0; index < sourceLength; index += 1) {
      const u = uValues[index];
      const v = vValues[index];
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        encoded[index] = HOVER_GRID_MISSING_VALUE;
        nonFiniteCount += 1;
        continue;
      }
      const value = Math.sqrt(u * u + v * v) * multiplier;
      const quantized = Math.floor(value * quantizeMultiplier + 0.5);
      if (quantized < -32767 || quantized > 32767) clampCount += 1;
      encoded[index] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
      validCount += 1;
    }
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
    clampCount,
    nonFiniteCount,
  };
}

function emptyHoverGridVariable(scale) {
  return {
    scale,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: new Int16Array(0),
    validCount: 0,
    clampCount: 0,
    nonFiniteCount: 0,
  };
}

function summarizeHoverQuantization(variables) {
  const byVariable = {};
  let clampCount = 0;
  let nonFiniteCount = 0;
  for (const [key, variable] of Object.entries(variables || {})) {
    const variableClampCount = Math.max(0, Number(variable?.clampCount) || 0);
    const variableNonFiniteCount = Math.max(0, Number(variable?.nonFiniteCount) || 0);
    if (variableClampCount > 0 || variableNonFiniteCount > 0) {
      byVariable[key] = { clampCount: variableClampCount, nonFiniteCount: variableNonFiniteCount };
    }
    clampCount += variableClampCount;
    nonFiniteCount += variableNonFiniteCount;
  }
  return { clampCount, nonFiniteCount, byVariable };
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
  summarizeHoverQuantization,
};
