"use strict";

const {
  CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY,
  EFFECTIVE_LAYER_PROFILE_LEVELS,
  EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY,
} = require("../noaa-nam-parameter-catalog");
const { MPS_TO_KT, clamp, clamp01 } = require("./util");
const { derivedSlabRequested, getParcelKernel } = require("./parcel-kernel");
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

// Test-facing engagement telemetry for the sparse effective-diagnostics loop
// in buildProfileDerivedGrids (runs/cells). Module-level rather than the
// render profile so it can never leak into finalized render profiles (the
// render-profile-whitelist contract); production never reads it.
const effectiveDiagnosticsSparseLoopStats = { runs: 0, cells: 0 };

const EFFECTIVE_PARCEL_SOURCE_DEPTH_HPA = 300;

const EFFECTIVE_PARCEL_SOURCE_STEP_HPA = 25;

const EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M = 4000;

const PARCEL_INTEGRATION_STEP_HPA = 1;

const PARCEL_CIN_TOP_PRESSURE_HPA = 500;

const MIXED_LAYER_PARCEL_DEPTH_HPA = 100;

const DERIVED_DIAGNOSTIC_PROFILE_LEVELS = Object.freeze([1000, 925, 850, 700, 500, 300]);

// Version token for the profile-derived grid disk cache. Bump whenever ANY
// formula, constant, threshold, level set, integration step, or gating in
// the buildProfileDerivedGrids pipeline (including thermo.js and
// profile-wind.js dependencies) changes output values; cached grids are
// reused verbatim under the same token.
const DERIVED_PROFILE_METHODOLOGY_VERSION = "derived-profile-grids-v1";

