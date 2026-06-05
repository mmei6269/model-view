const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

function latestPointer(run, manifestKey) {
  return {
    model: "gfs",
    run,
    view: "conus",
    generatedAt: "2026-02-14T00:00:00Z",
    manifestKey,
    frameCount: 1,
  };
}

function buildHoverGridPayload(rows = 2, cols = 2) {
  const encoded = Buffer.from(new Int16Array(rows * cols).fill(-32768).buffer).toString("base64");
  const variable = { scale: 1, offset: 0, missing: -32768, data: encoded };
  return {
    schemaVersion: 1,
    rows,
    cols,
    variables: {
      temperatureF: variable,
      windKt: variable,
      precipMm: variable,
      precipRateAndType: variable,
      capeJkg: variable,
      pressureHpa: variable,
    },
  };
}

test("schema v1 manifest still renders", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latestPointer("20260214-0000Z", "manifests/gfs/v1.json")),
    });
  });
  await page.route("**/__cf/manifests/gfs/v1.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260214-0000Z",
        view: "conus",
        generatedAt: "2026-02-14T00:00:00Z",
        frames: [
          {
            hour: 0,
            validHourKey: "2026-02-14T00:00:00Z",
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
              reflectivity: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
            },
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await expect(page.locator("article").first()).toBeVisible();
  await expect(page.locator("p", { hasText: "Run 2026-02-14 00z" }).first()).toBeVisible();
});

test("schema v2 manifest fields are consumed", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latestPointer("20260214-0600Z", "manifests/gfs/v2.json")),
    });
  });
  await page.route("**/__cf/manifests/gfs/v2.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        model: "gfs",
        run: "20260214-0600Z",
        view: "conus",
        generatedAt: "2026-02-14T06:15:00Z",
        referenceTime: "2026-02-14T06:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded", 1: "unavailable" },
        frames: [
          {
            hour: 0,
            validHourKey: "2026-02-14T06:00:00Z",
            bounds: { north: 53, south: 21, west: -129, east: -63 },
            cols: 1600,
            rows: 980,
            synopticCenters: {
              highs: [{ lat: 42, lon: -95, valueHpa: 1028 }],
              lows: [{ lat: 35, lon: -110, valueHpa: 998 }],
            },
            layers: {
              temperature: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
              synoptic: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
            },
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await expect(page.locator("article").first()).toBeVisible();
  await expect(page.locator("p", { hasText: "Run 2026-02-14 06z" }).first()).toBeVisible();

  const framesButton = page.getByRole("button", { name: /Frames/ }).first();
  await framesButton.click();
  await expect(page.getByRole("button", { name: "001" }).first()).toBeDisabled();
});

test("model switch preserves nearest valid time", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latestPointer("20260214-0000Z", "manifests/gfs/gfs-switch.json")),
    });
  });
  await page.route("**/__cf/manifests/gfs/gfs-switch.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        model: "gfs",
        run: "20260214-0000Z",
        view: "conus",
        generatedAt: "2026-02-14T00:10:00Z",
        referenceTime: "2026-02-14T00:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 2: "loaded", 5: "loaded" },
        frames: [
          {
            hour: 2,
            validHourKey: "2026-02-14T02:00:00Z",
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
          {
            hour: 5,
            validHourKey: "2026-02-14T05:00:00Z",
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
      }),
    });
  });
  await page.route("**/__cf/manifests/hrrr/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "hrrr",
        run: "20260214-0400Z",
        view: "conus",
        generatedAt: "2026-02-14T04:10:00Z",
        manifestKey: "manifests/hrrr/hrrr-switch.json",
        frameCount: 2,
      }),
    });
  });
  await page.route("**/__cf/manifests/hrrr/hrrr-switch.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 2,
        model: "hrrr",
        run: "20260214-0400Z",
        view: "conus",
        generatedAt: "2026-02-14T04:10:00Z",
        referenceTime: "2026-02-14T04:00:00Z",
        openDataModel: "noaa-hrrr-wrfprs",
        hourStatus: { 2: "loaded", 5: "loaded" },
        frames: [
          {
            hour: 2,
            validHourKey: "2026-02-14T06:00:00Z",
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
          {
            hour: 5,
            validHourKey: "2026-02-14T09:00:00Z",
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
      }),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.locator("footer")).toContainText("Valid 2026-02-14 02z");

  await panel.locator("select").first().selectOption("hrrr");
  await expect(panel.locator("footer")).toContainText("Valid 2026-02-14 06z");
});

