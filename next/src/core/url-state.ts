import { MODEL_KEYS, VIEW_KEYS } from "../config/constants";
import { MAX_PANELS } from "../config/panels";
import { normalizeTimeZoneSetting } from "../config/timezone";
import { normalizeIsoHour } from "./time";
import type {
  LayerKey,
  ModelKey,
  ReflectivityGateDbz,
  SynopticDetailMode,
  TimelineMode,
  ValidTimeIso,
  ViewKey,
} from "../types";

export interface UrlPanelState {
  model: ModelKey;
  run: string | null;
  layers: LayerKey[];
}

export interface UrlSynopticState {
  isobars: boolean;
  thickness: boolean;
  centers: boolean;
}

export interface UrlViewport {
  lat: number;
  lon: number;
  zoom: number;
}

export interface UrlState {
  view: ViewKey | null;
  hour: ValidTimeIso | null;
  // Full panel roster: ?p1=model:layerA,layerB&p2=… (null = absent from URL).
  panels: UrlPanelState[] | null;
  // Map viewport: ?c=lat,lon,zoom (+ the zs zoom-scale marker, Task 6.2:
  // zs=2 ⇒ the zoom is native MapLibre scale; absent ⇒ a legacy pre-6.2
  // permalink whose zoom is leaflet scale, converted −1 on read). `center`
  // is ALWAYS native-scale after readUrlState.
  center: UrlViewport | null;
  timelineMode: TimelineMode | null;
  synoptic: UrlSynopticState | null;
  synopticDetailMode: SynopticDetailMode | null;
  reflectivityGate: ReflectivityGateDbz | null;
  timeZone: string | null;
  // Legacy single-panel params (?model=&layer=) kept so old links still open.
  // (A legacy ?engine= param from the migration era is simply ignored.)
  model: ModelKey | null;
  layer: LayerKey | null;
}

// The URL roster always mirrors the app's panel ceiling — a private constant
// here would silently drop panels from share links if MAX_PANELS ever grew.
const MAX_URL_PANELS = MAX_PANELS;

const EMPTY_URL_STATE: UrlState = {
  view: null,
  hour: null,
  panels: null,
  center: null,
  timelineMode: null,
  synoptic: null,
  synopticDetailMode: null,
  reflectivityGate: null,
  timeZone: null,
  model: null,
  layer: null,
};

function parsePanelParam(raw: string | null): UrlPanelState | null {
  if (!raw) {
    return null;
  }
  const separatorIndex = raw.indexOf(":");
  const modelAndRun = separatorIndex >= 0 ? raw.slice(0, separatorIndex) : raw;
  const layersRaw = separatorIndex >= 0 ? raw.slice(separatorIndex + 1) : "";
  const runSeparatorIndex = modelAndRun.indexOf("@");
  const model = runSeparatorIndex >= 0 ? modelAndRun.slice(0, runSeparatorIndex) : modelAndRun;
  const rawRun = runSeparatorIndex >= 0 ? modelAndRun.slice(runSeparatorIndex + 1) : "";
  if (!(MODEL_KEYS as string[]).includes(model)) {
    return null;
  }
  const layers = layersRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const run = /^\d{8}-\d{4}Z$/.test(rawRun) ? rawRun : null;
  return { model: model as ModelKey, run, layers };
}

function parseSynopticParam(raw: string | null): UrlSynopticState | null {
  if (raw === null) {
    return null;
  }
  const normalized = raw.toLowerCase();
  return {
    isobars: normalized.includes("i"),
    thickness: normalized.includes("t"),
    centers: normalized.includes("c"),
  };
}

function parseReflectivityGate(raw: string | null): ReflectivityGateDbz | null {
  const gate = Number(raw);
  return gate === 10 || gate === 15 || gate === 20 ? gate : null;
}

function parseTimeZone(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const normalized = normalizeTimeZoneSetting(raw);
  return normalized === raw ? normalized : null;
}

// Zoom-scale URL marker (Task 6.2). Written on every permalink since the
// native-zoom conversion; its ABSENCE identifies a legacy link whose `c`
// zoom is leaflet scale (= native + 1). "2" names the second zoom scale the
// app has spoken, leaving room for another migration to bump it. That bump
// is NOT a one-line constant change — see the whitelist note in
// parseCenterParam for what it must preserve.
const ZOOM_SCALE_PARAM = "zs";
const NATIVE_ZOOM_SCALE = "2";

