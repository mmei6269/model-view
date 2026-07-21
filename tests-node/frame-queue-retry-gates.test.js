"use strict";

// Retry-pass scheduling contracts pinned after audits: (1) retry tasks must
// flow through the real dependency gates when the recorded failure belongs to
// an older attempt; (2) a failure in the current attempt skips and drains the
// remaining parts without letting a later part report the frame recovered;
// (3) a worker throw must stop every runner from dispatching new tasks.

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildFrameRenderTasks,
  canStartFrameTaskWithDependencies,
  markFrameTaskDependencyComplete,
  processGlobalFrameTask,
  rearmFrameDependencyGatesForRetry,
  runGlobalFrameTaskQueue,
} = require("../scripts/lib/noaa-build/frame-queue");

function snowfallEntry() {
  return {
    hasSnowfallFrameDependency: true,
    snowfallDependencyFrameHours: [0, 1],
    failedFrames: new Map(),
    finishedFrameHours: new Set(),
    completedDependencyHours: new Set(),
    completedBaseHours: new Set(),
    completedDeltaHours: new Set(),
    completedSnowPrefixHours: new Set(),
    completedRunMaxPrefixHours: new Set(),
  };
}

function splitHourTasks(entry) {
  return buildFrameRenderTasks([
    { entry, modelKey: "nam", frame: { hour: 0 }, hour: 0, sortKey: 0, modelIndex: 0, frameIndex: 0 },
    { entry, modelKey: "nam", frame: { hour: 1 }, hour: 1, sortKey: 1, modelIndex: 0, frameIndex: 1 },
  ]).filter((task) => task.hour === 1);
}

test("initial-pass tasks of a failed hour stay fast-pathed (the processor skips them)", () => {
  const entry = snowfallEntry();
  entry.failedFrames.set(1, { frame: { hour: 1 }, retryAttempt: 0 });
  for (const task of splitHourTasks(entry)) {
    assert.equal(canStartFrameTaskWithDependencies(task), true, `${task.renderPart} should stay dispatchable`);
  }
});

test("retry tasks of a failed hour flow through the real dependency gates", () => {
  const entry = snowfallEntry();
  // Simulate pass 0: every part of hour 1 "finished" (failed parts included —
  // onTaskFinished marks them in the runner's finally), hour 0 succeeded.
  entry.failedFrames.set(1, { frame: { hour: 1 }, retryAttempt: 0 });
  entry.completedDependencyHours.add(0).add(1);
  entry.completedBaseHours.add(0).add(1);
  entry.completedDeltaHours.add(0).add(1);
  entry.completedSnowPrefixHours.add(0).add(1);

  rearmFrameDependencyGatesForRetry(entry, [1]);
  const [base, snowPrefix, snow] = splitHourTasks(entry);
  for (const task of [base, snowPrefix, snow]) {
    task.retryAttempt = 1;
  }

  // The stale pass-0 marks are gone: parts gate in order again.
  assert.equal(canStartFrameTaskWithDependencies(base), true, "retried base starts first");
  assert.equal(canStartFrameTaskWithDependencies(snowPrefix), false, "snow-prefix waits for retried base");
  assert.equal(canStartFrameTaskWithDependencies(snow), false, "snow waits for retried prefix");
  markFrameTaskDependencyComplete(base);
  assert.equal(canStartFrameTaskWithDependencies(snowPrefix), true);
  assert.equal(canStartFrameTaskWithDependencies(snow), false);
  markFrameTaskDependencyComplete(snowPrefix);
  assert.equal(canStartFrameTaskWithDependencies(snow), true);

  // Hour 0's successful marks survived the re-arm (chain gates need them).
  assert.equal(entry.completedDependencyHours.has(0), true);
  assert.equal(entry.completedBaseHours.has(0), true);
});

