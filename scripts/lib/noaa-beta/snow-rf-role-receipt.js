"use strict";

const {
  SNOW_RF_ASSET_ORACLES,
  SNOW_RF_FIELD_SPECS,
  SNOW_RF_MODEL_ORACLES,
  SNOW_RF_RECEIPT_SCHEMA_VERSION,
  SNOW_RF_RECEIPT_TYPE,
  SNOW_RF_SOURCE_IDENTITY,
  alignSnowRfAssetOffset,
  buildSnowRfAssetStateSnapshot,
  sha256,
} = require("./snow-rf-asset");
const { PASS16_REGION_COMMITMENT_COUNT, validatePass16TimingAndMemory } = require("./snow-rf-benchmark-contract");
const { SNOW_RF_LOAD_FAILURE_CACHE, SNOW_RF_LOAD_STATE_CACHE, loadSnowRfState } = require("./selection");

const SNOW_RF_COMMITMENT_ENCODING = "snow-rf-tree-major-fields-le-v1";
const SNOW_RF_STARTUP_RECEIPT_TYPE = SNOW_RF_RECEIPT_TYPE;

function captureMemorySnapshot(label) {
  const memory = process.memoryUsage();
  return Object.freeze({
    label,
    captureNs: process.hrtime.bigint().toString(),
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  });
}

function assertReceiptCoordinates({ role, spawnOrdinal, processId, threadId }) {
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
}

function resolvePass16Mode(treatmentState) {
  const configuration = treatmentState?.configuration;
  const status = treatmentState?.status;
  if (
    status?.effectiveMode === "json" &&
    status.fallbackUsed === false &&
    status.fallbackReasonCode === null &&
    configuration?.resolvedMode === "off"
  ) {
    return "A";
  }
  if (
    status?.effectiveMode === "typed-asset" &&
    status.fallbackUsed === false &&
    status.fallbackReasonCode === null &&
    (configuration?.resolvedMode === "auto" || configuration?.resolvedMode === "required")
  ) {
    return "B";
  }
  throw new Error(
    "Snow-RF benchmark receipts require an unfallbacked off/JSON (A) or auto|required/typed-asset (B) treatment.",
  );
}

function inspectTypedAssetOwnership(model, mode) {
  if (mode === "A") {
    return null;
  }
  const owners = new Set();
  let commonOwner = null;
  let regionCount = 0;
  let privateRegionOwnerCount = 0;
  for (let treeIndex = 0; treeIndex < model?.trees?.length; treeIndex += 1) {
    const tree = model.trees[treeIndex];
    for (const field of SNOW_RF_FIELD_SPECS) {
      const view = tree?.[field.name];
      const ExpectedView = field.type === "Int32" ? Int32Array : Float64Array;
      if (
        Object.getPrototypeOf(view) !== ExpectedView.prototype ||
        view.byteLength !== view.length * field.elementBytes
      ) {
        throw new Error(`Snow-RF typed ownership region ${treeIndex}/${field.name} is invalid.`);
      }
      if (commonOwner === null) {
        commonOwner = view.buffer;
      } else if (view.buffer !== commonOwner) {
        privateRegionOwnerCount += 1;
      }
      owners.add(view.buffer);
      regionCount += 1;
    }
  }
  const ownership = {
    commonOwner: owners.size === 1,
    ownerAllocationCount: owners.size,
    ownerByteLength: commonOwner?.byteLength ?? 0,
    regionCount,
    privateRegionOwnerCount,
  };
  if (
    ownership.commonOwner !== true ||
    ownership.ownerAllocationCount !== 1 ||
    ownership.ownerByteLength !== SNOW_RF_ASSET_ORACLES.binaryBytes ||
    ownership.regionCount !== PASS16_REGION_COMMITMENT_COUNT ||
    ownership.privateRegionOwnerCount !== 0
  ) {
    throw new Error("Snow-RF typed ownership does not match the one-owner/500-view contract.");
  }
  return Object.freeze(ownership);
}

