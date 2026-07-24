"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  buildHoverGridBinaryRaw,
  encodeHoverGridBinaryPayload,
  encodeHoverGridJsonPayload,
} = require("../scripts/lib/hover-grid-binary");
const { HOVER_GRID_ENCODINGS } = require("../scripts/lib/hover-grid-encoding");
const {
  buildHoverGridArtifact,
  buildHoverGridVariables,
  hoverGridVariableToJson,
  quantizeHoverGridVariable,
  quantizeHoverWindGridVariable,
} = require("../scripts/lib/noaa-beta/hover");
const { _testBuildRenderedArtifacts: buildRenderedArtifacts } = require("../scripts/lib/noaa-beta-renderer");
const parcelKernel = require("../scripts/lib/noaa-beta/parcel-kernel");
const { buildSnowRenderedArtifacts } = require("../scripts/lib/noaa-beta/winter");

const MVH4 = HOVER_GRID_ENCODINGS.mvh4;
const MVH3 = HOVER_GRID_ENCODINGS.mvh3;

function buildGrid(length, phase = 0) {
  const values = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const selector = (index + phase) % 257;
    values[index] =
      selector === 0
        ? Number.NaN
        : selector === 1
          ? Number.POSITIVE_INFINITY
          : selector === 2
            ? Number.NEGATIVE_INFINITY
            : selector === 3
              ? 100_000
              : selector === 4
                ? -100_000
                : selector === 5
                  ? 32767
                  : selector === 6
                    ? -32767
                    : Math.fround(Math.sin((index + phase) * 0.017) * 211.75 + Math.cos(index * 0.003) * 19.5);
  }
  return values;
}

function payload(rows, cols, variables) {
  return { schemaVersion: 4, encoding: MVH4, rows, cols, variables };
}

function quantizationSummary(variable) {
  return {
    scale: variable.scale,
    offset: variable.offset,
    missing: variable.missing,
    validCount: variable.validCount,
    clampCount: variable.clampCount,
    nonFiniteCount: variable.nonFiniteCount,
  };
}

function assertFusedRawMatchesAbsolute({ rows, cols, absolute, fused, label }) {
  assert.equal(fused.predictorEncoded, "gradient2d", `${label}: fused marker`);
  assert.deepEqual(quantizationSummary(fused), quantizationSummary(absolute), `${label}: diagnostics`);
  assert.deepEqual(
    buildHoverGridBinaryRaw(payload(rows, cols, { probe: fused })),
    buildHoverGridBinaryRaw(payload(rows, cols, { probe: absolute })),
    `${label}: MVH4 raw bytes`,
  );
}

function gradientOracle(input, rows, cols) {
  const absolute = Int16Array.from(input);
  assert.equal(absolute.length, rows * cols);
  const encoded = new Int16Array(absolute.length);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      const predictor =
        row === 0
          ? col === 0
            ? 0
            : absolute[index - 1]
          : col === 0
            ? absolute[index - cols]
            : absolute[index - 1] + absolute[index - cols] - absolute[index - cols - 1];
      encoded[index] = absolute[index] - predictor;
    }
  }
  return encoded;
}

