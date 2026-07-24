"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { pipeline } = require("stream");
const { spawn } = require("child_process");
const { URL } = require("url");
const { LocalArtifactRuntime } = require("./local-artifact-runtime");
const { SCIENCE_PROTOTYPE_IDS } = require("./noaa-nam-parameter-catalog");
const { buildNoaaPointSounding } = require("./noaa-beta-renderer");
const {
  buildFullHoursForModel,
  buildRecentCycleCandidates,
  mapWithConcurrency,
  noaaForecastHourExists,
  resolveAvailableNoaaHours,
  resolveNoaaBaseUrls,
} = require("./noaa-build/run-resolution");
const { computeCacheStats, executeCachePrune, executeCacheClear } = require("./local-artifact-cache-actions");

function createLocalArtifactServer(options = {}) {
  const runtime = options.runtime || new LocalArtifactRuntime(options);
  const actions = {
    probeUpstreamRuns:
      typeof options.probeUpstreamRuns === "function" ? options.probeUpstreamRuns : probeUpstreamRunsDefault,
    probeRunFrameCount:
      typeof options.probeRunFrameCount === "function" ? options.probeRunFrameCount : probeRunFrameCountDefault,
    upstreamRunCache: new Map(),
    runFrameCountCache: new Map(),
    jobs: new JobRegistry(options.spawnBuildProcess),
  };
  const basemapRoot = path.resolve(options.basemapRoot || DEFAULT_BASEMAP_ROOT);
  const server = http.createServer((req, res) => {
    void handleRequest(runtime, req, res, actions, basemapRoot).catch((error) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: String(error && error.message ? error.message : error),
        }),
      );
    });
  });
  return { runtime, server, actions };
}

// Route path components (model key, run id, view key) become filesystem path
// segments in the manifest/pointer/sounding readers, so they must not contain
// separators or traversal sequences. Model keys, run ids ("20260614-1200Z"),
// and view keys ("conus") are plain identifiers. Forbidding "." rejects "..",
// ".", and any ".json"-suffix injection while accepting every real component.
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9_-]+$/;

function isSafePathComponent(value) {
  return typeof value === "string" && SAFE_PATH_COMPONENT.test(value);
}

// Run ids on this control surface are `YYYYMMDD-HH00Z` (built manifest stems and
// upstream `${date}-${cycle}00Z` ids alike — the builder stamps whole cycles, so
// the minute field is always "00"). The builder has no --run flag — a picked run
// is translated to its tested --date/--cycle resolution path — so the shape must
// parse strictly BEFORE anything reaches a spawn argv: loose minutes like
// "20260703-1299Z" would validate here and silently build --cycle=12 while
// naming a run that does not exist. Returns { date, cycle } or null.
const RUN_ID_PATTERN = /^(\d{8})-(\d{2})00Z$/;

function parseRunId(run) {
  const match = RUN_ID_PATTERN.exec(String(run || ""));
  if (!match) {
    return null;
  }
  const cycle = match[2];
  if (Number(cycle) > 23) {
    return null;
  }
  return { date: match[1], cycle };
}

// The "latest" alias resolves child-side from buildRecentCycleCandidates'
// bounded window (72 h of recent cycles) — and NOT necessarily to the newest
// published one: server-spawned unbounded renders pass
// --require-full-horizon, which skips partially published cycles and can
// settle on an OLDER fully published one, and an exported
// MODELVIEW_NOAA_RUN_OFFSET shifts the pick further back. So the newest
// observed run is not a valid disjointness floor; the only runs provably
// disjoint from a latest resolution are those older than the window's
// oldest candidate (archived runs). The window is clock-derived and needs no
// I/O; evaluating it at check time is sound because the builder's own
// window, generated moments later, can only shift forward. Null when the
// window cannot be derived — callers must then treat nothing as archived.
function oldestLatestCandidate(modelKey) {
  try {
    return buildRecentCycleCandidates(modelKey).at(-1) || null;
  } catch {
    return null;
  }
}

// True when runId is strictly older than the candidate {date, cycle} — i.e.
// provably outside the latest-resolution window. False when the run does
// not parse or the window is unknown (never call an unprovable run
// archived). Fixed-width fields make the (date, cycle) compare
// chronological.
function isRunOlderThanCandidate(runId, candidate) {
  const run = parseRunId(runId);
  if (!run || !candidate) {
    return false;
  }
  return run.date === candidate.date ? Number(run.cycle) < Number(candidate.cycle) : run.date < candidate.date;
}

// Drive-by protection for the POST mutation routes: a malicious page in the
// user's browser can fire a no-preflight cross-origin POST at 127.0.0.1 and
// trigger builds. Browsers always attach an Origin header to cross-origin
// POSTs, so rejecting non-localhost Origins blocks that vector while requests
// without an Origin (curl, the Vite /__cf proxy) and localhost origins pass.
function isAllowedPostOrigin(originHeader, hostHeader) {
  const origin = String(originHeader || "").trim();
  if (!origin) {
    return true; // server-to-server / CLI requests carry no Origin header
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return true;
  }
  const ownHost = String(hostHeader || "")
    .trim()
    .toLowerCase();
  return ownHost !== "" && parsed.host.toLowerCase() === ownHost;
}

const BUILDER_SCRIPT_PATH = path.resolve(__dirname, "..", "build-noaa-beta-artifacts.js");
const PREFETCH_SOUNDINGS_SCRIPT_PATH = path.resolve(__dirname, "..", "prefetch-point-soundings.js");

// PMTiles basemap extracts live under output/basemap/ (gitignored; may not
// exist yet — the route 404s cleanly). Tests inject options.basemapRoot so they
// never touch the real directory.
const DEFAULT_BASEMAP_ROOT = path.resolve(__dirname, "../..", "output/basemap");

// Enum allowlists for the /actions/* control surface. The server spawns
// processes, so every model/view/category/tier is validated against a fixed
// set before it can reach a path builder or a spawn argv (spec §3.3).
const ACTION_MODEL_KEYS = Object.freeze(["gfs", "nam", "nam3km", "hrrr"]);
const ACTION_VIEW_KEYS = Object.freeze(["conus", "na"]);
const ACTION_CATEGORY_IDS = Object.freeze(["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]);
const ACTION_TIERS = Object.freeze(["simple", "full"]);
const CAM_SCIENCE_PROTOTYPE_MODELS = Object.freeze(["hrrr", "nam3km"]);

function isAllowedModel(modelKey) {
  return ACTION_MODEL_KEYS.includes(modelKey);
}

function isAllowedView(viewKey) {
  return ACTION_VIEW_KEYS.includes(viewKey);
}

// Default upstream probe: for each candidate cycle, HEAD-probe f000 and keep the
// runs NOAA has published. Injected via createLocalArtifactServer so tests never
// hit live NOAA.
async function probeUpstreamRunsDefault({ modelKey, viewKey }) {
  void viewKey;
  const noaaBaseUrl = resolveNoaaBaseUrls({}, [modelKey])[modelKey];
  const candidates = buildRecentCycleCandidates(modelKey).slice(0, 8);
  const runs = [];
  for (const candidate of candidates) {
    const available = await noaaForecastHourExists({ modelKey, noaaBaseUrl, run: candidate, hour: 0 });
    if (available) {
      runs.push({ date: candidate.date, cycle: candidate.cycle, runId: `${candidate.date}-${candidate.cycle}00Z` });
    }
  }
  return runs;
}

// Default per-run frame probe: resolveAvailableNoaaHours derives the exact
// strict published prefix — one narrow S3 object listing on mirrors that
// support ListObjectsV2, the ordered HEAD fallback otherwise. Unlike the old
// binary search, both paths inspect prefix membership, so out-of-order
// posting (e.g. F013 missing while F030+ exists) cannot become a
// lifetime-cached full-horizon overestimate. A run with nothing reads null.
// Returns { frameCount, maxHour } or null.
async function probeRunFrameCountDefault({ modelKey, run }) {
  const noaaBaseUrl = resolveNoaaBaseUrls({}, [modelKey])[modelKey];
  const hours = buildActionFullHoursForModel(modelKey, run?.cycle);
  try {
    const available = await resolveAvailableNoaaHours({
      modelKey,
      noaaBaseUrl,
      run,
      hours,
      // Picker-only tuning for listing-less mirrors, where the fallback costs
      // one HEAD per published hour: a wide in-flight window keeps a full
      // 209-hour roster to ~13 awaited rounds, and the boundary re-probe
      // fires immediately instead of after the builder's 500 ms settle — a
      // still-flaky miss undercounts one poll, and an undercount is never
      // lifetime-cached (only full-horizon results cache as complete). The
      // builder keeps the defaults.
      lookahead: 16,
      missConfirmDelayMs: 0,
      logCappedPrefix: false,
    });
    return { frameCount: available.length, maxHour: available[available.length - 1] };
  } catch {
    return null;
  }
}

// Frame counts grow while NOAA is still uploading a run, so incomplete probes
// get a short TTL; a run at the model's full horizon is immutable and can be
// cached for the server's lifetime.
const RUN_FRAME_COUNT_TTL_MS = 60_000;

async function getCachedRunFrameCount(actions, modelKey, runId) {
  const parsed = parseRunId(runId);
  if (!parsed) {
    return null;
  }
  const cacheKey = `${modelKey}|${runId}`;
  const cached = actions.runFrameCountCache.get(cacheKey);
  if (cached && (cached.complete || Date.now() - cached.fetchedAt < RUN_FRAME_COUNT_TTL_MS)) {
    return cached.result;
  }
  let result = null;
  try {
    result = await actions.probeRunFrameCount({ modelKey, run: parsed, runId });
  } catch {
    result = null; // probe failures degrade to "count unknown", never a 500
  }
  const fullCount = buildFullHoursForModelSafe(modelKey, parsed.cycle);
  actions.runFrameCountCache.set(cacheKey, {
    fetchedAt: Date.now(),
    complete: Boolean(result && fullCount !== null && result.frameCount >= fullCount),
    result: result || null,
  });
  return result || null;
}

function buildFullHoursForModelSafe(modelKey, cycle = null) {
  try {
    return buildActionFullHoursForModel(modelKey, cycle).length;
  } catch {
    return null;
  }
}

function defaultRenderFrameCountForPublishedPrefix(modelKey, cycle, maxHour, fallbackCount = null) {
  if (modelKey !== "gfs") {
    return Number.isFinite(Number(fallbackCount)) ? Number(fallbackCount) : null;
  }
  const limit = Number(maxHour);
  if (!Number.isFinite(limit)) {
    return null;
  }
  try {
    return buildActionFullHoursForModel(modelKey, cycle, "three-hourly").filter((hour) => hour <= limit).length;
  } catch {
    return null;
  }
}

// The action UI's unbounded "Full horizon" means the official publishable
// horizon. NAM's normal builder default intentionally remains the cheaper
// F000-F036 tier, but action availability/completion must not call 37 frames
// complete when an explicit full-horizon render promises the 53-frame mixed
// cadence through F084.
function buildActionFullHoursForModel(modelKey, cycle = null, gfsTemporalTier = null) {
  return buildFullHoursForModel(modelKey, {
    cycle,
    officialHorizon: modelKey === "nam",
    // Availability surfaces report the full published source cadence when no
    // render tier is supplied. Progress paths pass the selected tier
    // explicitly, so a default 3-hourly build still gets a 129-frame target.
    gfsHourlyThrough120: modelKey === "gfs" && gfsTemporalTier !== "three-hourly",
  });
}

async function handleRequest(runtime, req, res, actions, basemapRoot) {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  const requestPath = decodeURIComponent(requestUrl.pathname || "/");
  // Data-server responses are read cross-origin under `vite preview` (the app is
  // served from :4173 while artifacts live on :5174). The GET/HEAD asset and
  // manifest surface is public read-only data, so a wildcard read origin is safe;
  // POST mutation routes stay guarded by isAllowedPostOrigin. Set the header once
  // here so every branch below (including 404s) is reachable cross-origin.
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (requestPath === "/healthz") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (requestPath === "/__runtime-stats") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(runtime.getStats()));
    return;
  }
  if (requestPath.startsWith("/manifests/")) {
    await handleManifestRequest(runtime, req, requestPath, requestUrl, res);
    return;
  }
  if (requestPath.startsWith("/soundings/")) {
    await handlePointSoundingRequest(runtime, requestPath, requestUrl, res);
    return;
  }
  if (requestPath.startsWith(`/${runtime.artifactPrefix}/`)) {
    await handleAssetRequest(runtime, requestPath, res);
    return;
  }
  if (requestPath.startsWith("/basemap/")) {
    await handleBasemapRequest(req, requestPath, res, basemapRoot);
    return;
  }
  if (requestPath === "/actions/available-runs") {
    await handleAvailableRunsRequest(runtime, req, requestUrl, res, actions);
    return;
  }
  if (requestPath === "/actions/render") {
    await handleRenderRequest(runtime, req, res, actions);
    return;
  }
  if (requestPath === "/actions/prefetch-soundings") {
    await handlePrefetchSoundingsRequest(runtime, req, res, actions);
    return;
  }
  if (requestPath === "/actions/jobs") {
    handleJobsRequest(req, res, actions);
    return;
  }
  if (requestPath === "/actions/cache-stats") {
    await handleCacheStatsRequest(runtime, req, requestUrl, res, actions);
    return;
  }
  if (requestPath === "/actions/cache/prune") {
    await handleCachePruneRequest(runtime, req, res, actions);
    return;
  }
  if (requestPath === "/actions/cache/clear") {
    await handleCacheClearRequest(runtime, req, res, actions);
    return;
  }
  if (requestPath.startsWith("/actions/status/")) {
    const jobId = requestPath.slice("/actions/status/".length);
    await handleStatusRequest(runtime, req, res, actions, jobId);
    return;
  }
  if (requestPath.startsWith("/actions/cancel/")) {
    const jobId = requestPath.slice("/actions/cancel/".length);
    handleCancelRequest(req, res, actions, jobId);
    return;
  }
  res.statusCode = 404;
  res.end("Not Found");
}

