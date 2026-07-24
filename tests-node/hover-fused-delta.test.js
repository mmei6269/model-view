"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  buildHoverGridBinaryRaw,
  decodeHoverGridPayload,
  encodeHoverGridJsonPayload,
} = require("../scripts/lib/hover-grid-binary");
const {
  buildHoverGridArtifact,
  buildHoverGridVariables,
  quantizeHoverGridVariable,
  quantizeHoverWindGridVariable,
} = require("../scripts/lib/noaa-beta/hover");
const { CompressPool, createCompressor } = require("../scripts/lib/noaa-beta/compress-pool");
const { getParcelKernel } = require("../scripts/lib/noaa-beta/parcel-kernel");
const { HOVER_GRID_ENCODINGS } = require("../scripts/lib/hover-grid-encoding");

function buildGrid(length, phase = 0) {
  const values = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    if ((index + phase) % 97 === 0) {
      values[index] = Number.NaN;
    } else if ((index + phase) % 4093 === 0) {
      values[index] = index & 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    } else if ((index + phase) % 8179 === 0) {
      values[index] = index & 1 ? 100_000 : -100_000;
    } else {
      values[index] = Math.sin((index + phase) * 0.013) * 73.25 + Math.cos(index * 0.003) * 11.5;
    }
  }
  return values;
}

test("fused hover quantize/delta produces the exact global schema-v3 byte stream", () => {
  const kernel = getParcelKernel();
  assert.equal(typeof kernel?.quantize?.deltaOutput, "function", "fused quantize delta export is unavailable");

  const sourceLength = 65_541;
  const cellCount = sourceLength + 5;
  const source = buildGrid(sourceLength);
  const windV = buildGrid(sourceLength, 31);
  const functionSource = Float64Array.from(source);
  const affine = { transformScale: 9 / 5, transformOffset: -459.67 };
  const functionTransform = (value) => value * 0.125 - 7;

  let fusedCalls = 0;
  let fallbackDeltaCalls = 0;
  const originalDeltaOutput = kernel.quantize.deltaOutput;
  const originalRegionDelta = kernel.delta.encode;
  kernel.quantize.deltaOutput = (...args) => {
    fusedCalls += 1;
    return originalDeltaOutput(...args);
  };
  kernel.delta.encode = (...args) => {
    fallbackDeltaCalls += 1;
    return originalRegionDelta(...args);
  };
  let absolute;
  let fused;
  try {
    absolute = {
      raw: quantizeHoverGridVariable(source, 0.05, cellCount),
      affine: quantizeHoverGridVariable(source, 0.05, cellCount, affine),
      function: quantizeHoverGridVariable(functionSource, 0.1, cellCount, functionTransform),
      wind: quantizeHoverWindGridVariable({
        uValues: source,
        vValues: windV,
        multiplier: 1.943844,
        scale: 0.1,
        cellCount,
      }),
    };
    fused = {
      raw: quantizeHoverGridVariable(source, 0.05, cellCount, null, { deltaEncode: true }),
      affine: quantizeHoverGridVariable(source, 0.05, cellCount, affine, { deltaEncode: true }),
      function: quantizeHoverGridVariable(functionSource, 0.1, cellCount, functionTransform, {
        deltaEncode: true,
      }),
      wind: quantizeHoverWindGridVariable({
        uValues: source,
        vValues: windV,
        multiplier: 1.943844,
        scale: 0.1,
        cellCount,
        deltaEncode: true,
      }),
    };
  } finally {
    kernel.quantize.deltaOutput = originalDeltaOutput;
    kernel.delta.encode = originalRegionDelta;
  }

  assert.ok(fusedCalls >= 9, `expected fused raw/affine/wind chunks to engage, observed ${fusedCalls}`);
  assert.ok(
    fallbackDeltaCalls >= 2,
    `expected function-transform delta chunks to engage, observed ${fallbackDeltaCalls}`,
  );
  for (const variable of Object.values(fused)) {
    assert.equal(variable.deltaEncoded, true);
    assert.ok(Number.isInteger(variable.deltaEndValue));
  }

  const payload = { schemaVersion: 3, rows: 1, cols: cellCount };
  const absoluteRaw = buildHoverGridBinaryRaw({ ...payload, variables: absolute });
  const fusedRaw = buildHoverGridBinaryRaw({ ...payload, variables: fused });
  assert.deepEqual(fusedRaw, absoluteRaw);
});

