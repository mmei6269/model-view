"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");
const { buildHoverGridBinaryRaw } = require("../scripts/lib/hover-grid-binary");

function loadModule({ hoverCacheLimitMb } = {}) {
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
      "import.meta.env.VITE_HOVER_GRID_CACHE_LIMIT_MB":
        hoverCacheLimitMb === undefined ? "undefined" : JSON.stringify(hoverCacheLimitMb),
      "import.meta.env.VITE_PARSED_PAYLOAD_CACHE_MAX_ENTRIES": "undefined",
      "import.meta.env.DEV": "false",
    },
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function loadManifestUtils() {
  const entry = path.join(__dirname, "..", "next", "src", "core", "manifest-utils.ts");
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
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

test("client treats Brotli and gzip binary hover keys as browser-decoded binary payloads", async () => {
  const client = loadModule();
  const raw = buildHoverGridBinaryRaw({
    schemaVersion: 3,
    rows: 1,
    cols: 1,
    variables: {
      temperatureF: { scale: 0.05, offset: 0, missing: -32768, values: new Int16Array([123]) },
    },
  });
  let jsonCalls = 0;
  let arrayBufferCalls = 0;
  const returnedBuffers = [];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      jsonCalls += 1;
      throw new Error("binary hover must not use response.json()");
    },
    arrayBuffer: async () => {
      arrayBufferCalls += 1;
      const buffer = Uint8Array.from(raw).buffer;
      returnedBuffers.push(buffer);
      return buffer;
    },
  });

  for (const extension of ["br", "gz"]) {
    const result = await client.fetchHoverGridPayload({
      ...frame(extension === "br" ? 101 : 102),
      hoverGridKey: `hover/probe-${extension}.bin.${extension}`,
      hoverGridSchemaVersion: 3,
    });
    assert.equal(result.variables.temperatureF.values[0], 123);
    assert.strictEqual(
      result.variables.temperatureF.values.buffer,
      returnedBuffers[returnedBuffers.length - 1],
      "response.arrayBuffer() ownership must reach the canonical zero-copy parser",
    );
  }
  assert.equal(arrayBufferCalls, 2);
  assert.equal(jsonCalls, 0);
});

test("binary hover schema identity is bound to the request URL before cache admission", async () => {
  const rawBySchema = new Map(
    [3, 4].map((schemaVersion) => [
      schemaVersion,
      buildHoverGridBinaryRaw({
        schemaVersion,
        rows: 1,
        cols: 1,
        variables: {
          temperatureF: {
            scale: 0.05,
            offset: 0,
            missing: -32768,
            values: new Int16Array([123]),
          },
        },
      }),
    ]),
  );

  for (const [declaredSchema, bodySchema] of [
    [4, 3],
    [3, 4],
  ]) {
    const client = loadModule();
    const item = {
      ...frame(150 + declaredSchema),
      hoverGridKey: `hover/stale-${declaredSchema}.bin.br`,
      hoverGridSchemaVersion: declaredSchema,
    };
    const urls = client.resolveHoverGridRequestUrls(item);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from(rawBySchema.get(bodySchema)).buffer,
    });

    await assert.rejects(
      client.fetchHoverGridPayload(item),
      new RegExp(`request declared ${declaredSchema}, payload decoded as ${bodySchema}`),
    );
    assert.equal(client.getCachedHoverGridPayload(urls[0]), null);
    assert.deepEqual(client._testGetHoverGridPayloadCacheStats(), {
      entries: 0,
      bytes: 0,
      metadataBytes: 0,
      backingStores: 0,
      backingBytes: 0,
      backingReferences: [],
    });
  }
});

