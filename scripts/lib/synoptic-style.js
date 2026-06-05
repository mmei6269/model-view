"use strict";

const path = require("path");
const fs = require("fs");

const STYLE_PATH = path.resolve(__dirname, "../../shared/synoptic-style-v1.json");

let cached = null;

function loadSynopticStyle() {
  if (cached) {
    return cached;
  }
  const raw = fs.readFileSync(STYLE_PATH, "utf8");
  const parsed = JSON.parse(raw);
  cached = Object.freeze(parsed);
  return cached;
}

function getZoomBucketId(zoom) {
  const style = loadSynopticStyle();
  const z = Number.isFinite(zoom) ? zoom : 6;
  const bucket = (style.zoomBuckets || []).find((entry) => z >= Number(entry.min) && z <= Number(entry.max));
  return bucket?.id || "z4_6";
}

function resolveBucketValue(table, zoom, fallback) {
  if (!table || typeof table !== "object") {
    return fallback;
  }
  const bucketId = getZoomBucketId(zoom);
  const value = table[bucketId];
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

module.exports = {
  loadSynopticStyle,
  getZoomBucketId,
  resolveBucketValue,
  STYLE_PATH,
};
