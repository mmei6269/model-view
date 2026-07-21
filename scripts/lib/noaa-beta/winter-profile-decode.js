"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { NOAA_NAM_PARAMETER_CATALOG, SNOW_PROFILE_LEVELS } = require("../noaa-nam-parameter-catalog");
const { incrementProfileCounter } = require("./util");
const { float32ArrayViewFromBuffer } = require("./grid-ops");
const { PROFILE_SURFACE_DECODE_KEYS, profileDecodeKey, standardProfileDecodeKey } = require("./profile-access");
const {
  CATALOG_VERSION,
  SELECTED_GRIB_CACHE_DIRNAME,
  buildFrameProvenanceCacheSnapshot,
  decodeSelectedRecordsToGrids,
  getNoaaRecordsForHour,
  getSelectedRecordPlan,
  materializeSelectedGrib,
  readDecodedRecordsForKeyedRecords,
  readRegisteredProfileGrids,
  registerProfileGrids,
  registerTemporalProvenanceDerivation,
  restoreFrameProvenanceCacheSnapshot,
  selectedGribSharedCacheDir,
  selectedPrecipRecordIdentity,
  selectedRecordDecodeCacheKey,
} = require("./grib-source");
const { findRecord } = require("./records");
const {
  cacheMetadataPayloadMatches,
  cacheMetadataWithPayload,
  mapWithConcurrency,
  padHour,
  probeCachedGridSidecar,
  recordProfileStage,
  releaseGridCacheLock,
  sanitizePathToken,
  tryAcquireGridCacheLock,
  waitForCachedGrid,
} = require("./cache-io");
const { buildNoaaGribUrl } = require("./model-config");
const { PROFILE_SURFACE_SELECTORS, profileSelector } = require("./selection");
const { ensureSelectedRecordByteRangesForHour } = require("./accumulation");
const { decodeHourFanoutConcurrency } = require("./winter-source-grids");
const {
  MIN_VISIBLE_SNOW_LIQUID_IN,
  buildSnowLiquidTotalInGrid,
  hasGridValueGreaterThan,
} = require("./winter-slr-grids");

const PROFILE_GRID_PROMISE_CACHE = new Map();

const PROFILE_GRID_CACHE_VERSION = "derived-profile-grid-v2-frame-local-provenance";

