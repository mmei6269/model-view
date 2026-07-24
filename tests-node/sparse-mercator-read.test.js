"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createFrameDecodeSession,
  decodeSelectedRecordsBulk,
  decodeSelectedRecordsToGrids,
  decodedGridOutcome,
  mercatorGridMappingForSelection,
  mercatorGridPackEntryKey,
  resolveMainDecodeRegridPayloadHash,
} = require("../scripts/lib/noaa-beta/grib-source");
const {
  buildDerivedDecodePlan,
  expectedProfileGridNamesForSelection,
} = require("../scripts/lib/noaa-beta/derived-decode-plan");
const { markBulkDecodedGrid } = require("../scripts/lib/noaa-beta/decode-session");
const { _testBuildDerivedParameterGrids } = require("../scripts/lib/noaa-beta-renderer");
const { selectNoaaNamParameterRecords } = require("../scripts/lib/noaa-beta/selection");

const WIDTH = 4;
const HEIGHT = 4;
const FIELD_BYTES = WIDTH * HEIGHT * Float32Array.BYTES_PER_ELEMENT;
const BOUNDS = Object.freeze({ north: 53, south: 21, west: -129, east: -63 });

function record(recordNumber, param, level) {
  return {
    record: String(recordNumber),
    offset: recordNumber * 2048,
    param,
    level,
    forecast: "3 hour fcst",
    extra: "",
    line: `${recordNumber}:${recordNumber * 2048}:d=2026071613:${param}:${level}:3 hour fcst:`,
  };
}

function directScalar(key, inputKey, param, level) {
  return {
    key,
    kind: "scalar",
    inputKey,
    selector: { param, level },
    required: false,
  };
}

function dcapeProfile(profileLevels, sourceSelectors = []) {
  return {
    key: "dcape",
    kind: "derivedScalar",
    inputKey: "dcape",
    profileVariables: ["TMP"],
    profileLevels,
    completeProfileRequired: true,
    surfaceHeightRequired: false,
    sourceSelectors,
    anySourceKeyGroups: [],
    required: false,
  };
}

function grid(seed) {
  const values = new Float32Array(WIDTH * HEIGHT);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = index === 7 ? Number.NaN : seed + index * 1.125;
  }
  return values;
}

