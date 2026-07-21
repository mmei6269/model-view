const { test, expect } = require("./helpers/test");

function soundingPayload(model, modelLabel, sbcape) {
  const levels = [
    { press: 1000, hght: 110, temp: 24, dwpt: 20, uKt: 5, vKt: 4, source: "surface" },
    { press: 925, hght: 780, temp: 20, dwpt: 16, uKt: 12, vKt: 8 },
    { press: 850, hght: 1500, temp: 15, dwpt: 9, uKt: 20, vKt: 12 },
    { press: 700, hght: 3100, temp: 4, dwpt: -6, uKt: 30, vKt: 10 },
    { press: 500, hght: 5800, temp: -12, dwpt: -24, uKt: 45, vKt: 6 },
    { press: 300, hght: 9500, temp: -42, dwpt: -55, uKt: 70, vKt: -4 },
  ];
  return {
    model,
    modelLabel,
    run: "20260423-1200Z",
    referenceTime: "2026-04-23T12:00:00Z",
    forecastHour: 0,
    validTime: "2026-04-23T12:00:00Z",
    lat: 39.0,
    lon: -95.0,
    sampleLat: 39.02,
    sampleLon: -94.98,
    levels,
    parcelTrace: { type: "SFC", label: "Surface parcel", levels },
    indices: { sbcapeJkg: sbcape, srh0to1kmM2S2: 120, bunkersRightDirDeg: 240, bunkersRightKt: 30 },
    warnings: [],
  };
}

test("compare overlays a second model's profile with dashed traces and an A/B table", async ({ page }) => {
  await page.addInitScript(() => {
    window.__soundingExportText = [];
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      window.__soundingExportText.push(String(text));
      return originalFillText.call(this, text, ...args);
    };
  });
  await page.route("**/soundings/gfs/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(soundingPayload("gfs", "GFS", 1500)),
    });
  });
  await page.route("**/soundings/hrrr/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(soundingPayload("hrrr", "HRRR", 900)),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.locator("footer")).toContainText("Valid", { timeout: 60_000 });
  await expect(panel.locator("footer")).not.toContainText("Valid --", { timeout: 60_000 });

  const mapContainer = panel.locator('[data-testid="map-canvas-host"]');
  const box = await mapContainer.boundingBox();
  if (!box) throw new Error("Map container bounding box is unavailable.");
  await mapContainer.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });

  const drawer = panel.locator("aside");
  await expect(drawer.getByText("Hodograph")).toBeVisible();

  // The compare picker excludes the profile's own model.
  const picker = drawer.getByLabel("Compare against");
  await expect(picker.locator('option[value="gfs"]')).toHaveCount(0);

  await picker.selectOption("hrrr");

  // Dashed overlays land on both charts.
  await expect(drawer.getByTestId("skewt-compare-temp")).toBeVisible();
  await expect(drawer.getByTestId("hodo-compare-trace")).toBeVisible();

  // A/B table shows both models' key indices side by side.
  const table = drawer.getByTestId("sounding-compare-table");
  await expect(table).toBeVisible();
  await expect(table).toContainText("GFS");
  await expect(table).toContainText("HRRR");
  const capeRow = table.locator("div", { hasText: /^SBCAPE/ }).last();
  await expect(capeRow).toContainText("1500");
  await expect(capeRow).toContainText("900");
  const provenance = drawer.getByTestId("sounding-provenance");
  await expect(provenance).toContainText(
    "compare HRRR run 20260423-1200Z init 2026-04-23 12z valid 2026-04-23 12z F000 (delta t 0 min)",
  );
  await expect(provenance).toContainText("compare request 39.00°N 95.00°W sample 39.02°N 94.98°W");

  const downloadPromise = page.waitForEvent("download");
  await drawer.getByRole("button", { name: "PNG", exact: true }).click();
  await downloadPromise;
  const exportText = await page.evaluate(() => window.__soundingExportText);
  expect(exportText).toContain(
    "Comparison HRRR | run 20260423-1200Z | init 2026-04-23 12z | valid 2026-04-23 12z | F000 | delta t 0 min",
  );
  expect(exportText).toContain("Comparison request 39.00°N 95.00°W | sample 39.02°N 94.98°W");

  // Switching back to None removes every overlay.
  await picker.selectOption("");
  await expect(drawer.getByTestId("skewt-compare-temp")).toHaveCount(0);
  await expect(drawer.getByTestId("hodo-compare-trace")).toHaveCount(0);
  await expect(drawer.getByTestId("sounding-compare-table")).toHaveCount(0);
});

test("grossly mismatched comparison valid times are disclosed and direct overlays are suppressed", async ({ page }) => {
  await page.addInitScript(() => {
    window.__soundingExportText = [];
    const originalFillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      window.__soundingExportText.push(String(text));
      return originalFillText.call(this, text, ...args);
    };
  });
  await page.route("**/soundings/gfs/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(soundingPayload("gfs", "GFS", 1500)),
    });
  });
  await page.route("**/soundings/hrrr/**", async (route) => {
    const payload = soundingPayload("hrrr", "HRRR", 900);
    payload.validTime = "2026-04-23T18:00:00Z";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.locator("footer")).not.toContainText("Valid --", { timeout: 60_000 });
  const mapContainer = panel.locator('[data-testid="map-canvas-host"]');
  const box = await mapContainer.boundingBox();
  if (!box) throw new Error("Map container bounding box is unavailable.");
  await mapContainer.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });

  const drawer = panel.locator("aside");
  await expect(drawer.getByText("Hodograph")).toBeVisible();
  await drawer.getByLabel("Compare against").selectOption("hrrr");
  await expect(drawer.getByTestId("sounding-compare-time-warning")).toContainText("suppressed");
  await expect(drawer.getByTestId("skewt-compare-temp")).toHaveCount(0);
  await expect(drawer.getByTestId("hodo-compare-trace")).toHaveCount(0);
  await expect(drawer.getByTestId("sounding-compare-table")).toHaveCount(0);
  await expect(drawer.getByTestId("sounding-provenance")).toContainText("delta t +6h");
  await expect(drawer.getByTestId("sounding-provenance")).toContainText(
    "compare HRRR run 20260423-1200Z init 2026-04-23 12z valid 2026-04-23 18z F000",
  );
  await expect(drawer.getByTestId("sounding-provenance")).toContainText(
    "compare request 39.00°N 95.00°W sample 39.02°N 94.98°W",
  );

  const downloadPromise = page.waitForEvent("download");
  await drawer.getByRole("button", { name: "PNG", exact: true }).click();
  await downloadPromise;
  const exportText = await page.evaluate(() => window.__soundingExportText);
  expect(exportText.some((line) => line.includes("traces/index pairs suppressed (>90 min)"))).toBe(true);
});
