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
  prefetchFrameAssets,
  prefetchHoverGridPayload,
  prefetchSynopticVectorPayload,
  fetchModelManifestWithOptions,
  resolveFrameByValidTime,
  resolveHoverGridRequestUrls,
  resolveLayerRequestUrl,
  resolveSynopticVectorKey,
  resolveSynopticVectorRequestUrl,
} from "./artifact-client";
import { markFramePrefetchCacheKeyLoaded } from "./frame-prefetch";
import { subscribeLayerImageObjectUrlEvictions } from "./image-prefetch-cache";

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

type MemoryWarmupTaskKind = "layer" | "vector" | "hover";

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
}

const MEMORY_WARMUP_CONCURRENCY = 24;

const startedWarmupKeys = new Set<string>();
const completedTaskKeys = new Set<string>();
const queuedTaskKeys = new Set<string>();
const inFlightByUrl = new Map<string, Promise<void>>();
const queue: MemoryWarmupTask[] = [];
let inFlight = 0;

subscribeLayerImageObjectUrlEvictions((requestUrl) => {
  completedTaskKeys.delete(`layer|${requestUrl}`);
});

export function startLatestRunMemoryWarmup(plan: LatestRunWarmupPlan): void {
  if (!isMemoryWarmupEnabled()) {
    return;
  }
  const activeLayers = new Set<LayerKey>(plan.activeLayers);
  const warmupKey = buildWarmupKey(plan, activeLayers);
  if (!warmupKey || startedWarmupKeys.has(warmupKey)) {
    return;
  }
  startedWarmupKeys.add(warmupKey);
  const tasks = buildWarmupTasks(plan, activeLayers);
  for (const task of tasks) {
    if (completedTaskKeys.has(task.cacheKey) || queuedTaskKeys.has(task.taskKey)) {
      continue;
    }
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
      try {
        const manifest = await fetchModelManifestWithOptions(modelKey, plan.viewKey, {
          forceRefresh: Boolean(plan.forceRefresh),
        });
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
      } catch {
        // Some local builds may only have a subset of models available. Keep warming
        // the models that do exist instead of surfacing background failures.
      }
    }),
  );
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
    attachTaskToRequest(task, request);
    void request.finally(() => {
      inFlight = Math.max(0, inFlight - 1);
      inFlightByUrl.delete(task.urlKey);
      pumpWarmupQueue();
    });
  }
}

function createWarmupRequest(task: MemoryWarmupTask): Promise<void> {
  if (task.kind === "vector") {
    return prefetchSynopticVectorPayload(task.frame, {
      synopticDetailMode: task.synopticDetailMode || "simple",
    });
  }
  if (task.kind === "hover") {
    return prefetchHoverGridPayload(task.frame);
  }
  return prefetchFrameAssets(task.frame, [task.layer as LayerKey], {
    decode: true,
    reflectivityGate: task.reflectivityGate,
  });
}

function attachTaskToRequest(task: MemoryWarmupTask, request: Promise<void>): void {
  void request
    .then(() => {
      completedTaskKeys.add(task.cacheKey);
      markFramePrefetchCacheKeyLoaded(task.cacheKey);
    })
    .catch(() => {
      // Background warmup must never affect the interactive map path.
    });
}

function buildWarmupTasks(plan: LatestRunWarmupPlan, activeLayers: ReadonlySet<LayerKey>): MemoryWarmupTask[] {
  const frames = [...(plan.manifest.frames || [])].sort((left, right) => left.hour - right.hour);
  const tasks: MemoryWarmupTask[] = [];
  for (const frame of frames) {
    const priority = Math.abs(frame.hour - plan.anchorHour);

    for (const layer of activeLayers) {
      if (isReflectivityLayer(layer)) {
        appendLayerTask(tasks, frame, layer, priority, plan.reflectivityGate);
        continue;
      }
      appendLayerTask(tasks, frame, layer, priority);
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
        });
      }
    }

    const hoverKey = resolveHoverGridRequestUrls(frame).join("|");
    if (hoverKey) {
      tasks.push({
        kind: "hover",
        frame,
        urlKey: `hover:${hoverKey}`,
        taskKey: `hover|${frame.hour}|${hoverKey}`,
        cacheKey: `hover|${hoverKey}`,
        priority,
      });
    }
  }
  return dedupeWarmupTasks(tasks).sort(compareWarmupTasks);
}

function appendLayerTask(
  tasks: MemoryWarmupTask[],
  frame: FrameRecord,
  layer: LayerKey,
  priority: number,
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
  if (kind === "layer") {
    return 0;
  }
  if (kind === "vector") {
    return 1;
  }
  return 2;
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
