"use strict";

const zlib = require("zlib");

const HOVER_GRID_BINARY_MAGIC = "MVHG";

function encodeHoverGridBinaryPayload({ schemaVersion = 1, rows, cols, variables = {}, gzipLevel = 1 } = {}) {
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
  const header = Buffer.from(
    JSON.stringify({
      schemaVersion: Number(schemaVersion) || 1,
      rows: Number(rows) || 0,
      cols: Number(cols) || 0,
      variables: headerVariables,
    }),
  );
  const raw = Buffer.allocUnsafe(8 + header.length + byteOffset);
  raw.write(HOVER_GRID_BINARY_MAGIC, 0, "ascii");
  raw.writeUInt32LE(header.length, 4);
  header.copy(raw, 8);
  let cursor = 8 + header.length;
  for (const body of dataBodies) {
    body.copy(raw, cursor);
    cursor += body.length;
  }
  return zlib.gzipSync(raw, { level: clampGzipLevel(gzipLevel) });
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
  if (raw.subarray(0, 4).toString("ascii") === HOVER_GRID_BINARY_MAGIC) {
    const headerLength = raw.readUInt32LE(4);
    const header = JSON.parse(raw.subarray(8, 8 + headerLength).toString("utf8"));
    const dataStart = 8 + headerLength;
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
  encodeHoverGridBinaryPayload,
  encodeHoverGridJsonPayload,
  inferHoverGridFormatFromKey,
  mergeHoverGridPayloads,
};
