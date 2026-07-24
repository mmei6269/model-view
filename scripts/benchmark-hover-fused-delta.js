#!/usr/bin/env node

"use strict";

// Production-shaped microbenchmark for Pass 18's fused hover quantize/delta
// path. It models the renderer's binary-hover CPU work up to (but excluding)
// lossless compression: quantize 72 1600x980 planes, pack one contiguous data
// region, and produce the schema-v3 global wrapping-i16 delta stream.
// Compression is intentionally excluded because both revisions feed it the
// exact same bytes and production normally dispatches it to a helper thread.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CANDIDATE_WASM = path.join(ROOT, "tools/parcel-kernel/build/parcel-kernel.wasm");

function parseArgs(argv) {
  const options = {
    baselineWasm: null,
    candidateWasm: DEFAULT_CANDIDATE_WASM,
    width: 1600,
    height: 980,
    variables: 72,
    warmups: 5,
    repetitions: 15,
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
    } else if (argument.startsWith("--variables=")) {
      options.variables = positiveInteger(argument.slice("--variables=".length), "variables");
    } else if (argument.startsWith("--warmups=")) {
      options.warmups = nonnegativeInteger(argument.slice("--warmups=".length), "warmups");
    } else if (argument.startsWith("--repetitions=")) {
      options.repetitions = positiveInteger(argument.slice("--repetitions=".length), "repetitions");
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
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
  process.stdout.write(`Usage: node --expose-gc scripts/benchmark-hover-fused-delta.js --baseline-wasm=PATH [options]

Options:
  --baseline-wasm=PATH   Required pre-candidate parcel-kernel wasm
  --candidate-wasm=PATH  Candidate wasm (default: repository build)
  --width=N              Grid width (default: 1600)
  --height=N             Grid height (default: 980)
  --variables=N          Hover planes (default: 72)
  --warmups=N            Alternating warm-up pairs (default: 5)
  --repetitions=N        Measured A/B pairs (default: 15)
`);
}

function loadPort(wasmPath, { requireFused = false } = {}) {
  const bytes = fs.readFileSync(wasmPath);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: {
      abort() {
        throw new Error("parcel-kernel abort");
      },
    },
  });
  const exports = instance.exports;
  const value = (name) => Number(exports[name]?.value ?? exports[name]);
  const quantChunk = value("QUANT_CHUNK");
  const deltaChunk = value("DELTA_CHUNK");
  const deltaOutput = exports.deltaEncodeQuantizedI16;
  if (
    !quantChunk ||
    !deltaChunk ||
    typeof exports.quantizeRawF64 !== "function" ||
    typeof exports.quantizeAffineF64 !== "function" ||
    typeof exports.quantizeWindF64 !== "function" ||
    typeof exports.deltaEncodeI16 !== "function"
  ) {
    throw new Error(`${wasmPath} does not expose the required hover ports`);
  }
  if (requireFused && typeof deltaOutput !== "function") {
    throw new Error(`${wasmPath} does not expose deltaEncodeQuantizedI16`);
  }
  return {
    path: wasmPath,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    quantChunk,
    deltaChunk,
    inputA: new Float32Array(exports.memory.buffer, value("QIN_A_PTR"), quantChunk),
    inputB: new Float32Array(exports.memory.buffer, value("QIN_B_PTR"), quantChunk),
    output: new Int16Array(exports.memory.buffer, value("QOUT_PTR"), quantChunk),
    stats: new Int32Array(exports.memory.buffer, value("QSTATS_PTR"), 3),
    deltaBuffer: new Int16Array(exports.memory.buffer, value("DELTA_PTR"), deltaChunk),
    quantizeRaw: exports.quantizeRawF64,
    quantizeAffine: exports.quantizeAffineF64,
    quantizeWind: exports.quantizeWindF64,
    delta: exports.deltaEncodeI16,
    deltaOutput,
  };
}

