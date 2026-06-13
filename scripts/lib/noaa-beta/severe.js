"use strict";

const { EFFECTIVE_LAYER_PROFILE_LEVELS } = require("../noaa-nam-parameter-catalog");
const { MPS_TO_KT, clamp, clamp01 } = require("./util");
const {
  CP_OVER_RD,
  DRY_ADIABATIC_LAPSE_K_M,
  EPSILON,
  GRAVITY_M_S2,
  RD_OVER_CP,
  boltonLclTemperatureK,
  boltonThetaE,
  dewpointFromTempRhK,
  dewpointFromVaporPressureHpa,
  integrateMoistParcelDescentK,
  integrateMoistParcelTemperatureK,
  mixingRatioFromDewpointK,
  mixingRatioFromVaporPressureHpa,
  moistLiftTemperatureK,
  saturationMixingRatioHpa,
  vaporPressureHpa,
  virtualTemperatureK,
  wetBulbTemperatureC,
  wetBulbTemperatureCAtPressure,
} = require("./thermo");
const {
  calculateBunkersMotionFromRows,
  calculateStormRelativeHelicityFromRows,
  interpolateProfileThermoAtPressureRows,
  interpolateProfileWindRows,
  sortEffectiveDiagnosticsRowsByHeight,
} = require("./profile-wind");
const {
  gridValue,
  profileDataGrid,
  profileValue,
  resolveProfileGrid,
  surfaceDewpointK,
  surfacePressureHpa,
} = require("./profile-access");

const EFFECTIVE_INFLOW_MIN_CAPE_JKG = 100;

const EFFECTIVE_INFLOW_MIN_CIN_JKG = -250;

const EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG = EFFECTIVE_INFLOW_MIN_CAPE_JKG;

const EFFECTIVE_PARCEL_SOURCE_DEPTH_HPA = 300;

const EFFECTIVE_PARCEL_SOURCE_STEP_HPA = 25;

const EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M = 4000;

const PARCEL_INTEGRATION_STEP_HPA = 1;

const PARCEL_CIN_TOP_PRESSURE_HPA = 500;

const MIXED_LAYER_PARCEL_DEPTH_HPA = 100;

const DERIVED_DIAGNOSTIC_PROFILE_LEVELS = Object.freeze([1000, 925, 850, 700, 500, 300]);

function calculateEffectiveLayerBunkersMotionFromRows(scratch, rowCount, layer) {
  const baseAglM = Number(layer?.baseAglM);
  const muElAglM = Number(layer?.muElAglM);
  const muCapeJkg = Number(layer?.muCapeJkg);
  if (
    !Number.isFinite(baseAglM) ||
    !Number.isFinite(muElAglM) ||
    !Number.isFinite(muCapeJkg) ||
    muCapeJkg <= EFFECTIVE_INFLOW_MIN_CAPE_JKG ||
    muElAglM <= baseAglM + 500
  ) {
    return null;
  }
  const topAglM = baseAglM + (muElAglM - baseAglM) * 0.65;
  if (topAglM < 3000 || baseAglM > topAglM) {
    return null;
  }
  return calculateBunkersMotionFromRows(scratch, rowCount, {
    meanBottomAglM: baseAglM,
    meanTopAglM: topAglM,
    shearBottomAglM: baseAglM,
    shearTopAglM: topAglM,
    pressureWeightedMean: true,
  });
}

function buildSurfaceThermoDerivedGrids(decoded, available, cellCount) {
  const needsLcl = available.has("surfaceBasedLclHeight") || available.has("significantTornadoParameter");
  const needsThetaE = available.has("surfaceThetaE");
  const out = {};
  if (!needsLcl && !needsThetaE) {
    return out;
  }
  const directLcl = decoded?.surfaceBasedLclHeightDirect || null;
  const tempKGrid = decoded?.temperature2m;
  if (!tempKGrid && !directLcl) {
    return out;
  }
  const lcl = needsLcl ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const thetaE = needsThetaE ? new Float32Array(cellCount).fill(Number.NaN) : null;
  // Grid resolution is hoisted out of the dense cell loop; the per-cell reads
  // below replicate gridValue/surfaceDewpointK/surfacePressureHpa exactly
  // (Number conversion, finite normalization, direct-value preference, and
  // the hypsometric fallback chain are unchanged).
  const profileSurfaceHeightGrid = decoded?.profileSurfaceHeight || null;
  const directDewpointGrid = decoded?.dewpoint2m || null;
  const surfaceTempGrid = resolveProfileGrid(decoded, "TMP", "surface");
  const surfaceRhGrid = resolveProfileGrid(decoded, "RH", "surface");
  const derivedSurfacePressureGrid = decoded?.derivedSurfacePressure || null;
  const pressureMslGrid = decoded?.pressureMsl || null;
  const surfaceHgtGrid = resolveProfileGrid(decoded, "HGT", "surface");
  for (let index = 0; index < cellCount; index += 1) {
    const directLclValue = directLcl ? Number(directLcl[index]) : Number.NaN;
    const surfaceHeightRaw = profileSurfaceHeightGrid ? Number(profileSurfaceHeightGrid[index]) : Number.NaN;
    if (lcl && Number.isFinite(directLclValue) && Number.isFinite(surfaceHeightRaw)) {
      lcl[index] = Math.max(0, directLclValue - surfaceHeightRaw);
    }
    const tempK = Number(tempKGrid?.[index]);
    let dewpointK = Number.NaN;
    const needsDewpoint = Boolean(thetaE || (lcl && !Number.isFinite(lcl[index])));
    if (needsDewpoint) {
      dewpointK = directDewpointGrid ? Number(directDewpointGrid[index]) : Number.NaN;
      if (!Number.isFinite(dewpointK)) {
        const surfaceTempRaw = surfaceTempGrid ? Number(surfaceTempGrid[index]) : Number.NaN;
        const surfaceRhRaw = surfaceRhGrid ? Number(surfaceRhGrid[index]) : Number.NaN;
        dewpointK = dewpointFromTempRhK(
          Number.isFinite(surfaceTempRaw) ? surfaceTempRaw : Number.NaN,
          Number.isFinite(surfaceRhRaw) ? surfaceRhRaw : Number.NaN,
        );
      }
    }
    if (lcl && !Number.isFinite(lcl[index]) && Number.isFinite(tempK) && Number.isFinite(dewpointK)) {
      const lclTempK = dewpointK <= tempK + 0.5 ? boltonLclTemperatureK(tempK, dewpointK) : Number.NaN;
      if (Number.isFinite(lclTempK)) {
        lcl[index] = Math.max(0, (tempK - lclTempK) / 0.0098);
      }
    }
    if (thetaE) {
      let pressureHpa;
      const directPressureRaw = derivedSurfacePressureGrid ? Number(derivedSurfacePressureGrid[index]) : Number.NaN;
      if (Number.isFinite(directPressureRaw) && directPressureRaw > 1000) {
        pressureHpa = directPressureRaw / 100;
      } else {
        const mslpRaw = pressureMslGrid ? Number(pressureMslGrid[index]) : Number.NaN;
        if (!Number.isFinite(mslpRaw)) {
          pressureHpa = Number.NaN;
        } else {
          const mslpHpa = mslpRaw / 100;
          const elevationRaw = surfaceHgtGrid ? Number(surfaceHgtGrid[index]) : Number.NaN;
          const surfaceTempRaw = surfaceTempGrid ? Number(surfaceTempGrid[index]) : Number.NaN;
          const elevation = Number.isFinite(elevationRaw) ? elevationRaw : Number.NaN;
          const surfaceTempK = Number.isFinite(surfaceTempRaw) ? surfaceTempRaw : Number.NaN;
          if (!Number.isFinite(elevation) || !Number.isFinite(surfaceTempK) || elevation <= 1) {
            pressureHpa = mslpHpa;
          } else {
            const lapseRate = 0.0065;
            const denominator = surfaceTempK + lapseRate * elevation;
            pressureHpa =
              !Number.isFinite(denominator) || denominator <= 0
                ? mslpHpa
                : mslpHpa * Math.pow(1 - (lapseRate * elevation) / denominator, 5.257);
          }
        }
      }
      const value = boltonThetaE(tempK, dewpointK, pressureHpa);
      if (Number.isFinite(value)) {
        thetaE[index] = value;
      }
    }
  }
  if (lcl) {
    out.surfaceBasedLclHeight = lcl;
  }
  if (thetaE) {
    out.surfaceThetaE = thetaE;
  }
  return out;
}