test("schema v3 reflectivity variants and split synoptic payload are accepted", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latestPointer("20260215-1800Z", "manifests/gfs/v3.json")),
    });
  });
  await page.route("**/__cf/manifests/gfs/v3.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 3,
        model: "gfs",
        run: "20260215-1800Z",
        view: "conus",
        generatedAt: "2026-02-15T18:10:00Z",
        referenceTime: "2026-02-15T18:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded" },
        frames: [
          {
            hour: 0,
            validHourKey: "2026-02-15T18:00:00Z",
            bounds: { north: 53, south: 21, west: -129, east: -63 },
            cols: 1600,
            rows: 980,
            reflectivityVariants: {
              dbz15: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
              dbz20: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
            },
            synopticVector: {
              styleVersion: "v2-operational-contrast",
              isobars: {
                lines: [],
                labels: [],
              },
              thickness: {
                lines: [],
                labels: [],
              },
              centers: {
                highs: [],
                lows: [],
              },
            },
            layers: {
              temperature: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
              reflectivity: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
            },
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await expect(page.locator("article").first()).toBeVisible();
  const gateSelect = page.locator("label:has-text('Refl Gate') select").first();
  await gateSelect.selectOption("20");
  await expect(gateSelect).toHaveValue("20");
});

test("schema v4 hover grid and dual synoptic frame fields are accepted", async ({ page }) => {
  let simpleVectorHits = 0;
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latestPointer("20260216-0000Z", "manifests/gfs/v4.json")),
    });
  });
  await page.route("**/__cf/manifests/gfs/v4.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260216-0000Z",
        view: "conus",
        generatedAt: "2026-02-16T00:10:00Z",
        referenceTime: "2026-02-16T00:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded" },
        frames: [
          {
            hour: 0,
            validHourKey: "2026-02-16T00:00:00Z",
            bounds: { north: 53, south: 21, west: -129, east: -63 },
            cols: 1600,
            rows: 980,
            synopticVectorKey: "fixtures/gfs/f000/synoptic-vector-simple.json",
            synopticVectorKeys: {
              simple: "fixtures/gfs/f000/synoptic-vector-simple.json",
              detailed: "fixtures/gfs/f000/synoptic-vector-detailed.json",
            },
            synopticStyleVersion: "v4-operational-contrast",
            synopticStyleVersions: {
              simple: "v4-operational-contrast",
              detailed: "v4-operational-contrast",
            },
            pressureUploadMeta: {
              source: "forecast-fallback",
              inputRows: 16,
              inputCols: 28,
              hoverRows: 980,
              hoverCols: 1600,
              fullResolutionInput: false,
            },
            hoverGridKey: "fixtures/gfs/f000/hover-grid.json.gz",
            hoverGridSchemaVersion: 1,
            layers: {
              temperature: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
              synoptic: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
            },
          },
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/f000/synoptic-vector-simple.json**", async (route) => {
    simpleVectorHits += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        styleVersion: "v4-operational-contrast",
        isobars: { lines: [], labels: [] },
        thickness: { lines: [], labels: [] },
        centers: { highs: [], lows: [] },
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/f000/hover-grid.json.gz**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildHoverGridPayload()),
    });
  });

  await page.goto("/");
  await expect(page.locator("article").first()).toBeVisible();
  await expect(page.locator("p", { hasText: "Run 2026-02-16 00z" }).first()).toBeVisible();
  await expect.poll(() => simpleVectorHits).toBeGreaterThan(0);
});

