import { useEffect, useRef, type RefObject } from "react";
import { BASEMAP_MAX_ZOOM, PAN_BOUNDS, VIEW_CONFIG, WORLD_BOUNDS } from "../../config/constants";
import { FramePrefetchEngine } from "../../core/frame-prefetch";
import { createMapEngine } from "../../core/map-engine";
import type { EngineFatal, GeoBounds, LatLon, MapEngine } from "../../core/map-engine/types";
import type { ViewKey } from "../../types";
import { EMPTY_HOVER, type HoverValues } from "./hover-utils";

export interface MapViewport {
  lat: number;
  lon: number;
  zoom: number;
}

const WORLD_GEO_BOUNDS: GeoBounds = {
  south: WORLD_BOUNDS[0][0],
  west: WORLD_BOUNDS[0][1],
  north: WORLD_BOUNDS[1][0],
  east: WORLD_BOUNDS[1][1],
};

interface UsePanelMapArgs {
  panelId: string;
  viewKey: ViewKey;
  layoutVersion: number;
  mapReady: boolean;
  // Restored center/zoom for this view (URL ?c= or session); when present the
  // initial fit uses it instead of the view's default bounds fit.
  initialViewport?: MapViewport | null;
  onViewportChange?: (panelId: string, viewport: MapViewport) => void;
  mapHostRef: RefObject<HTMLDivElement | null>;
  mapRef: RefObject<MapEngine | null>;
  hoverAbortRef: RefObject<AbortController | null>;
  vectorAbortRef: RefObject<AbortController | null>;
  prefetchEngineRef: RefObject<FramePrefetchEngine | null>;
  hasInitialViewportFitRef: RefObject<boolean>;
  lastViewportFitKeyRef: RefObject<string>;
  setMapReady: (ready: boolean) => void;
  setMapZoom: (zoom: number) => void;
  setHoverLatLng: (value: LatLon | null) => void;
  setHoverValues: (value: HoverValues) => void;
  setHoverLoading: (loading: boolean) => void;
  onMapReady: (panelId: string, engine: MapEngine) => void;
  onMapDestroyed: (panelId: string) => void;
  onMapDoubleClick?: (latlon: LatLon) => void;
  // Fatal engine failure (e.g. the PMTiles basemap failed to load), classed
  // so the panel can key its banner headline on the failure; null clears the
  // panel's error state on engine (re)creation AND when the engine reports a
  // recovery (Task 5.2: basemap source loaded after a transient boot
  // failure).
  onEngineFatal?: (fatal: EngineFatal | null) => void;
}

