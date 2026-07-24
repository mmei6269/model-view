// AssemblyScript port of the effective-inflow-layer origin scan from
// scripts/lib/noaa-beta/severe.js: prepareEffectiveParcelSegments +
// calculateEffectiveParcelLayerFromRows + the segment parcel CAPE/CIN
// integrator (including the inlined moist-adiabat Euler ascent from
// scripts/lib/noaa-beta/thermo.js).
//
// Formulas, guards, operation order, and NaN semantics mirror the JS
// implementation line for line. Transcendentals (exp/log/pow) use
// AssemblyScript's NativeMath (musl-derived, <=1 ulp), which is the ONLY
// numeric difference from the JS path (V8 uses its own fdlibm-derived
// ieee754 port). Per the 2026-07-11 owner ruling, this rounding-level
// shift is acceptable for the parcel kernel and is measured and documented
// in docs/noaa-renderer-benchmark-history.md rather than held to byte
// parity.
//
// Memory layout: fixed static offsets over linear memory, capacity
// ROWS_CAP rows. The JS side creates Float64Array/Uint8Array views over
// the exported wasm memory at these offsets, fills the row arrays exactly
// as it fills the plain scratch arrays, calls runOriginScan once per cell,
// and reads the outputs (and, for downstream mixed-layer consumers, the
// prepared segment arrays) through the same views.

export const ROWS_CAP: i32 = 64;

const F64_BYTES: usize = 8;

// Regions are reserved through memory.data() so the compiler lays them out
// in its static-data section. Hardcoded low offsets would silently overlap
// AssemblyScript's shadow stack, which occupies the bottom of linear
// memory (observed as intermittent segment-array corruption).
export const HEIGHTS_PTR: usize = memory.data(512, 8);
export const PRESSURE_PTR: usize = memory.data(512, 8);
export const TEMP_PTR: usize = memory.data(512, 8);
export const DEWPOINT_PTR: usize = memory.data(512, 8);
export const SEGMENT_DZ_PTR: usize = memory.data(512, 8);
export const SEGMENT_MID_HEIGHT_PTR: usize = memory.data(512, 8);
export const SEGMENT_MID_PRESSURE_PTR: usize = memory.data(512, 8);
export const SEGMENT_ENV_VIRTUAL_TEMP_PTR: usize = memory.data(512, 8);
export const SEGMENT_VALID_PTR: usize = memory.data(64, 8);
export const OUT_PTR: usize = memory.data(48, 8);

// Output slots (f64 each, from OUT_PTR):
// 0 found (1/0), 1 baseAglM, 2 topAglM, 3 muCapeJkg, 4 muCinJkg, 5 muElAglM
export const OUT_SLOTS: i32 = 6;

// Thermodynamic constants copied verbatim from scripts/lib/noaa-beta/thermo.js
const RD_OVER_CP: f64 = 0.2854;
const CP_OVER_RD: f64 = 1.0 / RD_OVER_CP;
const GRAVITY_M_S2: f64 = 9.80665;
const EPSILON: f64 = 0.622;
const RD_DRY_AIR_J_KG_K: f64 = 287.05;
const CP_DRY_AIR_J_KG_K: f64 = 1004.0;
const LATENT_HEAT_VAPORIZATION_J_KG: f64 = 2.5e6;
const DRY_ADIABATIC_LAPSE_K_M: f64 = 0.0098;
const MOIST_ADIABATIC_MAX_STEP_M: f64 = 300.0;

@inline
function heightAt(row: i32): f64 {
  return load<f64>(HEIGHTS_PTR + <usize>row * F64_BYTES);
}

@inline
function pressureAt(row: i32): f64 {
  return load<f64>(PRESSURE_PTR + <usize>row * F64_BYTES);
}

@inline
function tempAt(row: i32): f64 {
  return load<f64>(TEMP_PTR + <usize>row * F64_BYTES);
}

@inline
function dewpointAt(row: i32): f64 {
  return load<f64>(DEWPOINT_PTR + <usize>row * F64_BYTES);
}

@inline
function clamp01(value: f64): f64 {
  return Math.max(0.0, Math.min(1.0, value));
}

// thermo.boltonLclTemperatureK
@inline
function boltonLclTemperatureK(tempK: f64, dewpointK: f64): f64 {
  if (!isFinite(tempK) || !isFinite(dewpointK) || dewpointK <= 0.0) {
    return NaN;
  }
  return 56.0 + 1.0 / (1.0 / (dewpointK - 56.0) + Math.log(tempK / dewpointK) / 800.0);
}

// thermo.vaporPressureHpa
@inline
function vaporPressureHpa(dewpointK: f64): f64 {
  if (!isFinite(dewpointK)) {
    return NaN;
  }
  const dewpointC = dewpointK - 273.15;
  return 6.112 * Math.exp((17.67 * dewpointC) / (dewpointC + 243.5));
}

// thermo.mixingRatioFromVaporPressureHpa
@inline
function mixingRatioFromVaporPressureHpa(vaporPressure: f64, pressureHpa: f64): f64 {
  if (!isFinite(pressureHpa) || !isFinite(vaporPressure) || pressureHpa <= 0.0 || vaporPressure <= 0.0 || vaporPressure >= pressureHpa) {
    return NaN;
  }
  return (EPSILON * vaporPressure) / (pressureHpa - vaporPressure);
}

// thermo.integrateMoistParcelTemperatureK (fixed-step Euler ascent)
function integrateMoistParcelTemperatureK(startTempK: f64, startHeightM: f64, targetHeightM: f64, pressureHpa: f64): f64 {
  if (!isFinite(startTempK) || !isFinite(startHeightM) || !isFinite(targetHeightM) || !isFinite(pressureHpa)) {
    return NaN;
  }
  const dz = Math.max(0.0, targetHeightM - startHeightM);
  if (dz <= 0.0) {
    return startTempK;
  }
  const steps = Math.max(1.0, Math.ceil(dz / MOIST_ADIABATIC_MAX_STEP_M));
  const stepDz = dz / steps;
  const pressureUsable = pressureHpa > 0.0;
  let tempK = startTempK;
  for (let step: f64 = 0.0; step < steps; step += 1.0) {
    const tempC = tempK - 273.15;
    const vapor = 6.112 * Math.exp((17.67 * tempC) / (tempC + 243.5));
    if (!pressureUsable || !isFinite(vapor) || vapor <= 0.0 || vapor >= pressureHpa) {
      return NaN;
    }
    const saturationMixingRatio = (EPSILON * vapor) / (pressureHpa - vapor);
    const latentTerm = (LATENT_HEAT_VAPORIZATION_J_KG * saturationMixingRatio) / (RD_DRY_AIR_J_KG_K * tempK);
    const denominator =
      CP_DRY_AIR_J_KG_K +
      (LATENT_HEAT_VAPORIZATION_J_KG * LATENT_HEAT_VAPORIZATION_J_KG * saturationMixingRatio * EPSILON) /
        (RD_DRY_AIR_J_KG_K * tempK * tempK);
    if (!isFinite(latentTerm) || !isFinite(denominator) || denominator <= 0.0) {
      return NaN;
    }
    tempK -= ((GRAVITY_M_S2 * (1.0 + latentTerm)) / denominator) * stepDz;
  }
  return tempK;
}

// severe.prepareEffectiveParcelSegments
export function prepareSegments(rowCount: i32): void {
  const count = rowCount > ROWS_CAP ? ROWS_CAP : rowCount;
  for (let row = 0; row < count; row += 1) {
    store<u8>(SEGMENT_VALID_PTR + <usize>row, 0);
  }
  if (count <= 0) {
    return;
  }
  let lowerHeight = heightAt(0);
  let lowerPressure = pressureAt(0);
  let lowerTemp = tempAt(0);
  let lowerDewpoint = dewpointAt(0);
  let lowerLogPressure = Math.log(lowerPressure);
  for (let row = 1; row < count; row += 1) {
    const upperHeight = heightAt(row);
    const upperPressure = pressureAt(row);
    const upperTemp = tempAt(row);
    const upperDewpoint = dewpointAt(row);
    const upperLogPressure = Math.log(upperPressure);
    const dz = upperHeight - lowerHeight;
    const usable =
      isFinite(dz) &&
      dz > 1.0 &&
      isFinite(lowerPressure) &&
      isFinite(upperPressure) &&
      lowerPressure > 0.0 &&
      upperPressure > 0.0 &&
      isFinite(lowerTemp) &&
      isFinite(upperTemp) &&
      isFinite(lowerDewpoint) &&
      isFinite(upperDewpoint);
    if (usable) {
      const midPressure = Math.exp((lowerLogPressure + upperLogPressure) / 2.0);
      const envTemp = (lowerTemp + upperTemp) / 2.0;
      const envDewpoint = (lowerDewpoint + upperDewpoint) / 2.0;
      let envVirtualTemp: f64 = NaN;
      if (isFinite(midPressure) && midPressure > 0.0) {
        const envDewpointC = envDewpoint - 273.15;
        const vapor = 6.112 * Math.exp((17.67 * envDewpointC) / (envDewpointC + 243.5));
        if (isFinite(vapor) && vapor > 0.0 && vapor < midPressure) {
          const ratio = (EPSILON * vapor) / (midPressure - vapor);
          envVirtualTemp = (envTemp * (1.0 + ratio / EPSILON)) / (1.0 + ratio);
        }
      }
      if (isFinite(midPressure) && isFinite(envVirtualTemp)) {
        store<u8>(SEGMENT_VALID_PTR + <usize>row, 1);
        store<f64>(SEGMENT_DZ_PTR + <usize>row * F64_BYTES, dz);
        store<f64>(SEGMENT_MID_HEIGHT_PTR + <usize>row * F64_BYTES, (lowerHeight + upperHeight) / 2.0);
        store<f64>(SEGMENT_MID_PRESSURE_PTR + <usize>row * F64_BYTES, midPressure);
        store<f64>(SEGMENT_ENV_VIRTUAL_TEMP_PTR + <usize>row * F64_BYTES, envVirtualTemp);
      }
    }
    lowerHeight = upperHeight;
    lowerPressure = upperPressure;
    lowerTemp = upperTemp;
    lowerDewpoint = upperDewpoint;
    lowerLogPressure = upperLogPressure;
  }
}

// severe.calculateSegmentParcelCapeCinForSourceValues. Writes
// cape/cin/lcl/lfc/el into the five f64 slots starting at scratchOut and
// returns true when the parcel is computable (JS returned an object) or
// false (JS returned null).
function segmentParcel(
  rowCount: i32,
  sourcePressure: f64,
  sourceHeight: f64,
  sourceTemp: f64,
  rawSourceDewpoint: f64,
  startRow: i32,
  capeOut: usize,
): bool {
  const sourceDewpoint = Math.min(rawSourceDewpoint, sourceTemp);
  if (
    !isFinite(sourcePressure) ||
    !isFinite(sourceHeight) ||
    !isFinite(sourceTemp) ||
    !isFinite(rawSourceDewpoint) ||
    sourcePressure <= 100.0 ||
    rawSourceDewpoint > sourceTemp + 0.5
  ) {
    return false;
  }
  const lclTempK = boltonLclTemperatureK(sourceTemp, sourceDewpoint);
  const sourceVaporPressure = vaporPressureHpa(sourceDewpoint);
  if (!isFinite(lclTempK) || !isFinite(sourceVaporPressure)) {
    return false;
  }
  const lclPressure = sourcePressure * Math.pow(lclTempK / sourceTemp, CP_OVER_RD);
  const sourceMixingRatio = mixingRatioFromVaporPressureHpa(sourceVaporPressure, sourcePressure);
  if (!isFinite(lclPressure) || !isFinite(sourceMixingRatio)) {
    return false;
  }
  const lclHeight = sourceHeight + Math.max(0.0, sourceTemp - lclTempK) / DRY_ADIABATIC_LAPSE_K_M;
  const dryVirtualNumer = 1.0 + sourceMixingRatio / EPSILON;
  const dryVirtualDenom = 1.0 + sourceMixingRatio;

  let cape: f64 = 0.0;
  let cin: f64 = 0.0;
  let positiveSeen = false;
  let previousBuoyancy: f64 = NaN;
  let previousHeight = sourceHeight;
  let lfcAglM: f64 = NaN;
  let elAglM: f64 = NaN;
  let saturatedParcelTemp = lclTempK;
  let saturatedParcelHeight = lclHeight;
  for (let row = startRow; row < rowCount; row += 1) {
    if (!load<u8>(SEGMENT_VALID_PTR + <usize>row)) {
      continue;
    }
    const midHeight = load<f64>(SEGMENT_MID_HEIGHT_PTR + <usize>row * F64_BYTES);
    const midPressure = load<f64>(SEGMENT_MID_PRESSURE_PTR + <usize>row * F64_BYTES);
    const envVirtualTemp = load<f64>(SEGMENT_ENV_VIRTUAL_TEMP_PTR + <usize>row * F64_BYTES);
    const dz = load<f64>(SEGMENT_DZ_PTR + <usize>row * F64_BYTES);
    if (midHeight <= sourceHeight + 1.0 || midPressure > sourcePressure + 1.0) {
      continue;
    }
    const belowLclPressure = midPressure >= lclPressure;
    let parcelTemp: f64;
    if (belowLclPressure || midHeight <= lclHeight) {
      parcelTemp = sourceTemp * Math.pow(midPressure / sourcePressure, RD_OVER_CP);
    } else {
      parcelTemp = integrateMoistParcelTemperatureK(saturatedParcelTemp, saturatedParcelHeight, midHeight, midPressure);
      if (isFinite(parcelTemp)) {
        saturatedParcelTemp = parcelTemp;
        saturatedParcelHeight = midHeight;
      }
    }
    let parcelVirtualTemp: f64;
    if (belowLclPressure) {
      parcelVirtualTemp = (parcelTemp * dryVirtualNumer) / dryVirtualDenom;
    } else {
      const parcelTempC = parcelTemp - 273.15;
      const vapor = 6.112 * Math.exp((17.67 * parcelTempC) / (parcelTempC + 243.5));
      if (isFinite(vapor) && vapor > 0.0 && vapor < midPressure) {
        const ratio = (EPSILON * vapor) / (midPressure - vapor);
        parcelVirtualTemp = (parcelTemp * (1.0 + ratio / EPSILON)) / (1.0 + ratio);
      } else {
        parcelVirtualTemp = NaN;
      }
    }
    if (!isFinite(envVirtualTemp) || !isFinite(parcelVirtualTemp)) {
      continue;
    }
    const buoyancy = (GRAVITY_M_S2 * (parcelVirtualTemp - envVirtualTemp)) / Math.max(180.0, envVirtualTemp);
    const energy = buoyancy * dz;
    const isAtOrAboveLcl = midHeight >= lclHeight - 1.0 || midPressure <= lclPressure + 0.1;
    if (isFinite(energy)) {
      if (energy > 0.0 && isAtOrAboveLcl) {
        if (!positiveSeen) {
          let crossingHeight: f64;
          if (isFinite(previousBuoyancy) && previousBuoyancy <= 0.0) {
            crossingHeight =
              previousHeight +
              (midHeight - previousHeight) * clamp01(-previousBuoyancy / Math.max(1e-9, buoyancy - previousBuoyancy));
          } else if (previousHeight < lclHeight) {
            crossingHeight = lclHeight;
          } else {
            crossingHeight = midHeight;
          }
          lfcAglM = Math.max(lclHeight, crossingHeight);
        }
        cape += energy;
        positiveSeen = true;
        elAglM = heightAt(row);
      } else if (!positiveSeen && energy < 0.0) {
        cin += energy;
      } else if (isFinite(previousBuoyancy) && previousBuoyancy > 0.0 && buoyancy <= 0.0) {
        const fraction = previousBuoyancy / Math.max(1e-9, previousBuoyancy - buoyancy);
        elAglM = previousHeight + (midHeight - previousHeight) * clamp01(fraction);
      }
    }
    previousBuoyancy = buoyancy;
    previousHeight = midHeight;
  }
  store<f64>(capeOut, Math.max(0.0, cape));
  store<f64>(capeOut + 8, Math.min(0.0, cin));
  store<f64>(capeOut + 16, isFinite(lclHeight) ? lclHeight : NaN);
  store<f64>(capeOut + 24, isFinite(lfcAglM) ? lfcAglM : NaN);
  store<f64>(capeOut + 32, isFinite(elAglM) ? elAglM : NaN);
  return true;
}

// Scratch slots for segmentParcel results during the origin scan.
const PARCEL_OUT: usize = memory.data(40, 8);

// severe.calculateEffectiveParcelLayerFromRows (segment-parcel path only).
// Writes found/base/top/muCape/muCin/muEl to the OUT slots. Returns 1 when a
// layer was found (JS returned an object), 0 otherwise (JS returned null).
export function runOriginScan(
  rowCount: i32,
  sourceDepthHpa: f64,
  sourceStepHpa: f64,
  sourceMaxAglM: f64,
  minCapeJkg: f64,
  minCinJkg: f64,
): i32 {
  const count = rowCount > ROWS_CAP ? ROWS_CAP : rowCount;
  store<f64>(OUT_PTR, 0.0);
  const surfacePressure = pressureAt(0);
  if (!isFinite(surfacePressure)) {
    return 0;
  }
  prepareSegments(count);
  const pressureFloor = surfacePressure - sourceDepthHpa;
  let inLayer = false;
  let baseAglM: f64 = NaN;
  let topAglM: f64 = NaN;
  let lastEffectiveAglM: f64 = NaN;
  let muCapeJkg: f64 = -Infinity;
  let muCinJkg: f64 = NaN;
  let muElAglM: f64 = NaN;
  let lastScannedSourcePressure: f64 = NaN;

  for (let row = 0; row < count; row += 1) {
    const height = heightAt(row);
    const pressure = pressureAt(row);
    const temp = tempAt(row);
    const dewpoint = dewpointAt(row);
    if (!isFinite(height) || height > sourceMaxAglM || !isFinite(pressure) || !isFinite(temp) || !isFinite(dewpoint)) {
      continue;
    }
    if (pressure < pressureFloor) {
      break;
    }
    if (sourceStepHpa > 0.0 && isFinite(lastScannedSourcePressure) && lastScannedSourcePressure - pressure < sourceStepHpa) {
      continue;
    }
    lastScannedSourcePressure = pressure;
    const ok = segmentParcel(count, pressure, height, temp, dewpoint, row + 1, PARCEL_OUT);
    const capeJkg = load<f64>(PARCEL_OUT);
    const cinJkg = load<f64>(PARCEL_OUT + 8);
    if (!ok || !isFinite(capeJkg) || !isFinite(cinJkg)) {
      if (inLayer) {
        break;
      }
      continue;
    }
    if (capeJkg > muCapeJkg) {
      muCapeJkg = capeJkg;
      muCinJkg = cinJkg;
      muElAglM = load<f64>(PARCEL_OUT + 32);
    }
    const effective = capeJkg >= minCapeJkg && cinJkg >= minCinJkg;
    if (effective) {
      if (!inLayer) {
        baseAglM = Math.max(0.0, height);
        inLayer = true;
      }
      lastEffectiveAglM = Math.max(baseAglM, height);
    } else if (inLayer) {
      topAglM = Math.max(baseAglM, lastEffectiveAglM);
      break;
    }
  }
  if (inLayer && !isFinite(topAglM) && isFinite(lastEffectiveAglM)) {
    topAglM = Math.max(baseAglM, lastEffectiveAglM);
  }
  if (!isFinite(baseAglM) || !isFinite(topAglM) || !isFinite(muCapeJkg)) {
    return 0;
  }
  store<f64>(OUT_PTR, 1.0);
  store<f64>(OUT_PTR + 8, baseAglM);
  store<f64>(OUT_PTR + 16, topAglM);
  store<f64>(OUT_PTR + 24, Math.max(0.0, muCapeJkg));
  store<f64>(OUT_PTR + 32, muCinJkg);
  store<f64>(OUT_PTR + 40, muElAglM);
  return 1;
}

// ============================================================================
// f32x4 SIMD origin scan (variant "wasm-f32", default).
//
// Same scan semantics as runOriginScan with two deliberate, owner-approved
// numeric deviations (2026-07-12 relaxed-tolerance ruling):
//   1. parcel integration runs in single precision (inputs rounded to f32;
//      accumulation in f32), and
//   2. the in-loop exponentials use a vectorized degree-6 polynomial exp
//      (~7e-7 relative) instead of NativeMath.
// Structure: candidate origins are collected exactly like the sequential
// scan's eligibility walk, parcels for up to four origins integrate in
// f32x4 lanes over the shared per-cell segments (origins of one cell walk
// identical rows, so lane divergence is limited to LCL position and Euler
// substep counts), and the sequential layer-selection logic then replays
// over the per-origin results — including its result-dependent breaks — so
// discrete outcomes (base/top rows, mu selection) follow the same rules.
// Validation: randomized dual-run fuzz vs the f64 paths plus real-frame
// artifact quantification; see docs/noaa-renderer-benchmark-history.md.
// ============================================================================

// Bumped whenever the kernel's numeric behavior or exported capability set
// changes; part of the derived-grid cache backend id so grids computed by
// different kernel builds are never served to each other (a stale binary
// without the DCAPE port must not share cache entries with this one).
// v3 (2026-07-12): Stage G1 — the post-scan effective-layer product glue
// (wind interpolation, Bunkers, SRH, mixed-layer parcel, SCP/STP
// composites) moved into the kernel under f64 NativeMath, shifting derived
// grids at the ulp level relative to the JS glue.
// v4 (2026-07-12): Stage G2 — the whole buildProfileDerivedGrids cell loop
// (profile-row fill incl. the NativeMath dewpoint, lapse/bulk column
// interpolation, DCAPE knot prep, surface-pressure chains) runs in-kernel
// over slab-resident grids under the wasm-f32 variant.
export const KERNEL_NUMERICS_VERSION: i32 = 4;

// Origins can never exceed the row capacity, so sizing the origin arrays to
// ROWS_CAP makes silent truncation structurally impossible.
export const ORIGINS_CAP: i32 = 64;

// f32 working copies of the row arrays (+ per-row log pressure).
const H32: usize = memory.data(256, 16);
const P32: usize = memory.data(256, 16);
const T32: usize = memory.data(256, 16);
const D32: usize = memory.data(256, 16);
const LOGP32: usize = memory.data(256, 16);
// f32 segment internals (widened into the JS-facing f64 arrays after prep).
const SDZ32: usize = memory.data(256, 16);
const SMH32: usize = memory.data(256, 16);
const SMP32: usize = memory.data(256, 16);
const SETV32: usize = memory.data(256, 16);
const SLOGMP32: usize = memory.data(256, 16);
// per-origin collection + results
const ORG_ROW: usize = memory.data(256, 16); // i32 x 64
const ORG_CAPE: usize = memory.data(256, 16);
const ORG_CIN: usize = memory.data(256, 16);
const ORG_EL: usize = memory.data(256, 16);
const ORG_VALID: usize = memory.data(64, 16); // u8 x 64
// per-group lane scratch (4 lanes x f32)
const LANE_SRCP: usize = memory.data(16, 16);
const LANE_SRCH: usize = memory.data(16, 16);
const LANE_SRCT: usize = memory.data(16, 16);
const LANE_LOGSRCP: usize = memory.data(16, 16);
const LANE_LCLT: usize = memory.data(16, 16);
const LANE_LCLP: usize = memory.data(16, 16);
const LANE_LCLH: usize = memory.data(16, 16);
const LANE_DRYN: usize = memory.data(16, 16);
const LANE_DRYD: usize = memory.data(16, 16);
const LANE_VALID: usize = memory.data(16, 16);

