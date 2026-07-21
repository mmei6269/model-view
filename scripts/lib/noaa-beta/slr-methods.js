"use strict";

const { rowToLatMercator } = require("../mercator");

const { SNOW_PROFILE_LEVELS } = require("../noaa-nam-parameter-catalog");
const { gridValue, profileSpeedAtLevel, profileValue, resolveProfileGrid } = require("./profile-access");
const { PLETCHER_RF_FEATURE_KEYS, WESTERN_LINEAR_FEATURE_KEYS } = require("./selection");
const { isPointInLower48Mainland, lower48LongitudeIntervalsAtLatitude } = require("./lower48-domain-mask");

const KUCHERA_PROFILE_LEVELS = Object.freeze(SNOW_PROFILE_LEVELS.filter((level) => level >= 500));

const COBB_PROFILE_LEVELS = Object.freeze(SNOW_PROFILE_LEVELS.filter((level) => level >= 300 && level <= 925));

const PLETCHER_RF_AGL_LEVELS = Object.freeze([300, 600, 900, 1200, 1500, 1800, 2100, 2400]);

const CONTIGUOUS_US_SNOW_DOMAIN_V1 = Object.freeze({
  minLat: 24,
  maxLat: 49,
  minLon: -125,
  maxLon: -66.5,
});

const PLETCHER_RF_DOMAIN_MASK_VERSION = "lower48-mainland-natural-earth-0p2deg-v2";

const WESTERN_LINEAR_DOMAIN_MASK_VERSION = "western-lower48-mainland-natural-earth-0p2deg-elevation-v2";

const WESTERN_LINEAR_WEST_OF_LON = -103;

const WESTERN_LINEAR_MIN_ELEVATION_M = 1000;

const WESTERN_LINEAR_MIN_LAT = 31;

const COBB_TTHRESH = Object.freeze([-24, -21, -19, -16, -12, -10, -8, -7, -5, -3, 0]);

const COBB_C1 = Object.freeze([8, 12, 21, 30, 19, 9, 8, 9, 13, 6, 2]);

const COBB_C2 = Object.freeze([-0.0017, 3.5034, 4.9065, -0.465, -4.7608, -2.0799, 0.3122, 2.0127, -0.7004, -3.711, 0]);

const COBB_C3 = Object.freeze([0, 1.1684, -0.4668, -1.0679, -0.1594, 1.2318, 0.363, 1.3375, -2.6941, 1.1888, 0]);

const COBB_C4 = Object.freeze([0.1298, -0.2725, -0.0573, 0.0865, 0.1855, -0.1931, 0.3249, -0.6719, 0.6472, -0.1321, 0]);

function calculateWarmestProfileTempC(decoded, index) {
  return calculateWarmestProfileTempCFromSources(buildKucheraProfileSources(decoded), index);
}

function buildKucheraProfileSources(decoded) {
  return {
    surfaceHeight: resolveProfileGrid(decoded, "HGT", "surface"),
    surfaceTemp: resolveProfileGrid(decoded, "TMP", "surface"),
    levels: KUCHERA_PROFILE_LEVELS.map((level) => ({
      temp: resolveProfileGrid(decoded, "TMP", level),
      height: resolveProfileGrid(decoded, "HGT", level),
    })),
  };
}

function calculateWarmestProfileTempCFromSources(sources, index) {
  let maxTempC = Number.NEGATIVE_INFINITY;
  const surfaceHeight = gridValue(sources?.surfaceHeight, index);
  for (const level of sources?.levels || []) {
    const tempK = gridValue(level.temp, index);
    const heightM = gridValue(level.height, index);
    if (!Number.isFinite(tempK) || !Number.isFinite(heightM)) {
      continue;
    }
    if (Number.isFinite(surfaceHeight) && heightM <= surfaceHeight) {
      continue;
    }
    maxTempC = Math.max(maxTempC, tempK - 273.15);
  }
  const surfaceTempK = gridValue(sources?.surfaceTemp, index);
  if (Number.isFinite(surfaceTempK)) {
    maxTempC = Math.max(maxTempC, surfaceTempK - 273.15);
  }
  return Number.isFinite(maxTempC) ? maxTempC : Number.NaN;
}

function calculateKucheraRatio(maxTempC) {
  if (!Number.isFinite(maxTempC)) {
    return Number.NaN;
  }
  const ratio = maxTempC > -2 ? 12 + 2 * (-2 - maxTempC) : 12 + (-2 - maxTempC);
  return Math.max(3, Math.min(50, ratio));
}