function buildGradientExportFixture({ mode = "exact" } = {}) {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const chunk = 32;
  const cap = 16;
  const inputAPtr = 0;
  const inputBPtr = inputAPtr + chunk * Float32Array.BYTES_PER_ELEMENT;
  const outputPtr = inputBPtr + chunk * Float32Array.BYTES_PER_ELEMENT;
  const statsPtr = outputPtr + chunk * Int16Array.BYTES_PER_ELEMENT;
  const previousRowPtr = statsPtr + 16;
  const output = new Int16Array(memory.buffer, outputPtr, chunk);
  const previousRow = new Int16Array(memory.buffer, previousRowPtr, cap);
  const fixture = {
    encodeCalls: 0,
    memory,
    output,
    previousRow,
    resetCalls: 0,
  };
  let activeCols = 0;
  let col = 0;
  let topRow = true;
  let left = 0;
  let upLeft = 0;
  fixture.exports = {
    GRADIENT_ABI_VERSION: parcelKernel.QUANTIZED_GRADIENT_ABI_VERSION,
    GRADIENT_COLS_CAP: cap,
    GRADIENT_CANARY: 0x47523244,
    GRADIENT_PREVIOUS_ROW_PTR: previousRowPtr,
    resetQuantizedGradient2d(cols) {
      fixture.resetCalls += 1;
      activeCols = 0;
      col = 0;
      topRow = true;
      left = 0;
      upLeft = 0;
      if (mode === "bad-reset" || !Number.isInteger(cols) || cols <= 0 || cols > cap) {
        return 0;
      }
      activeCols = cols;
      return cols;
    },
    gradientEncodeQuantizedI16(count) {
      fixture.encodeCalls += 1;
      if (mode === "short-progress") {
        return count - 1;
      }
      if (mode === "no-op") {
        return count;
      }
      for (let index = 0; index < count; index += 1) {
        const value = output[index];
        if (topRow) {
          output[index] = col === 0 ? value : value - left;
          previousRow[col] = value;
          left = value;
        } else {
          const up = previousRow[col];
          output[index] = col === 0 ? value - up : value - left - up + upLeft;
          previousRow[col] = value;
          left = value;
          upLeft = up;
        }
        col += 1;
        if (col === activeCols) {
          col = 0;
          topRow = false;
          left = 0;
          upLeft = 0;
        }
      }
      return count;
    },
  };
  fixture.quantize = {
    chunk,
    inA: new Float32Array(memory.buffer, inputAPtr, chunk),
    inB: new Float32Array(memory.buffer, inputBPtr, chunk),
    out: output,
    stats: new Int32Array(memory.buffer, statsPtr, 3),
  };
  return fixture;
}

test("loader fail-closes malformed gradient ABI, ranges, progress, and semantic canaries", () => {
  const create = parcelKernel._testCreateQuantizedGradientCapability;
  const valid = buildGradientExportFixture();
  assert.ok(create(valid.exports, valid.memory, valid.quantize));
  assert.ok(valid.encodeCalls >= 3, "split-row semantic canary did not execute");
  assert.deepEqual(Array.from(valid.output.subarray(0, 13)), new Array(13).fill(0));
  assert.deepEqual(Array.from(valid.previousRow.subarray(0, 10)), new Array(10).fill(0));

  for (const [name, mutate, expectedCalls] of [
    [
      "wrong ABI",
      (fixture) => {
        fixture.exports.GRADIENT_ABI_VERSION += 1;
      },
      0,
    ],
    [
      "wrong constant canary",
      (fixture) => {
        fixture.exports.GRADIENT_CANARY = 0;
      },
      0,
    ],
    [
      "oversized cap",
      (fixture) => {
        fixture.exports.GRADIENT_COLS_CAP = 32769;
      },
      0,
    ],
    [
      "overlapping previous-row range",
      (fixture) => {
        fixture.exports.GRADIENT_PREVIOUS_ROW_PTR = fixture.quantize.out.byteOffset;
      },
      0,
    ],
  ]) {
    const fixture = buildGradientExportFixture();
    mutate(fixture);
    assert.equal(create(fixture.exports, fixture.memory, fixture.quantize), null, name);
    assert.equal(fixture.encodeCalls, expectedCalls, `${name}: untrusted function executed`);
  }
  for (const mode of ["bad-reset", "short-progress", "no-op"]) {
    const fixture = buildGradientExportFixture({ mode });
    assert.equal(create(fixture.exports, fixture.memory, fixture.quantize), null, mode);
    if (mode !== "bad-reset") {
      assert.ok(fixture.encodeCalls > 0, `${mode}: semantic canary did not execute`);
    }
  }
});