const F32_BYTES: usize = 4;

// @ts-ignore: decorator
@inline
function vexp4(x: v128): v128 {
  const n = f32x4.nearest(f32x4.mul(x, f32x4.splat(1.4426950408889634)));
  const r = f32x4.sub(x, f32x4.mul(n, f32x4.splat(0.6931471805599453)));
  let acc = f32x4.splat(1.0 / 720.0);
  acc = f32x4.add(f32x4.mul(acc, r), f32x4.splat(1.0 / 120.0));
  acc = f32x4.add(f32x4.mul(acc, r), f32x4.splat(1.0 / 24.0));
  acc = f32x4.add(f32x4.mul(acc, r), f32x4.splat(1.0 / 6.0));
  acc = f32x4.add(f32x4.mul(acc, r), f32x4.splat(0.5));
  acc = f32x4.add(f32x4.mul(acc, r), f32x4.splat(1.0));
  acc = f32x4.add(f32x4.mul(acc, r), f32x4.splat(1.0));
  const scale = i32x4.shl(i32x4.add(i32x4.trunc_sat_f32x4_s(n), i32x4.splat(127)), 23);
  return f32x4.mul(acc, scale);
}

// @ts-ignore: decorator
@inline
function isFiniteMask4(v: v128): v128 {
  // finite <=> |v| < inf  (NaN compares false, +/-inf compares false)
  return f32x4.lt(f32x4.abs(v), f32x4.splat(f32.MAX_VALUE * 2.0)); // inf literal shortcut
}

// Prepare segments in f32; store internals and widen into the f64
// JS-facing segment arrays consumed by the mixed-layer path.
function prepareSegmentsF32(rowCount: i32): void {
  for (let row = 0; row < rowCount; row += 1) {
    store<u8>(SEGMENT_VALID_PTR + <usize>row, 0);
    const p = <f32>load<f64>(PRESSURE_PTR + <usize>row * F64_BYTES);
    store<f32>(H32 + <usize>row * F32_BYTES, <f32>load<f64>(HEIGHTS_PTR + <usize>row * F64_BYTES));
    store<f32>(P32 + <usize>row * F32_BYTES, p);
    store<f32>(T32 + <usize>row * F32_BYTES, <f32>load<f64>(TEMP_PTR + <usize>row * F64_BYTES));
    store<f32>(D32 + <usize>row * F32_BYTES, <f32>load<f64>(DEWPOINT_PTR + <usize>row * F64_BYTES));
    store<f32>(LOGP32 + <usize>row * F32_BYTES, p > 0.0 ? <f32>Math.log(<f64>p) : f32.NaN);
  }
  for (let row = 1; row < rowCount; row += 1) {
    const lowerH = load<f32>(H32 + <usize>(row - 1) * F32_BYTES);
    const upperH = load<f32>(H32 + <usize>row * F32_BYTES);
    const lowerP = load<f32>(P32 + <usize>(row - 1) * F32_BYTES);
    const upperP = load<f32>(P32 + <usize>row * F32_BYTES);
    const lowerT = load<f32>(T32 + <usize>(row - 1) * F32_BYTES);
    const upperT = load<f32>(T32 + <usize>row * F32_BYTES);
    const lowerD = load<f32>(D32 + <usize>(row - 1) * F32_BYTES);
    const upperD = load<f32>(D32 + <usize>row * F32_BYTES);
    const dz = upperH - lowerH;
    const usable =
      isFinite(dz) && dz > 1.0 &&
      isFinite(lowerP) && isFinite(upperP) && lowerP > 0.0 && upperP > 0.0 &&
      isFinite(lowerT) && isFinite(upperT) && isFinite(lowerD) && isFinite(upperD);
    if (!usable) {
      continue;
    }
    const logMid = (load<f32>(LOGP32 + <usize>(row - 1) * F32_BYTES) + load<f32>(LOGP32 + <usize>row * F32_BYTES)) / 2.0;
    const midP = Mathf.exp(logMid);
    const envT = (lowerT + upperT) / 2.0;
    const envD = (lowerD + upperD) / 2.0;
    let envTv: f32 = f32.NaN;
    if (isFinite(midP) && midP > 0.0) {
      const envDc = envD - 273.15;
      const vap: f32 = 6.112 * Mathf.exp((17.67 * envDc) / (envDc + 243.5));
      if (isFinite(vap) && vap > 0.0 && vap < midP) {
        const ratio = (<f32>0.622 * vap) / (midP - vap);
        envTv = (envT * (1.0 + ratio / <f32>0.622)) / (1.0 + ratio);
      }
    }
    if (isFinite(midP) && isFinite(envTv)) {
      store<u8>(SEGMENT_VALID_PTR + <usize>row, 1);
      store<f32>(SDZ32 + <usize>row * F32_BYTES, dz);
      store<f32>(SMH32 + <usize>row * F32_BYTES, (lowerH + upperH) / 2.0);
      store<f32>(SMP32 + <usize>row * F32_BYTES, midP);
      store<f32>(SETV32 + <usize>row * F32_BYTES, envTv);
      store<f32>(SLOGMP32 + <usize>row * F32_BYTES, logMid);
      // Widen for the JS-facing mixed-layer consumers.
      store<f64>(SEGMENT_DZ_PTR + <usize>row * F64_BYTES, <f64>dz);
      store<f64>(SEGMENT_MID_HEIGHT_PTR + <usize>row * F64_BYTES, <f64>((lowerH + upperH) / 2.0));
      store<f64>(SEGMENT_MID_PRESSURE_PTR + <usize>row * F64_BYTES, <f64>midP);
      store<f64>(SEGMENT_ENV_VIRTUAL_TEMP_PTR + <usize>row * F64_BYTES, <f64>envTv);
    }
  }
}

// Integrate parcels for up to four origins (lanes) over the shared
// prepared segments. Writes cape/cin/el per origin slot.
function integrateOriginGroupF32(rowCount: i32, groupStart: i32, laneCount: i32): void {
  // ---- per-lane scalar setup (Bolton LCL etc.; four lanes at most) ----
  for (let lane = 0; lane < 4; lane += 1) {
    store<u8>(LANE_VALID + <usize>lane, 0);
    if (lane >= laneCount) continue;
    const row = load<i32>(ORG_ROW + <usize>((groupStart + lane) << 2));
    const srcP = load<f32>(P32 + <usize>row * F32_BYTES);
    const srcH = load<f32>(H32 + <usize>row * F32_BYTES);
    const srcT = load<f32>(T32 + <usize>row * F32_BYTES);
    const srcDraw = load<f32>(D32 + <usize>row * F32_BYTES);
    const srcD = Mathf.min(srcDraw, srcT);
    if (!isFinite(srcP) || !isFinite(srcH) || !isFinite(srcT) || !isFinite(srcDraw) || srcP <= 100.0 || srcDraw > srcT + 0.5) {
      continue;
    }
    if (srcD <= 0.0) continue;
    const lclT: f32 = 56.0 + 1.0 / (1.0 / (srcD - 56.0) + Mathf.log(srcT / srcD) / 800.0);
    const srcDc = srcD - 273.15;
    const srcVap: f32 = 6.112 * Mathf.exp((17.67 * srcDc) / (srcDc + 243.5));
    if (!isFinite(lclT) || !isFinite(srcVap)) continue;
    const lclP: f32 = srcP * Mathf.exp(<f32>(1.0 / 0.2854) * Mathf.log(lclT / srcT));
    if (!isFinite(lclP)) continue;
    if (!(isFinite(srcP) && srcP > 0.0 && srcVap > 0.0 && srcVap < srcP)) continue;
    const srcW: f32 = (<f32>0.622 * srcVap) / (srcP - srcVap);
    if (!isFinite(srcW)) continue;
    const lclH: f32 = srcH + Mathf.max(0.0, srcT - lclT) / <f32>0.0098;
    store<f32>(LANE_SRCP + <usize>(lane << 2), srcP);
    store<f32>(LANE_SRCH + <usize>(lane << 2), srcH);
    store<f32>(LANE_SRCT + <usize>(lane << 2), srcT);
    store<f32>(LANE_LOGSRCP + <usize>(lane << 2), load<f32>(LOGP32 + <usize>row * F32_BYTES));
    store<f32>(LANE_LCLT + <usize>(lane << 2), lclT);
    store<f32>(LANE_LCLP + <usize>(lane << 2), lclP);
    store<f32>(LANE_LCLH + <usize>(lane << 2), lclH);
    store<f32>(LANE_DRYN + <usize>(lane << 2), 1.0 + srcW / <f32>0.622);
    store<f32>(LANE_DRYD + <usize>(lane << 2), 1.0 + srcW);
    store<u8>(LANE_VALID + <usize>lane, 1);
  }

  const srcPv = v128.load(LANE_SRCP);
  const srcHv = v128.load(LANE_SRCH);
  const srcTv = v128.load(LANE_SRCT);
  const logSrcPv = v128.load(LANE_LOGSRCP);
  const lclPv = v128.load(LANE_LCLP);
  const lclHv = v128.load(LANE_LCLH);
  const dryNv = v128.load(LANE_DRYN);
  const dryDv = v128.load(LANE_DRYD);
  const laneValid = i32x4(
    load<u8>(LANE_VALID) ? -1 : 0,
    load<u8>(LANE_VALID, 1) ? -1 : 0,
    load<u8>(LANE_VALID, 2) ? -1 : 0,
    load<u8>(LANE_VALID, 3) ? -1 : 0,
  );

  let cape = f32x4.splat(0.0);
  let cin = f32x4.splat(0.0);
  let positiveSeen = i32x4.splat(0);
  let prevB = f32x4.splat(f32.NaN);
  let prevH = srcHv;
  let lfc = f32x4.splat(f32.NaN);
  let el = f32x4.splat(f32.NaN);
  let satT = v128.load(LANE_LCLT);
  let satH = lclHv;

  for (let row = 1; row < rowCount; row += 1) {
    if (!load<u8>(SEGMENT_VALID_PTR + <usize>row)) {
      continue;
    }
    const midH = f32x4.splat(load<f32>(SMH32 + <usize>row * F32_BYTES));
    const midP = f32x4.splat(load<f32>(SMP32 + <usize>row * F32_BYTES));
    const envTv = f32x4.splat(load<f32>(SETV32 + <usize>row * F32_BYTES));
    const dzSeg = f32x4.splat(load<f32>(SDZ32 + <usize>row * F32_BYTES));
    const logMidP = f32x4.splat(load<f32>(SLOGMP32 + <usize>row * F32_BYTES));
    // per-lane skip: mid at/below origin
    const laneOn = v128.and(
      laneValid,
      v128.and(
        f32x4.gt(midH, f32x4.add(srcHv, f32x4.splat(1.0))),
        f32x4.le(midP, f32x4.add(srcPv, f32x4.splat(1.0))),
      ),
    );
    if (!v128.any_true(laneOn)) {
      continue;
    }
    const belowLcl = f32x4.ge(midP, lclPv);
    const dryBranch = v128.or(belowLcl, f32x4.le(midH, lclHv));
    // dry lift: srcT * exp(RD_OVER_CP * (logMidP - logSrcP))
    const dryT = f32x4.mul(srcTv, vexp4(f32x4.mul(f32x4.splat(0.2854), f32x4.sub(logMidP, logSrcPv))));
    // saturated lift: lockstep Euler from (satT, satH) to midH at midP
    let satNext = satT;
    {
      const dzL = f32x4.max(f32x4.splat(0.0), f32x4.sub(midH, satH));
      const stepsL = f32x4.max(f32x4.splat(1.0), f32x4.ceil(f32x4.div(dzL, f32x4.splat(300.0))));
      const stepDz = f32x4.div(dzL, stepsL);
      const run = v128.and(v128.and(laneOn, v128.not(dryBranch)), f32x4.gt(dzL, f32x4.splat(0.0)));
      if (v128.any_true(run)) {
        const maxSteps = <i32>Mathf.max(
          Mathf.max(f32x4.extract_lane(stepsL, 0), f32x4.extract_lane(stepsL, 1)),
          Mathf.max(f32x4.extract_lane(stepsL, 2), f32x4.extract_lane(stepsL, 3)),
        );
        let t = satT;
        let bad = i32x4.splat(0);
        for (let s = 0; s < maxSteps; s += 1) {
          const active = v128.and(run, f32x4.gt(stepsL, f32x4.splat(<f32>s)));
          if (!v128.any_true(active)) break;
          const tc = f32x4.sub(t, f32x4.splat(273.15));
          const vap = f32x4.mul(f32x4.splat(6.112), vexp4(f32x4.div(f32x4.mul(f32x4.splat(17.67), tc), f32x4.add(tc, f32x4.splat(243.5)))));
          const vapOk = v128.and(f32x4.gt(vap, f32x4.splat(0.0)), f32x4.lt(vap, midP));
          bad = v128.or(bad, v128.and(active, v128.not(vapOk)));
          const w = f32x4.div(f32x4.mul(f32x4.splat(0.622), vap), f32x4.sub(midP, vap));
          const latent = f32x4.div(f32x4.mul(f32x4.splat(2.5e6), w), f32x4.mul(f32x4.splat(287.05), t));
          const denom = f32x4.add(
            f32x4.splat(1004.0),
            f32x4.div(f32x4.mul(f32x4.mul(f32x4.splat(6.25e12), w), f32x4.splat(0.622)), f32x4.mul(f32x4.splat(287.05), f32x4.mul(t, t))),
          );
          const delta = f32x4.mul(f32x4.div(f32x4.mul(f32x4.splat(9.80665), f32x4.add(f32x4.splat(1.0), latent)), denom), stepDz);
          t = f32x4.sub(t, v128.and(delta, active));
        }
        const tBad = v128.or(bad, v128.not(isFiniteMask4(t)));
        satNext = v128.bitselect(f32x4.splat(f32.NaN), t, tBad);
        satNext = v128.bitselect(satNext, satT, run);
      }
    }
    const parcelT = v128.bitselect(dryT, satNext, dryBranch);
    // advance saturated state where the saturated branch produced a finite T
    const satAdvance = v128.and(v128.and(laneOn, v128.not(dryBranch)), isFiniteMask4(parcelT));
    satT = v128.bitselect(parcelT, satT, satAdvance);
    satH = v128.bitselect(midH, satH, satAdvance);
    // parcel virtual temperature
    const tcP = f32x4.sub(parcelT, f32x4.splat(273.15));
    const vapP = f32x4.mul(f32x4.splat(6.112), vexp4(f32x4.div(f32x4.mul(f32x4.splat(17.67), tcP), f32x4.add(tcP, f32x4.splat(243.5)))));
    const vapPOk = v128.and(f32x4.gt(vapP, f32x4.splat(0.0)), f32x4.lt(vapP, midP));
    const ratioP = f32x4.div(f32x4.mul(f32x4.splat(0.622), vapP), f32x4.sub(midP, vapP));
    const satTvRaw = f32x4.div(
      f32x4.mul(parcelT, f32x4.add(f32x4.splat(1.0), f32x4.div(ratioP, f32x4.splat(0.622)))),
      f32x4.add(f32x4.splat(1.0), ratioP),
    );
    const satTvOk = v128.and(vapPOk, isFiniteMask4(satTvRaw));
    const satTvSel = v128.bitselect(satTvRaw, f32x4.splat(f32.NaN), satTvOk);
    const dryTvSel = f32x4.div(f32x4.mul(parcelT, dryNv), dryDv);
    const parcelTv = v128.bitselect(dryTvSel, satTvSel, belowLcl);
    const tvOk = v128.and(v128.and(laneOn, isFiniteMask4(parcelTv)), isFiniteMask4(envTv));
    const buoy = f32x4.div(
      f32x4.mul(f32x4.splat(9.80665), f32x4.sub(parcelTv, envTv)),
      f32x4.max(f32x4.splat(180.0), envTv),
    );
    const energy = f32x4.mul(buoy, dzSeg);
    const atLcl = v128.or(
      f32x4.ge(midH, f32x4.sub(lclHv, f32x4.splat(1.0))),
      f32x4.le(midP, f32x4.add(lclPv, f32x4.splat(0.1))),
    );
    const energyFinite = isFiniteMask4(energy);
    const rowLive = v128.and(tvOk, energyFinite);
    const posBranch = v128.and(rowLive, v128.and(f32x4.gt(energy, f32x4.splat(0.0)), atLcl));
    const notSeen = i32x4.eq(positiveSeen, i32x4.splat(0));
    // LFC crossing where first positive energy appears
    const crossBase = v128.and(isFiniteMask4(prevB), f32x4.le(prevB, f32x4.splat(0.0)));
    const denomB = f32x4.max(f32x4.splat(1e-9), f32x4.sub(buoy, prevB));
    const frac = f32x4.min(f32x4.splat(1.0), f32x4.max(f32x4.splat(0.0), f32x4.div(f32x4.neg(prevB), denomB)));
    const crossInterp = f32x4.add(prevH, f32x4.mul(f32x4.sub(midH, prevH), frac));
    const crossFallback = v128.bitselect(lclHv, midH, f32x4.lt(prevH, lclHv));
    const crossing = v128.bitselect(crossInterp, crossFallback, crossBase);
    const lfcNew = f32x4.max(lclHv, crossing);
    const setLfc = v128.and(posBranch, notSeen);
    lfc = v128.bitselect(lfcNew, lfc, setLfc);
    cape = f32x4.add(cape, v128.and(energy, posBranch));
    const rowHv = f32x4.splat(load<f32>(H32 + <usize>row * F32_BYTES));
    el = v128.bitselect(rowHv, el, posBranch);
    // CIN: else-if — not posBranch, not seen, energy < 0
    const cinBranch = v128.and(
      v128.and(rowLive, v128.not(posBranch)),
      v128.and(notSeen, f32x4.lt(energy, f32x4.splat(0.0))),
    );
    cin = f32x4.add(cin, v128.and(energy, cinBranch));
    // falling-EL: else-if — not pos, not cin, prevB>0 && buoy<=0
    const fallBranch = v128.and(
      v128.and(rowLive, v128.and(v128.not(posBranch), v128.not(cinBranch))),
      v128.and(
        v128.and(isFiniteMask4(prevB), f32x4.gt(prevB, f32x4.splat(0.0))),
        f32x4.le(buoy, f32x4.splat(0.0)),
      ),
    );
    const fracFall = f32x4.min(
      f32x4.splat(1.0),
      f32x4.max(f32x4.splat(0.0), f32x4.div(prevB, f32x4.max(f32x4.splat(1e-9), f32x4.sub(prevB, buoy)))),
    );
    const elFall = f32x4.add(prevH, f32x4.mul(f32x4.sub(midH, prevH), fracFall));
    el = v128.bitselect(elFall, el, fallBranch);
    positiveSeen = v128.or(positiveSeen, posBranch);
    // prev updates only on rows the lane actually processed (tvOk)
    prevB = v128.bitselect(buoy, prevB, tvOk);
    prevH = v128.bitselect(midH, prevH, tvOk);
  }
  const capeOut = f32x4.max(f32x4.splat(0.0), cape);
  const cinOut = f32x4.min(f32x4.splat(0.0), cin);
  for (let lane = 0; lane < laneCount; lane += 1) {
    const slot = <usize>((groupStart + lane) << 2);
    const valid = load<u8>(LANE_VALID + <usize>lane) != 0;
    store<u8>(ORG_VALID + <usize>(groupStart + lane), valid ? 1 : 0);
    store<f32>(ORG_CAPE + slot, valid ? f32x4Lane(capeOut, lane) : f32.NaN);
    store<f32>(ORG_CIN + slot, valid ? f32x4Lane(cinOut, lane) : f32.NaN);
    store<f32>(ORG_EL + slot, valid ? f32x4Lane(el, lane) : f32.NaN);
  }
}

// @ts-ignore: decorator
@inline
function f32x4Lane(v: v128, lane: i32): f32 {
  if (lane == 0) return f32x4.extract_lane(v, 0);
  if (lane == 1) return f32x4.extract_lane(v, 1);
  if (lane == 2) return f32x4.extract_lane(v, 2);
  return f32x4.extract_lane(v, 3);
}

export function runOriginScanF32(
  rowCount: i32,
  sourceDepthHpa: f64,
  sourceStepHpa: f64,
  sourceMaxAglM: f64,
  minCapeJkg: f64,
  minCinJkg: f64,
): i32 {
  const count = rowCount > ROWS_CAP ? ROWS_CAP : rowCount;
  store<f64>(OUT_PTR, 0.0);
  const surfacePressure = <f32>load<f64>(PRESSURE_PTR);
  if (!isFinite(surfacePressure)) {
    return 0;
  }
  prepareSegmentsF32(count);
  // ---- origin collection: same eligibility walk as the sequential scan ----
  const pressureFloor = surfacePressure - <f32>sourceDepthHpa;
  const stepHpa = <f32>sourceStepHpa;
  const maxAgl = <f32>sourceMaxAglM;
  let originCount: i32 = 0;
  let lastScanned: f32 = f32.NaN;
  for (let row = 0; row < count && originCount < ORIGINS_CAP; row += 1) {
    const h = load<f32>(H32 + <usize>row * F32_BYTES);
    const p = load<f32>(P32 + <usize>row * F32_BYTES);
    const t = load<f32>(T32 + <usize>row * F32_BYTES);
    const d = load<f32>(D32 + <usize>row * F32_BYTES);
    if (!isFinite(h) || h > maxAgl || !isFinite(p) || !isFinite(t) || !isFinite(d)) {
      continue;
    }
    if (p < pressureFloor) {
      break;
    }
    if (stepHpa > 0.0 && isFinite(lastScanned) && lastScanned - p < stepHpa) {
      continue;
    }
    lastScanned = p;
    store<i32>(ORG_ROW + <usize>(originCount << 2), row);
    originCount += 1;
  }
  if (originCount == 0) {
    return 0;
  }
  // ---- integrate parcels in lane groups of four ----
  for (let group = 0; group < originCount; group += 4) {
    integrateOriginGroupF32(count, group, originCount - group >= 4 ? 4 : originCount - group);
  }
  // ---- replay the sequential layer selection over per-origin results ----
  let inLayer = false;
  let baseAglM: f32 = f32.NaN;
  let topAglM: f32 = f32.NaN;
  let lastEffective: f32 = f32.NaN;
  let muCape: f32 = <f32>-Infinity;
  let muCin: f32 = f32.NaN;
  let muEl: f32 = f32.NaN;
  for (let origin = 0; origin < originCount; origin += 1) {
    const capeV = load<f32>(ORG_CAPE + <usize>(origin << 2));
    const cinV = load<f32>(ORG_CIN + <usize>(origin << 2));
    const okV = load<u8>(ORG_VALID + <usize>origin) != 0;
    if (!okV || !isFinite(capeV) || !isFinite(cinV)) {
      if (inLayer) {
        break;
      }
      continue;
    }
    if (capeV > muCape) {
      muCape = capeV;
      muCin = cinV;
      muEl = load<f32>(ORG_EL + <usize>(origin << 2));
    }
    const height = load<f32>(H32 + <usize>load<i32>(ORG_ROW + <usize>(origin << 2)) * F32_BYTES);
    const effective = capeV >= <f32>minCapeJkg && cinV >= <f32>minCinJkg;
    if (effective) {
      if (!inLayer) {
        baseAglM = Mathf.max(0.0, height);
        inLayer = true;
      }
      lastEffective = Mathf.max(baseAglM, height);
    } else if (inLayer) {
      topAglM = Mathf.max(baseAglM, lastEffective);
      break;
    }
  }
  if (inLayer && !isFinite(topAglM) && isFinite(lastEffective)) {
    topAglM = Mathf.max(baseAglM, lastEffective);
  }
  if (!isFinite(baseAglM) || !isFinite(topAglM) || !isFinite(muCape)) {
    return 0;
  }
  store<f64>(OUT_PTR, 1.0);
  store<f64>(OUT_PTR, <f64>baseAglM, 8);
  store<f64>(OUT_PTR, <f64>topAglM, 16);
  store<f64>(OUT_PTR, <f64>Mathf.max(0.0, muCape), 24);
  store<f64>(OUT_PTR, <f64>muCin, 32);
  store<f64>(OUT_PTR, <f64>muEl, 40);
  return 1;
}