test("manifest-driven precip-rate type is selectable", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latestPointer("20260216-0600Z", "manifests/gfs/v4-direct-planned.json")),
    });
  });
  await page.route("**/__cf/manifests/gfs/v4-direct-planned.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260216-0600Z",
        view: "conus",
        generatedAt: "2026-02-16T06:10:00Z",
        referenceTime: "2026-02-16T06:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded" },
        parameterOrder: [
          "precipRateAndType",
          "stormMotionVectors",
          "absoluteVorticity850",
          "verticalVelocity850",
          "simulatedIrProxy",
        ],
        parameters: {
          precipRateAndType: {
            key: "precipRateAndType",
            label: "Precip Rate + Type",
            unit: "in/hr",
            group: "Precipitation",
            legendType: "precip-rate-type",
            legendTicks: [0.01, 0.1, 1],
            legendStops: [
              [0, [0, 0, 0, 0]],
              [1, [239, 68, 68, 0.9]],
            ],
            precipRateTypeLegend: [
              {
                key: "rain",
                label: "Rain",
                tickLabels: [0.01, 0.1, 1],
                bins: [
                  { label: "light", minRate: 0.01, maxRate: 0.1, color: [20, 184, 166, 0.55] },
                  { label: "heavy", minRate: 0.1, maxRate: 1, color: [13, 148, 136, 0.9] },
                ],
              },
              {
                key: "snow",
                label: "Snow",
                tickLabels: [0.01, 0.1, 1],
                bins: [
                  { label: "light", minRate: 0.01, maxRate: 0.1, color: [147, 197, 253, 0.55] },
                  { label: "heavy", minRate: 0.1, maxRate: 1, color: [37, 99, 235, 0.9] },
                ],
              },
            ],
          },
          stormMotionVectors: {
            key: "stormMotionVectors",
            label: "Storm Motion",
            unit: "kt",
            group: "Convection",
            legendType: "vector",
            legendTicks: [0, 25, 50],
            legendStops: [
              [0, [248, 250, 252, 0.4]],
              [1, [248, 250, 252, 0.9]],
            ],
          },
          absoluteVorticity850: {
            key: "absoluteVorticity850",
            label: "850 mb Abs Vort",
            unit: "x10^-5 s^-1",
            group: "Upper Air",
            legendTicks: [0, 10, 20],
            legendStops: [
              [0, [0, 0, 0, 0]],
              [1, [239, 68, 68, 0.9]],
            ],
          },
          verticalVelocity850: {
            key: "verticalVelocity850",
            label: "850 mb Omega",
            unit: "dPa/s",
            group: "Upper Air",
            legendTicks: [-20, 0, 20],
            legendStops: [
              [0, [59, 130, 246, 0.9]],
              [1, [239, 68, 68, 0.9]],
            ],
          },
          simulatedIrProxy: {
            key: "simulatedIrProxy",
            label: "Simulated IR Proxy",
            unit: "C",
            group: "Clouds",
            legendStops: [
              [0, [235, 235, 235, 0.9]],
              [1, [115, 91, 82, 0.55]],
            ],
          },
        },
        frames: [
          {
            hour: 0,
            validHourKey: "2026-02-16T06:00:00Z",
            bounds: { north: 53, south: 21, west: -129, east: -63 },
            cols: 1600,
            rows: 980,
            hoverGridKey: "fixtures/gfs/f000/hover-grid.json.gz",
            hoverGridSchemaVersion: 1,
            weatherVectorRefs: {
              stormMotionVectors: {
                key: "fixtures/gfs/f000/storm-motion-vectors.json",
                bytes: 240,
                contentType: "application/json",
              },
            },
            layers: {
              temperature: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
              precipRateAndType: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
              absoluteVorticity850: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
              verticalVelocity850: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
              simulatedIrProxy: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
            },
          },
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/f000/hover-grid.json.gz**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildHoverGridPayload()),
    });
  });

  await page.goto("/");
  await expect(page.locator("article").first()).toBeVisible();
  await page
    .getByRole("button", { name: /Parameters/ })
    .first()
    .click();
  await page.getByRole("checkbox", { name: /Precip Rate \+ Type/ }).check();
  await expect(page.getByRole("checkbox", { name: /Storm Motion/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /850 mb Abs Vort/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /850 mb Omega/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /Simulated IR Proxy/ })).toHaveCount(0);
  await expect(page.getByText("Precip Rate + Type (in/hr)").first()).toBeVisible();
  await expect(page.getByText("Rain").first()).toBeVisible();
});