test("bounded gradient capability is present and guards chunk progress without touching sentinels", () => {
  const quantize = parcelKernel.getParcelKernel()?.quantize;
  const gradient = quantize?.gradient;
  assert.ok(gradient, "optional fused gradient capability is unavailable");
  assert.equal(gradient.abiVersion, parcelKernel.QUANTIZED_GRADIENT_ABI_VERSION);
  assert.equal(gradient.cap, 32768);
  assert.equal(gradient.canEncode(32768, 65536), true);
  assert.equal(gradient.canEncode(32769, 65538), false);
  assert.equal(gradient.canEncode(7, 15), false);

  const snapshot = quantize.out.slice();
  try {
    quantize.out.fill(0x2a2a, 0, 12);
    assert.throws(() => gradient.encode(0), /outside 1/);
    assert.throws(() => gradient.encode(quantize.chunk + 1), /outside 1/);
    assert.deepEqual(Array.from(quantize.out.subarray(0, 12)), new Array(12).fill(0x2a2a));

    const absolute = Int16Array.from([32767, -32768, -1, 0, 1, 12345, -23456, 9, 10, 11, 12, 13, 14, 15]);
    quantize.out.fill(0x2a2a, 0, absolute.length + 2);
    assert.equal(gradient.reset(7), true);
    quantize.out.set(absolute.subarray(0, 5), 0);
    assert.equal(gradient.encode(5), 5);
    const first = quantize.out.slice(0, 5);
    assert.equal(quantize.out[5], 0x2a2a);
    quantize.out.fill(0x2a2a, 0, 11);
    quantize.out.set(absolute.subarray(5), 0);
    assert.equal(gradient.encode(absolute.length - 5), absolute.length - 5);
    const actual = new Int16Array(absolute.length);
    actual.set(first);
    actual.set(quantize.out.subarray(0, absolute.length - 5), 5);
    assert.deepEqual(actual, gradientOracle(absolute, 2, 7));
    assert.equal(quantize.out[absolute.length - 5], 0x2a2a);
  } finally {
    quantize.out.set(snapshot);
    gradient.reset(1);
  }
});

test("fused raw gradient is exact for row/vector/chunk boundary shapes", () => {
  const shapes = [
    [1, 32768],
    [32769, 1],
    [5, 7],
    [5, 8],
    [5, 9],
    [22, 1599],
    [22, 1600],
    [22, 1601],
    [2, 32768],
  ];
  for (const [rows, cols] of shapes) {
    const cellCount = rows * cols;
    const source = buildGrid(cellCount, rows + cols);
    const absolute = quantizeHoverGridVariable(source, 0.05, cellCount);
    const fused = quantizeHoverGridVariable(source, 0.05, cellCount, null, {
      gradientEncode: true,
      gradientCols: cols,
    });
    assertFusedRawMatchesAbsolute({ rows, cols, absolute, fused, label: `${rows}x${cols}` });
  }
});

test("fused affine and wind gradients preserve missing tails, clamps, wraps, stats, and stored bytes", () => {
  const rows = 23;
  const cols = 1601;
  const cellCount = rows * cols;
  const sourceLength = cellCount - 37;
  const source = buildGrid(sourceLength, 11);
  const windV = buildGrid(sourceLength, 73);
  const affineTransform = { transformScale: -2.5, transformOffset: 10, transformMin: -100 };

  const absoluteAffine = quantizeHoverGridVariable(source, 0.01, cellCount, affineTransform);
  const fusedAffine = quantizeHoverGridVariable(source, 0.01, cellCount, affineTransform, {
    gradientEncode: true,
    gradientCols: cols,
  });
  assertFusedRawMatchesAbsolute({
    rows,
    cols,
    absolute: absoluteAffine,
    fused: fusedAffine,
    label: "partial affine",
  });

  const absoluteWind = quantizeHoverWindGridVariable({
    uValues: source,
    vValues: windV,
    multiplier: 1.943844,
    scale: 0.1,
    cellCount,
  });
  const fusedWind = quantizeHoverWindGridVariable({
    uValues: source,
    vValues: windV,
    multiplier: 1.943844,
    scale: 0.1,
    cellCount,
    gradientEncode: true,
    gradientCols: cols,
  });
  assertFusedRawMatchesAbsolute({
    rows,
    cols,
    absolute: absoluteWind,
    fused: fusedWind,
    label: "partial wind",
  });

  const compression = { backend: "brotli", brotliQuality: 0 };
  assert.deepEqual(
    encodeHoverGridBinaryPayload({ ...payload(rows, cols, { affine: fusedAffine, wind: fusedWind }), compression }),
    encodeHoverGridBinaryPayload({
      ...payload(rows, cols, { affine: absoluteAffine, wind: absoluteWind }),
      compression,
    }),
  );
});