async function handleManifestRequest(runtime, req, requestPath, requestUrl, res) {
  const match = requestPath.match(/^\/manifests\/([^/]+)\/([^/]+)$/);
  if (!match) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const modelKey = match[1];
  const fileName = match[2];
  const viewKey =
    String(requestUrl.searchParams.get("view") || runtime.defaultViewKey).trim() || runtime.defaultViewKey;
  if (!isSafePathComponent(modelKey) || !isSafePathComponent(viewKey)) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  if (fileName === "runs.json") {
    const runs = await runtime.listRunManifests(modelKey, viewKey);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ model: modelKey, view: viewKey, runs }));
    return;
  }
  if (fileName === "latest.json") {
    const pointer = await runtime.readLatestPointerFromDisk(modelKey, viewKey);
    if (!pointer) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(pointer));
    return;
  }
  const runMatch = fileName.match(/^(.+)\.json$/);
  if (!runMatch || !isSafePathComponent(runMatch[1])) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const result = await runtime.readManifestWithEtag(modelKey, runMatch[1], viewKey);
  if (!result) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const ifNoneMatch = String(req?.headers?.["if-none-match"] || "").trim();
  res.setHeader("ETag", result.etag);
  res.setHeader("Cache-Control", "no-store");
  if (ifNoneMatch && ifNoneMatch === result.etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(result.manifest));
}

async function handlePointSoundingRequest(runtime, requestPath, requestUrl, res) {
  const match = requestPath.match(/^\/soundings\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (!match) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const modelKey = match[1];
  const runId = match[2];
  const hour = Number(match[3]);
  const viewKey =
    String(requestUrl.searchParams.get("view") || runtime.defaultViewKey).trim() || runtime.defaultViewKey;
  if (!isSafePathComponent(modelKey) || !isSafePathComponent(runId) || !isSafePathComponent(viewKey)) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  // Number(null) is 0, so an absent (or blank) lat/lon would pass the finite
  // gate as a real coordinate and silently sound (0, 0). Map missing params to
  // NaN so they fail the gate with a 400.
  const latParam = requestUrl.searchParams.get("lat");
  const lonParam = requestUrl.searchParams.get("lon");
  const lat = latParam === null || latParam.trim() === "" ? NaN : Number(latParam);
  const lon = lonParam === null || lonParam.trim() === "" ? NaN : Number(lonParam);
  if (!Number.isFinite(hour) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    sendJsonError(res, 400, "Point sounding requests require finite hour, lat, and lon values.");
    return;
  }

  const manifest = await runtime.readManifestFromDisk(modelKey, runId, viewKey);
  if (!manifest) {
    sendJsonError(res, 404, `No manifest is available for ${modelKey}/${runId}/${viewKey}.`);
    return;
  }
  const frame = (manifest.frames || []).find((entry) => Number(entry.hour) === Math.round(hour));
  if (!frame) {
    sendJsonError(res, 404, `No frame is available for ${modelKey}/${runId} f${String(hour).padStart(3, "0")}.`);
    return;
  }
  if (!pointInsideBounds(lat, lon, frame.bounds)) {
    sendJsonError(res, 400, "Requested point is outside this frame's model/view bounds.");
    return;
  }

  try {
    const payload = await buildNoaaPointSounding({
      modelKey,
      runId,
      hour,
      lat,
      lon,
      rawCacheDir: path.join(runtime.cacheRoot, "raw-noaa"),
      wgrib2Path: resolveWgrib2Path(),
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(payload));
  } catch (error) {
    sendJsonError(res, 500, String(error && error.message ? error.message : error));
  }
}

function parseModelsParam(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

async function handleAvailableRunsRequest(runtime, req, requestUrl, res, actions) {
  if (req.method !== "GET") {
    sendJsonError(res, 405, "available-runs only accepts GET.");
    return;
  }
  const models = parseModelsParam(requestUrl.searchParams.get("models"));
  const viewKey =
    String(requestUrl.searchParams.get("view") || runtime.defaultViewKey).trim() || runtime.defaultViewKey;
  if (models.length === 0) {
    sendJsonError(res, 400, "available-runs requires at least one model (?models=hrrr,nam3km).");
    return;
  }
  if (!isAllowedView(viewKey) || !isSafePathComponent(viewKey)) {
    sendJsonError(res, 400, `Unsupported view '${viewKey}'.`);
    return;
  }
  for (const modelKey of models) {
    if (!isAllowedModel(modelKey) || !isSafePathComponent(modelKey)) {
      sendJsonError(res, 400, `Unsupported model '${modelKey}'.`);
      return;
    }
  }
  const runs = {};
  await Promise.all(
    models.map(async (modelKey) => {
      const built = await runtime.listRunManifests(modelKey, viewKey);
      const upstream = await getCachedUpstreamRuns(actions, modelKey, viewKey);
      // Every row carries how many source-cadence frames NOAA has published
      // for that run (they differ per run: still-uploading cycles and
      // short-horizon off-cycles). GFS additionally carries the count selected
      // by the default 3-hourly render tier; its source cadence is the optional
      // 209-frame hourly-through-F120 tier, while the default build is 129
      // frames. Legacy frameCount/upstreamFrameCount remain source counts.
      // Probe failures degrade to null, never a 500.
      const annotatedUpstream = await mapWithConcurrency(upstream, 6, async (run) => {
        const probed = await getCachedRunFrameCount(actions, modelKey, run.runId);
        const sourceFrameCount = probed ? probed.frameCount : null;
        return {
          ...run,
          frameCount: sourceFrameCount,
          sourceFrameCount,
          defaultRenderFrameCount: probed
            ? defaultRenderFrameCountForPublishedPrefix(modelKey, run.cycle, probed.maxHour, sourceFrameCount)
            : null,
          maxHour: probed ? probed.maxHour : null,
        };
      });
      const annotatedBuilt = await mapWithConcurrency(built, 6, async (run) => {
        const cycle = parseRunId(run.run)?.cycle;
        const fullSourceHours = (() => {
          try {
            return buildActionFullHoursForModel(modelKey, cycle);
          } catch {
            return null;
          }
        })();
        const fullCount = fullSourceHours?.length ?? null;
        // A run already at the model's full horizon cannot gain frames —
        // skip its probe entirely (most built runs, most picker opens).
        if (fullCount !== null && Number(run.frameCount) >= fullCount) {
          const sourceFrameCount = Number(run.frameCount);
          return {
            ...run,
            upstreamFrameCount: sourceFrameCount,
            upstreamSourceFrameCount: sourceFrameCount,
            upstreamDefaultRenderFrameCount: defaultRenderFrameCountForPublishedPrefix(
              modelKey,
              cycle,
              fullSourceHours.at(-1),
              sourceFrameCount,
            ),
            upstreamMaxHour: null,
          };
        }
        const probed = await getCachedRunFrameCount(actions, modelKey, run.run);
        const sourceFrameCount = probed ? probed.frameCount : null;
        return {
          ...run,
          upstreamFrameCount: sourceFrameCount,
          upstreamSourceFrameCount: sourceFrameCount,
          upstreamDefaultRenderFrameCount: probed
            ? defaultRenderFrameCountForPublishedPrefix(modelKey, cycle, probed.maxHour, sourceFrameCount)
            : null,
          upstreamMaxHour: probed ? probed.maxHour : null,
        };
      });
      runs[modelKey] = { built: annotatedBuilt, upstream: annotatedUpstream };
    }),
  );
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ view: viewKey, runs }));
}