test("hover URL identity distinguishes bin3/bin4 and preserves an explicit legacy zero", async () => {
  const client = loadModule();
  const shared = {
    ...frame(155),
    hoverGridKey: "hover/shared.bin.br",
    hoverGridBytes: 777,
  };
  const urls = [0, 3, 4].map(
    (schemaVersion) => client.resolveHoverGridRequestUrls({ ...shared, hoverGridSchemaVersion: schemaVersion })[0],
  );
  assert.equal(new Set(urls).size, 3);
  for (const [index, schemaVersion] of [0, 3, 4].entries()) {
    const url = new URL(urls[index], "http://modelview.invalid");
    assert.equal(url.searchParams.get("h"), String(schemaVersion));
    assert.equal(url.searchParams.get("f"), `bin${schemaVersion}`);
  }

  const supplementalUrls = client.resolveHoverGridRequestUrls({
    ...shared,
    hoverGridSchemaVersion: 4,
    hoverGridSupplemental: {
      legacy: { key: "hover/legacy.bin.gz", bytes: 50, schemaVersion: 0 },
    },
  });
  const supplemental = new URL(supplementalUrls[1], "http://modelview.invalid");
  assert.equal(supplemental.searchParams.get("h"), "0", "explicit zero must not fall back to the base schema");
  assert.equal(supplemental.searchParams.get("f"), "bin0");

  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("invalid schema must fail before fetch");
  };
  for (const invalid of ["4", -1, 1.5, 5, Number.NaN]) {
    await assert.rejects(
      client.fetchHoverGridPayload({ ...shared, hoverGridSchemaVersion: invalid }),
      /Unsupported hover-grid schema identity/,
    );
  }
  assert.equal(fetches, 0);
});

test("manifest normalization preserves schema zero and rejects malformed base/supplemental identities", () => {
  const { normalizeManifest } = loadManifestUtils();
  const manifest = {
    schemaVersion: 4,
    model: "hrrr",
    view: "conus",
    run: "20260723-0000Z",
    frames: [
      {
        ...frame(156),
        hoverGridSchemaVersion: 0,
        hoverGridSupplemental: {
          legacy: { key: "hover/legacy.bin.gz", bytes: 50, schemaVersion: 0 },
        },
      },
    ],
  };
  const normalized = normalizeManifest(manifest, "hrrr", "conus");
  assert.equal(normalized.frames[0].hoverGridSchemaVersion, 0);
  assert.equal(normalized.frames[0].hoverGridSupplemental.legacy.schemaVersion, 0);

  for (const invalid of ["4", -1, 1.5, Number.NaN]) {
    const invalidBase = structuredClone(manifest);
    invalidBase.frames[0].hoverGridSchemaVersion = invalid;
    assert.throws(() => normalizeManifest(invalidBase, "hrrr", "conus"), /hover schema identity/);

    const invalidSupplemental = structuredClone(manifest);
    invalidSupplemental.frames[0].hoverGridSupplemental.legacy.schemaVersion = invalid;
    assert.throws(() => normalizeManifest(invalidSupplemental, "hrrr", "conus"), /hover schema identity/);
  }

  // A future integer schema published ahead of this client degrades that
  // frame's hover declaration to null instead of failing the whole manifest.
  const futureBase = structuredClone(manifest);
  futureBase.frames[0].hoverGridSchemaVersion = 5;
  assert.equal(normalizeManifest(futureBase, "hrrr", "conus").frames[0].hoverGridSchemaVersion, null);

  const futureSupplemental = structuredClone(manifest);
  futureSupplemental.frames[0].hoverGridSupplemental.legacy.schemaVersion = 5;
  assert.equal(
    normalizeManifest(futureSupplemental, "hrrr", "conus").frames[0].hoverGridSupplemental.legacy.schemaVersion,
    null,
  );
});

test("canonical empty MVH3 and MVH4 are usable and cacheable with bound schema identities", async () => {
  const client = loadModule();
  for (const schemaVersion of [3, 4]) {
    const raw = buildHoverGridBinaryRaw({ schemaVersion, rows: 2, cols: 3, variables: {} });
    const item = {
      ...frame(160 + schemaVersion),
      hoverGridKey: `hover/empty-${schemaVersion}.bin.br`,
      hoverGridBytes: raw.length,
      hoverGridSchemaVersion: schemaVersion,
    };
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from(raw).buffer,
    });
    const result = await client.fetchHoverGridPayload(item);
    assert.deepEqual(result, { schemaVersion, rows: 2, cols: 3, variables: {} });
    const requestUrl = client.resolveHoverGridRequestUrls(item)[0];
    assert.match(requestUrl, new RegExp(`[?&]h=${schemaVersion}(?:&|$)`));
    assert.strictEqual(client.getCachedHoverGridPayload(requestUrl), result);
  }
});

