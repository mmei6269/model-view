# Point Sounding Accuracy Audit - 2026-06-11

Scope: full meteorological/scientific audit of the point-sounding feature (Skew-T payload,
parcel physics, kinematics, composites, and chart geometry), benchmarked value-by-value
against SHARPpy as displayed by a third-party SHARPpy reference for the same model run, hour, and grid point
(NAM 3km CONUS 2026-06-11 00z, F003, valid 03z, 40.43N 90.13W).

## Method

- Rebuilt the live payload with `buildNoaaPointSounding` against the cached 20260611-0000Z
  NAM 3km run at the exact reference coordinates and compared every displayed index against
  the SHARPpy reference image.
- Verified SHARPpy algorithm details against `sharppy/sharptab/params.py` (dcape, ship,
  lapse_rate, bunkers_storm_motion, mean_thetae) rather than secondhand descriptions.

## Real errors found and fixed

1. **Critical-temperature heights snapped to the level below the crossing**
   (`interpolateHeightForTemperature`, `interpolateHeightForWetBulbZero` in
   `point-sounding.js`). The interpolation fraction divided by
   `Math.max(1e-9, upperTemp - lowerTemp)`; temperature normally decreases with height, so
   the negative denominator was replaced by 1e-9 and the clamped fraction collapsed to 0.
   Every 0/-10/-20/-30C and fallback WBZ height was reported ~300 m (~1000 ft) low.
   After the fix: 0C 15,468 ft vs SHARPpy 15,360; -20C 25,719 vs 25,658; -30C 30,579 vs
   30,514 (residuals are interpolation-grid differences).

2. **Bunkers storm motion used 500 m layer-mean winds at the shear endpoints**
   (`calculateBunkersMotionFromRows` in `profile-wind.js`). SHARPpy/SHARPlib `wind_shear`
   uses point winds at the layer bottom/top. With a nocturnal low-level jet inside the
   bottom 0-500 m mean layer, the shear vector rotated and the right-mover collapsed:
   RM 259/29 kt vs SHARPpy 260/42. Fixed to point-wind shear (fixed and effective variants).
   After the fix: RM 261/42, LM 219/41 (SHARPpy 260/42, 219/41), SRH 0-1 km 412 vs 410,
   SRH 0-3 km 449 vs 448, ESRH 450 vs 449, SRW 4-6 km 7 kt vs ~5.

3. **DCAPE understated ~40% versus SHARPpy** (`calculatePointDcapeJkg`,
   `calculateReducedProfileDcapeFromSources`). The v3 source selection used the minimum
   _point_ theta-e level with a +/-50 mb mean parcel; SHARPpy/NSHARP scores each candidate
   level by the mean theta-e of the 100 mb layer _above_ it and starts the parcel at the
   layer midpoint (candidate minus 50 mb), which reaches colder/drier air (550 mb vs 625 mb
   on the benchmark profile). Replaced with SHARPpy parity (`point-dcape-v4` /
   `reduced-profile-dcape-v4`): point path uses 1 hPa layer-mean steps and the exact Wobus
   pseudoadiabat; gridded path uses knot-trapezoid layer means and the Euler moist descent.
   After the fix: 1138 J/kg vs SHARPpy 1120 (was 675); downrush temp 63F vs 63F. Gridded
   and point paths agree within 0.1% on the regression fixture.

## Additions

- **3CAPE**: profile-derived mixed-layer-parcel CAPE below 3 km AGL (SHARPpy `b3km`,
  straddling segment clipped at 3 km), with the direct model 0-3 km CAPE field as fallback.
  187 J/kg vs SHARPpy 193 on the benchmark (NAM 3km has no direct field; this row was
  previously blank).
- **SHIP**: SHARPpy `params.ship` parity (MU parcel mixing ratio clipped 11-13.6 g/kg,
  virtual 700-500 lapse rate, 500 mb temp capped at -5.5 C, sfc-6 km shear clipped
  7-27 m/s, /42e6, low-CAPE/lapse/freezing-level reductions). 1.8 vs SHARPpy 1.8.
