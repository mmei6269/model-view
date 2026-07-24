"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  buildHoverGridBinaryRaw,
  decodeHoverGridPayload,
  encodeHoverGridBinaryPayload,
  inferHoverGridCompressionFromKey,
  inferHoverGridFormatFromKey,
} = require("../scripts/lib/hover-grid-binary");
const {
  DEFAULT_HOVER_GRID_COMPRESSION,
  resolveHoverGridCompressionConfig,
} = require("../scripts/lib/hover-grid-compression");
const { contentTypeFor, encodingFor } = require("../scripts/lib/local-artifact-server");
const { normalizeRenderedFrameArtifacts } = require("../scripts/lib/local-artifact-manifest");
const { HOVER_GRID_SCHEMA_VERSION } = require("../scripts/lib/modelview-runtime");
const { HOVER_GRID_ENCODINGS } = require("../scripts/lib/hover-grid-encoding");
const { serializeFrameArtifacts } = require("../scripts/noaa-beta-frame-worker");

test("hover schema v3 delta encoding round-trips losslessly, including wrap-around deltas", () => {
  assert.ok(HOVER_GRID_SCHEMA_VERSION >= 3, "runtime schema version advertises v3");
  // Values chosen to force every delta edge: missing sentinel (-32768),
  // full-range jumps whose deltas wrap int16 in both directions, zero runs,
  // and cross-variable carry.
  const alpha = new Int16Array([-32768, 32767, -32768, 0, 0, 1, -1, 12345]);
  const beta = new Int16Array([-12345, -12345, 32767, 32766, -32768, 5, 5, 5]);
  const body = encodeHoverGridBinaryPayload({
    schemaVersion: 3,
    rows: 2,
    cols: 4,
    variables: {
      alpha: { scale: 0.1, offset: 0, missing: -32768, values: alpha },
      beta: { scale: 1, offset: 2, missing: -32768, values: beta },
    },
    gzipLevel: 1,
  });
  const decoded = decodeHoverGridPayload(body);
  assert.equal(decoded.schemaVersion, 3);
  assert.equal(decoded.rows, 2);
  assert.equal(decoded.cols, 4);
  assert.deepEqual(Array.from(decoded.variables.alpha.values), Array.from(alpha));
  assert.deepEqual(Array.from(decoded.variables.beta.values), Array.from(beta));
  assert.equal(decoded.variables.alpha.scale, 0.1);
  assert.equal(decoded.variables.beta.offset, 2);
});

test("hover v1 payloads (no delta) still decode after the v3 default", () => {
  const values = new Int16Array([3, 1, 4, 1, 5, 9, 2, 6]);
  const body = encodeHoverGridBinaryPayload({
    schemaVersion: 1,
    rows: 2,
    cols: 4,
    variables: { pi: { scale: 1, offset: 0, missing: -32768, values } },
    gzipLevel: 1,
  });
  const decoded = decodeHoverGridPayload(body);
  assert.equal(decoded.schemaVersion, 1);
  assert.deepEqual(Array.from(decoded.variables.pi.values), Array.from(values));
});

test("merging a v1 payload into a v3 payload can explicitly roll back losslessly to v3", () => {
  const { mergeHoverGridPayloads } = require("../scripts/lib/hover-grid-binary");
  const a = new Int16Array([10, 20, 30, 40]);
  const b = new Int16Array([-5, -6, -7, -8]);
  const bodyV3 = encodeHoverGridBinaryPayload({
    schemaVersion: 3,
    rows: 1,
    cols: 4,
    variables: { a: { scale: 1, offset: 0, missing: -32768, values: a } },
  });
  const bodyV1 = encodeHoverGridBinaryPayload({
    schemaVersion: 1,
    rows: 1,
    cols: 4,
    variables: { b: { scale: 1, offset: 0, missing: -32768, values: b } },
  });
  const merged = decodeHoverGridPayload(
    mergeHoverGridPayloads(bodyV3, bodyV1, {
      format: "binary",
      encoding: HOVER_GRID_ENCODINGS.mvh3,
    }),
  );
  assert.equal(merged.schemaVersion, 3);
  assert.deepEqual(Array.from(merged.variables.a.values), Array.from(a));
  assert.deepEqual(Array.from(merged.variables.b.values), Array.from(b));
});

test("merging payloads with mismatched grid dimensions fails loudly", () => {
  const { mergeHoverGridPayloads } = require("../scripts/lib/hover-grid-binary");
  const bodyA = encodeHoverGridBinaryPayload({
    schemaVersion: 3,
    rows: 2,
    cols: 4,
    variables: { a: { scale: 1, offset: 0, missing: -32768, values: new Int16Array(8) } },
  });
  const bodyB = encodeHoverGridBinaryPayload({
    schemaVersion: 3,
    rows: 4,
    cols: 2,
    variables: { b: { scale: 1, offset: 0, missing: -32768, values: new Int16Array(8) } },
  });
  // Splicing variables across dimension regimes would self-describe an
  // inconsistent artifact that clients pad/truncate into spatially
  // misaligned hover values.
  assert.throws(() => mergeHoverGridPayloads(bodyA, bodyB, { format: "binary" }), /dimension mismatch/);
});

