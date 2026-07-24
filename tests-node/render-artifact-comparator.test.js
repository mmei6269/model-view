"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const zlib = require("node:zlib");
const { PNG } = require("pngjs");
const { buildHoverGridBinaryRaw } = require("../scripts/lib/hover-grid-binary");
const {
  canonicalizeArtifactKey,
  collectReferencedInventory,
  compareArtifactCaches,
  normalizeOptions,
  parseManifestSpec,
} = require("../scripts/compare-render-artifacts");

const ROOT_DIR = path.resolve(__dirname, "..");
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts/compare-render-artifacts.js");
const MANIFEST_ID = "hrrr/20260716-1300Z--conus.json";
const RUN_ID = "20260716-1300Z";
const FIXTURE_RGBA = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 128, 100, 110, 120, 0]);

function makeFixturePair(
  t,
  {
    baselineCodec = "gz",
    candidateCodec = "gz",
    candidateHoverBody = "hover-data",
    baselineHoverBody = "hover-data",
    baselineHoverSchemaVersion,
    candidateHoverSchemaVersion,
    baselinePngBody = Buffer.from("png-payload"),
    candidatePngBody = Buffer.from("png-payload"),
    baselineRendererSignature = "fixture-v1",
    candidateRendererSignature = "fixture-v1",
    candidateMarkerRendererSignature = candidateRendererSignature,
  } = {},
) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "render-artifact-comparator-"));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const baselineCacheRoot = path.join(temporaryRoot, "baseline");
  const candidateCacheRoot = path.join(temporaryRoot, "candidate");
  const baseline = writeFixtureCache(baselineCacheRoot, {
    codec: baselineCodec,
    generatedAt: "2026-07-22T10:00:00.000Z",
    renderedAt: "2026-07-22T10:00:01.000Z",
    renderProfile: { stages: { wallMs: 101.2 } },
    hoverBody: baselineHoverBody,
    hoverSchemaVersion: baselineHoverSchemaVersion,
    pngBody: baselinePngBody,
    rendererSignature: baselineRendererSignature,
    markerRendererSignature: baselineRendererSignature,
  });
  const candidate = writeFixtureCache(candidateCacheRoot, {
    codec: candidateCodec,
    generatedAt: "2026-07-22T11:00:00.000Z",
    renderedAt: "2026-07-22T11:00:01.000Z",
    renderProfile: { stages: { wallMs: 88.4 }, cacheHits: 1 },
    hoverBody: candidateHoverBody,
    hoverSchemaVersion: candidateHoverSchemaVersion,
    pngBody: candidatePngBody,
    rendererSignature: candidateRendererSignature,
    markerRendererSignature: candidateMarkerRendererSignature,
  });
  return {
    temporaryRoot,
    baselineCacheRoot,
    candidateCacheRoot,
    baseline,
    candidate,
    compare({ pngComparison, hoverComparison } = {}) {
      const options = {
        "baseline-cache-root": baselineCacheRoot,
        "candidate-cache-root": candidateCacheRoot,
        manifests: [MANIFEST_ID],
      };
      if (pngComparison !== undefined) {
        options["png-comparison"] = pngComparison;
      }
      if (hoverComparison !== undefined) {
        options["hover-comparison"] = hoverComparison;
      }
      return compareArtifactCaches(normalizeOptions(options));
    },
  };
}

function makeSemanticFixturePair(t, options = {}) {
  const baselinePngBody =
    options.baselinePngBody ||
    encodeRgbaPng({ width: 2, height: 2, data: FIXTURE_RGBA, compressionLevel: 1, filterType: 0 });
  const candidatePngBody =
    options.candidatePngBody ||
    encodeRgbaPng({ width: 2, height: 2, data: FIXTURE_RGBA, compressionLevel: 9, filterType: 4 });
  assert.equal(baselinePngBody.equals(candidatePngBody), false, "semantic fixture PNG containers must differ");
  return makeFixturePair(t, {
    ...options,
    baselinePngBody,
    candidatePngBody,
    baselineRendererSignature: options.baselineRendererSignature || "fixture-v1",
    candidateRendererSignature: options.candidateRendererSignature || "fixture-v2",
  });
}

function makeHoverSemanticFixturePair(t, options = {}) {
  const baselineSchemaVersion = options.baselineSchemaVersion || 3;
  const candidateSchemaVersion = options.candidateSchemaVersion || 4;
  const baselineHoverBody =
    options.baselineHoverBody ||
    hoverRaw({
      schemaVersion: baselineSchemaVersion,
      rows: options.baselineRows || 2,
      cols: options.baselineCols || 2,
      variables: options.baselineVariables,
      reverseVariableOrder: true,
    });
  const candidateHoverBody =
    options.candidateHoverBody ||
    hoverRaw({
      schemaVersion: candidateSchemaVersion,
      rows: options.candidateRows || 2,
      cols: options.candidateCols || 2,
      variables: options.candidateVariables,
    });
  return makeFixturePair(t, {
    ...options,
    baselineCodec: options.baselineCodec || "gz",
    candidateCodec: options.candidateCodec || "br",
    baselineHoverBody,
    candidateHoverBody,
    baselineHoverSchemaVersion: baselineSchemaVersion,
    candidateHoverSchemaVersion: candidateSchemaVersion,
    baselineRendererSignature: options.baselineRendererSignature || "hover-fixture-v3",
    candidateRendererSignature: options.candidateRendererSignature || "hover-fixture-v4",
  });
}

function hoverRaw({ schemaVersion, rows, cols, variables, reverseVariableOrder = false }) {
  const source = variables || {
    temperatureF: {
      scale: 0.05,
      offset: -100,
      missing: -32768,
      values: Int16Array.from([-32768, 32767, -12345, 23456]),
    },
    windMph: {
      scale: 0.1,
      offset: 0,
      missing: -32768,
      values: Int16Array.from([0, 5, 25, 100]),
    },
  };
  const entries = Object.entries(source);
  return buildHoverGridBinaryRaw({
    schemaVersion,
    rows,
    cols,
    variables: Object.fromEntries(reverseVariableOrder ? entries.reverse() : entries),
  });
}

