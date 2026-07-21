import type { EngineEvent, MapEngine } from "./map-engine/types";

interface RegisteredEngine {
  engine: MapEngine;
  detach: () => void;
}

const MOVE_EPSILON_DEG = 0.0001;
const ZOOM_EPSILON = 0.001;

export interface ViewportSyncController {
  register: (panelId: string, engine: MapEngine) => void;
  unregister: (panelId: string) => void;
  setEnabled: (enabled: boolean) => void;
  alignAll: () => void;
}

export function createViewportSyncController(): ViewportSyncController {
  const engines = new Map<string, RegisteredEngine>();
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

  function syncFrom(sourcePanelId: string, includeZoom: boolean): void {
    const sourceEntry = engines.get(sourcePanelId);
    if (!sourceEntry) {
      return;
    }
    const sourceCenter = sourceEntry.engine.getCenter();
    const sourceZoom = sourceEntry.engine.getZoom();

    for (const [panelId, target] of engines.entries()) {
      if (panelId === sourcePanelId) {
        continue;
      }
      const currentCenter = target.engine.getCenter();
      const currentZoom = target.engine.getZoom();
      const latDelta = Math.abs(currentCenter.lat - sourceCenter.lat);
      const lonDelta = Math.abs(currentCenter.lon - sourceCenter.lon);
      const zoomDelta = Math.abs(currentZoom - sourceZoom);

      if (latDelta < MOVE_EPSILON_DEG && lonDelta < MOVE_EPSILON_DEG && (!includeZoom || zoomDelta < ZOOM_EPSILON)) {
        continue;
      }
      // The engine stamps every event this jump fires with wxSync meta; the
      // guards in register() drop those, so the sync never echoes back.
      target.engine.jumpTo({ center: sourceCenter, zoom: includeZoom ? sourceZoom : currentZoom }, { wxSync: true });
    }
  }

  function register(panelId: string, engine: MapEngine): void {
    unregister(panelId);
    const guarded = (includeZoom: boolean) => (event: EngineEvent) => {
      if (!enabled || event.meta?.wxSync) {
        return;
      }
      scheduleSync(panelId, includeZoom);
    };
    const offMove = engine.on("move", guarded(false));
    const offMoveEnd = engine.on("moveend", guarded(true));
    const offZoomEnd = engine.on("zoomend", guarded(true));

    engines.set(panelId, {
      engine,
      detach: () => {
        offMove();
        offMoveEnd();
        offZoomEnd();
      },
    });
  }

  function unregister(panelId: string): void {
    const existing = engines.get(panelId);
    if (!existing) {
      return;
    }
    existing.detach();
    engines.delete(panelId);
  }

  function setEnabled(next: boolean): void {
    enabled = Boolean(next);
    if (!enabled && rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
      pendingSource = null;
    }
  }

  // Snap every panel to the primary (oldest-registered) panel's viewport.
  // Used when linking turns on after panels drifted apart while unlinked, and
  // after layout changes — without it, relinking only converges on the next
  // manual gesture, from whichever panel happens to move first.
  function alignAll(): void {
    if (!enabled || engines.size < 2) {
      return;
    }
    const first = engines.keys().next();
    if (!first.done) {
      syncFrom(first.value, true);
    }
  }

  return {
    register,
    unregister,
    setEnabled,
    alignAll,
  };
}
