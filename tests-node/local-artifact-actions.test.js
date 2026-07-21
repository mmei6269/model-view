"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createLocalArtifactServer } = require("../scripts/lib/local-artifact-server");
const { buildRecentCycleCandidates } = require("../scripts/lib/noaa-build/run-resolution");

// A run inside the model's latest-resolution candidate window (the newest
// recent cycle): a latest render CAN resolve to it, so it must conflict.
// The 20260703 fixtures elsewhere in this file are archived runs a latest
// request can never land on (the window spans 72 h).
function recentCandidateRunId(modelKey = "hrrr") {
  const candidate = buildRecentCycleCandidates(modelKey)[0];
  return `${candidate.date}-${candidate.cycle}00Z`;
}

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
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-actions-"));
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

test("available-runs returns built runs and probed upstream runs without touching NOAA", async () => {
  let probeCalls = 0;
  const stubProbe = async ({ modelKey }) => {
    probeCalls += 1;
    return [{ date: "20260703", cycle: "12", runId: "20260703-1200Z" }];
  };
  // Per-run frame probe stub: upstream cycle has 49 published frames; the
  // built run's cycle has 49 too (more than its 1 built frame).
  const frameCounts = {
    "20260703-1200Z": { frameCount: 49, maxHour: 48 },
    "20260703-0600Z": { frameCount: 49, maxHour: 48 },
  };
  const stubFrameCount = async ({ runId }) => frameCounts[runId] || null;
  await withServer({ probeUpstreamRuns: stubProbe, probeRunFrameCount: stubFrameCount }, async ({ runtime, port }) => {
    const runId = "20260703-0600Z";
    const manifestPath = runtime.getManifestStoragePath("hrrr", runId, runtime.defaultViewKey);
    await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.promises.writeFile(
      manifestPath,
      JSON.stringify({
        model: "hrrr",
        run: runId,
        view: runtime.defaultViewKey,
        frames: [{ hour: 0 }],
        hourStatus: {},
      }),
    );

    const res = await request(port, "GET", "/actions/available-runs?models=hrrr&view=conus");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.view, "conus");
    assert.ok(Array.isArray(body.runs.hrrr.built), "built runs is an array");
    assert.equal(body.runs.hrrr.built[0].run, runId, "built run surfaced from listRunManifests");
    assert.equal(body.runs.hrrr.upstream[0].runId, "20260703-1200Z", "upstream run surfaced from the probe stub");
    assert.equal(probeCalls, 1, "upstream probe invoked exactly once for the one model");
    assert.equal(body.runs.hrrr.upstream[0].frameCount, 49, "upstream run carries its published frame count");
    assert.equal(body.runs.hrrr.upstream[0].maxHour, 48, "upstream run carries its max published hour");
    assert.equal(body.runs.hrrr.built[0].upstreamFrameCount, 49, "built run carries the upstream frame count");
  });
});

test("available-runs degrades frame counts to null when the probe fails, and caches per run", async () => {
  let frameProbeCalls = 0;
  await withServer(
    {
      probeUpstreamRuns: async () => [{ date: "20260703", cycle: "12", runId: "20260703-1200Z" }],
      probeRunFrameCount: async () => {
        frameProbeCalls += 1;
        throw new Error("NOAA unreachable");
      },
    },
    async ({ port }) => {
      const first = await request(port, "GET", "/actions/available-runs?models=hrrr&view=conus");
      assert.equal(first.status, 200, "probe failure never fails the endpoint");
      const body = JSON.parse(first.body);
      assert.equal(body.runs.hrrr.upstream[0].frameCount, null, "failed probe reads null");
      assert.equal(frameProbeCalls, 1, "one probe for the one run");

      const second = await request(port, "GET", "/actions/available-runs?models=hrrr&view=conus");
      assert.equal(second.status, 200);
      assert.equal(frameProbeCalls, 1, "second request within the TTL is served from the cache");
    },
  );
});

test("available-runs skips frame probing for built runs already at the model's full horizon", async () => {
  const { buildFullHoursForModel } = require("../scripts/lib/noaa-build/run-resolution");
  const fullHours = buildFullHoursForModel("hrrr");
  let frameProbeCalls = 0;
  await withServer(
    {
      probeUpstreamRuns: async () => [],
      probeRunFrameCount: async () => {
        frameProbeCalls += 1;
        return null;
      },
    },
    async ({ runtime, port }) => {
      const runId = "20260703-0600Z";
      const manifestPath = runtime.getManifestStoragePath("hrrr", runId, runtime.defaultViewKey);
      await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.promises.writeFile(
        manifestPath,
        JSON.stringify({
          model: "hrrr",
          run: runId,
          view: runtime.defaultViewKey,
          frames: fullHours.map((hour) => ({ hour })),
          hourStatus: {},
        }),
      );
      const res = await request(port, "GET", "/actions/available-runs?models=hrrr&view=conus");
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(
        body.runs.hrrr.built[0].upstreamFrameCount,
        fullHours.length,
        "full-horizon run reports its own count without probing",
      );
      assert.equal(frameProbeCalls, 0, "a run that cannot gain frames is never probed");
    },
  );
});

test("available-runs does not mistake NAM's 37-frame default tier for the official full horizon", async () => {
  const { buildFullHoursForModel } = require("../scripts/lib/noaa-build/run-resolution");
  const shortHours = buildFullHoursForModel("nam");
  let frameProbeCalls = 0;
  await withServer(
    {
      probeUpstreamRuns: async () => [],
      probeRunFrameCount: async () => {
        frameProbeCalls += 1;
        return { frameCount: 53, maxHour: 84 };
      },
    },
    async ({ runtime, port }) => {
      const runId = "20260703-0600Z";
      const manifestPath = runtime.getManifestStoragePath("nam", runId, runtime.defaultViewKey);
      await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.promises.writeFile(
        manifestPath,
        JSON.stringify({
          model: "nam",
          run: runId,
          view: runtime.defaultViewKey,
          frames: shortHours.map((hour) => ({ hour })),
          hourStatus: {},
        }),
      );
      const res = await request(port, "GET", "/actions/available-runs?models=nam&view=conus");
      assert.equal(res.status, 200);
      const built = JSON.parse(res.body).runs.nam.built[0];
      assert.equal(built.upstreamFrameCount, 53);
      assert.equal(built.upstreamMaxHour, 84);
      assert.equal(frameProbeCalls, 1, "a short-tier NAM build can still gain official-horizon frames");
    },
  );
});

test("available-runs distinguishes GFS's 129-frame default from its 209-frame published cadence", async () => {
  const { buildFullHoursForModel } = require("../scripts/lib/noaa-build/run-resolution");
  const defaultHours = buildFullHoursForModel("gfs");
  let frameProbeCalls = 0;
  await withServer(
    {
      probeUpstreamRuns: async () => [{ date: "20260703", cycle: "00", runId: "20260703-0000Z" }],
      probeRunFrameCount: async () => {
        frameProbeCalls += 1;
        return { frameCount: 209, maxHour: 384 };
      },
    },
    async ({ runtime, port }) => {
      const runId = "20260703-0000Z";
      const manifestPath = runtime.getManifestStoragePath("gfs", runId, runtime.defaultViewKey);
      await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.promises.writeFile(
        manifestPath,
        JSON.stringify({
          model: "gfs",
          run: runId,
          view: runtime.defaultViewKey,
          frames: defaultHours.map((hour) => ({ hour })),
          hourStatus: {},
        }),
      );
      const res = await request(port, "GET", "/actions/available-runs?models=gfs&view=conus");
      assert.equal(res.status, 200);
      const payload = JSON.parse(res.body).runs.gfs;
      const built = payload.built[0];
      assert.equal(built.frameCount, 129);
      assert.equal(built.upstreamFrameCount, 209, "legacy field remains the source-cadence count");
      assert.equal(built.upstreamSourceFrameCount, 209, "source cadence is explicit");
      assert.equal(built.upstreamDefaultRenderFrameCount, 129, "default renderer selects the 3-hourly subset");
      assert.equal(payload.upstream[0].frameCount, 209, "legacy upstream count remains source cadence");
      assert.equal(payload.upstream[0].sourceFrameCount, 209);
      assert.equal(payload.upstream[0].defaultRenderFrameCount, 129);
      assert.equal(frameProbeCalls, 1);
    },
  );
});