function floatBytes(values) {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function exactGridBytes(actual, expected) {
  assert.ok(actual instanceof Float32Array);
  assert.ok(expected instanceof Float32Array);
  assert.equal(Buffer.compare(floatBytes(actual), floatBytes(expected)), 0);
}

async function createFixture(t, { name, records, catalog, inventoryRecords, linearGrids }) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const gribPath = path.join(dir, "fixture.grib2");
  const wgrib2Path = path.join(dir, "fake-wgrib2.js");
  const callsPath = path.join(dir, "calls.log");
  await fs.promises.writeFile(gribPath, "selected fixture bytes");
  await fs.promises.writeFile(
    `${gribPath}.json`,
    JSON.stringify({ sha256: "b".repeat(64), selectedHash: `${name}-selected` }),
  );

  const selection = selectNoaaNamParameterRecords(records, { catalog, modelKey: "hrrr", targetHour: 3 });
  assert.deepEqual(selection.missingRequired, []);
  assert.ok(selection.availableParameters.includes("dcape"));
  const recordIndexByIdentity = new Map(
    inventoryRecords.map((sourceRecord, index) => [sourceRecord.record, String(index + 1)]),
  );
  const selectedPlan = {
    recordIndexByOriginalRecord: new Map(
      Object.values(selection.records).map((sourceRecord) => [
        sourceRecord.record,
        recordIndexByIdentity.get(sourceRecord.record),
      ]),
    ),
  };
  const inventoryText = inventoryRecords
    .map(
      (sourceRecord, index) =>
        `${index + 1}:${index * FIELD_BYTES}:d=2026071613:${sourceRecord.param}:${sourceRecord.level}:${sourceRecord.forecast}:`,
    )
    .join("\n");
  const fullBody = Buffer.concat(inventoryRecords.map((sourceRecord) => floatBytes(linearGrids.get(sourceRecord))));
  const bodyByDecodeKey = Object.fromEntries(
    Object.entries(selection.records).map(([key, sourceRecord]) => [
      key,
      floatBytes(linearGrids.get(sourceRecord)).toString("base64"),
    ]),
  );
  await fs.promises.writeFile(
    wgrib2Path,
    `#!/usr/bin/env node\n` +
      `"use strict";\n` +
      `const fs = require("fs");\n` +
      `const path = require("path");\n` +
      `const args = process.argv.slice(2);\n` +
      `fs.appendFileSync(${JSON.stringify(callsPath)}, args.join(" ") + "\\n");\n` +
      `if (args.includes("-version")) { console.log("wgrib2 sparse fixture 3.1.0"); process.exit(0); }\n` +
      `const output = args[args.length - 1];\n` +
      `if (!args.includes("-bin")) { fs.writeFileSync(output, "regridded fixture"); process.exit(0); }\n` +
      `const inputKey = path.basename(args[0], ".grib2");\n` +
      `if (inputKey === "selected-regridded") {\n` +
      `  fs.writeFileSync(output, Buffer.from(${JSON.stringify(fullBody.toString("base64"))}, "base64"));\n` +
      `  console.log(${JSON.stringify(inventoryText)});\n` +
      `  process.exit(0);\n` +
      `}\n` +
      `const bodies = ${JSON.stringify(bodyByDecodeKey)};\n` +
      `if (!bodies[inputKey]) { throw new Error("missing fake body for " + inputKey); }\n` +
      `fs.writeFileSync(output, Buffer.from(bodies[inputKey], "base64"));\n`,
  );
  await fs.promises.chmod(wgrib2Path, 0o755);

  return {
    dir,
    gribPath,
    wgrib2Path,
    callsPath,
    selection,
    selectedPlan,
    async tempDir(label) {
      const tempDir = path.join(dir, label);
      await fs.promises.mkdir(tempDir, { recursive: true });
      return tempDir;
    },
    async payloadHash() {
      return resolveMainDecodeRegridPayloadHash({
        gribPath,
        wgrib2Path,
        selection,
        bounds: BOUNDS,
        width: WIDTH,
        height: HEIGHT,
      });
    },
    derivedPlan(regridBinPayloadHash) {
      const expectedNames = expectedProfileGridNamesForSelection(selection);
      assert.deepEqual(expectedNames, ["dcape"]);
      const restoredGrids = Object.fromEntries(
        expectedNames.map((gridName) => [gridName, new Float32Array(WIDTH * HEIGHT).fill(42)]),
      );
      const plan = buildDerivedDecodePlan({
        selection,
        restoredGrids,
        cellCount: WIDTH * HEIGHT,
      });
      assert.equal(plan.valid, true);
      return { ...plan, regridBinPayloadHash };
    },
    async packPaths() {
      const siblings = await fs.promises.readdir(dir);
      const binName = siblings.find((entry) => entry.includes(".mercator-") && entry.endsWith(".bin"));
      const metadataName = siblings.find((entry) => entry.includes(".mercator-") && entry.endsWith(".json"));
      assert.ok(binName, "fixture must publish one Mercator pack body");
      assert.ok(metadataName, "fixture must publish one Mercator pack metadata file");
      return {
        binPath: path.join(dir, binName),
        metadataPath: path.join(dir, metadataName),
      };
    },
  };
}

function mainFixtureOptions() {
  const temp700 = record(1, "TMP", "700 mb");
  const temperature2m = record(2, "TMP", "2 m above ground");
  const temp925 = record(3, "TMP", "925 mb");
  return {
    name: "sparse-mercator-main",
    records: [temp700, temperature2m, temp925],
    catalog: [
      directScalar("temperature700", "temp700", "TMP", "700 mb"),
      dcapeProfile(
        [700, 925],
        [
          {
            key: "temperature2m",
            selector: { param: "TMP", level: "2 m above ground" },
          },
        ],
      ),
    ],
    inventoryRecords: [temp700, temperature2m, temp925],
    linearGrids: new Map([
      [temp700, grid(100)],
      [temperature2m, grid(200)],
      [temp925, grid(300)],
    ]),
  };
}

