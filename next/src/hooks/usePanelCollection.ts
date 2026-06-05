import { useCallback, useState } from "react";
import { DEFAULT_PANEL_MODEL, MODEL_KEYS } from "../config/constants";
import type { LayerKey, ModelKey, PanelState } from "../types";

const DEFAULT_PANEL_LAYERS: LayerKey[] = ["temperature"];

function buildPanel(id: number, modelKey: ModelKey): PanelState {
  return { id: `panel-${id}`, modelKey, layers: [...DEFAULT_PANEL_LAYERS] };
}

export function usePanelCollection() {
  const [panels, setPanels] = useState<PanelState[]>([buildPanel(1, DEFAULT_PANEL_MODEL)]);
  const [panelCounter, setPanelCounter] = useState(1);

  const addPanel = useCallback((): void => {
    setPanels((prev) => {
      if (prev.length >= 2) {
        return prev;
      }
      const nextIndex = panelCounter + 1;
      const modelKey = MODEL_KEYS[nextIndex % MODEL_KEYS.length];
      setPanelCounter(nextIndex);
      return [...prev, buildPanel(nextIndex, modelKey)];
    });
  }, [panelCounter]);

  const removePanel = useCallback((panelId: string): void => {
    setPanels((prev) => {
      if (prev.length <= 1) {
        return prev;
      }
      return prev.filter((panel) => panel.id !== panelId);
    });
  }, []);

  const updatePanelModel = useCallback((panelId: string, modelKey: ModelKey): void => {
    setPanels((prev) => prev.map((panel) => (panel.id === panelId ? { ...panel, modelKey, runId: null } : panel)));
  }, []);

  const updatePanelRun = useCallback((panelId: string, runId: string | null): void => {
    setPanels((prev) => prev.map((panel) => (panel.id === panelId ? { ...panel, runId } : panel)));
  }, []);

  const togglePanelLayer = useCallback((panelId: string, layer: LayerKey): void => {
    setPanels((prev) =>
      prev.map((panel) => {
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
    );
  }, []);

  return {
    addPanel,
    panels,
    removePanel,
    togglePanelLayer,
    updatePanelModel,
    updatePanelRun,
  };
}
