"use strict";

const { LocalArtifactRuntime } = require("../../scripts/lib/local-artifact-runtime");
const { NOAA_BETA_SOURCE_NAME } = require("../../scripts/lib/noaa-beta-renderer");

const [cacheRoot, extension, bodyText] = process.argv.slice(2);
const runId = "20260716-1300Z";
const validHourKey = "2026-07-16T13:00:00Z";

const runtime = new LocalArtifactRuntime({ cacheRoot, sourceName: NOAA_BETA_SOURCE_NAME });
const frame = {
  hour: 0,
  validHourKey,
  rows: 1,
  cols: 1,
  hoverGridKey: `tiles/hrrr/${runId}/conus/000/hover-grid.bin.${extension}`,
  hoverGridBytes: 0,
  hoverGridSchemaVersion: 3,
  hoverGridSupplemental: {},
  layers: {},
  reflectivityVariants: {},
  reflectivityVariantsByLayer: {},
  contourVectorRefs: {},
  weatherVectorRefs: {},
};
const state = {
  modelKey: "hrrr",
  runId,
  viewKey: "conus",
  framePlanByHour: new Map([[0, { hour: 0, validTime: validHourKey }]]),
  frameByHour: new Map([[0, frame]]),
  latestMetadata: {
    openDataModel: "noaa-hrrr-wrfprs",
    runPath: "hrrr.20260716/conus",
    rendererSignature: `codec-race-${extension}`,
  },
  manifest: {
    schemaVersion: 4,
    model: "hrrr",
    run: runId,
    view: "conus",
    frames: [frame],
    hourStatus: { 0: "pending" },
  },
  latestPointer: { model: "hrrr", run: runId, view: "conus", frameCount: 1 },
};

process.send?.({ type: "ready" });
process.once("message", async (message) => {
  if (message?.type !== "go") return;
  try {
    await runtime.persistFrameArtifacts(
      state,
      frame,
      {
        layers: {},
        hoverGrid: {
          body: Buffer.from(bodyText),
          bytes: Buffer.byteLength(bodyText),
          contentEncoding: extension === "br" ? "br" : "gzip",
          schemaVersion: 3,
        },
        hoverGridSchemaVersion: 3,
        renderProfile: {},
      },
      { persistManifestEachFrame: true },
    );
    process.send?.({ type: "done" });
    process.disconnect?.();
  } catch (error) {
    process.send?.({ type: "error", error: String(error?.stack || error) });
    process.exitCode = 1;
    process.disconnect?.();
  }
});