function withNegativeZeroFirstOffset(raw) {
  const source = Buffer.from(raw);
  const headerLength = source.readUInt32LE(4);
  const headerText = source
    .subarray(8, 8 + headerLength)
    .toString("utf8")
    .trimEnd();
  const replaced = headerText.replace('"offset":0', '"offset":-0');
  assert.notEqual(replaced, headerText, "fixture must contain a zero offset");
  let header = Buffer.from(replaced);
  if (header.length % 2 !== 0) {
    header = Buffer.concat([header, Buffer.from(" ")]);
  }
  const data = source.subarray(8 + headerLength);
  const rebuilt = Buffer.allocUnsafe(8 + header.length + data.length);
  source.copy(rebuilt, 0, 0, 4);
  rebuilt.writeUInt32LE(header.length, 4);
  header.copy(rebuilt, 8);
  data.copy(rebuilt, 8 + header.length);
  return rebuilt;
}

function encodeRgbaPng({ width, height, data, compressionLevel, filterType }) {
  return PNG.sync.write(
    {
      width,
      height,
      data: Buffer.from(data),
    },
    {
      colorType: 6,
      inputColorType: 6,
      inputHasAlpha: true,
      bitDepth: 8,
      compressionLevel,
      filterType,
    },
  );
}

function writeFixtureCache(
  cacheRoot,
  {
    codec,
    generatedAt,
    renderedAt,
    renderProfile,
    hoverBody,
    hoverSchemaVersion,
    pngBody,
    rendererSignature,
    markerRendererSignature,
  },
) {
  const artifactRoot = path.join(cacheRoot, "artifacts");
  const manifestPath = path.join(artifactRoot, "manifests", "hrrr", `${RUN_ID}--conus.json`);
  const frameDirectory = path.join(artifactRoot, "tiles", "hrrr", RUN_ID, "conus", "000");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.mkdirSync(frameDirectory, { recursive: true });

  const hoverKey = `tiles/hrrr/${RUN_ID}/conus/000/hover-grid.bin.${codec}`;
  const temperatureKey = `tiles/hrrr/${RUN_ID}/conus/000/temperature.png`;
  const hoverStored =
    codec === "gz"
      ? zlib.gzipSync(Buffer.from(hoverBody), { level: 1 })
      : zlib.brotliCompressSync(Buffer.from(hoverBody));
  fs.writeFileSync(path.join(artifactRoot, ...hoverKey.split("/")), hoverStored);
  fs.writeFileSync(path.join(artifactRoot, ...temperatureKey.split("/")), pngBody);

  const manifest = {
    schemaVersion: 4,
    model: "hrrr",
    run: RUN_ID,
    view: "conus",
    generatedAt,
    source: "local-noaa-beta",
    rendererSignature,
    hourStatus: { 0: "loaded" },
    frames: [
      {
        hour: 0,
        validHourKey: "2026-07-16T13:00:00Z",
        parameterAvailability: {
          temperature: "available",
          synoptic: "unavailable",
        },
        hoverGridKey: hoverKey,
        hoverGridBytes: hoverStored.length,
        ...(hoverSchemaVersion === undefined ? {} : { hoverGridSchemaVersion: hoverSchemaVersion }),
        layers: {
          temperature: {
            key: temperatureKey,
            bytes: pngBody.length,
            contentType: "image/png",
          },
        },
      },
    ],
  };
  const marker = {
    renderedAt,
    modelKey: "hrrr",
    viewKey: "conus",
    runId: RUN_ID,
    hour: 0,
    validTime: "2026-07-16T13:00:00Z",
    rendererSignature: markerRendererSignature,
    parameterAvailability: manifest.frames[0].parameterAvailability,
    sourceProvenance: { schemaVersion: 2, scope: "fixture" },
    renderProfile,
  };
  writeJson(manifestPath, manifest);
  writeJson(path.join(frameDirectory, ".complete.json"), marker);
  return {
    artifactRoot,
    manifestPath,
    markerPath: path.join(frameDirectory, ".complete.json"),
    hoverPath: path.join(artifactRoot, ...hoverKey.split("/")),
    hoverKey,
    temperatureKey,
    temperaturePath: path.join(artifactRoot, ...temperatureKey.split("/")),
  };
}

function writeJson(target, value) {
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function fingerprintTree(root) {
  const records = [];
  function visit(directory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
      } else {
        const body = fs.readFileSync(target);
        records.push([
          path.relative(root, target),
          body.length,
          crypto.createHash("sha256").update(body).digest("hex"),
        ]);
      }
    }
  }
  visit(root);
  return records;
}

test("exact comparison ignores only volatile publication/profile metadata and never mutates caches", (t) => {
  const fixture = makeFixturePair(t);
  const beforeBaseline = fingerprintTree(fixture.baselineCacheRoot);
  const beforeCandidate = fingerprintTree(fixture.candidateCacheRoot);
  const report = fixture.compare();

  assert.equal(report.exact, true);
  assert.equal(report.pngComparison, "container");
  assert.equal(report.counts.manifestsEqual, 1);
  assert.equal(report.counts.completionMarkersEqual, 1);
  assert.equal(report.counts.payloadsCompared, 2);
  assert.equal(report.counts.payloadsEqual, 2);
  assert.equal(report.counts.hoverPayloadsCompared, 1);
  assert.equal(report.bytes.equalCanonical, Buffer.byteLength("hover-data") + Buffer.byteLength("png-payload"));
  assert.equal(report.hashes.baselineCanonicalPayloadSha256, report.hashes.candidateCanonicalPayloadSha256);
  assert.equal(
    report.hashes.baselineCanonicalPayloadSha256,
    "6e356156701256cd6a5dd7b2f0ce671fd01b27f6914c17ef954ba5aea900a4e2",
    "the default exact-container aggregate hash contract remains unchanged",
  );
  assert.deepEqual(fingerprintTree(fixture.baselineCacheRoot), beforeBaseline);
  assert.deepEqual(fingerprintTree(fixture.candidateCacheRoot), beforeCandidate);
});

