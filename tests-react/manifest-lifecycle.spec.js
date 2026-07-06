const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

function frameEntry(hour, validHourKey) {
  return {
    hour,
    validHourKey,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    cols: 1600,
    rows: 980,
    layers: {
      temperature: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE },
    },
  };
}

function gfsLatestPointer() {
  return {
    model: "gfs",
    run: "20260214-0000Z",
    view: "conus",
    generatedAt: "2026-02-14T00:10:00Z",
    manifestKey: "manifests/gfs/lifecycle-gfs.json",
    frameCount: 1,
  };
}

function gfsManifest() {
  return {
    schemaVersion: 2,
    model: "gfs",
    run: "20260214-0000Z",
    view: "conus",
    generatedAt: "2026-02-14T00:10:00Z",
    referenceTime: "2026-02-14T00:00:00Z",
    openDataModel: "noaa-gfs-pgrb2-0p25",
    hourStatus: { 2: "loaded" },
    frames: [frameEntry(2, "2026-02-14T02:00:00Z")],
  };
}

function hrrrLatestPointer() {
  return {
    model: "hrrr",
    run: "20260214-0400Z",
    view: "conus",
    generatedAt: "2026-02-14T04:10:00Z",
    manifestKey: "manifests/hrrr/lifecycle-hrrr.json",
    frameCount: 1,
  };
}

function hrrrManifest() {
  return {
    schemaVersion: 2,
    model: "hrrr",
    run: "20260214-0400Z",
    view: "conus",
    generatedAt: "2026-02-14T04:10:00Z",
    referenceTime: "2026-02-14T04:00:00Z",
    openDataModel: "noaa-hrrr-wrfprs",
    hourStatus: { 2: "loaded" },
    frames: [frameEntry(2, "2026-02-14T06:00:00Z")],
  };
}

async function routeGfsOk(page) {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gfsLatestPointer()) });
  });
  await page.route("**/__cf/manifests/gfs/lifecycle-gfs.json**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gfsManifest()) });
  });
}

module.exports = { frameEntry, gfsLatestPointer, gfsManifest, routeGfsOk };

test("switching to a model with a failing manifest surfaces an error instead of stale frames", async ({ page }) => {
  await routeGfsOk(page);
  let hrrrAvailable = false;
  // Match every candidate artifact base URL (/__cf proxy and the direct data-server fallback),
  // otherwise the client falls through to http://127.0.0.1:5174 where hrrr fixtures exist.
  await page.route("**/manifests/hrrr/**", async (route) => {
    if (!hrrrAvailable) {
      await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
      return;
    }
    const url = route.request().url();
    if (url.includes("/latest.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hrrrLatestPointer()) });
      return;
    }
    if (url.includes("/runs.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hrrrManifest()) });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.locator("footer")).toContainText("Valid 2026-02-14 02z");
  await expect(panel.getByText("Ready").first()).toBeVisible();

  await panel.locator("select").first().selectOption("hrrr");

  // The old GFS manifest must not keep rendering under the HRRR label.
  await expect(panel.getByText("Manifest Error").first()).toBeVisible();
  await expect(panel.getByText("Ready")).toHaveCount(0);
  await expect(panel.locator("footer")).toContainText("Valid --");
  await expect(panel.locator("footer")).not.toContainText("2026-02-14 02z");
  await expect(panel.getByTestId("manifest-error")).toBeVisible();

  hrrrAvailable = true;
  // Scope to the manifest card: the run-list error card has its own Retry (P3.6).
  await panel.getByTestId("manifest-error").getByRole("button", { name: "Retry" }).click();
  await expect(panel.getByText("Ready").first()).toBeVisible();
  await expect(panel.locator("footer")).toContainText("Valid 2026-02-14 06z");
  await expect(panel.getByTestId("manifest-error")).toHaveCount(0);
});

test("initial manifest failure shows an error state with retry instead of a frame message", async ({ page }) => {
  let gfsAvailable = false;
  await page.route("**/manifests/gfs/**", async (route) => {
    if (!gfsAvailable) {
      await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
      return;
    }
    const url = route.request().url();
    if (url.includes("/latest.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gfsLatestPointer()) });
      return;
    }
    if (url.includes("/runs.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gfsManifest()) });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.getByText("Manifest Error").first()).toBeVisible();
  await expect(panel.getByText("Manifest unavailable").first()).toBeVisible();
  await expect(panel.getByText("Ready")).toHaveCount(0);

  gfsAvailable = true;
  // Scope to the manifest card: the run-list error card has its own Retry (P3.6).
  await panel.getByTestId("manifest-error").getByRole("button", { name: "Retry" }).click();
  await expect(panel.getByText("Ready").first()).toBeVisible();
  await expect(panel.locator("footer")).toContainText("Valid 2026-02-14 02z");
});

test("run-list failures are surfaced and stale run options are dropped on model switch", async ({ page }) => {
  await routeGfsOk(page);
  await page.route("**/__cf/manifests/gfs/runs.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            model: "gfs",
            run: "20260214-0000Z",
            view: "conus",
            generatedAt: "2026-02-14T00:10:00Z",
            manifestKey: "manifests/gfs/lifecycle-gfs.json",
            frameCount: 1,
            loadedFrameCount: 1,
            complete: true,
            latest: true,
          },
        ],
      }),
    });
  });
  // 404 across all candidate base URLs: runs.json fails AND the manifest fallback fails,
  // which is the only path where useModelRuns reports an error.
  await page.route("**/manifests/hrrr/**", async (route) => {
    await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  const runSelect = panel.locator("select").nth(1);
  await expect(runSelect.locator("option", { hasText: "2026-02-14 00z" })).toHaveCount(1);

  await panel.locator("select").first().selectOption("hrrr");
  await expect(panel.getByTestId("run-list-error")).toBeVisible();
  await expect(panel.getByTestId("run-list-error")).toContainText("Runs unavailable");
  await expect(runSelect.locator("option", { hasText: "2026-02-14 00z" })).toHaveCount(0);
});
