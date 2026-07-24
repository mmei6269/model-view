"use strict";

process.env.MODELVIEW_NOAA_COLOR_LOOKUPS = "dynamic";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const { Worker } = require("node:worker_threads");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../scripts/lib/noaa-nam-parameter-catalog");
const {
  CATALOG_RENDER_OPTIONS,
  CORE_LAYER_RENDER_OPTIONS,
  REFLECTIVITY_STOPS,
  STATIC_CONTINUOUS_COLOR_LOOKUP_STATE,
  buildCatalogRenderOptions,
  createContinuousColorLookup,
  normalizeColorStops,
} = require("../scripts/lib/noaa-beta/raster");
const {
  CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING,
  CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256,
  CATALOG_COLOR_LOOKUP_RECIPE_ENCODING,
  DEFAULT_BINARY_PATH,
  DEFAULT_COMPILER_DEPENDENCY_PATH,
  DEFAULT_COMPILER_PATH,
  DEFAULT_MANIFEST_PATH,
  _resetCatalogColorLookupWarningsForTest,
  buildCanonicalCatalogColorLookupInput,
  buildCatalogColorLookupAssignmentMappingIdentity,
  buildCatalogColorLookupBenchmarkReceipt,
  buildCatalogColorLookupCompilerClosure,
  buildCatalogColorLookupStateSnapshot,
  loadCatalogColorLookupRoster,
  sha256,
  validateAssetManifest,
} = require("../scripts/lib/noaa-beta/catalog-color-lookup-asset");
const {
  buildStaticContinuousColorLookupAssignments,
} = require("../scripts/lib/noaa-beta/catalog-color-lookup-recipes");
const {
  canonicalContinuousColorLookupRecipe,
  compileContinuousColorLookupRecipe,
  finiteNumberToIeee754Hex,
  materializeContinuousColorLookupRecipe,
  resolveContinuousColorLookupRecipe,
} = require("../scripts/lib/noaa-beta/color-lookup-compiler");
const {
  generateCatalogColorLookupAsset,
  parseGeneratorOptions,
  writeFileAtomically,
} = require("../scripts/generate-noaa-catalog-color-lookups");

const ROOT_DIR = path.resolve(__dirname, "..");
const EXPECTED_UNIQUE_BINARY_SHA256 = "81e90f3444f2b213be0173c1767c1c99874d614e06662f5e017006caae639263";
const EXPECTED_ALL_83_PAYLOAD_SHA256 = "24f2bc24aa1a5bb58a1857b50c492df518a5957b382ca0747355bd97d3e23a8d";
const EXPECTED_ALL_83_METADATA_SHA256 = "aebebaea217a3e1c0eac653cf57b12b820d390f6b42130c12139e23d73ec7678";
const EXPECTED_ALL_83_PAYLOAD_BYTES = 2_672_488;

function freshAssignments() {
  return buildStaticContinuousColorLookupAssignments();
}

function readCommittedAsset() {
  return {
    manifest: JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, "utf8")),
    binary: fs.readFileSync(DEFAULT_BINARY_PATH),
    compilerClosure: buildCatalogColorLookupCompilerClosure(),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function lookupMetadata(lookup) {
  return {
    kind: lookup.kind,
    size: lookup.size,
    min: lookup.min,
    max: lookup.max,
    scale: lookup.scale,
    log: lookup.log,
    logMin: lookup.logMin,
    logScale: lookup.logScale,
  };
}

function assertContinuousLookupExact(actual, expected, label) {
  assert.deepEqual(lookupMetadata(actual), lookupMetadata(expected), `${label}: numeric metadata`);
  assert.deepEqual(actual.colors, expected.colors, `${label}: RGBA bytes`);
}

function makeAssetDirectory(t, { manifest, binary } = readCommittedAsset()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-color-lookups-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, path.basename(DEFAULT_MANIFEST_PATH));
  const binaryPath = path.join(directory, path.basename(DEFAULT_BINARY_PATH));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(binaryPath, binary);
  return { directory, manifestPath, binaryPath };
}

function strictLoad(assignments, paths = {}) {
  return loadCatalogColorLookupRoster({
    assignments,
    mode: "precompiled",
    manifestPath: paths.manifestPath || DEFAULT_MANIFEST_PATH,
    binaryPath: paths.binaryPath || DEFAULT_BINARY_PATH,
    compilerPath: paths.compilerPath || DEFAULT_COMPILER_PATH,
    compilerDependencyPath: paths.compilerDependencyPath || DEFAULT_COMPILER_DEPENDENCY_PATH,
    warn: () => {},
  });
}

function allLookupRecords() {
  return [
    ...NOAA_NAM_PARAMETER_CATALOG.map((entry) => ({
      id: `catalog:${entry.key}`,
      scope: "catalog",
      lookup: CATALOG_RENDER_OPTIONS.get(entry.key).colorLookup,
    })),
    ...Object.entries(CORE_LAYER_RENDER_OPTIONS).map(([key, options]) => ({
      id: `core:${key}`,
      scope: "core",
      lookup: options.colorLookup,
    })),
  ];
}

function exactMetadata(lookup) {
  if (lookup.kind === "continuous") {
    return {
      kind: "continuous",
      size: lookup.size,
      min: finiteNumberToIeee754Hex(lookup.min),
      max: finiteNumberToIeee754Hex(lookup.max),
      scale: finiteNumberToIeee754Hex(lookup.scale),
      log: Boolean(lookup.log),
      logMin: finiteNumberToIeee754Hex(lookup.logMin),
      logScale: finiteNumberToIeee754Hex(lookup.logScale),
    };
  }
  return {
    kind: "step",
    thresholdCount: lookup.thresholds.length,
    uniformStart: lookup.uniformStart === null ? null : finiteNumberToIeee754Hex(lookup.uniformStart),
    uniformScale: finiteNumberToIeee754Hex(lookup.uniformScale),
  };
}

