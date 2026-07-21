const { test, expect } = require("./helpers/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";

// Fixed multi-day valid times (default zone is UTC, so the expected labels and
// day boundaries are deterministic). Frame labels are F000, F006, ... by index.
const VALID_TIMES = [
  "2026-07-01T18:00:00Z",
  "2026-07-02T00:00:00Z",
  "2026-07-02T06:00:00Z",
  "2026-07-02T12:00:00Z",
  "2026-07-03T00:00:00Z",
];

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

async function openTimeline(page) {
  await routeGfs(page, VALID_TIMES);
  await page.goto(`/?hour=${encodeURIComponent(VALID_TIMES[0])}`);
  await expect(page.getByTestId("frame-label")).toHaveText("F000", { timeout: 15000 });
}

test("day-boundary date labels render along the track", async ({ page }) => {
  await openTimeline(page);

  const labels = page.getByTestId("timeline-day-label");
  // Two calendar-day crossings in the fixture: Jul 1 -> Jul 2 and Jul 2 -> Jul 3.
  await expect(labels).toHaveCount(2);
  await expect(labels.nth(0)).toBeVisible();
  await expect(labels.nth(0)).toHaveText("Jul 2");
  await expect(labels.nth(1)).toHaveText("Jul 3");
});

test("range input title shows the selected frame's full valid label and updates on ArrowRight", async ({ page }) => {
  await openTimeline(page);

  const slider = page.locator("input.timeline-range");
  await expect(slider).toHaveAttribute("title", "2026-07-01 18z");

  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("frame-label")).toHaveText("F006", { timeout: 15000 });
  await expect(slider).toHaveAttribute("title", "2026-07-02 00z");
});

test("hovering the track shows the nearest frame's valid time in the title", async ({ page }) => {
  await openTimeline(page);

  const slider = page.locator("input.timeline-range");
  const box = await slider.boundingBox();
  expect(box).not.toBeNull();

  // Hover near the right edge: nearest frame is the last one.
  await slider.hover({ position: { x: box.width - 2, y: box.height / 2 } });
  await expect(slider).toHaveAttribute("title", "2026-07-03 00z");

  // Leaving the track falls back to the selected frame's label.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 80);
  await expect(slider).toHaveAttribute("title", "2026-07-01 18z");
});
