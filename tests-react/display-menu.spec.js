const { test, expect } = require("./helpers/test");
const { routeBasemapFixture } = require("./helpers/basemap-fixture");

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

  // Applied group opacity per panel via the bridge: the engine reports the
  // value it wrote to its rendering surface.
  const groupOpacities = (group) =>
    page.evaluate((groupName) => {
      const bridge = window.__wx;
      if (!bridge) {
        return [];
      }
      return bridge.panels().map((id) => bridge.getGroupOpacity(id, groupName));
    }, group);

  await expect.poll(() => groupOpacities("weather")).toEqual([0.45, 0.45]);
  await expect.poll(() => groupOpacities("synoptic")).toEqual([0.35, 0.35]);
  await expect.poll(() => groupOpacities("labels")).toEqual([0, 0]);

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
  // Resolved opacity of the state-boundary line layer via the bridge: the
  // engine reports the opacity it applies to that layer at the current zoom.
  const stateBorderOpacity = () =>
    page.evaluate(() => {
      const bridge = window.__wx;
      if (!bridge || bridge.panels().length === 0) {
        return Number.NaN;
      }
      return bridge.getLineLayerOpacity(bridge.panels()[0], "reference-state-borders");
    });
  await expect.poll(stateBorderOpacity).toBeGreaterThan(0);

  // The zoom control is engine-owned chrome with a stable testid.
  const zoomIn = page.getByTestId("map-zoom-in").first();
  for (let i = 0; i < 10; i += 1) {
    if ((await zoomIn.getAttribute("aria-disabled")) === "true" || !(await zoomIn.isEnabled())) {
      break;
    }
    await zoomIn.click();
    await page.waitForTimeout(120);
  }

  await expect.poll(stateBorderOpacity).toBe(0);

  await page.getByRole("button", { name: "Display" }).click();
  await page.getByLabel("Borders").selectOption("reference");

  await expect.poll(stateBorderOpacity).toBeGreaterThan(0);
});

test("exclusive border modes: basemap knobs gate on mode and toggle the basemap boundary lines", async ({ page }) => {
  // Owner decision 2026-07-09 — one border source at a time: the basemap's
  // own OSM boundary lines show ONLY in border mode "basemap" (auto/reference
  // draw the app's reference overlay instead), and the basemap width/color
  // knobs are dead everywhere else.
  await routeModelFixtures(page, ["gfs"]);
  await routeBoundaryFixtures(page);
  await routeBasemapFixture(page);

  await page.goto("/");
  // Whether the basemap's country-boundary layer is applied-visible, via the
  // bridge (the engine reads the live layout state back, not stored flags);
  // null while the panel is booting.
  const basemapCountryBoundaryVisible = () =>
    page.evaluate(() => {
      const bridge = window.__wx;
      if (!bridge || bridge.panels().length === 0) {
        return null;
      }
      try {
        return bridge.getBasemapBoundaryLayers(bridge.panels()[0]).includes("boundaries_country");
      } catch {
        return null; // panel mid-remount
      }
    });
  // Assert basemap mode FIRST: a still-loading style reports no visible
  // boundary layers, so "hidden" could false-positive at boot — "visible"
  // cannot. Every later "hidden" poll therefore reads a live style.
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByLabel("Borders").selectOption("basemap");
  await expect.poll(basemapCountryBoundaryVisible, { timeout: 30_000 }).toBe(true);

  const basemapWeight = page.locator("label", { hasText: "Basemap weight" }).locator("input[type='range']");
  await expect(basemapWeight).toBeEnabled();

  // Reference mode: the app overlay owns borders — the basemap lines hide
  // and the basemap knobs go dead.
  await page.getByLabel("Borders").selectOption("reference");
  await expect(basemapWeight).toBeDisabled();
  await expect.poll(basemapCountryBoundaryVisible, { timeout: 30_000 }).toBe(false);

  // And back: the toggle is live state, not a boot-time accident.
  await page.getByLabel("Borders").selectOption("basemap");
  await expect(basemapWeight).toBeEnabled();
  await expect.poll(basemapCountryBoundaryVisible, { timeout: 30_000 }).toBe(true);
});

