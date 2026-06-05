import { useMemo } from "react";
import { MODEL_CONFIG } from "../../config/constants";
import { getCachedFramePrefetchState } from "../../core/frame-prefetch";
import { resolveFrameLayerRef } from "../../core/layer-refs";
import { normalizeIsoHour } from "../../core/time";
import type {
  FrameLayerRef,
  FrameHourStatus,
  FrameRecord,
  LayerKey,
  ModelKey,
  ModelManifest,
  PrefetchState,
  ReflectivityGateDbz,
  SynopticDetailMode,
  ValidTimeIso,
} from "../../types";

interface UseFrameStatusArgs {
  activeLayers: Set<LayerKey>;
  frame: FrameRecord | null;
  frameByHour: Map<number, FrameRecord>;
  manifest: ModelManifest | null;
  modelKey: ModelKey;
  prefetchByHour: Record<number, PrefetchState>;
  prefetchCacheRevision: number;
  reflectivityGate: ReflectivityGateDbz;
  synopticDetailMode: SynopticDetailMode;
}

export function useFrameStatus({
  activeLayers,
  frame,
  frameByHour,
  manifest,
  modelKey,
  prefetchByHour,
  prefetchCacheRevision,
  reflectivityGate,
  synopticDetailMode,
}: UseFrameStatusArgs) {
  const plannedHours = useMemo(
    () => buildPlannedHours(manifest, frameByHour, modelKey),
    [frameByHour, manifest, modelKey],
  );
  const effectiveHourStatus = useMemo(
    () => buildEffectiveHourStatus(plannedHours, frameByHour, manifest),
    [frameByHour, manifest, plannedHours],
  );
  const selectedFrameStatus = frame ? effectiveHourStatus[frame.hour] || "pending" : "pending";
  const browserHourStatus = useMemo(() => {
    void prefetchCacheRevision;
    return buildBrowserHourStatus(
      frameByHour,
      manifest,
      prefetchByHour,
      activeLayers,
      reflectivityGate,
      synopticDetailMode,
    );
  }, [
    activeLayers,
    frameByHour,
    manifest,
    prefetchByHour,
    prefetchCacheRevision,
    reflectivityGate,
    synopticDetailMode,
  ]);
  const selectedBrowserFrameStatus = frame ? browserHourStatus[frame.hour] || selectedFrameStatus : selectedFrameStatus;
  const browserLoadedCount = useMemo(
    () => plannedHours.reduce((count, hour) => count + (browserHourStatus[hour] === "loaded" ? 1 : 0), 0),
    [browserHourStatus, plannedHours],
  );
  const frameStatusByValidTime = useMemo(
    () => buildStatusByValidTime(frameByHour, effectiveHourStatus),
    [effectiveHourStatus, frameByHour],
  );
  const browserStatusByValidTime = useMemo(
    () => buildStatusByValidTime(frameByHour, browserHourStatus),
    [browserHourStatus, frameByHour],
  );

  return {
    browserHourStatus,
    browserLoadedCount,
    browserStatusByValidTime,
    browserStatusRevision: buildStatusRevision(browserStatusByValidTime),
    effectiveHourStatus,
    frameStatusByValidTime,
    frameStatusRevision: buildStatusRevision(frameStatusByValidTime),
    loadedFrameCountByValidTime: Object.values(frameStatusByValidTime).filter((status) => status === "loaded").length,
    plannedHours,
    selectedBrowserFrameStatus,
    totalFrameCountByValidTime: Object.keys(frameStatusByValidTime).length,
    totalHours: plannedHours.length,
  };
}

export function normalizeFrameHourStatus(value: unknown): FrameHourStatus {
  if (
    value === "loaded" ||
    value === "loading" ||
    value === "error" ||
    value === "pending" ||
    value === "unavailable"
  ) {
    return value;
  }
  return "pending";
}

function buildPlannedHours(manifest: ModelManifest | null, frameByHour: Map<number, FrameRecord>, modelKey: ModelKey) {
  const planned = new Set<number>();
  for (const key of Object.keys(manifest?.hourStatus || {})) {
    const hour = Number(key);
    if (Number.isFinite(hour) && hour >= 0) {
      planned.add(hour);
    }
  }
  for (const hour of frameByHour.keys()) {
    planned.add(hour);
  }
  if (planned.size === 0) {
    const model = MODEL_CONFIG[modelKey];
    const step = Math.max(1, Number(model.frameStepHours || 1));
    for (let hour = 0; hour <= model.maxHour; hour += step) {
      planned.add(hour);
    }
  }
  return Array.from(planned).sort((a, b) => a - b);
}

