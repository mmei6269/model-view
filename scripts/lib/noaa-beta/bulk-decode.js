"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { clampInt, incrementDecodeSessionCounter, incrementProfileCounter } = require("./util");
const { decodeBinaryGridFileSlice, readPackedFloat32GridFileSlice } = require("./grid-ops");
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
  decodedRecordCacheOutcome,
  markBulkDecodedGrid,
  readDecodedSelectionFromRecordCache,
  writeDecodedRecordGridCache,
} = require("./decode-session");
const { applyDerivedDecodePlan } = require("./derived-decode-plan");

const REGRIDDED_BIN_CACHE_VERSION = "mercator-grid-pack-v3-entry-crc32";

const PREVIOUS_REGRIDDED_BIN_CACHE_VERSION = "mercator-grid-pack-v2";

const LEGACY_REGRIDDED_BIN_CACHE_VERSION = "regridded-bin-v1";

const REGRIDDED_BIN_EXPORT_ARGS = Object.freeze(["-s", "-order", "we:sn", "-no_header", "-bin"]);

const DECODED_GRID_OUTCOME = Symbol("noaaDecodedGridOutcome");

// A required-pack token is useful only inside this module. Keeping its
// validated context in a WeakMap prevents callers from forging a cache hit or
// swapping paths/payloads after the probe.
const PROBED_MAIN_DECODE_WARM_PACKS = new WeakMap();

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
  sparseReadPlan = null,
  profile = null,
  decodeSession = null,
  requiredRegridPack = null,
}) {
  const requiredPackDetails = requiredRegridPackDetails(requiredRegridPack);
  if (requiredPackDetails) {
    assertRequiredRegridPackMatchesDecode(requiredPackDetails, {
      gribPath,
      wgrib2Path,
      selection,
      bounds,
      width,
      height,
      categoricalPrecipTypeInterpolation,
    });
  }
  const cacheKey = decodeSession
    ? decodedSelectionCacheKey({
        gribPath,
        selection,
        bounds,
        width,
        height,
        categoricalPrecipTypeInterpolation,
        sparseReadPlan,
        requiredRegridPack,
      })
    : null;
  const existing = cacheKey ? decodeSession.decodedGridPromises.get(cacheKey) : null;
  if (existing) {
    incrementDecodeSessionCounter(decodeSession, "decodedGridPromiseHits");
    return existing;
  }
  // Required-pack decoding is an integrity policy, not merely a cache hint.
  // Do not let a run-local record hit bypass validation/consumption of the
  // exact probed pack.
  const recordCached = requiredPackDetails
    ? null
    : readDecodedSelectionFromRecordCache({
        selection,
        hour,
        bounds,
        width,
        height,
        categoricalPrecipTypeInterpolation,
        decodeSession,
      });
  if (recordCached) {
    const recordCacheOutcome = decodedRecordCacheOutcome(recordCached);
    const uniqueBulkPayloadHash =
      recordCacheOutcome?.allBulkDecoded === true && recordCacheOutcome.bulkPayloadHashes.length === 1
        ? recordCacheOutcome.bulkPayloadHashes[0]
        : null;
    return attachDecodedGridOutcome(recordCached, {
      source: "record-cache",
      payloadHash: uniqueBulkPayloadHash,
      sparseApplied: false,
      allBulkDecoded: recordCacheOutcome?.allBulkDecoded === true,
    });
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
        sparseReadPlan,
        profile,
        decodeSession,
        requiredRegridPack,
      });
    } catch (error) {
      if (requiredPackDetails || process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE === "1") {
        throw error;
      }
      // The legacy per-record path is several times slower; surface every silent downgrade.
      incrementProfileCounter(profile, "bulkDecodeFallbacks");
      console.warn(
        `[noaa-beta] bulk decode failed for ${gribPath}; falling back to legacy per-record decode: ${String(error?.message || error)}`,
      );
      const decoded = await decodeSelectedRecordsLegacy({
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
      return attachDecodedGridOutcome(decoded, {
        source: "legacy-fallback",
        payloadHash: null,
        sparseApplied: false,
      });
    }
  })();
  if (cacheKey) {
    decodeSession.decodedGridPromises.set(cacheKey, promise);
  }
  return promise;
}

function decodedSelectionCacheKey({
  gribPath,
  selection,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation,
  sparseReadPlan = null,
  requiredRegridPack = null,
}) {
  const requiredPackDetails = requiredRegridPackDetails(requiredRegridPack);
  return JSON.stringify({
    gribPath,
    bounds,
    width,
    height,
    categoricalPrecipTypeInterpolation: Boolean(categoricalPrecipTypeInterpolation),
    sparseReadPlan: sparseReadPlanCacheIdentity(sparseReadPlan),
    ...(requiredPackDetails
      ? {
          regridPackPolicy: {
            policy: "required",
            payloadHash: requiredPackDetails.cacheContext.payloadHash,
            binIdentity: requiredPackDetails.cached.binIdentity,
            metadataIdentity: requiredPackDetails.cached.metadataIdentity,
          },
        }
      : {}),
    records: Object.fromEntries(
      Object.entries(selection?.records || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, record]) => [key, selectedRecordDecodeCacheKey(record)]),
    ),
  });
}