test("available-runs rejects an unknown model with 400 and does not probe", async () => {
  let probeCalls = 0;
  await withServer(
    {
      probeUpstreamRuns: async () => {
        probeCalls += 1;
        return [];
      },
    },
    async ({ port }) => {
      const res = await request(port, "GET", "/actions/available-runs?models=badmodel&view=conus");
      assert.equal(res.status, 400, "unknown model is rejected");
      assert.equal(probeCalls, 0, "no upstream probe for a rejected request");
    },
  );
});

test("available-runs rejects an unknown view with 400", async () => {
  await withServer({ probeUpstreamRuns: async () => [] }, async ({ port }) => {
    const res = await request(port, "GET", "/actions/available-runs?models=hrrr&view=mars");
    assert.equal(res.status, 400, "unknown view is rejected");
  });
});

function makeStubStream() {
  const listeners = {};
  return {
    on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
    },
    _emit(event, payload) {
      for (const cb of listeners[event] || []) {
        cb(payload);
      }
    },
  };
}

function makeSpawnStub() {
  const calls = [];
  const children = [];
  const spawnBuildProcess = (scriptPath, argv, spawnOptions) => {
    const listeners = { exit: [], error: [] };
    const child = {
      pid: 4242 + children.length,
      killed: false,
      stdout: makeStubStream(),
      stderr: makeStubStream(),
      on(event, cb) {
        (listeners[event] = listeners[event] || []).push(cb);
      },
      // Push builder-style output through the server's real line reader so
      // tests exercise the attachLineReader -> applyLogLine scrape path.
      _emitStdoutLine(line) {
        this.stdout._emit("data", Buffer.from(`${line}\n`, "utf8"));
      },
      kill() {
        this.killed = true;
        for (const cb of listeners.exit) {
          cb(0, "SIGTERM");
        }
      },
      _emitExit(code) {
        for (const cb of listeners.exit) {
          cb(code, null);
        }
      },
      _emitError(error) {
        for (const cb of listeners.error) {
          cb(error);
        }
      },
    };
    calls.push({ scriptPath, argv, spawnOptions });
    children.push(child);
    return child;
  };
  return { spawnBuildProcess, calls, children };
}

const VALID_RENDER_BODY = {
  models: ["hrrr"],
  view: "conus",
  run: "latest",
  categories: {
    surface: true,
    precip: true,
    radar: false,
    cloud: true,
    severe: { enabled: true, tier: "simple" },
    winter: { enabled: false, tier: "full" },
    upperAir: true,
  },
};

