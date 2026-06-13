"use strict";

const { clamp01 } = require("./util");

const BUNKERS_RIGHT_MOVER_DEVIATION_MPS = 7.5;

function logPressureInterpolationFraction(targetPressureHpa, lowerPressureHpa, upperPressureHpa) {
  const target = Number(targetPressureHpa);
  const lower = Number(lowerPressureHpa);
  const upper = Number(upperPressureHpa);
  if (![target, lower, upper].every(Number.isFinite) || target <= 0 || lower <= 0 || upper <= 0) {
    return Number.NaN;
  }
  const denominator = Math.log(upper) - Math.log(lower);
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return Number.NaN;
  }
  return (Math.log(target) - Math.log(lower)) / denominator;
}

function sortEffectiveDiagnosticsRowsByHeight(scratch, count) {
  for (let index = 1; index < count; index += 1) {
    const height = scratch.heights[index];
    const u = scratch.u[index];
    const v = scratch.v[index];
    const pressure = scratch.pressure[index];
    const temp = scratch.temp[index];
    const dewpoint = scratch.dewpoint[index];
    let cursor = index - 1;
    while (cursor >= 0 && scratch.heights[cursor] > height) {
      scratch.heights[cursor + 1] = scratch.heights[cursor];
      scratch.u[cursor + 1] = scratch.u[cursor];
      scratch.v[cursor + 1] = scratch.v[cursor];
      scratch.pressure[cursor + 1] = scratch.pressure[cursor];
      scratch.temp[cursor + 1] = scratch.temp[cursor];
      scratch.dewpoint[cursor + 1] = scratch.dewpoint[cursor];
      cursor -= 1;
    }
    scratch.heights[cursor + 1] = height;
    scratch.u[cursor + 1] = u;
    scratch.v[cursor + 1] = v;
    scratch.pressure[cursor + 1] = pressure;
    scratch.temp[cursor + 1] = temp;
    scratch.dewpoint[cursor + 1] = dewpoint;
  }
  updateScratchPressureBrackets(scratch, count);
}

function updateScratchPressureBrackets(scratch, count) {
  // The binary-search fast path in the pressure interpolators is valid only
  // when every pressure row is finite/positive and strictly decreasing with
  // adjacent gaps > 2e-6. That guarantees at most one row can satisfy the
  // |pressure - target| < 1e-6 exact-match test and that bracketing pairs are
  // unique, so binary search returns exactly what the linear scans return.
  // This function runs as the final step of every scratch fill (both fill
  // paths end in sortEffectiveDiagnosticsRowsByHeight), so the flag can never
  // be stale for a freshly filled scratch.
  const pressures = scratch.pressure;
  let valid = count > 0;
  let previous = Number.POSITIVE_INFINITY;
  for (let row = 0; row < count; row += 1) {
    const pressure = pressures[row];
    if (!Number.isFinite(pressure) || pressure <= 0 || !(previous - pressure > 2e-6)) {
      valid = false;
      break;
    }
    previous = pressure;
  }
  scratch.pressureBracketsValid = valid;
  scratch.pressureBracketsRowCount = valid ? count : -1;
}

function findPressureBracketUpperRow(pressures, rowCount, targetPressure) {
  // Returns the smallest row index whose pressure is <= targetPressure in a
  // strictly descending pressure array, or rowCount when every row is above
  // the target.
  let lo = 0;
  let hi = rowCount - 1;
  let result = rowCount;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pressures[mid] <= targetPressure) {
      result = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return result;
}

function interpolateProfileWindRows(scratch, rowCount, targetHeight) {
  if (!Number.isFinite(targetHeight) || rowCount <= 0) {
    return null;
  }
  const heights = scratch.heights;
  const us = scratch.u;
  const vs = scratch.v;
  let lowerRow = -1;
  for (let row = 0; row < rowCount; row += 1) {
    const height = heights[row];
    const u = us[row];
    const v = vs[row];
    if (!Number.isFinite(height) || !Number.isFinite(u) || !Number.isFinite(v)) {
      continue;
    }
    if (height === targetHeight) {
      return { u, v };
    }
    if (height < targetHeight) {
      lowerRow = row;
      continue;
    }
    if (lowerRow < 0) {
      return null;
    }
    const lowerHeight = heights[lowerRow];
    const fraction = (targetHeight - lowerHeight) / Math.max(1e-9, height - lowerHeight);
    return {
      u: us[lowerRow] + (u - us[lowerRow]) * clamp01(fraction),
      v: vs[lowerRow] + (v - vs[lowerRow]) * clamp01(fraction),
    };
  }
  return null;
}

function calculateMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM) {
  const pressureCoordinateMean = calculatePressureCoordinateMeanWindInHeightLayerFromRows(
    scratch,
    rowCount,
    bottomAglM,
    topAglM,
  );
  if (pressureCoordinateMean) {
    return pressureCoordinateMean;
  }
  return calculateHeightMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM);
}

function calculateHeightMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM) {
  if (!Number.isFinite(bottomAglM) || !Number.isFinite(topAglM) || topAglM <= bottomAglM) {
    return null;
  }
  let previousHeight = bottomAglM;
  let previousWind = interpolateProfileWindRows(scratch, rowCount, bottomAglM);
  if (!previousWind) {
    return null;
  }
  let sumU = 0;
  let sumV = 0;
  let totalDepth = 0;
  const addSegment = (nextHeight, nextWind) => {
    const dz = nextHeight - previousHeight;
    if (Number.isFinite(dz) && dz > 0) {
      sumU += ((previousWind.u + nextWind.u) / 2) * dz;
      sumV += ((previousWind.v + nextWind.v) / 2) * dz;
      totalDepth += dz;
    }
    previousHeight = nextHeight;
    previousWind = nextWind;
  };
  for (let row = 0; row < rowCount; row += 1) {
    const height = scratch.heights[row];
    if (!Number.isFinite(height) || height <= bottomAglM || height >= topAglM) {
      continue;
    }
    addSegment(height, { u: scratch.u[row], v: scratch.v[row] });
  }
  const topWind = interpolateProfileWindRows(scratch, rowCount, topAglM);
  if (!topWind) {
    return null;
  }
  addSegment(topAglM, topWind);
  return totalDepth > 0 ? { u: sumU / totalDepth, v: sumV / totalDepth } : null;
}

function calculatePressureCoordinateMeanWindInHeightLayerFromRows(
  scratch,
  rowCount,
  bottomAglM,
  topAglM,
  options = {},
) {
  const bottomPressure = interpolateProfilePressureRows(scratch, rowCount, bottomAglM);
  const topPressure = interpolateProfilePressureRows(scratch, rowCount, topAglM);
  return calculateMeanWindByPressureFromRows(scratch, rowCount, bottomPressure, topPressure, options);
}

function calculatePointSoundingMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM) {
  return calculateMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM);
}

function calculateCorfidiMcsMotionFromRows(scratch, rowCount) {
  const surfacePressure = scratch.pressure?.[0];
  if (!Number.isFinite(surfacePressure) || rowCount < 3) {
    return null;
  }
  const deepBottomPressure = surfacePressure < 850 ? surfacePressure : 850;
  const deepMean = calculateMeanWindByPressureFromRows(scratch, rowCount, deepBottomPressure, 300);
  const pressureAt1p5km = interpolateProfilePressureRows(scratch, rowCount, 1500);
  const lowMean = calculateMeanWindByPressureFromRows(scratch, rowCount, surfacePressure, pressureAt1p5km);
  if (!deepMean || !lowMean) {
    return null;
  }
  const upshear = {
    u: deepMean.u - lowMean.u,
    v: deepMean.v - lowMean.v,
  };
  return {
    upshear,
    downshear: {
      u: deepMean.u + upshear.u,
      v: deepMean.v + upshear.v,
    },
  };
}

