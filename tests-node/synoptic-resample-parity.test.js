"use strict";

// Byte-exactness contract for the resampleGridBilinear NaN-prefill removal
// (backlog #19, 2026-07-18): the bilinear resample loop assigns every target
// cell unconditionally (sampleGridBilinear returns NaN when no tap is
// usable), so the blanket Float32Array.fill(Number.NaN) was redundant. The
// reference below is the pre-change implementation copied verbatim (prefill
// included); outputs must match the shipped function bit for bit over NaN
// edges/holes, -0, zeros, infinities, and clamp degenerates.

const test = require("node:test");
const assert = require("node:assert");

const { _testResampleGridBilinear: resampleGridBilinear } = require("../scripts/lib/synoptic-render");

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

function assertSameBits(actual, expected, label) {
  assert.ok(actual, `${label}: actual is null`);
  assert.ok(expected, `${label}: expected is null`);
  assert.strictEqual(actual.length, expected.length, `${label}: length`);
  const a = new Uint32Array(actual.buffer, actual.byteOffset, actual.length);
  const b = new Uint32Array(expected.buffer, expected.byteOffset, expected.length);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      assert.fail(`${label}: first bit mismatch at cell ${i}: actual=${actual[i]} expected=${expected[i]}`);
    }
  }
}

// --- Pre-change reference (5243c79), verbatim including the NaN prefill ---

function clampInt(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Number.isFinite(fallback) ? Number(fallback) : min;
  }
  const rounded = Math.round(numeric);
  return Math.max(min, Math.min(max, rounded));
}

function referenceSampleGridBilinear(values, cols, x0, x1, y0, y1, tx, ty) {
  const i00 = y0 * cols + x0;
  const i10 = y0 * cols + x1;
  const i01 = y1 * cols + x0;
  const i11 = y1 * cols + x1;
  const v00 = Number(values[i00]);
  const v10 = Number(values[i10]);
  const v01 = Number(values[i01]);
  const v11 = Number(values[i11]);
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  let sum = 0;
  let weight = 0;
  if (Number.isFinite(v00)) {
    sum += v00 * w00;
    weight += w00;
  }
  if (Number.isFinite(v10)) {
    sum += v10 * w10;
    weight += w10;
  }
  if (Number.isFinite(v01)) {
    sum += v01 * w01;
    weight += w01;
  }
  if (Number.isFinite(v11)) {
    sum += v11 * w11;
    weight += w11;
  }
  return weight > 0 ? sum / weight : Number.NaN;
}

