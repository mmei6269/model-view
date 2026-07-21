# MapLibre GL Map Architecture — Design

**Date:** 2026-07-07 · **Status:** Approved design (owner-reviewed)
**Branch:** `maplibre-map-engine` (off `master` @ 53ef133)
**Companion:** research doc `2026-07-08-maplibre-map-rewrite-research.md` (current-state inventory, API cheat sheet, verified library/data facts). This spec records the *decisions* and the buildable design; the research doc remains the reference for mechanics.

## Owner decisions (resolved 2026-07-07)

| # | Question (research §7) | Decision |
|---|---|---|
| 1–2 | Extract coverage / zoom / disk | **NA bbox @ z14** (~8–12 GB); **raise UI zoom clamp** (native z13, tiles crisp to z14) |
| 3 | Counties source | **Upgrade to Census `cb_*_us_county_5m`** via `prepare-map-geodata.js` |
| 4 | Online fallback | **Fully local-only** — delete all CDN fallback machinery |
| 5 | Roads / place labels | **Basemap owns both** — delete app-drawn NE roads + place-label layers, restyle basemap layers |
| 6 | Synoptic endgame | **Full native GL conversion** — and explicitly a *redesign*, not a parity port (see §5) |
| 7 | Topographic option | **Drop OpenTopoMap** |
| 8 | Library timing | **maplibre-gl 5.24.0 now**; v6 later as a contained bump |
| — | Definition of done | **Delete Leaflet in this branch** (deps, engine, CSS); no rollback engine kept |
| — | Strategy | **Strangler via `MapEngine`** — Leaflet wrapped first, MapLibre built alongside, Leaflet removed at cutover |

## 1. End state

- `leaflet` / `@types/leaflet` removed from `package.json`; `maplibre-gl` + `pmtiles` + `@protomaps/basemaps` added.
- All map access goes through a **`MapEngine` interface** (`next/src/core/map-engine/`), one implementation (MapLibre). The interface outlives the migration as the containment boundary for the future v6 bump — no `maplibregl.*` outside the engine module.
- **Basemap:** self-hosted Protomaps **PMTiles NA extract** (bbox −170,7,−45,74 @ z14), served by `scripts/lib/local-artifact-server.js` via a new **HTTP Range route**; `pmtiles` protocol registered once at app root (shared directory/header caches across panels). Glyphs + sprites vendored from `protomaps/basemaps-assets` into the artifact server's static tree. **The app boots and renders fully offline.**
- **Style:** generated in code from `@protomaps/basemaps` `layers("protomaps", namedFlavor("dark"), {lang:"en"})`, then filtered/tuned: POIs, buildings, minor landuse, housenumber labels stripped; near-black navy water; thin desaturated roads; admin-0/1 boundaries; place labels with strong dark halos. Weather raster layers insert **below the first basemap symbol layer** — labels and boundaries render above weather natively (replacing the CARTO `dark_only_labels` sandwich).
- **App-drawn layers that remain:** graticule, counties, reference country/state boundaries, all weather/synoptic/contour layers. **Deleted:** app NE roads layer, app NE place-labels layer (basemap owns both), OpenTopoMap option, OSM fallback + error-counter machinery, the pane/z-index system, `canvas-renderer.ts`, `preferCanvas`, `{r}` retina logic, `syncOverlayBounds` re-anchoring.
- **Counties:** `prepare-map-geodata.js` gains a Census `cb_*_us_county_5m` source (fetch → mapshaper clip/simplify → committed `next/public/geo/features/us-counties.geojson`, same runtime path/consumers). NE 10m county code path removed.

## 2. MapEngine interface

Shape as researched (§5 of research doc), consumed by `viewport-sync.ts`, hover bus, and all `use-*` hooks:

```ts
interface MapEngine {
  create(host, {center, zoom, maxBounds, minZoom}): void;  destroy(): void;
  getCenter(): LatLon;  getZoom(): number;          // compat-zoom during migration; native after Phase 6
  jumpTo({center, zoom}, meta?: {wxSync: boolean}): void;
  fitBounds(b, {padding}): void;  setMaxBounds(b): void;  setMinZoom(z): void;
  project(p: LatLon): Point;  unproject(pt: Point): LatLon;  getSize(): Size;
  on("move"|"moveend"|"zoomend"|"dblclick"|"mousemove"|"mouseout", fn): Off;
  setWeatherImage(key, url, bounds, opts): void;
  swapWeatherImage(key, url): void;                 // frame-animation hot path
  removeWeatherImage(key): void;  onWeatherImageLoaded(key, fn): void;
  setLineLayer(id, geojson, style): void;           // borders/counties/graticule
  setSymbolLayer(id, geojson, style): void;         // native synoptic labels / H&L (Phase 4)
  setGroupOpacity(group, v): void;                  // fan-out to raster-/line-/text-opacity
  addMarker(el: HTMLElement, p: LatLon): MarkerHandle;  // sounding pin, remote-hover crosshair
}
```

Layer ordering: the numeric pane z-table (`config/layers.ts`, 340–650) becomes a canonical ordered list of **anchor ids** (`anchor:weather` → `anchor:graticule` → `anchor:reference-lines` → `anchor:contours` → `anchor:synoptic` → first-basemap-symbol-layer for labels). Engine helpers insert at anchors via `addLayer(layer, beforeId)`.

Group opacity: no DOM shortcut exists — the engine multiplies group × per-layer opacity into `raster-opacity`/`line-opacity`/`text-opacity` via `setPaintProperty` for every layer in the group. Known cost, budgeted.

## 3. Weather overlays (the hot path)

One **ImageSource + raster layer** per active weather layer. Frame swap = `source.updateImage({url: blobUrl})` with `raster-fade-duration: 0`; `raster-resampling: "nearest"` replaces the `image-rendering: pixelated` CSS for raw-pixel layers. Blob object-URL prefetching (`image-prefetch-cache.ts`, `frame-prefetch.ts`) is untouched. Load signaling: `map.on("data")` filtered on `sourceId` + `isSourceLoaded`, wrapped as `onWeatherImageLoaded` so timeline status logic doesn't change. Sources removed promptly on layer deactivation (mirrors today's eviction loop).

**Phase 0 spike must settle animation:** 4 panels × 3 layers at 1.6 fps; targets — <20 ms main-thread per swap, no dropped-frame accumulation over a 60-frame loop, no monotonic GPU-memory growth, pan/zoom stays fluid during playback. Fallback if `updateImage` janks: two ImageSources per layer, ping-pong `raster-opacity` 0/1 (double-buffering).

## 4. Camera, sync, hover, zoom semantics

- Viewport sync keeps its architecture (rAF coalescing, epsilon guards, `alignAll`); echo suppression switches from the 120 ms `internalUntilByPanel` window to **eventData tagging** (`jumpTo(opts, {wxSync:true})`, ignore events carrying it; user gestures carry `originalEvent`).
- Hover/dblclick are 1:1 (`e.lngLat`); hover sampling math (`hover-utils.ts`) is already engine-free. Sounding pin + remote-hover crosshair reuse their HTML/CSS via `maplibregl.Marker`.
- **Zoom conversion is two-stage.** Phases 1–5: engine exposes compat-zoom (Leaflet scale ≈ native+1) so `VIEW_CONFIG`, fade curves, zoom buckets, and persisted state don't churn. Phase 6: convert the app to **native MapLibre zoom** everywhere; session storage schema bump converts stored viewports on load; `?c=` URLs gain a version marker, unversioned URLs read as Leaflet-scale and converted. All bucket/curve functions must tolerate fractional zoom. UI zoom clamp rises to native z13 (≈ old Leaflet z14).

## 5. Synoptic + contours: native GL redesign (not a parity port)

Owner note (2026-07-07): the current synoptic stack — line styling, label placement, declutter (`pickReadableSynopticLabels/-Centers`), H/L rendering — is a known-crude legacy implementation and needs rework regardless of engine. Therefore Phase 4 **designs the synoptic presentation fresh** on MapLibre primitives instead of replicating Leaflet output:

