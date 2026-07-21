"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { incrementProfileCounter } = require("./util");
const { float32ArrayViewFromBuffer } = require("./grid-ops");
const {
  buildFrameProvenanceCacheSnapshot,
  registerTemporalProvenanceDerivation,
  restoreFrameProvenanceCacheSnapshot,
  selectedPrecipRecordIdentity,
} = require("./grib-source");
const {
  cacheMetadataPayloadMatches,
  cacheMetadataWithPayload,
  padHour,
  probeCachedGridSidecar,
  releaseGridCacheLock,
  sanitizePathToken,
  tryAcquireGridCacheLock,
  waitForCachedGrid,
} = require("./cache-io");
const { buildBoundedForecastHourRosterIdentity } = require("./forecast-hour-roster");
const { snowArtifactCacheIdentity } = require("./selection");
const {
  activeDescriptorCellCount,
  buildLiquidChunkDescriptors,
  buildSnowfallLiquidInByChunk,
  hasIncompleteLiquidChunks,
} = require("./winter-sparse");
const { resolveSnowfallLiquidChunksForWindow } = require("./winter-liquid-planning");
const { decodeSnowLiquidSourceGrids, snowMaskSampleIdentity } = require("./winter-source-grids");
const { decodeIntervalSnowfallProfiles, writeFloatGridEntriesBinary } = require("./winter-profile-decode");
const { buildIntervalSnowfallGridsForEntries } = require("./winter-slr-grids");

const SNOWFALL_DELTA_PROMISE_CACHE = new Map();

const SNOWFALL_CUMULATIVE_PROMISE_CACHE = new Map();

const SNOWFALL_DELTA_GRID_CACHE_VERSION = "snowfall-delta-grid-v6-target-bounded-provenance";

const SNOWFALL_CUMULATIVE_GRID_CACHE_VERSION = "snowfall-cumulative-grid-v6-target-bounded-provenance";

const SNOWFALL_CUMULATIVE_GRID_LOCK_MIN_HOUR = 6;

async function restoreSnowfallProvenanceAfterSharedPromise(promise, cachePath, payload, context) {
  const grids = await promise;
  if (cachePath) {
    // A promise can be shared by two frame-local decode sessions. Re-read the
    // now-complete sidecar so the second session receives the same validated
    // lineage as an ordinary warm disk-cache hit.
    const cached = await readCachedCumulativeSnowfallGrids(cachePath, payload, context);
    if (!cached && typeof promise?.provenanceSnapshot === "function") {
      restoreFrameProvenanceCacheSnapshot(context?.decodeSession, promise.provenanceSnapshot());
    }
  }
  return grids;
}

async function buildCachedCumulativeSnowfallGrids({ entries, targetHour, context, decoded }) {
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour) || hour <= 0) {
    return new Map();
  }
  const payload = cumulativeSnowfallCachePayload({ entries, targetHour: hour, context });
  const cachePath = cumulativeSnowfallGridCachePath(payload, context);
  const cacheKey = cachePath || null;
  const cached = cacheKey ? SNOWFALL_CUMULATIVE_PROMISE_CACHE.get(cacheKey) : null;
  if (cached) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
    return restoreSnowfallProvenanceAfterSharedPromise(cached, cachePath, payload, context);
  }
  const promise = readOrComputeCachedCumulativeSnowfallGrids({
    payload,
    cachePath,
    context,
    compute: () => computeCumulativeSnowfallGrids({ entries, targetHour: hour, context, decoded }),
  }).finally(() => {
    if (cacheKey) {
      SNOWFALL_CUMULATIVE_PROMISE_CACHE.delete(cacheKey);
    }
  });
  promise.provenanceSnapshot = () =>
    buildFrameProvenanceCacheSnapshot(context?.decodeSession, {
      families: ["snowfall-accumulation", "snowfall-profile-inputs"],
      maxTargetHour: payload.targetHour,
    });
  if (cacheKey) {
    SNOWFALL_CUMULATIVE_PROMISE_CACHE.set(cacheKey, promise);
  }
  return promise;
}

