"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
const { buildNoaaModelMetadata } = require("../scripts/lib/noaa-build/run-resolution");
const {
  WGRIB2_IDENTITY_PROMISES,
  WGRIB2_PROVENANCE_IDENTITY_PROMISES,
  attachRunLocalDecodeSession,
  createFrameDecodeSession,
  ensureWgrib2Available,
  getFrameSourceProvenanceSources,
  getWgrib2Identity,
  getWgrib2ProvenanceIdentity,
  registerTemporalProvenanceDerivation,
  regriddedBinMemoKey,
  restoreFrameProvenanceCacheSnapshot,
} = require("../scripts/lib/noaa-beta/grib-source");
const {
  buildFrameSourceProvenance,
  buildRunSourceProvenanceCatalog,
  mergeFrameSourceProvenance,
  normalizeFrameSourceProvenance,
} = require("../scripts/lib/noaa-beta/source-provenance");

test("tool provenance resolves, versions, hashes, and memoizes one executable identity", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-tool-provenance-"));
  t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));
  const executablePath = path.join(tempDir, "wgrib2-test");
  await fs.promises.writeFile(executablePath, "#!/bin/sh\nprintf 'wgrib2-test-version\\n'\n");
  await fs.promises.chmod(executablePath, 0o755);
  WGRIB2_PROVENANCE_IDENTITY_PROMISES.clear();
  WGRIB2_IDENTITY_PROMISES.clear();
  const firstPromise = getWgrib2ProvenanceIdentity(executablePath);
  const secondPromise = getWgrib2ProvenanceIdentity(executablePath);
  assert.equal(firstPromise, secondPromise, "the executable is inspected once per process");
  const identity = await firstPromise;
  const expectedHash = crypto
    .createHash("sha256")
    .update(await fs.promises.readFile(executablePath))
    .digest("hex");
  assert.equal(identity.resolvedPath, await fs.promises.realpath(executablePath));
  assert.equal(identity.versionOutput, "wgrib2-test-version");
  assert.equal(identity.sha256, expectedHash);
  assert.equal(identity.id, `wgrib2-sha256:${expectedHash}`);

  const catalog = buildRunSourceProvenanceCatalog({ toolIdentity: identity });
  assert.equal(catalog.tools.length, 1);
  assert.deepEqual(catalog.tools[0], identity);
});

test("wgrib2 identity accepts version output written only to stderr", async (t) => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-tool-stderr-version-"));
  t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }));
  const executablePath = path.join(tempDir, "wgrib2-stderr-test");
  await fs.promises.writeFile(executablePath, "#!/bin/sh\nprintf 'wgrib2 stderr version 3.9.1\\n' >&2\n");
  await fs.promises.chmod(executablePath, 0o755);
  WGRIB2_IDENTITY_PROMISES.clear();
  WGRIB2_PROVENANCE_IDENTITY_PROMISES.clear();

  await ensureWgrib2Available(executablePath);
  assert.equal(await getWgrib2Identity(executablePath), "wgrib2 stderr version 3.9.1");
  const identity = await getWgrib2ProvenanceIdentity(executablePath);
  assert.equal(identity.versionOutput, "wgrib2 stderr version 3.9.1");
  assert.match(identity.sha256, /^[a-f0-9]{64}$/);
});

test("regrid memo keys retain NUL delimiter semantics without binary bytes in JavaScript source", async () => {
  const key = regriddedBinMemoKey("/tmp/selected.grib2", ["-new_grid", "latlon"]);
  assert.equal(key, "/tmp/selected.grib2\u0000-new_grid\u0000latlon");
  const sourcePath = path.resolve(__dirname, "../scripts/lib/noaa-beta/bulk-decode.js");
  const source = await fs.promises.readFile(sourcePath);
  assert.equal(source.includes(0), false, "source stays text-searchable; delimiter is a source escape");
});

test("per-frame provenance does not inherit unrelated sources from an earlier frame", () => {
  const context = {
    modelKey: "gfs",
    modelConfig: { productKey: "pgrb2-0p25" },
    baseUrl: "https://example.test",
    date: "20260711",
    cycle: "00",
  };
  const source = {
    id: `noaa-selected:${"d".repeat(64)}`,
    modelKey: "gfs",
    productKey: "pgrb2-0p25",
    date: "20260711",
    cycle: "00",
    forecastHour: 0,
    gribUrl: "https://example.test/gfs.f000.grib2",
    idxUrl: "https://example.test/gfs.f000.grib2.idx",
    selectedHash: "source-hash",
    selectedSha256: "d".repeat(64),
    selectedBytes: 100,
    records: [{ record: "1", param: "APCP", level: "surface", forecast: "0-1 hour acc fcst" }],
  };
  const first = createFrameDecodeSession();
  attachRunLocalDecodeSession(first, context);
  restoreFrameProvenanceCacheSnapshot(first, {
    schemaVersion: 1,
    sources: [source],
    temporalDerivations: [],
  });
  assert.deepEqual(
    getFrameSourceProvenanceSources(first).map((entry) => entry.id),
    [source.id],
  );

  const second = createFrameDecodeSession();
  attachRunLocalDecodeSession(second, context);
  assert.deepEqual(getFrameSourceProvenanceSources(second), [], "frame two starts with an empty used-source set");
  registerTemporalProvenanceDerivation(second, {
    family: "precipitation-accumulation",
    outputKey: "precip1h",
    targetHour: 1,
    terms: [
      {
        hour: 0,
        record: { record: "1", param: "APCP", level: "surface", forecast: "0-1 hour acc fcst" },
      },
    ],
  });
  assert.deepEqual(
    getFrameSourceProvenanceSources(second).map((entry) => entry.id),
    [source.id],
    "an earlier source is copied into frame two only when a frame-two derivation consumes it",
  );
});

