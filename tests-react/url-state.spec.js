const { test, expect } = require("@playwright/test");

// Reuse the panel-collection fixture routing so panels resolve a manifest.
const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

function latestPointer(model, key) {
  return {
    model,
    run: "20260423-1200Z",
    view: "conus",
    generatedAt: "2026-04-23T12:10:00Z",
    manifestKey: key,
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
        layers: { temperature: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE } },
      },
    ],
  };
}
async function routeModelFixtures(page, models) {
  for (const model of models) {
    await page.route(`**/__cf/manifests/${model}/latest.json**`, (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(latestPointer(model, `manifests/${model}/p.json`)),
      }),
    );
    await page.route(`**/__cf/manifests/${model}/p.json**`, (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(buildManifest(model)) }),
    );
  }
}

test("URL view/model params override storage on load", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.addInitScript(() => {
    window.localStorage.setItem("modelview.session.v1", JSON.stringify({ viewKey: "conus" }));
  });
  await page.goto("/?view=na&model=hrrr");
  await expect(page.getByLabel("View")).toHaveValue("na");
  await expect(page.getByLabel("Model").first()).toHaveValue("hrrr");
});

test("changing the view writes ?view= into the URL via replaceState", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.goto("/");
  await page.getByLabel("View").selectOption("na");
  await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get("view"))).toBe("na");
  // replaceState (not pushState): one back step leaves the app entirely.
  const historyLen = await page.evaluate(() => history.length);
  await page.getByLabel("View").selectOption("conus");
  await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get("view"))).toBe("conus");
  expect(await page.evaluate(() => history.length)).toBe(historyLen);
});
