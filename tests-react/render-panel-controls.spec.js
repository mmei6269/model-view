const { test, expect } = require("./helpers/test");

async function openRenderMenu(page) {
  await page.getByRole("button", { name: "Render", exact: true }).click();
  return page.getByRole("dialog", { name: "Render" });
}

test("frames cap and tuning preset serialize into the render POST body", async ({ page }) => {
  const postedBodies = [];
  await page.route("**/__cf/actions/render**", async (route) => {
    postedBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-fc1" }) });
  });
  await page.route("**/__cf/actions/status/job-fc1**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "job-fc1", status: "done", built: 25, reused: 0, failed: 0, total: 25 }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);

  await drawer.getByLabel("Frames").selectOption("24");
  await expect(drawer.getByText("Renders f000–f024 only", { exact: false })).toBeVisible();
  await drawer.getByLabel("Tuning").selectOption("production");
  await expect(drawer.getByText("18 workers · 24 frame queue", { exact: false })).toBeVisible();

  await drawer.getByRole("button", { name: "▶ Render" }).click();
  await expect.poll(() => postedBodies.length).toBe(1);
  expect(postedBodies[0].maxHour).toBe(24);
  expect(postedBodies[0].tuning).toEqual({
    workerCount: 18,
    totalFrameConcurrency: 24,
    rangeConcurrency: 3,
    decodeConcurrency: 2,
  });

  // Full horizon + auto tuning omit both fields entirely (byte-stable default).
  await drawer.getByLabel("Frames").selectOption("full");
  await drawer.getByLabel("Tuning").selectOption("auto");
  await expect(page.getByTestId("toast").filter({ hasText: "Render complete" }).first()).toBeVisible({
    timeout: 10_000,
  });
  await drawer.getByRole("button", { name: "▶ Render" }).click();
  await expect.poll(() => postedBodies.length).toBe(2);
  expect(postedBodies[1].maxHour).toBeUndefined();
  expect(postedBodies[1].tuning).toBeUndefined();
  expect(postedBodies[1].gfsTemporalTier).toBeUndefined();
  expect(postedBodies[1].sciencePrototypes).toBeUndefined();
});

test("optional GFS cadence and science prototypes serialize only when selected", async ({ page }) => {
  const postedBodies = [];
  await page.route("**/__cf/actions/render**", async (route) => {
    postedBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-opt1" }) });
  });
  await page.route("**/__cf/actions/status/job-opt1**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "job-opt1", status: "done", built: 1, reused: 0, failed: 0, total: 1 }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await expect(drawer.getByText("about +3.80 CPU s/frame", { exact: false })).toBeVisible();
  await expect(drawer.getByText("about +11.77 CPU s/frame modeled marginal cost", { exact: false })).toBeVisible();
  await expect(
    drawer.getByText("+2.98 ms/frame marginal at 119x73 / 12 retained centers", { exact: false }),
  ).toBeVisible();
  await drawer.getByRole("checkbox", { name: "GFS", exact: true }).check();
  await drawer.getByRole("checkbox", { name: "GFS hourly F000-F120 (optional)" }).check();
  const dcapePrototype = drawer.getByRole("checkbox", { name: "21-level DCAPE prototype (CAM-only)" });
  const prototypeDescription = await dcapePrototype.evaluate((element) => {
    const id = element.getAttribute("aria-describedby");
    return id ? document.getElementById(id)?.textContent || "" : "";
  });
  expect(prototypeDescription).toContain("+3.80 CPU s/frame");

  await drawer.getByRole("radio", { name: "Severe Simple" }).check();
  await drawer.getByRole("checkbox", { name: "21-level DCAPE prototype (CAM-only)" }).check();
  await expect(drawer.getByRole("radio", { name: "Severe Full" })).toBeChecked();
  await drawer.getByRole("radio", { name: "Severe Simple" }).check();
  await expect(drawer.getByRole("checkbox", { name: "21-level DCAPE prototype (CAM-only)" })).not.toBeChecked();

  await drawer.getByRole("checkbox", { name: "100-mb reduced-profile prototype" }).check();
  await expect(drawer.getByRole("radio", { name: "Severe Full" })).toBeChecked();
  await drawer.getByRole("checkbox", { name: "21-level DCAPE prototype (CAM-only)" }).check();
  await drawer.getByRole("checkbox", { name: "Row-aware center validation diagnostic" }).check();
  await drawer.getByRole("button", { name: "▶ Render" }).click();

  await expect.poll(() => postedBodies.length).toBe(1);
  expect(postedBodies[0].gfsTemporalTier).toBe("hourly-through-120");
  expect(postedBodies[0].categories.severe).toEqual({ enabled: true, tier: "full" });
  expect(postedBodies[0].sciencePrototypes).toEqual([
    "camDcape21Level",
    "effectiveStp100mbReduced",
    "rowAwareCenterValidation",
  ]);
});

test("persisted prototype selections discard only prerequisites that cannot render", async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem("modelview.render.v1")) return;
    localStorage.setItem(
      "modelview.render.v1",
      JSON.stringify({
        models: ["gfs"],
        view: "conus",
        runMode: "latest",
        runs: {},
        categories: { severe: { enabled: true, tier: "full" } },
        maxHour: null,
        tuning: null,
        gfsTemporalTier: "three-hourly",
        sciencePrototypes: ["camDcape21Level", "effectiveStp100mbReduced", "rowAwareCenterValidation"],
      }),
    );
  });

  await page.goto("/");
  let drawer = await openRenderMenu(page);
  await expect(drawer.getByRole("checkbox", { name: "21-level DCAPE prototype (CAM-only)" })).not.toBeChecked();
  await expect(drawer.getByRole("checkbox", { name: "100-mb reduced-profile prototype" })).toBeChecked();
  await expect(drawer.getByRole("checkbox", { name: "Row-aware center validation diagnostic" })).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("modelview.render.v1") || "{}").sciencePrototypes))
    .toEqual(["effectiveStp100mbReduced", "rowAwareCenterValidation"]);

  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("modelview.render.v1") || "{}");
    stored.categories.severe = { enabled: true, tier: "simple" };
    stored.sciencePrototypes = ["camDcape21Level", "effectiveStp100mbReduced", "rowAwareCenterValidation"];
    localStorage.setItem("modelview.render.v1", JSON.stringify(stored));
  });
  await page.reload();
  drawer = await openRenderMenu(page);
  await expect(drawer.getByRole("checkbox", { name: "21-level DCAPE prototype (CAM-only)" })).not.toBeChecked();
  await expect(drawer.getByRole("checkbox", { name: "100-mb reduced-profile prototype" })).not.toBeChecked();
  await expect(drawer.getByRole("checkbox", { name: "Row-aware center validation diagnostic" })).toBeChecked();
});

