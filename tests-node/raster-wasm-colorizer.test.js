"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const test = require("node:test");
const { Worker } = require("node:worker_threads");

process.env.MODELVIEW_PARCEL_KERNEL = "wasm-f32";

const parcelKernel = require("../scripts/lib/noaa-beta/parcel-kernel");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../scripts/lib/noaa-nam-parameter-catalog");
const {
  CATALOG_RENDER_OPTIONS,
  buildAffineTransformState,
  createContinuousColorLookup,
  renderScalarGrid,
  renderScalarGridContinuousAffine,
  renderScalarGridContinuousRaw,
  resolveCatalogTransformOptions,
  resolveVisibleBounds,
} = require("../scripts/lib/noaa-beta/raster");

const kernel = parcelKernel.getParcelKernel();

function buildLookup() {
  return createContinuousColorLookup({
    stops: [
      [0, [0, 0, 0, 0]],
      [0.2, [20, 80, 160, 0.35]],
      [0.65, [80, 210, 120, 0.8]],
      [1, [250, 230, 30, 1]],
    ],
    min: -80,
    max: 160,
    alpha: 0.91,
    size: 257,
  });
}

function buildValues(length, seed = 0x51a7e) {
  const values = new Float32Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < values.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    values[index] = ((state >>> 0) / 0xffffffff) * 800 - 300;
  }
  const probes = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0,
    0,
    -80,
    160,
    Math.fround(-80 - Number.EPSILON),
    Math.fround(160 + Number.EPSILON),
    -1000,
    1000,
  ];
  values.set(probes.slice(0, Math.min(probes.length, values.length)));
  for (let index = 211; index < values.length; index += 997) {
    values[index] = Number.NaN;
  }
  return values;
}

function renderJsReference(values, lookup, options = {}) {
  const visible = resolveVisibleBounds(options.minVisible, options.maxVisible, options.visibleRange);
  const rgba = Buffer.alloc(values.length * 4);
  const affine = buildAffineTransformState(options.transformScale, options.transformOffset, options.transformMin);
  const common = {
    rgba,
    values,
    cellCount: values.length,
    colorLookup: lookup,
    visible,
  };
  return affine
    ? renderScalarGridContinuousAffine({ ...common, affineTransform: affine })
    : renderScalarGridContinuousRaw(common);
}

function renderKernelCandidate(values, lookup, options = {}) {
  return renderScalarGrid({
    values,
    width: values.length,
    height: 1,
    colorLookup: lookup,
    ...options,
  });
}

function withKernelGetter(getter, run) {
  const original = parcelKernel.getParcelKernel;
  parcelKernel.getParcelKernel = getter;
  try {
    return run();
  } finally {
    parcelKernel.getParcelKernel = original;
  }
}

function buildColorizerExportFixture({
  abiVersion = parcelKernel.CONTINUOUS_COLORIZER_ABI_VERSION,
  mode = "exact",
} = {}) {
  const memory = new WebAssembly.Memory({ initial: 10 });
  const chunk = 8;
  const paletteCap = 8;
  const inputPtr = 0;
  const outputPtr = inputPtr + chunk * 4;
  const palettePtr = outputPtr + chunk * 4;
  const statsPtr = palettePtr + paletteCap * 4;
  const input = new Float32Array(memory.buffer, inputPtr, chunk);
  const output = new Uint8Array(memory.buffer, outputPtr, chunk * 4);
  const palette = new Uint8Array(memory.buffer, palettePtr, paletteCap * 4);
  const stats = new Int32Array(memory.buffer, statsPtr, 2);
  const fixture = { calls: 0, memory };
  fixture.exports = {
    COLORIZER_ABI_VERSION: abiVersion,
    COLOR_CHUNK: chunk,
    COLOR_PALETTE_CAP: paletteCap,
    QIN_A_PTR: inputPtr,
    COLOR_OUT_PTR: outputPtr,
    COLOR_PALETTE_PTR: palettePtr,
    COLOR_STATS_PTR: statsPtr,
    colorizeContinuousF64(
      count,
      paletteSize,
      lookupMin,
      lookupScale,
      hasVisibleMin,
      visibleMin,
      hasVisibleMax,
      visibleMax,
      affineScale,
      affineOffset,
      affineHasMin,
      affineMin,
    ) {
      fixture.calls += 1;
      if (mode === "no-op") {
        return;
      }
      const resolvedCount = Math.max(0, Math.min(chunk, count));
      const resolvedPaletteSize = Math.max(0, Math.min(paletteCap, paletteSize));
      output.fill(0, 0, resolvedCount * 4);
      let visibleCount = 0;
      let validCount = 0;
      const lastBucket = resolvedPaletteSize - 1;
      for (let index = 0; index < resolvedCount; index += 1) {
        let value = input[index] * affineScale + affineOffset;
        if (affineHasMin && value < affineMin) {
          value = affineMin;
        }
        if (!Number.isFinite(value)) {
          continue;
        }
        validCount += 1;
        if ((hasVisibleMin && value < visibleMin) || (hasVisibleMax && value > visibleMax)) {
          continue;
        }
        const position = (value - lookupMin) * lookupScale;
        const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
        const colorOffset = bucket * 4;
        if (palette[colorOffset + 3] === 0) {
          continue;
        }
        output.set(palette.subarray(colorOffset, colorOffset + 4), index * 4);
        visibleCount += 1;
      }
      stats[0] = visibleCount;
      stats[1] = validCount;
      if (mode === "wrong-output") {
        output[5] ^= 0xff;
      }
    },
  };
  return fixture;
}

