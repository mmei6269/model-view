import { useCallback, useEffect, useRef, useState } from "react";
import type { MapEngine } from "../core/map-engine/types";
import { createViewportSyncController } from "../core/viewport-sync";

export function useViewportSync(panelCount: number, initialLinkViewports = true) {
  const [linkViewports, setLinkViewports] = useState(initialLinkViewports);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const syncControllerRef = useRef(createViewportSyncController());

  useEffect(() => {
    const enabled = linkViewports && panelCount > 1;
    syncControllerRef.current.setEnabled(enabled);
    if (!enabled) {
      return;
    }
    // Converge immediately (from the primary panel) instead of waiting for
    // the next manual pan: covers relinking after unlinked drift and panels
    // whose containers just changed shape. Size invalidation now lives inside
    // each engine (ResizeObserver in create()), so aligning is all that's left.
    window.setTimeout(() => {
      syncControllerRef.current.alignAll();
    }, 0);
  }, [linkViewports, panelCount]);

  useEffect(() => {
    setLayoutVersion((prev) => prev + 1);
  }, [panelCount]);

  const handleMapReady = useCallback((panelId: string, engine: MapEngine) => {
    syncControllerRef.current.register(panelId, engine);
  }, []);

  const handleMapDestroyed = useCallback((panelId: string) => {
    syncControllerRef.current.unregister(panelId);
  }, []);

  return {
    handleMapDestroyed,
    handleMapReady,
    layoutVersion,
    linkViewports,
    setLinkViewports,
    unregisterPanel: handleMapDestroyed,
  };
}
