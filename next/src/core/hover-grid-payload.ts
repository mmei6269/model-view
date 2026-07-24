import type { HoverGridPayload, HoverGridVariable, HoverGridVariableKey } from "../types";

const HOVER_GRID_BINARY_MAGIC = "MVHG";
// v3 payloads (global int16 delta region) carry their own magic so older
// decoders reject them instead of reading delta residue as data.
const HOVER_GRID_BINARY_MAGIC_V3 = "MVH3";
const HOVER_GRID_BINARY_MAGIC_V4 = "MVH4";
const HOVER_GRID_PREDICTOR_GRADIENT_2D = "gradient2d";
const MAX_FALLBACK_DATA_AMPLIFICATION = 2;
// Legacy JSON hover payloads decode on the browser main thread. These bounds
// leave more than 10x headroom over the current 980x1600 producer grid while
// preventing dimensions or base64 text from becoming allocation instructions.
const MAX_JSON_DATA_AMPLIFICATION = 2;
const MAX_JSON_HOVER_GRID_CELLS = 16 * 1024 * 1024;
const MAX_JSON_HOVER_GRID_DECODED_BYTES = 512 * 1024 * 1024;
const MAX_JSON_HOVER_GRID_ENCODED_CHARS = 768 * 1024 * 1024;
const EMPTY_HOVER_GRID_PAYLOAD: HoverGridPayload = {
  schemaVersion: 1,
  rows: 0,
  cols: 0,
  variables: {},
};
const NATIVE_LITTLE_ENDIAN = (() => {
  const probe = new Uint16Array([0x0102]);
  return new Uint8Array(probe.buffer)[0] === 0x02;
})();

interface BinaryHoverGridVariable extends HoverGridVariable {
  byteOffset?: number;
  length?: number;
}

interface BinaryHoverGridHeader {
  schemaVersion?: number;
  rows?: number;
  cols?: number;
  predictor?: string;
  variables?: Partial<Record<HoverGridVariableKey, BinaryHoverGridVariable>>;
}

interface ParsedBinaryHoverGrid {
  buffer: ArrayBuffer;
  bytes: Uint8Array;
  magic: string;
  header: BinaryHoverGridHeader;
  dataStart: number;
}

interface CanonicalBinaryHoverGridVariable {
  key: string;
  variable: BinaryHoverGridVariable;
  byteOffset: number;
  length: number;
}

interface CanonicalBinaryHoverGridLayout {
  rows: number;
  cols: number;
  schemaVersion: number;
  dataStart: number;
  dataLength: number;
  encoding: "absolute" | "global1d" | "gradient2d";
  variables: CanonicalBinaryHoverGridVariable[];
}

interface ResolvedFallbackBinaryHoverGridVariable {
  key: string;
  variable: BinaryHoverGridVariable;
  byteOffset: number;
  length: number;
}

export function normalizeHoverGridPayload(input: HoverGridPayload): HoverGridPayload {
  const rows = Number(input?.rows);
  const cols = Number(input?.cols);
  const expectedLength = safeJsonHoverGridCellCount(rows, cols);
  if (expectedLength === null) {
    return emptyHoverGridPayload();
  }
  const rawVariables = Object.entries(input?.variables || {});
  const expectedBytes = expectedLength * Int16Array.BYTES_PER_ELEMENT;
  let aggregateDecodedBytes = 0;
  let aggregateEncodedChars = 0;
  for (const [key, variable] of rawVariables) {
    if (!isSafeHoverGridVariableKey(key) || !variable) {
      continue;
    }
    const dataLength = typeof variable.data === "string" ? variable.data.length : 0;
    const canonicalEncodedChars = Math.ceil(expectedBytes / 3) * 4;
    aggregateDecodedBytes += expectedBytes;
    aggregateEncodedChars += dataLength;
    if (
      !Number.isSafeInteger(aggregateDecodedBytes) ||
      aggregateDecodedBytes > MAX_JSON_HOVER_GRID_DECODED_BYTES ||
      !Number.isSafeInteger(aggregateEncodedChars) ||
      aggregateEncodedChars > MAX_JSON_HOVER_GRID_ENCODED_CHARS ||
      expectedBytes > dataLength * MAX_JSON_DATA_AMPLIFICATION ||
      dataLength > canonicalEncodedChars * MAX_JSON_DATA_AMPLIFICATION
    ) {
      return emptyHoverGridPayload();
    }
  }
  const variables: HoverGridPayload["variables"] = {};
  for (const [key, variable] of rawVariables) {
    if (!isSafeHoverGridVariableKey(key)) {
      continue;
    }
    const normalized = normalizeHoverGridVariable(variable, expectedLength);
    if (normalized) {
      variables[key] = normalized;
    }
  }
  return {
    schemaVersion: Number(input?.schemaVersion) || 1,
    rows: Number.isFinite(rows) ? rows : 0,
    cols: Number.isFinite(cols) ? cols : 0,
    variables,
  };
}