const floatBitsBuffer = new ArrayBuffer(4);
const floatBitsView = new Float32Array(floatBitsBuffer);
const uintBitsView = new Uint32Array(floatBitsBuffer);

function nextAdjacentFloat32(value, direction) {
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) {
    return rounded;
  }
  floatBitsView[0] = rounded;
  let bits = uintBitsView[0];
  if (Object.is(rounded, -0)) {
    bits = direction > 0 ? 1 : 0x80000001;
  } else if (Object.is(rounded, 0)) {
    bits = direction > 0 ? 1 : 0x80000001;
  } else if (rounded > 0 === direction > 0) {
    bits += 1;
  } else {
    bits -= 1;
  }
  uintBitsView[0] = bits;
  return floatBitsView[0];
}

test("continuous colorizer capability is bounded and fully owned by one kernel instance", () => {
  assert.ok(kernel?.colorize, "tracked parcel kernel must expose the exact colorizer");
  const colorize = kernel.colorize;
  assert.equal(colorize.abiVersion, parcelKernel.CONTINUOUS_COLORIZER_ABI_VERSION);
  assert.equal(colorize.chunk, 32768);
  assert.equal(colorize.paletteCap, 65536);
  assert.equal(colorize.input.length, colorize.chunk);
  assert.equal(colorize.output.length, colorize.chunk * 4);
  assert.equal(colorize.palette.length, colorize.paletteCap * 4);
  assert.equal(colorize.stats.length, 2);
  assert.equal(colorize.input.buffer, colorize.memory.buffer);
  assert.equal(colorize.output.buffer, colorize.memory.buffer);
  assert.equal(colorize.palette.buffer, colorize.memory.buffer);
  assert.equal(colorize.stats.buffer, colorize.memory.buffer);
  assert.ok(colorize.memory.buffer.byteLength <= 24 * 1024 * 1024);
});

test("raw and affine colorization are byte/count exact across chunks and a partial tail", () => {
  const values = buildValues(kernel.colorize.chunk * 2 + 19);
  const lookup = buildLookup();
  let calls = 0;
  const observed = {
    ...kernel.colorize,
    run(...args) {
      calls += 1;
      return kernel.colorize.run(...args);
    },
  };
  withKernelGetter(
    () => ({ colorize: observed }),
    () => {
      for (const options of [
        { minVisible: -55, maxVisible: 140 },
        {
          minVisible: -90,
          maxVisible: 120,
          transformScale: -2.5,
          transformOffset: 10,
          transformMin: -100,
        },
      ]) {
        const actual = renderKernelCandidate(values, lookup, options);
        const expected = renderJsReference(values, lookup, options);
        assert.deepEqual(actual, expected);
      }
    },
  );
  assert.equal(calls, 6, "three chunks per raw/affine render must engage the kernel");
});