test("render spawns the builder with an argv array and returns a jobId", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.jobId, "a jobId is returned");
    assert.equal(spawn.calls.length, 1, "exactly one build spawned");
    const { scriptPath, argv } = spawn.calls[0];
    assert.ok(scriptPath.endsWith("build-noaa-beta-artifacts.js"), "spawns the builder script");
    assert.ok(Array.isArray(argv), "argv is an array (shell:false)");
    assert.ok(argv.includes("--models=hrrr"), "models flag marshalled");
    assert.ok(argv.includes("--view=conus"), "view flag marshalled");
    assert.ok(argv.includes("--hours=full"), "UI renders build every published frame, not DEFAULT_HOURS");
    assert.ok(argv.includes("--require-full-horizon"), "the UI full-horizon choice requires a completed horizon");
    assert.ok(argv.includes("--categories=surface,precip,cloud,severe,upperAir"), "enabled categories marshalled");
    assert.ok(argv.includes("--severe-tier=simple"), "severe tier marshalled");
    assert.ok(argv.includes("--winter-tier=full"), "winter tier marshalled even though winter is disabled");
    assert.ok(!argv.some((a) => /[;&|`$]/.test(a)), "no shell metacharacters reach argv");
  });
});

test("render rejects an unknown tier with 400 and does not spawn", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    bad.categories.severe.tier = "turbo";
    const res = await request(port, "POST", "/actions/render", bad);
    assert.equal(res.status, 400, "bad tier rejected");
    assert.equal(spawn.calls.length, 0, "no build spawned on a rejected selection");
  });
});

test("render rejects an unknown model with 400 and does not spawn", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    bad.models = ["hrrr", "badmodel"];
    const res = await request(port, "POST", "/actions/render", bad);
    assert.equal(res.status, 400, "bad model rejected");
    assert.equal(spawn.calls.length, 0, "no build spawned");
  });
});

test("render rejects a duplicate (model,run,view) job with 409 while running", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const first = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(first.status, 200, "first render accepted");
    const second = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(second.status, 409, "duplicate running job rejected");
    assert.equal(spawn.calls.length, 1, "duplicate did not spawn a second build");
  });
});

test("render only accepts POST", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "GET", "/actions/render");
    assert.equal(res.status, 405, "GET on the mutation route is rejected");
    assert.equal(spawn.calls.length, 0, "no spawn on a wrong-method request");
  });
});

const FULL_RENDER_BODY = {
  models: ["hrrr"],
  view: "conus",
  run: "latest",
  categories: {
    surface: true,
    precip: true,
    radar: true,
    cloud: true,
    severe: { enabled: true, tier: "full" },
    winter: { enabled: true, tier: "full" },
    upperAir: true,
  },
};

test("render canonicalizes a full selection to the no-flags default build", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const full = await request(port, "POST", "/actions/render", FULL_RENDER_BODY);
    assert.equal(full.status, 200, "full selection accepted");
    assert.equal(spawn.calls.length, 1, "full selection spawned");
    const fullArgv = spawn.calls[0].argv;
    assert.ok(
      !fullArgv.some(
        (a) => a.startsWith("--categories") || a.startsWith("--severe-tier") || a.startsWith("--winter-tier"),
      ),
      `full selection emits no selection flags (got ${JSON.stringify(fullArgv)})`,
    );
    assert.deepEqual(
      fullArgv,
      ["--models=hrrr", "--view=conus", "--hours=full", "--require-full-horizon"],
      "full selection argv carries no selection flags (--hours=full is orthogonal to selection parity)",
    );

    const partialBody = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    partialBody.models = ["nam3km"];
    const partial = await request(port, "POST", "/actions/render", partialBody);
    assert.equal(partial.status, 200, "partial selection accepted");
    assert.equal(spawn.calls.length, 2, "partial selection spawned");
    const partialArgv = spawn.calls[1].argv;
    assert.ok(
      partialArgv.includes("--categories=surface,precip,cloud,severe,upperAir"),
      "partial selection still emits --categories",
    );
    assert.ok(partialArgv.includes("--severe-tier=simple"), "partial selection still emits --severe-tier");
    assert.ok(partialArgv.includes("--winter-tier=full"), "partial selection still emits --winter-tier");
  });
});

test("render rejects run injection payloads with 400 and zero spawns", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    for (const run of ["../../etc", "$(whoami)"]) {
      const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
      bad.run = run;
      const res = await request(port, "POST", "/actions/render", bad);
      assert.equal(res.status, 400, `run ${JSON.stringify(run)} rejected`);
    }
    assert.equal(spawn.calls.length, 0, "no build spawned for any injection payload");
  });
});

test("render with a picked run spawns --date/--cycle (the builder has no --run flag)", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const body = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    body.run = "20260702-1200Z";
    const res = await request(port, "POST", "/actions/render", body);
    assert.equal(res.status, 200, "picked-run render accepted");
    const { jobId } = JSON.parse(res.body);
    assert.equal(spawn.calls.length, 1, "one build spawned");
    const { argv } = spawn.calls[0];
    assert.ok(argv.includes("--date=20260702"), `picked run translated to --date (got ${JSON.stringify(argv)})`);
    assert.ok(argv.includes("--cycle=12"), `picked run translated to --cycle (got ${JSON.stringify(argv)})`);
    assert.ok(
      !argv.some((a) => a.startsWith("--run=")),
      "no --run flag reaches the builder (it would be silently ignored and build latest)",
    );
    // The job/status surface still reports the picked run the build targets.
    const status = await request(port, "GET", `/actions/status/${jobId}`);
    assert.equal(JSON.parse(status.body).run, "20260702-1200Z", "job reports the picked run");
  });
});

test("render with per-model runs chains one build per distinct run (never two builders at once)", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const body = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    body.models = ["hrrr", "nam3km"];
    body.runs = { hrrr: "20260703-1900Z", nam3km: "20260703-1800Z" };
    const res = await request(port, "POST", "/actions/render", body);
    assert.equal(res.status, 200, "per-model runs accepted");
    const parsed = JSON.parse(res.body);
    assert.ok(Array.isArray(parsed.jobs), "response lists the spawned jobs");
    assert.equal(parsed.jobs.length, 2, "one job handle per build");
    assert.equal(parsed.jobId, parsed.jobs[0].jobId, "legacy jobId field mirrors the first job");
    assert.deepEqual(
      parsed.jobs.map((job) => job.run).sort(),
      ["20260703-1800Z", "20260703-1900Z"],
      "job handles report each group's run",
    );

    // Each builder sizes a full worker pool against the whole machine, so the
    // second group must wait for the first child to exit.
    assert.equal(spawn.calls.length, 1, "only the first group's builder spawns immediately");
    const queued = JSON.parse((await request(port, "GET", `/actions/status/${parsed.jobs[1].jobId}`)).body);
    assert.equal(queued.status, "queued", "the second group is queued, not running");

    spawn.children[0]._emitExit(0);
    assert.equal(spawn.calls.length, 2, "second group spawns after the first exits");
    const hrrrArgv = spawn.calls.find((call) => call.argv.includes("--models=hrrr")).argv;
    assert.ok(
      hrrrArgv.includes("--date=20260703") && hrrrArgv.includes("--cycle=19"),
      "hrrr build targets its own run",
    );
    const namArgv = spawn.calls.find((call) => call.argv.includes("--models=nam3km")).argv;
    assert.ok(namArgv.includes("--cycle=18"), "nam3km build targets its own run");
    const running = JSON.parse((await request(port, "GET", `/actions/status/${parsed.jobs[1].jobId}`)).body);
    assert.equal(running.status, "running", "queued job transitions to running");
  });
});

test("render groups models sharing a run into a single build", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const body = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    body.models = ["hrrr", "nam3km"];
    body.runs = { hrrr: "latest", nam3km: "latest" };
    const res = await request(port, "POST", "/actions/render", body);
    assert.equal(res.status, 200);
    assert.equal(spawn.calls.length, 1, "shared run keeps one multi-model build (global frame queue intact)");
    assert.ok(spawn.calls[0].argv.includes("--models=hrrr,nam3km"), "both models in the one build");
    assert.equal(JSON.parse(res.body).jobs.length, 1);
  });
});

test("render rejects runs entries for unselected models or with malformed ids", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const unselected = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    unselected.runs = { nam3km: "20260703-1800Z" }; // models is ["hrrr"]
    const first = await request(port, "POST", "/actions/render", unselected);
    assert.equal(first.status, 400, "runs key outside models[] rejected");

    const malformed = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    malformed.runs = { hrrr: "$(whoami)" };
    const second = await request(port, "POST", "/actions/render", malformed);
    assert.equal(second.status, 400, "malformed per-model run rejected");
    assert.equal(spawn.calls.length, 0, "no build spawned for any rejected runs map");
  });
});

test("render with per-model runs 409s when ANY group conflicts, spawning nothing", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const first = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    first.runs = { hrrr: "20260703-1900Z" };
    const started = await request(port, "POST", "/actions/render", first);
    assert.equal(started.status, 200, "first render accepted");
    assert.equal(spawn.calls.length, 1);

    const second = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    second.models = ["hrrr", "nam3km"];
    second.runs = { hrrr: "20260703-1900Z", nam3km: "20260703-1800Z" };
    const conflicted = await request(port, "POST", "/actions/render", second);
    assert.equal(conflicted.status, 409, "conflicting hrrr group rejects the whole request");
    assert.equal(spawn.calls.length, 1, "the non-conflicting nam3km group did not spawn either");
  });
});

test("render rejects a malformed picked run with 400 and zero spawns", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    for (const run of ["latest-ish", "2026-bad", "20260702-2400Z", "202607021200Z", "20260702-1200"]) {
      const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
      bad.run = run;
      const res = await request(port, "POST", "/actions/render", bad);
      assert.equal(res.status, 400, `run ${JSON.stringify(run)} rejected`);
    }
    assert.equal(spawn.calls.length, 0, "no build spawned for any malformed run");
  });
});

test("render rejects a selection with zero enabled categories with 400 and does not spawn", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    bad.categories = {
      surface: false,
      precip: false,
      radar: false,
      cloud: false,
      severe: { enabled: false, tier: "full" },
      winter: { enabled: false, tier: "full" },
      upperAir: false,
    };
    const res = await request(port, "POST", "/actions/render", bad);
    assert.equal(res.status, 400, "all-disabled selection rejected (would build an empty catalog)");
    assert.equal(spawn.calls.length, 0, "no build spawned");
  });
});

test("POST mutation routes reject non-localhost Origins with 403 and zero spawns", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const render = await request(port, "POST", "/actions/render", VALID_RENDER_BODY, {
      Origin: "http://evil.example",
    });
    assert.equal(render.status, 403, "cross-origin render rejected");
    const prefetch = await request(port, "POST", "/actions/prefetch-soundings", PREFETCH_BODY, {
      Origin: "http://evil.example",
    });
    assert.equal(prefetch.status, 403, "cross-origin prefetch rejected");
    assert.equal(spawn.calls.length, 0, "no spawn from a cross-origin POST");
  });
});

test("POST mutation routes accept localhost Origins and requests without an Origin", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    // Browser UI via the Vite dev server: Origin is a localhost origin.
    const fromUi = await request(port, "POST", "/actions/render", VALID_RENDER_BODY, {
      Origin: "http://localhost:5173",
    });
    assert.equal(fromUi.status, 200, "localhost Origin passes");
    assert.equal(spawn.calls.length, 1, "localhost-origin render spawned");
    // curl / server-to-server (Vite /__cf proxy): no Origin header at all.
    // (The archived prefetch run is provably disjoint from the still-
    // unresolved latest render, so no conflict interferes with this test.)
    await seedBuiltRun(runtime, PREFETCH_BODY.run, [0, 3]);
    const noOrigin = await request(port, "POST", "/actions/prefetch-soundings", PREFETCH_BODY);
    assert.equal(noOrigin.status, 200, "missing Origin passes");
    assert.equal(spawn.calls.length, 2, "origin-less prefetch spawned");
  });
});

test("render rejects an unknown view with 400 and does not spawn", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    bad.view = "conus$(whoami)";
    const res = await request(port, "POST", "/actions/render", bad);
    assert.equal(res.status, 400, "bad view rejected");
    assert.equal(spawn.calls.length, 0, "no build spawned");
  });
});

test("render rejects an unknown category key with 400 and does not spawn", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    bad.categories.evil = true;
    const res = await request(port, "POST", "/actions/render", bad);
    assert.equal(res.status, 400, "unknown category key rejected");
    assert.equal(spawn.calls.length, 0, "no build spawned");
  });
});

test("render job fails on child spawn error and stops 409-blocking its slot", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ actions, port }) => {
    const first = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(first.status, 200, "first render accepted");
    const { jobId } = JSON.parse(first.body);

    spawn.children[0]._emitError(new Error("spawn EMFILE"));
    const job = actions.jobs.getJob(jobId);
    assert.equal(job.status, "failed", "spawn error transitions the job out of running");
    assert.match(job.error, /EMFILE/, "spawn error message recorded on the job");
    assert.ok(job.endedAt, "spawn error stamps endedAt");
    assert.equal(actions.jobs.children.size, 0, "dead child removed from the kill set");

    const second = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(second.status, 200, "errored job no longer 409-blocks the (model,run,view) slot");
    assert.equal(spawn.calls.length, 2, "retry spawned a fresh build");
  });
});

test("render rejects a single-model duplicate of any model in a running multi-model job", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const multi = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    multi.models = ["hrrr", "nam3km"];
    const first = await request(port, "POST", "/actions/render", multi);
    assert.equal(first.status, 200, "multi-model render accepted");

    const secondary = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    secondary.models = ["nam3km"];
    const second = await request(port, "POST", "/actions/render", secondary);
    assert.equal(second.status, 409, "secondary model of a running multi-model job is a duplicate");
    assert.equal(spawn.calls.length, 1, "duplicate did not spawn a second build");
  });
});

const PREFETCH_BODY = { model: "hrrr", run: "20260703-0600Z", view: "conus", hours: [0, 3] };

test("prefetch-soundings spawns the prefetch script with an argv array (legacy single-model body)", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    await seedBuiltRun(runtime, "20260703-0600Z", [0, 3, 6]);
    const res = await request(port, "POST", "/actions/prefetch-soundings", PREFETCH_BODY);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.jobId, "prefetch returns a jobId");
    assert.equal(spawn.calls.length, 1, "one prefetch spawned");
    const { scriptPath, argv } = spawn.calls[0];
    assert.ok(scriptPath.endsWith("prefetch-point-soundings.js"), "spawns the prefetch script");
    assert.ok(Array.isArray(argv), "argv is an array");
    assert.ok(argv.includes("--models=hrrr"), "model marshalled");
    assert.ok(argv.includes("--view=conus"), "view marshalled");
    assert.ok(argv.includes("--runs=20260703-0600Z"), "run marshalled");
  });
});

test("prefetch-soundings rejects a bad model with 400 and does not spawn", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/prefetch-soundings", { ...PREFETCH_BODY, model: "nope" });
    assert.equal(res.status, 400);
    assert.equal(spawn.calls.length, 0, "no spawn on a rejected prefetch");
  });
});

test("prefetch-soundings 400s BEFORE spawning when a run has nothing built (actionable message)", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/prefetch-soundings", {
      models: ["hrrr"],
      runs: { hrrr: "latest" },
      view: "conus",
    });
    assert.equal(res.status, 400, "nothing built -> 400, not a spawn-then-exit-1");
    assert.match(JSON.parse(res.body).error, /render it first/i, "message tells the user what to do");
    assert.equal(spawn.calls.length, 0, "no spawn for an unbuildable prefetch");
  });
});

test("prefetch-soundings resolves 'latest' to the concrete built run and spawns one job per model", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    await seedBuiltRun(runtime, "20260703-1200Z", [0, 1, 2], "hrrr");
    await seedLatestPointer(runtime, "20260703-1200Z", "hrrr");
    await seedBuiltRun(runtime, "20260703-1800Z", [0, 3], "nam3km");

    const res = await request(port, "POST", "/actions/prefetch-soundings", {
      models: ["hrrr", "nam3km"],
      runs: { hrrr: "latest", nam3km: "20260703-1800Z" },
      view: "conus",
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.jobs.length, 2, "one job per model");
    // Prefetch processes each open their own NOAA range-fetch lanes, so
    // models warm one after another.
    assert.equal(spawn.calls.length, 1, "only the first model's prefetch spawns immediately");
    spawn.children[0]._emitExit(0);
    assert.equal(spawn.calls.length, 2, "second model spawns after the first exits");

    const hrrrJob = body.jobs.find((job) => job.models[0] === "hrrr");
    assert.equal(hrrrJob.run, "20260703-1200Z", "latest resolved to the built pointer run");
    assert.equal(hrrrJob.frameCount, 3, "job reports the loaded-frame target");
    const hrrrArgv = spawn.calls.find((call) => call.argv.includes("--models=hrrr")).argv;
    assert.ok(hrrrArgv.includes("--runs=20260703-1200Z"), "spawn targets the RESOLVED run, never 'latest'");

    const namJob = body.jobs.find((job) => job.models[0] === "nam3km");
    assert.equal(namJob.run, "20260703-1800Z");
    assert.equal(namJob.frameCount, 2);

    // The status surface reports the concrete run for each job.
    const status = await request(port, "GET", `/actions/status/${hrrrJob.jobId}`);
    assert.equal(JSON.parse(status.body).run, "20260703-1200Z");
  });
});

test("prefetch warms the buildable models and reports unbuilt ones as skipped (never all-or-nothing)", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    await seedBuiltRun(runtime, "20260703-1200Z", [0, 1], "hrrr");
    // nam3km has nothing built at all.
    const res = await request(port, "POST", "/actions/prefetch-soundings", {
      models: ["hrrr", "nam3km"],
      runs: { hrrr: "20260703-1200Z", nam3km: "latest" },
      view: "conus",
    });
    assert.equal(res.status, 200, "one warmable model is enough to proceed");
    const body = JSON.parse(res.body);
    assert.equal(body.jobs.length, 1, "the warmable model spawned");
    assert.equal(body.jobs[0].models[0], "hrrr");
    assert.equal(body.skipped.length, 1, "the unbuilt model is reported, not silently dropped");
    assert.equal(body.skipped[0].model, "nam3km");
    assert.match(body.skipped[0].reason, /render it first/i);
    assert.equal(spawn.calls.length, 1, "no spawn for the skipped model");
  });
});

test("prefetch failure surfaces the per-frame error line, never the planned/done summary lines", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    await seedBuiltRun(runtime, "20260703-0600Z", [0, 3]);
    const res = await request(port, "POST", "/actions/prefetch-soundings", {
      models: ["hrrr"],
      runs: { hrrr: "20260703-0600Z" },
      view: "conus",
    });
    const { jobId } = JSON.parse(res.body);
    const child = spawn.children[0];
    // Real output order: plan, per-frame failure, then the ALWAYS-printed
    // summary — whose "failed=N" must not shadow the actual reason.
    child._emitStdoutLine("[noaa-sounding-prefetch] planned tasks=2");
    child._emitStdoutLine("[noaa-sounding-prefetch] hrrr/20260703-0600Z F000 failed: NOAA range fetch 404");
    child._emitStdoutLine("[noaa-sounding-prefetch] done tasks=2 warmed=0 cached=0 failed=2 bytes=0");
    child._emitExit(1);
    const status = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(status.status, "failed");
    assert.match(status.error, /Sounding prefetch failed/, "kind-aware error prefix");
    assert.match(status.error, /range fetch 404/, "the child's actual failure line is surfaced");
    assert.ok(!/done tasks=/.test(status.error), "the benign summary line never masquerades as the error");
  });
});

// Seed a previously-built run on disk: a union-merged manifest holding `hours`
// frames (all hourStatus "loaded", like a real built run) with a
// .complete.json marker for every one of them.
async function seedBuiltRun(runtime, run, hours, model = "hrrr") {
  const manifestPath = runtime.getManifestStoragePath(model, run, runtime.defaultViewKey);
  await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.promises.writeFile(
    manifestPath,
    JSON.stringify({
      model,
      run,
      view: runtime.defaultViewKey,
      frames: hours.map((hour) => ({ hour })),
      hourStatus: Object.fromEntries(hours.map((hour) => [String(hour), "loaded"])),
    }),
  );
  for (const hour of hours) {
    const markerPath = runtime.getFrameMarkerPath(model, run, runtime.defaultViewKey, hour);
    await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.promises.writeFile(markerPath, JSON.stringify({ hour }));
  }
}

async function seedLatestPointer(runtime, run, model = "hrrr") {
  const pointerPath = runtime.getLatestPointerStoragePath(model, runtime.defaultViewKey);
  await fs.promises.mkdir(path.dirname(pointerPath), { recursive: true });
  await fs.promises.writeFile(pointerPath, JSON.stringify({ model, run, view: runtime.defaultViewKey }));
}

// Backdate every seeded marker so tests can distinguish markers that predate a
// job (a prior build's output) from markers the job wrote itself.
async function backdateMarkers(runtime, run, hours, model = "hrrr") {
  const past = new Date(Date.now() - 60_000);
  for (const hour of hours) {
    const markerPath = runtime.getFrameMarkerPath(model, run, runtime.defaultViewKey, hour);
    await fs.promises.utimes(markerPath, past, past);
  }
}

test("status reports progress against THIS build's target, ignoring prior builds' markers", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    // The on-disk manifest is union-merged across builds of the same run, so a
    // re-render (e.g. the remaining categories of a partial run) starts with 5
    // frames whose markers ALL pre-exist. Status must count only markers this
    // build writes — pre-existing ones would read 100% before any frame runs.
    const run = "20260703-0600Z";
    await seedBuiltRun(runtime, run, [0, 1, 2, 3, 4]);
    await backdateMarkers(runtime, run, [0, 1, 2, 3, 4]);

    const started = await request(port, "POST", "/actions/render", {
      models: ["hrrr"],
      view: "conus",
      run,
      categories: { surface: true },
    });
    const { jobId } = JSON.parse(started.body);
    const child = spawn.children[0];

    const before = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(before.markerCount, 0, "pre-existing markers from prior builds never count as progress");

    // This build re-renders hour 0: its marker is rewritten NOW (fresh mtime).
    const markerPath = runtime.getFrameMarkerPath("hrrr", run, runtime.defaultViewKey, 0);
    await fs.promises.writeFile(markerPath, JSON.stringify({ hour: 0 }));
    child._emitStdoutLine("[noaa-beta] hrrr/20260703-0600Z F000 complete finish=12:00:00");

    const mid = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(mid.markerCount, 1, "only the marker THIS build rewrote counts");

    // A frame reused from disk logs `reused` without touching its marker; the
    // scraped counters carry it. The final summary is authoritative for totals.
    child._emitStdoutLine("[noaa-beta] hrrr/20260703-0600Z F003 reused at=12:00:01");
    child._emitStdoutLine(
      JSON.stringify({ results: [{ model: "hrrr", run, frameCount: 2, built: 1, reused: 1, failed: 0 }] }, null, 2),
    );
    const done = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(done.total, 2, "job total scraped from the builder summary frameCount");
    assert.equal(done.markerTotal, 2, "denominator is THIS build's resolved count, not the 5-frame union");
    assert.equal(done.built + done.reused, 2, "scraped counters reach the target for the UI numerator");
    assert.ok(done.markerCount <= done.markerTotal, "progress never exceeds 100%");
  });
});

test("unbounded latest progress uses the builder's exact hour plan before the first frame", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ actions, port }) => {
    const started = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      models: ["hrrr"],
      run: "latest",
    });
    const { jobId } = JSON.parse(started.body);
    const child = spawn.children[0];

    child._emitStdoutLine(
      "[noaa-beta] building models=hrrr view=conus hours=hrrr:0,1,2,3,4 cache=/tmp/noaa-beta-cache",
    );
    child._emitStdoutLine("[noaa-beta] hrrr/conus run=20260703-1200Z start");
    child._emitStdoutLine("[noaa-beta] hrrr/20260703-1200Z F000 complete finish=12:00:00");

    const status = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(status.total, 5, "exact planned denominator is known before the final JSON summary");
    assert.equal(status.markerTotal, 5, "one completed frame reports 1/5, never the old false 1/1");
    assert.equal(status.built, 1);
    assert.deepEqual(actions.jobs.getJob(jobId).targetHours, [0, 1, 2, 3, 4]);
    assert.deepEqual(actions.jobs.getJob(jobId).resolvedRunsByModel, { hrrr: "20260703-1200Z" });
  });
});

test("builder hour plan replaces a requested cap with the realized published prefix", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ actions, port }) => {
    const started = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      run: "20260703-1200Z",
      maxHour: 24,
    });
    const { jobId } = JSON.parse(started.body);
    const before = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(before.markerTotal, 25, "requested F000-F024 roster is only a pre-plan estimate");

    spawn.children[0]._emitStdoutLine(
      "[noaa-beta] building models=hrrr view=conus hours=hrrr:0,1,2,3,4,5,6 cache=/tmp/noaa-beta-cache",
    );
    const after = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(after.total, 7);
    assert.equal(after.markerTotal, 7, "uploading run denominator is the realized F000-F006 prefix");
    assert.deepEqual(actions.jobs.getJob(jobId).targetHours, [0, 1, 2, 3, 4, 5, 6]);
  });
});

test("multi-model final builder summary aggregates every model's exact counts", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const started = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      models: ["hrrr", "nam3km"],
      run: "latest",
    });
    const { jobId } = JSON.parse(started.body);
    const child = spawn.children[0];
    child._emitStdoutLine(
      "[noaa-beta] building models=hrrr,nam3km view=conus hours=hrrr:0,1 nam3km:0,3,6 cache=/tmp/noaa-beta-cache",
    );
    let status = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(status.markerTotal, 5, "pre-frame plan sums both model rosters");

    const summary = {
      results: [
        { model: "hrrr", run: "20260703-1200Z", frameCount: 2, built: 1, reused: 1, failed: 0 },
        { model: "nam3km", run: "20260703-1200Z", frameCount: 3, built: 2, reused: 0, failed: 1 },
      ],
    };
    for (const line of JSON.stringify(summary, null, 2).split("\n")) {
      child._emitStdoutLine(line);
    }
    status = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(status.built, 3);
    assert.equal(status.reused, 1);
    assert.equal(status.failed, 1);
    assert.equal(status.total, 5, "denominator aggregates both result frameCounts");
    assert.equal(status.markerTotal, 5);
    assert.equal(status.run, "latest", "different per-model latest cycles are never collapsed to one scalar run");
  });
});

test("prefetch status tracks warmed/cached lines against the requested hours, not pre-existing render markers", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    // A prefetch targets frames that are ALREADY rendered, so every render
    // marker pre-exists — marker scanning would read 100% from the first
    // poll. Progress must come from the prefetch's own warmed/cached lines.
    const run = "20260703-0600Z";
    await seedBuiltRun(runtime, run, [0, 1, 2, 3, 4]);

    const started = await request(port, "POST", "/actions/prefetch-soundings", { ...PREFETCH_BODY, run });
    const { jobId } = JSON.parse(started.body);
    const before = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(before.markerTotal, 2, "denominator is the 2 requested hours, not the 5-frame union");
    assert.equal(before.markerCount, 0, "no progress before the prefetch reports any frame");

    const child = spawn.children[0];
    child._emitStdoutLine("[noaa-sounding-prefetch] hrrr/20260703-0600Z F000 warmed");
    const mid = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(mid.markerCount, 1, "a warmed frame advances progress");

    child._emitStdoutLine("[noaa-sounding-prefetch] hrrr/20260703-0600Z F003 cached");
    child._emitStdoutLine("[noaa-sounding-prefetch] done tasks=2 warmed=1 cached=1 failed=0 bytes=123");
    const done = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(done.markerCount, 2, "warmed + cached reach the target");
    assert.equal(done.markerTotal, 2, "summary total confirms the denominator");
    assert.equal(done.built, 1, "warmed count scraped from the summary");
    assert.equal(done.reused, 1, "cached count scraped from the summary");
  });
});

test("status returns 404 for an unknown jobId", async () => {
  await withServer({ spawnBuildProcess: makeSpawnStub().spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "GET", "/actions/status/job-does-not-exist");
    assert.equal(res.status, 404);
  });
});

test("jobs lists active and recent jobs", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    await request(port, "POST", "/actions/render", {
      models: ["hrrr"],
      view: "conus",
      run: "latest",
      categories: { surface: true },
    });
    const res = await request(port, "GET", "/actions/jobs");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.jobs), "jobs is an array");
    assert.equal(body.jobs.length, 1, "the started job is listed");
    assert.equal(body.jobs[0].model, "hrrr");
  });
});

test("status and jobs are GET-only; prefetch is POST-only", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const postStatus = await request(port, "POST", "/actions/status/anything", {});
    assert.equal(postStatus.status, 405, "status rejects POST");
    const postJobs = await request(port, "POST", "/actions/jobs", {});
    assert.equal(postJobs.status, 405, "jobs rejects POST");
    const getPrefetch = await request(port, "GET", "/actions/prefetch-soundings");
    assert.equal(getPrefetch.status, 405, "prefetch rejects GET");
    assert.equal(spawn.calls.length, 0, "no spawns from wrong-method requests");
  });
});

test("read-only GET routes never spawn a child process", async () => {
  const spawn = makeSpawnStub();
  await withServer(
    { spawnBuildProcess: spawn.spawnBuildProcess, probeUpstreamRuns: async () => [] },
    async ({ port }) => {
      await request(port, "GET", "/actions/available-runs?models=hrrr&view=conus");
      await request(port, "GET", "/actions/jobs");
      await request(port, "GET", "/actions/status/whatever");
      assert.equal(spawn.calls.length, 0, "no GET route spawned a process");
    },
  );
});

test("cancel terminates a running job as canceled, not failed", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(res.status, 200);
    const { jobId } = JSON.parse(res.body);

    const cancel = await request(port, "POST", `/actions/cancel/${jobId}`, {});
    assert.equal(cancel.status, 200);
    assert.equal(JSON.parse(cancel.body).status, "canceled", "stub kill exits synchronously -> canceled");
    assert.equal(spawn.children[0].killed, true, "the running child was killed");

    const status = await request(port, "GET", `/actions/status/${jobId}`);
    assert.equal(JSON.parse(status.body).status, "canceled", "canceled, never failed");
  });
});

test("canceling a queued chained job still launches its successors", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    // Three distinct run picks -> three chained jobs (only the first spawns).
    const res = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      models: ["gfs", "nam", "hrrr"],
      runs: { gfs: "latest", nam: "20260703-0600Z", hrrr: "20260703-1200Z" },
    });
    assert.equal(res.status, 200);
    const { jobs } = JSON.parse(res.body);
    assert.equal(jobs.length, 3, "three run groups");
    assert.equal(spawn.children.length, 1, "only the head of the chain spawns");

    const cancel = await request(port, "POST", `/actions/cancel/${jobs[1].jobId}`, {});
    assert.equal(cancel.status, 200);
    assert.equal(JSON.parse(cancel.body).status, "canceled", "queued job cancels immediately");
    assert.equal(spawn.children.length, 1, "canceling a queued job spawns nothing");

    // Head exits -> canceled middle is skipped -> tail spawns.
    spawn.children[0]._emitExit(0);
    assert.equal(spawn.children.length, 2, "successor behind the canceled job launched");
    const tail = await request(port, "GET", `/actions/status/${jobs[2].jobId}`);
    assert.equal(JSON.parse(tail.body).status, "running", "tail job is running");
    const middle = await request(port, "GET", `/actions/status/${jobs[1].jobId}`);
    assert.equal(JSON.parse(middle.body).status, "canceled", "middle job stays canceled");
  });
});

test("cancel is idempotent on terminal jobs, 404s on unknown ids, and guards origin", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    const { jobId } = JSON.parse(res.body);
    spawn.children[0]._emitExit(0);

    const cancelDone = await request(port, "POST", `/actions/cancel/${jobId}`, {});
    assert.equal(cancelDone.status, 200, "terminal cancel is a no-op, not an error");
    assert.equal(JSON.parse(cancelDone.body).status, "done", "done job stays done");

    const unknown = await request(port, "POST", "/actions/cancel/job-nope", {});
    assert.equal(unknown.status, 404);

    const crossOrigin = await request(port, "POST", `/actions/cancel/${jobId}`, {}, { Origin: "https://evil.example" });
    assert.equal(crossOrigin.status, 403, "cancel rejects cross-origin POSTs");
  });
});

test("render maxHour flows to the builder argv and sets the marker denominator", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      runs: { hrrr: "20260703-0600Z" },
      maxHour: 6,
    });
    assert.equal(res.status, 200);
    assert.ok(spawn.calls[0].argv.includes("--max-hour=6"), "argv carries the prefix cap");
    assert.ok(
      !spawn.calls[0].argv.includes("--require-full-horizon"),
      "a short prefix remains eligible for the newest partially published run",
    );

    const { jobId } = JSON.parse(res.body);
    const status = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(status.markerTotal, 7, "hrrr f000-f006 = 7 target frames");
  });
});

test("NAM caps beyond F036 opt into the official mixed-cadence horizon", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      models: ["nam"],
      maxHour: 48,
    });
    assert.equal(res.status, 200);
    assert.ok(spawn.calls[0].argv.includes("--require-full-horizon"));
    assert.ok(spawn.calls[0].argv.includes("--max-hour=48"));
    const { jobId } = JSON.parse(res.body);
    const status = JSON.parse((await request(port, "GET", `/actions/status/${jobId}`)).body);
    assert.equal(status.markerTotal, 41, "NAM F000-F048 is 37 hourly frames plus four 3-hour frames");
  });
});

test("render forwards optional GFS cadence and validated science prototype tiers", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      models: ["gfs", "hrrr"],
      categories: {
        ...VALID_RENDER_BODY.categories,
        severe: { enabled: true, tier: "full" },
      },
      gfsTemporalTier: "hourly-through-120",
      sciencePrototypes: ["camDcape21Level", "rowAwareCenterValidation"],
    });
    assert.equal(res.status, 200);
    assert.ok(spawn.calls[0].argv.includes("--gfs-hourly-through-120"));
    assert.ok(spawn.calls[0].argv.includes("--science-prototypes=camDcape21Level,rowAwareCenterValidation"));
  });
});

test("render rejects science prototypes whose model or Severe Full prerequisites are absent", async () => {
  const spawn = makeSpawnStub();
  const withSevere = (enabled, tier, overrides = {}) => ({
    ...VALID_RENDER_BODY,
    ...overrides,
    categories: {
      ...VALID_RENDER_BODY.categories,
      severe: { enabled, tier },
    },
  });
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const cases = [
      withSevere(true, "full", { models: ["gfs"], sciencePrototypes: ["camDcape21Level"] }),
      withSevere(true, "simple", { models: ["hrrr"], sciencePrototypes: ["camDcape21Level"] }),
      withSevere(false, "full", { models: ["nam3km"], sciencePrototypes: ["camDcape21Level"] }),
      withSevere(true, "simple", { models: ["gfs"], sciencePrototypes: ["effectiveStp100mbReduced"] }),
      withSevere(false, "full", { models: ["hrrr"], sciencePrototypes: ["effectiveStp100mbReduced"] }),
    ];
    for (const body of cases) {
      const res = await request(port, "POST", "/actions/render", body);
      assert.equal(res.status, 400, res.body);
    }
    assert.equal(spawn.calls.length, 0);
  });
});

test("row-aware center validation remains valid without upper-air or Severe Full categories", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      categories: {
        surface: true,
        precip: false,
        radar: false,
        cloud: false,
        upperAir: false,
        severe: { enabled: false, tier: "simple" },
        winter: { enabled: false, tier: "simple" },
      },
      sciencePrototypes: ["rowAwareCenterValidation"],
    });
    assert.equal(res.status, 200, res.body);
    assert.ok(spawn.calls[0].argv.includes("--science-prototypes=rowAwareCenterValidation"));
  });
});

test("render rejects unknown GFS cadence and science prototype values before spawning", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    for (const body of [
      { ...VALID_RENDER_BODY, gfsTemporalTier: "hourly-forever" },
      { ...VALID_RENDER_BODY, models: ["hrrr"], gfsTemporalTier: "hourly-through-120" },
      { ...VALID_RENDER_BODY, sciencePrototypes: ["inventedMethod"] },
      { ...VALID_RENDER_BODY, sciencePrototypes: "camDcape21Level" },
    ]) {
      const res = await request(port, "POST", "/actions/render", body);
      assert.equal(res.status, 400);
    }
    assert.equal(spawn.calls.length, 0);
  });
});

test("render tuning fields flow to builder flags; full selections still emit no category flags", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const fullBody = {
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
      maxHour: 12,
      tuning: { workerCount: 8, totalFrameConcurrency: 12, rangeConcurrency: 2, decodeConcurrency: 1 },
    };
    const res = await request(port, "POST", "/actions/render", fullBody);
    assert.equal(res.status, 200);
    const argv = spawn.calls[0].argv;
    assert.ok(argv.includes("--worker-count=8"), "workerCount mapped");
    assert.ok(argv.includes("--total-frame-concurrency=12"), "totalFrameConcurrency mapped");
    assert.ok(argv.includes("--range-concurrency=2"), "rangeConcurrency mapped");
    assert.ok(argv.includes("--decode-concurrency=1"), "decodeConcurrency mapped");
    assert.ok(argv.includes("--max-hour=12"));
    assert.ok(
      !argv.some((flag) => flag.startsWith("--categories=")),
      "byte-identical parity: tuning/maxHour never force selection flags onto a full render",
    );
  });
});

test("render rejects out-of-range maxHour and tuning values with 400", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    for (const body of [
      { ...VALID_RENDER_BODY, maxHour: -1 },
      { ...VALID_RENDER_BODY, maxHour: 3.5 },
      { ...VALID_RENDER_BODY, maxHour: "abc" },
      { ...VALID_RENDER_BODY, maxHour: 999 },
      { ...VALID_RENDER_BODY, tuning: { workerCount: 99 } },
      { ...VALID_RENDER_BODY, tuning: { decodeConcurrency: 0 } },
      { ...VALID_RENDER_BODY, tuning: { bogusKnob: 4 } },
      { ...VALID_RENDER_BODY, tuning: "fast" },
    ]) {
      const res = await request(port, "POST", "/actions/render", body);
      assert.equal(res.status, 400, `rejected: ${JSON.stringify(body.maxHour ?? body.tuning)}`);
    }
    assert.equal(spawn.calls.length, 0, "nothing spawned for rejected bodies");
  });
});

test("multi-run selection spawns one chained job per run, newest first", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      models: ["hrrr", "nam"],
      runs: { hrrr: ["20260703-0600Z", "20260703-1200Z"], nam: "20260703-0600Z" },
    });
    assert.equal(res.status, 200);
    const { jobs } = JSON.parse(res.body);
    assert.equal(jobs.length, 2, "two distinct runs -> two jobs");
    assert.equal(jobs[0].run, "20260703-1200Z", "newest run launches first");
    assert.deepEqual(jobs[0].models, ["hrrr"]);
    assert.equal(jobs[1].run, "20260703-0600Z");
    assert.deepEqual(jobs[1].models, ["hrrr", "nam"], "models sharing a run stay in one job");

    assert.equal(spawn.calls.length, 1, "only the newest-run job spawns immediately");
    assert.ok(spawn.calls[0].argv.includes("--date=20260703"));
    assert.ok(spawn.calls[0].argv.includes("--cycle=12"));

    spawn.children[0]._emitExit(0);
    assert.equal(spawn.calls.length, 2, "older run spawns after the newest finishes");
    assert.ok(spawn.calls[1].argv.includes("--cycle=06"));
    assert.ok(spawn.calls[1].argv.includes("--models=hrrr,nam"));
  });
});

test("multi-run selection puts 'latest' ahead of picked runs and dedupes repeats", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      runs: { hrrr: ["20260703-0600Z", "latest", "20260703-0600Z"] },
    });
    assert.equal(res.status, 200);
    const { jobs } = JSON.parse(res.body);
    assert.equal(jobs.length, 2, "duplicate run ids collapse");
    assert.equal(jobs[0].run, "latest", "latest is newest by definition and goes first");
    assert.equal(jobs[1].run, "20260703-0600Z");
  });
});

test("multi-run conflicts reject the whole request before any spawn", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const first = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      runs: { hrrr: "20260703-1200Z" },
    });
    assert.equal(first.status, 200);
    assert.equal(spawn.calls.length, 1);

    const second = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      runs: { hrrr: ["20260703-0600Z", "20260703-1200Z"] },
    });
    assert.equal(second.status, 409, "any overlapping (model, run) rejects the batch");
    assert.equal(spawn.calls.length, 1, "no partial spawn from the rejected batch");
  });
});

test("multi-run selection rejects malformed run ids inside arrays", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", {
      ...VALID_RENDER_BODY,
      runs: { hrrr: ["20260703-1200Z", "../etc"] },
    });
    assert.equal(res.status, 400);
    assert.equal(spawn.calls.length, 0);
  });
});

test("render 409s a concrete run while a same-model 'latest' build is unresolved (and vice versa)", async () => {
  // latest-then-concrete: the latest job has not logged its resolved cycle
  // yet, so a concrete resubmit INSIDE the candidate window can target the
  // very same run tree; an archived run is provably disjoint and proceeds.
  const spawnLatestFirst = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawnLatestFirst.spawnBuildProcess }, async ({ port }) => {
    const latest = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(latest.status, 200, "latest render accepted");
    const concrete = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    concrete.run = recentCandidateRunId();
    const dup = await request(port, "POST", "/actions/render", concrete);
    assert.equal(dup.status, 409, "an unresolved 'latest' job can land on this run — concrete resubmit must 409");
    assert.equal(spawnLatestFirst.calls.length, 1, "no second builder on the same run tree");

    const archived = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    archived.run = "20260703-1200Z";
    const allowed = await request(port, "POST", "/actions/render", archived);
    assert.equal(allowed.status, 200, "an archived run is outside the latest window — provably disjoint");
    assert.equal(spawnLatestFirst.calls.length, 2, "the archived-run build spawned");
  });

  // concrete-then-latest: 'latest' can resolve to any run inside the
  // recent-cycle candidate window, this one included.
  const spawnConcreteFirst = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawnConcreteFirst.spawnBuildProcess }, async ({ port }) => {
    const concrete = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    concrete.run = recentCandidateRunId();
    const first = await request(port, "POST", "/actions/render", concrete);
    assert.equal(first.status, 200, "concrete render accepted");
    const dup = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(dup.status, 409, "'latest' can land on the running concrete run — must 409");
    assert.equal(spawnConcreteFirst.calls.length, 1, "no second builder on the same run tree");
  });
});

test("a resolved 'latest' build only 409s its own run — other picked runs proceed", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const latest = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(latest.status, 200);
    // The builder logs its resolved cycle early ("run=... start"); from then
    // on only that concrete run conflicts.
    spawn.children[0]._emitStdoutLine("[noaa-beta] hrrr/conus run=20260703-1200Z start");

    const same = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    same.run = "20260703-1200Z";
    const dup = await request(port, "POST", "/actions/render", same);
    assert.equal(dup.status, 409, "the resolved run still conflicts");
    assert.equal(spawn.calls.length, 1, "the duplicate did not spawn");

    const other = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    other.run = "20260703-0600Z";
    const allowed = await request(port, "POST", "/actions/render", other);
    assert.equal(allowed.status, 200, "a provably different run may proceed");
    assert.equal(spawn.calls.length, 2, "the disjoint picked run spawned");
  });
});

test("a prefetch pinned to an archived run never 409-blocks a latest render", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    // 20260703 is far outside the recent-cycle candidate window, so no
    // latest resolution — even a --require-full-horizon fallback to an older
    // fully-published cycle — can land on it.
    await seedBuiltRun(runtime, "20260703-0600Z", [0, 3]);
    await seedLatestPointer(runtime, "20260703-0600Z");

    const prefetch = await request(port, "POST", "/actions/prefetch-soundings", {
      models: ["hrrr"],
      runs: { hrrr: "20260703-0600Z" },
      view: "conus",
    });
    assert.equal(prefetch.status, 200, "archived-run prefetch accepted");
    assert.equal(spawn.calls.length, 1);

    const render = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(render.status, 200, "an archived-run prefetch never blocks a latest render");
    assert.equal(spawn.calls.length, 2, "the latest render spawned");
  });
});

test("a prefetch pinned to a run inside the latest candidate window still blocks a latest render", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    // A recent run CAN be what 'latest' resolves to — not only the newest
    // cycle: --require-full-horizon renders skip partially published cycles
    // and settle on an older fully published one. Everything in the window
    // must therefore conflict.
    const recentRun = recentCandidateRunId();
    await seedBuiltRun(runtime, recentRun, [0, 3]);
    await seedLatestPointer(runtime, recentRun);

    const prefetch = await request(port, "POST", "/actions/prefetch-soundings", {
      models: ["hrrr"],
      runs: { hrrr: recentRun },
      view: "conus",
    });
    assert.equal(prefetch.status, 200, "recent-run prefetch accepted");
    assert.equal(spawn.calls.length, 1);

    const render = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(render.status, 409, "a latest render can land on the prefetch's run tree — must 409");
    assert.match(
      JSON.parse(render.body).error,
      /A job for hrrr\/latest\/conus is already running/,
      "the 409 names a job, not a render — the blocker here is a prefetch",
    );
    assert.equal(spawn.calls.length, 1, "no second child spawned");
  });
});

test("prefetch 409s an in-window run while an unresolved 'latest' render could be building it", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    const recentRun = recentCandidateRunId();
    await seedBuiltRun(runtime, recentRun, [0, 3]);
    await seedLatestPointer(runtime, recentRun);
    const render = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(render.status, 200);

    // 'latest' resolves to the built pointer run — a cycle inside the
    // candidate window that the unresolved latest render may be building
    // right now. The exact-match check used to pass this and put two
    // children on one run tree.
    const conflicted = await request(port, "POST", "/actions/prefetch-soundings", {
      models: ["hrrr"],
      runs: { hrrr: "latest" },
      view: "conus",
    });
    assert.equal(conflicted.status, 409, "a possibly-shared run tree is a conflict");
    assert.equal(spawn.calls.length, 1, "no second child spawned");

    // An ARCHIVED run stays warmable during the unresolved phase: the
    // latest render can only land inside the window, so the trees are
    // provably disjoint (the symmetric direction of the archived-run rule).
    await seedBuiltRun(runtime, "20260703-0600Z", [0, 3]);
    const archived = await request(port, "POST", "/actions/prefetch-soundings", {
      models: ["hrrr"],
      runs: { hrrr: "20260703-0600Z" },
      view: "conus",
    });
    assert.equal(archived.status, 200, "archived-run prefetch is disjoint from an unresolved latest render");
    assert.equal(spawn.calls.length, 2);

    // Once the builder logs a DIFFERENT resolved cycle, even the in-window
    // pointer run is provably disjoint and the prefetch proceeds.
    spawn.children[0]._emitStdoutLine("[noaa-beta] hrrr/conus run=20260703-1800Z start");
    const allowed = await request(port, "POST", "/actions/prefetch-soundings", {
      models: ["hrrr"],
      runs: { hrrr: "latest" },
      view: "conus",
    });
    assert.equal(allowed.status, 200, "a resolved-different latest render no longer conflicts");
    assert.equal(spawn.calls.length, 3);
  });
});

test("render spawns builders with roster env vars stripped from the child environment", async (t) => {
  // The control panel's argv is the complete specification of what a job
  // builds: a roster variable exported in the operator's shell (for CLI
  // experiments) must never silently truncate a server-spawned build.
  const original = process.env.MODELVIEW_NOAA_HRRR_HOURS;
  process.env.MODELVIEW_NOAA_HRRR_HOURS = "0,3,6";
  t.after(() => {
    if (original === undefined) {
      delete process.env.MODELVIEW_NOAA_HRRR_HOURS;
    } else {
      process.env.MODELVIEW_NOAA_HRRR_HOURS = original;
    }
  });
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    const res = await request(port, "POST", "/actions/render", VALID_RENDER_BODY);
    assert.equal(res.status, 200);
    const env = spawn.calls[0].spawnOptions.env;
    assert.equal(env.MODELVIEW_NOAA_HRRR_HOURS, undefined, "per-model roster env never reaches the child");
    assert.equal(env.PATH, process.env.PATH, "the rest of the environment passes through");
  });
});

test("render rejects run ids with non-00 minute fields", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    // Real run ids are always YYYYMMDD-HH00Z: "20260703-1299Z" used to
    // validate and silently build --cycle=12 while naming a run that does
    // not exist.
    for (const run of ["20260703-1299Z", "20260703-1230Z"]) {
      const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
      bad.run = run;
      const res = await request(port, "POST", "/actions/render", bad);
      assert.equal(res.status, 400, `run ${run} rejected`);
    }
    const badMap = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
    badMap.runs = { hrrr: "20260703-1260Z" };
    const res = await request(port, "POST", "/actions/render", badMap);
    assert.equal(res.status, 400, "the per-model runs map applies the same strict shape");
    assert.equal(spawn.calls.length, 0, "no build spawned for minute-field run ids");
  });
});

test("render rejects non-boolean severe/winter enabled flags instead of reading them as disabled", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    for (const override of [
      { severe: { enabled: 1, tier: "full" } },
      { winter: { enabled: "yes", tier: "simple" } },
      { severe: { tier: "full" } }, // enabled missing entirely
    ]) {
      const bad = JSON.parse(JSON.stringify(VALID_RENDER_BODY));
      Object.assign(bad.categories, override);
      const res = await request(port, "POST", "/actions/render", bad);
      assert.equal(res.status, 400, `rejected: ${JSON.stringify(override)}`);
      assert.match(JSON.parse(res.body).error, /enabled must be a boolean/);
    }
    assert.equal(spawn.calls.length, 0, "no build spawned for non-boolean enabled flags");
  });
});

test("render rejects boolean/array coercions in numeric fields with 400", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ port }) => {
    // Number(false) === 0 used to turn maxHour:false into --max-hour=0; true
    // and [6] coerced to 1 and 6 the same way.
    for (const body of [
      { ...VALID_RENDER_BODY, maxHour: false },
      { ...VALID_RENDER_BODY, maxHour: true },
      { ...VALID_RENDER_BODY, maxHour: [6] },
      { ...VALID_RENDER_BODY, tuning: { workerCount: true } },
      { ...VALID_RENDER_BODY, tuning: { rangeConcurrency: [2] } },
    ]) {
      const res = await request(port, "POST", "/actions/render", body);
      assert.equal(res.status, 400, `rejected: ${JSON.stringify(body.maxHour ?? body.tuning)}`);
    }
    assert.equal(spawn.calls.length, 0, "nothing spawned for coerced values");

    // Plain numbers and digit strings remain valid.
    const ok = await request(port, "POST", "/actions/render", { ...VALID_RENDER_BODY, maxHour: "24" });
    assert.equal(ok.status, 200, "a digit-string maxHour is still accepted");
    assert.ok(spawn.calls[0].argv.includes("--max-hour=24"), "the string coerces to the same flag value");
  });
});

test("prefetch-soundings rejects malformed hours instead of silently rewriting or widening the request", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    await seedBuiltRun(runtime, "20260703-0600Z", [0, 3, 6]);
    // 3.7 used to round to 3; "abc"/-5 were dropped; an all-invalid list
    // OMITTED --hours and warmed every loaded frame.
    for (const hours of [[0, 3.7], ["abc"], [-5], [true], "0,3", []]) {
      const res = await request(port, "POST", "/actions/prefetch-soundings", { ...PREFETCH_BODY, hours });
      assert.equal(res.status, 400, `rejected: ${JSON.stringify(hours)}`);
    }
    assert.equal(spawn.calls.length, 0, "no prefetch spawned for malformed hours");

    // Integer hours still marshal verbatim.
    const ok = await request(port, "POST", "/actions/prefetch-soundings", PREFETCH_BODY);
    assert.equal(ok.status, 200);
    assert.ok(spawn.calls[0].argv.includes("--hours=0,3"), "integer hours reach the argv untouched");
    spawn.children[0]._emitExit(0);

    // Omitting hours remains the (only) way to warm every loaded frame.
    const { hours, ...noHoursBody } = PREFETCH_BODY;
    void hours;
    const all = await request(port, "POST", "/actions/prefetch-soundings", noHoursBody);
    assert.equal(all.status, 200);
    assert.ok(
      !spawn.calls[1].argv.some((flag) => flag.startsWith("--hours=")),
      "an omitted hours field warms all loaded hours — never an emptied list",
    );
  });
});

test("two concurrent identical prefetch POSTs spawn one child — the loser 409s", async () => {
  const spawn = makeSpawnStub();
  await withServer({ spawnBuildProcess: spawn.spawnBuildProcess }, async ({ runtime, port }) => {
    await seedBuiltRun(runtime, "20260703-1200Z", [0, 1, 2], "hrrr");
    await seedBuiltRun(runtime, "20260703-1800Z", [0, 3], "nam3km");
    const body = {
      models: ["hrrr", "nam3km"],
      runs: { hrrr: "20260703-1200Z", nam3km: "20260703-1800Z" },
      view: "conus",
    };
    // Both requests resolve their targets (awaiting manifests) before either
    // reaches the launch loop; the second must re-check and lose there.
    const [first, second] = await Promise.all([
      request(port, "POST", "/actions/prefetch-soundings", body),
      request(port, "POST", "/actions/prefetch-soundings", body),
    ]);
    assert.deepEqual(
      [first.status, second.status].sort(),
      [200, 409],
      "one request wins, the duplicate 409s — never two children on one run tree",
    );
    assert.equal(spawn.calls.length, 1, "exactly one prefetch child spawned");
    const loser = first.status === 409 ? first : second;
    assert.match(JSON.parse(loser.body).error, /already running/i, "the loser is told a job is running");
  });
});

test("cache/prune rejects boolean/array coercions in keep and budgetGb", async () => {
  await withServer({}, async ({ port }) => {
    // Number(true) === 1 used to turn keep:true into keep=1 run and
    // budgetGb:true into a 1 GiB budget.
    for (const body of [{ keep: true }, { keep: [4] }, { budgetGb: true }, { budgetGb: [1] }]) {
      const res = await request(port, "POST", "/actions/cache/prune", body);
      assert.equal(res.status, 400, `rejected: ${JSON.stringify(body)}`);
    }
    const ok = await request(port, "POST", "/actions/cache/prune", { keep: "2" });
    assert.equal(ok.status, 200, "a digit-string keep remains valid (dry run by default)");
    assert.equal(JSON.parse(ok.body).dryRun, true);
  });
});
