"use strict";

// Stage G2 tolerance contract: buildProfileDerivedGrids through the wasm
// slab pipeline vs the JS cell loop, with BOTH sides using the same kernel
// scan/DCAPE/product ports (MODELVIEW_DERIVED_SLAB=off forces the JS loop
// while keeping the kernel backends). Remaining differences are limited to
// the ported fill/interpolation/surface-chain arithmetic: lapse is pure
// linear interpolation and must match bit for bit; bulk shear adds one
// NativeMath hypot; DCAPE adds one NativeMath pow on the surface-pressure
// input; the SCP/STP chain adds the NativeMath dewpoint in the row fill.

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const severe = require("../scripts/lib/noaa-beta/severe");
const { getParcelKernel } = require("../scripts/lib/noaa-beta/parcel-kernel");
const {
  CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY,
  EFFECTIVE_LAYER_PROFILE_LEVELS,
  EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY,
} = require("../scripts/lib/noaa-nam-parameter-catalog");

const { buildProfileDerivedGrids, PROFILE_DERIVED_AVAILABILITY_KEYS } = severe;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CELLS = 20011; // crosses two slab boundaries with an odd tail

function buildDecoded(rand) {
  const grid = (fill) => {
    const values = new Float32Array(CELLS);
    for (let i = 0; i < CELLS; i += 1) {
      values[i] = fill(i);
    }
    return values;
  };
  const elevationGrid = grid((i) => (rand() < 0.02 ? NaN : rand() < 0.2 ? rand() * 1600 : rand() * 300));
  const decoded = {
    profileSurfaceHeight: elevationGrid,
    temperature2m: grid(() => (rand() < 0.02 ? NaN : 270 + rand() * 35)),
    humidity2m: grid(() => 20 + rand() * 80),
    dewpoint2m: grid(() => (rand() < 0.4 ? NaN : 262 + rand() * 30)),
    derivedSurfacePressure: grid(() => (rand() < 0.15 ? NaN : 84000 + rand() * 19000)),
    pressureMsl: grid(() => 99000 + rand() * 4500),
    windU10m: grid(() => (rand() < 0.02 ? NaN : (rand() - 0.5) * 40)),
    windV10m: grid(() => (rand() - 0.5) * 40),
    mucape: grid(() => (rand() < 0.3 ? 0 : rand() * 4200)),
    mlcape: grid(() => (rand() < 0.35 ? 0 : rand() * 3200)),
    mlcin: grid(() => -rand() * 260),
    sbcape: grid(() => (rand() < 0.3 ? 0 : rand() * 4600)),
    sbcin: grid(() => -rand() * 260),
  };
  // 21 CAM levels with plausible height/temp structure per cell offset so
  // profiles vary spatially; the 6-level diagnostics reuse these grids.
  for (const level of EFFECTIVE_LAYER_PROFILE_LEVELS) {
    const baseHeight = 44330 * (1 - Math.pow(level / 1013.25, 0.1903));
    decoded[`profileHgt${level}`] = grid((i) => {
      const elev = elevationGrid[i];
      const jitter = (rand() - 0.5) * 120;
      return Number.isFinite(elev) ? Math.max(elev - 400, baseHeight) + jitter : baseHeight + jitter;
    });
    decoded[`profileTmp${level}`] = grid(() => (rand() < 0.02 ? NaN : 288 - baseHeight * 0.0062 + (rand() - 0.5) * 6));
    decoded[`profileRh${level}`] = grid(() => 5 + rand() * 95);
    decoded[`profileU${level}`] = grid(() => (rand() < 0.02 ? NaN : (rand() - 0.5) * 80));
    decoded[`profileV${level}`] = grid(() => (rand() - 0.5) * 80);
  }
  return decoded;
}

function runBuild(decoded, slabEnabled, availabilityKeys = PROFILE_DERIVED_AVAILABILITY_KEYS) {
  const previous = process.env.MODELVIEW_DERIVED_SLAB;
  process.env.MODELVIEW_DERIVED_SLAB = slabEnabled ? "on" : "off";
  try {
    return buildProfileDerivedGrids(decoded, new Set(availabilityKeys), CELLS, null);
  } finally {
    if (previous === undefined) {
      delete process.env.MODELVIEW_DERIVED_SLAB;
    } else {
      process.env.MODELVIEW_DERIVED_SLAB = previous;
    }
  }
}

