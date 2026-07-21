const { test, expect } = require("./helpers/test");

// Reuse the panel-collection fixture routing so panels resolve a manifest.
const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWNoaGj4DwAFhAKAfr3l1AAAAABJRU5ErkJggg==";

function latestPointer(model, key) {
  return {
    model,
    run: "20260423-1200Z",
    view: "conus",
    generatedAt: "2026-04-23T12:10:00Z",
    manifestKey: key,
    frameCount: 1,
  };
}
function buildManifest(model) {
  return {
    schemaVersion: 4,
    model,
    run: "20260423-1200Z",
    view: "conus",
    generatedAt: "2026-04-23T12:10:00Z",
    referenceTime: "2026-04-23T12:00:00Z",
    openDataModel: "noaa-gfs-pgrb2-0p25",
    hourStatus: { 0: "loaded" },
    frames: [
      {
        hour: 0,
        validHourKey: "2026-04-23T12:00:00Z",
        bounds: { north: 53, south: 21, west: -129, east: -63 },
        cols: 1600,
        rows: 980,
        layers: { temperature: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE } },
      },
    ],
  };
}
async function routeModelFixtures(page, models) {
  for (const model of models) {
    await page.route(`**/__cf/manifests/${model}/latest.json**`, (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(latestPointer(model, `manifests/${model}/p.json`)),
      }),
    );
    await page.route(`**/__cf/manifests/${model}/p.json**`, (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(buildManifest(model)) }),
    );
  }
}

test("URL view/model params override storage on load", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.addInitScript(() => {
    window.localStorage.setItem("modelview.session.v2", JSON.stringify({ viewKey: "conus" }));
  });
  await page.goto("/?view=na&model=hrrr");
  await expect(page.getByLabel("View")).toHaveValue("na");
  await expect(page.getByLabel("Model", { exact: true }).first()).toHaveValue("hrrr");
});

test("changing the view writes ?view= into the URL via replaceState", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.goto("/");
  await page.getByLabel("View").selectOption("na");
  await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get("view"))).toBe("na");
  // replaceState (not pushState): one back step leaves the app entirely.
  const historyLen = await page.evaluate(() => history.length);
  await page.getByLabel("View").selectOption("conus");
  await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get("view"))).toBe("conus");
  expect(await page.evaluate(() => history.length)).toBe(historyLen);
});

test("a ?p1=&p2= roster restores both panels with their layers; URL mirrors the roster", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.goto("/?p1=hrrr:temperature&p2=gfs:temperature");

  const modelSelects = page.getByLabel("Model", { exact: true });
  await expect(modelSelects).toHaveCount(2);
  await expect(modelSelects.nth(0)).toHaveValue("hrrr");
  await expect(modelSelects.nth(1)).toHaveValue("gfs");

  // The write path keeps the roster (and drops legacy model/layer params).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const params = new URL(location.href).searchParams;
        return { p1: params.get("p1"), p2: params.get("p2"), model: params.get("model"), layer: params.get("layer") };
      }),
    )
    .toEqual({ p1: "hrrr:temperature", p2: "gfs:temperature", model: null, layer: null });
});

test("legacy ?model=&layer= links still steer the first panel", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.goto("/?model=nam&layer=temperature");
  await expect(page.getByLabel("Model", { exact: true }).first()).toHaveValue("nam");
});

// Bridge viewport of the first panel (zoom is NATIVE maplibre scale, the
// app-wide zoom unit since Task 6.2).
function readPrimaryViewport(page) {
  return page.evaluate(() => {
    const bridge = window.__wx;
    if (!bridge || bridge.panels().length === 0) {
      return null;
    }
    try {
      return bridge.getViewport(bridge.panels()[0]);
    } catch {
      return null;
    }
  });
}

test("the map viewport round-trips through ?c= (native zoom + zs=2) and session storage", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.goto("/?c=39.5,-98.25,5&zs=2");

  // The initial fit honors the restored center/zoom instead of the view fit,
  // and the writer keeps the native zoom + scale marker verbatim.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const params = new URL(location.href).searchParams;
        return { c: params.get("c"), zs: params.get("zs") };
      }),
    )
    .toEqual({ c: "39.500,-98.250,5", zs: "2" });

  // Session storage (v2 = native zoom) carries the viewport for the next
  // plain load.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("modelview.session.v2");
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed?.viewports?.conus ?? null;
      }),
    )
    .toEqual({ lat: 39.5, lon: -98.25, zoom: 5 });

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get("c"))).toBe("39.500,-98.250,5");
  await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get("zs"))).toBe("2");
});

test("a legacy pre-6.2 permalink (?c= without zs) restores the same visual extent and rewrites native", async ({
  page,
}) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  // Legacy compat-scale zoom 6 == native 5: the SAME ground scale, so an old
  // bookmark shows exactly the extent it always did.
  await page.goto("/?c=39.5,-98.25,6");

  await expect
    .poll(async () => {
      const vp = await readPrimaryViewport(page);
      return vp ? { lat: Math.round(vp.lat * 100) / 100, lon: Math.round(vp.lon * 100) / 100, zoom: vp.zoom } : null;
    })
    .toEqual({ lat: 39.5, lon: -98.25, zoom: 5 });

  // The app rewrites the URL to the new form: native zoom + zs=2 marker.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const params = new URL(location.href).searchParams;
        return { c: params.get("c"), zs: params.get("zs") };
      }),
    )
    .toEqual({ c: "39.500,-98.250,5", zs: "2" });
});

test("a legacy v1 session payload restores its viewport at the same visual extent", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  // v1 viewports stored compat-scale zooms; the loader converts them -1 to
  // native on the way in (modelview.session.v2 is the only write target).
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "modelview.session.v1",
      JSON.stringify({ viewKey: "conus", viewports: { conus: { lat: 39.5, lon: -98.25, zoom: 6 } } }),
    );
  });
  await page.goto("/");

  await expect
    .poll(async () => {
      const vp = await readPrimaryViewport(page);
      return vp ? { lat: Math.round(vp.lat * 100) / 100, lon: Math.round(vp.lon * 100) / 100, zoom: vp.zoom } : null;
    })
    .toEqual({ lat: 39.5, lon: -98.25, zoom: 5 });

  // The migrated viewport persists forward under the v2 key (native zoom).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("modelview.session.v2");
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed?.viewports?.conus ?? null;
      }),
    )
    .toEqual({ lat: 39.5, lon: -98.25, zoom: 5 });
});

test("Share copies the current URL to the clipboard and toasts", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "Link copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("view=conus");
  expect(copied).toContain("p1=");
});
