# Basemap & pan-bounds expansion plan (deferred: awaiting high-speed network)

Status: **documented, not executed** — the re-extract is a ~16–22 GB download and the
current network is limited. When bandwidth is back, this is a one-command download plus
a small, fully-specified code change. Written 2026-07-09.

## Why the map feels cramped (diagnosis)

The complaint: _"you can't drag the map to have California centered when zoomed out;
CONUS doesn't fit comfortably in frame."_ Two stacked causes, both in how the per-view
max-pan bounds are wired:

1. **Pan bounds == data-view bounds.** `use-panel-map.ts:224` applies
   `VIEW_CONFIG[viewKey].bounds` as the engine `maxBounds`. For the CONUS view that is
   the CONUS bbox itself (`constants.ts:20`, `{north: 53, south: 21, west: -129,
east: -63}`), so the camera can never leave CONUS — the same rectangle serves as
   _default framing_ and _pan cage_.
2. **MapLibre force-zooms when maxBounds is narrower than the viewport.** Verified in
   maplibre-gl 5.24.0 (`defaultConstrain`, dist/maplibre-gl-dev.js:56108): if the
   bounds' pixel width at the requested zoom is smaller than the screen, the constrain
   _raises the zoom_ until the bounds fill the screen. CONUS is 66° wide = 751 px at
   native z3; on a ~1500 px fullscreen panel the effective floor becomes ~z4.0 — and at
   that forced zoom the viewport exactly equals the cage, so horizontal pan freedom is
   **zero**. That is the "can't drag" feel.

Corrected corollary (Stage B implementation, 2026-07-10): `maxBounds` **must NOT
cross the antimeridian in this app**. The constrain source does wrap
antimeridian-crossing ranges (`minX/maxX += worldSize`) — but the companion
wrap of the CAMERA longitude into that range is gated on `renderWorldCopies`,
which this app sets to `false` (maplibre-engine.ts). With copies off, a west
bound of -195° makes every mid-CONUS longitude read as out-of-range and clamp
to the wrapped west edge (~+179°) — live-caught by the `?c=` restore spec.
Stage B therefore pins west at -179.99 (just inside the antimeridian).

## Fix shape: decouple PAN bounds from FIT bounds

`view.bounds` keeps its role as the **fit target** (default framing on view switch,
`use-panel-map.ts:234`). A new, wider **pan bounds** feeds `setMaxBounds`. Two stages:

### Stage A — code-only, no download (can ship any time)

Pan bounds for **both** views = the current PMTiles extract bbox, which already covers
North America:

```ts
// constants.ts — the extract's coverage (prepare-basemap.js NA_BBOX)
export const PAN_BOUNDS: GeoBounds = { south: 7, west: -170, north: 74, east: -45 };
```

- `use-panel-map.ts:224` → `engine.setMaxBounds(PAN_BOUNDS)` (drop the per-view cage;
  keep `engine.setMinZoom(view.zoom)` as-is).
- Everything stays inside tile coverage — no visual downside, no download.
- Result: CONUS view pans across all of NA; the forced-zoom floor at fullscreen drops
  from ~z4.0 to ~z3.1; California is centerable at z3 in multi-panel layouts (panel
  ≲ 1400 px). The one case still short: single fullscreen panel at exactly z3 can
  reach center-lon ≈ -104° only (viewport half-width ~66° vs west cage -170).

### Stage B — the download (when network allows)

Re-extract with a wider bbox and widen the pan bounds past the extract edges:

```sh
# prepare-basemap.js: NA_BBOX = "-180,3,-11,84"   (today: "-170,7,-45,74")
npm run basemap:fetch    # re-downloads output/basemap/na.pmtiles (est. 18–22 GB)
```

Bbox rationale:

- **west -180**: `pmtiles extract` bboxes cannot cross the antimeridian — hard floor.
  (Far Aleutians past -180 stay untiled; they already are today.)
- **south 3**: all of mainland NA + Panama with margin; the land cut runs through
  northern Colombia at the frame edge instead of through Panama.
- **east -11**: all of Greenland (easternmost cape ≈ -11.3°) and Iceland (≥ -24.5°),
  while excluding Ireland/UK (Ireland starts at -10.6°) — pure ocean elsewhere, cheap.
- **north 84**: full Canadian Arctic Archipelago (Cape Columbia 83.1°N) + north
  Greenland (83.6°N).
- Additions are dominated by ocean/arctic tiles (near-empty) + Greenland/Iceland +
  a northern South-America fringe → estimate **+2–6 GB** over today's 15.78 GB.

Code changes alongside the new extract:

```ts
// constants.ts (as shipped — see the corrected corollary above)
export const PAN_BOUNDS: GeoBounds = { south: 3, west: -179.99, north: 84, east: -8 };
```

- **west -179.99** (antimeridian floor): the original -195 target would have let
  California center exactly at the z3 floor on a ~1600 px panel, but crossing the
  antimeridian is unusable with `renderWorldCopies: false` (corollary above).
  Shipped behavior: the whole 169°-wide extract pans freely at z3 (no force-zoom);
  California sits ≈6° off-center at the exact floor and centers from z≈3.2 up.
- The strip east of -11 has no tiles. Mitigation: recolor the style
  **background** knob to the water tone so untiled void reads as open ocean —
  `basemap-style.ts`: light flavor `background: LIGHT_WATER` (today `LIGHT_EARTH`,
  line 73); dark style gets a post-generation background recolor to
  `DARK_WATER_FILL_COLOR` (same pattern as `recolorDarkWater`, line 278). Over-pan
  west shows Bering Sea "ocean" (Chukotka land missing at the extreme edge —
  accepted); east shows Atlantic.
- `prepare-basemap.js`: update `NA_BBOX` (line 28), the header size prose (lines
  5–12), and consider raising the truncation sanity floor (line 179, `>2 GB`) to
  `>10 GB`. `FIXTURE_BBOX` (line 31) is unchanged and still cuts from the new file
  (superset), so CI fixtures and `offline-boot.spec.js` are untouched.

### Both stages: shared touch points

- `next/src/types.ts` `ViewDefinition` — no change needed if `PAN_BOUNDS` is a single
  shared constant (recommended; per-view pan cages are the bug, not a feature).
- Guard: keep total lng span < 360° (the `FULL_WORLD_LNG_EPSILON` singular-matrix
  guard in maplibre-engine.ts:70 protects this; -179.99..-8 spans ~172° — fine).
- Sessions/permalinks: stored centers are all inside the new bounds (superset) — no
  migration, no `zs` bump.
- Weather rasters are untouched — panning past the raster edge shows basemap only,
  exactly as the NA view behaves today.

### Verification checklist (run at Stage A and again at Stage B)

1. `tests-react/viewport-sync.spec.js` — comments/assertions encode "maxBounds = the
   view bounds" (line 28); update to PAN_BOUNDS and re-run.
2. Live drive: CONUS view, single fullscreen panel, zoom fully out → drag until
   California is centered; confirm no force-zoom above the view minZoom and no
   visible void (Stage A) / ocean-colored void only (Stage B).
3. View switch CONUS↔NA still fits to each view's `bounds` (fit target unchanged).
4. Permalink round-trip with a center outside old CONUS bbox (e.g. Yukon) restores.
5. Stage B only: `npm run basemap:fetch` completes, size sanity check passes, spot
   Greenland/Iceland/arctic render at z4–z8, offline boot still green.
