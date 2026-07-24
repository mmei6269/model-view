"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  SELECTED_GRIB_CACHE_METADATA_VERSION,
  buildSelectedGribProvenanceSource,
  commitSelectedGribProvenance,
  probeCachedSelectedGribCandidate,
  readCachedSelectedGribPath,
  registerSelectedGribProvenance,
  selectedGribCacheDescriptor,
} = require("../scripts/lib/noaa-beta/selected-grib");
const {
  createFrameDecodeSession,
  disposeIsolatedFrameDecodeSession,
} = require("../scripts/lib/noaa-beta/decode-session");

const BODY = Buffer.from("GRIB");

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function makeDescriptor(cacheRoot, hour = 3) {
  const record = {
    record: "1",
    offset: 0,
    param: "TMP",
    level: "2 m above ground",
    forecast: `${hour} hour fcst`,
    line: `1:0:d=2026072200:TMP:2 m above ground:${hour} hour fcst:`,
    rangeHeader: "bytes=0-3",
    byteLength: BODY.length,
  };
  return selectedGribCacheDescriptor({
    modelKey: "hrrr",
    productKey: "wrfsfc",
    gribUrl: `https://example.invalid/hrrr-f${String(hour).padStart(2, "0")}.grib2`,
    groups: [
      {
        offset: 0,
        rangeHeader: record.rangeHeader,
        byteLength: BODY.length,
        records: [record],
      },
    ],
    rawCacheDir: cacheRoot,
    date: "20260722",
    cycle: "00",
    hour,
    cacheVersion: "candidate-test",
  });
}

function metadataFor(descriptor, overrides = {}) {
  return {
    version: SELECTED_GRIB_CACHE_METADATA_VERSION,
    url: descriptor.gribUrl,
    urlHash: descriptor.urlHash,
    selectedHash: descriptor.selectedHash,
    selectedBytes: BODY.length,
    sha256: sha256(BODY),
    records: descriptor.records,
    ...overrides,
  };
}

async function writeCandidate(descriptor, metadata = metadataFor(descriptor), body = BODY) {
  await fs.promises.mkdir(path.dirname(descriptor.cachePath), { recursive: true });
  await fs.promises.writeFile(descriptor.cachePath, body);
  await fs.promises.writeFile(`${descriptor.cachePath}.ready.json`, JSON.stringify(metadata));
}

async function makeTempRoot(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "selected-grib-candidate-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  return root;
}

test("candidate probe uses only stable ready metadata and does not authorize or hash selected bytes", async (t) => {
  const root = await makeTempRoot(t);
  const descriptor = makeDescriptor(root);
  const declaredMetadata = metadataFor(descriptor);
  await writeCandidate(descriptor, declaredMetadata);

  // Preserve the published size but make its declared digest false. A probe is
  // allowed to return this only as a candidate for a separately authenticated
  // pack; the normal selected-GRIB verifier must still reject it.
  await fs.promises.writeFile(descriptor.cachePath, Buffer.from("FAIL"));

  const originalReadFile = fs.promises.readFile;
  const originalCreateReadStream = fs.createReadStream;
  const readPaths = [];
  let bodyStreamReads = 0;
  fs.promises.readFile = async (filePath, ...args) => {
    readPaths.push(String(filePath));
    if (String(filePath) === descriptor.cachePath) {
      throw new Error("candidate probe read the selected GRIB body");
    }
    return originalReadFile.call(fs.promises, filePath, ...args);
  };
  fs.createReadStream = (filePath, ...args) => {
    if (String(filePath) === descriptor.cachePath) {
      bodyStreamReads += 1;
    }
    return originalCreateReadStream.call(fs, filePath, ...args);
  };
  t.after(() => {
    fs.promises.readFile = originalReadFile;
    fs.createReadStream = originalCreateReadStream;
  });

  const candidate = await probeCachedSelectedGribCandidate(descriptor);
  assert.ok(candidate);
  assert.equal(candidate.gribPath, descriptor.cachePath);
  assert.equal(candidate.metadataPath, `${descriptor.cachePath}.ready.json`);
  assert.equal(candidate.metadata.sha256, declaredMetadata.sha256);
  assert.equal(candidate.provenanceSource.selectedSha256, declaredMetadata.sha256);
  assert.deepEqual(readPaths, [`${descriptor.cachePath}.ready.json`]);
  assert.equal(bodyStreamReads, 0);

  // The candidate probe must not seed SELECTED_GRIB_VERIFIED_CACHE. The
  // authoritative reader therefore hashes the body and rejects the mutation.
  assert.equal(await readCachedSelectedGribPath(descriptor.cachePath, descriptor), null);
  assert.equal(bodyStreamReads, 1);
});

