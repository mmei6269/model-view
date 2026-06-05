#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { createLocalArtifactServer } = require("./lib/local-artifact-server");

const ROOT_DIR = path.resolve(__dirname, "..");

async function main() {
  loadDotEnv(path.join(ROOT_DIR, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const port = Number.isFinite(Number(args.port)) ? Number(args.port) : Number(process.env.MODELVIEW_DATA_PORT || 5174);
  const host = String(args.host || process.env.MODELVIEW_DATA_HOST || "127.0.0.1");
  const cacheRoot = args["cache-root"] || process.env.MODELVIEW_CACHE_ROOT || undefined;
  const artifactPrefix = args["artifact-prefix"] || process.env.MODELVIEW_ARTIFACT_PREFIX || undefined;
  const reflectivityGates = String(args["reflectivity-gates"] || process.env.MODELVIEW_REFLECTIVITY_GATES || "10,15,20")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);

  const { runtime, server } = createLocalArtifactServer({
    cacheRoot,
    artifactPrefix,
    reflectivityGates,
  });
  await runtime.init();

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, resolve);
  });

  const origin = `http://${host}:${port}`;
  console.log(`Local artifact server listening at ${origin}`);
  console.log(
    `Serving prebuilt NOAA artifacts from ${runtime.cacheRoot}. Run 'npm run noaa:build' if manifests are missing.`,
  );
  console.log(JSON.stringify(runtime.getStats(), null, 2));

  const shutdown = async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const trimmed = token.slice(2);
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex >= 0) {
      args[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[trimmed] = true;
      continue;
    }
    args[trimmed] = next;
    i += 1;
  }
  return args;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
