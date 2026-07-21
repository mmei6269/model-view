import { MapLibreEngine } from "./maplibre-engine";
import type { MapEngine } from "./types";

// The factory is the app's only construction point for a map engine. MapLibre
// is the sole implementation since Task 6.3 (Leaflet deleted); the MapEngine
// seam stays as the containment boundary for map-library churn.
export function createMapEngine(): MapEngine {
  return new MapLibreEngine();
}
