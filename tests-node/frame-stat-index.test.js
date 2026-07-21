"use strict";

// Backlog #11: the FrameStatIndex-backed completeness path (one readdir per
// frame directory + lazily memoized entry stats) must answer exactly what the
// per-key access/stat probes answered. These suites pin that equivalence on
// synthetic frame directories — present/missing/corrupt entries, dotfiles,
// subdirectories, size-zero files, symlinks, and keys that escape the frame
// directory — plus the sweep-level mutation windows (byte refreshes, marker
// availability merges, early-exit boundaries) and the mid-sweep invalidation
// contract: an index never outlives the sweep that created it.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
const { collectFrameArtifactKeys } = require("../scripts/lib/local-artifact-manifest");
const { MODEL_CONFIG, buildManifestTemplate } = require("../scripts/lib/modelview-runtime");

const MODEL = "gfs";
const VIEW = "conus";
const RUN = "20260701-0000Z";
const REFERENCE_TIME = "2026-07-01T00:00:00Z";
const SIGNATURE = "stat-index-test-signature";

function createRuntime(cacheRoot, options = {}) {
  return new LocalArtifactRuntime({
    cacheRoot,
    renderWidth: 8,
    renderHeight: 6,
    ...options,
  });
}

function supplementalRefs(frame) {
  // A dotfile-named supplemental and a bytes=0 supplemental pin two key-set
  // rules: bytes>0 supplementals are probed (dotfiles included), bytes=0
  // supplementals are not probed but are still stat-refreshed.
  const frameBase = path.posix.dirname(frame.hoverGridKey);
  return {
    dot: { key: `${frameBase}/.dotfile-grid.gz`, bytes: 5, schemaVersion: 4 },
    zero: { key: `${frameBase}/hover-grid-zero.json.gz`, bytes: 0, schemaVersion: 4 },
  };
}

function buildFrame(hour) {
  const manifest = buildManifestTemplate({
    modelKey: MODEL,
    viewKey: VIEW,
    runId: RUN,
    referenceTime: REFERENCE_TIME,
    validTimes: [new Date(Date.parse(REFERENCE_TIME) + hour * 3_600_000).toISOString()],
    renderWidth: 8,
    renderHeight: 6,
    reflectivityGates: [10, 15, 20],
    forecastHours: [hour],
  });
  const frame = manifest.frames.find((entry) => Number(entry.hour) === hour);
  assert.ok(frame, `template carries hour ${hour}`);
  frame.hoverGridSupplemental = supplementalRefs(frame);
  return frame;
}

async function writeFrameArtifacts(runtime, frame, options = {}) {
  const frameDir = runtime.getFrameDirectory(MODEL, RUN, VIEW, frame.hour);
  await fs.promises.mkdir(frameDir, { recursive: true });
  const omit = new Set(options.omitKeys || []);
  for (const key of collectFrameArtifactKeys(frame)) {
    if (omit.has(key)) {
      continue;
    }
    await fs.promises.writeFile(runtime.getArtifactStoragePath(key), Buffer.from(`artifact:${key}`));
  }
  if (options.marker !== false) {
    const marker = {
      renderedAt: "2026-07-01T00:05:00.000Z",
      modelKey: MODEL,
      viewKey: VIEW,
      runId: RUN,
      hour: frame.hour,
      validTime: frame.validHourKey,
      openDataModel: MODEL_CONFIG[MODEL].openDataModel,
      rendererSignature: SIGNATURE,
      parameterAvailability: options.markerAvailability || {},
    };
    await fs.promises.writeFile(runtime.getFrameMarkerPath(MODEL, RUN, VIEW, frame.hour), JSON.stringify(marker));
  }
}

function snapshotByteFields(frame) {
  const pick = (refs) => Object.fromEntries(Object.entries(refs || {}).map(([key, ref]) => [key, ref.bytes]));
  return {
    layers: pick(frame.layers),
    reflectivityVariants: pick(frame.reflectivityVariants),
    reflectivityVariantsByLayer: Object.fromEntries(
      Object.entries(frame.reflectivityVariantsByLayer || {}).map(([layer, variants]) => [layer, pick(variants)]),
    ),
    contourVectorRefs: pick(frame.contourVectorRefs),
    weatherVectorRefs: pick(frame.weatherVectorRefs),
    hoverGridSupplemental: pick(frame.hoverGridSupplemental),
    synopticVectorBytes: { ...frame.synopticVectorBytes },
    hoverGridBytes: frame.hoverGridBytes,
  };
}