function sparseReadPlanCacheIdentity(plan) {
  if (!plan) {
    return null;
  }
  return {
    schemaVersion: String(plan.schemaVersion || ""),
    identity: String(plan.identity || ""),
    valid: plan.valid === true,
    expectedProfileGridNames: Array.isArray(plan.expectedProfileGridNames) ? plan.expectedProfileGridNames : [],
    restoredGridNames: Array.isArray(plan.restoredGridNames) ? plan.restoredGridNames : [],
    omittedDecodeKeys: Array.isArray(plan.omittedDecodeKeys) ? plan.omittedDecodeKeys : [],
    retainedDecodeKeys: Array.isArray(plan.retainedDecodeKeys) ? plan.retainedDecodeKeys : [],
    regridBinPayloadHash: String(plan.regridBinPayloadHash || ""),
    cellCount: Number(plan.cellCount) || null,
  };
}

function attachDecodedGridOutcome(decoded, outcome) {
  if (!decoded || typeof decoded !== "object") {
    return decoded;
  }
  Object.defineProperty(decoded, DECODED_GRID_OUTCOME, {
    configurable: true,
    enumerable: false,
    value: Object.freeze({ ...outcome }),
  });
  return decoded;
}

function decodedGridOutcome(decoded) {
  return decoded?.[DECODED_GRID_OUTCOME] || null;
}

async function resolveRegriddedBinCacheContext({
  gribPath,
  wgrib2Path,
  regridArgsSignature,
  gridMapping = [],
  width = null,
  height = null,
  decodeSession = null,
}) {
  // The context is fully determined by the selected GRIB path (whose cached
  // sidecar bytes are immutable once written), the wgrib2 regrid signature,
  // and the exact record/interpolation mapping. The latter is essential:
  // identical selected bytes can legitimately be consumed with nearest or
  // bilinear Mercator-row interpolation.
  const normalizedGridMapping = normalizeMercatorGridMapping(gridMapping);
  const memo = decodeSession?.regridBinCacheContexts;
  const memoKey = memo
    ? regriddedBinMemoKey(gribPath, regridArgsSignature, normalizedGridMapping, width, height)
    : null;
  if (memo && memo.has(memoKey)) {
    return memo.get(memoKey);
  }
  const context = await resolveRegriddedBinCacheContextUncached({
    gribPath,
    wgrib2Path,
    regridArgsSignature,
    gridMapping: normalizedGridMapping,
    width,
    height,
  });
  if (memo) {
    memo.set(memoKey, context);
  }
  return context;
}

function regriddedBinMemoKey(gribPath, regridArgsSignature, gridMapping = [], width = null, height = null) {
  // Preserve the exported two-argument helper contract used by provenance
  // tooling/tests. Internal indexed-pack callers always pass the mapping and shape, so
  // they use the collision-safe structured identity below.
  if (arguments.length <= 2) {
    return `${gribPath}\u0000${(Array.isArray(regridArgsSignature) ? regridArgsSignature : []).join("\u0000")}`;
  }
  return JSON.stringify({
    gribPath,
    regridArgsSignature: Array.isArray(regridArgsSignature) ? regridArgsSignature : [],
    gridMapping: normalizeMercatorGridMapping(gridMapping),
    width: Number(width) || null,
    height: Number(height) || null,
  });
}

async function resolveRegriddedBinCacheContextUncached({
  gribPath,
  wgrib2Path,
  regridArgsSignature,
  gridMapping = [],
  width = null,
  height = null,
}) {
  let selectedMetadata;
  try {
    selectedMetadata = await readSelectedGribMetadata(gribPath);
  } catch {
    return null;
  }
  return resolveRegriddedBinCacheContextFromSelectedMetadata({
    gribPath,
    selectedMetadata,
    wgrib2Path,
    regridArgsSignature,
    gridMapping,
    width,
    height,
  });
}

// Build the content-addressed Mercator-pack identity from sidecar metadata
// already captured by the selected-GRIB publication probe. Unlike the
// historical resolver, this helper never reopens that sidecar.
async function resolveRegriddedBinCacheContextFromSelectedMetadata({
  gribPath,
  selectedMetadata,
  wgrib2Path,
  regridArgsSignature,
  gridMapping = [],
  width = null,
  height = null,
}) {
  const selectedSha256 = String(selectedMetadata?.sha256 || "");
  const selectedHash = String(selectedMetadata?.selectedHash || "");
  if (!selectedSha256 || !selectedHash) {
    return null;
  }
  const wgrib2Identity = await getWgrib2Identity(wgrib2Path);
  if (!wgrib2Identity) {
    return null;
  }
  const resolvedWidth = Math.round(Number(width));
  const resolvedHeight = Math.round(Number(height));
  const fieldBytes = resolvedWidth * resolvedHeight * Float32Array.BYTES_PER_ELEMENT;
  if (resolvedWidth <= 0 || resolvedHeight <= 0 || !Number.isSafeInteger(fieldBytes) || fieldBytes <= 0) {
    return null;
  }
  const normalizedGridMapping = normalizeMercatorGridMapping(gridMapping);
  const payload = {
    kind: REGRIDDED_BIN_CACHE_VERSION,
    selectedSha256,
    selectedHash,
    regridArgs: regridArgsSignature,
    exportArgs: REGRIDDED_BIN_EXPORT_ARGS,
    wgrib2: wgrib2Identity,
    gridShape: { width: resolvedWidth, height: resolvedHeight, fieldBytes },
    byteOrder: os.endianness(),
    gridMapping: normalizedGridMapping,
  };
  const descriptor = cachePayloadDescriptor(payload);
  const pathToken = descriptor.payloadHash.slice(0, 16);
  const previousPayload = { ...payload, kind: PREVIOUS_REGRIDDED_BIN_CACHE_VERSION };
  const previousPathToken = cachePayloadDescriptor(previousPayload).payloadHash.slice(0, 16);
  const legacyPayload = {
    kind: LEGACY_REGRIDDED_BIN_CACHE_VERSION,
    selectedSha256,
    selectedHash,
    regridArgs: regridArgsSignature,
    exportArgs: REGRIDDED_BIN_EXPORT_ARGS,
    wgrib2: wgrib2Identity,
  };
  const legacyPathToken = cachePayloadDescriptor(legacyPayload).payloadHash.slice(0, 16);
  return {
    payload,
    payloadHash: descriptor.payloadHash,
    binPath: `${gribPath}.mercator-${pathToken}.bin`,
    metadataPath: `${gribPath}.mercator-${pathToken}.json`,
    previousBinPath: `${gribPath}.mercator-${previousPathToken}.bin`,
    previousMetadataPath: `${gribPath}.mercator-${previousPathToken}.json`,
    legacyBinPath: `${gribPath}.regrid-${legacyPathToken}.bin`,
    legacyMetadataPath: `${gribPath}.regrid-${legacyPathToken}.json`,
  };
}

