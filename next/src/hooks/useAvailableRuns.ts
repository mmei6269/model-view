import { useEffect, useMemo, useState } from "react";
import { fetchAvailableRuns, type BuiltRun, type UpstreamRun } from "../core/actions-client";
import type { ModelKey, ViewKey } from "../types";

export interface AvailableRunsState {
  loading: boolean;
  error: string | null;
  // Keyed by model: run ids differ per model (HRRR is hourly, NAM3km is 4×/day),
  // so consumers scope any picked run to a single model's list.
  runsByModel: Record<string, { built: BuiltRun[]; upstream: UpstreamRun[] }>;
}

const initialState: AvailableRunsState = {
  loading: false,
  error: null,
  runsByModel: {},
};

// Fetches /actions/available-runs when the run picker needs it (enabled) and
// refetches on model/view changes. No polling: a fetch per picker open is
// enough — the server caches upstream probes for 60s anyway.
export function useAvailableRuns(models: ModelKey[], view: ViewKey, enabled: boolean): AvailableRunsState {
  const [state, setState] = useState<AvailableRunsState>(initialState);
  const modelsKey = models.join(",");

  useEffect(() => {
    if (!enabled || !modelsKey) {
      setState(initialState);
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    const load = async () => {
      try {
        const result = await fetchAvailableRuns(modelsKey.split(",") as ModelKey[], view);
        if (cancelled) {
          return;
        }
        setState({ loading: false, error: null, runsByModel: result.runs });
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState({
          loading: false,
          error: String(error instanceof Error ? error.message : "Unable to load runs."),
          runsByModel: {},
        });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [enabled, modelsKey, view]);

  return useMemo(() => state, [state]);
}
