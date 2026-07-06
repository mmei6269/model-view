"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

// Bundle the client layers config with esbuild (A.2 pattern, extended with
// bundle:true because layers.ts imports the shared config JSON + color maps)
// and evaluate it in a throwaway CJS context so the node test exercises the
// exact availability logic the browser bundle ships.
function loadLayersModule() {
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "next", "src", "config", "layers.ts")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    logLevel: "silent",
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

const layers = loadLayersModule();

function allOnCategories(overrides = {}) {
  const categories = {};
  for (const id of ["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]) {
    categories[id] = { enabled: true, tier: "full" };
  }
  return { ...categories, ...overrides };
}

// A selective radar-off build: the reflectivity floor layers are still written
// as empty transparent-PNG placeholders, so they appear in frame.layers, but
// their (deselected) parameter metadata is filtered from the manifest.
function buildManifest({ renderSelection } = {}) {
  return {
    schemaVersion: 2,
    model: "hrrr",
    run: "20260703-1200Z",
    view: "conus",
    generatedAt: "2026-07-03T12:10:00Z",
    parameters: {
      temperature: {
        key: "temperature",
        label: "Temp",
        unit: "F",
        group: "Surface & Boundary Layer",
        category: "surface",
        costTier: "simple",
      },
      sbcape: {
        key: "sbcape",
        label: "SBCAPE",
        unit: "J/kg",
        group: "Severe: Thermodynamics",
        category: "severe",
        costTier: "simple",
      },
      // Full-tier severe products with metadata still present (e.g. a manifest
      // merged over an earlier full build) must be gated by the tier stamp.
      dcape: {
        key: "dcape",
        label: "DCAPE",
        unit: "J/kg",
        group: "Severe: Thermodynamics",
        category: "severe",
        costTier: "full",
      },
      effectiveLayerSupercellCompositeParameter: {
        key: "effectiveLayerSupercellCompositeParameter",
        label: "SCP (Effective Layer)",
        unit: null,
        group: "Severe: Kinematics",
        category: "severe",
        costTier: "full",
      },
    },
    parameterOrder: ["temperature", "sbcape", "dcape", "effectiveLayerSupercellCompositeParameter"],
    frames: [
      {
        hour: 0,
        validTime: "2026-07-03T12:00:00Z",
        layers: {
          temperature: { key: "t.png" },
          sbcape: { key: "sbcape.png" },
          dcape: { key: "dcape.png" },
          effectiveLayerSupercellCompositeParameter: { key: "escp.png" },
          // Radar floor placeholder: present on disk even when radar was deselected.
          reflectivityComposite: { key: "refc.png" },
          reflectivity1km: { key: "refd.png" },
        },
      },
    ],
    ...(renderSelection ? { renderSelection } : {}),
  };
}

function optionByKey(manifest, key) {
  const option = layers.getManifestParameterOptions(manifest).find((entry) => entry.key === key);
  assert.ok(option, `expected parameter option '${key}' to be listed`);
  return option;
}

test("radar-off renderSelection marks reflectivity placeholders unavailable", () => {
  const manifest = buildManifest({
    renderSelection: {
      categories: allOnCategories({ radar: { enabled: false, tier: "full" } }),
      builtAt: "2026-07-03T12:00:00Z",
    },
  });
  assert.equal(optionByKey(manifest, "reflectivityComposite").available, false);
  assert.equal(optionByKey(manifest, "reflectivity1km").available, false);
  // Enabled categories are untouched.
  assert.equal(optionByKey(manifest, "temperature").available, true);
  assert.equal(optionByKey(manifest, "sbcape").available, true);
});

test("same layers WITHOUT renderSelection keep full-build behavior (no gating)", () => {
  const manifest = buildManifest();
  assert.equal("renderSelection" in manifest, false);
  assert.equal(optionByKey(manifest, "reflectivityComposite").available, true);
  assert.equal(optionByKey(manifest, "reflectivity1km").available, true);
  assert.equal(optionByKey(manifest, "temperature").available, true);
  assert.equal(optionByKey(manifest, "dcape").available, true);
  assert.equal(optionByKey(manifest, "effectiveLayerSupercellCompositeParameter").available, true);
});

test("severe simple tier drops full-tier products but keeps simple ones", () => {
  const manifest = buildManifest({
    renderSelection: {
      categories: allOnCategories({ severe: { enabled: true, tier: "simple" } }),
      builtAt: "2026-07-03T12:00:00Z",
    },
  });
  assert.equal(optionByKey(manifest, "dcape").available, false);
  assert.equal(optionByKey(manifest, "effectiveLayerSupercellCompositeParameter").available, false);
  assert.equal(optionByKey(manifest, "sbcape").available, true);
});

test("disabled category gates fallback-only keys via their group mapping", () => {
  // Deselected parameters have their metadata filtered out server-side, so the
  // gate must classify placeholder keys from the fallback group when needed.
  const manifest = buildManifest({
    renderSelection: {
      categories: allOnCategories({ severe: { enabled: false, tier: "full" } }),
      builtAt: "2026-07-03T12:00:00Z",
    },
  });
  delete manifest.parameters.sbcape;
  delete manifest.parameters.dcape;
  assert.equal(optionByKey(manifest, "sbcape").available, false);
  assert.equal(optionByKey(manifest, "dcape").available, false);
});

test("compact boolean category form is read like the server's normalizer", () => {
  const manifest = buildManifest({
    renderSelection: {
      categories: { ...allOnCategories(), radar: false, surface: true },
      builtAt: "2026-07-03T12:00:00Z",
    },
  });
  assert.equal(optionByKey(manifest, "reflectivityComposite").available, false);
  assert.equal(optionByKey(manifest, "temperature").available, true);
});
