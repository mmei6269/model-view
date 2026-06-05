import type { Map as LeafletMap } from "leaflet";

interface RegisteredMap {
  map: LeafletMap;
  detach: () => void;
}

const INTERNAL_EVENT_WINDOW_MS = 120;
const MOVE_EPSILON_DEG = 0.0001;
const ZOOM_EPSILON = 0.001;

export interface ViewportSyncController {
  register: (panelId: string, map: LeafletMap) => void;
  unregister: (panelId: string) => void;
  setEnabled: (enabled: boolean) => void;
  invalidateAll: () => void;
}

export function createViewportSyncController(): ViewportSyncController {
  const maps = new Map<string, RegisteredMap>();
  const internalUntilByPanel = new Map<string, number>();
  let enabled = true;
  let pendingSource: { id: string; includeZoom: boolean } | null = null;
  let rafId = 0;

  function scheduleSync(panelId: string, includeZoom: boolean): void {
    pendingSource = { id: panelId, includeZoom: pendingSource?.includeZoom || includeZoom };
    if (rafId) {
      return;
    }
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      const source = pendingSource;
      pendingSource = null;
      if (!source || !enabled) {
        return;
      }
      syncFrom(source.id, source.includeZoom);
    });
  }

  function isInternalEvent(panelId: string): boolean {
    return Date.now() <= (internalUntilByPanel.get(panelId) || 0);
  }

  function markInternal(panelId: string): void {
    internalUntilByPanel.set(panelId, Date.now() + INTERNAL_EVENT_WINDOW_MS);
  }

  function syncFrom(sourcePanelId: string, includeZoom: boolean): void {
    const sourceEntry = maps.get(sourcePanelId);
    if (!sourceEntry) {
      return;
    }
    const sourceCenter = sourceEntry.map.getCenter();
    const sourceZoom = sourceEntry.map.getZoom();

    for (const [panelId, target] of maps.entries()) {
      if (panelId === sourcePanelId) {
        continue;
      }
      const currentCenter = target.map.getCenter();
      const currentZoom = target.map.getZoom();
      const latDelta = Math.abs(currentCenter.lat - sourceCenter.lat);
      const lonDelta = Math.abs(currentCenter.lng - sourceCenter.lng);
      const zoomDelta = Math.abs(currentZoom - sourceZoom);

      if (latDelta < MOVE_EPSILON_DEG && lonDelta < MOVE_EPSILON_DEG && (!includeZoom || zoomDelta < ZOOM_EPSILON)) {
        continue;
      }
      markInternal(panelId);
      if (includeZoom) {
        target.map.setView(sourceCenter, sourceZoom, { animate: false, noMoveStart: true });
      } else {
        target.map.setView(sourceCenter, currentZoom, { animate: false, noMoveStart: true });
      }
    }
  }

  function register(panelId: string, map: LeafletMap): void {
    unregister(panelId);
    const onMove = () => {
      if (!enabled || isInternalEvent(panelId)) {
        return;
      }
      scheduleSync(panelId, false);
    };
    const onMoveEnd = () => {
      if (!enabled || isInternalEvent(panelId)) {
        return;
      }
      scheduleSync(panelId, true);
    };
    const onZoomEnd = () => {
      if (!enabled || isInternalEvent(panelId)) {
        return;
      }
      scheduleSync(panelId, true);
    };

    map.on("move", onMove);
    map.on("moveend", onMoveEnd);
    map.on("zoomend", onZoomEnd);
    maps.set(panelId, {
      map,
      detach: () => {
        map.off("move", onMove);
        map.off("moveend", onMoveEnd);
        map.off("zoomend", onZoomEnd);
      },
    });
  }

  function unregister(panelId: string): void {
    const existing = maps.get(panelId);
    if (!existing) {
      return;
    }
    existing.detach();
    maps.delete(panelId);
    internalUntilByPanel.delete(panelId);
  }

  function setEnabled(next: boolean): void {
    enabled = Boolean(next);
    if (!enabled && rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
      pendingSource = null;
    }
  }

  function invalidateAll(): void {
    for (const entry of maps.values()) {
      entry.map.invalidateSize({ pan: false, debounceMoveend: true });
    }
  }

  return {
    register,
    unregister,
    setEnabled,
    invalidateAll,
  };
}