async function buildCachedIterativeCumulativeSnowfallGrids({ entries, targetHour, context, decoded }) {
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour) || hour <= 0) {
    return new Map();
  }
  const payload = cumulativeSnowfallCachePayload({ entries, targetHour: hour, context });
  const cachePath = cumulativeSnowfallGridCachePath(payload, context);
  const cacheKey = cachePath || null;
  const cached = cacheKey ? SNOWFALL_CUMULATIVE_PROMISE_CACHE.get(cacheKey) : null;
  if (cached) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
    return restoreSnowfallProvenanceAfterSharedPromise(cached, cachePath, payload, context);
  }
  const promise = readOrComputeCachedCumulativeSnowfallGrids({
    payload,
    cachePath,
    context,
    compute: () => computeIterativeCumulativeSnowfallGrids({ entries, targetHour: hour, context, decoded }),
  }).finally(() => {
    if (cacheKey) {
      SNOWFALL_CUMULATIVE_PROMISE_CACHE.delete(cacheKey);
    }
  });
  promise.provenanceSnapshot = () =>
    buildFrameProvenanceCacheSnapshot(context?.decodeSession, {
      families: ["snowfall-accumulation", "snowfall-profile-inputs"],
      maxTargetHour: payload.targetHour,
    });
  if (cacheKey) {
    SNOWFALL_CUMULATIVE_PROMISE_CACHE.set(cacheKey, promise);
  }
  return promise;
}

async function buildCachedDeltaSnowfallGrids({ entries, step, context, decoded }) {
  if (!step || !Array.isArray(step.chunks) || step.chunks.length === 0) {
    return new Map();
  }
  const payload = deltaSnowfallCachePayload({ entries, step, context });
  const cachePath = deltaSnowfallGridCachePath(payload, context);
  const cacheKey = cachePath || null;
  const cached = cacheKey ? SNOWFALL_DELTA_PROMISE_CACHE.get(cacheKey) : null;
  if (cached) {
    incrementProfileCounter(context.profile, "snowfallDeltaCacheHits");
    return restoreSnowfallProvenanceAfterSharedPromise(cached, cachePath, payload, context);
  }
  const promise = (async () => {
    const cachedDelta = await readCachedCumulativeSnowfallGrids(cachePath, payload, context);
    if (cachedDelta) {
      incrementProfileCounter(context.profile, "snowfallDeltaCacheHits");
      return cachedDelta;
    }
    if (cachePath) {
      const lockPath = `${cachePath}.lock`;
      const lockHandle = await tryAcquireGridCacheLock(lockPath, payload);
      if (!lockHandle) {
        const waited = await waitForCachedGrid({
          cachePath,
          payload,
          lockPath,
          context,
          read: (targetPath, expectedPayload) =>
            readCachedCumulativeSnowfallGrids(targetPath, expectedPayload, context),
          probe: probeCachedGridSidecar,
          timeoutCounter: "snowfallDeltaLockTimeouts",
        });
        if (waited) {
          incrementProfileCounter(context.profile, "snowfallDeltaCacheHits");
          return waited;
        }
      } else {
        try {
          const cachedAfterLock = await readCachedCumulativeSnowfallGrids(cachePath, payload, context);
          if (cachedAfterLock) {
            incrementProfileCounter(context.profile, "snowfallDeltaCacheHits");
            return cachedAfterLock;
          }
          incrementProfileCounter(context.profile, "snowfallDeltaCacheMisses");
          const computed = await buildDeltaSnowfallGrids({
            entries,
            chunks: step.chunks,
            targetHour: step.endHour,
            context,
            decoded,
          });
          await writeCachedCumulativeSnowfallGrids(cachePath, payload, computed, context);
          return computed;
        } finally {
          await releaseGridCacheLock(lockPath, lockHandle);
        }
      }
    }
    incrementProfileCounter(context.profile, "snowfallDeltaCacheMisses");
    const computed = await buildDeltaSnowfallGrids({
      entries,
      chunks: step.chunks,
      targetHour: step.endHour,
      context,
      decoded,
    });
    await writeCachedCumulativeSnowfallGrids(cachePath, payload, computed, context);
    return computed;
  })().finally(() => {
    if (cacheKey) {
      SNOWFALL_DELTA_PROMISE_CACHE.delete(cacheKey);
    }
  });
  promise.provenanceSnapshot = () =>
    buildFrameProvenanceCacheSnapshot(context?.decodeSession, {
      families: ["snowfall-accumulation", "snowfall-profile-inputs"],
      maxTargetHour: payload.targetHour,
    });
  if (cacheKey) {
    SNOWFALL_DELTA_PROMISE_CACHE.set(cacheKey, promise);
  }
  return promise;
}

