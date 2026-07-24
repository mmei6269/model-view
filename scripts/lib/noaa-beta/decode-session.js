"use strict";

const { incrementDecodeSessionCounter, incrementProfileCounter } = require("./util");
const {
  boundedRunCacheGet,
  boundedRunCacheSet,
  cachePayloadHashFromJson,
  cachePayloadJson,
  createBoundedRunCacheMap,
  roundMs,
} = require("./cache-io");
const { normalizeBaseUrl } = require("./model-config");
const { selectedPrecipRecordIdentity, selectedRecordDecodeCacheKey } = require("./selected-grib");
const { buildRunLocalGridCacheEntry, restoreRunLocalGridCacheEntry } = require("./provenance");
const { decodeRowInterpolationForKey } = require("./wgrib2");

// Grids produced by a successful bulk decode (as opposed to the legacy
// per-record fallback decoder, which also seeds the run-local registry).
// Consumers that reconstruct regrid-bin-derived cache keys for
// registry-served frames must only do so when every served grid came from
// the bulk path the key describes.
const BULK_DECODED_GRIDS = new WeakSet();
const BULK_DECODED_GRID_PAYLOAD_HASHES = new WeakMap();
const DECODED_RECORD_CACHE_OUTCOME = Symbol("noaaDecodedRecordCacheOutcome");

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
  let allBulkDecoded = true;
  const bulkPayloadHashes = new Set();
  for (const [key, record] of records) {
    const rowInterpolation = decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation);
    const values = restoreRunLocalGridCacheEntry(
      boundedRunCacheGet(cache, decodedRecordGridCacheKey({ record, hour, bounds, width, height, rowInterpolation })),
      decodeSession,
    );
    if (!values) {
      return null;
    }
    const bulkPayloadHash = BULK_DECODED_GRID_PAYLOAD_HASHES.get(values);
    if (!BULK_DECODED_GRIDS.has(values) || !bulkPayloadHash) {
      allBulkDecoded = false;
    } else {
      bulkPayloadHashes.add(bulkPayloadHash);
    }
    decoded[key] = values;
  }
  const cacheOutcome = Object.freeze({
    allBulkDecoded,
    bulkPayloadHashes: Object.freeze([...bulkPayloadHashes].sort()),
  });
  Object.defineProperty(decoded, DECODED_RECORD_CACHE_OUTCOME, {
    enumerable: false,
    value: cacheOutcome,
  });
  incrementDecodeSessionCounter(decodeSession, "decodedRecordGridHits");
  if (decodeSession) {
    decodeSession.lastRecordCacheAllBulkDecoded = allBulkDecoded;
  }
  return decoded;
}

function decodedRecordCacheOutcome(decoded) {
  return decoded?.[DECODED_RECORD_CACHE_OUTCOME] || null;
}

function markBulkDecodedGrid(values, payloadHash) {
  if (!(values instanceof Float32Array)) {
    return;
  }
  BULK_DECODED_GRIDS.add(values);
  const hash = String(payloadHash || "");
  if (/^[a-f0-9]{64}$/.test(hash)) {
    BULK_DECODED_GRID_PAYLOAD_HASHES.set(values, hash);
  }
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
  sourceRef = null,
}) {
  const cache = decodeSession?.decodedRecordGrids;
  if (!cache || !record || !(values instanceof Float32Array)) {
    return;
  }
  boundedRunCacheSet(
    cache,
    decodedRecordGridCacheKey({ record, hour, bounds, width, height, rowInterpolation }),
    buildRunLocalGridCacheEntry(values, decodeSession, [{ hour, record }], sourceRef ? [sourceRef] : null),
  );
}

function seedDecodedSelectionRecordCache({
  decoded,
  selection,
  hour = null,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation = true,
  decodeSession,
  sourceRef = null,
}) {
  if (!decoded || typeof decoded !== "object" || !decodeSession) {
    return 0;
  }
  let seeded = 0;
  const seededKeys = new Set();
  for (const [key, record] of Object.entries(selection?.records || {})) {
    const values = decoded[key];
    if (!record || !(values instanceof Float32Array)) {
      continue;
    }
    const rowInterpolation = decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation);
    const cacheKey = decodedRecordGridCacheKey({ record, hour, bounds, width, height, rowInterpolation });
    if (seededKeys.has(cacheKey)) {
      continue;
    }
    writeDecodedRecordGridCache({
      record,
      values,
      hour,
      bounds,
      width,
      height,
      rowInterpolation,
      decodeSession,
      sourceRef,
    });
    seededKeys.add(cacheKey);
    seeded += 1;
  }
  return seeded;
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
  const resolved = typeof cached.then === "function" ? await cached : cached;
  const values = restoreRunLocalGridCacheEntry(resolved, context?.decodeSession);
  if (!(values instanceof Float32Array)) {
    return null;
  }
  incrementProfileCounter(context.profile, counterKey);
  return values;
}