// Runs the completeness probe and the byte refresh both ways — the pre-change
// per-key path (no statIndex) and the indexed path — and asserts identical
// decisions, identical refreshed bytes, and identical marker merges.
async function assertProbeParity(runtime, frame) {
  const frameDir = runtime.getFrameDirectory(MODEL, RUN, VIEW, frame.hour);
  const fallbackFrame = structuredClone(frame);
  const indexedFrame = structuredClone(frame);
  const decision = await runtime.isFrameComplete(MODEL, RUN, VIEW, fallbackFrame);
  const statIndex = runtime.createFrameStatIndex();
  const indexed = await runtime.isFrameComplete(MODEL, RUN, VIEW, indexedFrame, { statIndex });
  assert.equal(indexed, decision, "indexed probe decision matches per-key probes");
  await runtime.refreshFrameArtifactBytes(fallbackFrame);
  await runtime.refreshFrameArtifactBytes(indexedFrame, { statIndex, frameDir });
  assert.deepEqual(snapshotByteFields(indexedFrame), snapshotByteFields(fallbackFrame));
  assert.deepEqual(indexedFrame.parameterAvailability, fallbackFrame.parameterAvailability);
  return { decision, fallbackFrame, indexedFrame };
}

async function makeTempRuntime() {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "frame-stat-index-"));
  return { cacheRoot, runtime: createRuntime(cacheRoot) };
}

test("indexed presence and byte refresh match per-key probes on a complete frame", async () => {
  const { runtime } = await makeTempRuntime();
  const frame = buildFrame(0);
  await writeFrameArtifacts(runtime, frame, { markerAvailability: { temperature: "available" } });
  const { decision, indexedFrame } = await assertProbeParity(runtime, frame);
  assert.equal(decision, true);
  // Sanity: every probed artifact carries its real non-zero size, and the
  // bytes=0 supplemental was refreshed to 0 without breaking completeness.
  const bytes = snapshotByteFields(indexedFrame);
  assert.ok(Object.values(bytes.layers).every((value) => value > 0));
  assert.equal(indexedFrame.hoverGridSupplemental.zero.bytes, 0);
  assert.deepEqual(indexedFrame.parameterAvailability, { temperature: "available" });
});

test("indexed and per-key probes agree on missing and corrupt entries", async () => {
  const { runtime } = await makeTempRuntime();
  const keys = collectFrameArtifactKeys(buildFrame(0));
  const midKey = keys[Math.floor(keys.length / 2)];

  const missing = buildFrame(0);
  await writeFrameArtifacts(runtime, missing, { omitKeys: [midKey] });
  assert.equal((await assertProbeParity(runtime, missing)).decision, false);

  const corrupt = buildFrame(3);
  await writeFrameArtifacts(runtime, corrupt, { marker: false });
  await fs.promises.writeFile(runtime.getFrameMarkerPath(MODEL, RUN, VIEW, 3), "{not-json!!");
  assert.equal((await assertProbeParity(runtime, corrupt)).decision, false);

  const noMarker = buildFrame(6);
  await writeFrameArtifacts(runtime, noMarker, { marker: false });
  assert.equal((await assertProbeParity(runtime, noMarker)).decision, false);
});

test("size-zero artifacts count as present and refresh to zero bytes both ways", async () => {
  const { runtime } = await makeTempRuntime();
  const frame = buildFrame(0);
  await writeFrameArtifacts(runtime, frame);
  const layerKey = Object.keys(frame.layers)[0];
  await fs.promises.truncate(runtime.getArtifactStoragePath(frame.layers[layerKey].key), 0);
  const { decision, indexedFrame } = await assertProbeParity(runtime, frame);
  assert.equal(decision, true);
  assert.equal(indexedFrame.layers[layerKey].bytes, 0);
});

test("dotfile artifact keys are indexed like any other entry", async () => {
  const { runtime } = await makeTempRuntime();
  const present = buildFrame(0);
  await writeFrameArtifacts(runtime, present);
  assert.equal((await assertProbeParity(runtime, present)).decision, true);

  const missing = buildFrame(3);
  await writeFrameArtifacts(runtime, missing, { omitKeys: [missing.hoverGridSupplemental.dot.key] });
  assert.equal((await assertProbeParity(runtime, missing)).decision, false);
});

test("a subdirectory posing as an artifact matches access() semantics", async () => {
  const { runtime } = await makeTempRuntime();
  const frame = buildFrame(0);
  await writeFrameArtifacts(runtime, frame);
  const layerKey = Object.keys(frame.layers)[0];
  const storagePath = runtime.getArtifactStoragePath(frame.layers[layerKey].key);
  await fs.promises.unlink(storagePath);
  await fs.promises.mkdir(storagePath);
  // access(F_OK) succeeds on directories; the indexed path must agree, and the
  // byte refresh must read the same directory stat size.
  const { decision, indexedFrame } = await assertProbeParity(runtime, frame);
  assert.equal(decision, true);
  assert.equal(indexedFrame.layers[layerKey].bytes, (await fs.promises.stat(storagePath)).size);
});

