"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { PNG } = require("pngjs");

const { _testFormatRenderProfile: formatRenderProfile } = require("../scripts/build-noaa-beta-artifacts");
const { compressSync } = require("../scripts/lib/noaa-beta/compress-pool");
const {
  _testIndexedPngRawScratchSlot,
  _testPngRawScratchSlot,
  _testResetPngRawScratch,
  encodeIndexedPngFilter0,
  encodeIndexedPngFilter0ViaPool,
  encodeRgbaPngFilter0,
  pngCrc32,
} = require("../scripts/lib/noaa-beta/png-encode");
const {
  CORE_LAYER_RENDER_OPTIONS,
  INDEXED_PIXEL_FORMAT,
  PRECIP_RATE_TYPE_LOOKUPS,
  PRATE_KG_M2_S_TO_IN_HR,
  REFLECTIVITY_PRECIP_TYPE_LOOKUPS,
  buildIndexedPalette,
  createStepColorLookup,
  encodeLayerOrEmpty,
  encodeLayerOrEmptyDeferred,
  expandIndexedLayerToRgba,
  renderPrecipRateTypeGrid,
  renderReflectivityGateLayers,
  renderReflectivityPrecipTypeGrid,
  renderScalarGrid,
} = require("../scripts/lib/noaa-beta/raster");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../scripts/lib/noaa-nam-parameter-catalog");
const {
  _testBuildRenderedArtifacts: buildRenderedArtifacts,
  getNoaaGribRendererSignature,
} = require("../scripts/lib/noaa-beta-renderer");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function parsePngChunks(body) {
  assert.deepEqual(body.subarray(0, 8), PNG_SIGNATURE);
  const chunks = [];
  let offset = 8;
  while (offset < body.length) {
    const length = body.readUInt32BE(offset);
    const type = body.toString("ascii", offset + 4, offset + 8);
    const data = body.subarray(offset + 8, offset + 8 + length);
    const crc = body.readUInt32BE(offset + 8 + length);
    assert.equal(crc, pngCrc32(Buffer.from(type, "ascii"), data), `${type} CRC`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  assert.equal(offset, body.length);
  return chunks;
}

function expandIndices(indices, palette) {
  const rgba = Buffer.alloc(indices.length * 4);
  for (let index = 0; index < indices.length; index += 1) {
    const source = indices[index] * 4;
    palette.copy(rgba, index * 4, source, source + 4);
  }
  return rgba;
}

function makeBufferSwappingUint8Array(firstBytes, laterBytes) {
  const first = Uint8Array.from(firstBytes);
  const later = Uint8Array.from(laterBytes);
  assert.equal(first.length, later.length);
  const view = new Uint8Array(first.buffer);
  let bufferReads = 0;
  Object.defineProperty(view, "buffer", {
    get() {
      bufferReads += 1;
      return bufferReads === 1 ? first.buffer : later.buffer;
    },
  });
  return {
    view,
    bufferReads: () => bufferReads,
  };
}

function makeStatefulDimension(values) {
  let reads = 0;
  return {
    value: {
      valueOf() {
        const value = values[Math.min(reads, values.length - 1)];
        reads += 1;
        return value;
      },
    },
    reads: () => reads,
  };
}

function nextUp(value) {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) {
    return value;
  }
  if (value === 0) {
    return Number.MIN_VALUE;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n, false);
  return view.getFloat64(0, false);
}

function nextDown(value) {
  return -nextUp(-value);
}

function assertIndexedMatchesRgba(indexed, rgba, width, height, label) {
  assert.equal(indexed.pixelFormat, INDEXED_PIXEL_FORMAT, `${label}: pixel format`);
  assert.equal(indexed.visibleCount, rgba.visibleCount, `${label}: visible count`);
  if (Object.prototype.hasOwnProperty.call(rgba, "validCount")) {
    assert.equal(indexed.validCount, rgba.validCount, `${label}: valid count`);
  }
  assert.deepEqual(expandIndexedLayerToRgba(indexed, width, height), rgba.rgba, `${label}: RGBA`);
}

test("indexed encoder emits deterministic valid PLTE/tRNS PNGs with exact decoded RGBA", () => {
  const width = 3;
  const height = 2;
  const indices = Buffer.from([0, 1, 2, 3, 2, 1]);
  const palette = Buffer.from([0, 0, 0, 0, 10, 20, 30, 64, 40, 50, 60, 173, 70, 80, 90, 255]);
  const body = encodeIndexedPngFilter0(indices, palette, width, height, 1);
  assert.deepEqual(body, encodeIndexedPngFilter0(indices, palette, width, height, 1));
  const chunks = parsePngChunks(body);
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ["IHDR", "PLTE", "tRNS", "IDAT", "IEND"],
  );
  assert.equal(chunks[0].data[8], 8);
  assert.equal(chunks[0].data[9], 3);
  assert.deepEqual(chunks[1].data, Buffer.from([0, 0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90]));
  assert.deepEqual(chunks[2].data, Buffer.from([0, 64, 173, 255]));
  assert.deepEqual(PNG.sync.read(body).data, expandIndices(indices, palette));
});

