"use strict";

// Disk caches for exact derived Float32 products. The established profile
// family stores severe.buildProfileDerivedGrids outputs (lapse rate,
// bulk/effective shear, DCAPE, effective-layer SCP/STP and prototypes). The
// supplemental family stores surface LCL/theta-e and raw frontogenesis grids
// behind a separate version/key so either methodology can evolve independently.
//
// Correctness model: buildProfileDerivedGrids is a pure function of the
// frame's main-decode grids. Those grids are themselves pinned by the
// regridded-bin cache payload hash(es) (selected-subset SHA-256, regrid and
// export argument vectors, wgrib2 identity), and the JS post-processing that
// turns bin slices into decoded grids (Mercator row remap policy, catalog
// interpolation choices) is pinned by CATALOG_VERSION plus the methodology
// version token exported by severe.js. The cache therefore keys on all of
// those and stores the exact Float32 output bytes, so a hit reproduces the
// computed grids bit-for-bit by construction.
//
// Storage follows the regridded-bin discipline: a versioned file next to the
// cached selected GRIB, concatenated Float32 grids in canonical metadata
// order, and metadata-last tmp+rename publication. Both current families
// carry SHA-256 so same-size corruption fails open to recomputation. Profile
// v2 also binds its exact output-grid roster separately from the requested
// product roster: products such as legacy SCP/STP consume dependency grids
// named effectiveBulkShear/bulkShear0to6km.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  cachePayloadDescriptor,
  cacheMetadataWithPayload,
  cacheMetadataPayloadMatches,
  releaseGridCacheLock,
  tryAcquireGridCacheLock,
} = require("./cache-io");
const { float32ArrayViewFromBuffer } = require("./grid-ops");

const DERIVED_GRID_CACHE_VERSION = "profile-derived-grids-v2";
const SUPPLEMENTAL_DERIVED_GRID_CACHE_VERSION = "supplemental-derived-grids-v1";
const pendingDerivedGridCacheWrites = new Set();

function buildDerivedGridCacheContext({
  gribPath,
  regridBinPayloadHashes,
  methodologyVersion,
  catalogVersion,
  products,
  expectedGridNames,
  cellCount,
  byteOrder = os.endianness(),
}) {
  const expectedNames = normalizeExpectedGridNames(expectedGridNames);
  const nativeByteOrder = String(byteOrder || "").toUpperCase();
  if (
    !gribPath ||
    !Array.isArray(regridBinPayloadHashes) ||
    regridBinPayloadHashes.length === 0 ||
    !isNonEmptyIdentityToken(methodologyVersion) ||
    !isNonEmptyIdentityToken(catalogVersion) ||
    !expectedNames ||
    (nativeByteOrder !== "LE" && nativeByteOrder !== "BE")
  ) {
    return null;
  }
  return buildGridCacheContext({
    gribPath,
    regridBinPayloadHashes,
    methodologyVersion,
    catalogVersion,
    products,
    cellCount,
    cacheVersion: DERIVED_GRID_CACHE_VERSION,
    pathLabel: "profile-derived-v2",
    requireBodySha256: true,
    requireCompleteExpectedGridCoverage: true,
    requireStrictPayloadIdentity: true,
    requireSha256RegridHashes: true,
    restoreOwningBuffers: true,
    payloadExtra: { byteOrder: nativeByteOrder, expectedGridNames: expectedNames },
  });
}

function buildSupplementalDerivedGridCacheContext({
  gribPath,
  regridBinPayloadHashes,
  methodologyVersion,
  catalogVersion,
  products,
  cellCount,
  byteOrder = os.endianness(),
}) {
  const nativeByteOrder = String(byteOrder || "").toUpperCase();
  if (nativeByteOrder !== "LE" && nativeByteOrder !== "BE") {
    return null;
  }
  return buildGridCacheContext({
    gribPath,
    regridBinPayloadHashes,
    methodologyVersion,
    catalogVersion,
    products,
    cellCount,
    cacheVersion: SUPPLEMENTAL_DERIVED_GRID_CACHE_VERSION,
    pathLabel: "supplemental-derived",
    requireBodySha256: true,
    requireCompleteProductCoverage: true,
    payloadExtra: { byteOrder: nativeByteOrder },
  });
}