function buildProfileDerivedGrids(decoded, available, cellCount, profile = null) {
  const needsLapse = available.has("lapseRate0to3km");
  const needsLegacyScp = available.has("supercellCompositeParameter");
  const needsEffectiveLayerScp = available.has("effectiveLayerSupercellCompositeParameter");
  const needsEffectiveLayerStp = available.has("effectiveLayerSignificantTornadoParameter");
  const needsBulk = available.has("bulkShear0to6km") || available.has("significantTornadoParameter");
  const needsEffective = available.has("effectiveBulkShear") || needsLegacyScp;
  const needsEffectiveDiagnostics = needsEffectiveLayerScp || needsEffectiveLayerStp;
  const needsDcape = available.has("dcape");
  const out = {};
  if (!needsLapse && !needsBulk && !needsEffective && !needsEffectiveDiagnostics && !needsDcape) {
    return out;
  }
  const lapse = needsLapse ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const bulk = needsBulk ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const effective = needsEffective ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const dcape = needsDcape ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const effectiveLayerScp = needsEffectiveLayerScp ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const effectiveLayerStp = needsEffectiveLayerStp ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const sources = buildDerivedProfileSources(decoded);
  const effectiveCandidateCells = needsEffectiveDiagnostics
    ? buildEffectiveDiagnosticsCandidateCells(decoded, cellCount, {
        needsScp: needsEffectiveLayerScp,
        needsStp: needsEffectiveLayerStp,
        profile,
      })
    : null;
  const effectiveSources = effectiveCandidateCells ? buildEffectiveLayerProfileSources(decoded) : null;
  const effectiveScratch = effectiveSources ? createEffectiveDiagnosticsScratch(effectiveSources.length) : null;
  const dcapeScratch = needsDcape
    ? {
        heights: new Float64Array(sources.length + 1),
        temps: new Float64Array(sources.length + 1),
        pressures: new Float64Array(sources.length + 1),
        dewpoints: new Float64Array(sources.length + 1),
        thetaE: new Float64Array(sources.length + 1),
      }
    : null;
  const surfaceHeightGrid = resolveProfileGrid(decoded, "HGT", "surface");
  const surfaceTempGrid = resolveProfileGrid(decoded, "TMP", "surface");
  const surfaceUGrid = resolveProfileGrid(decoded, "UGRD", "surface");
  const surfaceVGrid = resolveProfileGrid(decoded, "VGRD", "surface");
  const derivedSurfacePressureGrid = needsDcape ? decoded?.derivedSurfacePressure || null : null;
  const pressureMslGrid = needsDcape ? decoded?.pressureMsl || null : null;

  for (let index = 0; index < cellCount; index += 1) {
    const wantsEffectiveDiagnosticsCandidate = Boolean(
      needsEffectiveDiagnostics &&
      effectiveScratch &&
      isEffectiveDiagnosticsCandidateCell(effectiveCandidateCells, index),
    );
    const wantsEffectiveCandidate = Boolean(effective && isEffectiveLayerCellActive(decoded, index));
    if (!needsLapse && !needsBulk && !needsDcape && !wantsEffectiveCandidate && !wantsEffectiveDiagnosticsCandidate) {
      continue;
    }

    const elevation = gridValue(surfaceHeightGrid, index);
    if (!Number.isFinite(elevation)) {
      continue;
    }

    const surfaceTemp = needsLapse || needsDcape ? gridValue(surfaceTempGrid, index) : Number.NaN;
    let surfaceU = Number.NaN;
    let surfaceV = Number.NaN;
    let hasSurfaceWind = false;
    if (needsBulk || wantsEffectiveCandidate || wantsEffectiveDiagnosticsCandidate) {
      surfaceU = gridValue(surfaceUGrid, index);
      surfaceV = gridValue(surfaceVGrid, index);
      hasSurfaceWind = Number.isFinite(surfaceU) && Number.isFinite(surfaceV);
    }
    const wantsLapse = Boolean(lapse && Number.isFinite(surfaceTemp));
    const wantsBulk = Boolean(bulk && hasSurfaceWind);
    const wantsDcape = Boolean(dcape && Number.isFinite(surfaceTemp));
    const wantsEffective = Boolean(wantsEffectiveCandidate && hasSurfaceWind);
    const wantsEffectiveDiagnostics = Boolean(wantsEffectiveDiagnosticsCandidate && hasSurfaceWind);
    if (!wantsLapse && !wantsBulk && !wantsDcape && !wantsEffective && !wantsEffectiveDiagnostics) {
      continue;
    }

    if (wantsLapse) {
      const temp3km = interpolateDerivedProfileColumn(sources, "TMP", index, 3000, elevation, surfaceTemp);
      if (Number.isFinite(surfaceTemp) && Number.isFinite(temp3km)) {
        lapse[index] = (surfaceTemp - temp3km) / 3;
      }
    }
    if (wantsBulk) {
      const shear = calculateBulkShearKtFromSources(sources, index, elevation, 6000, surfaceU, surfaceV);
      if (Number.isFinite(shear)) {
        bulk[index] = shear;
      }
    }
    if (wantsEffective) {
      const shear = Number.isFinite(bulk?.[index])
        ? bulk[index]
        : calculateBulkShearKtFromSources(sources, index, elevation, 6000, surfaceU, surfaceV);
      if (Number.isFinite(shear)) {
        effective[index] = shear;
      }
    }
    if (wantsDcape) {
      // Surface pressure via the same direct-pressure-then-hypsometric-MSLP
      // chain as surfacePressureHpa, with the grids hoisted out of the loop.
      let cellSurfacePressure;
      const directPressureRaw = derivedSurfacePressureGrid ? Number(derivedSurfacePressureGrid[index]) : Number.NaN;
      if (Number.isFinite(directPressureRaw) && directPressureRaw > 1000) {
        cellSurfacePressure = directPressureRaw / 100;
      } else {
        const mslpRaw = pressureMslGrid ? Number(pressureMslGrid[index]) : Number.NaN;
        if (!Number.isFinite(mslpRaw)) {
          cellSurfacePressure = Number.NaN;
        } else {
          const mslpHpa = mslpRaw / 100;
          if (!Number.isFinite(elevation) || !Number.isFinite(surfaceTemp) || elevation <= 1) {
            cellSurfacePressure = mslpHpa;
          } else {
            const lapseRate = 0.0065;
            const denominator = surfaceTemp + lapseRate * elevation;
            cellSurfacePressure =
              !Number.isFinite(denominator) || denominator <= 0
                ? mslpHpa
                : mslpHpa * Math.pow(1 - (lapseRate * elevation) / denominator, 5.257);
          }
        }
      }
      const value = calculateReducedProfileDcapeFromSources(
        sources,
        index,
        elevation,
        surfaceTemp,
        cellSurfacePressure,
        dcapeScratch,
      );
      if (Number.isFinite(value)) {
        dcape[index] = Math.max(0, value);
      }
    }
    if (wantsEffectiveDiagnostics) {
      const products = calculateEffectiveLayerProductsFromSources(
        decoded,
        effectiveSources,
        index,
        elevation,
        surfaceU,
        surfaceV,
        effectiveScratch,
        {
          needsScp: needsEffectiveLayerScp,
          needsStp: needsEffectiveLayerStp,
        },
      );
      if (products) {
        if (effectiveLayerScp && Number.isFinite(products.scp)) {
          effectiveLayerScp[index] = products.scp;
        }
        if (effectiveLayerStp && Number.isFinite(products.stp)) {
          effectiveLayerStp[index] = products.stp;
        }
      }
    }
  }
  if (lapse) {
    out.lapseRate0to3km = lapse;
  }
  if (bulk) {
    out.bulkShear0to6km = bulk;
  }
  if (effective) {
    out.effectiveBulkShear = effective;
  }
  if (dcape) {
    out.dcape = dcape;
  }
  if (effectiveLayerScp) {
    out.effectiveLayerSupercellCompositeParameter = effectiveLayerScp;
  }
  if (effectiveLayerStp) {
    out.effectiveLayerSignificantTornadoParameter = effectiveLayerStp;
  }
  return out;
}

function buildEffectiveDiagnosticsCandidateCells(decoded, cellCount, options = {}) {
  const count = Math.max(0, Math.round(Number(cellCount) || 0));
  if (count <= 0) {
    return null;
  }
  const needsScp = Boolean(options?.needsScp);
  const needsStp = Boolean(options?.needsStp);
  const profile = options?.profile || null;
  const mask = new Uint8Array(count);
  let candidateCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (!hasEffectiveDiagnosticsCandidateCape(decoded, index, { needsScp, needsStp })) {
      continue;
    }
    mask[index] = 1;
    candidateCount += 1;
  }
  if (profile) {
    profile.effectiveDiagnosticsCandidateCount = candidateCount;
  }
  return candidateCount > 0 ? { mask, count: candidateCount } : null;
}

function hasEffectiveDiagnosticsCandidateCape(decoded, index, options = {}) {
  const mucape = gridValue(decoded?.mucape, index);
  const mlcape = gridValue(decoded?.mlcape, index);
  const sbcape = gridValue(decoded?.sbcape, index);
  if (options?.needsScp && mucape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG) {
    return true;
  }
  if (!options?.needsStp) {
    return false;
  }
  const mlcin = gridValue(decoded?.mlcin, index);
  if (!(mlcape > 0) || (Number.isFinite(mlcin) && mlcin <= -200)) {
    return false;
  }
  return (
    mucape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG ||
    mlcape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG ||
    sbcape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG
  );
}

function isEffectiveDiagnosticsCandidateCell(candidateCells, index) {
  if (!candidateCells) {
    return false;
  }
  return candidateCells.mask?.[index] === 1;
}

function createEffectiveDiagnosticsScratch(sourceCount) {
  const size = Math.max(4, sourceCount + 2);
  return {
    heights: new Float64Array(size),
    u: new Float64Array(size),
    v: new Float64Array(size),
    pressure: new Float64Array(size),
    temp: new Float64Array(size),
    dewpoint: new Float64Array(size),
    segmentValid: new Uint8Array(size),
    segmentDz: new Float64Array(size),
    segmentMidHeight: new Float64Array(size),
    segmentMidPressure: new Float64Array(size),
    segmentEnvVirtualTemp: new Float64Array(size),
  };
}

