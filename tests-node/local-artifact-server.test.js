"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createLocalArtifactServer } = require("../scripts/lib/local-artifact-server");

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(run) {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-artifact-server-"));
  const { runtime, server } = createLocalArtifactServer({ cacheRoot });
  await runtime.init();
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run({ runtime, cacheRoot, port: server.address().port });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  }
}

test("asset requests inside the artifact root are still served", async () => {
  await withServer(async ({ runtime, port }) => {
    const key = `${runtime.artifactPrefix}/gfs/20260313-0000Z/conus/000/2t.png`;
    const filePath = runtime.getArtifactStoragePath(key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const response = await rawGet(port, `/${key}`);
    assert.equal(response.status, 200, "a legit in-root asset must still be served");
  });
});

test("encoded ../ traversal cannot escape the artifact root", async () => {
  await withServer(async ({ runtime, cacheRoot, port }) => {
    // Sentinel file placed OUTSIDE the artifact root (in its parent directory).
    const sentinelPath = path.join(cacheRoot, "secret.txt");
    await fs.promises.writeFile(sentinelPath, "TOP-SECRET");

    // A valid-looking asset path so the hour segment (parts[4]) parses as finite,
    // with the traversal encoded as "..%2F" so the URL parser does not normalize it away.
    const assetKey = `${runtime.artifactPrefix}/gfs/20260313-0000Z/conus/000/2t.png`;
    const assetDir = path.dirname(runtime.getArtifactStoragePath(assetKey));
    const relativeToSentinel = path.relative(assetDir, sentinelPath);
    const encodedTraversal = relativeToSentinel.split(path.sep).map(encodeURIComponent).join("%2F");
    const traversalPath = `/${runtime.artifactPrefix}/gfs/20260313-0000Z/conus/000/${encodedTraversal}`;

    const response = await rawGet(port, traversalPath);
    assert.equal(response.status, 404, "traversal outside the artifact root must be rejected with 404");
    assert.notEqual(response.body, "TOP-SECRET", "the sentinel file must never be served");
  });
});

// A run id / view key made only of a plain identifier. RUN is a legitimate run id
// shape for the manifest route (the run-manifest branch strips ".json").
const VALID_RUN_ID = "20260313-0000Z";

// The raw ?view= value that steers the manifest filename builder
// (manifests/<model>/<run>--<view>.json) out of the artifact root and into
// <cacheRoot>/leak.json (one level above artifactRoot, which is <cacheRoot>/artifacts).
const LEAK_VIEW = "../../../../../leak";
const LEAK_VIEW_ENCODED = LEAK_VIEW.split("/").map(encodeURIComponent).join("%2F");

async function writeLeakSentinel(runtime, cacheRoot) {
  const sentinelPath = path.join(cacheRoot, "leak.json");
  await fs.promises.writeFile(sentinelPath, JSON.stringify({ secret: true }));
  // Guard: prove the traversal actually reaches the out-of-root sentinel with the
  // current storage layout, so a green test can only mean the boundary rejected it
  // (not that the layout silently changed and the read missed the sentinel anyway).
  const resolvedLeak = path.resolve(runtime.getManifestStoragePath("gfs", "RUN", LEAK_VIEW));
  assert.equal(resolvedLeak, path.resolve(sentinelPath), "traversal view must resolve to the out-of-root sentinel");
  return sentinelPath;
}

test("manifest ?view= traversal cannot read a file outside the artifact root", async () => {
  await withServer(async ({ runtime, cacheRoot, port }) => {
    await writeLeakSentinel(runtime, cacheRoot);
    const response = await rawGet(port, `/manifests/gfs/RUN.json?view=${LEAK_VIEW_ENCODED}`);
    assert.equal(response.status, 404, "a ?view= traversal must be rejected with 404");
    assert.ok(!response.body.includes("secret"), "the out-of-root sentinel must never be served");
  });
});

test("legitimate manifest requests are still served", async () => {
  await withServer(async ({ runtime, port }) => {
    const manifestPath = runtime.getManifestStoragePath("gfs", VALID_RUN_ID, runtime.defaultViewKey);
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify({ model: "gfs", run: VALID_RUN_ID, view: runtime.defaultViewKey, frames: [] }),
    );

    const response = await rawGet(port, `/manifests/gfs/${VALID_RUN_ID}.json?view=${runtime.defaultViewKey}`);
    assert.equal(response.status, 200, "a legitimate manifest request must still be served");
    const body = JSON.parse(response.body);
    assert.equal(body.model, "gfs");
    assert.equal(body.run, VALID_RUN_ID);
  });
});

test("manifest model-segment traversal is rejected", async () => {
  await withServer(async ({ port }) => {
    const response = await rawGet(port, "/manifests/..%2F..%2Fx/RUN.json?view=conus");
    assert.equal(response.status, 404, "a traversal in the model segment must be rejected with 404");
  });
});

test("manifest view keys containing a dot are rejected", async () => {
  await withServer(async ({ port }) => {
    // Real view keys never contain a dot; the allowlist forbids it so ".json" and
    // ".." injection are both impossible.
    const response = await rawGet(port, "/manifests/gfs/RUN.json?view=co.nus");
    assert.equal(response.status, 404, "a dotted view key must be rejected with 404");
  });
});

test("sounding ?view= traversal cannot read a file outside the artifact root", async () => {
  await withServer(async ({ runtime, cacheRoot, port }) => {
    await writeLeakSentinel(runtime, cacheRoot);
    const response = await rawGet(port, `/soundings/gfs/RUN/0?view=${LEAK_VIEW_ENCODED}&lat=40&lon=-100`);
    assert.ok(response.status === 404 || response.status === 400, "a ?view= traversal must be rejected");
    assert.ok(!response.body.includes("secret"), "the out-of-root sentinel must never be served");
  });
});