- **Isobars / thickness / height contours:** GeoJSON `line` layers (data is already lat/lon polylines). Line styling designed anew: weight/dash hierarchy for intervals, `line-opacity` zoom expressions. The screen-space canvas renderer machinery (`canvas-renderer.ts`, per-pane `L.canvas`) deletes outright.
- **Contour labels (pressure/thickness/height values):** `symbol` layers with `symbol-placement: "line"` where along-line labeling reads well, or point symbols at computed label anchors where it doesn't — decided by visual evaluation during the phase. Halos sized for readability over bright weather fills.
- **H/L centers:** `symbol` layer (text + optional sprite), `symbol-sort-key` encoding meteorological priority (deeper lows / stronger highs first), MapLibre's collision engine handling density instead of the custom screen-space declutter.
- **Acceptance:** side-by-side against the Leaflet reference is a *baseline for judgment*, not a parity gate. The bar: an analyst reads pressure fields faster and with less clutter than before; no missing H/L centers at synoptic scales; labels legible over reflectivity/CAPE fills at CONUS and regional zooms. Screenshots of representative cases (zonal flow, deep cyclone, ridge) recorded in the phase report; owner eyeballs before Leaflet deletion.
- The declutter/placement modules (`synoptic-render.ts` placement math, `pickReadable*`) are expected to shrink dramatically or disappear; whatever survives must be engine-free (operate on `project()` output only).

## 6. Offline + error handling

- No fallback basemap ⇒ failures must be loud and legible: missing/corrupt PMTiles renders a clear in-panel error state with the fix ("basemap file missing — run `npm run basemap:fetch`"), not a silent black map.
- `npm run basemap:fetch` (new script): runs `pmtiles extract` against the current dated Protomaps build with the NA bbox/zoom baked in; `pmtiles show`/`verify` sanity checks; documents refresh cadence (quarterly-ish).
- Range route: parse `Range: bytes=a-b`, reply `206` + `Accept-Ranges` + `Content-Range` via `fs.createReadStream({start,end})`; malformed/unsatisfiable ranges → `416`; HEAD support for the pmtiles protocol's probing.
- `webglcontextlost`: log + recreate the panel's map. `map.remove()` on every teardown path (layout churn is the known leak hazard; ~16-context browser cap).

## 7. Testing (analyst-ready bar)

1. **Phase 1 test bridge:** `window.__wx.getPanelViewport(id)`, `getActiveWeatherLayers(id)`, style introspection helpers; engine-neutral `data-testid`s. Every existing spec green against Leaflet-behind-engine before MapLibre work starts.
2. **Spec ports:** all `.leaflet-*` selector assertions rewritten against the bridge/testids; pane z-order + pane-opacity assertions become style-order/paint-property assertions via `page.evaluate`.
3. **Retired:** `basemap-fallback.spec.js` (tests deleted behavior). **Replaced by offline-boot spec:** block all non-localhost requests; assert basemap tiles, glyphs (labels visible), and sprites render.
4. **New viewport-sync spec:** two linked panels, drag one, assert convergence + no echo oscillation via the bridge.
5. **CI fixtures:** small committed PMTiles extract (CONUS z0–5, a few MB) + glyph subset — deterministic, network-free (repo CI rule).
6. **Golden-frame parity** while both engines exist: per-panel screenshots (basemap + boundaries + one weather layer), Leaflet vs MapLibre adjacent panels, at each phase boundary.
7. **Synoptic redesign acceptance** per §5 (owner eyeball on representative cases).
8. **Final gate:** full node + react suites green; live drive against the real artifact cache — playback at 1×–4×, 4-panel linked pan/zoom, hover Δ, double-click soundings, synoptic overlay, permalink round-trip — before Leaflet deletion lands.

