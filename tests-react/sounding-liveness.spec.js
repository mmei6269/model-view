const { test, expect } = require("./helpers/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";

const GFS_RUN = "20260701-0000Z";
const HRRR_RUN = "20260701-0600Z";

// Frames at caller-picked hour offsets from now (same shape as keyboard-shortcuts.spec.js).
// Frame labels are F000, F006, F012, ... regardless of the offsets.
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

async function routeGfs(page, valids) {
  await page.route("**/__cf/manifests/gfs/latest.json**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: GFS_RUN,
        view: "conus",
        generatedAt: valids[0],
        manifestKey: "manifests/gfs/p.json",
        frameCount: valids.length,
      }),
    }),
  );
  await page.route("**/__cf/manifests/gfs/p.json**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildManifest("gfs", GFS_RUN, valids)),
    }),
  );
}

// Broad match across every candidate artifact base URL (see manifest-lifecycle.spec.js):
// otherwise the client falls through to the direct data server where real hrrr fixtures exist.
async function routeHrrr(page, valids) {
  await page.route("**/manifests/hrrr/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/latest.json")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          model: "hrrr",
          run: HRRR_RUN,
          view: "conus",
          generatedAt: valids[0],
          manifestKey: "manifests/hrrr/p.json",
          frameCount: valids.length,
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
      body: JSON.stringify(buildManifest("hrrr", HRRR_RUN, valids)),
    });
  });
}

// On-demand point-sounding endpoint mock. Echoes the requested model/run/hour
// and lat/lon so re-samples are observable, and records every hit in
// `requests` so tests can count endpoint traffic.
async function routeSounding(page, requests) {
  await page.route("**/soundings/**", (route) => {
    const url = new URL(route.request().url());
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.indexOf("soundings");
    const model = parts[index + 1];
    const run = decodeURIComponent(parts[index + 2]);
    const hour = Number(parts[index + 3]);
    requests.push({ model, run, hour, url: url.toString() });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model,
        modelLabel: model.toUpperCase(),
        run,
        forecastHour: hour,
        validTime: null,
        lat: Number(url.searchParams.get("lat")),
        lon: Number(url.searchParams.get("lon")),
        levels: [],
        indices: {},
        warnings: [],
      }),
    });
  });
}

function frameLabel(page) {
  return page.getByTestId("frame-label");
}

async function waitForLabel(page, text) {
  await expect(frameLabel(page)).toHaveText(text, { timeout: 15000 });
}

function drawerCloseButton(page) {
  return page.getByRole("button", { name: "Close sounding" });
}

async function openSoundingDrawer(page) {
  const container = page.locator('[data-testid="map-canvas-host"]').first();
  await container.dblclick();
  await expect(drawerCloseButton(page)).toBeVisible({ timeout: 15000 });
  // The map focuses its keyboard surface (the inner canvas) on click and
  // consumes arrow keys for panning (Task 4.4's host keydown guard stops
  // them leaking to app shortcuts). Blur whatever owns focus rather than the
  // host — matching a user whose focus is on the page body, so ArrowRight
  // reaches the app-level frame-step shortcut.
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
}

function followToggle(page) {
  return page.getByLabel("Follow timeline");
}

function soundingFrameLabel(page) {
  return page.getByTestId("sounding-frame-label");
}

function staleNotice(page) {
  return page.getByTestId("sounding-stale-notice");
}

function recenterButton(page) {
  return page.getByLabel("Recenter map on sounding point");
}

test("follow toggle defaults off and a pinned drawer does not re-request on frame step", async ({ page }) => {
  const valids = frameSetAt([0, 6, 12]);
  const requests = [];
  await routeGfs(page, valids);
  await routeSounding(page, requests);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await openSoundingDrawer(page);
  await expect(soundingFrameLabel(page)).toHaveText("F000");
  expect(requests.length).toBe(1);

  await expect(followToggle(page)).toBeVisible();
  await expect(followToggle(page)).not.toBeChecked();

  await page.keyboard.press("ArrowRight");
  await waitForLabel(page, "F006");
  // Give a would-be debounced re-request time to fire, then confirm it did not.
  await page.waitForTimeout(700);
  expect(requests.length).toBe(1);
  // The drawer stays pinned to the hour it sampled.
  await expect(soundingFrameLabel(page)).toHaveText("F000");
});

