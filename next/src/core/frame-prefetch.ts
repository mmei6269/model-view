import type { FrameRecord, LayerKey, PrefetchState, ReflectivityGateDbz, SynopticDetailMode } from "../types";
import {
  type ParsedPayloadCacheKind,
  prefetchContourVectorPayload,
  prefetchFrameAssets,
  prefetchSynopticVectorPayload,
  prefetchWeatherVectorPayload,
  isParsedPayloadCached,
  resolveContourVectorRequestUrl,
  resolveLayerRequestUrl,
  resolveSynopticVectorKey,
  resolveSynopticVectorRequestUrl,
  resolveWeatherVectorRequestUrl,
  subscribeParsedPayloadEvictions,
} from "./artifact-client";
import { isLayerImageUrlResident, subscribeLayerImageObjectUrlEvictions } from "./image-prefetch-cache";

interface PrefetchTask {
  kind: "layer" | "vector" | "contour-vector" | "weather-vector";
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
  rememberFramePrefetchCacheKeyLoaded(cacheKey, true);
}

function rememberFramePrefetchCacheKeyLoaded(cacheKey: string, notify: boolean): void {
  const key = String(cacheKey || "");
  if (!key || GLOBAL_LOADED_CACHE_KEYS.has(key)) {
    return;
  }
  GLOBAL_LOADED_CACHE_KEYS.add(key);
  if (notify) {
    scheduleGlobalLoadedCacheNotify();
  }
}

export function markFramePrefetchCacheKeyEvicted(cacheKey: string): void {
  const key = String(cacheKey || "");
  if (!key || !GLOBAL_LOADED_CACHE_KEYS.delete(key)) {
    return;
  }
  scheduleGlobalLoadedCacheNotify();
}

// Layer cache keys are `layer|${requestUrl}` (see buildLayerCacheKey), so an object-URL
// eviction maps 1:1 onto the loaded-key set.
subscribeLayerImageObjectUrlEvictions((requestUrl) => {
  markFramePrefetchCacheKeyEvicted(`layer|${requestUrl}`);
});

subscribeParsedPayloadEvictions((kind, requestUrl) => {
  evictParsedPayloadLoadedKeys(kind, requestUrl);
});

