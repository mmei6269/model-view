"use strict";

// Worker-local filter-0 scanline scratch (png-encode.js): one slot per worker
// serves every layer's raw scanline buffer. These tests pin the safety
// invariants the reuse relies on — full-overwrite semantics, release-after-
// submit race-freedom against a real compression pool, identical inline
// fallback bytes on pool failure, size-growth handling, and deterministic
// per-task cleanup — plus byte-identity against the allocating reference
// pipeline (buildPngFilter0Raw + deflatePngIdatSync + assemblePngFromIdat).

const assert = require("node:assert/strict");
const test = require("node:test");

const { CompressPool } = require("../scripts/lib/noaa-beta/compress-pool");
const { deflatePngIdatSync } = require("../scripts/lib/noaa-beta/deflate-backend");
const {
  _testPngRawScratchSlot,
  _testResetPngRawScratch,
  assemblePngFromIdat,
  buildPngFilter0Raw,
  encodeRgbaPngFilter0,
  encodeRgbaPngFilter0ViaPool,
  pngFilter0RawSize,
  withPngFilter0Raw,
} = require("../scripts/lib/noaa-beta/png-encode");

function patternRgba(width, height, seed = 0) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < rgba.length; index += 1) {
    rgba[index] = (index * 31 + seed * 17 + ((index >> 4) % 11)) & 255;
  }
  return rgba;
}

// Reference bytes via the allocating (pre-scratch) pipeline.
function referencePng(rgba, width, height, level = 1) {
  return assemblePngFromIdat(deflatePngIdatSync(buildPngFilter0Raw(rgba, width, height), level), width, height);
}

function scratchSlot() {
  return _testPngRawScratchSlot();
}

test.beforeEach(() => {
  _testResetPngRawScratch();
});

test("inline encodes reuse one scratch slot and stay byte-identical to the allocating pipeline", () => {
  const width = 6;
  const height = 4;
  const rgbaA = patternRgba(width, height, 1);
  const rgbaB = patternRgba(width, height, 2);
  const bodyA = encodeRgbaPngFilter0(rgbaA, width, height, 1);
  const slotAfterA = scratchSlot().buffer;
  assert.ok(slotAfterA && slotAfterA.length === pngFilter0RawSize(width, height));
  assert.equal(scratchSlot().inUse, false, "slot must be released after a synchronous encode");
  const bodyB = encodeRgbaPngFilter0(rgbaB, width, height, 1);
  assert.equal(scratchSlot().buffer, slotAfterA, "second encode must reuse the same slot buffer");
  assert.equal(scratchSlot().inUse, false);
  assert.deepEqual(bodyA, referencePng(rgbaA, width, height));
  assert.deepEqual(bodyB, referencePng(rgbaB, width, height));
});

test("overwrite semantics: stale bytes from a previous layer never leak into the next", () => {
  const width = 8;
  const height = 3;
  // First layer fills every byte with non-zero content; second is all zeros
  // except one pixel, so any stale byte would show up as a wrong scanline.
  const solid = Buffer.alloc(width * height * 4, 0xab);
  const sparse = Buffer.alloc(width * height * 4);
  sparse[3] = 0xff;
  assert.deepEqual(encodeRgbaPngFilter0(solid, width, height, 1), referencePng(solid, width, height));
  assert.deepEqual(encodeRgbaPngFilter0(sparse, width, height, 1), referencePng(sparse, width, height));
});

test("scratch grows and shrinks with frame size and stays byte-correct", () => {
  const small = patternRgba(2, 2, 3);
  const large = patternRgba(8, 5, 4);
  assert.deepEqual(encodeRgbaPngFilter0(small, 2, 2, 1), referencePng(small, 2, 2));
  const smallSlot = scratchSlot().buffer;
  assert.deepEqual(encodeRgbaPngFilter0(large, 8, 5, 1), referencePng(large, 8, 5));
  const largeSlot = scratchSlot().buffer;
  assert.notEqual(largeSlot, smallSlot, "size change must replace the slot buffer");
  assert.equal(largeSlot.length, pngFilter0RawSize(8, 5));
  assert.deepEqual(encodeRgbaPngFilter0(small, 2, 2, 1), referencePng(small, 2, 2));
  assert.equal(scratchSlot().buffer.length, pngFilter0RawSize(2, 2));
  assert.equal(scratchSlot().inUse, false);
});

