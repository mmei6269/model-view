const { test, expect } = require("./helpers/test");
const { routeBasemapFixture } = require("./helpers/basemap-fixture");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";

const GFS_RUN = "20260701-0000Z";

// Frames at caller-picked hour offsets from now (same shape as sounding-liveness.spec.js).
function frameSetAt(offsetHours) {
  const now = Date.now();
  const iso = (ms) => new Date(Math.floor(ms / 3600000) * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return offsetHours.map((offset) => iso(now + offset * 3600000));
}

function buildManifest(model, run, valids) {
  return {
    schemaVersion: 4,
    model,
    run,
    view: "conus",
    generatedAt: valids[0],
    referenceTime: valids[0],
    openDataModel: `noaa-${model}`,
    hourStatus: Object.fromEntries(valids.map((_, i) => [i * 6, "loaded"])),
    frames: valids.map((valid, i) => ({
      hour: i * 6,
      validHourKey: valid,
      bounds: { north: 53, south: 21, west: -129, east: -63 },
      cols: 1600,
      rows: 980,
      layers: { temperature: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE } },
    })),
  };
}

function latestPointer(valids) {
  return {
    model: "gfs",
    run: GFS_RUN,
    view: "conus",
    generatedAt: valids[0],
    manifestKey: "manifests/gfs/p.json",
    frameCount: valids.length,
  };
}

function runsPayload(valids) {
  return {
    runs: [
      {
        model: "gfs",
        run: GFS_RUN,
        view: "conus",
        generatedAt: valids[0],
        manifestKey: "manifests/gfs/p.json",
        frameCount: valids.length,
        loadedFrameCount: valids.length,
        complete: true,
        latest: true,
      },
    ],
  };
}

// Broad match across every candidate artifact base URL (see manifest-lifecycle.spec.js):
// otherwise the client falls through to the direct data server where real fixtures exist.
async function routeGfsHealthy(page, valids) {
  await page.route("**/manifests/gfs/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/latest.json")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(latestPointer(valids)),
      });
      return;
    }
    if (url.includes("/runs.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runsPayload(valids)) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildManifest("gfs", GFS_RUN, valids)),
    });
  });
}

test("run-list failure surfaces a humanized error card whose Retry clears it", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  // A run-list error only surfaces when the manifest fallback fails too, so the
  // outage covers every gfs artifact endpoint until `healthy` flips; after the
  // flip the same routes serve good payloads so Retry can succeed.
  let healthy = false;
  await page.route("**/manifests/gfs/**", async (route) => {
    const url = route.request().url();
    if (!healthy) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
      return;
    }
    if (url.includes("/latest.json")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(latestPointer(valids)),
      });
      return;
    }
    if (url.includes("/runs.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runsPayload(valids)) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildManifest("gfs", GFS_RUN, valids)),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  const runError = panel.getByTestId("run-list-error");
  await expect(runError).toBeVisible({ timeout: 20000 });
  // Humanized copy: one readable line, never the raw multi-URL failover dump.
  await expect(runError).not.toContainText("http");
  const retry = panel.getByTestId("run-list-retry");
  await expect(retry).toBeVisible();

  healthy = true;
  await retry.click();
  await expect(panel.getByTestId("run-list-error")).toHaveCount(0, { timeout: 15000 });
});

test("sounding failure shows a humanized single-line message instead of the raw URL dump", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeGfsHealthy(page, valids);
  const rawDump =
    "Unable to build sounding. Tried: https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20260701/00/atmos/a.grib2 " +
    "| https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20260701/00/atmos/b.grib2 " +
    "| https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20260701/00/atmos/c.grib2";
  await page.route("**/soundings/**", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: rawDump }) }),
  );

  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await expect(page.getByTestId("frame-label")).toHaveText("F000", { timeout: 15000 });
  await page.locator('[data-testid="map-canvas-host"]').first().dblclick();

  const errorRegion = page.getByTestId("sounding-error");
  await expect(errorRegion).toBeVisible({ timeout: 15000 });
  const text = ((await errorRegion.textContent()) || "").trim();
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toContain("http");
  expect(text).not.toContain("\n");
  expect(text.length).toBeLessThan(rawDump.length);
});

test("an empty artifact cache surfaces the noaa:update onboarding hint", async ({ page }) => {
  const nowIso = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  await page.route("**/manifests/gfs/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/latest.json")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          model: "gfs",
          run: GFS_RUN,
          view: "conus",
          generatedAt: nowIso,
          manifestKey: "manifests/gfs/p.json",
          frameCount: 0,
        }),
      });
      return;
    }
    if (url.includes("/runs.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [] }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...buildManifest("gfs", GFS_RUN, []), generatedAt: nowIso, referenceTime: nowIso }),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.getByText("npm run noaa:update")).toBeVisible({ timeout: 20000 });
  // Genuine empty cache: no error cards, just the onboarding hint.
  await expect(panel.getByTestId("run-list-error")).toHaveCount(0);
  await expect(panel.getByTestId("manifest-error")).toHaveCount(0);
});