function buildSnowRfCanonicalCommitmentHolder(model, { onBufferLifecycle } = {}) {
  if (onBufferLifecycle !== undefined && typeof onBufferLifecycle !== "function") {
    throw new Error("Snow-RF canonical buffer lifecycle hook must be a function.");
  }
  if (!Array.isArray(model?.trees) || model.trees.length !== SNOW_RF_MODEL_ORACLES.treeCount) {
    throw new Error("Snow-RF commitments require the exact canonical tree roster.");
  }

  let canonicalModelBinary = Buffer.alloc(SNOW_RF_ASSET_ORACLES.binaryBytes);
  onBufferLifecycle?.(
    Object.freeze({
      event: "allocated",
      byteLength: canonicalModelBinary.byteLength,
    }),
  );
  let cursor = 0;
  let payloadBytes = 0;
  let paddingBytes = 0;
  const regions = [];
  try {
    for (let treeIndex = 0; treeIndex < model.trees.length; treeIndex += 1) {
      const tree = model.trees[treeIndex];
      for (const field of SNOW_RF_FIELD_SPECS) {
        const values = tree?.[field.name];
        if (
          values === null ||
          values === undefined ||
          typeof values.length !== "number" ||
          !Number.isSafeInteger(values.length) ||
          values.length <= 0
        ) {
          throw new Error(`Snow-RF commitment region ${treeIndex}/${field.name} is invalid.`);
        }
        const offset = alignSnowRfAssetOffset(cursor);
        paddingBytes += offset - cursor;
        const byteCount = values.length * field.elementBytes;
        const end = offset + byteCount;
        if (!Number.isSafeInteger(end) || end > canonicalModelBinary.byteLength) {
          throw new Error(`Snow-RF commitment region ${treeIndex}/${field.name} exceeds the canonical binary.`);
        }
        for (let index = 0; index < values.length; index += 1) {
          const target = offset + index * field.elementBytes;
          if (field.type === "Int32") {
            canonicalModelBinary.writeInt32LE(values[index], target);
          } else {
            canonicalModelBinary.writeDoubleLE(values[index], target);
          }
        }
        regions.push(
          Object.freeze({
            treeIndex,
            field: field.name,
            scalarType: field.type,
            elementCount: values.length,
            byteCount,
            sha256: sha256(canonicalModelBinary.subarray(offset, end)),
          }),
        );
        payloadBytes += byteCount;
        cursor = end;
      }
    }

    const canonicalModelBinarySha256 = sha256(canonicalModelBinary);
    if (
      regions.length !== PASS16_REGION_COMMITMENT_COUNT ||
      payloadBytes !== SNOW_RF_ASSET_ORACLES.payloadBytes ||
      paddingBytes !== SNOW_RF_ASSET_ORACLES.paddingBytes ||
      cursor !== SNOW_RF_ASSET_ORACLES.binaryBytes ||
      canonicalModelBinarySha256 !== SNOW_RF_ASSET_ORACLES.binarySha256
    ) {
      throw new Error("Snow-RF canonical commitment differs from the frozen binary oracle.");
    }
    const commitments = deepFreeze({
      encoding: SNOW_RF_COMMITMENT_ENCODING,
      regionCount: regions.length,
      payloadBytes,
      paddingBytes,
      binaryBytes: canonicalModelBinary.byteLength,
      canonicalModelBinarySha256,
      regions,
    });
    let released = false;
    return Object.freeze({
      commitments,
      get released() {
        return released;
      },
      release() {
        if (released) {
          return false;
        }
        const byteLength = canonicalModelBinary.byteLength;
        canonicalModelBinary = null;
        released = true;
        onBufferLifecycle?.(
          Object.freeze({
            event: "released",
            byteLength,
          }),
        );
        return true;
      },
    });
  } catch (error) {
    if (canonicalModelBinary !== null) {
      const byteLength = canonicalModelBinary.byteLength;
      canonicalModelBinary = null;
      onBufferLifecycle?.(
        Object.freeze({
          event: "released-after-error",
          byteLength,
        }),
      );
    }
    throw error;
  }
}

