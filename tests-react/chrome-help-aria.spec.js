const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

// Frames at caller-picked hour offsets from now (same shape as keyboard-shortcuts.spec.js).
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

async function routeModel(page, model, valids) {
  await page.route(`**/__cf/manifests/${model}/latest.json**`, (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model,
        run: "20260701-0000Z",
        view: "conus",
        generatedAt: valids[0],
        manifestKey: `manifests/${model}/p.json`,
        frameCount: valids.length,
      }),
    }),
  );
  await page.route(`**/__cf/manifests/${model}/p.json**`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(buildManifest(model, valids)) }),
  );
}

async function waitForLabel(page, text) {
  await expect(page.getByTestId("frame-label")).toHaveText(text, { timeout: 15000 });
}

function helpDialog(page) {
  return page.getByRole("dialog", { name: /help/i });
}

// A point over the map background: left of the panel chrome (which starts at
// left-14 = 56px), below the header, above the timeline.
const OUTSIDE_POINT = { x: 20, y: 420 };

test("Help button and ? open the help dialog; outside click and Esc close it", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeModel(page, "gfs", valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  const trigger = page.getByRole("button", { name: "Help" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(helpDialog(page)).toBeVisible();
  // The dialog documents soundings and the keyboard map.
  await expect(helpDialog(page)).toContainText("Double-click");
  await expect(helpDialog(page)).toContainText("Space");

  // Clicking outside dismisses it.
  await page.mouse.click(OUTSIDE_POINT.x, OUTSIDE_POINT.y);
  await expect(helpDialog(page)).toHaveCount(0);

  // The ? shortcut reopens it; Escape closes it.
  await page.keyboard.press("?");
  await expect(helpDialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(helpDialog(page)).toHaveCount(0);
});

test("Parameters menu collapses when clicking the map background", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeModel(page, "gfs", valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  const toggle = page.getByRole("button", { name: /^Parameters \d+$/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("parameter-menu-wrapper")).toHaveCSS("opacity", "1");

  await page.mouse.click(OUTSIDE_POINT.x, OUTSIDE_POINT.y);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
});

test("play button exposes Play timeline / Pause playback aria-labels", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeModel(page, "gfs", valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  const play = page.getByRole("button", { name: "Play timeline", exact: true });
  const pause = page.getByRole("button", { name: "Pause playback", exact: true });
  await expect(play).toBeVisible();
  await play.click();
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(play).toBeVisible();
});

test("disabled Add Map button explains the two-map limit", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeModel(page, "gfs", valids);
  await routeModel(page, "nam3km", valids);
  await page.goto("/");
  await expect(page.locator("article")).toHaveCount(1);

  const addMap = page.getByRole("button", { name: "Add Map" });
  await expect(addMap).toBeEnabled();
  await addMap.click();
  await expect(page.locator("article")).toHaveCount(2);
  await expect(addMap).toBeDisabled();
  await expect(addMap).toHaveAttribute("title", "Maximum 2 maps");
});
