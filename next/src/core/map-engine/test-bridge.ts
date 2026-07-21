// window.__wx test bridge (Task 1.5): the ONLY surface Playwright specs may
// use to observe map/engine state, so the same specs pass against every
// MapEngine implementation. Installed unconditionally from App.tsx — the app
// is a localhost-only tool. Panel registration mirrors the app's onMapReady/
// onMapDestroyed lifecycle, so panels() lists ids in mount (== App panel
// collection) order. Everything beyond viewport/kind is derived from the
// engine's TEST-ONLY __introspect() snapshot (see types.ts).
import type { MapEngine, OpacityGroup } from "./types";

export interface WxTestBridge {
  panels(): string[];
  getViewport(id: string): { lat: number; lon: number; zoom: number };
  getEngineKind(id: string): MapEngine["kind"];
  getActiveWeatherLayers(id: string): string[];
  isWeatherLoaded(id: string, key: string): boolean;
  // Applied raw-pixel (nearest-neighbor) rendering for a weather key — the
  // live raster-resampling paint value.
  isWeatherPixelated(id: string, key: string): boolean;
  getLayerOrder(id: string): string[];
  getGroupOpacity(id: string, group: OpacityGroup): number;
  // Resolved opacity of an engine line layer (NaN while the layer is not
  // set). Covers the zoom-gated boundary assertions.
  getLineLayerOpacity(id: string, layerId: string): number;
  // Feature count of an engine symbol layer's current data (NaN while the
  // layer is not set). Task 4.3: lets specs assert H/L center features
  // rendered natively without scraping GL state.
  getSymbolFeatureCount(id: string, layerId: string): number;
  // Basemap-owned label (symbol) layers present + visible in the live style.
  // Task 5.2: the offline-boot spec's "place labels exist" signal — basemap
  // layers are deliberately not in getLayerOrder.
  getBasemapLabelLayers(id: string): string[];
  // Basemap-owned admin boundary (line) layers present + visible in the live
  // style. Map QA E3: the exclusive-border-modes signal — these show ONLY in
  // border mode "basemap".
  getBasemapBoundaryLayers(id: string): string[];
}

declare global {
  interface Window {
    __wx?: WxTestBridge;
  }
}

const engines = new Map<string, MapEngine>();

export function registerTestBridgePanel(panelId: string, engine: MapEngine): void {
  // Re-registering an id moves it to the end; that matches a panel remount,
  // which is also when the app re-appends it to the collection.
  engines.delete(panelId);
  engines.set(panelId, engine);
}

export function unregisterTestBridgePanel(panelId: string): void {
  engines.delete(panelId);
}

function requireEngine(panelId: string): MapEngine {
  const engine = engines.get(panelId);
  if (!engine) {
    const known = Array.from(engines.keys()).join(", ") || "none";
    throw new Error(`window.__wx: no live map for panel "${panelId}" (known panels: ${known}).`);
  }
  return engine;
}

export function installTestBridge(): void {
  window.__wx = {
    panels: () => Array.from(engines.keys()),
    getViewport: (id) => {
      const engine = requireEngine(id);
      const center = engine.getCenter();
      return { lat: center.lat, lon: center.lon, zoom: engine.getZoom() };
    },
    getEngineKind: (id) => requireEngine(id).kind,
    getActiveWeatherLayers: (id) => requireEngine(id).__introspect().weatherLayers,
    isWeatherLoaded: (id, key) => requireEngine(id).__introspect().loadedWeatherLayers.includes(key),
    isWeatherPixelated: (id, key) => Boolean(requireEngine(id).__introspect().weatherPixelated[key]),
    getLayerOrder: (id) => requireEngine(id).__introspect().layerOrder,
    getGroupOpacity: (id, group) => requireEngine(id).__introspect().groupOpacity[group],
    getLineLayerOpacity: (id, layerId) => {
      const resolved = requireEngine(id).__introspect().lineLayerOpacity[layerId];
      return resolved === undefined ? Number.NaN : resolved;
    },
    getSymbolFeatureCount: (id, layerId) => {
      const count = requireEngine(id).__introspect().symbolFeatureCounts[layerId];
      return count === undefined ? Number.NaN : count;
    },
    getBasemapLabelLayers: (id) => requireEngine(id).__introspect().basemapLabelLayers,
    getBasemapBoundaryLayers: (id) => requireEngine(id).__introspect().basemapBoundaryLayers,
  };
}