test("static palette construction deduplicates RGBA, reserves transparent index zero, and enforces 256 entries", () => {
  const first = { colors: Buffer.from([9, 8, 7, 0, 1, 2, 3, 120, 4, 5, 6, 255]) };
  const second = { colors: Buffer.from([80, 70, 60, 0, 1, 2, 3, 120, 7, 8, 9, 255]) };
  const palette = buildIndexedPalette([first, second]);
  assert.equal(palette.entries, 4);
  assert.deepEqual(palette.rgba, Buffer.from([0, 0, 0, 0, 1, 2, 3, 120, 4, 5, 6, 255, 7, 8, 9, 255]));
  assert.deepEqual(palette.indicesByLookup.get(first), Uint8Array.from([0, 1, 2]));
  assert.deepEqual(palette.indicesByLookup.get(second), Uint8Array.from([0, 1, 3]));

  const tooManyColors = Buffer.alloc(256 * 4);
  for (let index = 0; index < 256; index += 1) {
    tooManyColors[index * 4] = index;
    tooManyColors[index * 4 + 1] = 255 - index;
    tooManyColors[index * 4 + 2] = index ^ 0x5a;
    tooManyColors[index * 4 + 3] = 255;
  }
  assert.throws(() => buildIndexedPalette([{ colors: tooManyColors }]), /exceeds 256 entries/);
});

test("indexed encoder rejects malformed palettes and out-of-range external indices", () => {
  assert.throws(() => encodeIndexedPngFilter0(Buffer.from([0]), Buffer.alloc(0), 1, 1, 1), /1 to 256/);
  assert.throws(
    () => encodeIndexedPngFilter0(Buffer.from([0, 2]), Buffer.from([0, 0, 0, 0, 1, 2, 3, 255]), 2, 1, 1),
    /palette index 2/,
  );
  assert.throws(
    () => encodeIndexedPngFilter0(Buffer.from([0]), Buffer.from([0, 0, 0, 0]), 2, 1, 1),
    /expected 2 indices/,
  );
  assert.throws(
    () => encodeIndexedPngFilter0(Buffer.from([3]), Buffer.from([0, 0, 0, 0]), 1, 1, 1, { indicesAreValidated: true }),
    /palette index 3/,
  );
});

test("pooled generic encoder cannot forge an index-validation bypass", async () => {
  await assert.rejects(
    encodeIndexedPngFilter0ViaPool(
      Buffer.from([4]),
      Buffer.from([0, 0, 0, 0]),
      1,
      1,
      1,
      { dead: false, submit: () => assert.fail("invalid indices reached the pool") },
      null,
      { indicesAreValidated: true },
    ),
    /palette index 4/,
  );
});

test("generic sync indexed encoding validates and encodes one exact snapshot", () => {
  const indices = makeBufferSwappingUint8Array([0], [1]);
  const palette = makeBufferSwappingUint8Array([0, 0, 0, 0], [200, 100, 50, 255]);
  const body = encodeIndexedPngFilter0(indices.view, palette.view, 1, 1, 1);

  assert.equal(indices.bufferReads(), 1, "indices must be captured exactly once");
  assert.equal(palette.bufferReads(), 1, "palette must be captured exactly once");
  assert.deepEqual(PNG.sync.read(body).data, Buffer.from([0, 0, 0, 0]));
});

