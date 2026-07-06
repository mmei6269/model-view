"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { writeSelectedGribRangeFile } = require("../scripts/lib/noaa-beta/grib-source");

test("writeSelectedGribRangeFile assembles ranges and records the sha256 stage", async () => {
  const chunks = {
    "bytes=0-3": Buffer.from("GRIB"),
    "bytes=4-9": Buffer.from("abcdef"),
  };
  const groups = [
    { rangeHeader: "bytes=0-3", byteLength: 4 },
    { rangeHeader: "bytes=4-9", byteLength: 6 },
  ];
  const targetPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grib-range-test-")), "selected.grib2");
  const profile = { stages: {} };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const chunk = chunks[options.headers?.Range];
    assert.ok(chunk, `unexpected Range header ${options.headers?.Range}`);
    return {
      status: 206,
      arrayBuffer: async () => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    };
  };
  try {
    const result = await writeSelectedGribRangeFile({
      targetPath,
      gribUrl: "https://example.invalid/file.grib2",
      groups,
      rangeFetchConcurrency: 1,
      profile,
    });
    const expected = Buffer.concat([chunks["bytes=0-3"], chunks["bytes=4-9"]]);
    assert.deepEqual(fs.readFileSync(targetPath), expected);
    assert.equal(result.bytes, expected.length);
    assert.equal(result.sha256, crypto.createHash("sha256").update(expected).digest("hex"));
    assert.equal(profile.selectedBytes, expected.length);
    assert.ok(Number.isFinite(profile.stages.rangeFetchMs));
    assert.ok(Number.isFinite(profile.stages.selectedGribHashMs));
    assert.equal("rangeConcatMs" in profile.stages, false);
  } finally {
    global.fetch = originalFetch;
  }
});
