const { test, expect } = require("./helpers/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";

const CENTER = { highs: [{ lat: 40, lon: -100, valueHpa: 1024 }], lows: [] };
const EMPTY_CENTERS = { highs: [], lows: [] };

function vectorPayload(centers) {
  return {
    styleVersion: "v4-operational-contrast",
    isobars: { lines: [], labels: [] },
    thickness: { lines: [], labels: [] },
    centers,
  };
}

function manifest(vectorKeys) {
  return {
    schemaVersion: 4,
    model: "gfs",
    run: "20260711-0000Z",
    view: "conus",
    generatedAt: "2026-07-11T00:10:00Z",
    referenceTime: "2026-07-11T00:00:00Z",
    openDataModel: "noaa-gfs-pgrb2-0p25",
    hourStatus: { 0: "loaded" },
    frames: [
      {
        hour: 0,
        validHourKey: "2026-07-11T00:00:00Z",
        bounds: { north: 53, south: 21, west: -129, east: -63 },
        cols: 1600,
        rows: 980,
        synopticCenters: CENTER,
        synopticVectorKey: vectorKeys.simple,
        synopticVectorKeys: vectorKeys,
        synopticVectorBytes: { simple: 100, detailed: vectorKeys.detailed ? 100 : null },
        layers: {
          temperature: { key: "", bytes: 100, contentType: "image/png", url: ONE_BY_ONE },
          synoptic: { key: "", bytes: 100, contentType: "image/png", url: ONE_BY_ONE },
        },
      },
    ],
  };
}

async function routeManifest(page, vectorKeys) {
  await page.route("**/__cf/manifests/gfs/latest.json**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260711-0000Z",
        view: "conus",
        generatedAt: "2026-07-11T00:10:00Z",
        manifestKey: "manifests/gfs/synoptic-lifecycle.json",
        frameCount: 1,
      }),
    }),
  );
  await page.route("**/__cf/manifests/gfs/synoptic-lifecycle.json**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(manifest(vectorKeys)) }),
  );
}

async function centerCount(page) {
  return page.evaluate(() => {
    const panelId = window.__wx.panels()[0];
    return window.__wx.getSymbolFeatureCount(panelId, "synoptic-centers-high");
  });
}

async function activeWeatherLayers(page) {
  return page.evaluate(() => {
    const panelId = window.__wx.panels()[0];
    return window.__wx.getActiveWeatherLayers(panelId);
  });
}

test("missing detailed vector is explicit, keeps manifest centers, and combined raster honors toggles", async ({
  page,
}) => {
  const simpleKey = "fixtures/synoptic-lifecycle/simple-only.json";
  await routeManifest(page, { simple: simpleKey });
  await page.route(`**/__cf/${simpleKey}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      // Legacy vectors can omit the center field entirely; omission is not
      // an authoritative empty analysis and must retain manifest markers.
      body: JSON.stringify({
        styleVersion: "v4-operational-contrast",
        isobars: { lines: [], labels: [] },
        thickness: { lines: [], labels: [] },
      }),
    }),
  );

  await page.goto("/");
  await expect.poll(() => centerCount(page)).toBe(1);
  const detailSelect = page.locator("label:has-text('Isobar Detail') select").first();
  await detailSelect.selectOption("detailed");

  const status = page.getByTestId("vector-raster-fallback-status").first();
  await expect(status).toContainText("Detailed synoptic vectors unavailable");
  await expect(status).toContainText("Simple combined isobar/thickness raster shown");
  await expect.poll(() => activeWeatherLayers(page)).toContain("synoptic");
  await expect.poll(() => centerCount(page)).toBe(1);

  await page.getByRole("button", { name: "Thickness", exact: true }).first().click();
  await expect(status).toContainText("Combined raster hidden to honor");
  await expect.poll(() => activeWeatherLayers(page)).not.toContain("synoptic");
  await expect.poll(() => centerCount(page)).toBe(1);
});

test("detailed loading preserves centers until present-empty vector resolves and labels the simple raster", async ({
  page,
}) => {
  const simpleKey = "fixtures/synoptic-lifecycle/simple.json";
  const detailedKey = "fixtures/synoptic-lifecycle/detailed.json";
  await routeManifest(page, { simple: simpleKey, detailed: detailedKey });
  await page.route(`**/__cf/${simpleKey}**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(vectorPayload(CENTER)) }),
  );

  let releaseDetailed;
  const detailedGate = new Promise((resolve) => {
    releaseDetailed = resolve;
  });
  let detailedHits = 0;
  await page.route(`**/__cf/${detailedKey}**`, async (route) => {
    detailedHits += 1;
    await detailedGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(vectorPayload(EMPTY_CENTERS)),
    });
  });

  await page.goto("/");
  await expect.poll(() => centerCount(page)).toBe(1);
  await page.locator("label:has-text('Isobar Detail') select").first().selectOption("detailed");
  await expect.poll(() => detailedHits).toBe(1);

  const status = page.getByTestId("vector-raster-fallback-status").first();
  await expect(status).toContainText("Detailed synoptic vectors loading");
  await expect(status).toContainText("Simple combined isobar/thickness raster shown");
  await expect.poll(() => centerCount(page)).toBe(1);

  releaseDetailed();
  await expect.poll(() => centerCount(page)).toBe(0);
  await expect(status).toHaveCount(0);
});

test("failed detailed request retains manifest centers and reports the simple fallback", async ({ page }) => {
  const simpleKey = "fixtures/synoptic-lifecycle/failure-simple.json";
  const detailedKey = "fixtures/synoptic-lifecycle/failure-detailed.json";
  await routeManifest(page, { simple: simpleKey, detailed: detailedKey });
  await page.route(`**/__cf/${simpleKey}**`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(vectorPayload(CENTER)) }),
  );
  await page.route(`**/__cf/${detailedKey}**`, (route) =>
    route.fulfill({ status: 503, contentType: "text/plain", body: "fixture failure" }),
  );

  await page.goto("/");
  await expect.poll(() => centerCount(page)).toBe(1);
  await page.locator("label:has-text('Isobar Detail') select").first().selectOption("detailed");

  const status = page.getByTestId("vector-raster-fallback-status").first();
  await expect(status).toContainText("Detailed synoptic vectors unavailable");
  await expect(status).toContainText("Simple combined isobar/thickness raster shown");
  await expect.poll(() => centerCount(page)).toBe(1);
});
