"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { clampInt, incrementDecodeSessionCounter, incrementProfileCounter } = require("./util");
const {
  boundedRunCacheGet,
  boundedRunCacheSet,
  createBoundedRunCacheMap,
  mapWithConcurrency,
  padHour,
  pathExists,
  recordProfileStage,
  releaseGridCacheLock,
  sanitizePathToken,
  tryAcquireGridCacheLock,
} = require("./cache-io");
const { referenceTimeIsoFromNoaaRun, validTimeIsoFromNoaaRun } = require("./model-config");
const { sleep } = require("../local-artifact-options");

const SELECTED_GRIB_CACHE_DIRNAME = "selected-grib-v2";

const SELECTED_GRIB_CACHE_METADATA_VERSION = 3;

const SELECTED_GRIB_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

const SELECTED_GRIB_LOCK_POLL_MS = 100;

const CATALOG_VERSION = "noaa-grib2-catalog-v4";

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
  // "wait-then-fetch" (default) keeps the historical semantics: a caller
  // that loses the lock race polls for the winner's file and, on timeout,
  // fetches without the lock as a last resort — correctness over dedupe.
  // "decline" resolves null immediately on contention instead; cache
  // warmers use it because a held lock means the work is already being
  // done, and parking or double-fetching adds nothing.
  onLockContention = "wait-then-fetch",
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
    onLockContention,
  })
    .then(async (gribPath) => {
      await registerSelectedGribProvenance(decodeSession, descriptor, gribPath);
      return gribPath;
    })
    .finally(() => {
      if (!descriptor.cachePath) {
        decodeSession?.selectedGribPromises?.delete(promiseKey);
      }
    });
  decodeSession?.selectedGribPromises?.set(promiseKey, promise);
  return promise;
}

