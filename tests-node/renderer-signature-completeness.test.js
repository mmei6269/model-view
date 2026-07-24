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
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getNoaaGribRendererSignature } = require("../scripts/lib/noaa-beta-renderer");
const { buildNoaaModelMetadata } = require("../scripts/lib/noaa-build/run-resolution");
const { SCALES } = require("../scripts/lib/noaa-nam-parameter-catalog");

const BASE_SIGNATURE = getNoaaGribRendererSignature();
const ROOT_DIR = path.resolve(__dirname, "..");

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

test("MVH4 default and MVH3 rollback freeze distinct descriptors, containers, and renderer signatures", () => {
  const probe = (encoding) => {
    const env = { ...process.env, MODELVIEW_NOAA_HOVER_ENCODING: encoding };
    const script = [
      'const descriptor = require("./scripts/lib/hover-grid-encoding").HOVER_GRID_ENCODING;',
      'const binary = require("./scripts/lib/hover-grid-binary");',
      'const renderer = require("./scripts/lib/noaa-beta-renderer");',
      "const raw = binary.buildHoverGridBinaryRaw({",
      "  schemaVersion: descriptor.schemaVersion, encoding: descriptor, rows: 1, cols: 1,",
      "  variables: { probe: { scale: 1, offset: 0, missing: -32768, values: new Int16Array([7]) } },",
      "});",
      "const layout = binary.parseHoverGridBinaryRaw(raw);",
      "process.stdout.write(JSON.stringify({",
      "  id: descriptor.id, schemaVersion: descriptor.schemaVersion,",
      "  preDeltaEncode: descriptor.preDeltaEncode, magic: layout.magic,",
      "  predictor: layout.header.predictor ?? null,",
      "  signature: renderer.getNoaaGribRendererSignature(),",
      "}));",
    ].join("\n");
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: ROOT_DIR,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const mvh4 = probe("mvh4");
  const mvh3 = probe("mvh3");
  assert.deepEqual(
    {
      id: mvh4.id,
      schemaVersion: mvh4.schemaVersion,
      preDeltaEncode: mvh4.preDeltaEncode,
      magic: mvh4.magic,
      predictor: mvh4.predictor,
    },
    { id: "mvh4", schemaVersion: 4, preDeltaEncode: false, magic: "MVH4", predictor: "gradient2d" },
  );
  assert.deepEqual(
    {
      id: mvh3.id,
      schemaVersion: mvh3.schemaVersion,
      preDeltaEncode: mvh3.preDeltaEncode,
      magic: mvh3.magic,
      predictor: mvh3.predictor,
    },
    { id: "mvh3", schemaVersion: 3, preDeltaEncode: true, magic: "MVH3", predictor: null },
  );
  assert.notEqual(mvh4.signature, mvh3.signature);
});

test("hover arena auto/off rollback is renderer-signature neutral", () => {
  const probe = (mode) => {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        [
          'const arena = require("./scripts/lib/noaa-beta/hover-arena");',
          'const renderer = require("./scripts/lib/noaa-beta-renderer");',
          "process.stdout.write(JSON.stringify({",
          "  mode: arena.HOVER_ARENA_MODE,",
          "  signature: renderer.getNoaaGribRendererSignature(),",
          "}));",
        ].join("\n"),
      ],
      {
        cwd: ROOT_DIR,
        env: { ...process.env, MODELVIEW_NOAA_HOVER_ARENA: mode },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  const auto = probe("auto");
  const off = probe("off");
  assert.equal(auto.mode, "auto");
  assert.equal(off.mode, "off");
  assert.equal(auto.signature, off.signature);
});

test("selected-GRIB warm-pack auto/off rollback is renderer-signature neutral", () => {
  const probe = (mode) => {
    const result = spawnSync(
      process.execPath,
      ["-e", 'process.stdout.write(require("./scripts/lib/noaa-beta-renderer").getNoaaGribRendererSignature())'],
      {
        cwd: ROOT_DIR,
        env: { ...process.env, MODELVIEW_NOAA_FAST_PACK: mode },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  assert.equal(probe("auto"), probe("off"));
});
