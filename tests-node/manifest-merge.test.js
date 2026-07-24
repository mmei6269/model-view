"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  applyRenderedFrameToManifestFrame,
  mergeManifestWithTemplate,
} = require("../scripts/lib/local-artifact-manifest");
const { buildManifestTemplate } = require("../scripts/lib/modelview-runtime");
const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
const { buildLatestStatesWithGlobalFrameQueue } = require("../scripts/lib/noaa-build/frame-queue");
const { buildNoaaNamMetadata } = require("../scripts/lib/noaa-build/run-resolution");

const RUN_ID = "20260425-1200Z";
const REFERENCE_TIME = "2026-04-25T12:00:00Z";
const VALID_TIMES = ["2026-04-25T12:00:00Z", "2026-04-25T15:00:00Z", "2026-04-25T18:00:00Z"];

function buildTemplateForHours(hourCount) {
  return buildManifestTemplate({
    modelKey: "nam",
    viewKey: "conus",
    runId: RUN_ID,
    referenceTime: REFERENCE_TIME,
    validTimes: VALID_TIMES.slice(0, hourCount),
    renderWidth: 4,
    renderHeight: 3,
  });
}

function createRuntime(cacheRoot, metadata, renderFrameArtifacts = async () => null) {
  return new LocalArtifactRuntime({
    cacheRoot,
    renderWidth: 4,
    renderHeight: 3,
    fetchLatestMetadata: async () => metadata,
    renderFrameArtifacts,
  });
}

test("manifest merge keeps existing run frames when a partial-hours template arrives", () => {
  const existing = JSON.parse(JSON.stringify(buildTemplateForHours(3)));
  existing.generatedAt = "2026-04-25T13:00:00Z";
  existing.hourStatus = { 0: "loaded", 3: "loaded", 6: "loaded" };
  existing.frames[0].layers.temperature.bytes = 555;
  existing.frames[0].layers.temperature.key = "stale/moved/temperature.png";
  existing.frames[2].layers.temperature.bytes = 1234;
  existing.frames[2].hoverGridBytes = 777;

  const partialTemplate = buildTemplateForHours(2);
  const merged = mergeManifestWithTemplate(existing, partialTemplate);

  assert.deepEqual(
    merged.frames.map((frame) => frame.hour),
    [0, 3, 6],
  );
  assert.deepEqual(merged.hourStatus, { 0: "loaded", 3: "loaded", 6: "loaded" });
  // Rebuilt hours take the template frame (new refs win) with existing byte counts carried over.
  assert.equal(merged.frames[0].layers.temperature.key, partialTemplate.frames[0].layers.temperature.key);
  assert.equal(merged.frames[0].layers.temperature.bytes, 555);
  // Hours absent from the template keep their stored frame records verbatim.
  assert.deepEqual(merged.frames[2], existing.frames[2]);
  assert.equal(merged.frames[2].hoverGridBytes, 777);
  assert.equal(merged.generatedAt, existing.generatedAt);
});

test("manifest merge replaces the frame set when the run changes", () => {
  const existing = JSON.parse(JSON.stringify(buildTemplateForHours(3)));
  const otherRunTemplate = buildManifestTemplate({
    modelKey: "nam",
    viewKey: "conus",
    runId: "20260425-1800Z",
    referenceTime: "2026-04-25T18:00:00Z",
    validTimes: ["2026-04-25T18:00:00Z"],
    renderWidth: 4,
    renderHeight: 3,
  });
  assert.equal(mergeManifestWithTemplate(existing, otherRunTemplate), otherRunTemplate);
});

test("manifest merge drops stored frames whose hour field is null/undefined (malformed-frame guard)", () => {
  const existing = JSON.parse(JSON.stringify(buildTemplateForHours(2)));
  existing.generatedAt = "2026-04-25T13:00:00Z";
  existing.hourStatus = { 0: "loaded", 3: "loaded" };
  // Inject a malformed frame that has no hour property.
  existing.frames.push({ validHourKey: "2026-04-25T21:00:00Z", layers: {}, hoverGridBytes: 0 });

  const partialTemplate = buildTemplateForHours(1); // only hour 0
  const merged = mergeManifestWithTemplate(existing, partialTemplate);

  // The malformed frame (hour == undefined → NaN) must be dropped.
  assert.ok(
    merged.frames.every((frame) => frame.hour != null),
    "merged frames must all have a defined hour",
  );
  // Valid stored frames that are not covered by the template (hour 3) survive.
  assert.deepEqual(
    merged.frames.map((frame) => frame.hour),
    [0, 3],
  );
});