function calculateEffectiveLayerProductsFromSources(
  decoded,
  sources,
  index,
  elevation,
  surfaceU,
  surfaceV,
  scratch,
  options = {},
) {
  const rowCount = fillEffectiveDiagnosticsProfileRows(decoded, sources, index, elevation, surfaceU, surfaceV, scratch);
  if (rowCount < 3) {
    return null;
  }
  const layer = calculateEffectiveParcelLayerFromRows(scratch, rowCount);
  if (!layer || !Number.isFinite(layer.baseAglM) || !Number.isFinite(layer.topAglM)) {
    return null;
  }
  const needsScp = Boolean(options?.needsScp);
  const needsStp = Boolean(options?.needsStp);
  const products = {};
  const baseAglM = layer.baseAglM;
  const canShortCircuitStp = needsStp && !needsScp && baseAglM > 0;
  if (canShortCircuitStp) {
    products.stp = 0;
    return products;
  }

  const topAglM = Math.max(layer.topAglM, baseAglM + 1);
  const windAtBase = interpolateProfileWindRows(scratch, rowCount, baseAglM);
  if (!windAtBase) {
    return null;
  }
  const muElAglM = Number.isFinite(layer.muElAglM) ? layer.muElAglM : topAglM;
  const ebwdTopAglM = baseAglM + 0.5 * Math.max(0, muElAglM - baseAglM);
  const windAtEbwdTop = interpolateProfileWindRows(scratch, rowCount, ebwdTopAglM);
  const stormMotion =
    calculateEffectiveLayerBunkersMotionFromRows(scratch, rowCount, layer)?.right ||
    calculateBunkersMotionFromRows(scratch, rowCount)?.right;
  if (!windAtEbwdTop || !stormMotion) {
    return null;
  }
  const esrh = calculateStormRelativeHelicityFromRows(scratch, rowCount, baseAglM, topAglM, stormMotion);
  const ebwdKt = Math.hypot(windAtEbwdTop.u - windAtBase.u, windAtEbwdTop.v - windAtBase.v) * MPS_TO_KT;
  if (!Number.isFinite(esrh) || !Number.isFinite(ebwdKt)) {
    return null;
  }
  if (needsScp) {
    products.scp = calculateEffectiveLayerScpValue(decoded, index, layer, esrh, ebwdKt);
  }
  if (needsStp) {
    products.stp =
      baseAglM > 0
        ? 0
        : calculateEffectiveLayerStpValue(
            decoded,
            index,
            esrh,
            ebwdKt,
            calculateMixedLayerLclMFromRows(scratch, rowCount),
          );
  }
  return products;
}

function fillEffectiveDiagnosticsProfileRows(decoded, sources, index, elevation, surfaceU, surfaceV, scratch) {
  const heights = scratch.heights;
  const us = scratch.u;
  const vs = scratch.v;
  const pressures = scratch.pressure;
  const temps = scratch.temp;
  const dewpoints = scratch.dewpoint;
  let rowCount = 0;

  if (Number.isFinite(surfaceU) && Number.isFinite(surfaceV)) {
    const surfacePressure = surfacePressureHpa(decoded, index);
    const surfaceTemp = profileValue(decoded, "TMP", "surface", index);
    const surfaceDewpoint = surfaceDewpointK(decoded, index);
    heights[rowCount] = 0;
    us[rowCount] = surfaceU;
    vs[rowCount] = surfaceV;
    pressures[rowCount] = Number.isFinite(surfacePressure) ? surfacePressure : Number.NaN;
    temps[rowCount] = Number.isFinite(surfaceTemp) ? surfaceTemp : Number.NaN;
    dewpoints[rowCount] = Number.isFinite(surfaceDewpoint) ? surfaceDewpoint : Number.NaN;
    rowCount += 1;
  }

  for (const source of sources) {
    const hgtGrid = source.hgt;
    const heightMsl = hgtGrid ? hgtGrid[index] : Number.NaN;
    const heightAglM = heightMsl - elevation;
    if (!Number.isFinite(heightAglM) || heightAglM <= 0 || heightAglM > 16000) {
      continue;
    }
    const uGrid = source.u;
    const vGrid = source.v;
    const u = uGrid ? uGrid[index] : Number.NaN;
    const v = vGrid ? vGrid[index] : Number.NaN;
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      continue;
    }
    const tmpGrid = source.tmp;
    const rhGrid = source.rh;
    const tempK = tmpGrid ? tmpGrid[index] : Number.NaN;
    const rh = rhGrid ? rhGrid[index] : Number.NaN;
    const dewpointK = dewpointFromTempRhK(tempK, rh);
    const levelHpa = Number(source.level);
    heights[rowCount] = heightAglM;
    us[rowCount] = u;
    vs[rowCount] = v;
    pressures[rowCount] = Number.isFinite(levelHpa) ? levelHpa : Number.NaN;
    temps[rowCount] = Number.isFinite(tempK) ? tempK : Number.NaN;
    dewpoints[rowCount] = Number.isFinite(dewpointK) ? dewpointK : Number.NaN;
    rowCount += 1;
  }
  sortEffectiveDiagnosticsRowsByHeight(scratch, rowCount);
  return rowCount;
}

function calculateEffectiveParcelLayerFromRows(scratch, rowCount, options = {}) {
  const surfacePressure = scratch.pressure[0];
  if (!Number.isFinite(surfacePressure)) {
    return null;
  }
  prepareEffectiveParcelSegments(scratch, rowCount);
  const pressureFloor = surfacePressure - EFFECTIVE_PARCEL_SOURCE_DEPTH_HPA;
  const sourceStepHpa = Number.isFinite(options?.sourceStepHpa)
    ? Math.max(0, Number(options.sourceStepHpa))
    : EFFECTIVE_PARCEL_SOURCE_STEP_HPA;
  let inLayer = false;
  let baseAglM = Number.NaN;
  let topAglM = Number.NaN;
  let lastEffectiveAglM = Number.NaN;
  let muCapeJkg = Number.NEGATIVE_INFINITY;
  let muCinJkg = Number.NaN;
  let muElAglM = Number.NaN;
  let lastScannedSourcePressure = Number.NaN;
  const rowHeights = scratch.heights;
  const rowPressures = scratch.pressure;
  const rowTemps = scratch.temp;
  const rowDewpoints = scratch.dewpoint;

  for (let row = 0; row < rowCount; row += 1) {
    const height = rowHeights[row];
    const pressure = rowPressures[row];
    const temp = rowTemps[row];
    const dewpoint = rowDewpoints[row];
    if (
      !Number.isFinite(height) ||
      height > EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M ||
      !Number.isFinite(pressure) ||
      !Number.isFinite(temp) ||
      !Number.isFinite(dewpoint)
    ) {
      continue;
    }
    if (pressure < pressureFloor) {
      break;
    }
    if (
      sourceStepHpa > 0 &&
      Number.isFinite(lastScannedSourcePressure) &&
      lastScannedSourcePressure - pressure < sourceStepHpa
    ) {
      continue;
    }
    lastScannedSourcePressure = pressure;
    const parcel = calculateParcelCapeCinFromRows(scratch, rowCount, row, options);
    if (!parcel || !Number.isFinite(parcel.capeJkg) || !Number.isFinite(parcel.cinJkg)) {
      if (inLayer) {
        break;
      }
      continue;
    }
    if (parcel.capeJkg > muCapeJkg) {
      muCapeJkg = parcel.capeJkg;
      muCinJkg = parcel.cinJkg;
      muElAglM = parcel.elAglM;
    }
    const effective = parcel.capeJkg >= EFFECTIVE_INFLOW_MIN_CAPE_JKG && parcel.cinJkg >= EFFECTIVE_INFLOW_MIN_CIN_JKG;
    if (effective) {
      if (!inLayer) {
        baseAglM = Math.max(0, height);
        inLayer = true;
      }
      lastEffectiveAglM = Math.max(baseAglM, height);
    } else if (inLayer) {
      topAglM = Math.max(baseAglM, lastEffectiveAglM);
      break;
    }
  }
  if (inLayer && !Number.isFinite(topAglM) && Number.isFinite(lastEffectiveAglM)) {
    topAglM = Math.max(baseAglM, lastEffectiveAglM);
  }
  if (!Number.isFinite(baseAglM) || !Number.isFinite(topAglM) || !Number.isFinite(muCapeJkg)) {
    return null;
  }
  return {
    baseAglM,
    topAglM,
    muCapeJkg: Math.max(0, muCapeJkg),
    muCinJkg,
    muElAglM,
  };
}

function prepareEffectiveParcelSegments(scratch, rowCount) {
  if (!scratch?.segmentValid) {
    return;
  }
  const heights = scratch.heights;
  const pressures = scratch.pressure;
  const temps = scratch.temp;
  const dewpoints = scratch.dewpoint;
  const segmentValid = scratch.segmentValid;
  const segmentDz = scratch.segmentDz;
  const segmentMidHeight = scratch.segmentMidHeight;
  const segmentMidPressure = scratch.segmentMidPressure;
  const segmentEnvVirtualTemp = scratch.segmentEnvVirtualTemp;
  segmentValid.fill(0, 0, Math.max(0, rowCount));
  let lowerHeight = heights[0];
  let lowerPressure = pressures[0];
  let lowerTemp = temps[0];
  let lowerDewpoint = dewpoints[0];
  let lowerLogPressure = Math.log(lowerPressure);
  for (let row = 1; row < rowCount; row += 1) {
    const upperHeight = heights[row];
    const upperPressure = pressures[row];
    const upperTemp = temps[row];
    const upperDewpoint = dewpoints[row];
    const upperLogPressure = Math.log(upperPressure);
    const dz = upperHeight - lowerHeight;
    const usable =
      Number.isFinite(dz) &&
      dz > 1 &&
      Number.isFinite(lowerPressure) &&
      Number.isFinite(upperPressure) &&
      lowerPressure > 0 &&
      upperPressure > 0 &&
      Number.isFinite(lowerTemp) &&
      Number.isFinite(upperTemp) &&
      Number.isFinite(lowerDewpoint) &&
      Number.isFinite(upperDewpoint);
    if (usable) {
      const midPressure = Math.exp((lowerLogPressure + upperLogPressure) / 2);
      const envTemp = (lowerTemp + upperTemp) / 2;
      const envDewpoint = (lowerDewpoint + upperDewpoint) / 2;
      // Inlined mixingRatioFromDewpointK + virtualTemperatureK with identical
      // operation order, guards, and NaN propagation.
      let envVirtualTemp = Number.NaN;
      if (Number.isFinite(midPressure) && midPressure > 0) {
        const envDewpointC = envDewpoint - 273.15;
        const vapor = 6.112 * Math.exp((17.67 * envDewpointC) / (envDewpointC + 243.5));
        if (Number.isFinite(vapor) && vapor > 0 && vapor < midPressure) {
          const ratio = (EPSILON * vapor) / (midPressure - vapor);
          envVirtualTemp = (envTemp * (1 + ratio / EPSILON)) / (1 + ratio);
        }
      }
      if (Number.isFinite(midPressure) && Number.isFinite(envVirtualTemp)) {
        segmentValid[row] = 1;
        segmentDz[row] = dz;
        segmentMidHeight[row] = (lowerHeight + upperHeight) / 2;
        segmentMidPressure[row] = midPressure;
        segmentEnvVirtualTemp[row] = envVirtualTemp;
      }
    }
    lowerHeight = upperHeight;
    lowerPressure = upperPressure;
    lowerTemp = upperTemp;
    lowerDewpoint = upperDewpoint;
    lowerLogPressure = upperLogPressure;
  }
}

