"use strict";

const PASS16_RECEIPT_SCHEMA_VERSION = 1;
const PASS16_RECEIPT_FRAME_MAGIC = "MVBR";
const PASS16_RECEIPT_FRAME_HEADER_BYTES = 8;
const PASS16_MAX_CANONICAL_RECEIPT_JSON_BYTES = 2 * 1024 * 1024;
const PASS16_MAX_CANONICAL_RECEIPT_FRAME_BYTES =
  PASS16_RECEIPT_FRAME_HEADER_BYTES + PASS16_MAX_CANONICAL_RECEIPT_JSON_BYTES;
const PASS16_MAX_RECEIPT_SIDEBAND_BYTES = 16 * 1024 * 1024;
const PASS16_REGION_COMMITMENT_COUNT = 500;

const PASS16_COMMON_PHASES = Object.freeze(["identityOnlySourceCaptureNs", "modelSourceCaptureNs"]);
const PASS16_A_PHASES = Object.freeze([...PASS16_COMMON_PHASES, "jsonParseNs", "strictCompileNs", "graphValidateNs"]);
const PASS16_B_PHASES = Object.freeze([
  ...PASS16_COMMON_PHASES,
  "manifestReadNs",
  "manifestParseNs",
  "binaryReadNs",
  "manifestValidateNs",
  "binaryHashValidateNs",
  "ownerAllocateCopyNs",
  "layoutMaterializeNs",
  "graphValidateNs",
]);
const PASS16_SOURCE_CAPTURE_NESTED_PHASES = Object.freeze(["sourceReadNs", "sourceHashNs"]);
const PASS16_MEMORY_FIELDS = Object.freeze(["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"]);
const PASS16_B_MEMORY_DELTA_LIMITS = deepFreeze({
  rss: 75_497_472,
  external: 58_720_256,
  arrayBuffers: 58_720_256,
  heapUsed: 4_194_304,
});

const PASS16_RECEIPT_GATE_LIMITS = deepFreeze({
  pairCount: 31,
  minimumBLowerPairs: 24,
  signTailMaximum: { numerator: "1", denominator: "100" },
  loaderB: {
    medianNs: "50000000",
    p95Ns: "55000000",
    maximumNs: "70000000",
  },
  roleReadyB: {
    medianNs: "60000000",
    p95Ns: "75000000",
    maximumNs: "100000000",
  },
});

const PASS16_FULL_GATE_LIMITS = deepFreeze({
  blockCount: 16,
  runsPerMode: 32,
  minimumBLowerBlocks: 12,
  signTailMaximum: { numerator: "1", denominator: "20" },
});

const RECEIPT_SCHEDULE_KEYS = Object.freeze([
  "classification",
  "globalSequence",
  "excludedSequence",
  "retainedSequence",
  "cellIndex",
  "withinCellSequence",
  "pairIndex",
  "withinPairSequence",
  "runtime",
  "runtimePosition",
  "role",
  "rolePosition",
  "mode",
  "assetMode",
  "modePosition",
  "memoryTeardownTrial",
  "parityPreflight",
]);
const FULL_SCHEDULE_KEYS = Object.freeze([
  "classification",
  "globalSequence",
  "excludedSequence",
  "retainedSequence",
  "excludedBlockIndex",
  "blockIndex",
  "withinBlockPosition",
  "mode",
  "assetMode",
]);
const TIMING_RECORD_KEYS = Object.freeze([
  "loaderTotalNs",
  "roleReadyNs",
  "receiptCommitmentNs",
  "roleReady",
  "loader",
  "commitment",
  "phases",
  "memorySnapshots",
]);
const TIMING_VALIDATION_OPTION_KEYS = Object.freeze(["mode", "teardownTrial"]);
const INTERVAL_KEYS = Object.freeze(["startNs", "endNs"]);
const PHASE_KEYS = Object.freeze(["name", "startNs", "endNs", "durationNs", "nestedPhases"]);
const NESTED_INTERVAL_KEYS = Object.freeze(["name", "startNs", "endNs", "durationNs"]);
const MEMORY_SNAPSHOT_KEYS = Object.freeze(["label", "captureNs", ...PASS16_MEMORY_FIELDS]);
const RECEIPT_PAIR_KEYS = Object.freeze([
  "pairIndex",
  "aLoaderTotalNs",
  "aRoleReadyNs",
  "bLoaderTotalNs",
  "bRoleReadyNs",
]);
const FULL_BLOCK_KEYS = Object.freeze(["blockIndex", "aNs", "bNs"]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function fail(message) {
  throw new Error(message);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${label} must be a plain object.`);
  }
}

function ownEnumerableDataKeys(value, label) {
  const keys = Reflect.ownKeys(value);
  const stringKeys = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      fail(`${label} must not contain symbol keys.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      fail(`${label}.${key} must be an enumerable own data property.`);
    }
    stringKeys.push(key);
  }
  return stringKeys;
}