test("empty quantized variables remain unmarked and production orchestration omits them", () => {
  const empty = quantizeHoverGridVariable(new Float32Array(0), 0.1, 1, null, { deltaEncode: true });
  assert.equal(empty.values.length, 0);
  assert.equal(empty.validCount, 0);
  assert.equal(empty.deltaEncoded, undefined);

  const variables = buildHoverGridVariables({
    decoded: { rawProbe: new Float32Array(0) },
    selection: {
      availableParameters: ["rawProbe"],
      catalog: [{ key: "rawProbe", inputKey: "rawProbe", unit: "C", transform: "identity" }],
    },
    pressureHpa: new Float32Array(0),
    width: 1,
    height: 1,
    preDeltaEncode: true,
  });
  assert.deepEqual(variables, {});
});

test("pre-delta packing rejects mixed modes, invalid carries, and pre-v3 containers", () => {
  const source = new Float32Array([1, 2, 3, 4]);
  const absolute = quantizeHoverGridVariable(source, 0.1, source.length);
  const fused = quantizeHoverGridVariable(source, 0.1, source.length, null, { deltaEncode: true });

  assert.throws(
    () =>
      buildHoverGridBinaryRaw({
        schemaVersion: 3,
        rows: 1,
        cols: source.length,
        variables: { absolute, fused },
      }),
    /cannot mix absolute and pre-delta/,
  );
  assert.throws(
    () =>
      buildHoverGridBinaryRaw({
        schemaVersion: 2,
        rows: 1,
        cols: source.length,
        variables: { fused },
      }),
    /require schema version 3/,
  );
  assert.throws(
    () =>
      buildHoverGridBinaryRaw({
        schemaVersion: 3,
        rows: 1,
        cols: source.length,
        variables: { fused: { ...fused, deltaEndValue: 40_000 } },
      }),
    /missing a valid signed Int16 end value/,
  );
  assert.throws(
    () => encodeHoverGridJsonPayload({ schemaVersion: 3, rows: 1, cols: source.length, variables: { fused } }),
    /require the binary schema-v3 container/,
  );
  assert.throws(
    () => buildHoverGridArtifact({ width: source.length, height: 1, variables: { fused }, format: "json" }),
    /require the binary schema-v3 container/,
  );
});

test("fused delta export clamps oversized calls to the quantized-output allocation", () => {
  const quantize = getParcelKernel()?.quantize;
  assert.equal(typeof quantize?.deltaOutput, "function");

  const originalOutput = new Int16Array(quantize.out);
  const originalStats = new Int32Array(quantize.stats);
  const previous = -12345;
  const absolute = new Int16Array(quantize.chunk);
  for (let index = 0; index < absolute.length; index += 1) {
    absolute[index] = ((index * 1543 + 97) & 0xffff) - 32768;
  }
  const expected = new Int16Array(absolute);
  let carry = previous;
  for (let index = 0; index < expected.length; index += 1) {
    const value = expected[index];
    expected[index] = value - carry;
    carry = value;
  }

  try {
    quantize.out.set(absolute);
    quantize.stats.set([0x13579, -0x2468, 0x3579]);
    const actualCarry = quantize.deltaOutput(quantize.chunk + 64, previous);
    assert.equal(actualCarry, carry);
    assert.deepEqual(quantize.out, expected);
    assert.deepEqual(Array.from(quantize.stats), [0x13579, -0x2468, 0x3579]);
  } finally {
    quantize.out.set(originalOutput);
    quantize.stats.set(originalStats);
  }
});

test("compression worker receives the exact legacy raw stream from fused variables", async () => {
  const cellCount = 32_773;
  const source = buildGrid(cellCount);
  const absolute = quantizeHoverGridVariable(source, 0.05, cellCount);
  const fused = quantizeHoverGridVariable(source, 0.05, cellCount, null, { deltaEncode: true });
  const compression = { backend: "brotli", brotliQuality: 0 };
  const inline = buildHoverGridArtifact({
    width: cellCount,
    height: 1,
    variables: { probe: absolute },
    format: "binary",
    compression,
    encoding: HOVER_GRID_ENCODINGS.mvh3,
  });
  const pool = new CompressPool(1);
  const counters = { jobs: 0, fallbacks: 0 };
  try {
    const pooled = buildHoverGridArtifact({
      width: cellCount,
      height: 1,
      variables: { probe: fused },
      format: "binary",
      compression,
      encoding: HOVER_GRID_ENCODINGS.mvh3,
      compress: createCompressor(pool, counters),
    });
    await pooled.pending;
    assert.deepEqual(pooled.body, inline.body);
    assert.deepEqual(pooled.diagnostics, inline.diagnostics);
    assert.equal(counters.jobs, 1);
    assert.equal(counters.fallbacks, 0);
  } finally {
    pool.markDead(new Error("test done"));
  }
});