function calculateParcelCapeCinFromRows(scratch, rowCount, sourceRow, options = {}) {
  const source = {
    pressureHpa: scratch.pressure[sourceRow],
    heightAglM: scratch.heights[sourceRow],
    tempK: scratch.temp[sourceRow],
    dewpointK: scratch.dewpoint[sourceRow],
  };
  return options?.pressureStep
    ? calculatePressureStepParcelCapeCinForSource(scratch, rowCount, source)
    : calculateParcelCapeCinForSource(scratch, rowCount, source);
}

function calculateParcelCapeCinForSource(scratch, rowCount, source) {
  return calculateSegmentParcelCapeCinForSource(scratch, rowCount, source);
}

function calculateSegmentParcelCapeCinForSource(scratch, rowCount, source) {
  const sourcePressure = Number(source?.pressureHpa);
  const sourceHeight = Number(source?.heightAglM);
  const sourceTemp = Number(source?.tempK);
  const rawSourceDewpoint = Number(source?.dewpointK);
  const sourceDewpoint = Math.min(rawSourceDewpoint, sourceTemp);
  if (
    !Number.isFinite(sourcePressure) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(sourceTemp) ||
    !Number.isFinite(rawSourceDewpoint) ||
    sourcePressure <= 100 ||
    rawSourceDewpoint > sourceTemp + 0.5
  ) {
    return null;
  }
  const lclTempK = boltonLclTemperatureK(sourceTemp, sourceDewpoint);
  const sourceVaporPressure = vaporPressureHpa(sourceDewpoint);
  if (!Number.isFinite(lclTempK) || !Number.isFinite(sourceVaporPressure)) {
    return null;
  }
  const lclPressure = sourcePressure * Math.pow(lclTempK / sourceTemp, CP_OVER_RD);
  const sourceMixingRatio = mixingRatioFromVaporPressureHpa(sourceVaporPressure, sourcePressure);
  if (!Number.isFinite(lclPressure) || !Number.isFinite(sourceMixingRatio)) {
    return null;
  }
  const lclHeight = sourceHeight + Math.max(0, sourceTemp - lclTempK) / DRY_ADIABATIC_LAPSE_K_M;
  const segmentValid = scratch.segmentValid;
  const segmentMidHeight = scratch.segmentMidHeight;
  const segmentMidPressure = scratch.segmentMidPressure;
  const segmentEnvVirtualTemp = scratch.segmentEnvVirtualTemp;
  const segmentDz = scratch.segmentDz;
  const rowHeights = scratch.heights;
  // Constant-per-origin factors of virtualTemperatureK(parcelTemp, sourceMixingRatio);
  // applying them per segment keeps the identical (T * numer) / denom operation order.
  const dryVirtualNumer = 1 + sourceMixingRatio / EPSILON;
  const dryVirtualDenom = 1 + sourceMixingRatio;

  let cape = 0;
  let cin = 0;
  let positiveSeen = false;
  let previousBuoyancy = Number.NaN;
  let previousHeight = sourceHeight;
  let lfcAglM = Number.NaN;
  let elAglM = Number.NaN;
  let saturatedParcelTemp = lclTempK;
  let saturatedParcelHeight = lclHeight;
  for (let row = 1; row < rowCount; row += 1) {
    if (!segmentValid || !segmentValid[row]) {
      continue;
    }
    const midHeight = segmentMidHeight[row];
    const midPressure = segmentMidPressure[row];
    const envVirtualTemp = segmentEnvVirtualTemp[row];
    const dz = segmentDz[row];
    if (midHeight <= sourceHeight + 1 || midPressure > sourcePressure + 1) {
      continue;
    }
    const belowLclPressure = midPressure >= lclPressure;
    let parcelTemp;
    if (belowLclPressure || midHeight <= lclHeight) {
      parcelTemp = sourceTemp * Math.pow(midPressure / sourcePressure, RD_OVER_CP);
    } else {
      parcelTemp = integrateMoistParcelTemperatureK(saturatedParcelTemp, saturatedParcelHeight, midHeight, midPressure);
      if (Number.isFinite(parcelTemp)) {
        saturatedParcelTemp = parcelTemp;
        saturatedParcelHeight = midHeight;
      }
    }
    let parcelVirtualTemp;
    if (belowLclPressure) {
      parcelVirtualTemp = (parcelTemp * dryVirtualNumer) / dryVirtualDenom;
    } else {
      // Inlined saturationMixingRatioHpa + virtualTemperatureK with identical
      // operation order and NaN propagation.
      const parcelTempC = parcelTemp - 273.15;
      const vapor = 6.112 * Math.exp((17.67 * parcelTempC) / (parcelTempC + 243.5));
      if (Number.isFinite(vapor) && vapor > 0 && vapor < midPressure) {
        const ratio = (EPSILON * vapor) / (midPressure - vapor);
        parcelVirtualTemp = (parcelTemp * (1 + ratio / EPSILON)) / (1 + ratio);
      } else {
        parcelVirtualTemp = Number.NaN;
      }
    }
    if (!Number.isFinite(envVirtualTemp) || !Number.isFinite(parcelVirtualTemp)) {
      continue;
    }
    const buoyancy = (GRAVITY_M_S2 * (parcelVirtualTemp - envVirtualTemp)) / Math.max(180, envVirtualTemp);
    const energy = buoyancy * dz;
    const isAtOrAboveLcl = midHeight >= lclHeight - 1 || midPressure <= lclPressure + 0.1;
    if (Number.isFinite(energy)) {
      if (energy > 0 && isAtOrAboveLcl) {
        if (!positiveSeen) {
          const crossingHeight =
            Number.isFinite(previousBuoyancy) && previousBuoyancy <= 0
              ? previousHeight +
                (midHeight - previousHeight) * clamp01(-previousBuoyancy / Math.max(1e-9, buoyancy - previousBuoyancy))
              : previousHeight < lclHeight
                ? lclHeight
                : midHeight;
          lfcAglM = Math.max(lclHeight, crossingHeight);
        }
        cape += energy;
        positiveSeen = true;
        elAglM = rowHeights[row];
      } else if (!positiveSeen && energy < 0) {
        cin += energy;
      } else if (Number.isFinite(previousBuoyancy) && previousBuoyancy > 0 && buoyancy <= 0) {
        const fraction = previousBuoyancy / Math.max(1e-9, previousBuoyancy - buoyancy);
        elAglM = previousHeight + (midHeight - previousHeight) * clamp01(fraction);
      }
    }
    previousBuoyancy = buoyancy;
    previousHeight = midHeight;
  }
  return {
    capeJkg: Math.max(0, cape),
    cinJkg: Math.min(0, cin),
    lclAglM: Number.isFinite(lclHeight) ? lclHeight : Number.NaN,
    lfcAglM: Number.isFinite(lfcAglM) ? lfcAglM : Number.NaN,
    elAglM: Number.isFinite(elAglM) ? elAglM : Number.NaN,
  };
}