test("run manifest persists the single tool catalog referenced by frame provenance", async (t) => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-provenance-manifest-"));
  t.after(() => fs.promises.rm(cacheRoot, { recursive: true, force: true }));
  const toolIdentity = {
    id: `wgrib2-sha256:${"e".repeat(64)}`,
    name: "wgrib2",
    configuredPath: "/opt/wgrib2",
    resolvedPath: "/opt/wgrib2",
    versionOutput: "3.8.0",
    sha256: "e".repeat(64),
  };
  const sourceProvenanceCatalog = buildRunSourceProvenanceCatalog({ toolIdentity });
  const latestMetadata = buildNoaaModelMetadata({
    modelKey: "gfs",
    run: { date: "20260711", cycle: "00" },
    hours: [0],
    sourceProvenanceCatalog,
  });
  const runtime = new LocalArtifactRuntime({ cacheRoot, fetchLatestMetadata: async () => latestMetadata });
  t.after(() => runtime.close());
  const state = await runtime.ensureLatestState("gfs", "conus");
  assert.deepEqual(state.manifest.sourceProvenanceCatalog, sourceProvenanceCatalog);
  assert.equal(state.manifest.sourceProvenanceCatalog.tools[0].id, toolIdentity.id);

  const replacementToolIdentity = {
    ...toolIdentity,
    id: `wgrib2-sha256:${"f".repeat(64)}`,
    sha256: "f".repeat(64),
  };
  const replacementMetadata = buildNoaaModelMetadata({
    modelKey: "gfs",
    run: { date: "20260711", cycle: "00" },
    hours: [0],
    sourceProvenanceCatalog: buildRunSourceProvenanceCatalog({ toolIdentity: replacementToolIdentity }),
  });
  assert.notEqual(
    replacementMetadata.rendererSignature,
    latestMetadata.rendererSignature,
    "changing the exact wgrib2 binary identity must invalidate frame completion",
  );
  const sameToolMetadata = buildNoaaModelMetadata({
    modelKey: "gfs",
    run: { date: "20260711", cycle: "00" },
    hours: [0],
    sourceProvenanceCatalog,
  });
  assert.equal(sameToolMetadata.rendererSignature, latestMetadata.rendererSignature);
});

test("frame provenance normalization is a JSON-byte fixed point (marker short-circuit is exact)", () => {
  const sourceA = {
    id: `noaa-selected:${"a".repeat(64)}`,
    modelKey: "gfs",
    productKey: "pgrb2-0p25",
    date: "20260711",
    cycle: "00",
    forecastHour: 0,
    gribUrl: "https://example.test/gfs.f000.grib2",
    idxUrl: "https://example.test/gfs.f000.grib2.idx",
    selectedHash: "hash-a",
    selectedSha256: "a".repeat(64),
    selectedBytes: 100,
    records: [
      { record: "2", param: "TMP", level: "2 m above ground", forecast: "anl" },
      { record: "1", param: "APCP", level: "surface", forecast: "0-1 hour acc fcst" },
    ],
  };
  const sourceB = {
    ...sourceA,
    id: `noaa-selected:${"b".repeat(64)}`,
    forecastHour: 1,
    gribUrl: "https://example.test/gfs.f001.grib2",
    idxUrl: "https://example.test/gfs.f001.grib2.idx",
    selectedHash: "hash-b",
    selectedSha256: "b".repeat(64),
  };
  const built = buildFrameSourceProvenance({
    gribUrl: sourceB.gribUrl,
    idxUrl: sourceB.idxUrl,
    selection: { catalog: [], records: {} },
    bounds: { north: 50, south: 20, west: -125, east: -66 },
    width: 1600,
    height: 980,
    renderMode: "all",
    toolRef: `wgrib2-sha256:${"e".repeat(64)}`,
    sourceInputs: [sourceB, sourceA],
    temporalDerivations: [
      {
        id: `temporal:${"c".repeat(64)}`,
        family: "precipitation-accumulation",
        outputKey: "precip1h",
        targetHour: 1,
        terms: [
          {
            hour: 0,
            record: { record: "1", param: "APCP", level: "surface", forecast: "0-1 hour acc fcst" },
          },
        ],
      },
    ],
  });

  // Round-trip through JSON to drop the non-enumerable marker, forcing a
  // genuine re-normalization; the bytes must not change.
  const normalized = normalizeFrameSourceProvenance(built);
  const renormalized = normalizeFrameSourceProvenance(JSON.parse(JSON.stringify(normalized)));
  assert.equal(JSON.stringify(renormalized), JSON.stringify(normalized), "normalize is JSON-byte idempotent");

  // Marked objects short-circuit by identity.
  assert.equal(normalizeFrameSourceProvenance(normalized), normalized);

  // Merge output must itself be a normalize fixed point, since it carries
  // the normalized marker.
  const other = buildFrameSourceProvenance({
    gribUrl: sourceA.gribUrl,
    idxUrl: sourceA.idxUrl,
    selection: { catalog: [], records: {} },
    bounds: { north: 50, south: 20, west: -125, east: -66 },
    width: 1600,
    height: 980,
    renderMode: "snow",
    toolRef: `wgrib2-sha256:${"e".repeat(64)}`,
    sourceInputs: [sourceA],
    temporalDerivations: [],
  });
  const merged = mergeFrameSourceProvenance(normalized, normalizeFrameSourceProvenance(other));
  const remergedFromJson = normalizeFrameSourceProvenance(JSON.parse(JSON.stringify(merged)));
  assert.equal(JSON.stringify(remergedFromJson), JSON.stringify(merged), "merge output is a normalize fixed point");
});
