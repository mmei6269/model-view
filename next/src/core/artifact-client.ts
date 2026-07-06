import type {
  ContourVectorPayload,
  FrameRecord,
  HoverGridPayload,
  LayerKey,
  LatestManifestPointer,
  ModelKey,
  ModelManifest,
  PointSoundingPayload,
  ReflectivityGateDbz,
  RunManifestPointer,
  SynopticDetailMode,
  SynopticVectorPayload,
  WeatherVectorPayload,
  ViewKey,
} from "../types";
import {
  appendQueryParams,
  buildArtifactUrl,
  getArtifactBaseUrl,
  getCandidateArtifactBaseUrls,
  resetResolvedArtifactBaseUrl,
  setResolvedArtifactBaseUrl,
} from "./artifact-url";
import { normalizeBinaryHoverGridPayload, normalizeHoverGridPayload } from "./hover-grid-payload";
import { clearLayerImageObjectUrlCache, preloadImage } from "./image-prefetch-cache";
import {
  resolveContourVectorRequestUrl,
  resolveHoverGridRequestUrl,
  resolveHoverGridRequestUrls,
  resolveLayerRequestUrl,
  resolveLayerUrl,
  resolveSynopticVectorRequestUrl,
  resolveSynopticStyleVersion,
  resolveSynopticVectorKey,
  resolveWeatherVectorRequestUrl,
} from "./layer-refs";
import { buildValidTimeAxis, formatRunLabel, normalizeManifest, resolveFrameByValidTime } from "./manifest-utils";
import { createSharedRequestMap, runSharedRequest } from "./shared-abortable-request";

export {
  buildArtifactUrl,
  buildValidTimeAxis,
  formatRunLabel,
  getArtifactBaseUrl,
  normalizeManifest,
  resolveFrameByValidTime,
  resolveHoverGridRequestUrl,
  resolveHoverGridRequestUrls,
  resolveContourVectorRequestUrl,
  resolveLayerRequestUrl,
  resolveLayerUrl,
  resolveSynopticStyleVersion,
  resolveSynopticVectorKey,
  resolveSynopticVectorRequestUrl,
  resolveWeatherVectorRequestUrl,
};

const MANIFEST_TTL_MS = 60_000;
const PARSED_PAYLOAD_CACHE_LIMIT = 8_192;

interface CacheEntry {
  manifest: ModelManifest;
  expiresAt: number;
}

interface RunListCacheEntry {
  runs: RunManifestPointer[];
  expiresAt: number;
}

interface PrefetchOptions {
  decode?: boolean;
  signal?: AbortSignal;
  reflectivityGate?: ReflectivityGateDbz;
  synopticDetailMode?: SynopticDetailMode;
}

interface ManifestFetchOptions {
  forceRefresh?: boolean;
  runId?: string | null;
}

const manifestCache = new Map<string, CacheEntry>();
const runListCache = new Map<string, RunListCacheEntry>();
const synopticVectorPayloadCache = new Map<string, SynopticVectorPayload>();
const synopticVectorPayloadInFlight = createSharedRequestMap<SynopticVectorPayload>();
const contourVectorPayloadCache = new Map<string, ContourVectorPayload>();
const contourVectorPayloadInFlight = createSharedRequestMap<ContourVectorPayload>();
const weatherVectorPayloadCache = new Map<string, WeatherVectorPayload>();
const weatherVectorPayloadInFlight = createSharedRequestMap<WeatherVectorPayload>();
const hoverGridPayloadCache = new Map<string, HoverGridPayload>();
const hoverGridPayloadInFlight = createSharedRequestMap<HoverGridPayload>();
const pointSoundingPayloadCache = new Map<string, PointSoundingPayload>();
const pointSoundingPayloadInFlight = createSharedRequestMap<PointSoundingPayload>();

