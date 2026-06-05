import { LAYER_STACK_ORDER } from "../config/layers";
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

interface LatestRunWarmupPlan {
  modelKey: ModelKey;
  viewKey: ViewKey;
  manifest: ModelManifest;
  anchorHour: number;
}

interface LatestViewWarmupPlan {
  viewKey: ViewKey;
  anchorValidTimeIso?: string | null;
  forceRefresh?: boolean;
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
const REFLECTIVITY_GATES: ReflectivityGateDbz[] = [10, 15, 20];
const SYNOPTIC_DETAIL_MODES: SynopticDetailMode[] = ["simple", "detailed"];

const startedWarmupKeys = new Set<string>();
const completedTaskKeys = new Set<string>();
const queuedTaskKeys = new Set<string>();
const inFlightByUrl = new Map<string, Promise<void>>();
const queue: MemoryWarmupTask[] = [];
let inFlight = 0;

export function startLatestRunMemoryWarmup(plan: LatestRunWarmupPlan): void {
  if (!isMemoryWarmupEnabled()) {
    return;
  }
  const warmupKey = buildWarmupKey(plan);
  if (!warmupKey || startedWarmupKeys.has(warmupKey)) {
    return;
  }
  startedWarmupKeys.add(warmupKey);
  const tasks = buildWarmupTasks(plan);
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

function buildWarmupTasks(plan: LatestRunWarmupPlan): MemoryWarmupTask[] {
  const frames = [...(plan.manifest.frames || [])].sort((left, right) => left.hour - right.hour);
  const tasks: MemoryWarmupTask[] = [];
  for (const frame of frames) {
    const priority = Math.abs(frame.hour - plan.anchorHour);

    for (const layer of LAYER_STACK_ORDER) {
      if (isReflectivityLayer(layer)) {
        for (const gate of REFLECTIVITY_GATES) {
          appendLayerTask(tasks, frame, layer, priority, gate);
        }
        continue;
      }
      appendLayerTask(tasks, frame, layer, priority);
    }

    for (const mode of SYNOPTIC_DETAIL_MODES) {
      const vectorKey = String(resolveSynopticVectorKey(frame, mode) || "").trim();
      const vectorUrl = String(resolveSynopticVectorRequestUrl(frame, mode) || "").trim();
      if (!vectorKey || !vectorUrl) {
        continue;
      }
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

function buildWarmupKey(plan: LatestRunWarmupPlan): string {
  const run = String(plan.manifest.run || "").trim();
  if (!run || !plan.manifest.frames?.length) {
    return "";
  }
  return [
    plan.modelKey,
    plan.viewKey,
    run,
    plan.manifest.generatedAt || "",
    String(plan.manifest.frames.length),
    "all-artifacts-v1",
  ].join("|");
}

function isMemoryWarmupEnabled(): boolean {
  return String(import.meta.env.VITE_DISABLE_LATEST_RUN_MEMORY_WARMUP || "").trim() !== "1";
}
