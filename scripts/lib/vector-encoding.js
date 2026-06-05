"use strict";

const DEFAULT_POLYLINE_PRECISION = 5;

function encodeLatLonPolyline(points, precision = DEFAULT_POLYLINE_PRECISION) {
  if (!Array.isArray(points) || points.length === 0) {
    return "";
  }
  const factor = 10 ** clampPrecision(precision);
  let previousLat = 0;
  let previousLon = 0;
  let out = "";
  for (const point of points) {
    const lat = Math.round(Number(point?.[0]) * factor);
    const lon = Math.round(Number(point?.[1]) * factor);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    out += encodeSigned(lat - previousLat);
    out += encodeSigned(lon - previousLon);
    previousLat = lat;
    previousLon = lon;
  }
  return out;
}

function decodeLatLonPolyline(encoded, precision = DEFAULT_POLYLINE_PRECISION) {
  const text = String(encoded || "");
  if (!text) {
    return [];
  }
  const factor = 10 ** clampPrecision(precision);
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

function encodeSigned(value) {
  const rounded = Math.round(value);
  let encoded = rounded << 1;
  if (rounded < 0) {
    encoded = ~encoded;
  }
  let out = "";
  while (encoded >= 0x20) {
    out += String.fromCharCode((0x20 | (encoded & 0x1f)) + 63);
    encoded >>= 5;
  }
  out += String.fromCharCode(encoded + 63);
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

function clampPrecision(value) {
  const precision = Math.round(Number(value));
  return Number.isFinite(precision) ? Math.max(0, Math.min(8, precision)) : DEFAULT_POLYLINE_PRECISION;
}

module.exports = {
  DEFAULT_POLYLINE_PRECISION,
  decodeLatLonPolyline,
  decodeVectorLinePoints,
  encodeLatLonPolyline,
  encodeVectorLine,
};
