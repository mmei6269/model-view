"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const sharedConfig = require("../shared/modelview-config.json");
const {
  SCALES,
  getNoaaNamParameterMetadata,
  resolveNoaaNamParameterCatalog,
} = require("../scripts/lib/noaa-nam-parameter-catalog");

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

// Independent recomputation of the catalog's legend normalization: linear
// scales may apply a power display exponent, log scales interpolate in ln.
function legendPositionForValue(value, min, max, options = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  const displayScale = options?.displayScale;
  const log = Boolean(options?.log || displayScale?.kind === "log");
  if (!log) {
    const normalized = clamp01((num - min) / Math.max(1e-9, max - min));
    const displayExponent = displayScale?.kind === "power" ? Number(displayScale.exponent) : 1;
    return displayExponent > 0 && displayExponent !== 1 ? normalized ** displayExponent : normalized;
  }
  if (num <= min) {
    return 0;
  }
  return clamp01((Math.log(num) - Math.log(min)) / Math.max(1e-9, Math.log(max) - Math.log(min)));
}

// The frontend's no-manifest fallback legends come from shared/
// modelview-config.json, which scripts/generate-shared-layer-legends.js
// regenerates from the catalog. This guard fails when the two drift — before
// it existed, the temperature/wind/reflectivity fallbacks showed stops that
// no longer matched what the renderer paints.
test("shared-config layer legends match the catalog exactly", () => {
  const metadata = getNoaaNamParameterMetadata();
  const layers = sharedConfig.layers || {};
  let checked = 0;
  for (const [key, layer] of Object.entries(layers)) {
    const entry = metadata[key];
    if (!entry) {
      continue; // legacy aliases (e.g. "reflectivity") are not catalog keys
    }
    checked += 1;
    assert.equal(layer.label, entry.label, `${key}: label drift`);
    assert.equal(layer.unit, entry.unit, `${key}: unit drift`);
    assert.deepEqual(layer.legendTicks, entry.legendTicks, `${key}: tick drift`);
    assert.deepEqual(layer.legendTickPositions, entry.legendTickPositions, `${key}: tick position drift`);
    assert.deepEqual(layer.legendStops, entry.legendStops, `${key}: stop drift`);
  }
  // 6 shared layers are catalog-backed (the 7th, "reflectivity", is a legacy alias).
  assert.ok(checked >= 6, `expected to check the shared layer set, checked ${checked}`);
});

test("every non-special catalog legend carries value-accurate tick positions", () => {
  const metadata = getNoaaNamParameterMetadata();
  let checked = 0;
  for (const entry of resolveNoaaNamParameterCatalog()) {
    if (entry.hidden) {
      continue;
    }
    const rendered = metadata[entry.key];
    if (!rendered || rendered.legendType) {
      continue; // precip-type / height-contour / vector legends have no gradient ticks
    }
    const scale = SCALES[entry.scale] || SCALES.humidityPct;
    const min = scale?.min ?? 0;
    const max = scale?.max ?? 1;
    // Ticks outside [min, max] are dropped, not clamped; positions are the
    // kept ticks normalized through the scale, never evenly spaced.
    const ticks = (Array.isArray(scale?.legendTicks) ? scale.legendTicks : [])
      .map((tick) => Number(tick))
      .filter((value) => Number.isFinite(value) && value >= min && value <= max);
    const positions = ticks.map((tick) =>
      legendPositionForValue(tick, min, max, {
        displayScale: scale?.legendDisplayScale,
        log: Boolean(scale?.legendLog ?? scale?.log),
      }),
    );
    checked += 1;
    assert.deepEqual(rendered.legendTicks || [], ticks, `${entry.key}: kept tick drift`);
    assert.deepEqual(rendered.legendTickPositions || [], positions, `${entry.key}: tick position drift`);
  }
  assert.ok(checked > 0, "expected to check at least one gradient legend");
});
