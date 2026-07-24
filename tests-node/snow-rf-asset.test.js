"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const {
  SNOW_RF_COMPILER_ID,
  compileSnowRfModel,
  inspectCompiledSnowRfModel,
} = require("../scripts/lib/noaa-beta/snow-rf-compiler");
const {
  DEFAULT_BINARY_PATH,
  DEFAULT_COMPILER_PATH,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SOURCE_PATH,
  SNOW_RF_ASSET_MATERIALIZATION_PHASES,
  SNOW_RF_ASSET_ORACLES,
  SNOW_RF_FIELD_SPECS,
  SNOW_RF_MODEL_ORACLES,
  SNOW_RF_RECEIPT_SCHEMA_VERSION,
  SNOW_RF_RECEIPT_TYPE,
  SNOW_RF_SOURCE_IDENTITY,
  buildSnowRfAssetStateSnapshot,
  buildSnowRfBenchmarkReceipt,
  buildSnowRfCompilerClosure,
  createSnowRfLoadedState,
  hostIsLittleEndian,
  materializeSnowRfAsset,
  requireLittleEndianHost,
  sha256,
  validateSnowRfAssetManifest,
} = require("../scripts/lib/noaa-beta/snow-rf-asset");
const {
  PUBLICATION_LOCK_BASENAME,
  assertGenerationInputsStable,
  generateSnowRfAsset,
  parseGeneratorOptions,
  publishSnowRfAsset,
  resolveOutputPaths,
  withSnowRfPublicationLock,
} = require("../scripts/generate-noaa-snow-rf-asset");

const ROOT_DIR = path.resolve(__dirname, "..");
const GENERATOR_PATH = path.join(ROOT_DIR, "scripts/generate-noaa-snow-rf-asset.js");
const NODE20_RUNTIME_ENV = "MODELVIEW_NODE20_PATH";
const PILOT_MANIFEST_SHA256 = "0da1ea251f6af4feffce351285726045375dfda7232c3616048c1209b6b01be4";
const closure = buildSnowRfCompilerClosure();
let generatedCache = null;
let compiledSourceCache = null;

function readCommittedAsset() {
  return {
    binary: fs.readFileSync(DEFAULT_BINARY_PATH),
    manifestBytes: fs.readFileSync(DEFAULT_MANIFEST_PATH),
    manifest: JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, "utf8")),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function generatedAsset() {
  generatedCache ||= generateSnowRfAsset();
  return generatedCache;
}

function compiledSourceModel() {
  if (!compiledSourceCache) {
    const raw = JSON.parse(fs.readFileSync(DEFAULT_SOURCE_PATH, "utf8"));
    compiledSourceCache = compileSnowRfModel(raw);
    assert.ok(compiledSourceCache);
  }
  return compiledSourceCache;
}

function validateManifest(manifest) {
  return validateSnowRfAssetManifest({ manifest, compilerClosure: closure });
}

function materialize(manifest, binaryBytes) {
  return materializeSnowRfAsset({
    manifest,
    binaryBytes,
    compilerClosure: closure,
  });
}

function makeTempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function probeNode20Runtime(runtime) {
  const result = spawnSync(runtime, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return {
    error: result.error || null,
    status: result.status,
    version: String(result.stdout || "").trim(),
  };
}

function resolveNode20Runtime() {
  if (Object.hasOwn(process.env, NODE20_RUNTIME_ENV)) {
    const configured = String(process.env[NODE20_RUNTIME_ENV] || "").trim();
    if (configured === "") {
      throw new Error(`${NODE20_RUNTIME_ENV} must name a Node 20 executable when it is present.`);
    }
    const runtime = path.resolve(configured);
    const probe = probeNode20Runtime(runtime);
    if (probe.error || probe.status !== 0 || !/^v20\./.test(probe.version)) {
      throw new Error(
        `${NODE20_RUNTIME_ENV}=${JSON.stringify(runtime)} is not a working Node 20 executable ` +
          `(status=${String(probe.status)}, version=${JSON.stringify(probe.version)}, ` +
          `error=${probe.error?.message || "none"}).`,
      );
    }
    return runtime;
  }

  const candidates = process.version.startsWith("v20.")
    ? [process.execPath, "node20", "node-20"]
    : ["node20", "node-20"];
  for (const runtime of candidates) {
    const probe = probeNode20Runtime(runtime);
    if (!probe.error && probe.status === 0 && /^v20\./.test(probe.version)) {
      return runtime;
    }
  }
  return null;
}

function fileSeal(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return {
    bytes: fs.readFileSync(filePath),
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
  };
}

function assertFileSeal(filePath, expected) {
  const actual = fileSeal(filePath);
  assert.deepEqual(actual, expected);
}

test("committed source, binary, manifest, and closure retain the frozen production contract", () => {
  const committed = readCommittedAsset();
  assert.deepEqual(
    {
      bytes: fs.statSync(DEFAULT_SOURCE_PATH).size,
      sha256: sha256(fs.readFileSync(DEFAULT_SOURCE_PATH)),
    },
    {
      bytes: SNOW_RF_SOURCE_IDENTITY.bytes,
      sha256: SNOW_RF_SOURCE_IDENTITY.sha256,
    },
  );
  assert.equal(committed.binary.byteLength, SNOW_RF_ASSET_ORACLES.binaryBytes);
  assert.equal(sha256(committed.binary), SNOW_RF_ASSET_ORACLES.binarySha256);
  const validated = validateManifest(committed.manifest);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.compiler.closure.files), true);
  assert.deepEqual(validated.source, SNOW_RF_SOURCE_IDENTITY);
  assert.deepEqual(validated.model, SNOW_RF_MODEL_ORACLES);
  assert.deepEqual(validated.compiler.closure, closure);
  assert.equal(validated.compiler.id, SNOW_RF_COMPILER_ID);
  assert.equal(validated.layout.regions.length, SNOW_RF_ASSET_ORACLES.regionCount);
  assert.equal(
    sha256(committed.manifestBytes) === PILOT_MANIFEST_SHA256,
    false,
    "production manifest intentionally replaces the pilot runner schema/filename with the sealed production closure",
  );
});

