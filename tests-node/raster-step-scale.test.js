"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CATALOG_RENDER_OPTIONS,
  CORE_LAYER_RENDER_OPTIONS,
  createStepColorLookup,
  renderScalarGridStep,
} = require("../scripts/lib/noaa-beta/raster");

function stepOptionEntries() {
  const entries = [];
  for (const [key, options] of CATALOG_RENDER_OPTIONS.entries()) {
    if (options?.colorLookup?.kind === "step") {
      entries.push([`catalog:${key}`, options]);
    }
  }
  for (const [key, options] of Object.entries(CORE_LAYER_RENDER_OPTIONS)) {
    if (options?.colorLookup?.kind === "step") {
      entries.push([`core:${key}`, options]);
    }
  }
  return entries;
}

test("step palettes keep below-range values invisible (bucket-0 clamp guard)", () => {
  const entries = stepOptionEntries();
  assert.ok(entries.length >= 2, "expected step render options in catalog/core lookups");
  for (const [key, options] of entries) {
    const lookup = options.colorLookup;
    const firstAlpha = lookup.colors[3];
    const rangeMin = Array.isArray(options.visibleRange) ? Number(options.visibleRange[0]) : Number.NaN;
    const effectiveMin = Number.isFinite(rangeMin) ? rangeMin : Number(options.minVisible);
    const guarded = firstAlpha === 0 || (Number.isFinite(effectiveMin) && effectiveMin >= lookup.thresholds[0]);
    assert.ok(guarded, `${key}: below-range values would paint the first step bucket`);
  }
});

test("bucket-0 clamp paints below-range values when a palette is unguarded", () => {
  // Documents the latent hazard the guard test above protects against: an
  // opaque first stop with no covering minVisible paints out-of-range values
  // with the first bucket color. Intentional pin of current clamp behavior.
  const lookup = createStepColorLookup(
    [
      [10, [255, 0, 0, 1]],
      [20, [0, 255, 0, 1]],
    ],
    1,
  );
  const result = renderScalarGridStep({
    values: Float64Array.from([5]),
    width: 1,
    height: 1,
    colorLookup: lookup,
    minVisible: null,
    maxVisible: null,
    visibleRange: null,
  });
  assert.equal(result.visibleCount, 1);
  assert.equal(result.rgba[0], 255);
  assert.equal(result.rgba[3], 255);
});
