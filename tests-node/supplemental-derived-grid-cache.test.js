"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { GRID_CACHE_LOCK_TIMEOUT_MS } = require("../scripts/lib/noaa-beta/cache-io");
const {
  buildSupplementalDerivedGridCacheContext,
  readDerivedGridCache,
  writeDerivedGridCache,
} = require("../scripts/lib/noaa-beta/derived-grid-cache");
const {
  _testBuildDerivedParameterGrids: buildDerivedParameterGrids,
  _testBuildSupplementalDerivedMethodologyVersion: buildSupplementalDerivedMethodologyVersion,
  _testSupplementalDerivedProductsForAvailability: supplementalDerivedProductsForAvailability,
} = require("../scripts/lib/noaa-beta-renderer");

const PRODUCTS = Object.freeze(["surfaceBasedLclHeight", "surfaceThetaE", "frontogenesis850", "frontogenesis700"]);

function makeContext(gribPath, overrides = {}) {
  return buildSupplementalDerivedGridCacheContext({
    gribPath,
    regridBinPayloadHashes: ["a".repeat(64)],
    methodologyVersion: "surface-thermo-v1+frontogenesis-v1",
    catalogVersion: "noaa-grib2-catalog-v4",
    products: PRODUCTS,
    cellCount: 16,
    ...overrides,
  });
}

function makeGrids(cellCount = 16) {
  return Object.fromEntries(
    PRODUCTS.map((name, productIndex) => {
      const values = new Float32Array(cellCount);
      for (let index = 0; index < values.length; index += 1) {
        values[index] = index % 7 === 0 ? Number.NaN : Math.fround(productIndex * 100 + index / 3);
      }
      return [name, values];
    }),
  );
}

function exactGridBytes(values) {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function gridSetMatches(actual, expected) {
  return PRODUCTS.every(
    (name) => actual[name] && expected[name] && exactGridBytes(actual[name]).equals(exactGridBytes(expected[name])),
  );
}

test("supplemental sidecar round-trips canonical exact grids with a verified body hash", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-supplemental-cache-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
  const grids = makeGrids();

  assert.equal(await writeDerivedGridCache(context, grids), true);
  const metadata = JSON.parse(await fs.promises.readFile(context.metadataPath, "utf8"));
  const body = await fs.promises.readFile(context.binPath);
  assert.deepEqual(metadata.gridNames, [...PRODUCTS].sort(), "layout is canonical, not caller-order dependent");
  assert.equal(metadata.binSha256, crypto.createHash("sha256").update(body).digest("hex"));

  const restored = await readDerivedGridCache(context);
  assert.ok(restored);
  for (const name of PRODUCTS) {
    assert.deepEqual(exactGridBytes(restored[name]), exactGridBytes(grids[name]), `${name} bytes are exact`);
  }
});

test("supplemental sidecar rejects incomplete writes and same-size corruption", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-supplemental-corrupt-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
  const grids = makeGrids();

  const incomplete = { ...grids };
  delete incomplete.frontogenesis700;
  assert.equal(await writeDerivedGridCache(context, incomplete), false, "partial product families are never published");
  assert.equal(await writeDerivedGridCache(context, grids), true);

  const body = await fs.promises.readFile(context.binPath);
  body[Math.floor(body.length / 2)] ^= 0x01;
  await fs.promises.writeFile(context.binPath, body);
  assert.equal(await readDerivedGridCache(context), null, "same-length byte corruption is a cache miss");
});

test("supplemental sidecar rejects malformed layouts, hashes, missing bodies, and truncation", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-supplemental-adversarial-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
  assert.equal(await writeDerivedGridCache(context, makeGrids()), true);
  const validMetadataText = await fs.promises.readFile(context.metadataPath, "utf8");
  const validMetadata = JSON.parse(validMetadataText);
  const validBody = await fs.promises.readFile(context.binPath);

  const invalidMetadata = [
    { ...validMetadata, gridNames: [...validMetadata.gridNames].reverse() },
    { ...validMetadata, gridNames: [validMetadata.gridNames[0], ...validMetadata.gridNames] },
    { ...validMetadata, gridNames: validMetadata.gridNames.slice(1) },
    { ...validMetadata, binBytes: validMetadata.binBytes - 4 },
    { ...validMetadata, binSha256: "0".repeat(64) },
    { ...validMetadata, binSha256: validMetadata.binSha256.toUpperCase() },
  ];
  for (const metadata of invalidMetadata) {
    await fs.promises.writeFile(context.metadataPath, JSON.stringify(metadata));
    await fs.promises.writeFile(context.binPath, validBody);
    assert.equal(await readDerivedGridCache(context), null, JSON.stringify(metadata.gridNames));
  }

  await fs.promises.writeFile(context.metadataPath, validMetadataText);
  await fs.promises.rm(context.binPath);
  assert.equal(await readDerivedGridCache(context), null, "missing body is a miss");
  await fs.promises.writeFile(context.binPath, validBody.subarray(0, validBody.length - 4));
  assert.equal(await readDerivedGridCache(context), null, "truncated body is a miss");
});