function buildAllLookupOracle() {
  const payloadHash = crypto.createHash("sha256");
  const metadataHash = crypto.createHash("sha256");
  let payloadBytes = 0;
  for (const record of allLookupRecords().sort((left, right) => (left.id < right.id ? -1 : 1))) {
    const parts =
      record.lookup.kind === "step"
        ? [
            ["thresholds-f64-native", Buffer.from(record.lookup.thresholds.buffer)],
            ["colors-rgba8", Buffer.from(record.lookup.colors.buffer)],
          ]
        : [["colors-rgba8", Buffer.from(record.lookup.colors.buffer)]];
    const metadata = Buffer.from(JSON.stringify(exactMetadata(record.lookup)));
    metadataHash.update(`${record.id}\0metadata-json\0${metadata.length}\0`);
    metadataHash.update(metadata);
    for (const [partName, body] of parts) {
      const frame = `${record.id}\0${record.lookup.kind}\0${partName}\0${body.length}\0`;
      payloadHash.update(frame);
      payloadHash.update(body);
      metadataHash.update(frame);
      metadataHash.update(body);
      payloadBytes += body.length;
    }
  }
  return {
    payloadBytes,
    payloadSha256: payloadHash.digest("hex"),
    metadataSha256: metadataHash.digest("hex"),
  };
}

test("static scope and all-83 exact oracles remain frozen", () => {
  const records = allLookupRecords();
  const catalogContinuous = records.filter(
    (record) => record.scope === "catalog" && record.lookup.kind === "continuous",
  );
  const coreContinuous = records.filter((record) => record.scope === "core" && record.lookup.kind === "continuous");
  const catalogStep = records.filter((record) => record.scope === "catalog" && record.lookup.kind === "step");
  const coreStep = records.filter((record) => record.scope === "core" && record.lookup.kind === "step");
  assert.equal(records.length, 83);
  assert.equal(catalogContinuous.length, 71);
  assert.equal(coreContinuous.length, 2);
  assert.equal(catalogStep.length, 8);
  assert.equal(coreStep.length, 2);
  assert.equal(
    [...catalogContinuous, ...coreContinuous].reduce((sum, record) => sum + record.lookup.colors.byteLength, 0),
    2_670_592,
  );
  assert.deepEqual(buildAllLookupOracle(), {
    payloadBytes: EXPECTED_ALL_83_PAYLOAD_BYTES,
    payloadSha256: EXPECTED_ALL_83_PAYLOAD_SHA256,
    metadataSha256: EXPECTED_ALL_83_METADATA_SHA256,
  });
});

test("strict precompiled roster is exact and gives every assignment independent storage", () => {
  const assignments = freshAssignments();
  const dynamic = loadCatalogColorLookupRoster({ assignments, mode: "dynamic", warn: () => {} });
  const precompiled = strictLoad(assignments);
  assert.equal(assignments.length, 73);
  assert.equal(precompiled.effectiveMode, "precompiled");
  assert.equal(precompiled.fallbackReason, null);
  assert.equal(precompiled.fallbackReasonCode, null);
  assert.equal(precompiled.identity.inputSha256, dynamic.identity.inputSha256);
  assert.equal(precompiled.identity.assignmentMappingSha256, CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256);
  assert.equal(dynamic.identity.assignmentMappingSha256, null);
  assert.equal(precompiled.identity.binarySha256, EXPECTED_UNIQUE_BINARY_SHA256);
  assert.equal(Object.isFrozen(precompiled.identity.compilerFiles), true);
  assert.equal(precompiled.identity.compilerFiles.every(Object.isFrozen), true);
  assert.throws(() => {
    precompiled.identity.compilerFiles[0].sha256 = "0".repeat(64);
  }, TypeError);
  assert.equal(precompiled.status.assignmentCount, 73);
  assert.equal(precompiled.status.paletteCount, 35);
  assert.equal(precompiled.status.logicalColorBytes, 2_670_592);
  const buffers = [];
  for (const assignment of assignments) {
    const actual = precompiled.lookups.get(assignment.id);
    const expected = dynamic.lookups.get(assignment.id);
    assertContinuousLookupExact(actual, expected, assignment.id);
    assert.equal(actual.colors.byteOffset, 0, `${assignment.id}: exact-length view starts at zero`);
    assert.equal(actual.colors.byteLength, actual.colors.buffer.byteLength, `${assignment.id}: no oversized backing`);
    buffers.push(actual.colors.buffer);
  }
  assert.equal(new Set(buffers).size, 73, "no assignment shares an ArrayBuffer");

  const manifest = readCommittedAsset().manifest;
  const duplicatePalette = manifest.assignments.find(
    (entry, index) =>
      manifest.assignments.findIndex((candidate) => candidate.paletteSha256 === entry.paletteSha256) !== index,
  );
  const sibling = manifest.assignments.find(
    (entry) => entry.id !== duplicatePalette.id && entry.paletteSha256 === duplicatePalette.paletteSha256,
  );
  const left = precompiled.lookups.get(duplicatePalette.id).colors;
  const right = precompiled.lookups.get(sibling.id).colors;
  const saved = right[0];
  left[0] ^= 0xff;
  assert.equal(right[0], saved, "duplicate palettes are cloned per assignment");
});

test("benchmark receipt snapshot is JSON-safe and excludes live lookup ownership", () => {
  const state = loadCatalogColorLookupRoster({
    assignments: freshAssignments(),
    mode: "precompiled",
    warn: () => {},
  });
  const snapshot = buildCatalogColorLookupStateSnapshot(state);
  const receipt = buildCatalogColorLookupBenchmarkReceipt(state, {
    role: "builder-main",
    spawnOrdinal: 0,
    processId: 123,
    threadId: 0,
  });
  assert.equal(snapshot.effectiveMode, "precompiled");
  assert.equal(snapshot.identity.binarySha256, EXPECTED_UNIQUE_BINARY_SHA256);
  assert.equal(snapshot.identity.assignmentMappingSha256, CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256);
  assert.equal(snapshot.status.assignmentCount, 73);
  assert.equal(Object.hasOwn(snapshot, "lookups"), false);
  assert.equal(Object.hasOwn(snapshot, "assetOwnerWeakRef"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
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
      schemaVersion: 1,
      type: "noaa-color-lookup-state",
      role: "builder-main",
      spawnOrdinal: 0,
      processId: 123,
      threadId: 0,
    },
  );
  assert.throws(
    () => buildCatalogColorLookupBenchmarkReceipt(state, { role: "frame-worker", spawnOrdinal: -1 }),
    /spawnOrdinal/,
  );
  assert.throws(
    () =>
      buildCatalogColorLookupStateSnapshot({
        ...state,
        status: { ...state.status, totalMs: Number.NaN },
      }),
    /totalMs/,
  );
  for (const assignmentMappingSha256 of [undefined, null, "f".repeat(64)]) {
    const identity = { ...state.identity };
    if (assignmentMappingSha256 === undefined) {
      delete identity.assignmentMappingSha256;
    } else {
      identity.assignmentMappingSha256 = assignmentMappingSha256;
    }
    assert.throws(() => buildCatalogColorLookupStateSnapshot({ ...state, identity }), /assignment mapping identity/);
  }
  const dynamic = loadCatalogColorLookupRoster({
    assignments: freshAssignments(),
    mode: "dynamic",
    warn: () => {},
  });
  assert.equal(buildCatalogColorLookupStateSnapshot(dynamic).identity.assignmentMappingSha256, null);
  assert.throws(
    () =>
      buildCatalogColorLookupStateSnapshot({
        ...dynamic,
        identity: {
          ...dynamic.identity,
          assignmentMappingSha256: CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256,
        },
      }),
    /assignment mapping identity/,
  );
});

