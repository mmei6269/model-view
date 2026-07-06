const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

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
  await page.locator(".leaflet-container").first().dblclick();
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
