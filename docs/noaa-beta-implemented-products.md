# NOAA Beta Implemented Product Notes

This document holds implemented NOAA beta renderer details that used to bloat `plan.md`. Keep `plan.md` focused on active/future development decisions.

## Source Scope

- Native NOAA beta renderer supports `gfs`, `nam`, `nam3km`, and `hrrr`.
- Source products:
  - `gfs`: NOAA GFS `pgrb2.0p25`
  - `nam`: NOAA NAM `awphys`
  - `nam3km`: NOAA NAM CONUS nest `conusnest.hires`
  - `hrrr`: NOAA HRRR CONUS `wrfprs`
- Reference inventory set used for prior validation:
  - GFS: `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20260426/12/atmos/gfs.t12z.pgrb2.0p25.f003.idx`
  - NAM: `https://noaa-nam-pds.s3.amazonaws.com/nam.20260426/nam.t12z.awphys03.tm00.grib2.idx`
  - NAM 3km: `https://noaa-nam-pds.s3.amazonaws.com/nam.20260426/nam.t12z.conusnest.hiresf03.tm00.grib2.idx`
  - HRRR: `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20260426/conus/hrrr.t12z.wrfprsf03.grib2.idx`

### Exact source and tool provenance

- Run manifests contain one deduplicated wgrib2 tool identity: configured and resolved executable paths, normalized/trimmed combined stdout/stderr `-version` output, and binary SHA-256. Frame sidecars reference that identity by ID instead of repeating it; stderr-only version reporters are covered by regression.
- Schema-v2 frame provenance records every selected GRIB subset by source URL/IDX URL, ISO reference/valid time, forecast hour, exact byte ranges, raw inventory/reference-time/forecast-time text, parsed accumulation/average/maximum/minimum windows, selected-file SHA-256, and selected byte count.
- Temporal precipitation, snowfall/freezing-rain, and run-maximum derivations record their source hour, role, weight, statistical start/end window, and resolvable source/record references. Each source `referenceTime` must agree with the selected record's raw `d=YYYYMMDDHH` reference-time token, and a parsed record window must agree with the derivation term's start/end window; missing/mismatched reference tokens or parsed-window disagreement fail closed. Snowfall SLR predictors enumerate their actual surface/pressure-level records; each FRAM flat/radial output explicitly links both its liquid-composition terms and the temperature/moisture/wind profile records it consumes. A required-role or selected-output gap also fails closed instead of claiming exact lineage.
- Used-source sets are frame-local. Disk caches, shared promises, and run-local decoded/profile/derived-grid hits restore the exact producing source references. Target-bounded delta/cumulative/run-max snapshots cannot copy an already-registered future target into an earlier prefix, and unrelated earlier-frame sources are not serialized into the current frame.
- Tool hashing/version capture is performed once per build process (23.469 ms combined for the bundled 3.8.0 binary in the final local check). A 146-record current-frame synthetic benchmark measured 0.124 ms to build and 0.036 ms to stringify a 47,827-byte sidecar; adding 80 temporal sources measured 0.473 ms + 0.146 ms and 173,067 bytes. The marker stores one copy, and actual size scales with the records/temporal terms used by that frame.
- Renderer v47 completion identity is stable across extension of an exact canonical model/tier prefix, while a regular custom cadence receives a stable step identity and an irregular roster uses its exact SHA-256. It also binds the run's exact `wgrib2-sha256:…` tool reference, so replacing the executable invalidates old frame markers before the run-level tool catalog changes. This lets hourly-tier F000-F006 completion markers survive extension through F007 without allowing three-hourly/hourly, holed rosters, or different tool binaries to cross-reuse.
- Cadence-sensitive temporal caches hash the exact available source hours at or before the payload target. Current versions are `precip-accum-grid-v5-forecast-hour-roster`, `run-max-grid-v6-target-bounded-provenance`, `snow-liquid-grid-v7-forecast-hour-roster`, `snowfall-delta-grid-v6-target-bounded-provenance`, and `snowfall-cumulative-grid-v6-target-bounded-provenance`; profile inputs use `derived-profile-grid-v2-frame-local-provenance`. A first distinct-target SHA-256 identity measured 0.0116 ms and a memoized lookup 0.0000117 ms on the audit host.
- Snowfall delta/cumulative sidecars persist their frame-local snowfall-accumulation and profile-input snapshots. Warm hits restore them only after payload and exact contiguous binary-layout validation; cache-disabled builds do not share promises across sessions. Cold F006→F003 and new-session warm F003 regressions prove both delta and cumulative sidecars exclude the future target. The analogous run-max regression inspects the actual F003 sidecar and warm restore.

