"use strict";

const {
  compressHoverGridSync,
  decompressHoverGridSync,
  inferHoverGridCompressionFromKey,
  resolveHoverGridCompressionConfig,
} = require("./hover-grid-compression");
const {
  HOVER_GRID_ENCODING,
  HOVER_GRID_ENCODINGS,
  resolveHoverGridEncodingDescriptor,
} = require("./hover-grid-encoding");

const HOVER_GRID_BINARY_MAGIC = "MVHG";

// Schema v3 payloads carry their own magic so pre-v3 decoders fail loudly
// (unknown container) instead of silently reading delta residue as absolute
// values; stored artifacts outlive code versions even with no legacy
// clients.
const HOVER_GRID_BINARY_MAGIC_V3 = "MVH3";
const HOVER_GRID_BINARY_MAGIC_V4 = "MVH4";

function encodeHoverGridBinaryPayload(payload = {}) {
  const raw = buildHoverGridBinaryRaw(payload);
  return compressHoverGridSync(raw, compressionConfigFromPayload(payload));
}

// Everything up to (but excluding) final lossless container compression, so
// the compression pool can run that step off-thread; encodeHoverGridBinaryPayload stays the
// single-call form and both produce identical bytes.
function buildHoverGridBinaryRaw(options = {}) {
  return buildHoverGridBinaryRawWithAllocator(options, (byteLength) => Buffer.allocUnsafe(byteLength));
}

// Renderer-only packing target for the compression helper. The allocation is
// exact (no pooled backing), and every byte is published before the returned
// view is submitted. The caller retains this immutable SAB until codec
// settlement so worker failure can run the same inline codec without a copy.
function _buildHoverGridBinaryRawShared(options = {}) {
  return buildHoverGridBinaryRawWithAllocator(options, (byteLength) => Buffer.from(new SharedArrayBuffer(byteLength)));
}