// ── MapLibre engine fatal states (Task 5.2) ──────────────────────────────────
// The engine has no fallback basemap, so failures must be loud, legible, and
// honest about the fix: a missing/unreachable PMTiles basemap names the
// one-command fix; repeated GL context loss points at the GPU instead. A
// transient basemap outage must also UN-stick without a remount once the
// server recovers (the engine retries on the next camera gesture).

test("basemap outage shows the fetch banner; recovery on the next gesture clears it", async ({ page }) => {
  // The kill-switch registers AFTER the fixture route so Playwright consults
  // it first; once healthy it falls back to the fixture handler.
  let basemapDown = true;
  let servedAfterRecovery = 0;
  await routeBasemapFixture(page);
  await page.route("**/basemap/*.pmtiles", async (route) => {
    if (basemapDown) {
      await route.abort("connectionrefused");
      return;
    }
    servedAfterRecovery += 1;
    await route.fallback();
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  const banner = panel.getByTestId("engine-fatal-error");
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).toContainText("npm run basemap:fetch");
  // The banner must PERSIST while the outage lasts: maplibre flips an errored
  // source to isSourceLoaded=true, and a clear keyed on that synthetic event
  // vanished the banner milliseconds after it appeared (live drill finding).
  await page.waitForTimeout(1000);
  await expect(banner).toBeVisible();

  // Server comes back; the next camera gesture (zoom fires moveend) triggers
  // the engine's basemap retry and the banner clears with no remount.
  basemapDown = false;
  await panel.getByTestId("map-zoom-in").click();
  await expect(banner).toHaveCount(0, { timeout: 15000 });
  // Honesty check on the recovery: the retry must have actually RE-FETCHED
  // the archive (pmtiles pins a failed header fetch as a cached rejection, so
  // a cleared banner without a network re-fetch would be the synthetic-clear
  // bug again, not a recovery).
  expect(servedAfterRecovery).toBeGreaterThan(0);
});

test("repeated GL context loss shows the GPU-oriented fatal banner, not the basemap hint", async ({ page }) => {
  // Collected from the start: the whole run — cap included, and the post-cap
  // Display changes below — must never leak an unhandled error to the page.
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await routeBasemapFixture(page);
  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.getByTestId("panel-status")).toHaveText("Ready", { timeout: 30000 });

  // Force context loss on whatever canvas is live; the engine self-heals
  // twice (recreate), then the third loss exceeds the budget and goes fatal.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.evaluate(() => {
      const canvas = document.querySelector("[data-testid=map-canvas-host] canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      gl.getExtension("WEBGL_lose_context").loseContext();
    });
    // The recreate defers out of the event dispatch (setTimeout 0) and boots
    // a fresh map; give it a beat before losing the next context.
    await page.waitForTimeout(400);
  }

  const banner = panel.getByTestId("engine-fatal-error");
  await expect(banner).toBeVisible({ timeout: 10000 });
  await expect(banner).toContainText(/GPU/);
  await expect(banner).not.toContainText("basemap:fetch");

  // Post-cap, the capped engine disposed its dead map, but the panel stays
  // mounted under the banner with mapReady true — its display effects keep
  // driving engine verbs. A user Display change must therefore no-op inside
  // the gave-up engine (never throw into a live React effect): the banner
  // persists, and no error escapes to the page. Theme select exercises
  // setBasemap; the border-mode flip exercises setBasemapBoundaries plus the
  // reference-overlay cleanup's removeLayer.
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByRole("combobox", { name: "Basemap", exact: true }).selectOption("dark");
  await page.getByLabel("Borders").selectOption("basemap");
  await page.waitForTimeout(400);
  expect(pageErrors).toEqual([]);
  await expect(banner).toBeVisible();
});

test("WebGL unavailable at boot shows the webgl-init fatal banner instead of crashing the app", async ({ page }) => {
  // Task 6.1 (pre-flip hardening): maplibre's Map constructor throws
  // synchronously ("Failed to initialize WebGL") when the canvas cannot
  // produce a GL context — a machine with WebGL disabled/blocklisted.
  // Simulate exactly that by nulling GL context creation before any app code
  // runs; 2d contexts stay untouched. Without the constructor wrap the throw
  // escapes the panel's boot effect, React unmounts the tree, and the page
  // fires an unhandled error — so this asserts both the classed banner AND
  // zero pageerrors with the chrome still alive.
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") {
        return null;
      }
      return original.call(this, type, ...rest);
    };
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  const banner = panel.getByTestId("engine-fatal-error");
  await expect(banner).toBeVisible({ timeout: 15000 });
  await expect(banner).toContainText(/WebGL could not be initialized/);
  await expect(banner).not.toContainText("basemap:fetch");
  // The app survived the boot failure: header chrome still mounted and
  // interactive, no unhandled errors anywhere in the run.
  await expect(page.getByRole("button", { name: "Display", exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
