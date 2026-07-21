"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { clamp01 } = require("./util");
const { float32ArrayViewFromBuffer } = require("./grid-ops");
const {
  CATALOG_VERSION,
  SELECTED_GRIB_CACHE_DIRNAME,
  buildFrameProvenanceCacheSnapshot,
  decodeSelectedRecordsToGrids,
  getSelectedRecordPlan,
  materializeSelectedGrib,
  readDecodedRecordsForKeyedRecords,
  readRegisteredSourceGrid,
  registerSourceGrid,
  restoreFrameProvenanceCacheSnapshot,
  selectedPrecipRecordIdentity,
} = require("./grib-source");
const {
  isSurfaceAccumulatedFreezingRainRecord,
  isSurfaceAccumulatedSnowWaterRecord,
  isSurfacePrecipAccumulationRecord,
  parseAccumulationWindow,
  recordsMatch,
} = require("./records");
const {
  cacheMetadataWithPayload,
  directCacheMetadataPayloadMatches,
  mapWithConcurrency,
  padHour,
  readCachedRefGridsBySourceKey,
  releaseGridCacheLock,
  sanitizePathToken,
  tryAcquireGridCacheLock,
  waitForCachedRefGrids,
} = require("./cache-io");
const { buildNoaaGribUrl } = require("./model-config");
const { buildBoundedForecastHourRosterIdentity } = require("./forecast-hour-roster");
const { SNOW_MASK_TYPE_KEYS } = require("./selection");
const { ensureSelectedRecordByteRangesForHour, metadataFanoutConcurrency } = require("./accumulation");
const { snowLiquidSourceKey } = require("./winter-liquid-planning");

const SNOW_LIQUID_GRID_CACHE_VERSION = "snow-liquid-grid-v7-forecast-hour-roster";

function snowMaskSampleIdentity(sample) {
  return {
    hour: Math.round(Number(sample?.hour)),
    weight: Number(sample?.weight) || 0,
    snow: selectedPrecipRecordIdentity(sample?.snow),
    rain: selectedPrecipRecordIdentity(sample?.rain),
    freezingRain: selectedPrecipRecordIdentity(sample?.freezingRain),
    icePellets: selectedPrecipRecordIdentity(sample?.icePellets),
  };
}