function assertExactKeys(value, expectedKeys, label) {
  assertPlainObject(value, label);
  const actual = ownEnumerableDataKeys(value, label).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} keys must be exactly ${expected.join(", ")}.`);
  }
}

function assertSafeInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
}

function assertDenseArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
  expectedKeys.push("length");
  if (ownKeys.length !== expectedKeys.length || expectedKeys.some((key) => !ownKeys.includes(key))) {
    fail(`${label} must be dense and have no extra own keys.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      fail(`${label}[${index}] must be an enumerable own data property.`);
    }
  }
}

function assetMode(mode) {
  if (mode === "A") {
    return "off";
  }
  if (mode === "B") {
    return "required";
  }
  fail("Unknown Pass 16 mode; expected A or B.");
}

function receiptCellIndex(runtime, role) {
  const key = `${runtime}/${role}`;
  const indexes = {
    "node20/builder-main": 1,
    "node20/frame-worker": 2,
    "node22/builder-main": 3,
    "node22/frame-worker": 4,
  };
  const index = indexes[key];
  if (index === undefined) {
    fail(`Unknown Pass 16 receipt cell ${key}.`);
  }
  return index;
}

function buildReceiptScheduleInternal() {
  const schedule = [];
  let globalSequence = 0;
  let excludedSequence = 0;
  let retainedSequence = 0;
  const excludedCells = [
    ["node20", "builder-main"],
    ["node20", "frame-worker"],
    ["node22", "builder-main"],
    ["node22", "frame-worker"],
  ];
  const excludedModes = ["B", "A", "B", "B", "B", "B"];
  for (const [cellOffset, [runtime, role]] of excludedCells.entries()) {
    for (const [modeOffset, mode] of excludedModes.entries()) {
      globalSequence += 1;
      excludedSequence += 1;
      schedule.push({
        classification: "excluded",
        globalSequence,
        excludedSequence,
        retainedSequence: null,
        cellIndex: cellOffset + 1,
        withinCellSequence: modeOffset + 1,
        pairIndex: null,
        withinPairSequence: null,
        runtime,
        runtimePosition: runtime === "node20" ? 1 : 2,
        role,
        rolePosition: role === "builder-main" ? 1 : 2,
        mode,
        assetMode: assetMode(mode),
        modePosition: modeOffset + 1,
        memoryTeardownTrial: mode === "B",
        parityPreflight: modeOffset < 2,
      });
    }
  }

  for (let pairIndex = 1; pairIndex <= 31; pairIndex += 1) {
    const odd = pairIndex % 2 === 1;
    const runtimes = odd ? ["node20", "node22"] : ["node22", "node20"];
    const roles = odd ? ["builder-main", "frame-worker"] : ["frame-worker", "builder-main"];
    const modes = odd ? ["A", "B"] : ["B", "A"];
    let withinPairSequence = 0;
    for (const [runtimeOffset, runtime] of runtimes.entries()) {
      for (const [roleOffset, role] of roles.entries()) {
        for (const [modeOffset, mode] of modes.entries()) {
          globalSequence += 1;
          retainedSequence += 1;
          withinPairSequence += 1;
          schedule.push({
            classification: "retained",
            globalSequence,
            excludedSequence: null,
            retainedSequence,
            cellIndex: receiptCellIndex(runtime, role),
            withinCellSequence: null,
            pairIndex,
            withinPairSequence,
            runtime,
            runtimePosition: runtimeOffset + 1,
            role,
            rolePosition: roleOffset + 1,
            mode,
            assetMode: assetMode(mode),
            modePosition: modeOffset + 1,
            memoryTeardownTrial: false,
            parityPreflight: false,
          });
        }
      }
    }
  }
  return schedule;
}

function buildFullScheduleInternal() {
  const schedule = [];
  let globalSequence = 0;
  let excludedSequence = 0;
  let retainedSequence = 0;
  const appendBlock = ({ classification, excludedBlockIndex, blockIndex, modes }) => {
    for (const [positionOffset, mode] of modes.entries()) {
      globalSequence += 1;
      if (classification === "excluded") {
        excludedSequence += 1;
      } else {
        retainedSequence += 1;
      }
      schedule.push({
        classification,
        globalSequence,
        excludedSequence: classification === "excluded" ? excludedSequence : null,
        retainedSequence: classification === "retained" ? retainedSequence : null,
        excludedBlockIndex,
        blockIndex,
        withinBlockPosition: positionOffset + 1,
        mode,
        assetMode: assetMode(mode),
      });
    }
  };

  appendBlock({
    classification: "excluded",
    excludedBlockIndex: 1,
    blockIndex: null,
    modes: ["A", "B", "B", "A"],
  });
  appendBlock({
    classification: "excluded",
    excludedBlockIndex: 2,
    blockIndex: null,
    modes: ["B", "A", "A", "B"],
  });
  for (let blockIndex = 1; blockIndex <= 16; blockIndex += 1) {
    appendBlock({
      classification: "retained",
      excludedBlockIndex: null,
      blockIndex,
      modes: blockIndex % 2 === 1 ? ["A", "B", "B", "A"] : ["B", "A", "A", "B"],
    });
  }
  return schedule;
}

