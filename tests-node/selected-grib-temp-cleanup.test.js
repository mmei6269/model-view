"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const test = require("node:test");
const { materializeSelectedGrib } = require("../scripts/lib/noaa-beta/selected-grib");

const TEMP_SELECTED_GRIB_PATTERN = /^noaa-selected-\d+-[a-z0-9]+\.grib2$/;

async function tempSelectedGribNames() {
  return (await fs.promises.readdir(os.tmpdir())).filter((name) => TEMP_SELECTED_GRIB_PATTERN.test(name));
}

test("materializeSelectedGrib removes the partial temp GRIB when a non-cached fetch fails", async (t) => {
  const before = new Set(await tempSelectedGribNames());
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 404 });
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(
    materializeSelectedGrib({
      modelKey: "nam",
      productKey: "grib",
      gribUrl: "https://example.invalid/file.grib2",
      recordGroups: [
        {
          offset: 0,
          rangeHeader: "bytes=0-3",
          byteLength: 4,
          records: [
            {
              record: "1",
              offset: 0,
              param: "TMP",
              level: "2 m above ground",
              forecast: "anl",
              line: "1:0:d=2026071200:TMP:2 m above ground:anl:",
              rangeHeader: "bytes=0-3",
              byteLength: 4,
            },
          ],
        },
      ],
      rawCacheDir: null,
      date: "20260712",
      cycle: "00",
      hour: 0,
    }),
    /Expected byte-range response/,
  );

  const leaked = (await tempSelectedGribNames()).filter((name) => !before.has(name));
  assert.deepEqual(leaked, []);
});
