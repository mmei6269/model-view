const { test, expect } = require("./helpers/test");

async function openRenderMenu(page) {
  await page.getByRole("button", { name: "Render", exact: true }).click();
  return page.getByRole("dialog", { name: "Render" });
}

// Server shape (verified): /actions/available-runs nests per model under
// runs[model].{built,upstream}; upstream elements carry the id as `runId` plus
// a probed published-frame count; built elements carry the manifest frameCount
// plus the probed upstreamFrameCount (more upstream ⇒ a re-render gains frames).
const AVAILABLE_RUNS_PAYLOAD = {
  view: "conus",
  runs: {
    hrrr: {
      built: [
        {
          model: "hrrr",
          run: "20260703-1200Z",
          view: "conus",
          generatedAt: "2026-07-03T12:40:00Z",
          manifestKey: "manifests/hrrr/20260703-1200Z--conus.json",
          frameCount: 49,
          loadedFrameCount: 49,
          complete: true,
          latest: true,
          upstreamFrameCount: 49,
        },
        {
          // A 3-frame-era partial build: only 20 frames in the manifest while
          // NOAA has 49 — the row must surface that a re-render gains frames.
          model: "hrrr",
          run: "20260703-1100Z",
          view: "conus",
          generatedAt: "2026-07-03T11:40:00Z",
          manifestKey: "manifests/hrrr/20260703-1100Z--conus.json",
          frameCount: 20,
          loadedFrameCount: 20,
          complete: false,
          latest: false,
          upstreamFrameCount: 49,
        },
      ],
      upstream: [
        { date: "20260703", cycle: "13", runId: "20260703-1300Z", frameCount: 12, maxHour: 11 },
        // Duplicate of a built run: the picker must dedupe it out of upstream.
        { date: "20260703", cycle: "12", runId: "20260703-1200Z", frameCount: 49, maxHour: 48 },
      ],
    },
    nam3km: {
      built: [],
      upstream: [{ date: "20260703", cycle: "18", runId: "20260703-1800Z", frameCount: 61, maxHour: 60 }],
    },
    gfs: {
      built: [
        {
          model: "gfs",
          run: "20260703-0000Z",
          view: "conus",
          generatedAt: "2026-07-03T00:40:00Z",
          frameCount: 129,
          loadedFrameCount: 129,
          complete: true,
          latest: true,
          upstreamFrameCount: 209,
          upstreamSourceFrameCount: 209,
          upstreamDefaultRenderFrameCount: 129,
        },
      ],
      upstream: [
        {
          date: "20260702",
          cycle: "18",
          runId: "20260702-1800Z",
          frameCount: 209,
          sourceFrameCount: 209,
          defaultRenderFrameCount: 129,
          maxHour: 384,
        },
      ],
    },
  },
};

