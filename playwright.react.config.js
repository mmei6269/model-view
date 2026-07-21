// @ts-check
const { defineConfig } = require("@playwright/test");

const DEFAULT_LOCAL_WORKERS = 8;
const DEFAULT_CI_WORKERS = 1;

function resolveWorkerCount() {
  const configured = Number(process.env.PLAYWRIGHT_WORKERS);
  if (Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return process.env.CI ? DEFAULT_CI_WORKERS : DEFAULT_LOCAL_WORKERS;
}

// The shared `test` in tests-react/helpers/test.js serves the committed
// PMTiles basemap fixture context-wide, so every spec boots a deterministic
// local basemap (Playwright has no config-level init-script hook, hence the
// helper module every spec imports).
module.exports = defineConfig({
  testDir: "./tests-react",
  // Test-level sharding avoids a long tail from large spec files such as
  // smoke-react.spec.js. Keep it CI-only: each shard still has one isolated
  // worker, while local multi-worker runs retain file-level isolation.
  fullyParallel: Boolean(process.env.CI),
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  workers: resolveWorkerCount(),
  use: {
    baseURL: "http://127.0.0.1:5173",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "node scripts/prepare-react-fixture-cache.js test-results/react-cache && MODELVIEW_CACHE_ROOT=test-results/react-cache npm run local:dev -- --host 127.0.0.1 --port 5173",
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  reporter: [["list"]],
  outputDir: "test-results/react",
});
