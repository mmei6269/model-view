import { useCallback, useMemo, useState } from "react";
import { DEFAULT_PANEL_MODEL, MODEL_CONFIG, VIEW_CONFIG } from "../config/constants";
import { toEpochMs } from "../core/time";
import type { ManifestUiInfo, PanelState, ResolvedFrame, ValidTimeIso, ViewKey } from "../types";

export function usePanelManifests(panels: PanelState[], viewKey: ViewKey) {
  const [availableValidTimesByPanel, setAvailableValidTimesByPanel] = useState<Record<string, ValidTimeIso[]>>({});
  const [resolvedFrameByPanel, setResolvedFrameByPanel] = useState<Record<string, ResolvedFrame | null>>({});
  const [manifestInfoByPanel, setManifestInfoByPanel] = useState<Record<string, ManifestUiInfo>>({});

  const clearPanelData = useCallback((panelId: string): void => {
    setAvailableValidTimesByPanel((prev) => omitKey(prev, panelId));
    setResolvedFrameByPanel((prev) => omitKey(prev, panelId));
    setManifestInfoByPanel((prev) => omitKey(prev, panelId));
  }, []);

  const updatePanelAvailableValidTimes = useCallback((panelId: string, values: ValidTimeIso[]): void => {
    const normalized = Array.from(new Set((values || []).filter(Boolean))).sort(
      (left, right) => toEpochMs(left) - toEpochMs(right),
    );
    setAvailableValidTimesByPanel((prev) => {
      const current = prev[panelId] || [];
      if (current.length === normalized.length && current.every((value, index) => value === normalized[index])) {
        return prev;
      }
      return {
        ...prev,
        [panelId]: normalized,
      };
    });
  }, []);

  const updatePanelResolvedFrame = useCallback((panelId: string, frame: ResolvedFrame | null): void => {
    setResolvedFrameByPanel((prev) => {
      const current = prev[panelId];
      if (
        current?.hour === frame?.hour &&
        current?.validHourKey === frame?.validHourKey &&
        current?.deltaMinutes === frame?.deltaMinutes
      ) {
        return prev;
      }
      return {
        ...prev,
        [panelId]: frame,
      };
    });
  }, []);

  const updatePanelManifestInfo = useCallback((panelId: string, info: ManifestUiInfo): void => {
    setManifestInfoByPanel((prev) => {
      const existing = prev[panelId];
      if (
        existing?.runLabel === info.runLabel &&
        existing?.validLabel === info.validLabel &&
        existing?.validHourKey === info.validHourKey &&
        existing?.resolvedHour === info.resolvedHour &&
        existing?.loadedFrameCount === info.loadedFrameCount &&
        existing?.totalFrameCount === info.totalFrameCount &&
        existing?.statusRevision === info.statusRevision &&
        existing?.browserStatusRevision === info.browserStatusRevision
      ) {
        return prev;
      }
      return {
        ...prev,
        [panelId]: info,
      };
    });
  }, []);

  const summaryText = useMemo(() => {
    const primaryPanel = panels[0];
    const model = MODEL_CONFIG[primaryPanel?.modelKey || DEFAULT_PANEL_MODEL];
    const panelInfo = primaryPanel ? manifestInfoByPanel[primaryPanel.id] : null;
    const runText = panelInfo?.runLabel ? ` · Run ${panelInfo.runLabel}` : "";
    const validText = panelInfo?.validLabel ? ` · Valid ${panelInfo.validLabel}` : "";
    const frame = primaryPanel ? resolvedFrameByPanel[primaryPanel.id] : null;
    const frameText = frame ? ` · F${String(frame.hour).padStart(3, "0")}` : "";
    return `${model.label} · View ${VIEW_CONFIG[viewKey].label}${runText}${validText}${frameText}`;
  }, [manifestInfoByPanel, panels, resolvedFrameByPanel, viewKey]);

  return {
    availableValidTimesByPanel,
    clearPanelData,
    manifestInfoByPanel,
    resolvedFrameByPanel,
    summaryText,
    updatePanelAvailableValidTimes,
    updatePanelManifestInfo,
    updatePanelResolvedFrame,
  };
}

function omitKey<T extends Record<string, unknown>>(input: T, key: string): T {
  if (!(key in input)) {
    return input;
  }
  const next = { ...input };
  delete next[key];
  return next;
}
