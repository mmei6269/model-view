"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { clampInt, incrementProfileCounter } = require("./util");
const { float32ArrayViewFromBuffer } = require("./grid-ops");
const { sleep } = require("../local-artifact-options");

const GRID_CACHE_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

const GRID_CACHE_LOCK_POLL_MS = 100;

function createBoundedRunCacheMap(maxEntries) {
  const map = new Map();
  map.maxEntries = Math.max(1, Math.round(Number(maxEntries) || 1));
  return map;
}

function boundedRunCacheGet(cache, key) {
  if (!cache || !cache.has(key)) {
    return null;
  }
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function boundedRunCacheSet(cache, key, value) {
  if (!cache || !key || !value) {
    return;
  }
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  const maxEntries = Math.max(1, Math.round(Number(cache.maxEntries) || 1));
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

async function readCachedFloatGrid(cachePath, expectedPayload, cellCount, options = {}) {
  if (!cachePath) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    if (!cacheMetadataPayloadMatches(metadata, expectedPayload)) {
      return null;
    }
    const body = await fs.promises.readFile(`${cachePath}.bin`);
    if (body.length !== cellCount * 4) {
      return null;
    }
    if (typeof options.onMetadata === "function") {
      options.onMetadata(metadata);
    }
    return float32ArrayViewFromBuffer(body, 0, body.byteLength);
  } catch {
    return null;
  }
}

async function writeCachedFloatGrid(cachePath, payload, values, metadataExtra = {}) {
  if (!cachePath || !values) {
    return false;
  }
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  // Cache persistence is best-effort: a failed write must degrade to a
  // warn-and-recompute, never fail the frame that already holds the grid
  // (mirrors writeDerivedGridCache / writeRegriddedBinCache).
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.promises.writeFile(tmp, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
    await fs.promises.writeFile(`${tmp}.json`, JSON.stringify(cacheMetadataWithPayload(payload, metadataExtra)));
    await fs.promises.rename(tmp, `${cachePath}.bin`);
    await fs.promises.rename(`${tmp}.json`, `${cachePath}.json`);
    return true;
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    await fs.promises.rm(`${tmp}.json`, { force: true }).catch(() => {});
    console.warn(`[noaa-beta] float-grid cache write failed for ${cachePath}: ${String(error?.message || error)}`);
    return false;
  }
}

function cachePayloadJson(payload) {
  return JSON.stringify(payload || {});
}

function cachePayloadHashFromJson(json) {
  return crypto.createHash("sha256").update(json).digest("hex");
}

function cachePayloadDescriptor(payload) {
  const payloadJson = cachePayloadJson(payload);
  return { payload, payloadJson, payloadHash: cachePayloadHashFromJson(payloadJson) };
}

function cacheMetadataWithPayload(payload, extra = {}) {
  const descriptor = cachePayloadDescriptor(payload);
  return { payload, payloadHash: descriptor.payloadHash, ...extra };
}

function cacheMetadataPayloadMatches(metadata, expectedPayload, expectedPayloadHash = null) {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  // Callers that already hold the payload's hash (regrid-bin/derived-grid
  // cache contexts) skip re-serializing and re-hashing the expected payload
  // on the fast path; the JSON comparison below stays the fallback for
  // metadata written without a payloadHash.
  if (expectedPayloadHash && metadata.payloadHash && metadata.payloadHash === expectedPayloadHash) {
    return true;
  }
  const expected = cachePayloadDescriptor(expectedPayload);
  if (metadata.payloadHash && metadata.payloadHash === expected.payloadHash) {
    return true;
  }
  return cachePayloadJson(metadata.payload) === expected.payloadJson;
}

function directCacheMetadataPayloadMatches(metadata, expectedPayload) {
  if (metadata?.payload && metadata?.payloadHash) {
    return cacheMetadataPayloadMatches(metadata, expectedPayload);
  }
  return cachePayloadJson(metadata) === cachePayloadJson(expectedPayload);
}

// Generic waitForCachedGrid probe for entries whose sidecar is written via
// cacheMetadataWithPayload (writeCachedFloatGrid and the snowfall/profile
// writers): reads only the small JSON sidecar and validates the payload hash,
// so a waiting caller never re-reads the multi-MB grid body on a poll that
// cannot succeed yet. The full read after a ready probe still validates
// payload and body before use.
async function probeCachedGridSidecar(cachePath, expectedPayload) {
  if (!cachePath) {
    return false;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    return cacheMetadataPayloadMatches(metadata, expectedPayload);
  } catch {
    return false;
  }
}

async function waitForCachedGrid({ cachePath, payload, lockPath, context, read, probe = null, timeoutCounter }) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < GRID_CACHE_LOCK_TIMEOUT_MS) {
    await sleep(GRID_CACHE_LOCK_POLL_MS + Math.round(Math.random() * 40));
    // The optional probe checks only the small JSON sidecar, so callers that
    // pass one avoid re-reading the multi-MB grid body on every poll; the
    // full read below still validates payload and body bytes before use.
    const ready = typeof probe === "function" ? await probe(cachePath, payload) : true;
    if (ready) {
      const cached = await read(cachePath, payload);
      if (cached) {
        return cached;
      }
    }
    const lockExists = await pathExists(lockPath);
    if (!lockExists) {
      return null;
    }
  }
  if (timeoutCounter) {
    incrementProfileCounter(context.profile, timeoutCounter);
  }
  return null;
}

