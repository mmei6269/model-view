"use strict";

const zlib = require("zlib");
const { deflatePngIdatSync } = require("./deflate-backend");
const { PNG } = require("pngjs");
const { clampInt } = require("./util");

const TRANSPARENT_PNG_CACHE = new Map();

function encodeRgbaPng(rgba, width, height, compressionLevel = 1, filterType = 0) {
  if (Number(filterType) === 0) {
    return encodeRgbaPngFilter0(rgba, width, height, compressionLevel);
  }
  const png = new PNG({ width, height });
  png.data = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return PNG.sync.write(png, {
    colorType: 6,
    inputHasAlpha: true,
    compressionLevel,
    filterType,
  });
}

function buildPngFilter0Raw(rgba, width, height) {
  return writePngFilter0Raw(Buffer.allocUnsafe(pngFilter0RawSize(width, height)), rgba, width, height);
}

function pngFilter0RawSize(width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  return Math.max(0, (cols * 4 + 1) * rows);
}

function writePngFilter0Raw(target, rgba, width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const rowBytes = cols * 4;
  const imageBytes = rowBytes * rows;
  const source = toBufferView(rgba);
  if (source.length < imageBytes) {
    throw new Error(`Cannot encode RGBA PNG: expected ${imageBytes} bytes, received ${source.length}.`);
  }
  // Every byte is assigned below (one filter byte plus a full row copy per
  // scanline), so reusing a scratch buffer never leaks stale bytes between
  // layers, and the unsafe allocation never leaks uninitialized memory.
  for (let row = 0; row < rows; row += 1) {
    const sourceOffset = row * rowBytes;
    const targetOffset = row * (rowBytes + 1);
    target[targetOffset] = 0;
    source.copy(target, targetOffset + 1, sourceOffset, sourceOffset + rowBytes);
  }
  return target;
}

// Worker-local scratch slot for filter-0 scanline buffers. Each non-empty
// layer used to allocate a fresh ~6.3 MB scanline buffer here; across a
// ~70-layer conus frame that churned ~460 MB of transient codec buffers per
// frame (plus the matching GC), on top of the mandatory structured-clone copy
// the compression pool makes of every submit. The scanline bytes are consumed
// synchronously in every encode path — the inline deflate runs to completion,
// and CompressPool.submit structured-clones its input synchronously inside
// postMessage before it returns (verified: mutating the buffer right after
// submit never reaches the helper) — so one slot per worker serves every
// layer:
//   - a checkout spans only synchronous code, so nothing can observe the slot
//     mid-overwrite (JS runs each synchronous segment atomically);
//   - the deferred path releases the slot as soon as pool.submit returns; the
//     clone is complete by then, and the pool-failure fallback rebuilds its
//     own copy from an immutable submission-time RGBA source instead of
//     reading the slot, so reuse-while-in-flight cannot corrupt a queued or
//     retrying job;
//   - every checkout overwrites every byte before use (see writer above).
// The slot is the bounded per-worker pool: a single scanline buffer retained
// across frames, with deterministic per-task cleanup (every acquire is
// released within the same synchronous task, so inUse is always false once a
// frame's encode tasks settle).
const PNG_RAW_SCRATCH = { buffer: null, inUse: false };

function acquirePngRawScratch(size) {
  const slot = PNG_RAW_SCRATCH;
  if (size > 0 && !slot.inUse) {
    if (!slot.buffer || slot.buffer.length !== size) {
      slot.buffer = Buffer.allocUnsafe(size);
    }
    slot.inUse = true;
    return slot.buffer;
  }
  // Zero-length encodes and defensive nested checkouts get a fresh buffer
  // that releasePngRawScratch leaves alone.
  return Buffer.allocUnsafe(size);
}

function releasePngRawScratch(buffer) {
  const slot = PNG_RAW_SCRATCH;
  if (slot.inUse && slot.buffer === buffer) {
    slot.inUse = false;
  }
}

