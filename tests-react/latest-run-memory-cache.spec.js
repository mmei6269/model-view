const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";
const ONE_BY_ONE_BYTES = Buffer.from(ONE_BY_ONE.split(",")[1], "base64");
const MODELS = ["gfs", "nam", "nam3km", "hrrr"];

function encodeInt16(values) {
  return Buffer.from(Int16Array.from(values).buffer).toString("base64");
}

function buildHoverGridPayload() {
  return {
    schemaVersion: 1,
    rows: 1,
    cols: 1,
    variables: {
      temperatureF: { scale: 1, offset: 0, missing: -32768, data: encodeInt16([50]) },
      windKt: { scale: 1, offset: 0, missing: -32768, data: encodeInt16([10]) },
      precipMm: { scale: 1, offset: 0, missing: -32768, data: encodeInt16([0]) },
      capeJkg: { scale: 1, offset: 0, missing: -32768, data: encodeInt16([100]) },
      pressureHpa: { scale: 1, offset: 0, missing: -32768, data: encodeInt16([1000]) },
    },
  };
}

function frame(model, hour) {
  const padded = String(hour).padStart(3, "0");
  return {
    hour,
    validHourKey: `2026-04-23T${String(12 + hour / 3).padStart(2, "0")}:00:00Z`,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    cols: 1600,
    rows: 980,
    layers: {
      temperature: {
        key: `fixtures/${model}/full-memory-cache/${padded}/temperature.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
      wind: {
        key: `fixtures/${model}/full-memory-cache/${padded}/wind.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
      precip: {
        key: `fixtures/${model}/full-memory-cache/${padded}/precip.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
      snow10to1: {
        key: `fixtures/${model}/full-memory-cache/${padded}/snow10to1.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
      synoptic: {
        key: `fixtures/${model}/full-memory-cache/${padded}/synoptic.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
    },
    reflectivityVariants: {
      dbz15: {
        key: `fixtures/${model}/full-memory-cache/${padded}/reflectivity-15.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
      dbz20: {
        key: `fixtures/${model}/full-memory-cache/${padded}/reflectivity-20.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
    },
    synopticVectorKeys: {
      simple: `fixtures/${model}/full-memory-cache/${padded}/synoptic-simple.json`,
      detailed: `fixtures/${model}/full-memory-cache/${padded}/synoptic-detailed.json`,
    },
    synopticStyleVersions: {
      simple: "v4-operational-contrast",
      detailed: "v4-operational-contrast",
    },
    hoverGridKey: `fixtures/${model}/full-memory-cache/${padded}/hover-grid.json.gz`,
    hoverGridSchemaVersion: 1,
  };
}

async function routeWarmupFixtures(page) {
  const fixtureRequests = new Set();
  const fixtureRequestCounts = new Map();

  for (const model of MODELS) {
    await page.route(`**/__cf/manifests/${model}/latest.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          model,
          run: "20260423-1200Z",
          view: "conus",
          generatedAt: "2026-04-23T12:10:00Z",
          manifestKey: `manifests/${model}/full-memory-cache.json`,
          frameCount: 2,
        }),
      });
    });
    await page.route(`**/__cf/manifests/${model}/full-memory-cache.json**`, async (route) => {
      await route.fulfill({
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
          hourStatus: { 0: "loaded", 3: "loaded" },
          frames: [frame(model, 0), frame(model, 3)],
        }),
      });
    });
  }
  await page.route("**/__cf/fixtures/**/full-memory-cache/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    fixtureRequests.add(pathname);
    fixtureRequestCounts.set(pathname, (fixtureRequestCounts.get(pathname) || 0) + 1);
    if (pathname.includes("hover-grid")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildHoverGridPayload()),
      });
      return;
    }
    if (pathname.endsWith(".json")) {
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
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: ONE_BY_ONE_BYTES,
    });
  });

  return { fixtureRequests, fixtureRequestCounts };
}

function expectedFixturePaths() {
  // Warmup is scoped to the panels' active layers (temperature + synoptic by default),
  // the current gate, and the current synoptic detail mode — not the full cross-product.
  const paths = [];
  for (const model of MODELS) {
    for (const hour of [0, 3]) {
      const padded = String(hour).padStart(3, "0");
      for (const name of ["temperature.png", "synoptic.png", "synoptic-simple.json", "hover-grid.json.gz"]) {
        paths.push(`/__cf/fixtures/${model}/full-memory-cache/${padded}/${name}`);
      }
    }
  }
  return paths.sort();
}

test("latest view memory warmup covers active layers on every model and makes model switching instant", async ({
  page,
}) => {
  const { fixtureRequests, fixtureRequestCounts } = await routeWarmupFixtures(page);

  await page.goto("/");
  await expect(page.locator("article").first().getByText("Ready")).toBeVisible();

  await expect.poll(() => Array.from(fixtureRequests).sort(), { timeout: 10_000 }).toEqual(expectedFixturePaths());

  const panel = page.locator("article").first();
  const hrrrTemperaturePath = "/__cf/fixtures/hrrr/full-memory-cache/000/temperature.png";
  const hrrrTemperatureHitsBeforeSwitch = fixtureRequestCounts.get(hrrrTemperaturePath) || 0;
  await panel.locator("select").first().selectOption("hrrr");
  await expect(panel.getByRole("button", { name: /Frames 2\/2/ }).first()).toBeVisible({ timeout: 1_000 });
  await expect(page.getByText("Loaded 2/2")).toBeVisible({ timeout: 1_000 });
  await page.waitForTimeout(300);
  expect(fixtureRequestCounts.get(hrrrTemperaturePath)).toBe(hrrrTemperatureHitsBeforeSwitch);
});

test("selecting a snow layer warms it across every model", async ({ page }) => {
  const { fixtureRequests } = await routeWarmupFixtures(page);

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.getByText("Ready")).toBeVisible();
  await expect.poll(() => Array.from(fixtureRequests).sort(), { timeout: 10_000 }).toEqual(expectedFixturePaths());

  await panel.getByRole("button", { name: /Parameters/ }).click();
  const snowCheckbox = panel.getByRole("checkbox", { name: /10:1 Snow/ });
  await snowCheckbox.focus();
  await page.keyboard.press("Space");
  await expect(snowCheckbox).toBeChecked();

  const expectedSnowPaths = [];
  for (const model of MODELS) {
    for (const hour of [0, 3]) {
      expectedSnowPaths.push(
        `/__cf/fixtures/${model}/full-memory-cache/${String(hour).padStart(3, "0")}/snow10to1.png`,
      );
    }
  }
  await expect
    .poll(() => expectedSnowPaths.filter((path) => fixtureRequests.has(path)).length, { timeout: 10_000 })
    .toBe(expectedSnowPaths.length);
});