function compareGrids(label, slabGrid, jsGrid, absBound, { exact = false } = {}) {
  assert.ok(slabGrid instanceof Float32Array, `${label}: slab output missing`);
  assert.ok(jsGrid instanceof Float32Array, `${label}: js output missing`);
  assert.strictEqual(slabGrid.length, jsGrid.length, label);
  let flips = 0;
  let maxDelta = 0;
  let compared = 0;
  for (let i = 0; i < slabGrid.length; i += 1) {
    const a = slabGrid[i];
    const b = jsGrid[i];
    const aFinite = Number.isFinite(a);
    const bFinite = Number.isFinite(b);
    if (aFinite !== bFinite) {
      flips += 1;
      continue;
    }
    if (!aFinite) {
      continue;
    }
    compared += 1;
    const delta = Math.abs(a - b);
    if (exact) {
      assert.strictEqual(a, b, `${label}: cell ${i} slab=${a} js=${b} (expected exact)`);
    } else {
      assert.ok(delta <= absBound, `${label}: cell ${i} slab=${a} js=${b} delta=${delta} > ${absBound}`);
    }
    if (delta > maxDelta) {
      maxDelta = delta;
    }
  }
  assert.strictEqual(flips, 0, `${label}: ${flips} finite/absent flips`);
  return { compared, maxDelta };
}

test("kernel exports the Stage G2 slab pipeline", () => {
  const kernel = getParcelKernel();
  assert.ok(kernel?.derivedSlab, "kernel.derivedSlab missing — slab tests would be vacuous");
});

test("derived grids via slabs match the JS cell loop within the ported ulp classes", () => {
  const rand = mulberry32(0x51ab5);
  const decoded = buildDecoded(rand);
  // Spy on the slab entry point so a silent fallback to the JS loop can
  // never make this comparison vacuous.
  const port = getParcelKernel().derivedSlab;
  const originalRun = port.run;
  let slabCalls = 0;
  port.run = (...args) => {
    slabCalls += 1;
    return originalRun(...args);
  };
  let slabOut;
  try {
    slabOut = runBuild(decoded, true);
  } finally {
    port.run = originalRun;
  }
  assert.strictEqual(slabCalls, Math.ceil(CELLS / port.cells), "slab path did not engage");
  const jsOut = runBuild(decoded, false);
  assert.deepStrictEqual(Object.keys(slabOut).sort(), Object.keys(jsOut).sort());

  const summary = {};
  // Pure linear interpolation over identical reads: exact.
  summary.lapse = compareGrids("lapseRate0to3km", slabOut.lapseRate0to3km, jsOut.lapseRate0to3km, 0, { exact: true });
  // One NativeMath hypot difference, rounded to f32 output.
  summary.bulk = compareGrids("bulkShear0to6km", slabOut.bulkShear0to6km, jsOut.bulkShear0to6km, 1e-3);
  summary.effective = compareGrids("effectiveBulkShear", slabOut.effectiveBulkShear, jsOut.effectiveBulkShear, 1e-3);
  // NativeMath pow on the hypsometric surface pressure feeding the (shared)
  // f32 DCAPE port.
  summary.dcape = compareGrids("dcape", slabOut.dcape, jsOut.dcape, 0.5);
  // Hard requirement, not a guard: the full-availability fixture DOES
  // produce the CAM 21-level DCAPE prototype grid, so a missing key means
  // the pipeline (or the fixture) regressed and the comparison must fail
  // loudly instead of silently skipping. compareGrids asserts presence.
  summary.dcape21 = compareGrids(
    CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY,
    slabOut[CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY],
    jsOut[CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY],
    0.5,
  );
  // NativeMath dewpoint in the row fill feeding the shared scan + G1 chain.
  summary.scp = compareGrids(
    "effectiveLayerSupercellCompositeParameter",
    slabOut.effectiveLayerSupercellCompositeParameter,
    jsOut.effectiveLayerSupercellCompositeParameter,
    1e-2,
  );
  summary.stp = compareGrids(
    "effectiveLayerSignificantTornadoParameter",
    slabOut.effectiveLayerSignificantTornadoParameter,
    jsOut.effectiveLayerSignificantTornadoParameter,
    1e-2,
  );
  // Same hard requirement for the STP-100mb prototype grid.
  summary.stp100 = compareGrids(
    EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY,
    slabOut[EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY],
    jsOut[EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY],
    1e-2,
  );
  for (const [key, value] of Object.entries(summary)) {
    assert.ok(value.compared > 200, `${key}: only ${value.compared} finite cells compared — corpus too sparse`);
  }
  // eslint-disable-next-line no-console
  console.log(
    "derived-slab fuzz:",
    Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, { compared: v.compared, maxDelta: v.maxDelta }])),
  );
});

