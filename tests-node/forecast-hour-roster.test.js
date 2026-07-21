"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
const { buildNoaaModelMetadata } = require("../scripts/lib/noaa-build/run-resolution");
const {
  buildBoundedForecastHourRosterIdentity,
  buildForecastHourRosterIdentity,
} = require("../scripts/lib/noaa-beta/forecast-hour-roster");
const {
  RUN_MAX_GRID_PROMISE_CACHE,
  precipSourceGridCachePayload,
  readOrComputeCachedRunMaxGrid,
  resolveAvailableForecastHours,
  runMaxCumulativeGridPayload,
  runMaxGridCachePath,
} = require("../scripts/lib/noaa-beta/accumulation");
const {
  attachRunLocalDecodeSession,
  createFrameDecodeSession,
  getFrameSourceProvenanceSources,
  getFrameTemporalProvenanceDerivations,
  readDecodedRecordsForKeyedRecords,
  readRegisteredProfileGrids,
  readRegisteredSourceGrid,
  registerProfileGrids,
  registerSourceGrid,
  restoreFrameProvenanceCacheSnapshot,
  writeDecodedRecordGridCache,
} = require("../scripts/lib/noaa-beta/grib-source");
const {
  PROFILE_GRID_PROMISE_CACHE,
  buildFramOutputProvenance,
  buildFramProfileProvenance,
  buildSnowfallProfileInputForEntry,
  cumulativeSnowfallCachePayload,
  decodeIntervalSnowfallProfiles,
  deltaSnowfallCachePayload,
  profileGridCachePayload,
  readCachedCumulativeSnowfallGrids,
  readOrDecodeCachedProfileGrids,
  snowLiquidSourceGridCachePayload,
  writeCachedCumulativeSnowfallGrids,
} = require("../scripts/lib/noaa-beta/winter");
const { buildFrameSourceProvenance } = require("../scripts/lib/noaa-beta/source-provenance");

function gfsMetadata(hours, gfsHourlyThrough120 = false) {
  return buildNoaaModelMetadata({
    modelKey: "gfs",
    run: { date: "20260711", cycle: "00" },
    hours,
    gfsHourlyThrough120,
  });
}

function cacheContext(availableHours, forecastHourSamplingTier) {
  return {
    modelKey: "gfs",
    modelConfig: { productKey: "pgrb2-0p25" },
    date: "20260711",
    cycle: "00",
    availableHours,
    forecastHourSamplingTier,
    width: 2,
    height: 1,
    bounds: { west: -130, south: 20, east: -60, north: 55 },
  };
}

function precipRecord() {
  return {
    record: "7",
    param: "APCP",
    level: "surface",
    forecast: "0-6 hour acc fcst",
    accumulationWindow: { startHour: 0, endHour: 6 },
  };
}

function exactSourceForRecord(record, { hour = 6, sha = "c" } = {}) {
  const digest = String(sha).repeat(64).slice(0, 64);
  return {
    id: `noaa-selected:${digest}`,
    modelKey: "gfs",
    productKey: "pgrb2-0p25",
    date: "20260711",
    cycle: "00",
    forecastHour: hour,
    referenceTime: "2026-07-11T00:00:00.000Z",
    validTime: new Date(Date.UTC(2026, 6, 11, hour)).toISOString(),
    gribUrl: `https://example.test/gfs.f${String(hour).padStart(3, "0")}.grib2`,
    idxUrl: `https://example.test/gfs.f${String(hour).padStart(3, "0")}.grib2.idx`,
    selectedHash: "selected-records",
    selectedSha256: digest,
    selectedBytes: 512,
    records: [record],
  };
}

function rawRecord(param, level, record = "1") {
  return {
    record,
    param,
    level,
    forecast: "6 hour fcst",
    extra: "",
    dateToken: "d=2026071100",
    line: `${record}:0:d=2026071100:${param}:${level}:6 hour fcst:`,
    offset: 0,
    endExclusive: 128,
    byteLength: 128,
    rangeHeader: "bytes=0-127",
  };
}

