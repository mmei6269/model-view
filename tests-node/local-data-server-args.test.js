"use strict";

// Pins the data server's reflectivity-gate parsing to the builder's exported
// parseReflectivityGates: an audit found the server accepting any finite
// numbers from --reflectivity-gates / MODELVIEW_REFLECTIVITY_GATES while the
// builder whitelists the {10, 15, 20} dBZ gates, letting the two sides
// disagree about which gates exist.

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveReflectivityGates } = require("../scripts/local-data-server");
const { parseReflectivityGates } = require("../scripts/build-noaa-beta-artifacts");

test("server reflectivity gates share the builder's whitelist vocabulary", () => {
  assert.deepEqual(resolveReflectivityGates({}, {}), [10, 15, 20]);
  assert.deepEqual(resolveReflectivityGates({ "reflectivity-gates": "20,10" }, {}), [10, 20]);
  assert.deepEqual(resolveReflectivityGates({}, { MODELVIEW_REFLECTIVITY_GATES: "15" }), [15]);
  // The flag wins over the env var, matching the builder's precedence.
  assert.deepEqual(
    resolveReflectivityGates({ "reflectivity-gates": "20" }, { MODELVIEW_REFLECTIVITY_GATES: "15" }),
    [20],
  );
  // Out-of-vocabulary gates fall back to the default set instead of being
  // served as gates the artifacts were never built with.
  assert.deepEqual(resolveReflectivityGates({ "reflectivity-gates": "12,18" }, {}), [10, 15, 20]);
  assert.deepEqual(resolveReflectivityGates({}, { MODELVIEW_REFLECTIVITY_GATES: "5,35" }), [10, 15, 20]);
});

test("server gate parsing is the builder's parseReflectivityGates, byte for byte", () => {
  for (const raw of ["", "20,10", "12,18", "5,35", "10,15,20,20", "garbage", "15"]) {
    assert.deepEqual(
      resolveReflectivityGates({ "reflectivity-gates": raw }, {}),
      parseReflectivityGates(raw || "10,15,20"),
    );
  }
});
