const fs = require("fs");
const path = require("path");
const { test, expect } = require("./helpers/test");

// Explicit coverage for the cross-panel viewport-sync subsystem
// (next/src/core/viewport-sync.ts): with two panels (viewport linking is on by
// default), dragging or zooming one panel must converge BOTH panels'
// viewports and then hold them still. The sync is rAF-coalesced,
// epsilon-guarded, and echo-suppressed via e.meta.wxSync — a regression there
// shows up either as permanent divergence (convergence assertions) or as
// A→B→A ping-pong (the no-oscillation sampling).
//
// (The leaflet/mixed engine matrix died with Leaflet in Task 6.3; MapLibre is
// the only engine, and it applies fractional centers exactly, so convergence
// is asserted at the bare 2× epsilon bound with no pixel-quantum slack.)

// The app's own sync thresholds, parsed from the source so spec and app can
// never drift apart silently.
const syncSource = fs.readFileSync(path.join(__dirname, "../next/src/core/viewport-sync.ts"), "utf8");
const MOVE_EPSILON_DEG = readConstant(syncSource, "MOVE_EPSILON_DEG");
const ZOOM_EPSILON = readConstant(syncSource, "ZOOM_EPSILON");
// Convergence bar: 2× the app's thresholds. The controller stops syncing once
// a delta drops below 1×, so a legitimately settled pair can sit just under
// 1× apart; 2× keeps the assertion meaningful without racing that guard.
const MOVE_TOLERANCE_DEG = MOVE_EPSILON_DEG * 2;
const ZOOM_TOLERANCE = ZOOM_EPSILON * 2;

// Boot INSIDE the conus view at an explicit ?c= viewport (zs=2 = native-zoom
// permalink, Task 6.2) instead of the default bounds fit: a deterministic
// zoomed-in camera gives the drag/zoom gestures known slack in every
// direction. (Historical note: pre-Stage-A this boot was load-bearing —
// maxBounds was the view bbox, so the default fit had ~zero pan slack and
// drags were no-ops. Since Stage A the pan cage is PAN_BOUNDS (basemap
// coverage, constants.ts) and the view bbox is the fit target only — the
// Stage A scenario below covers that directly.)
const PANEL_PARAMS = "p1=gfs:temperature&p2=nam3km:temperature&c=39,-96,5&zs=2";

function readConstant(source, name) {
  const match = new RegExp(`const ${name} = ([0-9.e-]+);`).exec(source);
  if (!match) {
    throw new Error(`viewport-sync.spec: could not read ${name} from next/src/core/viewport-sync.ts`);
  }
  return Number(match[1]);
}

// ── window.__wx bridge readers (the only allowed map-state surface) ─────────

function readViewports(page) {
  return page.evaluate(() => {
    const bridge = window.__wx;
    if (!bridge || bridge.panels().length < 2) {
      return null;
    }
    try {
      return bridge.panels().map((id) => bridge.getViewport(id));
    } catch {
      return null;
    }
  });
}

// ── viewport math ───────────────────────────────────────────────────────────

function isConverged([a, b]) {
  return (
    Math.abs(a.lat - b.lat) <= MOVE_TOLERANCE_DEG &&
    Math.abs(a.lon - b.lon) <= MOVE_TOLERANCE_DEG &&
    Math.abs(a.zoom - b.zoom) <= ZOOM_TOLERANCE
  );
}

function isStill(current, previous) {
  return current.every(
    (view, index) =>
      Math.abs(view.lat - previous[index].lat) <= MOVE_EPSILON_DEG &&
      Math.abs(view.lon - previous[index].lon) <= MOVE_EPSILON_DEG &&
      Math.abs(view.zoom - previous[index].zoom) <= ZOOM_EPSILON,
  );
}

function moveDelta(a, b) {
  return Math.abs(a.lat - b.lat) + Math.abs(a.lon - b.lon);
}

