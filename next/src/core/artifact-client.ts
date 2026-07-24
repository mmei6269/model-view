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
import { normalizeHoverGridPayload, normalizeOwnedBinaryHoverGridPayload } from "./hover-grid-payload";
import {
  isHoverGridWorkerOwnershipLostError,
  isUsableHoverGridPayload,
  normalizeOwnedBinaryHoverGridPayloadOffMainThread,
  prewarmHoverGridPayloadWorker,
} from "./hover-grid-worker-client";
import { clearLayerImageObjectUrlCache, preloadImage } from "./image-prefetch-cache";
import {
  resolveContourVectorRequestUrl,
  resolveHoverGridRequestUrl,
  resolveHoverGridRequestUrls,
  resolveLayerRequestUrl,
  resolveLayerUrl,
  resolveSynopticVectorRequestUrl,
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
  resolveSynopticVectorKey,
  resolveSynopticVectorRequestUrl,
  resolveWeatherVectorRequestUrl,
};

const MANIFEST_TTL_MS = 60_000;
const PARSED_PAYLOAD_CACHE_LIMIT = resolveCacheMaxEntries(import.meta.env.VITE_PARSED_PAYLOAD_CACHE_MAX_ENTRIES, 8_192);
// Hover payloads are fundamentally different from the small JSON vectors in
// the generic parsed-payload caches: a single full CONUS frame can decode to
// hundreds of MiB of Int16Array storage. Keep only a tiny, real-LRU working
// set and enforce a byte ceiling so timeline scrubbing cannot retain a whole
// run (or several runs) in the JS heap.
const HOVER_GRID_PAYLOAD_CACHE_LIMIT_BYTES = resolveCacheLimitBytes(
  import.meta.env.VITE_HOVER_GRID_CACHE_LIMIT_MB,
  512,
);
const HOVER_GRID_PAYLOAD_CACHE_MAX_ENTRIES = 6;

interface CacheEntry {
  manifest: ModelManifest;
  expiresAt: number;
}

interface RunListCacheEntry {
  runs: RunManifestPointer[];
  expiresAt: number;
}

interface HoverGridPayloadCacheEntry {
  payload: HoverGridPayload;
  metadataBytes: number;
  backingStores: ArrayBufferLike[];
}

interface HoverGridBackingStoreReference {
  bytes: number;
  references: number;
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
const hoverGridPayloadCache = new Map<string, HoverGridPayloadCacheEntry>();
const hoverGridBackingStoreReferences = new Map<ArrayBufferLike, HoverGridBackingStoreReference>();
let hoverGridPayloadCacheBytes = 0;
const hoverGridPayloadInFlight = createSharedRequestMap<HoverGridPayload>();
const pointSoundingPayloadCache = new Map<string, PointSoundingPayload>();
const pointSoundingPayloadInFlight = createSharedRequestMap<PointSoundingPayload>();

export type ParsedPayloadCacheKind = "synoptic-vector" | "contour-vector" | "weather-vector" | "point-sounding";
const parsedPayloadEvictionListeners = new Set<(kind: ParsedPayloadCacheKind, key: string) => void>();

export function subscribeParsedPayloadEvictions(
  listener: (kind: ParsedPayloadCacheKind, key: string) => void,
): () => void {
  parsedPayloadEvictionListeners.add(listener);
  return () => {
    parsedPayloadEvictionListeners.delete(listener);
  };
}

export function isParsedPayloadCached(kind: ParsedPayloadCacheKind, key: string): boolean {
  if (kind === "synoptic-vector") {
    return synopticVectorPayloadCache.has(key);
  }
  if (kind === "contour-vector") {
    return contourVectorPayloadCache.has(key);
  }
  if (kind === "weather-vector") {
    return weatherVectorPayloadCache.has(key);
  }
  return pointSoundingPayloadCache.has(key);
}

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
  const cached = getCachedParsedPayload(synopticVectorPayloadCache, key);
  if (cached) {
    return cached;
  }
  return runSharedRequest(synopticVectorPayloadInFlight, key, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Synoptic vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as SynopticVectorPayload;
      cacheParsedPayload(synopticVectorPayloadCache, key, payload, "synoptic-vector");
      return payload;
    }),
  );
}