test("supplemental sidecar identity covers source, methodology, catalog, products, and shape", () => {
  const gribPath = "/tmp/supplemental-selected.grib2";
  const context = makeContext(gribPath);
  const reordered = makeContext(gribPath, { products: [...PRODUCTS].reverse() });
  assert.equal(reordered.payloadHash, context.payloadHash, "product order is canonicalized");
  assert.equal(context.payload.byteOrder, os.endianness(), "native Float32 byte order is explicit");

  for (const overrides of [
    { regridBinPayloadHashes: ["b".repeat(64)] },
    { methodologyVersion: "surface-thermo-v2+frontogenesis-v1" },
    { catalogVersion: "noaa-grib2-catalog-v5" },
    { products: PRODUCTS.slice(0, 2) },
    { cellCount: 32 },
    { byteOrder: os.endianness() === "LE" ? "BE" : "LE" },
  ]) {
    const changed = makeContext(gribPath, overrides);
    assert.notEqual(changed.payloadHash, context.payloadHash, JSON.stringify(overrides));
    assert.notEqual(changed.binPath, context.binPath, JSON.stringify(overrides));
  }
});

test("metadata-last publication fails open and removes temporary files", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-supplemental-atomic-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
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
  assert.equal(await readDerivedGridCache(context), null, "an unpublished pair degrades to recompute");
  assert.equal(fs.existsSync(context.binPath), false, "failed metadata publication leaves no orphan body");
  assert.equal(fs.existsSync(context.lockPath), false, "the writer lock is always released");
  assert.deepEqual(
    (await fs.promises.readdir(dir)).filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("supplemental writer lock prevents hybrid publication and recovers stale owners", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-supplemental-concurrent-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
  const gridsA = makeGrids();
  const gridsB = Object.fromEntries(
    Object.entries(makeGrids()).map(([name, values]) => [name, Float32Array.from(values, (value) => value + 1000)]),
  );

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) => writeDerivedGridCache(context, index % 2 === 0 ? gridsA : gridsB)),
  );
  assert.ok(results.some(Boolean), "one contender publishes");
  const restored = await readDerivedGridCache(context);
  assert.ok(restored, "the winning body and metadata form a valid pair");
  assert.ok(gridSetMatches(restored, gridsA) || gridSetMatches(restored, gridsB), "no hybrid grid family is served");
  assert.equal(fs.existsSync(context.lockPath), false);
  assert.deepEqual(
    (await fs.promises.readdir(dir)).filter((name) => name.includes(".tmp-")),
    [],
  );

  await fs.promises.rm(context.binPath, { force: true });
  await fs.promises.rm(context.metadataPath, { force: true });
  await fs.promises.writeFile(context.lockPath, "abandoned");
  const staleTime = new Date(Date.now() - GRID_CACHE_LOCK_TIMEOUT_MS - 1000);
  await fs.promises.utimes(context.lockPath, staleTime, staleTime);
  assert.equal(await writeDerivedGridCache(context, gridsA), true, "a stale lock cannot strand the cache");
  assert.ok(gridSetMatches(await readDerivedGridCache(context), gridsA));
  assert.equal(fs.existsSync(context.lockPath), false);
});

test("supplemental methodology identity pins every catalog method and renderer-specific norm", () => {
  const version = buildSupplementalDerivedMethodologyVersion();
  assert.match(version, /surfaceBasedLclHeight:direct-lcl-msl-to-agl-bolton-fallback-v2/);
  assert.match(version, /surfaceThetaE:bolton-thetae-v1/);
  assert.match(version, /frontogenesis850:petterssen-latlon-terrain-mask-v4/);
  assert.match(version, /frontogenesis700:petterssen-latlon-terrain-mask-v4/);
  assert.match(version, /frontogenesisGradientNorm:direct-sqrt-v1/);
  assert.throws(
    () => buildSupplementalDerivedMethodologyVersion([]),
    /Missing supplemental derived methodVersion/,
    "catalog drift cannot silently reuse a cache key",
  );
});