function requiredRegridPackDetails(requiredRegridPack) {
  if (requiredRegridPack === null || requiredRegridPack === undefined) {
    return null;
  }
  const details =
    requiredRegridPack && typeof requiredRegridPack === "object"
      ? PROBED_MAIN_DECODE_WARM_PACKS.get(requiredRegridPack)
      : null;
  if (!details) {
    const error = new Error("Required NOAA Mercator grid pack was not produced by the warm-pack probe.");
    error.code = "NOAA_REGRID_PACK_REQUIRED_INVALID";
    throw error;
  }
  return details;
}

function requiredRegridPackError(message, code = "NOAA_REGRID_PACK_REQUIRED_MISS") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mercatorGridPackEntryKey(record, rowInterpolation) {
  return JSON.stringify({
    record: selectedRecordDecodeCacheKey(record),
    rowInterpolation: String(rowInterpolation || "bilinear"),
  });
}

function mercatorGridMappingForSelection(selection, categoricalPrecipTypeInterpolation = true) {
  return normalizeMercatorGridMapping(
    Object.entries(selection?.records || {})
      .filter(([, record]) => Boolean(record))
      .map(([key, record]) =>
        mercatorGridPackEntryKey(record, decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation)),
      ),
  );
}

function normalizeMercatorGridMapping(gridMapping) {
  return Array.from(
    new Set((Array.isArray(gridMapping) ? gridMapping : []).map((value) => String(value || "")).filter(Boolean)),
  ).sort();
}

// Validated pack metadata is content-addressed and immutable once written.
// The bin stat stays on every read to detect deletion/truncation by pruning
// or an interrupted external cache copy.
const REGRID_BIN_METADATA_CACHE = createBoundedRunCacheMap(16);
const REGRID_BIN_CORRUPT_PAYLOADS = createBoundedRunCacheMap(16);