test("persisted and serialized GFS hourly cadence canonicalizes off without a selected GFS model", async ({ page }) => {
  const postedBodies = [];
  await page.addInitScript(() => {
    localStorage.setItem(
      "modelview.render.v1",
      JSON.stringify({
        models: ["hrrr", "nam3km"],
        view: "conus",
        runMode: "latest",
        runs: {},
        categories: {},
        maxHour: 0,
        tuning: null,
        gfsTemporalTier: "hourly-through-120",
        sciencePrototypes: [],
      }),
    );
  });
  await page.route("**/__cf/actions/render**", async (route) => {
    postedBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-gfs0" }) });
  });
  await page.route("**/__cf/actions/status/job-gfs0**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "job-gfs0", status: "done", built: 1, reused: 0, failed: 0, total: 1 }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await expect(drawer.getByRole("checkbox", { name: "GFS hourly F000-F120 (optional)" })).toBeDisabled();
  await expect(drawer.getByRole("checkbox", { name: "GFS hourly F000-F120 (optional)" })).not.toBeChecked();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("modelview.render.v1") || "{}").gfsTemporalTier))
    .toBe("three-hourly");

  await drawer.getByRole("button", { name: "▶ Render" }).click();
  await expect.poll(() => postedBodies.length).toBe(1);
  expect(postedBodies[0].models).toEqual(["hrrr", "nam3km"]);
  expect(postedBodies[0].gfsTemporalTier).toBeUndefined();
});

