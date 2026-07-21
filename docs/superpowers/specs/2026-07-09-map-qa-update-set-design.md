# Map QA update set — design (2026-07-09)

Owner-approved scope (post-MapLibre-migration QA round; decisions gathered
2026-07-09). Branch: `map-qa-update-set`. Stage B basemap re-extract stays
deferred on bandwidth (`docs/basemap-expansion-plan.md`); everything below is
implementable offline against the existing 15.78 GB NA extract.

## 1. Detailed isobars at 2 hPa (owner: "2 minor / 8 major")

Today both synoptic detail modes share `mslp.minorIntervalHpa 4 /
majorIntervalHpa 8` from `shared/synoptic-style-v1.json`. Change **detailed
mode only** to minor 2 / major 8 (thin line every 2 hPa, bold every 8 —
high-density with major emphasis).

- **No shape change to the shared style JSON** (public-mirrored, shape-frozen
  per `next/src/config/synopticStyle.ts` DOMAIN NOTE). The detailed render
  pass in `scripts/lib/noaa-beta-renderer.js` passes a derived style object
  (`{...style, mslp: {...style.mslp, minorIntervalHpa: 2}}`) into
  `renderSynopticArtifacts`.
- Simple-mode artifacts must stay **byte-identical** (existing invariant).
- Detailed vector bytes change → the synoptic style version stamped into
  detailed vectors must distinguish new artifacts from cached ones; verify how
  `styleVersion` flows and stamp a detailed-interval marker if needed
  (rebuild via the render control panel / local actions endpoints).
- Client: `synoptic-geojson.ts` reads `mslp.majorIntervalHpa` for
  classification only; verify 2 hPa minors classify/label correctly (labels
  come per-line from the payload; MapLibre collision gates density).

## 2. Exclusive border modes (owner decision)

`BoundaryDisplayMode` semantics become exclusive:

| mode | app reference overlay (NE-10m) | basemap OSM boundary lines |
|---|---|---|
| `auto` | country always; state < z7 | **hidden** |
| `reference` | country + state | **hidden** |
| `basemap` | none | shown |
| `off` | none | **hidden** |

- New helper `basemapBoundaryLayerIds(style)` in `basemap-style.ts` matching
  `/^boundaries(_country)?$/` (fail-loud like the other id helpers).
- New engine surface: `setBasemapBoundaries({visible, widthScale, color})`
  stored on the instance and re-asserted in `applyLoadedStyle()` (survives
  theme switches + context-loss recreates), mirroring
  `applyBasemapLayerVisibility`.
- Policy stays in `use-map-display-layers.ts` (mode → engine verb).

## 3. Basemap border thickness + color (owner: "slider + color")

- One width **multiplier** slider (0.5×–3×, step 0.1, default 1×) scaling the
  generated widths proportionally (country 0.7 px, state 0.4 px base).
- Color picker for basemap boundary `line-color` (defaults: current
  `#a3aab2` light / `#5b6374` dark; reuse `DISPLAY_BOUNDARY_COLORS` swatches
  + keep per-theme default when unset).
- Settings: `boundaries.basemapWidthScale: number`,
  `boundaries.basemapColor: string | "auto"` in `display.ts`; presets updated;
  `normalizeDisplaySettings` clamps; `DISPLAY_SCHEMA_VERSION` 4 → 5 (absent
  fields fall back to preset defaults — no payload migration needed beyond
  the stamp).
- UI: Borders block of `DisplayMenu.tsx`; slider + swatches enabled when mode
  shows basemap lines (`basemap` mode; disabled in auto/reference/off since
  those hide basemap lines under the new semantics).

## 4. Stage A pan bounds (code-only; Stage B deferred)

- `constants.ts`: `export const PAN_BOUNDS: GeoBounds = {south: 7, west:
  -170, north: 74, east: -45}` (== current extract coverage). `view.bounds`
  keeps its fit-target role.
