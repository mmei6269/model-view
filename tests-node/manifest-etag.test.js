"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createLocalArtifactServer } = require("../scripts/lib/local-artifact-server");

const MANIFEST_URL = "/manifests/gfs/20260703-0000Z.json?view=conus";

function rawRequest(port, rawPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(run, runtimeOptions = {}) {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-etag-"));
  const { runtime, server } = createLocalArtifactServer({ cacheRoot, ...runtimeOptions });
  await runtime.init();
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run({ runtime, cacheRoot, port: server.address().port });
  } finally {
    await new Promise((r) => server.close(() => r()));
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  }
}

async function writeManifest(runtime, overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    model: "gfs",
    run: "20260703-0000Z",
    view: "conus",
    generatedAt: "2026-07-03T00:40:00Z",
    hourStatus: {},
    frames: [],
    ...overrides,
  };
  const p = runtime.getManifestStoragePath("gfs", "20260703-0000Z", "conus");
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, JSON.stringify(manifest));
  return p;
}

// Rewrites the manifest and forces a strictly newer mtime so tests never depend
// on filesystem timestamp granularity to observe the cache invalidation.
async function rewriteManifestWithNewerMtime(runtime, overrides) {
  const p = await writeManifest(runtime, overrides);
  const previous = await fs.promises.stat(p);
  const bumped = new Date(previous.mtimeMs + 2_000);
  await fs.promises.utimes(p, bumped, bumped);
  return p;
}

test("manifest response carries an ETag and a matching If-None-Match yields 304", async () => {
  await withServer(async ({ runtime, port }) => {
    await writeManifest(runtime);
    const first = await rawRequest(port, MANIFEST_URL);
    assert.equal(first.status, 200);
    const etag = first.headers.etag;
    assert.ok(etag, "manifest must carry an ETag");
    const second = await rawRequest(port, MANIFEST_URL, { "If-None-Match": etag });
    assert.equal(second.status, 304);
    assert.equal(second.body, "");
  });
});

test("repeat manifest reads within the TTL reuse the cached completeness pass", async () => {
  await withServer(async ({ runtime }) => {
    await writeManifest(runtime);
    let completenessReads = 0;
    const original = runtime.readManifestFromDisk.bind(runtime);
    runtime.readManifestFromDisk = async (...args) => {
      completenessReads += 1;
      return original(...args);
    };
    const first = await runtime.readManifestWithEtag("gfs", "20260703-0000Z", "conus");
    const second = await runtime.readManifestWithEtag("gfs", "20260703-0000Z", "conus");
    assert.ok(first && first.etag, "first read must produce an ETag");
    assert.equal(completenessReads, 1, "second read within the TTL must not re-run the completeness pass");
    assert.equal(second.etag, first.etag);
    assert.deepEqual(second.manifest, first.manifest);
  });
});

test("a manifest rewrite with a newer mtime invalidates the cache and serves fresh completeness", async () => {
  await withServer(async ({ runtime }) => {
    await writeManifest(runtime);
    const first = await runtime.readManifestWithEtag("gfs", "20260703-0000Z", "conus");
    assert.equal(first.manifest.frames.length, 0);
    await rewriteManifestWithNewerMtime(runtime, {
      generatedAt: "2026-07-03T01:10:00Z",
      frames: [{ hour: 0, artifacts: {} }],
    });
    const second = await runtime.readManifestWithEtag("gfs", "20260703-0000Z", "conus");
    assert.equal(second.manifest.frames.length, 1, "rewrite must surface the new frame immediately");
    assert.equal(second.manifest.hourStatus["0"], "pending", "completeness must be re-derived for the new frame");
    assert.notEqual(second.etag, first.etag, "a changed manifest must produce a new ETag");
  });
});

