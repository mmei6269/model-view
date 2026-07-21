"use strict";

const DEFAULT_POLYLINE_PRECISION = 5;

// appendSignedCode shifts with 32-bit bitwise ops, so |scaled| must stay
// below 2^30; precision 7 already corrupts |lon| > 107.37 on encode.
const MAX_ENCODE_PRECISION = 6;

// Decode divides by the factor and is not subject to the encoder's scaling
// overflow, so it honors the wider historical cap: a stored polyline7/8
// payload must keep decoding with the factor its pointEncoding declares
// (mirrors next/src/core/vector-encoding.ts).
const MAX_DECODE_PRECISION = 8;

// Array-of-[lat, lon] entry point: same wire format as the projected path,
// via an identity projector so there is exactly one encoder loop.
function encodeLatLonPolyline(points, precision = DEFAULT_POLYLINE_PRECISION) {
  return encodeProjectedPolyline(points, copyLatLonPoint, precision);
}

function copyLatLonPoint(point, out) {
  out[0] = Number(point?.[0]);
  out[1] = Number(point?.[1]);
}

// Direct vector encoding (backlog #22): encodes straight from source points
// through a projection callback that writes [lat, lon] into a reused scratch
// pair, so no per-point [lat, lon] arrays are materialized.
function encodeProjectedPolyline(points, projectPoint, precision = DEFAULT_POLYLINE_PRECISION) {
  if (!Array.isArray(points) || points.length === 0) {
    return "";
  }
  const factor = 10 ** clampPrecision(precision);
  let previousLat = 0;
  let previousLon = 0;
  const codes = [];
  const scratch = [0, 0];
  for (const point of points) {
    projectPoint(point, scratch);
    const lat = Math.round(scratch[0] * factor);
    const lon = Math.round(scratch[1] * factor);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    appendSignedCode(codes, lat - previousLat);
    appendSignedCode(codes, lon - previousLon);
    previousLat = lat;
    previousLon = lon;
  }
  return joinCharCodes(codes);
}

function decodeLatLonPolyline(encoded, precision = DEFAULT_POLYLINE_PRECISION) {
  const text = String(encoded || "");
  if (!text) {
    return [];
  }
  const factor = 10 ** clampPrecision(precision, MAX_DECODE_PRECISION);
  const points = [];
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

function encodeVectorLine(line, points, precision = DEFAULT_POLYLINE_PRECISION) {
  return {
    ...line,
    pointEncoding: `polyline${clampPrecision(precision)}`,
    encodedPoints: encodeLatLonPolyline(points, precision),
  };
}

function encodeVectorLineProjected(line, points, projectPoint, precision = DEFAULT_POLYLINE_PRECISION) {
  return {
    ...line,
    pointEncoding: `polyline${clampPrecision(precision)}`,
    encodedPoints: encodeProjectedPolyline(points, projectPoint, precision),
  };
}

function decodeVectorLinePoints(line) {
  if (!line || typeof line !== "object") {
    return [];
  }
  if (Array.isArray(line.points)) {
    return line.points;
  }
  const encoding = String(line.pointEncoding || "");
  const match = encoding.match(/^polyline(\d+)$/);
  if (!match || !line.encodedPoints) {
    return [];
  }
  return decodeLatLonPolyline(line.encodedPoints, Number(match[1]));
}

// Chunked string assembly (backlog #22): the standard polyline signed
// varint characters, accumulated as char codes in one array and materialized
// in slices — no per-point intermediate strings or rope nodes.
function appendSignedCode(codes, value) {
  const rounded = Math.round(value);
  let encoded = rounded << 1;
  if (rounded < 0) {
    encoded = ~encoded;
  }
  while (encoded >= 0x20) {
    codes.push((0x20 | (encoded & 0x1f)) + 63);
    encoded >>= 5;
  }
  codes.push(encoded + 63);
}

function joinCharCodes(codes) {
  let out = "";
  for (let index = 0; index < codes.length; index += 8192) {
    out += String.fromCharCode.apply(null, codes.slice(index, index + 8192));
  }
  return out;
}

function decodeSigned(text, startIndex) {
  let result = 0;
  let shift = 0;
  let index = startIndex;
  let byte;
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

function clampPrecision(value, maxPrecision = MAX_ENCODE_PRECISION) {
  const precision = Math.round(Number(value));
  return Number.isFinite(precision) ? Math.max(0, Math.min(maxPrecision, precision)) : DEFAULT_POLYLINE_PRECISION;
}

module.exports = {
  DEFAULT_POLYLINE_PRECISION,
  decodeLatLonPolyline,
  decodeVectorLinePoints,
  encodeLatLonPolyline,
  encodeProjectedPolyline,
  encodeVectorLine,
  encodeVectorLineProjected,
};
