"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { clampInt, incrementDecodeSessionCounter, incrementProfileCounter } = require("./util");
const { decodeBinaryGridFileSlice, decodeSouthNorthBinaryGridBuffer, trimMapToMaxEntries } = require("./grid-ops");
const {
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
  mapWithConcurrency,
  padHour,
  pathExists,
  recordProfileStage,
  releaseGridCacheLock,
  roundMs,
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
const { buildNoaaGribUrl, normalizeBaseUrl } = require("./model-config");
const { sleep } = require("../local-artifact-options");

const DEFAULT_WGRIB2_PATH = "wgrib2";

const PRECIP_TYPE_REGRID_PATTERN = ":(CRAIN|CSNOW|CFRZR|CICEP):";

const PRECIP_TYPE_DECODE_KEYS = new Set([
  "precipTypeRain",
  "precipTypeSnow",
  "precipTypeFreezingRain",
  "precipTypeIcePellets",
]);

const NOAA_INDEX_TEXT_CACHE = new Map();

const NOAA_INDEX_CONTENT_LENGTH_CACHE = new Map();

const NOAA_INDEX_RECORD_CACHE = new Map();

// In-process .idx caches are bounded per worker; the on-disk raw .idx cache
// remains the durable source, so an evicted entry only costs a cheap disk
// re-read with identical content.
const NOAA_INDEX_TEXT_CACHE_MAX_ENTRIES = 96;

const NOAA_INDEX_CONTENT_LENGTH_CACHE_MAX_ENTRIES = 256;

const NOAA_INDEX_RECORD_CACHE_MAX_ENTRIES = 96;

const SELECTED_GRIB_CACHE_DIRNAME = "selected-grib-v2";

const SELECTED_GRIB_CACHE_METADATA_VERSION = 2;

const REGRIDDED_BIN_CACHE_VERSION = "regridded-bin-v1";

const REGRIDDED_BIN_EXPORT_ARGS = Object.freeze(["-s", "-order", "we:sn", "-no_header", "-bin"]);

const WGRIB2_IDENTITY_PROMISES = new Map();

const SELECTED_GRIB_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

const SELECTED_GRIB_LOCK_POLL_MS = 100;

const CATALOG_VERSION = "noaa-grib2-catalog-v4";

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
  let promise = context.decodeSession?.parsedRecords?.get(sessionKey) || NOAA_INDEX_RECORD_CACHE.get(idxUrl);
  if (!promise) {
    promise = readOrFetchNoaaIdxTextCached(idxUrl, context, targetHour)
      .then((text) => parseNoaaIdx(text, null))
      .catch((error) => {
        NOAA_INDEX_RECORD_CACHE.delete(idxUrl);
        context.decodeSession?.parsedRecords?.delete(sessionKey);
        throw error;
      });
    NOAA_INDEX_RECORD_CACHE.set(idxUrl, promise);
    trimMapToMaxEntries(NOAA_INDEX_RECORD_CACHE, NOAA_INDEX_RECORD_CACHE_MAX_ENTRIES);
    context.decodeSession?.parsedRecords?.set(sessionKey, promise);
  }
  const records = await promise;
  context.recordsByHour.set(targetHour, records);
  return records;
}

async function readOrFetchNoaaIdxTextCached(idxUrl, context, hour, profile = null) {
  const key = String(idxUrl || "");
  let promise = NOAA_INDEX_TEXT_CACHE.get(key);
  if (promise) {
    incrementProfileCounter(profile, "indexCacheHits");
    return promise;
  }
  promise = readOrFetchNoaaIdxText(idxUrl, context, hour, profile).catch((error) => {
    NOAA_INDEX_TEXT_CACHE.delete(key);
    throw error;
  });
  NOAA_INDEX_TEXT_CACHE.set(key, promise);
  trimMapToMaxEntries(NOAA_INDEX_TEXT_CACHE, NOAA_INDEX_TEXT_CACHE_MAX_ENTRIES);
  return promise;
}

async function readOrFetchNoaaIdxText(idxUrl, context, hour, profile = null) {
  const cachePath = noaaIdxCachePath(idxUrl, context, hour);
  if (cachePath) {
    try {
      const cached = await fs.promises.readFile(cachePath, "utf8");
      if (cached.trim()) {
        incrementProfileCounter(profile, "indexCacheHits");
        return cached;
      }
    } catch {
      // Fall through to network fetch.
    }
  }
  const lockPath = cachePath ? `${cachePath}.lock` : null;
  const lockHandle = lockPath ? await tryAcquireGridCacheLock(lockPath, { idxUrl, hour }) : null;
  if (lockPath && !lockHandle) {
    const waited = await waitForCachedNoaaIdxText(cachePath, lockPath);
    if (waited) {
      incrementProfileCounter(profile, "indexCacheHits");
      return waited;
    }
  } else if (lockHandle) {
    try {
      const cachedAfterLock = await fs.promises.readFile(cachePath, "utf8").catch(() => "");
      if (cachedAfterLock.trim()) {
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
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, cachePath);
  }
  return text;
}

async function waitForCachedNoaaIdxText(cachePath, lockPath) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < GRID_CACHE_LOCK_TIMEOUT_MS) {
    await sleep(GRID_CACHE_LOCK_POLL_MS + Math.round(Math.random() * 40));
    try {
      const cached = await fs.promises.readFile(cachePath, "utf8");
      if (cached.trim()) {
        return cached;
      }
    } catch {
      // Keep waiting while the writer owns the lock.
    }
    if (!(await pathExists(lockPath))) {
      return null;
    }
  }
  return null;
}

async function readOrFetchNoaaContentLengthCached(gribUrl, context, hour, profile = null) {
  const key = String(gribUrl || "");
  let promise = NOAA_INDEX_CONTENT_LENGTH_CACHE.get(key);
  if (promise) {
    incrementProfileCounter(profile, "contentLengthCacheHits");
    return promise;
  }
  promise = readOrFetchNoaaContentLength(gribUrl, context, hour, profile).catch((error) => {
    NOAA_INDEX_CONTENT_LENGTH_CACHE.delete(key);
    throw error;
  });
  NOAA_INDEX_CONTENT_LENGTH_CACHE.set(key, promise);
  trimMapToMaxEntries(NOAA_INDEX_CONTENT_LENGTH_CACHE, NOAA_INDEX_CONTENT_LENGTH_CACHE_MAX_ENTRIES);
  return promise;
}

