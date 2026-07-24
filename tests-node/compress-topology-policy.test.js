"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _testResolveCompressThreadsForBuild: resolveCompressThreadsForBuild,
} = require("../scripts/build-noaa-beta-artifacts");
const { _testShouldUseCompressionPool: shouldUseCompressionPool } = require("../scripts/lib/noaa-beta-renderer");

const DEFAULTS = Object.freeze({
  cpuCount: 18,
  freeGb: 64,
  totalFrameConcurrency: 18,
  workerCount: 18,
  explicitFrameThrottle: false,
  inputExplicit: false,
});

test("compression auto uses two helpers only below the measured half-core crossover", () => {
  for (const plannedFrameCount of [1, 4, 8]) {
    assert.equal(resolve({ plannedFrameCount }), 2, `${plannedFrameCount} active frames`);
  }
  for (const plannedFrameCount of [9, 12, 16, 40]) {
    assert.equal(resolve({ plannedFrameCount }), 0, `${plannedFrameCount} active frames`);
  }
});

test("compression auto budgets active workers rather than the queued roster", () => {
  assert.equal(resolve({ plannedFrameCount: 40, workerCount: 8, totalFrameConcurrency: 8 }), 2);
  assert.equal(resolve({ plannedFrameCount: 40, workerCount: 12, totalFrameConcurrency: 12 }), 0);
});

test("compression auto respects explicit outer throttles unless compression is also explicit", () => {
  assert.equal(resolve({ plannedFrameCount: 4, explicitFrameThrottle: true }), 0);
  assert.equal(resolve({ plannedFrameCount: 4, explicitFrameThrottle: true, input: "auto", inputExplicit: true }), 2);
});

test("explicit compression thread counts preserve the 0-4 override contract", () => {
  for (const expected of [0, 1, 2, 3, 4]) {
    assert.equal(
      resolve({
        plannedFrameCount: 18,
        freeGb: 1,
        explicitFrameThrottle: true,
        input: String(expected),
        inputExplicit: true,
      }),
      expected,
    );
  }
  assert.equal(resolve({ plannedFrameCount: 1, input: "off", inputExplicit: true }), 0);
  assert.equal(resolve({ plannedFrameCount: 1, input: "99", inputExplicit: true }), 4);
});

test("compression auto fails closed under measured helper-memory pressure", () => {
  assert.equal(resolve({ plannedFrameCount: 8, freeGb: 19.9 }), 0);
  assert.equal(resolve({ plannedFrameCount: 8, freeGb: 20 }), 2);
  assert.equal(resolve({ plannedFrameCount: 4, freeGb: 13.9 }), 0);
  assert.equal(resolve({ plannedFrameCount: 4, freeGb: 14 }), 2);
  assert.equal(resolve({ plannedFrameCount: 4, freeGb: Number.NaN }), 2, "unknown telemetry keeps measured win");
});

test("blank compression configuration keeps auto and garbage warns then stays inline", () => {
  assert.equal(resolve({ plannedFrameCount: 4, input: "" }), 2);
  assert.equal(resolve({ plannedFrameCount: 4, input: undefined }), 2);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.equal(resolve({ plannedFrameCount: 4, input: "surprise", inputExplicit: true }), 0);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /compression helpers stay off/);
});

test("only base-producing render modes can create a compression pool", () => {
  assert.equal(shouldUseCompressionPool("all", 2), true);
  assert.equal(shouldUseCompressionPool("base", 2), true);
  for (const renderMode of ["snow", "snow-delta", "snow-prefix", "runmax-prefix"]) {
    assert.equal(shouldUseCompressionPool(renderMode, 2), false, renderMode);
  }
  assert.equal(shouldUseCompressionPool("all", 0), false);
});

function resolve(overrides) {
  return resolveCompressThreadsForBuild({ ...DEFAULTS, ...overrides });
}
