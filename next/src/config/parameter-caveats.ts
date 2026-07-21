// Documented accuracy caveats surfaced in the parameter menu. Each entry is a
// disclosed limitation from the methodology record — not a bug list. Sources:
// plan.md (Winter Methodology, Severe Products, App-completion decisions),
// docs/methodology-audit-2026-06-11.md, docs/noaa-beta-implemented-products.md.
// Keep entries short: they render as an ⓘ marker + tooltip line.

const ROLLING_ACCUMULATION_CAVEAT =
  "Rolling window: early frames read as run-start totals until the forecast history covers the full window.";

const GRIDDED_CIN_CAVEAT =
  "Gridded CIN integrates all sub-LFC negative buoyancy (no 500 mb cap), so it reads more negative than a point sounding at the same cell in deep or elevated regimes.";

const HEIGHT_HOVER_CAVEAT = "Hover samples the unsmoothed field; contour smoothing is presentation-only.";

const FRONTOGENESIS_CAVEAT =
  "PNG applies positive-only heavy smoothing for readability; hover values are raw Petterssen finite differences.";

export const PARAMETER_CAVEATS: Readonly<Partial<Record<string, string>>> = Object.freeze({
  // Winter methodology (plan.md)
  reflectivity1kmPrecipType:
    "Instantaneous reflectivity + model precip-type masks — can show snow or freezing rain where accumulated totals are zero or trace.",
  precipRateAndType:
    "Precip type is the model's instantaneous phase mask, not an accumulation; display is transparent below 0.02 in/hr.",
  freezingRainLiquidTotal:
    "Direct accumulated FRZR when present; otherwise APCP weighted by the CFRZR phase fraction (complete phase masks required).",
  framFlatIce: "FRAM ice from freezing-rain liquid + surface environment; zero liquid short-circuits to zero ice.",
  framRadialIce: "FRAM ice from freezing-rain liquid + surface environment; zero liquid short-circuits to zero ice.",
  snowKuchera:
    "Uses the warmest instantaneous surface-to-500 mb profile temperature; SLR is clamped to 3-50:1. Complete profile inputs are required.",
  snowCobb:
    "Cobb/Waldstreicher SLR uses instantaneous TMP/RH/HGT/VVEL every 25 mb from 925-300 mb and the operational T-1/T/T+1 C response mean; complete profiles required.",
  snowRfConus:
    "Pletcher random-forest SLR is limited to the approximate lower-48 training domain (24-49N, 125-66.5W), uses instantaneous model profile features, and is clamped to 1-60:1.",
  snowWesternLinear:
    "Veals V1c is HRRR-only within 31-49N, 125-103W and terrain >=1000 m. Instantaneous endpoint profiles approximate the paper's period-mean predictors; SLR is clamped to 1-60:1.",
  snowHrrrAsnow: "Direct model ASNOW; HRRR only.",
  snowDepth: "Instantaneous snowpack-depth state at the valid time, not interval snowfall accumulation.",
  snowWaterEq: "Instantaneous snowpack water-equivalent state at the valid time, not interval snowfall accumulation.",

  // Severe products (plan.md, methodology audit items 1-3)
  effectiveBulkShear:
    "Effective-inflow-gated proxy: reports fixed 0–6 km shear inside the effective mask, not true per-cell effective-layer EBWD (deferred as compute-bound).",
  effectiveLayerSupercellCompositeParameter:
    "Reduced-profile ESRH/EBWD (25–50 mb parcel spacing). " + GRIDDED_CIN_CAVEAT,
  effectiveLayerSignificantTornadoParameter:
    "Uses model-native 90-mb MLCAPE/MLCIN as an approximation to SPC's 100-mb mixed layer, with reduced-profile MLLCL/ESRH/EBWD (25-50 mb parcel spacing). " +
    GRIDDED_CIN_CAVEAT,
  dcape:
    "Gridded DCAPE integrates over reduced diagnostic levels (reduced-profile-dcape-v4); point soundings use the dense reference calculation.",
  sbcin: GRIDDED_CIN_CAVEAT,
  mlcin: GRIDDED_CIN_CAVEAT,

  // Rolling accumulations (docs/noaa-beta-implemented-products.md)
  precip: ROLLING_ACCUMULATION_CAVEAT,
  precip3h: ROLLING_ACCUMULATION_CAVEAT,
  precip6h: ROLLING_ACCUMULATION_CAVEAT,
  precip12h: ROLLING_ACCUMULATION_CAVEAT,
  precip24h: ROLLING_ACCUMULATION_CAVEAT,

  // Presentation-only smoothing (plan.md)
  frontogenesis850: FRONTOGENESIS_CAVEAT,
  frontogenesis700: FRONTOGENESIS_CAVEAT,
  height850: HEIGHT_HOVER_CAVEAT,
  height700: HEIGHT_HOVER_CAVEAT,
  height500: HEIGHT_HOVER_CAVEAT,
  height300: HEIGHT_HOVER_CAVEAT,
  height250: HEIGHT_HOVER_CAVEAT,
});

export function getParameterCaveat(key: string): string | null {
  return PARAMETER_CAVEATS[key] ?? null;
}
