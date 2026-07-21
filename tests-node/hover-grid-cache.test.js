"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

function loadModule() {
  const entry = path.join(__dirname, "..", "next", "src", "core", "artifact-client.ts");
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    define: {
      "import.meta.env.VITE_ARTIFACT_BASE_URL": "undefined",
      "import.meta.env.VITE_IMAGE_OBJECT_URL_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_DECODED_IMAGE_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_HOVER_GRID_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_PARSED_PAYLOAD_CACHE_MAX_ENTRIES": "undefined",
      "import.meta.env.DEV": "false",
    },
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function frame(hour) {
  return {
    hour,
    validHourKey: `frame-${hour}`,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    layers: {},
    hoverGridKey: `hover/frame-${hour}.json`,
    hoverGridBytes: 100,
    hoverGridSchemaVersion: 1,
  };
}

function payload(value) {
  return {
    schemaVersion: 1,
    rows: 2,
    cols: 2,
    variables: {
      temperatureF: {
        scale: 1,
        offset: 0,
        missing: -32768,
        data: Buffer.from(Int16Array.from([value, value, value, value]).buffer).toString("base64"),
      },
    },
  };
}

test("hover payload cache is a six-entry LRU instead of a whole-run cache", async () => {
  const client = loadModule();
  const requests = new Map();
  globalThis.fetch = async (url) => {
    const key = String(url);
    requests.set(key, (requests.get(key) || 0) + 1);
    const match = key.match(/frame-(\d+)\.json/);
    return {
      ok: true,
      status: 200,
      json: async () => payload(Number(match?.[1] || 0)),
    };
  };

  const frames = Array.from({ length: 7 }, (_, hour) => frame(hour));
  for (const item of frames.slice(0, 6)) {
    await client.fetchHoverGridPayload(item);
  }

  // A cache hit promotes frame 0, so adding frame 6 must evict frame 1.
  const frame0Key = client.resolveHoverGridRequestUrls(frames[0]).join("|");
  assert.ok(client.getCachedHoverGridPayload(frame0Key));
  await client.fetchHoverGridPayload(frames[6]);

  await client.fetchHoverGridPayload(frames[0]);
  await client.fetchHoverGridPayload(frames[1]);
  const frame0Url = client.resolveHoverGridRequestUrls(frames[0])[0];
  const frame1Url = client.resolveHoverGridRequestUrls(frames[1])[0];
  assert.equal(requests.get(frame0Url), 1, "recently touched frame should remain cached");
  assert.equal(requests.get(frame1Url), 2, "least-recently-used frame should refetch");
});

test("a single-file hover fetch aborts when its last shared consumer leaves", async () => {
  const client = loadModule();
  let requestCount = 0;
  let underlyingAbortCount = 0;
  globalThis.fetch = (_url, options = {}) => {
    requestCount += 1;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          underlyingAbortCount += 1;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  };

  const first = new AbortController();
  const second = new AbortController();
  const firstPromise = client.fetchHoverGridPayload(frame(20), { signal: first.signal });
  const secondPromise = client.fetchHoverGridPayload(frame(20), { signal: second.signal });
  assert.equal(requestCount, 1, "concurrent consumers share the underlying fetch");

  first.abort();
  await assert.rejects(firstPromise, (error) => error?.name === "AbortError");
  assert.equal(underlyingAbortCount, 0, "one remaining consumer keeps the request alive");

  second.abort();
  await assert.rejects(secondPromise, (error) => error?.name === "AbortError");
  assert.equal(underlyingAbortCount, 1, "the last consumer abort reaches the underlying fetch");
});
