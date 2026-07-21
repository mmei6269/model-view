import { DEFAULT_VIEW, VIEW_KEYS } from "./constants";
import type { ReflectivityGateDbz, SynopticDetailMode, TimelineMode, ViewKey } from "../types";

// v2 (Task 6.2): per-view viewport zooms are NATIVE MapLibre zoom. v1 stored
// them in the retired compat scale (= leaflet zoom = native + 1), so the
// loader falls back to the v1 key and converts zooms −1 — same visual extent,
// new unit. Writes only ever go to v2; the v1 payload is deliberately left
// behind (harmless, and an older build pointed at this origin can still boot
// from it).
export const SESSION_STORAGE_KEY = "modelview.session.v2";
export const LEGACY_SESSION_STORAGE_KEY = "modelview.session.v1";

export interface SessionViewport {
  lat: number;
  lon: number;
  zoom: number;
}

export interface SessionState {
  viewKey: ViewKey;
  showIsobars: boolean;
  showCenters: boolean;
  showThickness: boolean;
  synopticDetailMode: SynopticDetailMode;
  reflectivityGate: ReflectivityGateDbz;
  settingsOpen: boolean;
  timelineMode: TimelineMode;
  viewportLink: boolean;
  // Last map center/zoom per view, restored on the next load of that view.
  viewports: Partial<Record<ViewKey, SessionViewport>>;
}

export const DEFAULT_SESSION_STATE: SessionState = {
  viewKey: DEFAULT_VIEW,
  showIsobars: true,
  showCenters: true,
  showThickness: true,
  synopticDetailMode: "simple",
  reflectivityGate: 15,
  settingsOpen: true,
  timelineMode: "overlap",
  viewportLink: true,
  viewports: {},
};

function normalizeBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeGate(value: unknown): ReflectivityGateDbz {
  return value === 10 || value === 15 || value === 20 ? value : DEFAULT_SESSION_STATE.reflectivityGate;
}

function normalizeViewports(value: unknown): Partial<Record<ViewKey, SessionViewport>> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: Partial<Record<ViewKey, SessionViewport>> = {};
  for (const viewKey of VIEW_KEYS) {
    const entry = (value as Record<string, unknown>)[viewKey];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const { lat, lon, zoom } = entry as Partial<SessionViewport>;
    if (
      typeof lat === "number" &&
      Number.isFinite(lat) &&
      Math.abs(lat) <= 90 &&
      typeof lon === "number" &&
      Number.isFinite(lon) &&
      Math.abs(lon) <= 360 &&
      typeof zoom === "number" &&
      Number.isFinite(zoom) &&
      zoom >= 0 &&
      zoom <= 22
    ) {
      out[viewKey] = { lat, lon, zoom };
    }
  }
  return out;
}

export function normalizeSessionState(candidate: unknown): SessionState {
  const fallback = DEFAULT_SESSION_STATE;
  if (!candidate || typeof candidate !== "object") {
    return { ...fallback };
  }
  const raw = candidate as Partial<SessionState>;
  return {
    viewKey: raw.viewKey === "na" ? "na" : "conus",
    showIsobars: normalizeBool(raw.showIsobars, fallback.showIsobars),
    showCenters: normalizeBool(raw.showCenters, fallback.showCenters),
    showThickness: normalizeBool(raw.showThickness, fallback.showThickness),
    synopticDetailMode: raw.synopticDetailMode === "detailed" ? "detailed" : "simple",
    reflectivityGate: normalizeGate(raw.reflectivityGate),
    settingsOpen: normalizeBool(raw.settingsOpen, fallback.settingsOpen),
    timelineMode: raw.timelineMode === "panel" ? "panel" : "overlap",
    viewportLink: normalizeBool(raw.viewportLink, fallback.viewportLink),
    viewports: normalizeViewports(raw.viewports),
  };
}

// One-time LOAD-side migration for legacy v1 payloads: viewport zooms arrive
// in the compat/leaflet scale and convert −1 to native. Runs BEFORE
// normalizeSessionState, so a converted zoom that leaves the valid range
// (legacy 0 → native −1) is dropped by the normal viewport validation instead
// of restoring a nonsense camera. Every other field is unit-less and passes
// through untouched.
function migrateLegacySessionPayload(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== "object") {
    return candidate;
  }
  const raw = candidate as { viewports?: unknown };
  if (!raw.viewports || typeof raw.viewports !== "object") {
    return candidate;
  }
  const viewports: Record<string, unknown> = {};
  for (const [viewKey, entry] of Object.entries(raw.viewports as Record<string, unknown>)) {
    if (entry && typeof entry === "object" && typeof (entry as SessionViewport).zoom === "number") {
      viewports[viewKey] = { ...(entry as object), zoom: (entry as SessionViewport).zoom - 1 };
    } else {
      viewports[viewKey] = entry;
    }
  }
  return { ...candidate, viewports };
}

export function loadStoredSessionState(): SessionState {
  if (typeof window === "undefined") {
    return { ...DEFAULT_SESSION_STATE };
  }
  try {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) {
      return normalizeSessionState(JSON.parse(stored));
    }
    const legacy = window.localStorage.getItem(LEGACY_SESSION_STORAGE_KEY);
    return legacy
      ? normalizeSessionState(migrateLegacySessionPayload(JSON.parse(legacy)))
      : { ...DEFAULT_SESSION_STATE };
  } catch {
    return { ...DEFAULT_SESSION_STATE };
  }
}

export function storeSessionState(state: SessionState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(normalizeSessionState(state)));
  } catch {
    // Ignore private-mode and quota failures; session state should never block the app.
  }
}
