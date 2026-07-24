"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  SELECTED_GRIB_CACHE_METADATA_VERSION,
  readCachedSelectedGribPath,
  selectedGribCacheDescriptor,
  writeCachedSelectedGrib,
  writeSelectedGribRangeFile,
} = require("../scripts/lib/noaa-beta/grib-source");

function buildTestDescriptor(root, cacheVersion = "test") {
  const groups = [
    {
      offset: 0,
      rangeHeader: "bytes=0-3",
      byteLength: 4,
      records: [
        {
          record: "1",
          offset: 0,
          param: "TMP",
          level: "2 m above ground",
          forecast: "anl",
          line: "1:0:d=2026071200:TMP:2 m above ground:anl:",
          rangeHeader: "bytes=0-3",
          byteLength: 4,
        },
      ],
    },
  ];
  return selectedGribCacheDescriptor({
    modelKey: "nam",
    productKey: "conusnest.hiresf",
    gribUrl: "https://example.invalid/file.grib2",
    groups,
    rawCacheDir: root,
    date: "20260712",
    cycle: "00",
    hour: 0,
    cacheVersion,
  });
}

function testSelectedMetadata(descriptor, body, overrides = {}) {
  return {
    version: SELECTED_GRIB_CACHE_METADATA_VERSION,
    url: descriptor.gribUrl,
    urlHash: descriptor.urlHash,
    selectedHash: descriptor.selectedHash,
    selectedBytes: body.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    records: descriptor.records,
    ...overrides,
  };
}