async function readOrFetchNoaaContentLength(gribUrl, context, hour, profile = null) {
  const metadataPath = noaaIdxMetadataCachePath(`${gribUrl}.idx`, context, hour);
  if (metadataPath) {
    try {
      const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
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
    await fs.promises.mkdir(path.dirname(metadataPath), { recursive: true });
    const tmp = `${metadataPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.promises.writeFile(
      tmp,
      JSON.stringify({
        version: 1,
        gribUrl,
        idxUrl: `${gribUrl}.idx`,
        totalBytes,
      }),
    );
    await fs.promises.rename(tmp, metadataPath);
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

function selectedPrecipRecordIdentity(record) {
  return {
    record: record?.record || "",
    offset: Number(record?.offset),
    param: record?.param || "",
    level: record?.level || "",
    forecast: record?.forecast || "",
    line: record?.line || "",
  };
}

function selectedGribRecordsHash(groups) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(selectedGribRecordManifest(groups)))
    .digest("hex")
    .slice(0, 24);
}

function selectedGribSharedCacheDir(rawCacheDir) {
  if (!rawCacheDir) {
    return null;
  }
  const base = path.basename(String(rawCacheDir));
  if (base === SELECTED_GRIB_CACHE_DIRNAME) {
    return rawCacheDir;
  }
  if (base.endsWith("-selected") || base.endsWith("-raw")) {
    return path.join(path.dirname(rawCacheDir), SELECTED_GRIB_CACHE_DIRNAME);
  }
  return path.join(rawCacheDir, SELECTED_GRIB_CACHE_DIRNAME);
}

async function ensureWgrib2Available(wgrib2Path = DEFAULT_WGRIB2_PATH) {
  try {
    const result = await runCommand(wgrib2Path, ["-version"], { allowNonZero: true });
    const output = `${result.stdout || ""} ${result.stderr || ""}`;
    if (!/\d+\.\d+/.test(output)) {
      throw new Error(`unexpected version output '${output.trim()}'`);
    }
  } catch (error) {
    throw new Error(
      `NOAA beta renderer requires '${wgrib2Path}' on PATH. Install wgrib2, then rerun the command. Original error: ${String(error?.message || error)}`,
      { cause: error },
    );
  }
}

async function materializeSelectedGrib({
  modelKey = "nam",
  productKey = "grib",
  gribUrl,
  recordGroups,
  rawCacheDir,
  date,
  cycle,
  hour,
  cacheVersion = "current-ui",
  rangeFetchConcurrency = 8,
  rangeFetchLimiter = null,
  profile = null,
  decodeSession = null,
}) {
  const groups = Array.isArray(recordGroups) ? recordGroups : [];
  if (groups.length === 0) {
    throw new Error(`No NOAA GRIB records selected for ${gribUrl}`);
  }
  for (const group of groups) {
    if (!group.rangeHeader) {
      throw new Error(`NOAA GRIB index row is missing byte range at offset ${group.offset}`);
    }
  }
  const descriptor = selectedGribCacheDescriptor({
    modelKey,
    productKey,
    gribUrl,
    groups,
    rawCacheDir,
    date,
    cycle,
    hour,
    cacheVersion,
  });
  const promiseKey = descriptor.cachePath || descriptor.identityKey;
  const existing = decodeSession?.selectedGribPromises?.get(promiseKey);
  if (existing) {
    incrementDecodeSessionCounter(decodeSession, "selectedGribPromiseHits");
    return existing;
  }
  const promise = materializeSelectedGribUncached({
    descriptor,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    profile,
  }).finally(() => {
    if (!descriptor.cachePath) {
      decodeSession?.selectedGribPromises?.delete(promiseKey);
    }
  });
  decodeSession?.selectedGribPromises?.set(promiseKey, promise);
  return promise;
}

async function materializeSelectedGribUncached({ descriptor, rangeFetchConcurrency, rangeFetchLimiter, profile }) {
  const { cachePath, gribUrl, groups } = descriptor;
  const cachedPath = cachePath ? await readCachedSelectedGribPath(cachePath, descriptor) : null;
  if (cachedPath) {
    if (profile) {
      profile.selectedGribCacheHit = true;
    }
    incrementProfileCounter(profile, "selectedGribCacheHits");
    return cachedPath;
  }
  if (profile) {
    profile.selectedGribCacheHit = false;
  }
  incrementProfileCounter(profile, "selectedGribCacheMisses");

  if (!cachePath) {
    const tempPath = path.join(
      os.tmpdir(),
      `noaa-selected-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.grib2`,
    );
    await writeSelectedGribRangeFile({
      targetPath: tempPath,
      gribUrl,
      groups,
      rangeFetchConcurrency,
      rangeFetchLimiter,
      profile,
      atomic: false,
    });
    return tempPath;
  }

  const lockPath = `${cachePath}.lock`;
  const lockHandle = await tryAcquireGridCacheLock(lockPath, selectedGribLockPayload(descriptor));
  if (!lockHandle) {
    incrementProfileCounter(profile, "selectedGribLockWaits");
    const waited = await waitForCachedSelectedGrib(cachePath, descriptor, lockPath);
    if (waited) {
      if (profile) {
        profile.selectedGribCacheHit = true;
      }
      incrementProfileCounter(profile, "selectedGribCacheHits");
      return waited;
    }
  } else {
    try {
      const cachedAfterLock = await readCachedSelectedGribPath(cachePath, descriptor);
      if (cachedAfterLock) {
        if (profile) {
          profile.selectedGribCacheHit = true;
        }
        incrementProfileCounter(profile, "selectedGribCacheHits");
        return cachedAfterLock;
      }
      return await writeCachedSelectedGrib({ descriptor, rangeFetchConcurrency, rangeFetchLimiter, profile });
    } finally {
      await releaseGridCacheLock(lockPath, lockHandle);
    }
  }

  return writeCachedSelectedGrib({ descriptor, rangeFetchConcurrency, rangeFetchLimiter, profile });
}

function selectedGribCacheDescriptor({
  modelKey,
  productKey,
  gribUrl,
  groups,
  rawCacheDir,
  date,
  cycle,
  hour,
  cacheVersion,
}) {
  const records = selectedGribRecordManifest(groups);
  const recordsJson = JSON.stringify(records);
  const selectedHash = crypto.createHash("sha256").update(recordsJson).digest("hex").slice(0, 24);
  const urlHash = crypto
    .createHash("sha256")
    .update(String(gribUrl || ""))
    .digest("hex")
    .slice(0, 16);
  const versionToken = sanitizePathToken(cacheVersion || CATALOG_VERSION);
  const cacheRoot = selectedGribSharedCacheDir(rawCacheDir);
  const cachePath = cacheRoot
    ? path.join(
        cacheRoot,
        sanitizePathToken(modelKey),
        String(date),
        String(cycle),
        sanitizePathToken(productKey),
        `${padHour(hour)}-${versionToken}-${selectedHash}-${urlHash}.grib2`,
      )
    : null;
  return {
    cachePath,
    gribUrl,
    groups,
    records,
    recordsJson,
    selectedHash,
    urlHash,
    modelKey,
    productKey,
    date,
    cycle,
    hour: Math.round(Number(hour)),
    cacheVersion,
    identityKey: JSON.stringify({ gribUrl, selectedHash, modelKey, productKey, date, cycle, hour, cacheVersion }),
  };
}

function selectedGribLockPayload(descriptor) {
  return {
    version: SELECTED_GRIB_CACHE_METADATA_VERSION,
    gribUrl: descriptor.gribUrl,
    selectedHash: descriptor.selectedHash,
    urlHash: descriptor.urlHash,
    modelKey: descriptor.modelKey,
    productKey: descriptor.productKey,
    date: descriptor.date,
    cycle: descriptor.cycle,
    hour: descriptor.hour,
  };
}

async function readCachedSelectedGribPath(cachePath, descriptor) {
  try {
    const metadata = await readSelectedGribMetadata(cachePath);
    if (!selectedGribMetadataMatches(metadata, descriptor)) {
      return null;
    }
    const stat = await fs.promises.stat(cachePath);
    if (stat.size !== Number(metadata.selectedBytes)) {
      return null;
    }
    if (metadata.sha256) {
      const sha256 = await hashFileSha256(cachePath);
      if (sha256 !== metadata.sha256) {
        return null;
      }
    }
    return cachePath;
  } catch {
    return null;
  }
}

async function readSelectedGribMetadata(cachePath) {
  const readyPath = `${cachePath}.ready.json`;
  try {
    return JSON.parse(await fs.promises.readFile(readyPath, "utf8"));
  } catch {
    return JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
  }
}

function selectedGribMetadataMatches(metadata, descriptor) {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  if (metadata.url !== descriptor.gribUrl || metadata.selectedHash !== descriptor.selectedHash) {
    return false;
  }
  if (metadata.urlHash && metadata.urlHash !== descriptor.urlHash) {
    return false;
  }
  return JSON.stringify(metadata.records || []) === descriptor.recordsJson;
}

async function waitForCachedSelectedGrib(cachePath, descriptor, lockPath) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < SELECTED_GRIB_LOCK_TIMEOUT_MS) {
    await sleep(SELECTED_GRIB_LOCK_POLL_MS + Math.round(Math.random() * 40));
    const cached = await readCachedSelectedGribPath(cachePath, descriptor);
    if (cached) {
      return cached;
    }
    if (!(await pathExists(lockPath))) {
      return null;
    }
  }
  return null;
}

async function writeCachedSelectedGrib({ descriptor, rangeFetchConcurrency, rangeFetchLimiter, profile }) {
  const { cachePath } = descriptor;
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await writeSelectedGribRangeFile({
    targetPath: tmp,
    gribUrl: descriptor.gribUrl,
    groups: descriptor.groups,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    profile,
    atomic: false,
  });
  const metadata = {
    version: SELECTED_GRIB_CACHE_METADATA_VERSION,
    url: descriptor.gribUrl,
    urlHash: descriptor.urlHash,
    selectedHash: descriptor.selectedHash,
    rangeRequestCount: descriptor.groups.length,
    rangeFetchConcurrency: clampInt(rangeFetchConcurrency, 1, descriptor.groups.length, 1),
    selectedBytes: result.bytes,
    sha256: result.sha256,
    records: descriptor.records,
  };
  const metadataTmp = `${tmp}.json`;
  const readyTmp = `${tmp}.ready.json`;
  const stageStartedAt = performance.now();
  await fs.promises.writeFile(metadataTmp, JSON.stringify(metadata));
  await fs.promises.writeFile(readyTmp, JSON.stringify(metadata));
  await fs.promises.rename(tmp, cachePath);
  await fs.promises.rename(metadataTmp, `${cachePath}.json`);
  await fs.promises.rename(readyTmp, `${cachePath}.ready.json`);
  recordProfileStage(profile, "selectedGribWriteMs", stageStartedAt);
  return cachePath;
}

async function writeSelectedGribRangeFile({
  targetPath,
  gribUrl,
  groups,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  profile,
}) {
  const offsets = [];
  let cursor = 0;
  for (const group of groups) {
    const byteLength = selectedGribGroupByteLength(group);
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
      throw new Error(`NOAA GRIB selected record is missing byte length for ${group.rangeHeader}`);
    }
    offsets.push(cursor);
    cursor += byteLength;
  }
  const stageStartedAt = performance.now();
  const handle = await fs.promises.open(targetPath, "w");
  try {
    await mapWithConcurrency(groups, rangeFetchConcurrency, async (group, index) => {
      const chunk = await fetchRangeChunk({ gribUrl, group, rangeFetchLimiter, profile });
      const expectedBytes = selectedGribGroupByteLength(group);
      if (chunk.length !== expectedBytes) {
        throw new Error(
          `NOAA byte-range ${group.rangeHeader} returned ${chunk.length} bytes; expected ${expectedBytes}.`,
        );
      }
      await handle.write(chunk, 0, chunk.length, offsets[index]);
    });
  } finally {
    await handle.close().catch(() => {});
  }
  recordProfileStage(profile, "rangeFetchMs", stageStartedAt);
  const hashStartedAt = performance.now();
  const sha256 = await hashFileSha256(targetPath);
  recordProfileStage(profile, "rangeConcatMs", hashStartedAt);
  if (profile) {
    profile.selectedBytes = cursor;
  }
  return { bytes: cursor, sha256 };
}

function selectedGribGroupByteLength(group) {
  const byteLength = Number(group?.byteLength ?? group?.records?.[0]?.byteLength);
  return Number.isFinite(byteLength) && byteLength > 0 ? byteLength : null;
}

async function hashFileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function fetchRangeChunk({ gribUrl, group, rangeFetchLimiter, profile = null }) {
  const run = async () => {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(gribUrl, { headers: { Range: group.rangeHeader } });
        if (response.status === 206) {
          return Buffer.from(await response.arrayBuffer());
        }
        const error = new Error(`Expected byte-range response for ${gribUrl}, got HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      } catch (error) {
        lastError = error;
        if (attempt >= 3 || !isRetryableRangeFetchError(error)) {
          throw error;
        }
        recordRangeFetchRetry(profile, error);
        await sleep(250 * attempt);
      }
    }
    throw lastError || new Error(`NOAA byte-range request failed for ${gribUrl}`);
  };
  return typeof rangeFetchLimiter === "function" ? rangeFetchLimiter(run) : run();
}

