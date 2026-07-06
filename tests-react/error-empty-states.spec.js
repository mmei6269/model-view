const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

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
  await page.locator(".leaflet-container").first().dblclick();

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