## Reflectivity

- Public layers:
  - `reflectivityComposite`: `REFC` composite reflectivity.
  - `reflectivity1km`: `REFD:1000 m above ground`.
  - `reflectivity1kmPrecipType`: 1 km reflectivity colored by model precip type.
- All four source products have `REFC` and `REFD:1000 m above ground`.
- Composite selector uses an `entire atmosphere` level pattern so it matches GFS/HRRR and NAM/NAM3km level strings.
- Legacy `reflectivity` remains a hidden composite alias in new manifests.
- Reflectivity gate variants are `10`, `15`, and `20` dBZ; default UI gate remains `15` dBZ.
- Reflectivity uses the provided stepped 2.5 dBZ palette from 7.5-72.5 dBZ.

## Precipitation Type

- Direct categorical model masks:
  - `CRAIN`: rain
  - `CSNOW`: snow
  - `CFRZR`: freezing rain
  - `CICEP`: ice pellets/sleet
- `CFRZR` is freezing-rain occurrence/type, not ice accumulation.
- Standalone public precip-type mask layers were intentionally removed from NOAA beta manifests.
- `reflectivity1kmPrecipType` combines direct `REFD:1000 m above ground` with `CRAIN/CSNOW/CFRZR/CICEP`; the renderer chooses the active precip type per pixel and colors the 1 km reflectivity value.
- Combined precip-type reflectivity is not affected by the app reflectivity gate selector. It uses palette thresholds: snow visible at `>=5 dBZ`; rain, freezing rain, and sleet/ice pellets visible at `>=10 dBZ`.
- Keep precip-type masks as internal inputs for combined reflectivity + type, snowfall masking, freezing-rain/ice derivations, and other winter products unless the user explicitly reverses the public-layer decision.

## Accumulated Precipitation

- Direct `APCP` is available on all four models.
- Public accumulation layers are implemented for all four models:
  - `precip`: rolling 1-hour precipitation
  - `precip3h`: rolling 3-hour precipitation
  - `precip6h`: rolling 6-hour precipitation
  - `precip12h`: rolling 12-hour precipitation
  - `precip24h`: rolling 24-hour precipitation
  - `precipTotal`: total precipitation from run start
- The 1-hour layer uses exact prior-hour `APCP` when present, otherwise it is derived from cumulative or interval differences; it is not a duration-averaged multi-hour field.
- All accumulation layers use the same `precipIn` color mapping as `1-h Precip`.
- Rolling windows accumulate from run start until enough forecast history exists, then become true rolling windows. Example: at `F012`, `precip24h` is the 0-12 hour total; at and after `F024`, it is rolling 24-hour precipitation.
- The renderer resolves each accumulation from available `APCP` records by trying direct exact interval, cumulative end minus cumulative start, then summed adjacent interval records.
- Accumulation source notes:
  - `gfs`: `0-3`, `0-12`, `0-1 day`, plus interval fields like `6-12` and `18-24`.
  - `nam`: `0-3`, `0-12`, `12-24`, and interval fields like `9-12` and `21-24`.
  - `nam3km`: interval fields such as `0-3`, `9-12`, `21-24`; longer windows are derived by summing intervals.
  - `hrrr`: `0-3`, `0-12`, `0-1 day`, plus hourly interval fields like `2-3`, `11-12`, `23-24`.

## Snowfall

- Implemented snowfall members:
  - `snow10to1`
  - reduced-profile `snowKuchera`
  - reduced-profile `snowCobb`
  - Pletcher `snowRfConus`
  - Veals `snowWesternLinear`
  - HRRR `snowHrrrAsnow`
