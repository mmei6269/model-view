"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createLocalArtifactServer } = require("../scripts/lib/local-artifact-server");

function request(port, method, rawPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: rawPath,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          ...(extraHeaders || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function withServer(options, run) {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-cache-actions-"));
  const { runtime, server, actions } = createLocalArtifactServer({ cacheRoot, ...options });
  await runtime.init();
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run({ runtime, cacheRoot, actions, port: server.address().port });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  }
}

// Minimal fake spawn: a child that stays "running" until _emitExit is called,
// so tests can hold a job active across requests.
function makeFakeSpawn() {
  const children = [];
  const spawnBuildProcess = (scriptPath, argv, spawnOptions) => {
    const listeners = { exit: [], error: [] };
    const child = {
      pid: 5150 + children.length,
      stdout: null,
      stderr: null,
      on(event, cb) {
        (listeners[event] = listeners[event] || []).push(cb);
      },
      kill() {
        for (const cb of listeners.exit) {
          cb(0, "SIGTERM");
        }
      },
      _emitExit(code) {
        for (const cb of listeners.exit) {
          cb(code, null);
        }
      },
    };
    void scriptPath;
    void argv;
    void spawnOptions;
    children.push(child);
    return child;
  };
  return { spawnBuildProcess, children };
}

const RENDER_BODY = {
  models: ["hrrr"],
  view: "conus",
  run: "latest",
  categories: {
    surface: true,
    precip: true,
    radar: true,
    cloud: true,
    upperAir: true,
    severe: { enabled: true, tier: "full" },
    winter: { enabled: true, tier: "full" },
  },
};

async function seedRun(cacheRoot, model, runId, { tileBytes = 512, view = "conus" } = {}) {
  const manifestsDir = path.join(cacheRoot, "artifacts", "manifests", model);
  await fs.promises.mkdir(manifestsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(manifestsDir, `${runId}--${view}.json`),
    JSON.stringify({ model, run: runId, view, frames: [{ hour: 0 }], hourStatus: {} }),
  );
  const tilesDir = path.join(cacheRoot, "artifacts", "tiles", model, runId, view, "0");
  await fs.promises.mkdir(tilesDir, { recursive: true });
  await fs.promises.writeFile(path.join(tilesDir, "frame.png"), Buffer.alloc(tileBytes, 7));
}

async function seedLatestPointer(cacheRoot, model, runId, view = "conus") {
  const manifestsDir = path.join(cacheRoot, "artifacts", "manifests", model);
  await fs.promises.mkdir(manifestsDir, { recursive: true });
  await fs.promises.writeFile(path.join(manifestsDir, `latest--${view}.json`), JSON.stringify({ model, run: runId }));
}

async function seedRaw(cacheRoot, model, date, cycle, bytes = 256) {
  const rawDir = path.join(cacheRoot, "raw-noaa", "idx", model, date, cycle);
  await fs.promises.mkdir(rawDir, { recursive: true });
  await fs.promises.writeFile(path.join(rawDir, "inventory.idx"), Buffer.alloc(bytes, 3));
}

test("cache-stats reports totals and per-run sizes, newest run flagged latest", async () => {
  await withServer({}, async ({ cacheRoot, port }) => {
    await seedRun(cacheRoot, "hrrr", "20260703-0600Z", { tileBytes: 1024 });
    await seedRun(cacheRoot, "hrrr", "20260703-1200Z", { tileBytes: 2048 });
    await seedLatestPointer(cacheRoot, "hrrr", "20260703-1200Z");
    await seedRaw(cacheRoot, "hrrr", "20260703", "12", 512);

    const res = await request(port, "GET", "/actions/cache-stats");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.totalBytes > 0, "totalBytes populated");
    assert.ok(body.artifactsBytes > 0, "artifactsBytes populated");
    assert.ok(body.rawBytes >= 512, "rawBytes covers seeded raw inputs");
    const hrrr = body.models.find((entry) => entry.model === "hrrr");
    assert.ok(hrrr, "hrrr model entry present");
    assert.equal(hrrr.runs[0].runId, "20260703-1200Z", "runs sorted newest-first");
    assert.equal(hrrr.runs[0].latest, true, "newest run flagged latest");
    assert.equal(hrrr.runs[1].latest, false);
    assert.ok(hrrr.runs[0].bytes >= 2048, "run bytes include tiles");
    assert.ok(hrrr.totalBytes >= hrrr.runs[0].bytes + hrrr.runs[1].bytes, "model total covers runs");
  });
});