test("repeated strict materialization has no cross-roster or asset backing alias", () => {
  const assignments = freshAssignments();
  const left = strictLoad(assignments);
  const right = strictLoad(assignments);
  for (const assignment of assignments) {
    const leftColors = left.lookups.get(assignment.id).colors;
    const rightColors = right.lookups.get(assignment.id).colors;
    assert.notEqual(leftColors.buffer, rightColors.buffer, assignment.id);
    assert.deepEqual(leftColors, rightColors, assignment.id);
  }
});

test("manifest binds compiler closure and canonical IEEE-754 recipe input", () => {
  const assignments = freshAssignments();
  const { manifest, compilerClosure } = readCommittedAsset();
  const input = buildCanonicalCatalogColorLookupInput(assignments);
  assert.deepEqual(manifest.compiler.closure, compilerClosure);
  assert.deepEqual(
    manifest.compiler.closure.files.map((file) => file.name),
    ["color-lookup-compiler.js", "util.js"],
  );
  assert.equal(manifest.input.sha256, input.sha256);
  assert.equal(manifest.input.assignmentCount, 73);
  assert.equal(manifest.input.recipeEncoding, CATALOG_COLOR_LOOKUP_RECIPE_ENCODING);
  assert.deepEqual(manifest.assignmentMapping, buildCatalogColorLookupAssignmentMappingIdentity(manifest.assignments));
  assert.equal(manifest.assignmentMapping.encoding, CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING);
  assert.equal(manifest.assignmentMapping.sha256, CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256);
  assert.equal(canonicalContinuousColorLookupRecipe(assignments[0].recipe).min.length, 16);
  assert.equal(finiteNumberToIeee754Hex(1), "3ff0000000000000");
});

test("dynamic and unknown modes perform no asset reads; unknown mode warns once", () => {
  const assignments = freshAssignments();
  const impossible = path.join(os.tmpdir(), `missing-color-asset-${process.pid}-${Date.now()}`);
  const dynamic = loadCatalogColorLookupRoster({
    assignments,
    mode: "dynamic",
    manifestPath: impossible,
    binaryPath: impossible,
    compilerPath: impossible,
    warn: () => assert.fail("dynamic mode must not warn"),
  });
  assert.equal(dynamic.effectiveMode, "dynamic");
  assert.equal(dynamic.fallbackReasonCode, null);

  _resetCatalogColorLookupWarningsForTest();
  const warnings = [];
  for (let index = 0; index < 2; index += 1) {
    const state = loadCatalogColorLookupRoster({
      assignments,
      mode: "unexpected",
      manifestPath: impossible,
      binaryPath: impossible,
      compilerPath: impossible,
      warn: (message) => warnings.push(message),
    });
    assert.equal(state.effectiveMode, "dynamic");
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /complete lookup roster dynamically/);
});

test("auto falls back once to a complete dynamic roster with a stable reason code", () => {
  const assignments = freshAssignments();
  _resetCatalogColorLookupWarningsForTest();
  const warnings = [];
  const missing = path.join(os.tmpdir(), `absent-color-asset-${process.pid}-${Date.now()}`);
  const states = [0, 1].map(() =>
    loadCatalogColorLookupRoster({
      assignments,
      mode: "auto",
      manifestPath: missing,
      binaryPath: missing,
      warn: (message) => warnings.push(message),
    }),
  );
  assert.equal(warnings.length, 1);
  for (const state of states) {
    assert.equal(state.effectiveMode, "dynamic");
    assert.equal(state.fallbackReasonCode, "asset-read-failed");
    assert.equal(state.lookups.size, 73);
    assert.ok(state.status.fallbackAttemptMs >= 0);
  }
});

test("auto binary-corruption fallback is complete, exact, and warned once", (t) => {
  const committed = readCommittedAsset();
  const corrupted = Buffer.from(committed.binary);
  corrupted[Math.floor(corrupted.length / 2)] ^= 0x80;
  const paths = makeAssetDirectory(t, { manifest: committed.manifest, binary: corrupted });
  const assignments = freshAssignments();
  assert.throws(() => strictLoad(assignments, paths), /binary length, alignment, filename, or whole-file digest/);

  _resetCatalogColorLookupWarningsForTest();
  const warnings = [];
  const auto = loadCatalogColorLookupRoster({
    assignments,
    mode: "auto",
    ...paths,
    warn: (message) => warnings.push(message),
  });
  const dynamic = loadCatalogColorLookupRoster({ assignments, mode: "dynamic", warn: () => {} });
  assert.equal(auto.effectiveMode, "dynamic");
  assert.equal(auto.fallbackReasonCode, "asset-validation-failed");
  assert.equal(auto.lookups.size, 73);
  assert.equal(warnings.length, 1);
  for (const assignment of assignments) {
    assertContinuousLookupExact(auto.lookups.get(assignment.id), dynamic.lookups.get(assignment.id), assignment.id);
  }
});