- `use-panel-map.ts:224` → `engine.setMaxBounds(PAN_BOUNDS)`; per-view
  `setMinZoom(view.zoom)` unchanged.
- Update `tests-react/viewport-sync.spec.js` (comment at :28 and any
  assertions encoding the old cage).

## 5. Hygiene (P1/P2/P3 from PR #16 checklist)

- P1a `maplibre-engine.ts:1031-1037`: at the recreate cap, `map.remove()` +
  clear the instance ref before emitting the fatal (free the dead GL
  context).
- P1b `types.ts:57`: `SymbolLayerStyle.opacity: number` (ban ZoomCurve
  structurally); fix any compile fallout (`symbolOpacityValue`).
- P2c `maplibre-engine.ts:1563`: stale-image error → `console.warn`.
- P2d `tests-node/basemap-style.test.js:88-96`: correct "~57 KB" → actual
  ~208 KB/theme figure, re-affirm the pin decision in the comment.
- P3e `url-state.ts:67-83`: comment documenting unknown-`zs` legacy parsing +
  bump procedure.
- P3f `prepare-basemap.js:177-182`: size-guard message names interrupted
  download as likely cause + delete-before-retry.
- Bonus (audit finding 5/6, cheap): align code fallback styleVersion string
  with JSON, note-only; leave dead legacy JSON blocks in place (public-mirror
  shape freeze) but document them as client-dead in a comment where read.

## 6. Meteorological soundness fixes (audit findings 1–4)

- **6a Physical-units center detection**: express the H/L detection disc and
  prominence annulus in **km** (converted per grid via
  `estimateGridSpacingKm`, with sane cell clamps) instead of fixed cell
  counts, so simple (250 km cells) and detailed (16 km cells) modes gate
  centers on comparable physical scales. Prominence stays 1.8 hPa; target
  ring ~300–500 km (synoptic-low scale) for both modes. Same-kind min
  distance + opposing-overlap radii likewise km-based.
- **6b Height contours on the detailed grid**: render height contours from
  the detailed-cap grid (≤360×224, as MSLP-detailed does) instead of 25×15.
  Keep the artifact keys/manifest shape unchanged (still one height vector
  per level); this is a quality bump, not a schema change.
- **6c Simple-mode smoothing**: the σ floor (0.6 cells) makes per-model σ
  policy inert on the 25×15 grid (downsampling already smooths harder than
  σ), yet the floor-clamped Gaussian still ran — silent extra smoothing the
  style never asked for. Skip the kernel when the raw σ_cells is sub-floor.
  Note: skipping slightly SHARPENS simple-mode fields (contour geometry and
  detection input change) — an intentional visual change, not a no-op.
- **6d Model-honest refinement precision**: cap the center hill-climb travel
  and snap radius by the **model's native grid spacing** (GFS ~27 km, NAM
  ~12, 3 km nests ~3) so GFS centers aren't reported at ~4 km false
  precision. Keep NAM3km behavior unchanged (the machinery was tuned for
  it).
- Verification: node renderer tests updated where goldens change
  (simple-mode MSLP/thickness bytes must NOT change except where 6a/6c
  intentionally alter centers — document each intentional diff); SHARPpy/
  center-accuracy style spot checks vs `docs/synoptic-center-refinement.md`
  tables where applicable.

## Non-goals

Stage B re-extract (bandwidth), any shared-JSON shape change, upper-air
detailed variants beyond 6b, reflectivity/temp layers, public-mirror sync
(happens on its own cadence via the playbook).

## Acceptance

- All node + Playwright suites green; simple-mode synoptic artifacts
  byte-identical except intentional 6a/6c/6d center diffs (each explained).
- Live drive: 2 hPa detailed isobars render high-density with 8 hPa bolds;
  border modes exclusive with working width/color controls; NA-wide panning at min
  zoom without force-zoom cramping; no console noise regression.
- A weather analyst reading the synoptic output would sign off: intervals
  anchored on 1000 hPa / 540 dam, physically-consistent center gating,
  height contours that resolve real troughs.
