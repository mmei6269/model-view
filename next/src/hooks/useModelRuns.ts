import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchModelRunsWithOptions } from "../core/artifact-client";
import type { ModelKey, RunManifestPointer, ViewKey } from "../types";

interface ModelRunsData {
  loading: boolean;
  error: string | null;
  runs: RunManifestPointer[];
}

export interface ModelRunsState extends ModelRunsData {
  retry: () => void;
}

const initialState: ModelRunsData = {
  loading: true,
  error: null,
  runs: [],
};

const RUN_LIST_POLL_MS = 15_000;

export function useModelRuns(modelKey: ModelKey, viewKey: ViewKey): ModelRunsState {
  const [state, setState] = useState<ModelRunsData>(initialState);
  const reloadRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    // Drop the previous model/view run list so stale run options never linger
    // under a new selection when its own fetch fails.
    setState(initialState);

    const loadRuns = async (forceRefresh: boolean, showLoading: boolean) => {
      if (showLoading) {
        setState((prev) => ({ ...prev, loading: true, error: null }));
      }
      try {
        const runs = await fetchModelRunsWithOptions(modelKey, viewKey, { forceRefresh });
        if (cancelled) {
          return;
        }
        setState({ loading: false, error: null, runs });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState((prev) => ({
          loading: false,
          error: String(error instanceof Error ? error.message : "Unable to load runs."),
          runs: prev.runs,
        }));
      }
    };

    // Retry must target the loader bound to the current model/view; the ref is
    // rewritten on every effect run and cleared on cleanup, so a click can
    // never re-run a stale closure (same idiom as useManifest).
    reloadRef.current = () => {
      void loadRuns(true, true);
    };
    void loadRuns(false, true);
    intervalId = setInterval(() => {
      void loadRuns(true, false);
    }, RUN_LIST_POLL_MS);

    return () => {
      cancelled = true;
      reloadRef.current = null;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [modelKey, viewKey]);

  const retry = useCallback(() => {
    reloadRef.current?.();
  }, []);

  return useMemo(() => ({ ...state, retry }), [state, retry]);
}