function buildGridCacheContext({
  gribPath,
  regridBinPayloadHashes,
  methodologyVersion,
  catalogVersion,
  products,
  cellCount,
  cacheVersion,
  pathLabel,
  requireBodySha256 = false,
  requireCompleteProductCoverage = false,
  requireCompleteExpectedGridCoverage = false,
  requireStrictPayloadIdentity = false,
  requireSha256RegridHashes = false,
  restoreOwningBuffers = false,
  payloadExtra = null,
}) {
  if (!gribPath || !Array.isArray(regridBinPayloadHashes) || regridBinPayloadHashes.length === 0) {
    return null;
  }
  const hashes = regridBinPayloadHashes.map((value) => String(value || ""));
  if (hashes.some((value) => !value) || (requireSha256RegridHashes && hashes.some((value) => !isSha256(value)))) {
    return null;
  }
  const productList = Array.from(new Set((products || []).map((value) => String(value)))).sort();
  if (productList.length === 0) {
    return null;
  }
  const cells = Math.round(Number(cellCount));
  if (!Number.isSafeInteger(cells) || cells <= 0) {
    return null;
  }
  const payload = {
    kind: cacheVersion,
    regridBinPayloadHashes: [...hashes].sort(),
    methodologyVersion: String(methodologyVersion || ""),
    catalogVersion: String(catalogVersion || ""),
    products: productList,
    cellCount: cells,
    ...(payloadExtra && typeof payloadExtra === "object" ? payloadExtra : {}),
  };
  const descriptor = cachePayloadDescriptor(payload);
  const pathToken = descriptor.payloadHash.slice(0, 16);
  return {
    gribPath,
    payload,
    payloadHash: descriptor.payloadHash,
    cellCount: cells,
    binPath: `${gribPath}.${pathLabel}-${pathToken}.bin`,
    metadataPath: `${gribPath}.${pathLabel}-${pathToken}.json`,
    lockPath: `${gribPath}.${pathLabel}-${pathToken}.lock`,
    requireBodySha256,
    requireCompleteProductCoverage,
    requireCompleteExpectedGridCoverage,
    requireStrictPayloadIdentity,
    restoreOwningBuffers,
  };
}

async function readDerivedGridCache(cacheContext) {
  if (!cacheContext) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(cacheContext.metadataPath, "utf8"));
    if (!metadataMatchesCacheContext(metadata, cacheContext)) {
      return null;
    }
    const gridNames =
      Array.isArray(metadata.gridNames) && metadata.gridNames.every((value) => typeof value === "string")
        ? [...metadata.gridNames]
        : null;
    // An empty grid set must be a miss, not a hit: it would round-trip to a
    // truthy {} that callers count as "precomputed", silently skipping the
    // compute of every derived severe product. A null return means miss.
    if (!gridNames || gridNames.length === 0) {
      return null;
    }
    if (!validateGridNames(cacheContext, gridNames)) {
      return null;
    }
    const cellCount = cacheContext.cellCount;
    const expectedBytes = gridNames.length * cellCount * 4;
    if (Number(metadata.binBytes) !== expectedBytes) {
      return null;
    }
    const bin = await fs.promises.readFile(cacheContext.binPath);
    if (bin.length !== expectedBytes) {
      return null;
    }
    if (cacheContext.requireBodySha256) {
      const expectedSha256 = String(metadata.binSha256 || "");
      if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256Buffer(bin) !== expectedSha256) {
        return null;
      }
    }
    const grids = {};
    for (let index = 0; index < gridNames.length; index += 1) {
      let grid;
      if (!cacheContext.restoreOwningBuffers) {
        // The readFile Buffer owns these bytes for the lifetime of its typed
        // views. Avoid copying the entire supplemental sidecar a second time:
        // a full HRRR hit is ~24 MiB, so this halves peak cache-read storage
        // while preserving exact Float32 bit patterns (including NaNs).
        grid = float32ArrayViewFromBuffer(bin, index * cellCount * 4, cellCount * 4);
        if (!grid) {
          return null;
        }
      } else {
        // Preserve the profile-cache contract that every restored grid owns a
        // distinct zero-offset ArrayBuffer; profile tooling transfers those
        // buffers directly. Buffer.copy preserves every Float32 bit pattern,
        // including non-canonical NaN payloads.
        grid = new Float32Array(cellCount);
        bin.copy(Buffer.from(grid.buffer), 0, index * cellCount * 4, (index + 1) * cellCount * 4);
      }
      grids[gridNames[index]] = grid;
    }
    return grids;
  } catch {
    return null;
  }
}

