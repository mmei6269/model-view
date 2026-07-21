import maplibregl, {
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
  type ImageSource,
  type LineLayerSpecification,
  type Map as MapLibreMap,
  type StyleSpecification,
  type SymbolLayerSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { DEFAULT_DISPLAY_SETTINGS } from "../../config/display";
import {
  COUNTRY_BORDERS_BAND_RANK,
  COUNTRY_BOUNDARY_LINE_LAYER_ID,
  COUNTY_LINE_LAYER_ID,
  COUNTY_LINES_BAND_RANK,
  GRATICULE_BAND_RANK,
  GRATICULE_LINE_LAYER_ID,
  STATE_BORDERS_BAND_RANK,
  STATE_BOUNDARY_LINE_LAYER_ID,
} from "../../config/layers";
import { getAbsoluteArtifactBaseUrl } from "../artifact-url";
import {
  BASEMAP_SOURCE_ID,
  basemapBoundaryLayerIds,
  basemapLabelLayerIds,
  basemapPlaceLabelLayerIds,
  basemapRoadLayerIds,
  buildDarkStyle,
  buildLightStyle,
  verifyThemeLayerIdParity,
} from "./basemap-style";
import { ensurePmtilesProtocol, resetPmtilesArchive } from "./pmtiles-protocol";
import {
  countFilteredGeoJsonFeatures,
  SharedGeoJsonSourceRegistry,
  type SharedGeoJsonSourceHost,
} from "./shared-geojson-source";
import { evalZoomCurve, normalizedZoomStops } from "./zoom-curve";
import type {
  AnchorId,
  BasemapBoundaryStyle,
  BasemapTheme,
  EngineEvent,
  EngineEventName,
  EngineFatal,
  EngineIntrospection,
  EventMeta,
  GeoBounds,
  GeoJsonSourceFilter,
  LatLon,
  LineLayerStyle,
  MapEngine,
  MarkerHandle,
  OpacityGroup,
  PointPx,
  SymbolLayerStyle,
  ZoomCurve,
} from "./types";

// WebGL context loss self-healing: destroy/recreate the map preserving the
// camera, at most this many times per engine lifetime. A machine that keeps
// losing contexts (GPU reset loop, too many live contexts) gets the in-panel
// fatal state instead of an infinite recreate loop.
const MAX_CONTEXT_LOSS_RECREATES = 2;

// GeoBounds is {south, west, north, east}; MapLibre wants [[west, south],
// [east, north]] (lng-first!). This lon/lat order flip is THE classic bug —
// keep every conversion in this one helper.
//
// Full-world guard (verified against maplibre-gl 5.24.0 in this app): a
// bounds whose longitude span is exactly 360° ([-180, 180], the app's
// WORLD_BOUNDS) makes the constrain math produce a singular view-projection
// matrix — gl-matrix invert() returns null and the Map constructor throws
// "Cannot read properties of null (reading '0')". A span shrunk by any
// epsilon is fine (±179° verified OK), so shave a hair off each end; 0.001°
// is ~100 m at the antimeridian, unobservable at our zooms.
const FULL_WORLD_LNG_EPSILON = 0.001;

function toLngLatBounds(b: GeoBounds): [[number, number], [number, number]] {
  let west = b.west;
  let east = b.east;
  if (east - west >= 360) {
    west += FULL_WORLD_LNG_EPSILON;
    east -= FULL_WORLD_LNG_EPSILON;
  }
  return [
    [west, b.south],
    [east, b.north],
  ];
}

// ImageSource corner coordinates: [lng, lat] pairs starting at the TOP-LEFT
// corner and proceeding CLOCKWISE — TL, TR, BR, BL (maplibre's
// ImageSource.setCoordinates contract). Same lon/lat-order trap as
// toLngLatBounds; keep the conversion in this one helper.
function toImageCoordinates(b: GeoBounds): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [b.west, b.north],
    [b.east, b.north],
    [b.east, b.south],
    [b.west, b.south],
  ];
}

// Anchor scaffold (engine contract): ordered no-op placeholder layers
// inserted after style load, ALL sitting just before the first basemap
// symbol layer — so every app band, weather included, renders below the
// basemap's place labels (the design's core stacking guarantee). A layer
// inserted "at" an anchor uses the NEXT anchor's id as beforeId: it lands at
// the top of its own band, so same-anchor layers stack in call order
// (later = on top within the band).
//
// The "centers" anchor is NOT in this list: it is the top band, ABOVE the
// entire basemap symbol stack (layers append with no beforeId, so it needs
// no placeholder). H/L pressure centers live there so they place FIRST in
// MapLibre's top-down collision pass — a basemap city label can then never
// suppress a center; the city label is the one that loses the contested
// space (spec §8a.3 "no missing centers, ever").
const ANCHOR_ORDER: AnchorId[] = ["weather", "graticule", "reference", "contours", "synoptic", "labels"];

function anchorLayerId(anchor: AnchorId): string {
  return `anchor:${anchor}`;
}

// Weather image source/layer ids share one prefixed namespace so the
// sourcedata handler can route load events without a registry lookup per
// basemap event. The bare key (== the caller's LayerKey) is what introspection
// reports; the prefix never leaks outside this engine.
const WEATHER_SOURCE_PREFIX = "wx-weather:";

function weatherSourceId(key: string): string {
  return `${WEATHER_SOURCE_PREFIX}${key}`;
}

// Line source/layer ids share one prefixed namespace (same scheme as the
// weather prefix above): the bare caller id is what introspection reports;
// the prefix keeps app line layers from ever colliding with basemap or
// anchor layer ids.
const LINE_SOURCE_PREFIX = "wx-line:";

function lineSourceId(id: string): string {
  return `${LINE_SOURCE_PREFIX}${id}`;
}

// Symbol source/layer ids: third prefixed namespace, same scheme as weather/
// line ids above.
const SYMBOL_SOURCE_PREFIX = "wx-symbol:";

function symbolSourceId(id: string): string {
  return `${SYMBOL_SOURCE_PREFIX}${id}`;
}

function lineSharedSourceMemberId(id: string): string {
  return `line:${id}`;
}

function symbolSharedSourceMemberId(id: string): string {
  return `symbol:${id}`;
}

function sharedGeoJsonSourceHost(map: MapLibreMap): SharedGeoJsonSourceHost {
  return {
    addSource: (id, data) => map.addSource(id, { type: "geojson", data }),
    setData: (id, data) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data),
    removeSource: (id) => map.removeSource(id),
  };
}

function maplibreFilter(filter: GeoJsonSourceFilter | undefined): FilterSpecification | undefined {
  return filter as FilterSpecification | undefined;
}

// Map-navigation keys MapLibre's KeyboardHandler owns (arrows pan; =/+ and
// -/_ zoom; shift+arrows are its rotation/pitch bindings, disabled in this
// 2D app). See the keydown guard in create() for why these must not bubble
// past the map host.
const MAP_NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "_"]);

// All app symbol text renders in the vendored Medium stack
// (next/public/basemap/fonts/): synoptic values and H/L glyphs need the
// weight to survive bright reflectivity/CAPE fills, and one stack keeps the
// glyph atlas small. Basic Latin + digits — everything the app's labels use —
// are covered by the vendored ranges (verified live in Task 4.3).
const SYMBOL_TEXT_FONT = ["Noto Sans Medium"];

// Within-band stacking rank per known line-layer id, so band-mates stack
// identically no matter which fetch resolves first (graticule < counties in
// the detail band; state < country in the reference band). Ids without a
// rank stack at the band top in call order, per the anchor-band contract.
// The anchor still decides the BAND; the rank only orders layers within it.
const LINE_LAYER_BAND_RANK: Record<string, number> = {
  [GRATICULE_LINE_LAYER_ID]: GRATICULE_BAND_RANK,
  [COUNTY_LINE_LAYER_ID]: COUNTY_LINES_BAND_RANK,
  [STATE_BOUNDARY_LINE_LAYER_ID]: STATE_BORDERS_BAND_RANK,
  [COUNTRY_BOUNDARY_LINE_LAYER_ID]: COUNTRY_BORDERS_BAND_RANK,
};

// GeoJSON line-layer registry entry. `data` is kept for identity comparison
// (setLineLayer with the same collection restyles in place, leaflet parity);
// `added` is false while the style is still loading and across a context-loss
// recreate, until flushLineLayers re-adds the layer.
interface LineLayerEntry {
  data: GeoJSON.FeatureCollection;
  style: LineLayerStyle;
  added: boolean;
}

// GeoJSON symbol-layer registry entry; same lifecycle semantics as
// LineLayerEntry (identity-compared data, `added` false until flushed).
interface SymbolLayerEntry {
  data: GeoJSON.FeatureCollection;
  style: SymbolLayerStyle;
  added: boolean;
}

// Weather raster registry entry. Registry iteration order == the caller's
// stacking order (setWeatherImage re-appends its key on every call), exactly
// like the leaflet engine's overlay registry.
interface WeatherEntry {
  url: string;
  bounds: GeoBounds;
  // Per-layer base opacity; the applied raster-opacity is always
  // groupOpacity × base (see appliedWeatherOpacity).
  opacity: number;
  // Creation-time, like the leaflet engine's pixelated className: frame
  // passes never re-apply it (RAW_PIXEL_MODE is a build-wide constant).
  pixelated: boolean;
  // Load-signal bookkeeping: generation bumps on every URL (re)set;
  // pendingGeneration is the generation still awaiting its load event (null
  // once dispatched). See handleWeatherSourceData for the full design.
  generation: number;
  pendingGeneration: number | null;
  // Source + layer exist on the live map. False while the style is still
  // loading and across a context-loss recreate, until flushWeatherLayers
  // re-adds them.
  added: boolean;
}

// Camera/config snapshot in NATIVE maplibre units, used by create() and by
// the context-loss recreate path (which must preserve whatever the app set
// after create, e.g. per-view setMaxBounds/setMinZoom).
interface NativeMapConfig {
  center: [number, number];
  zoom: number;
  minZoom: number;
  maxZoom: number;
  maxBounds: maplibregl.LngLatBoundsLike;
}

export class MapLibreEngine implements MapEngine {
  readonly kind = "maplibre" as const;