export function normalizeBinaryHoverGridPayload(input: ArrayBuffer): HoverGridPayload {
  // This generic entry point retains copy isolation: neither predictor
  // reconstruction nor later writes through returned Int16Array views can
  // mutate caller-owned bytes. The fetch path has a separate, explicit
  // ownership-transfer entry point below.
  let ownedCopy: ArrayBuffer;
  try {
    ownedCopy = input.slice(0);
  } catch {
    return emptyHoverGridPayload();
  }
  return normalizeOwnedBinaryHoverGridPayload(ownedCopy);
}

/**
 * Consumes an exclusively owned response ArrayBuffer. Canonical little-endian
 * binary payloads are reconstructed in place and expose zero-copy Int16Array
 * views over that owner. Callers must not reuse or mutate the input afterward.
 */
export function normalizeOwnedBinaryHoverGridPayload(input: ArrayBuffer): HoverGridPayload {
  const parsed = parseBinaryHoverGrid(input);
  if (!parsed) {
    return emptyHoverGridPayload();
  }

  const canonical = resolveCanonicalBinaryHoverGridLayout(parsed);
  if (canonical && NATIVE_LITTLE_ENDIAN && parsed.dataStart % Int16Array.BYTES_PER_ELEMENT === 0) {
    const viewed = buildCanonicalOwnedHoverGridPayload(parsed.buffer, canonical);
    if (viewed) {
      return viewed;
    }
  }

  if (canonical) {
    // A non-native platform retains exact decoding via byte-addressed copies.
    return decodeCanonicalBinaryHoverGridPayloadCopyIsolated(parsed, canonical);
  }
  if (isCompatibleLegacyBinaryEnvelope(parsed)) {
    // MVHG/MVH3 artifacts predate the canonical-only contract. Preserve the
    // bounded historical copy decoder for their numeric-string, reordered,
    // gapped, and unaligned layouts. MVH4 can never enter this path.
    return decodeCompatibleLegacyBinaryHoverGridPayloadCopyIsolated(parsed);
  }
  return emptyHoverGridPayload();
}

function parseBinaryHoverGrid(input: ArrayBuffer): ParsedBinaryHoverGrid | null {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(input);
  } catch {
    return null;
  }
  if (bytes.byteLength < 8) {
    return null;
  }
  const magic = textFromBytes(bytes.subarray(0, 4));
  if (
    magic !== HOVER_GRID_BINARY_MAGIC &&
    magic !== HOVER_GRID_BINARY_MAGIC_V3 &&
    magic !== HOVER_GRID_BINARY_MAGIC_V4
  ) {
    return null;
  }
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const dataStart = 8 + headerLength;
  if (!Number.isSafeInteger(dataStart) || dataStart < 8 || dataStart > bytes.byteLength) {
    return null;
  }
  let header: BinaryHoverGridHeader;
  try {
    header = JSON.parse(textFromBytes(bytes.subarray(8, dataStart))) as BinaryHoverGridHeader;
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    return null;
  }
  return { buffer: input, bytes, magic, header, dataStart };
}

