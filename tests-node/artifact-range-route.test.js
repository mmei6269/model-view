"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createLocalArtifactServer } = require("../scripts/lib/local-artifact-server");

const SEEDED_NAME = "planet-na.pmtiles";
const SEEDED_SIZE = 4096;

// Deterministic non-repeating-ish byte pattern so a wrong slice offset can never
// accidentally equal the expected slice.
function buildSeededBytes(size) {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = (i * 31 + (i >> 7) * 17 + 7) & 0xff;
  }
  return bytes;
}

function request(port, method, rawPath, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

// Same mkdtemp harness shape as local-artifact-actions.test.js, plus a seeded
// basemap dir INSIDE the temp root — tests never touch the real output/basemap/.
async function withRangeServer(run, { seedBasemapDir = true } = {}) {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-range-"));
  const basemapRoot = path.join(cacheRoot, "basemap");
  const seeded = buildSeededBytes(SEEDED_SIZE);
  if (seedBasemapDir) {
    await fs.promises.mkdir(basemapRoot, { recursive: true });
    await fs.promises.writeFile(path.join(basemapRoot, SEEDED_NAME), seeded);
    // A file OUTSIDE the basemap root: traversal attempts must never reach it.
    await fs.promises.writeFile(path.join(cacheRoot, "outside.pmtiles"), Buffer.from("secret"));
  }
  const { runtime, server } = createLocalArtifactServer({ cacheRoot, basemapRoot });
  await runtime.init();
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run({ port: server.address().port, seeded });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  }
}

test("bytes=a-b returns 206 with the exact byte slice and range headers", async () => {
  await withRangeServer(async ({ port, seeded }) => {
    const res = await request(port, "GET", `/basemap/${SEEDED_NAME}`, { Range: "bytes=100-199" });
    assert.equal(res.status, 206);
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(res.headers["content-range"], `bytes 100-199/${SEEDED_SIZE}`);
    assert.equal(Number(res.headers["content-length"]), 100);
    assert.ok(res.body.equals(seeded.subarray(100, 200)), "body is exactly bytes 100..199");
  });
});

test("open-ended bytes=a- returns 206 through the last byte", async () => {
  await withRangeServer(async ({ port, seeded }) => {
    const res = await request(port, "GET", `/basemap/${SEEDED_NAME}`, { Range: "bytes=4000-" });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], `bytes 4000-4095/${SEEDED_SIZE}`);
    assert.equal(Number(res.headers["content-length"]), 96);
    assert.ok(res.body.equals(seeded.subarray(4000)), "body is exactly the tail from 4000");
  });
});

test("suffix bytes=-n returns 206 with the last n bytes", async () => {
  await withRangeServer(async ({ port, seeded }) => {
    const res = await request(port, "GET", `/basemap/${SEEDED_NAME}`, { Range: "bytes=-96" });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], `bytes 4000-4095/${SEEDED_SIZE}`);
    assert.equal(Number(res.headers["content-length"]), 96);
    assert.ok(res.body.equals(seeded.subarray(SEEDED_SIZE - 96)), "body is exactly the last 96 bytes");
  });
});

test("suffix longer than the file returns the whole file as 206", async () => {
  await withRangeServer(async ({ port, seeded }) => {
    const res = await request(port, "GET", `/basemap/${SEEDED_NAME}`, { Range: "bytes=-999999" });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], `bytes 0-4095/${SEEDED_SIZE}`);
    assert.ok(res.body.equals(seeded), "body is the entire file");
  });
});

test("end beyond EOF is clamped to the last byte", async () => {
  await withRangeServer(async ({ port, seeded }) => {
    const res = await request(port, "GET", `/basemap/${SEEDED_NAME}`, { Range: "bytes=4090-999999" });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], `bytes 4090-4095/${SEEDED_SIZE}`);
    assert.ok(res.body.equals(seeded.subarray(4090)), "body is clamped to EOF");
  });
});