test("strict mode fails before publication for missing and malformed files", async (t) => {
  const assignments = freshAssignments();
  assert.throws(
    () =>
      strictLoad(assignments, {
        manifestPath: path.join(os.tmpdir(), `missing-manifest-${process.pid}`),
        binaryPath: DEFAULT_BINARY_PATH,
      }),
    (error) => error.code === "ERR_NOAA_COLOR_LOOKUP_PRECOMPILED" && error.reasonCode === "asset-read-failed",
  );

  const malformed = makeAssetDirectory(t);
  fs.writeFileSync(malformed.manifestPath, "{not-json");
  assert.throws(
    () => strictLoad(assignments, malformed),
    (error) => error.code === "ERR_NOAA_COLOR_LOOKUP_PRECOMPILED" && error.reasonCode === "manifest-json-invalid",
  );
});

test("validator rejects schema, identity, layout, coverage, and corruption matrix", async (t) => {
  const assignments = freshAssignments();
  const committed = readCommittedAsset();
  const input = buildCanonicalCatalogColorLookupInput(assignments);
  const validate = (manifest, binary = committed.binary, suppliedAssignments = assignments) =>
    validateAssetManifest({
      manifest,
      input: buildCanonicalCatalogColorLookupInput(suppliedAssignments),
      assignments: suppliedAssignments,
      compilerClosure: committed.compilerClosure,
      binary,
      binaryPath: DEFAULT_BINARY_PATH,
    });
  const cases = [];
  const add = (name, mutate) => cases.push([name, mutate]);
  add("non-object root", () => [[], committed.binary]);
  add("wrong schema", (manifest) => ((manifest.schemaVersion += 1), [manifest, committed.binary]));
  add("wrong compiler id", (manifest) => ((manifest.compiler.id = "wrong"), [manifest, committed.binary]));
  add(
    "wrong compiler closure hash",
    (manifest) => ((manifest.compiler.closure.sha256 = "0".repeat(64)), [manifest, committed.binary]),
  );
  add(
    "wrong compiler dependency hash",
    (manifest) => ((manifest.compiler.closure.files[1].sha256 = "0".repeat(64)), [manifest, committed.binary]),
  );
  add("wrong input hash", (manifest) => ((manifest.input.sha256 = "0".repeat(64)), [manifest, committed.binary]));
  add(
    "wrong input encoding",
    (manifest) => ((manifest.input.recipeEncoding = "decimal"), [manifest, committed.binary]),
  );
  add("wrong assignment count", (manifest) => ((manifest.input.assignmentCount -= 1), [manifest, committed.binary]));
  add(
    "wrong assignment mapping digest",
    (manifest) => ((manifest.assignmentMapping.sha256 = "0".repeat(64)), [manifest, committed.binary]),
  );
  add(
    "wrong assignment mapping encoding",
    (manifest) => ((manifest.assignmentMapping.encoding = "unordered"), [manifest, committed.binary]),
  );
  add(
    "wrong assignment mapping count",
    (manifest) => ((manifest.assignmentMapping.assignmentCount -= 1), [manifest, committed.binary]),
  );
  add("wrong binary filename", (manifest) => ((manifest.binary.file = "other.bin"), [manifest, committed.binary]));
  add("wrong binary alignment", (manifest) => ((manifest.binary.alignment = 8), [manifest, committed.binary]));
  add(
    "wrong whole binary hash",
    (manifest) => ((manifest.binary.sha256 = "0".repeat(64)), [manifest, committed.binary]),
  );
  add("truncated binary", (manifest) => {
    const binary = committed.binary.subarray(0, -1);
    manifest.binary.byteLength = binary.length;
    manifest.binary.sha256 = sha256(binary);
    return [manifest, binary];
  });
  add("extended binary", (manifest) => {
    const binary = Buffer.concat([committed.binary, Buffer.alloc(4)]);
    manifest.binary.byteLength = binary.length;
    manifest.binary.sha256 = sha256(binary);
    return [manifest, binary];
  });
  add("corrupt palette slice", (manifest) => {
    const binary = Buffer.from(committed.binary);
    binary[0] ^= 0xff;
    manifest.binary.sha256 = sha256(binary);
    return [manifest, binary];
  });
  add("gap", (manifest) => ((manifest.palettes[1].offset += 4), [manifest, committed.binary]));
  add("overlap", (manifest) => ((manifest.palettes[1].offset -= 4), [manifest, committed.binary]));
  add("unaligned offset", (manifest) => ((manifest.palettes[0].offset = 2), [manifest, committed.binary]));
  add("unaligned length", (manifest) => ((manifest.palettes[0].byteLength += 1), [manifest, committed.binary]));
  add(
    "unsafe range",
    (manifest) => ((manifest.palettes[0].offset = Number.MAX_SAFE_INTEGER), [manifest, committed.binary]),
  );
  add(
    "bad palette digest",
    (manifest) => ((manifest.palettes[0].sha256 = "0".repeat(64)), [manifest, committed.binary]),
  );
  add("duplicate palette", (manifest) => {
    manifest.palettes[1].sha256 = manifest.palettes[0].sha256;
    return [manifest, committed.binary];
  });
  add("missing palette", (manifest) => {
    manifest.palettes.pop();
    manifest.paletteCount -= 1;
    return [manifest, committed.binary];
  });
  add("extra palette", (manifest) => {
    manifest.palettes.push({ sha256: "f".repeat(64), offset: committed.binary.length, byteLength: 4 });
    manifest.paletteCount += 1;
    return [manifest, committed.binary];
  });
  add("coherent unreferenced palette", (manifest) => {
    const paletteBodies = manifest.palettes.map((palette) => ({
      sha256: palette.sha256,
      body: committed.binary.subarray(palette.offset, palette.offset + palette.byteLength),
    }));
    const extraBody = Buffer.from([19, 37, 73, 109]);
    paletteBodies.push({ sha256: sha256(extraBody), body: extraBody });
    paletteBodies.sort((left, right) => (left.sha256 < right.sha256 ? -1 : 1));
    let offset = 0;
    manifest.palettes = paletteBodies.map(({ sha256: digest, body }) => {
      const palette = { sha256: digest, offset, byteLength: body.length };
      offset += body.length;
      return palette;
    });
    manifest.paletteCount = manifest.palettes.length;
    const binary = Buffer.concat(paletteBodies.map(({ body }) => body));
    manifest.binary.byteLength = binary.length;
    manifest.binary.sha256 = sha256(binary);
    return [manifest, binary];
  });
  add("missing assignment", (manifest) => (manifest.assignments.pop(), [manifest, committed.binary]));
  add("extra assignment", (manifest) => {
    manifest.assignments.push({ ...manifest.assignments.at(-1), id: "zz:extra" });
    return [manifest, committed.binary];
  });
  add("duplicate assignment", (manifest) => {
    manifest.assignments[1].id = manifest.assignments[0].id;
    return [manifest, committed.binary];
  });
  add("missing palette reference", (manifest) => {
    manifest.assignments[0].paletteSha256 = "0".repeat(64);
    return [manifest, committed.binary];
  });
  add("wrong assignment size", (manifest) => {
    manifest.assignments[0].byteLength += 4;
    return [manifest, committed.binary];
  });
  add("coherent same-size assignment palette swap", (manifest) => {
    const cloudCeiling = manifest.assignments.find((assignment) => assignment.id === "catalog:cloudCeiling");
    const cloudCover = manifest.assignments.find((assignment) => assignment.id === "catalog:cloudCover");
    assert.equal(cloudCeiling.paletteSha256, "2087c42f7f24ce12be3e4a8768a3825333de1b2f6b5870718d599f9a4b14fb80");
    assert.equal(cloudCover.paletteSha256, "cfcdd1be39b587366083f3617c6a0850fd4e2db4095bab3bacc0e092fe579f6f");
    assert.equal(cloudCeiling.byteLength, cloudCover.byteLength);
    [cloudCeiling.paletteSha256, cloudCover.paletteSha256] = [cloudCover.paletteSha256, cloudCeiling.paletteSha256];
    manifest.assignmentMapping = buildCatalogColorLookupAssignmentMappingIdentity(manifest.assignments);
    return [manifest, committed.binary];
  });
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const [manifest, binary] = mutate(cloneJson(committed.manifest));
      assert.throws(() => validate(manifest, binary));
    });
  }

  const compilerFixture = makeAssetDirectory(t);
  const mutatedCompilerPath = path.join(compilerFixture.directory, "color-lookup-compiler-mutated.js");
  fs.writeFileSync(mutatedCompilerPath, `${fs.readFileSync(DEFAULT_COMPILER_PATH, "utf8")}\n// mutation\n`);
  assert.throws(
    () => strictLoad(assignments, { ...compilerFixture, compilerPath: mutatedCompilerPath }),
    /compiler closure/,
  );
  const mutatedDependencyPath = path.join(compilerFixture.directory, "util-mutated.js");
  fs.writeFileSync(
    mutatedDependencyPath,
    `${fs.readFileSync(DEFAULT_COMPILER_DEPENDENCY_PATH, "utf8")}\n// mutation\n`,
  );
  assert.throws(
    () => strictLoad(assignments, { ...compilerFixture, compilerDependencyPath: mutatedDependencyPath }),
    /compiler closure/,
  );
  assert.doesNotThrow(() => validate(committed.manifest, committed.binary, assignments));
  assert.equal(input.sha256, committed.manifest.input.sha256);
});