const UPSTREAM_RUN_CACHE_TTL_MS = 60_000;

async function getCachedUpstreamRuns(actions, modelKey, viewKey) {
  const cacheKey = `${modelKey}|${viewKey}`;
  const cached = actions.upstreamRunCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < UPSTREAM_RUN_CACHE_TTL_MS) {
    return cached.runs;
  }
  const runs = await actions.probeUpstreamRuns({ modelKey, viewKey });
  actions.upstreamRunCache.set(cacheKey, { fetchedAt: Date.now(), runs });
  return runs;
}

// Roster/run-selection env spellings the spawned child must NEVER inherit:
// the control panel's argv is the complete specification of what a job
// builds, and a variable exported in the operator's shell for CLI
// experiments (e.g. MODELVIEW_NOAA_HRRR_HOURS=0,3,6) would otherwise
// silently truncate or shift every server-spawned "full" build with no log
// trace. Mirror/base-url and resource-tuning variables pass through — those
// configure HOW a build runs, not WHAT it builds.
const JOB_CHILD_ENV_BLOCKLIST =
  /^MODELVIEW_NOAA_(?:[A-Z0-9]+_HOURS|FULL_RUN|REQUIRE_FULL_HORIZON|GFS_HOURLY_THROUGH_120|RUN_OFFSET)$/;

function sanitizedJobChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (JOB_CHILD_ENV_BLOCKLIST.test(key)) {
      delete env[key];
    }
  }
  return env;
}

let JOB_SEQUENCE = 0;

function nextJobId() {
  JOB_SEQUENCE += 1;
  return `job-${Date.now().toString(36)}-${JOB_SEQUENCE.toString(36)}`;
}

// Owns the in-memory job map and the set of live children so the process
// shutdown can kill every build (no zombies). One running job per
// (model, run, view) at a time.
class JobRegistry {
  constructor(spawnBuildProcess) {
    this.spawnBuildProcess =
      typeof spawnBuildProcess === "function"
        ? spawnBuildProcess
        : (scriptPath, argv, spawnOptions) => spawn(process.execPath, [scriptPath, ...argv], spawnOptions);
    this.jobs = new Map();
    this.children = new Set();
  }

  // One conflict check for anything that spawns a child writing into a run
  // tree (renders and sounding prefetches alike): a request conflicts with a
  // running or queued job when ANY of its models overlaps the job's models
  // for the same view and the two could target the same run tree. The naive
  // exact-run comparison is defeated by the "latest" alias — a latest job
  // keeps run="latest" until its builder logs the resolved cycle, so
  // latest-then-concrete (or the reverse) used to pass the check and spawn
  // two children on one run tree. Alias resolution here:
  //  - an unresolved latest (job or request) can land on any run inside the
  //    model's recent-cycle candidate window, so it conflicts with the
  //    other side unless that side is a concrete run provably OLDER than
  //    the window (an archived run — see oldestLatestCandidate); the rule
  //    is symmetric in both directions;
  //  - once a latest job logs its resolved cycle (or when it was pinned to
  //    a concrete run), only that run conflicts with a concrete request.
  hasJobConflict(model, run, view) {
    let windowOldest;
    // Lazy + memoized per call: the 72 h candidate window is only needed
    // when a latest alias meets a concrete run, and never differs between
    // jobs of one check.
    const isArchivedRun = (concreteRunId) => {
      if (windowOldest === undefined) {
        windowOldest = oldestLatestCandidate(model);
      }
      return isRunOlderThanCandidate(concreteRunId, windowOldest);
    };
    for (const job of this.jobs.values()) {
      if ((job.status !== "running" && job.status !== "queued") || job.view !== view) {
        continue;
      }
      const jobModels = Array.isArray(job.models) && job.models.length > 0 ? job.models : [job.model];
      if (!jobModels.includes(model)) {
        continue;
      }
      const jobRun = job.run === "latest" ? job.resolvedRunsByModel[model] || "latest" : job.run;
      if (jobRun === run) {
        return true;
      }
      if (jobRun === "latest" && (run === "latest" || !isArchivedRun(run))) {
        return true;
      }
      if (run === "latest" && jobRun !== "latest" && !isArchivedRun(jobRun)) {
        return true;
      }
    }
    return false;
  }

  // `after`: chain this job behind another — it spawns only when that job's
  // child exits. Builder/prefetch processes each size their concurrency
  // against the whole machine, so one request must never run two children at
  // once (two full frame-worker pools oversubscribe CPU/memory; two prefetch
  // processes double the NOAA range-fetch burst).
  startJob({ scriptPath, argv, model, models, run, view, kind, targetHours, after = null }) {
    const jobId = nextJobId();
    const job = {
      jobId,
      kind: kind || "render",
      status: "queued",
      model,
      models: Array.isArray(models) && models.length > 0 ? models.slice() : [model],
      run,
      view,
      pid: null,
      built: 0,
      reused: 0,
      failed: 0,
      total: 0,
      // Prefetch: the exact caller-resolved hours. Render: a preliminary
      // requested roster when knowable, replaced by the builder's exact
      // availability-capped plan log before any frame starts.
      targetHours: Array.isArray(targetHours) && targetHours.length > 0 ? Array.from(new Set(targetHours)) : null,
      plannedHoursByModel: null,
      resolvedRunsByModel: {},
      // Hours seen in this build's own F%03d progress lines — the derivable
      // target set for builds whose hours are resolved child-side.
      observedHours: new Set(),
      log: [],
      error: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      cancelRequested: false,
      _child: null,
      _queue: [],
    };
    this.jobs.set(jobId, job);
    const launch = () => {
      if (job.status !== "queued") {
        // Canceled (user or shutdown) while waiting: never spawn, but release
        // anything chained behind this job so the rest of the queue still runs.
        this.flushJobQueue(job);
        return;
      }
      job.status = "running";
      // Re-stamp at spawn: the fresh-marker progress filter compares marker
      // mtimes against startedAt, which must be the CHILD's start, not the
      // moment the job was queued.
      job.startedAt = new Date().toISOString();
      this.spawnJobChild(job, scriptPath, argv);
    };
    if (after && (after.status === "running" || after.status === "queued")) {
      after._queue.push(launch);
    } else {
      launch();
    }
    return job;
  }

