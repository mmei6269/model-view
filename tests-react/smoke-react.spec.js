const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";
const ONE_BY_ONE_BYTES = Buffer.from(ONE_BY_ONE.split(",")[1], "base64");

function encodeInt16(values) {
  return Buffer.from(Int16Array.from(values).buffer).toString("base64");
}

function buildHoverGridPayload(rows, cols, valuesByVariable) {
  const total = rows * cols;
  const fallback = new Array(total).fill(-32768);
  const makeVariable = (values, scale = 1, offset = 0) => ({
    scale,
    offset,
    missing: -32768,
    data: encodeInt16(values || fallback),
  });
  return {
    schemaVersion: 1,
    rows,
    cols,
    variables: {
      temperatureF: makeVariable(valuesByVariable.temperatureF),
      windKt: makeVariable(valuesByVariable.windKt),
      precipMm: makeVariable(valuesByVariable.precipMm),
      capeJkg: makeVariable(valuesByVariable.capeJkg),
      pressureHpa: makeVariable(valuesByVariable.pressureHpa),
    },
  };
}

function baseManifestFrame(overrides = {}) {
  return {
    hour: 0,
    validHourKey: "2026-02-16T00:00:00Z",
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
    ...overrides,
  };
}

function extractLastNumber(text) {
  const matches = String(text || "").match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) {
    return Number.NaN;
  }
  return Number(matches[matches.length - 1]);
}

function extractLatitudeFromCoordinateLabel(text) {
  const match = String(text || "").match(/(\d+(?:\.\d+)?)°([NS])/);
  if (!match) {
    return Number.NaN;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  return match[2] === "S" ? -value : value;
}

async function setCheckboxState(page, checkbox, checked) {
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

function latToMercatorY(latDeg) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, Number(latDeg)));
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI * 0.25 + rad * 0.5));
}

function mercatorSouthwardFraction(lat, north, south) {
  const northY = latToMercatorY(north);
  const southY = latToMercatorY(south);
  const targetY = latToMercatorY(lat);
  if (![northY, southY, targetY].every(Number.isFinite) || Math.abs(southY - northY) < 1e-12) {
    return Number.NaN;
  }
  return (targetY - northY) / (southY - northY);
}

test("react map panel smoke and frame menu status", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/Run\s+\d{4}-\d{2}-\d{2}\s+\d{2}z/)).toBeVisible();

  const framesButton = panel.getByRole("button", { name: /Frames/ }).first();
  await framesButton.click();
  await expect(panel.locator("button", { hasText: "000" }).first()).toBeVisible();

  const statusLoaded = panel.locator("button.bg-cyan-500\\/20").first();
  await expect(statusLoaded).toBeVisible();

  await setCheckboxState(page, panel.getByRole("checkbox", { name: /Composite Reflectivity/ }), true);
  await expect(page.getByText("Composite Reflectivity (dBZ)")).toBeVisible();
});