function assertScheduleMatches(value, expected, keys, label) {
  assertDenseArray(value, label);
  if (value.length !== expected.length) {
    fail(`${label} must contain exactly ${expected.length} entries.`);
  }
  const seenGlobalSequences = new Set();
  for (let index = 0; index < expected.length; index += 1) {
    const actualEntry = value[index];
    const expectedEntry = expected[index];
    assertExactKeys(actualEntry, keys, `${label}[${index}]`);
    if (seenGlobalSequences.has(actualEntry.globalSequence)) {
      fail(`${label} contains duplicate global sequence ${actualEntry.globalSequence}.`);
    }
    seenGlobalSequences.add(actualEntry.globalSequence);
    for (const key of keys) {
      if (!Object.is(actualEntry[key], expectedEntry[key])) {
        fail(`${label}[${index}].${key} must be ${JSON.stringify(expectedEntry[key])}.`);
      }
    }
  }
  return true;
}

function assertReceiptScheduleInvariants(schedule) {
  if (schedule.length !== 272) {
    fail("Pass 16 receipt schedule must contain 272 entries.");
  }
  const excluded = schedule.filter((entry) => entry.classification === "excluded");
  const retained = schedule.filter((entry) => entry.classification === "retained");
  if (excluded.length !== 24 || retained.length !== 248) {
    fail("Pass 16 receipt schedule must contain 24 excluded and 248 retained entries.");
  }
  const cellCounts = new Map();
  for (const entry of retained) {
    const key = `${entry.runtime}/${entry.role}/${entry.mode}`;
    cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
  }
  for (const runtime of ["node20", "node22"]) {
    for (const role of ["builder-main", "frame-worker"]) {
      for (const mode of ["A", "B"]) {
        if (cellCounts.get(`${runtime}/${role}/${mode}`) !== 31) {
          fail(`Pass 16 retained cell ${runtime}/${role}/${mode} must contain 31 entries.`);
        }
      }
    }
  }
}

function assertFullScheduleInvariants(schedule) {
  if (schedule.length !== 72) {
    fail("Pass 16 full schedule must contain 72 entries.");
  }
  const excluded = schedule.filter((entry) => entry.classification === "excluded");
  const retained = schedule.filter((entry) => entry.classification === "retained");
  if (excluded.length !== 8 || retained.length !== 64) {
    fail("Pass 16 full schedule must contain 8 excluded and 64 retained entries.");
  }
  const totalModes = { A: 0, B: 0 };
  const positionModes = new Map();
  for (const entry of retained) {
    totalModes[entry.mode] += 1;
    const key = `${entry.withinBlockPosition}/${entry.mode}`;
    positionModes.set(key, (positionModes.get(key) ?? 0) + 1);
  }
  if (totalModes.A !== 32 || totalModes.B !== 32) {
    fail("Pass 16 full retained schedule must contain 32 runs per mode.");
  }
  for (let position = 1; position <= 4; position += 1) {
    for (const mode of ["A", "B"]) {
      if (positionModes.get(`${position}/${mode}`) !== 8) {
        fail(`Pass 16 full position ${position}/${mode} must contain 8 retained runs.`);
      }
    }
  }
}

const PASS16_RECEIPT_SCHEDULE = deepFreeze(buildReceiptScheduleInternal());
const PASS16_FULL_SCHEDULE = deepFreeze(buildFullScheduleInternal());
assertReceiptScheduleInvariants(PASS16_RECEIPT_SCHEDULE);
assertFullScheduleInvariants(PASS16_FULL_SCHEDULE);

function buildPass16ReceiptSchedule() {
  return PASS16_RECEIPT_SCHEDULE;
}

function validatePass16ReceiptSchedule(schedule) {
  assertScheduleMatches(schedule, PASS16_RECEIPT_SCHEDULE, RECEIPT_SCHEDULE_KEYS, "Pass 16 receipt schedule");
  assertReceiptScheduleInvariants(schedule);
  return true;
}

function buildPass16FullSchedule() {
  return PASS16_FULL_SCHEDULE;
}

function validatePass16FullSchedule(schedule) {
  assertScheduleMatches(schedule, PASS16_FULL_SCHEDULE, FULL_SCHEDULE_KEYS, "Pass 16 full schedule");
  assertFullScheduleInvariants(schedule);
  return true;
}

function parseCanonicalNonnegativeNs(value, label = "nanoseconds") {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(`${label} must be a canonical nonnegative decimal string.`);
  }
  return BigInt(value);
}

function parseInterval(value, label) {
  assertExactKeys(value, INTERVAL_KEYS, label);
  const startNs = parseCanonicalNonnegativeNs(value.startNs, `${label}.startNs`);
  const endNs = parseCanonicalNonnegativeNs(value.endNs, `${label}.endNs`);
  if (endNs < startNs) {
    fail(`${label}.endNs must be greater than or equal to startNs.`);
  }
  return { startNs, endNs };
}

