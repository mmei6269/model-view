import type { GeoBounds } from "../core/map-engine/types";
import type { LayerDefinition, ModelDefinition, ModelKey, ViewDefinition, ViewKey } from "../types";
import { LAYER_STACK_ORDER } from "./layers";

export const MODEL_CONFIG: Record<ModelKey, ModelDefinition> = {
  gfs: { label: "GFS", maxHour: 384, frameStepHours: 3, cycleHours: [0, 6, 12, 18] },
  nam: { label: "NAM", maxHour: 84, cycleHours: [0, 6, 12, 18] },
  nam3km: { label: "NAM 3km", maxHour: 60, cycleHours: [0, 6, 12, 18] },
  hrrr: { label: "HRRR", maxHour: 48, cycleHours: Array.from({ length: 24 }, (_, hour) => hour) },
};

// View zooms are NATIVE MapLibre zoom (the app-wide zoom unit since Task
// 6.2): conus 3 / na 2 render the exact ground scale the pre-migration
// leaflet-scale 4 / 3 did. Each view's zoom doubles as its minZoom clamp
// (use-panel-map applies it per view).
export const VIEW_CONFIG: Record<ViewKey, ViewDefinition> = {
  conus: {
    label: "CONUS",
    center: [38.8, -97.3],
    zoom: 3,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
  },
  na: {
    label: "NA",
    center: [45.5, -108.5],
    zoom: 2,
    bounds: { north: 74, south: 7, west: -170, east: -45 },
  },
};

// Stage B pan bounds (docs/basemap-expansion-plan.md): panning is capped by
// BASEMAP COVERAGE plus deliberate over-pan margins, not by the active
// view's data bbox — the view bbox stays the FIT target only. This fixes
// the min-zoom force-zoom cage (MapLibre constrains zoom up when maxBounds
// is narrower than the viewport) for BOTH views. The extract itself
// (prepare-basemap.js NA_BBOX) is "-180,3,-11,84"; east -8 over-pans past
// the extract edge (un-tiled strips render the water-tone style background
// and read as open ocean — basemap-style.ts background knobs).
//
// WEST MUST NOT CROSS THE ANTIMERIDIAN: with renderWorldCopies: false
// (maplibre-engine.ts), the camera constrain only wraps longitudes into an
// antimeridian-crossing lngRange when world copies are ON — with copies off
// a west bound like -195 makes every mid-CONUS longitude read as
// out-of-range and clamp to the wrapped west edge (~+179°). Live-caught by
// display-menu.spec.js "?c= restore lands exactly on the requested camera".
// -179.99 keeps the full extract pannable; California centers at z≈3.2+ on
// wide fullscreen panels (≈6° off-center at the exact z3 floor).
export const PAN_BOUNDS: GeoBounds = { south: 3, west: -179.99, north: 84, east: -8 };

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

// City scale: deep enough to pinpoint sounding locations, shallow enough that
// model pixels (3 km HRRR ≈ native z9) are already the limiting factor.
// This is the app-wide UI zoom clamp in NATIVE MapLibre zoom (Task 6.2; the
// same ground scale the pre-migration leaflet/compat z14 clamp allowed, per
// the design's owner decision "clamp native z13 ≈ compat z14"). The PMTiles
// NA extract carries native z14 tiles, so the clamped max renders from native
// tiles with a full level of sharpness headroom. Weather rasters are
// fixed-resolution images and simply magnify under `nearest` resampling at
// this depth (crisp model-pixel squares — verified deliberate, Task 5.1).
export const BASEMAP_MAX_ZOOM = 13;

export const WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-85, -180],
  [85, 180],
];
