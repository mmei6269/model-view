import type { ContourVectorLine, SynopticVectorLine } from "../types";

type VectorLine = ContourVectorLine | SynopticVectorLine;

const DEFAULT_POLYLINE_PRECISION = 5;

export function decodeVectorLinePoints(line: VectorLine | null | undefined): [number, number][] {
  if (!line) {
    return [];
  }
  if (Array.isArray(line.points)) {
    return line.points.filter(isFinitePoint);
  }
  const encoding = String(line.pointEncoding || "");
  const match = encoding.match(/^polyline(\d+)$/);
  if (!match || !line.encodedPoints) {
    return [];
  }
  return decodeLatLonPolyline(line.encodedPoints, Number(match[1])).filter(isFinitePoint);
}

export function withDecodedVectorLinePoints<T extends VectorLine>(line: T): T {
  if (Array.isArray(line.points)) {
    return line;
  }
  const points = decodeVectorLinePoints(line);
  return points.length > 0 ? { ...line, points } : line;
}

function decodeLatLonPolyline(encoded: string, precision = DEFAULT_POLYLINE_PRECISION): [number, number][] {
  const text = String(encoded || "");
  if (!text) {
    return [];
  }
  const factor = 10 ** clampPrecision(precision);
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < text.length) {
    const latDelta = decodeSigned(text, index);
    if (!latDelta) {
      break;
    }
    index = latDelta.nextIndex;
    const lonDelta = decodeSigned(text, index);
    if (!lonDelta) {
      break;
    }
    index = lonDelta.nextIndex;
    lat += latDelta.value;
    lon += lonDelta.value;
    points.push([lat / factor, lon / factor]);
  }
  return points;
}

function decodeSigned(text: string, startIndex: number): { value: number; nextIndex: number } | null {
  let result = 0;
  let shift = 0;
  let index = startIndex;
  let byte: number;
  do {
    if (index >= text.length) {
      return null;
    }
    byte = text.charCodeAt(index) - 63;
    index += 1;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20);
  return {
    value: result & 1 ? ~(result >> 1) : result >> 1,
    nextIndex: index,
  };
}

function clampPrecision(value: number): number {
  const precision = Math.round(Number(value));
  return Number.isFinite(precision) ? Math.max(0, Math.min(8, precision)) : DEFAULT_POLYLINE_PRECISION;
}

function isFinitePoint(point: [number, number]): boolean {
  return Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}
