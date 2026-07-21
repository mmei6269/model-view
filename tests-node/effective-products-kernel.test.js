"use strict";

// Stage G1 tolerance contract: the in-kernel effective-layer product chain
// (wind interpolation, Bunkers, SRH, EBWD, mixed-layer parcel, SCP/STP
// composites — f64 NativeMath) vs the JS glue in severe.js/profile-wind.js.
// Both sides run the SAME f32 kernel origin scan, so any disagreement is
// attributable to the glue port alone. NativeMath transcendentals are <=1
// ulp from V8's, so agreed-finite products must match to ~1e-12 relative;
// the bounds below carry orders-of-magnitude headroom, and classification
// flips (finite vs absent) must not occur across the fuzz corpus.

const test = require("node:test");
const assert = require("node:assert");

const severe = require("../scripts/lib/noaa-beta/severe");
const { getParcelKernel } = require("../scripts/lib/noaa-beta/parcel-kernel");

const calculateEffectiveLayerProductsFromSources =
  severe.calculateEffectiveLayerProductsFromSources || severe._test_calculateEffectiveLayerProductsFromSources;
const createEffectiveDiagnosticsScratch =
  severe.createEffectiveDiagnosticsScratch || severe._test_createEffectiveDiagnosticsScratch;

const LEVELS = [
  1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 650, 600, 550, 500, 450, 400, 350, 300,
];

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

// Builds a single-cell decoded object + 21-level sources so the REAL
// fillEffectiveDiagnosticsProfileRows path (via
// calculateEffectiveLayerProductsFromSources) constructs the rows.
function buildProfileCase(rand) {
  const elevation = rand() < 0.25 ? rand() * 1800 : rand() * 350;
  const surfacePressurePa = (1013 - elevation * 0.11 + (rand() - 0.5) * 30) * 100;
  const surfaceTempK = 272 + rand() * 34;
  const surfaceRh = 25 + rand() * 74;
  const surfaceU = (rand() - 0.5) * 40;
  const surfaceV = (rand() - 0.5) * 40;
  const useDirectDewpoint = rand() < 0.6;
  const surfaceDewpointK = surfaceTempK - rand() * 18;

  const decoded = {
    derivedSurfacePressure: [surfacePressurePa],
    pressureMsl: [101300 + (rand() - 0.5) * 3000],
    temperature2m: [surfaceTempK],
    humidity2m: [surfaceRh],
    dewpoint2m: [useDirectDewpoint ? surfaceDewpointK : Number.NaN],
    profileSurfaceHeight: [elevation],
    windU10m: [surfaceU],
    windV10m: [surfaceV],
    mlcape: [rand() < 0.15 ? Number.NaN : rand() * 3500],
    mlcin: [rand() < 0.15 ? Number.NaN : -rand() * 220],
  };

  const sources = [];
  let heightMsl = elevation + 10;
  let tempK = surfaceTempK + (rand() - 0.5) * 3;
  for (const level of LEVELS) {
    const surfaceHpa = surfacePressurePa / 100;
    if (level >= surfaceHpa - 2) {
      // below-ground level: keep grids but at a height below the surface
      sources.push({
        level,
        hgt: [elevation - 50 - rand() * 200],
        tmp: [tempK + rand() * 4],
        rh: [40 + rand() * 40],
        u: [(rand() - 0.5) * 20],
        v: [(rand() - 0.5) * 20],
      });
      continue;
    }
    heightMsl += 180 + rand() * 420;
    tempK -= (0.4 + rand() * 0.65) * ((heightMsl - elevation) / 1000);
    const missingWind = rand() < 0.04;
    const missingThermo = rand() < 0.04;
    sources.push({
      level,
      hgt: [rand() < 0.02 ? Number.NaN : heightMsl],
      tmp: [missingThermo ? Number.NaN : Math.max(200, tempK + (rand() - 0.5) * 2)],
      rh: [missingThermo ? Number.NaN : 8 + rand() * 92],
      u: [missingWind ? Number.NaN : (rand() - 0.5) * 70],
      v: [missingWind ? Number.NaN : (rand() - 0.5) * 70],
    });
  }
  return { decoded, sources, elevation, surfaceU, surfaceV };
}

const kernel = getParcelKernel();

test("kernel exports the Stage G1 product chain", () => {
  assert.ok(kernel?.effectiveProducts, "runEffectiveProducts missing");
  assert.ok(kernel?.views?.u && kernel?.views?.v && kernel?.views?.productsOut, "G1 views missing");
});