test("manifest merge with absent/empty existing manifest returns exactly the template frames", () => {
  const template = buildTemplateForHours(3);

  // Case 1: existingManifest is null (file missing entirely).
  const mergedNull = mergeManifestWithTemplate(null, template);
  assert.equal(mergedNull, template);

  // Case 2: existing manifest has frames: [] (empty).
  const emptyExisting = { ...JSON.parse(JSON.stringify(template)), frames: [] };
  const mergedEmpty = mergeManifestWithTemplate(emptyExisting, template);
  assert.deepEqual(
    mergedEmpty.frames.map((frame) => frame.hour),
    template.frames.map((frame) => frame.hour),
  );
  assert.equal(mergedEmpty.frames.length, template.frames.length);
});

test("manifest merge preserves explicit unknown hover schema identities for base and supplemental refs", () => {
  const existing = JSON.parse(JSON.stringify(buildTemplateForHours(1)));
  const template = buildTemplateForHours(1);
  existing.frames[0].hoverGridBytes = 321;
  existing.frames[0].hoverGridSchemaVersion = 0;
  existing.frames[0].hoverGridSupplemental = {
    legacy: {
      key: "tiles/nam/existing/hover-grid-legacy.bin.gz",
      bytes: 123,
      schemaVersion: 0,
    },
  };
  template.frames[0].hoverGridSchemaVersion = 4;
  template.frames[0].hoverGridSupplemental = {
    legacy: {
      key: "tiles/nam/template/hover-grid-legacy.bin.br",
      bytes: 456,
      schemaVersion: 4,
    },
  };

  const frame = mergeManifestWithTemplate(existing, template).frames[0];
  assert.equal(frame.hoverGridBytes, 321);
  assert.equal(frame.hoverGridSchemaVersion, 0);
  assert.deepEqual(frame.hoverGridSupplemental.legacy, {
    key: "tiles/nam/existing/hover-grid-legacy.bin.gz",
    bytes: 123,
    schemaVersion: 0,
  });
});

test("manifest merge keeps absent and null persisted hover schemas unknown", () => {
  for (const schemaState of ["absent", "null"]) {
    const existing = JSON.parse(JSON.stringify(buildTemplateForHours(1)));
    const template = buildTemplateForHours(1);
    existing.frames[0].hoverGridBytes = 321;
    existing.frames[0].hoverGridSupplemental = {
      legacy: {
        key: `tiles/nam/existing/hover-grid-${schemaState}.bin.gz`,
        bytes: 123,
        schemaVersion: null,
      },
    };
    if (schemaState === "absent") {
      delete existing.frames[0].hoverGridSchemaVersion;
      delete existing.frames[0].hoverGridSupplemental.legacy.schemaVersion;
    } else {
      existing.frames[0].hoverGridSchemaVersion = null;
    }
    template.frames[0].hoverGridSchemaVersion = 4;
    template.frames[0].hoverGridSupplemental = {
      legacy: {
        key: "tiles/nam/template/hover-grid-current.bin.br",
        bytes: 456,
        schemaVersion: 4,
      },
    };

    const frame = mergeManifestWithTemplate(existing, template).frames[0];
    assert.equal(frame.hoverGridBytes, 321, schemaState);
    assert.equal(frame.hoverGridSchemaVersion, null, schemaState);
    assert.equal(frame.hoverGridSupplemental.legacy.schemaVersion, null, schemaState);
    assert.equal(frame.hoverGridSupplemental.legacy.key, `tiles/nam/existing/hover-grid-${schemaState}.bin.gz`);
    assert.equal(frame.hoverGridSupplemental.legacy.bytes, 123);
  }
});

