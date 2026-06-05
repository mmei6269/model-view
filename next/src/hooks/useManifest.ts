import { useEffect, useMemo, useState } from "react";
import { fetchModelManifestWithOptions } from "../core/artifact-client";
import type { ModelKey, ModelManifest, ViewKey } from "../types";

interface ManifestState {
  loading: boolean;
  error: string | null;
  manifest: ModelManifest | null;
}

const initialState: ManifestState = {
  loading: true,
  error: null,
  manifest: null,
};

const MANIFEST_POLL_MS = 5_000;

export function useManifest(modelKey: ModelKey, viewKey: ViewKey, runId: string | null = null): ManifestState {
  const [state, setState] = useState<ManifestState>(initialState);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const loadManifest = async (forceRefresh: boolean, showLoading: boolean) => {
      if (showLoading) {
        setState((prev) => ({ ...prev, loading: true, error: null }));
      }
      try {
        const manifest = await fetchModelManifestWithOptions(modelKey, viewKey, { forceRefresh, runId });
        if (cancelled) {
          return;
        }
        setState((prev) => {
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
        setState((prev) => {
          if (prev.manifest) {
            return { ...prev, loading: false };
          }
          return {
            loading: false,
            error: String(error instanceof Error ? error.message : "Unable to load manifest."),
            manifest: null,
          };
        });
      }
    };

    void loadManifest(false, true);
    intervalId = setInterval(() => {
      void loadManifest(true, false);
    }, MANIFEST_POLL_MS);

    return () => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [modelKey, runId, viewKey]);

  return useMemo(() => state, [state]);
}

function manifestRevision(manifest: ModelManifest | null): string {
  if (!manifest) {
    return "none";
  }
  const lastFrame = manifest.frames.length > 0 ? manifest.frames[manifest.frames.length - 1] : null;
  return [manifest.run, manifest.generatedAt, manifest.frames.length, lastFrame?.hour ?? -1].join("|");
}