function calculateMeanWindByPressureFromRows(scratch, rowCount, bottomPressureHpa, topPressureHpa, options = {}) {
  const bottomPressure = Number(bottomPressureHpa);
  const topPressure = Number(topPressureHpa);
  if (!Number.isFinite(bottomPressure) || !Number.isFinite(topPressure) || bottomPressure <= topPressure) {
    return null;
  }
  const pressureWeighted = Boolean(options?.pressureWeighted);
  // Reused scratch sample arrays replace per-call sample objects and the
  // comparator sort. Dedupe predicate, accepted-sample order, and the Simpson
  // summation order are unchanged: accepted pressures are pairwise >=1e-6
  // apart, so descending order is unique and insertion sort reproduces the
  // previous comparator sort exactly.
  let samplePs = scratch.meanWindSampleP;
  if (!samplePs || samplePs.length < rowCount + 2) {
    samplePs = new Float64Array(rowCount + 2);
    scratch.meanWindSampleP = samplePs;
    scratch.meanWindSampleU = new Float64Array(rowCount + 2);
    scratch.meanWindSampleV = new Float64Array(rowCount + 2);
  }
  const sampleUs = scratch.meanWindSampleU;
  const sampleVs = scratch.meanWindSampleV;
  let sampleCount = 0;
  const addSample = (pressureHpa, u, v) => {
    if (!Number.isFinite(pressureHpa) || !Number.isFinite(u) || !Number.isFinite(v)) {
      return;
    }
    if (pressureHpa > bottomPressure + 1e-6 || pressureHpa < topPressure - 1e-6) {
      return;
    }
    for (let existing = 0; existing < sampleCount; existing += 1) {
      if (Math.abs(samplePs[existing] - pressureHpa) < 1e-6) {
        return;
      }
    }
    samplePs[sampleCount] = pressureHpa;
    sampleUs[sampleCount] = u;
    sampleVs[sampleCount] = v;
    sampleCount += 1;
  };
  const bottomWind = interpolateProfileWindAtPressureRows(scratch, rowCount, bottomPressure);
  const topWind = interpolateProfileWindAtPressureRows(scratch, rowCount, topPressure);
  if (!isFiniteWindVector(bottomWind) || !isFiniteWindVector(topWind)) {
    return null;
  }
  const pressures = scratch.pressure;
  const us = scratch.u;
  const vs = scratch.v;
  addSample(bottomPressure, bottomWind.u, bottomWind.v);
  for (let row = 0; row < rowCount; row += 1) {
    const pressure = pressures[row];
    if (!Number.isFinite(pressure) || pressure >= bottomPressure || pressure <= topPressure) {
      continue;
    }
    addSample(pressure, us[row], vs[row]);
  }
  addSample(topPressure, topWind.u, topWind.v);
  for (let index = 1; index < sampleCount; index += 1) {
    const pressure = samplePs[index];
    const u = sampleUs[index];
    const v = sampleVs[index];
    let cursor = index - 1;
    while (cursor >= 0 && samplePs[cursor] < pressure) {
      samplePs[cursor + 1] = samplePs[cursor];
      sampleUs[cursor + 1] = sampleUs[cursor];
      sampleVs[cursor + 1] = sampleVs[cursor];
      cursor -= 1;
    }
    samplePs[cursor + 1] = pressure;
    sampleUs[cursor + 1] = u;
    sampleVs[cursor + 1] = v;
  }
  let sumU = 0;
  let sumV = 0;
  let totalWeight = 0;
  for (let index = 1; index < sampleCount; index += 1) {
    const lowerP = samplePs[index - 1];
    const upperP = samplePs[index];
    const dp = lowerP - upperP;
    if (!Number.isFinite(dp) || dp <= 0) {
      continue;
    }
    const lowerU = sampleUs[index - 1];
    const lowerV = sampleVs[index - 1];
    const upperU = sampleUs[index];
    const upperV = sampleVs[index];
    const midPressure = (lowerP + upperP) / 2;
    const mid = interpolateProfileWindAtPressureRows(scratch, rowCount, midPressure);
    const segmentWeight = pressureWeighted ? ((lowerP + 4 * midPressure + upperP) / 6) * dp : dp;
    if (mid) {
      if (pressureWeighted) {
        sumU += ((lowerU * lowerP + 4 * mid.u * midPressure + upperU * upperP) / 6) * dp;
        sumV += ((lowerV * lowerP + 4 * mid.v * midPressure + upperV * upperP) / 6) * dp;
      } else {
        sumU += ((lowerU + 4 * mid.u + upperU) / 6) * dp;
        sumV += ((lowerV + 4 * mid.v + upperV) / 6) * dp;
      }
    } else {
      if (pressureWeighted) {
        sumU += ((lowerU * lowerP + upperU * upperP) / 2) * dp;
        sumV += ((lowerV * lowerP + upperV * upperP) / 2) * dp;
      } else {
        sumU += ((lowerU + upperU) / 2) * dp;
        sumV += ((lowerV + upperV) / 2) * dp;
      }
    }
    totalWeight += segmentWeight;
  }
  return totalWeight > 0 ? { u: sumU / totalWeight, v: sumV / totalWeight } : null;
}

