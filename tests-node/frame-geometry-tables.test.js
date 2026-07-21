"use strict";

// Byte-exactness contract for the per-frame geometry-table hoist (backlog #17,
// 2026-07-18) and the buildRunMaxCurrentGrid NaN-prefill removal (#19):
//  - buildDerivedParameterGrids now builds the Coriolis table and the
//    finite-difference spacing table once per frame and passes them to the
//    two relative-vorticity and two frontogenesis builders (previously each
//    builder rebuilt an identical table).
//  - buildFiniteDifferenceSpacingRows tabulates rowToLatMercator once per row
//    instead of three overlapping calls per interior row.
//  - buildRunMaxCurrentGrid dropped its blanket fill(NaN) because every cell
//    is assigned (explicit NaN in the non-finite branch).
// All three are pure refactors: same functions, same inputs, same doubles.
// These tests pin that claim with inline pre-change reference implementations
// and raw-bit comparisons (NaN payloads, -0, clamp branches included).

const test = require("node:test");
const assert = require("node:assert");

const { rowToLatMercator } = require("../scripts/lib/mercator");
const {
  _testBuildCoriolisByRow: buildCoriolisByRow,
  _testBuildDerivedParameterGrids: buildDerivedParameterGrids,
  _testBuildFiniteDifferenceSpacingRows: buildFiniteDifferenceSpacingRows,
  _testBuildFrontogenesisGrid: buildFrontogenesisGrid,
  _testBuildRelativeVorticityGrid: buildRelativeVorticityGrid,
  _testBuildRunMaxCurrentGrid: buildRunMaxCurrentGrid,
  _testMaskPressureLevelGridBelowTerrain: maskPressureLevelGridBelowTerrain,
} = require("../scripts/lib/noaa-beta-renderer");

const EARTH_OMEGA_RAD_S = 7.2921e-5;
const EARTH_RADIUS_M = 6371000;

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

function bitsOf(arr) {
  if (arr.BYTES_PER_ELEMENT === 8) {
    return new BigUint64Array(arr.buffer, arr.byteOffset, arr.length);
  }
  return new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
}

function assertSameBits(actual, expected, label) {
  assert.ok(actual, `${label}: actual is null`);
  assert.ok(expected, `${label}: expected is null`);
  assert.strictEqual(actual.length, expected.length, `${label}: length`);
  const a = bitsOf(actual);
  const b = bitsOf(expected);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      assert.fail(`${label}: first bit mismatch at index ${i}: actual=${actual[i]} expected=${expected[i]}`);
    }
  }
}

// --- Inline pre-change references (copied from the 5243c79 implementations) ---

function referenceCoriolisByRow(bounds, rows) {
  const out = new Float64Array(Math.max(0, rows));
  out.fill(Number.NaN);
  for (let y = 0; y < rows; y += 1) {
    const lat = bounds ? rowToLatMercator(y, rows, bounds) : Number.NaN;
    if (Number.isFinite(lat)) {
      out[y] = 2 * EARTH_OMEGA_RAD_S * Math.sin((lat * Math.PI) / 180);
    }
  }
  return out;
}

function referenceFiniteDifferenceSpacingRows(bounds, cols, rows) {
  const west = Number(bounds?.west);
  const east = Number(bounds?.east);
  if (!Number.isFinite(west) || !Number.isFinite(east)) {
    return null;
  }
  const lonStepRad = Math.abs(((east - west) * Math.PI) / 180 / Math.max(1, cols - 1));
  const dx2 = new Float64Array(Math.max(0, rows));
  const dy2 = new Float64Array(Math.max(0, rows));
  dx2.fill(Number.NaN);
  dy2.fill(Number.NaN);
  for (let y = 1; y < rows - 1; y += 1) {
    const centerLat = rowToLatMercator(y, rows, bounds);
    const northLat = rowToLatMercator(y - 1, rows, bounds);
    const southLat = rowToLatMercator(y + 1, rows, bounds);
    if (!Number.isFinite(centerLat) || !Number.isFinite(northLat) || !Number.isFinite(southLat)) {
      continue;
    }
    dx2[y] = Math.max(1, 2 * EARTH_RADIUS_M * Math.cos((centerLat * Math.PI) / 180) * lonStepRad);
    dy2[y] = Math.max(1, EARTH_RADIUS_M * Math.abs(((northLat - southLat) * Math.PI) / 180));
  }
  return { dx2, dy2 };
}