// Diagnostic line for a not-yet-settled sample: which check is failing
// (stillness vs convergence), both panels' viewports, and the deltas against
// their tolerances — this is what a waitForSettled timeout prints.
function describeUnsettled(current, previous, { still, isConv }) {
  const [a, b] = current;
  const failing = [];
  if (!still) {
    failing.push(previous ? "stillness (moved since previous sample)" : "stillness (first sample)");
  }
  if (!isConv) {
    failing.push("convergence (cross-panel delta over tolerance)");
  }
  const fmt = (v) => `{lat:${v.lat.toFixed(6)} lon:${v.lon.toFixed(6)} zoom:${v.zoom.toFixed(3)}}`;
  const exp = (value) => value.toExponential(2);
  return (
    `failing: ${failing.join(" + ") || "nothing (race)"}; panel1=${fmt(a)} panel2=${fmt(b)}; ` +
    `cross-panel deltas lat=${exp(Math.abs(a.lat - b.lat))} lon=${exp(Math.abs(a.lon - b.lon))} ` +
    `zoom=${exp(Math.abs(a.zoom - b.zoom))} vs tolerances move=${exp(MOVE_TOLERANCE_DEG)} zoom=${exp(ZOOM_TOLERANCE)}`
  );
}

// Poll until both viewports have stopped moving between consecutive samples
// (drag inertia / zoom easing keep linked maps moving in tandem after the
// gesture ends) and agree within tolerance. Returns the settled
// [panel1, panel2] viewports. The poll yields null once settled and a
// diagnostic string while not, so a timeout fails with the last-seen
// viewports/deltas and the failing check instead of a bare boolean.
async function waitForSettled(page) {
  let previous = null;
  let settled = null;
  await expect
    .poll(
      async () => {
        const current = await readViewports(page);
        if (!current) {
          previous = current;
          return "bridge not ready: window.__wx missing or fewer than two live panels";
        }
        const still = Boolean(previous) && isStill(current, previous);
        const isConv = isConverged(current);
        const diagnostic = still && isConv ? null : describeUnsettled(current, previous, { still, isConv });
        if (diagnostic === null) {
          settled = current;
        }
        previous = current;
        return diagnostic;
      },
      { timeout: 15_000, intervals: [150] },
    )
    .toBeNull();
  return settled;
}