function isFiniteWindVector(wind) {
  return Boolean(wind && Number.isFinite(wind.u) && Number.isFinite(wind.v));
}

function interpolateProfilePressureRows(scratch, rowCount, targetHeight) {
  if (!Number.isFinite(targetHeight) || rowCount <= 0) {
    return Number.NaN;
  }
  const heights = scratch.heights;
  const pressures = scratch.pressure;
  let lowerRow = -1;
  for (let row = 0; row < rowCount; row += 1) {
    const height = heights[row];
    const pressure = pressures[row];
    if (!Number.isFinite(height) || !Number.isFinite(pressure) || pressure <= 0) {
      continue;
    }
    if (height === targetHeight) {
      return pressure;
    }
    if (height < targetHeight) {
      lowerRow = row;
      continue;
    }
    if (lowerRow < 0) {
      return Number.NaN;
    }
    const lowerHeight = heights[lowerRow];
    const lowerPressure = pressures[lowerRow];
    if (!Number.isFinite(lowerHeight) || !Number.isFinite(lowerPressure) || lowerPressure <= 0) {
      return Number.NaN;
    }
    const fraction = (targetHeight - lowerHeight) / Math.max(1e-9, height - lowerHeight);
    return Math.exp(Math.log(lowerPressure) + (Math.log(pressure) - Math.log(lowerPressure)) * clamp01(fraction));
  }
  return Number.NaN;
}

function interpolateProfileWindAtPressureRows(scratch, rowCount, targetPressureHpa) {
  const targetPressure = Number(targetPressureHpa);
  if (!Number.isFinite(targetPressure) || targetPressure <= 0 || rowCount <= 0) {
    return null;
  }
  const pressures = scratch.pressure;
  const us = scratch.u;
  const vs = scratch.v;
  if (scratch.pressureBracketsValid === true && scratch.pressureBracketsRowCount === rowCount) {
    // Strictly descending pressures with gaps > 2e-6: the exact-match row and
    // the bracketing pair are unique, so binary search reproduces the linear
    // scans below exactly.
    const upperRow = findPressureBracketUpperRow(pressures, rowCount, targetPressure);
    let matchRow = -1;
    if (upperRow < rowCount && Math.abs(pressures[upperRow] - targetPressure) < 1e-6) {
      matchRow = upperRow;
    } else if (upperRow > 0 && Math.abs(pressures[upperRow - 1] - targetPressure) < 1e-6) {
      matchRow = upperRow - 1;
    }
    if (matchRow >= 0) {
      const u = us[matchRow];
      const v = vs[matchRow];
      return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
    }
    if (upperRow <= 0 || upperRow >= rowCount) {
      return null;
    }
    const lowerU = us[upperRow - 1];
    const lowerV = vs[upperRow - 1];
    const upperU = us[upperRow];
    const upperV = vs[upperRow];
    if (!Number.isFinite(lowerU) || !Number.isFinite(lowerV) || !Number.isFinite(upperU) || !Number.isFinite(upperV)) {
      return null;
    }
    const fraction = logPressureInterpolationFraction(targetPressure, pressures[upperRow - 1], pressures[upperRow]);
    const t = clamp01(fraction);
    return {
      u: lowerU + (upperU - lowerU) * t,
      v: lowerV + (upperV - lowerV) * t,
    };
  }
  for (let row = 0; row < rowCount; row += 1) {
    if (Math.abs(pressures[row] - targetPressure) < 1e-6) {
      const u = us[row];
      const v = vs[row];
      return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
    }
  }
  for (let row = 1; row < rowCount; row += 1) {
    const lowerPressure = pressures[row - 1];
    const upperPressure = pressures[row];
    if (
      !Number.isFinite(lowerPressure) ||
      !Number.isFinite(upperPressure) ||
      lowerPressure <= 0 ||
      upperPressure <= 0
    ) {
      continue;
    }
    const brackets =
      (lowerPressure >= targetPressure && upperPressure <= targetPressure) ||
      (lowerPressure <= targetPressure && upperPressure >= targetPressure);
    if (!brackets) {
      continue;
    }
    const lowerU = us[row - 1];
    const lowerV = vs[row - 1];
    const upperU = us[row];
    const upperV = vs[row];
    if (!Number.isFinite(lowerU) || !Number.isFinite(lowerV) || !Number.isFinite(upperU) || !Number.isFinite(upperV)) {
      continue;
    }
    const fraction = logPressureInterpolationFraction(targetPressure, lowerPressure, upperPressure);
    const t = clamp01(fraction);
    return {
      u: lowerU + (upperU - lowerU) * t,
      v: lowerV + (upperV - lowerV) * t,
    };
  }
  return null;
}