test("hover cache counts shared URL, supplemental, and merged backing stores exactly once", async () => {
  const client = loadModule();
  const baseRaw = buildHoverGridBinaryRaw({
    schemaVersion: 3,
    rows: 1,
    cols: 2,
    variables: {
      base: { scale: 1, offset: 0, missing: -32768, values: new Int16Array([10, 20]) },
      shared: { scale: 1, offset: 0, missing: -32768, values: new Int16Array([1, 2]) },
    },
  });
  const supplementalRaw = buildHoverGridBinaryRaw({
    schemaVersion: 4,
    rows: 1,
    cols: 2,
    variables: {
      supplemental: { scale: 1, offset: 0, missing: -32768, values: new Int16Array([30, 40]) },
      shared: { scale: 1, offset: 0, missing: -32768, values: new Int16Array([99, 98]) },
    },
  });
  const baseBuffer = Uint8Array.from(baseRaw).buffer;
  const supplementalBuffer = Uint8Array.from(supplementalRaw).buffer;
  const item = {
    ...frame(200),
    hoverGridKey: "hover/base.bin.br",
    hoverGridBytes: baseRaw.length,
    hoverGridSchemaVersion: 3,
    hoverGridSupplemental: {
      extra: {
        key: "hover/supplemental.bin.br",
        bytes: supplementalRaw.length,
        schemaVersion: 4,
      },
    },
  };
  const urls = client.resolveHoverGridRequestUrls(item);
  const buffersByUrl = new Map([
    [urls[0], baseBuffer],
    [urls[1], supplementalBuffer],
  ]);
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => buffersByUrl.get(String(url)),
  });

  const merged = await client.fetchHoverGridPayload(item);
  assert.equal(merged.schemaVersion, 4, "mixed v3/v4 supplementals preserve the newest decoded schema");
  assert.strictEqual(merged.variables.base.values.buffer, baseBuffer);
  assert.strictEqual(merged.variables.supplemental.values.buffer, supplementalBuffer);
  assert.deepEqual(Array.from(merged.variables.shared.values), [99, 98], "later supplemental variables win by key");
  assert.strictEqual(merged.variables.shared.values.buffer, supplementalBuffer);
  assert.deepEqual(client._testGetHoverGridPayloadCacheStats(), {
    entries: 3,
    bytes:
      client._testGetHoverGridPayloadCacheStats().metadataBytes + baseBuffer.byteLength + supplementalBuffer.byteLength,
    metadataBytes: client._testGetHoverGridPayloadCacheStats().metadataBytes,
    backingStores: 2,
    backingBytes: baseBuffer.byteLength + supplementalBuffer.byteLength,
    backingReferences: [2, 2],
  });

  assert.equal(client._testDeleteCachedHoverGridPayload(urls[0]), true);
  let stats = client._testGetHoverGridPayloadCacheStats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.backingStores, 2);
  assert.equal(stats.backingBytes, baseBuffer.byteLength + supplementalBuffer.byteLength);
  assert.deepEqual(stats.backingReferences, [1, 2]);

  assert.equal(client._testDeleteCachedHoverGridPayload(urls.join("|")), true);
  stats = client._testGetHoverGridPayloadCacheStats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.backingStores, 1);
  assert.equal(stats.backingBytes, supplementalBuffer.byteLength);
  assert.deepEqual(stats.backingReferences, [1]);

  assert.equal(client._testDeleteCachedHoverGridPayload(urls[1]), true);
  assert.deepEqual(client._testGetHoverGridPayloadCacheStats(), {
    entries: 0,
    bytes: 0,
    metadataBytes: 0,
    backingStores: 0,
    backingBytes: 0,
    backingReferences: [],
  });
});

test("supplemental dimension mismatch rejects without admitting a merged cache entry", async () => {
  const client = loadModule();
  const baseRaw = buildHoverGridBinaryRaw({
    schemaVersion: 3,
    rows: 1,
    cols: 2,
    variables: {
      base: { scale: 1, offset: 0, missing: -32768, values: new Int16Array([10, 20]) },
    },
  });
  const supplementalRaw = buildHoverGridBinaryRaw({
    schemaVersion: 4,
    rows: 2,
    cols: 2,
    variables: {
      extra: { scale: 1, offset: 0, missing: -32768, values: new Int16Array([1, 2, 3, 4]) },
    },
  });
  const item = {
    ...frame(201),
    hoverGridKey: "hover/mismatch-base.bin.br",
    hoverGridSchemaVersion: 3,
    hoverGridSupplemental: {
      extra: { key: "hover/mismatch-extra.bin.br", bytes: supplementalRaw.length, schemaVersion: 4 },
    },
  };
  const urls = client.resolveHoverGridRequestUrls(item);
  const bodies = new Map([
    [urls[0], baseRaw],
    [urls[1], supplementalRaw],
  ]);
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Uint8Array.from(bodies.get(String(url))).buffer,
  });

  await assert.rejects(client.fetchHoverGridPayload(item), /dimensions do not match/);
  assert.equal(client.getCachedHoverGridPayload(urls.join("|")), null);
  assert.ok(client.getCachedHoverGridPayload(urls[0]));
  assert.ok(client.getCachedHoverGridPayload(urls[1]));
});

