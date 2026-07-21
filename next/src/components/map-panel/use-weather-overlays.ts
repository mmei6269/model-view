import { useEffect, useRef, type RefObject } from "react";
import { shouldUseRawPixelRendering } from "../../config/layers";
import { resolveLayerUrl } from "../../core/artifact-client";
import { markFrameLayerLoaded } from "../../core/frame-prefetch";
import type { MapEngine } from "../../core/map-engine/types";
import type { FrameRecord, LayerKey, ReflectivityGateDbz, SynopticVectorPayload } from "../../types";

interface UseWeatherOverlaysArgs {
  activeLayers: Set<LayerKey>;
  frame: FrameRecord | null;
  mapReady: boolean;
  engineRef: RefObject<MapEngine | null>;
  reflectivityGate: ReflectivityGateDbz;
  contourVectorLayerKeys?: Set<LayerKey>;
  synopticVector: SynopticVectorPayload | null;
  allowSynopticRasterFallback?: boolean;
}

// The hook decides WHICH weather rasters exist (active layers minus
// vector-rendered ones), which frame/URL each shows, and their opacity; the
// engine owns the overlays themselves. setWeatherImage is called for every
// desired layer on every pass, in stacking order — the engine derives the
// dynamic z-ordering from that call order.
export function useWeatherOverlays({
  activeLayers,
  frame,
  mapReady,
  engineRef,
  reflectivityGate,
  contourVectorLayerKeys,
  synopticVector,
  allowSynopticRasterFallback = true,
}: UseWeatherOverlaysArgs): void {
  // Keys currently pushed to the engine, for the eviction sweep, plus each
  // key's load-listener unsubscribe so every pass can re-arm markLoaded with
  // that pass's frame (the engine-verb equivalent of the old
  // off("load")/once("load", markLoaded) pair).
  const engineKeysRef = useRef<Set<LayerKey>>(new Set());
  const loadUnsubsRef = useRef<Map<LayerKey, () => void>>(new Map());

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const engine = engineRef.current;
    if (!engine) {
      return;
    }

    const bounds = frame ? frame.bounds : null;
    const desired = new Set<LayerKey>();
    const hasVectorSynoptic = Boolean(synopticVector && activeLayers.has("synoptic"));
    const orderedLayers = Array.from(activeLayers);

    orderedLayers.forEach((layerKey) => {
      if (!activeLayers.has(layerKey)) {
        return;
      }
      if (layerKey === "synoptic" && hasVectorSynoptic) {
        return;
      }
      // The legacy synoptic PNG combines isobars and thickness. It is an
      // honest fallback only when both line components are requested; with a
      // single component selected, hide it rather than draw unrequested
      // meteorological guidance while the independently toggleable vector
      // payload loads or fails.
      if (layerKey === "synoptic" && !allowSynopticRasterFallback) {
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
      const markLoaded = () => markFrameLayerLoaded(frame, layerKey, reflectivityGate);
      // Swap the registered load callback BEFORE the URL is set, so the
      // decode that completes for this URL marks this frame loaded.
      loadUnsubsRef.current.get(layerKey)?.();
      loadUnsubsRef.current.set(layerKey, engine.onWeatherImageLoaded(layerKey, markLoaded));
      engine.setWeatherImage(layerKey, url, bounds, {
        opacity: layerKey === "synoptic" ? 0.9 : 0.92,
        pixelated: shouldUseRawPixelRendering(layerKey),
      });
    });

    for (const key of engineKeysRef.current) {
      if (desired.has(key)) {
        continue;
      }
      loadUnsubsRef.current.get(key)?.();
      loadUnsubsRef.current.delete(key);
      engine.removeWeatherImage(key);
    }
    engineKeysRef.current = desired;
  }, [
    activeLayers,
    allowSynopticRasterFallback,
    contourVectorLayerKeys,
    engineRef,
    frame,
    mapReady,
    reflectivityGate,
    synopticVector,
  ]);
}
