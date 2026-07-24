"use strict";

const zlib = require("zlib");

// PNG IDAT deflate backend. libdeflate (WASM, whole-buffer) measured 1.45x
// faster than node zlib level 1 on real artifact PNG streams with ~6% smaller
// output (decoded bytes identical; container bytes differ). Hover lossless
// compression (Brotli by default, legacy gzip optionally) stays on node:zlib;
// the earlier gzip/libdeflate path would pin ~300MB of WASM linear memory per
// render worker for the ~226MB payload. Set
// MODELVIEW_PNG_DEFLATE_BACKEND=zlib to force the node zlib path; the zlib
// path is also the automatic fallback when the libdeflate module is missing.
const LIBDEFLATE_PNG_LEVEL = 1;

let libdeflateZlib = null;
if (String(process.env.MODELVIEW_PNG_DEFLATE_BACKEND || "").toLowerCase() !== "zlib") {
  try {
    libdeflateZlib = require("libdeflate").zlib;
  } catch {
    libdeflateZlib = null;
  }
}

function deflatePngIdatSync(raw, zlibLevel) {
  if (libdeflateZlib && zlibLevel === 1) {
    return bufferFromLibdeflateResult(libdeflateZlib(raw, LIBDEFLATE_PNG_LEVEL));
  }
  return zlib.deflateSync(raw, { level: zlibLevel });
}

function bufferFromLibdeflateResult(result) {
  // libdeflate 0.1.0 returns HEAPU8.slice(...): a plain Uint8Array whose
  // fixed, exact-sized ArrayBuffer is independent of WASM memory before the
  // call returns. Transfer that otherwise-unreferenced allocation into a
  // Buffer view instead of copying every compressed IDAT body a second time.
  //
  // Keep the predicate deliberately narrow so an upstream implementation
  // change to a WASM-heap subarray, pooled Buffer, resizable buffer, typed
  // array subclass, or other result shape falls back to Buffer.from's copy.
  if (
    Object.getPrototypeOf(result) === Uint8Array.prototype &&
    result.buffer instanceof ArrayBuffer &&
    result.buffer.resizable !== true &&
    result.byteOffset === 0 &&
    result.byteLength === result.buffer.byteLength
  ) {
    return Buffer.from(result.buffer, 0, result.byteLength);
  }
  return Buffer.from(result);
}

function pngDeflateBackendName() {
  return libdeflateZlib ? "libdeflate" : "zlib";
}

module.exports = {
  deflatePngIdatSync,
  pngDeflateBackendName,
  _testBufferFromLibdeflateResult: bufferFromLibdeflateResult,
};
