import { useEffect, useRef, type RefObject } from "react";
import L, { type Map as LeafletMap } from "leaflet";
import { BASEMAP_FALLBACK, BASEMAP_LABELS, BASEMAP_LIGHT, BASEMAP_TOPO } from "../../config/constants";
import { AUTO_BOUNDARY_STATE_MAX_ZOOM, type MapDisplaySettings } from "../../config/display";
import {
  COUNTRY_BORDERS_PANE,
  LABELS_PANE,
  LAYER_PANES,
  LAYER_STACK_ORDER,
  DYNAMIC_PARAMETER_PANE,
  HEIGHT_CONTOUR_PANE,
  STATE_BORDERS_PANE,
  SYNOPTIC_ISOBAR_PANE,
  SYNOPTIC_MARKER_PANE,
  SYNOPTIC_THICKNESS_PANE,
} from "../../config/layers";
import { fetchReferenceBoundaries } from "../../core/borders";
import type { ViewKey } from "../../types";

interface UseMapDisplayLayersArgs {
  viewKey: ViewKey;
  display: MapDisplaySettings;
  mapReady: boolean;
  mapZoom: number;
  mapRef: RefObject<LeafletMap | null>;
  baseLayerRef: RefObject<L.TileLayer | null>;
}

export function useMapDisplayLayers({
  viewKey,
  display,
  mapReady,
  mapZoom,
  mapRef,
  baseLayerRef,
}: UseMapDisplayLayersArgs): void {
  const countryBordersRef = useRef<L.GeoJSON | null>(null);
  const stateBordersRef = useRef<L.GeoJSON | null>(null);

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const tileUrl = display.basemap === "topographic" ? BASEMAP_TOPO : BASEMAP_LIGHT;
    if (baseLayerRef.current) {
      map.removeLayer(baseLayerRef.current);
    }
    const primaryAttribution =
      display.basemap === "topographic"
        ? "Map data: OpenStreetMap contributors, SRTM | Style: OpenTopoMap (CC-BY-SA)"
        : "&copy; OpenStreetMap contributors &copy; CARTO";
    const fallbackAttribution = "&copy; OpenStreetMap contributors";

    let fallbackActivated = false;
    let tileErrors = 0;
    let tileLoads = 0;
    let activeLayer: L.TileLayer | null = null;
    let fallbackLayer: L.TileLayer | null = null;

    const applyFallback = () => {
      if (fallbackActivated) {
        return;
      }
      fallbackActivated = true;
      if (activeLayer) {
        map.removeLayer(activeLayer);
      }
      fallbackLayer = L.tileLayer(BASEMAP_FALLBACK, {
        maxZoom: 12,
        noWrap: true,
        attribution: fallbackAttribution,
      });
      fallbackLayer.addTo(map);
      activeLayer = fallbackLayer;
      baseLayerRef.current = fallbackLayer;
    };

    const layer = L.tileLayer(tileUrl, {
      maxZoom: 12,
      noWrap: true,
      attribution: primaryAttribution,
    });
    layer.on("tileload", () => {
      tileLoads += 1;
    });
    layer.on("tileerror", () => {
      tileErrors += 1;
      if (fallbackActivated || tileErrors < 4) {
        return;
      }
      applyFallback();
    });

    layer.addTo(map);
    activeLayer = layer;
    baseLayerRef.current = layer;

    const labelsLayer = L.tileLayer(BASEMAP_LABELS, {
      maxZoom: 12,
      noWrap: true,
      pane: LABELS_PANE,
    });
    labelsLayer.addTo(map);

    const fallbackTimer = window.setTimeout(() => {
      if (!fallbackActivated && tileLoads === 0) {
        applyFallback();
      }
    }, 2200);

    return () => {
      window.clearTimeout(fallbackTimer);
      map.removeLayer(labelsLayer);
      if (activeLayer) {
        map.removeLayer(activeLayer);
      }
      if (fallbackLayer && fallbackLayer !== activeLayer) {
        map.removeLayer(fallbackLayer);
      }
      if (baseLayerRef.current === activeLayer || baseLayerRef.current === fallbackLayer) {
        baseLayerRef.current = null;
      }
    };
  }, [baseLayerRef, display.basemap, mapReady, mapRef]);

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const map = mapRef.current;
    if (!map || (display.boundaries.mode !== "auto" && display.boundaries.mode !== "reference")) {
      return;
    }

    let cancelled = false;
    const countryRenderer = L.svg({ pane: COUNTRY_BORDERS_PANE });
    const stateRenderer = L.svg({ pane: STATE_BORDERS_PANE });

    void Promise.all([fetchReferenceBoundaries(viewKey, "country"), fetchReferenceBoundaries(viewKey, "admin1")]).then(
      ([countryData, stateData]) => {
        if (cancelled || !mapRef.current) {
          return;
        }
        if (countryData) {
          const layer = L.geoJSON(countryData, {
            ...({ renderer: countryRenderer } as unknown as L.GeoJSONOptions),
            pane: COUNTRY_BORDERS_PANE,
            interactive: false,
            style: boundaryStyle(display, "country", mapZoom),
          });
          layer.addTo(map);
          countryBordersRef.current = layer;
        }
        if (stateData) {
          const layer = L.geoJSON(stateData, {
            ...({ renderer: stateRenderer } as unknown as L.GeoJSONOptions),
            pane: STATE_BORDERS_PANE,
            interactive: false,
            style: boundaryStyle(display, "admin1", mapZoom),
          });
          layer.addTo(map);
          stateBordersRef.current = layer;
        }
      },
    );

    return () => {
      cancelled = true;
      if (countryBordersRef.current && mapRef.current) {
        mapRef.current.removeLayer(countryBordersRef.current);
      }
      if (stateBordersRef.current && mapRef.current) {
        mapRef.current.removeLayer(stateBordersRef.current);
      }
      countryBordersRef.current = null;
      stateBordersRef.current = null;
    };
  }, [display.boundaries.mode, mapReady, mapRef, viewKey]);

  useEffect(() => {
    const country = countryBordersRef.current;
    if (country) {
      country.setStyle(boundaryStyle(display, "country", mapZoom));
    }
    const state = stateBordersRef.current;
    if (state) {
      state.setStyle(boundaryStyle(display, "admin1", mapZoom));
    }
  }, [
    display.boundaries.color,
    display.boundaries.countryOpacity,
    display.boundaries.countryWeight,
    display.boundaries.mode,
    display.boundaries.stateOpacity,
    display.boundaries.stateWeight,
    mapZoom,
  ]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      return;
    }
    const map = mapRef.current;
    const labelOpacity = display.labels.visible ? display.labels.opacity / 100 : 0;
    const labelsPane = map.getPane(LABELS_PANE);
    if (labelsPane) {
      labelsPane.style.opacity = String(labelOpacity);
    }

    const weatherOpacity = String(display.weather.opacity / 100);
    for (const layerKey of LAYER_STACK_ORDER) {
      if (layerKey === "synoptic") {
        continue;
      }
      const pane = map.getPane(LAYER_PANES[layerKey]);
      if (pane) {
        pane.style.opacity = weatherOpacity;
      }
    }
    const dynamicPane = map.getPane(DYNAMIC_PARAMETER_PANE);
    if (dynamicPane) {
      dynamicPane.style.opacity = weatherOpacity;
    }
    const heightContourPane = map.getPane(HEIGHT_CONTOUR_PANE);
    if (heightContourPane) {
      heightContourPane.style.opacity = weatherOpacity;
    }

    const synopticOpacity = String(display.synoptic.opacity / 100);
    for (const paneName of [
      LAYER_PANES.synoptic,
      SYNOPTIC_THICKNESS_PANE,
      SYNOPTIC_ISOBAR_PANE,
      SYNOPTIC_MARKER_PANE,
    ]) {
      const pane = map.getPane(paneName);
      if (pane) {
        pane.style.opacity = synopticOpacity;
      }
    }
  }, [
    display.labels.opacity,
    display.labels.visible,
    display.synoptic.opacity,
    display.weather.opacity,
    mapReady,
    mapRef,
  ]);
}

function boundaryStyle(display: MapDisplaySettings, layer: "country" | "admin1", mapZoom: number): L.PathOptions {
  const enabled =
    display.boundaries.mode === "reference" ||
    (display.boundaries.mode === "auto" && (layer === "country" || mapZoom < AUTO_BOUNDARY_STATE_MAX_ZOOM));
  const opacity = enabled
    ? (layer === "country" ? display.boundaries.countryOpacity : display.boundaries.stateOpacity) / 100
    : 0;
  const weight = layer === "country" ? display.boundaries.countryWeight : display.boundaries.stateWeight;
  return {
    fill: false,
    stroke: true,
    color: display.boundaries.color,
    weight,
    opacity,
    lineCap: "round",
    lineJoin: "round",
  };
}
