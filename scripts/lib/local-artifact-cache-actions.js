"use strict";

// In-process cache management for the /actions/cache-* control surface.
// Pure filesystem work only: HTTP guards (method, origin, active-job 409s)
// stay in local-artifact-server.js so every mutation route shares one gate.

const fs = require("fs");
const path = require("path");
const { planPrune, runPrune, dirSize } = require("../prune-render-cache");

const RUN_ID_PATTERN = /^(\d{8})-(\d{2})\d{2}Z$/;

async function listDirs(target) {
  try {
    return (await fs.promises.readdir(target, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

// One directory level of sizes in a single walk: total plus per-child bytes.
// Entries deleted between readdir and stat size as 0 (builders rename temp
// files while stats scans run; the walk must never fail on a vanished entry).
async function dirSizeWithChildren(target) {
  let entries;
  try {
    entries = await fs.promises.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { total: 0, children: new Map() };
    }
    throw error;
  }
  let total = 0;
  const children = new Map();
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    const bytes = entry.isDirectory() ? await dirSize(child) : await statSizeSafe(child);
    children.set(entry.name, bytes);
    total += bytes;
  }
  return { total, children };
}

async function statSizeSafe(target) {
  try {
    return (await fs.promises.stat(target)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

// Walk the cache once and report totals plus a per-model, per-run breakdown.
// Run bytes cover rendered artifacts (manifests + tiles); raw GRIB inputs are
// keyed by date/cycle across many subdirs, so they report as one aggregate.
async function computeCacheStats(cacheRoot) {
  const artifactRoot = path.join(cacheRoot, "artifacts");
  const manifestsRoot = path.join(artifactRoot, "manifests");
  const tilesRoot = path.join(artifactRoot, "tiles");

  const models = [];
  let manifestsBytes = 0;
  let tilesBytes = 0;
  const modelNames = new Set([...(await listDirs(manifestsRoot)), ...(await listDirs(tilesRoot))]);
  for (const model of Array.from(modelNames).sort()) {
    const manifestsDir = path.join(manifestsRoot, model);
    let manifestEntries = [];
    try {
      manifestEntries = await fs.promises.readdir(manifestsDir);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    const manifestBytesByRun = new Map();
    for (const name of manifestEntries) {
      const bytes = await dirSize(path.join(manifestsDir, name));
      manifestsBytes += bytes;
      if (name.startsWith("latest--")) {
        continue;
      }
      const stem = name.replace(/--[^-]+\.json$/, "");
      if (RUN_ID_PATTERN.test(stem)) {
        manifestBytesByRun.set(stem, (manifestBytesByRun.get(stem) || 0) + bytes);
      }
    }
    const tiles = await dirSizeWithChildren(path.join(tilesRoot, model));
    tilesBytes += tiles.total;
    const runIds = new Set([...manifestBytesByRun.keys()]);
    for (const name of tiles.children.keys()) {
      if (RUN_ID_PATTERN.test(name)) {
        runIds.add(name);
      }
    }
    const ordered = Array.from(runIds).sort().reverse(); // run ids sort lexicographically = chronologically
    const runs = ordered.map((runId, index) => ({
      runId,
      bytes: (manifestBytesByRun.get(runId) || 0) + (tiles.children.get(runId) || 0),
      latest: index === 0,
    }));
    if (runs.length > 0 || tiles.total > 0) {
      models.push({
        model,
        totalBytes: runs.reduce((sum, run) => sum + run.bytes, 0),
        runs,
      });
    }
  }

  // Stray artifacts outside manifests/tiles (none today, but never undercount).
  let artifactsBytes = manifestsBytes + tilesBytes;
  for (const entry of await listDirs(artifactRoot)) {
    if (entry !== "manifests" && entry !== "tiles") {
      artifactsBytes += await dirSize(path.join(artifactRoot, entry));
    }
  }
  const rawBytes = await dirSize(path.join(cacheRoot, "raw-noaa"));
  let totalBytes = artifactsBytes + rawBytes;
  let topLevel = [];
  try {
    topLevel = await fs.promises.readdir(cacheRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  for (const entry of topLevel) {
    if (entry.name === "artifacts" || entry.name === "raw-noaa") {
      continue;
    }
    const target = path.join(cacheRoot, entry.name);
    totalBytes += entry.isDirectory() ? await dirSize(target) : await statSizeSafe(target);
  }

  return {
    cacheRoot,
    computedAt: new Date().toISOString(),
    totalBytes,
    artifactsBytes,
    rawBytes,
    models,
  };
}

// Retention-aware prune (planPrune/runPrune keep the newest run per model and
// the latest pointers no matter what). Deletion paths are reported relative to
// cacheRoot so the client never renders machine-absolute paths.
async function executeCachePrune(cacheRoot, { dryRun = true, keepRuns = 4, budgetBytes = null } = {}) {
  const options = { keepRuns, budgetBytes, models: null, dryRun };
  const plan = dryRun ? await planPrune(cacheRoot, options) : await runPrune(cacheRoot, options);
  return {
    dryRun,
    removedBytes: plan.removedBytes,
    projectedBytes: plan.projectedBytes,
    budgetUnmet: plan.budgetUnmet,
    deletions: plan.deletions.map((deletion) => ({
      path: path.relative(cacheRoot, deletion.path),
      bytes: deletion.bytes,
      runId: deletion.runId,
      model: deletion.model,
      kind: deletion.kind,
    })),
  };
}

// Full clear: rendered artifacts + raw GRIB inputs. Never touches tools
// (wgrib2 install) or anything outside the cache root. Directories are
// recreated empty so the runtime and builders keep working without a restart.
async function executeCacheClear(cacheRoot) {
  const targets = [path.join(cacheRoot, "artifacts"), path.join(cacheRoot, "raw-noaa")];
  let removedBytes = 0;
  for (const target of targets) {
    removedBytes += await dirSize(target);
    await fs.promises.rm(target, { recursive: true, force: true });
    await fs.promises.mkdir(target, { recursive: true });
  }
  return { removedBytes };
}

module.exports = { computeCacheStats, executeCachePrune, executeCacheClear };
