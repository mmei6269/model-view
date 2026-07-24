"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  _buildHoverGridBinaryRawShared,
  buildHoverGridBinaryRaw,
  decodeHoverGridPayload,
  encodeHoverGridBinaryPayload,
  mergeHoverGridPayloads,
  parseHoverGridBinaryRaw,
} = require("../scripts/lib/hover-grid-binary");
const { decompressHoverGridSync } = require("../scripts/lib/hover-grid-compression");
const {
  HOVER_GRID_ENCODING,
  HOVER_GRID_ENCODINGS,
  resolveHoverGridEncodingDescriptor,
} = require("../scripts/lib/hover-grid-encoding");

const MVH4 = HOVER_GRID_ENCODINGS.mvh4;
const MVH3 = HOVER_GRID_ENCODINGS.mvh3;

function variable(values, overrides = {}) {
  return {
    scale: 1,
    offset: 0,
    missing: -32768,
    values: Int16Array.from(values),
    ...overrides,
  };
}

function payload4(rows, cols, variables) {
  return { schemaVersion: 4, encoding: MVH4, rows, cols, variables };
}

function rawDataValues(raw) {
  const layout = parseHoverGridBinaryRaw(raw);
  return Array.from(new Int16Array(raw.buffer, raw.byteOffset + layout.dataStart, layout.dataBytes / 2));
}

function rebuildRaw(raw, mutateHeader, { magic = null, oddHeader = false, trailing = null } = {}) {
  const layout = parseHoverGridBinaryRaw(raw);
  const header = structuredClone(layout.header);
  mutateHeader?.(header);
  let headerBytes = Buffer.from(JSON.stringify(header));
  if (oddHeader ? headerBytes.length % 2 === 0 : headerBytes.length % 2 === 1) {
    headerBytes = Buffer.concat([headerBytes, Buffer.from(" ")]);
  }
  const suffix = trailing ? Buffer.from(trailing) : Buffer.alloc(0);
  const rebuilt = Buffer.alloc(8 + headerBytes.length + layout.dataBytes + suffix.length);
  rebuilt.write(magic || layout.magic, 0, "ascii");
  rebuilt.writeUInt32LE(headerBytes.length, 4);
  headerBytes.copy(rebuilt, 8);
  raw.copy(rebuilt, 8 + headerBytes.length, layout.dataStart, layout.dataStart + layout.dataBytes);
  suffix.copy(rebuilt, 8 + headerBytes.length + layout.dataBytes);
  return rebuilt;
}

test("the immutable encoding descriptor uses MVH4 for blank input and accepts only the audited rollback", () => {
  assert.strictEqual(
    HOVER_GRID_ENCODING,
    resolveHoverGridEncodingDescriptor(process.env.MODELVIEW_NOAA_HOVER_ENCODING),
  );
  assert.equal(Object.isFrozen(HOVER_GRID_ENCODINGS), true);
  assert.equal(Object.isFrozen(MVH4), true);
  assert.equal(Object.isFrozen(MVH3), true);
  assert.strictEqual(resolveHoverGridEncodingDescriptor(""), MVH4);
  assert.strictEqual(resolveHoverGridEncodingDescriptor("  MVH4  "), MVH4);
  assert.strictEqual(resolveHoverGridEncodingDescriptor("mvh3"), MVH3);
  assert.throws(() => resolveHoverGridEncodingDescriptor("gradient2d"), /must be 'mvh4' or 'mvh3'/);
  assert.throws(() => resolveHoverGridEncodingDescriptor("future"), /must be 'mvh4' or 'mvh3'/);
});

test("MVH4 emits the exact accepted gradient2d vector and resets at every variable", () => {
  const alpha = [10, 20, 35, -30000, 14, 31, -32768, 32767, -5, 200, 12345, -12345];
  const beta = [-32768, 32767, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const raw = buildHoverGridBinaryRaw(
    payload4(3, 4, {
      alpha: variable(alpha),
      beta: variable(beta, { scale: 0.1, offset: 2 }),
    }),
  );
  const layout = parseHoverGridBinaryRaw(raw);

  assert.equal(layout.magic, "MVH4");
  assert.equal(layout.schemaVersion, 4);
  assert.equal(layout.encoding, "gradient2d");
  assert.equal(layout.header.predictor, "gradient2d");
  assert.deepEqual(
    rawDataValues(raw),
    [
      10, 10, 15, -30035, 4, 7, 32722, 30034, -19, 188, -20592, -24689, -32768, -1, -32767, 1, -32766, 2, -32768, 0, 4,
      0, 0, 0,
    ],
  );
  assert.equal(rawDataValues(raw)[alpha.length], beta[0], "the second variable predicts from zero, not alpha");

  const decoded = decodeHoverGridPayload(
    zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 0 } }),
  );
  assert.deepEqual(Array.from(decoded.variables.alpha.values), alpha);
  assert.deepEqual(Array.from(decoded.variables.beta.values), beta);
  assert.equal(decoded.variables.beta.scale, 0.1);
  assert.equal(decoded.variables.beta.offset, 2);
});

