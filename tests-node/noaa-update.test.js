"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildUpdateArgs, DEFAULT_MODELS, main } = require("../scripts/noaa-update");

test("default update targets all models, full-run, latest (no force, no run-offset)", () => {
  const args = buildUpdateArgs({});
  assert.ok(args.includes(`--models=${DEFAULT_MODELS}`));
  assert.ok(args.includes("--full-run"));
  assert.ok(!args.some((a) => a === "--force" || a.startsWith("--force")), "update must never force a rebuild");
  assert.ok(!args.some((a) => a.startsWith("--run-offset")), "update resolves the latest run (offset 0)");
  assert.ok(!args.some((a) => a.startsWith("--date") || a.startsWith("--cycle")));
});

test("--models filter is passed through", () => {
  const args = buildUpdateArgs({ models: "hrrr,nam3km" });
  assert.ok(args.includes("--models=hrrr,nam3km"));
});

test("main spawns build-noaa-beta-artifacts.js (no --force) then prunes", async () => {
  const calls = [];
  let spawnedArgv = null;
  let pruneOptions = null;
  await main([], {
    spawnSync: (execPath, argv) => {
      calls.push("build");
      spawnedArgv = argv;
      return { status: 0 };
    },
    runPrune: async (cacheRoot, options) => {
      calls.push("prune");
      pruneOptions = options;
      return { deletions: [], removedBytes: 0, budgetUnmet: false };
    },
  });
  assert.deepEqual(calls, ["build", "prune"], "prune must run after the build");
  assert.ok(String(spawnedArgv[0]).endsWith("build-noaa-beta-artifacts.js"));
  const buildArgs = spawnedArgv.slice(1);
  assert.ok(buildArgs.includes(`--models=${DEFAULT_MODELS}`));
  assert.ok(buildArgs.includes("--full-run"));
  assert.ok(!buildArgs.some((a) => a === "--force" || a.startsWith("--force")), "spawned build must never force");
  assert.ok(!buildArgs.some((a) => a.startsWith("--run-offset")));
  assert.equal(pruneOptions.dryRun, false);
  assert.equal(pruneOptions.keepRuns, 4);
});

test("main honors --models filter for both build and prune; --no-prune skips prune", async () => {
  const calls = [];
  let spawnedArgv = null;
  let pruneModels = null;
  await main(["--models=hrrr,nam3km"], {
    spawnSync: (execPath, argv) => {
      calls.push("build");
      spawnedArgv = argv;
      return { status: 0 };
    },
    runPrune: async (cacheRoot, options) => {
      calls.push("prune");
      pruneModels = options.models;
      return { deletions: [], removedBytes: 0, budgetUnmet: false };
    },
  });
  assert.ok(spawnedArgv.slice(1).includes("--models=hrrr,nam3km"));
  assert.deepEqual(pruneModels, ["hrrr", "nam3km"]);

  const noPruneCalls = [];
  await main(["--no-prune"], {
    spawnSync: () => {
      noPruneCalls.push("build");
      return { status: 0 };
    },
    runPrune: async () => {
      noPruneCalls.push("prune");
      return { deletions: [], removedBytes: 0, budgetUnmet: false };
    },
  });
  assert.deepEqual(noPruneCalls, ["build"], "--no-prune must skip the prune step");
});