test("typed materialization has 500 exact views sharing one exact owner and matches strict JSON element-for-element", () => {
  const committed = readCommittedAsset();
  const typed = materialize(committed.manifest, committed.binary);
  const strict = compiledSourceModel();
  assert.deepEqual(inspectCompiledSnowRfModel(typed), SNOW_RF_MODEL_ORACLES);
  assert.equal(Object.isFrozen(typed), true);
  assert.equal(Object.isFrozen(typed.featureKeys), true);
  assert.equal(Object.isFrozen(typed.trees), true);
  assert.equal(Object.hasOwn(typed, "owner"), false);
  const owner = typed.trees[0].childrenLeft.buffer;
  assert.equal(owner.byteLength, SNOW_RF_ASSET_ORACLES.binaryBytes);
  const manifestRegions = committed.manifest.layout.regions;
  let viewCount = 0;
  let fieldElementComparisons = 0;
  for (let treeIndex = 0; treeIndex < typed.trees.length; treeIndex += 1) {
    const actualTree = typed.trees[treeIndex];
    const expectedTree = strict.trees[treeIndex];
    assert.equal(Object.isFrozen(actualTree), true);
    for (let fieldIndex = 0; fieldIndex < SNOW_RF_FIELD_SPECS.length; fieldIndex += 1) {
      const field = SNOW_RF_FIELD_SPECS[fieldIndex];
      const actual = actualTree[field.name];
      const expected = expectedTree[field.name];
      const region = manifestRegions[treeIndex * SNOW_RF_FIELD_SPECS.length + fieldIndex];
      assert.equal(actual.buffer, owner);
      assert.equal(actual.byteOffset, region.offset);
      assert.equal(actual.length, region.length);
      assert.equal(actual.byteLength, region.byteLength);
      assert.equal(
        Object.getPrototypeOf(actual),
        field.type === "Int32" ? Int32Array.prototype : Float64Array.prototype,
      );
      assert.equal(Object.isFrozen(actual), false);
      for (let index = 0; index < actual.length; index += 1) {
        assert.equal(Object.is(actual[index], expected[index]), true, `tree ${treeIndex} ${field.name}[${index}]`);
        fieldElementComparisons += 1;
      }
      viewCount += 1;
    }
  }
  assert.equal(viewCount, 500);
  assert.equal(fieldElementComparisons, 3_332_030);
  assert.deepEqual(typed.featureKeys, strict.featureKeys);
});

test("generator uses deterministic explicit-layout bytes and returns 500 region diagnostics", () => {
  const committed = readCommittedAsset();
  const generated = generatedAsset();
  assert.deepEqual(generated.binary, committed.binary);
  assert.deepEqual(generated.manifestBytes, committed.manifestBytes);
  assert.equal(generated.binarySha256, SNOW_RF_ASSET_ORACLES.binarySha256);
  assert.equal(generated.regionDiagnostics.length, 500);
  assert.equal(
    generated.regionDiagnostics.reduce((sum, entry) => sum + entry.byteLength, 0),
    SNOW_RF_ASSET_ORACLES.payloadBytes,
  );
  assert.equal(
    generated.regionDiagnostics.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)),
    true,
  );
  assert.doesNotMatch(
    generated.manifestBytes.toString("utf8"),
    /generatedAt|timestamp|nodeVersion|\/Users\/|\/private\/tmp/i,
  );
  let cursor = 0;
  let paddingBytes = 0;
  for (const region of generated.manifest.layout.regions) {
    for (let offset = cursor; offset < region.offset; offset += 1) {
      assert.equal(generated.binary[offset], 0, `padding byte ${offset}`);
      paddingBytes += 1;
    }
    cursor = region.offset + region.byteLength;
  }
  assert.equal(cursor, generated.binary.byteLength);
  assert.equal(paddingBytes, SNOW_RF_ASSET_ORACLES.paddingBytes);
});

