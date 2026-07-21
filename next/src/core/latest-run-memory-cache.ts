import { MODEL_KEYS } from "../config/constants";
import type {
  FrameRecord,
  LayerKey,
  ModelKey,
  ModelManifest,
  ReflectivityGateDbz,
  SynopticDetailMode,
  ViewKey,
} from "../types";
import {
  type ParsedPayloadCacheKind,
  prefetchContourVectorPayload,
  prefetchFrameAssets,
  prefetchSynopticVectorPayload,
  fetchModelManifestWithOptions,
  isParsedPayloadCached,
  resolveContourVectorRequestUrl,
  resolveFrameByValidTime,
  resolveLayerRequestUrl,
  resolveSynopticVectorKey,
  resolveSynopticVectorRequestUrl,
  subscribeParsedPayloadEvictions,
} from "./artifact-client";
import { markFramePrefetchCacheKeyEvicted, markFramePrefetchCacheKeyLoaded } from "./frame-prefetch";
import { isLayerImageUrlResident, subscribeLayerImageObjectUrlEvictions } from "./image-prefetch-cache";

interface LatestRunWarmupPlan {
  modelKey: ModelKey;
  viewKey: ViewKey;
  manifest: ModelManifest;
  anchorHour: number;
  activeLayers: Iterable<LayerKey>;
  reflectivityGate: ReflectivityGateDbz;
  synopticDetailMode: SynopticDetailMode;
}

interface LatestViewWarmupPlan {
  viewKey: ViewKey;
  anchorValidTimeIso?: string | null;
  forceRefresh?: boolean;
  activeLayers: Iterable<LayerKey>;
  reflectivityGate: ReflectivityGateDbz;
  synopticDetailMode: SynopticDetailMode;
}

type MemoryWarmupTaskKind = "layer" | "vector" | "contour-vector";

interface MemoryWarmupTask {
  kind: MemoryWarmupTaskKind;
  frame: FrameRecord;
  layer?: LayerKey;
  reflectivityGate?: ReflectivityGateDbz;
  synopticDetailMode?: SynopticDetailMode;
  urlKey: string;
  taskKey: string;
  cacheKey: string;
  priority: number;
  scopeKey: string;
}

const MEMORY_WARMUP_CONCURRENCY = 24;
const LATEST_MANIFEST_FAILURE_BACKOFF_MS = 60_000;
const WARMUP_TASK_FAILURE_BACKOFF_MS = 15_000;

const startedWarmupKeys = new Set<string>();
const warmupAnchorByKey = new Map<string, number>();
const completedTaskKeys = new Set<string>();
const queuedTaskKeys = new Set<string>();
const failedTaskRetryAfter = new Map<string, { scopeKey: string; retryAfter: number }>();
const inFlightByUrl = new Map<string, Promise<void>>();
const queue: MemoryWarmupTask[] = [];
const latestManifestProbeInFlight = new Map<string, Promise<ModelManifest | null>>();
const latestManifestFailureUntil = new Map<string, number>();
let inFlight = 0;

subscribeLayerImageObjectUrlEvictions((requestUrl) => {
  completedTaskKeys.delete(`layer|${requestUrl}`);
});

subscribeParsedPayloadEvictions((kind, requestUrl) => {
  deleteCompletedParsedPayloadKeys(kind, requestUrl);
});

function deleteCompletedParsedPayloadKeys(kind: ParsedPayloadCacheKind, requestUrl: string): void {
  const prefix = kind === "synoptic-vector" ? "vector|" : kind === "contour-vector" ? "contour-vector|" : "";
  if (!prefix) {
    return;
  }
  for (const cacheKey of completedTaskKeys) {
    if (cacheKey.startsWith(prefix) && cacheKey.endsWith(`|${requestUrl}`)) {
      completedTaskKeys.delete(cacheKey);
    }
  }
}

