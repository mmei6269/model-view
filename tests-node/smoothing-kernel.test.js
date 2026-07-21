"use strict";

// Byte-exactness contract for the wasm presentation-smoothing port (kernel
// Stage E, 2026-07-12): the port must reproduce the JS
// smoothFiniteNonnegativeGrid output bit for bit (f64 tap order, f32
// intermediate rounding, finiteness-flag semantics, Math.max(0,·) clamp).

const test = require("node:test");
const assert = require("node:assert");

const gridOps = require("../scripts/lib/noaa-beta/grid-ops");
const { getParcelKernel } = require("../scripts/lib/noaa-beta/parcel-kernel");

const { smoothFiniteNonnegativeGrid, SNOWFALL_PRESENTATION_SMOOTHING_KERNEL } = gridOps;

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

// Pure-JS reference copied from grid-ops.js at the pre-port revision so the
// test stays meaningful even though the module now routes to the kernel.
function referenceSmooth(values, width, height, passes) {
  const kernel = SNOWFALL_PRESENTATION_SMOOTHING_KERNEL;
  const radius = Math.floor(kernel.length / 2);
  const cellCount = values.length;
  let maskAllFinite = true;
  for (let i = 0; i < cellCount; i += 1) {
    if (!Number.isFinite(values[i])) {
      maskAllFinite = false;
      break;
    }
  }
  const sampleInline = (buf, centerIndex, stride, coordinate, limit) => {
    if (radius !== 2 || coordinate < 2 || coordinate > limit - 3) {
      let weighted = 0;
      let weightTotal = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const sampleCoordinate = coordinate + offset;
        if (sampleCoordinate < 0 || sampleCoordinate >= limit) continue;
        const value = Number(buf[centerIndex + offset * stride]);
        if (!Number.isFinite(value)) continue;
        const weight = Number(kernel[offset + radius]) || 0;
        weighted += value * weight;
        weightTotal += weight;
      }
      return weightTotal > 0 ? weighted / weightTotal : Number.NaN;
    }
    const w0 = Number(kernel[0]) || 0;
    const w1 = Number(kernel[1]) || 0;
    const w2 = Number(kernel[2]) || 0;
    const w3 = Number(kernel[3]) || 0;
    const w4 = Number(kernel[4]) || 0;
    let weighted = 0;
    let weightTotal = 0;
    const v0 = buf[centerIndex - 2 * stride];
    if (Number.isFinite(v0)) {
      weighted += v0 * w0;
      weightTotal += w0;
    }
    const v1 = buf[centerIndex - stride];
    if (Number.isFinite(v1)) {
      weighted += v1 * w1;
      weightTotal += w1;
    }
    const v2 = buf[centerIndex];
    if (Number.isFinite(v2)) {
      weighted += v2 * w2;
      weightTotal += w2;
    }
    const v3 = buf[centerIndex + stride];
    if (Number.isFinite(v3)) {
      weighted += v3 * w3;
      weightTotal += w3;
    }
    const v4 = buf[centerIndex + 2 * stride];
    if (Number.isFinite(v4)) {
      weighted += v4 * w4;
      weightTotal += w4;
    }
    return weightTotal > 0 ? weighted / weightTotal : Number.NaN;
  };
  const interior5 = (buf, centerIndex, stride) => {
    const w0 = Number(kernel[0]) || 0;
    const w1 = Number(kernel[1]) || 0;
    const w2 = Number(kernel[2]) || 0;
    const w3 = Number(kernel[3]) || 0;
    const w4 = Number(kernel[4]) || 0;
    let weighted = 0;
    let weightTotal = 0;
    weighted += buf[centerIndex - 2 * stride] * w0;
    weightTotal += w0;
    weighted += buf[centerIndex - stride] * w1;
    weightTotal += w1;
    weighted += buf[centerIndex] * w2;
    weightTotal += w2;
    weighted += buf[centerIndex + stride] * w3;
    weightTotal += w3;
    weighted += buf[centerIndex + 2 * stride] * w4;
    weightTotal += w4;
    return weightTotal > 0 ? weighted / weightTotal : Number.NaN;
  };
  let current = values;
  let currentAllFinite = maskAllFinite;
  const horizontal = new Float32Array(cellCount);
  for (let pass = 0; pass < passes; pass += 1) {
    const fastHorizontal = maskAllFinite && currentAllFinite && radius === 2;
    let horizontalAllFinite = true;
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = rowOffset + x;
        let smoothed;
        if (fastHorizontal && x >= 2 && x <= width - 3) {
          smoothed = interior5(current, index, 1);
        } else if (Number.isFinite(values[index])) {
          smoothed = sampleInline(current, index, 1, x, width);
        } else {
          smoothed = Number.NaN;
        }
        horizontal[index] = smoothed;
        if (smoothed !== smoothed || smoothed === Number.POSITIVE_INFINITY || smoothed === Number.NEGATIVE_INFINITY) {
          horizontalAllFinite = false;
        }
      }
    }
    const out = current === values ? new Float32Array(cellCount) : current;
    const fastVertical = maskAllFinite && horizontalAllFinite && radius === 2;
    let outAllFinite = true;
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      const fastRow = fastVertical && y >= 2 && y <= height - 3;
      for (let x = 0; x < width; x += 1) {
        const index = rowOffset + x;
        let result;
        if (fastRow) {
          const smoothed = interior5(horizontal, index, width);
          result = Number.isFinite(smoothed) ? Math.max(0, smoothed) : Number.NaN;
        } else if (Number.isFinite(values[index])) {
          const smoothed = sampleInline(horizontal, index, width, y, height);
          result = Number.isFinite(smoothed) ? Math.max(0, smoothed) : Number.NaN;
        } else {
          result = Number.NaN;
        }
        out[index] = result;
        if (result !== result) {
          outAllFinite = false;
        }
      }
    }
    current = out;
    currentAllFinite = outAllFinite;
  }
  return current;
}