test("parameter menu uses meteorological slot grids and future placeholders", async ({ page }) => {
  const parameter = (key, label, unit, group) => ({
    key,
    label,
    unit,
    group,
    legendTicks: [],
    legendStops: [
      [0, [0, 0, 0, 0]],
      [1, [239, 68, 68, 0.9]],
    ],
  });
  const parameters = Object.fromEntries(
    [
      ["precip", "1-h Precip", "in", "Precipitation"],
      ["precip3h", "3-h Precip", "in", "Precipitation"],
      ["precip6h", "6-h Precip", "in", "Precipitation"],
      ["precip12h", "12-h Precip", "in", "Precipitation"],
      ["precip24h", "24-h Precip", "in", "Precipitation"],
      ["precipTotal", "Total Precip", "in", "Precipitation"],
      ["precipRateAndType", "Precip Rate + Type", "in/hr", "Precipitation"],
      ["wind", "Wind", "mph", "Surface & Boundary Layer"],
      ["height500", "500 mb Height", "dam", "Upper Air: Height / Wind / Temp"],
      ["wind500", "500 mb Wind", "kt", "Upper Air: Height / Wind / Temp"],
      ["temp500", "500 mb Temp", "C", "Upper Air: Height / Wind / Temp"],
      ["rh500", "500 mb RH", "%", "Upper Air: Height / Wind / Temp"],
      ["absoluteVorticity500", "500 mb Abs Vort", "x10^-5 s^-1", "Upper Air: Omega / Vorticity"],
      ["verticalVelocity500", "500 mb Omega", "dPa/s", "Upper Air: Omega / Vorticity"],
      ["absoluteVorticity700", "700 mb Abs Vort", "x10^-5 s^-1", "Upper Air: Omega / Vorticity"],
      ["verticalVelocity700", "700 mb Omega", "dPa/s", "Upper Air: Omega / Vorticity"],
      ["sbcape", "SBCAPE", "J/kg", "Severe: Thermodynamics"],
      ["sbcin", "SBCIN", "J/kg", "Severe: Thermodynamics"],
      ["mlcape", "MLCAPE", "J/kg", "Severe: Thermodynamics"],
      ["mlcin", "MLCIN", "J/kg", "Severe: Thermodynamics"],
      ["mucape", "MUCAPE", "J/kg", "Severe: Thermodynamics"],
      ["surfaceBasedLclHeight", "Surface LCL", "m", "Severe: Thermodynamics"],
      ["srh0to1km", "0-1 km SRH", "m2/s2", "Severe: Kinematics"],
      ["srh0to3km", "0-3 km SRH", "m2/s2", "Severe: Kinematics"],
      ["updraftHelicity2to5km1h", "2-5 km UH", "m2/s2", "Severe: Kinematics"],
      ["effectiveLayerSupercellCompositeParameter", "SCP (Effective Layer)", "", "Severe: Kinematics"],
      ["freezingRainLiquidTotal", "Freezing Rain Liquid", "in", "Winter / Snow & Ice"],
    ].map(([key, label, unit, group]) => [key, parameter(key, label, unit, group)]),
  );
  parameters.wind.sourceNote =
    "NOAA UGRD/VGRD at 10 m above ground; vector speed converted from m/s components to mph.";
  parameters.effectiveLayerSupercellCompositeParameter.derivation =
    "SPC effective-layer SCP formula using every loaded pressure-profile source row for the effective inflow layer: 25 mb spacing from 1000-700 mb and 50 mb spacing from 700-300 mb.";
  parameters.effectiveLayerSupercellCompositeParameter.methodVersion = "spc-effective-scp-parcel-sparse-v2";
  parameters.effectiveLayerSupercellCompositeParameter.formulaReference =
    "SPC Supercell Composite Parameter effective-layer formula.";

  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latestPointer("20260216-1200Z", "manifests/gfs/v4-menu-slots.json")),
    });
  });
  await page.route("**/__cf/manifests/gfs/v4-menu-slots.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260216-1200Z",
        view: "conus",
        generatedAt: "2026-02-16T12:10:00Z",
        referenceTime: "2026-02-16T12:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded" },
        parameterOrder: Object.keys(parameters),
        parameters,
        frames: [
          {
            hour: 0,
            validHourKey: "2026-02-16T12:00:00Z",
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
              wind: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
              effectiveLayerSupercellCompositeParameter: {
                key: "",
                bytes: 120,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
            },
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await expect(page.locator("article").first()).toBeVisible();
  await page
    .getByRole("button", { name: /Parameters/ })
    .first()
    .click();

  const menuText = await page.locator("article").first().textContent();
  const expectIncreasing = (labels) => {
    const indexes = labels.map((label) => menuText.indexOf(label));
    for (const index of indexes) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < indexes.length; index += 1) {
      expect(indexes[index]).toBeGreaterThan(indexes[index - 1]);
    }
  };

  expectIncreasing([
    "1-h Precip",
    "3-h Precip",
    "6-h Precip",
    "12-h Precip",
    "24-h Precip",
    "Total Precip",
    "Precip Rate + Type",
  ]);
  expectIncreasing(["SBCAPE", "SBCIN", "MLCAPE", "MLCIN", "MUCAPE", "DCAPE"]);
  expectIncreasing(["Surface Theta-e", "700-500 mb Lapse Rate", "0-3 km Lapse Rate"]);
  expectIncreasing(["500 mb Abs Vort", "500 mb Omega", "500 mb Rel Vort", "700 mb Abs Vort"]);
  expectIncreasing(["Snow Depth", "Snow Water Eq", "10:1 Snow", "Kuchera Snow", "Cobb Snow"]);

  await expect(page.getByText("500 mb Rel Vort").first()).toBeVisible();
  await expect(
    page
      .getByTestId("parameter-menu-scroll")
      .locator("span", { hasText: /^Wind$/ })
      .first(),
  ).toHaveAttribute("title", /10 m above ground/);
  await expect(page.getByText("SCP (Effective Layer)").first()).toHaveAttribute(
    "title",
    /every loaded pressure-profile source row/,
  );
  await expect(page.getByText("SCP (Effective Layer)").first()).toHaveAttribute(
    "title",
    /spc-effective-scp-parcel-sparse-v2/,
  );
  await expect(page.getByText("DCAPE").first()).toBeVisible();
  await expect(page.getByText("0-6 km Bulk Shear").first()).toBeVisible();
  await expect(page.getByText("FRAM Flat Ice").first()).toBeVisible();
  await expect(page.getByText("10:1 Snow").first()).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Run Max Gust/ })).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: /^reflectivity$/i })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /^temp250$/i })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /^temp300$/i })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /^rh250$/i })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /^rh300$/i })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /500 mb Rel Vort/ })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /10:1 Snow/ })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /MUCIN/ })).toHaveCount(0);
});