function resolveCanonicalBinaryHoverGridLayout(parsed: ParsedBinaryHoverGrid): CanonicalBinaryHoverGridLayout | null {
  if (parsed.dataStart % Int16Array.BYTES_PER_ELEMENT !== 0) {
    return null;
  }
  const schemaVersion = parsed.header.schemaVersion;
  const rows = parsed.header.rows;
  const cols = parsed.header.cols;
  if (
    typeof schemaVersion !== "number" ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion <= 0 ||
    typeof rows !== "number" ||
    !Number.isSafeInteger(rows) ||
    rows <= 0 ||
    typeof cols !== "number" ||
    !Number.isSafeInteger(cols) ||
    cols <= 0 ||
    rows > Number.MAX_SAFE_INTEGER / cols
  ) {
    return null;
  }
  const hasPredictor = Object.prototype.hasOwnProperty.call(parsed.header, "predictor");
  const encoding =
    parsed.magic === HOVER_GRID_BINARY_MAGIC && (schemaVersion === 1 || schemaVersion === 2) && !hasPredictor
      ? "absolute"
      : parsed.magic === HOVER_GRID_BINARY_MAGIC_V3 && schemaVersion === 3 && !hasPredictor
        ? "global1d"
        : parsed.magic === HOVER_GRID_BINARY_MAGIC_V4 &&
            schemaVersion === 4 &&
            parsed.header.predictor === HOVER_GRID_PREDICTOR_GRADIENT_2D
          ? "gradient2d"
          : null;
  if (!encoding) {
    return null;
  }
  const expectedLength = rows * cols;
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength > Number.MAX_SAFE_INTEGER / Int16Array.BYTES_PER_ELEMENT
  ) {
    return null;
  }
  const rawVariables = parsed.header.variables;
  if (!rawVariables || typeof rawVariables !== "object" || Array.isArray(rawVariables)) {
    return null;
  }
  if (Object.keys(rawVariables).length === 0 && schemaVersion !== 3 && schemaVersion !== 4) {
    return null;
  }
  const dataLength = parsed.bytes.byteLength - parsed.dataStart;
  const variables: CanonicalBinaryHoverGridVariable[] = [];
  let cursor = 0;
  for (const [key, variable] of Object.entries(rawVariables)) {
    if (!isCanonicalHoverGridVariableKey(key)) {
      return null;
    }
    if (!variable || typeof variable !== "object" || Array.isArray(variable)) {
      return null;
    }
    const byteOffset = variable.byteOffset;
    const length = variable.length;
    const scale = variable.scale;
    const offset = variable.offset;
    const missing = variable.missing;
    if (
      typeof byteOffset !== "number" ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0 ||
      byteOffset % Int16Array.BYTES_PER_ELEMENT !== 0 ||
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length !== expectedLength ||
      length > Number.MAX_SAFE_INTEGER / Int16Array.BYTES_PER_ELEMENT ||
      typeof scale !== "number" ||
      !Number.isFinite(scale) ||
      scale <= 0 ||
      typeof offset !== "number" ||
      !Number.isFinite(offset) ||
      typeof missing !== "number" ||
      !Number.isInteger(missing) ||
      missing < -32768 ||
      missing > 32767
    ) {
      return null;
    }
    const byteLength = length * Int16Array.BYTES_PER_ELEMENT;
    const end = byteOffset + byteLength;
    if (
      !Number.isSafeInteger(end) ||
      byteOffset < cursor ||
      byteOffset !== cursor ||
      end > dataLength ||
      (parsed.dataStart + byteOffset) % Int16Array.BYTES_PER_ELEMENT !== 0
    ) {
      return null;
    }
    variables.push({ key, variable, byteOffset, length });
    cursor = end;
  }
  // A canonical payload has no gaps, overlaps, unreferenced data, or trailing
  // bytes. This also proves the global v3 delta region has an even length.
  if (cursor !== dataLength) {
    return null;
  }
  return {
    rows,
    cols,
    schemaVersion,
    dataStart: parsed.dataStart,
    dataLength,
    encoding,
    variables,
  };
}

