import { DEFAULT_VIEW } from "./constants";
import type { ReflectivityGateDbz, SynopticDetailMode, TimelineMode, ViewKey } from "../types";

export const SESSION_STORAGE_KEY = "modelview.session.v1";

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
};

function normalizeBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeGate(value: unknown): ReflectivityGateDbz {
  return value === 10 || value === 15 || value === 20 ? value : DEFAULT_SESSION_STATE.reflectivityGate;
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
  };
}

export function loadStoredSessionState(): SessionState {
  if (typeof window === "undefined") {
    return { ...DEFAULT_SESSION_STATE };
  }
  try {
    const stored = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return stored ? normalizeSessionState(JSON.parse(stored)) : { ...DEFAULT_SESSION_STATE };
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