function calculateCobbSlr(decoded, index) {
  return calculateCobbSlrFromSources(buildCobbProfileSources(decoded), index);
}

function buildCobbProfileSources(decoded) {
  return {
    surfaceHeight: resolveProfileGrid(decoded, "HGT", "surface"),
    levels: COBB_PROFILE_LEVELS.map((level) => ({
      level,
      pressurePa: level * 100,
      temp: resolveProfileGrid(decoded, "TMP", level),
      height: resolveProfileGrid(decoded, "HGT", level),
      rh: resolveProfileGrid(decoded, "RH", level),
      omega: resolveProfileGrid(decoded, "VVEL", level),
    })),
  };
}

function calculateCobbSlrFromSources(sources, index) {
  const surfaceHeight = gridValue(sources?.surfaceHeight, index);
  let slrWeightedSum = 0;
  let weightSum = 0;
  for (const level of sources?.levels || []) {
    const tempK = gridValue(level.temp, index);
    const heightM = gridValue(level.height, index);
    const rhPct = gridValue(level.rh, index);
    const omega = gridValue(level.omega, index);
    if (!Number.isFinite(tempK) || !Number.isFinite(heightM) || !Number.isFinite(rhPct) || !Number.isFinite(omega)) {
      continue;
    }
    if (Number.isFinite(surfaceHeight) && heightM <= surfaceHeight) {
      continue;
    }
    const density = level.pressurePa / (287.058 * tempK);
    let wCmSec = -100 * (omega / 9.8 / density);
    if (!Number.isFinite(wCmSec)) {
      continue;
    }
    if (wCmSec < 0) {
      continue;
    }
    const sqrtW = Math.sqrt(Math.max(0, wCmSec));
    const cloudyWeight = rhPct >= 80 ? sqrtW : sqrtW * ((rhPct * rhPct) / 6400);
    if (!Number.isFinite(cloudyWeight) || cloudyWeight <= 0) {
      continue;
    }
    const tempC = tempK - 273.15;
    const layerSlr = calculateCobbLayerSlr(tempC);
    if (!Number.isFinite(layerSlr)) {
      continue;
    }
    slrWeightedSum += layerSlr * cloudyWeight;
    weightSum += cloudyWeight;
  }
  const slr = weightSum > 0 ? slrWeightedSum / weightSum : Number.NaN;
  return Number.isFinite(slr) && slr > 0 && slr <= 50 ? slr : Number.NaN;
}

function calculateCobbLayerSlr(tempC) {
  let total = 0;
  let count = 0;
  // The operational NBM implementation samples the fitted curve at
  // T-1, T, and T+1 C. The former T, T+1, T+2 sampling introduced a
  // systematic one-degree warm displacement and could turn a valid 0 C
  // value into missing data.
  for (let offset = -1; offset <= 1; offset += 1) {
    const value = calculateCobbLayerSlrAtTemp(tempC + offset);
    if (Number.isFinite(value)) {
      total += value;
      count += 1;
    }
  }
  return count > 0 ? total / count : Number.NaN;
}

function calculateCobbLayerSlrAtTemp(tempC) {
  if (!Number.isFinite(tempC)) {
    return Number.NaN;
  }
  if (tempC < COBB_TTHRESH[0]) {
    return COBB_C1[0];
  }
  if (tempC >= COBB_TTHRESH[COBB_TTHRESH.length - 1]) {
    return tempC > 3 ? 0 : Number.NaN;
  }
  let selected = -1;
  for (let index = 0; index < COBB_TTHRESH.length - 1; index += 1) {
    if (COBB_TTHRESH[index] <= tempC && tempC < COBB_TTHRESH[index + 1]) {
      selected = index;
      break;
    }
  }
  if (selected < 0) {
    return Number.NaN;
  }
  const tdiff = tempC - COBB_TTHRESH[selected];
  return (
    COBB_C1[selected] +
    COBB_C2[selected] * tdiff +
    COBB_C3[selected] * tdiff * tdiff +
    COBB_C4[selected] * tdiff * tdiff * tdiff
  );
}

