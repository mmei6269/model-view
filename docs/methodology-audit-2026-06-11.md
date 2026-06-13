# model-view Per-Parameter Accuracy Audit

Date: 2026-06-11

Scope: every catalog parameter (79 entries) individually checked for meteorological accuracy against its source selectors, unit conversions, derivation formulas, and display/hover semantics, in the post-module-split renderer with DCAPE v3. Optimization review folded in (rounding-error-tolerant changes allowed; none found beyond the established compute floor).

## Verified accurate (no change)

- Unit transforms (all three code paths agree): K->F (`x9/5 - 459.67`), K->C, Pa->hPa, kg/kg->g/kg, m->mi (`/1609.344`), m->ft (`x3.28084`), m->dam, m->in (`x39.3701`), kg/m^2->water inches (`/25.4`), s^-1 -> 10^-5 s^-1, Pa/s -> dPa/s (`x10`, numerically identical to the ub/s convention), m/s->kt (`1.943844`), m/s->mph (`2.2369362920544`).
- Surface group: 2 m TMP/DPT/RH, surface VIS/GUST, 10 m and 80 m wind levels, TCDC entire-atmosphere, cloud ceiling (MSL HGT minus surface HGT -> AGL, correct for the FAA ceiling definition), wet-bulb-zero HGT (displayed in ft, MSL-labeled).
- Precip family: rolling APCP windows (window resolution tested), PRATE `x3600/25.4` -> in/hr, precip-type priority freezing rain > sleet > snow > rain (operational hazard precedence), reflectivity composite/1 km selectors, categorical reflectivity thresholds (documented design).
- Severe direct: CAPE/CIN at surface (SB), 90-0 mb (ML), 255-0 mb (MU); HLCY 3000-0/1000-0 m; MXUPHL 5000-2000 m; HAIL (m->in); PWAT (kg/m^2 = mm, identity); HPBL.
- Upper air: TMP/RH/HGT/UGRD/VGRD/ABSV/VVEL pressure-level selectors; relative vorticity = ABSV - f with f = 2(7.2921e-5)sin(lat) per Mercator row; VVEL sign/unit convention.
- Derived: Bolton theta-e (eqs. 24/38 form with station pressure); surface LCL (direct MSL->AGL with Bolton fallback); 700-500 lapse (T_low - T_high over geometric depth) and 0-3 km AGL lapse (2 m temperature base); Petterssen 2D kinematic frontogenesis (deformation + divergence terms, scaling 1e5 x 10800 -> C/100km/3hr) with per-Mercator-row finite-difference spacing (dx = 2 R cos(lat) dlon, dy from actual neighbor-row latitudes); fixed-layer STP and 0-3 km proxy SCP (SPC term shapes, gates, and caps); effective-layer SCP/STP (exact SPC normalizations: MUCAPE/1000, ESRH/50, EBWD 10 m/s zero gate and /20 cap for SCP; MLCAPE/1500, ESRH/150, EBWD 12.5 gate with 1.5 cap, LCL and CIN terms for STP); DCAPE v3 (validated 2026-06-10/11, see validation log); Bunkers 7.5 m/s deviation; effective-inflow candidate gates CAPE >= 100, CIN >= -250.
- Run max: gust and interval-aware MXUPHL run maxima with exact carry-forward semantics.
- Winter: FRAM matches Sanders & Barjenbruch (2016) exactly (ILR_P = 0.1395 P^-0.541; ILR_Tw cubic -0.0071/-0.1039/-0.3904/+0.5545; ILR_V = 0.0014 V^2 + 0.0027 V + 0.7574; blend weights 0.7/0.29/0.01, 0.73/0.01/0.26 above 12 kt, 0.79/0.2/0.01; radial = 0.394 x flat; regression-domain clamps at 0.02 in/hr and -7 C); Kuchera (12 + 2(-2 - Tmax) warm side, 12 + (-2 - Tmax) cold side, column max including surface, surface-to-500 mb levels); Cobb (omega -> w via density, subsidence layers skipped, sqrt(w) weight with (RH/80)^2 damping below 80%, canonical 11-knot spline tables, 925-300 mb levels); 10:1; HRRR ASNOW (m->in); SNOD (m->in); WEASD state (kg/m^2 -> water in).
- Hover quantization: every unit's Int16 scale x range covers its physical domain with adequate precision (e.g., temperature 0.05, accumulations 0.01 in, unitless composites 0.1, CAPE 1 J/kg).
- Synoptic/contours: PRMSL Pa->hPa isobars, 1000-500 thickness in dam, height contour intervals; hover uses unsmoothed fields (smoothing is presentation-only, documented).

## Fixed (minor compute)

- F1: the legacy SCP grid silently fell back `mucape || sbcape || mlcape` when the MU grid object was absent. Catalog gating makes the fallback unreachable in practice (verified byte-identical artifacts), but it violated the omit-rather-than-substitute doctrine; SCP now requires MUCAPE and omits otherwise.

## Accurate fixes that would require significant compute (reported, not done)

1. Gridded DCAPE vertical resolution: descent physics is now correct (v3) but integrates over the reduced diagnostic levels (1000/925/850/700 usable below typical sources). Using the dense effective-layer level set would sharpen the integral at roughly +0.3-0.8 s/frame of decode+compute on models that do not already load it.
2. `effectiveBulkShear` remains the documented effective-inflow-gated fixed 0-6 km shear proxy. True effective-layer EBWD (inflow base to 50% MU EL) per cell requires the full parcel scan on models where effective-layer products are filtered today (GFS/NAM dense profile decode plus the parcel pipeline).
3. MUCAPE-only elevated instability remains masked pending an elevated effective-layer base/top calculation (parcel-scan cost on additional cells).
4. Gridded Cobb uses VVEL at the reduced 850/700/500 levels; a denser omega profile would better resolve the snow-growth-zone weighting at additional decode cost.
5. Display-domain notes (no science change): the HAIL selector takes the first matching record on models exposing multiple HAIL levels; cloud-ceiling unlimited sentinels rely on palette caps.

## Optimization review

No new rounding-error-tolerant optimizations were found beyond the established floor: remaining hot costs are the SPC parcel pipeline (methodology-bound transcendental volume), zlib at fixed output bytes, and per-pixel loops already at minimal operation counts (see the benchmark history for the 2026-06-10 passes). DCAPE v3's ~+0.9 s/frame is methodology cost, not overhead.

## Validation

- 111 node tests pass; typecheck, lint --quiet, Prettier, and `git diff --check` pass.
- 8-frame fixture builds clean (32/32 frames, 4 models); F1 verified byte-identical on re-rendered models via interleaved rebuild (244 artifact files compared; HRRR run advanced mid-check and is covered by the shared nam3km code path).
