"use strict";

// Backlog #22 (2026-07-18): synoptic/contour allocation churn — three
// allocation-only fast paths, each required to be byte-identical to the
// generic path it replaced:
//
// 1. In-place contour-chain merging (segmentsToPolylines/mergeChains): merges
//    extend one parent array in place instead of spreading both chains into a
//    fresh array per merge. An endpoint-indexed chaining variant was
//    benchmarked and REVERTED: at the ~50 short-lived chains of a CONUS frame
//    the legacy O(segments x chains) scan of cheap pointsNear calls beats the
//    Map probing/registration churn of an index (detailed pass 11.0 -> 14.1
//    ms with the index). Chain contents and chain order are unchanged.
// 2. Direct vector encoding + chunked string assembly
//    (encodeVectorLineProjected / encodeLatLonPolyline): the polyline bytes
//    are accumulated as char codes in one array and materialized in slices
//    straight from grid {x, y} points via a scratch-pair projector, skipping
//    the per-contour [lat, lon] arrays and per-point intermediate strings.
// 3. Direct rasterization (drawPolyline): the Bresenham walk and the stamp
//    loop are fused, skipping rasterizeSegment's per-segment pixel arrays.
//
// These tests pin fast-vs-generic equivalence on adversarial edge cases; the
// generic implementations are embedded here as oracles (verbatim copies of
// the pre-change code).

const assert = require("node:assert/strict");
const test = require("node:test");

const { _testContours } = require("../scripts/lib/synoptic-render.js");
const { encodeVectorLine, encodeVectorLineProjected } = require("../scripts/lib/vector-encoding.js");

const { drawPolyline, postProcessContours, projectGridLatLon, segmentsToPolylines, toLatLon } = _testContours;

// ── Legacy oracles (verbatim from the pre-change module) ────────────────────

function pointsNear(a, b, tolerance = 1e-4) {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

function dedupeConsecutivePoints(points) {
  const out = [];
  for (const point of points) {
    if (!out.length || !pointsNear(out[out.length - 1], point)) {
      out.push(point);
    }
  }
  return out;
}

function mergeChainsLegacy(first, second, firstAtHead, secondAtHead) {
  const a = [...first];
  const b = [...second];
  if (firstAtHead && secondAtHead) {
    return [...b.reverse(), ...a];
  }
  if (firstAtHead && !secondAtHead) {
    return [...b, ...a];
  }
  if (!firstAtHead && secondAtHead) {
    return [...a, ...b];
  }
  return [...a, ...b.reverse()];
}

function segmentsToPolylinesLegacy(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }
  const chains = [];
  for (const segment of segments) {
    const start = { x: segment.x0, y: segment.y0 };
    const end = { x: segment.x1, y: segment.y1 };
    if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y)) {
      continue;
    }
    let startChainIndex = -1;
    let startAtHead = false;
    let endChainIndex = -1;
    let endAtHead = false;
    for (let index = 0; index < chains.length; index += 1) {
      const chain = chains[index];
      if (pointsNear(chain[0], start)) {
        startChainIndex = index;
        startAtHead = true;
      } else if (pointsNear(chain[chain.length - 1], start)) {
        startChainIndex = index;
        startAtHead = false;
      }
      if (pointsNear(chain[0], end)) {
        endChainIndex = index;
        endAtHead = true;
      } else if (pointsNear(chain[chain.length - 1], end)) {
        endChainIndex = index;
        endAtHead = false;
      }
    }
    if (startChainIndex === -1 && endChainIndex === -1) {
      chains.push([start, end]);
      continue;
    }
    if (startChainIndex !== -1 && endChainIndex === -1) {
      const chain = chains[startChainIndex];
      if (startAtHead) {
        chain.unshift(end);
      } else {
        chain.push(end);
      }
      continue;
    }
    if (startChainIndex === -1 && endChainIndex !== -1) {
      const chain = chains[endChainIndex];
      if (endAtHead) {
        chain.unshift(start);
      } else {
        chain.push(start);
      }
      continue;
    }
    if (startChainIndex === endChainIndex) {
      const chain = chains[startChainIndex];
      if (startAtHead && !endAtHead) {
        chain.unshift(end);
      } else if (!startAtHead && endAtHead) {
        chain.push(end);
      }
      continue;
    }
    const first = chains[startChainIndex];
    const second = chains[endChainIndex];
    const merged = mergeChainsLegacy(first, second, startAtHead, endAtHead);
    const keep = Math.min(startChainIndex, endChainIndex);
    const drop = Math.max(startChainIndex, endChainIndex);
    chains[keep] = merged;
    chains.splice(drop, 1);
  }
  return chains.map((chain) => dedupeConsecutivePoints(chain)).filter((chain) => chain.length >= 2);
}

