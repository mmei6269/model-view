"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");

const {
  _gradientEncodeInt16Region,
  buildHoverGridBinaryRaw,
  parseHoverGridBinaryRaw,
} = require("../scripts/lib/hover-grid-binary");
const { HOVER_GRID_ENCODINGS } = require("../scripts/lib/hover-grid-encoding");
const { compressSync, createCompressor } = require("../scripts/lib/noaa-beta/compress-pool");
const {
  _isHoverGridArena,
  _preflightHoverGridArena,
  createHoverGridArena,
  supportsGrowableSharedArrayBuffer,
} = require("../scripts/lib/noaa-beta/hover-arena");
const {
  _buildHoverGridVariablePlan,
  _materializeHoverGridArena,
  _materializeHoverGridVariablePlan,
  buildHoverGridArtifact,
} = require("../scripts/lib/noaa-beta/hover");
const {
  ArtifactEncodeCoordinator,
  getArtifactEncodeAdmissionGate,
} = require("../scripts/lib/noaa-beta/artifact-encode-coordinator");

const MVH4 = HOVER_GRID_ENCODINGS.mvh4;
const ROOT_DIR = path.resolve(__dirname, "..");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function source(length, phase, { allMissing = false, type = "f32" } = {}) {
  const values = type === "f64" ? new Float64Array(length) : new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    values[index] = allMissing
      ? Number.NaN
      : index % 11 === 0
        ? Number.NaN
        : Math.sin((index + phase) * 0.23) * 97.75 + phase;
  }
  return values;
}

function buildCatalogPlan(rows, cols, entries, decoded, options = {}) {
  return _buildHoverGridVariablePlan({
    decoded,
    selection: {
      availableParameters: [...new Set(entries.map((entry) => entry.key))],
      catalog: entries,
    },
    pressureHpa: options.pressureHpa || new Float32Array(0),
    temperatureF: options.temperatureF,
    width: cols,
    height: rows,
    preGradient: true,
  });
}

function legacyRawForPlan(plan) {
  return buildHoverGridBinaryRaw({
    schemaVersion: MVH4.schemaVersion,
    encoding: MVH4,
    rows: plan.height,
    cols: plan.width,
    variables: _materializeHoverGridVariablePlan(plan),
  });
}

function capturingCompressor({ settle = null } = {}) {
  const submissions = [];
  const counters = { jobs: 0, fallbacks: 0 };
  const pool = {
    dead: false,
    maxPending: 1,
    canUseSharedInput: () => true,
    submitShared(kind, raw, level) {
      submissions.push({ kind, raw, level });
      return (settle ? settle() : Promise.resolve()).then(() => compressSync(kind, raw, level));
    },
    submit() {
      assert.fail("direct hover arena must not use generic cloned compression");
    },
  };
  return { compress: createCompressor(pool, counters), counters, pool, submissions };
}

