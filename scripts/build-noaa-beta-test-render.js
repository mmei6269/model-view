#!/usr/bin/env node

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");
const { buildFullHoursForModel, resolveModels } = require("./build-noaa-beta-artifacts");

const ROOT_DIR = path.resolve(__dirname, "..");
const BUILD_SCRIPT = path.join(ROOT_DIR, "scripts/build-noaa-beta-artifacts.js");
const DEFAULT_MODELS = "gfs,nam,nam3km,hrrr";
const DEFAULT_VIEW = "conus";
const DEFAULT_FRAME_COUNT = 18;
const DEFAULT_TOTAL_FRAME_CONCURRENCY = 24;
const DEFAULT_GLOBAL_FRAME_CONCURRENCY = 48;
const DEFAULT_WORKER_COUNT = 18;
const DEFAULT_RANGE_CONCURRENCY = 3;
const DEFAULT_DECODE_CONCURRENCY = 2;

function main() {
  const { frameCount, passthroughArgs } = parseWrapperArgs(process.argv.slice(2));
  rejectManagedHours(passthroughArgs);

  const models = resolveModels(optionValue(passthroughArgs, ["models", "model"]) || DEFAULT_MODELS);
  const buildArgs = buildBaseArgs(passthroughArgs, models, frameCount);
  console.log(
    `[noaa-beta] test render frames=${frameCount} models=${models.join(",")} hours=${models
      .map((modelKey) => `${modelKey}:${firstForecastHours(modelKey, frameCount).join(",")}`)
      .join(" ")}`,
  );
  const result = spawnSync(process.execPath, [BUILD_SCRIPT, ...buildArgs], {
    cwd: ROOT_DIR,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`NOAA test render stopped by signal ${result.signal}.`);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function parseWrapperArgs(argv) {
  const passthroughArgs = [];
  let frameCount = DEFAULT_FRAME_COUNT;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const parsed = parseOptionToken(token);
    if (parsed && ["frames", "frame-count", "test-frames"].includes(parsed.name)) {
      const value = parsed.hasInlineValue ? parsed.value : argv[index + 1];
      frameCount = clampFrameCount(value);
      if (!parsed.hasInlineValue) {
        index += 1;
      }
      continue;
    }
    passthroughArgs.push(token);
  }
  return { frameCount, passthroughArgs };
}

function buildBaseArgs(passthroughArgs, models, frameCount) {
  const args = [];
  pushDefaultArg(args, passthroughArgs, ["models", "model"], `--models=${models.join(",")}`);
  pushDefaultArg(args, passthroughArgs, ["view"], `--view=${DEFAULT_VIEW}`);
  for (const modelKey of models) {
    args.push(`--hours-${modelKey}=${firstForecastHours(modelKey, frameCount).join(",")}`);
  }
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

function rejectManagedHours(passthroughArgs) {
  for (const token of passthroughArgs) {
    const parsed = parseOptionToken(token);
    if (
      parsed &&
      (parsed.name === "hours" ||
        parsed.name.startsWith("hours-") ||
        parsed.name === "full-run" ||
        parsed.name === "full")
    ) {
      throw new Error(
        "NOAA test renders manage forecast hours internally; remove --hours/--hours-* or --full/--full-run.",
      );
    }
  }
}

function firstForecastHours(modelKey, frameCount) {
  return buildFullHoursForModel(modelKey).slice(0, frameCount);
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

function optionValue(argv, names) {
  const set = new Set(names);
  for (let index = 0; index < argv.length; index += 1) {
    const parsed = parseOptionToken(argv[index]);
    if (!parsed || !set.has(parsed.name)) {
      continue;
    }
    if (parsed.hasInlineValue) {
      return parsed.value;
    }
    return argv[index + 1];
  }
  return null;
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

function clampFrameCount(value) {
  const num = Math.round(Number(value));
  return Number.isFinite(num) ? Math.max(1, Math.min(64, num)) : DEFAULT_FRAME_COUNT;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