// ============================================================================
// DCAPE (reduced-profile v4) f32 port — variant "wasm-f32" only.
//
// Scalar single-precision port of severe.calculateReducedProfileDcapeFromSources:
// per-knot dewpoint (Magnus RH form) + Bolton theta-e, insertion sort by
// height, minimum 100-mb layer-mean theta-e source selection, pressure-aware
// Normand wet-bulb at the source midpoint (Wobus saturated lift), and the
// fixed-step pseudoadiabatic Euler descent. Structure, guards, and skip
// rules mirror the JS implementation; precision (f32) and NativeMath are
// the documented deviations. Near-tie theta-e argmin flips are possible at
// ~1e-7 relative and are quantified by the validation suite.
// ============================================================================

export const DCAPE_KNOTS_CAP: i32 = 64;

// ============================================================================
// Hover quantization + int16 delta encode (2026-07-12 Stage D) — EXACT ports.
//
// Unlike the parcel/DCAPE ports above, these carry NO numeric deviation:
// every arithmetic step runs in f64 exactly as V8 executes the JS loops in
// scripts/lib/noaa-beta/hover.js (widened-f32 loads, f64 multiply/add,
// f64.floor, identical clamp comparisons and Int16 truncation), and IEEE 754
// makes those operations bit-deterministic across engines. SIMD is used only
// to classify 8-element blocks (all-finite-in-range fast path, all-non-finite
// fill path) and to run the same f64 lane arithmetic four pairs at a time;
// any block containing a clamp or a mixed finite/non-finite pattern is
// re-run through the scalar element loop so validCount/clampCount/
// nonFiniteCount diagnostics match the JS loops exactly. Byte parity with
// the JS quantizers is asserted by tests-node/hover-quantize-kernel.test.js
// and by the golden-frame fixture.
// ============================================================================

// Chunk capacity (elements) for the quantize input/output buffers. JS feeds
// grids through these buffers in chunks; per-call overhead is ~µs.
export const QUANT_CHUNK: i32 = 32768;

export const QIN_A_PTR: usize = memory.data(131072, 16); // f32 x 32768 (values / wind u)
export const QIN_B_PTR: usize = memory.data(131072, 16); // f32 x 32768 (wind v)
export const QOUT_PTR: usize = memory.data(65536, 16); // i16 x 32768
// i32 slots: 0 validCount, 1 clampCount, 2 nonFiniteCount (per call)
export const QSTATS_PTR: usize = memory.data(16, 16);

const HOVER_MISSING: i16 = -32768;

// Widen the four f32 lanes of `v` into two f64x2 vectors (low pair, high pair).
// @ts-ignore: decorator
@inline
function promoteHigh(v: v128): v128 {
  return f64x2.promote_low_f32x4(i8x16.shuffle(v, v, 8, 9, 10, 11, 12, 13, 14, 15, 8, 9, 10, 11, 12, 13, 14, 15));
}

// finite mask for f32 lanes: |v| < +inf (NaN and ±inf compare false)
// @ts-ignore: decorator
@inline
function finiteMaskF32(v: v128): v128 {
  return f32x4.lt(f32x4.abs(v), f32x4.splat(<f32>Infinity));
}

// Quantize two f64x2 pairs (4 elements). When every lane is in-range (no
// clamp) writes the four results as an i32x4 to the given scratch slot and
// returns true; the caller narrows two such slots into one i16x8 store.
const Q8_SCRATCH_A: usize = memory.data(16, 16);
const Q8_SCRATCH_B: usize = memory.data(16, 16);

// @ts-ignore: decorator
@inline
function quantizePairsInRange(lo: v128, hi: v128, mult: v128, slot: usize): bool {
  const half = f64x2.splat(0.5);
  const qlo = f64x2.floor(f64x2.add(f64x2.mul(lo, mult), half));
  const qhi = f64x2.floor(f64x2.add(f64x2.mul(hi, mult), half));
  const limitLo = f64x2.splat(-32767.0);
  const limitHi = f64x2.splat(32767.0);
  const outLo = v128.or(f64x2.lt(qlo, limitLo), f64x2.gt(qlo, limitHi));
  const outHi = v128.or(f64x2.lt(qhi, limitLo), f64x2.gt(qhi, limitHi));
  if (v128.any_true(v128.or(outLo, outHi))) {
    return false;
  }
  const ilo = i32x4.trunc_sat_f64x2_s_zero(qlo); // [l0, l1, 0, 0]
  const ihi = i32x4.trunc_sat_f64x2_s_zero(qhi);
  // [l0, l1, h0, h1] as i32x4
  v128.store(slot, i8x16.shuffle(ilo, ihi, 0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23));
  return true;
}

// hover.quantizeHoverRawValues (exact). Reads count f32 values from QIN_A,
// writes count i16 to QOUT, stats to QSTATS.
export function quantizeRawF64(count: i32, quantizeMultiplier: f64): void {
  const n = count > QUANT_CHUNK ? QUANT_CHUNK : count;
  let valid: i64 = 0;
  let packedCounts: i64 = 0; // (valid) + (clamp << 20) + (nonFinite << 40) accumulator for scalar path
  const mult2 = f64x2.splat(quantizeMultiplier);
  let index = 0;
  const blockEnd = n & ~7;
  const missing8 = i16x8.splat(HOVER_MISSING);
  while (index < blockEnd) {
    const a = v128.load(QIN_A_PTR + (<usize>index << 2));
    const b = v128.load(QIN_A_PTR + (<usize>index << 2) + 16);
    const fa = finiteMaskF32(a);
    const fb = finiteMaskF32(b);
    const allFinite = i32x4.all_true(fa) && i32x4.all_true(fb);
    if (allFinite) {
      if (
        quantizePairsInRange(f64x2.promote_low_f32x4(a), promoteHigh(a), mult2, Q8_SCRATCH_A) &&
        quantizePairsInRange(f64x2.promote_low_f32x4(b), promoteHigh(b), mult2, Q8_SCRATCH_B)
      ) {
        // Both i32x4 slots are within ±32767, so the saturating narrow is exact.
        v128.store(
          QOUT_PTR + (<usize>index << 1),
          i16x8.narrow_i32x4_s(v128.load(Q8_SCRATCH_A), v128.load(Q8_SCRATCH_B)),
        );
        valid += 8;
        index += 8;
        continue;
      }
    } else if (!v128.any_true(v128.or(fa, fb))) {
      v128.store(QOUT_PTR + (<usize>index << 1), missing8);
      packedCounts += <i64>8 << 40;
      index += 8;
      continue;
    }
    // mixed / clamped block: exact scalar replay of the 8 elements
    for (let k = 0; k < 8; k += 1) {
      const value = <f64>load<f32>(QIN_A_PTR + (<usize>(index + k) << 2));
      packedCounts += quantizeScalarPacked(QOUT_PTR + (<usize>(index + k) << 1), value, quantizeMultiplier);
    }
    index += 8;
  }
  for (; index < n; index += 1) {
    const value = <f64>load<f32>(QIN_A_PTR + (<usize>index << 2));
    packedCounts += quantizeScalarPacked(QOUT_PTR + (<usize>index << 1), value, quantizeMultiplier);
  }
  store<i32>(QSTATS_PTR, <i32>(valid + (packedCounts & 0xfffff)));
  store<i32>(QSTATS_PTR + 4, <i32>((packedCounts >> 20) & 0xfffff));
  store<i32>(QSTATS_PTR + 8, <i32>((packedCounts >> 40) & 0xfffff));
}

// Scalar element with packed counter deltas: valid | clamp<<20 | nonFinite<<40.
// @ts-ignore: decorator
@inline
function quantizeScalarPacked(outPtr: usize, value: f64, quantizeMultiplier: f64): i64 {
  if (!isFinite(value)) {
    store<i16>(outPtr, HOVER_MISSING);
    return <i64>1 << 40;
  }
  const quantized = Math.floor(value * quantizeMultiplier + 0.5);
  if (quantized < -32767.0) {
    store<i16>(outPtr, -32767);
    return (<i64>1 << 20) | 1;
  }
  if (quantized > 32767.0) {
    store<i16>(outPtr, 32767);
    return (<i64>1 << 20) | 1;
  }
  store<i16>(outPtr, <i16><i32>quantized);
  return 1;
}

// hover.quantizeHoverAffineValues (exact): value*scale+offset, optional min
// clamp BEFORE the finite gate (so -inf inputs clamp to a finite min exactly
// like the JS loop), then the shared quantize step.
export function quantizeAffineF64(
  count: i32,
  quantizeMultiplier: f64,
  affineScale: f64,
  affineOffset: f64,
  hasMin: i32,
  affineMin: f64,
): void {
  const n = count > QUANT_CHUNK ? QUANT_CHUNK : count;
  let valid: i64 = 0;
  let packedCounts: i64 = 0;
  const mult2 = f64x2.splat(quantizeMultiplier);
  const scale2 = f64x2.splat(affineScale);
  const offset2 = f64x2.splat(affineOffset);
  const min2 = f64x2.splat(affineMin);
  const applyMin = hasMin != 0;
  let index = 0;
  const blockEnd = n & ~7;
  while (index < blockEnd) {
    const a = v128.load(QIN_A_PTR + (<usize>index << 2));
    const b = v128.load(QIN_A_PTR + (<usize>index << 2) + 16);
    // Transform in f64 lanes, then classify on the transformed values.
    let t0 = f64x2.add(f64x2.mul(f64x2.promote_low_f32x4(a), scale2), offset2);
    let t1 = f64x2.add(f64x2.mul(promoteHigh(a), scale2), offset2);
    let t2 = f64x2.add(f64x2.mul(f64x2.promote_low_f32x4(b), scale2), offset2);
    let t3 = f64x2.add(f64x2.mul(promoteHigh(b), scale2), offset2);
    if (applyMin) {
      t0 = v128.bitselect(min2, t0, f64x2.lt(t0, min2));
      t1 = v128.bitselect(min2, t1, f64x2.lt(t1, min2));
      t2 = v128.bitselect(min2, t2, f64x2.lt(t2, min2));
      t3 = v128.bitselect(min2, t3, f64x2.lt(t3, min2));
    }
    const inf2 = f64x2.splat(Infinity);
    const f0 = f64x2.lt(f64x2.abs(t0), inf2);
    const f1 = f64x2.lt(f64x2.abs(t1), inf2);
    const f2 = f64x2.lt(f64x2.abs(t2), inf2);
    const f3 = f64x2.lt(f64x2.abs(t3), inf2);
    const allFinite = i64x2.all_true(f0) && i64x2.all_true(f1) && i64x2.all_true(f2) && i64x2.all_true(f3);
    if (allFinite) {
      if (quantizePairsInRange(t0, t1, mult2, Q8_SCRATCH_A) && quantizePairsInRange(t2, t3, mult2, Q8_SCRATCH_B)) {
        v128.store(
          QOUT_PTR + (<usize>index << 1),
          i16x8.narrow_i32x4_s(v128.load(Q8_SCRATCH_A), v128.load(Q8_SCRATCH_B)),
        );
        valid += 8;
        index += 8;
        continue;
      }
    }
    for (let k = 0; k < 8; k += 1) {
      let value = <f64>load<f32>(QIN_A_PTR + (<usize>(index + k) << 2)) * affineScale + affineOffset;
      if (applyMin && value < affineMin) {
        value = affineMin;
      }
      packedCounts += quantizeScalarPacked(QOUT_PTR + (<usize>(index + k) << 1), value, quantizeMultiplier);
    }
    index += 8;
  }
  for (; index < n; index += 1) {
    let value = <f64>load<f32>(QIN_A_PTR + (<usize>index << 2)) * affineScale + affineOffset;
    if (applyMin && value < affineMin) {
      value = affineMin;
    }
    packedCounts += quantizeScalarPacked(QOUT_PTR + (<usize>index << 1), value, quantizeMultiplier);
  }
  store<i32>(QSTATS_PTR, <i32>(valid + (packedCounts & 0xfffff)));
  store<i32>(QSTATS_PTR + 4, <i32>((packedCounts >> 20) & 0xfffff));
  store<i32>(QSTATS_PTR + 8, <i32>((packedCounts >> 40) & 0xfffff));
}

// hover.quantizeHoverWindGridVariable's inner loop (exact): missing when
// either component is non-finite; otherwise sqrt(u²+v²)*multiplier with NO
// post-compute finite gate (an overflow to +inf clamps to 32767 and counts
// as valid+clamp, exactly like the JS loop). f64.sqrt is IEEE-exact.
export function quantizeWindF64(count: i32, quantizeMultiplier: f64, speedMultiplier: f64): void {
  const n = count > QUANT_CHUNK ? QUANT_CHUNK : count;
  let valid: i64 = 0;
  let packedCounts: i64 = 0;
  const mult2 = f64x2.splat(quantizeMultiplier);
  const speed2 = f64x2.splat(speedMultiplier);
  let index = 0;
  const blockEnd = n & ~7;
  const missing8 = i16x8.splat(HOVER_MISSING);
  while (index < blockEnd) {
    const ua = v128.load(QIN_A_PTR + (<usize>index << 2));
    const ub = v128.load(QIN_A_PTR + (<usize>index << 2) + 16);
    const va = v128.load(QIN_B_PTR + (<usize>index << 2));
    const vb = v128.load(QIN_B_PTR + (<usize>index << 2) + 16);
    const fa = v128.and(finiteMaskF32(ua), finiteMaskF32(va));
    const fb = v128.and(finiteMaskF32(ub), finiteMaskF32(vb));
    const allFinite = i32x4.all_true(fa) && i32x4.all_true(fb);
    if (allFinite) {
      const u0 = f64x2.promote_low_f32x4(ua);
      const u1 = promoteHigh(ua);
      const u2 = f64x2.promote_low_f32x4(ub);
      const u3 = promoteHigh(ub);
      const v0 = f64x2.promote_low_f32x4(va);
      const v1 = promoteHigh(va);
      const v2 = f64x2.promote_low_f32x4(vb);
      const v3 = promoteHigh(vb);
      const s0 = f64x2.mul(f64x2.sqrt(f64x2.add(f64x2.mul(u0, u0), f64x2.mul(v0, v0))), speed2);
      const s1 = f64x2.mul(f64x2.sqrt(f64x2.add(f64x2.mul(u1, u1), f64x2.mul(v1, v1))), speed2);
      const s2 = f64x2.mul(f64x2.sqrt(f64x2.add(f64x2.mul(u2, u2), f64x2.mul(v2, v2))), speed2);
      const s3 = f64x2.mul(f64x2.sqrt(f64x2.add(f64x2.mul(u3, u3), f64x2.mul(v3, v3))), speed2);
      if (quantizePairsInRange(s0, s1, mult2, Q8_SCRATCH_A) && quantizePairsInRange(s2, s3, mult2, Q8_SCRATCH_B)) {
        v128.store(
          QOUT_PTR + (<usize>index << 1),
          i16x8.narrow_i32x4_s(v128.load(Q8_SCRATCH_A), v128.load(Q8_SCRATCH_B)),
        );
        valid += 8;
        index += 8;
        continue;
      }
    } else if (!v128.any_true(v128.or(fa, fb))) {
      v128.store(QOUT_PTR + (<usize>index << 1), missing8);
      packedCounts += <i64>8 << 40;
      index += 8;
      continue;
    }
    for (let k = 0; k < 8; k += 1) {
      packedCounts += quantizeWindScalarPacked(index + k, quantizeMultiplier, speedMultiplier);
    }
    index += 8;
  }
  for (; index < n; index += 1) {
    packedCounts += quantizeWindScalarPacked(index, quantizeMultiplier, speedMultiplier);
  }
  store<i32>(QSTATS_PTR, <i32>(valid + (packedCounts & 0xfffff)));
  store<i32>(QSTATS_PTR + 4, <i32>((packedCounts >> 20) & 0xfffff));
  store<i32>(QSTATS_PTR + 8, <i32>((packedCounts >> 40) & 0xfffff));
}

// @ts-ignore: decorator
@inline
function quantizeWindScalarPacked(index: i32, quantizeMultiplier: f64, speedMultiplier: f64): i64 {
  const u = <f64>load<f32>(QIN_A_PTR + (<usize>index << 2));
  const v = <f64>load<f32>(QIN_B_PTR + (<usize>index << 2));
  const outPtr = QOUT_PTR + (<usize>index << 1);
  if (!isFinite(u) || !isFinite(v)) {
    store<i16>(outPtr, HOVER_MISSING);
    return <i64>1 << 40;
  }
  const value = Math.sqrt(u * u + v * v) * speedMultiplier;
  const quantized = Math.floor(value * quantizeMultiplier + 0.5);
  if (quantized < -32767.0) {
    store<i16>(outPtr, -32767);
    return (<i64>1 << 20) | 1;
  }
  if (quantized > 32767.0) {
    store<i16>(outPtr, 32767);
    return (<i64>1 << 20) | 1;
  }
  store<i16>(outPtr, <i16><i32>quantized);
  return 1;
}

// ============================================================================
// Continuous RGBA colorizer (2026-07-23 Stage H) — EXACT f64 port.
//
// This is the hot raw/affine continuous lookup loop from
// scripts/lib/noaa-beta/raster.js. Inputs remain f32 source grids, while
// transform, visibility, lookup position, and bucket arithmetic use f64 in
// the same order as JavaScript. The output is copied by JS into an owned
// Buffer before this thread-local scratch can be reused.
//
// QIN_A is shared with hover quantization because both drivers are
// synchronous and non-reentrant. The dedicated RGBA output and palette add
// only 384 KiB plus counters per kernel instance.
// ============================================================================

export const COLOR_CHUNK: i32 = QUANT_CHUNK;
export const COLOR_PALETTE_CAP: i32 = 65536;
export const COLORIZER_ABI_VERSION: i32 = 1;
export const COLOR_OUT_PTR: usize = memory.data(131072, 16); // RGBA8 x 32768
export const COLOR_PALETTE_PTR: usize = memory.data(262144, 16); // RGBA8 x 65536
export const COLOR_STATS_PTR: usize = memory.data(8, 8); // visibleCount, validCount

export function colorizeContinuousF64(
  count: i32,
  paletteSize: i32,
  lookupMin: f64,
  lookupScale: f64,
  hasVisibleMin: i32,
  visibleMin: f64,
  hasVisibleMax: i32,
  visibleMax: f64,
  affineScale: f64,
  affineOffset: f64,
  affineHasMin: i32,
  affineMin: f64,
): void {
  const n = count <= 0 ? 0 : count > COLOR_CHUNK ? COLOR_CHUNK : count;
  const resolvedPaletteSize =
    paletteSize <= 0 ? 0 : paletteSize > COLOR_PALETTE_CAP ? COLOR_PALETTE_CAP : paletteSize;
  memory.fill(COLOR_OUT_PTR, 0, <usize>n * 4);
  if (n <= 0 || resolvedPaletteSize <= 0) {
    store<i32>(COLOR_STATS_PTR, 0);
    store<i32>(COLOR_STATS_PTR + 4, 0);
    return;
  }
  const lastBucket = resolvedPaletteSize - 1;
  const applyVisibleMin = hasVisibleMin != 0;
  const applyVisibleMax = hasVisibleMax != 0;
  const applyAffineMin = affineHasMin != 0;
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < n; index += 1) {
    let value = <f64>load<f32>(QIN_A_PTR + (<usize>index << 2));
    value = value * affineScale + affineOffset;
    if (applyAffineMin && value < affineMin) {
      value = affineMin;
    }
    if (!isFinite(value)) {
      continue;
    }
    validCount += 1;
    if (applyVisibleMin && value < visibleMin) {
      continue;
    }
    if (applyVisibleMax && value > visibleMax) {
      continue;
    }
    const position = (value - lookupMin) * lookupScale;
    const bucket =
      position <= 0.0 ? 0 : position >= 1.0 ? lastBucket : <i32>Math.floor(position * <f64>lastBucket);
    const color = load<u32>(COLOR_PALETTE_PTR + (<usize>bucket << 2));
    if ((color >>> 24) == 0) {
      continue;
    }
    store<u32>(COLOR_OUT_PTR + (<usize>index << 2), color);
    visibleCount += 1;
  }
  store<i32>(COLOR_STATS_PTR, visibleCount);
  store<i32>(COLOR_STATS_PTR + 4, validCount);
}

// ============================================================================
// Effective-layer product glue (2026-07-12 Stage G1) — f64 NativeMath port
// of the post-fill chain in severe.calculateEffectiveLayerProductsFromSources:
// profile-wind interpolators (height + log-pressure), pressure-bracket
// binary search, Simpson mean winds, Bunkers storm motion (default +
// effective-layer variant), storm-relative helicity, the 100-mb mixed-layer
// parcel (theta/mixing-ratio Simpson integral + Bolton LCL), the segment
// parcel for the STP 100-mb prototype (reusing segmentParcel above), and
// the SCP/STP composite formulas. Structure, guards, operation order, and
// NaN/null semantics mirror scripts/lib/noaa-beta/{profile-wind,severe}.js
// line for line; NativeMath transcendentals (log/exp/pow/hypot, <=1 ulp vs
// V8's) are the only numeric difference — same contract as the f64 scan
// port, validated by fuzz + real-frame quantification.
// ============================================================================