test("active jobs can be canceled; terminal rows can be dismissed", async ({ page }) => {
  let canceled = false;
  const cancelPosts = [];
  await page.route("**/__cf/actions/render**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-cx1" }) });
  });
  await page.route("**/__cf/actions/status/job-cx1**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "job-cx1",
        status: canceled ? "canceled" : "running",
        built: 3,
        reused: 0,
        failed: 0,
        total: 25,
        markerCount: 3,
        markerTotal: 25,
      }),
    });
  });
  await page.route("**/__cf/actions/cancel/job-cx1**", async (route) => {
    canceled = true;
    cancelPosts.push(route.request().method());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, jobId: "job-cx1", status: "canceled" }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("button", { name: "▶ Render" }).click();

  const jobRow = drawer.getByRole("status", { name: "Render job" });
  await expect(jobRow).toBeVisible();

  await jobRow.getByRole("button", { name: /Cancel job/ }).click();
  await expect.poll(() => cancelPosts).toEqual(["POST"]);

  // The poller observes the canceled status and the row settles.
  await expect(jobRow).toContainText("canceled", { timeout: 10_000 });
  await expect(page.getByTestId("toast").filter({ hasText: "Render canceled" })).toBeVisible();

  // Terminal rows dismiss locally.
  await jobRow.getByRole("button", { name: /Dismiss job/ }).click();
  await expect(drawer.getByRole("status", { name: "Render job" })).toHaveCount(0);

  // The submit button re-enables once the job is terminal.
  await expect(drawer.getByRole("button", { name: "▶ Render" })).toBeEnabled();
});

test("the default no-cap selection round-trips storage as null, never 0", async ({ page }) => {
  await page.goto("/");
  // Let the persistence effect run, then verify the stored shape: a maxHour
  // of 0 here would silently cap every future render at f000.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem("modelview.render.v1");
        if (!raw) return "missing";
        const parsed = JSON.parse(raw);
        return { maxHour: parsed.maxHour ?? null, tuning: parsed.tuning ?? null };
      }),
    )
    .toEqual({ maxHour: null, tuning: null });

  // And a submitted default render carries no maxHour/tuning on the wire.
  const postedBodies = [];
  await page.route("**/__cf/actions/render**", async (route) => {
    postedBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-nn1" }) });
  });
  await page.route("**/__cf/actions/status/job-nn1**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "job-nn1", status: "done", built: 1, reused: 0, failed: 0, total: 1 }),
    });
  });
  await page.getByRole("button", { name: "Render", exact: true }).click();
  await page.getByRole("dialog", { name: "Render" }).getByRole("button", { name: "▶ Render" }).click();
  await expect.poll(() => postedBodies.length).toBe(1);
  expect(postedBodies[0].maxHour).toBeUndefined();
  expect(postedBodies[0].tuning).toBeUndefined();
  expect(postedBodies[0].gfsTemporalTier).toBeUndefined();
  expect(postedBodies[0].sciencePrototypes).toBeUndefined();
});

test("a failed job with an unknown frame target shows an empty bar, not a full one", async ({ page }) => {
  await page.route("**/__cf/actions/render**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-fx1" }) });
  });
  await page.route("**/__cf/actions/status/job-fx1**", async (route) => {
    // Failed before the builder ever reported a frame plan: no total, no markerTotal.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "job-fx1",
        status: "failed",
        error: "spawn failed",
        built: 0,
        reused: 0,
        failed: 0,
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("button", { name: "▶ Render" }).click();

  const jobRow = drawer.getByRole("status", { name: "Render job" });
  await expect(jobRow).toContainText("failed: spawn failed", { timeout: 10_000 });

  const track = jobRow.locator("div.h-2");
  const bar = track.locator("> div");
  expect((await track.boundingBox())?.width ?? 0).toBeGreaterThan(50);
  // The bar animates down through transition-all, so poll past the transition.
  await expect.poll(async () => (await bar.boundingBox())?.width ?? 0).toBeLessThan(4);
});
