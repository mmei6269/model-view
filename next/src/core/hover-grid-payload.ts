import type { HoverGridPayload, HoverGridVariable, HoverGridVariableKey } from "../types";

const HOVER_GRID_BINARY_MAGIC = "MVHG";

export function normalizeHoverGridPayload(input: HoverGridPayload): HoverGridPayload {
  const rows = Number(input?.rows);
  const cols = Number(input?.cols);
  const variables: HoverGridPayload["variables"] = {};
  for (const [key, variable] of Object.entries(input?.variables || {})) {
    const normalized = normalizeHoverGridVariable(variable, rows, cols);
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
  const bytes = new Uint8Array(input || new ArrayBuffer(0));
  if (bytes.byteLength < 8 || textFromBytes(bytes.subarray(0, 4)) !== HOVER_GRID_BINARY_MAGIC) {
    return normalizeHoverGridPayload({ schemaVersion: 1, rows: 0, cols: 0, variables: {} });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4, true);
  const headerStart = 8;
  const headerEnd = headerStart + headerLength;
  if (!Number.isFinite(headerLength) || headerEnd > bytes.byteLength) {
    return normalizeHoverGridPayload({ schemaVersion: 1, rows: 0, cols: 0, variables: {} });
  }
  let header: {
    schemaVersion?: number;
    rows?: number;
    cols?: number;
    variables?: Partial<Record<HoverGridVariableKey, HoverGridVariable & { byteOffset?: number; length?: number }>>;
  };
  try {
    header = JSON.parse(textFromBytes(bytes.subarray(headerStart, headerEnd)));
  } catch {
    return normalizeHoverGridPayload({ schemaVersion: 1, rows: 0, cols: 0, variables: {} });
  }
  const rows = Number(header.rows);
  const cols = Number(header.cols);
  const expectedLength = Number.isFinite(rows) && Number.isFinite(cols) && rows > 0 && cols > 0 ? rows * cols : 0;
  const variables: HoverGridPayload["variables"] = {};
  const dataStart = headerEnd;
  for (const [key, variable] of Object.entries(header.variables || {})) {
    if (!variable) {
      continue;
    }
    const length = Math.max(0, Math.round(Number(variable.length) || expectedLength));
    const byteOffset = Math.max(0, Math.round(Number(variable.byteOffset) || 0));
    const values = decodeBinaryInt16(bytes, dataStart + byteOffset, length, expectedLength);
    variables[key] = {
      scale: Number.isFinite(Number(variable.scale)) ? Number(variable.scale) : 1,
      offset: Number.isFinite(Number(variable.offset)) ? Number(variable.offset) : 0,
      missing: Number.isFinite(Number(variable.missing)) ? Number(variable.missing) : -32768,
      values,
    };
  }
  return {
    schemaVersion: Number(header.schemaVersion) || 1,
    rows: Number.isFinite(rows) ? rows : 0,
    cols: Number.isFinite(cols) ? cols : 0,
    variables,
  };
}

function normalizeHoverGridVariable(
  input: HoverGridVariable | undefined,
  rows: number,
  cols: number,
): HoverGridVariable | null {
  if (!input) {
    return null;
  }
  const scale = Number(input.scale);
  const offset = Number(input.offset);
  const missing = Number.isFinite(Number(input.missing)) ? Number(input.missing) : -32768;
  const data = typeof input.data === "string" ? input.data : "";
  const expectedLength = Number.isFinite(rows) && Number.isFinite(cols) && rows > 0 && cols > 0 ? rows * cols : 0;
  const values = decodeBase64Int16(data, expectedLength);
  return {
    scale: Number.isFinite(scale) ? scale : 1,
    offset: Number.isFinite(offset) ? offset : 0,
    missing,
    values,
  };
}

function decodeBase64Int16(data: string, expectedLength: number): Int16Array {
  if (!data) {
    return new Int16Array(Math.max(0, expectedLength));
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(data);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } catch {
    return new Int16Array(Math.max(0, expectedLength));
  }
  const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  if (!Number.isFinite(expectedLength) || expectedLength <= 0) {
    return view;
  }
  if (view.length === expectedLength) {
    return view;
  }
  const resized = new Int16Array(expectedLength);
  resized.set(view.subarray(0, Math.min(view.length, expectedLength)));
  return resized;
}

function decodeBinaryInt16(bytes: Uint8Array, byteOffset: number, length: number, expectedLength: number): Int16Array {
  const resolvedLength = Math.max(0, Number.isFinite(expectedLength) && expectedLength > 0 ? expectedLength : length);
  const values = new Int16Array(resolvedLength);
  const availableBytes = Math.max(0, Math.min(length * 2, bytes.byteLength - byteOffset));
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
