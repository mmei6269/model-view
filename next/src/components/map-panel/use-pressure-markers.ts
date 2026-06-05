import { useEffect, type RefObject } from "react";
import L, { type Map as LeafletMap } from "leaflet";
import { SYNOPTIC_MARKER_PANE } from "../../config/layers";
import type { LayerKey, SynopticCenter, SynopticCenters } from "../../types";
import { clearSynopticMarkers } from "./map-layer-utils";
import { type CenterVisual, resolveCenterVisual, resolveSynopticCenters } from "./synoptic-utils";
import { pickReadableSynopticCenters } from "./synoptic-render";

interface UsePressureMarkersArgs {
  activeLayers: Set<LayerKey>;
  frameHour: number | null;
  frameSynopticCenters: SynopticCenters | null | undefined;
  mapReady: boolean;
  mapRef: RefObject<LeafletMap | null>;
  mapZoom: number;
  normalizedSynopticCenters: SynopticCenters | null | undefined;
  showCenters: boolean;
  synopticMarkersRef: RefObject<L.Marker[]>;
}

const MARKER_HTML = (kind: "high" | "low", value: number, style: CenterVisual): string => {
  const markerColor = kind === "high" ? style.highColor : style.lowColor;
  const markerText = kind === "high" ? "H" : "L";
  const markerClass = kind === "high" ? "pressure-high" : "pressure-low";
  return `
<div class="pressure-marker ${markerClass}" style="--pressure-marker-size:${style.markerSize}px;--pressure-value-size:${style.valueSize}px;--pressure-marker-color:${markerColor};--pressure-value-color:${markerColor};--pressure-value-offset:${style.valueOffset}px">
  <div class="pressure-marker-value">${Math.round(value)}</div>
  <div class="pressure-marker-symbol">${markerText}</div>
</div>`;
};

export function usePressureMarkers({
  activeLayers,
  frameHour,
  frameSynopticCenters,
  mapReady,
  mapRef,
  mapZoom,
  normalizedSynopticCenters,
  showCenters,
  synopticMarkersRef,
}: UsePressureMarkersArgs): void {
  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const map = mapRef.current;
    if (!map) {
      return;
    }
    clearSynopticMarkers(synopticMarkersRef.current, map);
    synopticMarkersRef.current = [];

    if (!activeLayers.has("synoptic") || !showCenters) {
      return;
    }
    const centers = resolveSynopticCenters(normalizedSynopticCenters, frameSynopticCenters || null);
    if (!centers) {
      return;
    }
    const centerVisual = resolveCenterVisual(mapZoom);
    const visibleCenters = pickReadableSynopticCenters(map, centers, mapZoom);

    const nextMarkers: L.Marker[] = [];
    for (const entry of visibleCenters) {
      const marker = buildPressureMarker(entry.center, entry.kind, centerVisual);
      if (!marker) {
        continue;
      }
      marker.addTo(map);
      nextMarkers.push(marker);
    }
    synopticMarkersRef.current = nextMarkers;
  }, [
    activeLayers,
    frameHour,
    frameSynopticCenters,
    mapReady,
    mapRef,
    mapZoom,
    normalizedSynopticCenters,
    showCenters,
    synopticMarkersRef,
  ]);
}

function buildPressureMarker(entry: SynopticCenter, kind: "high" | "low", centerVisual: CenterVisual): L.Marker | null {
  if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lon) || !Number.isFinite(entry.valueHpa)) {
    return null;
  }
  return L.marker([entry.lat, entry.lon], {
    pane: SYNOPTIC_MARKER_PANE,
    interactive: false,
    keyboard: false,
    icon: L.divIcon({
      className: "pressure-marker-icon",
      html: MARKER_HTML(kind, entry.valueHpa, centerVisual),
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
}