test("all continuous catalog lookups are exact at bucket/visibility boundaries and random Float32 values", () => {
  let entries = 0;
  let probes = 0;
  let calls = 0;
  const observed = {
    ...kernel.colorize,
    run(...args) {
      calls += 1;
      return kernel.colorize.run(...args);
    },
  };
  withKernelGetter(
    () => ({ colorize: observed }),
    () => {
      for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
        const renderOptions = CATALOG_RENDER_OPTIONS.get(entry.key);
        const lookup = renderOptions?.colorLookup;
        if (lookup?.kind !== "continuous") {
          continue;
        }
        assert.equal(lookup.log, false, `${entry.key}: log lookup must stay on JS until separately ported`);
        const isAlreadyPresentationGrid =
          entry.key === "temperature" ||
          entry.key === "wind" ||
          entry.kind === "wind" ||
          entry.kind === "snowfallDerived" ||
          entry.kind === "snowfallDirect";
        const transformOptions = isAlreadyPresentationGrid ? {} : resolveCatalogTransformOptions(entry);
        assert.notEqual(typeof transformOptions.transformValue, "function", `${entry.key}: non-affine transform`);
        const affine = buildAffineTransformState(
          transformOptions.transformScale,
          transformOptions.transformOffset,
          transformOptions.transformMin,
        );
        const values = buildValues(kernel.colorize.chunk, 0x9e3779b9 ^ entries);
        const visible = resolveVisibleBounds(
          renderOptions.minVisible,
          renderOptions.maxVisible,
          renderOptions.visibleRange,
        );
        const presentationTargets = [lookup.min, lookup.max, visible.min, visible.max].filter(Number.isFinite);
        const lastBucket = lookup.size - 1;
        const stride = Math.max(1, Math.floor(lastBucket / 1024));
        for (let bucket = 0; bucket <= lastBucket; bucket += stride) {
          presentationTargets.push(lookup.min + bucket / lastBucket / lookup.scale);
        }
        let cursor = 0;
        for (const presentationValue of presentationTargets) {
          const sourceValue = Math.fround(
            affine ? (presentationValue - affine.offset) / affine.scale : presentationValue,
          );
          for (const probe of [
            nextAdjacentFloat32(sourceValue, -1),
            sourceValue,
            nextAdjacentFloat32(sourceValue, 1),
          ]) {
            if (cursor >= values.length) {
              break;
            }
            values[cursor] = probe;
            cursor += 1;
          }
        }
        const options = {
          minVisible: renderOptions.minVisible,
          maxVisible: renderOptions.maxVisible,
          visibleRange: renderOptions.visibleRange,
          ...transformOptions,
        };
        assert.deepEqual(
          renderKernelCandidate(values, lookup, options),
          renderJsReference(values, lookup, options),
          entry.key,
        );
        entries += 1;
        probes += values.length;
      }
    },
  );
  assert.equal(entries, 71);
  assert.equal(probes, 2326528);
  assert.equal(calls, entries, "each one-chunk catalog probe must engage the kernel once");
});

test("kernel failure after a completed chunk reruns exact JS from a clean buffer and stays disabled", () => {
  const values = buildValues(kernel.colorize.chunk + 7, 0xbadc0de);
  const lookup = buildLookup();
  const expected = renderJsReference(values, lookup, { minVisible: -40 });
  let calls = 0;
  const failing = {
    ...kernel.colorize,
    run(...args) {
      calls += 1;
      if (calls === 2) {
        throw new Error("injected colorizer failure");
      }
      return kernel.colorize.run(...args);
    },
  };
  withKernelGetter(
    () => ({ colorize: failing }),
    () => {
      assert.deepEqual(renderKernelCandidate(values, lookup, { minVisible: -40 }), expected);
      assert.equal(calls, 2);
      assert.deepEqual(renderKernelCandidate(values, lookup, { minVisible: -40 }), expected);
      assert.equal(calls, 2, "failed capability must not be retried on later layers");
    },
  );
});

test("a colorizer that returns without writing stats fails closed and stays disabled", () => {
  const values = buildValues(kernel.colorize.chunk + 7, 0x5a1e);
  const lookup = buildLookup();
  const expected = renderJsReference(values, lookup, { maxVisible: 120 });
  let calls = 0;
  const noStats = {
    ...kernel.colorize,
    run() {
      calls += 1;
    },
  };
  withKernelGetter(
    () => ({ colorize: noStats }),
    () => {
      assert.deepEqual(renderKernelCandidate(values, lookup, { maxVisible: 120 }), expected);
      assert.equal(calls, 1, "poisoned counters must reject the first missing write");
      assert.deepEqual(renderKernelCandidate(values, lookup, { maxVisible: 120 }), expected);
      assert.equal(calls, 1, "rejected capability must not be retried");
    },
  );
});