function rasterizeSegmentLegacy(x0, y0, x1, y1, dashPattern) {
  const out = [];
  let cx = x0;
  let cy = y0;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let dashIndex = 0;
  let dashRemaining = dashPattern && dashPattern.length > 0 ? dashPattern[0] : Number.POSITIVE_INFINITY;
  let draw = true;
  while (true) {
    if (draw) {
      out.push({ x: cx, y: cy });
    }
    dashRemaining -= 1;
    if (dashPattern && dashRemaining <= 0) {
      dashIndex = (dashIndex + 1) % dashPattern.length;
      dashRemaining = dashPattern[dashIndex];
      draw = !draw;
    }
    if (cx === x1 && cy === y1) {
      break;
    }
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      cx += sx;
    }
    if (e2 <= dx) {
      err += dx;
      cy += sy;
    }
  }
  return out;
}

function scaleXLegacy(x, cols, width) {
  return Math.round((x / Math.max(1, cols - 1)) * (width - 1));
}

function scaleYLegacy(y, rows, height) {
  return Math.round((y / Math.max(1, rows - 1)) * (height - 1));
}

function drawPolylineLegacy(buffer, width, height, contour, cols, rows, { rgba, widthPx = 1, dash = [] }) {
  const lineWidth = Math.max(1, Math.round(widthPx));
  const radius = Math.max(0, Math.floor((lineWidth - 1) / 2));
  let painted = 0;
  const dashPattern =
    Array.isArray(dash) && dash.length > 0
      ? dash.map((value) => Math.max(1, Number(value))).filter(Number.isFinite)
      : null;
  for (let i = 1; i < contour.length; i += 1) {
    const a = contour[i - 1];
    const b = contour[i];
    const x0 = scaleXLegacy(a.x, cols, width);
    const y0 = scaleYLegacy(a.y, rows, height);
    const x1 = scaleXLegacy(b.x, cols, width);
    const y1 = scaleYLegacy(b.y, rows, height);
    const pixels = rasterizeSegmentLegacy(x0, y0, x1, y1, dashPattern);
    for (const pixel of pixels) {
      for (let oy = -radius; oy <= radius; oy += 1) {
        for (let ox = -radius; ox <= radius; ox += 1) {
          const px = pixel.x + ox;
          const py = pixel.y + oy;
          if (px < 0 || py < 0 || px >= width || py >= height) {
            continue;
          }
          const idx = (py * width + px) * 4;
          buffer[idx] = rgba[0];
          buffer[idx + 1] = rgba[1];
          buffer[idx + 2] = rgba[2];
          buffer[idx + 3] = rgba[3];
          painted += 1;
        }
      }
    }
  }
  return painted;
}

// ── Endpoint-indexed chaining vs legacy scan ────────────────────────────────

function segment(x0, y0, x1, y1) {
  return { x0, y0, x1, y1 };
}

test("chaining: degenerate inputs match the legacy scan", () => {
  for (const segments of [
    [],
    null,
    [segment(0, 0, 1, 1)],
    // NaN endpoints are skipped by both paths.
    [segment(0, 0, Number.NaN, 1), segment(0, 0, 1, 0), segment(1, 0, 1, 1)],
    // Closed ring: the ring-close branch must keep the legacy rotation.
    [segment(0, 0, 1, 0), segment(1, 0, 1, 1), segment(1, 1, 0, 0)],
    // Ring closed by a segment whose endpoints both match the same chain
    // (regression: the close extends with the segment END at a fixed side).
    [segment(1, 1.5, 1, 2), segment(0.5, 1.5, 1, 2), segment(0.5, 1.5, 1, 1.5)],
    [segment(1, 1.5, 1, 2), segment(0.5, 1.5, 1, 2), segment(1, 1.5, 0.5, 1.5)],
  ]) {
    assert.deepEqual(segmentsToPolylines(segments), segmentsToPolylinesLegacy(segments));
  }
});

