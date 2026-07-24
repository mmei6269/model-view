"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DERIVED_GRID_CACHE_VERSION,
  buildDerivedGridCacheContext,
  drainDerivedGridCacheWrites,
  readDerivedGridCache,
  scheduleDerivedGridCacheWrite,
  writeDerivedGridCache,
} = require("../scripts/lib/noaa-beta/derived-grid-cache");
const { cacheMetadataWithPayload, cachePayloadDescriptor } = require("../scripts/lib/noaa-beta/cache-io");

const CELL_COUNT = 16;
const PRODUCTS = Object.freeze(["dcape", "supercellCompositeParameter", "significantTornadoParameter"]);
// Output grids are deliberately not inferred from the product roster:
// legacy SCP consumes effectiveBulkShear and fixed-layer STP consumes
// bulkShear0to6km.
const EXPECTED_GRID_NAMES = Object.freeze(["bulkShear0to6km", "dcape", "effectiveBulkShear"]);

function makeContext(gribPath, overrides = {}) {
  return buildDerivedGridCacheContext({
    gribPath,
    regridBinPayloadHashes: ["a".repeat(64), "b".repeat(64)],
    methodologyVersion: "derived-profile-grids-v1+parcel-wasm-sha256:kernel-a",
    catalogVersion: "noaa-grib2-catalog-v4",
    products: PRODUCTS,
    expectedGridNames: EXPECTED_GRID_NAMES,
    cellCount: CELL_COUNT,
    ...overrides,
  });
}

function makeGrid(seed, { subarray = false } = {}) {
  const backing = new Float32Array(CELL_COUNT + (subarray ? 2 : 0));
  const values = subarray ? backing.subarray(1, 1 + CELL_COUNT) : backing;
  for (let index = 0; index < values.length; index += 1) {
    values[index] = Math.fround(seed * 100 + index / 7);
  }
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  bits[1] = 0x7fc12345 + seed;
  bits[5] = 0x80000000;
  return values;
}

function makeGrids(seed = 1) {
  // Reverse insertion order verifies that persistence is canonicalized.
  return {
    effectiveBulkShear: makeGrid(seed + 2, { subarray: true }),
    dcape: makeGrid(seed + 1),
    bulkShear0to6km: makeGrid(seed),
  };
}