export async function fetchModelManifestWithOptions(
  modelKey: ModelKey,
  viewKey: ViewKey,
  options: ManifestFetchOptions = {},
): Promise<ModelManifest> {
  const requestedRunId = String(options.runId || "").trim();
  const cacheKey = `${modelKey}|${viewKey}|${requestedRunId || "latest"}`;
  const now = Date.now();
  const cached = manifestCache.get(cacheKey);
  const forceRefresh = Boolean(options.forceRefresh);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.manifest;
  }

  const errors: string[] = [];
  let manifest: ModelManifest | null = null;
  for (const baseUrl of getCandidateArtifactBaseUrls()) {
    try {
      let manifestUrl = "";
      if (requestedRunId) {
        manifestUrl = appendQueryParams(`${baseUrl}/manifests/${modelKey}/${requestedRunId}.json`, {
          view: viewKey,
          t: String(now),
        });
      } else {
        const latestUrl = `${baseUrl}/manifests/${modelKey}/latest.json`;
        const latest = await fetchJson<LatestManifestPointer>(
          appendQueryParams(latestUrl, { view: viewKey, t: String(now) }),
        );
        if (!latest?.manifestKey) {
          throw new Error(`Missing latest manifest key in ${latestUrl}`);
        }
        manifestUrl = appendQueryParams(`${baseUrl}/${String(latest.manifestKey).replace(/^\/+/, "")}`, {
          t: String(now),
        });
      }
      manifest = await fetchJson<ModelManifest>(manifestUrl);
      setResolvedArtifactBaseUrl(baseUrl);
      break;
    } catch (error) {
      errors.push(`${baseUrl}: ${String(error instanceof Error ? error.message : error)}`);
      if (isResourceLevelFailure(error)) {
        break;
      }
    }
  }

  if (!manifest) {
    throw new Error(`Unable to load manifest for ${modelKey}/${viewKey}. Tried: ${errors.join(" | ")}`);
  }

  const normalized = normalizeManifest(manifest, modelKey, viewKey);
  manifestCache.set(cacheKey, { manifest: normalized, expiresAt: now + MANIFEST_TTL_MS });
  return normalized;
}

export async function fetchModelRunsWithOptions(
  modelKey: ModelKey,
  viewKey: ViewKey,
  options: { forceRefresh?: boolean } = {},
): Promise<RunManifestPointer[]> {
  const cacheKey = `${modelKey}|${viewKey}`;
  const now = Date.now();
  const cached = runListCache.get(cacheKey);
  const forceRefresh = Boolean(options.forceRefresh);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.runs;
  }

  const errors: string[] = [];
  for (const baseUrl of getCandidateArtifactBaseUrls()) {
    try {
      const payload = await fetchJson<{ runs?: RunManifestPointer[] }>(
        appendQueryParams(`${baseUrl}/manifests/${modelKey}/runs.json`, { view: viewKey, t: String(now) }),
      );
      const runs = Array.isArray(payload.runs) ? payload.runs : [];
      runListCache.set(cacheKey, { runs, expiresAt: now + MANIFEST_TTL_MS });
      setResolvedArtifactBaseUrl(baseUrl);
      return runs;
    } catch (error) {
      errors.push(`${baseUrl}: ${String(error instanceof Error ? error.message : error)}`);
      if (isResourceLevelFailure(error)) {
        break;
      }
    }
  }

  try {
    const manifest = await fetchModelManifestWithOptions(modelKey, viewKey, { forceRefresh });
    const fallback = [
      {
        model: manifest.model,
        run: manifest.run,
        view: manifest.view,
        generatedAt: manifest.generatedAt,
        manifestKey: `manifests/${manifest.model}/${manifest.run}.json?view=${encodeURIComponent(manifest.view)}`,
        frameCount: manifest.frames.length,
        loadedFrameCount: manifest.frames.length,
        complete: true,
        latest: true,
      },
    ];
    runListCache.set(cacheKey, { runs: fallback, expiresAt: now + MANIFEST_TTL_MS });
    return fallback;
  } catch {
    throw new Error(`Unable to load runs for ${modelKey}/${viewKey}. Tried: ${errors.join(" | ")}`);
  }
}

