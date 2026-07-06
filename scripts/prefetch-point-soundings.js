#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { AsyncSemaphore } = require("./lib/local-artifact-concurrency");
const { LocalArtifactRuntime } = require("./lib/local-artifact-runtime");
const { NOAA_BETA_SOURCE_NAME } = require("./lib/noaa-beta-renderer");
const { DEFAULT_ARTIFACT_PREFIX, DEFAULT_VIEW_KEY, VIEW_CONFIG } = require("./lib/modelview-runtime");
const { resolveModels } = require("./lib/noaa-build/run-resolution");
const { loadDotEnv, resolveCacheRootEnv } = require("./lib/env-config");
const { runSoundingPrefetch } = require("./lib/noaa-build/prefetch-soundings");
const { parseArgs } = require("./build-noaa-beta-artifacts");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_CACHE_ROOT = path.join(ROOT_DIR, "output/noaa-beta-cache");
const DEFAULT_LOCAL_WGRIB2_PATH = path.join(ROOT_DIR, "output/noaa-beta-tools/bin/wgrib2");
const DEFAULT_MODELS = "nam3km,hrrr";

function defaultWgrib2Path() {
  return fs.existsSync(DEFAULT_LOCAL_WGRIB2_PATH) ? DEFAULT_LOCAL_WGRIB2_PATH : "wgrib2";
}

function parseRunsMode(raw) {
  const value = String(raw || "latest").trim();
  const keyword = value.toLowerCase();
  if (keyword === "latest" || keyword === "all") {
    return { runsMode: keyword, runIds: null };
  }
  // Run ids are case-sensitive ("20260703-2100Z") — lowercasing them slips
  // past the manifest read on case-insensitive filesystems and then fails
  // every frame in the point-sounding run validation.
  const runIds = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  if (runIds.length === 0) {
    throw new Error("--runs must be 'latest', 'all', or a comma list of run ids (YYYYMMDD-HHMMZ).");
  }
  return { runsMode: "list", runIds };
}

function parseHoursArg(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const hours = String(raw)
    .split(",")
    .map((token) => Number(token.trim()))
    .filter((hour) => Number.isFinite(hour) && hour >= 0)
    .map((hour) => Math.round(hour));
  return hours.length > 0 ? Array.from(new Set(hours)) : null;
}

async function main() {
  loadDotEnv(path.join(ROOT_DIR, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const models = resolveModels(args.models || args.model || DEFAULT_MODELS);
  const view = String(args.view || DEFAULT_VIEW_KEY).trim() || DEFAULT_VIEW_KEY;
  if (!VIEW_CONFIG[view]) {
    throw new Error(`Unsupported view '${view}'. Supported: ${Object.keys(VIEW_CONFIG).join(", ")}`);
  }
  const { runsMode, runIds } = parseRunsMode(args.runs);
  const hours = parseHoursArg(args.hours);
  const cacheRoot = path.resolve(String(args["cache-root"] || resolveCacheRootEnv() || DEFAULT_CACHE_ROOT));
  const artifactPrefix = String(
    args["artifact-prefix"] || process.env.MODELVIEW_ARTIFACT_PREFIX || DEFAULT_ARTIFACT_PREFIX,
  ).trim();
  const rawCacheDir = path.join(cacheRoot, "raw-noaa");
  const wgrib2Path = String(args.wgrib2 || process.env.WGRIB2 || defaultWgrib2Path()).trim() || "wgrib2";
  const concurrency = Math.max(1, Math.round(Number(args["concurrency"]) || 4));
  const rangeFetchLimiter = new AsyncSemaphore(Math.max(1, Math.round(Number(args["range-concurrency"]) || 4)));

  const runtime = new LocalArtifactRuntime({ cacheRoot, artifactPrefix, sourceName: NOAA_BETA_SOURCE_NAME });
  await runtime.init();
  console.log(
    `[noaa-sounding-prefetch] models=${models.join(",")} view=${view} runs=${runsMode}${runIds ? `(${runIds.join(",")})` : ""} cache=${cacheRoot}`,
  );
  const summary = await runSoundingPrefetch({
    runtime,
    models,
    view,
    runsMode,
    runIds,
    hours,
    rawCacheDir,
    wgrib2Path,
    rangeFetchLimiter,
    concurrency,
    // The planned task count is the progress denominator for the UI job bar;
    // announce it up front so the bar never reads against a stale estimate.
    onPlan: (tasks) => {
      console.log(`[noaa-sounding-prefetch] planned tasks=${tasks.length}`);
    },
    onProgress: (result) => {
      const label = `${result.modelKey}/${result.runId} F${String(result.hour).padStart(3, "0")}`;
      if (result.status === "failed") {
        console.warn(`[noaa-sounding-prefetch] ${label} failed: ${result.error}`);
      } else {
        // "alreadyCached" -> "cached": the server's per-frame progress scrape
        // keys off warmed/cached words.
        console.log(
          `[noaa-sounding-prefetch] ${label} ${result.status === "alreadyCached" ? "cached" : result.status}`,
        );
      }
    },
  });
  console.log(
    `[noaa-sounding-prefetch] done tasks=${summary.tasks} warmed=${summary.warmed} cached=${summary.alreadyCached} failed=${summary.failed} bytes=${summary.bytes}`,
  );
  // tasks=0 means the runs selection matched no on-disk manifest (typo'd
  // --runs, or an upstream run that was never built). A silent exit-0 no-op
  // hides that, so fail loudly instead.
  if (summary.tasks === 0) {
    console.warn("[noaa-sounding-prefetch] no loaded frames matched; nothing to prefetch");
    process.exitCode = 1;
  } else if (summary.warmed + summary.alreadyCached === 0 && summary.failed > 0) {
    // Every frame failed — a real failure. Partial failures (some frames not
    // yet published/renderable) exit 0: the job summary carries the fail
    // count, and failing the whole job over a tail frame would mislabel a
    // mostly-successful warm.
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = { parseRunsMode, parseHoursArg };