export function startLatestRunMemoryWarmup(plan: LatestRunWarmupPlan): void {
  if (!isMemoryWarmupEnabled()) {
    return;
  }
  const activeLayers = new Set<LayerKey>(plan.activeLayers);
  const warmupKey = buildWarmupKey(plan, activeLayers);
  if (!warmupKey) {
    return;
  }
  const normalizedAnchor = Number(plan.anchorHour) || 0;
  const sameAnchor = startedWarmupKeys.has(warmupKey) && warmupAnchorByKey.get(warmupKey) === normalizedAnchor;
  if (sameAnchor && !hasRetryableFailedTask(warmupKey, Date.now())) {
    return;
  }
  startedWarmupKeys.add(warmupKey);
  warmupAnchorByKey.set(warmupKey, normalizedAnchor);
  // A timeline move should promote the new selected/adjacent frames even if
  // the first-anchor whole-run queue is still long. Replace only this run's
  // queued (not already in-flight) tasks and preserve completed work.
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index].scopeKey !== warmupKey) {
      continue;
    }
    queuedTaskKeys.delete(queue[index].taskKey);
    queue.splice(index, 1);
  }
  const tasks = buildWarmupTasks(plan, activeLayers, warmupKey);
  for (const task of tasks) {
    if (completedTaskKeys.has(task.cacheKey) || queuedTaskKeys.has(task.taskKey)) {
      continue;
    }
    const failedTask = failedTaskRetryAfter.get(task.taskKey);
    if (failedTask && failedTask.retryAfter > Date.now()) {
      continue;
    }
    failedTaskRetryAfter.delete(task.taskKey);
    queuedTaskKeys.add(task.taskKey);
    queue.push(task);
  }
  queue.sort(compareWarmupTasks);
  pumpWarmupQueue();
}

export async function warmLatestViewMemoryCache(plan: LatestViewWarmupPlan): Promise<void> {
  if (!isMemoryWarmupEnabled()) {
    return;
  }
  await Promise.all(
    MODEL_KEYS.map(async (modelKey) => {
      const manifest = await resolveLatestManifestForWarmup(modelKey, plan.viewKey, Boolean(plan.forceRefresh));
      if (!manifest) {
        return;
      }
      const anchorHour =
        resolveFrameByValidTime(manifest, plan.anchorValidTimeIso || null, "nearest-absolute")?.hour ??
        manifest.frames[0]?.hour ??
        0;
      startLatestRunMemoryWarmup({
        modelKey,
        viewKey: plan.viewKey,
        manifest,
        anchorHour,
        activeLayers: plan.activeLayers,
        reflectivityGate: plan.reflectivityGate,
        synopticDetailMode: plan.synopticDetailMode,
      });
    }),
  );
}

async function resolveLatestManifestForWarmup(
  modelKey: ModelKey,
  viewKey: ViewKey,
  forceRefresh: boolean,
): Promise<ModelManifest | null> {
  const key = `${modelKey}|${viewKey}`;
  const now = Date.now();
  if (!forceRefresh && (latestManifestFailureUntil.get(key) || 0) > now) {
    return null;
  }
  const existing = latestManifestProbeInFlight.get(key);
  if (existing) {
    return existing;
  }
  const request = fetchModelManifestWithOptions(modelKey, viewKey, { forceRefresh })
    .then((manifest) => {
      latestManifestFailureUntil.delete(key);
      return manifest;
    })
    .catch(() => {
      // A local cache commonly contains only one or two models. Back off every
      // failed probe so timeline motion cannot create a request storm, while a
      // force refresh can still discover a newly built run early.
      latestManifestFailureUntil.set(key, Date.now() + LATEST_MANIFEST_FAILURE_BACKOFF_MS);
      return null;
    })
    .finally(() => {
      if (latestManifestProbeInFlight.get(key) === request) {
        latestManifestProbeInFlight.delete(key);
      }
    });
  latestManifestProbeInFlight.set(key, request);
  return request;
}

function pumpWarmupQueue(): void {
  while (inFlight < MEMORY_WARMUP_CONCURRENCY && queue.length > 0) {
    const task = queue.shift();
    if (!task) {
      break;
    }
    queuedTaskKeys.delete(task.taskKey);
    if (completedTaskKeys.has(task.cacheKey)) {
      continue;
    }
    const existing = inFlightByUrl.get(task.urlKey);
    if (existing) {
      attachTaskToRequest(task, existing);
      continue;
    }
    const request = createWarmupRequest(task);
    inFlight += 1;
    inFlightByUrl.set(task.urlKey, request);
    const releaseRequestSlot = () => {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlightByUrl.get(task.urlKey) === request) {
        inFlightByUrl.delete(task.urlKey);
      }
      pumpWarmupQueue();
    };
    void request.then(releaseRequestSlot, releaseRequestSlot);
    attachTaskToRequest(task, request);
  }
}

