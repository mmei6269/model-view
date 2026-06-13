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

function encodeRgbaPngFilter0(rgba, width, height, compressionLevel = 1) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const rowBytes = cols * 4;
  const imageBytes = rowBytes * rows;
  const source = toBufferView(rgba);
  if (source.length < imageBytes) {
    throw new Error(`Cannot encode RGBA PNG: expected ${imageBytes} bytes, received ${source.length}.`);
  }
  // Every byte is assigned below (one filter byte plus a full row copy per
  // scanline), so the unsafe allocation never leaks uninitialized memory.
  const raw = Buffer.allocUnsafe(Math.max(0, (rowBytes + 1) * rows));
  for (let row = 0; row < rows; row += 1) {
    const sourceOffset = row * rowBytes;
    const targetOffset = row * (rowBytes + 1);
    raw[targetOffset] = 0;
    source.copy(raw, targetOffset + 1, sourceOffset, sourceOffset + rowBytes);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cols, 0);
  ihdr.writeUInt32BE(rows, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflatePngIdatSync(raw, clampInt(compressionLevel, 0, 9, 1));
  return Buffer.concat([PNG_SIGNATURE, createPngChunk("IHDR", ihdr), createPngChunk("IDAT", idat), PNG_IEND_CHUNK]);
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
  buildPngCrcTable,
  createPngChunk,
  createTransparentPng,
  encodeRgbaPng,
  encodeRgbaPngFilter0,
  pngCrc32,
  toBufferView,
};
