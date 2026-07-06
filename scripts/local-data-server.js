#!/usr/bin/env node

"use strict";

const path = require("path");
const { loadDotEnv, resolveCacheRootEnv } = require("./lib/env-config");
const { createLocalArtifactServer } = require("./lib/local-artifact-server");

const ROOT_DIR = path.resolve(__dirname, "..");

async function main() {
  loadDotEnv(path.join(ROOT_DIR, ".env"));
  const args = parseArgs(process.argv.slice(2));
  const port = Number.isFinite(Number(args.port)) ? Number(args.port) : Number(process.env.MODELVIEW_DATA_PORT || 5174);
  const host = String(args.host || process.env.MODELVIEW_DATA_HOST || "127.0.0.1");
  const cacheRoot = args["cache-root"] || resolveCacheRootEnv() || undefined;
  const artifactPrefix = args["artifact-prefix"] || process.env.MODELVIEW_ARTIFACT_PREFIX || undefined;
  const reflectivityGates = String(args["reflectivity-gates"] || process.env.MODELVIEW_REFLECTIVITY_GATES || "10,15,20")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);

  const { runtime, server, actions } = createLocalArtifactServer({
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
    actions.jobs.killAll("SIGTERM");
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

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