function buildGrid(width, height, mode, rand) {
  const grid = new Float32Array(width * height);
  for (let i = 0; i < grid.length; i += 1) {
    if (mode === "allFinite") {
      grid[i] = rand() * 30;
    } else if (mode === "oceanNaN") {
      const row = Math.floor(i / width);
      grid[i] = row < height / 5 || i % width < width / 8 ? NaN : rand() * 20;
    } else if (mode === "sparseNaN") {
      grid[i] = rand() < 0.03 ? NaN : rand() * 10;
    } else if (mode === "withInf") {
      const r = rand();
      grid[i] = r < 0.002 ? Infinity : r < 0.004 ? 3.5e38 : rand() * 5;
    } else {
      grid[i] = rand() < 0.5 ? 0 : rand() * 2;
    }
  }
  return grid;
}

function assertSameBits(actual, expected, label) {
  assert.strictEqual(actual.length, expected.length, label);
  const a = new Uint32Array(actual.buffer, actual.byteOffset, actual.length);
  const b = new Uint32Array(expected.buffer, expected.byteOffset, expected.length);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      assert.fail(`${label}: first bit mismatch at cell ${i}: actual=${actual[i]} expected=${expected[i]}`);
    }
  }
}

test("wasm smoothing port is present under the default variant", () => {
  const kernel = getParcelKernel();
  assert.ok(kernel?.smooth, "kernel.smooth port missing — exactness tests would be vacuous");
});

// Shared parity corpus for the kernel spec and the forced-JS-fallback spec:
// mixed interior/edge geometries, finiteness regimes, and multi-pass counts
// (multi-pass exercises the JS path's output-buffer aliasing; repeated sizes
// exercise its shared per-length scratch across calls).
function parityCaseMatrix() {
  const cases = [];
  for (const [width, height] of [
    [160, 98],
    [161, 97],
    [1600, 98],
    [7, 5],
    [5, 7],
    [4, 4], // narrower than the kernel: edge/sample path everywhere
  ]) {
    for (const mode of ["allFinite", "oceanNaN", "sparseNaN", "withInf", "zeros"]) {
      for (const passes of [1, 2, 4]) {
        cases.push([width, height, mode, passes]);
      }
    }
  }
  return cases;
}