  spawnJobChild(job, scriptPath, argv) {
    const child = this.spawnBuildProcess(scriptPath, argv, {
      cwd: path.resolve(__dirname, "..", ".."),
      env: sanitizedJobChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.pid = child.pid || null;
    job._child = child;
    this.children.add(child);
    const onLine = (line) => this.applyLogLine(job, line);
    attachLineReader(child.stdout, onLine);
    attachLineReader(child.stderr, onLine);
    child.on("exit", (code) => {
      this.children.delete(child);
      job._child = null;
      if (!job.endedAt) {
        job.endedAt = new Date().toISOString();
      }
      if (job.status === "running" && job.cancelRequested) {
        // The child died because WE killed it — a canceled job is not a
        // failure, whatever exit code the signal produced.
        job.status = "canceled";
        job.error = job.error || "Canceled by user.";
      } else if (job.status === "running") {
        job.status = Number(code) === 0 ? "done" : "failed";
        if (Number(code) !== 0 && !job.error) {
          // The child's real failure reason is in its output — surface the
          // last error-looking line instead of only an opaque exit code. The
          // prefetch's own planned/done summary lines contain "failed=N" and
          // would shadow the per-frame reason, so they never qualify.
          const reason = [...job.log]
            .reverse()
            .find(
              (line) =>
                !/\b(?:done|planned) tasks=/.test(line) &&
                /\b(error|failed|no loaded frames|nothing to prefetch|Error:)/i.test(line),
            );
          const what = job.kind === "prefetch-soundings" ? "Sounding prefetch" : "Builder";
          job.error = reason ? `${what} failed: ${reason.slice(0, 300)}` : `${what} exited with code ${code}.`;
        }
      }
      this.flushJobQueue(job);
    });
    // A spawn-level failure (EMFILE, EAGAIN, ENOENT, ...) fires 'error' and may
    // never fire 'exit'. Without this, the job stays "running" forever, 409-blocks
    // its (model, run, view) until restart, and the dead child lingers in the
    // kill set. Mirror the exit cleanup: fail the job and drop the child.
    child.on("error", (error) => {
      this.children.delete(child);
      job._child = null;
      if (job.status === "running") {
        if (job.cancelRequested) {
          job.status = "canceled";
          job.error = job.error || "Canceled by user.";
        } else {
          job.status = "failed";
          job.error = `Builder process error: ${String(error && error.message ? error.message : error)}`;
        }
        job.endedAt = new Date().toISOString();
      }
      this.flushJobQueue(job);
    });
  }

  // Launch whatever was chained behind this job (regardless of its outcome —
  // chained jobs target different (model, run) pairs and are independent).
  flushJobQueue(job) {
    const queue = job._queue.splice(0);
    for (const launch of queue) {
      launch();
    }
  }

  // Scrape the builder's progress lines and final JSON summary. Frame lines drive
  // built/reused/failed counters; the final summary (results[]) is authoritative.
  applyLogLine(job, line) {
    const text = String(line || "").trim();
    if (!text) {
      return;
    }
    if (job.log.length < 500) {
      job.log.push(text);
    }
    const builderPlan = parseBuilderPlanLine(text);
    if (builderPlan && builderPlan.view === job.view) {
      const plannedHoursByModel = {};
      let plannedFrameCount = 0;
      let completePlan = true;
      for (const modelKey of job.models) {
        const hours = builderPlan.hoursByModel[modelKey];
        if (!Array.isArray(hours)) {
          completePlan = false;
          break;
        }
        plannedHoursByModel[modelKey] = hours;
        plannedFrameCount += hours.length;
      }
      if (completePlan && plannedFrameCount > 0) {
        job.plannedHoursByModel = plannedHoursByModel;
        job.total = plannedFrameCount;
        // Marker scanning is single-model only. Replace the requested cap
        // with the realized published prefix so an uploading picked run never
        // reports progress against hours the builder omitted.
        if (job.models.length === 1) {
          job.targetHours = [...plannedHoursByModel[job.model]];
        }
      }
    }
    const builderRun = parseBuilderRunLine(text);
    if (builderRun && job.models.includes(builderRun.model) && builderRun.view === job.view) {
      job.resolvedRunsByModel[builderRun.model] = builderRun.run;
    }
    const frameMatch = /\bF(\d{3})\b/.exec(text);
    if (frameMatch) {
      job.observedHours.add(Number(frameMatch[1]));
    }
    // Builder frames log complete/reused/error; the sounding prefetch logs
    // warmed/cached/failed per frame plus its own one-line summary.
    if (frameMatch && /\b(complete|warmed)\b/.test(text)) {
      job.built += 1;
    } else if (frameMatch && /\b(reused|cached|alreadyCached)\b/.test(text)) {
      job.reused += 1;
    } else if (frameMatch && /\b(error|failed)\b/.test(text)) {
      job.failed += 1;
    }
    // The prefetch announces its plan up front — that count is the job's
    // authoritative denominator (never a server-side pre-spawn estimate).
    const prefetchPlan = /\bplanned tasks=(\d+)\b/.exec(text);
    if (prefetchPlan) {
      job.total = Number(prefetchPlan[1]) || job.total;
    }
    const prefetchSummary = /\bdone tasks=(\d+) warmed=(\d+) cached=(\d+) failed=(\d+)\b/.exec(text);
    if (prefetchSummary) {
      job.total = Number(prefetchSummary[1]) || job.total;
      job.built = Number(prefetchSummary[2]) || 0;
      job.reused = Number(prefetchSummary[3]) || 0;
      job.failed = Number(prefetchSummary[4]) || 0;
    }
    const summary = tryParseBuilderSummary(job._summaryBuffer, text);
    if (summary && Array.isArray(summary.results)) {
      job._summaryBuffer = null;
      const modelSet = new Set(job.models);
      const matches = summary.results.filter((entry) => modelSet.has(String(entry?.model || "")));
      if (matches.length > 0) {
        job.built = sumBuilderResultCount(matches, "built");
        job.reused = sumBuilderResultCount(matches, "reused");
        job.failed = sumBuilderResultCount(matches, "failed");
        const frameCount = sumBuilderResultCount(matches, "frameCount");
        if (frameCount > 0) {
          job.total = frameCount;
        }
        for (const match of matches) {
          const modelKey = String(match.model || "");
          const run = String(match.run || "").trim();
          if (run) {
            job.resolvedRunsByModel[modelKey] = run;
          }
        }
        // Preserve the legacy concrete run field for a single-model latest
        // job. A multi-model latest job can resolve to different cycles and
        // therefore has no truthful scalar run id.
        if (job.models.length === 1 && job.run === "latest") {
          job.run = job.resolvedRunsByModel[job.model] || job.run;
        }
      }
    } else if (text.startsWith("{") || (job._summaryBuffer !== undefined && job._summaryBuffer !== null)) {
      job._summaryBuffer = (job._summaryBuffer || "") + text + "\n";
    }
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  // Queued jobs cancel instantly (they never spawn; launch() flushes their
  // successors when the predecessor exits). Running jobs get SIGTERM and stay
  // "running" until the child actually exits — that keeps hasJobConflict
  // blocking the (model, run, view) so a resubmit cannot race the dying
  // builder's final writes. Terminal jobs are a no-op.
  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    if (job.status === "queued") {
      job.status = "canceled";
      job.error = "Canceled by user.";
      job.endedAt = new Date().toISOString();
      return job;
    }
    if (job.status === "running") {
      job.cancelRequested = true;
      if (job._child) {
        try {
          job._child.kill("SIGTERM");
        } catch {
          // Child already gone; its exit/error handler settles the status.
        }
      }
    }
    return job;
  }

  // True while any build/prefetch is queued or running — cache mutations are
  // refused in that window (deleting tiles under an active builder corrupts
  // the run it is writing).
  hasActiveJobs() {
    for (const job of this.jobs.values()) {
      if (job.status === "running" || job.status === "queued") {
        return true;
      }
    }
    return false;
  }

  listJobs() {
    return Array.from(this.jobs.values()).map((job) => publicJobView(job));
  }

  killAll(signal = "SIGTERM") {
    // Cancel queued jobs FIRST so a dying child's exit handler cannot launch
    // the next chained process mid-shutdown (launch() no-ops on non-queued).
    for (const job of this.jobs.values()) {
      if (job.status === "queued") {
        job.status = "failed";
        job.error = "Cancelled: server shutting down.";
        job.endedAt = new Date().toISOString();
      }
    }
    for (const child of this.children) {
      try {
        child.kill(signal);
      } catch {
        // best-effort: a child that already exited is fine.
      }
    }
  }
}

function parseBuilderPlanLine(line) {
  const match = /^\[noaa-beta\]\s+building models=([^\s]+)\s+view=([^\s]+)\s+hours=(.*?)\s+cache=/.exec(
    String(line || ""),
  );
  if (!match) {
    return null;
  }
  const models = match[1]
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const hoursByModel = {};
  for (const token of match[3].trim().split(/\s+/).filter(Boolean)) {
    const separator = token.indexOf(":");
    if (separator <= 0) {
      return null;
    }
    const model = token.slice(0, separator);
    const rawHours = token.slice(separator + 1);
    if (!models.includes(model) || (rawHours && !/^\d+(?:,\d+)*$/.test(rawHours))) {
      return null;
    }
    const hours = rawHours ? rawHours.split(",").map(Number) : [];
    if (new Set(hours).size !== hours.length) {
      return null;
    }
    hoursByModel[model] = hours;
  }
  if (!models.every((model) => Array.isArray(hoursByModel[model]))) {
    return null;
  }
  return { models, view: match[2], hoursByModel };
}

function parseBuilderRunLine(line) {
  const match = /^\[noaa-beta\]\s+([a-z0-9_-]+)\/([A-Za-z0-9_-]+)\s+run=([^\s]+)\s+(?:start|complete)\b/.exec(
    String(line || ""),
  );
  if (!match || !parseRunId(match[3])) {
    return null;
  }
  return { model: match[1], view: match[2], run: match[3] };
}

function sumBuilderResultCount(results, field) {
  return results.reduce((sum, result) => {
    const value = Number(result?.[field]);
    return sum + (Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
  }, 0);
}

// The final builder summary is a multi-line pretty-printed JSON block. Accumulate
// candidate lines and parse when the buffer forms valid JSON with a results array.
function tryParseBuilderSummary(buffer, line) {
  const candidate = (buffer || "") + line + "\n";
  const start = candidate.indexOf("{");
  if (start < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate.slice(start));
    return parsed && Array.isArray(parsed.results) ? parsed : null;
  } catch {
    return null;
  }
}

function attachLineReader(stream, onLine) {
  if (!stream || typeof stream.on !== "function") {
    return;
  }
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let index = buffered.indexOf("\n");
    while (index >= 0) {
      onLine(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      index = buffered.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffered) {
      onLine(buffered);
    }
  });
}

function publicJobView(job) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    model: job.model,
    run: job.run,
    view: job.view,
    pid: job.pid,
    built: job.built,
    reused: job.reused,
    failed: job.failed,
    total: job.total,
    error: job.error,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
  };
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Never destroy the request here: the caller answers this rejection
        // with a 400, and a synchronous destroy kills the socket before that
        // response can flush (clients saw ECONNRESET instead of the 400).
        // Drain toward the 400 instead — but only within a bounded grace
        // window: an endless body would otherwise hold the socket and burn
        // read bandwidth for the connection's lifetime. The window is 8x the
        // cap so any realistic accidental oversend (a few hundred KB over)
        // drains fully and sees the 400; only a body megabytes past the
        // limit — abusive or hopelessly broken — gets cut off mid-upload.
        reject(new Error("Request body too large."));
        req.removeAllListeners("data");
        const drainLimit = size + maxBytes * 8;
        req.on("data", (drained) => {
          size += drained.length;
          if (size > drainLimit) {
            req.destroy();
          }
        });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function fail(message) {
  return { ok: false, error: message };
}

