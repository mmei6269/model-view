import type { FrameRecord, LayerKey, PrefetchState, ReflectivityGateDbz, SynopticDetailMode } from "../types";
import {
  prefetchFrameAssets,
  prefetchHoverGridPayload,
  prefetchSynopticVectorPayload,
  prefetchWeatherVectorPayload,
  resolveHoverGridRequestUrls,
  resolveLayerRequestUrl,
  resolveSynopticVectorKey,
  resolveSynopticVectorRequestUrl,
  resolveWeatherVectorRequestUrl,
} from "./artifact-client";

interface PrefetchTask {
  kind: "layer" | "vector" | "weather-vector" | "hover";
  frame: FrameRecord;
  layer?: LayerKey;
  reflectivityGate?: ReflectivityGateDbz;
  synopticDetailMode?: SynopticDetailMode;
  vectorKey?: string;
  taskKey: string;
  priority: number;
  cacheKey: string;
  affectsStatus: boolean;
  revision: number;
}

interface PrefetchPlan {
  cacheKey: string;
  frames: FrameRecord[];
  activeLayers: Set<LayerKey>;
  currentHour: number;
  reflectivityGate?: ReflectivityGateDbz;
  synopticDetailMode?: SynopticDetailMode;
  onStatus?: (hour: number, status: PrefetchState) => void;
}

const DEFAULT_CONCURRENCY = 12;
const GLOBAL_LOADED_CACHE_KEYS = new Set<string>();
const GLOBAL_LOADED_CACHE_LISTENERS = new Set<() => void>();
let globalLoadedCacheNotifyScheduled = false;
type TaskOutcome = "success" | "error" | "cancelled";

export function markFramePrefetchCacheKeyLoaded(cacheKey: string): void {
  const key = String(cacheKey || "");
  if (!key || GLOBAL_LOADED_CACHE_KEYS.has(key)) {
    return;
  }
  GLOBAL_LOADED_CACHE_KEYS.add(key);
  scheduleGlobalLoadedCacheNotify();
}

export function subscribeFramePrefetchCacheChanges(listener: () => void): () => void {
  GLOBAL_LOADED_CACHE_LISTENERS.add(listener);
  return () => {
    GLOBAL_LOADED_CACHE_LISTENERS.delete(listener);
  };
}

export function getCachedFramePrefetchState(
  frame: FrameRecord | null | undefined,
  activeLayers: Set<LayerKey>,
  reflectivityGate: ReflectivityGateDbz = 15,
  synopticDetailMode: SynopticDetailMode = "simple",
): PrefetchState {
  if (!frame) {
    return "idle";
  }
  const tasks = buildTieredTasks([frame], activeLayers, frame.hour, reflectivityGate, synopticDetailMode, 0).filter(
    (task) => task.affectsStatus,
  );
  if (tasks.length === 0) {
    return "loaded";
  }
  return tasks.every((task) => GLOBAL_LOADED_CACHE_KEYS.has(task.cacheKey)) ? "loaded" : "loading";
}

export function markFrameLayerLoaded(
  frame: FrameRecord | null | undefined,
  layer: LayerKey,
  reflectivityGate: ReflectivityGateDbz = 15,
): void {
  if (!frame) {
    return;
  }
  markFramePrefetchCacheKeyLoaded(buildLayerCacheKey(frame, layer, reflectivityGate));
}

export function markFrameSynopticVectorLoaded(
  frame: FrameRecord | null | undefined,
  synopticDetailMode: SynopticDetailMode = "simple",
): void {
  const vectorUrl = String(resolveSynopticVectorRequestUrl(frame, synopticDetailMode) || "").trim();
  if (!frame || !vectorUrl) {
    return;
  }
  markFramePrefetchCacheKeyLoaded(buildVectorCacheKey(frame, vectorUrl));
}

export function markFrameWeatherVectorLoaded(frame: FrameRecord | null | undefined, layer: LayerKey): void {
  const vectorUrl = String(resolveWeatherVectorRequestUrl(frame, layer) || "").trim();
  if (!frame || !vectorUrl) {
    return;
  }
  markFramePrefetchCacheKeyLoaded(buildWeatherVectorCacheKey(frame, layer, vectorUrl));
}

