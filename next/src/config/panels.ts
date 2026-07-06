import { DEFAULT_PANEL_MODEL, MODEL_KEYS } from "./constants";
import type { LayerKey, ModelKey, PanelState } from "../types";

export const PANELS_STORAGE_KEY = "modelview.panels.v1";

export const DEFAULT_PANEL_LAYERS: LayerKey[] = ["temperature"];

export interface StoredPanelCollection {
  panels: PanelState[];
  counter: number;
}

function normalizeModelKey(value: unknown): ModelKey {
  return typeof value === "string" && (MODEL_KEYS as string[]).includes(value)
    ? (value as ModelKey)
    : DEFAULT_PANEL_MODEL;
}

function normalizeLayers(value: unknown): LayerKey[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_PANEL_LAYERS];
  }
  const out: LayerKey[] = [];
  for (const layer of value) {
    if (typeof layer === "string" && layer && !out.includes(layer)) {
      out.push(layer);
    }
  }
  return out;
}

export function buildDefaultPanelCollection(): StoredPanelCollection {
  return {
    counter: 1,
    panels: [{ id: "panel-1", modelKey: DEFAULT_PANEL_MODEL, layers: [...DEFAULT_PANEL_LAYERS] }],
  };
}

export function normalizePanelCollection(candidate: unknown): StoredPanelCollection {
  if (!candidate || typeof candidate !== "object") {
    return buildDefaultPanelCollection();
  }
  const raw = candidate as Partial<StoredPanelCollection>;
  const rawPanels = Array.isArray(raw.panels) ? raw.panels.slice(0, 2) : [];
  const panels: PanelState[] = [];
  let maxId = 0;
  for (let index = 0; index < rawPanels.length; index += 1) {
    const entry = (rawPanels[index] || {}) as Partial<PanelState>;
    const id = typeof entry.id === "string" && /^panel-\d+$/.test(entry.id) ? entry.id : `panel-${index + 1}`;
    const numeric = Number(id.slice("panel-".length));
    if (Number.isFinite(numeric)) {
      maxId = Math.max(maxId, numeric);
    }
    // runId is intentionally dropped: pinned runs reset to latest on reload.
    panels.push({ id, modelKey: normalizeModelKey(entry.modelKey), layers: normalizeLayers(entry.layers) });
  }
  if (panels.length === 0) {
    return buildDefaultPanelCollection();
  }
  const rawCounter = Number(raw.counter);
  const counter = Number.isFinite(rawCounter) ? Math.max(maxId, rawCounter) : maxId;
  return { panels, counter: Math.max(counter, 1) };
}

export function loadStoredPanelCollection(): StoredPanelCollection {
  if (typeof window === "undefined") {
    return buildDefaultPanelCollection();
  }
  try {
    const stored = window.localStorage.getItem(PANELS_STORAGE_KEY);
    return stored ? normalizePanelCollection(JSON.parse(stored)) : buildDefaultPanelCollection();
  } catch {
    return buildDefaultPanelCollection();
  }
}

export function storePanelCollection(state: StoredPanelCollection): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    // Strip runId before persisting so pinned runs never survive a reload.
    const payload: StoredPanelCollection = {
      counter: state.counter,
      panels: state.panels.map((panel) => ({ id: panel.id, modelKey: panel.modelKey, layers: [...panel.layers] })),
    };
    window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore private-mode and quota failures; panel layout should never block the app.
  }
}
