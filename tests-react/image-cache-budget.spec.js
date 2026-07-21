const { test, expect } = require("./helpers/test");

const GIB = 1024 * 1024 * 1024;
const ONE_BY_ONE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==",
  "base64",
);

test("image prefetch cache budgets default to 2 GiB object-URL and 4 GiB decoded", async ({ page }) => {
  await page.goto("/");
  const stats = await page.evaluate(() => window.__wxImagePrefetchCache?.getStats() ?? null);
  expect(stats).not.toBeNull();
  expect(stats.objectUrlLimitBytes).toBe(2 * GIB);
  expect(stats.decodedLimitBytes).toBe(4 * GIB);
});

// Two frames on purpose: the panel displays hour 0 (pinned via ?hour=), and
// every eviction assertion targets the NON-displayed hour 3. A frame that is
// genuinely on screen may legitimately re-enter loaded at any time — the map
// engine marks a layer loaded whenever its decode lands (late first decode,
// re-apply, context-loss recreate), and the transient-failure recovery flow
// depends on that display-driven marking. Only frames the map is not
// displaying can promise "evicted stays non-loaded", which is what these
// specs pin. (Asserting the displayed frame here is what made this spec
// flake on slow CI shards.)
async function routeEvictChipManifests(page) {
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
        frameCount: 2,
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
        hourStatus: { 0: "loaded", 3: "loaded" },
        frames: [
          {
            hour: 0,
            validHourKey: "2026-02-16T10:00:00Z",
            bounds: { north: 53, south: 21, west: -129, east: -63 },
            cols: 1600,
            rows: 980,
            layers: {
              temperature: {
                key: "fixtures/gfs/evict-chip/temp-000.png",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          },
          {
            hour: 3,
            validHourKey: "2026-02-16T13:00:00Z",
            bounds: { north: 53, south: 21, west: -129, east: -63 },
            cols: 1600,
            rows: 980,
            layers: {
              temperature: {
                key: "fixtures/gfs/evict-chip/temp-003.png",
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
}

function routeEvictChipImage(page, name, onRequest) {
  return page.route(`**/__cf/fixtures/gfs/evict-chip/${name}**`, async (route) => {
    if (onRequest) {
      onRequest();
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: ONE_BY_ONE_BYTES,
    });
  });
}

async function openFrameStrip(page) {
  const panel = page.locator("article").first();
  await panel
    .getByRole("button", { name: /Frames/ })
    .first()
    .click();
  return panel;
}

async function expectChipLoaded(chip) {
  await expect
    .poll(async () => (await chip.getAttribute("class")) || "", { timeout: 10_000 })
    .toContain("bg-cyan-500/20");
}

async function expectChipStaysNonLoaded(chip) {
  await expect
    .poll(async () => (await chip.getAttribute("class")) || "", { timeout: 5_000 })
    .not.toContain("bg-cyan-500/20");
  // Re-marks land within the 100 ms batched cache notify; sample well past
  // several windows — the chip must never flip back to loaded.
  for (let sample = 0; sample < 6; sample += 1) {
    await chip.page().waitForTimeout(200);
    expect((await chip.getAttribute("class")) || "").not.toContain("bg-cyan-500/20");
  }
}

test("evicting cached layer images drops non-displayed frame chips out of loaded", async ({ page }) => {
  await routeEvictChipManifests(page);
  await routeEvictChipImage(page, "temp-000.png");
  await routeEvictChipImage(page, "temp-003.png");

  await page.goto("/?hour=2026-02-16T10:00:00Z");
  const panel = await openFrameStrip(page);
  const displayedChip = panel.getByRole("button", { name: /^Forecast hour 0:/ });
  const futureChip = panel.getByRole("button", { name: /^Forecast hour 3:/ });
  await expectChipLoaded(displayedChip);
  await expectChipLoaded(futureChip);

  const before = await page.evaluate(() => window.__wxImagePrefetchCache.getStats());
  expect(before.objectUrlBytes).toBeGreaterThan(0);

  await page.evaluate(() => window.__wxImagePrefetchCache.setObjectUrlLimitBytes(1));

  // The non-displayed hour must drop out of loaded and STAY out: no marker
  // path may recreate a loaded key for bytes that are no longer resident.
  // (The displayed hour-0 chip is deliberately unasserted — a late map
  // decode may re-mark it, and that is sanctioned display-driven behavior.)
  await expectChipStaysNonLoaded(futureChip);
  await expect.poll(() => page.evaluate(() => window.__wxImagePrefetchCache.getStats().objectUrlBytes)).toBe(0);
});

test("a warmup pass finishing after eviction cannot re-mark evicted frames loaded", async ({ page }) => {
  // Regression for the CI failure in the eviction spec: a latest-run memory
  // warmup whose raster task runs after cache pressure emptied the
  // object-URL cache takes the cold-fetch path, its insert immediately
  // self-evicts under the shrunken budget, and its completion used to mark
  // the cache key loaded anyway (the warmup residency check only covered
  // parsed vector payloads) — permanently, since an empty cache fires no
  // further eviction events. The dev warmup hook makes the ordering
  // deterministic instead of racing MapPanel's 300 ms trigger timer.
  await routeEvictChipManifests(page);
  let futurePngRequests = 0;
  await routeEvictChipImage(page, "temp-000.png");
  await routeEvictChipImage(page, "temp-003.png", () => {
    futurePngRequests += 1;
  });

  await page.goto("/?hour=2026-02-16T10:00:00Z");
  const panel = await openFrameStrip(page);
  const futureChip = panel.getByRole("button", { name: /^Forecast hour 3:/ });
  await expectChipLoaded(futureChip);

  await page.evaluate(() => window.__wxImagePrefetchCache.setObjectUrlLimitBytes(1));
  await expect
    .poll(async () => (await futureChip.getAttribute("class")) || "", { timeout: 5_000 })
    .not.toContain("bg-cyan-500/20");

  // Start a fresh warmup pass over this run now that the bytes are gone.
  // The layer set differs from the automatic pass so the plan key does not
  // dedupe, and the eviction above already cleared the warmup's
  // completed-task keys for both temperature URLs.
  const requestsBeforeWarmup = futurePngRequests;
  await page.evaluate(async () => {
    const response = await fetch("/__cf/manifests/gfs/evict-chip.json");
    const manifest = await response.json();
    window.__wxLatestRunMemoryWarmup.start({
      modelKey: "gfs",
      viewKey: "conus",
      manifest,
      anchorHour: 0,
      activeLayers: ["temperature", "wind"],
      reflectivityGate: 15,
      synopticDetailMode: "simple",
    });
  });
  await expect.poll(() => futurePngRequests, { timeout: 10_000 }).toBeGreaterThan(requestsBeforeWarmup);
  // Request start is not enough: wait for the pump to go quiescent so the
  // guarded completion path under test has definitely executed before the
  // stays-non-loaded sampling begins (otherwise a slow shard could finish
  // the sampling before the completion lands and pass vacuously).
  await expect
    .poll(() => page.evaluate(() => window.__wxLatestRunMemoryWarmup.stats()), { timeout: 10_000 })
    .toEqual({ inFlight: 0, queued: 0 });

  await expectChipStaysNonLoaded(futureChip);
  await expect(panel.getByRole("button", { name: /Frames 0\/2|Frames 1\/2/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__wxImagePrefetchCache.getStats().objectUrlBytes)).toBe(0);
});