function interpolateProfileThermoAtPressureRows(scratch, rowCount, targetPressureHpa) {
  const targetPressure = Number(targetPressureHpa);
  if (!Number.isFinite(targetPressure) || targetPressure <= 0 || rowCount <= 0) {
    return null;
  }
  const pressures = scratch.pressure;
  const heights = scratch.heights;
  const temps = scratch.temp;
  const dewpoints = scratch.dewpoint;
  if (scratch.pressureBracketsValid === true && scratch.pressureBracketsRowCount === rowCount) {
    // Strictly descending pressures with gaps > 2e-6: the exact-match row and
    // the bracketing pair are unique, so binary search reproduces the linear
    // scans below exactly.
    const upperRow = findPressureBracketUpperRow(pressures, rowCount, targetPressure);
    let matchRow = -1;
    if (upperRow < rowCount && Math.abs(pressures[upperRow] - targetPressure) < 1e-6) {
      matchRow = upperRow;
    } else if (upperRow > 0 && Math.abs(pressures[upperRow - 1] - targetPressure) < 1e-6) {
      matchRow = upperRow - 1;
    }
    if (matchRow >= 0) {
      return {
        pressureHpa: targetPressure,
        heightAglM: heights[matchRow],
        tempK: temps[matchRow],
        dewpointK: dewpoints[matchRow],
      };
    }
    if (upperRow <= 0 || upperRow >= rowCount) {
      return null;
    }
    const fraction = logPressureInterpolationFraction(targetPressure, pressures[upperRow - 1], pressures[upperRow]);
    const t = clamp01(fraction);
    return {
      pressureHpa: targetPressure,
      heightAglM: heights[upperRow - 1] + (heights[upperRow] - heights[upperRow - 1]) * t,
      tempK: temps[upperRow - 1] + (temps[upperRow] - temps[upperRow - 1]) * t,
      dewpointK: dewpoints[upperRow - 1] + (dewpoints[upperRow] - dewpoints[upperRow - 1]) * t,
    };
  }
  for (let row = 0; row < rowCount; row += 1) {
    if (Math.abs(pressures[row] - targetPressure) < 1e-6) {
      return {
        pressureHpa: targetPressure,
        heightAglM: heights[row],
        tempK: temps[row],
        dewpointK: dewpoints[row],
      };
    }
  }
  for (let row = 1; row < rowCount; row += 1) {
    const lowerPressure = pressures[row - 1];
    const upperPressure = pressures[row];
    if (
      !Number.isFinite(lowerPressure) ||
      !Number.isFinite(upperPressure) ||
      lowerPressure <= 0 ||
      upperPressure <= 0
    ) {
      continue;
    }
    const brackets =
      (lowerPressure >= targetPressure && upperPressure <= targetPressure) ||
      (lowerPressure <= targetPressure && upperPressure >= targetPressure);
    if (!brackets) {
      continue;
    }
    const fraction = logPressureInterpolationFraction(targetPressure, lowerPressure, upperPressure);
    const t = clamp01(fraction);
    return {
      pressureHpa: targetPressure,
      heightAglM: heights[row - 1] + (heights[row] - heights[row - 1]) * t,
      tempK: temps[row - 1] + (temps[row] - temps[row - 1]) * t,
      dewpointK: dewpoints[row - 1] + (dewpoints[row] - dewpoints[row - 1]) * t,
    };
  }
  return null;
}

