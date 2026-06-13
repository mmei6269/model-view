"use strict";

const zlib = require("zlib");

// PNG IDAT deflate backend. libdeflate (WASM, whole-buffer) measured 1.45x
// faster than node zlib level 1 on real artifact PNG streams with ~6% smaller
// output (decoded bytes identical; container bytes differ). Hover gzip stays
// on node zlib, where libdeflate measured ~1.0x and would pin ~300MB of WASM
// linear memory per render worker for the ~226MB payload. Set
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
    return Buffer.from(libdeflateZlib(raw, LIBDEFLATE_PNG_LEVEL));
  }
  return zlib.deflateSync(raw, { level: zlibLevel });
}

function pngDeflateBackendName() {
  return libdeflateZlib ? "libdeflate" : "zlib";
}

module.exports = {
  deflatePngIdatSync,
  pngDeflateBackendName,
};