test("symlinked artifacts resolve through the index; dangling links read as missing", async () => {
  const { runtime } = await makeTempRuntime();
  const linked = buildFrame(0);
  await writeFrameArtifacts(runtime, linked);
  const layerKey = Object.keys(linked.layers)[0];
  const linkPath = runtime.getArtifactStoragePath(linked.layers[layerKey].key);
  await fs.promises.unlink(linkPath);
  await fs.promises.symlink(runtime.getArtifactStoragePath(linked.hoverGridKey), linkPath);
  assert.equal((await assertProbeParity(runtime, linked)).decision, true);

  const dangling = buildFrame(3);
  await writeFrameArtifacts(runtime, dangling);
  const danglingKey = Object.keys(dangling.layers)[0];
  const danglingPath = runtime.getArtifactStoragePath(dangling.layers[danglingKey].key);
  await fs.promises.unlink(danglingPath);
  await fs.promises.symlink(path.join(path.dirname(danglingPath), "no-such-target.png"), danglingPath);
  assert.equal((await assertProbeParity(runtime, dangling)).decision, false);
});

test("a listing-denied frame directory falls back to per-key probes instead of reading empty", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root ignores directory permission bits");
    return;
  }
  const { runtime } = await makeTempRuntime();
  const frame = buildFrame(0);
  await writeFrameArtifacts(runtime, frame, { markerAvailability: { temperature: "available" } });
  const frameDir = runtime.getFrameDirectory(MODEL, RUN, VIEW, frame.hour);
  // Search-only: readdir fails with EACCES while every child still stats
  // fine. The index must not report the directory as empty — that verdict
  // would flip a complete frame to pending on every sweep and zero its byte
  // counts, where the per-key probes it replaces succeed.
  await fs.promises.chmod(frameDir, 0o311);
  t.after(() => fs.promises.chmod(frameDir, 0o755));
  const { decision, indexedFrame } = await assertProbeParity(runtime, frame);
  assert.equal(decision, true);
  assert.ok(Object.values(snapshotByteFields(indexedFrame).layers).every((value) => value > 0));
});

test("keys escaping the frame directory fall back to per-key probes", async () => {
  const { runtime } = await makeTempRuntime();
  const donor = buildFrame(9);
  await writeFrameArtifacts(runtime, donor);

  const frame = buildFrame(0);
  await writeFrameArtifacts(runtime, frame);
  const layerKey = Object.keys(frame.layers)[0];
  const originalPath = runtime.getArtifactStoragePath(frame.layers[layerKey].key);
  frame.layers[layerKey] = { ...frame.layers[layerKey], key: donor.layers[layerKey].key };
  await fs.promises.unlink(originalPath);
  // The escaped target exists, so both paths still call the frame complete.
  assert.equal((await assertProbeParity(runtime, frame)).decision, true);

  frame.layers[layerKey] = { ...frame.layers[layerKey], key: `${donor.layers[layerKey].key}.missing` };
  assert.equal((await assertProbeParity(runtime, frame)).decision, false);
});

test("marker-merged availability narrows the probed key set before probing", async () => {
  const { runtime } = await makeTempRuntime();
  const frame = buildFrame(0);
  // The marker stamps precip unavailable and the precip artifact is absent:
  // only a merge that lands BEFORE collectFrameArtifactKeys can call this
  // frame complete (regression pinned by parameter-availability.test.js).
  const precipKey = frame.layers.precip?.key;
  assert.ok(precipKey, "fixture frame carries a precip layer");
  await writeFrameArtifacts(runtime, frame, {
    omitKeys: [precipKey],
    markerAvailability: { precip: "unavailable" },
  });
  const { decision, indexedFrame } = await assertProbeParity(runtime, frame);
  assert.equal(decision, true);
  assert.deepEqual(indexedFrame.parameterAvailability, { precip: "unavailable" });
});