function frontogenesisFixtureOptions() {
  const surfaceHeight = record(1, "HGT", "surface");
  const temp925 = record(2, "TMP", "925 mb");
  const height925 = record(3, "HGT", "925 mb");
  const temp850 = record(4, "TMP", "850 mb");
  const height850 = record(5, "HGT", "850 mb");
  const wind850U = record(6, "UGRD", "850 mb");
  const wind850V = record(7, "VGRD", "850 mb");
  const cellCount = WIDTH * HEIGHT;
  const surfaceHeightGrid = new Float32Array(cellCount);
  const temp850Grid = new Float32Array(cellCount);
  const height850Grid = new Float32Array(cellCount).fill(1500);
  const wind850UGrid = new Float32Array(cellCount);
  const wind850VGrid = new Float32Array(cellCount);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const index = y * WIDTH + x;
      temp850Grid[index] = 280 + x;
      wind850UGrid[index] = 20 - x;
    }
  }
  surfaceHeightGrid[WIDTH + 1] = 2000;

  return {
    name: "sparse-mercator-frontogenesis",
    records: [surfaceHeight, temp925, height925, temp850, height850, wind850U, wind850V],
    catalog: [
      {
        key: "frontogenesis850",
        kind: "derivedScalar",
        inputKey: "frontogenesis850",
        profileVariables: [],
        profileLevels: [],
        completeProfileRequired: false,
        surfaceHeightRequired: false,
        sourceSelectors: [
          { key: "temp850", selector: { param: "TMP", level: "850 mb" } },
          { key: "wind850U", selector: { param: "UGRD", level: "850 mb" } },
          { key: "wind850V", selector: { param: "VGRD", level: "850 mb" } },
        ],
        anySourceKeyGroups: [],
        required: false,
      },
      {
        ...dcapeProfile([925, 850]),
        profileVariables: ["TMP", "HGT"],
      },
    ],
    inventoryRecords: [surfaceHeight, temp925, height925, temp850, height850, wind850U, wind850V],
    linearGrids: new Map([
      [surfaceHeight, surfaceHeightGrid],
      [temp925, new Float32Array(cellCount).fill(290)],
      [height925, new Float32Array(cellCount).fill(800)],
      [temp850, temp850Grid],
      [height850, height850Grid],
      [wind850U, wind850UGrid],
      [wind850V, wind850VGrid],
    ]),
  };
}

async function coldPublish(fixture, { sparseReadPlan = null, label = "cold" } = {}) {
  const profile = { stages: {} };
  const decodeSession = createFrameDecodeSession(profile);
  decodeSession.collectRegridBinPayloadHashes = [];
  const decoded = await decodeSelectedRecordsBulk({
    gribPath: fixture.gribPath,
    selectedPlan: fixture.selectedPlan,
    selection: fixture.selection,
    hour: 3,
    tempDir: await fixture.tempDir(label),
    wgrib2Path: fixture.wgrib2Path,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    sparseReadPlan,
    profile,
    decodeSession,
  });
  return { decoded, outcome: decodedGridOutcome(decoded), profile, decodeSession };
}

async function warmBulk(fixture, sparseReadPlan, label) {
  const profile = { stages: {} };
  const decodeSession = createFrameDecodeSession(profile);
  decodeSession.collectRegridBinPayloadHashes = [];
  const decoded = await decodeSelectedRecordsBulk({
    gribPath: fixture.gribPath,
    selectedPlan: fixture.selectedPlan,
    selection: fixture.selection,
    hour: 3,
    tempDir: await fixture.tempDir(label),
    wgrib2Path: fixture.wgrib2Path,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    sparseReadPlan,
    profile,
    decodeSession,
  });
  return { decoded, outcome: decodedGridOutcome(decoded), profile, decodeSession };
}

function assertFullWarmRead(result, expectedEntryCount) {
  assert.equal(result.outcome.source, "regrid-pack");
  assert.equal(result.outcome.sparseApplied, false);
  assert.equal(result.outcome.packEntriesRead, expectedEntryCount);
  assert.equal(result.outcome.packEntriesSkipped, 0);
  assert.equal(result.outcome.packBytesRead, expectedEntryCount * FIELD_BYTES);
  assert.equal(result.outcome.packBytesSkipped, 0);
  assert.equal(result.profile.regridBinCacheHits, 1);
  assert.equal(result.profile.regridBinSparseDeclines, 1);
}