function buildPletcherRfFeatures({ decoded, index, bounds, width, height, scratch = null }) {
  const elevation = profileValue(decoded, "HGT", "surface", index);
  if (!Number.isFinite(elevation)) {
    // Ordered before the Mercator lat/lon derivation so cells without a
    // surface height never pay the per-cell transcendental projection.
    return null;
  }
  const latLon = latLonForGridIndex(index, bounds, width, height);
  if (!isPletcherRfEligiblePixel({ latLon, index, bounds, width, height, scratch })) {
    return null;
  }
  const profile = buildAglProfileColumns(decoded, index, elevation, ["SPD", "TMP", "RH"], {
    scratch: scratch?.profile,
  });
  if (!profile) {
    return null;
  }
  const features =
    Array.isArray(scratch?.features) && scratch.features.length === PLETCHER_RF_FEATURE_KEYS.length
      ? scratch.features
      : new Array(PLETCHER_RF_FEATURE_KEYS.length);
  let featureIndex = 0;
  for (const agl of PLETCHER_RF_AGL_LEVELS) {
    features[featureIndex] = interpolateAglProfileColumn(profile, "SPD", agl, elevation);
    featureIndex += 1;
  }
  for (const agl of PLETCHER_RF_AGL_LEVELS) {
    features[featureIndex] = interpolateAglProfileColumn(profile, "TMP", agl, elevation);
    featureIndex += 1;
  }
  for (const agl of PLETCHER_RF_AGL_LEVELS) {
    features[featureIndex] = interpolateAglProfileColumn(profile, "RH", agl, elevation);
    featureIndex += 1;
  }
  features[featureIndex] = elevation;
  features[featureIndex + 1] = latLon.lat;
  features[featureIndex + 2] = latLon.lon;
  return features.every(Number.isFinite) ? features : null;
}

function buildWesternLinearFeatures({ decoded, index, bounds, width, height, scratch = null }) {
  const elevation = profileValue(decoded, "HGT", "surface", index);
  if (!Number.isFinite(elevation) || elevation < WESTERN_LINEAR_MIN_ELEVATION_M) {
    // Same short-circuit the eligibility helper applies first; evaluated
    // before the per-cell Mercator projection (the helper re-checks it).
    return null;
  }
  const latLon = latLonForGridIndex(index, bounds, width, height);
  if (!isWesternLinearEligiblePixel({ elevation, latLon, index, bounds, width, height, scratch })) {
    return null;
  }
  const profile = buildAglProfileColumns(decoded, index, elevation, ["TMP", "SPD"], {
    scratch: scratch?.profile,
  });
  if (!profile) {
    return null;
  }
  const features =
    Array.isArray(scratch?.features) && scratch.features.length === WESTERN_LINEAR_FEATURE_KEYS.length
      ? scratch.features
      : new Array(WESTERN_LINEAR_FEATURE_KEYS.length);
  features[0] = interpolateAglProfileColumn(profile, "TMP", 400, elevation);
  features[1] = interpolateAglProfileColumn(profile, "TMP", 2400, elevation);
  features[2] = interpolateAglProfileColumn(profile, "SPD", 400, elevation);
  features[3] = interpolateAglProfileColumn(profile, "SPD", 2400, elevation);
  return features.every(Number.isFinite) ? features : null;
}

function isWesternLinearEligiblePixel({ elevation, latLon, index, bounds, width, height, scratch }) {
  return (
    Number.isFinite(elevation) &&
    elevation >= WESTERN_LINEAR_MIN_ELEVATION_M &&
    isContiguousUsSnowDomainPixel(latLon, { index, bounds, width, height, scratch }) &&
    Number(latLon?.lat) >= WESTERN_LINEAR_MIN_LAT &&
    latLon.lon <= WESTERN_LINEAR_WEST_OF_LON
  );
}

function isPletcherRfEligiblePixel({ latLon, index, bounds, width, height, scratch }) {
  return isContiguousUsSnowDomainPixel(latLon, { index, bounds, width, height, scratch });
}

