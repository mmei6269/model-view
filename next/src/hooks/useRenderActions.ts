import { useCallback, useEffect, useRef, useState } from "react";
import type { RenderJobEntry } from "../components/RenderMenu";
import { MODEL_CONFIG } from "../config/constants";
import { effectiveRunForModel, type RenderSelection } from "../config/render";
import { JobStatusError, fetchJobStatus, postPrefetchSoundingsAction, postRenderAction } from "../core/actions-client";
import { fetchModelManifestWithOptions, fetchModelRunsWithOptions } from "../core/artifact-client";
import type { ModelKey, ViewKey } from "../types";

const JOB_POLL_MS = 2_000;

function modelLabels(models: ModelKey[]): string {
  return models.map((model) => MODEL_CONFIG[model]?.label || model).join(" + ");
}

type JobKind = "render" | "prefetch";

interface TrackedJob {
  jobId: string;
  label: string;
  kind: JobKind;
  // Models this job built, captured at submit time — the done-time
  // force-refresh must target these even if the live selection changed.
  models: ModelKey[];
  view: ViewKey;
  terminal: boolean;
}

interface RenderActions {
  jobs: RenderJobEntry[];
  submitRender: () => void;
  prefetchSoundings: () => void;
  canSubmit: boolean;
}

function pendingEntry(jobId: string, label: string): RenderJobEntry {
  return {
    jobId,
    label,
    status: "queued",
    built: 0,
    reused: 0,
    failed: 0,
    total: 0,
    markerCount: 0,
    markerTotal: 0,
    error: null,
  };
}

export function useRenderActions(selection: RenderSelection): RenderActions {
  const [jobs, setJobs] = useState<RenderJobEntry[]>([]);
  const [busy, setBusy] = useState(false);
  // Bumped once per launched batch to force the poll effect to (re)subscribe
  // after trackedRef is assigned. A same-value setBusy nudge would be dropped.
  const [jobEpoch, setJobEpoch] = useState(0);
  const trackedRef = useRef<TrackedJob[]>([]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    if (trackedRef.current.length === 0) {
      return;
    }
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      const active = trackedRef.current.filter((job) => !job.terminal);
      await Promise.all(
        active.map(async (tracked) => {
          try {
            const status = await fetchJobStatus(tracked.jobId);
            if (cancelled) {
              return;
            }
            setJobs((prev) =>
              prev.map((entry) =>
                entry.jobId === tracked.jobId ? { ...entry, ...status, label: entry.label } : entry,
              ),
            );
            if (status.status === "done" || status.status === "failed") {
              tracked.terminal = true;
              // Render jobs write artifacts; force fresh runs + manifests so the
              // panels pick them up immediately. Prefetch jobs warm the sounding
              // byte-range cache only (served live), so no manifest refresh.
              if (status.status === "done" && tracked.kind === "render") {
                await Promise.all(
                  tracked.models.flatMap((model) => [
                    fetchModelRunsWithOptions(model, tracked.view, { forceRefresh: true }).catch(() => undefined),
                    fetchModelManifestWithOptions(model, tracked.view, { forceRefresh: true }).catch(() => undefined),
                  ]),
                );
              }
            }
          } catch (error) {
            // A 404 means the job vanished — the registry is in-memory, so a
            // server restart drops it. Without terminating here, busy stays
            // true forever and the panel's buttons never re-enable.
            if (error instanceof JobStatusError && error.status === 404 && !cancelled) {
              tracked.terminal = true;
              setJobs((prev) =>
                prev.map((entry) =>
                  entry.jobId === tracked.jobId
                    ? {
                        ...entry,
                        status: "failed",
                        error: "Job no longer exists on the server (was it restarted?).",
                      }
                    : entry,
                ),
              );
            }
            // Other poll failures are transient; keep polling until terminal.
          }
        }),
      );
      if (cancelled) {
        return;
      }
      if (trackedRef.current.every((job) => job.terminal)) {
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
        setBusy(false);
      }
    };

    void poll();
    intervalId = setInterval(() => {
      void poll();
    }, JOB_POLL_MS);

    return () => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
    // Re-run whenever a new batch starts (jobEpoch increments after trackedRef set).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobEpoch]);

  const startJobs = useCallback(
    async (
      kind: JobKind,
      view: ViewKey,
      // Entries with failedError are shown as terminal failed rows (e.g. a
      // prefetch target the server skipped) and never polled.
      launch: () => Promise<Array<{ jobId: string; label: string; models: ModelKey[]; failedError?: string }>>,
    ) => {
      setBusy(true);
      setJobs([pendingEntry("pending", "")]);
      try {
        const launched = await launch();
        trackedRef.current = launched.map((job) => ({
          jobId: job.jobId,
          label: job.label,
          kind,
          models: job.models,
          view,
          terminal: Boolean(job.failedError),
        }));
        setJobs(
          launched.map((job) =>
            job.failedError
              ? { ...pendingEntry(job.jobId, job.label), status: "failed" as const, error: job.failedError }
              : pendingEntry(job.jobId, job.label),
          ),
        );
        setJobEpoch((epoch) => epoch + 1);
      } catch (error) {
        trackedRef.current = [];
        setBusy(false);
        setJobs([
          {
            ...pendingEntry("failed", ""),
            status: "failed",
            error: String(error instanceof Error ? error.message : error),
          },
        ]);
      }
    },
    [],
  );

  const submitRender = useCallback(() => {
    if (busy) {
      return;
    }
    const submitted = selectionRef.current;
    void startJobs("render", submitted.view, async () => {
      const { jobs: handles } = await postRenderAction(submitted);
      return handles.map((handle) => ({
        jobId: handle.jobId,
        // Label rows only when the submit split into multiple builds.
        label: handles.length > 1 ? `${modelLabels(handle.models)} · ${handle.run}` : "",
        models: handle.models,
      }));
    });
  }, [busy, startJobs]);

  const prefetchSoundings = useCallback(() => {
    if (busy) {
      return;
    }
    const submitted = selectionRef.current;
    if (submitted.models.length === 0) {
      return;
    }
    // Every selected model, each against its own picked run (the server
    // resolves "latest" to the concrete built run and reports it back, so the
    // job rows name exactly what is being warmed).
    const runs: Record<string, string> = {};
    for (const model of submitted.models) {
      runs[model] = effectiveRunForModel(submitted, model);
    }
    void startJobs("prefetch", submitted.view, async () => {
      const { jobs: handles, skipped } = await postPrefetchSoundingsAction({
        models: [...submitted.models],
        runs,
        view: submitted.view,
      });
      return [
        ...handles.map((handle) => ({
          jobId: handle.jobId,
          label: `${modelLabels(handle.models)} · ${handle.run} soundings`,
          models: handle.models,
        })),
        // Unwarmable targets surface as terminal rows so the user sees WHY a
        // model was skipped instead of it silently missing.
        ...skipped.map((entry, index) => ({
          jobId: `skipped-${entry.model}-${index}`,
          label: `${modelLabels([entry.model as ModelKey])} soundings`,
          models: [entry.model as ModelKey],
          failedError: entry.reason,
        })),
      ];
    });
  }, [busy, startJobs]);

  return { jobs, submitRender, prefetchSoundings, canSubmit: !busy };
}
