# MapLibre GL Map Architecture Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Leaflet + CARTO raster basemaps with MapLibre GL 5.24.0 + self-hosted Protomaps PMTiles behind a `MapEngine` interface, redesign the synoptic stack natively on GL primitives, and delete Leaflet — per approved spec `docs/superpowers/specs/2026-07-07-maplibre-migration-design.md`.

**Architecture:** Strangler. Phase 0 proves animation feasibility; Phase 1 extracts a `MapEngine` interface around Leaflet (pure refactor, suite green); Phases 2–5 build the MapLibre engine feature-by-feature with per-panel engine A/B; Phase 6 flips the default, converts zoom semantics to native, and deletes Leaflet. All `L.*`/`maplibregl.*` usage lives in `next/src/core/map-engine/`; hooks and `viewport-sync.ts` consume only the interface.

**Tech Stack:** maplibre-gl 5.24.0 (exact pin), pmtiles ^4.4.1, @protomaps/basemaps (pin at install), Vite 7 + React 19 + TS + Tailwind 4, Node 20 artifact server (no framework), node:test, Playwright 1.52.

## Global Constraints

- **Weather artifact pipeline untouched:** no changes under `scripts/lib/noaa-beta/` or to any render formula/threshold/gating (`plan.md` accuracy-first rule). Only the display substrate changes.
- **Public mirror constraint:** never delete/rename public palette exports or scale constants. Geodata output deletions (roads/places, Task 6.3) must be noted for the public sync playbook.
- **Engine containment:** `leaflet` and `maplibre-gl` importable ONLY inside `next/src/core/map-engine/` — enforced by eslint `no-restricted-imports` from Task 1.5. Temporary exceptions (deleted in Phase 6): `use-synoptic-vector.ts`, `use-contour-vector.ts`, `use-pressure-markers.ts`, `synoptic-render.ts`, `synoptic-utils.ts`, `canvas-renderer.ts`, `map-layer-utils.ts` via the `getLeafletMap()` hatch.
- **Zoom semantics:** engine exposes compat-zoom (Leaflet scale = MapLibre native + 1) through Phase 5. Native conversion + persisted-state migration happen in Task 6.2 ONLY — no call site converts early.
- **Coordinate order:** the engine contract is `{lat, lon}` objects and `{south, west, north, east}` bounds — no positional arrays cross the engine boundary (MapLibre is lon-first, Leaflet lat-first; arrays are the classic silent bug).
- **Network-free tests:** CI fixtures committed (`tests-react/fixtures/basemap-fixture.pmtiles` CONUS z0–5 + glyph subset). The real NA extract lives in `output/basemap/` (gitignored). Offline-boot spec blocks non-localhost.
- **Validation baseline per task:** `node --test tests-node/*.test.js && npm run typecheck && npm run lint -- --quiet && npm run format:check && npm run smoke:react` (= `npm test`). Phase gates additionally run `npm run test:react`.
- Branch `maplibre-map-engine`; commit per task; parity screenshots into `output/map-parity/` (gitignored).

## Shared engine contract (referenced by all tasks)

`next/src/core/map-engine/types.ts` — exact names used everywhere below:

```ts
export type LatLon = { lat: number; lon: number };
export type GeoBounds = { south: number; west: number; north: number; east: number };
export type PointPx = { x: number; y: number };
export type EngineEventName = "move" | "moveend" | "zoomend" | "dblclick" | "mousemove" | "mouseout";
export type EngineEvent = { latlon?: LatLon; meta?: EventMeta };
export type EventMeta = { wxSync?: boolean };
export type OpacityGroup = "weather" | "synoptic" | "labels" | "boundaries";
export type AnchorId = "weather" | "graticule" | "reference" | "contours" | "synoptic" | "labels";
export type ZoomCurve = Array<[zoom: number, value: number]>; // piecewise-linear, compat-zoom domain
export type BasemapTheme = "dark" | "light" | "topo"; // "light"/"topo" die in Phase 5
export interface MarkerHandle { setLatLon(p: LatLon): void; setOpacity(v: number): void; remove(): void; }
export interface LineLayerStyle {
  color: string; weight: number; opacity: number | ZoomCurve;
  dashArray?: number[]; group: OpacityGroup; anchor: AnchorId;
}
export interface SymbolLayerStyle { // Phase 4, maplibre-only
  textProperty: string; textSize: number | ZoomCurve; color: string;
  haloColor: string; haloWidth: number; sortKeyProperty?: string;
  placement: "point" | "line"; group: OpacityGroup; anchor: AnchorId;
}
export interface MapEngine {
  readonly kind: "leaflet" | "maplibre";
  readonly capabilities: { basemapDetail: boolean }; // true ⇒ setBasemapDetail supported
  create(host: HTMLElement, opts: { center: LatLon; zoom: number; maxBounds: GeoBounds; minZoom: number; maxZoom: number }): void;
  destroy(): void;
  getCenter(): LatLon; getZoom(): number; getSize(): PointPx;
  jumpTo(v: { center: LatLon; zoom: number }, meta?: EventMeta): void;
  fitBounds(b: GeoBounds, opts?: { padding?: number }): void;
  setMaxBounds(b: GeoBounds): void; setMinZoom(z: number): void; setMaxZoom(z: number): void;
  project(p: LatLon): PointPx; unproject(pt: PointPx): LatLon;
  on(ev: EngineEventName, fn: (e: EngineEvent) => void): () => void;
  setBasemap(opts: { theme: BasemapTheme; labels: boolean }): void;
  setBasemapDetail(opts: { roads: boolean; cities: boolean }): void; // no-op when !capabilities.basemapDetail
  setWeatherImage(key: string, url: string, bounds: GeoBounds, opts: { opacity: number; pixelated: boolean }): void;
  swapWeatherImage(key: string, url: string): void;
  removeWeatherImage(key: string): void;
  onWeatherImageLoaded(key: string, fn: () => void): () => void;
  setLineLayer(id: string, data: GeoJSON.FeatureCollection, style: LineLayerStyle): void;
  setSymbolLayer(id: string, data: GeoJSON.FeatureCollection, style: SymbolLayerStyle): void;
  removeLayer(id: string): void;
  setGroupOpacity(group: OpacityGroup, v: number): void;
  addMarker(el: HTMLElement, p: LatLon, opts?: { interactive?: boolean }): MarkerHandle;
  getLeafletMap(): import("leaflet").Map | null; // TEMPORARY hatch — synoptic/contour/pressure hooks only
}
export function createMapEngine(kind: MapEngine["kind"]): MapEngine; // factory in index.ts
```

Test bridge (Task 1.5), `window.__wx`:
`{ panels(): string[]; getViewport(id): {lat: number; lon: number; zoom: number}; getEngineKind(id): "leaflet"|"maplibre"; getActiveWeatherLayers(id): string[]; isWeatherLoaded(id, key): boolean; getLayerOrder(id): string[]; getGroupOpacity(id, group): number }`

---

## Phase 0 — Spike (exit: animation verdict with numbers)

### Task 0.1: HTTP Range route on the artifact server

**Files:**
- Modify: `scripts/lib/local-artifact-server.js` (static route for `/basemap/*.pmtiles`, GET+HEAD)
- Test: `tests-node/artifact-range-route.test.js`

**Interfaces (produces):** `GET /basemap/<name>.pmtiles` with `Range: bytes=a-b` → `206` + `Accept-Ranges: bytes` + `Content-Range: bytes a-b/total` + exact byte slice via `fs.createReadStream({start, end})`. Open-ended (`bytes=a-`) and suffix (`bytes=-n`) forms supported; multi-range → serve full `200` (pmtiles never sends it); unsatisfiable → `416` + `Content-Range: bytes */total`; no Range header → `200` full body; `HEAD` → headers incl. `Content-Length`, no body. Files resolved ONLY from `output/basemap/` via `SAFE_PATH_COMPONENT`-style name gate (no traversal).

**Steps:** write failing node tests against a temp dir with a seeded file (slice equality vs `Buffer.subarray`, both range forms, 416, HEAD, traversal 404); run (fail); implement route; run (pass); `npm test`; commit `feat: range-request route for PMTiles on the artifact server`.