function deltaSnowfallCachePayload({ entries, step, context }) {
  return {
    version: SNOWFALL_DELTA_GRID_CACHE_VERSION,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    forecastHourRosterIdentity: buildBoundedForecastHourRosterIdentity(context, step.endHour),
    startHour: Math.round(Number(step.startHour)),
    targetHour: Math.round(Number(step.endHour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    entries: entries
      .map((entry) => ({
        key: entry.key,
        methodVersion: entry.methodVersion || null,
        artifactRequired: entry.artifactRequired || null,
        artifact: snowArtifactCacheIdentity(entry.artifactRequired),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    chunks: (step.chunks || []).map(deltaSnowfallChunkIdentity),
  };
}

function deltaSnowfallChunkIdentity(chunk) {
  return {
    key: chunk?.key || "",
    kind: chunk?.kind || "",
    startHour: Math.round(Number(chunk?.startHour)),
    endHour: Math.round(Number(chunk?.endHour)),
    profileHour: Math.round(Number(chunk?.profileHour)),
    terms: (chunk?.terms || []).map((term) => ({
      sourceKey: term?.sourceKey || "",
      kind: term?.kind || "",
      hour: Math.round(Number(term?.hour)),
      weight: Number(term?.weight) || 0,
      record: selectedPrecipRecordIdentity(term?.record),
      maskRecords: Object.fromEntries(
        Object.entries(term?.maskRecords || {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, record]) => [key, selectedPrecipRecordIdentity(record)]),
      ),
      maskSamples: (term?.maskSamples || []).map(snowMaskSampleIdentity),
    })),
  };
}

function deltaSnowfallCacheKey(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function deltaSnowfallGridCachePath(payload, context) {
  const cacheDir = context?.deltaGridCacheDir;
  if (!cacheDir || !payload) {
    return null;
  }
  const hash = deltaSnowfallCacheKey(payload).slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(payload.targetHour)}-${hash}`,
  );
}

function cumulativeSnowfallCachePayload({ entries, targetHour, context }) {
  return {
    version: SNOWFALL_CUMULATIVE_GRID_CACHE_VERSION,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    forecastHourRosterIdentity: buildBoundedForecastHourRosterIdentity(context, targetHour),
    targetHour: Math.round(Number(targetHour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    entries: entries
      .map((entry) => ({
        key: entry.key,
        methodVersion: entry.methodVersion || null,
        artifactRequired: entry.artifactRequired || null,
        artifact: snowArtifactCacheIdentity(entry.artifactRequired),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function cumulativeSnowfallCacheKey(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function cumulativeSnowfallGridCachePath(payload, context) {
  const cacheDir = context?.cumulativeGridCacheDir;
  if (!cacheDir || !payload) {
    return null;
  }
  const hash = cumulativeSnowfallCacheKey(payload).slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(payload.targetHour)}-${hash}`,
  );
}

async function readOrComputeCachedCumulativeSnowfallGrids({ payload, cachePath, context, compute }) {
  const cached = await readCachedCumulativeSnowfallGrids(cachePath, payload, context);
  if (cached) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
    return cached;
  }
  if (!cachePath) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheMisses");
    return compute();
  }
  if (Number(payload?.targetHour) < SNOWFALL_CUMULATIVE_GRID_LOCK_MIN_HOUR) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheMisses");
    const computed = await compute();
    await writeCachedCumulativeSnowfallGrids(cachePath, payload, computed, context);
    return computed;
  }
  const lockPath = `${cachePath}.lock`;
  const lockHandle = await tryAcquireGridCacheLock(lockPath, payload);
  if (!lockHandle) {
    const waited = await waitForCachedCumulativeSnowfallGrids(cachePath, payload, context);
    if (waited) {
      incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
      return waited;
    }
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheMisses");
    return compute();
  }
  try {
    const cachedAfterLock = await readCachedCumulativeSnowfallGrids(cachePath, payload, context);
    if (cachedAfterLock) {
      incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
      return cachedAfterLock;
    }
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheMisses");
    const computed = await compute();
    await writeCachedCumulativeSnowfallGrids(cachePath, payload, computed, context);
    return computed;
  } finally {
    await releaseGridCacheLock(lockPath, lockHandle);
  }
}

