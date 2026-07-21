"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { findRecord, indexNoaaRecords, recordMatchesStatistic } = require("../scripts/lib/noaa-beta/records");

function record(recordId, param, level, forecast) {
  return {
    record: recordId,
    param,
    level,
    forecast,
    extra: "",
    line: `${recordId}:0:d=2026071100:${param}:${level}:${forecast}:`,
  };
}

test("record selectors distinguish instantaneous, accumulated, and maximum statistics", () => {
  const records = [
    record("1", "PRATE", "surface", "0-1 hour max fcst"),
    record("2", "PRATE", "surface", "1 hour fcst"),
    record("3", "WEASD", "surface", "0-1 hour acc fcst"),
    record("4", "WEASD", "surface", "1 hour fcst"),
  ];
  indexNoaaRecords(records);
  assert.equal(findRecord(records, { param: "PRATE", level: "surface", statistic: "instant" }).record, "2");
  assert.equal(findRecord(records, { param: "PRATE", level: "surface", statistic: "maximum" }).record, "1");
  assert.equal(findRecord(records, { param: "WEASD", level: "surface", statistic: "accumulation" }).record, "3");
  assert.equal(findRecord(records, { param: "WEASD", level: "surface", statistic: "instant" }).record, "4");
});

test("statistic matching recognizes hour-average windows", () => {
  const average = record("1", "TMP", "2 m above ground", "0-3 hour ave fcst");
  assert.equal(recordMatchesStatistic(average, "average"), true);
  assert.equal(recordMatchesStatistic(average, "instant"), false);
});

test("ambiguous selectors emit a one-time diagnostic instead of silently hiding ambiguity", () => {
  const records = [
    record("101", "TESTAMBIG", "surface", "1 hour fcst"),
    record("102", "TESTAMBIG", "surface", "1 hour fcst"),
  ];
  indexNoaaRecords(records);
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(findRecord(records, { param: "TESTAMBIG", level: "surface", statistic: "instant" }).record, "101");
    assert.equal(findRecord(records, { param: "TESTAMBIG", level: "surface", statistic: "instant" }).record, "101");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ambiguous GRIB selector/);
  } finally {
    console.warn = originalWarn;
  }
});
