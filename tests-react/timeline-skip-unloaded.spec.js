const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";
const ONE_BY_ONE_BYTES = Buffer.from(ONE_BY_ONE.split(",")[1], "base64");

// Frames at caller-picked hour offsets from now (same shape as timeline-playback.spec.js).
// Frame labels are F000, F006, F012, ... regardless of the offsets.
function frameSetAt(offsetHours) {
  const now = Date.now();
  const iso = (ms) => new Date(Math.floor(ms / 3600000) * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return offsetHours.map((offset) => iso(now + offset * 3600000));
}

function tempKey(hour) {
  return `fixtures/gfs/skip-unloaded/temp-${String(hour).padStart(3, "0")}.png`;
}

function buildManifest(valids) {
  return {
    schemaVersion: 4,
    model: "gfs",
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
          key: tempKey(i * 6),
          bytes: ONE_BY_ONE_BYTES.length,
          contentType: "image/png",
        },
      },
    })),
  };
}

// Routes manifests for a 3-frame GFS timeline (F000/F006/F012) whose images
// come from routed PNG endpoints. The middle frame (F006) never fulfills until
// the returned release() is called, so its browser status stays loading.
async function routeGfsWithHungMiddleFrame(page, valids) {
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
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(buildManifest(valids)) }),
  );

  let releaseMiddle;
  const middleGate = new Promise((resolve) => {
    releaseMiddle = resolve;
  });
  const fulfillPng = (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: ONE_BY_ONE_BYTES,
    });
  await page.route(`**/__cf/${tempKey(0)}**`, fulfillPng);
  await page.route(`**/__cf/${tempKey(12)}**`, fulfillPng);
  await page.route(`**/__cf/${tempKey(6)}**`, async (route) => {
    await middleGate;
    await fulfillPng(route).catch(() => {});
  });
  return releaseMiddle;
}

function frameLabel(page) {
  return page.getByTestId("frame-label");
}

async function waitForLabel(page, text) {
  await expect(frameLabel(page)).toHaveText(text, { timeout: 15000 });
}

function skipToggle(page) {
  return page.getByRole("checkbox", { name: /skip unloaded/i });
}

test("Skip unloaded toggle exists and defaults to off", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6]);
  await routeGfsWithHungMiddleFrame(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await expect(skipToggle(page)).toBeVisible();
  await expect(skipToggle(page)).not.toBeChecked();
});

test("playback holds on a never-loaded frame with a loading indicator instead of advancing past it", async ({
  page,
}) => {
  const valids = frameSetAt([-6, 0, 6]);
  const releaseMiddle = await routeGfsWithHungMiddleFrame(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");
  // First and last frames decoded in-browser; middle stuck loading.
  await expect(page.getByText("Loaded 2/3")).toBeVisible({ timeout: 15000 });

  await page.getByRole("button", { name: "Play timeline", exact: true }).click();
  // Playback advances onto the unloaded middle frame, then holds there.
  await waitForLabel(page, "F006");
  await expect(page.getByTestId("playback-holding")).toBeVisible({ timeout: 15000 });
  // While the frame stays unloaded, playback must not move past it (more than
  // two base intervals pass here — an un-held loop would have advanced).
  await page.waitForTimeout(3000);
  await expect(frameLabel(page)).toHaveText("F006");
  await expect(page.getByTestId("playback-holding")).toBeVisible();

  // Once the frame finally decodes, the hold clears and playback resumes.
  releaseMiddle();
  await expect(page.getByTestId("playback-holding")).toBeHidden({ timeout: 15000 });
  await waitForLabel(page, "F012");
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();
});

test("with Skip unloaded on, playback skips a never-loaded frame without dwelling on it", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6]);
  await routeGfsWithHungMiddleFrame(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");
  await expect(page.getByText("Loaded 2/3")).toBeVisible({ timeout: 15000 });

  await skipToggle(page).check();
  await expect(skipToggle(page)).toBeChecked();

  await page.getByRole("button", { name: "Play timeline", exact: true }).click();
  // The first advance lands directly on F012 — never on the unloaded F006.
  await expect.poll(() => frameLabel(page).textContent(), { timeout: 15000, intervals: [50] }).not.toBe("F000");
  await expect(frameLabel(page)).toHaveText("F012");
  await expect(page.getByTestId("playback-holding")).toHaveCount(0);

  // Wrapping also skips: from the last frame it returns to loaded F000.
  await waitForLabel(page, "F000");
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();
});