function referenceRunMaxCurrentGrid(values, multiplier, cellCount) {
  if (!values) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const value = Number(values[index]);
    out[index] = Number.isFinite(value) ? Math.max(0, value * multiplier) : Number.NaN;
  }
  return out;
}

// --- buildFiniteDifferenceSpacingRows: lat-table refactor parity ---

test("spacing rows match the three-call-per-row reference bit for bit", () => {
  const cases = [
    // [label, bounds, cols, rows]
    ["conus", { north: 50, south: 25, west: -125, east: -66 }, 37, 23],
    ["tiny-grid", { north: 41, south: 40, west: -100, east: -99 }, 3, 3],
    ["zero-lon-span-clamp", { north: 45, south: 40, west: -100, east: -100 }, 5, 5],
    ["negative-zero-lon-span", { north: 45, south: 40, west: 0, east: -0 }, 5, 5],
    ["zero-lat-span-fallback", { north: 42, south: 42, west: -105, east: -95 }, 6, 4],
    ["nan-north-all-nan-rows", { north: Number.NaN, south: 40, west: -105, east: -95 }, 5, 5],
    ["single-col", { north: 45, south: 40, west: -105, east: -95 }, 1, 6],
    ["two-rows-no-interior", { north: 45, south: 40, west: -105, east: -95 }, 4, 2],
    ["one-row", { north: 45, south: 40, west: -105, east: -95 }, 4, 1],
    ["zero-rows", { north: 45, south: 40, west: -105, east: -95 }, 4, 0],
    ["wide-pole-clipped", { north: 89.9, south: -89.9, west: -179.9, east: 179.9 }, 19, 17],
    ["crossing-equator", { north: 12.5, south: -7.25, west: 20, east: 55 }, 11, 9],
  ];
  for (const [label, bounds, cols, rows] of cases) {
    const actual = buildFiniteDifferenceSpacingRows(bounds, cols, rows);
    const expected = referenceFiniteDifferenceSpacingRows(bounds, cols, rows);
    assert.ok(actual, `${label}: builder returned null`);
    assertSameBits(actual.dx2, expected.dx2, `${label} dx2`);
    assertSameBits(actual.dy2, expected.dy2, `${label} dy2`);
    // Rows 0 and rows-1 must remain the load-bearing prefill NaN.
    if (rows > 0) {
      assert.ok(Number.isNaN(actual.dx2[0]) && Number.isNaN(actual.dy2[0]), `${label}: row 0 must stay NaN`);
    }
    if (rows > 1) {
      assert.ok(
        Number.isNaN(actual.dx2[rows - 1]) && Number.isNaN(actual.dy2[rows - 1]),
        `${label}: last row must stay NaN`,
      );
    }
  }
});

test("spacing rows return null for non-finite west/east exactly like the reference", () => {
  assert.strictEqual(
    buildFiniteDifferenceSpacingRows({ north: 45, south: 40, west: Number.NaN, east: -95 }, 5, 5),
    null,
  );
  assert.strictEqual(
    buildFiniteDifferenceSpacingRows({ north: 45, south: 40, west: -Infinity, east: -95 }, 5, 5),
    null,
  );
  assert.strictEqual(buildFiniteDifferenceSpacingRows({ north: 45, south: 40, west: -105 }, 5, 5), null);
  assert.strictEqual(buildFiniteDifferenceSpacingRows(null, 5, 5), null);
});

test("spacing rows fuzz: randomized bounds/dimensions match the reference bit for bit", () => {
  const rand = mulberry32(0x5eed1234);
  for (let trial = 0; trial < 400; trial += 1) {
    const south = -80 + rand() * 100;
    const north = south + rand() * (85.05112878 - south) + rand() * 5;
    const west = -180 + rand() * 360;
    const east = west + rand() * 60 - (rand() < 0.1 ? rand() * 120 : 0);
    const cols = 2 + Math.floor(rand() * 40);
    const rows = 2 + Math.floor(rand() * 40);
    const bounds = { north, south, west, east };
    const actual = buildFiniteDifferenceSpacingRows(bounds, cols, rows);
    const expected = referenceFiniteDifferenceSpacingRows(bounds, cols, rows);
    assert.strictEqual(Boolean(actual), Boolean(expected), `trial ${trial}: null mismatch`);
    if (actual) {
      assertSameBits(actual.dx2, expected.dx2, `trial ${trial} dx2`);
      assertSameBits(actual.dy2, expected.dy2, `trial ${trial} dy2`);
    }
  }
});