test("generic pooled indexed encoding validates, submits, and assembles one exact snapshot", async () => {
  const indices = makeBufferSwappingUint8Array([0], [1]);
  const palette = makeBufferSwappingUint8Array([0, 0, 0, 0], [200, 100, 50, 255]);
  const body = await encodeIndexedPngFilter0ViaPool(indices.view, palette.view, 1, 1, 1, {
    dead: false,
    submit: (kind, raw, level) => Promise.resolve(compressSync(kind, Buffer.from(raw), level)),
  });

  assert.equal(indices.bufferReads(), 1, "indices must be captured exactly once");
  assert.equal(palette.bufferReads(), 1, "palette must be captured exactly once");
  assert.deepEqual(PNG.sync.read(body).data, Buffer.from([0, 0, 0, 0]));
});

test("generic raster encoding cannot re-read caller-controlled indexed backing buffers after validation", () => {
  const indices = makeBufferSwappingUint8Array([0], [1]);
  const palette = makeBufferSwappingUint8Array([0, 0, 0, 0], [200, 100, 50, 255]);
  const descriptor = encodeLayerOrEmpty(
    {
      pixelFormat: INDEXED_PIXEL_FORMAT,
      indices: indices.view,
      paletteRgba: palette.view,
      visibleCount: 1,
    },
    Buffer.from("empty"),
    1,
    1,
    1,
    0,
  );

  assert.equal(indices.bufferReads(), 1, "indices must be captured exactly once");
  assert.equal(palette.bufferReads(), 1, "palette must be captured exactly once");
  assert.deepEqual(PNG.sync.read(descriptor.body).data, Buffer.from([0, 0, 0, 0]));
});

test("generic indexed encoders canonicalize stateful dimensions once before validation", async () => {
  const indices = Buffer.from([2]);
  const palette = Buffer.from([0, 0, 0, 0, 10, 20, 30, 255]);
  const syncWidth = makeStatefulDimension([1, 0, 1, 1, 1]);
  const syncHeight = makeStatefulDimension([1, 0, 1, 1, 1]);

  assert.throws(
    () => encodeIndexedPngFilter0(indices, palette, syncWidth.value, syncHeight.value, 1),
    /palette index 2/,
  );
  assert.equal(syncWidth.reads(), 1);
  assert.equal(syncHeight.reads(), 1);

  const pooledWidth = makeStatefulDimension([1, 0, 1, 1, 1]);
  const pooledHeight = makeStatefulDimension([1, 0, 1, 1, 1]);
  await assert.rejects(
    encodeIndexedPngFilter0ViaPool(indices, palette, pooledWidth.value, pooledHeight.value, 1, {
      dead: false,
      submit: () => assert.fail("invalid indices reached the pool"),
    }),
    /palette index 2/,
  );
  assert.equal(pooledWidth.reads(), 1);
  assert.equal(pooledHeight.reads(), 1);
});

test("indexed and RGBA scanline scratches are distinct, released, and reused", () => {
  _testResetPngRawScratch();
  const indexed = encodeIndexedPngFilter0(Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0, 0, 0]), 2, 2, 1);
  const indexedBuffer = _testIndexedPngRawScratchSlot().buffer;
  assert.equal(_testIndexedPngRawScratchSlot().inUse, false);
  assert.ok(indexedBuffer);
  assert.deepEqual(encodeIndexedPngFilter0(Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0, 0, 0]), 2, 2, 1), indexed);
  assert.strictEqual(_testIndexedPngRawScratchSlot().buffer, indexedBuffer);
  encodeRgbaPngFilter0(Buffer.alloc(16), 2, 2, 1);
  assert.equal(_testPngRawScratchSlot().inUse, false);
  assert.notStrictEqual(_testPngRawScratchSlot().buffer, indexedBuffer);
});

