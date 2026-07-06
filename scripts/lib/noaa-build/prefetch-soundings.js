"use strict";

const { buildNoaaPointSounding } = require("../noaa-beta/point-sounding");

function domainCenterFromBounds(bounds) {
  if (!bounds || typeof bounds !== "object") {
    return null;
  }
  const north = Number(bounds.north);
  const south = Number(bounds.south);
  const west = Number(bounds.west);
  const east = Number(bounds.east);
  if (![north, south, west, east].every(Number.isFinite)) {
    return null;
  }
  return { lat: (north + south) / 2, lon: (west + east) / 2 };
}

async function resolveRunIdsForModel(runtime, modelKey, view, runsMode, explicitRunIds) {
  if (Array.isArray(explicitRunIds) && explicitRunIds.length > 0) {
    return explicitRunIds;
  }
  if (runsMode === "latest") {
    const pointer = await runtime.readLatestPointerFromDisk(modelKey, view);
    return pointer && pointer.run ? [pointer.run] : [];
  }
  // runsMode === "all"
  const runs = await runtime.listRunManifests(modelKey, view);
  return runs.map((run) => run.run).filter(Boolean);
}

async function planPrefetchTasks({ runtime, models, view, runsMode = "latest", runIds = null, hours = null }) {
  const hourFilter = Array.isArray(hours) && hours.length > 0 ? new Set(hours.map((hour) => Number(hour))) : null;
  const tasks = [];
  for (const modelKey of models) {
    const resolvedRunIds = await resolveRunIdsForModel(runtime, modelKey, view, runsMode, runIds);
    for (const runId of resolvedRunIds) {
      const manifest = await runtime.readManifestFromDisk(modelKey, runId, view);
      if (!manifest || !Array.isArray(manifest.frames)) {
        continue;
      }
      const hourStatus = manifest.hourStatus && typeof manifest.hourStatus === "object" ? manifest.hourStatus : {};
      for (const frame of manifest.frames) {
        const hour = Number(frame.hour);
        if (!Number.isFinite(hour)) {
          continue;
        }
        // Soundings warm the point-independent raw-GRIB cache, which is
        // fetchable for ANY frame the run's manifest lists — rendered or not.
        // Gating on hourStatus === "loaded" (strict artifact completeness)
        // silently skipped frames mid-re-render or with stale renderer
        // signatures. Only data-gated hours are truly unwarmable.
        if (hourStatus[String(hour)] === "unavailable") {
          continue;
        }
        if (hourFilter && !hourFilter.has(hour)) {
          continue;
        }
        const center = domainCenterFromBounds(frame.bounds);
        if (!center) {
          continue;
        }
        tasks.push({ modelKey, runId, hour, lat: center.lat, lon: center.lon });
      }
    }
  }
  return tasks;
}

async function warmFrameSounding(
  task,
  { rawCacheDir, wgrib2Path, rangeFetchLimiter = null, buildSounding = buildNoaaPointSounding } = {},
) {
  const base = { modelKey: task.modelKey, runId: task.runId, hour: task.hour };
  try {
    const payload = await buildSounding({
      modelKey: task.modelKey,
      runId: task.runId,
      hour: task.hour,
      lat: task.lat,
      lon: task.lon,
      rawCacheDir,
      wgrib2Path,
      rangeFetchLimiter,
    });
    const profile = payload && payload.renderProfile ? payload.renderProfile : {};
    const cacheHit = Boolean(profile.selectedGribCacheHit);
    const bytes = Number(profile.selectedBytes) || 0;
    return { ...base, status: cacheHit ? "alreadyCached" : "warmed", bytes };
  } catch (error) {
    return { ...base, status: "failed", bytes: 0, error: error && error.message ? error.message : String(error) };
  }
}

async function runSoundingPrefetch({
  runtime,
  models,
  view,
  runsMode = "latest",
  runIds = null,
  hours = null,
  rawCacheDir,
  wgrib2Path,
  rangeFetchLimiter,
  concurrency = 1,
  onProgress = null,
  onPlan = null,
}) {
  const tasks = await planPrefetchTasks({ runtime, models, view, runsMode, runIds, hours });
  if (typeof onPlan === "function") {
    onPlan(tasks);
  }
  const summary = { tasks: tasks.length, warmed: 0, alreadyCached: 0, failed: 0, bytes: 0 };
  let index = 0;
  const runNext = async () => {
    while (index < tasks.length) {
      const current = index;
      index += 1;
      const result = await warmFrameSounding(tasks[current], { rawCacheDir, wgrib2Path, rangeFetchLimiter });
      if (result.status === "warmed") {
        summary.warmed += 1;
      } else if (result.status === "alreadyCached") {
        summary.alreadyCached += 1;
      } else {
        summary.failed += 1;
      }
      summary.bytes += Number(result.bytes) || 0;
      if (typeof onProgress === "function") {
        onProgress(result, summary);
      }
    }
  };
  const lanes = Math.max(1, Math.min(Number(concurrency) || 1, tasks.length || 1));
  await Promise.all(Array.from({ length: lanes }, runNext));
  return summary;
}

module.exports = {
  domainCenterFromBounds,
  planPrefetchTasks,
  warmFrameSounding,
  runSoundingPrefetch,
};