test("with follow timeline on, stepping issues one debounced re-request and updates the drawer hour", async ({
  page,
}) => {
  const valids = frameSetAt([0, 6, 12]);
  const requests = [];
  await routeGfs(page, valids);
  await routeSounding(page, requests);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await openSoundingDrawer(page);
  expect(requests.length).toBe(1);

  await followToggle(page).check();
  await expect(followToggle(page)).toBeChecked();
  // Move focus off the checkbox so arrow keys reach the global shortcut handler.
  await followToggle(page).blur();

  await page.keyboard.press("ArrowRight");
  await waitForLabel(page, "F006");
  // Debounced (~350 ms) re-request lands and the drawer follows to the new hour.
  await expect(soundingFrameLabel(page)).toHaveText("F006", { timeout: 15000 });
  expect(requests.length).toBe(2);
  expect(requests[1].hour).toBe(6);
  // Exactly one re-request: nothing else trickles in after the debounce window.
  await page.waitForTimeout(700);
  expect(requests.length).toBe(2);
});

test("changing the panel model surfaces a stale notice and Refresh re-requests against the new model/run", async ({
  page,
}) => {
  const valids = frameSetAt([0, 6, 12]);
  const requests = [];
  await routeGfs(page, valids);
  await routeHrrr(page, valids);
  await routeSounding(page, requests);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await openSoundingDrawer(page);
  expect(requests.length).toBe(1);
  expect(requests[0].model).toBe("gfs");
  await expect(staleNotice(page)).toHaveCount(0);

  const panel = page.locator("article").first();
  await panel.getByLabel("Model", { exact: true }).selectOption("hrrr");

  // The drawer must never silently keep showing the old model's profile:
  // a visible stale notice with a Refresh action appears.
  await expect(staleNotice(page)).toBeVisible({ timeout: 15000 });
  await expect(staleNotice(page).getByRole("button", { name: "Refresh" })).toBeVisible();
  // But no auto-refresh: the user decides.
  await page.waitForTimeout(700);
  expect(requests.length).toBe(1);

  // Wait for the HRRR manifest frame to be current before refreshing.
  await expect(panel.locator("footer")).toContainText("noaa-hrrr", { timeout: 15000 });
  await staleNotice(page).getByRole("button", { name: "Refresh" }).click();

  await expect(staleNotice(page)).toHaveCount(0, { timeout: 15000 });
  await expect.poll(() => requests.length, { timeout: 15000 }).toBe(2);
  expect(requests[1].model).toBe("hrrr");
  expect(requests[1].run).toBe(HRRR_RUN);
  await expect(page.getByRole("heading", { name: "HRRR Point Sounding" })).toBeVisible();
});

test("recenter affordance appears only for manually typed coordinates and recenters the map", async ({ page }) => {
  const valids = frameSetAt([0, 6, 12]);
  const requests = [];
  await routeGfs(page, valids);
  await routeSounding(page, requests);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  // Double-click-derived point: no recenter affordance.
  await openSoundingDrawer(page);
  await expect(recenterButton(page)).toHaveCount(0);

  // Manually typed coordinates: the affordance appears.
  await page.getByLabel("Sounding latitude").fill("41");
  await page.getByLabel("Sounding longitude").fill("-104");
  await page.getByRole("button", { name: "Go" }).click();
  await expect(recenterButton(page)).toBeVisible({ timeout: 15000 });

  // Zoom in before recentering: at the default view fit the whole map is
  // pinned by maxBounds, so a recenter jump cannot move the center at all.
  // With panning freedom, the bridge viewport asserts the user-visible
  // outcome: the center lands on the typed point.
  const zoomIn = page.getByTestId("map-zoom-in").first();
  for (let i = 0; i < 3; i += 1) {
    await zoomIn.click();
    await page.waitForTimeout(150);
  }
  await recenterButton(page).click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const bridge = window.__wx;
          if (!bridge || bridge.panels().length === 0) {
            return null;
          }
          return bridge.getViewport(bridge.panels()[0]);
        }),
      { timeout: 15000 },
    )
    .toEqual(expect.objectContaining({ lat: expect.closeTo(41, 0), lon: expect.closeTo(-104, 0) }));
});