function isRetryableRangeFetchError(error) {
  const status = Number(error?.status);
  if (status === 429 || status >= 500) {
    return true;
  }
  return !Number.isFinite(status);
}

function recordRangeFetchRetry(profile, error) {
  if (!profile) {
    return;
  }
  profile.rangeFetchRetries += 1;
  const status = Number(error?.status);
  const key = Number.isFinite(status) ? String(status) : "network";
  profile.rangeFetchRetryStatuses[key] = (profile.rangeFetchRetryStatuses[key] || 0) + 1;
}

function selectedGribRecordManifest(groups) {
  return groups.flatMap((group) =>
    group.records.map((record) => ({
      record: record.record,
      param: record.param,
      level: record.level,
      forecast: record.forecast,
      rangeHeader: group.rangeHeader,
      byteLength: record.byteLength,
    })),
  );
}

async function decodeSelectedRecordsToGrids({
  gribPath,
  selectedPlan,
  selection,
  hour = null,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  decodeConcurrency = 1,
  categoricalPrecipTypeInterpolation = true,
  profile = null,
  decodeSession = null,
}) {
  const cacheKey = decodeSession
    ? decodedSelectionCacheKey({ gribPath, selection, bounds, width, height, categoricalPrecipTypeInterpolation })
    : null;
  const existing = cacheKey ? decodeSession.decodedGridPromises.get(cacheKey) : null;
  if (existing) {
    incrementDecodeSessionCounter(decodeSession, "decodedGridPromiseHits");
    return existing;
  }
  const recordCached = readDecodedSelectionFromRecordCache({
    selection,
    hour,
    bounds,
    width,
    height,
    categoricalPrecipTypeInterpolation,
    decodeSession,
  });
  if (recordCached) {
    return recordCached;
  }
  const promise = (async () => {
    try {
      return await decodeSelectedRecordsBulk({
        gribPath,
        selectedPlan,
        selection,
        hour,
        tempDir,
        wgrib2Path,
        bounds,
        width,
        height,
        categoricalPrecipTypeInterpolation,
        profile,
        decodeSession,
      });
    } catch (error) {
      if (process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE === "1") {
        throw error;
      }
      return decodeSelectedRecordsLegacy({
        gribPath,
        selectedPlan,
        selection,
        hour,
        tempDir,
        wgrib2Path,
        bounds,
        width,
        height,
        decodeConcurrency,
        categoricalPrecipTypeInterpolation,
        profile,
        decodeSession,
      });
    }
  })();
  if (cacheKey) {
    decodeSession.decodedGridPromises.set(cacheKey, promise);
  }
  return promise;
}

function decodedSelectionCacheKey({ gribPath, selection, bounds, width, height, categoricalPrecipTypeInterpolation }) {
  return JSON.stringify({
    gribPath,
    bounds,
    width,
    height,
    categoricalPrecipTypeInterpolation: Boolean(categoricalPrecipTypeInterpolation),
    records: Object.fromEntries(
      Object.entries(selection?.records || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, record]) => [key, selectedRecordDecodeCacheKey(record)]),
    ),
  });
}

function readDecodedSelectionFromRecordCache({
  selection,
  hour = null,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation,
  decodeSession,
}) {
  const cache = decodeSession?.decodedRecordGrids;
  const records = Object.entries(selection?.records || {}).filter(([, record]) => Boolean(record));
  if (!cache || records.length === 0) {
    return null;
  }
  const decoded = {};
  for (const [key, record] of records) {
    const rowInterpolation = decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation);
    const values = boundedRunCacheGet(
      cache,
      decodedRecordGridCacheKey({ record, hour, bounds, width, height, rowInterpolation }),
    );
    if (!values) {
      return null;
    }
    decoded[key] = values;
  }
  incrementDecodeSessionCounter(decodeSession, "decodedRecordGridHits");
  return decoded;
}

function writeDecodedRecordGridCache({
  record,
  values,
  hour = null,
  bounds,
  width,
  height,
  rowInterpolation,
  decodeSession,
}) {
  const cache = decodeSession?.decodedRecordGrids;
  if (!cache || !record || !(values instanceof Float32Array)) {
    return;
  }
  boundedRunCacheSet(
    cache,
    decodedRecordGridCacheKey({ record, hour, bounds, width, height, rowInterpolation }),
    values,
  );
}

