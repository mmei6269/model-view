#!/usr/bin/env node

"use strict";

// Regenerates the legend fields of shared/modelview-config.json `layers.*`
// from the parameter catalog, so the frontend's no-manifest fallback legends
// can never drift from what the renderer actually paints. Only legend fields
// are touched; every other shared-config key passes through untouched.
// Guarded by tests-node/shared-legend-parity.test.js.

const fs = require("fs");
const path = require("path");
const { getNoaaNamParameterMetadata } = require("./lib/noaa-nam-parameter-catalog");

const CONFIG_PATH = path.resolve(__dirname, "../shared/modelview-config.json");

function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const metadata = getNoaaNamParameterMetadata();
  const layers = config.layers || {};
  const updated = [];
  const skipped = [];
  for (const key of Object.keys(layers)) {
    const entry = metadata[key];
    if (!entry) {
      // e.g. the legacy "reflectivity" alias — not a catalog parameter.
      skipped.push(key);
      continue;
    }
    layers[key] = {
      ...layers[key],
      label: entry.label,
      unit: entry.unit,
      thresholdNote: entry.thresholdNote ?? null,
      legendTicks: entry.legendTicks,
      legendTickPositions: entry.legendTickPositions,
      legendStops: entry.legendStops,
    };
    updated.push(key);
  }
  config.layers = layers;
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Updated ${updated.length} layer legend(s): ${updated.join(", ")}`);
  if (skipped.length > 0) {
    console.log(`Left untouched (not in catalog): ${skipped.join(", ")}`);
  }
}

main();