function parseNamedInterval(value, expectedName, label, keys) {
  assertExactKeys(value, keys, label);
  if (value.name !== expectedName) {
    fail(`${label}.name must be ${expectedName}.`);
  }
  const startNs = parseCanonicalNonnegativeNs(value.startNs, `${label}.startNs`);
  const endNs = parseCanonicalNonnegativeNs(value.endNs, `${label}.endNs`);
  const durationNs = parseCanonicalNonnegativeNs(value.durationNs, `${label}.durationNs`);
  if (endNs < startNs) {
    fail(`${label}.endNs must be greater than or equal to startNs.`);
  }
  if (durationNs !== endNs - startNs) {
    fail(`${label}.durationNs must equal endNs - startNs.`);
  }
  return { startNs, endNs, durationNs };
}

function pass16PhaseRoster(mode) {
  if (mode === "A") {
    return PASS16_A_PHASES;
  }
  if (mode === "B") {
    return PASS16_B_PHASES;
  }
  fail("Pass 16 timing mode must be A or B.");
}

function pass16MemoryLabels(mode, teardownTrial = false) {
  if (typeof teardownTrial !== "boolean") {
    fail("Pass 16 teardownTrial must be a boolean.");
  }
  if (teardownTrial && mode !== "B") {
    fail("Only Pass 16 B receipts may be teardown trials.");
  }
  const labels = [
    "before",
    ...pass16PhaseRoster(mode).map((phase) => `after:${phase}`),
    "readyLive",
    "postCommitmentRelease",
  ];
  if (teardownTrial) {
    labels.push("teardownAfterGc1", "teardownAfterGc2");
  }
  return Object.freeze(labels);
}

function validateMemorySnapshots(snapshots, mode, teardownTrial, { roleReady, loader, commitment, phaseIntervals }) {
  assertDenseArray(snapshots, "Pass 16 memorySnapshots");
  const expectedLabels = pass16MemoryLabels(mode, teardownTrial);
  if (snapshots.length !== expectedLabels.length) {
    fail(`Pass 16 memorySnapshots must contain exactly ${expectedLabels.length} entries.`);
  }
  const seen = new Set();
  let previousCaptureNs = null;
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    const label = `Pass 16 memorySnapshots[${index}]`;
    assertExactKeys(snapshot, MEMORY_SNAPSHOT_KEYS, label);
    if (seen.has(snapshot.label)) {
      fail(`Pass 16 memorySnapshots contains a duplicate label at index ${index}.`);
    }
    seen.add(snapshot.label);
    if (snapshot.label !== expectedLabels[index]) {
      fail(`${label}.label must be ${expectedLabels[index]}.`);
    }
    const captureNs = parseCanonicalNonnegativeNs(snapshot.captureNs, `${label}.captureNs`);
    if (previousCaptureNs !== null && captureNs < previousCaptureNs) {
      fail("Pass 16 memorySnapshots capture ticks must be ordered.");
    }
    previousCaptureNs = captureNs;
    if (snapshot.label === "before") {
      if (captureNs < roleReady.startNs || captureNs > loader.startNs) {
        fail("Pass 16 before memory snapshot must be between roleReady start and loader start.");
      }
    } else if (snapshot.label.startsWith("after:")) {
      const phaseName = snapshot.label.slice("after:".length);
      const phase = phaseIntervals.get(phaseName);
      if (phase === undefined || captureNs < phase.startNs || captureNs > phase.endNs) {
        fail(`${label} must be captured inside its named phase boundary.`);
      }
    } else if (snapshot.label === "readyLive") {
      if (captureNs < loader.endNs || captureNs > roleReady.endNs) {
        fail("Pass 16 readyLive memory snapshot must be between loader end and roleReady end.");
      }
    } else if (snapshot.label === "postCommitmentRelease") {
      if (captureNs < commitment.endNs) {
        fail("Pass 16 postCommitmentRelease snapshot must follow commitment end.");
      }
    } else if (captureNs < commitment.endNs) {
      fail(`${label} must follow commitment end.`);
    }
    for (const field of PASS16_MEMORY_FIELDS) {
      assertSafeInteger(snapshot[field], `${label}.${field}`);
    }
  }

  const phasePeakLabels = new Set(expectedLabels.slice(0, expectedLabels.indexOf("readyLive") + 1));
  const phasePeak = Object.fromEntries(PASS16_MEMORY_FIELDS.map((field) => [field, 0]));
  for (const snapshot of snapshots) {
    if (!phasePeakLabels.has(snapshot.label)) {
      continue;
    }
    for (const field of PASS16_MEMORY_FIELDS) {
      phasePeak[field] = Math.max(phasePeak[field], snapshot[field]);
    }
  }
  const before = snapshots[0];
  const phasePeakMinusBefore = Object.fromEntries(
    PASS16_MEMORY_FIELDS.map((field) => [field, phasePeak[field] - before[field]]),
  );
  return {
    labels: expectedLabels,
    phasePeak: Object.freeze(phasePeak),
    phasePeakMinusBefore: Object.freeze(phasePeakMinusBefore),
  };
}