test("hover cache replacement, shared views, LRU promotion, and centralized eviction preserve accounting", () => {
  const client = loadModule();
  const shared = new ArrayBuffer(256);
  const replacement = new ArrayBuffer(384);
  const payloadFrom = (buffer, key) => ({
    schemaVersion: 3,
    rows: 1,
    cols: 2,
    variables: {
      [key]: {
        scale: 1,
        offset: 0,
        missing: -32768,
        values: new Int16Array(buffer, 0, 2),
      },
      [`${key}Alias`]: {
        scale: 1,
        offset: 0,
        missing: -32768,
        values: new Int16Array(buffer, 4, 2),
      },
    },
  });
  const sharedPayload = payloadFrom(shared, "shared");

  client._testCacheHoverGridPayload("a", sharedPayload);
  client._testCacheHoverGridPayload("b", sharedPayload);
  let stats = client._testGetHoverGridPayloadCacheStats();
  assert.equal(stats.backingStores, 1, "two variables and two entries share one backing store");
  assert.equal(stats.backingBytes, shared.byteLength, "accounting charges the whole retained owner, not view lengths");
  assert.deepEqual(stats.backingReferences, [2]);
  assert.equal(stats.bytes, stats.metadataBytes + shared.byteLength);

  client._testCacheHoverGridPayload("a", payloadFrom(replacement, "replacement"));
  stats = client._testGetHoverGridPayloadCacheStats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.backingStores, 2);
  assert.equal(stats.backingBytes, shared.byteLength + replacement.byteLength);
  assert.deepEqual(stats.backingReferences, [1, 1]);

  client._testResetHoverGridPayloadCache();
  for (let index = 0; index < 6; index += 1) {
    client._testCacheHoverGridPayload(`lru-${index}`, sharedPayload);
  }
  assert.ok(client.getCachedHoverGridPayload("lru-0"), "touch the oldest entry");
  client._testCacheHoverGridPayload("lru-6", sharedPayload);
  assert.ok(client.getCachedHoverGridPayload("lru-0"), "promoted entry survives");
  assert.equal(client.getCachedHoverGridPayload("lru-1"), null, "untouched oldest entry is evicted");
  stats = client._testGetHoverGridPayloadCacheStats();
  assert.equal(stats.entries, 6);
  assert.equal(stats.backingStores, 1);
  assert.equal(stats.backingBytes, shared.byteLength);
  assert.deepEqual(stats.backingReferences, [6]);
  assert.equal(stats.bytes, stats.metadataBytes + shared.byteLength);
});

test("byte-limit eviction releases a shared owner only after its last cache entry", () => {
  const client = loadModule({ hoverCacheLimitMb: 0.001 });
  const firstBacking = new ArrayBuffer(512);
  const secondBacking = new ArrayBuffer(512);
  const payloadFrom = (buffer, key) => ({
    schemaVersion: 3,
    rows: 1,
    cols: 1,
    variables: {
      [key]: { scale: 1, offset: 0, missing: -32768, values: new Int16Array(buffer, 0, 1) },
    },
  });
  const first = payloadFrom(firstBacking, "first");

  client._testCacheHoverGridPayload("first-a", first);
  client._testCacheHoverGridPayload("first-b", first);
  assert.deepEqual(client._testGetHoverGridPayloadCacheStats().backingReferences, [2]);
  client._testCacheHoverGridPayload("second", payloadFrom(secondBacking, "second"));

  assert.equal(client.getCachedHoverGridPayload("first-a"), null);
  assert.equal(client.getCachedHoverGridPayload("first-b"), null);
  assert.ok(client.getCachedHoverGridPayload("second"));
  const stats = client._testGetHoverGridPayloadCacheStats();
  assert.equal(stats.entries, 1);
  assert.equal(stats.backingStores, 1);
  assert.equal(stats.backingBytes, secondBacking.byteLength);
  assert.deepEqual(stats.backingReferences, [1]);
  assert.equal(stats.bytes, stats.metadataBytes + secondBacking.byteLength);
  assert.ok(stats.bytes <= Math.round(0.001 * 1024 * 1024));
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
