const { test, expect } = require("./helpers/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";

// Frames at caller-picked hour offsets from now (same shape as default-frame.spec.js).
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

function frameLabel(page) {
  return page.getByTestId("frame-label");
}

async function waitForLabel(page, text) {
  await expect(frameLabel(page)).toHaveText(text, { timeout: 15000 });
}

// Waits for one playback advance (any frame-label change).
async function waitForOneAdvance(page) {
  const current = await frameLabel(page).textContent();
  await expect.poll(() => frameLabel(page).textContent(), { timeout: 15000, intervals: [50] }).not.toBe(current);
}

test("2x halves the scheduled advance interval and playback advances at both speeds", async ({ page }) => {
  // Wall-clock speed ratios are NOT assertable here: on slow CI shards the
  // per-advance render cost (2-3 s under software GL) dwarfs the 600/300 ms
  // timer, so 1x and 2x take indistinguishable wall time — measured medians
  // of 2692 ms (2x) vs 3077 ms (1x) on a shard that failed the old ratio
  // assert, with the retry even measuring 2x slower than 1x. The scheduling
  // contract (interval = base / speed) is asserted exactly via the play
  // button's data-playback-interval-ms; advancing at all is the behavioral
  // smoke at each speed.
  const valids = frameSetAt([-6, 0, 6, 12, 18, 24, 30, 36]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  const playButton = page.getByRole("button", { name: /Play timeline|Pause playback/ });
  await expect(playButton).toHaveAttribute("data-playback-interval-ms", "600");
  await playButton.click();
  await waitForOneAdvance(page);
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();

  await page.getByRole("button", { name: "2\u00d7", exact: true }).click();
  await expect(playButton).toHaveAttribute("data-playback-interval-ms", "300");
  await playButton.click();
  await waitForOneAdvance(page);
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();

  // 0.5x recovers the pre-rebase pace: the attribute must track any speed.
  await page.getByRole("button", { name: "0.5\u00d7", exact: true }).click();
  await expect(playButton).toHaveAttribute("data-playback-interval-ms", "1200");
});
test("Next and Previous frame buttons step by one while paused", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[1])}`);
  await waitForLabel(page, "F006");

  await page.getByRole("button", { name: "Next frame" }).click();
  await waitForLabel(page, "F012");

  await page.getByRole("button", { name: "Previous frame" }).click();
  await waitForLabel(page, "F006");

  await page.getByRole("button", { name: "Previous frame" }).click();
  await waitForLabel(page, "F000");
});

test("prev at the first frame wraps to the last; next at the last wraps to the first", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await page.getByRole("button", { name: "Previous frame" }).click();
  await waitForLabel(page, "F018");

  await page.getByRole("button", { name: "Next frame" }).click();
  await waitForLabel(page, "F000");
});

test("playback schedules a last-frame dwell before wrapping to the first", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.__modelViewScheduledTimeouts = [];
    window.setTimeout = (callback, delay = 0, ...args) => {
      window.__modelViewScheduledTimeouts.push(Number(delay));
      return nativeSetTimeout(callback, delay, ...args);
    };
  });
  const valids = frameSetAt([-6, 0, 6]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[1])}`);
  await waitForLabel(page, "F006");
  await expect(page.getByRole("button", { name: /Frames 3\/3/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[aria-label^="Loaded"]')).toHaveText("Loaded 3/3", { timeout: 30_000 });

  await page.evaluate(() => {
    window.__modelViewScheduledTimeouts = [];
  });

  await page.getByRole("button", { name: "Play timeline", exact: true }).click();
  // F006 gets the normal 600 ms interval. Landing on the last frame schedules
  // the 600 ms base interval plus its 900 ms dwell. Assert the requested
  // delays instead of comparing wall-clock observations: Playwright begins
  // observing F012 only after the dwell timer is already in flight, and a
  // loaded-status transition can independently delay the first advance.
  await waitForLabel(page, "F012");
  await expect
    .poll(() => page.evaluate(() => window.__modelViewScheduledTimeouts), { timeout: 10_000 })
    .toEqual(expect.arrayContaining([600, 1500]));
  await waitForLabel(page, "F000");
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();
});