test("smoothing: kernel output is bit-identical to the JS reference", () => {
  const rand = mulberry32(0xe001);
  // Engagement spy: a silent fallback to the JS loop would make this a
  // vacuous JS-vs-JS comparison.
  const port = getParcelKernel().smooth;
  const originalRun = port.run;
  let runCalls = 0;
  port.run = (...args) => {
    runCalls += 1;
    return originalRun(...args);
  };
  try {
    const cases = parityCaseMatrix();
    for (const [width, height, mode, passes] of cases) {
      const grid = buildGrid(width, height, mode, rand);
      const original = grid.slice();
      const actual = smoothFiniteNonnegativeGrid(grid, width, height, passes);
      const expected = referenceSmooth(original.slice(), width, height, passes);
      assertSameBits(actual, expected, `${width}x${height} ${mode} passes=${passes}`);
      assertSameBits(grid, original, `${width}x${height} ${mode} passes=${passes}: input mutated`);
    }
    assert.strictEqual(runCalls, cases.length, "kernel smoothing did not engage for every case");
  } finally {
    port.run = originalRun;
  }
});

test("smoothing: JS fallback loops are bit-identical to the reference when the kernel port is absent", () => {
  // The JS loops in grid-ops.js (shared per-length scratch, explicit NaN
  // writes instead of prefills, cross-pass buffer aliasing) are the
  // authoritative fallback, but on a kernel-enabled checkout no other spec
  // executes them. Detaching the port from the memoized kernel object
  // forces smoothFiniteNonnegativeGrid's routing gate to the JS loops.
  const rand = mulberry32(0xe003);
  const kernel = getParcelKernel();
  assert.ok(kernel?.smooth, "precondition: kernel port present (this spec detaches it temporarily)");
  const port = kernel.smooth;
  const originalRun = port.run;
  let kernelRuns = 0;
  // ENGAGEMENT (negative spy): if any cached reference to the detached port
  // still computed a case, the JS loops were not exercised.
  port.run = (...args) => {
    kernelRuns += 1;
    return originalRun(...args);
  };
  kernel.smooth = null;
  try {
    for (const [width, height, mode, passes] of parityCaseMatrix()) {
      const grid = buildGrid(width, height, mode, rand);
      const original = grid.slice();
      const actual = smoothFiniteNonnegativeGrid(grid, width, height, passes);
      const expected = referenceSmooth(original.slice(), width, height, passes);
      assert.ok(actual instanceof Float32Array, `js ${width}x${height} ${mode} passes=${passes}: no output`);
      assert.notStrictEqual(actual, grid, `js ${width}x${height} ${mode} passes=${passes}: output aliases the input`);
      assertSameBits(actual, expected, `js ${width}x${height} ${mode} passes=${passes}`);
      assertSameBits(grid, original, `js ${width}x${height} ${mode} passes=${passes}: input mutated`);
    }
    assert.strictEqual(kernelRuns, 0, "kernel port ran while detached — the JS loops were not exercised");
  } finally {
    port.run = originalRun;
    kernel.smooth = port;
  }
});

test("smoothing: full render-grid size runs through the kernel and matches", () => {
  const rand = mulberry32(0xe002);
  const width = 1600;
  const height = 980;
  const port = getParcelKernel().smooth;
  const originalRun = port.run;
  let runCalls = 0;
  port.run = (...args) => {
    runCalls += 1;
    return originalRun(...args);
  };
  let actual;
  const grid = buildGrid(width, height, "oceanNaN", rand);
  try {
    actual = smoothFiniteNonnegativeGrid(grid, width, height, 2);
  } finally {
    port.run = originalRun;
  }
  assert.strictEqual(runCalls, 1, "kernel smoothing did not engage at full grid size");
  const expected = referenceSmooth(grid.slice(), width, height, 2);
  assertSameBits(actual, expected, "1600x980 oceanNaN passes=2");
});