function parseCenterParam(raw: string | null, zoomScale: string | null): UrlViewport | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split(",").map((value) => Number(value));
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const [lat, lon, rawZoom] = parts;
  // This comparison is an exact-match whitelist: any `zs` value other than
  // "2" — including a future "3" — parses as LEGACY leaflet zoom
  // (rawZoom − 1). A future scale bump must extend the whitelist here AND
  // keep emitting the old marker for back-compat links.
  //
  // Legacy pre-6.2 permalink: no scale marker ⇒ leaflet-scale zoom; −1 keeps
  // the exact visual extent in native units. A conversion that leaves the
  // valid range drops the viewport (same failure mode as malformed input:
  // the app falls back to the view's default fit).
  const zoom = zoomScale === NATIVE_ZOOM_SCALE ? rawZoom : rawZoom - 1;
  if (lat < -90 || lat > 90 || lon < -360 || lon > 360 || zoom < 0 || zoom > 22) {
    return null;
  }
  return { lat, lon, zoom };
}

export function readUrlState(): UrlState {
  if (typeof window === "undefined") {
    return { ...EMPTY_URL_STATE };
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const rawView = params.get("view");
    const rawModel = params.get("model");
    const rawLayer = params.get("layer");
    const rawHour = params.get("hour");
    const panels: UrlPanelState[] = [];
    for (let index = 1; index <= MAX_URL_PANELS; index += 1) {
      const panel = parsePanelParam(params.get(`p${index}`));
      if (panel) {
        panels.push(panel);
      }
    }
    return {
      view: rawView && (VIEW_KEYS as string[]).includes(rawView) ? (rawView as ViewKey) : null,
      hour: rawHour ? normalizeIsoHour(rawHour) : null,
      panels: panels.length > 0 ? panels : null,
      center: parseCenterParam(params.get("c"), params.get(ZOOM_SCALE_PARAM)),
      timelineMode: params.get("tl") === "panel" ? "panel" : null,
      synoptic: parseSynopticParam(params.get("syn")),
      synopticDetailMode: params.get("sd") === "d" ? "detailed" : params.get("sd") === "s" ? "simple" : null,
      reflectivityGate: parseReflectivityGate(params.get("rg")),
      timeZone: parseTimeZone(params.get("tz")),
      model: rawModel && (MODEL_KEYS as string[]).includes(rawModel) ? (rawModel as ModelKey) : null,
      layer: rawLayer ? rawLayer : null,
    };
  } catch {
    return { ...EMPTY_URL_STATE };
  }
}

export interface WriteUrlStateInput {
  view: ViewKey | null;
  hour: ValidTimeIso | null;
  panels: UrlPanelState[] | null;
  center: UrlViewport | null;
  timelineMode: TimelineMode | null;
  synoptic?: UrlSynopticState | null;
  synopticDetailMode?: SynopticDetailMode | null;
  reflectivityGate?: ReflectivityGateDbz | null;
  timeZone?: string | null;
}

export function writeUrlState(state: WriteUrlStateInput): void {
  if (typeof window === "undefined" || !window.history) {
    return;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    setOrDelete(params, "view", state.view);
    setOrDelete(params, "hour", state.hour);
    const panels = (state.panels ?? []).slice(0, MAX_URL_PANELS);
    for (let index = 1; index <= MAX_URL_PANELS; index += 1) {
      const panel = panels[index - 1];
      setOrDelete(
        params,
        `p${index}`,
        panel ? `${panel.model}${panel.run ? `@${panel.run}` : ""}:${panel.layers.join(",")}` : null,
      );
    }
    // The pN roster supersedes the legacy single-panel params on write; they
    // remain read-compatible for old bookmarks.
    if (panels.length > 0) {
      params.delete("model");
      params.delete("layer");
    }
    setOrDelete(
      params,
      "c",
      state.center
        ? `${state.center.lat.toFixed(3)},${state.center.lon.toFixed(3)},${roundZoom(state.center.zoom)}`
        : null,
    );
    // The zoom-scale marker rides with the viewport: written whenever `c` is
    // (marking its zoom native), deleted with it (a bare zs would mislabel a
    // later legacy-style edit of the URL).
    setOrDelete(params, ZOOM_SCALE_PARAM, state.center ? NATIVE_ZOOM_SCALE : null);
    setOrDelete(params, "tl", state.timelineMode === "panel" ? "panel" : null);
    setOrDelete(
      params,
      "syn",
      state.synoptic
        ? `${state.synoptic.isobars ? "i" : ""}${state.synoptic.thickness ? "t" : ""}${
            state.synoptic.centers ? "c" : ""
          }` || "none"
        : null,
    );
    setOrDelete(params, "sd", state.synopticDetailMode === "detailed" ? "d" : state.synopticDetailMode ? "s" : null);
    setOrDelete(params, "rg", state.reflectivityGate ? String(state.reflectivityGate) : null);
    setOrDelete(params, "tz", state.timeZone || null);
    const query = params.toString();
    const next = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    window.history.replaceState(window.history.state, "", next);
  } catch {
    // Ignore history failures; URL mirroring is a bookmarking nicety, never load-bearing.
  }
}

function roundZoom(zoom: number): string {
  const rounded = Math.round(zoom * 100) / 100;
  return String(rounded);
}

function setOrDelete(params: URLSearchParams, key: string, value: string | null): void {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}
