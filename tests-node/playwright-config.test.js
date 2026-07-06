"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const CONFIG_PATH = require.resolve("../playwright.react.config.js");

function loadConfigWithCi(ciValue) {
  const originalCi = process.env.CI;
  try {
    if (ciValue === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = ciValue;
    }
    delete require.cache[CONFIG_PATH];
    return require(CONFIG_PATH);
  } finally {
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
    delete require.cache[CONFIG_PATH];
  }
}

test("playwright react config reuses an existing dev server locally", () => {
  assert.equal(loadConfigWithCi(undefined).webServer.reuseExistingServer, true);
});

test("playwright react config never reuses a stale server on CI", () => {
  assert.equal(loadConfigWithCi("true").webServer.reuseExistingServer, false);
});