### Task 0.2: `basemap:fetch` script + NA extract + CI fixture

**Files:**
- Create: `scripts/prepare-basemap.js`
- Modify: `package.json` (scripts: `"basemap:fetch": "node scripts/prepare-basemap.js"`), `.gitignore` (`output/basemap/`)
- Create (committed): `tests-react/fixtures/basemap-fixture.pmtiles`

**Interfaces:** script shells out to the `pmtiles` CLI (brew-installed; fail with install hint if absent): `pmtiles extract https://build.protomaps.com/<latest-dated>.pmtiles output/basemap/na.pmtiles --bbox=-170,7,-45,74 --maxzoom=14`, then `pmtiles show` and size sanity (>2 GB), prints refresh instructions. `--fixture` flag extracts CONUS z0–5 from the local NA file into `tests-react/fixtures/basemap-fixture.pmtiles`.

**Steps:** install `pmtiles` CLI; write script; kick off the NA extract **in the background** (8–12 GB — overlaps Phases 0.3–1); when done: `pmtiles show output/basemap/na.pmtiles` (verify bbox/zoom), build + commit fixture (a few MB); commit `feat: basemap fetch script + committed CI PMTiles fixture`.

### Task 0.3: Animation spike + verdict

**Files:**
- Modify: `package.json` (deps: `maplibre-gl@5.24.0` exact, `pmtiles@^4.4.1`, `@protomaps/basemaps@latest` pinned)
- Create: `next/src/spike/MapLibreSpike.tsx` (dev-only, deleted Task 6.3)
- Modify: `next/src/main.tsx` (early-return `?spike=maplibre` → render spike)
- Create: `docs/superpowers/specs/2026-07-07-maplibre-phase0-verdict.md`

**Interfaces:** spike renders 4 MapLibre maps (dark flavor from fixture or NA pmtiles via `pmtiles` protocol, whichever is ready) × 3 `ImageSource` raster layers each, cycling real frame PNGs from the artifact cache as blob object URLs at 625 ms; on-screen stats: avg/p95 `updateImage` wall ms, rAF-gap dropped frames over 60 swaps, `performance.memory` trend; `raster-fade-duration: 0`.

**Steps:** install deps; build spike; run against real cache frames; record numbers for 1/2/4 panels; verdict in the doc — **`updateImage` direct** vs **double-buffered ping-pong** (two sources per layer, `raster-opacity` 0/1), per spec targets (<20 ms swap main-thread, no dropped-frame accumulation, flat GPU memory); commit `feat(spike): maplibre 4-panel animation benchmark + phase-0 verdict`.

---

## Phase 1 — MapEngine extraction around Leaflet (exit: pure refactor, full suite green)

### Task 1.1: Engine contract + Leaflet engine core + panel rewire

**Files:**
- Create: `next/src/core/map-engine/types.ts` (contract above verbatim), `next/src/core/map-engine/index.ts` (`createMapEngine`), `next/src/core/map-engine/leaflet-engine.ts`, `next/src/core/map-engine/zoom-compat.ts` (`compatToNative(z) = z - 1`, `nativeToCompat(z) = z + 1`, used by maplibre engine only)
- Create: `next/src/components/map-panel/use-panel-map.ts` (replaces `use-leaflet-map.ts` — same responsibilities, engine-typed)
- Modify: `next/src/components/MapPanel.tsx` (`mapRef: RefObject<MapEngine>`; inline sounding-pin `L.circleMarker` + remote-crosshair `L.marker` → `engine.addMarker` with equivalent styled divs)
- Modify: `next/src/core/viewport-sync.ts` (typed to `MapEngine`; echo suppression via `EventMeta.wxSync` — the 120 ms `internalUntilByPanel` window and `INTERNAL_EVENT_WINDOW_MS` move INSIDE `leaflet-engine.ts`, which tags its own `move` events fired within the window after a programmatic `jumpTo`)
- Modify: `next/src/hooks/useViewportSync.ts` (drop `invalidateSize` — resize handling moves inside `create()`)
- Delete: `next/src/components/map-panel/use-leaflet-map.ts`