async function materializeSelectedGribUncached({
  descriptor,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  profile,
  onLockContention = "wait-then-fetch",
}) {
  const { cachePath, gribUrl, groups } = descriptor;
  const cachedPath = cachePath ? await readCachedSelectedGribPath(cachePath, descriptor, profile) : null;
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
    try {
      await writeSelectedGribRangeFile({
        targetPath: tempPath,
        gribUrl,
        groups,
        rangeFetchConcurrency,
        rangeFetchLimiter,
        profile,
      });
    } catch (error) {
      // A failed fetch leaves the caller with no reference to the temp path,
      // so it must not leak partial GRIB bytes the way the cached branch's
      // cleanup in writeCachedSelectedGrib already prevents.
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    return tempPath;
  }

  const lockPath = `${cachePath}.lock`;
  const lockHandle = await tryAcquireGridCacheLock(lockPath, selectedGribLockPayload(descriptor));
  if (!lockHandle) {
    if (onLockContention === "decline") {
      incrementProfileCounter(profile, "selectedGribLockDeclines");
      return null;
    }
    incrementProfileCounter(profile, "selectedGribLockWaits");
    const waited = await waitForCachedSelectedGrib(cachePath, descriptor, lockPath, profile);
    if (waited) {
      if (profile) {
        profile.selectedGribCacheHit = true;
      }
      incrementProfileCounter(profile, "selectedGribCacheHits");
      return waited;
    }
  } else {
    try {
      const cachedAfterLock = await readCachedSelectedGribPath(cachePath, descriptor, profile);
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

// Selected GRIB cache paths identify their source and record selection, but
// not the selected bytes themselves. Cache pruning, recreation, or external
// corruption can therefore replace a path during a long-lived process. Keep
// the verified hash memo only while the file's full filesystem identity is
// unchanged; the identity stat is much cheaper than re-hashing every frame.
const SELECTED_GRIB_VERIFIED_CACHE = createBoundedRunCacheMap(1024);

const SELECTED_GRIB_METADATA_CACHE = createBoundedRunCacheMap(512);

function selectedGribFileIdentity(stat) {
  if (!stat) {
    return null;
  }
  const nanoseconds = (value, milliseconds) =>
    value !== undefined ? String(value) : String(Math.round(Number(milliseconds) * 1e6));
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: nanoseconds(stat.mtimeNs, stat.mtimeMs),
    ctimeNs: nanoseconds(stat.ctimeNs, stat.ctimeMs),
  };
}

async function statSelectedGribFileIdentity(filePath) {
  return selectedGribFileIdentity(await fs.promises.stat(filePath, { bigint: true }));
}

async function statSelectedGribRegularFileIdentity(filePath) {
  const stat = await fs.promises.stat(filePath, { bigint: true });
  if (!stat.isFile()) {
    throw new Error(`Selected GRIB cache entry is not a regular file: ${filePath}`);
  }
  return selectedGribFileIdentity(stat);
}

function selectedGribFileIdentityMatches(left, right) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readCachedSelectedGribPath(cachePath, descriptor, profile = null) {
  try {
    const identity = await statSelectedGribFileIdentity(cachePath);
    const verified = boundedRunCacheGet(SELECTED_GRIB_VERIFIED_CACHE, cachePath);
    if (verified && selectedGribFileIdentityMatches(verified.identity, identity)) {
      const metadataIdentity = await statSelectedGribFileIdentity(verified.metadataPath).catch(() => null);
      if (selectedGribFileIdentityMatches(verified.metadataIdentity, metadataIdentity)) {
        const stableIdentity = await statSelectedGribFileIdentity(cachePath);
        if (selectedGribFileIdentityMatches(identity, stableIdentity)) {
          return selectedGribMetadataMatches(verified.metadata, descriptor) ? cachePath : null;
        }
      }
    }
    if (verified) {
      SELECTED_GRIB_VERIFIED_CACHE.delete(cachePath);
    }
    const metadataEntry = await readSelectedGribMetadataEntry(cachePath);
    const { metadata } = metadataEntry;
    if (!selectedGribMetadataMatches(metadata, descriptor)) {
      return null;
    }
    if (identity.size !== String(metadata.selectedBytes)) {
      return null;
    }
    incrementProfileCounter(profile, "selectedGribVerifyHashes");
    if (profile) {
      profile.selectedGribVerifyHashBytes = (Number(profile.selectedGribVerifyHashBytes) || 0) + Number(identity.size);
    }
    const sha256 = await hashFileSha256(cachePath);
    if (sha256 !== String(metadata.sha256).toLowerCase()) {
      return null;
    }
    // Do not memoize a verification if either the selected bytes or their
    // identity sidecar was replaced while the file was being hashed.
    const verifiedIdentity = await statSelectedGribFileIdentity(cachePath);
    const verifiedMetadataIdentity = await statSelectedGribFileIdentity(metadataEntry.metadataPath);
    if (
      !selectedGribFileIdentityMatches(identity, verifiedIdentity) ||
      !selectedGribFileIdentityMatches(metadataEntry.identity, verifiedMetadataIdentity)
    ) {
      return null;
    }
    boundedRunCacheSet(SELECTED_GRIB_VERIFIED_CACHE, cachePath, {
      metadata,
      identity: verifiedIdentity,
      metadataPath: metadataEntry.metadataPath,
      metadataIdentity: verifiedMetadataIdentity,
    });
    return cachePath;
  } catch {
    return null;
  }
}

// A warm Mercator pack is already keyed by the selected GRIB SHA-256 and
// validates its own payload before use. Probe the current publication marker
// so that callers can try that strict cache path without first streaming the
// selected GRIB solely to recompute the same hash. This is intentionally only
// a candidate: it neither verifies the body contents nor seeds the
// authoritative selected-GRIB verification cache.
async function probeCachedSelectedGribCandidate(descriptor) {
  const gribPath = descriptor?.cachePath;
  if (!gribPath) {
    return null;
  }
  const metadataPath = `${gribPath}.ready.json`;
  try {
    const identityBefore = await statSelectedGribRegularFileIdentity(gribPath);
    const metadataIdentityBefore = await statSelectedGribRegularFileIdentity(metadataPath);
    const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
    const metadataIdentity = await statSelectedGribRegularFileIdentity(metadataPath);
    const identity = await statSelectedGribRegularFileIdentity(gribPath);
    if (
      !selectedGribFileIdentityMatches(identityBefore, identity) ||
      !selectedGribFileIdentityMatches(metadataIdentityBefore, metadataIdentity)
    ) {
      return null;
    }
    if (!selectedGribMetadataMatches(metadata, descriptor)) {
      return null;
    }
    if (
      !Number.isSafeInteger(metadata.selectedBytes) ||
      metadata.selectedBytes <= 0 ||
      identity.size !== String(metadata.selectedBytes)
    ) {
      return null;
    }
    if (!/^[a-f0-9]{64}$/i.test(String(metadata.sha256 || ""))) {
      return null;
    }
    return {
      gribPath,
      metadata,
      identity,
      metadataPath,
      metadataIdentity,
      provenanceSource: buildSelectedGribProvenanceSource(descriptor, metadata),
    };
  } catch {
    return null;
  }
}

async function readSelectedGribMetadata(cachePath) {
  return (await readSelectedGribMetadataEntry(cachePath)).metadata;
}

async function readSelectedGribMetadataEntry(cachePath) {
  const cached = boundedRunCacheGet(SELECTED_GRIB_METADATA_CACHE, cachePath);
  if (cached) {
    try {
      const identity = await statSelectedGribFileIdentity(cached.metadataPath);
      if (selectedGribFileIdentityMatches(cached.identity, identity)) {
        return cached;
      }
    } catch {
      // The sidecar was pruned or replaced; fall through to a fresh read.
    }
    SELECTED_GRIB_METADATA_CACHE.delete(cachePath);
  }
  const readyPath = `${cachePath}.ready.json`;
  let metadataEntry;
  try {
    metadataEntry = await readSelectedGribMetadataFile(readyPath);
  } catch {
    metadataEntry = await readSelectedGribMetadataFile(`${cachePath}.json`);
  }
  const { metadata, metadataPath, identity } = metadataEntry;
  if (metadata && typeof metadata === "object") {
    boundedRunCacheSet(SELECTED_GRIB_METADATA_CACHE, cachePath, { metadata, metadataPath, identity });
  }
  return { metadata, metadataPath, identity };
}

async function readSelectedGribMetadataFile(metadataPath) {
  const identity = await statSelectedGribFileIdentity(metadataPath);
  const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
  const readIdentity = await statSelectedGribFileIdentity(metadataPath);
  if (!selectedGribFileIdentityMatches(identity, readIdentity)) {
    throw new Error(`Selected GRIB metadata changed while reading ${metadataPath}`);
  }
  return { metadata, metadataPath, identity: readIdentity };
}

function selectedGribMetadataMatches(metadata, descriptor) {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  if (Number(metadata.version) !== SELECTED_GRIB_CACHE_METADATA_VERSION) {
    return false;
  }
  if (metadata.url !== descriptor.gribUrl || metadata.selectedHash !== descriptor.selectedHash) {
    return false;
  }
  if (metadata.urlHash && metadata.urlHash !== descriptor.urlHash) {
    return false;
  }
  if (!/^[a-f0-9]{64}$/i.test(String(metadata.sha256 || ""))) {
    return false;
  }
  return JSON.stringify(metadata.records || []) === descriptor.recordsJson;
}

async function waitForCachedSelectedGrib(cachePath, descriptor, lockPath, profile = null) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < SELECTED_GRIB_LOCK_TIMEOUT_MS) {
    await sleep(SELECTED_GRIB_LOCK_POLL_MS + Math.round(Math.random() * 40));
    const cached = await readCachedSelectedGribPath(cachePath, descriptor, profile);
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
  const metadataTmp = `${tmp}.json`;
  const readyTmp = `${tmp}.ready.json`;
  try {
    const result = await writeSelectedGribRangeFile({
      targetPath: tmp,
      gribUrl: descriptor.gribUrl,
      groups: descriptor.groups,
      rangeFetchConcurrency,
      rangeFetchLimiter,
      profile,
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
    const stageStartedAt = performance.now();
    await fs.promises.writeFile(metadataTmp, JSON.stringify(metadata));
    await fs.promises.writeFile(readyTmp, JSON.stringify(metadata));
    await fs.promises.rename(tmp, cachePath);
    await fs.promises.rename(metadataTmp, `${cachePath}.json`);
    await fs.promises.rename(readyTmp, `${cachePath}.ready.json`);

    // Another writer or cache-pruning process can replace a published path
    // between rename and stat. Invalidate any old memos and use the normal
    // size/hash/identity verification path before returning this cache hit.
    SELECTED_GRIB_VERIFIED_CACHE.delete(cachePath);
    SELECTED_GRIB_METADATA_CACHE.delete(cachePath);
    const verifiedPath = await readCachedSelectedGribPath(cachePath, descriptor);
    if (!verifiedPath) {
      throw new Error(`Selected NOAA GRIB cache failed post-publish verification for ${descriptor.gribUrl}`);
    }
    recordProfileStage(profile, "selectedGribWriteMs", stageStartedAt);
    return verifiedPath;
  } catch (error) {
    await Promise.allSettled([tmp, metadataTmp, readyTmp].map((tempPath) => fs.promises.rm(tempPath, { force: true })));
    throw error;
  }
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
  recordProfileStage(profile, "selectedGribHashMs", hashStartedAt);
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
          const body = Buffer.from(await response.arrayBuffer());
          validateNoaaRangeResponse({ response, group, body, gribUrl });
          return body;
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
  if (typeof rangeFetchLimiter === "function") {
    return rangeFetchLimiter(run);
  }
  if (rangeFetchLimiter && typeof rangeFetchLimiter.run === "function") {
    return rangeFetchLimiter.run(run);
  }
  return run();
}

function parseHttpByteRange(value) {
  const match = String(value || "")
    .trim()
    .match(/^bytes[= ](\d+)-(\d+)(?:\/(?:\d+|\*))?$/i);
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start ? { start, end } : null;
}

function validateNoaaRangeResponse({ response, group, body, gribUrl }) {
  const requested = parseHttpByteRange(group?.rangeHeader);
  if (!requested) {
    throw new Error(`Invalid NOAA byte-range request '${group?.rangeHeader || ""}' for ${gribUrl}`);
  }
  const expectedBytes = requested.end - requested.start + 1;
  if (!body || body.length !== expectedBytes) {
    const error = new Error(
      `NOAA byte-range body for ${gribUrl} has ${body?.length || 0} bytes; expected ${expectedBytes} for ${group.rangeHeader}`,
    );
    error.status = 502;
    throw error;
  }
  const contentRange = response?.headers?.get?.("content-range");
  if (contentRange) {
    const returned = parseHttpByteRange(contentRange);
    if (!returned || returned.start !== requested.start || returned.end !== requested.end) {
      const error = new Error(
        `NOAA Content-Range '${contentRange}' does not match requested ${group.rangeHeader} for ${gribUrl}`,
      );
      error.status = 502;
      throw error;
    }
  }
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
      extra: record.extra || "",
      referenceTimeToken: record.dateToken || "",
      rawInventory: record.line || "",
      accumulationWindow: normalizeForecastWindow(record.accumulationWindow),
      averageWindow: normalizeForecastWindow(record.averageWindow),
      statisticalWindow: normalizeStatisticalWindow(record),
      rangeHeader: group.rangeHeader,
      byteLength: record.byteLength,
    })),
  );
}

