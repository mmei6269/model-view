import type { FrameParameterAvailability, FrameRecord, ReflectivityGateDbz, SynopticDetailMode } from "../types";
import { appendQueryParams, buildArtifactUrl } from "./artifact-url";
import { getCachedLayerImageObjectUrl } from "./image-prefetch-cache";

export function resolveLayerUrl(
  frame: FrameRecord | null | undefined,
  layer: string,
  options: { reflectivityGate?: ReflectivityGateDbz } = {},
): string | null {
  const requestUrl = resolveLayerRequestUrl(frame, layer, options);
  if (!requestUrl) {
    return null;
  }
  const cachedObjectUrl = getCachedLayerImageObjectUrl(requestUrl);
  if (cachedObjectUrl) {
    return cachedObjectUrl;
  }
  return requestUrl;
}

export function resolveLayerRequestUrl(
  frame: FrameRecord | null | undefined,
  layer: string,
  options: { reflectivityGate?: ReflectivityGateDbz } = {},
): string | null {
  if (!frame) {
    return null;
  }
  const entry = resolveFrameLayerRef(frame, layer, options.reflectivityGate);
  if (!entry) {
    return null;
  }
  if (!entry.key) {
    return entry.url || null;
  }
  const url = buildArtifactUrl(entry.key);
  return appendQueryParams(url, { b: String(Math.max(0, Number(entry.bytes) || 0)) });
}

export function resolveHoverGridRequestUrl(frame: FrameRecord | null | undefined): string | null {
  const key = String(frame?.hoverGridKey || "").trim();
  if (!key) {
    return null;
  }
  return buildHoverGridRequestUrl(key, frame?.hoverGridBytes, frame?.hoverGridSchemaVersion);
}

export function resolveHoverGridRequestUrls(frame: FrameRecord | null | undefined): string[] {
  const baseUrl = resolveHoverGridRequestUrl(frame);
  if (!frame || !baseUrl) {
    return [];
  }
  const urls = [baseUrl];
  for (const ref of Object.values(frame.hoverGridSupplemental || {})) {
    const key = String(ref?.key || "").trim();
    if (!key || Number(ref?.bytes) <= 0) {
      continue;
    }
    const schemaVersion =
      ref?.schemaVersion === null || ref?.schemaVersion === undefined
        ? frame.hoverGridSchemaVersion
        : ref.schemaVersion;
    urls.push(buildHoverGridRequestUrl(key, ref?.bytes, schemaVersion));
  }
  return urls;
}

export function resolveSynopticVectorKey(
  frame: FrameRecord | null | undefined,
  detailMode: SynopticDetailMode = "simple",
): string | null {
  const resolved = resolveSynopticVectorRef(frame, detailMode);
  return resolved?.key || null;
}

export function resolveSynopticVectorRequestUrl(
  frame: FrameRecord | null | undefined,
  detailMode: SynopticDetailMode = "simple",
): string | null {
  const resolved = resolveSynopticVectorRef(frame, detailMode);
  if (!resolved?.key) {
    return null;
  }
  const url = buildArtifactUrl(resolved.key);
  return appendQueryParams(url, { b: String(Math.max(0, Number(resolved.bytes) || 0)) });
}

export function resolveContourVectorRequestUrl(frame: FrameRecord | null | undefined, layer: string): string | null {
  if (!frame || !layer || resolveFrameParameterAvailability(frame, layer) === "unavailable") {
    return null;
  }
  const ref = frame.contourVectorRefs?.[layer];
  const key = String(ref?.key || "").trim();
  if (!key) {
    return null;
  }
  const url = buildArtifactUrl(key);
  return appendQueryParams(url, { b: String(Math.max(0, Number(ref?.bytes) || 0)) });
}

export function resolveWeatherVectorRequestUrl(frame: FrameRecord | null | undefined, layer: string): string | null {
  if (!frame || !layer || resolveFrameParameterAvailability(frame, layer) === "unavailable") {
    return null;
  }
  const ref = frame.weatherVectorRefs?.[layer];
  const key = String(ref?.key || "").trim();
  if (!key) {
    return null;
  }
  const url = buildArtifactUrl(key);
  return appendQueryParams(url, { b: String(Math.max(0, Number(ref?.bytes) || 0)) });
}

function resolveSynopticVectorRef(
  frame: FrameRecord | null | undefined,
  detailMode: SynopticDetailMode = "simple",
): { key: string; bytes: number } | null {
  if (!frame || resolveFrameParameterAvailability(frame, "synoptic") === "unavailable") {
    return null;
  }
  const mode = detailMode === "detailed" ? "detailed" : "simple";
  const preferred = String(frame.synopticVectorKeys?.[mode] || "").trim();
  if (preferred) {
    return { key: preferred, bytes: Number(frame.synopticVectorBytes?.[mode]) || 0 };
  }
  // A legacy single vector is the simple product. Never silently use it (or
  // the opposite modern mode) for a detailed request: the caller can then
  // present the combined simple raster as an explicitly labelled fallback.
  const legacy = !frame.synopticVectorKeys && mode === "simple" ? String(frame.synopticVectorKey || "").trim() : "";
  if (legacy) {
    return { key: legacy, bytes: Number(frame.synopticVectorBytes?.simple) || 0 };
  }
  return null;
}

