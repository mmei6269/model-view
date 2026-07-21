#!/usr/bin/env node
"use strict";

// Reproducible proxy benchmark for the MapLibre shared-GeoJSON-source change.
// MapLibre performs structured cloning and worker-side indexing rather than
// JSON.stringify, so these timings are not browser render times. They isolate
// the duplicate geometry volume that the old per-style-layer sources sent to
// MapLibre and report the exact source-count reduction on checked-in fixtures.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SYNOPTIC_FIXTURE = path.join(ROOT, "tests-node/fixtures/synoptic-vector-simple.nam3km-20260707-1800Z-f020.json");
const HEIGHT_FIXTURE = path.join(ROOT, "tests-node/fixtures/height500-contours.nam3km-20260707-1800Z-f020.json");

function loadSynopticGeoJsonModule() {
  const entry = path.join(ROOT, "next/src/components/map-panel/synoptic-geojson.ts");
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const moduleShim = { exports: {} };
  const wrapper = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  wrapper(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function combinedCollection(collections) {
  return {
    type: "FeatureCollection",
    features: collections.flatMap((collection) => collection.features),
  };
}

function serializedBytes(collections) {
  return collections.reduce((sum, collection) => sum + Buffer.byteLength(JSON.stringify(collection)), 0);
}

function benchmarkSerialization(collections, { repetitions = 9, iterations = 200 } = {}) {
  let sink = 0;
  const run = () => {
    for (const collection of collections) {
      sink += JSON.stringify(collection).length;
    }
  };
  for (let warm = 0; warm < 20; warm += 1) {
    run();
  }
  const samplesMs = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      run();
    }
    samplesMs.push((performance.now() - started) / iterations);
  }
  samplesMs.sort((left, right) => left - right);
  return {
    iterationsPerRepetition: iterations,
    repetitions,
    medianMs: quantileSorted(samplesMs, 0.5),
    p95Ms: quantileSorted(samplesMs, 0.95),
    minMs: samplesMs[0],
    maxMs: samplesMs.at(-1),
    samplesMs,
    sink,
  };
}

function quantileSorted(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function summarizeFamily(name, oldSources, sharedSources) {
  const oldTiming = benchmarkSerialization(oldSources);
  const sharedTiming = benchmarkSerialization(sharedSources);
  const oldBytes = serializedBytes(oldSources);
  const sharedBytes = serializedBytes(sharedSources);
  return {
    name,
    sourceCount: {
      before: oldSources.length,
      after: sharedSources.length,
      removed: oldSources.length - sharedSources.length,
    },
    serializedGeometryBytesPerUpdateProxy: {
      before: oldBytes,
      after: sharedBytes,
      removed: oldBytes - sharedBytes,
      reductionFraction: oldBytes > 0 ? (oldBytes - sharedBytes) / oldBytes : 0,
    },
    stringifyProxyMsPerUpdate: {
      before: oldTiming,
      after: sharedTiming,
      medianSaved: oldTiming.medianMs - sharedTiming.medianMs,
      p95Saved: oldTiming.p95Ms - sharedTiming.p95Ms,
    },
  };
}

const geo = loadSynopticGeoJsonModule();
const synopticPayload = JSON.parse(fs.readFileSync(SYNOPTIC_FIXTURE, "utf8"));
const heightPayload = JSON.parse(fs.readFileSync(HEIGHT_FIXTURE, "utf8"));

const synopticCollections = geo.buildSynopticFeatureCollections(synopticPayload);
const splitSynoptic = geo.splitSynopticStyleClasses(synopticCollections);
const splitSynopticValues = Object.values(splitSynoptic);
const combinedSynoptic = combinedCollection([synopticCollections.thickness, synopticCollections.isobars]);
// Before consolidation: two isobar halo sources, seven line sources, and
// seven label sources. Line and label layers duplicated the same seven
// style-class collections.
const oldSynopticSources = [
  splitSynoptic.isobars,
  splitSynoptic.isobarsMajor,
  ...splitSynopticValues,
  ...splitSynopticValues,
];

const centerCollections = geo.buildSynopticCenterFeatureCollections(synopticPayload.centers);
const combinedCenters = combinedCollection([centerCollections.highs, centerCollections.lows]);

const heightCollection = geo.buildHeightContourFeatureCollection(heightPayload);
const splitHeight = geo.splitHeightContourClasses(heightCollection);
// Before consolidation: minor/major halos, minor/major cores, and labels.
const oldHeightSources = [splitHeight.minor, splitHeight.major, splitHeight.minor, splitHeight.major, heightCollection];

const families = [
  summarizeFamily("synoptic-lines-and-labels", oldSynopticSources, [combinedSynoptic]),
  summarizeFamily("synoptic-centers", [centerCollections.highs, centerCollections.lows], [combinedCenters]),
  summarizeFamily("one-height-contour-parameter", oldHeightSources, [heightCollection]),
];

process.stdout.write(
  `${JSON.stringify(
    {
      methodology: {
        fixtures: [path.relative(ROOT, SYNOPTIC_FIXTURE), path.relative(ROOT, HEIGHT_FIXTURE)],
        clock: "node:perf_hooks performance.now",
        proxy:
          "JSON serialization of each former/new source collection; MapLibre structured-clone and worker-index time is device-dependent and is not claimed by this benchmark",
      },
      families,
      commonStackSourceCount: {
        before: families.reduce((sum, family) => sum + family.sourceCount.before, 0),
        after: families.reduce((sum, family) => sum + family.sourceCount.after, 0),
      },
      commonStackSerializedBytesProxy: {
        before: families.reduce((sum, family) => sum + family.serializedGeometryBytesPerUpdateProxy.before, 0),
        after: families.reduce((sum, family) => sum + family.serializedGeometryBytesPerUpdateProxy.after, 0),
      },
    },
    null,
    2,
  )}\n`,
);
