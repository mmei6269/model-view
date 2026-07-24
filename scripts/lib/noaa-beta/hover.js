"use strict";

const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { MPS_TO_KT, MPS_TO_MPH } = require("./util");
const {
  PRATE_KG_M2_S_TO_IN_HR,
  buildAffineTransformState,
  resolveCatalogSourceGrid,
  resolveHoverTransformValue,
} = require("./raster");
const {
  _gradientEncodeInt16Region,
  _buildHoverGridBinaryRawShared,
  buildHoverGridBinaryRaw,
  encodeHoverGridBinaryPayload,
} = require("../hover-grid-binary");
const { isSharedInputCompressor } = require("./compress-pool");
const {
  HOVER_ARENA_MODE,
  _preflightHoverGridArena: preflightHoverGridArena,
  createHoverGridArena,
  supportsGrowableSharedArrayBuffer,
} = require("./hover-arena");
const {
  DEFAULT_HOVER_GRID_COMPRESSION,
  DEFAULT_HOVER_GRID_GZIP_LEVEL,
  compressHoverGridSync,
  resolveHoverGridCompressionConfig,
} = require("../hover-grid-compression");
const { HOVER_GRID_ENCODING, HOVER_GRID_SCHEMA_VERSION } = require("../modelview-runtime");
const { getParcelKernel } = require("./parcel-kernel");

const HOVER_GRID_MISSING_VALUE = -32768;
const HOVER_GRID_GZIP_LEVEL = DEFAULT_HOVER_GRID_GZIP_LEVEL;
const HOVER_VARIABLE_PLAN_BRAND = new WeakSet();

function recordHoverValueCount(counts, key, layer) {
  if (!counts || !key || !Number.isFinite(Number(layer?.validCount))) {
    return;
  }
  counts.set(key, Math.max(0, Math.round(Number(layer.validCount))));
}

function hasKnownEmptyHoverValues(counts, key) {
  return counts instanceof Map && counts.get(key) === 0;
}

function buildHoverGridVariables(options) {
  return materializeHoverGridVariablePlan(buildHoverGridVariablePlan(options));
}

