const { test, expect } = require("@playwright/test");
const { renderSynopticArtifacts } = require("../scripts/lib/synoptic-render");
const { decodeVectorLinePoints } = require("../scripts/lib/vector-encoding");

function buildSyntheticLowPressure(rows, cols, centerX, centerY) {
  const values = new Float32Array(rows * cols);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      values[y * cols + x] = 980 + distance * 0.9;
    }
  }
  return values;
}

function isClosed(points) {
  if (!Array.isArray(points) || points.length < 4) {
    return false;
  }
  const first = points[0];
  const last = points[points.length - 1];
  return Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6;
}

function hasCurve(points) {
  if (!Array.isArray(points) || points.length < 6) {
    return false;
  }
  for (let i = 2; i < points.length; i += 1) {
    const a = points[i - 2];
    const b = points[i - 1];
    const c = points[i];
    const abx = b[1] - a[1];
    const aby = b[0] - a[0];
    const bcx = c[1] - b[1];
    const bcy = c[0] - b[0];
    const cross = Math.abs(abx * bcy - aby * bcx);
    if (cross > 1e-5) {
      return true;
    }
  }
  return false;
}

test("synthetic low keeps dense 4hPa closed contours and curved isobars", async () => {
  const rows = 96;
  const cols = 96;
  const values = buildSyntheticLowPressure(rows, cols, 48, 48);

  const output = renderSynopticArtifacts({
    pressureGrid: {
      rows,
      cols,
      values,
    },
    thicknessGrid: null,
    targetBounds: { north: 53, south: 21, west: -129, east: -63 },
    width: 1600,
    height: 980,
    modelKey: "gfs",
  });

  const mslpLines = (output?.vector?.isobars?.lines || []).filter((line) => String(line.kind || "").startsWith("mslp"));
  expect(mslpLines.length).toBeGreaterThan(0);

  const closedInner = mslpLines.filter(
    (line) => Number.isFinite(line.value) && line.value <= 1000 && isClosed(decodeVectorLinePoints(line)),
  );
  expect(closedInner.length).toBeGreaterThanOrEqual(2);

  const intervalViolations = mslpLines
    .map((line) => Number(line.value))
    .filter(Number.isFinite)
    .filter((value) => Math.abs(value / 4 - Math.round(value / 4)) > 1e-6);
  expect(intervalViolations.length).toBe(0);

  const curved = closedInner.some((line) => hasCurve(decodeVectorLinePoints(line)));
  expect(curved).toBeTruthy();
});

test("simple synoptic detail mode is less crowded than detailed mode", async () => {
  const rows = 120;
  const cols = 120;
  const values = buildSyntheticLowPressure(rows, cols, 64, 52);

  const pressureGrid = {
    rows,
    cols,
    values,
  };
  const detailed = renderSynopticArtifacts({
    pressureGrid,
    thicknessGrid: null,
    targetBounds: { north: 53, south: 21, west: -129, east: -63 },
    width: 1600,
    height: 980,
    modelKey: "gfs",
    detailMode: "detailed",
  });
  const simple = renderSynopticArtifacts({
    pressureGrid,
    thicknessGrid: null,
    targetBounds: { north: 53, south: 21, west: -129, east: -63 },
    width: 1600,
    height: 980,
    modelKey: "gfs",
    detailMode: "simple",
  });

  const detailedLines = (detailed?.vector?.isobars?.lines || []).length;
  const simpleLines = (simple?.vector?.isobars?.lines || []).length;
  const detailedLabels = (detailed?.vector?.isobars?.labels || []).length;
  const simpleLabels = (simple?.vector?.isobars?.labels || []).length;

  expect(detailedLines).toBeGreaterThan(0);
  expect(simpleLines).toBeGreaterThan(0);
  expect(detailedLines).toBeGreaterThan(simpleLines);
  expect(detailedLabels).toBeGreaterThanOrEqual(simpleLabels);
});