function isContiguousUsSnowDomainPixel(latLon, options = {}) {
  const lat = Number(latLon?.lat);
  const lon = Number(latLon?.lon);
  const withinBounds =
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= CONTIGUOUS_US_SNOW_DOMAIN_V1.minLat &&
    lat <= CONTIGUOUS_US_SNOW_DOMAIN_V1.maxLat &&
    lon >= CONTIGUOUS_US_SNOW_DOMAIN_V1.minLon &&
    lon <= CONTIGUOUS_US_SNOW_DOMAIN_V1.maxLon;
  if (!withinBounds) {
    return false;
  }
  const rowIntervals = resolveLower48RowIntervals(options);
  const cols = Math.max(1, Math.round(Number(options.width) || 0));
  const row = Number.isInteger(Number(options.index)) ? Math.floor(Number(options.index) / cols) : -1;
  if (rowIntervals && row >= 0 && row < rowIntervals.length) {
    const intervals = rowIntervals[row];
    for (let intervalIndex = 0; intervalIndex < intervals.length; intervalIndex += 1) {
      const interval = intervals[intervalIndex];
      if (lon >= interval[0] && lon <= interval[1]) {
        return true;
      }
    }
    return false;
  }
  return isPointInLower48Mainland(lat, lon);
}

function resolveLower48RowIntervals({ scratch, bounds, width, height }) {
  if (!scratch || typeof scratch !== "object" || !bounds) {
    return null;
  }
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  if (cols <= 0 || rows <= 0) {
    return null;
  }
  // Numeric memo comparison: this runs once per active cell, so the memo
  // test must not allocate (the previous 6-element array + join built a
  // fresh key string per cell).
  const cached = scratch.lower48DomainMask;
  if (
    cached &&
    cached.north === bounds.north &&
    cached.south === bounds.south &&
    cached.west === bounds.west &&
    cached.east === bounds.east &&
    cached.cols === cols &&
    cached.rows === rows
  ) {
    return cached.rowIntervals;
  }
  const rowIntervals = Array.from({ length: rows }, (_, y) =>
    lower48LongitudeIntervalsAtLatitude(rowToLatMercator(rows > 1 ? y : 0.5, rows > 1 ? rows : 2, bounds)),
  );
  scratch.lower48DomainMask = {
    north: bounds.north,
    south: bounds.south,
    west: bounds.west,
    east: bounds.east,
    cols,
    rows,
    rowIntervals,
  };
  return rowIntervals;
}

function buildAglProfileColumns(decoded, index, elevation, variables, options = {}) {
  if (!Number.isFinite(elevation)) {
    return null;
  }
  const wanted = Array.from(new Set(Array.isArray(variables) ? variables : []));
  const profileLevels =
    Array.isArray(options.levels) && options.levels.length > 0 ? options.levels : SNOW_PROFILE_LEVELS;
  const profile = resolveAglProfileScratch(options.scratch, wanted, profileLevels.length + 1);
  profile.count = 0;
  const columns = resolveAglProfileColumns(decoded, wanted, profileLevels, profile);

  const surfaceValues =
    profile.values instanceof Float64Array && profile.values.length >= wanted.length
      ? profile.values
      : new Array(wanted.length);
  let hasSurfaceValue = false;
  for (let wantedIndex = 0; wantedIndex < wanted.length; wantedIndex += 1) {
    const value = aglProfileColumnValue(columns.surface[wantedIndex], index);
    surfaceValues[wantedIndex] = value;
    hasSurfaceValue = hasSurfaceValue || Number.isFinite(value);
  }
  if (hasSurfaceValue) {
    appendAglProfileRow(profile, wanted, elevation, surfaceValues);
  }

  for (let levelIndex = 0; levelIndex < columns.levels.length; levelIndex += 1) {
    const levelColumns = columns.levels[levelIndex];
    const heightM = aglProfileColumnValue(levelColumns.height, index);
    if (!Number.isFinite(heightM) || heightM <= elevation) {
      continue;
    }
    const values = surfaceValues;
    for (let wantedIndex = 0; wantedIndex < wanted.length; wantedIndex += 1) {
      values[wantedIndex] = aglProfileColumnValue(levelColumns.values[wantedIndex], index);
    }
    appendAglProfileRow(profile, wanted, heightM, values);
  }
  if (profile.count === 0) {
    return null;
  }
  return profile;
}

