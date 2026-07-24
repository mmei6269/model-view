"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const CHILD_FLAG = "MODELVIEW_RENDERER_FAST_PACK_TEST_CHILD";
const CHILD_CONFIG = "MODELVIEW_RENDERER_FAST_PACK_TEST_CONFIG";
const WIDTH = 4;
const HEIGHT = 4;
const FIELD_BYTES = WIDTH * HEIGHT * Float32Array.BYTES_PER_ELEMENT;
const SOURCE_BODY = Buffer.from("AAAABBBBCCCCDDDD");
const SELECTED_BODY = SOURCE_BODY.subarray(0, 12);
const EXPECTED_SELECTED_SHA256 = sha256(SELECTED_BODY);
const IDX_TEXT = [
  "1:0:d=2026071412:TMP:2 m above ground:6 hour fcst:",
  "2:4:d=2026071412:UGRD:10 m above ground:6 hour fcst:",
  "3:8:d=2026071412:VGRD:10 m above ground:6 hour fcst:",
  "4:12:d=2026071412:ZZZZ:fixture sentinel:6 hour fcst:",
  "",
].join("\n");

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function appendEvent(eventLog, event) {
  fs.appendFileSync(eventLog, `${JSON.stringify(event)}\n`);
}

function readEvents(eventLog) {
  if (!fs.existsSync(eventLog)) {
    return [];
  }
  return fs
    .readFileSync(eventLog, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function stableValue(value) {
  if (Buffer.isBuffer(value)) {
    return { $buffer: value.toString("base64") };
  }
  if (value instanceof ArrayBuffer) {
    return { $arrayBuffer: Buffer.from(value).toString("base64") };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      $typedArray: value.constructor.name,
      body: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    };
  }
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== "renderProfile" && typeof value[key] !== "function" && value[key] !== undefined)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function artifactDigest(artifacts) {
  return sha256(Buffer.from(JSON.stringify(stableValue(artifacts))));
}

function surfaceOnlySelection() {
  return {
    categories: {
      surface: { enabled: true, tier: "full" },
      precip: { enabled: false, tier: "full" },
      radar: { enabled: false, tier: "full" },
      cloud: { enabled: false, tier: "full" },
      severe: { enabled: false, tier: "full" },
      winter: { enabled: false, tier: "full" },
      upperAir: { enabled: false, tier: "full" },
    },
  };
}

function responseHeaders(values) {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
  );
  return {
    get(name) {
      return normalized[String(name).toLowerCase()] ?? null;
    },
  };
}

