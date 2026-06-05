# NOAA Beta Renderer Plan

This is the live plan for the NOAA beta renderer. Keep it focused on current behavior, useful constraints, and next work. Historical implementation notes belong in `docs/noaa-beta-implemented-products.md`; validation history belongs in `docs/noaa-beta-validation-log.md`; benchmark history, optimization history, and active optimization candidates belong in `docs/noaa-renderer-benchmark-history.md`.

## Scope

- Native NOAA beta renderer supports `gfs`, `nam`, `nam3km`, and `hrrr`.
- Source products are GFS `pgrb2.0p25`, NAM `awphys`, NAM 3 km `conusnest.hires`, and HRRR `wrfprs`.
- Current manifests are metadata-driven and must be regenerated after renderer/catalog signature changes.
- Accuracy is the first rule: omit unavailable derived products rather than showing dead controls or heuristic-filled fields.

## Current Behavior

- As of 2026-05-09, the NOAA renderer is the default local runtime and app data source.
- Local artifact generation uses `scripts/build-noaa-beta-artifacts.js` and writes to `output/noaa-beta-cache` unless `MODELVIEW_CACHE_ROOT` overrides it.
- The local dev server serves prebuilt NOAA artifacts through the React app; removed prior-renderer entrypoints should stay deleted unless a new NOAA-backed workflow explicitly needs an equivalent.
- Point soundings are available from the local artifact server for loaded NOAA model frames. The app opens them from a map double-click and samples the nearest GRIB grid point on demand.
- Point sounding UI follows an operational Skew-T workflow: large thermodynamic plot with wind barbs, height/isotherm markers, an explicitly labeled on-demand parcel trace, hodograph with Bunkers/mean-wind vectors, compact parcel/kinematic/lapse/critical-temp/composite tables, effective-layer diagnostics, and a possible-hazard signal that requires buoyancy.
- Direct products are implemented for planned upper-air, precip, cloud, radar, severe, winter, and CAM fields where source records exist.
- Derived scalar and derived accumulation products use the existing scalar PNG, legend, hover-grid, and manifest shapes.
- Implemented derived products include relative vorticity, surface LCL fallback, 700-500 mb lapse rate, surface theta-e, gust run max, UH run max, 0-6 km bulk shear, 0-3 km lapse rate, 700/850 mb frontogenesis, freezing-rain liquid, FRAM flat/radial ice, effective bulk shear, SCP, STP, and DCAPE.
- Source palettes are treated as data. White/near-white stops that mean no ink are transparent, intentional hard breaks are preserved, and source SHA-256 checks run when local source-color fixtures are present.
- Frontogenesis hover values remain raw finite-difference values. Only the PNG presentation applies positive-only heavy smoothing.
- Relative vorticity uses a true zero-alpha ramp: exact zero is transparent, weak positive values fade into yellow, and weak negative values fade into gray without white/black halos.

## Severe Products

- Point soundings sample direct NOAA severe fields when they exist, but parcel-family CAPE/CIN and SRH diagnostics shown in the drawer are profile-derived for internal consistency. Direct fields such as PWAT, wet-bulb zero, PBL height, UH, hail, and model SRH remain useful source/context values.
- Point-sounding parcel work is on-demand only. Use it for sounding-specific diagnostics such as LFC/EL, Bunkers motion, storm-relative winds, effective-layer context, and composites that require a valid effective inflow layer.
- Point-sounding effective SCP/STP should remain missing when the effective inflow layer or required direct CAPE/CIN terms are not present; do not fill them with broad heuristics.
- Point-sounding parcel traces and parcel CAPE/CIN tables use the clicked-profile parcel calculation for internal consistency. Direct model CAPE/CIN fields remain sampled as source data but should not override point-sounding parcel-family diagnostics.
- Point-sounding surface LCL uses the clicked-profile parcel calculation from surface temperature/dew point first. The direct NOAA LCL height remains a fallback because direct zero samples can be misleading when the surface spread is nonzero.
- Point-sounding lapse-rate tables display virtual-temperature lapse rates for analyst use, with literal-temperature lapse rates retained as hover detail.
- Point-sounding SRH, EHI, and point-composite diagnostics prefer profile-derived SRH from the plotted Bunkers right-mover storm motion. Direct model SRH remains available as source detail and fallback.
- Point-sounding Bunkers motion uses the effective-inflow Bunkers method when effective layer and MU equilibrium level are valid, with fixed SFC-6 km Bunkers as fallback.
- Sounding and gridded effective-layer diagnostics use a fast pressure-segment mean wind through AGL layers, with height-mean fallback only when pressure interpolation is unavailable. This avoids dense pressure stepping in render loops.
- Sounding and gridded mixed-layer LCL diagnostics use a pressure-segment, mass-weighted lowest-100 hPa mean of potential temperature and mixing ratio. Direct MLCAPE/MLCIN remain preferred for CAPE/CIN values when present.
- Point-sounding Corfidi MCS vectors use the SHARPpy-style MBE method: 850-300 hPa non-pressure-weighted mean wind, or surface-300 hPa when the surface is already below 850 hPa, minus the surface-1.5 km non-pressure-weighted mean wind for upshear, with downshear as the deep mean plus that upshear vector.
- `SCP (0-3 km Proxy)` preserves the legacy/current SCP: MUCAPE, direct 0-3 km SRH, and the effective-inflow-gated 0-6 km shear proxy with the SPC shear cap at 20 m/s.
- `SCP (Effective Layer)` is separate: MUCAPE, reduced-profile Bunkers ESRH, and reduced-profile EBWD with SPC-style normalization and no CIN damping. Effective-layer Bunkers motion is used when the effective layer and MU equilibrium level are valid, with fixed SFC-6 km Bunkers as fallback. Effective inflow parcel origins use every loaded profile row: 25 mb spacing from 1000-700 mb and 50 mb spacing from 700-300 mb.
- `STP (Fixed Layer)` preserves fixed-layer STP: surface-based CAPE, surface LCL, 0-1 km SRH, and 0-6 km bulk shear.
- `STP (Effective Layer)` is separate: MLCAPE, reduced-profile MLLCL, reduced-profile Bunkers ESRH/EBWD, and MLCIN, zeroed when the effective inflow base is above ground. EBWD uses the SPC-style 12.5 m/s zero gate and 20 m/s normalization capped at 1.5. Effective-layer Bunkers motion is used when the effective layer and MU equilibrium level are valid, with fixed SFC-6 km Bunkers as fallback. Effective inflow parcel origins use every loaded profile row, matching the SCP profile cadence.
- `DCAPE` is a fast reduced-profile approximation: select the minimum wet-bulb/theta-e source layer from 500-800 mb, descend it dry adiabatically through the sampled environmental temperature profile, and report positive downdraft buoyancy energy. It is not a full MetPy/Emanuel downdraft parcel trace.
- Effective bulk shear is currently an effective-inflow-gated 0-6 km shear proxy. Cells must pass surface or mixed-layer CAPE/CIN thresholds, then the product reports fixed 0-6 km vector shear inside that mask.
- MUCAPE-only elevated instability remains masked until an elevated effective-layer base/top calculation exists.

