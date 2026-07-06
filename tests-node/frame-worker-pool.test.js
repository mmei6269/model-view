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