// Number() alone admits non-numeric JSON types — Number(false) is 0,
// Number(true) is 1, Number([6]) is 6 — silently rewriting a malformed field
// into a valid-looking flag value. Validated numeric fields accept only real
// numbers and plain numeric strings. Returns the number, or null when the
// input is not numeric at all (callers apply their own range and message).
function strictJsonNumber(raw) {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

// Validate the §1.4 selection wire contract against the enum allowlists. Rejects
// unknown models/view/categories/tiers so nothing outside the allowlist reaches
// a spawn argv or a path builder.
function validateRenderSelection(selection) {
  if (!selection || typeof selection !== "object") {
    return fail("A render selection object is required.");
  }
  const models = Array.isArray(selection.models)
    ? selection.models.map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
    : [];
  if (models.length === 0) {
    return fail("At least one model is required.");
  }
  for (const modelKey of models) {
    if (!isAllowedModel(modelKey) || !isSafePathComponent(modelKey)) {
      return fail(`Unsupported model '${modelKey}'.`);
    }
  }
  const viewKey = String(selection.view || "conus").trim();
  if (!isAllowedView(viewKey) || !isSafePathComponent(viewKey)) {
    return fail(`Unsupported view '${viewKey}'.`);
  }
  const run = String(selection.run || "latest").trim();
  // isSafePathComponent gates injection; parseRunId adds the strict
  // YYYYMMDD-HH00Z shape the --date/--cycle translation depends on.
  if (run !== "latest" && (!isSafePathComponent(run) || !parseRunId(run))) {
    return fail(`Unsupported run '${run}'. Expected 'latest' or YYYYMMDD-HH00Z.`);
  }
  // Per-model runs map (run cycles differ per model — HRRR is hourly, NAM3km
  // 4×/day). Every key must be a selected model; every value — a single run
  // or an ARRAY of runs (the multi-run queue) — passes the same strict run
  // gate as `run`. Models absent from the map fall back to `run`.
  const runsInput = selection.runs && typeof selection.runs === "object" ? selection.runs : {};
  const runsByModel = {};
  for (const [key, rawValue] of Object.entries(runsInput)) {
    if (!models.includes(key)) {
      return fail(`runs['${key}'] does not match a selected model.`);
    }
    const list = Array.isArray(rawValue) ? rawValue : [rawValue];
    const normalizedRuns = [];
    for (const rawRun of list) {
      const value = String(rawRun || "").trim();
      if (value !== "latest" && (!isSafePathComponent(value) || !parseRunId(value))) {
        return fail(`Unsupported run '${value}' for model '${key}'. Expected 'latest' or YYYYMMDD-HH00Z.`);
      }
      if (!normalizedRuns.includes(value)) {
        normalizedRuns.push(value);
      }
    }
    if (normalizedRuns.length > 0) {
      runsByModel[key] = normalizedRuns;
    }
  }
  for (const modelKey of models) {
    if (!runsByModel[modelKey] || runsByModel[modelKey].length === 0) {
      runsByModel[modelKey] = [run];
    }
  }
  const categoriesInput = selection.categories && typeof selection.categories === "object" ? selection.categories : {};
  const enabledCategories = [];
  const tiers = { severe: "full", winter: "full" };
  for (const key of Object.keys(categoriesInput)) {
    if (!ACTION_CATEGORY_IDS.includes(key)) {
      return fail(`Unknown category '${key}'.`);
    }
  }
  for (const categoryId of ACTION_CATEGORY_IDS) {
    const value = categoriesInput[categoryId];
    if (value === undefined) {
      continue;
    }
    if (categoryId === "severe" || categoryId === "winter") {
      if (!value || typeof value !== "object") {
        return fail(`Category '${categoryId}' requires an { enabled, tier } object.`);
      }
      // Plain categories 400 on a non-boolean below; the object form must not
      // silently read a truthy/falsy `enabled` (1, "yes", missing) as disabled.
      if (typeof value.enabled !== "boolean") {
        return fail(`Category '${categoryId}'.enabled must be a boolean.`);
      }
      const tier = String(value.tier || "full").trim();
      if (!ACTION_TIERS.includes(tier)) {
        return fail(`Unsupported tier '${tier}' for '${categoryId}'.`);
      }
      tiers[categoryId] = tier;
      if (value.enabled === true) {
        enabledCategories.push(categoryId);
      }
    } else {
      if (typeof value !== "boolean") {
        return fail(`Category '${categoryId}' must be a boolean.`);
      }
      if (value === true) {
        enabledCategories.push(categoryId);
      }
    }
  }
  // An empty category set would spawn a builder with `--categories=` (empty),
  // producing a floor-placeholders-only catalog that can still advance the
  // latest pointer. Degenerate by construction — reject before argv/spawn.
  if (enabledCategories.length === 0) {
    return fail("At least one category must be enabled.");
  }
  // maxHour: prefix frame subset (f000..fN). Prefix-only keeps run-cumulative
  // products byte-identical to a full build's same hours; the builder enforces
  // the same rule via --max-hour filtering in resolveHoursByModel.
  let maxHour = null;
  if (selection.maxHour !== undefined && selection.maxHour !== null) {
    const value = strictJsonNumber(selection.maxHour);
    if (value === null || !Number.isInteger(value) || value < 0 || value > 384) {
      return fail("maxHour must be an integer between 0 and 384.");
    }
    maxHour = value;
  }
  const gfsTemporalTier = String(selection.gfsTemporalTier || "three-hourly").trim();
  if (gfsTemporalTier !== "three-hourly" && gfsTemporalTier !== "hourly-through-120") {
    return fail("gfsTemporalTier must be 'three-hourly' or 'hourly-through-120'.");
  }
  if (gfsTemporalTier === "hourly-through-120" && !models.includes("gfs")) {
    return fail("gfsTemporalTier 'hourly-through-120' requires GFS to be selected.");
  }
  const sciencePrototypes = [];
  if (selection.sciencePrototypes !== undefined && selection.sciencePrototypes !== null) {
    if (!Array.isArray(selection.sciencePrototypes)) {
      return fail("sciencePrototypes must be an array.");
    }
    for (const rawId of selection.sciencePrototypes) {
      const id = String(rawId || "").trim();
      if (!SCIENCE_PROTOTYPE_IDS.includes(id)) {
        return fail(`Unsupported science prototype '${id}'.`);
      }
      if (!sciencePrototypes.includes(id)) {
        sciencePrototypes.push(id);
      }
    }
  }
  const severeFull = enabledCategories.includes("severe") && tiers.severe === "full";
  if (
    sciencePrototypes.includes("camDcape21Level") &&
    !models.some((model) => CAM_SCIENCE_PROTOTYPE_MODELS.includes(model))
  ) {
    return fail("Science prototype 'camDcape21Level' requires a selected CAM model (hrrr or nam3km).");
  }
  for (const id of ["camDcape21Level", "effectiveStp100mbReduced"]) {
    if (sciencePrototypes.includes(id) && !severeFull) {
      return fail(`Science prototype '${id}' requires the Severe category at full tier.`);
    }
  }
  // The row-aware diagnostic is always applicable: core synoptic support and
  // center detection are rendered independently of the seven category gates.
  let tuning = null;
  if (selection.tuning !== undefined && selection.tuning !== null) {
    if (typeof selection.tuning !== "object" || Array.isArray(selection.tuning)) {
      return fail("tuning must be an object.");
    }
    tuning = {};
    for (const [key, rawValue] of Object.entries(selection.tuning)) {
      const spec = RENDER_TUNING_FIELDS[key];
      if (!spec) {
        return fail(`Unknown tuning field '${key}'.`);
      }
      if (rawValue === undefined || rawValue === null || rawValue === "") {
        continue;
      }
      const value = strictJsonNumber(rawValue);
      if (value === null || !Number.isInteger(value) || value < spec.min || value > spec.max) {
        return fail(`tuning.${key} must be an integer between ${spec.min} and ${spec.max}.`);
      }
      tuning[key] = value;
    }
    if (Object.keys(tuning).length === 0) {
      tuning = null;
    }
  }
  return {
    ok: true,
    normalized: {
      models,
      view: viewKey,
      run,
      runsByModel,
      categories: enabledCategories,
      severeTier: tiers.severe,
      winterTier: tiers.winter,
      maxHour,
      gfsTemporalTier,
      sciencePrototypes: SCIENCE_PROTOTYPE_IDS.filter((id) => sciencePrototypes.includes(id)),
      tuning,
    },
  };
}

// Renderer tuning knobs the UI may pass per render. Bounds mirror the builder's
// own clampInt ranges (resolveParallelism / resolveDerivedCellConcurrency in
// build-noaa-beta-artifacts.js) so a value that validates here is used
// verbatim, never silently re-clamped. derivedCellConcurrency=1 is the
// explicit off switch for intra-frame derived parallelism (the builder's
// default is auto; note an explicit workerCount/totalFrameConcurrency
// throttle already keeps auto off on its own).
const RENDER_TUNING_FIELDS = Object.freeze({
  workerCount: { flag: "--worker-count", min: 1, max: 48 },
  totalFrameConcurrency: { flag: "--total-frame-concurrency", min: 1, max: 64 },
  rangeConcurrency: { flag: "--range-concurrency", min: 1, max: 64 },
  decodeConcurrency: { flag: "--decode-concurrency", min: 1, max: 8 },
  derivedCellConcurrency: { flag: "--derived-cell-concurrency", min: 1, max: 16 },
});

// Group the selected models by their effective run choices, preserving model
// order within a group. Models sharing a run (or all-latest) build in ONE job
// so the global frame queue keeps sharing workers across models; divergent
// picks split. A model may appear in several groups (multi-run queue). Groups
// come back in launch order: newest first — 'latest' (newest by definition),
// then picked run ids descending (YYYYMMDD-HH00Z sorts chronologically).
function groupModelsByRun(normalized) {
  const groups = new Map();
  for (const modelKey of normalized.models) {
    const runKeys = normalized.runsByModel[modelKey] || [normalized.run || "latest"];
    for (const runKey of runKeys) {
      if (!groups.has(runKey)) {
        groups.set(runKey, []);
      }
      const group = groups.get(runKey);
      if (!group.includes(modelKey)) {
        group.push(modelKey);
      }
    }
  }
  return new Map(
    [...groups.entries()].sort((left, right) => {
      if (left[0] === "latest") {
        return -1;
      }
      if (right[0] === "latest") {
        return 1;
      }
      return left[0] < right[0] ? 1 : left[0] > right[0] ? -1 : 0;
    }),
  );
}

// True when a normalized selection enables every category at full tier — the
// byte-identical default build. Absent selection flags = full render (B.3).
function isFullRenderSelection(normalized) {
  return (
    ACTION_CATEGORY_IDS.every((id) => normalized.categories.includes(id)) &&
    normalized.severeTier === "full" &&
    normalized.winterTier === "full"
  );
}

// Marshal a validated selection into builder CLI flags (array form, shell:false).
// Category order follows ACTION_CATEGORY_IDS so the flag is stable/testable.
// A FULL selection (all 7 categories, both tiers full) emits NO selection flags
// so the spawned build carries no renderSelection stamp in the manifest, per
// the B.3 "absent = full" convention. (--full is the HOURS dimension — all
// frames in the configured/selected cadence — and is orthogonal to the selection-flag parity rule:
// per-frame artifacts stay byte-identical to a no-flags CLI build.)
function buildBuilderArgv(normalized) {
  // --hours=full: the UI targets every frame in the configured/selected
  // cadence for the run (the builder caps explicit runs to what NOAA has
  // actually uploaded via resolveAvailableNoaaHours). Without it the builder
  // falls back to DEFAULT_HOURS = [0,3,6]. Deliberately the --hours spelling,
  // not --full: an explicit --hours flag overrides a lingering
  // MODELVIEW_NOAA_BETA_HOURS in the server's inherited environment through
  // ordinary flag-over-env precedence, where the bare --full flag would trip
  // resolveHoursByModel's contradiction guard and fail every spawned build.
  const argv = [`--models=${normalized.models.join(",")}`, `--view=${normalized.view}`, "--hours=full"];
  // Latest/unbounded selection requires a completed official horizon. Explicit
  // picked runs use their published prefix, and GFS mixed cadence stays mixed.
  // NAM also needs the opt-in for any cap beyond its intentionally cheaper F036
  // default tier; otherwise a user asking for F048 would silently stop at F036.
  // The flag adds no per-frame cost beyond the frames the user chose.
  if (
    normalized.maxHour === null ||
    normalized.maxHour === undefined ||
    (normalized.models.includes("nam") && normalized.maxHour > 36)
  ) {
    argv.push("--require-full-horizon");
  }
  if (!isFullRenderSelection(normalized)) {
    const orderedCategories = ACTION_CATEGORY_IDS.filter((id) => normalized.categories.includes(id));
    argv.push(`--categories=${orderedCategories.join(",")}`);
    argv.push(`--severe-tier=${normalized.severeTier}`);
    argv.push(`--winter-tier=${normalized.winterTier}`);
  }
  if (normalized.run && normalized.run !== "latest") {
    // The builder has NO --run flag: it resolves the run from --date/--cycle
    // (resolveNoaaModelRun) or falls through to the latest probe. Translate the
    // picked run id onto that existing, tested path so the build targets the
    // run the job/status report — never silently "latest".
    const parsedRun = parseRunId(normalized.run);
    if (!parsedRun) {
      // validateRenderSelection guarantees the shape; never fall through to a
      // silent latest build if that invariant is ever broken.
      throw new Error(`Run '${normalized.run}' is not a valid YYYYMMDD-HH00Z run id.`);
    }
    argv.push(`--date=${parsedRun.date}`, `--cycle=${parsedRun.cycle}`);
  }
  // Hours cap and tuning are orthogonal to the selection-flag parity rule:
  // they never change the bytes of the frames that ARE rendered, so they are
  // safe to append even on a no-selection-flags full render.
  if (normalized.maxHour !== null && normalized.maxHour !== undefined) {
    argv.push(`--max-hour=${normalized.maxHour}`);
  }
  if (normalized.gfsTemporalTier === "hourly-through-120" && normalized.models.includes("gfs")) {
    argv.push("--gfs-hourly-through-120");
  }
  if (normalized.sciencePrototypes?.length > 0) {
    const orderedSciencePrototypes = SCIENCE_PROTOTYPE_IDS.filter((id) => normalized.sciencePrototypes.includes(id));
    argv.push(`--science-prototypes=${orderedSciencePrototypes.join(",")}`);
  }
  if (normalized.tuning) {
    for (const [key, spec] of Object.entries(RENDER_TUNING_FIELDS)) {
      if (normalized.tuning[key] !== undefined) {
        argv.push(`${spec.flag}=${normalized.tuning[key]}`);
      }
    }
  }
  return argv;
}

// The hour prefix a maxHour render will target for a model — the marker-scan
// progress denominator. Null when unbounded (builder resolves its own target).
function targetHoursForMaxHour(modelKey, maxHour, cycle = null, gfsTemporalTier = "three-hourly") {
  if (maxHour === null || maxHour === undefined) {
    return null;
  }
  if (modelKey === "hrrr" && !/^\d{2}$/.test(String(cycle || ""))) {
    // A latest HRRR run can resolve to either the F018 off-cycle or F048
    // extension. Do not invent a denominator before the builder reports its
    // resolved frame count.
    return null;
  }
  try {
    return buildActionFullHoursForModel(modelKey, cycle, gfsTemporalTier).filter((hour) => hour <= maxHour);
  } catch {
    return null;
  }
}

async function handleRenderRequest(runtime, req, res, actions) {
  if (req.method !== "POST") {
    sendJsonError(res, 405, "render only accepts POST.");
    return;
  }
  if (!isAllowedPostOrigin(req.headers.origin, req.headers.host)) {
    sendJsonError(res, 403, "Cross-origin requests are not allowed on this route.");
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJsonError(res, 400, String(error && error.message ? error.message : error));
    return;
  }
  const result = validateRenderSelection(body);
  if (!result.ok) {
    sendJsonError(res, 400, result.error);
    return;
  }
  // Mirror of the cache routes' active-job gate: never spawn a builder while
  // a prune/clear is deleting from the trees the build would write into.
  if ((actions.cacheMutationCount || 0) > 0) {
    sendJsonError(res, 409, "A cache prune/clear is in progress; retry once it finishes.");
    return;
  }
  const { normalized } = result;
  // One builder job per distinct run choice (models sharing a run stay in one
  // job). Conflicts are checked across ALL groups before ANY spawn so a
  // rejected request never leaves a partial set of builds running.
  const groups = groupModelsByRun(normalized);
  for (const [runKey, groupModels] of groups) {
    for (const modelKey of groupModels) {
      if (actions.jobs.hasJobConflict(modelKey, runKey, normalized.view)) {
        // Kind-neutral wording: the conflicting job can be a render OR a
        // sounding prefetch on (possibly) the same run tree.
        sendJsonError(res, 409, `A job for ${modelKey}/${runKey}/${normalized.view} is already running.`);
        return;
      }
    }
  }
  const jobs = [];
  let previousJob = null;
  for (const [runKey, groupModels] of groups) {
    const argv = buildBuilderArgv({ ...normalized, models: groupModels, run: runKey });
    // Chained, not parallel: each builder process sizes a full frame-worker
    // pool against the whole machine, so groups run one after another.
    const job = actions.jobs.startJob({
      scriptPath: BUILDER_SCRIPT_PATH,
      argv,
      model: groupModels[0],
      models: groupModels,
      run: runKey,
      view: normalized.view,
      kind: "render",
      // Single-model groups only: the marker scan counts one model's frames
      // while built/reused accumulate across the whole group, so a shared
      // prefix denominator would read 100% while other models still build.
      targetHours:
        groupModels.length === 1
          ? targetHoursForMaxHour(
              groupModels[0],
              normalized.maxHour,
              parseRunId(runKey)?.cycle,
              normalized.gfsTemporalTier,
            )
          : null,
      after: previousJob,
    });
    previousJob = job;
    jobs.push({ jobId: job.jobId, models: groupModels, run: runKey });
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // `jobId` (first job) is kept for older clients of the single-job contract.
  res.end(JSON.stringify({ jobId: jobs[0].jobId, jobs }));
}

// The prefetch script exits 1 when a run resolves to no loaded frames, which
// used to surface as an opaque "exited with code 1" AFTER a spawn. Resolve and
// validate every target here instead: "latest" resolves to the latest BUILT
// run (the local pointer — soundings need built raw data, not upstream), the
// manifest must exist, and it must carry loaded frames. Any bad target fails
// the whole request with an actionable 400 before anything spawns.
async function resolvePrefetchTarget(runtime, actions, modelKey, requestedRun, viewKey) {
  let runId = requestedRun;
  if (runId === "latest") {
    const pointer = await runtime.readLatestPointerFromDisk(modelKey, viewKey);
    runId = pointer && pointer.run ? String(pointer.run) : null;
    if (!runId) {
      return { error: `${modelKey}/${viewKey} has no built runs yet — render it first.` };
    }
  }
  if (!isSafePathComponent(runId)) {
    return { error: `Unsupported run '${runId}'.` };
  }
  const manifest = await runtime.readManifestFromDisk(modelKey, runId, viewKey);
  if (!manifest || !Array.isArray(manifest.frames)) {
    return { error: `${modelKey} run ${runId} is not built for ${viewKey} — render it first.` };
  }
  // Mirror the prefetch script's own plan: every manifest frame except
  // data-gated (unavailable) hours is warmable — raw GRIBs are fetched on
  // demand, so frames need not be fully rendered. Keeping the predicates
  // aligned keeps this frameCount honest, though the job bar's denominator is
  // ultimately the script's OWN "planned tasks=N" line.
  const hourStatus = manifest.hourStatus && typeof manifest.hourStatus === "object" ? manifest.hourStatus : {};
  const loadedHours = [];
  for (const frame of manifest.frames) {
    const hour = Number(frame.hour);
    if (Number.isFinite(hour) && hourStatus[String(hour)] !== "unavailable") {
      loadedHours.push(hour);
    }
  }
  if (loadedHours.length === 0) {
    return { error: `${modelKey} run ${runId} has no warmable frames on ${viewKey} — render it first.` };
  }
  // Alias-aware, same as the render path: a running run="latest" render may
  // be building exactly this cycle (it stays "latest" until the child logs
  // its resolved run), so the exact-match comparison is not enough to keep
  // two children off one run tree.
  if (actions.jobs.hasJobConflict(modelKey, runId, viewKey)) {
    return { conflict: `A job for ${modelKey}/${runId}/${viewKey} is already running.` };
  }
  return { modelKey, runId, loadedHours };
}

async function handlePrefetchSoundingsRequest(runtime, req, res, actions) {
  if (req.method !== "POST") {
    sendJsonError(res, 405, "prefetch-soundings only accepts POST.");
    return;
  }
  if (!isAllowedPostOrigin(req.headers.origin, req.headers.host)) {
    sendJsonError(res, 403, "Cross-origin requests are not allowed on this route.");
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJsonError(res, 400, String(error && error.message ? error.message : error));
    return;
  }
  // Same gate as /actions/render: prefetches write raw GRIBs into trees a
  // running prune/clear may be deleting.
  if ((actions.cacheMutationCount || 0) > 0) {
    sendJsonError(res, 409, "A cache prune/clear is in progress; retry once it finishes.");
    return;
  }
  // `models` + per-model `runs` (mirrors /actions/render); legacy single
  // {model, run} still accepted.
  const rawModels = Array.isArray(body.models) ? body.models : body.model !== undefined ? [body.model] : [];
  const models = Array.from(
    new Set(
      rawModels.map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      ),
    ),
  );
  const viewKey = String(body.view || runtime.defaultViewKey).trim();
  const fallbackRun = String(body.run || "latest").trim();
  if (models.length === 0) {
    sendJsonError(res, 400, "At least one model is required.");
    return;
  }
  for (const modelKey of models) {
    if (!isAllowedModel(modelKey) || !isSafePathComponent(modelKey)) {
      sendJsonError(res, 400, `Unsupported model '${modelKey}'.`);
      return;
    }
  }
  if (!isAllowedView(viewKey) || !isSafePathComponent(viewKey)) {
    sendJsonError(res, 400, `Unsupported view '${viewKey}'.`);
    return;
  }
  const runsInput = body.runs && typeof body.runs === "object" ? body.runs : {};
  const requestedRunByModel = {};
  for (const [key, rawValue] of Object.entries(runsInput)) {
    if (!models.includes(key)) {
      sendJsonError(res, 400, `runs['${key}'] does not match a selected model.`);
      return;
    }
    const value = String(rawValue || "").trim();
    if (value !== "latest" && (!isSafePathComponent(value) || !parseRunId(value))) {
      sendJsonError(res, 400, `Unsupported run '${value}' for model '${key}'.`);
      return;
    }
    requestedRunByModel[key] = value;
  }
  for (const modelKey of models) {
    const requested = requestedRunByModel[modelKey] || fallbackRun;
    if (requested !== "latest" && (!isSafePathComponent(requested) || !parseRunId(requested))) {
      sendJsonError(res, 400, `Unsupported run '${requested}'.`);
      return;
    }
    requestedRunByModel[modelKey] = requested;
  }
  // Fail loud on malformed hours, mirroring the CLI's parseHoursArg: rounding
  // or dropping bad tokens silently rewrites the request, and an all-invalid
  // list would OMIT --hours below — warming every loaded frame of the run.
  let hours = [];
  if (body.hours !== undefined && body.hours !== null) {
    if (!Array.isArray(body.hours)) {
      sendJsonError(res, 400, "hours must be an array of non-negative integers.");
      return;
    }
    for (const entry of body.hours) {
      const value = strictJsonNumber(entry);
      if (value === null || !Number.isInteger(value) || value < 0) {
        sendJsonError(
          res,
          400,
          `Invalid forecast hour '${entry}' in hours; expected non-negative integers (e.g. 0,3,6).`,
        );
        return;
      }
      hours.push(value);
    }
    if (hours.length === 0) {
      sendJsonError(res, 400, "hours was provided but names no forecast hours; omit it to prefetch all loaded hours.");
      return;
    }
  }

  // Resolve every target; warm what CAN be warmed and report the rest as
  // skipped (targets are independent — one unbuilt model must not block
  // warming the others). The request only fails when nothing is warmable:
  // 409 when every skip was a pure job conflict, 400 otherwise.
  const targets = [];
  const skipped = [];
  const respondAllSkipped = () => {
    const allConflicts = skipped.length > 0 && skipped.every((entry) => entry.conflict);
    sendJsonError(res, allConflicts ? 409 : 400, skipped.map((entry) => entry.reason).join(" "));
  };
  for (const modelKey of models) {
    const target = await resolvePrefetchTarget(runtime, actions, modelKey, requestedRunByModel[modelKey], viewKey);
    if (target.error || target.conflict) {
      skipped.push({ model: modelKey, reason: target.error || target.conflict, conflict: Boolean(target.conflict) });
    } else {
      targets.push(target);
    }
  }
  if (targets.length === 0) {
    respondAllSkipped();
    return;
  }

  const jobs = [];
  let previousJob = null;
  for (const target of targets) {
    // Re-check before launch: resolving the other targets awaited pointer and
    // manifest reads, so a concurrent identical POST may have claimed this
    // (model, run, view) since resolvePrefetchTarget's check.
    if (actions.jobs.hasJobConflict(target.modelKey, target.runId, viewKey)) {
      skipped.push({
        model: target.modelKey,
        reason: `A job for ${target.modelKey}/${target.runId}/${viewKey} is already running.`,
        conflict: true,
      });
      continue;
    }
    const argv = [`--models=${target.modelKey}`, `--view=${viewKey}`, `--runs=${target.runId}`];
    if (hours.length > 0) {
      argv.push(`--hours=${hours.join(",")}`);
    }
    const targetHours = hours.length > 0 ? hours : target.loadedHours;
    // Chained, not parallel: each prefetch process opens its own NOAA
    // range-fetch lanes; models warm one after another to bound the burst.
    const job = actions.jobs.startJob({
      scriptPath: PREFETCH_SOUNDINGS_SCRIPT_PATH,
      argv,
      model: target.modelKey,
      run: target.runId,
      view: viewKey,
      kind: "prefetch-soundings",
      targetHours,
      after: previousJob,
    });
    previousJob = job;
    jobs.push({ jobId: job.jobId, models: [target.modelKey], run: target.runId, frameCount: targetHours.length });
  }
  if (jobs.length === 0) {
    // Every resolved target was claimed by a concurrent request mid-loop.
    respondAllSkipped();
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // `jobId` (first job) is kept for older clients of the single-job contract.
  res.end(JSON.stringify({ jobId: jobs[0].jobId, jobs, skipped }));
}

// On-disk marker fallback: count .complete.json markers for THIS build's hours.
// The on-disk manifest is union-merged by hour across builds of the same run
// (mergeManifestWithTemplate), so on a partial-hours rebuild its frame list can
// exceed this build's target and carry prior builds' markers. The denominator
// is the build's resolved hour count (spec §3.2): job.total (builder summary
// frameCount) first, then the caller's requested hours; the union-manifest
// length is only a last-resort fallback before either is known.
async function countCompleteMarkers(runtime, job) {
  const jobModels = Array.isArray(job?.models) && job.models.length > 0 ? job.models : [job?.model];
  const resolvedRun = jobModels.length === 1 ? String(job?.resolvedRunsByModel?.[job?.model] || job?.run || "") : "";
  if (
    !job ||
    jobModels.length !== 1 ||
    resolvedRun === "latest" ||
    !isSafePathComponent(resolvedRun) ||
    !isSafePathComponent(job.model) ||
    !isSafePathComponent(job.view)
  ) {
    const markerTotal =
      job?.total ||
      (Array.isArray(job?.targetHours) ? job.targetHours.length : 0) ||
      job?.built + job?.reused + job?.failed ||
      0;
    return {
      markerCount: Math.min((job?.built || 0) + (job?.reused || 0), markerTotal || Number.MAX_SAFE_INTEGER),
      markerTotal,
    };
  }
  // Sounding prefetches target frames that are ALREADY rendered (their
  // .complete.json markers pre-exist), so the render-marker scan would read
  // 100% from the first poll. Their real progress is the scraped
  // warmed/cached counters against the loaded-hour target.
  if (job.kind === "prefetch-soundings") {
    const markerTotal =
      job.total || (Array.isArray(job.targetHours) ? job.targetHours.length : 0) || job.built + job.reused + job.failed;
    return { markerCount: Math.min(job.built + job.reused, markerTotal || Number.MAX_SAFE_INTEGER), markerTotal };
  }
  const manifest = await runtime.readManifestFromDisk(job.model, resolvedRun, job.view);
  const frames = Array.isArray(manifest?.frames) ? manifest.frames : [];
  const requestedHours = Array.isArray(job.targetHours) && job.targetHours.length > 0 ? job.targetHours : null;
  const markerTotal = job.total || (requestedHours ? requestedHours.length : 0) || frames.length || 0;
  // Numerator: only markers for hours this build is producing count — the
  // requested hours when the caller named them, else the hours observed in the
  // builder's own F%03d progress lines. Cap at markerTotal so prior builds'
  // markers can never push progress past 100%.
  const targetHourSet = requestedHours
    ? new Set(requestedHours)
    : job.observedHours instanceof Set && job.observedHours.size > 0
      ? job.observedHours
      : null;
  // Only markers written AFTER this job started count: a re-render (e.g.
  // rendering the remaining categories of a partially-selected run, which
  // forces frames) starts with every marker already on disk from the earlier
  // build — counting those reads 100% before any frame renders.
  const startedAtMs = Date.parse(job.startedAt) || 0;
  let markerCount = 0;
  for (const frame of frames) {
    const hour = Number(frame.hour);
    if (!Number.isFinite(hour) || (targetHourSet && !targetHourSet.has(hour))) {
      continue;
    }
    if (markerTotal > 0 && markerCount >= markerTotal) {
      break;
    }
    const markerMtime = await fileMtimeMs(runtime.getFrameMarkerPath(job.model, resolvedRun, job.view, hour));
    if (markerMtime !== null && markerMtime >= startedAtMs) {
      markerCount += 1;
    }
  }
  return { markerCount, markerTotal };
}

async function fileMtimeMs(filePath) {
  try {
    return (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

async function handleStatusRequest(runtime, req, res, actions, jobId) {
  if (req.method !== "GET") {
    sendJsonError(res, 405, "status only accepts GET.");
    return;
  }
  const job = actions.jobs.getJob(jobId);
  if (!job) {
    sendJsonError(res, 404, `No job '${jobId}'.`);
    return;
  }
  const { markerCount, markerTotal } = await countCompleteMarkers(runtime, job);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ...publicJobView(job), markerCount, markerTotal }));
}

function handleCancelRequest(req, res, actions, jobId) {
  if (req.method !== "POST") {
    sendJsonError(res, 405, "cancel only accepts POST.");
    return;
  }
  if (!isAllowedPostOrigin(req.headers.origin, req.headers.host)) {
    sendJsonError(res, 403, "Cross-origin requests are not allowed on this route.");
    return;
  }
  const job = actions.jobs.cancelJob(jobId);
  if (!job) {
    sendJsonError(res, 404, `No job '${jobId}'.`);
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ok: true, jobId: job.jobId, status: job.status }));
}

