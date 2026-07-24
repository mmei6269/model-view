"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { FRAME_WORKER_STARTUP_RECEIPT_TYPE, FrameWorkerPool } = require("../scripts/lib/local-artifact-concurrency");

const SNOW_STARTUP_RECEIPT_TYPE = "noaa-snow-lookup-state";

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

function withStartupMessages(messages) {
  const startupMessages = messages.map((message) => `parentPort.postMessage(${JSON.stringify(message)});`).join("\n");
  return STUB_WORKER_SOURCE.replace(
    'parentPort.on("message", (message) => {',
    `${startupMessages}\nparentPort.on("message", (message) => {`,
  );
}

let stubDir;
let stubWorkerPath;
let receiptWorkerPath;
let dualReceiptWorkerPaths;
let duplicateReceiptWorkerPath;
let unknownReceiptWorkerPath;
let missingReceiptWorkerPath;
let masqueradingReceiptWorkerPath;

test.before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-worker-pool-test-"));
  stubWorkerPath = path.join(stubDir, "stub-frame-worker.js");
  fs.writeFileSync(stubWorkerPath, STUB_WORKER_SOURCE);
  const writeStartupWorker = (filename, messages) => {
    const workerPath = path.join(stubDir, filename);
    fs.writeFileSync(workerPath, withStartupMessages(messages));
    return workerPath;
  };
  const colorReceipt = {
    type: FRAME_WORKER_STARTUP_RECEIPT_TYPE,
    role: "frame-worker",
    marker: "color-ready",
  };
  const snowReceipt = {
    type: SNOW_STARTUP_RECEIPT_TYPE,
    role: "frame-worker",
    marker: "snow-ready",
  };
  receiptWorkerPath = writeStartupWorker("receipt-frame-worker.js", [{ ...colorReceipt, marker: "ready" }]);
  dualReceiptWorkerPaths = {
    colorThenSnow: writeStartupWorker("color-then-snow-frame-worker.js", [colorReceipt, snowReceipt]),
    snowThenColor: writeStartupWorker("snow-then-color-frame-worker.js", [snowReceipt, colorReceipt]),
  };
  duplicateReceiptWorkerPath = writeStartupWorker("duplicate-receipt-frame-worker.js", [colorReceipt, colorReceipt]);
  unknownReceiptWorkerPath = writeStartupWorker("unknown-receipt-frame-worker.js", [
    { type: "noaa-unconfigured-lookup-state", role: "frame-worker" },
  ]);
  missingReceiptWorkerPath = writeStartupWorker("missing-receipt-frame-worker.js", [colorReceipt]);
  masqueradingReceiptWorkerPath = writeStartupWorker("masquerading-receipt-frame-worker.js", [
    {
      type: FRAME_WORKER_STARTUP_RECEIPT_TYPE,
      id: 1,
      ok: true,
      frameArtifacts: { echo: "not-a-receipt" },
    },
  ]);
});

test.after(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
});

test("startup receipts gate dispatch and identify every respawn ordinal", { timeout: 30000 }, async () => {
  const receipts = [];
  const pool = new FrameWorkerPool({
    workerPath: receiptWorkerPath,
    size: 1,
    maxRespawns: 1,
    requireStartupReceipt: true,
    onStartupReceipt: (receipt) => receipts.push(receipt),
  });
  try {
    assert.deepEqual(pool.requiredStartupReceiptTypes, [FRAME_WORKER_STARTUP_RECEIPT_TYPE]);
    assert.equal(pool.getStats().busy, 0, "a worker is not dispatchable before its receipt");
    assert.equal((await pool.run({ echo: "first" })).echo, "first");
    await assert.rejects(pool.run({ mode: "die" }), /Frame worker died mid-job/);
    assert.equal((await pool.run({ echo: "after-respawn" })).echo, "after-respawn");
    assert.deepEqual(
      receipts.map(({ type, role, marker, spawnOrdinal }) => ({ type, role, marker, spawnOrdinal })),
      [
        {
          type: FRAME_WORKER_STARTUP_RECEIPT_TYPE,
          role: "frame-worker",
          marker: "ready",
          spawnOrdinal: 1,
        },
        {
          type: FRAME_WORKER_STARTUP_RECEIPT_TYPE,
          role: "frame-worker",
          marker: "ready",
          spawnOrdinal: 2,
        },
      ],
    );
  } finally {
    await pool.close();
  }
});