function buildCanonicalOwnedHoverGridPayload(
  buffer: ArrayBuffer,
  layout: CanonicalBinaryHoverGridLayout,
): HoverGridPayload | null {
  let data: Int16Array;
  const variables: HoverGridPayload["variables"] = {};
  try {
    data = new Int16Array(buffer, layout.dataStart, layout.dataLength / Int16Array.BYTES_PER_ELEMENT);
    // Create every view before mutating either predictor stream. If a platform
    // rejects any view despite the gate, fallback still sees untouched bytes.
    for (const { key, variable, byteOffset, length } of layout.variables) {
      variables[key] = {
        scale: finiteOr(variable.scale, 1),
        offset: finiteOr(variable.offset, 0),
        missing: finiteOr(variable.missing, -32768),
        values: new Int16Array(buffer, layout.dataStart + byteOffset, length),
      };
    }
  } catch {
    return null;
  }
  if (layout.encoding === "global1d") {
    let previous = 0;
    for (let index = 0; index < data.length; index += 1) {
      previous = ((previous + data[index]) << 16) >> 16;
      data[index] = previous;
    }
  } else if (layout.encoding === "gradient2d") {
    for (const { key } of layout.variables) {
      const values = variables[key]?.values;
      if (!(values instanceof Int16Array)) {
        return null;
      }
      reconstructGradient2dInt16(values, layout.rows, layout.cols);
    }
  }
  return {
    schemaVersion: layout.schemaVersion,
    rows: layout.rows,
    cols: layout.cols,
    variables,
  };
}

function decodeCanonicalBinaryHoverGridPayloadCopyIsolated(
  parsed: ParsedBinaryHoverGrid,
  layout: CanonicalBinaryHoverGridLayout,
): HoverGridPayload {
  let isolated: ArrayBuffer;
  try {
    isolated = parsed.buffer.slice(0);
  } catch {
    return emptyHoverGridPayload();
  }
  const bytes = new Uint8Array(isolated);
  if (layout.encoding === "global1d") {
    reconstructV3Region(bytes, parsed.dataStart);
  } else if (layout.encoding === "gradient2d") {
    reconstructV4Variables(bytes, layout);
  }

  const variables: HoverGridPayload["variables"] = {};
  for (const { key, variable, length, byteOffset } of layout.variables) {
    const absoluteOffset = parsed.dataStart + byteOffset;
    const values = decodeBinaryInt16(bytes, absoluteOffset, length, layout.rows * layout.cols);
    variables[key] = {
      scale: finiteOr(variable.scale, 1),
      offset: finiteOr(variable.offset, 0),
      missing: finiteOr(variable.missing, -32768),
      values,
    };
  }
  return {
    schemaVersion: layout.schemaVersion,
    rows: layout.rows,
    cols: layout.cols,
    variables,
  };
}

function isCompatibleLegacyBinaryEnvelope(parsed: ParsedBinaryHoverGrid): boolean {
  const schemaVersion = parsed.header.schemaVersion;
  const hasPredictor = Object.prototype.hasOwnProperty.call(parsed.header, "predictor");
  return (
    !hasPredictor &&
    ((parsed.magic === HOVER_GRID_BINARY_MAGIC && (schemaVersion === 1 || schemaVersion === 2)) ||
      (parsed.magic === HOVER_GRID_BINARY_MAGIC_V3 && schemaVersion === 3))
  );
}

