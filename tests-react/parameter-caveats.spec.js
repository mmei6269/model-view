const { test, expect } = require("./helpers/test");

// Same minimal manifest fixture shape the url-state spec uses: one loaded
// temperature frame is enough to open the panel's parameter menu.
const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";

async function routeModelFixtures(page, models) {
  for (const model of models) {
    await page.route(`**/__cf/manifests/${model}/latest.json**`, (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          model,
          run: "20260423-1200Z",
          view: "conus",
          generatedAt: "2026-04-23T12:10:00Z",
          manifestKey: `manifests/${model}/p.json`,
          frameCount: 1,
        }),
      }),
    );
    await page.route(`**/__cf/manifests/${model}/p.json**`, (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
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
        }),
      }),
    );
  }
}

test("documented accuracy caveats surface as ⓘ markers in the parameter menu", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.goto("/");

  await page
    .getByRole("button", { name: /^Parameters/ })
    .first()
    .click();

  // Reflectivity precip-type: the instantaneous-vs-accumulation caveat.
  const reflCaveat = page.locator('[data-caveat-key="reflectivity1kmPrecipType"]');
  await expect(reflCaveat).toBeVisible();
  await expect(reflCaveat).toHaveAttribute("title", /Instantaneous reflectivity/);

  // Effective bulk shear: the 0-6 km proxy disclosure.
  const ebsCaveat = page.locator('[data-caveat-key="effectiveBulkShear"]');
  await expect(ebsCaveat).toBeVisible();
  await expect(ebsCaveat).toHaveAttribute("title", /0–6 km shear/);

  // A parameter without a documented caveat renders no marker.
  await expect(page.locator('[data-caveat-key="temperature"]')).toHaveCount(0);

  // The caveat also lands in the row tooltip so hover reads it in context.
  const dcapeRow = page.locator('label[title*="reduced-profile-dcape-v4"]');
  await expect(dcapeRow.first()).toBeAttached();
});