// util.MPS_TO_KT / profile-wind.BUNKERS_RIGHT_MOVER_DEVIATION_MPS /
// severe.MIXED_LAYER_PARCEL_DEPTH_HPA, copied verbatim.
const MPS_TO_KT: f64 = 1.943844;
const BUNKERS_RIGHT_MOVER_DEVIATION_MPS: f64 = 7.5;
const MIXED_LAYER_PARCEL_DEPTH_HPA: f64 = 100.0;

// Wind rows (filled by the JS profile-row fill exactly like the thermo rows).
export const ROW_U_PTR: usize = memory.data(512, 8);
export const ROW_V_PTR: usize = memory.data(512, 8);

// Product outputs: 0 scp, 1 stp, 2 stp100mbReduced (NaN = not computed).
export const EP_OUT_PTR: usize = memory.data(24, 8);
export const EP_OUT_SLOTS: i32 = 3;

// Internal scratch: wind vectors (u, v) for interpolation results.
const WIND_BASE: usize = memory.data(16, 8);
const WIND_TOP: usize = memory.data(16, 8);
const WIND_TMP: usize = memory.data(16, 8);
const STORM_OUT: usize = memory.data(16, 8);
const MEANWIND_OUT: usize = memory.data(16, 8);
// Thermo interpolation result: pressure, height, temp, dewpoint.
const THERMO_OUT: usize = memory.data(32, 8);
// Mean-wind Simpson samples (rowCount + 2 <= 66 slots).
const MW_P: usize = memory.data(528, 8);
const MW_U: usize = memory.data(528, 8);
const MW_V: usize = memory.data(528, 8);
// Mixed-layer Simpson samples.
const MLS_P: usize = memory.data(528, 8);
const MLS_TH: usize = memory.data(528, 8);
const MLS_R: usize = memory.data(528, 8);
// Mixed-layer sample result: theta, ratio.
const MLSAMPLE_OUT: usize = memory.data(16, 8);
const ML_PROPS_OUT: usize = memory.data(24, 8); // pressure, temp, dewpoint
const EP_PARCEL_OUT: usize = memory.data(40, 8); // cape, cin, lcl, lfc, el

// @ts-ignore: decorator
@inline
function rowUAt(row: i32): f64 {
  return load<f64>(ROW_U_PTR + <usize>row * F64_BYTES);
}

// @ts-ignore: decorator
@inline
function rowVAt(row: i32): f64 {
  return load<f64>(ROW_V_PTR + <usize>row * F64_BYTES);
}

// profile-wind.logPressureInterpolationFraction
function logPressureFraction(target: f64, lower: f64, upper: f64): f64 {
  if (!isFinite(target) || !isFinite(lower) || !isFinite(upper) || target <= 0.0 || lower <= 0.0 || upper <= 0.0) {
    return NaN;
  }
  const denominator = Math.log(upper) - Math.log(lower);
  if (!isFinite(denominator) || Math.abs(denominator) < 1e-9) {
    return NaN;
  }
  return (Math.log(target) - Math.log(lower)) / denominator;
}

// profile-wind.updateScratchPressureBrackets predicate (recomputed per
// product call; identical to the JS flag for a freshly filled scratch).
function pressureBracketsValidFor(rowCount: i32): bool {
  let valid = rowCount > 0;
  let previous: f64 = Infinity;
  for (let row = 0; row < rowCount; row += 1) {
    const pressure = pressureAt(row);
    if (!isFinite(pressure) || pressure <= 0.0 || !(previous - pressure > 2e-6)) {
      valid = false;
      break;
    }
    previous = pressure;
  }
  return valid;
}

// profile-wind.findPressureBracketUpperRow
function findBracketUpperRow(rowCount: i32, targetPressure: f64): i32 {
  let lo = 0;
  let hi = rowCount - 1;
  let result = rowCount;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pressureAt(mid) <= targetPressure) {
      result = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return result;
}

// profile-wind.interpolateProfileWindRows → writes u,v to outPtr, returns found.
function interpWindAtHeight(rowCount: i32, targetHeight: f64, outPtr: usize): bool {
  if (!isFinite(targetHeight) || rowCount <= 0) {
    return false;
  }
  let lowerRow = -1;
  for (let row = 0; row < rowCount; row += 1) {
    const height = heightAt(row);
    const u = rowUAt(row);
    const v = rowVAt(row);
    if (!isFinite(height) || !isFinite(u) || !isFinite(v)) {
      continue;
    }
    if (height == targetHeight) {
      store<f64>(outPtr, u);
      store<f64>(outPtr + 8, v);
      return true;
    }
    if (height < targetHeight) {
      lowerRow = row;
      continue;
    }
    if (lowerRow < 0) {
      return false;
    }
    const lowerHeight = heightAt(lowerRow);
    const fraction = clamp01((targetHeight - lowerHeight) / Math.max(1e-9, height - lowerHeight));
    store<f64>(outPtr, rowUAt(lowerRow) + (u - rowUAt(lowerRow)) * fraction);
    store<f64>(outPtr + 8, rowVAt(lowerRow) + (v - rowVAt(lowerRow)) * fraction);
    return true;
  }
  return false;
}

// profile-wind.interpolateProfilePressureRows
function interpPressureAtHeight(rowCount: i32, targetHeight: f64): f64 {
  if (!isFinite(targetHeight) || rowCount <= 0) {
    return NaN;
  }
  let lowerRow = -1;
  for (let row = 0; row < rowCount; row += 1) {
    const height = heightAt(row);
    const pressure = pressureAt(row);
    if (!isFinite(height) || !isFinite(pressure) || pressure <= 0.0) {
      continue;
    }
    if (height == targetHeight) {
      return pressure;
    }
    if (height < targetHeight) {
      lowerRow = row;
      continue;
    }
    if (lowerRow < 0) {
      return NaN;
    }
    const lowerHeight = heightAt(lowerRow);
    const lowerPressure = pressureAt(lowerRow);
    if (!isFinite(lowerHeight) || !isFinite(lowerPressure) || lowerPressure <= 0.0) {
      return NaN;
    }
    const fraction = clamp01((targetHeight - lowerHeight) / Math.max(1e-9, height - lowerHeight));
    return Math.exp(Math.log(lowerPressure) + (Math.log(pressure) - Math.log(lowerPressure)) * fraction);
  }
  return NaN;
}

// profile-wind.interpolateProfileWindAtPressureRows
function interpWindAtPressure(rowCount: i32, targetPressure: f64, bracketsValid: bool, outPtr: usize): bool {
  if (!isFinite(targetPressure) || targetPressure <= 0.0 || rowCount <= 0) {
    return false;
  }
  if (bracketsValid) {
    const upperRow = findBracketUpperRow(rowCount, targetPressure);
    let matchRow = -1;
    if (upperRow < rowCount && Math.abs(pressureAt(upperRow) - targetPressure) < 1e-6) {
      matchRow = upperRow;
    } else if (upperRow > 0 && Math.abs(pressureAt(upperRow - 1) - targetPressure) < 1e-6) {
      matchRow = upperRow - 1;
    }
    if (matchRow >= 0) {
      const u = rowUAt(matchRow);
      const v = rowVAt(matchRow);
      if (isFinite(u) && isFinite(v)) {
        store<f64>(outPtr, u);
        store<f64>(outPtr + 8, v);
        return true;
      }
      return false;
    }
    if (upperRow <= 0 || upperRow >= rowCount) {
      return false;
    }
    const lowerU = rowUAt(upperRow - 1);
    const lowerV = rowVAt(upperRow - 1);
    const upperU = rowUAt(upperRow);
    const upperV = rowVAt(upperRow);
    if (!isFinite(lowerU) || !isFinite(lowerV) || !isFinite(upperU) || !isFinite(upperV)) {
      return false;
    }
    const t = clamp01(logPressureFraction(targetPressure, pressureAt(upperRow - 1), pressureAt(upperRow)));
    store<f64>(outPtr, lowerU + (upperU - lowerU) * t);
    store<f64>(outPtr + 8, lowerV + (upperV - lowerV) * t);
    return true;
  }
  for (let row = 0; row < rowCount; row += 1) {
    if (Math.abs(pressureAt(row) - targetPressure) < 1e-6) {
      const u = rowUAt(row);
      const v = rowVAt(row);
      if (isFinite(u) && isFinite(v)) {
        store<f64>(outPtr, u);
        store<f64>(outPtr + 8, v);
        return true;
      }
      return false;
    }
  }
  for (let row = 1; row < rowCount; row += 1) {
    const lowerPressure = pressureAt(row - 1);
    const upperPressure = pressureAt(row);
    if (!isFinite(lowerPressure) || !isFinite(upperPressure) || lowerPressure <= 0.0 || upperPressure <= 0.0) {
      continue;
    }
    const brackets =
      (lowerPressure >= targetPressure && upperPressure <= targetPressure) ||
      (lowerPressure <= targetPressure && upperPressure >= targetPressure);
    if (!brackets) {
      continue;
    }
    const lowerU = rowUAt(row - 1);
    const lowerV = rowVAt(row - 1);
    const upperU = rowUAt(row);
    const upperV = rowVAt(row);
    if (!isFinite(lowerU) || !isFinite(lowerV) || !isFinite(upperU) || !isFinite(upperV)) {
      continue;
    }
    const t = clamp01(logPressureFraction(targetPressure, lowerPressure, upperPressure));
    store<f64>(outPtr, lowerU + (upperU - lowerU) * t);
    store<f64>(outPtr + 8, lowerV + (upperV - lowerV) * t);
    return true;
  }
  return false;
}

// profile-wind.interpolateProfileThermoAtPressureRows → THERMO_OUT
// (pressure, height, temp, dewpoint), returns found.
function interpThermoAtPressure(rowCount: i32, targetPressure: f64, bracketsValid: bool): bool {
  if (!isFinite(targetPressure) || targetPressure <= 0.0 || rowCount <= 0) {
    return false;
  }
  if (bracketsValid) {
    const upperRow = findBracketUpperRow(rowCount, targetPressure);
    let matchRow = -1;
    if (upperRow < rowCount && Math.abs(pressureAt(upperRow) - targetPressure) < 1e-6) {
      matchRow = upperRow;
    } else if (upperRow > 0 && Math.abs(pressureAt(upperRow - 1) - targetPressure) < 1e-6) {
      matchRow = upperRow - 1;
    }
    if (matchRow >= 0) {
      store<f64>(THERMO_OUT, targetPressure);
      store<f64>(THERMO_OUT + 8, heightAt(matchRow));
      store<f64>(THERMO_OUT + 16, tempAt(matchRow));
      store<f64>(THERMO_OUT + 24, dewpointAt(matchRow));
      return true;
    }
    if (upperRow <= 0 || upperRow >= rowCount) {
      return false;
    }
    const t = clamp01(logPressureFraction(targetPressure, pressureAt(upperRow - 1), pressureAt(upperRow)));
    store<f64>(THERMO_OUT, targetPressure);
    store<f64>(THERMO_OUT + 8, heightAt(upperRow - 1) + (heightAt(upperRow) - heightAt(upperRow - 1)) * t);
    store<f64>(THERMO_OUT + 16, tempAt(upperRow - 1) + (tempAt(upperRow) - tempAt(upperRow - 1)) * t);
    store<f64>(THERMO_OUT + 24, dewpointAt(upperRow - 1) + (dewpointAt(upperRow) - dewpointAt(upperRow - 1)) * t);
    return true;
  }
  for (let row = 0; row < rowCount; row += 1) {
    if (Math.abs(pressureAt(row) - targetPressure) < 1e-6) {
      store<f64>(THERMO_OUT, targetPressure);
      store<f64>(THERMO_OUT + 8, heightAt(row));
      store<f64>(THERMO_OUT + 16, tempAt(row));
      store<f64>(THERMO_OUT + 24, dewpointAt(row));
      return true;
    }
  }
  for (let row = 1; row < rowCount; row += 1) {
    const lowerPressure = pressureAt(row - 1);
    const upperPressure = pressureAt(row);
    if (!isFinite(lowerPressure) || !isFinite(upperPressure) || lowerPressure <= 0.0 || upperPressure <= 0.0) {
      continue;
    }
    const brackets =
      (lowerPressure >= targetPressure && upperPressure <= targetPressure) ||
      (lowerPressure <= targetPressure && upperPressure >= targetPressure);
    if (!brackets) {
      continue;
    }
    const t = clamp01(logPressureFraction(targetPressure, lowerPressure, upperPressure));
    store<f64>(THERMO_OUT, targetPressure);
    store<f64>(THERMO_OUT + 8, heightAt(row - 1) + (heightAt(row) - heightAt(row - 1)) * t);
    store<f64>(THERMO_OUT + 16, tempAt(row - 1) + (tempAt(row) - tempAt(row - 1)) * t);
    store<f64>(THERMO_OUT + 24, dewpointAt(row - 1) + (dewpointAt(row) - dewpointAt(row - 1)) * t);
    return true;
  }
  return false;
}

// profile-wind addSample closure body (dedupe + bounds), returns new count.
function meanWindAddSample(sampleCount: i32, bottomPressure: f64, topPressure: f64, pressureHpa: f64, u: f64, v: f64): i32 {
  if (!isFinite(pressureHpa) || !isFinite(u) || !isFinite(v)) {
    return sampleCount;
  }
  if (pressureHpa > bottomPressure + 1e-6 || pressureHpa < topPressure - 1e-6) {
    return sampleCount;
  }
  for (let existing = 0; existing < sampleCount; existing += 1) {
    if (Math.abs(load<f64>(MW_P + <usize>existing * F64_BYTES) - pressureHpa) < 1e-6) {
      return sampleCount;
    }
  }
  store<f64>(MW_P + <usize>sampleCount * F64_BYTES, pressureHpa);
  store<f64>(MW_U + <usize>sampleCount * F64_BYTES, u);
  store<f64>(MW_V + <usize>sampleCount * F64_BYTES, v);
  return sampleCount + 1;
}

// profile-wind.calculateMeanWindByPressureFromRows → MEANWIND_OUT (u, v).
function meanWindByPressure(
  rowCount: i32,
  bottomPressureHpa: f64,
  topPressureHpa: f64,
  pressureWeighted: bool,
  bracketsValid: bool,
): bool {
  if (!isFinite(bottomPressureHpa) || !isFinite(topPressureHpa) || bottomPressureHpa <= topPressureHpa) {
    return false;
  }
  if (!interpWindAtPressure(rowCount, bottomPressureHpa, bracketsValid, WIND_TMP)) {
    return false;
  }
  const bottomU = load<f64>(WIND_TMP);
  const bottomV = load<f64>(WIND_TMP + 8);
  if (!interpWindAtPressure(rowCount, topPressureHpa, bracketsValid, WIND_TMP)) {
    return false;
  }
  const topU = load<f64>(WIND_TMP);
  const topV = load<f64>(WIND_TMP + 8);
  // profile-wind.isFiniteWindVector on both endpoints: a bracket whose
  // log-pressure fraction degenerates to NaN yields found=true with NaN
  // components, which the JS reference rejects before sampling.
  if (!isFinite(bottomU) || !isFinite(bottomV) || !isFinite(topU) || !isFinite(topV)) {
    return false;
  }
  let sampleCount = meanWindAddSample(0, bottomPressureHpa, topPressureHpa, bottomPressureHpa, bottomU, bottomV);
  for (let row = 0; row < rowCount; row += 1) {
    const pressure = pressureAt(row);
    if (!isFinite(pressure) || pressure >= bottomPressureHpa || pressure <= topPressureHpa) {
      continue;
    }
    sampleCount = meanWindAddSample(sampleCount, bottomPressureHpa, topPressureHpa, pressure, rowUAt(row), rowVAt(row));
  }
  sampleCount = meanWindAddSample(sampleCount, bottomPressureHpa, topPressureHpa, topPressureHpa, topU, topV);
  // descending insertion sort (accepted pressures pairwise >= 1e-6 apart)
  for (let index = 1; index < sampleCount; index += 1) {
    const pressure = load<f64>(MW_P + <usize>index * F64_BYTES);
    const u = load<f64>(MW_U + <usize>index * F64_BYTES);
    const v = load<f64>(MW_V + <usize>index * F64_BYTES);
    let cursor = index - 1;
    while (cursor >= 0 && load<f64>(MW_P + <usize>cursor * F64_BYTES) < pressure) {
      store<f64>(MW_P + <usize>(cursor + 1) * F64_BYTES, load<f64>(MW_P + <usize>cursor * F64_BYTES));
      store<f64>(MW_U + <usize>(cursor + 1) * F64_BYTES, load<f64>(MW_U + <usize>cursor * F64_BYTES));
      store<f64>(MW_V + <usize>(cursor + 1) * F64_BYTES, load<f64>(MW_V + <usize>cursor * F64_BYTES));
      cursor -= 1;
    }
    store<f64>(MW_P + <usize>(cursor + 1) * F64_BYTES, pressure);
    store<f64>(MW_U + <usize>(cursor + 1) * F64_BYTES, u);
    store<f64>(MW_V + <usize>(cursor + 1) * F64_BYTES, v);
  }
  let sumU: f64 = 0.0;
  let sumV: f64 = 0.0;
  let totalWeight: f64 = 0.0;
  for (let index = 1; index < sampleCount; index += 1) {
    const lowerP = load<f64>(MW_P + <usize>(index - 1) * F64_BYTES);
    const upperP = load<f64>(MW_P + <usize>index * F64_BYTES);
    const dp = lowerP - upperP;
    if (!isFinite(dp) || dp <= 0.0) {
      continue;
    }
    const lowerU = load<f64>(MW_U + <usize>(index - 1) * F64_BYTES);
    const lowerV = load<f64>(MW_V + <usize>(index - 1) * F64_BYTES);
    const upperU = load<f64>(MW_U + <usize>index * F64_BYTES);
    const upperV = load<f64>(MW_V + <usize>index * F64_BYTES);
    const midPressure = (lowerP + upperP) / 2.0;
    const midOk = interpWindAtPressure(rowCount, midPressure, bracketsValid, WIND_TMP);
    const segmentWeight = pressureWeighted ? ((lowerP + 4.0 * midPressure + upperP) / 6.0) * dp : dp;
    if (midOk) {
      const midU = load<f64>(WIND_TMP);
      const midV = load<f64>(WIND_TMP + 8);
      if (pressureWeighted) {
        sumU += ((lowerU * lowerP + 4.0 * midU * midPressure + upperU * upperP) / 6.0) * dp;
        sumV += ((lowerV * lowerP + 4.0 * midV * midPressure + upperV * upperP) / 6.0) * dp;
      } else {
        sumU += ((lowerU + 4.0 * midU + upperU) / 6.0) * dp;
        sumV += ((lowerV + 4.0 * midV + upperV) / 6.0) * dp;
      }
    } else {
      if (pressureWeighted) {
        sumU += ((lowerU * lowerP + upperU * upperP) / 2.0) * dp;
        sumV += ((lowerV * lowerP + upperV * upperP) / 2.0) * dp;
      } else {
        sumU += ((lowerU + upperU) / 2.0) * dp;
        sumV += ((lowerV + upperV) / 2.0) * dp;
      }
    }
    totalWeight += segmentWeight;
  }
  if (totalWeight > 0.0) {
    store<f64>(MEANWIND_OUT, sumU / totalWeight);
    store<f64>(MEANWIND_OUT + 8, sumV / totalWeight);
    return true;
  }
  return false;
}

// profile-wind.calculateBunkersMotionFromRows (right mover → STORM_OUT).
function bunkersRightMotion(
  rowCount: i32,
  meanBottomAglM: f64,
  meanTopAglM: f64,
  shearBottomAglM: f64,
  shearTopAglM: f64,
  pressureWeightedMean: bool,
  bracketsValid: bool,
): bool {
  if (meanTopAglM <= meanBottomAglM || shearTopAglM <= shearBottomAglM + 500.0) {
    return false;
  }
  const meanBottomPressure = interpPressureAtHeight(rowCount, meanBottomAglM);
  const meanTopPressure = interpPressureAtHeight(rowCount, meanTopAglM);
  const meanOk = meanWindByPressure(rowCount, meanBottomPressure, meanTopPressure, pressureWeightedMean, bracketsValid);
  const loOk = interpWindAtHeight(rowCount, shearBottomAglM, WIND_TMP);
  const loU = load<f64>(WIND_TMP);
  const loV = load<f64>(WIND_TMP + 8);
  const hiOk = interpWindAtHeight(rowCount, shearTopAglM, WIND_TMP);
  const hiU = load<f64>(WIND_TMP);
  const hiV = load<f64>(WIND_TMP + 8);
  if (!meanOk || !loOk || !hiOk) {
    return false;
  }
  const shearU = hiU - loU;
  const shearV = hiV - loV;
  const shearMagnitude = Math.hypot(shearU, shearV);
  if (!isFinite(shearMagnitude) || shearMagnitude < 1e-6) {
    return false;
  }
  store<f64>(STORM_OUT, load<f64>(MEANWIND_OUT) + (BUNKERS_RIGHT_MOVER_DEVIATION_MPS * shearV) / shearMagnitude);
  store<f64>(STORM_OUT + 8, load<f64>(MEANWIND_OUT + 8) - (BUNKERS_RIGHT_MOVER_DEVIATION_MPS * shearU) / shearMagnitude);
  return true;
}

// severe.calculateEffectiveLayerBunkersMotionFromRows (gating + pressure
// -weighted mean over the effective inflow-based layer).
function effectiveLayerBunkersRightMotion(
  rowCount: i32,
  baseAglM: f64,
  muElAglM: f64,
  muCapeJkg: f64,
  minCapeJkg: f64,
  bracketsValid: bool,
): bool {
  if (
    !isFinite(baseAglM) ||
    !isFinite(muElAglM) ||
    !isFinite(muCapeJkg) ||
    muCapeJkg <= minCapeJkg ||
    muElAglM <= baseAglM + 500.0
  ) {
    return false;
  }
  const topAglM = baseAglM + (muElAglM - baseAglM) * 0.65;
  if (topAglM < 3000.0 || baseAglM > topAglM) {
    return false;
  }
  return bunkersRightMotion(rowCount, baseAglM, topAglM, baseAglM, topAglM, true, bracketsValid);
}

