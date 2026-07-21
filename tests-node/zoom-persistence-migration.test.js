"use strict";
// Task 6.2 persisted-state migration: the app's zoom unit changed from the
// Phase 1–5 compat scale (= leaflet zoom) to NATIVE MapLibre zoom (one level
// lower for the same ground scale). Old persisted viewports must keep their
// exact visual extent:
//  - URL `?c=lat,lon,zoom`: new links carry a zoom-scale marker `zs=2` and a
//    native zoom; legacy links (no zs) are read as leaflet-scale and
//    converted −1 on read.
//  - Session storage: `modelview.session.v2` stores native-zoom viewports;
//    a v1 payload (`modelview.session.v1`, compat zooms) is read as fallback
//    with viewport zooms converted −1. Writes only ever go to v2.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

// Bundle a next/src TS module (imports resolved) to CJS and evaluate it with
// an injectable `window` — url-state and session only touch the DOM through
// that one global, so a plain object per test is a full harness.
function loadModule(relPath, windowShim) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "next", "src", relPath)],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    mainFields: ["module", "main"],
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require, window) { ${code}\n})`, {
    filename: relPath,
  }).runInThisContext();
  fn(moduleShim, moduleShim.exports, require, windowShim);
  return moduleShim.exports;
}

function fakeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    dump: () => Object.fromEntries(store),
  };
}

function urlWindow(search) {
  const win = {
    location: { search, pathname: "/" },
    history: {
      state: null,
      replaceState(state, _title, url) {
        const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
        win.location.search = query;
      },
    },
  };
  return win;
}

// ── URL `?c=` migration ──────────────────────────────────────────────────────

test("url-state: writer emits native zoom plus the zs=2 scale marker", () => {
  const win = urlWindow("");
  const { writeUrlState } = loadModule("core/url-state.ts", win);
  writeUrlState({
    view: "conus",
    hour: null,
    panels: null,
    center: { lat: 39.5, lon: -98.25, zoom: 5 },
    timelineMode: null,
  });
  const params = new URLSearchParams(win.location.search);
  assert.equal(params.get("c"), "39.500,-98.250,5");
  assert.equal(params.get("zs"), "2");
});

test("url-state: zs=2 permalinks read their zoom as native, untouched", () => {
  const { readUrlState } = loadModule("core/url-state.ts", urlWindow("?c=39.5,-98.25,5&zs=2"));
  assert.deepEqual(readUrlState().center, { lat: 39.5, lon: -98.25, zoom: 5 });
});

test("url-state: legacy permalinks (no zs) convert leaflet-scale zoom -1 on read", () => {
  const { readUrlState } = loadModule("core/url-state.ts", urlWindow("?c=39.5,-98.25,6"));
  assert.deepEqual(readUrlState().center, { lat: 39.5, lon: -98.25, zoom: 5 });
});

test("url-state: legacy fractional zooms convert exactly", () => {
  const { readUrlState } = loadModule("core/url-state.ts", urlWindow("?c=40,-100,6.25"));
  assert.equal(readUrlState().center.zoom, 5.25);
});

test("url-state: a legacy zoom whose conversion leaves the valid range drops the viewport", () => {
  const { readUrlState } = loadModule("core/url-state.ts", urlWindow("?c=40,-100,0"));
  assert.equal(readUrlState().center, null);
});

test("url-state: legacy link -> read -> write round-trips to a zs=2 native link", () => {
  const win = urlWindow("?c=39.5,-98.25,6");
  const mod = loadModule("core/url-state.ts", win);
  const first = mod.readUrlState();
  assert.equal(first.center.zoom, 5);
  mod.writeUrlState({ view: null, hour: null, panels: null, center: first.center, timelineMode: null });
  const params = new URLSearchParams(win.location.search);
  assert.equal(params.get("c"), "39.500,-98.250,5");
  assert.equal(params.get("zs"), "2");
  // Reading the rewritten URL restores the same native viewport (idempotent).
  assert.deepEqual(mod.readUrlState().center, first.center);
});

test("url-state: dropping the center also drops the stale zs marker", () => {
  const win = urlWindow("?c=39.5,-98.25,5&zs=2&view=conus");
  const { writeUrlState } = loadModule("core/url-state.ts", win);
  writeUrlState({ view: "conus", hour: null, panels: null, center: null, timelineMode: null });
  const params = new URLSearchParams(win.location.search);
  assert.equal(params.get("c"), null);
  assert.equal(params.get("zs"), null);
});

test("url-state: analyst share state round-trips pinned runs and science display controls", () => {
  const win = urlWindow("");
  const mod = loadModule("core/url-state.ts", win);
  mod.writeUrlState({
    view: "conus",
    hour: "2026-07-11T12:00:00Z",
    panels: [{ model: "gfs", run: "20260711-0000Z", layers: ["temperature", "synoptic"] }],
    center: null,
    timelineMode: "panel",
    synoptic: { isobars: true, thickness: false, centers: true },
    synopticDetailMode: "detailed",
    reflectivityGate: 20,
    timeZone: "America/New_York",
  });
  const params = new URLSearchParams(win.location.search);
  assert.equal(params.get("p1"), "gfs@20260711-0000Z:temperature,synoptic");
  assert.equal(params.get("syn"), "ic");
  assert.equal(params.get("sd"), "d");
  assert.equal(params.get("rg"), "20");
  assert.equal(params.get("tz"), "America/New_York");

  const restored = mod.readUrlState();
  assert.deepEqual(restored.panels, [{ model: "gfs", run: "20260711-0000Z", layers: ["temperature", "synoptic"] }]);
  assert.deepEqual(restored.synoptic, { isobars: true, thickness: false, centers: true });
  assert.equal(restored.synopticDetailMode, "detailed");
  assert.equal(restored.reflectivityGate, 20);
  assert.equal(restored.timeZone, "America/New_York");
});

// ── Session storage migration ────────────────────────────────────────────────

const V1_PAYLOAD = {
  viewKey: "na",
  showIsobars: false,
  viewports: {
    conus: { lat: 39.5, lon: -98.25, zoom: 6 },
    na: { lat: 50, lon: -110, zoom: 4.5 },
  },
};

test("session: a v2 payload loads untouched (no double conversion)", () => {
  const win = {
    localStorage: fakeLocalStorage({
      "modelview.session.v2": JSON.stringify({ viewports: { conus: { lat: 39.5, lon: -98.25, zoom: 5 } } }),
    }),
  };
  const { loadStoredSessionState } = loadModule("config/session.ts", win);
  assert.deepEqual(loadStoredSessionState().viewports.conus, { lat: 39.5, lon: -98.25, zoom: 5 });
});

test("session: a legacy v1 payload converts viewport zooms -1 and keeps every other field", () => {
  const win = { localStorage: fakeLocalStorage({ "modelview.session.v1": JSON.stringify(V1_PAYLOAD) }) };
  const { loadStoredSessionState } = loadModule("config/session.ts", win);
  const state = loadStoredSessionState();
  assert.equal(state.viewKey, "na");
  assert.equal(state.showIsobars, false);
  assert.deepEqual(state.viewports.conus, { lat: 39.5, lon: -98.25, zoom: 5 });
  assert.deepEqual(state.viewports.na, { lat: 50, lon: -110, zoom: 3.5 });
});

test("session: v2 wins when both keys exist", () => {
  const win = {
    localStorage: fakeLocalStorage({
      "modelview.session.v1": JSON.stringify(V1_PAYLOAD),
      "modelview.session.v2": JSON.stringify({ viewports: { conus: { lat: 40, lon: -100, zoom: 7 } } }),
    }),
  };
  const { loadStoredSessionState } = loadModule("config/session.ts", win);
  const state = loadStoredSessionState();
  assert.deepEqual(state.viewports.conus, { lat: 40, lon: -100, zoom: 7 });
  assert.equal(state.viewports.na, undefined);
});

test("session: writes go to the v2 key only; the legacy v1 payload is left as-is", () => {
  const storage = fakeLocalStorage({ "modelview.session.v1": JSON.stringify(V1_PAYLOAD) });
  const win = { localStorage: storage };
  const mod = loadModule("config/session.ts", win);
  const migrated = mod.loadStoredSessionState();
  mod.storeSessionState(migrated);
  const dump = storage.dump();
  assert.equal(dump["modelview.session.v1"], JSON.stringify(V1_PAYLOAD));
  const stored = JSON.parse(dump["modelview.session.v2"]);
  assert.deepEqual(stored.viewports.conus, { lat: 39.5, lon: -98.25, zoom: 5 });
  // The next load reads v2 directly — the one-time conversion never re-runs.
  assert.deepEqual(mod.loadStoredSessionState().viewports.conus, { lat: 39.5, lon: -98.25, zoom: 5 });
});

test("session: a v1 viewport whose converted zoom leaves the valid range is dropped", () => {
  const win = {
    localStorage: fakeLocalStorage({
      "modelview.session.v1": JSON.stringify({ viewports: { conus: { lat: 40, lon: -100, zoom: 0 } } }),
    }),
  };
  const { loadStoredSessionState } = loadModule("config/session.ts", win);
  assert.equal(loadStoredSessionState().viewports.conus, undefined);
});