test("nested checkout falls back to an unpooled buffer without corrupting the slot", () => {
  const width = 4;
  const height = 4;
  const outer = patternRgba(width, height, 5);
  const inner = patternRgba(width, height, 6);
  let innerBody = null;
  let slotDuringNested = null;
  const outerBody = withPngFilter0Raw(outer, width, height, () => {
    // The slot is checked out here; the nested encode must not reuse it.
    const nested = encodeRgbaPngFilter0(inner, width, height, 1);
    slotDuringNested = scratchSlot().inUse;
    innerBody = nested;
    return assemblePngFromIdat(deflatePngIdatSync(buildPngFilter0Raw(outer, width, height), 1), width, height);
  });
  assert.equal(slotDuringNested, true, "outer checkout must stay marked in use during the nested encode");
  assert.deepEqual(innerBody, referencePng(inner, width, height));
  assert.deepEqual(outerBody, referencePng(outer, width, height));
  assert.equal(scratchSlot().inUse, false, "nested release must not free the outer checkout");
});

test("zero-size encodes never touch the scratch slot", () => {
  const body = encodeRgbaPngFilter0(Buffer.alloc(0), 0, 0, 1);
  assert.deepEqual(body, referencePng(Buffer.alloc(0), 0, 0));
  assert.equal(scratchSlot().buffer, null);
  assert.equal(scratchSlot().inUse, false);
});

test("source-too-small layers throw the same error and release the slot", () => {
  const width = 4;
  const height = 4;
  const short = Buffer.alloc(8);
  assert.throws(
    () => encodeRgbaPngFilter0(short, width, height, 1),
    /Cannot encode RGBA PNG: expected 64 bytes, received 8\./,
  );
  assert.equal(scratchSlot().inUse, false);
});

test("pooled path is byte-identical and releases the slot while jobs are in flight", async () => {
  const pool = new CompressPool(1);
  const counters = { jobs: 0, fallbacks: 0 };
  try {
    const width = 8;
    const height = 4;
    const layers = Array.from({ length: 6 }, (_, index) => patternRgba(width, height, index + 1));
    // Submit every layer without awaiting: each submit clones synchronously,
    // so later layers overwrite the slot while earlier deflates are queued.
    const pending = layers.map((rgba) => encodeRgbaPngFilter0ViaPool(rgba, width, height, 1, pool, counters));
    assert.equal(scratchSlot().inUse, false, "slot must be free between deferred submits");
    // Interleave an inline encode that reuses the same slot mid-flight.
    const inlineRgba = patternRgba(width, height, 99);
    assert.deepEqual(encodeRgbaPngFilter0(inlineRgba, width, height, 1), referencePng(inlineRgba, width, height));
    const bodies = await Promise.all(pending);
    for (let index = 0; index < layers.length; index += 1) {
      assert.deepEqual(bodies[index], referencePng(layers[index], width, height), `layer ${index} bytes diverged`);
    }
    assert.equal(counters.jobs, layers.length);
    assert.equal(counters.fallbacks, 0);
    assert.equal(scratchSlot().inUse, false);
  } finally {
    pool.markDead(new Error("test done"));
  }
});

