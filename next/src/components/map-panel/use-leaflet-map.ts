import { useEffect, useRef, type RefObject } from "react";
import L, { type Map as LeafletMap } from "leaflet";
import { VIEW_CONFIG, WORLD_BOUNDS } from "../../config/constants";
import { FramePrefetchEngine } from "../../core/frame-prefetch";
import type { LayerKey, ViewKey } from "../../types";
import { EMPTY_HOVER, type HoverValues } from "./hover-utils";
import { clearSynopticMarkers, ensureLayerPanes, syncOverlayBounds } from "./map-layer-utils";

interface UseLeafletMapArgs {
  panelId: string;
  viewKey: ViewKey;
  layoutVersion: number;
  frameHour: number | null;
  mapReady: boolean;
  mapHostRef: RefObject<HTMLDivElement | null>;
  mapRef: RefObject<LeafletMap | null>;
  overlayRef: RefObject<Map<LayerKey, L.ImageOverlay>>;
  synopticMarkersRef: RefObject<L.Marker[]>;
  synopticVectorLayerRef: RefObject<L.LayerGroup | null>;
  hoverAbortRef: RefObject<AbortController | null>;
  vectorAbortRef: RefObject<AbortController | null>;
  prefetchEngineRef: RefObject<FramePrefetchEngine | null>;
  hasInitialViewportFitRef: RefObject<boolean>;
  lastViewportFitKeyRef: RefObject<string>;
  setMapReady: (ready: boolean) => void;
  setMapZoom: (zoom: number) => void;
  setHoverLatLng: (value: L.LatLng | null) => void;
  setHoverValues: (value: HoverValues) => void;
  setHoverLoading: (loading: boolean) => void;
  onMapReady: (panelId: string, map: LeafletMap) => void;
  onMapDestroyed: (panelId: string) => void;
  onMapDoubleClick?: (latLng: L.LatLng) => void;
}

export function useLeafletMap({
  panelId,
  viewKey,
  layoutVersion,
  frameHour,
  mapReady,
  mapHostRef,
  mapRef,
  overlayRef,
  synopticMarkersRef,
  synopticVectorLayerRef,
  hoverAbortRef,
  vectorAbortRef,
  prefetchEngineRef,
  hasInitialViewportFitRef,
  lastViewportFitKeyRef,
  setMapReady,
  setMapZoom,
  setHoverLatLng,
  setHoverValues,
  setHoverLoading,
  onMapReady,
  onMapDestroyed,
  onMapDoubleClick,
}: UseLeafletMapArgs): void {
  const onMapDoubleClickRef = useRef(onMapDoubleClick);

  useEffect(() => {
    onMapDoubleClickRef.current = onMapDoubleClick;
  }, [onMapDoubleClick]);

  useEffect(() => {
    if (!mapHostRef.current || mapRef.current) {
      return;
    }

    hasInitialViewportFitRef.current = false;
    lastViewportFitKeyRef.current = "";

    const view = VIEW_CONFIG[viewKey];
    const map = L.map(mapHostRef.current, {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
      worldCopyJump: false,
      maxBounds: L.latLngBounds(WORLD_BOUNDS),
      maxBoundsViscosity: 1,
      minZoom: 2,
      doubleClickZoom: false,
    }).setView(view.center, view.zoom);

    ensureLayerPanes(map);

    map.on("mousemove", (event) => {
      setHoverLatLng(event.latlng);
    });
    map.on("zoomend", () => {
      setMapZoom(map.getZoom());
    });
    map.on("mouseout", () => {
      setHoverLatLng(null);
      setHoverValues(EMPTY_HOVER);
      setHoverLoading(false);
    });
    map.on("dblclick", (event) => {
      onMapDoubleClickRef.current?.(event.latlng);
    });

    mapRef.current = map;
    setMapZoom(map.getZoom());
    setMapReady(true);
    onMapReady(panelId, map);

    return () => {
      hoverAbortRef.current?.abort();
      vectorAbortRef.current?.abort();
      prefetchEngineRef.current?.stop();
      clearSynopticMarkers(synopticMarkersRef.current, map);
      if (synopticVectorLayerRef.current) {
        map.removeLayer(synopticVectorLayerRef.current);
        synopticVectorLayerRef.current = null;
      }
      overlayRef.current.clear();
      map.remove();
      mapRef.current = null;
      hasInitialViewportFitRef.current = false;
      lastViewportFitKeyRef.current = "";
      setMapReady(false);
      onMapDestroyed(panelId);
    };
  }, [
    hasInitialViewportFitRef,
    hoverAbortRef,
    lastViewportFitKeyRef,
    mapHostRef,
    mapRef,
    onMapDestroyed,
    onMapReady,
    onMapDoubleClickRef,
    overlayRef,
    panelId,
    prefetchEngineRef,
    setHoverLatLng,
    setHoverLoading,
    setHoverValues,
    setMapReady,
    setMapZoom,
    synopticMarkersRef,
    synopticVectorLayerRef,
    vectorAbortRef,
    viewKey,
  ]);

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const view = VIEW_CONFIG[viewKey];
    const bounds = L.latLngBounds([view.bounds.south, view.bounds.west], [view.bounds.north, view.bounds.east]);
    map.setMaxBounds(bounds);
    map.setMinZoom(view.zoom);
  }, [mapReady, mapRef, viewKey]);

  useEffect(() => {
    if (!mapReady || !mapHostRef.current || !mapRef.current) {
      return;
    }
    const map = mapRef.current;
    const host = mapHostRef.current;
    const observer = new ResizeObserver(() => {
      map.invalidateSize({ pan: false, debounceMoveend: true });
      syncOverlayBounds(overlayRef.current);
    });
    observer.observe(host);
    map.invalidateSize({ pan: false, debounceMoveend: true });
    return () => {
      observer.disconnect();
    };
  }, [frameHour, mapHostRef, mapReady, mapRef, overlayRef]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      return;
    }
    const map = mapRef.current;
    map.invalidateSize({ pan: false, debounceMoveend: true });
    syncOverlayBounds(overlayRef.current);
  }, [frameHour, layoutVersion, mapReady, mapRef, overlayRef]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !mapHostRef.current) {
      return;
    }
    const map = mapRef.current;
    const host = mapHostRef.current;
    const target = VIEW_CONFIG[viewKey].bounds;
    const targetBounds = L.latLngBounds([target.south, target.west], [target.north, target.east]);
    const fitKey = `${viewKey}:${target.north}:${target.south}:${target.west}:${target.east}`;
    const shouldFit = !hasInitialViewportFitRef.current || lastViewportFitKeyRef.current !== fitKey;
    if (!shouldFit) {
      return;
    }

    let cancelled = false;
    const runFit = () => {
      if (cancelled || !mapRef.current || !mapHostRef.current) {
        return;
      }
      if (host.clientWidth < 80 || host.clientHeight < 80) {
        window.requestAnimationFrame(runFit);
        return;
      }
      map.invalidateSize({ pan: false, debounceMoveend: true });
      map.fitBounds(targetBounds, { animate: false, padding: [8, 8] });
      syncOverlayBounds(overlayRef.current);
      hasInitialViewportFitRef.current = true;
      lastViewportFitKeyRef.current = fitKey;
    };

    const timer = window.setTimeout(runFit, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    hasInitialViewportFitRef,
    lastViewportFitKeyRef,
    layoutVersion,
    mapHostRef,
    mapReady,
    mapRef,
    overlayRef,
    viewKey,
  ]);
}
