"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { incrementProfileCounter } = require("./util");
const { float32ArrayViewFromBuffer } = require("./grid-ops");
const {
  CATALOG_VERSION,
  SELECTED_GRIB_CACHE_DIRNAME,
  decodeSelectedRecordsToGrids,
  getNoaaRecordsForHour,
  getSelectedRecordPlan,
  materializeSelectedGrib,
  readDecodedRecordsForKeyedRecords,
  readOrFetchNoaaContentLengthCached,
  readRegisteredSourceGrid,
  registerSourceGrid,
  repairNoaaIdxFinalRecordRanges,
  selectedGribSharedCacheDir,
  selectedPrecipRecordIdentity,
} = require("./grib-source");
const { findRecord, isSurfacePrecipRecord, parseAccumulationWindow } = require("./records");
const {
  GRID_CACHE_LOCK_POLL_MS,
  GRID_CACHE_LOCK_TIMEOUT_MS,
  cacheMetadataWithPayload,
  directCacheMetadataPayloadMatches,
  mapWithConcurrency,
  padHour,
  pathExists,
  readCachedFloatGrid,
  recordProfileStage,
  releaseGridCacheLock,
  sanitizePathToken,
  tryAcquireGridCacheLock,
  waitForCachedGrid,
  writeCachedFloatGrid,
} = require("./cache-io");
const { buildNoaaGribUrl } = require("./model-config");
const { RUN_MAX_ACCUMULATION_SOURCES } = require("./selection");
const { sleep } = require("../local-artifact-options");

const RUN_MAX_GRID_PROMISE_CACHE = new Map();

const RUN_MAX_SOURCE_GRID_PROMISE_CACHE = new Map();

const PRECIP_ACCUM_GRID_CACHE_VERSION = "precip-accum-grid-v2";

const RUN_MAX_GRID_CACHE_VERSION = "run-max-grid-v1";

async function buildPrecipAccumulationGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
}) {
  const entries = getPrecipAccumulationEntries();
  if (entries.length === 0) {
    return {};
  }
  const availableHours = resolveAvailableForecastHours(latestMetadata, targetHour, modelKey);
  const context = {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    availableHours,
    availableHourSet: new Set(availableHours),
    recordsByHour: new Map([[Number(targetHour), currentRecords || []]]),
    intervalsByHour: new Map(),
    intervalSumPlanCache: new Map(),
    cumulativePlanCache: new Map(),
    precipAccumulationPlanCache: new Map(),
    runAccumulationPlannerReady: false,
    runAccumulationPlansByKey: new Map(),
    sourceGridOverrides: buildPrecipSourceGridOverrides({ targetHour, decoded, selection }),
    sourceGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "precip-accum-grids") : null,
    sourceGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
    profile,
    decodeSession,
  };
  let stageStartedAt = performance.now();
  const warmedPlans = await warmPrecipAccumulationRunPlanner(context);
  const plans = {};
  const sourceRefs = [];
  for (const entry of entries) {
    const plan = warmedPlans?.has(entry.key)
      ? warmedPlans.get(entry.key)
      : await resolvePrecipAccumulationPlan(entry, context);
    if (!plan) {
      continue;
    }
    plans[entry.key] = plan;
    sourceRefs.push(...plan.terms);
  }
  recordProfileStage(profile, "precipAccumPlanMs", stageStartedAt);
  if (Object.keys(plans).length === 0) {
    return {};
  }
  if (profile) {
    profile.precipAccumSourceRefs = sourceRefs.length;
  }
  stageStartedAt = performance.now();
  const sourceGrids = await decodePrecipAccumulationSourceGrids(sourceRefs, context);
  recordProfileStage(profile, "precipAccumSourceMs", stageStartedAt);
  const out = {};
  stageStartedAt = performance.now();
  for (const [key, plan] of Object.entries(plans)) {
    const grid = composePrecipAccumulationGrid(plan.terms, sourceGrids, width, height);
    if (grid) {
      out[key] = grid;
    }
  }
  recordProfileStage(profile, "precipAccumComposeMs", stageStartedAt);
  return out;
}

function getPrecipAccumulationEntries() {
  return NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.kind === "precipAccumulation");
}

async function buildRunMaxAccumulationGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
}) {
  const available = new Set(selection?.availableParameters || []);
  const entries = Object.entries(RUN_MAX_ACCUMULATION_SOURCES).filter(([key]) => available.has(key));
  const target = Math.round(Number(targetHour));
  if (entries.length === 0 || !Number.isFinite(target) || target <= 0) {
    return {};
  }
  const context = {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour: target,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    availableHours: resolveAvailableForecastHours(latestMetadata, target, modelKey),
    recordsByHour: new Map([[target, currentRecords || []]]),
    sourceGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "run-max-source-grids") : null,
    sourceGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    cumulativeGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "run-max-cumulative-grids") : null,
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
    profile,
    decodeSession,
  };
  const startedAt = performance.now();
  const pairs = await mapWithConcurrency(entries, Math.min(entries.length, 2), async ([key, source]) => {
    const grid = await readOrBuildCachedRunMaxGrid({ key, source, hour: target, context, decoded });
    return grid ? [key, grid] : null;
  });
  recordProfileStage(profile, "runMaxAccumMs", startedAt);
  return Object.fromEntries(pairs.filter(Boolean));
}

async function buildRunMaxPrefixOnlyGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  targetHour,
  currentRecords,
  latestMetadata,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  decoded,
  selection,
  profile = null,
  decodeSession = null,
}) {
  const available = new Set(selection?.availableParameters || []);
  const entries = Object.entries(RUN_MAX_ACCUMULATION_SOURCES).filter(([key]) => available.has(key));
  const target = Math.round(Number(targetHour));
  if (entries.length === 0 || !Number.isFinite(target) || target <= 0) {
    return new Map();
  }
  const context = {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour: target,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    availableHours: resolveAvailableForecastHours(latestMetadata, target, modelKey),
    recordsByHour: new Map([[target, currentRecords || []]]),
    sourceGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "run-max-source-grids") : null,
    sourceGribCacheDir: selectedGribSharedCacheDir(rawCacheDir),
    cumulativeGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "run-max-cumulative-grids") : null,
    sourceIndexCacheDir: rawCacheDir ? path.join(rawCacheDir, "idx") : null,
    profile,
    decodeSession,
  };
  const startedAt = performance.now();
  await mapWithConcurrency(entries, Math.min(entries.length, 2), ([key, source]) =>
    buildCachedIterativeRunMaxGrid({ key, source, hour: target, context, decoded }),
  );
  recordProfileStage(profile, "runMaxAccumMs", startedAt);
  return new Map();
}

async function readOrBuildCachedRunMaxGrid({ key, source, hour, context, decoded }) {
  return buildCachedIterativeRunMaxGrid({ key, source, hour, context, decoded });
}

async function buildCachedIterativeRunMaxGrid({ key, source, hour, context, decoded }) {
  return readOrComputeCachedRunMaxGrid({
    key,
    source,
    hour,
    context,
    compute: async ({ target, targetRecord, cellCount }) => {
      const previousHour = previousRunMaxSourceHour(context, target);
      let previousGrid = null;
      if (previousHour !== null) {
        previousGrid =
          (await readCachedRunMaxGridForHour({ key, source, hour: previousHour, context, countHit: true })) ||
          (await buildCachedIterativeRunMaxGrid({ key, source, hour: previousHour, context, decoded }));
      }
      const sourceGrid = await readOrDecodeRunMaxSourceGrid({
        key,
        source,
        hour: target,
        record: targetRecord,
        context,
        decoded,
      });
      return composeRunMaxGrid([previousGrid, sourceGrid], cellCount);
    },
  });
}

async function readOrComputeCachedRunMaxGrid({ key, source, hour, context, compute }) {
  const target = Math.round(Number(hour));
  if (!Number.isFinite(target) || target <= 0) {
    return null;
  }
  const targetRecord = await findRunMaxSourceRecord(source, target, context);
  const payload = runMaxCumulativeGridPayload({ key, source, hour: target, record: targetRecord, context });
  const cachePath = runMaxGridCachePath(context.cumulativeGridCacheDir, payload, context);
  const cacheKey = cachePath || crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const existing = RUN_MAX_GRID_PROMISE_CACHE.get(cacheKey);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    const cellCount = Math.round(Number(context.width) * Number(context.height));
    const cached = await readCachedFloatGrid(cachePath, payload, cellCount);
    if (cached) {
      incrementProfileCounter(context.profile, "runMaxGridCacheHits");
      return cached;
    }
    const build = async () => {
      incrementProfileCounter(context.profile, "runMaxGridCacheMisses");
      const grid = await compute({ target, targetRecord, cellCount });
      if (grid) {
        await writeCachedFloatGrid(cachePath, payload, grid);
      }
      return grid;
    };
    if (!cachePath) {
      return build();
    }
    const lockPath = `${cachePath}.lock`;
    const lockHandle = await tryAcquireGridCacheLock(lockPath, payload);
    if (!lockHandle) {
      const waited = await waitForCachedGrid({
        cachePath,
        payload,
        lockPath,
        context,
        read: (targetPath, expectedPayload) => readCachedFloatGrid(targetPath, expectedPayload, cellCount),
        timeoutCounter: "runMaxGridLockTimeouts",
      });
      if (waited) {
        incrementProfileCounter(context.profile, "runMaxGridCacheHits");
        return waited;
      }
      return build();
    }
    try {
      const cachedAfterLock = await readCachedFloatGrid(cachePath, payload, cellCount);
      if (cachedAfterLock) {
        incrementProfileCounter(context.profile, "runMaxGridCacheHits");
        return cachedAfterLock;
      }
      return build();
    } finally {
      await releaseGridCacheLock(lockPath, lockHandle);
    }
  })().finally(() => {
    RUN_MAX_GRID_PROMISE_CACHE.delete(cacheKey);
  });
  RUN_MAX_GRID_PROMISE_CACHE.set(cacheKey, promise);
  return promise;
}

async function readCachedRunMaxGridForHour({ key, source, hour, context, countHit = false }) {
  const target = Math.round(Number(hour));
  if (!Number.isFinite(target) || target <= 0) {
    return null;
  }
  const targetRecord = await findRunMaxSourceRecord(source, target, context);
  const payload = runMaxCumulativeGridPayload({ key, source, hour: target, record: targetRecord, context });
  const cachePath = runMaxGridCachePath(context.cumulativeGridCacheDir, payload, context);
  const cellCount = Math.round(Number(context.width) * Number(context.height));
  const cached = await readCachedFloatGrid(cachePath, payload, cellCount);
  if (cached && countHit) {
    incrementProfileCounter(context.profile, "runMaxGridCacheHits");
  }
  return cached;
}

function previousRunMaxSourceHour(context, targetHour) {
  let previous = null;
  for (const hour of context.availableHours || []) {
    const candidate = Math.round(Number(hour));
    if (Number.isFinite(candidate) && candidate > 0 && candidate < targetHour) {
      previous = candidate;
    }
  }
  return previous;
}

async function findRunMaxSourceRecord(source, hour, context) {
  const records = await getNoaaRecordsForHour(context, hour);
  return findRecord(records || [], source.selector);
}

