import type { FrameRecord, ReflectivityGateDbz, SynopticDetailMode } from "../types";
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
    urls.push(buildHoverGridRequestUrl(key, ref?.bytes, ref?.schemaVersion || frame.hoverGridSchemaVersion));
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
  if (!frame || !layer) {
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
  if (!frame || !layer) {
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
  if (!frame) {
    return null;
  }
  const mode = detailMode === "detailed" ? "detailed" : "simple";
  const preferred = String(frame.synopticVectorKeys?.[mode] || "").trim();
  if (preferred) {
    return { key: preferred, bytes: Number(frame.synopticVectorBytes?.[mode]) || 0 };
  }
  const legacy = String(frame.synopticVectorKey || "").trim();
  if (legacy) {
    return { key: legacy, bytes: Number(frame.synopticVectorBytes?.simple) || 0 };
  }
  const alternateMode = mode === "simple" ? "detailed" : "simple";
  const alternate = String(frame.synopticVectorKeys?.[alternateMode] || "").trim();
  return alternate ? { key: alternate, bytes: Number(frame.synopticVectorBytes?.[alternateMode]) || 0 } : null;
}

export function resolveSynopticStyleVersion(
  frame: FrameRecord | null | undefined,
  detailMode: SynopticDetailMode = "simple",
): string | null {
  if (!frame) {
    return null;
  }
  const mode = detailMode === "detailed" ? "detailed" : "simple";
  const preferred = String(frame.synopticStyleVersions?.[mode] || "").trim();
  if (preferred) {
    return preferred;
  }
  const legacy = String(frame.synopticStyleVersion || "").trim();
  if (legacy) {
    return legacy;
  }
  const alternate = String(frame.synopticStyleVersions?.[mode === "simple" ? "detailed" : "simple"] || "").trim();
  return alternate || null;
}

export function resolveFrameLayerRef(frame: FrameRecord, layer: string, reflectivityGate: ReflectivityGateDbz = 15) {
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

function buildHoverGridRequestUrl(
  key: string,
  bytes: number | null | undefined,
  schemaVersion: number | null | undefined,
): string {
  const url = buildArtifactUrl(key);
  return appendQueryParams(url, {
    b: String(Math.max(0, Number(bytes) || 0)),
    h: String(Math.max(0, Number(schemaVersion) || 0)),
    f: /\.bin\.gz(?:$|[?#])/i.test(key) ? "bin3" : "json2",
  });
}

function isReflectivityLayer(layer: string): boolean {
  return layer === "reflectivity" || layer === "reflectivityComposite" || layer === "reflectivity1km";
}
