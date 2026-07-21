const { test, expect } = require("./helpers/test");

function encodeInt16(values) {
  return Buffer.from(Int16Array.from(values).buffer).toString("base64");
}

function buildHoverGridPayload() {
  return {
    schemaVersion: 1,
    rows: 1,
    cols: 1,
    variables: {
      temperatureF: { scale: 1, offset: 0, missing: -32768, data: encodeInt16([50]) },
      windKt: { scale: 1, offset: 0, missing: -32768, data: encodeInt16([10]) },
      precipMm: { scale: 1, offset: 0, missing: -32768, data: encodeInt16([0]) },
      capeJkg: { scale: 1, offset: 0, missing: -32768, data: encodeInt16([100]) },
      pressureHpa: { scale: 1, offset: 0, missing: -32768, data: encodeInt16([1000]) },
    },
  };
}

function buildSynopticPayload() {
  return {
    styleVersion: "v4-operational-contrast",
    isobars: { lines: [], labels: [] },
    thickness: { lines: [], labels: [] },
    centers: { highs: [], lows: [] },
  };
}

test("synoptic vector joiner survives the first consumer's abort", async ({ page }) => {
  let releaseResponse;
  const responseGate = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  let requestCount = 0;
  await page.route("**/fixtures/abort-race/module/synoptic-simple.json**", async (route) => {
    requestCount += 1;
    await responseGate;
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildSynopticPayload()),
      });
    } catch {
      // The browser may have aborted the request while the gate was held.
    }
  });

  await page.goto("/");

  await page.evaluate(async () => {
    const client = await import("/src/core/artifact-client.ts");
    const frame = {
      hour: 0,
      validHourKey: "2026-04-23T12:00:00Z",
      bounds: { north: 53, south: 21, west: -129, east: -63 },
      layers: {},
      synopticVectorKeys: { simple: "fixtures/abort-race/module/synoptic-simple.json" },
      synopticStyleVersions: { simple: "v4-operational-contrast" },
    };
    const first = new AbortController();
    const second = new AbortController();
    const state = { client, frame, first, second, firstOutcome: null, secondOutcome: null };
    state.firstPromise = client
      .fetchSynopticVectorPayload(frame, { signal: first.signal })
      .then(() => {
        state.firstOutcome = "resolved";
      })
      .catch((error) => {
        state.firstOutcome = String((error && error.name) || error);
      });
    state.secondPromise = client
      .fetchSynopticVectorPayload(frame, { signal: second.signal })
      .then((payload) => {
        state.secondOutcome = payload && payload.styleVersion ? "resolved" : "empty";
      })
      .catch((error) => {
        state.secondOutcome = String((error && error.name) || error);
      });
    window.__abortRace = state;
  });

  await expect.poll(() => requestCount).toBe(1);

  await page.evaluate(async () => {
    window.__abortRace.first.abort();
    await window.__abortRace.firstPromise;
  });
  expect(await page.evaluate(() => window.__abortRace.firstOutcome)).toBe("AbortError");

  // Give an incorrectly shared abort a beat to propagate before releasing the response.
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__abortRace.secondOutcome)).toBe(null);

  releaseResponse();
  await page.evaluate(() => window.__abortRace.secondPromise);
  expect(await page.evaluate(() => window.__abortRace.secondOutcome)).toBe("resolved");
  expect(requestCount).toBe(1);
});

