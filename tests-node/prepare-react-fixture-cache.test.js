"use strict";

// Regression pin for the fixture-cache foot-gun: the script recursively
// deletes <cacheRoot>/artifacts before writing 1x1-PNG fixtures, and it used
// to honor MODELVIEW_CACHE_ROOT as that target — so running it without an
// argument in a shell configured for the REAL rendered cache wiped the
// production artifacts directory and poisoned it with fixture manifests. The
// target is now argv-only and confined to the repo's test-results/ area.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT_DIR = path.resolve(__dirname, "..");
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "prepare-react-fixture-cache.js");
const {
  DEFAULT_CACHE_ROOT,
  FIXTURE_AREA_ROOT,
  assertFixtureCacheRoot,
  resolveFixtureCacheRoot,
} = require("../scripts/prepare-react-fixture-cache");

test("fixture cache root is argv-only, repo-root anchored, and confined to test-results/", () => {
  assert.equal(DEFAULT_CACHE_ROOT, path.join(ROOT_DIR, "test-results", "react-cache"));
  assert.equal(resolveFixtureCacheRoot(undefined), DEFAULT_CACHE_ROOT);
  // The playwright.react.config.js invocation resolves cwd-independently.
  assert.equal(resolveFixtureCacheRoot("test-results/react-cache"), DEFAULT_CACHE_ROOT);
  assert.doesNotThrow(() => assertFixtureCacheRoot(DEFAULT_CACHE_ROOT));
  assert.doesNotThrow(() => assertFixtureCacheRoot(path.join(FIXTURE_AREA_ROOT, "react-cache-alt")));
  for (const outside of [
    path.join(os.tmpdir(), "real-cache"),
    ROOT_DIR,
    FIXTURE_AREA_ROOT, // the fixture area itself is not a cache the script owns
    path.join(ROOT_DIR, "output", "noaa-beta-cache"),
    path.join(FIXTURE_AREA_ROOT, "..", "src"), // traversal out of the area
  ]) {
    assert.throws(
      () => assertFixtureCacheRoot(path.resolve(outside)),
      /refusing to prepare fixture cache/,
      `guard rejects ${outside}`,
    );
  }
});

test("a stray MODELVIEW_CACHE_ROOT no longer directs the fixture wipe at a real cache", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-react-fixture-env-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const realCacheRoot = path.join(dir, "real-cache");
  const sentinelPath = path.join(realCacheRoot, "artifacts", "manifests", "nam", "sentinel.json");
  await fs.promises.mkdir(path.dirname(sentinelPath), { recursive: true });
  const sentinelBody = JSON.stringify({ realRenderedArtifact: true });
  await fs.promises.writeFile(sentinelPath, sentinelBody);

  // The historical foot-gun invocation: no argv, MODELVIEW_CACHE_ROOT
  // exported. The script must ignore the env var and prepare the default
  // fixture cache instead (test-results/react-cache — the same gitignored
  // directory the playwright webServer command rebuilds on every run).
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: ROOT_DIR,
    env: { ...process.env, MODELVIEW_CACHE_ROOT: realCacheRoot },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `script succeeds against the default target: ${result.stderr}`);
  assert.equal(
    fs.readFileSync(sentinelPath, "utf8"),
    sentinelBody,
    "the real cache pointed at by MODELVIEW_CACHE_ROOT is untouched",
  );
  assert.equal(
    fs.readdirSync(path.join(realCacheRoot, "artifacts", "manifests")).length,
    1,
    "no fixture manifests were written into the real cache",
  );
  assert.ok(result.stdout.includes(DEFAULT_CACHE_ROOT), "the script reports the default fixture target");
});

test("the fixture script refuses to delete an explicit target outside the test fixture area", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-react-fixture-guard-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "some-cache");
  const artifactSentinel = path.join(target, "artifacts", "keep.json");
  await fs.promises.mkdir(path.dirname(artifactSentinel), { recursive: true });
  await fs.promises.writeFile(artifactSentinel, "{}");

  const result = spawnSync(process.execPath, [SCRIPT_PATH, target], { cwd: ROOT_DIR, encoding: "utf8" });
  assert.notEqual(result.status, 0, "an out-of-area target exits nonzero");
  assert.match(String(result.stderr), /refusing to prepare fixture cache/);
  assert.ok(fs.existsSync(artifactSentinel), "out-of-area artifacts are not deleted");
});
