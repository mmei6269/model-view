import { createSharedRequestMap, runSharedRequest } from "./shared-abortable-request";

interface ImagePrefetchOptions {
  decode?: boolean;
  signal?: AbortSignal;
}

// Budgets are configured in MB; defaults per spec P1.12: 2 GiB object-URL blobs, 4 GiB decoded bitmaps.
let imageObjectUrlCacheLimitBytes = resolveCacheLimitBytes(
  import.meta.env.VITE_IMAGE_OBJECT_URL_CACHE_LIMIT_MB,
  2 * 1024,
);
const DECODED_IMAGE_CACHE_LIMIT_BYTES = resolveCacheLimitBytes(
  import.meta.env.VITE_DECODED_IMAGE_CACHE_LIMIT_MB,
  4 * 1024,
);

const layerImageObjectUrlCache = new Map<string, { objectUrl: string; bytes: number }>();
let layerImageObjectUrlCacheBytes = 0;
const decodedLayerImageCache = new Map<string, { image: HTMLImageElement; bytes: number }>();
let decodedLayerImageCacheBytes = 0;
// Prefetch engines, live panel application, and latest-run warmup can all ask
// for the same image in the same tick. Share both the blob/object-URL work and
// decode work; each caller retains independent abort semantics.
const layerImageObjectUrlInFlight = createSharedRequestMap<string>();
const decodedLayerImageInFlight = createSharedRequestMap<HTMLImageElement>();

function resolveCacheLimitBytes(value: unknown, fallbackMb: number): number {
  const mb = Number(value);
  const normalizedMb = Number.isFinite(mb) && mb > 0 ? mb : fallbackMb;
  return Math.round(normalizedMb * 1024 * 1024);
}

type LayerImageEvictionListener = (requestUrl: string) => void;
const layerImageEvictionListeners = new Set<LayerImageEvictionListener>();

export function subscribeLayerImageObjectUrlEvictions(listener: LayerImageEvictionListener): () => void {
  layerImageEvictionListeners.add(listener);
  return () => {
    layerImageEvictionListeners.delete(listener);
  };
}

function notifyLayerImageObjectUrlEvicted(requestUrl: string): void {
  for (const listener of layerImageEvictionListeners) {
    listener(requestUrl);
  }
}

export async function preloadImage(url: string, options: ImagePrefetchOptions = {}): Promise<void> {
  const cachedObjectUrl = getCachedLayerImageObjectUrl(url);
  if (cachedObjectUrl) {
    if (options.decode) {
      await ensureDecodedLayerImage(url, cachedObjectUrl, options.signal);
    }
    return;
  }

  if (isLayerImageObjectUrlCacheable(url)) {
    const objectUrl = await runSharedRequest(layerImageObjectUrlInFlight, url, options.signal, async (sharedSignal) => {
      const racedCacheHit = getCachedLayerImageObjectUrl(url);
      if (racedCacheHit) {
        return racedCacheHit;
      }
      const blob = await fetchImageBlob(url, sharedSignal);
      const createdObjectUrl = URL.createObjectURL(blob);
      cacheLayerImageObjectUrl(url, createdObjectUrl, blob.size);
      return getCachedLayerImageObjectUrl(url) ?? createdObjectUrl;
    });
    if (options.decode) {
      try {
        await ensureDecodedLayerImage(url, objectUrl, options.signal);
      } catch (error) {
        if (isAbortLikeError(error)) {
          throw error;
        }
      }
    }
    return;
  }

  const image = await loadImage(url, options.signal, Boolean(options.decode));
  if (options.decode) {
    cacheDecodedLayerImage(url, image);
  }
}

async function ensureDecodedLayerImage(url: string, fallbackObjectUrl: string, signal?: AbortSignal): Promise<void> {
  if (getCachedDecodedLayerImage(url)) {
    return;
  }
  await runSharedRequest(decodedLayerImageInFlight, url, signal, async (sharedSignal) => {
    const racedDecodeHit = getCachedDecodedLayerImage(url);
    if (racedDecodeHit) {
      return racedDecodeHit;
    }
    // The object URL can be touched/replaced by cache pressure between the
    // shared fetch and decode; always resolve the live cache entry.
    const liveObjectUrl = getCachedLayerImageObjectUrl(url) ?? fallbackObjectUrl;
    const image = await loadImage(liveObjectUrl, sharedSignal, true);
    cacheDecodedLayerImage(url, image);
    return image;
  });
}

