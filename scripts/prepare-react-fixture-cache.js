#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_CACHE_ROOT = path.join(ROOT_DIR, "test-results/react-cache");
const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==",
  "base64",
);
const MODELS = {
  gfs: "noaa-gfs-pgrb2-0p25",
  nam: "noaa-nam-awphys",
  nam3km: "noaa-nam-conusnest",
  hrrr: "noaa-hrrr-wrfprs",
};
const RUN_ID = "20260423-1200Z";
const VIEW = "conus";
const ARTIFACT_PREFIX = "tiles";

async function main() {
  const cacheRoot = path.resolve(process.argv[2] || process.env.MODELVIEW_CACHE_ROOT || DEFAULT_CACHE_ROOT);
  const artifactRoot = path.join(cacheRoot, "artifacts");
  await fs.promises.rm(artifactRoot, { recursive: true, force: true });
  for (const [model, openDataModel] of Object.entries(MODELS)) {
    await writeModelFixture(artifactRoot, model, openDataModel);
  }
  console.log(`Prepared React fixture NOAA cache at ${cacheRoot}`);
}

async function writeModelFixture(artifactRoot, model, openDataModel) {
  const frames = [0, 3].map((hour) => buildFrame(model, openDataModel, hour));
  for (const frame of frames) {
    await writeFrameArtifacts(artifactRoot, frame);
  }

  const manifest = {
    schemaVersion: 4,
    model,
    run: RUN_ID,
    view: VIEW,
    generatedAt: "2026-04-23T12:10:00Z",
    source: "noaa-grib2-beta",
    referenceTime: "2026-04-23T12:00:00Z",
    openDataModel,
    rendererSignature: "fixture-noaa-renderer",
    parameterOrder: ["temperature", "wind", "precip", "reflectivityComposite", "reflectivity1kmPrecipType"],
    hourStatus: { 0: "loaded", 3: "loaded" },
    frames,
  };
  const latest = {
    model,
    run: RUN_ID,
    view: VIEW,
    generatedAt: manifest.generatedAt,
    manifestKey: `manifests/${model}/${RUN_ID}.json?view=${VIEW}`,
    frameCount: frames.length,
  };
  await writeJson(path.join(artifactRoot, "manifests", model, `${RUN_ID}--${VIEW}.json`), manifest);
  await writeJson(path.join(artifactRoot, "manifests", model, `latest--${VIEW}.json`), latest);
}

function buildFrame(model, openDataModel, hour) {
  const padded = String(hour).padStart(3, "0");
  const frameBase = `${ARTIFACT_PREFIX}/${model}/${RUN_ID}/${VIEW}/${padded}`;
  const validHourKey = hour === 0 ? "2026-04-23T12:00:00Z" : "2026-04-23T15:00:00Z";
  const layerRef = (name) => ({
    key: `${frameBase}/${name}`,
    bytes: ONE_BY_ONE_PNG.length,
    contentType: "image/png",
    url: null,
  });
  const jsonRef = (name, bytes = 2) => ({
    key: `${frameBase}/${name}`,
    bytes,
    contentType: "application/json",
    url: null,
  });
  const reflectivityVariants = {
    dbz10: layerRef("reflectivity-composite-g10.png"),
    dbz15: layerRef("reflectivity-composite-g15.png"),
    dbz20: layerRef("reflectivity-composite-g20.png"),
  };
  const reflectivity1kmVariants = {
    dbz10: layerRef("reflectivity-1km-g10.png"),
    dbz15: layerRef("reflectivity-1km-g15.png"),
    dbz20: layerRef("reflectivity-1km-g20.png"),
  };
  return {
    hour,
    validHourKey,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    cols: 1600,
    rows: 980,
    modelToken: openDataModel,
    referenceTime: "2026-04-23T12:00:00Z",
    synopticCenters: { highs: [], lows: [] },
    synopticVectorKeys: {
      simple: `${frameBase}/synoptic-vector-simple.json`,
      detailed: `${frameBase}/synoptic-vector-detailed.json`,
    },
    synopticVectorBytes: { simple: 2, detailed: 2 },
    synopticStyleVersions: { simple: "v4-operational-contrast", detailed: "v4-operational-contrast" },
    contourVectorRefs: {},
    weatherVectorRefs: {},
    pressureUploadMeta: {
      source: "om-grid",
      inputRows: 980,
      inputCols: 1600,
      hoverRows: 980,
      hoverCols: 1600,
      fullResolutionInput: true,
    },
    hoverGridKey: `${frameBase}/hover-grid.json.gz`,
    hoverGridBytes: hoverGridBody().length,
    hoverGridSchemaVersion: 1,
    layers: {
      temperature: layerRef("temperature.png"),
      wind: layerRef("wind.png"),
      precip: layerRef("precip.png"),
      synoptic: layerRef("synoptic.png"),
      reflectivityComposite: reflectivityVariants.dbz15,
      reflectivity1km: reflectivity1kmVariants.dbz15,
      reflectivity1kmPrecipType: layerRef("reflectivity1kmPrecipType.png"),
      reflectivity: reflectivityVariants.dbz15,
    },
    reflectivityVariants,
    reflectivityVariantsByLayer: {
      reflectivityComposite: reflectivityVariants,
      reflectivity1km: reflectivity1kmVariants,
    },
    _jsonRefs: [jsonRef("synoptic-vector-simple.json"), jsonRef("synoptic-vector-detailed.json")],
  };
}

async function writeFrameArtifacts(artifactRoot, frame) {
  for (const ref of Object.values(frame.layers)) {
    await writeBuffer(path.join(artifactRoot, ref.key), ONE_BY_ONE_PNG);
  }
  for (const variants of Object.values(frame.reflectivityVariantsByLayer)) {
    for (const ref of Object.values(variants)) {
      await writeBuffer(path.join(artifactRoot, ref.key), ONE_BY_ONE_PNG);
    }
  }
  for (const ref of frame._jsonRefs) {
    await writeJson(path.join(artifactRoot, ref.key), {});
  }
  await writeBuffer(path.join(artifactRoot, frame.hoverGridKey), hoverGridBody());
  await writeJson(path.join(artifactRoot, path.dirname(frame.hoverGridKey), ".complete.json"), {
    renderedAt: "2026-04-23T12:10:00Z",
    modelKey: frame.modelToken,
    viewKey: VIEW,
    runId: RUN_ID,
    hour: frame.hour,
    validTime: frame.validHourKey,
    openDataModel: frame.modelToken,
    rendererSignature: "fixture-noaa-renderer",
  });
  delete frame._jsonRefs;
}

function hoverGridBody() {
  const encoded = Buffer.from(Int16Array.from([50]).buffer).toString("base64");
  return zlib.gzipSync(
    Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        rows: 1,
        cols: 1,
        variables: {
          temperatureF: { scale: 1, offset: 0, missing: -32768, data: encoded },
          windKt: { scale: 1, offset: 0, missing: -32768, data: encoded },
          precipMm: { scale: 1, offset: 0, missing: -32768, data: encoded },
          pressureHpa: { scale: 1, offset: 950, missing: -32768, data: encoded },
        },
      }),
    ),
  );
}

async function writeJson(filePath, payload) {
  await writeBuffer(filePath, Buffer.from(JSON.stringify(payload)));
}

async function writeBuffer(filePath, body) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, body);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