test("parameter menu keeps winter placeholders when parameter metadata is absent", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latestPointer("20260216-1800Z", "manifests/gfs/v4-no-parameter-metadata.json")),
    });
  });
  await page.route("**/__cf/manifests/gfs/v4-no-parameter-metadata.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260216-1800Z",
        view: "conus",
        generatedAt: "2026-02-16T18:10:00Z",
        referenceTime: "2026-02-16T18:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded" },
        frames: [
          {
            hour: 0,
            validHourKey: "2026-02-16T18:00:00Z",
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
      }),
    });
  });

  await page.goto("/");
  await expect(page.locator("article").first()).toBeVisible();
  await page
    .getByRole("button", { name: /Parameters/ })
    .first()
    .click();

  await expect(page.getByText("Winter / Snow & Ice").first()).toBeVisible();
  await expect(page.getByText("Snow Depth").first()).toBeVisible();
  await expect(page.getByText("10:1 Snow").first()).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /10:1 Snow/ })).toBeDisabled();

  const scrollPanel = page.getByTestId("parameter-menu-scroll");
  await scrollPanel.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });

  const wrapperOverflow = await page
    .getByTestId("parameter-menu-wrapper")
    .evaluate((node) => getComputedStyle(node).overflowY);
  expect(wrapperOverflow).not.toBe("hidden");
  await expect(page.getByText("FRAM Radial Ice").first()).toBeVisible();
});
