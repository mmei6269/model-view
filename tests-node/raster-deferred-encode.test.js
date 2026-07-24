"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { compressSync } = require("../scripts/lib/noaa-beta/compress-pool");
const { encodeLayerOrEmpty, encodeLayerOrEmptyDeferred } = require("../scripts/lib/noaa-beta/raster");
const { _testBuildRenderedArtifacts: buildRenderedArtifacts } = require("../scripts/lib/noaa-beta-renderer");

const WIDTH = 2;
const HEIGHT = 2;
const EMPTY_PNG = Buffer.from("stub-empty-png");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Same codec entry point as the compression-pool fallback, so deferred bodies
// must equal the inline encode byte for byte. The stub pool consumes its input
// synchronously at submit (as the real pool's structured clone does), which
// keeps it compatible with the scanline-scratch release-after-submit contract.
const stubPool = {
  dead: false,
  submit: (kind, buffer, level) => Promise.resolve(compressSync(kind, buffer, level)),
};
const stubEncodeContext = { pool: stubPool, counters: null };

function visibleLayer() {
  const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
  rgba[0] = 255;
  rgba[3] = 255;
  return { rgba, visibleCount: 1, validCount: WIDTH * HEIGHT };
}

test("deferred encode returns a null-body descriptor resolved by its pending promise", async () => {
  const layer = visibleLayer();
  const { descriptor, pending } = encodeLayerOrEmptyDeferred(layer, EMPTY_PNG, WIDTH, HEIGHT, 1, 0, stubEncodeContext);
  assert.equal(descriptor.body, null);
  assert.equal(descriptor.bytes, 0);
  assert.equal(descriptor.contentType, "image/png");
  assert.ok(pending && typeof pending.then === "function");
  await pending;
  assert.ok(Buffer.isBuffer(descriptor.body));
  assert.deepEqual(descriptor.body.subarray(0, 8), PNG_SIGNATURE);
  assert.equal(descriptor.bytes, descriptor.body.length);
  assert.deepEqual(descriptor.body, encodeLayerOrEmpty(layer, EMPTY_PNG, WIDTH, HEIGHT, 1, 0).body);
});

test("empty layers stay inline even with a compressor and filter type 0", () => {
  const emptyLayers = [null, { rgba: Buffer.alloc(WIDTH * HEIGHT * 4), visibleCount: 0, validCount: 0 }];
  for (const layer of emptyLayers) {
    const { descriptor, pending } = encodeLayerOrEmptyDeferred(
      layer,
      EMPTY_PNG,
      WIDTH,
      HEIGHT,
      1,
      0,
      stubEncodeContext,
    );
    assert.equal(pending, null);
    assert.strictEqual(descriptor.body, EMPTY_PNG);
    assert.equal(descriptor.bytes, EMPTY_PNG.length);
    assert.equal(descriptor.contentType, "image/png");
  }
});

test("non-filter-0 layers stay inline even with a compressor", () => {
  const layer = visibleLayer();
  const { descriptor, pending } = encodeLayerOrEmptyDeferred(layer, EMPTY_PNG, WIDTH, HEIGHT, 1, 1, stubEncodeContext);
  assert.equal(pending, null);
  assert.ok(Buffer.isBuffer(descriptor.body) && descriptor.body.length > 0);
  assert.deepEqual(descriptor, encodeLayerOrEmpty(layer, EMPTY_PNG, WIDTH, HEIGHT, 1, 1));
});

test("missing compressor keeps filter-0 layers inline", () => {
  const layer = visibleLayer();
  const { descriptor, pending } = encodeLayerOrEmptyDeferred(layer, EMPTY_PNG, WIDTH, HEIGHT, 1, 0, null);
  assert.equal(pending, null);
  assert.deepEqual(descriptor, encodeLayerOrEmpty(layer, EMPTY_PNG, WIDTH, HEIGHT, 1, 0));
});

test("buildRenderedArtifacts drains deferred layer bodies before returning", async () => {
  const frameArgs = () => ({
    decoded: { temperature2m: new Float32Array([300, 300, 300, 300]) },
    selection: { catalog: [], availableParameters: [], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: WIDTH,
    height: HEIGHT,
    reflectivityGates: [15],
    pngCompressionLevel: 1,
    pngFilterType: 0,
  });
  const deferred = await buildRenderedArtifacts({ ...frameArgs(), layerEncodeContext: stubEncodeContext });
  assert.equal(deferred.pendingEncodes, undefined);
  assert.ok(Buffer.isBuffer(deferred.layers.temperature.body));
  assert.deepEqual(deferred.layers.temperature.body.subarray(0, 8), PNG_SIGNATURE);
  assert.equal(deferred.layers.temperature.bytes, deferred.layers.temperature.body.length);
  // Empty layers (no wind grids decoded) encode inline in both modes, and the
  // deferred temperature body matches the no-compressor inline render exactly.
  assert.ok(Buffer.isBuffer(deferred.layers.wind.body));
  const inline = await buildRenderedArtifacts(frameArgs());
  assert.deepEqual(deferred.layers.temperature.body, inline.layers.temperature.body);
  assert.deepEqual(deferred.layers.wind.body, inline.layers.wind.body);
});
