"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
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
} = require("../scripts/lib/noaa-beta/snow-rf-benchmark-contract");

function clone(value) {
  return structuredClone(value);
}

function interval(startNs, endNs) {
  return {
    startNs: startNs.toString(),
    endNs: endNs.toString(),
  };
}

function namedInterval(name, startNs, endNs) {
  return {
    name,
    ...interval(startNs, endNs),
    durationNs: (endNs - startNs).toString(),
  };
}

function timingFixture(mode, { teardownTrial = false, origin = 100n } = {}) {
  const phaseNames = mode === "A" ? PASS16_A_PHASES : PASS16_B_PHASES;
  const loaderStart = origin + 10n;
  const phases = phaseNames.map((name, index) => {
    const startNs = loaderStart + BigInt(index * 10);
    const endNs = startNs + 10n;
    return {
      ...namedInterval(name, startNs, endNs),
      nestedPhases:
        index < 2
          ? [
              namedInterval("sourceReadNs", startNs + 2n, startNs + 5n),
              namedInterval("sourceHashNs", startNs + 6n, startNs + 8n),
            ]
          : [],
    };
  });
  const loaderEnd = phases.at(-1).endNs;
  const roleReady = interval(origin, BigInt(loaderEnd) + 10n);
  const loader = interval(loaderStart, BigInt(loaderEnd));
  const commitment = interval(BigInt(roleReady.endNs), BigInt(roleReady.endNs) + 10n);
  const labels = pass16MemoryLabels(mode, teardownTrial);
  const phaseByName = new Map(phases.map((phase) => [phase.name, phase]));
  const memorySnapshots = labels.map((label, index) => {
    let captureNs;
    if (label === "before") {
      captureNs = loader.startNs;
    } else if (label.startsWith("after:")) {
      captureNs = phaseByName.get(label.slice("after:".length)).endNs;
    } else if (label === "readyLive") {
      captureNs = roleReady.endNs;
    } else if (label === "postCommitmentRelease") {
      captureNs = commitment.endNs;
    } else {
      captureNs = (BigInt(commitment.endNs) + BigInt(index)).toString();
    }
    const bytes = 1_000 + index * 10;
    return {
      label,
      captureNs,
      rss: bytes,
      heapTotal: bytes + 1,
      heapUsed: bytes + 2,
      external: bytes + 3,
      arrayBuffers: bytes + 4,
    };
  });
  const timing = {
    loaderTotalNs: (BigInt(loader.endNs) - BigInt(loader.startNs)).toString(),
    roleReadyNs: (BigInt(roleReady.endNs) - BigInt(roleReady.startNs)).toString(),
    receiptCommitmentNs: (BigInt(commitment.endNs) - BigInt(commitment.startNs)).toString(),
    roleReady,
    loader,
    commitment,
    phases,
    memorySnapshots,
  };
  return {
    mode,
    teardownTrial,
    timing,
  };
}

function validateTimingFixture(fixture) {
  return validatePass16TimingAndMemory(fixture.timing, {
    mode: fixture.mode,
    teardownTrial: fixture.teardownTrial,
  });
}

function mutateAndReject(base, mutations, validator) {
  for (const [name, mutate] of Object.entries(mutations)) {
    const candidate = clone(base);
    mutate(candidate);
    assert.throws(() => validator(candidate), undefined, name);
  }
}

