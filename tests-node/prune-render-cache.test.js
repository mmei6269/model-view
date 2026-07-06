"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { promisify } = require("node:util");
const { planPrune, runPrune, parseArgs } = require("../scripts/prune-render-cache");

const execFileAsync = promisify(execFile);
const SCRIPT = path.resolve(__dirname, "..", "scripts", "prune-render-cache.js");

async function touch(filePath, bytes = 4) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, Buffer.alloc(bytes, 1));
}

// runIds newest-last so we can assert which get kept.
const RUNS = [
  "20260701-0000Z",
  "20260701-0600Z",
  "20260701-1200Z",
  "20260701-1800Z",
  "20260702-0000Z",
  "20260702-0600Z",
];

async function buildCache(root) {
  for (const run of RUNS) {
    for (const view of ["conus", "na"]) {
      await touch(path.join(root, "artifacts", "manifests", "gfs", `${run}--${view}.json`));
      await touch(path.join(root, "artifacts", "tiles", "gfs", run, view, "000", "2t.png"), 1000);
    }
    const [date, cycleZ] = run.split("-");
    const cycle = cycleZ.slice(0, 2);
    await touch(path.join(root, "raw-noaa", "selected-grib-v2", "gfs", date, cycle, "sel.grib2"), 5000);
  }
  await touch(path.join(root, "artifacts", "manifests", "gfs", "latest--conus.json"));
  await touch(path.join(root, "artifacts", "manifests", "gfs", "latest--na.json"));
}

