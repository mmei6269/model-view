"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { cacheMetadataWithPayload, cachePayloadDescriptor } = require("../scripts/lib/noaa-beta/cache-io");
const {
  REGRIDDED_BIN_CACHE_VERSION,
  buildNoaaRegridArgs,
  createFrameDecodeSession,
  decodeSelectedRecordsBulk,
  decodeSelectedRecordsToGrids,
  decodedGridOutcome,
  decodedSelectionCacheKey,
  mercatorGridMappingForSelection,
  mercatorGridPackEntryKey,
  mercatorGridPackManifestSha256,
  probeMainDecodeWarmPack,
  readRegriddedBinCache,
  regriddedBinMemoKey,
  resolveMainDecodeRegridPayloadHash,
  resolveRegriddedBinCacheContextFromSelectedMetadata,
  validatedMercatorGridPackMetadata,
  writeRegriddedBinCache,
} = require("../scripts/lib/noaa-beta/grib-source");
const {
  decodeSouthNorthBinaryGridBuffer,
  readPackedFloat32GridFileSlice,
} = require("../scripts/lib/noaa-beta/grid-ops");

const WIDTH = 4;
const HEIGHT = 4;
const FIELD_BYTES = WIDTH * HEIGHT * Float32Array.BYTES_PER_ELEMENT;
const BOUNDS = Object.freeze({ north: 53, south: 21, west: -129, east: -63 });

function record(overrides = {}) {
  return {
    record: "17",
    offset: 2048,
    param: "TMP",
    level: "2 m above ground",
    forecast: "3 hour fcst",
    line: "17:2048:d=2026071613:TMP:2 m above ground:3 hour fcst:",
    ...overrides,
  };
}

function makeContext(dir, mapping, nonce) {
  const payload = {
    kind: REGRIDDED_BIN_CACHE_VERSION,
    selectedSha256: "a".repeat(64),
    selectedHash: "selected",
    regridArgs: ["fixture"],
    exportArgs: ["-bin"],
    wgrib2: "fixture-wgrib2",
    gridShape: { width: WIDTH, height: HEIGHT, fieldBytes: FIELD_BYTES },
    byteOrder: os.endianness(),
    gridMapping: [...mapping].sort(),
    nonce,
  };
  const { payloadHash } = cachePayloadDescriptor(payload);
  return {
    payload,
    payloadHash,
    binPath: path.join(dir, `${nonce}.mercator.bin`),
    metadataPath: path.join(dir, `${nonce}.mercator.json`),
    previousBinPath: path.join(dir, `${nonce}.mercator-v2.bin`),
    previousMetadataPath: path.join(dir, `${nonce}.mercator-v2.json`),
    legacyBinPath: path.join(dir, `${nonce}.legacy.bin`),
    legacyMetadataPath: path.join(dir, `${nonce}.legacy.json`),
  };
}