function exactGridBytes(values) {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function gridSetMatches(actual, expected) {
  return EXPECTED_GRID_NAMES.every(
    (name) => actual[name] && expected[name] && exactGridBytes(actual[name]).equals(exactGridBytes(expected[name])),
  );
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function legacyProfileSidecarPaths(gribPath, token = "0123456789abcdef") {
  const stem = `${gribPath}.derived-${token}`;
  return [`${stem}.bin`, `${stem}.json`];
}

test("profile v2 round-trips exact owning Float32 grids with canonical coverage and SHA-256", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-v2-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
  const grids = makeGrids();

  assert.ok(context);
  assert.equal(context.payload.kind, DERIVED_GRID_CACHE_VERSION);
  assert.equal(DERIVED_GRID_CACHE_VERSION, "profile-derived-grids-v2");
  assert.match(context.binPath, /\.profile-derived-v2-[a-f0-9]{16}\.bin$/);
  assert.deepEqual(context.payload.products, [...PRODUCTS].sort());
  assert.deepEqual(context.payload.expectedGridNames, [...EXPECTED_GRID_NAMES].sort());
  assert.notDeepEqual(
    context.payload.products,
    context.payload.expectedGridNames,
    "the requested product roster must not masquerade as the output-grid roster",
  );

  assert.equal(await writeDerivedGridCache(context, grids), true);
  const body = await fs.promises.readFile(context.binPath);
  const metadata = JSON.parse(await fs.promises.readFile(context.metadataPath, "utf8"));
  assert.deepEqual(metadata.gridNames, [...EXPECTED_GRID_NAMES].sort(), "writes are complete and sorted");
  assert.equal(metadata.binBytes, body.length);
  assert.equal(metadata.binSha256, sha256(body));

  const restored = await readDerivedGridCache(context);
  assert.ok(restored);
  assert.deepEqual(Object.keys(restored), [...EXPECTED_GRID_NAMES].sort());
  for (const name of EXPECTED_GRID_NAMES) {
    assert.deepEqual(exactGridBytes(restored[name]), exactGridBytes(grids[name]), `${name} preserves exact bits`);
    assert.equal(restored[name].byteOffset, 0, `${name} starts at byte zero`);
    assert.equal(restored[name].buffer.byteLength, CELL_COUNT * 4, `${name} owns an exact-sized backing buffer`);
    assert.notEqual(restored[name].buffer, body.buffer, `${name} does not alias the readFile body`);
  }
  assert.equal(
    new Set(EXPECTED_GRID_NAMES.map((name) => restored[name].buffer)).size,
    EXPECTED_GRID_NAMES.length,
    "each restored grid owns a distinct transferable buffer",
  );
});

test("profile v2 identity binds full regrid, methodology/kernel, catalog, products, output roster, shape, and endian", () => {
  const gribPath = "/tmp/profile-derived-selected.grib2";
  const context = makeContext(gribPath);
  const reordered = makeContext(gribPath, {
    regridBinPayloadHashes: [...context.payload.regridBinPayloadHashes].reverse(),
    products: [...PRODUCTS].reverse(),
    expectedGridNames: [...EXPECTED_GRID_NAMES].reverse(),
  });
  assert.equal(reordered.payloadHash, context.payloadHash, "identity rosters are canonicalized");
  assert.equal(reordered.binPath, context.binPath);
  assert.equal(context.payload.byteOrder, os.endianness());

  for (const overrides of [
    { regridBinPayloadHashes: ["a".repeat(64), "c".repeat(64)] },
    { methodologyVersion: "derived-profile-grids-v1+parcel-wasm-sha256:kernel-b" },
    { catalogVersion: "noaa-grib2-catalog-v5" },
    { products: PRODUCTS.slice(0, 2) },
    { expectedGridNames: EXPECTED_GRID_NAMES.slice(0, 2) },
    { cellCount: CELL_COUNT + 1 },
    { byteOrder: os.endianness() === "LE" ? "BE" : "LE" },
  ]) {
    const changed = makeContext(gribPath, overrides);
    assert.ok(changed, JSON.stringify(overrides));
    assert.notEqual(changed.payloadHash, context.payloadHash, JSON.stringify(overrides));
    assert.notEqual(changed.binPath, context.binPath, JSON.stringify(overrides));
  }

  for (const overrides of [
    { expectedGridNames: undefined },
    { expectedGridNames: [] },
    { expectedGridNames: ["dcape", "dcape"] },
    { expectedGridNames: ["dcape", "__proto__"] },
    { expectedGridNames: ["dcape", "constructor"] },
    { regridBinPayloadHashes: ["short"] },
    { regridBinPayloadHashes: ["A".repeat(64)] },
    { methodologyVersion: "" },
    { catalogVersion: " noaa-grib2-catalog-v4" },
    { cellCount: 0 },
    { cellCount: Number.MAX_SAFE_INTEGER + 1 },
    { byteOrder: "middle" },
  ]) {
    assert.equal(makeContext(gribPath, overrides), null, `invalid context: ${JSON.stringify(overrides)}`);
  }
});

test("profile v2 refuses partial, extra, duplicate, malformed, and wrong-sized grid families", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-coverage-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
  const grids = makeGrids();

  const missing = { ...grids };
  delete missing.effectiveBulkShear;
  assert.equal(await writeDerivedGridCache(context, missing), false, "missing output is refused");
  assert.equal(
    await writeDerivedGridCache(context, { ...grids, lapseRate0to3km: makeGrid(9) }),
    false,
    "extra output is refused",
  );
  assert.equal(
    await writeDerivedGridCache(context, { ...grids, dcape: new Float64Array(CELL_COUNT) }),
    false,
    "wrong element type is refused",
  );
  assert.equal(
    await writeDerivedGridCache(context, { ...grids, dcape: new Float32Array(CELL_COUNT - 1) }),
    false,
    "wrong element count is refused",
  );
  assert.equal(fs.existsSync(context.binPath), false);
  assert.equal(fs.existsSync(context.metadataPath), false);

  const partialContext = makeContext(path.join(dir, "selected.grib2"), {
    expectedGridNames: ["dcape"],
  });
  assert.notEqual(
    partialContext.binPath,
    context.binPath,
    "a caller-declared partial roster cannot appear as a strict hit for the full roster",
  );
});