test("production hover-variable orchestration opts every retained binary plane into fusion", () => {
  const width = 17;
  const height = 3;
  const cellCount = width * height;
  const raw = buildGrid(cellCount);
  const temperatureK = Float32Array.from(raw, (value) => (Number.isFinite(value) ? value + 273.15 : value));
  const windV = buildGrid(cellCount, 7);
  const pressureHpa = Float32Array.from(raw, (value) => (Number.isFinite(value) ? value + 1000 : value));
  const selection = {
    availableParameters: ["rawProbe", "affineProbe", "windProbe"],
    catalog: [
      { key: "rawProbe", inputKey: "raw", unit: "C", transform: "identity" },
      { key: "affineProbe", inputKey: "temperatureK", unit: "F", transform: "kelvinToFahrenheit" },
      { key: "windProbe", kind: "wind", uKey: "raw", vKey: "windV", unit: "kt", transform: "windKt" },
    ],
  };
  const options = {
    decoded: { raw, temperatureK, windV },
    selection,
    pressureHpa,
    width,
    height,
  };
  const absolute = buildHoverGridVariables(options);
  const fused = buildHoverGridVariables({ ...options, preDeltaEncode: true });

  assert.deepEqual(Object.keys(fused), ["rawProbe", "affineProbe", "windProbe", "pressureHpa"]);
  for (const variable of Object.values(fused)) {
    assert.equal(variable.deltaEncoded, true);
  }
  const payload = { schemaVersion: 3, rows: height, cols: width };
  assert.deepEqual(
    buildHoverGridBinaryRaw({ ...payload, variables: fused }),
    buildHoverGridBinaryRaw({ ...payload, variables: absolute }),
  );
});

test("kernel-disabled production orchestration retains the exact legacy global delta path", () => {
  const childScript = String.raw`
    "use strict";
    const assert = require("node:assert/strict");
    const { buildHoverGridBinaryRaw } = require("./scripts/lib/hover-grid-binary");
    const { buildHoverGridVariables, quantizeHoverGridVariable } = require("./scripts/lib/noaa-beta/hover");

    const source = new Float32Array([NaN, -3276.7, -1.25, 0, 1.25, 3276.7, Infinity, 42]);
    const options = {
      decoded: { raw: source },
      selection: {
        availableParameters: ["rawProbe"],
        catalog: [{ key: "rawProbe", inputKey: "raw", unit: "C", transform: "identity" }],
      },
      pressureHpa: Float32Array.from(source, (value) => Number.isFinite(value) ? value + 1000 : value),
      width: source.length,
      height: 1,
    };
    const absolute = buildHoverGridVariables(options);
    const requested = buildHoverGridVariables({ ...options, preDeltaEncode: true });
    assert.ok(Object.keys(requested).length > 0);
    for (const variable of Object.values(requested)) {
      assert.equal(variable.deltaEncoded, undefined);
      assert.equal(variable.deltaEndValue, undefined);
    }
    const payload = { schemaVersion: 3, rows: 1, cols: source.length };
    assert.deepEqual(
      buildHoverGridBinaryRaw({ ...payload, variables: requested }),
      buildHoverGridBinaryRaw({ ...payload, variables: absolute }),
    );

    const direct = quantizeHoverGridVariable(source, 0.05, source.length, null, { deltaEncode: true });
    assert.equal(direct.deltaEncoded, true);
    assert.ok(Number.isInteger(direct.deltaEndValue));
    process.stdout.write(JSON.stringify({ variableCount: Object.keys(requested).length }));
  `;
  const result = spawnSync(process.execPath, ["-e", childScript], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, MODELVIEW_PARCEL_KERNEL: "js" },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(JSON.parse(result.stdout).variableCount > 0);
});

test("independently fused variable bodies preserve global delta wraparound under fuzz", () => {
  let state = 0x18d37a11;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };

  for (let repetition = 0; repetition < 80; repetition += 1) {
    const absolute = {};
    const fused = {};
    const variableCount = 1 + (random() % 9);
    let totalLength = 0;
    for (let variableIndex = 0; variableIndex < variableCount; variableIndex += 1) {
      const length = random() % 263;
      const values = new Int16Array(length);
      for (let index = 0; index < length; index += 1) {
        const selector = random() % 8;
        values[index] =
          selector === 0 ? -32768 : selector === 1 ? 32767 : selector === 2 ? 0 : (random() & 0xffff) - 32768;
      }
      const deltaValues = new Int16Array(values);
      let previous = 0;
      for (let index = 0; index < deltaValues.length; index += 1) {
        const value = deltaValues[index];
        deltaValues[index] = value - previous;
        previous = value;
      }
      const key = `v${variableIndex}`;
      absolute[key] = { values, scale: 1, offset: 0, missing: -32768 };
      fused[key] = {
        values: deltaValues,
        scale: 1,
        offset: 0,
        missing: -32768,
        deltaEncoded: true,
        deltaEndValue: previous,
      };
      totalLength += length;
    }

    const payload = { schemaVersion: 3, rows: 1, cols: totalLength };
    assert.deepEqual(
      buildHoverGridBinaryRaw({ ...payload, variables: fused }),
      buildHoverGridBinaryRaw({ ...payload, variables: absolute }),
      `fuzz repetition ${repetition}`,
    );
  }
});