test("decoded-rgba mode equates different PNG containers and validates the signature transition", (t) => {
  const fixture = makeSemanticFixturePair(t);
  const before = fingerprintTree(fixture.temporaryRoot);
  const report = fixture.compare({ pngComparison: "decoded-rgba" });
  const manifestReport = report.manifests[0];

  assert.equal(report.exact, true);
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.pngComparison, "decoded-rgba");
  assert.equal(report.counts.payloadsCompared, 2);
  assert.equal(report.counts.payloadsEqual, 2);
  assert.equal(report.counts.declaredPngByteReferencesChecked, 2);
  assert.equal(report.counts.declaredPngByteMismatches, 0);
  assert.equal(report.counts.rendererSignatureTransitionsChecked, 1);
  assert.equal(report.counts.rendererSignatureTransitionsValid, 1);
  assert.equal(report.counts.pngStoredContainerChanges, 1);
  assert.equal(report.pngStoredContainerChanges.count, 1);
  assert.equal(report.pngStoredContainerChanges.detailsTruncated, false);
  assert.match(report.pngStoredContainerChanges.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    report.pngStoredContainerChanges.entries.map((entry) => [entry.manifest, entry.logicalKey]),
    [[MANIFEST_ID, fixture.baseline.temperatureKey]],
  );
  assert.notEqual(
    report.pngStoredContainerChanges.entries[0].baseline.storedSha256,
    report.pngStoredContainerChanges.entries[0].candidate.storedSha256,
  );
  assert.deepEqual(manifestReport.payloads.pngStoredContainerChanges, {
    count: 1,
    entries: report.pngStoredContainerChanges.entries.map(({ manifest: _manifest, ...entry }) => entry),
    detailsTruncated: false,
    sha256: manifestReport.payloads.pngStoredContainerChanges.sha256,
  });
  assert.equal(manifestReport.manifest.comparison.equal, true);
  assert.deepEqual(manifestReport.signatureTransition, {
    required: true,
    baseline: "fixture-v1",
    candidate: "fixture-v2",
    changed: true,
    valid: true,
    issues: [],
  });
  assert.equal(
    manifestReport.payloads.hashes.baselineCanonicalSha256,
    manifestReport.payloads.hashes.candidateCanonicalSha256,
  );
  assert.equal(
    report.bytes.equalCanonical,
    Buffer.byteLength("hover-data") + 8 + FIXTURE_RGBA.length,
    "the PNG canonical body is width/height framing followed by decoded RGBA",
  );
  assert.deepEqual(fingerprintTree(fixture.temporaryRoot), before);

  const cli = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      `--baseline-cache-root=${fixture.baselineCacheRoot}`,
      `--candidate-cache-root=${fixture.candidateCacheRoot}`,
      `--manifest=${MANIFEST_ID}`,
      "--png-comparison=decoded-rgba",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const cliReport = JSON.parse(cli.stdout);
  assert.equal(cliReport.exact, true);
  assert.equal(cliReport.pngStoredContainerChanges.sha256, report.pngStoredContainerChanges.sha256);
});

test("default PNG comparison remains exact-container and does not decode PNG bytes", (t) => {
  const fixture = makeSemanticFixturePair(t);
  const report = fixture.compare();
  const mismatch = report.manifests[0].payloads.mismatches.find(
    (entry) => entry.logicalKey === fixture.baseline.temperatureKey,
  );

  assert.equal(report.pngComparison, "container");
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.exact, false);
  assert.equal(report.pngStoredContainerChanges.count, 0);
  assert.deepEqual(report.pngStoredContainerChanges.entries, []);
  assert.equal(mismatch.kind, "decoded-byte-mismatch");
  assert.equal(mismatch.baseline.kind, "container-bytes");
  assert.equal(mismatch.candidate.kind, "container-bytes");
  assert.notEqual(report.hashes.baselineCanonicalPayloadSha256, report.hashes.candidateCanonicalPayloadSha256);
});

test("decoded-rgba PNG container-change inventory is bounded and deterministic", (t) => {
  const fixture = makeSemanticFixturePair(t);
  const baselineManifest = JSON.parse(fs.readFileSync(fixture.baseline.manifestPath, "utf8"));
  const candidateManifest = JSON.parse(fs.readFileSync(fixture.candidate.manifestPath, "utf8"));
  const baselinePng = fs.readFileSync(fixture.baseline.temperaturePath);
  const candidatePng = fs.readFileSync(fixture.candidate.temperaturePath);

  for (let index = 0; index < 101; index += 1) {
    const layerKey = `auditLayer${String(index).padStart(3, "0")}`;
    const physicalKey = `tiles/hrrr/${RUN_ID}/conus/000/audit-${String(index).padStart(3, "0")}.png`;
    baselineManifest.frames[0].layers[layerKey] = {
      key: physicalKey,
      bytes: baselinePng.length,
      contentType: "image/png",
    };
    candidateManifest.frames[0].layers[layerKey] = {
      key: physicalKey,
      bytes: candidatePng.length,
      contentType: "image/png",
    };
    fs.writeFileSync(path.join(fixture.baseline.artifactRoot, ...physicalKey.split("/")), baselinePng);
    fs.writeFileSync(path.join(fixture.candidate.artifactRoot, ...physicalKey.split("/")), candidatePng);
  }
  writeJson(fixture.baseline.manifestPath, baselineManifest);
  writeJson(fixture.candidate.manifestPath, candidateManifest);

  const first = fixture.compare({ pngComparison: "decoded-rgba" });
  const second = fixture.compare({ pngComparison: "decoded-rgba" });
  const keys = first.pngStoredContainerChanges.entries.map((entry) => entry.logicalKey);

  assert.equal(first.exact, true);
  assert.equal(first.pngStoredContainerChanges.count, 102);
  assert.equal(first.pngStoredContainerChanges.entries.length, 100);
  assert.equal(first.pngStoredContainerChanges.detailsTruncated, true);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(first.pngStoredContainerChanges.sha256, second.pngStoredContainerChanges.sha256);
  assert.deepEqual(first.pngStoredContainerChanges.entries, second.pngStoredContainerChanges.entries);
});

test("decoded-rgba mode frames dimensions so equal RGBA bytes at different dimensions fail", (t) => {
  const candidatePngBody = encodeRgbaPng({
    width: 1,
    height: 4,
    data: FIXTURE_RGBA,
    compressionLevel: 9,
    filterType: 4,
  });
  const fixture = makeSemanticFixturePair(t, { candidatePngBody });
  const report = fixture.compare({ pngComparison: "decoded-rgba" });
  const mismatch = report.manifests[0].payloads.mismatches.find((entry) => entry.kind === "png-dimension-mismatch");

  assert.equal(report.exact, false);
  assert.ok(mismatch);
  assert.deepEqual({ width: mismatch.baseline.width, height: mismatch.baseline.height }, { width: 2, height: 2 });
  assert.deepEqual({ width: mismatch.candidate.width, height: mismatch.candidate.height }, { width: 1, height: 4 });
  assert.notEqual(mismatch.baseline.decodedSha256, mismatch.candidate.decodedSha256);
});

