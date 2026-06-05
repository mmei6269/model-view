#!/usr/bin/env node

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const BUILD_SCRIPT = path.join(ROOT_DIR, "scripts/build-noaa-beta-artifacts.js");
const DEFAULT_MODELS = "gfs,nam,nam3km,hrrr";
const DEFAULT_VIEW = "conus";
const DEFAULT_TOTAL_FRAME_CONCURRENCY = 24;
const DEFAULT_GLOBAL_FRAME_CONCURRENCY = 48;
const DEFAULT_WORKER_COUNT = 18;
const DEFAULT_RANGE_CONCURRENCY = 3;
const DEFAULT_DECODE_CONCURRENCY = 2;

function main() {
  const { runCount, passthroughArgs } = parseWrapperArgs(process.argv.slice(2));
  if (hasOption(passthroughArgs, ["date"]) || hasOption(passthroughArgs, ["cycle"])) {
    throw new Error("Recent-run full renders resolve date/cycle automatically; remove --date/--cycle.");
  }
  if (hasOption(passthroughArgs, ["run-offset"])) {
    throw new Error("Recent-run full renders manage --run-offset internally.");
  }

  const baseArgs = buildBaseArgs(passthroughArgs);
  const offsets = Array.from({ length: runCount }, (_, index) => runCount - index - 1);
  for (const [index, offset] of offsets.entries()) {
    const buildArgs = [BUILD_SCRIPT, ...baseArgs, `--run-offset=${offset}`];
    console.log(`[noaa-beta] recent full render ${index + 1}/${runCount} run-offset=${offset}`);
    const result = spawnSync(process.execPath, buildArgs, {
      cwd: ROOT_DIR,
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.signal) {
      throw new Error(`NOAA recent full render stopped by signal ${result.signal}.`);
    }
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }
}

function parseWrapperArgs(argv) {
  const passthroughArgs = [];
  let runCount = 2;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const parsed = parseOptionToken(token);
    if (parsed && ["runs", "latest-runs", "recent-runs"].includes(parsed.name)) {
      const value = parsed.hasInlineValue ? parsed.value : argv[index + 1];
      runCount = clampRunCount(value);
      if (!parsed.hasInlineValue) {
        index += 1;
      }
      continue;
    }
    passthroughArgs.push(token);
  }
  return { runCount, passthroughArgs };
}

function buildBaseArgs(passthroughArgs) {
  const args = [];
  pushDefaultArg(args, passthroughArgs, ["models", "model"], `--models=${DEFAULT_MODELS}`);
  pushDefaultArg(args, passthroughArgs, ["view"], `--view=${DEFAULT_VIEW}`);
  pushDefaultArg(args, passthroughArgs, ["full-run", "full", "hours"], "--full-run");
  pushDefaultArg(args, passthroughArgs, ["force"], "--force");
  pushDefaultArg(args, passthroughArgs, ["profile", "profile-frames"], "--profile");
  pushDefaultArg(args, passthroughArgs, ["global-frame-queue"], "--global-frame-queue=true");
  pushDefaultArg(
    args,
    passthroughArgs,
    ["total-frame-concurrency"],
    `--total-frame-concurrency=${DEFAULT_TOTAL_FRAME_CONCURRENCY}`,
  );
  pushDefaultArg(
    args,
    passthroughArgs,
    ["global-frame-concurrency"],
    `--global-frame-concurrency=${DEFAULT_GLOBAL_FRAME_CONCURRENCY}`,
  );
  pushDefaultArg(args, passthroughArgs, ["worker-count"], `--worker-count=${DEFAULT_WORKER_COUNT}`);
  pushDefaultArg(args, passthroughArgs, ["range-concurrency"], `--range-concurrency=${DEFAULT_RANGE_CONCURRENCY}`);
  pushDefaultArg(args, passthroughArgs, ["decode-concurrency"], `--decode-concurrency=${DEFAULT_DECODE_CONCURRENCY}`);
  pushDefaultArg(args, passthroughArgs, ["global-persist-queue"], "--global-persist-queue=false");
  pushDefaultArg(args, passthroughArgs, ["persist-manifest-each-frame"], "--persist-manifest-each-frame=false");
  return [...args, ...passthroughArgs];
}

function pushDefaultArg(args, passthroughArgs, names, value) {
  if (!hasOption(passthroughArgs, names)) {
    args.push(value);
  }
}

function hasOption(argv, names) {
  const set = new Set(names);
  for (const token of argv) {
    const parsed = parseOptionToken(token);
    if (parsed && set.has(parsed.name)) {
      return true;
    }
  }
  return false;
}

function parseOptionToken(token) {
  if (!String(token || "").startsWith("--")) {
    return null;
  }
  const trimmed = token.slice(2);
  const eq = trimmed.indexOf("=");
  if (eq >= 0) {
    return {
      name: trimmed.slice(0, eq),
      value: trimmed.slice(eq + 1),
      hasInlineValue: true,
    };
  }
  return {
    name: trimmed,
    value: null,
    hasInlineValue: false,
  };
}

function clampRunCount(value) {
  const num = Math.round(Number(value));
  return Number.isFinite(num) ? Math.max(1, Math.min(6, num)) : 2;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