// profile-wind.calculateStormRelativeHelicityFromRows
function stormRelativeHelicity(rowCount: i32, bottomAglM: f64, topAglM: f64, stormU: f64, stormV: f64): f64 {
  if (!isFinite(bottomAglM) || !isFinite(topAglM) || topAglM <= bottomAglM) {
    return NaN;
  }
  if (!interpWindAtHeight(rowCount, bottomAglM, WIND_TMP)) {
    return NaN;
  }
  let previousU = load<f64>(WIND_TMP);
  let previousV = load<f64>(WIND_TMP + 8);
  let helicity: f64 = 0.0;
  for (let row = 0; row < rowCount; row += 1) {
    const height = heightAt(row);
    if (!isFinite(height) || height <= bottomAglM || height >= topAglM) {
      continue;
    }
    const nextU = rowUAt(row);
    const nextV = rowVAt(row);
    helicity += (nextU - stormU) * (previousV - stormV) - (previousU - stormU) * (nextV - stormV);
    previousU = nextU;
    previousV = nextV;
  }
  if (!interpWindAtHeight(rowCount, topAglM, WIND_TMP)) {
    return NaN;
  }
  const topU = load<f64>(WIND_TMP);
  const topV = load<f64>(WIND_TMP + 8);
  helicity += (topU - stormU) * (previousV - stormV) - (previousU - stormU) * (topV - stormV);
  return helicity;
}

// severe.mixedLayerSampleFromValues → MLSAMPLE_OUT (theta, ratio).
function mlSampleFromValues(pressureHpa: f64, tempK: f64, dewpointK: f64): bool {
  const dewpoint = Math.min(dewpointK, tempK);
  const mixingRatio = mixingRatioFromVaporPressureHpa(vaporPressureHpa(dewpoint), pressureHpa);
  const theta = tempK * Math.pow(1000.0 / pressureHpa, RD_OVER_CP);
  if (!isFinite(mixingRatio) || !isFinite(theta)) {
    return false;
  }
  store<f64>(MLSAMPLE_OUT, theta);
  store<f64>(MLSAMPLE_OUT + 8, mixingRatio);
  return true;
}

// severe.mixedLayerSampleAtPressure (thermo interp + sample).
function mlSampleAtPressure(rowCount: i32, pressureHpa: f64, bracketsValid: bool): bool {
  if (!interpThermoAtPressure(rowCount, pressureHpa, bracketsValid)) {
    return false;
  }
  const tempK = load<f64>(THERMO_OUT + 16);
  const dewpointK = load<f64>(THERMO_OUT + 24);
  if (!isFinite(tempK) || !isFinite(dewpointK)) {
    return false;
  }
  return mlSampleFromValues(load<f64>(THERMO_OUT), tempK, dewpointK);
}

// severe mixed-layer addSample closure body, returns new count.
function mlAddSample(sampleCount: i32, surfacePressure: f64, topPressure: f64, pressureHpa: f64, thetaK: f64, mixingRatio: f64): i32 {
  if (!isFinite(pressureHpa) || !isFinite(thetaK) || !isFinite(mixingRatio)) {
    return sampleCount;
  }
  if (pressureHpa > surfacePressure + 1e-6 || pressureHpa < topPressure - 1e-6) {
    return sampleCount;
  }
  for (let existing = 0; existing < sampleCount; existing += 1) {
    if (Math.abs(load<f64>(MLS_P + <usize>existing * F64_BYTES) - pressureHpa) < 1e-6) {
      return sampleCount;
    }
  }
  store<f64>(MLS_P + <usize>sampleCount * F64_BYTES, pressureHpa);
  store<f64>(MLS_TH + <usize>sampleCount * F64_BYTES, thetaK);
  store<f64>(MLS_R + <usize>sampleCount * F64_BYTES, mixingRatio);
  return sampleCount + 1;
}

// severe.calculateMixedLayerParcelPropertiesFromScratch → ML_PROPS_OUT
// (pressure, temp, dewpoint).
function mixedLayerParcelProperties(rowCount: i32, bracketsValid: bool): bool {
  const surfacePressure = pressureAt(0);
  if (!isFinite(surfacePressure) || surfacePressure <= MIXED_LAYER_PARCEL_DEPTH_HPA + 100.0 || rowCount < 2) {
    return false;
  }
  const topPressure = surfacePressure - MIXED_LAYER_PARCEL_DEPTH_HPA;
  if (!mlSampleAtPressure(rowCount, surfacePressure, bracketsValid)) {
    return false;
  }
  const surfaceTheta = load<f64>(MLSAMPLE_OUT);
  const surfaceRatio = load<f64>(MLSAMPLE_OUT + 8);
  if (!mlSampleAtPressure(rowCount, topPressure, bracketsValid)) {
    return false;
  }
  const topTheta = load<f64>(MLSAMPLE_OUT);
  const topRatio = load<f64>(MLSAMPLE_OUT + 8);
  let sampleCount = mlAddSample(0, surfacePressure, topPressure, surfacePressure, surfaceTheta, surfaceRatio);
  for (let row = 0; row < rowCount; row += 1) {
    const pressure = pressureAt(row);
    if (!isFinite(pressure) || pressure >= surfacePressure || pressure <= topPressure) {
      continue;
    }
    if (mlSampleFromValues(pressure, tempAt(row), dewpointAt(row))) {
      sampleCount = mlAddSample(
        sampleCount,
        surfacePressure,
        topPressure,
        pressure,
        load<f64>(MLSAMPLE_OUT),
        load<f64>(MLSAMPLE_OUT + 8),
      );
    }
  }
  sampleCount = mlAddSample(sampleCount, surfacePressure, topPressure, topPressure, topTheta, topRatio);
  for (let index = 1; index < sampleCount; index += 1) {
    const pressure = load<f64>(MLS_P + <usize>index * F64_BYTES);
    const theta = load<f64>(MLS_TH + <usize>index * F64_BYTES);
    const ratio = load<f64>(MLS_R + <usize>index * F64_BYTES);
    let cursor = index - 1;
    while (cursor >= 0 && load<f64>(MLS_P + <usize>cursor * F64_BYTES) < pressure) {
      store<f64>(MLS_P + <usize>(cursor + 1) * F64_BYTES, load<f64>(MLS_P + <usize>cursor * F64_BYTES));
      store<f64>(MLS_TH + <usize>(cursor + 1) * F64_BYTES, load<f64>(MLS_TH + <usize>cursor * F64_BYTES));
      store<f64>(MLS_R + <usize>(cursor + 1) * F64_BYTES, load<f64>(MLS_R + <usize>cursor * F64_BYTES));
      cursor -= 1;
    }
    store<f64>(MLS_P + <usize>(cursor + 1) * F64_BYTES, pressure);
    store<f64>(MLS_TH + <usize>(cursor + 1) * F64_BYTES, theta);
    store<f64>(MLS_R + <usize>(cursor + 1) * F64_BYTES, ratio);
  }
  let thetaIntegral: f64 = 0.0;
  let mixingRatioIntegral: f64 = 0.0;
  let totalDp: f64 = 0.0;
  for (let index = 1; index < sampleCount; index += 1) {
    const lowerP = load<f64>(MLS_P + <usize>(index - 1) * F64_BYTES);
    const upperP = load<f64>(MLS_P + <usize>index * F64_BYTES);
    const dp = lowerP - upperP;
    if (!isFinite(dp) || dp <= 0.0) {
      continue;
    }
    const lowerTheta = load<f64>(MLS_TH + <usize>(index - 1) * F64_BYTES);
    const upperTheta = load<f64>(MLS_TH + <usize>index * F64_BYTES);
    const lowerRatio = load<f64>(MLS_R + <usize>(index - 1) * F64_BYTES);
    const upperRatio = load<f64>(MLS_R + <usize>index * F64_BYTES);
    const midPressure = (lowerP + upperP) / 2.0;
    const midOk = mlSampleAtPressure(rowCount, midPressure, bracketsValid);
    if (midOk) {
      thetaIntegral += ((lowerTheta + 4.0 * load<f64>(MLSAMPLE_OUT) + upperTheta) / 6.0) * dp;
      mixingRatioIntegral += ((lowerRatio + 4.0 * load<f64>(MLSAMPLE_OUT + 8) + upperRatio) / 6.0) * dp;
    } else {
      thetaIntegral += ((lowerTheta + upperTheta) / 2.0) * dp;
      mixingRatioIntegral += ((lowerRatio + upperRatio) / 2.0) * dp;
    }
    totalDp += dp;
  }
  if (totalDp <= 0.0) {
    return false;
  }
  const meanTheta = thetaIntegral / totalDp;
  const meanMixingRatio = mixingRatioIntegral / totalDp;
  const parcelTemp = meanTheta * Math.pow(surfacePressure / 1000.0, RD_OVER_CP);
  const vaporPressure = (meanMixingRatio * surfacePressure) / (EPSILON + meanMixingRatio);
  // thermo.dewpointFromVaporPressureHpa
  let parcelDewpoint: f64 = NaN;
  if (isFinite(vaporPressure) && vaporPressure > 0.0) {
    const logRatio = Math.log(vaporPressure / 6.112);
    parcelDewpoint = 273.15 + (243.5 * logRatio) / (17.67 - logRatio);
  }
  if (!isFinite(parcelTemp) || !isFinite(parcelDewpoint)) {
    return false;
  }
  store<f64>(ML_PROPS_OUT, surfacePressure);
  store<f64>(ML_PROPS_OUT + 8, parcelTemp);
  store<f64>(ML_PROPS_OUT + 16, parcelDewpoint);
  return true;
}

// severe.calculateMixedLayerLclMFromRows (calculateParcelLclAglM over the
// mixed-layer point-sounding source, heightAglM = 0).
function mixedLayerLclAglM(rowCount: i32, bracketsValid: bool): f64 {
  if (!mixedLayerParcelProperties(rowCount, bracketsValid)) {
    return NaN;
  }
  const sourceTemp = load<f64>(ML_PROPS_OUT + 8);
  const sourceDewpoint = Math.min(load<f64>(ML_PROPS_OUT + 16), sourceTemp);
  if (!isFinite(sourceTemp) || !isFinite(sourceDewpoint)) {
    return NaN;
  }
  const lclTemp = boltonLclTemperatureK(sourceTemp, sourceDewpoint);
  return isFinite(lclTemp) ? Math.max(0.0, 0.0 + (sourceTemp - lclTemp) / DRY_ADIABATIC_LAPSE_K_M) : NaN;
}

// util.clamp
// @ts-ignore: decorator
@inline
function clampF64(value: f64, min: f64, max: f64): f64 {
  return Math.min(max, Math.max(min, value));
}

// severe.calculateEffectiveLayerScpValue (mu pair from the scan).
function effectiveLayerScpValue(mucape: f64, mucin: f64, esrh: f64, ebwdKt: f64): f64 {
  if (!isFinite(mucape) || !isFinite(mucin)) {
    return NaN;
  }
  const capeTerm = Math.max(0.0, mucape) / 1000.0;
  const srhTerm = Math.max(0.0, esrh) / 50.0;
  const ebwdMs = Math.max(0.0, ebwdKt) / MPS_TO_KT;
  const shearTerm = ebwdMs < 10.0 ? 0.0 : clampF64(ebwdMs / 20.0, 0.0, 1.0);
  const cinTerm = mucin > -40.0 ? 1.0 : clampF64(-40.0 / mucin, 0.0, 1.0);
  const scp = capeTerm * srhTerm * shearTerm * cinTerm;
  return isFinite(scp) ? Math.max(0.0, scp) : NaN;
}

// severe.calculateEffectiveLayerStpFromParcelValues
function effectiveLayerStpFromParcelValues(capeJkg: f64, cinJkg: f64, esrh: f64, ebwdKt: f64, mixedLayerLclM: f64): f64 {
  if (!isFinite(capeJkg) || !isFinite(cinJkg)) {
    return NaN;
  }
  const capeTerm = Math.max(0.0, capeJkg) / 1500.0;
  const lclTerm = clampF64((2000.0 - mixedLayerLclM) / 1000.0, 0.0, 1.0);
  const srhTerm = Math.max(0.0, esrh) / 150.0;
  const ebwdMs = Math.max(0.0, ebwdKt) / MPS_TO_KT;
  const shearTerm = ebwdMs < 12.5 ? 0.0 : clampF64(ebwdMs / 20.0, 0.0, 1.5);
  const cinTerm = cinJkg > -50.0 ? 1.0 : clampF64((cinJkg + 200.0) / 150.0, 0.0, 1.0);
  const stp = capeTerm * lclTerm * srhTerm * shearTerm * cinTerm;
  return isFinite(stp) ? Math.max(0.0, stp) : NaN;
}

// severe.calculateEffectiveLayerProductsFromSources, post-fill: scan +
// wind/Bunkers/SRH/EBWD + SCP/STP/STP-100mb assembly. Rows (including the
// u/v arrays) must be filled and height-sorted; mlcape/mlcin arrive as
// per-cell scalars read from the decoded grids JS-side. Writes the EP_OUT
// slots (NaN = not computed; the JS caller keeps its isFinite guards) and
// returns 1 when the chain ran to completion (JS returned an object).
export function runEffectiveProducts(
  rowCount: i32,
  sourceDepthHpa: f64,
  sourceStepHpa: f64,
  sourceMaxAglM: f64,
  minCapeJkg: f64,
  minCinJkg: f64,
  needsScp: i32,
  needsStp: i32,
  needsStp100mb: i32,
  mlcape: f64,
  mlcin: f64,
  useF32Scan: i32,
): i32 {
  const count = rowCount > ROWS_CAP ? ROWS_CAP : rowCount;
  store<f64>(EP_OUT_PTR, NaN);
  store<f64>(EP_OUT_PTR + 8, NaN);
  store<f64>(EP_OUT_PTR + 16, NaN);
  const found = useF32Scan
    ? runOriginScanF32(count, sourceDepthHpa, sourceStepHpa, sourceMaxAglM, minCapeJkg, minCinJkg)
    : runOriginScan(count, sourceDepthHpa, sourceStepHpa, sourceMaxAglM, minCapeJkg, minCinJkg);
  if (!found) {
    return 0;
  }
  const baseAglM = load<f64>(OUT_PTR + 8);
  const layerTopAglM = load<f64>(OUT_PTR + 16);
  const muCapeJkg = load<f64>(OUT_PTR + 24);
  const muCinJkg = load<f64>(OUT_PTR + 32);
  const muElRaw = load<f64>(OUT_PTR + 40);
  if (!isFinite(baseAglM) || !isFinite(layerTopAglM)) {
    return 0;
  }
  const canShortCircuitStp = (needsStp != 0 || needsStp100mb != 0) && needsScp == 0 && baseAglM > 0.0;
  if (canShortCircuitStp) {
    if (needsStp != 0) {
      store<f64>(EP_OUT_PTR + 8, 0.0);
    }
    if (needsStp100mb != 0) {
      store<f64>(EP_OUT_PTR + 16, 0.0);
    }
    return 1;
  }
  const bracketsValid = pressureBracketsValidFor(count);
  const topAglM = Math.max(layerTopAglM, baseAglM + 1.0);
  if (!interpWindAtHeight(count, baseAglM, WIND_BASE)) {
    return 0;
  }
  const muElAglM = isFinite(muElRaw) ? muElRaw : topAglM;
  const ebwdTopAglM = baseAglM + 0.5 * Math.max(0.0, muElAglM - baseAglM);
  if (!interpWindAtHeight(count, ebwdTopAglM, WIND_TOP)) {
    return 0;
  }
  const ebwdTopU = load<f64>(WIND_TOP);
  const ebwdTopV = load<f64>(WIND_TOP + 8);
  let stormOk = effectiveLayerBunkersRightMotion(count, baseAglM, muElRaw, muCapeJkg, minCapeJkg, bracketsValid);
  if (!stormOk) {
    stormOk = bunkersRightMotion(count, 0.0, 6000.0, 0.0, 6000.0, false, bracketsValid);
  }
  if (!stormOk) {
    return 0;
  }
  const stormU = load<f64>(STORM_OUT);
  const stormV = load<f64>(STORM_OUT + 8);
  const esrh = stormRelativeHelicity(count, baseAglM, topAglM, stormU, stormV);
  const ebwdKt = Math.hypot(ebwdTopU - load<f64>(WIND_BASE), ebwdTopV - load<f64>(WIND_BASE + 8)) * MPS_TO_KT;
  if (!isFinite(esrh) || !isFinite(ebwdKt)) {
    return 0;
  }
  if (needsScp != 0) {
    store<f64>(EP_OUT_PTR, effectiveLayerScpValue(muCapeJkg, muCinJkg, esrh, ebwdKt));
  }
  if (needsStp != 0) {
    if (baseAglM > 0.0) {
      store<f64>(EP_OUT_PTR + 8, 0.0);
    } else {
      const mixedLayerLclM = mixedLayerLclAglM(count, bracketsValid);
      store<f64>(EP_OUT_PTR + 8, effectiveLayerStpFromParcelValues(mlcape, mlcin, esrh, ebwdKt, mixedLayerLclM));
    }
  }
  if (needsStp100mb != 0) {
    if (baseAglM > 0.0) {
      store<f64>(EP_OUT_PTR + 16, 0.0);
    } else {
      // severe.calculateEffectiveLayerStp100mbReducedValue: mixed-layer
      // point-sounding source (heightAglM = 0) through the shared segment
      // parcel integrator, then the STP composite with the parcel's LCL.
      if (mixedLayerParcelProperties(count, bracketsValid)) {
        const ok = segmentParcel(
          count,
          load<f64>(ML_PROPS_OUT),
          0.0,
          load<f64>(ML_PROPS_OUT + 8),
          load<f64>(ML_PROPS_OUT + 16),
          1,
          EP_PARCEL_OUT,
        );
        if (ok) {
          store<f64>(
            EP_OUT_PTR + 16,
            effectiveLayerStpFromParcelValues(
              load<f64>(EP_PARCEL_OUT),
              load<f64>(EP_PARCEL_OUT + 8),
              esrh,
              ebwdKt,
              load<f64>(EP_PARCEL_OUT + 16),
            ),
          );
        }
      }
    }
  }
  return 1;
}

// ============================================================================
// Derived-grid slab pipeline (2026-07-12 Stage G2) — f64 NativeMath port of
// the buildProfileDerivedGrids cell loop over slab-resident grids. JS
// copies row-ranges of every referenced decoded grid into the slab arena
// (raw f32 bits, so in-kernel reads see exactly what the JS loop read),
// fills the per-frame source tables (level values + arena slot indices for
// hgt/tmp/rh/u/v), and calls runDerivedSlab per range; the kernel walks the
// cells with the same gates, fallback chains, and skip rules as the JS
// loop, gathering profile rows, running the DCAPE port and the Stage G1
// product chain in place, and writing the eight product rows (NaN = cell
// not computed, matching the caller's prefilled-NaN output grids).
// ============================================================================

export const SLAB_CELLS: i32 = 8192;
export const SLAB_SLOTS: i32 = 128;
// Fixed aux slot assignments (JS mirrors these): 0 profileSurfaceHeight,
// 1 temperature2m, 2 humidity2m, 3 dewpoint2m, 4 derivedSurfacePressure,
// 5 pressureMsl, 6 windU10m, 7 windV10m, 8 mucape, 9 mlcape, 10 mlcin,
// 11 sbcape, 12 sbcin. Level-variable slots are assigned from 13 upward.
export const SLAB_AUX_SLOTS: i32 = 13;
const SLOT_HGT_SFC: i32 = 0;
const SLOT_TMP_SFC: i32 = 1;
const SLOT_RH_SFC: i32 = 2;
const SLOT_DPT_SFC: i32 = 3;
const SLOT_PRES_SFC: i32 = 4;
const SLOT_MSLP: i32 = 5;
const SLOT_U10: i32 = 6;
const SLOT_V10: i32 = 7;
const SLOT_MUCAPE: i32 = 8;
const SLOT_MLCAPE: i32 = 9;
const SLOT_MLCIN: i32 = 10;
const SLOT_SBCAPE: i32 = 11;
const SLOT_SBCIN: i32 = 12;

// Memory-footprint note (applies to every large memory.data reservation in
// this module, ~24MB total per instance, dominated by the three 6.27MB
// smoothing buffers): memory.data reserves zero-initialized address space
// in the initial wasm memory; the runtime commits physical pages on first
// touch, so threads that never run a given port never pay its resident
// cost. Render workers exercise every port each frame (~24MB resident per
// worker at full activity), which is the accepted trade-off for slab
// residency; a shared union arena is the follow-up if footprint matters.
export const SLAB_ARENA_PTR: usize = memory.data(4194304, 16); // f32 x 128 x 8192
export const SLAB_PRESENT_PTR: usize = memory.data(128, 16); // u8 per slot
export const SLAB_MASK_PTR: usize = memory.data(8192, 16); // u8 candidate mask
// Product rows: 0 lapse, 1 bulk, 2 effective, 3 dcape, 4 dcape21, 5 scp,
// 6 stp, 7 stp100mb.
export const SLAB_OUT_PTR: usize = memory.data(262144, 16); // f32 x 8 x 8192
export const SLAB_OUT_ROWS: i32 = 8;
// Per-frame source tables (level hPa + hgt/tmp/rh/u/v slot indices, -1 = absent).
export const SRC6_LEVELS_PTR: usize = memory.data(512, 8); // f64 x 64
export const SRC6_SLOTS_PTR: usize = memory.data(1280, 16); // i32 x 64 x 5
export const SRC21_LEVELS_PTR: usize = memory.data(512, 8);
export const SRC21_SLOTS_PTR: usize = memory.data(1280, 16);

// @ts-ignore: decorator
@inline
function slabRaw(slot: i32, cell: i32): f64 {
  // Raw grid read (JS `grid[index]` on a Float32Array): the widened f32 bit
  // pattern with no finite normalization.
  if (slot < 0 || !load<u8>(SLAB_PRESENT_PTR + <usize>slot)) {
    return NaN;
  }
  return <f64>load<f32>(SLAB_ARENA_PTR + ((<usize>slot * <usize>SLAB_CELLS + <usize>cell) << 2));
}

// @ts-ignore: decorator
@inline
function slabValue(slot: i32, cell: i32): f64 {
  // profile-access.gridValue: Number(values[index]) normalized to NaN when
  // not finite (also NaN when the grid is absent).
  const value = slabRaw(slot, cell);
  return isFinite(value) ? value : NaN;
}

// @ts-ignore: decorator
@inline
function srcSlot(slotsPtr: usize, source: i32, variable: i32): i32 {
  return load<i32>(slotsPtr + ((<usize>source * 5 + <usize>variable) << 2));
}

// thermo.dewpointFromTempRhK (f64, NativeMath log).
function dewpointFromTempRhK64(tempK: f64, rhPct: f64): f64 {
  if (!isFinite(tempK) || !isFinite(rhPct) || rhPct <= 0.0) {
    return NaN;
  }
  const tempC = tempK - 273.15;
  const rh = clampF64(rhPct, 1.0, 100.0);
  const gamma = Math.log(rh / 100.0) + (17.625 * tempC) / (243.04 + tempC);
  return 273.15 + (243.04 * gamma) / (17.625 - gamma);
}