  private map: MapLibreMap | null = null;
  private host: HTMLElement | null = null;
  // Host-level keydown guard (keyboard parity, see create()); removed on
  // destroy so a dead engine never intercepts keys for a reused host.
  private hostKeydownGuard: ((event: KeyboardEvent) => void) | null = null;
  private listeners = new Map<EngineEventName, Set<(event: EngineEvent) => void>>();
  private fatalListeners = new Set<(fatal: EngineFatal | null) => void>();
  private lastFatal: EngineFatal | null = null;
  // One armed basemap-retry gesture listener at a time (see armBasemapRetry).
  private basemapRetryPending = false;
  private markers = new Set<maplibregl.Marker>();
  // Stored group opacities. "weather"/"synoptic" fan out to the weather
  // raster layers (raster-opacity = group × per-layer base); "labels" fans
  // onto the basemap symbol layers' text/icon-opacity (the labels "band" on
  // maplibre IS the basemap symbol stack); every group also fans onto the
  // line layers riding it (line-opacity = group × style opacity/curve).
  private groupOpacity: Record<OpacityGroup, number> = { weather: 1, synoptic: 1, labels: 1, boundaries: 1 };
  // GeoJSON line layers keyed by caller id (reference boundaries + the
  // graticule/roads/counties detail band; contours/synoptic lines join in
  // Tasks 4.2/4.3).
  private lineLayers = new Map<string, LineLayerEntry>();
  // GeoJSON symbol layers keyed by caller id (synoptic value labels, H/L
  // pressure centers, contour labels — Task 4.3).
  private symbolLayers = new Map<string, SymbolLayerEntry>();
  // Optional shared-family sources back multiple filtered line/symbol
  // layers. The registry owns reference counting and one-setData-per-frame
  // identity semantics across both layer kinds.
  private sharedGeoJsonSources = new SharedGeoJsonSourceRegistry();
  // Weather raster registry; iteration order == caller stacking order.
  private weatherEntries = new Map<string, WeatherEntry>();
  private weatherLoadListeners = new Map<string, Set<() => void>>();
  // TEST-ONLY bookkeeping for __introspect(): keys whose currently-set URL
  // has fired its load event (same source event that drives
  // onWeatherImageLoaded/markFrameLayerLoaded, so the bridge's
  // isWeatherLoaded matches the timeline chips' load source).
  private loadedWeatherKeys = new Set<string>();
  // Non-synoptic weather keys in APPLIED style order within the weather band
  // (bottom -> top); syncWeatherBandOrder keeps it matching registry order.
  private appliedWeatherOrder: string[] = [];
  // One order sync is scheduled per synchronous set-pass; see
  // scheduleWeatherBandOrderSync.
  private weatherOrderSyncScheduled = false;
  private labelsVisible = true;
  // Basemap detail flags (the Display roads/cities toggles). Initial values
  // follow the app's display defaults so the window between style load and
  // the feature hook's first setBasemapDetail call already renders the
  // default look (and a panel that never calls it matches the app default).
  private detailRoads = DEFAULT_DISPLAY_SETTINGS.features.roads;
  private detailCities = DEFAULT_DISPLAY_SETTINGS.features.cities;
  // Basemap boundary-line presentation (Display border modes). Initial value
  // is the generated style's own stock look (visible, unscaled, theme color)
  // so a panel that never calls the verb renders the unmodified basemap.
  private basemapBoundaries: BasemapBoundaryStyle = { visible: true, widthScale: 1, color: null };
  // Active basemap theme. Initial value follows the app's display default
  // (same rationale as the detail flags above: the style built at create()
  // already renders the default look); setBasemap swaps styles on change.
  private theme: BasemapTheme = DEFAULT_DISPLAY_SETTINGS.basemap;
  private labelLayerIds: string[] = [];
  private roadLayerIds: string[] = [];
  private placeLabelLayerIds: string[] = [];
  private boundaryLayerIds: string[] = [];
  // ORIGINAL line-width/line-color per boundary layer, captured off the
  // generated style spec BEFORE any user scaling (theme-independent plain
  // 0.7/0.4 widths, theme-dependent colors — pinned by the basemap-style
  // snapshot suite), so widthScale always multiplies the true base across
  // repeated applies and color:null restores the theme default.
  private boundaryLayerBase = new Map<string, { width: number; color: unknown }>();
  // "load" fired for the current map — style mutations (setLayoutProperty)
  // throw before that.
  private styleReady = false;
  // First full load of the current map completed. Distinguishes the initial
  // "load"-driven flush from theme-switch "style.load" flushes (style.load
  // also fires during the initial load, before "load").
  private initialLoadComplete = false;
  private basemapSourceLoaded = false;
  private contextLossCount = 0;
  // Terminal give-up state (context-loss recreate budget exhausted, or the
  // recreate's own Map constructor throw): the dead map is disposed, but the
  // engine object stays owned by the panel's live effects, marker handles,
  // and the App-level viewport sync until unmount — MapPanel keeps mapReady
  // true under the fatal banner, so all of them keep calling in. Every verb
  // must silently no-op in this state (never throw into a live React
  // effect/cleanup: one dead panel must never escalate into an
  // error-boundary crash), while pre-create/post-destroy misuse keeps
  // throwing loudly through requireMap. Below-cap recreates never set this,
  // so transient-fatal recovery is untouched.
  private gaveUp = false;
  // The give-up warning fires once per engine, not per ignored call: the
  // banner already names the failure and per-render hook traffic would
  // flood the console.
  private gaveUpWarned = false;
  // Camera frozen at give-up time (plain JS state — readable after the GL
  // context died). getCenter/getZoom must keep answering: viewport sync
  // reads BOTH on every registered panel, dead ones included, before
  // deciding to jump.
  private frozenCamera: { center: LatLon; zoom: number } | null = null;