test("effective products: kernel chain vs JS glue over the shared f32 scan (fuzz)", () => {
  assert.strictEqual(typeof calculateEffectiveLayerProductsFromSources, "function");
  assert.strictEqual(typeof createEffectiveDiagnosticsScratch, "function");
  const rand = mulberry32(0x91a11);
  const CASES = 4000;
  const stats = {
    computed: 0,
    bothNull: 0,
    flips: 0,
    kernelEngaged: 0,
    maxDelta: { scp: 0, stp: 0, stp100mbReduced: 0 },
    finite: { scp: 0, stp: 0, stp100mbReduced: 0 },
  };
  const options = { needsScp: true, needsStp: true, needsStp100mb: true };
  // ENGAGEMENT SPY (derived-slab precedent): count invocations of the
  // kernel's Stage G1 entry point. The routing gate in severe.js
  // (scratch.kernel?.effectiveProducts && scratch.u === kernel.views.u) can
  // silently fall back to the JS glue, which would turn this fuzz into a
  // vacuous JS-vs-JS comparison; the spy ties every non-null kernel-path
  // product to an actual kernel call, and proves the oracle path never
  // enters the kernel chain.
  const originalEffectiveProducts = kernel.effectiveProducts;
  let effectiveProductsCalls = 0;
  kernel.effectiveProducts = (...args) => {
    effectiveProductsCalls += 1;
    return originalEffectiveProducts(...args);
  };
  try {
    for (let i = 0; i < CASES; i += 1) {
      const { decoded, sources, elevation, surfaceU, surfaceV } = buildProfileCase(rand);
      // Kernel path: scratch whose u/v ARE the kernel views.
      const kernelScratch = createEffectiveDiagnosticsScratch(sources.length, { useKernel: true });
      assert.strictEqual(kernelScratch.u, kernel.views.u, "kernel scratch must use the wind views");
      const callsBeforeKernelPath = effectiveProductsCalls;
      const kernelProducts = calculateEffectiveLayerProductsFromSources(
        decoded,
        sources,
        0,
        elevation,
        surfaceU,
        surfaceV,
        kernelScratch,
        options,
      );
      const kernelPathCalls = effectiveProductsCalls - callsBeforeKernelPath;
      assert.ok(kernelPathCalls <= 1, `case ${i}: kernel entry point ran ${kernelPathCalls} times for one cell`);
      if (kernelProducts) {
        assert.strictEqual(
          kernelPathCalls,
          1,
          `case ${i}: kernel-path products returned without engaging kernel.effectiveProducts — the JS glue computed both sides`,
        );
      }
      stats.kernelEngaged += kernelPathCalls;
      // Oracle path: same kernel scratch (same f32 scan, same shared row
      // views) but with detached copies of u/v so the routing gate falls
      // back to the JS glue.
      const oracleScratch = createEffectiveDiagnosticsScratch(sources.length, { useKernel: true });
      oracleScratch.u = new Float64Array(oracleScratch.kernel.rowsCap);
      oracleScratch.v = new Float64Array(oracleScratch.kernel.rowsCap);
      const callsBeforeOraclePath = effectiveProductsCalls;
      const oracleProducts = calculateEffectiveLayerProductsFromSources(
        decoded,
        sources,
        0,
        elevation,
        surfaceU,
        surfaceV,
        oracleScratch,
        options,
      );
      assert.strictEqual(
        effectiveProductsCalls,
        callsBeforeOraclePath,
        `case ${i}: oracle path entered the kernel product chain — comparison is kernel-vs-kernel`,
      );
      const kernelNull = !kernelProducts;
      const oracleNull = !oracleProducts;
      if (kernelNull && oracleNull) {
        stats.bothNull += 1;
        continue;
      }
      for (const key of ["scp", "stp", "stp100mbReduced"]) {
        const kernelValue = kernelNull ? Number.NaN : Number(kernelProducts[key]);
        const oracleValue = oracleNull ? Number.NaN : Number(oracleProducts[key]);
        const kernelFinite = Number.isFinite(kernelValue);
        const oracleFinite = Number.isFinite(oracleValue);
        if (kernelFinite !== oracleFinite) {
          stats.flips += 1;
          continue;
        }
        if (!kernelFinite) {
          continue;
        }
        stats.finite[key] += 1;
        const delta = Math.abs(kernelValue - oracleValue);
        const bound = 1e-6 + 1e-9 * Math.abs(oracleValue);
        assert.ok(
          delta <= bound,
          `case ${i} ${key}: kernel=${kernelValue} oracle=${oracleValue} delta=${delta} > ${bound}`,
        );
        if (delta > stats.maxDelta[key]) {
          stats.maxDelta[key] = delta;
        }
      }
      stats.computed += 1;
    }
  } finally {
    kernel.effectiveProducts = originalEffectiveProducts;
  }
  // Classification flips would mean a NativeMath ulp crossed a hard gate —
  // possible in principle, but it must not happen across this corpus.
  assert.strictEqual(stats.flips, 0, `finite/absent classification flips: ${stats.flips}`);
  assert.ok(
    stats.computed > CASES / 10,
    `too few computed cases (${stats.computed}) — corpus not exercising the chain`,
  );
  assert.ok(
    stats.finite.scp > 100 && stats.finite.stp > 100 && stats.finite.stp100mbReduced > 100,
    `too few finite products: ${JSON.stringify(stats.finite)}`,
  );
  // ENGAGEMENT: parity is meaningless unless the kernel chain actually ran
  // for a substantial share of the corpus (rowCount < 3 cases legitimately
  // skip it, so this is a floor rather than CASES).
  assert.ok(
    stats.kernelEngaged > CASES / 10,
    `kernel product chain engaged for only ${stats.kernelEngaged}/${CASES} cases — fuzz is not exercising it`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `effective-products fuzz: computed=${stats.computed} bothNull=${stats.bothNull} ` +
      `kernelEngaged=${stats.kernelEngaged} finite=${JSON.stringify(stats.finite)} ` +
      `maxDelta=${JSON.stringify(stats.maxDelta)}`,
  );
});