test("Brotli q0/q1 and legacy gzip decode to exactly the same hover bytes", () => {
  const values = new Int16Array([-32768, 32767, -17, 0, 1, 2048, -2048, 91]);
  const payload = {
    schemaVersion: 3,
    rows: 2,
    cols: 4,
    variables: { probe: { scale: 0.05, offset: 2, missing: -32768, values } },
  };
  const raw = buildHoverGridBinaryRaw(payload);
  const gzip = encodeHoverGridBinaryPayload({ ...payload, compressionBackend: "gzip", gzipLevel: 1 });
  const brotliQ0 = encodeHoverGridBinaryPayload({ ...payload, compressionBackend: "brotli", brotliQuality: 0 });
  const brotliQ1 = encodeHoverGridBinaryPayload({ ...payload, compressionBackend: "brotli", brotliQuality: 1 });

  assert.deepEqual(zlib.gunzipSync(gzip), raw);
  assert.deepEqual(zlib.brotliDecompressSync(brotliQ0), raw);
  assert.deepEqual(zlib.brotliDecompressSync(brotliQ1), raw);
  for (const body of [gzip, brotliQ0, brotliQ1]) {
    assert.deepEqual(Array.from(decodeHoverGridPayload(body).variables.probe.values), Array.from(values));
  }
});

test("legacy gzip and Brotli payloads merge into a Brotli target losslessly", () => {
  const { mergeHoverGridPayloads } = require("../scripts/lib/hover-grid-binary");
  const gzip = encodeHoverGridBinaryPayload({
    schemaVersion: 3,
    rows: 1,
    cols: 2,
    variables: { old: { scale: 1, offset: 0, missing: -32768, values: new Int16Array([1, 2]) } },
  });
  const brotli = encodeHoverGridBinaryPayload({
    schemaVersion: 3,
    rows: 1,
    cols: 2,
    variables: { fresh: { scale: 1, offset: 0, missing: -32768, values: new Int16Array([3, 4]) } },
    compressionBackend: "brotli",
    brotliQuality: 0,
  });
  const mergedBody = mergeHoverGridPayloads(gzip, brotli, {
    format: "binary",
    compression: resolveHoverGridCompressionConfig({ backend: "brotli", brotliQuality: 0 }),
    encoding: HOVER_GRID_ENCODINGS.mvh3,
  });
  assert.equal(zlib.brotliDecompressSync(mergedBody).subarray(0, 4).toString("ascii"), "MVH3");
  const merged = decodeHoverGridPayload(mergedBody);
  assert.deepEqual(Array.from(merged.variables.old.values), [1, 2]);
  assert.deepEqual(Array.from(merged.variables.fresh.values), [3, 4]);
});

test("hover compression config is explicit, bounded, and inferable from legacy/new keys", () => {
  assert.equal(DEFAULT_HOVER_GRID_COMPRESSION.backend, "brotli");
  assert.equal(DEFAULT_HOVER_GRID_COMPRESSION.brotliQuality, 0);
  assert.deepEqual(
    resolveHoverGridCompressionConfig({ backend: "brotli", brotliQuality: 99 }),
    resolveHoverGridCompressionConfig({ backend: "brotli", brotliQuality: 11 }),
  );
  assert.equal(inferHoverGridCompressionFromKey("hover-grid.bin.br").contentEncoding, "br");
  assert.equal(inferHoverGridCompressionFromKey("hover-grid.bin.gz").contentEncoding, "gzip");
  assert.equal(inferHoverGridFormatFromKey("hover-grid.bin.br"), "binary");
  assert.equal(inferHoverGridFormatFromKey("hover-grid.bin.gz"), "binary");
  assert.equal(encodingFor("hover-grid.bin.br"), "br");
  assert.equal(encodingFor("hover-grid.json.br"), "br");
  assert.equal(encodingFor("hover-grid.bin.gz"), "gzip");
  assert.match(contentTypeFor("hover-grid.json.br"), /^application\/json/);
  assert.equal(contentTypeFor("hover-grid.bin.br"), "application/octet-stream");
});

test("artifact normalization and worker serialization infer missing encoding from container bytes", () => {
  const raw = Buffer.from("hover-container-probe");
  const brotli = zlib.brotliCompressSync(raw);
  const gzip = zlib.gzipSync(raw);
  const frame = {
    hour: 0,
    validHourKey: "2026-07-16T13:00:00Z",
    rows: 1,
    cols: 1,
    layers: {},
    reflectivityVariants: {},
    reflectivityVariantsByLayer: {},
    contourVectorRefs: {},
    weatherVectorRefs: {},
  };
  const normalized = normalizeRenderedFrameArtifacts(
    { hour: 0, validHourKey: frame.validHourKey, hoverGrid: { body: brotli }, layers: {} },
    frame,
    [10, 15, 20],
  );
  assert.equal(normalized.hoverGrid.contentEncoding, "br");

  for (const [body, expected] of [
    [brotli, "br"],
    [gzip, "gzip"],
  ]) {
    const serialized = serializeFrameArtifacts({ layers: {}, hoverGrid: { body } }).frameArtifacts;
    assert.equal(serialized.hoverGrid.contentEncoding, expected);
  }
});
