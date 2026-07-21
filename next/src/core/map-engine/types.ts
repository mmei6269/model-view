// Shared MapEngine contract. One implementation (MapLibre) lives behind it —
// the seam survives the Leaflet deletion (Task 6.3) as the containment
// boundary for map-library churn (e.g. a maplibre-gl major bump). App code
// codes against these exact names; the factory (`createMapEngine`) lives in
// ./index.ts.
export type LatLon = { lat: number; lon: number };
export type GeoBounds = { south: number; west: number; north: number; east: number };
export type PointPx = { x: number; y: number };
export type EngineEventName = "move" | "moveend" | "zoomend" | "dblclick" | "mousemove" | "mouseout";
export type EngineEvent = { latlon?: LatLon; meta?: EventMeta };
export type EventMeta = { wxSync?: boolean };
export type OpacityGroup = "weather" | "synoptic" | "labels" | "boundaries";
// "centers" (Task 4.3 owner round) is the TOP band: it renders above the
// basemap symbol stack, so its symbols place first in MapLibre's top-down
// collision pass and can never be suppressed by basemap city labels — H/L
// pressure centers only ("no missing centers, ever", spec §8a.3).
export type AnchorId = "weather" | "graticule" | "reference" | "contours" | "synoptic" | "labels" | "centers";
export type ZoomCurve = Array<[zoom: number, value: number]>; // piecewise-linear, NATIVE maplibre zoom domain (Task 6.2)
export type BasemapTheme = "dark" | "light"; // topo removed app-wide in Task 5.2 (light is the app default, spec §8a.1)
// Fatal engine failure, classed so the panel can key its banner headline on
// what actually broke (Task 5.2): "basemap" = the local PMTiles basemap never
// loaded (file missing / artifact server down — fix: npm run basemap:fetch);
// "context-loss" = repeated WebGL context loss exhausted the engine's
// self-healing recreates (a GPU/driver problem, not a data problem);
// "webgl-init" (Task 6.1) = the GL map constructor threw because no WebGL
// context could be created at all (WebGL disabled/blocklisted — a browser or
// GPU setting, not a data problem).
export type EngineFatal = { kind: "basemap" | "context-loss" | "webgl-init"; message: string };
export interface MarkerHandle {
  setLatLon(p: LatLon): void;
  setOpacity(v: number): void;
  remove(): void;
}
// Presentation of the basemap's OWN admin-boundary line layers (Display
// border modes, owner decision 2026-07-09: one border source at a time —
// these lines show ONLY in border mode "basemap"). widthScale multiplies the
// generated style's original line-widths; color null keeps the theme default
// line-color (the flavor's per-theme boundary ink).
export interface BasemapBoundaryStyle {
  visible: boolean;
  widthScale: number;
  color: string | null;
}
// Optional MapLibre expression used to select features from a shared GeoJSON
// source. The common engine contract deliberately keeps this structural: app
// callers build ordinary expression arrays while the MapLibre implementation
// narrows them to its FilterSpecification type at the library boundary.
export type GeoJsonSourceFilter = unknown[];
export interface LineLayerStyle {
  color: string;
  weight: number;
  opacity: number | ZoomCurve;
  dashArray?: number[];
  group: OpacityGroup;
  anchor: AnchorId;
  // Layers in the same family share one GeoJSON source. Every member must be
  // set with the same FeatureCollection reference for a frame; sourceFilter
  // selects the member's style class without duplicating/parsing geometry.
  sourceFamily?: string;
  sourceFilter?: GeoJsonSourceFilter;
}
export interface SymbolLayerStyle {
  // Phase 4, maplibre-only
  textProperty: string;
  textSize: number | ZoomCurve;
  color: string;
  haloColor: string;
  haloWidth: number;
  sortKeyProperty?: string;
  placement: "point" | "line";
  group: OpacityGroup;
  anchor: AnchorId;
  // Same source-sharing contract as LineLayerStyle. A family may span line
  // and symbol layers (for example, contour strokes plus their labels).
  sourceFamily?: string;
  sourceFilter?: GeoJsonSourceFilter;
  // Task 4.3 extensions (mirrored in engine-contract.md):
  // Base text opacity (default 1); applied text-opacity = group x this, the
  // same group-factor semantics as LineLayerStyle.opacity. Plain number ONLY
  // (unlike line opacity): a zoom-faded label is the paint-side twin of the
  // zoom-gating trap documented at minZoom below — near-zero text-opacity
  // still claims collision space — so curves are banned at the type level;
  // zoom gates belong to minZoom. No app caller ever passed a curve here.
  opacity?: number;
  // Second text line rendered beneath the primary (e.g. the pressure value
  // under an H/L glyph), scaled by secondaryTextScale (default 0.5) relative
  // to textSize. Compiles to a ["format", ...] text-field; the two lines
  // share one collision box, so glyph+value place or drop together.
  secondaryTextProperty?: string;
  secondaryTextScale?: number;
  // Minimum px between repeated labels along one line (symbol-spacing;
  // placement:"line" only). Engine default 250 when omitted.
  repeatSpacing?: number;
  // Task 4.3 owner round: zoom gate as a LAYER property (native zoom domain
  // since Task 6.2 — applied directly as the maplibre layer minzoom).
  // Zoom-gating labels via paint opacity is FORBIDDEN — text-opacity:0 labels
  // still claim collision space (MapLibre collision ignores paint), silently
  // suppressing visible labels beneath them; a layer-level minzoom removes
  // the phantom boxes entirely. Omitted = no gate.
  minZoom?: number;
}
// TEST-ONLY introspection snapshot consumed by the window.__wx bridge
// (test-bridge.ts). Read-only; app code must never call __introspect().
export interface EngineIntrospection {
  // Active weather image keys, in the caller's stacking order.
  weatherLayers: string[];
  // Weather keys whose CURRENTLY-SET url has fired its load event — the same
  // event that drives onWeatherImageLoaded/markFrameLayerLoaded (timeline chips).
  loadedWeatherLayers: string[];
  // Every engine-known renderable layer id (weather + line + symbol), bottom
  // to top in applied render order.
  layerOrder: string[];
  // Applied opacity per group, as last set via setGroupOpacity (1 if never set).
  groupOpacity: Record<OpacityGroup, number>;
  // APPLIED raw-pixel (nearest-neighbor) rendering per weather key: the live
  // raster-resampling paint value read back from the map, not stored options.
  weatherPixelated: Record<string, boolean>;
  // Resolved opacity per line layer id (ZoomCurve styles evaluated at the
  // current native zoom).
  lineLayerOpacity: Record<string, number>;
  // Feature count per live symbol layer id (from the layer's current
  // FeatureCollection).
  symbolFeatureCounts: Record<string, number>;
  // Basemap-owned label (symbol) layers present in the LIVE style with
  // visibility "visible" — the offline-boot spec's honest "place labels
  // exist" signal (basemap layers are deliberately excluded from layerOrder,
  // which tracks app layers only). (Task 5.2 bridge extension.)
  basemapLabelLayers: string[];
  // Basemap-owned admin boundary (line) layers present in the LIVE style
  // with visibility "visible" — the exclusive-border-modes signal (Map QA
  // E3): empty in border modes auto/reference/off, the full boundary id set
  // in mode "basemap". Same applied-layout read-back discipline as
  // basemapLabelLayers.
  basemapBoundaryLayers: string[];
}
export interface MapEngine {
  readonly kind: "maplibre";
  create(
    host: HTMLElement,
    opts: { center: LatLon; zoom: number; maxBounds: GeoBounds; minZoom: number; maxZoom: number },
  ): void;
  destroy(): void;
  getCenter(): LatLon;
  getZoom(): number;
  getSize(): PointPx;
  jumpTo(v: { center: LatLon; zoom: number }, meta?: EventMeta): void;
  fitBounds(b: GeoBounds, opts?: { padding?: number }): void;
  setMaxBounds(b: GeoBounds): void;
  setMinZoom(z: number): void;
  setMaxZoom(z: number): void;
  project(p: LatLon): PointPx;
  unproject(pt: PointPx): LatLon;
  on(ev: EngineEventName, fn: (e: EngineEvent) => void): () => void;
  setBasemap(opts: { theme: BasemapTheme; labels: boolean }): void;
  // Roads/cities Display toggles: the vector basemap renders roads and place
  // labels itself, so the app hands the flags to the engine instead of
  // drawing its own feature layers (decision #5 of the migration).
  setBasemapDetail(opts: { roads: boolean; cities: boolean }): void;
  // Border-mode policy hook: the vector basemap draws its own admin boundary
  // lines, so the app hands their presentation (visibility, width scale,
  // color override) to the engine instead of filtering the style — same
  // division of labor as setBasemapDetail. Stored state survives theme
  // switches and context-loss recreates.
  setBasemapBoundaries(style: BasemapBoundaryStyle): void;
  setWeatherImage(key: string, url: string, bounds: GeoBounds, opts: { opacity: number; pixelated: boolean }): void;
  swapWeatherImage(key: string, url: string): void;
  removeWeatherImage(key: string): void;
  onWeatherImageLoaded(key: string, fn: () => void): () => void;
  setLineLayer(id: string, data: GeoJSON.FeatureCollection, style: LineLayerStyle): void;
  setSymbolLayer(id: string, data: GeoJSON.FeatureCollection, style: SymbolLayerStyle): void;
  removeLayer(id: string): void;
  setGroupOpacity(group: OpacityGroup, v: number): void;
  addMarker(el: HTMLElement, p: LatLon, opts?: { interactive?: boolean }): MarkerHandle;
  // OPTIONAL fatal-failure channel. Engines whose basemap can fail hard at
  // boot (maplibre: local PMTiles file missing / artifact server down /
  // repeated WebGL context loss / WebGL unavailable at create) report a
  // classed EngineFatal here and MapPanel renders it as an in-panel error
  // state; `null` means a previously reported fatal RECOVERED (Task 5.2: a
  // transient boot failure clears when the basemap source later loads — no
  // remount needed). Engines that always degrade gracefully do not implement
  // it. Boot-time fatals can fire synchronously inside create() — subscribers
  // that attach after create() still receive the last fatal on subscribe
  // (never swallowed), but create() may ALSO throw for them (see the
  // constructor wrap in maplibre-engine.createMap), so callers must wrap
  // create() and stop their boot flow on throw.
  onFatal?(fn: (fatal: EngineFatal | null) => void): () => void;
  __introspect(): EngineIntrospection; // TEST-ONLY — window.__wx bridge; never app code
}
