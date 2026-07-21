"use strict";

const { MM_TO_IN, clampInt } = require("./util");
const { smoothFiniteNonnegativeGrid } = require("./grid-ops");
const {
  PLETCHER_RF_FEATURE_KEYS,
  WESTERN_LINEAR_FEATURE_KEYS,
  loadSnowRfModel,
  loadWesternLinearSlrModel,
} = require("./selection");
const {
  buildCobbProfileSources,
  buildKucheraProfileSources,
  buildPletcherRfFeatures,
  buildWesternLinearFeatures,
  calculateCobbSlrFromSources,
  calculateKucheraRatio,
  calculateWarmestProfileTempCFromSources,
  createAglProfileScratch,
  predictLinearSlr,
  predictRandomForest,
} = require("./slr-methods");
const { activeDescriptorCellCount, activeVisitCount, activeVisitIndex } = require("./winter-sparse");

const SNOW_LIQUID_TOTAL_KEY = "snowLiquidTotal";

const SNOWFALL_RENDER_THRESHOLD_IN = 0.1;

const MAX_SNOW_TO_LIQUID_RATIO = 60;

const MIN_VISIBLE_SNOW_LIQUID_IN = SNOWFALL_RENDER_THRESHOLD_IN / MAX_SNOW_TO_LIQUID_RATIO;

const SNOWFALL_PRESENTATION_SMOOTHING_BY_MODEL = Object.freeze({
  gfs: Object.freeze({ passes: 2 }),
});

function buildIntervalSnowfallGridsForEntries({
  entries,
  chunkDescriptors,
  profilesByHour,
  decoded,
  bounds,
  width,
  height,
}) {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry?.key) : [];
  const descriptors = Array.isArray(chunkDescriptors) ? chunkDescriptors : [];
  const cellCount = Number(width) * Number(height);
  const out = new Map();
  if (list.length === 0 || descriptors.length === 0 || !Number.isFinite(cellCount) || cellCount <= 0) {
    return out;
  }
  const grids = new Map();
  for (const entry of list) {
    if (isSupportedIntervalSnowfallEntry(entry)) {
      grids.set(entry.key, new Float32Array(cellCount).fill(0));
    }
  }
  if (grids.size === 0) {
    return out;
  }
  // One running skipped-trace-liquid total per learned entry, shared by every
  // profile-hour state of that entry so the visibility bound holds across the
  // whole accumulation window (see skipTraceIntervalSnowfallLiquid).
  const skippedTraceLiquidByKey = new Map();
  for (const key of grids.keys()) {
    if (key === "snowRfConus" || key === "snowWesternLinear") {
      // Liquid chunks arrive as Float32 values, but the running bound must not
      // round back below the visibility floor after an addition crosses it.
      // Keep the accumulator at Number precision so each source-f32 chunk is
      // represented exactly and the omitted-liquid bound remains conservative.
      skippedTraceLiquidByKey.set(key, new Float64Array(cellCount).fill(0));
    }
  }
  const statesByDecoded = new WeakMap();
  let primitiveDecodedStates = null;

  for (const descriptor of descriptors) {
    const { chunk, liquidIn, activeIndices } = descriptor;
    if (!liquidIn || activeDescriptorCellCount(descriptor, cellCount) === 0) {
      return new Map();
    }
    const profileDecoded = profilesByHour.get(chunk.profileHour) || decoded;
    const states = getIntervalSnowfallEntryStates(profileDecoded);
    if (states.length !== grids.size) {
      return new Map();
    }
    const visitCount = activeVisitCount(activeIndices, cellCount);
    for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
      const index = activeVisitIndex(activeIndices, visitIndex);
      const liquid = Number(liquidIn[index]);
      if (!Number.isFinite(liquid)) {
        for (const state of states) {
          state.out[index] = Number.NaN;
        }
        continue;
      }
      if (liquid <= 0) {
        continue;
      }
      for (const state of states) {
        addIntervalSnowfallValueForState(state, index, liquid);
      }
    }
  }

  for (const [key, values] of grids) {
    out.set(key, values);
  }
  return out;

  function getIntervalSnowfallEntryStates(profileDecoded) {
    if (profileDecoded && typeof profileDecoded === "object") {
      const cached = statesByDecoded.get(profileDecoded);
      if (cached) {
        return cached;
      }
      const states = buildIntervalSnowfallEntryStates({
        entries: list,
        decoded: profileDecoded,
        bounds,
        width,
        height,
      });
      statesByDecoded.set(profileDecoded, states);
      return states;
    }
    if (!primitiveDecodedStates) {
      primitiveDecodedStates = buildIntervalSnowfallEntryStates({
        entries: list,
        decoded: profileDecoded || {},
        bounds,
        width,
        height,
      });
    }
    return primitiveDecodedStates;
  }

  function buildIntervalSnowfallEntryStates({ entries: stateEntries, decoded: profileDecoded, bounds, width, height }) {
    const states = [];
    for (const entry of stateEntries) {
      const outGrid = grids.get(entry.key);
      if (!outGrid) {
        continue;
      }
      const state = createIntervalSnowfallEntryState({
        entry,
        out: outGrid,
        decoded: profileDecoded,
        bounds,
        width,
        height,
        skippedTraceLiquidIn: skippedTraceLiquidByKey.get(entry.key) || null,
      });
      if (!state) {
        return [];
      }
      states.push(state);
    }
    return states;
  }
}