test("canonical GFS prefix extension reuses completion identity while temporal tiers and arbitrary holes do not", async (t) => {
  const shortThreeHourly = gfsMetadata([0, 3, 6]);
  const longerThreeHourly = gfsMetadata([0, 3, 6, 9, 12]);
  const hourly = gfsMetadata([0, 1, 2, 3, 4, 5, 6], true);
  const arbitraryHole = gfsMetadata([0, 6, 12]);

  assert.equal(shortThreeHourly.forecastHourRoster.canonicalPrefix, true);
  assert.equal(shortThreeHourly.rendererSignature, longerThreeHourly.rendererSignature);
  assert.notEqual(shortThreeHourly.rendererSignature, hourly.rendererSignature);
  assert.notEqual(shortThreeHourly.rendererSignature, arbitraryHole.rendererSignature);
  assert.deepEqual(resolveAvailableForecastHours(shortThreeHourly, 6, "gfs"), [0, 3, 6]);
  assert.deepEqual(resolveAvailableForecastHours(hourly, 6, "gfs"), [0, 1, 2, 3, 4, 5, 6]);

  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-roster-marker-"));
  t.after(() => fs.promises.rm(cacheRoot, { recursive: true, force: true }));
  const runtime = new LocalArtifactRuntime({ cacheRoot });
  const frame = { hour: 3, layers: { temperature: { key: "tiles/gfs/003-temperature.png" } } };
  const artifactPath = runtime.getArtifactStoragePath(frame.layers.temperature.key);
  const markerPath = runtime.getFrameMarkerPath("gfs", "20260711-0000Z", "conus", frame.hour);
  await fs.promises.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.promises.writeFile(artifactPath, Buffer.from([1]));
  await fs.promises.writeFile(
    markerPath,
    JSON.stringify({ rendererSignature: shortThreeHourly.rendererSignature, parameterAvailability: {} }),
  );

  assert.equal(
    await runtime.isFrameComplete("gfs", "20260711-0000Z", "conus", frame, {
      expectedRendererSignature: longerThreeHourly.rendererSignature,
    }),
    true,
    "a newly published future canonical hour must not invalidate a completed common frame",
  );
  assert.equal(
    await runtime.isFrameComplete("gfs", "20260711-0000Z", "conus", frame, {
      expectedRendererSignature: hourly.rendererSignature,
    }),
    false,
    "the hourly tier can use additional temporal inputs at the same common forecast hour",
  );
});

test("cumulative cache identities use the exact source-hour roster bounded by target hour", () => {
  const threeHourly = cacheContext([0, 3, 6], "three-hourly");
  const futureExtension = cacheContext([0, 3, 6, 9, 12], "three-hourly");
  const hourly = cacheContext([0, 1, 2, 3, 4, 5, 6], "hourly-through-f120");
  const hole = cacheContext([0, 6], "three-hourly");
  assert.equal(
    buildBoundedForecastHourRosterIdentity(threeHourly, 6),
    buildBoundedForecastHourRosterIdentity(futureExtension, 6),
  );
  assert.notEqual(
    buildBoundedForecastHourRosterIdentity(threeHourly, 6),
    buildBoundedForecastHourRosterIdentity(hourly, 6),
  );
  assert.notEqual(
    buildBoundedForecastHourRosterIdentity(threeHourly, 6),
    buildBoundedForecastHourRosterIdentity(hole, 6),
  );

  const record = precipRecord();
  const runMaxArgs = {
    key: "updraftHelicity",
    source: { sourceKey: "updraftHelicity", multiplier: 1 },
    hour: 6,
    record,
  };
  const precipRef = { hour: 6, record };
  const snowRef = { hour: 6, kind: "direct", sourceKey: "snow:6", record };
  const entries = [{ key: "snowKuchera", methodVersion: "test-v1" }];
  const step = { startHour: 3, endHour: 6, chunks: [{ key: "snow:6", kind: "direct", terms: [snowRef] }] };
  for (const payloadBuilder of [
    (context) => runMaxCumulativeGridPayload({ ...runMaxArgs, context }),
    (context) => precipSourceGridCachePayload(precipRef, context),
    (context) => snowLiquidSourceGridCachePayload(snowRef, context),
    (context) => deltaSnowfallCachePayload({ entries, step, context }),
    (context) => cumulativeSnowfallCachePayload({ entries, targetHour: 6, context }),
  ]) {
    assert.deepEqual(payloadBuilder(threeHourly), payloadBuilder(futureExtension));
    assert.notDeepEqual(payloadBuilder(threeHourly), payloadBuilder(hourly));
    assert.notDeepEqual(payloadBuilder(threeHourly), payloadBuilder(hole));
  }
});