// Runs `fn` with the filter-0 scanline bytes for `rgba`; the scratch slot is
// held only for the synchronous duration of `fn`. `fn` must not retain the
// buffer — every consumer here copies or clones it synchronously.
function withPngFilter0Raw(rgba, width, height, fn) {
  const raw = acquirePngRawScratch(pngFilter0RawSize(width, height));
  try {
    writePngFilter0Raw(raw, rgba, width, height);
    return fn(raw);
  } finally {
    releasePngRawScratch(raw);
  }
}

function assemblePngFromIdat(idat, width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cols, 0);
  ihdr.writeUInt32BE(rows, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, createPngChunk("IHDR", ihdr), createPngChunk("IDAT", idat), PNG_IEND_CHUNK]);
}

function encodeRgbaPngFilter0(rgba, width, height, compressionLevel = 1) {
  const level = clampInt(compressionLevel, 0, 9, 1);
  return withPngFilter0Raw(rgba, width, height, (raw) =>
    assemblePngFromIdat(deflatePngIdatSync(raw, level), width, height),
  );
}

// Pool-offloaded variant: the scanlines build synchronously in the
// worker-local scratch slot, pool.submit structured-clones them
// synchronously, and the slot is released before the pooled deflate
// resolves — later layers overwrite the slot while this job is in flight.
// By default the source RGBA is snapshotted before submission and retained by
// this suspended call until settlement. That makes the asynchronous failure
// fallback reflect the bytes submitted even when a caller immediately reuses
// or mutates its buffer. Renderer-owned layers may opt out only when they stay
// immutable until the returned promise settles; that production invariant
// preserves the zero-allocation scanline-scratch fast path. Byte-identical to
// encodeRgbaPngFilter0 (same raw bytes, same codec entry points, same chunk
// assembly), and any pool failure resolves to the identical inline deflate
// and counts a fallback.
async function encodeRgbaPngFilter0ViaPool(
  rgba,
  width,
  height,
  compressionLevel,
  pool,
  counters = null,
  options = null,
) {
  const level = clampInt(compressionLevel, 0, 9, 1);
  const idat = await deflatePngIdatViaPool(rgba, width, height, level, pool, counters, options);
  return assemblePngFromIdat(idat, width, height);
}

async function deflatePngIdatViaPool(rgba, width, height, level, pool, counters, options) {
  if (!pool || pool.dead) {
    if (counters) {
      counters.fallbacks += 1;
    }
    return withPngFilter0Raw(rgba, width, height, (raw) => deflatePngIdatSync(raw, level));
  }
  // A generic caller may reuse its RGBA as soon as this async function
  // returns. Freeze the logical image bytes before the first await so a later
  // pool rejection cannot observe those replacement pixels. Internal raster
  // layers are freshly allocated and never written after submission, so that
  // trusted path keeps the original memory-saving behavior via the opt-out.
  const fallbackRgba = options?.rgbaIsImmutableUntilSettled ? rgba : snapshotPngRgba(rgba, width, height);
  let job;
  const raw = acquirePngRawScratch(pngFilter0RawSize(width, height));
  try {
    writePngFilter0Raw(raw, fallbackRgba, width, height);
    try {
      job = pool.submit("png-idat", raw, level);
    } catch (error) {
      // Synchronous submit failure: the slot has not been released yet, so the
      // inline fallback deflates the scanlines in place (the exact bytes the
      // createCompressor catch path would deflate).
      warnPngEncodePoolFailure(error);
      if (counters) {
        counters.fallbacks += 1;
      }
      return deflatePngIdatSync(raw, level);
    }
  } finally {
    // postMessage cloned the scanlines synchronously inside pool.submit, so
    // the slot is dead here even though the pooled deflate is still running;
    // neither the success path nor the retry path below reads it again.
    releasePngRawScratch(raw);
  }
  try {
    const body = await job;
    if (counters) {
      counters.jobs += 1;
    }
    return body;
  } catch (error) {
    warnPngEncodePoolFailure(error);
    if (counters) {
      counters.fallbacks += 1;
    }
    // The slot may have served later layers since submit, so rebuild from the
    // immutable submission source retained by this suspended call.
    return withPngFilter0Raw(fallbackRgba, width, height, (scratch) => deflatePngIdatSync(scratch, level));
  }
}