test("writeSelectedGribRangeFile assembles ranges and records the sha256 stage", async () => {
  const chunks = {
    "bytes=0-3": Buffer.from("GRIB"),
    "bytes=4-9": Buffer.from("abcdef"),
  };
  const groups = [
    { rangeHeader: "bytes=0-3", byteLength: 4 },
    { rangeHeader: "bytes=4-9", byteLength: 6 },
  ];
  const targetPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grib-range-test-")), "selected.grib2");
  const profile = { stages: {} };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const chunk = chunks[options.headers?.Range];
    assert.ok(chunk, `unexpected Range header ${options.headers?.Range}`);
    return {
      status: 206,
      arrayBuffer: async () => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    };
  };
  try {
    const result = await writeSelectedGribRangeFile({
      targetPath,
      gribUrl: "https://example.invalid/file.grib2",
      groups,
      rangeFetchConcurrency: 1,
      profile,
    });
    const expected = Buffer.concat([chunks["bytes=0-3"], chunks["bytes=4-9"]]);
    assert.deepEqual(fs.readFileSync(targetPath), expected);
    assert.equal(result.bytes, expected.length);
    assert.equal(result.sha256, crypto.createHash("sha256").update(expected).digest("hex"));
    assert.equal(profile.selectedBytes, expected.length);
    assert.ok(Number.isFinite(profile.stages.rangeFetchMs));
    assert.ok(Number.isFinite(profile.stages.selectedGribHashMs));
    assert.equal("rangeConcatMs" in profile.stages, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("readCachedSelectedGribPath revalidates a same-size replacement", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grib-identity-test-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const descriptor = buildTestDescriptor(root);
  const original = Buffer.from("GRIB");
  await fs.promises.mkdir(path.dirname(descriptor.cachePath), { recursive: true });
  await fs.promises.writeFile(descriptor.cachePath, original);
  await fs.promises.writeFile(
    `${descriptor.cachePath}.ready.json`,
    JSON.stringify(testSelectedMetadata(descriptor, original)),
  );

  const verifyProfile = {};
  assert.equal(await readCachedSelectedGribPath(descriptor.cachePath, descriptor, verifyProfile), descriptor.cachePath);
  assert.equal(verifyProfile.selectedGribVerifyHashes, 1);
  assert.equal(verifyProfile.selectedGribVerifyHashBytes, original.length);

  const metadataReplacementPath = `${descriptor.cachePath}.ready.json.replacement`;
  await fs.promises.writeFile(
    metadataReplacementPath,
    JSON.stringify(testSelectedMetadata(descriptor, original, { sha256: "b".repeat(64) })),
  );
  await fs.promises.rename(metadataReplacementPath, `${descriptor.cachePath}.ready.json`);
  assert.equal(
    await readCachedSelectedGribPath(descriptor.cachePath, descriptor),
    null,
    "a sidecar-only replacement invalidates the verified memo",
  );

  await fs.promises.writeFile(metadataReplacementPath, JSON.stringify(testSelectedMetadata(descriptor, original)));
  await fs.promises.rename(metadataReplacementPath, `${descriptor.cachePath}.ready.json`);
  assert.equal(await readCachedSelectedGribPath(descriptor.cachePath, descriptor), descriptor.cachePath);

  const replacementPath = `${descriptor.cachePath}.replacement`;
  await fs.promises.writeFile(replacementPath, Buffer.from("FAIL"));
  await fs.promises.rename(replacementPath, descriptor.cachePath);
  assert.equal(await readCachedSelectedGribPath(descriptor.cachePath, descriptor), null);

  // A later cache recreation at the same path must refresh both memos and
  // accept the newly verified bytes, rather than retaining stale state.
  const recreated = Buffer.from("DATA");
  await fs.promises.writeFile(replacementPath, recreated);
  await fs.promises.rename(replacementPath, descriptor.cachePath);
  await fs.promises.writeFile(metadataReplacementPath, JSON.stringify(testSelectedMetadata(descriptor, recreated)));
  await fs.promises.rename(metadataReplacementPath, `${descriptor.cachePath}.ready.json`);
  assert.equal(await readCachedSelectedGribPath(descriptor.cachePath, descriptor), descriptor.cachePath);
});

test("readCachedSelectedGribPath rejects missing or malformed SHA-256 metadata", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grib-sha-test-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const body = Buffer.from("GRIB");

  for (const [cacheVersion, sha256] of [
    ["missing-sha", undefined],
    ["malformed-sha", "not-a-sha256"],
  ]) {
    const descriptor = buildTestDescriptor(root, cacheVersion);
    await fs.promises.mkdir(path.dirname(descriptor.cachePath), { recursive: true });
    await fs.promises.writeFile(descriptor.cachePath, body);
    const metadata = testSelectedMetadata(descriptor, body);
    if (sha256 === undefined) {
      delete metadata.sha256;
    } else {
      metadata.sha256 = sha256;
    }
    await fs.promises.writeFile(`${descriptor.cachePath}.ready.json`, JSON.stringify(metadata));
    assert.equal(await readCachedSelectedGribPath(descriptor.cachePath, descriptor), null, cacheVersion);
  }
});

test("writeCachedSelectedGrib cleans temporary files after a fetch failure", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grib-write-cleanup-test-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const descriptor = buildTestDescriptor(root);
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 404 });
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(
    writeCachedSelectedGrib({ descriptor, rangeFetchConcurrency: 1 }),
    /Expected byte-range response/,
  );
  const entries = await fs.promises.readdir(path.dirname(descriptor.cachePath));
  assert.deepEqual(
    entries.filter((name) => name.includes(".tmp-")),
    [],
  );
});

test("writeCachedSelectedGrib verifies the final published path before returning", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grib-publish-race-test-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const descriptor = buildTestDescriptor(root);
  const originalFetch = global.fetch;
  const originalRename = fs.promises.rename;
  global.fetch = async () => {
    const body = Buffer.from("GRIB");
    return {
      status: 206,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  fs.promises.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (destination === `${descriptor.cachePath}.ready.json`) {
      const replacement = `${descriptor.cachePath}.race-replacement`;
      await fs.promises.writeFile(replacement, Buffer.from("FAIL"));
      await originalRename(replacement, descriptor.cachePath);
    }
  };
  t.after(() => {
    global.fetch = originalFetch;
    fs.promises.rename = originalRename;
  });

  await assert.rejects(
    writeCachedSelectedGrib({ descriptor, rangeFetchConcurrency: 1 }),
    /failed post-publish verification/,
  );
  const entries = await fs.promises.readdir(path.dirname(descriptor.cachePath));
  assert.deepEqual(
    entries.filter((name) => name.includes(".tmp-")),
    [],
  );
});
