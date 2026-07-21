const { test, expect } = require("./helpers/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";

// Frames at caller-picked hour offsets from now (same shape as timeline-playback.spec.js).
// Frame labels are F000, F006, F012, ... regardless of the offsets.
function frameSetAt(offsetHours) {
  const now = Date.now();
  const iso = (ms) => new Date(Math.floor(ms / 3600000) * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return offsetHours.map((offset) => iso(now + offset * 3600000));
}

function buildManifest(model, valids) {
  return {
    schemaVersion: 4,
    model,
    run: "20260701-0000Z",
    view: "conus",
    generatedAt: valids[0],
    referenceTime: valids[0],
    openDataModel: "noaa-gfs-pgrb2-0p25",
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
        run: "20260701-0000Z",
        view: "conus",
        generatedAt: valids[0],
        manifestKey: "manifests/gfs/p.json",
        frameCount: valids.length,
      }),
    }),
  );
  await page.route("**/__cf/manifests/gfs/p.json**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(buildManifest("gfs", valids)) }),
  );
}

// On-demand point-sounding endpoint mock; an empty profile keeps the drawer
// open in its "no profile" state, which is all the shortcut tests need.
async function routeSounding(page, valids) {
  await page.route("**/__cf/soundings/**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        modelLabel: "GFS",
        run: "20260701-0000Z",
        forecastHour: 0,
        validTime: valids[0],
        lat: 39,
        lon: -98,
        levels: [],
        indices: {},
        warnings: [],
      }),
    }),
  );
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
  await page.locator('[data-testid="map-canvas-host"]').first().dblclick();
  await expect(drawerCloseButton(page)).toBeVisible({ timeout: 15000 });
}

