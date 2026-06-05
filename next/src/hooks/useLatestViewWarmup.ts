import { useEffect, useMemo } from "react";
import { warmLatestViewMemoryCache } from "../core/latest-run-memory-cache";
import type { ManifestUiInfo, PanelState, ValidTimeIso, ViewKey } from "../types";

interface LatestViewWarmupOptions {
  anchorValidTimeIso: ValidTimeIso | null;
  manifestInfoByPanel: Record<string, ManifestUiInfo>;
  panels: PanelState[];
  resolvePanelSelectedValidTime: (panelId: string) => ValidTimeIso | null;
  viewKey: ViewKey;
}

export function useLatestViewWarmup({
  anchorValidTimeIso,
  manifestInfoByPanel,
  panels,
  resolvePanelSelectedValidTime,
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
    if (!ready) {
      return;
    }
    let cancelled = false;
    const warm = (forceRefresh: boolean) => {
      void warmLatestViewMemoryCache({
        viewKey,
        anchorValidTimeIso,
        forceRefresh,
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
  }, [anchorValidTimeIso, ready, viewKey]);

  return ready;
}