test("pick from list shows per-model run lists with frame counts; picks post per model", async ({ page }) => {
  const availableRunsRequests = [];
  const postedBodies = [];

  await page.route("**/__cf/actions/available-runs**", async (route) => {
    availableRunsRequests.push(new URL(route.request().url()).searchParams.get("models"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(AVAILABLE_RUNS_PAYLOAD),
    });
  });
  await page.route("**/__cf/actions/render**", async (route) => {
    postedBodies.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "job-pick-a",
        jobs: [
          { jobId: "job-pick-a", models: ["hrrr"], run: "20260703-1100Z" },
          { jobId: "job-pick-b", models: ["nam3km"], run: "latest" },
        ],
      }),
    });
  });
  for (const jobId of ["job-pick-a", "job-pick-b"]) {
    await page.route(`**/__cf/actions/status/${jobId}**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jobId,
          status: "done",
          built: 49,
          reused: 0,
          failed: 0,
          total: 49,
          markerCount: 49,
          markerTotal: 49,
        }),
      });
    });
  }

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("radio", { name: "Pick from list" }).check();
  await expect(drawer.getByRole("combobox", { name: "Frames" }).locator("option[value='full']")).toHaveText(
    "Full horizon",
  );
  await expect(drawer.getByText(/latest completed official horizon/)).toBeVisible();

  // One run list PER selected model (run cycles differ per model).
  await expect(drawer.getByText("Runs for HRRR")).toBeVisible();
  await expect(drawer.getByText("Runs for NAM 3km")).toBeVisible();
  await expect.poll(() => availableRunsRequests.length).toBeGreaterThan(0);
  expect(availableRunsRequests[0]).toBe("hrrr,nam3km");

  const hrrrList = drawer.locator('[data-run-list="hrrr"]');
  const namList = drawer.locator('[data-run-list="nam3km"]');

  // Each list defaults to its Latest-available pseudo-row.
  await expect(hrrrList.getByRole("button", { name: "Latest available" })).toHaveAttribute("aria-pressed", "true");
  await expect(namList.getByRole("button", { name: "Latest available" })).toHaveAttribute("aria-pressed", "true");

  // ONE chronological list, newest cycle first: the unbuilt upstream 13Z sits
  // ABOVE the built 12Z — being built never pins a run to the top.
  const rowNames = await hrrrList
    .getByRole("button")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  expect(rowNames).toEqual(["Latest available", "20260703-1300Z", "20260703-1200Z", "20260703-1100Z"]);

  const latestRow = hrrrList.getByRole("button", { name: "20260703-1200Z", exact: true });
  const partialRow = hrrrList.getByRole("button", { name: "20260703-1100Z", exact: true });
  const upstreamRow = hrrrList.getByRole("button", { name: "20260703-1300Z", exact: true });
  await expect(latestRow).toBeVisible();
  await expect(latestRow.getByText("Built", { exact: true })).toBeVisible();
  await expect(latestRow.getByText("Latest built", { exact: true })).toBeVisible();
  await expect(latestRow.getByText("Build complete", { exact: true })).toBeVisible();
  await expect(partialRow.getByText("Partial", { exact: true })).toBeVisible();
  await expect(upstreamRow.getByText("Upstream (not built)", { exact: true })).toBeVisible();
  // The run built AND probed upstream appears exactly once.
  await expect(hrrrList.getByRole("button", { name: "20260703-1200Z", exact: true })).toHaveCount(1);

  // Frame counts: runs differ (still-uploading 13Z has 12; NAM3km 18Z has 61);
  // the stale 20-frame build shows what a re-render would gain.
  await expect(latestRow.getByText("49 frames", { exact: true })).toBeVisible();
  await expect(upstreamRow.getByText("12 frames", { exact: true })).toBeVisible();
  await expect(partialRow.getByText("20/49 frames", { exact: true })).toBeVisible();
  await expect(
    namList.getByRole("button", { name: "20260703-1800Z", exact: true }).getByText("61 frames", { exact: true }),
  ).toBeVisible();

  // Picking marks the row for THAT model only and persists per-model runs.
  await partialRow.click();
  await expect(partialRow).toHaveAttribute("aria-pressed", "true");
  await expect(latestRow).toHaveAttribute("aria-pressed", "false");
  await expect(hrrrList.getByRole("button", { name: "Latest available" })).toHaveAttribute("aria-pressed", "false");
  await expect(namList.getByRole("button", { name: "Latest available" })).toHaveAttribute("aria-pressed", "true");
  await expect(drawer.getByRole("combobox", { name: "Frames" }).locator("option[value='full']")).toHaveText(
    "Mixed: prefix + full",
  );
  await expect(drawer.getByText(/Concrete picked cycles use their currently published prefix/)).toBeVisible();

  // Once every model has a concrete pick, the unbounded choice is a published
  // prefix for every run; toggling NAM back to latest restores mixed wording.
  const namPickedRow = namList.getByRole("button", { name: "20260703-1800Z", exact: true });
  await namPickedRow.click();
  await expect(drawer.getByRole("combobox", { name: "Frames" }).locator("option[value='full']")).toHaveText(
    "Published prefix",
  );
  await expect(drawer.getByText(/each concrete picked run's currently published contiguous prefix/i)).toBeVisible();
  await namPickedRow.click();
  await expect(drawer.getByRole("combobox", { name: "Frames" }).locator("option[value='full']")).toHaveText(
    "Mixed: prefix + full",
  );

  // Multi-run queue: a second pick toggles ON alongside the first and the
  // queue note appears; picks persist as arrays.
  await upstreamRow.click();
  await expect(upstreamRow).toHaveAttribute("aria-pressed", "true");
  await expect(partialRow).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("run-queue-note-hrrr")).toContainText("2 runs queued");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = localStorage.getItem("modelview.render.v1");
        return raw ? { runs: JSON.parse(raw).runs, runMode: JSON.parse(raw).runMode } : null;
      }),
    )
    .toEqual({ runs: { hrrr: ["20260703-1100Z", "20260703-1300Z"] }, runMode: "pick" });

  // Toggling a pick off removes just that run.
  await upstreamRow.click();
  await expect(upstreamRow).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("run-queue-note-hrrr")).toHaveCount(0);

  // Submitting posts the per-model runs map (arrays): the picked run for
  // HRRR, latest for the untouched NAM3km.
  await drawer.getByRole("button", { name: "▶ Render" }).click();
  await expect.poll(() => postedBodies.length).toBe(1);
  expect(postedBodies[0].runs).toEqual({ hrrr: ["20260703-1100Z"], nam3km: ["latest"] });

  // Both spawned jobs render a progress row.
  await expect(drawer.getByRole("status", { name: "Render job" })).toHaveCount(2);
});

test("GFS run chips distinguish the 129-frame default from the 209-frame source cadence", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.route("**/__cf/actions/available-runs**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(AVAILABLE_RUNS_PAYLOAD),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("checkbox", { name: "GFS", exact: true }).check();
  await drawer.getByRole("checkbox", { name: "HRRR", exact: true }).uncheck();
  await drawer.getByRole("checkbox", { name: "NAM 3km", exact: true }).uncheck();
  await drawer.getByRole("radio", { name: "Pick from list" }).check();

  const gfsList = drawer.locator('[data-run-list="gfs"]');
  const builtRow = gfsList.getByRole("button", { name: "20260703-0000Z", exact: true });
  await expect(builtRow.getByText("129 built/default · 209 hourly-tier source", { exact: true })).toBeVisible();
  const describedText = await builtRow.evaluate((element) => {
    const id = element.getAttribute("aria-describedby");
    return id ? document.getElementById(id)?.textContent || "" : "";
  });
  expect(describedText).toContain("129 built/default · 209 hourly-tier source");
  expect(await builtRow.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(
    gfsList
      .getByRole("button", { name: "20260702-1800Z", exact: true })
      .getByText("129 3-hourly default · 209 hourly-tier source", { exact: true }),
  ).toBeVisible();

  // Selecting the optional cadence leaves both exact rosters visible.
  await drawer.getByRole("checkbox", { name: "GFS hourly F000-F120 (optional)" }).check();
  await expect(
    gfsList
      .getByRole("button", { name: "20260703-0000Z", exact: true })
      .getByText("129 built/default · 209 hourly-tier source", { exact: true }),
  ).toBeVisible();
});

test("picker shows 'No runs found' when the server has nothing for the model", async ({ page }) => {
  await page.route("**/__cf/actions/available-runs**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        view: "conus",
        runs: { hrrr: { built: [], upstream: [] }, nam3km: { built: [], upstream: [] } },
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("radio", { name: "Pick from list" }).check();

  await expect(drawer.getByText("No runs found").first()).toBeVisible();
});

test("mid-run progress uses markerCount/markerTotal when the builder summary has not landed", async ({ page }) => {
  await page.route("**/__cf/actions/render**", async (route) => {
    // Legacy single-job response shape: the client must still normalize it.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-mid" }) });
  });
  await page.route("**/__cf/actions/status/job-mid**", async (route) => {
    // Mid-run: no builder summary yet (total 0) but the on-disk marker scan
    // already knows the resolved target — the bar must show 2/5, never 2/0.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "job-mid",
        status: "running",
        built: 2,
        reused: 0,
        failed: 0,
        total: 0,
        markerCount: 2,
        markerTotal: 5,
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("button", { name: "▶ Render" }).click();

  const status = drawer.getByRole("status", { name: "Render job" });
  await expect(status).toBeVisible();
  await expect(status).toContainText("2/5");
  await expect(status).not.toContainText("2/0");
});

test("queued jobs show an indeterminate planning state before an exact denominator arrives", async ({ page }) => {
  await page.route("**/__cf/actions/render**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "job-plan" }) });
  });
  await page.route("**/__cf/actions/status/job-plan**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "job-plan",
        status: "queued",
        built: 0,
        reused: 0,
        failed: 0,
        total: 0,
        markerCount: 0,
        markerTotal: 0,
      }),
    });
  });

  await page.goto("/");
  const drawer = await openRenderMenu(page);
  await drawer.getByRole("button", { name: "▶ Render" }).click();
  const status = drawer.getByRole("status", { name: "Render job" });
  await expect(status).toContainText("planning target");
  await expect(status).not.toContainText("0/0");
});