function decodeCompatibleLegacyBinaryHoverGridPayloadCopyIsolated(parsed: ParsedBinaryHoverGrid): HoverGridPayload {
  const rows = Number(parsed.header.rows);
  const cols = Number(parsed.header.cols);
  const expectedLength = safeHoverGridCellCount(rows, cols, parsed.bytes.byteLength - parsed.dataStart);
  if (expectedLength === null) {
    return emptyHoverGridPayload();
  }
  const rawVariableMap = parsed.header.variables;
  if (!rawVariableMap || typeof rawVariableMap !== "object" || Array.isArray(rawVariableMap)) {
    return emptyHoverGridPayload();
  }
  const rawVariables = Object.entries(rawVariableMap);
  if (rawVariables.length === 0) {
    return emptyHoverGridPayload();
  }
  const bytesPerDecodedVariable = expectedLength * Int16Array.BYTES_PER_ELEMENT;
  const availableDataBytes = parsed.bytes.byteLength - parsed.dataStart;
  const maximumAggregateDecodedBytes = availableDataBytes * MAX_FALLBACK_DATA_AMPLIFICATION;
  const resolvedVariables: ResolvedFallbackBinaryHoverGridVariable[] = [];
  let aggregateDecodedBytes = 0;
  for (const [key, variable] of rawVariables) {
    if (!variable || typeof variable !== "object" || Array.isArray(variable)) {
      return emptyHoverGridPayload();
    }
    const length = safeNonnegativeInteger(variable.length, expectedLength);
    const byteOffset = safeNonnegativeInteger(variable.byteOffset, 0);
    if (length === null || length !== expectedLength || byteOffset === null) {
      return emptyHoverGridPayload();
    }
    if (length > Number.MAX_SAFE_INTEGER / Int16Array.BYTES_PER_ELEMENT) {
      return emptyHoverGridPayload();
    }
    const byteLength = length * Int16Array.BYTES_PER_ELEMENT;
    const end = byteOffset + byteLength;
    if (!Number.isSafeInteger(end) || end > availableDataBytes) {
      return emptyHoverGridPayload();
    }
    if (!isCanonicalHoverGridVariableKey(key)) {
      continue;
    }
    aggregateDecodedBytes += bytesPerDecodedVariable;
    if (!Number.isSafeInteger(aggregateDecodedBytes) || aggregateDecodedBytes > maximumAggregateDecodedBytes) {
      return emptyHoverGridPayload();
    }
    resolvedVariables.push({ key, variable, byteOffset, length });
  }
  if (resolvedVariables.length === 0) {
    return emptyHoverGridPayload();
  }

  let isolated: ArrayBuffer;
  try {
    isolated = parsed.buffer.slice(0);
  } catch {
    return emptyHoverGridPayload();
  }
  const bytes = new Uint8Array(isolated);
  if (parsed.header.schemaVersion === 3 && bytes.byteLength > parsed.dataStart) {
    reconstructV3Region(bytes, parsed.dataStart);
  }

  const variables: HoverGridPayload["variables"] = {};
  for (const { key, variable, length, byteOffset } of resolvedVariables) {
    const absoluteOffset = parsed.dataStart + byteOffset;
    const values = decodeBinaryInt16(bytes, absoluteOffset, length, expectedLength);
    variables[key] = {
      scale: finiteOr(variable.scale, 1),
      offset: finiteOr(variable.offset, 0),
      missing: finiteOr(variable.missing, -32768),
      values,
    };
  }
  return {
    schemaVersion: Number(parsed.header.schemaVersion) || 1,
    rows: Number.isFinite(rows) ? rows : 0,
    cols: Number.isFinite(cols) ? cols : 0,
    variables,
  };
}

function reconstructV3Region(bytes: Uint8Array, dataStart: number): void {
  const count = (bytes.byteLength - dataStart) >> 1;
  const regionOffset = bytes.byteOffset + dataStart;
  let previous = 0;
  if (NATIVE_LITTLE_ENDIAN && regionOffset % Int16Array.BYTES_PER_ELEMENT === 0) {
    const data = new Int16Array(bytes.buffer, regionOffset, count);
    for (let index = 0; index < count; index += 1) {
      previous = ((previous + data[index]) << 16) >> 16;
      data[index] = previous;
    }
    return;
  }
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index += 1) {
    previous = ((previous + dataView.getInt16(dataStart + index * 2, true)) << 16) >> 16;
    dataView.setInt16(dataStart + index * 2, previous, true);
  }
}

function reconstructGradient2dInt16(values: Int16Array, rows: number, cols: number): void {
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
}

function reconstructV4Variables(bytes: Uint8Array, layout: CanonicalBinaryHoverGridLayout): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const variable of layout.variables) {
    const start = layout.dataStart + variable.byteOffset;
    const read = (index: number) => view.getInt16(start + index * Int16Array.BYTES_PER_ELEMENT, true);
    const write = (index: number, value: number) =>
      view.setInt16(start + index * Int16Array.BYTES_PER_ELEMENT, wrapInt16(value), true);
    let left = 0;
    for (let col = 0; col < layout.cols; col += 1) {
      left = wrapInt16(left + read(col));
      write(col, left);
    }
    for (let row = 1; row < layout.rows; row += 1) {
      const rowStart = row * layout.cols;
      let upLeft = read(rowStart - layout.cols);
      let leftAbsolute = wrapInt16(read(rowStart) + upLeft);
      write(rowStart, leftAbsolute);
      for (let col = 1; col < layout.cols; col += 1) {
        const index = rowStart + col;
        const up = read(index - layout.cols);
        leftAbsolute = wrapInt16(read(index) + leftAbsolute + up - upLeft);
        write(index, leftAbsolute);
        upLeft = up;
      }
    }
  }
}

function wrapInt16(value: number): number {
  return (value << 16) >> 16;
}