test("MVH4 reverse in-place encoding preserves nonplanar upper-row predictors", () => {
  const values = [3, 100, -8, 250, -40, 17, 999, -32768, 32767, 4, -700, 88];
  const raw = buildHoverGridBinaryRaw(payload4(3, 4, { probe: variable(values) }));
  const residue = rawDataValues(raw);
  // A forward in-place implementation reads row-0 residue for these cells
  // and produces different values. These exact checks guard that regression.
  assert.deepEqual(residue.slice(4, 8), [-43, -40, 1090, 31511]);
  assert.deepEqual(residue.slice(8), [-32729, 32716, -1686, -30981]);
  const decoded = decodeHoverGridPayload(zlib.gzipSync(raw, { level: 1 }));
  assert.deepEqual(Array.from(decoded.variables.probe.values), values);
});

test("MVH4 round-trips 1x1, 1xN, Nx1, and signed-wrap boundaries exactly", () => {
  const shapes = [
    [1, 1, [-32768]],
    [1, 8, [-32768, 32767, -32768, 0, 32767, -1, 1, -32768]],
    [8, 1, [32767, -32768, 32767, 0, -1, 1, 12345, -23456]],
  ];
  for (const [rows, cols, values] of shapes) {
    const body = encodeHoverGridBinaryPayload(payload4(rows, cols, { boundary: variable(values) }));
    const decoded = decodeHoverGridPayload(body);
    assert.deepEqual(Array.from(decoded.variables.boundary.values), values, `${rows}x${cols}`);
  }
  for (let previous = -32768; previous <= 32767; previous += 1) {
    const value = ((Math.imul(previous, 40503) + 17) << 16) >> 16;
    const residue = ((value - previous) << 16) >> 16;
    assert.equal(((residue + previous) << 16) >> 16, value);
  }
});

test("regular and shared MVH4 packers produce identical exact raw bytes", () => {
  const payload = payload4(2, 3, {
    alpha: variable([1, 9, -4, 30000, -30000, 7]),
    beta: variable([-32768, 32767, 4, 3, 2, 1], { scale: 0.05, offset: -7 }),
  });
  const regular = buildHoverGridBinaryRaw(payload);
  const shared = _buildHoverGridBinaryRawShared(payload);
  assert.equal(shared.buffer instanceof SharedArrayBuffer, true);
  assert.deepEqual(shared, regular);
});

test("canonical empty MVH3 and MVH4 preserve positive dimensions with zero data bytes", () => {
  for (const encoding of [MVH3, MVH4]) {
    const raw = buildHoverGridBinaryRaw({
      schemaVersion: encoding.schemaVersion,
      encoding,
      rows: 2,
      cols: 3,
      variables: {},
    });
    const layout = parseHoverGridBinaryRaw(raw);
    assert.equal(raw.subarray(0, 4).toString("ascii"), encoding.magic);
    assert.equal(layout.dataBytes, 0);
    assert.deepEqual(layout.variables, []);
    const decoded = decodeHoverGridPayload(zlib.gzipSync(raw, { level: 1 }));
    assert.deepEqual(decoded, {
      schemaVersion: encoding.schemaVersion,
      rows: 2,
      cols: 3,
      variables: {},
    });
    assert.throws(() => parseHoverGridBinaryRaw(Buffer.concat([raw, Buffer.from([0, 0])])), /byte length mismatch/);
  }

  const emptyMvh3 = buildHoverGridBinaryRaw({
    schemaVersion: 3,
    encoding: MVH3,
    rows: 2,
    cols: 3,
    variables: {},
  });
  assert.equal(emptyMvh3.length, 60);
  assert.equal(
    crypto.createHash("sha256").update(emptyMvh3).digest("hex"),
    "5aeddbafbf62dc9e85047a8ea3cb4552911c8d74a9c1fba125e63815b1d2dc07",
    "the rollback empty-container bytes are frozen",
  );
  for (const schemaVersion of [1, 2]) {
    assert.throws(
      () => buildHoverGridBinaryRaw({ schemaVersion, rows: 2, cols: 3, variables: {} }),
      /canonical MVH3\/MVH4/,
    );
  }
  assert.throws(
    () => buildHoverGridBinaryRaw({ schemaVersion: 3, rows: 2, cols: 3, variables: { ignored: null } }),
    /canonical MVH3\/MVH4/,
  );
  assert.throws(
    () =>
      buildHoverGridBinaryRaw({
        schemaVersion: 3,
        rows: 2,
        cols: 3,
        variables: { zero: variable([]) },
      }),
    /canonical MVH3\/MVH4/,
  );
});

