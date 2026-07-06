"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");
const { LocalArtifactRuntime } = require("./local-artifact-runtime");
const { buildNoaaPointSounding } = require("./noaa-beta-renderer");
const {
  buildFullHoursForModel,
  buildRecentCycleCandidates,
  mapWithConcurrency,
  noaaForecastHourExists,
  resolveNoaaBaseUrls,
} = require("./noaa-build/run-resolution");

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
  const server = http.createServer((req, res) => {
    void handleRequest(runtime, req, res, actions).catch((error) => {
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

// Run ids on this control surface are `YYYYMMDD-HHMMZ` (built manifest stems and
// upstream `${date}-${cycle}00Z` ids alike). The builder has no --run flag — a
// picked run is translated to its tested --date/--cycle resolution path — so the
// shape must parse strictly BEFORE anything reaches a spawn argv. Returns
// { date, cycle } or null.
const RUN_ID_PATTERN = /^(\d{8})-(\d{2})\d{2}Z$/;

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

// Enum allowlists for the /actions/* control surface. The server spawns
// processes, so every model/view/category/tier is validated against a fixed
// set before it can reach a path builder or a spawn argv (spec §3.3).
const ACTION_MODEL_KEYS = Object.freeze(["gfs", "nam", "nam3km", "hrrr"]);
const ACTION_VIEW_KEYS = Object.freeze(["conus", "na"]);
const ACTION_CATEGORY_IDS = Object.freeze(["surface", "precip", "radar", "cloud", "severe", "winter", "upperAir"]);
const ACTION_TIERS = Object.freeze(["simple", "full"]);

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

// Default per-run frame probe: NOAA publishes forecast hours as a contiguous
// prefix of the model's full hour list (the same assumption the builder's
// resolveAvailableNoaaHours makes), so a binary search over that list finds
// the highest published hour in ~log2(N) HEAD requests instead of N. f000 is
// verified first so an expired/offline run reads null, never "1 frame".
// Returns { frameCount, maxHour } or null.
async function probeRunFrameCountDefault({ modelKey, run }) {
  const noaaBaseUrl = resolveNoaaBaseUrls({}, [modelKey])[modelKey];
  const hours = buildFullHoursForModel(modelKey);
  try {
    if (!(await noaaForecastHourExists({ modelKey, noaaBaseUrl, run, hour: hours[0] }))) {
      return null;
    }
    let lo = 0;
    let hi = hours.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (await noaaForecastHourExists({ modelKey, noaaBaseUrl, run, hour: hours[mid] })) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { frameCount: lo + 1, maxHour: hours[lo] };
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
  const fullCount = buildFullHoursForModelSafe(modelKey);
  actions.runFrameCountCache.set(cacheKey, {
    fetchedAt: Date.now(),
    complete: Boolean(result && fullCount !== null && result.frameCount >= fullCount),
    result: result || null,
  });
  return result || null;
}

function buildFullHoursForModelSafe(modelKey) {
  try {
    return buildFullHoursForModel(modelKey).length;
  } catch {
    return null;
  }
}

async function handleRequest(runtime, req, res, actions) {
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
  if (requestPath.startsWith("/actions/status/")) {
    const jobId = requestPath.slice("/actions/status/".length);
    await handleStatusRequest(runtime, req, res, actions, jobId);
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
  const lat = Number(requestUrl.searchParams.get("lat"));
  const lon = Number(requestUrl.searchParams.get("lon"));
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
      // Every row carries how many frames NOAA has published for that run
      // (they differ per run: still-uploading cycles and short-horizon
      // off-cycles). Upstream rows: upstreamFrameCount is what a render would
      // build. Built rows: comparing it to the manifest's frameCount shows
      // when a re-render would pick up more frames. Probe failures degrade to
      // null, never a 500.
      const fullCount = buildFullHoursForModelSafe(modelKey);
      const annotatedUpstream = await mapWithConcurrency(upstream, 6, async (run) => {
        const probed = await getCachedRunFrameCount(actions, modelKey, run.runId);
        return { ...run, frameCount: probed ? probed.frameCount : null, maxHour: probed ? probed.maxHour : null };
      });
      const annotatedBuilt = await mapWithConcurrency(built, 6, async (run) => {
        // A run already at the model's full horizon cannot gain frames —
        // skip its probe entirely (most built runs, most picker opens).
        if (fullCount !== null && Number(run.frameCount) >= fullCount) {
          return { ...run, upstreamFrameCount: run.frameCount, upstreamMaxHour: null };
        }
        const probed = await getCachedRunFrameCount(actions, modelKey, run.run);
        return {
          ...run,
          upstreamFrameCount: probed ? probed.frameCount : null,
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

  // A job is a duplicate when ANY of its requested models overlaps a running
  // or queued job's models for the same (run, view) — a multi-model job blocks
  // each of its models individually, not just models[0].
  hasRunningJob(model, run, view) {
    for (const job of this.jobs.values()) {
      if ((job.status !== "running" && job.status !== "queued") || job.run !== run || job.view !== view) {
        continue;
      }
      const jobModels = Array.isArray(job.models) && job.models.length > 0 ? job.models : [job.model];
      if (jobModels.includes(model)) {
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
      // Hours explicitly requested by the caller (prefetch); null when the
      // builder resolves its own target (render).
      targetHours: Array.isArray(targetHours) && targetHours.length > 0 ? Array.from(new Set(targetHours)) : null,
      // Hours seen in this build's own F%03d progress lines — the derivable
      // target set for builds whose hours are resolved child-side.
      observedHours: new Set(),
      log: [],
      error: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      _queue: [],
    };
    this.jobs.set(jobId, job);
    const launch = () => {
      if (job.status !== "queued") {
        return; // cancelled (e.g. shutdown) while waiting
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
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.pid = child.pid || null;
    this.children.add(child);
    const onLine = (line) => this.applyLogLine(job, line);
    attachLineReader(child.stdout, onLine);
    attachLineReader(child.stderr, onLine);
    child.on("exit", (code) => {
      this.children.delete(child);
      if (!job.endedAt) {
        job.endedAt = new Date().toISOString();
      }
      if (job.status === "running") {
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
      if (job.status === "running") {
        job.status = "failed";
        job.error = `Builder process error: ${String(error && error.message ? error.message : error)}`;
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
      const match = summary.results.find((entry) => String(entry.model) === job.model) || summary.results[0];
      if (match) {
        job.built = Number(match.built) || job.built;
        job.reused = Number(match.reused) || job.reused;
        job.failed = Number(match.failed) || job.failed;
        job.total = Number(match.frameCount) || job.total;
        if (String(summary.results[0]?.run || "").trim() && job.run === "latest") {
          job.run = String(match.run || job.run);
        }
      }
    } else if (text.startsWith("{") || (job._summaryBuffer !== undefined && job._summaryBuffer !== null)) {
      job._summaryBuffer = (job._summaryBuffer || "") + text + "\n";
    }
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
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
        reject(new Error("Request body too large."));
        req.destroy();
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
  // YYYYMMDD-HHMMZ shape the --date/--cycle translation depends on.
  if (run !== "latest" && (!isSafePathComponent(run) || !parseRunId(run))) {
    return fail(`Unsupported run '${run}'. Expected 'latest' or YYYYMMDD-HHMMZ.`);
  }
  // Per-model runs map (run cycles differ per model — HRRR is hourly, NAM3km
  // 4×/day). Every key must be a selected model; every value passes the same
  // strict run gate as `run`. Models absent from the map fall back to `run`.
  const runsInput = selection.runs && typeof selection.runs === "object" ? selection.runs : {};
  const runsByModel = {};
  for (const [key, rawValue] of Object.entries(runsInput)) {
    if (!models.includes(key)) {
      return fail(`runs['${key}'] does not match a selected model.`);
    }
    const value = String(rawValue || "").trim();
    if (value !== "latest" && (!isSafePathComponent(value) || !parseRunId(value))) {
      return fail(`Unsupported run '${value}' for model '${key}'. Expected 'latest' or YYYYMMDD-HHMMZ.`);
    }
    runsByModel[key] = value;
  }
  for (const modelKey of models) {
    if (!runsByModel[modelKey]) {
      runsByModel[modelKey] = run;
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
    },
  };
}

// Group the selected models by their effective run choice, preserving model
// order. Models sharing a run (or all-latest) build in ONE job so the global
// frame queue keeps sharing workers across models; only divergent picks split.
function groupModelsByRun(normalized) {
  const groups = new Map();
  for (const modelKey of normalized.models) {
    const runKey = normalized.runsByModel[modelKey] || normalized.run || "latest";
    if (!groups.has(runKey)) {
      groups.set(runKey, []);
    }
    groups.get(runKey).push(modelKey);
  }
  return groups;
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
// published frames — and is orthogonal to the selection-flag parity rule:
// per-frame artifacts stay byte-identical to a no-flags CLI build.)
function buildBuilderArgv(normalized) {
  // --full: UI renders target every published frame for the run (the builder
  // caps to what NOAA has actually uploaded via resolveAvailableNoaaHours).
  // Without it the builder falls back to DEFAULT_HOURS = [0,3,6].
  const argv = [`--models=${normalized.models.join(",")}`, `--view=${normalized.view}`, "--full"];
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
      throw new Error(`Run '${normalized.run}' is not a valid YYYYMMDD-HHMMZ run id.`);
    }
    argv.push(`--date=${parsedRun.date}`, `--cycle=${parsedRun.cycle}`);
  }
  return argv;
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
  const { normalized } = result;
  // One builder job per distinct run choice (models sharing a run stay in one
  // job). Conflicts are checked across ALL groups before ANY spawn so a
  // rejected request never leaves a partial set of builds running.
  const groups = groupModelsByRun(normalized);
  for (const [runKey, groupModels] of groups) {
    for (const modelKey of groupModels) {
      if (actions.jobs.hasRunningJob(modelKey, runKey, normalized.view)) {
        sendJsonError(res, 409, `A render for ${modelKey}/${runKey}/${normalized.view} is already running.`);
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
  if (actions.jobs.hasRunningJob(modelKey, runId, viewKey)) {
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
  const hours = Array.isArray(body.hours)
    ? body.hours.map((value) => Math.round(Number(value))).filter((value) => Number.isFinite(value) && value >= 0)
    : [];

  // Resolve every target; warm what CAN be warmed and report the rest as
  // skipped (targets are independent — one unbuilt model must not block
  // warming the others). The request only fails when nothing is warmable.
  const targets = [];
  const skipped = [];
  for (const modelKey of models) {
    const target = await resolvePrefetchTarget(runtime, actions, modelKey, requestedRunByModel[modelKey], viewKey);
    if (target.error || target.conflict) {
      skipped.push({ model: modelKey, reason: target.error || target.conflict });
    } else {
      targets.push(target);
    }
  }
  if (targets.length === 0) {
    const allConflicts = skipped.length > 0 && skipped.every((entry) => /already running/i.test(entry.reason));
    sendJsonError(res, allConflicts ? 409 : 400, skipped.map((entry) => entry.reason).join(" "));
    return;
  }

  const jobs = [];
  let previousJob = null;
  for (const target of targets) {
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
  if (!job || job.run === "latest" || !isSafePathComponent(job.model) || !isSafePathComponent(job.view)) {
    return { markerCount: job?.built || 0, markerTotal: job?.total || 0 };
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
  const manifest = await runtime.readManifestFromDisk(job.model, job.run, job.view);
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
    const markerMtime = await fileMtimeMs(runtime.getFrameMarkerPath(job.model, job.run, job.view, hour));
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
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,If-None-Match");
}

function contentTypeFor(filePath) {
  const normalized = String(filePath || "").toLowerCase();
  if (normalized.endsWith(".json.gz") || normalized.endsWith(".json")) {
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
  ACTION_MODEL_KEYS,
  ACTION_VIEW_KEYS,
  ACTION_CATEGORY_IDS,
  ACTION_TIERS,
};