export async function prefetchFrameAssets(
  frame: FrameRecord | null | undefined,
  layers: LayerKey[],
  options: PrefetchOptions = {},
): Promise<void> {
  if (!frame || !Array.isArray(layers) || layers.length === 0) {
    return;
  }
  const urls = layers
    .map((layer) => resolveLayerRequestUrl(frame, layer, { reflectivityGate: options.reflectivityGate }))
    .filter((value): value is string => Boolean(value));
  if (urls.length === 0) {
    return;
  }
  await Promise.all(urls.map((url) => preloadImage(url, options)));
}

export async function fetchSynopticVectorPayload(
  frame: FrameRecord | null | undefined,
  options: PrefetchOptions = {},
): Promise<SynopticVectorPayload | null> {
  const url = resolveSynopticVectorRequestUrl(frame, options.synopticDetailMode || "simple");
  if (!url) {
    return null;
  }
  const key = url;
  const cached = synopticVectorPayloadCache.get(key);
  if (cached) {
    return cached;
  }
  return runSharedRequest(synopticVectorPayloadInFlight, key, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Synoptic vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as SynopticVectorPayload;
      cacheParsedPayload(synopticVectorPayloadCache, key, payload);
      return payload;
    }),
  );
}

export async function prefetchSynopticVectorPayload(
  frame: FrameRecord | null | undefined,
  options: PrefetchOptions = {},
): Promise<void> {
  await fetchSynopticVectorPayload(frame, options);
}

export async function fetchContourVectorPayload(
  frame: FrameRecord | null | undefined,
  layer: LayerKey,
  options: PrefetchOptions = {},
): Promise<ContourVectorPayload | null> {
  const url = resolveContourVectorRequestUrl(frame, layer);
  if (!url) {
    return null;
  }
  const cached = contourVectorPayloadCache.get(url);
  if (cached) {
    return cached;
  }
  return runSharedRequest(contourVectorPayloadInFlight, url, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Contour vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as ContourVectorPayload;
      cacheParsedPayload(contourVectorPayloadCache, url, payload);
      return payload;
    }),
  );
}

export async function fetchWeatherVectorPayload(
  frame: FrameRecord | null | undefined,
  layer: LayerKey,
  options: PrefetchOptions = {},
): Promise<WeatherVectorPayload | null> {
  const url = resolveWeatherVectorRequestUrl(frame, layer);
  if (!url) {
    return null;
  }
  const cached = weatherVectorPayloadCache.get(url);
  if (cached) {
    return cached;
  }
  return runSharedRequest(weatherVectorPayloadInFlight, url, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Weather vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as WeatherVectorPayload;
      cacheParsedPayload(weatherVectorPayloadCache, url, payload);
      return payload;
    }),
  );
}

export async function prefetchWeatherVectorPayload(
  frame: FrameRecord | null | undefined,
  layer: LayerKey,
  options: PrefetchOptions = {},
): Promise<void> {
  await fetchWeatherVectorPayload(frame, layer, options);
}

export async function fetchHoverGridPayload(
  frame: FrameRecord | null | undefined,
  options: PrefetchOptions = {},
): Promise<HoverGridPayload | null> {
  const urls = resolveHoverGridRequestUrls(frame);
  if (urls.length === 0) {
    return null;
  }
  const key = buildHoverGridPayloadCacheKey(urls);
  const cached = hoverGridPayloadCache.get(key);
  if (cached) {
    return cached;
  }
  // The merged fetch is itself one consumer of each per-URL fetch, so a
  // caller abort propagates inward only when every merged consumer is gone.
  return runSharedRequest(hoverGridPayloadInFlight, key, options.signal, (sharedSignal) =>
    Promise.all(urls.map((url) => fetchSingleHoverGridPayload(url, { ...options, signal: sharedSignal }))).then(
      (payloads) => {
        const mergedPayload = mergeHoverGridPayloadObjects(payloads);
        cacheParsedPayload(hoverGridPayloadCache, key, mergedPayload);
        return mergedPayload;
      },
    ),
  );
}

export async function prefetchHoverGridPayload(
  frame: FrameRecord | null | undefined,
  options: PrefetchOptions = {},
): Promise<void> {
  await fetchHoverGridPayload(frame, options);
}

