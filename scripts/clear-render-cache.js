#!/usr/bin/env node

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");
const DEFAULT_TARGETS = [
  {
    label: "NOAA beta artifact cache",
    path: path.join(OUTPUT_DIR, "noaa-beta-cache"),
  },
];
const OPTIONAL_TARGETS = [
  {
    flag: "include-tools",
    label: "NOAA beta tools",
    path: path.join(OUTPUT_DIR, "noaa-beta-tools"),
  },
];
const NOAA_TEMP_PREFIXES = [
  "noaa-gfs-",
  "noaa-nam-",
  "noaa-nam3km-",
  "noaa-hrrr-",
  "noaa-selected-",
  "weather-app-noaa-",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = hasFlag(args, "dry-run");
  const includeTemp = !hasFlag(args, "no-temp");
  const includeNoaa = !hasFlag(args, "no-noaa");
  const targets = [];
  if (includeNoaa) {
    targets.push(DEFAULT_TARGETS[0]);
  }
  for (const target of OPTIONAL_TARGETS) {
    if (hasFlag(args, target.flag)) {
      targets.push(target);
    }
  }
  if (includeTemp) {
    targets.push(...(await findNoaaTempTargets()));
  }
  if (targets.length === 0) {
    console.log("No cache targets selected.");
    return;
  }
  for (const target of targets) {
    await removeTarget(target, { dryRun });
  }
}

async function findNoaaTempTargets() {
  const tempRoot = os.tmpdir();
  let entries;
  try {
    entries = await fs.promises.readdir(tempRoot, { withFileTypes: true });
  } catch (error) {
    console.warn(`Could not list temp directory ${tempRoot}: ${error?.message || error}`);
    return [];
  }
  return entries
    .filter((entry) => NOAA_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => ({
      label: "NOAA temp work item",
      path: path.join(tempRoot, entry.name),
    }));
}

async function removeTarget(target, { dryRun }) {
  const exists = await pathExists(target.path);
  const action = dryRun ? "Would clear" : "Cleared";
  if (!exists) {
    console.log(`${action} ${target.label}: ${target.path} (not present)`);
    return;
  }
  if (!dryRun) {
    await fs.promises.rm(target.path, { recursive: true, force: true });
  }
  console.log(`${action} ${target.label}: ${target.path}`);
}

async function pathExists(targetPath) {
  try {
    await fs.promises.lstat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseArgs(argv) {
  const flags = new Set();
  for (const token of argv) {
    if (!String(token || "").startsWith("--")) {
      continue;
    }
    flags.add(String(token).slice(2));
  }
  return flags;
}

function hasFlag(flags, name) {
  return flags.has(name);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
