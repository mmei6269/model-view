"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createLocalArtifactServer } = require("../scripts/lib/local-artifact-server");

function rawRequest(port, rawPath, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(run) {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-cors-"));
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

test("served assets carry a cross-origin allow header", async () => {
  await withServer(async ({ runtime, port }) => {
    const key = `${runtime.artifactPrefix}/gfs/20260703-0000Z/conus/000/2t.png`;
    const filePath = runtime.getArtifactStoragePath(key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const response = await rawRequest(port, `/${key}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], "*");
  });
});

test("healthz carries the allow header too", async () => {
  await withServer(async ({ port }) => {
    const response = await rawRequest(port, "/healthz");
    assert.equal(response.status, 200);
    assert.equal(response.headers["access-control-allow-origin"], "*");
  });
});

test("OPTIONS preflight returns 204 with allow-methods/headers", async () => {
  await withServer(async ({ port }) => {
    const response = await rawRequest(port, "/manifests/gfs/latest.json", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:4173", "Access-Control-Request-Method": "GET" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers["access-control-allow-origin"], "*");
    assert.match(String(response.headers["access-control-allow-methods"] || ""), /GET/);
    assert.match(String(response.headers["access-control-allow-headers"] || ""), /If-None-Match/i);
  });
});