test("manifest merge rejects malformed base and supplemental hover schema identities", () => {
  for (const invalid of [-1, 5, 1.5, "3", NaN]) {
    const existingBase = JSON.parse(JSON.stringify(buildTemplateForHours(1)));
    const templateBase = buildTemplateForHours(1);
    existingBase.frames[0].hoverGridSchemaVersion = invalid;
    assert.throws(
      () => mergeManifestWithTemplate(existingBase, templateBase),
      /integer hover schema identity from 0 through 4/,
    );

    const existingSupplemental = JSON.parse(JSON.stringify(buildTemplateForHours(1)));
    const templateSupplemental = buildTemplateForHours(1);
    existingSupplemental.frames[0].hoverGridSupplemental = {
      invalid: {
        key: "tiles/nam/existing/hover-grid-invalid.bin.gz",
        bytes: 123,
        schemaVersion: invalid,
      },
    };
    assert.throws(
      () => mergeManifestWithTemplate(existingSupplemental, templateSupplemental),
      /integer hover schema identity from 0 through 4/,
    );
  }
});

test("supplemental application defaults new producer refs while preserving unknown persisted refs", () => {
  const frame = buildTemplateForHours(1).frames[0];
  const activeSchemaVersion = frame.hoverGridSchemaVersion;
  frame.hoverGridSupplemental = {
    persisted: { key: "tiles/nam/persisted.bin.gz", bytes: 10 },
    replaced: { key: "tiles/nam/old.bin.gz", bytes: 11 },
  };
  applyRenderedFrameToManifestFrame(frame, {
    hoverGridSupplemental: {
      replaced: { key: "tiles/nam/new.bin.br", bytes: 12 },
      produced: { key: "tiles/nam/produced.bin.br", bytes: 13 },
    },
    layers: {},
    reflectivityVariants: {},
    reflectivityVariantsByLayer: {},
  });

  assert.deepEqual(frame.hoverGridSupplemental, {
    persisted: { key: "tiles/nam/persisted.bin.gz", bytes: 10, schemaVersion: null },
    replaced: { key: "tiles/nam/new.bin.br", bytes: 12, schemaVersion: activeSchemaVersion },
    produced: { key: "tiles/nam/produced.bin.br", bytes: 13, schemaVersion: activeSchemaVersion },
  });
});

test("NOAA partial-hours rebuilds keep previously rendered frames in the run manifest", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-manifest-merge-"));
  const run = { date: "20260425", cycle: "12" };

  const fullRuntime = createRuntime(tempDir, buildNoaaNamMetadata({ modelKey: "nam", run, hours: [0, 3, 6] }));
  await fullRuntime.init();
  const fullSummary = await fullRuntime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });
  assert.equal(fullSummary.frameCount, 3);

  const partialRuntime = createRuntime(tempDir, buildNoaaNamMetadata({ modelKey: "nam", run, hours: [0, 3] }));
  await partialRuntime.init();
  const partialSummary = await partialRuntime.buildLatestState("nam", "conus", {
    frameRetries: 0,
    frameConcurrency: 1,
  });
  assert.equal(partialSummary.frameCount, 2);
  assert.equal(partialSummary.built, 0);
  assert.equal(partialSummary.reused, 2);

  const manifest = await partialRuntime.readManifestFromDisk("nam", RUN_ID, "conus");
  assert.deepEqual(
    manifest.frames.map((frame) => frame.hour),
    [0, 3, 6],
  );
  assert.deepEqual(Object.keys(manifest.hourStatus).sort(), ["0", "3", "6"]);
  assert.equal(manifest.hourStatus["6"], "loaded");
  assert.ok(manifest.frames[2].hoverGridBytes > 0);

  const queueRuntime = createRuntime(tempDir, buildNoaaNamMetadata({ modelKey: "nam", run, hours: [0] }));
  await queueRuntime.init();
  const [queueSummary] = await buildLatestStatesWithGlobalFrameQueue(queueRuntime, ["nam"], "conus", {
    frameConcurrency: 1,
    frameRetries: 0,
  });
  assert.equal(queueSummary.frameCount, 1);
  const queueManifest = await queueRuntime.readManifestFromDisk("nam", RUN_ID, "conus");
  assert.deepEqual(
    queueManifest.frames.map((frame) => frame.hour),
    [0, 3, 6],
  );
  assert.equal(queueManifest.hourStatus["3"], "loaded");
  assert.equal(queueManifest.hourStatus["6"], "loaded");
});