test("MVH4 rejects pre-delta planes and invalid writer metadata before emitting a container", () => {
  const valid = variable([1, 2, 3, 4]);
  const invalidCases = [
    ["pre-delta", { ...valid, deltaEncoded: true, deltaEndValue: 4 }, /requires absolute/],
    ["wrong length", variable([1, 2, 3]), /does not match rows\*cols/],
    ["missing values", { ...valid, values: [1, 2, 3, 4] }, /Int16Array/],
    ["zero scale", { ...valid, scale: 0 }, /quantization metadata/],
    ["negative scale", { ...valid, scale: -1 }, /quantization metadata/],
    ["nonfinite scale", { ...valid, scale: Infinity }, /quantization metadata/],
    ["nonfinite offset", { ...valid, offset: NaN }, /quantization metadata/],
    ["fractional missing", { ...valid, missing: -1.5 }, /quantization metadata/],
    ["large missing", { ...valid, missing: 32768 }, /quantization metadata/],
  ];
  for (const [name, candidate, expected] of invalidCases) {
    assert.throws(() => buildHoverGridBinaryRaw(payload4(2, 2, { probe: candidate })), expected, name);
  }
  assert.throws(() => buildHoverGridBinaryRaw(payload4(2, 2, { constructor: valid })), /unsafe or empty/);
  assert.throws(
    () => buildHoverGridBinaryRaw({ ...payload4(2, 2, { probe: valid }), encoding: MVH3 }),
    /requires schema 3|canonical mvh4/,
  );
});

test("MVH4 strict parser rejects malformed predictor, magic, schema, layout, metadata, and truncation", () => {
  const raw = buildHoverGridBinaryRaw(payload4(2, 2, { probe: variable([1, 9, -4, 17]) }));
  const cases = [
    rebuildRaw(raw, (header) => delete header.predictor),
    rebuildRaw(raw, (header) => {
      header.predictor = "global1d";
    }),
    rebuildRaw(raw, null, { magic: "MVH3" }),
    rebuildRaw(raw, (header) => {
      header.schemaVersion = 3;
    }),
    rebuildRaw(raw, (header) => {
      header.variables.probe.byteOffset = 2;
    }),
    rebuildRaw(raw, (header) => {
      header.variables.probe.length = 3;
    }),
    rebuildRaw(raw, (header) => {
      header.variables.probe.scale = "1";
    }),
    rebuildRaw(raw, (header) => {
      header.variables = {};
    }),
    rebuildRaw(raw, null, { oddHeader: true }),
    rebuildRaw(raw, null, { trailing: [0, 0] }),
    raw.subarray(0, raw.length - 1),
  ];
  for (const malformed of cases) {
    assert.throws(() => parseHoverGridBinaryRaw(malformed));
    assert.throws(() => decodeHoverGridPayload(zlib.gzipSync(malformed, { level: 1 })));
  }
});

test("mixed MVH3/MVH4 merge decodes to absolutes and re-encodes the explicit target", () => {
  const oldValues = [1, 2, 4, 8];
  const newValues = [-32768, 32767, -7, 91];
  const body3 = encodeHoverGridBinaryPayload({
    schemaVersion: 3,
    encoding: MVH3,
    rows: 2,
    cols: 2,
    variables: { old: variable(oldValues) },
  });
  const body4 = encodeHoverGridBinaryPayload(payload4(2, 2, { fresh: variable(newValues, { scale: 0.1 }) }));

  for (const [existing, incoming] of [
    [body3, body4],
    [body4, body3],
  ]) {
    for (const target of [MVH4, MVH3]) {
      const mergedBody = mergeHoverGridPayloads(existing, incoming, {
        format: "binary",
        encoding: target,
      });
      const raw = decompressHoverGridSync(mergedBody);
      assert.equal(raw.subarray(0, 4).toString("ascii"), target.magic);
      const merged = decodeHoverGridPayload(mergedBody);
      assert.equal(merged.schemaVersion, target.schemaVersion);
      assert.deepEqual(Array.from(merged.variables.old.values), oldValues);
      assert.deepEqual(Array.from(merged.variables.fresh.values), newValues);
    }
  }
});

test("the frozen MVH3 writer remains byte-compatible with the legacy golden", () => {
  const raw = buildHoverGridBinaryRaw({
    schemaVersion: 3,
    encoding: MVH3,
    rows: 2,
    cols: 4,
    variables: {
      alpha: variable([-32768, 32767, -32768, 0, 0, 1, -1, 12345], { scale: 0.1, offset: 2 }),
      beta: variable([-12345, -12345, 32767, 32766, -32768, 5, 5, 5], { offset: -4 }),
    },
  });
  assert.equal(raw.length, 242);
  assert.equal(
    crypto.createHash("sha256").update(raw).digest("hex"),
    "b3cb2cf38c3b5be6a8d4d83db6bf2dd717fd30396e6b6ad0e326732cb20e5bde",
  );
});