test("cold decode ignores a valid sparse plan, publishes the full pack, then an exact warm plan reads retained bytes", async (t) => {
  const fixture = await createFixture(t, mainFixtureOptions());
  const payloadHash = await fixture.payloadHash();
  assert.match(payloadHash, /^[a-f0-9]{64}$/);
  const exactPlan = fixture.derivedPlan(payloadHash);
  assert.deepEqual(exactPlan.omittedDecodeKeys, ["profileTmp925"]);

  const cold = await coldPublish(fixture, { sparseReadPlan: exactPlan });
  assert.equal(cold.outcome.source, "bulk-cold");
  assert.equal(cold.outcome.sparseApplied, false);
  assert.equal(cold.outcome.packEntriesRead, 3);
  assert.equal(cold.outcome.packEntriesSkipped, 0);
  assert.equal(cold.profile.regridBinCacheMisses, 1);
  assert.equal(cold.profile.regridBinSparseHits, undefined);
  assert.deepEqual(Object.keys(cold.decoded).sort(), ["profileTmp925", "temp700", "temperature2m"]);
  const { metadataPath } = await fixture.packPaths();
  const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
  assert.equal(metadata.entries.length, 3, "cold publication must never persist a sparse pack");
  const callsAfterCold = await fs.promises.readFile(fixture.callsPath, "utf8");

  const warm = await warmBulk(fixture, exactPlan, "warm-exact");
  assert.equal(warm.outcome.source, "regrid-pack-sparse");
  assert.equal(warm.outcome.payloadHash, payloadHash);
  assert.equal(warm.outcome.sparseApplied, true);
  assert.equal(warm.outcome.packEntriesRead, 2);
  assert.equal(warm.outcome.packEntriesSkipped, 1);
  assert.equal(warm.outcome.packBytesRead, FIELD_BYTES * 2);
  assert.equal(warm.outcome.packBytesSkipped, FIELD_BYTES);
  assert.equal(warm.profile.regridBinCacheHits, 1);
  assert.equal(warm.profile.regridBinSparseHits, 1);
  assert.equal(warm.profile.regridBinPackEntriesRead, 2);
  assert.equal(warm.profile.regridBinPackEntriesSkipped, 1);
  assert.deepEqual(Object.keys(warm.decoded).sort(), ["temp700", "temperature2m"]);
  exactGridBytes(warm.decoded.temp700, cold.decoded.temp700);
  exactGridBytes(warm.decoded.temperature2m, cold.decoded.temperature2m);
  assert.deepEqual(warm.decodeSession.collectRegridBinPayloadHashes, [payloadHash]);
  assert.equal(
    await fs.promises.readFile(fixture.callsPath, "utf8"),
    callsAfterCold,
    "a warm sparse pack read must not invoke wgrib2",
  );
});

test("sparse decode retains pressure-height support and reproduces terrain-masked frontogenesis output", async (t) => {
  const fixture = await createFixture(t, frontogenesisFixtureOptions());
  const payloadHash = await fixture.payloadHash();
  const plan = fixture.derivedPlan(payloadHash);
  assert.deepEqual(plan.omittedDecodeKeys, ["profileHgt925", "profileTmp925"]);
  assert.ok(plan.retainedDecodeKeys.includes("profileHgt850"));

  const cold = await coldPublish(fixture);
  const warm = await warmBulk(fixture, plan, "warm-frontogenesis");
  assert.equal(warm.outcome.source, "regrid-pack-sparse");
  assert.equal(warm.outcome.packEntriesRead, 5);
  assert.equal(warm.outcome.packEntriesSkipped, 2);
  assert.ok(warm.decoded.profileHgt850);
  assert.equal(warm.decoded.profileHgt925, undefined);
  assert.equal(warm.decoded.profileTmp925, undefined);

  const precomputedProfileDerived = {
    dcape: new Float32Array(WIDTH * HEIGHT).fill(500),
  };
  const derivedOptions = {
    selection: fixture.selection,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    precomputedProfileDerived,
  };
  const fullOutput = _testBuildDerivedParameterGrids({
    ...derivedOptions,
    decoded: cold.decoded,
  });
  const sparseOutput = _testBuildDerivedParameterGrids({
    ...derivedOptions,
    decoded: warm.decoded,
  });
  assert.deepEqual(Object.keys(sparseOutput).sort(), Object.keys(fullOutput).sort());
  exactGridBytes(sparseOutput.frontogenesis850, fullOutput.frontogenesis850);
  exactGridBytes(sparseOutput.dcape, fullOutput.dcape);

  const terrainCell = WIDTH + 1;
  assert.equal(Number.isNaN(fullOutput.frontogenesis850[terrainCell]), true);
  assert.equal(Number.isNaN(sparseOutput.frontogenesis850[terrainCell]), true);
  const withoutPressureHeight = { ...warm.decoded };
  delete withoutPressureHeight.profileHgt850;
  const unmaskedOutput = _testBuildDerivedParameterGrids({
    ...derivedOptions,
    decoded: withoutPressureHeight,
  });
  assert.equal(
    Number.isFinite(unmaskedOutput.frontogenesis850[terrainCell]),
    true,
    "without 850-mb HGT, the below-terrain cell would incorrectly become finite",
  );
});