function buildFixture(width, height) {
  const cellCount = width * height;
  const source = new Float32Array(cellCount);
  const windV = new Float32Array(cellCount);
  let nonFiniteCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const x = index % width;
    const y = Math.floor(index / width);
    // A broad outside-domain band plus sparse interior holes approximates a
    // CONUS pressure-surface/terrain mask while retaining long finite runs.
    const missing = x < Math.round(width * 0.05) || (x * 17 + y * 31) % 211 === 0;
    if (missing) {
      source[index] = Number.NaN;
      windV[index] = Number.NaN;
      nonFiniteCount += 1;
    } else {
      source[index] = Math.sin(x * 0.007) * 35 + Math.cos(y * 0.009) * 18 + 20;
      windV[index] = Math.cos(x * 0.011) * 22 - Math.sin(y * 0.006) * 12;
    }
  }
  return { source, windV, nonFiniteCount };
}

function variableKind(index, variableCount) {
  const rawEnd = Math.floor((variableCount * 2) / 3);
  const affineEnd = Math.floor((variableCount * 8) / 9);
  return index < rawEnd ? "raw" : index < affineEnd ? "affine" : "wind";
}

function createRunner({ baseline, candidate, fixture, cellCount, variableCount }) {
  const valueCount = cellCount * variableCount;
  const encoded = new Int16Array(valueCount);
  const packed = new Int16Array(valueCount);
  const variableEndValues = new Int16Array(variableCount);

  function quantizeVariable(port, kind, outputOffset, fuseDelta) {
    let previous = 0;
    const diagnostics = { validCount: 0, clampCount: 0, nonFiniteCount: 0 };
    for (let start = 0; start < cellCount; start += port.quantChunk) {
      const count = Math.min(port.quantChunk, cellCount - start);
      port.inputA.set(fixture.source.subarray(start, start + count));
      if (kind === "wind") {
        port.inputB.set(fixture.windV.subarray(start, start + count));
        port.quantizeWind(count, 10, 1.943844);
      } else if (kind === "affine") {
        port.quantizeAffine(count, 20, 1.8, -459.67, 0, 0);
      } else {
        port.quantizeRaw(count, 10);
      }
      diagnostics.validCount += port.stats[0];
      diagnostics.clampCount += port.stats[1];
      diagnostics.nonFiniteCount += port.stats[2];
      if (fuseDelta) {
        previous = port.deltaOutput(count, previous);
      }
      encoded.set(port.output.subarray(0, count), outputOffset + start);
    }
    return { previous, diagnostics };
  }

  function run(revision) {
    const fused = revision === "candidate";
    const port = fused ? candidate : baseline;
    const diagnostics = { validCount: 0, clampCount: 0, nonFiniteCount: 0 };
    const startedAt = performance.now();
    for (let variable = 0; variable < variableCount; variable += 1) {
      const result = quantizeVariable(port, variableKind(variable, variableCount), variable * cellCount, fused);
      variableEndValues[variable] = result.previous;
      diagnostics.validCount += result.diagnostics.validCount;
      diagnostics.clampCount += result.diagnostics.clampCount;
      diagnostics.nonFiniteCount += result.diagnostics.nonFiniteCount;
    }
    const quantizeFinishedAt = performance.now();

    packed.set(encoded);
    if (fused) {
      // The production packer performs the same one-value adjustment at each
      // variable boundary, converting independent zero-carry streams into
      // the exact schema-v3 global stream.
      let previous = 0;
      for (let variable = 0; variable < variableCount; variable += 1) {
        const offset = variable * cellCount;
        packed[offset] = packed[offset] - previous;
        previous = variableEndValues[variable];
      }
    }
    const packFinishedAt = performance.now();

    if (!fused) {
      let previous = 0;
      for (let start = 0; start < valueCount; start += port.deltaChunk) {
        const count = Math.min(port.deltaChunk, valueCount - start);
        port.deltaBuffer.set(packed.subarray(start, start + count));
        previous = port.delta(count, previous);
        packed.set(port.deltaBuffer.subarray(0, count), start);
      }
    }
    const finishedAt = performance.now();
    return {
      quantizeMs: quantizeFinishedAt - startedAt,
      packMs: packFinishedAt - quantizeFinishedAt,
      separateDeltaMs: finishedAt - packFinishedAt,
      totalMs: finishedAt - startedAt,
      diagnostics,
    };
  }

  function outputHash() {
    return crypto
      .createHash("sha256")
      .update(Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength))
      .digest("hex");
  }

  return { run, outputHash, outputBytes: packed.byteLength };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mad(values) {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function summarize(samples) {
  const fields = ["quantizeMs", "packMs", "separateDeltaMs", "totalMs"];
  return Object.fromEntries(
    fields.map((field) => {
      const values = samples.map((sample) => sample[field]);
      return [field, { median: median(values), mad: mad(values), samples: values }];
    }),
  );
}

function maybeCollectGarbage() {
  if (typeof global.gc === "function") {
    global.gc();
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.baselineWasm) {
    throw new Error("--baseline-wasm=PATH is required");
  }

  const baseline = loadPort(options.baselineWasm);
  const candidate = loadPort(options.candidateWasm, { requireFused: true });
  const cellCount = options.width * options.height;
  const fixture = buildFixture(options.width, options.height);
  const runner = createRunner({
    baseline,
    candidate,
    fixture,
    cellCount,
    variableCount: options.variables,
  });

  for (let index = 0; index < options.warmups; index += 1) {
    const order = index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const revision of order) {
      runner.run(revision);
    }
  }

  const samples = { baseline: [], candidate: [] };
  for (let index = 0; index < options.repetitions; index += 1) {
    const order = index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const revision of order) {
      maybeCollectGarbage();
      samples[revision].push(runner.run(revision));
    }
  }

  const baselineParity = runner.run("baseline");
  const baselineHash = runner.outputHash();
  const candidateParity = runner.run("candidate");
  const candidateHash = runner.outputHash();
  assertDiagnosticsEqual(baselineParity.diagnostics, candidateParity.diagnostics);
  if (baselineHash !== candidateHash) {
    throw new Error(`output mismatch: baseline ${baselineHash}, candidate ${candidateHash}`);
  }

  const baselineSummary = summarize(samples.baseline);
  const candidateSummary = summarize(samples.candidate);
  const baselineMedian = baselineSummary.totalMs.median;
  const candidateMedian = candidateSummary.totalMs.median;
  const deltaMs = candidateMedian - baselineMedian;
  const deltaPercent = baselineMedian > 0 ? (deltaMs / baselineMedian) * 100 : 0;

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "hover-fused-delta-v1",
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        options,
        workload: {
          cellCount,
          variableCount: options.variables,
          rawVariables: Math.floor((options.variables * 2) / 3),
          affineVariables: Math.floor((options.variables * 8) / 9) - Math.floor((options.variables * 2) / 3),
          windVariables: options.variables - Math.floor((options.variables * 8) / 9),
          nonFiniteCellsPerVariable: fixture.nonFiniteCount,
          packedBytes: runner.outputBytes,
        },
        wasm: {
          baseline: { path: baseline.path, sha256: baseline.sha256 },
          candidate: { path: candidate.path, sha256: candidate.sha256 },
        },
        baseline: baselineSummary,
        candidate: candidateSummary,
        result: { deltaMs, deltaPercent, baselineHash, candidateHash, exactParity: true },
      },
      null,
      2,
    )}\n`,
  );
}

function assertDiagnosticsEqual(baseline, candidate) {
  for (const key of ["validCount", "clampCount", "nonFiniteCount"]) {
    if (baseline[key] !== candidate[key]) {
      throw new Error(`diagnostic mismatch for ${key}: baseline ${baseline[key]}, candidate ${candidate[key]}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error);
  process.exitCode = 1;
}