## Winter Methodology

- Reflectivity precip type is instantaneous `REFD + CRAIN/CSNOW/CFRZR/CICEP`, not an accumulation product. It can show snow or freezing rain where accumulated snowfall/freezing-rain liquid is zero or trace.
- Internal precip-type masks remain internal inputs for precip-rate/type, reflectivity/type, snowfall, freezing-rain, and FRAM products.
- `CICEP` is sleet/ice pellets. `CFRZR` is freezing-rain occurrence/type, not accumulation.
- Snowfall prefers direct accumulated snow-water sources (`WEASD`, HRRR `ASNOW`) when present. APCP-derived snow requires complete phase-mask records and rejects sampled phase-mask gaps.
- Kuchera and Cobb snowfall require complete profile inputs. If profile prerequisites are missing, omit the derived product or mark affected cells unknown rather than filling with a fallback.
- Accumulated snowfall preserves `NaN` as unknown through interval and cumulative merges. Verified finite zero intervals can carry totals forward; missing interval cells cannot silently undercount totals.
- Snowfall paint uses the source trace opacity ramp below `0.1 in`, while hover grids preserve trace values.
- Freezing-rain liquid uses direct accumulated `FRZR` when present; otherwise it uses accumulated APCP weighted by interval-average or sampled `CFRZR` fraction, with complete phase masks required.
- FRAM flat/radial ice is calculated only from freezing-rain liquid and sampled surface environment. Per-cell zero liquid returns zero ice without wet-bulb or wind work; trace liquid uses the supplied freezing-rain/ice opacity ramp.

## Hidden Products

- Keep these removed from new NOAA manifests and filtered out of cached manifests: public storm-motion vectors, simulated IR proxy, cloud base, freezing level/0C height, snow cover, 850 mb absolute vorticity, and 850 mb omega.

## Optimization Notes

- Detailed optimization history, benchmark fixtures, benchmark gates, rejected experiments, and active optimization candidates live in `docs/noaa-renderer-benchmark-history.md`.
- Keep `plan.md` limited to operational renderer behavior, durable decisions, and validation expectations; move future optimization logs/backlogs to the benchmark history doc.

## Validation Baseline

- `node --test tests-node/noaa-beta.test.js` should pass.
- `npm run typecheck` should pass.
- `npm run lint -- --quiet` should pass.
- `npm run smoke:react` should pass before handoff when app artifact-loading behavior changes.
- Touched-file Prettier checks and `git diff --check` should pass before handoff.

## Durable Decisions

- Derived severe and winter products must include formula/version/applicability metadata in manifests or sidecar metadata.
- Product availability stays manifest-gated by required inputs. If source records or profile prerequisites are absent, omit the product.
- Point sounding cache behavior must reuse selected/rendered GRIB cache records first; only add a lean point-sounding selected-GRIB cache when the rendered selection does not cover required sounding fields.
- Do not precompute expensive point-sounding parcel diagnostics during artifact builds. Cache missing raw/direct fields cheaply and run point-specific profile analysis only after the user requests a location.
- Do not use broad weather heuristics to skip meteorological calculations. Only skip when the value is definitively impossible, missing, zero, or intentionally unavailable by build mode.
- Do not downsample derived calculations and upscale them for operational layers.
- Do not hide trace calculations just because display thresholds would hide them, unless the output is mathematically bounded below that display threshold and the decision is documented.
- Use smoothed color interpolation where it improves continuous scalar readability, while preserving intentional hard transitions, category breaks, transparent ramps, and source-legend discontinuities.
- CAM-only or CAM-first products should be labeled that way in UI/config so GFS/NAM do not imply false precision.
- Snowfall RF remaining work: keep fixture-validating Node CONUS RF inference against sklearn when refreshing artifacts. The implemented western member is the fixed Veals V1c linear formula.