test("County lines toggle mounts the county layer and renders it above the fade-in zoom", async ({ page }) => {
  await routeModelFixtures(page, ["gfs"]);
  await routeBoundaryFixtures(page);
  await routeBasemapFixture(page);
  await page.route("**/geo/features/us-counties.geojson", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [-96.5, 38.5],
                [-96.5, 39.5],
                [-95.5, 39.5],
              ],
            },
          },
        ],
      }),
    });
  });

  // Native z6 sits above the county fade-in threshold (opacity 0 below z5,
  // then 0.12 + (zoom - 5) * 0.09), so the resolved opacity must be > 0.
  await page.goto("/?c=39,-96,6&zs=2");
  const countyState = () =>
    page.evaluate((layerId) => {
      const bridge = window.__wx;
      if (!bridge || bridge.panels().length === 0) {
        return null;
      }
      const id = bridge.panels()[0];
      try {
        return {
          mounted: bridge.getLayerOrder(id).includes(layerId),
          opacity: bridge.getLineLayerOpacity(id, layerId),
        };
      } catch {
        return null; // panel mid-remount
      }
    }, "feature-county-lines");
  await expect.poll(() => countyState(), { timeout: 30_000 }).not.toBeNull();
  expect((await countyState()).mounted).toBe(false);

  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByText("County lines", { exact: true }).click();

  await expect.poll(async () => (await countyState())?.mounted, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await countyState())?.opacity).toBeGreaterThan(0);

  // Toggling back off unmounts the layer (the effect cleanup removes it).
  await page.getByText("County lines", { exact: true }).click();
  await expect.poll(async () => (await countyState())?.mounted).toBe(false);
});

async function toggleCheckbox(page, checkbox, checked) {
  if ((await checkbox.isChecked()) === checked) {
    return;
  }
  await checkbox.focus();
  await page.keyboard.press("Space");
  if (checked) {
    await expect(checkbox).toBeChecked();
  } else {
    await expect(checkbox).not.toBeChecked();
  }
}

function buildSnowOrderingManifest() {
  return {
    schemaVersion: 4,
    model: "gfs",
    run: "20260423-1200Z",
    view: "conus",
    generatedAt: "2026-04-23T12:10:00Z",
    referenceTime: "2026-04-23T12:00:00Z",
    openDataModel: "noaa-gfs-pgrb2-0p25",
    hourStatus: { 0: "loaded" },
    parameterOrder: ["temperature", "snow10to1", "reflectivityComposite"],
    parameters: {
      snow10to1: {
        key: "snow10to1",
        label: "10:1 Snow",
        unit: "in",
        group: "Winter / Snow & Ice",
        legendTicks: [1, 6, 12, 24, 48],
        legendStops: [
          [0, [40, 90, 140]],
          [1, [220, 80, 160]],
        ],
      },
    },
    frames: [
      {
        hour: 0,
        validHourKey: "2026-04-23T12:00:00Z",
        bounds: { north: 53, south: 21, west: -129, east: -63 },
        cols: 1600,
        rows: 980,
        layers: {
          temperature: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE },
          snow10to1: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE },
          reflectivityComposite: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE },
        },
      },
    ],
  };
}

test("snow layers follow the shared config stack order ahead of radar", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latestPointer("gfs", "manifests/gfs/snow-order.json")),
    });
  });
  await page.route("**/__cf/manifests/gfs/snow-order.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildSnowOrderingManifest()),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.getByTestId("panel-status")).toHaveText("Ready");

  await panel.getByRole("button", { name: /Parameters/ }).click();
  await toggleCheckbox(page, panel.getByRole("checkbox", { name: /10:1 Snow/ }), true);
  await toggleCheckbox(page, panel.getByRole("checkbox", { name: /Composite Reflectivity/ }), true);
  await toggleCheckbox(page, panel.getByRole("checkbox", { name: /Temp/ }).first(), false);

  // Legend cards render in getLayerStackOrder order; shared config puts snow before radar.
  await expect
    .poll(async () => panel.locator(".z-\\[510\\] span.font-medium").allTextContents(), { timeout: 5_000 })
    .toEqual(["10:1 Snow (in)", "Composite Reflectivity (dBZ)"]);
});