test("missing/stale pack hashes and a tampered dependency plan fail closed to full warm reads", async (t) => {
  const fixture = await createFixture(t, mainFixtureOptions());
  const payloadHash = await fixture.payloadHash();
  await coldPublish(fixture);
  const exactPlan = fixture.derivedPlan(payloadHash);
  const { regridBinPayloadHash: _omittedHash, ...missingHash } = exactPlan;
  const staleHash = { ...exactPlan, regridBinPayloadHash: "f".repeat(64) };
  const tampered = {
    ...exactPlan,
    omittedDecodeKeys: [...exactPlan.omittedDecodeKeys, "temp700"].sort(),
    retainedDecodeKeys: exactPlan.retainedDecodeKeys.filter((key) => key !== "temp700"),
  };

  for (const [label, plan] of [
    ["missing-hash", missingHash],
    ["stale-hash", staleHash],
    ["tampered", tampered],
  ]) {
    const result = await warmBulk(fixture, plan, label);
    assertFullWarmRead(result, 3);
    assert.deepEqual(Object.keys(result.decoded).sort(), ["profileTmp925", "temp700", "temperature2m"]);
  }
});

test("a retained physical alias keeps its shared pack entry readable while another profile entry is omitted", async (t) => {
  const temp925 = record(1, "TMP", "925 mb");
  const temp900 = record(2, "TMP", "900 mb");
  const fixture = await createFixture(t, {
    name: "sparse-mercator-alias",
    records: [temp925, temp900],
    catalog: [
      directScalar("syntheticTemperature925", "visibleTemperature925", "TMP", "925 mb"),
      dcapeProfile([925, 900]),
    ],
    inventoryRecords: [temp925, temp900],
    linearGrids: new Map([
      [temp925, grid(500)],
      [temp900, grid(600)],
    ]),
  });
  const payloadHash = await fixture.payloadHash();
  const plan = fixture.derivedPlan(payloadHash);
  assert.deepEqual(plan.omittedDecodeKeys, ["profileTmp900"]);
  assert.ok(plan.retainedDecodeKeys.includes("profileTmp925"));
  assert.ok(plan.retainedDecodeKeys.includes("visibleTemperature925"));
  assert.equal(mercatorGridMappingForSelection(fixture.selection).length, 2);

  const cold = await coldPublish(fixture);
  const warm = await warmBulk(fixture, plan, "warm-alias");
  assert.equal(warm.outcome.source, "regrid-pack-sparse");
  assert.equal(warm.outcome.packEntriesRead, 1);
  assert.equal(warm.outcome.packEntriesSkipped, 1);
  assert.deepEqual(Object.keys(warm.decoded).sort(), ["profileTmp925", "visibleTemperature925"]);
  assert.equal(warm.decoded.profileTmp925, warm.decoded.visibleTemperature925);
  exactGridBytes(warm.decoded.profileTmp925, cold.decoded.profileTmp925);
});