test("post-validation recipe mutation is never trusted", () => {
  const finiteMutated = freshAssignments();
  buildCanonicalCatalogColorLookupInput(finiteMutated);
  finiteMutated[0].recipe.stops[0][1][0] += 1;
  assert.throws(() => strictLoad(finiteMutated), /input identity/);
  const dynamic = loadCatalogColorLookupRoster({ assignments: finiteMutated, mode: "dynamic", warn: () => {} });
  _resetCatalogColorLookupWarningsForTest();
  const warnings = [];
  const auto = loadCatalogColorLookupRoster({
    assignments: finiteMutated,
    mode: "auto",
    warn: (message) => warnings.push(message),
  });
  assert.equal(auto.effectiveMode, "dynamic");
  assert.equal(auto.fallbackReasonCode, "asset-validation-failed");
  assert.equal(warnings.length, 1);
  for (const assignment of finiteMutated) {
    assertContinuousLookupExact(auto.lookups.get(assignment.id), dynamic.lookups.get(assignment.id), assignment.id);
  }

  const nonfinite = freshAssignments();
  buildCanonicalCatalogColorLookupInput(nonfinite);
  nonfinite[0].recipe.stops[0][1][0] = Number.NaN;
  assert.throws(() => strictLoad(nonfinite), /malformed stop/);
  assert.throws(
    () => loadCatalogColorLookupRoster({ assignments: nonfinite, mode: "dynamic", warn: () => {} }),
    /malformed stop/,
  );
  assert.throws(
    () => loadCatalogColorLookupRoster({ assignments: nonfinite, mode: "auto", warn: () => {} }),
    /malformed stop/,
  );
});

test("materialization has no forgeable malformed-recipe validation bypass", () => {
  const recipe = freshAssignments()[0].recipe;
  recipe.stops[0][1][0] = Number.NaN;
  assert.throws(
    () => materializeContinuousColorLookupRecipe(recipe, new Uint8Array(recipe.size * 4), { validated: true }),
    /malformed stop/,
  );
});

