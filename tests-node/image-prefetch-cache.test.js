"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

// Regression guards for parallel frame warmers: concurrent calls for one URL
// share the blob request, object URL, and optional image decode. This avoids
// duplicate network/decode work and also makes revocation races impossible.

// ── Module under test ─────────────────────────────────────────────────────────
// image-prefetch-cache.ts is client TypeScript reading import.meta.env at
// module scope; bundle with esbuild (repo pattern, see basemap-style.test.js)
// with the env references defined away, and stub the browser APIs it uses.
function loadModule() {
  const entry = path.join(__dirname, "..", "next", "src", "core", "image-prefetch-cache.ts");
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
    define: {
      "import.meta.env.VITE_IMAGE_OBJECT_URL_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_DECODED_IMAGE_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.DEV": "false",
    },
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function installBrowserStubs() {
  let nextObjectUrl = 0;
  const revoked = new Set();
  const pendingFetches = [];
  const imageLoadsOfRevokedUrls = [];
  let fetchCount = 0;
  let imageLoadCount = 0;
  globalThis.fetch = (url) => {
    fetchCount += 1;
    return new Promise((resolve) => {
      pendingFetches.push(() =>
        resolve({
          ok: true,
          status: 200,
          blob: async () => ({ size: 64, url }),
        }),
      );
    });
  };
  globalThis.URL.createObjectURL = () => `blob:test/${(nextObjectUrl += 1)}`;
  globalThis.URL.revokeObjectURL = (objectUrl) => {
    revoked.add(objectUrl);
  };
  // Minimal Image stub for the decode path: loading a revoked object URL is
  // exactly the browser's net::ERR_FILE_NOT_FOUND case, so record it and
  // error out like the real thing.
  globalThis.Image = class FakeImage {
    set src(value) {
      imageLoadCount += 1;
      queueMicrotask(() => {
        if (revoked.has(value)) {
          imageLoadsOfRevokedUrls.push(value);
          this.onerror?.(new Error(`revoked object URL: ${value}`));
          return;
        }
        this.onload?.();
      });
    }
  };
  return {
    revoked,
    imageLoadsOfRevokedUrls,
    fetchCount: () => fetchCount,
    imageLoadCount: () => imageLoadCount,
    releaseNextFetch: () => {
      const release = pendingFetches.shift();
      if (release) {
        release();
      }
    },
    releaseAllFetches: () => {
      for (const release of pendingFetches.splice(0)) {
        release();
      }
    },
  };
}

test("concurrent preloads of one URL share one fetch and one live object URL", async () => {
  const stubs = installBrowserStubs();
  const mod = loadModule();
  const requestUrl = "http://127.0.0.1:5174/tiles/gfs/000/temperature.png";

  // Both preloads start before either caches, but join one shared request.
  const first = mod.preloadImage(requestUrl);
  const second = mod.preloadImage(requestUrl);

  // The first fetch lands; the panel reads the cache and hands the object URL
  // to the map engine (whose own fetch of it may still be in flight)...
  stubs.releaseNextFetch();
  await first;
  const held = mod.getCachedLayerImageObjectUrl(requestUrl);
  assert.ok(held, "expected a cached object URL after the first preload settled");

  // The joined consumer receives the same cached URL without another blob or
  // object URL being created.
  stubs.releaseAllFetches();
  await second;
  assert.ok(!stubs.revoked.has(held), `the handed-out object URL ${held} was revoked by the racing duplicate`);
  assert.equal(mod.getCachedLayerImageObjectUrl(requestUrl), held);
  assert.equal(stubs.fetchCount(), 1);
  assert.equal(stubs.revoked.size, 0);
});

test("the losing concurrent preload decodes via the surviving cache entry, never its revoked blob", async () => {
  const stubs = installBrowserStubs();
  const mod = loadModule();
  const requestUrl = "http://127.0.0.1:5174/tiles/gfs/006/temperature.png";

  // Both decode-prefetches race (the frame-prefetch engine and the panel's
  // immediate frame application both decode the same frame).
  const first = mod.preloadImage(requestUrl, { decode: true });
  const second = mod.preloadImage(requestUrl, { decode: true });
  stubs.releaseAllFetches();
  await Promise.all([first, second]);

  // The loser's own blob was revoked (first-write-wins), so decoding through
  // it would hit the browser's net::ERR_FILE_NOT_FOUND — the offline-boot
  // spec's failed-request audit flagged exactly that.
  assert.deepEqual(stubs.imageLoadsOfRevokedUrls, []);
  assert.equal(stubs.fetchCount(), 1);
  assert.equal(stubs.imageLoadCount(), 1);
});

test("a second sequential preload is a cache hit: no new object URL, nothing revoked", async () => {
  const stubs = installBrowserStubs();
  const mod = loadModule();
  const requestUrl = "http://127.0.0.1:5174/tiles/gfs/003/temperature.png";

  const first = mod.preloadImage(requestUrl);
  stubs.releaseAllFetches();
  await first;
  const held = mod.getCachedLayerImageObjectUrl(requestUrl);

  const second = mod.preloadImage(requestUrl);
  stubs.releaseAllFetches();
  await second;

  assert.equal(mod.getCachedLayerImageObjectUrl(requestUrl), held);
  assert.equal(stubs.revoked.size, 0);
});
