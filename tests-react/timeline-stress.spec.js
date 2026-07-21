const { test, expect } = require("./helpers/test");

// Stress coverage for the timeline controller across multiple panels:
// composite statuses with frameless panels, disjoint runs, track fallback,
// mode switches, and the rebased playback speed.

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
      layers: {
        temperature: {
          key: "",
          bytes: 120,
          contentType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==",
        },
      },
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
        manifestKey: `manifests/${model}/stress.json`,
        frameCount: valids.length,
      }),
    }),
  );
  await page.route(`**/__cf/manifests/${model}/stress.json**`, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(buildManifest(model, valids)) }),
  );
}

async function routeMissingModel(page, model) {
  await page.route(`**/__cf/manifests/${model}/latest.json**`, (r) => r.fulfill({ status: 404, body: "Not Found" }));
}

const loadedCounter = (page) => page.locator('[aria-label^="Loaded"]');

test("a frameless panel never poisons overlap statuses (Loaded N/N regression)", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeModel(page, "gfs", valids);
  await routeModel(page, "nam3km", valids);
  await routeMissingModel(page, "hrrr");

  await page.goto("/?p1=gfs:temperature&p2=nam3km:temperature&p3=hrrr:temperature");
  await expect(page.locator("article")).toHaveCount(3);
  await expect(page.getByTestId("manifest-error")).toBeVisible();

  // Before the participation fix, the frameless HRRR panel forced every
  // composite status to "pending": the counter read 0/4 with imagery visibly
  // on screen and playback would hold forever.
  await expect(loadedCounter(page)).toHaveText("Loaded 4/4", { timeout: 30_000 });
});

test("disjoint runs fall back to the primary panel's axis without zeroing statuses", async ({ page }) => {
  await routeModel(page, "gfs", frameSetAt([-6, 0, 6]));
  await routeModel(page, "nam3km", frameSetAt([48, 54, 60]));

  await page.goto("/?p1=gfs:temperature&p2=nam3km:temperature");
  await expect(page.locator("article")).toHaveCount(2);

  // No intersection: the axis is the first panel's 3 frames, and the second
  // panel (which has none of those valid times) must not block "loaded".
  await expect(loadedCounter(page)).toHaveText("Loaded 3/3", { timeout: 30_000 });

  await page.getByRole("button", { name: "Next frame" }).click();
  await expect(page.getByTestId("frame-label")).not.toHaveText("F---");
});

test("removing the tracked panel falls back to the first panel in panel mode", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeModel(page, "gfs", valids);
  await routeModel(page, "nam3km", valids);

  await page.goto("/?p1=gfs:temperature&p2=nam3km:temperature");
  await expect(page.locator("article")).toHaveCount(2);

  await page.getByLabel("Axis").selectOption("panel");
  const track = page.getByLabel("Track");
  await expect(track.locator("option")).toHaveCount(2);
  await track.selectOption({ index: 1 });

  await page.getByRole("button", { name: "Remove" }).last().click();
  await expect(page.locator("article")).toHaveCount(1);

  // The track selector falls back to the remaining panel and stays usable.
  await expect(track.locator("option")).toHaveCount(1);
  await page.getByRole("button", { name: "Next frame" }).click();
  await expect(page.getByTestId("frame-label")).not.toHaveText("F---");
});

test("mode switches preserve the selected frame in both directions", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeModel(page, "gfs", valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[1])}`);
  await expect(page.getByTestId("frame-label")).toHaveText("F006", { timeout: 15_000 });

  await page.getByRole("button", { name: "Next frame" }).click();
  await expect(page.getByTestId("frame-label")).toHaveText("F012");

  await page.getByLabel("Axis").selectOption("panel");
  await expect(page.getByTestId("frame-label")).toHaveText("F012");

  await page.getByLabel("Axis").selectOption("overlap");
  await expect(page.getByTestId("frame-label")).toHaveText("F012");
});

test("1x playback requests the rebased 600ms interval and advances", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.__modelViewScheduledTimeouts = [];
    window.setTimeout = (callback, delay = 0, ...args) => {
      window.__modelViewScheduledTimeouts.push(Number(delay));
      return nativeSetTimeout(callback, delay, ...args);
    };
  });
  const valids = frameSetAt([-6, 0, 6, 12, 18, 24]);
  await routeModel(page, "gfs", valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await expect(page.getByTestId("frame-label")).toHaveText("F000", { timeout: 15_000 });
  // Fully decoded browser axis first so hold-on-pending cannot skew the
  // timing. The global counter can briefly reflect manifest-loaded status
  // before per-panel browser cache state replaces it; the panel's Frames
  // count is the authoritative decoded-readiness signal.
  await expect(page.getByRole("button", { name: /Frames 6\/6/ })).toBeVisible({ timeout: 30_000 });
  await expect(loadedCounter(page)).toHaveText("Loaded 6/6", { timeout: 30_000 });

  await page.evaluate(() => {
    window.__modelViewScheduledTimeouts = [];
  });
  await page.getByRole("button", { name: "Play timeline", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__modelViewScheduledTimeouts.includes(600)), { timeout: 10_000 })
    .toBe(true);
  await expect(page.getByTestId("frame-label")).not.toHaveText("F000", { timeout: 15_000 });
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();
});

test("a panel whose manifest is still loading holds the composite instead of playing past it", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6, 12]);
  await routeModel(page, "gfs", valids);
  // NAM3km manifest pointer stalls for 4s: the panel is LOADING, not failed.
  await page.route("**/__cf/manifests/nam3km/latest.json**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "nam3km",
        run: "20260701-0000Z",
        view: "conus",
        generatedAt: valids[0],
        manifestKey: "manifests/nam3km/stress.json",
        frameCount: valids.length,
      }),
    });
  });
  await page.route("**/__cf/manifests/nam3km/stress.json**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(buildManifest("nam3km", valids)) }),
  );

  await page.goto("/?p1=gfs:temperature&p2=nam3km:temperature");
  await expect(page.locator("article")).toHaveCount(2);

  // While the second manifest is in flight, the composite must hold at 0
  // loaded (the loading panel participates as pending).
  await expect(loadedCounter(page)).toHaveText("Loaded 0/4");

  // Once it lands, statuses join and the axis fully loads.
  await expect(loadedCounter(page)).toHaveText("Loaded 4/4", { timeout: 30_000 });
});