function installFixtureFetch(config) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || "GET").toUpperCase();
    const range = options.headers?.Range || options.headers?.range;
    if (config.networkPolicy === "deny") {
      appendEvent(config.eventLog, { type: "fetch-denied", method, target, range: range || null });
      return {
        ok: false,
        status: 403,
        headers: responseHeaders({}),
        text: async () => "",
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    if (target.endsWith(".idx") && method === "GET") {
      appendEvent(config.eventLog, { type: "fetch-idx", method, target });
      return {
        ok: true,
        status: 200,
        headers: responseHeaders({ "content-length": Buffer.byteLength(IDX_TEXT) }),
        text: async () => IDX_TEXT,
      };
    }
    if (method === "HEAD") {
      appendEvent(config.eventLog, { type: "fetch-head", method, target });
      return {
        ok: true,
        status: 200,
        headers: responseHeaders({ "content-length": SOURCE_BODY.length }),
      };
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(range || ""));
    if (method === "GET" && match) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = SOURCE_BODY.subarray(start, end + 1);
      appendEvent(config.eventLog, { type: "fetch-range", method, target, range, bytes: body.length });
      return {
        ok: true,
        status: 206,
        headers: responseHeaders({
          "content-length": body.length,
          "content-range": `bytes ${start}-${end}/${SOURCE_BODY.length}`,
        }),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      };
    }
    appendEvent(config.eventLog, { type: "fetch-unexpected", method, target, range: range || null });
    return {
      ok: false,
      status: 404,
      headers: responseHeaders({}),
      text: async () => "",
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  return () => {
    global.fetch = originalFetch;
  };
}

function installSelectedBodyReadSpy(config) {
  const originalCreateReadStream = fs.createReadStream;
  let selectedBodyStreams = 0;
  fs.createReadStream = function patchedCreateReadStream(filePath, ...args) {
    if (config.selectedPath && path.resolve(String(filePath)) === path.resolve(config.selectedPath)) {
      selectedBodyStreams += 1;
      appendEvent(config.eventLog, { type: "selected-body-hash", path: path.resolve(String(filePath)) });
    }
    return originalCreateReadStream.call(fs, filePath, ...args);
  };
  return {
    count() {
      return selectedBodyStreams;
    },
    restore() {
      fs.createReadStream = originalCreateReadStream;
    },
  };
}

function currentSources(sourceProvenance) {
  const currentRefs = new Set(sourceProvenance?.currentSourceRefs || []);
  return (sourceProvenance?.sources || []).filter((source) => currentRefs.has(source.id));
}

function installRendererTransactionSpies(config) {
  const gribSource = require("../scripts/lib/noaa-beta/grib-source");
  const sessions = [];
  const originalCreateFrameDecodeSession = gribSource.createFrameDecodeSession;
  const originalCommitSelectedGribProvenance = gribSource.commitSelectedGribProvenance;
  const originalSeedDecodedSelectionRecordCache = gribSource.seedDecodedSelectionRecordCache;
  gribSource.createFrameDecodeSession = (...args) => {
    const session = originalCreateFrameDecodeSession(...args);
    sessions.push(session);
    return session;
  };
  gribSource.commitSelectedGribProvenance = (decodeSession, gribPath, source) => {
    const committed = originalCommitSelectedGribProvenance(decodeSession, gribPath, source);
    appendEvent(config.eventLog, {
      type: "fast-provenance-commit",
      sourceId: committed?.id || null,
      runCacheAttached: Boolean(decodeSession?.runCache),
      selectedRefMatches: decodeSession?.selectedGribSourceRefs?.get(String(gribPath)) === committed?.id,
      sourceCatalogHasCommit: decodeSession?.sourceProvenanceSources?.get(committed?.id) === committed,
    });
    return committed;
  };
  gribSource.seedDecodedSelectionRecordCache = (args) => {
    const seeded = originalSeedDecodedSelectionRecordCache(args);
    appendEvent(config.eventLog, {
      type: "fast-record-cache-seed",
      seeded,
      runCacheAttached: Boolean(args?.decodeSession?.runCache),
      usesRunLocalStore: args?.decodeSession?.decodedRecordGrids === args?.decodeSession?.runCache?.decodedRecordGrids,
      sourceRefRegistered: [...(args?.decodeSession?.selectedGribSourceRefs?.values?.() || [])].includes(
        args?.sourceRef,
      ),
    });
    return seeded;
  };
  return {
    snapshots() {
      return sessions.map((session) => ({
        runCacheAttached: Boolean(session.runCache),
        decodedGridPromises: session.decodedGridPromises?.size ?? null,
        decodedRecordGrids: session.decodedRecordGrids?.size ?? null,
        sourceProvenanceSources: session.sourceProvenanceSources?.size ?? null,
        selectedGribSourceRefs: session.selectedGribSourceRefs?.size ?? null,
      }));
    },
  };
}

async function runChild(config) {
  fs.writeFileSync(config.eventLog, "");
  process.env.MODELVIEW_NOAA_FAST_PACK = config.fastPack;
  process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE = "1";
  process.env.MODELVIEW_NOAA_HOVER_ARENA = "off";
  process.env.RENDERER_FAST_PACK_EVENT_LOG = config.eventLog;
  const restoreFetch = installFixtureFetch(config);
  const bodyReadSpy = installSelectedBodyReadSpy(config);
  const transactionSpies = installRendererTransactionSpies(config);
  let result;
  try {
    const { renderNoaaGribFrame } = require("../scripts/lib/noaa-beta-renderer");
    const artifacts = await renderNoaaGribFrame({
      modelKey: "nam",
      latestMetadata: {
        modelKey: "nam",
        hoverGridFormat: "json",
        noaa: {
          date: "20260714",
          cycle: "12",
          baseUrl: "https://fixture.invalid/noaa",
        },
      },
      framePlan: {
        hour: 6,
        validTime: "2026-07-14T18:00:00.000Z",
      },
      renderWidth: WIDTH,
      renderHeight: HEIGHT,
      noaaBaseUrl: "https://fixture.invalid/noaa",
      wgrib2Path: config.wgrib2Path,
      rawCacheDir: config.cacheRoot,
      tempRoot: config.tempRoot,
      rangeFetchConcurrency: 3,
      decodeConcurrency: 1,
      derivedCellConcurrency: 1,
      compressThreads: 0,
      hoverGridFormat: "json",
      renderMode: "all",
      renderSelection: surfaceOnlySelection(),
    });
    result = {
      ok: true,
      digest: artifactDigest(artifacts),
      profile: artifacts.renderProfile,
      sourceProvenance: artifacts.sourceProvenance,
      currentSources: currentSources(artifacts.sourceProvenance),
    };
  } catch (error) {
    result = {
      ok: false,
      error: {
        name: error?.name || "Error",
        message: String(error?.message || error),
        code: error?.code || null,
      },
    };
  } finally {
    result.selectedBodyStreams = bodyReadSpy.count();
    bodyReadSpy.restore();
    restoreFetch();
    result.sessionSnapshots = transactionSpies.snapshots();
    result.events = readEvents(config.eventLog);
    if (config.selectedPath && fs.existsSync(config.selectedPath)) {
      result.selectedBodySha256 = sha256(fs.readFileSync(config.selectedPath));
      result.selectedBodyBytes = fs.statSync(config.selectedPath).size;
    }
    fs.writeFileSync(config.resultPath, JSON.stringify(result));
  }
}

function floatBody(values) {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

async function writeFakeWgrib2(root) {
  const temperature = new Float32Array(WIDTH * HEIGHT);
  const windU = new Float32Array(WIDTH * HEIGHT);
  const windV = new Float32Array(WIDTH * HEIGHT);
  for (let index = 0; index < temperature.length; index += 1) {
    temperature[index] = 281.5 + index * 0.25;
    windU[index] = 4 + index * 0.125;
    windV[index] = -2.5 + index * 0.0625;
  }
  const binaryBody = Buffer.concat([floatBody(temperature), floatBody(windU), floatBody(windV)]);
  const inventory = [
    "1:0:d=2026071412:TMP:2 m above ground:6 hour fcst:",
    `2:${FIELD_BYTES}:d=2026071412:UGRD:10 m above ground:6 hour fcst:`,
    `3:${FIELD_BYTES * 2}:d=2026071412:VGRD:10 m above ground:6 hour fcst:`,
  ].join("\n");
  const executablePath = path.join(root, "fake-wgrib2.js");
  const source = [
    "#!/usr/bin/env node",
    '"use strict";',
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    "const eventLog = process.env.RENDERER_FAST_PACK_EVENT_LOG;",
    'if (eventLog) fs.appendFileSync(eventLog, `${JSON.stringify({ type: "wgrib2", args })}\\n`);',
    'if (args.includes("-version")) { console.log("wgrib2 renderer-fast-pack fixture 3.1.0"); process.exit(0); }',
    "const output = args[args.length - 1];",
    'if (args.includes("-bin")) {',
    `  fs.writeFileSync(output, Buffer.from(${JSON.stringify(binaryBody.toString("base64"))}, "base64"));`,
    `  console.log(${JSON.stringify(inventory)});`,
    "} else {",
    '  fs.writeFileSync(output, "fixture regridded GRIB");',
    "}",
    "",
  ].join("\n");
  await fs.promises.writeFile(executablePath, source);
  await fs.promises.chmod(executablePath, 0o755);
  return executablePath;
}

async function findFiles(root, predicate) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (predicate(entryPath)) {
        matches.push(entryPath);
      }
    }
  }
  await visit(root);
  return matches.sort();
}