test("each variable resets independently and mixed fused/unfused MVH4 bodies remain exact", () => {
  const rows = 31;
  const cols = 1600;
  const cellCount = rows * cols;
  const firstSource = buildGrid(cellCount, 3);
  const secondSource = buildGrid(cellCount, 91);
  const functionSource = Float64Array.from(buildGrid(cellCount, 151));
  const transform = (value) => value * 0.125 - 7;
  const absolute = {
    first: quantizeHoverGridVariable(firstSource, 0.1, cellCount),
    function: quantizeHoverGridVariable(functionSource, 0.1, cellCount, transform),
    second: quantizeHoverGridVariable(secondSource, 1, cellCount),
  };
  const mixed = {
    first: quantizeHoverGridVariable(firstSource, 0.1, cellCount, null, {
      gradientEncode: true,
      gradientCols: cols,
    }),
    function: quantizeHoverGridVariable(functionSource, 0.1, cellCount, transform, {
      gradientEncode: true,
      gradientCols: cols,
    }),
    second: quantizeHoverGridVariable(secondSource, 1, cellCount, null, {
      gradientEncode: true,
      gradientCols: cols,
    }),
  };
  assert.equal(mixed.first.predictorEncoded, "gradient2d");
  assert.equal(mixed.function.predictorEncoded, undefined, "function transforms retain the absolute fallback");
  assert.equal(mixed.second.predictorEncoded, "gradient2d");
  const raw = buildHoverGridBinaryRaw(payload(rows, cols, mixed));
  assert.deepEqual(raw, buildHoverGridBinaryRaw(payload(rows, cols, absolute)));
  const headerLength = raw.readUInt32LE(4);
  assert.equal(raw.subarray(8, 8 + headerLength).includes(Buffer.from("predictorEncoded")), false);
});

test("production orchestration engages raw, affine, and wind fusion but leaves fallback-safe planes unmarked", () => {
  const kernel = parcelKernel.getParcelKernel();
  const originalGradient = kernel.quantize.gradient;
  let resets = 0;
  let chunks = 0;
  kernel.quantize.gradient = {
    ...originalGradient,
    reset(cols) {
      resets += 1;
      return originalGradient.reset(cols);
    },
    encode(count) {
      chunks += 1;
      return originalGradient.encode(count);
    },
  };
  try {
    const width = 1601;
    const height = 22;
    const cellCount = width * height;
    const raw = buildGrid(cellCount, 19);
    const affine = buildGrid(cellCount, 29);
    const windV = buildGrid(cellCount, 39);
    const options = {
      decoded: { raw, affine, windV },
      selection: {
        availableParameters: ["rawProbe", "affineProbe", "windProbe"],
        catalog: [
          { key: "rawProbe", inputKey: "raw", unit: "C", transform: "identity" },
          { key: "affineProbe", inputKey: "affine", unit: "F", transform: "kelvinToFahrenheit" },
          { key: "windProbe", kind: "wind", uKey: "raw", vKey: "windV", unit: "kt", transform: "windKt" },
        ],
      },
      pressureHpa: buildGrid(cellCount, 49),
      width,
      height,
    };
    const absolute = buildHoverGridVariables(options);
    const fused = buildHoverGridVariables({ ...options, preGradient: true });
    assert.deepEqual(Object.keys(fused), ["rawProbe", "affineProbe", "windProbe", "pressureHpa"]);
    for (const variable of Object.values(fused)) {
      assert.equal(variable.predictorEncoded, "gradient2d");
    }
    assert.equal(resets, 4);
    assert.ok(chunks >= 8, `expected chunked gradient engagement, observed ${chunks}`);
    assert.deepEqual(
      buildHoverGridBinaryRaw(payload(height, width, fused)),
      buildHoverGridBinaryRaw(payload(height, width, absolute)),
    );
  } finally {
    kernel.quantize.gradient = originalGradient;
  }
});