function normalizeForecastWindow(value) {
  const startHour = Number(value?.startHour);
  const endHour = Number(value?.endHour);
  return Number.isFinite(startHour) && Number.isFinite(endHour) && endHour >= startHour ? { startHour, endHour } : null;
}

function normalizeStatisticalWindow(record) {
  const accumulation = normalizeForecastWindow(record?.accumulationWindow);
  if (accumulation) {
    return { statistic: "accumulation", ...accumulation };
  }
  const average = normalizeForecastWindow(record?.averageWindow);
  if (average) {
    return { statistic: "average", ...average };
  }
  const text = `${record?.forecast || ""} ${record?.extra || ""} ${record?.line || ""}`;
  const match = text.match(/(\d+)\s*-\s*(\d+)\s*(hour|day)\s+(max|min)/i);
  if (!match) {
    return null;
  }
  const scale = match[3].toLowerCase() === "day" ? 24 : 1;
  return {
    statistic: match[4].toLowerCase() === "max" ? "maximum" : "minimum",
    startHour: Number(match[1]) * scale,
    endHour: Number(match[2]) * scale,
  };
}

function buildSelectedGribProvenanceSource(descriptor, metadata) {
  const sha256 = String(metadata?.sha256 || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new Error(`Selected NOAA GRIB provenance is missing a SHA-256 identity for ${descriptor.gribUrl}`);
  }
  const identityPayload = {
    gribUrl: descriptor.gribUrl,
    selectedHash: descriptor.selectedHash,
    selectedSha256: sha256.toLowerCase(),
  };
  const id = `noaa-selected:${crypto.createHash("sha256").update(JSON.stringify(identityPayload)).digest("hex")}`;
  const source = {
    id,
    modelKey: descriptor.modelKey,
    productKey: descriptor.productKey,
    date: String(descriptor.date || ""),
    cycle: String(descriptor.cycle || "").padStart(2, "0"),
    forecastHour: Math.round(Number(descriptor.hour)),
    referenceTime: referenceTimeIsoFromNoaaRun(descriptor.date, descriptor.cycle),
    validTime: validTimeIsoFromNoaaRun(descriptor.date, descriptor.cycle, descriptor.hour),
    gribUrl: descriptor.gribUrl,
    idxUrl: `${descriptor.gribUrl}.idx`,
    selectedHash: descriptor.selectedHash,
    selectedSha256: sha256.toLowerCase(),
    selectedBytes: Number(metadata?.selectedBytes) || null,
    records: descriptor.records.map(normalizeSelectedSourceRecord),
  };
  return source;
}

