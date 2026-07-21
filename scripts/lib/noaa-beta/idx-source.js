"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { incrementProfileCounter } = require("./util");
const { trimMapToMaxEntries } = require("./grid-ops");
const {
  GRID_CACHE_LOCK_POLL_MS,
  GRID_CACHE_LOCK_TIMEOUT_MS,
  padHour,
  pathExists,
  releaseGridCacheLock,
  sanitizePathToken,
  tryAcquireGridCacheLock,
} = require("./cache-io");
const {
  compareRecordIds,
  indexNoaaRecords,
  noaaRecordSelectorKey,
  parseAccumulationWindow,
  parseAverageWindow,
  uniqueRecords,
} = require("./records");
const { buildNoaaGribUrl } = require("./model-config");
const { selectedRecordDecodeCacheKey } = require("./selected-grib");
const { sleep } = require("../local-artifact-options");

const NOAA_INDEX_TEXT_CACHE = new Map();

const NOAA_INDEX_CONTENT_LENGTH_CACHE = new Map();

const NOAA_INDEX_RECORD_CACHE = new Map();

// In-process .idx caches are bounded per worker; the on-disk raw .idx cache
// remains the durable source, so an evicted entry only costs a cheap disk
// re-read with identical content.
const NOAA_INDEX_TEXT_CACHE_MAX_ENTRIES = 96;

const NOAA_INDEX_CONTENT_LENGTH_CACHE_MAX_ENTRIES = 256;

const NOAA_INDEX_RECORD_CACHE_MAX_ENTRIES = 96;

// NOAA publishes a cycle's files progressively (up to ~4 h for GFS), so idx text
// and content lengths under the newest cycle can still change upstream. In-process
// entries for such cycles expire on a short TTL; completed cycles are immutable
// and stay pinned (the durable on-disk idx cache is unaffected either way).
const NOAA_RECENT_CYCLE_PIN_WINDOW_MS = 6 * 60 * 60 * 1000;

const NOAA_RECENT_CYCLE_CACHE_TTL_MS = 60 * 1000;

function parseNoaaIdx(text, totalBytes = null) {
  const rows = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(":");
      const record = String(parts[0] || "").trim();
      const offset = Number(parts[1]);
      return {
        line,
        record,
        recordNumber: Number(record),
        offset,
        dateToken: String(parts[2] || ""),
        param: String(parts[3] || ""),
        level: String(parts[4] || ""),
        forecast: String(parts[5] || ""),
        extra: parts.slice(6).join(":"),
      };
    })
    .filter((entry) => entry.record && Number.isFinite(entry.offset));

  rows.sort((left, right) => left.offset - right.offset);
  for (const entry of rows) {
    entry.accumulationWindow = parseAccumulationWindow(entry);
    entry.averageWindow = parseAverageWindow(entry);
    entry.selectorKey = noaaRecordSelectorKey(entry.param, entry.level);
  }
  assignNoaaIdxByteRanges(rows, totalBytes);
  indexNoaaRecords(rows);
  return rows;
}

function assignNoaaIdxByteRanges(rows, totalBytes = null) {
  const resolvedTotalBytes = Number(totalBytes);
  for (let index = 0; index < rows.length; ) {
    const offset = rows[index].offset;
    let nextIndex = index + 1;
    while (nextIndex < rows.length && rows[nextIndex].offset === offset) {
      nextIndex += 1;
    }
    const nextOffset = nextIndex < rows.length ? rows[nextIndex].offset : resolvedTotalBytes;
    const endExclusive = Number.isFinite(nextOffset) ? nextOffset : resolvedTotalBytes;
    for (let current = index; current < nextIndex; current += 1) {
      rows[current].endExclusive =
        Number.isFinite(endExclusive) && endExclusive > rows[current].offset ? endExclusive : null;
      rows[current].byteLength = rows[current].endExclusive ? rows[current].endExclusive - rows[current].offset : null;
      rows[current].rangeHeader = rows[current].endExclusive
        ? `bytes=${rows[current].offset}-${rows[current].endExclusive - 1}`
        : null;
    }
    index = nextIndex;
  }
  return rows;
}