## 8. Phases

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0 | Spike: PMTiles extract + Range route + throwaway `?engine=maplibre` panel + animation benchmark | Animation verdict with numbers (`updateImage` vs double-buffer) |
| 1 | `MapEngine` extracted around Leaflet; test bridge + testids | Pure refactor; every existing spec green |
| 2 | MapLibre engine core: camera/bounds/sync/hover/dblclick + dark style boots from local PMTiles | Side-by-side panels pan/zoom in lockstep |
| 3 | Weather ImageSources, anchors, group opacity, load signaling | Playback parity under timeline-stress on MapLibre panels |
| 4 | Vector overlays: borders/counties/graticule lines; **native synoptic redesign** (§5) | Owner accepts synoptic presentation; all overlay toggles work |
| 5 | Style polish, vendored glyphs/sprites, offline hardening, fallback deletion | Offline-boot spec green; style reads well over weather |
| 6 | Spec ports complete, native-zoom conversion, MapLibre default, **Leaflet deleted** | Full suites green + live-drive gate (§7.8) |

## 8a. Owner iteration round — 2026-07-08 (supersedes conflicting text above)

Recorded at the Task 4.3 owner gate; these decisions override earlier sections where they conflict:

1. **Light basemap style, and light becomes the DEFAULT.** The weather color maps were designed for a white background. The MapLibre engine ships TWO purpose-built styles — light (default) and dark — both generated/filtered from Protomaps flavors with meteorology tuning (halos, water, boundaries per theme). The basemap picker survives on MapLibre panels (light/dark; topo still dies in Phase 5). `DEFAULT_DISPLAY_SETTINGS.basemap` → `"light"`; users with an explicitly stored theme keep it. §1's "purpose-built dark style" and Task 5.2's "narrow to dark-only" are amended accordingly.
2. **All contour lines get labels** — isobars (minor + major), thickness, height contours — density managed by repeat spacing + the collision engine, not by hiding label classes. The z6 minor-label opacity gate is removed (it also left phantom collision boxes — labels invisible via paint opacity still claimed collision space, suppressing visible contour labels).
3. **H/L centers must never lose collisions to basemap city labels** (review finding): centers render with overlap-allow or above the basemap symbol stack — no missing centers, ever.
4. **Detailed isobar mode** (the existing "Isobar Detail" setting) must work on MapLibre exactly as it did on Leaflet.
5. **Height-contour geometry must be smooth** (owner: current 500 mb contours are jagged/angular) — smoothing happens in geographic space at a tolerance that preserves values/extrema, replacing the fixed-zoom smoothing constant. Styling redesigned to be attractive and crisp ("pretty ugly" verdict on round 1's casing look).
6. **H/L center placement accuracy must be CONFIRMED against the underlying field.** Known legacy issue: centers occasionally read a few mb less extreme than the true center and sit slightly off. Investigation (2026-07-08, `.superpowers/sdd/center-accuracy-investigation.md`) found extraction on a 25×15 downsampled grid with no full-res refinement: 36/40 centers less extreme (mean ~1 hPa, max 6.7 hPa; mean 46 km / max 148 km displaced). **Owner blessed the renderer fix in-branch (2026-07-08):** detect on the smoothed grid, refine position+value on the full-res field (physical-radius hill-climb), round at emit; target residual ≤0.5 hPa / ~8 km. Synoptic vector/manifest bytes change — the exactness rule is consciously waived for this accuracy fix; verification is before/after center tables on the cached run + node tests. The empty-`synopticCenters` manifest fallback bug rides along.
7. **Overall quality bar restated:** cleanness/sharpness designed AND confirmed ideal, both themes.

## 9. Risks (carried from research, updated)

- **Animation jank** — top open question; settled by Phase 0 before further investment.
- **Synoptic redesign scope** — no longer a parity port; risk shifts from "subtle mismatch" to "design iteration time." Mitigation: representative-case screenshot set early in Phase 4; owner feedback loop per case rather than at phase end.
- **Zoom half-conversion** — mitigated by the two-stage plan and a Phase 6 checklist of every zoom consumer (`VIEW_CONFIG`, `AUTO_BOUNDARY_STATE_MAX_ZOOM`, `getZoomBucketId`, `resolveCenterVisual`, fade curves, persisted state).
- **Lon-lat order bugs** — MapLibre is lon-first everywhere Leaflet was lat-first; engine boundary owns all conversions; no raw coordinate arrays cross it.
- **PMTiles availability** — one-time extracts from dated builds (supported pattern); `basemap:fetch` script pins the workflow.
- **Safari** — best-effort only (localhost Chrome-first app); noted in engine module header.
