# NOAA Beta Validation Log

Historical test and validation notes moved out of `plan.md`. Keep this file for run evidence and use `plan.md` for live future work.

## 2026-06-11 DCAPE v4 / Bunkers / Critical-Height

- Source audit: `docs/point-sounding-audit-2026-06-11.md` — every displayed index benchmarked value-by-value against SHARPpy as displayed by a third-party SHARPpy reference for the same model run, hour, and grid point (NAM 3km CONUS 2026-06-11 00z, F003, valid 03z, 40.43N 90.13W), with SHARPpy algorithm details verified against `sharppy/sharptab/params.py`.
- DCAPE v4 (`point-dcape-v4` / `reduced-profile-dcape-v4`) supersedes v3 in both point and gridded paths. v3's source selection (minimum point theta-e level with a +/-50 mb mean parcel) understated DCAPE ~40% versus SHARPpy; v4 matches SHARPpy/NSHARP by scoring each candidate level by the mean theta-e of the 100 mb layer above it and starting the parcel at the layer midpoint (candidate minus 50 mb), reaching colder/drier air (550 mb vs 625 mb on the benchmark profile). Point path uses 1 hPa layer-mean steps and the exact Wobus pseudoadiabat; gridded path uses knot-trapezoid layer means and the Euler moist descent. After the fix: 1138 J/kg vs SHARPpy 1120 (was 675); downrush temp 63F vs 63F; gridded and point paths agree within 0.1% on the regression fixture.
- Bunkers storm motion fixed to point winds at the shear layer bottom/top (fixed and effective variants), matching SHARPpy/SHARPlib `wind_shear`; the prior 500 m layer-mean endpoints rotated the shear vector under a nocturnal low-level jet and collapsed the right-mover (RM 259/29 kt vs SHARPpy 260/42). After the fix: RM 261/42, LM 219/41 (SHARPpy 260/42, 219/41), SRH 0-1 km 412 vs 410, SRH 0-3 km 449 vs 448, ESRH 450 vs 449, SRW 4-6 km 7 kt vs ~5.
- Critical-temperature heights fixed (`interpolateHeightForTemperature` / `interpolateHeightForWetBulbZero`): a negative interpolation denominator was clamped to 1e-9, snapping every 0/-10/-20/-30C and fallback WBZ height to the level below the crossing, ~300 m (~1000 ft) low. After the fix: 0C 15,468 ft vs SHARPpy 15,360; -20C 25,719 vs 25,658; -30C 30,579 vs 30,514 (residuals are interpolation-grid differences).
- Additions from the same audit: 3CAPE (187 J/kg vs SHARPpy 193 on the benchmark) and SHIP (1.8 vs SHARPpy 1.8).
- Validation: `node --test tests-node/noaa-beta.test.js` 112 pass (Bunkers and DCAPE tests updated to encode the new conventions; DCAPE gridded/point consistency held at <0.1%); `npm run typecheck`, `npm run lint -- --quiet`, `npm run build`, `npm run smoke:react` (33 pass), touched-file Prettier all clean; drawer screenshots at the benchmark point inspected against the SHARPpy reference.

## 2026-06-10 DCAPE v3 (Pseudoadiabatic Descent, superseded by v4 — see 2026-06-11 entry above)

- Replaced the dry-adiabatic-descent DCAPE (v2) in both gridded and point paths with SPC/SHARPpy-style conventions: minimum theta-e source in the lowest 400 mb above ground with a 100 mb mean source layer, pressure-aware Normand wet-bulb at the source level, pseudoadiabatic (saturated) descent, and a net plain-temperature buoyancy integral clamped to 0-4000 J/kg. Gridded uses the fixed-step moist-lapse Euler integrator (new `integrateMoistParcelDescentK`); point soundings use the exact Wobus pseudoadiabat on the full profile.
- Cross-method validation: the independent gridded Euler and point Wobus implementations agree within 0.1% on an inverted-V test profile (719 vs 720 J/kg); a saturated stable profile yields ~10 J/kg. Covered by a new unit test with banded assertions and a 2% cross-method tolerance.
- Artifact A/B on the 8-frame fixture (same NOAA runs via interleaved stash rebuild): exactly 8 of 336 artifact files changed - `dcape.png` and `hover-grid.bin.gz` on each model - with zero collateral diffs. Frame profile DCAPE distributions moved from p99~430/max~800 J/kg (dry descent) to p99~1500/max~2000 J/kg, matching SPC mesoanalysis magnitudes for the regime.
- Measured cost: derivedGrid +24.3s across 28 base partials (~+0.87s/frame average), inside the pre-implementation estimate of +0.4 to +1.3s/frame.
- `node --test` passes with 111 tests; typecheck, lint --quiet, React smoke (33), Prettier, and `git diff --check` pass.