async function fetchSingleHoverGridPayload(url: string, options: PrefetchOptions): Promise<HoverGridPayload> {
  const cached = hoverGridPayloadCache.get(url);
  if (cached) {
    return cached;
  }
  return runSharedRequest(hoverGridPayloadInFlight, url, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Hover grid request failed (${response.status}) for ${url}`);
      }
      const parsedPayload = /\.bin\.gz(?:$|[?#])/.test(url)
        ? normalizeBinaryHoverGridPayload(await response.arrayBuffer())
        : normalizeHoverGridPayload((await response.json()) as HoverGridPayload);
      cacheParsedPayload(hoverGridPayloadCache, url, parsedPayload);
      return parsedPayload;
    }),
  );
}

function mergeHoverGridPayloadObjects(payloads: HoverGridPayload[]): HoverGridPayload {
  if (payloads.length === 1) {
    return payloads[0];
  }
  const [base] = payloads;
  return {
    schemaVersion: Math.max(...payloads.map((payload) => Number(payload.schemaVersion) || 0)),
    rows: base.rows,
    cols: base.cols,
    variables: Object.assign({}, ...payloads.map((payload) => payload.variables || {})),
  };
}

function buildHoverGridPayloadCacheKey(urls: string[]): string {
  return urls.join("|");
}

export function getCachedHoverGridPayload(requestUrl: string | null | undefined): HoverGridPayload | null {
  const key = String(requestUrl || "").trim();
  if (!key) {
    return null;
  }
  return hoverGridPayloadCache.get(key) || null;
}

export async function fetchPointSoundingPayload({
  modelKey,
  runId,
  viewKey,
  hour,
  lat,
  lon,
  signal,
}: {
  modelKey: ModelKey;
  runId: string;
  viewKey: ViewKey;
  hour: number;
  lat: number;
  lon: number;
  signal?: AbortSignal;
}): Promise<PointSoundingPayload> {
  const safeRunId = encodeURIComponent(String(runId || "").trim());
  const safeHour = Math.max(0, Math.round(Number(hour) || 0));
  const baseUrl = `${getArtifactBaseUrl()}/soundings/${modelKey}/${safeRunId}/${safeHour}`;
  const url = appendQueryParams(baseUrl, {
    view: viewKey,
    lat: String(lat),
    lon: String(lon),
  });
  const cacheKey = `${modelKey}|${runId}|${viewKey}|${safeHour}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
  const cached = pointSoundingPayloadCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  return runSharedRequest(pointSoundingPayloadInFlight, cacheKey, signal, (sharedSignal) =>
    fetch(url, { cache: "no-store", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        let reason: string;
        try {
          const payload = (await response.json()) as { error?: string };
          reason = payload.error ? `: ${payload.error}` : "";
        } catch {
          reason = "";
        }
        throw new Error(`Point sounding request failed (${response.status})${reason}`);
      }
      const payload = (await response.json()) as PointSoundingPayload;
      cacheParsedPayload(pointSoundingPayloadCache, cacheKey, payload);
      return payload;
    }),
  );
}

function cacheParsedPayload<T>(cache: Map<string, T>, key: string, payload: T): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, payload);
  while (cache.size > PARSED_PAYLOAD_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) {
      break;
    }
    cache.delete(oldest);
  }
}

class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`Request failed (${status}): ${url}`);
    this.status = status;
  }
}

// Origin failover exists for origin-level outages: the fetch itself failing
// (network/CORS/connection refused) or the origin erroring server-side (5xx,
// which is also what the vite /__cf proxy returns when its target is down). A
// 4xx means the origin is reachable and definitively lacks the resource — the
// same request would 404 anywhere — so failing over is wrong. Worse, a success
// on a fallback origin repoints the resolved artifact base (and with it every
// subsequent action POST) away from the same-origin dev proxy.
function isResourceLevelFailure(error: unknown): boolean {
  return error instanceof HttpStatusError && error.status < 500;
}

async function fetchJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error);
    throw new Error(`Network request failed for ${url} (${reason})`, { cause: error });
  }
  if (!response.ok) {
    throw new HttpStatusError(response.status, url);
  }
  return (await response.json()) as T;
}