// Regression guard for the marker-only completion case: a frame finishing render
// writes its .complete.json marker but never rewrites the manifest, so the mtime
// component of the ETag is identical before and after. Within the TTL the cached
// "pending" answer may be served (bounded staleness, by design); once the TTL
// lapses the completeness pass MUST re-run and the hourStatus fold MUST change
// the ETag so a conditional client can never 304 into stale completeness. If the
// ETag ever degrades to mtime-only, the notEqual assertions below fail.
test("a marker-only completion refreshes completeness and changes the ETag once the TTL lapses", async () => {
  const ttlMs = 200;
  await withServer(
    async ({ runtime, port }) => {
      const artifactKey = "noaa/gfs/20260703-0000Z/conus/000/t2m.png";
      const artifactPath = runtime.getArtifactStoragePath(artifactKey);
      await fs.promises.mkdir(path.dirname(artifactPath), { recursive: true });
      await fs.promises.writeFile(artifactPath, "png-bytes");
      const manifestPath = await writeManifest(runtime, {
        frames: [{ hour: 0, artifacts: {}, layers: { t2m: { key: artifactKey, bytes: 0 } } }],
      });
      const manifestMtimeMs = (await fs.promises.stat(manifestPath)).mtimeMs;

      const beforeFirstRead = Date.now();
      const first = await runtime.readManifestWithEtag("gfs", "20260703-0000Z", "conus");
      const afterFirstRead = Date.now();
      assert.equal(first.manifest.hourStatus["0"], "pending", "a frame without a marker must derive as pending");
      assert.ok(first.etag, "the pending read must produce an ETag");

      // The frame completes: only the .complete.json marker lands; the manifest
      // file itself is untouched, so its mtime cannot drive an ETag change.
      const markerPath = runtime.getFrameMarkerPath("gfs", "20260703-0000Z", "conus", 0);
      await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.promises.writeFile(markerPath, JSON.stringify({ hour: 0 }));
      assert.equal(
        (await fs.promises.stat(manifestPath)).mtimeMs,
        manifestMtimeMs,
        "writing the frame marker must not touch the manifest file mtime",
      );

      // Bounded staleness inside the TTL is allowed: the cached pending answer may
      // still be served. Only asserted when the probe provably landed inside the
      // window (cachedAt is never earlier than beforeFirstRead).
      const staleProbe = await runtime.readManifestWithEtag("gfs", "20260703-0000Z", "conus");
      if (Date.now() - beforeFirstRead < ttlMs) {
        assert.equal(
          staleProbe.manifest.hourStatus["0"],
          "pending",
          "within the TTL the cached pending answer may persist",
        );
        assert.equal(staleProbe.etag, first.etag);
      }

      // Let the TTL lapse. cachedAt was set no later than afterFirstRead, so this
      // wait guarantees the cache entry is expired when the next read runs.
      const waitMs = Math.max(0, ttlMs + 75 - (Date.now() - afterFirstRead));
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      const refreshed = await runtime.readManifestWithEtag("gfs", "20260703-0000Z", "conus");
      assert.equal(
        refreshed.manifest.hourStatus["0"],
        "loaded",
        "after the TTL the completeness pass must re-run and observe the marker",
      );
      assert.notEqual(
        refreshed.etag,
        first.etag,
        "a marker-only completion must change the ETag even though the manifest mtime is unchanged",
      );
      assert.equal(
        (await fs.promises.stat(manifestPath)).mtimeMs,
        manifestMtimeMs,
        "the ETag change must come from the hourStatus fold, not from an mtime change",
      );

      // The user-visible invariant: a conditional poll holding the pre-completion
      // tag gets 200 with fresh completeness, never a 304 into stale pending.
      const conditional = await rawRequest(port, MANIFEST_URL, { "If-None-Match": first.etag });
      assert.equal(conditional.status, 200, "a stale pre-completion ETag must not yield 304");
      assert.equal(conditional.headers.etag, refreshed.etag);
      assert.equal(JSON.parse(conditional.body).hourStatus["0"], "loaded");
    },
    { manifestCompletenessTtlMs: ttlMs },
  );
});

test("a changed manifest defeats If-None-Match and returns 200 with fresh data and a new ETag", async () => {
  await withServer(async ({ runtime, port }) => {
    await writeManifest(runtime);
    const first = await rawRequest(port, MANIFEST_URL);
    assert.equal(first.status, 200);
    const staleEtag = first.headers.etag;
    assert.ok(staleEtag);
    await rewriteManifestWithNewerMtime(runtime, {
      generatedAt: "2026-07-03T01:10:00Z",
      frames: [{ hour: 0, artifacts: {} }],
    });
    const second = await rawRequest(port, MANIFEST_URL, { "If-None-Match": staleEtag });
    assert.equal(second.status, 200, "a stale ETag must not yield 304 once the manifest changed");
    assert.ok(second.headers.etag, "changed manifest must carry an ETag");
    assert.notEqual(second.headers.etag, staleEtag);
    const body = JSON.parse(second.body);
    assert.equal(body.frames.length, 1);
    assert.equal(body.hourStatus["0"], "pending");
  });
});
