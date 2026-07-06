import { useCallback, useEffect, useState } from "react";
import { MODEL_KEYS } from "../config/constants";
import {
  DEFAULT_PANEL_LAYERS,
  loadStoredPanelCollection,
  storePanelCollection,
  type StoredPanelCollection,
} from "../config/panels";
import type { LayerKey, ModelKey, PanelState } from "../types";

function buildPanel(id: number, modelKey: ModelKey): PanelState {
  return { id: `panel-${id}`, modelKey, layers: [...DEFAULT_PANEL_LAYERS] };
}

type PanelCollectionState = StoredPanelCollection;

export function usePanelCollection() {
  // Panels and the id counter live in one state object so addPanel's updater
  // stays pure (no setState calls inside another updater). Hydrated from the
  // persisted collection (model + layers only; runId is never restored).
  const [state, setState] = useState<PanelCollectionState>(loadStoredPanelCollection);

  useEffect(() => {
    storePanelCollection(state);
  }, [state]);

  const addPanel = useCallback((): void => {
    setState((prev) => {
      if (prev.panels.length >= 2) {
        return prev;
      }
      const nextIndex = prev.counter + 1;
      const modelKey = MODEL_KEYS[nextIndex % MODEL_KEYS.length];
      return { counter: nextIndex, panels: [...prev.panels, buildPanel(nextIndex, modelKey)] };
    });
  }, []);

  const removePanel = useCallback((panelId: string): void => {
    setState((prev) => {
      if (prev.panels.length <= 1) {
        return prev;
      }
      return { ...prev, panels: prev.panels.filter((panel) => panel.id !== panelId) };
    });
  }, []);

  const updatePanelModel = useCallback((panelId: string, modelKey: ModelKey): void => {
    setState((prev) => ({
      ...prev,
      panels: prev.panels.map((panel) => (panel.id === panelId ? { ...panel, modelKey, runId: null } : panel)),
    }));
  }, []);

  const updatePanelRun = useCallback((panelId: string, runId: string | null): void => {
    setState((prev) => ({
      ...prev,
      panels: prev.panels.map((panel) => (panel.id === panelId ? { ...panel, runId } : panel)),
    }));
  }, []);

  const togglePanelLayer = useCallback((panelId: string, layer: LayerKey): void => {
    setState((prev) => ({
      ...prev,
      panels: prev.panels.map((panel) => {
        if (panel.id !== panelId) {
          return panel;
        }
        const next = new Set<LayerKey>(panel.layers);
        if (next.has(layer)) {
          next.delete(layer);
        } else {
          next.add(layer);
        }
        return { ...panel, layers: Array.from(next) };
      }),
    }));
  }, []);

  return {
    addPanel,
    panels: state.panels,
    removePanel,
    togglePanelLayer,
    updatePanelModel,
    updatePanelRun,
  };
}
