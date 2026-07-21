#!/usr/bin/env node

"use strict";

// Codec helper thread for the render worker's compression pool: runs the
// exact same synchronous codec calls the render thread would run inline
// (deflate-backend for PNG IDAT, node zlib for hover gzip), so pooled and
// inline outputs are byte-identical by construction. Inputs arrive as
// structured clones (never transferred) so the submitter always retains its
// copy for the inline fallback; results transfer back zero-copy.

const { parentPort } = require("worker_threads");
const zlib = require("zlib");
const { deflatePngIdatSync } = require("./lib/noaa-beta/deflate-backend");
const { clampInt } = require("./lib/noaa-beta/util");

if (parentPort) {
  parentPort.on("message", handleMessage);
}

function handleMessage(message) {
  if (!message || message.type !== "compress") {
    return;
  }
  const { id, kind, input, level } = message;
  try {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let out;
    if (kind === "gzip") {
      out = zlib.gzipSync(buffer, { level: clampInt(level, 0, 9, 1) });
    } else if (kind === "png-idat") {
      out = deflatePngIdatSync(buffer, clampInt(level, 0, 9, 1));
    } else {
      throw new Error(`Unknown compress kind '${kind}'.`);
    }
    const transferable =
      out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
        ? out.buffer
        : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    parentPort.postMessage({ id, ok: true, body: transferable }, [transferable]);
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
}