test("strict manifest validation rejects schema, source, closure, count, and object-grammar drift", async (t) => {
  const committed = readCommittedAsset();
  const cases = [
    ["schema", (manifest) => (manifest.schemaVersion = 2)],
    ["format", (manifest) => (manifest.format = "other")],
    ["endian", (manifest) => (manifest.endian = "big")],
    ["source artifact", (manifest) => (manifest.source.artifactRequired = "other.json")],
    ["source bytes", (manifest) => (manifest.source.bytes += 1)],
    ["source hash", (manifest) => (manifest.source.sha256 = "0".repeat(64))],
    ["compiler id", (manifest) => (manifest.compiler.id = "other")],
    ["closure encoding", (manifest) => (manifest.compiler.closure.encoding = "other")],
    ["closure hash", (manifest) => (manifest.compiler.closure.sha256 = "0".repeat(64))],
    ["closure file name", (manifest) => (manifest.compiler.closure.files[0].name = "other.js")],
    ["closure file bytes", (manifest) => (manifest.compiler.closure.files[0].byteLength += 1)],
    ["closure file hash", (manifest) => (manifest.compiler.closure.files[0].sha256 = "0".repeat(64))],
    ["feature count", (manifest) => (manifest.model.featureCount += 1)],
    ["tree count", (manifest) => (manifest.model.treeCount += 1)],
    ["node count", (manifest) => (manifest.model.nodeCount += 1)],
    ["internal count", (manifest) => (manifest.model.internalNodeCount += 1)],
    ["leaf count", (manifest) => (manifest.model.leafCount += 1)],
    ["depth", (manifest) => (manifest.model.maxDepth += 1)],
    ["binary filename", (manifest) => (manifest.binary.file = "other.bin")],
    ["binary bytes", (manifest) => (manifest.binary.bytes += 1)],
    ["binary hash", (manifest) => (manifest.binary.sha256 = "0".repeat(64))],
    ["root extra", (manifest) => (manifest.extra = true)],
    ["source extra", (manifest) => (manifest.source.extra = true)],
    ["closure file extra", (manifest) => (manifest.compiler.closure.files[0].extra = true)],
    ["missing field", (manifest) => delete manifest.layout.paddingBytes],
    ["field-order extra", (manifest) => manifest.layout.fieldOrder.push({})],
    ["region extra", (manifest) => (manifest.layout.regions[0].extra = true)],
    ["region array extra", (manifest) => (manifest.layout.regions.extra = true)],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const manifest = cloneJson(committed.manifest);
      mutate(manifest);
      assert.throws(() => validateManifest(manifest));
    });
  }

  for (const [label, target, key] of [
    ["root accessor", cloneJson(committed.manifest), "format"],
    ["region accessor", cloneJson(committed.manifest).layout.regions[0], "offset"],
  ]) {
    await t.test(label, () => {
      let calls = 0;
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        get() {
          calls += 1;
          return 0;
        },
      });
      const manifest =
        label === "root accessor"
          ? target
          : (() => {
              const next = cloneJson(committed.manifest);
              next.layout.regions[0] = target;
              return next;
            })();
      assert.throws(() => validateManifest(manifest), /own data property/);
      assert.equal(calls, 0);
    });
  }

  await t.test("region-array element accessor", () => {
    const manifest = cloneJson(committed.manifest);
    let calls = 0;
    Object.defineProperty(manifest.layout.regions, "0", {
      configurable: true,
      enumerable: true,
      get() {
        calls += 1;
        return committed.manifest.layout.regions[0];
      },
    });
    assert.throws(() => validateManifest(manifest), /own data property/);
    assert.equal(calls, 0);
  });

  for (const [label, mutate] of [
    ["root symbol", (manifest) => (manifest[Symbol("extra")] = true)],
    ["region symbol", (manifest) => (manifest.layout.regions[0][Symbol("extra")] = true)],
    ["region-array symbol", (manifest) => (manifest.layout.regions[Symbol("extra")] = true)],
    ["region-array hole", (manifest) => delete manifest.layout.regions[10]],
  ]) {
    await t.test(label, () => {
      const manifest = cloneJson(committed.manifest);
      mutate(manifest);
      assert.throws(() => validateManifest(manifest));
    });
  }
});