test("decoded-rgba mode rejects manifest PNG byte declarations that do not match stored files", (t) => {
  const fixture = makeSemanticFixturePair(t);
  const candidateManifest = JSON.parse(fs.readFileSync(fixture.candidate.manifestPath, "utf8"));
  candidateManifest.frames[0].layers.temperature.bytes += 1;
  writeJson(fixture.candidate.manifestPath, candidateManifest);

  const report = fixture.compare({ pngComparison: "decoded-rgba" });
  const mismatch = report.manifests[0].payloads.mismatches.find(
    (entry) => entry.kind === "candidate-declared-byte-mismatch",
  );

  assert.equal(report.exact, false);
  assert.equal(report.manifests[0].manifest.comparison.equal, true);
  assert.ok(mismatch);
  assert.equal(mismatch.path, "/frames/0/layers/temperature/bytes");
  assert.equal(mismatch.declaredBytes, mismatch.actualStoredBytes + 1);
  assert.equal(report.counts.declaredPngByteMismatches, 1);
});

test("decoded-rgba normalization still rejects unrelated manifest metadata changes", (t) => {
  const fixture = makeSemanticFixturePair(t);
  const candidateManifest = JSON.parse(fs.readFileSync(fixture.candidate.manifestPath, "utf8"));
  candidateManifest.source = "changed-scientific-lineage";
  writeJson(fixture.candidate.manifestPath, candidateManifest);

  const report = fixture.compare({ pngComparison: "decoded-rgba" });
  const differences = report.manifests[0].manifest.comparison.differences;

  assert.equal(report.exact, false);
  assert.deepEqual(
    differences.map((entry) => entry.path),
    ["/source"],
  );
  assert.equal(report.manifests[0].payloads.exact, true);
  assert.equal(report.manifests[0].signatureTransition.valid, true);
});

test("decoded-rgba mode requires a signature transition and validates marker signatures", (t) => {
  const unchanged = makeSemanticFixturePair(t, {
    candidateRendererSignature: "fixture-v1",
  });
  const unchangedReport = unchanged.compare({ pngComparison: "decoded-rgba" });
  assert.equal(unchangedReport.exact, false);
  assert.equal(unchangedReport.mismatches.rendererSignatureTransitions, 1);
  assert.equal(unchangedReport.manifests[0].signatureTransition.changed, false);
  assert.deepEqual(unchangedReport.manifests[0].signatureTransition.issues, [
    {
      kind: "renderer-signature-did-not-transition",
      baseline: "fixture-v1",
      candidate: "fixture-v1",
    },
  ]);

  const staleMarker = makeSemanticFixturePair(t, {
    candidateMarkerRendererSignature: "stale-fixture-v1",
  });
  const staleMarkerReport = staleMarker.compare({ pngComparison: "decoded-rgba" });
  const markerMismatch = staleMarkerReport.manifests[0].completions.mismatches[0];
  assert.equal(staleMarkerReport.exact, false);
  assert.equal(staleMarkerReport.manifests[0].signatureTransition.valid, true);
  assert.equal(markerMismatch.comparison.equal, true);
  assert.deepEqual(markerMismatch.signatureValidation.issues, [
    {
      side: "candidate",
      kind: "completion-renderer-signature-mismatch",
      expected: "fixture-v2",
      actual: "stale-fixture-v1",
    },
  ]);
});

test("decoded-rgba mode fails closed on invalid PNG payloads", (t) => {
  const fixture = makeSemanticFixturePair(t, {
    candidatePngBody: Buffer.from("not-a-png"),
  });
  const report = fixture.compare({ pngComparison: "decoded-rgba" });
  const mismatch = report.manifests[0].payloads.mismatches.find((entry) => entry.kind === "candidate-payload-error");

  assert.equal(report.exact, false);
  assert.ok(mismatch);
  assert.equal(mismatch.candidateKey, fixture.candidate.temperatureKey);
  assert.equal(typeof mismatch.error, "string");
  assert.ok(mismatch.error.length > 0);
  assert.equal(report.counts.payloadReadOrDecodeErrors, 1);
  assert.equal(report.counts.declaredPngByteMismatches, 0);
});

test("decoded-int16 mode equates strict MVH3/MVH4 hover containers and audits the transition", (t) => {
  const fixture = makeHoverSemanticFixturePair(t);
  const before = fingerprintTree(fixture.temporaryRoot);
  const report = fixture.compare({ hoverComparison: "decoded-int16" });
  const manifestReport = report.manifests[0];

  assert.equal(report.exact, true);
  assert.equal(report.hoverComparison, "decoded-int16");
  assert.equal(report.counts.payloadsCompared, 2);
  assert.equal(report.counts.payloadsEqual, 2);
  assert.equal(report.counts.declaredHoverReferencesChecked, 2);
  assert.equal(report.counts.declaredHoverReferenceMismatches, 0);
  assert.equal(report.counts.rendererSignatureTransitionsValid, 1);
  assert.equal(report.counts.hoverStoredContainerChanges, 1);
  assert.equal(report.hoverStoredContainerChanges.count, 1);
  assert.equal(manifestReport.manifest.comparison.equal, true);
  assert.deepEqual(
    report.hoverStoredContainerChanges.entries.map((entry) => [
      entry.logicalKey,
      entry.baseline.magic,
      entry.baseline.schemaVersion,
      entry.candidate.magic,
      entry.candidate.schemaVersion,
      entry.candidate.predictor,
    ]),
    [[canonicalizeArtifactKey(fixture.baseline.hoverKey), "MVH3", 3, "MVH4", 4, "gradient2d"]],
  );
  assert.equal(
    manifestReport.payloads.hashes.baselineCanonicalSha256,
    manifestReport.payloads.hashes.candidateCanonicalSha256,
  );
  assert.deepEqual(fingerprintTree(fixture.temporaryRoot), before, "semantic hover comparison remains read-only");

  const cli = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      `--baseline-cache-root=${fixture.baselineCacheRoot}`,
      `--candidate-cache-root=${fixture.candidateCacheRoot}`,
      `--manifest=${MANIFEST_ID}`,
      "--hover-comparison=decoded-int16",
    ],
    { encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).exact, true);
  assert.deepEqual(fingerprintTree(fixture.temporaryRoot), before, "semantic hover CLI remains read-only");
});