export function getCachedSynopticVectorPayload(
  frame: FrameRecord | null | undefined,
  options: PrefetchOptions = {},
): SynopticVectorPayload | null {
  const url = resolveSynopticVectorRequestUrl(frame, options.synopticDetailMode || "simple");
  return url ? getCachedParsedPayload(synopticVectorPayloadCache, url) : null;
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
  const cached = getCachedParsedPayload(contourVectorPayloadCache, url);
  if (cached) {
    return cached;
  }
  return runSharedRequest(contourVectorPayloadInFlight, url, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Contour vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as ContourVectorPayload;
      cacheParsedPayload(contourVectorPayloadCache, url, payload, "contour-vector");
      return payload;
    }),
  );
}

export function getCachedContourVectorPayload(
  frame: FrameRecord | null | undefined,
  layer: LayerKey,
): ContourVectorPayload | null {
  const url = resolveContourVectorRequestUrl(frame, layer);
  return url ? getCachedParsedPayload(contourVectorPayloadCache, url) : null;
}

export async function prefetchContourVectorPayload(
  frame: FrameRecord | null | undefined,
  layer: LayerKey,
  options: PrefetchOptions = {},
): Promise<void> {
  await fetchContourVectorPayload(frame, layer, options);
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
  const cached = getCachedParsedPayload(weatherVectorPayloadCache, url);
  if (cached) {
    return cached;
  }
  return runSharedRequest(weatherVectorPayloadInFlight, url, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Weather vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as WeatherVectorPayload;
      cacheParsedPayload(weatherVectorPayloadCache, url, payload, "weather-vector");
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
  const cached = getCachedHoverGridPayloadByKey(key);
  if (cached) {
    return cached;
  }
  // For the common one-file case the merged key is the URL itself. Nesting a
  // per-URL shared request inside another shared request with that same key
  // replaces the inner entry before abort bookkeeping can see it, leaving a
  // tens-of-megabytes fetch alive after every caller has scrubbed away.
  if (urls.length === 1) {
    return fetchSingleHoverGridPayload(urls[0], options);
  }
  // The merged fetch is itself one consumer of each per-URL fetch, so a
  // caller abort propagates inward only when every merged consumer is gone.
  return runSharedRequest(hoverGridPayloadInFlight, key, options.signal, (sharedSignal) =>
    Promise.all(urls.map((url) => fetchSingleHoverGridPayload(url, { ...options, signal: sharedSignal }))).then(
      (payloads) => {
        const mergedPayload = mergeHoverGridPayloadObjects(payloads);
        cacheHoverGridPayload(key, mergedPayload);
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
  const cached = getCachedHoverGridPayloadByKey(url);
  if (cached) {
    return cached;
  }
  const isBinary = /\.bin\.(?:gz|br)(?:$|[?#])/.test(url);
  if (isBinary && !options.signal?.aborted) {
    // Start the same-origin module worker while the compressed response is in
    // flight, hiding startup behind network transfer and Brotli/gzip decode.
    prewarmHoverGridPayloadWorker();
  }
  return runSharedRequest(hoverGridPayloadInFlight, url, options.signal, async (sharedSignal) => {
    const response = await fetch(url, { cache: "force-cache", signal: sharedSignal });
    if (!response.ok) {
      throw new Error(`Hover grid request failed (${response.status}) for ${url}`);
    }
    const parsedPayload = isBinary
      ? await decodeFetchedBinaryHoverGridPayload(url, await response.arrayBuffer(), sharedSignal)
      : normalizeHoverGridPayload((await response.json()) as HoverGridPayload);
    assertHoverGridPayloadMatchesRequestSchema(url, parsedPayload);
    cacheHoverGridPayload(url, parsedPayload);
    return parsedPayload;
  });
}

async function decodeFetchedBinaryHoverGridPayload(
  url: string,
  ownedBuffer: ArrayBuffer,
  signal: AbortSignal,
): Promise<HoverGridPayload> {
  try {
    const parsedPayload = await normalizeOwnedBinaryHoverGridPayloadOffMainThread(ownedBuffer, signal);
    if (!isUsableHoverGridPayload(parsedPayload)) {
      throw new Error(`Hover grid binary payload decoded to an unusable result for ${url}`);
    }
    assertHoverGridPayloadMatchesRequestSchema(url, parsedPayload);
    return parsedPayload;
  } catch (error) {
    if (!isHoverGridWorkerOwnershipLostError(error)) {
      throw error;
    }
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // A crashed/timed-out worker exclusively owns the detached response
    // buffer; retaining a second 225+ MiB fallback copy would undo Pass 07.
    // Refetch at most once (normally from the HTTP cache), then use the
    // in-process parser. The worker client disables itself after a crash, so
    // later frames also take the safe fallback instead of entering a loop.
    const recoveryResponse = await fetch(url, { cache: "force-cache", signal });
    if (!recoveryResponse.ok) {
      throw new Error(
        `Hover grid recovery request failed (${recoveryResponse.status}) after worker ownership loss for ${url}`,
      );
    }
    const recoveryBuffer = await recoveryResponse.arrayBuffer();
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const recoveredPayload = normalizeOwnedBinaryHoverGridPayload(recoveryBuffer);
    if (!isUsableHoverGridPayload(recoveredPayload)) {
      throw new Error(`Hover grid recovery payload decoded to an unusable result for ${url}`);
    }
    assertHoverGridPayloadMatchesRequestSchema(url, recoveredPayload);
    return recoveredPayload;
  }
}

function mergeHoverGridPayloadObjects(payloads: HoverGridPayload[]): HoverGridPayload {
  if (payloads.length === 1) {
    return payloads[0];
  }
  const [base] = payloads;
  if (
    payloads.some((payload) => Number(payload.rows) !== Number(base.rows) || Number(payload.cols) !== Number(base.cols))
  ) {
    throw new Error("Hover grid supplemental payload dimensions do not match the base payload");
  }
  return {
    schemaVersion: Math.max(...payloads.map((payload) => Number(payload.schemaVersion) || 0)),
    rows: base.rows,
    cols: base.cols,
    variables: Object.assign({}, ...payloads.map((payload) => payload.variables || {})),
  };
}

function assertHoverGridPayloadMatchesRequestSchema(url: string, payload: HoverGridPayload): void {
  const expected = hoverGridRequestSchemaVersion(url);
  if (expected === null) {
    return;
  }
  if (payload.schemaVersion !== expected) {
    throw new Error(
      `Hover grid schema mismatch for ${url}: request declared ${expected}, payload decoded as ${payload.schemaVersion}`,
    );
  }
}

function hoverGridRequestSchemaVersion(url: string): number | null {
  let value: string | null;
  try {
    value = new URL(url, "http://modelview.invalid").searchParams.get("h");
  } catch {
    throw new Error(`Hover grid request URL is invalid: ${url}`);
  }
  if (value === null || value === "" || value === "0") {
    return null;
  }
  const schemaVersion = Number(value);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 4) {
    throw new Error(`Hover grid request URL has unsupported schema identity ${JSON.stringify(value)}: ${url}`);
  }
  return schemaVersion;
}

function buildHoverGridPayloadCacheKey(urls: string[]): string {
  return urls.join("|");
}

export function getCachedHoverGridPayload(requestUrl: string | null | undefined): HoverGridPayload | null {
  const key = String(requestUrl || "").trim();
  if (!key) {
    return null;
  }
  return getCachedHoverGridPayloadByKey(key);
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
  const cached = getCachedParsedPayload(pointSoundingPayloadCache, cacheKey);
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
      cacheParsedPayload(pointSoundingPayloadCache, cacheKey, payload, "point-sounding");
      return payload;
    }),
  );
}

function cacheParsedPayload<T>(cache: Map<string, T>, key: string, payload: T, kind: ParsedPayloadCacheKind): void {
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
    notifyParsedPayloadEviction(kind, oldest);
  }
}

function notifyParsedPayloadEviction(kind: ParsedPayloadCacheKind, key: string): void {
  for (const listener of parsedPayloadEvictionListeners) {
    try {
      listener(kind, key);
    } catch {
      // Cache accounting is advisory. A consumer must not be able to turn a
      // successful artifact fetch into an interactive failure.
    }
  }
}

function getCachedParsedPayload<T>(cache: Map<string, T>, key: string): T | null {
  const cached = cache.get(key);
  if (!cached) {
    return null;
  }
  // Map insertion order is the eviction order, so a cache hit must move the
  // entry to the newest end for the advertised LRU behavior to be real.
  cache.delete(key);
  cache.set(key, cached);
  return cached;
}

function getCachedHoverGridPayloadByKey(key: string): HoverGridPayload | null {
  const entry = hoverGridPayloadCache.get(key);
  if (!entry) {
    return null;
  }
  hoverGridPayloadCache.delete(key);
  hoverGridPayloadCache.set(key, entry);
  return entry.payload;
}

function cacheHoverGridPayload(key: string, payload: HoverGridPayload): void {
  deleteCachedHoverGridPayload(key);
  const entry = describeHoverGridPayloadCacheEntry(payload);
  hoverGridPayloadCache.set(key, entry);
  retainHoverGridPayloadCacheEntry(entry);
  while (
    hoverGridPayloadCache.size > HOVER_GRID_PAYLOAD_CACHE_MAX_ENTRIES ||
    hoverGridPayloadCacheBytes > HOVER_GRID_PAYLOAD_CACHE_LIMIT_BYTES
  ) {
    const oldestKey = hoverGridPayloadCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    deleteCachedHoverGridPayload(oldestKey);
  }
}

function describeHoverGridPayloadCacheEntry(payload: HoverGridPayload): HoverGridPayloadCacheEntry {
  let metadataBytes = 64;
  const backingStores = new Set<ArrayBufferLike>();
  for (const [key, variable] of Object.entries(payload.variables || {})) {
    metadataBytes += key.length * 2 + 48;
    const backingStore = variable?.values?.buffer;
    if (backingStore && Number.isSafeInteger(backingStore.byteLength) && backingStore.byteLength >= 0) {
      backingStores.add(backingStore);
    }
    metadataBytes += typeof variable?.data === "string" ? variable.data.length * 2 : 0;
  }
  return { payload, metadataBytes, backingStores: Array.from(backingStores) };
}

function retainHoverGridPayloadCacheEntry(entry: HoverGridPayloadCacheEntry): void {
  hoverGridPayloadCacheBytes += entry.metadataBytes;
  for (const backingStore of entry.backingStores) {
    const existing = hoverGridBackingStoreReferences.get(backingStore);
    if (existing) {
      existing.references += 1;
      continue;
    }
    const bytes = backingStore.byteLength;
    hoverGridBackingStoreReferences.set(backingStore, { bytes, references: 1 });
    hoverGridPayloadCacheBytes += bytes;
  }
}

function deleteCachedHoverGridPayload(key: string): boolean {
  const entry = hoverGridPayloadCache.get(key);
  if (!entry) {
    return false;
  }
  hoverGridPayloadCache.delete(key);
  hoverGridPayloadCacheBytes -= entry.metadataBytes;
  for (const backingStore of entry.backingStores) {
    const reference = hoverGridBackingStoreReferences.get(backingStore);
    if (!reference) {
      continue;
    }
    if (reference.references > 1) {
      reference.references -= 1;
      continue;
    }
    hoverGridBackingStoreReferences.delete(backingStore);
    hoverGridPayloadCacheBytes -= reference.bytes;
  }
  return true;
}

export function _testGetHoverGridPayloadCacheStats(): {
  entries: number;
  bytes: number;
  metadataBytes: number;
  backingStores: number;
  backingBytes: number;
  backingReferences: number[];
} {
  const references = Array.from(hoverGridBackingStoreReferences.values());
  return {
    entries: hoverGridPayloadCache.size,
    bytes: hoverGridPayloadCacheBytes,
    metadataBytes: Array.from(hoverGridPayloadCache.values()).reduce((sum, entry) => sum + entry.metadataBytes, 0),
    backingStores: references.length,
    backingBytes: references.reduce((sum, reference) => sum + reference.bytes, 0),
    backingReferences: references.map((reference) => reference.references).sort((left, right) => left - right),
  };
}

export function _testCacheHoverGridPayload(key: string, payload: HoverGridPayload): void {
  cacheHoverGridPayload(key, payload);
}

export function _testDeleteCachedHoverGridPayload(key: string): boolean {
  return deleteCachedHoverGridPayload(key);
}

export function _testResetHoverGridPayloadCache(): void {
  for (const key of Array.from(hoverGridPayloadCache.keys())) {
    deleteCachedHoverGridPayload(key);
  }
}

function resolveCacheLimitBytes(value: unknown, fallbackMb: number): number {
  const mb = Number(value);
  const normalizedMb = Number.isFinite(mb) && mb > 0 ? mb : fallbackMb;
  return Math.round(normalizedMb * 1024 * 1024);
}

function resolveCacheMaxEntries(value: unknown, fallback: number): number {
  const entries = Number(value);
  return Number.isFinite(entries) && entries > 0 ? Math.max(1, Math.floor(entries)) : fallback;
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
