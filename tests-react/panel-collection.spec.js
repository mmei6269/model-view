const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

function latestPointer(model, manifestKey) {
  return {
    model,
    run: "20260423-1200Z",
    view: "conus",
    generatedAt: "2026-04-23T12:10:00Z",
    manifestKey,
    frameCount: 1,
  };
}

function buildManifest(model) {
  return {
    schemaVersion: 4,
    model,
    run: "20260423-1200Z",
    view: "conus",
    generatedAt: "2026-04-23T12:10:00Z",
    referenceTime: "2026-04-23T12:00:00Z",
    openDataModel: "noaa-gfs-pgrb2-0p25",
    hourStatus: { 0: "loaded" },
    frames: [
      {
        hour: 0,
        validHourKey: "2026-04-23T12:00:00Z",
        bounds: { north: 53, south: 21, west: -129, east: -63 },
        cols: 1600,
        rows: 980,
        layers: {
          temperature: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE },
        },
      },
    ],
  };
}

async function routeModelFixtures(page, models) {
  for (const model of models) {
    await page.route(`**/__cf/manifests/${model}/latest.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(latestPointer(model, `manifests/${model}/panel-test.json`)),
      });
    });
    await page.route(`**/__cf/manifests/${model}/panel-test.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildManifest(model)),
      });
    });
  }
}

test("panel add/remove/add keeps monotonic ids and model rotation", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);

  await page.goto("/");
  await expect(page.locator("article")).toHaveCount(1);
  await expect(page.getByLabel("Model").first()).toHaveValue("gfs");

  await page.getByRole("button", { name: "Add Map" }).click();
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.getByLabel("Model").nth(1)).toHaveValue("nam3km");
  await expect(page.getByRole("button", { name: "Add Map" })).toBeDisabled();

  await page.getByRole("button", { name: "Remove" }).last().click();
  await expect(page.locator("article")).toHaveCount(1);

  await page.getByRole("button", { name: "Add Map" }).click();
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.getByLabel("Model").nth(1)).toHaveValue("hrrr");
});

test("panel model + layers persist across reload; runId is not pinned", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.goto("/");
  await expect(page.getByLabel("Model").first()).toHaveValue("gfs");
  await page.getByLabel("Model").first().selectOption("hrrr");
  await expect(page.getByLabel("Model").first()).toHaveValue("hrrr");

  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = JSON.parse(window.localStorage.getItem("modelview.panels.v1") || "{}");
        return raw.panels?.[0]?.modelKey;
      }),
    )
    .toBe("hrrr");
  // runId must never be persisted.
  const hasRunId = await page.evaluate(() =>
    Object.prototype.hasOwnProperty.call(
      JSON.parse(window.localStorage.getItem("modelview.panels.v1") || "{}").panels?.[0] || {},
      "runId",
    ),
  );
  expect(hasRunId).toBe(false);

  await page.reload();
  await expect(page.getByLabel("Model").first()).toHaveValue("hrrr");
});

test("a stored two-panel collection hydrates on load", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "modelview.panels.v1",
      JSON.stringify({
        counter: 2,
        panels: [
          { id: "panel-1", modelKey: "nam", layers: ["temperature"] },
          { id: "panel-2", modelKey: "hrrr", layers: ["temperature"] },
        ],
      }),
    );
  });
  await page.goto("/");
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.getByLabel("Model").first()).toHaveValue("nam");
  await expect(page.getByLabel("Model").nth(1)).toHaveValue("hrrr");
});