test("profile v2 fails closed on malformed coverage, missing hashes, corruption, truncation, and wrong identity", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-adversarial-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
  assert.equal(await writeDerivedGridCache(context, makeGrids()), true);
  const validBody = await fs.promises.readFile(context.binPath);
  const validMetadata = JSON.parse(await fs.promises.readFile(context.metadataPath, "utf8"));

  const validContextPayload = context.payload;
  context.payload = { ...validContextPayload, catalogVersion: "tampered-after-context-build" };
  assert.equal(await readDerivedGridCache(context), null, "a mutated context cannot reuse its original payload hash");
  context.payload = validContextPayload;

  const alteredPayload = {
    ...validMetadata.payload,
    methodologyVersion: "derived-profile-grids-v1+parcel-wasm-sha256:wrong-kernel",
  };
  const wrongIdentity = makeContext(path.join(dir, "selected.grib2"), {
    methodologyVersion: alteredPayload.methodologyVersion,
  });
  const invalidMetadata = [
    { ...validMetadata, gridNames: validMetadata.gridNames.slice(1) },
    { ...validMetadata, gridNames: [...validMetadata.gridNames, "lapseRate0to3km"].sort() },
    { ...validMetadata, gridNames: [validMetadata.gridNames[0], ...validMetadata.gridNames] },
    { ...validMetadata, gridNames: [...validMetadata.gridNames].reverse() },
    { ...validMetadata, gridNames: [null, ...validMetadata.gridNames.slice(1)] },
    { ...validMetadata, binSha256: undefined },
    { ...validMetadata, binSha256: validMetadata.binSha256.toUpperCase() },
    { ...validMetadata, binSha256: "0".repeat(64) },
    { ...validMetadata, binBytes: validMetadata.binBytes - 4 },
    { ...validMetadata, payload: alteredPayload },
    {
      ...validMetadata,
      payload: wrongIdentity.payload,
      payloadHash: wrongIdentity.payloadHash,
    },
  ];
  for (const metadata of invalidMetadata) {
    await fs.promises.writeFile(context.binPath, validBody);
    await fs.promises.writeFile(context.metadataPath, JSON.stringify(metadata));
    assert.equal(
      await readDerivedGridCache(context),
      null,
      `malformed metadata must miss: ${JSON.stringify(metadata)}`,
    );
  }

  await fs.promises.writeFile(context.metadataPath, JSON.stringify(validMetadata));
  const corrupted = Buffer.from(validBody);
  corrupted[Math.floor(corrupted.length / 2)] ^= 0x01;
  await fs.promises.writeFile(context.binPath, corrupted);
  assert.equal(await readDerivedGridCache(context), null, "same-size corruption is caught by SHA-256");

  await fs.promises.writeFile(context.binPath, validBody.subarray(0, validBody.length - 4));
  assert.equal(await readDerivedGridCache(context), null, "truncation is a miss");

  await fs.promises.rm(context.binPath);
  assert.equal(await readDerivedGridCache(context), null, "missing body is a miss");
});

test("old v1 sidecars are isolated from v2 paths and fail if transplanted", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-v1-isolation-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const gribPath = path.join(dir, "selected.grib2");
  const context = makeContext(gribPath);
  const oldPayload = {
    kind: "derived-grids-v1",
    regridBinPayloadHashes: [...context.payload.regridBinPayloadHashes],
    methodologyVersion: context.payload.methodologyVersion,
    catalogVersion: context.payload.catalogVersion,
    products: [...context.payload.products],
    cellCount: context.payload.cellCount,
  };
  const oldDescriptor = cachePayloadDescriptor(oldPayload);
  const oldStem = `${gribPath}.derived-${oldDescriptor.payloadHash.slice(0, 16)}`;
  const oldBinPath = `${oldStem}.bin`;
  const oldMetadataPath = `${oldStem}.json`;
  const oldBody = Buffer.alloc(EXPECTED_GRID_NAMES.length * CELL_COUNT * 4, 0x5a);
  const oldMetadata = cacheMetadataWithPayload(oldPayload, {
    gridNames: [...EXPECTED_GRID_NAMES],
    binBytes: oldBody.length,
  });
  await fs.promises.writeFile(oldBinPath, oldBody);
  await fs.promises.writeFile(oldMetadataPath, JSON.stringify(oldMetadata));

  assert.notEqual(oldBinPath, context.binPath);
  assert.notEqual(oldMetadataPath, context.metadataPath);
  assert.equal(await readDerivedGridCache(context), null, "v2 never probes the old writer's namespace");

  await fs.promises.writeFile(context.binPath, oldBody);
  await fs.promises.writeFile(context.metadataPath, JSON.stringify(oldMetadata));
  assert.equal(await readDerivedGridCache(context), null, "v1 identity/hash omissions fail closed at a v2 path");
});

test("profile v2 publication removes only exact legacy main-profile namespace files", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-v1-cleanup-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const gribPath = path.join(dir, "selected.grib2");
  const context = makeContext(gribPath);
  const legacyPaths = [
    ...legacyProfileSidecarPaths(gribPath),
    ...legacyProfileSidecarPaths(gribPath, "fedcba9876543210"),
  ];
  const protectedPaths = [
    ...legacyProfileSidecarPaths(path.join(dir, "other-selected.grib2")),
    `${gribPath}.derived-short.bin`,
    `${gribPath}.derived-0123456789abcdef.lock`,
    `${gribPath}.supplemental-derived-0123456789abcdef.bin`,
    `${gribPath}.supplemental-derived-0123456789abcdef.json`,
    `${gribPath}.profile-derived-v2-0123456789abcdef.bin`,
    `${gribPath}.profile-derived-v2-0123456789abcdef.json`,
  ];
  await Promise.all([...legacyPaths, ...protectedPaths].map((filePath) => fs.promises.writeFile(filePath, "old")));

  assert.equal(await writeDerivedGridCache(context, makeGrids()), true);
  for (const filePath of legacyPaths) {
    assert.equal(fs.existsSync(filePath), false, `legacy profile sidecar removed: ${filePath}`);
  }
  for (const filePath of protectedPaths) {
    assert.equal(fs.existsSync(filePath), true, `non-legacy namespace retained: ${filePath}`);
  }
  assert.ok(gridSetMatches(await readDerivedGridCache(context), makeGrids()));
});

