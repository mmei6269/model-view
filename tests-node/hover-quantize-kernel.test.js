"use strict";

// Byte-exactness contract for the wasm hover quantizer + delta encoder
// (kernel Stage D, 2026-07-12). Unlike the parcel/DCAPE fuzz suites these
// assert EXACT equality: the ports run the identical f64 arithmetic the JS
// loops run, so any deviation at all is a defect, not a tolerance question.

const test = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");

const {
  quantizeHoverGridVariable,
  quantizeHoverWindGridVariable,
  quantizeHoverRawValues,
  quantizeHoverAffineValues,
  HOVER_GRID_MISSING_VALUE,
} = require("../scripts/lib/noaa-beta/hover");
const { buildAffineTransformState } = require("../scripts/lib/noaa-beta/raster");
const { getParcelKernel } = require("../scripts/lib/noaa-beta/parcel-kernel");
const { encodeHoverGridBinaryPayload, decodeHoverGridPayload } = require("../scripts/lib/hover-grid-binary");

// Deterministic PRNG (mulberry32) so failures reproduce.
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

// Grid generator exercising every block class the kernel distinguishes:
// long all-finite runs, long all-NaN (ocean) runs, mixed blocks, exact
// half-integer products, clamp-scale magnitudes, and ±inf.
function buildFuzzGrid(length, rand) {
  const values = new Float32Array(length);
  let index = 0;
  while (index < length) {
    const mode = rand();
    const runLength = Math.min(length - index, 1 + Math.floor(rand() * 97));
    if (mode < 0.35) {
      for (let i = 0; i < runLength; i += 1, index += 1) {
        values[index] = (rand() - 0.5) * 2000;
      }
    } else if (mode < 0.55) {
      for (let i = 0; i < runLength; i += 1, index += 1) {
        values[index] = Number.NaN;
      }
    } else if (mode < 0.7) {
      for (let i = 0; i < runLength; i += 1, index += 1) {
        // exact half-integer ties under multiplier 1 / 10 / 20
        values[index] = (Math.floor(rand() * 200) - 100) / 2;
      }
    } else if (mode < 0.85) {
      for (let i = 0; i < runLength; i += 1, index += 1) {
        const r = rand();
        values[index] = r < 0.1 ? Number.POSITIVE_INFINITY : r < 0.2 ? Number.NEGATIVE_INFINITY : (rand() - 0.5) * 1e5;
      }
    } else {
      for (let i = 0; i < runLength; i += 1, index += 1) {
        values[index] = rand() < 0.5 ? Number.NaN : (rand() - 0.5) * 8e4;
      }
    }
  }
  return values;
}

const kernel = getParcelKernel();

// Engagement spies: a silent fallback to the JS loops would make the
// byte-equality assertions vacuous JS-vs-JS comparisons, so every fuzz
// test asserts its kernel entry points were actually invoked.
const spyCounts = { raw: 0, affine: 0, wind: 0, delta: 0 };
if (kernel?.quantize) {
  for (const key of ["raw", "affine", "wind"]) {
    const original = kernel.quantize[key];
    kernel.quantize[key] = (...args) => {
      spyCounts[key] += 1;
      return original(...args);
    };
  }
}
if (kernel?.delta) {
  const originalEncode = kernel.delta.encode;
  kernel.delta.encode = (...args) => {
    spyCounts.delta += 1;
    return originalEncode(...args);
  };
}

test("wasm quantize kernel is present under the default variant", () => {
  assert.ok(kernel, "parcel kernel should load in the test environment");
  assert.ok(kernel.quantize, "kernel.quantize port missing — exactness tests would be vacuous");
  assert.ok(kernel.delta, "kernel.delta port missing — exactness tests would be vacuous");
});

test("raw quantize: kernel output is byte-identical to the JS loop (fuzz)", () => {
  const rand = mulberry32(0xd001);
  for (const scale of [0.05, 0.1, 0.01, 0.001, 1, 5]) {
    for (const length of [200_003, 32_768, 32_769, 7, 8]) {
      const values = buildFuzzGrid(length, rand);
      const actual = quantizeHoverGridVariable(values, scale, length);
      const expectedEncoded = new Int16Array(length);
      const expectedStats = { clampCount: 0, nonFiniteCount: 0 };
      const expectedValid = quantizeHoverRawValues(expectedEncoded, values, length, 1 / scale, expectedStats);
      assert.deepStrictEqual(actual.values, expectedEncoded, `raw scale=${scale} length=${length}`);
      assert.strictEqual(actual.validCount, expectedValid);
      assert.strictEqual(actual.clampCount, expectedStats.clampCount);
      assert.strictEqual(actual.nonFiniteCount, expectedStats.nonFiniteCount);
    }
  }
  assert.ok(spyCounts.raw > 0, "kernel raw quantizer did not engage");
});