test("invalid counters and view shapes fail closed to the JS renderer", () => {
  const values = buildValues(4099, 0xc001d00d);
  const lookup = buildLookup();
  const expected = renderJsReference(values, lookup);
  let invalidCounterCalls = 0;
  const invalidCounters = {
    ...kernel.colorize,
    run(...args) {
      invalidCounterCalls += 1;
      kernel.colorize.run(...args);
      kernel.colorize.stats[0] = args[0] + 1;
    },
  };
  withKernelGetter(
    () => ({ colorize: invalidCounters }),
    () => assert.deepEqual(renderKernelCandidate(values, lookup), expected),
  );
  assert.equal(invalidCounterCalls, 1);

  let invalidShapeCalls = 0;
  const invalidShape = {
    ...kernel.colorize,
    output: new Uint8Array(4),
    run() {
      invalidShapeCalls += 1;
    },
  };
  withKernelGetter(
    () => ({ colorize: invalidShape }),
    () => assert.deepEqual(renderKernelCandidate(values, lookup), expected),
  );
  assert.equal(invalidShapeCalls, 0, "invalid views must be rejected before execution");

  const zeroScaleLookup = { ...lookup, scale: 0 };
  withKernelGetter(
    () => ({ colorize: invalidShape }),
    () => assert.deepEqual(renderKernelCandidate(values, zeroScaleLookup), renderJsReference(values, zeroScaleLookup)),
  );
  assert.equal(invalidShapeCalls, 0, "unsupported lookup shapes must remain on JS");

  let oversizedShapeCalls = 0;
  const oversizedBuffer = new ArrayBuffer(800000);
  const oversizedShape = {
    chunk: 65537,
    paletteCap: lookup.size,
    memory: { buffer: oversizedBuffer },
    input: new Float32Array(oversizedBuffer, 0, 65537),
    output: new Uint8Array(oversizedBuffer, 262148, 65537 * 4),
    palette: new Uint8Array(oversizedBuffer, 524296, lookup.colors.length),
    stats: new Int32Array(oversizedBuffer, 525324, 2),
    run() {
      oversizedShapeCalls += 1;
    },
  };
  withKernelGetter(
    () => ({ colorize: oversizedShape }),
    () => assert.deepEqual(renderKernelCandidate(values, lookup), expected),
  );
  assert.equal(oversizedShapeCalls, 0, "oversized injected shapes must be rejected before execution");
});

test("log lookups and non-Float32 inputs remain on the authoritative JS path", () => {
  const values = buildValues(8193, 0x10f);
  const baseLookup = buildLookup();
  const logLookup = {
    ...baseLookup,
    log: true,
    logMin: Math.log(1),
    logScale: 1 / Math.log(200),
  };
  let calls = 0;
  const trap = {
    ...kernel.colorize,
    run() {
      calls += 1;
      throw new Error("unsupported path engaged kernel");
    },
  };
  withKernelGetter(
    () => ({ colorize: trap }),
    () => {
      const logActual = renderKernelCandidate(values, logLookup);
      const logExpected = renderJsReference(values, logLookup);
      assert.deepEqual(logActual, logExpected);

      const doubles = Float64Array.from(values);
      const doubleActual = renderKernelCandidate(doubles, baseLookup);
      const doubleExpected = renderJsReference(doubles, baseLookup);
      assert.deepEqual(doubleActual, doubleExpected);
    },
  );
  assert.equal(calls, 0);
});

test("returned RGBA owns its bytes across later kernel scratch reuse", () => {
  const lookup = buildLookup();
  const first = renderKernelCandidate(buildValues(50003, 0x111), lookup);
  const frozenFirst = Buffer.from(first.rgba);
  const second = renderKernelCandidate(buildValues(50003, 0x222), lookup, {
    transformScale: 1.8,
    transformOffset: -459.67,
  });
  assert.deepEqual(first.rgba, frozenFirst);
  assert.notDeepEqual(first.rgba, second.rgba);
  assert.notEqual(first.rgba.buffer, kernel.colorize.memory.buffer);
  assert.notEqual(second.rgba.buffer, kernel.colorize.memory.buffer);
});