test("renderer consumes exact supplemental hits without source grids and includes LCL for STP dependencies", () => {
  assert.deepEqual(supplementalDerivedProductsForAvailability(new Set(["significantTornadoParameter"])), [
    "surfaceBasedLclHeight",
  ]);

  const precomputed = {
    surfaceBasedLclHeight: new Float32Array([100, 200, 300, 400]),
    surfaceThetaE: new Float32Array([330, 331, 332, 333]),
    frontogenesis850: new Float32Array([1, 2, 3, 4]),
    frontogenesis700: new Float32Array([5, 6, 7, 8]),
  };
  const restored = buildDerivedParameterGrids({
    decoded: {},
    selection: { availableParameters: PRODUCTS },
    bounds: { west: -100, east: -90, south: 30, north: 40 },
    width: 2,
    height: 2,
    precomputedSupplementalDerived: precomputed,
  });
  for (const name of PRODUCTS) {
    assert.equal(restored[name], precomputed[name], `${name} reuses the restored Float32Array`);
  }
});

test("supplemental roster includes exactly direct products plus fixed-layer STP's LCL dependency", () => {
  const cases = [
    [[], []],
    [["surfaceThetaE"], ["surfaceThetaE"]],
    [["frontogenesis700"], ["frontogenesis700"]],
    [["significantTornadoParameter"], ["surfaceBasedLclHeight"]],
    [["effectiveLayerSignificantTornadoParameter"], []],
    [
      ["frontogenesis700", "significantTornadoParameter", "surfaceBasedLclHeight", "frontogenesis850"],
      ["surfaceBasedLclHeight", "frontogenesis850", "frontogenesis700"],
    ],
  ];
  for (const [available, expected] of cases) {
    assert.deepEqual(supplementalDerivedProductsForAvailability(new Set(available)), expected);
  }
});

test("cold and restored LCL paths produce exact fixed-layer STP bytes without source thermodynamics on hit", () => {
  const cellCount = 4;
  const profileDerived = { bulkShear0to6km: new Float32Array(cellCount).fill(40) };
  const common = {
    selection: { availableParameters: ["significantTornadoParameter"] },
    bounds: { west: -100, east: -90, south: 30, north: 40 },
    width: 2,
    height: 2,
    precomputedProfileDerived: profileDerived,
  };
  const capture = { grids: {} };
  const cold = buildDerivedParameterGrids({
    ...common,
    decoded: {
      surfaceBasedLclHeightDirect: new Float32Array([1400, 1500, 1600, 1700]),
      profileSurfaceHeight: new Float32Array([400, 450, 500, 550]),
      sbcape: new Float32Array(cellCount).fill(3000),
      srh0to1km: new Float32Array(cellCount).fill(300),
    },
    supplementalDerivedCapture: capture,
  });
  assert.deepEqual(Object.keys(capture.grids), ["surfaceBasedLclHeight"]);

  const warm = buildDerivedParameterGrids({
    ...common,
    decoded: {
      sbcape: new Float32Array(cellCount).fill(3000),
      srh0to1km: new Float32Array(cellCount).fill(300),
    },
    precomputedSupplementalDerived: capture.grids,
  });
  assert.deepEqual(exactGridBytes(warm.significantTornadoParameter), exactGridBytes(cold.significantTornadoParameter));
});

test("partial supplemental rosters are complete relative to their requested product set", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-supplemental-subset-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"), {
    products: ["surfaceThetaE"],
    cellCount: 4,
  });
  const thetaE = new Float32Array([330, 331, Number.NaN, 333]);
  assert.equal(await writeDerivedGridCache(context, { surfaceThetaE: thetaE }), true);
  assert.deepEqual(exactGridBytes((await readDerivedGridCache(context)).surfaceThetaE), exactGridBytes(thetaE));
  assert.equal(
    await writeDerivedGridCache(context, { surfaceThetaE: thetaE, frontogenesis700: thetaE }),
    false,
    "unrequested extras are rejected",
  );
});
