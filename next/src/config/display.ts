export type DisplayPresetKey = "standard" | "analysis" | "presentation" | "custom";
// Topographic was removed app-wide in Task 5.2 (spec owner decision #7);
// stored "topographic" picks migrate to light (see migrateStoredDisplayPayload).
export type DisplayBasemapKey = "dark" | "light";
export type BoundaryDisplayMode = "auto" | "basemap" | "reference" | "off";

// Which GROUND the map overlays ink against (Task 4.3r3 per-theme inks):
// synoptic/contour strokes, symbol halos, and DOM map markers each carry a
// light and a dark variant.
export type BasemapInkTheme = "dark" | "light";

export function basemapInkTheme(basemap: DisplayBasemapKey): BasemapInkTheme {
  return basemap === "dark" ? "dark" : "light";
}

export interface MapFeatureSettings {
  // US county lines, fading in past mid zoom.
  counties: boolean;
  // Major highways/interstates for orientation.
  roads: boolean;
  // Denser ranked city labels (independent of the basemap label tiles).
  cities: boolean;
  // Lat/lon degree grid.
  graticule: boolean;
}

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
    // Basemap-boundary presentation (v5, border mode "basemap" only — the
    // modes are exclusive: one border source at a time, owner decision
    // 2026-07-09). Width as a scale factor over the generated style's own
    // line-widths; color "auto" keeps the theme default ink, else #rrggbb.
    basemapWidthScale: number;
    basemapColor: string;
  };
  features: MapFeatureSettings;
}

export const DISPLAY_STORAGE_KEY = "modelview.display.v1";
// Bumped when a default (or the option set) changes out from under stored
// settings: v2 made the dark basemap the default; v3 flipped the default
// (and every preset) to light — the weather color maps were designed for a
// white background (spec §8a.1); v4 removed the topographic basemap
// app-wide (Task 5.2) — stored "topographic" picks migrate to light, the
// light-toned ground maplibre panels already rendered for them; v5 (Map QA
// E3) added the basemap-boundary width/color fields alongside the exclusive
// border modes (basemap lines show ONLY in mode "basemap") — legacy payloads
// need no migration, normalize fills the defaults (1 / "auto").
export const DISPLAY_SCHEMA_VERSION = 5;
// Auto boundary mode hides custom state borders at/above this NATIVE maplibre
// zoom (Task 6.2; same ground scale as the pre-migration leaflet-scale 8).
export const AUTO_BOUNDARY_STATE_MAX_ZOOM = 7;

export const DISPLAY_BOUNDARY_COLORS = [
  { label: "Slate", value: "#64748b" },
  { label: "Charcoal", value: "#334155" },
  { label: "White", value: "#e2e8f0" },
  { label: "Cyan", value: "#22d3ee" },
] as const;

const DEFAULT_FEATURES: MapFeatureSettings = {
  counties: false,
  roads: false,
  cities: false,
  graticule: false,
};

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
      stateOpacity: 32,
      stateWeight: 0.55,
      color: "#94a3b8",
      basemapWidthScale: 1,
      basemapColor: "auto",
    },
    features: { ...DEFAULT_FEATURES },
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
      stateOpacity: 42,
      stateWeight: 0.65,
      color: "#94a3b8",
      basemapWidthScale: 1,
      basemapColor: "auto",
    },
    features: { ...DEFAULT_FEATURES, counties: true },
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
      color: "#94a3b8",
      basemapWidthScale: 1,
      basemapColor: "auto",
    },
    features: { ...DEFAULT_FEATURES },
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
    features: { ...settings.features },
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
  const featuresRaw =
    raw.features && typeof raw.features === "object" ? (raw.features as Partial<MapFeatureSettings>) : {};

  return {
    preset,
    basemap: normalizeBasemap(raw.basemap, presetBase.basemap),
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
      basemapWidthScale: clampNumber(boundaryRaw.basemapWidthScale, presetBase.boundaries.basemapWidthScale, 0.5, 3),
      basemapColor: normalizeBasemapBoundaryColor(boundaryRaw.basemapColor, presetBase.boundaries.basemapColor),
    },
    features: {
      counties: typeof featuresRaw.counties === "boolean" ? featuresRaw.counties : presetBase.features.counties,
      roads: typeof featuresRaw.roads === "boolean" ? featuresRaw.roads : presetBase.features.roads,
      cities: typeof featuresRaw.cities === "boolean" ? featuresRaw.cities : presetBase.features.cities,
      graticule: typeof featuresRaw.graticule === "boolean" ? featuresRaw.graticule : presetBase.features.graticule,
    },
  };
}

export function loadStoredDisplaySettings(): MapDisplaySettings {
  if (typeof window === "undefined") {
    return cloneDisplaySettings(DEFAULT_DISPLAY_SETTINGS);
  }
  try {
    const stored = window.localStorage.getItem(DISPLAY_STORAGE_KEY);
    if (!stored) {
      return cloneDisplaySettings(DEFAULT_DISPLAY_SETTINGS);
    }
    return normalizeDisplaySettings(migrateStoredDisplayPayload(JSON.parse(stored)));
  } catch {
    return cloneDisplaySettings(DEFAULT_DISPLAY_SETTINGS);
  }
}

// One-time LOAD-side migrations for persisted payloads. This must live here
// (not in normalizeDisplaySettings): normalize also runs on live in-memory
// edits from the Display menu, and treating those as legacy payloads would
// reset the basemap on every settings change.
function migrateStoredDisplayPayload(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== "object") {
    return candidate;
  }
  const raw = candidate as Record<string, unknown>;
  const storedVersion = Number(raw.schemaVersion) || 1;
  if (storedVersion >= DISPLAY_SCHEMA_VERSION) {
    return raw;
  }
  // The old v1 -> v2 rule ("drop a pre-v2 stored 'light', the then-default,
  // so the preset default applies") was deleted with v4 as INERT (flagged in
  // the 4.3r3 review): since v3 flipped every preset default back to light,
  // dropping a stored "light" resolved to light anyway — byte-identical
  // outcome to keeping it, on every preset.
  //
  // v4 (topo removal, Task 5.2): the topographic basemap no longer exists on
  // ANY engine, so a stored pick — whatever its version — migrates to light.
  // This covers the leaflet path too: pre-v4 only maplibre panels mapped
  // topo -> light at render time (use-map-display-layers); leaflet rendered
  // real topo tiles, and that surface is gone.
  if (raw.basemap === "topographic") {
    return { ...raw, basemap: "light" };
  }
  // v2 -> v3 (light default) was payload-preserving: every v2 payload
  // carries an explicit basemap, and explicit choices stick.
  return raw;
}

export function storeDisplaySettings(settings: MapDisplaySettings): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    // Persist normalized state stamped with the current schema version so the
    // one-time load-side migrations stay one-time.
    const payload = {
      ...normalizeDisplaySettings(settings),
      schemaVersion: DISPLAY_SCHEMA_VERSION,
    };
    window.localStorage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(payload));
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

function normalizeBasemap(value: unknown, fallback: DisplayBasemapKey): DisplayBasemapKey {
  if (value === "dark" || value === "light") {
    return value;
  }
  return fallback;
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

// basemapColor admits one non-hex value: "auto" = the basemap theme's own
// boundary ink (the engine maps it to color:null). Everything else runs
// through normalizeColor — so an invalid stored value falls back to the
// preset default ("auto" in every preset), never to a stale hex.
function normalizeBasemapBoundaryColor(value: unknown, fallback: string): string {
  if (value === "auto") {
    return "auto";
  }
  return normalizeColor(value, fallback);
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
