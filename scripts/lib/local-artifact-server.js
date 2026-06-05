"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { LocalArtifactRuntime } = require("./local-artifact-runtime");
const { buildNoaaPointSounding } = require("./noaa-beta-renderer");

function createLocalArtifactServer(options = {}) {
  const runtime = options.runtime || new LocalArtifactRuntime(options);
  const server = http.createServer((req, res) => {
    void handleRequest(runtime, req, res).catch((error) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: String(error && error.message ? error.message : error),
        }),
      );
    });
  });
  return { runtime, server };
}

async function handleRequest(runtime, req, res) {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  const requestPath = decodeURIComponent(requestUrl.pathname || "/");
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
    await handleManifestRequest(runtime, requestPath, requestUrl, res);
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
  res.statusCode = 404;
  res.end("Not Found");
}

async function handleManifestRequest(runtime, requestPath, requestUrl, res) {
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
  if (!runMatch) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  const manifest = await runtime.readManifestFromDisk(modelKey, runMatch[1], viewKey);
  if (!manifest) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(manifest));
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

module.exports = {
  createLocalArtifactServer,
};