test("strict layout validation rejects reorder, duplicate, missing, extra, overlap, gap, alignment, bounds, and type drift", async (t) => {
  const committed = readCommittedAsset();
  const cases = [
    ["reordered", (regions) => ([regions[0], regions[1]] = [regions[1], regions[0]])],
    ["duplicate", (regions) => (regions[1] = { ...regions[0] })],
    ["missing", (regions) => regions.pop()],
    ["extra", (regions) => regions.push({ ...regions.at(-1) })],
    ["overlap", (regions) => (regions[1].offset = regions[0].offset)],
    ["gap", (regions) => (regions[1].offset += 8)],
    ["unaligned", (regions) => (regions[1].offset += 1)],
    ["negative offset", (regions) => (regions[0].offset = -8)],
    ["out of bounds", (regions) => (regions.at(-1).offset = SNOW_RF_ASSET_ORACLES.binaryBytes)],
    ["wrong tree", (regions) => (regions[0].treeIndex = 1)],
    ["wrong field", (regions) => (regions[0].field = "threshold")],
    ["wrong type", (regions) => (regions[0].type = "Float64")],
    ["fractional offset", (regions) => (regions[0].offset = 0.5)],
    ["zero length", (regions) => (regions[0].length = 0)],
    ["fractional length", (regions) => (regions[0].length += 0.5)],
    ["wrong byte length", (regions) => (regions[0].byteLength += 4)],
    [
      "tree field length mismatch",
      (regions) => {
        regions[1].length -= 1;
        regions[1].byteLength -= 4;
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, () => {
      const manifest = cloneJson(committed.manifest);
      mutate(manifest.layout.regions);
      assert.throws(() => validateManifest(manifest), /region|layout|coverage|length/i);
    });
  }
});

test("materialization rejects shared or aliased inputs and validates the isolated copy before exposing views", () => {
  const committed = readCommittedAsset();
  const bitFlip = Buffer.from(committed.binary);
  bitFlip[100_000] ^= 0x80;
  assert.throws(() => materialize(committed.manifest, bitFlip), /whole-file SHA-256/);
  assert.throws(() => materialize(committed.manifest, committed.binary.subarray(0, -1)), /exact-length|whole-buffer/);
  assert.throws(
    () => materialize(committed.manifest, Buffer.concat([committed.binary, Buffer.from([0])])),
    /exact-length|whole-buffer|binary bytes/,
  );
  const coordinatedManifest = cloneJson(committed.manifest);
  coordinatedManifest.binary.sha256 = sha256(bitFlip);
  assert.throws(() => materialize(coordinatedManifest, bitFlip), /frozen binary oracle/);

  const firstPaddingOffset =
    committed.manifest.layout.regions[0].offset + committed.manifest.layout.regions[0].byteLength;
  const paddingCorruption = Buffer.from(committed.binary);
  paddingCorruption[firstPaddingOffset] = 1;
  assert.throws(() => materialize(committed.manifest, paddingCorruption), /whole-file SHA-256/);
  const graphCorruption = Buffer.from(committed.binary);
  graphCorruption.writeInt32LE(0, committed.manifest.layout.regions[0].offset);
  assert.throws(() => materialize(committed.manifest, graphCorruption), /whole-file SHA-256/);
  const thresholdRegion = committed.manifest.layout.regions[3];
  const numericCorruption = Buffer.from(committed.binary);
  numericCorruption.writeDoubleLE(Number.NaN, thresholdRegion.offset);
  assert.throws(() => materialize(committed.manifest, numericCorruption), /whole-file SHA-256/);

  const shared = new Uint8Array(new SharedArrayBuffer(committed.binary.byteLength));
  shared.set(committed.binary);
  assert.throws(
    () => materialize(committed.manifest, shared),
    /whole-buffer Uint8Array backed by a private ArrayBuffer/,
  );
  Object.defineProperty(shared.buffer, Symbol.toStringTag, {
    value: "ArrayBuffer",
    configurable: true,
  });
  assert.equal(Object.prototype.toString.call(shared.buffer), "[object ArrayBuffer]");
  assert.throws(
    () => materialize(committed.manifest, shared),
    /whole-buffer Uint8Array backed by a private ArrayBuffer/,
  );
  const aliasedOwner = new ArrayBuffer(committed.binary.byteLength + 1);
  const aliased = new Uint8Array(aliasedOwner, 1, committed.binary.byteLength);
  aliased.set(committed.binary);
  assert.throws(
    () => materialize(committed.manifest, aliased),
    /whole-buffer Uint8Array backed by a private ArrayBuffer/,
  );
  assert.equal(
    Object.hasOwn(require("../scripts/lib/noaa-beta/snow-rf-asset"), "materializeValidatedSnowRfAssetOwner"),
    false,
  );
});

test("staged materialization reports exact contiguous phase boundaries only after graph validation", () => {
  const committed = readCommittedAsset();
  const phaseStartNs = process.hrtime.bigint();
  let instrumentation = null;
  const model = materializeSnowRfAsset({
    manifest: committed.manifest,
    binaryBytes: committed.binary,
    compilerClosure: closure,
    phaseStartNs,
    onInstrumentation(snapshot) {
      assert.equal(instrumentation, null);
      instrumentation = snapshot;
    },
  });
  assert.ok(model);
  assert.ok(instrumentation);
  assert.equal(instrumentation.completed, true);
  assert.deepEqual(
    instrumentation.phases.map((phase) => phase.name),
    SNOW_RF_ASSET_MATERIALIZATION_PHASES,
  );
  assert.equal(instrumentation.phases[0].startNs, phaseStartNs.toString());
  for (let index = 0; index < instrumentation.phases.length; index += 1) {
    const phase = instrumentation.phases[index];
    assert.equal(BigInt(phase.durationNs), BigInt(phase.endNs) - BigInt(phase.startNs));
    if (index > 0) {
      assert.equal(phase.startNs, instrumentation.phases[index - 1].endNs);
    }
  }
  assert.deepEqual(
    instrumentation.memorySnapshots.map((snapshot) => snapshot.label),
    SNOW_RF_ASSET_MATERIALIZATION_PHASES.map((name) => `after:${name}`),
  );
  assert.deepEqual(instrumentation.modelMetrics, SNOW_RF_MODEL_ORACLES);

  const bitFlip = Buffer.from(committed.binary);
  bitFlip[0] ^= 1;
  let failedInstrumentation = null;
  assert.throws(
    () =>
      materializeSnowRfAsset({
        manifest: committed.manifest,
        binaryBytes: bitFlip,
        compilerClosure: closure,
        phaseStartNs: process.hrtime.bigint(),
        onInstrumentation(snapshot) {
          failedInstrumentation = snapshot;
        },
      }),
    /whole-file SHA-256/,
  );
  assert.equal(failedInstrumentation.completed, false);
  assert.deepEqual(
    failedInstrumentation.phases.map((phase) => phase.name),
    SNOW_RF_ASSET_MATERIALIZATION_PHASES.slice(0, 2),
  );
  assert.equal(failedInstrumentation.modelMetrics, null);

  assert.throws(
    () =>
      materializeSnowRfAsset({
        manifest: committed.manifest,
        binaryBytes: bitFlip,
        compilerClosure: closure,
        phaseStartNs: process.hrtime.bigint(),
        onInstrumentation() {
          throw new Error("instrumentation sink failed");
        },
      }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      /whole-file SHA-256/.test(error.errors[0].message) &&
      /instrumentation sink failed/.test(error.errors[1].message),
  );
});

test("compiler closure and source drift fail before publication", (t) => {
  const compilerCopyDir = makeTempDirectory(t, "snow-rf-closure-drift-");
  const compilerCopy = path.join(compilerCopyDir, "snow-rf-compiler.js");
  fs.copyFileSync(DEFAULT_COMPILER_PATH, compilerCopy);
  fs.appendFileSync(compilerCopy, "\n// deliberate test drift\n");
  const driftedClosure = buildSnowRfCompilerClosure({ compilerPath: compilerCopy });
  assert.throws(
    () =>
      validateSnowRfAssetManifest({
        manifest: readCommittedAsset().manifest,
        compilerClosure: driftedClosure,
      }),
    /compiler closure does not match/,
  );

  const sourceCopy = path.join(compilerCopyDir, "conus-rf.json");
  fs.copyFileSync(DEFAULT_SOURCE_PATH, sourceCopy);
  const generated = generateSnowRfAsset({ sourcePath: sourceCopy });
  fs.appendFileSync(sourceCopy, " ");
  assert.throws(() => assertGenerationInputsStable(generated), /frozen oracle|changed before publication/);
});

test("generator --check is nonmutating for current, stale, and missing pairs and rejects invalid flags", (t) => {
  const committedBefore = {
    roster: fs.readdirSync(path.dirname(DEFAULT_BINARY_PATH)).sort(),
    binary: fileSeal(DEFAULT_BINARY_PATH),
    manifest: fileSeal(DEFAULT_MANIFEST_PATH),
  };
  const current = spawnSync(process.execPath, [GENERATOR_PATH, "--check"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  });
  assert.equal(current.status, 0, current.stderr);
  assert.deepEqual(fs.readdirSync(path.dirname(DEFAULT_BINARY_PATH)).sort(), committedBefore.roster);
  assertFileSeal(DEFAULT_BINARY_PATH, committedBefore.binary);
  assertFileSeal(DEFAULT_MANIFEST_PATH, committedBefore.manifest);

  const missingDir = makeTempDirectory(t, "snow-rf-check-missing-");
  const missing = spawnSync(process.execPath, [GENERATOR_PATH, "--check", `--output-dir=${missingDir}`], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.deepEqual(fs.readdirSync(missingDir), []);

  const staleDir = makeTempDirectory(t, "snow-rf-check-stale-");
  const stalePaths = resolveOutputPaths(staleDir);
  fs.copyFileSync(DEFAULT_BINARY_PATH, stalePaths.binaryPath);
  fs.copyFileSync(DEFAULT_MANIFEST_PATH, stalePaths.manifestPath);
  const staleBinary = fs.readFileSync(stalePaths.binaryPath);
  staleBinary[0] ^= 1;
  fs.writeFileSync(stalePaths.binaryPath, staleBinary);
  const staleBefore = {
    roster: fs.readdirSync(staleDir).sort(),
    binary: fileSeal(stalePaths.binaryPath),
    manifest: fileSeal(stalePaths.manifestPath),
  };
  const stale = spawnSync(process.execPath, [GENERATOR_PATH, "--check", "--output-dir", staleDir], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  });
  assert.notEqual(stale.status, 0);
  assert.deepEqual(fs.readdirSync(staleDir).sort(), staleBefore.roster);
  assertFileSeal(stalePaths.binaryPath, staleBefore.binary);
  assertFileSeal(stalePaths.manifestPath, staleBefore.manifest);

  for (const argv of [
    [],
    ["--write", "--check"],
    ["--write", "--write"],
    ["--write", "--output-dir", staleDir, "--output-dir", staleDir],
    ["--write", "--output-dir", "   "],
    ["--write", "--output-dir", "--check"],
    ["--write", "--output-dir="],
    ["--write", "--unknown"],
  ]) {
    assert.throws(() => parseGeneratorOptions(argv), `argv=${JSON.stringify(argv)}`);
  }
});

test("Node 20 and current Node publish byte-identical isolated pairs with no lock/temp residue", (t) => {
  const node20Runtime = resolveNode20Runtime();
  if (node20Runtime === null) {
    t.skip(`Node 20 runtime unavailable; set ${NODE20_RUNTIME_ENV} to its executable path.`);
    return;
  }
  const currentDir = makeTempDirectory(t, "snow-rf-current-generation-");
  const node20Dir = makeTempDirectory(t, "snow-rf-node20-generation-");
  for (const [runtime, outputDir] of [
    [process.execPath, currentDir],
    [node20Runtime, node20Dir],
  ]) {
    const result = spawnSync(runtime, [GENERATOR_PATH, "--write", `--output-dir=${outputDir}`], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fs.readdirSync(outputDir).sort(),
      [path.basename(DEFAULT_BINARY_PATH), path.basename(DEFAULT_MANIFEST_PATH)].sort(),
    );
  }
  const currentPaths = resolveOutputPaths(currentDir);
  const node20Paths = resolveOutputPaths(node20Dir);
  assert.deepEqual(fs.readFileSync(currentPaths.binaryPath), fs.readFileSync(node20Paths.binaryPath));
  assert.deepEqual(fs.readFileSync(currentPaths.manifestPath), fs.readFileSync(node20Paths.manifestPath));
  assert.deepEqual(fs.readFileSync(currentPaths.binaryPath), fs.readFileSync(DEFAULT_BINARY_PATH));
  assert.deepEqual(fs.readFileSync(currentPaths.manifestPath), fs.readFileSync(DEFAULT_MANIFEST_PATH));
});

test("an explicitly configured invalid Node 20 runtime fails instead of silently skipping", (t) => {
  const directory = makeTempDirectory(t, "snow-rf-missing-node20-");
  const missingRuntime = path.join(directory, "missing-node");
  const wasPresent = Object.hasOwn(process.env, NODE20_RUNTIME_ENV);
  const previous = process.env[NODE20_RUNTIME_ENV];
  process.env[NODE20_RUNTIME_ENV] = missingRuntime;
  try {
    assert.throws(() => resolveNode20Runtime(), new RegExp(`${NODE20_RUNTIME_ENV}.*not a working Node 20`));
  } finally {
    if (wasPresent) {
      process.env[NODE20_RUNTIME_ENV] = previous;
    } else {
      delete process.env[NODE20_RUNTIME_ENV];
    }
  }
});

test("exclusive publication lock rejects a concurrent publisher without deleting the winner's lock", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "snow-rf-lock-"));
  try {
    const paths = resolveOutputPaths(directory);
    withSnowRfPublicationLock(paths, () => {
      assert.equal(fs.existsSync(paths.lockPath), true);
      assert.throws(() => withSnowRfPublicationLock(paths, () => {}), /generation lock already exists/);
      assert.equal(fs.existsSync(paths.lockPath), true);
    });
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(fs.readdirSync(directory).includes(PUBLICATION_LOCK_BASENAME), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("binary-first manifest-last publication validates its reread pair and interrupted pairs fail closed", (t) => {
  const directory = makeTempDirectory(t, "snow-rf-publication-");
  const paths = resolveOutputPaths(directory);
  publishSnowRfAsset(paths, generatedAsset());
  assert.deepEqual(fs.readFileSync(paths.binaryPath), fs.readFileSync(DEFAULT_BINARY_PATH));
  assert.deepEqual(fs.readFileSync(paths.manifestPath), fs.readFileSync(DEFAULT_MANIFEST_PATH));
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    [path.basename(DEFAULT_BINARY_PATH), path.basename(DEFAULT_MANIFEST_PATH)].sort(),
  );

  const oldManifest = cloneJson(readCommittedAsset().manifest);
  oldManifest.binary.sha256 = "0".repeat(64);
  assert.throws(() => materialize(oldManifest, fs.readFileSync(paths.binaryPath)), /frozen binary oracle/);
  const oldBinary = Buffer.alloc(SNOW_RF_ASSET_ORACLES.binaryBytes);
  assert.throws(
    () => materialize(JSON.parse(fs.readFileSync(paths.manifestPath, "utf8")), oldBinary),
    /whole-file SHA-256/,
  );
});

test("publication fsyncs the directory after lock, binary, manifest, and lock-unlink transitions", (t) => {
  const directory = makeTempDirectory(t, "snow-rf-publication-fsync-order-");
  const paths = resolveOutputPaths(directory);
  const descriptors = new Map();
  const events = [];
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalFsyncSync = fs.fsyncSync;
  const originalRenameSync = fs.renameSync;
  const originalUnlinkSync = fs.unlinkSync;
  const labelPath = (filePath) => {
    const resolved = path.resolve(String(filePath));
    const basename = path.basename(resolved);
    if (resolved === path.resolve(directory)) return "directory";
    if (basename === PUBLICATION_LOCK_BASENAME) return "lock";
    if (basename.startsWith(`${path.basename(paths.binaryPath)}.tmp-`)) return "binary-temp";
    if (basename.startsWith(`${path.basename(paths.manifestPath)}.tmp-`)) return "manifest-temp";
    if (resolved === paths.binaryPath) return "binary";
    if (resolved === paths.manifestPath) return "manifest";
    return null;
  };
  fs.openSync = function openSyncTracked(filePath, flags, ...args) {
    const descriptor = originalOpenSync.call(fs, filePath, flags, ...args);
    descriptors.set(descriptor, labelPath(filePath));
    return descriptor;
  };
  fs.closeSync = function closeSyncTracked(descriptor) {
    try {
      return originalCloseSync.call(fs, descriptor);
    } finally {
      descriptors.delete(descriptor);
    }
  };
  fs.fsyncSync = function fsyncSyncTracked(descriptor) {
    const label = descriptors.get(descriptor);
    if (label) events.push(`fsync:${label}`);
    return originalFsyncSync.call(fs, descriptor);
  };
  fs.renameSync = function renameSyncTracked(source, destination) {
    const result = originalRenameSync.call(fs, source, destination);
    const label = labelPath(destination);
    if (label) events.push(`rename:${label}`);
    return result;
  };
  fs.unlinkSync = function unlinkSyncTracked(filePath) {
    const label = labelPath(filePath);
    const result = originalUnlinkSync.call(fs, filePath);
    if (label) events.push(`unlink:${label}`);
    return result;
  };
  try {
    publishSnowRfAsset(paths, generatedAsset());
  } finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    fs.fsyncSync = originalFsyncSync;
    fs.renameSync = originalRenameSync;
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.deepEqual(events, [
    "fsync:lock",
    "fsync:directory",
    "fsync:binary-temp",
    "fsync:manifest-temp",
    "rename:binary",
    "fsync:directory",
    "rename:manifest",
    "fsync:directory",
    "unlink:lock",
    "fsync:directory",
  ]);
});

test("publication rejects a substituted directory descriptor and cleans pending temp and lock entries", (t) => {
  const directory = makeTempDirectory(t, "snow-rf-publication-directory-race-");
  const impostorDirectory = makeTempDirectory(t, "snow-rf-publication-directory-impostor-");
  const paths = resolveOutputPaths(directory);
  const originalOpenSync = fs.openSync;
  let directoryOpens = 0;
  let substituted = false;
  fs.openSync = function openSyncWithDirectorySubstitution(filePath, flags, ...args) {
    if (path.resolve(String(filePath)) === path.resolve(directory) && flags === fs.constants.O_RDONLY) {
      directoryOpens += 1;
      if (directoryOpens === 2) {
        substituted = true;
        return originalOpenSync.call(fs, impostorDirectory, flags, ...args);
      }
    }
    return originalOpenSync.call(fs, filePath, flags, ...args);
  };
  try {
    assert.throws(() => publishSnowRfAsset(paths, generatedAsset()), /output directory descriptor identity changed/);
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(substituted, true);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(paths.binaryPath)]);
});

test("publication rejects a final-path swap between path validation and descriptor capture", (t) => {
  const directory = makeTempDirectory(t, "snow-rf-publication-path-swap-");
  const paths = resolveOutputPaths(directory);
  const attackerPath = path.join(directory, "attacker.bin");
  fs.writeFileSync(attackerPath, Buffer.from("replacement"));
  const originalOpenSync = fs.openSync;
  let swapped = false;
  fs.openSync = function openSyncWithFinalPathSwap(filePath, flags, ...args) {
    if (!swapped && path.resolve(String(filePath)) === paths.binaryPath && flags === "r") {
      swapped = true;
      fs.renameSync(attackerPath, paths.binaryPath);
    }
    return originalOpenSync.call(fs, filePath, flags, ...args);
  };
  try {
    assert.throws(() => publishSnowRfAsset(paths, generatedAsset()), /published descriptor identity changed/);
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(swapped, true);
  assert.equal(fs.existsSync(paths.binaryPath), true);
  assert.equal(fs.existsSync(paths.manifestPath), true);
  assert.equal(
    fs.readdirSync(directory).some((name) => name.includes(".tmp-")),
    false,
  );
  assert.equal(fs.existsSync(paths.lockPath), false);
});

test("publication rejects a multiply linked final path before descriptor-captured reread", (t) => {
  const directory = makeTempDirectory(t, "snow-rf-publication-hardlink-race-");
  const paths = resolveOutputPaths(directory);
  const hardlinkPath = path.join(directory, "binary-hardlink.bin");
  const originalRenameSync = fs.renameSync;
  let linked = false;
  fs.renameSync = function renameSyncWithHardlink(source, destination) {
    const result = originalRenameSync.call(fs, source, destination);
    if (!linked && path.resolve(String(destination)) === paths.manifestPath) {
      fs.linkSync(paths.binaryPath, hardlinkPath);
      linked = true;
    }
    return result;
  };
  try {
    assert.throws(() => publishSnowRfAsset(paths, generatedAsset()), /replaced or multiply linked owned file/);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(linked, true);
  assert.equal(fs.existsSync(hardlinkPath), true);
  assert.equal(
    fs.readdirSync(directory).some((name) => name.includes(".tmp-")),
    false,
  );
  assert.equal(fs.existsSync(paths.lockPath), false);
});

test("directory fsync failure after binary rename leaves a fail-closed pair and cleans temp and lock entries", (t) => {
  const directory = makeTempDirectory(t, "snow-rf-publication-fsync-failure-");
  const paths = resolveOutputPaths(directory);
  const descriptors = new Map();
  const originalOpenSync = fs.openSync;
  const originalCloseSync = fs.closeSync;
  const originalFsyncSync = fs.fsyncSync;
  let directoryFsyncs = 0;
  fs.openSync = function openSyncTracked(filePath, flags, ...args) {
    const descriptor = originalOpenSync.call(fs, filePath, flags, ...args);
    descriptors.set(descriptor, path.resolve(String(filePath)));
    return descriptor;
  };
  fs.closeSync = function closeSyncTracked(descriptor) {
    try {
      return originalCloseSync.call(fs, descriptor);
    } finally {
      descriptors.delete(descriptor);
    }
  };
  fs.fsyncSync = function fsyncSyncWithInjectedFailure(descriptor) {
    if (descriptors.get(descriptor) === path.resolve(directory)) {
      directoryFsyncs += 1;
      if (directoryFsyncs === 2) {
        throw new Error("injected publication directory fsync failure");
      }
    }
    return originalFsyncSync.call(fs, descriptor);
  };
  try {
    assert.throws(() => publishSnowRfAsset(paths, generatedAsset()), /injected publication directory fsync failure/);
  } finally {
    fs.openSync = originalOpenSync;
    fs.closeSync = originalCloseSync;
    fs.fsyncSync = originalFsyncSync;
  }
  assert.equal(directoryFsyncs, 4);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(paths.binaryPath)]);
  assert.deepEqual(fs.readFileSync(paths.binaryPath), fs.readFileSync(DEFAULT_BINARY_PATH));
});

test("publication safely removes its partial temp and lock after a staged write failure", (t) => {
  const directory = makeTempDirectory(t, "snow-rf-publication-failure-");
  const paths = resolveOutputPaths(directory);
  const originalWriteFileSync = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = function writeFileSyncWithInjectedFailure(descriptor, bytes, ...args) {
    writes += 1;
    if (writes === 2) {
      originalWriteFileSync.call(fs, descriptor, bytes.subarray(0, 32), ...args);
      throw new Error("injected staged binary write failure");
    }
    return originalWriteFileSync.call(fs, descriptor, bytes, ...args);
  };
  try {
    assert.throws(() => publishSnowRfAsset(paths, generatedAsset()), /injected staged binary write failure/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(writes, 2);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("loaded-state snapshot and receipt are immutable, JSON-safe, model-free, and preserve raw nanoseconds", () => {
  const model = materialize(readCommittedAsset().manifest, readCommittedAsset().binary);
  const configuration = {
    requestedMode: "required",
    resolvedMode: "required",
    sourceKind: "bundled",
    customPathPresent: false,
  };
  Object.defineProperty(configuration, "__proto__", {
    value: { retainedAsData: true },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const state = createSnowRfLoadedState({
    configuration,
    model,
    identity: {
      sourceSha256: SNOW_RF_SOURCE_IDENTITY.sha256,
      sourceBytes: SNOW_RF_SOURCE_IDENTITY.bytes,
      compilerId: SNOW_RF_COMPILER_ID,
      compilerClosureSha256: closure.sha256,
      binarySha256: SNOW_RF_ASSET_ORACLES.binarySha256,
      binaryBytes: SNOW_RF_ASSET_ORACLES.binaryBytes,
    },
    status: {
      effectiveMode: "typed-asset",
      fallbackUsed: false,
      fallbackReasonCode: null,
    },
    timing: {
      loaderTotalNs: "123",
      loader: { startNs: "10", endNs: "133" },
      phases: [{ name: "binaryHashValidate", startNs: "10", endNs: "133", durationNs: "123" }],
    },
  });
  assert.equal(Object.isFrozen(state), true);
  assert.equal(state.model, model);
  assert.equal(Object.getPrototypeOf(state.configuration), Object.prototype);
  assert.equal(Object.hasOwn(state.configuration, "__proto__"), true);
  assert.deepEqual(state.configuration.__proto__, { retainedAsData: true });
  assert.equal({}.retainedAsData, undefined);
  const snapshot = buildSnowRfAssetStateSnapshot(state);
  assert.equal(Object.hasOwn(snapshot, "model"), false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.configuration), true);
  assert.equal(Object.hasOwn(snapshot.configuration, "__proto__"), true);
  assert.deepEqual(snapshot.configuration.__proto__, { retainedAsData: true });
  assert.equal(snapshot.timing.loaderTotalNs, "123");
  assert.deepEqual(snapshot.modelMetrics, SNOW_RF_MODEL_ORACLES);
  const receipt = buildSnowRfBenchmarkReceipt(state, {
    role: "builder-main",
    spawnOrdinal: 1,
    processId: 123,
    threadId: 0,
  });
  assert.deepEqual(
    {
      schemaVersion: receipt.schemaVersion,
      type: receipt.type,
      role: receipt.role,
      spawnOrdinal: receipt.spawnOrdinal,
      processId: receipt.processId,
      threadId: receipt.threadId,
    },
    {
      schemaVersion: SNOW_RF_RECEIPT_SCHEMA_VERSION,
      type: SNOW_RF_RECEIPT_TYPE,
      role: "builder-main",
      spawnOrdinal: 1,
      processId: 123,
      threadId: 0,
    },
  );
  assert.equal(Object.hasOwn(receipt.state.configuration, "__proto__"), true);
  assert.deepEqual(receipt.state.configuration.__proto__, { retainedAsData: true });
  assert.equal(Object.getPrototypeOf(receipt.state.configuration), Object.prototype);
  assert.doesNotMatch(JSON.stringify(receipt), /childrenLeft|threshold|ArrayBuffer/);
  assert.throws(
    () =>
      createSnowRfLoadedState({
        configuration: {},
        model,
        identity: {},
        status: {},
        timing: { loaderTotalNs: 123 },
      }),
    /raw nanoseconds/,
  );
  assert.throws(
    () => buildSnowRfBenchmarkReceipt(state, { role: "other", spawnOrdinal: 0 }),
    /Invalid Snow-RF benchmark receipt role/,
  );
});

test("little-endian production requirement is explicit and independently testable", () => {
  assert.equal(hostIsLittleEndian(), true);
  assert.doesNotThrow(() => requireLittleEndianHost(true));
  assert.throws(() => requireLittleEndianHost(false), /little-endian host/);
});

test("real concurrent process observes the exclusive lock", async (t) => {
  const directory = makeTempDirectory(t, "snow-rf-process-lock-");
  const childSource = `
    "use strict";
    const { resolveOutputPaths, withSnowRfPublicationLock } = require(${JSON.stringify(GENERATOR_PATH)});
    const paths = resolveOutputPaths(${JSON.stringify(directory)});
    withSnowRfPublicationLock(paths, () => {
      process.stdout.write("locked\\n");
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 3000);
    });
  `;
  const child = spawn(process.execPath, ["-e", childSource], {
    cwd: ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const childExit = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve, reject) => {
    let stdout = "";
    let ready = false;
    const timer = setTimeout(() => reject(new Error("lock holder did not become ready")), 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("locked\n")) {
        ready = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`lock holder exited ${code} before becoming ready`));
      }
    });
  });
  const contender = spawnSync(process.execPath, [GENERATOR_PATH, "--write", `--output-dir=${directory}`], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.notEqual(contender.status, 0);
  assert.match(contender.stderr, /generation lock already exists/);
  const exitCode = await childExit;
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString("utf8"));
  assert.equal(fs.existsSync(path.join(directory, PUBLICATION_LOCK_BASENAME)), false);
});
