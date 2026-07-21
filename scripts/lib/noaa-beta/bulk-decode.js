"use strict";

const fs = require("fs");
const path = require("path");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { clampInt, incrementDecodeSessionCounter, incrementProfileCounter } = require("./util");
const { decodeBinaryGridFileSlice } = require("./grid-ops");
const {
  boundedRunCacheGet,
  boundedRunCacheSet,
  cacheMetadataPayloadMatches,
  cacheMetadataWithPayload,
  cachePayloadDescriptor,
  createBoundedRunCacheMap,
  mapWithConcurrency,
  recordProfileStage,
} = require("./cache-io");
const { readSelectedGribMetadata, selectedRecordDecodeCacheKey } = require("./selected-grib");
const {
  buildNoaaRegridArgs,
  decodeRecordToGrid,
  decodeRowInterpolationForKey,
  decodeWindPairToGrids,
  getWgrib2Identity,
  runCommand,
} = require("./wgrib2");
const {
  BULK_DECODED_GRIDS,
  readDecodedSelectionFromRecordCache,
  writeDecodedRecordGridCache,
} = require("./decode-session");

const REGRIDDED_BIN_CACHE_VERSION = "regridded-bin-v1";

const REGRIDDED_BIN_EXPORT_ARGS = Object.freeze(["-s", "-order", "we:sn", "-no_header", "-bin"]);

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
      // The legacy per-record path is several times slower; surface every silent downgrade.
      incrementProfileCounter(profile, "bulkDecodeFallbacks");
      console.warn(
        `[noaa-beta] bulk decode failed for ${gribPath}; falling back to legacy per-record decode: ${String(error?.message || error)}`,
      );
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

async function resolveRegriddedBinCacheContext({ gribPath, wgrib2Path, regridArgsSignature, decodeSession = null }) {
  // The context is fully determined by the selected GRIB path (whose cached
  // sidecar bytes are immutable once written), the regrid signature, and the
  // wgrib2 identity, so frame sessions memoize it to avoid re-reading and
  // re-hashing the sidecar for every decode consumer of the same hour.
  const memo = decodeSession?.regridBinCacheContexts;
  const memoKey = memo ? regriddedBinMemoKey(gribPath, regridArgsSignature) : null;
  if (memo && memo.has(memoKey)) {
    return memo.get(memoKey);
  }
  const context = await resolveRegriddedBinCacheContextUncached({ gribPath, wgrib2Path, regridArgsSignature });
  if (memo) {
    memo.set(memoKey, context);
  }
  return context;
}