test("an exact two-receipt set gates dispatch in either order and resets on respawn", { timeout: 30000 }, async (t) => {
  for (const [caseName, workerPath] of Object.entries(dualReceiptWorkerPaths)) {
    await t.test(caseName, async () => {
      const receipts = [];
      const statsAtReceipt = [];
      let pool;
      pool = new FrameWorkerPool({
        workerPath,
        size: 1,
        maxRespawns: 1,
        requiredStartupReceiptTypes: [FRAME_WORKER_STARTUP_RECEIPT_TYPE, SNOW_STARTUP_RECEIPT_TYPE],
        onStartupReceipt: (receipt) => {
          receipts.push(receipt);
          statsAtReceipt.push(pool.getStats());
        },
      });
      try {
        const first = pool.run({ echo: "first" });
        assert.deepEqual(
          { busy: pool.getStats().busy, queued: pool.getStats().queued },
          { busy: 0, queued: 1 },
          "the first job queues until the complete receipt set arrives",
        );
        assert.equal((await first).echo, "first");

        const dying = pool.run({ mode: "die" });
        const queued = pool.run({ echo: "after-respawn" });
        await assert.rejects(dying, /Frame worker died mid-job/);
        assert.equal((await queued).echo, "after-respawn");

        const expectedOrder =
          caseName === "colorThenSnow"
            ? [FRAME_WORKER_STARTUP_RECEIPT_TYPE, SNOW_STARTUP_RECEIPT_TYPE]
            : [SNOW_STARTUP_RECEIPT_TYPE, FRAME_WORKER_STARTUP_RECEIPT_TYPE];
        assert.deepEqual(
          receipts.map(({ type, spawnOrdinal }) => ({ type, spawnOrdinal })),
          [
            ...expectedOrder.map((type) => ({ type, spawnOrdinal: 1 })),
            ...expectedOrder.map((type) => ({ type, spawnOrdinal: 2 })),
          ],
          "each spawn forwards both canonical receipts with one shared ordinal",
        );
        assert.ok(
          statsAtReceipt.every(({ busy, queued }) => busy === 0 && queued === 1),
          "neither the first nor final receipt callback observes a dispatchable worker",
        );
        assert.equal(pool.getStats().respawnsUsed, 1);
      } finally {
        await pool.close();
      }
    });
  }
});

test("a duplicate required receipt before the set is complete kills the worker", { timeout: 30000 }, async () => {
  const receipts = [];
  const pool = new FrameWorkerPool({
    workerPath: duplicateReceiptWorkerPath,
    size: 1,
    maxRespawns: 0,
    requiredStartupReceiptTypes: [FRAME_WORKER_STARTUP_RECEIPT_TYPE, SNOW_STARTUP_RECEIPT_TYPE],
    onStartupReceipt: (receipt) => receipts.push(receipt),
  });
  try {
    await assert.rejects(
      pool.run({ echo: "must-not-dispatch" }),
      /duplicate startup receipt type "noaa-color-lookup-state"/,
    );
    assert.deepEqual(
      receipts.map(({ type, spawnOrdinal }) => ({ type, spawnOrdinal })),
      [{ type: FRAME_WORKER_STARTUP_RECEIPT_TYPE, spawnOrdinal: 1 }],
      "the first canonical receipt is forwarded exactly once",
    );
  } finally {
    await pool.close();
  }
});

test("an unknown startup receipt type kills the worker", { timeout: 30000 }, async () => {
  const receipts = [];
  const pool = new FrameWorkerPool({
    workerPath: unknownReceiptWorkerPath,
    size: 1,
    maxRespawns: 0,
    requiredStartupReceiptTypes: [FRAME_WORKER_STARTUP_RECEIPT_TYPE, SNOW_STARTUP_RECEIPT_TYPE],
    onStartupReceipt: (receipt) => receipts.push(receipt),
  });
  try {
    await assert.rejects(
      pool.run({ echo: "must-not-dispatch" }),
      /unknown startup receipt type "noaa-unconfigured-lookup-state"/,
    );
    assert.deepEqual(receipts, [], "unknown receipts are never forwarded");
  } finally {
    await pool.close();
  }
});

test("the startup timeout reports every receipt still missing from the exact set", { timeout: 30000 }, async () => {
  const receipts = [];
  const pool = new FrameWorkerPool({
    workerPath: missingReceiptWorkerPath,
    size: 1,
    maxRespawns: 0,
    requiredStartupReceiptTypes: [FRAME_WORKER_STARTUP_RECEIPT_TYPE, SNOW_STARTUP_RECEIPT_TYPE],
    onStartupReceipt: (receipt) => receipts.push(receipt),
    startupReceiptTimeoutMs: 200,
  });
  try {
    await assert.rejects(
      pool.run({ echo: "must-not-dispatch" }),
      /did not provide all required startup receipts within 200ms; missing: noaa-snow-lookup-state/,
    );
    assert.deepEqual(
      receipts.map(({ type, spawnOrdinal }) => ({ type, spawnOrdinal })),
      [{ type: FRAME_WORKER_STARTUP_RECEIPT_TYPE, spawnOrdinal: 1 }],
    );
  } finally {
    await pool.close();
  }
});

test("a job-shaped message cannot masquerade as a startup receipt", { timeout: 30000 }, async () => {
  const receipts = [];
  const pool = new FrameWorkerPool({
    workerPath: masqueradingReceiptWorkerPath,
    size: 1,
    maxRespawns: 0,
    requireStartupReceipt: true,
    onStartupReceipt: (receipt) => receipts.push(receipt),
  });
  try {
    await assert.rejects(
      pool.run({ echo: "must-not-dispatch" }),
      /startup receipt type "noaa-color-lookup-state" with reserved job-response field "id"/,
    );
    assert.deepEqual(receipts, [], "job-shaped messages are never forwarded as startup receipts");
  } finally {
    await pool.close();
  }
});

test("duplicate required receipt types are rejected before any worker is spawned", () => {
  assert.throws(
    () =>
      new FrameWorkerPool({
        workerPath: stubWorkerPath,
        size: 1,
        maxRespawns: 0,
        requiredStartupReceiptTypes: [FRAME_WORKER_STARTUP_RECEIPT_TYPE, FRAME_WORKER_STARTUP_RECEIPT_TYPE],
      }),
    /requiredStartupReceiptTypes contains duplicate type "noaa-color-lookup-state"/,
  );
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