test("basemap picks stick: no snap-back on custom edits, menu switches persist", async ({ page }) => {
  // A v2 payload with an explicit Light pick must survive load AND further edits.
  await page.addInitScript(() => {
    localStorage.setItem(
      "modelview.display.v1",
      JSON.stringify({ preset: "custom", basemap: "light", schemaVersion: 2 }),
    );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await expect(page.getByRole("combobox", { name: /^Basemap/ })).toHaveValue("light");

  // Editing another setting must not reset the basemap (the migration used to
  // run inside normalize and fired on every in-memory change).
  await page.getByText("County lines", { exact: true }).click();
  await expect(page.getByRole("combobox", { name: /^Basemap/ })).toHaveValue("light");

  // Switching the basemap from the menu must stick.
  await page.getByRole("combobox", { name: /^Basemap/ }).selectOption("dark");
  await expect(page.getByRole("combobox", { name: /^Basemap/ })).toHaveValue("dark");
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("modelview.display.v1") || "{}").basemap))
    .toBe("dark");
});

test("fresh boot (no stored payload) defaults to the light basemap", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  // v3 default (spec §8a.1): the weather color maps were designed for a
  // white background.
  await expect(page.getByRole("combobox", { name: /^Basemap/ })).toHaveValue("light");
});

test("pre-v2 stored 'light' (the old default, never a choice) lands on the current light default", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("modelview.display.v1", JSON.stringify({ preset: "standard", basemap: "light" }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  // v1 "light" is still dropped as a non-choice (it was the pre-v2 default);
  // since v3 the preset default it falls to is light again.
  await expect(page.getByRole("combobox", { name: /^Basemap/ })).toHaveValue("light");
});

test("stored explicit 'dark' survives the v3 light-default flip (v2 payload and pre-v2 payload)", async ({ page }) => {
  // A v2 payload's dark cannot be told apart from an explicit pick, so the
  // v2 -> v3 migration never reverse-drops it: explicit choices stick.
  await page.addInitScript(() => {
    localStorage.setItem(
      "modelview.display.v1",
      JSON.stringify({ preset: "custom", basemap: "dark", schemaVersion: 2 }),
    );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await expect(page.getByRole("combobox", { name: /^Basemap/ })).toHaveValue("dark");

  // Pre-v2 dark was an explicit pick too (light was the default then).
  await page.evaluate(() => {
    localStorage.setItem("modelview.display.v1", JSON.stringify({ preset: "custom", basemap: "dark" }));
  });
  await page.reload();
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await expect(page.getByRole("combobox", { name: /^Basemap/ })).toHaveValue("dark");
});

test("stored 'topographic' migrates to light — topo is gone app-wide (v4)", async ({ page }) => {
  // Task 5.2: the topographic basemap was removed. Any stored pick — pre-v2
  // (no schemaVersion) or v3 — migrates to light, the light-toned ground
  // panels already rendered for it.
  await page.addInitScript(() => {
    localStorage.setItem("modelview.display.v1", JSON.stringify({ preset: "custom", basemap: "topographic" }));
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await expect(page.getByRole("combobox", { name: /^Basemap/ })).toHaveValue("light");
  // The option itself is gone from the picker.
  await expect(page.getByRole("combobox", { name: /^Basemap/ }).locator("option")).toHaveCount(2);

  // A v3 payload (explicit topographic pick from the last schema era)
  // migrates identically.
  await page.evaluate(() => {
    localStorage.setItem(
      "modelview.display.v1",
      JSON.stringify({ preset: "custom", basemap: "topographic", schemaVersion: 3 }),
    );
  });
  await page.reload();
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await expect(page.getByRole("combobox", { name: /^Basemap/ })).toHaveValue("light");
});

test("theme picker: light -> dark -> light round-trip preserves app layers, camera, and load state", async ({
  page,
}) => {
  // Task 4.3r3 (spec §8a.1): a theme switch swaps the whole GL style
  // (setStyle drops every layer/source), so this guards the re-flush
  // machinery — app layers, stacking order, camera, and the weather load
  // signal must all survive a round trip.
  await routeModelFixtures(page, ["gfs"]);
  await routeBoundaryFixtures(page);
  await routeBasemapFixture(page);

  await page.goto("/?c=39,-96,5&zs=2");
  const bridgeState = () =>
    page.evaluate(() => {
      const bridge = window.__wx;
      if (!bridge || bridge.panels().length === 0) {
        return null;
      }
      const id = bridge.panels()[0];
      try {
        return {
          kind: bridge.getEngineKind(id),
          order: bridge.getLayerOrder(id),
          loaded: bridge.isWeatherLoaded(id, "temperature"),
          viewport: bridge.getViewport(id),
        };
      } catch {
        return null; // panel mid-remount
      }
    });
  await expect.poll(async () => (await bridgeState())?.kind, { timeout: 30_000 }).toBe("maplibre");
  await expect.poll(async () => (await bridgeState())?.loaded, { timeout: 30_000 }).toBe(true);
  const before = await bridgeState();
  expect(before.order).toContain("temperature");
  expect(before.order).toContain("reference-country-borders");

  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByRole("combobox", { name: /^Basemap/ }).selectOption("dark");
  // The style swap re-flushes every registered layer in the same band order
  // and re-arms the weather load signal; the fixture data re-decodes fast.
  await expect.poll(async () => (await bridgeState())?.loaded, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await bridgeState())?.order).toEqual(before.order);

  await page.getByRole("combobox", { name: /^Basemap/ }).selectOption("light");
  await expect.poll(async () => (await bridgeState())?.loaded, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await bridgeState())?.order).toEqual(before.order);

  // Camera survives both swaps (setStyle never touches it).
  const after = await bridgeState();
  expect(after.viewport.lat).toBeCloseTo(before.viewport.lat, 5);
  expect(after.viewport.lon).toBeCloseTo(before.viewport.lon, 5);
  expect(after.viewport.zoom).toBeCloseTo(before.viewport.zoom, 5);
});

test("?c= restore lands exactly on the requested camera", async ({ page }) => {
  // Task 4.4 regression (kept from the retired engine-flip spec — the
  // dev-only engine toggle died with Leaflet in Task 6.3): the `?c=` restore
  // must land ON the requested camera. The old animated maxBounds-enforcement
  // pan used to drag every restore ~14 px east while the boot-default view
  // was still being pulled inside the view bounds.
  await routeModelFixtures(page, ["gfs"]);
  await routeBoundaryFixtures(page);
  await routeBasemapFixture(page);

  await page.goto("/?p1=gfs:temperature&c=39,-96,5&zs=2");
  const viewportOf = () =>
    page.evaluate(() => {
      const bridge = window.__wx;
      if (!bridge || bridge.panels().length === 0) {
        return null;
      }
      try {
        return bridge.getViewport(bridge.panels()[0]);
      } catch {
        return null; // panel mid-remount
      }
    });
  await expect.poll(() => viewportOf(), { timeout: 30_000 }).not.toBeNull();

  await expect
    .poll(async () => {
      const vp = await viewportOf();
      return vp ? { lat: Math.round(vp.lat), lon: Math.round(vp.lon), zoom: vp.zoom } : null;
    })
    .toEqual({ lat: 39, lon: -96, zoom: 5 });
  const booted = await viewportOf();
  expect(Math.abs(booted.lat - 39)).toBeLessThan(0.05);
  expect(Math.abs(booted.lon - -96)).toBeLessThan(0.05);
});