function buildHoverGridVariablePlan({
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
  preDeltaEncode = false,
  preGradient = false,
  requireTrackedGridShape = false,
}) {
  const rawCellCount = Number(width) * Number(height);
  const cellCount = Number.isFinite(rawCellCount) && rawCellCount > 0 ? Math.round(rawCellCount) : 0;
  // The pure-JS fallback gets no hot-buffer benefit from per-variable delta
  // passes and is measurably faster retaining the legacy single global pass
  // in buildHoverGridBinaryRaw. Requiring the general exact delta port also
  // guarantees function-transform variables cannot mix modes with fused
  // raw/affine/wind variables when an older kernel binary is loaded.
  const parcelKernel = getParcelKernel();
  const usePreDeltaEncoding = Boolean(preDeltaEncode && parcelKernel?.delta);
  const usePreGradientEncoding = Boolean(preGradient && parcelKernel?.quantize?.gradient);
  if (preDeltaEncode && preGradient) {
    throw new Error("hover variables cannot request both global1d delta and gradient2d predictors");
  }
  const candidates = [];
  const availableParameters = new Set(selection?.availableParameters || []);
  const hasExplicitAvailableParameters = Array.isArray(selection?.availableParameters);
  const isAvailable = (entry) => !hasExplicitAvailableParameters || availableParameters.has(entry.key);
  const addCandidate = (key, values, unit, transformValue = null, trackedByRaster = false) => {
    if (hasKnownEmptyHoverValues(hoverValueCounts, key)) {
      return;
    }
    // buildRenderedArtifacts historically constructed hover after every PNG
    // layer and used the raster validCount as an omission hint. Raster layers
    // reject non-exact dimensions, while the standalone hover quantizer
    // intentionally accepts partial arrays and pads missing cells. The
    // cooperative renderer now constructs hover early, so reproduce that
    // legacy gate only for keys that were covered by encodeTrackedLayer.
    // Untracked reflectivity, pressure, precipitation-rate, and height-contour
    // variables retain their existing partial-input behavior.
    if (requireTrackedGridShape && trackedByRaster && Number(values?.length) !== cellCount) {
      return;
    }
    candidates.push({
      kind: "scalar",
      key,
      values,
      scale: resolveHoverQuantizeScale(unit),
      offset: 0,
      missing: HOVER_GRID_MISSING_VALUE,
      transformValue,
    });
  };

  for (const entry of selection?.catalog || NOAA_NAM_PARAMETER_CATALOG) {
    if (!entry || entry.hidden || !isAvailable(entry)) {
      continue;
    }
    if (entry.key === "temperature") {
      addCandidate(entry.key, temperatureF, entry.unit, null, true);
      continue;
    }
    if (entry.key === "wind") {
      addCandidate(entry.key, windMph, entry.unit, null, true);
      continue;
    }
    if (entry.key === "precip") {
      addCandidate(entry.key, precipIn, entry.unit, null, true);
      continue;
    }
    if (entry.key === "reflectivityComposite") {
      addCandidate(entry.key, reflectivityCompositeDbz, entry.unit);
      continue;
    }
    if (entry.key === "reflectivity1km") {
      addCandidate(entry.key, reflectivity1kmDbz, entry.unit);
      continue;
    }
    if (entry.kind === "precipAccumulation") {
      addCandidate(entry.key, precipAccumulationIn?.[entry.key], entry.unit, null, true);
      continue;
    }
    if (entry.kind === "snowfallDerived" || entry.kind === "snowfallDirect") {
      addCandidate(entry.key, snowfallIn?.[entry.key], entry.unit, null, true);
      continue;
    }
    if (entry.kind === "reflectivityPrecipType") {
      // The precip-type layer uses the same reflectivity value as the 1 km AGL reflectivity layer.
      continue;
    }
    if (entry.kind === "precipRateType") {
      addCandidate(entry.key, decoded?.[entry.rateKey], entry.unit, {
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
        addCandidate(entry.key, speedGrid, entry.unit, null, true);
      } else {
        if (
          requireTrackedGridShape &&
          (Number(decoded?.[entry.uKey]?.length) !== cellCount || Number(decoded?.[entry.vKey]?.length) !== cellCount)
        ) {
          continue;
        }
        candidates.push({
          kind: "wind",
          key: entry.key,
          uValues: decoded?.[entry.uKey],
          vValues: decoded?.[entry.vKey],
          multiplier: entry.transform === "windKt" ? MPS_TO_KT : MPS_TO_MPH,
          scale: resolveHoverQuantizeScale(entry.unit),
          offset: 0,
          missing: HOVER_GRID_MISSING_VALUE,
        });
      }
      continue;
    }
    const source = resolveCatalogSourceGrid(entry, decoded, width, height, modelKey);
    if (!source) {
      continue;
    }
    addCandidate(entry.key, source, entry.unit, resolveHoverTransformValue(entry), entry.kind !== "heightContour");
  }

  candidates.push({
    kind: "scalar",
    key: "pressureHpa",
    values: pressureHpa,
    scale: 0.05,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    transformValue: null,
  });
  const plan = Object.freeze({
    width: Number(width),
    height: Number(height),
    cellCount,
    preDeltaEncode: usePreDeltaEncoding,
    preGradient: usePreGradientEncoding,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
  });
  HOVER_VARIABLE_PLAN_BRAND.add(plan);
  return plan;
}

function materializeHoverGridVariablePlan(plan) {
  if (!HOVER_VARIABLE_PLAN_BRAND.has(plan)) {
    throw new TypeError("hover variables require a trusted variable plan");
  }
  const variables = {};
  for (const candidate of plan.candidates) {
    addHoverGridVariable(variables, candidate.key, materializeHoverGridCandidate(plan, candidate));
  }
  return variables;
}

function materializeHoverGridCandidate(plan, candidate, target = null) {
  if (candidate.kind === "wind") {
    return quantizeHoverWindGridVariable({
      uValues: candidate.uValues,
      vValues: candidate.vValues,
      multiplier: candidate.multiplier,
      scale: candidate.scale,
      cellCount: plan.cellCount,
      deltaEncode: plan.preDeltaEncode,
      gradientEncode: plan.preGradient,
      gradientCols: plan.width,
      target,
    });
  }
  return quantizeHoverGridVariable(candidate.values, candidate.scale, plan.cellCount, candidate.transformValue, {
    deltaEncode: plan.preDeltaEncode,
    gradientEncode: plan.preGradient,
    gradientCols: plan.width,
    target,
  });
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

function buildHoverGridArtifact({
  width,
  height,
  variables = {},
  variablePlan = null,
  format = "json",
  compress = null,
  coordinator = null,
  compression = DEFAULT_HOVER_GRID_COMPRESSION,
  encoding = HOVER_GRID_ENCODING,
}) {
  const compressionConfig = compression
    ? resolveHoverGridCompressionConfig(compression)
    : DEFAULT_HOVER_GRID_COMPRESSION;
  if (variablePlan !== null && !HOVER_VARIABLE_PLAN_BRAND.has(variablePlan)) {
    throw new TypeError("hover artifact variablePlan is not a trusted renderer plan");
  }
  const hasDirectArenaCodecShape = Boolean(
    variablePlan &&
    String(format || "").toLowerCase() === "binary" &&
    isSharedInputCompressor(compress) &&
    encoding?.magic === "MVH4" &&
    encoding?.schemaVersion === 4 &&
    encoding?.predictor === "gradient2d" &&
    encoding?.preDeltaEncode === false &&
    variablePlan.preDeltaEncode === false &&
    variablePlan.candidates.every((candidate) => typeof candidate.transformValue !== "function"),
  );
  const directArenaDimensionsMatch = Boolean(
    variablePlan && Number(width) === variablePlan.width && Number(height) === variablePlan.height,
  );
  const hasDirectArenaCallShape = hasDirectArenaCodecShape && directArenaDimensionsMatch;
  let directArenaPreflightReason =
    hasDirectArenaCodecShape && !directArenaDimensionsMatch ? "plan-dimension-mismatch" : null;
  if (hasDirectArenaCallShape) {
    if (HOVER_ARENA_MODE !== "auto") {
      directArenaPreflightReason = "disabled";
    } else if (!supportsGrowableSharedArrayBuffer()) {
      directArenaPreflightReason = "growable-shared-array-buffer-unavailable";
    } else {
      const preflight = preflightHoverGridArena({
        rows: variablePlan.height,
        cols: variablePlan.width,
        candidates: variablePlan.candidates,
        encoding,
      });
      if (!preflight.ok) {
        directArenaPreflightReason = preflight.reason;
      }
    }
  }
  const shouldAttemptDirectArena = hasDirectArenaCallShape && directArenaPreflightReason === null;
  const arenaFallbackReason =
    variablePlan && !shouldAttemptDirectArena
      ? directArenaPreflightReason ||
        (String(format || "").toLowerCase() !== "binary"
          ? "non-binary-format"
          : !isSharedInputCompressor(compress)
            ? "untrusted-compressor"
            : "noncanonical-plan-or-encoding")
      : null;
  // A queued direct job must retain its source plan until admission, but the
  // codec promise must not retain that source graph after quantization. Keep
  // the sole deferred reference in a mutable closure slot and clear the
  // original parameter binding immediately so the admitted start can sever
  // every long-lived path before it submits compression.
  let pendingDirectVariablePlan = shouldAttemptDirectArena ? variablePlan : null;
  if (shouldAttemptDirectArena) {
    variablePlan = null;
  }
  const resolvedVariables =
    variablePlan && !shouldAttemptDirectArena ? materializeHoverGridVariablePlan(variablePlan) : variables;
  const normalizedVariables = {};
  if (!shouldAttemptDirectArena) {
    for (const [key, variable] of Object.entries(resolvedVariables || {})) {
      if (key && variable?.values instanceof Int16Array) {
        normalizedVariables[key] = variable;
      }
    }
  }
  const diagnostics = shouldAttemptDirectArena ? null : summarizeHoverQuantization(normalizedVariables);
  const hasPreDeltaVariables = Object.values(normalizedVariables).some((variable) => variable.deltaEncoded === true);
  const predictorMarkers = Object.values(normalizedVariables).filter((variable) =>
    Object.prototype.hasOwnProperty.call(variable, "predictorEncoded"),
  );
  const hasGradientVariables = predictorMarkers.some((variable) => variable.predictorEncoded === "gradient2d");
  const unknownPredictor = predictorMarkers.find((variable) => variable.predictorEncoded !== "gradient2d");
  if (unknownPredictor) {
    throw new Error(`unknown pre-encoded hover predictor ${JSON.stringify(unknownPredictor.predictorEncoded)}`);
  }
  if (hasPreDeltaVariables && hasGradientVariables) {
    throw new Error("hover variables cannot mix global1d delta and gradient2d predictor markers");
  }
  if (String(format || "").toLowerCase() === "binary") {
    if (!encoding?.preDeltaEncode && hasPreDeltaVariables) {
      throw new Error(`${encoding?.magic || "MVH4"} requires absolute hover variables`);
    }
    if (encoding?.predictor !== "gradient2d" && hasGradientVariables) {
      throw new Error(`${encoding?.magic || "MVH3"} cannot contain pre-gradient hover variables`);
    }
    const artifact = {
      body: null,
      bytes: 0,
      contentType: "application/octet-stream",
      contentEncoding: compressionConfig.contentEncoding,
      schemaVersion: encoding.schemaVersion,
      diagnostics,
      ...(arenaFallbackReason ? { arenaFallbackReason } : {}),
    };
    if (compress) {
      // Allocate, quantize, pack, and submit only after frame + pool-scoped
      // coordinator admission. A queued direct-arena job therefore retains
      // source grids but no giant speculative owner. Once admitted, the
      // trusted renderer path publishes every byte into one SAB and retains
      // that same immutable owner for bounded worker or inline compression.
      // Production frame workers render one frame at a time, so each isolate
      // reaches at most one arena; a builder can reach at most workerCount
      // arenas across isolates. This pool-scoped admission additionally
      // bounds non-production concurrent direct calls within one isolate, but
      // intentionally is not a cross-worker/process memory gate.
      // Arbitrary callback compressors keep the historical Buffer +
      // structured-clone contract.
      const start = () => {
        const packStartedAt = performance.now();
        let directArena = null;
        let packedVariables = normalizedVariables;
        if (shouldAttemptDirectArena) {
          let admittedVariablePlan = pendingDirectVariablePlan;
          pendingDirectVariablePlan = null;
          if (!admittedVariablePlan) {
            throw new Error("direct hover arena source plan was already consumed");
          }
          try {
            const directArenaAttempt = materializeHoverGridArena(admittedVariablePlan, encoding);
            directArena = directArenaAttempt.result;
            if (directArena) {
              artifact.diagnostics = directArena.diagnostics;
              artifact.arenaTelemetry = directArena.telemetry;
            } else {
              artifact.arenaFallbackReason = directArenaAttempt.reason;
              packedVariables = materializeHoverGridVariablePlan(admittedVariablePlan);
              artifact.diagnostics = summarizeHoverQuantization(packedVariables);
            }
          } finally {
            admittedVariablePlan = null;
          }
        }
        const shared = Boolean(directArena) || isSharedInputCompressor(compress);
        const raw = directArena
          ? directArena.raw
          : shared
            ? _buildHoverGridBinaryRawShared({
                schemaVersion: encoding.schemaVersion,
                encoding,
                rows: height,
                cols: width,
                variables: packedVariables,
              })
            : buildHoverGridBinaryRaw({
                schemaVersion: encoding.schemaVersion,
                encoding,
                rows: height,
                cols: width,
                variables: packedVariables,
              });
        artifact.packDurationMs = performance.now() - packStartedAt;
        const compressRaw = shared ? compress.shared : compress;
        return settleHoverGridCompressionArtifact(
          artifact,
          compressRaw(compressionConfig.backend, raw, compressionConfig.level),
        );
      };
      artifact.pending =
        coordinator && typeof coordinator.schedule === "function"
          ? coordinator.schedule(start, `hover-${compressionConfig.backend}`)
          : start();
      return artifact;
    }
    const body = encodeHoverGridBinaryPayload({
      schemaVersion: encoding.schemaVersion,
      encoding,
      rows: height,
      cols: width,
      variables: normalizedVariables,
      compression: compressionConfig,
    });
    artifact.body = body;
    artifact.bytes = body.length;
    return artifact;
  }
  if (hasPreDeltaVariables) {
    throw new Error("pre-delta hover variables require the binary schema-v3 container");
  }
  if (predictorMarkers.length > 0) {
    throw new Error("pre-gradient hover variables require the binary schema-v4 container");
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
  const body = compressHoverGridSync(Buffer.from(JSON.stringify(payload)), compressionConfig);
  return {
    body,
    bytes: body.length,
    contentType: "application/json",
    contentEncoding: compressionConfig.contentEncoding,
    schemaVersion: HOVER_GRID_SCHEMA_VERSION,
    diagnostics,
  };
}

// Keep the codec completion closure outside buildHoverGridArtifact/start. Its
// promise may remain pending for an arbitrarily slow worker, and must retain
// only the small artifact shell—not the admitted source-plan scope.
function settleHoverGridCompressionArtifact(artifact, compressionWork) {
  return Promise.resolve(compressionWork).then(publishHoverGridCompressionArtifact.bind(null, artifact));
}

function publishHoverGridCompressionArtifact(artifact, body) {
  artifact.body = body;
  artifact.bytes = body.length;
  delete artifact.pending;
}

function materializeHoverGridArena(plan, encoding, materializeCandidate = materializeHoverGridCandidate) {
  const created = createHoverGridArena({
    rows: plan.height,
    cols: plan.width,
    candidates: plan.candidates,
    encoding,
  });
  if (!created.arena) {
    return { result: null, reason: created.reason };
  }
  const arena = created.arena;
  try {
    for (const candidate of plan.candidates) {
      const target = arena.openPlane(candidate.key);
      const variable = materializeCandidate(plan, candidate, target);
      const validCount = Number(variable?.validCount);
      if (!Number.isFinite(validCount)) {
        throw new Error(`hover arena variable '${candidate.key}' returned a non-finite validCount`);
      }
      if (validCount <= 0) {
        arena.discardPlane(candidate.key);
        continue;
      }
      if (!(variable?.values instanceof Int16Array) || variable.values !== target) {
        throw new Error(`hover arena variable '${candidate.key}' did not preserve its exact target view`);
      }
      if (variable.deltaEncoded === true) {
        throw new Error(`MVH4 arena variable '${candidate.key}' cannot be pre-delta encoded`);
      }
      if (Object.prototype.hasOwnProperty.call(variable, "predictorEncoded")) {
        if (variable.predictorEncoded !== "gradient2d") {
          throw new Error(
            `MVH4 arena variable '${candidate.key}' has unknown predictor ${JSON.stringify(variable.predictorEncoded)}`,
          );
        }
      } else {
        const plane = Buffer.from(target.buffer, target.byteOffset, target.byteLength);
        _gradientEncodeInt16Region(plane, 0, plan.height, plan.width);
        variable.predictorEncoded = "gradient2d";
      }
      arena.commitPlane(candidate.key, variable);
    }
    return { result: arena.seal(), reason: null };
  } catch (error) {
    arena.abort();
    throw error;
  }
}

function hoverGridVariableToJson(variable) {
  if (variable?.deltaEncoded === true) {
    throw new Error("pre-delta hover variables require the binary schema-v3 container");
  }
  if (Object.prototype.hasOwnProperty.call(variable || {}, "predictorEncoded")) {
    throw new Error("pre-gradient hover variables require the binary schema-v4 container");
  }
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

function quantizeHoverGridVariable(values, scale, cellCount, transformValue = null, options = null) {
  const total = Math.max(0, Number(cellCount) || Number(values?.length) || 0);
  const sourceLength = Math.min(total, Number(values?.length) || 0);
  const resolvedScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  const shouldDeltaEncode = Boolean(options?.deltaEncode);
  const shouldGradientEncode = Boolean(options?.gradientEncode);
  if (shouldDeltaEncode && shouldGradientEncode) {
    throw new Error("hover variable cannot request both global1d delta and gradient2d predictors");
  }
  if (!values || total <= 0 || sourceLength <= 0) {
    return emptyHoverGridVariable(resolvedScale);
  }
  const encoded = resolveHoverQuantizeTarget(options?.target, total);
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
  const fusedDeltaState = shouldDeltaEncode && quantizeKernel?.deltaOutput ? { previous: 0 } : null;
  const fusedGradientState = prepareFusedGradientState(
    shouldGradientEncode ? quantizeKernel?.gradient : null,
    options?.gradientCols,
    total,
  );
  const fusedPredictorState = fusedGradientState || fusedDeltaState;
  const validCount = quantizeKernel
    ? quantizeHoverValuesKernel(
        quantizeKernel,
        encoded,
        values,
        sourceLength,
        quantizeMultiplier,
        affineTransform,
        quantizationStats,
        fusedPredictorState,
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
    if (fusedGradientState) {
      appendFusedGradientMissingTail(quantizeKernel, encoded, sourceLength, total, fusedGradientState);
    } else if (fusedDeltaState) {
      encoded[sourceLength] = wrapInt16(HOVER_GRID_MISSING_VALUE - fusedDeltaState.previous);
      encoded.fill(0, sourceLength + 1);
      fusedDeltaState.previous = HOVER_GRID_MISSING_VALUE;
    } else {
      encoded.fill(HOVER_GRID_MISSING_VALUE, sourceLength);
    }
  }
  const deltaEndValue = shouldDeltaEncode
    ? fusedDeltaState
      ? fusedDeltaState.previous
      : deltaEncodeInt16ValuesInPlace(encoded)
    : null;
  return {
    scale: resolvedScale,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: encoded,
    validCount,
    ...quantizationStats,
    ...(shouldDeltaEncode ? { deltaEncoded: true, deltaEndValue } : {}),
    ...(fusedGradientState ? { predictorEncoded: "gradient2d" } : {}),
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
  predictorState = null,
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
    encodeQuantizedPredictorChunk(quantizeKernel, count, predictorState);
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
  predictorState = null,
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
    encodeQuantizedPredictorChunk(quantizeKernel, count, predictorState);
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

function quantizeHoverWindGridVariable({
  uValues,
  vValues,
  multiplier = MPS_TO_MPH,
  scale,
  cellCount,
  deltaEncode = false,
  gradientEncode = false,
  gradientCols = null,
  target = null,
}) {
  const total = Math.max(0, Number(cellCount) || Number(uValues?.length) || Number(vValues?.length) || 0);
  const resolvedScale = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  if (deltaEncode && gradientEncode) {
    throw new Error("hover wind variable cannot request both global1d delta and gradient2d predictors");
  }
  if (!uValues || !vValues || uValues.length !== vValues.length) {
    return emptyHoverGridVariable(resolvedScale);
  }
  const sourceLength = Math.min(total, uValues.length, vValues.length);
  if (total <= 0 || sourceLength <= 0) {
    return emptyHoverGridVariable(resolvedScale);
  }
  const encoded = resolveHoverQuantizeTarget(target, total);
  const quantizeMultiplier = 1 / resolvedScale;
  let validCount = 0;
  let clampCount = 0;
  let nonFiniteCount = Math.max(0, total - sourceLength);
  const quantizeKernel =
    uValues instanceof Float32Array && vValues instanceof Float32Array ? getParcelKernel()?.quantize : null;
  const fusedDeltaState = deltaEncode && quantizeKernel?.deltaOutput ? { previous: 0 } : null;
  const fusedGradientState = prepareFusedGradientState(
    gradientEncode ? quantizeKernel?.gradient : null,
    gradientCols,
    total,
  );
  const fusedPredictorState = fusedGradientState || fusedDeltaState;
  if (quantizeKernel) {
    const kernelStats = quantizeHoverWindValuesKernel(
      quantizeKernel,
      encoded,
      uValues,
      vValues,
      sourceLength,
      quantizeMultiplier,
      multiplier,
      fusedPredictorState,
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
    if (fusedGradientState) {
      appendFusedGradientMissingTail(quantizeKernel, encoded, sourceLength, total, fusedGradientState);
    } else if (fusedDeltaState) {
      encoded[sourceLength] = wrapInt16(HOVER_GRID_MISSING_VALUE - fusedDeltaState.previous);
      encoded.fill(0, sourceLength + 1);
      fusedDeltaState.previous = HOVER_GRID_MISSING_VALUE;
    } else {
      encoded.fill(HOVER_GRID_MISSING_VALUE, sourceLength);
    }
  }
  const deltaEndValue = deltaEncode
    ? fusedDeltaState
      ? fusedDeltaState.previous
      : deltaEncodeInt16ValuesInPlace(encoded)
    : null;
  return {
    scale: resolvedScale,
    offset: 0,
    missing: HOVER_GRID_MISSING_VALUE,
    values: encoded,
    validCount,
    clampCount,
    nonFiniteCount,
    ...(deltaEncode ? { deltaEncoded: true, deltaEndValue } : {}),
    ...(fusedGradientState ? { predictorEncoded: "gradient2d" } : {}),
  };
}

function resolveHoverQuantizeTarget(target, total) {
  if (target === null || target === undefined) {
    return new Int16Array(total);
  }
  if (!(target instanceof Int16Array) || target.length !== total) {
    throw new TypeError(`hover quantize target must be an Int16Array of length ${total}`);
  }
  return target;
}

function prepareFusedGradientState(gradient, cols, total) {
  const resolvedCols = Number(cols);
  if (!gradient || typeof gradient.canEncode !== "function" || !gradient.canEncode(resolvedCols, total)) {
    return null;
  }
  try {
    return gradient.reset(resolvedCols) ? { gradient } : null;
  } catch {
    return null;
  }
}

function encodeQuantizedPredictorChunk(quantizeKernel, count, predictorState) {
  if (predictorState?.gradient) {
    predictorState.gradient.encode(count);
  } else if (predictorState) {
    predictorState.previous = quantizeKernel.deltaOutput(count, predictorState.previous);
  }
}

function appendFusedGradientMissingTail(quantizeKernel, encoded, start, total, gradientState) {
  for (let offset = start; offset < total; offset += quantizeKernel.chunk) {
    const count = Math.min(quantizeKernel.chunk, total - offset);
    quantizeKernel.out.fill(HOVER_GRID_MISSING_VALUE, 0, count);
    gradientState.gradient.encode(count);
    encoded.set(quantizeKernel.out.subarray(0, count), offset);
  }
}

function deltaEncodeInt16ValuesInPlace(values) {
  const kernel = getParcelKernel()?.delta;
  if (kernel) {
    let previous = 0;
    for (let start = 0; start < values.length; start += kernel.chunk) {
      const count = Math.min(kernel.chunk, values.length - start);
      kernel.buf.set(values.subarray(start, start + count));
      previous = kernel.encode(count, previous);
      values.set(kernel.buf.subarray(0, count), start);
    }
    return previous;
  }
  let previous = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    values[index] = value - previous;
    previous = value;
  }
  return previous;
}

function wrapInt16(value) {
  return (value << 16) >> 16;
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
  _buildHoverGridVariablePlan: buildHoverGridVariablePlan,
  _materializeHoverGridArena: materializeHoverGridArena,
  _materializeHoverGridVariablePlan: materializeHoverGridVariablePlan,
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