async function waitForCachedCumulativeSnowfallGrids(cachePath, payload, context) {
  return waitForCachedGrid({
    cachePath,
    payload,
    lockPath: `${cachePath}.lock`,
    context,
    read: (targetPath, expectedPayload) => readCachedCumulativeSnowfallGrids(targetPath, expectedPayload, context),
    probe: probeCachedGridSidecar,
    timeoutCounter: "snowfallCumulativeLockTimeouts",
  });
}

async function readCachedCumulativeSnowfallGrids(cachePath, expectedPayload, context = null) {
  if (!cachePath) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    if (!cacheMetadataPayloadMatches(metadata, expectedPayload)) {
      return null;
    }
    const body = await fs.promises.readFile(`${cachePath}.bin`);
    const out = new Map();
    const expectedGridBytes = Math.round(Number(expectedPayload?.width) * Number(expectedPayload?.height) * 4);
    let expectedByteOffset = 0;
    for (const grid of metadata.grids || []) {
      const byteOffset = Number(grid.byteOffset);
      const byteLength = Number(grid.byteLength);
      const key = grid.key;
      if (
        !key ||
        !Number.isFinite(byteOffset) ||
        !Number.isFinite(byteLength) ||
        byteOffset < 0 ||
        byteLength !== expectedGridBytes ||
        byteOffset !== expectedByteOffset ||
        byteOffset + byteLength > body.byteLength ||
        byteOffset % 4 !== 0 ||
        byteLength % 4 !== 0
      ) {
        return null;
      }
      if (out.has(key)) {
        return null;
      }
      out.set(key, float32ArrayViewFromBuffer(body, byteOffset, byteLength));
      expectedByteOffset += byteLength;
    }
    if (expectedByteOffset !== body.byteLength) {
      return null;
    }
    restoreFrameProvenanceCacheSnapshot(context?.decodeSession, metadata.provenanceSnapshot);
    return out;
  } catch {
    return null;
  }
}

async function writeCachedCumulativeSnowfallGrids(cachePath, payload, grids, context = null) {
  if (!cachePath || !(grids instanceof Map)) {
    return false;
  }
  const entries = Array.from(grids.entries()).filter(([, values]) => values instanceof Float32Array);
  const gridMetadata = [];
  let byteOffset = 0;
  for (const [key, values] of entries) {
    const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    gridMetadata.push({ key, byteOffset, byteLength: body.byteLength });
    byteOffset += body.byteLength;
  }
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  // Cache persistence is best-effort: a failed write must degrade to a
  // warn-and-recompute, never discard the already-computed grids (mirrors
  // writeCachedFloatGrid).
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    await writeFloatGridEntriesBinary(`${tmp}.bin`, entries);
    await fs.promises.writeFile(
      `${tmp}.json`,
      JSON.stringify(
        cacheMetadataWithPayload(payload, {
          grids: gridMetadata,
          provenanceSnapshot: buildFrameProvenanceCacheSnapshot(context?.decodeSession, {
            families: ["snowfall-accumulation", "snowfall-profile-inputs"],
            maxTargetHour: payload.targetHour,
          }),
        }),
      ),
    );
    await fs.promises.rename(`${tmp}.bin`, `${cachePath}.bin`);
    await fs.promises.rename(`${tmp}.json`, `${cachePath}.json`);
    return true;
  } catch (error) {
    await fs.promises.rm(`${tmp}.bin`, { force: true }).catch(() => {});
    await fs.promises.rm(`${tmp}.json`, { force: true }).catch(() => {});
    console.warn(
      `[noaa-beta] cumulative snowfall grid cache write failed for ${cachePath}: ${String(error?.message || error)}`,
    );
    return false;
  }
}

async function computeCumulativeSnowfallGrids({ entries, targetHour, context, decoded }) {
  const step = await resolveSnowfallAccumulationStep(context, targetHour);
  if (!step) {
    return new Map();
  }
  const previous =
    step.startHour > 0
      ? await buildCachedCumulativeSnowfallGrids({ entries, targetHour: step.startHour, context, decoded })
      : new Map();
  const delta = await buildCachedDeltaSnowfallGrids({ entries, step, context, decoded });
  return mergeCumulativeSnowfallGrids({ entries, previous, delta, width: context.width, height: context.height });
}

