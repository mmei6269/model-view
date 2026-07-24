#!/usr/bin/env node

"use strict";

/**
 * Pass 16 full-gate driver: executes the frozen 72-run Snow-RF full schedule
 * (2 excluded ABBA/BAAB warmup blocks + 16 retained blocks, 32 runs per mode)
 * through the sealed renderer benchmark harness, one harness invocation per
 * scheduled run. Mode A pins --snow-rf=off (complete-JSON loader) and mode B
 * pins --snow-rf=required (typed asset); both arms run the identical candidate
 * source tree. Each mode renders into its own dedicated cache clone so the two
 * arms' artifacts stay separable for post-gate parity comparison, and the
 * application cache is never touched.
 *
 * Schedule, block statistics, and gate limits are owned by
 * scripts/lib/noaa-beta/snow-rf-benchmark-contract.js.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  buildPass16FullSchedule,
  summarizePass16FullGate,
  validatePass16FullSchedule,
} = require("./lib/noaa-beta/snow-rf-benchmark-contract");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_ROOT = path.join(ROOT_DIR, "output", "noaa-benchmarks", "renderer-30pass");
const HARNESS_RELATIVE_PATH = path.join("scripts", "benchmark-noaa-renderer.js");
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    model: "hrrr",
    date: "20260716",
    cycle: "13",
    hours: "0,1,2,3",
    label: "pass16-full",
    outputRoot: DEFAULT_OUTPUT_ROOT,
  };
  for (const token of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(token);
    if (!match) {
      throw new Error(`Unknown argument ${JSON.stringify(token)}.`);
    }
    const [, key, value] = match;
    const mapped = {
      "cache-root-a": "cacheRootA",
      "cache-root-b": "cacheRootB",
      "source-root": "sourceRoot",
      "output-root": "outputRoot",
      label: "label",
      model: "model",
      date: "date",
      cycle: "cycle",
      hours: "hours",
    }[key];
    if (!mapped) {
      throw new Error(`Unknown argument ${JSON.stringify(token)}.`);
    }
    args[mapped] = value;
  }
  for (const required of ["cacheRootA", "cacheRootB", "sourceRoot"]) {
    if (!args[required]) {
      throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required.`);
    }
    args[required] = path.resolve(args[required]);
  }
  if (path.resolve(args.cacheRootA) === path.resolve(args.cacheRootB)) {
    throw new Error("Mode A and mode B must use distinct dedicated cache clones.");
  }
  return args;
}

function runLabelForEntry(label, entry) {
  const block =
    entry.classification === "excluded"
      ? `w${entry.excludedBlockIndex}`
      : `b${String(entry.blockIndex).padStart(2, "0")}`;
  return `${label}-${entry.classification === "excluded" ? "warmup" : "retained"}-${block}-p${entry.withinBlockPosition}-${entry.mode.toLowerCase()}`;
}

function millisecondsToCanonicalNs(milliseconds, label) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new Error(`${label} must be a nonnegative finite millisecond value.`);
  }
  return BigInt(Math.round(milliseconds * 1e6)).toString();
}

function newestSummaryPath(outputRoot, runLabel, sinceMs) {
  const prefix = `${runLabel}-`;
  const candidates = fs
    .readdirSync(outputRoot)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(outputRoot, name, "summary.json"))
    .filter((summaryPath) => {
      try {
        return fs.statSync(summaryPath).mtimeMs >= sinceMs;
      } catch {
        return false;
      }
    })
    .sort();
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one fresh summary for ${runLabel}; observed ${candidates.length}.`);
  }
  return candidates[0];
}

function executeHarnessRun(args, entry) {
  const runLabel = runLabelForEntry(args.label, entry);
  const cacheRoot = entry.mode === "A" ? args.cacheRootA : args.cacheRootB;
  const snowRf = entry.mode === "A" ? "off" : "required";
  const harnessPath = path.join(args.sourceRoot, HARNESS_RELATIVE_PATH);
  const startedMs = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      harnessPath,
      `--label=${runLabel}`,
      `--cache-root=${cacheRoot}`,
      `--source-root=${args.sourceRoot}`,
      `--output-root=${args.outputRoot}`,
      `--model=${args.model}`,
      `--date=${args.date}`,
      `--cycle=${args.cycle}`,
      `--hours=${args.hours}`,
      "--repetitions=1",
      `--snow-rf=${snowRf}`,
    ],
    {
      cwd: args.sourceRoot,
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(`Run ${runLabel} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Run ${runLabel} exited with ${result.status === null ? `signal ${result.signal}` : `code ${result.status}`}:\n` +
        `${(result.stderr || result.stdout || "").slice(-4000)}`,
    );
  }
  const summaryPath = newestSummaryPath(args.outputRoot, runLabel, startedMs);
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const repetition = summary?.repetitions?.[0];
  if (summary?.fixture?.repetitionsCompleted !== 1 || !repetition) {
    throw new Error(`Run ${runLabel} did not complete its single repetition.`);
  }
  if (repetition?.parsed?.fixtureValidation?.valid !== true) {
    throw new Error(
      `Run ${runLabel} failed fixture/treatment validation: ` +
        `${JSON.stringify(repetition?.parsed?.fixtureValidation?.errors || ["missing validation"]).slice(0, 2000)}`,
    );
  }
  const wallMs = repetition.subprocessWallMs;
  return {
    runLabel,
    summaryPath: path.relative(ROOT_DIR, summaryPath),
    snowRf,
    cacheRoot,
    wallMs,
    wallNs: millisecondsToCanonicalNs(wallMs, `${runLabel} subprocess wall`),
  };
}

function assembleFullBlocks(retainedRecords) {
  const blocks = new Map();
  for (const record of retainedRecords) {
    const { entry, run } = record;
    if (!blocks.has(entry.blockIndex)) {
      blocks.set(entry.blockIndex, { blockIndex: entry.blockIndex, aNs: [], bNs: [] });
    }
    blocks.get(entry.blockIndex)[entry.mode === "A" ? "aNs" : "bNs"].push(run.wallNs);
  }
  return [...blocks.values()].sort((left, right) => left.blockIndex - right.blockIndex);
}

function collectClonePreflightManifest(cacheRoot) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        entries.push(`${path.relative(cacheRoot, full)}\t${fs.statSync(full).size}`);
      }
    }
  };
  walk(cacheRoot);
  const text = entries.join("\n");
  return {
    fileCount: entries.length,
    manifestSha256: require("node:crypto").createHash("sha256").update(text).digest("hex"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const schedule = buildPass16FullSchedule();
  validatePass16FullSchedule(schedule);
  fs.mkdirSync(args.outputRoot, { recursive: true });

  // The sign test is powerless against arm-constant cache bias, so both
  // clones must start structurally identical (same file roster and sizes).
  const clonePreflight = {
    A: collectClonePreflightManifest(args.cacheRootA),
    B: collectClonePreflightManifest(args.cacheRootB),
  };
  if (
    clonePreflight.A.fileCount !== clonePreflight.B.fileCount ||
    clonePreflight.A.manifestSha256 !== clonePreflight.B.manifestSha256
  ) {
    throw new Error("Mode A and mode B cache clones are not structurally identical before the first run.");
  }

  const records = [];
  for (const entry of schedule) {
    const run = executeHarnessRun(args, entry);
    records.push({ entry, run });
    console.log(
      `[snow-rf-full-gate] ${String(entry.globalSequence).padStart(2, "0")}/72 ${run.runLabel} ` +
        `wall=${run.wallMs.toFixed(3)}ms`,
    );
  }

  const retained = records.filter((record) => record.entry.classification === "retained");
  const blocks = assembleFullBlocks(retained);
  const gate = summarizePass16FullGate(blocks);

  const evidence = {
    schemaVersion: 1,
    label: args.label,
    generatedAt: new Date().toISOString(),
    fixture: { model: args.model, date: args.date, cycle: args.cycle, hours: args.hours },
    treatments: { A: "off", B: "required" },
    sourceRoot: args.sourceRoot,
    cacheRoots: { A: args.cacheRootA, B: args.cacheRootB },
    clonePreflight,
    runs: records.map(({ entry, run }) => ({
      globalSequence: entry.globalSequence,
      classification: entry.classification,
      blockIndex: entry.blockIndex,
      excludedBlockIndex: entry.excludedBlockIndex,
      withinBlockPosition: entry.withinBlockPosition,
      mode: entry.mode,
      ...run,
    })),
    blocks,
    gate,
  };
  const evidencePath = path.join(args.outputRoot, `${args.label}-gate-summary.json`);
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[snow-rf-full-gate] gate ${gate.passed ? "PASSED" : "FAILED"}; evidence at ${evidencePath}`);
  if (!gate.passed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  assembleFullBlocks,
  millisecondsToCanonicalNs,
  newestSummaryPath,
  parseArgs,
  runLabelForEntry,
};