async function readOrDecodeRunMaxSourceGrid({ key, source, hour, record, context, decoded }) {
  const target = Math.round(Number(hour));
  const cellCount = Math.round(Number(context.width) * Number(context.height));
  if (target === Math.round(Number(context.targetHour)) && decoded?.[source.sourceKey]) {
    return transformRunMaxSourceGrid(decoded[source.sourceKey], source.multiplier, cellCount);
  }
  if (!record) {
    return null;
  }
  const payload = runMaxSourceGridPayload({ key, source, hour: target, record, context });
  const cachePath = runMaxGridCachePath(context.sourceGridCacheDir, payload, context);
  const cacheKey = cachePath || crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const existing = RUN_MAX_SOURCE_GRID_PROMISE_CACHE.get(cacheKey);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    const cached = await readCachedFloatGrid(cachePath, payload, cellCount);
    if (cached) {
      incrementProfileCounter(context.profile, "runMaxSourceCacheHits");
      return cached;
    }
    const build = async () => {
      incrementProfileCounter(context.profile, "runMaxSourceCacheMisses");
      const grid = await decodeRunMaxSourceGridForHour({ source, hour: target, record, context });
      if (grid) {
        await writeCachedFloatGrid(cachePath, payload, grid);
      }
      return grid;
    };
    if (!cachePath) {
      return build();
    }
    const lockPath = `${cachePath}.lock`;
    const lockHandle = await tryAcquireGridCacheLock(lockPath, payload);
    if (!lockHandle) {
      const waited = await waitForCachedGrid({
        cachePath,
        payload,
        lockPath,
        context,
        read: (targetPath, expectedPayload) => readCachedFloatGrid(targetPath, expectedPayload, cellCount),
        timeoutCounter: "runMaxSourceLockTimeouts",
      });
      if (waited) {
        incrementProfileCounter(context.profile, "runMaxSourceCacheHits");
        return waited;
      }
      return build();
    }
    try {
      const cachedAfterLock = await readCachedFloatGrid(cachePath, payload, cellCount);
      if (cachedAfterLock) {
        incrementProfileCounter(context.profile, "runMaxSourceCacheHits");
        return cachedAfterLock;
      }
      return build();
    } finally {
      await releaseGridCacheLock(lockPath, lockHandle);
    }
  })().finally(() => {
    RUN_MAX_SOURCE_GRID_PROMISE_CACHE.delete(cacheKey);
  });
  RUN_MAX_SOURCE_GRID_PROMISE_CACHE.set(cacheKey, promise);
  return promise;
}