test("full and sparse concurrent promises have distinct identities and cannot cross-contaminate", async (t) => {
  const fixture = await createFixture(t, mainFixtureOptions());
  const payloadHash = await fixture.payloadHash();
  await coldPublish(fixture);
  const plan = fixture.derivedPlan(payloadHash);
  const sharedProfile = { stages: {} };
  const sharedSession = createFrameDecodeSession(sharedProfile);
  const fullTempDir = await fixture.tempDir("concurrent-full");
  const sparseTempDir = await fixture.tempDir("concurrent-sparse");
  const common = {
    gribPath: fixture.gribPath,
    selectedPlan: fixture.selectedPlan,
    selection: fixture.selection,
    hour: 3,
    wgrib2Path: fixture.wgrib2Path,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    profile: sharedProfile,
    decodeSession: sharedSession,
  };

  const fullPromise = decodeSelectedRecordsToGrids({ ...common, tempDir: fullTempDir });
  const sparsePromise = decodeSelectedRecordsToGrids({
    ...common,
    tempDir: sparseTempDir,
    sparseReadPlan: plan,
  });
  const [full, sparse] = await Promise.all([fullPromise, sparsePromise]);
  assert.equal(decodedGridOutcome(full).source, "regrid-pack");
  assert.equal(decodedGridOutcome(sparse).source, "regrid-pack-sparse");
  assert.ok(full.profileTmp925);
  assert.equal(sparse.profileTmp925, undefined);
  assert.ok(full.temp700);
  assert.ok(sparse.temp700);
  assert.equal(sharedSession.decodedGridPromises.size, 2);
  assert.equal(sharedSession.counters.decodedGridPromiseHits, 0);

  const sparseAgain = await decodeSelectedRecordsToGrids({
    ...common,
    tempDir: sparseTempDir,
    sparseReadPlan: plan,
  });
  assert.equal(sparseAgain, sparse);
  assert.equal(sharedSession.counters.decodedGridPromiseHits, 1);
});

test("full record-cache reuse carries one exact Mercator-pack hash and rejects mixed provenance", async (t) => {
  const fixture = await createFixture(t, mainFixtureOptions());
  const payloadHash = await fixture.payloadHash();
  const cold = await coldPublish(fixture);
  const common = {
    gribPath: fixture.gribPath,
    selectedPlan: fixture.selectedPlan,
    selection: fixture.selection,
    hour: 3,
    tempDir: await fixture.tempDir("record-cache"),
    wgrib2Path: fixture.wgrib2Path,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    profile: cold.profile,
    decodeSession: cold.decodeSession,
  };

  const exactHit = await decodeSelectedRecordsToGrids(common);
  assert.equal(decodedGridOutcome(exactHit).source, "record-cache");
  assert.equal(decodedGridOutcome(exactHit).allBulkDecoded, true);
  assert.equal(decodedGridOutcome(exactHit).payloadHash, payloadHash);

  markBulkDecodedGrid(cold.decoded.temp700, "f".repeat(64));
  const mixedHit = await decodeSelectedRecordsToGrids(common);
  assert.equal(decodedGridOutcome(mixedHit).source, "record-cache");
  assert.equal(decodedGridOutcome(mixedHit).allBulkDecoded, true);
  assert.equal(decodedGridOutcome(mixedHit).payloadHash, null);
});

