"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("@playwright/test");
const { createLocalArtifactServer } = require("../scripts/lib/local-artifact-server");

const ROOT_DIR = path.resolve(__dirname, "..");

async function main() {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-local-integration-"));
  const { runtime, server } = createLocalArtifactServer({
    cacheRoot: tempDir,
    fetchLatestMetadata: async ({ modelKey }) => buildLatestMetadata(modelKey, "20260313-0000Z"),
    renderFrameArtifacts: async () => null,
  });
  await runtime.init();
  await runtime.buildLatestState("gfs", "conus");
  const prebuiltFrameRenders = runtime.getStats().frameRenders;
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const artifactOrigin = `http://127.0.0.1:${address.port}`;
  const vitePort = 4175;
  const vite = spawn(
    process.execPath,
    [path.join(ROOT_DIR, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(vitePort)],
    {
      cwd: ROOT_DIR,
      env: buildViteEnv(artifactOrigin),
      stdio: "inherit",
    },
  );

  try {
    await waitForHttp(`http://127.0.0.1:${vitePort}`);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${vitePort}`, { waitUntil: "domcontentloaded" });
      await page.locator("article").first().waitFor({ state: "visible", timeout: 15_000 });
      await waitForWeatherOverlay(page);
      const firstRenders = runtime.getStats().frameRenders;
      assert.equal(firstRenders, prebuiltFrameRenders, "expected site load to reuse prebuilt artifacts");

      const secondPage = await browser.newPage();
      await secondPage.goto(`http://127.0.0.1:${vitePort}`, { waitUntil: "domcontentloaded" });
      await secondPage.locator("article").first().waitFor({ state: "visible", timeout: 15_000 });
      await waitForWeatherOverlay(secondPage);
      const secondRenders = runtime.getStats().frameRenders;
      assert.equal(secondRenders, firstRenders, "expected second load to reuse the cached frame");
      await secondPage.close();
      await page.close();
    } finally {
      await browser.close();
    }
  } finally {
    vite.kill("SIGTERM");
    await new Promise((resolve) => vite.on("exit", () => resolve()));
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function buildLatestMetadata(modelKey, runId) {
  const referenceTime = runIdToReferenceTime(runId);
  const modelTokens = {
    gfs: "noaa-gfs-pgrb2-0p25",
    nam: "noaa-nam-awphys",
    nam3km: "noaa-nam-conusnest",
    hrrr: "noaa-hrrr-wrfprs",
  };
  return {
    modelKey,
    openDataModel: modelTokens[modelKey] || modelKey,
    latestUrl: "http://fixture/latest.json",
    referenceTime,
    runId,
    runPath: buildRunPathFromReference(referenceTime),
    validTimes: [referenceTime],
    crsWkt: 'GEOGCRS["WGS 84",BBOX[21,-129,53,-63]]',
    sourceBounds: { north: 53, south: 21, west: -129, east: -63 },
    rawLatest: {},
  };
}

function buildViteEnv(artifactOrigin) {
  const env = { ...process.env };
  delete env.VITE_ARTIFACT_BASE_URL;
  env.MODELVIEW_ARTIFACT_BASE_URL = artifactOrigin;
  return env;
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until Vite is ready.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForWeatherOverlay(page) {
  await page.waitForFunction(
    () => {
      const overlays = document.querySelectorAll(".leaflet-image-layer.wx-weather-overlay");
      return Array.from(overlays).some((element) => {
        const image = element;
        const style = window.getComputedStyle(image);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0 &&
          image.naturalWidth > 0 &&
          image.naturalHeight > 0
        );
      });
    },
    null,
    { timeout: 15_000 },
  );
}

function runIdToReferenceTime(runId) {
  const match = String(runId).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})00Z$/);
  if (!match) {
    throw new Error(`Unsupported test run id '${runId}'`);
  }
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:00:00Z`;
}

function buildRunPathFromReference(referenceTime) {
  const date = new Date(referenceTime);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}/${month}/${day}/${hour}${minute}Z`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