async function findSelectedGrib(root) {
  const candidates = await findFiles(
    root,
    (filePath) => filePath.endsWith(".grib2") && fs.existsSync(`${filePath}.ready.json`),
  );
  assert.equal(candidates.length, 1, `expected exactly one selected GRIB under ${root}`);
  return candidates[0];
}

async function findMercatorPack(root) {
  const candidates = await findFiles(
    root,
    (filePath) => path.basename(filePath).includes(".mercator-") && filePath.endsWith(".bin"),
  );
  assert.equal(candidates.length, 1, `expected exactly one Mercator pack under ${root}`);
  return candidates[0];
}

async function runIsolatedChild(root, options) {
  const resultPath = path.join(root, `${options.label}-result.json`);
  const eventLog = path.join(root, `${options.label}-events.jsonl`);
  const config = {
    ...options,
    resultPath,
    eventLog,
    tempRoot: root,
  };
  const encodedConfig = Buffer.from(JSON.stringify(config)).toString("base64");
  await execFileAsync(process.execPath, [__filename], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      [CHILD_FLAG]: "1",
      [CHILD_CONFIG]: encodedConfig,
    },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(await fs.promises.readFile(resultPath, "utf8"));
}

function mutateSelectedBody(filePath) {
  const body = fs.readFileSync(filePath);
  for (let index = 0; index < body.length; index += 1) {
    body[index] ^= 0x5a;
  }
  assert.notEqual(sha256(body), EXPECTED_SELECTED_SHA256);
  fs.writeFileSync(filePath, body);
  return sha256(body);
}