function isSupportedIntervalSnowfallEntry(entry) {
  return (
    entry?.key === "snow10to1" ||
    entry?.key === "snowKuchera" ||
    entry?.key === "snowCobb" ||
    entry?.key === "snowRfConus" ||
    entry?.key === "snowWesternLinear"
  );
}

function createIntervalSnowfallEntryState({ entry, out, decoded, bounds, width, height, skippedTraceLiquidIn = null }) {
  if (entry.key === "snow10to1") {
    return { key: entry.key, out, kind: "ratio", ratio: 10 };
  }
  if (entry.key === "snowKuchera") {
    return { key: entry.key, out, kind: "kuchera", sources: buildKucheraProfileSources(decoded) };
  }
  if (entry.key === "snowCobb") {
    return { key: entry.key, out, kind: "cobb", sources: buildCobbProfileSources(decoded) };
  }
  if (entry.key === "snowRfConus") {
    const model = loadSnowRfModel("conus");
    return model
      ? {
          key: entry.key,
          out,
          kind: "snowRfConus",
          model,
          decoded,
          bounds,
          width,
          height,
          skippedTraceLiquidIn,
          scratch: createSnowFeatureScratch(PLETCHER_RF_FEATURE_KEYS.length, ["SPD", "TMP", "RH"]),
        }
      : null;
  }
  if (entry.key === "snowWesternLinear") {
    const model = loadWesternLinearSlrModel();
    return model
      ? {
          key: entry.key,
          out,
          kind: "snowWesternLinear",
          model,
          decoded,
          bounds,
          width,
          height,
          skippedTraceLiquidIn,
          scratch: createSnowFeatureScratch(WESTERN_LINEAR_FEATURE_KEYS.length, ["TMP", "SPD"]),
        }
      : null;
  }
  return null;
}

function addIntervalSnowfallValueForState(state, index, liquid) {
  if (!state || Number.isNaN(state.out[index])) {
    return;
  }
  if (state.kind === "ratio") {
    state.out[index] += Math.max(0, liquid * state.ratio);
    return;
  }
  if (state.kind === "kuchera") {
    const ratio = calculateKucheraRatio(calculateWarmestProfileTempCFromSources(state.sources, index));
    state.out[index] = Number.isFinite(ratio) && ratio > 0 ? state.out[index] + liquid * ratio : Number.NaN;
    return;
  }
  if (state.kind === "cobb") {
    const ratio = calculateCobbSlrFromSources(state.sources, index);
    state.out[index] = Number.isFinite(ratio) && ratio > 0 ? state.out[index] + liquid * ratio : Number.NaN;
    return;
  }
  if (state.kind === "snowRfConus") {
    if (liquid <= MIN_VISIBLE_SNOW_LIQUID_IN && skipTraceIntervalSnowfallLiquid(state, index, liquid)) {
      return;
    }
    const features = buildPletcherRfFeatures({
      decoded: state.decoded,
      index,
      bounds: state.bounds,
      width: state.width,
      height: state.height,
      scratch: state.scratch,
    });
    if (!features) {
      state.out[index] = Number.NaN;
      return;
    }
    const slr = predictRandomForest(state.model, features);
    state.out[index] =
      Number.isFinite(slr) && slr > 0
        ? state.out[index] + liquid * Math.min(MAX_SNOW_TO_LIQUID_RATIO, Math.max(1, slr))
        : Number.NaN;
    return;
  }
  if (state.kind === "snowWesternLinear") {
    if (liquid <= MIN_VISIBLE_SNOW_LIQUID_IN && skipTraceIntervalSnowfallLiquid(state, index, liquid)) {
      return;
    }
    const features = buildWesternLinearFeatures({
      decoded: state.decoded,
      index,
      bounds: state.bounds,
      width: state.width,
      height: state.height,
      scratch: state.scratch,
    });
    if (!features) {
      state.out[index] = Number.NaN;
      return;
    }
    const slr = predictLinearSlr(state.model, features);
    state.out[index] =
      Number.isFinite(slr) && slr > 0
        ? state.out[index] + liquid * Math.min(MAX_SNOW_TO_LIQUID_RATIO, Math.max(1, slr))
        : Number.NaN;
  }
}