test("multi-range request falls back to a full 200 body", async () => {
  await withRangeServer(async ({ port, seeded }) => {
    const res = await request(port, "GET", `/basemap/${SEEDED_NAME}`, { Range: "bytes=0-1,10-11" });
    assert.equal(res.status, 200);
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(Number(res.headers["content-length"]), SEEDED_SIZE);
    assert.ok(res.body.equals(seeded), "full body served instead of multipart");
  });
});

test("malformed range headers are ignored and served as full 200", async () => {
  await withRangeServer(async ({ port, seeded }) => {
    for (const header of ["bytes=abc", "bytes=5-2", "bytes=-", "items=0-5"]) {
      const res = await request(port, "GET", `/basemap/${SEEDED_NAME}`, { Range: header });
      assert.equal(res.status, 200, `"${header}" is ignored per RFC 7233`);
      assert.ok(res.body.equals(seeded), `"${header}" serves the full body`);
    }
  });
});

test("unsatisfiable range returns 416 with Content-Range: bytes */total", async () => {
  await withRangeServer(async ({ port }) => {
    for (const header of [`bytes=${SEEDED_SIZE}-`, "bytes=5000-6000", "bytes=-0"]) {
      const res = await request(port, "GET", `/basemap/${SEEDED_NAME}`, { Range: header });
      assert.equal(res.status, 416, `"${header}" is unsatisfiable`);
      assert.equal(res.headers["content-range"], `bytes */${SEEDED_SIZE}`);
    }
  });
});

test("no Range header returns 200 with the full body and Accept-Ranges", async () => {
  await withRangeServer(async ({ port, seeded }) => {
    const res = await request(port, "GET", `/basemap/${SEEDED_NAME}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(Number(res.headers["content-length"]), SEEDED_SIZE);
    assert.ok(res.body.equals(seeded), "entire file body");
  });
});

test("HEAD returns headers including Content-Length and Accept-Ranges with an empty body", async () => {
  await withRangeServer(async ({ port }) => {
    const res = await request(port, "HEAD", `/basemap/${SEEDED_NAME}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(Number(res.headers["content-length"]), SEEDED_SIZE);
    assert.equal(res.body.length, 0, "HEAD carries no body");
  });
});

test("traversal attempts and non-pmtiles names all 404", async () => {
  await withRangeServer(async ({ port }) => {
    const badPaths = [
      "/basemap/../outside.pmtiles", // dot segments (client may normalize; server must 404 either way)
      "/basemap/..%2Foutside.pmtiles", // encoded separator
      "/basemap/%2e%2e%2foutside.pmtiles", // fully encoded ../
      "/basemap/outside.txt", // wrong extension
      "/basemap/a.b.pmtiles", // dotted stem rejected by the name gate
      "/basemap/.pmtiles", // empty stem
      "/basemap/nested/outside.pmtiles", // nested path
      "/basemap/missing.pmtiles", // simply absent
    ];
    for (const rawPath of badPaths) {
      const res = await request(port, "GET", rawPath);
      assert.equal(res.status, 404, `${rawPath} must 404`);
    }
  });
});

test("missing basemap directory 404s cleanly", async () => {
  await withRangeServer(
    async ({ port }) => {
      const res = await request(port, "GET", `/basemap/${SEEDED_NAME}`);
      assert.equal(res.status, 404);
    },
    { seedBasemapDir: false },
  );
});

test("non-GET/HEAD methods on /basemap are rejected with 405", async () => {
  await withRangeServer(async ({ port }) => {
    const res = await request(port, "POST", `/basemap/${SEEDED_NAME}`);
    assert.equal(res.status, 405);
  });
});

test("CORS preflight allows the Range request header", async () => {
  await withRangeServer(async ({ port }) => {
    const res = await request(port, "OPTIONS", `/basemap/${SEEDED_NAME}`, {
      Origin: "http://localhost:4173",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "range",
    });
    assert.equal(res.status, 204);
    const allowHeaders = String(res.headers["access-control-allow-headers"] || "").toLowerCase();
    assert.ok(allowHeaders.includes("range"), "pmtiles fetches send Range cross-origin under vite preview");
  });
});