test("availability subsets: slab needed-slot gating never starves a product", () => {
  // The slab path copies only slots the requested products can read and
  // marks the rest absent; an under-marked needed-set would surface here
  // as NaN cells the JS loop computes. Every subset must match the JS loop
  // exactly as the full-availability run does.
  const rand = mulberry32(0x51ab6);
  const decoded = buildDecoded(rand);
  const subsets = [
    ["lapseRate0to3km"],
    ["bulkShear0to6km"],
    ["effectiveBulkShear"],
    ["dcape"],
    [CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY],
    [
      "effectiveLayerSupercellCompositeParameter",
      "effectiveLayerSignificantTornadoParameter",
      EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY,
    ],
    ["effectiveLayerSignificantTornadoParameter"],
    ["dcape", "bulkShear0to6km", "lapseRate0to3km"],
  ];
  for (const subset of subsets) {
    const label = subset.join("+");
    const slabOut = runBuild(decoded, true, subset);
    const jsOut = runBuild(decoded, false, subset);
    assert.deepStrictEqual(Object.keys(slabOut).sort(), Object.keys(jsOut).sort(), label);
    // Two empty outputs would deep-equal and skip the loop below silently;
    // every subset here is expected to yield at least one product grid.
    assert.ok(Object.keys(jsOut).length > 0, `${label}: subset produced no grids — comparison is vacuous`);
    for (const key of Object.keys(jsOut)) {
      const stats = compareGrids(`${label}:${key}`, slabOut[key], jsOut[key], 1e-2);
      assert.ok(stats.compared > 100, `${label}:${key}: only ${stats.compared} finite cells — gating starved it`);
    }
  }
});

test("MODELVIEW_DERIVED_SLAB=off keeps the JS loop in a fresh process", () => {
  // End-to-end operator contract: with the env set before module load, a
  // tiny build must complete through the JS loop (kernel slab untouched).
  const script = `
    process.env.MODELVIEW_DERIVED_SLAB = "off";
    const severe = require(${JSON.stringify(path.join(__dirname, "../scripts/lib/noaa-beta/severe.js"))});
    const kernelModule = require(${JSON.stringify(path.join(__dirname, "../scripts/lib/noaa-beta/parcel-kernel.js"))});
    const port = kernelModule.getParcelKernel()?.derivedSlab;
    if (port) {
      port.run = () => {
        throw new Error("slab entry point must not run under MODELVIEW_DERIVED_SLAB=off");
      };
    }
    const cells = 64;
    const grid = (v) => new Float32Array(cells).fill(v);
    const decoded = {
      profileSurfaceHeight: grid(100),
      temperature2m: grid(290),
      profileHgt850: grid(1500),
      profileTmp850: grid(282),
      profileHgt700: grid(3100),
      profileTmp700: grid(273),
    };
    const out = severe.buildProfileDerivedGrids(decoded, new Set(["lapseRate0to3km"]), cells, null);
    console.log(JSON.stringify(Object.keys(out)));
  `;
  const stdout = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.strictEqual(stdout.trim(), '["lapseRate0to3km"]');
});
