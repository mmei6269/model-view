"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { LocalArtifactRuntime, isManifestUsablyComplete } = require("../scripts/lib/local-artifact-runtime");
const { buildNoaaNamMetadata } = require("../scripts/lib/noaa-build/run-resolution");

function createRuntime(cacheRoot, metadata, renderFrameArtifacts = async () => null) {
  return new LocalArtifactRuntime({
    cacheRoot,
    renderWidth: 4,
    renderHeight: 3,
    fetchLatestMetadata: async () => metadata,
    renderFrameArtifacts,
  });
}

test("manifest usable completeness requires every frame loaded", () => {
  assert.equal(isManifestUsablyComplete(null), false);
  assert.equal(isManifestUsablyComplete({ frames: [], hourStatus: {} }), false);
  assert.equal(
    isManifestUsablyComplete({ frames: [{ hour: 0 }, { hour: 3 }], hourStatus: { 0: "loaded", 3: "loaded" } }),
    true,
  );
  assert.equal(
    isManifestUsablyComplete({ frames: [{ hour: 0 }, { hour: 3 }], hourStatus: { 0: "loaded", 3: "pending" } }),
    false,
  );
  assert.equal(
    isManifestUsablyComplete({ frames: [{ hour: 0 }, { hour: 3 }], hourStatus: { 0: "loaded", 3: "error" } }),
    false,
  );
});

test("NOAA latest pointer advances only when the new run is usably complete", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-latest-pointer-"));

  // Bootstrap: with no pointer on disk the first build is visible immediately.
  const morningRuntime = createRuntime(
    tempDir,
    buildNoaaNamMetadata({ modelKey: "nam", run: { date: "20260425", cycle: "06" }, hours: [0, 3] }),
  );
  await morningRuntime.init();
  await morningRuntime.ensureLatestState("nam", "conus", { forceRefresh: true });
  let pointer = await morningRuntime.readLatestPointerFromDisk("nam", "conus");
  assert.equal(pointer.run, "20260425-0600Z");
  await morningRuntime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });

  // A new run's build start writes its manifest but must not steal the pointer.
  const noonRuntime = createRuntime(
    tempDir,
    buildNoaaNamMetadata({ modelKey: "nam", run: { date: "20260425", cycle: "12" }, hours: [0, 3] }),
  );
  await noonRuntime.init();
  await noonRuntime.ensureLatestState("nam", "conus", { forceRefresh: true });
  pointer = await noonRuntime.readLatestPointerFromDisk("nam", "conus");
  assert.equal(pointer.run, "20260425-0600Z");

  // The in-progress run stays selectable: manifest on disk and listed in runs.json.
  const inProgress = await noonRuntime.readManifestFromDisk("nam", "20260425-1200Z", "conus");
  assert.deepEqual(
    inProgress.frames.map((frame) => frame.hour),
    [0, 3],
  );
  const runs = await noonRuntime.listRunManifests("nam", "conus");
  assert.deepEqual(
    runs.map((entry) => entry.run),
    ["20260425-1200Z", "20260425-0600Z"],
  );
  assert.equal(runs.find((entry) => entry.run === "20260425-1200Z").latest, false);
  assert.equal(runs.find((entry) => entry.run === "20260425-0600Z").latest, true);

  // Completing the new run advances the pointer.
  await noonRuntime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });
  pointer = await noonRuntime.readLatestPointerFromDisk("nam", "conus");
  assert.equal(pointer.run, "20260425-1200Z");
});

test("NOAA latest pointer bootstraps over a corrupt pointer file instead of aborting", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-latest-pointer-corrupt-"));
  const runtime = createRuntime(
    tempDir,
    buildNoaaNamMetadata({ modelKey: "nam", run: { date: "20260425", cycle: "06" }, hours: [0, 3] }),
  );
  await runtime.init();
  const pointerPath = runtime.getLatestPointerStoragePath("nam", "conus");
  await fs.promises.mkdir(path.dirname(pointerPath), { recursive: true });
  await fs.promises.writeFile(pointerPath, "{not-json!!", "utf8");

  // The gating flow must not throw on the garbage pointer; it rewrites it
  // with bootstrap semantics for the run being built.
  await runtime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });
  const pointer = await runtime.readLatestPointerFromDisk("nam", "conus");
  assert.equal(pointer.run, "20260425-0600Z");
});

test("NOAA latest pointer stays on the previous run when a new run build fails", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-latest-pointer-fail-"));
  const morningRuntime = createRuntime(
    tempDir,
    buildNoaaNamMetadata({ modelKey: "nam", run: { date: "20260425", cycle: "06" }, hours: [0, 3] }),
  );
  await morningRuntime.init();
  await morningRuntime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });

  const failingRuntime = createRuntime(
    tempDir,
    buildNoaaNamMetadata({ modelKey: "nam", run: { date: "20260425", cycle: "12" }, hours: [0, 3] }),
    async () => {
      throw new Error("render unavailable");
    },
  );
  await failingRuntime.init();
  const summary = await failingRuntime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });
  assert.equal(summary.failed, 2);
  const pointer = await failingRuntime.readLatestPointerFromDisk("nam", "conus");
  assert.equal(pointer.run, "20260425-0600Z");
  const failedManifest = await failingRuntime.readManifestFromDisk("nam", "20260425-1200Z", "conus");
  assert.equal(failedManifest.hourStatus["0"], "error");
});