test("same-size pack corruption falls back once, invalidates the poison, then cold-rebuilds and warms", async (t) => {
  const fixture = await createFixture(t, mainFixtureOptions());
  const payloadHash = await fixture.payloadHash();
  const cold = await coldPublish(fixture);
  const plan = fixture.derivedPlan(payloadHash);
  const { binPath, metadataPath } = await fixture.packPaths();
  const metadata = JSON.parse(await fs.promises.readFile(metadataPath, "utf8"));
  const temp700EntryKey = mercatorGridPackEntryKey(fixture.selection.records.temp700, "bilinear");
  const temp700Entry = metadata.entries.find((entry) => entry.key === temp700EntryKey);
  assert.ok(temp700Entry);
  const body = await fs.promises.readFile(binPath);
  body[temp700Entry.byteOffset] ^= 0x01;
  await fs.promises.writeFile(binPath, body);
  assert.equal((await fs.promises.stat(binPath)).size, metadata.binBytes);

  const fallbackProfile = { stages: {} };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(" "));
  let fallback;
  try {
    fallback = await decodeSelectedRecordsToGrids({
      gribPath: fixture.gribPath,
      selectedPlan: fixture.selectedPlan,
      selection: fixture.selection,
      hour: 3,
      tempDir: await fixture.tempDir("same-size-corrupt"),
      wgrib2Path: fixture.wgrib2Path,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
      sparseReadPlan: plan,
      profile: fallbackProfile,
      decodeSession: createFrameDecodeSession(fallbackProfile),
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(decodedGridOutcome(fallback).source, "legacy-fallback");
  assert.equal(fallbackProfile.regridBinCacheCorruptions, 1);
  assert.equal(fallbackProfile.regridBinCacheHits, undefined);
  assert.equal(fallbackProfile.regridBinSparseHits, undefined);
  assert.match(warnings.join("\n"), /checksum mismatch/);
  assert.equal(fs.existsSync(metadataPath), false);
  assert.equal(fs.existsSync(binPath), false);
  exactGridBytes(fallback.temp700, cold.decoded.temp700);

  const rebuilt = await coldPublish(fixture, { label: "cold-rebuild-after-corruption" });
  assert.equal(rebuilt.outcome.source, "bulk-cold");
  assert.equal(rebuilt.profile.regridBinCacheMisses, 1);
  const warm = await warmBulk(fixture, plan, "warm-after-corruption-rebuild");
  assert.equal(warm.outcome.source, "regrid-pack-sparse");
  assert.equal(warm.profile.regridBinCacheHits, 1);
  assert.equal(warm.profile.regridBinSparseHits, 1);
  exactGridBytes(warm.decoded.temp700, cold.decoded.temp700);
});

test("a short sparse pack read falls back to full legacy decode, while strict mode propagates the read error", async (t) => {
  const fixture = await createFixture(t, mainFixtureOptions());
  const payloadHash = await fixture.payloadHash();
  const cold = await coldPublish(fixture);
  const plan = fixture.derivedPlan(payloadHash);
  const originalOpen = fs.promises.open;
  const originalStrict = process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE;
  const originalWarn = console.warn;

  async function sabotageNextPackOpen() {
    const { binPath } = await fixture.packPaths();
    let sabotaged = false;
    fs.promises.open = async function patchedOpen(filePath, ...args) {
      if (!sabotaged && String(filePath) === binPath) {
        sabotaged = true;
        await fs.promises.truncate(binPath, 0);
      }
      return originalOpen.call(this, filePath, ...args);
    };
  }

  try {
    delete process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE;
    await sabotageNextPackOpen();
    const fallbackProfile = { stages: {} };
    const warnings = [];
    console.warn = (...parts) => warnings.push(parts.join(" "));
    const fallback = await decodeSelectedRecordsToGrids({
      gribPath: fixture.gribPath,
      selectedPlan: fixture.selectedPlan,
      selection: fixture.selection,
      hour: 3,
      tempDir: await fixture.tempDir("short-fallback"),
      wgrib2Path: fixture.wgrib2Path,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
      sparseReadPlan: plan,
      profile: fallbackProfile,
      decodeSession: createFrameDecodeSession(fallbackProfile),
    });
    assert.equal(decodedGridOutcome(fallback).source, "legacy-fallback");
    assert.equal(decodedGridOutcome(fallback).sparseApplied, false);
    assert.equal(fallbackProfile.bulkDecodeFallbacks, 1);
    assert.equal(fallbackProfile.regridBinSparseHits, undefined);
    assert.match(warnings.join("\n"), /falling back to legacy per-record decode/);
    assert.deepEqual(Object.keys(fallback).sort(), ["profileTmp925", "temp700", "temperature2m"]);
    exactGridBytes(fallback.temp700, cold.decoded.temp700);
    exactGridBytes(fallback.temperature2m, cold.decoded.temperature2m);
    exactGridBytes(fallback.profileTmp925, cold.decoded.profileTmp925);

    fs.promises.open = originalOpen;
    console.warn = originalWarn;
    await coldPublish(fixture, { label: "rebuild-after-short-read" });
    await sabotageNextPackOpen();
    process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE = "1";
    await assert.rejects(
      decodeSelectedRecordsToGrids({
        gribPath: fixture.gribPath,
        selectedPlan: fixture.selectedPlan,
        selection: fixture.selection,
        hour: 3,
        tempDir: await fixture.tempDir("short-strict"),
        wgrib2Path: fixture.wgrib2Path,
        bounds: BOUNDS,
        width: WIDTH,
        height: HEIGHT,
        sparseReadPlan: plan,
        profile: { stages: {} },
        decodeSession: createFrameDecodeSession(),
      }),
      /read .* expected/i,
    );
  } finally {
    fs.promises.open = originalOpen;
    console.warn = originalWarn;
    if (originalStrict === undefined) {
      delete process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE;
    } else {
      process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE = originalStrict;
    }
  }
});