test(
  "direct MVH4 arena matches legacy bytes across mixed fused/unfused planes and reuses one omitted tail",
  { skip: !supportsGrowableSharedArrayBuffer() },
  async () => {
    const rows = 4;
    const cols = 5;
    const cells = rows * cols;
    const temperatureF = source(cells, 7, { type: "f64" });
    temperatureF[3] = Number.POSITIVE_INFINITY;
    temperatureF[5] = 1e9;
    const rate = source(cells, 0, { allMissing: true });
    const windU = source(cells, 13);
    const windV = source(cells, 17);
    const pressureHpa = source(cells, 0, { allMissing: true });
    const snapshots = [temperatureF, rate, windU, windV, pressureHpa].map((values) => Array.from(values));
    const plan = _buildHoverGridVariablePlan({
      decoded: { rate, windU, windV },
      selection: {
        availableParameters: ["temperature", "rainRate", "windAloft"],
        catalog: [
          { key: "temperature", unit: "F" },
          { key: "rainRate", kind: "precipRateType", rateKey: "rate", unit: "in/hr" },
          {
            key: "windAloft",
            kind: "wind",
            uKey: "windU",
            vKey: "windV",
            unit: "kt",
            transform: "windKt",
          },
        ],
      },
      temperatureF,
      pressureHpa,
      width: cols,
      height: rows,
      preGradient: true,
    });
    const expectedRaw = legacyRawForPlan(plan);
    const transport = capturingCompressor();
    const artifact = buildHoverGridArtifact({
      width: cols,
      height: rows,
      variablePlan: plan,
      format: "binary",
      compress: transport.compress,
      encoding: MVH4,
    });
    await artifact.pending;

    assert.equal(transport.submissions.length, 1);
    const published = transport.submissions[0].raw;
    assert.ok(Buffer.isBuffer(published));
    assert.ok(published.buffer instanceof SharedArrayBuffer);
    assert.ok(published.byteOffset > 0, "bounded wire view must begin inside the reserved prefix");
    assert.deepEqual(published, expectedRaw);
    assert.deepEqual(Object.keys(parseHoverGridBinaryRaw(published).header.variables), ["temperature", "windAloft"]);
    assert.strictEqual(published.buffer, transport.submissions[0].raw.buffer);
    assert.deepEqual(artifact.arenaTelemetry, {
      variables: 2,
      cells,
      planeBytes: cells * 2,
      headerReserveBytes: artifact.arenaTelemetry.headerReserveBytes,
      viewOffsetBytes: published.byteOffset,
      viewBytes: published.byteLength,
      backingBytes: artifact.arenaTelemetry.headerReserveBytes + cells * 2 * 3,
      maxBytes: artifact.arenaTelemetry.headerReserveBytes + cells * 2 * 4,
      backingSlackBytes: published.buffer.byteLength - published.byteLength,
      speculativeTailBytes: cells * 2,
      uniqueOwners: 1,
      copyBytes: 0,
    });
    assert.equal(transport.counters.sharedInputViewBytes, published.byteLength);
    assert.equal(transport.counters.sharedInputBackingBytes, published.buffer.byteLength);
    assert.equal(transport.counters.sharedInputMaxBytes, published.buffer.maxByteLength);
    assert.equal(transport.counters.sharedInputUniqueOwners, 1);
    assert.equal(transport.counters.transportLiveBytes, 0);
    assert.deepEqual(
      [temperatureF, rate, windU, windV, pressureHpa].map((values) => Array.from(values)),
      snapshots,
      "quantization and predictor finalization must not mutate meteorological sources",
    );
  },
);

