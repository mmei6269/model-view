const { PNG } = require("pngjs");
const { test, expect } = require("./helpers/test");
const { routeBasemapFixture } = require("./helpers/basemap-fixture");

// ── Offline-boot guarantee (Task 5.2, spec §1/§7.3) ──────────────────────────
// The app must boot and render FULLY offline on a maplibre panel: local
// PMTiles basemap (the committed CONUS fixture via the shared helper),
// vendored glyphs/sprites at the app origin, weather frames from the react
// harness's local artifact fixture cache (127.0.0.1:5174). This spec blocks
// every request that is not localhost/127.0.0.1 at the context level and then
// asserts, in the strongest available form, that nothing off-machine was ever
// needed:
//
//   (a) the basemap actually PAINTED — a pixel probe on the map canvas
//       screenshot (light theme: paper-white land over Kansas vs steel-blue
//       Gulf water, plus a distinct-color floor so a flat canvas can't pass);
//   (b) basemap place-label layers are present AND visible in the live style
//       (bridge getBasemapLabelLayers — basemap symbol layers are deliberately
//       not in getLayerOrder), corroborated by successful app-origin glyph
//       fetches (MapLibre only requests glyph ranges when it lays out real
//       label text) and a successful sprite fetch;
//   (c) ZERO blocked non-localhost requests (the app must not merely survive
//       offline, it must not ASK for the network at all), zero failed
//       localhost requests, zero 4xx/5xx localhost responses;
//   (d) a weather frame renders from the harness's artifact-server fixture
//       routes: panel Ready + the temperature layer's load event via the
//       bridge (the harness serves manifests/frames/hover grids locally, so
//       full weather boot is honestly available offline).

// Web-mercator screen projection at NATIVE maplibre zoom — the scale the
// bridge's getViewport reports since Task 6.2: world width = 512 * 2^zoom px.
function projectToBox(viewport, box, lat, lon) {
  const scale = 512 * Math.pow(2, viewport.zoom);
  const mercY = (deg) => Math.log(Math.tan(Math.PI / 4 + (deg * Math.PI) / 360));
  return {
    x: box.width / 2 + ((lon - viewport.lon) / 360) * scale,
    y: box.height / 2 + ((mercY(viewport.lat) - mercY(lat)) / (2 * Math.PI)) * scale,
  };
}

// Average RGB of a (2r+1)x(2r+1) patch, so thin strokes (state borders, roads)
// and label antialiasing can't skew a single-pixel read.
function patchAverage(png, cx, cy, r = 2) {
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = cy - r; y <= cy + r; y += 1) {
    for (let x = cx - r; x <= cx + r; x += 1) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
        continue;
      }
      const i = (y * png.width + x) * 4;
      red += png.data[i];
      green += png.data[i + 1];
      blue += png.data[i + 2];
      count += 1;
    }
  }
  return { r: red / count, g: green / count, b: blue / count };
}

// Distinct quantized colors over a sampling grid: a blank/monochrome canvas
// yields a handful; a painted basemap (land, water, landcover tints, roads,
// boundaries, label ink) yields far more.
function distinctColorCount(png, step = 16) {
  const seen = new Set();
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const i = (y * png.width + x) * 4;
      seen.add(`${png.data[i] >> 3},${png.data[i + 1] >> 3},${png.data[i + 2] >> 3}`);
    }
  }
  return seen.size;
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

