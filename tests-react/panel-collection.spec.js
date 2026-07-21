const { test, expect } = require("./helpers/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";

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
  await expect(page.getByLabel("Model", { exact: true }).first()).toHaveValue("gfs");

  await page.getByRole("button", { name: "Add Map" }).click();
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.getByLabel("Model", { exact: true }).nth(1)).toHaveValue("nam3km");
  // The ceiling is now four panels, so two maps leave Add Map enabled.
  await expect(page.getByRole("button", { name: "Add Map" })).toBeEnabled();

  await page.getByRole("button", { name: "Remove" }).last().click();
  await expect(page.locator("article")).toHaveCount(1);

  await page.getByRole("button", { name: "Add Map" }).click();
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.getByLabel("Model", { exact: true }).nth(1)).toHaveValue("hrrr");
});

test("panel model + layers persist across reload; runId is not pinned", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.goto("/");
  await expect(page.getByLabel("Model", { exact: true }).first()).toHaveValue("gfs");
  await page.getByLabel("Model", { exact: true }).first().selectOption("hrrr");
  await expect(page.getByLabel("Model", { exact: true }).first()).toHaveValue("hrrr");

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
  await expect(page.getByLabel("Model", { exact: true }).first()).toHaveValue("hrrr");
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
  await expect(page.getByLabel("Model", { exact: true }).first()).toHaveValue("nam");
  await expect(page.getByLabel("Model", { exact: true }).nth(1)).toHaveValue("hrrr");
});

test("Add Map scales to four panels in a 2x2 grid, then disables", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.goto("/");

  const addMap = page.getByRole("button", { name: "Add Map" });
  await addMap.click();
  await addMap.click();
  await addMap.click();

  await expect(page.getByLabel("Model", { exact: true })).toHaveCount(4);
  await expect(addMap).toBeDisabled();

  // 2x2 layout: four panels split the viewport in half both ways.
  const boxes = [];
  for (const article of await page.locator("main > article").all()) {
    boxes.push(await article.boundingBox());
  }
  expect(boxes).toHaveLength(4);
  const viewport = page.viewportSize();
  for (const box of boxes) {
    expect(box.width).toBeLessThan(viewport.width * 0.6);
    expect(box.height).toBeLessThan(viewport.height * 0.6);
  }

  // Track picker lists all four panels in panel timeline mode.
  await page.getByLabel("Axis").selectOption("panel");
  await expect(page.getByLabel("Track").locator("option")).toHaveCount(4);

  // Removing one drops back to three; the lone third panel spans the bottom.
  await page.getByRole("button", { name: "Remove" }).last().click();
  await expect(page.getByLabel("Model", { exact: true })).toHaveCount(3);
  await expect(addMap).toBeEnabled();
  const lastBox = await page.locator("main > article").last().boundingBox();
  expect(lastBox.width).toBeGreaterThan(viewport.width * 0.9);
});
