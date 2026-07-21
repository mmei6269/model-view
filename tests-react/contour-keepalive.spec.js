const { test, expect } = require("./helpers/test");
const { routeBasemapFixture } = require("./helpers/basemap-fixture");

// ── Native height-contour keep-alive (Task 4.4) ─────────────────────────────
// The contour hook used to sweep/re-add its three engine layer ids on EVERY
// frame change (payload state clears while the next frame's vector payload
// fetches). The synoptic path keeps its ids mounted with empty-collection
// gaps; this spec pins the same treatment for contours on the maplibre
// engine: stepping to a frame whose payload has not arrived must keep
// "contour-height500{,-major,-labels}" mounted (with zero features), and the
// payload's arrival must fill them back in — no layer churn.

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";

const RUN = "20260701-0000Z";

function frameSetAt(offsetHours) {
  const now = Date.now();
  const iso = (ms) => new Date(Math.floor(ms / 3600000) * 3600000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return offsetHours.map((offset) => iso(now + offset * 3600000));
}

function buildManifest(valids) {
  return {
    schemaVersion: 4,
    model: "gfs",
    run: RUN,
    view: "conus",
    generatedAt: valids[0],
    referenceTime: valids[0],
    openDataModel: "noaa-gfs",
    hourStatus: Object.fromEntries(valids.map((_, i) => [i * 6, "loaded"])),
    frames: valids.map((valid, i) => ({
      hour: i * 6,
      validHourKey: valid,
      bounds: { north: 53, south: 21, west: -129, east: -63 },
      cols: 1600,
      rows: 980,
      layers: { height500: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE } },
      contourVectorRefs: { height500: { key: `vectors/gfs/h500-f00${i * 6}.json`, bytes: 400 } },
    })),
  };
}

function contourPayload() {
  return {
    styleVersion: "test-1",
    layerType: "height500",
    contourLevelMb: 500,
    contourIntervalDam: 6,
    lines: [
      {
        points: [
          [30, -120],
          [35, -100],
          [30, -80],
        ],
        value: 570,
        kind: "height",
      },
      {
        points: [
          [40, -120],
          [45, -100],
          [40, -80],
        ],
        value: 576,
        kind: "height-major",
      },
    ],
    labels: [],
  };
}

async function routeGfs(page, valids) {
  await page.route("**/__cf/manifests/gfs/latest.json**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: RUN,
        view: "conus",
        generatedAt: valids[0],
        manifestKey: "manifests/gfs/p.json",
        frameCount: valids.length,
      }),
    }),
  );
  await page.route("**/__cf/manifests/gfs/p.json**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildManifest(valids)),
    }),
  );
}

function bridgeContourState(page) {
  return page.evaluate(() => {
    const bridge = window.__wx;
    if (!bridge || bridge.panels().length === 0) {
      return null;
    }
    const id = bridge.panels()[0];
    try {
      return {
        kind: bridge.getEngineKind(id),
        order: bridge.getLayerOrder(id),
        labelFeatures: bridge.getSymbolFeatureCount(id, "contour-height500-labels"),
      };
    } catch {
      return null;
    }
  });
}

test("frame steps keep contour layer ids mounted through payload gaps", async ({ page }) => {
  const valids = frameSetAt([0, 6]);
  await routeGfs(page, valids);
  await routeBasemapFixture(page);

  // Frame 0's contour payload resolves immediately; frame 6's is HELD until
  // the spec releases it, freezing the "payload gap" the keep-alive covers.
  let releaseF006;
  const f006Gate = new Promise((resolve) => {
    releaseF006 = resolve;
  });
  await page.route("**/vectors/gfs/h500-f000.json**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(contourPayload()) }),
  );
  await page.route("**/vectors/gfs/h500-f006.json**", async (r) => {
    await f006Gate;
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(contourPayload()) });
  });

  await page.goto(`/?p1=gfs:height500&hour=${encodeURIComponent(valids[0])}`);
  await expect(page.getByTestId("frame-label")).toHaveText("F000", { timeout: 15_000 });

  // Frame 0: all three contour ids mounted, label features present.
  const CONTOUR_IDS = ["contour-height500", "contour-height500-major", "contour-height500-labels"];
  await expect
    .poll(
      async () => {
        const state = await bridgeContourState(page);
        return state ? CONTOUR_IDS.every((id) => state.order.includes(id)) && state.labelFeatures > 0 : false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // Step to frame 6, whose payload is gated: the ids must SURVIVE the gap
  // (empty collections), not get swept and re-added later.
  await page.getByRole("button", { name: "Next frame" }).click();
  await expect(page.getByTestId("frame-label")).toHaveText("F006", { timeout: 15_000 });
  const during = await bridgeContourState(page);
  for (const id of CONTOUR_IDS) {
    expect(during.order).toContain(id);
  }
  expect(during.labelFeatures).toBe(0);
  // The gap is stable, not a transient re-add racing the assertion.
  await page.waitForTimeout(400);
  const still = await bridgeContourState(page);
  for (const id of CONTOUR_IDS) {
    expect(still.order).toContain(id);
  }
  expect(still.labelFeatures).toBe(0);

  // Releasing the payload fills the SAME mounted layers back in.
  releaseF006();
  await expect
    .poll(async () => (await bridgeContourState(page))?.labelFeatures, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const after = await bridgeContourState(page);
  for (const id of CONTOUR_IDS) {
    expect(after.order).toContain(id);
  }
});