function floatBytes(values) {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function linearGridBody() {
  const values = new Float32Array(WIDTH * HEIGHT);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = index % 7 === 0 ? Number.NaN : index * 1.25 - 8;
  }
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

test("Mercator grid-pack round-trips exact bilinear and nearest Float32 bytes in canonical order", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mercator-grid-pack-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const sourceRecord = record();
  const bilinearKey = mercatorGridPackEntryKey(sourceRecord, "bilinear");
  const nearestKey = mercatorGridPackEntryKey(sourceRecord, "nearest");
  const context = makeContext(dir, [nearestKey, bilinearKey], "roundtrip");
  const body = linearGridBody();
  const bilinear = decodeSouthNorthBinaryGridBuffer({
    body,
    byteOffset: 0,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    rowInterpolation: "bilinear",
  });
  const nearest = decodeSouthNorthBinaryGridBuffer({
    body,
    byteOffset: 0,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    rowInterpolation: "nearest",
  });
  await fs.promises.writeFile(context.legacyBinPath, "legacy-large-bin");
  await fs.promises.writeFile(context.legacyMetadataPath, "legacy-sidecar");
  await fs.promises.writeFile(context.previousBinPath, "unchecksummed-v2-large-bin");
  await fs.promises.writeFile(context.previousMetadataPath, "unchecksummed-v2-sidecar");

  assert.equal(
    await writeRegriddedBinCache(context, {
      // Deliberately reverse canonical key order.
      gridEntries: [
        { key: nearestKey, values: nearest },
        { key: bilinearKey, values: bilinear },
      ],
    }),
    true,
  );
  assert.equal(fs.existsSync(context.legacyBinPath), false, "v3 publication replaces the v1 payload");
  assert.equal(fs.existsSync(context.legacyMetadataPath), false, "v3 publication replaces the v1 sidecar");
  assert.equal(fs.existsSync(context.previousBinPath), false, "v3 publication replaces the unchecksummed v2 payload");
  assert.equal(
    fs.existsSync(context.previousMetadataPath),
    false,
    "v3 publication replaces the unchecksummed v2 sidecar",
  );

  const metadata = JSON.parse(await fs.promises.readFile(context.metadataPath, "utf8"));
  assert.deepEqual(
    metadata.entries.map((entry) => entry.key),
    [bilinearKey, nearestKey].sort(),
    "pack layout must be deterministic regardless of decode traversal order",
  );
  assert.deepEqual(
    metadata.entries.map((entry) => entry.byteOffset),
    [0, FIELD_BYTES],
  );

  const cached = await readRegriddedBinCache(context);
  assert.ok(cached);
  const handle = await fs.promises.open(context.binPath, "r");
  try {
    const restoredBilinear = await readPackedFloat32GridFileSlice({
      fileHandle: handle,
      byteOffset: cached.entryByKey.get(bilinearKey).byteOffset,
      fieldBytes: FIELD_BYTES,
    });
    const restoredNearest = await readPackedFloat32GridFileSlice({
      fileHandle: handle,
      byteOffset: cached.entryByKey.get(nearestKey).byteOffset,
      fieldBytes: FIELD_BYTES,
    });
    assert.equal(Buffer.compare(floatBytes(restoredBilinear), floatBytes(bilinear)), 0);
    assert.equal(Buffer.compare(floatBytes(restoredNearest), floatBytes(nearest)), 0);
  } finally {
    await handle.close();
  }
});

test("Mercator grid mapping and memo identity distinguish nearest from bilinear consumption", () => {
  const sourceRecord = record();
  const bilinear = mercatorGridMappingForSelection({ records: { temperature2m: sourceRecord } }, true);
  const nearest = mercatorGridMappingForSelection({ records: { precipTypeRain: sourceRecord } }, true);
  assert.notDeepEqual(bilinear, nearest);
  assert.notEqual(
    regriddedBinMemoKey("fixture.grib2", ["regrid"], bilinear, WIDTH, HEIGHT),
    regriddedBinMemoKey("fixture.grib2", ["regrid"], nearest, WIDTH, HEIGHT),
  );
});