async function computeIterativeCumulativeSnowfallGrids({ entries, targetHour, context, decoded }) {
  const step = await resolveSnowfallAccumulationStep(context, targetHour);
  if (!step) {
    return new Map();
  }
  let previous = new Map();
  if (step.startHour > 0) {
    previous =
      (await readCachedCumulativeSnowfallGridsForHour({
        entries,
        targetHour: step.startHour,
        context,
        countHit: true,
      })) || (await buildCachedCumulativeSnowfallGrids({ entries, targetHour: step.startHour, context, decoded }));
  }
  const delta = await buildCachedDeltaSnowfallGrids({ entries, step, context, decoded });
  return mergeCumulativeSnowfallGrids({ entries, previous, delta, width: context.width, height: context.height });
}

async function readCachedCumulativeSnowfallGridsForHour({ entries, targetHour, context, countHit = false }) {
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour) || hour <= 0) {
    return null;
  }
  const payload = cumulativeSnowfallCachePayload({ entries, targetHour: hour, context });
  const cachePath = cumulativeSnowfallGridCachePath(payload, context);
  const cached = await readCachedCumulativeSnowfallGrids(cachePath, payload, context);
  if (cached && countHit) {
    incrementProfileCounter(context.profile, "snowfallCumulativeCacheHits");
  }
  return cached;
}

async function resolveSnowfallAccumulationStep(context, targetHour) {
  const target = Math.round(Number(targetHour));
  if (!Number.isFinite(target) || target <= 0) {
    return null;
  }
  const starts = context.availableHours
    .map((hour) => Math.round(Number(hour)))
    .filter((hour) => Number.isFinite(hour) && hour >= 0 && hour < target)
    .sort((left, right) => right - left);
  for (const startHour of starts) {
    const chunks = await resolveSnowfallLiquidChunksForWindow(context, startHour, target);
    if (chunks.length > 0) {
      if (startHour > 0) {
        const prefixChunks = await resolveSnowfallLiquidChunksForWindow(context, 0, startHour);
        if (prefixChunks.length === 0) {
          continue;
        }
      }
      return { startHour, endHour: target, chunks };
    }
  }
  return null;
}

async function buildDeltaSnowfallGrids({ entries, chunks, targetHour = null, context, decoded }) {
  const sourceRefs = chunks.flatMap((chunk) => chunk.terms);
  const resolvedTargetHour = Number.isFinite(Number(targetHour)) ? Number(targetHour) : context?.targetHour;
  for (const entry of entries || []) {
    registerTemporalProvenanceDerivation(context.decodeSession, {
      family: "snowfall-accumulation",
      outputKey: entry?.key,
      // Use this cached delta's own endpoint, not the outer frame endpoint.
      // Recursive cold builds and restored warm-prefix sidecars then record the
      // same temporal chain (for example F003 followed by F006).
      targetHour: resolvedTargetHour,
      terms: sourceRefs,
    });
  }
  const sourceGrids = await decodeSnowLiquidSourceGrids(sourceRefs, context);
  const liquidByChunk = buildSnowfallLiquidInByChunk(chunks, sourceGrids, context.width, context.height);
  sourceGrids.clear();
  const cellCount = Number(context.width) * Number(context.height);
  if (hasIncompleteLiquidChunks(chunks, liquidByChunk, cellCount)) {
    liquidByChunk.clear();
    return buildUnknownSnowfallDeltaGrids(entries, cellCount);
  }
  const snowfallChunkDescriptors = buildLiquidChunkDescriptors({
    chunks,
    liquidByChunk,
    width: context.width,
    height: context.height,
    threshold: 0,
  });
  const positiveChunks = snowfallChunkDescriptors
    .filter((descriptor) => Number(descriptor.positiveCount) > 0)
    .map((descriptor) => descriptor.chunk);
  if (context.profile) {
    context.profile.snowfallIntervalCount = (Number(context.profile.snowfallIntervalCount) || 0) + chunks.length;
    context.profile.snowfallIntervalActiveCount =
      (Number(context.profile.snowfallIntervalActiveCount) || 0) + positiveChunks.length;
    context.profile.snowfallIntervalActiveCells =
      (Number(context.profile.snowfallIntervalActiveCells) || 0) +
      snowfallChunkDescriptors.reduce(
        (total, descriptor) => total + activeDescriptorCellCount(descriptor, context.width * context.height),
        0,
      );
    context.profile.snowfallIntervalSourceRefs =
      (Number(context.profile.snowfallIntervalSourceRefs) || 0) +
      chunks.reduce((total, chunk) => total + chunk.terms.length, 0);
  }
  if (snowfallChunkDescriptors.length === 0) {
    liquidByChunk.clear();
    return new Map();
  }
  let profilesByHour = null;
  try {
    profilesByHour = await decodeIntervalSnowfallProfiles({
      entries,
      chunks: positiveChunks,
      targetHour: resolvedTargetHour,
      context,
      decoded,
    });
    return buildIntervalSnowfallGridsForEntries({
      entries,
      chunkDescriptors: snowfallChunkDescriptors,
      profilesByHour,
      decoded,
      bounds: context.bounds,
      width: context.width,
      height: context.height,
    });
  } finally {
    liquidByChunk.clear();
    profilesByHour?.clear?.();
  }
}