function commitSelectedGribProvenance(decodeSession, gribPath, source) {
  if (!decodeSession || !gribPath || !source) {
    return null;
  }
  const id = source.id;
  if (!(decodeSession.sourceProvenanceSources instanceof Map)) {
    decodeSession.sourceProvenanceSources = new Map();
  }
  decodeSession.sourceProvenanceSources.set(id, source);
  decodeSession.runSourceProvenanceCatalog?.set(id, source);
  if (!(decodeSession.selectedGribSourceRefs instanceof Map)) {
    decodeSession.selectedGribSourceRefs = new Map();
  }
  decodeSession.selectedGribSourceRefs.set(String(gribPath), id);
  return source;
}

async function registerSelectedGribProvenance(decodeSession, descriptor, gribPath) {
  if (!decodeSession || !descriptor || !gribPath) {
    return null;
  }
  let metadata;
  try {
    metadata = await readSelectedGribMetadata(gribPath);
  } catch {
    const stat = await fs.promises.stat(gribPath);
    metadata = {
      selectedHash: descriptor.selectedHash,
      selectedBytes: stat.size,
      sha256: await hashFileSha256(gribPath),
    };
  }
  const source = buildSelectedGribProvenanceSource(descriptor, metadata);
  return commitSelectedGribProvenance(decodeSession, gribPath, source);
}