test("a mid-sweep landing is seen on the next sweep, never through a stale index", async () => {
  const { runtime } = await makeTempRuntime();
  const frame = buildFrame(0);
  const missingKey = collectFrameArtifactKeys(frame)[3];
  await writeFrameArtifacts(runtime, frame, { omitKeys: [missingKey] });

  // Before the landing both observation styles agree: incomplete.
  assert.equal(await runtime.isFrameComplete(MODEL, RUN, VIEW, structuredClone(frame)), false);
  const sweepIndex = runtime.createFrameStatIndex();
  assert.equal(
    await runtime.isFrameComplete(MODEL, RUN, VIEW, structuredClone(frame), { statIndex: sweepIndex }),
    false,
  );

  // The artifact lands mid-sweep. The primed index keeps its observation
  // (exactly what per-key probes answered a moment earlier) ...
  await fs.promises.writeFile(runtime.getArtifactStoragePath(missingKey), Buffer.from(`artifact:${missingKey}`));
  assert.equal(
    await runtime.isFrameComplete(MODEL, RUN, VIEW, structuredClone(frame), { statIndex: sweepIndex }),
    false,
  );
  // ... while the next sweep and the per-key path both see the landing.
  assert.equal(
    await runtime.isFrameComplete(MODEL, RUN, VIEW, structuredClone(frame), {
      statIndex: runtime.createFrameStatIndex(),
    }),
    true,
  );
  assert.equal(await runtime.isFrameComplete(MODEL, RUN, VIEW, structuredClone(frame)), true);
});

test("a marker landing after a marker-less probe is seen through the same index", async () => {
  const { runtime } = await makeTempRuntime();
  const frame = buildFrame(0);
  await writeFrameArtifacts(runtime, frame, { marker: false });
  const sweepIndex = runtime.createFrameStatIndex();
  assert.equal(
    await runtime.isFrameComplete(MODEL, RUN, VIEW, structuredClone(frame), { statIndex: sweepIndex }),
    false,
  );
  // The listing is lazy: the marker gate short-circuited before any readdir,
  // so the persisted frame is visible without waiting for a new index — the
  // same answer fresh per-key probes give here.
  await writeFrameArtifacts(runtime, frame);
  assert.equal(
    await runtime.isFrameComplete(MODEL, RUN, VIEW, structuredClone(frame), { statIndex: sweepIndex }),
    true,
  );
});

// The pre-change sweep, kept as the differential oracle: sequential frames,
// per-key probes, no index.
async function applyCompletenessSequentially(runtime, modelKey, runId, viewKey, manifest) {
  manifest.hourStatus =
    manifest.hourStatus && typeof manifest.hourStatus === "object" ? { ...manifest.hourStatus } : {};
  const expectedOpenDataModel = manifest.openDataModel || MODEL_CONFIG[modelKey]?.openDataModel || "";
  for (const frame of manifest.frames) {
    const hourKey = String(frame.hour);
    const complete = await runtime.isFrameComplete(modelKey, runId, viewKey, frame, {
      expectedOpenDataModel,
      expectedRendererSignature: undefined,
    });
    if (complete) {
      manifest.hourStatus[hourKey] = "loaded";
      await runtime.refreshFrameArtifactBytes(frame);
    } else if (manifest.hourStatus[hourKey] === "error" || manifest.hourStatus[hourKey] === "unavailable") {
      continue;
    } else {
      manifest.hourStatus[hourKey] = "pending";
    }
  }
  return manifest;
}

test("applyManifestArtifactCompleteness matches the sequential per-key sweep byte-for-byte", async () => {
  const { runtime } = await makeTempRuntime();
  const manifest = buildManifestTemplate({
    modelKey: MODEL,
    viewKey: VIEW,
    runId: RUN,
    referenceTime: REFERENCE_TIME,
    validTimes: [0, 1, 2, 3].map((hour) => new Date(Date.parse(REFERENCE_TIME) + hour * 3_600_000).toISOString()),
    renderWidth: 8,
    renderHeight: 6,
    reflectivityGates: [10, 15, 20],
    forecastHours: [0, 1, 2, 3],
  });
  const [completeA, errorFrame, pendingFrame, completeB] = manifest.frames;
  completeA.hoverGridSupplemental = supplementalRefs(completeA);
  completeB.hoverGridSupplemental = supplementalRefs(completeB);
  await writeFrameArtifacts(runtime, completeA, { markerAvailability: { temperature: "available" } });
  await writeFrameArtifacts(runtime, completeB);
  await writeFrameArtifacts(runtime, errorFrame, { omitKeys: [collectFrameArtifactKeys(errorFrame)[2]] });
  await writeFrameArtifacts(runtime, pendingFrame, { marker: false });
  manifest.hourStatus = { 0: "pending", 1: "error", 2: "pending", 3: "pending" };

  const swept = await runtime.applyManifestArtifactCompleteness(MODEL, RUN, VIEW, structuredClone(manifest));
  const oracle = await applyCompletenessSequentially(runtime, MODEL, RUN, VIEW, structuredClone(manifest));
  assert.deepEqual(swept, oracle);
  assert.equal(JSON.stringify(swept), JSON.stringify(oracle), "swept manifest is byte-identical");
  assert.deepEqual(swept.hourStatus, { 0: "loaded", 1: "error", 2: "pending", 3: "loaded" });
  assert.deepEqual(swept.frames[0].parameterAvailability, { temperature: "available" });
});

