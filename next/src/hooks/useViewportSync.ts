import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as LeafletMapType } from "leaflet";
import { createViewportSyncController } from "../core/viewport-sync";

export function useViewportSync(panelCount: number) {
  const [linkViewports, setLinkViewports] = useState(true);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const syncControllerRef = useRef(createViewportSyncController());

  useEffect(() => {
    const enabled = linkViewports && panelCount > 1;
    syncControllerRef.current.setEnabled(enabled);
    if (!enabled) {
      return;
    }
    window.setTimeout(() => {
      syncControllerRef.current.invalidateAll();
    }, 0);
  }, [linkViewports, panelCount]);

  useEffect(() => {
    setLayoutVersion((prev) => prev + 1);
    window.setTimeout(() => {
      syncControllerRef.current.invalidateAll();
    }, 20);
  }, [panelCount]);

  const handleMapReady = useCallback((panelId: string, map: LeafletMapType) => {
    syncControllerRef.current.register(panelId, map);
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
