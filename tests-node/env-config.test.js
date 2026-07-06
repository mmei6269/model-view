"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { loadDotEnv, resolveCacheRootEnv } = require("../scripts/lib/env-config");

test("resolveCacheRootEnv prefers the canonical MODELVIEW_CACHE_ROOT without warning", () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(
    resolveCacheRootEnv({ MODELVIEW_CACHE_ROOT: "canonical", MODELVIEW_NOAA_BETA_CACHE_ROOT: "legacy" }, { warn }),
    "canonical",
  );
  assert.deepEqual(warnings, []);
});

test("resolveCacheRootEnv accepts the deprecated alias with a warning", () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(resolveCacheRootEnv({ MODELVIEW_NOAA_BETA_CACHE_ROOT: "legacy" }, { warn }), "legacy");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /MODELVIEW_NOAA_BETA_CACHE_ROOT is deprecated/);
});

test("resolveCacheRootEnv returns undefined when neither variable is set", () => {
  const warnings = [];
  assert.equal(resolveCacheRootEnv({}, { warn: (message) => warnings.push(message) }), undefined);
  assert.deepEqual(warnings, []);
});

test("loadDotEnv parses quotes, skips comments, and never overrides existing keys", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-env-"));
  const envPath = path.join(dir, ".env");
  await fs.promises.writeFile(
    envPath,
    ["# comment", "", "MODELVIEW_CACHE_ROOT=output/from-dotenv", 'QUOTED="hello world"', "EXISTING=from-dotenv"].join(
      "\n",
    ),
  );
  const env = { EXISTING: "from-process" };
  loadDotEnv(envPath, env);
  assert.equal(env.MODELVIEW_CACHE_ROOT, "output/from-dotenv");
  assert.equal(env.QUOTED, "hello world");
  assert.equal(env.EXISTING, "from-process");
  loadDotEnv(path.join(dir, "missing.env"), env);
  assert.equal(env.MODELVIEW_CACHE_ROOT, "output/from-dotenv");
});