test("snowfall F003 delta and cumulative sidecars exclude outer F006 lineage on cold write and warm restore", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-snow-lineage-cache-"));
  t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));
  const contextBase = cacheContext([0, 3, 6], "three-hourly");
  const record3 = { ...precipRecord(), record: "3", forecast: "0-3 hour acc fcst" };
  const record6 = { ...precipRecord(), record: "6", forecast: "0-6 hour acc fcst" };
  const source3 = exactSourceForRecord(record3, { hour: 3, sha: "a" });
  const source6 = exactSourceForRecord(record6, { hour: 6, sha: "b" });
  const derivationFor = (hour, record, idToken) => ({
    id: `temporal:${idToken.repeat(64)}`,
    family: "snowfall-accumulation",
    outputKey: "snowKuchera",
    targetHour: hour,
    terms: [
      {
        sourceHour: hour,
        role: "value",
        weight: 1,
        sourceKey: `snow:${hour}`,
        kind: "direct",
        startHour: 0,
        endHour: hour,
        record: {
          record: record.record,
          param: record.param,
          level: record.level,
          forecast: record.forecast,
          extra: null,
          referenceTimeToken: null,
          rawInventory: null,
        },
      },
    ],
  });
  const derivation3 = derivationFor(3, record3, "c");
  const derivation6 = derivationFor(6, record6, "d");
  const coldSession = createFrameDecodeSession();
  restoreFrameProvenanceCacheSnapshot(coldSession, {
    schemaVersion: 1,
    sources: [source3, source6],
    // Reproduce the inner-prefix write while its outer F006 request is already
    // registered in the same cold-build session.
    temporalDerivations: [derivation3, derivation6],
  });
  const coldContext = { ...contextBase, decodeSession: coldSession };
  const entries = [{ key: "snowKuchera", methodVersion: "test-v1" }];
  const ref = { hour: 3, kind: "direct", sourceKey: "snow:3", record: record3 };
  const payloads = [
    deltaSnowfallCachePayload({
      entries,
      step: { startHour: 0, endHour: 3, chunks: [{ key: "snow:3", kind: "direct", terms: [ref] }] },
      context: coldContext,
    }),
    cumulativeSnowfallCachePayload({ entries, targetHour: 3, context: coldContext }),
  ];

  for (const [index, payload] of payloads.entries()) {
    const cachePath = path.join(tempDir, `snow-${index}`);
    await writeCachedCumulativeSnowfallGrids(
      cachePath,
      payload,
      new Map([["snowKuchera", new Float32Array([1.25, 2.5])]]),
      coldContext,
    );
    const sidecar = JSON.parse(await fs.promises.readFile(`${cachePath}.json`, "utf8"));
    assert.equal(sidecar.provenanceSnapshot.sources.length, 1);
    assert.equal(sidecar.provenanceSnapshot.sources[0].id, source3.id);
    assert.equal(sidecar.provenanceSnapshot.temporalDerivations.length, 1);
    assert.equal(sidecar.provenanceSnapshot.temporalDerivations[0].targetHour, 3);

    const warmSession = createFrameDecodeSession();
    const warm = await readCachedCumulativeSnowfallGrids(cachePath, payload, {
      ...contextBase,
      decodeSession: warmSession,
    });
    assert.deepEqual(Array.from(warm.get("snowKuchera")), [1.25, 2.5]);
    assert.deepEqual(
      getFrameSourceProvenanceSources(warmSession).map((entry) => entry.id),
      [source3.id],
    );
    assert.deepEqual(
      getFrameTemporalProvenanceDerivations(warmSession).map((entry) => entry.targetHour),
      [3],
    );
    if (index === 0) {
      await fs.promises.appendFile(`${cachePath}.bin`, Buffer.from([0]));
      const corruptSession = createFrameDecodeSession();
      assert.equal(
        await readCachedCumulativeSnowfallGrids(cachePath, payload, {
          ...contextBase,
          decodeSession: corruptSession,
        }),
        null,
      );
      assert.deepEqual(getFrameSourceProvenanceSources(corruptSession), []);
      assert.deepEqual(getFrameTemporalProvenanceDerivations(corruptSession), []);
    }
  }
});