test("profile v2 publishes metadata last, cleans failed bodies, and always releases its lock", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-atomic-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const gribPath = path.join(dir, "selected.grib2");
  const context = makeContext(gribPath);
  const legacyPaths = legacyProfileSidecarPaths(gribPath);
  await Promise.all(legacyPaths.map((filePath) => fs.promises.writeFile(filePath, "old")));
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, destination) => {
    if (destination === context.metadataPath) {
      const error = new Error("injected metadata publication failure");
      error.code = "EIO";
      throw error;
    }
    return originalRename(source, destination);
  };
  t.after(() => {
    fs.promises.rename = originalRename;
  });

  assert.equal(await writeDerivedGridCache(context, makeGrids()), false);
  assert.equal(await readDerivedGridCache(context), null);
  assert.equal(fs.existsSync(context.binPath), false, "unpublished body is removed");
  assert.equal(fs.existsSync(context.lockPath), false, "writer lock is released");
  for (const filePath of legacyPaths) {
    assert.equal(fs.existsSync(filePath), true, "failed replacement publication retains the legacy sidecar");
  }
  assert.deepEqual(
    (await fs.promises.readdir(dir)).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("legacy profile cleanup failure does not fail or corrupt profile v2 publication", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-v1-cleanup-failure-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const gribPath = path.join(dir, "selected.grib2");
  const context = makeContext(gribPath);
  const legacyPaths = legacyProfileSidecarPaths(gribPath);
  await Promise.all(legacyPaths.map((filePath) => fs.promises.writeFile(filePath, "old")));
  const legacyPathSet = new Set(legacyPaths);
  const originalRm = fs.promises.rm;
  fs.promises.rm = async (filePath, options) => {
    if (legacyPathSet.has(String(filePath))) {
      const error = new Error("injected legacy cleanup failure");
      error.code = "EACCES";
      throw error;
    }
    return originalRm(filePath, options);
  };
  t.after(() => {
    fs.promises.rm = originalRm;
  });

  const grids = makeGrids();
  assert.equal(await writeDerivedGridCache(context, grids), true);
  assert.ok(gridSetMatches(await readDerivedGridCache(context), grids));
  for (const filePath of legacyPaths) {
    assert.equal(fs.existsSync(filePath), true, "best-effort cleanup failure leaves the legacy file in place");
  }
});

test("profile v2 writer lock prevents concurrent hybrid publication", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-concurrent-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
  const gridsA = makeGrids(10);
  const gridsB = makeGrids(20);

  const results = await Promise.all(
    Array.from({ length: 16 }, (_, index) => writeDerivedGridCache(context, index % 2 === 0 ? gridsA : gridsB)),
  );
  assert.equal(results.filter(Boolean).length, 1, "only the lock owner publishes");
  const restored = await readDerivedGridCache(context);
  assert.ok(restored);
  assert.ok(gridSetMatches(restored, gridsA) || gridSetMatches(restored, gridsB), "no hybrid family is served");
  assert.equal(fs.existsSync(context.lockPath), false);
  assert.deepEqual(
    (await fs.promises.readdir(dir)).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("derived grid cache drain waits for a complete scheduled v2 write", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-drain-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
  const grids = makeGrids();
  let releaseFirstWrite;
  let reachedFirstWrite;
  const firstWriteReached = new Promise((resolve) => {
    reachedFirstWrite = resolve;
  });
  const originalWriteFile = fs.promises.writeFile;
  let delayed = true;
  fs.promises.writeFile = async (...args) => {
    if (delayed && String(args[0]).includes(".tmp-")) {
      delayed = false;
      reachedFirstWrite();
      await new Promise((resolve) => {
        releaseFirstWrite = resolve;
      });
    }
    return originalWriteFile(...args);
  };
  t.after(() => {
    fs.promises.writeFile = originalWriteFile;
  });

  void scheduleDerivedGridCacheWrite(context, grids);
  await firstWriteReached;
  let drained = false;
  const drain = drainDerivedGridCacheWrites().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  releaseFirstWrite();
  await drain;

  assert.equal(drained, true);
  assert.ok(gridSetMatches(await readDerivedGridCache(context), grids));
  assert.deepEqual(
    (await fs.promises.readdir(dir)).filter((name) => name.includes(".tmp-")),
    [],
  );
});