function buildHoverGridBinaryRawWithAllocator(
  { schemaVersion, rows, cols, variables = {}, encoding = null } = {},
  allocateRaw,
) {
  const resolvedSchemaVersion = resolveWriteSchemaVersion(schemaVersion, encoding);
  const resolvedEncoding = resolveWriteEncoding(resolvedSchemaVersion, encoding);
  const resolvedRows = Number(rows) || 0;
  const resolvedCols = Number(cols) || 0;
  const cells = resolvedRows * resolvedCols;
  const hasCanonicalDimensions =
    Number.isSafeInteger(resolvedRows) &&
    resolvedRows > 0 &&
    Number.isSafeInteger(resolvedCols) &&
    resolvedCols > 0 &&
    Number.isSafeInteger(cells) &&
    cells > 0;
  if (resolvedSchemaVersion === HOVER_GRID_ENCODINGS.mvh4.schemaVersion && !hasCanonicalDimensions) {
    throw new Error("MVH4 hover dimensions must be positive safe integers");
  }
  const dataBodies = [];
  const headerVariables = {};
  let byteOffset = 0;
  let deltaEncodedBodies = 0;
  let absoluteBodies = 0;
  for (const [key, variable] of Object.entries(variables || {})) {
    const values = variable?.values;
    if (!(values instanceof Int16Array)) {
      if (resolvedSchemaVersion === HOVER_GRID_ENCODINGS.mvh4.schemaVersion) {
        throw new Error(`MVH4 hover variable '${key}' must contain an Int16Array`);
      }
      continue;
    }
    if (!key || !isSafeHoverGridVariableKey(key)) {
      throw new Error(`hover variable key ${JSON.stringify(key)} is unsafe or empty`);
    }
    const scale = Number(variable.scale);
    const offset = Number(variable.offset);
    const missing = Number(variable.missing);
    if (
      resolvedSchemaVersion === HOVER_GRID_ENCODINGS.mvh4.schemaVersion &&
      (!Number.isFinite(scale) ||
        scale <= 0 ||
        !Number.isFinite(offset) ||
        !Number.isInteger(missing) ||
        missing < -32768 ||
        missing > 32767)
    ) {
      throw new Error(`MVH4 hover variable '${key}' has invalid quantization metadata`);
    }
    const body = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const deltaEncoded = variable.deltaEncoded === true;
    const hasPredictorMarker = Object.prototype.hasOwnProperty.call(variable, "predictorEncoded");
    const predictorEncoded = variable.predictorEncoded;
    if (hasPredictorMarker && predictorEncoded !== "gradient2d") {
      throw new Error(`hover variable '${key}' has unknown predictor marker ${JSON.stringify(predictorEncoded)}`);
    }
    if (deltaEncoded && hasPredictorMarker) {
      throw new Error(`hover variable '${key}' cannot be both pre-delta and pre-gradient encoded`);
    }
    if (resolvedSchemaVersion === HOVER_GRID_ENCODINGS.mvh4.schemaVersion && deltaEncoded) {
      throw new Error(`MVH4 gradient2d requires absolute hover values; '${key}' is pre-delta encoded`);
    }
    if (resolvedSchemaVersion !== HOVER_GRID_ENCODINGS.mvh4.schemaVersion && hasPredictorMarker) {
      throw new Error(`${resolvedEncoding?.magic || "MVHG"} cannot contain pre-gradient hover variable '${key}'`);
    }
    if (resolvedSchemaVersion === HOVER_GRID_ENCODINGS.mvh4.schemaVersion && values.length !== cells) {
      throw new Error(`MVH4 hover variable '${key}' length ${values.length} does not match rows*cols ${cells}`);
    }
    if (body.length > 0) {
      if (deltaEncoded) {
        if (
          !Number.isInteger(variable.deltaEndValue) ||
          variable.deltaEndValue < -32768 ||
          variable.deltaEndValue > 32767
        ) {
          throw new Error(`pre-delta hover variable '${key}' is missing a valid signed Int16 end value`);
        }
        deltaEncodedBodies += 1;
      } else {
        absoluteBodies += 1;
      }
    }
    dataBodies.push({
      body,
      byteOffset,
      length: values.length,
      deltaEncoded,
      deltaEndValue: Number(variable.deltaEndValue),
      gradientEncoded: hasPredictorMarker && predictorEncoded === "gradient2d",
    });
    headerVariables[key] = {
      scale: Number.isFinite(scale) ? scale : 1,
      offset: Number.isFinite(offset) ? offset : 0,
      missing: Number.isFinite(missing) ? missing : -32768,
      byteOffset,
      length: values.length,
    };
    byteOffset += body.length;
  }
  if (deltaEncodedBodies > 0 && absoluteBodies > 0) {
    throw new Error("hover binary payload cannot mix absolute and pre-delta variable bodies");
  }
  const usesPreDeltaBodies = deltaEncodedBodies > 0;
  if (usesPreDeltaBodies && resolvedSchemaVersion < 3) {
    throw new Error("pre-delta hover variable bodies require schema version 3 or newer");
  }
  if (byteOffset === 0) {
    const supportsCanonicalEmpty =
      resolvedSchemaVersion === HOVER_GRID_ENCODINGS.mvh3.schemaVersion ||
      resolvedSchemaVersion === HOVER_GRID_ENCODINGS.mvh4.schemaVersion;
    const plainEmptyVariables = isPlainRecord(variables) && Object.keys(variables).length === 0;
    if (!supportsCanonicalEmpty || !hasCanonicalDimensions || !plainEmptyVariables || dataBodies.length !== 0) {
      throw new Error("empty binary hover payloads require canonical MVH3/MVH4 dimensions and variables:{}");
    }
  }
  const header = serializeHoverGridBinaryHeader({
    schemaVersion: resolvedSchemaVersion,
    rows: resolvedRows,
    cols: resolvedCols,
    encoding: resolvedEncoding,
    variables: headerVariables,
  });
  const rawSize = 8 + header.length + byteOffset;
  const raw = allocateRaw(rawSize);
  if (!Buffer.isBuffer(raw) || raw.length !== rawSize) {
    throw new Error(`hover raw allocator returned ${String(raw?.length)} bytes; expected ${rawSize}`);
  }
  raw.write(resolvedEncoding?.magic || HOVER_GRID_BINARY_MAGIC, 0, "ascii");
  raw.writeUInt32LE(header.length, 4);
  header.copy(raw, 8);
  let cursor = 8 + header.length;
  let previous = 0;
  for (const { body, deltaEncoded, deltaEndValue } of dataBodies) {
    body.copy(raw, cursor);
    if (deltaEncoded && body.length > 0) {
      // Each variable was fused independently from a zero carry while its
      // source grid was hot in the quantizer. Adjust only the first residue
      // so concatenation is exactly the schema-v3 global delta stream.
      const localFirst = raw.readInt16LE(cursor);
      raw.writeInt16LE(wrapInt16(localFirst - previous), cursor);
      previous = deltaEndValue;
    }
    cursor += body.length;
  }
  if (resolvedSchemaVersion >= 3 && byteOffset > 0 && !usesPreDeltaBodies) {
    if (resolvedSchemaVersion === HOVER_GRID_ENCODINGS.mvh3.schemaVersion) {
      // MVH3 is frozen: one lossless global int16 delta stream with carry
      // across rows and variable boundaries.
      deltaEncodeInt16Region(raw, 8 + header.length, byteOffset);
    } else if (resolvedSchemaVersion === HOVER_GRID_ENCODINGS.mvh4.schemaVersion) {
      // MVH4 predicts each variable independently over its real 2D shape.
      // Its source is always absolute quantized data; pre-delta planes are
      // rejected above rather than guessed or reconstructed.
      for (const body of dataBodies) {
        if (!body.gradientEncoded) {
          gradientEncodeInt16Region(raw, 8 + header.length + body.byteOffset, resolvedRows, resolvedCols);
        }
      }
    }
  }
  return raw;
}

