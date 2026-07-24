#!/usr/bin/env node
"use strict";

const { performance } = require("node:perf_hooks");
const {
  CORE_LAYER_RENDER_OPTIONS,
  createContinuousColorLookup,
  createStepColorLookup,
  renderScalarGrid,
} = require("./lib/noaa-beta/raster");

const width = readPositiveInteger("--width", 1600);
const height = readPositiveInteger("--height", 980);
const samples = readPositiveInteger("--samples", 9);
const iterations = readPositiveInteger("--iterations", 3);
const cellCount = width * height;
const source = buildSourceGrid(cellCount);

const logLookup = createContinuousColorLookup({
  stops: [
    [0, [8, 24, 64, 0]],
    [0.3, [31, 120, 180, 0.65]],
    [0.7, [250, 220, 70, 0.9]],
    [1, [180, 20, 30, 1]],
  ],
  min: 0.01,
  max: 100,
  log: true,
  alpha: 0.9,
});
const nonuniformStepLookup = createStepColorLookup(
  [
    [-30, [0, 0, 0, 0]],
    [-5, [30, 80, 180, 0.5]],
    [2, [50, 190, 100, 0.7]],
    [17, [245, 220, 50, 0.85]],
    [41, [225, 80, 30, 1]],
    [73, [160, 30, 180, 1]],
  ],
  0.9,
);

const workloads = [
  {
    name: "continuous-raw",
    options: {
      values: source,
      width,
      height,
      ...CORE_LAYER_RENDER_OPTIONS.temperature,
    },
  },
  {
    name: "continuous-affine",
    options: {
      values: source,
      width,
      height,
      ...CORE_LAYER_RENDER_OPTIONS.temperature,
      transformScale: 1.8,
      transformOffset: -17.5,
    },
  },
  {
    name: "continuous-log",
    options: {
      values: source,
      width,
      height,
      colorLookup: logLookup,
      minVisible: 0.01,
    },
  },
  {
    name: "step-uniform",
    options: {
      values: source,
      width,
      height,
      ...CORE_LAYER_RENDER_OPTIONS.reflectivity,
    },
  },
  {
    name: "step-nonuniform",
    options: {
      values: source,
      width,
      height,
      colorLookup: nonuniformStepLookup,
      minVisible: -30,
    },
  },
];

for (let warmup = 0; warmup < 3; warmup += 1) {
  for (const workload of workloads) {
    consume(renderScalarGrid(workload.options));
  }
}

const results = new Map(workloads.map(({ name }) => [name, []]));
let checksum = 0;
for (let sample = 0; sample < samples; sample += 1) {
  const ordered = sample % 2 === 0 ? workloads : [...workloads].reverse();
  for (const workload of ordered) {
    if (typeof global.gc === "function") {
      global.gc();
    }
    const startedAt = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      checksum = (checksum + consume(renderScalarGrid(workload.options))) >>> 0;
    }
    results.get(workload.name).push((performance.now() - startedAt) / iterations);
  }
}

const reported = {};
for (const workload of workloads) {
  const values = results.get(workload.name);
  reported[workload.name] = summarize(values);
}
const aggregateSamples = Array.from({ length: samples }, (_, sample) =>
  workloads.reduce((total, workload) => total + results.get(workload.name)[sample], 0),
);

process.stdout.write(
  `${JSON.stringify(
    {
      dimensions: { width, height, cellCount },
      samples,
      iterations,
      checksum,
      workloads: reported,
      aggregate: summarize(aggregateSamples),
    },
    null,
    2,
  )}\n`,
);

function buildSourceGrid(length) {
  const values = new Float32Array(length);
  let state = 0x6d2b79f5;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    values[index] = index % 127 === 0 ? Number.NaN : ((state >>> 0) / 0xffffffff) * 180 - 60;
  }
  return values;
}

function consume(layer) {
  const rgba = layer.rgba;
  return (
    Number(layer.visibleCount || 0) +
    Number(layer.validCount || 0) +
    Number(rgba[0] || 0) +
    Number(rgba[(rgba.length / 2) | 0] || 0) +
    Number(rgba[rgba.length - 1] || 0)
  );
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const median = percentile(sorted, 0.5);
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((left, right) => left - right);
  return {
    samplesMs: values.map(round),
    medianMs: round(median),
    madMs: round(percentile(deviations, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

function readPositiveInteger(flag, fallback) {
  const argument = process.argv.find((value) => value.startsWith(`${flag}=`));
  const parsed = Number(argument?.slice(flag.length + 1));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
