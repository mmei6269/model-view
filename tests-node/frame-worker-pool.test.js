"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { FrameWorkerPool } = require("../scripts/lib/local-artifact-concurrency");

const STUB_WORKER_SOURCE = `"use strict";
const { parentPort } = require("worker_threads");
parentPort.on("message", (message) => {
  if (!message || message.type !== "render-frame") {
    return;
  }
  const payload = message.payload || {};
  if (payload.mode === "die") {
    process.exit(payload.exitCode ?? 7);
  }
  if (payload.mode === "throw") {
    throw new Error("stub-worker-boom");
  }
  if (payload.mode === "rendezvous") {
    // Barrier for the concurrency spec: park INSIDE the job until the test
    // releases lanes[1]. lanes[0] counts workers currently inside a job, so
    // it can only reach 2 when two workers execute simultaneously.
    const lanes = new Int32Array(payload.sab);
    Atomics.add(lanes, 0, 1);
    Atomics.notify(lanes, 0);
    Atomics.wait(lanes, 1, 0);
  }
  parentPort.postMessage({
    id: message.id,
    ok: true,
    frameArtifacts: { echo: payload.echo ?? null },
  });
});
`;

let stubDir;
let stubWorkerPath;

test.before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-worker-pool-test-"));
  stubWorkerPath = path.join(stubDir, "stub-frame-worker.js");
  fs.writeFileSync(stubWorkerPath, STUB_WORKER_SOURCE);
});

test.after(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
});

test("worker death rejects the in-flight job and respawns for the next job", { timeout: 30000 }, async () => {
  const pool = new FrameWorkerPool({
    workerPath: stubWorkerPath,
    size: 1,
    maxRespawns: 3,
  });
  try {
    await assert.rejects(pool.run({ mode: "die" }), /Frame worker died mid-job \(job 1\): Worker exited with code 7/);
    const result = await pool.run({ echo: "after-respawn" });
    assert.equal(result.echo, "after-respawn");
    assert.equal(pool.getStats().respawnsUsed, 1);
  } finally {
    await pool.close();
  }
});

test("queued jobs survive a worker death when a respawn is available", { timeout: 30000 }, async () => {
  const pool = new FrameWorkerPool({
    workerPath: stubWorkerPath,
    size: 1,
    maxRespawns: 3,
  });
  try {
    const dying = pool.run({ mode: "die" });
    const queued = pool.run({ echo: "survives" });
    await assert.rejects(dying, /Frame worker died mid-job/);
    const result = await queued;
    assert.equal(result.echo, "survives");
  } finally {
    await pool.close();
  }
});

test("respawn budget exhaustion rejects queued and subsequent jobs loudly", { timeout: 30000 }, async () => {
  const pool = new FrameWorkerPool({
    workerPath: stubWorkerPath,
    size: 1,
    maxRespawns: 0,
  });
  try {
    const dying = pool.run({ mode: "die" });
    const queued = pool.run({ echo: "queued" });
    await assert.rejects(dying, /Frame worker died mid-job/);
    await assert.rejects(queued, /respawn budget exhausted \(0 respawns\)/);
    await assert.rejects(pool.run({ echo: "later" }), /respawn budget exhausted/);
    assert.equal(pool.getStats().queued, 0);
  } finally {
    await pool.close();
  }
});

test(
  "uncaught worker error rejects the job without double-spending the budget on exit",
  { timeout: 30000 },
  async () => {
    const pool = new FrameWorkerPool({
      workerPath: stubWorkerPath,
      size: 1,
      maxRespawns: 1,
    });
    try {
      await assert.rejects(pool.run({ mode: "throw" }), /Frame worker died mid-job \(job 1\): stub-worker-boom/);
      const result = await pool.run({ echo: "ok" });
      assert.equal(result.echo, "ok");
      assert.equal(pool.getStats().respawnsUsed, 1);
    } finally {
      await pool.close();
    }
  },
);