## 2026-05-01 Upper-Air Height Contours

- `node --test tests-node/noaa-beta.test.js`: passed, 40 tests.
- `npm run typecheck`: passed.
- `npm run lint`: passed with warning-class lint debt, 0 errors.
- `npx prettier --check` on touched code files: passed.
- Initial contour build smoke, before the simple-smoothing adjustment: `npm run noaa:build:test -- --models=gfs,nam,nam3km,hrrr --frames=6 --run-offset=1` passed after network-capable rerun; GFS `20260501-0600Z`, NAM/NAM3km `20260501-1200Z`, HRRR `20260501-1900Z`, 6/6 frames built for each model.
- Initial manifest sidecar spot-check confirmed non-empty `height850/700/500/300/250` contour-vector JSON with lines and labels for first frames across all four models.
- Follow-up contour efficiency pass for compact vectors, canvas rendering, and multi-level marching squares: `node --test tests-node/noaa-beta.test.js` passed, 42 tests; `npm run typecheck` passed; `npm run lint` passed with the repo's existing 46 warning-class lint items and 0 errors; targeted `npx prettier --check` passed; `git diff --check` passed.
- Browser visual check intentionally skipped at user request.

## 2026-06-10 NOAA Beta Renderer Validation

- Reflectivity precip-type opacity rollback:
  - Restored the opacity-aware RGBA ramp in `shared/reflectivity-precip-type-colors.json` that `f416c49` had replaced with opaque white-composited colors.
  - Validation: `node --test tests-node/noaa-beta.test.js` passed; `npx prettier --check shared/reflectivity-precip-type-colors.json tests-node/noaa-beta.test.js` passed; `git diff --check` passed.
- Palette hard-break pass:
  - Added duplicate-value stops to preserve source-palette category jumps without making every continuous palette stepped: surface temp 32F; 850/700 mb temp 0C; 500 mb temp -20C; dew point 50/60/70/80F; visibility 1/3/6/10 mi; and snowfall/snow-depth 1, 6, 12, 24, and 36 inches.
  - Precipitation and reflectivity remain true stepped lookups. Reflectivity + precip type keeps the opacity-aware RGBA ramp from the source legend extraction; below-filter bins remain transparent.
  - Validation: `node --test tests-node/noaa-beta.test.js` passed; `npm run typecheck` passed; `npm run lint` passed with 46 existing warning-class hotspots; targeted `npx prettier --check shared/color-mapping-v2.json shared/snowfall-legend-colors.json shared/reflectivity-precip-type-colors.json next/src/config/layers.ts tests-node/noaa-beta.test.js` passed.
- Snow raster de-pixeling pass:
  - Root cause: snowfall accumulation reused hard categorical precipitation-type masks for snow-liquid weighting.
  - Fix: snow-liquid APCP fallback masks are decoded with bilinear interpolation and fractional snow weighting while public precip-type display masks stay categorical.
  - Cache/signature invalidation: bumped snow-liquid, snowfall delta/cumulative, and NOAA renderer signature versions.
  - User confirmed snowfall improved.
  - Validation: `node --test tests-node/noaa-beta.test.js` passed; `npm run typecheck` passed; `npm run lint` passed with 46 existing warning-class hotspots; targeted `npx prettier --check scripts/lib/noaa-beta-renderer.js tests-node/noaa-beta.test.js` passed. Full `npm run format:check` still reports the repo's pre-existing non-Prettier files, including the old `plan.md`.
