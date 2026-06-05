// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests-react",
  timeout: 90_000,
  retries: 0,
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
    reuseExistingServer: true,
    timeout: 180_000,
  },
  reporter: [["list"]],
  outputDir: "test-results/react",
});