// profile-access.surfacePressureHpa over slab slots.
function slabSurfacePressureHpa(cell: i32): f64 {
  const surfacePressure = slabValue(SLOT_PRES_SFC, cell);
  if (isFinite(surfacePressure) && surfacePressure > 1000.0) {
    return surfacePressure / 100.0;
  }
  const mslp = slabValue(SLOT_MSLP, cell);
  if (!isFinite(mslp)) {
    return NaN;
  }
  const mslpHpa = mslp / 100.0;
  const elevation = slabValue(SLOT_HGT_SFC, cell);
  const tempK = slabValue(SLOT_TMP_SFC, cell);
  if (!isFinite(elevation) || !isFinite(tempK) || elevation <= 1.0) {
    return mslpHpa;
  }
  const lapseRate = 0.0065;
  const denominator = tempK + lapseRate * elevation;
  if (!isFinite(denominator) || denominator <= 0.0) {
    return mslpHpa;
  }
  return mslpHpa * Math.pow(1.0 - (lapseRate * elevation) / denominator, 5.257);
}

// profile-access.surfaceDewpointK over slab slots.
function slabSurfaceDewpointK(cell: i32): f64 {
  const direct = slabValue(SLOT_DPT_SFC, cell);
  if (isFinite(direct)) {
    return direct;
  }
  return dewpointFromTempRhK64(slabValue(SLOT_TMP_SFC, cell), slabValue(SLOT_RH_SFC, cell));
}

// severe.fillEffectiveDiagnosticsProfileRows +
// profile-wind.sortEffectiveDiagnosticsRowsByHeight over the slab sources.
function slabFillProfileRows(cell: i32, elevation: f64, surfaceU: f64, surfaceV: f64, src21Count: i32): i32 {
  let rowCount = 0;
  if (isFinite(surfaceU) && isFinite(surfaceV)) {
    const surfacePressure = slabSurfacePressureHpa(cell);
    const surfaceTemp = slabValue(SLOT_TMP_SFC, cell);
    const surfaceDewpoint = slabSurfaceDewpointK(cell);
    store<f64>(HEIGHTS_PTR, 0.0);
    store<f64>(ROW_U_PTR, surfaceU);
    store<f64>(ROW_V_PTR, surfaceV);
    store<f64>(PRESSURE_PTR, isFinite(surfacePressure) ? surfacePressure : NaN);
    store<f64>(TEMP_PTR, isFinite(surfaceTemp) ? surfaceTemp : NaN);
    store<f64>(DEWPOINT_PTR, isFinite(surfaceDewpoint) ? surfaceDewpoint : NaN);
    rowCount = 1;
  }
  for (let source = 0; source < src21Count && rowCount < ROWS_CAP; source += 1) {
    const heightMsl = slabRaw(srcSlot(SRC21_SLOTS_PTR, source, 0), cell);
    const heightAglM = heightMsl - elevation;
    if (!isFinite(heightAglM) || heightAglM <= 0.0 || heightAglM > 16000.0) {
      continue;
    }
    const u = slabRaw(srcSlot(SRC21_SLOTS_PTR, source, 3), cell);
    const v = slabRaw(srcSlot(SRC21_SLOTS_PTR, source, 4), cell);
    if (!isFinite(u) || !isFinite(v)) {
      continue;
    }
    const tempK = slabRaw(srcSlot(SRC21_SLOTS_PTR, source, 1), cell);
    const rh = slabRaw(srcSlot(SRC21_SLOTS_PTR, source, 2), cell);
    const dewpointK = dewpointFromTempRhK64(tempK, rh);
    const levelHpa = load<f64>(SRC21_LEVELS_PTR + (<usize>source << 3));
    store<f64>(HEIGHTS_PTR + (<usize>rowCount << 3), heightAglM);
    store<f64>(ROW_U_PTR + (<usize>rowCount << 3), u);
    store<f64>(ROW_V_PTR + (<usize>rowCount << 3), v);
    store<f64>(PRESSURE_PTR + (<usize>rowCount << 3), isFinite(levelHpa) ? levelHpa : NaN);
    store<f64>(TEMP_PTR + (<usize>rowCount << 3), isFinite(tempK) ? tempK : NaN);
    store<f64>(DEWPOINT_PTR + (<usize>rowCount << 3), isFinite(dewpointK) ? dewpointK : NaN);
    rowCount += 1;
  }
  // insertion sort ascending by height across all six row arrays
  for (let index = 1; index < rowCount; index += 1) {
    const height = load<f64>(HEIGHTS_PTR + (<usize>index << 3));
    const u = load<f64>(ROW_U_PTR + (<usize>index << 3));
    const v = load<f64>(ROW_V_PTR + (<usize>index << 3));
    const pressure = load<f64>(PRESSURE_PTR + (<usize>index << 3));
    const temp = load<f64>(TEMP_PTR + (<usize>index << 3));
    const dewpoint = load<f64>(DEWPOINT_PTR + (<usize>index << 3));
    let cursor = index - 1;
    while (cursor >= 0 && load<f64>(HEIGHTS_PTR + (<usize>cursor << 3)) > height) {
      store<f64>(HEIGHTS_PTR + (<usize>(cursor + 1) << 3), load<f64>(HEIGHTS_PTR + (<usize>cursor << 3)));
      store<f64>(ROW_U_PTR + (<usize>(cursor + 1) << 3), load<f64>(ROW_U_PTR + (<usize>cursor << 3)));
      store<f64>(ROW_V_PTR + (<usize>(cursor + 1) << 3), load<f64>(ROW_V_PTR + (<usize>cursor << 3)));
      store<f64>(PRESSURE_PTR + (<usize>(cursor + 1) << 3), load<f64>(PRESSURE_PTR + (<usize>cursor << 3)));
      store<f64>(TEMP_PTR + (<usize>(cursor + 1) << 3), load<f64>(TEMP_PTR + (<usize>cursor << 3)));
      store<f64>(DEWPOINT_PTR + (<usize>(cursor + 1) << 3), load<f64>(DEWPOINT_PTR + (<usize>cursor << 3)));
      cursor -= 1;
    }
    store<f64>(HEIGHTS_PTR + (<usize>(cursor + 1) << 3), height);
    store<f64>(ROW_U_PTR + (<usize>(cursor + 1) << 3), u);
    store<f64>(ROW_V_PTR + (<usize>(cursor + 1) << 3), v);
    store<f64>(PRESSURE_PTR + (<usize>(cursor + 1) << 3), pressure);
    store<f64>(TEMP_PTR + (<usize>(cursor + 1) << 3), temp);
    store<f64>(DEWPOINT_PTR + (<usize>(cursor + 1) << 3), dewpoint);
  }
  return rowCount;
}

// severe.interpolateDerivedProfileColumn for TMP over the 6-level sources.
function slabInterpTmpColumn(cell: i32, aglMeters: f64, elevation: f64, surfaceValue: f64, src6Count: i32): f64 {
  const targetHeight = elevation + aglMeters;
  let lowerHeight: f64 = NaN;
  let lowerValue: f64 = NaN;
  if (isFinite(surfaceValue)) {
    if (elevation == targetHeight) {
      return surfaceValue;
    }
    if (elevation < targetHeight) {
      lowerHeight = elevation;
      lowerValue = surfaceValue;
    }
  }
  for (let source = 0; source < src6Count; source += 1) {
    const currentHeight = slabValue(srcSlot(SRC6_SLOTS_PTR, source, 0), cell);
    const currentValue = slabValue(srcSlot(SRC6_SLOTS_PTR, source, 1), cell);
    if (!isFinite(currentHeight) || currentHeight <= elevation || !isFinite(currentValue)) {
      continue;
    }
    if (currentHeight == targetHeight) {
      return currentValue;
    }
    if (currentHeight < targetHeight) {
      lowerHeight = currentHeight;
      lowerValue = currentValue;
      continue;
    }
    if (!isFinite(lowerHeight) || !isFinite(lowerValue)) {
      return currentValue;
    }
    const t = (targetHeight - lowerHeight) / Math.max(1e-9, currentHeight - lowerHeight);
    return lowerValue + (currentValue - lowerValue) * Math.max(0.0, Math.min(1.0, t));
  }
  // requireUpperBracket defaults to true in the lapse call
  return NaN;
}

// severe.interpolateDerivedProfileWindColumn (fused u/v state machine) +
// calculateBulkShearKtFromSources over the 6-level sources.
function slabBulkShearKt(cell: i32, elevation: f64, topAglM: f64, surfaceU: f64, surfaceV: f64, src6Count: i32): f64 {
  if (!isFinite(elevation) || !isFinite(surfaceU) || !isFinite(surfaceV)) {
    return NaN;
  }
  const targetHeight = elevation + topAglM;
  let uResolved = false;
  let uResult: f64 = NaN;
  let uLowerHeight: f64 = NaN;
  let uLowerValue: f64 = NaN;
  let vResolved = false;
  let vResult: f64 = NaN;
  let vLowerHeight: f64 = NaN;
  let vLowerValue: f64 = NaN;
  if (isFinite(surfaceU)) {
    if (elevation == targetHeight) {
      uResolved = true;
      uResult = surfaceU;
    } else if (elevation < targetHeight) {
      uLowerHeight = elevation;
      uLowerValue = surfaceU;
    }
  }
  if (isFinite(surfaceV)) {
    if (elevation == targetHeight) {
      vResolved = true;
      vResult = surfaceV;
    } else if (elevation < targetHeight) {
      vLowerHeight = elevation;
      vLowerValue = surfaceV;
    }
  }
  for (let source = 0; source < src6Count; source += 1) {
    if (uResolved && vResolved) {
      break;
    }
    const currentHeight = slabValue(srcSlot(SRC6_SLOTS_PTR, source, 0), cell);
    if (!isFinite(currentHeight) || currentHeight <= elevation) {
      continue;
    }
    if (!uResolved) {
      const currentValue = slabValue(srcSlot(SRC6_SLOTS_PTR, source, 3), cell);
      if (isFinite(currentValue)) {
        if (currentHeight == targetHeight) {
          uResolved = true;
          uResult = currentValue;
        } else if (currentHeight < targetHeight) {
          uLowerHeight = currentHeight;
          uLowerValue = currentValue;
        } else if (!isFinite(uLowerHeight) || !isFinite(uLowerValue)) {
          uResolved = true;
          uResult = currentValue;
        } else {
          const t = (targetHeight - uLowerHeight) / Math.max(1e-9, currentHeight - uLowerHeight);
          uResolved = true;
          uResult = uLowerValue + (currentValue - uLowerValue) * Math.max(0.0, Math.min(1.0, t));
        }
      }
    }
    if (!vResolved) {
      const currentValue = slabValue(srcSlot(SRC6_SLOTS_PTR, source, 4), cell);
      if (isFinite(currentValue)) {
        if (currentHeight == targetHeight) {
          vResolved = true;
          vResult = currentValue;
        } else if (currentHeight < targetHeight) {
          vLowerHeight = currentHeight;
          vLowerValue = currentValue;
        } else if (!isFinite(vLowerHeight) || !isFinite(vLowerValue)) {
          vResolved = true;
          vResult = currentValue;
        } else {
          const t = (targetHeight - vLowerHeight) / Math.max(1e-9, currentHeight - vLowerHeight);
          vResolved = true;
          vResult = vLowerValue + (currentValue - vLowerValue) * Math.max(0.0, Math.min(1.0, t));
        }
      }
    }
  }
  if (!isFinite(uResult) || !isFinite(vResult)) {
    return NaN;
  }
  return Math.hypot(uResult - surfaceU, vResult - surfaceV) * MPS_TO_KT;
}

// severe.computeKernelDcape's knot fill (raw slab reads mirror the raw grid
// reads the JS glue performs) + the in-kernel f32 DCAPE port.
function slabDcape(
  cell: i32,
  levelsPtr: usize,
  slotsPtr: usize,
  sourceCount: i32,
  elevation: f64,
  surfaceTemp: f64,
  surfacePressure: f64,
  sourceDepthHpa: f64,
  sourceLayerDepthHpa: f64,
): f64 {
  const count = sourceCount > DCAPE_KNOTS_CAP ? DCAPE_KNOTS_CAP : sourceCount;
  for (let source = 0; source < count; source += 1) {
    store<f32>(DK_LEVEL_PTR + (<usize>source << 2), <f32>load<f64>(levelsPtr + (<usize>source << 3)));
    store<f32>(DK_HGT_PTR + (<usize>source << 2), <f32>slabRaw(srcSlot(slotsPtr, source, 0), cell));
    store<f32>(DK_TMP_PTR + (<usize>source << 2), <f32>slabRaw(srcSlot(slotsPtr, source, 1), cell));
    store<f32>(DK_RH_PTR + (<usize>source << 2), <f32>slabRaw(srcSlot(slotsPtr, source, 2), cell));
  }
  return computeDcapeF32(count, isFinite(elevation) ? elevation : 0.0, surfaceTemp, surfacePressure, sourceDepthHpa, sourceLayerDepthHpa);
}

// severe.buildProfileDerivedGrids cell loop over one slab range.
export function runDerivedSlab(
  count: i32,
  needsLapse: i32,
  needsBulk: i32,
  needsEffective: i32,
  needsDcape: i32,
  needsDcape21: i32,
  needsScp: i32,
  needsStp: i32,
  needsStp100mb: i32,
  hasCandidateMask: i32,
  src6Count: i32,
  src21Count: i32,
  sourceDepthHpa: f64,
  sourceStepHpa: f64,
  sourceMaxAglM: f64,
  minCapeJkg: f64,
  minCinJkg: f64,
  diagnosticMinCapeJkg: f64,
  dcapeSourceDepthHpa: f64,
  dcapeLayerDepthHpa: f64,
  useF32Scan: i32,
): void {
  const cells = count > SLAB_CELLS ? SLAB_CELLS : count;
  // Prefill all product rows with f32 NaN (the JS output grids are
  // prefilled NaN, so an untouched slab cell must copy back as NaN).
  for (let row = 0; row < SLAB_OUT_ROWS; row += 1) {
    const base = SLAB_OUT_PTR + ((<usize>row * <usize>SLAB_CELLS) << 2);
    for (let cell = 0; cell < cells; cell += 1) {
      store<f32>(base + (<usize>cell << 2), f32.NaN);
    }
  }
  const needsEffectiveDiagnostics = needsScp != 0 || needsStp != 0 || needsStp100mb != 0;
  const outLapse = SLAB_OUT_PTR;
  const outBulk = SLAB_OUT_PTR + ((<usize>SLAB_CELLS) << 2);
  const outEffective = SLAB_OUT_PTR + ((<usize>SLAB_CELLS * 2) << 2);
  const outDcape = SLAB_OUT_PTR + ((<usize>SLAB_CELLS * 3) << 2);
  const outDcape21 = SLAB_OUT_PTR + ((<usize>SLAB_CELLS * 4) << 2);
  const outScp = SLAB_OUT_PTR + ((<usize>SLAB_CELLS * 5) << 2);
  const outStp = SLAB_OUT_PTR + ((<usize>SLAB_CELLS * 6) << 2);
  const outStp100 = SLAB_OUT_PTR + ((<usize>SLAB_CELLS * 7) << 2);

  for (let cell = 0; cell < cells; cell += 1) {
    const wantsEffectiveDiagnosticsCandidate =
      needsEffectiveDiagnostics && hasCandidateMask != 0 && load<u8>(SLAB_MASK_PTR + <usize>cell) == 1;
    // severe.isEffectiveLayerCellActive (gridValue semantics on both pairs)
    let wantsEffectiveCandidate = false;
    if (needsEffective != 0) {
      const mlcapeA = slabValue(SLOT_MLCAPE, cell);
      const mlcinA = slabValue(SLOT_MLCIN, cell);
      const sbcapeA = slabValue(SLOT_SBCAPE, cell);
      const sbcinA = slabValue(SLOT_SBCIN, cell);
      wantsEffectiveCandidate =
        (isFinite(mlcapeA) && mlcapeA >= minCapeJkg && isFinite(mlcinA) && mlcinA >= minCinJkg) ||
        (isFinite(sbcapeA) && sbcapeA >= minCapeJkg && isFinite(sbcinA) && sbcinA >= minCinJkg);
    }
    if (
      needsLapse == 0 &&
      needsBulk == 0 &&
      needsDcape == 0 &&
      needsDcape21 == 0 &&
      !wantsEffectiveCandidate &&
      !wantsEffectiveDiagnosticsCandidate
    ) {
      continue;
    }
    const elevation = slabValue(SLOT_HGT_SFC, cell);
    if (!isFinite(elevation)) {
      continue;
    }
    const surfaceTemp =
      needsLapse != 0 || needsDcape != 0 || needsDcape21 != 0 ? slabValue(SLOT_TMP_SFC, cell) : NaN;
    let surfaceU: f64 = NaN;
    let surfaceV: f64 = NaN;
    let hasSurfaceWind = false;
    if (needsBulk != 0 || wantsEffectiveCandidate || wantsEffectiveDiagnosticsCandidate) {
      surfaceU = slabValue(SLOT_U10, cell);
      surfaceV = slabValue(SLOT_V10, cell);
      hasSurfaceWind = isFinite(surfaceU) && isFinite(surfaceV);
    }
    const wantsLapse = needsLapse != 0 && isFinite(surfaceTemp);
    const wantsBulk = needsBulk != 0 && hasSurfaceWind;
    const wantsDcape = (needsDcape != 0 || needsDcape21 != 0) && isFinite(surfaceTemp);
    const wantsEffective = wantsEffectiveCandidate && hasSurfaceWind;
    const wantsEffectiveDiagnostics = wantsEffectiveDiagnosticsCandidate && hasSurfaceWind;
    if (!wantsLapse && !wantsBulk && !wantsDcape && !wantsEffective && !wantsEffectiveDiagnostics) {
      continue;
    }

    if (wantsLapse) {
      const temp3km = slabInterpTmpColumn(cell, 3000.0, elevation, surfaceTemp, src6Count);
      if (isFinite(surfaceTemp) && isFinite(temp3km)) {
        store<f32>(outLapse + (<usize>cell << 2), <f32>((surfaceTemp - temp3km) / 3.0));
      }
    }
    if (wantsBulk) {
      const shear = slabBulkShearKt(cell, elevation, 6000.0, surfaceU, surfaceV, src6Count);
      if (isFinite(shear)) {
        store<f32>(outBulk + (<usize>cell << 2), <f32>shear);
      }
    }
    if (wantsEffective) {
      // JS reuses the f32-rounded bulk output value when present.
      const bulkStored = needsBulk != 0 ? <f64>load<f32>(outBulk + (<usize>cell << 2)) : NaN;
      const shear = isFinite(bulkStored)
        ? bulkStored
        : slabBulkShearKt(cell, elevation, 6000.0, surfaceU, surfaceV, src6Count);
      if (isFinite(shear)) {
        store<f32>(outEffective + (<usize>cell << 2), <f32>shear);
      }
    }
    if (wantsDcape) {
      // Surface pressure via the same direct-pressure-then-hypsometric-MSLP
      // chain the JS loop hoists (severe.js buildProfileDerivedGrids).
      let cellSurfacePressure: f64;
      const directPressureRaw = slabRaw(SLOT_PRES_SFC, cell);
      if (isFinite(directPressureRaw) && directPressureRaw > 1000.0) {
        cellSurfacePressure = directPressureRaw / 100.0;
      } else {
        const mslpRaw = slabRaw(SLOT_MSLP, cell);
        if (!isFinite(mslpRaw)) {
          cellSurfacePressure = NaN;
        } else {
          const mslpHpa = mslpRaw / 100.0;
          if (!isFinite(elevation) || !isFinite(surfaceTemp) || elevation <= 1.0) {
            cellSurfacePressure = mslpHpa;
          } else {
            const lapseRate = 0.0065;
            const denominator = surfaceTemp + lapseRate * elevation;
            cellSurfacePressure =
              !isFinite(denominator) || denominator <= 0.0
                ? mslpHpa
                : mslpHpa * Math.pow(1.0 - (lapseRate * elevation) / denominator, 5.257);
          }
        }
      }
      if (needsDcape != 0) {
        const value = slabDcape(
          cell,
          SRC6_LEVELS_PTR,
          SRC6_SLOTS_PTR,
          src6Count,
          elevation,
          surfaceTemp,
          cellSurfacePressure,
          dcapeSourceDepthHpa,
          dcapeLayerDepthHpa,
        );
        if (isFinite(value)) {
          store<f32>(outDcape + (<usize>cell << 2), <f32>Math.max(0.0, value));
        }
      }
      if (needsDcape21 != 0 && src21Count > 0) {
        const value = slabDcape(
          cell,
          SRC21_LEVELS_PTR,
          SRC21_SLOTS_PTR,
          src21Count,
          elevation,
          surfaceTemp,
          cellSurfacePressure,
          dcapeSourceDepthHpa,
          dcapeLayerDepthHpa,
        );
        if (isFinite(value)) {
          store<f32>(outDcape21 + (<usize>cell << 2), <f32>Math.max(0.0, value));
        }
      }
    }
    if (wantsEffectiveDiagnostics) {
      // Fused per-cell SCP/STP screens (severe.js buildProfileDerivedGrids).
      // severe.EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG is a distinct
      // (currently aliased) constant from the inflow threshold; keep them
      // independently tunable exactly like the JS loop.
      const cellMucape = slabValue(SLOT_MUCAPE, cell);
      const needsScpAtCell = needsScp != 0 && cellMucape >= diagnosticMinCapeJkg;
      let needsStpAtCell = false;
      if (needsStp != 0) {
        const cellMlcape = slabValue(SLOT_MLCAPE, cell);
        const cellMlcin = slabValue(SLOT_MLCIN, cell);
        if (cellMlcape > 0.0 && !(isFinite(cellMlcin) && cellMlcin <= -200.0)) {
          needsStpAtCell =
            cellMucape >= diagnosticMinCapeJkg ||
            cellMlcape >= diagnosticMinCapeJkg ||
            slabValue(SLOT_SBCAPE, cell) >= diagnosticMinCapeJkg;
        }
      }
      const rowCount = slabFillProfileRows(cell, elevation, surfaceU, surfaceV, src21Count);
      if (rowCount >= 3 && (needsScpAtCell || needsStpAtCell || needsStp100mb != 0)) {
        const completed = runEffectiveProducts(
          rowCount,
          sourceDepthHpa,
          sourceStepHpa,
          sourceMaxAglM,
          minCapeJkg,
          minCinJkg,
          needsScpAtCell ? 1 : 0,
          needsStpAtCell ? 1 : 0,
          needsStp100mb,
          slabValue(SLOT_MLCAPE, cell),
          slabValue(SLOT_MLCIN, cell),
          useF32Scan,
        );
        if (completed) {
          const scp = load<f64>(EP_OUT_PTR);
          const stp = load<f64>(EP_OUT_PTR + 8);
          const stp100 = load<f64>(EP_OUT_PTR + 16);
          if (needsScp != 0 && isFinite(scp)) {
            store<f32>(outScp + (<usize>cell << 2), <f32>scp);
          }
          if (needsStp != 0 && isFinite(stp)) {
            store<f32>(outStp + (<usize>cell << 2), <f32>stp);
          }
          if (needsStp100mb != 0 && isFinite(stp100)) {
            store<f32>(outStp100 + (<usize>cell << 2), <f32>stp100);
          }
        }
      }
    }
  }
}

