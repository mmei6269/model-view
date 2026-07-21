const { test, expect } = require("./helpers/test");

const ONE_BY_ONE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==",
  "base64",
);

test("an explicitly unavailable selected parameter is not fetched and is shown as unavailable", async ({ page }) => {
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const referenceTime = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  const valid0 = referenceTime;
  const valid3 = new Date(now + 3 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const run = "20260711-0000Z";
  let unavailablePrecipRequests = 0;

  await page.route("**/__cf/manifests/gfs/latest.json**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run,
        view: "conus",
        generatedAt: referenceTime,
        manifestKey: "manifests/gfs/parameter-availability.json",
        frameCount: 2,
      }),
    }),
  );
  await page.route("**/__cf/manifests/gfs/parameter-availability.json**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run,
        view: "conus",
        generatedAt: referenceTime,
        referenceTime,
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded", 3: "loaded" },
        parameterOrder: ["temperature", "precip"],
        frames: [
          {
            hour: 0,
            validHourKey: valid0,
            bounds: { north: 53, south: 21, west: -129, east: -63 },
            cols: 1,
            rows: 1,
            parameterAvailability: { temperature: "available", precip: "available" },
            layers: {
              temperature: { key: "fixtures/availability/temperature-f000.png", bytes: 70 },
              precip: { key: "fixtures/availability/precip-f000.png", bytes: 70 },
            },
          },
          {
            hour: 3,
            validHourKey: valid3,
            bounds: { north: 53, south: 21, west: -129, east: -63 },
            cols: 1,
            rows: 1,
            parameterAvailability: { temperature: "available", precip: "unavailable" },
            // The run-union manifest still has a transparent placeholder ref.
            layers: {
              temperature: { key: "fixtures/availability/temperature-f003.png", bytes: 70 },
              precip: { key: "fixtures/availability/precip-f003.png", bytes: 70 },
            },
          },
        ],
      }),
    }),
  );
  await page.route("**/__cf/fixtures/availability/*.png**", async (route) => {
    if (route.request().url().includes("precip-f003.png")) {
      unavailablePrecipRequests += 1;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: ONE_BY_ONE_BYTES,
    });
  });

  await page.goto(`/?p1=gfs:precip&syn=none&hour=${encodeURIComponent(valid3)}`);
  const panel = page.locator("article").first();
  await expect(panel.getByText("Layer Unavailable", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByText("Unavailable for this frame: 1-h Precip", { exact: true })).toBeVisible();
  await panel
    .getByRole("button", { name: /Frames/ })
    .first()
    .click();
  const unavailableChip = panel.locator('button[title^="F003"]');
  await expect(unavailableChip).toHaveAttribute("data-frame-status", "unavailable", { timeout: 10_000 });
  await expect(unavailableChip).toHaveAttribute("title", /Unavailable/);
  await page.waitForTimeout(500);
  expect(unavailablePrecipRequests).toBe(0);

  await page.goto(`/?p1=gfs:temperature,precip&syn=none&hour=${encodeURIComponent(valid3)}`);
  const mixedPanel = page.locator("article").first();
  await expect(mixedPanel.getByTestId("layer-unavailable-status")).toContainText(
    "Unavailable for this frame: 1-h Precip. Other selected layers remain visible.",
  );
  await expect(mixedPanel.getByText("Layer Unavailable", { exact: true })).toHaveCount(0);
  await expect(mixedPanel.getByText("Unavailable for this frame: 1-h Precip", { exact: true })).toHaveCount(0);
  expect(unavailablePrecipRequests).toBe(0);
});