async function writeFloatGridEntriesBinary(filePath, entries) {
  const handle = await fs.promises.open(filePath, "w");
  try {
    for (const [, values] of entries) {
      if (!(values instanceof Float32Array)) {
        continue;
      }
      const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
      await handle.write(body, 0, body.byteLength);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function decodeLazySnowfallProfileGrids({
  modelKey,
  modelConfig,
  baseUrl,
  date,
  cycle,
  hour,
  records,
  decoded,
  selection,
  rawCacheDir,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  rangeFetchConcurrency,
  rangeFetchLimiter,
  decodeConcurrency,
  profile = null,
  decodeSession = null,
}) {
  const available = new Set(selection?.availableParameters || []);
  const lazyEntries = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => {
    return entry.kind === "snowfallDerived" && entry.lazyProfile && available.has(entry.key);
  });
  const snowLiquidIn = buildSnowLiquidTotalInGrid(decoded, width, height);
  if (lazyEntries.length === 0 || !hasGridValueGreaterThan(snowLiquidIn, MIN_VISIBLE_SNOW_LIQUID_IN)) {
    return {};
  }
  const recordsByKey = {};
  const addRecord = (key, record) => {
    if (record && !decoded?.[key] && !recordsByKey[key]) {
      recordsByKey[key] = record;
    }
  };
  addProfileRecordsForEntries({ entries: lazyEntries, records, decoded, addRecord, skipDecoded: true });
  const context = {
    modelKey,
    modelConfig,
    baseUrl,
    date,
    cycle,
    targetHour: hour,
    tempDir,
    wgrib2Path,
    bounds,
    width,
    height,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    decodeConcurrency,
    profileGridCacheDir: rawCacheDir ? path.join(rawCacheDir, "derived-profile-grids") : null,
    profileSelectedGribCacheDir: selectedGribSharedCacheDir(rawCacheDir) || path.join(tempDir, "selected-grib-v2"),
    profile,
    decodeSession,
  };
  const profileDecoded = await decodeProfileRecordsForHour({
    recordsByKey,
    hour,
    context,
  });
  registerSnowfallProfileProvenance({
    entries: lazyEntries,
    recordsByHour: new Map([[hour, records || []]]),
    profileHours: [hour],
    context,
    targetHour: hour,
  });
  return profileDecoded;
}

async function decodeProfileRecordsForHour({ recordsByKey, hour, context }) {
  const selectedRecords = Object.values(recordsByKey || {}).filter(Boolean);
  if (selectedRecords.length === 0) {
    return {};
  }
  const registered = readRegisteredProfileGrids({ recordsByKey, hour, context });
  if (registered) {
    return registered;
  }
  if (shouldUnionProfileDecode(context)) {
    const payload = profileGridCachePayload({ recordsByKey, hour, context });
    const cachePath = profileGridCachePath(payload, context);
    const cached = await readCachedProfileGrids(cachePath, payload, context);
    if (cached) {
      incrementProfileCounter(context.profile, "profileGridCacheHits");
      registerProfileGrids({ recordsByKey, hour, context, decoded: cached });
      return cached;
    }
    return enqueueUnionedProfileDecode({ recordsByKey, hour, context });
  }
  return decodeProfileRecordsForHourExact({ recordsByKey, hour, context });
}

async function decodeProfileRecordsForHourExact({ recordsByKey, hour, context }) {
  const selectedRecords = Object.values(recordsByKey || {}).filter(Boolean);
  if (selectedRecords.length === 0) {
    return {};
  }
  const registered = readRegisteredProfileGrids({ recordsByKey, hour, context });
  if (registered) {
    return registered;
  }
  const payload = profileGridCachePayload({ recordsByKey, hour, context });
  const decoded = await readOrDecodeCachedProfileGrids(payload, context, async () => {
    const decodedCached = readDecodedRecordsForKeyedRecords({ recordsByKey, hour, context });
    if (decodedCached) {
      return decodedCached;
    }
    await ensureSelectedRecordByteRangesForHour({
      context,
      hour,
      selectedRecords,
      profile: context.profile,
    });
    const selectedPlan = getSelectedRecordPlan(selectedRecords, context.decodeSession);
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
      rawCacheDir: context.profileSelectedGribCacheDir || path.join(context.tempDir, "derived-profile-raw"),
      date: context.date,
      cycle: context.cycle,
      hour,
      cacheVersion: CATALOG_VERSION,
      rangeFetchConcurrency: context.rangeFetchConcurrency,
      rangeFetchLimiter: context.rangeFetchLimiter,
      profile: null,
      decodeSession: context.decodeSession,
    });
    const decodeTempDir = await fs.promises.mkdtemp(path.join(context.tempDir, `profile-${padHour(hour)}-`));
    const startedAt = performance.now();
    try {
      const decoded = await decodeSelectedRecordsToGrids({
        gribPath,
        selectedPlan,
        selection: { records: recordsByKey, catalog: [] },
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
      if (context.profile) {
        context.profile.profileRecordCount = (Number(context.profile.profileRecordCount) || 0) + selectedRecords.length;
      }
      return decoded;
    } finally {
      recordProfileStage(context.profile, "profileDecodeMs", startedAt);
      await fs.promises.rm(decodeTempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
  registerProfileGrids({ recordsByKey, hour, context, decoded });
  return decoded;
}

function shouldUnionProfileDecode(context) {
  return Boolean(context?.decodeSession) && context.profileDecodeUnion !== false;
}

function enqueueUnionedProfileDecode({ recordsByKey, hour, context }) {
  const session = context.decodeSession;
  const batchKey = profileDecodeUnionBatchKey({ hour, context });
  let batch = session.profileDecodeBatches.get(batchKey);
  if (!batch) {
    batch = { hour, context, requests: [], scheduled: false };
    session.profileDecodeBatches.set(batchKey, batch);
  }
  const promise = new Promise((resolve, reject) => {
    batch.requests.push({ recordsByKey, resolve, reject });
  });
  if (!batch.scheduled) {
    batch.scheduled = true;
    scheduleProfileDecodeUnionFlush(() => runUnionedProfileDecodeBatch(session, batch));
  }
  return promise;
}

function scheduleProfileDecodeUnionFlush(callback) {
  if (typeof setImmediate === "function") {
    setImmediate(callback);
  } else {
    setTimeout(callback, 0);
  }
}

function profileDecodeUnionBatchKey({ hour, context }) {
  return JSON.stringify({
    modelKey: context?.modelKey || "",
    productKey: context?.modelConfig?.productKey || "",
    date: context?.date || "",
    cycle: context?.cycle || "",
    hour: Math.round(Number(hour)),
    width: context?.width,
    height: context?.height,
    bounds: context?.bounds || null,
    profileGridCacheDir: context?.profileGridCacheDir || "",
    profileSelectedGribCacheDir: profileSelectedGribCacheDir(context) || "",
  });
}

async function runUnionedProfileDecodeBatch(session, batch) {
  const batchKey = profileDecodeUnionBatchKey({ hour: batch.hour, context: batch.context });
  session.profileDecodeBatches.delete(batchKey);
  const requests = batch.requests.splice(0);
  const union = buildUnionedProfileDecodeRequest(requests);
  try {
    const decoded = await decodeProfileRecordsForHourExact({
      recordsByKey: union.recordsByKey,
      hour: batch.hour,
      context: { ...batch.context, profileDecodeUnion: false },
    });
    for (const request of requests) {
      const subset = {};
      const keyMap = union.requestKeyMaps.get(request) || new Map();
      for (const [requestedKey, unionKey] of keyMap) {
        if (decoded?.[unionKey]) {
          subset[requestedKey] = decoded[unionKey];
        }
      }
      request.resolve(subset);
    }
  } catch (error) {
    for (const request of requests) {
      request.reject(error);
    }
  }
}

function buildUnionedProfileDecodeRequest(requests) {
  const recordsByKey = {};
  const identityByKey = new Map();
  const requestKeyMaps = new Map();
  let conflictIndex = 0;
  const addRecord = (requestedKey, record) => {
    const identity = selectedRecordDecodeCacheKey(record);
    const existingIdentity = identityByKey.get(requestedKey);
    if (!existingIdentity || existingIdentity === identity) {
      recordsByKey[requestedKey] = record;
      identityByKey.set(requestedKey, identity);
      return requestedKey;
    }
    let unionKey;
    do {
      conflictIndex += 1;
      unionKey = `${requestedKey}__union${conflictIndex}`;
    } while (recordsByKey[unionKey]);
    recordsByKey[unionKey] = record;
    identityByKey.set(unionKey, identity);
    return unionKey;
  };
  for (const request of requests) {
    const keyMap = new Map();
    for (const [requestedKey, record] of Object.entries(request.recordsByKey || {})) {
      if (!record) {
        continue;
      }
      keyMap.set(requestedKey, addRecord(requestedKey, record));
    }
    requestKeyMaps.set(request, keyMap);
  }
  return { recordsByKey, requestKeyMaps };
}

function addProfileRecordsForEntries({ entries, records, decoded = null, addRecord, skipDecoded = false }) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0 || typeof addRecord !== "function") {
    return;
  }
  addSurfaceProfileRecords({ entries: list, records, decoded, addRecord, skipDecoded });
  for (const entry of list) {
    addPressureProfileRecordsForEntry({ entry, records, decoded, addRecord, skipDecoded });
  }
}

function addPressureProfileRecordsForEntry({ entry, records, decoded = null, addRecord, skipDecoded = false }) {
  if (!entry || typeof addRecord !== "function") {
    return;
  }
  for (const variable of entry.profileVariables || []) {
    for (const level of entry.profileLevels || SNOW_PROFILE_LEVELS) {
      const standardKey = standardProfileDecodeKey(variable, level);
      const profileKey = profileDecodeKey(variable, level);
      if (skipDecoded && ((standardKey && decoded?.[standardKey]) || decoded?.[profileKey])) {
        continue;
      }
      addProfileRecord({ addRecord, key: profileKey, record: findRecord(records, profileSelector(variable, level)) });
    }
  }
}

function profileSelectedGribCacheDir(context) {
  if (context?.profileSelectedGribCacheDir) {
    return context.profileSelectedGribCacheDir;
  }
  if (context?.sourceGribCacheDir) {
    return selectedGribSharedCacheDir(context.sourceGribCacheDir);
  }
  return context?.tempDir ? path.join(context.tempDir, SELECTED_GRIB_CACHE_DIRNAME) : null;
}

async function materializeDecodedProfileGridsForHour({ recordsByKey, hour, context }) {
  return decodeProfileRecordsForHour({
    recordsByKey,
    hour,
    context: {
      ...context,
      profileSelectedGribCacheDir: profileSelectedGribCacheDir(context),
      profileDecodeUnion: context?.profileDecodeUnion !== false,
    },
  });
}

async function decodeIntervalSnowfallProfiles({ entries, chunks, targetHour = null, context, decoded }) {
  const profileEntries = entries.filter(
    (entry) => Array.isArray(entry.profileVariables) && entry.profileVariables.length > 0,
  );
  if (profileEntries.length === 0) {
    return new Map();
  }
  const profileHours = Array.from(new Set(chunks.map((chunk) => chunk.profileHour))).sort(
    (left, right) => left - right,
  );
  // A zero-liquid interval does not evaluate any profile-dependent SLR. Its
  // output lineage is therefore fully described by the per-output liquid
  // accumulation derivation; recording an empty "profile" derivation would
  // falsely make an exact dry-frame lineage appear incomplete.
  if (profileHours.length === 0) {
    return new Map();
  }
  const pairs = await mapWithConcurrency(profileHours, decodeHourFanoutConcurrency(context, 6), async (hour) => {
    const records = await getNoaaRecordsForHour(context, hour);
    const baseDecoded = hour === context.targetHour ? decoded : {};
    const profileDecoded = await decodeSnowfallProfileGridsForHour({
      entries: profileEntries,
      hour,
      records,
      context,
      decoded: baseDecoded,
    });
    return [hour, { ...baseDecoded, ...profileDecoded }];
  });
  const profilesByHour = new Map(pairs.filter(Boolean));
  const recordsByHour = new Map();
  for (const hour of profileHours) {
    recordsByHour.set(hour, await getNoaaRecordsForHour(context, hour));
  }
  registerSnowfallProfileProvenance({
    entries: profileEntries,
    recordsByHour,
    profileHours,
    context,
    targetHour: Number.isFinite(Number(targetHour)) ? Number(targetHour) : context.targetHour,
  });
  return profilesByHour;
}

async function decodeSnowfallProfileGridsForHour({ entries, hour, records, context, decoded = null }) {
  const recordsByKey = {};
  const addRecord = (key, record) => {
    if (record && !decoded?.[key] && !recordsByKey[key]) {
      recordsByKey[key] = record;
    }
  };
  addProfileRecordsForEntries({ entries, records, decoded, addRecord, skipDecoded: true });
  return materializeDecodedProfileGridsForHour({ recordsByKey, hour, context });
}

function profileGridCachePayload({ recordsByKey, hour, context }) {
  return {
    version: PROFILE_GRID_CACHE_VERSION,
    modelKey: context.modelKey,
    productKey: context.modelConfig?.productKey || "",
    date: context.date,
    cycle: context.cycle,
    hour: Math.round(Number(hour)),
    width: context.width,
    height: context.height,
    bounds: context.bounds,
    records: Object.fromEntries(
      Object.entries(recordsByKey || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, record]) => [key, selectedPrecipRecordIdentity(record)]),
    ),
  };
}

function profileGridCachePath(payload, context) {
  const cacheDir = context?.profileGridCacheDir;
  if (!cacheDir || !payload) {
    return null;
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 20);
  return path.join(
    cacheDir,
    sanitizePathToken(context.modelKey),
    String(context.date),
    String(context.cycle),
    `${padHour(payload.hour)}-${hash}`,
  );
}

async function readOrDecodeCachedProfileGrids(payload, context, decode) {
  const cachePath = profileGridCachePath(payload, context);
  const cacheKey = cachePath || null;
  const existing = cacheKey ? PROFILE_GRID_PROMISE_CACHE.get(cacheKey) : null;
  if (existing) {
    return restoreProfileProvenanceAfterSharedPromise(existing, cachePath, payload, context);
  }
  const promise = (async () => {
    const cached = await readCachedProfileGrids(cachePath, payload, context);
    if (cached) {
      incrementProfileCounter(context.profile, "profileGridCacheHits");
      return cached;
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
          read: (targetPath, expectedPayload) => readCachedProfileGrids(targetPath, expectedPayload, context),
          probe: probeCachedGridSidecar,
          timeoutCounter: "profileGridLockTimeouts",
        });
        if (waited) {
          incrementProfileCounter(context.profile, "profileGridCacheHits");
          return waited;
        }
      } else {
        try {
          const cachedAfterLock = await readCachedProfileGrids(cachePath, payload, context);
          if (cachedAfterLock) {
            incrementProfileCounter(context.profile, "profileGridCacheHits");
            return cachedAfterLock;
          }
          incrementProfileCounter(context.profile, "profileGridCacheMisses");
          const decoded = await decode();
          await writeCachedProfileGrids(cachePath, payload, decoded, context);
          return decoded;
        } finally {
          await releaseGridCacheLock(lockPath, lockHandle);
        }
      }
    }
    incrementProfileCounter(context.profile, "profileGridCacheMisses");
    const decoded = await decode();
    await writeCachedProfileGrids(cachePath, payload, decoded, context);
    return decoded;
  })().finally(() => {
    if (cacheKey) {
      PROFILE_GRID_PROMISE_CACHE.delete(cacheKey);
    }
  });
  promise.provenanceSnapshot = () =>
    buildFrameProvenanceCacheSnapshot(context?.decodeSession, {
      terms: profileCacheProvenanceTerms(payload),
      includeDerivations: false,
    });
  if (cacheKey) {
    PROFILE_GRID_PROMISE_CACHE.set(cacheKey, promise);
  }
  return promise;
}