test("Mercator grid-pack metadata rejects missing mappings, overlapping entries, and truncation", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mercator-grid-corrupt-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const firstKey = mercatorGridPackEntryKey(record(), "bilinear");
  const secondKey = mercatorGridPackEntryKey(record({ record: "18", offset: 4096, param: "RH" }), "bilinear");
  const context = makeContext(dir, [firstKey, secondKey], "corrupt");
  const validEntries = [{ key: firstKey, byteOffset: 0, crc32: "a".repeat(8) }];
  const validMissingEntryKeys = [secondKey];
  const valid = cacheMetadataWithPayload(context.payload, {
    fieldBytes: FIELD_BYTES,
    binBytes: FIELD_BYTES,
    entries: validEntries,
    missingEntryKeys: validMissingEntryKeys,
    entryManifestSha256: mercatorGridPackManifestSha256({
      fieldBytes: FIELD_BYTES,
      binBytes: FIELD_BYTES,
      entries: validEntries,
      missingEntryKeys: validMissingEntryKeys,
    }),
  });
  assert.ok(validatedMercatorGridPackMetadata(valid, context.payload));
  assert.equal(
    validatedMercatorGridPackMetadata(
      {
        ...valid,
        missingEntryKeys: [],
        entryManifestSha256: mercatorGridPackManifestSha256({
          fieldBytes: FIELD_BYTES,
          binBytes: FIELD_BYTES,
          entries: validEntries,
          missingEntryKeys: [],
        }),
      },
      context.payload,
    ),
    null,
    "every expected mapping must be represented",
  );
  assert.equal(
    validatedMercatorGridPackMetadata(
      {
        ...valid,
        entries: [{ ...validEntries[0], key: secondKey }],
        missingEntryKeys: [firstKey],
      },
      context.payload,
    ),
    null,
    "the checksummed entry manifest must reject a key/offset swap",
  );
  assert.equal(
    validatedMercatorGridPackMetadata(
      {
        ...valid,
        entries: [{ ...validEntries[0], crc32: "b".repeat(8) }],
      },
      context.payload,
    ),
    null,
    "a valid-looking CRC change must be rejected unless the SHA-256-bound manifest also matches",
  );
  const overlappingEntries = [
    { key: firstKey, byteOffset: 0, crc32: "a".repeat(8) },
    { key: secondKey, byteOffset: 0, crc32: "b".repeat(8) },
  ];
  assert.equal(
    validatedMercatorGridPackMetadata(
      {
        ...valid,
        binBytes: FIELD_BYTES * 2,
        entries: overlappingEntries,
        missingEntryKeys: [],
        entryManifestSha256: mercatorGridPackManifestSha256({
          fieldBytes: FIELD_BYTES,
          binBytes: FIELD_BYTES * 2,
          entries: overlappingEntries,
          missingEntryKeys: [],
        }),
      },
      context.payload,
    ),
    null,
    "entry byte ranges may not overlap",
  );

  const first = new Float32Array(WIDTH * HEIGHT).fill(3.25);
  const second = new Float32Array(WIDTH * HEIGHT).fill(-7.5);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(" "));
  try {
    assert.equal(
      await writeRegriddedBinCache(context, {
        gridEntries: [{ key: firstKey, values: first }],
        missingEntryKeys: [firstKey, secondKey],
      }),
      false,
      "a key cannot be both present and missing",
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.equal(fs.existsSync(context.binPath), false);
  assert.equal(fs.existsSync(context.metadataPath), false);
  assert.equal(
    await writeRegriddedBinCache(context, {
      gridEntries: [
        { key: firstKey, values: first },
        { key: secondKey, values: second },
      ],
    }),
    true,
  );
  await fs.promises.truncate(context.binPath, FIELD_BYTES + 1);
  assert.equal(await readRegriddedBinCache(context), null, "a truncated pack must become a cold-cache miss");
});

test("Mercator grid-pack write failures are contained and leave no temporary file", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mercator-grid-write-fail-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const key = mercatorGridPackEntryKey(record(), "bilinear");
  const context = makeContext(path.join(dir, "missing-parent"), [key], "failure");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(" "));
  try {
    assert.equal(
      await writeRegriddedBinCache(context, {
        gridEntries: [{ key, values: new Float32Array(WIDTH * HEIGHT) }],
      }),
      false,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /regridded-bin cache write failed/);
  assert.deepEqual(
    (await fs.promises.readdir(dir)).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("failed v3 metadata publication preserves exact v2 and v1 migration siblings", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mercator-grid-migration-fail-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const key = mercatorGridPackEntryKey(record(), "bilinear");
  const context = makeContext(dir, [key], "migration-failure");
  await fs.promises.writeFile(context.previousBinPath, "v2-body");
  await fs.promises.writeFile(context.previousMetadataPath, "v2-metadata");
  await fs.promises.writeFile(context.legacyBinPath, "v1-body");
  await fs.promises.writeFile(context.legacyMetadataPath, "v1-metadata");

  const originalRename = fs.promises.rename;
  const originalWarn = console.warn;
  const warnings = [];
  fs.promises.rename = async (source, destination) => {
    if (destination === context.metadataPath) {
      throw new Error("injected v3 metadata publication failure");
    }
    return originalRename(source, destination);
  };
  console.warn = (...parts) => warnings.push(parts.join(" "));
  try {
    assert.equal(
      await writeRegriddedBinCache(context, {
        gridEntries: [{ key, values: new Float32Array(WIDTH * HEIGHT) }],
      }),
      false,
    );
  } finally {
    fs.promises.rename = originalRename;
    console.warn = originalWarn;
  }

  assert.equal(await fs.promises.readFile(context.previousBinPath, "utf8"), "v2-body");
  assert.equal(await fs.promises.readFile(context.previousMetadataPath, "utf8"), "v2-metadata");
  assert.equal(await fs.promises.readFile(context.legacyBinPath, "utf8"), "v1-body");
  assert.equal(await fs.promises.readFile(context.legacyMetadataPath, "utf8"), "v1-metadata");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /injected v3 metadata publication failure/);
});