test(
  "size 2 dispatches two jobs to distinct workers concurrently and drains the queue",
  { timeout: 30000 },
  async () => {
    const pool = new FrameWorkerPool({
      workerPath: stubWorkerPath,
      size: 2,
      maxRespawns: 0,
    });
    const sab = new SharedArrayBuffer(8);
    const lanes = new Int32Array(sab);
    try {
      const first = pool.run({ mode: "rendezvous", sab, echo: "lane-a" });
      const second = pool.run({ mode: "rendezvous", sab, echo: "lane-b" });
      // Keep the promises from surfacing as unhandled if an assertion below
      // throws before the barrier release.
      first.catch(() => undefined);
      second.catch(() => undefined);
      // ENGAGEMENT: run() dispatches synchronously through pump(), so with two
      // idle workers both jobs must already be in flight — nothing queued.
      // A size-1 pool (or single-worker dispatch bug) fails here immediately.
      const stats = pool.getStats();
      assert.deepEqual({ busy: stats.busy, queued: stats.queued }, { busy: 2, queued: 0 });
      const third = pool.run({ echo: "queued-c" });
      third.catch(() => undefined);
      assert.equal(pool.getStats().queued, 1, "third job queues behind two busy workers");
      // Deterministic proof of true concurrency (no wall-clock): both workers
      // must reach the barrier while neither job has completed, which is only
      // possible with two workers inside jobs at the same time.
      while (Atomics.load(lanes, 0) < 2) {
        const wait = Atomics.waitAsync(lanes, 0, Atomics.load(lanes, 0));
        if (wait.async) {
          await wait.value;
        }
      }
      assert.equal(Atomics.load(lanes, 0), 2, "two workers inside jobs simultaneously");
      Atomics.store(lanes, 1, 1);
      Atomics.notify(lanes, 1);
      const results = await Promise.all([first, second]);
      assert.deepEqual(results.map((result) => result.echo).sort(), ["lane-a", "lane-b"]);
      assert.equal((await third).echo, "queued-c", "queued job dispatches once a worker frees up");
      assert.equal(pool.getStats().queued, 0);
    } finally {
      Atomics.store(lanes, 1, 1);
      Atomics.notify(lanes, 1);
      await pool.close();
    }
  },
);

test("two concurrent worker deaths share the pool-wide respawn budget", { timeout: 30000 }, async () => {
  const pool = new FrameWorkerPool({
    workerPath: stubWorkerPath,
    size: 2,
    maxRespawns: 1,
  });
  try {
    const deathA = pool.run({ mode: "die" });
    const deathB = pool.run({ mode: "die" });
    deathA.catch(() => undefined);
    deathB.catch(() => undefined);
    assert.equal(pool.getStats().busy, 2, "both dying jobs dispatch concurrently to distinct workers");
    await assert.rejects(deathA, /Frame worker died mid-job/);
    await assert.rejects(deathB, /Frame worker died mid-job/);
    // The budget is shared across workers, not per worker: the first death
    // consumes the single respawn, the second exhausts the pool.
    assert.equal(pool.getStats().respawnsUsed, 1, "exactly one respawn spent across both deaths");
    await assert.rejects(pool.run({ echo: "after-exhaustion" }), /respawn budget exhausted \(1 respawns\)/);
  } finally {
    await pool.close();
  }
});

test("pool survives deaths within the budget and fails on the death after it", { timeout: 30000 }, async () => {
  const pool = new FrameWorkerPool({
    workerPath: stubWorkerPath,
    size: 1,
    maxRespawns: 2,
  });
  try {
    await assert.rejects(pool.run({ mode: "die" }), /Frame worker died mid-job/);
    await assert.rejects(pool.run({ mode: "die" }), /Frame worker died mid-job/);
    const ok = await pool.run({ echo: "still-alive" });
    assert.equal(ok.echo, "still-alive");
    await assert.rejects(pool.run({ mode: "die" }), /Frame worker died mid-job/);
    await assert.rejects(pool.run({ echo: "too-late" }), /respawn budget exhausted \(2 respawns\)/);
  } finally {
    await pool.close();
  }
});