test("fused quantization is exact at SIMD tails, chunk boundaries, and synthetic missing tails", () => {
  const lengths = [0, 1, 7, 8, 9, 32_767, 32_768, 32_769];
  for (const sourceLength of lengths) {
    const cellCount = sourceLength + 3;
    const source = buildGrid(sourceLength, 19);
    const absolute = quantizeHoverGridVariable(source, 0.05, cellCount);
    const fused = quantizeHoverGridVariable(source, 0.05, cellCount, null, { deltaEncode: true });
    const payload = { schemaVersion: 3, rows: 1, cols: cellCount };

    if (sourceLength === 0) {
      assert.equal(fused.deltaEncoded, undefined);
      assert.throws(() => buildHoverGridBinaryRaw({ ...payload, variables: { probe: fused } }), /canonical MVH3\/MVH4/);
      assert.throws(
        () => buildHoverGridBinaryRaw({ ...payload, variables: { probe: absolute } }),
        /canonical MVH3\/MVH4/,
      );
      continue;
    }
    assert.deepEqual(
      buildHoverGridBinaryRaw({ ...payload, variables: { probe: fused } }),
      buildHoverGridBinaryRaw({ ...payload, variables: { probe: absolute } }),
      `source length ${sourceLength}`,
    );
    assert.equal(fused.deltaEncoded, true);
    assert.equal(fused.deltaEndValue, -32768, `source length ${sourceLength} missing-tail carry`);
  }
});

test("function transforms and non-Float32 raw/wind fallbacks preserve the exact schema-v3 stream", () => {
  const values = Float64Array.from([
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    -100_000,
    -0,
    0,
    0.049,
    0.05,
    1.25,
    3_276.7,
    100_000,
    Number.POSITIVE_INFINITY,
  ]);
  const windV = Float64Array.from(values, (value, index) =>
    Number.isFinite(value) ? (index & 1 ? -value * 0.25 : value * 0.5) : value,
  );
  const cellCount = values.length + 4;
  const transform = (value) => Math.sin(value) * 2_000 - 17.25;
  const absolute = {
    raw: quantizeHoverGridVariable(values, 0.1, cellCount),
    function: quantizeHoverGridVariable(values, 0.05, cellCount, transform),
    wind: quantizeHoverWindGridVariable({
      uValues: values,
      vValues: windV,
      multiplier: 1.943844,
      scale: 0.1,
      cellCount,
    }),
  };
  const fused = {
    raw: quantizeHoverGridVariable(values, 0.1, cellCount, null, { deltaEncode: true }),
    function: quantizeHoverGridVariable(values, 0.05, cellCount, transform, { deltaEncode: true }),
    wind: quantizeHoverWindGridVariable({
      uValues: values,
      vValues: windV,
      multiplier: 1.943844,
      scale: 0.1,
      cellCount,
      deltaEncode: true,
    }),
  };

  for (const variable of Object.values(fused)) {
    assert.equal(variable.deltaEncoded, true);
    assert.equal(variable.deltaEndValue, -32768);
  }
  const payload = { schemaVersion: 3, rows: 1, cols: cellCount };
  assert.deepEqual(
    buildHoverGridBinaryRaw({ ...payload, variables: fused }),
    buildHoverGridBinaryRaw({ ...payload, variables: absolute }),
  );
});

test("ordinary absolute JSON encoding retains its legacy byte layout and round trip", () => {
  const values = new Int16Array([-32768, -32767, -1, 0, 1, 32767]);
  const variable = { values, scale: 0.25, offset: -11, missing: -32768 };
  const options = {
    schemaVersion: 3,
    rows: 2,
    cols: 3,
    variables: { probe: variable },
    compressionBackend: "gzip",
    gzipLevel: 1,
  };
  const expectedJson = {
    schemaVersion: 3,
    rows: 2,
    cols: 3,
    variables: {
      probe: {
        scale: 0.25,
        offset: -11,
        missing: -32768,
        data: Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64"),
      },
    },
  };

  const encoded = encodeHoverGridJsonPayload(options);
  assert.deepEqual(encoded, zlib.gzipSync(Buffer.from(JSON.stringify(expectedJson)), { level: 1 }));
  const decoded = decodeHoverGridPayload(encoded, { contentEncoding: "gzip" });
  assert.deepEqual(decoded.variables.probe.values, values);
  assert.deepEqual(
    { schemaVersion: decoded.schemaVersion, rows: decoded.rows, cols: decoded.cols },
    { schemaVersion: 3, rows: 2, cols: 3 },
  );
});