test("forecast-hour roster exact identity changes when the tier changes even for the same hour list", () => {
  const hours = [0, 3, 6];
  const defaultTier = buildForecastHourRosterIdentity({ modelKey: "gfs", hours, tier: "three-hourly" });
  const hourlyTier = buildForecastHourRosterIdentity({ modelKey: "gfs", hours, tier: "hourly-through-f120" });
  assert.notEqual(defaultTier.id, hourlyTier.id);
  assert.equal(defaultTier.canonicalPrefix, true);
  assert.equal(hourlyTier.canonicalPrefix, false);
});

test("snowfall and FRAM profile provenance enumerates predictor records, hours, roles, weights, and coverage", async () => {
  const entry = { key: "snowTest", profileVariables: ["TMP", "HGT"], profileLevels: [850] };
  const completeRecords = [
    rawRecord("HGT", "surface", "1"),
    rawRecord("TMP", "2 m above ground", "2"),
    rawRecord("TMP", "850 mb", "3"),
    rawRecord("HGT", "850 mb", "4"),
  ];
  const complete = buildSnowfallProfileInputForEntry({ entry, records: completeRecords, hour: 3 });
  assert.equal(complete.requiredRoles.length, 4);
  assert.deepEqual(complete.missingRoles, []);
  assert.equal(
    complete.terms.every((term) => term.hour === 3 && term.weight === 1),
    true,
  );
  assert.equal(
    complete.terms.some((term) => term.role === "snowfall-profile:snowTest:profileTmp850"),
    true,
  );

  const incomplete = buildSnowfallProfileInputForEntry({ entry, records: completeRecords.slice(0, 3), hour: 3 });
  assert.deepEqual(incomplete.missingRoles, ["F003:snowTest:profileHgt850"]);

  const framRecords = [
    rawRecord("TMP", "2 m above ground", "5"),
    rawRecord("DPT", "2 m above ground", "6"),
    rawRecord("RH", "2 m above ground", "7"),
    rawRecord("UGRD", "10 m above ground", "8"),
    rawRecord("VGRD", "10 m above ground", "9"),
  ];
  const fram = await buildFramProfileProvenance({
    chunks: [{ key: "ice-0-3", startHour: 0, endHour: 3, profileHour: 3, profileHours: [1, 3] }],
    profilesByHour: new Map([
      [1, {}],
      [3, {}],
    ]),
    context: {
      recordsByHour: new Map([
        [1, framRecords],
        [3, framRecords],
      ]),
    },
  });
  assert.equal(fram.inputCoverage.complete, true);
  assert.equal(fram.terms.length, 10);
  assert.ok(fram.terms.some((term) => term.hour === 1 && Math.abs(term.weight - 1 / 3) < 1e-12));
  assert.ok(fram.terms.some((term) => term.hour === 3 && Math.abs(term.weight - 2 / 3) < 1e-12));
  assert.ok(fram.terms.some((term) => term.role === "fram-profile:windU10m"));

  const liquidTerm = {
    hour: 3,
    role: "freezing-rain-liquid",
    sourceKey: "freezingRainLiquid",
    kind: "accumulation",
    weight: 1,
    record: rawRecord("APCP", "surface", "10"),
  };
  const combinedFram = buildFramOutputProvenance({
    sourceRefs: [liquidTerm],
    profileProvenance: fram,
  });
  assert.equal(combinedFram.inputCoverage.complete, true);
  assert.equal(combinedFram.terms.includes(liquidTerm), true, "each FRAM output must explicitly carry its liquid term");
  assert.ok(combinedFram.terms.some((term) => term.role === "fram-profile:windU10m"));
  const zeroFram = buildFramOutputProvenance({ sourceRefs: [liquidTerm], requiresProfile: false });
  assert.equal(zeroFram.inputCoverage.complete, true);
  assert.deepEqual(zeroFram.terms, [liquidTerm]);

  const drySession = createFrameDecodeSession();
  const dryProfiles = await decodeIntervalSnowfallProfiles({
    entries: [entry],
    chunks: [],
    targetHour: 3,
    context: { decodeSession: drySession },
    decoded: {},
  });
  assert.equal(dryProfiles.size, 0);
  assert.deepEqual(
    getFrameTemporalProvenanceDerivations(drySession),
    [],
    "a zero-liquid snowfall output must not claim unused profile inputs",
  );
});