test("chaining: tolerance-edge endpoints match the legacy scan", () => {
  const base = segment(0, 0, 1, 0);
  for (const offset of [0, 9e-5, 1e-4, 1.1e-4, -9e-5, -1e-4, -1.1e-4]) {
    // Endpoint offset from the chain head (1, 0) right at the 1e-4 Chebyshev
    // tolerance boundary, in both axes independently.
    const segments = [base, segment(1 + offset, 0, 2, 0), segment(1, offset, 1, 1)];
    assert.deepEqual(segmentsToPolylines(segments), segmentsToPolylinesLegacy(segments), `offset ${offset}`);
  }
});

test("chaining: merge order and self-touching chains match the legacy scan", () => {
  // Two closed squares sharing one corner point (5, 5): whichever chain
  // "wins" the shared endpoint decides the merge; plus an open spur.
  const squareA = [segment(5, 5, 8, 5), segment(8, 5, 8, 8), segment(8, 8, 5, 8), segment(5, 8, 5, 5)];
  const squareB = [segment(5, 5, 2, 5), segment(2, 5, 2, 2), segment(2, 2, 5, 2), segment(5, 2, 5, 5)];
  const spur = [segment(8, 8, 10, 10), segment(10, 10, 12, 10)];
  for (const segments of [
    [...squareA, ...squareB, ...spur],
    [...squareB, ...squareA, ...spur],
    [...spur, ...squareA, ...squareB],
    // Interleaved arrival order.
    [squareA[0], squareB[0], squareA[1], squareB[1], squareA[2], squareB[2], squareA[3], squareB[3], ...spur],
  ]) {
    assert.deepEqual(segmentsToPolylines(segments), segmentsToPolylinesLegacy(segments));
  }
});

test("chaining: seeded fuzz matches the legacy scan (exact + tolerance-jittered)", () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (const mode of ["exact", "jitter"]) {
    for (let trial = 0; trial < 300; trial += 1) {
      const count = 1 + (trial % 48);
      const segments = [];
      for (let i = 0; i < count; i += 1) {
        const x = Math.round(rand() * 40) / 2;
        const y = Math.round(rand() * 40) / 2;
        let x1 = x + (rand() < 0.5 ? 0.5 : 0);
        let y1 = y + (rand() < 0.5 ? 0.5 : 0);
        if (x === x1 && y === y1) {
          x1 += 0.5;
        }
        const jitter = () => (mode === "jitter" ? (rand() - 0.5) * 2e-4 : 0);
        segments.push(segment(x + jitter(), y + jitter(), x1 + jitter(), y1 + jitter()));
      }
      assert.deepEqual(
        segmentsToPolylines(segments),
        segmentsToPolylinesLegacy(segments),
        `mode=${mode} trial=${trial}`,
      );
    }
  }
});

test("chaining: full postProcessContours stays identical on a planted-ring field", () => {
  // Marching-squares output around a single closed contour with a saddle
  // nearby: the chain/roster path must produce identical polylines.
  const segments = [
    segment(2, 1, 3, 1.5),
    segment(3, 1.5, 4, 1),
    segment(4, 1, 4.5, 2),
    segment(4.5, 2, 4, 3),
    segment(4, 3, 3, 3.5),
    segment(3, 3.5, 2, 3),
    segment(2, 3, 1.5, 2),
    segment(1.5, 2, 2, 1),
    segment(6, 6, 7, 6.5),
    segment(7, 6.5, 8, 6),
  ];
  const options = { simplifyTolerance: 0.3, minLengthCells: 2, minClosedAreaCells: 2, smoothPasses: 2 };
  assert.deepEqual(postProcessContours(segments, options), postProcessContours(segments, options));
  assert.deepEqual(segmentsToPolylines(segments), segmentsToPolylinesLegacy(segments));
});

// ── Direct vector encoding vs [lat, lon] materialization ───────────────────