test("hover grid aborts the underlying request only after every consumer aborts", async ({ page }) => {
  const parkedResponses = [];
  let requestCount = 0;
  let parkedRequest = null;
  const failedHoverGridRequests = [];
  page.on("requestfailed", (request) => {
    if (request.url().includes("fixtures/abort-race/module/hover-grid.json")) {
      failedHoverGridRequests.push(request);
    }
  });
  await page.route("**/fixtures/abort-race/module/hover-grid.json**", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      parkedRequest = route.request();
      await new Promise((resolve) => parkedResponses.push(resolve));
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildHoverGridPayload()),
      });
    } catch {
      // The browser may have aborted the request while it was parked.
    }
  });

  await page.goto("/");

  await page.evaluate(async () => {
    const client = await import("/src/core/artifact-client.ts");
    const frame = {
      hour: 0,
      validHourKey: "2026-04-23T12:00:00Z",
      bounds: { north: 53, south: 21, west: -129, east: -63 },
      layers: {},
      hoverGridKey: "fixtures/abort-race/module/hover-grid.json",
      hoverGridSchemaVersion: 1,
    };
    const first = new AbortController();
    const second = new AbortController();
    const state = { client, frame, first, second, firstOutcome: null, secondOutcome: null, thirdOutcome: null };
    state.firstPromise = client
      .fetchHoverGridPayload(frame, { signal: first.signal })
      .then(() => {
        state.firstOutcome = "resolved";
      })
      .catch((error) => {
        state.firstOutcome = String((error && error.name) || error);
      });
    state.secondPromise = client
      .fetchHoverGridPayload(frame, { signal: second.signal })
      .then(() => {
        state.secondOutcome = "resolved";
      })
      .catch((error) => {
        state.secondOutcome = String((error && error.name) || error);
      });
    window.__abortRace = state;
  });

  await expect.poll(() => requestCount).toBe(1);

  await page.evaluate(async () => {
    window.__abortRace.first.abort();
    await window.__abortRace.firstPromise;
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__abortRace.secondOutcome)).toBe(null);
  // The surviving consumer must keep the underlying network request alive.
  expect(parkedRequest.failure()).toBe(null);
  expect(failedHoverGridRequests).toHaveLength(0);

  await page.evaluate(async () => {
    window.__abortRace.second.abort();
    await window.__abortRace.secondPromise;
  });
  expect(await page.evaluate(() => window.__abortRace.secondOutcome)).toBe("AbortError");

  // Once the LAST consumer aborts, the shared controller must cancel the
  // underlying network request — teardown alone (refetch below) is not enough.
  await expect
    .poll(() => failedHoverGridRequests.length, {
      message: "underlying hover-grid request was never cancelled after every consumer aborted",
    })
    .toBe(1);
  expect(parkedRequest.failure()).not.toBeNull();

  // With every consumer gone the shared entry must be torn down so a fresh call refetches.
  await page.evaluate(async () => {
    const state = window.__abortRace;
    const payload = await state.client.fetchHoverGridPayload(state.frame, {});
    state.thirdOutcome = payload && payload.rows === 1 ? "resolved" : "unexpected";
  });
  expect(await page.evaluate(() => window.__abortRace.thirdOutcome)).toBe("resolved");
  expect(requestCount).toBe(2);

  for (const release of parkedResponses) {
    release();
  }
});

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";
const ONE_BY_ONE_BYTES = Buffer.from(ONE_BY_ONE.split(",")[1], "base64");
const MODELS = ["gfs", "nam", "nam3km", "hrrr"];

// The hover readout's sampleHoverVariableAtPoint rejects grids smaller than
// 2x2 (hover-utils.ts), so the UI panel gets a 2x2 grid; constant values make
// the bilinear sample exactly 50 -> "50.0 °F" wherever the cursor lands.
function buildUiHoverGridPayload() {
  const fill = (value) => encodeInt16([value, value, value, value]);
  return {
    schemaVersion: 1,
    rows: 2,
    cols: 2,
    variables: {
      temperatureF: { scale: 1, offset: 0, missing: -32768, data: fill(50) },
      windKt: { scale: 1, offset: 0, missing: -32768, data: fill(10) },
      precipMm: { scale: 1, offset: 0, missing: -32768, data: fill(0) },
      capeJkg: { scale: 1, offset: 0, missing: -32768, data: fill(100) },
      pressureHpa: { scale: 1, offset: 0, missing: -32768, data: fill(1000) },
    },
  };
}