// After settling, the sync must go quiet: sample both panels every ~100 ms
// for a second and require them pinned to the settled viewport. A broken
// echo guard (meta.wxSync lost) shows up here as ping-pong between panels.
async function expectNoOscillation(page) {
  const samples = await page.evaluate(async () => {
    const bridge = window.__wx;
    const ids = bridge.panels();
    const out = [];
    for (let i = 0; i < 11; i += 1) {
      out.push(ids.map((id) => bridge.getViewport(id)));
      if (i < 10) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return out;
  });
  const baseline = samples[0];
  for (const sample of samples.slice(1)) {
    expect(isStill(sample, baseline), `viewports moved after settling: ${JSON.stringify({ baseline, sample })}`).toBe(
      true,
    );
  }
}

// ── gestures ────────────────────────────────────────────────────────────────

async function dragPanelMap(page, panelIndex, dx, dy) {
  const host = page.locator("article").nth(panelIndex).locator('[data-testid="map-canvas-host"]');
  await expect(host).toBeVisible();
  const box = await host.boundingBox();
  if (!box) {
    throw new Error(`No bounding box for panel ${panelIndex + 1} map host.`);
  }
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Deliberate multi-step drag: a fast flick triggers pan inertia, which
  // keeps both maps easing long after mouseup and muddies the settle window.
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(startX + (dx * i) / steps, startY + (dy * i) / steps);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
}

// ── boot ────────────────────────────────────────────────────────────────────

async function bootTwoPanels(page) {
  await page.goto(`/?${PANEL_PARAMS}`);
  await expect(page.locator("article")).toHaveCount(2);
  await expect.poll(() => readViewports(page), { timeout: 30_000 }).not.toBeNull();
}

// ── scenarios ───────────────────────────────────────────────────────────────

test("dragging panel 1 converges both panels, then no oscillation", async ({ page }) => {
  await bootTwoPanels(page);
  const before = await waitForSettled(page);
  await dragPanelMap(page, 0, 140, 90);
  const settled = await waitForSettled(page);
  // The drag must actually have moved panel 1 (no vacuous pass on two
  // never-moved panels) ...
  expect(moveDelta(settled[0], before[0])).toBeGreaterThan(0.05);
  // ... and linking is on by default: the un-dragged panel must have followed.
  expect(moveDelta(settled[1], before[1])).toBeGreaterThan(0.05);
  await expectNoOscillation(page);
});

// ── Stage A pan bounds (docs/basemap-expansion-plan.md) ─────────────────────
// The pan cage is PAN_BOUNDS (basemap coverage, west -170), decoupled from
// the conus view bbox (west -129), which is now the FIT target only. From the
// CONUS DEFAULT fit (no ?c=), the camera sits on the view's minZoom floor
// (VIEW_CONFIG conus zoom = 3) and must be able to pan west past lon -135 —
// 6 deg beyond the old cage's west EDGE, unreachable under the old
// maxBounds even with the viewport pinned against it. Under the old cage
// this camera also had ~zero pan slack (and wide panels were force-zoomed
// above minZoom, since MapLibre constrains zoom up when maxBounds is
// narrower than the viewport), so the pan must succeed WITHOUT any zoom
// change.
const CONUS_MIN_ZOOM = 3; // VIEW_CONFIG.conus.zoom (= the view's minZoom clamp)

test("Stage A: from the CONUS default fit, panning west past lon -135 succeeds at min zoom", async ({ page }) => {
  await page.goto("/?p1=gfs:temperature&p2=nam3km:temperature");
  await expect(page.locator("article")).toHaveCount(2);
  await expect.poll(() => readViewports(page), { timeout: 30_000 }).not.toBeNull();
  const before = await waitForSettled(page);
  // Default fit lands on the minZoom floor — the force-zoom cage would have
  // pushed it above.
  expect(Math.abs(before[0].zoom - CONUS_MIN_ZOOM)).toBeLessThanOrEqual(0.05);

  // Drag west (mouse right = camera west) until the center clears lon -135.
  // ~22 deg per 250 px drag at zoom 3; a couple of drags suffice, capped
  // defensively — a re-caged map makes the drags no-ops and the loop exits
  // with lon stuck near the old fit center (~-96), failing the assertion.
  let lon = before[0].lon;
  for (let i = 0; i < 8 && lon >= -135; i += 1) {
    await dragPanelMap(page, 0, 250, 0);
    const settled = await waitForSettled(page);
    lon = settled[0].lon;
  }
  expect(lon).toBeLessThan(-135);
  // The whole pan happened at the minZoom floor: no force-zoom, on either
  // panel (sync mirrors the camera, so panel 2 proves the cage app-wide).
  const after = await readViewports(page);
  expect(Math.abs(after[0].zoom - CONUS_MIN_ZOOM)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(after[1].zoom - CONUS_MIN_ZOOM)).toBeLessThanOrEqual(0.05);
});

test("zooming panel 1 via the zoom control converges both panels", async ({ page }) => {
  await bootTwoPanels(page);
  const before = await waitForSettled(page);
  await page.locator("article").nth(0).getByTestId("map-zoom-in").click();
  await expect
    .poll(async () => (await readViewports(page))?.[0].zoom ?? Number.NaN, { timeout: 10_000 })
    .toBeGreaterThan(before[0].zoom + 0.9);
  const settled = await waitForSettled(page);
  // Both panels ended up one zoom step above where the un-zoomed panel
  // started.
  expect(settled[1].zoom).toBeGreaterThan(before[1].zoom + 0.9);
  await expectNoOscillation(page);
});
