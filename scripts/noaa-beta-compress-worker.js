#!/usr/bin/env node

"use strict";

// Codec helper thread for the render worker's compression pool: runs the
// exact same synchronous codec calls the render thread would run inline
// (deflate-backend for PNG IDAT, node zlib for hover gzip/Brotli), so pooled and
// inline outputs are byte-identical by construction. The versioned protocol
// has three explicit input ownership modes:
//   clone: generic input, structured-cloned by postMessage;
//   owned-array-buffer: exact renderer PNG slab, transferred in and returned;
//   shared-array-buffer: bounded immutable hover view, shared read-only via
//     explicit owner offset/length.
// Results transfer back zero-copy. Owned input is returned on codec errors as
// well as success so a valid slab can be recycled; worker death is the only
// path that can lose a transferred owner.

const { parentPort } = require("worker_threads");
const zlib = require("zlib");
const { deflatePngIdatSync } = require("./lib/noaa-beta/deflate-backend");
const { clampInt } = require("./lib/noaa-beta/util");

const COMPRESS_PROTOCOL_VERSION = 3;
const COMPRESS_RESULT_TYPE = "compress-result";
const INPUT_MODE_CLONE = "clone";
const INPUT_MODE_OWNED = "owned-array-buffer";
const INPUT_MODE_SHARED = "shared-array-buffer";

if (parentPort) {
  parentPort.on("message", handleMessage);
}

function handleMessage(message) {
  if (!message || message.type !== "compress") {
    return;
  }
  const { id, token, inputMode, kind, input, level } = message;
  try {
    validateRequest(message);
    const buffer =
      inputMode === INPUT_MODE_SHARED
        ? Buffer.from(input, message.inputByteOffset, message.inputByteLength)
        : Buffer.isBuffer(input)
          ? input
          : Buffer.from(input);
    let out;
    if (kind === "gzip") {
      out = zlib.gzipSync(buffer, { level: clampInt(level, 0, 9, 1) });
    } else if (kind === "brotli") {
      out = zlib.brotliCompressSync(buffer, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: clampInt(level, 0, 11, 0),
        },
      });
    } else if (kind === "png-idat") {
      out = deflatePngIdatSync(buffer, clampInt(level, 0, 9, 1));
    } else {
      throw new Error(`Unknown compress kind '${kind}'.`);
    }
    const transferable =
      out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
        ? out.buffer
        : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    const result = {
      type: COMPRESS_RESULT_TYPE,
      protocolVersion: COMPRESS_PROTOCOL_VERSION,
      id,
      token,
      inputMode,
      ok: true,
      body: transferable,
      ...(inputMode === INPUT_MODE_SHARED
        ? {
            inputByteOffset: message.inputByteOffset,
            inputByteLength: message.inputByteLength,
          }
        : {}),
      ...(inputMode === INPUT_MODE_OWNED ? { input } : {}),
    };
    const transferList = inputMode === INPUT_MODE_OWNED ? [transferable, input] : [transferable];
    parentPort.postMessage(result, transferList);
  } catch (error) {
    const canReturnOwnedInput = inputMode === INPUT_MODE_OWNED && input instanceof ArrayBuffer;
    parentPort.postMessage(
      {
        type: COMPRESS_RESULT_TYPE,
        protocolVersion: COMPRESS_PROTOCOL_VERSION,
        id,
        token,
        inputMode,
        ok: false,
        error: String(error?.message || error),
        ...(inputMode === INPUT_MODE_SHARED
          ? {
              inputByteOffset: message.inputByteOffset,
              inputByteLength: message.inputByteLength,
            }
          : {}),
        ...(canReturnOwnedInput ? { input } : {}),
      },
      canReturnOwnedInput ? [input] : [],
    );
  }
}

function validateRequest(message) {
  if (message.protocolVersion !== COMPRESS_PROTOCOL_VERSION) {
    throw new Error(`Unsupported compress protocol version '${String(message.protocolVersion)}'.`);
  }
  if (!Number.isSafeInteger(message.id) || message.id < 1 || typeof message.token !== "bigint") {
    throw new Error("Compress request is missing a valid id/token.");
  }
  if (![INPUT_MODE_CLONE, INPUT_MODE_OWNED, INPUT_MODE_SHARED].includes(message.inputMode)) {
    throw new Error(`Unknown compress input mode '${String(message.inputMode)}'.`);
  }
  if (message.inputMode === INPUT_MODE_OWNED && !(message.input instanceof ArrayBuffer)) {
    throw new Error("Owned compress input must be an ArrayBuffer.");
  }
  if (message.inputMode === INPUT_MODE_SHARED && !(message.input instanceof SharedArrayBuffer)) {
    throw new Error("Shared compress input must be a SharedArrayBuffer.");
  }
  if (message.inputMode === INPUT_MODE_SHARED) {
    const byteOffset = message.inputByteOffset;
    const byteLength = message.inputByteLength;
    const end = byteOffset + byteLength;
    if (
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0 ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      !Number.isSafeInteger(end) ||
      end > message.input.byteLength
    ) {
      throw new Error("Shared compress input range is unsafe or outside its current backing.");
    }
  }
  if (
    message.inputMode === INPUT_MODE_CLONE &&
    !(message.input instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(message.input)
  ) {
    throw new Error("Cloned compress input must be an ArrayBuffer view.");
  }
}