function createWarmupRequest(task: MemoryWarmupTask): Promise<void> {
  if (task.kind === "vector") {
    return prefetchSynopticVectorPayload(task.frame, {
      synopticDetailMode: task.synopticDetailMode || "simple",
    });
  }
  if (task.kind === "contour-vector") {
    return prefetchContourVectorPayload(task.frame, task.layer as LayerKey);
  }
  return prefetchFrameAssets(task.frame, [task.layer as LayerKey], {
    decode: true,
    reflectivityGate: task.reflectivityGate,
  });
}

function attachTaskToRequest(task: MemoryWarmupTask, request: Promise<void>): void {
  void request
    .then(() => {
      if (!isWarmupTaskCacheResident(task)) {
        // Bytes could not be retained (evicted mid-flight, or a budget too
        // small to hold them at all). Deliberately NOT paced with the
        // failure backoff: taskKeys are scope-agnostic, so a backoff here
        // blocks legitimate re-warms started by OTHER passes for 15 s, and
        // the pathological-budget refetch concern it would address is cheap
        // in practice (fetches use force-cache, so repeats cost a decode,
        // not a download).
        completedTaskKeys.delete(task.cacheKey);
        markFramePrefetchCacheKeyEvicted(task.cacheKey);
        return;
      }
      failedTaskRetryAfter.delete(task.taskKey);
      completedTaskKeys.add(task.cacheKey);
      // Unlike a panel-owned FramePrefetchEngine, background warmup has no
      // onStatus callback. Notify through the globally batched cache channel so
      // an already-mounted panel can recover from a prior error immediately.
      markFramePrefetchCacheKeyLoaded(task.cacheKey);
    })
    .catch(() => {
      // Background failures stay isolated from the interactive map path, but
      // become eligible for a bounded retry on a later warmup tick.
      rememberWarmupTaskFailure(task);
    });
}

function rememberWarmupTaskFailure(task: MemoryWarmupTask): void {
  failedTaskRetryAfter.set(task.taskKey, {
    scopeKey: task.scopeKey,
    retryAfter: Date.now() + WARMUP_TASK_FAILURE_BACKOFF_MS,
  });
}

function hasRetryableFailedTask(scopeKey: string, now: number): boolean {
  for (const failure of failedTaskRetryAfter.values()) {
    if (failure.scopeKey === scopeKey && failure.retryAfter <= now) {
      return true;
    }
  }
  return false;
}

function isWarmupTaskCacheResident(task: MemoryWarmupTask): boolean {
  if (task.kind === "vector") {
    const requestUrl = String(resolveSynopticVectorRequestUrl(task.frame, task.synopticDetailMode || "simple") || "");
    return Boolean(requestUrl) && isParsedPayloadCached("synoptic-vector", requestUrl);
  }
  if (task.kind === "contour-vector") {
    const requestUrl = String(resolveContourVectorRequestUrl(task.frame, task.layer as LayerKey) || "");
    return Boolean(requestUrl) && isParsedPayloadCached("contour-vector", requestUrl);
  }
  // Raster tasks need the same guard the panel engine has (frame-prefetch's
  // isTaskCacheResident, via the shared predicate): a warmup fetch can finish
  // after cache pressure evicted the object URL — its own insert may even
  // self-evict immediately under a shrunken budget — and must not recreate a
  // loaded key for bytes that are no longer resident. Returning true
  // unconditionally here let a late warmup permanently re-mark evicted
  // frames as loaded.
  const requestUrl = String(
    resolveLayerRequestUrl(task.frame, task.layer as LayerKey, { reflectivityGate: task.reflectivityGate }) || "",
  );
  return isLayerImageUrlResident(requestUrl);
}