// One serializer owns the byte-exact JSON field order and alignment for both
// the generic packer above and the renderer-private direct-final MVH4 arena.
// `variables` contains header descriptors only; callers must validate their
// data ownership and ranges before invoking this small deterministic helper.
function serializeHoverGridBinaryHeader({ schemaVersion, rows, cols, encoding = null, variables = {} } = {}) {
  const headerValue = {
    schemaVersion,
    rows,
    cols,
    ...(encoding?.headerPredictor ? { predictor: encoding.headerPredictor } : {}),
    variables,
  };
  let header = Buffer.from(JSON.stringify(headerValue));
  if (header.length % 2 === 1) {
    // Keep the Int16 data region 2-byte aligned (JSON tolerates the pad).
    header = Buffer.concat([header, Buffer.from(" ")]);
  }
  return header;
}

function resolveWriteSchemaVersion(schemaVersion, encoding) {
  const descriptor =
    encoding === null || encoding === undefined
      ? null
      : typeof encoding === "string"
        ? resolveHoverGridEncodingDescriptor(encoding)
        : encoding;
  const candidate = schemaVersion === undefined ? (descriptor?.schemaVersion ?? 1) : Number(schemaVersion);
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 4) {
    throw new Error(`unsupported hover binary schema version ${JSON.stringify(schemaVersion)}`);
  }
  if (descriptor && descriptor.schemaVersion !== candidate) {
    throw new Error(
      `hover encoding ${descriptor.id || "unknown"} requires schema ${descriptor.schemaVersion}; received ${candidate}`,
    );
  }
  return candidate;
}

function resolveWriteEncoding(schemaVersion, encoding) {
  if (schemaVersion <= 2) {
    if (encoding !== null && encoding !== undefined) {
      throw new Error(`legacy MVHG schema ${schemaVersion} cannot carry an MVH3/MVH4 encoding descriptor`);
    }
    return null;
  }
  const expected =
    schemaVersion === HOVER_GRID_ENCODINGS.mvh4.schemaVersion ? HOVER_GRID_ENCODINGS.mvh4 : HOVER_GRID_ENCODINGS.mvh3;
  if (encoding === null || encoding === undefined) {
    return expected;
  }
  const resolved = typeof encoding === "string" ? resolveHoverGridEncodingDescriptor(encoding) : encoding;
  if (
    !resolved ||
    resolved.id !== expected.id ||
    resolved.schemaVersion !== expected.schemaVersion ||
    resolved.magic !== expected.magic ||
    resolved.predictor !== expected.predictor
  ) {
    throw new Error(`schema ${schemaVersion} requires the canonical ${expected.id} encoding descriptor`);
  }
  return expected;
}

