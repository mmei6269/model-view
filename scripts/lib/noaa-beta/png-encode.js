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

function buildIndexedPngFilter0Raw(indices, width, height) {
  return writeIndexedPngFilter0Raw(Buffer.allocUnsafe(indexedPngFilter0RawSize(width, height)), indices, width, height);
}

function pngFilter0RawSize(width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  return Math.max(0, (cols * 4 + 1) * rows);
}

function indexedPngFilter0RawSize(width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  return Math.max(0, (cols + 1) * rows);
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

function writeIndexedPngFilter0Raw(target, indices, width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const imageBytes = cols * rows;
  const source = toBufferView(indices);
  if (source.length < imageBytes) {
    throw new Error(`Cannot encode indexed PNG: expected ${imageBytes} indices, received ${source.length}.`);
  }
  for (let row = 0; row < rows; row += 1) {
    const sourceOffset = row * cols;
    const targetOffset = row * (cols + 1);
    target[targetOffset] = 0;
    source.copy(target, targetOffset + 1, sourceOffset, sourceOffset + cols);
  }
  return target;
}

// Worker-local scratch slot for inline and generic filter-0 scanline buffers.
// Each non-empty layer used to allocate a fresh ~6.3 MB scanline buffer here; across a
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
const INDEXED_PNG_RAW_SCRATCH = { buffer: null, inUse: false };

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

function acquireIndexedPngRawScratch(size) {
  const slot = INDEXED_PNG_RAW_SCRATCH;
  if (size > 0 && !slot.inUse) {
    if (!slot.buffer || slot.buffer.length !== size) {
      slot.buffer = Buffer.allocUnsafe(size);
    }
    slot.inUse = true;
    return slot.buffer;
  }
  return Buffer.allocUnsafe(size);
}

function releaseIndexedPngRawScratch(buffer) {
  const slot = INDEXED_PNG_RAW_SCRATCH;
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

function withIndexedPngFilter0Raw(indices, width, height, fn) {
  const raw = acquireIndexedPngRawScratch(indexedPngFilter0RawSize(width, height));
  try {
    writeIndexedPngFilter0Raw(raw, indices, width, height);
    return fn(raw);
  } finally {
    releaseIndexedPngRawScratch(raw);
  }
}

function assemblePngFromIdat(idat, width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  // Preserve the former IHDR-first error ordering without allocating its
  // temporary 13-byte payload on valid calls. These writes are reached only
  // for out-of-range dimensions and let Node produce the same native error
  // before IDAT coercion is attempted.
  if (cols > 0xffffffff) {
    PNG_DIMENSION_VALIDATOR.writeUInt32BE(cols, 0);
  }
  if (rows > 0xffffffff) {
    PNG_DIMENSION_VALIDATOR.writeUInt32BE(rows, 4);
  }
  const payload = toPngIdatView(idat);
  const out = Buffer.allocUnsafe(PNG_FIXED_BYTES + payload.length);

  PNG_SIGNATURE.copy(out, 0);

  // Write the fixed IHDR directly into its final position. Buffer.allocUnsafe
  // is safe here because all 13 payload bytes (including the three zero-valued
  // method bytes) and both chunk headers/CRCs are assigned below.
  out.writeUInt32BE(PNG_IHDR_BYTES, 8);
  PNG_IHDR_TYPE.copy(out, 12);
  out.writeUInt32BE(cols, 16);
  out.writeUInt32BE(rows, 20);
  out[24] = 8;
  out[25] = 6;
  out[26] = 0;
  out[27] = 0;
  out[28] = 0;
  out.writeUInt32BE(pngCrc32(PNG_IHDR_TYPE, out.subarray(16, 29)), 29);

  // The former createPngChunk + Buffer.concat path copied every IDAT byte
  // twice and allocated an equally large intermediate chunk. Assemble the
  // variable chunk in the final buffer so its payload is copied exactly once.
  out.writeUInt32BE(payload.length, 33);
  PNG_IDAT_TYPE.copy(out, 37);
  payload.copy(out, 41);
  out.writeUInt32BE(pngCrc32(PNG_IDAT_TYPE, out.subarray(41, 41 + payload.length)), 41 + payload.length);
  PNG_IEND_CHUNK.copy(out, 45 + payload.length);
  return out;
}

function assembleIndexedPngFromIdat(idat, width, height, paletteRgba) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  if (cols > 0xffffffff) {
    PNG_DIMENSION_VALIDATOR.writeUInt32BE(cols, 0);
  }
  if (rows > 0xffffffff) {
    PNG_DIMENSION_VALIDATOR.writeUInt32BE(rows, 4);
  }
  const palette = normalizeIndexedPalette(paletteRgba);
  const paletteEntries = palette.length / 4;
  const payload = toPngIdatView(idat);
  const out = Buffer.allocUnsafe(INDEXED_PNG_FIXED_BYTES + paletteEntries * 4 + payload.length);

  PNG_SIGNATURE.copy(out, 0);

  out.writeUInt32BE(PNG_IHDR_BYTES, 8);
  PNG_IHDR_TYPE.copy(out, 12);
  out.writeUInt32BE(cols, 16);
  out.writeUInt32BE(rows, 20);
  out[24] = 8;
  out[25] = 3;
  out[26] = 0;
  out[27] = 0;
  out[28] = 0;
  out.writeUInt32BE(pngCrc32(PNG_IHDR_TYPE, out.subarray(16, 29)), 29);

  const plteLength = paletteEntries * 3;
  out.writeUInt32BE(plteLength, 33);
  PNG_PLTE_TYPE.copy(out, 37);
  const plteStart = 41;
  for (let index = 0; index < paletteEntries; index += 1) {
    const sourceOffset = index * 4;
    const targetOffset = plteStart + index * 3;
    out[targetOffset] = palette[sourceOffset];
    out[targetOffset + 1] = palette[sourceOffset + 1];
    out[targetOffset + 2] = palette[sourceOffset + 2];
  }
  const plteCrcOffset = plteStart + plteLength;
  out.writeUInt32BE(pngCrc32(PNG_PLTE_TYPE, out.subarray(plteStart, plteCrcOffset)), plteCrcOffset);

  const trnsOffset = plteCrcOffset + 4;
  out.writeUInt32BE(paletteEntries, trnsOffset);
  PNG_TRNS_TYPE.copy(out, trnsOffset + 4);
  const trnsStart = trnsOffset + 8;
  // Emit one alpha byte for every palette entry, including trailing opaque
  // entries. PNG permits trimming trailing 255 values, but the full table is
  // deterministic and preserves partial alpha without special cases.
  for (let index = 0; index < paletteEntries; index += 1) {
    out[trnsStart + index] = palette[index * 4 + 3];
  }
  const trnsCrcOffset = trnsStart + paletteEntries;
  out.writeUInt32BE(pngCrc32(PNG_TRNS_TYPE, out.subarray(trnsStart, trnsCrcOffset)), trnsCrcOffset);

  const idatOffset = trnsCrcOffset + 4;
  out.writeUInt32BE(payload.length, idatOffset);
  PNG_IDAT_TYPE.copy(out, idatOffset + 4);
  const idatStart = idatOffset + 8;
  payload.copy(out, idatStart);
  const idatCrcOffset = idatStart + payload.length;
  out.writeUInt32BE(pngCrc32(PNG_IDAT_TYPE, out.subarray(idatStart, idatCrcOffset)), idatCrcOffset);
  PNG_IEND_CHUNK.copy(out, idatCrcOffset + 4);
  return out;
}

function encodeRgbaPngFilter0(rgba, width, height, compressionLevel = 1) {
  const level = clampInt(compressionLevel, 0, 9, 1);
  return withPngFilter0Raw(rgba, width, height, (raw) =>
    assemblePngFromIdat(deflatePngIdatSync(raw, level), width, height),
  );
}

function encodeIndexedPngFilter0(indices, paletteRgba, width, height, compressionLevel = 1) {
  const cols = normalizePngDimension(width);
  const rows = normalizePngDimension(height);
  return encodeIndexedPngFilter0Internal(indices, paletteRgba, cols, rows, compressionLevel, false);
}

// Internal capability used only after raster.js verifies its private layer
// brand. Keep the generic export above unconditionally validating so a caller
// cannot forge a validation bypass through an options object.
function _encodeTrustedIndexedPngFilter0(indices, paletteRgba, width, height, compressionLevel = 1) {
  return encodeIndexedPngFilter0Internal(indices, paletteRgba, width, height, compressionLevel, true);
}

function encodeIndexedPngFilter0Internal(indices, paletteRgba, width, height, compressionLevel, trustedIndices) {
  const level = clampInt(compressionLevel, 0, 9, 1);
  const input = trustedIndices
    ? { indices, palette: normalizeIndexedPalette(paletteRgba) }
    : snapshotAndValidateIndexedPngInput(indices, paletteRgba, width, height);
  return withIndexedPngFilter0Raw(input.indices, width, height, (raw) =>
    assembleIndexedPngFromIdat(deflatePngIdatSync(raw, level), width, height, input.palette),
  );
}

// Generic pool-offloaded variant: the caller's pixels are snapshotted before
// the first await and the raw scanlines use the reusable scratch slot.
// CompressPool.submit always clones generic inputs, so immediate caller
// mutation and every asynchronous fallback remain isolated. Renderer-owned
// layers use the separate underscored entry point below: it checks out one
// exact owned ArrayBuffer after coordinator admission, transfers that slab to
// the worker, then recycles the returned owner. Keeping the APIs separate
// prevents an arbitrary options object from opting caller-owned bytes into
// the transfer contract.
async function encodeRgbaPngFilter0ViaPool(
  rgba,
  width,
  height,
  compressionLevel,
  pool,
  counters = null,
  _options = null,
) {
  const level = clampInt(compressionLevel, 0, 9, 1);
  const idat = await deflatePngIdatViaPool(rgba, width, height, level, pool, counters, false);
  return assemblePngFromIdat(idat, width, height);
}

async function _encodeTrustedRgbaPngFilter0ViaPool(rgba, width, height, compressionLevel, pool, counters = null) {
  const level = clampInt(compressionLevel, 0, 9, 1);
  const idat = await deflatePngIdatViaPool(rgba, width, height, level, pool, counters, true);
  return assemblePngFromIdat(idat, width, height);
}

async function encodeIndexedPngFilter0ViaPool(
  indices,
  paletteRgba,
  width,
  height,
  compressionLevel,
  pool,
  counters = null,
  _options = null,
) {
  const cols = normalizePngDimension(width);
  const rows = normalizePngDimension(height);
  return encodeIndexedPngFilter0ViaPoolInternal(
    indices,
    paletteRgba,
    cols,
    rows,
    compressionLevel,
    pool,
    counters,
    false,
  );
}

function normalizePngDimension(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

async function _encodeTrustedIndexedPngFilter0ViaPool(
  indices,
  paletteRgba,
  width,
  height,
  compressionLevel,
  pool,
  counters = null,
  _options = null,
) {
  return encodeIndexedPngFilter0ViaPoolInternal(
    indices,
    paletteRgba,
    width,
    height,
    compressionLevel,
    pool,
    counters,
    true,
  );
}

async function encodeIndexedPngFilter0ViaPoolInternal(
  indices,
  paletteRgba,
  width,
  height,
  compressionLevel,
  pool,
  counters,
  trustedIndices,
) {
  const level = clampInt(compressionLevel, 0, 9, 1);
  const input = trustedIndices
    ? {
        indices,
        palette: normalizeIndexedPalette(paletteRgba),
      }
    : {
        ...snapshotAndValidateIndexedPngInput(indices, paletteRgba, width, height),
      };
  const idat = await deflateIndexedPngIdatViaPool(input.indices, width, height, level, pool, counters, trustedIndices);
  return assembleIndexedPngFromIdat(idat, width, height, input.palette);
}

async function deflatePngIdatViaPool(rgba, width, height, level, pool, counters, trustedOwnedInput) {
  if (!pool || pool.dead) {
    if (counters) {
      counters.fallbacks += 1;
    }
    return withPngFilter0Raw(rgba, width, height, (raw) => deflatePngIdatSync(raw, level));
  }
  if (
    trustedOwnedInput &&
    typeof pool.acquireOwnedInput === "function" &&
    typeof pool.submitOwned === "function" &&
    typeof pool.releaseOwnedInput === "function"
  ) {
    return deflateOwnedPngIdatViaPool({
      counters,
      level,
      pool,
      rawSize: pngFilter0RawSize(width, height),
      rebuild: (raw) => writePngFilter0Raw(raw, rgba, width, height),
      rebuildInline: () => withPngFilter0Raw(rgba, width, height, (scratch) => deflatePngIdatSync(scratch, level)),
    });
  }
  // A generic caller may reuse its RGBA as soon as this async function
  // returns. Freeze the logical image bytes before the first await so a later
  // pool rejection cannot observe those replacement pixels.
  const fallbackRgba = snapshotPngRgba(rgba, width, height);
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

async function deflateIndexedPngIdatViaPool(indices, width, height, level, pool, counters, trustedOwnedInput) {
  if (!pool || pool.dead) {
    if (counters) {
      counters.fallbacks += 1;
    }
    return withIndexedPngFilter0Raw(indices, width, height, (raw) => deflatePngIdatSync(raw, level));
  }
  if (
    trustedOwnedInput &&
    typeof pool.acquireOwnedInput === "function" &&
    typeof pool.submitOwned === "function" &&
    typeof pool.releaseOwnedInput === "function"
  ) {
    return deflateOwnedPngIdatViaPool({
      counters,
      level,
      pool,
      rawSize: indexedPngFilter0RawSize(width, height),
      rebuild: (raw) => writeIndexedPngFilter0Raw(raw, indices, width, height),
      rebuildInline: () =>
        withIndexedPngFilter0Raw(indices, width, height, (scratch) => deflatePngIdatSync(scratch, level)),
    });
  }
  const fallbackIndices = snapshotIndexedPngIndices(indices, width, height);
  let job;
  const raw = acquireIndexedPngRawScratch(indexedPngFilter0RawSize(width, height));
  try {
    writeIndexedPngFilter0Raw(raw, fallbackIndices, width, height);
    try {
      job = pool.submit("png-idat", raw, level);
    } catch (error) {
      warnPngEncodePoolFailure(error);
      if (counters) {
        counters.fallbacks += 1;
      }
      return deflatePngIdatSync(raw, level);
    }
  } finally {
    releaseIndexedPngRawScratch(raw);
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
    return withIndexedPngFilter0Raw(fallbackIndices, width, height, (scratch) => deflatePngIdatSync(scratch, level));
  }
}

async function deflateOwnedPngIdatViaPool({ counters, level, pool, rawSize, rebuild, rebuildInline }) {
  let lease;
  try {
    lease = pool.acquireOwnedInput(rawSize);
  } catch (error) {
    warnPngEncodePoolFailure(error);
  }
  if (!lease) {
    incrementCounter(counters, "fallbacks");
    incrementCounter(counters, "ownedInputFallbacks");
    return rebuildInline();
  }

  let raw;
  try {
    // acquireOwnedInput always allocates an exact standalone ArrayBuffer.
    // Buffer.from(ArrayBuffer) adds only a view and can never expose or
    // transfer Node's small-buffer pool backing allocation.
    raw = Buffer.from(lease.buffer);
    rebuild(raw);
  } catch (error) {
    pool.releaseOwnedInput(lease);
    throw error;
  }

  beginOwnedTransportInput(counters, rawSize, pool);
  try {
    let result;
    try {
      result = await pool.submitOwned("png-idat", lease, level);
    } catch (error) {
      warnPngEncodePoolFailure(error);
      incrementCounter(counters, "fallbacks");
      incrementCounter(counters, "ownedInputFallbacks");
      const attached =
        lease.state === "attached" &&
        lease.buffer instanceof ArrayBuffer &&
        lease.buffer.byteLength === lease.byteLength;
      if (attached && error?.code !== "ERR_COMPRESS_WORKER") {
        // Admission/postMessage failed before ownership left this thread. The
        // already-built scanlines are still exact, so compress them in place.
        try {
          return deflatePngIdatSync(Buffer.from(lease.buffer), level);
        } finally {
          pool.releaseOwnedInput(lease);
        }
      }
      // A worker-reported codec error, worker death, invalid return, or lost
      // detached owner is not trusted. Drop/recycle only a valid returned
      // slab, then rebuild from the immutable renderer-owned source.
      if (attached) {
        pool.releaseOwnedInput(lease);
      }
      incrementCounter(counters, "ownedInputRebuilds");
      return rebuildInline();
    }

    const returnedLease = result?.lease;
    if (returnedLease !== lease || !Buffer.isBuffer(result?.body)) {
      if (lease.state === "attached") {
        pool.releaseOwnedInput(lease);
      }
      incrementCounter(counters, "fallbacks");
      incrementCounter(counters, "ownedInputFallbacks");
      incrementCounter(counters, "ownedInputRebuilds");
      return rebuildInline();
    }
    pool.releaseOwnedInput(lease);
    incrementCounter(counters, "jobs");
    incrementCounter(counters, "ownedInputJobs");
    incrementCounter(counters, "ownedInputBytes", rawSize);
    return result.body;
  } finally {
    endOwnedTransportInput(counters, rawSize, pool);
  }
}

function incrementCounter(counters, key, amount = 1) {
  if (counters) {
    counters[key] = (Number(counters[key]) || 0) + amount;
  }
}

function beginOwnedTransportInput(counters, byteLength, pool) {
  if (!counters) {
    return;
  }
  counters.transportOwnedActiveBytes = (Number(counters.transportOwnedActiveBytes) || 0) + byteLength;
  refreshTransportMemory(counters, pool);
}

function endOwnedTransportInput(counters, byteLength, pool) {
  if (!counters) {
    return;
  }
  counters.transportOwnedActiveBytes = Math.max(0, (Number(counters.transportOwnedActiveBytes) || 0) - byteLength);
  refreshTransportMemory(counters, pool);
}

function refreshTransportMemory(counters, pool) {
  const ownedActiveBytes = Number(counters.transportOwnedActiveBytes) || 0;
  const sharedLiveBytes = Number(counters.transportSharedLiveBytes) || 0;
  const ownedRetainedBytes =
    typeof pool?.ownedInputTelemetry === "function"
      ? Number(pool.ownedInputTelemetry().liveBytes) || 0
      : ownedActiveBytes;
  counters.transportLiveBytes = ownedActiveBytes + sharedLiveBytes;
  counters.transportRetainedLiveBytes = ownedRetainedBytes + sharedLiveBytes;
  counters.transportPeakLiveBytes = Math.max(
    Number(counters.transportPeakLiveBytes) || 0,
    counters.transportRetainedLiveBytes,
  );
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

function snapshotIndexedPngIndices(indices, width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const imageBytes = cols * rows;
  const source = toBufferView(indices);
  return Buffer.from(source.subarray(0, imageBytes));
}

function snapshotIndexedPngPalette(paletteRgba) {
  return Buffer.from(toBufferView(paletteRgba));
}

function snapshotAndValidateIndexedPngInput(indices, paletteRgba, width, height) {
  // Snapshot both independently caller-controlled views before validating
  // either. Validation, scanline construction, pooled submission, fallback,
  // and chunk assembly then share these exact immutable owners.
  const indicesSnapshot = snapshotIndexedPngIndices(indices, width, height);
  const paletteSnapshot = snapshotIndexedPngPalette(paletteRgba);
  const palette = normalizeIndexedPalette(paletteSnapshot);
  validateIndexedPngIndices(indicesSnapshot, width, height, palette.length / 4);
  return { indices: indicesSnapshot, palette };
}

function normalizeIndexedPalette(paletteRgba) {
  const palette = toBufferView(paletteRgba);
  if (palette.length < 4 || palette.length > 256 * 4 || palette.length % 4 !== 0) {
    throw new RangeError(
      `Cannot encode indexed PNG: palette must contain 1 to 256 RGBA entries; received ${palette.length} bytes.`,
    );
  }
  return palette;
}

function validateIndexedPngIndices(indices, width, height, paletteEntries) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const imageBytes = cols * rows;
  const source = toBufferView(indices);
  if (source.length < imageBytes) {
    throw new Error(`Cannot encode indexed PNG: expected ${imageBytes} indices, received ${source.length}.`);
  }
  for (let index = 0; index < imageBytes; index += 1) {
    if (source[index] >= paletteEntries) {
      throw new RangeError(
        `Cannot encode indexed PNG: palette index ${source[index]} at pixel ${index} exceeds ${paletteEntries} entries.`,
      );
    }
  }
  return source;
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
  INDEXED_PNG_RAW_SCRATCH.buffer = null;
  INDEXED_PNG_RAW_SCRATCH.inUse = false;
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

function toPngIdatView(value) {
  if (value instanceof Uint8Array && value.byteLength === 0) {
    // A transferred/detached Uint8Array cannot back a new Buffer view, while
    // Buffer.from(Uint8Array), used by the former IDAT chunk builder, treated
    // it as empty. Keep that compatibility local to PNG assembly so RGBA
    // validation retains its existing detached-input errors.
    return Buffer.alloc(0);
  }
  return toBufferView(value);
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

const PNG_IHDR_BYTES = 13;

const PNG_FIXED_BYTES = 57;
const INDEXED_PNG_FIXED_BYTES = 81;

const PNG_IHDR_TYPE = Buffer.from("IHDR", "ascii");

const PNG_IDAT_TYPE = Buffer.from("IDAT", "ascii");
const PNG_PLTE_TYPE = Buffer.from("PLTE", "ascii");
const PNG_TRNS_TYPE = Buffer.from("tRNS", "ascii");

const PNG_DIMENSION_VALIDATOR = Buffer.allocUnsafe(8);

const PNG_IEND_CHUNK = createPngChunk("IEND", Buffer.alloc(0));

module.exports = {
  HAS_NATIVE_CRC32,
  PNG_CRC_TABLE,
  PNG_IEND_CHUNK,
  PNG_SIGNATURE,
  TRANSPARENT_PNG_CACHE,
  _encodeTrustedIndexedPngFilter0,
  _encodeTrustedIndexedPngFilter0ViaPool,
  _encodeTrustedRgbaPngFilter0ViaPool,
  _testIndexedPngRawScratchSlot: () => INDEXED_PNG_RAW_SCRATCH,
  _testPngRawScratchSlot: () => PNG_RAW_SCRATCH,
  _testResetPngRawScratch,
  assembleIndexedPngFromIdat,
  assemblePngFromIdat,
  buildPngCrcTable,
  buildIndexedPngFilter0Raw,
  buildPngFilter0Raw,
  createPngChunk,
  createTransparentPng,
  encodeIndexedPngFilter0,
  encodeIndexedPngFilter0ViaPool,
  encodeRgbaPng,
  encodeRgbaPngFilter0,
  encodeRgbaPngFilter0ViaPool,
  indexedPngFilter0RawSize,
  normalizeIndexedPalette,
  pngCrc32,
  pngFilter0RawSize,
  toBufferView,
  validateIndexedPngIndices,
  withIndexedPngFilter0Raw,
  withPngFilter0Raw,
  writeIndexedPngFilter0Raw,
  writePngFilter0Raw,
};