test(
  "canonical omissions, empty bodies, numeric order fallback, duplicates, and escaped keys stay byte exact",
  { skip: !supportsGrowableSharedArrayBuffer() },
  async (t) => {
    const rows = 4;
    const cols = 5;
    const cells = rows * cols;

    await t.test("middle and trailing omissions use one speculative plane", async () => {
      const entries = [
        { key: "keepFirst", inputKey: "keepFirst", unit: "C", transform: "identity" },
        { key: "omitMiddle", inputKey: "omitMiddle", unit: "C", transform: "identity" },
        { key: "keepLast", inputKey: "keepLast", unit: "C", transform: "identity" },
        { key: "omitTrailing", inputKey: "omitTrailing", unit: "C", transform: "identity" },
      ];
      const plan = buildCatalogPlan(rows, cols, entries, {
        keepFirst: source(cells, 41),
        omitMiddle: source(cells, 0, { allMissing: true }),
        keepLast: source(cells, 43),
        omitTrailing: source(cells, 0, { allMissing: true }),
      });
      const expected = legacyRawForPlan(plan);
      assert.equal(sha256(expected), "ddb02f52ca4fb4f1bd4c82cabff79f047a4dc374736c21e9a96c32c2ec7d2d2f");
      const transport = capturingCompressor();
      const artifact = buildHoverGridArtifact({
        width: cols,
        height: rows,
        variablePlan: plan,
        format: "binary",
        compress: transport.compress,
      });
      await artifact.pending;
      assert.deepEqual(transport.submissions[0].raw, expected);
      assert.equal(artifact.arenaTelemetry.variables, 2);
      assert.equal(artifact.arenaTelemetry.speculativeTailBytes, cells * 2);
      assert.equal(artifact.arenaTelemetry.backingBytes, artifact.arenaTelemetry.headerReserveBytes + cells * 2 * 3);
    });

    await t.test("all-empty output retains only one speculative tail and canonical hash", async () => {
      const entries = [{ key: "empty", inputKey: "empty", unit: "C", transform: "identity" }];
      const plan = buildCatalogPlan(rows, cols, entries, {
        empty: source(cells, 0, { allMissing: true }),
      });
      const transport = capturingCompressor();
      const artifact = buildHoverGridArtifact({
        width: cols,
        height: rows,
        variablePlan: plan,
        format: "binary",
        compress: transport.compress,
      });
      await artifact.pending;
      const published = transport.submissions[0].raw;
      assert.equal(sha256(published), "cfe27238db2d0e104619aeb8ee1603c855ef302911b3f9b8149d0fb049e144fd");
      assert.equal(artifact.arenaTelemetry.variables, 0);
      assert.equal(artifact.arenaTelemetry.speculativeTailBytes, cells * 2);
      assert.equal(artifact.arenaTelemetry.backingBytes, artifact.arenaTelemetry.headerReserveBytes + cells * 2);
    });

    await t.test("numeric keys reject before arena allocation and preserve legacy Object.keys order", async () => {
      const entries = [
        { key: "z", inputKey: "zSource", unit: "C", transform: "identity" },
        { key: "10", inputKey: "tenSource", unit: "C", transform: "identity" },
        { key: "2", inputKey: "twoSource", unit: "C", transform: "identity" },
        { key: "a", inputKey: "aSource", unit: "C", transform: "identity" },
      ];
      const plan = buildCatalogPlan(rows, cols, entries, {
        zSource: source(cells, 1),
        tenSource: source(cells, 2),
        twoSource: source(cells, 3),
        aSource: source(cells, 4),
      });
      const transport = capturingCompressor();
      const artifact = buildHoverGridArtifact({
        width: cols,
        height: rows,
        variablePlan: plan,
        format: "binary",
        compress: transport.compress,
      });
      await artifact.pending;
      const published = transport.submissions[0].raw;
      assert.equal(artifact.arenaFallbackReason, "noncanonical-variable-roster");
      assert.equal(artifact.arenaTelemetry, undefined);
      assert.equal(published.byteOffset, 0);
      assert.equal(published.byteLength, published.buffer.byteLength);
      assert.equal(sha256(published), "b48477fa9c3649cfc829f4fa2d24bc48f8bacd28bcc019b40a222e464eee9ee1");
      assert.deepEqual(Object.keys(parseHoverGridBinaryRaw(published).header.variables), ["2", "10", "z", "a"]);
    });

    await t.test("duplicate keys reject before allocation and retain legacy last-write-wins bytes", async () => {
      const entries = [
        { key: "dup", inputKey: "first", unit: "C", transform: "identity" },
        { key: "dup", inputKey: "second", unit: "C", transform: "identity" },
      ];
      const plan = buildCatalogPlan(rows, cols, entries, {
        first: source(cells, 11),
        second: source(cells, 29),
      });
      const transport = capturingCompressor();
      const artifact = buildHoverGridArtifact({
        width: cols,
        height: rows,
        variablePlan: plan,
        format: "binary",
        compress: transport.compress,
      });
      await artifact.pending;
      assert.equal(artifact.arenaFallbackReason, "noncanonical-variable-roster");
      assert.equal(
        sha256(transport.submissions[0].raw),
        "76125bcd3799d31906f68c526ef40aa0a4e97283b9c11c636a3f31219474313a",
      );
    });

    await t.test("escaped Unicode key uses the direct arena and exact canonical bytes", async () => {
      const key = 'snow☃"\\\\\n';
      const plan = buildCatalogPlan(
        rows,
        cols,
        [{ key, inputKey: "unicodeSource", unit: "C", transform: "identity" }],
        { unicodeSource: source(cells, 51) },
      );
      const transport = capturingCompressor();
      const artifact = buildHoverGridArtifact({
        width: cols,
        height: rows,
        variablePlan: plan,
        format: "binary",
        compress: transport.compress,
      });
      await artifact.pending;
      assert.ok(artifact.arenaTelemetry);
      assert.equal(
        sha256(transport.submissions[0].raw),
        "7f485ca131a6fea4498ad33e5c7624b719edc359c8421190f7ecc3238ff2b399",
      );
    });
  },
);

