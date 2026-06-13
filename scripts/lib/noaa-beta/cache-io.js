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

async function readCachedFloatGrid(cachePath, expectedPayload, cellCount) {
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
    return float32ArrayViewFromBuffer(body, 0, body.byteLength);
  } catch {
    return null;
  }
}

async function writeCachedFloatGrid(cachePath, payload, values) {
  if (!cachePath || !values) {
    return;
  }
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.promises.writeFile(tmp, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
  await fs.promises.writeFile(`${tmp}.json`, JSON.stringify(cacheMetadataWithPayload(payload)));
  await fs.promises.rename(tmp, `${cachePath}.bin`);
  await fs.promises.rename(`${tmp}.json`, `${cachePath}.json`);
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

function cacheMetadataPayloadMatches(metadata, expectedPayload) {
  if (!metadata || typeof metadata !== "object") {
    return false;
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

async function waitForCachedGrid({ cachePath, payload, lockPath, context, read, timeoutCounter }) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < GRID_CACHE_LOCK_TIMEOUT_MS) {
    await sleep(GRID_CACHE_LOCK_POLL_MS + Math.round(Math.random() * 40));
    const cached = await read(cachePath, payload);
    if (cached) {
      return cached;
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
  const runners = Array.from({ length: workerCount }, async () => {
    while (index < list.length) {
      const current = index;
      index += 1;
      out[current] = await worker(list[current], current);
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
  readCachedFloatGrid,
  recordProfileStage,
  releaseGridCacheLock,
  removeStaleGridCacheLock,
  roundMs,
  sanitizePathToken,
  tryAcquireGridCacheLock,
  waitForCachedGrid,
  writeCachedFloatGrid,
};