test("decoded-int16 equivalence is symmetric for MVH4 to MVH3", (t) => {
  const fixture = makeHoverSemanticFixturePair(t, {
    baselineSchemaVersion: 4,
    candidateSchemaVersion: 3,
    baselineCodec: "br",
    candidateCodec: "gz",
  });
  const report = fixture.compare({ hoverComparison: "decoded-int16" });
  assert.equal(report.exact, true);
  assert.equal(report.hoverStoredContainerChanges.entries[0].baseline.schemaVersion, 4);
  assert.equal(report.hoverStoredContainerChanges.entries[0].candidate.schemaVersion, 3);
});

test("decoded-int16 mode equates canonical empty MVH3 and MVH4 with positive dimensions", (t) => {
  const fixture = makeHoverSemanticFixturePair(t, {
    baselineSchemaVersion: 3,
    candidateSchemaVersion: 4,
    baselineVariables: {},
    candidateVariables: {},
  });
  const report = fixture.compare({ hoverComparison: "decoded-int16" });
  assert.equal(report.exact, true);
  assert.equal(report.counts.declaredHoverReferenceMismatches, 0);
  assert.equal(report.counts.payloadsEqual, 2);
  assert.equal(report.counts.hoverStoredContainerChanges, 1);
});

test("decoded-int16 framing detects absolute values, keys, metadata, and dimensions independently", async (t) => {
  const probes = [
    {
      name: "value",
      options: {
        candidateVariables: {
          temperatureF: {
            scale: 0.05,
            offset: -100,
            missing: -32768,
            values: Int16Array.from([-32768, 32767, -12345, 23455]),
          },
          windMph: {
            scale: 0.1,
            offset: 0,
            missing: -32768,
            values: Int16Array.from([0, 5, 25, 100]),
          },
        },
      },
    },
    {
      name: "key",
      options: {
        candidateVariables: {
          temperatureF: {
            scale: 0.05,
            offset: -100,
            missing: -32768,
            values: Int16Array.from([-32768, 32767, -12345, 23456]),
          },
          windKnots: {
            scale: 0.1,
            offset: 0,
            missing: -32768,
            values: Int16Array.from([0, 5, 25, 100]),
          },
        },
      },
    },
    {
      name: "metadata",
      options: {
        candidateVariables: {
          temperatureF: {
            scale: 0.1,
            offset: -100,
            missing: -32768,
            values: Int16Array.from([-32768, 32767, -12345, 23456]),
          },
          windMph: {
            scale: 0.1,
            offset: 0,
            missing: -32768,
            values: Int16Array.from([0, 5, 25, 100]),
          },
        },
      },
    },
    {
      name: "offset metadata",
      options: {
        candidateVariables: {
          temperatureF: {
            scale: 0.05,
            offset: -99,
            missing: -32768,
            values: Int16Array.from([-32768, 32767, -12345, 23456]),
          },
          windMph: {
            scale: 0.1,
            offset: 0,
            missing: -32768,
            values: Int16Array.from([0, 5, 25, 100]),
          },
        },
      },
    },
    {
      name: "missing metadata",
      options: {
        candidateVariables: {
          temperatureF: {
            scale: 0.05,
            offset: -100,
            missing: -32767,
            values: Int16Array.from([-32768, 32767, -12345, 23456]),
          },
          windMph: {
            scale: 0.1,
            offset: 0,
            missing: -32768,
            values: Int16Array.from([0, 5, 25, 100]),
          },
        },
      },
    },
    {
      name: "dimensions",
      options: { candidateRows: 1, candidateCols: 4 },
    },
  ];

  for (const probe of probes) {
    await t.test(probe.name, () => {
      const fixture = makeHoverSemanticFixturePair(t, probe.options);
      const report = fixture.compare({ hoverComparison: "decoded-int16" });
      const mismatch = report.manifests[0].payloads.mismatches.find((entry) => entry.kind === "decoded-byte-mismatch");
      assert.equal(report.exact, false);
      assert.ok(mismatch, `${probe.name} must alter the canonical hover frame`);
      assert.equal(mismatch.baseline.kind, "hover-absolute-framed-int16");
      assert.equal(mismatch.candidate.kind, "hover-absolute-framed-int16");
    });
  }
});

test("decoded-int16 metadata framing preserves IEEE-754 signed zero", (t) => {
  const candidateHoverBody = hoverRaw({ schemaVersion: 4, rows: 2, cols: 2 });
  const fixture = makeHoverSemanticFixturePair(t, {
    candidateHoverBody,
    baselineHoverBody: withNegativeZeroFirstOffset(
      hoverRaw({ schemaVersion: 3, rows: 2, cols: 2, reverseVariableOrder: true }),
    ),
  });
  const report = fixture.compare({ hoverComparison: "decoded-int16" });
  const mismatch = report.manifests[0].payloads.mismatches.find((entry) => entry.kind === "decoded-byte-mismatch");
  assert.equal(report.exact, false);
  assert.ok(mismatch);
});

test("decoded-int16 mode fails closed on malformed bodies and invalid hover declarations", (t) => {
  const malformed = makeHoverSemanticFixturePair(t, {
    candidateHoverBody: Buffer.from("not-a-hover-container"),
  });
  const malformedCandidateManifest = JSON.parse(fs.readFileSync(malformed.candidate.manifestPath, "utf8"));
  malformedCandidateManifest.frames[0].hoverGridSchemaVersion = 0;
  writeJson(malformed.candidate.manifestPath, malformedCandidateManifest);
  const malformedReport = malformed.compare({ hoverComparison: "decoded-int16" });
  assert.equal(malformedReport.exact, false);
  assert.equal(malformedReport.counts.declaredHoverWildcardReferences, 1);
  assert.ok(
    malformedReport.manifests[0].payloads.mismatches.some(
      (entry) => entry.kind === "candidate-payload-error" && typeof entry.error === "string" && entry.error.length > 0,
    ),
  );

  const declarations = makeHoverSemanticFixturePair(t);
  const candidateManifest = JSON.parse(fs.readFileSync(declarations.candidate.manifestPath, "utf8"));
  candidateManifest.frames[0].hoverGridBytes += 1;
  candidateManifest.frames[0].hoverGridSchemaVersion = 3;
  writeJson(declarations.candidate.manifestPath, candidateManifest);
  const declarationReport = declarations.compare({ hoverComparison: "decoded-int16" });
  const kinds = declarationReport.manifests[0].payloads.mismatches.map((entry) => entry.kind);
  assert.ok(kinds.includes("candidate-declared-hover-byte-mismatch"));
  assert.ok(kinds.includes("candidate-declared-hover-schema-mismatch"));
  assert.equal(declarationReport.manifests[0].manifest.comparison.equal, true);
  assert.equal(declarationReport.counts.declaredHoverReferenceMismatches, 2);
});

