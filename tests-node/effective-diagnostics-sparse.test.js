"use strict";

// Backlog item #24: buildProfileDerivedGrids must produce BYTE-IDENTICAL
// effective severe diagnostic grids whether the effective-diagnostics work
// scans the grid densely (historical form) or iterates the precomputed
// candidate index list (sparse form). This suite pins that contract:
//
// - A dense oracle, reconstructed from the documented per-cell gates and the
//   exported per-cell machinery, drives the SAME primitives over ALL cells
//   and is compared Object.is-exactly (NaN, -0, finite/absent) against the
//   builder's sparse-iterated outputs on randomized fixtures.
// - Module-level engagement counters (_testEffectiveDiagnosticsSparseLoopStats)
//   prove the builder iterated exactly the candidate list, not the grid.
// - Edge cases: empty candidate set, all-candidate set, NaN-heavy grids, and
//   every effective-diagnostics availability subset.
// - Dense products (lapse/bulk/effective shear/DCAPE) are invariant to
//   co-requested effective diagnostics, pinned against the dense-only build.
//
// MODELVIEW_PARCEL_KERNEL=js forces the pure-JS fallback path — the path the
// sparse iteration optimizes — and keeps both sides on plain-array scratch so
// the comparison is exact rather than kernel-tolerance-based. (The kernel and
// slab parity contracts stay covered by derived-slab-kernel.test.js.)

process.env.MODELVIEW_PARCEL_KERNEL = "js";

const test = require("node:test");
const assert = require("node:assert/strict");

const severe = require("../scripts/lib/noaa-beta/severe");
const { gridValue, resolveProfileGrid } = require("../scripts/lib/noaa-beta/profile-access");
const {
  CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY,
  EFFECTIVE_LAYER_PROFILE_LEVELS,
  EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY,
} = require("../scripts/lib/noaa-nam-parameter-catalog");

const {
  EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG,
  buildEffectiveDiagnosticsCandidateCells,
  buildEffectiveLayerProfileSources,
  buildProfileDerivedGrids,
  calculateEffectiveLayerProductsFromSources,
  createEffectiveDiagnosticsScratch,
  isEffectiveDiagnosticsCandidateCell,
} = severe;

const SCP_KEY = "effectiveLayerSupercellCompositeParameter";
const STP_KEY = "effectiveLayerSignificantTornadoParameter";
const STP100_KEY = EFFECTIVE_STP_100MB_REDUCED_PROTOTYPE_KEY;
const DCAPE21_KEY = CAM_DCAPE_21_LEVEL_PROTOTYPE_KEY;

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

const CELLS = 20011; // odd size, exercises tails like the slab fuzz fixture