function validatePass16PhasePartition(phases, mode, loader, loaderTotalNs) {
  const expectedPhases = pass16PhaseRoster(mode);
  assertDenseArray(phases, `Pass 16 ${mode} phases`);
  if (phases.length !== expectedPhases.length) {
    fail(`Pass 16 ${mode} timing must contain exactly ${expectedPhases.length} phases.`);
  }
  const phaseIntervals = [];
  for (let index = 0; index < expectedPhases.length; index += 1) {
    const phase = phases[index];
    const label = `Pass 16 phases[${index}]`;
    const phaseInterval = parseNamedInterval(phase, expectedPhases[index], label, PHASE_KEYS);
    assertDenseArray(phase.nestedPhases, `${label}.nestedPhases`);
    const expectedNested = index < PASS16_COMMON_PHASES.length ? PASS16_SOURCE_CAPTURE_NESTED_PHASES : [];
    if (phase.nestedPhases.length !== expectedNested.length) {
      fail(`${label}.nestedPhases must contain exactly ${expectedNested.length} intervals.`);
    }
    const nestedIntervals = phase.nestedPhases.map((nested, nestedIndex) =>
      parseNamedInterval(
        nested,
        expectedNested[nestedIndex],
        `${label}.nestedPhases[${nestedIndex}]`,
        NESTED_INTERVAL_KEYS,
      ),
    );
    if (
      nestedIntervals.length > 0 &&
      (nestedIntervals[0].startNs < phaseInterval.startNs || nestedIntervals.at(-1).endNs > phaseInterval.endNs)
    ) {
      fail(`${label}.nestedPhases intervals must be contained by their parent phase.`);
    }
    for (let nestedIndex = 0; nestedIndex < nestedIntervals.length - 1; nestedIndex += 1) {
      if (nestedIntervals[nestedIndex].endNs > nestedIntervals[nestedIndex + 1].startNs) {
        fail(`${label}.nestedPhases intervals must be ordered and nonoverlapping.`);
      }
    }
    phaseIntervals.push(phaseInterval);
  }
  if (phaseIntervals[0].startNs !== loader.startNs) {
    fail("Pass 16 first phase must start at loader.startNs.");
  }
  for (let index = 0; index < phaseIntervals.length - 1; index += 1) {
    if (phaseIntervals[index].endNs !== phaseIntervals[index + 1].startNs) {
      fail("Pass 16 loader phases must be gapless and ordered.");
    }
  }
  if (phaseIntervals.at(-1).endNs !== loader.endNs) {
    fail("Pass 16 final phase must end at loader.endNs.");
  }
  const phaseDurationSum = phaseIntervals.reduce((sum, phase) => sum + phase.durationNs, 0n);
  if (phaseDurationSum !== loaderTotalNs) {
    fail("Pass 16 loaderTotalNs must equal the sum of top-level phase durations.");
  }
  return {
    expectedPhases,
    phaseIntervals,
  };
}

function validatePass16TimingAndMemory(timing, options) {
  assertExactKeys(timing, TIMING_RECORD_KEYS, "Pass 16 timing record");
  assertExactKeys(options, TIMING_VALIDATION_OPTION_KEYS, "Pass 16 timing validation options");
  if (options.mode !== "A" && options.mode !== "B") {
    fail("Pass 16 timing record mode must be A or B.");
  }
  if (typeof options.teardownTrial !== "boolean") {
    fail("Pass 16 timing record teardownTrial must be a boolean.");
  }
  if (options.teardownTrial && options.mode !== "B") {
    fail("Only Pass 16 B timing records may be teardown trials.");
  }
  const roleReady = parseInterval(timing.roleReady, "Pass 16 roleReady");
  const loader = parseInterval(timing.loader, "Pass 16 loader");
  const commitment = parseInterval(timing.commitment, "Pass 16 commitment");
  const loaderTotalNs = parseCanonicalNonnegativeNs(timing.loaderTotalNs, "Pass 16 loaderTotalNs");
  const roleReadyNs = parseCanonicalNonnegativeNs(timing.roleReadyNs, "Pass 16 roleReadyNs");
  const receiptCommitmentNs = parseCanonicalNonnegativeNs(timing.receiptCommitmentNs, "Pass 16 receiptCommitmentNs");
  if (loaderTotalNs !== loader.endNs - loader.startNs) {
    fail("Pass 16 loaderTotalNs must equal loader.endNs - loader.startNs.");
  }
  if (roleReadyNs !== roleReady.endNs - roleReady.startNs) {
    fail("Pass 16 roleReadyNs must equal roleReady.endNs - roleReady.startNs.");
  }
  if (receiptCommitmentNs !== commitment.endNs - commitment.startNs) {
    fail("Pass 16 receiptCommitmentNs must equal commitment.endNs - commitment.startNs.");
  }
  if (roleReady.startNs > loader.startNs || roleReady.endNs < loader.endNs) {
    fail("Pass 16 roleReady interval must enclose the loader interval.");
  }
  if (commitment.startNs < roleReady.endNs) {
    fail("Pass 16 commitment must begin after roleReady has stopped.");
  }

  const { expectedPhases, phaseIntervals } = validatePass16PhasePartition(
    timing.phases,
    options.mode,
    loader,
    loaderTotalNs,
  );
  const memory = validateMemorySnapshots(timing.memorySnapshots, options.mode, options.teardownTrial, {
    roleReady,
    loader,
    commitment,
    phaseIntervals: new Map(expectedPhases.map((phaseName, index) => [phaseName, phaseIntervals[index]])),
  });
  const memoryGates =
    options.mode === "B" && !options.teardownTrial
      ? Object.fromEntries(
          Object.entries(PASS16_B_MEMORY_DELTA_LIMITS).map(([field, maximum]) => [
            field,
            memory.phasePeakMinusBefore[field] <= maximum,
          ]),
        )
      : null;
  return deepFreeze({
    mode: options.mode,
    loaderTotalNs: loaderTotalNs.toString(),
    roleReadyNs: roleReadyNs.toString(),
    receiptCommitmentNs: receiptCommitmentNs.toString(),
    memory: {
      ...memory,
      gates: memoryGates,
      passed: memoryGates === null ? null : Object.values(memoryGates).every(Boolean),
    },
  });
}