export function resolveFrameLayerRef(frame: FrameRecord, layer: string, reflectivityGate: ReflectivityGateDbz = 15) {
  if (resolveFrameParameterAvailability(frame, layer) === "unavailable") {
    return null;
  }
  if (isReflectivityLayer(layer)) {
    const variants =
      frame.reflectivityVariantsByLayer?.[layer] ||
      (layer === "reflectivity" ? frame.reflectivityVariantsByLayer?.reflectivityComposite : null) ||
      (layer === "reflectivity" || layer === "reflectivityComposite" ? frame.reflectivityVariants : null);
    if (variants) {
      const preferred =
        reflectivityGate === 10 ? variants.dbz10 : reflectivityGate === 20 ? variants.dbz20 : variants.dbz15;
      if (preferred) {
        return preferred;
      }
      if (variants.dbz10) {
        return variants.dbz10;
      }
      if (variants.dbz15) {
        return variants.dbz15;
      }
      if (variants.dbz20) {
        return variants.dbz20;
      }
    }
  }
  return frame.layers?.[layer] || null;
}

/**
 * Returns only an explicit per-frame declaration. A missing map/key is
 * intentionally `null`: manifests written before availability metadata must
 * keep resolving their artifact refs rather than being treated as missing.
 */
export function resolveFrameParameterAvailability(
  frame: FrameRecord | null | undefined,
  layer: string,
): FrameParameterAvailability | null {
  if (!frame || !layer || !frame.parameterAvailability) {
    return null;
  }
  const direct = normalizeFrameParameterAvailability(frame.parameterAvailability[layer]);
  if (direct) {
    return direct;
  }
  if (layer === "reflectivity") {
    return normalizeFrameParameterAvailability(frame.parameterAvailability.reflectivityComposite);
  }
  if (layer === "reflectivityComposite") {
    return normalizeFrameParameterAvailability(frame.parameterAvailability.reflectivity);
  }
  return null;
}

export interface SynopticComponentSelection {
  showCenters: boolean;
  showIsobars: boolean;
  showThickness: boolean;
}

/** Resolve the scientific inputs the analyst actually asked to see. */
export function resolveSelectedLayerAvailability(
  frame: FrameRecord | null | undefined,
  layer: string,
  synopticSelection?: SynopticComponentSelection | null,
): FrameParameterAvailability | null {
  if (layer !== "synoptic" || !synopticSelection) {
    return resolveFrameParameterAvailability(frame, layer);
  }
  const requestedKeys: string[] = [];
  if (synopticSelection.showIsobars || synopticSelection.showCenters) {
    requestedKeys.push("synopticIsobars");
  }
  if (synopticSelection.showThickness) {
    requestedKeys.push("synopticThickness");
  }
  if (requestedKeys.length === 0) {
    return resolveFrameParameterAvailability(frame, layer);
  }
  const states = requestedKeys.map((key) => resolveFrameParameterAvailability(frame, key));
  // The aggregate layer is unusable only when every requested component is
  // explicitly unavailable. A mixed pressure/thickness selection remains
  // renderable and the unavailable component is surfaced independently.
  if (states.every((state) => state === "unavailable")) {
    return "unavailable";
  }
  if (states.some((state) => state === "available")) {
    return "available";
  }
  // Older manifests have only the aggregate key; preserve their behavior.
  return resolveFrameParameterAvailability(frame, layer);
}

function buildHoverGridRequestUrl(
  key: string,
  bytes: number | null | undefined,
  schemaVersion: number | null | undefined,
): string {
  const url = buildArtifactUrl(key);
  const resolvedSchemaVersion = resolveHoverGridSchemaIdentity(schemaVersion);
  return appendQueryParams(url, {
    b: String(Math.max(0, Number(bytes) || 0)),
    h: String(resolvedSchemaVersion),
    f: /\.bin\.(?:gz|br)(?:$|[?#])/i.test(key) ? `bin${resolvedSchemaVersion}` : "json2",
  });
}

function resolveHoverGridSchemaIdentity(schemaVersion: number | null | undefined): number {
  if (schemaVersion === null || schemaVersion === undefined) {
    return 0;
  }
  if (
    typeof schemaVersion !== "number" ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 0 ||
    schemaVersion > 4
  ) {
    throw new Error(`Unsupported hover-grid schema identity: ${JSON.stringify(schemaVersion)}`);
  }
  return schemaVersion;
}

function isReflectivityLayer(layer: string): boolean {
  return layer === "reflectivity" || layer === "reflectivityComposite" || layer === "reflectivity1km";
}

function normalizeFrameParameterAvailability(value: unknown): FrameParameterAvailability | null {
  return value === "available" || value === "unavailable" ? value : null;
}