function handleJobsRequest(req, res, actions) {
  if (req.method !== "GET") {
    sendJsonError(res, 405, "jobs only accepts GET.");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ jobs: actions.jobs.listJobs() }));
}

// Cache stats are a full-tree size walk (minutes-old data is fine; the real
// cache is hundreds of GB), so results are cached with a short TTL and
// concurrent requests share one in-flight scan. `?refresh=1` forces a rescan.
const CACHE_STATS_TTL_MS = 60_000;

async function handleCacheStatsRequest(runtime, req, requestUrl, res, actions) {
  if (req.method !== "GET") {
    sendJsonError(res, 405, "cache-stats only accepts GET.");
    return;
  }
  const refresh = requestUrl.searchParams.get("refresh") === "1";
  const cached = actions.cacheStats;
  if (!refresh && cached && Date.now() - cached.computedAtMs < CACHE_STATS_TTL_MS) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(cached.payload));
    return;
  }
  let payload;
  // Generation loop: a prune/clear that lands while a scan is in flight
  // invalidates it (generation bump + inFlight reset). Serving or re-caching
  // that pre-mutation payload would show hundreds of GB that were just
  // deleted, so a stale resolve triggers one fresh rescan instead.
  let doRefresh = refresh;
  for (;;) {
    const generation = actions.cacheStatsGeneration || 0;
    let inFlight = actions.cacheStatsInFlight;
    if (!inFlight || doRefresh) {
      inFlight = computeCacheStats(runtime.cacheRoot).finally(() => {
        if (actions.cacheStatsInFlight === inFlight) {
          actions.cacheStatsInFlight = null;
        }
      });
      actions.cacheStatsInFlight = inFlight;
      doRefresh = false;
    }
    payload = await inFlight;
    if ((actions.cacheStatsGeneration || 0) === generation) {
      actions.cacheStats = { payload, computedAtMs: Date.now() };
      break;
    }
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

// Drop every cached/in-flight stats artifact after a destructive cache op.
function invalidateCacheStats(actions) {
  actions.cacheStats = null;
  actions.cacheStatsInFlight = null;
  actions.cacheStatsGeneration = (actions.cacheStatsGeneration || 0) + 1;
}

// Shared gate for the cache mutation routes: POST + localhost origin + no
// active jobs (a prune/clear under a running builder deletes files it is
// mid-write on). Returns the parsed body object, or null after responding.
async function readCacheMutationBody(req, res, actions, label) {
  if (req.method !== "POST") {
    sendJsonError(res, 405, `${label} only accepts POST.`);
    return null;
  }
  if (!isAllowedPostOrigin(req.headers.origin, req.headers.host)) {
    sendJsonError(res, 403, "Cross-origin requests are not allowed on this route.");
    return null;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJsonError(res, 400, String(error && error.message ? error.message : error));
    return null;
  }
  if (actions.jobs.hasActiveJobs()) {
    sendJsonError(res, 409, "Cache operations are blocked while render/prefetch jobs are active.");
    return null;
  }
  // JSON bodies like the literal `null`, a string, or an array parse fine but
  // are not selection objects — and null would collide with the "already
  // responded" sentinel above, leaving the request hanging with no reply.
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

async function handleCachePruneRequest(runtime, req, res, actions) {
  const body = await readCacheMutationBody(req, res, actions, "cache/prune");
  if (body === null) {
    return;
  }
  // dryRun defaults TRUE: real deletion requires an explicit dryRun:false.
  const dryRun = body.dryRun !== false;
  const keepRaw = body.keep === undefined ? 4 : strictJsonNumber(body.keep);
  if (keepRaw === null || !Number.isInteger(keepRaw) || keepRaw < 1 || keepRaw > 24) {
    sendJsonError(res, 400, "keep must be an integer between 1 and 24.");
    return;
  }
  let budgetBytes = null;
  if (body.budgetGb !== undefined && body.budgetGb !== null) {
    const budgetGb = strictJsonNumber(body.budgetGb);
    if (budgetGb === null || budgetGb <= 0) {
      sendJsonError(res, 400, "budgetGb must be a positive number.");
      return;
    }
    budgetBytes = budgetGb * 1024 ** 3;
  }
  // Destructive prunes hold the mutation latch so a render/prefetch POST
  // cannot spawn a builder into directories that are mid-deletion; dry runs
  // only read and stay latch-free.
  if (!dryRun) {
    actions.cacheMutationCount = (actions.cacheMutationCount || 0) + 1;
  }
  let result;
  try {
    result = await executeCachePrune(runtime.cacheRoot, { dryRun, keepRuns: keepRaw, budgetBytes });
  } finally {
    if (!dryRun) {
      actions.cacheMutationCount -= 1;
    }
  }
  if (!dryRun) {
    invalidateCacheStats(actions);
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(result));
}

async function handleCacheClearRequest(runtime, req, res, actions) {
  const body = await readCacheMutationBody(req, res, actions, "cache/clear");
  if (body === null) {
    return;
  }
  // Typed confirmation: clearing drops EVERY rendered run and raw input. The
  // exact token is the contract with the UI's confirm field.
  if (body.confirm !== "CLEAR") {
    sendJsonError(res, 400, 'cache/clear requires { confirm: "CLEAR" }.');
    return;
  }
  actions.cacheMutationCount = (actions.cacheMutationCount || 0) + 1;
  let result;
  try {
    result = await executeCacheClear(runtime.cacheRoot);
  } finally {
    actions.cacheMutationCount -= 1;
  }
  invalidateCacheStats(actions);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ok: true, removedBytes: result.removedBytes }));
}