**Interfaces:** consumes/produces the shared contract. `leaflet-engine.create` owns: `L.map` options (`preferCanvas`, `doubleClickZoom: false`, world `maxBounds` viscosity 1), `ensureLayerPanes`, ResizeObserver → `invalidateSize` + `syncOverlayBounds`. Epsilon guards (`MOVE_EPSILON_DEG`, `ZOOM_EPSILON`), rAF coalescing, `alignAll` stay in `viewport-sync.ts` unchanged.

**Steps:** create contract + engine (move code, don't rewrite); rewire consumers; `npm test` green; `npm run test:react` green (zero visual change expected); commit `refactor: extract MapEngine interface around Leaflet (camera, events, markers, sync)`.

### Task 1.2: Weather overlays through the engine

**Files:**
- Modify: `next/src/core/map-engine/leaflet-engine.ts` (`setWeatherImage`/`swapWeatherImage`/`removeWeatherImage`/`onWeatherImageLoaded` wrapping `L.imageOverlay` + pane/zIndex/pixelated-class logic from today), `next/src/components/map-panel/use-weather-overlays.ts` (consumes engine; `overlayRef` map of `L.ImageOverlay` moves inside the engine keyed by `key`)

**Interfaces:** `onWeatherImageLoaded(key, fn)` fires exactly when today's `overlay.once("load")` fired — `markFrameLayerLoaded` and `frame-prefetch.ts` are untouched.

**Steps:** move; `npm test`; `npm run test:react -- timeline-playback timeline-stress timeline-skip-unloaded smoke-react`; commit `refactor: weather overlays behind MapEngine`.

### Task 1.3: Basemap + boundaries + group opacity through the engine

**Files:**
- Modify: `leaflet-engine.ts` (`setBasemap` absorbs CARTO tile layers, label sandwich, OSM fallback machinery from `use-map-display-layers.ts:40-147`; `setLineLayer` wraps `L.geoJSON` + per-pane renderers; `setGroupOpacity` wraps pane opacity), `next/src/components/map-panel/use-map-display-layers.ts` (keeps: settings interpretation, boundary fetch via `core/borders.ts`, zoom gating; loses: all `L.*`)

**Steps:** move; `npm test`; `npm run test:react -- display-menu basemap-fallback smoke-react`; commit `refactor: basemap, boundaries, opacity groups behind MapEngine`.

### Task 1.4: Feature layers through the engine

**Files:**
- Modify: `next/src/components/map-panel/use-map-feature-layers.ts` (counties/roads/graticule via `setLineLayer` with `ZoomCurve` opacities replacing `countyOpacity()`/`roadOpacity()` inline math; place labels via `addMarker`; all fetch/cull/rank logic stays in the hook), `leaflet-engine.ts` (ZoomCurve evaluation on `zoomend` for leaflet line layers)

**Steps:** move; verify toggles by hand in `npm run dev`; `npm test`; commit `refactor: detail feature layers behind MapEngine`.

### Task 1.5: Test bridge + engine-neutral specs + lint containment

**Files:**
- Create: `next/src/core/map-engine/test-bridge.ts` (installs `window.__wx` per contract above; registered from `App.tsx` always — localhost app)
- Modify: `eslint.config.js` (no-restricted-imports for `leaflet`, `maplibre-gl` outside `map-engine/` + listed temporary exceptions)
- Modify: `tests-react/smoke-react.spec.js` (pane z-order + pixelated-CSS assertions → `getLayerOrder` bridge assertions), `tests-react/display-menu.spec.js` (pane-opacity reads → `getGroupOpacity`), `tests-react/{hover-card,hover-diff,keyboard-shortcuts,error-empty-states,sounding-drawer,sounding-compare,sounding-liveness,responsive-react}.spec.js` (`.leaflet-container` → `[data-testid="map-canvas-host"]` on the panel root)

**Interfaces (produces):** every spec asserts app state via bridge/testids; `basemap-fallback.spec.js` is the only spec still Leaflet-DOM-coupled (dies in Phase 5).

**Steps:** bridge; spec rewrites; `npm run test:react` full — green; commit `test: engine-neutral bridge + spec selectors; lint-contain map libraries`.

**PHASE 1 GATE:** `npm test` + `npm run test:react` fully green; manual smoke in `npm run dev` (pan/sync/playback/sounding/synoptic identical).

---

## Phase 2 — MapLibre engine core (exit: side-by-side panels in lockstep)

### Task 2.1: Dark style + maplibre-engine core + engine flag

**Files:**
- Create: `next/src/core/map-engine/basemap-style.ts` (`buildDarkStyle(baseUrl: string): StyleSpecification` — `layers("protomaps", namedFlavor("dark"), {lang:"en"})` filtered: drop id-prefixes `pois`, `buildings`, `landuse_`, address/housenumber labels; near-black navy water paint; glyphs/sprite → `${baseUrl}/basemap/fonts/...` / `${baseUrl}/basemap/sprites/...`; source `pmtiles://${baseUrl}/basemap/na.pmtiles`, attribution "© OpenStreetMap")
- Create: `next/src/core/map-engine/maplibre-engine.ts` (create/destroy/camera/bounds via zoom-compat, `dragRotate:false`, `pitchWithTouch` off, `doubleClickZoom.disable()`, events incl. eventData `wxSync` tagging, `project`/`unproject`, `addMarker` via `maplibregl.Marker`, `trackResize`, `webglcontextlost` → log + recreate, `map.remove()` on destroy; `setBasemap` supports `theme:"dark"` only — engine throws on others; `getLeafletMap()` returns `null`)
- Create: `next/src/core/map-engine/pmtiles-protocol.ts` (module-singleton `maplibregl.addProtocol("pmtiles", new Protocol().tile)`)
- Vendor (committed): `next/public/basemap/fonts/<used stacks only>`, `next/public/basemap/sprites/` from `protomaps/basemaps-assets` — dark flavor's referenced font stacks only; serve also via artifact server static tree so both origins work
- Modify: `next/src/components/map-panel/use-panel-map.ts` + panel state (per-panel `engine` field; global default from `?engine=`; dev-only per-panel toggle in `DisplayMenu.tsx`), `MapPanel.tsx` (in-panel error state when basemap source errors: "basemap file missing — run `npm run basemap:fetch`")

**Interfaces:** `createMapEngine("maplibre")` returns full contract; unimplemented weather/line/symbol methods console.warn + no-op until Phases 3–4 (panels render basemap only).

**Steps:** style module; engine; flag; boot one maplibre panel next to leaflet panels; verify hover readout, dblclick sounding, viewport sync convergence both directions; `npm test`; commit `feat: MapLibre engine core — local PMTiles dark basemap, camera, sync, markers`.

### Task 2.2: Viewport-sync spec + parity screenshot helper

**Files:**
- Create: `tests-react/viewport-sync.spec.js` (two linked panels: drag one via mouse, assert both `getViewport` converge ≤ epsilon and no oscillation over 1 s settle; run for default engine and `?engine=maplibre`)
- Create: `scripts/map-parity-shot.js` (Playwright script: boots app with panel1=leaflet panel2=maplibre same viewport/layers, screenshots each panel into `output/map-parity/<label>-{leaflet,maplibre}.png`)

**Steps:** spec red→green on both engines; parity shots of basemap+boundaries; eyeball; `npm test`; commit `test: explicit viewport-sync spec (both engines) + parity screenshot helper`.

---

## Phase 3 — Weather overlays on MapLibre (exit: playback parity under stress)

### Task 3.1: ImageSource weather implementation

**Files:**
- Modify: `maplibre-engine.ts` — anchor scaffold (ordered no-op background layers `anchor:weather` → `anchor:labels` inserted after style load, before first basemap symbol layer for `labels`); `setWeatherImage` = `addSource(type:"image", coordinates from GeoBounds)` + raster layer at `anchor:weather` with `raster-fade-duration: 0`, `raster-resampling: opts.pixelated ? "nearest" : "linear"`; `swapWeatherImage` per Phase-0 verdict (direct `updateImage` or double-buffer ping-pong — implement whichever won); `removeWeatherImage` removes layer+source; `onWeatherImageLoaded` via `map.on("data")` filtered `sourceId` + `isSourceLoaded`; `setGroupOpacity("weather", v)` fan-out `raster-opacity = groupV × layerV` (store per-layer base opacity in engine state)

**Steps:** implement; manual: 2 panels leaflet/maplibre same layers, play timeline, visually identical frames incl. pixelated radar; `npm test`; commit `feat: weather raster overlays on MapLibre (ImageSource, anchors, group opacity)`.

### Task 3.2: Playback parity gate

**Steps:** `npm run test:react -- timeline-playback timeline-stress timeline-skip-unloaded hover-card hover-diff` with `?engine=maplibre` forced via spec-level env (add `WX_TEST_ENGINE=maplibre` support in playwright config `use.baseURL` query injection); compare swap timings vs Phase-0 numbers (no regression >2×); parity screenshots with weather active; commit `test: timeline + hover suites green on MapLibre weather path`.

---

## Phase 4 — Vector overlays + native synoptic redesign (exit: owner accepts presentation)

### Task 4.1: Census counties upgrade + line layers on MapLibre

**Files:**
- Modify: `scripts/prepare-map-geodata.js` (counties source → Census `cb_2023_us_county_5m` zip: fetch to `.geodata-cache/`, `mapshaper` clip to CONUS bbox + simplify to keep output <3 MB, emit same `next/public/geo/features/us-counties.geojson`), regenerate + commit output
- Modify: `maplibre-engine.ts` (`setLineLayer`: geojson source + line layer at `style.anchor`, `ZoomCurve` → `["interpolate", ["linear"], ["zoom"], ...]` with compat-zoom stops converted via `compatToNative`; `setGroupOpacity` fan-out gains `line-opacity`; `setBasemapDetail` toggles `layout.visibility` on basemap road/place-label layer id sets; `capabilities.basemapDetail = true`)
- Modify: `next/src/components/map-panel/use-map-feature-layers.ts` (when `engine.capabilities.basemapDetail`: roads/cities toggles call `setBasemapDetail`, app roads/places layers not created; counties/graticule via `setLineLayer` as on leaflet)

**Steps:** pipeline change + regenerate; engine impl; display-menu spec on maplibre variant green; parity shots (boundaries/counties/graticule); `npm test`; commit `feat: census counties + vector detail layers on MapLibre; basemap-owned roads/labels`.

### Task 4.2: Synoptic GeoJSON conversion + native contour lines

**Files:**
- Create: `next/src/components/map-panel/synoptic-geojson.ts` (pure: existing decoded synoptic/contour payloads → `FeatureCollection`s with properties `{ kind: "isobar"|"thickness"|"height", value: number, label: string, emphasis: boolean }` — reuses stitching/smoothing from `synoptic-utils.ts` pure parts, no map argument)
- Modify: `use-synoptic-vector.ts`, `use-contour-vector.ts` (branch: maplibre engine → `setLineLayer` per kind at `anchor:contours`/`anchor:synoptic` with redesigned styling — solid isobars weight 1.2 emphasis 2.0 at 4-hPa intervals, dashed thickness, height contours per existing palette colors; leaflet engine → unchanged hatch path)
- Test: `tests-node/synoptic-geojson.test.js` (fixture payload → feature counts, value/label properties, ring closure)

**Steps:** failing node test on conversion; implement; visual on maplibre panel vs leaflet reference; `npm test`; commit `feat: native GL contour/isobar/thickness line layers (redesigned styling)`.

### Task 4.3: Native symbol layers — contour labels + H/L centers

**Files:**
- Modify: `maplibre-engine.ts` (`setSymbolLayer` per contract: `symbol-placement`, `text-field: ["get", textProperty]`, `symbol-sort-key: ["get", sortKeyProperty]`, halo paint, collision defaults `text-allow-overlap: false`; `setGroupOpacity` fan-out gains `text-opacity`/`icon-opacity`)
- Modify: `synoptic-geojson.ts` (label points: H/L centers FeatureCollection with `{ kind: "high"|"low", value, label, sortKey }`, sortKey = pressure-anomaly magnitude so deeper lows/stronger highs win collisions; isobar labels as `placement:"line"` on the line features)
- Modify: `use-synoptic-vector.ts`, `use-pressure-markers.ts` (maplibre branch → symbol layers; the custom declutter `pickReadableSynopticLabels/-Centers` NOT called on maplibre)
- Create: `output/map-parity/synoptic-cases.md` procedure note + screenshots via `scripts/map-parity-shot.js` for 3 representative cases (zonal flow, deep cyclone, ridge — pick from cached runs)

**Steps:** implement; generate 3-case side-by-sides; **present to owner for the spec §5 acceptance eyeball (bar: reads faster, less clutter, no missing H/L at synoptic zooms; iterate styling per feedback within this task)**; `npm test`; commit `feat: native synoptic labels + H/L centers via GL collision engine`.

### Task 4.4: Interaction parity on MapLibre

**Steps:** run full react suite with `WX_TEST_ENGINE=maplibre` — sounding drawer/compare/liveness, keyboard shortcuts, error-empty-states, responsive; fix engine-specific fallout (focus handling: MapLibre canvas needs `tabindex` parity for the liveness spec); commit `test: full interaction suite green on MapLibre panels`.

**PHASE 4 GATE:** owner accepted synoptic presentation; both engines pass full suite.

---

## Phase 5 — Style polish + offline hardening (exit: offline-boot green)

### Task 5.1: Meteorology style tuning + zoom clamp raise

**AMENDED per spec §8a (owner round 2026-07-08):** two purpose-built styles — LIGHT (new default; colormaps designed for white backgrounds) and dark — both tuned; basemap picker survives on MapLibre (light/dark only).

**Files:**
- Modify: `basemap-style.ts` (buildLightStyle + buildDarkStyle; final POI/landuse strip audit; road hierarchy thin/desaturated; place-label halo width/color tuned per-theme over bright weather via parity shots; state-label size), `next/src/config/display.ts` (default basemap → light), `next/src/config/constants.ts` / view config (max zoom 12 → 14 compat-scale)

**Steps:** tune with weather-active screenshots; owner eyeball via side-by-side artifact; verify z13–14 tiles crisp; `npm test`; commit `feat: dark meteorology basemap tuning + zoom clamp to z14 (compat)`.

### Task 5.2: Offline boot + fallback deletion + topo removal

**Files:**
- Create: `tests-react/offline-boot.spec.js` (Playwright `context.route` blocks non-`localhost`/`127.0.0.1`; app boots on fixture pmtiles (`WX_TEST_BASEMAP=fixture` env → engine uses fixture path); assert basemap canvas paints (non-blank pixel probe), place labels present via `getLayerOrder` containing label layers, no failed requests)
- Delete: `tests-react/basemap-fallback.spec.js`, fallback machinery inside `leaflet-engine.ts` (error counters, OSM layer, 2.2 s timer), `BASEMAP_TOPO`/`BASEMAP_FALLBACK`/label-sandwich constants from `constants.ts`
- Modify: `next/src/config/display.ts` (`DISPLAY_SCHEMA_VERSION` bump; migration maps stored `basemap:"topo"` → `"light"` (new default); `BasemapTheme` narrows to `"light" | "dark"` — AMENDED per spec §8a: light default, picker survives with light/dark), `DisplayMenu.tsx` (topo option removed)

**Steps:** offline spec red→green; deletions; full `npm test` + `npm run test:react`; commit `feat: offline-boot guarantee; delete online fallback + topo basemap`.

---

## Phase 6 — Cutover + Leaflet deletion (exit: analyst-ready, Leaflet gone)

### Task 6.1: Default flip

**Files:** panel state default → `"maplibre"`; `WX_TEST_ENGINE` default maplibre; leaflet spec variants removed.

**Steps:** flip; full `npm test` + `npm run test:react` green; commit `feat: MapLibre is the default map engine`.

### Task 6.2: Native zoom conversion + persisted-state migration

**Files:**
- Modify: `maplibre-engine.ts` (compat shims removed — `getZoom` returns native; `zoom-compat.ts` deleted), every compat-zoom consumer converted −1: `VIEW_CONFIG` zooms, `AUTO_BOUNDARY_STATE_MAX_ZOOM`, `getZoomBucketId` buckets, `resolveCenterVisual` sizing, `ZoomCurve` stops in `use-map-feature-layers.ts`/`use-map-display-layers.ts`/synoptic styles, spike/docs references
- Modify: `next/src/config/session.ts` (storage key → `modelview.session.v2`; loader reads v1, converts viewport zooms −1, writes v2), `next/src/core/url-state.ts` (writer emits `&zs=2`; reader: `zs=2` → native, absent → legacy −1 conversion)
- Test: `tests-node` or react spec `url-state`/`session-persistence` extensions covering both migration directions

**Steps:** checklist-driven conversion (grep every consumer listed in spec §9); migration tests red→green; full suites; manual permalink round-trip old + new; commit `feat: native MapLibre zoom semantics + viewport persistence migration`.

### Task 6.3: Delete Leaflet

**Files:**
- Delete: `leaflet-engine.ts`, `getLeafletMap` from contract + all hatch branches (`use-synoptic-vector.ts`/`use-contour-vector.ts`/`use-pressure-markers.ts` leaflet paths, `pickReadableSynopticLabels/-Centers` + placement math in `synoptic-render.ts` now unused, `canvas-renderer.ts`, `map-layer-utils.ts` pane logic, `synoptic-utils.ts` leaflet-coupled culling), `config/layers.ts` pane/z tables, `.leaflet-*` CSS in `index.css`, `next/src/spike/`, app roads/places layer code + `next/public/geo/features/na-roads-major.geojson` + `na-places.json` + their `prepare-map-geodata.js` sections + `MAX_PLACE_LABELS`
- Modify: `package.json` (remove `leaflet`, `@types/leaflet`), eslint rule tightened repo-wide (no exceptions)

**Steps:** delete; typecheck drives the cleanup; full suites green; `npm run maintainability:report` sanity; note public-mirror playbook impact (geo outputs removed) in `docs/superpowers/specs/2026-07-06-public-repo-sync-design.md` addendum; commit `feat!: remove Leaflet — MapLibre is the only map engine`.

### Task 6.4: Final gate — live drive + docs

**Steps:**
- `npm test` + `npm run test:react` full, zero skips.
- Live drive against the real artifact cache (dev server + artifact server): 4-panel linked pan/zoom at z4→z14, playback 1×–4× with 3 layers/panel, hover Δ cross-panel, double-click soundings + compare + export, synoptic overlay all cases, permalink round-trip, session restore, offline boot (Wi-Fi off), cache panel ops, render queue smoke (dry).
- `webglcontextlost` drill: force context loss via `WEBGL_lose_context` in console; panel recovers.
- Layout churn drill: add/remove panels ×10; `chrome://gpu` context count stable.
- Update `README.md` (basemap setup section: `brew install pmtiles`, `npm run basemap:fetch`), `plan.md` (migration decision log), memory.
- Commit `docs: maplibre migration complete — setup + verification notes`; push branch; open PR per repo convention.

---

## Self-review checklist (author-run)

- Spec coverage: §1 end-state ↔ Tasks 2.1/4.1/5.2/6.3; §2 interface ↔ contract block + 1.x; §3 weather ↔ 0.3/3.x; §4 camera/zoom ↔ 1.1/2.1/6.2; §5 synoptic redesign ↔ 4.2/4.3 (owner-eyeball step embedded); §6 errors ↔ 0.1/2.1 (416, missing-file state, contextlost); §7 testing ↔ 1.5/2.2/3.2/4.4/5.2/6.4; §8 phases ↔ gates. No gaps found.
- Placeholders: none — every task names exact files, routes, types, commands.
- Type consistency: engine method/type names match the contract block everywhere (checked: `GeoBounds` not `Bounds`, `onWeatherImageLoaded`, `setBasemapDetail`, `ZoomCurve` stops compat-scale until 6.2).