test("immediate slot overwrite after submit cannot corrupt an in-flight job", async () => {
  const pool = new CompressPool(1);
  try {
    const width = 16;
    const height = 8;
    const rgbaA = patternRgba(width, height, 7);
    const bodyPromise = encodeRgbaPngFilter0ViaPool(rgbaA, width, height, 1, pool, null);
    // Scribble through the slot with several unrelated encodes before awaiting.
    for (let seed = 0; seed < 4; seed += 1) {
      encodeRgbaPngFilter0(patternRgba(width, height, 40 + seed), width, height, 1);
    }
    assert.deepEqual(await bodyPromise, referencePng(rgbaA, width, height));
  } finally {
    pool.markDead(new Error("test done"));
  }
});

test("worker death mid-job rebuilds scanlines from the layer RGBA (byte-identical inline fallback)", async () => {
  const pool = new CompressPool(1);
  const counters = { jobs: 0, fallbacks: 0 };
  const width = 16;
  const height = 8;
  const rgbaA = patternRgba(width, height, 11);
  const rgbaB = patternRgba(width, height, 12);
  const bodyPromise = encodeRgbaPngFilter0ViaPool(rgbaA, width, height, 1, pool, counters);
  pool.markDead(new Error("simulated worker death"));
  // Overwrite the released slot with unrelated scanlines before the rejection
  // lands; the fallback must rebuild from rgbaA, not read the slot as-is.
  encodeRgbaPngFilter0(rgbaB, width, height, 1);
  assert.deepEqual(await bodyPromise, referencePng(rgbaA, width, height));
  assert.equal(counters.jobs, 0);
  assert.equal(counters.fallbacks, 1);
  assert.equal(scratchSlot().inUse, false);
  // A dead pool keeps producing the identical inline bytes.
  assert.deepEqual(
    await encodeRgbaPngFilter0ViaPool(rgbaB, width, height, 1, pool, counters),
    referencePng(rgbaB, width, height),
  );
  assert.equal(counters.fallbacks, 2);
});

test("worker death after caller reuses RGBA falls back from the submission-time pixels", async () => {
  const pool = new CompressPool(1);
  const counters = { jobs: 0, fallbacks: 0 };
  const width = 16;
  const height = 8;
  const rgba = patternRgba(width, height, 13);
  const submittedRgba = Buffer.from(rgba);
  const expected = referencePng(submittedRgba, width, height);
  const bodyPromise = encodeRgbaPngFilter0ViaPool(rgba, width, height, 1, pool, counters);

  // Reuse the caller-owned pixels before the asynchronous rejection lands.
  // The fallback must encode the bytes observed at submission, not these
  // replacement pixels.
  rgba.fill(0xa5);
  assert.notDeepEqual(referencePng(rgba, width, height), expected);
  pool.markDead(new Error("simulated worker death after source reuse"));

  assert.deepEqual(await bodyPromise, expected);
  assert.equal(counters.jobs, 0);
  assert.equal(counters.fallbacks, 1);
  assert.equal(scratchSlot().inUse, false);
});

test("missing pool deflates inline with identical bytes and counts a fallback", async () => {
  const counters = { jobs: 0, fallbacks: 0 };
  const width = 8;
  const height = 4;
  const rgba = patternRgba(width, height, 21);
  const body = await encodeRgbaPngFilter0ViaPool(rgba, width, height, 1, null, counters);
  assert.deepEqual(body, referencePng(rgba, width, height));
  assert.equal(counters.jobs, 0);
  assert.equal(counters.fallbacks, 1);
  assert.equal(scratchSlot().inUse, false);
});

test("synchronous submit failure deflates the scanlines in place (byte-identical)", async () => {
  const width = 8;
  const height = 4;
  const rgba = patternRgba(width, height, 31);
  const counters = { jobs: 0, fallbacks: 0 };
  const failingPool = {
    dead: false,
    submit: () => {
      throw new Error("synthetic synchronous submit failure");
    },
  };
  const body = await encodeRgbaPngFilter0ViaPool(rgba, width, height, 1, failingPool, counters);
  assert.deepEqual(body, referencePng(rgba, width, height));
  assert.equal(counters.jobs, 0);
  assert.equal(counters.fallbacks, 1);
  assert.equal(scratchSlot().inUse, false);
});