function scheduleGlobalLoadedCacheNotify(): void {
  if (globalLoadedCacheNotifyScheduled) {
    return;
  }
  globalLoadedCacheNotifyScheduled = true;
  globalThis.setTimeout(() => {
    globalLoadedCacheNotifyScheduled = false;
    for (const listener of GLOBAL_LOADED_CACHE_LISTENERS) {
      listener();
    }
  }, 0);
}

export class FramePrefetchEngine {
  private cacheKey = "";
  private planRevision = 0;
  private queue: PrefetchTask[] = [];
  private inFlight = 0;
  private inFlightByUrl = new Map<string, Promise<void>>();
  private requiredByHour = new Map<number, number>();
  private successByHour = new Map<number, number>();
  private failedHours = new Set<number>();
  private globalAbort: AbortController | null = null;
  private onStatus?: (hour: number, status: PrefetchState) => void;

  configure(plan: PrefetchPlan): void {
    const nextKey = String(plan.cacheKey || "");
    if (!nextKey) {
      this.stop();
      return;
    }
    this.planRevision += 1;
    const revision = this.planRevision;
    this.cacheKey = nextKey;
    this.queue = [];
    this.requiredByHour.clear();
    this.successByHour.clear();
    this.failedHours.clear();

    this.onStatus = plan.onStatus;
    this.globalAbort = this.globalAbort || new AbortController();

    const tasks = buildTieredTasks(
      plan.frames,
      plan.activeLayers,
      plan.currentHour,
      plan.reflectivityGate || 15,
      plan.synopticDetailMode || "simple",
      revision,
    );
    this.queue = tasks;
    this.requiredByHour = countTasksByHour(tasks);
    this.successByHour = seedSuccessByHour(tasks);

    for (const [hour, required] of this.requiredByHour.entries()) {
      if (required <= 0) {
        this.emitStatus(hour, "loaded");
        continue;
      }
      const successful = this.successByHour.get(hour) || 0;
      if (successful >= required) {
        this.emitStatus(hour, "loaded");
      } else {
        this.emitStatus(hour, "loading");
      }
    }
    this.pump();
  }

  stop(): void {
    this.planRevision += 1;
    this.cacheKey = "";
    this.queue = [];
    this.requiredByHour.clear();
    this.successByHour.clear();
    this.failedHours.clear();
    this.onStatus = undefined;
    this.inFlightByUrl.clear();
    if (this.globalAbort) {
      this.globalAbort.abort();
    }
    this.globalAbort = null;
    this.inFlight = 0;
  }

  private pump(): void {
    while (this.inFlight < DEFAULT_CONCURRENCY && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) {
        break;
      }
      if (GLOBAL_LOADED_CACHE_KEYS.has(task.cacheKey)) {
        this.markTaskComplete(task, "success");
        continue;
      }
      const url = resolveTaskUrl(task);
      if (!url) {
        this.markTaskComplete(task, "success");
        continue;
      }
      const existingRequest = this.inFlightByUrl.get(url);
      if (existingRequest) {
        this.attachTaskToRequest(task, existingRequest);
        continue;
      }
      const request = this.createTaskRequest(task);
      this.inFlight += 1;
      this.inFlightByUrl.set(url, request);
      this.attachTaskToRequest(task, request);
      void request.finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.inFlightByUrl.delete(url);
        this.pump();
      });
    }
  }

  private createTaskRequest(task: PrefetchTask): Promise<void> {
    const signal = this.globalAbort?.signal;
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    return task.kind === "vector"
      ? prefetchSynopticVectorPayload(task.frame, {
          signal,
          synopticDetailMode: task.synopticDetailMode || "simple",
        })
      : task.kind === "weather-vector"
        ? prefetchWeatherVectorPayload(task.frame, task.layer as LayerKey, { signal })
        : task.kind === "hover"
          ? prefetchHoverGridPayload(task.frame, { signal })
          : prefetchFrameAssets(task.frame, [task.layer as LayerKey], {
              decode: true,
              signal,
              reflectivityGate: task.reflectivityGate,
            });
  }

  private attachTaskToRequest(task: PrefetchTask, request: Promise<void>): void {
    void request
      .then(() => {
        markFramePrefetchCacheKeyLoaded(task.cacheKey);
        this.markTaskComplete(task, "success");
      })
      .catch((error: unknown) => {
        if (isAbortLikeError(error)) {
          this.markTaskComplete(task, "cancelled");
          return;
        }
        this.markTaskComplete(task, "error");
      });
  }

  private markTaskComplete(task: PrefetchTask, outcome: TaskOutcome): void {
    if (task.revision !== this.planRevision) {
      return;
    }
    const hour = task.frame.hour;
    if (!task.affectsStatus) {
      return;
    }
    if (outcome === "cancelled") {
      return;
    }
    if (outcome === "error") {
      this.failedHours.add(hour);
      this.emitStatus(hour, "error");
      return;
    }
    const prev = this.successByHour.get(hour) || 0;
    const next = prev + 1;
    this.successByHour.set(hour, next);
    const required = this.requiredByHour.get(hour) || 0;
    if (required > 0 && next >= required && !this.failedHours.has(hour)) {
      this.emitStatus(hour, "loaded");
    }
  }

  private emitStatus(hour: number, status: PrefetchState): void {
    if (!this.onStatus) {
      return;
    }
    this.onStatus(hour, status);
  }
}

