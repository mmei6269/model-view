"use strict";

// Regression for the 2026-07-19 nam3km report: the run-list frame chip read
// "61 frames" while only 13 hours were published. The display probe used a
// binary search over the hour roster assuming contiguous-prefix publication,
// so out-of-order posting (F013 missing while F030+ were already up) read
// full horizon — and getCachedRunFrameCount then lifetime-cached the
// overestimate as complete. The display probe now resolves the same strict
// sequential prefix the builder renders (resolveAvailableNoaaHours), so a
// chip can never claim more frames than a render would build.

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createLocalArtifactServer } = require("../scripts/lib/local-artifact-server");
const { buildFullHoursForModel } = require("../scripts/lib/noaa-build/run-resolution");

function request(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(run) {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-frame-count-"));
  const { runtime, server, actions } = createLocalArtifactServer({ cacheRoot });
  await runtime.init();
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run({ runtime, actions, port: server.address().port });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  }
}

function listObjectsXml(keys) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<ListBucketResult>",
    "<IsTruncated>false</IsTruncated>",
    ...keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`),
    "</ListBucketResult>",
  ].join("");
}

// Stubs global.fetch with a per-(date, cycle, hour) verdict map for NAM
// conusnest probes. Tests can expose the S3 ListObjectsV2 fast path or leave
// it unsupported to exercise the ordered-HEAD fallback. Returns the probe log.
function stubNoaa(t, verdictFor, { objectListing = false } = {}) {
  const originalFetch = global.fetch;
  const probed = [];
  global.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    if (options?.method === "GET" && parsed.searchParams.get("list-type") === "2") {
      const prefix = parsed.searchParams.get("prefix") || "";
      const listingMatch = prefix.match(/^nam\.(\d{8})\/nam\.t(\d{2})z\.conusnest\.hiresf$/);
      if (!objectListing || !listingMatch) {
        return { ok: false, status: 404 };
      }
      const [, date, cycle] = listingMatch;
      probed.push({ kind: "list", date, cycle, hour: null });
      if (objectListing === "malformed") {
        return {
          ok: true,
          status: 200,
          text: async () => "<ListBucketResult><IsTruncated>false</IsTruncated>",
        };
      }
      const keys = Array.from({ length: 61 }, (_, hour) => hour)
        .filter((hour) => verdictFor(date, cycle, hour))
        .map((hour) => `${prefix}${String(hour).padStart(2, "0")}.tm00.grib2.idx`);
      return { ok: true, status: 200, text: async () => listObjectsXml(keys) };
    }
    const match = String(url).match(/nam\.(\d{8})\/nam\.t(\d{2})z\.conusnest\.hiresf(\d{2})\.tm00\.grib2\.idx$/);
    if (!match) {
      return { ok: false, status: 404 };
    }
    const [, date, cycle, hourText] = match;
    const hour = Number(hourText);
    probed.push({ kind: "head", date, cycle, hour });
    return { ok: Boolean(verdictFor(date, cycle, hour)) };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  return probed;
}

// Derived, not hardcoded: the server's upstream probe only checks the 8 most
// recent cycles, so a literal date ages out of the candidate window within
// two days of being written (the original 20260719 fixture did exactly that).
const RUN_DATE = (() => {
  const { buildRecentCycleCandidates } = require("../scripts/lib/noaa-build/run-resolution");
  const candidate = buildRecentCycleCandidates("nam3km")
    .slice(0, 8)
    .find((entry) => entry.cycle === "00");
  assert.ok(candidate, "the 8 most recent nam3km cycles always span a 00Z run");
  return candidate.date;
})();
const RUN_ID = `${RUN_DATE}-0000Z`;

test("run-list chip reports the strict sequential prefix during out-of-order posting", async (t) => {
  // The user's case: F013 missing while F014..F060 are already posted. The old
  // binary search read 61 here; exact prefix membership must read 13.
  const probed = stubNoaa(t, (date, cycle, hour) => date === RUN_DATE && cycle === "00" && hour !== 13, {
    objectListing: true,
  });
  await withServer(async ({ actions, port }) => {
    const first = await request(port, "/actions/available-runs?models=nam3km&view=conus");
    assert.equal(first.status, 200);
    const upstream = first.body.runs.nam3km.upstream;
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].runId, RUN_ID);
    assert.equal(upstream[0].frameCount, 13, "chip shows the sequential prefix, not the out-of-order tail");
    assert.equal(upstream[0].maxHour, 12);

    // The probe is marked incomplete, so it is NOT lifetime-frozen: it is
    // served from the 60s TTL cache now and re-resolved after expiry.
    const cached = actions.runFrameCountCache.get(`nam3km|${RUN_ID}`);
    assert.equal(cached?.result?.frameCount, 13);
    assert.equal(cached?.complete, false, "an out-of-order overestimate must never be marked lifetime-complete");
    assert.equal(
      probed.filter((probe) => probe.kind === "list" && probe.date === RUN_DATE).length,
      1,
      "one listing finds the exact gap without a HEAD per forecast hour",
    );
    // The capped listing earns the boundary confirm at the gap — probe plus
    // miss re-probe, guarding against a stale listing replica AND a
    // transient HEAD failure — never one HEAD per hour.
    assert.deepEqual(
      probed.filter((probe) => probe.kind === "head" && probe.date === RUN_DATE && probe.hour !== 0).map((p) => p.hour),
      [13, 13],
    );
  });
});

test("a fully published run reports full horizon and is lifetime-cached", async (t) => {
  const probed = stubNoaa(t, (date, cycle) => date === RUN_DATE && cycle === "00", { objectListing: true });
  await withServer(async ({ actions, port }) => {
    const first = await request(port, "/actions/available-runs?models=nam3km&view=conus");
    const upstream = first.body.runs.nam3km.upstream;
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].frameCount, 61);
    assert.equal(upstream[0].maxHour, 60);
    assert.equal(actions.runFrameCountCache.get(`nam3km|${RUN_ID}`)?.complete, true);

    const frameCountProbes = probed.filter((p) => p.kind === "list" && p.date === RUN_DATE).length;
    const second = await request(port, "/actions/available-runs?models=nam3km&view=conus");
    assert.equal(second.body.runs.nam3km.upstream[0].frameCount, 61);
    const frameCountProbesAfter = probed.filter((p) => p.kind === "list" && p.date === RUN_DATE).length;
    assert.equal(frameCountProbesAfter, frameCountProbes, "a complete probe is served from the lifetime cache");
  });
});

test("an incomplete object listing falls back to ordered frame probes", async (t) => {
  const probed = stubNoaa(t, (date, cycle) => date === RUN_DATE && cycle === "00", {
    objectListing: "malformed",
  });
  await withServer(async ({ port }) => {
    const response = await request(port, "/actions/available-runs?models=nam3km&view=conus");
    assert.equal(response.status, 200);
    assert.equal(response.body.runs.nam3km.upstream[0].frameCount, 61);
    assert.equal(probed.filter((probe) => probe.kind === "list" && probe.date === RUN_DATE).length, 1);
    assert.equal(
      probed.filter((probe) => probe.kind === "head" && probe.date === RUN_DATE && probe.hour !== 0).length,
      60,
      "malformed listing must use the safe ordered-HEAD fallback",
    );
  });
});

test("a cold full-GFS request uses one object listing instead of 209 frame HEADs", async (t) => {
  const originalFetch = global.fetch;
  const probes = [];
  let selectedRun = null;
  const fullHours = buildFullHoursForModel("gfs", { cycle: "00", gfsHourlyThrough120: true });
  assert.equal(fullHours.length, 209);

  global.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    if (options?.method === "GET" && parsed.searchParams.get("list-type") === "2") {
      const prefix = parsed.searchParams.get("prefix") || "";
      probes.push({ kind: "list", prefix });
      const keys = fullHours.map((hour) => `${prefix}${String(hour).padStart(3, "0")}.idx`);
      return { ok: true, status: 200, text: async () => listObjectsXml(keys) };
    }
    const match = parsed.pathname.match(/gfs\.(\d{8})\/(\d{2})\/atmos\/gfs\.t\2z\.pgrb2\.0p25\.f(\d{3})\.idx$/);
    if (options?.method !== "HEAD" || !match) {
      return { ok: false, status: 404 };
    }
    const [, date, cycle, hour] = match;
    const runId = `${date}-${cycle}00Z`;
    probes.push({ kind: "head", runId, hour: Number(hour) });
    if (selectedRun === null) {
      selectedRun = runId;
    }
    return { ok: runId === selectedRun && Number(hour) === 0, status: runId === selectedRun ? 200 : 404 };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await withServer(async ({ port }) => {
    const response = await request(port, "/actions/available-runs?models=gfs&view=conus");
    assert.equal(response.status, 200);
    assert.equal(response.body.runs.gfs.upstream.length, 1);
    assert.equal(response.body.runs.gfs.upstream[0].frameCount, 209);
    assert.equal(response.body.runs.gfs.upstream[0].maxHour, 384);
    assert.equal(probes.filter((probe) => probe.kind === "list").length, 1);
    assert.equal(
      probes.filter((probe) => probe.kind === "head" && probe.hour !== 0).length,
      0,
      "the frame-count path launches no per-hour HEAD probes",
    );
    assert.ok(probes.length <= 9, `cold picker request stays bounded (saw ${probes.length} upstream requests)`);
  });
});

test("a transient boundary miss is confirmed so the chip does not under-read", async (t) => {
  // One flaky 404 at F013 while everything is actually published: the confirm
  // probe must rescue the full prefix rather than freezing at 13.
  let missRemaining = 1;
  stubNoaa(t, (date, cycle, hour) => {
    if (date !== RUN_DATE || cycle !== "00") {
      return false;
    }
    if (hour === 13 && missRemaining > 0) {
      missRemaining -= 1;
      return false;
    }
    return true;
  });
  await withServer(async ({ port }) => {
    const first = await request(port, "/actions/available-runs?models=nam3km&view=conus");
    assert.equal(first.body.runs.nam3km.upstream[0].frameCount, 61, "the transient miss is confirmed away");
  });
});

test("a run whose F000 is absent is simply not listed", async (t) => {
  stubNoaa(t, () => false);
  await withServer(async ({ port }) => {
    const first = await request(port, "/actions/available-runs?models=nam3km&view=conus");
    assert.equal(first.status, 200);
    assert.equal(first.body.runs.nam3km.upstream.length, 0);
  });
});
