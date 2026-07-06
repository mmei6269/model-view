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
    assert.ok(argv.includes("--full"), "UI renders build every published frame, not DEFAULT_HOURS");
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
      ["--models=hrrr", "--view=conus", "--full"],
      "full selection argv carries no selection flags (hours flag --full is orthogonal to selection parity)",
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
