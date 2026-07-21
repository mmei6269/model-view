"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { decodeHoverGridPayload, encodeHoverGridBinaryPayload } = require("../scripts/lib/hover-grid-binary");
const { HOVER_GRID_SCHEMA_VERSION } = require("../scripts/lib/modelview-runtime");

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

test("merging a v1 payload into a v3 payload re-encodes losslessly at v3", () => {
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
  const merged = decodeHoverGridPayload(mergeHoverGridPayloads(bodyV3, bodyV1, { format: "binary" }));
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