- Denser parcel trace (20 hPa steps plus the exact LCL pressure) so the dry-adiabat to
  pseudoadiabat kink renders correctly.

## Verified correct (no change)

- Wobus moist adiabat, Bolton theta-e/LCL, Normand pressure-aware wet-bulb, virtual
  temperature corrections in CAPE/CIN/LI.
- Corfidi vectors exact match (306/24 up, 269/58 down vs SHARPpy 306/24, 269/58).
- Effective inflow layer: top 2355 m exactly matches SHARPpy's 2355 m bracket.
- Bulk shear ladder identical (39/40/49/38 kt for 1/3/6/8 km vs SHARPpy 39/40/49/38).
- K 36.8 vs 37, TT 51 vs 51, PW 49.0 mm vs 1.92 in, lapse-rate table (virtual, the
  SHARPpy convention): 5.7/6.7/6.7/7.0 vs 5.8/6.7/6.7/6.9.
- Parcel table within input noise: ML 3379/-18 vs 3267/-22, MU 3986/-7 vs 3852/-7;
  SBCAPE (2019 vs 2263) is within surface-parcel sensitivity to the 25 mb resampled
  profile SHARPpy uses across a sharp nocturnal inversion.
- Composites: SCP eff 35.9 vs 34.6, STP eff 8.4 vs 7.9, STP fixed 4.6 vs 5.2 (remaining
  deltas fully explained by the SRH/SBCAPE input differences above).
- Wind barb NH convention, hodograph geometry, SRH cross-product integral, EHI /160000,
  fixed STP/SCP term caps and gates.

## UI changes (SoundingDrawer)

- Isotherms tilted 30 degrees from vertical (bottom axis -40..50 C). The original chart
  was ~19.5 degrees (profile crammed left); a full 45-degree pass overshot, pushing the
  upper-level temperature curve into the right edge. 30 degrees keeps the whole curve in
  the readable middle of the chart on deep convective profiles, which is what an analyst
  needs (and matches SHARPpy's apparent tilt).
- Added Wobus pseudoadiabat (moist adiabat) grid lines, denser dry adiabats, dashed
  mixing-ratio lines capped at 600 mb with end labels, cold-isotherm edge labels,
  -20C dashed isotherm highlight.
- LCL/LFC/EL as SHARPpy-style right-side ticks with label collision dodging; 0/-20/-30C
  crossing heights as right-edge labels (feet) with a dot on the temperature curve at the
  crossing; surface T/Td readouts at the curve feet; EFF bracket label placed above the
  bracket clear of the wind-barb column.
- Wind barbs thinned to a 13 px minimum spacing; km height marks converted to left ticks.
- Composite table gains SHIP and 3CAPE; parcel table 0-3 row now populated (3CAPE).
- Data panel documents the new conventions.
- Hodograph reworked for analyst use: the view auto-fits the 0-12 km trace plus storm-motion
  markers (speed rings stay origin-centered and clip to the panel) instead of reserving an
  empty origin-centered disk; the trace is clipped at 12 km AGL with an interpolated end
  point so weak, erratic stratospheric winds no longer scribble through the middle; dashed
  storm-relative wind vectors run from the right-mover to the effective inflow base/top
  winds; the critical angle (Esterheld & Giuliano 2008, SHARPpy vector convention - RM minus
  surface wind against the 0-500 m shear; 55 deg vs the reference's 54) prints when the
  effective inflow layer is surface based; SFC square marker, height dots at
  1/2/3/6/9/12 km, segment color legend (0-1/1-3/3-6/6-9/9-12 km) in the header, and an
  adaptive 10/20 kt ring step with a rings-step caption.

## Validation

- `node --test tests-node/noaa-beta.test.js`: 112 pass (Bunkers and DCAPE tests updated to
  encode the new conventions; DCAPE gridded/point consistency held at <0.1%).
- `npm run typecheck`, `npm run lint -- --quiet`, `npm run build`, `npm run smoke:react`
  (33 pass), touched-file Prettier: all clean.
- Visual verification: drawer screenshots at the benchmark point inspected against the
  SHARPpy reference (skew geometry, curves, markers, hodograph, all tables).