test("candidate probe requires the current ready marker and rejects malformed or mismatched metadata", async (t) => {
  const root = await makeTempRoot(t);
  const legacyDescriptor = makeDescriptor(root, 4);
  await fs.promises.mkdir(path.dirname(legacyDescriptor.cachePath), { recursive: true });
  await fs.promises.writeFile(legacyDescriptor.cachePath, BODY);
  await fs.promises.writeFile(`${legacyDescriptor.cachePath}.json`, JSON.stringify(metadataFor(legacyDescriptor)));
  assert.equal(await probeCachedSelectedGribCandidate(legacyDescriptor), null);

  const cases = [
    ["zero bytes", { selectedBytes: 0 }],
    ["non-numeric bytes", { selectedBytes: String(BODY.length) }],
    ["unsafe bytes", { selectedBytes: Number.MAX_SAFE_INTEGER + 1 }],
    ["wrong body size", { selectedBytes: BODY.length - 1 }],
    ["invalid digest", { sha256: "not-a-sha256" }],
    ["wrong version", { version: SELECTED_GRIB_CACHE_METADATA_VERSION - 1 }],
    ["wrong URL", { url: "https://example.invalid/replaced.grib2" }],
    ["wrong URL hash", { urlHash: "0".repeat(16) }],
    ["wrong selection", { selectedHash: "0".repeat(24) }],
    ["wrong records", { records: [] }],
  ];
  let hour = 5;
  for (const [label, overrides] of cases) {
    const descriptor = makeDescriptor(root, hour);
    hour += 1;
    await writeCandidate(descriptor, metadataFor(descriptor, overrides));
    assert.equal(await probeCachedSelectedGribCandidate(descriptor), null, label);
  }
});

test("candidate probe rejects selected-body and ready-marker replacement races", async (t) => {
  const root = await makeTempRoot(t);
  const originalReadFile = fs.promises.readFile;

  const bodyRaceDescriptor = makeDescriptor(root, 20);
  await writeCandidate(bodyRaceDescriptor);
  const replacementBody = `${bodyRaceDescriptor.cachePath}.replacement`;
  await fs.promises.writeFile(replacementBody, BODY);
  fs.promises.readFile = async (filePath, ...args) => {
    const result = await originalReadFile.call(fs.promises, filePath, ...args);
    if (String(filePath) === `${bodyRaceDescriptor.cachePath}.ready.json`) {
      await fs.promises.rename(replacementBody, bodyRaceDescriptor.cachePath);
    }
    return result;
  };
  assert.equal(await probeCachedSelectedGribCandidate(bodyRaceDescriptor), null);
  fs.promises.readFile = originalReadFile;

  const metadataRaceDescriptor = makeDescriptor(root, 21);
  const metadata = metadataFor(metadataRaceDescriptor);
  await writeCandidate(metadataRaceDescriptor, metadata);
  const readyPath = `${metadataRaceDescriptor.cachePath}.ready.json`;
  const replacementReady = `${readyPath}.replacement`;
  await fs.promises.writeFile(replacementReady, JSON.stringify(metadata));
  fs.promises.readFile = async (filePath, ...args) => {
    const result = await originalReadFile.call(fs.promises, filePath, ...args);
    if (String(filePath) === readyPath) {
      await fs.promises.rename(replacementReady, readyPath);
    }
    return result;
  };
  t.after(() => {
    fs.promises.readFile = originalReadFile;
  });
  assert.equal(await probeCachedSelectedGribCandidate(metadataRaceDescriptor), null);
});

test("provenance construction is pure and commit is the only session mutation", async (t) => {
  const root = await makeTempRoot(t);
  const descriptor = makeDescriptor(root, 22);
  const metadata = metadataFor(descriptor, { sha256: sha256(BODY).toUpperCase() });
  const descriptorSnapshot = JSON.stringify(descriptor);
  const metadataSnapshot = JSON.stringify(metadata);

  const source = buildSelectedGribProvenanceSource(descriptor, metadata);
  assert.equal(JSON.stringify(descriptor), descriptorSnapshot);
  assert.equal(JSON.stringify(metadata), metadataSnapshot);
  assert.equal(source.selectedSha256, sha256(BODY));
  assert.equal(source.selectedBytes, BODY.length);

  const runSourceProvenanceCatalog = new Map();
  const decodeSession = { runSourceProvenanceCatalog };
  assert.equal(commitSelectedGribProvenance(decodeSession, descriptor.cachePath, source), source);
  assert.equal(decodeSession.sourceProvenanceSources.get(source.id), source);
  assert.equal(runSourceProvenanceCatalog.get(source.id), source);
  assert.equal(decodeSession.selectedGribSourceRefs.get(descriptor.cachePath), source.id);

  // The historical registration API still falls back to hashing a
  // sidecar-less selected file before delegating to the same pure+commit path.
  const fallbackDescriptor = makeDescriptor(root, 23);
  await fs.promises.mkdir(path.dirname(fallbackDescriptor.cachePath), { recursive: true });
  await fs.promises.writeFile(fallbackDescriptor.cachePath, BODY);
  const fallbackSession = { runSourceProvenanceCatalog: new Map() };
  const registered = await registerSelectedGribProvenance(
    fallbackSession,
    fallbackDescriptor,
    fallbackDescriptor.cachePath,
  );
  assert.equal(registered.selectedSha256, sha256(BODY));
  assert.equal(fallbackSession.selectedGribSourceRefs.get(fallbackDescriptor.cachePath), registered.id);
});

test("isolated speculative sessions dispose every strong map before a verified retry", () => {
  const session = createFrameDecodeSession({});
  for (const [key, value] of Object.entries(session)) {
    if (value instanceof Map) {
      value.set("probe", { key });
    }
  }
  assert.equal(disposeIsolatedFrameDecodeSession(session), true);
  for (const value of Object.values(session)) {
    if (value instanceof Map) {
      assert.equal(value.size, 0);
    }
  }

  const attached = createFrameDecodeSession({});
  attached.runCache = {};
  attached.decodedRecordGrids.set("must-survive", {});
  assert.equal(disposeIsolatedFrameDecodeSession(attached), false);
  assert.equal(attached.decodedRecordGrids.has("must-survive"), true);
});