test("main and winter writers engage gradient fusion only for binary MVH4 output", async () => {
  const kernel = parcelKernel.getParcelKernel();
  const originalGradient = kernel.quantize.gradient;
  let resets = 0;
  kernel.quantize.gradient = Object.freeze({
    ...originalGradient,
    reset(cols) {
      resets += 1;
      return originalGradient.reset(cols);
    },
  });
  const width = 2;
  const height = 2;
  const decoded = { probe: new Float32Array([1, 2, 3, 4]) };
  const selection = {
    catalog: [{ key: "probe", inputKey: "probe", unit: "C", transform: "identity" }],
    availableParameters: ["probe"],
    records: {},
  };
  const shared = {
    decoded,
    selection,
    framePlan: { hour: 0, validTime: "2026-07-11T00:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "hrrr",
    width,
    height,
    pngCompressionLevel: 1,
    pngFilterType: 0,
  };
  try {
    resets = 0;
    await buildRenderedArtifacts({ ...shared, hoverGridFormat: "binary", reflectivityGates: [15] });
    assert.equal(resets, 1, "main binary MVH4 path");

    resets = 0;
    await buildRenderedArtifacts({ ...shared, hoverGridFormat: "json", reflectivityGates: [15] });
    assert.equal(resets, 0, "main JSON path");

    resets = 0;
    buildSnowRenderedArtifacts({ ...shared, hoverGridFormat: "binary" });
    assert.equal(resets, 1, "winter binary MVH4 path");

    resets = 0;
    buildSnowRenderedArtifacts({ ...shared, hoverGridFormat: "json" });
    assert.equal(resets, 0, "winter JSON path");
  } finally {
    kernel.quantize.gradient = originalGradient;
  }
});

test("empty gradient requests remain unmarked and preserve production omission", () => {
  const empty = quantizeHoverGridVariable(new Float32Array(0), 0.1, 1, null, {
    gradientEncode: true,
    gradientCols: 1,
  });
  assert.equal(empty.validCount, 0);
  assert.equal(empty.predictorEncoded, undefined);
  const variables = buildHoverGridVariables({
    decoded: { probe: new Float32Array(0) },
    selection: {
      availableParameters: ["probe"],
      catalog: [{ key: "probe", inputKey: "probe", unit: "C", transform: "identity" }],
    },
    pressureHpa: new Float32Array(0),
    width: 1,
    height: 1,
    preGradient: true,
  });
  assert.deepEqual(variables, {});
});

test("missing or incompatible capability chooses the absolute fallback before quantization", () => {
  const kernel = parcelKernel.getParcelKernel();
  const originalGradient = kernel.quantize.gradient;
  const rows = 3;
  const cols = 9;
  const source = buildGrid(rows * cols);
  const expected = quantizeHoverGridVariable(source, 0.1, source.length);
  try {
    kernel.quantize.gradient = null;
    const direct = quantizeHoverGridVariable(source, 0.1, source.length, null, {
      gradientEncode: true,
      gradientCols: cols,
    });
    assert.equal(direct.predictorEncoded, undefined);
    assert.deepEqual(direct.values, expected.values);

    const buildOptions = {
      decoded: { probe: source },
      selection: {
        availableParameters: ["probe"],
        catalog: [{ key: "probe", inputKey: "probe", unit: "C", transform: "identity" }],
      },
      pressureHpa: buildGrid(rows * cols, 41),
      width: cols,
      height: rows,
    };
    const absoluteVariables = buildHoverGridVariables(buildOptions);
    const requestedVariables = buildHoverGridVariables({ ...buildOptions, preGradient: true });
    for (const variable of Object.values(requestedVariables)) {
      assert.equal(variable.predictorEncoded, undefined);
    }
    assert.deepEqual(
      buildHoverGridBinaryRaw(payload(rows, cols, requestedVariables)),
      buildHoverGridBinaryRaw(payload(rows, cols, absoluteVariables)),
    );

    const incompatible = quantizeHoverGridVariable(source, 0.1, source.length, null, {
      gradientEncode: true,
      gradientCols: 32769,
    });
    assert.equal(incompatible.predictorEncoded, undefined);
    assert.deepEqual(incompatible.values, expected.values);
  } finally {
    kernel.quantize.gradient = originalGradient;
  }
});

test("packer accepts trusted mixed MVH4 markers and rejects every invalid marker/container combination", () => {
  const rows = 2;
  const cols = 3;
  const values = Int16Array.from([-32768, 32767, -1, 0, 1, 12345]);
  const absolute = { values, scale: 0.1, offset: 0, missing: -32768 };
  const gradient = {
    ...absolute,
    values: gradientOracle(values, rows, cols),
    predictorEncoded: "gradient2d",
  };
  const mixed = buildHoverGridBinaryRaw(payload(rows, cols, { absolute, gradient }));
  const expected = buildHoverGridBinaryRaw(payload(rows, cols, { absolute, gradient: absolute }));
  assert.deepEqual(mixed, expected);

  const inheritedMarker = Object.assign(Object.create({ predictorEncoded: "gradient2d" }), absolute);
  assert.deepEqual(
    buildHoverGridBinaryRaw(payload(rows, cols, { probe: inheritedMarker })),
    buildHoverGridBinaryRaw(payload(rows, cols, { probe: absolute })),
    "inherited/prototype-polluted markers must not bypass the authoritative gradient pass",
  );

  for (const [label, candidate, options, pattern] of [
    ["unknown", { ...absolute, predictorEncoded: "future" }, payload(rows, cols, {}), /unknown predictor marker/],
    ["undefined marker", { ...absolute, predictorEncoded: undefined }, payload(rows, cols, {}), /unknown predictor/],
    [
      "delta plus gradient",
      { ...gradient, deltaEncoded: true, deltaEndValue: 12345 },
      payload(rows, cols, {}),
      /both pre-delta and pre-gradient/,
    ],
    [
      "MVH3 gradient",
      gradient,
      { schemaVersion: 3, encoding: MVH3, rows, cols, variables: {} },
      /cannot contain pre-gradient/,
    ],
    ["MVHG gradient", gradient, { schemaVersion: 2, rows, cols, variables: {} }, /cannot contain pre-gradient/],
  ]) {
    assert.throws(() => buildHoverGridBinaryRaw({ ...options, variables: { probe: candidate } }), pattern, label);
  }
  assert.throws(
    () =>
      buildHoverGridBinaryRaw(
        payload(rows, cols, {
          probe: { ...absolute, deltaEncoded: true, deltaEndValue: values.at(-1) },
        }),
      ),
    /requires absolute/,
  );
  assert.throws(() => encodeHoverGridJsonPayload({ rows, cols, variables: { probe: gradient } }), /binary schema-v4/);
  assert.throws(() => hoverGridVariableToJson(gradient), /binary schema-v4/);
  assert.throws(
    () => buildHoverGridArtifact({ width: cols, height: rows, variables: { probe: gradient }, format: "json" }),
    /binary schema-v4/,
  );
  assert.throws(
    () =>
      quantizeHoverGridVariable(Float32Array.from(values), 1, values.length, null, {
        deltaEncode: true,
        gradientEncode: true,
        gradientCols: cols,
      }),
    /both global1d delta and gradient2d/,
  );
  assert.throws(
    () =>
      quantizeHoverWindGridVariable({
        uValues: Float32Array.from(values),
        vValues: Float32Array.from(values),
        scale: 1,
        cellCount: values.length,
        deltaEncode: true,
        gradientEncode: true,
        gradientCols: cols,
      }),
    /both global1d delta and gradient2d/,
  );
  assert.throws(
    () =>
      buildHoverGridVariables({
        decoded: {},
        selection: { catalog: [] },
        width: cols,
        height: rows,
        preDeltaEncode: true,
        preGradient: true,
      }),
    /both global1d delta and gradient2d/,
  );
});

test("fused MVH4 output has a stable hash independent of the internal marker", () => {
  const rows = 5;
  const cols = 9;
  const source = buildGrid(rows * cols, 121);
  const absolute = quantizeHoverGridVariable(source, 0.05, source.length);
  const fused = quantizeHoverGridVariable(source, 0.05, source.length, null, {
    gradientEncode: true,
    gradientCols: cols,
  });
  const absoluteRaw = buildHoverGridBinaryRaw(payload(rows, cols, { probe: absolute }));
  const fusedRaw = buildHoverGridBinaryRaw(payload(rows, cols, { probe: fused }));
  const fusedHash = crypto.createHash("sha256").update(fusedRaw).digest("hex");
  assert.equal(fusedHash, crypto.createHash("sha256").update(absoluteRaw).digest("hex"));
  assert.equal(fusedRaw.length, 252);
  assert.equal(fusedHash, "d23b0aa2e8f193eaf7af0f3de8aec26919923d7f424b9aedf294aae165b420de");
});