test("ArrowRight advances the frame and ArrowLeft steps back", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[1])}`);
  await waitForLabel(page, "F006");

  await page.keyboard.press("ArrowRight");
  await waitForLabel(page, "F012");

  await page.keyboard.press("ArrowLeft");
  await waitForLabel(page, "F006");
});

test("Space toggles play and pause", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await expect(page.getByRole("button", { name: "Play timeline", exact: true })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Pause playback", exact: true })).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play timeline", exact: true })).toBeVisible();
});

test("Escape closes the sounding drawer", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeGfs(page, valids);
  await routeSounding(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await openSoundingDrawer(page);
  await page.keyboard.press("Escape");
  await expect(drawerCloseButton(page)).toHaveCount(0);
});

test("Escape closes an open header menu", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await page.getByRole("button", { name: "Display" }).click();
  await expect(page.getByText("Weather Opacity")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Weather Opacity")).toHaveCount(0);
});

test("typing shortcuts are suppressed in the sounding coordinate input, but Escape still closes", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeGfs(page, valids);
  await routeSounding(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await openSoundingDrawer(page);
  await page.getByLabel("Sounding latitude").click();
  await page.keyboard.press("ArrowRight");
  // Negative assertion: give a would-be frame step time to land, then confirm it did not.
  await page.waitForTimeout(300);
  await expect(frameLabel(page)).toHaveText("F000");
  // Space types into the input rather than toggling playback.
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "Play timeline", exact: true })).toBeVisible();

  // Escape is the exception (WAI-ARIA dialog pattern): it closes the drawer
  // even while the lat/lon input has focus.
  await page.keyboard.press("Escape");
  await expect(drawerCloseButton(page)).toHaveCount(0);

  // With the drawer gone and focus back on the page, keys act again.
  await page.keyboard.press("ArrowRight");
  await waitForLabel(page, "F006");
});

test("Space on a focused button activates the button instead of toggling playback", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await page.getByRole("button", { name: "Display" }).focus();
  await page.keyboard.press("Space");
  // Native activation: the focused Display button opens its menu.
  await expect(page.getByText("Weather Opacity")).toBeVisible();
  // And playback was not toggled.
  await expect(page.getByRole("button", { name: "Play timeline", exact: true })).toBeVisible();
});

test("Escape closes the drawer but leaves the persisted settings strip open", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeGfs(page, valids);
  await routeSounding(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  // The settings strip is open by default (session-persisted).
  await expect(page.getByRole("button", { name: "Link Viewports" })).toBeVisible();

  await openSoundingDrawer(page);
  await page.keyboard.press("Escape");
  await expect(drawerCloseButton(page)).toHaveCount(0);
  // The strip stays open: Escape only closes transient surfaces.
  await expect(page.getByRole("button", { name: "Link Viewports" })).toBeVisible();
});

test("? toggles the help popover", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await expect(page.getByTestId("help-popover")).toHaveCount(0);
  await page.keyboard.press("?");
  await expect(page.getByTestId("help-popover")).toBeVisible();
  await page.keyboard.press("?");
  await expect(page.getByTestId("help-popover")).toHaveCount(0);
});

// ── Map-focused keyboard guard (Task 4.4 regression) ─────────────────────────
// Invariant: while focus is inside the map host, arrow keys navigate the MAP
// and must never also reach the app's window-level frame-step shortcut
// (useKeyboardShortcuts). MapLibre's KeyboardHandler lets handled keydowns
// bubble, so the engine adds a host-level keydown guard (maplibre-engine.ts
// create()) that swallows MAP_NAV_KEYS. These specs pin that contract: if
// the guard were dropped, or the app shortcut listener moved to capture
// phase (ahead of the guard), ArrowRight on a focused map would double-fire
// (pan + frame step) and the first spec below fails.

function mapHost(page) {
  return page.locator('[data-testid="map-canvas-host"]').first();
}

function readViewport(page) {
  return page.evaluate(() => {
    const bridge = window.__wx;
    if (!bridge || bridge.panels().length === 0) {
      return null;
    }
    return bridge.getViewport(bridge.panels()[0]);
  });
}

// Click-focus the map (the canvas is tabindex 0 and takes focus natively on
// mousedown), then confirm focus really is inside the host — the whole guard
// contract is scoped to keys targeted inside it.
async function focusMap(page) {
  await mapHost(page).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = document.querySelector('[data-testid="map-canvas-host"]');
        return host ? host.contains(document.activeElement) : false;
      }),
    )
    .toBe(true);
}

// Zoom in until maxBounds stops pinning the camera: at the default fit view
// the engine clamps keyboard pans to a zero offset (its instant maxBounds
// constraint — see the recenter spec in sounding-liveness.spec.js), so
// camera-delta assertions need panning freedom first. The trailing wait lets
// the last zoom easing settle so the pan baseline read afterwards is stable.
async function zoomInForPanFreedom(page) {
  const zoomIn = page.getByTestId("map-zoom-in").first();
  for (let i = 0; i < 3; i += 1) {
    await zoomIn.click();
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(500);
}

test("ArrowRight with the map focused pans the camera and does not step the frame", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[1])}`);
  await waitForLabel(page, "F006");

  await zoomInForPanFreedom(page);
  await focusMap(page);
  const before = await readViewport(page);
  expect(before).not.toBeNull();

  await page.keyboard.press("ArrowRight");

  // The camera panned east (keyboard pans are animated on both engines, so
  // poll until the easing shows).
  await expect
    .poll(async () => {
      const now = await readViewport(page);
      return now ? now.lon - before.lon : 0;
    })
    .toBeGreaterThan(0);
  // ...and the frame-step shortcut never fired (negative assertion: give a
  // would-be step time to land, then confirm the label is unchanged).
  await page.waitForTimeout(300);
  await expect(frameLabel(page)).toHaveText("F006");
});

test("ArrowRight with focus outside the map steps the frame and leaves the camera alone", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[1])}`);
  await waitForLabel(page, "F006");

  // Same panning freedom as the focused-map spec, so "camera did not move"
  // is a real assertion rather than a maxBounds pin.
  await zoomInForPanFreedom(page);
  // Drop focus from the zoom button back to body.
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
  const before = await readViewport(page);
  expect(before).not.toBeNull();

  await page.keyboard.press("ArrowRight");
  await waitForLabel(page, "F012");

  // Any keyboard pan would still be easing at this point; give it time to
  // show, then confirm the camera never moved.
  await page.waitForTimeout(500);
  const after = await readViewport(page);
  expect(after).toEqual(before);
});

test("Shift+ArrowRight with the map focused never reaches the frame-step shortcut", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeGfs(page, valids);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto(`/?hour=${encodeURIComponent(valids[1])}`);
  await waitForLabel(page, "F006");

  await zoomInForPanFreedom(page);
  await focusMap(page);
  await page.keyboard.press("Shift+ArrowRight");

  // Shift+arrow is MapLibre's rotation binding, disabled via
  // keyboard.disableRotation() in this 2D app, so no camera action results.
  // The invariant is that the key stays inside the map: the app shortcut
  // treats shift+arrow as a bare arrow (only meta/ctrl/alt are exempt), so
  // any leak would step the frame.
  await page.waitForTimeout(300);
  await expect(frameLabel(page)).toHaveText("F006");
  expect(pageErrors).toEqual([]);
});
