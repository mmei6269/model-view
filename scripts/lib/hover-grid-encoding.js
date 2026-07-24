"use strict";

const HOVER_GRID_ENCODING_ENV = "MODELVIEW_NOAA_HOVER_ENCODING";

const HOVER_GRID_ENCODINGS = Object.freeze({
  mvh4: Object.freeze({
    id: "mvh4",
    magic: "MVH4",
    schemaVersion: 4,
    predictor: "gradient2d",
    headerPredictor: "gradient2d",
    binaryFormatToken: "bin4",
    quantization: "absolute",
    preDeltaEncode: false,
    identity: "mvh4-schema4-gradient2d-absolute-v1",
  }),
  mvh3: Object.freeze({
    id: "mvh3",
    magic: "MVH3",
    schemaVersion: 3,
    predictor: "global1d",
    headerPredictor: null,
    binaryFormatToken: "bin3",
    quantization: "global1d-pre-delta-compatible",
    preDeltaEncode: true,
    identity: "mvh3-schema3-global1d-v1",
  }),
});

function resolveHoverGridEncodingDescriptor(value = process.env[HOVER_GRID_ENCODING_ENV]) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return HOVER_GRID_ENCODINGS.mvh4;
  }
  const descriptor = HOVER_GRID_ENCODINGS[normalized];
  if (!descriptor) {
    throw new Error(`${HOVER_GRID_ENCODING_ENV} must be 'mvh4' or 'mvh3' when set; received ${JSON.stringify(value)}`);
  }
  return descriptor;
}

const HOVER_GRID_ENCODING = resolveHoverGridEncodingDescriptor();

module.exports = {
  HOVER_GRID_ENCODING,
  HOVER_GRID_ENCODING_ENV,
  HOVER_GRID_ENCODINGS,
  resolveHoverGridEncodingDescriptor,
};
