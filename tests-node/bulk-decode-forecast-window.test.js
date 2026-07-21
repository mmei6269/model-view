"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildBulkDecodedRecordIndex, takeBulkDecodedRecord } = require("../scripts/lib/noaa-beta/bulk-decode");

function inventoryRow(record, forecast, fieldOrdinal) {
  return { record, recordNumber: Number(record), fieldOrdinal, param: "APCP", level: "surface", forecast, extra: "" };
}

function sourceRecord(record, forecast) {
  return {
    record,
    recordNumber: Number(record),
    fieldOrdinal: Number(record),
    param: "APCP",
    level: "surface",
    forecast,
    extra: "",
  };
}

test("NOAA bulk decoded record binding requires the forecast window to match", () => {
  const index = buildBulkDecodedRecordIndex([
    inventoryRow("1", "0-3 hour acc fcst:", 1),
    inventoryRow("2", "0-6 hour acc fcst:", 2),
  ]);
  const used = new Set();

  const mismatch = takeBulkDecodedRecord(index, sourceRecord("9", "0-1 hour acc fcst:"), used);
  assert.equal(mismatch, null, "a forecast-window mismatch must miss, not bind a different window");

  const exact = takeBulkDecodedRecord(index, sourceRecord("8", "0-3 hour acc fcst:"), used);
  assert.equal(exact?.record, "1", "an exact param/level/forecast match still binds");

  const secondExact = takeBulkDecodedRecord(index, sourceRecord("7", "0-3 hour acc fcst:"), used);
  assert.equal(secondExact, null, "a taken record is not bound twice");
});