function assertBigIntSamples(samples, label) {
  assertDenseArray(samples, label);
  if (samples.length === 0) {
    fail(`${label} must be a nonempty array.`);
  }
  for (let index = 0; index < samples.length; index += 1) {
    if (typeof samples[index] !== "bigint" || samples[index] < 0n) {
      fail(`${label}[${index}] must be a nonnegative BigInt.`);
    }
  }
}

function nearestRankBigInt(samples, numerator, denominator) {
  assertBigIntSamples(samples, "nearest-rank samples");
  assertSafeInteger(numerator, "nearest-rank numerator", { minimum: 1 });
  assertSafeInteger(denominator, "nearest-rank denominator", { minimum: 1 });
  if (numerator > denominator) {
    fail("nearest-rank numerator must be no greater than denominator.");
  }
  const sorted = [...samples].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const rank = (BigInt(numerator) * BigInt(sorted.length) + BigInt(denominator) - 1n) / BigInt(denominator);
  return sorted[Number(rank - 1n)];
}

function parseCanonicalNsArray(values, label, expectedLength) {
  assertDenseArray(values, label);
  if (expectedLength !== undefined && values.length !== expectedLength) {
    fail(`${label} must contain exactly ${expectedLength} entries.`);
  }
  if (values.length === 0) {
    fail(`${label} must not be empty.`);
  }
  return values.map((value, index) => parseCanonicalNonnegativeNs(value, `${label}[${index}]`));
}

function sumCanonicalNs(values, label = "nanosecond values") {
  return parseCanonicalNsArray(values, label).reduce((sum, value) => sum + value, 0n);
}

function compareCanonicalNsSums(left, right) {
  const leftSum = sumCanonicalNs(left, "left nanosecond values");
  const rightSum = sumCanonicalNs(right, "right nanosecond values");
  return leftSum < rightSum ? -1 : leftSum > rightSum ? 1 : 0;
}

function binomialCoefficient(n, k) {
  const reducedK = Math.min(k, n - k);
  let value = 1n;
  for (let index = 1; index <= reducedK; index += 1) {
    value = (value * BigInt(n - reducedK + index)) / BigInt(index);
  }
  return value;
}

function exactOneSidedSignTail(successes, trials) {
  assertSafeInteger(trials, "sign-tail trials", { minimum: 1 });
  assertSafeInteger(successes, "sign-tail successes");
  if (trials > 64) {
    fail("sign-tail trials must be no greater than 64.");
  }
  if (successes > trials) {
    fail("sign-tail successes must be no greater than trials.");
  }
  let numerator = 0n;
  for (let count = successes; count <= trials; count += 1) {
    numerator += binomialCoefficient(trials, count);
  }
  return Object.freeze({
    numerator,
    denominator: 1n << BigInt(trials),
  });
}

function fractionAtMost(fraction, maximum) {
  const maximumNumerator = parseCanonicalNonnegativeNs(maximum.numerator, "fraction maximum numerator");
  const maximumDenominator = parseCanonicalNonnegativeNs(maximum.denominator, "fraction maximum denominator");
  if (maximumDenominator === 0n) {
    fail("fraction maximum denominator must be positive.");
  }
  return fraction.numerator * maximumDenominator <= maximumNumerator * fraction.denominator;
}

function summarizeBigIntSamples(samples) {
  assertBigIntSamples(samples, "summary samples");
  return Object.freeze({
    count: samples.length,
    medianNs: nearestRankBigInt(samples, 1, 2).toString(),
    p95Ns: nearestRankBigInt(samples, 95, 100).toString(),
    maximumNs: samples.reduce((maximum, value) => (value > maximum ? value : maximum), 0n).toString(),
  });
}