test("affine quantize: kernel output is byte-identical to the JS loop (fuzz)", () => {
  const rand = mulberry32(0xd002);
  const transforms = [
    { transformScale: 0.03937007874015748, transformMin: 0 },
    { transformScale: 1.8, transformOffset: -459.67 },
    { transformScale: -2.5, transformOffset: 10, transformMin: -100 },
    { transformScale: 3600 * 0.03937007874015748, transformMin: 0 },
  ];
  for (const transformValue of transforms) {
    for (const length of [200_003, 32_768, 15]) {
      const values = buildFuzzGrid(length, rand);
      const actual = quantizeHoverGridVariable(values, 0.01, length, transformValue);
      const expectedEncoded = new Int16Array(length);
      const expectedStats = { clampCount: 0, nonFiniteCount: 0 };
      const affineState = buildAffineTransformState(
        transformValue.transformScale,
        transformValue.transformOffset,
        transformValue.transformMin,
      );
      const expectedValid = quantizeHoverAffineValues(expectedEncoded, values, length, 100, affineState, expectedStats);
      assert.deepStrictEqual(
        actual.values,
        expectedEncoded,
        `affine ${JSON.stringify(transformValue)} length=${length}`,
      );
      assert.strictEqual(actual.validCount, expectedValid);
      assert.strictEqual(actual.clampCount, expectedStats.clampCount);
      assert.strictEqual(actual.nonFiniteCount, expectedStats.nonFiniteCount);
    }
  }
  assert.ok(spyCounts.affine > 0, "kernel affine quantizer did not engage");
});

test("wind quantize: kernel output is byte-identical to the JS loop (fuzz)", () => {
  const rand = mulberry32(0xd003);
  const MPS_TO_MPH = 2.2369362920544025;
  for (const length of [200_003, 32_768, 9]) {
    const uValues = buildFuzzGrid(length, rand);
    const vValues = buildFuzzGrid(length, rand);
    const actual = quantizeHoverWindGridVariable({
      uValues,
      vValues,
      multiplier: MPS_TO_MPH,
      scale: 0.1,
      cellCount: length,
    });
    // Reference: the JS loop semantics (missing on either non-finite
    // component; NO post-compute finite gate — overflow clamps as valid).
    const expected = new Int16Array(length);
    let expectedValid = 0;
    let expectedClamp = 0;
    let expectedNonFinite = 0;
    for (let i = 0; i < length; i += 1) {
      const u = uValues[i];
      const v = vValues[i];
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        expected[i] = HOVER_GRID_MISSING_VALUE;
        expectedNonFinite += 1;
        continue;
      }
      const value = Math.sqrt(u * u + v * v) * MPS_TO_MPH;
      const quantized = Math.floor(value * 10 + 0.5);
      if (quantized < -32767 || quantized > 32767) expectedClamp += 1;
      expected[i] = quantized < -32767 ? -32767 : quantized > 32767 ? 32767 : quantized;
      expectedValid += 1;
    }
    assert.deepStrictEqual(actual.values, expected, `wind length=${length}`);
    assert.strictEqual(actual.validCount, expectedValid);
    assert.strictEqual(actual.clampCount, expectedClamp);
    assert.strictEqual(actual.nonFiniteCount, expectedNonFinite);
  }
  assert.ok(spyCounts.wind > 0, "kernel wind quantizer did not engage");
});

test("v3 delta encode through the kernel matches the pure-JS delta byte for byte", () => {
  const rand = mulberry32(0xd004);
  // Multi-variable payload sized to cross the 65536-value delta chunk with
  // an odd tail, including wrap-heavy values near the i16 limits.
  const variables = {};
  const originals = [];
  const lengths = [70_001, 40_000, 33];
  for (let v = 0; v < lengths.length; v += 1) {
    const values = new Int16Array(lengths[v]);
    for (let i = 0; i < values.length; i += 1) {
      const r = rand();
      values[i] = r < 0.05 ? -32768 : r < 0.1 ? 32767 : r < 0.15 ? -32767 : Math.floor((rand() - 0.5) * 65534);
    }
    variables[`var${v}`] = { scale: 1, offset: 0, missing: -32768, values };
    originals.push(values);
  }
  const body = encodeHoverGridBinaryPayload({ schemaVersion: 3, rows: 1, cols: 1, variables, gzipLevel: 1 });
  const raw = zlib.gunzipSync(body);
  const headerLength = raw.readUInt32LE(4);
  const dataStart = 8 + headerLength;
  const encoded = new Int16Array(raw.buffer, raw.byteOffset + dataStart, (raw.length - dataStart) >> 1);
  // Reference delta over the concatenated originals.
  const concat = new Int16Array(encoded.length);
  let cursor = 0;
  for (const values of originals) {
    concat.set(values, cursor);
    cursor += values.length;
  }
  const expected = new Int16Array(concat.length);
  let previous = 0;
  for (let i = 0; i < concat.length; i += 1) {
    expected[i] = concat[i] - previous;
    previous = concat[i];
  }
  assert.deepStrictEqual(Array.from(encoded), Array.from(expected));
  // And the full roundtrip restores the exact originals.
  const decoded = decodeHoverGridPayload(body);
  for (let v = 0; v < lengths.length; v += 1) {
    assert.deepStrictEqual(decoded.variables[`var${v}`].values, originals[v]);
  }
  assert.ok(spyCounts.delta > 0, "kernel delta encoder did not engage");
});