// The catalog availability keys that influence buildProfileDerivedGrids'
// needs* flags. Its output key set is a pure function of the intersection
// of these with selection.availableParameters, which is why the derived
// grid cache keys on exactly that intersection.
const PROFILE_DERIVED_AVAILABILITY_KEYS = Object.freeze([
  "lapseRate0to3km",
  "supercellCompositeParameter",
  "effectiveLayerSupercellCompositeParameter",
  "effectiveLayerSignificantTornadoParameter",
  "bulkShear0to6km",
  "significantTornadoParameter",
  "effectiveBulkShear",
  "dcape",
  EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY,
  CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY,
]);

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
  const needsEffectiveLayerStp100mb = available.has(EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY);
  const needsBulk = available.has("bulkShear0to6km") || available.has("significantTornadoParameter");
  const needsEffective = available.has("effectiveBulkShear") || needsLegacyScp;
  const needsEffectiveDiagnostics = needsEffectiveLayerScp || needsEffectiveLayerStp || needsEffectiveLayerStp100mb;
  const needsDcape = available.has("dcape");
  const needsDcape21LevelCam = available.has(CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY);
  const out = {};
  if (
    !needsLapse &&
    !needsBulk &&
    !needsEffective &&
    !needsEffectiveDiagnostics &&
    !needsDcape &&
    !needsDcape21LevelCam
  ) {
    return out;
  }
  const lapse = needsLapse ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const bulk = needsBulk ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const effective = needsEffective ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const dcape = needsDcape ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const dcape21LevelCam = needsDcape21LevelCam ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const effectiveLayerScp = needsEffectiveLayerScp ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const effectiveLayerStp = needsEffectiveLayerStp ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const effectiveLayerStp100mb = needsEffectiveLayerStp100mb ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const sources = buildDerivedProfileSources(decoded);
  const effectiveCandidateCells = needsEffectiveDiagnostics
    ? buildEffectiveDiagnosticsCandidateCells(decoded, cellCount, {
        needsScp: needsEffectiveLayerScp,
        needsStp: needsEffectiveLayerStp,
        needsStp100mb: needsEffectiveLayerStp100mb,
        profile,
      })
    : null;
  // Both prototypes consume the same 21-row profile already used by CAM
  // effective diagnostics. Build one source view so enabling both never
  // duplicates decoded grids or profile objects.
  const effectiveSources =
    effectiveCandidateCells || needsDcape21LevelCam ? buildEffectiveLayerProfileSources(decoded) : null;
  const effectiveScratch = effectiveCandidateCells
    ? createEffectiveDiagnosticsScratch(effectiveSources?.length || EFFECTIVE_LAYER_PROFILE_LEVELS.length, {
        useKernel: true,
      })
    : null;
  const dcapeScratch =
    needsDcape || needsDcape21LevelCam
      ? {
          heights: new Float64Array(Math.max(sources.length, effectiveSources?.length || 0) + 1),
          temps: new Float64Array(Math.max(sources.length, effectiveSources?.length || 0) + 1),
          pressures: new Float64Array(Math.max(sources.length, effectiveSources?.length || 0) + 1),
          dewpoints: new Float64Array(Math.max(sources.length, effectiveSources?.length || 0) + 1),
          thetaE: new Float64Array(Math.max(sources.length, effectiveSources?.length || 0) + 1),
        }
      : null;
  // The f32 kernel DCAPE port is used only under the wasm-f32 variant so
  // MODELVIEW_PARCEL_KERNEL=wasm|js reverts every numeric deviation at once.
  const dcapeKernelCandidate = needsDcape || needsDcape21LevelCam ? getParcelKernel() : null;
  const dcapeKernel =
    dcapeKernelCandidate?.variant === "wasm-f32" && dcapeKernelCandidate.dcape ? dcapeKernelCandidate : null;
  const surfaceHeightGrid = resolveProfileGrid(decoded, "HGT", "surface");
  const surfaceTempGrid = resolveProfileGrid(decoded, "TMP", "surface");
  const surfaceUGrid = resolveProfileGrid(decoded, "UGRD", "surface");
  const surfaceVGrid = resolveProfileGrid(decoded, "VGRD", "surface");
  const derivedSurfacePressureGrid =
    needsDcape || needsDcape21LevelCam ? decoded?.derivedSurfacePressure || null : null;
  const pressureMslGrid = needsDcape || needsDcape21LevelCam ? decoded?.pressureMsl || null : null;

  // Stage G2: when the wasm-f32 kernel exports the slab pipeline and every
  // referenced grid is a full-length Float32Array, the entire cell loop
  // below runs inside the kernel over slab-resident copies of the grids
  // (raw f32 bits — in-kernel reads see exactly what this loop would read).
  // Any ineligibility falls through to the JS loop unchanged.
  const slabRan = runProfileDerivedGridsViaSlabs({
    decoded,
    cellCount,
    sources,
    effectiveSources,
    effectiveCandidateCells,
    needsLapse,
    needsBulk,
    needsDcape,
    needsDcape21: Boolean(dcape21LevelCam && effectiveSources),
    needsEffective: Boolean(effective),
    needsScp: needsEffectiveLayerScp,
    needsStp: needsEffectiveLayerStp,
    needsStp100mb: needsEffectiveLayerStp100mb,
    outputs: {
      lapse,
      bulk,
      effective,
      dcape,
      dcape21LevelCam,
      effectiveLayerScp,
      effectiveLayerStp,
      effectiveLayerStp100mb,
    },
  });

  // Dense products (lapse, bulk shear, effective bulk shear, DCAPE) keep the
  // full-grid cell loop. Effective severe diagnostics are handled by the
  // sparse candidate-index loop below, so a frame requesting ONLY those
  // diagnostics skips this loop entirely.
  const needsDenseCellLoop = Boolean(needsLapse || needsBulk || needsDcape || needsDcape21LevelCam || effective);
  for (let index = 0; !slabRan && needsDenseCellLoop && index < cellCount; index += 1) {
    const wantsEffectiveCandidate = Boolean(effective && isEffectiveLayerCellActive(decoded, index));
    if (!needsLapse && !needsBulk && !needsDcape && !needsDcape21LevelCam && !wantsEffectiveCandidate) {
      continue;
    }

    const elevation = gridValue(surfaceHeightGrid, index);
    if (!Number.isFinite(elevation)) {
      continue;
    }

    const surfaceTemp =
      needsLapse || needsDcape || needsDcape21LevelCam ? gridValue(surfaceTempGrid, index) : Number.NaN;
    let surfaceU = Number.NaN;
    let surfaceV = Number.NaN;
    let hasSurfaceWind = false;
    if (needsBulk || wantsEffectiveCandidate) {
      surfaceU = gridValue(surfaceUGrid, index);
      surfaceV = gridValue(surfaceVGrid, index);
      hasSurfaceWind = Number.isFinite(surfaceU) && Number.isFinite(surfaceV);
    }
    const wantsLapse = Boolean(lapse && Number.isFinite(surfaceTemp));
    const wantsBulk = Boolean(bulk && hasSurfaceWind);
    const wantsDcape = Boolean((dcape || dcape21LevelCam) && Number.isFinite(surfaceTemp));
    const wantsEffective = Boolean(wantsEffectiveCandidate && hasSurfaceWind);
    if (!wantsLapse && !wantsBulk && !wantsDcape && !wantsEffective) {
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
      if (dcape) {
        // A null kernel result means the port declined (knot capacity), not
        // an invalid cell (NaN); fall back to the JS path in that case.
        let value = dcapeKernel
          ? computeKernelDcape(dcapeKernel, sources, index, elevation, surfaceTemp, cellSurfacePressure)
          : null;
        if (value === null) {
          value = calculateReducedProfileDcapeFromSources(
            sources,
            index,
            elevation,
            surfaceTemp,
            cellSurfacePressure,
            dcapeScratch,
          );
        }
        if (Number.isFinite(value)) {
          dcape[index] = Math.max(0, value);
        }
      }
      if (dcape21LevelCam && effectiveSources) {
        let value = dcapeKernel
          ? computeKernelDcape(dcapeKernel, effectiveSources, index, elevation, surfaceTemp, cellSurfacePressure)
          : null;
        if (value === null) {
          value = calculateReducedProfileDcapeFromSources(
            effectiveSources,
            index,
            elevation,
            surfaceTemp,
            cellSurfacePressure,
            dcapeScratch,
          );
        }
        if (Number.isFinite(value)) {
          dcape21LevelCam[index] = Math.max(0, value);
        }
      }
    }
  }

  // Effective severe diagnostics (effective-layer SCP/STP and the 100-mb
  // prototype) iterate the precomputed candidate index list instead of
  // scanning the grid. Byte-identity with the dense-scan form:
  // - The dense loop entered this branch iff the mask marked the cell AND
  //   the elevation and surface-wind gates passed; the same gates are
  //   re-evaluated here from the same grids, so the visited cell set and the
  //   per-cell work are identical.
  // - The branch reads only the cell's decoded inputs, writes only the
  //   cell's own output slots, and accumulates nothing across cells; the
  //   shared scratch (plain arrays or kernel views) is fully refilled and
  //   consumed per cell, and candidate indices are ascending, so the scratch
  //   sees the identical fill/consume sequence as the dense scan.
  // - Cells outside the mask never entered the branch, so they keep the
  //   pre-filled NaN of the output grids — exactly what the dense scan left.
  if (!slabRan && effectiveScratch && effectiveCandidateCells) {
    const candidateIndices = effectiveCandidateCells.indices;
    effectiveDiagnosticsSparseLoopStats.runs += 1;
    effectiveDiagnosticsSparseLoopStats.cells += candidateIndices.length;
    for (let position = 0; position < candidateIndices.length; position += 1) {
      const index = candidateIndices[position];
      const elevation = gridValue(surfaceHeightGrid, index);
      if (!Number.isFinite(elevation)) {
        continue;
      }
      const surfaceU = gridValue(surfaceUGrid, index);
      const surfaceV = gridValue(surfaceVGrid, index);
      if (!Number.isFinite(surfaceU) || !Number.isFinite(surfaceV)) {
        continue;
      }
      // An opt-in broad prototype mask must not widen the native SCP/STP
      // output footprints. Preserve each production product's established
      // candidate screen while sharing the expensive profile scan.
      // Fused evaluation of hasEffectiveDiagnosticsCandidateCape for the
      // needsScp-only and needsStp-only screens with single grid reads.
      const cellMucape = gridValue(decoded?.mucape, index);
      const needsScpAtCell = needsEffectiveLayerScp && cellMucape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG;
      let needsStpAtCell = false;
      if (needsEffectiveLayerStp) {
        const cellMlcape = gridValue(decoded?.mlcape, index);
        const cellMlcin = gridValue(decoded?.mlcin, index);
        if (cellMlcape > 0 && !(Number.isFinite(cellMlcin) && cellMlcin <= -200)) {
          needsStpAtCell =
            cellMucape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG ||
            cellMlcape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG ||
            gridValue(decoded?.sbcape, index) >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG;
        }
      }
      const products = calculateEffectiveLayerProductsFromSources(
        decoded,
        effectiveSources,
        index,
        elevation,
        surfaceU,
        surfaceV,
        effectiveScratch,
        {
          needsScp: needsScpAtCell,
          needsStp: needsStpAtCell,
          needsStp100mb: needsEffectiveLayerStp100mb,
        },
      );
      if (products) {
        if (effectiveLayerScp && Number.isFinite(products.scp)) {
          effectiveLayerScp[index] = products.scp;
        }
        if (effectiveLayerStp && Number.isFinite(products.stp)) {
          effectiveLayerStp[index] = products.stp;
        }
        if (effectiveLayerStp100mb && Number.isFinite(products.stp100mbReduced)) {
          effectiveLayerStp100mb[index] = products.stp100mbReduced;
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
  if (dcape21LevelCam) {
    out[CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY] = dcape21LevelCam;
  }
  if (effectiveLayerScp) {
    out.effectiveLayerSupercellCompositeParameter = effectiveLayerScp;
  }
  if (effectiveLayerStp) {
    out.effectiveLayerSignificantTornadoParameter = effectiveLayerStp;
  }
  if (effectiveLayerStp100mb) {
    out[EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY] = effectiveLayerStp100mb;
  }
  return out;
}

const DERIVED_SLAB_SOURCE_VARIABLES = Object.freeze(["hgt", "tmp", "rh", "u", "v"]);

// Stage G2 slab plan: fixed aux slots 0-12 (mirroring the kernel's
// SLOT_* constants), level-variable slots assigned from auxSlots upward
// with identity dedupe (the 6-level sources reference the same grid
// objects as their 21-level counterparts). Returns null when ineligible:
// any referenced grid that is not a Float32Array covering cellCount, or
// slot overflow — the JS cell loop remains authoritative in those cases.
function buildDerivedSlabPlan(port, decoded, sources, effectiveSources, cellCount) {
  const grids = [
    resolveProfileGrid(decoded, "HGT", "surface"),
    resolveProfileGrid(decoded, "TMP", "surface"),
    resolveProfileGrid(decoded, "RH", "surface"),
    decoded?.dewpoint2m || null,
    decoded?.derivedSurfacePressure || null,
    decoded?.pressureMsl || null,
    resolveProfileGrid(decoded, "UGRD", "surface"),
    resolveProfileGrid(decoded, "VGRD", "surface"),
    decoded?.mucape || null,
    decoded?.mlcape || null,
    decoded?.mlcin || null,
    decoded?.sbcape || null,
    decoded?.sbcin || null,
  ];
  if (grids.length !== port.auxSlots) {
    return null;
  }
  const slotByGrid = new Map();
  for (let slot = 0; slot < grids.length; slot += 1) {
    const grid = grids[slot];
    if (grid && !slotByGrid.has(grid)) {
      slotByGrid.set(grid, slot);
    }
  }
  const assignSlot = (grid) => {
    if (!grid) {
      return -1;
    }
    const existing = slotByGrid.get(grid);
    if (existing !== undefined) {
      return existing;
    }
    if (grids.length >= port.slots) {
      return null;
    }
    grids.push(grid);
    const slot = grids.length - 1;
    slotByGrid.set(grid, slot);
    return slot;
  };
  const buildSourceTable = (sourceList) => {
    const levels = new Float64Array(64);
    const slots = new Int32Array(320).fill(-1);
    const count = sourceList?.length || 0;
    // Never truncate silently: a future level set beyond the kernel's row
    // capacity (surface row + sources must fit ROWS_CAP=64, and the DCAPE
    // knot inputs share the same 64-slot tables) declines the slab path so
    // the JS loop computes from the full list — the same decline-don't-
    // truncate contract computeKernelDcape established.
    if (count > 62) {
      return null;
    }
    for (let index = 0; index < count; index += 1) {
      const source = sourceList[index];
      levels[index] = Number(source.level);
      for (let variable = 0; variable < DERIVED_SLAB_SOURCE_VARIABLES.length; variable += 1) {
        const slot = assignSlot(source[DERIVED_SLAB_SOURCE_VARIABLES[variable]] || null);
        if (slot === null) {
          return null;
        }
        slots[index * 5 + variable] = slot;
      }
    }
    return { levels, slots, count };
  };
  const table6 = buildSourceTable(sources);
  if (!table6) {
    return null;
  }
  const table21 = buildSourceTable(effectiveSources || []);
  if (!table21) {
    return null;
  }
  for (const grid of grids) {
    if (grid && (!(grid instanceof Float32Array) || grid.length < cellCount)) {
      return null;
    }
  }
  return { grids, table6, table21 };
}

function runProfileDerivedGridsViaSlabs(context) {
  if (!derivedSlabRequested()) {
    return false;
  }
  const kernel = getParcelKernel();
  const port = kernel?.derivedSlab;
  if (!port) {
    return false;
  }
  const {
    decoded,
    cellCount,
    sources,
    effectiveSources,
    effectiveCandidateCells,
    needsLapse,
    needsBulk,
    needsDcape,
    needsDcape21,
    needsEffective,
    needsScp,
    needsStp,
    needsStp100mb,
    outputs,
  } = context;
  if (effectiveCandidateCells && !(effectiveCandidateCells.mask instanceof Uint8Array)) {
    return false;
  }
  const plan = buildDerivedSlabPlan(port, decoded, sources, effectiveSources, cellCount);
  if (!plan) {
    return false;
  }
  port.levels6.set(plan.table6.levels);
  port.slots6.set(plan.table6.slots);
  port.levels21.set(plan.table21.levels);
  port.slots21.set(plan.table21.slots);
  // Copy only slots the requested products can read (the kernel reads
  // nothing else); skipped slots get present=0, so if this needed-set ever
  // under-marks a slot the kernel sees NaN — a loud divergence in the
  // slab-vs-JS suites — rather than stale arena bytes.
  const needsEffectiveDiagnostics = needsScp || needsStp || needsStp100mb;
  const needed = new Uint8Array(plan.grids.length);
  needed[0] = 1; // HGT surface: elevation gate for every product
  if (needsLapse || needsDcape || needsDcape21 || needsEffectiveDiagnostics) {
    needed[1] = 1; // TMP surface: lapse, DCAPE + surface-pressure chain, row fill
  }
  if (needsEffectiveDiagnostics) {
    needed[2] = 1; // RH surface (surface dewpoint fallback)
    needed[3] = 1; // dewpoint2m
    needed[8] = 1; // mucape (SCP/STP screens)
  }
  if (needsDcape || needsDcape21 || needsEffectiveDiagnostics) {
    needed[4] = 1; // derivedSurfacePressure
    needed[5] = 1; // pressureMsl
  }
  if (needsBulk || needsEffective || needsEffectiveDiagnostics) {
    needed[6] = 1; // windU10m
    needed[7] = 1; // windV10m
  }
  if (needsEffective || needsEffectiveDiagnostics) {
    needed[9] = 1; // mlcape
    needed[10] = 1; // mlcin
    needed[11] = 1; // sbcape
  }
  if (needsEffective) {
    needed[12] = 1; // sbcin (effective-layer candidate screen only)
  }
  const markSourceSlots = (table, variableNeeds) => {
    for (let index = 0; index < table.count; index += 1) {
      for (let variable = 0; variable < variableNeeds.length; variable += 1) {
        const slot = table.slots[index * 5 + variable];
        if (variableNeeds[variable] && slot >= 0) {
          needed[slot] = 1;
        }
      }
    }
  };
  // src6 variables [hgt, tmp, rh, u, v]
  markSourceSlots(plan.table6, [
    needsLapse || needsBulk || needsEffective || needsDcape,
    needsLapse || needsDcape,
    needsDcape,
    needsBulk || needsEffective,
    needsBulk || needsEffective,
  ]);
  markSourceSlots(plan.table21, [
    needsEffectiveDiagnostics || needsDcape21,
    needsEffectiveDiagnostics || needsDcape21,
    needsEffectiveDiagnostics || needsDcape21,
    needsEffectiveDiagnostics,
    needsEffectiveDiagnostics,
  ]);
  port.present.fill(0);
  for (let slot = 0; slot < plan.grids.length; slot += 1) {
    port.present[slot] = plan.grids[slot] && needed[slot] ? 1 : 0;
  }
  const outRows = [
    outputs.lapse,
    outputs.bulk,
    outputs.effective,
    outputs.dcape,
    outputs.dcape21LevelCam,
    outputs.effectiveLayerScp,
    outputs.effectiveLayerStp,
    outputs.effectiveLayerStp100mb,
  ];
  for (let start = 0; start < cellCount; start += port.cells) {
    const count = Math.min(port.cells, cellCount - start);
    for (let slot = 0; slot < plan.grids.length; slot += 1) {
      const grid = plan.grids[slot];
      if (grid && needed[slot]) {
        port.arena.set(grid.subarray(start, start + count), slot * port.cells);
      }
    }
    if (effectiveCandidateCells) {
      port.mask.set(effectiveCandidateCells.mask.subarray(start, start + count));
    }
    port.run(
      count,
      needsLapse ? 1 : 0,
      needsBulk ? 1 : 0,
      needsEffective ? 1 : 0,
      needsDcape ? 1 : 0,
      needsDcape21 ? 1 : 0,
      needsScp ? 1 : 0,
      needsStp ? 1 : 0,
      needsStp100mb ? 1 : 0,
      effectiveCandidateCells ? 1 : 0,
      plan.table6.count,
      plan.table21.count,
      EFFECTIVE_PARCEL_SOURCE_DEPTH_HPA,
      EFFECTIVE_PARCEL_SOURCE_STEP_HPA,
      EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M,
      EFFECTIVE_INFLOW_MIN_CAPE_JKG,
      EFFECTIVE_INFLOW_MIN_CIN_JKG,
      EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG,
      DCAPE_SOURCE_DEPTH_HPA,
      DCAPE_SOURCE_LAYER_DEPTH_HPA,
      1,
    );
    for (let row = 0; row < outRows.length; row += 1) {
      const target = outRows[row];
      if (target) {
        target.set(port.out.subarray(row * port.cells, row * port.cells + count), start);
      }
    }
  }
  return true;
}

function buildEffectiveDiagnosticsCandidateCells(decoded, cellCount, options = {}) {
  const count = Math.max(0, Math.round(Number(cellCount) || 0));
  if (count <= 0) {
    return null;
  }
  const needsScp = Boolean(options?.needsScp);
  const needsStp = Boolean(options?.needsStp);
  const needsStp100mb = Boolean(options?.needsStp100mb);
  const profile = options?.profile || null;
  const mask = new Uint8Array(count);
  // Ascending candidate indices collected in the same pass as the mask (no
  // extra scan): the JS cell loop iterates this list instead of scanning the
  // grid for mask hits; the slab path reads only the mask.
  const indices = new Uint32Array(count);
  let candidateCount = 0;
  for (let index = 0; index < count; index += 1) {
    if (!hasEffectiveDiagnosticsCandidateCape(decoded, index, { needsScp, needsStp, needsStp100mb })) {
      continue;
    }
    mask[index] = 1;
    indices[candidateCount] = index;
    candidateCount += 1;
  }
  if (profile) {
    profile.effectiveDiagnosticsCandidateCount = candidateCount;
  }
  return candidateCount > 0 ? { mask, indices: indices.subarray(0, candidateCount), count: candidateCount } : null;
}

function hasEffectiveDiagnosticsCandidateCape(decoded, index, options = {}) {
  const mucape = gridValue(decoded?.mucape, index);
  const mlcape = gridValue(decoded?.mlcape, index);
  const sbcape = gridValue(decoded?.sbcape, index);
  if (options?.needsScp && mucape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG) {
    return true;
  }
  // The 100-mb prototype must not inherit any native CAPE/CIN gate: a sharp
  // boundary-layer gradient or different parcel numerics can move the derived
  // source across those thresholds. Gate only on surface prerequisites without
  // which fillEffectiveDiagnosticsProfileRows cannot compute the parcel. This
  // is deliberately broader and more expensive than the production screens.
  if (options?.needsStp100mb && hasEffectiveDiagnosticsSurfacePrerequisites(decoded, index)) {
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

function hasEffectiveDiagnosticsSurfacePrerequisites(decoded, index) {
  return (
    Number.isFinite(profileValue(decoded, "HGT", "surface", index)) &&
    Number.isFinite(profileValue(decoded, "TMP", "surface", index)) &&
    Number.isFinite(surfaceDewpointK(decoded, index)) &&
    Number.isFinite(surfacePressureHpa(decoded, index)) &&
    Number.isFinite(profileValue(decoded, "UGRD", "surface", index)) &&
    Number.isFinite(profileValue(decoded, "VGRD", "surface", index))
  );
}

function isEffectiveDiagnosticsCandidateCell(candidateCells, index) {
  if (!candidateCells) {
    return false;
  }
  return candidateCells.mask?.[index] === 1;
}

function createEffectiveDiagnosticsScratch(sourceCount, options = {}) {
  const size = Math.max(4, sourceCount + 2);
  // Kernel-backed scratch is strictly opt-in: the kernel's linear-memory
  // views are one shared region per thread, so only the synchronous
  // gridded cell loop (exclusive use between fill and consume) may request
  // it. Async consumers (point soundings) must keep plain arrays.
  if (options.useKernel === true) {
    const kernel = getParcelKernel();
    if (kernel && size <= kernel.rowsCap) {
      return {
        kernel,
        heights: kernel.views.heights,
        // Wind rows live in kernel memory too when the kernel exports the
        // Stage G1 product chain, so the in-kernel wind interpolators read
        // the same buffers the JS fill writes.
        u: kernel.views.u || new Float64Array(kernel.rowsCap),
        v: kernel.views.v || new Float64Array(kernel.rowsCap),
        pressure: kernel.views.pressure,
        temp: kernel.views.temp,
        dewpoint: kernel.views.dewpoint,
        segmentValid: kernel.views.segmentValid,
        segmentDz: kernel.views.segmentDz,
        segmentMidHeight: kernel.views.segmentMidHeight,
        segmentMidPressure: kernel.views.segmentMidPressure,
        segmentEnvVirtualTemp: kernel.views.segmentEnvVirtualTemp,
      };
    }
  }
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
  // Stage G1: when the kernel exports the product chain (and the scratch's
  // wind rows are kernel views), the entire post-fill sequence below —
  // scan, wind interpolation, Bunkers, SRH, EBWD, mixed-layer parcel, and
  // the SCP/STP composites — runs inside the kernel as an f64 NativeMath
  // port. NaN slots reproduce the JS null/absent semantics because every
  // caller filters through Number.isFinite.
  if (scratch.kernel?.effectiveProducts && scratch.u === scratch.kernel.views.u && !options?.pressureStep) {
    // The JS path below calls calculateEffectiveParcelLayerFromRows WITHOUT
    // forwarding options, so the scan always runs at the default source
    // step; the kernel branch must mirror that exactly.
    const needsStpProduct = Boolean(options?.needsStp);
    const mlcapeValue = needsStpProduct ? gridValue(decoded?.mlcape, index) : Number.NaN;
    const mlcinValue = needsStpProduct ? gridValue(decoded?.mlcin, index) : Number.NaN;
    const completed = scratch.kernel.effectiveProducts(
      rowCount,
      EFFECTIVE_PARCEL_SOURCE_DEPTH_HPA,
      EFFECTIVE_PARCEL_SOURCE_STEP_HPA,
      EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M,
      EFFECTIVE_INFLOW_MIN_CAPE_JKG,
      EFFECTIVE_INFLOW_MIN_CIN_JKG,
      options?.needsScp ? 1 : 0,
      needsStpProduct ? 1 : 0,
      options?.needsStp100mb ? 1 : 0,
      mlcapeValue,
      mlcinValue,
      scratch.kernel.variant === "wasm-f32" ? 1 : 0,
    );
    if (!completed) {
      return null;
    }
    const out = scratch.kernel.views.productsOut;
    return { scp: out[0], stp: out[1], stp100mbReduced: out[2] };
  }
  const layer = calculateEffectiveParcelLayerFromRows(scratch, rowCount);
  if (!layer || !Number.isFinite(layer.baseAglM) || !Number.isFinite(layer.topAglM)) {
    return null;
  }
  const needsScp = Boolean(options?.needsScp);
  const needsStp = Boolean(options?.needsStp);
  const needsStp100mb = Boolean(options?.needsStp100mb);
  const products = {};
  const baseAglM = layer.baseAglM;
  const canShortCircuitStp = (needsStp || needsStp100mb) && !needsScp && baseAglM > 0;
  if (canShortCircuitStp) {
    if (needsStp) {
      products.stp = 0;
    }
    if (needsStp100mb) {
      products.stp100mbReduced = 0;
    }
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
    products.scp = calculateEffectiveLayerScpValue(layer, esrh, ebwdKt);
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
  if (needsStp100mb) {
    products.stp100mbReduced =
      baseAglM > 0 ? 0 : calculateEffectiveLayerStp100mbReducedValue(scratch, rowCount, esrh, ebwdKt);
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
  if (scratch.kernel && !options?.pressureStep) {
    // The WASM kernel runs the identical scan (including segment prep into
    // the same shared views) with NativeMath transcendentals; see
    // tools/parcel-kernel/assembly/index.ts for the tolerance contract.
    const kernelStepHpa = Number.isFinite(options?.sourceStepHpa)
      ? Math.max(0, Number(options.sourceStepHpa))
      : EFFECTIVE_PARCEL_SOURCE_STEP_HPA;
    const found = scratch.kernel.runOriginScan(
      rowCount,
      EFFECTIVE_PARCEL_SOURCE_DEPTH_HPA,
      kernelStepHpa,
      EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M,
      EFFECTIVE_INFLOW_MIN_CAPE_JKG,
      EFFECTIVE_INFLOW_MIN_CIN_JKG,
    );
    if (!found) {
      return null;
    }
    const out = scratch.kernel.views.out;
    return {
      baseAglM: out[1],
      topAglM: out[2],
      muCapeJkg: out[3],
      muCinJkg: out[4],
      muElAglM: out[5],
    };
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
  if (options?.pressureStep) {
    const source = {
      pressureHpa: scratch.pressure[sourceRow],
      heightAglM: scratch.heights[sourceRow],
      tempK: scratch.temp[sourceRow],
      dewpointK: scratch.dewpoint[sourceRow],
    };
    return calculatePressureStepParcelCapeCinForSource(scratch, rowCount, source);
  }
  return calculateSegmentParcelCapeCinForSourceValues(
    scratch,
    rowCount,
    Number(scratch.pressure[sourceRow]),
    Number(scratch.heights[sourceRow]),
    Number(scratch.temp[sourceRow]),
    Number(scratch.dewpoint[sourceRow]),
    sourceRow + 1,
  );
}

function calculateParcelCapeCinForSource(scratch, rowCount, source) {
  return calculateSegmentParcelCapeCinForSource(scratch, rowCount, source);
}

function calculateSegmentParcelCapeCinForSource(scratch, rowCount, source) {
  return calculateSegmentParcelCapeCinForSourceValues(
    scratch,
    rowCount,
    Number(source?.pressureHpa),
    Number(source?.heightAglM),
    Number(source?.tempK),
    Number(source?.dewpointK),
    1,
  );
}

function calculateSegmentParcelCapeCinForSourceValues(
  scratch,
  rowCount,
  sourcePressure,
  sourceHeight,
  sourceTemp,
  rawSourceDewpoint,
  startRow,
) {
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
  // Rows at or below the origin always fail the mid-height/mid-pressure
  // guards below (heights are sorted ascending), so starting at startRow
  // skips only iterations that would have been skipped anyway.
  for (let row = startRow; row < rowCount; row += 1) {
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

function calculateEffectiveLayerScpValue(effectiveLayer, esrh, ebwdKt) {
  // MU CAPE and MU CIN must come from the same parcel. The effective-layer
  // scan already identifies and retains that pair; substituting the model's
  // separate MUCAPE field can pair CAPE with an unrelated CIN value.
  const mucape = Number(effectiveLayer?.muCapeJkg);
  const mucin = Number(effectiveLayer?.muCinJkg);
  if (!Number.isFinite(mucape) || !Number.isFinite(mucin)) {
    return Number.NaN;
  }
  const capeTerm = Math.max(0, mucape) / 1000;
  const srhTerm = Math.max(0, Number(esrh)) / 50;
  const ebwdMs = Math.max(0, Number(ebwdKt)) / MPS_TO_KT;
  const shearTerm = ebwdMs < 10 ? 0 : clamp(ebwdMs / 20, 0, 1);
  const cinTerm = mucin > -40 ? 1 : clamp(-40 / mucin, 0, 1);
  const scp = capeTerm * srhTerm * shearTerm * cinTerm;
  return Number.isFinite(scp) ? Math.max(0, scp) : Number.NaN;
}

function calculateEffectiveLayerStpValue(decoded, index, esrh, ebwdKt, mixedLayerLclM) {
  const mlcape = gridValue(decoded?.mlcape, index);
  const mlcin = gridValue(decoded?.mlcin, index);
  return calculateEffectiveLayerStpFromParcelValues(mlcape, mlcin, esrh, ebwdKt, mixedLayerLclM);
}

function calculateEffectiveLayerStp100mbReducedValue(scratch, rowCount, esrh, ebwdKt) {
  const source = buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount);
  if (!source) {
    return Number.NaN;
  }
  // Deliberately use the same segment-integrated parcel kernel as the sparse
  // gridded effective-layer scan. This isolates the native 90-mb -> derived
  // 100-mb source experiment without implying dense 1-hPa/SHARPpy parity.
  const parcel = calculateSegmentParcelCapeCinForSource(scratch, rowCount, source);
  if (!parcel) {
    return Number.NaN;
  }
  return calculateEffectiveLayerStpFromParcelValues(parcel.capeJkg, parcel.cinJkg, esrh, ebwdKt, parcel.lclAglM);
}

function calculateEffectiveLayerStpFromParcelValues(capeJkg, cinJkg, esrh, ebwdKt, mixedLayerLclM) {
  const cape = Number(capeJkg);
  const cin = Number(cinJkg);
  if (!Number.isFinite(cape) || !Number.isFinite(cin)) {
    return Number.NaN;
  }
  const capeTerm = Math.max(0, cape) / 1500;
  const lclTerm = clamp((2000 - Number(mixedLayerLclM)) / 1000, 0, 1);
  const srhTerm = Math.max(0, Number(esrh)) / 150;
  const ebwdMs = Math.max(0, Number(ebwdKt)) / MPS_TO_KT;
  const shearTerm = ebwdMs < 12.5 ? 0 : clamp(ebwdMs / 20, 0, 1.5);
  const cinTerm = cin > -50 ? 1 : clamp((cin + 200) / 150, 0, 1);
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
function interpolateDcapeKnotThermoInto(
  sample,
  knotHeights,
  knotTemps,
  knotPressures,
  knotDewpoints,
  knotCount,
  pressureHpa,
) {
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
      sample.tempK = knotTemps[row];
      sample.dewpointK = knotDewpoints[row];
      sample.heightM = knotHeights[row];
      return sample;
    }
    const t = clamp(
      (Math.log(pressureHpa) - Math.log(lowerPressure)) / (Math.log(upperPressure) - Math.log(lowerPressure)),
      0,
      1,
    );
    sample.tempK = knotTemps[row - 1] + (knotTemps[row] - knotTemps[row - 1]) * t;
    sample.dewpointK = knotDewpoints[row - 1] + (knotDewpoints[row] - knotDewpoints[row - 1]) * t;
    sample.heightM = knotHeights[row - 1] + (knotHeights[row] - knotHeights[row - 1]) * t;
    return sample;
  }
  return null;
}

// Fills the kernel's DCAPE knot inputs with the same raw grid reads the JS
// path performs (the kernel applies the identical acceptance guards) and
// runs the f32 port. The surfaceHeight fallback mirrors the JS function's
// `Number.isFinite(elevation) ? elevation : 0`.
function computeKernelDcape(kernel, sourceList, index, elevation, surfaceTemp, surfacePressure) {
  const dcapePort = kernel.dcape;
  if (sourceList.length > dcapePort.cap) {
    // Never truncate knots silently; callers fall back to the JS path.
    return null;
  }
  let count = 0;
  for (let sourceIndex = 0; sourceIndex < sourceList.length && count < dcapePort.cap; sourceIndex += 1) {
    const source = sourceList[sourceIndex];
    dcapePort.levels[count] = Number(source.level);
    dcapePort.hgt[count] = source.hgt ? source.hgt[index] : Number.NaN;
    dcapePort.tmp[count] = source.tmp ? source.tmp[index] : Number.NaN;
    dcapePort.rh[count] = source.rh ? source.rh[index] : Number.NaN;
    count += 1;
  }
  return dcapePort.compute(
    count,
    Number.isFinite(elevation) ? elevation : 0,
    surfaceTemp,
    surfacePressure,
    DCAPE_SOURCE_DEPTH_HPA,
    DCAPE_SOURCE_LAYER_DEPTH_HPA,
  );
}

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

  // Interpolation samples reuse one scratch-owned object per cell; every
  // consumer reads the sample's fields before the next interpolation call,
  // and no interpolation happens between the final source sample's write
  // and its reads in the descent setup below.
  const knotSample = scratch.knotSample || (scratch.knotSample = { tempK: 0, dewpointK: 0, heightM: 0 });
  const interpolateKnotThermo = (pressureHpa) =>
    interpolateDcapeKnotThermoInto(
      knotSample,
      knotHeights,
      knotTemps,
      knotPressures,
      knotDewpoints,
      knotCount,
      pressureHpa,
    );

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

module.exports = {
  DERIVED_DIAGNOSTIC_PROFILE_LEVELS,
  DERIVED_PROFILE_METHODOLOGY_VERSION,
  PROFILE_DERIVED_AVAILABILITY_KEYS,
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
  calculateEffectiveLayerStp100mbReducedValue,
  calculateEffectiveLayerStpFromParcelValues,
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
  hasEffectiveDiagnosticsSurfacePrerequisites,
  interpolateBuoyancyZeroHeight,
  interpolateDerivedProfileColumn,
  interpolateDerivedProfileWindColumn,
  isEffectiveDiagnosticsCandidateCell,
  isEffectiveLayerCellActive,
  mixedLayerSampleAtPressure,
  mixedLayerSampleFromValues,
  prepareEffectiveParcelSegments,
  _testEffectiveDiagnosticsSparseLoopStats: effectiveDiagnosticsSparseLoopStats,
};