function referenceResampleGridBilinear(grid, outCols, outRows) {
  if (!grid || !grid.values) {
    return null;
  }
  const srcCols = Number(grid.cols);
  const srcRows = Number(grid.rows);
  const targetCols = clampInt(outCols, 2, 4096, srcCols);
  const targetRows = clampInt(outRows, 2, 4096, srcRows);
  if (!Number.isFinite(srcCols) || !Number.isFinite(srcRows) || srcCols < 2 || srcRows < 2) {
    return null;
  }
  if (targetCols === srcCols && targetRows === srcRows) {
    return {
      rows: srcRows,
      cols: srcCols,
      values: grid.values,
    };
  }

  const out = new Float32Array(targetRows * targetCols).fill(Number.NaN);
  for (let y = 0; y < targetRows; y += 1) {
    const gy = (y / Math.max(1, targetRows - 1)) * (srcRows - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(srcRows - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < targetCols; x += 1) {
      const gx = (x / Math.max(1, targetCols - 1)) * (srcCols - 1);
      const x0 = Math.floor(gx);
      const x1 = Math.min(srcCols - 1, x0 + 1);
      const tx = gx - x0;
      out[y * targetCols + x] = referenceSampleGridBilinear(grid.values, srcCols, x0, x1, y0, y1, tx, ty);
    }
  }
  return {
    rows: targetRows,
    cols: targetCols,
    values: out,
  };
}

// --- Parity cases ---

test("resample matches the prefill reference over NaN edges, holes, -0, and zeros", () => {
  const srcCols = 24;
  const srcRows = 18;
  const values = new Float32Array(srcCols * srcRows);
  const rand = mulberry32(0x5eed);
  for (let i = 0; i < values.length; i += 1) {
    const r = rand();
    if (r < 0.2) {
      values[i] = Number.NaN;
    } else if (r < 0.25) {
      values[i] = -0;
    } else if (r < 0.3) {
      values[i] = 0;
    } else {
      values[i] = 900 + rand() * 200;
    }
  }
  // Force structured NaN edges and an interior hole.
  for (let x = 0; x < srcCols; x += 1) {
    values[x] = Number.NaN;
    values[(srcRows - 1) * srcCols + x] = Number.NaN;
  }
  for (let y = 0; y < srcRows; y += 1) {
    values[y * srcCols] = Number.NaN;
    values[y * srcCols + srcCols - 1] = Number.NaN;
  }
  for (let y = 7; y < 11; y += 1) {
    for (let x = 9; x < 14; x += 1) {
      values[y * srcCols + x] = Number.NaN;
    }
  }
  const grid = { cols: srcCols, rows: srcRows, values };
  for (const [outCols, outRows] of [
    [12, 9],
    [48, 36],
    [17, 13],
    [2, 2],
    [4097, 4097],
  ]) {
    const actual = resampleGridBilinear(grid, outCols, outRows);
    const expected = referenceResampleGridBilinear(grid, outCols, outRows);
    assert.strictEqual(actual.cols, expected.cols, `${outCols}x${outRows} cols`);
    assert.strictEqual(actual.rows, expected.rows, `${outCols}x${outRows} rows`);
    assertSameBits(actual.values, expected.values, `${outCols}x${outRows}`);
  }
});

test("resample all-NaN and infinite-tap sources match the prefill reference", () => {
  const srcCols = 9;
  const srcRows = 7;
  const allNaN = { cols: srcCols, rows: srcRows, values: new Float32Array(srcCols * srcRows).fill(Number.NaN) };
  assertSameBits(
    resampleGridBilinear(allNaN, 5, 4).values,
    referenceResampleGridBilinear(allNaN, 5, 4).values,
    "all-NaN source",
  );
  const withInf = new Float32Array(srcCols * srcRows);
  const rand = mulberry32(0x1eaf);
  for (let i = 0; i < withInf.length; i += 1) {
    const r = rand();
    withInf[i] = r < 0.1 ? Infinity : r < 0.15 ? -Infinity : 1000 + rand() * 50;
  }
  const infGrid = { cols: srcCols, rows: srcRows, values: withInf };
  assertSameBits(
    resampleGridBilinear(infGrid, 6, 5).values,
    referenceResampleGridBilinear(infGrid, 6, 5).values,
    "infinite taps",
  );
});

test("resample same-size passthrough and degenerate inputs are unchanged", () => {
  const values = new Float32Array(12).map((_, i) => i * 1.5);
  const grid = { cols: 4, rows: 3, values };
  const passthrough = resampleGridBilinear(grid, 4, 3);
  assert.strictEqual(passthrough.values, values, "same-size must return the source array untouched");
  assert.strictEqual(resampleGridBilinear(null, 4, 3), null);
  assert.strictEqual(resampleGridBilinear({}, 4, 3), null);
  assert.strictEqual(resampleGridBilinear({ cols: 1, rows: 3, values }, 4, 3), null);
  assert.strictEqual(resampleGridBilinear({ cols: Number.NaN, rows: 3, values }, 4, 3), null);
});

test("resample fuzz: randomized grids and sizes match the prefill reference bit for bit", () => {
  const rand = mulberry32(0xabcd1234);
  for (let trial = 0; trial < 300; trial += 1) {
    const srcCols = 2 + Math.floor(rand() * 30);
    const srcRows = 2 + Math.floor(rand() * 30);
    const values = new Float32Array(srcCols * srcRows);
    for (let i = 0; i < values.length; i += 1) {
      const r = rand();
      if (r < 0.25) {
        values[i] = Number.NaN;
      } else if (r < 0.3) {
        values[i] = -0;
      } else if (r < 0.35) {
        values[i] = 0;
      } else if (r < 0.37) {
        values[i] = rand() < 0.5 ? Infinity : -Infinity;
      } else {
        values[i] = (rand() - 0.5) * 2000;
      }
    }
    const grid = { cols: srcCols, rows: srcRows, values };
    const outCols = 1 + Math.floor(rand() * 60);
    const outRows = 1 + Math.floor(rand() * 60);
    const actual = resampleGridBilinear(grid, outCols, outRows);
    const expected = referenceResampleGridBilinear(grid, outCols, outRows);
    assert.strictEqual(Boolean(actual), Boolean(expected), `trial ${trial}: null mismatch`);
    if (actual && actual.values !== values) {
      assert.strictEqual(actual.cols, expected.cols, `trial ${trial} cols`);
      assert.strictEqual(actual.rows, expected.rows, `trial ${trial} rows`);
      assertSameBits(actual.values, expected.values, `trial ${trial}`);
    }
  }
});
