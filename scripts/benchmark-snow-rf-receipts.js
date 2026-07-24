#!/usr/bin/env node

"use strict";

/**
 * Pass 16 receipt-gate driver: executes the frozen 272-entry Snow-RF receipt
 * schedule (24 excluded warmups + 31 retained pairs x 8) across two Node
 * runtimes (node20/node22) and two roles (builder-main/frame-worker), collects
 * one MVBR-framed canonical receipt per run over fd 3, revalidates every
 * receipt against the sealed contract, and summarizes the four per-cell gates.
 *
 * The schedule, gate limits, receipt framing caps, and statistics are owned by
 * scripts/lib/noaa-beta/snow-rf-benchmark-contract.js and are not configurable
 * here. The driver never touches the application cache.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  PASS16_MAX_CANONICAL_RECEIPT_FRAME_BYTES,
  PASS16_MAX_RECEIPT_SIDEBAND_BYTES,
  PASS16_RECEIPT_FRAME_HEADER_BYTES,
  PASS16_RECEIPT_FRAME_MAGIC,
  buildPass16ReceiptSchedule,
  measurePass16CanonicalReceiptFrame,
  serializePass16CanonicalReceiptJson,
  summarizePass16ReceiptCellGate,
  validatePass16ReceiptSchedule,
  validatePass16TimingAndMemory,
} = require("./lib/noaa-beta/snow-rf-benchmark-contract");

const ROOT_DIR = path.resolve(__dirname, "..");
const DRIVER_PATH = __filename;
const NODE20_RUNTIME_ENV = "MODELVIEW_NODE20_PATH";
const SNOW_RF_ASSET_ENV = "MODELVIEW_NOAA_SNOW_RF_ASSET";
const SNOW_RF_CUSTOM_PATH_ENV = "MODELVIEW_SNOW_RF_CONUS_PATH";
const RECEIPT_CHANNEL_FD = 3;
const DEFAULT_OUTPUT_ROOT = path.join(ROOT_DIR, "output", "noaa-benchmarks", "renderer-30pass");
const CHILD_TIMEOUT_MS = 120_000;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function parseDriverArgs(argv) {
  const args = { child: false };
  for (const token of argv) {
    if (token === "--child") {
      args.child = true;
    } else if (token.startsWith("--role=")) {
      args.role = token.slice("--role=".length);
    } else if (token.startsWith("--asset-mode=")) {
      args.assetMode = token.slice("--asset-mode=".length);
    } else if (token.startsWith("--teardown-trial=")) {
      args.teardownTrial = token.slice("--teardown-trial=".length);
    } else if (token.startsWith("--sequence=")) {
      args.sequence = token.slice("--sequence=".length);
    } else if (token.startsWith("--label=")) {
      args.label = token.slice("--label=".length);
    } else if (token.startsWith("--output-root=")) {
      args.outputRoot = token.slice("--output-root=".length);
    } else if (token.startsWith("--node20=")) {
      args.node20 = token.slice("--node20=".length);
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(token)}.`);
    }
  }
  return args;
}

function buildReceiptFrame(receipt) {
  const body = serializePass16CanonicalReceiptJson(receipt);
  const header = Buffer.alloc(PASS16_RECEIPT_FRAME_HEADER_BYTES);
  header.write(PASS16_RECEIPT_FRAME_MAGIC, 0, "ascii");
  // NOTE: this Pass 16 channel is little-endian while the builder/harness
  // benchmark sideband ("MVBR-u32be-json-v1") is big-endian despite the shared
  // magic; the two streams never cross, but a consumer keying on the magic
  // alone must check which channel it is reading.
  header.writeUInt32LE(body.byteLength, PASS16_RECEIPT_FRAME_MAGIC.length);
  return Buffer.concat([header, body]);
}

function parseReceiptFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.byteLength < PASS16_RECEIPT_FRAME_HEADER_BYTES) {
    throw new Error("Snow-RF receipt frame is shorter than its fixed header.");
  }
  if (frame.byteLength > PASS16_MAX_CANONICAL_RECEIPT_FRAME_BYTES) {
    throw new Error(`Snow-RF receipt frame exceeds ${PASS16_MAX_CANONICAL_RECEIPT_FRAME_BYTES} bytes.`);
  }
  const magic = frame.toString("ascii", 0, PASS16_RECEIPT_FRAME_MAGIC.length);
  if (magic !== PASS16_RECEIPT_FRAME_MAGIC) {
    throw new Error(
      `Snow-RF receipt frame magic must be ${PASS16_RECEIPT_FRAME_MAGIC}; observed ${JSON.stringify(magic)}.`,
    );
  }
  const declaredLength = frame.readUInt32LE(PASS16_RECEIPT_FRAME_MAGIC.length);
  if (frame.byteLength !== PASS16_RECEIPT_FRAME_HEADER_BYTES + declaredLength) {
    throw new Error(
      `Snow-RF receipt frame declares ${declaredLength} body bytes but carries ` +
        `${frame.byteLength - PASS16_RECEIPT_FRAME_HEADER_BYTES}.`,
    );
  }
  const body = frame.subarray(PASS16_RECEIPT_FRAME_HEADER_BYTES);
  const receipt = JSON.parse(body.toString("utf8"));
  const canonical = serializePass16CanonicalReceiptJson(receipt);
  if (!canonical.equals(body)) {
    throw new Error("Snow-RF receipt frame body is not in canonical form.");
  }
  return { receipt, bodyBytes: body.byteLength, bodySha256: sha256(body) };
}

async function runChild(args) {
  if (args.role !== "builder-main" && args.role !== "frame-worker") {
    throw new Error(`--role must be builder-main or frame-worker; observed ${JSON.stringify(args.role)}.`);
  }
  if (args.assetMode !== "off" && args.assetMode !== "required") {
    throw new Error(`--asset-mode must be off or required; observed ${JSON.stringify(args.assetMode)}.`);
  }
  if (args.teardownTrial !== "true" && args.teardownTrial !== "false") {
    throw new Error(`--teardown-trial must be true or false; observed ${JSON.stringify(args.teardownTrial)}.`);
  }
  const teardownTrial = args.teardownTrial === "true";
  if (process.env[SNOW_RF_ASSET_ENV] !== args.assetMode) {
    throw new Error(`${SNOW_RF_ASSET_ENV} must equal the --asset-mode argument in receipt children.`);
  }
  if (process.env[SNOW_RF_CUSTOM_PATH_ENV] !== undefined) {
    throw new Error(`${SNOW_RF_CUSTOM_PATH_ENV} must not be set in receipt children.`);
  }

  let receipt;
  if (args.role === "builder-main") {
    const { initializeSnowRfBenchmarkRole } = require("./lib/noaa-beta/snow-rf-role-receipt");
    receipt = initializeSnowRfBenchmarkRole({
      role: "builder-main",
      spawnOrdinal: 0,
      threadId: 0,
      teardownTrial,
    });
  } else {
    receipt = await runWorkerRole(teardownTrial);
  }
  const frame = buildReceiptFrame(receipt);
  // Write the whole frame even across short/interrupted pipe writes; a
  // truncated frame would abort the entire 272-run schedule at the parent.
  let written = 0;
  while (written < frame.byteLength) {
    written += fs.writeSync(RECEIPT_CHANNEL_FD, frame, written, frame.byteLength - written);
  }
}

function runWorkerRole(teardownTrial) {
  const { Worker } = require("node:worker_threads");
  return new Promise((resolve, reject) => {
    const worker = new Worker(DRIVER_PATH, {
      workerData: { pass16ReceiptWorker: true, teardownTrial },
    });
    let settled = false;
    worker.on("message", (message) => {
      settled = true;
      resolve(message);
    });
    worker.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    worker.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Snow-RF receipt worker exited with code ${code} before reporting a receipt.`));
      }
    });
  });
}

function runWorkerRoleThread() {
  const { parentPort, threadId, workerData } = require("node:worker_threads");
  const { initializeSnowRfBenchmarkRole } = require("./lib/noaa-beta/snow-rf-role-receipt");
  const receipt = initializeSnowRfBenchmarkRole({
    role: "frame-worker",
    spawnOrdinal: 1,
    threadId,
    teardownTrial: Boolean(workerData.teardownTrial),
  });
  parentPort.postMessage(receipt);
}

function resolveRuntimeBinary(binaryPath, expectedMajor, label) {
  const resolved = String(binaryPath || "").trim();
  if (!resolved) {
    throw new Error(`${label} runtime path is empty.`);
  }
  const probe = spawnSync(resolved, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 20_000 });
  if (probe.status !== 0) {
    throw new Error(
      `${label} runtime ${JSON.stringify(resolved)} failed a version probe: ${probe.stderr || probe.error}`,
    );
  }
  const version = String(probe.stdout).trim();
  if (!version.startsWith(`${expectedMajor}.`)) {
    throw new Error(
      `${label} runtime ${JSON.stringify(resolved)} reports Node ${version}, expected major ${expectedMajor}.`,
    );
  }
  return { path: resolved, version, sha256: sha256File(fs.realpathSync(resolved)) };
}

function buildChildEnv(assetMode) {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    NODE_DEBUG: "",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NODE_V8_COVERAGE: "",
    [SNOW_RF_ASSET_ENV]: assetMode,
  };
}

function executeScheduleEntry(entry, runtimes, sessionDir) {
  const runtime = runtimes[entry.runtime];
  const execArgs = [];
  if (entry.memoryTeardownTrial) {
    execArgs.push("--expose-gc");
  }
  execArgs.push(
    DRIVER_PATH,
    "--child",
    `--role=${entry.role}`,
    `--asset-mode=${entry.assetMode}`,
    `--teardown-trial=${entry.memoryTeardownTrial}`,
    `--sequence=${entry.globalSequence}`,
  );
  const startedAt = process.hrtime.bigint();
  const result = spawnSync(runtime.path, execArgs, {
    cwd: ROOT_DIR,
    env: buildChildEnv(entry.assetMode),
    encoding: "buffer",
    timeout: CHILD_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    maxBuffer: PASS16_MAX_RECEIPT_SIDEBAND_BYTES,
  });
  const finishedAt = process.hrtime.bigint();
  if (result.error) {
    throw new Error(`Schedule entry ${entry.globalSequence} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Schedule entry ${entry.globalSequence} (${entry.runtime}/${entry.role}/${entry.mode}) exited with ` +
        `${result.status === null ? `signal ${result.signal}` : `code ${result.status}`}: ` +
        `${result.stderr.toString("utf8").slice(0, 4000)}`,
    );
  }
  const sideband = result.output[RECEIPT_CHANNEL_FD];
  if (!Buffer.isBuffer(sideband) || sideband.byteLength === 0) {
    throw new Error(`Schedule entry ${entry.globalSequence} produced no receipt frame.`);
  }
  if (sideband.byteLength > PASS16_MAX_RECEIPT_SIDEBAND_BYTES) {
    throw new Error(`Schedule entry ${entry.globalSequence} exceeded the receipt sideband cap.`);
  }
  const { receipt, bodyBytes, bodySha256 } = parseReceiptFrame(sideband);
  measurePass16CanonicalReceiptFrame(receipt);
  const frameFile = path.join(
    sessionDir,
    "receipts",
    `${String(entry.globalSequence).padStart(3, "0")}-${entry.runtime}-${entry.role}-${entry.mode}.receipt.bin`,
  );
  fs.writeFileSync(frameFile, sideband);
  return {
    receipt,
    bodyBytes,
    bodySha256,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    childWallNs: (finishedAt - startedAt).toString(),
  };
}

function validateRunReceipt(entry, receipt, oracles) {
  if (receipt?.type !== "noaa-snow-rf-state" || receipt?.schemaVersion !== 1) {
    throw new Error(`Schedule entry ${entry.globalSequence} receipt type or schema is invalid.`);
  }
  if (receipt.role !== entry.role) {
    throw new Error(`Schedule entry ${entry.globalSequence} receipt role ${receipt.role} does not match the schedule.`);
  }
  const expectedSpawnOrdinal = entry.role === "builder-main" ? 0 : 1;
  if (receipt.spawnOrdinal !== expectedSpawnOrdinal) {
    throw new Error(`Schedule entry ${entry.globalSequence} receipt spawnOrdinal is invalid.`);
  }
  if (entry.role === "builder-main" ? receipt.threadId !== 0 : !(receipt.threadId > 0)) {
    throw new Error(`Schedule entry ${entry.globalSequence} receipt threadId is invalid for its role.`);
  }
  const state = receipt.state;
  const configuration = state?.configuration;
  const status = state?.status;
  if (configuration?.resolvedMode !== entry.assetMode) {
    throw new Error(
      `Schedule entry ${entry.globalSequence} resolved mode ${String(configuration?.resolvedMode)} ` +
        `does not match the scheduled treatment ${entry.assetMode}.`,
    );
  }
  const expectedEffective = entry.mode === "A" ? "json" : "typed-asset";
  if (
    status?.effectiveMode !== expectedEffective ||
    status?.fallbackUsed !== false ||
    status?.fallbackReasonCode !== null
  ) {
    throw new Error(`Schedule entry ${entry.globalSequence} did not run the unfallbacked ${expectedEffective} path.`);
  }
  const commitments = state?.commitments;
  if (
    commitments?.encoding !== "snow-rf-tree-major-fields-le-v1" ||
    commitments?.regionCount !== 500 ||
    commitments?.canonicalModelBinarySha256 !== oracles.binarySha256
  ) {
    throw new Error(`Schedule entry ${entry.globalSequence} commitments do not match the committed asset oracle.`);
  }
  if (entry.mode === "B") {
    const ownership = state?.ownership;
    if (
      ownership?.commonOwner !== true ||
      ownership?.ownerAllocationCount !== 1 ||
      ownership?.regionCount !== 500 ||
      ownership?.privateRegionOwnerCount !== 0
    ) {
      throw new Error(`Schedule entry ${entry.globalSequence} typed ownership contract failed.`);
    }
  } else if (state?.ownership !== null) {
    throw new Error(`Schedule entry ${entry.globalSequence} JSON-mode receipt must not report typed ownership.`);
  }
  const timingValidation = validatePass16TimingAndMemory(state.timing, {
    mode: entry.mode,
    teardownTrial: entry.memoryTeardownTrial,
  });
  if (timingValidation.memory.passed === false) {
    throw new Error(`Schedule entry ${entry.globalSequence} failed the B-mode memory delta ceilings.`);
  }
  return timingValidation;
}

function assembleCellPairs(retainedRecords) {
  const cells = new Map();
  for (const record of retainedRecords) {
    const cellKey = `${record.entry.runtime}/${record.entry.role}`;
    if (!cells.has(cellKey)) {
      cells.set(cellKey, new Map());
    }
    const pairs = cells.get(cellKey);
    if (!pairs.has(record.entry.pairIndex)) {
      pairs.set(record.entry.pairIndex, { pairIndex: record.entry.pairIndex });
    }
    const pair = pairs.get(record.entry.pairIndex);
    const prefix = record.entry.mode === "A" ? "a" : "b";
    pair[`${prefix}LoaderTotalNs`] = record.receipt.state.timing.loaderTotalNs;
    pair[`${prefix}RoleReadyNs`] = record.receipt.state.timing.roleReadyNs;
  }
  const assembled = {};
  for (const [cellKey, pairs] of cells) {
    assembled[cellKey] = [...pairs.values()].sort((left, right) => left.pairIndex - right.pairIndex);
  }
  return assembled;
}

async function runDriver(args) {
  const schedule = buildPass16ReceiptSchedule();
  validatePass16ReceiptSchedule(schedule);

  const {
    SNOW_RF_ASSET_ORACLES,
    DEFAULT_BINARY_PATH,
    DEFAULT_MANIFEST_PATH,
    DEFAULT_SOURCE_PATH,
  } = require("./lib/noaa-beta/snow-rf-asset");
  const committedBinarySha256 = sha256File(DEFAULT_BINARY_PATH);
  if (committedBinarySha256 !== SNOW_RF_ASSET_ORACLES.binarySha256) {
    throw new Error("Committed Snow-RF binary does not match the sealed asset oracle; refusing to benchmark.");
  }

  const node22 = resolveRuntimeBinary(process.execPath, 22, "node22");
  const node20 = resolveRuntimeBinary(args.node20 || process.env[NODE20_RUNTIME_ENV], 20, "node20");
  const runtimes = { node20, node22 };

  const label = args.label || "pass16-receipt-gate";
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const sessionDir = path.join(args.outputRoot || DEFAULT_OUTPUT_ROOT, `${label}-${stamp}`);
  fs.mkdirSync(path.join(sessionDir, "receipts"), { recursive: true });

  const records = [];
  let parityCommitments = null;
  for (const entry of schedule) {
    const run = executeScheduleEntry(entry, runtimes, sessionDir);
    const timingValidation = validateRunReceipt(entry, run.receipt, SNOW_RF_ASSET_ORACLES);
    if (entry.parityPreflight) {
      const serialized = JSON.stringify(run.receipt.state.commitments);
      if (parityCommitments === null) {
        parityCommitments = serialized;
      } else if (serialized !== parityCommitments) {
        throw new Error(`Schedule entry ${entry.globalSequence} parity-preflight commitments diverged.`);
      }
    }
    records.push({ entry, receipt: run.receipt, run, timingValidation });
    console.log(
      `[snow-rf-receipts] ${String(entry.globalSequence).padStart(3, "0")}/272 ` +
        `${entry.classification} ${entry.runtime} ${entry.role} ${entry.mode} ` +
        `loader=${(Number(run.receipt.state.timing.loaderTotalNs) / 1e6).toFixed(3)}ms ` +
        `roleReady=${(Number(run.receipt.state.timing.roleReadyNs) / 1e6).toFixed(3)}ms`,
    );
  }

  const retained = records.filter((record) => record.entry.classification === "retained");
  const cellPairs = assembleCellPairs(retained);
  const cellSummaries = {};
  for (const [cellKey, pairs] of Object.entries(cellPairs)) {
    cellSummaries[cellKey] = summarizePass16ReceiptCellGate(pairs);
  }
  const passed = Object.values(cellSummaries).every((summary) => summary.passed);

  const evidence = {
    schemaVersion: 1,
    label,
    generatedAt: new Date().toISOString(),
    contract: {
      scheduleEntries: schedule.length,
      retainedEntries: retained.length,
      excludedEntries: schedule.length - retained.length,
    },
    runtimes,
    asset: {
      binaryPath: path.relative(ROOT_DIR, DEFAULT_BINARY_PATH),
      binarySha256: committedBinarySha256,
      manifestSha256: sha256File(DEFAULT_MANIFEST_PATH),
      sourceSha256: sha256File(DEFAULT_SOURCE_PATH),
    },
    runs: records.map(({ entry, run, timingValidation }) => ({
      globalSequence: entry.globalSequence,
      classification: entry.classification,
      runtime: entry.runtime,
      role: entry.role,
      mode: entry.mode,
      assetMode: entry.assetMode,
      pairIndex: entry.pairIndex,
      memoryTeardownTrial: entry.memoryTeardownTrial,
      parityPreflight: entry.parityPreflight,
      receiptBodyBytes: run.bodyBytes,
      receiptBodySha256: run.bodySha256,
      childWallNs: run.childWallNs,
      loaderTotalNs: timingValidation.loaderTotalNs,
      roleReadyNs: timingValidation.roleReadyNs,
      receiptCommitmentNs: timingValidation.receiptCommitmentNs,
      memoryGates: timingValidation.memory.gates,
    })),
    cellPairs,
    cellSummaries,
    passed,
  };
  const evidencePath = path.join(sessionDir, "summary.json");
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[snow-rf-receipts] gate ${passed ? "PASSED" : "FAILED"}; evidence at ${evidencePath}`);
  if (!passed) {
    process.exitCode = 1;
  }
  return evidence;
}

async function main() {
  const args = parseDriverArgs(process.argv.slice(2));
  if (args.child) {
    await runChild(args);
    return;
  }
  await runDriver(args);
}

const workerThreads = require("node:worker_threads");
if (!workerThreads.isMainThread && workerThreads.workerData?.pass16ReceiptWorker === true) {
  runWorkerRoleThread();
} else if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  assembleCellPairs,
  buildChildEnv,
  buildReceiptFrame,
  parseDriverArgs,
  parseReceiptFrame,
  resolveRuntimeBinary,
  validateRunReceipt,
};
