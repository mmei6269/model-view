"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
const { buildLatestStatesWithGlobalFrameQueue } = require("../scripts/lib/noaa-build/frame-queue");
const {
  buildNoaaModelMetadata,
  filterNoaaParameterSetByRenderSelection,
} = require("../scripts/lib/noaa-build/run-resolution");
const { parseRenderSelectionFromArgs } = require("../scripts/lib/noaa-build/render-selection-args");
const { NOAA_NAM_PARAMETER_CATALOG, getNoaaNamParameterOrder } = require("../scripts/lib/noaa-nam-parameter-catalog");

const CATEGORY_BY_KEY = new Map(NOAA_NAM_PARAMETER_CATALOG.map((entry) => [entry.key, entry.category]));
// buildFrameAssetKeySet always appends the legacy layer floor regardless of the
// parameter set ("no schema change for omission"), so these keys are expected
// in every manifest frame even for a selective build.
const LEGACY_FALLBACK_LAYER_KEYS = new Set(["temperature", "wind", "precip", "synoptic", "reflectivity"]);

function surfaceOnlySelection() {
  return parseRenderSelectionFromArgs({ categories: "surface" }, { models: ["nam"], view: "conus", run: "latest" });
}

// Drives the REAL frame queue + REAL LocalArtifactRuntime end-to-end (metadata
// -> manifest template -> render dispatch -> persisted manifest on disk) with
// only the frame renderer stubbed, exactly mirroring how the builder wires the
// runtime. This is the regression net for the CLI-flag plumbing: deleting any
// renderSelection hop (metadata stamp, frame-queue forward, renderParams) makes
// these assertions fail.
async function runStubBuild(renderSelection) {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "render-selection-wiring-"));
  const renderCalls = [];
  const metadata = buildNoaaModelMetadata({
    modelKey: "nam",
    run: { date: "20260701", cycle: "00" },
    hours: [0],
    noaaBaseUrl: "https://example.invalid/nam",
    renderSelection,
  });
  const runtime = new LocalArtifactRuntime({
    cacheRoot,
    sourceName: "noaa-beta-test",
    renderWidth: 8,
    renderHeight: 8,
    fetchLatestMetadata: async () => metadata,
    renderFrameArtifacts: async (params) => {
      renderCalls.push(params);
      return {};
    },
  });
  await runtime.init();
  const results = await buildLatestStatesWithGlobalFrameQueue(runtime, ["nam"], "conus", {
    renderSelection,
    frameConcurrency: 1,
    frameRetries: 0,
  });
  const manifestPath = path.join(cacheRoot, "artifacts", "manifests", "nam", `${metadata.runId}--conus.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.rmSync(cacheRoot, { recursive: true, force: true });
  return { results, renderCalls, manifest, metadata };
}

test("--categories=surface flows end-to-end: render call gets the selection, manifest is surface-only + stamped", async () => {
  const selection = surfaceOnlySelection();
  const { results, renderCalls, manifest } = await runStubBuild(selection);

  assert.equal(results[0].built, 1, "the single frame renders");
  assert.equal(results[0].failed, 0);

  // 1. The render dispatch receives the parsed selection (not null, not a copy-mangled shape).
  assert.equal(renderCalls.length, 1, "exactly one frame render call");
  assert.deepEqual(renderCalls[0].renderSelection, selection, "renderParams carry the parsed selection");
  assert.equal(renderCalls[0].renderMode, "all");

  // 2. The persisted manifest records the intent.
  assert.ok(manifest.renderSelection, "manifest carries the renderSelection stamp");
  assert.equal(manifest.renderSelection.categories.surface.enabled, true);
  assert.equal(manifest.renderSelection.categories.winter.enabled, false);
  assert.equal(manifest.renderSelection.categories.severe.enabled, false);
  assert.ok(Date.parse(manifest.renderSelection.builtAt), "builtAt stamped");

  // 3. The persisted manifest layer plan is surface-only (plus the legacy floor).
  const expectedSurfaceKeys = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.category === "surface").map(
    (entry) => entry.key,
  );
  assert.deepEqual(manifest.parameterOrder, expectedSurfaceKeys, "parameterOrder is surface-only, catalog order");
  const frame = manifest.frames[0];
  for (const layerKey of Object.keys(frame.layers)) {
    const category = CATEGORY_BY_KEY.get(layerKey);
    assert.ok(
      category === "surface" || LEGACY_FALLBACK_LAYER_KEYS.has(layerKey),
      `unexpected non-surface layer '${layerKey}' (category ${category || "none"})`,
    );
  }
  for (const droppedKey of ["sbcape", "snowDepth", "cloudCover", "height850", "reflectivityComposite"]) {
    assert.equal(droppedKey in frame.layers, false, `dropped category layer '${droppedKey}' must be absent`);
  }
  assert.deepEqual(frame.contourVectorRefs, {}, "upper-air contour refs absent for a surface-only build");
});

test("no flags (null selection) keeps today's manifest and passes null to the renderer", async () => {
  const { results, renderCalls, manifest, metadata } = await runStubBuild(null);

  assert.equal(results[0].built, 1);
  assert.equal(renderCalls.length, 1);
  assert.equal(renderCalls[0].renderSelection, null, "null selection reaches the renderer unchanged");

  assert.equal("renderSelection" in metadata, false, "null selection adds no metadata key");
  assert.equal("renderSelection" in manifest, false, "null selection stamps nothing");
  assert.deepEqual(manifest.parameterOrder, getNoaaNamParameterOrder(), "full parameter order preserved");
  const frame = manifest.frames[0];
  for (const presentKey of ["sbcape", "snowDepth", "cloudCover", "height850", "reflectivityComposite"]) {
    assert.equal(presentKey in frame.layers, true, `default build keeps layer '${presentKey}'`);
  }
});

test("filterNoaaParameterSetByRenderSelection: null and all-on selections return identical inputs", () => {
  const parameters = { temperature: { label: "T" }, sbcape: { label: "CAPE" } };
  const parameterOrder = ["temperature", "sbcape"];
  const nullResult = filterNoaaParameterSetByRenderSelection({ parameters, parameterOrder }, null);
  assert.equal(nullResult.parameters, parameters, "null selection: same parameters reference");
  assert.equal(nullResult.parameterOrder, parameterOrder, "null selection: same order reference");

  const allOn = parseRenderSelectionFromArgs(
    { categories: "surface,precip,radar,cloud,severe,winter,upperAir" },
    { models: ["nam"], view: "conus", run: "latest" },
  );
  const allOnResult = filterNoaaParameterSetByRenderSelection({ parameters, parameterOrder }, allOn);
  assert.equal(allOnResult.parameters, parameters, "all-on selection: same parameters reference");
  assert.equal(allOnResult.parameterOrder, parameterOrder, "all-on selection: same order reference");
});

test("buildNoaaModelMetadata stamps renderSelection and filters tiered keys (severe simple drops dcape)", () => {
  const selection = parseRenderSelectionFromArgs(
    { categories: "severe", "severe-tier": "simple" },
    { models: ["nam"], view: "conus", run: "latest" },
  );
  const metadata = buildNoaaModelMetadata({
    modelKey: "nam",
    run: { date: "20260701", cycle: "00" },
    hours: [0],
    noaaBaseUrl: "https://example.invalid/nam",
    renderSelection: selection,
  });
  assert.equal(metadata.renderSelection, selection, "metadata carries the selection for the manifest stamp");
  assert.equal(metadata.parameterOrder.includes("sbcape"), true, "simple severe keeps cheap severe keys");
  assert.equal(metadata.parameterOrder.includes("dcape"), false, "simple severe drops full-tier dcape");
  assert.equal(metadata.parameterOrder.includes("temperature"), false, "off categories drop out");
  assert.deepEqual(metadata.parameterKeys, metadata.parameterOrder);
  assert.equal("dcape" in metadata.parameters, false, "parameters map filtered in lockstep");
});
