"use strict";

// Background prefetch of a frame's MAIN selected GRIB so network overlaps
// compute in the global frame queue. Cold full builds otherwise alternate
// between network-bound waves (every frame worker fetching, CPU idle) and
// CPU-bound waves (every worker computing, network idle), because each
// worker runs fetch -> decode -> compute serially for its own frame.
//
// Correctness posture: this module only WARMS the same content-addressed
// selected-GRIB cache the frame worker reads, through the same
// materializeSelectedGrib entry (same lock files, same tmp+rename publish,
// same post-publish verification). A prefetch/worker race settles through
// those locks; a prefetch failure is swallowed (the worker fetches for
// itself exactly as before); and if this selection derivation ever diverged
// from the renderer's, the worker would simply miss the cache and fetch its
// own bytes — wasted bandwidth, never wrong artifacts.
//
// The derivation below mirrors the prefix of renderNoaaGribFrame
// (scripts/lib/noaa-beta-renderer.js) through the same shared helpers:
// grib URL -> idx records -> catalog filtered by the task's renderMode ->
// record selection -> byte-range resolution -> selected-record plan ->
// materialize. renderMode matters: "base" and "all" select different
// record sets and therefore different content-addressed cache paths, so
// the caller passes the exact renderMode the queue will dispatch.

const fs = require("fs");

const {
  // CATALOG_VERSION must come from grib-source (the renderer's source for
  // it too): importing a name that a module does not export yields
  // undefined, which silently fell back to materializeSelectedGrib's
  // "current-ui" default and forked the cache namespace — every prefetch
  // landed at a path no frame worker ever reads, doubling cold downloads.
  CATALOG_VERSION,
  buildNoaaIndexCacheContext,
  getSelectedRecordPlan,
  materializeSelectedGrib,
  readOrFetchNoaaIdxRecordsCached,
  readSelectedGribMetadata,
  selectedGribCacheDescriptor,
} = require("../noaa-beta/grib-source");
const { ensureSelectedRecordByteRangesForHour } = require("../noaa-beta/accumulation");
const { filterCatalogForRenderMode, selectNoaaNamParameterRecords } = require("../noaa-beta/selection");
const { buildNoaaGribUrl, getNoaaGribModelConfig, normalizeNoaaModelKey } = require("../noaa-beta/model-config");
const { resolveNoaaNamParameterCatalog } = require("../noaa-nam-parameter-catalog");

if (typeof CATALOG_VERSION !== "string" || CATALOG_VERSION.length === 0) {
  throw new Error("input-prefetch requires grib-source's CATALOG_VERSION export (cache namespace parity with workers)");
}