function repairNoaaIdxFinalRecordRanges(rows, totalBytes) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return rows;
  }
  const resolvedTotalBytes = Number(totalBytes);
  if (!Number.isFinite(resolvedTotalBytes) || resolvedTotalBytes <= 0) {
    return rows;
  }
  return assignNoaaIdxByteRanges(rows, resolvedTotalBytes);
}

function buildSelectedRecordPlan(records) {
  const sortedRecords = uniqueRecords(records).sort((left, right) => {
    const offsetDelta = left.offset - right.offset;
    if (offsetDelta !== 0) {
      return offsetDelta;
    }
    return compareRecordIds(left.record, right.record);
  });
  const groups = [];
  const groupByRange = new Map();
  for (const record of sortedRecords) {
    const rangeKey = `${record.offset}|${record.rangeHeader || ""}`;
    let group = groupByRange.get(rangeKey);
    if (!group) {
      group = {
        offset: record.offset,
        rangeHeader: record.rangeHeader,
        byteLength: record.byteLength,
        records: [],
      };
      groupByRange.set(rangeKey, group);
      groups.push(group);
    }
    group.records.push(record);
  }

  const recordIndexByOriginalRecord = new Map();
  groups.forEach((group, groupIndex) => {
    const messageIndex = groupIndex + 1;
    for (const record of group.records) {
      const submessage = String(record.record || "").match(/\.(\d+)$/)?.[1];
      recordIndexByOriginalRecord.set(
        record.record,
        submessage ? `${messageIndex}.${submessage}` : String(messageIndex),
      );
    }
  });

  return {
    groups,
    records: sortedRecords,
    recordIndexByOriginalRecord,
  };
}

function getSelectedRecordPlan(records, decodeSession = null) {
  const selectedRecords = (Array.isArray(records) ? records : []).filter(Boolean);
  if (!decodeSession?.selectedPlans) {
    return buildSelectedRecordPlan(selectedRecords);
  }
  const key = selectedRecords
    .map((record) => selectedRecordDecodeCacheKey(record))
    .sort()
    .join("|");
  const cached = decodeSession.selectedPlans.get(key);
  if (cached) {
    incrementProfileCounter(decodeSession.profile, "selectedPlanCacheHits");
    return cached;
  }
  const plan = buildSelectedRecordPlan(selectedRecords);
  decodeSession.selectedPlans.set(key, plan);
  return plan;
}

async function getNoaaRecordsForHour(context, hour) {
  const targetHour = Math.round(Number(hour));
  if (context.recordsByHour.has(targetHour)) {
    return context.recordsByHour.get(targetHour);
  }
  const gribUrl = buildNoaaGribUrl({
    modelKey: context.modelKey,
    baseUrl: context.baseUrl,
    date: context.date,
    cycle: context.cycle,
    hour: targetHour,
  });
  const idxUrl = `${gribUrl}.idx`;
  const sessionKey = `${idxUrl}|unrepaired`;
  let promise = context.decodeSession?.parsedRecords?.get(sessionKey);
  if (!promise) {
    // Single fill/evict path for NOAA_INDEX_RECORD_CACHE shared with the
    // renderer and point soundings; only the per-session wrapper (and its
    // eviction on failure) lives here.
    promise = readOrFetchNoaaIdxRecordsCached(idxUrl, context, targetHour).catch((error) => {
      context.decodeSession?.parsedRecords?.delete(sessionKey);
      throw error;
    });
    context.decodeSession?.parsedRecords?.set(sessionKey, promise);
  }
  const records = await promise;
  context.recordsByHour.set(targetHour, records);
  return records;
}