test("planPrune keeps the newest N runs of manifests+tiles per model/view", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-prune-"));
  try {
    await buildCache(root);
    const plan = await planPrune(root, { keepRuns: 4 });
    const removedManifests = plan.deletions
      .filter((d) => d.path.includes(`${path.sep}manifests${path.sep}`))
      .map((d) => d.path);
    // Oldest 2 runs (both views) => 4 manifest files removed; newest 4 kept.
    assert.equal(removedManifests.length, 4);
    for (const kept of ["20260702-0600Z", "20260702-0000Z", "20260701-1800Z", "20260701-1200Z"]) {
      assert.ok(!removedManifests.some((p) => p.includes(kept)), `${kept} must be kept`);
    }
    // latest pointer is never a deletion target.
    assert.ok(!plan.deletions.some((d) => d.path.includes("latest--")));
    // Tiles dirs for the oldest 2 runs are removed.
    const removedTiles = plan.deletions
      .filter((d) => d.path.includes(`${path.sep}tiles${path.sep}`))
      .map((d) => d.path);
    assert.ok(removedTiles.some((p) => p.includes("20260701-0000Z")));
    assert.ok(removedTiles.some((p) => p.includes("20260701-0600Z")));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("planPrune keeps only the newest run of raw-noaa per model", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-prune-raw-"));
  try {
    await buildCache(root);
    const plan = await planPrune(root, { keepRuns: 4 });
    const removedRaw = plan.deletions
      .filter((d) => d.path.includes(`${path.sep}raw-noaa${path.sep}`))
      .map((d) => d.path);
    // 6 raw runs, keep 1 (newest 20260702/06) => 5 removed.
    assert.equal(removedRaw.length, 5);
    assert.ok(!removedRaw.some((p) => p.includes(`${path.sep}06${path.sep}`) && p.includes("20260702")));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("budget spill never deletes the newest run per model; latest pointers survive a real prune", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-prune-floor-"));
  try {
    await buildCache(root);
    const logs = captureLogs();
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    let plan;
    try {
      // 1 byte: impossible to satisfy — the spill must stop at the retention
      // floor instead of deleting the newest run per model.
      plan = await runPrune(root, { keepRuns: 4, budgetBytes: 1, dryRun: false });
    } finally {
      logs.restore();
      console.warn = originalWarn;
    }
    // The newest run's artifacts are never in the plan, under any kind.
    assert.ok(
      !plan.deletions.some((d) => d.path.includes("20260702-0600Z")),
      "newest run per model must never be planned for deletion",
    );
    assert.ok(!plan.deletions.some((d) => d.path.includes("latest--")));
    assert.equal(plan.budgetUnmet, true, "an unmeetable budget is reported, not forced");
    assert.ok(warnings.some((line) => line.includes("retention floor")));
    // After the REAL prune the newest run + latest pointers are intact on disk.
    for (const survivor of [
      path.join(root, "artifacts", "manifests", "gfs", "latest--conus.json"),
      path.join(root, "artifacts", "manifests", "gfs", "latest--na.json"),
      path.join(root, "artifacts", "manifests", "gfs", "20260702-0600Z--conus.json"),
      path.join(root, "artifacts", "manifests", "gfs", "20260702-0600Z--na.json"),
      path.join(root, "artifacts", "tiles", "gfs", "20260702-0600Z"),
      path.join(root, "raw-noaa", "selected-grib-v2", "gfs", "20260702", "06", "sel.grib2"),
    ]) {
      assert.ok(fs.existsSync(survivor), `${survivor} must survive a tiny-budget prune`);
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("raw walk ignores non-conforming entries and keeps the real latest raw run", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-prune-rawval-"));
  try {
    await buildCache(root);
    // Strays that must be ignored, not treated as runs (a non-date dir would
    // otherwise sort as "newest" and doom the real latest raw run).
    await touch(path.join(root, "raw-noaa", "selected-grib-v2", "gfs", "tmp-workdir", "junk.bin"));
    await touch(path.join(root, "raw-noaa", "selected-grib-v2", "gfs", "20260702", "README.txt"));
    await touch(path.join(root, "raw-noaa", "selected-grib-v2", "gfs", "stray.txt"));
    const plan = await planPrune(root, { keepRuns: 4 });
    const removedRaw = plan.deletions.filter((d) => d.kind === "raw").map((d) => d.path);
    // Still exactly the 5 older real runs — strays neither pruned nor counted.
    assert.equal(removedRaw.length, 5);
    assert.ok(
      !removedRaw.some((p) => p.includes(path.join("20260702", "06"))),
      "real latest raw run must not be planned for deletion",
    );
    for (const stray of ["tmp-workdir", "README.txt", "stray.txt"]) {
      assert.ok(!removedRaw.some((p) => p.includes(stray)), `stray ${stray} must never be pruned`);
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("planPrune with a tiny budget also deletes oldest kept runs to fit the ceiling", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-prune-budget-"));
  try {
    await buildCache(root);
    const budgetBytes = 3000; // far below the total; forces budget-driven deletion.
    const plan = await planPrune(root, { keepRuns: 4, budgetBytes });
    // With keepRuns=4 the retention floor alone already deletes 11 targets, so also
    // assert the budget spill actually appended kind:"budget" deletions from the kept set.
    assert.ok(
      plan.deletions.some((d) => d.kind === "budget"),
      "budget pressure must spill kept runs",
    );
    assert.ok(plan.projectedBytes <= budgetBytes || plan.deletions.length > 0);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

async function snapshotTree(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else files.push(path.relative(root, child));
    }
  }
  await walk(root);
  return files.sort();
}

function captureLogs() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  return { lines, restore: () => (console.log = original) };
}

test("runPrune --dry-run deletes nothing and prints the plan", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-prune-dry-"));
  try {
    await buildCache(root);
    const before = await snapshotTree(root);
    const logs = captureLogs();
    let plan;
    try {
      plan = await runPrune(root, { keepRuns: 4, dryRun: true });
    } finally {
      logs.restore();
    }
    const after = await snapshotTree(root);
    assert.deepEqual(after, before, "dry-run must not delete or create any file");
    assert.ok(plan.deletions.length > 0);
    const wouldDelete = logs.lines.filter((line) => line.startsWith("Would delete "));
    assert.equal(wouldDelete.length, plan.deletions.length, "each planned deletion is printed");
    assert.ok(logs.lines.some((line) => line.startsWith("Would reclaim ")));
    assert.ok(!logs.lines.some((line) => line.startsWith("Deleted ")));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("runPrune never touches protected sibling dirs, latest pointers, or unknown raw-noaa subdirs", async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-prune-protect-"));
  const root = path.join(tmp, "output", "noaa-beta-cache");
  try {
    await buildCache(root);
    // Protected siblings that must never be walked or deleted.
    await touch(path.join(tmp, "output", "noaa-benchmarks", "bench.json"));
    await touch(path.join(tmp, "output", "noaa-debug", "debug.log"));
    await touch(path.join(tmp, "output", "noaa-beta-tools", "tool.js"));
    // Unknown sibling under raw-noaa must not be enumerated as prunable.
    await touch(path.join(root, "raw-noaa", "unrelated-cache", "gfs", "20260101", "00", "keep.bin"));
    const logs = captureLogs();
    let plan;
    try {
      plan = await runPrune(root, { keepRuns: 4, dryRun: false });
    } finally {
      logs.restore();
    }
    assert.ok(!plan.deletions.some((d) => d.path.includes("noaa-benchmarks")));
    assert.ok(!plan.deletions.some((d) => d.path.includes("noaa-debug")));
    assert.ok(!plan.deletions.some((d) => d.path.includes("noaa-beta-tools")));
    assert.ok(!plan.deletions.some((d) => d.path.includes("unrelated-cache")));
    for (const protectedFile of [
      path.join(tmp, "output", "noaa-benchmarks", "bench.json"),
      path.join(tmp, "output", "noaa-debug", "debug.log"),
      path.join(tmp, "output", "noaa-beta-tools", "tool.js"),
      path.join(root, "raw-noaa", "unrelated-cache", "gfs", "20260101", "00", "keep.bin"),
      path.join(root, "artifacts", "manifests", "gfs", "latest--conus.json"),
      path.join(root, "artifacts", "manifests", "gfs", "latest--na.json"),
    ]) {
      assert.ok(fs.existsSync(protectedFile), `${protectedFile} must survive a real prune`);
    }
    // Kept runs (newest 4) survive; pruned runs (oldest 2) are gone.
    for (const kept of ["20260701-1200Z", "20260701-1800Z", "20260702-0000Z", "20260702-0600Z"]) {
      assert.ok(fs.existsSync(path.join(root, "artifacts", "manifests", "gfs", `${kept}--conus.json`)));
      assert.ok(fs.existsSync(path.join(root, "artifacts", "tiles", "gfs", kept)));
    }
    for (const pruned of ["20260701-0000Z", "20260701-0600Z"]) {
      assert.ok(!fs.existsSync(path.join(root, "artifacts", "manifests", "gfs", `${pruned}--conus.json`)));
      assert.ok(!fs.existsSync(path.join(root, "artifacts", "tiles", "gfs", pruned)));
    }
    // Raw: only newest run's grib remains.
    assert.ok(fs.existsSync(path.join(root, "raw-noaa", "selected-grib-v2", "gfs", "20260702", "06", "sel.grib2")));
    assert.ok(!fs.existsSync(path.join(root, "raw-noaa", "selected-grib-v2", "gfs", "20260702", "00")));
    assert.ok(!fs.existsSync(path.join(root, "raw-noaa", "selected-grib-v2", "gfs", "20260701", "00")));
    assert.ok(!fs.existsSync(path.join(root, "raw-noaa", "selected-grib-v2", "gfs", "20260701", "06")));
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

test("--budget-gb on the CLI overrides MODELVIEW_CACHE_BUDGET_GB from the environment", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-prune-cli-"));
  try {
    await buildCache(root);
    // Tiny env budget (~107 bytes) that would force a spill if it won.
    const env = { ...process.env, MODELVIEW_CACHE_BUDGET_GB: "0.0000001" };
    const envOnly = await execFileAsync(process.execPath, [SCRIPT, "--dry-run", `--cache-root=${root}`], { env });
    assert.ok(envOnly.stdout.includes("Would delete budget "), "env budget alone must trigger a spill");
    const cliWins = await execFileAsync(
      process.execPath,
      [SCRIPT, "--dry-run", `--cache-root=${root}`, "--budget-gb=1000"],
      { env },
    );
    assert.ok(!cliWins.stdout.includes("Would delete budget "), "--budget-gb must override the env budget");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("unknown flags fail closed: non-zero exit and nothing deleted", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-prune-flags-"));
  try {
    await buildCache(root);
    const before = await snapshotTree(root);
    let failed = false;
    try {
      // Typo'd --dry-run must abort, not escalate to a real prune.
      await execFileAsync(process.execPath, [SCRIPT, "--dryrun", `--cache-root=${root}`]);
    } catch (error) {
      failed = true;
      assert.notEqual(error.code, 0);
      assert.ok(String(error.stderr).includes('Unknown flag "--dryrun"'));
    }
    assert.ok(failed, "unknown flag must exit non-zero");
    assert.deepEqual(await snapshotTree(root), before, "unknown flag must not delete or create any file");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("parseArgs accepts the known flag surface and rejects everything else", () => {
  const parsed = parseArgs(["--dry-run", "--keep=3", "--budget-gb=2", "--cache-root=/tmp/x", "--models=gfs,hrrr"]);
  assert.deepEqual(parsed, {
    "dry-run": true,
    keep: "3",
    "budget-gb": "2",
    "cache-root": "/tmp/x",
    models: "gfs,hrrr",
  });
  assert.throws(() => parseArgs(["--dryrun"]), /Unknown flag "--dryrun"/);
  assert.throws(() => parseArgs(["--budget=2"]), /Unknown flag "--budget"/);
  assert.throws(() => parseArgs(["-dry-run"]), /Unknown argument "-dry-run"/);
  assert.throws(() => parseArgs(["prune"]), /Unknown argument "prune"/);
});