test("cache-stats serves cached totals within TTL and recomputes with refresh=1", async () => {
  await withServer({}, async ({ cacheRoot, port }) => {
    await seedRun(cacheRoot, "hrrr", "20260703-0600Z", { tileBytes: 1024 });
    const first = JSON.parse((await request(port, "GET", "/actions/cache-stats")).body);

    // Grow the cache after the first scan.
    await seedRun(cacheRoot, "hrrr", "20260703-1200Z", { tileBytes: 4096 });

    const cached = JSON.parse((await request(port, "GET", "/actions/cache-stats")).body);
    assert.equal(cached.totalBytes, first.totalBytes, "within TTL the cached payload is served");

    const refreshed = JSON.parse((await request(port, "GET", "/actions/cache-stats?refresh=1")).body);
    assert.ok(refreshed.totalBytes > first.totalBytes, "refresh=1 recomputes from disk");
  });
});

test("cache/prune dry-run reports deletions without deleting; real prune keeps newest 4", async () => {
  await withServer({}, async ({ cacheRoot, port }) => {
    const runIds = ["20260703-0000Z", "20260703-0100Z", "20260703-0200Z", "20260703-0300Z", "20260703-0400Z"];
    for (const runId of runIds) {
      await seedRun(cacheRoot, "hrrr", runId);
    }
    await seedLatestPointer(cacheRoot, "hrrr", "20260703-0400Z");
    const oldestManifest = path.join(cacheRoot, "artifacts", "manifests", "hrrr", "20260703-0000Z--conus.json");

    const dry = await request(port, "POST", "/actions/cache/prune", { dryRun: true, keep: 4 });
    assert.equal(dry.status, 200);
    const dryBody = JSON.parse(dry.body);
    assert.equal(dryBody.dryRun, true);
    assert.ok(
      dryBody.deletions.some((entry) => entry.runId === "20260703-0000Z"),
      "dry-run plans the oldest run for deletion",
    );
    assert.ok(
      dryBody.deletions.every((entry) => !path.isAbsolute(entry.path)),
      "deletion paths are cacheRoot-relative",
    );
    assert.ok(fs.existsSync(oldestManifest), "dry-run deletes nothing");

    const real = await request(port, "POST", "/actions/cache/prune", { dryRun: false, keep: 4 });
    assert.equal(real.status, 200);
    assert.equal(fs.existsSync(oldestManifest), false, "real prune removes the oldest run");
    const remaining = (await fs.promises.readdir(path.join(cacheRoot, "artifacts", "manifests", "hrrr"))).filter(
      (name) => !name.startsWith("latest--"),
    );
    assert.equal(remaining.length, 4, "newest 4 runs retained");
    assert.ok(
      fs.existsSync(path.join(cacheRoot, "artifacts", "manifests", "hrrr", "latest--conus.json")),
      "latest pointer untouched",
    );
  });
});

test("cache/prune and cache/clear refuse while a job is active", async () => {
  const spawn = makeFakeSpawn();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const render = await request(port, "POST", "/actions/render", RENDER_BODY);
    assert.equal(render.status, 200, "render job accepted");

    const prune = await request(port, "POST", "/actions/cache/prune", { dryRun: false });
    assert.equal(prune.status, 409, "prune refused while a job is running");
    const clear = await request(port, "POST", "/actions/cache/clear", { confirm: "CLEAR" });
    assert.equal(clear.status, 409, "clear refused while a job is running");

    spawn.children[0]._emitExit(0);
    const pruneAfter = await request(port, "POST", "/actions/cache/prune", { dryRun: true });
    assert.equal(pruneAfter.status, 200, "prune allowed once the job exits");
  });
});

test("cache/clear requires the typed confirm token and clears artifacts + raw inputs", async () => {
  await withServer({}, async ({ cacheRoot, port }) => {
    await seedRun(cacheRoot, "hrrr", "20260703-0600Z", { tileBytes: 2048 });
    await seedRaw(cacheRoot, "hrrr", "20260703", "06", 256);

    const unconfirmed = await request(port, "POST", "/actions/cache/clear", {});
    assert.equal(unconfirmed.status, 400, "missing confirm token rejected");
    const wrongToken = await request(port, "POST", "/actions/cache/clear", { confirm: "clear" });
    assert.equal(wrongToken.status, 400, "confirm token is exact-match");

    const cleared = await request(port, "POST", "/actions/cache/clear", { confirm: "CLEAR" });
    assert.equal(cleared.status, 200);
    const body = JSON.parse(cleared.body);
    assert.ok(body.removedBytes >= 2048, "removedBytes reports what was freed");
    const manifests = await fs.promises.readdir(path.join(cacheRoot, "artifacts", "manifests")).catch(() => []);
    assert.equal(manifests.length, 0, "manifests removed");
    const raw = await fs.promises.readdir(path.join(cacheRoot, "raw-noaa")).catch(() => []);
    assert.equal(raw.length, 0, "raw inputs removed");

    const stats = JSON.parse((await request(port, "GET", "/actions/cache-stats?refresh=1")).body);
    assert.equal(stats.models.length, 0, "stats reflect the cleared cache");
  });
});