function noaaCycleStartMs(date, cycle) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(date || ""));
  const cycleHour = Number(cycle);
  if (!match || !Number.isInteger(cycleHour) || cycleHour < 0 || cycleHour > 23) {
    return Number.NaN;
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), cycleHour);
}

function noaaIndexCacheExpiresAtMs(context, nowMs = Date.now()) {
  const cycleStartMs = noaaCycleStartMs(context?.date, context?.cycle);
  if (!Number.isFinite(cycleStartMs) || nowMs - cycleStartMs >= NOAA_RECENT_CYCLE_PIN_WINDOW_MS) {
    return Number.POSITIVE_INFINITY;
  }
  return nowMs + NOAA_RECENT_CYCLE_CACHE_TTL_MS;
}

function isNoaaCycleRecentlyPublishing(context, nowMs = Date.now()) {
  const cycleStartMs = noaaCycleStartMs(context?.date, context?.cycle);
  return Number.isFinite(cycleStartMs) && nowMs - cycleStartMs < NOAA_RECENT_CYCLE_PIN_WINDOW_MS;
}

async function readFreshNoaaDiskCache(cachePath, context, { json = false, nowMs = Date.now() } = {}) {
  if (!cachePath) {
    return null;
  }
  try {
    const stat = await fs.promises.stat(cachePath);
    if (isNoaaCycleRecentlyPublishing(context, nowMs) && nowMs - stat.mtimeMs >= NOAA_RECENT_CYCLE_CACHE_TTL_MS) {
      return null;
    }
    const text = await fs.promises.readFile(cachePath, "utf8");
    if (!text.trim()) {
      return null;
    }
    return json ? JSON.parse(text) : text;
  } catch {
    return null;
  }
}

function liveNoaaIndexCacheEntry(cache, key, nowMs = Date.now()) {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }
  if (nowMs >= entry.expiresAtMs) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setNoaaIndexCacheEntry(cache, key, promise, context) {
  cache.set(key, { promise, expiresAtMs: noaaIndexCacheExpiresAtMs(context) });
}

async function readOrFetchNoaaIdxTextCached(idxUrl, context, hour, profile = null) {
  const key = String(idxUrl || "");
  const live = liveNoaaIndexCacheEntry(NOAA_INDEX_TEXT_CACHE, key);
  if (live) {
    incrementProfileCounter(profile, "indexCacheHits");
    return live.promise;
  }
  const promise = readOrFetchNoaaIdxText(idxUrl, context, hour, profile).catch((error) => {
    NOAA_INDEX_TEXT_CACHE.delete(key);
    throw error;
  });
  setNoaaIndexCacheEntry(NOAA_INDEX_TEXT_CACHE, key, promise, context);
  trimMapToMaxEntries(NOAA_INDEX_TEXT_CACHE, NOAA_INDEX_TEXT_CACHE_MAX_ENTRIES);
  return promise;
}

// Shared parsed-records front for the renderer's per-frame idx consumption.
// Keys and TTL semantics are identical to getNoaaRecordsForHour's use of
// NOAA_INDEX_RECORD_CACHE (both expire with the recent-cycle window), so
// every renderMode task for an hour shares one parse instead of re-parsing
// the same idx text per frame.
async function readOrFetchNoaaIdxRecordsCached(idxUrl, context, hour, profile = null) {
  const key = String(idxUrl || "");
  const live = liveNoaaIndexCacheEntry(NOAA_INDEX_RECORD_CACHE, key);
  if (live) {
    return live.promise;
  }
  const promise = readOrFetchNoaaIdxTextCached(idxUrl, context, hour, profile)
    .then((text) => parseNoaaIdx(text, null))
    .catch((error) => {
      NOAA_INDEX_RECORD_CACHE.delete(key);
      throw error;
    });
  setNoaaIndexCacheEntry(NOAA_INDEX_RECORD_CACHE, key, promise, context);
  trimMapToMaxEntries(NOAA_INDEX_RECORD_CACHE, NOAA_INDEX_RECORD_CACHE_MAX_ENTRIES);
  return promise;
}