// Per-(variable, level) grid resolution hoisted out of the per-cell calls: the
// memo lives on the persistent profile scratch so decode-key strings are built
// once per frame instead of once per active cell. A resolved column is
// { grid } for scalar variables or { uGrid, vGrid } for SPD; the per-cell reads
// replicate profileValue/profileSpeedAtLevel exactly (Number conversion, finite
// normalization, and hypot order are unchanged).
function resolveAglProfileColumns(decoded, wanted, profileLevels, profile) {
  let memo = profile.columnGridMemo || null;
  if (!memo || memo.decoded !== decoded) {
    memo = { decoded, columns: new Map() };
    profile.columnGridMemo = memo;
  }
  const resolveColumn = (variable, level) => {
    const key = `${variable}:${String(level)}`;
    let column = memo.columns.get(key);
    if (!column) {
      if (variable === "SPD") {
        column = {
          uGrid: resolveProfileGrid(decoded, "UGRD", level),
          vGrid: resolveProfileGrid(decoded, "VGRD", level),
        };
      } else if (
        variable === "UGRD" ||
        variable === "VGRD" ||
        variable === "TMP" ||
        variable === "RH" ||
        variable === "HGT"
      ) {
        column = { grid: resolveProfileGrid(decoded, variable, level) };
      } else {
        column = { grid: null };
      }
      memo.columns.set(key, column);
    }
    return column;
  };
  return {
    surface: wanted.map((variable) => resolveColumn(variable, "surface")),
    levels: profileLevels.map((level) => ({
      height: resolveColumn("HGT", level),
      values: wanted.map((variable) => resolveColumn(variable, level)),
    })),
  };
}

function aglProfileColumnValue(column, index) {
  if (column.uGrid || column.vGrid) {
    const u = gridValue(column.uGrid, index);
    const v = gridValue(column.vGrid, index);
    return Number.isFinite(u) && Number.isFinite(v) ? Math.hypot(u, v) : Number.NaN;
  }
  return gridValue(column.grid, index);
}

function appendAglProfileRow(profile, wanted, height, values) {
  const row = profile.count;
  if (row >= profile.heights.length) {
    return;
  }
  profile.heights[row] = height;
  for (let wantedIndex = 0; wantedIndex < wanted.length; wantedIndex += 1) {
    profile[wanted[wantedIndex]][row] = Number(values[wantedIndex]);
  }
  profile.count = row + 1;
}

function createAglProfileScratch(variables, size = SNOW_PROFILE_LEVELS.length + 1) {
  const wanted = Array.from(new Set(Array.isArray(variables) ? variables : []));
  const count = Math.max(1, Math.round(Number(size) || SNOW_PROFILE_LEVELS.length + 1));
  const scratch = {
    heights: new Float64Array(count),
    values: new Float64Array(Math.max(1, wanted.length)),
    count: 0,
  };
  for (const variable of wanted) {
    scratch[variable] = new Float64Array(count);
  }
  return scratch;
}

function resolveAglProfileScratch(candidate, variables, size) {
  const wanted = Array.from(new Set(Array.isArray(variables) ? variables : []));
  const count = Math.max(1, Math.round(Number(size) || SNOW_PROFILE_LEVELS.length + 1));
  const hasUsableScratch =
    candidate &&
    candidate.heights instanceof Float64Array &&
    candidate.heights.length >= count &&
    candidate.values instanceof Float64Array &&
    candidate.values.length >= wanted.length &&
    wanted.every((variable) => candidate[variable] instanceof Float64Array && candidate[variable].length >= count);
  if (hasUsableScratch) {
    return candidate;
  }
  return createAglProfileScratch(wanted, count);
}

function profileColumnValue(decoded, variable, level, index) {
  if (variable === "SPD") {
    return profileSpeedAtLevel(decoded, level, index);
  }
  if (variable === "UGRD" || variable === "VGRD" || variable === "TMP" || variable === "RH") {
    return profileValue(decoded, variable, level, index);
  }
  return Number.NaN;
}

function interpolateAglProfileColumn(profile, variable, aglMeters, elevation) {
  const heights = profile?.heights;
  const values = profile?.[variable];
  const heightsUsable = Array.isArray(heights) || ArrayBuffer.isView(heights);
  const valuesUsable = Array.isArray(values) || ArrayBuffer.isView(values);
  if (!profile || !heightsUsable || !valuesUsable) {
    return Number.NaN;
  }
  const count = Math.min(
    Number.isFinite(Number(profile.count)) ? Math.max(0, Math.round(Number(profile.count))) : heights.length,
    heights.length,
    values.length,
  );
  const targetHeight = elevation + aglMeters;
  let lowerHeight = Number.NaN;
  let lowerValue = Number.NaN;
  for (let index = 0; index < count; index += 1) {
    const currentHeight = Number(heights[index]);
    const currentValue = Number(values[index]);
    if (!Number.isFinite(currentHeight) || !Number.isFinite(currentValue)) {
      continue;
    }
    if (currentHeight === targetHeight) {
      return currentValue;
    }
    if (currentHeight < targetHeight) {
      lowerHeight = currentHeight;
      lowerValue = currentValue;
      continue;
    }
    if (!Number.isFinite(lowerHeight) || !Number.isFinite(lowerValue)) {
      return Number.NaN;
    }
    const t = (targetHeight - lowerHeight) / Math.max(1e-9, currentHeight - lowerHeight);
    return lowerValue + (currentValue - lowerValue) * Math.max(0, Math.min(1, t));
  }
  return Number.NaN;
}

