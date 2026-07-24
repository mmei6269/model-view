"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  _testBuildFiniteDifferenceSpacingRows: buildFiniteDifferenceSpacingRows,
  _testBuildFrontogenesisGrid: buildFrontogenesisGrid,
  _testMaskPressureLevelGridBelowTerrain: maskPressureLevelGridBelowTerrain,
} = require("../scripts/lib/noaa-beta-renderer");

const RD_OVER_CP = 0.2854;
const FRONTOGENESIS_SCALE = 100000 * 10800;

function buildHypotReference(decoded, level, bounds, width, height, spacingRows = null) {
  const temp = maskPressureLevelGridBelowTerrain(decoded?.[`temp${level}`], decoded, level, width, height);
  const u = maskPressureLevelGridBelowTerrain(decoded?.[`wind${level}U`], decoded, level, width, height);
  const v = maskPressureLevelGridBelowTerrain(decoded?.[`wind${level}V`], decoded, level, width, height);
  if (!temp || !u || !v || width < 3 || height < 3) return null;
  const cols = Math.round(Number(width));
  const rows = Math.round(Number(height));
  const cellCount = cols * rows;
  const theta = new Float32Array(cellCount);
  const thetaMultiplier = Math.pow(1000 / level, RD_OVER_CP);
  for (let index = 0; index < cellCount; index += 1) {
    const tempK = Number(temp[index]);
    theta[index] = Number.isFinite(tempK) ? tempK * thetaMultiplier : Number.NaN;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  const spacing = spacingRows || buildFiniteDifferenceSpacingRows(bounds, cols, rows);
  if (!spacing) return out;
  for (let y = 1; y < rows - 1; y += 1) {
    const dx2 = spacing.dx2[y];
    const dy2 = spacing.dy2[y];
    if (!Number.isFinite(dx2) || !Number.isFinite(dy2)) continue;
    for (let x = 1; x < cols - 1; x += 1) {
      const index = y * cols + x;
      if (!Number.isFinite(theta[index]) || !Number.isFinite(u[index]) || !Number.isFinite(v[index])) continue;
      const dThetaDx = centralDiffX(theta, x, y, cols, dx2);
      const dThetaDy = centralDiffY(theta, x, y, cols, dy2);
      const dUdx = centralDiffX(u, x, y, cols, dx2);
      const dUdy = centralDiffY(u, x, y, cols, dy2);
      const dVdx = centralDiffX(v, x, y, cols, dx2);
      const dVdy = centralDiffY(v, x, y, cols, dy2);
      const gradientMagnitude = Math.hypot(dThetaDx, dThetaDy);
      if (
        !Number.isFinite(gradientMagnitude) ||
        gradientMagnitude < 1e-12 ||
        !Number.isFinite(dUdx) ||
        !Number.isFinite(dUdy) ||
        !Number.isFinite(dVdx) ||
        !Number.isFinite(dVdy)
      ) {
        continue;
      }
      const divergence = dUdx + dVdy;
      const stretching = dUdx - dVdy;
      const shearing = dVdx + dUdy;
      const deformationTerm =
        (dThetaDx * dThetaDx - dThetaDy * dThetaDy) * stretching + 2 * dThetaDx * dThetaDy * shearing;
      const divergenceTerm = gradientMagnitude * gradientMagnitude * divergence;
      out[index] = (-0.5 * (deformationTerm + divergenceTerm) * FRONTOGENESIS_SCALE) / gradientMagnitude;
    }
  }
  return out;
}

function centralDiffX(grid, x, y, width, dx2) {
  const left = Number(grid[y * width + (x - 1)]);
  const right = Number(grid[y * width + (x + 1)]);
  return Number.isFinite(left) && Number.isFinite(right) ? (right - left) / dx2 : Number.NaN;
}

function centralDiffY(grid, x, y, width, dy2) {
  const north = Number(grid[(y - 1) * width + x]);
  const south = Number(grid[(y + 1) * width + x]);
  return Number.isFinite(north) && Number.isFinite(south) ? (north - south) / dy2 : Number.NaN;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("direct frontogenesis norm preserves full-kernel validity and meteorological values", () => {
  const random = mulberry32(0x14f00d);
  const width = 11;
  const height = 9;
  const bounds = { north: 52, south: 24, west: -126, east: -67 };
  const spacing = buildFiniteDifferenceSpacingRows(bounds, width, height);
  let compared = 0;
  let changedFloat32 = 0;
  let maxAbsDelta = 0;
  for (let fixture = 0; fixture < 300; fixture += 1) {
    const decoded = {};
    for (const level of [850, 700]) {
      const temp = new Float32Array(width * height);
      const u = new Float32Array(width * height);
      const v = new Float32Array(width * height);
      for (let index = 0; index < temp.length; index += 1) {
        temp[index] = 245 + random() * 70;
        u[index] = (random() - 0.5) * 120;
        v[index] = (random() - 0.5) * 120;
        if (random() < 0.025) temp[index] = Number.NaN;
        if (random() < 0.025) u[index] = Number.NaN;
        if (random() < 0.025) v[index] = Number.NaN;
      }
      decoded[`temp${level}`] = temp;
      decoded[`wind${level}U`] = u;
      decoded[`wind${level}V`] = v;
    }
    for (const level of [850, 700]) {
      const actual = buildFrontogenesisGrid(decoded, level, bounds, width, height, spacing);
      const reference = buildHypotReference(decoded, level, bounds, width, height, spacing);
      for (let index = 0; index < actual.length; index += 1) {
        assert.equal(
          Number.isNaN(actual[index]),
          Number.isNaN(reference[index]),
          `validity ${fixture}:${level}:${index}`,
        );
        if (!Number.isFinite(actual[index])) continue;
        compared += 1;
        if (!Object.is(actual[index], reference[index])) changedFloat32 += 1;
        maxAbsDelta = Math.max(maxAbsDelta, Math.abs(actual[index] - reference[index]));
      }
    }
  }
  assert.ok(compared > 10_000);
  assert.equal(changedFloat32, 0, "broad meteorological full-kernel fixtures should remain bit-identical");
  assert.ok(maxAbsDelta <= 1e-6, `max full-kernel delta ${maxAbsDelta}`);
});

test("near-zero cancellation deltas stay far below a meaningful frontogenesis signal", () => {
  const random = mulberry32(0x51f14e);
  let changedFloat32 = 0;
  let signFlips = 0;
  let maxAbsDelta = 0;
  for (let sample = 0; sample < 500_000; sample += 1) {
    const angle = random() * Math.PI * 2;
    const magnitude = 10 ** (-7 + random() * 3);
    const dThetaDx = Math.cos(angle) * magnitude;
    const dThetaDy = Math.sin(angle) * magnitude;
    const stretching = (random() - 0.5) * 2e-4;
    const shearing = (random() - 0.5) * 2e-4;
    const deformation = (dThetaDx * dThetaDx - dThetaDy * dThetaDy) * stretching + 2 * dThetaDx * dThetaDy * shearing;
    const hypotMagnitude = Math.hypot(dThetaDx, dThetaDy);
    const directMagnitude = Math.sqrt(dThetaDx * dThetaDx + dThetaDy * dThetaDy);
    const cancellationJitter = (random() - 0.5) * 2e-11;
    const divergence = (-deformation / (hypotMagnitude * hypotMagnitude)) * (1 + cancellationJitter);
    const reference = Math.fround(
      (-0.5 * (deformation + hypotMagnitude * hypotMagnitude * divergence) * FRONTOGENESIS_SCALE) / hypotMagnitude,
    );
    const actual = Math.fround(
      (-0.5 * (deformation + directMagnitude * directMagnitude * divergence) * FRONTOGENESIS_SCALE) / directMagnitude,
    );
    if (Object.is(actual, reference)) continue;
    changedFloat32 += 1;
    maxAbsDelta = Math.max(maxAbsDelta, Math.abs(actual - reference));
    if (Math.sign(actual) !== Math.sign(reference)) signFlips += 1;
  }
  assert.ok(changedFloat32 > 100_000, "stress oracle did not exercise rounding differences");
  assert.ok(signFlips < 20, `unexpected near-zero sign flips: ${signFlips}`);
  assert.ok(maxAbsDelta < 1e-12, `near-zero delta ${maxAbsDelta} exceeds the tolerance`);
});
