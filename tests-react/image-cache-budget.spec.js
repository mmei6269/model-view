const { test, expect } = require("@playwright/test");

const GIB = 1024 * 1024 * 1024;
const ONE_BY_ONE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==",
  "base64",
);

test("image prefetch cache budgets default to 2 GiB object-URL and 4 GiB decoded", async ({ page }) => {
  await page.goto("/");
  const stats = await page.evaluate(() => window.__wxImagePrefetchCache?.getStats() ?? null);
  expect(stats).not.toBeNull();
  expect(stats.objectUrlLimitBytes).toBe(2 * GIB);
  expect(stats.decodedLimitBytes).toBe(4 * GIB);
});

test("evicting cached layer images drops frame chips out of loaded", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-1000Z",
        view: "conus",
        generatedAt: "2026-02-16T10:10:00Z",
        manifestKey: "manifests/gfs/evict-chip.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/evict-chip.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260216-1000Z",
        view: "conus",
        generatedAt: "2026-02-16T10:10:00Z",
        referenceTime: "2026-02-16T10:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded" },
        frames: [
          {
            hour: 0,
            validHourKey: "2026-02-16T10:00:00Z",
            bounds: { north: 53, south: 21, west: -129, east: -63 },
            cols: 1600,
            rows: 980,
            layers: {
              temperature: {
                key: "fixtures/gfs/evict-chip/temp.png",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          },
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/evict-chip/temp.png**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: ONE_BY_ONE_BYTES,
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await panel
    .getByRole("button", { name: /Frames/ })
    .first()
    .click();
  const frameChip = panel.getByRole("button", { name: "000" }).first();
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 10_000 })
    .toContain("bg-cyan-500/20");

  // Let the background warmup pass over this run finish, so a late warmup success
  // cannot re-mark the evicted key as loaded after we shrink the budget.
  await page.waitForTimeout(1_000);

  const before = await page.evaluate(() => window.__wxImagePrefetchCache.getStats());
  expect(before.objectUrlBytes).toBeGreaterThan(0);

  await page.evaluate(() => window.__wxImagePrefetchCache.setObjectUrlLimitBytes(1));

  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .not.toContain("bg-cyan-500/20");
  await expect(panel.getByRole("button", { name: /Frames 0\/1/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__wxImagePrefetchCache.getStats().objectUrlBytes)).toBe(0);
});
