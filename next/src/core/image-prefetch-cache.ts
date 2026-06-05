interface ImagePrefetchOptions {
  decode?: boolean;
  signal?: AbortSignal;
}

const IMAGE_OBJECT_URL_CACHE_LIMIT_BYTES = 32 * 1024 * 1024 * 1024;
const DECODED_IMAGE_CACHE_LIMIT_BYTES = resolveCacheLimitBytes(
  import.meta.env.VITE_DECODED_IMAGE_CACHE_LIMIT_MB,
  64 * 1024,
);

const layerImageObjectUrlCache = new Map<string, { objectUrl: string; bytes: number }>();
let layerImageObjectUrlCacheBytes = 0;
const decodedLayerImageCache = new Map<string, { image: HTMLImageElement; bytes: number }>();
let decodedLayerImageCacheBytes = 0;

function resolveCacheLimitBytes(value: unknown, fallbackMb: number): number {
  const mb = Number(value);
  const normalizedMb = Number.isFinite(mb) && mb > 0 ? mb : fallbackMb;
  return Math.round(normalizedMb * 1024 * 1024);
}

export async function preloadImage(url: string, options: ImagePrefetchOptions = {}): Promise<void> {
  const cachedObjectUrl = getCachedLayerImageObjectUrl(url);
  if (cachedObjectUrl) {
    if (options.decode) {
      if (getCachedDecodedLayerImage(url)) {
        return;
      }
      const image = await loadImage(cachedObjectUrl, options.signal, true);
      cacheDecodedLayerImage(url, image);
    }
    return;
  }

  if (canCacheLayerImageUrl(url)) {
    const blob = await fetchImageBlob(url, options.signal);
    const objectUrl = URL.createObjectURL(blob);
    cacheLayerImageObjectUrl(url, objectUrl, blob.size);
    if (options.decode) {
      try {
        const image = await loadImage(objectUrl, options.signal, true);
        cacheDecodedLayerImage(url, image);
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
  for (const [, entry] of layerImageObjectUrlCache.entries()) {
    URL.revokeObjectURL(entry.objectUrl);
  }
  layerImageObjectUrlCache.clear();
  layerImageObjectUrlCacheBytes = 0;
  decodedLayerImageCache.clear();
  decodedLayerImageCacheBytes = 0;
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
    throw new Error(`Image prefetch failed for ${url}`);
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

function canCacheLayerImageUrl(url: string): boolean {
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
    layerImageObjectUrlCache.delete(key);
    layerImageObjectUrlCacheBytes = Math.max(0, layerImageObjectUrlCacheBytes - existing.bytes);
    if (existing.objectUrl !== objectUrl) {
      URL.revokeObjectURL(existing.objectUrl);
      evictDecodedLayerImage(key);
    }
  }
  const normalizedBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  layerImageObjectUrlCache.set(key, { objectUrl, bytes: normalizedBytes });
  layerImageObjectUrlCacheBytes += normalizedBytes;
  enforceLayerImageObjectUrlBudget();
}

function enforceLayerImageObjectUrlBudget(): void {
  while (layerImageObjectUrlCacheBytes > IMAGE_OBJECT_URL_CACHE_LIMIT_BYTES && layerImageObjectUrlCache.size > 0) {
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