function snapshotPngRgba(rgba, width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const imageBytes = cols * rows * 4;
  const source = toBufferView(rgba);
  if (source.length < imageBytes) {
    throw new Error(`Cannot encode RGBA PNG: expected ${imageBytes} bytes, received ${source.length}.`);
  }
  return Buffer.from(source.subarray(0, imageBytes));
}

let pngEncodePoolFailureWarned = false;

function warnPngEncodePoolFailure(error) {
  if (pngEncodePoolFailureWarned) {
    return;
  }
  pngEncodePoolFailureWarned = true;
  console.warn(`[noaa-beta] compression pool unavailable; compressing inline: ${String(error?.message || error)}`);
}

function _testResetPngRawScratch() {
  PNG_RAW_SCRATCH.buffer = null;
  PNG_RAW_SCRATCH.inUse = false;
  pngEncodePoolFailureWarned = false;
}

function toBufferView(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(value || []);
}

function createTransparentPng(width, height, compressionLevel = 1, filterType = 0) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const resolvedCompressionLevel = clampInt(compressionLevel, 0, 9, 1);
  const resolvedFilterType = Math.round(Number(filterType) || 0);
  const cacheKey = `${cols}x${rows}:${resolvedCompressionLevel}:${resolvedFilterType}`;
  const cached = TRANSPARENT_PNG_CACHE.get(cacheKey);
  if (cached) {
    return Buffer.from(cached);
  }
  const body = encodeRgbaPng(
    Buffer.alloc(Math.max(0, cols * rows * 4)),
    cols,
    rows,
    resolvedCompressionLevel,
    resolvedFilterType,
  );
  TRANSPARENT_PNG_CACHE.set(cacheKey, body);
  return Buffer.from(body);
}

function buildPngCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function pngCrc32(type, data) {
  if (HAS_NATIVE_CRC32) {
    return zlib.crc32(data, zlib.crc32(type)) >>> 0;
  }
  let crc = 0xffffffff;
  for (let index = 0; index < type.length; index += 1) {
    crc = PNG_CRC_TABLE[(crc ^ type[index]) & 255] ^ (crc >>> 8);
  }
  for (let index = 0; index < data.length; index += 1) {
    crc = PNG_CRC_TABLE[(crc ^ data[index]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  const out = Buffer.allocUnsafe(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  typeBuffer.copy(out, 4);
  payload.copy(out, 8);
  out.writeUInt32BE(pngCrc32(typeBuffer, payload), 8 + payload.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const PNG_CRC_TABLE = buildPngCrcTable();

const HAS_NATIVE_CRC32 = typeof zlib.crc32 === "function";

const PNG_IEND_CHUNK = createPngChunk("IEND", Buffer.alloc(0));

module.exports = {
  HAS_NATIVE_CRC32,
  PNG_CRC_TABLE,
  PNG_IEND_CHUNK,
  PNG_SIGNATURE,
  TRANSPARENT_PNG_CACHE,
  _testPngRawScratchSlot: () => PNG_RAW_SCRATCH,
  _testResetPngRawScratch,
  assemblePngFromIdat,
  buildPngCrcTable,
  buildPngFilter0Raw,
  createPngChunk,
  createTransparentPng,
  encodeRgbaPng,
  encodeRgbaPngFilter0,
  encodeRgbaPngFilter0ViaPool,
  pngCrc32,
  pngFilter0RawSize,
  toBufferView,
  withPngFilter0Raw,
  writePngFilter0Raw,
};
