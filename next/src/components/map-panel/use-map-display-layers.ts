import { useEffect, useRef, type RefObject } from "react";
import { AUTO_BOUNDARY_STATE_MAX_ZOOM, type MapDisplaySettings } from "../../config/display";
import { COUNTRY_BOUNDARY_LINE_LAYER_ID, STATE_BOUNDARY_LINE_LAYER_ID } from "../../config/layers";
import { fetchReferenceBoundaries } from "../../core/borders";
import type { LineLayerStyle, MapEngine } from "../../core/map-engine/types";
import type { ViewKey } from "../../types";

interface UseMapDisplayLayersArgs {
  viewKey: ViewKey;
  display: MapDisplaySettings;
  mapReady: boolean;
  mapZoom: number;
  engineRef: RefObject<MapEngine | null>;
}

// Display settings -> engine verbs. The hook keeps the POLICY (settings
// interpretation, boundary fetching, the auto-mode zoom gate); the engine
// owns the MECHANISM (tile layers + OSM outage fallback, GeoJSON rendering,
// pane opacity).
export function useMapDisplayLayers({ viewKey, display, mapReady, mapZoom, engineRef }: UseMapDisplayLayersArgs): void {
  // Boundary collections currently pushed to the engine; the restyle effect
  // re-submits the SAME references so the engine restyles in place instead of
  // re-parsing geometry.
  const countryDataRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const stateDataRef = useRef<GeoJSON.FeatureCollection | null>(null);

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    engine.setBasemap({
      // Both engines honor the light/dark picker (maplibre renders its two
      // purpose-built PMTiles styles, spec §8a.1; topo died app-wide in
      // Task 5.2 — stored "topographic" picks migrate to light in display.ts).
      theme: display.basemap,
      // Label tiles are always mounted; the Labels toggle drives the "labels"
      // group opacity below (matching the pre-engine pane behavior).
      labels: true,
    });
  }, [display.basemap, engineRef, mapReady]);

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    // Exclusive border modes (owner decision 2026-07-09): one border source
    // at a time. The basemap's own OSM boundary lines show ONLY in mode
    // "basemap"; auto/reference draw the app's NE reference overlay (the
    // effect below), so the basemap lines hide under it; "off" means off —
    // both sources hidden. "auto" is the theme default ink (engine
    // color:null); a hex pick overrides it.
    engine.setBasemapBoundaries({
      visible: display.boundaries.mode === "basemap",
      widthScale: display.boundaries.basemapWidthScale,
      color: display.boundaries.basemapColor === "auto" ? null : display.boundaries.basemapColor,
    });
  }, [
    display.boundaries.basemapColor,
    display.boundaries.basemapWidthScale,
    display.boundaries.mode,
    engineRef,
    mapReady,
  ]);

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const engine = engineRef.current;
    if (!engine || (display.boundaries.mode !== "auto" && display.boundaries.mode !== "reference")) {
      return;
    }

    let cancelled = false;
    void Promise.all([fetchReferenceBoundaries(viewKey, "country"), fetchReferenceBoundaries(viewKey, "admin1")]).then(
      ([countryData, stateData]) => {
        if (cancelled || !engineRef.current) {
          return;
        }
        if (countryData) {
          engineRef.current.setLineLayer(
            COUNTRY_BOUNDARY_LINE_LAYER_ID,
            countryData,
            boundaryLineStyle(display, "country", mapZoom),
          );
          countryDataRef.current = countryData;
        }
        if (stateData) {
          engineRef.current.setLineLayer(
            STATE_BOUNDARY_LINE_LAYER_ID,
            stateData,
            boundaryLineStyle(display, "admin1", mapZoom),
          );
          stateDataRef.current = stateData;
        }
      },
    );

    return () => {
      cancelled = true;
      const cleanupEngine = engineRef.current;
      if (cleanupEngine) {
        cleanupEngine.removeLayer(COUNTRY_BOUNDARY_LINE_LAYER_ID);
        cleanupEngine.removeLayer(STATE_BOUNDARY_LINE_LAYER_ID);
      }
      countryDataRef.current = null;
      stateDataRef.current = null;
    };
  }, [display.boundaries.mode, engineRef, mapReady, viewKey]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    if (countryDataRef.current) {
      engine.setLineLayer(
        COUNTRY_BOUNDARY_LINE_LAYER_ID,
        countryDataRef.current,
        boundaryLineStyle(display, "country", mapZoom),
      );
    }
    if (stateDataRef.current) {
      engine.setLineLayer(
        STATE_BOUNDARY_LINE_LAYER_ID,
        stateDataRef.current,
        boundaryLineStyle(display, "admin1", mapZoom),
      );
    }
  }, [
    display.boundaries.color,
    display.boundaries.countryOpacity,
    display.boundaries.countryWeight,
    display.boundaries.mode,
    display.boundaries.stateOpacity,
    display.boundaries.stateWeight,
    engineRef,
    mapZoom,
  ]);

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    engine.setGroupOpacity("labels", display.labels.visible ? display.labels.opacity / 100 : 0);
    engine.setGroupOpacity("weather", display.weather.opacity / 100);
    engine.setGroupOpacity("synoptic", display.synoptic.opacity / 100);
  }, [
    display.labels.opacity,
    display.labels.visible,
    display.synoptic.opacity,
    display.weather.opacity,
    engineRef,
    mapReady,
  ]);
}

function boundaryLineStyle(display: MapDisplaySettings, layer: "country" | "admin1", mapZoom: number): LineLayerStyle {
  const enabled =
    display.boundaries.mode === "reference" ||
    (display.boundaries.mode === "auto" && (layer === "country" || mapZoom < AUTO_BOUNDARY_STATE_MAX_ZOOM));
  const opacity = enabled
    ? (layer === "country" ? display.boundaries.countryOpacity : display.boundaries.stateOpacity) / 100
    : 0;
  const weight = layer === "country" ? display.boundaries.countryWeight : display.boundaries.stateWeight;
  return {
    color: display.boundaries.color,
    weight,
    opacity,
    group: "boundaries",
    anchor: "reference",
  };
}