test("decoded-int16 treats base and supplemental zero, absent, and null schemas as strict-decode wildcards", (t) => {
  const fixture = makeHoverSemanticFixturePair(t);
  const baselineManifest = JSON.parse(fs.readFileSync(fixture.baseline.manifestPath, "utf8"));
  const candidateManifest = JSON.parse(fs.readFileSync(fixture.candidate.manifestPath, "utf8"));
  baselineManifest.frames[0].hoverGridSchemaVersion = 0;
  delete candidateManifest.frames[0].hoverGridSchemaVersion;

  const baselineZeroKey = `tiles/hrrr/${RUN_ID}/conus/000/hover-grid-zero.bin.gz`;
  const candidateZeroKey = `tiles/hrrr/${RUN_ID}/conus/000/hover-grid-zero.bin.br`;
  const baselineNullKey = `tiles/hrrr/${RUN_ID}/conus/000/hover-grid-null.bin.gz`;
  const candidateNullKey = `tiles/hrrr/${RUN_ID}/conus/000/hover-grid-null.bin.br`;
  const baselineBody = zlib.gzipSync(hoverRaw({ schemaVersion: 3, rows: 2, cols: 2 }), { level: 1 });
  const candidateBody = zlib.brotliCompressSync(hoverRaw({ schemaVersion: 4, rows: 2, cols: 2 }));
  for (const key of [baselineZeroKey, baselineNullKey]) {
    fs.writeFileSync(path.join(fixture.baseline.artifactRoot, ...key.split("/")), baselineBody);
  }
  for (const key of [candidateZeroKey, candidateNullKey]) {
    fs.writeFileSync(path.join(fixture.candidate.artifactRoot, ...key.split("/")), candidateBody);
  }
  baselineManifest.frames[0].hoverGridSupplemental = {
    zero: { key: baselineZeroKey, bytes: baselineBody.length, schemaVersion: 0 },
    nullable: { key: baselineNullKey, bytes: baselineBody.length, schemaVersion: null },
  };
  candidateManifest.frames[0].hoverGridSupplemental = {
    zero: { key: candidateZeroKey, bytes: candidateBody.length },
    nullable: { key: candidateNullKey, bytes: candidateBody.length, schemaVersion: null },
  };
  writeJson(fixture.baseline.manifestPath, baselineManifest);
  writeJson(fixture.candidate.manifestPath, candidateManifest);

  const report = fixture.compare({ hoverComparison: "decoded-int16" });
  assert.equal(report.exact, true);
  assert.equal(report.counts.declaredHoverReferencesChecked, 6);
  assert.equal(report.counts.declaredHoverWildcardReferences, 6);
  assert.equal(report.counts.declaredHoverReferenceMismatches, 0);
  assert.equal(report.counts.hoverStoredContainerChanges, 3);
});

test("decoded-int16 treats a null base hover schema as a wildcard", (t) => {
  const fixture = makeHoverSemanticFixturePair(t);
  for (const side of [fixture.baseline, fixture.candidate]) {
    const manifest = JSON.parse(fs.readFileSync(side.manifestPath, "utf8"));
    manifest.frames[0].hoverGridSchemaVersion = null;
    writeJson(side.manifestPath, manifest);
  }
  const report = fixture.compare({ hoverComparison: "decoded-int16" });
  assert.equal(report.exact, true);
  assert.equal(report.counts.declaredHoverWildcardReferences, 2);
  assert.equal(report.counts.declaredHoverReferenceMismatches, 0);
});

test("decoded-int16 makes supplemental null/absence inherit the base while explicit zero stays wildcard", (t) => {
  const fixture = makeHoverSemanticFixturePair(t);
  const baselineManifest = JSON.parse(fs.readFileSync(fixture.baseline.manifestPath, "utf8"));
  const candidateManifest = JSON.parse(fs.readFileSync(fixture.candidate.manifestPath, "utf8"));
  const baselineBody = zlib.gzipSync(hoverRaw({ schemaVersion: 3, rows: 2, cols: 2 }), { level: 1 });
  const candidateBody = zlib.brotliCompressSync(hoverRaw({ schemaVersion: 3, rows: 2, cols: 2 }));
  const names = ["absent", "nullable", "explicit"];
  baselineManifest.frames[0].hoverGridSupplemental = {};
  candidateManifest.frames[0].hoverGridSupplemental = {};
  for (const name of names) {
    const baselineKey = `tiles/hrrr/${RUN_ID}/conus/000/hover-grid-${name}.bin.gz`;
    const candidateKey = `tiles/hrrr/${RUN_ID}/conus/000/hover-grid-${name}.bin.br`;
    fs.writeFileSync(path.join(fixture.baseline.artifactRoot, ...baselineKey.split("/")), baselineBody);
    fs.writeFileSync(path.join(fixture.candidate.artifactRoot, ...candidateKey.split("/")), candidateBody);
    baselineManifest.frames[0].hoverGridSupplemental[name] = {
      key: baselineKey,
      bytes: baselineBody.length,
      schemaVersion: 3,
    };
    candidateManifest.frames[0].hoverGridSupplemental[name] = {
      key: candidateKey,
      bytes: candidateBody.length,
      ...(name === "nullable" ? { schemaVersion: null } : name === "explicit" ? { schemaVersion: 0 } : {}),
    };
  }
  writeJson(fixture.baseline.manifestPath, baselineManifest);
  writeJson(fixture.candidate.manifestPath, candidateManifest);

  const inherited = fixture.compare({ hoverComparison: "decoded-int16" });
  const inheritedMismatches = inherited.manifests[0].payloads.mismatches.filter(
    (entry) => entry.kind === "candidate-declared-hover-schema-mismatch",
  );
  assert.equal(inherited.exact, false);
  assert.equal(inherited.counts.declaredHoverWildcardReferences, 1);
  assert.deepEqual(
    inheritedMismatches.map((entry) => entry.path),
    ["/frames/0/hoverGridSupplemental/absent/schemaVersion", "/frames/0/hoverGridSupplemental/nullable/schemaVersion"],
  );
  assert.ok(inheritedMismatches.every((entry) => entry.declaredSchemaVersion === 4 && entry.actualSchemaVersion === 3));
  assert.ok(
    !inherited.manifests[0].payloads.mismatches.some((entry) =>
      String(entry.path || "").includes("/hoverGridSupplemental/explicit/"),
    ),
  );

  candidateManifest.frames[0].hoverGridSupplemental.absent.schemaVersion = 0;
  candidateManifest.frames[0].hoverGridSupplemental.nullable.schemaVersion = 0;
  writeJson(fixture.candidate.manifestPath, candidateManifest);
  const explicit = fixture.compare({ hoverComparison: "decoded-int16" });
  assert.equal(explicit.exact, true);
  assert.equal(explicit.counts.declaredHoverWildcardReferences, 3);
  assert.equal(explicit.counts.declaredHoverReferenceMismatches, 0);
});