test(
  "direct eligibility binds artifact dimensions and orientation to the branded source plan",
  { skip: !supportsGrowableSharedArrayBuffer() },
  async (t) => {
    const plan = buildCatalogPlan(2, 3, [{ key: "probe", inputKey: "probe", unit: "C", transform: "identity" }], {
      probe: source(6, 73),
    });

    await t.test("equal-cell swapped dimensions preserve the eager legacy wire exactly", async () => {
      const expected = buildHoverGridBinaryRaw({
        schemaVersion: MVH4.schemaVersion,
        encoding: MVH4,
        rows: 3,
        cols: 2,
        variables: _materializeHoverGridVariablePlan(plan),
      });
      const transport = capturingCompressor();
      const artifact = buildHoverGridArtifact({
        width: 2,
        height: 3,
        variablePlan: plan,
        format: "binary",
        compress: transport.compress,
        encoding: MVH4,
      });
      await artifact.pending;

      assert.equal(artifact.arenaFallbackReason, "plan-dimension-mismatch");
      assert.equal(artifact.arenaTelemetry, undefined);
      assert.equal(transport.submissions[0].raw.byteOffset, 0);
      assert.deepEqual(transport.submissions[0].raw, expected);
      const parsed = parseHoverGridBinaryRaw(transport.submissions[0].raw);
      assert.deepEqual([parsed.header.rows, parsed.header.cols], [3, 2]);
    });

    await t.test("different cell counts take the same eager validation failure", async () => {
      const transport = capturingCompressor();
      const coordinator = new ArtifactEncodeCoordinator(1);
      const artifact = buildHoverGridArtifact({
        width: 2,
        height: 2,
        variablePlan: plan,
        format: "binary",
        compress: transport.compress,
        coordinator,
        encoding: MVH4,
      });

      assert.equal(artifact.arenaFallbackReason, "plan-dimension-mismatch");
      assert.equal(artifact.arenaTelemetry, undefined);
      await assert.rejects(artifact.pending, /length 6 does not match rows\*cols 4/);
      assert.equal(transport.submissions.length, 0);
      await assert.rejects(coordinator.drain(), /length 6 does not match rows\*cols 4/);
    });
  },
);

test(
  "arena preflight binds the exact descriptor, roster, metadata, order, and immutable snapshot before allocation",
  { skip: !supportsGrowableSharedArrayBuffer() },
  () => {
    const validCandidate = { key: "safe", scale: 0.05, offset: 0, missing: -32768 };
    for (const candidates of [
      [{ ...validCandidate }, { ...validCandidate }],
      [{ ...validCandidate, key: "0" }],
      [{ ...validCandidate, key: "4294967294" }],
      [{ ...validCandidate, key: "__proto__" }],
      [{ ...validCandidate, scale: 0 }],
    ]) {
      let allocations = 0;
      const created = createHoverGridArena({
        rows: 2,
        cols: 2,
        candidates,
        encoding: MVH4,
        allocateShared() {
          allocations += 1;
          assert.fail("invalid preflight must not allocate");
        },
      });
      assert.equal(created.arena, null);
      assert.equal(allocations, 0);
    }

    let forgedAllocations = 0;
    const forged = createHoverGridArena({
      rows: 2,
      cols: 2,
      candidates: [validCandidate],
      encoding: { magic: "MVH4", schemaVersion: 4, predictor: "gradient2d", preDeltaEncode: false },
      allocateShared() {
        forgedAllocations += 1;
        assert.fail("a forged descriptor must not allocate");
      },
    });
    assert.equal(forged.reason, "noncanonical-encoding");
    assert.equal(forgedAllocations, 0);

    const boundaryCandidates = [
      { ...validCandidate, key: "00" },
      { ...validCandidate, key: "4294967295" },
    ];
    assert.equal(
      _preflightHoverGridArena({ rows: 2, cols: 2, candidates: boundaryCandidates, encoding: MVH4 }).ok,
      true,
    );
    const created = createHoverGridArena({
      rows: 2,
      cols: 2,
      candidates: boundaryCandidates,
      encoding: MVH4,
    });
    assert.ok(_isHoverGridArena(created.arena));
    boundaryCandidates[0].key = "mutated";
    boundaryCandidates[0].scale = 99;
    const first = created.arena.openPlane("00");
    created.arena.discardPlane("00");
    const second = created.arena.openPlane("4294967295");
    second.fill(0);
    _gradientEncodeInt16Region(Buffer.from(second.buffer, second.byteOffset, second.byteLength), 0, 2, 2);
    created.arena.commitPlane("4294967295", {
      values: second,
      predictorEncoded: "gradient2d",
      scale: 0.05,
      offset: 0,
      missing: -32768,
    });
    const sealed = created.arena.seal();
    assert.ok(first.buffer === sealed.raw.buffer && second.buffer === sealed.raw.buffer);
    assert.deepEqual(Object.keys(parseHoverGridBinaryRaw(sealed.raw).header.variables), ["4294967295"]);
    assert.throws(() => created.arena.seal(), /sealed, not building/);
  },
);