function calculatePressureStepParcelCapeCinForSource(scratch, rowCount, source) {
  const sourcePressure = Number(source?.pressureHpa);
  const sourceHeight = Number(source?.heightAglM);
  const sourceTemp = Number(source?.tempK);
  const rawSourceDewpoint = Number(source?.dewpointK);
  const sourceDewpoint = Math.min(rawSourceDewpoint, sourceTemp);
  if (
    !Number.isFinite(sourcePressure) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(sourceTemp) ||
    !Number.isFinite(rawSourceDewpoint) ||
    sourcePressure <= 100 ||
    rawSourceDewpoint > sourceTemp + 0.5
  ) {
    return null;
  }
  const lclTempK = boltonLclTemperatureK(sourceTemp, sourceDewpoint);
  const sourceVaporPressure = vaporPressureHpa(sourceDewpoint);
  if (!Number.isFinite(lclTempK) || !Number.isFinite(sourceVaporPressure)) {
    return null;
  }
  const lclPressure = sourcePressure * Math.pow(lclTempK / sourceTemp, CP_OVER_RD);
  const sourceMixingRatio = mixingRatioFromVaporPressureHpa(sourceVaporPressure, sourcePressure);
  if (!Number.isFinite(lclPressure) || !Number.isFinite(sourceMixingRatio)) {
    return null;
  }
  const lclHeight = calculateLclHeightForSourceRows(scratch, rowCount, {
    pressureHpa: sourcePressure,
    heightAglM: sourceHeight,
    tempK: sourceTemp,
    lclTempK,
    lclPressure,
  });
  const samples = buildParcelBuoyancySamples(scratch, rowCount, {
    sourcePressure,
    sourceTemp,
    sourceMixingRatio,
    lclPressure,
    lclTempK,
  });
  let cape = 0;
  let cape0to3km = 0;
  let cin = 0;
  let positiveSeen = false;
  let lfcAglM = Number.NaN;
  let elAglM = Number.NaN;
  for (let index = 1; index < samples.length; index += 1) {
    const lower = samples[index - 1];
    const upper = samples[index];
    const dz = upper.heightAglM - lower.heightAglM;
    if (!Number.isFinite(dz) || dz <= 0) {
      continue;
    }
    if (!Number.isFinite(lower.buoyancyMps2) || !Number.isFinite(upper.buoyancyMps2)) {
      continue;
    }
    const energy = ((lower.buoyancyMps2 + upper.buoyancyMps2) / 2) * dz;
    const isAtOrAboveLcl = upper.pressureHpa <= lclPressure + 1e-6 || upper.heightAglM >= lclHeight - 1;
    if (Number.isFinite(energy)) {
      if (energy > 0 && isAtOrAboveLcl) {
        if (!positiveSeen) {
          const crossingHeight = interpolateBuoyancyZeroHeight(lower, upper, lclHeight);
          lfcAglM = Math.max(lclHeight, crossingHeight);
        }
        cape += energy;
        // SHARPpy-style b3km: positive buoyancy accumulated below 3 km AGL,
        // with the straddling segment clipped at 3 km by linear buoyancy
        // interpolation.
        if (upper.heightAglM <= 3000) {
          cape0to3km += energy;
        } else if (lower.heightAglM < 3000) {
          const fraction = (3000 - lower.heightAglM) / dz;
          const buoyancyAt3km = lower.buoyancyMps2 + (upper.buoyancyMps2 - lower.buoyancyMps2) * fraction;
          const subEnergy = ((lower.buoyancyMps2 + buoyancyAt3km) / 2) * (3000 - lower.heightAglM);
          if (Number.isFinite(subEnergy) && subEnergy > 0) {
            cape0to3km += subEnergy;
          }
        }
        positiveSeen = true;
      } else if (!positiveSeen && energy < 0 && upper.pressureHpa >= PARCEL_CIN_TOP_PRESSURE_HPA) {
        cin += energy;
      }
      if (
        positiveSeen &&
        Number.isFinite(lower.buoyancyMps2) &&
        Number.isFinite(upper.buoyancyMps2) &&
        lower.buoyancyMps2 > 0 &&
        upper.buoyancyMps2 <= 0
      ) {
        elAglM = interpolateBuoyancyZeroHeight(lower, upper, lclHeight);
      }
    }
  }
  return {
    capeJkg: Math.max(0, cape),
    cape0to3kmJkg: Math.max(0, cape0to3km),
    cinJkg: Math.min(0, cin),
    lclAglM: Number.isFinite(lclHeight) ? lclHeight : Number.NaN,
    lfcAglM: Number.isFinite(lfcAglM) ? lfcAglM : Number.NaN,
    elAglM: Number.isFinite(elAglM) ? elAglM : Number.NaN,
  };
}

function calculateLclHeightForSourceRows(scratch, rowCount, source) {
  const lclPressure = Number(source?.lclPressure);
  const lclTempK = Number(source?.lclTempK);
  const sourceHeight = Number(source?.heightAglM);
  const sourceTemp = Number(source?.tempK);
  const interpolated = interpolateProfileThermoAtPressureRows(scratch, rowCount, lclPressure);
  if (interpolated && Number.isFinite(interpolated.heightAglM)) {
    return Math.max(0, interpolated.heightAglM);
  }
  return Number.isFinite(sourceHeight) && Number.isFinite(sourceTemp) && Number.isFinite(lclTempK)
    ? Math.max(0, sourceHeight + Math.max(0, sourceTemp - lclTempK) / DRY_ADIABATIC_LAPSE_K_M)
    : Number.NaN;
}

function buildParcelBuoyancySamples(scratch, rowCount, parcel) {
  const sourcePressure = Number(parcel?.sourcePressure);
  const sourceTemp = Number(parcel?.sourceTemp);
  const sourceMixingRatio = Number(parcel?.sourceMixingRatio);
  const lclPressure = Number(parcel?.lclPressure);
  const lclTempK = Number(parcel?.lclTempK);
  const topPressure = findTopPressureHpaForScratch(scratch, rowCount);
  if (
    !Number.isFinite(sourcePressure) ||
    !Number.isFinite(sourceTemp) ||
    !Number.isFinite(sourceMixingRatio) ||
    !Number.isFinite(lclPressure) ||
    !Number.isFinite(lclTempK) ||
    !Number.isFinite(topPressure) ||
    topPressure >= sourcePressure
  ) {
    return [];
  }
  const pressures = [];
  const addPressure = (pressure) => {
    const value = Number(pressure);
    if (!Number.isFinite(value) || value > sourcePressure + 1e-6 || value < topPressure - 1e-6) {
      return;
    }
    if (pressures.some((existing) => Math.abs(existing - value) < 1e-6)) {
      return;
    }
    pressures.push(value);
  };
  addPressure(sourcePressure);
  addPressure(topPressure);
  addPressure(lclPressure);
  for (
    let pressure = Math.floor(sourcePressure);
    pressure >= Math.ceil(topPressure);
    pressure -= PARCEL_INTEGRATION_STEP_HPA
  ) {
    addPressure(pressure);
  }
  for (let row = 0; row < rowCount; row += 1) {
    addPressure(scratch.pressure[row]);
  }
  pressures.sort((left, right) => right - left);

  let saturatedPressure = lclPressure;
  let saturatedTemp = lclTempK;
  const samples = [];
  for (const pressure of pressures) {
    const env = interpolateProfileThermoAtPressureRows(scratch, rowCount, pressure);
    if (!env || !Number.isFinite(env.heightAglM) || !Number.isFinite(env.tempK) || !Number.isFinite(env.dewpointK)) {
      continue;
    }
    const envMixingRatio = mixingRatioFromDewpointK(Math.min(env.dewpointK, env.tempK), pressure);
    const envVirtualTemp = virtualTemperatureK(env.tempK, envMixingRatio);
    let parcelTemp;
    let parcelMixingRatio;
    if (pressure >= lclPressure) {
      parcelTemp = sourceTemp * Math.pow(pressure / sourcePressure, RD_OVER_CP);
      parcelMixingRatio = sourceMixingRatio;
    } else {
      parcelTemp = moistLiftTemperatureK(saturatedPressure, saturatedTemp, pressure);
      if (Number.isFinite(parcelTemp)) {
        saturatedPressure = pressure;
        saturatedTemp = parcelTemp;
      }
      parcelMixingRatio = saturationMixingRatioHpa(parcelTemp, pressure);
    }
    const parcelVirtualTemp = virtualTemperatureK(parcelTemp, parcelMixingRatio);
    if (!Number.isFinite(envVirtualTemp) || !Number.isFinite(parcelVirtualTemp)) {
      continue;
    }
    samples.push({
      pressureHpa: pressure,
      heightAglM: env.heightAglM,
      buoyancyMps2: (GRAVITY_M_S2 * (parcelVirtualTemp - envVirtualTemp)) / Math.max(180, envVirtualTemp),
    });
  }
  return samples.sort((left, right) => left.heightAglM - right.heightAglM);
}

function findTopPressureHpaForScratch(scratch, rowCount) {
  let topPressure = Number.POSITIVE_INFINITY;
  for (let row = 0; row < rowCount; row += 1) {
    const pressure = Number(scratch?.pressure?.[row]);
    if (Number.isFinite(pressure) && pressure > 0 && pressure < topPressure) {
      topPressure = pressure;
    }
  }
  return Number.isFinite(topPressure) ? topPressure : Number.NaN;
}

function interpolateBuoyancyZeroHeight(lower, upper, fallbackHeight) {
  const lowerBuoyancy = Number(lower?.buoyancyMps2);
  const upperBuoyancy = Number(upper?.buoyancyMps2);
  const lowerHeight = Number(lower?.heightAglM);
  const upperHeight = Number(upper?.heightAglM);
  if (
    Number.isFinite(lowerBuoyancy) &&
    Number.isFinite(upperBuoyancy) &&
    Number.isFinite(lowerHeight) &&
    Number.isFinite(upperHeight) &&
    Math.abs(upperBuoyancy - lowerBuoyancy) > 1e-9
  ) {
    return lowerHeight + (upperHeight - lowerHeight) * clamp01(-lowerBuoyancy / (upperBuoyancy - lowerBuoyancy));
  }
  return Number.isFinite(fallbackHeight) ? fallbackHeight : Number.isFinite(upperHeight) ? upperHeight : Number.NaN;
}

function buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount) {
  const mixedLayer = calculateMixedLayerParcelPropertiesFromScratch(scratch, rowCount);
  if (!mixedLayer) {
    return null;
  }
  return {
    source: "mixedLayer",
    pressureHpa: mixedLayer.pressureHpa,
    heightAglM: 0,
    heightMslM: Number.NaN,
    tempK: mixedLayer.tempK,
    dewpointK: mixedLayer.dewpointK,
    uMps: scratch.u?.[0],
    vMps: scratch.v?.[0],
  };
}

