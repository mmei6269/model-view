"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PLETCHER_RF_FEATURE_KEYS, SNOW_RF_COMPILER_ID, inspectCompiledSnowRfModel } = require("./snow-rf-compiler");

const SNOW_RF_ASSET_SCHEMA_VERSION = 1;
const SNOW_RF_ASSET_FORMAT = "modelview-snow-rf-tree-major-fields-v1";
const SNOW_RF_ASSET_ENDIAN = "little";
const SNOW_RF_ASSET_ALIGNMENT = 8;
const SNOW_RF_ASSET_BASENAME = "snow-rf-conus-v1";
const SNOW_RF_COMPILER_CLOSURE_ENCODING = "ordered-generator-compiler-file-bytes-nul-v1";
const SNOW_RF_RECEIPT_SCHEMA_VERSION = 1;
const SNOW_RF_RECEIPT_TYPE = "noaa-snow-rf-state";
const SNOW_RF_ASSET_MATERIALIZATION_PHASES = Object.freeze([
  "manifestValidateNs",
  "binaryHashValidateNs",
  "ownerAllocateCopyNs",
  "layoutMaterializeNs",
  "graphValidateNs",
]);
const DEFAULT_SOURCE_PATH = path.resolve(__dirname, "../../../tools/noaa-beta/snow-rf/conus-rf.json");
const DEFAULT_BINARY_PATH = path.join(__dirname, "generated", `${SNOW_RF_ASSET_BASENAME}.bin`);
const DEFAULT_MANIFEST_PATH = path.join(__dirname, "generated", `${SNOW_RF_ASSET_BASENAME}.json`);
const DEFAULT_COMPILER_PATH = require.resolve("./snow-rf-compiler");
const DEFAULT_ASSET_MODULE_PATH = __filename;
const DEFAULT_GENERATOR_PATH = path.resolve(__dirname, "../../generate-noaa-snow-rf-asset.js");

const SNOW_RF_SOURCE_IDENTITY = Object.freeze({
  artifactRequired: "snow-rf/conus-rf.json",
  sha256: "b3bc9395135c6ef79d103e82516b70cdca6c28571807b362d4080de512f6c731",
  bytes: 27_054_389,
});

const SNOW_RF_MODEL_ORACLES = Object.freeze({
  featureCount: 27,
  treeCount: 100,
  nodeCount: 666_406,
  internalNodeCount: 333_153,
  leafCount: 333_253,
  maxDepth: 21,
});

const SNOW_RF_ASSET_ORACLES = Object.freeze({
  regionCount: 500,
  payloadBytes: 18_659_368,
  paddingBytes: 1_200,
  binaryBytes: 18_660_568,
  binarySha256: "b60056d477f13f68f590babad587badb607c174cb51b073c677294f920e27376",
});

const SNOW_RF_FIELD_SPECS = Object.freeze([
  Object.freeze({ name: "childrenLeft", type: "Int32", elementBytes: 4 }),
  Object.freeze({ name: "childrenRight", type: "Int32", elementBytes: 4 }),
  Object.freeze({ name: "feature", type: "Int32", elementBytes: 4 }),
  Object.freeze({ name: "threshold", type: "Float64", elementBytes: 8 }),
  Object.freeze({ name: "value", type: "Float64", elementBytes: 8 }),
]);

const MANIFEST_KEYS = Object.freeze([
  "schemaVersion",
  "format",
  "endian",
  "source",
  "compiler",
  "model",
  "layout",
  "binary",
]);
const SOURCE_KEYS = Object.freeze(["artifactRequired", "sha256", "bytes"]);
const COMPILER_KEYS = Object.freeze(["id", "closure"]);
const CLOSURE_KEYS = Object.freeze(["encoding", "sha256", "files"]);
const CLOSURE_FILE_KEYS = Object.freeze(["name", "byteLength", "sha256"]);
const MODEL_KEYS = Object.freeze([
  "featureCount",
  "treeCount",
  "nodeCount",
  "internalNodeCount",
  "leafCount",
  "maxDepth",
]);
const LAYOUT_KEYS = Object.freeze([
  "alignmentBytes",
  "fieldOrder",
  "regionCount",
  "payloadBytes",
  "paddingBytes",
  "binaryBytes",
  "regions",
]);
const FIELD_SPEC_KEYS = Object.freeze(["name", "type", "elementBytes"]);
const REGION_KEYS = Object.freeze(["treeIndex", "field", "type", "offset", "length", "byteLength"]);
const BINARY_KEYS = Object.freeze(["file", "bytes", "sha256"]);
const COMPILER_CLOSURE_FILE_NAMES = Object.freeze([
  "snow-rf-compiler.js",
  "snow-rf-asset.js",
  "generate-noaa-snow-rf-asset.js",
]);
const LOADED_STATE_KEYS = Object.freeze(["configuration", "model", "identity", "status", "timing"]);
const validatedManifestSnapshots = new WeakSet();
const isolatedBinaryOwners = new WeakSet();
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset").get;