function buildUiFrame(model, hour) {
  const padded = String(hour).padStart(3, "0");
  return {
    hour,
    validHourKey: `2026-04-23T${String(12 + hour).padStart(2, "0")}:00:00Z`,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    cols: 1600,
    rows: 980,
    layers: {
      temperature: {
        key: `fixtures/abort-race/ui/${model}/${padded}/temperature.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
    },
    hoverGridKey: `fixtures/abort-race/ui/${model}/${padded}/hover-grid.json`,
    hoverGridSchemaVersion: 1,
  };
}

function countBySuffix(counts, suffix) {
  let total = 0;
  for (const [pathname, count] of counts) {
    if (pathname.endsWith(suffix)) {
      total += count;
    }
  }
  return total;
}

test("removing one panel does not clear the other panel's hover grid", async ({ page }) => {
  let releaseGfsHover;
  const gfsHoverGate = new Promise((resolve) => {
    releaseGfsHover = resolve;
  });
  const hoverRequestCounts = new Map();

  for (const model of MODELS) {
    await page.route(`**/manifests/${model}/latest.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          model,
          run: "20260423-1200Z",
          view: "conus",
          generatedAt: "2026-04-23T12:10:00Z",
          manifestKey: `manifests/${model}/abort-race-ui.json`,
          frameCount: 2,
        }),
      });
    });
    await page.route(`**/manifests/${model}/abort-race-ui.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: 4,
          model,
          run: "20260423-1200Z",
          view: "conus",
          generatedAt: "2026-04-23T12:10:00Z",
          referenceTime: "2026-04-23T12:00:00Z",
          openDataModel: "noaa-gfs-pgrb2-0p25",
          hourStatus: { 0: "loaded", 3: "loaded" },
          frames: [buildUiFrame(model, 0), buildUiFrame(model, 3)],
        }),
      });
    });
  }
  await page.route("**/fixtures/abort-race/ui/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.includes("hover-grid")) {
      hoverRequestCounts.set(pathname, (hoverRequestCounts.get(pathname) || 0) + 1);
      if (pathname.includes("/gfs/")) {
        await gfsHoverGate;
      }
      try {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(buildUiHoverGridPayload()),
        });
      } catch {
        // The browser may have aborted the request while the gate was held.
      }
      return;
    }
    await route.fulfill({ status: 200, contentType: "image/png", body: ONE_BY_ONE_BYTES });
  });

  await page.goto(`/?hour=${encodeURIComponent("2026-04-23T12:00:00Z")}`);
  const firstPanel = page.locator("article").first();
  await expect(firstPanel.getByTestId("panel-status")).toHaveText("Ready");
  const firstBox = await firstPanel.boundingBox();
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
  await expect.poll(() => countBySuffix(hoverRequestCounts, "/gfs/000/hover-grid.json")).toBe(1);

  await page.getByRole("button", { name: "Add Map" }).click();
  await expect(page.locator("article")).toHaveCount(2);
  const secondPanel = page.locator("article").nth(1);
  await secondPanel.getByLabel("Model", { exact: true }).selectOption("gfs");
  await expect(secondPanel.getByText("Ready", { exact: true }).first()).toBeVisible();
  const secondBox = await secondPanel.boundingBox();
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);

  // The second panel must join the still-pending gfs hover fetch, not start a new one.
  await page.waitForTimeout(400);
  expect(countBySuffix(hoverRequestCounts, "/gfs/000/hover-grid.json")).toBe(1);

  await firstPanel.getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("article")).toHaveCount(1);
  // Let the removed panel's hook/prefetch aborts propagate before the response arrives.
  await page.waitForTimeout(200);
  releaseGfsHover();

  const remainingPanel = page.locator("article").first();
  const box = await remainingPanel.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10, { steps: 2 });
  await expect(remainingPanel.getByText("50.0 °F")).toBeVisible({ timeout: 5000 });

  // The surviving panel must still be serving the ORIGINAL shared fetch, not a
  // retry through the reopened gate: guards against a future retry-on-abort
  // wrong-fix that would mask the shared-abort symptom.
  expect(countBySuffix(hoverRequestCounts, "/gfs/000/hover-grid.json")).toBe(1);
});
