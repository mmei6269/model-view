"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { loadDotEnv, resolveCacheRootEnv } = require("../scripts/lib/env-config");

const ROOT_DIR = path.resolve(__dirname, "..");

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

test("builder loads .env before parent renderer defaults are initialized", async (t) => {
  const sourceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-builder-env-"));
  t.after(() => fs.promises.rm(sourceRoot, { recursive: true, force: true }));
  const scriptsDir = path.join(sourceRoot, "scripts");
  const builderPath = path.join(scriptsDir, "build-noaa-beta-artifacts.js");
  const preloadPath = path.join(sourceRoot, "capture-renderer-config.cjs");
  await fs.promises.mkdir(scriptsDir, { recursive: true });
  await fs.promises.copyFile(path.join(ROOT_DIR, "scripts/build-noaa-beta-artifacts.js"), builderPath);
  await fs.promises.symlink(path.join(ROOT_DIR, "scripts/lib"), path.join(scriptsDir, "lib"), "dir");
  await fs.promises.writeFile(
    path.join(sourceRoot, ".env"),
    [
      "MODELVIEW_NOAA_HOVER_COMPRESSION=gzip",
      "MODELVIEW_NOAA_HOVER_GZIP_LEVEL=2",
      "MODELVIEW_NOAA_HOVER_BROTLI_QUALITY=5",
      "MODELVIEW_NOAA_HOVER_ENCODING=mvh3",
      "MODELVIEW_NOAA_HOVER_ARENA=off",
      "",
    ].join("\n"),
  );
  await fs.promises.writeFile(
    preloadPath,
    [
      '"use strict";',
      'const Module = require("node:module");',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const originalLoad = Module._load;",
      "Module._load = function capture(request, parent, isMain) {",
      '  if (request === "./lib/noaa-beta/source-provenance" && path.basename(parent?.filename || "") === "build-noaa-beta-artifacts.js") {',
      "    const root = process.env.MODELVIEW_TEST_REPO_ROOT;",
      '    const codec = require(path.join(root, "scripts/lib/hover-grid-compression.js"));',
      '    const runtime = require(path.join(root, "scripts/lib/modelview-runtime.js"));',
      '    const encoding = require(path.join(root, "scripts/lib/hover-grid-encoding.js"));',
      '    const hoverArena = require(path.join(root, "scripts/lib/noaa-beta/hover-arena.js"));',
      '    const body = codec.compressHoverGridSync(Buffer.from("builder-env-order"));',
      "    const key = runtime.buildFrameAssetKeySet({",
      '      modelKey: "hrrr", runId: "20260716-1300Z", viewKey: "conus", hour: 0, hoverGridFormat: "binary"',
      "    }).hoverGridKey;",
      "    fs.writeSync(1, JSON.stringify({",
      "      backend: codec.DEFAULT_HOVER_GRID_COMPRESSION.backend,",
      "      level: codec.DEFAULT_HOVER_GRID_COMPRESSION.level,",
      "      extension: codec.DEFAULT_HOVER_GRID_COMPRESSION.extension,",
      "      encodingId: encoding.HOVER_GRID_ENCODING.id,",
      "      encodingSchemaVersion: encoding.HOVER_GRID_ENCODING.schemaVersion,",
      "      hoverArenaMode: hoverArena.HOVER_ARENA_MODE,",
      "      runtimeSchemaVersion: runtime.HOVER_GRID_SCHEMA_VERSION,",
      '      magic: body.subarray(0, 2).toString("hex"), key',
      "    }));",
      "    process.exit(73);",
      "  }",
      "  return originalLoad.call(this, request, parent, isMain);",
      "};",
      "",
    ].join("\n"),
  );

  const env = { ...process.env };
  delete env.MODELVIEW_NOAA_HOVER_COMPRESSION;
  delete env.MODELVIEW_NOAA_HOVER_GZIP_LEVEL;
  delete env.MODELVIEW_NOAA_HOVER_BROTLI_QUALITY;
  delete env.MODELVIEW_NOAA_HOVER_ENCODING;
  delete env.MODELVIEW_NOAA_HOVER_ARENA;
  env.MODELVIEW_TEST_REPO_ROOT = ROOT_DIR;
  const result = spawnSync(process.execPath, ["--require", preloadPath, builderPath], {
    cwd: sourceRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 73, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    backend: "gzip",
    level: 2,
    extension: "gz",
    encodingId: "mvh3",
    encodingSchemaVersion: 3,
    hoverArenaMode: "off",
    runtimeSchemaVersion: 3,
    magic: "1f8b",
    key: "tiles/hrrr/20260716-1300Z/conus/000/hover-grid.bin.gz",
  });
});

test("invalid hover encoding env fails closed during process-frozen descriptor initialization", () => {
  const env = { ...process.env, MODELVIEW_NOAA_HOVER_ENCODING: "legacy-ish" };
  const result = spawnSync(process.execPath, ["-e", 'require("./scripts/lib/hover-grid-encoding")'], {
    cwd: ROOT_DIR,
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /MODELVIEW_NOAA_HOVER_ENCODING.*mvh4.*mvh3/i);
});

test("invalid hover arena env fails closed during process-frozen mode initialization", () => {
  const env = { ...process.env, MODELVIEW_NOAA_HOVER_ARENA: "sometimes" };
  const result = spawnSync(process.execPath, ["-e", 'require("./scripts/lib/noaa-beta/hover-arena")'], {
    cwd: ROOT_DIR,
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /MODELVIEW_NOAA_HOVER_ARENA.*auto.*off/i);
});

test("invalid fast-pack env fails closed instead of silently enabling the bypass", () => {
  const { _testResolveFastPackMode } = require("../scripts/lib/noaa-beta-renderer");
  assert.equal(_testResolveFastPackMode(undefined), "auto");
  assert.equal(_testResolveFastPackMode(""), "auto");
  assert.equal(_testResolveFastPackMode("auto"), "auto");
  assert.equal(_testResolveFastPackMode(" OFF "), "off");
  for (const invalid of ["offf", "of", "false", "0", "on", "1"]) {
    assert.throws(() => _testResolveFastPackMode(invalid), /MODELVIEW_NOAA_FAST_PACK.*auto.*off/i, invalid);
  }
});