function isLocalhost(url) {
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

// Blob object URLs are page-local memory (weather frames are handed to the
// GL engine as blob: URLs); their hostname parses empty, so treat them as
// on-machine explicitly — a failed blob fetch (e.g. a revoked object URL) is
// a local failure this spec must catch.
function isAppLocal(url) {
  return url.startsWith("blob:") || isLocalhost(url);
}

test("the app boots and renders fully offline", async ({ page, context }) => {
  const blockedRequests = [];
  const failedLocalRequests = [];
  const badLocalResponses = [];
  const glyphResponses = [];
  const spriteResponses = [];

  // Block-all FIRST, then the basemap fixture: Playwright consults handlers in
  // reverse registration order, so the fixture route fields pmtiles requests
  // and everything else lands here — localhost falls through to the network
  // (route.fallback()), anything off-machine is recorded and aborted.
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (isLocalhost(url)) {
      await route.fallback();
      return;
    }
    blockedRequests.push(url);
    await route.abort("blockedbyclient");
  });
  await routeBasemapFixture(context);

  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown";
    // The app deliberately ABORTS superseded prefetches (frame churn during
    // the default-frame jump; covered by the abort-race suite) — an abort is
    // app policy, not a failure. Anything else on-machine is a real failure:
    // this caught a revoked-object-URL race (net::ERR_FILE_NOT_FOUND on the
    // engine's blob fetch) during Task 5.2.
    if (failure === "net::ERR_ABORTED") {
      return;
    }
    if (isAppLocal(request.url())) {
      failedLocalRequests.push(`${request.url()} (${failure})`);
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 400) {
      badLocalResponses.push(`${response.status()} ${url}`);
    }
    if (url.includes("/basemap/fonts/")) {
      glyphResponses.push({ url, ok: response.ok() });
    }
    if (url.includes("/basemap/sprites/")) {
      spriteResponses.push({ url, ok: response.ok() });
    }
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.getByTestId("panel-status")).toHaveText("Ready", { timeout: 30_000 });

  const panelId = await page.evaluate(() => window.__wx.panels()[0]);

  // (d) Weather from the harness's local artifact fixture cache: the default
  // temperature layer is active and its CURRENT frame url fired the engine's
  // load event (the same signal that drives the timeline chips).
  expect(await page.evaluate((id) => window.__wx.getActiveWeatherLayers(id), panelId)).toContain("temperature");
  await expect
    .poll(() => page.evaluate((id) => window.__wx.isWeatherLoaded(id, "temperature"), panelId), { timeout: 15_000 })
    .toBe(true);

  // (b) Place/label layers present + visible in the LIVE style. Basemap
  // symbol layers are deliberately excluded from getLayerOrder (it tracks app
  // layers), so this reads the dedicated bridge accessor; with default detail
  // flags (cities off) the orientation tiers must still be there.
  const labelLayers = await page.evaluate((id) => window.__wx.getBasemapLabelLayers(id), panelId);
  expect(labelLayers.length).toBeGreaterThan(0);
  expect(labelLayers).toContain("places_country");
  expect(labelLayers).toContain("places_region");

  // (b) corroboration: label text actually laid out (glyph ranges are only
  // fetched on demand) and the sprite sheet loaded, all from the app origin.
  await expect.poll(() => glyphResponses.length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(glyphResponses.filter((entry) => !entry.ok)).toEqual([]);
  expect(spriteResponses.length).toBeGreaterThan(0);
  expect(spriteResponses.filter((entry) => !entry.ok)).toEqual([]);

  // (a) The basemap painted. The fixture weather PNG is an opaque gray that
  // covers CONUS, so switch the temperature layer off first — the probe must
  // measure basemap pixels, not the weather raster.
  await panel.getByRole("button", { name: /Parameters/ }).click();
  await setCheckboxState(page, panel.getByRole("checkbox", { name: /Temp/ }).first(), false);
  await page.keyboard.press("Escape");

  const host = panel.getByTestId("map-canvas-host");
  const probeBasemap = async () => {
    const box = await host.boundingBox();
    const png = PNG.sync.read(await host.screenshot());
    const pixelScale = png.width / box.width;
    const viewport = await page.evaluate((id) => window.__wx.getViewport(id), panelId);
    const at = (lat, lon) => {
      const point = projectToBox(viewport, box, lat, lon);
      return patchAverage(png, Math.round(point.x * pixelScale), Math.round(point.y * pixelScale));
    };
    return {
      land: at(38.5, -98.5), // central Kansas: near-white paper on the light default
      water: at(25.5, -90), // Gulf of Mexico: steel-blue water fill
      distinct: distinctColorCount(png),
    };
  };

  await expect
    .poll(async () => {
      const probe = await probeBasemap();
      const landSum = probe.land.r + probe.land.g + probe.land.b;
      const waterSum = probe.water.r + probe.water.g + probe.water.b;
      return {
        landIsPaper: Math.min(probe.land.r, probe.land.g, probe.land.b) > 200,
        waterIsBlue: probe.water.b - probe.water.r > 12,
        landBrighterThanWater: landSum - waterSum > 30,
        notMonochrome: probe.distinct >= 6,
      };
    })
    .toEqual({ landIsPaper: true, waterIsBlue: true, landBrighterThanWater: true, notMonochrome: true });

  // (c) Strongest form: the app never even ASKED for anything off-machine,
  // and nothing it did ask for failed or errored.
  expect(blockedRequests).toEqual([]);
  expect(failedLocalRequests).toEqual([]);
  expect(badLocalResponses).toEqual([]);
});