async function decodeSnowLiquidSourceGrids(sourceRefs, context) {
  const unique = new Map();
  for (const ref of sourceRefs) {
    if (!unique.has(ref.sourceKey)) {
      unique.set(ref.sourceKey, ref);
    }
  }
  const out = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;
  const prefix = context.sourceProfilePrefix || "snowLiquid";
  for (const [sourceKey, values] of context.sourceGridOverrides?.entries() || []) {
    const ref = unique.get(sourceKey);
    if (ref && values) {
      out.set(sourceKey, values);
      registerSourceGrid({
        family: "snowLiquid",
        payload: snowLiquidSourceGridCachePayload(ref, context),
        context,
        values,
        provenanceTerms: [ref],
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
        family: "snowLiquid",
        payload: snowLiquidSourceGridCachePayload(ref, context),
        context,
        counterKey: `${prefix}SourceRegistryHits`,
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
    async ([sourceKey, ref]) => [sourceKey, await readCachedSnowLiquidSourceGrid(ref, context)],
  );
  for (const [sourceKey, cached] of cachedPairs) {
    if (cached && unique.has(sourceKey)) {
      const ref = unique.get(sourceKey);
      out.set(sourceKey, cached);
      registerSourceGrid({
        family: "snowLiquid",
        payload: snowLiquidSourceGridCachePayload(ref, context),
        context,
        values: cached,
        provenanceTerms: [ref],
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
  await mapWithConcurrency([...byHour.entries()], decodeHourFanoutConcurrency(context, 6), async ([hour, refs]) => {
    let refsToDecode = refs;
    const lockPath = snowLiquidSourceHourLockPath(hour, context);
    const lockHandle = lockPath ? await tryAcquireGridCacheLock(lockPath, { hour, count: refs.length }) : null;
    if (lockPath && !lockHandle) {
      const waited = await waitForCachedSnowLiquidHourSources(refs, context, lockPath);
      for (const [key, values] of waited.entries()) {
        out.set(key, values);
        const ref = refs.find((candidate) => candidate.sourceKey === key) || null;
        if (ref) {
          registerSourceGrid({
            family: "snowLiquid",
            payload: snowLiquidSourceGridCachePayload(ref, context),
            context,
            values,
            provenanceTerms: [ref],
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
      ? await decodeSnowLiquidHourSourcesWithLock(hour, refsToDecode, context, lockPath, decodeLockHandle)
      : {
          grids: await decodeSnowLiquidHourSources(hour, refsToDecode, context),
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
          family: "snowLiquid",
          payload: snowLiquidSourceGridCachePayload(ref, context),
          context,
          values,
          provenanceTerms: [ref],
        });
      }
      if (ref && decodedResult.decodedKeys.has(key)) {
        writes.push({ ref, values });
      }
    }
    await mapWithConcurrency(writes, metadataFanoutConcurrency(context, 8), ({ ref, values }) =>
      writeCachedSnowLiquidSourceGrid(ref, values, context),
    );
  });
  if (context.profile) {
    context.profile[`${prefix}SourceCount`] = cacheHits + cacheMisses;
    context.profile[`${prefix}GridCacheHits`] = cacheHits;
    context.profile[`${prefix}GridCacheMisses`] = cacheMisses;
  }
  return out;
}

async function decodeSnowLiquidHourSourcesWithLock(hour, refs, context, lockPath, lockHandle) {
  try {
    const cached = await readCachedSnowLiquidHourSources(refs, context);
    const refsToDecode = refs.filter((ref) => !cached.has(ref.sourceKey));
    if (refsToDecode.length === 0) {
      return { grids: cached, decodedKeys: new Set(), cacheHits: cached.size, cacheMisses: 0 };
    }
    const decoded = await decodeSnowLiquidHourSources(hour, refsToDecode, context);
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

async function decodeSnowLiquidHourSources(hour, refs, context) {
  const recordsByHour = new Map();
  const keyByHourRecord = new Map();
  const decodeKeysBySource = new Map();
  const assignRecordKey = (record, suffix, sourceHour = hour) => {
    if (!record) {
      return null;
    }
    const resolvedHour = Math.round(Number(sourceHour));
    const identity = `${resolvedHour}:${record.record || `${record.param}:${record.level}:${record.forecast}`}`;
    if (keyByHourRecord.has(identity)) {
      return keyByHourRecord.get(identity);
    }
    const recordsByKey = recordsByHour.get(resolvedHour) || {};
    const key = `snowLiquid${padHour(resolvedHour)}_${Object.keys(recordsByKey).length}_${suffix}`;
    keyByHourRecord.set(identity, key);
    recordsByKey[key] = record;
    recordsByHour.set(resolvedHour, recordsByKey);
    return key;
  };
  for (const ref of refs) {
    const decodeKeys = { water: assignRecordKey(ref.record, ref.kind === "weasd" ? "weasd" : "apcp") };
    if (ref.maskTargetKey) {
      const samples =
        Array.isArray(ref.maskSamples) && ref.maskSamples.length > 0
          ? ref.maskSamples
          : [{ hour, weight: 1, ...(ref.maskRecords || {}) }];
      decodeKeys.maskSamples = samples.map((sample, index) => ({
        weight: Number(sample?.weight) || 0,
        snow: assignRecordKey(sample?.snow, `sample${index}_snow`, sample?.hour),
        rain: assignRecordKey(sample?.rain, `sample${index}_rain`, sample?.hour),
        freezingRain: assignRecordKey(sample?.freezingRain, `sample${index}_freezingRain`, sample?.hour),
        icePellets: assignRecordKey(sample?.icePellets, `sample${index}_icePellets`, sample?.hour),
      }));
    }
    decodeKeysBySource.set(ref.sourceKey, decodeKeys);
  }
  const decoded = {};
  await mapWithConcurrency(
    [...recordsByHour.entries()],
    decodeHourFanoutConcurrency(context, 6),
    async ([sourceHour, recordsByKey]) => {
      const selectedRecords = Object.values(recordsByKey).filter(Boolean);
      if (selectedRecords.length === 0) {
        return;
      }
      const cached = readDecodedRecordsForKeyedRecords({
        recordsByKey,
        hour: sourceHour,
        context,
        categoricalPrecipTypeInterpolation: false,
      });
      if (cached) {
        Object.assign(decoded, cached);
        return;
      }
      await ensureSelectedRecordByteRangesForHour({
        context,
        hour: sourceHour,
        selectedRecords,
        profile: context.profile,
      });
      const selectedPlan = getSelectedRecordPlan(selectedRecords, context.decodeSession);
      const selection = { records: recordsByKey, catalog: [] };
      const gribUrl = buildNoaaGribUrl({
        modelKey: context.modelKey,
        baseUrl: context.baseUrl,
        date: context.date,
        cycle: context.cycle,
        hour: sourceHour,
      });
      const gribPath = await materializeSelectedGrib({
        modelKey: context.modelKey,
        productKey: context.modelConfig.productKey,
        gribUrl,
        recordGroups: selectedPlan.groups,
        rawCacheDir: context.sourceGribCacheDir || path.join(context.tempDir, SELECTED_GRIB_CACHE_DIRNAME),
        date: context.date,
        cycle: context.cycle,
        hour: sourceHour,
        cacheVersion: CATALOG_VERSION,
        rangeFetchConcurrency: context.rangeFetchConcurrency,
        rangeFetchLimiter: context.rangeFetchLimiter,
        profile: null,
        decodeSession: context.decodeSession,
      });
      const decodeTempDir = await fs.promises.mkdtemp(
        path.join(context.tempDir, `snow-liquid-${padHour(sourceHour)}-`),
      );
      Object.assign(
        decoded,
        await decodeSelectedRecordsToGrids({
          gribPath,
          selectedPlan,
          selection,
          hour: sourceHour,
          tempDir: decodeTempDir,
          wgrib2Path: context.wgrib2Path,
          bounds: context.bounds,
          width: context.width,
          height: context.height,
          decodeConcurrency: context.decodeConcurrency,
          categoricalPrecipTypeInterpolation: false,
          profile: null,
          decodeSession: context.decodeSession,
        }).finally(() => fs.promises.rm(decodeTempDir, { recursive: true, force: true }).catch(() => {})),
      );
    },
  );
  const out = new Map();
  for (const ref of refs) {
    const decodeKeys = decodeKeysBySource.get(ref.sourceKey) || {};
    if (!ref.maskTargetKey) {
      if (decoded[decodeKeys.water]) {
        out.set(ref.sourceKey, decoded[decodeKeys.water]);
      }
      continue;
    }
    const grid = composePhaseMaskedPrecipGrid({
      precipMm: decoded[decodeKeys.water],
      maskSamples: (decodeKeys.maskSamples || []).map((sample) => ({
        weight: sample.weight,
        snow: decoded[sample.snow],
        rain: decoded[sample.rain],
        freezingRain: decoded[sample.freezingRain],
        icePellets: decoded[sample.icePellets],
      })),
      targetType: ref.maskTargetKey || "snow",
      width: context.width,
      height: context.height,
    });
    if (grid) {
      out.set(ref.sourceKey, grid);
    }
  }
  return out;
}

function composePhaseMaskedPrecipGrid({
  precipMm,
  snow,
  rain,
  freezingRain,
  icePellets,
  maskSamples,
  targetType = "snow",
  width,
  height,
}) {
  const cellCount = Number(width) * Number(height);
  const samples =
    Array.isArray(maskSamples) && maskSamples.length > 0
      ? maskSamples
      : [{ weight: 1, snow, rain, freezingRain, icePellets }];
  if (!precipMm || precipMm.length !== cellCount || samples.length === 0) {
    return null;
  }
  if (samples.length === 1) {
    return composeSingleSamplePhaseMaskedPrecipGrid({
      precipMm,
      sample: samples[0],
      targetType,
      cellCount,
    });
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const precip = Number(precipMm[index]);
    if (!Number.isFinite(precip)) {
      continue;
    }
    if (precip <= 0) {
      out[index] = 0;
      continue;
    }
    const phaseFraction = calculateIntervalPhaseFraction(samples, index, cellCount, targetType);
    if (!Number.isFinite(phaseFraction)) {
      continue;
    }
    if (phaseFraction <= 0) {
      out[index] = 0;
      continue;
    }
    out[index] = precip * phaseFraction;
  }
  return out;
}

function composeSingleSamplePhaseMaskedPrecipGrid({ precipMm, sample, targetType, cellCount }) {
  const snowValues = sample?.snow;
  const rainValues = sample?.rain;
  const freezingRainValues = sample?.freezingRain;
  const icePelletsValues = sample?.icePellets;
  if (
    !snowValues ||
    snowValues.length !== cellCount ||
    !rainValues ||
    rainValues.length !== cellCount ||
    !freezingRainValues ||
    freezingRainValues.length !== cellCount ||
    !icePelletsValues ||
    icePelletsValues.length !== cellCount
  ) {
    return composePhaseMaskedPrecipGridGeneric({ precipMm, samples: [sample], targetType, cellCount });
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  const targetValues =
    targetType === "freezingRain"
      ? freezingRainValues
      : targetType === "rain"
        ? rainValues
        : targetType === "icePellets"
          ? icePelletsValues
          : snowValues;
  for (let index = 0; index < cellCount; index += 1) {
    const precip = Number(precipMm[index]);
    if (!Number.isFinite(precip)) {
      continue;
    }
    if (precip <= 0) {
      out[index] = 0;
      continue;
    }
    const snow = Number(snowValues[index]);
    const rain = Number(rainValues[index]);
    const freezingRain = Number(freezingRainValues[index]);
    const icePellets = Number(icePelletsValues[index]);
    if (
      !Number.isFinite(snow) ||
      !Number.isFinite(rain) ||
      !Number.isFinite(freezingRain) ||
      !Number.isFinite(icePellets)
    ) {
      continue;
    }
    const targetValue = Number(targetValues[index]);
    const phaseAmount = Number.isFinite(targetValue) ? clamp01(targetValue) : 0;
    if (phaseAmount <= 0) {
      out[index] = 0;
      continue;
    }
    const activeTotal = clamp01(snow) + clamp01(rain) + clamp01(freezingRain) + clamp01(icePellets);
    out[index] = activeTotal > 0 ? precip * Math.max(0, Math.min(1, phaseAmount / activeTotal)) : 0;
  }
  return out;
}

function composePhaseMaskedPrecipGridGeneric({ precipMm, samples, targetType, cellCount }) {
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const precip = Number(precipMm[index]);
    if (!Number.isFinite(precip)) {
      continue;
    }
    if (precip <= 0) {
      out[index] = 0;
      continue;
    }
    const phaseFraction = calculateIntervalPhaseFraction(samples, index, cellCount, targetType);
    if (!Number.isFinite(phaseFraction)) {
      continue;
    }
    if (phaseFraction <= 0) {
      out[index] = 0;
      continue;
    }
    out[index] = precip * phaseFraction;
  }
  return out;
}

function calculateIntervalPhaseFraction(samples, index, cellCount, targetType = "snow") {
  let weightedPhase = 0;
  let totalWeight = 0;
  for (const sample of samples || []) {
    const weight = Number(sample?.weight);
    const resolvedWeight = Number.isFinite(weight) && weight > 0 ? weight : 1;
    const fraction = calculatePhaseMaskFraction(sample, index, cellCount, targetType);
    if (!Number.isFinite(fraction)) {
      continue;
    }
    weightedPhase += fraction * resolvedWeight;
    totalWeight += resolvedWeight;
  }
  return totalWeight > 0 ? weightedPhase / totalWeight : Number.NaN;
}

function calculatePhaseMaskFraction(sample, index, cellCount, targetType = "snow") {
  const snow = maskValueAt(sample?.snow, index, cellCount);
  const rain = maskValueAt(sample?.rain, index, cellCount);
  const freezingRain = maskValueAt(sample?.freezingRain, index, cellCount);
  const icePellets = maskValueAt(sample?.icePellets, index, cellCount);
  let activeTotal = 0;
  let validCount = 0;
  if (Number.isFinite(snow)) {
    activeTotal += clamp01(snow);
    validCount += 1;
  }
  if (Number.isFinite(rain)) {
    activeTotal += clamp01(rain);
    validCount += 1;
  }
  if (Number.isFinite(freezingRain)) {
    activeTotal += clamp01(freezingRain);
    validCount += 1;
  }
  if (Number.isFinite(icePellets)) {
    activeTotal += clamp01(icePellets);
    validCount += 1;
  }
  if (validCount !== SNOW_MASK_TYPE_KEYS.length) {
    return Number.NaN;
  }
  let targetValue;
  if (targetType === "freezingRain") {
    targetValue = freezingRain;
  } else if (targetType === "rain") {
    targetValue = rain;
  } else if (targetType === "icePellets") {
    targetValue = icePellets;
  } else {
    targetValue = snow;
  }
  const phaseAmount = Number.isFinite(targetValue) ? clamp01(targetValue) : 0;
  if (phaseAmount <= 0) {
    return 0;
  }
  return activeTotal > 0 ? Math.max(0, Math.min(1, phaseAmount / activeTotal)) : 0;
}

function maskValueAt(values, index, cellCount) {
  if (!values || values.length !== cellCount) {
    return Number.NaN;
  }
  const value = Number(values[index]);
  return Number.isFinite(value) ? value : Number.NaN;
}

function buildSnowLiquidSourceGridOverrides({ targetHour, decoded, selection, records }) {
  const out = new Map();
  if (!decoded || !selection?.records || !Array.isArray(records)) {
    return out;
  }
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour)) {
    return out;
  }
  for (const record of records) {
    if (!isSurfaceAccumulatedSnowWaterRecord(record) && !isSurfacePrecipAccumulationRecord(record)) {
      continue;
    }
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour !== hour) {
      continue;
    }
    if (isSurfaceAccumulatedSnowWaterRecord(record)) {
      const values = decodedGridForRecord(decoded, selection, record);
      if (values) {
        out.set(snowLiquidSourceKey({ kind: "weasd", hour, record }), values);
      }
      continue;
    }
    // APCP+ptype snowfall masks need bilinear, fractional treatment. The main
    // frame decode keeps precip-type fields categorical for display, so decode
    // these snow-liquid sources separately instead of reusing display masks.
  }
  return out;
}

function buildFreezingRainLiquidSourceGridOverrides({ targetHour, decoded, selection, records }) {
  const out = new Map();
  if (!decoded || !selection?.records || !Array.isArray(records)) {
    return out;
  }
  const hour = Math.round(Number(targetHour));
  if (!Number.isFinite(hour)) {
    return out;
  }
  for (const record of records) {
    if (!isSurfaceAccumulatedFreezingRainRecord(record)) {
      continue;
    }
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour !== hour) {
      continue;
    }
    const values = decodedGridForRecord(decoded, selection, record);
    if (values) {
      out.set(snowLiquidSourceKey({ kind: "frzr", hour, record }), values);
    }
  }
  return out;
}

function zeroGridForFiniteSource(values) {
  const out = new Float32Array(values?.length || 0).fill(Number.NaN);
  for (let index = 0; index < out.length; index += 1) {
    if (Number.isFinite(Number(values[index]))) {
      out[index] = 0;
    }
  }
  return out;
}

function decodedGridForRecord(decoded, selection, record) {
  if (!record || !decoded || !selection?.records) {
    return null;
  }
  for (const [key, selectedRecord] of Object.entries(selection.records)) {
    if (recordsMatch(selectedRecord, record) && decoded[key]) {
      return decoded[key];
    }
  }
  return null;
}

function snowLiquidSourceGridCachePath(ref, context) {
  const cacheDir = context?.sourceGridCacheDir;
  if (!cacheDir || !ref?.record) {
    return null;
  }
  const payload = snowLiquidSourceGridCachePayload(ref, context);
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(ref.hour)}-${hash}.f32`,
  );
}

function snowLiquidSourceGridCachePayload(ref, context) {
  return {
    version: SNOW_LIQUID_GRID_CACHE_VERSION,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    forecastHourRosterIdentity: buildBoundedForecastHourRosterIdentity(context, ref.hour),
    hour: Math.round(Number(ref.hour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    kind: ref.kind,
    maskTargetKey: ref.maskTargetKey || null,
    record: selectedPrecipRecordIdentity(ref.record),
    maskRecords: Object.fromEntries(
      Object.entries(ref.maskRecords || {}).map(([key, record]) => [key, selectedPrecipRecordIdentity(record)]),
    ),
    maskSamples: (ref.maskSamples || []).map(snowMaskSampleIdentity),
  };
}

function snowLiquidSourceHourLockPath(hour, context) {
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

async function waitForCachedSnowLiquidHourSources(refs, context, lockPath) {
  return waitForCachedRefGrids({
    refs,
    lockPath,
    concurrency: metadataFanoutConcurrency(context, 16),
    probeRef: (ref) => probeCachedSnowLiquidSourceGrid(ref, context),
    readRef: (ref) => readCachedSnowLiquidSourceGrid(ref, context),
    profile: context.profile,
    timeoutCounter: "snowLiquidGridLockTimeouts",
  });
}

async function probeCachedSnowLiquidSourceGrid(ref, context) {
  const cachePath = snowLiquidSourceGridCachePath(ref, context);
  if (!cachePath) {
    return false;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    return directCacheMetadataPayloadMatches(metadata, snowLiquidSourceGridCachePayload(ref, context));
  } catch {
    return false;
  }
}

async function readCachedSnowLiquidHourSources(refs, context) {
  return readCachedRefGridsBySourceKey(refs, metadataFanoutConcurrency(context, 16), (ref) =>
    readCachedSnowLiquidSourceGrid(ref, context),
  );
}

async function readCachedSnowLiquidSourceGrid(ref, context) {
  const cachePath = snowLiquidSourceGridCachePath(ref, context);
  if (!cachePath) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    const expected = snowLiquidSourceGridCachePayload(ref, context);
    if (!directCacheMetadataPayloadMatches(metadata, expected)) {
      return null;
    }
    const body = await fs.promises.readFile(cachePath);
    const expectedBytes = Number(context.width) * Number(context.height) * 4;
    if (body.length !== expectedBytes) {
      return null;
    }
    restoreFrameProvenanceCacheSnapshot(context.decodeSession, metadata.provenanceSnapshot);
    return float32ArrayViewFromBuffer(body, 0, body.byteLength);
  } catch {
    return null;
  }
}

async function writeCachedSnowLiquidSourceGrid(ref, values, context) {
  const cachePath = snowLiquidSourceGridCachePath(ref, context);
  if (!cachePath || !values || values.length !== Number(context.width) * Number(context.height)) {
    return false;
  }
  const metadata = snowLiquidSourceGridCachePayload(ref, context);
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpJson = `${tmp}.json`;
  // Cache persistence is best-effort: a failed write must degrade to a
  // warn-and-recompute, never fail the frame that already holds the grid
  // (mirrors writeCachedFloatGrid).
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    await fs.promises.writeFile(tmp, body);
    await fs.promises.writeFile(
      tmpJson,
      JSON.stringify(
        cacheMetadataWithPayload(metadata, {
          provenanceSnapshot: buildFrameProvenanceCacheSnapshot(context.decodeSession, {
            terms: [ref],
            includeDerivations: false,
          }),
        }),
      ),
    );
    await fs.promises.rename(tmp, cachePath);
    await fs.promises.rename(tmpJson, `${cachePath}.json`);
    return true;
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    await fs.promises.rm(tmpJson, { force: true }).catch(() => {});
    console.warn(
      `[noaa-beta] snow-liquid source grid cache write failed for ${cachePath}: ${String(error?.message || error)}`,
    );
    return false;
  }
}

function decodeHourFanoutConcurrency(context, cap = 6) {
  const decodeConcurrency = Math.max(1, Number(context?.decodeConcurrency) || 1);
  return Math.min(decodeConcurrency, Math.max(1, Number(cap) || 6));
}

module.exports = {
  SNOW_LIQUID_GRID_CACHE_VERSION,
  buildFreezingRainLiquidSourceGridOverrides,
  buildSnowLiquidSourceGridOverrides,
  calculateIntervalPhaseFraction,
  calculatePhaseMaskFraction,
  composePhaseMaskedPrecipGrid,
  composePhaseMaskedPrecipGridGeneric,
  composeSingleSamplePhaseMaskedPrecipGrid,
  decodeHourFanoutConcurrency,
  decodeSnowLiquidHourSources,
  decodeSnowLiquidHourSourcesWithLock,
  decodeSnowLiquidSourceGrids,
  decodedGridForRecord,
  maskValueAt,
  probeCachedSnowLiquidSourceGrid,
  readCachedSnowLiquidHourSources,
  readCachedSnowLiquidSourceGrid,
  snowLiquidSourceGridCachePath,
  snowLiquidSourceGridCachePayload,
  snowLiquidSourceHourLockPath,
  snowMaskSampleIdentity,
  waitForCachedSnowLiquidHourSources,
  writeCachedSnowLiquidSourceGrid,
  zeroGridForFiniteSource,
};
