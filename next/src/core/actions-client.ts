import type { RenderJobView } from "../components/RenderMenu";
import { serializeRenderSelectionWire, type RenderSelection } from "../config/render";
import type { ModelKey, ViewKey } from "../types";
import { appendQueryParams, getArtifactBaseUrl } from "./artifact-url";

// One run manifest already built locally (server: listRunManifests). `run` is
// the run id string (e.g. "20260703-1200Z"); server sorts built newest-first.
// `upstreamFrameCount` is how many frames NOAA has published for the run
// (null when the probe failed or the run expired upstream) — more than
// `frameCount` means a re-render would pick up additional frames.
export type BuiltRun = {
  run: string;
  model: string;
  view: string;
  generatedAt: string;
  frameCount: number;
  loadedFrameCount: number;
  complete: boolean;
  latest: boolean;
  upstreamFrameCount: number | null;
};

// One NOAA-published cycle candidate (server: probeUpstreamRunsDefault). The
// run id lives under `runId` (`${date}-${cycle}00Z`), not `run`. `frameCount`
// is the probed published-frame count (null when the probe failed).
export type UpstreamRun = { runId: string; date: string; cycle: string; frameCount: number | null };

// One spawned build (server groups models by picked run; one job per group).
export type RenderJobHandle = { jobId: string; models: ModelKey[]; run: string };

export type AvailableRunsResult = {
  view: string;
  runs: Record<string, { built: BuiltRun[]; upstream: UpstreamRun[] }>;
};

function actionsUrl(path: string): string {
  return `${getArtifactBaseUrl()}/actions/${path.replace(/^\/+/, "")}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let reason = "";
    try {
      const payload = (await response.json()) as { error?: string };
      reason = payload.error ? `: ${payload.error}` : "";
    } catch {
      reason = "";
    }
    throw new Error(`Action request failed (${response.status})${reason}`);
  }
  return (await response.json()) as T;
}

function normalizeJobHandles(
  payload: { jobId?: string; jobs?: unknown },
  fallbackModels: ModelKey[],
): RenderJobHandle[] {
  const jobs = Array.isArray(payload.jobs)
    ? payload.jobs
        .map((raw): RenderJobHandle => {
          const record = (raw ?? {}) as Partial<RenderJobHandle>;
          return {
            jobId: String(record.jobId || ""),
            models: Array.isArray(record.models) ? (record.models as ModelKey[]) : [],
            run: String(record.run || "latest"),
          };
        })
        .filter((job) => job.jobId)
    : [];
  if (jobs.length > 0) {
    return jobs;
  }
  // Legacy single-job response shape.
  if (payload.jobId) {
    return [{ jobId: String(payload.jobId), models: fallbackModels, run: "latest" }];
  }
  throw new Error("Action returned no jobs.");
}

export async function postRenderAction(selection: RenderSelection): Promise<{ jobs: RenderJobHandle[] }> {
  const payload = await postJson<{ jobId?: string; jobs?: unknown }>(
    actionsUrl("render"),
    serializeRenderSelectionWire(selection),
  );
  return { jobs: normalizeJobHandles(payload, [...selection.models]) };
}

// One prefetch job per model. The server resolves "latest" to the concrete
// built run, warms what it can, and reports unwarmable models under
// `skipped` (the request only 400s when NOTHING is warmable).
export type SkippedPrefetchTarget = { model: string; reason: string };

export async function postPrefetchSoundingsAction(body: {
  models: ModelKey[];
  runs: Record<string, string>;
  view: ViewKey;
}): Promise<{ jobs: RenderJobHandle[]; skipped: SkippedPrefetchTarget[] }> {
  const payload = await postJson<{ jobId?: string; jobs?: unknown; skipped?: unknown }>(
    actionsUrl("prefetch-soundings"),
    body,
  );
  const skipped = Array.isArray(payload.skipped)
    ? payload.skipped
        .map((raw): SkippedPrefetchTarget => {
          const record = (raw ?? {}) as Partial<SkippedPrefetchTarget>;
          return { model: String(record.model || ""), reason: String(record.reason || "skipped") };
        })
        .filter((entry) => entry.model)
    : [];
  return { jobs: normalizeJobHandles(payload, [...body.models]), skipped };
}

// Thrown by fetchJobStatus so pollers can tell "job vanished" (404 — the
// in-memory registry was lost to a server restart) from a transient failure.
export class JobStatusError extends Error {
  status: number;
  constructor(status: number) {
    super(`Job status request failed (${status})`);
    this.status = status;
  }
}

export async function fetchJobStatus(jobId: string): Promise<RenderJobView & { jobId: string }> {
  const url = appendQueryParams(actionsUrl(`status/${encodeURIComponent(jobId)}`), { t: String(Date.now()) });
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new JobStatusError(response.status);
  }
  const payload = (await response.json()) as Partial<RenderJobView> & { jobId?: string };
  return {
    jobId: String(payload.jobId || jobId),
    status: (payload.status as RenderJobView["status"]) || "running",
    built: Number(payload.built) || 0,
    reused: Number(payload.reused) || 0,
    failed: Number(payload.failed) || 0,
    total: Number(payload.total) || 0,
    // On-disk marker scan: markerTotal is the build's resolved frame target,
    // available mid-run before the builder summary sets `total`.
    markerCount: Number(payload.markerCount) || 0,
    markerTotal: Number(payload.markerTotal) || 0,
    error: payload.error ?? null,
  };
}

export async function fetchAvailableRuns(models: ModelKey[], view: ViewKey): Promise<AvailableRunsResult> {
  const url = appendQueryParams(actionsUrl("available-runs"), {
    models: models.join(","),
    view,
    t: String(Date.now()),
  });
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Available runs request failed (${response.status})`);
  }
  const payload = (await response.json()) as {
    view?: string;
    runs?: Record<string, { built?: unknown; upstream?: unknown }>;
  };
  const runs: AvailableRunsResult["runs"] = {};
  for (const model of models) {
    const entry = payload.runs?.[model];
    const built = Array.isArray(entry?.built)
      ? entry.built
          .map((raw): BuiltRun => {
            const record = (raw ?? {}) as Partial<BuiltRun>;
            return {
              run: String(record.run || ""),
              model: String(record.model || model),
              view: String(record.view || view),
              generatedAt: String(record.generatedAt || ""),
              frameCount: Number(record.frameCount) || 0,
              loadedFrameCount: Number(record.loadedFrameCount) || 0,
              complete: record.complete === true,
              latest: record.latest === true,
              upstreamFrameCount:
                typeof record.upstreamFrameCount === "number" && Number.isFinite(record.upstreamFrameCount)
                  ? record.upstreamFrameCount
                  : null,
            };
          })
          .filter((run) => run.run)
      : [];
    const upstream = Array.isArray(entry?.upstream)
      ? entry.upstream
          .map((raw): UpstreamRun => {
            const record = (raw ?? {}) as Partial<UpstreamRun>;
            return {
              runId: String(record.runId || ""),
              date: String(record.date || ""),
              cycle: String(record.cycle || ""),
              frameCount:
                typeof record.frameCount === "number" && Number.isFinite(record.frameCount) ? record.frameCount : null,
            };
          })
          .filter((run) => run.runId)
      : [];
    runs[model] = { built, upstream };
  }
  return { view: String(payload.view || view), runs };
}