// --- buildCoriolisByRow: unchanged builder, pinned against the formula ---

test("coriolis table matches the inline formula incl. NaN and zero rows", () => {
  const cases = [
    ["conus", { north: 50, south: 25, west: -125, east: -66 }, 23],
    ["equator-zero", { north: 1, south: -1, west: -10, east: 10 }, 3],
    ["null-bounds-all-nan", null, 5],
    ["nan-bounds-all-nan", { north: Number.NaN, south: 40, west: -105, east: -95 }, 5],
    ["zero-rows", { north: 45, south: 40, west: -105, east: -95 }, 0],
    ["one-row-degenerate", { north: 45, south: 40, west: -105, east: -95 }, 1],
  ];
  for (const [label, bounds, rows] of cases) {
    assertSameBits(buildCoriolisByRow(bounds, rows), referenceCoriolisByRow(bounds, rows), label);
  }
});

// --- buildRelativeVorticityGrid: hoisted-table parameter parity ---

test("relative vorticity with a hoisted coriolis table is bit-identical to computing its own", () => {
  const rand = mulberry32(0xc0ffee);
  const width = 9;
  const height = 7;
  const bounds = { north: 48, south: 30, west: -110, east: -90 };
  const absolute = new Float32Array(width * height);
  for (let i = 0; i < absolute.length; i += 1) {
    const r = rand();
    if (r < 0.15) {
      absolute[i] = Number.NaN;
    } else if (r < 0.2) {
      absolute[i] = -0;
    } else if (r < 0.25) {
      absolute[i] = 0;
    } else {
      absolute[i] = (rand() - 0.5) * 4e-4;
    }
  }
  // A cell exactly at the Coriolis value exercises the +0 subtraction branch.
  const coriolis = buildCoriolisByRow(bounds, height);
  absolute[3 * width + 4] = coriolis[3];
  const own = buildRelativeVorticityGrid(absolute, bounds, width, height);
  const hoisted = buildRelativeVorticityGrid(absolute, bounds, width, height, coriolis);
  assertSameBits(hoisted, own, "hoisted-vs-own coriolis");
  // The shared table must also survive reuse by a second level unchanged.
  const second = buildRelativeVorticityGrid(absolute, bounds, width, height, coriolis);
  assertSameBits(second, own, "second-consumer reuse");
});

test("relative vorticity keeps NaN rows where the coriolis table is non-finite", () => {
  const width = 4;
  const height = 3;
  const absolute = new Float32Array(width * height).fill(1e-4);
  const bounds = { north: Number.NaN, south: 40, west: -105, east: -95 };
  const own = buildRelativeVorticityGrid(absolute, bounds, width, height);
  const hoisted = buildRelativeVorticityGrid(absolute, bounds, width, height, buildCoriolisByRow(bounds, height));
  assertSameBits(hoisted, own, "all-NaN coriolis rows");
  assert.ok(
    own.every((v) => Number.isNaN(v)),
    "non-finite coriolis must leave every cell NaN",
  );
});

test("builders actually consume the supplied table (engagement, not vacuous parity)", () => {
  const width = 4;
  const height = 3;
  const bounds = { north: 45, south: 40, west: -105, east: -95 };
  const absolute = new Float32Array(width * height).fill(1e-4);
  const own = buildRelativeVorticityGrid(absolute, bounds, width, height);
  // A poisoned coriolis table must change the output if the parameter is
  // really wired through.
  const poison = new Float64Array(height).fill(7e-9);
  const withPoison = buildRelativeVorticityGrid(absolute, bounds, width, height, poison);
  assert.ok(
    withPoison.some((v, i) => !Object.is(v, own[i])),
    "supplied coriolis table was ignored",
  );

  const width5 = 5;
  const height5 = 5;
  const temp = new Float32Array(width5 * height5);
  const windU = new Float32Array(width5 * height5);
  const windV = new Float32Array(width5 * height5);
  for (let y = 0; y < height5; y += 1) {
    for (let x = 0; x < width5; x += 1) {
      const index = y * width5 + x;
      temp[index] = 280 + x + y;
      windU[index] = 10 + x * 2;
      windV[index] = 5 - y;
    }
  }
  const decoded = { temp850: temp, wind850U: windU, wind850V: windV };
  const ownFront = buildFrontogenesisGrid(decoded, 850, bounds, width5, height5);
  const poisonSpacing = {
    dx2: new Float64Array(5).fill(1),
    dy2: new Float64Array(5).fill(1),
  };
  const withPoisonSpacing = buildFrontogenesisGrid(decoded, 850, bounds, 5, 5, poisonSpacing);
  assert.ok(
    withPoisonSpacing.some((v, i) => !Object.is(v, ownFront[i])),
    "supplied spacing table was ignored",
  );
});