function parseReceiptPairs(pairs) {
  assertDenseArray(pairs, "Pass 16 receipt pairs");
  if (pairs.length !== PASS16_RECEIPT_GATE_LIMITS.pairCount) {
    fail(`Pass 16 receipt pairs must contain exactly ${PASS16_RECEIPT_GATE_LIMITS.pairCount} entries.`);
  }
  return pairs.map((pair, index) => {
    const label = `Pass 16 receipt pairs[${index}]`;
    assertExactKeys(pair, RECEIPT_PAIR_KEYS, label);
    if (pair.pairIndex !== index + 1) {
      fail(`${label}.pairIndex must be ${index + 1}.`);
    }
    return {
      pairIndex: pair.pairIndex,
      aLoaderTotalNs: parseCanonicalNonnegativeNs(pair.aLoaderTotalNs, `${label}.aLoaderTotalNs`),
      aRoleReadyNs: parseCanonicalNonnegativeNs(pair.aRoleReadyNs, `${label}.aRoleReadyNs`),
      bLoaderTotalNs: parseCanonicalNonnegativeNs(pair.bLoaderTotalNs, `${label}.bLoaderTotalNs`),
      bRoleReadyNs: parseCanonicalNonnegativeNs(pair.bRoleReadyNs, `${label}.bRoleReadyNs`),
    };
  });
}

function summarizePass16ReceiptCellGate(pairs) {
  const parsed = parseReceiptPairs(pairs);
  const aRoleReady = parsed.map((pair) => pair.aRoleReadyNs);
  const bRoleReady = parsed.map((pair) => pair.bRoleReadyNs);
  const bLoader = parsed.map((pair) => pair.bLoaderTotalNs);
  const bLowerPairs = parsed.filter((pair) => pair.bRoleReadyNs < pair.aRoleReadyNs).length;
  const signTail = exactOneSidedSignTail(bLowerPairs, parsed.length);
  const aRoleSummary = summarizeBigIntSamples(aRoleReady);
  const bRoleSummary = summarizeBigIntSamples(bRoleReady);
  const bLoaderSummary = summarizeBigIntSamples(bLoader);
  const gates = {
    minimumBLowerPairs: bLowerPairs >= PASS16_RECEIPT_GATE_LIMITS.minimumBLowerPairs,
    signTail: fractionAtMost(signTail, PASS16_RECEIPT_GATE_LIMITS.signTailMaximum),
    roleReadyMedian: BigInt(bRoleSummary.medianNs) <= BigInt(aRoleSummary.medianNs),
    roleReadyP95: BigInt(bRoleSummary.p95Ns) <= BigInt(aRoleSummary.p95Ns),
    loaderBMedian: BigInt(bLoaderSummary.medianNs) <= BigInt(PASS16_RECEIPT_GATE_LIMITS.loaderB.medianNs),
    loaderBP95: BigInt(bLoaderSummary.p95Ns) <= BigInt(PASS16_RECEIPT_GATE_LIMITS.loaderB.p95Ns),
    loaderBMaximum: BigInt(bLoaderSummary.maximumNs) <= BigInt(PASS16_RECEIPT_GATE_LIMITS.loaderB.maximumNs),
    roleReadyBMedian: BigInt(bRoleSummary.medianNs) <= BigInt(PASS16_RECEIPT_GATE_LIMITS.roleReadyB.medianNs),
    roleReadyBP95: BigInt(bRoleSummary.p95Ns) <= BigInt(PASS16_RECEIPT_GATE_LIMITS.roleReadyB.p95Ns),
    roleReadyBMaximum: BigInt(bRoleSummary.maximumNs) <= BigInt(PASS16_RECEIPT_GATE_LIMITS.roleReadyB.maximumNs),
  };
  return deepFreeze({
    pairCount: parsed.length,
    bLowerPairs,
    signTail: {
      successes: bLowerPairs,
      trials: parsed.length,
      numerator: signTail.numerator.toString(),
      denominator: signTail.denominator.toString(),
    },
    roleReady: {
      A: aRoleSummary,
      B: bRoleSummary,
    },
    loaderB: bLoaderSummary,
    gates,
    passed: Object.values(gates).every(Boolean),
  });
}

function parseFullBlocks(blocks) {
  assertDenseArray(blocks, "Pass 16 full blocks");
  if (blocks.length !== PASS16_FULL_GATE_LIMITS.blockCount) {
    fail(`Pass 16 full blocks must contain exactly ${PASS16_FULL_GATE_LIMITS.blockCount} entries.`);
  }
  return blocks.map((block, index) => {
    const label = `Pass 16 full blocks[${index}]`;
    assertExactKeys(block, FULL_BLOCK_KEYS, label);
    if (block.blockIndex !== index + 1) {
      fail(`${label}.blockIndex must be ${index + 1}.`);
    }
    return {
      blockIndex: block.blockIndex,
      aNs: parseCanonicalNsArray(block.aNs, `${label}.aNs`, 2),
      bNs: parseCanonicalNsArray(block.bNs, `${label}.bNs`, 2),
    };
  });
}

