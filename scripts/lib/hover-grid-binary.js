"use strict";

const zlib = require("zlib");

const HOVER_GRID_BINARY_MAGIC = "MVHG";

// Schema v3 payloads carry their own magic so pre-v3 decoders fail loudly
// (unknown container) instead of silently reading delta residue as absolute
// values; stored artifacts outlive code versions even with no legacy
// clients.
const HOVER_GRID_BINARY_MAGIC_V3 = "MVH3";

function encodeHoverGridBinaryPayload(payload = {}) {
  const raw = buildHoverGridBinaryRaw(payload);
  return zlib.gzipSync(raw, { level: clampGzipLevel(payload.gzipLevel ?? 1) });
}

// Everything up to (but excluding) the final gzip, so the compression pool
// can run that step off-thread; encodeHoverGridBinaryPayload stays the
// single-call form and both produce identical bytes.
function buildHoverGridBinaryRaw({ schemaVersion = 1, rows, cols, variables = {} } = {}) {
  const resolvedSchemaVersion = Number(schemaVersion) || 1;
  const dataBodies = [];
  const headerVariables = {};
  let byteOffset = 0;
  for (const [key, variable] of Object.entries(variables || {})) {
    const values = variable?.values;
    if (!(values instanceof Int16Array)) {
      continue;
    }
    const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    dataBodies.push(body);
    headerVariables[key] = {
      scale: Number.isFinite(Number(variable.scale)) ? Number(variable.scale) : 1,
      offset: Number.isFinite(Number(variable.offset)) ? Number(variable.offset) : 0,
      missing: Number.isFinite(Number(variable.missing)) ? Number(variable.missing) : -32768,
      byteOffset,
      length: values.length,
    };
    byteOffset += body.length;
  }
  let header = Buffer.from(
    JSON.stringify({
      schemaVersion: resolvedSchemaVersion,
      rows: Number(rows) || 0,
      cols: Number(cols) || 0,
      variables: headerVariables,
    }),
  );
  if (header.length % 2 === 1) {
    // Keep the Int16 data region 2-byte aligned (JSON tolerates the pad).
    header = Buffer.concat([header, Buffer.from(" ")]);
  }
  const raw = Buffer.allocUnsafe(8 + header.length + byteOffset);
  raw.write(resolvedSchemaVersion >= 3 ? HOVER_GRID_BINARY_MAGIC_V3 : HOVER_GRID_BINARY_MAGIC, 0, "ascii");
  raw.writeUInt32LE(header.length, 4);
  header.copy(raw, 8);
  let cursor = 8 + header.length;
  for (const body of dataBodies) {
    body.copy(raw, cursor);
    cursor += body.length;
  }
  if (resolvedSchemaVersion >= 3 && byteOffset > 0) {
    // Schema v3: lossless global int16 delta across the data region (the
    // previous value carries across variable boundaries). Smooth fields
    // become near-zero residue, cutting gzip size ~19% and gzip time ~14%
    // on real payloads; the decoder restores by wrapping prefix sum.
    deltaEncodeInt16Region(raw, 8 + header.length, byteOffset);
  }
  return raw;
}

// The wasm delta encoder is an exact port (wrapping i16 subtraction has no
// precision component); the loader degrades to null wherever the kernel
// module or wasm binary is unavailable, keeping the JS loops authoritative.
let cachedDeltaKernel;
function deltaEncodeKernel() {
  if (cachedDeltaKernel === undefined) {
    cachedDeltaKernel = null;
    try {
      // Lazy + guarded: this module is shared beyond the renderer workers.
      const { getParcelKernel } = require("./noaa-beta/parcel-kernel");
      cachedDeltaKernel = getParcelKernel()?.delta || null;
    } catch {
      cachedDeltaKernel = null;
    }
  }
  return cachedDeltaKernel;
}

function deltaEncodeInt16Region(buffer, start, byteLength) {
  const count = byteLength >> 1;
  if ((buffer.byteOffset + start) % 2 === 0) {
    const data = new Int16Array(buffer.buffer, buffer.byteOffset + start, count);
    const kernel = deltaEncodeKernel();
    if (kernel) {
      let previous = 0;
      for (let offset = 0; offset < count; offset += kernel.chunk) {
        const chunkCount = Math.min(kernel.chunk, count - offset);
        kernel.buf.set(data.subarray(offset, offset + chunkCount));
        previous = kernel.encode(chunkCount, previous);
        data.set(kernel.buf.subarray(0, chunkCount), offset);
      }
      return;
    }
    let previous = 0;
    for (let index = 0; index < count; index += 1) {
      const value = data[index];
      data[index] = value - previous;
      previous = value;
    }
    return;
  }
  // Unaligned small pooled buffers (tests) take the byte-addressed path.
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    const value = buffer.readInt16LE(start + index * 2);
    buffer.writeInt16LE(((value - previous) << 16) >> 16, start + index * 2);
    previous = value;
  }
}

function deltaDecodeInt16Region(buffer, start, byteLength) {
  const count = byteLength >> 1;
  if ((buffer.byteOffset + start) % 2 === 0) {
    const data = new Int16Array(buffer.buffer, buffer.byteOffset + start, count);
    let previous = 0;
    for (let index = 0; index < count; index += 1) {
      previous = ((previous + data[index]) << 16) >> 16;
      data[index] = previous;
    }
    return;
  }
  let previous = 0;
  for (let index = 0; index < count; index += 1) {
    previous = ((previous + buffer.readInt16LE(start + index * 2)) << 16) >> 16;
    buffer.writeInt16LE(previous, start + index * 2);
  }
}

