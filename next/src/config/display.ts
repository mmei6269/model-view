export type DisplayPresetKey = "standard" | "analysis" | "presentation" | "custom";
export type DisplayBasemapKey = "light" | "topographic";
export type BoundaryDisplayMode = "auto" | "basemap" | "reference" | "off";

export interface MapDisplaySettings {
  preset: DisplayPresetKey;
  basemap: DisplayBasemapKey;
  labels: {
    visible: boolean;
    opacity: number;
  };
  weather: {
    opacity: number;
  };
  synoptic: {
    opacity: number;
  };
  boundaries: {
    mode: BoundaryDisplayMode;
    countryOpacity: number;
    countryWeight: number;
    stateOpacity: number;
    stateWeight: number;
    color: string;
  };
}

export const DISPLAY_STORAGE_KEY = "modelview.display.v1";
export const AUTO_BOUNDARY_STATE_MAX_ZOOM = 8;

export const DISPLAY_BOUNDARY_COLORS = [
  { label: "Slate", value: "#64748b" },
  { label: "Charcoal", value: "#334155" },
  { label: "White", value: "#e2e8f0" },
  { label: "Cyan", value: "#22d3ee" },
] as const;

export const DISPLAY_PRESETS: Record<Exclude<DisplayPresetKey, "custom">, MapDisplaySettings> = {
  standard: {
    preset: "standard",
    basemap: "light",
    labels: { visible: true, opacity: 100 },
    weather: { opacity: 100 },
    synoptic: { opacity: 100 },
    boundaries: {
      mode: "auto",
      countryOpacity: 55,
      countryWeight: 1.2,
      stateOpacity: 28,
      stateWeight: 0.55,
      color: "#64748b",
    },
  },
  analysis: {
    preset: "analysis",
    basemap: "light",
    labels: { visible: true, opacity: 82 },
    weather: { opacity: 88 },
    synoptic: { opacity: 100 },
    boundaries: {
      mode: "reference",
      countryOpacity: 68,
      countryWeight: 1.35,
      stateOpacity: 38,
      stateWeight: 0.65,
      color: "#334155",
    },
  },
  presentation: {
    preset: "presentation",
    basemap: "light",
    labels: { visible: true, opacity: 100 },
    weather: { opacity: 94 },
    synoptic: { opacity: 86 },
    boundaries: {
      mode: "basemap",
      countryOpacity: 0,
      countryWeight: 1,
      stateOpacity: 0,
      stateWeight: 0.5,
      color: "#64748b",
    },
  },
};

export const DEFAULT_DISPLAY_SETTINGS = cloneDisplaySettings(DISPLAY_PRESETS.standard);

export function cloneDisplaySettings(settings: MapDisplaySettings): MapDisplaySettings {
  return {
    preset: settings.preset,
    basemap: settings.basemap,
    labels: { ...settings.labels },
    weather: { ...settings.weather },
    synoptic: { ...settings.synoptic },
    boundaries: { ...settings.boundaries },
  };
}

export function normalizeDisplaySettings(candidate: unknown): MapDisplaySettings {
  const fallback = DEFAULT_DISPLAY_SETTINGS;
  if (!candidate || typeof candidate !== "object") {
    return cloneDisplaySettings(fallback);
  }
  const raw = candidate as Partial<MapDisplaySettings>;
  const preset = normalizePreset(raw.preset);
  const presetBase = preset === "custom" ? fallback : DISPLAY_PRESETS[preset];
  const labelsRaw =
    raw.labels && typeof raw.labels === "object" ? (raw.labels as Partial<MapDisplaySettings["labels"]>) : {};
  const weatherRaw =
    raw.weather && typeof raw.weather === "object" ? (raw.weather as Partial<MapDisplaySettings["weather"]>) : {};
  const synopticRaw =
    raw.synoptic && typeof raw.synoptic === "object" ? (raw.synoptic as Partial<MapDisplaySettings["synoptic"]>) : {};
  const boundaryRaw =
    raw.boundaries && typeof raw.boundaries === "object"
      ? (raw.boundaries as Partial<MapDisplaySettings["boundaries"]>)
      : {};

  return {
    preset,
    basemap: raw.basemap === "topographic" ? "topographic" : "light",
    labels: {
      visible: typeof labelsRaw.visible === "boolean" ? labelsRaw.visible : presetBase.labels.visible,
      opacity: clampPercent(labelsRaw.opacity, presetBase.labels.opacity),
    },
    weather: {
      opacity: clampPercent(weatherRaw.opacity, presetBase.weather.opacity),
    },
    synoptic: {
      opacity: clampPercent(synopticRaw.opacity, presetBase.synoptic.opacity),
    },
    boundaries: {
      mode: normalizeBoundaryMode(boundaryRaw.mode, presetBase.boundaries.mode),
      countryOpacity: clampPercent(boundaryRaw.countryOpacity, presetBase.boundaries.countryOpacity),
      countryWeight: clampNumber(boundaryRaw.countryWeight, presetBase.boundaries.countryWeight, 0.5, 3),
      stateOpacity: clampPercent(boundaryRaw.stateOpacity, presetBase.boundaries.stateOpacity),
      stateWeight: clampNumber(boundaryRaw.stateWeight, presetBase.boundaries.stateWeight, 0.25, 2),
      color: normalizeColor(boundaryRaw.color, presetBase.boundaries.color),
    },
  };
}

export function loadStoredDisplaySettings(): MapDisplaySettings {
  if (typeof window === "undefined") {
    return cloneDisplaySettings(DEFAULT_DISPLAY_SETTINGS);
  }
  try {
    const stored = window.localStorage.getItem(DISPLAY_STORAGE_KEY);
    return stored ? normalizeDisplaySettings(JSON.parse(stored)) : cloneDisplaySettings(DEFAULT_DISPLAY_SETTINGS);
  } catch {
    return cloneDisplaySettings(DEFAULT_DISPLAY_SETTINGS);
  }
}

export function storeDisplaySettings(settings: MapDisplaySettings): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(normalizeDisplaySettings(settings)));
  } catch {
    // Ignore private-mode and quota failures; display settings should never block the app.
  }
}

function normalizePreset(value: unknown): DisplayPresetKey {
  if (value === "standard" || value === "analysis" || value === "presentation" || value === "custom") {
    return value;
  }
  return "standard";
}

function normalizeBoundaryMode(value: unknown, fallback: BoundaryDisplayMode): BoundaryDisplayMode {
  if (value === "auto" || value === "basemap" || value === "reference" || value === "off") {
    return value;
  }
  return fallback;
}

function normalizeColor(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim())) {
    return value.trim().toLowerCase();
  }
  return fallback;
}

function clampPercent(value: unknown, fallback: number): number {
  return Math.round(clampNumber(value, fallback, 0, 100));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, next));
}