function readDecodedRecordsForKeyedRecords({
  recordsByKey,
  hour = null,
  context,
  categoricalPrecipTypeInterpolation = true,
}) {
  return readDecodedSelectionFromRecordCache({
    selection: { records: recordsByKey || {} },
    hour: hour ?? context?.targetHour ?? null,
    bounds: context?.bounds,
    width: context?.width,
    height: context?.height,
    categoricalPrecipTypeInterpolation,
    decodeSession: context?.decodeSession,
  });
}

async function readRegisteredSourceGrid({ family, payload, context, counterKey = "sourceGridRegistryHits" }) {
  const cache = context?.decodeSession?.sourceGridRegistry;
  if (!cache || !family || !payload) {
    return null;
  }
  const cached = boundedRunCacheGet(cache, sourceGridRegistryKey(family, payload));
  if (!cached) {
    return null;
  }
  const values = typeof cached.then === "function" ? await cached : cached;
  if (!(values instanceof Float32Array)) {
    return null;
  }
  incrementProfileCounter(context.profile, counterKey);
  return values;
}

function registerSourceGrid({ family, payload, context, values }) {
  const cache = context?.decodeSession?.sourceGridRegistry;
  if (!cache || !family || !payload || !(values instanceof Float32Array)) {
    return;
  }
  boundedRunCacheSet(cache, sourceGridRegistryKey(family, payload), values);
}

function sourceGridRegistryKey(family, payload) {
  return `${family}:${cachePayloadHashFromJson(cachePayloadJson(payload))}`;
}

function readRegisteredProfileGrids({ recordsByKey, hour, context }) {
  const entries = Object.entries(recordsByKey || {}).filter(([, record]) => Boolean(record));
  if (entries.length === 0) {
    return null;
  }
  const cache = context?.decodeSession?.profileGridRegistry;
  const out = {};
  if (cache) {
    let allProfileRegistered = true;
    for (const [key, record] of entries) {
      const values = boundedRunCacheGet(cache, profileGridRegistryKey({ record, hour, context }));
      if (!(values instanceof Float32Array)) {
        allProfileRegistered = false;
        break;
      }
      out[key] = values;
    }
    if (allProfileRegistered) {
      incrementProfileCounter(context.profile, "profileGridRegistryHits");
      return out;
    }
  }
  const decodedCached = readDecodedRecordsForKeyedRecords({ recordsByKey, hour, context });
  if (decodedCached) {
    registerProfileGrids({ recordsByKey, hour, context, decoded: decodedCached });
    return decodedCached;
  }
  return null;
}

function registerProfileGrids({ recordsByKey, hour, context, decoded }) {
  const cache = context?.decodeSession?.profileGridRegistry;
  if (!cache || !decoded || typeof decoded !== "object") {
    return;
  }
  for (const [key, record] of Object.entries(recordsByKey || {})) {
    const values = decoded[key];
    if (!(values instanceof Float32Array)) {
      continue;
    }
    boundedRunCacheSet(cache, profileGridRegistryKey({ record, hour, context }), values);
    writeDecodedRecordGridCache({
      record,
      values,
      hour,
      bounds: context.bounds,
      width: context.width,
      height: context.height,
      rowInterpolation: "bilinear",
      decodeSession: context.decodeSession,
    });
  }
}

function profileGridRegistryKey({ record, hour, context }) {
  return JSON.stringify({
    hour: Math.round(Number(hour)),
    record: selectedPrecipRecordIdentity(record),
    bounds: context?.bounds,
    width: context?.width,
    height: context?.height,
    rowInterpolation: "bilinear",
  });
}

function decodedRecordGridCacheKey({ record, hour = null, bounds, width, height, rowInterpolation }) {
  return JSON.stringify({
    hour: Number.isFinite(Number(hour)) ? Math.round(Number(hour)) : null,
    record: selectedRecordDecodeCacheKey(record),
    bounds,
    width,
    height,
    rowInterpolation: String(rowInterpolation || "bilinear"),
  });
}

function getWgrib2Identity(wgrib2Path) {
  const key = String(wgrib2Path || "");
  let promise = WGRIB2_IDENTITY_PROMISES.get(key);
  if (!promise) {
    promise = runCommand(wgrib2Path, ["-version"], { allowNonZero: true })
      .then((result) => String(result?.stdout || "").trim() || null)
      .catch(() => null);
    WGRIB2_IDENTITY_PROMISES.set(key, promise);
  }
  return promise;
}

async function resolveRegriddedBinCacheContext({ gribPath, wgrib2Path, regridArgsSignature, decodeSession = null }) {
  // The context is fully determined by the selected GRIB path (whose cached
  // sidecar bytes are immutable once written), the regrid signature, and the
  // wgrib2 identity, so frame sessions memoize it to avoid re-reading and
  // re-hashing the sidecar for every decode consumer of the same hour.
  const memo = decodeSession?.regridBinCacheContexts;
  const memoKey = memo ? `${gribPath} ${regridArgsSignature.join(" ")}` : null;
  if (memo && memo.has(memoKey)) {
    return memo.get(memoKey);
  }
  const context = await resolveRegriddedBinCacheContextUncached({ gribPath, wgrib2Path, regridArgsSignature });
  if (memo) {
    memo.set(memoKey, context);
  }
  return context;
}

async function resolveRegriddedBinCacheContextUncached({ gribPath, wgrib2Path, regridArgsSignature }) {
  let selectedMetadata;
  try {
    selectedMetadata = await readSelectedGribMetadata(gribPath);
  } catch {
    return null;
  }
  const selectedSha256 = String(selectedMetadata?.sha256 || "");
  const selectedHash = String(selectedMetadata?.selectedHash || "");
  if (!selectedSha256 || !selectedHash) {
    return null;
  }
  const wgrib2Identity = await getWgrib2Identity(wgrib2Path);
  if (!wgrib2Identity) {
    return null;
  }
  const payload = {
    kind: REGRIDDED_BIN_CACHE_VERSION,
    selectedSha256,
    selectedHash,
    regridArgs: regridArgsSignature,
    exportArgs: REGRIDDED_BIN_EXPORT_ARGS,
    wgrib2: wgrib2Identity,
  };
  const descriptor = cachePayloadDescriptor(payload);
  const pathToken = descriptor.payloadHash.slice(0, 16);
  return {
    payload,
    payloadHash: descriptor.payloadHash,
    binPath: `${gribPath}.regrid-${pathToken}.bin`,
    metadataPath: `${gribPath}.regrid-${pathToken}.json`,
  };
}

async function readRegriddedBinCache(cacheContext) {
  if (!cacheContext) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(cacheContext.metadataPath, "utf8"));
    if (!cacheMetadataPayloadMatches(metadata, cacheContext.payload)) {
      return null;
    }
    const inventoryText = String(metadata.inventoryText || "");
    const binBytes = Number(metadata.binBytes);
    if (!inventoryText || !Number.isFinite(binBytes) || binBytes <= 0) {
      return null;
    }
    const stat = await fs.promises.stat(cacheContext.binPath);
    if (stat.size !== binBytes) {
      return null;
    }
    return { inventoryText, binBytes };
  } catch {
    return null;
  }
}