- Direct source inputs available on all four models include `APCP`, `CSNOW`, `CICEP`, `CFRZR`, `CRAIN`, pressure-level `TMP/RH/HGT/UGRD/VGRD/VVEL`, surface/2 m thermodynamics, and surface height.
- `SPFH` is present on GFS/NAM3km/HRRR pressure levels and can be derived from `TMP/RH/P` on NAM where absent.
- HRRR uniquely has direct internal `ASNOW:surface` accumulated snowfall depth in `wrfprs`; keep it as a member/check, not the primary snowfall answer.
- NAM, NAM3km, and HRRR expose accumulated `WEASD` windows that can support snow-liquid accumulation. GFS checked `pgrb2.0p25` exposes instantaneous/state `WEASD` but not an accumulated `WEASD` window, so use `APCP` plus precip-type/snow-fraction logic for GFS.
- Snow-liquid APCP fallback masks are decoded with bilinear interpolation and fractional snow weighting while public precip-type display masks stay categorical.
- Snowfall layers do not activate for `F000` or non-accumulation records; SLR math is sparse over positive snow-liquid pixels. Finite zero/trace grids remain available to hover even when the PNG is transparent.
- Kuchera uses the surface-to-500 mb profile; Cobb uses instantaneous TMP/HGT/RH/VVEL every 25 mb from 925-300 mb; learned methods interpolate their published 300-2400 m AGL predictors. For RF/Western only, positive snow liquid `<=0.1/60 in` is reported as 0 without learned inference because even the 60:1 cap cannot reach the 0.1 in display threshold. This is an explicit compute/display tradeoff; other raw snow hover values remain unsmoothed.
- Optional RF/Western speed tradeoff: test a density-aware reduced profile for `snowRfConus` and `snowWesternLinear`, keeping tight lower-troposphere spacing where 300-2400 m AGL interpolation is most sensitive and thinning aloft, for example `1000,975,950,925,900,875,850,800,750,700,650,600,550,500,450,400,350,300`. Treat as an approximation needing numeric/visual A/B checks.

## Opt-in science prototypes

Research diagnostics are absent from the default 79-product catalog, parameter metadata, artifact plan, and renderer signature. They are enabled only by an explicit builder/action selection, for example:

```sh
node scripts/build-noaa-beta-artifacts.js --models=nam3km,hrrr --science-prototypes=camDcape21Level,effectiveStp100mbReduced,rowAwareCenterValidation
```

The normalized IDs are recorded in `renderSelection.sciencePrototypes`; enabled raster prototypes receive ordinary versioned parameter metadata, PNG/hover artifacts, current-record provenance, and a prototype-specific renderer signature. An empty or absent list preserves the default catalog and compute path.

- `camDcape21Level` adds `dcape21LevelCamPrototype` to HRRR/NAM 3 km only. It applies the current reduced DCAPE source/descent/numerical kernel to all 21 effective-profile HGT/TMP/RH rows. It reuses those decoded grids when effective diagnostics are present. It is a fuller sampled gridded profile, not the point path or an independent SHARPpy invocation. A reproducible nine-repetition, 50,000-call/rep run measured medians of 1.530 microseconds/cell for six levels and 2.425 for 21 (p95 1.569/2.620): approximately 2.399 and 3.802 CPU seconds for a 1600×980 frame. Because opt-in builds retain the default DCAPE raster and add a second prototype raster, the actual marginal compute is the full **+3.802 seconds/frame** (6.201 seconds combined); 1.403 seconds is only the hypothetical replacement delta. A separately isolated `point-dcape-v4` reference measured 235.308 microseconds/cell median (244.697 p95), or 368.963 CPU seconds/6.15 minutes when linearly applied to all 1,568,000 cells. If the profile is not already resident, 45 additional Float32 input grids are 269.17 MiB live; on CAM effective-diagnostic builds the intended incremental input cost is zero through shared decoded grids.
- `effectiveStp100mbReduced` adds `effectiveLayerStp100mbReducedPrototype`. It derives a pressure-weighted 100 mb mixed-layer source from the 21 loaded rows and evaluates CAPE/CIN/LCL with the reduced segment parcel kernel while sharing the existing effective-inflow/Bunkers/ESRH/EBWD scan. It explicitly selects 10 m wind as well as the complete profile, and it does not use native CAPE/CIN in the formula **or as a spatial prefilter**, because either use could create false negatives relative to the derived parcel; only finite surface prerequisites can skip a cell. It is not dense/SHARPpy-exact. The same nine-repetition benchmark measured candidate-mask medians of 0.0152 microseconds native and 0.0550 combined, and core medians of 11.222 native-only, 12.175 prototype-only, and 12.791 shared both. Applying mask cost to all 1,568,000 cells, then core cost to 696,000 audited native candidates plus 872,000 other prerequisite-valid cells, gives 7.834 seconds native-only and 19.606 seconds combined: **+11.771 seconds/frame**. Prototype-only is 19.177 seconds. The isolated dense reference measured 1.464/1.596 ms median/p95 for the 100-mb parcel alone (16.98 CPU minutes at 696,000 candidates), and 9.853/10.249 ms for the point-style dense effective-layer thermodynamic scan plus that parcel (1.90 CPU hours at 696,000 candidates, before wind/render work). Decoded input/storage cost is unchanged when the existing effective-profile rows are shared. The native 90-mb effective STP remains the default because broad-column validation has not yet established that reduced-profile 100-mb integration improves total error.
- `rowAwareCenterValidation` adds a diagnostic-only object to each retained H/L marker. It recomputes the 200 km locality, a physically estimated 60% finite-data coverage quorum, and 300–500 km annular prominence at the pre-refinement candidate, then measures 450/300 km separation on the final refined/deduplicated emitted roster. All distances use latitude-aware great-circle calculations on the bounded center grid. It reports pass/disagreement, finite sample counts, edge truncation, and method version but never rejects, reprioritizes, or moves a marker. On a warmed 119×73 synthetic field retaining 12 centers, 12 warm-up pairs followed by 80 measured pairs with alternating call order produced baseline median/p95 3.507/4.185 ms and diagnostic 6.487/7.764 ms. The diagnostic-minus-baseline differences of those marginal median/p95 totals were +2.980/+3.579 ms, with a 1.850× median ratio; the harness also emits the within-repetition paired-delta distribution. A serialized sample diagnostic was 429 bytes before the coverage and roster-distance fields; at the 24-marker cap the addition remains on the order of tens of KiB per vector plus the manifest copy.

