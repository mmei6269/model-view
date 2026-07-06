#!/usr/bin/env node

"use strict";

const path = require("path");
const { spawn } = require("child_process");
const { loadDotEnv } = require("./lib/env-config");

const ROOT_DIR = path.resolve(__dirname, "..");

function buildPreviewEnv(dataOrigin, baseEnv = process.env) {
  const env = { ...baseEnv };
  env.MODELVIEW_ARTIFACT_BASE_URL = dataOrigin;
  // Preview is served from a different origin than the data server, so the browser
  // must know the absolute artifact base (the dev-only /__cf proxy is unavailable
  // outside DEV). CORS on the data server (P2.4a) makes the cross-origin read safe.
  env.VITE_ARTIFACT_BASE_URL = dataOrigin;
  return env;
}

async function main() {
  loadDotEnv(path.join(ROOT_DIR, ".env"));
  const previewArgs = process.argv.slice(2);
  const dataPort = Number(process.env.MODELVIEW_DATA_PORT || 5174);
  const dataHost = String(process.env.MODELVIEW_DATA_HOST || "127.0.0.1");
  const dataOrigin = `http://${dataHost}:${dataPort}`;
  let vite = null;

  const dataServer = spawn(process.execPath, [path.join(ROOT_DIR, "scripts/local-data-server.js")], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "inherit",
  });

  const shutdown = () => {
    if (!dataServer.killed) dataServer.kill("SIGTERM");
    if (vite && !vite.killed) vite.kill("SIGTERM");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await waitForHealth(`${dataOrigin}/healthz`, 30_000);

  const viteBin = path.join(ROOT_DIR, "node_modules/vite/bin/vite.js");
  vite = spawn(process.execPath, [viteBin, "preview", ...previewArgs], {
    cwd: ROOT_DIR,
    env: buildPreviewEnv(dataOrigin),
    stdio: "inherit",
  });

  const exitCode = await Promise.race([waitForExit(dataServer), waitForExit(vite)]);
  shutdown();
  process.exit(exitCode);
}

async function waitForHealth(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // retry until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for local data server health at ${url}`);
}

function waitForExit(child) {
  return new Promise((resolve) => child.on("exit", (code) => resolve(Number(code) || 0)));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = { buildPreviewEnv };
