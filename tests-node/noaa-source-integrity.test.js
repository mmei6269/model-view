"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  NOAA_RECENT_CYCLE_CACHE_TTL_MS,
  parseHttpByteRange,
  readFreshNoaaDiskCache,
  validateNoaaRangeResponse,
} = require("../scripts/lib/noaa-beta/grib-source");

function cycleContextAt(timestampMs) {
  const date = new Date(timestampMs);
  return {
    date: `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(
      date.getUTCDate(),
    ).padStart(2, "0")}`,
    cycle: String(date.getUTCHours()).padStart(2, "0"),
  };
}

test("recent-cycle disk caches expire while completed-cycle caches stay reusable", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "noaa-disk-ttl-"));
  const cachePath = path.join(tempDir, "sample.idx");
  try {
    await fs.promises.writeFile(cachePath, "1:0:d=2026071100:TMP:surface:anl:\n");
    const nowMs = Date.now();
    const staleMs = nowMs - NOAA_RECENT_CYCLE_CACHE_TTL_MS - 5000;
    await fs.promises.utimes(cachePath, staleMs / 1000, staleMs / 1000);

    const recent = cycleContextAt(nowMs - 60 * 60 * 1000);
    assert.equal(await readFreshNoaaDiskCache(cachePath, recent, { nowMs }), null);

    const completed = cycleContextAt(nowMs - 24 * 60 * 60 * 1000);
    assert.match(await readFreshNoaaDiskCache(cachePath, completed, { nowMs }), /TMP:surface/);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test("HTTP byte range parsing accepts request and Content-Range forms", () => {
  assert.deepEqual(parseHttpByteRange("bytes=100-249"), { start: 100, end: 249 });
  assert.deepEqual(parseHttpByteRange("bytes 100-249/1000"), { start: 100, end: 249 });
  assert.equal(parseHttpByteRange("items 100-249/1000"), null);
  assert.equal(parseHttpByteRange("bytes=249-100"), null);
});

test("range validation rejects a wrong body length or mismatched Content-Range", () => {
  const group = { rangeHeader: "bytes=100-109" };
  assert.doesNotThrow(() =>
    validateNoaaRangeResponse({
      response: { headers: { get: () => "bytes 100-109/500" } },
      group,
      body: Buffer.alloc(10),
      gribUrl: "https://example.test/model.grib2",
    }),
  );
  assert.throws(
    () =>
      validateNoaaRangeResponse({
        response: { headers: { get: () => "bytes 100-109/500" } },
        group,
        body: Buffer.alloc(9),
        gribUrl: "https://example.test/model.grib2",
      }),
    /has 9 bytes; expected 10/,
  );
  assert.throws(
    () =>
      validateNoaaRangeResponse({
        response: { headers: { get: () => "bytes 101-110/500" } },
        group,
        body: Buffer.alloc(10),
        gribUrl: "https://example.test/model.grib2",
      }),
    /does not match requested/,
  );
});