function calculateBunkersMotionFromRows(scratch, rowCount, options = {}) {
  const meanBottomAglM = Number.isFinite(options?.meanBottomAglM) ? Number(options.meanBottomAglM) : 0;
  const meanTopAglM = Number.isFinite(options?.meanTopAglM) ? Number(options.meanTopAglM) : 6000;
  const shearBottomAglM = Number.isFinite(options?.shearBottomAglM) ? Number(options.shearBottomAglM) : 0;
  const shearTopAglM = Number.isFinite(options?.shearTopAglM) ? Number(options.shearTopAglM) : 6000;
  if (meanTopAglM <= meanBottomAglM || shearTopAglM <= shearBottomAglM + 500) {
    return null;
  }
  const meanBottomPressure = interpolateProfilePressureRows(scratch, rowCount, meanBottomAglM);
  const meanTopPressure = interpolateProfilePressureRows(scratch, rowCount, meanTopAglM);
  const meanWind = calculateMeanWindByPressureFromRows(scratch, rowCount, meanBottomPressure, meanTopPressure, {
    pressureWeighted: Boolean(options?.pressureWeightedMean),
  });
  // SHARPpy/SHARPlib wind_shear convention: the deviation is orthogonal to the
  // point-wind shear between the shear-layer bottom and top, not 500 m
  // layer-mean winds. Layer-mean endpoints understate right-mover speed when a
  // low-level jet sits inside the bottom mean layer.
  const windsLo = interpolateProfileWindRows(scratch, rowCount, shearBottomAglM);
  const windsHi = interpolateProfileWindRows(scratch, rowCount, shearTopAglM);
  if (!meanWind || !windsLo || !windsHi) {
    return null;
  }
  const shearU = windsHi.u - windsLo.u;
  const shearV = windsHi.v - windsLo.v;
  const shearMagnitude = Math.hypot(shearU, shearV);
  if (!Number.isFinite(shearMagnitude) || shearMagnitude < 1e-6) {
    return null;
  }
  return {
    right: {
      u: meanWind.u + (BUNKERS_RIGHT_MOVER_DEVIATION_MPS * shearV) / shearMagnitude,
      v: meanWind.v - (BUNKERS_RIGHT_MOVER_DEVIATION_MPS * shearU) / shearMagnitude,
    },
    left: {
      u: meanWind.u - (BUNKERS_RIGHT_MOVER_DEVIATION_MPS * shearV) / shearMagnitude,
      v: meanWind.v + (BUNKERS_RIGHT_MOVER_DEVIATION_MPS * shearU) / shearMagnitude,
    },
  };
}

function calculateStormRelativeHelicityFromRows(scratch, rowCount, bottomAglM, topAglM, stormMotion) {
  if (!stormMotion || !Number.isFinite(bottomAglM) || !Number.isFinite(topAglM) || topAglM <= bottomAglM) {
    return Number.NaN;
  }
  const bottomWind = interpolateProfileWindRows(scratch, rowCount, bottomAglM);
  if (!bottomWind) {
    return Number.NaN;
  }
  const heights = scratch.heights;
  const us = scratch.u;
  const vs = scratch.v;
  const stormU = stormMotion.u;
  const stormV = stormMotion.v;
  let previousU = bottomWind.u;
  let previousV = bottomWind.v;
  let helicity = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const height = heights[row];
    if (!Number.isFinite(height) || height <= bottomAglM || height >= topAglM) {
      continue;
    }
    const nextU = us[row];
    const nextV = vs[row];
    helicity += (nextU - stormU) * (previousV - stormV) - (previousU - stormU) * (nextV - stormV);
    previousU = nextU;
    previousV = nextV;
  }
  const topWind = interpolateProfileWindRows(scratch, rowCount, topAglM);
  if (!topWind) {
    return Number.NaN;
  }
  helicity += (topWind.u - stormU) * (previousV - stormV) - (previousU - stormU) * (topWind.v - stormV);
  return helicity;
}

module.exports = {
  BUNKERS_RIGHT_MOVER_DEVIATION_MPS,
  calculateBunkersMotionFromRows,
  calculateCorfidiMcsMotionFromRows,
  calculateHeightMeanWindInLayerFromRows,
  calculateMeanWindByPressureFromRows,
  calculateMeanWindInLayerFromRows,
  calculatePointSoundingMeanWindInLayerFromRows,
  calculatePressureCoordinateMeanWindInHeightLayerFromRows,
  calculateStormRelativeHelicityFromRows,
  findPressureBracketUpperRow,
  interpolateProfilePressureRows,
  interpolateProfileThermoAtPressureRows,
  interpolateProfileWindAtPressureRows,
  interpolateProfileWindRows,
  isFiniteWindVector,
  logPressureInterpolationFraction,
  sortEffectiveDiagnosticsRowsByHeight,
  updateScratchPressureBrackets,
};