test(
  "arena misuse and post-allocation quantization failures fail closed without a legacy retry",
  { skip: !supportsGrowableSharedArrayBuffer() },
  async (t) => {
    const candidates = [
      { key: "a", scale: 0.05, offset: 0, missing: -32768 },
      { key: "b", scale: 0.05, offset: 0, missing: -32768 },
    ];

    await t.test("reorder, skip, and metadata mutation make the owner permanently failed", () => {
      const reordered = createHoverGridArena({ rows: 2, cols: 2, candidates, encoding: MVH4 }).arena;
      assert.throws(() => reordered.openPlane("b"), /expected canonical plane "a"/);
      assert.throws(() => reordered.openPlane("a"), /failed, not building/);

      const skipped = createHoverGridArena({ rows: 2, cols: 2, candidates, encoding: MVH4 }).arena;
      assert.throws(() => skipped.seal(), /before every canonical candidate/);
      assert.throws(() => skipped.openPlane("a"), /failed, not building/);

      const changed = createHoverGridArena({
        rows: 2,
        cols: 2,
        candidates: [candidates[0]],
        encoding: MVH4,
      }).arena;
      const values = changed.openPlane("a");
      values.fill(1);
      _gradientEncodeInt16Region(Buffer.from(values.buffer, values.byteOffset, values.byteLength), 0, 2, 2);
      assert.throws(
        () =>
          changed.commitPlane("a", {
            values,
            predictorEncoded: "gradient2d",
            scale: 0.1,
            offset: 0,
            missing: -32768,
          }),
        /changed its canonical quantization metadata/,
      );
      assert.throws(() => changed.seal(), /failed, not building/);
    });

    await t.test("only finite nonpositive validCount may discard a materialized candidate", () => {
      const plan = buildCatalogPlan(2, 2, [{ key: "probe", inputKey: "probe", unit: "C", transform: "identity" }], {
        probe: [1, 2, 3, 4],
      });
      assert.throws(
        () =>
          _materializeHoverGridArena(plan, MVH4, (_plan, _candidate, target) => ({
            values: new Int16Array(target.length),
            validCount: 1,
          })),
        /did not preserve its exact target view/,
      );
      assert.throws(
        () =>
          _materializeHoverGridArena(plan, MVH4, (_plan, _candidate, target) => ({
            values: target,
            validCount: Number.NaN,
          })),
        /non-finite validCount/,
      );
      const empty = _materializeHoverGridArena(plan, MVH4, () => ({
        values: new Int16Array(0),
        validCount: 0,
      }));
      assert.equal(empty.result.telemetry.variables, 0);
      assert.deepEqual(Object.keys(parseHoverGridBinaryRaw(empty.result.raw).header.variables), []);
    });

    await t.test("a quantizer throw after allocation submits nothing and reads the source only once", async () => {
      let reads = 0;
      const throwingSource = {
        length: 4,
        get 0() {
          reads += 1;
          throw new Error("synthetic quantizer failure");
        },
      };
      const plan = buildCatalogPlan(2, 2, [{ key: "probe", inputKey: "probe", unit: "C", transform: "identity" }], {
        probe: throwingSource,
      });
      const transport = capturingCompressor();
      const coordinator = new ArtifactEncodeCoordinator(1, {
        admissionGate: getArtifactEncodeAdmissionGate(transport.pool, 1),
      });
      const artifact = buildHoverGridArtifact({
        width: 2,
        height: 2,
        variablePlan: plan,
        format: "binary",
        compress: transport.compress,
        coordinator,
      });
      await assert.rejects(artifact.pending, /synthetic quantizer failure/);
      assert.equal(reads, 1, "post-allocation failure must not retry through legacy materialization");
      assert.equal(transport.submissions.length, 0);
      assert.equal(artifact.body, null);
      assert.equal(artifact.arenaTelemetry, undefined);
      await assert.rejects(coordinator.drain(), /synthetic quantizer failure/);
    });
  },
);