// --- buildFrontogenesisGrid: hoisted-spacing parameter parity ---

function makeFrontogenesisFixture(width, height, rand) {
  const decoded = {};
  for (const level of [850, 700]) {
    const temp = new Float32Array(width * height);
    const u = new Float32Array(width * height);
    const v = new Float32Array(width * height);
    for (let i = 0; i < temp.length; i += 1) {
      const r = rand();
      if (r < 0.12) {
        temp[i] = Number.NaN;
      } else if (r < 0.16) {
        u[i] = Number.NaN;
      } else if (r < 0.2) {
        v[i] = Number.NaN;
      } else {
        temp[i] = 260 + rand() * 40;
        u[i] = (rand() - 0.5) * 60;
        v[i] = (rand() - 0.5) * 60;
      }
    }
    decoded[`temp${level}`] = temp;
    decoded[`wind${level}U`] = u;
    decoded[`wind${level}V`] = v;
  }
  return decoded;
}

test("frontogenesis with a hoisted spacing table is bit-identical to computing its own", () => {
  const rand = mulberry32(0xf00d);
  const width = 8;
  const height = 8;
  const bounds = { north: 46, south: 38, west: -108, east: -96 };
  const decoded = makeFrontogenesisFixture(width, height, rand);
  const spacing = buildFiniteDifferenceSpacingRows(bounds, width, height);
  for (const level of [850, 700]) {
    const own = buildFrontogenesisGrid(decoded, level, bounds, width, height);
    const hoisted = buildFrontogenesisGrid(decoded, level, bounds, width, height, spacing);
    assertSameBits(hoisted, own, `level ${level} hoisted-vs-own spacing`);
  }
});

test("frontogenesis clamp/degenerate cases match with and without hoisted spacing", () => {
  const width = 5;
  const height = 5;
  const zeros = () => new Float32Array(width * height);
  const decoded = { temp850: zeros(), wind850U: zeros(), wind850V: zeros() };
  // Zero lon span drives dx2/dy2 onto the Math.max(1, ·) clamp.
  const clampBounds = { north: 41, south: 40, west: -100, east: -100 };
  const clampSpacing = buildFiniteDifferenceSpacingRows(clampBounds, width, height);
  assertSameBits(
    buildFrontogenesisGrid(decoded, 850, clampBounds, width, height, clampSpacing),
    buildFrontogenesisGrid(decoded, 850, clampBounds, width, height),
    "clamp bounds",
  );
  // Non-finite west/east makes the spacing table null: the builder must still
  // produce the all-NaN grid in both modes.
  const nanBounds = { north: 45, south: 40, west: Number.NaN, east: -95 };
  const own = buildFrontogenesisGrid(decoded, 850, nanBounds, width, height);
  const hoisted = buildFrontogenesisGrid(decoded, 850, nanBounds, width, height, null);
  assertSameBits(hoisted, own, "null spacing bounds");
  assert.ok(
    own.every((v) => Number.isNaN(v)),
    "null spacing must leave the grid all-NaN",
  );
});

// --- Frame-level hoist: buildDerivedParameterGrids shares one table per frame ---