test("decoded-int16 rejects malformed non-null hover schema declarations without coercion", (t) => {
  for (const invalid of ["0", -1, 1.5, 5]) {
    const fixture = makeHoverSemanticFixturePair(t);
    const candidateManifest = JSON.parse(fs.readFileSync(fixture.candidate.manifestPath, "utf8"));
    candidateManifest.frames[0].hoverGridSchemaVersion = invalid;
    writeJson(fixture.candidate.manifestPath, candidateManifest);
    const report = fixture.compare({ hoverComparison: "decoded-int16" });
    const mismatch = report.manifests[0].payloads.mismatches.find(
      (entry) => entry.kind === "candidate-declared-hover-schema-invalid",
    );
    assert.equal(report.exact, false, String(invalid));
    assert.ok(mismatch, String(invalid));
    assert.equal(mismatch.declaredSchemaVersion, invalid);
  }
});

test("decoded-int16 validates and canonicalizes base and supplemental hover references", (t) => {
  const fixture = makeHoverSemanticFixturePair(t);
  const baselineManifest = JSON.parse(fs.readFileSync(fixture.baseline.manifestPath, "utf8"));
  const candidateManifest = JSON.parse(fs.readFileSync(fixture.candidate.manifestPath, "utf8"));
  const baselineKey = `tiles/hrrr/${RUN_ID}/conus/000/hover-grid-extra.bin.gz`;
  const candidateKey = `tiles/hrrr/${RUN_ID}/conus/000/hover-grid-extra.bin.br`;
  const baselineBody = zlib.gzipSync(hoverRaw({ schemaVersion: 3, rows: 2, cols: 2 }), { level: 1 });
  const candidateBody = zlib.brotliCompressSync(hoverRaw({ schemaVersion: 4, rows: 2, cols: 2 }));
  fs.writeFileSync(path.join(fixture.baseline.artifactRoot, ...baselineKey.split("/")), baselineBody);
  fs.writeFileSync(path.join(fixture.candidate.artifactRoot, ...candidateKey.split("/")), candidateBody);
  baselineManifest.frames[0].hoverGridSupplemental = {
    extra: { key: baselineKey, bytes: baselineBody.length, schemaVersion: 3 },
  };
  candidateManifest.frames[0].hoverGridSupplemental = {
    extra: { key: candidateKey, bytes: candidateBody.length, schemaVersion: 4 },
  };
  writeJson(fixture.baseline.manifestPath, baselineManifest);
  writeJson(fixture.candidate.manifestPath, candidateManifest);

  const report = fixture.compare({ hoverComparison: "decoded-int16" });
  assert.equal(report.exact, true);
  assert.equal(report.counts.declaredHoverReferencesChecked, 4);
  assert.equal(report.counts.hoverStoredContainerChanges, 2);
  assert.equal(report.manifests[0].inventory.baselineDeclaredHoverReferences, 2);
  assert.equal(report.manifests[0].inventory.candidateDeclaredHoverReferences, 2);

  candidateManifest.frames[0].hoverGridSupplemental.extra.bytes += 1;
  candidateManifest.frames[0].hoverGridSupplemental.extra.schemaVersion = 3;
  writeJson(fixture.candidate.manifestPath, candidateManifest);
  const invalid = fixture.compare({ hoverComparison: "decoded-int16" });
  const supplementalMismatches = invalid.manifests[0].payloads.mismatches.filter((entry) =>
    String(entry.path || "").includes("/hoverGridSupplemental/extra/"),
  );
  assert.deepEqual(
    supplementalMismatches.map((entry) => [entry.kind, entry.path]),
    [
      ["candidate-declared-hover-byte-mismatch", "/frames/0/hoverGridSupplemental/extra/bytes"],
      ["candidate-declared-hover-schema-mismatch", "/frames/0/hoverGridSupplemental/extra/schemaVersion"],
    ],
  );
});

test("decoded-int16 mode requires the renderer signature to transition", (t) => {
  const fixture = makeHoverSemanticFixturePair(t, {
    baselineRendererSignature: "hover-fixture-v3",
    candidateRendererSignature: "hover-fixture-v3",
  });
  const report = fixture.compare({ hoverComparison: "decoded-int16" });
  assert.equal(report.exact, false);
  assert.equal(report.mismatches.rendererSignatureTransitions, 1);
  assert.equal(report.manifests[0].signatureTransition.changed, false);

  const staleMarker = makeHoverSemanticFixturePair(t, {
    candidateMarkerRendererSignature: "stale-hover-signature",
  });
  const staleReport = staleMarker.compare({ hoverComparison: "decoded-int16" });
  assert.equal(staleReport.exact, false);
  assert.deepEqual(staleReport.manifests[0].completions.mismatches[0].signatureValidation.issues, [
    {
      side: "candidate",
      kind: "completion-renderer-signature-mismatch",
      expected: "hover-fixture-v4",
      actual: "stale-hover-signature",
    },
  ]);
});

test("decoded-int16 normalization does not hide unrelated binary-key lineage metadata", (t) => {
  const fixture = makeHoverSemanticFixturePair(t);
  const baselineManifest = JSON.parse(fs.readFileSync(fixture.baseline.manifestPath, "utf8"));
  const candidateManifest = JSON.parse(fs.readFileSync(fixture.candidate.manifestPath, "utf8"));
  baselineManifest.sourceContainer = { key: "lineage/source.bin.br", bytes: 10, schemaVersion: 3 };
  candidateManifest.sourceContainer = { key: "lineage/source.bin.br", bytes: 11, schemaVersion: 4 };
  writeJson(fixture.baseline.manifestPath, baselineManifest);
  writeJson(fixture.candidate.manifestPath, candidateManifest);

  const report = fixture.compare({ hoverComparison: "decoded-int16" });
  assert.equal(report.exact, false);
  assert.deepEqual(
    report.manifests[0].manifest.comparison.differences.map((entry) => entry.path),
    ["/sourceContainer/bytes", "/sourceContainer/schemaVersion"],
  );
});

