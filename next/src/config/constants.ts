import type { LayerDefinition, ModelDefinition, ModelKey, ViewDefinition, ViewKey } from "../types";
import { LAYER_STACK_ORDER } from "./layers";

export const MODEL_CONFIG: Record<ModelKey, ModelDefinition> = {
  gfs: { label: "GFS", maxHour: 384, frameStepHours: 3 },
  nam: { label: "NAM", maxHour: 84 },
  nam3km: { label: "NAM 3km", maxHour: 60 },
  hrrr: { label: "HRRR", maxHour: 48 },
};

export const VIEW_CONFIG: Record<ViewKey, ViewDefinition> = {
  conus: {
    label: "CONUS",
    center: [38.8, -97.3],
    zoom: 4,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
  },
  na: {
    label: "NA",
    center: [45.5, -108.5],
    zoom: 3,
    bounds: { north: 74, south: 7, west: -170, east: -45 },
  },
};

export const MODEL_KEYS = Object.keys(MODEL_CONFIG) as ModelKey[];
export const VIEW_KEYS = Object.keys(VIEW_CONFIG) as ViewKey[];

export const LAYER_OPTIONS: LayerDefinition[] = LAYER_STACK_ORDER.filter((key) => key !== "synoptic").map((key) => {
  if (key === "temperature") return { key, label: "Temp" };
  if (key === "reflectivity") return { key, label: "Reflectivity" };
  if (key === "wind") return { key, label: "Wind" };
  return { key, label: "Precip" };
});

export const DEFAULT_PANEL_MODEL: ModelKey = "gfs";
export const DEFAULT_VIEW: ViewKey = "conus";

export const BASEMAP_LIGHT = "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png";
export const BASEMAP_LABELS = "https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png";
export const BASEMAP_TOPO = "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png";
export const BASEMAP_FALLBACK = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

export const WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-85, -180],
  [85, 180],
];
