"use strict";

const fs = require("fs");

// Shared .env loader: never overrides variables already present in env,
// matching the historical behavior of the per-script copies it replaces.
function loadDotEnv(filePath, env = process.env) {
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
    if (!(key in env)) {
      env[key] = value;
    }
  }
}

function resolveCacheRootEnv(env = process.env, { warn = console.warn } = {}) {
  const canonical = String(env.MODELVIEW_CACHE_ROOT || "").trim();
  if (canonical) {
    return canonical;
  }
  const alias = String(env.MODELVIEW_NOAA_BETA_CACHE_ROOT || "").trim();
  if (alias) {
    warn("[modelview] MODELVIEW_NOAA_BETA_CACHE_ROOT is deprecated; set MODELVIEW_CACHE_ROOT instead.");
    return alias;
  }
  return undefined;
}

module.exports = {
  loadDotEnv,
  resolveCacheRootEnv,
};