function latLonForGridIndex(index, bounds, width, height) {
  const cols = Math.max(1, Math.round(Number(width) || 1));
  const rows = Math.max(1, Math.round(Number(height) || 1));
  const x = index % cols;
  const y = Math.floor(index / cols);
  const west = Number(bounds?.west);
  const east = Number(bounds?.east);
  const lon =
    Number.isFinite(west) && Number.isFinite(east)
      ? west + (cols > 1 ? x / (cols - 1) : 0.5) * (east - west)
      : Number.NaN;
  return {
    lat: bounds ? rowToLatMercator(rows > 1 ? y : 0.5, rows > 1 ? rows : 2, bounds) : Number.NaN,
    lon,
  };
}

function predictRandomForest(model, features) {
  if (!model?.trees?.length || !Array.isArray(features)) {
    return Number.NaN;
  }
  let total = 0;
  let count = 0;
  for (const tree of model.trees) {
    const value = predictRfTree(tree, features);
    if (Number.isFinite(value)) {
      total += value;
      count += 1;
    }
  }
  return count > 0 ? total / count : Number.NaN;
}

function predictLinearSlr(model, features) {
  if (!model?.coefficients?.length || !Array.isArray(features)) {
    return Number.NaN;
  }
  let value = Number(model.intercept);
  if (!Number.isFinite(value) || features.length !== model.coefficients.length) {
    return Number.NaN;
  }
  for (let index = 0; index < model.coefficients.length; index += 1) {
    const feature = Number(features[index]);
    const coefficient = Number(model.coefficients[index]);
    if (!Number.isFinite(feature) || !Number.isFinite(coefficient)) {
      return Number.NaN;
    }
    value += coefficient * feature;
  }
  return value;
}

function predictRfTree(tree, features) {
  let node = 0;
  for (let depth = 0; depth < 4096; depth += 1) {
    const left = tree.childrenLeft[node];
    const right = tree.childrenRight[node];
    if (left < 0 || right < 0) {
      return tree.value[node];
    }
    const featureIndex = tree.feature[node];
    const featureValue = features[featureIndex];
    if (!Number.isFinite(featureValue)) {
      return Number.NaN;
    }
    node = featureValue <= tree.threshold[node] ? left : right;
    if (!Number.isInteger(node) || node < 0 || node >= tree.value.length) {
      return Number.NaN;
    }
  }
  return Number.NaN;
}

module.exports = {
  COBB_C1,
  COBB_C2,
  COBB_C3,
  COBB_C4,
  COBB_PROFILE_LEVELS,
  COBB_TTHRESH,
  CONTIGUOUS_US_SNOW_DOMAIN_V1,
  KUCHERA_PROFILE_LEVELS,
  PLETCHER_RF_AGL_LEVELS,
  PLETCHER_RF_DOMAIN_MASK_VERSION,
  WESTERN_LINEAR_DOMAIN_MASK_VERSION,
  WESTERN_LINEAR_MIN_ELEVATION_M,
  WESTERN_LINEAR_MIN_LAT,
  WESTERN_LINEAR_WEST_OF_LON,
  appendAglProfileRow,
  buildAglProfileColumns,
  buildCobbProfileSources,
  buildKucheraProfileSources,
  buildPletcherRfFeatures,
  buildWesternLinearFeatures,
  calculateCobbLayerSlr,
  calculateCobbLayerSlrAtTemp,
  calculateCobbSlr,
  calculateCobbSlrFromSources,
  calculateKucheraRatio,
  calculateWarmestProfileTempC,
  calculateWarmestProfileTempCFromSources,
  createAglProfileScratch,
  interpolateAglProfileColumn,
  isContiguousUsSnowDomainPixel,
  isPletcherRfEligiblePixel,
  isWesternLinearEligiblePixel,
  latLonForGridIndex,
  predictLinearSlr,
  predictRandomForest,
  predictRfTree,
  profileColumnValue,
  resolveAglProfileScratch,
};