async function decodeRunMaxSourceGridForHour({ source, hour, record, context }) {
  const cached = readDecodedRecordsForKeyedRecords({
    recordsByKey: { [source.sourceKey]: record },
    hour,
    context,
  });
  if (cached?.[source.sourceKey]) {
    return transformRunMaxSourceGrid(
      cached[source.sourceKey],
      source.multiplier,
      Math.round(Number(context.width) * Number(context.height)),
    );
  }
  await ensureSelectedRecordByteRangesForHour({
    context,
    hour,
    selectedRecords: [record],
    profile: context.profile,
  });
  const selectedPlan = getSelectedRecordPlan([record], context.decodeSession);
  const gribPath = await materializeSelectedGrib({
    modelKey: context.modelKey,
    productKey: context.modelConfig.productKey,
    gribUrl: buildNoaaGribUrl({
      modelKey: context.modelKey,
      baseUrl: context.baseUrl,
      date: context.date,
      cycle: context.cycle,
      hour,
    }),
    recordGroups: selectedPlan.groups,
    rawCacheDir: context.sourceGribCacheDir || path.join(context.tempDir, SELECTED_GRIB_CACHE_DIRNAME),
    date: context.date,
    cycle: context.cycle,
    hour,
    cacheVersion: CATALOG_VERSION,
    rangeFetchConcurrency: context.rangeFetchConcurrency,
    rangeFetchLimiter: context.rangeFetchLimiter,
    profile: null,
    decodeSession: context.decodeSession,
  });
  const decodeTempDir = await fs.promises.mkdtemp(path.join(context.tempDir, `run-max-${padHour(hour)}-`));
  try {
    const decoded = await decodeSelectedRecordsToGrids({
      gribPath,
      selectedPlan,
      selection: { records: { [source.sourceKey]: record }, catalog: [] },
      hour,
      tempDir: decodeTempDir,
      wgrib2Path: context.wgrib2Path,
      bounds: context.bounds,
      width: context.width,
      height: context.height,
      decodeConcurrency: context.decodeConcurrency,
      profile: null,
      decodeSession: context.decodeSession,
    });
    return transformRunMaxSourceGrid(
      decoded?.[source.sourceKey],
      source.multiplier,
      Math.round(Number(context.width) * Number(context.height)),
    );
  } finally {
    await fs.promises.rm(decodeTempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function transformRunMaxSourceGrid(values, multiplier, cellCount) {
  if (!values) {
    return null;
  }
  // Every cell is assigned in the loop below, so the NaN prefill was
  // redundant.
  const out = new Float32Array(cellCount);
  const factor = Number.isFinite(Number(multiplier)) ? Number(multiplier) : 1;
  for (let index = 0; index < cellCount; index += 1) {
    const value = Number(values[index]);
    out[index] = Number.isFinite(value) ? Math.max(0, value * factor) : Number.NaN;
  }
  return out;
}

function composeRunMaxGrid(grids, cellCount) {
  const sources = (Array.isArray(grids) ? grids : []).filter(Boolean);
  if (sources.length === 0) {
    return null;
  }
  if (sources.length === 1) {
    return composeSingleRunMaxGrid(sources[0], cellCount);
  }
  if (sources.length === 2) {
    return composeTwoRunMaxGrids(sources[0], sources[1], cellCount);
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  let finiteCount = 0;
  for (const values of sources) {
    for (let index = 0; index < cellCount; index += 1) {
      const value = Number(values[index]);
      if (!Number.isFinite(value)) {
        continue;
      }
      if (!Number.isFinite(out[index]) || value > out[index]) {
        out[index] = value;
      }
      finiteCount += 1;
    }
  }
  return finiteCount > 0 ? out : null;
}

function composeSingleRunMaxGrid(values, cellCount) {
  const out = new Float32Array(cellCount).fill(Number.NaN);
  let finiteCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }
    out[index] = value;
    finiteCount += 1;
  }
  return finiteCount > 0 ? out : null;
}

function composeTwoRunMaxGrids(left, right, cellCount) {
  const out = new Float32Array(cellCount).fill(Number.NaN);
  let finiteCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const leftValue = Number(left[index]);
    const rightValue = Number(right[index]);
    const leftFinite = Number.isFinite(leftValue);
    const rightFinite = Number.isFinite(rightValue);
    if (leftFinite && rightFinite) {
      out[index] = Math.max(leftValue, rightValue);
      finiteCount += 2;
    } else if (leftFinite) {
      out[index] = leftValue;
      finiteCount += 1;
    } else if (rightFinite) {
      out[index] = rightValue;
      finiteCount += 1;
    }
  }
  return finiteCount > 0 ? out : null;
}

function runMaxCumulativeGridPayload({ key, source, hour, record, context }) {
  return {
    version: RUN_MAX_GRID_CACHE_VERSION,
    mode: "cumulative",
    key,
    sourceKey: source.sourceKey,
    multiplier: source.multiplier,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    hour: Math.round(Number(hour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    record: selectedPrecipRecordIdentity(record),
  };
}

function runMaxSourceGridPayload({ key, source, hour, record, context }) {
  return {
    version: RUN_MAX_GRID_CACHE_VERSION,
    mode: "source",
    key,
    sourceKey: source.sourceKey,
    multiplier: source.multiplier,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    hour: Math.round(Number(hour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    record: selectedPrecipRecordIdentity(record),
  };
}

function runMaxGridCachePath(cacheDir, payload, context) {
  if (!cacheDir || !payload) {
    return null;
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(payload.hour)}-${sanitizePathToken(payload.key)}-${hash}`,
  );
}

function resolveAvailableForecastHours(latestMetadata, targetHour, modelKey = null) {
  const candidates = latestMetadata?.rawLatest?.hours || latestMetadata?.noaa?.hours || latestMetadata?.hours || [];
  const hours = Array.isArray(candidates)
    ? candidates.map((hour) => Math.round(Number(hour))).filter((hour) => Number.isFinite(hour) && hour >= 0)
    : [];
  hours.push(...buildPrecipSourceForecastHours(modelKey || latestMetadata?.modelKey, targetHour));
  if (!hours.includes(Number(targetHour))) {
    hours.push(Number(targetHour));
  }
  if (!hours.includes(0)) {
    hours.push(0);
  }
  return Array.from(new Set(hours)).sort((left, right) => left - right);
}

function buildPrecipSourceForecastHours(modelKey, targetHour) {
  const target = Math.max(0, Math.round(Number(targetHour)));
  if (!Number.isFinite(target)) {
    return [];
  }
  const normalizedModel = String(modelKey || "").toLowerCase();
  const hours = [];
  if (normalizedModel === "gfs") {
    const hourlyLimit = Math.min(target, 120);
    for (let hour = 0; hour <= hourlyLimit; hour += 1) {
      hours.push(hour);
    }
    for (let hour = 123; hour <= target; hour += 3) {
      hours.push(hour);
    }
    return hours;
  }
  for (let hour = 0; hour <= target; hour += 1) {
    hours.push(hour);
  }
  return hours;
}

async function warmPrecipAccumulationRunPlanner(context) {
  if (!context) {
    return new Map();
  }
  if (context.runAccumulationPlannerReady) {
    return context.runAccumulationPlansByKey || new Map();
  }
  context.runAccumulationPlannerReady = true;
  const plans = context.runAccumulationPlansByKey || new Map();
  context.runAccumulationPlansByKey = plans;
  for (const entry of getPrecipAccumulationEntries()) {
    const plan = await resolvePrecipAccumulationPlan(entry, context);
    plans.set(entry.key, plan);
  }
  return plans;
}

async function resolvePrecipAccumulationPlan(entry, context) {
  const cacheKey = precipAccumulationPlanCacheKey(entry, context);
  if (cacheKey && context?.precipAccumulationPlanCache?.has(cacheKey)) {
    return context.precipAccumulationPlanCache.get(cacheKey);
  }
  const plan = await resolvePrecipAccumulationPlanUncached(entry, context);
  if (cacheKey) {
    context?.precipAccumulationPlanCache?.set(cacheKey, plan);
  }
  return plan;
}

function precipAccumulationPlanCacheKey(entry, context) {
  const key = entry?.key || "";
  const endHour = Math.round(Number(context?.targetHour));
  if (!key || !Number.isFinite(endHour)) {
    return null;
  }
  return [
    key,
    entry?.accumulationMode || "",
    Number.isFinite(Number(entry?.accumulationWindowHours)) ? Math.round(Number(entry.accumulationWindowHours)) : "",
    endHour,
  ].join(":");
}

async function resolvePrecipAccumulationPlanUncached(entry, context) {
  const endHour = Math.round(Number(context.targetHour));
  const isTotal = entry.accumulationMode === "total";
  const windowHours = Number(entry.accumulationWindowHours);
  if (!Number.isFinite(endHour) || endHour <= 0) {
    return null;
  }
  if (!isTotal && !Number.isFinite(windowHours)) {
    return null;
  }
  const startHour = isTotal ? 0 : Math.max(0, endHour - windowHours);
  if (!context.availableHourSet.has(endHour)) {
    return null;
  }

  const direct = await findExactPrecipInterval(context, startHour, endHour);
  if (direct) {
    return { terms: [precipTerm(direct, 1)] };
  }

  const cumulativeEnd = await buildCumulativePrecipPlan(context, endHour);
  if (cumulativeEnd.length > 0) {
    if (startHour === 0) {
      return { terms: cumulativeEnd };
    }
    const cumulativeStart = await buildCumulativePrecipPlan(context, startHour);
    if (cumulativeStart.length > 0) {
      return {
        terms: mergeWeightedPrecipTerms(
          cumulativeEnd,
          cumulativeStart.map((term) => ({ ...term, weight: -term.weight })),
        ),
      };
    }
  }

  const summed = await buildPrecipIntervalSumPlan(context, startHour, endHour);
  return summed.length > 0 ? { terms: summed.map((interval) => precipTerm(interval, 1)) } : null;
}

async function buildCumulativePrecipPlan(context, endHour) {
  const targetHour = Math.round(Number(endHour));
  if (!Number.isFinite(targetHour) || targetHour <= 0 || !context.availableHourSet.has(targetHour)) {
    return [];
  }
  const cacheKey = String(targetHour);
  if (context.cumulativePlanCache?.has(cacheKey)) {
    return context.cumulativePlanCache.get(cacheKey);
  }
  let terms = [];
  const direct = await findExactPrecipInterval(context, 0, targetHour);
  if (direct) {
    terms = [precipTerm(direct, 1)];
  } else {
    const endingInterval = await findBestPrecipIntervalEndingAt(context, targetHour);
    if (endingInterval) {
      const prefix = await buildCumulativePrecipPlan(context, endingInterval.startHour);
      if (prefix.length > 0 || endingInterval.startHour === 0) {
        terms = mergeWeightedPrecipTerms(prefix, [precipTerm(endingInterval, 1)]);
      }
    }
    if (terms.length === 0) {
      const summed = await buildPrecipIntervalSumPlan(context, 0, targetHour);
      terms = summed.map((interval) => precipTerm(interval, 1));
    }
  }
  context.cumulativePlanCache?.set(cacheKey, terms);
  return terms;
}

function mergeWeightedPrecipTerms(...termLists) {
  const merged = new Map();
  for (const terms of termLists) {
    for (const term of terms || []) {
      const weight = Number(term.weight) || 0;
      if (!term?.sourceKey || weight === 0) {
        continue;
      }
      const existing = merged.get(term.sourceKey);
      if (existing) {
        existing.weight += weight;
      } else {
        merged.set(term.sourceKey, { ...term, weight });
      }
    }
  }
  return Array.from(merged.values()).filter((term) => Math.abs(Number(term.weight) || 0) > 1e-9);
}

function precipTerm(interval, weight) {
  return {
    sourceKey: precipSourceKey(interval.hour, interval.record),
    hour: interval.hour,
    record: interval.record,
    weight,
  };
}

async function findExactPrecipInterval(context, startHour, endHour) {
  const intervals = await getPrecipIntervalsForHour(context, endHour);
  return intervals.find((interval) => interval.startHour === startHour && interval.endHour === endHour) || null;
}

async function findBestPrecipIntervalEndingAt(context, endHour) {
  const targetHour = Math.round(Number(endHour));
  if (!Number.isFinite(targetHour) || targetHour <= 0) {
    return null;
  }
  const intervals = await getPrecipIntervalsForHour(context, targetHour);
  return (
    intervals
      .filter(
        (interval) => interval.endHour === targetHour && interval.startHour >= 0 && interval.startHour < targetHour,
      )
      .sort((left, right) => left.startHour - right.startHour)[0] || null
  );
}

async function buildPrecipIntervalSumPlan(context, startHour, endHour) {
  const cacheKey = `${Math.round(Number(startHour))}:${Math.round(Number(endHour))}`;
  if (context.intervalSumPlanCache?.has(cacheKey)) {
    return context.intervalSumPlanCache.get(cacheKey);
  }
  const hours = context.availableHours.filter((hour) => hour > startHour && hour <= endHour);
  const intervals = [];
  for (const hour of hours) {
    intervals.push(...(await getPrecipIntervalsForHour(context, hour)));
  }
  const usable = intervals.filter((interval) => {
    return interval.startHour >= startHour && interval.endHour <= endHour && interval.endHour > interval.startHour;
  });
  const terms = [];
  let cursor = startHour;
  while (cursor < endHour) {
    const candidates = usable
      .filter((interval) => interval.startHour === cursor && interval.endHour > cursor)
      .sort((left, right) => right.endHour - left.endHour);
    const selected = candidates[0] || null;
    if (!selected) {
      context.intervalSumPlanCache?.set(cacheKey, []);
      return [];
    }
    terms.push(selected);
    cursor = selected.endHour;
  }
  const resolved = cursor === endHour ? terms : [];
  context.intervalSumPlanCache?.set(cacheKey, resolved);
  return resolved;
}

async function getPrecipIntervalsForHour(context, hour) {
  const targetHour = Math.round(Number(hour));
  if (!context.availableHourSet.has(targetHour)) {
    return [];
  }
  if (context.intervalsByHour?.has(targetHour)) {
    return context.intervalsByHour.get(targetHour);
  }
  const records = await getNoaaRecordsForHour(context, targetHour);
  const intervals = records
    .filter(isSurfacePrecipRecord)
    .map((record) => {
      const window = parseAccumulationWindow(record);
      if (!window || window.endHour < window.startHour) {
        return null;
      }
      return {
        hour: targetHour,
        record,
        startHour: window.startHour,
        endHour: window.endHour,
      };
    })
    .filter(Boolean);
  context.intervalsByHour?.set(targetHour, intervals);
  return intervals;
}

async function ensureSelectedRecordByteRangesForHour({
  context,
  hour,
  selectedRecords,
  gribUrl = null,
  profile = null,
}) {
  const selected = (Array.isArray(selectedRecords) ? selectedRecords : []).filter(Boolean);
  if (selected.length === 0 || selected.every((record) => record.rangeHeader)) {
    return;
  }
  const targetHour = Math.round(Number(hour));
  if (!Number.isFinite(targetHour)) {
    return;
  }
  let records = context?.recordsByHour?.get(targetHour) || null;
  if (!records && context?.recordsByHour) {
    records = await getNoaaRecordsForHour(context, targetHour);
  }
  if (!records) {
    records = selected;
  }
  const resolvedGribUrl =
    gribUrl ||
    buildNoaaGribUrl({
      modelKey: context.modelKey,
      baseUrl: context.baseUrl,
      date: context.date,
      cycle: context.cycle,
      hour: targetHour,
    });
  const totalBytes = await readOrFetchNoaaContentLengthCached(resolvedGribUrl, context, targetHour, profile);
  repairNoaaIdxFinalRecordRanges(records, totalBytes);
}

async function decodePrecipAccumulationSourceGrids(sourceRefs, context) {
  const unique = new Map();
  for (const ref of sourceRefs) {
    if (!unique.has(ref.sourceKey)) {
      unique.set(ref.sourceKey, ref);
    }
  }
  const out = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;
  for (const [sourceKey, values] of context.sourceGridOverrides?.entries() || []) {
    const ref = unique.get(sourceKey);
    if (ref && values) {
      out.set(sourceKey, values);
      registerSourceGrid({
        family: "precipAccum",
        payload: precipSourceGridCachePayload(ref, context),
        context,
        values,
      });
      unique.delete(sourceKey);
      cacheHits += 1;
    }
  }
  const registeredPairs = await mapWithConcurrency(
    [...unique.entries()],
    metadataFanoutConcurrency(context, 16),
    async ([sourceKey, ref]) => [
      sourceKey,
      await readRegisteredSourceGrid({
        family: "precipAccum",
        payload: precipSourceGridCachePayload(ref, context),
        context,
        counterKey: "precipAccumSourceRegistryHits",
      }),
    ],
  );
  for (const [sourceKey, registered] of registeredPairs) {
    if (registered && unique.has(sourceKey)) {
      out.set(sourceKey, registered);
      unique.delete(sourceKey);
      cacheHits += 1;
    }
  }
  const cachedPairs = await mapWithConcurrency(
    [...unique.entries()],
    metadataFanoutConcurrency(context, 16),
    async ([sourceKey, ref]) => [sourceKey, await readCachedPrecipSourceGrid(ref, context)],
  );
  for (const [sourceKey, cached] of cachedPairs) {
    if (cached && unique.has(sourceKey)) {
      const ref = unique.get(sourceKey);
      out.set(sourceKey, cached);
      registerSourceGrid({
        family: "precipAccum",
        payload: precipSourceGridCachePayload(ref, context),
        context,
        values: cached,
      });
      unique.delete(sourceKey);
      cacheHits += 1;
    }
  }
  const byHour = new Map();
  for (const ref of unique.values()) {
    const group = byHour.get(ref.hour) || [];
    group.push(ref);
    byHour.set(ref.hour, group);
  }
  await mapWithConcurrency(
    [...byHour.entries()],
    Math.min(Math.max(1, Number(context.decodeConcurrency) || 1), 4),
    async ([hour, refs]) => {
      let refsToDecode = refs;
      const lockPath = precipSourceHourLockPath(hour, context);
      const lockHandle = lockPath ? await tryAcquireGridCacheLock(lockPath, { hour, count: refs.length }) : null;
      if (lockPath && !lockHandle) {
        const waited = await waitForCachedPrecipHourSources(refs, context, lockPath);
        for (const [key, values] of waited.entries()) {
          out.set(key, values);
          const ref = refs.find((candidate) => candidate.sourceKey === key) || null;
          if (ref) {
            registerSourceGrid({
              family: "precipAccum",
              payload: precipSourceGridCachePayload(ref, context),
              context,
              values,
            });
          }
        }
        cacheHits += waited.size;
        refsToDecode = refs.filter((ref) => !waited.has(ref.sourceKey));
      }
      if (refsToDecode.length === 0) {
        return;
      }
      const decodeLockHandle =
        lockHandle || (lockPath ? await tryAcquireGridCacheLock(lockPath, { hour, count: refsToDecode.length }) : null);
      const decodedResult = decodeLockHandle
        ? await decodePrecipAccumulationHourSourcesWithLock(hour, refsToDecode, context, lockPath, decodeLockHandle)
        : {
            grids: await decodePrecipAccumulationHourSources(hour, refsToDecode, context),
            decodedKeys: new Set(refsToDecode.map((ref) => ref.sourceKey)),
            cacheHits: 0,
            cacheMisses: refsToDecode.length,
          };
      cacheHits += decodedResult.cacheHits;
      cacheMisses += decodedResult.cacheMisses;
      const writes = [];
      for (const [key, values] of decodedResult.grids.entries()) {
        out.set(key, values);
        const ref = refs.find((candidate) => candidate.sourceKey === key) || null;
        if (ref) {
          registerSourceGrid({
            family: "precipAccum",
            payload: precipSourceGridCachePayload(ref, context),
            context,
            values,
          });
        }
        if (ref && decodedResult.decodedKeys.has(key)) {
          writes.push({ ref, values });
        }
      }
      await mapWithConcurrency(writes, metadataFanoutConcurrency(context, 8), ({ ref, values }) =>
        writeCachedPrecipSourceGrid(ref, values, context),
      );
    },
  );
  if (context.profile) {
    context.profile.precipAccumSourceCount = cacheHits + cacheMisses;
    context.profile.precipAccumGridCacheHits = cacheHits;
    context.profile.precipAccumGridCacheMisses = cacheMisses;
  }
  return out;
}

async function decodePrecipAccumulationHourSourcesWithLock(hour, refs, context, lockPath, lockHandle) {
  try {
    const cached = await readCachedPrecipHourSources(refs, context);
    const refsToDecode = refs.filter((ref) => !cached.has(ref.sourceKey));
    if (refsToDecode.length === 0) {
      return { grids: cached, decodedKeys: new Set(), cacheHits: cached.size, cacheMisses: 0 };
    }
    const decoded = await decodePrecipAccumulationHourSources(hour, refsToDecode, context);
    const decodedKeys = new Set();
    for (const [key, values] of decoded.entries()) {
      cached.set(key, values);
      decodedKeys.add(key);
    }
    return {
      grids: cached,
      decodedKeys,
      cacheHits: cached.size - decodedKeys.size,
      cacheMisses: refsToDecode.length,
    };
  } finally {
    await releaseGridCacheLock(lockPath, lockHandle);
  }
}

async function decodePrecipAccumulationHourSources(hour, refs, context) {
  const records = refs.map((ref) => ref.record);
  const recordsByKey = Object.fromEntries(refs.map((ref) => [ref.sourceKey, ref.record]));
  const cached = readDecodedRecordsForKeyedRecords({ recordsByKey, hour, context });
  if (cached) {
    return new Map(Object.entries(cached));
  }
  await ensureSelectedRecordByteRangesForHour({
    context,
    hour,
    selectedRecords: records,
    profile: context.profile,
  });
  const selectedPlan = getSelectedRecordPlan(records, context.decodeSession);
  const selection = {
    records: recordsByKey,
    catalog: [],
  };
  const gribUrl = buildNoaaGribUrl({
    modelKey: context.modelKey,
    baseUrl: context.baseUrl,
    date: context.date,
    cycle: context.cycle,
    hour,
  });
  const gribPath = await materializeSelectedGrib({
    modelKey: context.modelKey,
    productKey: context.modelConfig.productKey,
    gribUrl,
    recordGroups: selectedPlan.groups,
    rawCacheDir: context.sourceGribCacheDir || path.join(context.tempDir, SELECTED_GRIB_CACHE_DIRNAME),
    date: context.date,
    cycle: context.cycle,
    hour,
    cacheVersion: CATALOG_VERSION,
    rangeFetchConcurrency: context.rangeFetchConcurrency,
    rangeFetchLimiter: context.rangeFetchLimiter,
    profile: null,
    decodeSession: context.decodeSession,
  });
  const decodeTempDir = await fs.promises.mkdtemp(path.join(context.tempDir, `precip-accum-${padHour(hour)}-`));
  const decoded = await decodeSelectedRecordsToGrids({
    gribPath,
    selectedPlan,
    selection,
    hour,
    tempDir: decodeTempDir,
    wgrib2Path: context.wgrib2Path,
    bounds: context.bounds,
    width: context.width,
    height: context.height,
    decodeConcurrency: context.decodeConcurrency,
    profile: null,
    decodeSession: context.decodeSession,
  }).finally(() => fs.promises.rm(decodeTempDir, { recursive: true, force: true }).catch(() => {}));
  return new Map(Object.entries(decoded));
}

function composePrecipAccumulationGrid(terms, sourceGrids, width, height, options = {}) {
  const cellCount = width * height;
  if (!Array.isArray(terms) || terms.length === 0) {
    return null;
  }
  const sources = terms.map((term) => ({
    weight: Number(term.weight) || 0,
    values: sourceGrids.get(term.sourceKey),
  }));
  if (sources.some((source) => !source.values || source.values.length !== cellCount)) {
    return null;
  }
  const outputScale = Number.isFinite(Number(options.outputScale)) ? Number(options.outputScale) : 1;
  if (sources.length === 1) {
    return composeSinglePrecipAccumulationGrid(sources[0], cellCount, outputScale);
  }
  if (sources.length === 2) {
    return composeTwoPrecipAccumulationGrid(sources[0], sources[1], cellCount, outputScale);
  }
  return composeManyPrecipAccumulationGrid(sources, cellCount, outputScale);
}

function composeSinglePrecipAccumulationGrid(source, cellCount, outputScale = 1) {
  const out = new Float32Array(cellCount);
  const values = source.values;
  const weight = source.weight;
  for (let index = 0; index < cellCount; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      out[index] = Number.NaN;
      continue;
    }
    const total = value * weight;
    out[index] = Math.max(0, total) * outputScale;
  }
  return out;
}

function composeTwoPrecipAccumulationGrid(left, right, cellCount, outputScale = 1) {
  const out = new Float32Array(cellCount);
  const leftValues = left.values;
  const rightValues = right.values;
  const leftWeight = left.weight;
  const rightWeight = right.weight;
  for (let index = 0; index < cellCount; index += 1) {
    const leftValue = Number(leftValues[index]);
    const rightValue = Number(rightValues[index]);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      out[index] = Number.NaN;
      continue;
    }
    out[index] = Math.max(0, leftValue * leftWeight + rightValue * rightWeight) * outputScale;
  }
  return out;
}

function composeManyPrecipAccumulationGrid(sources, cellCount, outputScale = 1) {
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    let total = 0;
    let valid = true;
    for (const source of sources) {
      const value = Number(source.values[index]);
      if (!Number.isFinite(value)) {
        valid = false;
        break;
      }
      total += value * source.weight;
    }
    if (valid) {
      out[index] = Math.max(0, total) * outputScale;
    }
  }
  return out;
}

function precipSourceKey(hour, record) {
  return `precip:${Math.round(Number(hour))}:${record?.record || ""}:${record?.forecast || ""}`;
}

function buildPrecipSourceGridOverrides({ targetHour, decoded, selection }) {
  const out = new Map();
  if (!decoded || !selection?.records) {
    return out;
  }
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour)) {
    return out;
  }
  for (const [key, record] of Object.entries(selection.records)) {
    const values = decoded[key];
    if (isSurfacePrecipRecord(record) && values) {
      out.set(precipSourceKey(hour, record), values);
    }
  }
  return out;
}

function precipSourceGridCachePath(ref, context) {
  const cacheDir = context?.sourceGridCacheDir;
  if (!cacheDir || !ref?.record) {
    return null;
  }
  const payload = precipSourceGridCachePayload(ref, context);
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(ref.hour)}-${hash}.f32`,
  );
}

function precipSourceGridCachePayload(ref, context) {
  return {
    version: PRECIP_ACCUM_GRID_CACHE_VERSION,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    hour: Math.round(Number(ref.hour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    record: selectedPrecipRecordIdentity(ref.record),
  };
}

function precipSourceHourLockPath(hour, context) {
  const cacheDir = context?.sourceGridCacheDir;
  if (!cacheDir) {
    return null;
  }
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(hour)}.lock`,
  );
}

async function waitForCachedPrecipHourSources(refs, context, lockPath) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < GRID_CACHE_LOCK_TIMEOUT_MS) {
    await sleep(GRID_CACHE_LOCK_POLL_MS + Math.round(Math.random() * 40));
    const cached = await readCachedPrecipHourSources(refs, context);
    if (cached.size === refs.length) {
      return cached;
    }
    const lockExists = await pathExists(lockPath);
    if (!lockExists) {
      return cached;
    }
  }
  incrementProfileCounter(context.profile, "precipAccumGridLockTimeouts");
  return readCachedPrecipHourSources(refs, context);
}

async function readCachedPrecipHourSources(refs, context) {
  const pairs = await mapWithConcurrency(refs, metadataFanoutConcurrency(context, 16), async (ref) => [
    ref.sourceKey,
    await readCachedPrecipSourceGrid(ref, context),
  ]);
  const out = new Map();
  for (const [sourceKey, cached] of pairs) {
    if (cached) {
      out.set(sourceKey, cached);
    }
  }
  return out;
}

async function readCachedPrecipSourceGrid(ref, context) {
  const cachePath = precipSourceGridCachePath(ref, context);
  if (!cachePath) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    const expected = precipSourceGridCachePayload(ref, context);
    if (!directCacheMetadataPayloadMatches(metadata, expected)) {
      return null;
    }
    const body = await fs.promises.readFile(cachePath);
    const expectedBytes = Number(context.width) * Number(context.height) * 4;
    if (body.length !== expectedBytes) {
      return null;
    }
    return float32ArrayViewFromBuffer(body, 0, body.byteLength);
  } catch {
    return null;
  }
}

async function writeCachedPrecipSourceGrid(ref, values, context) {
  const cachePath = precipSourceGridCachePath(ref, context);
  if (!cachePath || !values || values.length !== Number(context.width) * Number(context.height)) {
    return;
  }
  const metadata = precipSourceGridCachePayload(ref, context);
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpJson = `${tmp}.json`;
  const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  await fs.promises.writeFile(tmp, body);
  await fs.promises.writeFile(tmpJson, JSON.stringify(cacheMetadataWithPayload(metadata)));
  await fs.promises.rename(tmp, cachePath);
  await fs.promises.rename(tmpJson, `${cachePath}.json`);
}

function metadataFanoutConcurrency(context, cap = 8) {
  const decodeConcurrency = Math.max(1, Number(context?.decodeConcurrency) || 1);
  return Math.min(Math.max(4, decodeConcurrency * 2), Math.max(1, Number(cap) || 8));
}

module.exports = {
  PRECIP_ACCUM_GRID_CACHE_VERSION,
  RUN_MAX_GRID_CACHE_VERSION,
  RUN_MAX_GRID_PROMISE_CACHE,
  RUN_MAX_SOURCE_GRID_PROMISE_CACHE,
  buildCachedIterativeRunMaxGrid,
  buildCumulativePrecipPlan,
  buildPrecipAccumulationGrids,
  buildPrecipIntervalSumPlan,
  buildPrecipSourceForecastHours,
  buildPrecipSourceGridOverrides,
  buildRunMaxAccumulationGrids,
  buildRunMaxPrefixOnlyGrids,
  composeManyPrecipAccumulationGrid,
  composePrecipAccumulationGrid,
  composeRunMaxGrid,
  composeSinglePrecipAccumulationGrid,
  composeSingleRunMaxGrid,
  composeTwoPrecipAccumulationGrid,
  composeTwoRunMaxGrids,
  decodePrecipAccumulationHourSources,
  decodePrecipAccumulationHourSourcesWithLock,
  decodePrecipAccumulationSourceGrids,
  decodeRunMaxSourceGridForHour,
  ensureSelectedRecordByteRangesForHour,
  findBestPrecipIntervalEndingAt,
  findExactPrecipInterval,
  findRunMaxSourceRecord,
  getPrecipAccumulationEntries,
  getPrecipIntervalsForHour,
  mergeWeightedPrecipTerms,
  metadataFanoutConcurrency,
  precipAccumulationPlanCacheKey,
  precipSourceGridCachePath,
  precipSourceGridCachePayload,
  precipSourceHourLockPath,
  precipSourceKey,
  precipTerm,
  previousRunMaxSourceHour,
  readCachedPrecipHourSources,
  readCachedPrecipSourceGrid,
  readCachedRunMaxGridForHour,
  readOrBuildCachedRunMaxGrid,
  readOrComputeCachedRunMaxGrid,
  readOrDecodeRunMaxSourceGrid,
  resolveAvailableForecastHours,
  resolvePrecipAccumulationPlan,
  resolvePrecipAccumulationPlanUncached,
  runMaxCumulativeGridPayload,
  runMaxGridCachePath,
  runMaxSourceGridPayload,
  transformRunMaxSourceGrid,
  waitForCachedPrecipHourSources,
  warmPrecipAccumulationRunPlanner,
  writeCachedPrecipSourceGrid,
};