// Shared residency predicate for raster completion paths (panel prefetch
// engine + latest-run warmup): a cacheable URL counts as resident only while
// its object URL is live; non-cacheable URLs (data:/blob:) have no cache
// entry to be evicted from and are always "resident". Keeping this in one
// place is what stops the two engines' guards from drifting apart.
export function isLayerImageUrlResident(requestUrl: string): boolean {
  const url = String(requestUrl || "");
  return !url || !isLayerImageObjectUrlCacheable(url) || Boolean(getCachedLayerImageObjectUrl(url));
}

export function getCachedLayerImageObjectUrl(requestUrl: string): string | null {
  const key = String(requestUrl || "");
  if (!key) {
    return null;
  }
  const entry = layerImageObjectUrlCache.get(key);
  if (!entry) {
    return null;
  }
  touchLayerImageObjectUrlEntry(key, entry);
  return entry.objectUrl;
}

export function clearLayerImageObjectUrlCache(): void {
  const evictedKeys = Array.from(layerImageObjectUrlCache.keys());
  for (const [, entry] of layerImageObjectUrlCache.entries()) {
    URL.revokeObjectURL(entry.objectUrl);
  }
  layerImageObjectUrlCache.clear();
  layerImageObjectUrlCacheBytes = 0;
  decodedLayerImageCache.clear();
  decodedLayerImageCacheBytes = 0;
  for (const key of evictedKeys) {
    notifyLayerImageObjectUrlEvicted(key);
  }
}

async function fetchImageBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "force-cache",
      signal,
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new DOMException("Aborted", "AbortError");
    }
    throw new Error(`Image prefetch failed for ${url}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Image prefetch failed for ${url} (${response.status})`);
  }
  return response.blob();
}

