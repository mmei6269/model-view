const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

// Frames at now-6h, now, now+6h. Nearest-to-now must select the middle frame.
function frameSet() {
  const now = Date.now();
  const iso = (ms) => new Date(Math.floor(ms / 3600000) * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [iso(now - 6 * 3600000), iso(now), iso(now + 6 * 3600000)];
}

// Same shape as frameSet(), but with caller-picked hour offsets from now.
function frameSetAt(offsetHours) {
  const now = Date.now();
  const iso = (ms) => new Date(Math.floor(ms / 3600000) * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return offsetHours.map((offset) => iso(now + offset * 3600000));
}

function buildManifest(model, valids, hourStatus) {
  return {
    schemaVersion: 4,
    model,
    run: "20260701-0000Z",
    view: "conus",
    generatedAt: valids[0],
    referenceTime: valids[0],
    openDataModel: "noaa-gfs-pgrb2-0p25",
    hourStatus: hourStatus || Object.fromEntries(valids.map((_, i) => [i * 6, "loaded"])),
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

async function routeGfs(page, valids, hourStatus) {
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
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildManifest("gfs", valids, hourStatus)),
    }),
  );
}

test("initial frame defaults to the frame nearest to now, not F000", async ({ page }) => {
  const valids = frameSet();
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

  await page.goto("/");
  // The current-frame chip shows F006 (middle frame), not F000. The label
  // renders in the header summary, panel chip, and timeline chip, so pick the
  // first match to satisfy strict mode.
  await expect(page.locator("text=/F0*6\\b/").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator("text=F000")).toHaveCount(0);
});

test("URL hour param wins over nearest-to-now on load", async ({ page }) => {
  const valids = frameSet();
  await routeGfs(page, valids);

  // Bookmarked hour = the future frame (hour 12). Distinct from both the old
  // F000 default and the nearest-to-now frame (F006), so this only passes if
  // the URL hour is actually applied.
  await page.goto(`/?hour=${encodeURIComponent(valids[2])}`);
  await expect(page.locator("text=F012").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator("text=F006")).toHaveCount(0);
  await expect(page.locator("text=F000")).toHaveCount(0);
});

test("an unavailable nearest-to-now frame is skipped for the nearest available frame", async ({ page }) => {
  // Frames at now-12h, now, now+6h; the nearest-to-now frame (hour 6) is
  // marked unavailable, so the pick must fall to the future frame (hour 12,
  // ~6h away) rather than the stale one (hour 0, ~12h away).
  const valids = frameSetAt([-12, 0, 6]);
  await routeGfs(page, valids, { 0: "loaded", 6: "unavailable", 12: "loaded" });

  await page.goto("/");
  await expect(page.locator("text=F012").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator("text=F006")).toHaveCount(0);
});
