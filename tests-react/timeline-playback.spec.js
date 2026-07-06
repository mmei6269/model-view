const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

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

// Time (ms) until the frame label no longer reads `fromText`. Bounded poll.
async function timeUntilLabelLeaves(page, fromText, timeout = 15000) {
  const start = Date.now();
  await expect.poll(() => frameLabel(page).textContent(), { timeout, intervals: [50] }).not.toBe(fromText);
  return Date.now() - start;
}

// Time (ms) for the frame label to change twice (two playback advances).
async function measureTwoAdvances(page) {
  let current = await frameLabel(page).textContent();
  const start = Date.now();
  for (let step = 0; step < 2; step += 1) {
    await expect.poll(() => frameLabel(page).textContent(), { timeout: 15000, intervals: [50] }).not.toBe(current);
    current = await frameLabel(page).textContent();
  }
  return Date.now() - start;
}

test("2x playback advances roughly twice as fast as 1x", async ({ page }) => {
  // 8 frames so neither measured run reaches the last frame (no dwell noise).
  const valids = frameSetAt([-6, 0, 6, 12, 18, 24, 30, 36]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[0])}`);
  await waitForLabel(page, "F000");

  await page.getByRole("button", { name: "Play timeline", exact: true }).click();
  const elapsedAt1x = await measureTwoAdvances(page);
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();

  await page.getByRole("button", { name: "2×", exact: true }).click();
  await page.getByRole("button", { name: "Play timeline", exact: true }).click();
  const elapsedAt2x = await measureTwoAdvances(page);
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();

  // Generous bounds: assert relative speed-up, not exact intervals.
  expect(elapsedAt2x).toBeLessThan(elapsedAt1x);
  expect(elapsedAt2x).toBeLessThan(elapsedAt1x * 0.85);
  // Two 1x advances cannot complete faster than a single base interval.
  expect(elapsedAt1x).toBeGreaterThan(1200);
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

test("playback dwells on the last frame before wrapping to the first", async ({ page }) => {
  const valids = frameSetAt([-6, 0, 6]);
  await routeGfs(page, valids);
  await page.goto(`/?hour=${encodeURIComponent(valids[1])}`);
  await waitForLabel(page, "F006");

  await page.getByRole("button", { name: "Play timeline", exact: true }).click();
  // Normal advance: F006 -> F012 (last frame) after ~one base interval.
  const normalAdvanceMs = await timeUntilLabelLeaves(page, "F006");
  await waitForLabel(page, "F012");
  // Wrap advance: F012 -> F000 should take base interval + dwell.
  const wrapAdvanceMs = await timeUntilLabelLeaves(page, "F012");
  await page.getByRole("button", { name: "Pause playback", exact: true }).click();

  expect(wrapAdvanceMs).toBeGreaterThan(normalAdvanceMs);
  expect(wrapAdvanceMs).toBeGreaterThan(normalAdvanceMs + 300);
});
