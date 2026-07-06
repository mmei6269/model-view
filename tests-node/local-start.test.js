"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildPreviewEnv } = require("../scripts/local-start");

test("preview env wires the artifact base to the data origin", () => {
  const env = buildPreviewEnv("http://127.0.0.1:5174", { PATH: "/usr/bin" });
  assert.equal(env.MODELVIEW_ARTIFACT_BASE_URL, "http://127.0.0.1:5174");
  assert.equal(env.VITE_ARTIFACT_BASE_URL, "http://127.0.0.1:5174");
  assert.equal(env.PATH, "/usr/bin", "base env is preserved");
});