function wrapInt16(value) {
  return (value << 16) >> 16;
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

function gradientEncodeInt16Region(buffer, start, rows, cols) {
  const count = rows * cols;
  if ((buffer.byteOffset + start) % 2 === 0) {
    const values = new Int16Array(buffer.buffer, buffer.byteOffset + start, count);
    // Walk backward so every left/up/up-left predictor still contains its
    // absolute value; this makes the exact transform in-place without a
    // second variable-sized owner.
    for (let row = rows - 1; row >= 0; row -= 1) {
      const rowStart = row * cols;
      for (let col = cols - 1; col >= 0; col -= 1) {
        const index = rowStart + col;
        const value = values[index];
        const predictor =
          row === 0
            ? col === 0
              ? 0
              : values[index - 1]
            : col === 0
              ? values[index - cols]
              : values[index - 1] + values[index - cols] - values[index - cols - 1];
        values[index] = wrapInt16(value - predictor);
      }
    }
    return;
  }
  const read = (index) => buffer.readInt16LE(start + index * 2);
  const write = (index, value) => buffer.writeInt16LE(wrapInt16(value), start + index * 2);
  for (let row = rows - 1; row >= 0; row -= 1) {
    const rowStart = row * cols;
    for (let col = cols - 1; col >= 0; col -= 1) {
      const index = rowStart + col;
      const value = read(index);
      const predictor =
        row === 0
          ? col === 0
            ? 0
            : read(index - 1)
          : col === 0
            ? read(index - cols)
            : read(index - 1) + read(index - cols) - read(index - cols - 1);
      write(index, value - predictor);
    }
  }
}

function gradientDecodeInt16Region(buffer, start, rows, cols) {
  const count = rows * cols;
  if ((buffer.byteOffset + start) % 2 === 0) {
    const values = new Int16Array(buffer.buffer, buffer.byteOffset + start, count);
    let left = 0;
    for (let col = 0; col < cols; col += 1) {
      left = wrapInt16(left + values[col]);
      values[col] = left;
    }
    for (let row = 1; row < rows; row += 1) {
      const rowStart = row * cols;
      let upLeft = values[rowStart - cols];
      let leftAbsolute = wrapInt16(values[rowStart] + upLeft);
      values[rowStart] = leftAbsolute;
      for (let col = 1; col < cols; col += 1) {
        const index = rowStart + col;
        const up = values[index - cols];
        leftAbsolute = wrapInt16(values[index] + leftAbsolute + up - upLeft);
        values[index] = leftAbsolute;
        upLeft = up;
      }
    }
    return;
  }
  const read = (index) => buffer.readInt16LE(start + index * 2);
  const write = (index, value) => buffer.writeInt16LE(wrapInt16(value), start + index * 2);
  let left = 0;
  for (let col = 0; col < cols; col += 1) {
    left = wrapInt16(left + read(col));
    write(col, left);
  }
  for (let row = 1; row < rows; row += 1) {
    const rowStart = row * cols;
    let upLeft = read(rowStart - cols);
    let leftAbsolute = wrapInt16(read(rowStart) + upLeft);
    write(rowStart, leftAbsolute);
    for (let col = 1; col < cols; col += 1) {
      const index = rowStart + col;
      const up = read(index - cols);
      leftAbsolute = wrapInt16(read(index) + leftAbsolute + up - upLeft);
      write(index, leftAbsolute);
      upLeft = up;
    }
  }
}

function encodeHoverGridJsonPayload(options = {}) {
  const { schemaVersion = 1, rows, cols, variables = {} } = options;
  const variableValues = Object.values(variables || {});
  if (variableValues.some((variable) => variable?.deltaEncoded === true)) {
    throw new Error("pre-delta hover variables require the binary schema-v3 container");
  }
  if (variableValues.some((variable) => Object.prototype.hasOwnProperty.call(variable || {}, "predictorEncoded"))) {
    throw new Error("pre-gradient hover variables require the binary schema-v4 container");
  }
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
  return compressHoverGridSync(Buffer.from(JSON.stringify(payload)), compressionConfigFromPayload(options));
}

function decodeHoverGridPayload(body, { contentEncoding = null } = {}) {
  const raw = decompressHoverGridSync(body, contentEncoding);
  const magic = raw.subarray(0, 4).toString("ascii");
  if (
    magic === HOVER_GRID_BINARY_MAGIC ||
    magic === HOVER_GRID_BINARY_MAGIC_V3 ||
    magic === HOVER_GRID_BINARY_MAGIC_V4
  ) {
    return decodeHoverGridBinaryRaw(raw);
  }
  const jsonText = raw.toString("utf8");
  if (!jsonText.trimStart().startsWith("{")) {
    throw new Error(`unknown hover-grid container magic ${JSON.stringify(magic)}`);
  }
  const payload = JSON.parse(jsonText);
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

function decodeHoverGridBinaryRaw(input) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const layout = parseHoverGridBinaryRaw(raw);
  if (layout.encoding === "global1d") {
    deltaDecodeInt16Region(raw, layout.dataStart, layout.dataBytes);
  } else if (layout.encoding === "gradient2d") {
    for (const range of layout.variables) {
      gradientDecodeInt16Region(raw, layout.dataStart + range.byteOffset, layout.rows, layout.cols);
    }
  }
  const variables = {};
  for (const range of layout.variables) {
    const bytes = raw.subarray(
      layout.dataStart + range.byteOffset,
      layout.dataStart + range.byteOffset + range.byteLength,
    );
    variables[range.key] = {
      scale: range.scale,
      offset: range.offset,
      missing: range.missing,
      values: new Int16Array(Uint8Array.from(bytes).buffer),
    };
  }
  return {
    schemaVersion: layout.schemaVersion,
    rows: layout.rows,
    cols: layout.cols,
    variables,
  };
}

function parseHoverGridBinaryRaw(input) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (raw.length < 8) {
    throw new Error("hover binary container is shorter than its fixed header");
  }
  const magic = raw.subarray(0, 4).toString("ascii");
  if (
    magic !== HOVER_GRID_BINARY_MAGIC &&
    magic !== HOVER_GRID_BINARY_MAGIC_V3 &&
    magic !== HOVER_GRID_BINARY_MAGIC_V4
  ) {
    throw new Error(`unknown hover binary magic ${JSON.stringify(magic)}`);
  }
  const headerLength = raw.readUInt32LE(4);
  const dataStart = 8 + headerLength;
  if (headerLength <= 0 || !Number.isSafeInteger(dataStart) || dataStart > raw.length) {
    throw new Error("hover binary header length is empty, unsafe, or truncated");
  }
  if ((dataStart & 1) !== 0) {
    throw new Error("hover binary data start is not Int16-aligned");
  }
  let header;
  try {
    header = JSON.parse(raw.subarray(8, dataStart).toString("utf8"));
  } catch (error) {
    throw new Error(`hover binary header JSON is invalid: ${error.message}`, { cause: error });
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new Error("hover binary header must be an object");
  }
  const schemaVersion = header.schemaVersion;
  const encoding = resolveReadEncoding(magic, schemaVersion, header);
  const rows = header.rows;
  const cols = header.cols;
  if (
    !Number.isSafeInteger(rows) ||
    rows <= 0 ||
    !Number.isSafeInteger(cols) ||
    cols <= 0 ||
    rows > Number.MAX_SAFE_INTEGER / cols
  ) {
    throw new Error("hover binary rows and cols must be positive safe integers");
  }
  const cells = rows * cols;
  if (!Number.isSafeInteger(cells) || cells <= 0 || cells > Number.MAX_SAFE_INTEGER / Int16Array.BYTES_PER_ELEMENT) {
    throw new Error("hover binary rows*cols is unsafe");
  }
  const rawVariables = header.variables;
  if (!rawVariables || typeof rawVariables !== "object" || Array.isArray(rawVariables)) {
    throw new Error("hover binary variables must be an object");
  }
  const entries = Object.entries(rawVariables);
  if (
    entries.length === 0 &&
    schemaVersion !== HOVER_GRID_ENCODINGS.mvh3.schemaVersion &&
    schemaVersion !== HOVER_GRID_ENCODINGS.mvh4.schemaVersion
  ) {
    throw new Error("empty hover binary containers are supported only by canonical schema 3 or 4");
  }
  const variables = [];
  let expectedByteOffset = 0;
  for (const [key, meta] of entries) {
    if (!key || !isSafeHoverGridVariableKey(key)) {
      throw new Error(`unsafe hover binary variable key ${JSON.stringify(key)}`);
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      throw new Error(`hover binary variable '${key}' descriptor must be an object`);
    }
    const byteOffset = meta.byteOffset;
    const length = meta.length;
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || (byteOffset & 1) !== 0) {
      throw new Error(`hover binary variable '${key}' has an invalid byteOffset`);
    }
    if (!Number.isSafeInteger(length) || length !== cells) {
      throw new Error(`hover binary variable '${key}' length must equal rows*cols`);
    }
    if (byteOffset !== expectedByteOffset) {
      throw new Error(`hover binary variable '${key}' layout is not canonical and contiguous`);
    }
    const scale = meta.scale;
    const offset = meta.offset;
    const missing = meta.missing;
    if (
      typeof scale !== "number" ||
      !Number.isFinite(scale) ||
      scale <= 0 ||
      typeof offset !== "number" ||
      !Number.isFinite(offset) ||
      typeof missing !== "number" ||
      !Number.isInteger(missing)
    ) {
      throw new Error(`hover binary variable '${key}' quantization metadata is invalid`);
    }
    if (missing < -32768 || missing > 32767) {
      throw new Error(`hover binary variable '${key}' missing sentinel is outside Int16`);
    }
    const byteLength = length * Int16Array.BYTES_PER_ELEMENT;
    const end = byteOffset + byteLength;
    if (!Number.isSafeInteger(end)) {
      throw new Error(`hover binary variable '${key}' byte range overflows`);
    }
    variables.push({ key, byteOffset, byteLength, length, scale, offset, missing });
    expectedByteOffset = end;
  }
  if (dataStart + expectedByteOffset !== raw.length) {
    throw new Error(
      `hover binary byte length mismatch: expected ${dataStart + expectedByteOffset}, received ${raw.length}`,
    );
  }
  return {
    raw,
    magic,
    header,
    headerLength,
    dataStart,
    dataBytes: expectedByteOffset,
    schemaVersion,
    encoding,
    rows,
    cols,
    cells,
    variables,
  };
}

