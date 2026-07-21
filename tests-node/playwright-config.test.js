"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const CONFIG_PATH = require.resolve("../playwright.react.config.js");

function loadConfigWithEnvironment({ ci, workers } = {}) {
  const originalCi = process.env.CI;
  const originalWorkers = process.env.PLAYWRIGHT_WORKERS;
  try {
    if (ci === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = ci;
    }
    if (workers === undefined) {
      delete process.env.PLAYWRIGHT_WORKERS;
    } else {
      process.env.PLAYWRIGHT_WORKERS = workers;
    }
    delete require.cache[CONFIG_PATH];
    return require(CONFIG_PATH);
  } finally {
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
    if (originalWorkers === undefined) {
      delete process.env.PLAYWRIGHT_WORKERS;
    } else {
      process.env.PLAYWRIGHT_WORKERS = originalWorkers;
    }
    delete require.cache[CONFIG_PATH];
  }
}

test("playwright react config reuses an existing dev server locally", () => {
  assert.equal(loadConfigWithEnvironment().webServer.reuseExistingServer, true);
});

test("playwright react config never reuses a stale server on CI", () => {
  assert.equal(loadConfigWithEnvironment({ ci: "true" }).webServer.reuseExistingServer, false);
});

test("playwright uses eight workers for local test runs", () => {
  assert.equal(loadConfigWithEnvironment().workers, 8);
});

test("playwright isolates browser tests to one worker on CI runners", () => {
  assert.equal(loadConfigWithEnvironment({ ci: "true" }).workers, 1);
});

test("playwright balances CI shards without changing local file isolation", () => {
  assert.equal(loadConfigWithEnvironment().fullyParallel, false);
  assert.equal(loadConfigWithEnvironment({ ci: "true" }).fullyParallel, true);
});

test("playwright retries once only on CI", () => {
  assert.equal(loadConfigWithEnvironment().retries, 0);
  assert.equal(loadConfigWithEnvironment({ ci: "true" }).retries, 1);
});

test("playwright worker count can be overridden with an environment variable", () => {
  assert.equal(loadConfigWithEnvironment({ workers: "5" }).workers, 5);
});

test("playwright ignores invalid worker-count overrides", () => {
  assert.equal(loadConfigWithEnvironment({ workers: "0" }).workers, 8);
  assert.equal(loadConfigWithEnvironment({ workers: "many" }).workers, 8);
});