async function writeDerivedGridCache(cacheContext, grids) {
  if (!cacheContext || !grids) {
    return false;
  }
  const gridNames = Object.keys(grids).sort();
  // Refuse to persist an empty grid set (the read side rejects it as a miss,
  // so writing one could only ever poison the cache slot for real writes).
  if (gridNames.length === 0) {
    return false;
  }
  if (!validateGridNames(cacheContext, gridNames)) {
    return false;
  }
  const cellCount = cacheContext.cellCount;
  for (const name of gridNames) {
    const grid = grids[name];
    if (!(grid instanceof Float32Array) || grid.length !== cellCount) {
      return false;
    }
  }
  // Checksummed bodies are large enough that two frame workers racing the
  // same cache slot would otherwise be able to interleave their independent
  // body/metadata renames. The lock is best-effort: a contender simply keeps
  // the already-computed grids and lets the owner publish for the next build.
  let lockHandle = null;
  if (cacheContext.requireBodySha256) {
    try {
      lockHandle = await tryAcquireGridCacheLock(cacheContext.lockPath, cacheContext.payload);
    } catch (error) {
      console.warn(
        `[noaa-beta] derived-grid cache lock failed for ${cacheContext.binPath}: ${String(error?.message || error)}`,
      );
      return false;
    }
    if (!lockHandle) {
      return false;
    }
  }
  const tmp = `${cacheContext.binPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let binPublished = false;
  let metadataPublished = false;
  let publishedBinSha256 = null;
  try {
    await fs.promises.mkdir(path.dirname(cacheContext.binPath), { recursive: true });
    const bin = Buffer.allocUnsafe(gridNames.length * cellCount * 4);
    for (let index = 0; index < gridNames.length; index += 1) {
      Buffer.from(grids[gridNames[index]].buffer, grids[gridNames[index]].byteOffset, cellCount * 4).copy(
        bin,
        index * cellCount * 4,
      );
    }
    await fs.promises.writeFile(tmp, bin);
    const metadata = { gridNames, binBytes: bin.length };
    if (cacheContext.requireBodySha256) {
      publishedBinSha256 = sha256Buffer(bin);
      metadata.binSha256 = publishedBinSha256;
    }
    await fs.promises.writeFile(
      `${tmp}.json`,
      JSON.stringify(cacheMetadataWithPayload(cacheContext.payload, metadata)),
    );
    await fs.promises.rename(tmp, cacheContext.binPath);
    binPublished = true;
    await fs.promises.rename(`${tmp}.json`, cacheContext.metadataPath);
    metadataPublished = true;
    // The previous profile writer used `<selected>.derived-<token>.*`.
    // Profile-v2 has a disjoint namespace, so those bodies can no longer be
    // read after a successful replacement publication. Clean only that exact
    // legacy namespace; supplemental sidecars intentionally retain their
    // independent lifecycle. Cleanup is best-effort and must never turn a
    // complete current publication into a frame failure.
    await removeLegacyProfileDerivedSidecars(cacheContext).catch(() => {});
    return true;
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    await fs.promises.rm(`${tmp}.json`, { force: true }).catch(() => {});
    if (cacheContext.requireBodySha256 && binPublished && !metadataPublished) {
      // If no matching metadata reached the final path, this body is not
      // discoverable and would otherwise become a permanent ~24 MiB orphan.
      // The writer lock makes the check/removal safe against other publishers.
      await removeUnpublishedDerivedBody(cacheContext, publishedBinSha256);
    }
    console.warn(
      `[noaa-beta] derived-grid cache write failed for ${cacheContext.binPath}: ${String(error?.message || error)}`,
    );
    return false;
  } finally {
    if (lockHandle) {
      await releaseGridCacheLock(cacheContext.lockPath, lockHandle);
    }
  }
}

async function removeLegacyProfileDerivedSidecars(cacheContext) {
  if (cacheContext?.payload?.kind !== DERIVED_GRID_CACHE_VERSION || !cacheContext.gribPath) {
    return false;
  }
  const directory = path.dirname(cacheContext.gribPath);
  const prefix = `${path.basename(cacheContext.gribPath)}.derived-`;
  let names;
  try {
    names = await fs.promises.readdir(directory);
  } catch {
    return false;
  }
  const legacyNames = names
    .filter(
      (name) =>
        typeof name === "string" &&
        name.startsWith(prefix) &&
        /^[a-f0-9]{16}\.(?:json|bin)$/.test(name.slice(prefix.length)),
    )
    // Metadata first makes an interrupted cleanup fail closed for old readers.
    .sort((left, right) => Number(left.endsWith(".bin")) - Number(right.endsWith(".bin")));
  let complete = true;
  for (const name of legacyNames) {
    try {
      await fs.promises.rm(path.join(directory, name), { force: true });
    } catch {
      complete = false;
    }
  }
  return complete;
}

async function removeUnpublishedDerivedBody(cacheContext, publishedBinSha256) {
  try {
    const metadata = JSON.parse(await fs.promises.readFile(cacheContext.metadataPath, "utf8"));
    const metadataMatches = metadataMatchesCacheContext(metadata, cacheContext);
    if (metadataMatches && String(metadata.binSha256 || "") === publishedBinSha256 && Number(metadata.binBytes) > 0) {
      return;
    }
  } catch {
    // Missing/malformed metadata is precisely the unpublished-orphan case.
  }
  await fs.promises.rm(cacheContext.binPath, { force: true }).catch(() => {});
}

function validateGridNames(cacheContext, gridNames) {
  if (!Array.isArray(gridNames) || gridNames.length === 0) {
    return false;
  }
  for (let index = 0; index < gridNames.length; index += 1) {
    if (!isSafeGridName(gridNames[index]) || (index > 0 && gridNames[index - 1] >= gridNames[index])) {
      return false;
    }
  }
  if (cacheContext.requireCompleteExpectedGridCoverage) {
    const expectedGridNames = cacheContext?.payload?.expectedGridNames;
    if (!Array.isArray(expectedGridNames) || gridNames.length !== expectedGridNames.length) {
      return false;
    }
    for (let index = 0; index < gridNames.length; index += 1) {
      if (gridNames[index] !== expectedGridNames[index]) {
        return false;
      }
    }
    return true;
  }
  const productNames = Array.isArray(cacheContext?.payload?.products) ? cacheContext.payload.products : [];
  const allowed = new Set(productNames);
  if (gridNames.some((name) => !allowed.has(name))) {
    return false;
  }
  if (cacheContext.requireCompleteProductCoverage) {
    if (gridNames.length !== productNames.length) {
      return false;
    }
    for (let index = 0; index < gridNames.length; index += 1) {
      if (gridNames[index] !== productNames[index]) {
        return false;
      }
    }
  }
  return true;
}

function metadataMatchesCacheContext(metadata, cacheContext) {
  if (!cacheMetadataPayloadMatches(metadata, cacheContext.payload, cacheContext.payloadHash)) {
    return false;
  }
  if (!cacheContext.requireStrictPayloadIdentity) {
    return true;
  }
  if (
    cachePayloadDescriptor(cacheContext.payload).payloadHash !== cacheContext.payloadHash ||
    metadata?.payloadHash !== cacheContext.payloadHash ||
    !metadata.payload ||
    typeof metadata.payload !== "object"
  ) {
    return false;
  }
  return cachePayloadDescriptor(metadata.payload).payloadHash === cacheContext.payloadHash;
}

function normalizeExpectedGridNames(expectedGridNames) {
  if (!Array.isArray(expectedGridNames) || expectedGridNames.length === 0) {
    return null;
  }
  const names = [];
  const seen = new Set();
  for (const value of expectedGridNames) {
    if (typeof value !== "string" || !isSafeGridName(value) || seen.has(value)) {
      return null;
    }
    seen.add(value);
    names.push(value);
  }
  return names.sort();
}

function isSafeGridName(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9]*$/.test(value) &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

function isNonEmptyIdentityToken(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(value);
}

function sha256Buffer(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function scheduleDerivedGridCacheWrite(cacheContext, grids) {
  const write = writeDerivedGridCache(cacheContext, grids);
  pendingDerivedGridCacheWrites.add(write);
  void write.then(
    () => pendingDerivedGridCacheWrites.delete(write),
    () => pendingDerivedGridCacheWrites.delete(write),
  );
  return write;
}

async function drainDerivedGridCacheWrites() {
  while (pendingDerivedGridCacheWrites.size > 0) {
    await Promise.allSettled([...pendingDerivedGridCacheWrites]);
  }
}

module.exports = {
  DERIVED_GRID_CACHE_VERSION,
  SUPPLEMENTAL_DERIVED_GRID_CACHE_VERSION,
  buildDerivedGridCacheContext,
  buildSupplementalDerivedGridCacheContext,
  drainDerivedGridCacheWrites,
  readDerivedGridCache,
  scheduleDerivedGridCacheWrite,
  writeDerivedGridCache,
};
