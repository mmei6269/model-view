#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { loadDotEnv, resolveCacheRootEnv } = require("./lib/env-config");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_KEEP_RUNS = 4;
// Raw GRIB inputs are only needed to (re)build the newest run; older raw runs are
// disposable regardless of how many rendered runs we retain for the run selector.
const RAW_KEEP_RUNS = 1;
const RUN_ID_PATTERN = /^(\d{8})-(\d{2})\d{2}Z$/;

// Raw subdirs are all keyed <subdir>/<model>/<YYYYMMDD>/<HH>/... so a runId maps
// cleanly to date=YYYYMMDD, cycle=HH. Enumerated so an unknown sibling dir under
// raw-noaa is never walked/deleted by accident. Verified against
// scripts/lib/noaa-beta/{winter,accumulation}.js.
const RAW_SUBDIRS = Object.freeze([
  "selected-grib-v2",
  "idx",
  "derived-profile-grids",
  "precip-accum-grids",
  "run-max-source-grids",
  "run-max-cumulative-grids",
  "snow-liquid-grids",
  "snowfall-cumulative-grids",
  "snowfall-delta-grids",
  "freezing-rain-liquid-grids",
]);

function parseRunId(run) {
  const match = RUN_ID_PATTERN.exec(String(run || ""));
  return match ? { date: match[1], cycle: match[2] } : null;
}

async function pathExists(p) {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function dirSize(target) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    if (error?.code === "ENOTDIR") {
      const stat = await fs.promises.stat(target);
      return stat.size;
    }
    throw error;
  }
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    total += entry.isDirectory() ? await dirSize(child) : (await fs.promises.stat(child)).size;
  }
  return total;
}