async function loadImage(url: string, signal?: AbortSignal, decode = false): Promise<HTMLImageElement> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const image = new Image();
  image.decoding = "async";
  let abortListener: (() => void) | null = null;
  const clearHandlers = () => {
    image.onload = null;
    image.onerror = null;
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
      abortListener = null;
    }
  };
  const loaded = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (resolver: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearHandlers();
      resolver();
    };
    image.onload = () => settle(() => resolve());
    image.onerror = () => settle(() => reject(new Error(`Image prefetch failed for ${url}`)));
    if (signal) {
      abortListener = () => {
        image.src = "";
        settle(() => reject(new DOMException("Aborted", "AbortError")));
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  image.src = url;
  await loaded.finally(() => {
    clearHandlers();
  });
  if (decode && typeof image.decode === "function") {
    await image.decode().catch(() => undefined);
  }
  return image;
}

export function isLayerImageObjectUrlCacheable(url: string): boolean {
  if (!url) {
    return false;
  }
  if (url.startsWith("blob:") || url.startsWith("data:")) {
    return false;
  }
  if (url.startsWith("/") || url.startsWith("http://") || url.startsWith("https://")) {
    return true;
  }
  return false;
}

function touchLayerImageObjectUrlEntry(key: string, entry: { objectUrl: string; bytes: number }): void {
  layerImageObjectUrlCache.delete(key);
  layerImageObjectUrlCache.set(key, entry);
  const decoded = decodedLayerImageCache.get(key);
  if (decoded) {
    touchDecodedLayerImageEntry(key, decoded);
  }
}

function cacheLayerImageObjectUrl(requestUrl: string, objectUrl: string, bytes: number): void {
  const key = String(requestUrl || "");
  if (!key) {
    URL.revokeObjectURL(objectUrl);
    return;
  }
  const existing = layerImageObjectUrlCache.get(key);
  if (existing) {
    // FIRST write wins. An existing entry here means two concurrent
    // preloads of the same request URL raced (both missed, both fetched,
    // both minted an object URL for the SAME bytes). The old path revoked
    // the existing URL in favor of the newcomer — but the existing URL is
    // the one consumers may already HOLD: the map engine's ImageSource
    // fetch of it died mid-flight with net::ERR_FILE_NOT_FOUND and the
    // frame never reported loaded (Task 5.2, offline-boot spec under
    // parallel contention). Keep the handed-out URL; release the loser.
    if (existing.objectUrl !== objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
    touchLayerImageObjectUrlEntry(key, existing);
    return;
  }
  const normalizedBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  layerImageObjectUrlCache.set(key, { objectUrl, bytes: normalizedBytes });
  layerImageObjectUrlCacheBytes += normalizedBytes;
  enforceLayerImageObjectUrlBudget();
}

function enforceLayerImageObjectUrlBudget(): void {
  while (layerImageObjectUrlCacheBytes > imageObjectUrlCacheLimitBytes && layerImageObjectUrlCache.size > 0) {
    const oldestKey = layerImageObjectUrlCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    const oldest = layerImageObjectUrlCache.get(oldestKey);
    layerImageObjectUrlCache.delete(oldestKey);
    if (!oldest) {
      continue;
    }
    layerImageObjectUrlCacheBytes = Math.max(0, layerImageObjectUrlCacheBytes - oldest.bytes);
    URL.revokeObjectURL(oldest.objectUrl);
    evictDecodedLayerImage(oldestKey);
    notifyLayerImageObjectUrlEvicted(oldestKey);
  }
}

function getCachedDecodedLayerImage(requestUrl: string): HTMLImageElement | null {
  const key = String(requestUrl || "");
  if (!key) {
    return null;
  }
  const entry = decodedLayerImageCache.get(key);
  if (!entry) {
    return null;
  }
  touchDecodedLayerImageEntry(key, entry);
  return entry.image;
}

function touchDecodedLayerImageEntry(key: string, entry: { image: HTMLImageElement; bytes: number }): void {
  decodedLayerImageCache.delete(key);
  decodedLayerImageCache.set(key, entry);
}

function cacheDecodedLayerImage(requestUrl: string, image: HTMLImageElement): void {
  const key = String(requestUrl || "");
  if (!key) {
    return;
  }
  evictDecodedLayerImage(key);
  const bytes = estimateDecodedImageBytes(image);
  decodedLayerImageCache.set(key, { image, bytes });
  decodedLayerImageCacheBytes += bytes;
  enforceDecodedLayerImageBudget();
}

function evictDecodedLayerImage(key: string): void {
  const existing = decodedLayerImageCache.get(key);
  if (!existing) {
    return;
  }
  decodedLayerImageCache.delete(key);
  decodedLayerImageCacheBytes = Math.max(0, decodedLayerImageCacheBytes - existing.bytes);
}

function enforceDecodedLayerImageBudget(): void {
  while (decodedLayerImageCacheBytes > DECODED_IMAGE_CACHE_LIMIT_BYTES && decodedLayerImageCache.size > 0) {
    const oldestKey = decodedLayerImageCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    evictDecodedLayerImage(oldestKey);
  }
}

function estimateDecodedImageBytes(image: HTMLImageElement): number {
  const width = Number(image.naturalWidth || image.width);
  const height = Number(image.naturalHeight || image.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 0;
  }
  return Math.ceil(width * height * 4);
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

interface ImagePrefetchCacheDebugHooks {
  getStats(): {
    decodedBytes: number;
    decodedEntries: number;
    decodedLimitBytes: number;
    objectUrlBytes: number;
    objectUrlEntries: number;
    objectUrlLimitBytes: number;
  };
  setObjectUrlLimitBytes(bytes: number): void;
}

// Dev-only introspection used by the Playwright cache-budget specs.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as Window & { __wxImagePrefetchCache?: ImagePrefetchCacheDebugHooks }).__wxImagePrefetchCache = {
    getStats: () => ({
      decodedBytes: decodedLayerImageCacheBytes,
      decodedEntries: decodedLayerImageCache.size,
      decodedLimitBytes: DECODED_IMAGE_CACHE_LIMIT_BYTES,
      objectUrlBytes: layerImageObjectUrlCacheBytes,
      objectUrlEntries: layerImageObjectUrlCache.size,
      objectUrlLimitBytes: imageObjectUrlCacheLimitBytes,
    }),
    setObjectUrlLimitBytes: (bytes: number) => {
      imageObjectUrlCacheLimitBytes = Math.max(0, Math.round(Number(bytes) || 0));
      enforceLayerImageObjectUrlBudget();
    },
  };
}