test("public and custom lookup construction stays dynamic and isolated", () => {
  const continuousEntry = NOAA_NAM_PARAMETER_CATALOG.find(
    (entry) => CATALOG_RENDER_OPTIONS.get(entry.key).colorLookup.kind === "continuous",
  );
  const staticLookup = CATALOG_RENDER_OPTIONS.get(continuousEntry.key).colorLookup;
  const customLeft = buildCatalogRenderOptions({ ...continuousEntry }).colorLookup;
  const customRight = buildCatalogRenderOptions({ ...continuousEntry }).colorLookup;
  assertContinuousLookupExact(customLeft, staticLookup, "custom catalog");
  assert.notEqual(customLeft.colors.buffer, staticLookup.colors.buffer);
  assert.notEqual(customLeft.colors.buffer, customRight.colors.buffer);

  const sentinel = Object.freeze({ kind: "sentinel" });
  const extraArgument = buildCatalogRenderOptions({ ...continuousEntry }, sentinel);
  assert.equal(extraArgument.colorLookup.kind, "continuous");
  assert.notEqual(extraArgument.colorLookup, sentinel);
  assertContinuousLookupExact(extraArgument.colorLookup, staticLookup, "ignored extra argument");

  const mapped = NOAA_NAM_PARAMETER_CATALOG.map(buildCatalogRenderOptions);
  assert.equal(mapped.length, NOAA_NAM_PARAMETER_CATALOG.length);
  for (let index = 0; index < NOAA_NAM_PARAMETER_CATALOG.length; index += 1) {
    const entry = NOAA_NAM_PARAMETER_CATALOG[index];
    const actual = mapped[index].colorLookup;
    const expected = CATALOG_RENDER_OPTIONS.get(entry.key).colorLookup;
    assert.equal(actual.kind, expected.kind, `${entry.key}: Array.map public callback kind`);
    if (actual.kind === "continuous") {
      assertContinuousLookupExact(actual, expected, `${entry.key}: Array.map public callback`);
      assert.notEqual(actual.colors.buffer, expected.colors.buffer, `${entry.key}: remains dynamic`);
    } else {
      assert.deepEqual(actual.thresholds, expected.thresholds, `${entry.key}: step thresholds`);
      assert.deepEqual(actual.colors, expected.colors, `${entry.key}: step colors`);
    }
  }

  const arbitraryLeft = createContinuousColorLookup({
    stops: [
      [0, [1, 2, 3, 1]],
      [1, [4, 5, 6, 0.5]],
    ],
    min: -1,
    max: 2,
    size: 17,
  });
  const arbitraryRight = createContinuousColorLookup({
    stops: [
      [0, [1, 2, 3, 1]],
      [1, [4, 5, 6, 0.5]],
    ],
    min: -1,
    max: 2,
    size: 17,
  });
  assertContinuousLookupExact(arbitraryLeft, arbitraryRight, "arbitrary public lookup");
  assert.notEqual(arbitraryLeft.colors.buffer, arbitraryRight.colors.buffer);
});

test("public continuous lookup preserves legacy edge semantics and ordinary randomized parity", () => {
  assert.deepEqual(normalizeColorStops([], []), []);
  assert.deepEqual(normalizeColorStops([], [[Number.NaN, [1, 2, 3, 0.5]]]), [[Number.NaN, [1, 2, 3, 0.5]]]);
  let fallbackMapCalls = 0;
  const fallbackWithMap = {
    map(callback) {
      fallbackMapCalls += 1;
      return [callback([0.25, [7, 8, 9, 0.75]])];
    },
  };
  assert.deepEqual(normalizeColorStops([], fallbackWithMap), [[0.25, [7, 8, 9, 0.75]]]);
  assert.equal(fallbackMapCalls, 1);
  assert.throws(() => normalizeColorStops([], undefined), TypeError);

  const nanStop = createContinuousColorLookup({
    stops: [
      [Number.NaN, [1, 2, 3, 1]],
      [1, [4, 5, 6, 1]],
    ],
    size: 2,
  });
  assert.deepEqual([...nanStop.colors], [0, 0, 0, 255, 4, 5, 6, 255]);

  const evaluationOrder = [];
  const originalRound = Math.round;
  try {
    Math.round = (value) => {
      evaluationOrder.push(`round:${value}`);
      return originalRound(value);
    };
    createContinuousColorLookup({
      stops: [
        [0, [10, 20, 30, 1]],
        [1, [40, 50, 60, 1]],
      ],
      min: {
        valueOf() {
          evaluationOrder.push("min:valueOf");
          return 0;
        },
      },
      max: {
        valueOf() {
          evaluationOrder.push("max:valueOf");
          return 1;
        },
      },
      size: 2,
    });
  } finally {
    Math.round = originalRound;
  }
  assert.deepEqual(evaluationOrder, [
    "round:10",
    "round:20",
    "round:30",
    "round:40",
    "round:50",
    "round:60",
    "round:2",
    "round:10",
    "round:20",
    "round:30",
    "round:255",
    "round:40",
    "round:50",
    "round:60",
    "round:255",
    "min:valueOf",
    "max:valueOf",
  ]);

  let seed = 0x5f3759df;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let caseIndex = 0; caseIndex < 64; caseIndex += 1) {
    const stopCount = 2 + Math.floor(random() * 5);
    const positions = Array.from({ length: stopCount }, (_, index) =>
      index === 0 ? 0 : index === stopCount - 1 ? 1 : random(),
    ).sort((left, right) => left - right);
    const options = {
      stops: positions.map((position) => [
        position,
        [Math.floor(random() * 256), Math.floor(random() * 256), Math.floor(random() * 256), random()],
      ]),
      min: -100 + random() * 50,
      max: 1 + random() * 200,
      log: random() < 0.5,
      alpha: random(),
      size: 2 + Math.floor(random() * 128),
    };
    const actual = createContinuousColorLookup(options);
    const expected = compileContinuousColorLookupRecipe(
      resolveContinuousColorLookupRecipe(options, {
        fallbackStops: REFLECTIVITY_STOPS,
        defaultSize: 4096,
      }),
    );
    assertContinuousLookupExact(actual, expected, `random public case ${caseIndex}`);
  }
});

test("catalog render options resolve a stateful scale getter exactly once", () => {
  const entry = NOAA_NAM_PARAMETER_CATALOG.find(
    (candidate) => CATALOG_RENDER_OPTIONS.get(candidate.key).colorLookup.kind === "continuous",
  );
  let reads = 0;
  const stateful = {
    ...entry,
    get scale() {
      reads += 1;
      return reads === 1 ? entry.scale : "precipIn";
    },
  };
  const actual = buildCatalogRenderOptions(stateful);
  const expected = buildCatalogRenderOptions({ ...entry });
  assert.equal(reads, 1);
  assertContinuousLookupExact(actual.colorLookup, expected.colorLookup, "stateful scale");
  assert.deepEqual(
    {
      minVisible: actual.minVisible,
      maxVisible: actual.maxVisible,
      visibleRange: actual.visibleRange,
    },
    {
      minVisible: expected.minVisible,
      maxVisible: expected.maxVisible,
      visibleRange: expected.visibleRange,
    },
  );
});

