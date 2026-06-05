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
- Snowfall layers do not activate for `F000` or non-accumulation records; SLR math is sparse over positive snow-liquid pixels; zero snowfall grids are left for the artifact normalizer to fill as transparent PNGs.
- Current deterministic snowfall path uses existing 850/700/500 mb upper-air temperature/height/RH fields plus only 850/700/500 mb `VVEL` for Cobb.
- Optional RF/Western speed tradeoff: test a density-aware reduced profile for `snowRfConus` and `snowWesternLinear`, keeping tight lower-troposphere spacing where 300-2400 m AGL interpolation is most sensitive and thinning aloft, for example `1000,975,950,925,900,875,850,800,750,700,650,600,550,500,450,400,350,300`. Treat as an approximation needing numeric/visual A/B checks.

## Upper-Air Height Contours

- Public upper-air height products are analysis-style contour products instead of scalar color-fill rasters.
- Supported contour levels are `850`, `700`, `500`, `300`, and `250` mb.
- Intervals are `3 dam` at 850/700 mb, `6 dam` at 500 mb, and `12 dam` at 300/250 mb.
- Hover/readout uses the unsmoothed decoded `HGT` field converted to decameters; contour generation smooths only geometry input.
- Height contour smoothing mirrors the simple isobar path: resample to the simple contour grid, then apply synoptic-style `mslpSigmaKmByModel` Gaussian smoothing in grid-cell space before marching squares.
- Height contours write transparent fallback PNG line layers and per-layer contour-vector JSON sidecars.
- Synoptic and height-contour vector sidecars store contour coordinates as compact `polyline5`-encoded `encodedPoints`; readers decode compact and older raw `points` payloads.
- Synoptic isobars/thickness and upper-air height contours use a multi-level marching-squares pass.
- React renders synoptic and height contour polylines through reusable per-pane Leaflet canvas renderers. Labels remain DOM `divIcon`s.
- `300 mb Height` and `300 mb Wind` are implemented; `wind300` uses `UGRD/VGRD:300 mb`, knots, and the same palette/ticks/threshold as `wind250`. `temp300` and `rh300` remain intentionally absent.

## Palette And Rendering Behavior

- Precipitation and reflectivity are true stepped lookups.
- Reflectivity + precip type keeps the opacity-aware RGBA ramp from the generated public palette; below-filter bins remain transparent.
- Palette hard-break pass added duplicate-value stops for important category breaks without making every continuous palette stepped: surface temp 32F; 850/700 mb temp 0C; 500 mb temp -20C; dew point 50/60/70/80F; visibility 1/3/6/10 mi; snowfall/snow-depth 1, 6, 12, 24, and 36 inches.