- General checks from latest renderer work:
  - `node --test tests-node/noaa-beta.test.js`: passed.
  - `npm run typecheck`: passed.
  - `npm run lint`: passed with the repo's existing 42 warning-class hotspots.
  - `npm run test:local-runtime`: passed on escalated rerun after sandboxed `127.0.0.1` bind `EPERM`.
  - `npm run noaa:build:test -- --models=gfs,nam,nam3km,hrrr --frames=6 --run-offset=1`: previously passed; 24/24 frames built, 0 failures, about 22s wall-clock with cached raw inputs before the snowfall RF additions.
  - `npm run noaa:snow-rf:export -- --source-dir=/private/tmp/utahrfslr-codex --python=/Users/micha/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3`: exported the Pletcher CONUS RF to compact Node tree arrays and imported it into `tools/noaa-beta/snow-rf/conus-rf.json`.
- Snowfall layer validation:
  - Manifests expose deterministic snowfall layers where source records exist and expose ML/formula layers only when their imported artifacts and profile fields exist.
  - HRRR exposes `snowHrrrAsnow` when `ASNOW:surface` is present.
  - Unit tests cover snow-liquid interval planning, `WEASD` preference, `APCP`/`CSNOW` fallback masking, Kuchera ratio, Cobb ratio, and RF gating metadata.
- Byte-for-byte renderer correctness comparison passed on identical synthetic decoded grids covering 44 layer artifacts, 6 reflectivity gate variants, synoptic payloads, and the binary hover grid.
- Combined precip-type reflectivity visual-check render for `20260426-1200Z`, `view=conus`, hours `0,3,6,9,12`, models `gfs,nam,nam3km,hrrr`:
  - All four models built 5/5 frames with 0 failures.
  - Manifests expose `reflectivity1kmPrecipType` with four precip-type legend rows.
  - Standalone precip-type public layers are absent.
- Reflectivity split visual-check render for `20260426-1200Z`, `view=conus`, hours `0,3,6,9,12`, models `gfs,nam,nam3km,hrrr`, gates `10,15,20`:
  - All four models built 5/5 frames with 0 failures.
  - Manifests expose `reflectivityComposite`, `reflectivity1km`, and `reflectivityVariantsByLayer` entries for both reflectivity layers and all three gates.
- Accumulated-precip full cold render for `20260426-1200Z`, `view=conus`, models `gfs,nam,nam3km,hrrr`, gates `10,15,20`:
  - 276 total manifest frames loaded, 0 failures.
  - All four full-run manifests expose all five accumulated-precip layers.
  - Every full-run frame has nonzero-byte artifacts and visible precip pixels for all five accumulated-precip layers.
- Requested-parameter source validation on `20260426-1200Z` official NOAA `.idx` files:
  - `f000`, `f001`, `f003`, `f012`, and `f024` fetched successfully for GFS `pgrb2.0p25`, NAM `awphys`, NAM3km `conusnest.hires`, and HRRR `wrfprs`.
  - Confirmed plan rows for `ABSV`, `VVEL`, UH, LCL, SCP/STP derivability, frontogenesis derivability, simulated IR proxy, and accumulated precipitation.
  - Added findings for snowfall/SLR, HRRR `ASNOW`, HRRR `FRZR`, all-model freezing-rain derivation, and FRAM-style total ice.
- Pletcher CONUS RF implementation availability:
  - Public repo `mdpletcher/utahrfslr` found with RF model directory, examples, and scripts.
  - Implementation is now feasible as an integration task; biggest work is mapping NOAA beta decoded grids/profiles into the repo's expected feature set and deciding whether to invoke Python or port/export RF inference into Node.
- Western-mountain SLR implementation availability:
  - Public repo `pveals/Veals_etal_2025` found with V1c fixed linear model files, predictor keys, sample data, and load/use notebooks.
  - Implemented `snowWesternLinear` from the V1c HRRR linear coefficients. It is much cheaper than RF inference and avoids unvalidated western RF preprocessing.