test("pooled indexed encoder owns generic indices and palette across success and every fallback", async (t) => {
  const originalIndices = Buffer.from([0, 1, 2, 1]);
  const originalPalette = Buffer.from([0, 0, 0, 0, 20, 30, 40, 127, 50, 60, 70, 255]);
  const expected = encodeIndexedPngFilter0(originalIndices, originalPalette, 2, 2, 1);

  async function runCase(name, makePool, settle, expectedCounters) {
    await t.test(name, async () => {
      const indices = Buffer.from(originalIndices);
      const palette = Buffer.from(originalPalette);
      const counters = { jobs: 0, fallbacks: 0 };
      const state = {};
      const pool = makePool(state);
      const promise = encodeIndexedPngFilter0ViaPool(indices, palette, 2, 2, 1, pool, counters);
      indices.fill(0);
      palette.fill(9);
      if (settle) {
        settle(state);
      }
      assert.deepEqual(await promise, expected);
      assert.equal(_testIndexedPngRawScratchSlot().inUse, false);
      assert.deepEqual(counters, expectedCounters);
    });
  }

  await runCase(
    "pool success",
    (state) => ({
      dead: false,
      submit(kind, raw, level) {
        state.raw = Buffer.from(raw);
        state.level = level;
        return new Promise((resolve) => {
          state.resolve = resolve;
        });
      },
    }),
    (state) => state.resolve(compressSync("png-idat", state.raw, state.level)),
    { jobs: 1, fallbacks: 0 },
  );
  await runCase(
    "synchronous submit throw",
    () => ({
      dead: false,
      submit() {
        throw new Error("sync worker failure");
      },
    }),
    null,
    { jobs: 0, fallbacks: 1 },
  );
  await runCase(
    "asynchronous rejection",
    (state) => ({
      dead: false,
      submit() {
        return new Promise((resolve, reject) => {
          state.reject = reject;
        });
      },
    }),
    (state) => state.reject(new Error("async worker failure")),
    { jobs: 0, fallbacks: 1 },
  );
  await runCase("dead pool", () => ({ dead: true }), null, { jobs: 0, fallbacks: 1 });
});

test("scalar indexed rendering preserves exact step boundaries, visibility, NaN handling, and partial alpha", () => {
  const lookup = createStepColorLookup(
    [
      [-5, [2, 3, 4, 0]],
      [0.01, [10, 20, 30, 0.25]],
      [0.1, [40, 50, 60, 0.6]],
      [1, [70, 80, 90, 1]],
    ],
    0.8,
  );
  const values = Float64Array.from([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    nextDown(0.01),
    0.01,
    nextUp(0.01),
    nextDown(0.1),
    0.1,
    nextUp(0.1),
    1,
    nextUp(1),
  ]);
  const options = { values, width: values.length, height: 1, colorLookup: lookup, minVisible: 0.01 };
  const rgba = renderScalarGrid(options);
  const indexed = renderScalarGrid({ ...options, outputFormat: INDEXED_PIXEL_FORMAT });
  assertIndexedMatchesRgba(indexed, rgba, values.length, 1, "scalar step");
  const productionPrecip = renderScalarGrid({
    values: Float64Array.from([0.01]),
    width: 1,
    height: 1,
    ...CORE_LAYER_RENDER_OPTIONS.precip,
    outputFormat: INDEXED_PIXEL_FORMAT,
  });
  assert.equal(productionPrecip.paletteEntries, 11);
  assert.ok(
    Array.from(expandIndexedLayerToRgba(indexed, values.length, 1)).some(
      (value, index) => index % 4 === 3 && value > 0 && value < 255,
    ),
  );
});