// Trace chunks skip the learned SLR compute only while the cell's running
// skipped-liquid total stays below the visibility floor: at the 60:1 cap the
// omitted snow then cannot reach the 0.1in display threshold (plan.md's
// bounded-heuristic rule). Once the running total crosses the floor, that
// chunk and all later chunks compute normally; the early skipped liquid's
// snow stays omitted but is bounded by the floor.
function skipTraceIntervalSnowfallLiquid(state, index, liquid) {
  const tracker = state.skippedTraceLiquidIn;
  if (!tracker) {
    return true;
  }
  const total = tracker[index] + liquid;
  tracker[index] = total;
  return total <= MIN_VISIBLE_SNOW_LIQUID_IN;
}

function buildSnowfallGridForEntry({ entry, decoded, snowLiquidIn, activeIndices = null, bounds, width, height }) {
  if (entry.key === "snow10to1") {
    return multiplySnowLiquidByRatio(snowLiquidIn, 10, activeIndices);
  }
  if (entry.key === "snowKuchera") {
    return buildKucheraSnowfallGrid(decoded, snowLiquidIn, width, height, { activeIndices });
  }
  if (entry.key === "snowCobb") {
    return buildCobbSnowfallGrid(decoded, snowLiquidIn, width, height, { activeIndices });
  }
  if (entry.key === "snowRfConus") {
    return buildSnowRfConusSnowfallGrid({ decoded, snowLiquidIn, activeIndices, bounds, width, height });
  }
  if (entry.key === "snowWesternLinear") {
    return buildWesternLinearSnowfallGrid({ decoded, snowLiquidIn, activeIndices, bounds, width, height });
  }
  return null;
}

function transformGridAffine(values, scale = 1, offset = 0, min = null, stats = null) {
  if (!values) {
    return null;
  }
  const resolvedScale = Number.isFinite(Number(scale)) ? Number(scale) : 1;
  const resolvedOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  const hasMin = Number.isFinite(Number(min));
  const resolvedMin = hasMin ? Number(min) : 0;
  const out = new Float32Array(values.length);
  let finiteCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    let value = values[index] * resolvedScale + resolvedOffset;
    if (hasMin && value < resolvedMin) {
      value = resolvedMin;
    }
    out[index] = value === value ? value : Number.NaN;
    // The tally is read back from the stored f32 cell rather than the f64
    // intermediate, so it matches an independent Number.isFinite scan of the
    // returned grid on every input — including f64-finite values that round
    // to Infinity when stored as f32. Callers may therefore skip that rescan.
    if (stats && Number.isFinite(out[index])) {
      finiteCount += 1;
    }
  }
  if (stats) {
    stats.finiteCount = finiteCount;
  }
  return out;
}

function shouldIncludeGrid(values, visibleThreshold) {
  if (!values) {
    return false;
  }
  const hasVisibleThreshold = Number.isFinite(visibleThreshold);
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (!hasVisibleThreshold || value > visibleThreshold) {
      return true;
    }
  }
  return false;
}

function smoothSnowfallPresentationGrids(grids, { modelKey, width, height }) {
  const entries = Object.entries(grids || {});
  if (entries.length === 0) {
    return grids || {};
  }
  const out = {};
  for (const [key, values] of entries) {
    out[key] = smoothSnowfallPresentationGrid(values, { modelKey, width, height });
  }
  return out;
}