// The pre-change build-end check, kept as the differential oracle: sequential
// with early exit on the first incomplete frame.
async function areFramesCompleteSequentially(runtime, state, frames) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return false;
  }
  for (const frame of frames) {
    if (!(await runtime.isFrameCompleteForState(state, frame))) {
      return false;
    }
  }
  return true;
}

function stateStub() {
  return {
    modelKey: MODEL,
    runId: RUN,
    viewKey: VIEW,
    latestMetadata: {
      openDataModel: MODEL_CONFIG[MODEL].openDataModel,
      rendererSignature: SIGNATURE,
    },
  };
}

test("areFramesCompleteForState preserves the early-exit mutation window", async () => {
  const { runtime } = await makeTempRuntime();
  const frames = [buildFrame(0), buildFrame(1), buildFrame(2)];
  await writeFrameArtifacts(runtime, frames[0], { markerAvailability: { capeJkg: "available" } });
  await writeFrameArtifacts(runtime, frames[1], {
    omitKeys: [collectFrameArtifactKeys(frames[1])[1]],
    markerAvailability: { mlcape: "unavailable" },
  });
  await writeFrameArtifacts(runtime, frames[2], { markerAvailability: { gust: "available" } });
  const state = stateStub();
  const oracleFrames = frames.map((frame) => structuredClone(frame));

  const indexedResult = await runtime.areFramesCompleteForState(state, frames);
  const oracleResult = await areFramesCompleteSequentially(runtime, state, oracleFrames);

  assert.equal(indexedResult, false);
  assert.equal(oracleResult, false);
  assert.deepEqual(frames, oracleFrames, "parallel probe + ordered merge replays the sequential mutations");
  // The exact window: frames through the first incomplete frame inclusive get
  // the marker merge; frames after it stay untouched.
  assert.deepEqual(
    frames.map((frame) => frame.parameterAvailability),
    [{ capeJkg: "available" }, { mlcape: "unavailable" }, {}],
  );
});

test("areFramesCompleteForState agrees with the sequential path when all frames are complete", async () => {
  const { runtime } = await makeTempRuntime();
  const frames = [buildFrame(0), buildFrame(1), buildFrame(2)];
  for (const frame of frames) {
    await writeFrameArtifacts(runtime, frame, { markerAvailability: { capeJkg: "available" } });
  }
  const state = stateStub();
  const oracleFrames = frames.map((frame) => structuredClone(frame));

  const indexed = await runtime.areFramesCompleteForState(state, frames);
  const oracle = await areFramesCompleteSequentially(runtime, state, oracleFrames);

  assert.equal(indexed, true);
  assert.equal(oracle, true);
  assert.deepEqual(frames, oracleFrames);
  assert.deepEqual(
    frames.map((frame) => frame.parameterAvailability),
    [{ capeJkg: "available" }, { capeJkg: "available" }, { capeJkg: "available" }],
  );
});

test("areFramesCompleteForState stops after one bounded batch when F000 is incomplete", async () => {
  const concurrency = 8;
  const runtime = createRuntime(path.join(os.tmpdir(), "modelview-completeness-batch-test"), {
    completenessSweepConcurrency: concurrency,
  });
  const frames = Array.from({ length: 209 }, (_, hour) => ({ hour, parameterAvailability: {} }));
  const probedHours = [];
  let active = 0;
  let maximumActive = 0;
  runtime.probeFrameComplete = async (_modelKey, _runId, _viewKey, frame) => {
    probedHours.push(frame.hour);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return {
      complete: frame.hour !== 0,
      availabilityMarker: { parameterAvailability: { temperature: "available" } },
    };
  };

  const result = await runtime.areFramesCompleteForState(stateStub(), frames);

  assert.equal(result, false);
  assert.deepEqual(
    probedHours,
    Array.from({ length: concurrency }, (_, hour) => hour),
  );
  assert.equal(maximumActive, concurrency, "the bounded batch still probes in parallel");
  assert.deepEqual(frames[0].parameterAvailability, { temperature: "available" });
  assert.deepEqual(
    frames[1].parameterAvailability,
    {},
    "frames after the first miss retain the sequential mutation window",
  );
  assert.ok(probedHours.length < frames.length, "an F000 miss never scans the remaining GFS horizon");
});