function resolveReadEncoding(magic, schemaVersion, header) {
  if (!Number.isSafeInteger(schemaVersion)) {
    throw new Error("hover binary schemaVersion must be a safe integer");
  }
  const hasPredictor = Object.hasOwn(header, "predictor");
  if (magic === HOVER_GRID_BINARY_MAGIC && (schemaVersion === 1 || schemaVersion === 2) && !hasPredictor) {
    return "absolute";
  }
  if (magic === HOVER_GRID_BINARY_MAGIC_V3 && schemaVersion === 3 && !hasPredictor) {
    return "global1d";
  }
  if (
    magic === HOVER_GRID_BINARY_MAGIC_V4 &&
    schemaVersion === 4 &&
    header.predictor === HOVER_GRID_ENCODINGS.mvh4.predictor
  ) {
    return "gradient2d";
  }
  throw new Error(
    `hover binary magic/schema/predictor mismatch: magic=${JSON.stringify(magic)} schema=${JSON.stringify(
      schemaVersion,
    )} predictor=${JSON.stringify(header.predictor)}`,
  );
}

function isSafeHoverGridVariableKey(key) {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeHoverGridPayloads(
  existingBody,
  incomingBody,
  { format = "binary", gzipLevel = 1, compression = null, encoding = HOVER_GRID_ENCODING } = {},
) {
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
    return encodeHoverGridJsonPayload({ ...merged, gzipLevel, ...compressionPayloadFields(compression) });
  }
  const targetEncoding =
    typeof encoding === "string" ? resolveHoverGridEncodingDescriptor(encoding) : encoding || HOVER_GRID_ENCODING;
  return encodeHoverGridBinaryPayload({
    ...merged,
    schemaVersion: targetEncoding.schemaVersion,
    encoding: targetEncoding,
    gzipLevel,
    ...compressionPayloadFields(compression),
  });
}