test("profile-grid cold, shared-promise, and disk-warm hits restore source provenance into each session", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-profile-lineage-"));
  t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));
  PROFILE_GRID_PROMISE_CACHE.clear();
  const record = rawRecord("TMP", "850 mb", "11");
  const source = exactSourceForRecord(record, { hour: 6, sha: "d" });
  const base = {
    ...cacheContext([0, 3, 6], "three-hourly"),
    profileGridCacheDir: tempDir,
  };
  const payload = profileGridCachePayload({ recordsByKey: { profileTmp850: record }, hour: 6, context: base });
  const firstSession = createFrameDecodeSession();
  firstSession.runSourceProvenanceCatalog = new Map([[source.id, source]]);
  let releaseDecode;
  const decodeGate = new Promise((resolve) => {
    releaseDecode = resolve;
  });
  const first = readOrDecodeCachedProfileGrids(payload, { ...base, decodeSession: firstSession }, async () => {
    await decodeGate;
    return { profileTmp850: new Float32Array([270, 271]) };
  });
  await new Promise((resolve) => setImmediate(resolve));
  const secondSession = createFrameDecodeSession();
  const second = readOrDecodeCachedProfileGrids(payload, { ...base, decodeSession: secondSession }, async () => {
    throw new Error("shared profile promise should prevent a second decode");
  });
  releaseDecode();
  await Promise.all([first, second]);
  assert.deepEqual(
    getFrameSourceProvenanceSources(secondSession).map((item) => item.id),
    [source.id],
  );

  const diskWarmSession = createFrameDecodeSession();
  const diskWarm = await readOrDecodeCachedProfileGrids(
    payload,
    { ...base, decodeSession: diskWarmSession },
    async () => {
      throw new Error("validated profile disk cache should prevent a decode");
    },
  );
  assert.deepEqual(Array.from(diskWarm.profileTmp850), [270, 271]);
  assert.deepEqual(
    getFrameSourceProvenanceSources(diskWarmSession).map((item) => item.id),
    [source.id],
  );
});

test("run-local decoded and derived grid reuse restores the exact producing source into each frame", async () => {
  const record = rawRecord("TMP", "850 mb", "31");
  const source = exactSourceForRecord(record, { hour: 6, sha: "9" });
  const duplicateBundle = exactSourceForRecord(record, { hour: 6, sha: "7" });
  const context = {
    ...cacheContext([0, 3, 6], "three-hourly"),
    baseUrl: "https://lineage-cache.example.test",
    forecastHourCompletionIdentity: "run-local-lineage-test",
  };
  const firstSession = createFrameDecodeSession();
  attachRunLocalDecodeSession(firstSession, context);
  firstSession.sourceProvenanceSources.set(source.id, source);
  firstSession.sourceProvenanceSources.set(duplicateBundle.id, duplicateBundle);
  firstSession.runSourceProvenanceCatalog.set(source.id, source);
  firstSession.runSourceProvenanceCatalog.set(duplicateBundle.id, duplicateBundle);
  const values = new Float32Array([270, 271]);
  writeDecodedRecordGridCache({
    record,
    values,
    hour: 6,
    bounds: context.bounds,
    width: context.width,
    height: context.height,
    rowInterpolation: "bilinear",
    decodeSession: firstSession,
    sourceRef: source.id,
  });
  registerSourceGrid({
    family: "lineage-test",
    payload: { hour: 6, record: record.record },
    context: { ...context, decodeSession: firstSession },
    values,
    provenanceTerms: [{ hour: 6, record }],
  });
  registerProfileGrids({
    recordsByKey: { profileTmp850: record },
    hour: 6,
    context: { ...context, decodeSession: firstSession },
    decoded: { profileTmp850: values },
  });

  const decodedSession = createFrameDecodeSession();
  attachRunLocalDecodeSession(decodedSession, context);
  const decoded = readDecodedRecordsForKeyedRecords({
    recordsByKey: { profileTmp850: record },
    hour: 6,
    context: { ...context, decodeSession: decodedSession },
  });
  assert.deepEqual(Array.from(decoded.profileTmp850), [270, 271]);
  assert.deepEqual(
    getFrameSourceProvenanceSources(decodedSession).map((item) => item.id),
    [source.id],
  );

  const profileSession = createFrameDecodeSession();
  attachRunLocalDecodeSession(profileSession, context);
  const profile = readRegisteredProfileGrids({
    recordsByKey: { profileTmp850: record },
    hour: 6,
    context: { ...context, decodeSession: profileSession },
  });
  assert.deepEqual(Array.from(profile.profileTmp850), [270, 271]);
  assert.deepEqual(
    getFrameSourceProvenanceSources(profileSession).map((item) => item.id),
    [source.id],
  );

  const derivedSession = createFrameDecodeSession();
  attachRunLocalDecodeSession(derivedSession, context);
  const derived = await readRegisteredSourceGrid({
    family: "lineage-test",
    payload: { hour: 6, record: record.record },
    context: { ...context, decodeSession: derivedSession },
  });
  assert.deepEqual(Array.from(derived), [270, 271]);
  assert.deepEqual(
    getFrameSourceProvenanceSources(derivedSession).map((item) => item.id),
    [source.id],
  );
});