function buildSnowRfCompilerClosure({
  compilerPath = DEFAULT_COMPILER_PATH,
  assetModulePath = DEFAULT_ASSET_MODULE_PATH,
  generatorPath = DEFAULT_GENERATOR_PATH,
} = {}) {
  const sources = [
    { name: COMPILER_CLOSURE_FILE_NAMES[0], filePath: compilerPath },
    { name: COMPILER_CLOSURE_FILE_NAMES[1], filePath: assetModulePath },
    { name: COMPILER_CLOSURE_FILE_NAMES[2], filePath: generatorPath },
  ];
  const hash = crypto.createHash("sha256");
  hash.update(`${SNOW_RF_COMPILER_CLOSURE_ENCODING}\0`);
  const files = sources.map(({ name, filePath }) => {
    const bytes = fs.readFileSync(filePath);
    hash.update(`${name}\0${bytes.byteLength}\0`);
    hash.update(bytes);
    return Object.freeze({
      name,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
  });
  return Object.freeze({
    encoding: SNOW_RF_COMPILER_CLOSURE_ENCODING,
    sha256: hash.digest("hex"),
    files: Object.freeze(files),
  });
}

function buildSnowRfAssetBinary(model) {
  const metrics = inspectCompiledSnowRfModel(model);
  assertExactModelOracles(metrics, "Cannot generate Snow-RF asset from a noncanonical model");
  let offset = 0;
  let payloadBytes = 0;
  let paddingBytes = 0;
  const regions = [];
  for (let treeIndex = 0; treeIndex < model.trees.length; treeIndex += 1) {
    const tree = model.trees[treeIndex];
    for (const field of SNOW_RF_FIELD_SPECS) {
      const aligned = alignSnowRfAssetOffset(offset);
      paddingBytes += aligned - offset;
      offset = aligned;
      const values = tree[field.name];
      const byteLength = values.length * field.elementBytes;
      regions.push(
        Object.freeze({
          treeIndex,
          field: field.name,
          type: field.type,
          offset,
          length: values.length,
          byteLength,
        }),
      );
      payloadBytes += byteLength;
      offset += byteLength;
    }
  }
  const binary = Buffer.alloc(offset);
  for (const region of regions) {
    const values = model.trees[region.treeIndex][region.field];
    for (let index = 0; index < values.length; index += 1) {
      const target = region.offset + index * (region.type === "Int32" ? 4 : 8);
      if (region.type === "Int32") {
        binary.writeInt32LE(values[index], target);
      } else {
        binary.writeDoubleLE(values[index], target);
      }
    }
  }
  const binarySha256 = sha256(binary);
  assertExactAssetOracles(
    {
      regionCount: regions.length,
      payloadBytes,
      paddingBytes,
      binaryBytes: binary.byteLength,
      binarySha256,
    },
    "Generated Snow-RF binary differs from the frozen layout oracle",
  );
  const regionDiagnostics = Object.freeze(
    regions.map((region) =>
      Object.freeze({
        treeIndex: region.treeIndex,
        field: region.field,
        type: region.type,
        length: region.length,
        byteLength: region.byteLength,
        sha256: sha256(binary.subarray(region.offset, region.offset + region.byteLength)),
      }),
    ),
  );
  return Object.freeze({
    binary,
    binarySha256,
    regions: Object.freeze(regions),
    regionDiagnostics,
    payloadBytes,
    paddingBytes,
  });
}

function buildSnowRfAssetManifest({ built, compilerClosure, binaryFile = path.basename(DEFAULT_BINARY_PATH) } = {}) {
  if (!built || !isUint8Bytes(built.binary)) {
    throw new Error("Snow-RF asset generation requires built binary bytes.");
  }
  assertExactAssetOracles(
    {
      regionCount: built.regions?.length,
      payloadBytes: built.payloadBytes,
      paddingBytes: built.paddingBytes,
      binaryBytes: built.binary.byteLength,
      binarySha256: sha256(built.binary),
    },
    "Snow-RF manifest input differs from the frozen binary oracle",
  );
  const closure = snapshotCompilerClosure(compilerClosure, "compiler closure");
  return {
    schemaVersion: SNOW_RF_ASSET_SCHEMA_VERSION,
    format: SNOW_RF_ASSET_FORMAT,
    endian: SNOW_RF_ASSET_ENDIAN,
    source: { ...SNOW_RF_SOURCE_IDENTITY },
    compiler: {
      id: SNOW_RF_COMPILER_ID,
      closure: cloneCompilerClosure(closure),
    },
    model: { ...SNOW_RF_MODEL_ORACLES },
    layout: {
      alignmentBytes: SNOW_RF_ASSET_ALIGNMENT,
      fieldOrder: SNOW_RF_FIELD_SPECS.map((field) => ({ ...field })),
      regionCount: built.regions.length,
      payloadBytes: built.payloadBytes,
      paddingBytes: built.paddingBytes,
      binaryBytes: built.binary.byteLength,
      regions: built.regions.map((region) => ({ ...region })),
    },
    binary: {
      file: binaryFile,
      bytes: built.binary.byteLength,
      sha256: built.binarySha256,
    },
  };
}

function serializeSnowRfAssetManifest(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function validateSnowRfAssetManifest({ manifest, compilerClosure = buildSnowRfCompilerClosure() } = {}) {
  const root = readExactRecord(manifest, MANIFEST_KEYS, "Snow-RF manifest");
  if (
    root.schemaVersion !== SNOW_RF_ASSET_SCHEMA_VERSION ||
    root.format !== SNOW_RF_ASSET_FORMAT ||
    root.endian !== SNOW_RF_ASSET_ENDIAN
  ) {
    throw new Error("Snow-RF manifest schema, format, or endian is invalid.");
  }

  const source = readExactRecord(root.source, SOURCE_KEYS, "Snow-RF source identity");
  assertExactJson(source, SNOW_RF_SOURCE_IDENTITY, "Snow-RF source identity does not match the frozen source");

  const compiler = readExactRecord(root.compiler, COMPILER_KEYS, "Snow-RF compiler");
  if (compiler.id !== SNOW_RF_COMPILER_ID) {
    throw new Error("Snow-RF manifest compiler ID is invalid.");
  }
  const closure = snapshotCompilerClosure(compiler.closure, "Snow-RF manifest compiler closure");
  const expectedClosure = snapshotCompilerClosure(compilerClosure, "authoritative Snow-RF compiler closure");
  assertExactJson(closure, expectedClosure, "Snow-RF manifest compiler closure does not match production sources");

  const model = readExactRecord(root.model, MODEL_KEYS, "Snow-RF model metrics");
  assertExactJson(model, SNOW_RF_MODEL_ORACLES, "Snow-RF model metrics do not match the frozen shape");

  const layout = readExactRecord(root.layout, LAYOUT_KEYS, "Snow-RF layout");
  if (
    layout.alignmentBytes !== SNOW_RF_ASSET_ALIGNMENT ||
    layout.regionCount !== SNOW_RF_ASSET_ORACLES.regionCount ||
    layout.payloadBytes !== SNOW_RF_ASSET_ORACLES.payloadBytes ||
    layout.paddingBytes !== SNOW_RF_ASSET_ORACLES.paddingBytes ||
    layout.binaryBytes !== SNOW_RF_ASSET_ORACLES.binaryBytes
  ) {
    throw new Error("Snow-RF manifest layout totals do not match the frozen layout.");
  }
  const rawFieldOrder = readExactDenseArray(layout.fieldOrder, SNOW_RF_FIELD_SPECS.length, "Snow-RF field order");
  const fieldOrder = Object.freeze(
    rawFieldOrder.map((field, index) => {
      const snapshot = readExactRecord(field, FIELD_SPEC_KEYS, `Snow-RF field spec ${index}`);
      assertExactJson(snapshot, SNOW_RF_FIELD_SPECS[index], `Snow-RF field spec ${index} is invalid`);
      return Object.freeze(snapshot);
    }),
  );
  const rawRegions = readExactDenseArray(layout.regions, SNOW_RF_ASSET_ORACLES.regionCount, "Snow-RF regions");
  const regions = Object.freeze(
    rawRegions.map((region, index) => Object.freeze(readExactRecord(region, REGION_KEYS, `Snow-RF region ${index}`))),
  );
  validateSnowRfRegionLayout(regions);

  const binary = readExactRecord(root.binary, BINARY_KEYS, "Snow-RF binary identity");
  if (
    binary.file !== path.basename(DEFAULT_BINARY_PATH) ||
    binary.bytes !== SNOW_RF_ASSET_ORACLES.binaryBytes ||
    binary.sha256 !== SNOW_RF_ASSET_ORACLES.binarySha256
  ) {
    throw new Error("Snow-RF manifest binary identity does not match the frozen binary oracle.");
  }

  const snapshot = Object.freeze({
    schemaVersion: root.schemaVersion,
    format: root.format,
    endian: root.endian,
    source: Object.freeze(source),
    compiler: Object.freeze({
      id: compiler.id,
      closure,
    }),
    model: Object.freeze(model),
    layout: Object.freeze({
      alignmentBytes: layout.alignmentBytes,
      fieldOrder,
      regionCount: layout.regionCount,
      payloadBytes: layout.payloadBytes,
      paddingBytes: layout.paddingBytes,
      binaryBytes: layout.binaryBytes,
      regions,
    }),
    binary: Object.freeze(binary),
  });
  validatedManifestSnapshots.add(snapshot);
  return snapshot;
}

function materializeSnowRfAsset({ manifest, binaryBytes, compilerClosure, phaseStartNs, onInstrumentation } = {}) {
  const instrumentation = createSnowRfAssetInstrumentation({
    phaseStartNs,
    onInstrumentation,
  });
  let modelMetrics = null;
  let binaryValidated = false;
  try {
    const validatedManifest = instrumentation.runPhase("manifestValidateNs", () => {
      requireLittleEndianHost();
      return validateSnowRfAssetManifest({
        manifest,
        compilerClosure: compilerClosure ?? buildSnowRfCompilerClosure(),
      });
    });
    instrumentation.runPhase("binaryHashValidateNs", () => {
      const byteLength = canonicalUint8ByteLength(binaryBytes);
      if (byteLength === null) {
        throw new Error(
          "Snow-RF binary input must be one exact-length, whole-buffer Uint8Array backed by a private ArrayBuffer.",
        );
      }
      if (
        byteLength !== SNOW_RF_ASSET_ORACLES.binaryBytes ||
        sha256(binaryBytes) !== SNOW_RF_ASSET_ORACLES.binarySha256
      ) {
        throw new Error("Snow-RF binary bytes or whole-file SHA-256 are invalid.");
      }
      binaryValidated = true;
    });
    const owner = instrumentation.runPhase("ownerAllocateCopyNs", () => {
      const byteLength = canonicalUint8ByteLength(binaryBytes);
      if (!binaryValidated || byteLength !== SNOW_RF_ASSET_ORACLES.binaryBytes) {
        throw new Error(
          "Snow-RF binary input must be one exact-length, whole-buffer Uint8Array backed by a private ArrayBuffer.",
        );
      }
      const nextOwner = new ArrayBuffer(byteLength);
      new Uint8Array(nextOwner).set(binaryBytes);
      isolatedBinaryOwners.add(nextOwner);
      return nextOwner;
    });
    const model = instrumentation.runPhase("layoutMaterializeNs", () =>
      materializeValidatedSnowRfAssetOwnerLayout(validatedManifest, owner),
    );
    modelMetrics = instrumentation.runPhase("graphValidateNs", () => {
      const metrics = inspectCompiledSnowRfModel(model);
      assertExactModelOracles(metrics, "Snow-RF typed asset graph validation failed");
      return metrics;
    });
    instrumentation.publish({ completed: true, modelMetrics });
    return model;
  } catch (error) {
    try {
      instrumentation.publish({ completed: false, modelMetrics: null });
    } catch (instrumentationError) {
      throw new AggregateError(
        [error, instrumentationError],
        "Snow-RF asset materialization and failure instrumentation both failed.",
      );
    }
    throw error;
  }
}

function createSnowRfAssetInstrumentation({ phaseStartNs, onInstrumentation }) {
  if (onInstrumentation !== undefined && typeof onInstrumentation !== "function") {
    throw new Error("Snow-RF asset instrumentation callback must be a function.");
  }
  const enabled = phaseStartNs !== undefined || onInstrumentation !== undefined;
  if (phaseStartNs !== undefined && (typeof phaseStartNs !== "bigint" || phaseStartNs < 0n)) {
    throw new Error("Snow-RF asset phaseStartNs must be a nonnegative bigint.");
  }
  let cursor = enabled ? (phaseStartNs ?? process.hrtime.bigint()) : null;
  let nextPhaseIndex = 0;
  let published = false;
  const phases = [];
  const memorySnapshots = [];

  function runPhase(name, action) {
    if (name !== SNOW_RF_ASSET_MATERIALIZATION_PHASES[nextPhaseIndex]) {
      throw new Error(`Snow-RF asset phase order is invalid at ${String(name)}.`);
    }
    nextPhaseIndex += 1;
    if (!enabled) {
      return action();
    }
    const startNs = cursor;
    let result;
    let actionError = null;
    try {
      result = action();
    } catch (error) {
      actionError = error;
    }
    memorySnapshots.push(captureSnowRfMemorySnapshot(`after:${name}`));
    const endNs = process.hrtime.bigint();
    phases.push(snapshotSnowRfTimingPhase(name, startNs, endNs));
    cursor = endNs;
    if (actionError) {
      throw actionError;
    }
    return result;
  }

  function publish({ completed, modelMetrics }) {
    if (!enabled || published) {
      return;
    }
    published = true;
    if (completed && nextPhaseIndex !== SNOW_RF_ASSET_MATERIALIZATION_PHASES.length) {
      throw new Error("Snow-RF asset instrumentation cannot publish an incomplete successful phase roster.");
    }
    if (onInstrumentation) {
      onInstrumentation(
        Object.freeze({
          completed,
          phases: Object.freeze(phases.slice()),
          memorySnapshots: Object.freeze(memorySnapshots.slice()),
          modelMetrics,
        }),
      );
    }
  }

  return Object.freeze({ publish, runPhase });
}

function snapshotSnowRfTimingPhase(name, startNs, endNs) {
  if (typeof startNs !== "bigint" || typeof endNs !== "bigint" || startNs < 0n || endNs < startNs) {
    throw new Error(`Snow-RF phase ${name} has invalid monotonic boundaries.`);
  }
  return Object.freeze({
    name,
    startNs: startNs.toString(),
    endNs: endNs.toString(),
    durationNs: (endNs - startNs).toString(),
  });
}

function captureSnowRfMemorySnapshot(label) {
  const memory = process.memoryUsage();
  const captureNs = process.hrtime.bigint();
  return Object.freeze({
    label,
    captureNs: captureNs.toString(),
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  });
}

function materializeValidatedSnowRfAssetOwnerLayout(validatedManifest, owner) {
  if (!validatedManifestSnapshots.has(validatedManifest)) {
    throw new Error("Snow-RF materialization requires a validated manifest snapshot.");
  }
  if (
    intrinsicArrayBufferByteLength(owner) !== SNOW_RF_ASSET_ORACLES.binaryBytes ||
    !isolatedBinaryOwners.delete(owner)
  ) {
    throw new Error("Snow-RF materialization requires one private, single-use exact-length ArrayBuffer owner.");
  }
  const mutableTrees = Array.from({ length: SNOW_RF_MODEL_ORACLES.treeCount }, () => ({}));
  let cursor = 0;
  let payloadBytes = 0;
  let paddingBytes = 0;
  let nodeCount = 0;

  for (let regionIndex = 0; regionIndex < validatedManifest.layout.regions.length; regionIndex += 1) {
    const region = validatedManifest.layout.regions[regionIndex];
    const expectedTreeIndex = Math.floor(regionIndex / SNOW_RF_FIELD_SPECS.length);
    const expectedField = SNOW_RF_FIELD_SPECS[regionIndex % SNOW_RF_FIELD_SPECS.length];
    const aligned = alignSnowRfAssetOffset(cursor);
    if (
      region.treeIndex !== expectedTreeIndex ||
      region.field !== expectedField.name ||
      region.type !== expectedField.type ||
      !Number.isSafeInteger(region.offset) ||
      region.offset !== aligned ||
      region.offset % SNOW_RF_ASSET_ALIGNMENT !== 0 ||
      !Number.isSafeInteger(region.length) ||
      region.length <= 0 ||
      !Number.isSafeInteger(region.byteLength) ||
      region.byteLength !== region.length * expectedField.elementBytes
    ) {
      throw new Error(`Snow-RF region ${regionIndex} has an invalid tree-major layout.`);
    }
    const end = region.offset + region.byteLength;
    if (!Number.isSafeInteger(end) || end > owner.byteLength) {
      throw new Error(`Snow-RF region ${regionIndex} extends outside the binary.`);
    }
    const padding = new Uint8Array(owner, cursor, region.offset - cursor);
    for (const byte of padding) {
      if (byte !== 0) {
        throw new Error(`Snow-RF region ${regionIndex} has nonzero alignment padding.`);
      }
    }
    paddingBytes += region.offset - cursor;
    payloadBytes += region.byteLength;
    const View = expectedField.type === "Int32" ? Int32Array : Float64Array;
    mutableTrees[expectedTreeIndex][expectedField.name] = new View(owner, region.offset, region.length);
    cursor = end;
  }

  if (
    cursor !== owner.byteLength ||
    payloadBytes !== SNOW_RF_ASSET_ORACLES.payloadBytes ||
    paddingBytes !== SNOW_RF_ASSET_ORACLES.paddingBytes
  ) {
    throw new Error("Snow-RF regions do not provide complete, exact binary coverage.");
  }

  const trees = Object.freeze(
    mutableTrees.map((tree, treeIndex) => {
      const lengths = SNOW_RF_FIELD_SPECS.map((field) => tree[field.name]?.length);
      if (lengths.some((length) => !Number.isSafeInteger(length) || length <= 0 || length !== lengths[0])) {
        throw new Error(`Snow-RF tree ${treeIndex} has inconsistent field lengths.`);
      }
      nodeCount += lengths[0];
      return Object.freeze({
        childrenLeft: tree.childrenLeft,
        childrenRight: tree.childrenRight,
        feature: tree.feature,
        threshold: tree.threshold,
        value: tree.value,
      });
    }),
  );
  if (nodeCount !== SNOW_RF_MODEL_ORACLES.nodeCount) {
    throw new Error("Snow-RF typed tree node totals do not match the frozen shape.");
  }

  const model = Object.freeze({
    featureKeys: Object.freeze(Array.from(PLETCHER_RF_FEATURE_KEYS)),
    trees,
  });
  let viewCount = 0;
  for (const tree of model.trees) {
    for (const field of SNOW_RF_FIELD_SPECS) {
      const view = tree[field.name];
      if (view.buffer !== owner) {
        throw new Error("Snow-RF typed regions do not share one exact owner.");
      }
      viewCount += 1;
    }
  }
  if (viewCount !== SNOW_RF_ASSET_ORACLES.regionCount) {
    throw new Error("Snow-RF typed view coverage is incomplete.");
  }
  return model;
}

function validateSnowRfRegionLayout(regions) {
  let cursor = 0;
  let payloadBytes = 0;
  let paddingBytes = 0;
  let nodeCount = 0;
  let currentTreeLength = null;
  for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
    const region = regions[regionIndex];
    const expectedTreeIndex = Math.floor(regionIndex / SNOW_RF_FIELD_SPECS.length);
    const fieldIndex = regionIndex % SNOW_RF_FIELD_SPECS.length;
    const expectedField = SNOW_RF_FIELD_SPECS[fieldIndex];
    const aligned = alignSnowRfAssetOffset(cursor);
    if (
      region.treeIndex !== expectedTreeIndex ||
      region.field !== expectedField.name ||
      region.type !== expectedField.type ||
      !Number.isSafeInteger(region.offset) ||
      region.offset !== aligned ||
      region.offset % SNOW_RF_ASSET_ALIGNMENT !== 0 ||
      !Number.isSafeInteger(region.length) ||
      region.length <= 0 ||
      !Number.isSafeInteger(region.byteLength) ||
      region.byteLength !== region.length * expectedField.elementBytes
    ) {
      throw new Error(`Snow-RF region ${regionIndex} has an invalid tree-major layout.`);
    }
    const end = region.offset + region.byteLength;
    if (!Number.isSafeInteger(end) || end > SNOW_RF_ASSET_ORACLES.binaryBytes) {
      throw new Error(`Snow-RF region ${regionIndex} extends outside the binary.`);
    }
    if (fieldIndex === 0) {
      currentTreeLength = region.length;
    } else if (region.length !== currentTreeLength) {
      throw new Error(`Snow-RF tree ${expectedTreeIndex} has inconsistent region lengths.`);
    }
    if (fieldIndex === SNOW_RF_FIELD_SPECS.length - 1) {
      nodeCount += currentTreeLength;
    }
    paddingBytes += region.offset - cursor;
    payloadBytes += region.byteLength;
    cursor = end;
  }
  if (
    cursor !== SNOW_RF_ASSET_ORACLES.binaryBytes ||
    payloadBytes !== SNOW_RF_ASSET_ORACLES.payloadBytes ||
    paddingBytes !== SNOW_RF_ASSET_ORACLES.paddingBytes ||
    nodeCount !== SNOW_RF_MODEL_ORACLES.nodeCount
  ) {
    throw new Error("Snow-RF region coverage, padding, payload, or node totals are invalid.");
  }
}

function createSnowRfLoadedState({ configuration, model, identity, status, timing = null } = {}) {
  const modelMetrics = inspectCompiledSnowRfModel(model);
  if (!modelMetrics) {
    throw new Error("Cannot publish a Snow-RF loaded state with an invalid compiled model.");
  }
  return Object.freeze({
    configuration: snapshotBenchmarkJson(configuration, "Snow-RF resolved configuration"),
    model,
    identity: snapshotBenchmarkJson(identity, "Snow-RF loaded identity"),
    status: snapshotBenchmarkJson(status, "Snow-RF loaded status"),
    timing: timing === null ? null : snapshotBenchmarkJson(timing, "Snow-RF loader timing"),
  });
}

function buildSnowRfAssetStateSnapshot(state) {
  const snapshot = readExactRecord(state, LOADED_STATE_KEYS, "Snow-RF loaded state");
  const modelMetrics = inspectCompiledSnowRfModel(snapshot.model);
  if (!modelMetrics) {
    throw new Error("Cannot snapshot a Snow-RF loaded state with an invalid model.");
  }
  return Object.freeze({
    configuration: snapshotBenchmarkJson(snapshot.configuration, "Snow-RF resolved configuration"),
    identity: snapshotBenchmarkJson(snapshot.identity, "Snow-RF loaded identity"),
    status: snapshotBenchmarkJson(snapshot.status, "Snow-RF loaded status"),
    timing: snapshot.timing === null ? null : snapshotBenchmarkJson(snapshot.timing, "Snow-RF loader timing"),
    modelMetrics,
  });
}

function buildSnowRfBenchmarkReceipt(state, { role, spawnOrdinal, processId = process.pid, threadId = 0 } = {}) {
  if (role !== "builder-main" && role !== "frame-worker") {
    throw new Error(`Invalid Snow-RF benchmark receipt role '${String(role)}'.`);
  }
  if (!Number.isSafeInteger(spawnOrdinal) || spawnOrdinal < 0) {
    throw new Error("Snow-RF benchmark receipt spawnOrdinal must be a nonnegative integer.");
  }
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("Snow-RF benchmark receipt processId must be a positive integer.");
  }
  if (!Number.isSafeInteger(threadId) || threadId < 0) {
    throw new Error("Snow-RF benchmark receipt threadId must be a nonnegative integer.");
  }
  return Object.freeze({
    schemaVersion: SNOW_RF_RECEIPT_SCHEMA_VERSION,
    type: SNOW_RF_RECEIPT_TYPE,
    role,
    spawnOrdinal,
    processId,
    threadId,
    state: buildSnowRfAssetStateSnapshot(state),
  });
}

function snapshotCompilerClosure(value, label) {
  const closure = readExactRecord(value, CLOSURE_KEYS, label);
  if (closure.encoding !== SNOW_RF_COMPILER_CLOSURE_ENCODING || !isSha256(closure.sha256)) {
    throw new Error(`${label} has an invalid encoding or SHA-256.`);
  }
  const rawFiles = readExactDenseArray(closure.files, COMPILER_CLOSURE_FILE_NAMES.length, `${label} files`);
  const files = Object.freeze(
    rawFiles.map((file, index) => {
      const snapshot = readExactRecord(file, CLOSURE_FILE_KEYS, `${label} file ${index}`);
      if (
        snapshot.name !== COMPILER_CLOSURE_FILE_NAMES[index] ||
        !Number.isSafeInteger(snapshot.byteLength) ||
        snapshot.byteLength <= 0 ||
        !isSha256(snapshot.sha256)
      ) {
        throw new Error(`${label} file ${index} is invalid.`);
      }
      return Object.freeze(snapshot);
    }),
  );
  return Object.freeze({
    encoding: closure.encoding,
    sha256: closure.sha256,
    files,
  });
}

function cloneCompilerClosure(closure) {
  return {
    encoding: closure.encoding,
    sha256: closure.sha256,
    files: closure.files.map((file) => ({ ...file })),
  };
}

function readExactRecord(value, expectedKeys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error(`${label} has missing, extra, or symbolic fields.`);
  }
  const snapshot = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`${label}.${key} must be an own data property.`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function readExactDenseArray(value, expectedLength, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || lengthDescriptor.value !== expectedLength) {
    throw new Error(`${label} has an invalid length.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedLength + 1 || !ownKeys.includes("length")) {
    throw new Error(`${label} must be dense and contain no extra properties.`);
  }
  const snapshot = new Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const key = String(index);
    if (!ownKeys.includes(key)) {
      throw new Error(`${label} has a hole at index ${index}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new Error(`${label}[${index}] must be an own data property.`);
    }
    snapshot[index] = descriptor.value;
  }
  if (
    ownKeys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !Number.isSafeInteger(Number(key)) ||
          Number(key) < 0 ||
          Number(key) >= expectedLength ||
          String(Number(key)) !== key),
    )
  ) {
    throw new Error(`${label} must be dense and contain no extra properties.`);
  }
  return Object.freeze(snapshot);
}