function buildEffectiveHourStatus(
  plannedHours: number[],
  frameByHour: Map<number, FrameRecord>,
  manifest: ModelManifest | null,
): Record<number, FrameHourStatus> {
  const fromManifest = manifest?.hourStatus || {};
  const status: Record<number, FrameHourStatus> = {};
  for (const hour of plannedHours) {
    const manifestStatus = normalizeFrameHourStatus(fromManifest[String(hour)]);
    const hasFrame = frameByHour.has(hour);
    if (hasFrame) {
      status[hour] = manifestStatus === "loaded" ? "loaded" : manifestStatus;
      continue;
    }

    status[hour] = manifestStatus === "unavailable" || manifestStatus === "error" ? manifestStatus : "pending";
  }
  return status;
}

function buildBrowserHourStatus(
  frameByHour: Map<number, FrameRecord>,
  manifest: ModelManifest | null,
  prefetchByHour: Record<number, PrefetchState>,
  activeLayers: Set<LayerKey>,
  reflectivityGate: ReflectivityGateDbz,
  synopticDetailMode: SynopticDetailMode,
): Record<number, FrameHourStatus> {
  const out: Record<number, FrameHourStatus> = {};
  for (const [hour, frameEntry] of frameByHour.entries()) {
    const manifestStatus = normalizeFrameHourStatus(manifest?.hourStatus?.[String(hour)]);
    const browserLoadable =
      manifestStatus === "loaded" ||
      hasCompleteActiveLayerRefs(frameEntry, activeLayers, reflectivityGate, synopticDetailMode);
    if (!browserLoadable) {
      out[hour] = manifestStatus;
      continue;
    }
    const cachedStatus = getCachedFramePrefetchState(frameEntry, activeLayers, reflectivityGate, synopticDetailMode);
    if (prefetchByHour[hour] === "loaded" || cachedStatus === "loaded") {
      out[hour] = "loaded";
    } else if (prefetchByHour[hour] === "error") {
      out[hour] = "error";
    } else {
      out[hour] = "loading";
    }
  }
  return out;
}

function hasCompleteActiveLayerRefs(
  frame: FrameRecord,
  activeLayers: Set<LayerKey>,
  reflectivityGate: ReflectivityGateDbz,
  synopticDetailMode: SynopticDetailMode,
): boolean {
  if (activeLayers.size === 0) {
    return false;
  }
  let checked = 0;
  for (const layer of activeLayers) {
    checked += 1;
    if (layer === "synoptic") {
      if (!hasCompleteSynopticRef(frame, synopticDetailMode)) {
        return false;
      }
      continue;
    }
    const layerRef = resolveFrameLayerRef(frame, layer, reflectivityGate);
    const vectorRef = frame.contourVectorRefs?.[layer] || frame.weatherVectorRefs?.[layer] || null;
    if (!hasCompleteFrameLayerRef(layerRef) && !hasCompleteFrameLayerRef(vectorRef)) {
      return false;
    }
  }
  return checked > 0;
}

function hasCompleteSynopticRef(frame: FrameRecord, synopticDetailMode: SynopticDetailMode): boolean {
  if (hasCompleteFrameLayerRef(frame.layers?.synoptic || null)) {
    return true;
  }
  const mode = synopticDetailMode === "detailed" ? "detailed" : "simple";
  const preferredKey = String(frame.synopticVectorKeys?.[mode] || "").trim();
  const preferredBytes = Number(frame.synopticVectorBytes?.[mode]);
  if (preferredKey && Number.isFinite(preferredBytes) && preferredBytes > 0) {
    return true;
  }
  const legacyKey = String(frame.synopticVectorKey || "").trim();
  const legacyBytes = Number(frame.synopticVectorBytes?.simple);
  if (legacyKey && Number.isFinite(legacyBytes) && legacyBytes > 0) {
    return true;
  }
  const alternateMode = mode === "simple" ? "detailed" : "simple";
  const alternateKey = String(frame.synopticVectorKeys?.[alternateMode] || "").trim();
  const alternateBytes = Number(frame.synopticVectorBytes?.[alternateMode]);
  return Boolean(alternateKey && Number.isFinite(alternateBytes) && alternateBytes > 0);
}

function hasCompleteFrameLayerRef(ref: FrameLayerRef | null | undefined): boolean {
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

function buildStatusByValidTime(
  frameByHour: Map<number, FrameRecord>,
  statusByHour: Record<number, FrameHourStatus>,
): Partial<Record<ValidTimeIso, FrameHourStatus>> {
  const out: Partial<Record<ValidTimeIso, FrameHourStatus>> = {};
  for (const [hour, frameEntry] of frameByHour.entries()) {
    const validKey = normalizeIsoHour(frameEntry.validHourKey);
    out[validKey] = statusByHour[hour] || "pending";
  }
  return out;
}

function buildStatusRevision(statusByValidTime: Partial<Record<ValidTimeIso, FrameHourStatus>>): string {
  return Object.entries(statusByValidTime)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([valid, status]) => `${valid}:${status}`)
    .join("|");
}