test(
  "two frame coordinators defer the second arena allocation and source reads behind shared admission",
  { skip: !supportsGrowableSharedArrayBuffer() },
  async () => {
    const controls = [];
    const transport = capturingCompressor({
      settle() {
        let resolve;
        const promise = new Promise((resolvePromise) => {
          resolve = resolvePromise;
        });
        controls.push({ promise, resolve });
        return promise;
      },
    });
    const gate = getArtifactEncodeAdmissionGate(transport.pool, 1);
    const firstCoordinator = new ArtifactEncodeCoordinator(1, { admissionGate: gate });
    const secondCoordinator = new ArtifactEncodeCoordinator(1, { admissionGate: gate });
    const reads = [0, 0];
    const makeValues = (frame) =>
      new Proxy(
        Array.from({ length: 4 }, (_, index) => 270 + frame * 5 + index),
        {
          get(target, property, receiver) {
            if (typeof property === "string" && /^\d+$/.test(property)) {
              reads[frame] += 1;
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
    const makePlan = (frame) =>
      buildCatalogPlan(2, 2, [{ key: "probe", inputKey: "probe", unit: "C", transform: "identity" }], {
        probe: makeValues(frame),
      });

    const first = buildHoverGridArtifact({
      width: 2,
      height: 2,
      variablePlan: makePlan(0),
      format: "binary",
      compress: transport.compress,
      coordinator: firstCoordinator,
    });
    const second = buildHoverGridArtifact({
      width: 2,
      height: 2,
      variablePlan: makePlan(1),
      format: "binary",
      compress: transport.compress,
      coordinator: secondCoordinator,
    });
    assert.equal(transport.submissions.length, 1);
    assert.ok(reads[0] > 0);
    assert.equal(reads[1], 0, "queued frame must retain sources but allocate and quantize nothing");
    assert.ok(first.arenaTelemetry);
    assert.equal(second.arenaTelemetry, undefined);

    controls[0].resolve();
    await first.pending;
    for (let attempt = 0; attempt < 10 && transport.submissions.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(transport.submissions.length, 2);
    assert.ok(reads[1] > 0);
    assert.ok(second.arenaTelemetry);
    assert.notStrictEqual(transport.submissions[0].raw.buffer, transport.submissions[1].raw.buffer);
    controls[1].resolve();
    await second.pending;
  },
);

test(
  "admitted direct arena releases meteorological sources while codec work is still pending",
  { skip: !supportsGrowableSharedArrayBuffer() },
  () => {
    const script = [
      '"use strict";',
      "const { _buildHoverGridVariablePlan, buildHoverGridArtifact } =",
      '  require("./scripts/lib/noaa-beta/hover");',
      'const { compressSync, createCompressor } = require("./scripts/lib/noaa-beta/compress-pool");',
      "const { ArtifactEncodeCoordinator, getArtifactEncodeAdmissionGate } =",
      '  require("./scripts/lib/noaa-beta/artifact-encode-coordinator");',
      'if (typeof global.gc !== "function") throw new Error("probe requires --expose-gc");',
      "let releaseCodec;",
      "const heldCodec = new Promise((resolve) => { releaseCodec = resolve; });",
      "const pool = {",
      "  dead: false, maxPending: 1, canUseSharedInput: () => true,",
      "  submitShared(kind, raw, level) {",
      "    return heldCodec.then(() => compressSync(kind, raw, level));",
      "  },",
      "};",
      "const compress = createCompressor(pool, { jobs: 0, fallbacks: 0 });",
      "const coordinator = new ArtifactEncodeCoordinator(1, {",
      "  admissionGate: getArtifactEncodeAdmissionGate(pool, 1),",
      "});",
      "function launch() {",
      "  const source = new Float32Array(1 << 20);",
      "  source.fill(273.15);",
      "  const weakSource = new WeakRef(source);",
      "  const plan = _buildHoverGridVariablePlan({",
      "    decoded: { probe: source },",
      "    selection: {",
      '      availableParameters: ["probe"],',
      '      catalog: [{ key: "probe", inputKey: "probe", unit: "C", transform: "identity" }],',
      "    },",
      "    pressureHpa: new Float32Array(0),",
      "    width: 1024, height: 1024, preGradient: true,",
      "  });",
      "  const artifact = buildHoverGridArtifact({",
      "    width: 1024, height: 1024, variablePlan: plan,",
      '    format: "binary", compress, coordinator,',
      "  });",
      "  return { weakSource, pending: artifact.pending, arena: Boolean(artifact.arenaTelemetry) };",
      "}",
      "async function collect() {",
      "  for (let round = 0; round < 16; round += 1) {",
      "    await new Promise((resolve) => setImmediate(resolve));",
      "    global.gc();",
      "  }",
      "}",
      "(async () => {",
      "  const launched = launch();",
      "  await collect();",
      "  const aliveWhileCodecPending = Boolean(launched.weakSource.deref());",
      "  releaseCodec();",
      "  await launched.pending;",
      "  await collect();",
      "  const aliveAfterSettlement = Boolean(launched.weakSource.deref());",
      "  process.stdout.write(JSON.stringify({",
      "    arena: launched.arena, aliveWhileCodecPending, aliveAfterSettlement,",
      "    activeEntries: coordinator.active.size, queuedEntries: coordinator.queue.length,",
      "  }));",
      "})().catch((error) => { console.error(error); process.exitCode = 1; });",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--expose-gc", "-e", script], {
      cwd: ROOT_DIR,
      env: { ...process.env, MODELVIEW_NOAA_HOVER_ARENA: "auto" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      arena: true,
      aliveWhileCodecPending: false,
      aliveAfterSettlement: false,
      activeEntries: 0,
      queuedEntries: 0,
    });
  },
);

test("a runtime that ignores GSAB constructor options eagerly selects the exact fixed-SAB fallback", () => {
  const script = [
    '"use strict";',
    "const NativeSharedArrayBuffer = global.SharedArrayBuffer;",
    "const allocations = [];",
    "function FixedSharedArrayBuffer(byteLength, options) {",
    "  allocations.push({",
    "    byteLength,",
    "    maxByteLength: options && Object.prototype.hasOwnProperty.call(options, 'maxByteLength')",
    "      ? options.maxByteLength",
    "      : null,",
    "  });",
    "  return new NativeSharedArrayBuffer(byteLength);",
    "}",
    "FixedSharedArrayBuffer.prototype = NativeSharedArrayBuffer.prototype;",
    "global.SharedArrayBuffer = FixedSharedArrayBuffer;",
    'const { buildHoverGridBinaryRaw } = require("./scripts/lib/hover-grid-binary");',
    'const { HOVER_GRID_ENCODINGS } = require("./scripts/lib/hover-grid-encoding");',
    'const { compressSync, createCompressor } = require("./scripts/lib/noaa-beta/compress-pool");',
    "const { supportsGrowableSharedArrayBuffer } =",
    '  require("./scripts/lib/noaa-beta/hover-arena");',
    "const {",
    "  _buildHoverGridVariablePlan, _materializeHoverGridVariablePlan, buildHoverGridArtifact,",
    '} = require("./scripts/lib/noaa-beta/hover");',
    "(async () => {",
    "  let reads = 0;",
    "  const source = new Proxy([271, 272, 273, 274], {",
    "    get(target, property, receiver) {",
    '      if (typeof property === "string" && /^\\d+$/.test(property)) reads += 1;',
    "      return Reflect.get(target, property, receiver);",
    "    },",
    "  });",
    "  const plan = _buildHoverGridVariablePlan({",
    "    decoded: { probe: source },",
    "    selection: {",
    '      availableParameters: ["probe"],',
    '      catalog: [{ key: "probe", inputKey: "probe", unit: "C", transform: "identity" }],',
    "    },",
    "    pressureHpa: new Float32Array(0), width: 2, height: 2, preGradient: true,",
    "  });",
    "  let published;",
    "  const pool = {",
    "    dead: false, maxPending: 1, canUseSharedInput: () => true,",
    "    submitShared(kind, raw, level) {",
    "      published = raw;",
    "      return Promise.resolve(compressSync(kind, raw, level));",
    "    },",
    "  };",
    "  let startJob;",
    "  let resolveJob;",
    "  let rejectJob;",
    "  const scheduled = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });",
    "  const coordinator = { schedule(start) { startJob = start; return scheduled; } };",
    "  const artifact = buildHoverGridArtifact({",
    '    width: 2, height: 2, variablePlan: plan, format: "binary",',
    "    compress: createCompressor(pool, { jobs: 0, fallbacks: 0 }), coordinator,",
    "  });",
    "  const readsBeforeAdmission = reads;",
    "  const expected = buildHoverGridBinaryRaw({",
    "    schemaVersion: HOVER_GRID_ENCODINGS.mvh4.schemaVersion,",
    "    encoding: HOVER_GRID_ENCODINGS.mvh4, rows: 2, cols: 2,",
    "    variables: _materializeHoverGridVariablePlan(plan),",
    "  });",
    "  Promise.resolve().then(startJob).then(resolveJob, rejectJob);",
    "  await artifact.pending;",
    "  process.stdout.write(JSON.stringify({",
    "    supported: supportsGrowableSharedArrayBuffer(),",
    "    readsBeforeAdmission, fallback: artifact.arenaFallbackReason || null,",
    "    arena: Boolean(artifact.arenaTelemetry),",
    "    allocations,",
    "    fixedOwner: published.buffer instanceof NativeSharedArrayBuffer && published.buffer.growable === false,",
    "    exactRange: published.byteOffset === 0 && published.byteLength === published.buffer.byteLength,",
    "    exactBytes: Buffer.compare(published, expected) === 0,",
    "  }));",
    "})().catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: ROOT_DIR,
    env: { ...process.env, MODELVIEW_NOAA_HOVER_ARENA: "auto" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.supported, false);
  assert.ok(observation.readsBeforeAdmission > 0);
  assert.equal(observation.fallback, "growable-shared-array-buffer-unavailable");
  assert.equal(observation.arena, false);
  assert.deepEqual(
    observation.allocations.filter((allocation) => allocation.maxByteLength !== null),
    [{ byteLength: 2, maxByteLength: 8 }],
    "the capability probe may request growth, but no renderer arena allocation may follow",
  );
  assert.equal(observation.fixedOwner, true);
  assert.equal(observation.exactRange, true);
  assert.equal(observation.exactBytes, true);
});

test(
  "explicit off is an eager Pass 12 operational rollback while auto stays byte and signature neutral",
  { skip: !supportsGrowableSharedArrayBuffer() },
  () => {
    const probe = (mode) => {
      const script = [
        '"use strict";',
        'const crypto = require("node:crypto");',
        'const { createCompressor, compressSync } = require("./scripts/lib/noaa-beta/compress-pool");',
        "const { _buildHoverGridVariablePlan, buildHoverGridArtifact } =",
        '  require("./scripts/lib/noaa-beta/hover");',
        'const { HOVER_ARENA_MODE } = require("./scripts/lib/noaa-beta/hover-arena");',
        'const { getNoaaGribRendererSignature } = require("./scripts/lib/noaa-beta-renderer");',
        "(async () => {",
        "  let reads = 0;",
        "  const source = new Proxy([271, 272, 273, 274], {",
        "    get(target, property, receiver) {",
        '      if (typeof property === "string" && /^\\d+$/.test(property)) reads += 1;',
        "      return Reflect.get(target, property, receiver);",
        "    },",
        "  });",
        "  const plan = _buildHoverGridVariablePlan({",
        "    decoded: { probe: source },",
        "    selection: {",
        '      availableParameters: ["probe"],',
        '      catalog: [{ key: "probe", inputKey: "probe", unit: "C", transform: "identity" }],',
        "    },",
        "    pressureHpa: new Float32Array(0), width: 2, height: 2, preGradient: true,",
        "  });",
        "  let published;",
        "  const pool = {",
        "    dead: false, maxPending: 1, canUseSharedInput: () => true,",
        "    submitShared(kind, raw, level) {",
        "      published = raw;",
        "      return Promise.resolve(compressSync(kind, raw, level));",
        "    },",
        "  };",
        "  let startJob;",
        "  let resolveJob;",
        "  let rejectJob;",
        "  const scheduled = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });",
        "  const coordinator = {",
        "    schedule(start) { startJob = start; return scheduled; },",
        "  };",
        "  const artifact = buildHoverGridArtifact({",
        '    width: 2, height: 2, variablePlan: plan, format: "binary",',
        "    compress: createCompressor(pool, { jobs: 0, fallbacks: 0 }), coordinator,",
        "  });",
        "  const readsBeforeAdmission = reads;",
        "  Promise.resolve().then(startJob).then(resolveJob, rejectJob);",
        "  await artifact.pending;",
        "  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');",
        "  process.stdout.write(JSON.stringify({",
        "    mode: HOVER_ARENA_MODE, readsBeforeAdmission,",
        "    fallback: artifact.arenaFallbackReason || null,",
        "    arena: Boolean(artifact.arenaTelemetry),",
        "    rawOffset: published.byteOffset,",
        "    rawBacking: published.buffer.byteLength,",
        "    rawBytes: published.byteLength,",
        "    rawHash: digest(published), bodyHash: digest(artifact.body),",
        "    signature: getNoaaGribRendererSignature(),",
        "  }));",
        "})().catch((error) => { console.error(error); process.exitCode = 1; });",
      ].join("\n");
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: ROOT_DIR,
        env: { ...process.env, MODELVIEW_NOAA_HOVER_ARENA: mode },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };

    const auto = probe("auto");
    const off = probe("off");
    assert.equal(auto.readsBeforeAdmission, 0);
    assert.ok(off.readsBeforeAdmission > 0, "off must eagerly materialize legacy variable planes before scheduling");
    assert.equal(auto.arena, true);
    assert.equal(auto.fallback, null);
    assert.equal(off.arena, false);
    assert.equal(off.fallback, "disabled");
    assert.ok(auto.rawOffset > 0);
    assert.equal(off.rawOffset, 0);
    assert.equal(off.rawBytes, off.rawBacking);
    assert.equal(auto.rawHash, off.rawHash);
    assert.equal(auto.bodyHash, off.bodyHash);
    assert.equal(auto.signature, off.signature);
  },
);