function regridPackFileIdentity(stat) {
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

function regridPackFileIdentityMatches(left, right) {
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

async function statRegridPackFileIdentity(filePath) {
  return regridPackFileIdentity(await fs.promises.stat(filePath, { bigint: true }));
}

async function readRegriddedBinCache(cacheContext) {
  if (!cacheContext) {
    return null;
  }
  try {
    if (boundedRunCacheGet(REGRID_BIN_CORRUPT_PAYLOADS, cacheContext.payloadHash)) {
      return null;
    }
    const memo = boundedRunCacheGet(REGRID_BIN_METADATA_CACHE, cacheContext.payloadHash);
    if (memo) {
      const [binIdentity, metadataIdentity] = await Promise.all([
        statRegridPackFileIdentity(cacheContext.binPath),
        statRegridPackFileIdentity(cacheContext.metadataPath),
      ]);
      if (Number(binIdentity.size) !== memo.binBytes) {
        return null;
      }
      if (regridPackFileIdentityMatches(metadataIdentity, memo.metadataIdentity)) {
        return { ...memo, binIdentity };
      }
      // A content-addressed sidecar is normally immutable. If another
      // process republished this payload, discard the old CRC/layout snapshot
      // and validate the current generation from bytes below.
      REGRID_BIN_METADATA_CACHE.delete(cacheContext.payloadHash);
    }
    const metadataIdentityBefore = await statRegridPackFileIdentity(cacheContext.metadataPath);
    const metadata = JSON.parse(await fs.promises.readFile(cacheContext.metadataPath, "utf8"));
    const metadataIdentity = await statRegridPackFileIdentity(cacheContext.metadataPath);
    if (!regridPackFileIdentityMatches(metadataIdentityBefore, metadataIdentity)) {
      return null;
    }
    if (!cacheMetadataPayloadMatches(metadata, cacheContext.payload, cacheContext.payloadHash)) {
      return null;
    }
    const entry = validatedMercatorGridPackMetadata(metadata, cacheContext.payload);
    if (!entry) {
      return null;
    }
    const binIdentity = await statRegridPackFileIdentity(cacheContext.binPath);
    if (Number(binIdentity.size) !== entry.binBytes) {
      return null;
    }
    const memoEntry = { ...entry, metadataIdentity };
    boundedRunCacheSet(REGRID_BIN_METADATA_CACHE, cacheContext.payloadHash, memoEntry);
    return { ...memoEntry, binIdentity };
  } catch {
    return null;
  }
}

function validatedMercatorGridPackMetadata(metadata, payload) {
  const fieldBytes = Number(payload?.gridShape?.fieldBytes);
  const expectedKeys = normalizeMercatorGridMapping(payload?.gridMapping);
  const binBytes = Number(metadata?.binBytes);
  if (!Number.isSafeInteger(fieldBytes) || fieldBytes <= 0 || !Number.isSafeInteger(binBytes) || binBytes < 0) {
    return null;
  }
  if (Number(metadata?.fieldBytes) !== fieldBytes || !Array.isArray(metadata?.entries)) {
    return null;
  }
  const missingEntryKeys = normalizeMercatorGridMapping(metadata?.missingEntryKeys);
  const missingSet = new Set(missingEntryKeys);
  const entries = [];
  const entryByKey = new Map();
  for (const raw of metadata.entries) {
    const key = String(raw?.key || "");
    const byteOffset = Number(raw?.byteOffset);
    const crc32 = String(raw?.crc32 || "");
    if (
      !key ||
      missingSet.has(key) ||
      entryByKey.has(key) ||
      !/^[a-f0-9]{8}$/.test(crc32) ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0 ||
      byteOffset % fieldBytes !== 0
    ) {
      return null;
    }
    const entry = { key, byteOffset, crc32 };
    entries.push(entry);
    entryByKey.set(key, entry);
  }
  entries.sort((left, right) => left.byteOffset - right.byteOffset);
  if (entries.some((entry, index) => entry.byteOffset !== index * fieldBytes)) {
    return null;
  }
  if (binBytes !== entries.length * fieldBytes) {
    return null;
  }
  const representedKeys = normalizeMercatorGridMapping([...entryByKey.keys(), ...missingEntryKeys]);
  if (JSON.stringify(representedKeys) !== JSON.stringify(expectedKeys)) {
    return null;
  }
  if (
    !/^[a-f0-9]{64}$/.test(String(metadata?.entryManifestSha256 || "")) ||
    metadata.entryManifestSha256 !==
      mercatorGridPackManifestSha256({
        fieldBytes,
        binBytes,
        entries,
        missingEntryKeys,
      })
  ) {
    return null;
  }
  return { binBytes, fieldBytes, entries, entryByKey, missingEntryKeys: missingSet };
}

async function writeRegriddedBinCache(cacheContext, { gridEntries = [], missingEntryKeys = [], profile = null } = {}) {
  const tmp = `${cacheContext.binPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let handle = null;
  try {
    const fieldBytes = Number(cacheContext?.payload?.gridShape?.fieldBytes);
    const expectedKeys = normalizeMercatorGridMapping(cacheContext?.payload?.gridMapping);
    const missingKeys = normalizeMercatorGridMapping(missingEntryKeys);
    const valuesByKey = new Map();
    for (const entry of Array.isArray(gridEntries) ? gridEntries : []) {
      const key = String(entry?.key || "");
      const values = entry?.values;
      if (!key || valuesByKey.has(key) || !(values instanceof Float32Array) || values.byteLength !== fieldBytes) {
        throw new Error("invalid or duplicate Mercator grid-pack entry");
      }
      valuesByKey.set(key, values);
    }
    if (missingKeys.some((key) => valuesByKey.has(key))) {
      throw new Error("Mercator grid-pack entries and missing keys must be disjoint");
    }
    const representedKeys = normalizeMercatorGridMapping([...valuesByKey.keys(), ...missingKeys]);
    if (JSON.stringify(representedKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error("Mercator grid-pack entries do not cover the cache mapping");
    }
    const orderedEntries = [...valuesByKey.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const metadataEntries = [];
    handle = await fs.promises.open(tmp, "wx");
    let byteOffset = 0;
    for (const [key, values] of orderedEntries) {
      const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
      let written = 0;
      while (written < body.byteLength) {
        const result = await handle.write(body, written, body.byteLength - written, byteOffset + written);
        if (!result || result.bytesWritten <= 0) {
          throw new Error(`Mercator grid-pack write stopped after ${written}/${body.byteLength} bytes`);
        }
        written += result.bytesWritten;
      }
      metadataEntries.push({ key, byteOffset, crc32: crc32Bytes(body) });
      byteOffset += body.byteLength;
    }
    await handle.close();
    handle = null;
    const metadata = cacheMetadataWithPayload(cacheContext.payload, {
      fieldBytes,
      binBytes: byteOffset,
      entries: metadataEntries,
      missingEntryKeys: missingKeys,
      entryManifestSha256: mercatorGridPackManifestSha256({
        fieldBytes,
        binBytes: byteOffset,
        entries: metadataEntries,
        missingEntryKeys: missingKeys,
      }),
    });
    await fs.promises.writeFile(`${tmp}.json`, JSON.stringify(metadata));
    await fs.promises.rename(tmp, cacheContext.binPath);
    await fs.promises.rename(`${tmp}.json`, cacheContext.metadataPath);
    REGRID_BIN_METADATA_CACHE.delete(cacheContext.payloadHash);
    REGRID_BIN_CORRUPT_PAYLOADS.delete(cacheContext.payloadHash);
    // v3 replaces both the unhashed v2 Mercator pack and the older
    // linear-latitude v1 body. Removing only these exact content-addressed
    // siblings after successful publication avoids retaining another
    // ~0.9 GB/frame; every removed cache is deterministically recomputable.
    for (const stalePath of [
      cacheContext.previousBinPath,
      cacheContext.previousMetadataPath,
      cacheContext.legacyBinPath,
      cacheContext.legacyMetadataPath,
    ].filter(Boolean)) {
      await fs.promises.rm(stalePath, { force: true }).catch(() => {});
    }
    return true;
  } catch (error) {
    // A failed persist silently forces wgrib2 regrid+export/remap on every
    // warm rebuild; the already-decoded frame remains authoritative.
    incrementProfileCounter(profile, "regridBinCacheWriteFailures");
    console.warn(
      `[noaa-beta] regridded-bin cache write failed for ${cacheContext.binPath}: ${String(error?.message || error)}`,
    );
    await handle?.close().catch(() => {});
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    await fs.promises.rm(`${tmp}.json`, { force: true }).catch(() => {});
    return false;
  }
}

// Single construction point for the bulk decoder's regrid-bin cache
// context (the signature slice and the context resolution must never
// diverge between the decode path and hash reconstruction).
function resolveBulkRegridBinCacheContext({
  gribPath,
  selectedMetadata = null,
  wgrib2Path,
  selection,
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
  const contextOptions = {
    gribPath,
    wgrib2Path,
    regridArgsSignature,
    gridMapping: mercatorGridMappingForSelection(selection, categoricalPrecipTypeInterpolation),
    width,
    height,
  };
  if (selectedMetadata) {
    return resolveRegriddedBinCacheContextFromSelectedMetadata({
      ...contextOptions,
      selectedMetadata,
    });
  }
  return resolveRegriddedBinCacheContext({
    ...contextOptions,
    decodeSession,
  });
}

// Structurally probe the exact main-decode Mercator pack using selected-GRIB
// metadata captured by the publication probe. Entry CRCs are deliberately
// deferred to decode, where every consumed Float32 field is checked before it
// can enter the result.
async function probeMainDecodeWarmPack({
  gribPath,
  selectedMetadata,
  wgrib2Path,
  selection,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation = true,
}) {
  if (
    !/^[a-f0-9]{64}$/.test(String(selectedMetadata?.sha256 || "")) ||
    !/^[a-f0-9]{24}$/.test(String(selectedMetadata?.selectedHash || ""))
  ) {
    return null;
  }
  const cacheContext = await resolveBulkRegridBinCacheContext({
    gribPath,
    selectedMetadata,
    wgrib2Path,
    selection,
    bounds,
    width,
    height,
    categoricalPrecipTypeInterpolation,
    // A speculative candidate must never enter the authoritative frame memo.
    decodeSession: null,
  });
  const cached = await readRegriddedBinCache(cacheContext);
  if (!cacheContext || !cached) {
    return null;
  }
  const candidate = Object.freeze({
    payloadHash: cacheContext.payloadHash,
    selectedMetadata,
  });
  PROBED_MAIN_DECODE_WARM_PACKS.set(candidate, {
    cacheContext,
    cached,
    gribPath: String(gribPath || ""),
    wgrib2Path: String(wgrib2Path || ""),
    width: Number(width),
    height: Number(height),
    categoricalPrecipTypeInterpolation: Boolean(categoricalPrecipTypeInterpolation),
    gridMapping: mercatorGridMappingForSelection(selection, categoricalPrecipTypeInterpolation),
    regridArgsSignature: buildNoaaRegridArgs({
      gribPath: "",
      gridPath: "",
      bounds,
      width,
      height,
      useCategoricalPrecipTypeInterpolation: Boolean(categoricalPrecipTypeInterpolation),
    }).slice(1, -1),
  });
  return candidate;
}

function assertRequiredRegridPackMatchesDecode(
  details,
  { gribPath, wgrib2Path, selection, bounds, width, height, categoricalPrecipTypeInterpolation = true },
) {
  const expectedGridMapping = mercatorGridMappingForSelection(selection, categoricalPrecipTypeInterpolation);
  const expectedRegridArgsSignature = buildNoaaRegridArgs({
    gribPath: "",
    gridPath: "",
    bounds,
    width,
    height,
    useCategoricalPrecipTypeInterpolation: Boolean(categoricalPrecipTypeInterpolation),
  }).slice(1, -1);
  const matches =
    details.gribPath === String(gribPath || "") &&
    details.wgrib2Path === String(wgrib2Path || "") &&
    details.width === Number(width) &&
    details.height === Number(height) &&
    details.categoricalPrecipTypeInterpolation === Boolean(categoricalPrecipTypeInterpolation) &&
    JSON.stringify(details.gridMapping) === JSON.stringify(expectedGridMapping) &&
    JSON.stringify(details.regridArgsSignature) === JSON.stringify(expectedRegridArgsSignature) &&
    details.cacheContext?.payloadHash === cachePayloadDescriptor(details.cacheContext?.payload).payloadHash;
  if (!matches) {
    throw requiredRegridPackError(
      "Required NOAA Mercator grid pack does not match this decode request.",
      "NOAA_REGRID_PACK_REQUIRED_MISMATCH",
    );
  }
}

// Rebuilds the regrid-bin payload hash the bulk decoder would have used
// for this frame's main decode. Consumed by the renderer when the decode
// was served entirely from bulk-seeded run-local registry entries, so the
// derived-grid cache can still engage on warm in-process paths.
async function resolveMainDecodeRegridPayloadHash({
  gribPath,
  wgrib2Path,
  selection,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation = true,
  decodeSession = null,
}) {
  const cacheContext = await resolveBulkRegridBinCacheContext({
    gribPath,
    wgrib2Path,
    selection,
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
  sparseReadPlan = null,
  profile,
  decodeSession = null,
  requiredRegridPack = null,
}) {
  const gridPath = path.join(tempDir, "selected-regridded.grib2");
  const binPath = path.join(tempDir, "selected-regridded.bin");
  const requiredPackDetails = requiredRegridPackDetails(requiredRegridPack);
  if (requiredPackDetails) {
    assertRequiredRegridPackMatchesDecode(requiredPackDetails, {
      gribPath,
      wgrib2Path,
      selection,
      bounds,
      width,
      height,
      categoricalPrecipTypeInterpolation,
    });
  }
  const cacheContext = requiredPackDetails
    ? requiredPackDetails.cacheContext
    : await resolveBulkRegridBinCacheContext({
        gribPath,
        wgrib2Path,
        selection,
        bounds,
        width,
        height,
        categoricalPrecipTypeInterpolation,
        decodeSession,
      });
  const cached = await readRegriddedBinCache(cacheContext);
  if (requiredPackDetails && !cached) {
    throw requiredRegridPackError(`Required NOAA Mercator grid pack is no longer available for ${gribPath}.`);
  }
  if (
    requiredPackDetails &&
    (!regridPackFileIdentityMatches(requiredPackDetails.cached.binIdentity, cached.binIdentity) ||
      !regridPackFileIdentityMatches(requiredPackDetails.cached.metadataIdentity, cached.metadataIdentity))
  ) {
    throw mercatorGridPackRaceError();
  }
  let inventoryText;
  let binReadPath;
  let cachedBinBytes = null;
  let persistBinAfterDecode = false;
  if (cached) {
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
  // A derived sidecar is authoritative only for the exact full Mercator pack
  // identity from which it was computed. Keep this check at the adoption
  // point (after pack metadata validation) so a stale/tampered plan can never
  // prune reads merely because its dependency graph still matches.
  const sparsePlanMatchesPack =
    Boolean(cached && sparseReadPlan) &&
    /^[a-f0-9]{64}$/.test(String(sparseReadPlan.regridBinPayloadHash || "")) &&
    sparseReadPlan.regridBinPayloadHash === cacheContext?.payloadHash;
  const candidateSelection = sparsePlanMatchesPack
    ? applyDerivedDecodePlan(selection, sparseReadPlan, width * height)
    : selection;
  const sparseApplied =
    candidateSelection !== selection &&
    Array.isArray(candidateSelection?.appliedDerivedDecodePlan?.omittedDecodeKeys) &&
    candidateSelection.appliedDerivedDecodePlan.omittedDecodeKeys.length > 0;
  const decodeSelection = sparseApplied ? candidateSelection : selection;
  if (cached && sparseReadPlan && !sparseApplied) {
    incrementProfileCounter(profile, "regridBinSparseDeclines");
  }
  // A pack hit is already indexed by selected-record identity and row mode;
  // only a miss needs to parse/match the temporary wgrib inventory.
  const inventory = cached ? null : parseWgribSimpleInventory(inventoryText);
  if (!cached && inventory.length === 0) {
    throw new Error("Bulk NOAA decode produced an empty regridded inventory.");
  }
  let stageStartedAt = performance.now();
  // Cache hits already validated the bin size against the metadata during
  // readRegriddedBinCache, so the extra stat is skipped.
  const binSize = cachedBinBytes !== null ? cachedBinBytes : (await fs.promises.stat(binReadPath)).size;
  recordProfileStage(profile, "binaryReadMs", stageStartedAt);
  const fieldBytes = width * height * 4;
  if (!cached && binSize < inventory.length * fieldBytes) {
    throw new Error(`Bulk NOAA binary has ${binSize} bytes; expected at least ${inventory.length * fieldBytes}.`);
  }
  const decoded = {};
  const usedRecordNumbers = new Set();
  const regriddedRecordBySource = new Map();
  const regriddedInventoryIndex = cached ? null : buildBulkDecodedRecordIndex(inventory);
  const selectedRecordIndex = selectedPlan?.recordIndexByOriginalRecord || null;
  const decodedGridByRecord = new Map();
  const recordCacheSeededKeys = new Set();
  const packEntriesByKey = new Map();
  const missingPackEntryKeys = new Set();
  let sliceScratchBuffer = null;
  const requiredKeys = requiredDecodeKeys(selection.catalog || NOAA_NAM_PARAMETER_CATALOG);
  const livePackEntryKeys = new Set(
    Object.entries(decodeSelection.records || {})
      .filter(([, record]) => Boolean(record))
      .map(([key, record]) =>
        mercatorGridPackEntryKey(record, decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation)),
      ),
  );
  let packEntriesRead = 0;
  let packEntriesSkipped = 0;
  let packBytesRead = 0;
  let packBytesSkipped = 0;
  stageStartedAt = performance.now();
  const binHandle = await fs.promises.open(binReadPath, "r");
  let openedBinIdentity = null;
  let completedBinIdentity = null;
  let completedMetadataIdentity = null;
  let gridDecodeError = null;
  try {
    if (cached) {
      openedBinIdentity = regridPackFileIdentity(await binHandle.stat({ bigint: true }));
      if (!regridPackFileIdentityMatches(cached.binIdentity, openedBinIdentity)) {
        throw mercatorGridPackRaceError();
      }
    }
    if (cached) {
      // Metadata entries are in increasing byte-offset order. Read the pack
      // sequentially up front so selection/catalog order cannot turn a warm
      // 0.9 GB HRRR hit into random I/O.
      const packedEntries = sparseApplied
        ? cached.entries.filter((entry) => livePackEntryKeys.has(entry.key))
        : cached.entries;
      packEntriesRead = packedEntries.length;
      packEntriesSkipped = cached.entries.length - packedEntries.length;
      packBytesRead = packEntriesRead * fieldBytes;
      packBytesSkipped = packEntriesSkipped * fieldBytes;
      for (const packedEntry of packedEntries) {
        const values = await readPackedFloat32GridFileSlice({
          fileHandle: binHandle,
          byteOffset: packedEntry.byteOffset,
          fieldBytes,
        });
        if (crc32Float32(values) !== packedEntry.crc32) {
          throw mercatorGridPackIntegrityError(packedEntry);
        }
        markBulkDecodedGrid(values, cacheContext?.payloadHash);
        decodedGridByRecord.set(packedEntry.key, values);
      }
    }
    for (const [key, sourceRecord] of Object.entries(decodeSelection.records || {})) {
      if (!sourceRecord) {
        continue;
      }
      const sourceRecordKey = selectedRecordDecodeCacheKey(sourceRecord);
      const rowInterpolation = decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation);
      const packEntryKey = mercatorGridPackEntryKey(sourceRecord, rowInterpolation);
      if (cached?.missingEntryKeys.has(packEntryKey)) {
        if (requiredKeys.has(key)) {
          throw new Error(`Bulk NOAA grid pack is missing required record for ${key}.`);
        }
        continue;
      }
      let values = decodedGridByRecord.get(packEntryKey);
      if (!values) {
        if (cached) {
          throw new Error(`Bulk NOAA grid pack has no validated entry for ${key}.`);
        } else {
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
            missingPackEntryKeys.add(packEntryKey);
            continue;
          }
          const fieldOrdinal = bulkDecodedRecordOrdinal(regriddedRecord);
          // The cold slice loop is sequential, so one scratch read buffer
          // serves every linear-latitude field before exact Mercator remap.
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
          packEntriesByKey.set(packEntryKey, values);
        }
        markBulkDecodedGrid(values, cacheContext?.payloadHash);
        decodedGridByRecord.set(packEntryKey, values);
      }
      if (!recordCacheSeededKeys.has(packEntryKey)) {
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
        recordCacheSeededKeys.add(packEntryKey);
      }
      decoded[key] = values;
    }
  } catch (error) {
    gridDecodeError = error;
  } finally {
    if (cached && openedBinIdentity) {
      completedBinIdentity = await binHandle
        .stat({ bigint: true })
        .then(regridPackFileIdentity)
        .catch(() => null);
    }
    if (requiredPackDetails) {
      completedMetadataIdentity = await statRegridPackFileIdentity(cacheContext.metadataPath).catch(() => null);
    }
    await binHandle.close().catch(() => {});
  }
  if (cached && openedBinIdentity && !regridPackFileIdentityMatches(openedBinIdentity, completedBinIdentity)) {
    gridDecodeError = mercatorGridPackRaceError();
  }
  if (
    requiredPackDetails &&
    !regridPackFileIdentityMatches(requiredPackDetails.cached.metadataIdentity, completedMetadataIdentity)
  ) {
    gridDecodeError = mercatorGridPackRaceError();
  }
  if (gridDecodeError) {
    if (gridDecodeError.code === "NOAA_REGRID_PACK_INTEGRITY") {
      incrementProfileCounter(profile, "regridBinCacheCorruptions");
      await invalidateCorruptRegriddedBinCache(cacheContext, gridDecodeError.packEntry, {
        expectedBinIdentity: openedBinIdentity,
        expectedMetadataIdentity: cached?.metadataIdentity || null,
        removeFiles: !requiredPackDetails,
      });
    }
    throw gridDecodeError;
  }
  if (cached) {
    incrementProfileCounter(profile, "regridBinCacheHits");
  }
  if (sparseApplied) {
    incrementProfileCounter(profile, "regridBinSparseHits");
  }
  recordProfileStage(profile, "gridMapMs", stageStartedAt);
  if (!cached) {
    packEntriesRead = packEntriesByKey.size;
    packBytesRead = packEntriesRead * fieldBytes;
  }
  if (profile) {
    profile.regridBinPackEntriesRead = (Number(profile.regridBinPackEntriesRead) || 0) + packEntriesRead;
    profile.regridBinPackEntriesSkipped = (Number(profile.regridBinPackEntriesSkipped) || 0) + packEntriesSkipped;
    profile.regridBinPackBytesRead = (Number(profile.regridBinPackBytesRead) || 0) + packBytesRead;
    profile.regridBinPackBytesSkipped = (Number(profile.regridBinPackBytesSkipped) || 0) + packBytesSkipped;
  }
  if (persistBinAfterDecode) {
    const persistStartedAt = performance.now();
    await writeRegriddedBinCache(cacheContext, {
      gridEntries: [...packEntriesByKey].map(([key, values]) => ({ key, values })),
      missingEntryKeys: [...missingPackEntryKeys],
      profile,
    }).catch(() => {});
    recordProfileStage(profile, "regridBinPersistMs", persistStartedAt);
  }
  // Recorded only on successful bulk completion so consumers (the
  // derived-grid cache) never key on a hash whose grids actually came from
  // the legacy fallback decoder.
  if (Array.isArray(decodeSession?.collectRegridBinPayloadHashes)) {
    decodeSession.collectRegridBinPayloadHashes.push(cacheContext?.payloadHash || null);
  }
  return attachDecodedGridOutcome(decoded, {
    source: cached ? (sparseApplied ? "regrid-pack-sparse" : "regrid-pack") : "bulk-cold",
    payloadHash: cacheContext?.payloadHash || null,
    sparseApplied,
    packEntriesRead,
    packEntriesSkipped,
    packBytesRead,
    packBytesSkipped,
  });
}

function sha256Bytes(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function crc32Bytes(body) {
  return zlib.crc32(body).toString(16).padStart(8, "0");
}

function crc32Float32(values) {
  return crc32Bytes(Buffer.from(values.buffer, values.byteOffset, values.byteLength));
}

function mercatorGridPackIntegrityError(entry) {
  const error = new Error(`Mercator grid-pack checksum mismatch for ${entry?.key || "unknown entry"}.`);
  error.code = "NOAA_REGRID_PACK_INTEGRITY";
  error.packEntry = entry;
  return error;
}

function mercatorGridPackRaceError() {
  const error = new Error("Mercator grid pack read changed identity; expected the probed file generation.");
  error.code = "NOAA_REGRID_PACK_RACE";
  return error;
}

async function invalidateCorruptRegriddedBinCache(
  cacheContext,
  entry,
  { expectedBinIdentity = null, expectedMetadataIdentity = null, removeFiles = true } = {},
) {
  if (!cacheContext || !entry) {
    return false;
  }
  REGRID_BIN_METADATA_CACHE.delete(cacheContext.payloadHash);
  let remainsCorrupt;
  try {
    const currentBinIdentity = await statRegridPackFileIdentity(cacheContext.binPath);
    if (expectedBinIdentity && !regridPackFileIdentityMatches(expectedBinIdentity, currentBinIdentity)) {
      return false;
    }
    const currentMetadataIdentity = await statRegridPackFileIdentity(cacheContext.metadataPath).catch(() => null);
    if (
      expectedMetadataIdentity &&
      currentMetadataIdentity &&
      !regridPackFileIdentityMatches(expectedMetadataIdentity, currentMetadataIdentity)
    ) {
      return false;
    }
    const handle = await fs.promises.open(cacheContext.binPath, "r");
    try {
      const openedIdentity = regridPackFileIdentity(await handle.stat({ bigint: true }));
      if (expectedBinIdentity && !regridPackFileIdentityMatches(expectedBinIdentity, openedIdentity)) {
        return false;
      }
      const values = await readPackedFloat32GridFileSlice({
        fileHandle: handle,
        byteOffset: entry.byteOffset,
        fieldBytes: cacheContext.payload.gridShape.fieldBytes,
      });
      remainsCorrupt = crc32Float32(values) !== entry.crc32;
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    remainsCorrupt = true;
  }
  if (!remainsCorrupt) {
    return false;
  }
  const finalBinIdentity = await statRegridPackFileIdentity(cacheContext.binPath).catch(() => null);
  const finalMetadataIdentity = await statRegridPackFileIdentity(cacheContext.metadataPath).catch(() => null);
  if (
    (expectedBinIdentity && !regridPackFileIdentityMatches(expectedBinIdentity, finalBinIdentity)) ||
    (expectedMetadataIdentity &&
      finalMetadataIdentity &&
      !regridPackFileIdentityMatches(expectedMetadataIdentity, finalMetadataIdentity))
  ) {
    return false;
  }
  boundedRunCacheSet(REGRID_BIN_CORRUPT_PAYLOADS, cacheContext.payloadHash, true);
  if (!removeFiles) {
    return true;
  }
  // Metadata first makes future readers miss before the recomputable body is
  // removed. A run-local blacklist closes the same-size-corruption hole even
  // if filesystem cleanup is denied; the next call cold-rebuilds the pack and
  // a successful publication clears the blacklist.
  await fs.promises.rm(cacheContext.metadataPath, { force: true }).catch(() => {});
  await fs.promises.rm(cacheContext.binPath, { force: true }).catch(() => {});
  return true;
}

function mercatorGridPackManifestSha256({ fieldBytes, binBytes, entries, missingEntryKeys }) {
  const manifest = {
    version: "mercator-grid-pack-entry-manifest-v1",
    fieldBytes: Number(fieldBytes),
    binBytes: Number(binBytes),
    entries: (Array.isArray(entries) ? entries : [])
      .map((entry) => ({
        key: String(entry?.key || ""),
        byteOffset: Number(entry?.byteOffset),
        crc32: String(entry?.crc32 || ""),
      }))
      .sort((left, right) => left.byteOffset - right.byteOffset || left.key.localeCompare(right.key)),
    missingEntryKeys: normalizeMercatorGridMapping(
      missingEntryKeys instanceof Set ? [...missingEntryKeys] : missingEntryKeys,
    ),
  };
  return sha256Bytes(Buffer.from(JSON.stringify(manifest)));
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
  decodedGridOutcome,
  decodedSelectionCacheKey,
  parseWgribSimpleInventory,
  mercatorGridMappingForSelection,
  mercatorGridPackManifestSha256,
  mercatorGridPackEntryKey,
  normalizeMercatorGridMapping,
  probeMainDecodeWarmPack,
  resolveMainDecodeRegridPayloadHash,
  readRegriddedBinCache,
  regriddedBinMemoKey,
  requiredDecodeKeys,
  resolveRegriddedBinCacheContext,
  resolveRegriddedBinCacheContextFromSelectedMetadata,
  resolveRegriddedBinCacheContextUncached,
  takeBulkDecodedRecord,
  takeBulkDecodedRecordBySelectedPlan,
  takeFirstUnusedRecord,
  validatedMercatorGridPackMetadata,
  writeRegriddedBinCache,
};
