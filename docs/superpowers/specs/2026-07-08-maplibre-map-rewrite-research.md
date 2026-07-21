# MapLibre GL JS Migration Research — Weather Model Viewer

**Date:** 2026-07-08 · **Status:** Research (no code changes)
**Scope:** Replace Leaflet 1.9.4 + CARTO raster basemaps with MapLibre GL JS + self-hosted vector tiles across the up-to-4-panel synced map grid, while keeping the prerendered-PNG weather artifact pipeline untouched.
**Baseline:** branch `ux-ops-suite` as of 2026-07-07, including the landed map-features work (counties / major roads / place labels / graticule in `use-map-feature-layers.ts`, data built by `scripts/prepare-map-geodata.js`).

**Library facts verified 2026-07-07:**
- `maplibre-gl` latest on npm: **5.24.0** (`next` tag: **6.0.0-20**, published 2026-07-05). The [April 2026 MapLibre newsletter](https://maplibre.org/news/2026-05-02-maplibre-newsletter-april-2026/) states 5.22–5.24 are the final v5 releases; [v6 is prerelease-only](https://github.com/maplibre/maplibre-gl-js/releases) (breaking: events-as-classes, style-spec v25, Camera composition). **Recommendation: build on 5.24.0**; take v6 later as a contained bump.
- v5's headline feature was [globe projection](https://github.com/maplibre/maplibre-gl-js/releases/tag/v5.0.0) (v5.0.0, Jan 2025) — irrelevant here (Web Mercator, CONUS/NA views only), but it confirms the v5 line is mature and battle-tested.
- `pmtiles` JS: **4.4.1** (npm, published 2026-04-08). `go-pmtiles` CLI: **v1.31.0** (released 2026-07-07).

---

## 1. Goals & non-goals

### Goals
1. **Crisp basemap at every zoom** — vector tiles rendered at devicePixelRatio with fractional zoom; no raster tile blur, no seams, no `{r}` retina URL hacks.
2. **Purpose-built dark meteorology style** — muted dark land/water, thin admin boundaries, restrained road network, and labels that render *above* weather rasters with halos. Full control via style JSON instead of today's sandwich of CARTO `light_nolabels` tiles + `dark_only_labels` label tiles (`next/src/config/constants.ts:39-42`).
3. **Offline-friendliness** — one local PMTiles file + self-hosted glyphs/sprites; zero CDN dependency at runtime. The tile-error fallback machinery in `use-map-display-layers.ts` (8-consecutive-error counter, 2.2 s no-load timer, OSM fallback layer) becomes deletable rather than portable.
4. **Keep the artifact-PNG weather pipeline unchanged** — weather stays prerendered PNGs served by the Node artifact server (`scripts/lib/local-artifact-server.js`); `core/frame-prefetch.ts` blob-object-URL prefetching, manifests, and render-panel builds are untouched. Only the *display* substrate changes.
5. **Behavior parity** — 4-panel viewport sync, hover mirroring, double-click point soundings, per-group opacity sliders, timeline playback at up to ~1.6 fps, synoptic declutter output.

### Non-goals
- Globe or non-Mercator projections, 3D terrain, pitch/rotate (lock with `dragRotate: false`, `pitchWithRotate: false`, `touchPitch: false`).
- GPU-rendering weather from data tiles/vectors (possible future; explicitly out of scope).
- Public deployment, mobile, or multi-user concerns — this remains a personal localhost app.
- Rewriting the synoptic declutter algorithm. Port it verbatim first; native symbol-layer decluttering is a post-parity experiment.

---

## 2. Current-state inventory → MapLibre mapping

All Leaflet coupling lives in `next/src/components/map-panel/*`, `next/src/core/viewport-sync.ts`, and `next/src/config/layers.ts` (pane/z-index tables). Files below are under `next/src/` unless noted.

### 2.0 The pane z-order model → layer ordering

Leaflet panes are DOM elements stacked by `z-index`, created in `map-layer-utils.ts:ensureLayerPanes`. Current stack (from `config/layers.ts`, including the feature panes):

| z | Pane | Content |
|---|---|---|
| 365 | `wx-dynamic-pane` (+ per-layer static panes) | weather PNG image overlays |
| 375 | `wx-graticule-pane` | graticule polylines |
| 377 | `wx-roads-pane` | major-road GeoJSON, canvas renderer |
| 378 | `wx-county-lines-pane` | US counties GeoJSON, canvas renderer |
| 380 / 382 | state / country borders panes | reference boundary GeoJSON (SVG renderers) |
| 390 / 410 | synoptic thickness / isobar panes | canvas polylines |
| 430 / 440 | height-contour / weather-vector panes | canvas polylines |
| 450 | `wx-labels-pane` | CARTO `dark_only_labels` raster tiles |
| 455 | `wx-place-labels-pane` | Natural Earth place-label divIcon markers (in-flight) |
| 650 | `wx-synoptic-marker-pane` | H/L markers + synoptic label divIcons |

MapLibre has no panes: **layer order is the style's layer array**, and `map.addLayer(layer, beforeId)` inserts relative to existing ids. Plan: translate the z table into a canonical ordered list of **anchor ids** — e.g. `anchor:weather`, `anchor:graticule`, `anchor:reference-lines`, `anchor:synoptic`, plus "first basemap symbol layer" as the natural labels anchor. Each engine helper inserts at its anchor; the numeric z values disappear. Group opacity (`pane.style.opacity` today, set in `use-map-display-layers.ts:210-259`) has no DOM shortcut: the engine must multiply group × per-layer opacity into `raster-opacity` / `line-opacity` / `text-opacity` via `setPaintProperty` for every layer in the group. This is the one place MapLibre is strictly *more* code — budget for it.

### 2.1 Feature-by-feature mapping

| # | Current (Leaflet) | Where | MapLibre equivalent |
|---|---|---|---|
| 1 | `L.map` with world `maxBounds` + `maxBoundsViscosity: 1`, then per-view `setMaxBounds`/`setMinZoom`; `doubleClickZoom: false` | `use-leaflet-map.ts:93-102,180-184` | `new maplibregl.Map({maxBounds, minZoom})`; `map.doubleClickZoom.disable()`. MapLibre `maxBounds` is hard-clamped (≈ viscosity 1). **Zoom offset:** MapLibre zoom is 512-px-tile based — equivalent scale ≈ Leaflet zoom − 1. See §6.6. |
| 2 | CARTO raster base + label tile layer + OSM outage fallback | `use-map-display-layers.ts:40-135` | One vector style from local PMTiles; labels are symbol layers ordered above weather. Fallback machinery deleted (offline file can't 404 from a CDN outage). |
| 3 | Weather PNGs: `L.imageOverlay(url, bounds, {opacity, pane, zIndex})`; frame swap via `overlay.setUrl(blobUrl)`; `image-rendering: pixelated` class for raw-pixel layers | `use-weather-overlays.ts:71-90`, `config/layers.ts` | One **`ImageSource`** + `raster` layer per active weather layer. Frame swap = [`source.updateImage({url})`](https://maplibre.org/maplibre-gl-js/docs/API/classes/ImageSource/); set **`raster-fade-duration: 0`** (the docs explicitly recommend this to prevent flashing on image change). `raster-resampling: "nearest"` replaces the pixelated CSS; `raster-opacity` replaces overlay + pane opacity. Use image sources, **not** raster tile sources — artifacts are single whole-view images, exactly ImageSource's job. §2.2 evaluates animation. |
| 4 | Reference boundaries: `L.geoJSON` + per-pane `L.svg` renderers, restyled from display settings, state lines zoom-gated | `use-map-display-layers.ts:137-208`, `core/borders.ts` | `geojson` source + `line` layer per kind; restyle via `setPaintProperty`; zoom gating as a zoom expression or kept in JS on `zoomend`. Same fetched GeoJSON — zero data change. |
| 5 | In-flight feature layers: counties + roads (canvas `L.geoJSON`), graticule (`L.polyline`), place labels (`L.divIcon` markers, zoom-faded opacity curves) | `use-map-feature-layers.ts`, `core/geo-features.ts`, `next/public/geo/features/` | Counties/roads/graticule → `geojson` sources + `line` layers with zoom-interpolated `line-opacity`/`line-width` expressions (the hand-written `countyOpacity(zoom)` curves translate directly to `interpolate` expressions). Place labels → either `symbol` layer from `na-places.json` (promoted to GeoJSON) or keep DOM markers. **Note overlap:** the Protomaps basemap already ships roads and place labels — decision point in §4/§7. |
| 6 | Synoptic isobars/thickness/gap lines: `L.polyline` batches on shared per-pane `L.canvas` renderers (padding 0.35) | `use-synoptic-vector.ts`, `canvas-renderer.ts` | Phased: **(a) first**, a screen-space `<canvas>` overlay in `map.getCanvasContainer()`, redrawn on `move`/`resize` using `map.project(lngLat)` — drop-in for `latLngToContainerPoint`, render code reused nearly verbatim. **(b) later**, GeoJSON `line` layers (data is already lat/lon polylines) for GPU-composited pan. `CustomLayerInterface` is the wrong tool — it exposes the raw WebGL context, not a 2D canvas. |
| 7 | Synoptic labels + H/L centers: `L.divIcon` markers, custom screen-space declutter (`pickReadableSynopticLabels/-Centers`) | `synoptic-render.ts`, `use-pressure-markers.ts:87-102` | Keep DOM: `new maplibregl.Marker({element})` reuses the exact `pressure-marker` HTML/CSS. Declutter only swaps `latLngToContainerPoint` → `map.project`. Native `symbol` layers (`text-field`, `symbol-sort-key`, collision engine) are a post-parity experiment, not part of the port. |
| 8 | Double-click → sounding (`map.on("dblclick", e.latlng)`) | `use-leaflet-map.ts:117-119` | `map.on("dblclick", e => e.lngLat)`. 1:1. |
| 9 | Hover: `mousemove`/`mouseout` → lat/lng → grid sampling; cross-panel hover mirroring | `use-leaflet-map.ts:106-116`, `core/hover-bus.ts` | `map.on("mousemove", e.lngLat)` / `"mouseout"`. Hover bus is engine-agnostic; only point↔lngLat conversions move behind the interface. |
| 10 | N-way viewport sync: `move/moveend/zoomend`, rAF-coalesced `setView(..., {animate:false, noMoveStart:true})`, echo suppression via 120 ms window + epsilons | `core/viewport-sync.ts` | `map.jumpTo({center, zoom})` driven by `move` events. **Cleaner echo suppression than today:** pass eventData — `map.jumpTo(opts, {wxSync: true})` — and ignore events carrying `e.wxSync`; user gestures additionally carry `e.originalEvent` while programmatic moves don't. The `internalUntilByPanel` time-window heuristic and its 120 ms constant can be deleted. Keep the epsilon guards (`MOVE_EPSILON_DEG`, `ZOOM_EPSILON`) — MapLibre zoom is continuous. Keep rAF coalescing and `alignAll`. |
| 11 | `ResizeObserver` → `invalidateSize` + `syncOverlayBounds` re-anchor loop | `use-leaflet-map.ts:186-210`, `map-layer-utils.ts:73-80` | `trackResize: true` (default) observes the container. `syncOverlayBounds` disappears — ImageSource coordinates are world-anchored, not DOM-anchored. |
| 12 | Initial `fitBounds` with padding; restored `?c=` viewport | `use-leaflet-map.ts:212-263` | `map.fitBounds(bounds, {padding: 8, animate: false})` / `jumpTo`. Apply the −1 zoom conversion for persisted viewports (version flag in `core/url-state.ts`). |
| 13 | Height-contour / weather-vector canvas polylines | `use-contour-vector.ts` | Same treatment as #6. |

### 2.2 Frame animation: `updateImage()` performance

Today: playback swaps `overlay.setUrl(blobObjectUrl)` per active layer per panel at up to ~1.6 fps; blobs are prefetched into the object-URL cache (`core/image-prefetch-cache.ts`) by `FramePrefetchEngine`.

MapLibre path: `imageSource.updateImage({url: blobUrl})` with `raster-fade-duration: 0`. Each call fetches the (blob) URL, decodes, and uploads a fresh GPU texture. At 1.6 fps × ~3 active layers × 4 panels ≈ **19 decode+upload operations/s** of view-sized PNGs — within desktop-GPU budget, but three caveats:

- **Decode repeats.** Leaflet's `<img>.src` swap benefits from the browser's decoded-image cache; MapLibre's fetch→decode path may re-decode each frame. Blob URLs are standard-fetchable, so the existing prefetch cache keeps working unchanged — but decode cost must be measured in the Phase-0 spike.
- **Fallback if it janks:** (a) keep exactly **two ImageSources per weather layer and ping-pong `raster-opacity` 0/1** (double-buffering, the pattern radar-animation apps use on MapLibre), or (b) pre-create a source+layer per prefetched frame and toggle opacity (memory-heavy; only if (a) fails).
- **`load`-event parity:** `markFrameLayerLoaded` hooks `overlay.once("load")` (`use-weather-overlays.ts:70,81`). MapLibre equivalent: `map.on("data")` filtered on `sourceId` + `isSourceLoaded`, wrapped as `onWeatherImageLoaded` in the engine interface so `frame-prefetch.ts` status logic is untouched.

Verdict: **ImageSource + `updateImage` is the correct first implementation**; double-buffering is a contained, well-understood fallback. This is the single highest-value question for the spike to answer.

### 2.3 What the migration deletes outright

A useful sanity check on net complexity — the port removes more machinery than it adds:

- Basemap outage fallback: consecutive-tile-error counter, 2.2 s no-load timer, OSM fallback layer, and `basemap-fallback.spec.js` (`use-map-display-layers.ts:59-120`).
- The two-tile-layer label sandwich (`dark_only_labels` over `light_nolabels`) and its labels pane.
- `ensureLayerPanes` + the entire numeric z-index table (13 panes → ordered anchor ids).
- `syncOverlayBounds` re-anchoring and the ResizeObserver → `invalidateSize` plumbing (3 effects in `use-leaflet-map.ts`) — `trackResize` + world-anchored image sources subsume both.
- The 120 ms `internalUntilByPanel` echo-suppression window in `viewport-sync.ts` (replaced by eventData tagging).
- The `{r}` retina URL logic and `preferCanvas` tuning.

New machinery added in exchange: group-opacity fan-out via `setPaintProperty` (§2.0), the range-request route + vendored glyphs/sprites (§3), and the −1 zoom-compat shim (§6.6).

---

## 3. Basemap data strategy (verified 2026-07)

| Option | What it is | Offline story | License / terms | Fit |
|---|---|---|---|---|
| **Protomaps PMTiles (self-hosted)** | Daily planet builds listed at [maps.protomaps.com/builds](https://maps.protomaps.com/builds/) (archives on `build.protomaps.com`), ~**120 GB** planet, z0–15; area extraction via `pmtiles` CLI ([downloads doc](https://docs.protomaps.com/basemaps/downloads)) | **One local file — fully offline** | Tiles: ODbL Produced Work → visible "© OpenStreetMap" attribution; map design CC0; code BSD-3 ([LICENSE_DATA](https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md)) | **Recommended** |
| [OpenFreeMap](https://openfreemap.org/) | Free public vector-tile instance: no keys, no limits, no registration; styles incl. **Dark** and Fiord; donation-funded | Public instance: online-only. Self-host needs ~**300 GB** planet image ([self-hosting doc](https://github.com/hyperknot/openfreemap/blob/main/docs/self_hosting.md)) | Fully open source ([repo](https://github.com/hyperknot/openfreemap)); OSM attribution | Good optional online fallback URL; self-hosting is 30× the disk for zero gain here |
| CARTO hosted vector | Keyless `style.json` endpoints, e.g. [`dark-matter-gl-style`](https://github.com/CartoDB/basemap-styles) at `basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json` | Online-only | Free under CARTO basemap grants + T&C; styles BSD-3 / CC-BY | Same online dependency the migration is shedding |

### Recommendation: self-hosted Protomaps PMTiles extract

For a personal localhost app that must work offline, a single PMTiles file wins outright: one download, no external service, no ToS exposure, daily rebuilds available whenever fresher data is wanted.

**Getting the file** (`go-pmtiles` v1.31.0; syntax per [CLI docs](https://docs.protomaps.com/pmtiles/cli)):

```sh
brew install pmtiles    # or a release binary from github.com/protomaps/go-pmtiles
# NA bbox matching VIEW_CONFIG "na" (7..74N, -170..-45), capped at z14:
pmtiles extract https://build.protomaps.com/20260707.pmtiles na-z14.pmtiles \
  --bbox=-170,7,-45,74 --maxzoom=14
```

Extraction issues range requests against the remote archive — it does **not** download the 120 GB planet. Useful companions: `pmtiles show na-z14.pmtiles` (verify bounds/zooms/tile counts after extract) and `pmtiles verify` (integrity). Refreshing data later is just re-running the extract against a newer dated build and swapping the file — worth a tiny `scripts/` helper alongside `prepare-map-geodata.js`, but not a blocker.

**Expected size at ~z14.** Verified reference point: a **US + Mexico z0–15 extract measured ≈ 17 GB** ([go-pmtiles #68](https://github.com/protomaps/go-pmtiles/issues/68)); Protomaps docs note each additional zoom level roughly doubles file size, so dropping z15 roughly halves it. Working estimates:

| Extract | Est. size |
|---|---|
| NA bbox (above) @ z15 | ~20–25 GB |
| NA bbox @ z14 | **~8–12 GB** |
| CONUS bbox (−129..−63, 21..53) @ z14 | ~5–8 GB |
| CONUS/NA @ z12 (current UI zoom clamp) | ~2–3 GB |

Since the UI currently clamps to z12, a **z13–14 extract (~4–12 GB)** buys zoom headroom cheaply; z15 doubles the bill for detail the app can't show today.

**Serving it locally:**
- Register the [pmtiles protocol](https://docs.protomaps.com/pmtiles/maplibre) once at app root: `maplibregl.addProtocol("pmtiles", new Protocol().tile)`; source URL `pmtiles://http://localhost:PORT/basemap/na-z14.pmtiles`. A single shared `Protocol` instance means all 4 panels share directory/header caches.
- The protocol reads via **HTTP range requests**. `scripts/lib/local-artifact-server.js` currently serves bodies with `fs.promises.readFile` (~line 1658) and has **no `Range` handling** — add a range-aware static route for `*.pmtiles` (parse `Range: bytes=a-b`, reply `206` + `Accept-Ranges: bytes` + `Content-Range`, stream via `fs.createReadStream({start, end})`; ~40 lines), or run `pmtiles serve` as a sidecar. Recommend extending the artifact server: one fewer process, and it already fronts all other app data.
- **Offline glyphs/sprites:** generated Protomaps styles point at GitHub Pages (`protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf`, `.../sprites/v4/{flavor}` — per [basemaps docs](https://docs.protomaps.com/basemaps/maplibre)). Vendor the [basemaps-assets](https://github.com/protomaps/basemaps-assets) repo into the artifact server's static tree and rewrite `glyphs`/`sprite` to localhost. **Without this, labels break offline** — easy to miss because it only fails when the network is down.

---

## 4. Dark meteorology style plan

Start from the **Protomaps `dark` (or `black`) flavor**, generated programmatically — style-as-code fits this repo better than a frozen JSON blob:

```ts
import { layers, namedFlavor } from "@protomaps/basemaps"; // flavors: light|dark|white|black|grayscale
const style = {
  version: 8,
  glyphs: "http://localhost:PORT/basemap/fonts/{fontstack}/{range}.pbf",
  sprite: "http://localhost:PORT/basemap/sprites/v4/dark",
  sources: { protomaps: { type: "vector",
    url: "pmtiles://http://localhost:PORT/basemap/na-z14.pmtiles",
    attribution: "© OpenStreetMap" } },
  layers: layers("protomaps", namedFlavor("dark"), { lang: "en" }),
};
```

The map design is CC0 — fork and edit freely. Plan:

1. **Strip POI noise:** drop POI symbol layers, building footprints, minor landuse fills, address/housenumber labels, and road classes below "major" until z8+. Filter the generated layer array by id prefix (`pois`, `buildings`, `landuse_*`) — the generated ids are stable within a basemap major version.
2. **Keep and tune:** water fills (near-black navy so weather colors pop), coastlines, admin-0/1 boundary lines, major highways as thin desaturated strokes, and place labels (state, city) with strong dark halos sized for readability over bright reflectivity fills.
3. **Weather anchor:** insert all weather raster layers *below the first basemap symbol layer*. Result: city/state labels and boundaries render above weather with halos — replacing the `dark_only_labels` raster-tile trick with the thing it was simulating.
4. **Counties are NOT in the basemap schema.** Protomaps v4 `boundaries` covers country/region kinds only — no US county (admin_level 6) geometry. **Already solved in-flight:** `scripts/prepare-map-geodata.js` builds `next/public/geo/features/us-counties.geojson` from Natural Earth 10m, fetched lazily and shared across panels (`core/geo-features.ts`). Under MapLibre this becomes a `geojson` source + `line` layer with the existing `countyOpacity(zoom)` fade curve expressed as an `interpolate` zoom expression. If NE 10m counties ever feel coarse, upgrade the *data* (Census `cb_*_us_county_5m` → same pipeline, or tippecanoe → a second PMTiles source) without touching the style.
5. **Roads/places overlap decision:** the in-flight app-drawn roads and place labels duplicate what the vector basemap provides. Options: (a) drop the app layers and restyle basemap roads/places (less code, one data source), or (b) keep app layers for exact control (custom fade curves, Natural Earth curation) and strip basemap roads/labels instead. Recommend **(a)** for roads, **owner's call** for place labels (§7 Q5) — the NE-curated label set may deliberately differ from OSM prominence.
6. **Graticule and all weather/synoptic layers stay app-owned** — they never belonged to the basemap.
7. **Retina:** nothing to do; MapLibre renders at `devicePixelRatio` natively. The "topographic" OpenTopoMap option can survive as a `raster` source inside MapLibre if wanted (online-only), or be dropped.

---

## 5. Migration strategy

### Recommendation: strangler via a `MapEngine` interface, panel-by-panel flag

Big-bang is tempting — the Leaflet surface is ~12 files — but the app has deep behavioral tests (sync, hover, playback, synoptic declutter), an in-flight feature branch touching the same files, and its riskiest pieces (animation perf, synoptic overlay) benefit enormously from A/B-ing Leaflet vs MapLibre **side by side in the same 4-panel grid**. The strangler costs one abstraction and buys incremental test migration, instant rollback, and adjacent-panel pixel comparison. Recommended.

**Interface shape** (derived from what panels actually consume):

```ts
interface MapEngine {
  create(host: HTMLElement, opts: {center; zoom; maxBounds; minZoom}): void;
  destroy(): void;
  getCenter(): LatLon;  getZoom(): number;              // compat-zoom (Leaflet scale)
  jumpTo(v: {center; zoom}, meta?: {wxSync: boolean}): void;
  fitBounds(b: Bounds, opts: {padding}): void;
  setMaxBounds(b: Bounds): void;  setMinZoom(z: number): void;
  project(p: LatLon): Point;  unproject(pt: Point): LatLon;
  on(ev: "move"|"moveend"|"zoomend"|"dblclick"|"mousemove"|"mouseout", fn): Off;
  setWeatherImage(key: LayerKey, url: string, bounds: Bounds, opts): void;
  swapWeatherImage(key: LayerKey, url: string): void;     // frame animation hot path
  removeWeatherImage(key: LayerKey): void;
  onWeatherImageLoaded(key: LayerKey, fn): void;
  setLineLayer(id, geojson, style): void;                  // borders/counties/roads/graticule
  setGroupOpacity(group: "weather"|"synoptic"|"labels", v: number): void;
  addMarker(el: HTMLElement, p: LatLon): MarkerHandle;     // divIcon-equivalents
  getOverlayCanvasHost(): HTMLElement;                     // synoptic canvas escape hatch
}
```

`viewport-sync.ts`, hover-bus, and all `use-*` hooks talk to this — never to `L.*` or `maplibregl.*` directly.

### Phased checklist

- **Phase 0 — Spike (throwaway, `?engine=maplibre`):**
  - PMTiles NA extract + range-request route on the artifact server; dark flavor boots in one panel.
  - `updateImage` with blob URLs at 1.6 fps, 3 layers, then 4 panels; profile decode/upload.
  - Concrete measurements to capture (Performance panel + `map.on("render")` timing):
    - main-thread ms per frame swap (target: < 20 ms with 4 panels × 3 layers),
    - dropped frames over a 60-frame playback loop at 1.6 fps,
    - GPU memory after a full playback cycle (no monotonic growth),
    - pan/zoom FPS while playback runs (the Leaflet baseline's weak spot),
    - context count in `chrome://gpu` after 10 layout add/remove cycles (leak check).
  - *Exit criterion:* animation parity confirmed, or double-buffer strategy selected with numbers.
- **Phase 1 — Extract `MapEngine` around Leaflet:** pure refactor, zero visual change, every existing Playwright spec green. Land the `data-map-engine` attribute + test bridge here. Coordinate with (or land after) the in-flight map-features branch to avoid churn in the same hooks.
- **Phase 2 — MapLibre engine core:** create/destroy, camera, maxBounds/minZoom with −1 zoom conversion, dblclick, hover, viewport sync via `jumpTo` + eventData echo tagging; basemap from local PMTiles + generated dark style; per-panel engine flag in panel state.
- **Phase 3 — Weather overlays:** ImageSource per layer, anchor ordering, group-opacity mapping, `raster-resampling: nearest` for raw-pixel layers, load signaling into `frame-prefetch.ts`, playback + prefetch parity under timeline-stress.
- **Phase 4 — Vector overlays:** boundaries/counties/roads/graticule as line layers; synoptic canvas as DOM overlay on `map.project`; divIcon HTML → `maplibregl.Marker`; H/L + synoptic label declutter parity.
- **Phase 5 — Style polish + offline hardening:** POI stripping, label/halo tuning, vendored glyphs/sprites, attribution control ("© OpenStreetMap"), delete raster-fallback machinery, offline-boot verification.
- **Phase 6 — Flip default + remove Leaflet:** default `engine=maplibre`, port remaining specs, soak for a week of real forecasting use, then drop `leaflet` + `@types/leaflet` and the Leaflet engine.

### Test strategy

Specs touching the map today (grep `leaflet-`/`cartocdn` under `tests-react/`): **smoke-react (17 refs), display-menu (5), basemap-fallback (4), sounding-liveness/-drawer/-compare, responsive-react, keyboard-shortcuts, hover-card, hover-diff, error-empty-states** — plus behaviorally `synoptic-render`, `timeline-playback/-stress/-skip-unloaded`, `session-persistence`, `url-state`, `panel-collection`.

- **Engine-neutral assertions:** replace `.leaflet-container` / `wx-overlay-*` selectors with `data-testid`s plus a small test bridge (`window.__wx.getPanelViewport(id)`, `getActiveWeatherLayers(id)`) so specs assert app state, not library DOM. Do this in Phase 1 so both engines pass the same specs.
- **Retire `basemap-fallback.spec.js`** (tests deleted behavior); replace with an **offline-boot spec**: block all non-localhost requests, assert basemap + labels render from PMTiles + vendored glyphs.
- **New fixtures:** a small committed PMTiles extract (CONUS @ z0–5, a few MB) + glyph subset so CI stays deterministic and network-free (matches the repo's enforced `format:check`/no-network CI rule).
- **Golden-frame parity:** per-panel screenshots of basemap + boundaries + one weather layer, Leaflet vs MapLibre side by side during Phases 2–5 — reuse the repo's existing golden-frame discipline from the renderer work.
- **Explicit viewport-sync spec:** two panels, drag one, assert convergence + no echo oscillation via the bridge. Sync is currently only implicitly covered and is the subtlest port.

---

## 6. Risks & unknowns

1. **WebGL context limits — low risk, verified:** Chrome and Safari cap at ~**16 live WebGL contexts per page** (Firefox ~200); exceeding the cap fires `webglcontextlost` on the *oldest* context ([Chromium #40939743](https://issues.chromium.org/issues/40939743), [#40543269](https://issues.chromium.org/issues/40543269)). 4 panels = 4 contexts — comfortable. The real hazard is leak-by-recreation during layout changes (`layoutVersion` churn re-creates maps): always `map.remove()` in cleanup (the Leaflet code already models this), and add a `webglcontextlost` handler that logs and recreates the panel.
2. **Raster animation jank — the open question.** Repeated decode + texture upload per `updateImage` vs Leaflet's cached `<img>` swap. Mitigation ladder in §2.2; settle it in Phase 0 before committing to the port.
3. **Blob-URL textures and memory:** GPU textures are per-map — the same frame visible in 4 panels = 4 texture copies (Leaflet shared one decoded bitmap). ~2000×1200 RGBA ≈ 9.6 MB; ×3 layers ×4 panels ≈ 115 MB GPU — fine, but don't raise the object-URL cache budget (`image-prefetch-cache.ts`) assuming GPU memory is free, and `removeSource` promptly when layers deactivate (mirror today's overlay eviction loop in `use-weather-overlays.ts:93-100`).
4. **Safari quirks:** same ~16-context cap; historically slower WebGL; MapLibre 5 requires WebGL2 (Safari ≥ 15.4 — fine in 2026); occasional canvas-dimension limits at high DPR × very large panels. Localhost Chrome-first app → treat Safari as best-effort and note it in the doc header of the engine module.
5. **Synoptic canvas overlay integration:** the DOM-canvas port redraws on CPU each `move` frame — same cost class as today's `L.canvas` renderer — but MapLibre pans the basemap on GPU while the overlay redraws, so *relative* lag between contours and basemap during fast pans is possible (Leaflet had the analogous artifact via CSS-transformed panes + 0.35 canvas padding). If distracting: redraw inside `map.on("render")` in the same rAF, or accelerate the Phase-4b native-line-layer conversion for isobars. Avoid `CustomLayerInterface` unless going full WebGL.
6. **Zoom-semantics conversion (−1) is easy to half-do.** Persisted `?c=` URLs, session viewports, `VIEW_CONFIG` zooms, `AUTO_BOUNDARY_STATE_MAX_ZOOM`, synoptic `getZoomBucketId` buckets, `resolveCenterVisual` marker sizing, label `maxLabels` thresholds, and the new in-flight `countyOpacity`/`roadOpacity` curves all key off Leaflet zoom numbers. Centralize as compat-zoom in the engine (`getZoom()` returns Leaflet-scale) during the strangler window; convert call sites deliberately in Phase 6. Make all bucket functions tolerate fractional zoom.
7. **Retina / resampling:** basemap improves automatically. Weather PNGs are fixed-resolution and geo-anchored — visually identical. Verify `raster-resampling: nearest` layers at fractional zoom: nearest-neighbor at non-integer scale can shimmer during zoom animation; acceptable outs are disabling zoom inertia or per-layer linear resampling.
8. **v6 timing:** v5 is feature-frozen ([final v5 releases](https://maplibre.org/news/2026-05-02-maplibre-newsletter-april-2026/)); v6 prereleases land weekly with breaking API changes (event classes, style-spec 25). Keeping all `maplibregl.*` usage inside one engine module makes the eventual bump a one-file change.
9. **Protomaps build availability:** runtime hotlinking of `build.protomaps.com` is discouraged — but the workflow only touches it for one-time extracts, which is the supported pattern. Re-extract quarterly-ish if fresh OSM edits matter.
10. **In-flight branch collision:** `use-map-feature-layers.ts` & friends are uncommitted; starting Phase 1 before that lands means refactoring a moving target. Sequence: land features → extract engine.

---

## 7. Effort estimate & open questions

Solo work, focused days, existing test harness assumed:

| Phase | Work | Est. |
|---|---|---|
| 0 | Spike: PMTiles + range route + 4-panel animation benchmark | 1–2 d |
| 1 | `MapEngine` extraction around Leaflet (pure refactor, tests green) | 3–4 d |
| 2 | MapLibre core: camera/sync/bounds/hover/dblclick + dark style boot | 3–5 d |
| 3 | Weather ImageSources, anchors, opacity groups, load signaling | 2–4 d |
| 4 | Vector overlays + synoptic canvas + markers parity | 3–5 d |
| 5 | Style polish, offline glyphs/sprites, fallback deletion | 2–3 d |
| 6 | Test migration, default flip, Leaflet removal | 2–3 d |
| | **Total** | **~16–26 d** (3–5 weeks part-time) |

Schedule risks concentrate in Phase 4 (synoptic parity) and the Phase 0 animation verdict.

### Open questions for the owner
1. **Disk budget / max zoom:** is ~8–12 GB acceptable for an NA z14 extract, or cap at z12 (~2–3 GB) matching today's zoom clamp? Separately — should the migration *raise* the zoom clamp (z13–14) now that tiles would be crisp there?
2. **Extract coverage:** NA view reaches 74°N/−170°W. Full NA bbox (bigger file) or CONUS-focused extract accepting sparse basemap at NA-view edges?
3. **Counties data source:** stay with the in-flight Natural Earth 10m counties, or upgrade to Census `cb_*_us_county_5m` via `prepare-map-geodata.js` during the migration?
4. **Online fallback:** keep OpenFreeMap Dark (`tiles.openfreemap.org/styles/dark`) wired as an optional online style behind a setting, or go fully local-only and delete all fallback pathways?
5. **Roads/place labels ownership:** adopt basemap roads + labels (less app code) or keep the in-flight app-drawn NE layers for curation control? (Recommend basemap roads; labels are a taste call.)
6. **Synoptic endgame:** is the DOM-canvas port acceptable long-term, or is native line/symbol conversion — MapLibre's collision engine replacing `pickReadableSynopticLabels` — a goal worth its own later phase?
7. **Topographic basemap option:** keep OpenTopoMap as an online raster source inside MapLibre, or drop the option?
8. **Timing vs v6:** start now on 5.24.0 (recommended — v6 has no announced stable date), or wait?

---

## Appendix: Leaflet → MapLibre API cheat sheet (calls used by this app)

| Leaflet (as used) | MapLibre GL JS 5.x |
|---|---|
| `L.map(el, {maxBounds, maxBoundsViscosity: 1, minZoom})` | `new Map({container, maxBounds, minZoom})` (maxBounds is hard-clamped) |
| `map.setView(center, zoom, {animate: false, noMoveStart: true})` | `map.jumpTo({center, zoom}, eventData)` |
| `map.fitBounds(b, {animate: false, padding: [8, 8]})` | `map.fitBounds(b, {animate: false, padding: 8})` |
| `map.getCenter()` / `getZoom()` | same names; zoom differs by ≈ −1 (512-px tiles) |
| `map.on("moveend" / "zoomend" / "dblclick" / "mousemove" / "mouseout")` | same event names; `e.latlng` → `e.lngLat` (lon-first!) |
| `map.latLngToContainerPoint(ll)` / `containerPointToLatLng(pt)` | `map.project(lnglat)` / `map.unproject(pt)` |
| `map.invalidateSize()` | `map.resize()` (usually unnecessary: `trackResize`) |
| `L.imageOverlay(url, bounds, {opacity, pane, zIndex}).setUrl(u)` | `addSource(id, {type: "image", url, coordinates})` + `raster` layer; `getSource(id).updateImage({url})` |
| `overlay.once("load", fn)` | `map.on("data", e => e.sourceId === id && e.isSourceLoaded && fn())` |
| `L.geoJSON(data, {style, renderer})` / `layer.setStyle(s)` | `addSource(id, {type: "geojson", data})` + `line` layer; `setPaintProperty(...)` |
| `L.marker(ll, {icon: L.divIcon({html})})` | `new Marker({element: htmlEl}).setLngLat(ll).addTo(map)` |
| `pane.style.opacity = v` (group opacity) | `setPaintProperty(layerId, "raster-opacity" / "line-opacity" / "text-opacity", groupV × layerV)` per layer |
| `pane.style.zIndex = n` | layer array order; `addLayer(layer, beforeAnchorId)` |
| `map.remove()` | `map.remove()` (also frees the WebGL context — mandatory) |
| Bounds order `[[south, west], [north, east]]` (lat-first) | `[[west, south], [east, north]]` (lon-first) — a classic silent-bug source |

### Key sources
- MapLibre releases: https://github.com/maplibre/maplibre-gl-js/releases · npm dist-tags `latest 5.24.0` / `next 6.0.0-20` (checked 2026-07-07)
- MapLibre v5 finale / v6 transition: https://maplibre.org/news/2026-05-02-maplibre-newsletter-april-2026/
- Globe in v5.0.0: https://github.com/maplibre/maplibre-gl-js/releases/tag/v5.0.0
- ImageSource API (`updateImage`, `raster-fade-duration` note): https://maplibre.org/maplibre-gl-js/docs/API/classes/ImageSource/
- Protomaps downloads & extract: https://docs.protomaps.com/basemaps/downloads · https://docs.protomaps.com/pmtiles/cli
- PMTiles + MapLibre protocol: https://docs.protomaps.com/pmtiles/maplibre
- Protomaps flavors / glyph & sprite assets: https://docs.protomaps.com/basemaps/maplibre
- Protomaps licensing (code BSD-3 / design CC0 / tiles ODbL): https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md
- US+Mexico z0–15 extract ≈ 17 GB datapoint: https://github.com/protomaps/go-pmtiles/issues/68
- OpenFreeMap: https://openfreemap.org/ · https://github.com/hyperknot/openfreemap
- CARTO vector styles: https://github.com/CartoDB/basemap-styles
- WebGL context limits (~16 Chrome/Safari, oldest-lost): https://issues.chromium.org/issues/40939743 · https://issues.chromium.org/issues/40543269
