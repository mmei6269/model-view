"use strict";

const zlib = require("zlib");

const HOVER_GRID_COMPRESSION_BACKENDS = Object.freeze(["brotli", "gzip"]);
const DEFAULT_HOVER_GRID_BROTLI_QUALITY = 0;
const DEFAULT_HOVER_GRID_GZIP_LEVEL = 1;

function normalizeHoverGridCompressionBackend(value, fallback = "brotli") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (HOVER_GRID_COMPRESSION_BACKENDS.includes(normalized)) {
    return normalized;
  }
  return HOVER_GRID_COMPRESSION_BACKENDS.includes(fallback) ? fallback : "brotli";
}

function clampHoverGridBrotliQuality(value) {
  return clampInteger(value, 0, 11, DEFAULT_HOVER_GRID_BROTLI_QUALITY);
}

function clampHoverGridGzipLevel(value) {
  return clampInteger(value, 0, 9, DEFAULT_HOVER_GRID_GZIP_LEVEL);
}

function resolveHoverGridCompressionConfig({
  backend = process.env.MODELVIEW_NOAA_HOVER_COMPRESSION,
  brotliQuality = process.env.MODELVIEW_NOAA_HOVER_BROTLI_QUALITY,
  gzipLevel = process.env.MODELVIEW_NOAA_HOVER_GZIP_LEVEL,
} = {}) {
  const resolvedBackend = normalizeHoverGridCompressionBackend(backend, "brotli");
  const resolvedBrotliQuality = clampHoverGridBrotliQuality(brotliQuality);
  const resolvedGzipLevel = clampHoverGridGzipLevel(gzipLevel);
  return Object.freeze({
    backend: resolvedBackend,
    level: resolvedBackend === "brotli" ? resolvedBrotliQuality : resolvedGzipLevel,
    brotliQuality: resolvedBrotliQuality,
    gzipLevel: resolvedGzipLevel,
    contentEncoding: resolvedBackend === "brotli" ? "br" : "gzip",
    extension: resolvedBackend === "brotli" ? "br" : "gz",
  });
}

const DEFAULT_HOVER_GRID_COMPRESSION = resolveHoverGridCompressionConfig();

function compressHoverGridSync(buffer, compression = DEFAULT_HOVER_GRID_COMPRESSION) {
  const config = normalizeCompressionConfig(compression);
  if (config.backend === "brotli") {
    return zlib.brotliCompressSync(buffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: config.brotliQuality,
      },
    });
  }
  return zlib.gzipSync(buffer, { level: config.gzipLevel });
}

function decompressHoverGridSync(body, contentEncoding = null) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  const encoding = normalizeHoverGridContentEncoding(contentEncoding) || detectHoverGridContentEncoding(buffer);
  if (encoding === "gzip") {
    return zlib.gunzipSync(buffer);
  }
  if (encoding === "br") {
    return zlib.brotliDecompressSync(buffer);
  }
  throw new Error("Unable to determine hover-grid content encoding.");
}

function detectHoverGridContentEncoding(buffer) {
  return buffer?.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b ? "gzip" : "br";
}

function normalizeHoverGridContentEncoding(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "gzip" || normalized === "gz") {
    return "gzip";
  }
  if (normalized === "br" || normalized === "brotli") {
    return "br";
  }
  return null;
}

function inferHoverGridCompressionFromKey(key, fallback = DEFAULT_HOVER_GRID_COMPRESSION) {
  const normalized = String(key || "").toLowerCase();
  if (/\.br(?:$|[?#])/.test(normalized)) {
    return resolveHoverGridCompressionConfig({ backend: "brotli", brotliQuality: fallback?.brotliQuality });
  }
  if (/\.gz(?:$|[?#])/.test(normalized)) {
    return resolveHoverGridCompressionConfig({ backend: "gzip", gzipLevel: fallback?.gzipLevel });
  }
  return normalizeCompressionConfig(fallback);
}

function normalizeCompressionConfig(compression) {
  if (!compression || typeof compression !== "object") {
    return DEFAULT_HOVER_GRID_COMPRESSION;
  }
  return resolveHoverGridCompressionConfig(compression);
}

function clampInteger(value, min, max, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

module.exports = {
  DEFAULT_HOVER_GRID_BROTLI_QUALITY,
  DEFAULT_HOVER_GRID_COMPRESSION,
  DEFAULT_HOVER_GRID_GZIP_LEVEL,
  HOVER_GRID_COMPRESSION_BACKENDS,
  clampHoverGridBrotliQuality,
  clampHoverGridGzipLevel,
  compressHoverGridSync,
  decompressHoverGridSync,
  detectHoverGridContentEncoding,
  inferHoverGridCompressionFromKey,
  normalizeHoverGridCompressionBackend,
  normalizeHoverGridContentEncoding,
  resolveHoverGridCompressionConfig,
};
