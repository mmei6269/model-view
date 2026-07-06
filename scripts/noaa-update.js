#!/usr/bin/env node

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { loadDotEnv, resolveCacheRootEnv } = require("./lib/env-config");
const { runPrune } = require("./prune-render-cache");

const ROOT_DIR = path.resolve(__dirname, "..");
const BUILD_SCRIPT = path.join(ROOT_DIR, "scripts/build-noaa-beta-artifacts.js");
const DEFAULT_MODELS = "gfs,nam,nam3km,hrrr";
const DEFAULT_VIEW = "conus";

// Latest run, build only missing frames: NO --force (the builder's .complete.json
// resume + isFrameCompleteForState skip already-built frames), NO --run-offset
// (default 0 = latest run per resolveNoaaModelRun). --full-run so the whole
// forecast horizon is targeted.
function buildUpdateArgs({ models, view } = {}) {
  const args = [`--models=${models || DEFAULT_MODELS}`, `--view=${view || DEFAULT_VIEW}`, "--full-run"];
  return args;
}

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (!String(token).startsWith("--")) continue;
    const trimmed = token.slice(2);
    const eq = trimmed.indexOf("=");
    if (eq >= 0) args[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    else args[trimmed] = true;
  }
  return args;
}

// deps ({ spawnSync, runPrune }) exists so tests can capture the spawned argv and
// prune invocation without running a real build or touching the cache.
async function main(argv = process.argv.slice(2), deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  const prune = deps.runPrune || runPrune;
  loadDotEnv(path.join(ROOT_DIR, ".env"));
  const args = parseArgs(argv);
  const models = typeof args.models === "string" ? args.models : undefined;
  const buildArgs = buildUpdateArgs({ models, view: typeof args.view === "string" ? args.view : undefined });
  console.log(`[noaa:update] resolving latest runs + building missing frames: ${buildArgs.join(" ")}`);
  const result = spawn(process.execPath, [BUILD_SCRIPT, ...buildArgs], { cwd: ROOT_DIR, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);

  if (args["no-prune"]) {
    console.log("[noaa:update] skipping prune (--no-prune).");
    return;
  }
  const cacheRoot = path.resolve(ROOT_DIR, String(resolveCacheRootEnv() || "output/noaa-beta-cache"));
  console.log("[noaa:update] pruning stale runs...");
  await prune(cacheRoot, {
    keepRuns: 4,
    budgetBytes:
      Number(process.env.MODELVIEW_CACHE_BUDGET_GB) > 0
        ? Number(process.env.MODELVIEW_CACHE_BUDGET_GB) * 1024 ** 3
        : null,
    models: models
      ? models
          .split(",")
          .map((m) => m.trim().toLowerCase())
          .filter(Boolean)
      : null,
    dryRun: false,
  });
  console.log("[noaa:update] done.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = { buildUpdateArgs, DEFAULT_MODELS, main };