async function listModelDirs(baseDir) {
  if (!(await pathExists(baseDir))) return [];
  return (await fs.promises.readdir(baseDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

// Newest-first sorted list of built run ids for a model (from the manifests dir,
// which is the authoritative catalog of built runs across all views).
async function listRunIdsForModel(manifestsModelDir) {
  if (!(await pathExists(manifestsModelDir))) return [];
  const runIds = new Set();
  for (const entry of await fs.promises.readdir(manifestsModelDir)) {
    if (entry.startsWith("latest--")) continue;
    const stem = entry.replace(/--[^-]+\.json$/, "");
    if (parseRunId(stem)) runIds.add(stem);
  }
  return Array.from(runIds).sort().reverse();
}

// Build the ordered deletion plan. Retention floor first (keep newest keepRuns of
// rendered artifacts, newest RAW_KEEP_RUNS of raw inputs), then — if budgetBytes
// is set and the projected total still exceeds it — extend deletions into the
// kept set OLDEST-FIRST until under budget. Deletions are ordered oldest-first so
// the budget pass is a stable prefix extension. `latest--*.json` is never listed.
async function planPrune(cacheRoot, { keepRuns = DEFAULT_KEEP_RUNS, budgetBytes = null, models = null } = {}) {
  const artifactRoot = path.join(cacheRoot, "artifacts");
  const manifestsRoot = path.join(artifactRoot, "manifests");
  const tilesRoot = path.join(artifactRoot, "tiles");
  const rawRoot = path.join(cacheRoot, "raw-noaa");
  const modelFilter = Array.isArray(models) && models.length > 0 ? new Set(models) : null;

  const retention = []; // { path, bytes, runId, kind } — always-delete (below floor)
  const spillable = []; // kept runs, oldest-first, eligible for budget-driven deletion

  const modelDirs = await listModelDirs(manifestsRoot);
  for (const model of modelDirs) {
    if (modelFilter && !modelFilter.has(model)) continue;
    const runIds = await listRunIdsForModel(path.join(manifestsRoot, model)); // newest-first
    const keep = new Set(runIds.slice(0, keepRuns));
    // Rendered artifacts: manifests + tiles for runs beyond the keep window.
    for (const runId of runIds) {
      const manifestFiles = (await fs.promises.readdir(path.join(manifestsRoot, model))).filter(
        (f) => f.startsWith(`${runId}--`) && !f.startsWith("latest--"),
      );
      const tilesDir = path.join(tilesRoot, model, runId);
      const runEntry = {
        runId,
        model,
        // The newest built run per model is the retention floor: it is what the
        // latest--<view>.json pointers reference, so the budget pass must never
        // spill it no matter how small the budget is.
        newestForModel: runId === runIds[0],
        paths: [
          ...manifestFiles.map((f) => path.join(manifestsRoot, model, f)),
          ...((await pathExists(tilesDir)) ? [tilesDir] : []),
        ],
      };
      runEntry.bytes = 0;
      for (const p of runEntry.paths) runEntry.bytes += await dirSize(p);
      if (!keep.has(runId)) {
        for (const p of runEntry.paths)
          retention.push({ path: p, bytes: await dirSize(p), runId, model, kind: "artifact" });
      } else {
        spillable.push(runEntry);
      }
    }
  }

  // Raw inputs: keep only the newest RAW_KEEP_RUNS run per model.
  for (const subdir of RAW_SUBDIRS) {
    const subdirRoot = path.join(rawRoot, subdir);
    for (const model of await listModelDirs(subdirRoot)) {
      if (modelFilter && !modelFilter.has(model)) continue;
      const modelDir = path.join(subdirRoot, model);
      const rawRuns = [];
      // Only <YYYYMMDD>/<HH> directory pairs are runs. Anything non-conforming
      // (stray files, tmp dirs, oddly named entries) is skipped entirely: it is
      // never pruned and never sorts as "newest" — fail toward keeping.
      for (const dateEntry of await fs.promises.readdir(modelDir, { withFileTypes: true })) {
        if (!dateEntry.isDirectory() || !/^\d{8}$/.test(dateEntry.name)) continue;
        const dateDir = path.join(modelDir, dateEntry.name);
        for (const cycleEntry of await fs.promises.readdir(dateDir, { withFileTypes: true })) {
          if (!cycleEntry.isDirectory() || !/^\d{2}$/.test(cycleEntry.name)) continue;
          rawRuns.push({
            runKey: `${dateEntry.name}-${cycleEntry.name}`,
            path: path.join(dateDir, cycleEntry.name),
          });
        }
      }
      rawRuns.sort((a, b) => a.runKey.localeCompare(b.runKey)).reverse(); // newest-first
      for (const raw of rawRuns.slice(RAW_KEEP_RUNS)) {
        retention.push({ path: raw.path, bytes: await dirSize(raw.path), runId: raw.runKey, model, kind: "raw" });
      }
    }
  }

  const deletions = retention.slice();
  let removedBytes = deletions.reduce((sum, d) => sum + d.bytes, 0);

  let projectedBytes = (await dirSize(cacheRoot)) - removedBytes;
  let budgetUnmet = false;
  if (Number.isFinite(budgetBytes) && budgetBytes !== null && projectedBytes > budgetBytes) {
    // Spill oldest kept runs first until under budget (or nothing left to spill).
    // Retention floor: the newest run per model is NEVER spilled — a budget
    // smaller than the floor stops here rather than delete the run that the
    // latest--*.json pointers reference.
    spillable.sort((a, b) => a.runId.localeCompare(b.runId)); // oldest-first
    for (const run of spillable) {
      if (projectedBytes <= budgetBytes) break;
      if (run.newestForModel) continue;
      for (const p of run.paths) {
        deletions.push({ path: p, bytes: await dirSize(p), runId: run.runId, model: run.model, kind: "budget" });
      }
      projectedBytes -= run.bytes;
    }
    budgetUnmet = projectedBytes > budgetBytes;
  }

  return { deletions, projectedBytes, budgetUnmet, removedBytes: deletions.reduce((s, d) => s + d.bytes, 0) };
}

async function runPrune(cacheRoot, options) {
  const plan = await planPrune(cacheRoot, options);
  for (const deletion of plan.deletions) {
    if (options.dryRun) {
      console.log(`Would delete ${deletion.kind} ${deletion.path} (${formatBytes(deletion.bytes)})`);
    } else {
      await fs.promises.rm(deletion.path, { recursive: true, force: true });
      console.log(`Deleted ${deletion.kind} ${deletion.path} (${formatBytes(deletion.bytes)})`);
    }
  }
  console.log(
    `${options.dryRun ? "Would reclaim" : "Reclaimed"} ${formatBytes(plan.removedBytes)} across ${plan.deletions.length} target(s).`,
  );
  if (plan.budgetUnmet) {
    console.warn(
      "Warning: budget cannot be met without deleting the newest run per model; retention floor kept intact.",
    );
  }
  return plan;
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// The full CLI surface. parseArgs fails closed: any token that is not one of
// these flags aborts the run, so a typo (e.g. --dryrun) can never silently
// escalate a dry run into a real prune.
const KNOWN_FLAGS = Object.freeze(["dry-run", "keep", "budget-gb", "cache-root", "models"]);

function parseArgs(argv) {
  const args = {};
  const usage = `Known flags: ${KNOWN_FLAGS.map((f) => `--${f}`).join(", ")}`;
  for (const token of argv) {
    const str = String(token);
    if (!str.startsWith("--")) {
      throw new Error(`Unknown argument "${str}". ${usage}`);
    }
    const trimmed = str.slice(2);
    const eq = trimmed.indexOf("=");
    const name = eq >= 0 ? trimmed.slice(0, eq) : trimmed;
    if (!KNOWN_FLAGS.includes(name)) {
      throw new Error(`Unknown flag "--${name}". ${usage}`);
    }
    if (eq >= 0) args[name] = trimmed.slice(eq + 1);
    else args[name] = true;
  }
  return args;
}

async function main() {
  loadDotEnv(path.join(ROOT_DIR, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const cacheRoot = path.resolve(
    ROOT_DIR,
    String(args["cache-root"] || resolveCacheRootEnv() || "output/noaa-beta-cache"),
  );
  const keepRuns = Number.isFinite(Number(args.keep)) ? Math.max(1, Number(args.keep)) : DEFAULT_KEEP_RUNS;
  // CLI wins over the environment (repo convention): an explicit --budget-gb
  // overrides a persistent MODELVIEW_CACHE_BUDGET_GB from .env.
  const budgetGb = Number(args["budget-gb"] || process.env.MODELVIEW_CACHE_BUDGET_GB || 0);
  const budgetBytes = Number.isFinite(budgetGb) && budgetGb > 0 ? budgetGb * 1024 ** 3 : null;
  const models =
    typeof args.models === "string"
      ? args.models
          .split(",")
          .map((m) => m.trim().toLowerCase())
          .filter(Boolean)
      : null;
  await runPrune(cacheRoot, { keepRuns, budgetBytes, models, dryRun: Boolean(args["dry-run"]) });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = { planPrune, runPrune, parseArgs, RAW_SUBDIRS, KNOWN_FLAGS };