Each enabled raster parameter adds one 1600×980 Int16 hover plane (3,136,000 raw bytes / 2.99 MiB before container compression) and one field-dependent PNG per frame. Those output costs do not exist in default builds.

Reproduce the isolated timings with `node scripts/benchmark-science-prototypes.js`; use `node scripts/benchmark-science-prototypes.js --section=dense` to run only the longer point-method references without warming the process on the prototypes first. The script emits every sorted sample, warm-up/iteration count, median, p95, column result, and extrapolation input/formula. Dense STP's single-parcel timing is a minimum component; its combined timing includes the point-style effective-layer source scan plus the 100-mb parcel but excludes winds, Bunkers/ESRH/EBWD, final arithmetic, I/O, and rendering. These synthetic-column CPU-work extrapolations are not end-to-end wall-time or forecast-skill claims. The final gate rerun produced 3.660 s additive modeled DCAPE, +11.866 s modeled STP, and +2.974 ms measured row-aware-center cost versus the pinned 3.802 s, +11.771 s, and +2.980 ms values above. Multiple runs are retained because JIT/thermal state varies; the exact evidence is the emitted samples, workload counts, and formula, not a hardware-independent time.

## Synoptic Overlays

- Simple MSLP isobars use 4 hPa minor and 8 hPa major intervals. Detailed mode uses 2 hPa minor and 8 hPa major intervals.
- Detail mode changes contour density only. Simple and detailed vectors reuse the same synoptic-scale H/L roster, including an explicitly empty roster when no center qualifies.
- H/L markers are automated model-guidance centers, not a human analyzed surface chart. Candidates must be local extrema with at least 1.8 hPa prominence over a 300-500 km annulus; same-kind systems are separated at 450 km and the generated roster is capped at 12 highs and 12 lows.
- The missing-style fallback for center prominence is also 1.8 hPa; metadata and detection no longer have divergent 1.8/2.4 hPa defaults.
- Pressure-center detection uses model-dependent presentation smoothing, but the emitted center position and pressure are refined against the full-resolution unsmoothed MSLP field. Every emitted prominence is finite; a domain-wide min/max alone does not create a marker.
- Near-boundary systems can qualify through the finite-sample quorum path, but literal-edge extrema and flat or monotonic fields do not fabricate centers.
- 1000-500 mb thickness uses 6 dam minor and 12 dam major intervals. The emphasized 540 dam contour is a synoptic thermal reference, not a deterministic or universal rain/snow boundary.

### MapLibre GeoJSON source lifecycle