function buildWarmupTasks(
  plan: LatestRunWarmupPlan,
  activeLayers: ReadonlySet<LayerKey>,
  scopeKey: string,
): MemoryWarmupTask[] {
  const frames = [...(plan.manifest.frames || [])].sort((left, right) => left.hour - right.hour);
  const tasks: MemoryWarmupTask[] = [];
  for (const frame of frames) {
    const priority = Math.abs(frame.hour - plan.anchorHour);

    for (const layer of activeLayers) {
      if (isReflectivityLayer(layer)) {
        appendLayerTask(tasks, frame, layer, priority, scopeKey, plan.reflectivityGate);
        continue;
      }
      appendLayerTask(tasks, frame, layer, priority, scopeKey);
      const contourUrl = String(resolveContourVectorRequestUrl(frame, layer) || "").trim();
      if (contourUrl) {
        tasks.push({
          kind: "contour-vector",
          frame,
          layer,
          urlKey: `contour-vector:${contourUrl}`,
          taskKey: `contour-vector|${frame.hour}|${layer}|${contourUrl}`,
          cacheKey: `contour-vector|${frame.hour}|${layer}|${contourUrl}`,
          priority,
          scopeKey,
        });
      }
    }

    if (activeLayers.has("synoptic")) {
      const mode = plan.synopticDetailMode;
      const vectorKey = String(resolveSynopticVectorKey(frame, mode) || "").trim();
      const vectorUrl = String(resolveSynopticVectorRequestUrl(frame, mode) || "").trim();
      if (vectorKey && vectorUrl) {
        tasks.push({
          kind: "vector",
          frame,
          synopticDetailMode: mode,
          urlKey: `vector:${vectorUrl}`,
          taskKey: `vector|${frame.hour}|${mode}|${vectorUrl}`,
          cacheKey: `vector|${vectorUrl}`,
          priority,
          scopeKey,
        });
      }
    }
  }
  return dedupeWarmupTasks(tasks).sort(compareWarmupTasks);
}

function appendLayerTask(
  tasks: MemoryWarmupTask[],
  frame: FrameRecord,
  layer: LayerKey,
  priority: number,
  scopeKey: string,
  reflectivityGate?: ReflectivityGateDbz,
): void {
  const requestUrl = resolveLayerRequestUrl(frame, layer, { reflectivityGate });
  if (!requestUrl) {
    return;
  }
  const gateKey = isReflectivityLayer(layer) ? `|g${reflectivityGate || 15}` : "";
  tasks.push({
    kind: "layer",
    frame,
    layer,
    reflectivityGate,
    urlKey: `layer:${requestUrl}`,
    taskKey: `layer|${frame.hour}|${layer}${gateKey}|${requestUrl}`,
    cacheKey: `layer|${requestUrl}`,
    priority,
    scopeKey,
  });
}

function isReflectivityLayer(layer: LayerKey): boolean {
  return layer === "reflectivity" || layer === "reflectivityComposite" || layer === "reflectivity1km";
}

function dedupeWarmupTasks(tasks: MemoryWarmupTask[]): MemoryWarmupTask[] {
  const seen = new Set<string>();
  const out: MemoryWarmupTask[] = [];
  for (const task of tasks) {
    if (seen.has(task.cacheKey)) {
      continue;
    }
    seen.add(task.cacheKey);
    out.push(task);
  }
  return out;
}

function compareWarmupTasks(left: MemoryWarmupTask, right: MemoryWarmupTask): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  return taskKindRank(left.kind) - taskKindRank(right.kind);
}

function taskKindRank(kind: MemoryWarmupTaskKind): number {
  if (kind === "vector" || kind === "contour-vector") {
    return 0;
  }
  return 1;
}

function buildWarmupKey(plan: LatestRunWarmupPlan, activeLayers: ReadonlySet<LayerKey>): string {
  const run = String(plan.manifest.run || "").trim();
  const layersKey = Array.from(activeLayers).sort().join(",");
  if (!run || !plan.manifest.frames?.length || !layersKey) {
    return "";
  }
  return [
    plan.modelKey,
    plan.viewKey,
    run,
    plan.manifest.generatedAt || "",
    String(plan.manifest.frames.length),
    layersKey,
    `g${plan.reflectivityGate}`,
    plan.synopticDetailMode,
    "active-layers-v1",
  ].join("|");
}

function isMemoryWarmupEnabled(): boolean {
  return String(import.meta.env.VITE_DISABLE_LATEST_RUN_MEMORY_WARMUP || "").trim() !== "1";
}

// Dev-only introspection used by the Playwright cache-budget specs: lets a
// spec start a warmup pass at a deterministic point (e.g. right after
// evicting the object-URL cache) instead of racing MapPanel's 300 ms trigger
// timer — the exact scheduling race that made the eviction spec flake on CI.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (
    window as Window & {
      __wxLatestRunMemoryWarmup?: {
        start(plan: LatestRunWarmupPlan): void;
        stats(): { inFlight: number; queued: number };
      };
    }
  ).__wxLatestRunMemoryWarmup = {
    start: startLatestRunMemoryWarmup,
    // Quiescence probe: specs poll this after starting a pass so their
    // assertions run strictly AFTER the completion path under test, instead
    // of racing it from the request-start signal.
    stats: () => ({ inFlight, queued: queue.length }),
  };
}