test("single-lookup indexed palettes rebuild after exported lookup colors mutate", () => {
  const lookup = createStepColorLookup([
    [0, [0, 0, 0, 0]],
    [1, [20, 40, 60, 1]],
  ]);
  const options = {
    values: Float64Array.of(1),
    width: 1,
    height: 1,
    colorLookup: lookup,
    minVisible: 1,
  };
  const beforeRgba = renderScalarGrid(options);
  const beforeIndexed = renderScalarGrid({ ...options, outputFormat: INDEXED_PIXEL_FORMAT });
  assertIndexedMatchesRgba(beforeIndexed, beforeRgba, 1, 1, "single cache seed");

  lookup.colors[4] = 211;
  const afterRgba = renderScalarGrid(options);
  const afterIndexed = renderScalarGrid({ ...options, outputFormat: INDEXED_PIXEL_FORMAT });
  assert.notDeepEqual(afterRgba.rgba, beforeRgba.rgba);
  assertIndexedMatchesRgba(afterIndexed, afterRgba, 1, 1, "single cache rebuild");
});

test("fused reflectivity indexed gates preserve threshold ULPs and decoded RGBA", () => {
  const lookup = CORE_LAYER_RENDER_OPTIONS.reflectivity.colorLookup;
  const probes = [Number.NaN, Number.NEGATIVE_INFINITY, 9.999, 10, 15, 20, 100];
  for (const threshold of lookup.thresholds) {
    probes.push(nextDown(threshold), threshold, nextUp(threshold));
  }
  const values = Float64Array.from(probes);
  const gates = [10, 15, 20, 27];
  const options = { values, width: values.length, height: 1, colorLookup: lookup, gates };
  const rgbaLayers = renderReflectivityGateLayers(options);
  const indexedLayers = renderReflectivityGateLayers({ ...options, outputFormat: INDEXED_PIXEL_FORMAT });
  assert.equal(indexedLayers[0].paletteEntries, 27);
  for (let index = 0; index < gates.length; index += 1) {
    assertIndexedMatchesRgba(indexedLayers[index], rgbaLayers[index], values.length, 1, `gate ${gates[index]}`);
  }
});

test("precip-rate and reflectivity phase palettes preserve thresholds and freezing/sleet/snow/rain precedence", () => {
  const phases = {
    rain: Float64Array.from([1, 1, 1, 1, 1, 1, 1, 0.49]),
    snow: Float64Array.from([1, 1, 1, 1, 1, 1, 0.49, 1]),
    freezingRain: Float64Array.from([1, 0.49, 0.49, 0.49, 1, 0.49, 0.49, 0.49]),
    sleet: Float64Array.from([1, 1, 0.49, 0.49, 0.49, 1, 0.49, 0.49]),
  };
  const rateThresholds = Array.from(PRECIP_RATE_TYPE_LOOKUPS.rain.thresholds);
  const rateInHr = [
    nextDown(0.01),
    0.01,
    nextUp(0.01),
    ...rateThresholds.slice(1, 4),
    nextDown(rateThresholds[4]),
    nextUp(rateThresholds[4]),
  ];
  const precipRate = Float64Array.from(rateInHr.map((value) => value / PRATE_KG_M2_S_TO_IN_HR));
  const rateOptions = { precipRate, ...phases, width: precipRate.length, height: 1 };
  const indexedRate = renderPrecipRateTypeGrid({ ...rateOptions, outputFormat: INDEXED_PIXEL_FORMAT });
  assert.equal(indexedRate.paletteEntries, 28);
  assertIndexedMatchesRgba(
    indexedRate,
    renderPrecipRateTypeGrid(rateOptions),
    precipRate.length,
    1,
    "precip rate/type",
  );

  const dbzThresholds = Array.from(REFLECTIVITY_PRECIP_TYPE_LOOKUPS.rain.thresholds);
  const reflectivityDbz = Float64Array.from([
    Number.NaN,
    nextDown(dbzThresholds[0]),
    dbzThresholds[0],
    nextUp(dbzThresholds[0]),
    dbzThresholds[1],
    nextDown(dbzThresholds[2]),
    dbzThresholds[2],
    nextUp(dbzThresholds[2]),
  ]);
  const reflectivityOptions = { reflectivityDbz, ...phases, width: reflectivityDbz.length, height: 1 };
  const indexedReflectivity = renderReflectivityPrecipTypeGrid({
    ...reflectivityOptions,
    outputFormat: INDEXED_PIXEL_FORMAT,
  });
  assert.equal(indexedReflectivity.paletteEntries, 101);
  assertIndexedMatchesRgba(
    indexedReflectivity,
    renderReflectivityPrecipTypeGrid(reflectivityOptions),
    reflectivityDbz.length,
    1,
    "reflectivity/type",
  );
});

