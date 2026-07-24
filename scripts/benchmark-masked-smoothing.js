#!/usr/bin/env node

"use strict";

// Repeatable A/B microbenchmark for the presentation-smoothing WASM port.
// Timings include the same JS -> WASM input copy and WASM -> JS result copy
// used by grid-ops.smoothFiniteNonnegativeGrid, not just kernel execution.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_WASM = path.join(ROOT, "tools/parcel-kernel/build/parcel-kernel.wasm");

function parseArgs(argv) {
  const options = {
    baselineWasm: null,
    candidateWasm: DEFAULT_WASM,
    width: 1600,
    height: 980,
    passes: 4,
    warmups: 4,
    repetitions: 15,
    mode: "terrain-mask",
  };
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument.startsWith("--baseline-wasm=")) {
      options.baselineWasm = path.resolve(argument.slice("--baseline-wasm=".length));
    } else if (argument.startsWith("--candidate-wasm=")) {
      options.candidateWasm = path.resolve(argument.slice("--candidate-wasm=".length));
    } else if (argument.startsWith("--width=")) {
      options.width = positiveInteger(argument.slice("--width=".length), "width");
    } else if (argument.startsWith("--height=")) {
      options.height = positiveInteger(argument.slice("--height=".length), "height");
    } else if (argument.startsWith("--passes=")) {
      options.passes = positiveInteger(argument.slice("--passes=".length), "passes");
    } else if (argument.startsWith("--warmups=")) {
      options.warmups = nonnegativeInteger(argument.slice("--warmups=".length), "warmups");
    } else if (argument.startsWith("--repetitions=")) {
      options.repetitions = positiveInteger(argument.slice("--repetitions=".length), "repetitions");
    } else if (argument.startsWith("--mode=")) {
      options.mode = argument.slice("--mode=".length);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!["terrain-mask", "sparse-missing", "all-finite"].includes(options.mode)) {
    throw new Error(`mode must be terrain-mask, sparse-missing, or all-finite; received '${options.mode}'`);
  }
  return options;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonnegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer`);
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/benchmark-masked-smoothing.js [options]

Options:
  --baseline-wasm=PATH   Optional baseline kernel for an interleaved A/B
  --candidate-wasm=PATH  Candidate kernel (default: repository build)
  --mode=MODE            terrain-mask (default), sparse-missing, all-finite
  --width=N              Grid width (default: 1600)
  --height=N             Grid height (default: 980)
  --passes=N             Smoothing passes (default: 4)
  --warmups=N            Warm-up calls per revision (default: 4)
  --repetitions=N        Measured calls per revision (default: 15)
`);
}

function loadSmoothingPort(wasmPath) {
  const bytes = fs.readFileSync(wasmPath);
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {
    env: {
      abort() {
        throw new Error("parcel-kernel abort");
      },
    },
  });
  const exports = instance.exports;
  const capacity = Number(exports.SMOOTH_CELLS_CAP?.value ?? exports.SMOOTH_CELLS_CAP);
  const inputPointer = Number(exports.SMOOTH_IN_PTR?.value ?? exports.SMOOTH_IN_PTR);
  const outputPointer = Number(exports.SMOOTH_OUT_PTR?.value ?? exports.SMOOTH_OUT_PTR);
  if (!capacity || !Number.isFinite(inputPointer) || !Number.isFinite(outputPointer)) {
    throw new Error(`${wasmPath} does not expose the smoothing buffers`);
  }
  if (typeof exports.smoothGrid !== "function") {
    throw new Error(`${wasmPath} does not export smoothGrid`);
  }
  return {
    path: wasmPath,
    capacity,
    input: new Float32Array(exports.memory.buffer, inputPointer, capacity),
    output: new Float32Array(exports.memory.buffer, outputPointer, capacity),
    run: exports.smoothGrid,
  };
}