function inferHoverGridFormatFromKey(key) {
  return /\.bin\.(?:gz|br)(?:$|[?#])/i.test(String(key || "")) ? "binary" : "json";
}

function compressionConfigFromPayload(payload = {}) {
  if (payload.compression && typeof payload.compression === "object") {
    return resolveHoverGridCompressionConfig(payload.compression);
  }
  return resolveHoverGridCompressionConfig({
    backend: payload.compressionBackend || "gzip",
    brotliQuality: payload.brotliQuality,
    gzipLevel: payload.gzipLevel,
  });
}

function compressionPayloadFields(compression) {
  if (!compression || typeof compression !== "object") {
    return {};
  }
  return { compression };
}

function clampGzipLevel(value) {
  const num = Math.round(Number(value));
  return Number.isFinite(num) ? Math.max(0, Math.min(9, num)) : 1;
}

module.exports = {
  _gradientEncodeInt16Region: gradientEncodeInt16Region,
  _isSafeHoverGridVariableKey: isSafeHoverGridVariableKey,
  _serializeHoverGridBinaryHeader: serializeHoverGridBinaryHeader,
  _buildHoverGridBinaryRawShared,
  HOVER_GRID_BINARY_MAGIC,
  HOVER_GRID_BINARY_MAGIC_V3,
  HOVER_GRID_BINARY_MAGIC_V4,
  decodeHoverGridBinaryRaw,
  decodeHoverGridPayload,
  buildHoverGridBinaryRaw,
  clampGzipLevel,
  encodeHoverGridBinaryPayload,
  encodeHoverGridJsonPayload,
  inferHoverGridCompressionFromKey,
  inferHoverGridFormatFromKey,
  mergeHoverGridPayloads,
  parseHoverGridBinaryRaw,
};