test("catalog and core step lookups remain outside the precompiled roster and exact on dynamic rebuild", () => {
  const staticIds = new Set(freshAssignments().map((assignment) => assignment.id));
  let catalogSteps = 0;
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    const existing = CATALOG_RENDER_OPTIONS.get(entry.key).colorLookup;
    if (existing.kind !== "step") {
      continue;
    }
    catalogSteps += 1;
    assert.equal(staticIds.has(`catalog:${entry.key}`), false);
    const rebuilt = buildCatalogRenderOptions({ ...entry }).colorLookup;
    assert.deepEqual(rebuilt.thresholds, existing.thresholds);
    assert.deepEqual(rebuilt.colors, existing.colors);
    assert.notEqual(rebuilt.colors.buffer, existing.colors.buffer);
  }
  const coreSteps = Object.entries(CORE_LAYER_RENDER_OPTIONS).filter(
    ([, options]) => options.colorLookup.kind === "step",
  );
  assert.equal(catalogSteps, 8);
  assert.equal(coreSteps.length, 2);
  for (const [key] of coreSteps) {
    assert.equal(staticIds.has(`core:${key}`), false);
  }
});

test("generator is deterministic, SHA-sorted, timestamp-free, and supports isolated output-dir check", (t) => {
  const assignments = freshAssignments();
  const left = generateCatalogColorLookupAsset(assignments);
  const right = generateCatalogColorLookupAsset(freshAssignments());
  assert.deepEqual(left.binary, right.binary);
  assert.deepEqual(left.manifestBytes, right.manifestBytes);
  assert.equal(sha256(left.binary), EXPECTED_UNIQUE_BINARY_SHA256);
  assert.equal(left.assignmentCount, 73);
  assert.equal(left.paletteCount, 35);
  assert.deepEqual(left.manifest.assignmentMapping, {
    encoding: CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING,
    assignmentCount: 73,
    sha256: CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256,
  });
  assert.deepEqual(
    left.manifest.palettes.map((palette) => palette.sha256),
    [...left.manifest.palettes.map((palette) => palette.sha256)].sort(),
  );
  assert.deepEqual(
    left.manifest.assignments.map((assignment) => assignment.id),
    [...left.manifest.assignments.map((assignment) => assignment.id)].sort(),
  );
  assert.doesNotMatch(left.manifestBytes.toString("utf8"), /timestamp|generatedAt|\/Users\/|nodeVersion/i);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-color-generator-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  execFileSync(
    process.execPath,
    [path.join(ROOT_DIR, "scripts/generate-noaa-catalog-color-lookups.js"), "--write", `--output-dir=${outputDir}`],
    { cwd: ROOT_DIR, stdio: "pipe" },
  );
  const generatedBinaryPath = path.join(outputDir, path.basename(DEFAULT_BINARY_PATH));
  const generatedManifestPath = path.join(outputDir, path.basename(DEFAULT_MANIFEST_PATH));
  assert.deepEqual(fs.readFileSync(generatedBinaryPath), fs.readFileSync(DEFAULT_BINARY_PATH));
  assert.deepEqual(fs.readFileSync(generatedManifestPath), fs.readFileSync(DEFAULT_MANIFEST_PATH));
  const before = {
    binary: fs.readFileSync(generatedBinaryPath),
    manifest: fs.readFileSync(generatedManifestPath),
  };
  execFileSync(
    process.execPath,
    [path.join(ROOT_DIR, "scripts/generate-noaa-catalog-color-lookups.js"), "--check", "--output-dir", outputDir],
    { cwd: ROOT_DIR, stdio: "pipe" },
  );
  assert.deepEqual(fs.readFileSync(generatedBinaryPath), before.binary);
  assert.deepEqual(fs.readFileSync(generatedManifestPath), before.manifest);
});

