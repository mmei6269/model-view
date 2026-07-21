"use strict";

// Wrapper-arg contracts for scripts/build-noaa-beta-test-render.js, pinned
// after an audit found the bare `--frames` lookahead consuming the following
// flag: `--frames --models=gfs` silently dropped --models from passthrough and
// ran all default models at the default frame count.

const assert = require("node:assert/strict");
const test = require("node:test");
const { DEFAULT_FRAME_COUNT, optionValue, parseWrapperArgs } = require("../scripts/build-noaa-beta-test-render");

test("a bare --frames does not swallow the following flag from passthrough", () => {
  const { frameCount, passthroughArgs } = parseWrapperArgs(["--frames", "--models=gfs"]);
  assert.equal(frameCount, DEFAULT_FRAME_COUNT, "no value means the default frame count");
  assert.deepEqual(passthroughArgs, ["--models=gfs"], "the following flag stays in passthrough");
});

test("--frames keeps its inline, separate-token, and valueless spellings", () => {
  assert.equal(parseWrapperArgs(["--frames=4", "--force"]).frameCount, 4);
  assert.equal(parseWrapperArgs(["--frames", "6"]).frameCount, 6);
  assert.deepEqual(parseWrapperArgs(["--frames", "6", "--force"]).passthroughArgs, ["--force"]);
  assert.equal(parseWrapperArgs(["--frames"]).frameCount, DEFAULT_FRAME_COUNT);
  assert.deepEqual(parseWrapperArgs(["--frames"]).passthroughArgs, []);
  assert.equal(parseWrapperArgs(["--frame-count", "--force"]).frameCount, DEFAULT_FRAME_COUNT);
  assert.deepEqual(parseWrapperArgs(["--frame-count", "--force"]).passthroughArgs, ["--force"]);
});

test("optionValue never returns the next flag as this option's value", () => {
  assert.equal(optionValue(["--model", "--force"], ["models", "model"]), null);
  assert.equal(optionValue(["--model"], ["models", "model"]), null);
  assert.equal(optionValue(["--model", "gfs"], ["models", "model"]), "gfs");
  assert.equal(optionValue(["--models=gfs"], ["models", "model"]), "gfs");
});