export function usePanelMap({
  panelId,
  viewKey,
  layoutVersion,
  mapReady,
  initialViewport,
  onViewportChange,
  mapHostRef,
  mapRef,
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
  onEngineFatal,
}: UsePanelMapArgs): void {
  const onMapDoubleClickRef = useRef(onMapDoubleClick);
  // Latest-value refs so the map creation/fit effects never re-run just
  // because a callback or the restored viewport changed identity.
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;
  const initialViewportRef = useRef(initialViewport ?? null);
  initialViewportRef.current = initialViewport ?? null;
  const onEngineFatalRef = useRef(onEngineFatal);
  onEngineFatalRef.current = onEngineFatal;

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
    // A fresh engine clears any previous fatal state (remounts start over).
    onEngineFatalRef.current?.(null);
    const engine = createMapEngine();
    // Optional contract channel: the engine can fail hard (basemap boot) and
    // reports here; MapPanel renders the in-panel error state. Subscribed
    // BEFORE create() so a synchronous boot fatal (the GL map constructor
    // throwing — WebGL unavailable) is delivered through the same channel.
    let sawEngineFatal = false;
    const offFatal = engine.onFatal?.((fatal) => {
      sawEngineFatal = sawEngineFatal || fatal !== null;
      onEngineFatalRef.current?.(fatal);
    });
    try {
      engine.create(mapHostRef.current, {
        center: { lat: view.center[0], lon: view.center[1] },
        zoom: view.zoom,
        maxBounds: WORLD_GEO_BOUNDS,
        // Native maplibre zoom (Task 6.2): world floor 1 ≈ the retired
        // leaflet-scale 2; the per-view minZoom clamp (view.zoom, below)
        // supersedes it once the view effect runs.
        minZoom: 1,
        maxZoom: BASEMAP_MAX_ZOOM,
      });
    } catch (error) {
      // The engine could not boot a map at all (Task 6.1: maplibre's Map
      // constructor throws when no WebGL context can be created). The engine
      // classes and reports the fatal through onFatal above; if it threw
      // before classing, surface a generic classed fatal so the panel still
      // shows the banner instead of the whole tree dying on an unhandled
      // effect error. Tear down the half-built engine and leave the panel
      // mapless — the banner is the UI.
      console.error("usePanelMap: engine.create failed", error);
      if (!sawEngineFatal) {
        onEngineFatalRef.current?.({
          kind: "webgl-init",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      offFatal?.();
      engine.destroy();
      return;
    }

    engine.on("mousemove", (event) => {
      if (event.latlon) {
        setHoverLatLng(event.latlon);
      }
    });
    engine.on("zoomend", () => {
      setMapZoom(engine.getZoom());
    });
    engine.on("mouseout", () => {
      setHoverLatLng(null);
      setHoverValues(EMPTY_HOVER);
      setHoverLoading(false);
    });
    engine.on("dblclick", (event) => {
      if (event.latlon) {
        onMapDoubleClickRef.current?.(event.latlon);
      }
    });
    // moveend fires at the end of every pan/zoom gesture (and after jumpTo),
    // so the app can persist the viewport without per-frame churn. Gated on
    // the initial fit having applied: before it, the camera is creation
    // default / maxBounds-clamp noise — reporting it would overwrite the
    // App-level restored viewport (URL ?c= / session) with garbage before
    // runFit gets to consume it (observable since Task 4.4 made the
    // maxBounds snap synchronous; the old animated snap merely masked the
    // same race behind its 250 ms delay).
    engine.on("moveend", () => {
      if (!hasInitialViewportFitRef.current) {
        return;
      }
      const center = engine.getCenter();
      onViewportChangeRef.current?.(panelId, { lat: center.lat, lon: center.lon, zoom: engine.getZoom() });
    });

    mapRef.current = engine;
    setMapZoom(engine.getZoom());
    setMapReady(true);
    onMapReady(panelId, engine);

    return () => {
      offFatal?.();
      hoverAbortRef.current?.abort();
      vectorAbortRef.current?.abort();
      prefetchEngineRef.current?.stop();
      engine.destroy();
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
    panelId,
    prefetchEngineRef,
    setHoverLatLng,
    setHoverLoading,
    setHoverValues,
    setMapReady,
    setMapZoom,
    vectorAbortRef,
    viewKey,
  ]);

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const engine = mapRef.current;
    if (!engine) {
      return;
    }
    const view = VIEW_CONFIG[viewKey];
    // Stage A (docs/basemap-expansion-plan.md): the pan cage is PAN_BOUNDS
    // (basemap coverage), NOT the view's data bbox — view.bounds stays the
    // fitBounds target only. Caging to the view bbox made MapLibre force-zoom
    // above the view minZoom on wide panels (it constrains zoom up when
    // maxBounds is narrower than the viewport) and left ~zero pan freedom.
    // This immediately narrows the creation-time maxBounds (WORLD_GEO_BOUNDS,
    // engine.create above), which is left wide on purpose as the pre-effect
    // default. minZoom stays per-view.
    engine.setMaxBounds(PAN_BOUNDS);
    engine.setMinZoom(view.zoom);
  }, [mapReady, mapRef, viewKey]);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !mapHostRef.current) {
      return;
    }
    const engine = mapRef.current;
    const host = mapHostRef.current;
    const target = VIEW_CONFIG[viewKey].bounds;
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
      const restored = initialViewportRef.current;
      // Flags flip BEFORE the jump/fit so the fit's own synchronous moveend
      // passes the pre-fit gate on the viewport report (the applied camera
      // is real user-visible state; only pre-fit churn is suppressed).
      hasInitialViewportFitRef.current = true;
      lastViewportFitKeyRef.current = fitKey;
      if (restored) {
        // A restored viewport (URL ?c= or session) replaces the default
        // bounds fit; the engine clamps it to PAN_BOUNDS / the view's minZoom.
        engine.jumpTo({ center: { lat: restored.lat, lon: restored.lon }, zoom: restored.zoom });
      } else {
        engine.fitBounds(target, { padding: 8 });
      }
    };

    const timer = window.setTimeout(runFit, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hasInitialViewportFitRef, lastViewportFitKeyRef, layoutVersion, mapHostRef, mapReady, mapRef, panelId, viewKey]);
}