test("contract constants independently match the frozen Pass 16 literals", () => {
  assert.equal(PASS16_RECEIPT_SCHEMA_VERSION, 1);
  assert.deepEqual(PASS16_COMMON_PHASES, ["identityOnlySourceCaptureNs", "modelSourceCaptureNs"]);
  assert.deepEqual(PASS16_A_PHASES, [
    "identityOnlySourceCaptureNs",
    "modelSourceCaptureNs",
    "jsonParseNs",
    "strictCompileNs",
    "graphValidateNs",
  ]);
  assert.deepEqual(PASS16_B_PHASES, [
    "identityOnlySourceCaptureNs",
    "modelSourceCaptureNs",
    "manifestReadNs",
    "manifestParseNs",
    "binaryReadNs",
    "manifestValidateNs",
    "binaryHashValidateNs",
    "ownerAllocateCopyNs",
    "layoutMaterializeNs",
    "graphValidateNs",
  ]);
  assert.deepEqual(PASS16_SOURCE_CAPTURE_NESTED_PHASES, ["sourceReadNs", "sourceHashNs"]);
  assert.deepEqual(pass16MemoryLabels("A"), [
    "before",
    ...PASS16_A_PHASES.map((phase) => `after:${phase}`),
    "readyLive",
    "postCommitmentRelease",
  ]);
  assert.deepEqual(pass16MemoryLabels("B"), [
    "before",
    ...PASS16_B_PHASES.map((phase) => `after:${phase}`),
    "readyLive",
    "postCommitmentRelease",
  ]);
  assert.deepEqual(PASS16_B_MEMORY_DELTA_LIMITS, {
    rss: 75_497_472,
    external: 58_720_256,
    arrayBuffers: 58_720_256,
    heapUsed: 4_194_304,
  });
  assert.deepEqual(PASS16_RECEIPT_GATE_LIMITS, {
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
  assert.deepEqual(PASS16_FULL_GATE_LIMITS, {
    blockCount: 16,
    runsPerMode: 32,
    minimumBLowerBlocks: 12,
    signTailMaximum: { numerator: "1", denominator: "20" },
  });
  assert.equal(PASS16_MAX_CANONICAL_RECEIPT_JSON_BYTES, 2_097_152);
  assert.equal(PASS16_MAX_CANONICAL_RECEIPT_FRAME_BYTES, 2_097_160);
  assert.equal(PASS16_MAX_RECEIPT_SIDEBAND_BYTES, 16_777_216);
});

test("receipt schedule freezes the exact 24 excluded and 248 retained order", () => {
  const schedule = buildPass16ReceiptSchedule();
  assert.equal(schedule.length, 272);
  assert.equal(Object.isFrozen(schedule), true);
  assert.equal(schedule.every(Object.isFrozen), true);
  assert.deepEqual(
    schedule.slice(0, 24).map((entry) => [entry.runtime, entry.role, entry.mode]),
    [
      ...["B", "A", "B", "B", "B", "B"].map((mode) => ["node20", "builder-main", mode]),
      ...["B", "A", "B", "B", "B", "B"].map((mode) => ["node20", "frame-worker", mode]),
      ...["B", "A", "B", "B", "B", "B"].map((mode) => ["node22", "builder-main", mode]),
      ...["B", "A", "B", "B", "B", "B"].map((mode) => ["node22", "frame-worker", mode]),
    ],
  );
  const retained = schedule.slice(24);
  assert.deepEqual(
    retained.slice(0, 8).map((entry) => [entry.runtime, entry.role, entry.mode]),
    [
      ["node20", "builder-main", "A"],
      ["node20", "builder-main", "B"],
      ["node20", "frame-worker", "A"],
      ["node20", "frame-worker", "B"],
      ["node22", "builder-main", "A"],
      ["node22", "builder-main", "B"],
      ["node22", "frame-worker", "A"],
      ["node22", "frame-worker", "B"],
    ],
  );
  assert.deepEqual(
    retained.slice(8, 16).map((entry) => [entry.runtime, entry.role, entry.mode]),
    [
      ["node22", "frame-worker", "B"],
      ["node22", "frame-worker", "A"],
      ["node22", "builder-main", "B"],
      ["node22", "builder-main", "A"],
      ["node20", "frame-worker", "B"],
      ["node20", "frame-worker", "A"],
      ["node20", "builder-main", "B"],
      ["node20", "builder-main", "A"],
    ],
  );
  assert.equal(retained.at(-1).globalSequence, 272);
  assert.equal(retained.at(-1).retainedSequence, 248);

  const counts = new Map();
  for (const entry of retained) {
    const key = `${entry.runtime}/${entry.role}/${entry.mode}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const runtime of ["node20", "node22"]) {
    for (const role of ["builder-main", "frame-worker"]) {
      assert.equal(counts.get(`${runtime}/${role}/A`), 31);
      assert.equal(counts.get(`${runtime}/${role}/B`), 31);
    }
  }
  assert.equal(validatePass16ReceiptSchedule(schedule), true);
});

test("receipt schedule validator rejects every field mutation and structural deviation", () => {
  const schedule = buildPass16ReceiptSchedule();
  const representativeIndexes = [0, 1, 24, 32, 271];
  for (const representativeIndex of representativeIndexes) {
    for (const key of Object.keys(schedule[representativeIndex])) {
      const mutated = clone(schedule);
      const original = mutated[representativeIndex][key];
      mutated[representativeIndex][key] =
        typeof original === "boolean"
          ? !original
          : typeof original === "number"
            ? original + 1
            : original === null
              ? 0
              : `${original}-mutated`;
      assert.throws(() => validatePass16ReceiptSchedule(mutated), undefined, `entry ${representativeIndex} key ${key}`);
    }
  }

  mutateAndReject(
    schedule,
    {
      "missing entry": (value) => value.pop(),
      "extra warmup": (value) => value.push(clone(value.at(-1))),
      "reordered entries": (value) => ([value[24], value[25]] = [value[25], value[24]]),
      "duplicate entry": (value) => value.splice(25, 1, clone(value[24])),
      "sparse array": (value) => delete value[3],
      "array property": (value) => (value.extra = true),
      "missing record key": (value) => delete value[24].modePosition,
      "extra record key": (value) => (value[24].unexpected = true),
      "primitive record": (value) => value.splice(24, 1, "invalid"),
    },
    validatePass16ReceiptSchedule,
  );

  const symbolExtra = clone(schedule);
  symbolExtra[24][Symbol("extra")] = true;
  assert.throws(() => validatePass16ReceiptSchedule(symbolExtra));

  const nonenumerableExtra = clone(schedule);
  Object.defineProperty(nonenumerableExtra[24], "hidden", { value: true });
  assert.throws(() => validatePass16ReceiptSchedule(nonenumerableExtra));

  let getterReads = 0;
  const accessorRecord = clone(schedule);
  Object.defineProperty(accessorRecord[24], "mode", {
    enumerable: true,
    get() {
      getterReads += 1;
      return "A";
    },
  });
  assert.throws(() => validatePass16ReceiptSchedule(accessorRecord));
  assert.equal(getterReads, 0, "validation must reject accessors without invoking them");

  const accessorArray = clone(schedule);
  const originalEntry = accessorArray[24];
  Object.defineProperty(accessorArray, "24", {
    enumerable: true,
    get() {
      getterReads += 1;
      return originalEntry;
    },
  });
  assert.throws(() => validatePass16ReceiptSchedule(accessorArray));
  assert.equal(getterReads, 0, "validation must reject accessor indexes without invoking them");
});

test("full schedule freezes excluded ABBA/BAAB and 16 balanced retained blocks", () => {
  const schedule = buildPass16FullSchedule();
  assert.equal(schedule.length, 72);
  assert.equal(Object.isFrozen(schedule), true);
  assert.equal(schedule.every(Object.isFrozen), true);
  assert.deepEqual(
    schedule.slice(0, 8).map((entry) => entry.mode),
    ["A", "B", "B", "A", "B", "A", "A", "B"],
  );
  assert.deepEqual(
    schedule.slice(8, 16).map((entry) => entry.mode),
    ["A", "B", "B", "A", "B", "A", "A", "B"],
  );
  assert.deepEqual(
    schedule.slice(-4).map((entry) => entry.mode),
    ["B", "A", "A", "B"],
  );
  const retained = schedule.slice(8);
  assert.equal(retained.filter((entry) => entry.mode === "A").length, 32);
  assert.equal(retained.filter((entry) => entry.mode === "B").length, 32);
  for (let position = 1; position <= 4; position += 1) {
    assert.equal(retained.filter((entry) => entry.withinBlockPosition === position && entry.mode === "A").length, 8);
    assert.equal(retained.filter((entry) => entry.withinBlockPosition === position && entry.mode === "B").length, 8);
  }
  assert.equal(validatePass16FullSchedule(schedule), true);
});

test("full schedule validator rejects every field mutation and structural deviation", () => {
  const schedule = buildPass16FullSchedule();
  for (const representativeIndex of [0, 4, 8, 12, 71]) {
    for (const key of Object.keys(schedule[representativeIndex])) {
      const mutated = clone(schedule);
      const original = mutated[representativeIndex][key];
      mutated[representativeIndex][key] =
        typeof original === "number" ? original + 1 : original === null ? 0 : `${original}-mutated`;
      assert.throws(() => validatePass16FullSchedule(mutated), undefined, `entry ${representativeIndex} key ${key}`);
    }
  }
  mutateAndReject(
    schedule,
    {
      "missing entry": (value) => value.pop(),
      "extra warmup": (value) => value.push(clone(value.at(-1))),
      "reordered entries": (value) => ([value[8], value[9]] = [value[9], value[8]]),
      "duplicate entry": (value) => value.splice(9, 1, clone(value[8])),
      "sparse array": (value) => delete value[3],
      "array property": (value) => (value.extra = true),
      "missing record key": (value) => delete value[8].withinBlockPosition,
      "extra record key": (value) => (value[8].unexpected = true),
    },
    validatePass16FullSchedule,
  );
});

test("canonical nonnegative nanoseconds retain values beyond Number precision", () => {
  assert.equal(parseCanonicalNonnegativeNs("0"), 0n);
  assert.equal(parseCanonicalNonnegativeNs("9007199254740993123456789"), 9007199254740993123456789n);
  for (const value of ["", " ", "00", "01", "+1", "-0", "-1", "1.0", "1e3", " 1", "1 ", "١", 1, 1n, null, undefined]) {
    assert.throws(() => parseCanonicalNonnegativeNs(value), undefined, String(value));
  }
});

test("timing validator accepts exact A and B phase, nested, commitment, and memory rosters", () => {
  const a = timingFixture("A", { origin: 9_007_199_254_740_993n });
  const b = timingFixture("B", { teardownTrial: true });
  const validatedA = validateTimingFixture(a);
  const validatedB = validateTimingFixture(b);
  assert.deepEqual(Object.keys(a.timing).sort(), [
    "commitment",
    "loader",
    "loaderTotalNs",
    "memorySnapshots",
    "phases",
    "receiptCommitmentNs",
    "roleReady",
    "roleReadyNs",
  ]);
  assert.ok(
    BigInt(a.timing.phases[0].nestedPhases[0].endNs) < BigInt(a.timing.phases[0].nestedPhases[1].startNs),
    "nested source diagnostics may contain untimed fstat/JavaScript work between them",
  );
  assert.equal(validatedA.loaderTotalNs, "50");
  assert.equal(validatedB.loaderTotalNs, "100");
  assert.deepEqual(validatedA.memory.labels, pass16MemoryLabels("A"));
  assert.deepEqual(validatedB.memory.labels, pass16MemoryLabels("B", true));
  assert.equal(validatedA.memory.phasePeak.rss, 1_060);
  assert.equal(validatedA.memory.phasePeakMinusBefore.rss, 60);
});

test("post-commitment and teardown memory cannot inflate loader phasePeak", () => {
  const fixture = timingFixture("B", { teardownTrial: true });
  const readyIndex = fixture.timing.memorySnapshots.findIndex((snapshot) => snapshot.label === "readyLive");
  const expectedPeak = fixture.timing.memorySnapshots[readyIndex].rss;
  for (const snapshot of fixture.timing.memorySnapshots.slice(readyIndex + 1)) {
    for (const field of PASS16_MEMORY_FIELDS) {
      snapshot[field] = Number.MAX_SAFE_INTEGER;
    }
  }
  const validated = validateTimingFixture(fixture);
  assert.equal(validated.memory.phasePeak.rss, expectedPeak);
  assert.equal(validated.memory.phasePeakMinusBefore.rss, expectedPeak - fixture.timing.memorySnapshots[0].rss);
});

test("B memory delta ceilings pass at the exact boundary and fail one byte above", () => {
  const fixture = timingFixture("B");
  const before = fixture.timing.memorySnapshots[0];
  const readyLive = fixture.timing.memorySnapshots.find((snapshot) => snapshot.label === "readyLive");
  for (const [field, maximum] of Object.entries(PASS16_B_MEMORY_DELTA_LIMITS)) {
    readyLive[field] = before[field] + maximum;
  }
  const boundary = validateTimingFixture(fixture);
  assert.deepEqual(boundary.memory.gates, {
    rss: true,
    external: true,
    arrayBuffers: true,
    heapUsed: true,
  });
  assert.equal(boundary.memory.passed, true);

  for (const field of Object.keys(PASS16_B_MEMORY_DELTA_LIMITS)) {
    const over = clone(fixture);
    const overReadyLive = over.timing.memorySnapshots.find((snapshot) => snapshot.label === "readyLive");
    overReadyLive[field] += 1;
    const result = validateTimingFixture(over);
    assert.equal(result.memory.gates[field], false, field);
    assert.equal(result.memory.passed, false, field);
  }

  const a = validateTimingFixture(timingFixture("A"));
  assert.equal(a.memory.gates, null);
  assert.equal(a.memory.passed, null);

  const teardown = timingFixture("B", { teardownTrial: true });
  const teardownBefore = teardown.timing.memorySnapshots[0];
  const teardownReady = teardown.timing.memorySnapshots.find((snapshot) => snapshot.label === "readyLive");
  teardownReady.rss = teardownBefore.rss + PASS16_B_MEMORY_DELTA_LIMITS.rss + 1;
  const teardownResult = validateTimingFixture(teardown);
  assert.equal(teardownResult.memory.gates, null);
  assert.equal(teardownResult.memory.passed, null);
});

test("timing validator rejects roster, arithmetic, nesting, placement, and memory mutations", () => {
  const fixture = timingFixture("B");
  mutateAndReject(
    fixture,
    {
      "extra top key": (value) => (value.timing.extra = true),
      "missing top key": (value) => delete value.timing.loader,
      "invalid mode": (value) => (value.mode = "C"),
      "nonboolean teardown": (value) => (value.teardownTrial = 0),
      "role starts late": (value) => {
        value.timing.roleReady.startNs = (BigInt(value.timing.loader.startNs) + 1n).toString();
        value.timing.roleReadyNs = (
          BigInt(value.timing.roleReady.endNs) - BigInt(value.timing.roleReady.startNs)
        ).toString();
      },
      "role ends early": (value) => {
        value.timing.roleReady.endNs = (BigInt(value.timing.loader.endNs) - 1n).toString();
        value.timing.roleReadyNs = (
          BigInt(value.timing.roleReady.endNs) - BigInt(value.timing.roleReady.startNs)
        ).toString();
      },
      "commitment overlaps role": (value) => {
        value.timing.commitment.startNs = (BigInt(value.timing.roleReady.endNs) - 1n).toString();
        value.timing.receiptCommitmentNs = (
          BigInt(value.timing.commitment.endNs) - BigInt(value.timing.commitment.startNs)
        ).toString();
      },
      "loader duration mismatch": (value) => (value.timing.loaderTotalNs = "99"),
      "role duration mismatch": (value) => (value.timing.roleReadyNs = "99"),
      "commitment duration mismatch": (value) => (value.timing.receiptCommitmentNs = "99"),
      "top duration noncanonical": (value) => (value.timing.loaderTotalNs = "050"),
      "interval extra key": (value) => (value.timing.loader.extra = true),
      "interval missing key": (value) => delete value.timing.loader.endNs,
      "phase renamed": (value) => (value.timing.phases[2].name = "renamed"),
      "phases reordered": (value) =>
        ([value.timing.phases[2], value.timing.phases[3]] = [value.timing.phases[3], value.timing.phases[2]]),
      "phase omitted": (value) => value.timing.phases.pop(),
      "phase added": (value) => value.timing.phases.push(clone(value.timing.phases.at(-1))),
      "phase array sparse": (value) => delete value.timing.phases[2],
      "phase extra key": (value) => (value.timing.phases[2].extra = true),
      "phase missing key": (value) => delete value.timing.phases[2].durationNs,
      "first phase starts late": (value) => {
        value.timing.phases[0].startNs = (BigInt(value.timing.loader.startNs) + 1n).toString();
        value.timing.phases[0].durationNs = (
          BigInt(value.timing.phases[0].endNs) - BigInt(value.timing.phases[0].startNs)
        ).toString();
      },
      "phase gap": (value) => {
        value.timing.phases[3].startNs = (BigInt(value.timing.phases[3].startNs) + 1n).toString();
        value.timing.phases[3].durationNs = (
          BigInt(value.timing.phases[3].endNs) - BigInt(value.timing.phases[3].startNs)
        ).toString();
      },
      "final phase ends early": (value) => {
        const phase = value.timing.phases.at(-1);
        phase.endNs = (BigInt(phase.endNs) - 1n).toString();
        phase.durationNs = (BigInt(phase.endNs) - BigInt(phase.startNs)).toString();
      },
      "nested omitted": (value) => value.timing.phases[0].nestedPhases.pop(),
      "nested added": (value) =>
        value.timing.phases[0].nestedPhases.push(clone(value.timing.phases[0].nestedPhases[1])),
      "nested array sparse": (value) => delete value.timing.phases[0].nestedPhases[0],
      "nested on noncapture": (value) =>
        value.timing.phases[2].nestedPhases.push(namedInterval("sourceReadNs", 130n, 131n)),
      "nested renamed": (value) => (value.timing.phases[0].nestedPhases[0].name = "renamed"),
      "nested extra key": (value) => (value.timing.phases[0].nestedPhases[0].extra = true),
      "nested duration mismatch": (value) => (value.timing.phases[0].nestedPhases[0].durationNs = "99"),
      "nested escapes parent": (value) => {
        const nested = value.timing.phases[0].nestedPhases[0];
        nested.startNs = (BigInt(value.timing.phases[0].startNs) - 1n).toString();
        nested.durationNs = (BigInt(nested.endNs) - BigInt(nested.startNs)).toString();
      },
      "nested overlap": (value) => {
        const nested = value.timing.phases[0].nestedPhases[1];
        nested.startNs = (BigInt(value.timing.phases[0].nestedPhases[0].endNs) - 1n).toString();
        nested.durationNs = (BigInt(nested.endNs) - BigInt(nested.startNs)).toString();
      },
      "memory omitted": (value) => value.timing.memorySnapshots.pop(),
      "memory added": (value) => value.timing.memorySnapshots.push(clone(value.timing.memorySnapshots.at(-1))),
      "memory reordered": (value) =>
        ([value.timing.memorySnapshots[1], value.timing.memorySnapshots[2]] = [
          value.timing.memorySnapshots[2],
          value.timing.memorySnapshots[1],
        ]),
      "memory duplicate": (value) => (value.timing.memorySnapshots[2].label = value.timing.memorySnapshots[1].label),
      "memory sparse": (value) => delete value.timing.memorySnapshots[2],
      "memory extra key": (value) => (value.timing.memorySnapshots[2].extra = true),
      "memory missing key": (value) => delete value.timing.memorySnapshots[2].rss,
      "memory negative": (value) => (value.timing.memorySnapshots[2].rss = -1),
      "memory fractional": (value) => (value.timing.memorySnapshots[2].heapUsed = 1.5),
      "memory nonfinite": (value) => (value.timing.memorySnapshots[2].external = Number.POSITIVE_INFINITY),
      "memory unsafe": (value) => (value.timing.memorySnapshots[2].arrayBuffers = Number.MAX_SAFE_INTEGER + 1),
      "memory noncanonical tick": (value) => (value.timing.memorySnapshots[2].captureNs = "01"),
      "memory capture outside phase": (value) =>
        (value.timing.memorySnapshots[2].captureNs = value.timing.loader.endNs),
      "post commitment captured early": (value) =>
        (value.timing.memorySnapshots.at(-1).captureNs = value.timing.commitment.startNs),
    },
    validateTimingFixture,
  );
});

test("A teardown trials and malformed A memory rosters are rejected", () => {
  const fixture = timingFixture("A");
  fixture.teardownTrial = true;
  assert.throws(() => validateTimingFixture(fixture), /Only Pass 16 B/);
  assert.throws(() => pass16MemoryLabels("A", true), /Only Pass 16 B/);
  assert.throws(() =>
    validatePass16TimingAndMemory(fixture.timing, {
      mode: "A",
    }),
  );
  assert.throws(() =>
    validatePass16TimingAndMemory(fixture.timing, {
      mode: "A",
      teardownTrial: false,
      extra: true,
    }),
  );
});

test("nearest-rank BigInt quantiles use the frozen n31 and n32 ranks", () => {
  const n31 = Array.from({ length: 31 }, (_, index) => BigInt(31 - index));
  const n32 = Array.from({ length: 32 }, (_, index) => BigInt(32 - index));
  const original31 = [...n31];
  assert.equal(nearestRankBigInt(n31, 1, 2), 16n);
  assert.equal(nearestRankBigInt(n31, 95, 100), 30n);
  assert.equal(nearestRankBigInt(n32, 1, 2), 16n);
  assert.equal(nearestRankBigInt(n32, 95, 100), 31n);
  assert.deepEqual(n31, original31, "quantile sorting must not mutate raw samples");
  assert.throws(() => nearestRankBigInt([], 1, 2));
  assert.throws(() => nearestRankBigInt([1], 1, 2));
  assert.throws(() => nearestRankBigInt([1n], 0, 2));
  assert.throws(() => nearestRankBigInt([1n], 3, 2));
});

test("exact sums compare canonical nanoseconds without Number coercion", () => {
  const left = ["9007199254740993", "2"];
  const right = ["9007199254740994", "0"];
  assert.equal(sumCanonicalNs(left), 9007199254740995n);
  assert.equal(compareCanonicalNsSums(left, right), 1);
  assert.equal(compareCanonicalNsSums(["1", "2"], ["2", "1"]), 0);
  assert.equal(compareCanonicalNsSums(["1", "1"], ["1", "2"]), -1);
  assert.throws(() => compareCanonicalNsSums(["01"], ["1"]));
  assert.throws(() => compareCanonicalNsSums([], ["1"]));
});

test("exact one-sided sign tails preserve denominator 2^n and frozen cutoffs", () => {
  assert.deepEqual(exactOneSidedSignTail(24, 31), {
    numerator: 3_572_224n,
    denominator: 2_147_483_648n,
  });
  assert.deepEqual(exactOneSidedSignTail(12, 16), {
    numerator: 2_517n,
    denominator: 65_536n,
  });
  assert.deepEqual(exactOneSidedSignTail(0, 4), {
    numerator: 16n,
    denominator: 16n,
  });
  assert.deepEqual(exactOneSidedSignTail(4, 4), {
    numerator: 1n,
    denominator: 16n,
  });
  assert.throws(() => exactOneSidedSignTail(-1, 31));
  assert.throws(() => exactOneSidedSignTail(32, 31));
  assert.throws(() => exactOneSidedSignTail(1, 0));
  assert.throws(() => exactOneSidedSignTail(1.5, 31));
  assert.throws(() => exactOneSidedSignTail(1, 65));
});

function passingReceiptPairs() {
  return Array.from({ length: 31 }, (_, index) => ({
    pairIndex: index + 1,
    aLoaderTotalNs: "60000000",
    aRoleReadyNs: "40000000",
    bLoaderTotalNs: "40000000",
    bRoleReadyNs: index < 24 ? "30000000" : "40000000",
  }));
}

test("receipt gate summary passes exactly 24/31 without floating milliseconds", () => {
  const summary = summarizePass16ReceiptCellGate(passingReceiptPairs());
  assert.equal(summary.passed, true);
  assert.equal(summary.bLowerPairs, 24);
  assert.deepEqual(summary.signTail, {
    successes: 24,
    trials: 31,
    numerator: "3572224",
    denominator: "2147483648",
  });
  assert.equal(summary.roleReady.A.medianNs, "40000000");
  assert.equal(summary.roleReady.B.medianNs, "30000000");
  assert.equal(summary.roleReady.B.p95Ns, "40000000");
  assert.equal(JSON.stringify(summary).includes("Ms"), false);
});

test("receipt gate requires 24 successes separately from the exact sign tail", () => {
  const pairs = passingReceiptPairs();
  pairs[23].bRoleReadyNs = pairs[23].aRoleReadyNs;
  const summary = summarizePass16ReceiptCellGate(pairs);
  assert.equal(summary.bLowerPairs, 23);
  assert.equal(summary.gates.signTail, true);
  assert.equal(summary.gates.minimumBLowerPairs, false);
  assert.equal(summary.passed, false);

  const overMaximum = passingReceiptPairs();
  overMaximum[0].bLoaderTotalNs = "70000001";
  const maximumSummary = summarizePass16ReceiptCellGate(overMaximum);
  assert.equal(maximumSummary.gates.loaderBMaximum, false);
  assert.equal(maximumSummary.passed, false);
});

test("receipt timing gates honor exact median, p95, maximum, and causal boundaries", () => {
  const base = Array.from({ length: 31 }, (_, index) => ({
    pairIndex: index + 1,
    aLoaderTotalNs: "80000000",
    aRoleReadyNs: "80000000",
    bLoaderTotalNs: "40000000",
    bRoleReadyNs: "50000000",
  }));

  const loaderMedianBoundary = clone(base);
  for (const pair of loaderMedianBoundary) {
    pair.bLoaderTotalNs = "50000000";
  }
  assert.equal(summarizePass16ReceiptCellGate(loaderMedianBoundary).gates.loaderBMedian, true);
  const loaderMedianOver = clone(base);
  for (let index = 0; index < 16; index += 1) {
    loaderMedianOver[index].bLoaderTotalNs = "50000001";
  }
  assert.equal(summarizePass16ReceiptCellGate(loaderMedianOver).gates.loaderBMedian, false);

  const loaderP95Boundary = clone(base);
  loaderP95Boundary[29].bLoaderTotalNs = "55000000";
  loaderP95Boundary[30].bLoaderTotalNs = "55000000";
  assert.equal(summarizePass16ReceiptCellGate(loaderP95Boundary).gates.loaderBP95, true);
  loaderP95Boundary[29].bLoaderTotalNs = "55000001";
  loaderP95Boundary[30].bLoaderTotalNs = "55000001";
  assert.equal(summarizePass16ReceiptCellGate(loaderP95Boundary).gates.loaderBP95, false);

  const loaderMaximumBoundary = clone(base);
  loaderMaximumBoundary[30].bLoaderTotalNs = "70000000";
  assert.equal(summarizePass16ReceiptCellGate(loaderMaximumBoundary).gates.loaderBMaximum, true);
  loaderMaximumBoundary[30].bLoaderTotalNs = "70000001";
  assert.equal(summarizePass16ReceiptCellGate(loaderMaximumBoundary).gates.loaderBMaximum, false);

  const roleMedianBoundary = clone(base);
  for (const pair of roleMedianBoundary) {
    pair.bRoleReadyNs = "60000000";
  }
  assert.equal(summarizePass16ReceiptCellGate(roleMedianBoundary).gates.roleReadyBMedian, true);
  const roleMedianOver = clone(base);
  for (let index = 0; index < 16; index += 1) {
    roleMedianOver[index].bRoleReadyNs = "60000001";
  }
  assert.equal(summarizePass16ReceiptCellGate(roleMedianOver).gates.roleReadyBMedian, false);

  const roleP95Boundary = clone(base);
  roleP95Boundary[29].bRoleReadyNs = "75000000";
  roleP95Boundary[30].bRoleReadyNs = "75000000";
  assert.equal(summarizePass16ReceiptCellGate(roleP95Boundary).gates.roleReadyBP95, true);
  roleP95Boundary[29].bRoleReadyNs = "75000001";
  roleP95Boundary[30].bRoleReadyNs = "75000001";
  assert.equal(summarizePass16ReceiptCellGate(roleP95Boundary).gates.roleReadyBP95, false);

  const roleMaximumBoundary = clone(base);
  roleMaximumBoundary[30].bRoleReadyNs = "100000000";
  assert.equal(summarizePass16ReceiptCellGate(roleMaximumBoundary).gates.roleReadyBMaximum, true);
  roleMaximumBoundary[30].bRoleReadyNs = "100000001";
  assert.equal(summarizePass16ReceiptCellGate(roleMaximumBoundary).gates.roleReadyBMaximum, false);

  const causalP95Failure = passingReceiptPairs();
  for (let index = 24; index < 31; index += 1) {
    causalP95Failure[index].bRoleReadyNs = "50000000";
  }
  const causal = summarizePass16ReceiptCellGate(causalP95Failure);
  assert.equal(causal.bLowerPairs, 24);
  assert.equal(causal.gates.roleReadyMedian, true);
  assert.equal(causal.gates.roleReadyP95, false);
  assert.equal(causal.passed, false);
});

test("receipt gate rejects duplicate, missing, extra, or malformed pair records", () => {
  const pairs = passingReceiptPairs();
  mutateAndReject(
    pairs,
    {
      missing: (value) => value.pop(),
      extra: (value) => value.push(clone(value.at(-1))),
      duplicate: (value) => (value[1].pairIndex = 1),
      reordered: (value) => ([value[0], value[1]] = [value[1], value[0]]),
      "extra key": (value) => (value[0].extra = true),
      "missing key": (value) => delete value[0].bLoaderTotalNs,
      malformed: (value) => (value[0].aRoleReadyNs = "01"),
      sparse: (value) => delete value[0],
    },
    summarizePass16ReceiptCellGate,
  );
});

function passingFullBlocks() {
  return Array.from({ length: 16 }, (_, index) => ({
    blockIndex: index + 1,
    aNs: ["200000000", "200000000"],
    bNs: index < 12 ? ["100000000", "100000000"] : ["200000000", "200000000"],
  }));
}

test("full gate summary passes exactly 12/16 using summed blocks and n32 ranks", () => {
  const summary = summarizePass16FullGate(passingFullBlocks());
  assert.equal(summary.passed, true);
  assert.equal(summary.bLowerBlocks, 12);
  assert.deepEqual(summary.signTail, {
    successes: 12,
    trials: 16,
    numerator: "2517",
    denominator: "65536",
  });
  assert.equal(summary.statistics.A.medianNs, "200000000");
  assert.equal(summary.statistics.B.medianNs, "100000000");
  assert.equal(summary.statistics.B.p95Ns, "200000000");
  assert.equal(summary.blockComparisons[12].bLower, false, "ties are non-successes");
  assert.equal(JSON.stringify(summary).includes("Ms"), false);
});

test("full gate independently rejects raw median and p95 regressions", () => {
  const p95Failure = passingFullBlocks();
  p95Failure[12].bNs = ["200000001", "200000001"];
  const p95Summary = summarizePass16FullGate(p95Failure);
  assert.equal(p95Summary.bLowerBlocks, 12);
  assert.equal(p95Summary.gates.minimumBLowerBlocks, true);
  assert.equal(p95Summary.gates.signTail, true);
  assert.equal(p95Summary.gates.median, true);
  assert.equal(p95Summary.gates.p95, false);
  assert.equal(p95Summary.passed, false);

  const medianFailure = Array.from({ length: 16 }, (_, index) => ({
    blockIndex: index + 1,
    aNs: ["200", "200"],
    bNs: index < 12 ? ["0", "399"] : ["201", "201"],
  }));
  const medianSummary = summarizePass16FullGate(medianFailure);
  assert.equal(medianSummary.bLowerBlocks, 12);
  assert.equal(medianSummary.gates.minimumBLowerBlocks, true);
  assert.equal(medianSummary.gates.signTail, true);
  assert.equal(medianSummary.gates.median, false);
  assert.equal(medianSummary.passed, false);
});

test("full gate fails at 11/16 and rejects malformed block structures", () => {
  const blocks = passingFullBlocks();
  blocks[11].bNs = [...blocks[11].aNs];
  const summary = summarizePass16FullGate(blocks);
  assert.equal(summary.bLowerBlocks, 11);
  assert.equal(summary.gates.minimumBLowerBlocks, false);
  assert.equal(summary.gates.signTail, false);
  assert.equal(summary.passed, false);

  mutateAndReject(
    passingFullBlocks(),
    {
      missing: (value) => value.pop(),
      extra: (value) => value.push(clone(value.at(-1))),
      duplicate: (value) => (value[1].blockIndex = 1),
      reordered: (value) => ([value[0], value[1]] = [value[1], value[0]]),
      "extra key": (value) => (value[0].extra = true),
      "missing key": (value) => delete value[0].bNs,
      "one A run": (value) => value[0].aNs.pop(),
      "three B runs": (value) => value[0].bNs.push("1"),
      malformed: (value) => (value[0].bNs[0] = "01"),
      sparse: (value) => delete value[0],
    },
    summarizePass16FullGate,
  );
});

test("canonical receipt JSON is deterministic, strict, and sized for 500 commitments", () => {
  const left = serializePass16CanonicalReceiptJson({ z: 1, a: { y: 2, x: 3 } });
  const right = serializePass16CanonicalReceiptJson({ a: { x: 3, y: 2 }, z: 1 });
  assert.deepEqual(left, right);
  assert.equal(left.toString("utf8"), '{"a":{"x":3,"y":2},"z":1}');
  const prototypeKey = serializePass16CanonicalReceiptJson(JSON.parse('{"a":2,"__proto__":{"retainedAsData":true}}'));
  assert.equal(prototypeKey.toString("utf8"), '{"__proto__":{"retainedAsData":true},"a":2}');
  assert.equal(Object.hasOwn(Object.prototype, "retainedAsData"), false);

  const commitments = Array.from({ length: PASS16_REGION_COMMITMENT_COUNT }, (_, index) => ({
    treeIndex: Math.floor(index / 5),
    field: ["childrenLeft", "childrenRight", "feature", "threshold", "value"][index % 5],
    scalarType: index % 5 < 3 ? "Int32" : "Float64",
    elementCount: 6_664,
    byteCount: index % 5 < 3 ? 26_656 : 53_312,
    sha256: index.toString(16).padStart(64, "0"),
  }));
  const receipt = {
    schemaVersion: 1,
    type: "noaa-snow-rf-state",
    commitments,
  };
  const measured = measurePass16CanonicalReceiptFrame(receipt);
  assert.ok(measured.jsonBytes > 64 * 1024, "the realistic roster exceeds the legacy 64 KiB cap");
  assert.ok(measured.jsonBytes < PASS16_MAX_CANONICAL_RECEIPT_JSON_BYTES);
  assert.equal(measured.frameBytes, measured.jsonBytes + PASS16_RECEIPT_FRAME_HEADER_BYTES);
  assert.ok(PASS16_MAX_RECEIPT_SIDEBAND_BYTES >= 4 * measured.frameBytes);
  assert.equal(PASS16_RECEIPT_FRAME_MAGIC, "MVBR");
  assert.equal(
    PASS16_MAX_CANONICAL_RECEIPT_FRAME_BYTES,
    PASS16_MAX_CANONICAL_RECEIPT_JSON_BYTES + PASS16_RECEIPT_FRAME_HEADER_BYTES,
  );

  const exactCapPayload = "x".repeat(PASS16_MAX_CANONICAL_RECEIPT_JSON_BYTES - 8);
  assert.equal(
    serializePass16CanonicalReceiptJson({ x: exactCapPayload }).byteLength,
    PASS16_MAX_CANONICAL_RECEIPT_JSON_BYTES,
  );
  assert.throws(() =>
    serializePass16CanonicalReceiptJson({
      x: `${exactCapPayload}x`,
    }),
  );
});

test("canonical receipt JSON rejects lossy, cyclic, sparse, and unsupported values", () => {
  for (const value of [
    null,
    [],
    "receipt",
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: -0 },
    { value: 1n },
    { value: undefined },
    { value: () => {} },
  ]) {
    assert.throws(() => serializePass16CanonicalReceiptJson(value));
  }
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => serializePass16CanonicalReceiptJson(cycle));
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => serializePass16CanonicalReceiptJson(sparse));
  const decorated = [1];
  decorated.extra = true;
  assert.throws(() => serializePass16CanonicalReceiptJson(decorated));

  const symbolExtra = { value: 1 };
  symbolExtra[Symbol("extra")] = true;
  assert.throws(() => serializePass16CanonicalReceiptJson(symbolExtra));

  const nonenumerableExtra = { value: 1 };
  Object.defineProperty(nonenumerableExtra, "hidden", { value: true });
  assert.throws(() => serializePass16CanonicalReceiptJson(nonenumerableExtra));

  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterReads += 1;
      return 1;
    },
  });
  assert.throws(() => serializePass16CanonicalReceiptJson(accessor));
  assert.equal(getterReads, 0, "canonicalization must reject accessors without invoking them");

  const accessorArray = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      getterReads += 1;
      return 1;
    },
  });
  accessorArray.length = 1;
  assert.throws(() => serializePass16CanonicalReceiptJson({ value: accessorArray }));
  assert.equal(getterReads, 0, "canonicalization must reject accessor indexes without invoking them");
});
