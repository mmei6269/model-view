"use strict";

// The renderer signature is the frame-completion identity: local-artifact-runtime
// treats a matching signature as frame-complete, so any build option or catalog
// scale field that changes rendered bytes must also move the signature, or a
// rebuild silently serves stale artifacts. This suite pins the ingredients a
// renderer audit found missing: the resolved reflectivity-gate roster (which
// selects the dbz<gate> variant artifacts a frame writes) and the
// byte-affecting catalog scale fields raster.js resolves through
// CATALOG_RENDER_OPTIONS (alpha, visible bounds, lookup routing and size).

const test = require("node:test");
const assert = require("node:assert/strict");
const { getNoaaGribRendererSignature } = require("../scripts/lib/noaa-beta-renderer");
const { buildNoaaModelMetadata } = require("../scripts/lib/noaa-build/run-resolution");
const { SCALES } = require("../scripts/lib/noaa-nam-parameter-catalog");

const BASE_SIGNATURE = getNoaaGribRendererSignature();

// Mutates one scale field for the probe and restores it in finally so the
// shared module registry returns to its true values for the next test.
function withScaleField(scaleKey, field, value, fn) {
  const scale = SCALES[scaleKey];
  assert.ok(scale, `test references a real catalog scale '${scaleKey}'`);
  const had = Object.prototype.hasOwnProperty.call(scale, field);
  const saved = scale[field];
  try {
    scale[field] = value;
    return fn();
  } finally {
    if (had) {
      scale[field] = saved;
    } else {
      delete scale[field];
    }
  }
}

function metadataWithGates(reflectivityGates) {
  return buildNoaaModelMetadata({
    modelKey: "nam",
    run: { date: "20260701", cycle: "00" },
    hours: [0],
    noaaBaseUrl: "https://example.invalid/nam",
    reflectivityGates,
  });
}

test("the resolved reflectivity-gate roster moves the renderer signature", () => {
  const defaultGates = getNoaaGribRendererSignature(null, { reflectivityGates: [10, 15, 20] });
  assert.notEqual(defaultGates, getNoaaGribRendererSignature(null, { reflectivityGates: [15] }));
  assert.notEqual(defaultGates, getNoaaGribRendererSignature(null, { reflectivityGates: [10, 15, 20, 25] }));
  // Equivalent spellings (ordering, duplicates) hash identically so the
  // identity stays deterministic for the same resolved roster.
  assert.equal(defaultGates, getNoaaGribRendererSignature(null, { reflectivityGates: [20, 10, 15, 15] }));
  // Same inputs, same signature: the payload assembly is deterministic.
  assert.equal(getNoaaGribRendererSignature(), BASE_SIGNATURE);
});

test("buildNoaaModelMetadata folds the gate roster into rendererSignature", () => {
  const full = metadataWithGates([10, 15, 20]);
  const gated = metadataWithGates([15]);
  assert.notEqual(full.rendererSignature, gated.rendererSignature);
  // The metadata stamp must be exactly the direct signature for the same
  // ingredients, so the builder and this identity cannot drift apart.
  assert.equal(
    full.rendererSignature,
    getNoaaGribRendererSignature(null, {
      forecastHourRosterIdentity: full.forecastHourRoster.completionIdentity,
      reflectivityGates: [10, 15, 20],
    }),
  );
});

test("byte-affecting catalog scale fields move the signature", () => {
  // The four probes an auditor verified change paint bytes: alpha, minVisible,
  // the step/continuous lookup routing flag, and the lookup table size.
  const probes = [
    ["capeJkg", "alpha", 0.31],
    ["snowDepthIn", "minVisible", 99],
    ["precipIn", "lookup", "continuous"],
    ["snowfallIn", "lookupSize", 1024],
  ];
  for (const [scaleKey, field, value] of probes) {
    const moved = withScaleField(scaleKey, field, value, () => getNoaaGribRendererSignature());
    assert.notEqual(moved, BASE_SIGNATURE, `${scaleKey}.${field} changes paint bytes but not the signature`);
  }
  assert.equal(getNoaaGribRendererSignature(), BASE_SIGNATURE, "probes restore the shared scale registry");
});

test("legend-only prose on a scale does not move the signature", () => {
  // The scale digest reads an explicit byte-affecting field list, so legend
  // text the paint path never reads must not invalidate every cached frame.
  const moved = withScaleField("capeJkg", "legendFootnote", "unrelated prose", () => getNoaaGribRendererSignature());
  assert.equal(moved, BASE_SIGNATURE);
});
