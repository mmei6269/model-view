"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  HOVER_GRID_MISSING_VALUE,
  buildHoverGridArtifact,
  quantizeHoverGridVariable,
} = require("../scripts/lib/noaa-beta/hover");

test("hover quantization rejects all non-finite values and counts saturation", () => {
  const variable = quantizeHoverGridVariable(
    new Float32Array([1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 50000]),
    1,
    5,
  );
  assert.deepEqual(Array.from(variable.values), [
    1,
    HOVER_GRID_MISSING_VALUE,
    HOVER_GRID_MISSING_VALUE,
    HOVER_GRID_MISSING_VALUE,
    32767,
  ]);
  assert.equal(variable.validCount, 2);
  assert.equal(variable.nonFiniteCount, 3);
  assert.equal(variable.clampCount, 1);
});

test("hover artifacts expose compact quantization diagnostics to render profiles", () => {
  const variable = quantizeHoverGridVariable(new Float32Array([0, 50000]), 1, 2);
  const artifact = buildHoverGridArtifact({ width: 2, height: 1, variables: { test: variable }, format: "binary" });
  assert.equal(artifact.diagnostics.clampCount, 1);
  assert.equal(artifact.diagnostics.nonFiniteCount, 0);
  assert.deepEqual(artifact.diagnostics.byVariable.test, { clampCount: 1, nonFiniteCount: 0 });
});