function registerSourceGrid({ family, payload, context, values, provenanceTerms = [] }) {
  const cache = context?.decodeSession?.sourceGridRegistry;
  if (!cache || !family || !payload || !(values instanceof Float32Array)) {
    return;
  }
  boundedRunCacheSet(
    cache,
    sourceGridRegistryKey(family, payload),
    buildRunLocalGridCacheEntry(values, context?.decodeSession, provenanceTerms),
  );
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
      const values = restoreRunLocalGridCacheEntry(
        boundedRunCacheGet(cache, profileGridRegistryKey({ record, hour, context })),
        context?.decodeSession,
      );
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
    boundedRunCacheSet(
      cache,
      profileGridRegistryKey({ record, hour, context }),
      buildRunLocalGridCacheEntry(values, context?.decodeSession, [{ hour, record }]),
    );
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
    selectedGribSourceRefs: new Map(),
    sourceProvenanceSources: new Map(),
    runSourceProvenanceCatalog: null,
    temporalProvenanceDerivations: new Map(),
    counters: {
      selectedGribPromiseHits: 0,
      decodedGridPromiseHits: 0,
      decodedRecordGridHits: 0,
      rowMapHits: 0,
      rowMapMisses: 0,
    },
  };
}

function disposeIsolatedFrameDecodeSession(decodeSession) {
  if (!decodeSession || decodeSession.runCache) {
    return false;
  }
  for (const key of [
    "selectedGribPromises",
    "decodedGridPromises",
    "decodedRecordGrids",
    "sourceGridRegistry",
    "profileGridRegistry",
    "profileDecodeBatches",
    "rowMaps",
    "parsedRecords",
    "selectedPlans",
    "regridBinCacheContexts",
    "selectedGribSourceRefs",
    "sourceProvenanceSources",
    "temporalProvenanceDerivations",
  ]) {
    decodeSession[key]?.clear?.();
  }
  return true;
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
  decodeSession.runSourceProvenanceCatalog = runCache.sourceProvenanceCatalog;
  return runCache;
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
    selectedGribLockDeclines: Number(profile.selectedGribLockDeclines) || 0,
    selectedGribPromiseHits: Number(profile.selectedGribPromiseHits) || 0,
    selectedGribFastPackProbes: Number(profile.selectedGribFastPackProbes) || 0,
    selectedGribFastPackMetadataHits: Number(profile.selectedGribFastPackMetadataHits) || 0,
    selectedGribHashBypasses: Number(profile.selectedGribHashBypasses) || 0,
    selectedGribHashBypassBytes: Number(profile.selectedGribHashBypassBytes) || 0,
    selectedGribFastPackFallbacks: Number(profile.selectedGribFastPackFallbacks) || 0,
    selectedGribVerifyHashes: Number(profile.selectedGribVerifyHashes) || 0,
    selectedGribVerifyHashBytes: Number(profile.selectedGribVerifyHashBytes) || 0,
    regridBinCacheHits: Number(profile.regridBinCacheHits) || 0,
    regridBinCacheMisses: Number(profile.regridBinCacheMisses) || 0,
    regridBinCacheWriteFailures: Number(profile.regridBinCacheWriteFailures) || 0,
    regridBinCacheCorruptions: Number(profile.regridBinCacheCorruptions) || 0,
    regridBinSparseHits: Number(profile.regridBinSparseHits) || 0,
    regridBinSparseDeclines: Number(profile.regridBinSparseDeclines) || 0,
    regridBinPackEntriesRead: Number(profile.regridBinPackEntriesRead) || 0,
    regridBinPackEntriesSkipped: Number(profile.regridBinPackEntriesSkipped) || 0,
    regridBinPackBytesRead: Number(profile.regridBinPackBytesRead) || 0,
    regridBinPackBytesSkipped: Number(profile.regridBinPackBytesSkipped) || 0,
    derivedGridCacheHits: Number(profile.derivedGridCacheHits) || 0,
    derivedGridCacheMisses: Number(profile.derivedGridCacheMisses) || 0,
    supplementalDerivedGridCacheHits: Number(profile.supplementalDerivedGridCacheHits) || 0,
    supplementalDerivedGridCacheMisses: Number(profile.supplementalDerivedGridCacheMisses) || 0,
    bulkDecodeFallbacks: Number(profile.bulkDecodeFallbacks) || 0,
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
    freezingRainLiquidSourceRefs: Number(profile.freezingRainLiquidSourceRefs) || 0,
    freezingRainLiquidSourceCount: Number(profile.freezingRainLiquidSourceCount) || 0,
    freezingRainLiquidGridCacheHits: Number(profile.freezingRainLiquidGridCacheHits) || 0,
    freezingRainLiquidGridCacheMisses: Number(profile.freezingRainLiquidGridCacheMisses) || 0,
    freezingRainLiquidChunkGaps: Number(profile.freezingRainLiquidChunkGaps) || 0,
    snowfallIntervalCount: Number(profile.snowfallIntervalCount) || 0,
    snowfallIntervalActiveCount: Number(profile.snowfallIntervalActiveCount) || 0,
    snowfallIntervalActiveCells: Number(profile.snowfallIntervalActiveCells) || 0,
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
    dcape21LevelCamPrototypeStats: profile.dcape21LevelCamPrototypeStats || null,
    effectiveDiagnosticsCandidateCount: Number(profile.effectiveDiagnosticsCandidateCount) || 0,
    compressPoolJobs: Number(profile.compressPoolJobs) || 0,
    compressPoolFallbacks: Number(profile.compressPoolFallbacks) || 0,
    compressOwnedInputJobs: Number(profile.compressOwnedInputJobs) || 0,
    compressOwnedInputBytes: Number(profile.compressOwnedInputBytes) || 0,
    compressOwnedInputFallbacks: Number(profile.compressOwnedInputFallbacks) || 0,
    compressOwnedInputRebuilds: Number(profile.compressOwnedInputRebuilds) || 0,
    compressSharedInputJobs: Number(profile.compressSharedInputJobs) || 0,
    compressSharedInputBytes: Number(profile.compressSharedInputBytes) || 0,
    compressSharedInputViewBytes: Number(profile.compressSharedInputViewBytes) || 0,
    compressSharedInputBackingBytes: Number(profile.compressSharedInputBackingBytes) || 0,
    compressSharedInputMaxBytes: Number(profile.compressSharedInputMaxBytes) || 0,
    compressSharedInputUniqueOwners: Number(profile.compressSharedInputUniqueOwners) || 0,
    compressSharedInputFallbacks: Number(profile.compressSharedInputFallbacks) || 0,
    compressTransportRetainedLiveBytes: Number(profile.compressTransportRetainedLiveBytes) || 0,
    compressTransportPeakLiveBytes: Number(profile.compressTransportPeakLiveBytes) || 0,
    indexedPngJobs: Number(profile.indexedPngJobs) || 0,
    indexedPngRawBytes: Number(profile.indexedPngRawBytes) || 0,
    indexedPngRgbaRawBytesAvoided: Number(profile.indexedPngRgbaRawBytesAvoided) || 0,
    artifactEncodeCheckpoints: Number(profile.artifactEncodeCheckpoints) || 0,
    artifactEncodePeakActive: Number(profile.artifactEncodePeakActive) || 0,
    artifactEncodePeakQueued: Number(profile.artifactEncodePeakQueued) || 0,
    artifactEncodeSubmitted: Number(profile.artifactEncodeSubmitted) || 0,
    derivedParallelChunks: Number(profile.derivedParallelChunks) || 0,
    derivedParallelWorkers: Number(profile.derivedParallelWorkers) || 0,
    hoverQuantization: profile.hoverQuantization || null,
    hoverArena: profile.hoverArena || null,
    hoverArenaFallbackReason: profile.hoverArenaFallbackReason || null,
    sourceProvenance: profile.sourceProvenance || null,
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
    sourceProvenanceCatalog: new Map(),
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
    forecastHourCompletionIdentity:
      context?.forecastHourCompletionIdentity || context?.forecastHourRosterIdentity || "",
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
  disposeIsolatedFrameDecodeSession,
  attachRunLocalDecodeSession,
  BULK_DECODED_GRIDS,
  BULK_DECODED_GRID_PAYLOAD_HASHES,
  decodedRecordCacheOutcome,
  decodedRecordGridCacheKey,
  profileGridRegistryKey,
  markBulkDecodedGrid,
  readDecodedRecordsForKeyedRecords,
  readDecodedSelectionFromRecordCache,
  readRegisteredProfileGrids,
  readRegisteredSourceGrid,
  registerProfileGrids,
  registerSourceGrid,
  sourceGridRegistryKey,
  seedDecodedSelectionRecordCache,
  writeDecodedRecordGridCache,
};