function summarizePass16FullGate(blocks) {
  const parsed = parseFullBlocks(blocks);
  const aSamples = parsed.flatMap((block) => block.aNs);
  const bSamples = parsed.flatMap((block) => block.bNs);
  const blockComparisons = parsed.map((block) => {
    const aSumNs = block.aNs[0] + block.aNs[1];
    const bSumNs = block.bNs[0] + block.bNs[1];
    return Object.freeze({
      blockIndex: block.blockIndex,
      aSumNs: aSumNs.toString(),
      bSumNs: bSumNs.toString(),
      bLower: bSumNs < aSumNs,
    });
  });
  const bLowerBlocks = blockComparisons.filter((block) => block.bLower).length;
  const signTail = exactOneSidedSignTail(bLowerBlocks, parsed.length);
  const aSummary = summarizeBigIntSamples(aSamples);
  const bSummary = summarizeBigIntSamples(bSamples);
  const gates = {
    minimumBLowerBlocks: bLowerBlocks >= PASS16_FULL_GATE_LIMITS.minimumBLowerBlocks,
    signTail: fractionAtMost(signTail, PASS16_FULL_GATE_LIMITS.signTailMaximum),
    median: BigInt(bSummary.medianNs) <= BigInt(aSummary.medianNs),
    p95: BigInt(bSummary.p95Ns) <= BigInt(aSummary.p95Ns),
  };
  return deepFreeze({
    blockCount: parsed.length,
    runsPerMode: aSamples.length,
    bLowerBlocks,
    signTail: {
      successes: bLowerBlocks,
      trials: parsed.length,
      numerator: signTail.numerator.toString(),
      denominator: signTail.denominator.toString(),
    },
    statistics: {
      A: aSummary,
      B: bSummary,
    },
    blockComparisons,
    gates,
    passed: Object.values(gates).every(Boolean),
  });
}

function normalizeCanonicalJson(value, label, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      fail(`${label} contains a noncanonical JSON number.`);
    }
    return value;
  }
  if (typeof value !== "object") {
    fail(`${label} contains a value that JSON cannot represent exactly.`);
  }
  if (seen.has(value)) {
    fail(`${label} contains a cycle.`);
  }
  seen.add(value);
  let normalized;
  if (Array.isArray(value)) {
    assertDenseArray(value, `${label} array`);
    normalized = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return normalizeCanonicalJson(descriptor.value, `${label}[${index}]`, seen);
    });
  } else {
    assertPlainObject(value, label);
    normalized = Object.create(null);
    for (const key of ownEnumerableDataKeys(value, label).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      normalized[key] = normalizeCanonicalJson(descriptor.value, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
  return normalized;
}

function serializePass16CanonicalReceiptJson(receipt) {
  assertPlainObject(receipt, "Pass 16 receipt");
  const normalized = normalizeCanonicalJson(receipt, "Pass 16 receipt", new Set());
  const bytes = Buffer.from(JSON.stringify(normalized), "utf8");
  if (bytes.byteLength > PASS16_MAX_CANONICAL_RECEIPT_JSON_BYTES) {
    fail(`Pass 16 canonical receipt JSON exceeds ${PASS16_MAX_CANONICAL_RECEIPT_JSON_BYTES} bytes.`);
  }
  return bytes;
}

function measurePass16CanonicalReceiptFrame(receipt) {
  const jsonBytes = serializePass16CanonicalReceiptJson(receipt).byteLength;
  const frameBytes = PASS16_RECEIPT_FRAME_HEADER_BYTES + jsonBytes;
  if (frameBytes > PASS16_MAX_CANONICAL_RECEIPT_FRAME_BYTES) {
    fail(`Pass 16 canonical receipt frame exceeds ${PASS16_MAX_CANONICAL_RECEIPT_FRAME_BYTES} bytes.`);
  }
  return Object.freeze({ jsonBytes, frameBytes });
}

module.exports = {
  PASS16_A_PHASES,
  PASS16_B_MEMORY_DELTA_LIMITS,
  PASS16_B_PHASES,
  PASS16_COMMON_PHASES,
  PASS16_FULL_GATE_LIMITS,
  PASS16_MAX_CANONICAL_RECEIPT_FRAME_BYTES,
  PASS16_MAX_CANONICAL_RECEIPT_JSON_BYTES,
  PASS16_MAX_RECEIPT_SIDEBAND_BYTES,
  PASS16_MEMORY_FIELDS,
  PASS16_RECEIPT_FRAME_HEADER_BYTES,
  PASS16_RECEIPT_FRAME_MAGIC,
  PASS16_RECEIPT_GATE_LIMITS,
  PASS16_RECEIPT_SCHEMA_VERSION,
  PASS16_REGION_COMMITMENT_COUNT,
  PASS16_SOURCE_CAPTURE_NESTED_PHASES,
  buildPass16FullSchedule,
  buildPass16ReceiptSchedule,
  compareCanonicalNsSums,
  exactOneSidedSignTail,
  measurePass16CanonicalReceiptFrame,
  nearestRankBigInt,
  parseCanonicalNonnegativeNs,
  pass16MemoryLabels,
  serializePass16CanonicalReceiptJson,
  sumCanonicalNs,
  summarizePass16FullGate,
  summarizePass16ReceiptCellGate,
  validatePass16FullSchedule,
  validatePass16ReceiptSchedule,
  validatePass16TimingAndMemory,
};