function initializeSnowRfBenchmarkRole({
  role,
  spawnOrdinal = 0,
  processId = process.pid,
  threadId = 0,
  teardownTrial = false,
  loadState = () => loadSnowRfState("conus"),
  onBufferLifecycle,
} = {}) {
  assertReceiptCoordinates({ role, spawnOrdinal, processId, threadId });
  if (typeof teardownTrial !== "boolean") {
    throw new Error("Snow-RF benchmark teardownTrial must be a boolean.");
  }
  if (typeof loadState !== "function") {
    throw new Error("Snow-RF benchmark loadState must be a function.");
  }
  if (teardownTrial && typeof global.gc !== "function") {
    throw new Error("Snow-RF benchmark teardown trials require --expose-gc.");
  }

  const roleReadyStartNs = process.hrtime.bigint();
  let loaded = loadState();
  if (
    loaded === null ||
    typeof loaded !== "object" ||
    loaded.model === null ||
    typeof loaded.model !== "object" ||
    loaded.treatmentState === null ||
    typeof loaded.treatmentState !== "object" ||
    loaded.treatmentState.model !== loaded.model
  ) {
    throw new Error("Snow-RF benchmark role failed to install one published production state.");
  }
  let model = loaded.model;
  let treatmentState = loaded.treatmentState;
  const mode = resolvePass16Mode(treatmentState);
  if (teardownTrial && mode !== "B") {
    throw new Error("Only Snow-RF B benchmark receipts may be teardown trials.");
  }
  const readyLive = captureMemorySnapshot("readyLive");
  const roleReadyEndNs = process.hrtime.bigint();

  const commitmentStartNs = process.hrtime.bigint();
  const stateSnapshot = buildSnowRfAssetStateSnapshot(treatmentState);
  const ownership = inspectTypedAssetOwnership(model, mode);
  let holder = buildSnowRfCanonicalCommitmentHolder(model, { onBufferLifecycle });
  const commitments = holder.commitments;
  const commitmentEndNs = process.hrtime.bigint();
  if (!holder.release()) {
    throw new Error("Snow-RF canonical commitment buffer was already released.");
  }
  holder = null;
  const postCommitmentRelease = captureMemorySnapshot("postCommitmentRelease");

  const memorySnapshots = [...treatmentState.timing.memorySnapshots, readyLive, postCommitmentRelease];
  if (teardownTrial) {
    loaded = null;
    model = null;
    treatmentState = null;
    SNOW_RF_LOAD_STATE_CACHE.clear();
    SNOW_RF_LOAD_FAILURE_CACHE.clear();
    global.gc();
    memorySnapshots.push(captureMemorySnapshot("teardownAfterGc1"));
    global.gc();
    memorySnapshots.push(captureMemorySnapshot("teardownAfterGc2"));
  }

  const timing = deepFreeze({
    loaderTotalNs: stateSnapshot.timing.loaderTotalNs,
    roleReadyNs: (roleReadyEndNs - roleReadyStartNs).toString(),
    receiptCommitmentNs: (commitmentEndNs - commitmentStartNs).toString(),
    roleReady: {
      startNs: roleReadyStartNs.toString(),
      endNs: roleReadyEndNs.toString(),
    },
    loader: stateSnapshot.timing.loader,
    commitment: {
      startNs: commitmentStartNs.toString(),
      endNs: commitmentEndNs.toString(),
    },
    phases: stateSnapshot.timing.phases,
    memorySnapshots,
  });
  validatePass16TimingAndMemory(timing, { mode, teardownTrial });

  return deepFreeze({
    schemaVersion: SNOW_RF_RECEIPT_SCHEMA_VERSION,
    type: SNOW_RF_RECEIPT_TYPE,
    role,
    spawnOrdinal,
    processId,
    threadId,
    state: {
      ...stateSnapshot,
      timing,
      commitments,
      ownership,
    },
  });
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

module.exports = {
  SNOW_RF_COMMITMENT_ENCODING,
  SNOW_RF_STARTUP_RECEIPT_TYPE,
  buildSnowRfCanonicalCommitmentHolder,
  initializeSnowRfBenchmarkRole,
  inspectTypedAssetOwnership,
  resolvePass16Mode,
};
