import { useCallback, useEffect, useRef, useState } from "react";
import { MODEL_KEYS } from "../config/constants";
import {
  fetchCacheStats,
  postCacheClear,
  postCachePrune,
  type CachePruneResult,
  type CacheStats,
} from "../core/actions-client";
import { fetchModelManifestWithOptions, fetchModelRunsWithOptions } from "../core/artifact-client";
import { pushToast } from "../core/toasts";
import type { ViewKey } from "../types";

export interface CacheActions {
  stats: CacheStats | null;
  statsLoading: boolean;
  statsError: string | null;
  refreshStats: (options?: { refresh?: boolean }) => void;
  prunePreview: CachePruneResult | null;
  previewPrune: () => void;
  confirmPrune: () => void;
  cancelPrunePreview: () => void;
  clearCache: (confirm: string) => void;
  busy: boolean;
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error);
}

// Cache panel state: lazy stats fetch while the panel is visible, a
// preview-then-confirm prune flow, and the typed-confirm clear. Destructive
// ops force-refresh stats AND the artifact client's run/manifest caches so
// panels and run pickers stop offering runs that no longer exist on disk.
export function useCacheActions(active: boolean, view: ViewKey): CacheActions {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [prunePreview, setPrunePreview] = useState<CachePruneResult | null>(null);
  const [busy, setBusy] = useState(false);
  const wasActiveRef = useRef(false);

  const refreshStats = useCallback((options?: { refresh?: boolean }) => {
    setStatsLoading(true);
    setStatsError(null);
    fetchCacheStats(options)
      .then((payload) => {
        setStats(payload);
      })
      .catch((error) => {
        setStatsError(errorText(error));
      })
      .finally(() => {
        setStatsLoading(false);
      });
  }, []);

  // Re-fetch on every open (rising edge), not just the first: renders and
  // prunes change the disk between opens, and the server's 60 s TTL makes a
  // repeat request cheap.
  useEffect(() => {
    if (active && !wasActiveRef.current) {
      refreshStats();
    }
    wasActiveRef.current = active;
  }, [active, refreshStats]);

  const afterMutation = useCallback(() => {
    refreshStats({ refresh: true });
    for (const model of MODEL_KEYS) {
      void fetchModelRunsWithOptions(model, view, { forceRefresh: true }).catch(() => undefined);
      void fetchModelManifestWithOptions(model, view, { forceRefresh: true }).catch(() => undefined);
    }
  }, [refreshStats, view]);

  const previewPrune = useCallback(() => {
    setBusy(true);
    postCachePrune({ dryRun: true })
      .then((result) => {
        setPrunePreview(result);
      })
      .catch((error) => {
        pushToast({ tone: "error", title: "Prune preview failed", detail: errorText(error) });
      })
      .finally(() => {
        setBusy(false);
      });
  }, []);

  const confirmPrune = useCallback(() => {
    setBusy(true);
    postCachePrune({ dryRun: false })
      .then((result) => {
        setPrunePreview(null);
        pushToast({
          tone: "success",
          title: "Cache pruned",
          detail: `Freed ${formatBytes(result.removedBytes)} across ${result.deletions.length} target(s).`,
        });
        afterMutation();
      })
      .catch((error) => {
        pushToast({ tone: "error", title: "Prune failed", detail: errorText(error) });
      })
      .finally(() => {
        setBusy(false);
      });
  }, [afterMutation]);

  const cancelPrunePreview = useCallback(() => {
    setPrunePreview(null);
  }, []);

  const clearCache = useCallback(
    (confirm: string) => {
      setBusy(true);
      postCacheClear(confirm)
        .then((result) => {
          pushToast({
            tone: "success",
            title: "Cache cleared",
            detail: `Freed ${formatBytes(result.removedBytes)}.`,
          });
          afterMutation();
        })
        .catch((error) => {
          pushToast({ tone: "error", title: "Clear failed", detail: errorText(error) });
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [afterMutation],
  );

  return {
    stats,
    statsLoading,
    statsError,
    refreshStats,
    prunePreview,
    previewPrune,
    confirmPrune,
    cancelPrunePreview,
    clearCache,
    busy,
  };
}

export function formatBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) {
    return `${(value / 1024 ** 3).toFixed(1)} GB`;
  }
  if (value >= 1024 ** 2) {
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}