function buildTieredTasks(
  frames: FrameRecord[],
  activeLayers: Set<LayerKey>,
  currentHour: number,
  reflectivityGate: ReflectivityGateDbz = 15,
  synopticDetailMode: SynopticDetailMode = "simple",
  revision = 0,
): PrefetchTask[] {
  const ordered = [...frames].sort((left, right) => left.hour - right.hour);
  const active = new Set<LayerKey>(activeLayers);

  const tasks: PrefetchTask[] = [];
  for (const frame of ordered) {
    const distance = Math.abs(frame.hour - currentHour);
    const inTierA = distance <= 2;

    for (const layer of active) {
      const weatherVectorUrl = resolveWeatherVectorRequestUrl(frame, layer);
      if (weatherVectorUrl) {
        tasks.push({
          kind: "weather-vector",
          frame,
          layer,
          priority: inTierA ? 1 : 2,
          taskKey: buildWeatherVectorTaskKey(frame, layer, weatherVectorUrl),
          cacheKey: buildWeatherVectorCacheKey(frame, layer, weatherVectorUrl),
          affectsStatus: true,
          revision,
        });
        continue;
      }
      const resolvedUrl = resolveLayerRequestUrl(frame, layer, { reflectivityGate });
      if (!resolvedUrl) {
        continue;
      }
      tasks.push({
        kind: "layer",
        frame,
        layer,
        reflectivityGate,
        priority: inTierA ? 1 : 2,
        taskKey: buildLayerTaskKey(frame, layer, reflectivityGate),
        cacheKey: buildLayerCacheKey(frame, layer, reflectivityGate),
        affectsStatus: true,
        revision,
      });
    }

    const vectorKey = resolveSynopticVectorKey(frame, synopticDetailMode);
    const vectorUrl = resolveSynopticVectorRequestUrl(frame, synopticDetailMode);
    const hasSynopticLayerRef = hasCompleteFrameLayerRef(frame.layers?.synoptic);
    if (active.has("synoptic") && vectorKey && vectorUrl) {
      tasks.push({
        kind: "vector",
        frame,
        synopticDetailMode,
        vectorKey: vectorUrl,
        priority: inTierA ? 1 : 2,
        taskKey: buildVectorTaskKey(frame, vectorUrl, synopticDetailMode),
        cacheKey: buildVectorCacheKey(frame, vectorUrl),
        affectsStatus: !hasSynopticLayerRef,
        revision,
      });
    }
    if (frame.hoverGridKey) {
      tasks.push({
        kind: "hover",
        frame,
        priority: inTierA ? 1 : 2,
        taskKey: buildHoverTaskKey(frame),
        cacheKey: buildHoverCacheKey(frame),
        affectsStatus: false,
        revision,
      });
    }
  }

  tasks.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return Math.abs(left.frame.hour - currentHour) - Math.abs(right.frame.hour - currentHour);
  });

  return dedupeTasks(tasks);
}