function snapshotBenchmarkJson(value, label, active = new Set(), keyName = "") {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (keyName.endsWith("Ns") && !/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new Error(`${label}.${keyName} must be a canonical nonnegative integer nanosecond string.`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite number.`);
    }
    if (keyName.endsWith("Ns")) {
      throw new Error(`${label}.${keyName} must retain raw nanoseconds as a decimal string.`);
    }
    return value;
  }
  if (value === undefined || typeof value !== "object") {
    throw new Error(`${label} is not benchmark-safe JSON data.`);
  }
  if (active.has(value)) {
    throw new Error(`${label} contains a cycle.`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        throw new Error(`${label} has an invalid array length.`);
      }
      const dense = readExactDenseArray(value, lengthDescriptor.value, label);
      return Object.freeze(dense.map((entry, index) => snapshotBenchmarkJson(entry, `${label}[${index}]`, active, "")));
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error(`${label} must contain only plain objects.`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new Error(`${label} contains a symbolic field.`);
    }
    const result = {};
    for (const key of ownKeys.slice().sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new Error(`${label}.${key} must be an own data property.`);
      }
      Object.defineProperty(result, key, {
        value: snapshotBenchmarkJson(descriptor.value, label, active, key),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return Object.freeze(result);
  } finally {
    active.delete(value);
  }
}

function assertExactModelOracles(actual, prefix) {
  assertExactJson(actual, SNOW_RF_MODEL_ORACLES, prefix);
}

function assertExactAssetOracles(actual, prefix) {
  assertExactJson(actual, SNOW_RF_ASSET_ORACLES, prefix);
}

function assertExactJson(actual, expected, prefix) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${prefix}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }
}

function alignSnowRfAssetOffset(offset) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Snow-RF asset offsets must be nonnegative safe integers.");
  }
  return Math.ceil(offset / SNOW_RF_ASSET_ALIGNMENT) * SNOW_RF_ASSET_ALIGNMENT;
}

function hostIsLittleEndian() {
  const bytes = new Uint8Array(new Uint16Array([0x0102]).buffer);
  return bytes[0] === 0x02 && bytes[1] === 0x01;
}

function requireLittleEndianHost(isLittleEndian = hostIsLittleEndian()) {
  if (isLittleEndian !== true) {
    throw new Error("Snow-RF typed assets require a little-endian host.");
  }
}

function isUint8Bytes(value) {
  return ArrayBuffer.isView(value) && value.BYTES_PER_ELEMENT === 1;
}

function canonicalUint8ByteLength(value) {
  if (
    !ArrayBuffer.isView(value) ||
    (!Buffer.isBuffer(value) && Object.getPrototypeOf(value) !== Uint8Array.prototype)
  ) {
    return null;
  }
  let owner;
  let byteLength;
  let byteOffset;
  try {
    owner = typedArrayBufferGetter.call(value);
    byteLength = typedArrayByteLengthGetter.call(value);
    byteOffset = typedArrayByteOffsetGetter.call(value);
  } catch {
    return null;
  }
  const ownerByteLength = intrinsicArrayBufferByteLength(owner);
  return ownerByteLength !== null && byteOffset === 0 && byteLength === ownerByteLength ? byteLength : null;
}

function intrinsicArrayBufferByteLength(value) {
  try {
    return arrayBufferByteLengthGetter.call(value);
  } catch {
    return null;
  }
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

module.exports = {
  COMPILER_CLOSURE_FILE_NAMES,
  DEFAULT_ASSET_MODULE_PATH,
  DEFAULT_BINARY_PATH,
  DEFAULT_COMPILER_PATH,
  DEFAULT_GENERATOR_PATH,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SOURCE_PATH,
  SNOW_RF_ASSET_ALIGNMENT,
  SNOW_RF_ASSET_BASENAME,
  SNOW_RF_ASSET_ENDIAN,
  SNOW_RF_ASSET_FORMAT,
  SNOW_RF_ASSET_MATERIALIZATION_PHASES,
  SNOW_RF_ASSET_ORACLES,
  SNOW_RF_ASSET_SCHEMA_VERSION,
  SNOW_RF_COMPILER_CLOSURE_ENCODING,
  SNOW_RF_FIELD_SPECS,
  SNOW_RF_MODEL_ORACLES,
  SNOW_RF_RECEIPT_SCHEMA_VERSION,
  SNOW_RF_RECEIPT_TYPE,
  SNOW_RF_SOURCE_IDENTITY,
  alignSnowRfAssetOffset,
  buildSnowRfAssetStateSnapshot,
  buildSnowRfAssetBinary,
  buildSnowRfAssetManifest,
  buildSnowRfBenchmarkReceipt,
  buildSnowRfCompilerClosure,
  createSnowRfLoadedState,
  hostIsLittleEndian,
  materializeSnowRfAsset,
  requireLittleEndianHost,
  serializeSnowRfAssetManifest,
  sha256,
  validateSnowRfAssetManifest,
};