function calculateMixedLayerParcelPropertiesFromScratch(scratch, rowCount, depthHpa = MIXED_LAYER_PARCEL_DEPTH_HPA) {
  const surfacePressure = Number(scratch.pressure?.[0]);
  if (!Number.isFinite(surfacePressure) || surfacePressure <= depthHpa + 100 || rowCount < 2) {
    return null;
  }
  const topPressure = surfacePressure - depthHpa;
  // Reused scratch sample arrays replace per-call sample objects and the
  // comparator sort; dedupe predicate, accepted order, and summation order are
  // unchanged (accepted pressures are pairwise >=1e-6 apart, so descending
  // order is unique).
  let samplePs = scratch.mixedLayerSampleP;
  if (!samplePs || samplePs.length < rowCount + 2) {
    samplePs = new Float64Array(rowCount + 2);
    scratch.mixedLayerSampleP = samplePs;
    scratch.mixedLayerSampleTheta = new Float64Array(rowCount + 2);
    scratch.mixedLayerSampleRatio = new Float64Array(rowCount + 2);
  }
  const sampleThetas = scratch.mixedLayerSampleTheta;
  const sampleRatios = scratch.mixedLayerSampleRatio;
  let sampleCount = 0;
  const addSample = (sample) => {
    if (
      !sample ||
      !Number.isFinite(sample.pressureHpa) ||
      !Number.isFinite(sample.thetaK) ||
      !Number.isFinite(sample.mixingRatio)
    ) {
      return;
    }
    if (sample.pressureHpa > surfacePressure + 1e-6 || sample.pressureHpa < topPressure - 1e-6) {
      return;
    }
    for (let existing = 0; existing < sampleCount; existing += 1) {
      if (Math.abs(samplePs[existing] - sample.pressureHpa) < 1e-6) {
        return;
      }
    }
    samplePs[sampleCount] = sample.pressureHpa;
    sampleThetas[sampleCount] = sample.thetaK;
    sampleRatios[sampleCount] = sample.mixingRatio;
    sampleCount += 1;
  };
  const surfaceSample = mixedLayerSampleAtPressure(scratch, rowCount, surfacePressure);
  const topSample = mixedLayerSampleAtPressure(scratch, rowCount, topPressure);
  if (!surfaceSample || !topSample) {
    return null;
  }
  const rowPressures = scratch.pressure;
  const rowTemps = scratch.temp;
  const rowDewpoints = scratch.dewpoint;
  addSample(surfaceSample);
  for (let row = 0; row < rowCount; row += 1) {
    const pressure = rowPressures[row];
    if (!Number.isFinite(pressure) || pressure >= surfacePressure || pressure <= topPressure) {
      continue;
    }
    addSample(mixedLayerSampleFromValues(pressure, rowTemps[row], rowDewpoints[row]));
  }
  addSample(topSample);
  for (let index = 1; index < sampleCount; index += 1) {
    const pressure = samplePs[index];
    const theta = sampleThetas[index];
    const ratio = sampleRatios[index];
    let cursor = index - 1;
    while (cursor >= 0 && samplePs[cursor] < pressure) {
      samplePs[cursor + 1] = samplePs[cursor];
      sampleThetas[cursor + 1] = sampleThetas[cursor];
      sampleRatios[cursor + 1] = sampleRatios[cursor];
      cursor -= 1;
    }
    samplePs[cursor + 1] = pressure;
    sampleThetas[cursor + 1] = theta;
    sampleRatios[cursor + 1] = ratio;
  }
  let thetaIntegral = 0;
  let mixingRatioIntegral = 0;
  let totalDp = 0;
  for (let index = 1; index < sampleCount; index += 1) {
    const lowerP = samplePs[index - 1];
    const upperP = samplePs[index];
    const dp = lowerP - upperP;
    if (!Number.isFinite(dp) || dp <= 0) {
      continue;
    }
    const midPressure = (lowerP + upperP) / 2;
    const mid = mixedLayerSampleAtPressure(scratch, rowCount, midPressure);
    if (mid) {
      thetaIntegral += ((sampleThetas[index - 1] + 4 * mid.thetaK + sampleThetas[index]) / 6) * dp;
      mixingRatioIntegral += ((sampleRatios[index - 1] + 4 * mid.mixingRatio + sampleRatios[index]) / 6) * dp;
    } else {
      thetaIntegral += ((sampleThetas[index - 1] + sampleThetas[index]) / 2) * dp;
      mixingRatioIntegral += ((sampleRatios[index - 1] + sampleRatios[index]) / 2) * dp;
    }
    totalDp += dp;
  }
  if (totalDp <= 0) {
    return null;
  }
  const meanTheta = thetaIntegral / totalDp;
  const meanMixingRatio = mixingRatioIntegral / totalDp;
  const parcelTemp = meanTheta * Math.pow(surfacePressure / 1000, RD_OVER_CP);
  const vaporPressure = (meanMixingRatio * surfacePressure) / (EPSILON + meanMixingRatio);
  const parcelDewpoint = dewpointFromVaporPressureHpa(vaporPressure);
  if (!Number.isFinite(parcelTemp) || !Number.isFinite(parcelDewpoint)) {
    return null;
  }
  return {
    pressureHpa: surfacePressure,
    tempK: parcelTemp,
    dewpointK: parcelDewpoint,
  };
}

function mixedLayerSampleAtPressure(scratch, rowCount, pressureHpa) {
  const sample = interpolateProfileThermoAtPressureRows(scratch, rowCount, pressureHpa);
  if (!sample || !Number.isFinite(sample.tempK) || !Number.isFinite(sample.dewpointK)) {
    return null;
  }
  return mixedLayerSampleFromValues(sample.pressureHpa, sample.tempK, sample.dewpointK);
}

function mixedLayerSampleFromValues(pressureHpa, tempK, dewpointK) {
  const pressure = Number(pressureHpa);
  const temp = Number(tempK);
  const dewpoint = Math.min(Number(dewpointK), temp);
  const mixingRatio = mixingRatioFromDewpointK(dewpoint, pressure);
  const theta = temp * Math.pow(1000 / pressure, RD_OVER_CP);
  if (!Number.isFinite(mixingRatio) || !Number.isFinite(theta)) {
    return null;
  }
  return {
    pressureHpa: pressure,
    thetaK: theta,
    mixingRatio,
  };
}

function calculateParcelLclAglM(source) {
  const sourceHeight = Number(source?.heightAglM);
  const sourceTemp = Number(source?.tempK);
  const sourceDewpoint = Math.min(Number(source?.dewpointK), sourceTemp);
  if (!Number.isFinite(sourceHeight) || !Number.isFinite(sourceTemp) || !Number.isFinite(sourceDewpoint)) {
    return Number.NaN;
  }
  const lclTemp = boltonLclTemperatureK(sourceTemp, sourceDewpoint);
  return Number.isFinite(lclTemp)
    ? Math.max(0, sourceHeight + (sourceTemp - lclTemp) / DRY_ADIABATIC_LAPSE_K_M)
    : Number.NaN;
}

function calculateMixedLayerLclMFromRows(scratch, rowCount) {
  return calculateParcelLclAglM(buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount));
}

function buildDerivedProfileSources(decoded) {
  return DERIVED_DIAGNOSTIC_PROFILE_LEVELS.map((level) => ({
    level,
    hgt: profileDataGrid(decoded, "HGT", level),
    tmp: profileDataGrid(decoded, "TMP", level),
    rh: profileDataGrid(decoded, "RH", level),
    u: profileDataGrid(decoded, "UGRD", level),
    v: profileDataGrid(decoded, "VGRD", level),
  }));
}

function buildEffectiveLayerProfileSources(decoded) {
  return EFFECTIVE_LAYER_PROFILE_LEVELS.map((level) => ({
    level,
    hgt: profileDataGrid(decoded, "HGT", level),
    tmp: profileDataGrid(decoded, "TMP", level),
    rh: profileDataGrid(decoded, "RH", level),
    u: profileDataGrid(decoded, "UGRD", level),
    v: profileDataGrid(decoded, "VGRD", level),
  }));
}

function interpolateDerivedProfileColumn(
  sources,
  variable,
  index,
  aglMeters,
  elevation,
  surfaceValue = Number.NaN,
  options = {},
) {
  const targetHeight = elevation + aglMeters;
  const requireUpperBracket = options.requireUpperBracket !== false;
  let lowerHeight = Number.NaN;
  let lowerValue = Number.NaN;
  if (Number.isFinite(surfaceValue)) {
    if (elevation === targetHeight) {
      return surfaceValue;
    }
    if (elevation < targetHeight) {
      lowerHeight = elevation;
      lowerValue = surfaceValue;
    }
  }
  for (const source of sources) {
    const currentHeight = gridValue(source.hgt, index);
    const currentValue = derivedProfileSourceValue(source, variable, index);
    if (!Number.isFinite(currentHeight) || currentHeight <= elevation || !Number.isFinite(currentValue)) {
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
      return currentValue;
    }
    const t = (targetHeight - lowerHeight) / Math.max(1e-9, currentHeight - lowerHeight);
    return lowerValue + (currentValue - lowerValue) * Math.max(0, Math.min(1, t));
  }
  return requireUpperBracket ? Number.NaN : Number.isFinite(lowerValue) ? lowerValue : Number.NaN;
}

function derivedProfileSourceValue(source, variable, index) {
  if (variable === "TMP") {
    return gridValue(source.tmp, index);
  }
  if (variable === "RH") {
    return gridValue(source.rh, index);
  }
  if (variable === "UGRD") {
    return gridValue(source.u, index);
  }
  if (variable === "VGRD") {
    return gridValue(source.v, index);
  }
  return Number.NaN;
}