async function prefetchFrameMainGribInput({
  latestMetadata,
  modelKey,
  hour,
  renderMode = "all",
  renderSelection = null,
  rawCacheDir = null,
  noaaBaseUrl = null,
  rangeFetchConcurrency = 4,
  rangeFetchLimiter = null,
  shouldStop = null,
}) {
  if (!rawCacheDir) {
    // Without the shared selected-GRIB cache root there is nothing to warm:
    // materializeSelectedGrib would download every byte range into a
    // throwaway os.tmpdir() file no worker ever reads.
    return null;
  }
  const stopRequested = typeof shouldStop === "function" ? shouldStop : () => false;
  const noaa = latestMetadata?.noaa || {};
  const resolvedModelKey = normalizeNoaaModelKey(modelKey || latestMetadata?.modelKey || noaa.model || "nam");
  const modelConfig = getNoaaGribModelConfig(resolvedModelKey);
  const date = String(noaa.date || "").trim();
  const cycle = String(noaa.cycle || "").padStart(2, "0");
  const targetHour = Number(hour);
  if (!/^\d{8}$/.test(date) || !/^\d{2}$/.test(cycle) || !Number.isFinite(targetHour)) {
    return null;
  }
  const baseUrl = noaaBaseUrl || noaa.baseUrl || modelConfig.baseUrl;
  const gribUrl = buildNoaaGribUrl({
    modelKey: resolvedModelKey,
    baseUrl,
    date,
    cycle,
    hour: targetHour,
  });
  const indexCacheContext = buildNoaaIndexCacheContext({
    modelKey: resolvedModelKey,
    date,
    cycle,
    rawCacheDir,
  });
  const selectedCatalog = filterCatalogForRenderMode(
    resolveNoaaNamParameterCatalog(renderSelection),
    renderMode,
    renderSelection,
  );
  if (stopRequested()) {
    return null;
  }
  const records = await readOrFetchNoaaIdxRecordsCached(`${gribUrl}.idx`, indexCacheContext, targetHour, null);
  if (stopRequested()) {
    return null;
  }
  const selection = selectNoaaNamParameterRecords(records, {
    catalog: selectedCatalog,
    modelKey: resolvedModelKey,
    targetHour,
    renderMode,
  });
  if (selection.missingRequired.length > 0) {
    // The worker surfaces the real error with full context; prefetching a
    // partial record set would materialize a descriptor the worker never
    // asks for.
    return null;
  }
  const selectedRecords = Object.values(selection.records).filter(Boolean);
  await ensureSelectedRecordByteRangesForHour({
    context: {
      modelKey: resolvedModelKey,
      baseUrl,
      date,
      cycle,
      sourceIndexCacheDir: indexCacheContext.sourceIndexCacheDir,
      recordsByHour: new Map([[targetHour, records]]),
    },
    hour: targetHour,
    selectedRecords,
    gribUrl,
    profile: null,
  });
  const selectedPlan = getSelectedRecordPlan(selectedRecords, null);
  if (!Array.isArray(selectedPlan?.groups) || selectedPlan.groups.length === 0) {
    return null;
  }
  // Light warm-skip: the cache path is content-addressed (selection hash +
  // URL hash + catalog version in the name), so an existing file whose size
  // matches its sidecar is the right bytes with overwhelming likelihood.
  // Skipping here avoids materializeSelectedGrib's full SHA-256 verification
  // pass in THIS process (the frame worker still performs the authoritative
  // verification when it reads the cache — a stale/corrupt file is caught
  // and re-fetched there exactly as before prefetch existed).
  const probe = selectedGribCacheDescriptor({
    modelKey: resolvedModelKey,
    productKey: modelConfig.productKey,
    gribUrl,
    groups: selectedPlan.groups,
    rawCacheDir,
    date,
    cycle,
    hour: targetHour,
    cacheVersion: CATALOG_VERSION,
  });
  if (!probe.cachePath) {
    return null;
  }
  try {
    const [stat, metadata] = await Promise.all([
      fs.promises.stat(probe.cachePath),
      readSelectedGribMetadata(probe.cachePath),
    ]);
    if (stat.size > 0 && stat.size === Number(metadata?.selectedBytes)) {
      return probe.cachePath;
    }
  } catch {
    // Not cached (or unreadable): fall through to the real materialize.
  }
  if (stopRequested()) {
    return null;
  }
  // If the lock is already held, a frame worker (or another build sharing
  // the cache) is downloading this exact selection right now — waiting on
  // it can park this pump slot for up to the 10-minute lock timeout and
  // adds nothing the worker isn't already doing. Skip; the pump moves on
  // to a frame that actually needs warming. This probe is only a cheap
  // short-circuit: losing the probe-to-acquire race is handled by
  // onLockContention "decline" below, which resolves null instead of
  // entering the poll loop or the unlocked last-resort fetch.
  try {
    await fs.promises.access(`${probe.cachePath}.lock`);
    return null;
  } catch {
    // No lock: proceed to materialize.
  }
  return materializeSelectedGrib({
    modelKey: resolvedModelKey,
    productKey: modelConfig.productKey,
    gribUrl,
    recordGroups: selectedPlan.groups,
    rawCacheDir,
    date,
    cycle,
    hour: targetHour,
    cacheVersion: CATALOG_VERSION,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    profile: null,
    decodeSession: null,
    onLockContention: "decline",
  });
}

module.exports = {
  prefetchFrameMainGribInput,
};