function normalizeSelectedSourceRecord(record) {
  const parsedRange = parseHttpByteRange(record?.rangeHeader);
  return {
    record: String(record?.record || "") || null,
    param: String(record?.param || "") || null,
    level: String(record?.level || "") || null,
    forecast: String(record?.forecast || "") || null,
    extra: String(record?.extra || "") || null,
    referenceTimeToken: String(record?.referenceTimeToken || "") || null,
    rawInventory: String(record?.rawInventory || "") || null,
    accumulationWindow: normalizeForecastWindow(record?.accumulationWindow),
    averageWindow: normalizeForecastWindow(record?.averageWindow),
    statisticalWindow:
      record?.statisticalWindow && typeof record.statisticalWindow === "object"
        ? { ...record.statisticalWindow }
        : null,
    byteRange: parsedRange ? { start: parsedRange.start, endInclusive: parsedRange.end } : null,
  };
}

function selectedRecordDecodeCacheKey(record) {
  return JSON.stringify(selectedPrecipRecordIdentity(record));
}

module.exports = {
  buildSelectedGribProvenanceSource,
  CATALOG_VERSION,
  commitSelectedGribProvenance,
  SELECTED_GRIB_CACHE_DIRNAME,
  SELECTED_GRIB_CACHE_METADATA_VERSION,
  SELECTED_GRIB_LOCK_POLL_MS,
  SELECTED_GRIB_LOCK_TIMEOUT_MS,
  fetchRangeChunk,
  hashFileSha256,
  isRetryableRangeFetchError,
  parseHttpByteRange,
  validateNoaaRangeResponse,
  materializeSelectedGrib,
  materializeSelectedGribUncached,
  normalizeStatisticalWindow,
  probeCachedSelectedGribCandidate,
  readCachedSelectedGribPath,
  readSelectedGribMetadata,
  recordRangeFetchRetry,
  registerSelectedGribProvenance,
  selectedGribCacheDescriptor,
  selectedGribGroupByteLength,
  selectedGribLockPayload,
  selectedGribMetadataMatches,
  selectedGribRecordManifest,
  selectedGribRecordsHash,
  selectedGribSharedCacheDir,
  selectedPrecipRecordIdentity,
  selectedRecordDecodeCacheKey,
  waitForCachedSelectedGrib,
  writeCachedSelectedGrib,
  writeSelectedGribRangeFile,
};