test("gzip and Brotli hover containers share one logical inventory key and compare decoded bytes", (t) => {
  const fixture = makeFixturePair(t, { baselineCodec: "gz", candidateCodec: "br" });
  const report = fixture.compare();
  const manifestReport = report.manifests[0];

  assert.equal(canonicalizeArtifactKey(fixture.baseline.hoverKey), canonicalizeArtifactKey(fixture.candidate.hoverKey));
  assert.equal(manifestReport.payloads.exact, true);
  assert.equal(manifestReport.payloads.counts.containerChanges, 1);
  assert.equal(manifestReport.payloads.counts.decodedEqual, 2);
  assert.equal(
    manifestReport.payloads.hashes.baselineCanonicalSha256,
    manifestReport.payloads.hashes.candidateCanonicalSha256,
  );
  assert.equal(report.exact, false, "the separately compared manifest still reports the codec/byte metadata change");
  assert.equal(report.mismatches.manifests, 1);
});

test("decoded payload differences report hashes, byte counts, and first differing byte", (t) => {
  const fixture = makeFixturePair(t, { candidateHoverBody: "hover-date" });
  const report = fixture.compare();
  const mismatch = report.manifests[0].payloads.mismatches.find((entry) => entry.kind === "decoded-byte-mismatch");

  assert.equal(report.exact, false);
  assert.ok(mismatch);
  assert.equal(mismatch.logicalKey.endsWith("hover-grid.bin"), true);
  assert.equal(mismatch.firstDifferentByte, 9);
  assert.notEqual(mismatch.baseline.decodedSha256, mismatch.candidate.decodedSha256);
  assert.equal(report.counts.payloadsCompared, 2);
  assert.equal(report.counts.payloadsEqual, 1);
});

test("inventory and missing-file errors are explicit payload mismatches", (t) => {
  const fixture = makeFixturePair(t);
  const candidateManifest = JSON.parse(fs.readFileSync(fixture.candidate.manifestPath, "utf8"));
  const extraKey = `tiles/hrrr/${RUN_ID}/conus/000/dewpoint2m.png`;
  candidateManifest.frames[0].layers.dewpoint2m = {
    key: extraKey,
    bytes: 5,
    contentType: "image/png",
  };
  candidateManifest.frames[0].parameterAvailability.dewpoint2m = "available";
  writeJson(fixture.candidate.manifestPath, candidateManifest);
  fs.writeFileSync(path.join(fixture.candidate.artifactRoot, ...extraKey.split("/")), "extra");
  fs.rmSync(fixture.candidate.hoverPath);

  const report = fixture.compare();
  const kinds = report.manifests[0].payloads.mismatches.map((entry) => entry.kind);
  assert.ok(kinds.includes("missing-from-baseline-inventory"));
  assert.ok(kinds.includes("candidate-payload-error"));
  assert.equal(report.exact, false);
});

test("nonvolatile completion metadata remains part of the comparison", (t) => {
  const fixture = makeFixturePair(t);
  const candidateMarker = JSON.parse(fs.readFileSync(fixture.candidate.markerPath, "utf8"));
  candidateMarker.sourceProvenance.scope = "changed-scientific-lineage";
  writeJson(fixture.candidate.markerPath, candidateMarker);

  const report = fixture.compare();
  const markerMismatch = report.manifests[0].completions.mismatches[0];
  assert.equal(report.exact, false);
  assert.equal(report.mismatches.completionMarkers, 1);
  assert.equal(markerMismatch.comparison.differences[0].path, "/sourceProvenance/scope");
});

test("CLI emits JSON, returns zero for parity, nonzero for mismatches, and leaves caches unchanged", (t) => {
  const fixture = makeFixturePair(t);
  const args = [
    SCRIPT_PATH,
    `--baseline-cache-root=${fixture.baselineCacheRoot}`,
    `--candidate-cache-root=${fixture.candidateCacheRoot}`,
    `--manifest=${MANIFEST_ID}`,
  ];
  const exactBefore = fingerprintTree(fixture.temporaryRoot);
  const exact = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(JSON.parse(exact.stdout).exact, true);
  assert.deepEqual(fingerprintTree(fixture.temporaryRoot), exactBefore);

  fs.writeFileSync(fixture.candidate.hoverPath, zlib.gzipSync(Buffer.from("different")));
  const mismatchBefore = fingerprintTree(fixture.temporaryRoot);
  const mismatch = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(mismatch.status, 1, mismatch.stderr);
  assert.equal(JSON.parse(mismatch.stdout).exact, false);
  assert.deepEqual(fingerprintTree(fixture.temporaryRoot), mismatchBefore);
});

test("manifest specs fail closed on latest pointers and traversal", () => {
  assert.deepEqual(parseManifestSpec(MANIFEST_ID), {
    id: MANIFEST_ID,
    model: "hrrr",
    run: RUN_ID,
    view: "conus",
    relativePath: `manifests/${MANIFEST_ID}`,
  });
  assert.throws(() => parseManifestSpec("hrrr/latest--conus.json"), /invalid manifest/);
  assert.throws(() => parseManifestSpec("../hrrr/20260716-1300Z--conus.json"), /invalid manifest/);
});

test("hover declaration collection tolerates null frame entries without inventing references", () => {
  const inventory = collectReferencedInventory({ frames: [null] }, parseManifestSpec(MANIFEST_ID));
  assert.equal(inventory.rawReferenceCount, 0);
  assert.deepEqual(inventory.declaredHoverReferences, []);
});

test("PNG comparison mode fails closed on unknown values", (t) => {
  const fixture = makeFixturePair(t);
  assert.throws(
    () => fixture.compare({ pngComparison: "approximately-the-same" }),
    /--png-comparison must be one of "container", "decoded-rgba"/,
  );
  assert.throws(
    () => fixture.compare({ hoverComparison: "approximately-the-same" }),
    /--hover-comparison must be one of "container", "decoded-int16"/,
  );
});