function buildDecoded(rand, options = {}) {
  const grid = (fill) => {
    const values = new Float32Array(CELLS);
    for (let i = 0; i < CELLS; i += 1) {
      values[i] = fill(i);
    }
    return values;
  };
  const capeMode = options.capeMode || "mixed";
  const capeValue = (zeroChance, span) => {
    if (capeMode === "none") {
      return 0;
    }
    if (capeMode === "all") {
      return 500 + rand() * span;
    }
    return rand() < zeroChance ? 0 : rand() * span;
  };
  const elevationGrid = grid(() => (rand() < 0.02 ? NaN : rand() < 0.2 ? rand() * 1600 : rand() * 300));
  const decoded = {
    profileSurfaceHeight: elevationGrid,
    temperature2m: grid(() => (rand() < 0.02 ? NaN : 270 + rand() * 35)),
    humidity2m: grid(() => 20 + rand() * 80),
    dewpoint2m: grid(() => (rand() < 0.4 ? NaN : 262 + rand() * 30)),
    derivedSurfacePressure: grid(() => (rand() < 0.15 ? NaN : 84000 + rand() * 19000)),
    pressureMsl: grid(() => 99000 + rand() * 4500),
    windU10m: grid(() => (rand() < 0.02 ? NaN : (rand() - 0.5) * 40)),
    windV10m: grid(() => (rand() - 0.5) * 40),
    mucape: grid(() => capeValue(0.3, 4200)),
    mlcape: grid(() => capeValue(0.35, 3200)),
    mlcin: grid(() => -rand() * 260),
    sbcape: grid(() => capeValue(0.3, 4600)),
    sbcin: grid(() => -rand() * 260),
  };
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

// Dense oracle: the historical per-cell gate sequence (candidate mask ->
// elevation -> surface wind -> fused product screens) driving the exported
// per-cell machinery over EVERY cell. Any cell the sparse loop visits must
// produce exactly this; every other cell keeps its pre-filled NaN.
function denseEffectiveDiagnosticsOracle(decoded, cellCount, { needsScp, needsStp, needsStp100mb }) {
  const scp = needsScp ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const stp = needsStp ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const stp100 = needsStp100mb ? new Float32Array(cellCount).fill(Number.NaN) : null;
  const candidateCells = buildEffectiveDiagnosticsCandidateCells(decoded, cellCount, {
    needsScp,
    needsStp,
    needsStp100mb,
  });
  if (!candidateCells) {
    return { scp, stp, stp100, candidateCount: 0 };
  }
  const effectiveSources = buildEffectiveLayerProfileSources(decoded);
  const scratch = createEffectiveDiagnosticsScratch(effectiveSources?.length || EFFECTIVE_LAYER_PROFILE_LEVELS.length);
  const surfaceHeightGrid = resolveProfileGrid(decoded, "HGT", "surface");
  const surfaceUGrid = resolveProfileGrid(decoded, "UGRD", "surface");
  const surfaceVGrid = resolveProfileGrid(decoded, "VGRD", "surface");
  for (let index = 0; index < cellCount; index += 1) {
    if (!isEffectiveDiagnosticsCandidateCell(candidateCells, index)) {
      continue;
    }
    const elevation = gridValue(surfaceHeightGrid, index);
    if (!Number.isFinite(elevation)) {
      continue;
    }
    const surfaceU = gridValue(surfaceUGrid, index);
    const surfaceV = gridValue(surfaceVGrid, index);
    if (!Number.isFinite(surfaceU) || !Number.isFinite(surfaceV)) {
      continue;
    }
    const cellMucape = gridValue(decoded?.mucape, index);
    const needsScpAtCell = needsScp && cellMucape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG;
    let needsStpAtCell = false;
    if (needsStp) {
      const cellMlcape = gridValue(decoded?.mlcape, index);
      const cellMlcin = gridValue(decoded?.mlcin, index);
      if (cellMlcape > 0 && !(Number.isFinite(cellMlcin) && cellMlcin <= -200)) {
        needsStpAtCell =
          cellMucape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG ||
          cellMlcape >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG ||
          gridValue(decoded?.sbcape, index) >= EFFECTIVE_DIAGNOSTIC_MIN_CANDIDATE_CAPE_JKG;
      }
    }
    const products = calculateEffectiveLayerProductsFromSources(
      decoded,
      effectiveSources,
      index,
      elevation,
      surfaceU,
      surfaceV,
      scratch,
      {
        needsScp: needsScpAtCell,
        needsStp: needsStpAtCell,
        needsStp100mb: needsStp100mb,
      },
    );
    if (products) {
      if (scp && Number.isFinite(products.scp)) {
        scp[index] = products.scp;
      }
      if (stp && Number.isFinite(products.stp)) {
        stp[index] = products.stp;
      }
      if (stp100 && Number.isFinite(products.stp100mbReduced)) {
        stp100[index] = products.stp100mbReduced;
      }
    }
  }
  return { scp, stp, stp100, candidateCount: candidateCells.count };
}

function assertGridObjectIs(label, actual, expected, cellCount) {
  assert.ok(actual instanceof Float32Array, `${label}: builder output missing`);
  assert.ok(expected instanceof Float32Array, `${label}: oracle output missing`);
  assert.strictEqual(actual.length, cellCount, label);
  assert.strictEqual(expected.length, cellCount, label);
  let compared = 0;
  for (let i = 0; i < cellCount; i += 1) {
    if (!Object.is(actual[i], expected[i])) {
      assert.fail(`${label}: cell ${i} builder=${actual[i]} oracle=${expected[i]} (Object.is failed)`);
    }
    if (Number.isFinite(actual[i])) {
      compared += 1;
    }
  }
  // Bit-level backstop: identical f32 bytes, not just identical read values.
  assert.deepStrictEqual(Buffer.from(actual.buffer), Buffer.from(expected.buffer), `${label}: f32 bytes differ`);
  return compared;
}

const AVAILABILITY_SUBSETS = [
  { label: "scp", keys: [SCP_KEY] },
  { label: "stp", keys: [STP_KEY] },
  { label: "scp+stp", keys: [SCP_KEY, STP_KEY] },
  { label: "scp+stp+stp100", keys: [SCP_KEY, STP_KEY, STP100_KEY] },
  { label: "stp100", keys: [STP100_KEY] },
];

function resetSparseLoopStats() {
  severe._testEffectiveDiagnosticsSparseLoopStats.runs = 0;
  severe._testEffectiveDiagnosticsSparseLoopStats.cells = 0;
}

function sparseLoopStats() {
  return { ...severe._testEffectiveDiagnosticsSparseLoopStats };
}

test("candidate cells carry an ascending index list matching the mask exactly", () => {
  const decoded = buildDecoded(mulberry32(0x24a));
  for (const subset of AVAILABILITY_SUBSETS) {
    const needs = {
      needsScp: subset.keys.includes(SCP_KEY),
      needsStp: subset.keys.includes(STP_KEY),
      needsStp100mb: subset.keys.includes(STP100_KEY),
    };
    const cells = buildEffectiveDiagnosticsCandidateCells(decoded, CELLS, needs);
    assert.ok(cells === null || typeof cells.count === "number", subset.label);
    if (cells === null) {
      continue;
    }
    assert.ok(cells.indices, `${subset.label}: candidate cells must carry an index list`);
    assert.strictEqual(cells.indices.length, cells.count, subset.label);
    let expected = 0;
    let previous = -1;
    for (let index = 0; index < CELLS; index += 1) {
      if (cells.mask[index] === 1) {
        assert.strictEqual(cells.indices[expected], index, `${subset.label}: indices/mask mismatch at ${index}`);
        assert.ok(index > previous, `${subset.label}: indices must be ascending`);
        previous = index;
        expected += 1;
      }
    }
    assert.strictEqual(expected, cells.count, subset.label);
  }
});

test("empty candidate set: builder returns all-NaN grids and never engages the sparse loop", () => {
  const decoded = buildDecoded(mulberry32(0x24b), { capeMode: "none" });
  // SCP/STP only: their candidate screens are CAPE-gated, so the zero-CAPE
  // fixture yields an empty candidate set (the STP-100mb prototype screen is
  // surface-prerequisite-only by design and would stay non-empty).
  resetSparseLoopStats();
  const out = buildProfileDerivedGrids(decoded, new Set([SCP_KEY, STP_KEY]), CELLS, null);
  const oracle = denseEffectiveDiagnosticsOracle(decoded, CELLS, {
    needsScp: true,
    needsStp: true,
    needsStp100mb: false,
  });
  assert.strictEqual(oracle.candidateCount, 0, "fixture must produce zero candidates");
  assertGridObjectIs("scp", out[SCP_KEY], oracle.scp, CELLS);
  assertGridObjectIs("stp", out[STP_KEY], oracle.stp, CELLS);
  assert.deepStrictEqual(sparseLoopStats(), { runs: 0, cells: 0 }, "sparse loop must not engage with zero candidates");
});

test("sparse iteration is Object.is-identical to the dense oracle across seeds and availability subsets", () => {
  for (const seed of [0x51ab5, 0x51ab6, 0xbeef01]) {
    const decoded = buildDecoded(mulberry32(seed));
    for (const subset of AVAILABILITY_SUBSETS) {
      const needs = {
        needsScp: subset.keys.includes(SCP_KEY),
        needsStp: subset.keys.includes(STP_KEY),
        needsStp100mb: subset.keys.includes(STP100_KEY),
      };
      resetSparseLoopStats();
      const out = buildProfileDerivedGrids(decoded, new Set(subset.keys), CELLS, null);
      const oracle = denseEffectiveDiagnosticsOracle(decoded, CELLS, needs);
      const label = `seed=${seed.toString(16)}:${subset.label}`;
      let finiteCells = 0;
      if (needs.needsScp) {
        finiteCells += assertGridObjectIs(`${label}:scp`, out[SCP_KEY], oracle.scp, CELLS);
      }
      if (needs.needsStp) {
        finiteCells += assertGridObjectIs(`${label}:stp`, out[STP_KEY], oracle.stp, CELLS);
      }
      if (needs.needsStp100mb) {
        finiteCells += assertGridObjectIs(`${label}:stp100`, out[STP100_KEY], oracle.stp100, CELLS);
      }
      assert.ok(finiteCells > 50, `${label}: too few finite cells (${finiteCells}) — comparison is vacuous`);
      // Engagement: the sparse loop ran once and iterated exactly the
      // candidate list — no more, no less — and that list is strictly smaller
      // than the grid on these mixed-CAPE fixtures.
      const stats = sparseLoopStats();
      assert.strictEqual(stats.runs, 1, `${label}: sparse loop must engage exactly once`);
      assert.strictEqual(stats.cells, oracle.candidateCount, `${label}: sparse loop must iterate the candidate list`);
      assert.ok(stats.cells < CELLS, `${label}: fixture must be sparse (candidates ${stats.cells} < ${CELLS})`);
    }
  }
});

test("all-candidate fixture: sparse loop covers every cell and stays byte-identical", () => {
  const decoded = buildDecoded(mulberry32(0xa11), { capeMode: "all" });
  const keys = [SCP_KEY, STP_KEY];
  resetSparseLoopStats();
  const out = buildProfileDerivedGrids(decoded, new Set(keys), CELLS, null);
  const oracle = denseEffectiveDiagnosticsOracle(decoded, CELLS, {
    needsScp: true,
    needsStp: true,
    needsStp100mb: false,
  });
  assert.strictEqual(oracle.candidateCount, CELLS, "fixture must make every cell a candidate");
  assert.strictEqual(sparseLoopStats().cells, CELLS, "sparse loop must iterate every cell when all are candidates");
  assertGridObjectIs("all:scp", out[SCP_KEY], oracle.scp, CELLS);
  assertGridObjectIs("all:stp", out[STP_KEY], oracle.stp, CELLS);
});

test("dense products are invariant to co-requested effective diagnostics", () => {
  // The dense cell loop's structure for dense-only availability is unchanged;
  // requiring the same dense grids byte-identically when effective
  // diagnostics join the availability set pins the mixed-case loop split.
  const decoded = buildDecoded(mulberry32(0xde11e));
  const denseKeys = ["lapseRate0to3km", "bulkShear0to6km", "effectiveBulkShear", "dcape"];
  const denseOnly = buildProfileDerivedGrids(decoded, new Set(denseKeys), CELLS, {});
  const mixed = buildProfileDerivedGrids(
    decoded,
    new Set([...denseKeys, SCP_KEY, STP_KEY, STP100_KEY, DCAPE21_KEY]),
    CELLS,
    {},
  );
  for (const key of [...denseKeys, DCAPE21_KEY]) {
    assert.ok(denseOnly[key] || mixed[key], `${key}: expected in at least one build`);
  }
  for (const key of denseKeys) {
    assert.deepStrictEqual(
      Buffer.from(mixed[key].buffer),
      Buffer.from(denseOnly[key].buffer),
      `${key}: dense grid changed when effective diagnostics were co-requested`,
    );
  }
  // The effective outputs of the mixed build still match the oracle exactly.
  const oracle = denseEffectiveDiagnosticsOracle(decoded, CELLS, {
    needsScp: true,
    needsStp: true,
    needsStp100mb: true,
  });
  assertGridObjectIs("mixed:scp", mixed[SCP_KEY], oracle.scp, CELLS);
  assertGridObjectIs("mixed:stp", mixed[STP_KEY], oracle.stp, CELLS);
  assertGridObjectIs("mixed:stp100", mixed[STP100_KEY], oracle.stp100, CELLS);
});
