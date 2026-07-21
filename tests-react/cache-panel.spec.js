const { test, expect } = require("./helpers/test");

async function openRenderMenu(page) {
  await page.getByRole("button", { name: "Render", exact: true }).click();
  return page.getByRole("dialog", { name: "Render" });
}

const STATS_PAYLOAD = {
  cacheRoot: "/tmp/cache",
  computedAt: "2026-07-07T00:00:00Z",
  totalBytes: 218_453_032_960,
  artifactsBytes: 193_273_528_320,
  rawBytes: 25_179_504_640,
  models: [
    {
      model: "hrrr",
      totalBytes: 96_636_764_160,
      runs: [
        { runId: "20260707-0000Z", bytes: 48_318_382_080, latest: true },
        { runId: "20260706-1800Z", bytes: 48_318_382_080, latest: false },
      ],
    },
  ],
};

test("cache section shows sizes and the preview-then-confirm prune flow", async ({ page }) => {
  const statsRequests = [];
  const pruneBodies = [];
  await page.route("**/__cf/actions/cache-stats**", async (route) => {
    statsRequests.push(new URL(route.request().url()).searchParams.get("refresh"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STATS_PAYLOAD) });
  });
  await page.route("**/__cf/actions/cache/prune**", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    pruneBodies.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        dryRun: body.dryRun !== false,
        removedBytes: 13_207_024_640,
        projectedBytes: 205_246_008_320,
        budgetUnmet: false,
        deletions: [
          {
            path: "artifacts/tiles/hrrr/20260706-1800Z",
            bytes: 13_207_024_640,
            runId: "20260706-1800Z",
            model: "hrrr",
            kind: "artifact",
          },
        ],
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  const section = drawer.getByTestId("cache-section");
  await expect(section).toBeVisible();

  // Stats load lazily when the popover opens.
  await expect(section.getByTestId("cache-total")).toHaveText("203.5 GB");
  await expect(section.getByText("HRRR · 2 runs")).toBeVisible();

  // Preview is a dry run; nothing destructive posted yet.
  await section.getByRole("button", { name: "Preview prune" }).click();
  await expect(section.getByTestId("prune-preview")).toContainText("free 12.3 GB across 1 target");
  expect(pruneBodies).toEqual([{ dryRun: true }]);

  // Confirming posts dryRun:false, toasts, closes the preview, and re-fetches
  // stats with refresh=1.
  await section.getByRole("button", { name: "Prune now" }).click();
  await expect.poll(() => pruneBodies.length).toBe(2);
  expect(pruneBodies[1]).toEqual({ dryRun: false });
  await expect(page.getByTestId("toast").filter({ hasText: "Cache pruned" })).toBeVisible();
  await expect(section.getByTestId("prune-preview")).toHaveCount(0);
  await expect.poll(() => statsRequests.includes("1")).toBeTruthy();
});

test("cache clear requires typing CLEAR before the button arms", async ({ page }) => {
  const clearBodies = [];
  await page.route("**/__cf/actions/cache-stats**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STATS_PAYLOAD) });
  });
  await page.route("**/__cf/actions/cache/clear**", async (route) => {
    clearBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, removedBytes: 218_453_032_960 }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  const section = drawer.getByTestId("cache-section");

  await section.getByRole("button", { name: "Clear…" }).click();
  const confirmButton = section.getByRole("button", { name: "Clear cache" });
  await expect(confirmButton).toBeDisabled();

  await section.getByLabel("Clear confirmation").fill("clear");
  await expect(confirmButton).toBeDisabled();

  await section.getByLabel("Clear confirmation").fill("CLEAR");
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect.poll(() => clearBodies.length).toBe(1);
  expect(clearBodies[0]).toEqual({ confirm: "CLEAR" });
  await expect(page.getByTestId("toast").filter({ hasText: "Cache cleared" })).toBeVisible();
});