function encodeHoverGridJsonPayload({ schemaVersion = 1, rows, cols, variables = {}, gzipLevel = 1 } = {}) {
  const payload = {
    schemaVersion: Number(schemaVersion) || 1,
    rows: Number(rows) || 0,
    cols: Number(cols) || 0,
    variables: Object.fromEntries(
      Object.entries(variables || {})
        .filter(([, variable]) => variable?.values instanceof Int16Array)
        .map(([key, variable]) => [
          key,
          {
            scale: Number.isFinite(Number(variable.scale)) ? Number(variable.scale) : 1,
            offset: Number.isFinite(Number(variable.offset)) ? Number(variable.offset) : 0,
            missing: Number.isFinite(Number(variable.missing)) ? Number(variable.missing) : -32768,
            data: Buffer.from(variable.values.buffer, variable.values.byteOffset, variable.values.byteLength).toString(
              "base64",
            ),
          },
        ]),
    ),
  };
  return zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: clampGzipLevel(gzipLevel) });
}

function decodeHoverGridPayload(body) {
  const raw = zlib.gunzipSync(Buffer.isBuffer(body) ? body : Buffer.from(body || []));
  const magic = raw.subarray(0, 4).toString("ascii");
  if (magic === HOVER_GRID_BINARY_MAGIC || magic === HOVER_GRID_BINARY_MAGIC_V3) {
    const headerLength = raw.readUInt32LE(4);
    const header = JSON.parse(raw.subarray(8, 8 + headerLength).toString("utf8"));
    const dataStart = 8 + headerLength;
    if ((Number(header.schemaVersion) || 1) >= 3 && raw.length > dataStart) {
      // Schema v3 stores a global int16 delta stream; restore in place
      // before the per-variable slices below.
      deltaDecodeInt16Region(raw, dataStart, raw.length - dataStart);
    }
    const variables = {};
    for (const [key, meta] of Object.entries(header.variables || {})) {
      const byteOffset = Number(meta.byteOffset) || 0;
      const length = Math.max(0, Number(meta.length) || 0);
      const bytes = raw.subarray(dataStart + byteOffset, dataStart + byteOffset + length * 2);
      variables[key] = {
        scale: Number.isFinite(Number(meta.scale)) ? Number(meta.scale) : 1,
        offset: Number.isFinite(Number(meta.offset)) ? Number(meta.offset) : 0,
        missing: Number.isFinite(Number(meta.missing)) ? Number(meta.missing) : -32768,
        values: new Int16Array(Uint8Array.from(bytes).buffer),
      };
    }
    return {
      schemaVersion: Number(header.schemaVersion) || 1,
      rows: Number(header.rows) || 0,
      cols: Number(header.cols) || 0,
      variables,
    };
  }
  const payload = JSON.parse(raw.toString("utf8"));
  const variables = {};
  for (const [key, variable] of Object.entries(payload.variables || {})) {
    const bytes = Buffer.from(String(variable.data || ""), "base64");
    variables[key] = {
      scale: Number.isFinite(Number(variable.scale)) ? Number(variable.scale) : 1,
      offset: Number.isFinite(Number(variable.offset)) ? Number(variable.offset) : 0,
      missing: Number.isFinite(Number(variable.missing)) ? Number(variable.missing) : -32768,
      values: new Int16Array(Uint8Array.from(bytes).buffer),
    };
  }
  return {
    schemaVersion: Number(payload.schemaVersion) || 1,
    rows: Number(payload.rows) || 0,
    cols: Number(payload.cols) || 0,
    variables,
  };
}

function mergeHoverGridPayloads(existingBody, incomingBody, { format = "binary", gzipLevel = 1 } = {}) {
  const existing = decodeHoverGridPayload(existingBody);
  const incoming = decodeHoverGridPayload(incomingBody);
  // Splicing variables across dimension regimes would self-describe an
  // inconsistent artifact that clients silently pad/truncate into spatially
  // misaligned hover values; fail loudly instead (only reachable if render
  // dims change without a renderer-signature bump).
  const existingRows = Number(existing.rows) || 0;
  const existingCols = Number(existing.cols) || 0;
  const incomingRows = Number(incoming.rows) || 0;
  const incomingCols = Number(incoming.cols) || 0;
  if (existingRows > 0 && incomingRows > 0 && (existingRows !== incomingRows || existingCols !== incomingCols)) {
    throw new Error(
      `hover-grid merge dimension mismatch: existing ${existingRows}x${existingCols} vs incoming ${incomingRows}x${incomingCols}`,
    );
  }
  const merged = {
    schemaVersion: Math.max(Number(existing.schemaVersion) || 1, Number(incoming.schemaVersion) || 1),
    rows: Number(existing.rows) || Number(incoming.rows) || 0,
    cols: Number(existing.cols) || Number(incoming.cols) || 0,
    variables: {
      ...(existing.variables || {}),
      ...(incoming.variables || {}),
    },
  };
  if (String(format || "").toLowerCase() === "json") {
    return encodeHoverGridJsonPayload({ ...merged, gzipLevel });
  }
  return encodeHoverGridBinaryPayload({ ...merged, gzipLevel });
}

function inferHoverGridFormatFromKey(key) {
  return /\.bin\.gz(?:$|[?#])/i.test(String(key || "")) ? "binary" : "json";
}

function clampGzipLevel(value) {
  const num = Math.round(Number(value));
  return Number.isFinite(num) ? Math.max(0, Math.min(9, num)) : 1;
}

module.exports = {
  HOVER_GRID_BINARY_MAGIC,
  decodeHoverGridPayload,
  buildHoverGridBinaryRaw,
  clampGzipLevel,
  encodeHoverGridBinaryPayload,
  encodeHoverGridJsonPayload,
  inferHoverGridFormatFromKey,
  mergeHoverGridPayloads,
};
