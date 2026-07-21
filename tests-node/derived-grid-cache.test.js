"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildDerivedGridCacheContext,
  drainDerivedGridCacheWrites,
  readDerivedGridCache,
  scheduleDerivedGridCacheWrite,
  writeDerivedGridCache,
} = require("../scripts/lib/noaa-beta/derived-grid-cache");
const { cacheMetadataWithPayload } = require("../scripts/lib/noaa-beta/cache-io");

function makeContext(gribPath, overrides = {}) {
  return buildDerivedGridCacheContext({
    gribPath,
    regridBinPayloadHashes: ["a".repeat(64)],
    methodologyVersion: "derived-profile-grids-v1",
    catalogVersion: "noaa-grib2-catalog-v4",
    products: ["dcape", "effectiveLayerSupercellCompositeParameter"],
    cellCount: 16,
    ...overrides,
  });
}

test("derived grid cache round-trips exact Float32 bytes including NaN patterns", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const gribPath = path.join(dir, "selected.grib2");
  const context = makeContext(gribPath);
  assert.ok(context, "context builds for valid inputs");

  const dcape = new Float32Array(16);
  const scp = new Float32Array(16);
  for (let index = 0; index < 16; index += 1) {
    dcape[index] = index % 3 === 0 ? Number.NaN : index * 1.5 - 4;
    scp[index] = index % 5 === 0 ? -0 : Math.fround(Math.PI * index);
  }
  // A non-canonical NaN payload must also survive byte-for-byte.
  new Uint32Array(dcape.buffer)[1] = 0x7fc12345;

  assert.equal(await writeDerivedGridCache(context, { dcape, effectiveLayerSupercellCompositeParameter: scp }), true);
  const restored = await readDerivedGridCache(context);
  assert.ok(restored, "hit after write");
  assert.deepEqual(Object.keys(restored).sort(), ["dcape", "effectiveLayerSupercellCompositeParameter"]);
  assert.deepEqual(Buffer.from(restored.dcape.buffer), Buffer.from(dcape.buffer), "dcape bytes exact");
  assert.deepEqual(Buffer.from(restored.effectiveLayerSupercellCompositeParameter.buffer), Buffer.from(scp.buffer));
});

test("derived grid cache misses on any key ingredient change and on corruption", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-miss-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const gribPath = path.join(dir, "selected.grib2");
  const context = makeContext(gribPath);
  const grid = new Float32Array(16).fill(1);
  await writeDerivedGridCache(context, { dcape: grid, effectiveLayerSupercellCompositeParameter: grid });

  for (const overrides of [
    { regridBinPayloadHashes: ["b".repeat(64)] },
    { methodologyVersion: "derived-profile-grids-v2" },
    { catalogVersion: "noaa-grib2-catalog-v5" },
    { products: ["dcape"] },
    { cellCount: 32 },
  ]) {
    const changed = makeContext(gribPath, overrides);
    assert.equal(await readDerivedGridCache(changed), null, `miss for ${JSON.stringify(overrides)}`);
  }

  // Truncated bin must miss rather than restore short grids.
  await fs.promises.truncate(context.binPath, 16);
  assert.equal(await readDerivedGridCache(context), null, "corrupted bin misses");
});

test("derived grid cache neither persists nor serves an empty grid set", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-empty-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));

  // Write side: an empty set is refused outright and leaves no cache files.
  assert.equal(await writeDerivedGridCache(context, {}), false, "empty grid set write is refused");
  assert.equal(fs.existsSync(context.binPath), false, "no bin persisted for the empty set");
  assert.equal(fs.existsSync(context.metadataPath), false, "no metadata persisted for the empty set");

  // Read side: a hand-forged empty entry (valid payload hash, gridNames: [],
  // 0-byte bin — what a buggy or older writer could leave behind) must read
  // as a miss (null), never as a truthy {} that a caller would count as a
  // hit and skip computing every derived severe product.
  await fs.promises.writeFile(context.binPath, Buffer.alloc(0));
  await fs.promises.writeFile(
    context.metadataPath,
    JSON.stringify(cacheMetadataWithPayload(context.payload, { gridNames: [], binBytes: 0 })),
  );
  assert.equal(await readDerivedGridCache(context), null, "empty-set cache entry reads as a miss");
});

test("derived grid cache context refuses unusable key inputs", () => {
  assert.equal(makeContext(null), null);
  assert.equal(makeContext("/tmp/x.grib2", { regridBinPayloadHashes: [] }), null);
  assert.equal(makeContext("/tmp/x.grib2", { regridBinPayloadHashes: [null] }), null);
  assert.equal(makeContext("/tmp/x.grib2", { products: [] }), null);
  assert.equal(makeContext("/tmp/x.grib2", { cellCount: 0 }), null);
});

test("derived grid cache drain waits for scheduled writes to finish", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-derived-cache-drain-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const context = makeContext(path.join(dir, "selected.grib2"));
  const grid = new Float32Array(16).fill(7);
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

  void scheduleDerivedGridCacheWrite(context, { dcape: grid });
  await firstWriteReached;
  let drained = false;
  const drain = drainDerivedGridCacheWrites().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "drain remains pending while the cache write is blocked");
  releaseFirstWrite();
  await drain;

  assert.equal(drained, true);
  assert.ok(await readDerivedGridCache(context), "scheduled cache write is committed before drain resolves");
  assert.deepEqual(
    (await fs.promises.readdir(dir)).filter((name) => name.includes(".tmp-")),
    [],
    "no temporary artifacts remain",
  );
});