test("run-max shared promises restore cumulative source and temporal lineage into the second frame session", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-runmax-lineage-"));
  t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));
  RUN_MAX_GRID_PROMISE_CACHE.clear();
  const record = rawRecord("GUST", "surface", "12");
  const sourceInput = exactSourceForRecord(record, { hour: 6, sha: "e" });
  const source = { sourceKey: "gust", selector: { param: "GUST", level: "surface" }, multiplier: 1 };
  const base = {
    ...cacheContext([0, 3, 6], "three-hourly"),
    targetHour: 6,
    recordsByHour: new Map([[6, [record]]]),
    cumulativeGridCacheDir: tempDir,
  };
  const firstSession = createFrameDecodeSession();
  let releaseCompute;
  const computeGate = new Promise((resolve) => {
    releaseCompute = resolve;
  });
  const first = readOrComputeCachedRunMaxGrid({
    key: "gustRunMax",
    source,
    hour: 6,
    context: { ...base, decodeSession: firstSession },
    compute: async () => {
      restoreFrameProvenanceCacheSnapshot(firstSession, {
        schemaVersion: 1,
        sources: [sourceInput],
        temporalDerivations: [],
      });
      await computeGate;
      return new Float32Array([20, 25]);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const secondSession = createFrameDecodeSession();
  const second = readOrComputeCachedRunMaxGrid({
    key: "gustRunMax",
    source,
    hour: 6,
    context: { ...base, decodeSession: secondSession },
    compute: async () => {
      throw new Error("shared run-max promise should prevent a second compute");
    },
  });
  releaseCompute();
  await Promise.all([first, second]);
  assert.deepEqual(
    getFrameSourceProvenanceSources(secondSession).map((item) => item.id),
    [sourceInput.id],
  );
  assert.equal(
    getFrameTemporalProvenanceDerivations(secondSession).some(
      (derivation) => derivation.family === "run-maximum" && derivation.terms[0]?.sourceHour === 6,
    ),
    true,
  );
});

test("run-max recursive prefix sidecars exclude future-target derivations", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-runmax-prefix-lineage-"));
  t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));
  RUN_MAX_GRID_PROMISE_CACHE.clear();
  const record3 = { ...rawRecord("GUST", "surface", "21"), forecast: "3 hour fcst" };
  const record6 = { ...rawRecord("GUST", "surface", "22"), forecast: "6 hour fcst" };
  const source = { sourceKey: "gust", selector: { param: "GUST", level: "surface" }, multiplier: 1 };
  const context = {
    ...cacheContext([0, 3, 6], "three-hourly"),
    targetHour: 6,
    recordsByHour: new Map([
      [3, [record3]],
      [6, [record6]],
    ]),
    cumulativeGridCacheDir: tempDir,
    decodeSession: createFrameDecodeSession(),
  };
  const build = (hour) =>
    readOrComputeCachedRunMaxGrid({
      key: "gustRunMax",
      source,
      hour,
      context,
      compute: async ({ target }) => {
        if (target === 6) {
          await build(3);
        }
        return new Float32Array([target, target + 1]);
      },
    });
  await build(6);

  const prefixPayload = runMaxCumulativeGridPayload({
    key: "gustRunMax",
    source,
    hour: 3,
    record: record3,
    context,
  });
  const prefixPath = runMaxGridCachePath(tempDir, prefixPayload, context);
  const prefixMetadata = JSON.parse(await fs.promises.readFile(`${prefixPath}.json`, "utf8"));
  assert.deepEqual(
    prefixMetadata.provenanceSnapshot.temporalDerivations.map((derivation) => derivation.targetHour),
    [3],
  );

  const warmSession = createFrameDecodeSession();
  await readOrComputeCachedRunMaxGrid({
    key: "gustRunMax",
    source,
    hour: 3,
    context: { ...context, decodeSession: warmSession },
    compute: async () => {
      throw new Error("validated F003 cache should prevent recomputation");
    },
  });
  assert.deepEqual(
    getFrameTemporalProvenanceDerivations(warmSession).map((derivation) => derivation.targetHour),
    [3],
  );
});

