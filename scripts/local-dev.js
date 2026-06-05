#!/usr/bin/env node

"use strict";

const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");

async function main() {
  const viteArgs = process.argv.slice(2);
  const dataPort = Number(process.env.MODELVIEW_DATA_PORT || 5174);
  const dataHost = String(process.env.MODELVIEW_DATA_HOST || "127.0.0.1");
  const dataOrigin = `http://${dataHost}:${dataPort}`;
  let vite = null;
  const viteEnv = buildViteEnv(dataOrigin);

  const dataServer = spawn(process.execPath, [path.join(ROOT_DIR, "scripts/local-data-server.js")], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: "inherit",
  });

  const shutdown = () => {
    if (!dataServer.killed) {
      dataServer.kill("SIGTERM");
    }
    if (vite && !vite.killed) {
      vite.kill("SIGTERM");
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await waitForHealth(`${dataOrigin}/healthz`, 30_000);

  const viteBin = path.join(ROOT_DIR, "node_modules/vite/bin/vite.js");
  vite = spawn(process.execPath, [viteBin, ...viteArgs], {
    cwd: ROOT_DIR,
    env: viteEnv,
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
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for local data server health at ${url}`);
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(Number(code) || 0));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildViteEnv(dataOrigin) {
  const env = { ...process.env };
  env.MODELVIEW_ARTIFACT_BASE_URL = dataOrigin;
  delete env.VITE_ARTIFACT_BASE_URL;
  return env;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