async function readOrFetchNoaaIdxText(idxUrl, context, hour, profile = null) {
  const cachePath = noaaIdxCachePath(idxUrl, context, hour);
  if (cachePath) {
    const cached = await readFreshNoaaDiskCache(cachePath, context);
    if (cached) {
      incrementProfileCounter(profile, "indexCacheHits");
      return cached;
    }
  }
  const lockPath = cachePath ? `${cachePath}.lock` : null;
  const lockHandle = lockPath ? await tryAcquireGridCacheLock(lockPath, { idxUrl, hour }) : null;
  if (lockPath && !lockHandle) {
    const waited = await waitForCachedNoaaIdxText(cachePath, lockPath, context);
    if (waited) {
      incrementProfileCounter(profile, "indexCacheHits");
      return waited;
    }
  } else if (lockHandle) {
    try {
      const cachedAfterLock = await readFreshNoaaDiskCache(cachePath, context);
      if (cachedAfterLock) {
        incrementProfileCounter(profile, "indexCacheHits");
        return cachedAfterLock;
      }
      return await fetchAndWriteNoaaIdxText({ idxUrl, cachePath, profile });
    } finally {
      await releaseGridCacheLock(lockPath, lockHandle);
    }
  }
  return fetchAndWriteNoaaIdxText({ idxUrl, cachePath, profile });
}

async function fetchAndWriteNoaaIdxText({ idxUrl, cachePath, profile = null }) {
  incrementProfileCounter(profile, "indexCacheMisses");
  const text = await fetchText(idxUrl);
  if (cachePath && text.trim()) {
    // Cache persistence is best-effort: the fetched text is already in hand,
    // so a disk failure must not fail the read (writeRegriddedBinCache
    // policy) or strand the tmp file.
    const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.promises.writeFile(tmp, text);
      await fs.promises.rename(tmp, cachePath);
    } catch (error) {
      console.warn(`[noaa-beta] idx cache write failed for ${cachePath}: ${String(error?.message || error)}`);
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }
  return text;
}

async function waitForCachedNoaaIdxText(cachePath, lockPath, context) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < GRID_CACHE_LOCK_TIMEOUT_MS) {
    await sleep(GRID_CACHE_LOCK_POLL_MS + Math.round(Math.random() * 40));
    const cached = await readFreshNoaaDiskCache(cachePath, context);
    if (cached) {
      return cached;
    }
    if (!(await pathExists(lockPath))) {
      return null;
    }
  }
  return null;
}

async function readOrFetchNoaaContentLengthCached(gribUrl, context, hour, profile = null) {
  const key = String(gribUrl || "");
  const live = liveNoaaIndexCacheEntry(NOAA_INDEX_CONTENT_LENGTH_CACHE, key);
  if (live) {
    incrementProfileCounter(profile, "contentLengthCacheHits");
    return live.promise;
  }
  const promise = readOrFetchNoaaContentLength(gribUrl, context, hour, profile).catch((error) => {
    NOAA_INDEX_CONTENT_LENGTH_CACHE.delete(key);
    throw error;
  });
  setNoaaIndexCacheEntry(NOAA_INDEX_CONTENT_LENGTH_CACHE, key, promise, context);
  trimMapToMaxEntries(NOAA_INDEX_CONTENT_LENGTH_CACHE, NOAA_INDEX_CONTENT_LENGTH_CACHE_MAX_ENTRIES);
  return promise;
}