test("cache mutation routes reject cross-origin POSTs", async () => {
  await withServer({}, async ({ port }) => {
    const prune = await request(
      port,
      "POST",
      "/actions/cache/prune",
      { dryRun: true },
      { Origin: "https://evil.example" },
    );
    assert.equal(prune.status, 403);
    const clear = await request(
      port,
      "POST",
      "/actions/cache/clear",
      { confirm: "CLEAR" },
      { Origin: "https://evil.example" },
    );
    assert.equal(clear.status, 403);
  });
});

test("render and prefetch refuse while a destructive cache mutation is in flight", async () => {
  const spawn = makeFakeSpawn();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ actions, port }) => {
    actions.cacheMutationCount = 1;
    const render = await request(port, "POST", "/actions/render", RENDER_BODY);
    assert.equal(render.status, 409, "render refused during prune/clear");
    const prefetch = await request(port, "POST", "/actions/prefetch-soundings", { models: ["hrrr"] });
    assert.equal(prefetch.status, 409, "prefetch refused during prune/clear");
    assert.equal(spawn.children.length, 0, "nothing spawned during the mutation");

    actions.cacheMutationCount = 0;
    const after = await request(port, "POST", "/actions/render", RENDER_BODY);
    assert.equal(after.status, 200, "render allowed once the mutation finishes");
  });
});

test("cache mutation bodies that parse to non-objects are treated as empty, never hang", async () => {
  await withServer({}, async ({ port }) => {
    // JSON literal `null` body: must not collide with the responded sentinel.
    const pruneNull = await request(port, "POST", "/actions/cache/prune", null);
    assert.equal(pruneNull.status, 200, "null body behaves as an empty body (dry run default)");
    assert.equal(JSON.parse(pruneNull.body).dryRun, true);

    const clearNull = await request(port, "POST", "/actions/cache/clear", null);
    assert.equal(clearNull.status, 400, "null body means no confirm token");

    const clearArray = await request(port, "POST", "/actions/cache/clear", [1, 2]);
    assert.equal(clearArray.status, 400, "array body means no confirm token");
  });
});

test("a destructive prune invalidates cached stats so the next read rescans", async () => {
  await withServer({}, async ({ cacheRoot, port }) => {
    const runIds = ["20260703-0000Z", "20260703-0100Z", "20260703-0200Z", "20260703-0300Z", "20260703-0400Z"];
    for (const runId of runIds) {
      await seedRun(cacheRoot, "hrrr", runId, { tileBytes: 4096 });
    }
    await seedLatestPointer(cacheRoot, "hrrr", "20260703-0400Z");

    const before = JSON.parse((await request(port, "GET", "/actions/cache-stats")).body);
    const pruned = await request(port, "POST", "/actions/cache/prune", { dryRun: false, keep: 4 });
    assert.equal(pruned.status, 200);

    // No refresh=1: the invalidation alone must force a rescan.
    const after = JSON.parse((await request(port, "GET", "/actions/cache-stats")).body);
    assert.ok(after.totalBytes < before.totalBytes, "stats reflect the prune without an explicit refresh");
  });
});

test("serve-time metadata refresh updates presentation fields but preserves build-time provenance", async () => {
  await withServer({}, async ({ cacheRoot, port }) => {
    const manifestsDir = path.join(cacheRoot, "artifacts", "manifests", "hrrr");
    await fs.promises.mkdir(manifestsDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(manifestsDir, "20260703-0600Z--conus.json"),
      JSON.stringify({
        model: "hrrr",
        run: "20260703-0600Z",
        view: "conus",
        frames: [{ hour: 0 }],
        hourStatus: {},
        parameters: {
          temperature: {
            key: "temperature",
            label: "Stale Label From Build Time",
            unit: "F",
            legendTicks: [1, 2],
            legendTickPositions: [],
            legendStops: [[0, [0, 0, 0]]],
            // Build-time provenance/gating that must survive the refresh.
            methodVersion: "built-with-v1",
            minForecastHour: 99,
            category: "surface",
          },
        },
      }),
    );

    const res = await request(port, "GET", "/manifests/hrrr/20260703-0600Z.json?view=conus");
    assert.equal(res.status, 200);
    const manifest = JSON.parse(res.body);
    const entry = manifest.parameters.temperature;
    assert.equal(entry.label, "Temp", "presentation label refreshed from the catalog");
    assert.ok(entry.legendTickPositions.length > 0, "tick positions refreshed from the catalog");
    assert.equal(entry.methodVersion, "built-with-v1", "provenance preserved from build time");
    assert.equal(entry.minForecastHour, 99, "gating preserved from build time");
    assert.ok(!manifest.parameters.sbcape, "keys are never added: selective-build filtering survives the refresh");
  });
});