test("exact temporal disclosure fails closed when a required predictor role is missing", () => {
  const record = {
    ...rawRecord("TMP", "850 mb", "13"),
    referenceTimeToken: "d=2026071100",
    rawInventory: "13:0:d=2026071100:TMP:850 mb:6 hour fcst:",
    byteRange: { start: 0, endInclusive: 127 },
  };
  const source = exactSourceForRecord(record, { hour: 6, sha: "f" });
  const common = {
    gribUrl: source.gribUrl,
    idxUrl: source.idxUrl,
    selection: { records: {}, catalog: [] },
    bounds: { west: -130, south: 20, east: -60, north: 55 },
    width: 2,
    height: 1,
    sourceInputs: [source],
  };
  const derivation = {
    family: "snowfall-profile-inputs",
    outputKey: "snowTest",
    targetHour: 6,
    terms: [{ sourceHour: 6, role: "snowfall-profile:snowTest:profileTmp850", weight: 1, record }],
  };
  const incomplete = buildFrameSourceProvenance({
    ...common,
    temporalDerivations: [
      {
        ...derivation,
        inputCoverage: {
          complete: false,
          requiredRoles: ["F006:snowTest:profileTmp850", "F006:snowTest:profileHgt850"],
          recordedRoles: ["F006:snowTest:profileTmp850"],
          missingRoles: ["F006:snowTest:profileHgt850"],
        },
      },
    ],
  });
  assert.equal(incomplete.temporalDerivedInputs.exactTemporalReferencesRecorded, false);
  assert.match(incomplete.temporalDerivedInputs.disclosure, /required input role is missing/);

  const complete = buildFrameSourceProvenance({
    ...common,
    temporalDerivations: [
      {
        ...derivation,
        inputCoverage: {
          complete: true,
          requiredRoles: ["F006:snowTest:profileTmp850"],
          recordedRoles: ["F006:snowTest:profileTmp850"],
          missingRoles: [],
        },
      },
    ],
  });
  assert.equal(complete.temporalDerivedInputs.exactTemporalReferencesRecorded, true);

  const mismatchedReferenceRecord = {
    ...record,
    referenceTimeToken: "d=2026071106",
    rawInventory: "13:0:d=2026071106:TMP:850 mb:6 hour fcst:",
  };
  const mismatchedReferenceSource = exactSourceForRecord(mismatchedReferenceRecord, { hour: 6, sha: "e" });
  const mismatchedReference = buildFrameSourceProvenance({
    ...common,
    sourceInputs: [mismatchedReferenceSource],
    temporalDerivations: [
      {
        ...derivation,
        terms: [
          {
            sourceHour: 6,
            role: "snowfall-profile:snowTest:profileTmp850",
            weight: 1,
            record: mismatchedReferenceRecord,
          },
        ],
      },
    ],
  });
  assert.equal(mismatchedReference.temporalDerivedInputs.exactTemporalReferencesRecorded, false);

  const windowedRecord = {
    ...record,
    record: "14",
    forecast: "0-6 hour acc fcst",
    rawInventory: "14:128:d=2026071100:APCP:surface:0-6 hour acc fcst:",
    statisticalWindow: { statistic: "accumulation", startHour: 0, endHour: 6 },
    byteRange: { start: 128, endInclusive: 255 },
  };
  const windowedSource = exactSourceForRecord(windowedRecord, { hour: 6, sha: "d" });
  const mismatchedWindow = buildFrameSourceProvenance({
    ...common,
    sourceInputs: [windowedSource],
    temporalDerivations: [
      {
        family: "precipitation-accumulation",
        outputKey: "precip6h",
        targetHour: 6,
        terms: [{ sourceHour: 6, role: "value", weight: 1, startHour: 1, endHour: 6, record: windowedRecord }],
      },
    ],
  });
  assert.equal(mismatchedWindow.temporalDerivedInputs.exactTemporalReferencesRecorded, false);

  const matchedWindow = buildFrameSourceProvenance({
    ...common,
    sourceInputs: [windowedSource],
    temporalDerivations: [
      {
        family: "precipitation-accumulation",
        outputKey: "precip6h",
        targetHour: 6,
        terms: [{ sourceHour: 6, role: "value", weight: 1, startHour: 0, endHour: 6, record: windowedRecord }],
      },
    ],
  });
  assert.equal(matchedWindow.temporalDerivedInputs.exactTemporalReferencesRecorded, true);

  const missingOutputKey = buildFrameSourceProvenance({
    ...common,
    temporalDerivations: [{ ...derivation, outputKey: null }],
  });
  assert.equal(missingOutputKey.temporalDerivedInputs.exactTemporalReferencesRecorded, false);

  const duplicateBundle = {
    ...source,
    id: `noaa-selected:${"8".repeat(64)}`,
    selectedHash: "different-selected-bundle",
    selectedSha256: "8".repeat(64),
  };
  const ambiguousBundle = buildFrameSourceProvenance({
    ...common,
    sourceInputs: [source, duplicateBundle],
    temporalDerivations: [derivation],
  });
  assert.equal(ambiguousBundle.temporalDerivedInputs.exactTemporalReferencesRecorded, false);
  assert.equal(ambiguousBundle.temporalDerivedInputs.derivations[0].terms[0].sourceRef, null);
  assert.deepEqual(ambiguousBundle.temporalDerivedInputs.derivations[0].terms[0].ambiguousSourceRefs, [
    duplicateBundle.id,
    source.id,
  ]);

  const catalog = [
    { key: "snowTest", kind: "snowfallDerived" },
    { key: "precip1h", kind: "precipAccumulation" },
  ];
  const unavailableExcluded = buildFrameSourceProvenance({
    ...common,
    selection: { records: {}, catalog, availableParameters: ["snowTest", "precip1h"] },
    parameterAvailability: { snowTest: "available", precip1h: "unavailable" },
    temporalDerivations: [complete.temporalDerivedInputs.derivations[0]],
  });
  assert.deepEqual(unavailableExcluded.temporalDerivedInputs.expectedOutputKeys, ["snowTest"]);
  assert.deepEqual(unavailableExcluded.temporalDerivedInputs.missingOutputKeys, []);
  assert.equal(unavailableExcluded.temporalDerivedInputs.exactTemporalReferencesRecorded, true);

  const missingAvailableOutput = buildFrameSourceProvenance({
    ...common,
    selection: { records: {}, catalog, availableParameters: ["snowTest", "precip1h"] },
    parameterAvailability: { snowTest: "available", precip1h: "available" },
    temporalDerivations: [complete.temporalDerivedInputs.derivations[0]],
  });
  assert.deepEqual(missingAvailableOutput.temporalDerivedInputs.missingOutputKeys, ["precip1h"]);
  assert.equal(missingAvailableOutput.temporalDerivedInputs.exactTemporalReferencesRecorded, false);

  const emptyRecordedOutput = buildFrameSourceProvenance({
    ...common,
    selection: { records: {}, catalog, availableParameters: ["snowTest", "precip1h"] },
    parameterAvailability: { snowTest: "available", precip1h: "available" },
    temporalDerivations: [
      complete.temporalDerivedInputs.derivations[0],
      { family: "precipitation-accumulation", outputKey: "precip1h", targetHour: 6, terms: [] },
    ],
  });
  assert.deepEqual(emptyRecordedOutput.temporalDerivedInputs.missingOutputKeys, []);
  assert.equal(
    emptyRecordedOutput.temporalDerivedInputs.exactTemporalReferencesRecorded,
    false,
    "an output-key placeholder without source terms must not satisfy exact per-output lineage",
  );
});