test("multi-lookup phase palettes rebuild after exported lookup colors mutate", () => {
  const rateColors = PRECIP_RATE_TYPE_LOOKUPS.rain.colors;
  const reflectivityColors = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.rain.colors;
  const savedRateColors = Buffer.from(rateColors);
  const savedReflectivityColors = Buffer.from(reflectivityColors);
  const phases = {
    rain: Float64Array.of(1),
    snow: Float64Array.of(0),
    freezingRain: Float64Array.of(0),
    sleet: Float64Array.of(0),
  };
  const rateOptions = {
    precipRate: Float64Array.of(0.001),
    ...phases,
    width: 1,
    height: 1,
  };
  const reflectivityOptions = {
    reflectivityDbz: Float64Array.of(30),
    ...phases,
    width: 1,
    height: 1,
  };

  try {
    const beforeRate = renderPrecipRateTypeGrid(rateOptions);
    assertIndexedMatchesRgba(
      renderPrecipRateTypeGrid({ ...rateOptions, outputFormat: INDEXED_PIXEL_FORMAT }),
      beforeRate,
      1,
      1,
      "rate cache seed",
    );
    const beforeReflectivity = renderReflectivityPrecipTypeGrid(reflectivityOptions);
    assertIndexedMatchesRgba(
      renderReflectivityPrecipTypeGrid({ ...reflectivityOptions, outputFormat: INDEXED_PIXEL_FORMAT }),
      beforeReflectivity,
      1,
      1,
      "reflectivity cache seed",
    );

    for (let offset = 0; offset < rateColors.length; offset += 4) {
      if (rateColors[offset + 3] > 0) {
        rateColors[offset] = (rateColors[offset] + 37) & 255;
      }
    }
    for (let offset = 0; offset < reflectivityColors.length; offset += 4) {
      if (reflectivityColors[offset + 3] > 0) {
        reflectivityColors[offset + 1] = (reflectivityColors[offset + 1] + 53) & 255;
      }
    }

    const afterRate = renderPrecipRateTypeGrid(rateOptions);
    assert.notDeepEqual(afterRate.rgba, beforeRate.rgba);
    assertIndexedMatchesRgba(
      renderPrecipRateTypeGrid({ ...rateOptions, outputFormat: INDEXED_PIXEL_FORMAT }),
      afterRate,
      1,
      1,
      "rate cache rebuild",
    );
    const afterReflectivity = renderReflectivityPrecipTypeGrid(reflectivityOptions);
    assert.notDeepEqual(afterReflectivity.rgba, beforeReflectivity.rgba);
    assertIndexedMatchesRgba(
      renderReflectivityPrecipTypeGrid({ ...reflectivityOptions, outputFormat: INDEXED_PIXEL_FORMAT }),
      afterReflectivity,
      1,
      1,
      "reflectivity cache rebuild",
    );
  } finally {
    savedRateColors.copy(rateColors);
    savedReflectivityColors.copy(reflectivityColors);
    renderPrecipRateTypeGrid({ ...rateOptions, outputFormat: INDEXED_PIXEL_FORMAT });
    renderReflectivityPrecipTypeGrid({ ...reflectivityOptions, outputFormat: INDEXED_PIXEL_FORMAT });
  }
});