// Multi-ref variant of waitForCachedGrid: N per-ref cache entries behind one
// hour-level lock (precip accumulation windows, snow-liquid source windows).
// Polls every ref's small JSON sidecar; the multi-MB grid bodies are read and
// validated only once every ref reports ready. The wait fails open to a
// final read when the lock disappears or the timeout elapses.
async function waitForCachedRefGrids({ refs, lockPath, concurrency, probeRef, readRef, profile, timeoutCounter }) {
  const readAll = () => readCachedRefGridsBySourceKey(refs, concurrency, readRef);
  const startedAt = performance.now();
  while (performance.now() - startedAt < GRID_CACHE_LOCK_TIMEOUT_MS) {
    await sleep(GRID_CACHE_LOCK_POLL_MS + Math.round(Math.random() * 40));
    if (await probeCachedRefGrids(refs, concurrency, probeRef)) {
      const cached = await readAll();
      if (cached.size === refs.length) {
        return cached;
      }
    }
    const lockExists = await pathExists(lockPath);
    if (!lockExists) {
      return readAll();
    }
  }
  if (timeoutCounter) {
    incrementProfileCounter(profile, timeoutCounter);
  }
  return readAll();
}

async function probeCachedRefGrids(refs, concurrency, probeRef) {
  const probes = await mapWithConcurrency(refs, concurrency, (ref) => probeRef(ref));
  return probes.every(Boolean);
}

async function readCachedRefGridsBySourceKey(refs, concurrency, readRef) {
  const pairs = await mapWithConcurrency(refs, concurrency, async (ref) => [ref.sourceKey, await readRef(ref)]);
  const out = new Map();
  for (const [sourceKey, cached] of pairs) {
    if (cached) {
      out.set(sourceKey, cached);
    }
  }
  return out;
}

async function tryAcquireGridCacheLock(lockPath, payload) {
  try {
    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    const handle = await fs.promises.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), payload }));
    return handle;
  } catch (error) {
    if (error?.code === "EEXIST") {
      if (await removeStaleGridCacheLock(lockPath)) {
        return tryAcquireGridCacheLock(lockPath, payload);
      }
      return null;
    }
    throw error;
  }
}

async function releaseGridCacheLock(lockPath, handle) {
  await handle.close().catch(() => {});
  await fs.promises.rm(lockPath, { force: true }).catch(() => {});
}

async function removeStaleGridCacheLock(lockPath) {
  try {
    const stat = await fs.promises.stat(lockPath);
    if (Date.now() - stat.mtimeMs < GRID_CACHE_LOCK_TIMEOUT_MS) {
      return false;
    }
    await fs.promises.rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function recordProfileStage(profile, key, startedAt) {
  if (!profile || !key || !Number.isFinite(startedAt)) {
    return;
  }
  profile.stages[key] = roundMs(performance.now() - startedAt);
}

function roundMs(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  if (list.length === 0) {
    return out;
  }
  const workerCount = clampInt(concurrency, 1, list.length, 1);
  let index = 0;
  // Once one runner rejects, surviving runners stop pulling new items; their
  // in-flight awaits still settle and Promise.all propagates the rejection.
  let aborted = false;
  const runners = Array.from({ length: workerCount }, async () => {
    while (!aborted && index < list.length) {
      const current = index;
      index += 1;
      try {
        out[current] = await worker(list[current], current);
      } catch (error) {
        aborted = true;
        throw error;
      }
    }
  });
  await Promise.all(runners);
  return out;
}

function padHour(hour) {
  return String(Math.max(0, Math.round(Number(hour) || 0))).padStart(3, "0");
}

function padTwoDigitHour(hour) {
  return String(Math.max(0, Math.round(Number(hour) || 0))).padStart(2, "0");
}

function sanitizePathToken(value) {
  return String(value || "grib").replace(/[^a-zA-Z0-9._-]+/g, "-");
}

module.exports = {
  GRID_CACHE_LOCK_POLL_MS,
  GRID_CACHE_LOCK_TIMEOUT_MS,
  boundedRunCacheGet,
  boundedRunCacheSet,
  cacheMetadataPayloadMatches,
  cacheMetadataWithPayload,
  cachePayloadDescriptor,
  cachePayloadHashFromJson,
  cachePayloadJson,
  createBoundedRunCacheMap,
  directCacheMetadataPayloadMatches,
  mapWithConcurrency,
  padHour,
  padTwoDigitHour,
  pathExists,
  probeCachedGridSidecar,
  readCachedFloatGrid,
  readCachedRefGridsBySourceKey,
  recordProfileStage,
  releaseGridCacheLock,
  removeStaleGridCacheLock,
  roundMs,
  sanitizePathToken,
  tryAcquireGridCacheLock,
  waitForCachedGrid,
  waitForCachedRefGrids,
  writeCachedFloatGrid,
};