async function restoreProfileProvenanceAfterSharedPromise(promise, cachePath, payload, context) {
  const decoded = await promise;
  if (cachePath) {
    const cached = await readCachedProfileGrids(cachePath, payload, context);
    if (!cached && typeof promise?.provenanceSnapshot === "function") {
      restoreFrameProvenanceCacheSnapshot(context?.decodeSession, promise.provenanceSnapshot());
    }
  }
  return decoded;
}

async function readCachedProfileGrids(cachePath, expectedPayload, context = null) {
  if (!cachePath) {
    return null;
  }
  try {
    const metadata = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    if (!cacheMetadataPayloadMatches(metadata, expectedPayload)) {
      return null;
    }
    const body = await fs.promises.readFile(`${cachePath}.bin`);
    const out = {};
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
      if (out[key]) {
        return null;
      }
      out[key] = float32ArrayViewFromBuffer(body, byteOffset, byteLength);
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

async function writeCachedProfileGrids(cachePath, payload, decoded, context = null) {
  if (!cachePath || !decoded || typeof decoded !== "object") {
    return false;
  }
  const entries = Object.entries(decoded).filter(([, values]) => values instanceof Float32Array);
  if (entries.length === 0) {
    return false;
  }
  const grids = [];
  let byteOffset = 0;
  for (const [key, values] of entries) {
    const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    grids.push({ key, byteOffset, byteLength: body.byteLength });
    byteOffset += body.byteLength;
  }
  const tmp = `${cachePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  // Cache persistence is best-effort: a failed write must degrade to a
  // warn-and-recompute, never fail the frame that already holds the grids
  // (mirrors writeCachedFloatGrid).
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    await writeFloatGridEntriesBinary(`${tmp}.bin`, entries);
    await fs.promises.writeFile(
      `${tmp}.json`,
      JSON.stringify(
        cacheMetadataWithPayload(payload, {
          grids,
          provenanceSnapshot: buildFrameProvenanceCacheSnapshot(context?.decodeSession, {
            terms: profileCacheProvenanceTerms(payload),
            includeDerivations: false,
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
    console.warn(`[noaa-beta] profile grid cache write failed for ${cachePath}: ${String(error?.message || error)}`);
    return false;
  }
}

function profileCacheProvenanceTerms(payload) {
  const hour = Math.round(Number(payload?.hour));
  return Object.entries(payload?.records || {}).map(([key, record]) => ({
    hour,
    role: `profile-cache:${key}`,
    sourceKey: key,
    kind: "profile-cache",
    record,
  }));
}

function addSurfaceProfileRecords({ entries, records, decoded = null, addRecord, skipDecoded = false }) {
  const variables = new Set(entries.flatMap((entry) => entry.profileVariables || []));
  addProfileRecord({
    addRecord,
    key: PROFILE_SURFACE_DECODE_KEYS.HGT,
    record: findRecord(records, PROFILE_SURFACE_SELECTORS.HGT),
    decoded,
    skipDecoded,
  });
  for (const variable of variables) {
    const key = PROFILE_SURFACE_DECODE_KEYS[variable];
    const selector = PROFILE_SURFACE_SELECTORS[variable];
    if (!key || !selector) {
      continue;
    }
    addProfileRecord({ addRecord, key, record: findRecord(records, selector), decoded, skipDecoded });
  }
}

function addProfileRecord({ addRecord, key, record, decoded = null, skipDecoded = false }) {
  if (!record || !key || typeof addRecord !== "function") {
    return;
  }
  if (skipDecoded && decoded?.[key]) {
    return;
  }
  addRecord(key, record);
}

function registerSnowfallProfileProvenance({ entries, recordsByHour, profileHours, context, targetHour }) {
  for (const entry of entries || []) {
    const terms = [];
    const requiredRoles = [];
    const recordedRoles = [];
    const missingRoles = [];
    for (const hour of profileHours || []) {
      const records = recordsByHour?.get(hour) || [];
      const input = buildSnowfallProfileInputForEntry({ entry, records, hour });
      terms.push(...input.terms);
      requiredRoles.push(...input.requiredRoles);
      recordedRoles.push(...input.recordedRoles);
      missingRoles.push(...input.missingRoles);
    }
    registerTemporalProvenanceDerivation(context?.decodeSession, {
      family: "snowfall-profile-inputs",
      outputKey: entry?.key,
      targetHour,
      terms,
      inputCoverage: {
        complete: requiredRoles.length > 0 && missingRoles.length === 0,
        requiredRoles,
        recordedRoles,
        missingRoles,
      },
    });
  }
}

function buildSnowfallProfileInputForEntry({ entry, records, hour }) {
  const recordsByKey = {};
  addProfileRecordsForEntries({
    entries: [entry],
    records,
    addRecord: (key, record) => {
      recordsByKey[key] = record;
    },
  });
  const requiredKeys = expectedSnowfallProfileRecordKeys(entry);
  const requiredRoles = requiredKeys.map((key) => `F${padHour(hour)}:${entry?.key}:${key}`);
  const recordedRoles = [];
  const terms = [];
  for (const [key, record] of Object.entries(recordsByKey)) {
    const coverageRole = `F${padHour(hour)}:${entry?.key}:${key}`;
    recordedRoles.push(coverageRole);
    terms.push({
      hour,
      role: `snowfall-profile:${entry?.key}:${key}`,
      sourceKey: key,
      kind: "snowfall-profile",
      weight: 1,
      record,
    });
  }
  const recordedSet = new Set(recordedRoles);
  return {
    terms,
    requiredRoles,
    recordedRoles,
    missingRoles: requiredRoles.filter((role) => !recordedSet.has(role)),
  };
}

function expectedSnowfallProfileRecordKeys(entry) {
  const keys = new Set([PROFILE_SURFACE_DECODE_KEYS.HGT]);
  for (const variable of entry?.profileVariables || []) {
    const surfaceKey = PROFILE_SURFACE_DECODE_KEYS[variable];
    if (surfaceKey && PROFILE_SURFACE_SELECTORS[variable]) {
      keys.add(surfaceKey);
    }
    for (const level of entry?.profileLevels || SNOW_PROFILE_LEVELS) {
      const key = profileDecodeKey(variable, level);
      if (key) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

module.exports = {
  PROFILE_GRID_CACHE_VERSION,
  PROFILE_GRID_PROMISE_CACHE,
  addPressureProfileRecordsForEntry,
  addProfileRecord,
  addProfileRecordsForEntries,
  addSurfaceProfileRecords,
  buildSnowfallProfileInputForEntry,
  buildUnionedProfileDecodeRequest,
  decodeIntervalSnowfallProfiles,
  decodeLazySnowfallProfileGrids,
  decodeProfileRecordsForHour,
  decodeProfileRecordsForHourExact,
  decodeSnowfallProfileGridsForHour,
  enqueueUnionedProfileDecode,
  expectedSnowfallProfileRecordKeys,
  materializeDecodedProfileGridsForHour,
  profileCacheProvenanceTerms,
  profileDecodeUnionBatchKey,
  profileGridCachePath,
  profileGridCachePayload,
  profileSelectedGribCacheDir,
  readCachedProfileGrids,
  readOrDecodeCachedProfileGrids,
  registerSnowfallProfileProvenance,
  restoreProfileProvenanceAfterSharedPromise,
  runUnionedProfileDecodeBatch,
  scheduleProfileDecodeUnionFlush,
  shouldUnionProfileDecode,
  writeCachedProfileGrids,
  writeFloatGridEntriesBinary,
};