function dedupeTasks(tasks: PrefetchTask[]): PrefetchTask[] {
  const seen = new Set<string>();
  const out: PrefetchTask[] = [];
  for (const task of tasks) {
    const key = task.taskKey;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(task);
  }
  return out;
}

function countTasksByHour(tasks: PrefetchTask[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const task of tasks) {
    if (!task.affectsStatus) {
      continue;
    }
    counts.set(task.frame.hour, (counts.get(task.frame.hour) || 0) + 1);
  }
  return counts;
}

function seedSuccessByHour(tasks: PrefetchTask[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const task of tasks) {
    if (!task.affectsStatus) {
      continue;
    }
    if (!GLOBAL_LOADED_CACHE_KEYS.has(task.cacheKey)) {
      continue;
    }
    counts.set(task.frame.hour, (counts.get(task.frame.hour) || 0) + 1);
  }
  return counts;
}

function buildLayerTaskKey(frame: FrameRecord, layer: LayerKey, reflectivityGate: ReflectivityGateDbz): string {
  return `layer|${frame.hour}|${layer}|g${reflectivityGate}`;
}

function buildLayerCacheKey(frame: FrameRecord, layer: LayerKey, reflectivityGate: ReflectivityGateDbz): string {
  const url = resolveLayerRequestUrl(frame, layer, { reflectivityGate });
  if (!url) {
    return `layer|missing|${frame.hour}|${layer}`;
  }
  return `layer|${url}`;
}

function hasCompleteFrameLayerRef(ref: FrameRecord["layers"][string] | null | undefined): boolean {
  if (!ref) {
    return false;
  }
  if (String(ref.url || "").trim()) {
    return true;
  }
  const key = String(ref.key || "").trim();
  const bytes = Number(ref.bytes);
  return Boolean(key && Number.isFinite(bytes) && bytes > 0);
}

function buildVectorCacheKey(frame: FrameRecord, key: string): string {
  return `vector|${String(key || `missing|${frame.hour}`)}`;
}

function buildWeatherVectorCacheKey(frame: FrameRecord, layer: LayerKey, key: string): string {
  return `weather-vector|${frame.hour}|${layer}|${String(key || "missing")}`;
}

function buildVectorTaskKey(frame: FrameRecord, key: string, synopticDetailMode: SynopticDetailMode): string {
  return `vector|${frame.hour}|${synopticDetailMode}|${String(key || "missing")}`;
}

function buildWeatherVectorTaskKey(frame: FrameRecord, layer: LayerKey, key: string): string {
  return `weather-vector|${frame.hour}|${layer}|${String(key || "missing")}`;
}

function buildHoverCacheKey(frame: FrameRecord): string {
  const url = resolveHoverGridRequestUrls(frame).join("|");
  return `hover|${String(url || `missing|${frame.hour}`)}`;
}

function buildHoverTaskKey(frame: FrameRecord): string {
  return `hover|${frame.hour}|${String(resolveHoverGridRequestUrls(frame).join("|") || "missing")}`;
}

function resolveTaskUrl(task: PrefetchTask): string {
  if (task.kind === "vector") {
    return String(task.vectorKey || "");
  }
  if (task.kind === "hover") {
    return resolveHoverGridRequestUrls(task.frame).join("|");
  }
  if (task.kind === "weather-vector") {
    return resolveWeatherVectorRequestUrl(task.frame, task.layer as LayerKey) || "";
  }
  return String(
    resolveLayerRequestUrl(task.frame, task.layer as LayerKey, { reflectivityGate: task.reflectivityGate }) || "",
  );
}

function isAbortLikeError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const name = String((error as { name?: unknown }).name || "");
    if (name === "AbortError") {
      return true;
    }
  }
  const message = String(
    (typeof error === "object" && error !== null ? (error as { message?: unknown }).message : error) || "",
  );
  return /abort(ed|error)?/i.test(message);
}