test("indexed raster encoding falls back safely for malformed forged layers and expands exact RGBA for nonzero filters", async () => {
  const emptyPng = Buffer.from("known-type6-empty");
  const malformed = {
    pixelFormat: INDEXED_PIXEL_FORMAT,
    indices: Buffer.from([0, 9]),
    indicesValidated: true,
    paletteRgba: Buffer.from([0, 0, 0, 0, 10, 20, 30, 255]),
    visibleCount: 1,
  };
  assert.strictEqual(encodeLayerOrEmpty(malformed, emptyPng, 2, 1, 1, 0).body, emptyPng);
  assert.strictEqual(encodeLayerOrEmpty(malformed, emptyPng, 2, 1, 1, 1).body, emptyPng);
  const malformedDeferred = encodeLayerOrEmptyDeferred(malformed, emptyPng, 2, 1, 1, 0, {
    pool: { dead: false, submit: () => assert.fail("malformed layer reached pool") },
    counters: { jobs: 0, fallbacks: 0 },
  });
  assert.equal(malformedDeferred.pending, null);
  assert.strictEqual(malformedDeferred.descriptor.body, emptyPng);

  const lookup = createStepColorLookup([
    [0, [0, 0, 0, 0]],
    [1, [20, 40, 60, 0.5]],
    [2, [80, 100, 120, 1]],
  ]);
  const options = {
    values: Float64Array.from([0, 1, 2, Number.NaN]),
    width: 4,
    height: 1,
    colorLookup: lookup,
    minVisible: 1,
  };
  const rgba = renderScalarGrid(options);
  const indexed = renderScalarGrid({ ...options, outputFormat: INDEXED_PIXEL_FORMAT });
  const indexedBody = encodeLayerOrEmpty(indexed, emptyPng, 4, 1, 1, 1).body;
  const rgbaBody = encodeLayerOrEmpty(rgba, emptyPng, 4, 1, 1, 1).body;
  assert.equal(indexedBody[25], 6);
  assert.deepEqual(indexedBody, rgbaBody);
});

test("renderer-owned indexed layers expose frozen metadata only before sync encoding", () => {
  const emptyPng = Buffer.from("empty");
  const lookup = createStepColorLookup([
    [0, [0, 0, 0, 0]],
    [1, [20, 40, 60, 128]],
    [2, [80, 100, 120, 255]],
  ]);
  const options = {
    values: Float64Array.from([0, 1, 2, 1]),
    width: 4,
    height: 1,
    colorLookup: lookup,
    minVisible: 1,
    outputFormat: INDEXED_PIXEL_FORMAT,
  };
  const expected = encodeLayerOrEmpty(renderScalarGrid(options), emptyPng, 4, 1, 1, 0).body;
  const layer = renderScalarGrid(options);

  assert.equal(Object.isFrozen(layer), true);
  assert.equal(layer.paletteEntries, 3);
  assert.equal("indices" in layer, false);
  assert.equal("paletteRgba" in layer, false);
  assert.throws(() => {
    layer.indices = Buffer.from([255, 255, 255, 255]);
  }, TypeError);
  assert.throws(() => {
    layer.paletteRgba = Buffer.from([9, 9, 9, 9]);
  }, TypeError);

  const actual = encodeLayerOrEmpty(layer, emptyPng, 4, 1, 1, 0).body;
  assert.deepEqual(actual, expected);
  assert.deepEqual(PNG.sync.read(actual).data, PNG.sync.read(expected).data);
});

test("renderer-owned indexed bytes remain unreachable while deferred work waits for coordinator admission", async () => {
  const emptyPng = Buffer.from("empty");
  const lookup = createStepColorLookup([
    [0, [0, 0, 0, 0]],
    [1, [10, 20, 30, 180]],
  ]);
  const options = {
    values: Float64Array.from([0, 1]),
    width: 2,
    height: 1,
    colorLookup: lookup,
    minVisible: 1,
    outputFormat: INDEXED_PIXEL_FORMAT,
  };
  const expected = encodeLayerOrEmpty(renderScalarGrid(options), emptyPng, 2, 1, 1, 0).body;
  const layer = renderScalarGrid(options);
  let start;
  const coordinator = {
    schedule(fn) {
      return new Promise((resolve, reject) => {
        start = () => Promise.resolve(fn()).then(resolve, reject);
      });
    },
  };
  const encoded = encodeLayerOrEmptyDeferred(layer, emptyPng, 2, 1, 1, 0, {
    pool: {
      dead: false,
      submit: (kind, raw, level) => Promise.resolve(compressSync(kind, Buffer.from(raw), level)),
    },
    counters: { jobs: 0, fallbacks: 0 },
    coordinator,
  });

  assert.equal(Object.isFrozen(layer), true);
  assert.equal("indices" in layer, false);
  assert.equal("paletteRgba" in layer, false);
  assert.throws(() => {
    Object.defineProperty(layer, "indices", { value: Buffer.from([255, 255]) });
  }, TypeError);
  start();
  await encoded.pending;
  assert.deepEqual(encoded.descriptor.body, expected);
  assert.deepEqual(PNG.sync.read(encoded.descriptor.body).data, PNG.sync.read(expected).data);
});

