const { test, expect } = require("./helpers/test");

// Point-sounding payload with enough real levels to satisfy the drawer's
// loaded state (`levels.length > 0`) and give the Skew-T/hodograph plottable
// data. The /soundings endpoint is mocked so no GRIB sampling or NOAA
// network is involved; the fixture cache provides the run/manifest so a
// frame loads and the double-click handler has a frame to sample against.
function soundingPayload() {
  const levels = [
    { press: 1000, hght: 110, temp: 24, dwpt: 20, uKt: 5, vKt: 4, source: "surface" },
    { press: 925, hght: 780, temp: 20, dwpt: 16, uKt: 12, vKt: 8 },
    { press: 850, hght: 1500, temp: 15, dwpt: 9, uKt: 20, vKt: 12 },
    { press: 700, hght: 3100, temp: 4, dwpt: -6, uKt: 30, vKt: 10 },
    { press: 500, hght: 5800, temp: -12, dwpt: -24, uKt: 45, vKt: 6 },
    { press: 300, hght: 9500, temp: -42, dwpt: -55, uKt: 70, vKt: -4 },
  ];
  return {
    model: "gfs",
    modelLabel: "GFS",
    run: "20260214-0000Z",
    referenceTime: "2026-02-14T00:00:00Z",
    methodVersion: "point-sounding-earth-winds-ceiling-datum-effective-scp-v2",
    forecastHour: 0,
    validTime: "2026-02-14T00:00:00Z",
    lat: 39.0,
    lon: -95.0,
    sampleLat: 39.01,
    sampleLon: -95.02,
    selectedRecordCount: 42,
    levels,
    parcelTrace: { type: "SFC", label: "Surface parcel", levels },
    windReference: {
      sourceFrame: "grid-relative",
      outputFrame: "earth-relative",
      projection: "lambert",
      rotationApplied: true,
      rotationAngleDeg: 2.5,
    },
    indices: {
      sbcapeJkg: 1500,
      bunkersRightDirDeg: 240,
      bunkersRightKt: 30,
      cloudCeilingState: "none",
      cloudCeilingDatum: "AGL",
    },
    warnings: [],
  };
}

test("double-click opens the sounding drawer, shows the profile, and closes", async ({ page }) => {
  await page.route("**/soundings/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(soundingPayload()),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  // The footer reads "Valid --" until a frame resolves; requestPointSounding
  // requires a loaded frame, so wait for a real valid label before clicking.
  await expect(panel.locator("footer")).toContainText("Valid", { timeout: 60_000 });
  await expect(panel.locator("footer")).not.toContainText("Valid --", { timeout: 60_000 });

  const mapContainer = panel.locator('[data-testid="map-canvas-host"]');
  const box = await mapContainer.boundingBox();
  if (!box) throw new Error("Map container bounding box is unavailable.");
  await mapContainer.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });

  const drawer = panel.locator("aside");
  await expect(drawer).toBeVisible();
  // Role-based: getByText("Point Sounding") also matches the technical
  // source panel's "point sounding" string; the heading is unambiguous.
  await expect(drawer.getByRole("heading", { name: "Point Sounding" })).toBeVisible();
  await expect(drawer.getByText("Building point profile...")).toHaveCount(0);
  await expect(drawer.getByText("Hodograph")).toBeVisible();
  await expect(drawer.getByLabel("Sounding latitude")).toBeVisible();
  await expect(drawer.getByTestId("sounding-provenance")).toContainText("run 20260214-0000Z");
  await expect(drawer.getByTestId("sounding-provenance")).toContainText("request 39.00°N 95.00°W");
  await expect(drawer.getByTestId("sounding-provenance")).toContainText(
    "wind grid-relative -> earth-relative, lambert, rotation applied (2.50 deg)",
  );
  await expect(drawer.getByText("App Convective-Environment Heuristic")).toBeVisible();
  await expect(drawer.getByText("N/A", { exact: true })).toBeVisible();
  await expect(drawer.getByText(/no independent CIN veto/)).toBeVisible();
  await expect(drawer.getByText(/Cloud ceiling: No ceiling/)).toBeVisible();
  await expect(drawer.getByText(/Wind reference: grid-relative -> earth-relative/)).toBeVisible();

  await drawer.getByRole("button", { name: "Close sounding" }).click();
  await expect(panel.locator("aside")).toHaveCount(0);
});

test("the drawer exports the Skew-T + hodograph as a PNG download", async ({ page }) => {
  await page.route("**/soundings/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(soundingPayload()),
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

  const downloadPromise = page.waitForEvent("download");
  await drawer.getByRole("button", { name: "PNG", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^sounding_gfs_.+_f000_.+\.png$/);
  await expect(page.getByTestId("toast").filter({ hasText: "Sounding PNG saved" })).toBeVisible();
});
