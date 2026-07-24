"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const {
  assembleCellPairs,
  buildChildEnv,
  buildReceiptFrame,
  parseDriverArgs,
  parseReceiptFrame,
  resolveRuntimeBinary,
  validateRunReceipt,
} = require("../scripts/benchmark-snow-rf-receipts");
const {
  assembleFullBlocks,
  millisecondsToCanonicalNs,
  newestSummaryPath,
  parseArgs: parseFullGateArgs,
  runLabelForEntry,
} = require("../scripts/benchmark-snow-rf-full-gate");
const {
  PASS16_RECEIPT_FRAME_HEADER_BYTES,
  buildPass16FullSchedule,
  buildPass16ReceiptSchedule,
  summarizePass16FullGate,
} = require("../scripts/lib/noaa-beta/snow-rf-benchmark-contract");
const { SNOW_RF_ASSET_ORACLES } = require("../scripts/lib/noaa-beta/snow-rf-asset");

const RECEIPT_DRIVER_PATH = path.resolve(__dirname, "../scripts/benchmark-snow-rf-receipts.js");
const ROOT_DIR = path.resolve(__dirname, "..");

function spawnReceiptChild({ role, assetMode, teardownTrial = false }) {
  const execArgs = [];
  if (teardownTrial) {
    execArgs.push("--expose-gc");
  }
  execArgs.push(
    RECEIPT_DRIVER_PATH,
    "--child",
    `--role=${role}`,
    `--asset-mode=${assetMode}`,
    `--teardown-trial=${teardownTrial}`,
    "--sequence=1",
  );
  return spawnSync(process.execPath, execArgs, {
    cwd: ROOT_DIR,
    env: buildChildEnv(assetMode),
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function retainedEntryFor(role, mode) {
  return buildPass16ReceiptSchedule().find(
    (entry) =>
      entry.classification === "retained" && entry.role === role && entry.mode === mode && entry.runtime === "node22",
  );
}

test("receipt frame codec round-trips canonically and rejects tampering", () => {
  const receipt = { b: 1, a: { nested: ["x", 2, true, null] } };
  const frame = buildReceiptFrame(receipt);
  assert.equal(frame.toString("ascii", 0, 4), "MVBR");
  assert.equal(frame.readUInt32LE(4), frame.byteLength - PASS16_RECEIPT_FRAME_HEADER_BYTES);
  const parsed = parseReceiptFrame(frame);
  assert.deepEqual(parsed.receipt, { a: { nested: ["x", 2, true, null] }, b: 1 });
  assert.equal(parsed.bodyBytes, frame.byteLength - PASS16_RECEIPT_FRAME_HEADER_BYTES);

  const badMagic = Buffer.from(frame);
  badMagic.write("XXXX", 0, "ascii");
  assert.throws(() => parseReceiptFrame(badMagic), /magic/);

  const badLength = Buffer.from(frame);
  badLength.writeUInt32LE(badLength.readUInt32LE(4) + 1, 4);
  assert.throws(() => parseReceiptFrame(badLength), /declares/);

  const nonCanonical = Buffer.concat([
    frame.subarray(0, PASS16_RECEIPT_FRAME_HEADER_BYTES),
    Buffer.from(JSON.stringify({ b: 1, a: { nested: ["x", 2, true, null] } })),
  ]);
  nonCanonical.writeUInt32LE(nonCanonical.byteLength - PASS16_RECEIPT_FRAME_HEADER_BYTES, 4);
  assert.throws(() => parseReceiptFrame(nonCanonical), /canonical/);

  assert.throws(() => parseReceiptFrame(frame.subarray(0, 4)), /shorter/);
});

test("driver argument parsing accepts the documented surface and rejects strays", () => {
  assert.deepEqual(parseDriverArgs([]), { child: false });
  const parsed = parseDriverArgs([
    "--child",
    "--role=frame-worker",
    "--asset-mode=required",
    "--teardown-trial=false",
    "--sequence=42",
  ]);
  assert.equal(parsed.child, true);
  assert.equal(parsed.role, "frame-worker");
  assert.equal(parsed.assetMode, "required");
  assert.equal(parsed.teardownTrial, "false");
  assert.equal(parsed.sequence, "42");
  assert.throws(() => parseDriverArgs(["--bogus"]), /Unknown argument/);
});

test("child environment pins the treatment and process controls", () => {
  const env = buildChildEnv("required");
  assert.equal(env.MODELVIEW_NOAA_SNOW_RF_ASSET, "required");
  assert.equal(env.NODE_OPTIONS, "");
  assert.equal(env.LANG, "C");
  assert.equal(env.TZ, "UTC");
  assert.equal(Object.hasOwn(env, "MODELVIEW_SNOW_RF_CONUS_PATH"), false);
});

test("runtime resolution rejects a wrong-major and missing binary", () => {
  const resolved = resolveRuntimeBinary(process.execPath, Number(process.versions.node.split(".")[0]), "current");
  assert.equal(resolved.version, process.versions.node);
  assert.match(resolved.sha256, /^[0-9a-f]{64}$/);
  assert.throws(
    () => resolveRuntimeBinary(process.execPath, 20 === Number(process.versions.node.split(".")[0]) ? 22 : 20, "wrong"),
    /expected major/,
  );
  assert.throws(
    () => resolveRuntimeBinary(path.join(os.tmpdir(), "missing-node-binary"), 20, "missing"),
    /version probe/,
  );
  assert.throws(() => resolveRuntimeBinary("", 20, "empty"), /empty/);
});

test("real receipt children produce contract-valid receipts in every role and mode", () => {
  for (const [role, assetMode, mode] of [
    ["builder-main", "off", "A"],
    ["builder-main", "required", "B"],
    ["frame-worker", "off", "A"],
    ["frame-worker", "required", "B"],
  ]) {
    const result = spawnReceiptChild({ role, assetMode });
    assert.equal(result.status, 0, `${role}/${assetMode}: ${result.stderr}`);
    const frame = result.output[3];
    assert.ok(Buffer.isBuffer(frame) && frame.byteLength > 0, `${role}/${assetMode} emitted no frame`);
    const { receipt } = parseReceiptFrame(frame);
    const entry = retainedEntryFor(role, mode);
    const timingValidation = validateRunReceipt(entry, receipt, SNOW_RF_ASSET_ORACLES);
    assert.equal(timingValidation.mode, mode);
    if (mode === "B") {
      assert.equal(timingValidation.memory.passed, true);
    }
  }
});

test("child refuses mismatched treatment environment and malformed arguments", () => {
  const mismatched = spawnSync(
    process.execPath,
    [
      RECEIPT_DRIVER_PATH,
      "--child",
      "--role=builder-main",
      "--asset-mode=required",
      "--teardown-trial=false",
      "--sequence=1",
    ],
    {
      cwd: ROOT_DIR,
      env: buildChildEnv("off"),
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  assert.notEqual(mismatched.status, 0);
  assert.match(String(mismatched.stderr), /must equal the --asset-mode/);

  const badRole = spawnReceiptChild({ role: "conductor", assetMode: "off" });
  assert.notEqual(badRole.status, 0);
  assert.match(String(badRole.stderr), /--role must be/);
});

test("cell pair assembly keys pairs by cell and mode from retained records", () => {
  const schedule = buildPass16ReceiptSchedule().filter((entry) => entry.classification === "retained");
  const records = schedule.map((entry) => ({
    entry,
    receipt: {
      state: {
        timing: {
          loaderTotalNs: String(1_000_000 + entry.globalSequence),
          roleReadyNs: String(2_000_000 + entry.globalSequence),
        },
      },
    },
  }));
  const cells = assembleCellPairs(records);
  assert.deepEqual(Object.keys(cells).sort(), [
    "node20/builder-main",
    "node20/frame-worker",
    "node22/builder-main",
    "node22/frame-worker",
  ]);
  for (const pairs of Object.values(cells)) {
    assert.equal(pairs.length, 31);
    pairs.forEach((pair, index) => {
      assert.equal(pair.pairIndex, index + 1);
      for (const key of ["aLoaderTotalNs", "aRoleReadyNs", "bLoaderTotalNs", "bRoleReadyNs"]) {
        assert.match(pair[key], /^[0-9]+$/);
      }
    });
  }
});

test("full-gate labels, ns conversion, and block assembly follow the frozen schedule", () => {
  const schedule = buildPass16FullSchedule();
  assert.equal(runLabelForEntry("pass16-full", schedule[0]), "pass16-full-warmup-w1-p1-a");
  const firstRetained = schedule.find((entry) => entry.classification === "retained");
  assert.equal(runLabelForEntry("pass16-full", firstRetained), "pass16-full-retained-b01-p1-a");

  assert.equal(millisecondsToCanonicalNs(6317.949, "wall"), "6317949000");
  assert.throws(() => millisecondsToCanonicalNs(-1, "wall"), /nonnegative/);
  assert.throws(() => millisecondsToCanonicalNs(Number.NaN, "wall"), /nonnegative/);

  const retained = schedule
    .filter((entry) => entry.classification === "retained")
    .map((entry) => ({
      entry,
      run: { wallNs: String(6_000_000_000 + entry.globalSequence * (entry.mode === "A" ? 3 : 1)) },
    }));
  const blocks = assembleFullBlocks(retained);
  assert.equal(blocks.length, 16);
  blocks.forEach((block, index) => {
    assert.equal(block.blockIndex, index + 1);
    assert.equal(block.aNs.length, 2);
    assert.equal(block.bNs.length, 2);
  });
  const gate = summarizePass16FullGate(blocks);
  assert.equal(gate.runsPerMode, 32);
  assert.equal(typeof gate.passed, "boolean");
});

test("full-gate argument parsing requires distinct clones and known flags", () => {
  const base = ["--cache-root-a=/tmp/a", "--cache-root-b=/tmp/b", "--source-root=/tmp/src"];
  const parsed = parseFullGateArgs(base);
  assert.equal(parsed.model, "hrrr");
  assert.equal(parsed.hours, "0,1,2,3");
  assert.throws(
    () => parseFullGateArgs(["--cache-root-a=/tmp/a", "--cache-root-b=/tmp/a", "--source-root=/tmp/src"]),
    /distinct/,
  );
  assert.throws(() => parseFullGateArgs([...base, "--repetitions=2"]), /Unknown argument/);
  assert.throws(() => parseFullGateArgs(["--cache-root-a=/tmp/a"]), /required/);
});

test("fresh-summary discovery requires exactly one matching session", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snow-rf-full-gate-summaries-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runLabel = "pass16-full-retained-b01-p1-a";
  assert.throws(() => newestSummaryPath(dir, runLabel, 0), /exactly one fresh summary/);
  const sessionDir = path.join(dir, `${runLabel}-hrrr-20260716-13z-20260723T000000000Z`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "summary.json"), "{}");
  assert.equal(newestSummaryPath(dir, runLabel, 0), path.join(sessionDir, "summary.json"));
  const secondDir = path.join(dir, `${runLabel}-hrrr-20260716-13z-20260723T000000001Z`);
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(path.join(secondDir, "summary.json"), "{}");
  assert.throws(() => newestSummaryPath(dir, runLabel, 0), /exactly one fresh summary/);
});