async function writeRegriddedBinCache(cacheContext, { binSourcePath, inventoryText, binBytes }) {
  const tmp = `${cacheContext.binPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    try {
      await fs.promises.rename(binSourcePath, tmp);
    } catch {
      await fs.promises.copyFile(binSourcePath, tmp);
    }
    await fs.promises.writeFile(
      `${tmp}.json`,
      JSON.stringify(cacheMetadataWithPayload(cacheContext.payload, { inventoryText, binBytes })),
    );
    await fs.promises.rename(tmp, cacheContext.binPath);
    await fs.promises.rename(`${tmp}.json`, cacheContext.metadataPath);
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    await fs.promises.rm(`${tmp}.json`, { force: true }).catch(() => {});
  }
}

async function decodeSelectedRecordsBulk({
  gribPath,
  selectedPlan = null,
  selection,
  hour = null,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation = true,
  profile,
  decodeSession = null,
}) {
  const gridPath = path.join(tempDir, "selected-regridded.grib2");
  const binPath = path.join(tempDir, "selected-regridded.bin");
  const regridArgsSignature = buildNoaaRegridArgs({
    gribPath: "",
    gridPath: "",
    bounds,
    width,
    height,
    useCategoricalPrecipTypeInterpolation: Boolean(categoricalPrecipTypeInterpolation),
  }).slice(1, -1);
  const cacheContext = await resolveRegriddedBinCacheContext({
    gribPath,
    wgrib2Path,
    regridArgsSignature,
    decodeSession,
  });
  const cached = await readRegriddedBinCache(cacheContext);
  let inventoryText;
  let binReadPath;
  let cachedBinBytes = null;
  let persistBinAfterDecode = false;
  if (cached) {
    incrementProfileCounter(profile, "regridBinCacheHits");
    inventoryText = cached.inventoryText;
    binReadPath = cacheContext.binPath;
    cachedBinBytes = cached.binBytes;
  } else {
    if (cacheContext) {
      incrementProfileCounter(profile, "regridBinCacheMisses");
      persistBinAfterDecode = true;
    }
    await fs.promises.rm(gridPath, { force: true }).catch(() => {});
    await fs.promises.rm(binPath, { force: true }).catch(() => {});
    let regridStageStartedAt = performance.now();
    await runCommand(
      wgrib2Path,
      buildNoaaRegridArgs({
        gribPath,
        gridPath,
        bounds,
        width,
        height,
        useCategoricalPrecipTypeInterpolation: Boolean(categoricalPrecipTypeInterpolation),
      }),
    );
    recordProfileStage(profile, "wgribRegridMs", regridStageStartedAt);
    regridStageStartedAt = performance.now();
    inventoryText = (await runCommand(wgrib2Path, [gridPath, ...REGRIDDED_BIN_EXPORT_ARGS, binPath])).stdout;
    recordProfileStage(profile, "wgribExportMs", regridStageStartedAt);
    binReadPath = binPath;
  }
  const inventory = parseWgribSimpleInventory(inventoryText);
  if (inventory.length === 0) {
    throw new Error("Bulk NOAA decode produced an empty regridded inventory.");
  }
  let stageStartedAt = performance.now();
  // Cache hits already validated the bin size against the metadata during
  // readRegriddedBinCache, so the extra stat is skipped.
  const binSize = cachedBinBytes !== null ? cachedBinBytes : (await fs.promises.stat(binReadPath)).size;
  recordProfileStage(profile, "binaryReadMs", stageStartedAt);
  const fieldBytes = width * height * 4;
  if (binSize < inventory.length * fieldBytes) {
    throw new Error(`Bulk NOAA binary has ${binSize} bytes; expected at least ${inventory.length * fieldBytes}.`);
  }
  const decoded = {};
  const usedRecordNumbers = new Set();
  const regriddedRecordBySource = new Map();
  const regriddedInventoryIndex = buildBulkDecodedRecordIndex(inventory);
  const selectedRecordIndex = selectedPlan?.recordIndexByOriginalRecord || null;
  const decodedGridByRecord = new Map();
  let sliceScratchBuffer = null;
  const requiredKeys = requiredDecodeKeys(selection.catalog || NOAA_NAM_PARAMETER_CATALOG);
  stageStartedAt = performance.now();
  const binHandle = await fs.promises.open(binReadPath, "r");
  try {
    for (const [key, sourceRecord] of Object.entries(selection.records || {})) {
      if (!sourceRecord) {
        continue;
      }
      const sourceRecordKey = selectedRecordDecodeCacheKey(sourceRecord);
      const rowInterpolation = decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation);
      let regriddedRecord = regriddedRecordBySource.get(sourceRecordKey);
      if (!regriddedRecord) {
        regriddedRecord =
          takeBulkDecodedRecordBySelectedPlan(
            regriddedInventoryIndex,
            selectedRecordIndex,
            sourceRecord,
            usedRecordNumbers,
          ) || takeBulkDecodedRecord(regriddedInventoryIndex, sourceRecord, usedRecordNumbers);
        if (regriddedRecord) {
          usedRecordNumbers.add(bulkDecodedRecordOrdinal(regriddedRecord));
          regriddedRecordBySource.set(sourceRecordKey, regriddedRecord);
        }
      }
      if (!regriddedRecord) {
        if (requiredKeys.has(key)) {
          throw new Error(`Bulk NOAA decode is missing required regridded record for ${key}.`);
        }
        continue;
      }
      const fieldOrdinal = bulkDecodedRecordOrdinal(regriddedRecord);
      const gridCacheKey = `${fieldOrdinal}:${rowInterpolation}`;
      let values = decodedGridByRecord.get(gridCacheKey);
      if (!values) {
        // The slice loop is sequential within this call, so one scratch read
        // buffer serves every field slice.
        if (!sliceScratchBuffer) {
          sliceScratchBuffer = Buffer.allocUnsafe(fieldBytes);
        }
        values = await decodeBinaryGridFileSlice({
          fileHandle: binHandle,
          byteOffset: (fieldOrdinal - 1) * fieldBytes,
          fieldBytes,
          bounds,
          width,
          height,
          rowInterpolation,
          rowMapCache: decodeSession?.rowMaps,
          decodeSession,
          scratchBuffer: sliceScratchBuffer,
        });
        decodedGridByRecord.set(gridCacheKey, values);
        writeDecodedRecordGridCache({
          record: sourceRecord,
          values,
          hour,
          bounds,
          width,
          height,
          rowInterpolation,
          decodeSession,
        });
      }
      decoded[key] = values;
    }
  } finally {
    await binHandle.close().catch(() => {});
  }
  recordProfileStage(profile, "gridMapMs", stageStartedAt);
  if (persistBinAfterDecode) {
    await writeRegriddedBinCache(cacheContext, {
      binSourcePath: binPath,
      inventoryText,
      binBytes: binSize,
    }).catch(() => {});
  }
  return decoded;
}

function selectedRecordDecodeCacheKey(record) {
  return JSON.stringify(selectedPrecipRecordIdentity(record));
}

function decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation = true) {
  return categoricalPrecipTypeInterpolation && PRECIP_TYPE_DECODE_KEYS.has(key) ? "nearest" : "bilinear";
}

function parseWgribSimpleInventory(text) {
  const rows = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(":");
    const record = String(parts[0] || "").trim();
    const recordNumber = Number(record);
    if (!record) {
      continue;
    }
    rows.push({
      line,
      record,
      recordNumber,
      fieldOrdinal: rows.length + 1,
      offset: Number(parts[1]),
      dateToken: String(parts[2] || ""),
      param: String(parts[3] || ""),
      level: String(parts[4] || ""),
      forecast: String(parts[5] || ""),
      extra: parts.slice(6).join(":"),
    });
  }
  return rows;
}

function buildBulkDecodedRecordIndex(records) {
  const exact = new Map();
  const byParamLevel = new Map();
  const byRecord = new Map();
  for (const record of records || []) {
    const recordKey = String(record?.record || "");
    const recordQueue = byRecord.get(recordKey) || [];
    recordQueue.push(record);
    byRecord.set(recordKey, recordQueue);
    const exactKey = bulkDecodedRecordExactKey(record);
    const exactQueue = exact.get(exactKey) || [];
    exactQueue.push(record);
    exact.set(exactKey, exactQueue);
    const fallbackKey = bulkDecodedRecordParamLevelKey(record);
    const fallbackQueue = byParamLevel.get(fallbackKey) || [];
    fallbackQueue.push(record);
    byParamLevel.set(fallbackKey, fallbackQueue);
  }
  return { byRecord, exact, byParamLevel };
}

function takeBulkDecodedRecordBySelectedPlan(index, selectedRecordIndex, sourceRecord, usedRecordNumbers) {
  const mappedRecord = selectedRecordIndex?.get(sourceRecord?.record);
  if (!mappedRecord) {
    return null;
  }
  return takeFirstUnusedRecord(
    index.byRecord.get(String(mappedRecord)),
    usedRecordNumbers,
    (record) => bulkDecodedRecordExactKey(record) === bulkDecodedRecordExactKey(sourceRecord),
  );
}

function takeBulkDecodedRecord(index, sourceRecord, usedRecordNumbers) {
  return (
    takeFirstUnusedRecord(index.exact.get(bulkDecodedRecordExactKey(sourceRecord)), usedRecordNumbers) ||
    takeFirstUnusedRecord(index.byParamLevel.get(bulkDecodedRecordParamLevelKey(sourceRecord)), usedRecordNumbers) ||
    null
  );
}

function takeFirstUnusedRecord(queue, usedRecordNumbers, predicate = null) {
  if (typeof predicate === "function") {
    const matchIndex = Array.isArray(queue)
      ? queue.findIndex((record) => !usedRecordNumbers.has(bulkDecodedRecordOrdinal(record)) && predicate(record))
      : -1;
    return matchIndex >= 0 ? queue.splice(matchIndex, 1)[0] : null;
  }
  while (Array.isArray(queue) && queue.length > 0) {
    const record = queue.shift();
    const ordinal = bulkDecodedRecordOrdinal(record);
    if (!usedRecordNumbers.has(ordinal)) {
      return record;
    }
  }
  return null;
}

function bulkDecodedRecordOrdinal(record) {
  const ordinal = Number(record?.fieldOrdinal);
  if (Number.isFinite(ordinal) && ordinal >= 1) {
    return Math.round(ordinal);
  }
  const recordNumber = Number(record?.recordNumber);
  return Number.isFinite(recordNumber) && recordNumber >= 1 ? Math.floor(recordNumber) : 1;
}

function bulkDecodedRecordExactKey(record) {
  return `${record?.param || ""}\u0000${record?.level || ""}\u0000${record?.forecast || ""}`;
}

function bulkDecodedRecordParamLevelKey(record) {
  return `${record?.param || ""}\u0000${record?.level || ""}`;
}

function requiredDecodeKeys(catalog) {
  const keys = new Set();
  for (const entry of catalog || []) {
    if (!entry?.required) {
      continue;
    }
    if (entry.kind === "wind") {
      keys.add(entry.uKey);
      keys.add(entry.vKey);
    } else if (entry.inputKey) {
      keys.add(entry.inputKey);
    }
  }
  return keys;
}

async function decodeSelectedRecordsLegacy({
  gribPath,
  selectedPlan,
  selection,
  hour = null,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  decodeConcurrency = 1,
  categoricalPrecipTypeInterpolation = true,
  profile = null,
  decodeSession = null,
}) {
  const stageStartedAt = performance.now();
  const decoded = {};
  const skippedDecodeKeys = new Set();
  const resolvedDecodeConcurrency = clampInt(decodeConcurrency, 1, 8, 1);
  const windEntries = (selection.catalog || []).filter(
    (entry) => entry.kind === "wind" && selection.records[entry.uKey] && selection.records[entry.vKey],
  );
  await mapWithConcurrency(windEntries, resolvedDecodeConcurrency, async (entry) => {
    try {
      const pairDecoded = await decodeWindPairToGrids({
        gribPath,
        tempDir,
        wgrib2Path,
        bounds,
        width,
        height,
        level: entry.uSelector.level,
        outputUKey: entry.uKey,
        outputVKey: entry.vKey,
      });
      Object.assign(decoded, pairDecoded);
      for (const key of [entry.uKey, entry.vKey]) {
        writeDecodedRecordGridCache({
          record: selection.records[key],
          values: pairDecoded[key],
          hour,
          bounds,
          width,
          height,
          rowInterpolation: "bilinear",
          decodeSession,
        });
      }
    } catch (error) {
      if (entry.required) {
        throw error;
      }
      skippedDecodeKeys.add(entry.uKey);
      skippedDecodeKeys.add(entry.vKey);
    }
  });
  const scalarDecodeTasks = Object.entries(selection.records)
    .map(([key, record]) => {
      if (!record || skippedDecodeKeys.has(key) || decoded[key]) {
        return null;
      }
      const partialIndex = selectedPlan.recordIndexByOriginalRecord.get(record.record);
      return partialIndex ? { key, record, recordIndex: partialIndex } : null;
    })
    .filter(Boolean);
  const scalarGridPromisesByRecord = new Map();
  await mapWithConcurrency(scalarDecodeTasks, resolvedDecodeConcurrency, async ({ key, record, recordIndex }) => {
    const rowInterpolation = decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation);
    const gridCacheKey = `${recordIndex}:${rowInterpolation}`;
    let gridPromise = scalarGridPromisesByRecord.get(gridCacheKey);
    if (!gridPromise) {
      gridPromise = decodeRecordToGrid({
        gribPath,
        recordIndex,
        key,
        tempDir,
        wgrib2Path,
        bounds,
        width,
        height,
        categoricalPrecipTypeInterpolation,
      });
      scalarGridPromisesByRecord.set(gridCacheKey, gridPromise);
    }
    const values = await gridPromise;
    decoded[key] = values;
    writeDecodedRecordGridCache({
      record,
      values,
      hour,
      bounds,
      width,
      height,
      rowInterpolation,
      decodeSession,
    });
  });
  recordProfileStage(profile, "legacyDecodeMs", stageStartedAt);
  return decoded;
}

async function decodeWindPairToGrids({
  gribPath,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  level = "10 m above ground",
  outputUKey = "windU10m",
  outputVKey = "windV10m",
}) {
  const safeName = String(outputUKey || "wind").replace(/[^a-zA-Z0-9_-]+/g, "-");
  const gridPath = path.join(tempDir, `${safeName}-pair.grib2`);
  const dlon = (bounds.east - bounds.west) / Math.max(1, width - 1);
  const dlat = (bounds.north - bounds.south) / Math.max(1, height - 1);
  await fs.promises.rm(gridPath, { force: true }).catch(() => {});
  await runCommand(wgrib2Path, [
    gribPath,
    "-match",
    `:(UGRD|VGRD):${escapeWgrib2MatchLiteral(level)}:`,
    "-new_grid_winds",
    "earth",
    "-new_grid_interpolation",
    "bilinear",
    "-new_grid",
    "latlon",
    `${bounds.west}:${width}:${dlon}`,
    `${bounds.south}:${height}:${dlat}`,
    gridPath,
  ]);
  return {
    [outputUKey]: await decodeRegriddedRecordToGrid({
      gridPath,
      recordIndex: "1",
      binPath: path.join(tempDir, `${outputUKey}.bin`),
      wgrib2Path,
      bounds,
      width,
      height,
    }),
    [outputVKey]: await decodeRegriddedRecordToGrid({
      gridPath,
      recordIndex: "2",
      binPath: path.join(tempDir, `${outputVKey}.bin`),
      wgrib2Path,
      bounds,
      width,
      height,
    }),
  };
}

function escapeWgrib2MatchLiteral(value) {
  return String(value || "").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function decodeRecordToGrid({
  gribPath,
  recordIndex,
  key,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation = true,
}) {
  const gridPath = path.join(tempDir, `${key}.grib2`);
  const binPath = path.join(tempDir, `${key}.bin`);
  await fs.promises.rm(gridPath, { force: true }).catch(() => {});
  await fs.promises.rm(binPath, { force: true }).catch(() => {});
  await runCommand(
    wgrib2Path,
    buildNoaaRegridArgs({
      gribPath,
      recordIndex,
      gridPath,
      bounds,
      width,
      height,
      interpolation: categoricalPrecipTypeInterpolation && PRECIP_TYPE_DECODE_KEYS.has(key) ? "neighbor" : "bilinear",
    }),
  );
  return decodeRegriddedRecordToGrid({
    gridPath,
    recordIndex: "1",
    binPath,
    wgrib2Path,
    bounds,
    width,
    height,
    rowInterpolation: categoricalPrecipTypeInterpolation && PRECIP_TYPE_DECODE_KEYS.has(key) ? "nearest" : "bilinear",
  });
}

function buildNoaaRegridArgs({
  gribPath,
  recordIndex = null,
  gridPath,
  bounds,
  width,
  height,
  interpolation = "bilinear",
  useCategoricalPrecipTypeInterpolation = false,
}) {
  const dlon = (bounds.east - bounds.west) / Math.max(1, width - 1);
  const dlat = (bounds.north - bounds.south) / Math.max(1, height - 1);
  const args = [gribPath];
  if (recordIndex !== null && recordIndex !== undefined) {
    args.push("-d", String(recordIndex));
  }
  args.push("-new_grid_winds", "earth", "-new_grid_interpolation", interpolation);
  if (useCategoricalPrecipTypeInterpolation) {
    args.push("-if", PRECIP_TYPE_REGRID_PATTERN, "-new_grid_interpolation", "neighbor", "-fi");
  }
  args.push("-new_grid", "latlon", `${bounds.west}:${width}:${dlon}`, `${bounds.south}:${height}:${dlat}`, gridPath);
  return args;
}

async function decodeRegriddedRecordToGrid({
  gridPath,
  recordIndex,
  binPath,
  wgrib2Path,
  bounds,
  width,
  height,
  rowInterpolation = "bilinear",
}) {
  await fs.promises.rm(binPath, { force: true }).catch(() => {});
  await runCommand(wgrib2Path, [gridPath, "-d", String(recordIndex), "-order", "we:sn", "-no_header", "-bin", binPath]);
  const expectedBytes = width * height * 4;
  const body = await fs.promises.readFile(binPath);
  if (body.length !== expectedBytes) {
    throw new Error(`Decoded NOAA grid has ${body.length} bytes; expected ${expectedBytes}.`);
  }
  return decodeSouthNorthBinaryGridBuffer({ body, byteOffset: 0, bounds, width, height, rowInterpolation });
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

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowNonZero) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function createFrameDecodeSession(profile = null) {
  return {
    profile,
    runCache: null,
    selectedGribPromises: new Map(),
    decodedGridPromises: new Map(),
    decodedRecordGrids: createBoundedRunCacheMap(RUN_LOCAL_DECODED_RECORD_GRID_MAX_ENTRIES),
    sourceGridRegistry: createBoundedRunCacheMap(RUN_LOCAL_SOURCE_GRID_MAX_ENTRIES),
    profileGridRegistry: createBoundedRunCacheMap(RUN_LOCAL_PROFILE_GRID_MAX_ENTRIES),
    profileDecodeBatches: new Map(),
    rowMaps: new Map(),
    parsedRecords: new Map(),
    selectedPlans: new Map(),
    regridBinCacheContexts: new Map(),
    counters: {
      selectedGribPromiseHits: 0,
      decodedGridPromiseHits: 0,
      decodedRecordGridHits: 0,
      rowMapHits: 0,
      rowMapMisses: 0,
    },
  };
}

function attachRunLocalDecodeSession(decodeSession, context) {
  if (!decodeSession) {
    return null;
  }
  const runCache = getRunLocalCache(context);
  decodeSession.runCache = runCache;
  decodeSession.decodedRecordGrids = runCache.decodedRecordGrids;
  decodeSession.sourceGridRegistry = runCache.sourceGridRegistry;
  decodeSession.profileGridRegistry = runCache.profileGridRegistry;
  return runCache;
}

function buildNoaaIndexCacheContext({ modelKey, date, cycle, rawCacheDir }) {
  return {
    modelKey,
    date,
    cycle,
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
  };
}

function createNoaaRenderProfile() {
  return {
    stages: {},
    selectedRecordGroups: 0,
    selectedBytes: 0,
    selectedGribCacheHit: false,
    rangeFetchRetries: 0,
    rangeFetchRetryStatuses: {},
  };
}

function finalizeNoaaRenderProfile(profile) {
  if (!profile) {
    return null;
  }
  const out = {
    selectedRecordGroups: Number(profile.selectedRecordGroups) || 0,
    selectedBytes: Number(profile.selectedBytes) || 0,
    selectedGribCacheHit: Boolean(profile.selectedGribCacheHit),
    selectedGribCacheHits: Number(profile.selectedGribCacheHits) || 0,
    selectedGribCacheMisses: Number(profile.selectedGribCacheMisses) || 0,
    selectedGribLockWaits: Number(profile.selectedGribLockWaits) || 0,
    selectedGribPromiseHits: Number(profile.selectedGribPromiseHits) || 0,
    regridBinCacheHits: Number(profile.regridBinCacheHits) || 0,
    regridBinCacheMisses: Number(profile.regridBinCacheMisses) || 0,
    selectedPlanCacheHits: Number(profile.selectedPlanCacheHits) || 0,
    decodedGridPromiseHits: Number(profile.decodedGridPromiseHits) || 0,
    decodedRecordGridHits: Number(profile.decodedRecordGridHits) || 0,
    sourceGridRegistryHits: Number(profile.sourceGridRegistryHits) || 0,
    precipAccumSourceRegistryHits: Number(profile.precipAccumSourceRegistryHits) || 0,
    snowLiquidSourceRegistryHits: Number(profile.snowLiquidSourceRegistryHits) || 0,
    freezingRainLiquidSourceRegistryHits: Number(profile.freezingRainLiquidSourceRegistryHits) || 0,
    profileGridRegistryHits: Number(profile.profileGridRegistryHits) || 0,
    rowMapHits: Number(profile.rowMapHits) || 0,
    rowMapMisses: Number(profile.rowMapMisses) || 0,
    indexCacheHits: Number(profile.indexCacheHits) || 0,
    indexCacheMisses: Number(profile.indexCacheMisses) || 0,
    contentLengthCacheHits: Number(profile.contentLengthCacheHits) || 0,
    contentLengthCacheMisses: Number(profile.contentLengthCacheMisses) || 0,
    rangeFetchRetries: Number(profile.rangeFetchRetries) || 0,
    precipAccumSourceRefs: Number(profile.precipAccumSourceRefs) || 0,
    precipAccumSourceCount: Number(profile.precipAccumSourceCount) || 0,
    precipAccumGridCacheHits: Number(profile.precipAccumGridCacheHits) || 0,
    precipAccumGridCacheMisses: Number(profile.precipAccumGridCacheMisses) || 0,
    precipAccumGridLockTimeouts: Number(profile.precipAccumGridLockTimeouts) || 0,
    runMaxGridCacheHits: Number(profile.runMaxGridCacheHits) || 0,
    runMaxGridCacheMisses: Number(profile.runMaxGridCacheMisses) || 0,
    runMaxSourceCacheHits: Number(profile.runMaxSourceCacheHits) || 0,
    runMaxSourceCacheMisses: Number(profile.runMaxSourceCacheMisses) || 0,
    runMaxGridLockTimeouts: Number(profile.runMaxGridLockTimeouts) || 0,
    runMaxSourceLockTimeouts: Number(profile.runMaxSourceLockTimeouts) || 0,
    snowLiquidSourceRefs: Number(profile.snowLiquidSourceRefs) || 0,
    snowLiquidSourceCount: Number(profile.snowLiquidSourceCount) || 0,
    snowLiquidGridCacheHits: Number(profile.snowLiquidGridCacheHits) || 0,
    snowLiquidGridCacheMisses: Number(profile.snowLiquidGridCacheMisses) || 0,
    snowLiquidGridLockTimeouts: Number(profile.snowLiquidGridLockTimeouts) || 0,
    snowfallIntervalCount: Number(profile.snowfallIntervalCount) || 0,
    snowfallIntervalActiveCount: Number(profile.snowfallIntervalActiveCount) || 0,
    snowfallIntervalSourceRefs: Number(profile.snowfallIntervalSourceRefs) || 0,
    snowfallCumulativeCacheHits: Number(profile.snowfallCumulativeCacheHits) || 0,
    snowfallCumulativeCacheMisses: Number(profile.snowfallCumulativeCacheMisses) || 0,
    snowfallCumulativeLockTimeouts: Number(profile.snowfallCumulativeLockTimeouts) || 0,
    snowfallDeltaCacheHits: Number(profile.snowfallDeltaCacheHits) || 0,
    snowfallDeltaCacheMisses: Number(profile.snowfallDeltaCacheMisses) || 0,
    snowfallDeltaLockTimeouts: Number(profile.snowfallDeltaLockTimeouts) || 0,
    profileRecordCount: Number(profile.profileRecordCount) || 0,
    profileGridCacheHits: Number(profile.profileGridCacheHits) || 0,
    profileGridCacheMisses: Number(profile.profileGridCacheMisses) || 0,
    profileGridLockTimeouts: Number(profile.profileGridLockTimeouts) || 0,
    dcapeStats: profile.dcapeStats || null,
    stages: {},
  };
  if (profile.rangeFetchRetries > 0) {
    out.rangeFetchRetryStatuses = { ...profile.rangeFetchRetryStatuses };
  }
  for (const [key, value] of Object.entries(profile.stages || {})) {
    if (Number.isFinite(value)) {
      out.stages[key] = roundMs(value);
    }
  }
  return out;
}

const RUN_LOCAL_CACHE_STORES = new Map();

const RUN_LOCAL_CACHE_MAX_RUNS = 8;

const RUN_LOCAL_DECODED_RECORD_GRID_MAX_ENTRIES = 192;

const RUN_LOCAL_SOURCE_GRID_MAX_ENTRIES = 192;

const RUN_LOCAL_PROFILE_GRID_MAX_ENTRIES = 192;

function getRunLocalCache(context) {
  const key = runLocalCacheKey(context);
  let cache = RUN_LOCAL_CACHE_STORES.get(key);
  if (cache) {
    cache.lastUsed = Date.now();
    RUN_LOCAL_CACHE_STORES.delete(key);
    RUN_LOCAL_CACHE_STORES.set(key, cache);
    return cache;
  }
  cache = {
    key,
    lastUsed: Date.now(),
    decodedRecordGrids: createBoundedRunCacheMap(RUN_LOCAL_DECODED_RECORD_GRID_MAX_ENTRIES),
    sourceGridRegistry: createBoundedRunCacheMap(RUN_LOCAL_SOURCE_GRID_MAX_ENTRIES),
    profileGridRegistry: createBoundedRunCacheMap(RUN_LOCAL_PROFILE_GRID_MAX_ENTRIES),
  };
  RUN_LOCAL_CACHE_STORES.set(key, cache);
  pruneRunLocalCaches();
  return cache;
}

function runLocalCacheKey(context) {
  return JSON.stringify({
    modelKey: context?.modelKey || "",
    productKey: context?.modelConfig?.productKey || "",
    baseUrl: normalizeBaseUrl(context?.baseUrl || ""),
    date: context?.date || "",
    cycle: context?.cycle || "",
  });
}

function pruneRunLocalCaches() {
  while (RUN_LOCAL_CACHE_STORES.size > RUN_LOCAL_CACHE_MAX_RUNS) {
    const oldestKey = RUN_LOCAL_CACHE_STORES.keys().next().value;
    RUN_LOCAL_CACHE_STORES.delete(oldestKey);
  }
}

module.exports = {
  RUN_LOCAL_CACHE_MAX_RUNS,
  RUN_LOCAL_CACHE_STORES,
  RUN_LOCAL_DECODED_RECORD_GRID_MAX_ENTRIES,
  RUN_LOCAL_PROFILE_GRID_MAX_ENTRIES,
  RUN_LOCAL_SOURCE_GRID_MAX_ENTRIES,
  getRunLocalCache,
  pruneRunLocalCaches,
  runLocalCacheKey,
  createNoaaRenderProfile,
  finalizeNoaaRenderProfile,
  createFrameDecodeSession,
  attachRunLocalDecodeSession,
  buildNoaaIndexCacheContext,
  CATALOG_VERSION,
  DEFAULT_WGRIB2_PATH,
  NOAA_INDEX_CONTENT_LENGTH_CACHE,
  NOAA_INDEX_CONTENT_LENGTH_CACHE_MAX_ENTRIES,
  NOAA_INDEX_RECORD_CACHE,
  NOAA_INDEX_RECORD_CACHE_MAX_ENTRIES,
  NOAA_INDEX_TEXT_CACHE,
  NOAA_INDEX_TEXT_CACHE_MAX_ENTRIES,
  PRECIP_TYPE_DECODE_KEYS,
  PRECIP_TYPE_REGRID_PATTERN,
  REGRIDDED_BIN_CACHE_VERSION,
  REGRIDDED_BIN_EXPORT_ARGS,
  SELECTED_GRIB_CACHE_DIRNAME,
  SELECTED_GRIB_CACHE_METADATA_VERSION,
  SELECTED_GRIB_LOCK_POLL_MS,
  SELECTED_GRIB_LOCK_TIMEOUT_MS,
  WGRIB2_IDENTITY_PROMISES,
  assignNoaaIdxByteRanges,
  buildBulkDecodedRecordIndex,
  buildNoaaRegridArgs,
  buildSelectedRecordPlan,
  bulkDecodedRecordExactKey,
  bulkDecodedRecordOrdinal,
  bulkDecodedRecordParamLevelKey,
  clearNoaaIndexCachesForTest,
  decodeRecordToGrid,
  decodeRegriddedRecordToGrid,
  decodeRowInterpolationForKey,
  decodeSelectedRecordsBulk,
  decodeSelectedRecordsLegacy,
  decodeSelectedRecordsToGrids,
  decodeWindPairToGrids,
  decodedRecordGridCacheKey,
  decodedSelectionCacheKey,
  ensureWgrib2Available,
  escapeWgrib2MatchLiteral,
  fetchAndWriteNoaaIdxText,
  fetchContentLength,
  fetchRangeChunk,
  fetchText,
  getNoaaRecordsForHour,
  getSelectedRecordPlan,
  getWgrib2Identity,
  hashFileSha256,
  isRetryableRangeFetchError,
  materializeSelectedGrib,
  materializeSelectedGribUncached,
  noaaIdxCachePath,
  noaaIdxMetadataCachePath,
  parseNoaaIdx,
  parseWgribSimpleInventory,
  profileGridRegistryKey,
  readCachedSelectedGribPath,
  readDecodedRecordsForKeyedRecords,
  readDecodedSelectionFromRecordCache,
  readOrFetchNoaaContentLength,
  readOrFetchNoaaContentLengthCached,
  readOrFetchNoaaIdxText,
  readOrFetchNoaaIdxTextCached,
  readRegisteredProfileGrids,
  readRegisteredSourceGrid,
  readRegriddedBinCache,
  readSelectedGribMetadata,
  recordRangeFetchRetry,
  registerProfileGrids,
  registerSourceGrid,
  repairNoaaIdxFinalRecordRanges,
  requiredDecodeKeys,
  resolveRegriddedBinCacheContext,
  resolveRegriddedBinCacheContextUncached,
  runCommand,
  selectedGribCacheDescriptor,
  selectedGribGroupByteLength,
  selectedGribLockPayload,
  selectedGribMetadataMatches,
  selectedGribRecordManifest,
  selectedGribRecordsHash,
  selectedGribSharedCacheDir,
  selectedPrecipRecordIdentity,
  selectedRecordDecodeCacheKey,
  sourceGridRegistryKey,
  takeBulkDecodedRecord,
  takeBulkDecodedRecordBySelectedPlan,
  takeFirstUnusedRecord,
  waitForCachedNoaaIdxText,
  waitForCachedSelectedGrib,
  writeCachedSelectedGrib,
  writeDecodedRecordGridCache,
  writeRegriddedBinCache,
  writeSelectedGribRangeFile,
};