function smoothSnowfallPresentationGrid(values, { modelKey, width, height }) {
  const settings = SNOWFALL_PRESENTATION_SMOOTHING_BY_MODEL[String(modelKey || "").toLowerCase()];
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const cellCount = cols * rows;
  if (!settings || !values || values.length !== cellCount || cellCount <= 0) {
    return values;
  }
  const passes = clampInt(settings.passes, 0, 4, 0);
  if (passes <= 0) {
    return values;
  }
  return smoothFiniteNonnegativeGrid(values, cols, rows, passes);
}

function hasGridValueGreaterThan(values, threshold) {
  if (!values) {
    return false;
  }
  const resolvedThreshold = Number.isFinite(Number(threshold)) ? Number(threshold) : 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (Number.isFinite(value) && value > resolvedThreshold) {
      return true;
    }
  }
  return false;
}

function buildSnowLiquidTotalInGrid(decoded, width, height, stats = null) {
  const cellCount = Number(width) * Number(height);
  if (!Number.isFinite(cellCount) || cellCount <= 0) {
    return null;
  }
  if (decoded?.[SNOW_LIQUID_TOTAL_KEY]?.length === cellCount) {
    return transformGridAffine(decoded[SNOW_LIQUID_TOTAL_KEY], MM_TO_IN, 0, 0, stats);
  }
  return null;
}

function multiplySnowLiquidByRatio(snowLiquidIn, ratio, activeIndices = null) {
  if (!snowLiquidIn) {
    return null;
  }
  const sparse = activeIndices && typeof activeIndices.length === "number";
  const out = new Float32Array(snowLiquidIn.length).fill(sparse ? 0 : Number.NaN);
  const indices = sparse ? activeIndices : null;
  const ratioIsGrid = ratio && typeof ratio.length === "number";
  const fixedRatio = Number(ratio);
  const visitCount = sparse ? indices.length : snowLiquidIn.length;
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = sparse ? indices[visitIndex] : visitIndex;
    const liquid = Number(snowLiquidIn[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= 0) {
      out[index] = 0;
      continue;
    }
    const localRatio = ratioIsGrid ? Number(ratio[index]) : fixedRatio;
    if (!Number.isFinite(localRatio) || localRatio <= 0) {
      out[index] = Number.NaN;
      continue;
    }
    out[index] = liquid * localRatio;
  }
  return out;
}

function buildKucheraSnowfallGrid(decoded, snowLiquidIn, width, height, options = {}) {
  const cellCount = Number(width) * Number(height);
  const sparse = options.activeIndices && typeof options.activeIndices.length === "number";
  const out = new Float32Array(cellCount).fill(sparse ? 0 : Number.NaN);
  const activeIndices = sparse ? options.activeIndices : null;
  const sources = buildKucheraProfileSources(decoded);
  const visitCount = sparse ? activeIndices.length : cellCount;
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = sparse ? activeIndices[visitIndex] : visitIndex;
    const liquid = Number(snowLiquidIn?.[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= 0) {
      out[index] = 0;
      continue;
    }
    const ratio = calculateKucheraRatio(calculateWarmestProfileTempCFromSources(sources, index));
    if (Number.isFinite(ratio) && ratio > 0) {
      out[index] = liquid * ratio;
    } else {
      out[index] = Number.NaN;
    }
  }
  return out;
}

function buildCobbSnowfallGrid(decoded, snowLiquidIn, width, height, options = {}) {
  const cellCount = Number(width) * Number(height);
  const sparse = options.activeIndices && typeof options.activeIndices.length === "number";
  const out = new Float32Array(cellCount).fill(sparse ? 0 : Number.NaN);
  const activeIndices = sparse ? options.activeIndices : null;
  const sources = buildCobbProfileSources(decoded);
  const visitCount = sparse ? activeIndices.length : cellCount;
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = sparse ? activeIndices[visitIndex] : visitIndex;
    const liquid = Number(snowLiquidIn?.[index]);
    if (!Number.isFinite(liquid)) {
      out[index] = Number.NaN;
      continue;
    }
    if (liquid <= 0) {
      out[index] = 0;
      continue;
    }
    const ratio = calculateCobbSlrFromSources(sources, index);
    if (Number.isFinite(ratio) && ratio > 0) {
      out[index] = liquid * ratio;
    } else {
      out[index] = Number.NaN;
    }
  }
  return out;
}

