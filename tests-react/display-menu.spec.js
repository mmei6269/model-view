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
          temperature: {
            key: "",
            bytes: 120,
            contentType: "image/png",
            url: ONE_BY_ONE,
          },
        },
      },
    ],
  };
}

function boundaryFixture(kind) {
  const line =
    kind === "country"
      ? [
          [-79, 43],
          [-73, 43],
        ]
      : [
          [-76, 39],
          [-76, 43],
        ];
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: line },
      },
    ],
  };
}

async function routeModelFixtures(page, models = ["gfs"]) {
  for (const model of models) {
    await page.route(`**/__cf/manifests/${model}/latest.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(latestPointer(model, `manifests/${model}/display-test.json`)),
      });
    });
    await page.route(`**/__cf/manifests/${model}/display-test.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildManifest(model)),
      });
    });
  }
}

async function routeBoundaryFixtures(page) {
  const requests = [];
  let oldGlobalRequests = 0;
  for (const oldPath of [
    "**/geo/ne_10m_admin_0_boundary_lines_land.geojson",
    "**/geo/ne_10m_admin_1_states_provinces_lines.geojson",
  ]) {
    await page.route(oldPath, async (route) => {
      oldGlobalRequests += 1;
      await route.fulfill({ status: 500, body: "old global boundary asset should not be requested" });
    });
  }
  await page.route("**/geo/boundaries/*.geojson", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(boundaryFixture(pathname.includes("country") ? "country" : "admin1")),
    });
  });
  return {
    requests,
    oldGlobalRequests: () => oldGlobalRequests,
  };
}

async function setRangeValue(page, label, value) {
  const locator = page.locator("label", { hasText: label }).locator("input[type='range']");
  await locator.evaluate((element, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter.call(element, String(nextValue));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

test("Display menu presets and power controls update all panel panes", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam"]);
  await routeBoundaryFixtures(page);

  await page.goto("/");
  await page.getByRole("button", { name: "Add Map" }).click();
  await expect(page.locator("article")).toHaveCount(2);

  await page.getByRole("button", { name: "Display" }).click();
  await page.getByRole("button", { name: /analysis/i }).click();
  await setRangeValue(page, "Weather Opacity", 45);
  await setRangeValue(page, "Synoptic Opacity", 35);
  await page.getByLabel("Labels", { exact: true }).uncheck();

  await expect
    .poll(async () =>
      page.$$eval(".leaflet-wx-temp-pane-pane", (panes) => panes.map((pane) => getComputedStyle(pane).opacity)),
    )
    .toEqual(["0.45", "0.45"]);

  await expect
    .poll(async () =>
      page.$$eval(".leaflet-wx-synoptic-isobar-pane-pane", (panes) =>
        panes.map((pane) => getComputedStyle(pane).opacity),
      ),
    )
    .toEqual(["0.35", "0.35"]);

  await expect
    .poll(async () =>
      page.$$eval(".leaflet-wx-labels-pane-pane", (panes) => panes.map((pane) => getComputedStyle(pane).opacity)),
    )
    .toEqual(["0", "0"]);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("modelview.display.v1") || "{}"));
  expect(stored.preset).toBe("custom");
  expect(stored.weather.opacity).toBe(45);
});

test("Display boundaries load view-scoped assets and never request old global files", async ({ page }) => {
  await routeModelFixtures(page, ["gfs"]);
  const boundaries = await routeBoundaryFixtures(page);

  await page.goto("/");
  await expect
    .poll(() => boundaries.requests)
    .toEqual(["/geo/boundaries/conus-country.geojson", "/geo/boundaries/conus-admin1.geojson"]);

  await page.getByLabel("View").selectOption("na");
  await expect.poll(() => boundaries.requests).toContain("/geo/boundaries/na-country.geojson");
  await expect.poll(() => boundaries.requests).toContain("/geo/boundaries/na-admin1.geojson");

  expect(boundaries.requests.every((request) => request.startsWith("/geo/boundaries/"))).toBeTruthy();
  expect(boundaries.oldGlobalRequests()).toBe(0);
});

test("Display auto mode hides custom state borders at high zoom while reference mode keeps them", async ({ page }) => {
  await routeModelFixtures(page, ["gfs"]);
  await routeBoundaryFixtures(page);

  await page.goto("/");
  const statePath = ".leaflet-wx-state-borders-pane-pane path";
  await expect.poll(async () => page.locator(statePath).count()).toBeGreaterThan(0);

  const zoomIn = page.locator(".leaflet-control-zoom-in").first();
  for (let i = 0; i < 10; i += 1) {
    if ((await zoomIn.getAttribute("aria-disabled")) === "true" || !(await zoomIn.isEnabled())) {
      break;
    }
    await zoomIn.click();
    await page.waitForTimeout(120);
  }

  await expect
    .poll(async () => page.$eval(statePath, (element) => element.getAttribute("stroke-opacity") || ""))
    .toBe("0");

  await page.getByRole("button", { name: "Display" }).click();
  await page.getByLabel("Borders").selectOption("reference");

  await expect
    .poll(async () => Number(await page.$eval(statePath, (element) => element.getAttribute("stroke-opacity") || "0")))
    .toBeGreaterThan(0);
});