test("generator check is non-mutating for missing and stale outputs and rejects invalid flags", (t) => {
  const generatorPath = path.join(ROOT_DIR, "scripts/generate-noaa-catalog-color-lookups.js");
  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-color-generator-missing-"));
  const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-color-generator-stale-"));
  t.after(() => fs.rmSync(missingDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(staleDir, { recursive: true, force: true }));

  const missing = spawnSync(process.execPath, [generatorPath, "--check", `--output-dir=${missingDir}`], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  });
  assert.notEqual(missing.status, 0);
  assert.deepEqual(fs.readdirSync(missingDir), [], "missing --check creates no files");

  execFileSync(process.execPath, [generatorPath, "--write", `--output-dir=${staleDir}`], {
    cwd: ROOT_DIR,
    stdio: "pipe",
  });
  const staleBinaryPath = path.join(staleDir, path.basename(DEFAULT_BINARY_PATH));
  const staleManifestPath = path.join(staleDir, path.basename(DEFAULT_MANIFEST_PATH));
  const staleBinary = Buffer.from(fs.readFileSync(staleBinaryPath));
  staleBinary[0] ^= 0xff;
  fs.writeFileSync(staleBinaryPath, staleBinary);
  const before = {
    binary: fs.readFileSync(staleBinaryPath),
    manifest: fs.readFileSync(staleManifestPath),
  };
  const stale = spawnSync(process.execPath, [generatorPath, "--check", "--output-dir", staleDir], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  });
  assert.notEqual(stale.status, 0);
  assert.deepEqual(fs.readFileSync(staleBinaryPath), before.binary);
  assert.deepEqual(fs.readFileSync(staleManifestPath), before.manifest);

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

test("compiler closure drift during generation fails before publication", () => {
  const originalReadFileSync = fs.readFileSync;
  let compilerReads = 0;
  fs.readFileSync = function readFileSyncWithDrift(filePath, ...args) {
    const body = originalReadFileSync.call(fs, filePath, ...args);
    if (path.resolve(String(filePath)) === path.resolve(DEFAULT_COMPILER_PATH)) {
      compilerReads += 1;
      if (compilerReads >= 2) {
        return Buffer.concat([Buffer.from(body), Buffer.from("\n// concurrent drift\n")]);
      }
    }
    return body;
  };
  try {
    assert.throws(
      () => generateCatalogColorLookupAsset(freshAssignments()),
      /compiler closure changed during asset generation/,
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(compilerReads, 2);
});

test("binary-first manifest-last pair publication fails closed without partial roster exposure", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-color-pair-publication-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binaryPath = path.join(directory, path.basename(DEFAULT_BINARY_PATH));
  const manifestPath = path.join(directory, path.basename(DEFAULT_MANIFEST_PATH));
  fs.writeFileSync(manifestPath, "{old-or-interrupted-manifest");

  // This models interruption after the new binary rename and before the
  // manifest rename. Pair publication is fail-closed and manifest-last; it is
  // deliberately not a rollback-atomic two-file transaction.
  writeFileAtomically(binaryPath, fs.readFileSync(DEFAULT_BINARY_PATH));
  const assignments = freshAssignments();
  assert.throws(() => strictLoad(assignments, { manifestPath, binaryPath }), /not valid JSON/);
  _resetCatalogColorLookupWarningsForTest();
  const state = loadCatalogColorLookupRoster({
    assignments,
    mode: "auto",
    manifestPath,
    binaryPath,
    warn: () => {},
  });
  assert.equal(state.effectiveMode, "dynamic");
  assert.equal(state.fallbackReasonCode, "manifest-json-invalid");
  assert.equal(state.lookups.size, 73);
});

test("four fresh worker isolates materialize exact independent rosters", async () => {
  const workerSource = `
    "use strict";
    const crypto = require("node:crypto");
    const { parentPort, workerData } = require("node:worker_threads");
    const { buildStaticContinuousColorLookupAssignments } = require(
      workerData.root + "/scripts/lib/noaa-beta/catalog-color-lookup-recipes"
    );
    const { loadCatalogColorLookupRoster } = require(
      workerData.root + "/scripts/lib/noaa-beta/catalog-color-lookup-asset"
    );
    const state = loadCatalogColorLookupRoster({
      assignments: buildStaticContinuousColorLookupAssignments(),
      mode: "precompiled",
      warn: () => {},
    });
    const rows = [...state.lookups.entries()].sort(([left], [right]) => left < right ? -1 : 1);
    const hash = crypto.createHash("sha256");
    for (const [id, lookup] of rows) {
      hash.update(id + "\\0" + lookup.colors.length + "\\0");
      hash.update(lookup.colors);
    }
    parentPort.postMessage({
      effectiveMode: state.effectiveMode,
      assignments: rows.length,
      uniqueBuffers: new Set(rows.map(([, lookup]) => lookup.colors.buffer)).size,
      hash: hash.digest("hex"),
    });
  `;
  const runWorker = () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(workerSource, { eval: true, workerData: { root: ROOT_DIR } });
      let messageCount = 0;
      let result;
      let workerError = null;
      worker.on("message", (message) => {
        messageCount += 1;
        result = message;
      });
      worker.once("error", (error) => {
        workerError = error;
      });
      worker.once("exit", (code) => {
        if (workerError) {
          reject(workerError);
          return;
        }
        if (code !== 0) {
          reject(new Error(`worker exited ${code}`));
          return;
        }
        if (messageCount !== 1) {
          reject(new Error(`worker emitted ${messageCount} result messages`));
          return;
        }
        resolve(result);
      });
    });
  const results = await Promise.all([runWorker(), runWorker(), runWorker(), runWorker()]);
  assert.equal(new Set(results.map((result) => result.hash)).size, 1);
  for (const result of results) {
    assert.deepEqual(
      { effectiveMode: result.effectiveMode, assignments: result.assignments, uniqueBuffers: result.uniqueBuffers },
      { effectiveMode: "precompiled", assignments: 73, uniqueBuffers: 73 },
    );
  }
});

test("binary owner becomes collectible after assignment clones materialize", () => {
  const script = `
    "use strict";
    const root = ${JSON.stringify(ROOT_DIR)};
    const { buildStaticContinuousColorLookupAssignments } = require(
      root + "/scripts/lib/noaa-beta/catalog-color-lookup-recipes"
    );
    const { loadCatalogColorLookupRoster } = require(
      root + "/scripts/lib/noaa-beta/catalog-color-lookup-asset"
    );
    const state = loadCatalogColorLookupRoster({
      assignments: buildStaticContinuousColorLookupAssignments(),
      mode: "precompiled",
      warn: () => {},
    });
    const weak = state.assetOwnerWeakRef;
    let attempts = 0;
    function probe() {
      for (let index = 0; index < 4; index += 1) global.gc();
      attempts += 1;
      if (weak.deref() === undefined) {
        process.stdout.write(JSON.stringify({
          collected: true,
          attempts,
          colors: [...state.lookups.values()].reduce((sum, lookup) => sum + lookup.colors.length, 0),
          memory: process.memoryUsage(),
        }));
        return;
      }
      if (attempts >= 40) {
        process.stdout.write(JSON.stringify({ collected: false, attempts }));
        process.exitCode = 1;
        return;
      }
      Buffer.alloc(1024 * 1024);
      setImmediate(probe);
    }
    setImmediate(probe);
  `;
  const result = spawnSync(process.execPath, ["--expose-gc", "-e", script], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.collected, true);
  assert.equal(parsed.colors, 2_670_592);
  assert.ok(parsed.memory.external > 0);
  assert.ok(parsed.memory.arrayBuffers > 0);
});

test("lookup mode remains renderer-signature neutral in fresh subprocesses", () => {
  const probe = (mode) => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        [
          'const raster = require("./scripts/lib/noaa-beta/raster");',
          'const renderer = require("./scripts/lib/noaa-beta-renderer");',
          "process.stdout.write(JSON.stringify({",
          "  effectiveMode: raster.STATIC_CONTINUOUS_COLOR_LOOKUP_STATE.effectiveMode,",
          "  signature: renderer.getNoaaGribRendererSignature(),",
          "}));",
        ].join("\n"),
      ],
      {
        cwd: ROOT_DIR,
        env: { ...process.env, MODELVIEW_NOAA_COLOR_LOOKUPS: mode },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const dynamic = probe("dynamic");
  const auto = probe("auto");
  const precompiled = probe("precompiled");
  assert.equal(dynamic.effectiveMode, "dynamic");
  assert.equal(auto.effectiveMode, "precompiled");
  assert.equal(precompiled.effectiveMode, "precompiled");
  assert.equal(dynamic.signature, auto.signature);
  assert.equal(dynamic.signature, precompiled.signature);
  assert.equal(STATIC_CONTINUOUS_COLOR_LOOKUP_STATE.effectiveMode, "dynamic");
});