test("run selector defaults to latest and can pin an older available run", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/runs.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        view: "conus",
        runs: [
          {
            model: "gfs",
            run: "20260314-0000Z",
            view: "conus",
            generatedAt: "2026-03-14T00:10:00Z",
            manifestKey: "manifests/gfs/20260314-0000Z.json?view=conus",
            frameCount: 1,
            loadedFrameCount: 1,
            complete: true,
            latest: true,
          },
          {
            model: "gfs",
            run: "20260313-0000Z",
            view: "conus",
            generatedAt: "2026-03-13T00:10:00Z",
            manifestKey: "manifests/gfs/20260313-0000Z.json?view=conus",
            frameCount: 1,
            loadedFrameCount: 1,
            complete: true,
            latest: false,
          },
        ],
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260314-0000Z",
        view: "conus",
        generatedAt: "2026-03-14T00:10:00Z",
        manifestKey: "manifests/gfs/20260314-0000Z.json?view=conus",
        frameCount: 1,
      }),
    });
  });
  for (const run of ["20260314-0000Z", "20260313-0000Z"]) {
    await page.route(`**/__cf/manifests/gfs/${run}.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 4,
          model: "gfs",
          run,
          view: "conus",
          generatedAt: "2026-03-14T00:10:00Z",
          referenceTime: run === "20260314-0000Z" ? "2026-03-14T00:00:00Z" : "2026-03-13T00:00:00Z",
          openDataModel: "noaa-gfs-pgrb2-0p25",
          hourStatus: { 0: "loaded" },
          frames: [
            baseManifestFrame({
              validHourKey: run === "20260314-0000Z" ? "2026-03-14T00:00:00Z" : "2026-03-13T00:00:00Z",
            }),
          ],
        }),
      });
    });
  }

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.getByText(/Run\s+2026-03-14\s+00z/)).toBeVisible();

  await panel.getByLabel("Run", { exact: true }).selectOption("20260313-0000Z");
  await expect(panel.getByText(/Run\s+2026-03-13\s+00z/)).toBeVisible();
});

test("initial load renders at least one weather overlay without layer toggles", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel).toBeVisible();

  await expect
    .poll(
      async () =>
        page.$$eval(
          ".leaflet-image-layer.wx-weather-overlay",
          (elements) =>
            elements.filter((element) => {
              const image = element;
              const style = window.getComputedStyle(image);
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                Number(style.opacity || "1") > 0 &&
                image.naturalWidth > 0 &&
                image.naturalHeight > 0
              );
            }).length,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
});

test("synoptic remains above parameter panes after toggles", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator("article").first();

  await setCheckboxState(page, panel.getByRole("checkbox", { name: /Composite Reflectivity/ }), true);
  await setCheckboxState(page, panel.getByRole("checkbox", { name: /1-h Precip/ }), true);
  await page.waitForTimeout(1200);

  const paneOrder = await page.evaluate(() => {
    const paneNames = [
      "leaflet-wx-temp-pane-pane",
      "leaflet-wx-wind-pane-pane",
      "leaflet-wx-precip-pane-pane",
      "leaflet-wx-reflectivity-pane-pane",
      "leaflet-wx-synoptic-thickness-pane-pane",
      "leaflet-wx-synoptic-isobar-pane-pane",
      "leaflet-wx-synoptic-marker-pane-pane",
    ];
    const order = {};
    for (const name of paneNames) {
      const pane = document.querySelector(`.${name}`);
      order[name] = pane ? Number(getComputedStyle(pane).zIndex || 0) : null;
    }
    return order;
  });

  expect(paneOrder["leaflet-wx-synoptic-thickness-pane-pane"]).toBeGreaterThan(
    paneOrder["leaflet-wx-reflectivity-pane-pane"],
  );
  expect(paneOrder["leaflet-wx-synoptic-isobar-pane-pane"]).toBeGreaterThan(
    paneOrder["leaflet-wx-synoptic-thickness-pane-pane"],
  );
  expect(paneOrder["leaflet-wx-synoptic-marker-pane-pane"]).toBeGreaterThan(
    paneOrder["leaflet-wx-synoptic-isobar-pane-pane"],
  );
});

test("reflectivity gate selector switches gate mode", async ({ page }) => {
  await page.goto("/");
  const gateSelect = page.locator("label:has-text('Refl Gate') select").first();
  await expect(gateSelect).toBeVisible();
  await gateSelect.selectOption("20");
  await expect(gateSelect).toHaveValue("20");
  await gateSelect.selectOption("15");
  await expect(gateSelect).toHaveValue("15");
});

test("isobar detail selector switches synoptic vector key from simple to detailed", async ({ page }) => {
  let simpleHits = 0;
  let detailedHits = 0;
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-0000Z",
        view: "conus",
        generatedAt: "2026-02-16T00:10:00Z",
        manifestKey: "manifests/gfs/synoptic-detail-toggle.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/synoptic-detail-toggle.json**", async (route) => {
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
          baseManifestFrame({
            synopticVectorKey: "fixtures/gfs/synoptic-detail/simple.json",
            synopticVectorKeys: {
              simple: "fixtures/gfs/synoptic-detail/simple.json",
              detailed: "fixtures/gfs/synoptic-detail/detailed.json",
            },
            synopticVectorBytes: {
              simple: 2,
              detailed: 2,
            },
            synopticStyleVersion: "v4-operational-contrast",
            synopticStyleVersions: {
              simple: "v4-operational-contrast",
              detailed: "v4-operational-contrast",
            },
            layers: {
              temperature: {
                key: "",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
              synoptic: {
                key: "",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
            },
          }),
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/synoptic-detail/simple.json**", async (route) => {
    simpleHits += 1;
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
  await page.route("**/__cf/fixtures/gfs/synoptic-detail/detailed.json**", async (route) => {
    detailedHits += 1;
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

  await page.goto("/");
  await expect.poll(() => simpleHits).toBeGreaterThan(0);
  await expect.poll(() => detailedHits, { timeout: 5_000 }).toBeGreaterThan(0);

  const detailSelect = page.locator("label:has-text('Isobar Detail') select").first();
  await expect(detailSelect).toBeVisible();
  await expect(detailSelect).toHaveValue("simple");
  await detailSelect.selectOption("detailed");
  await expect(detailSelect).toHaveValue("detailed");
});

test("weather overlays render in raw pixel mode", async ({ page }) => {
  await page.goto("/");
  const css = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (rule.selectorText === ".leaflet-image-layer.wx-weather-overlay") {
          return rule.cssText;
        }
      }
    }
    return "";
  });
  expect(css).toContain("image-rendering: pixelated");
});

test("panel timeline mode tracks selected panel independently", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add Map" }).click();

  const panels = page.locator("article");
  await expect(panels).toHaveCount(2);

  const firstFooter = panels.nth(0).locator("footer span").nth(1);
  const secondFooter = panels.nth(1).locator("footer span").nth(1);
  await expect.poll(async () => (await firstFooter.textContent()) || "", { timeout: 15_000 }).not.toContain("Valid --");
  await expect
    .poll(async () => (await secondFooter.textContent()) || "", { timeout: 15_000 })
    .not.toContain("Valid --");
  const firstBefore = (await firstFooter.textContent()) || "";
  const secondBefore = (await secondFooter.textContent()) || "";

  const axisSelect = page.locator("section").last().locator("label:has-text('Axis') select");
  await axisSelect.selectOption("panel");

  const trackSelect = page.locator("section").last().locator("label:has-text('Track') select");
  await trackSelect.selectOption({ index: 1 });

  const slider = page.locator("section").last().locator("input[type='range']");
  await expect
    .poll(async () => Number((await slider.getAttribute("max")) || "0"), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const sliderValueBefore = Number(await slider.inputValue());
  const sliderMax = Number((await slider.getAttribute("max")) || "0");
  const key = sliderValueBefore >= sliderMax ? "ArrowLeft" : "ArrowRight";
  await slider.focus();
  await slider.press(key);
  await expect.poll(async () => (await secondFooter.textContent()) || "", { timeout: 15_000 }).not.toBe(secondBefore);
  const firstAfter = (await firstFooter.textContent()) || "";
  const secondAfter = (await secondFooter.textContent()) || "";
  expect(secondAfter).not.toBe(secondBefore);
  expect(firstAfter).toBe(firstBefore);
});

test("hover values render instantly from local hover grid and never hit a point forecast API", async ({ page }) => {
  let pointApiHits = 0;
  page.on("request", (request) => {
    if (request.url().includes("/v1/forecast")) {
      pointApiHits += 1;
    }
  });
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-0000Z",
        view: "conus",
        generatedAt: "2026-02-16T00:10:00Z",
        manifestKey: "manifests/gfs/hover-test.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/hover-test.json**", async (route) => {
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
          baseManifestFrame({
            hoverGridKey: "fixtures/gfs/hover-test/hover-grid.json.gz",
            hoverGridSchemaVersion: 1,
          }),
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/hover-test/hover-grid.json.gz**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        buildHoverGridPayload(2, 2, {
          temperatureF: [50, 60, 70, 80],
          windKt: [5, 10, 15, 20],
          precipMm: [0.5, 1.5, 2.5, 3.5],
          capeJkg: [50, 200, 350, 500],
          pressureHpa: [1000, 999, 998, 997],
        }),
      ),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  const map = panel.locator(".leaflet-container").first();
  const mapBox = await map.boundingBox();
  if (!mapBox) {
    throw new Error("Map container bounding box is unavailable.");
  }
  await page.mouse.move(mapBox.x + mapBox.width - 120, mapBox.y + 120);

  await expect(panel.locator("p", { hasText: "Temp" }).first()).not.toContainText("--");
  await expect(panel.locator("p", { hasText: "MSLP" }).first()).not.toContainText("--");
  await page.waitForTimeout(350);
  expect(pointApiHits).toBe(0);
});

test("hover temperature sampling follows Mercator row mapping", async ({ page }) => {
  const bounds = { north: 53, south: 21, west: -129, east: -63 };
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260217-0000Z",
        view: "conus",
        generatedAt: "2026-02-17T00:10:00Z",
        manifestKey: "manifests/gfs/hover-mercator.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/hover-mercator.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260217-0000Z",
        view: "conus",
        generatedAt: "2026-02-17T00:10:00Z",
        referenceTime: "2026-02-17T00:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded" },
        frames: [
          baseManifestFrame({
            bounds,
            hoverGridKey: "fixtures/gfs/hover-mercator/hover-grid.json.gz",
            hoverGridSchemaVersion: 1,
          }),
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/hover-mercator/hover-grid.json.gz**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        buildHoverGridPayload(2, 2, {
          temperatureF: [0, 0, 100, 100],
          windKt: [0, 0, 0, 0],
          precipMm: [0, 0, 0, 0],
          capeJkg: [0, 0, 0, 0],
          pressureHpa: [1000, 1000, 1000, 1000],
        }),
      ),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  const map = panel.locator(".leaflet-container").first();
  const mapBox = await map.boundingBox();
  if (!mapBox) {
    throw new Error("Map container bounding box is unavailable.");
  }

  await page.mouse.move(mapBox.x + mapBox.width * 0.5, mapBox.y + mapBox.height * 0.5);

  const tempLine = panel.locator("p", { hasText: "Temp" }).first();
  await expect(tempLine).not.toContainText("--");
  const coordLine = panel
    .locator("p")
    .filter({ hasText: /°[NS]\s+\d+(?:\.\d+)?°[EW]/ })
    .first();
  await expect(coordLine).toBeVisible();

  const lat = extractLatitudeFromCoordinateLabel(await coordLine.textContent());
  const sampledTemp = extractLastNumber(await tempLine.textContent());
  expect(Number.isFinite(lat)).toBeTruthy();
  expect(Number.isFinite(sampledTemp)).toBeTruthy();

  const linearFraction = (bounds.north - lat) / (bounds.north - bounds.south);
  const mercatorFraction = mercatorSouthwardFraction(lat, bounds.north, bounds.south);
  const linearExpected = linearFraction * 100;
  const mercatorExpected = mercatorFraction * 100;

  expect(Math.abs(sampledTemp - mercatorExpected)).toBeLessThanOrEqual(1.2);
  expect(Math.abs(sampledTemp - linearExpected)).toBeGreaterThan(2);
});

test("frame status reaches loaded after visual assets even while hover is pending", async ({ page }) => {
  let releaseVector;
  let releaseHover;
  const vectorGate = new Promise((resolve) => {
    releaseVector = resolve;
  });
  const hoverGate = new Promise((resolve) => {
    releaseHover = resolve;
  });

  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-0600Z",
        view: "conus",
        generatedAt: "2026-02-16T06:10:00Z",
        manifestKey: "manifests/gfs/prefetch-ready.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/prefetch-ready.json**", async (route) => {
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
        frames: [
          baseManifestFrame({
            synopticVectorKey: "fixtures/gfs/prefetch-ready/synoptic-vector.json",
            synopticVectorBytes: {
              simple: 2,
              detailed: 2,
            },
            hoverGridKey: "fixtures/gfs/prefetch-ready/hover-grid.json.gz",
            hoverGridSchemaVersion: 1,
          }),
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/prefetch-ready/synoptic-vector.json**", async (route) => {
    await vectorGate;
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
  await page.route("**/__cf/fixtures/gfs/prefetch-ready/hover-grid.json.gz**", async (route) => {
    await hoverGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        buildHoverGridPayload(2, 2, {
          temperatureF: [55, 55, 55, 55],
          windKt: [10, 10, 10, 10],
          precipMm: [1, 1, 1, 1],
          capeJkg: [100, 100, 100, 100],
          pressureHpa: [1000, 1000, 1000, 1000],
        }),
      ),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await panel
    .getByRole("button", { name: /Frames/ })
    .first()
    .click();
  const frameChip = panel.getByRole("button", { name: "000" }).first();

  await expect.poll(async () => (await frameChip.getAttribute("class")) || "").not.toContain("bg-cyan-500/20");
  releaseVector();
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-cyan-500/20");
  releaseHover();
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .not.toContain("bg-rose-500/20");
});

test("transient prefetch failures stay selectable and recover after direct frame load", async ({ page }) => {
  let futureTempHits = 0;

  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-0700Z",
        view: "conus",
        generatedAt: "2026-02-16T07:10:00Z",
        manifestKey: "manifests/gfs/retryable-status.json",
        frameCount: 2,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/retryable-status.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260216-0700Z",
        view: "conus",
        generatedAt: "2026-02-16T07:10:00Z",
        referenceTime: "2026-02-16T07:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded", 3: "loaded" },
        frames: [
          baseManifestFrame({
            hour: 0,
            validHourKey: "2026-02-16T07:00:00Z",
            layers: {
              temperature: {
                key: "fixtures/gfs/retryable-status/temp-000.png",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          }),
          baseManifestFrame({
            hour: 3,
            validHourKey: "2026-02-16T10:00:00Z",
            layers: {
              temperature: {
                key: "fixtures/gfs/retryable-status/temp-003.png",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          }),
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/retryable-status/temp-000.png**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: ONE_BY_ONE_BYTES,
    });
  });
  await page.route("**/__cf/fixtures/gfs/retryable-status/temp-003.png**", async (route) => {
    futureTempHits += 1;
    if (futureTempHits <= 2) {
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        headers: { "cache-control": "no-store" },
        body: "temporary prefetch failure",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: ONE_BY_ONE_BYTES,
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await panel
    .getByRole("button", { name: /Frames/ })
    .first()
    .click();
  const futureFrameChip = panel.getByRole("button", { name: "003" }).first();

  await expect.poll(() => futureTempHits, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  await expect
    .poll(async () => (await futureFrameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-rose-500/20");
  await expect(futureFrameChip).toBeEnabled();

  await futureFrameChip.click();
  await expect.poll(() => futureTempHits, { timeout: 5_000 }).toBeGreaterThan(2);
  await expect
    .poll(async () => (await futureFrameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-cyan-500/20");
  await expect(page.getByText("Loaded 2/2")).toBeVisible({ timeout: 5_000 });
});

test("layer deselect/reselect during in-flight prefetch does not turn error or false-loaded", async ({ page }) => {
  let releaseTemp;
  const tempGate = new Promise((resolve) => {
    releaseTemp = resolve;
  });

  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-0900Z",
        view: "conus",
        generatedAt: "2026-02-16T09:10:00Z",
        manifestKey: "manifests/gfs/toggle-churn.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/toggle-churn.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260216-0900Z",
        view: "conus",
        generatedAt: "2026-02-16T09:10:00Z",
        referenceTime: "2026-02-16T09:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded" },
        frames: [
          baseManifestFrame({
            layers: {
              temperature: {
                key: "fixtures/gfs/toggle-churn/temp.png",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
              },
              reflectivity: {
                key: "fixtures/gfs/toggle-churn/refl.png",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          }),
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/toggle-churn/temp.png**", async (route) => {
    await tempGate;
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: ONE_BY_ONE_BYTES,
    });
  });
  await page.route("**/__cf/fixtures/gfs/toggle-churn/refl.png**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: ONE_BY_ONE_BYTES,
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await panel
    .getByRole("button", { name: /Frames/ })
    .first()
    .click();
  const frameChip = panel.getByRole("button", { name: "000" }).first();
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-sky-500/20");

  const temperatureCheckbox = panel.getByRole("checkbox", { name: /Temp/ }).first();
  await setCheckboxState(page, temperatureCheckbox, false);
  await setCheckboxState(page, temperatureCheckbox, true);
  await page.waitForTimeout(200);

  const classBeforeRelease = (await frameChip.getAttribute("class")) || "";
  expect(classBeforeRelease).not.toContain("bg-rose-500/20");
  expect(classBeforeRelease).not.toContain("bg-cyan-500/20");

  releaseTemp();
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-cyan-500/20");
});

test("model switch does not inherit stale error from aborted prior prefetch run", async ({ page }) => {
  let releaseGfsTemp;
  const gfsTempGate = new Promise((resolve) => {
    releaseGfsTemp = resolve;
  });

  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-1500Z",
        view: "conus",
        generatedAt: "2026-02-16T15:10:00Z",
        manifestKey: "manifests/gfs/model-switch-stale.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/model-switch-stale.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260216-1500Z",
        view: "conus",
        generatedAt: "2026-02-16T15:10:00Z",
        referenceTime: "2026-02-16T15:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded" },
        frames: [
          baseManifestFrame({
            layers: {
              temperature: {
                key: "fixtures/gfs/model-switch-stale/temp.png",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          }),
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/model-switch-stale/temp.png**", async (route) => {
    await gfsTempGate;
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: ONE_BY_ONE_BYTES,
    });
  });

  await page.route("**/__cf/manifests/hrrr/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "hrrr",
        run: "20260216-1600Z",
        view: "conus",
        generatedAt: "2026-02-16T16:10:00Z",
        manifestKey: "manifests/hrrr/model-switch-stale.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/hrrr/model-switch-stale.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "hrrr",
        run: "20260216-1600Z",
        view: "conus",
        generatedAt: "2026-02-16T16:10:00Z",
        referenceTime: "2026-02-16T16:00:00Z",
        openDataModel: "noaa-hrrr-wrfprs",
        hourStatus: { 0: "loaded" },
        frames: [
          baseManifestFrame({
            layers: {
              temperature: {
                key: "",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          }),
        ],
      }),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await panel
    .getByRole("button", { name: /Frames/ })
    .first()
    .click();
  const frameChip = panel.getByRole("button", { name: "000" }).first();
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-sky-500/20");

  await panel.locator("select").first().selectOption("hrrr");
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-cyan-500/20");
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .not.toContain("bg-rose-500/20");

  releaseGfsTemp();
});

test("switching away and back reuses prefetched gfs layer for instant return", async ({ page }) => {
  let gfsTempHits = 0;

  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-1800Z",
        view: "conus",
        generatedAt: "2026-02-16T18:10:00Z",
        manifestKey: "manifests/gfs/model-return-cache.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/model-return-cache.json**", async (route) => {
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
          baseManifestFrame({
            layers: {
              temperature: {
                key: "fixtures/gfs/model-return-cache/temp.png",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          }),
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/model-return-cache/temp.png**", async (route) => {
    gfsTempHits += 1;
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: {
        "cache-control": "no-store",
      },
      body: ONE_BY_ONE_BYTES,
    });
  });

  await page.route("**/__cf/manifests/nam3km/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "nam3km",
        run: "20260216-1800Z",
        view: "conus",
        generatedAt: "2026-02-16T18:10:00Z",
        manifestKey: "manifests/nam3km/model-return-cache.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/nam3km/model-return-cache.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "nam3km",
        run: "20260216-1800Z",
        view: "conus",
        generatedAt: "2026-02-16T18:10:00Z",
        referenceTime: "2026-02-16T18:00:00Z",
        openDataModel: "noaa-nam-awphys",
        hourStatus: { 0: "loaded" },
        frames: [
          baseManifestFrame({
            layers: {
              temperature: {
                key: "",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
                url: ONE_BY_ONE,
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          }),
        ],
      }),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await panel
    .getByRole("button", { name: /Frames/ })
    .first()
    .click();
  const frameChip = panel.getByRole("button", { name: "000" }).first();
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-cyan-500/20");
  await expect.poll(() => gfsTempHits, { timeout: 5_000 }).toBeGreaterThan(0);
  const baselineHits = gfsTempHits;

  await panel.locator("select").first().selectOption("nam3km");
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-cyan-500/20");

  await panel.locator("select").first().selectOption("gfs");
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-cyan-500/20");
  await page.waitForTimeout(500);
  expect(gfsTempHits).toBe(baselineHits);
});

test("center marker pressure stays consistent with hover pressure at marker location", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-1200Z",
        view: "conus",
        generatedAt: "2026-02-16T12:10:00Z",
        manifestKey: "manifests/gfs/center-consistency.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/center-consistency.json**", async (route) => {
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
        frames: [
          baseManifestFrame({
            synopticVectorKey: "fixtures/gfs/center-consistency/synoptic-vector.json",
            synopticCenters: {
              highs: [],
              lows: [{ lat: 38, lon: -97, valueHpa: 985 }],
            },
            hoverGridKey: "fixtures/gfs/center-consistency/hover-grid.json.gz",
            hoverGridSchemaVersion: 1,
          }),
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/center-consistency/synoptic-vector.json**", async (route) => {
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
  await page.route("**/__cf/fixtures/gfs/center-consistency/hover-grid.json.gz**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        buildHoverGridPayload(2, 2, {
          temperatureF: [45, 45, 45, 45],
          windKt: [8, 8, 8, 8],
          precipMm: [0, 0, 0, 0],
          capeJkg: [0, 0, 0, 0],
          pressureHpa: [985, 985, 985, 985],
        }),
      ),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  const markerValueEl = panel.locator(".pressure-marker-value").first();
  await expect(markerValueEl).toBeVisible();
  const markerValue = extractLastNumber(await markerValueEl.textContent());
  expect(Number.isFinite(markerValue)).toBeTruthy();

  const markerBox = await panel.locator(".pressure-marker-icon").first().boundingBox();
  if (!markerBox) {
    throw new Error("Pressure marker bounding box is unavailable.");
  }
  await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
  const mslpLine = panel.locator("p", { hasText: "MSLP" }).first();
  await expect(mslpLine).toContainText("hPa");
  const hoverPressure = extractLastNumber(await mslpLine.textContent());
  expect(Math.abs(hoverPressure - markerValue)).toBeLessThanOrEqual(1);
});