test("projected encoding: bytes identical to encodeVectorLine over materialized pairs", () => {
  const pairs = [
    [45.123456789, -100.987654321],
    [45.5, -100.5],
    [Number.NaN, -100.25], // non-finite points are skipped...
    [45.25, Number.POSITIVE_INFINITY],
    [46, -99],
    [46.000001, -99.000001],
  ];
  const projector = (point, out) => {
    out[0] = point.lat;
    out[1] = point.lon;
  };
  const points = pairs.map(([lat, lon]) => ({ lat, lon }));
  for (const precision of [0, 3, 5, 6, 7, -2, Number.NaN]) {
    const meta = { kind: "mslp-major", value: 1012 };
    assert.deepEqual(
      encodeVectorLineProjected(meta, points, projector, precision),
      encodeVectorLine(meta, pairs, precision),
      `precision ${precision}`,
    );
  }
});

test("projected encoding: skip leaves delta state untouched, matching the generic path", () => {
  // A non-finite point between two finite ones: the following delta must be
  // taken against the last FINITE point (both paths share this rule).
  const pairs = [
    [40, -110],
    [Number.NaN, Number.NaN],
    [40.5, -110.5],
  ];
  const points = pairs.map(([lat, lon]) => ({ lat, lon }));
  const projector = (point, out) => {
    out[0] = point.lat;
    out[1] = point.lon;
  };
  assert.deepEqual(encodeVectorLineProjected({}, points, projector), encodeVectorLine({}, pairs));
});

test("projected encoding: empty and single-point contours match", () => {
  const projector = (point, out) => {
    out[0] = point.lat;
    out[1] = point.lon;
  };
  assert.deepEqual(encodeVectorLineProjected({}, [], projector), encodeVectorLine({}, []));
  assert.deepEqual(
    encodeVectorLineProjected({}, [{ lat: 41, lon: -105 }], projector),
    encodeVectorLine({}, [[41, -105]]),
  );
});

test("projectGridLatLon writes the same doubles toLatLon returns", () => {
  const bounds = { north: 53, south: 21, west: -129, east: -63 };
  for (const [cols, rows] of [
    [360, 224],
    [28, 16],
    [1600, 980],
  ]) {
    const project = projectGridLatLon(cols, rows, bounds);
    const scratch = [0, 0];
    for (const [x, y] of [
      [0, 0],
      [cols - 1, rows - 1],
      [(cols - 1) / 2, (rows - 1) / 2],
      [3.375, 17.8125],
      [cols, rows], // out-of-range is still projected, like toLatLon
    ]) {
      project({ x, y }, scratch);
      assert.deepEqual(scratch, toLatLon(x, y, cols, rows, bounds), `cols=${cols} x=${x} y=${y}`);
    }
  }
});

// ── Direct rasterization vs per-segment pixel arrays ───────────────────────

test("rasterization: fused drawPolyline matches the array-based oracle", () => {
  const width = 24;
  const height = 16;
  const cols = 12;
  const rows = 8;
  const contours = [
    // Horizontal, vertical, and diagonal runs, incl. a zero-length segment.
    [
      { x: 0, y: 0 },
      { x: 11, y: 0 },
      { x: 11, y: 7 },
      { x: 0, y: 7 },
      { x: 0, y: 0 },
    ],
    [
      { x: 2, y: 2 },
      { x: 9, y: 5 },
    ],
    [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 8, y: 1 },
    ],
    // Runs off every buffer edge (stamp clipping).
    [
      { x: -4, y: -4 },
      { x: 20, y: 12 },
    ],
  ];
  const styles = [
    { rgba: [200, 100, 50, 255], widthPx: 1, dash: [] },
    { rgba: [255, 255, 255, 180], widthPx: 3, dash: [] },
    { rgba: [10, 20, 30, 220], widthPx: 2, dash: [3, 2] },
    { rgba: [1, 2, 3, 4], widthPx: 1.4, dash: [2, 2, 5, 2] },
    // Non-finite dash entries normalize away in both paths.
    { rgba: [9, 9, 9, 9], widthPx: 1, dash: [Number.NaN, 2] },
  ];
  for (const contour of contours) {
    for (const style of styles) {
      const actual = new Uint8Array(width * height * 4);
      const expected = new Uint8Array(width * height * 4);
      const paintedActual = drawPolyline(actual, width, height, contour, cols, rows, style);
      const paintedExpected = drawPolylineLegacy(expected, width, height, contour, cols, rows, style);
      assert.equal(paintedActual, paintedExpected);
      assert.deepEqual(actual, expected, JSON.stringify(style));
    }
  }
});