async function handleAssetRequest(runtime, requestPath, res) {
  const parts = requestPath.replace(/^\/+/, "").split("/");
  if (parts.length < 6) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const [, , , , hourText] = parts;
  const hour = Number(hourText);
  if (!Number.isFinite(hour)) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const relativeKey = requestPath.replace(/^\/+/, "");
  const filePath = runtime.getArtifactStoragePath(relativeKey);
  // Reject decoded "../" traversal (e.g. "..%2F") that would escape the artifact root.
  if (!isPathWithinRoot(filePath, runtime.artifactRoot)) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  if (!(await pathExists(filePath))) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const body = await fs.promises.readFile(filePath);
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeFor(filePath));
  const contentEncoding = encodingFor(filePath);
  if (contentEncoding) {
    res.setHeader("Content-Encoding", contentEncoding);
  }
  res.setHeader("Cache-Control", "public,max-age=31536000,immutable");
  res.end(body);
}

// The pmtiles JS protocol probes with single `bytes=a-b` GETs (plus open-ended
// `bytes=a-` and suffix `bytes=-n` forms, and the occasional HEAD). It never
// sends multi-range requests, so a comma'd (or otherwise malformed) header is
// ignored per RFC 7233 and answered with the full 200 body instead of growing a
// multipart/byteranges encoder. Returns one of:
//   { kind: "none" }               — no/ignorable Range header → 200 full body
//   { kind: "range", start, end }  — satisfiable single range → 206
//   { kind: "unsatisfiable" }      — → 416 with `Content-Range: bytes */total`
function parseByteRange(rawHeader, totalBytes) {
  const header = String(rawHeader || "").trim();
  if (!header) {
    return { kind: "none" };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) {
    return { kind: "none" };
  }
  const [, startText, endText] = match;
  if (startText === "") {
    // Suffix form: the last N bytes. N=0 (and any suffix of an empty file) is
    // unsatisfiable; N >= total serves the whole file as a 206.
    const suffixLength = Number(endText);
    if (suffixLength === 0 || totalBytes === 0) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "range", start: Math.max(0, totalBytes - suffixLength), end: totalBytes - 1 };
  }
  const start = Number(startText);
  if (start >= totalBytes) {
    return { kind: "unsatisfiable" };
  }
  const end = endText === "" ? totalBytes - 1 : Math.min(Number(endText), totalBytes - 1);
  if (end < start) {
    return { kind: "none" }; // invalid byte-range-spec → ignore the header (RFC 7233 §3.1)
  }
  return { kind: "range", start, end };
}