function evictParsedPayloadLoadedKeys(kind: ParsedPayloadCacheKind, requestUrl: string): void {
  const prefix =
    kind === "synoptic-vector"
      ? "vector|"
      : kind === "contour-vector"
        ? "contour-vector|"
        : kind === "weather-vector"
          ? "weather-vector|"
          : "";
  if (!prefix) {
    return;
  }
  let changed = false;
  for (const cacheKey of GLOBAL_LOADED_CACHE_KEYS) {
    if (cacheKey.startsWith(prefix) && cacheKey.endsWith(`|${requestUrl}`)) {
      GLOBAL_LOADED_CACHE_KEYS.delete(cacheKey);
      changed = true;
    }
  }
  if (changed) {
    scheduleGlobalLoadedCacheNotify();
  }
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
  // Display-driven marking is intentionally NOT residency-guarded: the map
  // engine fires this when its decode of the layer lands, and a frame that
  // is genuinely on screen counts as loaded even when cache pressure holds
  // no copy of its bytes (the transient-failure recovery flow depends on
  // exactly this — MapLibre's one visible request marks the selected hour
  // without a parallel prefetch). The residency guards live on the
  // cache-warming completion paths (prefetch + warmup engines), whose only
  // claim is "bytes are resident for instant reuse". Consequence: eviction
  // honesty can only be asserted for frames the map is not displaying.
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

export function markFrameContourVectorLoaded(frame: FrameRecord | null | undefined, layer: LayerKey): void {
  const vectorUrl = String(resolveContourVectorRequestUrl(frame, layer) || "").trim();
  if (!frame || !vectorUrl) {
    return;
  }
  markFramePrefetchCacheKeyLoaded(buildContourVectorCacheKey(frame, layer, vectorUrl));
}

function scheduleGlobalLoadedCacheNotify(): void {
  if (globalLoadedCacheNotifyScheduled) {
    return;
  }
  globalLoadedCacheNotifyScheduled = true;
  // Network/cache completions for a hot run arrive in dense clusters. One
  // notification per short burst keeps independent panels and background
  // warmups coherent without forcing a whole-horizon React scan per asset.
  globalThis.setTimeout(() => {
    globalLoadedCacheNotifyScheduled = false;
    for (const listener of GLOBAL_LOADED_CACHE_LISTENERS) {
      listener();
    }
  }, 100);
}

export class FramePrefetchEngine {
  private cacheKey = "";
  private planSignature = "";
  private anchorHour: number | null = null;
  private planRevision = 0;
  private queue: PrefetchTask[] = [];
  private inFlight = 0;
  private inFlightByUrl = new Map<string, Promise<void>>();
  private requiredByHour = new Map<number, number>();
  private successByHour = new Map<number, number>();
  private seededTaskKeys = new Set<string>();
  private failedHours = new Set<number>();
  private failedTaskHours = new Map<string, number>();
  private urgentTaskKeys = new Set<string>();
  private globalAbort: AbortController | null = null;
  private onStatus?: (hour: number, status: PrefetchState) => void;

  configure(plan: PrefetchPlan): void {
    const nextKey = String(plan.cacheKey || "");
    if (!nextKey) {
      this.stop();
      return;
    }
    const candidateTasks = buildTieredTasks(
      plan.frames,
      plan.activeLayers,
      plan.currentHour,
      plan.reflectivityGate || 15,
      plan.synopticDetailMode || "simple",
      this.planRevision,
    );
    const nextSignature = buildTaskPlanSignature(candidateTasks);
    this.onStatus = plan.onStatus;

    if (nextKey === this.cacheKey && nextSignature === this.planSignature) {
      if (plan.currentHour === this.anchorHour) {
        // Status callbacks can synchronously rerender the owning panel while a
        // cached-task pump is still unwinding. Re-entering pump() for the same
        // anchor recursively drains the remaining cached queue and can exceed
        // React's nested-update limit on a full run. Refreshing onStatus above
        // is the only work an identical configure call needs.
        return;
      }
      this.anchorHour = plan.currentHour;
      // A timeline move changes priority only. Preserve valid in-flight work
      // and progress, while reordering tasks that have not started yet around
      // the new anchor hour.
      const pendingTaskKeys = new Set(this.queue.map((task) => task.taskKey));
      // A transiently failed task is no longer pending. Give it one deliberate
      // retry when the analyst moves onto that hour, without restarting other
      // failed work or aborting unrelated in-flight requests.
      const retryTaskKeys = new Set<string>();
      const candidateByTaskKey = new Map(candidateTasks.map((task) => [task.taskKey, task]));
      for (const [taskKey, hour] of this.failedTaskHours.entries()) {
        const failedTask = candidateByTaskKey.get(taskKey);
        // Raster selection already makes MapLibre issue the direct visible
        // image request. Do not duplicate that transfer with a simultaneous
        // prefetch retry; its load callback updates the shared cache/status.
        if (hour === plan.currentHour && failedTask?.kind !== "layer") {
          retryTaskKeys.add(taskKey);
        }
      }
      const eligibleTasks = candidateTasks.filter(
        (task) => pendingTaskKeys.has(task.taskKey) || retryTaskKeys.has(task.taskKey),
      );
      const urgentTasks = eligibleTasks.filter((task) => task.frame.hour === plan.currentHour);
      const urgentTaskKeys = new Set(urgentTasks.map((task) => task.taskKey));
      const retryTasks = eligibleTasks.filter(
        (task) => retryTaskKeys.has(task.taskKey) && !urgentTaskKeys.has(task.taskKey),
      );
      const pendingTasks = eligibleTasks.filter(
        (task) => !retryTaskKeys.has(task.taskKey) && !urgentTaskKeys.has(task.taskKey),
      );
      this.urgentTaskKeys = urgentTaskKeys;
      this.queue = [...urgentTasks, ...retryTasks, ...pendingTasks];
      this.pump();
      return;
    }

    this.planRevision += 1;
    const revision = this.planRevision;
    // A URL/task-roster change is genuinely obsolete. Abort the old work and
    // release its concurrency slots; late handlers are revision-guarded.
    this.globalAbort?.abort();
    this.globalAbort = new AbortController();
    this.inFlightByUrl.clear();
    this.inFlight = 0;
    this.cacheKey = nextKey;
    this.planSignature = nextSignature;
    this.anchorHour = plan.currentHour;
    this.queue = [];
    this.requiredByHour.clear();
    this.successByHour.clear();
    this.seededTaskKeys.clear();
    this.failedHours.clear();
    this.failedTaskHours.clear();
    this.urgentTaskKeys.clear();

    const tasks = candidateTasks.map((task) => ({ ...task, revision }));
    this.queue = tasks;
    this.requiredByHour = countTasksByHour(tasks);
    const seeded = seedSuccessByHour(tasks);
    this.successByHour = seeded.successByHour;
    this.seededTaskKeys = seeded.seededTaskKeys;

    for (const [hour, required] of this.requiredByHour.entries()) {
      if (required <= 0) {
        this.emitStatus(hour, "loaded");
        continue;
      }
      const successful = this.successByHour.get(hour) || 0;
      if (successful >= required) {
        this.emitStatus(hour, "loaded");
      }
    }
    this.pump();
  }

  stop(): void {
    this.planRevision += 1;
    this.cacheKey = "";
    this.planSignature = "";
    this.anchorHour = null;
    this.queue = [];
    this.requiredByHour.clear();
    this.successByHour.clear();
    this.seededTaskKeys.clear();
    this.failedHours.clear();
    this.failedTaskHours.clear();
    this.urgentTaskKeys.clear();
    this.onStatus = undefined;
    this.inFlightByUrl.clear();
    if (this.globalAbort) {
      this.globalAbort.abort();
    }
    this.globalAbort = null;
    this.inFlight = 0;
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const nextTask = this.queue[0];
      const canUseUrgentSlot =
        this.inFlight === DEFAULT_CONCURRENCY && Boolean(nextTask && this.urgentTaskKeys.has(nextTask.taskKey));
      if (this.inFlight >= DEFAULT_CONCURRENCY && !canUseUrgentSlot) {
        break;
      }
      const task = this.queue.shift();
      if (!task) {
        break;
      }
      this.urgentTaskKeys.delete(task.taskKey);
      const isSelectedRetry = this.failedTaskHours.has(task.taskKey) && task.frame.hour === this.anchorHour;
      if (isSelectedRetry) {
        this.failedTaskHours.delete(task.taskKey);
        this.refreshFailedHour(task.frame.hour);
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
        this.noteTaskFetchStarted(task);
        this.attachTaskToRequest(task, existingRequest);
        continue;
      }
      const request = this.createTaskRequest(task);
      const requestRevision = task.revision;
      this.inFlight += 1;
      this.inFlightByUrl.set(url, request);
      this.noteTaskFetchStarted(task);
      const releaseRequestSlot = () => {
        if (requestRevision !== this.planRevision) {
          return;
        }
        this.inFlight = Math.max(0, this.inFlight - 1);
        if (this.inFlightByUrl.get(url) === request) {
          this.inFlightByUrl.delete(url);
        }
        this.pump();
      };
      // Register release first so an error status callback that synchronously
      // re-anchors cannot attach a retry to the already-rejected request.
      void request.then(releaseRequestSlot, releaseRequestSlot);
      this.attachTaskToRequest(task, request);
    }
  }

  // "loading" is only emitted once a fetch is actually in flight for the hour;
  // queued tasks leave the hour in its prior (pending) state.
  private noteTaskFetchStarted(task: PrefetchTask): void {
    if (!task.affectsStatus || task.revision !== this.planRevision || this.failedHours.has(task.frame.hour)) {
      return;
    }
    this.emitStatus(task.frame.hour, "loading");
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
      : task.kind === "contour-vector"
        ? prefetchContourVectorPayload(task.frame, task.layer as LayerKey, { signal })
        : task.kind === "weather-vector"
          ? prefetchWeatherVectorPayload(task.frame, task.layer as LayerKey, { signal })
          : prefetchFrameAssets(task.frame, [task.layer as LayerKey], {
              decode: true,
              signal,
              reflectivityGate: task.reflectivityGate,
            });
  }

  private attachTaskToRequest(task: PrefetchTask, request: Promise<void>): void {
    void request
      .then(() => {
        if (!isTaskCacheResident(task)) {
          markFramePrefetchCacheKeyEvicted(task.cacheKey);
          this.markTaskComplete(task, "cancelled");
          return;
        }
        // The owner receives its hour status below, but other mounted panels can
        // still hold an error for this shared URL. Publish through the batched
        // global channel so they recover too. The 100 ms scheduler collapses a
        // hot completion burst, and an identical reconfiguration is a no-op, so
        // this cannot recreate synchronous nested-update churn.
        rememberFramePrefetchCacheKeyLoaded(task.cacheKey, true);
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
      this.failedTaskHours.set(task.taskKey, hour);
      this.failedHours.add(hour);
      this.emitStatus(hour, "error");
      return;
    }
    this.failedTaskHours.delete(task.taskKey);
    this.refreshFailedHour(hour);
    if (this.seededTaskKeys.has(task.taskKey)) {
      // The configure-time seed already counted this task; counting it again on the
      // pump()'s cached fast path would double-count the hour and emit "loaded"
      // while sibling tasks are still in flight.
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

  private refreshFailedHour(hour: number): void {
    for (const failedHour of this.failedTaskHours.values()) {
      if (failedHour === hour) {
        this.failedHours.add(hour);
        return;
      }
    }
    this.failedHours.delete(hour);
  }
}

function buildTaskPlanSignature(tasks: PrefetchTask[]): string {
  return tasks
    .map((task) => `${task.taskKey}\u0000${task.cacheKey}\u0000${task.affectsStatus ? "status" : "warm"}`)
    .sort()
    .join("\n");
}

function isTaskCacheResident(task: PrefetchTask): boolean {
  const requestUrl = resolveTaskUrl(task);
  if (!requestUrl) {
    return true;
  }
  if (task.kind === "vector") {
    return isParsedPayloadCached("synoptic-vector", requestUrl);
  }
  if (task.kind === "contour-vector") {
    return isParsedPayloadCached("contour-vector", requestUrl);
  }
  if (task.kind === "weather-vector") {
    return isParsedPayloadCached("weather-vector", requestUrl);
  }
  // A raster fetch can finish after cache pressure evicted the object URL
  // (especially while its decode was still in flight). Do not let that stale
  // completion recreate a loaded key for bytes that are no longer resident.
  return isLayerImageUrlResident(requestUrl);
}

export function buildTieredTasks(
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
      const contourVectorUrl = resolveContourVectorRequestUrl(frame, layer);
      if (contourVectorUrl) {
        tasks.push({
          kind: "contour-vector",
          frame,
          layer,
          priority: inTierA ? 1 : 2,
          taskKey: buildContourVectorTaskKey(frame, layer, contourVectorUrl),
          cacheKey: buildContourVectorCacheKey(frame, layer, contourVectorUrl),
          affectsStatus: !hasCompleteFrameLayerRef(frame.layers?.[layer]),
          revision,
        });
      }
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
  }

  tasks.sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    const distance = Math.abs(left.frame.hour - currentHour) - Math.abs(right.frame.hour - currentHour);
    if (distance !== 0) {
      return distance;
    }
    return taskKindRank(left.kind) - taskKindRank(right.kind);
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

// Seeded tasks are counted here exactly once; markTaskComplete skips their later
// completions (cached fast path, or a refetch after eviction) so an hour's success
// count holds at most one success per distinct status task.
function seedSuccessByHour(tasks: PrefetchTask[]): {
  successByHour: Map<number, number>;
  seededTaskKeys: Set<string>;
} {
  const successByHour = new Map<number, number>();
  const seededTaskKeys = new Set<string>();
  for (const task of tasks) {
    if (!task.affectsStatus) {
      continue;
    }
    if (!GLOBAL_LOADED_CACHE_KEYS.has(task.cacheKey)) {
      continue;
    }
    successByHour.set(task.frame.hour, (successByHour.get(task.frame.hour) || 0) + 1);
    seededTaskKeys.add(task.taskKey);
  }
  return { successByHour, seededTaskKeys };
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

function buildContourVectorCacheKey(frame: FrameRecord, layer: LayerKey, key: string): string {
  return `contour-vector|${frame.hour}|${layer}|${String(key || "missing")}`;
}

function buildContourVectorTaskKey(frame: FrameRecord, layer: LayerKey, key: string): string {
  return `contour-vector|${frame.hour}|${layer}|${String(key || "missing")}`;
}

function resolveTaskUrl(task: PrefetchTask): string {
  if (task.kind === "vector") {
    return String(task.vectorKey || "");
  }
  if (task.kind === "contour-vector") {
    return resolveContourVectorRequestUrl(task.frame, task.layer as LayerKey) || "";
  }
  if (task.kind === "weather-vector") {
    return resolveWeatherVectorRequestUrl(task.frame, task.layer as LayerKey) || "";
  }
  return String(
    resolveLayerRequestUrl(task.frame, task.layer as LayerKey, { reflectivityGate: task.reflectivityGate }) || "",
  );
}

function taskKindRank(kind: PrefetchTask["kind"]): number {
  if (kind === "vector" || kind === "contour-vector" || kind === "weather-vector") {
    return 0;
  }
  return 1;
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
