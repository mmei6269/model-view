const { test, expect } = require("@playwright/test");

async function openRenderMenu(page) {
  await page.getByRole("button", { name: "Render", exact: true }).click();
  return page.getByRole("dialog", { name: "Render" });
}

test("submitting posts the selection, renders progress, and force-refreshes manifests on done", async ({ page }) => {
  const postedBodies = [];
  let statusCalls = 0;
  let forcedManifestFetches = 0;

  await page.route("**/__cf/actions/render**", async (route) => {
    postedBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-1" }) });
  });
  await page.route("**/__cf/actions/status/job-1**", async (route) => {
    statusCalls += 1;
    const done = statusCalls >= 2;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "job-1",
        status: done ? "done" : "running",
        built: done ? 10 : 4,
        reused: 0,
        failed: 0,
        total: 10,
      }),
    });
  });
  // A force-refresh manifest fetch for a "latest" run hits the latest.json pointer
  // first; counting that fetch is enough to prove the refresh fired.
  await page.route("**/__cf/manifests/hrrr/latest.json**", async (route) => {
    forcedManifestFetches += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "hrrr",
        run: "20260703-1200Z",
        view: "conus",
        generatedAt: "2026-07-03T12:10:00Z",
        manifestKey: "manifests/hrrr/render-done.json",
        frameCount: 1,
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("button", { name: "▶ Render" }).click();

  await expect.poll(() => postedBodies.length).toBe(1);
  expect(postedBodies[0].categories.severe).toEqual({ enabled: true, tier: "full" });
  expect(postedBodies[0].categories.radar).toBe(true);
  expect(Array.isArray(postedBodies[0].models)).toBeTruthy();

  // Progress bar renders from the mocked status.
  await expect(drawer.getByRole("status", { name: "Render job" })).toBeVisible();

  // On done, a force-refresh manifest fetch fires for a selected model.
  await expect.poll(() => forcedManifestFetches, { timeout: 8_000 }).toBeGreaterThan(0);
});

test("done-time refresh targets the submitted models even if the selection changed mid-job", async ({ page }) => {
  let hrrrLatestFetches = 0;
  let allowDone = false;

  await page.route("**/__cf/actions/render**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-2" }) });
  });
  await page.route("**/__cf/actions/status/job-2**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "job-2",
        status: allowDone ? "done" : "running",
        built: allowDone ? 10 : 4,
        reused: 0,
        failed: 0,
        total: 10,
      }),
    });
  });
  await page.route("**/__cf/manifests/hrrr/latest.json**", async (route) => {
    hrrrLatestFetches += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "hrrr",
        run: "20260703-1200Z",
        view: "conus",
        generatedAt: "2026-07-03T12:10:00Z",
        manifestKey: "manifests/hrrr/render-done.json",
        frameCount: 1,
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("button", { name: "▶ Render" }).click();
  await expect(drawer.getByRole("status", { name: "Render job" })).toBeVisible();

  // Mid-job: drop HRRR from the live selection. The submitted job still built
  // HRRR artifacts, so the done-time force-refresh must still target it.
  await drawer.getByRole("checkbox", { name: "HRRR" }).uncheck();

  const baseline = hrrrLatestFetches;
  allowDone = true;
  await expect.poll(() => hrrrLatestFetches, { timeout: 8_000 }).toBeGreaterThan(baseline);
});

test("a job that 404s (server restarted, registry lost) fails the row and re-enables submit", async ({ page }) => {
  await page.route("**/__cf/actions/render**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "job-lost", jobs: [{ jobId: "job-lost", models: ["hrrr"], run: "latest" }] }),
    });
  });
  await page.route("**/__cf/actions/status/job-lost**", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "No job" }) });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("button", { name: "▶ Render" }).click();

  const status = drawer.getByRole("status", { name: "Render job" });
  await expect(status).toContainText("no longer exists", { timeout: 8_000 });
  // busy released: submit is available again instead of locked forever.
  await expect(drawer.getByRole("button", { name: "▶ Render" })).toBeEnabled();
});

test("prefetch soundings posts {models,runs,view}, shows progress, and needs no manifest refresh", async ({ page }) => {
  const prefetchBodies = [];
  let statusCalls = 0;
  let manifestFetches = 0;

  await page.route("**/__cf/actions/prefetch-soundings**", async (route) => {
    prefetchBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "snd-1" }) });
  });
  await page.route("**/__cf/actions/status/snd-1**", async (route) => {
    statusCalls += 1;
    const done = statusCalls >= 2;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "snd-1",
        status: done ? "done" : "running",
        built: done ? 5 : 2,
        reused: 0,
        failed: 0,
        total: 5,
      }),
    });
  });
  await page.route("**/__cf/manifests/**", async (route) => {
    manifestFetches += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "hrrr",
        run: "20260703-1200Z",
        view: "conus",
        generatedAt: "2026-07-03T12:10:00Z",
        manifestKey: "manifests/hrrr/latest.json",
        frameCount: 1,
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  const manifestBaseline = manifestFetches;

  await drawer.getByRole("button", { name: "Prefetch soundings", exact: true }).click();

  await expect.poll(() => prefetchBodies.length).toBe(1);
  // Every selected model is prefetched, each against its own picked run.
  expect(prefetchBodies[0].models).toEqual(["hrrr", "nam3km"]);
  expect(prefetchBodies[0].runs).toEqual({ hrrr: "latest", nam3km: "latest" });
  expect(typeof prefetchBodies[0].view).toBe("string");

  await expect(drawer.getByRole("status", { name: "Render job" })).toBeVisible();
  await expect.poll(() => statusCalls, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);

  // Completion does not trigger extra manifest refreshes beyond ordinary panel polling.
  await page.waitForTimeout(500);
  expect(manifestFetches - manifestBaseline).toBeLessThanOrEqual(2);
});