function interpolateDerivedProfileWindColumn(sources, index, aglMeters, elevation, surfaceU, surfaceV) {
  // Fused u/v interpolation: one pass over the sources reads each height grid
  // once while applying interpolateDerivedProfileColumn's state machine to the
  // u and v components independently (per-component finite checks, exact-match
  // and bracket handling, and the default require-upper-bracket fallback are
  // unchanged), so both results are identical to two separate scans.
  const targetHeight = elevation + aglMeters;
  let uResolved = false;
  let uResult = Number.NaN;
  let uLowerHeight = Number.NaN;
  let uLowerValue = Number.NaN;
  let vResolved = false;
  let vResult = Number.NaN;
  let vLowerHeight = Number.NaN;
  let vLowerValue = Number.NaN;
  if (Number.isFinite(surfaceU)) {
    if (elevation === targetHeight) {
      uResolved = true;
      uResult = surfaceU;
    } else if (elevation < targetHeight) {
      uLowerHeight = elevation;
      uLowerValue = surfaceU;
    }
  }
  if (Number.isFinite(surfaceV)) {
    if (elevation === targetHeight) {
      vResolved = true;
      vResult = surfaceV;
    } else if (elevation < targetHeight) {
      vLowerHeight = elevation;
      vLowerValue = surfaceV;
    }
  }
  for (const source of sources) {
    if (uResolved && vResolved) {
      break;
    }
    const currentHeight = gridValue(source.hgt, index);
    if (!Number.isFinite(currentHeight) || currentHeight <= elevation) {
      continue;
    }
    if (!uResolved) {
      const currentValue = gridValue(source.u, index);
      if (Number.isFinite(currentValue)) {
        if (currentHeight === targetHeight) {
          uResolved = true;
          uResult = currentValue;
        } else if (currentHeight < targetHeight) {
          uLowerHeight = currentHeight;
          uLowerValue = currentValue;
        } else if (!Number.isFinite(uLowerHeight) || !Number.isFinite(uLowerValue)) {
          uResolved = true;
          uResult = currentValue;
        } else {
          const t = (targetHeight - uLowerHeight) / Math.max(1e-9, currentHeight - uLowerHeight);
          uResolved = true;
          uResult = uLowerValue + (currentValue - uLowerValue) * Math.max(0, Math.min(1, t));
        }
      }
    }
    if (!vResolved) {
      const currentValue = gridValue(source.v, index);
      if (Number.isFinite(currentValue)) {
        if (currentHeight === targetHeight) {
          vResolved = true;
          vResult = currentValue;
        } else if (currentHeight < targetHeight) {
          vLowerHeight = currentHeight;
          vLowerValue = currentValue;
        } else if (!Number.isFinite(vLowerHeight) || !Number.isFinite(vLowerValue)) {
          vResolved = true;
          vResult = currentValue;
        } else {
          const t = (targetHeight - vLowerHeight) / Math.max(1e-9, currentHeight - vLowerHeight);
          vResolved = true;
          vResult = vLowerValue + (currentValue - vLowerValue) * Math.max(0, Math.min(1, t));
        }
      }
    }
  }
  return { u: uResult, v: vResult };
}

function calculateBulkShearKtFromSources(sources, index, elevation, topAglM, surfaceU, surfaceV) {
  if (!Number.isFinite(elevation) || !Number.isFinite(surfaceU) || !Number.isFinite(surfaceV)) {
    return Number.NaN;
  }
  const top = interpolateDerivedProfileWindColumn(sources, index, topAglM, elevation, surfaceU, surfaceV);
  if (!Number.isFinite(top.u) || !Number.isFinite(top.v)) {
    return Number.NaN;
  }
  return Math.hypot(top.u - surfaceU, top.v - surfaceV) * MPS_TO_KT;
}

function isEffectiveLayerCellActive(decoded, index) {
  return (
    effectiveLayerCandidateActive(decoded?.mlcape, decoded?.mlcin, index) ||
    effectiveLayerCandidateActive(decoded?.sbcape, decoded?.sbcin, index)
  );
}

function effectiveLayerCandidateActive(capeGrid, cinGrid, index) {
  const cape = Number(capeGrid?.[index]);
  const cin = Number(cinGrid?.[index]);
  return (
    Number.isFinite(cape) &&
    cape >= EFFECTIVE_INFLOW_MIN_CAPE_JKG &&
    Number.isFinite(cin) &&
    cin >= EFFECTIVE_INFLOW_MIN_CIN_JKG
  );
}

function calculateEffectiveLayerScpValue(decoded, index, effectiveLayer, esrh, ebwdKt) {
  const mucape = decoded?.mucape ? gridValue(decoded.mucape, index) : Number(effectiveLayer?.muCapeJkg);
  const capeTerm = Math.max(0, mucape) / 1000;
  const srhTerm = Math.max(0, Number(esrh)) / 50;
  const ebwdMs = Math.max(0, Number(ebwdKt)) / MPS_TO_KT;
  const shearTerm = ebwdMs < 10 ? 0 : clamp(ebwdMs / 20, 0, 1);
  const scp = capeTerm * srhTerm * shearTerm;
  return Number.isFinite(scp) ? Math.max(0, scp) : Number.NaN;
}

function calculateEffectiveLayerStpValue(decoded, index, esrh, ebwdKt, mixedLayerLclM) {
  const mlcape = gridValue(decoded?.mlcape, index);
  const mlcin = gridValue(decoded?.mlcin, index);
  const capeTerm = Math.max(0, mlcape) / 1500;
  const lclTerm = clamp((2000 - Number(mixedLayerLclM)) / 1000, 0, 1);
  const srhTerm = Math.max(0, Number(esrh)) / 150;
  const ebwdMs = Math.max(0, Number(ebwdKt)) / MPS_TO_KT;
  const shearTerm = ebwdMs < 12.5 ? 0 : clamp(ebwdMs / 20, 0, 1.5);
  const cinTerm = mlcin > -50 ? 1 : clamp((mlcin + 200) / 150, 0, 1);
  const stp = capeTerm * lclTerm * srhTerm * shearTerm * cinTerm;
  return Number.isFinite(stp) ? Math.max(0, stp) : Number.NaN;
}

const DCAPE_SOURCE_DEPTH_HPA = 400;
const DCAPE_SOURCE_LAYER_DEPTH_HPA = 100;