test("a failed retry part skips later parts without clearing the frame failure", async () => {
  const frame = { hour: 1, validHourKey: "valid" };
  const entry = {
    ...snowfallEntry(),
    modelKey: "nam",
    viewKey: "conus",
    targetFrames: [frame],
    totalFrames: 1,
    state: {
      modelKey: "nam",
      runId: "run",
      viewKey: "conus",
      latestMetadata: {},
      framePlanByHour: new Map([[1, {}]]),
      manifest: { hourStatus: {} },
    },
    built: 0,
    reused: 0,
    failed: 1,
    completed: 1,
    active: 0,
  };
  entry.failedFrames.set(1, { frame, error: "initial failure", retryAttempt: 0 });
  entry.completedDependencyHours.add(1);
  entry.completedBaseHours.add(1);
  entry.completedDeltaHours.add(1);
  entry.completedSnowPrefixHours.add(1);

  const tasks = buildFrameRenderTasks([
    { entry, modelKey: "nam", frame, hour: 1, sortKey: 1, modelIndex: 0, frameIndex: 0 },
  ]);
  for (const task of tasks) {
    task.retryAttempt = 1;
  }
  rearmFrameDependencyGatesForRetry(entry, [1]);

  const calls = [];
  const runtime = {
    stats: { frameRenderCacheHits: 0, buildFrames: 0 },
    createFrameStatIndex: () => ({}),
    getFrameDirectory: () => "/unused",
    isFrameCompleteForState: async () => false,
    refreshFrameArtifactBytes: async () => {},
    renderFrameArtifactsForState: async (_state, _frame, options) => {
      calls.push(options.renderMode);
      if (options.renderMode === "base") {
        throw new Error("base retry failed");
      }
      return {};
    },
    ensureFrameRenderedForState: async (_state, renderedFrame, options) => {
      calls.push(options.renderMode);
      return renderedFrame;
    },
  };

  await runGlobalFrameTaskQueue(
    tasks,
    3,
    (task) => processGlobalFrameTask(runtime, entry, frame, { retryAttempt: 1, task, onProgress() {} }),
    {
      canStartTask: canStartFrameTaskWithDependencies,
      onTaskFinished: markFrameTaskDependencyComplete,
    },
  );

  assert.deepEqual(calls, ["base"], "later retry parts must drain as skips without rendering");
  assert.equal(entry.failedFrames.size, 1, "the failed retry must remain recorded");
  assert.equal(entry.failedFrames.get(1)?.retryAttempt, 1);
  assert.equal(entry.built, 0, "a skipped snow part must not report the frame built");
});

test("a duck-typed runtime without the stat-index factory reuses complete frames on the per-key path", async () => {
  // The stat-index support is opt-in ("Duck-typed runtimes without the
  // factory keep the per-key path"): a runtime that implements only the
  // documented interface — no createFrameStatIndex, no getFrameDirectory —
  // must flow through the reuse branch, not throw on a frameDir hint lookup.
  const frame = { hour: 1, validHourKey: "valid" };
  const entry = {
    ...snowfallEntry(),
    modelKey: "nam",
    viewKey: "conus",
    targetFrames: [frame],
    totalFrames: 1,
    state: {
      modelKey: "nam",
      runId: "run",
      viewKey: "conus",
      latestMetadata: {},
      framePlanByHour: new Map([[1, {}]]),
      manifest: { hourStatus: {} },
    },
    built: 0,
    reused: 0,
    failed: 0,
    completed: 0,
    active: 0,
  };
  const refreshOptions = [];
  const runtime = {
    stats: { frameRenderCacheHits: 0, buildFrames: 0 },
    isFrameCompleteForState: async () => true,
    refreshFrameArtifactBytes: async (_frame, options) => {
      refreshOptions.push(options);
    },
  };

  const result = await processGlobalFrameTask(runtime, entry, frame, {
    task: { renderMode: "all", renderPart: "all" },
    onProgress() {},
  });

  assert.equal(result, true);
  assert.equal(entry.reused, 1, "the complete frame was reused, not failed");
  assert.deepEqual(refreshOptions, [{}], "no statIndex/frameDir hint reaches the per-key refresh");
  assert.equal(entry.state.manifest.hourStatus["1"], "loaded");
});

test("a worker throw stops every runner from dispatching new tasks", async () => {
  const startedTasks = [];
  let releaseSecond;
  const secondRunning = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const tasks = Array.from({ length: 6 }, (_, index) => ({ id: index, renderMode: "all" }));
  const queueError = new Error("frame worker exploded");
  await assert.rejects(
    runGlobalFrameTaskQueue(
      tasks,
      2,
      async (task) => {
        startedTasks.push(task.id);
        if (task.id === 0) {
          // Let the sibling runner pick up task 1 before failing, so the
          // assertion exercises the cross-runner abort, not this runner's own
          // loop exit.
          await secondRunning;
          throw queueError;
        }
        releaseSecond();
        await new Promise((resolve) => setImmediate(resolve));
      },
      { label: "abort-test" },
    ),
    (error) => error === queueError,
  );
  // The old detached-drain behavior kept dispatching AFTER the queue promise
  // rejected, so give surviving runners time to expose themselves before
  // asserting nothing new started.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(startedTasks.sort(), [0, 1], `queue kept dispatching after failure: ${startedTasks}`);
});