async function handleBasemapRequest(req, requestPath, res, basemapRoot) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJsonError(res, 405, "basemap only accepts GET or HEAD.");
    return;
  }
  // Single `<stem>.pmtiles` component; the SAFE_PATH_COMPONENT gate on the stem
  // rejects ".", "..", separators, and any decoded traversal sequence.
  const match = requestPath.match(/^\/basemap\/([^/]+)\.pmtiles$/);
  if (!match || !isSafePathComponent(match[1])) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const filePath = path.join(basemapRoot, `${match[1]}.pmtiles`);
  // Defense-in-depth alongside the name gate, mirroring handleAssetRequest.
  if (!isPathWithinRoot(filePath, basemapRoot)) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  let stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    res.statusCode = 404; // includes the whole output/basemap/ dir not existing yet
    res.end("Not Found");
    return;
  }
  if (!stats.isFile()) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const totalBytes = stats.size;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentTypeFor(filePath));
  // Extracts are regenerated in place (no content-addressed name), so never let
  // the browser cache a stale slice across a re-fetch of the basemap.
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("Content-Length", totalBytes);
    res.end();
    return;
  }
  const range = parseByteRange(req.headers.range, totalBytes);
  if (range.kind === "unsatisfiable") {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${totalBytes}`);
    res.end();
    return;
  }
  let stream;
  if (range.kind === "range") {
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${totalBytes}`);
    res.setHeader("Content-Length", range.end - range.start + 1);
    stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
  } else {
    res.statusCode = 200;
    res.setHeader("Content-Length", totalBytes);
    stream = fs.createReadStream(filePath);
  }
  // pipeline() tears down both sides on error/early-close; by then headers are
  // already sent, so there is no 500 to fall back to — just drop the socket.
  pipeline(stream, res, () => {});
}

function pointInsideBounds(lat, lon, bounds) {
  const north = Number(bounds?.north);
  const south = Number(bounds?.south);
  const west = Number(bounds?.west);
  const east = Number(bounds?.east);
  const normalizedLon = Number(lon) > 180 ? Number(lon) - 360 : Number(lon);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(normalizedLon) &&
    Number.isFinite(north) &&
    Number.isFinite(south) &&
    Number.isFinite(west) &&
    Number.isFinite(east) &&
    lat <= north &&
    lat >= south &&
    normalizedLon >= west &&
    normalizedLon <= east
  );
}

function resolveWgrib2Path() {
  const configured = String(process.env.WGRIB2 || "").trim();
  if (configured) {
    return configured;
  }
  const local = path.resolve(__dirname, "../..", "output/noaa-beta-tools/bin/wgrib2");
  return fs.existsSync(local) ? local : "wgrib2";
}

function sendJsonError(res, statusCode, message) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: message }));
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
  // Range: pmtiles fetches send `Range: bytes=a-b`, which is not a
  // CORS-safelisted request header, so cross-origin reads (app on :4173/:5173,
  // data on :5174) preflight it. Content-Range/Accept-Ranges are likewise not
  // safelisted response headers, so expose them for the pmtiles client.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,If-None-Match,Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range,Accept-Ranges,Content-Length,ETag");
}

function contentTypeFor(filePath) {
  const normalized = String(filePath || "").toLowerCase();
  if (normalized.endsWith(".json.gz") || normalized.endsWith(".json.br") || normalized.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (normalized.endsWith(".png")) {
    return "image/png";
  }
  return "application/octet-stream";
}

function encodingFor(filePath) {
  const normalized = String(filePath || "").toLowerCase();
  if (normalized.endsWith(".json.gz") || normalized.endsWith(".bin.gz")) {
    return "gzip";
  }
  if (normalized.endsWith(".json.br") || normalized.endsWith(".bin.br")) {
    return "br";
  }
  return null;
}

async function pathExists(filePath) {
  try {
    await fs.promises.access(path.resolve(filePath));
    return true;
  } catch {
    return false;
  }
}

function isPathWithinRoot(filePath, rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(filePath);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
}

module.exports = {
  createLocalArtifactServer,
  buildBuilderArgv,
  readJsonBody,
  targetHoursForMaxHour,
  contentTypeFor,
  encodingFor,
  ACTION_MODEL_KEYS,
  ACTION_VIEW_KEYS,
  ACTION_CATEGORY_IDS,
  ACTION_TIERS,
};