// ============================================================================
// Presentation smoothing (2026-07-12 Stage E) — EXACT port of
// grid-ops.smoothFiniteNonnegativeGrid (5-tap [1,4,6,4,1] separable kernel,
// finite mask from the ORIGINAL input, Math.max(0,·) on the vertical pass).
//
// Exactness contract: every accumulation runs in f64 in the same tap order
// as the JS loops, intermediate values round through f32 exactly where the
// JS stores into Float32Array scratch, and the per-buffer finiteness flags
// replicate the JS semantics precisely — including the deliberate asymmetry
// that the horizontal flag tests NaN/±inf on the PRE-ROUNDING f64 value
// while the vertical flag tests only NaN. SIMD (f64x2 lanes) is used for
// the all-finite interior fast paths whose JS counterparts are branch-free,
// so lane arithmetic is the same operation sequence per cell.
// ============================================================================

export const SMOOTH_CELLS_CAP: i32 = 1568000; // 1600 x 980 render grid

export const SMOOTH_IN_PTR: usize = memory.data(6272000, 16); // f32 input (also the finite mask)
const SMOOTH_H_PTR: usize = memory.data(6272000, 16); // horizontal scratch
export const SMOOTH_OUT_PTR: usize = memory.data(6272000, 16); // per-pass output / result

// grid-ops.SNOWFALL_PRESENTATION_SMOOTHING_KERNEL, verbatim.
const SW0: f64 = 1.0;
const SW1: f64 = 4.0;
const SW2: f64 = 6.0;
const SW3: f64 = 4.0;
const SW4: f64 = 1.0;

// @ts-ignore: decorator
@inline
function smoothLoadF32(ptr: usize, index: i32): f64 {
  return <f64>load<f32>(ptr + (<usize>index << 2));
}

// grid-ops.smoothKernelSampleInterior5AllFinite (identical statement order)
// @ts-ignore: decorator
@inline
function smoothInterior5(ptr: usize, centerIndex: i32, stride: i32): f64 {
  let weighted: f64 = 0.0;
  let weightTotal: f64 = 0.0;
  weighted += smoothLoadF32(ptr, centerIndex - 2 * stride) * SW0;
  weightTotal += SW0;
  weighted += smoothLoadF32(ptr, centerIndex - stride) * SW1;
  weightTotal += SW1;
  weighted += smoothLoadF32(ptr, centerIndex) * SW2;
  weightTotal += SW2;
  weighted += smoothLoadF32(ptr, centerIndex + stride) * SW3;
  weightTotal += SW3;
  weighted += smoothLoadF32(ptr, centerIndex + 2 * stride) * SW4;
  weightTotal += SW4;
  return weightTotal > 0.0 ? weighted / weightTotal : NaN;
}

// grid-ops.smoothFiniteKernelSample (bounds-checked, finite-skip)
function smoothSample5(ptr: usize, centerIndex: i32, stride: i32, coordinate: i32, limit: i32): f64 {
  let weighted: f64 = 0.0;
  let weightTotal: f64 = 0.0;
  for (let offset = -2; offset <= 2; offset += 1) {
    const sampleCoordinate = coordinate + offset;
    if (sampleCoordinate < 0 || sampleCoordinate >= limit) {
      continue;
    }
    const value = smoothLoadF32(ptr, centerIndex + offset * stride);
    if (!isFinite(value)) {
      continue;
    }
    const weight: f64 = offset == -2 ? SW0 : offset == -1 ? SW1 : offset == 0 ? SW2 : offset == 1 ? SW3 : SW4;
    weighted += value * weight;
    weightTotal += weight;
  }
  return weightTotal > 0.0 ? weighted / weightTotal : NaN;
}

// grid-ops.smoothFiniteKernelSampleInline (interior fast path + fallback)
// @ts-ignore: decorator
@inline
function smoothInline5(ptr: usize, centerIndex: i32, stride: i32, coordinate: i32, limit: i32): f64 {
  if (coordinate < 2 || coordinate > limit - 3) {
    return smoothSample5(ptr, centerIndex, stride, coordinate, limit);
  }
  let weighted: f64 = 0.0;
  let weightTotal: f64 = 0.0;
  const v0 = smoothLoadF32(ptr, centerIndex - 2 * stride);
  if (isFinite(v0)) {
    weighted += v0 * SW0;
    weightTotal += SW0;
  }
  const v1 = smoothLoadF32(ptr, centerIndex - stride);
  if (isFinite(v1)) {
    weighted += v1 * SW1;
    weightTotal += SW1;
  }
  const v2 = smoothLoadF32(ptr, centerIndex);
  if (isFinite(v2)) {
    weighted += v2 * SW2;
    weightTotal += SW2;
  }
  const v3 = smoothLoadF32(ptr, centerIndex + stride);
  if (isFinite(v3)) {
    weighted += v3 * SW3;
    weightTotal += SW3;
  }
  const v4 = smoothLoadF32(ptr, centerIndex + 2 * stride);
  if (isFinite(v4)) {
    weighted += v4 * SW4;
    weightTotal += SW4;
  }
  return weightTotal > 0.0 ? weighted / weightTotal : NaN;
}

// Vector 5-tap over two adjacent cells: each lane accumulates in the same
// tap order as smoothInterior5 (f64 lanes), and the /16 weightTotal is the
// value the JS accumulation produces.
// @ts-ignore: decorator
@inline
function smoothInterior5Pair(ptr: usize, centerIndex: i32, stride: i32): v128 {
  const base = ptr + (<usize>centerIndex << 2);
  const strideBytes = <usize>stride << 2;
  const t0 = f64x2.promote_low_f32x4(v128.load64_zero(base - 2 * strideBytes));
  const t1 = f64x2.promote_low_f32x4(v128.load64_zero(base - strideBytes));
  const t2 = f64x2.promote_low_f32x4(v128.load64_zero(base));
  const t3 = f64x2.promote_low_f32x4(v128.load64_zero(base + strideBytes));
  const t4 = f64x2.promote_low_f32x4(v128.load64_zero(base + 2 * strideBytes));
  // Start from an explicit +0 accumulator: JS computes 0 + v*w, which turns
  // an all-negative-zero neighborhood into +0; t0*w alone would keep -0.
  let weighted = f64x2.add(f64x2.splat(0.0), f64x2.mul(t0, f64x2.splat(SW0)));
  weighted = f64x2.add(weighted, f64x2.mul(t1, f64x2.splat(SW1)));
  weighted = f64x2.add(weighted, f64x2.mul(t2, f64x2.splat(SW2)));
  weighted = f64x2.add(weighted, f64x2.mul(t3, f64x2.splat(SW3)));
  weighted = f64x2.add(weighted, f64x2.mul(t4, f64x2.splat(SW4)));
  return f64x2.div(weighted, f64x2.splat(16.0));
}

// Vector 5-tap over two adjacent cells with the scalar fallback's exact
// finite-skip semantics. Each lane conditionally accumulates the same taps,
// in the same order, and renormalizes by the same accepted weight total as
// smoothFiniteKernelSampleInline. Adding an explicit +0 for a rejected tap
// is value-identical to skipping the statement, including signed-zero
// behavior, while allowing masked pressure-surface/domain grids to retain
// f64x2 SIMD instead of forcing the entire grid through scalar branches.
// @ts-ignore: decorator
@inline
function smoothMasked5Pair(ptr: usize, centerIndex: i32, stride: i32): v128 {
  const base = ptr + (<usize>centerIndex << 2);
  const strideBytes = <usize>stride << 2;
  const t0 = f64x2.promote_low_f32x4(v128.load64_zero(base - 2 * strideBytes));
  const t1 = f64x2.promote_low_f32x4(v128.load64_zero(base - strideBytes));
  const t2 = f64x2.promote_low_f32x4(v128.load64_zero(base));
  const t3 = f64x2.promote_low_f32x4(v128.load64_zero(base + strideBytes));
  const t4 = f64x2.promote_low_f32x4(v128.load64_zero(base + 2 * strideBytes));
  const zero = f64x2.splat(0.0);
  const infinity = f64x2.splat(Infinity);
  const w0 = f64x2.splat(SW0);
  const w1 = f64x2.splat(SW1);
  const w2 = f64x2.splat(SW2);
  const w3 = f64x2.splat(SW3);
  const w4 = f64x2.splat(SW4);
  const finite0 = f64x2.lt(f64x2.abs(t0), infinity);
  const finite1 = f64x2.lt(f64x2.abs(t1), infinity);
  const finite2 = f64x2.lt(f64x2.abs(t2), infinity);
  const finite3 = f64x2.lt(f64x2.abs(t3), infinity);
  const finite4 = f64x2.lt(f64x2.abs(t4), infinity);
  let weighted = f64x2.add(zero, v128.bitselect(f64x2.mul(t0, w0), zero, finite0));
  let weightTotal = f64x2.add(zero, v128.bitselect(w0, zero, finite0));
  weighted = f64x2.add(weighted, v128.bitselect(f64x2.mul(t1, w1), zero, finite1));
  weightTotal = f64x2.add(weightTotal, v128.bitselect(w1, zero, finite1));
  weighted = f64x2.add(weighted, v128.bitselect(f64x2.mul(t2, w2), zero, finite2));
  weightTotal = f64x2.add(weightTotal, v128.bitselect(w2, zero, finite2));
  weighted = f64x2.add(weighted, v128.bitselect(f64x2.mul(t3, w3), zero, finite3));
  weightTotal = f64x2.add(weightTotal, v128.bitselect(w3, zero, finite3));
  weighted = f64x2.add(weighted, v128.bitselect(f64x2.mul(t4, w4), zero, finite4));
  weightTotal = f64x2.add(weightTotal, v128.bitselect(w4, zero, finite4));
  return f64x2.div(weighted, weightTotal);
}

// @ts-ignore: decorator
@inline
function storeSmoothedPair(outPtr: usize, index: i32, pair: v128): void {
  store<f32>(outPtr + (<usize>index << 2), <f32>f64x2.extract_lane(pair, 0));
  store<f32>(outPtr + (<usize>(index + 1) << 2), <f32>f64x2.extract_lane(pair, 1));
}

// grid-ops.gridIsAllFinite over the input buffer.
function smoothMaskAllFinite(cellCount: i32): bool {
  let index = 0;
  const blockEnd = cellCount & ~3;
  while (index < blockEnd) {
    const v = v128.load(SMOOTH_IN_PTR + (<usize>index << 2));
    if (!i32x4.all_true(f32x4.lt(f32x4.abs(v), f32x4.splat(<f32>Infinity)))) {
      return false;
    }
    index += 4;
  }
  for (; index < cellCount; index += 1) {
    if (!isFinite(smoothLoadF32(SMOOTH_IN_PTR, index))) {
      return false;
    }
  }
  return true;
}

// grid-ops.smoothFiniteNonnegativeGrid. Input in SMOOTH_IN_PTR (never
// written), result in SMOOTH_OUT_PTR. passes must be >= 1 (JS keeps the
// passes<=0 identity return).
export function smoothGrid(cellCount: i32, width: i32, height: i32, passes: i32): void {
  const maskAllFinite = smoothMaskAllFinite(cellCount);
  let currentAllFinite = maskAllFinite;
  let curPtr = SMOOTH_IN_PTR;
  for (let pass = 0; pass < passes; pass += 1) {
    const fastHorizontal = maskAllFinite && currentAllFinite;
    // A nonfinite original mask is preserved into every horizontal/output
    // buffer, so its all-finite flags are known false without rescanning pair
    // results. The checks remain active for the all-finite path (including
    // its defensive scalar fallback after an exceptional prior pass).
    let horizontalAllFinite = maskAllFinite;
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      let x = 0;
      if (fastHorizontal) {
        for (; x < 2 && x < width; x += 1) {
          const index = rowOffset + x;
          const smoothed = smoothInline5(curPtr, index, 1, x, width);
          store<f32>(SMOOTH_H_PTR + (<usize>index << 2), <f32>smoothed);
          if (smoothed != smoothed || smoothed == Infinity || smoothed == -Infinity) {
            horizontalAllFinite = false;
          }
        }
        const interiorEnd = width - 3; // last interior x (inclusive)
        let pairNaNInf = false;
        for (; x + 1 <= interiorEnd; x += 2) {
          const index = rowOffset + x;
          const pair = smoothInterior5Pair(curPtr, index, 1);
          storeSmoothedPair(SMOOTH_H_PTR, index, pair);
          if (!i64x2.all_true(f64x2.lt(f64x2.abs(pair), f64x2.splat(Infinity)))) {
            pairNaNInf = true;
          }
        }
        if (pairNaNInf) {
          horizontalAllFinite = false;
        }
        for (; x < width; x += 1) {
          const index = rowOffset + x;
          const smoothed =
            x <= width - 3 ? smoothInterior5(curPtr, index, 1) : smoothInline5(curPtr, index, 1, x, width);
          store<f32>(SMOOTH_H_PTR + (<usize>index << 2), <f32>smoothed);
          if (smoothed != smoothed || smoothed == Infinity || smoothed == -Infinity) {
            horizontalAllFinite = false;
          }
        }
      } else if (!maskAllFinite) {
        // The original finite mask remains authoritative across passes. Work
        // scalar at the horizontal boundaries, then process interior cells
        // in exact f64x2 pairs even when some taps are NaN/Infinity.
        for (; x < 2 && x < width; x += 1) {
          const index = rowOffset + x;
          const smoothed = isFinite(smoothLoadF32(SMOOTH_IN_PTR, index))
            ? smoothInline5(curPtr, index, 1, x, width)
            : NaN;
          store<f32>(SMOOTH_H_PTR + (<usize>index << 2), <f32>smoothed);
        }
        const interiorEnd = width - 3;
        for (; x + 1 <= interiorEnd; x += 2) {
          const index = rowOffset + x;
          const pair = smoothMasked5Pair(curPtr, index, 1);
          const originalCenters = f64x2.promote_low_f32x4(
            v128.load64_zero(SMOOTH_IN_PTR + (<usize>index << 2)),
          );
          const centerFinite = f64x2.lt(f64x2.abs(originalCenters), f64x2.splat(Infinity));
          const result = v128.bitselect(pair, f64x2.splat(NaN), centerFinite);
          storeSmoothedPair(SMOOTH_H_PTR, index, result);
        }
        for (; x < width; x += 1) {
          const index = rowOffset + x;
          const smoothed = isFinite(smoothLoadF32(SMOOTH_IN_PTR, index))
            ? smoothInline5(curPtr, index, 1, x, width)
            : NaN;
          store<f32>(SMOOTH_H_PTR + (<usize>index << 2), <f32>smoothed);
        }
      } else {
        // Defensive path for an originally all-finite grid whose previous
        // pass nevertheless produced a nonfinite value.
        for (; x < width; x += 1) {
          const index = rowOffset + x;
          const smoothed = smoothInline5(curPtr, index, 1, x, width);
          store<f32>(SMOOTH_H_PTR + (<usize>index << 2), <f32>smoothed);
          if (smoothed != smoothed || smoothed == Infinity || smoothed == -Infinity) {
            horizontalAllFinite = false;
          }
        }
      }
    }
    const fastVertical = maskAllFinite && horizontalAllFinite;
    let outAllFinite = maskAllFinite;
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      const fastRow = fastVertical && y >= 2 && y <= height - 3;
      if (fastRow) {
        let x = 0;
        let rowNaN = false;
        const pairEnd = width & ~1;
        for (; x < pairEnd; x += 2) {
          const index = rowOffset + x;
          const pair = smoothInterior5Pair(SMOOTH_H_PTR, index, width);
          // result = isFinite(smoothed) ? Math.max(0, smoothed) : NaN
          const finitePair = f64x2.lt(f64x2.abs(pair), f64x2.splat(Infinity));
          const result = v128.bitselect(f64x2.max(pair, f64x2.splat(0.0)), f64x2.splat(NaN), finitePair);
          storeSmoothedPair(SMOOTH_OUT_PTR, index, result);
          if (!i64x2.all_true(f64x2.eq(result, result))) {
            rowNaN = true;
          }
        }
        for (; x < width; x += 1) {
          const index = rowOffset + x;
          const smoothed = smoothInterior5(SMOOTH_H_PTR, index, width);
          const result = isFinite(smoothed) ? Math.max(0.0, smoothed) : NaN;
          store<f32>(SMOOTH_OUT_PTR + (<usize>index << 2), <f32>result);
          if (result != result) {
            rowNaN = true;
          }
        }
        if (rowNaN) {
          outAllFinite = false;
        }
      } else if (!maskAllFinite && y >= 2 && y <= height - 3) {
        // Masked grids keep the same original-cell gate as the scalar path,
        // but every interior row can still evaluate two columns at a time.
        let x = 0;
        const pairEnd = width & ~1;
        for (; x < pairEnd; x += 2) {
          const index = rowOffset + x;
          const pair = smoothMasked5Pair(SMOOTH_H_PTR, index, width);
          const originalCenters = f64x2.promote_low_f32x4(
            v128.load64_zero(SMOOTH_IN_PTR + (<usize>index << 2)),
          );
          const centerFinite = f64x2.lt(f64x2.abs(originalCenters), f64x2.splat(Infinity));
          const pairFinite = f64x2.lt(f64x2.abs(pair), f64x2.splat(Infinity));
          const result = v128.bitselect(
            f64x2.max(pair, f64x2.splat(0.0)),
            f64x2.splat(NaN),
            v128.and(centerFinite, pairFinite),
          );
          storeSmoothedPair(SMOOTH_OUT_PTR, index, result);
        }
        for (; x < width; x += 1) {
          const index = rowOffset + x;
          let result: f64;
          if (isFinite(smoothLoadF32(SMOOTH_IN_PTR, index))) {
            const smoothed = smoothInline5(SMOOTH_H_PTR, index, width, y, height);
            result = isFinite(smoothed) ? Math.max(0.0, smoothed) : NaN;
          } else {
            result = NaN;
          }
          store<f32>(SMOOTH_OUT_PTR + (<usize>index << 2), <f32>result);
        }
      } else {
        for (let x = 0; x < width; x += 1) {
          const index = rowOffset + x;
          let result: f64;
          if (isFinite(smoothLoadF32(SMOOTH_IN_PTR, index))) {
            const smoothed = smoothInline5(SMOOTH_H_PTR, index, width, y, height);
            result = isFinite(smoothed) ? Math.max(0.0, smoothed) : NaN;
          } else {
            result = NaN;
          }
          store<f32>(SMOOTH_OUT_PTR + (<usize>index << 2), <f32>result);
          if (result != result) {
            outAllFinite = false;
          }
        }
      }
    }
    curPtr = SMOOTH_OUT_PTR;
    currentAllFinite = outAllFinite;
  }
}

// hover-grid-binary.deltaEncodeInt16Region, chunked (exact: wrapping i16
// subtraction is precision-free). JS copies up to DELTA_CHUNK i16 values
// into DELTA_PTR, passes the running carry (the previous chunk's last
// original value), and copies the in-place deltas back out. Returns the
// last ORIGINAL value of this chunk as the next carry.
export const DELTA_CHUNK: i32 = 65536;
export const DELTA_PTR: usize = memory.data(131072, 16); // i16 x 65536

// @ts-ignore: decorator
@inline
function deltaEncodeI16At(ptr: usize, count: i32, previous: i32, capacity: i32): i32 {
  const n = count > capacity ? capacity : count;
  if (n <= 0) {
    return previous;
  }
  let index = 0;
  let carry = previous;
  const blockEnd = n & ~7;
  if (blockEnd > 0) {
    // The "shifted" vector for each block is [prev_last, v0..v6]; the first
    // block's prev_last (lane 7, bytes 14-15 in the shuffle) is the carry.
    let prevLast = i16x8.splat(<i16>carry);
    while (index < blockEnd) {
      const cur = v128.load(ptr + (<usize>index << 1));
      const shifted = i8x16.shuffle(prevLast, cur, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29);
      v128.store(ptr + (<usize>index << 1), i16x8.sub(cur, shifted));
      prevLast = cur;
      index += 8;
    }
    carry = <i32>i16x8.extract_lane_s(prevLast, 7);
  }
  for (; index < n; index += 1) {
    const value = <i32>load<i16>(ptr + (<usize>index << 1));
    store<i16>(ptr + (<usize>index << 1), <i16>(value - carry));
    carry = value;
  }
  return carry;
}

export function deltaEncodeI16(count: i32, previous: i32): i32 {
  return deltaEncodeI16At(DELTA_PTR, count, previous, DELTA_CHUNK);
}

// Fused hover path: quantizeRaw/Affine/Wind has just populated QOUT_PTR, so
// delta that hot buffer in place before JS copies it into the packed variable
// body. This removes the later raw -> DELTA_PTR -> raw round trip while using
// the exact same wrapping-i16 implementation as deltaEncodeI16.
export function deltaEncodeQuantizedI16(count: i32, previous: i32): i32 {
  return deltaEncodeI16At(QOUT_PTR, count, previous, QUANT_CHUNK);
}

// Fused MVH4 path: quantizeRaw/Affine/Wind has just populated QOUT_PTR, so
// replace that absolute chunk with the exact per-variable 2D gradient
// residues before JS copies it out. A bounded previous-row arena is the only
// persistent storage. resetQuantizedGradient2d starts each variable and
// gradientEncodeQuantizedI16 preserves row/column state across arbitrary
// QUANT_CHUNK splits, including splits in the middle of a row.
//
// The public constants form a fail-closed optional ABI. JS validates the ABI,
// cap, canary, scratch ranges, and an active split-row oracle before exposing
// this capability to the hover producer.
export const GRADIENT_ABI_VERSION: i32 = 1;
export const GRADIENT_COLS_CAP: i32 = 32768;
export const GRADIENT_CANARY: i32 = 0x47523244; // ASCII "GR2D"
export const GRADIENT_PREVIOUS_ROW_PTR: usize = memory.data(65536, 16); // i16 x 32768

let gradientCols: i32 = 0;
let gradientCol: i32 = 0;
let gradientTopRow: bool = true;
let gradientLeft: i32 = 0;
let gradientUpLeft: i32 = 0;

export function resetQuantizedGradient2d(cols: i32): i32 {
  gradientCols = 0;
  gradientCol = 0;
  gradientTopRow = true;
  gradientLeft = 0;
  gradientUpLeft = 0;
  if (cols <= 0 || cols > GRADIENT_COLS_CAP) {
    return 0;
  }
  gradientCols = cols;
  return cols;
}