// Reduced-profile downdraft CAPE (reduced-profile-dcape-v4).
// SHARPpy/NSHARP source-selection parity (params.dcape) on the reduced
// diagnostic profile:
// - Source: every pressure-level knot within the lowest 400 mb above ground
//   is a candidate layer bottom; the candidate score is the mean theta-e of
//   the 100 mb layer extending upward from it (knot-trapezoid integral on
//   log-pressure interpolated temperature/dewpoint; the point-sounding path
//   uses dense 1 hPa steps instead). The parcel source is the midpoint of
//   the minimum-mean-theta-e layer (candidate pressure minus 50 mb).
// - Parcel start: pressure-aware Normand wet-bulb of the log-pressure
//   interpolated temperature/dewpoint at the source pressure.
// - Descent: pseudoadiabatic (saturated) warming via the same fixed-step
//   moist-lapse Euler integrator used for parcel ascent, advanced segment by
//   segment at each segment's mid pressure.
// - Energy: net buoyancy integral g * (Tenv - Tparcel) / Tenv over the
//   descent path using plain (not virtual) temperature, clamped to
//   [0, 4000] J/kg. The v3 point-min-theta-e/100-mb-mean-parcel variant
//   understated DCAPE against SHARPpy on dry-slot soundings and was replaced.
function calculateReducedProfileDcapeFromSources(sources, index, elevation, surfaceTemp, surfacePressure, scratch) {
  if (
    !Number.isFinite(surfaceTemp) ||
    !Number.isFinite(surfacePressure) ||
    surfacePressure <= 100 ||
    !scratch?.heights ||
    !scratch?.temps ||
    !scratch?.pressures ||
    !scratch?.dewpoints ||
    !scratch?.thetaE
  ) {
    return Number.NaN;
  }
  const surfaceHeight = Number.isFinite(elevation) ? elevation : 0;
  const pressureFloor = surfacePressure - DCAPE_SOURCE_DEPTH_HPA;

  // Knots: surface row plus above-ground pressure-level rows, sorted by
  // ascending height (descending pressure). Surface dewpoint/theta-e stay
  // unset; the surface row is not a candidate layer bottom on the reduced
  // profile because the moist boundary layer is never the DCAPE source.
  const knotHeights = scratch.heights;
  const knotTemps = scratch.temps;
  const knotPressures = scratch.pressures;
  const knotDewpoints = scratch.dewpoints;
  const knotThetaE = scratch.thetaE;
  let knotCount = 0;
  knotHeights[knotCount] = surfaceHeight;
  knotTemps[knotCount] = surfaceTemp;
  knotPressures[knotCount] = surfacePressure;
  knotDewpoints[knotCount] = Number.NaN;
  knotThetaE[knotCount] = Number.NaN;
  knotCount += 1;
  for (const source of sources) {
    const level = Number(source.level);
    if (!Number.isFinite(level) || level >= surfacePressure) {
      continue;
    }
    const height = source.hgt ? source.hgt[index] : Number.NaN;
    const tempK = source.tmp ? source.tmp[index] : Number.NaN;
    const rh = source.rh ? source.rh[index] : Number.NaN;
    if (!Number.isFinite(height) || height <= surfaceHeight || !Number.isFinite(tempK) || !Number.isFinite(rh)) {
      continue;
    }
    const dewpointK = dewpointFromTempRhK(tempK, rh);
    if (!Number.isFinite(dewpointK)) {
      continue;
    }
    knotHeights[knotCount] = height;
    knotTemps[knotCount] = tempK;
    knotPressures[knotCount] = level;
    knotDewpoints[knotCount] = dewpointK;
    knotThetaE[knotCount] = boltonThetaE(tempK, dewpointK, level);
    knotCount += 1;
  }
  if (knotCount < 3) {
    return Number.NaN;
  }
  sortDcapeKnotsByHeight(knotHeights, knotTemps, knotPressures, knotDewpoints, knotThetaE, knotCount);

  const interpolateKnotThermo = (pressureHpa) => {
    for (let row = 1; row < knotCount; row += 1) {
      const lowerPressure = knotPressures[row - 1];
      const upperPressure = knotPressures[row];
      if (!(lowerPressure >= pressureHpa && upperPressure <= pressureHpa)) {
        continue;
      }
      if (row === 1 && !Number.isFinite(knotDewpoints[0])) {
        // Surface segment without a surface dewpoint: only usable when the
        // target sits at the upper knot.
        if (Math.abs(upperPressure - pressureHpa) > 1e-6) {
          return null;
        }
        return { tempK: knotTemps[row], dewpointK: knotDewpoints[row], heightM: knotHeights[row] };
      }
      const t = clamp(
        (Math.log(pressureHpa) - Math.log(lowerPressure)) / (Math.log(upperPressure) - Math.log(lowerPressure)),
        0,
        1,
      );
      return {
        tempK: knotTemps[row - 1] + (knotTemps[row] - knotTemps[row - 1]) * t,
        dewpointK: knotDewpoints[row - 1] + (knotDewpoints[row] - knotDewpoints[row - 1]) * t,
        heightM: knotHeights[row - 1] + (knotHeights[row] - knotHeights[row - 1]) * t,
      };
    }
    return null;
  };

  const thetaEAtPressure = (pressureHpa) => {
    for (let row = 0; row < knotCount; row += 1) {
      if (Math.abs(knotPressures[row] - pressureHpa) < 1e-6) {
        return knotThetaE[row];
      }
    }
    const sample = interpolateKnotThermo(pressureHpa);
    return sample ? boltonThetaE(sample.tempK, sample.dewpointK, pressureHpa) : Number.NaN;
  };

  // Candidate layer bottoms: above-ground knots in the lowest 400 mb. The
  // layer-mean theta-e is the pressure-weighted trapezoid over the layer's
  // endpoints and interior knots.
  let bestMeanThetaE = Number.POSITIVE_INFINITY;
  let sourcePressure = Number.NaN;
  for (let row = 1; row < knotCount; row += 1) {
    const bottomPressure = knotPressures[row];
    if (!Number.isFinite(bottomPressure) || bottomPressure < pressureFloor || bottomPressure > surfacePressure) {
      continue;
    }
    const topPressure = bottomPressure - DCAPE_SOURCE_LAYER_DEPTH_HPA;
    let previousPressure = bottomPressure;
    let previousThetaE = knotThetaE[row];
    let weighted = 0;
    let usable = Number.isFinite(previousThetaE);
    for (
      let upperRow = row + 1;
      usable && upperRow < knotCount && knotPressures[upperRow] > topPressure;
      upperRow += 1
    ) {
      const pressure = knotPressures[upperRow];
      const thetaE = knotThetaE[upperRow];
      if (!Number.isFinite(thetaE)) {
        usable = false;
        break;
      }
      weighted += ((previousThetaE + thetaE) / 2) * (previousPressure - pressure);
      previousPressure = pressure;
      previousThetaE = thetaE;
    }
    if (!usable) {
      continue;
    }
    const topThetaE = thetaEAtPressure(topPressure);
    if (!Number.isFinite(topThetaE)) {
      continue;
    }
    weighted += ((previousThetaE + topThetaE) / 2) * (previousPressure - topPressure);
    const meanThetaE = weighted / DCAPE_SOURCE_LAYER_DEPTH_HPA;
    if (Number.isFinite(meanThetaE) && meanThetaE < bestMeanThetaE) {
      bestMeanThetaE = meanThetaE;
      sourcePressure = bottomPressure - DCAPE_SOURCE_LAYER_DEPTH_HPA / 2;
    }
  }
  if (!Number.isFinite(sourcePressure)) {
    return Number.NaN;
  }

  const source = interpolateKnotThermo(sourcePressure);
  if (!source || !Number.isFinite(source.heightM)) {
    return Number.NaN;
  }
  const sourceDewpointK = Math.min(source.dewpointK, source.tempK);
  const sourceWetBulbC = wetBulbTemperatureCAtPressure(source.tempK, sourceDewpointK, sourcePressure);
  if (!Number.isFinite(sourceWetBulbC)) {
    return Number.NaN;
  }

  // Descend from the source midpoint to the surface, knot by knot.
  let parcelTempK = sourceWetBulbC + 273.15;
  let parcelHeight = source.heightM;
  let parcelPressure = sourcePressure;
  let envTempK = source.tempK;
  let energy = 0;
  for (let row = knotCount - 1; row >= 0; row -= 1) {
    if (!(knotPressures[row] > sourcePressure)) {
      continue;
    }
    const nextHeight = knotHeights[row];
    const nextEnvTempK = knotTemps[row];
    const dz = parcelHeight - nextHeight;
    if (!Number.isFinite(dz) || dz <= 1 || !Number.isFinite(nextEnvTempK)) {
      continue;
    }
    const midPressure = (parcelPressure + knotPressures[row]) / 2;
    const advanced = integrateMoistParcelDescentK(parcelTempK, parcelHeight, nextHeight, midPressure);
    const nextParcelTempK = Number.isFinite(advanced) ? advanced : parcelTempK;
    const deficitUpper = (GRAVITY_M_S2 * (envTempK - parcelTempK)) / Math.max(180, envTempK);
    const deficitLower = (GRAVITY_M_S2 * (nextEnvTempK - nextParcelTempK)) / Math.max(180, nextEnvTempK);
    const segment = ((deficitUpper + deficitLower) / 2) * dz;
    if (Number.isFinite(segment)) {
      energy += segment;
    }
    parcelTempK = nextParcelTempK;
    parcelHeight = nextHeight;
    parcelPressure = knotPressures[row];
    envTempK = nextEnvTempK;
  }
  return Number.isFinite(energy) ? Math.min(4000, Math.max(0, energy)) : Number.NaN;
}

function sortDcapeKnotsByHeight(heights, temps, pressures, dewpoints, thetaE, count) {
  for (let index = 1; index < count; index += 1) {
    const height = heights[index];
    const temp = temps[index];
    const pressure = pressures[index];
    const dewpoint = dewpoints[index];
    const knotThetaE = thetaE[index];
    let cursor = index - 1;
    while (cursor >= 0 && heights[cursor] > height) {
      heights[cursor + 1] = heights[cursor];
      temps[cursor + 1] = temps[cursor];
      pressures[cursor + 1] = pressures[cursor];
      dewpoints[cursor + 1] = dewpoints[cursor];
      thetaE[cursor + 1] = thetaE[cursor];
      cursor -= 1;
    }
    heights[cursor + 1] = height;
    temps[cursor + 1] = temp;
    pressures[cursor + 1] = pressure;
    dewpoints[cursor + 1] = dewpoint;
    thetaE[cursor + 1] = knotThetaE;
  }
}

function sortPairedRowsByHeight(heights, temps, count) {
  for (let index = 1; index < count; index += 1) {
    const height = heights[index];
    const temp = temps[index];
    let cursor = index - 1;
    while (cursor >= 0 && heights[cursor] > height) {
      heights[cursor + 1] = heights[cursor];
      temps[cursor + 1] = temps[cursor];
      cursor -= 1;
    }
    heights[cursor + 1] = height;
    temps[cursor + 1] = temp;
  }
}

module.exports = {
  DERIVED_DIAGNOSTIC_PROFILE_LEVELS,
  EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG,
  EFFECTIVE_INFLOW_MIN_CAPE_JKG,
  EFFECTIVE_INFLOW_MIN_CIN_JKG,
  EFFECTIVE_PARCEL_SOURCE_DEPTH_HPA,
  EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M,
  EFFECTIVE_PARCEL_SOURCE_STEP_HPA,
  MIXED_LAYER_PARCEL_DEPTH_HPA,
  PARCEL_CIN_TOP_PRESSURE_HPA,
  PARCEL_INTEGRATION_STEP_HPA,
  buildDerivedProfileSources,
  buildEffectiveDiagnosticsCandidateCells,
  buildEffectiveLayerProfileSources,
  buildMixedLayerPointSoundingSourceFromScratch,
  buildParcelBuoyancySamples,
  buildProfileDerivedGrids,
  buildSurfaceThermoDerivedGrids,
  calculateBulkShearKtFromSources,
  calculateEffectiveLayerBunkersMotionFromRows,
  calculateEffectiveLayerProductsFromSources,
  calculateEffectiveLayerScpValue,
  calculateEffectiveLayerStpValue,
  calculateEffectiveParcelLayerFromRows,
  calculateLclHeightForSourceRows,
  calculateMixedLayerLclMFromRows,
  calculateMixedLayerParcelPropertiesFromScratch,
  calculateParcelCapeCinForSource,
  calculateParcelCapeCinFromRows,
  calculateParcelLclAglM,
  calculatePressureStepParcelCapeCinForSource,
  calculateReducedProfileDcapeFromSources,
  calculateSegmentParcelCapeCinForSource,
  createEffectiveDiagnosticsScratch,
  derivedProfileSourceValue,
  effectiveLayerCandidateActive,
  fillEffectiveDiagnosticsProfileRows,
  findTopPressureHpaForScratch,
  hasEffectiveDiagnosticsCandidateCape,
  interpolateBuoyancyZeroHeight,
  interpolateDerivedProfileColumn,
  interpolateDerivedProfileWindColumn,
  isEffectiveDiagnosticsCandidateCell,
  isEffectiveLayerCellActive,
  mixedLayerSampleAtPressure,
  mixedLayerSampleFromValues,
  prepareEffectiveParcelSegments,
  sortPairedRowsByHeight,
};
