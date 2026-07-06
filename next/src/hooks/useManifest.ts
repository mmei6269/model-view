import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchModelManifestWithOptions } from "../core/artifact-client";
import type { ModelKey, ModelManifest, ViewKey } from "../types";

interface ManifestData {
  loading: boolean;
  error: string | null;
  manifest: ModelManifest | null;
}

export interface ManifestState extends ManifestData {
  retry: () => void;
}

const initialData: ManifestData = {
  loading: true,
  error: null,
  manifest: null,
};

const MANIFEST_POLL_MS = 5_000;

export function useManifest(modelKey: ModelKey, viewKey: ViewKey, runId: string | null = null): ManifestState {
  const requestKey = [modelKey, viewKey, runId || "latest"].join("|");
  const [slot, setSlot] = useState<{ key: string; data: ManifestData }>({ key: requestKey, data: initialData });
  const reloadRef = useRef<(() => void) | null>(null);
  // A slot written for a previous model/run/view never surfaces, so stale
  // frames cannot render under the new selection's label.
  const data = slot.key === requestKey ? slot.data : initialData;

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const setData = (updater: (prev: ManifestData) => ManifestData) => {
      setSlot((prev) => {
        const base = prev.key === requestKey ? prev.data : initialData;
        const next = updater(base);
        if (prev.key === requestKey && next === prev.data) {
          return prev;
        }
        return { key: requestKey, data: next };
      });
    };

    const loadManifest = async (forceRefresh: boolean, showLoading: boolean) => {
      if (showLoading) {
        setData((prev) => ({ ...prev, loading: true, error: null }));
      }
      try {
        const manifest = await fetchModelManifestWithOptions(modelKey, viewKey, { forceRefresh, runId });
        if (cancelled) {
          return;
        }
        setData((prev) => {
          const prevRevision = manifestRevision(prev.manifest);
          const nextRevision = manifestRevision(manifest);
          if (prevRevision === nextRevision && prev.error === null && prev.loading === false) {
            return prev;
          }
          return { loading: false, error: null, manifest };
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = String(error instanceof Error ? error.message : "Unable to load manifest.");
        setData((prev) => ({ loading: false, error: message, manifest: prev.manifest }));
      }
    };

    reloadRef.current = () => {
      void loadManifest(true, true);
    };
    void loadManifest(false, true);
    intervalId = setInterval(() => {
      void loadManifest(true, false);
    }, MANIFEST_POLL_MS);

    return () => {
      cancelled = true;
      reloadRef.current = null;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [modelKey, requestKey, runId, viewKey]);

  const retry = useCallback(() => {
    reloadRef.current?.();
  }, []);

  return useMemo(() => ({ ...data, retry }), [data, retry]);
}

function manifestRevision(manifest: ModelManifest | null): string {
  if (!manifest) {
    return "none";
  }
  const lastFrame = manifest.frames.length > 0 ? manifest.frames[manifest.frames.length - 1] : null;
  return [manifest.run, manifest.generatedAt, manifest.frames.length, lastFrame?.hour ?? -1].join("|");
}