// @ts-ignore: decorator
@inline
function gradientFinishRow(): void {
  if (gradientCol == gradientCols) {
    gradientCol = 0;
    gradientTopRow = false;
    gradientLeft = 0;
    gradientUpLeft = 0;
  }
}

// Encode up to one row segment from QOUT_PTR. Top-row blocks are horizontal
// deltas; later-row blocks use [left, current0..6] and
// [up-left, up0..6] shifted vectors. All arithmetic is i16 lane arithmetic,
// exactly matching the container's modular signed-Int16 predictor.
export function gradientEncodeQuantizedI16(count: i32): i32 {
  if (gradientCols <= 0 || count <= 0) {
    return 0;
  }
  const n = count > QUANT_CHUNK ? QUANT_CHUNK : count;
  let index = 0;
  while (index < n) {
    const segmentEnd = index + min<i32>(gradientCols - gradientCol, n - index);
    if (gradientTopRow) {
      if (gradientCol == 0 && index < segmentEnd) {
        const value = <i32>load<i16>(QOUT_PTR + (<usize>index << 1));
        store<i16>(GRADIENT_PREVIOUS_ROW_PTR, <i16>value);
        // The first predictor is zero, so QOUT already contains its residue.
        gradientLeft = value;
        gradientCol = 1;
        index += 1;
      }
      while (index + 8 <= segmentEnd) {
        const current = v128.load(QOUT_PTR + (<usize>index << 1));
        const previousLast = i16x8.splat(<i16>gradientLeft);
        const shiftedCurrent = i8x16.shuffle(
          previousLast,
          current,
          14,
          15,
          16,
          17,
          18,
          19,
          20,
          21,
          22,
          23,
          24,
          25,
          26,
          27,
          28,
          29,
        );
        v128.store(QOUT_PTR + (<usize>index << 1), i16x8.sub(current, shiftedCurrent));
        v128.store(GRADIENT_PREVIOUS_ROW_PTR + (<usize>gradientCol << 1), current);
        gradientLeft = <i32>i16x8.extract_lane_s(current, 7);
        gradientCol += 8;
        index += 8;
      }
      while (index < segmentEnd) {
        const value = <i32>load<i16>(QOUT_PTR + (<usize>index << 1));
        store<i16>(
          QOUT_PTR + (<usize>index << 1),
          <i16>(value - gradientLeft),
        );
        store<i16>(
          GRADIENT_PREVIOUS_ROW_PTR + (<usize>gradientCol << 1),
          <i16>value,
        );
        gradientLeft = value;
        gradientCol += 1;
        index += 1;
      }
    } else {
      if (gradientCol == 0 && index < segmentEnd) {
        const value = <i32>load<i16>(QOUT_PTR + (<usize>index << 1));
        const up = <i32>load<i16>(GRADIENT_PREVIOUS_ROW_PTR);
        store<i16>(QOUT_PTR + (<usize>index << 1), <i16>(value - up));
        store<i16>(GRADIENT_PREVIOUS_ROW_PTR, <i16>value);
        gradientLeft = value;
        gradientUpLeft = up;
        gradientCol = 1;
        index += 1;
      }
      while (index + 8 <= segmentEnd) {
        const current = v128.load(QOUT_PTR + (<usize>index << 1));
        const up = v128.load(GRADIENT_PREVIOUS_ROW_PTR + (<usize>gradientCol << 1));
        const previousLast = i16x8.splat(<i16>gradientLeft);
        const previousUp = i16x8.splat(<i16>gradientUpLeft);
        const shiftedCurrent = i8x16.shuffle(
          previousLast,
          current,
          14,
          15,
          16,
          17,
          18,
          19,
          20,
          21,
          22,
          23,
          24,
          25,
          26,
          27,
          28,
          29,
        );
        const shiftedUp = i8x16.shuffle(
          previousUp,
          up,
          14,
          15,
          16,
          17,
          18,
          19,
          20,
          21,
          22,
          23,
          24,
          25,
          26,
          27,
          28,
          29,
        );
        const horizontal = i16x8.sub(current, shiftedCurrent);
        const verticalDelta = i16x8.sub(up, shiftedUp);
        v128.store(QOUT_PTR + (<usize>index << 1), i16x8.sub(horizontal, verticalDelta));
        v128.store(GRADIENT_PREVIOUS_ROW_PTR + (<usize>gradientCol << 1), current);
        gradientLeft = <i32>i16x8.extract_lane_s(current, 7);
        gradientUpLeft = <i32>i16x8.extract_lane_s(up, 7);
        gradientCol += 8;
        index += 8;
      }
      while (index < segmentEnd) {
        const value = <i32>load<i16>(QOUT_PTR + (<usize>index << 1));
        const up = <i32>load<i16>(GRADIENT_PREVIOUS_ROW_PTR + (<usize>gradientCol << 1));
        store<i16>(
          QOUT_PTR + (<usize>index << 1),
          <i16>(value - gradientLeft - up + gradientUpLeft),
        );
        store<i16>(
          GRADIENT_PREVIOUS_ROW_PTR + (<usize>gradientCol << 1),
          <i16>value,
        );
        gradientLeft = value;
        gradientUpLeft = up;
        gradientCol += 1;
        index += 1;
      }
    }
    gradientFinishRow();
  }
  return n;
}

// JS fills raw knot inputs (level hPa, height MSL m, tempK, rh%) for rows
// that pass the grid-side finiteness guards; the kernel applies the same
// dewpoint/ordering/selection rules the JS path applies.
export const DK_LEVEL_PTR: usize = memory.data(256, 16);
export const DK_HGT_PTR: usize = memory.data(256, 16);
export const DK_TMP_PTR: usize = memory.data(256, 16);
export const DK_RH_PTR: usize = memory.data(256, 16);

// sorted working arrays (surface row + accepted knots)
const DW_H: usize = memory.data(260, 16);
const DW_T: usize = memory.data(260, 16);
const DW_P: usize = memory.data(260, 16);
const DW_D: usize = memory.data(260, 16);
const DW_TE: usize = memory.data(260, 16);

const F32B: usize = 4;

// @ts-ignore: decorator
@inline
function dewpointFromTempRhF32(tempK: f32, rhPct: f32): f32 {
  if (!isFinite(tempK) || !isFinite(rhPct) || rhPct <= 0.0) {
    return f32.NaN;
  }
  const tempC = tempK - 273.15;
  const rh = Mathf.max(1.0, Mathf.min(100.0, rhPct));
  const gamma: f32 = Mathf.log(rh / 100.0) + (17.625 * tempC) / (243.04 + tempC);
  return 273.15 + (243.04 * gamma) / (17.625 - gamma);
}

// @ts-ignore: decorator
@inline
function boltonThetaEF32(tempK: f32, dewpointK: f32, pressureHpa: f32): f32 {
  if (!isFinite(tempK) || !isFinite(dewpointK) || !isFinite(pressureHpa) || pressureHpa <= 100.0) {
    return f32.NaN;
  }
  const dc = dewpointK - 273.15;
  const e: f32 = 6.112 * Mathf.exp((17.67 * dc) / (dc + 243.5));
  if (!isFinite(e) || e <= 0.0 || e >= pressureHpa) {
    return f32.NaN;
  }
  const w: f32 = (<f32>0.622 * e) / (pressureHpa - e);
  if (dewpointK <= 0.0) {
    return f32.NaN;
  }
  const lclT: f32 = 56.0 + 1.0 / (1.0 / (dewpointK - 56.0) + Mathf.log(tempK / dewpointK) / 800.0);
  if (!isFinite(w) || !isFinite(lclT)) {
    return f32.NaN;
  }
  const dryTheta: f32 = tempK * Mathf.exp(<f32>(0.2854) * (1.0 - 0.28 * w) * Mathf.log(1000.0 / (pressureHpa - e)));
  return dryTheta * Mathf.exp(((3376.0 / lclT) - 2.54) * w * (1.0 + 0.81 * w));
}

// thermo.wobusCorrectionC (both polynomial branches, f32)
function wobusF32(tempC: f32): f32 {
  const t = tempC - 20.0;
  if (!isFinite(t)) {
    return f32.NaN;
  }
  if (t <= 0.0) {
    const poly: f32 =
      1.0 +
      t *
        (<f32>-8.841660499999999e-3 +
          t * (<f32>1.4714143e-4 + t * (<f32>-9.671989000000001e-7 + t * (<f32>-3.2607217e-8 + t * <f32>-3.8598073e-10))));
    return 15.13 / (poly * poly * poly * poly);
  }
  let poly: f32 =
    t * (<f32>4.9618922e-7 + t * (<f32>-6.1059365e-9 + t * (<f32>3.9401551e-11 + t * (<f32>-1.2588129e-13 + t * <f32>1.668828e-16))));
  poly = 1.0 + t * (<f32>3.6182989e-3 + t * (<f32>-1.3603273e-5 + poly));
  return 29.93 / (poly * poly * poly * poly) + 0.96 * t - 14.8;
}

// thermo.saturatedLiftTemperatureC (secant-style Wobus solver)
function saturatedLiftF32(pressureHpa: f32, saturatedThetaC: f32): f32 {
  if (!isFinite(pressureHpa) || !isFinite(saturatedThetaC) || pressureHpa <= 0.0) {
    return f32.NaN;
  }
  if (Mathf.abs(pressureHpa - 1000.0) <= 0.001) {
    return saturatedThetaC;
  }
  const power: f32 = Mathf.exp(<f32>0.2854 * Mathf.log(pressureHpa / 1000.0));
  let error: f32 = 999.0;
  let prevT: f32 = f32.NaN;
  let prevE: f32 = f32.NaN;
  let temp: f32 = f32.NaN;
  let evalV: f32 = f32.NaN;
  let rate: f32 = 1.0;
  for (let iter = 0; iter < 80 && Mathf.abs(error) > 0.1; iter += 1) {
    if (error == 999.0) {
      prevT = (saturatedThetaC + 273.15) * power - 273.15;
      prevE = wobusF32(prevT) - wobusF32(saturatedThetaC);
      rate = 1.0;
    } else {
      const dE = evalV - prevE;
      if (!isFinite(dE) || Mathf.abs(dE) < 1e-9) {
        return f32.NaN;
      }
      rate = (temp - prevT) / dE;
      prevT = temp;
      prevE = evalV;
    }
    temp = prevT - prevE * rate;
    evalV = (temp + 273.15) / power - 273.15;
    evalV += wobusF32(temp) - wobusF32(evalV) - saturatedThetaC;
    error = evalV * rate;
  }
  return isFinite(temp) && isFinite(error) ? temp - error : f32.NaN;
}

// thermo.wetBulbTemperatureCAtPressure via moistLiftTemperatureK
function wetBulbCF32(tempK: f32, dewpointK: f32, pressureHpa: f32): f32 {
  if (!isFinite(tempK) || !isFinite(dewpointK) || !isFinite(pressureHpa) || pressureHpa <= 0.0) {
    return f32.NaN;
  }
  const cappedD = Mathf.min(dewpointK, tempK);
  if (cappedD <= 0.0) {
    return f32.NaN;
  }
  const lclT: f32 = 56.0 + 1.0 / (1.0 / (cappedD - 56.0) + Mathf.log(tempK / cappedD) / 800.0);
  if (!isFinite(lclT)) {
    return f32.NaN;
  }
  const lclP: f32 = pressureHpa * Mathf.exp(<f32>(1.0 / 0.2854) * Mathf.log(lclT / tempK));
  if (!isFinite(lclP) || lclP <= 0.0) {
    return f32.NaN;
  }
  // moistLiftTemperatureK(lclP, lclT, pressureHpa)
  const startC = lclT - 273.15;
  const thetaC: f32 = (startC + 273.15) * Mathf.exp(<f32>0.2854 * Mathf.log(1000.0 / lclP)) - 273.15;
  const satThetaC: f32 = thetaC - wobusF32(thetaC) + wobusF32(startC);
  const lifted = saturatedLiftF32(pressureHpa, satThetaC);
  return lifted; // already Celsius
}

function interpolateDcapeKnotF32(count: i32, pressureHpa: f32, outSlot: usize): bool {
  for (let row = 1; row < count; row += 1) {
    const lowerP = load<f32>(DW_P + <usize>(row - 1) * F32B);
    const upperP = load<f32>(DW_P + <usize>row * F32B);
    if (!(lowerP >= pressureHpa && upperP <= pressureHpa)) {
      continue;
    }
    if (row == 1 && !isFinite(load<f32>(DW_D))) {
      if (Mathf.abs(upperP - pressureHpa) > 1e-6) {
        return false;
      }
      store<f32>(outSlot, load<f32>(DW_T + <usize>row * F32B));
      store<f32>(outSlot, load<f32>(DW_D + <usize>row * F32B), 4);
      store<f32>(outSlot, load<f32>(DW_H + <usize>row * F32B), 8);
      return true;
    }
    let t: f32 = (Mathf.log(pressureHpa) - Mathf.log(lowerP)) / (Mathf.log(upperP) - Mathf.log(lowerP));
    t = Mathf.max(0.0, Mathf.min(1.0, t));
    const tl = load<f32>(DW_T + <usize>(row - 1) * F32B);
    const dl = load<f32>(DW_D + <usize>(row - 1) * F32B);
    const hl = load<f32>(DW_H + <usize>(row - 1) * F32B);
    store<f32>(outSlot, tl + (load<f32>(DW_T + <usize>row * F32B) - tl) * t);
    store<f32>(outSlot, dl + (load<f32>(DW_D + <usize>row * F32B) - dl) * t, 4);
    store<f32>(outSlot, hl + (load<f32>(DW_H + <usize>row * F32B) - hl) * t, 8);
    return true;
  }
  return false;
}

const DCAPE_SAMPLE: usize = memory.data(12, 16);

export function computeDcapeF32(
  knotCount: i32,
  surfaceHeight: f64,
  surfaceTemp: f64,
  surfacePressure: f64,
  sourceDepthHpa: f64,
  sourceLayerDepthHpa: f64,
): f64 {
  const surfH = <f32>surfaceHeight;
  const surfT = <f32>surfaceTemp;
  const surfP = <f32>surfacePressure;
  if (!isFinite(surfT) || !isFinite(surfP) || surfP <= 100.0) {
    return f64.NaN;
  }
  const layerDepth = <f32>sourceLayerDepthHpa;
  const pressureFloor: f32 = surfP - <f32>sourceDepthHpa;
  // ---- build knots: surface row + accepted inputs ----
  let count: i32 = 0;
  store<f32>(DW_H, surfH);
  store<f32>(DW_T, surfT);
  store<f32>(DW_P, surfP);
  store<f32>(DW_D, f32.NaN);
  store<f32>(DW_TE, f32.NaN);
  count = 1;
  const inCap = knotCount > DCAPE_KNOTS_CAP ? DCAPE_KNOTS_CAP : knotCount;
  for (let i = 0; i < inCap; i += 1) {
    const level = load<f32>(DK_LEVEL_PTR + <usize>i * F32B);
    if (!isFinite(level) || level >= surfP) {
      continue;
    }
    const hgt = load<f32>(DK_HGT_PTR + <usize>i * F32B);
    const tmp = load<f32>(DK_TMP_PTR + <usize>i * F32B);
    const rh = load<f32>(DK_RH_PTR + <usize>i * F32B);
    if (!isFinite(hgt) || hgt <= surfH || !isFinite(tmp) || !isFinite(rh)) {
      continue;
    }
    const dew = dewpointFromTempRhF32(tmp, rh);
    if (!isFinite(dew)) {
      continue;
    }
    store<f32>(DW_H + <usize>count * F32B, hgt);
    store<f32>(DW_T + <usize>count * F32B, tmp);
    store<f32>(DW_P + <usize>count * F32B, level);
    store<f32>(DW_D + <usize>count * F32B, dew);
    store<f32>(DW_TE + <usize>count * F32B, boltonThetaEF32(tmp, dew, level));
    count += 1;
  }
  if (count < 3) {
    return f64.NaN;
  }
  // insertion sort by height (5 parallel arrays)
  for (let i = 1; i < count; i += 1) {
    const h = load<f32>(DW_H + <usize>i * F32B);
    const t = load<f32>(DW_T + <usize>i * F32B);
    const p = load<f32>(DW_P + <usize>i * F32B);
    const d = load<f32>(DW_D + <usize>i * F32B);
    const te = load<f32>(DW_TE + <usize>i * F32B);
    let c = i - 1;
    while (c >= 0 && load<f32>(DW_H + <usize>c * F32B) > h) {
      store<f32>(DW_H + <usize>(c + 1) * F32B, load<f32>(DW_H + <usize>c * F32B));
      store<f32>(DW_T + <usize>(c + 1) * F32B, load<f32>(DW_T + <usize>c * F32B));
      store<f32>(DW_P + <usize>(c + 1) * F32B, load<f32>(DW_P + <usize>c * F32B));
      store<f32>(DW_D + <usize>(c + 1) * F32B, load<f32>(DW_D + <usize>c * F32B));
      store<f32>(DW_TE + <usize>(c + 1) * F32B, load<f32>(DW_TE + <usize>c * F32B));
      c -= 1;
    }
    store<f32>(DW_H + <usize>(c + 1) * F32B, h);
    store<f32>(DW_T + <usize>(c + 1) * F32B, t);
    store<f32>(DW_P + <usize>(c + 1) * F32B, p);
    store<f32>(DW_D + <usize>(c + 1) * F32B, d);
    store<f32>(DW_TE + <usize>(c + 1) * F32B, te);
  }
  // ---- candidate layer bottoms: min 100-mb layer-mean theta-e ----
  let bestMean: f32 = <f32>Infinity;
  let sourceP: f32 = f32.NaN;
  for (let row = 1; row < count; row += 1) {
    const bottomP = load<f32>(DW_P + <usize>row * F32B);
    if (!isFinite(bottomP) || bottomP < pressureFloor || bottomP > surfP) {
      continue;
    }
    const topP = bottomP - layerDepth;
    let prevP = bottomP;
    let prevTe = load<f32>(DW_TE + <usize>row * F32B);
    let weighted: f32 = 0.0;
    let usable = isFinite(prevTe);
    for (let upper = row + 1; usable && upper < count && load<f32>(DW_P + <usize>upper * F32B) > topP; upper += 1) {
      const p = load<f32>(DW_P + <usize>upper * F32B);
      const te = load<f32>(DW_TE + <usize>upper * F32B);
      if (!isFinite(te)) {
        usable = false;
        break;
      }
      weighted += ((prevTe + te) / 2.0) * (prevP - p);
      prevP = p;
      prevTe = te;
    }
    if (!usable) {
      continue;
    }
    // theta-e at the layer top (exact knot match first, then interpolation)
    let topTe: f32 = f32.NaN;
    let matched = false;
    for (let r = 0; r < count; r += 1) {
      if (Mathf.abs(load<f32>(DW_P + <usize>r * F32B) - topP) < 1e-6) {
        topTe = load<f32>(DW_TE + <usize>r * F32B);
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (!interpolateDcapeKnotF32(count, topP, DCAPE_SAMPLE)) {
        continue;
      }
      topTe = boltonThetaEF32(load<f32>(DCAPE_SAMPLE), load<f32>(DCAPE_SAMPLE, 4), topP);
    }
    if (!isFinite(topTe)) {
      continue;
    }
    weighted += ((prevTe + topTe) / 2.0) * (prevP - topP);
    const mean = weighted / layerDepth;
    if (isFinite(mean) && mean < bestMean) {
      bestMean = mean;
      sourceP = bottomP - layerDepth / 2.0;
    }
  }
  if (!isFinite(sourceP)) {
    return f64.NaN;
  }
  if (!interpolateDcapeKnotF32(count, sourceP, DCAPE_SAMPLE)) {
    return f64.NaN;
  }
  const srcT = load<f32>(DCAPE_SAMPLE);
  const srcD = Mathf.min(load<f32>(DCAPE_SAMPLE, 4), srcT);
  const srcH = load<f32>(DCAPE_SAMPLE, 8);
  if (!isFinite(srcH)) {
    return f64.NaN;
  }
  const wetBulbC = wetBulbCF32(srcT, srcD, sourceP);
  if (!isFinite(wetBulbC)) {
    return f64.NaN;
  }
  // ---- descend knot by knot with the fixed-step Euler scheme ----
  let parcelT: f32 = wetBulbC + 273.15;
  let parcelH: f32 = srcH;
  let parcelP: f32 = sourceP;
  let envT: f32 = srcT;
  let energy: f32 = 0.0;
  for (let row = count - 1; row >= 0; row -= 1) {
    const rowP = load<f32>(DW_P + <usize>row * F32B);
    if (!(rowP > sourceP)) {
      continue;
    }
    const nextH = load<f32>(DW_H + <usize>row * F32B);
    const nextEnvT = load<f32>(DW_T + <usize>row * F32B);
    const dz = parcelH - nextH;
    if (!isFinite(dz) || dz <= 1.0 || !isFinite(nextEnvT)) {
      continue;
    }
    const midP = (parcelP + rowP) / 2.0;
    // integrateMoistParcelDescentK (downward Euler, warms descending)
    let advanced: f32 = parcelT;
    {
      const steps = Mathf.max(1.0, Mathf.ceil(dz / 300.0));
      const stepDz = dz / steps;
      let t = parcelT;
      let ok = midP > 0.0;
      for (let s: f32 = 0.0; ok && s < steps; s += 1.0) {
        const tc = t - 273.15;
        const vap: f32 = 6.112 * Mathf.exp((17.67 * tc) / (tc + 243.5));
        if (!isFinite(vap) || vap <= 0.0 || vap >= midP) {
          ok = false;
          break;
        }
        const w = (<f32>0.622 * vap) / (midP - vap);
        const latent = (<f32>2.5e6 * w) / (<f32>287.05 * t);
        const denom: f32 = 1004.0 + (<f32>6.25e12 * w * <f32>0.622) / (<f32>287.05 * t * t);
        if (!isFinite(latent) || !isFinite(denom) || denom <= 0.0) {
          ok = false;
          break;
        }
        t += ((<f32>9.80665 * (1.0 + latent)) / denom) * stepDz;
      }
      advanced = ok && isFinite(t) ? t : f32.NaN;
    }
    const nextParcelT = isFinite(advanced) ? advanced : parcelT;
    const defUp = (<f32>9.80665 * (envT - parcelT)) / Mathf.max(180.0, envT);
    const defDn = (<f32>9.80665 * (nextEnvT - nextParcelT)) / Mathf.max(180.0, nextEnvT);
    const seg = ((defUp + defDn) / 2.0) * dz;
    if (isFinite(seg)) {
      energy += seg;
    }
    parcelT = nextParcelT;
    parcelH = nextH;
    parcelP = rowP;
    envT = nextEnvT;
  }
  return isFinite(energy) ? <f64>Mathf.min(4000.0, Mathf.max(0.0, energy)) : f64.NaN;
}