function corruptPackBody(filePath) {
  const body = fs.readFileSync(filePath);
  assert.ok(body.length > 0);
  // Corrupt the final field, not the first one. The strict reader must first
  // materialize and validate every preceding grid, so this exercises a late
  // transactional failure rather than the cheapest early-reject case.
  body[body.length - 1] ^= 0x01;
  fs.writeFileSync(filePath, body);
}

function decoderEvents(events) {
  return events.filter((event) => event.type === "wgrib2" && !event.args.includes("-version"));
}

if (process.env[CHILD_FLAG] === "1") {
  const config = JSON.parse(Buffer.from(process.env[CHILD_CONFIG], "base64").toString("utf8"));
  runChild(config).catch((error) => {
    fs.writeFileSync(
      config.resultPath,
      JSON.stringify({
        ok: false,
        harnessError: {
          name: error?.name || "Error",
          message: String(error?.message || error),
          stack: String(error?.stack || ""),
        },
      }),
    );
    process.exitCode = 1;
  });
} else {
  test("renderer fast-pack commits exact warm output and rolls corrupt packs back through authoritative verification", async (t) => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "renderer-fast-pack-transaction-"));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const wgrib2Path = await writeFakeWgrib2(root);
    const seedCache = path.join(root, "seed-cache");
    await fs.promises.mkdir(seedCache);

    const seed = await runIsolatedChild(root, {
      label: "seed",
      cacheRoot: seedCache,
      wgrib2Path,
      fastPack: "off",
      networkPolicy: "fixture",
      selectedPath: null,
    });
    assert.equal(seed.ok, true, seed.error?.message);
    assert.equal(seed.profile.selectedGribFastPackProbes, 0);
    assert.equal(seed.profile.regridBinCacheMisses, 1);
    assert.equal(seed.profile.bulkDecodeFallbacks, 0);
    const seedSelectedPath = await findSelectedGrib(seedCache);
    const seedPackPath = await findMercatorPack(seedCache);
    assert.equal(sha256(fs.readFileSync(seedSelectedPath)), EXPECTED_SELECTED_SHA256);
    const seedPackSha256 = sha256(fs.readFileSync(seedPackPath));

    const autoCache = path.join(root, "auto-cache");
    await fs.promises.cp(seedCache, autoCache, { recursive: true });
    const autoSelectedPath = path.join(autoCache, path.relative(seedCache, seedSelectedPath));
    const mutatedSha256 = mutateSelectedBody(autoSelectedPath);
    const auto = await runIsolatedChild(root, {
      label: "auto-mutated",
      cacheRoot: autoCache,
      wgrib2Path,
      fastPack: "auto",
      networkPolicy: "deny",
      selectedPath: autoSelectedPath,
    });
    assert.equal(auto.ok, true, auto.error?.message);
    assert.equal(auto.digest, seed.digest, "valid exact pack must preserve every non-profile renderer artifact");
    assert.equal(auto.selectedBodyStreams, 0, "fast success must not stream/hash the selected GRIB body");
    assert.equal(auto.profile.selectedGribFastPackProbes, 1);
    assert.equal(auto.profile.selectedGribFastPackMetadataHits, 1);
    assert.equal(auto.profile.selectedGribHashBypasses, 1);
    assert.equal(auto.profile.selectedGribHashBypassBytes, SELECTED_BODY.length);
    assert.equal(auto.profile.selectedGribVerifyHashes, 0);
    assert.equal(auto.profile.selectedGribFastPackFallbacks, 0);
    assert.equal(auto.profile.bulkDecodeFallbacks, 0);
    assert.equal(decoderEvents(auto.events).length, 0, "exact warm pack must not invoke a body decoder");
    assert.equal(
      auto.events.some((event) => event.type.startsWith("fetch-")),
      false,
      "exact warm pack must not use network",
    );
    assert.equal(auto.currentSources.length, 1);
    assert.equal(auto.currentSources[0].selectedSha256, EXPECTED_SELECTED_SHA256);
    assert.equal(auto.selectedBodySha256, mutatedSha256, "fast success intentionally leaves the unused mutation alone");
    const autoCommits = auto.events.filter((event) => event.type === "fast-provenance-commit");
    const autoSeeds = auto.events.filter((event) => event.type === "fast-record-cache-seed");
    assert.equal(autoCommits.length, 1, "fast success must commit provenance exactly once");
    assert.deepEqual(
      {
        runCacheAttached: autoCommits[0].runCacheAttached,
        selectedRefMatches: autoCommits[0].selectedRefMatches,
        sourceCatalogHasCommit: autoCommits[0].sourceCatalogHasCommit,
      },
      {
        runCacheAttached: true,
        selectedRefMatches: true,
        sourceCatalogHasCommit: true,
      },
    );
    assert.equal(autoSeeds.length, 1, "fast success must promote record grids exactly once");
    assert.deepEqual(
      {
        seeded: autoSeeds[0].seeded,
        runCacheAttached: autoSeeds[0].runCacheAttached,
        usesRunLocalStore: autoSeeds[0].usesRunLocalStore,
        sourceRefRegistered: autoSeeds[0].sourceRefRegistered,
      },
      {
        seeded: 3,
        runCacheAttached: true,
        usesRunLocalStore: true,
        sourceRefRegistered: true,
      },
    );
    assert.equal(auto.sessionSnapshots.length, 2);
    assert.deepEqual(
      auto.sessionSnapshots[1],
      {
        runCacheAttached: false,
        decodedGridPromises: 0,
        decodedRecordGrids: 0,
        sourceProvenanceSources: 0,
        selectedGribSourceRefs: 0,
      },
      "the isolated success session must release all references after authoritative promotion",
    );

    const offCache = path.join(root, "off-cache");
    await fs.promises.cp(seedCache, offCache, { recursive: true });
    const offSelectedPath = path.join(offCache, path.relative(seedCache, seedSelectedPath));
    mutateSelectedBody(offSelectedPath);
    const off = await runIsolatedChild(root, {
      label: "off-mutated",
      cacheRoot: offCache,
      wgrib2Path,
      fastPack: "off",
      networkPolicy: "deny",
      selectedPath: offSelectedPath,
    });
    assert.equal(off.ok, false, "the off arm must reject an unverifiable same-size selected body");
    assert.ok(off.selectedBodyStreams > 0, "the off arm must authoritatively hash the selected body");
    assert.equal(decoderEvents(off.events).length, 0, "verification failure must happen before body decode");
    assert.ok(off.events.some((event) => event.type === "fetch-denied"));

    const corruptCache = path.join(root, "corrupt-cache");
    await fs.promises.cp(seedCache, corruptCache, { recursive: true });
    const corruptSelectedPath = path.join(corruptCache, path.relative(seedCache, seedSelectedPath));
    const corruptPackPath = path.join(corruptCache, path.relative(seedCache, seedPackPath));
    mutateSelectedBody(corruptSelectedPath);
    corruptPackBody(corruptPackPath);
    const corrupt = await runIsolatedChild(root, {
      label: "corrupt-pack",
      cacheRoot: corruptCache,
      wgrib2Path,
      fastPack: "auto",
      networkPolicy: "fixture",
      selectedPath: corruptSelectedPath,
    });
    assert.equal(corrupt.ok, true, corrupt.error?.message);
    assert.equal(corrupt.digest, seed.digest, "rollback must reproduce every non-profile renderer artifact exactly");
    assert.equal(corrupt.profile.selectedGribFastPackProbes, 1);
    assert.equal(corrupt.profile.selectedGribFastPackMetadataHits, 1);
    assert.equal(corrupt.profile.selectedGribFastPackFallbacks, 1);
    assert.equal(corrupt.profile.selectedGribHashBypasses, 0);
    assert.ok(corrupt.profile.selectedGribVerifyHashes > 0);
    assert.ok(corrupt.profile.selectedGribVerifyHashBytes >= SELECTED_BODY.length);
    assert.equal(corrupt.profile.regridBinCacheCorruptions, 1);
    assert.equal(corrupt.profile.regridBinCacheMisses, 1);
    assert.equal(corrupt.profile.bulkDecodeFallbacks, 0);
    assert.equal(corrupt.profile.decodedRecordGridHits, 0, "provisional grids must not leak into the verified retry");
    assert.equal(
      corrupt.selectedBodySha256,
      EXPECTED_SELECTED_SHA256,
      "authoritative retry must repair selected bytes",
    );
    assert.equal(sha256(fs.readFileSync(corruptPackPath)), seedPackSha256, "cold retry must replace the corrupt pack");
    assert.equal(corrupt.currentSources.length, 1);
    assert.equal(corrupt.currentSources[0].selectedSha256, EXPECTED_SELECTED_SHA256);
    assert.equal(JSON.stringify(corrupt.sourceProvenance).includes(mutatedSha256), false);
    assert.equal(
      corrupt.events.some(
        (event) => event.type === "fast-provenance-commit" || event.type === "fast-record-cache-seed",
      ),
      false,
      "a failed provisional decode must not commit provenance or seed authoritative record grids",
    );
    assert.equal(corrupt.sessionSnapshots.length, 2);
    assert.deepEqual(
      corrupt.sessionSnapshots[1],
      {
        runCacheAttached: false,
        decodedGridPromises: 0,
        decodedRecordGrids: 0,
        sourceProvenanceSources: 0,
        selectedGribSourceRefs: 0,
      },
      "late corruption must dispose the isolated session before the verified retry",
    );

    const hashIndex = corrupt.events.findIndex((event) => event.type === "selected-body-hash");
    const rangeIndex = corrupt.events.findIndex((event) => event.type === "fetch-range");
    const decodeIndex = corrupt.events.findIndex(
      (event) => event.type === "wgrib2" && !event.args.includes("-version"),
    );
    assert.ok(hashIndex >= 0, "corrupt-pack rollback must hash the selected body");
    assert.ok(rangeIndex > hashIndex, "selected-body verification must precede authoritative refetch");
    assert.ok(decodeIndex > rangeIndex, "authoritative refetch must precede every body decoder");
  });
}
