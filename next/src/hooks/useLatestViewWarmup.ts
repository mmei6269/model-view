import { useEffect, useMemo } from "react";
import { warmLatestViewMemoryCache } from "../core/latest-run-memory-cache";
import type {
  LayerKey,
  ManifestUiInfo,
  PanelState,
  ReflectivityGateDbz,
  SynopticDetailMode,
  ValidTimeIso,
  ViewKey,
} from "../types";

interface LatestViewWarmupOptions {
  activeLayers: LayerKey[];
  anchorValidTimeIso: ValidTimeIso | null;
  manifestInfoByPanel: Record<string, ManifestUiInfo>;
  panels: PanelState[];
  reflectivityGate: ReflectivityGateDbz;
  resolvePanelSelectedValidTime: (panelId: string) => ValidTimeIso | null;
  synopticDetailMode: SynopticDetailMode;
  viewKey: ViewKey;
}

export function useLatestViewWarmup({
  activeLayers,
  anchorValidTimeIso,
  manifestInfoByPanel,
  panels,
  reflectivityGate,
  resolvePanelSelectedValidTime,
  synopticDetailMode,
  viewKey,
}: LatestViewWarmupOptions): boolean {
  const ready = useMemo(() => {
    for (const panel of panels) {
      const selected = resolvePanelSelectedValidTime(panel.id);
      if (!selected) {
        continue;
      }
      const status = manifestInfoByPanel[panel.id]?.frameStatusByValidTime?.[selected];
      if (status === "loaded") {
        return true;
      }
    }
    return false;
  }, [manifestInfoByPanel, panels, resolvePanelSelectedValidTime]);

  useEffect(() => {
    if (!ready || activeLayers.length === 0) {
      return;
    }
    let cancelled = false;
    const warm = (forceRefresh: boolean) => {
      void warmLatestViewMemoryCache({
        viewKey,
        anchorValidTimeIso,
        forceRefresh,
        activeLayers,
        reflectivityGate,
        synopticDetailMode,
      }).catch(() => {
        if (cancelled) {
          return;
        }
      });
    };
    warm(false);
    const intervalId = window.setInterval(() => warm(true), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeLayers, anchorValidTimeIso, ready, reflectivityGate, synopticDetailMode, viewKey]);

  return ready;
}