function regriddedBinMemoKey(gribPath, regridArgsSignature) {
  return `${gribPath}\u0000${(Array.isArray(regridArgsSignature) ? regridArgsSignature : []).join("\u0000")}`;
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

// Validated regrid-bin metadata (which embeds the full wgrib2 inventory
// text) is content-addressed by the cache payload hash and immutable once
// written, so the JSON parse and inventory parse are shared across every
// frame consumer of the same selected GRIB in this process. The bin stat
// stays on every read to detect deletion by cache pruning.
const REGRID_BIN_METADATA_CACHE = createBoundedRunCacheMap(16);

async function readRegriddedBinCache(cacheContext) {
  if (!cacheContext) {
    return null;
  }
  try {
    const memo = boundedRunCacheGet(REGRID_BIN_METADATA_CACHE, cacheContext.payloadHash);
    if (memo) {
      const stat = await fs.promises.stat(cacheContext.binPath);
      if (stat.size !== memo.binBytes) {
        return null;
      }
      return memo;
    }
    const metadata = JSON.parse(await fs.promises.readFile(cacheContext.metadataPath, "utf8"));
    if (!cacheMetadataPayloadMatches(metadata, cacheContext.payload, cacheContext.payloadHash)) {
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
    const entry = { inventoryText, binBytes, inventory: null };
    boundedRunCacheSet(REGRID_BIN_METADATA_CACHE, cacheContext.payloadHash, entry);
    return entry;
  } catch {
    return null;
  }
}

async function writeRegriddedBinCache(cacheContext, { binSourcePath, inventoryText, binBytes, profile = null }) {
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
  } catch (error) {
    // A failed persist silently forces wgrib2 regrid+export on every warm rebuild.
    incrementProfileCounter(profile, "regridBinCacheWriteFailures");
    console.warn(
      `[noaa-beta] regridded-bin cache write failed for ${cacheContext.binPath}: ${String(error?.message || error)}`,
    );
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    await fs.promises.rm(`${tmp}.json`, { force: true }).catch(() => {});
  }
}

// Single construction point for the bulk decoder's regrid-bin cache
// context (the signature slice and the context resolution must never
// diverge between the decode path and hash reconstruction).
function resolveBulkRegridBinCacheContext({
  gribPath,
  wgrib2Path,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation = true,
  decodeSession = null,
}) {
  const regridArgsSignature = buildNoaaRegridArgs({
    gribPath: "",
    gridPath: "",
    bounds,
    width,
    height,
    useCategoricalPrecipTypeInterpolation: Boolean(categoricalPrecipTypeInterpolation),
  }).slice(1, -1);
  return resolveRegriddedBinCacheContext({ gribPath, wgrib2Path, regridArgsSignature, decodeSession });
}

// Rebuilds the regrid-bin payload hash the bulk decoder would have used
// for this frame's main decode. Consumed by the renderer when the decode
// was served entirely from bulk-seeded run-local registry entries, so the
// derived-grid cache can still engage on warm in-process paths.
async function resolveMainDecodeRegridPayloadHash({
  gribPath,
  wgrib2Path,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation = true,
  decodeSession = null,
}) {
  const cacheContext = await resolveBulkRegridBinCacheContext({
    gribPath,
    wgrib2Path,
    bounds,
    width,
    height,
    categoricalPrecipTypeInterpolation,
    decodeSession,
  });
  return cacheContext?.payloadHash || null;
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
  const cacheContext = await resolveBulkRegridBinCacheContext({
    gribPath,
    wgrib2Path,
    bounds,
    width,
    height,
    categoricalPrecipTypeInterpolation,
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
  // Warm hits share one parsed inventory per cached bin; the per-frame
  // record index below builds fresh queue arrays from these shared,
  // never-mutated row objects, so cross-frame sharing is safe.
  let inventory = cached?.inventory;
  if (!inventory) {
    inventory = parseWgribSimpleInventory(inventoryText);
    if (cached) {
      cached.inventory = inventory;
    }
  }
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
        BULK_DECODED_GRIDS.add(values);
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
          sourceRef: decodeSession?.selectedGribSourceRefs?.get(String(gribPath)) || null,
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
      profile,
    }).catch(() => {});
  }
  // Recorded only on successful bulk completion so consumers (the
  // derived-grid cache) never key on a hash whose grids actually came from
  // the legacy fallback decoder.
  if (Array.isArray(decodeSession?.collectRegridBinPayloadHashes)) {
    decodeSession.collectRegridBinPayloadHashes.push(cacheContext?.payloadHash || null);
  }
  return decoded;
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
  }
  return { byRecord, exact };
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
  // Exact match only: a param/level fallback would silently bind a record
  // from a different forecast window. A miss must surface through the
  // caller's required-key check as a throw (or an omitted optional key).
  return takeFirstUnusedRecord(index.exact.get(bulkDecodedRecordExactKey(sourceRecord)), usedRecordNumbers) || null;
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
          sourceRef: decodeSession?.selectedGribSourceRefs?.get(String(gribPath)) || null,
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
      sourceRef: decodeSession?.selectedGribSourceRefs?.get(String(gribPath)) || null,
    });
  });
  recordProfileStage(profile, "legacyDecodeMs", stageStartedAt);
  return decoded;
}

module.exports = {
  REGRIDDED_BIN_CACHE_VERSION,
  REGRIDDED_BIN_EXPORT_ARGS,
  buildBulkDecodedRecordIndex,
  bulkDecodedRecordExactKey,
  bulkDecodedRecordOrdinal,
  bulkDecodedRecordParamLevelKey,
  decodeSelectedRecordsBulk,
  decodeSelectedRecordsLegacy,
  decodeSelectedRecordsToGrids,
  decodedSelectionCacheKey,
  parseWgribSimpleInventory,
  resolveMainDecodeRegridPayloadHash,
  readRegriddedBinCache,
  regriddedBinMemoKey,
  requiredDecodeKeys,
  resolveRegriddedBinCacheContext,
  resolveRegriddedBinCacheContextUncached,
  takeBulkDecodedRecord,
  takeBulkDecodedRecordBySelectedPlan,
  takeFirstUnusedRecord,
  writeRegriddedBinCache,
};
