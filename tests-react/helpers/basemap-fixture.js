const fs = require("fs");
const path = require("path");

// ── MapLibre basemap fixture routing (shared) ────────────────────────────────
// Panels boot against the artifact server's /basemap/na.pmtiles Range route,
// backed by a ~16 GB local extract (output/basemap/) that not every machine
// has — on a machine without it the engine reports a fatal basemap error.
// For determinism, spec runs serve the committed CONUS z0–5 fixture through
// Playwright routing instead, byte-range semantics included (the pmtiles
// client fetches slices, cross-origin, so the preflight and CORS headers
// mirror the artifact server's).
//
// `target` is a Page or a BrowserContext (both expose .route with the same
// signature): the shared fixture in helpers/test.js routes every context;
// specs that need routing to win over their own broader routes (e.g. the
// error-state and offline-boot drills) also route their page/context
// directly — page routes take precedence over context routes.
const BASEMAP_FIXTURE = path.join(__dirname, "../fixtures/basemap-fixture.pmtiles");

async function routeBasemapFixture(target) {
  const body = fs.readFileSync(BASEMAP_FIXTURE);
  const corsHeaders = {
    "accept-ranges": "bytes",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "Content-Range,Accept-Ranges,Content-Length,ETag",
  };
  await target.route("**/basemap/*.pmtiles", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,HEAD,OPTIONS",
          "access-control-allow-headers": "Content-Type,If-None-Match,Range",
        },
      });
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || "");
    if (!match) {
      await route.fulfill({ status: 200, contentType: "application/octet-stream", body, headers: corsHeaders });
      return;
    }
    const start = Number(match[1]);
    const end = match[2] === "" ? body.length - 1 : Math.min(Number(match[2]), body.length - 1);
    await route.fulfill({
      status: 206,
      contentType: "application/octet-stream",
      body: body.subarray(start, end + 1),
      headers: { ...corsHeaders, "content-range": `bytes ${start}-${end}/${body.length}` },
    });
  });
}

module.exports = { routeBasemapFixture };
