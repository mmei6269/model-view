import { useEffect, type RefObject } from "react";
import L, { type Map as LeafletMap } from "leaflet";
import {
  DYNAMIC_PARAMETER_PANE,
  WEATHER_OVERLAY_CLASS,
  getLayerPane,
  getLayerZIndex,
  shouldUseRawPixelRendering,
} from "../../config/layers";
import { resolveLayerUrl } from "../../core/artifact-client";
import { markFrameLayerLoaded } from "../../core/frame-prefetch";
import type { FrameRecord, LayerKey, ReflectivityGateDbz, SynopticVectorPayload } from "../../types";

interface UseWeatherOverlaysArgs {
  activeLayers: Set<LayerKey>;
  frame: FrameRecord | null;
  mapReady: boolean;
  mapRef: RefObject<LeafletMap | null>;
  overlayRef: RefObject<Map<LayerKey, L.ImageOverlay>>;
  reflectivityGate: ReflectivityGateDbz;
  contourVectorLayerKeys?: Set<LayerKey>;
  synopticVector: SynopticVectorPayload | null;
}

export function useWeatherOverlays({
  activeLayers,
  frame,
  mapReady,
  mapRef,
  overlayRef,
  reflectivityGate,
  contourVectorLayerKeys,
  synopticVector,
}: UseWeatherOverlaysArgs): void {
  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const bounds = frame
      ? L.latLngBounds([frame.bounds.south, frame.bounds.west], [frame.bounds.north, frame.bounds.east])
      : null;
    const desired = new Set<LayerKey>();
    const hasVectorSynoptic = Boolean(synopticVector && activeLayers.has("synoptic"));
    const orderedLayers = Array.from(activeLayers);

    orderedLayers.forEach((layerKey, index) => {
      if (!activeLayers.has(layerKey)) {
        return;
      }
      if (layerKey === "synoptic" && hasVectorSynoptic) {
        return;
      }
      if (contourVectorLayerKeys?.has(layerKey)) {
        return;
      }
      const url = resolveLayerUrl(frame, layerKey, { reflectivityGate });
      if (!url || !bounds) {
        return;
      }
      desired.add(layerKey);
      const existing = overlayRef.current.get(layerKey);
      const pane = layerKey === "synoptic" ? getLayerPane(layerKey) : DYNAMIC_PARAMETER_PANE;
      const zIndex = layerKey === "synoptic" ? getLayerZIndex(layerKey) : getLayerZIndex("__dynamic__", index);
      const opacity = layerKey === "synoptic" ? 0.9 : 0.92;
      const markLoaded = () => markFrameLayerLoaded(frame, layerKey, reflectivityGate);
      if (!existing) {
        const overlay = L.imageOverlay(url, bounds, {
          opacity,
          interactive: false,
          pane,
          zIndex,
          className: shouldUseRawPixelRendering(layerKey)
            ? `${WEATHER_OVERLAY_CLASS} wx-overlay-${layerKey}`
            : `wx-overlay-${layerKey}`,
        });
        overlay.once("load", markLoaded);
        overlay.addTo(map);
        overlayRef.current.set(layerKey, overlay);
      } else {
        existing.off("load");
        existing.once("load", markLoaded);
        existing.setUrl(url);
        existing.setBounds(bounds);
        existing.setZIndex(zIndex);
      }
    });

    for (const [key, overlay] of overlayRef.current.entries()) {
      if (desired.has(key)) {
        continue;
      }
      overlay.off("load");
      map.removeLayer(overlay);
      overlayRef.current.delete(key);
    }
  }, [activeLayers, contourVectorLayerKeys, frame, mapReady, mapRef, overlayRef, reflectivityGate, synopticVector]);
}
