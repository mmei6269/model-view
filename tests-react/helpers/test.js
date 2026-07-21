const base = require("@playwright/test");
const { routeBasemapFixture } = require("./basemap-fixture");

// ── Shared Playwright test for tests-react ───────────────────────────────────
// Every spec imports { test, expect } from this module instead of
// "@playwright/test" so one context fixture applies suite-wide: the committed
// PMTiles basemap fixture is routed into every fresh browser context, so
// panels boot a deterministic local basemap in every spec regardless of
// whether the machine has the real extract (Playwright 1.52 has no
// config-level init-script/global-fixture hook, hence this extended `test`).
// The WX_TEST_ENGINE engine matrix that used to live here died with Leaflet
// in Task 6.3 — MapLibre is the only engine.
const test = base.test.extend({
  context: async ({ context }, use) => {
    await routeBasemapFixture(context);
    await use(context);
  },
});

module.exports = { ...base, test };