async function readOrFetchNoaaContentLength(gribUrl, context, hour, profile = null) {
  const metadataPath = noaaIdxMetadataCachePath(`${gribUrl}.idx`, context, hour);
  if (metadataPath) {
    try {
      const metadata = await readFreshNoaaDiskCache(metadataPath, context, { json: true });
      const totalBytes = Number(metadata?.totalBytes);
      if (Number.isFinite(totalBytes) && totalBytes > 0) {
        incrementProfileCounter(profile, "contentLengthCacheHits");
        return totalBytes;
      }
    } catch {
      // Fall through to HEAD.
    }
  }
  incrementProfileCounter(profile, "contentLengthCacheMisses");
  const totalBytes = await fetchContentLength(gribUrl);
  if (metadataPath) {
    // Best-effort persist; the fetched length must survive a disk failure.
    const tmp = `${metadataPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fs.promises.mkdir(path.dirname(metadataPath), { recursive: true });
      await fs.promises.writeFile(
        tmp,
        JSON.stringify({
          version: 1,
          gribUrl,
          idxUrl: `${gribUrl}.idx`,
          totalBytes,
          fetchedAt: new Date().toISOString(),
        }),
      );
      await fs.promises.rename(tmp, metadataPath);
    } catch (error) {
      console.warn(
        `[noaa-beta] content-length cache write failed for ${metadataPath}: ${String(error?.message || error)}`,
      );
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }
  return totalBytes;
}

function noaaIdxCachePath(idxUrl, context, hour) {
  const cacheDir = context?.sourceIndexCacheDir;
  if (!cacheDir || !idxUrl) {
    return null;
  }
  const hash = crypto.createHash("sha256").update(String(idxUrl)).digest("hex").slice(0, 16);
  const hourToken = Number.isFinite(Number(hour)) ? padHour(hour) : "unknown";
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${hourToken}-${hash}.idx`,
  );
}

function noaaIdxMetadataCachePath(idxUrl, context, hour) {
  const cachePath = noaaIdxCachePath(idxUrl, context, hour);
  return cachePath ? `${cachePath}.meta.json` : null;
}

function clearNoaaIndexCachesForTest() {
  NOAA_INDEX_TEXT_CACHE.clear();
  NOAA_INDEX_CONTENT_LENGTH_CACHE.clear();
  NOAA_INDEX_RECORD_CACHE.clear();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`NOAA request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

async function fetchContentLength(url) {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`NOAA HEAD request failed (${response.status}) for ${url}`);
  }
  const length = Number(response.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0) {
    throw new Error(`NOAA response is missing content-length for ${url}`);
  }
  return length;
}

function buildNoaaIndexCacheContext({ modelKey, date, cycle, rawCacheDir }) {
  return {
    modelKey,
    date,
    cycle,
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
  };
}

module.exports = {
  buildNoaaIndexCacheContext,
  NOAA_INDEX_CONTENT_LENGTH_CACHE,
  NOAA_INDEX_CONTENT_LENGTH_CACHE_MAX_ENTRIES,
  NOAA_INDEX_RECORD_CACHE,
  NOAA_INDEX_RECORD_CACHE_MAX_ENTRIES,
  NOAA_INDEX_TEXT_CACHE,
  NOAA_INDEX_TEXT_CACHE_MAX_ENTRIES,
  NOAA_RECENT_CYCLE_CACHE_TTL_MS,
  NOAA_RECENT_CYCLE_PIN_WINDOW_MS,
  isNoaaCycleRecentlyPublishing,
  readFreshNoaaDiskCache,
  assignNoaaIdxByteRanges,
  buildSelectedRecordPlan,
  clearNoaaIndexCachesForTest,
  fetchAndWriteNoaaIdxText,
  fetchContentLength,
  fetchText,
  getNoaaRecordsForHour,
  getSelectedRecordPlan,
  noaaCycleStartMs,
  noaaIdxCachePath,
  noaaIdxMetadataCachePath,
  noaaIndexCacheExpiresAtMs,
  parseNoaaIdx,
  readOrFetchNoaaContentLength,
  readOrFetchNoaaContentLengthCached,
  readOrFetchNoaaIdxRecordsCached,
  readOrFetchNoaaIdxText,
  readOrFetchNoaaIdxTextCached,
  repairNoaaIdxFinalRecordRanges,
  waitForCachedNoaaIdxText,
};