function buildUnknownSnowfallDeltaGrids(entries, cellCount) {
  const out = new Map();
  if (!Array.isArray(entries) || !Number.isFinite(cellCount) || cellCount <= 0) {
    return out;
  }
  for (const entry of entries) {
    if (entry?.key) {
      out.set(entry.key, new Float32Array(cellCount).fill(Number.NaN));
    }
  }
  return out;
}

function mergeCumulativeSnowfallGrids({ entries, previous, delta, width, height }) {
  const cellCount = Number(width) * Number(height);
  const out = new Map();
  if (!Number.isFinite(cellCount) || cellCount <= 0) {
    return out;
  }
  for (const entry of entries) {
    const previousGrid = previous.get(entry.key);
    const deltaGrid = delta.get(entry.key);
    if (previousGrid && deltaGrid) {
      out.set(entry.key, sumSnowfallGrids(previousGrid, deltaGrid, cellCount));
    } else if (previousGrid) {
      out.set(entry.key, previousGrid);
    } else if (deltaGrid) {
      out.set(entry.key, deltaGrid);
    }
  }
  return out;
}

function sumSnowfallGrids(previousGrid, deltaGrid, cellCount) {
  if (!previousGrid || !deltaGrid || previousGrid.length !== cellCount || deltaGrid.length !== cellCount) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const previous = Number(previousGrid[index]);
    const delta = Number(deltaGrid[index]);
    if (Number.isFinite(previous) && Number.isFinite(delta)) {
      out[index] = Math.max(0, previous) + Math.max(0, delta);
    }
  }
  return out;
}

module.exports = {
  SNOWFALL_CUMULATIVE_GRID_CACHE_VERSION,
  SNOWFALL_CUMULATIVE_GRID_LOCK_MIN_HOUR,
  SNOWFALL_CUMULATIVE_PROMISE_CACHE,
  SNOWFALL_DELTA_GRID_CACHE_VERSION,
  SNOWFALL_DELTA_PROMISE_CACHE,
  buildCachedCumulativeSnowfallGrids,
  buildCachedDeltaSnowfallGrids,
  buildCachedIterativeCumulativeSnowfallGrids,
  buildDeltaSnowfallGrids,
  buildUnknownSnowfallDeltaGrids,
  computeCumulativeSnowfallGrids,
  computeIterativeCumulativeSnowfallGrids,
  cumulativeSnowfallCacheKey,
  cumulativeSnowfallCachePayload,
  cumulativeSnowfallGridCachePath,
  deltaSnowfallCacheKey,
  deltaSnowfallCachePayload,
  deltaSnowfallChunkIdentity,
  deltaSnowfallGridCachePath,
  mergeCumulativeSnowfallGrids,
  readCachedCumulativeSnowfallGrids,
  readCachedCumulativeSnowfallGridsForHour,
  readOrComputeCachedCumulativeSnowfallGrids,
  // Aliases of the shared cache-io lock helpers (kept for winter.js
  // re-exports); the stale local copies were removed.
  releaseSnowfallCumulativeGridLock: releaseGridCacheLock,
  resolveSnowfallAccumulationStep,
  restoreSnowfallProvenanceAfterSharedPromise,
  sumSnowfallGrids,
  tryAcquireSnowfallCumulativeGridLock: tryAcquireGridCacheLock,
  waitForCachedCumulativeSnowfallGrids,
  writeCachedCumulativeSnowfallGrids,
};