test("deferred generic indexed layers snapshot before coordinator admission", async () => {
  const indices = Buffer.from([0, 1]);
  const palette = Buffer.from([0, 0, 0, 0, 10, 20, 30, 180]);
  const layer = {
    pixelFormat: INDEXED_PIXEL_FORMAT,
    indices,
    paletteRgba: palette,
    visibleCount: 1,
  };
  const expected = encodeLayerOrEmpty(layer, Buffer.from("empty"), 2, 1, 1, 0).body;
  let start;
  const coordinator = {
    schedule(fn) {
      return new Promise((resolve, reject) => {
        start = () => Promise.resolve(fn()).then(resolve, reject);
      });
    },
  };
  const encoded = encodeLayerOrEmptyDeferred(layer, Buffer.from("empty"), 2, 1, 1, 0, {
    pool: {
      dead: false,
      submit: (kind, raw, level) => Promise.resolve(compressSync(kind, Buffer.from(raw), level)),
    },
    counters: { jobs: 0, fallbacks: 0 },
    coordinator,
  });
  indices.fill(0);
  palette.fill(255);
  start();
  await encoded.pending;
  assert.deepEqual(encoded.descriptor.body, expected);
});

test("renderer emits indexed categorical scope, exact telemetry arithmetic, log counters, and v52 signature", async () => {
  const cellCount = 4;
  const all = (value) => Float32Array.from({ length: cellCount }, () => value);
  const precipRateTypeEntry = NOAA_NAM_PARAMETER_CATALOG.find((entry) => entry.kind === "precipRateType");
  const profile = { stages: {} };
  const artifacts = await buildRenderedArtifacts({
    decoded: {
      temperature2m: all(300),
      precip: all(25.4),
      precipRate: all(0.001),
      precipRateTypeRain: all(1),
      precipRateTypeSnow: all(0),
      precipRateTypeFreezingRain: all(0),
      precipRateTypeIcePellets: all(0),
      reflectivityComposite: all(30),
      reflectivity1km: all(30),
      precipTypeRain: all(1),
      precipTypeSnow: all(0),
      precipTypeFreezingRain: all(0),
      precipTypeIcePellets: all(0),
    },
    selection: {
      catalog: [precipRateTypeEntry],
      availableParameters: [precipRateTypeEntry.key, "reflectivity1kmPrecipType"],
      records: {},
    },
    framePlan: { hour: 3, validTime: "2026-07-23T03:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "hrrr",
    width: 2,
    height: 2,
    reflectivityGates: [10, 15, 20],
    pngCompressionLevel: 1,
    pngFilterType: 0,
    hoverGridFormat: "binary",
    profile,
  });
  assert.equal(profile.indexedPngJobs, 9);
  assert.equal(profile.indexedPngRawBytes, 54);
  assert.equal(profile.indexedPngRgbaRawBytesAvoided, 108);
  assert.match(formatRenderProfile(profile), /indexedJobs=9 indexedRawBytes=54 indexedRawSaved=108/);
  for (const key of [
    "precip",
    "reflectivityComposite",
    "reflectivity1km",
    "reflectivity1kmPrecipType",
    "precipRateAndType",
  ]) {
    assert.equal(artifacts.layers[key].body[25], 3, key);
  }
  assert.equal(artifacts.layers.temperature.body[25], 6, "continuous layers stay RGBA");
  assert.equal(artifacts.layers.wind.body[25], 6, "cached empty PNGs stay RGBA");
  assert.match(getNoaaGribRendererSignature(), /^[a-f0-9]{16}$/);
  assert.equal(getNoaaGribRendererSignature(), getNoaaGribRendererSignature());
});