test("derived grids built from shared per-frame tables match standalone builders bit for bit", () => {
  const rand = mulberry32(0xdecaf);
  const width = 11;
  const height = 9;
  const cellCount = width * height;
  const bounds = { north: 47, south: 32, west: -112, east: -92 };
  const decoded = makeFrontogenesisFixture(width, height, rand);
  decoded.absoluteVorticity700 = new Float32Array(cellCount);
  decoded.absoluteVorticity500 = new Float32Array(cellCount);
  for (let i = 0; i < cellCount; i += 1) {
    const r = rand();
    decoded.absoluteVorticity700[i] = r < 0.1 ? Number.NaN : (rand() - 0.4) * 3e-4;
    decoded.absoluteVorticity500[i] = r < 0.05 ? Number.NaN : (rand() - 0.4) * 3e-4;
  }
  const selection = {
    availableParameters: ["relativeVorticity700", "relativeVorticity500", "frontogenesis850", "frontogenesis700"],
  };
  const grids = buildDerivedParameterGrids({ decoded, selection, bounds, width, height });
  assertSameBits(
    grids.relativeVorticity700,
    buildRelativeVorticityGrid(
      maskPressureLevelGridBelowTerrain(decoded.absoluteVorticity700, decoded, 700, width, height),
      bounds,
      width,
      height,
    ),
    "frame relativeVorticity700",
  );
  assertSameBits(
    grids.relativeVorticity500,
    buildRelativeVorticityGrid(
      maskPressureLevelGridBelowTerrain(decoded.absoluteVorticity500, decoded, 500, width, height),
      bounds,
      width,
      height,
    ),
    "frame relativeVorticity500",
  );
  assertSameBits(
    grids.frontogenesis850,
    buildFrontogenesisGrid(decoded, 850, bounds, width, height),
    "frame frontogenesis850",
  );
  assertSameBits(
    grids.frontogenesis700,
    buildFrontogenesisGrid(decoded, 700, bounds, width, height),
    "frame frontogenesis700",
  );
});

// --- buildRunMaxCurrentGrid: prefill-removal parity (NaN/-0/zero/trace/clamp) ---

test("run-max grid without the NaN prefill matches the prefill reference bit for bit", () => {
  const cases = [
    ["basic", [Number.NaN, -0, 0, 1e-30, -5, 3.5, Infinity, -Infinity], 2],
    ["multiplier-one", [0, -0, 1e-38, 1e-45, 42], 1],
    ["negative-multiplier-clamp", [5, -5, 0.25, Number.NaN], -3],
    ["trace-subnormal", [5e-324, 1e-320, 2.2250738585072014e-308], 1e-10],
    ["huge-overflow", [3.4e38, 1e308, -1e308], 4],
  ];
  for (const [label, rawValues, multiplier] of cases) {
    const values = new Float32Array(rawValues);
    const cellCount = values.length;
    assertSameBits(
      buildRunMaxCurrentGrid(values, multiplier, cellCount),
      referenceRunMaxCurrentGrid(values, multiplier, cellCount),
      label,
    );
  }
  // Short source grid: out-of-range reads see undefined -> NaN, previously
  // indistinguishable from the prefill; still identical now.
  const short = new Float32Array([1, Number.NaN, 2]);
  assertSameBits(
    buildRunMaxCurrentGrid(short, 2, 6),
    referenceRunMaxCurrentGrid(short, 2, 6),
    "short-source undefined reads",
  );
  // Null source still returns null.
  assert.strictEqual(buildRunMaxCurrentGrid(null, 1, 4), null);
});

test("run-max grid fuzz: randomized inputs match the prefill reference bit for bit", () => {
  const rand = mulberry32(0xbeef01);
  for (let trial = 0; trial < 200; trial += 1) {
    const cellCount = 1 + Math.floor(rand() * 500);
    const values = new Float32Array(cellCount);
    for (let i = 0; i < cellCount; i += 1) {
      const r = rand();
      if (r < 0.2) {
        values[i] = Number.NaN;
      } else if (r < 0.25) {
        values[i] = -0;
      } else if (r < 0.3) {
        values[i] = 0;
      } else if (r < 0.35) {
        values[i] = (rand() - 0.5) * 1e-30;
      } else {
        values[i] = (rand() - 0.5) * 200;
      }
    }
    const multiplier = [1, 2.23694, 0.001, -1][Math.floor(rand() * 4)];
    assertSameBits(
      buildRunMaxCurrentGrid(values, multiplier, cellCount),
      referenceRunMaxCurrentGrid(values, multiplier, cellCount),
      `trial ${trial}`,
    );
  }
});
