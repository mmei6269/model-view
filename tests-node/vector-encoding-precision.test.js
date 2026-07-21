"use strict";

// Precision-cap contract of the polyline wire format. Encode is capped at 6
// (appendSignedCode's 32-bit shifts corrupt |scaled| >= 2^30, which precision
// 7 reaches at |lon| > 107.37), but decode divides by the declared factor and
// keeps the wider historical cap of 8: a stored polyline7/polyline8 payload
// must decode with the factor its pointEncoding names, never a silently
// narrowed one (the next/ client decoder honors 8 the same way).

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decodeLatLonPolyline,
  decodeVectorLinePoints,
  encodeLatLonPolyline,
  encodeProjectedPolyline,
  encodeVectorLine,
} = require("../scripts/lib/vector-encoding");

// Reference signed-varint polyline encoder (the standard published
// algorithm); valid for |value * 10^precision| < 2^31, which every fixture
// here stays under even at precision 8.
function referenceEncode(points, precision) {
  const factor = 10 ** precision;
  let out = "";
  let previousLat = 0;
  let previousLon = 0;
  for (const [rawLat, rawLon] of points) {
    const lat = Math.round(rawLat * factor);
    const lon = Math.round(rawLon * factor);
    for (let delta of [lat - previousLat, lon - previousLon]) {
      let encoded = delta < 0 ? ~(delta << 1) : delta << 1;
      while (encoded >= 0x20) {
        out += String.fromCharCode((0x20 | (encoded & 0x1f)) + 63);
        encoded >>= 5;
      }
      out += String.fromCharCode(encoded + 63);
    }
    previousLat = lat;
    previousLon = lon;
  }
  return out;
}

function assertPointsClose(actual, expected, tolerance) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(
      Math.abs(actual[index][0] - expected[index][0]) <= tolerance &&
        Math.abs(actual[index][1] - expected[index][1]) <= tolerance,
      `point ${index}: ${actual[index]} !~ ${expected[index]}`,
    );
  }
}

test("stored polyline7/polyline8 payloads decode with their declared factor", () => {
  const points = [
    [1.5, -2.25],
    [1.6002, -2.3501],
    [1.4998, -2.4],
  ];
  for (const precision of [7, 8]) {
    const line = { pointEncoding: `polyline${precision}`, encodedPoints: referenceEncode(points, precision) };
    assertPointsClose(decodeVectorLinePoints(line), points, 10 ** -precision);
  }
});

test("decodeLatLonPolyline still clamps nonsense precisions instead of trusting them", () => {
  const points = [[5.1234567, -9.8765432]];
  // Precision 99 would compute a 10^99 factor; the decode cap holds it at 8.
  const decoded = decodeLatLonPolyline(referenceEncode(points, 8), 99);
  assertPointsClose(decoded, points, 1e-8);
});

test("encode caps the precision at 6 and labels pointEncoding with the applied factor", () => {
  const points = [
    [37.5, -95.25],
    [37.6, -95.35],
  ];
  const line = encodeVectorLine({ value: 1000 }, points, 7);
  assert.equal(line.pointEncoding, "polyline6", "the label matches the factor actually encoded");
  assertPointsClose(decodeVectorLinePoints(line), points, 1e-6);
});

test("array and projected encoders emit identical bytes (skip semantics included)", () => {
  const points = [
    [37.5, -95.25],
    [undefined, -95.3],
    [Number.NaN, Number.NaN],
    [37.6, -95.35],
  ];
  const projected = encodeProjectedPolyline(
    points,
    (point, out) => {
      out[0] = Number(point?.[0]);
      out[1] = Number(point?.[1]);
    },
    5,
  );
  assert.equal(encodeLatLonPolyline(points, 5), projected);
  assert.equal(encodeLatLonPolyline(points, 5), referenceEncode([points[0], points[3]], 5));
});