  create(
    host: HTMLElement,
    opts: { center: LatLon; zoom: number; maxBounds: GeoBounds; minZoom: number; maxZoom: number },
  ): void {
    if (this.map) {
      throw new Error("MapEngine.create: this engine already owns a live map.");
    }
    // Terminal give-up state is per-MAP-lifecycle, not per-engine-object: a
    // create() after a give-up (the dead map is already disposed, so the
    // guard above passes) boots a fresh map that must not inherit the no-op
    // verb surface or the frozen camera.
    this.gaveUp = false;
    this.gaveUpWarned = false;
    this.frozenCamera = null;
    // The recreate budget is part of the same lifecycle: without this reset a
    // create() after a give-up would start with an exhausted budget and its
    // first context loss would re-give-up instead of earning fresh recreates.
    // (recreateAfterContextLoss goes through createMap, not create(), so the
    // cap still binds within one map lifecycle.)
    this.contextLossCount = 0;
    this.host = host;
    // Map-focused keyboard containment (Task 4.4): a focused map must
    // consume arrow/zoom keys — they pan/zoom the map and never reach the
    // app's window-level shortcuts. MapLibre's KeyboardHandler
    // preventDefaults but lets the event bubble, so a focused canvas would
    // BOTH pan the map AND step the app timeline on ArrowRight without this
    // guard. Swallow the map-navigation key set at the host boundary —
    // the bubble path is canvas (focus target) -> canvas container
    // (MapLibre's handler) -> host (this guard) -> window (app shortcuts),
    // so the map still navigates and only the leak is cut. Shift+arrows are
    // included: they are MapLibre's rotation/pitch bindings, which this 2D
    // app disables (disableRotation below) — swallowing keeps them from
    // reaching app shortcuts as bare arrows either. Attached once per
    // engine lifetime (survives the context-loss recreate, which reuses the
    // host); removed in destroy().
    const keydownGuard = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (MAP_NAV_KEYS.has(event.key)) {
        event.stopPropagation();
      }
    };
    host.addEventListener("keydown", keydownGuard);
    this.hostKeydownGuard = keydownGuard;
    // Native MapLibre zoom straight through (Task 6.2): the app speaks the
    // engine's own zoom unit everywhere — the Phase 1–5 compat-zoom shim
    // (legacy leaflet scale = native + 1) is gone.
    this.createMap({
      center: [opts.center.lon, opts.center.lat],
      zoom: opts.zoom,
      minZoom: opts.minZoom,
      maxZoom: opts.maxZoom,
      maxBounds: toLngLatBounds(opts.maxBounds),
    });
  }

  destroy(): void {
    // map.remove() is mandatory: it frees the WebGL context (browsers cap
    // live contexts; leaking one per panel remount kills the whole grid).
    this.map?.remove();
    this.map = null;
    if (this.host && this.hostKeydownGuard) {
      this.host.removeEventListener("keydown", this.hostKeydownGuard);
    }
    this.hostKeydownGuard = null;
    this.host = null;
    this.listeners.clear();
    this.fatalListeners.clear();
    this.markers.clear();
    this.weatherEntries.clear();
    this.weatherLoadListeners.clear();
    this.loadedWeatherKeys.clear();
    this.appliedWeatherOrder = [];
    this.lineLayers.clear();
    this.symbolLayers.clear();
    this.sharedGeoJsonSources.clear();
    this.lastFatal = null;
    this.basemapRetryPending = false;
    this.styleReady = false;
    this.initialLoadComplete = false;
    this.basemapSourceLoaded = false;
    this.contextLossCount = 0;
    this.gaveUp = false;
    this.gaveUpWarned = false;
    this.frozenCamera = null;
  }

  getCenter(): LatLon {
    if (this.gaveUp && this.frozenCamera) {
      return this.frozenCamera.center;
    }
    const center = this.requireMap("getCenter").getCenter();
    return { lat: center.lat, lon: center.lng };
  }

  // Native MapLibre zoom (512px tiles) — the app-wide zoom unit since
  // Task 6.2. No conversion: this engine's zoom IS the contract's zoom.
  getZoom(): number {
    if (this.gaveUp && this.frozenCamera) {
      return this.frozenCamera.zoom;
    }
    return this.requireMap("getZoom").getZoom();
  }

  getSize(): PointPx {
    const container = this.requireMap("getSize").getContainer();
    return { x: container.clientWidth, y: container.clientHeight };
  }

  jumpTo(v: { center: LatLon; zoom: number }, meta?: EventMeta): void {
    if (this.ignoredAfterGiveUp("jumpTo")) {
      return;
    }
    const map = this.requireMap("jumpTo");
    // MapLibre carries eventData natively: the meta rides the resulting
    // move/moveend/zoomend events as `wxMeta` and the handlers below surface
    // it as EngineEvent.meta — no leaflet-style time-window heuristic here.
    map.jumpTo({ center: [v.center.lon, v.center.lat], zoom: v.zoom }, meta ? { wxMeta: meta } : undefined);
  }

  fitBounds(b: GeoBounds, opts?: { padding?: number }): void {
    if (this.ignoredAfterGiveUp("fitBounds")) {
      return;
    }
    const map = this.requireMap("fitBounds");
    // cameraForBounds + jumpTo == fitBounds with animate:false semantics
    // (no easing frames, matching the leaflet engine's fitBounds).
    const camera = map.cameraForBounds(toLngLatBounds(b), { padding: opts?.padding ?? 0 });
    if (camera) {
      map.jumpTo(camera);
    }
  }

  setMaxBounds(b: GeoBounds): void {
    if (this.ignoredAfterGiveUp("setMaxBounds")) {
      return;
    }
    this.requireMap("setMaxBounds").setMaxBounds(toLngLatBounds(b));
  }

  setMinZoom(z: number): void {
    if (this.ignoredAfterGiveUp("setMinZoom")) {
      return;
    }
    this.requireMap("setMinZoom").setMinZoom(z);
  }

  setMaxZoom(z: number): void {
    if (this.ignoredAfterGiveUp("setMaxZoom")) {
      return;
    }
    this.requireMap("setMaxZoom").setMaxZoom(z);
  }

  project(p: LatLon): PointPx {
    const point = this.requireMap("project").project([p.lon, p.lat]);
    return { x: point.x, y: point.y };
  }

  unproject(pt: PointPx): LatLon {
    const lngLat = this.requireMap("unproject").unproject([pt.x, pt.y]);
    return { lat: lngLat.lat, lon: lngLat.lng };
  }

  on(ev: EngineEventName, fn: (e: EngineEvent) => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) {
      set = new Set();
      this.listeners.set(ev, set);
    }
    set.add(fn);
    return () => {
      this.listeners.get(ev)?.delete(fn);
    };
  }

  setBasemap(opts: { theme: BasemapTheme; labels: boolean }): void {
    if (this.ignoredAfterGiveUp("setBasemap")) {
      return;
    }
    const map = this.requireMap("setBasemap");
    const themeChanged = opts.theme !== this.theme;
    this.theme = opts.theme;
    this.labelsVisible = opts.labels;
    if (themeChanged) {
      this.switchBasemapTheme(map);
      return;
    }
    this.applyBasemapLayerVisibility();
  }

  // Theme switch == full style swap. setStyle(diff:false) drops every layer
  // and source, so the registries are marked un-added and the same flush
  // machinery the context-loss recreate uses re-applies anchors + weather +
  // line + symbol layers once the new style loads (the persistent
  // "style.load" handler in createMap; the camera, markers, and all stored
  // flags survive — setStyle never touches them). Safe mid-initial-load too:
  // setStyle replaces the in-flight style and the pending "load" handler
  // flushes onto whichever style wins.
  private switchBasemapTheme(map: MapLibreMap): void {
    this.reloadBasemapStyle(map);
  }

  // Full style (re)load: theme switches AND the basemap-fatal retry path
  // (Task 5.2) share it. setStyle(diff:false) drops every layer and source,
  // so the registries are marked un-added and the flush machinery re-applies
  // anchors + weather + line + symbol layers once the style loads.
  private reloadBasemapStyle(map: MapLibreMap): void {
    this.styleReady = false;
    for (const entry of this.weatherEntries.values()) {
      entry.added = false;
    }
    for (const entry of this.lineLayers.values()) {
      entry.added = false;
    }
    for (const entry of this.symbolLayers.values()) {
      entry.added = false;
    }
    this.sharedGeoJsonSources.markUnadded();
    this.appliedWeatherOrder = [];
    // basemapSourceLoaded deliberately survives: it scopes fatal-vs-transient
    // classification of pmtiles errors to the first-ever source load, and the
    // source (URL, local archive) is identical across themes.
    map.setStyle(this.buildThemeStyle() as StyleSpecification, { diff: false });
  }

  // A failed pmtiles source load is terminal inside maplibre — the source
  // never re-requests its header — so a fatal panel would stay stuck even
  // after the artifact server comes back. Re-attempt the whole basemap style
  // on the user's next camera gesture (moveend): success flows through the
  // sourcedata handler above and clears the fatal; failure lands back in
  // handleMapError, which re-arms for the gesture after. One armed listener
  // at a time, no timers.
  private armBasemapRetry(): void {
    const map = this.map;
    if (this.basemapRetryPending || !map) {
      return;
    }
    this.basemapRetryPending = true;
    map.once("moveend", () => {
      this.basemapRetryPending = false;
      if (this.map === map && this.lastFatal?.kind === "basemap") {
        // Bust the shared pmtiles instance first: its header cache pins the
        // FAILED fetch as a rejected promise forever (see resetPmtilesArchive)
        // — without this the reload "retries" against the cache and never
        // touches the recovered server (observed live, Task 5.2 drill).
        resetPmtilesArchive(this.basemapPmtilesUrl());
        this.reloadBasemapStyle(map);
      }
    });
  }

  // The basemap archive URL in plain http(s) form (the style embeds it as
  // pmtiles://<this>; the pmtiles Protocol keys its instance cache on it).
  private basemapPmtilesUrl(): string {
    return `${getAbsoluteArtifactBaseUrl()}/basemap/na.pmtiles`;
  }

  // Build the active theme's style and (re)derive the basemap layer-id sets
  // every consumer (labels/roads/cities visibility, anchor insertion) reads.
  private buildThemeStyle(): StyleSpecification {
    const pmtilesUrl = this.basemapPmtilesUrl();
    const style = this.theme === "dark" ? buildDarkStyle(pmtilesUrl) : buildLightStyle(pmtilesUrl);
    this.labelLayerIds = basemapLabelLayerIds(style);
    this.roadLayerIds = basemapRoadLayerIds(style);
    this.placeLabelLayerIds = basemapPlaceLabelLayerIds(style);
    this.boundaryLayerIds = basemapBoundaryLayerIds(style);
    this.boundaryLayerBase = new Map();
    for (const layer of style.layers) {
      if (layer.type !== "line" || !this.boundaryLayerIds.includes(layer.id)) {
        continue;
      }
      const width = layer.paint?.["line-width"];
      if (typeof width !== "number") {
        // The generated boundary widths are plain numbers (0.7/0.4, pinned by
        // the basemap-style snapshot suite); an expression here means a flavor
        // bump changed the shape and widthScale can no longer multiply it.
        console.error(`maplibre-engine: boundary layer "${layer.id}" line-width is not a plain number; using 1.`);
      }
      this.boundaryLayerBase.set(layer.id, {
        width: typeof width === "number" ? width : 1,
        color: layer.paint?.["line-color"],
      });
    }
    return style;
  }

  // Roads/cities Display toggles as basemap detail flags: layout.visibility
  // on the generated style's road-network and city-label layer id sets (see
  // basemap-style.ts for what each set governs). Stored flags survive style
  // load and the context-loss recreate — the load handler re-applies them,
  // same as the labels flag.
  setBasemapDetail(opts: { roads: boolean; cities: boolean }): void {
    if (this.ignoredAfterGiveUp("setBasemapDetail")) {
      return;
    }
    this.requireMap("setBasemapDetail");
    this.detailRoads = opts.roads;
    this.detailCities = opts.cities;
    this.applyBasemapLayerVisibility();
  }

  // Basemap boundary-line presentation (Display border modes; owner decision
  // 2026-07-09: one border source at a time — the basemap's own lines show
  // ONLY in border mode "basemap"). Stored style survives style load, theme
  // switches, and the context-loss recreate — the load handler re-applies it,
  // same as the labels/detail flags.
  setBasemapBoundaries(style: BasemapBoundaryStyle): void {
    if (this.ignoredAfterGiveUp("setBasemapBoundaries")) {
      return;
    }
    this.requireMap("setBasemapBoundaries");
    this.basemapBoundaries = style;
    this.applyBasemapBoundaries();
  }

  setWeatherImage(key: string, url: string, bounds: GeoBounds, opts: { opacity: number; pixelated: boolean }): void {
    if (this.ignoredAfterGiveUp("setWeatherImage")) {
      return;
    }
    const map = this.requireMap("setWeatherImage");
    const existing = this.weatherEntries.get(key);
    if (!existing) {
      const entry: WeatherEntry = {
        url,
        bounds,
        opacity: opts.opacity,
        pixelated: opts.pixelated,
        generation: 0,
        pendingGeneration: null,
        added: false,
      };
      this.armWeatherLoad(key, entry);
      this.weatherEntries.set(key, entry);
      // Style still loading (create() returns before maplibre's async style
      // load; the panel hooks start pushing weather immediately): the load
      // handler's flushWeatherLayers applies the registry once mutable.
      if (this.styleReady) {
        this.addWeatherLayer(map, key, entry);
      }
      return;
    }
    // Update path. Re-arm BEFORE the URL is (re)set so the decode that
    // completes for THIS url is the one that marks this generation loaded.
    this.armWeatherLoad(key, existing);
    existing.url = url;
    existing.bounds = bounds;
    existing.opacity = opts.opacity;
    // Re-append so registry order tracks the caller's stacking order.
    this.weatherEntries.delete(key);
    this.weatherEntries.set(key, existing);
    if (existing.added) {
      const source = map.getSource(weatherSourceId(key)) as ImageSource | undefined;
      // Bounds MUST ride the same updateImage call as the url. A separate
      // setCoordinates() while the previous image is still loaded fires a
      // sourcedata event with isSourceLoaded=true and would mark the NEW
      // generation loaded before its decode; updateImage flips the source's
      // loaded() false synchronously before any event can fire.
      source?.updateImage({ url, coordinates: toImageCoordinates(bounds) });
      map.setPaintProperty(weatherSourceId(key), "raster-opacity", this.appliedWeatherOpacity(key, existing));
      this.scheduleWeatherBandOrderSync();
    }
  }

  // Frame advance per the Phase-0 verdict: direct ImageSource.updateImage(),
  // no double-buffering (0.20 ms avg per 12-source swap batch, zero dropped
  // rAF frames; see docs/superpowers/specs/2026-07-07-maplibre-phase0-verdict.md).
  swapWeatherImage(key: string, url: string): void {
    if (this.ignoredAfterGiveUp("swapWeatherImage")) {
      return;
    }
    const map = this.requireMap("swapWeatherImage");
    const entry = this.weatherEntries.get(key);
    if (!entry) {
      // Asymmetry is contract (leaflet parity): remove is idempotent, but a
      // swap on a never-set key is a caller bug.
      throw new Error(`MapEngine.swapWeatherImage: no weather image for key "${key}" (call setWeatherImage first).`);
    }
    this.armWeatherLoad(key, entry);
    entry.url = url;
    if (entry.added) {
      (map.getSource(weatherSourceId(key)) as ImageSource | undefined)?.updateImage({ url });
    }
  }

  removeWeatherImage(key: string): void {
    if (this.ignoredAfterGiveUp("removeWeatherImage")) {
      return;
    }
    const entry = this.weatherEntries.get(key);
    if (!entry) {
      // Idempotent: eviction decisions live with the caller, whose
      // bookkeeping may lag an engine destroy/recreate cycle.
      return;
    }
    if (entry.added) {
      // Remove layer AND source promptly: the source owns the GPU texture,
      // so leaving it around leaks texture residency per toggled-off layer.
      const map = this.requireMap("removeWeatherImage");
      map.removeLayer(weatherSourceId(key));
      map.removeSource(weatherSourceId(key));
    }
    this.weatherEntries.delete(key);
    this.loadedWeatherKeys.delete(key);
    this.appliedWeatherOrder = this.appliedWeatherOrder.filter((applied) => applied !== key);
    // weatherLoadListeners deliberately survive removal (leaflet-engine
    // contract note: subscriptions outlive the image; callers own their
    // unsubscribe and may re-set the key later).
  }

  onWeatherImageLoaded(key: string, fn: () => void): () => void {
    let set = this.weatherLoadListeners.get(key);
    if (!set) {
      set = new Set();
      this.weatherLoadListeners.set(key, set);
    }
    set.add(fn);
    return () => {
      const current = this.weatherLoadListeners.get(key);
      if (!current) {
        return;
      }
      current.delete(fn);
      if (current.size === 0) {
        this.weatherLoadListeners.delete(key);
      }
    };
  }

  // GeoJSON line layer at the caller anchor's band. Leaflet-parity update
  // semantics: the SAME data reference restyles in place (setPaintProperty
  // only — geometry is never re-parsed); a NEW data reference goes through
  // GeoJSONSource.setData (cheaper than recreate and keeps the layer's band
  // position); only an anchor change (no app caller does this today) removes
  // and re-adds the layer at the new band.
  setLineLayer(id: string, data: GeoJSON.FeatureCollection, style: LineLayerStyle): void {
    if (this.ignoredAfterGiveUp("setLineLayer")) {
      return;
    }
    const map = this.requireMap("setLineLayer");
    const sharedHost = this.styleReady ? sharedGeoJsonSourceHost(map) : null;
    const existing = this.lineLayers.get(id);
    if (!existing) {
      const entry: LineLayerEntry = { data, style, added: false };
      this.lineLayers.set(id, entry);
      if (style.sourceFamily) {
        this.sharedGeoJsonSources.attach(style.sourceFamily, lineSharedSourceMemberId(id), data, sharedHost);
      }
      // Style still loading: the load handler's flushLineLayers applies the
      // registry once the style is mutable (same pattern as weather).
      if (this.styleReady) {
        this.addLineLayer(map, id, entry);
      }
      return;
    }
    const anchorChanged = existing.style.anchor !== style.anchor;
    const sourceFamilyChanged = existing.style.sourceFamily !== style.sourceFamily;
    const dataChanged = existing.data !== data;
    const styleChanged = existing.style !== style;
    const previousSourceFamily = existing.style.sourceFamily;
    if (sourceFamilyChanged) {
      if (existing.added) {
        map.removeLayer(lineSourceId(id));
        if (!previousSourceFamily) {
          map.removeSource(lineSourceId(id));
        }
      }
      if (previousSourceFamily) {
        this.sharedGeoJsonSources.release(
          previousSourceFamily,
          lineSharedSourceMemberId(id),
          sharedGeoJsonSourceHost(map),
        );
      }
      existing.data = data;
      existing.style = style;
      existing.added = false;
      if (style.sourceFamily) {
        this.sharedGeoJsonSources.attach(style.sourceFamily, lineSharedSourceMemberId(id), data, sharedHost);
      }
      if (this.styleReady) {
        this.addLineLayer(map, id, existing);
      }
      return;
    }
    existing.data = data;
    existing.style = style;
    if (style.sourceFamily) {
      this.sharedGeoJsonSources.attach(style.sourceFamily, lineSharedSourceMemberId(id), data, sharedHost);
    }
    if (!existing.added) {
      return; // flushLineLayers applies the updated stored state
    }
    if (anchorChanged) {
      // Band move: recreate at the new anchor's insertion point.
      map.removeLayer(lineSourceId(id));
      if (!style.sourceFamily) {
        map.removeSource(lineSourceId(id));
      }
      existing.added = false;
      this.addLineLayer(map, id, existing);
      return;
    }
    if (dataChanged && !style.sourceFamily) {
      (map.getSource(lineSourceId(id)) as GeoJSONSource | undefined)?.setData(data);
    }
    // Synoptic and height frames replace geometry while reusing immutable
    // theme style objects. Do not issue four identical paint writes per layer
    // on every timeline tick.
    if (styleChanged) {
      this.applyLineStyle(map, id, style);
      map.setFilter(lineSourceId(id), maplibreFilter(style.sourceFilter) ?? null);
    }
  }

  // GeoJSON symbol (text) layer at the caller anchor's band, placed by
  // MapLibre's collision engine (text-allow-overlap stays false — density
  // control is native placement, replacing the leaflet path's custom
  // screen-space declutter). Update semantics mirror setLineLayer: same data
  // reference restyles in place, a new reference goes through setData, only
  // an anchor change recreates the layer.
  setSymbolLayer(id: string, data: GeoJSON.FeatureCollection, style: SymbolLayerStyle): void {
    if (this.ignoredAfterGiveUp("setSymbolLayer")) {
      return;
    }
    const map = this.requireMap("setSymbolLayer");
    const sharedHost = this.styleReady ? sharedGeoJsonSourceHost(map) : null;
    const existing = this.symbolLayers.get(id);
    if (!existing) {
      const entry: SymbolLayerEntry = { data, style, added: false };
      this.symbolLayers.set(id, entry);
      if (style.sourceFamily) {
        this.sharedGeoJsonSources.attach(style.sourceFamily, symbolSharedSourceMemberId(id), data, sharedHost);
      }
      if (this.styleReady) {
        this.addSymbolLayer(map, id, entry);
      }
      return;
    }
    const anchorChanged = existing.style.anchor !== style.anchor;
    const sourceFamilyChanged = existing.style.sourceFamily !== style.sourceFamily;
    const dataChanged = existing.data !== data;
    const styleChanged = existing.style !== style;
    // Layout properties (placement/sort key/format structure) are baked at
    // creation; the restyle-in-place path only re-sets paint + the layout
    // values that can change (text-field/text-size/spacing). A placement or
    // sort-key change would need recreate — no app caller restyles those.
    const layoutChanged =
      existing.style.placement !== style.placement || existing.style.sortKeyProperty !== style.sortKeyProperty;
    const previousSourceFamily = existing.style.sourceFamily;
    if (sourceFamilyChanged) {
      if (existing.added) {
        map.removeLayer(symbolSourceId(id));
        if (!previousSourceFamily) {
          map.removeSource(symbolSourceId(id));
        }
      }
      if (previousSourceFamily) {
        this.sharedGeoJsonSources.release(
          previousSourceFamily,
          symbolSharedSourceMemberId(id),
          sharedGeoJsonSourceHost(map),
        );
      }
      existing.data = data;
      existing.style = style;
      existing.added = false;
      if (style.sourceFamily) {
        this.sharedGeoJsonSources.attach(style.sourceFamily, symbolSharedSourceMemberId(id), data, sharedHost);
      }
      if (this.styleReady) {
        this.addSymbolLayer(map, id, existing);
      }
      return;
    }
    existing.data = data;
    existing.style = style;
    if (style.sourceFamily) {
      this.sharedGeoJsonSources.attach(style.sourceFamily, symbolSharedSourceMemberId(id), data, sharedHost);
    }
    if (!existing.added) {
      return; // flushSymbolLayers applies the updated stored state
    }
    if (anchorChanged || layoutChanged) {
      map.removeLayer(symbolSourceId(id));
      if (!style.sourceFamily) {
        map.removeSource(symbolSourceId(id));
      }
      existing.added = false;
      this.addSymbolLayer(map, id, existing);
      return;
    }
    if (dataChanged && !style.sourceFamily) {
      (map.getSource(symbolSourceId(id)) as GeoJSONSource | undefined)?.setData(data);
    }
    if (styleChanged) {
      this.applySymbolStyle(map, id, style);
      map.setFilter(symbolSourceId(id), maplibreFilter(style.sourceFilter) ?? null);
    }
  }

  removeLayer(id: string): void {
    if (this.ignoredAfterGiveUp("removeLayer")) {
      return;
    }
    const entry = this.lineLayers.get(id);
    if (entry) {
      if (entry.added) {
        const map = this.requireMap("removeLayer");
        map.removeLayer(lineSourceId(id));
        if (entry.style.sourceFamily) {
          this.sharedGeoJsonSources.release(
            entry.style.sourceFamily,
            lineSharedSourceMemberId(id),
            sharedGeoJsonSourceHost(map),
          );
        } else {
          map.removeSource(lineSourceId(id));
        }
      } else if (entry.style.sourceFamily) {
        this.sharedGeoJsonSources.release(entry.style.sourceFamily, lineSharedSourceMemberId(id), null);
      }
      this.lineLayers.delete(id);
      return;
    }
    const symbolEntry = this.symbolLayers.get(id);
    if (!symbolEntry) {
      // Idempotent, like removeWeatherImage: caller cleanup may lag an
      // engine destroy/recreate cycle.
      return;
    }
    if (symbolEntry.added) {
      const map = this.requireMap("removeLayer");
      map.removeLayer(symbolSourceId(id));
      if (symbolEntry.style.sourceFamily) {
        this.sharedGeoJsonSources.release(
          symbolEntry.style.sourceFamily,
          symbolSharedSourceMemberId(id),
          sharedGeoJsonSourceHost(map),
        );
      } else {
        map.removeSource(symbolSourceId(id));
      }
    } else if (symbolEntry.style.sourceFamily) {
      this.sharedGeoJsonSources.release(symbolEntry.style.sourceFamily, symbolSharedSourceMemberId(id), null);
    }
    this.symbolLayers.delete(id);
  }

  setGroupOpacity(group: OpacityGroup, v: number): void {
    if (this.ignoredAfterGiveUp("setGroupOpacity")) {
      return;
    }
    const map = this.requireMap("setGroupOpacity");
    this.groupOpacity[group] = v;
    // Pre-style-load sets need no fan-out: layer creation bakes the stored
    // group value into each paint, and the load handler re-applies the
    // basemap-label fan-out.
    if (!this.styleReady) {
      return;
    }
    // "weather"/"synoptic" fan out to the live raster layers.
    if (group === "weather" || group === "synoptic") {
      for (const [key, entry] of this.weatherEntries) {
        if (entry.added && this.weatherOpacityGroup(key) === group) {
          map.setPaintProperty(weatherSourceId(key), "raster-opacity", this.appliedWeatherOpacity(key, entry));
        }
      }
    }
    // "labels" fans onto the basemap symbol stack (maplibre's labels band).
    if (group === "labels") {
      this.applyLabelsGroupOpacity();
    }
    // Line layers riding this group re-resolve line-opacity (the group
    // factor is baked into each layer's opacity value/expression, so a group
    // change recomputes and re-sets it — see lineOpacityValue).
    for (const [id, entry] of this.lineLayers) {
      if (entry.added && entry.style.group === group) {
        map.setPaintProperty(lineSourceId(id), "line-opacity", this.lineOpacityValue(entry.style));
      }
    }
    // Symbol layers riding this group re-resolve text-opacity the same way
    // (halo fades with the text — text-opacity governs the whole glyph).
    for (const [id, entry] of this.symbolLayers) {
      if (entry.added && entry.style.group === group) {
        map.setPaintProperty(symbolSourceId(id), "text-opacity", this.symbolOpacityValue(entry.style));
      }
    }
  }

  addMarker(el: HTMLElement, p: LatLon, opts?: { interactive?: boolean }): MarkerHandle {
    // Inert handle in the give-up state: the panel's marker effects (sounding
    // pin, remote hover crosshair) stay mounted under the fatal banner and
    // must get a handle whose methods are safe to call.
    if (this.ignoredAfterGiveUp("addMarker")) {
      return { setLatLon: () => {}, setOpacity: () => {}, remove: () => {} };
    }
    const map = this.requireMap("addMarker");
    // Holder wrapper mirrors the leaflet engine's centering semantics: the
    // caller's element renders centered on the anchor whatever its size
    // (anchor:"center" does the translate(-50%,-50%) equivalent), and
    // non-interactive markers must not eat map gestures.
    const holder = document.createElement("div");
    holder.appendChild(el);
    if (!(opts?.interactive ?? false)) {
      holder.style.pointerEvents = "none";
    }
    const marker = new maplibregl.Marker({ element: holder, anchor: "center" });
    marker.setLngLat([p.lon, p.lat]).addTo(map);
    this.markers.add(marker);
    return {
      setLatLon: (next: LatLon) => {
        marker.setLngLat([next.lon, next.lat]);
      },
      setOpacity: (v: number) => {
        holder.style.opacity = String(v);
      },
      remove: () => {
        this.markers.delete(marker);
        marker.remove();
      },
    };
  }

  onFatal(fn: (fatal: EngineFatal | null) => void): () => void {
    this.fatalListeners.add(fn);
    // A basemap failure can race the subscriber (source errors fire async
    // right after create); never swallow one that already happened.
    if (this.lastFatal) {
      fn(this.lastFatal);
    }
    return () => {
      this.fatalListeners.delete(fn);
    };
  }

  // TEST-ONLY snapshot for the window.__wx bridge. layerOrder tracks ONLY app
  // weather/line/symbol layers — never basemap or anchor layers — read off
  // the live style's applied order (bottom -> top), so the bridge observes
  // rendered reality; groupOpacity reflects the stored setGroupOpacity
  // values, which are also the applied group factors; lineLayerOpacity
  // resolves from the stored LineLayerStyle (curves evaluated at the current
  // native zoom, group factor excluded — same semantics as the leaflet
  // engine, so the display-menu bridge assertions hold on both).
  __introspect(): EngineIntrospection {
    const map = this.requireMap("__introspect");
    const layerOrder: string[] = [];
    if (this.styleReady) {
      for (const layerId of map.getLayersOrder()) {
        if (layerId.startsWith(WEATHER_SOURCE_PREFIX)) {
          layerOrder.push(layerId.slice(WEATHER_SOURCE_PREFIX.length));
        } else if (layerId.startsWith(LINE_SOURCE_PREFIX)) {
          layerOrder.push(layerId.slice(LINE_SOURCE_PREFIX.length));
        } else if (layerId.startsWith(SYMBOL_SOURCE_PREFIX)) {
          layerOrder.push(layerId.slice(SYMBOL_SOURCE_PREFIX.length));
        }
      }
    }
    // Applied raw-pixel mode: the raster-resampling paint value on the live
    // layer ("nearest" == raw pixels); stored flag while the style is still
    // loading (creation bakes the same value in).
    const weatherPixelated: Record<string, boolean> = {};
    for (const [key, entry] of this.weatherEntries) {
      weatherPixelated[key] = entry.added
        ? map.getPaintProperty(weatherSourceId(key), "raster-resampling") === "nearest"
        : entry.pixelated;
    }
    const lineLayerOpacity: Record<string, number> = {};
    for (const [id, entry] of this.lineLayers) {
      lineLayerOpacity[id] =
        typeof entry.style.opacity === "number"
          ? entry.style.opacity
          : evalZoomCurve(entry.style.opacity, this.getZoom());
    }
    const symbolFeatureCounts: Record<string, number> = {};
    for (const [id, entry] of this.symbolLayers) {
      symbolFeatureCounts[id] = countFilteredGeoJsonFeatures(entry.data, entry.style.sourceFilter);
    }
    // Basemap label layers present in the LIVE style and not toggled off —
    // read back from applied layout state (not the stored id list), so the
    // bridge observes rendered reality (Task 5.2 offline-boot signal).
    const basemapLabelLayers: string[] = [];
    if (this.styleReady) {
      for (const id of this.labelLayerIds) {
        if (map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none") {
          basemapLabelLayers.push(id);
        }
      }
    }
    // Basemap boundary lines present + visible — same read-back discipline
    // as basemapLabelLayers (Map QA E3: the exclusive-border-modes signal).
    const basemapBoundaryLayers: string[] = [];
    if (this.styleReady) {
      for (const id of this.boundaryLayerIds) {
        if (map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none") {
          basemapBoundaryLayers.push(id);
        }
      }
    }
    return {
      weatherLayers: Array.from(this.weatherEntries.keys()),
      loadedWeatherLayers: Array.from(this.loadedWeatherKeys),
      layerOrder,
      groupOpacity: { ...this.groupOpacity },
      weatherPixelated,
      lineLayerOpacity,
      symbolFeatureCounts,
      basemapLabelLayers,
      basemapBoundaryLayers,
    };
  }

  private createMap(config: NativeMapConfig): void {
    if (!this.host) {
      throw new Error("MapLibreEngine.createMap: no host element.");
    }
    ensurePmtilesProtocol();
    if (import.meta.env?.DEV) {
      // Fail-loud dev check (once per map create; generation is a few ms):
      // the theme switch relies on both flavors generating the same layer
      // ids — see verifyThemeLayerIdParity.
      const pmtilesUrl = this.basemapPmtilesUrl();
      verifyThemeLayerIdParity(buildLightStyle(pmtilesUrl), buildDarkStyle(pmtilesUrl));
    }
    const style = this.buildThemeStyle();
    this.styleReady = false;
    this.initialLoadComplete = false;
    this.basemapSourceLoaded = false;
    // Any armed basemap retry died with the previous map (once-listeners are
    // per-map); reset so the new map can arm its own.
    this.basemapRetryPending = false;
    // Weather/line sources and layers died with any previous map (context-
    // loss recreate): mark every registry entry un-added so the load flush
    // re-creates them on the new map.
    for (const entry of this.weatherEntries.values()) {
      entry.added = false;
    }
    for (const entry of this.lineLayers.values()) {
      entry.added = false;
    }
    for (const entry of this.symbolLayers.values()) {
      entry.added = false;
    }
    this.sharedGeoJsonSources.markUnadded();
    this.appliedWeatherOrder = [];

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: this.host,
        style: style as StyleSpecification,
        center: config.center,
        zoom: config.zoom,
        minZoom: config.minZoom,
        maxZoom: config.maxZoom,
        maxBounds: config.maxBounds,
        // 2D app: no rotate/pitch surfaces at all.
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        doubleClickZoom: false, // dblclick = point sounding, matching leaflet
        renderWorldCopies: false, // leaflet ran noWrap/worldCopyJump:false
        trackResize: true, // container ResizeObserver is built in
        fadeDuration: 0, // no label cross-fade churn under frame playback
        attributionControl: { compact: true },
      });
    } catch (error) {
      // The Map constructor throws synchronously when the canvas cannot
      // produce a WebGL context at all ("Failed to initialize WebGL": WebGL
      // disabled/blocklisted, exhausted contexts). Class it for the panel
      // banner FIRST — emitFatal stores lastFatal, so both already-attached
      // listeners and late onFatal subscribers see it — then rethrow so
      // create() callers stop their boot flow instead of driving a mapless
      // engine (Task 6.1, pre-flip hardening).
      this.emitFatal({
        kind: "webgl-init",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();

    // Engine-owned zoom chrome with the engine-neutral testids (Task 1.5
    // contract): specs select map-zoom-in/-out, never library classes.
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), "top-left");
    this.host.querySelector(".maplibregl-ctrl-zoom-in")?.setAttribute("data-testid", "map-zoom-in");
    this.host.querySelector(".maplibregl-ctrl-zoom-out")?.setAttribute("data-testid", "map-zoom-out");

    // Contract events. move/moveend/zoomend surface jumpTo's eventData as
    // EngineEvent.meta (echo suppression for viewport-sync); pointer events
    // convert lngLat -> {lat, lon} at this boundary.
    map.on("move", (event) => this.emit("move", { meta: metaFromEvent(event) }));
    map.on("moveend", (event) => this.emit("moveend", { meta: metaFromEvent(event) }));
    map.on("zoomend", (event) => this.emit("zoomend", { meta: metaFromEvent(event) }));
    map.on("mousemove", (event) => {
      this.emit("mousemove", { latlon: { lat: event.lngLat.lat, lon: event.lngLat.lng } });
    });
    map.on("mouseout", () => this.emit("mouseout", {}));
    map.on("dblclick", (event) => {
      this.emit("dblclick", { latlon: { lat: event.lngLat.lat, lon: event.lngLat.lng } });
    });

    map.once("load", () => {
      this.initialLoadComplete = true;
      this.applyLoadedStyle(map);
    });
    // Theme switches swap the whole style with setStyle; each swap fires one
    // "style.load" when the new stylesheet is ready to mutate. The initial
    // load also fires style.load (BEFORE "load") — the initialLoadComplete
    // gate keeps the first flush on the original "load" timing.
    map.on("style.load", () => {
      if (this.initialLoadComplete && !this.styleReady) {
        this.applyLoadedStyle(map);
      }
    });
    map.on("sourcedata", (event) => {
      // GENUINE basemap load signal = the "metadata" fire: the source's
      // header/TileJSON parsed, which only happens on a successful archive
      // read. isSourceLoaded is NOT trustworthy here — maplibre flips an
      // ERRORED source to loaded (so the style isn't stuck "loading") and
      // then fires sourcedata with isSourceLoaded=true, which would clear
      // the fatal below milliseconds after it was raised (observed live,
      // Task 5.2 drill: server down -> FATAL -> synthetic loaded event ->
      // banner vanished).
      if (event.sourceId === BASEMAP_SOURCE_ID && event.sourceDataType === "metadata") {
        this.basemapSourceLoaded = true;
        // A transient boot failure (artifact server briefly down) whose
        // retry later succeeds must un-stick the fatal banner without a
        // remount (Task 5.2): the first successful basemap source load
        // clears a basemap-class fatal. Context-loss fatals never clear
        // here — the engine already gave up recreating that map.
        if (this.lastFatal?.kind === "basemap") {
          this.clearFatal();
        }
      }
      this.handleWeatherSourceData(event);
    });
    map.on("error", (event) => this.handleMapError(event));

    // Self-healing GL context loss: destroy/recreate preserving the camera.
    map.on("webglcontextlost", () => {
      console.error("maplibre-engine: WebGL context lost; recreating the map.");
      // Defer out of the event dispatch so map.remove() never re-enters the
      // firing handler chain.
      window.setTimeout(() => {
        if (this.map === map) {
          this.recreateAfterContextLoss();
        }
      }, 0);
    });

    this.map = map;
  }

  private recreateAfterContextLoss(): void {
    const map = this.map;
    if (!map || !this.host) {
      return;
    }
    this.contextLossCount += 1;
    if (this.contextLossCount > MAX_CONTEXT_LOSS_RECREATES) {
      // Give up recreating — but tear the dead map down FIRST, with the same
      // map-instance disposal destroy() uses (remove() frees the context slot
      // and detaches maplibre's DOM/handlers; leaving a dead-but-attached map
      // would also keep requireMap() serving a corpse). Everything else
      // destroy() clears deliberately survives: the fatal below must reach
      // the already-subscribed panel banner listeners (fatalListeners), and
      // the registries/markers belong to the app, which still owns the real
      // destroy() on unmount. The camera must be frozen BEFORE remove() (see
      // frozenCamera), and gaveUp flips the whole verb surface to no-ops —
      // the app keeps driving this engine until unmount.
      const center = map.getCenter();
      this.frozenCamera = { center: { lat: center.lat, lon: center.lng }, zoom: map.getZoom() };
      this.gaveUp = true;
      map.remove();
      this.map = null;
      this.emitFatal({
        kind: "context-loss",
        message: "The map's WebGL context was lost repeatedly and could not be recovered.",
      });
      return;
    }
    // Camera + constraints are plain JS state — still readable after the GL
    // context died. Preserve everything the app set post-create.
    const center = map.getCenter();
    const config: NativeMapConfig = {
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      minZoom: map.getMinZoom(),
      maxZoom: map.getMaxZoom(),
      maxBounds: map.getMaxBounds() ?? toLngLatBounds({ south: -85, west: -180, north: 85, east: 180 }),
    };
    map.remove();
    this.map = null;
    try {
      this.createMap(config);
    } catch {
      // The recreate's own Map constructor threw — GL is gone for good on
      // this machine/tab. createMap already emitted the classed webgl-init
      // fatal (this runs from a setTimeout, so rethrowing would only produce
      // an unhandled error on top of the banner). Stop retrying — the same
      // terminal state as the recreate cap: the map is null but the app
      // keeps driving this engine, so verbs must no-op from here on. The
      // camera config captured above is the freshest one available.
      this.frozenCamera = { center: { lat: config.center[1], lon: config.center[0] }, zoom: config.zoom };
      this.gaveUp = true;
      return;
    }
    // Marker handles stay valid across the recreate: re-attach their
    // (caller-owned) elements to the new map.
    const newMap = this.map as MapLibreMap | null;
    if (newMap) {
      for (const marker of this.markers) {
        marker.addTo(newMap);
      }
    }
  }

  // Composite basemap-layer visibility: a layer is visible iff every flag
  // governing it is on. The id sets overlap — road labels/shields are symbol
  // layers (labels flag) AND road-network layers (roads flag); locality
  // labels are symbol layers AND city-label layers (cities flag) — so the
  // three flags must resolve in one place or the last-applied one would
  // clobber the others.
  private applyBasemapLayerVisibility(): void {
    const map = this.map;
    if (!map || !this.styleReady) {
      return; // the load handler re-applies once the style is mutable
    }
    const labels = new Set(this.labelLayerIds);
    const roads = new Set(this.roadLayerIds);
    const places = new Set(this.placeLabelLayerIds);
    const governed = new Set([...labels, ...roads, ...places]);
    for (const id of governed) {
      const visible =
        (!labels.has(id) || this.labelsVisible) &&
        (!roads.has(id) || this.detailRoads) &&
        (!places.has(id) || this.detailCities);
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  }

  // Applies the stored boundary presentation to the live boundary layers:
  // visibility as layout, line-width as captured base × widthScale, and
  // line-color as override-or-base (color null restores the theme default
  // captured at style build, so a dark<->light switch keeps the right ink).
  private applyBasemapBoundaries(): void {
    const map = this.map;
    if (!map || !this.styleReady) {
      return; // the load handler re-applies once the style is mutable
    }
    for (const id of this.boundaryLayerIds) {
      const base = this.boundaryLayerBase.get(id);
      if (!base) {
        continue; // unreachable while buildThemeStyle captures every id it derives
      }
      map.setLayoutProperty(id, "visibility", this.basemapBoundaries.visible ? "visible" : "none");
      map.setPaintProperty(id, "line-width", base.width * this.basemapBoundaries.widthScale);
      map.setPaintProperty(id, "line-color", this.basemapBoundaries.color ?? base.color);
    }
  }

  // The labels group fans onto the basemap symbol layers' text/icon opacity:
  // on maplibre the labels "band" IS the basemap symbol stack (the generated
  // style sets no text-/icon-opacity of its own, so writing the group value
  // directly clobbers nothing).
  private applyLabelsGroupOpacity(): void {
    const map = this.map;
    if (!map || !this.styleReady) {
      return; // the load handler re-applies once the style is mutable
    }
    for (const id of this.labelLayerIds) {
      map.setPaintProperty(id, "text-opacity", this.groupOpacity.labels);
      map.setPaintProperty(id, "icon-opacity", this.groupOpacity.labels);
    }
  }

  // See ANCHOR_ORDER: the six placeholders all insert before the first
  // basemap symbol layer, in contract order (each addLayer with the same
  // beforeId lands after the previously inserted one). Invisible background
  // layers are the cheapest legal no-op layer — no source, nothing drawn.
  private insertAnchorLayers(map: MapLibreMap): void {
    const beforeId = this.firstBasemapSymbolLayerId();
    for (const anchor of ANCHOR_ORDER) {
      map.addLayer({ id: anchorLayerId(anchor), type: "background", layout: { visibility: "none" } }, beforeId);
    }
  }

  // basemapLabelLayerIds == the style's symbol layers in style order, so its
  // first entry is where the basemap's label stack begins. undefined (a style
  // with no labels) degrades to top-of-stack insertion.
  private firstBasemapSymbolLayerId(): string | undefined {
    return this.labelLayerIds[0];
  }

  // beforeId for a layer inserted at `anchor`: the NEXT anchor's placeholder
  // (== this band's top). The labels band has no next anchor and caps at the
  // first basemap symbol layer instead; the centers band caps at nothing —
  // its layers append at the very top of the style, above the basemap
  // symbol stack (see the ANCHOR_ORDER note).
  private anchorBeforeId(anchor: AnchorId): string | undefined {
    if (anchor === "centers") {
      return undefined;
    }
    const next = ANCHOR_ORDER[ANCHOR_ORDER.indexOf(anchor) + 1];
    return next ? anchorLayerId(next) : this.firstBasemapSymbolLayerId();
  }

  // The synoptic raster renders in the synoptic band, above the weather band
  // (leaflet parity: its fixed z-410 isobar pane vs the z-36x dynamic pane),
  // and rides the "synoptic" opacity group for the same reason.
  private weatherAnchor(key: string): AnchorId {
    return key === "synoptic" ? "synoptic" : "weather";
  }

  private weatherOpacityGroup(key: string): OpacityGroup {
    return key === "synoptic" ? "synoptic" : "weather";
  }

  private appliedWeatherOpacity(key: string, entry: WeatherEntry): number {
    return this.groupOpacity[this.weatherOpacityGroup(key)] * entry.opacity;
  }

  private addWeatherLayer(map: MapLibreMap, key: string, entry: WeatherEntry): void {
    const id = weatherSourceId(key);
    map.addSource(id, { type: "image", url: entry.url, coordinates: toImageCoordinates(entry.bounds) });
    map.addLayer(
      {
        id,
        type: "raster",
        source: id,
        paint: {
          // 0 keeps frame swaps atomic-looking (Phase-0 verdict): without it
          // maplibre cross-fades rasters and playback strobes.
          "raster-fade-duration": 0,
          "raster-resampling": entry.pixelated ? "nearest" : "linear",
          "raster-opacity": this.appliedWeatherOpacity(key, entry),
        },
      },
      this.anchorBeforeId(this.weatherAnchor(key)),
    );
    entry.added = true;
    if (key !== "synoptic") {
      this.appliedWeatherOrder.push(key);
    }
  }

  // setWeatherImage re-appends its key to the registry on EVERY update, so
  // mid-pass the registry is a transient rotation of the true order (the
  // panel hook re-sets every active layer per pass, in stacking order). A
  // per-call sync cannot tell that rotation from a genuine reorder — for two
  // layers a reversal IS a rotation — and comparing rotated snapshots
  // re-stacked the band n times per steady-state pass. Deferring to a
  // microtask evaluates the order exactly once per synchronous pass, after
  // the LAST re-append: in steady state desired == applied and the sync
  // fast-paths with zero moveLayer; a genuine order change re-stacks exactly
  // once, still before the next rendered frame (microtasks flush ahead of
  // maplibre's rAF-driven render).
  private scheduleWeatherBandOrderSync(): void {
    if (this.weatherOrderSyncScheduled) {
      return;
    }
    this.weatherOrderSyncScheduled = true;
    queueMicrotask(() => {
      this.weatherOrderSyncScheduled = false;
      const map = this.map;
      // Destroyed, or a context-loss recreate is mid-flight: nothing to sync
      // (flushWeatherLayers re-adds in registry order, which is already the
      // canonical stacking order).
      if (!map || !this.styleReady) {
        return;
      }
      this.syncWeatherBandOrder(map);
    });
  }

  // Leaflet parity: registry (call) order == stacking order within the
  // weather band, updates of existing keys included. Runs once per set-pass
  // (see scheduleWeatherBandOrderSync), so the comparison sees the pass's
  // final registry order and is a fast-path no-op in steady state; when an
  // order change does arrive, moving each layer to the band top in registry
  // order re-stacks the whole band.
  private syncWeatherBandOrder(map: MapLibreMap): void {
    const desired: string[] = [];
    for (const [key, entry] of this.weatherEntries) {
      if (entry.added && key !== "synoptic") {
        desired.push(key);
      }
    }
    if (
      desired.length === this.appliedWeatherOrder.length &&
      desired.every((key, i) => key === this.appliedWeatherOrder[i])
    ) {
      return;
    }
    const beforeId = this.anchorBeforeId("weather");
    for (const key of desired) {
      map.moveLayer(weatherSourceId(key), beforeId);
    }
    this.appliedWeatherOrder = desired;
  }

  // Style just became mutable (initial "load", a theme-switch "style.load",
  // or a context-loss recreate): anchor scaffold first — every app layer
  // inserts relative to an anchor — then re-assert the stored basemap flags
  // (labels visibility, roads/cities detail, boundary presentation,
  // labels-group opacity; their setters usually run before the style finishes
  // loading), then apply the weather/line/symbol registries. Lines flush
  // before symbols so band-mates restack in the designed order (labels above
  // the lines they annotate).
  private applyLoadedStyle(map: MapLibreMap): void {
    this.styleReady = true;
    this.insertAnchorLayers(map);
    this.applyBasemapLayerVisibility();
    this.applyBasemapBoundaries();
    this.applyLabelsGroupOpacity();
    this.flushWeatherLayers(map);
    this.flushLineLayers(map);
    this.flushSymbolLayers(map);
  }

  // Style just became mutable (initial load, or a context-loss recreate):
  // re-add every registered weather image. On the recreate path entries that
  // had already dispatched their load are re-armed, so the bookkeeping tracks
  // the NEW map's reload (isWeatherLoaded reads false until the fresh decode
  // lands; markFrameLayerLoaded re-fires idempotently).
  private flushWeatherLayers(map: MapLibreMap): void {
    for (const [key, entry] of this.weatherEntries) {
      if (entry.pendingGeneration === null) {
        this.armWeatherLoad(key, entry);
      }
      this.addWeatherLayer(map, key, entry);
    }
  }

  // Style just became mutable (initial load, or a context-loss recreate):
  // add every registered line layer. lineLayerBeforeId re-derives each
  // layer's slot, so flush order does not matter.
  private flushLineLayers(map: MapLibreMap): void {
    for (const [id, entry] of this.lineLayers) {
      this.addLineLayer(map, id, entry);
    }
  }

  // Symbol registry flush (after flushLineLayers — see the load handler).
  private flushSymbolLayers(map: MapLibreMap): void {
    for (const [id, entry] of this.symbolLayers) {
      this.addSymbolLayer(map, id, entry);
    }
  }

  private addLineLayer(map: MapLibreMap, id: string, entry: LineLayerEntry): void {
    const glId = lineSourceId(id);
    const sourceId = entry.style.sourceFamily
      ? this.sharedGeoJsonSources.ensure(entry.style.sourceFamily, sharedGeoJsonSourceHost(map))
      : glId;
    if (!entry.style.sourceFamily) {
      map.addSource(glId, { type: "geojson", data: entry.data });
    }
    map.addLayer(
      {
        id: glId,
        type: "line",
        source: sourceId,
        ...(entry.style.sourceFilter ? { filter: maplibreFilter(entry.style.sourceFilter) } : {}),
        // Round caps/joins match the leaflet engine's path options.
        layout: { "line-cap": "round", "line-join": "round" },
        paint: this.linePaint(entry.style),
      },
      this.lineLayerBeforeId(id, entry.style.anchor),
    );
    entry.added = true;
  }

  // beforeId for a line layer: the bottom-most same-band line layer with a
  // HIGHER band rank (the new layer slides in under it); with no ranked
  // ceiling, the band's bottom-most SYMBOL layer (labels always annotate
  // from above the lines of their band); with neither, the band top
  // (anchorBeforeId). See LINE_LAYER_BAND_RANK — this keeps within-band
  // stacking identical to the leaflet engine's fixed pane z-indexes no
  // matter which feature fetch resolves first.
  private lineLayerBeforeId(id: string, anchor: AnchorId): string | undefined {
    const map = this.requireMap("lineLayerBeforeId");
    const rank = LINE_LAYER_BAND_RANK[id] ?? Number.POSITIVE_INFINITY;
    for (const appliedId of map.getLayersOrder()) {
      if (appliedId.startsWith(SYMBOL_SOURCE_PREFIX)) {
        const bareSymbol = appliedId.slice(SYMBOL_SOURCE_PREFIX.length);
        const symbol = this.symbolLayers.get(bareSymbol);
        if (symbol?.added && symbol.style.anchor === anchor) {
          return appliedId; // getLayersOrder is bottom -> top: first hit == band's lowest symbol
        }
        continue;
      }
      if (!appliedId.startsWith(LINE_SOURCE_PREFIX)) {
        continue;
      }
      const bare = appliedId.slice(LINE_SOURCE_PREFIX.length);
      const other = this.lineLayers.get(bare);
      if (bare === id || !other?.added || other.style.anchor !== anchor) {
        continue;
      }
      if ((LINE_LAYER_BAND_RANK[bare] ?? Number.POSITIVE_INFINITY) > rank) {
        return appliedId;
      }
    }
    return this.anchorBeforeId(anchor);
  }

  private linePaint(style: LineLayerStyle): LineLayerSpecification["paint"] {
    return {
      "line-color": style.color,
      "line-width": style.weight,
      "line-opacity": this.lineOpacityValue(style),
      // Leaflet dashArray is in px; maplibre line-dasharray is in multiples
      // of line-width. Convert so a [2, 5] dash renders the same on both.
      ...(style.dashArray ? { "line-dasharray": style.dashArray.map((d) => d / Math.max(style.weight, 0.1)) } : {}),
    };
  }

  // Restyle-in-place path (and the group fan-out target): paint-only writes,
  // never touching source data or layer position.
  private applyLineStyle(map: MapLibreMap, id: string, style: LineLayerStyle): void {
    const glId = lineSourceId(id);
    map.setPaintProperty(glId, "line-color", style.color);
    map.setPaintProperty(glId, "line-width", style.weight);
    map.setPaintProperty(glId, "line-opacity", this.lineOpacityValue(style));
    map.setPaintProperty(
      glId,
      "line-dasharray",
      style.dashArray ? style.dashArray.map((d) => d / Math.max(style.weight, 0.1)) : undefined,
    );
  }

  private addSymbolLayer(map: MapLibreMap, id: string, entry: SymbolLayerEntry): void {
    const glId = symbolSourceId(id);
    const sourceId = entry.style.sourceFamily
      ? this.sharedGeoJsonSources.ensure(entry.style.sourceFamily, sharedGeoJsonSourceHost(map))
      : glId;
    if (!entry.style.sourceFamily) {
      map.addSource(glId, { type: "geojson", data: entry.data });
    }
    map.addLayer(
      {
        id: glId,
        type: "symbol",
        source: sourceId,
        ...(entry.style.sourceFilter ? { filter: maplibreFilter(entry.style.sourceFilter) } : {}),
        // Zoom gates are LAYER minzoom, never paint opacity: an invisible
        // (text-opacity 0) label still claims collision space and would
        // suppress visible labels below it — a layer outside its zoom range
        // does not exist to the collision engine. style.minZoom is native
        // maplibre zoom (Task 6.2), the unit minzoom wants.
        ...(entry.style.minZoom !== undefined ? { minzoom: entry.style.minZoom } : {}),
        layout: this.symbolLayout(entry.style),
        paint: this.symbolPaint(entry.style),
      },
      // Band top in call order (labels over the band's lines; among symbol
      // layers, LATER-set ids sit higher — and MapLibre resolves cross-layer
      // collisions top-down, so callers set their highest-priority symbol
      // layer last).
      this.anchorBeforeId(entry.style.anchor),
    );
    entry.added = true;
  }

  private symbolLayout(style: SymbolLayerStyle): SymbolLayerSpecification["layout"] {
    return {
      "symbol-placement": style.placement === "line" ? "line" : "point",
      "text-field": symbolTextField(style),
      "text-font": SYMBOL_TEXT_FONT,
      "text-size": this.symbolTextSizeValue(style.textSize),
      // The point of the native path: MapLibre's collision engine owns
      // density/declutter. Never allow overlap; symbol-sort-key decides who
      // wins contested space within the layer.
      "text-allow-overlap": false,
      "text-ignore-placement": false,
      ...(style.sortKeyProperty ? { "symbol-sort-key": ["get", style.sortKeyProperty] } : {}),
      ...(style.placement === "line"
        ? {
            // Along-line value labels: repeat spacing per style (engine
            // default 250 px), map-aligned rotation so labels ride their
            // line, and a modest max-angle so text never bends around tight
            // contour curvature into illegibility.
            "symbol-spacing": style.repeatSpacing ?? 250,
            "text-rotation-alignment": "map",
            "text-max-angle": 30,
          }
        : {}),
    };
  }

  private symbolPaint(style: SymbolLayerStyle): SymbolLayerSpecification["paint"] {
    return {
      "text-color": style.color,
      "text-halo-color": style.haloColor,
      "text-halo-width": style.haloWidth,
      "text-opacity": this.symbolOpacityValue(style),
    };
  }

  // Restyle-in-place path (paint + the mutable layout values + the layer
  // zoom range); placement/sort-key/anchor changes recreate instead (see
  // setSymbolLayer).
  private applySymbolStyle(map: MapLibreMap, id: string, style: SymbolLayerStyle): void {
    const glId = symbolSourceId(id);
    map.setPaintProperty(glId, "text-color", style.color);
    map.setPaintProperty(glId, "text-halo-color", style.haloColor);
    map.setPaintProperty(glId, "text-halo-width", style.haloWidth);
    map.setPaintProperty(glId, "text-opacity", this.symbolOpacityValue(style));
    map.setLayoutProperty(glId, "text-field", symbolTextField(style));
    map.setLayoutProperty(glId, "text-size", this.symbolTextSizeValue(style.textSize));
    map.setLayerZoomRange(glId, style.minZoom ?? 0, 24);
    if (style.placement === "line") {
      map.setLayoutProperty(glId, "symbol-spacing", style.repeatSpacing ?? 250);
    }
  }

  // Applied text-opacity = group factor × the style's base opacity
  // (default 1) — the group semantics of lineOpacityValue, minus the curve
  // path: SymbolLayerStyle.opacity is number-only (see types.ts — opacity
  // curves on symbols are the zoom-gating-by-paint trap).
  private symbolOpacityValue(style: SymbolLayerStyle): number {
    return (style.opacity ?? 1) * this.groupOpacity[style.group];
  }

  // text-size takes the raw curve (no group factor: opacity fades, size
  // never scales with the Display slider).
  private symbolTextSizeValue(size: number | ZoomCurve): number | ExpressionSpecification {
    return this.zoomCurveValue(size, 1);
  }

  // Applied line-opacity = stored group factor × the style's opacity.
  private lineOpacityValue(style: LineLayerStyle): number | ExpressionSpecification {
    return this.zoomCurveValue(style.opacity, this.groupOpacity[style.group]);
  }

  // value/curve -> paint/layout value, scaled by `factor`. Constants multiply
  // to a plain value; ZoomCurves compile to ["interpolate", ["linear"],
  // ["zoom"], ...stops] with the stop keys used as-is (curves live in the
  // native maplibre zoom domain since Task 6.2, which is exactly what GL's
  // ["zoom"] evaluates) and the factor multiplied into every stop VALUE —
  // maplibre requires ["zoom"] to feed a TOP-LEVEL interpolate, so a wrapping
  // ["*", factor, …] is rejected at validation; scaling the outputs is
  // equivalent because linear interpolation commutes with scalar
  // multiplication. The factor is thus baked into the expression, and
  // setGroupOpacity recomputes and re-sets the whole value on group change.
  private zoomCurveValue(value: number | ZoomCurve, factor: number): number | ExpressionSpecification {
    if (typeof value === "number") {
      return value * factor;
    }
    const stops = normalizedZoomStops(value);
    if (stops.length === 0) {
      // Leaflet parity (evalZoomCurve): an empty curve renders fully visible
      // rather than hiding the layer with no error signal.
      return factor;
    }
    if (stops.length === 1) {
      return stops[0][1] * factor;
    }
    // Built dynamically, so the tuple-shaped ExpressionSpecification type
    // cannot be inferred — hence the through-unknown cast.
    const curve: unknown[] = ["interpolate", ["linear"], ["zoom"]];
    for (const [zoom, stopValue] of stops) {
      curve.push(zoom, stopValue * factor);
    }
    return curve as unknown as ExpressionSpecification;
  }

  // Every URL (re)set bumps the key's generation and re-arms the load signal:
  // until the NEW url's decode fires, the key is not loaded. The leaflet
  // engine's off("load")/once("load") pair, in generation-counter form.
  private armWeatherLoad(key: string, entry: WeatherEntry): void {
    entry.generation += 1;
    entry.pendingGeneration = entry.generation;
    this.loadedWeatherKeys.delete(key);
  }

  // Load signal. A weather key is "loaded" when the first sourcedata event
  // with isSourceLoaded=true arrives for its source AFTER its URL was
  // (re)set. Why stale fires cannot mark a new frame loaded (maplibre 5.24,
  // verified in src/source/image_source.ts): updateImage() aborts any
  // in-flight fetch and load() flips the source's loaded() false
  // SYNCHRONOUSLY inside our set/swap call — so every source event during the
  // new decode (coordinate content fires, tile churn, pan renders) reports
  // isSourceLoaded=false, and the first true event can only follow the
  // current URL's decode (the data/metadata fire on first load; the
  // render-frame idle fire after the SourceCache reload on swaps).
  // pendingGeneration makes dispatch once-per-armed-generation, so the
  // duplicate isSourceLoaded=true events that follow (idle refires, later
  // coordinate updates) are no-ops — leaflet's once("load") semantics.
  private handleWeatherSourceData(event: { sourceId?: string; isSourceLoaded?: boolean }): void {
    const sourceId = event.sourceId ?? "";
    if (!sourceId.startsWith(WEATHER_SOURCE_PREFIX) || !event.isSourceLoaded) {
      return;
    }
    const key = sourceId.slice(WEATHER_SOURCE_PREFIX.length);
    const entry = this.weatherEntries.get(key);
    if (!entry || entry.pendingGeneration === null || entry.pendingGeneration !== entry.generation) {
      return;
    }
    // Mark BEFORE dispatch so a listener that re-arms this key (a swap inside
    // a load callback) is not clobbered afterwards.
    entry.pendingGeneration = null;
    this.loadedWeatherKeys.add(key);
    const listeners = this.weatherLoadListeners.get(key);
    if (!listeners) {
      return;
    }
    for (const fn of Array.from(listeners)) {
      fn();
    }
  }

  private handleMapError(event: { error?: Error; sourceId?: string }): void {
    const message = event.error?.message ? String(event.error.message) : "unknown map error";
    const sourceId = event.sourceId ?? "";
    if (sourceId.startsWith(WEATHER_SOURCE_PREFIX)) {
      // A weather image failed to fetch/decode. MapLibre's ImageSource flips
      // loaded() TRUE on error (so the source isn't stuck "loading"), which
      // would let a later isSourceLoaded=true sourcedata fire (idle refires,
      // pan renders) mark the armed generation loaded without a decode.
      // Disarm it instead — leaflet parity: an <img> that errors never fires
      // load, so the frame stays un-loaded until the app re-sets the URL
      // (every re-set re-arms via armWeatherLoad and retries the fetch).
      //
      // Generation correlation (Task 4.4): error events carry no generation,
      // and a rejected fetch's ErrorEvent dispatches on the microtask queue —
      // it can land AFTER a newer URL was set/armed for the same key (the
      // rejection's await-chain hops can interleave with an app promise chain
      // that swaps the next frame). Disarming then would eat the FRESH
      // generation's load signal: its decode completes, but the pending arm
      // is gone and the frame never reports loaded until the next URL re-set.
      // What IS available: HTTP failures reject with maplibre's AJAXError,
      // which carries the failed request's URL verbatim (this engine
      // configures no transformRequest, so it is byte-equal to the URL we
      // set). An error whose URL differs from the entry's CURRENT url is
      // such a stale dispatch from a superseded generation — ignore it. App
      // frame URLs are per-frame distinct artifacts, so this correlates the
      // common playback path exactly. Residual, accepted imprecision (both
      // bounded to the microtask-wide dispatch window, self-healing on the
      // next URL re-set):
      // - errors WITHOUT a URL (image decode failures, network-level
      //   TypeErrors) stay uncorrelatable and keep the unconditional disarm;
      // - a stale error for the SAME url (immediate same-url retry) matches
      //   its successor and still disarms it.
      const entry = this.weatherEntries.get(sourceId.slice(WEATHER_SOURCE_PREFIX.length));
      const errorUrl = (event.error as { url?: unknown } | undefined)?.url;
      if (entry && typeof errorUrl === "string" && errorUrl !== entry.url) {
        console.warn("maplibre-engine: stale weather image error ignored (superseded url):", sourceId, message);
        return;
      }
      if (entry) {
        entry.pendingGeneration = null;
      }
      console.error("maplibre-engine: weather image failed to load:", sourceId, message);
      return;
    }
    const fromBasemapSource = event.sourceId === BASEMAP_SOURCE_ID || /pmtiles/i.test(message);
    if (fromBasemapSource && !this.basemapSourceLoaded) {
      // The pmtiles source failed before it ever loaded: file missing, 416,
      // artifact server down. This map has no basemap — surface the in-panel
      // error state instead of a silent black map (first failure only; retry
      // failures just log) and arm a gesture-driven retry so a recovered
      // server un-sticks the panel.
      if (!this.lastFatal) {
        this.emitFatal({ kind: "basemap", message: `Basemap source failed to load: ${message}` });
      } else {
        console.error("maplibre-engine: basemap source still failing:", message);
      }
      this.armBasemapRetry();
      return;
    }
    // Non-fatal (post-boot tile hiccups, glyph/sprite fetches, app layers
    // later): we own the "error" listener, so log what MapLibre would have.
    console.error("maplibre-engine:", message, event.error);
  }

  private emitFatal(fatal: EngineFatal): void {
    this.lastFatal = fatal;
    console.error(`maplibre-engine FATAL (${fatal.kind}): ${fatal.message}`);
    for (const fn of Array.from(this.fatalListeners)) {
      fn(fatal);
    }
  }

  // Recovery notification (Task 5.2): subscribers receive null so the panel
  // banner un-sticks without a remount.
  private clearFatal(): void {
    if (!this.lastFatal) {
      return;
    }
    this.lastFatal = null;
    for (const fn of Array.from(this.fatalListeners)) {
      fn(null);
    }
  }

  // Verb guard for the terminal give-up state (see the gaveUp field): true
  // means the caller must drop the call — the map is gone and will never
  // come back on this engine. Warns on the FIRST ignored call only.
  private ignoredAfterGiveUp(method: string): boolean {
    if (!this.gaveUp) {
      return false;
    }
    if (!this.gaveUpWarned) {
      this.gaveUpWarned = true;
      console.warn(
        `maplibre-engine: ${method} ignored — the engine gave up after repeated WebGL context loss; ` +
          "all further map calls no-op until the panel remounts.",
      );
    }
    return true;
  }

  private requireMap(method: string): MapLibreMap {
    if (!this.map) {
      // The give-up variant keeps misuse diagnostics honest: post-cap, a
      // method without a no-op path (project/unproject/getSize/__introspect
      // — no app caller reaches them on a dead panel) must not blame
      // create()/destroy() ordering.
      throw new Error(
        this.gaveUp
          ? `MapEngine.${method}: no live map (the engine gave up after repeated WebGL context loss).`
          : `MapEngine.${method}: no live map (create() not called or destroy() already ran).`,
      );
    }
    return this.map;
  }

  private emit(ev: EngineEventName, event: EngineEvent): void {
    const set = this.listeners.get(ev);
    if (!set) {
      return;
    }
    for (const fn of Array.from(set)) {
      fn(event);
    }
  }
}

// jumpTo's eventData rides the resulting camera events; wxMeta is this
// engine's private carrier key for the contract's EventMeta.
function metaFromEvent(event: object): EventMeta | undefined {
  return (event as { wxMeta?: EventMeta }).wxMeta;
}

// text-field for a symbol style: plain ["get"] for single-text layers; a
// two-line ["format"] when a secondary property rides beneath the primary
// (H/L glyph + pressure value). The "\n" section forces the line break; the
// secondary line scales relative to text-size via font-scale. One text ==
// one collision box, so the pair places or drops atomically.
function symbolTextField(style: SymbolLayerStyle): ExpressionSpecification {
  const primary: unknown[] = ["get", style.textProperty];
  if (!style.secondaryTextProperty) {
    return primary as unknown as ExpressionSpecification;
  }
  const format: unknown[] = [
    "format",
    primary,
    {},
    "\n",
    {},
    ["get", style.secondaryTextProperty],
    { "font-scale": style.secondaryTextScale ?? 0.5 },
  ];
  return format as unknown as ExpressionSpecification;
}
