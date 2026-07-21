"use strict";

// Disk cache for the profile-derived severe product grids built by
// severe.buildProfileDerivedGrids (lapse rate, bulk/effective shear, DCAPE,
// effective-layer SCP/STP and science prototypes).
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
// Storage follows the regridded-bin discipline: `<selected>.derived-<hash>.bin`
// next to the cached selected GRIB, concatenated Float32 grids in the
// metadata's gridNames order, tmp+rename writes, and hash-first metadata
// validation on read.

const fs = require("fs");
const { cachePayloadDescriptor, cacheMetadataWithPayload, cacheMetadataPayloadMatches } = require("./cache-io");

const DERIVED_GRID_CACHE_VERSION = "derived-grids-v1";
const pendingDerivedGridCacheWrites = new Set();

function buildDerivedGridCacheContext({
  gribPath,
  regridBinPayloadHashes,
  methodologyVersion,
  catalogVersion,
  products,
  cellCount,
}) {
  if (!gribPath || !Array.isArray(regridBinPayloadHashes) || regridBinPayloadHashes.length === 0) {
    return null;
  }
  const hashes = regridBinPayloadHashes.map((value) => String(value || ""));
  if (hashes.some((value) => !value)) {
    return null;
  }
  const productList = Array.from(new Set((products || []).map((value) => String(value)))).sort();
  if (productList.length === 0) {
    return null;
  }
  const cells = Math.round(Number(cellCount));
  if (!Number.isFinite(cells) || cells <= 0) {
    return null;
  }
  const payload = {
    kind: DERIVED_GRID_CACHE_VERSION,
    regridBinPayloadHashes: [...hashes].sort(),
    methodologyVersion: String(methodologyVersion || ""),
    catalogVersion: String(catalogVersion || ""),
    products: productList,
    cellCount: cells,
  };
  const descriptor = cachePayloadDescriptor(payload);
  const pathToken = descriptor.payloadHash.slice(0, 16);
  return {
    payload,
    payloadHash: descriptor.payloadHash,
    cellCount: cells,
    binPath: `${gribPath}.derived-${pathToken}.bin`,
    metadataPath: `${gribPath}.derived-${pathToken}.json`,
  };
}

async function readDerivedGridCache(cacheContext) {
  if (!cacheContext) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(cacheContext.metadataPath, "utf8"));
    if (!cacheMetadataPayloadMatches(metadata, cacheContext.payload, cacheContext.payloadHash)) {
      return null;
    }
    const gridNames = Array.isArray(metadata.gridNames) ? metadata.gridNames.map((value) => String(value)) : null;
    // An empty grid set must be a miss, not a hit: it would round-trip to a
    // truthy {} that callers count as "precomputed", silently skipping the
    // compute of every derived severe product. A null return means miss.
    if (!gridNames || gridNames.length === 0) {
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
    const grids = {};
    for (let index = 0; index < gridNames.length; index += 1) {
      const grid = new Float32Array(cellCount);
      const target = Buffer.from(grid.buffer);
      bin.copy(target, 0, index * cellCount * 4, (index + 1) * cellCount * 4);
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
  const gridNames = Object.keys(grids);
  // Refuse to persist an empty grid set (the read side rejects it as a miss,
  // so writing one could only ever poison the cache slot for real writes).
  if (gridNames.length === 0) {
    return false;
  }
  const cellCount = cacheContext.cellCount;
  for (const name of gridNames) {
    const grid = grids[name];
    if (!(grid instanceof Float32Array) || grid.length !== cellCount) {
      return false;
    }
  }
  const tmp = `${cacheContext.binPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const bin = Buffer.allocUnsafe(gridNames.length * cellCount * 4);
    for (let index = 0; index < gridNames.length; index += 1) {
      Buffer.from(grids[gridNames[index]].buffer, grids[gridNames[index]].byteOffset, cellCount * 4).copy(
        bin,
        index * cellCount * 4,
      );
    }
    await fs.promises.writeFile(tmp, bin);
    await fs.promises.writeFile(
      `${tmp}.json`,
      JSON.stringify(cacheMetadataWithPayload(cacheContext.payload, { gridNames, binBytes: bin.length })),
    );
    await fs.promises.rename(tmp, cacheContext.binPath);
    await fs.promises.rename(`${tmp}.json`, cacheContext.metadataPath);
    return true;
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    await fs.promises.rm(`${tmp}.json`, { force: true }).catch(() => {});
    console.warn(
      `[noaa-beta] derived-grid cache write failed for ${cacheContext.binPath}: ${String(error?.message || error)}`,
    );
    return false;
  }
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
  buildDerivedGridCacheContext,
  drainDerivedGridCacheWrites,
  readDerivedGridCache,
  scheduleDerivedGridCacheWrite,
  writeDerivedGridCache,
};
