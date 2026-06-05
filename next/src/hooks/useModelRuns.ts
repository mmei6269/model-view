import { useEffect, useMemo, useState } from "react";
import { fetchModelRunsWithOptions } from "../core/artifact-client";
import type { ModelKey, RunManifestPointer, ViewKey } from "../types";

interface ModelRunsState {
  loading: boolean;
  error: string | null;
  runs: RunManifestPointer[];
}

const initialState: ModelRunsState = {
  loading: true,
  error: null,
  runs: [],
};

const RUN_LIST_POLL_MS = 15_000;

export function useModelRuns(modelKey: ModelKey, viewKey: ViewKey): ModelRunsState {
  const [state, setState] = useState<ModelRunsState>(initialState);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

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

    void loadRuns(false, true);
    intervalId = setInterval(() => {
      void loadRuns(true, false);
    }, RUN_LIST_POLL_MS);

    return () => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [modelKey, viewKey]);

  return useMemo(() => state, [state]);
}