function buildSnowRfConusSnowfallGrid({ decoded, snowLiquidIn, activeIndices = null, bounds, width, height }) {
  const model = loadSnowRfModel("conus");
  if (!model || !snowLiquidIn) {
    return null;
  }
  const cellCount = Number(width) * Number(height);
  const sparse = activeIndices && typeof activeIndices.length === "number";
  const out = new Float32Array(cellCount).fill(sparse ? 0 : Number.NaN);
  const visitCount = sparse ? activeIndices.length : cellCount;
  const featureScratch = createSnowFeatureScratch(PLETCHER_RF_FEATURE_KEYS.length, ["SPD", "TMP", "RH"]);
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = sparse ? activeIndices[visitIndex] : visitIndex;
    const liquid = Number(snowLiquidIn[index]);
    if (!Number.isFinite(liquid) || liquid <= MIN_VISIBLE_SNOW_LIQUID_IN) {
      out[index] = Number.isFinite(liquid) ? 0 : Number.NaN;
      continue;
    }
    const features = buildPletcherRfFeatures({ decoded, index, bounds, width, height, scratch: featureScratch });
    if (!features) {
      out[index] = Number.NaN;
      continue;
    }
    const slr = predictRandomForest(model, features);
    if (Number.isFinite(slr) && slr > 0) {
      out[index] = liquid * Math.min(MAX_SNOW_TO_LIQUID_RATIO, Math.max(1, slr));
    } else {
      out[index] = Number.NaN;
    }
  }
  return out;
}

function buildWesternLinearSnowfallGrid({ decoded, snowLiquidIn, activeIndices = null, bounds, width, height }) {
  const model = loadWesternLinearSlrModel();
  if (!model || !snowLiquidIn) {
    return null;
  }
  const cellCount = Number(width) * Number(height);
  const sparse = activeIndices && typeof activeIndices.length === "number";
  const out = new Float32Array(cellCount).fill(sparse ? 0 : Number.NaN);
  const visitCount = sparse ? activeIndices.length : cellCount;
  const featureScratch = createSnowFeatureScratch(WESTERN_LINEAR_FEATURE_KEYS.length, ["TMP", "SPD"]);
  for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
    const index = sparse ? activeIndices[visitIndex] : visitIndex;
    const liquid = Number(snowLiquidIn[index]);
    if (!Number.isFinite(liquid) || liquid <= MIN_VISIBLE_SNOW_LIQUID_IN) {
      out[index] = Number.isFinite(liquid) ? 0 : Number.NaN;
      continue;
    }
    const features = buildWesternLinearFeatures({ decoded, index, bounds, width, height, scratch: featureScratch });
    if (!features) {
      out[index] = Number.NaN;
      continue;
    }
    const slr = predictLinearSlr(model, features);
    if (Number.isFinite(slr) && slr > 0) {
      out[index] = liquid * Math.min(MAX_SNOW_TO_LIQUID_RATIO, Math.max(1, slr));
    } else {
      out[index] = Number.NaN;
    }
  }
  return out;
}

function createSnowFeatureScratch(featureCount, variables) {
  return {
    features: new Array(Math.max(0, Math.round(Number(featureCount) || 0))),
    profile: createAglProfileScratch(variables),
  };
}

module.exports = {
  MAX_SNOW_TO_LIQUID_RATIO,
  MIN_VISIBLE_SNOW_LIQUID_IN,
  SNOWFALL_PRESENTATION_SMOOTHING_BY_MODEL,
  SNOWFALL_RENDER_THRESHOLD_IN,
  SNOW_LIQUID_TOTAL_KEY,
  addIntervalSnowfallValueForState,
  buildCobbSnowfallGrid,
  buildIntervalSnowfallGridsForEntries,
  buildKucheraSnowfallGrid,
  buildSnowLiquidTotalInGrid,
  buildSnowRfConusSnowfallGrid,
  buildSnowfallGridForEntry,
  buildWesternLinearSnowfallGrid,
  createIntervalSnowfallEntryState,
  createSnowFeatureScratch,
  hasGridValueGreaterThan,
  isSupportedIntervalSnowfallEntry,
  multiplySnowLiquidByRatio,
  shouldIncludeGrid,
  smoothSnowfallPresentationGrid,
  smoothSnowfallPresentationGrids,
  transformGridAffine,
};