test("loader requires the exact ABI and semantic canary while preserving the parcel kernel", () => {
  const create = parcelKernel._testCreateContinuousColorizerCapability;
  const retainedKernel = parcelKernel.getParcelKernel();
  const valid = buildColorizerExportFixture();
  const capability = create(valid.exports, valid.memory);
  assert.ok(capability);
  assert.equal(capability.abiVersion, parcelKernel.CONTINUOUS_COLORIZER_ABI_VERSION);
  assert.equal(valid.calls, 1, "loader must execute one semantic canary");
  assert.deepEqual(Array.from(capability.input.subarray(0, 6)), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(capability.output.subarray(0, 24)), new Array(24).fill(0));
  assert.deepEqual(Array.from(capability.palette.subarray(0, 16)), new Array(16).fill(0));
  assert.deepEqual(Array.from(capability.stats), [0, 0]);

  const wrongAbi = buildColorizerExportFixture({
    abiVersion: parcelKernel.CONTINUOUS_COLORIZER_ABI_VERSION + 1,
  });
  assert.equal(create(wrongAbi.exports, wrongAbi.memory), null);
  assert.equal(wrongAbi.calls, 0, "wrong ABI must be rejected before executing untrusted semantics");

  const missingAbi = buildColorizerExportFixture();
  delete missingAbi.exports.COLORIZER_ABI_VERSION;
  assert.equal(create(missingAbi.exports, missingAbi.memory), null);
  assert.equal(missingAbi.calls, 0);

  const noOp = buildColorizerExportFixture({ mode: "no-op" });
  assert.equal(create(noOp.exports, noOp.memory), null);
  assert.equal(noOp.calls, 1, "missing stat/output writes must fail the semantic canary");

  const wrongOutput = buildColorizerExportFixture({ mode: "wrong-output" });
  assert.equal(create(wrongOutput.exports, wrongOutput.memory), null);
  assert.equal(wrongOutput.calls, 1, "plausible counters with wrong RGBA must fail the semantic canary");

  assert.strictEqual(parcelKernel.getParcelKernel(), retainedKernel);
  assert.equal(typeof retainedKernel.runOriginScan, "function", "optional rejection must retain the parcel capability");
});

test("loader rejects overlapping, oversized, unaligned, and out-of-bounds colorizer ranges before execution", () => {
  const create = parcelKernel._testCreateContinuousColorizerCapability;
  for (const mutate of [
    (exports) => {
      exports.COLOR_OUT_PTR = exports.QIN_A_PTR;
    },
    (exports) => {
      exports.COLOR_CHUNK = 65537;
    },
    (exports, memory) => {
      exports.COLOR_PALETTE_PTR = memory.buffer.byteLength;
    },
    (exports) => {
      exports.COLOR_STATS_PTR = 3;
    },
  ]) {
    const fixture = buildColorizerExportFixture();
    mutate(fixture.exports, fixture.memory);
    assert.equal(create(fixture.exports, fixture.memory), null);
    assert.equal(fixture.calls, 0);
  }
});

test("a fresh worker thread loads and runs its own exact colorizer instance", async () => {
  const workerPath = path.resolve(__dirname, "../scripts/lib/noaa-beta/raster.js");
  const worker = new Worker(
    `
      "use strict";
      const { parentPort, workerData } = require("node:worker_threads");
      process.env.MODELVIEW_PARCEL_KERNEL = "wasm-f32";
      const crypto = require("node:crypto");
      const raster = require(workerData.rasterPath);
      const values = new Float32Array(40001);
      for (let i = 0; i < values.length; i += 1) values[i] = i % 173 === 0 ? NaN : (i % 997) / 4 - 80;
      const lookup = raster.createContinuousColorLookup({
        stops: [[0, [0, 0, 0, 0]], [0.5, [40, 180, 220, 0.7]], [1, [250, 60, 20, 1]]],
        min: -80,
        max: 170,
        size: 257,
      });
      const result = raster.renderScalarGrid({
        values,
        width: values.length,
        height: 1,
        colorLookup: lookup,
        minVisible: -40,
        transformScale: 1.25,
        transformOffset: 3,
      });
      parentPort.postMessage({
        sha256: crypto.createHash("sha256").update(result.rgba).digest("hex"),
        visibleCount: result.visibleCount,
        validCount: result.validCount,
      });
    `,
    { eval: true, workerData: { rasterPath: workerPath } },
  );
  const workerResult = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  await worker.terminate();

  const values = new Float32Array(40001);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = index % 173 === 0 ? Number.NaN : (index % 997) / 4 - 80;
  }
  const lookup = createContinuousColorLookup({
    stops: [
      [0, [0, 0, 0, 0]],
      [0.5, [40, 180, 220, 0.7]],
      [1, [250, 60, 20, 1]],
    ],
    min: -80,
    max: 170,
    size: 257,
  });
  const expected = renderKernelCandidate(values, lookup, {
    minVisible: -40,
    transformScale: 1.25,
    transformOffset: 3,
  });
  assert.deepEqual(workerResult, {
    sha256: crypto.createHash("sha256").update(expected.rgba).digest("hex"),
    visibleCount: expected.visibleCount,
    validCount: expected.validCount,
  });
});