- Synoptic isobar/thickness lines and labels share one filtered source instead of 16; H/L centers share one instead of 2; each active height-contour parameter uses one instead of 5. A common synoptic-plus-one-height stack is therefore exactly 23 sources before versus 3 after.
- The shared-source registry calls `setData` once per new collection identity, reference-counts members, removes the source only after its final layer leaves, and re-adds each family once after style recreation. Layer filters preserve class-specific styling and feature-count introspection.
- `node scripts/benchmark-map-geojson.js` reproduces the checked-in-fixture proxy: duplicated serialized geometry falls from 168,736 to 63,039 bytes/update (62.640 percent). The final run measured 0.399808 ms less median JSON serialization across the common stack. This is a duplicate-geometry proxy, not MapLibre structured-clone, worker-index, or browser frame time.

## Forecast-hour policies

- The configured NAM build tier is explicitly F000-F036 hourly. It no longer reaches that boundary by probing nonexistent F037/F038 files and treating the cadence gap as an incomplete run.
- `--require-full-horizon` opts into the official NAM F000-F036 hourly plus F039-F084 every-three-hours schedule: 53 instead of 37 frames (+16, about 43% more frame work).
- GFS keeps the configured 129-frame three-hourly F000-F384 default. `--gfs-hourly-through-120` opts into the published mixed cadence: F000-F120 hourly and F123-F384 every three hours, 209 frames total (+80, about +62%). On the audited cold fixture, the added tier is estimated at 17.05 worker-minutes, 9.53 GiB of artifacts, and 3.86 GiB of selected source cache per run.
- GFS run chips label the 129-frame three-hourly default separately from the 209-frame hourly-through-F120 source tier; legacy frame-count fields remain source-cadence aliases for compatibility.
- An all-concrete date/cycle selection uses the UI's **Published prefix** choice and is availability-capped, so a still-uploading run builds its contiguous published prefix instead of failing on future files. An all-latest unbounded official-horizon selection says **Full horizon** and requires a completed run; capped/default latest selection may use a contiguous published prefix. A combined concrete/latest selection says **Mixed: prefix + full**.
- Action progress parses the builder's exact resolved per-model hour plan before frames start, adopts a realized availability-capped prefix, and aggregates every model's final counts. The visible denominator therefore does not report 1/1 throughout an unbounded latest build or retain a requested horizon the selected run has not published.
- Manifests carry `forecastHourPolicy`, and the frame control displays the actual first/last forecast hour so an analyst can distinguish the configured tier from the official source horizon.

## Upper-Air Height Contours

- Public upper-air height products are model-guidance chart-style contours instead of scalar color-fill rasters; they are not observational upper-air analyses.
- Supported contour levels are `850`, `700`, `500`, `300`, and `250` mb.
- Minor intervals are `3 dam` at 850/700 mb, `6 dam` at 500 mb, and `12 dam` at 300/250 mb; major contours use twice the respective interval.
- Hover/readout uses the unsmoothed decoded `HGT` field converted to decameters; contour generation smooths only geometry input.
- Height contour smoothing mirrors the simple isobar path: resample to the simple contour grid, then apply synoptic-style `mslpSigmaKmByModel` Gaussian smoothing in grid-cell space before marching squares.
- Height contours write transparent fallback PNG line layers and per-layer contour-vector JSON sidecars.
- Synoptic and height-contour vector sidecars store contour coordinates as compact `polyline5`-encoded `encodedPoints`; readers decode compact and older raw `points` payloads.
- Synoptic isobars/thickness and upper-air height contours use a multi-level marching-squares pass with a bilinear asymptotic decider for ambiguous saddle cases 5 and 10.
- Method metadata is versioned as `hgt-pressure-contour-model-smoothed-v2` and states both the model-dependent presentation smoothing and unsmoothed hover behavior.
- MapLibre renders synoptic and height contours as native GeoJSON line/symbol layers. Height contours use theme-aware warm upper-air ink: graphite/sepia on the light basemap and warm silver/champagne on the dark basemap, with explicit minor/major legend samples.
- `300 mb Height` and `300 mb Wind` are implemented; `wind300` uses `UGRD/VGRD:300 mb`, knots, and the same palette/ticks/threshold as `wind250`. `temp300` and `rh300` remain intentionally absent.

## Palette And Rendering Behavior

- Precipitation and reflectivity are true stepped lookups.
- Reflectivity + precip type keeps the opacity-aware RGBA ramp from the source legend extraction; below-filter bins remain transparent.
- Palette hard-break pass added duplicate-value stops for important category breaks without making every continuous palette stepped: surface temp 32F; 850/700 mb temp 0C; 500 mb temp -20C; dew point 50/60/70/80F; visibility 1/3/6/10 mi; snowfall/snow-depth 1, 6, 12, 24, and 36 inches.