function safeHoverGridCellCount(rows: number, cols: number, availableDataBytes: number): number | null {
  if (
    !Number.isSafeInteger(rows) ||
    rows <= 0 ||
    !Number.isSafeInteger(cols) ||
    cols <= 0 ||
    rows > Number.MAX_SAFE_INTEGER / cols
  ) {
    return null;
  }
  const cellCount = rows * cols;
  if (
    !Number.isSafeInteger(cellCount) ||
    cellCount > Number.MAX_SAFE_INTEGER / Int16Array.BYTES_PER_ELEMENT ||
    cellCount * Int16Array.BYTES_PER_ELEMENT > availableDataBytes
  ) {
    return null;
  }
  return cellCount;
}

function safeJsonHoverGridCellCount(rows: number, cols: number): number | null {
  if (
    !Number.isSafeInteger(rows) ||
    rows <= 0 ||
    !Number.isSafeInteger(cols) ||
    cols <= 0 ||
    rows > Number.MAX_SAFE_INTEGER / cols
  ) {
    return null;
  }
  const cellCount = rows * cols;
  return Number.isSafeInteger(cellCount) && cellCount <= MAX_JSON_HOVER_GRID_CELLS ? cellCount : null;
}

function safeNonnegativeInteger(value: unknown, fallback: number): number | null {
  const resolved = value === undefined || value === null ? fallback : Math.round(Number(value));
  return Number.isSafeInteger(resolved) && resolved >= 0 ? resolved : null;
}

function finiteOr(value: unknown, fallback: number): number {
  const resolved = Number(value);
  return Number.isFinite(resolved) ? resolved : fallback;
}

function isSafeHoverGridVariableKey(key: string): boolean {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function isCanonicalHoverGridVariableKey(key: string): boolean {
  return key.length > 0 && isSafeHoverGridVariableKey(key);
}

function emptyHoverGridPayload(): HoverGridPayload {
  return {
    schemaVersion: EMPTY_HOVER_GRID_PAYLOAD.schemaVersion,
    rows: EMPTY_HOVER_GRID_PAYLOAD.rows,
    cols: EMPTY_HOVER_GRID_PAYLOAD.cols,
    variables: {},
  };
}

function normalizeHoverGridVariable(
  input: HoverGridVariable | undefined,
  expectedLength: number,
): HoverGridVariable | null {
  if (!input) {
    return null;
  }
  const scale = Number(input.scale);
  const offset = Number(input.offset);
  const missing = Number.isFinite(Number(input.missing)) ? Number(input.missing) : -32768;
  const data = typeof input.data === "string" ? input.data : "";
  const values = decodeBase64Int16(data, expectedLength);
  if (!values) {
    return null;
  }
  return {
    scale: Number.isFinite(scale) ? scale : 1,
    offset: Number.isFinite(offset) ? offset : 0,
    missing,
    values,
  };
}

function decodeBase64Int16(data: string, expectedLength: number): Int16Array | null {
  try {
    if (!data) {
      return expectedLength === 0 ? new Int16Array(0) : null;
    }
    const binary = atob(data);
    const expectedBytes = expectedLength * Int16Array.BYTES_PER_ELEMENT;
    if (binary.length < expectedBytes) {
      return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (view.length === expectedLength) {
      return view;
    }
    const resized = new Int16Array(expectedLength);
    resized.set(view.subarray(0, expectedLength));
    return resized;
  } catch {
    return null;
  }
}

function decodeBinaryInt16(bytes: Uint8Array, byteOffset: number, length: number, expectedLength: number): Int16Array {
  const resolvedLength = Math.max(0, Number.isFinite(expectedLength) && expectedLength > 0 ? expectedLength : length);
  const values = new Int16Array(resolvedLength);
  const requestedBytes =
    length <= Number.MAX_SAFE_INTEGER / Int16Array.BYTES_PER_ELEMENT ? length * Int16Array.BYTES_PER_ELEMENT : 0;
  const availableBytes = Math.max(0, Math.min(requestedBytes, bytes.byteLength - byteOffset));
  const view = new DataView(bytes.buffer, bytes.byteOffset + byteOffset, availableBytes);
  const count = Math.min(resolvedLength, Math.floor(availableBytes / 2));
  for (let index = 0; index < count; index += 1) {
    values[index] = view.getInt16(index * 2, true);
  }
  return values;
}

function textFromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