test("bulk decoder cold-publishes and warm-loads the replacement pack with exact provenance identity", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mercator-grid-integration-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const gribPath = path.join(dir, "fixture.grib2");
  const wgrib2Path = path.join(dir, "fake-wgrib2.js");
  const callsPath = path.join(dir, "calls.log");
  const coldTempDir = path.join(dir, "cold");
  const warmTempDir = path.join(dir, "warm");
  await fs.promises.mkdir(coldTempDir);
  await fs.promises.mkdir(warmTempDir);
  await fs.promises.writeFile(gribPath, "selected fixture bytes");
  await fs.promises.writeFile(
    `${gribPath}.json`,
    JSON.stringify({ sha256: "b".repeat(64), selectedHash: "c".repeat(24) }),
  );
  const firstLinear = new Float32Array(WIDTH * HEIGHT);
  const secondLinear = new Float32Array(WIDTH * HEIGHT);
  for (let index = 0; index < firstLinear.length; index += 1) {
    firstLinear[index] = index * 2.5 - 12;
    secondLinear[index] = index % 3 === 0 ? 1 : 0;
  }
  const fixtureBody = Buffer.concat([floatBytes(firstLinear), floatBytes(secondLinear)]);
  await fs.promises.writeFile(
    wgrib2Path,
    `#!/usr/bin/env node\n` +
      `"use strict";\n` +
      `const fs = require("fs");\n` +
      `const args = process.argv.slice(2);\n` +
      `fs.appendFileSync(${JSON.stringify(callsPath)}, args.join(" ") + "\\n");\n` +
      `if (args.includes("-version")) { console.log("wgrib2 fixture 3.1.0"); process.exit(0); }\n` +
      `const output = args[args.length - 1];\n` +
      `if (args.includes("-bin")) {\n` +
      `  fs.writeFileSync(output, Buffer.from(${JSON.stringify(fixtureBody.toString("base64"))}, "base64"));\n` +
      `  console.log("1:0:d=2026071613:TMP:2 m above ground:3 hour fcst:\\n2:${FIELD_BYTES}:d=2026071613:CRAIN:surface:3 hour fcst:");\n` +
      `} else { fs.writeFileSync(output, "regridded fixture"); }\n`,
  );
  await fs.promises.chmod(wgrib2Path, 0o755);

  const temperatureRecord = record();
  const rainRecord = record({
    record: "18",
    offset: 4096,
    param: "CRAIN",
    level: "surface",
    line: "18:4096:d=2026071613:CRAIN:surface:3 hour fcst:",
  });
  const selection = {
    catalog: [],
    records: { temperature2m: temperatureRecord, precipTypeRain: rainRecord },
  };
  const coldProfile = { stages: {} };
  const coldSession = createFrameDecodeSession(coldProfile);
  coldSession.collectRegridBinPayloadHashes = [];
  const cold = await decodeSelectedRecordsBulk({
    gribPath,
    selection,
    hour: 3,
    tempDir: coldTempDir,
    wgrib2Path,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    profile: coldProfile,
    decodeSession: coldSession,
  });
  assert.equal(coldProfile.regridBinCacheMisses, 1);
  assert.ok(coldProfile.stages.regridBinPersistMs >= 0);
  assert.equal(coldSession.collectRegridBinPayloadHashes.length, 1);
  const expectedTemperature = decodeSouthNorthBinaryGridBuffer({
    body: floatBytes(firstLinear),
    byteOffset: 0,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    rowInterpolation: "bilinear",
  });
  const expectedRain = decodeSouthNorthBinaryGridBuffer({
    body: floatBytes(secondLinear),
    byteOffset: 0,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    rowInterpolation: "nearest",
  });
  assert.equal(Buffer.compare(floatBytes(cold.temperature2m), floatBytes(expectedTemperature)), 0);
  assert.equal(Buffer.compare(floatBytes(cold.precipTypeRain), floatBytes(expectedRain)), 0);

  const callsAfterCold = (await fs.promises.readFile(callsPath, "utf8")).trim().split("\n").length;
  const warmProfile = { stages: {} };
  const warmSession = createFrameDecodeSession(warmProfile);
  warmSession.collectRegridBinPayloadHashes = [];
  const warm = await decodeSelectedRecordsBulk({
    gribPath,
    selection,
    hour: 3,
    tempDir: warmTempDir,
    wgrib2Path,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    profile: warmProfile,
    decodeSession: warmSession,
  });
  assert.equal(warmProfile.regridBinCacheHits, 1);
  assert.equal((await fs.promises.readFile(callsPath, "utf8")).trim().split("\n").length, callsAfterCold);
  assert.equal(Buffer.compare(floatBytes(warm.temperature2m), floatBytes(cold.temperature2m)), 0);
  assert.equal(Buffer.compare(floatBytes(warm.precipTypeRain), floatBytes(cold.precipTypeRain)), 0);
  assert.deepEqual(warmSession.collectRegridBinPayloadHashes, coldSession.collectRegridBinPayloadHashes);
  assert.equal(
    await resolveMainDecodeRegridPayloadHash({
      gribPath,
      wgrib2Path,
      selection,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
      decodeSession: warmSession,
    }),
    coldSession.collectRegridBinPayloadHashes[0],
  );

  const siblings = await fs.promises.readdir(dir);
  const packBinNames = siblings.filter((name) => name.includes(".mercator-") && name.endsWith(".bin"));
  const packMetadataNames = siblings.filter((name) => name.includes(".mercator-") && name.endsWith(".json"));
  assert.equal(packBinNames.length, 1);
  assert.equal(packMetadataNames.length, 1);
  assert.equal(siblings.filter((name) => name.includes(".regrid-") && name.endsWith(".bin")).length, 0);
  const packBinPath = path.join(dir, packBinNames[0]);
  const packMetadataPath = path.join(dir, packMetadataNames[0]);
  const originalPackBody = await fs.promises.readFile(packBinPath);
  const selectedMetadata = JSON.parse(await fs.promises.readFile(`${gribPath}.json`, "utf8"));

  // Context construction from captured metadata must remain possible after
  // the selected sidecar disappears; the candidate path must not reopen it.
  await fs.promises.rm(`${gribPath}.json`);
  const capturedContext = await resolveRegriddedBinCacheContextFromSelectedMetadata({
    gribPath,
    selectedMetadata,
    wgrib2Path,
    regridArgsSignature: ["captured-metadata-test"],
    gridMapping: mercatorGridMappingForSelection(selection),
    width: WIDTH,
    height: HEIGHT,
  });
  assert.equal(capturedContext.payload.selectedSha256, selectedMetadata.sha256);
  assert.equal(capturedContext.payload.selectedHash, selectedMetadata.selectedHash);
  const exactCacheContext = await resolveRegriddedBinCacheContextFromSelectedMetadata({
    gribPath,
    selectedMetadata,
    wgrib2Path,
    regridArgsSignature: buildNoaaRegridArgs({
      gribPath: "",
      gridPath: "",
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
      useCategoricalPrecipTypeInterpolation: true,
    }).slice(1, -1),
    gridMapping: mercatorGridMappingForSelection(selection),
    width: WIDTH,
    height: HEIGHT,
  });
  assert.equal(exactCacheContext.binPath, packBinPath);
  assert.equal(exactCacheContext.metadataPath, packMetadataPath);

  assert.equal(
    await probeMainDecodeWarmPack({
      gribPath,
      selectedMetadata: { ...selectedMetadata, sha256: "not-a-sha" },
      wgrib2Path,
      selection,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
    }),
    null,
  );
  const requiredRegridPack = await probeMainDecodeWarmPack({
    gribPath,
    selectedMetadata,
    wgrib2Path,
    selection,
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
  });
  assert.ok(requiredRegridPack);
  assert.equal(Object.isFrozen(requiredRegridPack), true);
  assert.equal(requiredRegridPack.payloadHash, coldSession.collectRegridBinPayloadHashes[0]);
  assert.equal(requiredRegridPack.selectedMetadata, selectedMetadata);
  assert.notEqual(
    decodedSelectionCacheKey({
      gribPath,
      selection,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
      categoricalPrecipTypeInterpolation: true,
    }),
    decodedSelectionCacheKey({
      gribPath,
      selection,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
      categoricalPrecipTypeInterpolation: true,
      requiredRegridPack,
    }),
    "required-pack and ordinary decodes must not share the same session promise",
  );

  async function decodeRequired(label, profile = { stages: {} }, pack = requiredRegridPack) {
    const tempDir = path.join(dir, label);
    await fs.promises.mkdir(tempDir);
    return decodeSelectedRecordsToGrids({
      gribPath,
      selection,
      hour: 3,
      tempDir,
      wgrib2Path,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
      profile,
      decodeSession: createFrameDecodeSession(profile),
      requiredRegridPack: pack,
    });
  }

  const callsBeforeRequired = (await fs.promises.readFile(callsPath, "utf8")).trim().split("\n").length;
  const strict = await decodeRequired("strict-valid");
  assert.equal(decodedGridOutcome(strict).source, "regrid-pack");
  assert.equal(decodedGridOutcome(strict).payloadHash, requiredRegridPack.payloadHash);
  assert.equal(Buffer.compare(floatBytes(strict.temperature2m), floatBytes(cold.temperature2m)), 0);
  assert.equal(Buffer.compare(floatBytes(strict.precipTypeRain), floatBytes(cold.precipTypeRain)), 0);
  assert.equal(
    (await fs.promises.readFile(callsPath, "utf8")).trim().split("\n").length,
    callsBeforeRequired,
    "a valid required pack must not invoke wgrib2",
  );

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(" "));
  try {
    const mismatchTempDir = path.join(dir, "strict-mismatch");
    await fs.promises.mkdir(mismatchTempDir);
    await assert.rejects(
      decodeSelectedRecordsToGrids({
        gribPath,
        selection,
        hour: 3,
        tempDir: mismatchTempDir,
        wgrib2Path,
        bounds: BOUNDS,
        width: WIDTH + 1,
        height: HEIGHT,
        profile: { stages: {} },
        decodeSession: createFrameDecodeSession(),
        requiredRegridPack,
      }),
      (error) => {
        assert.equal(error.code, "NOAA_REGRID_PACK_REQUIRED_MISMATCH");
        return true;
      },
    );

    const forgedTempDir = path.join(dir, "strict-forged");
    await fs.promises.mkdir(forgedTempDir);
    await assert.rejects(
      decodeSelectedRecordsToGrids({
        gribPath,
        selection,
        hour: 3,
        tempDir: forgedTempDir,
        wgrib2Path,
        bounds: BOUNDS,
        width: WIDTH,
        height: HEIGHT,
        profile: { stages: {} },
        decodeSession: createFrameDecodeSession(),
        requiredRegridPack: { payloadHash: requiredRegridPack.payloadHash },
      }),
      (error) => {
        assert.equal(error.code, "NOAA_REGRID_PACK_REQUIRED_INVALID");
        return true;
      },
    );

    await fs.promises.truncate(packBinPath, FIELD_BYTES);
    await assert.rejects(decodeRequired("strict-short"), (error) => {
      assert.equal(error.code, "NOAA_REGRID_PACK_REQUIRED_MISS");
      return true;
    });
    await fs.promises.writeFile(packBinPath, originalPackBody);
    const restoredAfterShort = await probeMainDecodeWarmPack({
      gribPath,
      selectedMetadata,
      wgrib2Path,
      selection,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
    });
    assert.ok(restoredAfterShort);

    await fs.promises.rm(packBinPath);
    await assert.rejects(decodeRequired("strict-absent", { stages: {} }, restoredAfterShort), (error) => {
      assert.equal(error.code, "NOAA_REGRID_PACK_REQUIRED_MISS");
      return true;
    });
    await fs.promises.writeFile(packBinPath, originalPackBody);

    const corruptPackBody = Buffer.from(originalPackBody);
    corruptPackBody[0] ^= 0x01;
    await fs.promises.writeFile(packBinPath, corruptPackBody);
    const structurallyProbedCorruptPack = await probeMainDecodeWarmPack({
      gribPath,
      selectedMetadata,
      wgrib2Path,
      selection,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
    });
    assert.ok(
      structurallyProbedCorruptPack,
      "the metadata probe is structural; consumed entries remain CRC-validated by decode",
    );
    await assert.rejects(decodeRequired("strict-corrupt", { stages: {} }, structurallyProbedCorruptPack), (error) => {
      assert.equal(error.code, "NOAA_REGRID_PACK_INTEGRITY");
      return true;
    });
    assert.equal(fs.existsSync(packBinPath), true, "a provisional strict decode must not delete the shared body");
    assert.equal(
      fs.existsSync(packMetadataPath),
      true,
      "a provisional strict decode must not delete the shared metadata",
    );

    const replacementTemperature = new Float32Array(WIDTH * HEIGHT).fill(91.25);
    const replacementRain = new Float32Array(WIDTH * HEIGHT).fill(1);
    assert.equal(
      await writeRegriddedBinCache(exactCacheContext, {
        gridEntries: [
          {
            key: mercatorGridPackEntryKey(temperatureRecord, "bilinear"),
            values: replacementTemperature,
          },
          {
            key: mercatorGridPackEntryKey(rainRecord, "nearest"),
            values: replacementRain,
          },
        ],
      }),
      true,
    );
    const preReplacementPack = await probeMainDecodeWarmPack({
      gribPath,
      selectedMetadata,
      wgrib2Path,
      selection,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
    });
    assert.ok(preReplacementPack);
    const secondReplacementTemperature = new Float32Array(WIDTH * HEIGHT).fill(-42.5);
    const secondReplacementRain = new Float32Array(WIDTH * HEIGHT).fill(0);
    assert.equal(
      await writeRegriddedBinCache(exactCacheContext, {
        gridEntries: [
          {
            key: mercatorGridPackEntryKey(temperatureRecord, "bilinear"),
            values: secondReplacementTemperature,
          },
          {
            key: mercatorGridPackEntryKey(rainRecord, "nearest"),
            values: secondReplacementRain,
          },
        ],
      }),
      true,
    );
    await assert.rejects(decodeRequired("strict-replaced-generation", { stages: {} }, preReplacementPack), (error) => {
      assert.equal(error.code, "NOAA_REGRID_PACK_RACE");
      return true;
    });

    const replacementPack = await probeMainDecodeWarmPack({
      gribPath,
      selectedMetadata,
      wgrib2Path,
      selection,
      bounds: BOUNDS,
      width: WIDTH,
      height: HEIGHT,
    });
    assert.ok(replacementPack);
    const replacementDecoded = await decodeRequired("strict-replacement-valid", { stages: {} }, replacementPack);
    assert.equal(
      Buffer.compare(floatBytes(replacementDecoded.temperature2m), floatBytes(secondReplacementTemperature)),
      0,
    );
    assert.equal(Buffer.compare(floatBytes(replacementDecoded.precipTypeRain), floatBytes(secondReplacementRain)), 0);

    const originalOpen = fs.promises.open;
    const metadataBody = await fs.promises.readFile(packMetadataPath);
    let metadataReplacedDuringRead = false;
    fs.promises.open = async function patchedOpen(filePath, ...args) {
      const handle = await originalOpen.call(this, filePath, ...args);
      if (String(filePath) !== packBinPath) {
        return handle;
      }
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs);
        if (!metadataReplacedDuringRead) {
          metadataReplacedDuringRead = true;
          const replacementPath = `${packMetadataPath}.generation-race`;
          await fs.promises.writeFile(replacementPath, metadataBody);
          await fs.promises.rename(replacementPath, packMetadataPath);
        }
        return result;
      };
      return handle;
    };
    try {
      await assert.rejects(
        decodeRequired("strict-during-read-replacement", { stages: {} }, replacementPack),
        (error) => {
          assert.equal(error.code, "NOAA_REGRID_PACK_RACE");
          return true;
        },
      );
    } finally {
      fs.promises.open = originalOpen;
    }
    assert.equal(metadataReplacedDuringRead, true);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [], "required-pack failures must never warn about or enter legacy fallback");
  assert.equal(
    (await fs.promises.readFile(callsPath, "utf8")).trim().split("\n").length,
    callsBeforeRequired,
    "absent, short, and corrupt required packs must not invoke wgrib2 or legacy decode",
  );
});

test("packed Float32 slice reader rejects a short body instead of returning partial science data", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mercator-grid-short-read-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const binPath = path.join(dir, "short.bin");
  await fs.promises.writeFile(binPath, Buffer.alloc(FIELD_BYTES - 4));
  const handle = await fs.promises.open(binPath, "r");
  try {
    await assert.rejects(
      readPackedFloat32GridFileSlice({ fileHandle: handle, byteOffset: 0, fieldBytes: FIELD_BYTES }),
      /read .* expected/,
    );
  } finally {
    await handle.close();
  }
});