function buildFixture(width, height, mode) {
  const values = new Float32Array(width * height);
  let state = 0x16f64f2;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  let nonFiniteCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const signal = Math.max(0, 8 * Math.sin(x * 0.011) * Math.cos(y * 0.015) + 1.5);
      let missing = false;
      if (mode === "terrain-mask") {
        const edge = x < Math.max(1, Math.round(width * 0.011)) || x >= Math.round(width * 0.989);
        const topBottom = y < Math.max(1, Math.round(height * 0.009)) || y >= Math.round(height * 0.991);
        const terrain = y > height * 0.48 && y < height * 0.84 && Math.sin(x * 0.016) + Math.cos(y * 0.021) > 1.08;
        missing = edge || topBottom || terrain;
      } else if (mode === "sparse-missing") {
        missing = random() < 0.035;
      }
      if (missing) {
        values[index] = Number.NaN;
        nonFiniteCount += 1;
      } else {
        values[index] = signal;
      }
    }
  }
  return { values, nonFiniteCount };
}

function invoke(port, fixture, width, height, passes) {
  port.input.set(fixture);
  port.run(fixture.length, width, height, passes);
  const out = new Float32Array(fixture.length);
  out.set(port.output.subarray(0, fixture.length));
  return out;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(values) {
  const center = median(values);
  const deviations = values.map((value) => Math.abs(value - center));
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samplesMs: values.map((value) => Number(value.toFixed(6))),
    medianMs: Number(center.toFixed(6)),
    madMs: Number(median(deviations).toFixed(6)),
    p95Ms: Number(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)].toFixed(6)),
  };
}

function compareBits(left, right) {
  const leftBits = new Uint32Array(left.buffer, left.byteOffset, left.length);
  const rightBits = new Uint32Array(right.buffer, right.byteOffset, right.length);
  let differentCells = 0;
  let finiteClassFlips = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (leftBits[index] === rightBits[index]) {
      continue;
    }
    differentCells += 1;
    if (Number.isFinite(left[index]) !== Number.isFinite(right[index])) {
      finiteClassFlips += 1;
    }
  }
  return { differentCells, finiteClassFlips };
}

function digest(values) {
  return crypto
    .createHash("sha256")
    .update(Buffer.from(values.buffer, values.byteOffset, values.byteLength))
    .digest("hex");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const fixture = buildFixture(options.width, options.height, options.mode);
  const candidate = loadSmoothingPort(options.candidateWasm);
  const baseline = options.baselineWasm ? loadSmoothingPort(options.baselineWasm) : null;
  for (const port of [baseline, candidate].filter(Boolean)) {
    if (fixture.values.length > port.capacity) {
      throw new Error(`${fixture.values.length} cells exceeds ${port.path}'s ${port.capacity}-cell capacity`);
    }
    for (let warmup = 0; warmup < options.warmups; warmup += 1) {
      invoke(port, fixture.values, options.width, options.height, options.passes);
    }
  }

  const samples = { candidate: [] };
  if (baseline) {
    samples.baseline = [];
  }
  const ports = baseline
    ? [
        ["baseline", baseline],
        ["candidate", candidate],
      ]
    : [["candidate", candidate]];
  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    const order = repetition % 2 === 0 ? ports : [...ports].reverse();
    for (const [name, port] of order) {
      const startedAt = performance.now();
      invoke(port, fixture.values, options.width, options.height, options.passes);
      samples[name].push(performance.now() - startedAt);
    }
  }

  const candidateOutput = invoke(candidate, fixture.values, options.width, options.height, options.passes);
  const result = {
    fixture: {
      mode: options.mode,
      width: options.width,
      height: options.height,
      cells: fixture.values.length,
      passes: options.passes,
      nonFiniteCount: fixture.nonFiniteCount,
    },
    warmups: options.warmups,
    repetitions: options.repetitions,
    candidate: {
      wasm: candidate.path,
      ...summarize(samples.candidate),
      outputSha256: digest(candidateOutput),
    },
  };
  if (baseline) {
    const baselineOutput = invoke(baseline, fixture.values, options.width, options.height, options.passes);
    result.baseline = {
      wasm: baseline.path,
      ...summarize(samples.baseline),
      outputSha256: digest(baselineOutput),
    };
    result.comparison = {
      medianDeltaPct: Number(
        (((result.candidate.medianMs - result.baseline.medianMs) / result.baseline.medianMs) * 100).toFixed(4),
      ),
      ...compareBits(baselineOutput, candidateOutput),
    };
    if (result.comparison.differentCells !== 0) {
      process.exitCode = 1;
    }
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
}
