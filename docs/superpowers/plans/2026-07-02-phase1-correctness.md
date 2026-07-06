# Phase 1 — Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the ~20 verified correctness bugs in Model View (spec Phase 1) so the app never shows wrong data, builds never hang, and silent failure modes become observable.

**Architecture:** Surgical fixes to the existing React UI (`next/src`) and Node renderer/serving stack (`scripts/`), each with its own test cycle. No new frameworks, no science changes, no restructuring. Every task was drafted against the code as of commit 211e8b7 and adversarially reviewed (quoted anchors verified byte-for-byte; failing tests reproduced live where claimed).

**Tech Stack:** React 19 + TypeScript + Vite + Tailwind 4 + Leaflet (UI); Node 22 CJS (renderer/scripts); node:test + assert (scripts tests); Playwright 1.52 (UI tests, fixture cache via `scripts/prepare-react-fixture-cache.js`).

## Global Constraints

- Exactness rule: renderer artifact output stays byte-identical, EXCEPT Section 6 Task 6.1 (snow bounds, spec P1.6) and Section 7 (NAM precip planner, spec P1.10), which are approved output-changing bug fixes verified for correctness on affected products only.
- Public-mirror rule: never delete or rename palette/scale exports, generated public palette JSONs, or scale constants — even if unreferenced in this repo.
- No science changes: formulas, thresholds, gating untouched (spec owner decision 2026-07-02).
- Point-sounding payloads/UI are computed on demand and are NOT under artifact byte parity; scientific correctness rules still apply.
- Test conventions: node:test for `scripts/**` (`node --test tests-node/<file>`), Playwright for `next/src/**` (`npx playwright test -c playwright.react.config.js tests-react/<file> --workers=1 --reporter=line`). No vitest/jest.
- Prettier (printWidth 120) must pass on every touched file: `npx prettier --check <files>`.
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Prerequisites once per machine: `npm install`, `npm run install:browsers`. The Playwright config auto-runs the fixture-cache prep and starts the dev server.
- Anchor drift: quoted "existing code" strings are exact as of commit 211e8b7. Four files are touched by multiple sections (MapPanel.tsx by 1 and 8; noaa-beta-renderer.js and grib-source.js by 6 and 10; tests-node/noaa-beta.test.js appended by 6 and 7). Execute sections in order; if an anchor no longer matches verbatim, re-locate it semantically before editing — do not skip the edit.
- Work on branch `app-completion`.

Sections group related tasks; tasks are numbered `<section>.<task>`. Complete sections in order.

---


## Section 1: Manifest lifecycle: reset on switch, surface errors with retry (spec P1.1, P1.19)

### Task 1.1: Reset per-panel manifest state on model/run/view change and surface manifest errors with retry (P1.1)

**Files:**
- Modify: `/Users/micha/Development/model-view/next/src/hooks/useManifest.ts` (full file — currently 82 lines)
- Modify: `/Users/micha/Development/model-view/next/src/components/map-panel/use-panel-chrome-data.ts` (emptyMessage chain, lines 60-66)
- Modify: `/Users/micha/Development/model-view/next/src/components/MapPanel.tsx` (manifest error card, lines 589-596)
- Create (test): `/Users/micha/Development/model-view/tests-react/manifest-lifecycle.spec.js`

**Interfaces:**
- Consumes: `fetchModelManifestWithOptions(modelKey, viewKey, { forceRefresh, runId })` from `next/src/core/artifact-client.ts` (unchanged).
- Produces: `useManifest(modelKey: ModelKey, viewKey: ViewKey, runId: string | null = null): ManifestState` where the now-exported interface is `ManifestState { loading: boolean; error: string | null; manifest: ModelManifest | null; retry: () => void }`. Task 1.2 relies on: (1) `manifestState.retry`, (2) the MapPanel error-card JSX block introduced here (Task 1.2 replaces it verbatim), (3) the test helpers `frameEntry`/`gfsLatestPointer`/`gfsManifest`/`routeGfsOk` in the new spec file.
- Behavior contract: on any `modelKey`/`viewKey`/`runId` change the hook immediately yields `{ loading: true, error: null, manifest: null }` (no stale manifest ever surfaces); every fetch failure sets `error` (manifest kept only if it belongs to the same model/run/view); `retry()` triggers an immediate force-refresh load.

Prerequisites: `npm run install:browsers` (once). The Playwright web server auto-runs `scripts/prepare-react-fixture-cache.js` (see playwright.react.config.js webServer). The tests mock all manifest routes with `page.route`, so they are deterministic even when `reuseExistingServer` picks up an already-running dev server.

This task is UI-only (`next/src/**`): no renderer/scripts code is touched, so artifact byte-parity is unaffected and no golden-frame run is needed.

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-react/manifest-lifecycle.spec.js`:

```js
const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

function frameEntry(hour, validHourKey) {
  return {
    hour,
    validHourKey,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    cols: 1600,
    rows: 980,
    layers: {
      temperature: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE },
    },
  };
}

function gfsLatestPointer() {
  return {
    model: "gfs",
    run: "20260214-0000Z",
    view: "conus",
    generatedAt: "2026-02-14T00:10:00Z",
    manifestKey: "manifests/gfs/lifecycle-gfs.json",
    frameCount: 1,
  };
}

function gfsManifest() {
  return {
    schemaVersion: 2,
    model: "gfs",
    run: "20260214-0000Z",
    view: "conus",
    generatedAt: "2026-02-14T00:10:00Z",
    referenceTime: "2026-02-14T00:00:00Z",
    openDataModel: "noaa-gfs-pgrb2-0p25",
    hourStatus: { 2: "loaded" },
    frames: [frameEntry(2, "2026-02-14T02:00:00Z")],
  };
}

function hrrrLatestPointer() {
  return {
    model: "hrrr",
    run: "20260214-0400Z",
    view: "conus",
    generatedAt: "2026-02-14T04:10:00Z",
    manifestKey: "manifests/hrrr/lifecycle-hrrr.json",
    frameCount: 1,
  };
}

function hrrrManifest() {
  return {
    schemaVersion: 2,
    model: "hrrr",
    run: "20260214-0400Z",
    view: "conus",
    generatedAt: "2026-02-14T04:10:00Z",
    referenceTime: "2026-02-14T04:00:00Z",
    openDataModel: "noaa-hrrr-wrfprs",
    hourStatus: { 2: "loaded" },
    frames: [frameEntry(2, "2026-02-14T06:00:00Z")],
  };
}

async function routeGfsOk(page) {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gfsLatestPointer()) });
  });
  await page.route("**/__cf/manifests/gfs/lifecycle-gfs.json**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gfsManifest()) });
  });
}

module.exports = { frameEntry, gfsLatestPointer, gfsManifest, routeGfsOk };

test("switching to a model with a failing manifest surfaces an error instead of stale frames", async ({ page }) => {
  await routeGfsOk(page);
  let hrrrAvailable = false;
  // Match every candidate artifact base URL (/__cf proxy and the direct data-server fallback),
  // otherwise the client falls through to http://127.0.0.1:5174 where hrrr fixtures exist.
  await page.route("**/manifests/hrrr/**", async (route) => {
    if (!hrrrAvailable) {
      await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
      return;
    }
    const url = route.request().url();
    if (url.includes("/latest.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hrrrLatestPointer()) });
      return;
    }
    if (url.includes("/runs.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hrrrManifest()) });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.locator("footer")).toContainText("Valid 2026-02-14 02z");
  await expect(panel.getByText("Ready").first()).toBeVisible();

  await panel.locator("select").first().selectOption("hrrr");

  // The old GFS manifest must not keep rendering under the HRRR label.
  await expect(panel.getByText("Manifest Error").first()).toBeVisible();
  await expect(panel.getByText("Ready")).toHaveCount(0);
  await expect(panel.locator("footer")).toContainText("Valid --");
  await expect(panel.locator("footer")).not.toContainText("2026-02-14 02z");
  await expect(panel.getByTestId("manifest-error")).toBeVisible();

  hrrrAvailable = true;
  await panel.getByRole("button", { name: "Retry" }).click();
  await expect(panel.getByText("Ready").first()).toBeVisible();
  await expect(panel.locator("footer")).toContainText("Valid 2026-02-14 06z");
  await expect(panel.getByTestId("manifest-error")).toHaveCount(0);
});

test("initial manifest failure shows an error state with retry instead of a frame message", async ({ page }) => {
  let gfsAvailable = false;
  await page.route("**/manifests/gfs/**", async (route) => {
    if (!gfsAvailable) {
      await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
      return;
    }
    const url = route.request().url();
    if (url.includes("/latest.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gfsLatestPointer()) });
      return;
    }
    if (url.includes("/runs.json")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gfsManifest()) });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.getByText("Manifest Error").first()).toBeVisible();
  await expect(panel.getByText("Manifest unavailable").first()).toBeVisible();
  await expect(panel.getByText("Ready")).toHaveCount(0);

  gfsAvailable = true;
  await panel.getByRole("button", { name: "Retry" }).click();
  await expect(panel.getByText("Ready").first()).toBeVisible();
  await expect(panel.locator("footer")).toContainText("Valid 2026-02-14 02z");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test -c playwright.react.config.js tests-react/manifest-lifecycle.spec.js --workers=1 --reporter=line
```

Expected: 2 failed (verified against current code).
- Test 1 fails at `expect(panel.getByText("Manifest Error").first()).toBeVisible()` (timeout): after switching to hrrr the badge stays "Ready" and the footer keeps "Valid 2026-02-14 02z" — the stale GFS manifest renders under the HRRR label (the bug).
- Test 2 fails at `expect(panel.getByText("Manifest unavailable").first()).toBeVisible()` (timeout): current empty-state shows "Frame unavailable for selected valid time" instead, and there is no Retry button.

- [ ] **Step 3: Write minimal implementation**

3a. Replace the entire contents of `/Users/micha/Development/model-view/next/src/hooks/useManifest.ts`. Current file (all 82 lines, abbreviated anchor — verify before overwrite):

```ts
import { useEffect, useMemo, useState } from "react";
import { fetchModelManifestWithOptions } from "../core/artifact-client";
import type { ModelKey, ModelManifest, ViewKey } from "../types";

interface ManifestState {
  loading: boolean;
  error: string | null;
  manifest: ModelManifest | null;
}
// ... (initialState, MANIFEST_POLL_MS, useManifest with a single useState that
// persists across [modelKey, runId, viewKey] changes, catch branch that keeps
// prev.manifest without setting error, manifestRevision helper)
```

New file contents:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchModelManifestWithOptions } from "../core/artifact-client";
import type { ModelKey, ModelManifest, ViewKey } from "../types";

interface ManifestData {
  loading: boolean;
  error: string | null;
  manifest: ModelManifest | null;
}

export interface ManifestState extends ManifestData {
  retry: () => void;
}

const initialData: ManifestData = {
  loading: true,
  error: null,
  manifest: null,
};

const MANIFEST_POLL_MS = 5_000;

export function useManifest(modelKey: ModelKey, viewKey: ViewKey, runId: string | null = null): ManifestState {
  const requestKey = [modelKey, viewKey, runId || "latest"].join("|");
  const [slot, setSlot] = useState<{ key: string; data: ManifestData }>({ key: requestKey, data: initialData });
  const reloadRef = useRef<(() => void) | null>(null);
  // A slot written for a previous model/run/view never surfaces, so stale
  // frames cannot render under the new selection's label.
  const data = slot.key === requestKey ? slot.data : initialData;

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const setData = (updater: (prev: ManifestData) => ManifestData) => {
      setSlot((prev) => {
        const base = prev.key === requestKey ? prev.data : initialData;
        const next = updater(base);
        if (prev.key === requestKey && next === prev.data) {
          return prev;
        }
        return { key: requestKey, data: next };
      });
    };

    const loadManifest = async (forceRefresh: boolean, showLoading: boolean) => {
      if (showLoading) {
        setData((prev) => ({ ...prev, loading: true, error: null }));
      }
      try {
        const manifest = await fetchModelManifestWithOptions(modelKey, viewKey, { forceRefresh, runId });
        if (cancelled) {
          return;
        }
        setData((prev) => {
          const prevRevision = manifestRevision(prev.manifest);
          const nextRevision = manifestRevision(manifest);
          if (prevRevision === nextRevision && prev.error === null && prev.loading === false) {
            return prev;
          }
          return { loading: false, error: null, manifest };
        });
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = String(error instanceof Error ? error.message : "Unable to load manifest.");
        setData((prev) => ({ loading: false, error: message, manifest: prev.manifest }));
      }
    };

    reloadRef.current = () => {
      void loadManifest(true, true);
    };
    void loadManifest(false, true);
    intervalId = setInterval(() => {
      void loadManifest(true, false);
    }, MANIFEST_POLL_MS);

    return () => {
      cancelled = true;
      reloadRef.current = null;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [modelKey, requestKey, runId, viewKey]);

  const retry = useCallback(() => {
    reloadRef.current?.();
  }, []);

  return useMemo(() => ({ ...data, retry }), [data, retry]);
}

function manifestRevision(manifest: ModelManifest | null): string {
  if (!manifest) {
    return "none";
  }
  const lastFrame = manifest.frames.length > 0 ? manifest.frames[manifest.frames.length - 1] : null;
  return [manifest.run, manifest.generatedAt, manifest.frames.length, lastFrame?.hour ?? -1].join("|");
}
```

Note the `setData` bailout (`next === prev.data` returns `prev`): without it every 5 s poll would produce a new state object even when `manifestRevision` dedupes, re-rendering MapPanel on every tick — the dedupe exists today precisely to avoid that.

3b. In `/Users/micha/Development/model-view/next/src/components/map-panel/use-panel-chrome-data.ts` (lines 60-66), replace:

```ts
  const emptyMessage = !hasAnyLayer
    ? "No layers selected"
    : manifestState.loading
      ? "Loading manifest..."
      : !frame
        ? "Frame unavailable for selected valid time"
        : null;
```

with:

```ts
  const emptyMessage = !hasAnyLayer
    ? "No layers selected"
    : manifestState.loading
      ? "Loading manifest..."
      : manifestState.error && !manifestState.manifest
        ? "Manifest unavailable"
        : !frame
          ? "Frame unavailable for selected valid time"
          : null;
```

(No change needed to `panelStatus` — it already reports `{ label: "Manifest Error", kind: "error" }` whenever `manifestState.error` is set and not loading; the hook change makes that state actually occur. `ManifestStateLike` stays as-is; the hook result is structurally assignable.)

3c. In `/Users/micha/Development/model-view/next/src/components/MapPanel.tsx` (lines 589-596), replace:

```tsx
        {manifestState.error ? (
          <div
            className="pointer-events-none absolute left-14 z-[520] rounded-lg bg-rose-950/80 px-3 py-1.5 text-xs text-rose-200 shadow-lg"
            style={{ top: "calc(var(--chrome-top, 96px) + 70px)" }}
          >
            {manifestState.error}
          </div>
        ) : null}
```

with:

```tsx
        {manifestState.error ? (
          <div
            data-testid="manifest-error"
            className="pointer-events-auto absolute left-14 z-[540] flex max-w-md items-start gap-2 rounded-lg bg-rose-950/80 px-3 py-1.5 text-xs text-rose-200 shadow-lg"
            style={{ top: "calc(var(--chrome-top, 96px) + 70px)" }}
          >
            <span className="min-w-0 break-words">{manifestState.error}</span>
            <button
              type="button"
              onClick={manifestState.retry}
              className="h-6 shrink-0 rounded border border-rose-300/40 bg-rose-500/15 px-2 text-[11px] font-semibold text-rose-100 hover:bg-rose-500/30 active:scale-95"
            >
              Retry
            </button>
          </div>
        ) : null}
```

IMPORTANT — the card must be `z-[540]`, not the previous `z-[520]`: the panel-chrome overlay wrapper at MapPanel.tsx:508 is `z-[530]` and its inner PanelChrome box is `pointer-events-auto`, so at `z-[520]` the chrome overlaps the card and intercepts every click on Retry (Playwright fails with "subtree intercepts pointer events" until the 5 s poll self-heals and detaches the button). `z-[540]` stays below SoundingDrawer (`z-[700]`). Verified: at `z-[520]` both tests fail on the Retry click; at `z-[540]` both pass.

- [ ] **Step 4: Run test to verify it passes**

```
npx playwright test -c playwright.react.config.js tests-react/manifest-lifecycle.spec.js --workers=1 --reporter=line
```
Expected: `2 passed` (verified, ~3 s with a warm server).

Regression + hygiene (all must be green; prettier is scoped to touched files because the repo has known pre-existing format:check failures elsewhere):

```
npx playwright test -c playwright.react.config.js --workers=1 --reporter=line
npm run typecheck
npm run lint -- --quiet
npx prettier --check next/src/hooks/useManifest.ts next/src/components/MapPanel.tsx next/src/components/map-panel/use-panel-chrome-data.ts tests-react/manifest-lifecycle.spec.js
```
Expected: full react suite passes (existing model-switch specs in manifest-compat.spec.js, smoke-react.spec.js, and latest-run-memory-cache.spec.js use auto-waiting/`expect.poll`, which tolerates the new brief loading reset; the smoke prefetch-reuse and memory-cache timing tests pass because layer images resolve from the object-URL cache and manifests from the in-memory client cache); typecheck/prettier clean; `npm run lint -- --quiet` clean (MapPanel.tsx has 4 pre-existing warnings at HEAD; the change adds none, and `--quiet` hides warnings). If a run fails with `page.goto: net::ERR_CONNECTION_TIMED_OUT`, do not run other heavy processes (tsc/eslint) concurrently with the suite and re-run the failed spec.

- [ ] **Step 5: Commit**

```
git add next/src/hooks/useManifest.ts next/src/components/MapPanel.tsx next/src/components/map-panel/use-panel-chrome-data.ts tests-react/manifest-lifecycle.spec.js
git commit -m "Reset per-panel manifest state on model/run/view change and surface manifest errors with retry" -m "Never render a prior model's frames under a new model label or show Ready on a failed manifest fetch (spec P1.1).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 1.2: Surface run-list fetch errors in the panel and drop stale run options on model switch (P1.19)

**Files:**
- Modify: `/Users/micha/Development/model-view/next/src/hooks/useModelRuns.ts` (effect body, lines 22-27)
- Modify: `/Users/micha/Development/model-view/next/src/components/MapPanel.tsx` (the error-card block introduced by Task 1.1)
- Test (modify): `/Users/micha/Development/model-view/tests-react/manifest-lifecycle.spec.js` (append one test)

**Interfaces:**
- Consumes: Task 1.1's MapPanel error-card JSX block (replaced verbatim below) and `manifestState.retry`; test helpers `routeGfsOk`/`gfsManifest` defined in the Task 1.1 spec file (Task 1.2 appends to the same file, so they are consumed in-scope).
- Produces: `data-testid="run-list-error"` element rendering `Runs unavailable: <error>` whenever `runState.error` is set; `useModelRuns` now resets to `{ loading: true, error: null, runs: [] }` on `modelKey`/`viewKey` change so a failed fetch cannot leave the previous model's run options in the run select. Run-list fetches keep auto-retrying via the existing 15 s poll (no dedicated retry button; the manifest Retry from Task 1.1 covers manual recovery of the panel).

Depends on: Task 1.1 (error card container, spec file). UI-only; no renderer/scripts changes, artifact byte-parity unaffected.

- [ ] **Step 1: Write the failing test**

Append to `/Users/micha/Development/model-view/tests-react/manifest-lifecycle.spec.js`:

```js
test("run-list failures are surfaced and stale run options are dropped on model switch", async ({ page }) => {
  await routeGfsOk(page);
  await page.route("**/__cf/manifests/gfs/runs.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [
          {
            model: "gfs",
            run: "20260214-0000Z",
            view: "conus",
            generatedAt: "2026-02-14T00:10:00Z",
            manifestKey: "manifests/gfs/lifecycle-gfs.json",
            frameCount: 1,
            loadedFrameCount: 1,
            complete: true,
            latest: true,
          },
        ],
      }),
    });
  });
  // 404 across all candidate base URLs: runs.json fails AND the manifest fallback fails,
  // which is the only path where useModelRuns reports an error.
  await page.route("**/manifests/hrrr/**", async (route) => {
    await route.fulfill({ status: 404, contentType: "text/plain", body: "missing" });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  const runSelect = panel.locator("select").nth(1);
  await expect(runSelect.locator("option", { hasText: "2026-02-14 00z" })).toHaveCount(1);

  await panel.locator("select").first().selectOption("hrrr");
  await expect(panel.getByTestId("run-list-error")).toBeVisible();
  await expect(panel.getByTestId("run-list-error")).toContainText("Runs unavailable");
  await expect(runSelect.locator("option", { hasText: "2026-02-14 00z" })).toHaveCount(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test -c playwright.react.config.js tests-react/manifest-lifecycle.spec.js --workers=1 --reporter=line
```

Expected: the two Task 1.1 tests pass; the new test fails at `expect(panel.getByTestId("run-list-error")).toBeVisible()` (timeout) — no element with that testid exists yet (`runState.error` is set by useModelRuns but never rendered) — and (if that assertion were skipped) the stale-option assertion would also fail because `runs: prev.runs` keeps the GFS run option under HRRR.

- [ ] **Step 3: Write minimal implementation**

3a. In `/Users/micha/Development/model-view/next/src/hooks/useModelRuns.ts` (lines 22-26), replace:

```ts
  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const loadRuns = async (forceRefresh: boolean, showLoading: boolean) => {
```

with:

```ts
  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    // Drop the previous model/view run list so stale run options never linger
    // under a new selection when its own fetch fails.
    setState(initialState);

    const loadRuns = async (forceRefresh: boolean, showLoading: boolean) => {
```

(On first mount this is a no-op: `state` is already the `initialState` reference, so React bails out.)

3b. In `/Users/micha/Development/model-view/next/src/components/MapPanel.tsx`, replace the Task 1.1 error-card block:

```tsx
        {manifestState.error ? (
          <div
            data-testid="manifest-error"
            className="pointer-events-auto absolute left-14 z-[540] flex max-w-md items-start gap-2 rounded-lg bg-rose-950/80 px-3 py-1.5 text-xs text-rose-200 shadow-lg"
            style={{ top: "calc(var(--chrome-top, 96px) + 70px)" }}
          >
            <span className="min-w-0 break-words">{manifestState.error}</span>
            <button
              type="button"
              onClick={manifestState.retry}
              className="h-6 shrink-0 rounded border border-rose-300/40 bg-rose-500/15 px-2 text-[11px] font-semibold text-rose-100 hover:bg-rose-500/30 active:scale-95"
            >
              Retry
            </button>
          </div>
        ) : null}
```

with:

```tsx
        {manifestState.error || runState.error ? (
          <div
            className="pointer-events-auto absolute left-14 z-[540] grid max-w-md gap-1 rounded-lg bg-rose-950/80 px-3 py-1.5 text-xs text-rose-200 shadow-lg"
            style={{ top: "calc(var(--chrome-top, 96px) + 70px)" }}
          >
            {manifestState.error ? (
              <div data-testid="manifest-error" className="flex items-start gap-2">
                <span className="min-w-0 break-words">{manifestState.error}</span>
                <button
                  type="button"
                  onClick={manifestState.retry}
                  className="h-6 shrink-0 rounded border border-rose-300/40 bg-rose-500/15 px-2 text-[11px] font-semibold text-rose-100 hover:bg-rose-500/30 active:scale-95"
                >
                  Retry
                </button>
              </div>
            ) : null}
            {runState.error ? (
              <p data-testid="run-list-error" className="m-0 min-w-0 break-words">
                Runs unavailable: {runState.error}
              </p>
            ) : null}
          </div>
        ) : null}
```

(Keep `z-[540]` — same interception constraint as Task 1.1 3c.)

- [ ] **Step 4: Run test to verify it passes**

```
npx playwright test -c playwright.react.config.js tests-react/manifest-lifecycle.spec.js --workers=1 --reporter=line
```
Expected: `3 passed` (verified, ~4 s with a warm server).

Regression + hygiene:

```
npx playwright test -c playwright.react.config.js --workers=1 --reporter=line
npm run typecheck
npm run lint -- --quiet
npx prettier --check next/src/hooks/useModelRuns.ts next/src/components/MapPanel.tsx tests-react/manifest-lifecycle.spec.js
```
Expected: all green (verified: full react suite 36/36 with both tasks applied). Note smoke-react.spec.js line 196 pins a run via the run select with a mocked runs.json; the reset only blanks options briefly before the mocked fetch resolves, and Playwright auto-waits on `selectOption`.

- [ ] **Step 5: Commit**

```
git add next/src/hooks/useModelRuns.ts next/src/components/MapPanel.tsx tests-react/manifest-lifecycle.spec.js
git commit -m "Surface run-list fetch errors in the panel and drop stale run options on model switch" -m "Run-list failures were tracked in useModelRuns but never rendered (spec P1.19).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```


## Section 2: Build manifest semantics: partial-build merge, latest-pointer completion gate (spec P1.2, P1.7)

### Task 2.1: Union-merge partial-build frames into existing run manifests (P1.2)

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/local-artifact-manifest.js` (lines 14-19, `mergeManifestWithTemplate`)
- Modify: `/Users/micha/Development/model-view/scripts/lib/local-artifact-runtime.js` (lines 156-158 `buildLatestState` targetFrames; lines 524-526 `renderFrameArtifactsForState` framePlan)
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-build/frame-queue.js` (line 57, `buildLatestStatesWithGlobalFrameQueue` targetFrames)
- Test (new): `/Users/micha/Development/model-view/tests-node/manifest-merge.test.js`

**Interfaces:**
- Consumes: `buildManifestTemplate` / `buildNoaaNamMetadata` (existing, unchanged); `mergeFrameRecord`, `normalizeHourStatus` (module-internal, unchanged).
- Produces: `mergeManifestWithTemplate(existingManifest, template)` now returns the union of frames by hour, sorted ascending by hour. Precedence: for an hour present in both, the template frame wins (fresh asset refs/layout) with existing byte counts and supplemental refs carried over via the existing `mergeFrameRecord`; hours present only in the existing manifest keep their stored frame records verbatim, including `hourStatus`. Invariant relied on by Task 2.2 and the UI: `manifest.frames` may now be a superset of the current build's target hours, and `manifest.hourStatus` has one entry per union frame. Build targeting invariant: both build paths (`LocalArtifactRuntime#buildLatestState` and `buildLatestStatesWithGlobalFrameQueue`) render only hours present in `state.framePlanByHour` (the current request's plan); union-only frames are carried, never re-rendered.

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-node/manifest-merge.test.js` (no fixture cache or browsers needed — pure node:test against a temp dir):

```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { mergeManifestWithTemplate } = require("../scripts/lib/local-artifact-manifest");
const { buildManifestTemplate } = require("../scripts/lib/modelview-runtime");
const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
const { buildLatestStatesWithGlobalFrameQueue } = require("../scripts/lib/noaa-build/frame-queue");
const { buildNoaaNamMetadata } = require("../scripts/lib/noaa-build/run-resolution");

const RUN_ID = "20260425-1200Z";
const REFERENCE_TIME = "2026-04-25T12:00:00Z";
const VALID_TIMES = ["2026-04-25T12:00:00Z", "2026-04-25T15:00:00Z", "2026-04-25T18:00:00Z"];

function buildTemplateForHours(hourCount) {
  return buildManifestTemplate({
    modelKey: "nam",
    viewKey: "conus",
    runId: RUN_ID,
    referenceTime: REFERENCE_TIME,
    validTimes: VALID_TIMES.slice(0, hourCount),
    renderWidth: 4,
    renderHeight: 3,
  });
}

function createRuntime(cacheRoot, metadata, renderFrameArtifacts = async () => null) {
  return new LocalArtifactRuntime({
    cacheRoot,
    renderWidth: 4,
    renderHeight: 3,
    fetchLatestMetadata: async () => metadata,
    renderFrameArtifacts,
  });
}

test("manifest merge keeps existing run frames when a partial-hours template arrives", () => {
  const existing = JSON.parse(JSON.stringify(buildTemplateForHours(3)));
  existing.generatedAt = "2026-04-25T13:00:00Z";
  existing.hourStatus = { 0: "loaded", 3: "loaded", 6: "loaded" };
  existing.frames[0].layers.temperature.bytes = 555;
  existing.frames[0].layers.temperature.key = "stale/moved/temperature.png";
  existing.frames[2].layers.temperature.bytes = 1234;
  existing.frames[2].hoverGridBytes = 777;

  const partialTemplate = buildTemplateForHours(2);
  const merged = mergeManifestWithTemplate(existing, partialTemplate);

  assert.deepEqual(
    merged.frames.map((frame) => frame.hour),
    [0, 3, 6],
  );
  assert.deepEqual(merged.hourStatus, { 0: "loaded", 3: "loaded", 6: "loaded" });
  // Rebuilt hours take the template frame (new refs win) with existing byte counts carried over.
  assert.equal(merged.frames[0].layers.temperature.key, partialTemplate.frames[0].layers.temperature.key);
  assert.equal(merged.frames[0].layers.temperature.bytes, 555);
  // Hours absent from the template keep their stored frame records verbatim.
  assert.deepEqual(merged.frames[2], existing.frames[2]);
  assert.equal(merged.frames[2].hoverGridBytes, 777);
  assert.equal(merged.generatedAt, existing.generatedAt);
});

test("manifest merge replaces the frame set when the run changes", () => {
  const existing = JSON.parse(JSON.stringify(buildTemplateForHours(3)));
  const otherRunTemplate = buildManifestTemplate({
    modelKey: "nam",
    viewKey: "conus",
    runId: "20260425-1800Z",
    referenceTime: "2026-04-25T18:00:00Z",
    validTimes: ["2026-04-25T18:00:00Z"],
    renderWidth: 4,
    renderHeight: 3,
  });
  assert.equal(mergeManifestWithTemplate(existing, otherRunTemplate), otherRunTemplate);
});

test("NOAA partial-hours rebuilds keep previously rendered frames in the run manifest", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-manifest-merge-"));
  const run = { date: "20260425", cycle: "12" };

  const fullRuntime = createRuntime(tempDir, buildNoaaNamMetadata({ modelKey: "nam", run, hours: [0, 3, 6] }));
  await fullRuntime.init();
  const fullSummary = await fullRuntime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });
  assert.equal(fullSummary.frameCount, 3);

  const partialRuntime = createRuntime(tempDir, buildNoaaNamMetadata({ modelKey: "nam", run, hours: [0, 3] }));
  await partialRuntime.init();
  const partialSummary = await partialRuntime.buildLatestState("nam", "conus", {
    frameRetries: 0,
    frameConcurrency: 1,
  });
  assert.equal(partialSummary.frameCount, 2);
  assert.equal(partialSummary.built, 0);
  assert.equal(partialSummary.reused, 2);

  const manifest = await partialRuntime.readManifestFromDisk("nam", RUN_ID, "conus");
  assert.deepEqual(
    manifest.frames.map((frame) => frame.hour),
    [0, 3, 6],
  );
  assert.deepEqual(Object.keys(manifest.hourStatus).sort(), ["0", "3", "6"]);
  assert.equal(manifest.hourStatus["6"], "loaded");
  assert.ok(manifest.frames[2].hoverGridBytes > 0);

  const queueRuntime = createRuntime(tempDir, buildNoaaNamMetadata({ modelKey: "nam", run, hours: [0] }));
  await queueRuntime.init();
  const [queueSummary] = await buildLatestStatesWithGlobalFrameQueue(queueRuntime, ["nam"], "conus", {
    frameConcurrency: 1,
    frameRetries: 0,
  });
  assert.equal(queueSummary.frameCount, 1);
  const queueManifest = await queueRuntime.readManifestFromDisk("nam", RUN_ID, "conus");
  assert.deepEqual(
    queueManifest.frames.map((frame) => frame.hour),
    [0, 3, 6],
  );
  assert.equal(queueManifest.hourStatus["3"], "loaded");
  assert.equal(queueManifest.hourStatus["6"], "loaded");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd /Users/micha/Development/model-view && node --test tests-node/manifest-merge.test.js
```

Expected: test 1 fails on `merged.frames.map(...)` — actual `[0, 3]` vs expected `[0, 3, 6]` (the shrink); test 3 fails the same way on the on-disk manifest (`[0, 3]` after the partial rebuild). Test 2 (run-change replacement) passes — that path is unchanged.

- [ ] **Step 3: Write minimal implementation** (three files, four edits)

Edit 1 — `/Users/micha/Development/model-view/scripts/lib/local-artifact-manifest.js`. Replace:

```js
function mergeManifestWithTemplate(existingManifest, template) {
  if (!existingManifest || existingManifest.run !== template.run || existingManifest.view !== template.view) {
    return template;
  }
  const existingByHour = new Map((existingManifest.frames || []).map((frame) => [Number(frame.hour), frame]));
  const frames = template.frames.map((frame) => mergeFrameRecord(existingByHour.get(Number(frame.hour)), frame));
```

with:

```js
function mergeManifestWithTemplate(existingManifest, template) {
  if (!existingManifest || existingManifest.run !== template.run || existingManifest.view !== template.view) {
    return template;
  }
  const existingByHour = new Map((existingManifest.frames || []).map((frame) => [Number(frame.hour), frame]));
  const templateHours = new Set(template.frames.map((frame) => Number(frame.hour)));
  // Union by hour: partial-hours rebuilds must not drop frames already rendered
  // for this run. Template frames win for rebuilt hours; hours only in the
  // existing manifest keep their stored records (bytes, supplemental refs).
  const frames = [
    ...template.frames.map((frame) => mergeFrameRecord(existingByHour.get(Number(frame.hour)), frame)),
    ...(existingManifest.frames || []).filter((frame) => frame && !templateHours.has(Number(frame.hour))),
  ].sort((left, right) => Number(left.hour) - Number(right.hour));
```

(The remainder of the function — the `existingHourStatus`/`hourStatus` loop and return — already iterates `frames` and needs no change; union hours automatically get their normalized stored status.)

Edit 2 — `/Users/micha/Development/model-view/scripts/lib/local-artifact-runtime.js`, in `buildLatestState`. Replace:

```js
    const targetFrames = state.manifest.frames.filter(
      (frame) => maxHoursPerModel === null || Number(frame.hour) <= maxHoursPerModel,
    );
```

with:

```js
    // Only frames in this build's plan are targets; union-merged frames from
    // earlier builds of the same run stay in the manifest without re-rendering.
    const targetFrames = state.manifest.frames.filter(
      (frame) =>
        state.framePlanByHour.has(Number(frame.hour)) &&
        (maxHoursPerModel === null || Number(frame.hour) <= maxHoursPerModel),
    );
```

Edit 3 — `/Users/micha/Development/model-view/scripts/lib/local-artifact-runtime.js`, in `renderFrameArtifactsForState`. Replace:

```js
  async renderFrameArtifactsForState(state, frame, options = {}) {
    this.stats.frameRenders += 1;
    const framePlan = state.framePlanByHour.get(Number(frame.hour));
```

with:

```js
  async renderFrameArtifactsForState(state, frame, options = {}) {
    this.stats.frameRenders += 1;
    // Union-merged frames can predate this build's plan; fall back to the
    // frame's own valid time so on-demand renders keep working.
    const framePlan = state.framePlanByHour.get(Number(frame.hour)) || {
      hour: Number(frame.hour),
      validTime: String(frame.validHourKey),
    };
```

(`state.frameByHour` now contains union-only hours; `ensureFrameRendered` is public runtime API, and without this fallback a render of such a frame would receive `framePlan: undefined`. The fallback fields mirror exactly how `framePlanByHour` entries are constructed in `loadLatestState`.)

Edit 4 — `/Users/micha/Development/model-view/scripts/lib/noaa-build/frame-queue.js`, in `buildLatestStatesWithGlobalFrameQueue`. Replace:

```js
    const targetFrames = state.manifest.frames.filter(Boolean);
```

with:

```js
    // Target only this build's planned hours; union-merged frames from earlier
    // builds of the same run stay in the manifest without re-rendering.
    const targetFrames = state.manifest.frames.filter(
      (frame) => frame && state.framePlanByHour.has(Number(frame.hour)),
    );
```

- [ ] **Step 4: Run test to verify it passes**

```
cd /Users/micha/Development/model-view && node --test tests-node/manifest-merge.test.js
```
Expected: `pass 3, fail 0`.

Regression + exactness verification (no render-path code touched, so no golden-frame parity run is required; this confirms manifest bytes are unchanged for full/fresh builds — the template path in `mergeManifestWithTemplate` and all frame records are untouched, and the union equals the template when hours match):

```
cd /Users/micha/Development/model-view && node --test tests-node/noaa-beta.test.js
```
Expected: all existing tests pass, including "NOAA beta runtime writes current manifest contract into separate cache root".

```
cd /Users/micha/Development/model-view && npx prettier --check scripts/lib/local-artifact-manifest.js scripts/lib/local-artifact-runtime.js scripts/lib/noaa-build/frame-queue.js tests-node/manifest-merge.test.js
```
Expected: "All matched files use Prettier code style!"

- [ ] **Step 5: Commit**

```
cd /Users/micha/Development/model-view && git add scripts/lib/local-artifact-manifest.js scripts/lib/local-artifact-runtime.js scripts/lib/noaa-build/frame-queue.js tests-node/manifest-merge.test.js && git commit -m "Merge partial-hours builds into run manifests by hour union (P1.2)" -m "Partial --hours rebuilds no longer shrink a fully rendered run's manifest: mergeManifestWithTemplate unions frames by hour (template wins for rebuilt hours, stored records kept for the rest), and both build paths target only the current plan's hours." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2.2: Advance latest--<view>.json only when the new run is usably complete (P1.7)

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/local-artifact-runtime.js` (lines 919-925 `writeManifestState`; add `shouldAdvanceLatestPointer` method after it; add module-level `isManifestUsablyComplete` after `applyLatestMetadataToManifest` (~line 1008); add export)
- Test (new): `/Users/micha/Development/model-view/tests-node/latest-pointer.test.js`

**Interfaces:**
- Consumes: `readJsonIfExists` (already imported in local-artifact-runtime.js), `manifest.hourStatus` per-union-frame invariant from Task 2.1.
- Produces: `isManifestUsablyComplete(manifest) -> boolean` (new named export of `scripts/lib/local-artifact-runtime.js`); `LocalArtifactRuntime#shouldAdvanceLatestPointer(modelKey, viewKey, runId, manifest) -> Promise<boolean>`.
- **Definition of "usably complete" (state this in the plan/PR):** verified from what the code can know — every frame listed in the run manifest has `hourStatus === "loaded"`, which is set only after a frame's `.complete.json` marker + all artifact files exist (written at frame persist during builds; re-derived from markers by `applyManifestArtifactCompleteness` on every load). Pointer rules: (1) bootstrap — if no `latest--<view>.json` exists, write it immediately (first build stays visible while in progress; current behavior for empty caches); (2) same-run refresh — if the pointer already names `runId`, always rewrite it (keeps `generatedAt`/`frameCount` live for progressive builds of the current latest run); (3) cross-run advance — only when the new run's manifest is usably complete. Run manifests themselves are still written unconditionally at build start and per-frame (`persistManifestEachFrame`), so in-progress runs remain listed in `runs.json` and manually selectable with progressive frame display — unchanged.

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-node/latest-pointer.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { LocalArtifactRuntime, isManifestUsablyComplete } = require("../scripts/lib/local-artifact-runtime");
const { buildNoaaNamMetadata } = require("../scripts/lib/noaa-build/run-resolution");

function createRuntime(cacheRoot, metadata, renderFrameArtifacts = async () => null) {
  return new LocalArtifactRuntime({
    cacheRoot,
    renderWidth: 4,
    renderHeight: 3,
    fetchLatestMetadata: async () => metadata,
    renderFrameArtifacts,
  });
}

test("manifest usable completeness requires every frame loaded", () => {
  assert.equal(isManifestUsablyComplete(null), false);
  assert.equal(isManifestUsablyComplete({ frames: [], hourStatus: {} }), false);
  assert.equal(
    isManifestUsablyComplete({ frames: [{ hour: 0 }, { hour: 3 }], hourStatus: { 0: "loaded", 3: "loaded" } }),
    true,
  );
  assert.equal(
    isManifestUsablyComplete({ frames: [{ hour: 0 }, { hour: 3 }], hourStatus: { 0: "loaded", 3: "pending" } }),
    false,
  );
  assert.equal(
    isManifestUsablyComplete({ frames: [{ hour: 0 }, { hour: 3 }], hourStatus: { 0: "loaded", 3: "error" } }),
    false,
  );
});

test("NOAA latest pointer advances only when the new run is usably complete", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-latest-pointer-"));

  // Bootstrap: with no pointer on disk the first build is visible immediately.
  const morningRuntime = createRuntime(
    tempDir,
    buildNoaaNamMetadata({ modelKey: "nam", run: { date: "20260425", cycle: "06" }, hours: [0, 3] }),
  );
  await morningRuntime.init();
  await morningRuntime.ensureLatestState("nam", "conus", { forceRefresh: true });
  let pointer = await morningRuntime.readLatestPointerFromDisk("nam", "conus");
  assert.equal(pointer.run, "20260425-0600Z");
  await morningRuntime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });

  // A new run's build start writes its manifest but must not steal the pointer.
  const noonRuntime = createRuntime(
    tempDir,
    buildNoaaNamMetadata({ modelKey: "nam", run: { date: "20260425", cycle: "12" }, hours: [0, 3] }),
  );
  await noonRuntime.init();
  await noonRuntime.ensureLatestState("nam", "conus", { forceRefresh: true });
  pointer = await noonRuntime.readLatestPointerFromDisk("nam", "conus");
  assert.equal(pointer.run, "20260425-0600Z");

  // The in-progress run stays selectable: manifest on disk and listed in runs.json.
  const inProgress = await noonRuntime.readManifestFromDisk("nam", "20260425-1200Z", "conus");
  assert.deepEqual(
    inProgress.frames.map((frame) => frame.hour),
    [0, 3],
  );
  const runs = await noonRuntime.listRunManifests("nam", "conus");
  assert.deepEqual(
    runs.map((entry) => entry.run),
    ["20260425-1200Z", "20260425-0600Z"],
  );
  assert.equal(runs.find((entry) => entry.run === "20260425-1200Z").latest, false);
  assert.equal(runs.find((entry) => entry.run === "20260425-0600Z").latest, true);

  // Completing the new run advances the pointer.
  await noonRuntime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });
  pointer = await noonRuntime.readLatestPointerFromDisk("nam", "conus");
  assert.equal(pointer.run, "20260425-1200Z");
});

test("NOAA latest pointer stays on the previous run when a new run build fails", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-latest-pointer-fail-"));
  const morningRuntime = createRuntime(
    tempDir,
    buildNoaaNamMetadata({ modelKey: "nam", run: { date: "20260425", cycle: "06" }, hours: [0, 3] }),
  );
  await morningRuntime.init();
  await morningRuntime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });

  const failingRuntime = createRuntime(
    tempDir,
    buildNoaaNamMetadata({ modelKey: "nam", run: { date: "20260425", cycle: "12" }, hours: [0, 3] }),
    async () => {
      throw new Error("render unavailable");
    },
  );
  await failingRuntime.init();
  const summary = await failingRuntime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });
  assert.equal(summary.failed, 2);
  const pointer = await failingRuntime.readLatestPointerFromDisk("nam", "conus");
  assert.equal(pointer.run, "20260425-0600Z");
  const failedManifest = await failingRuntime.readManifestFromDisk("nam", "20260425-1200Z", "conus");
  assert.equal(failedManifest.hourStatus["0"], "error");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd /Users/micha/Development/model-view && node --test tests-node/latest-pointer.test.js
```

Expected: test 1 errors with `TypeError: isManifestUsablyComplete is not a function` (not yet exported); test 2 fails at the second pointer assertion — actual `"20260425-1200Z"` vs expected `"20260425-0600Z"` (pointer flips at build start today); test 3 fails the same way after the failed build.

- [ ] **Step 3: Write minimal implementation**

Edit 1 — `/Users/micha/Development/model-view/scripts/lib/local-artifact-runtime.js`. Replace:

```js
  async writeManifestState(modelKey, viewKey, runId, manifest, latestPointer) {
    const manifestPath = this.getManifestStoragePath(modelKey, runId, viewKey);
    const latestPointerPath = this.getLatestPointerStoragePath(modelKey, viewKey);
    await writeJsonAtomic(manifestPath, manifest);
    await writeJsonAtomic(latestPointerPath, latestPointer);
    this.stats.manifestWrites += 2;
  }
```

with:

```js
  async writeManifestState(modelKey, viewKey, runId, manifest, latestPointer) {
    const manifestPath = this.getManifestStoragePath(modelKey, runId, viewKey);
    const latestPointerPath = this.getLatestPointerStoragePath(modelKey, viewKey);
    await writeJsonAtomic(manifestPath, manifest);
    this.stats.manifestWrites += 1;
    if (!(await this.shouldAdvanceLatestPointer(modelKey, viewKey, runId, manifest))) {
      return;
    }
    await writeJsonAtomic(latestPointerPath, latestPointer);
    this.stats.manifestWrites += 1;
  }

  // latest--<view>.json advances to a different run only once that run is
  // usably complete. A missing pointer is bootstrapped immediately, and the
  // run the pointer already names keeps refreshing so progressive builds of
  // the current latest run stay live. In-progress runs remain selectable
  // through their run manifests and listRunManifests regardless.
  async shouldAdvanceLatestPointer(modelKey, viewKey, runId, manifest) {
    const existingPointer = await readJsonIfExists(this.getLatestPointerStoragePath(modelKey, viewKey));
    if (!existingPointer || String(existingPointer.run || "") === String(runId || "")) {
      return true;
    }
    return isManifestUsablyComplete(manifest);
  }
```

Edit 2 — same file, insert after the closing brace of `applyLatestMetadataToManifest` (immediately before `function byteLengthOfArtifactBody(body) {`):

```js
// A run is usably complete when every frame in its manifest is marker-verified
// as loaded: builds set hourStatus per persisted frame, and loadLatestState
// re-derives it from .complete.json markers plus on-disk artifacts.
function isManifestUsablyComplete(manifest) {
  const frames = Array.isArray(manifest?.frames) ? manifest.frames : [];
  if (frames.length === 0) {
    return false;
  }
  const hourStatus = manifest?.hourStatus && typeof manifest.hourStatus === "object" ? manifest.hourStatus : {};
  return frames.every((frame) => hourStatus[String(frame.hour)] === "loaded");
}
```

Edit 3 — same file, in `module.exports`. Replace:

```js
module.exports = {
  LocalArtifactRuntime,
  applyRenderedFrameToManifestFrame,
  buildEmptyHoverGridArtifact,
  buildEmptySynopticVectorPayload,
  createTransparentPng,
  normalizeRenderedFrameArtifacts,
};
```

with:

```js
module.exports = {
  LocalArtifactRuntime,
  applyRenderedFrameToManifestFrame,
  buildEmptyHoverGridArtifact,
  buildEmptySynopticVectorPayload,
  createTransparentPng,
  isManifestUsablyComplete,
  normalizeRenderedFrameArtifacts,
};
```

- [ ] **Step 4: Run test to verify it passes**

```
cd /Users/micha/Development/model-view && node --test tests-node/latest-pointer.test.js
```
Expected: `pass 3, fail 0`.

Regression (must stay green — in particular "NOAA beta runtime writes current manifest contract into separate cache root", which exercises the bootstrap + complete-build pointer path on a fresh cache) and the Task 2.1 suite (its partial rebuilds are same-run refreshes, so the pointer still updates):

```
cd /Users/micha/Development/model-view && node --test tests-node/noaa-beta.test.js && node --test tests-node/manifest-merge.test.js
```
Expected: all pass.

```
cd /Users/micha/Development/model-view && npx prettier --check scripts/lib/local-artifact-runtime.js tests-node/latest-pointer.test.js
```
Expected: "All matched files use Prettier code style!"

No renderer output is touched (pointer/manifest bookkeeping only), so no golden-frame parity run is required; `latest--<view>.json` content for the unchanged scenarios (bootstrap, same-run refresh, completed build) is byte-identical to before apart from the already-varying `generatedAt`.

- [ ] **Step 5: Commit**

```
cd /Users/micha/Development/model-view && git add scripts/lib/local-artifact-runtime.js tests-node/latest-pointer.test.js && git commit -m "Advance latest pointer only when the new run is usably complete (P1.7)" -m "latest--<view>.json no longer flips to a new run at build start: it bootstraps when missing, keeps refreshing for the run it already names, and otherwise advances only once every manifest frame is marker-verified loaded. Run manifests still persist unconditionally so in-progress runs stay selectable with progressive frames." -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```


## Section 3: FrameWorkerPool: respawn crashed workers (spec P1.3)

### Task 3.1: FrameWorkerPool — reject in-flight jobs on worker death, respawn with a bounded budget, fail loudly when exhausted (P1.3)

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/local-artifact-concurrency.js` (FrameWorkerPool class, lines 58–172: constructor, `createWorkerState`, `run`, `pump`, `handleWorkerError`, `getStats`)
- Modify: `/Users/micha/Development/model-view/package.json` (line 31, `test:local-runtime` script)
- Test: `/Users/micha/Development/model-view/tests-node/frame-worker-pool.test.js` (new file)

**Interfaces:**
- Consumes: `clampInt(value, min, max, fallback)` from `./local-artifact-options`; `Worker` from `worker_threads`; the frame-worker message protocol from `/Users/micha/Development/model-view/scripts/noaa-beta-frame-worker.js` (`{type:"render-frame", id, payload}` in → `{id, ok:true, frameArtifacts}` or `{id, ok:false, error}` out).
- Produces: `FrameWorkerPool` constructor gains optional `maxRespawns` (integer, clamped 0–64, **default 3 respawns per pool lifetime**). `run(payload)` rejects with `Frame worker died mid-job (job <id>): <cause>` when the assigned worker dies, and — once the budget is spent — the pool sets a sticky failure so queued and all subsequent `run()` calls reject with `Frame worker pool respawn budget exhausted (<maxRespawns> respawns); last worker error: <cause>` (also written to stderr via `console.error`). `getStats()` gains a `respawnsUsed` field and `idle` now counts live workers (`this.workers.length - busy`; identical to the old value while all workers are alive). No exported names change; `module.exports` is untouched. The sole existing caller (`scripts/build-noaa-beta-artifacts.js:210`) needs no change — omitted `maxRespawns` takes the default of 3.
- Behavior changes (all spec-approved by P1.3, none touching renderer output): a worker death no longer drains the queue while a respawn is available (queued frames continue on the respawned worker); a worker exit with code 0 before `close()` is now treated as a death (previously silently ignored, stranding the in-flight job); no job is ever posted to a dead worker (dead states are removed from the pool and `pump()` skips `dead` states).

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-node/frame-worker-pool.test.js` with exactly this content (pure node:test — no fixture cache or browsers needed):

```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { FrameWorkerPool } = require("../scripts/lib/local-artifact-concurrency");

const STUB_WORKER_SOURCE = `"use strict";
const { parentPort } = require("worker_threads");
parentPort.on("message", (message) => {
  if (!message || message.type !== "render-frame") {
    return;
  }
  const payload = message.payload || {};
  if (payload.mode === "die") {
    process.exit(payload.exitCode ?? 7);
  }
  if (payload.mode === "throw") {
    throw new Error("stub-worker-boom");
  }
  parentPort.postMessage({
    id: message.id,
    ok: true,
    frameArtifacts: { echo: payload.echo ?? null },
  });
});
`;

let stubDir;
let stubWorkerPath;

test.before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "frame-worker-pool-test-"));
  stubWorkerPath = path.join(stubDir, "stub-frame-worker.js");
  fs.writeFileSync(stubWorkerPath, STUB_WORKER_SOURCE);
});

test.after(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
});

test("worker death rejects the in-flight job and respawns for the next job", { timeout: 30000 }, async () => {
  const pool = new FrameWorkerPool({
    workerPath: stubWorkerPath,
    size: 1,
    maxRespawns: 3,
  });
  try {
    await assert.rejects(pool.run({ mode: "die" }), /Frame worker died mid-job \(job 1\): Worker exited with code 7/);
    const result = await pool.run({ echo: "after-respawn" });
    assert.equal(result.echo, "after-respawn");
    assert.equal(pool.getStats().respawnsUsed, 1);
  } finally {
    await pool.close();
  }
});

test("queued jobs survive a worker death when a respawn is available", { timeout: 30000 }, async () => {
  const pool = new FrameWorkerPool({
    workerPath: stubWorkerPath,
    size: 1,
    maxRespawns: 3,
  });
  try {
    const dying = pool.run({ mode: "die" });
    const queued = pool.run({ echo: "survives" });
    await assert.rejects(dying, /Frame worker died mid-job/);
    const result = await queued;
    assert.equal(result.echo, "survives");
  } finally {
    await pool.close();
  }
});

test("respawn budget exhaustion rejects queued and subsequent jobs loudly", { timeout: 30000 }, async () => {
  const pool = new FrameWorkerPool({
    workerPath: stubWorkerPath,
    size: 1,
    maxRespawns: 0,
  });
  try {
    const dying = pool.run({ mode: "die" });
    const queued = pool.run({ echo: "queued" });
    await assert.rejects(dying, /Frame worker died mid-job/);
    await assert.rejects(queued, /respawn budget exhausted \(0 respawns\)/);
    await assert.rejects(pool.run({ echo: "later" }), /respawn budget exhausted/);
    assert.equal(pool.getStats().queued, 0);
  } finally {
    await pool.close();
  }
});

test(
  "uncaught worker error rejects the job without double-spending the budget on exit",
  { timeout: 30000 },
  async () => {
    const pool = new FrameWorkerPool({
      workerPath: stubWorkerPath,
      size: 1,
      maxRespawns: 1,
    });
    try {
      await assert.rejects(pool.run({ mode: "throw" }), /Frame worker died mid-job \(job 1\): stub-worker-boom/);
      const result = await pool.run({ echo: "ok" });
      assert.equal(result.echo, "ok");
      assert.equal(pool.getStats().respawnsUsed, 1);
    } finally {
      await pool.close();
    }
  },
);

test("pool survives deaths within the budget and fails on the death after it", { timeout: 30000 }, async () => {
  const pool = new FrameWorkerPool({
    workerPath: stubWorkerPath,
    size: 1,
    maxRespawns: 2,
  });
  try {
    await assert.rejects(pool.run({ mode: "die" }), /Frame worker died mid-job/);
    await assert.rejects(pool.run({ mode: "die" }), /Frame worker died mid-job/);
    const ok = await pool.run({ echo: "still-alive" });
    assert.equal(ok.echo, "still-alive");
    await assert.rejects(pool.run({ mode: "die" }), /Frame worker died mid-job/);
    await assert.rejects(pool.run({ echo: "too-late" }), /respawn budget exhausted \(2 respawns\)/);
  } finally {
    await pool.close();
  }
});
```

Why this test shape: the stub worker speaks the exact `render-frame` protocol of `scripts/noaa-beta-frame-worker.js` but self-terminates on demand (`process.exit`) or dies via uncaught throw, letting the suite prove all three required behaviors — in-flight job rejection with a descriptive error, bounded respawn with a subsequent job succeeding on the fresh worker, and loud sticky failure once the budget is exhausted. The `"throw"` case additionally proves the `error`-then-`exit` double-fire on the same Worker does not double-spend the budget. The success path exercises `reviveFrameArtifacts` end to end (`result.echo` survives the round trip). Each test carries `{ timeout: 30000 }` so a regression back to the never-settling-job hang fails instead of wedging the runner.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/micha/Development/model-view && node --test tests-node/frame-worker-pool.test.js
```

Expected: all five tests fail fast (~100–200 ms total, no hang — each first assertion mismatches before any job can be posted to a dead worker), ending with:

```
# tests 5
# pass 0
# fail 5
```

The first failure shows the current behavior: `assert.rejects` receives `error: 'Worker exited with code 7'` (raised from the existing `exit` handler at `local-artifact-concurrency.js:85`) instead of a message matching `/Frame worker died mid-job \(job 1\)/`, and no respawn ever happens.

- [ ] **Step 3: Write minimal implementation**

All edits are in `/Users/micha/Development/model-view/scripts/lib/local-artifact-concurrency.js`, plus one line in `package.json`. Replacement code below is already clean under the repo prettier config (printWidth 120).

**Edit 3a — constructor, `createWorkerState`, `run` (lines 58–104).** Replace:

```js
class FrameWorkerPool {
  constructor({ workerPath, size }) {
    this.workerPath = workerPath;
    this.size = clampInt(size, 1, 48, 2);
    this.queue = [];
    this.workers = [];
    this.nextJobId = 1;
    this.isClosed = false;
    for (let i = 0; i < this.size; i += 1) {
      this.workers.push(this.createWorkerState());
    }
  }

  createWorkerState() {
    const worker = new Worker(this.workerPath);
    const state = {
      worker,
      busy: false,
      activeJob: null,
    };
    worker.on("message", (message) => this.handleMessage(state, message));
    worker.on("error", (error) => this.handleWorkerError(state, error));
    worker.on("exit", (code) => {
      if (this.isClosed) {
        return;
      }
      if (code !== 0) {
        this.handleWorkerError(state, new Error(`Worker exited with code ${code}`));
      }
    });
    return state;
  }

  run(payload) {
    if (this.isClosed) {
      return Promise.reject(new Error("Worker pool is closed."));
    }
    return new Promise((resolve, reject) => {
```

with:

```js
class FrameWorkerPool {
  constructor({ workerPath, size, maxRespawns }) {
    this.workerPath = workerPath;
    this.size = clampInt(size, 1, 48, 2);
    this.maxRespawns = clampInt(maxRespawns, 0, 64, 3);
    this.respawnsUsed = 0;
    this.failure = null;
    this.queue = [];
    this.workers = [];
    this.nextJobId = 1;
    this.isClosed = false;
    for (let i = 0; i < this.size; i += 1) {
      this.workers.push(this.createWorkerState());
    }
  }

  createWorkerState() {
    const worker = new Worker(this.workerPath);
    const state = {
      worker,
      busy: false,
      activeJob: null,
      dead: false,
    };
    worker.on("message", (message) => this.handleMessage(state, message));
    worker.on("error", (error) => this.handleWorkerDeath(state, error));
    worker.on("exit", (code) => {
      // Any exit before close() is unexpected; even code 0 strands the in-flight job.
      this.handleWorkerDeath(state, new Error(`Worker exited with code ${code}`));
    });
    return state;
  }

  run(payload) {
    if (this.isClosed) {
      return Promise.reject(new Error("Worker pool is closed."));
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
```

(The body of the returned Promise — `this.queue.push({...}); this.pump();` — is unchanged.)

**Edit 3b — `pump()` guards (lines 106–113).** Replace:

```js
  pump() {
    if (this.isClosed) {
      return;
    }
    for (const state of this.workers) {
      if (state.busy) {
        continue;
      }
```

with:

```js
  pump() {
    if (this.isClosed || this.failure) {
      return;
    }
    for (const state of this.workers) {
      if (state.busy || state.dead) {
        continue;
      }
```

(The rest of `pump()` and all of `handleMessage()` are unchanged.)

**Edit 3c — `handleWorkerError` → `handleWorkerDeath` and `getStats` (lines 150–172).** Replace:

```js
  handleWorkerError(state, error) {
    const err = error instanceof Error ? error : new Error(String(error || "worker-error"));
    if (state.activeJob) {
      state.activeJob.reject(err);
      state.activeJob = null;
    }
    state.busy = false;
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      queued.reject(err);
    }
  }

  getStats() {
    const busy = this.workers.filter((state) => state.busy).length;
    return {
      size: this.size,
      busy,
      idle: Math.max(0, this.size - busy),
      queued: this.queue.length,
      closed: this.isClosed,
    };
  }
```

with:

```js
  handleWorkerDeath(state, error) {
    if (state.dead || this.isClosed) {
      return;
    }
    state.dead = true;
    const err = error instanceof Error ? error : new Error(String(error || "worker-error"));
    const index = this.workers.indexOf(state);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
    state.worker.terminate().catch(() => undefined);
    if (state.activeJob) {
      const job = state.activeJob;
      state.activeJob = null;
      state.busy = false;
      job.reject(new Error(`Frame worker died mid-job (job ${job.id}): ${err.message}`));
    }
    if (this.respawnsUsed < this.maxRespawns) {
      this.respawnsUsed += 1;
      console.warn(
        `[frame-worker-pool] worker died (${err.message}); respawning (${this.respawnsUsed}/${this.maxRespawns})`,
      );
      this.workers.push(this.createWorkerState());
      this.pump();
      return;
    }
    this.failure = new Error(
      `Frame worker pool respawn budget exhausted (${this.maxRespawns} respawns); last worker error: ${err.message}`,
    );
    console.error(`[frame-worker-pool] ${this.failure.message}`);
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      queued.reject(this.failure);
    }
  }

  getStats() {
    const busy = this.workers.filter((state) => state.busy).length;
    return {
      size: this.size,
      busy,
      idle: Math.max(0, this.workers.length - busy),
      queued: this.queue.length,
      closed: this.isClosed,
      respawnsUsed: this.respawnsUsed,
    };
  }
```

Non-obvious points, in order: the `state.dead || this.isClosed` guard is load-bearing — Node fires `error` and then `exit` on the same Worker for an uncaught throw, and `close()` terminates workers whose `exit` events must not trigger respawns after shutdown. The dead state is spliced out of `this.workers` before anything else so no code path (including the `pump()` inside the respawn branch) can ever post to it. `terminate()` is a harmless no-op on an already-exited worker but ensures cleanup on the `error`-before-`exit` path. `close()` needs no change: it sets `isClosed` before terminating, so the resulting `exit` events return at the guard.

**Edit 3d — include the new suite in the runtime test script.** In `/Users/micha/Development/model-view/package.json` line 31, replace:

```json
    "test:local-runtime": "node --test tests-node/noaa-beta.test.js",
```

with:

```json
    "test:local-runtime": "node --test tests-node/noaa-beta.test.js tests-node/frame-worker-pool.test.js",
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/micha/Development/model-view && node --test tests-node/frame-worker-pool.test.js
```

Expected: `# tests 5` / `# pass 5` / `# fail 0` (stderr will show the intentional `[frame-worker-pool] worker died ... respawning` and `respawn budget exhausted` lines — that is the "loud" logging under test, not a failure). Then regression-check the existing suite and hygiene gates:

```bash
cd /Users/micha/Development/model-view && npm run test:local-runtime
cd /Users/micha/Development/model-view && npx prettier --check scripts/lib/local-artifact-concurrency.js tests-node/frame-worker-pool.test.js package.json
cd /Users/micha/Development/model-view && npx eslint scripts/lib/local-artifact-concurrency.js tests-node/frame-worker-pool.test.js
```

Expected: existing `noaa-beta.test.js` cases all pass (it imports `LocalArtifactRuntime`, which pulls in this module), prettier reports "All matched files use Prettier code style!", eslint reports no errors. Exactness rule note: this task never touches the render path — worker-pool orchestration only, and on a healthy build (no worker deaths) job scheduling is identical — so no golden-frame parity run is required; do not run one against changed products because there are none.

- [ ] **Step 5: Commit**

```bash
cd /Users/micha/Development/model-view && git add scripts/lib/local-artifact-concurrency.js tests-node/frame-worker-pool.test.js package.json && git commit -m "$(cat <<'EOF'
Respawn dead frame workers with a bounded budget (P1.3)

A worker death used to leave the dead worker in the pool with
busy=false; pump() would postMessage into the terminated worker (a
silent no-op) and the job never settled, hanging the build. Now a
death rejects the in-flight job with a descriptive error, removes the
worker, respawns up to 3 times per pool lifetime, keeps queued jobs
alive across respawns, and fails the pool loudly (sticky rejection +
stderr) once the budget is exhausted. Exit code 0 before close() is
treated as a death too, since it equally strands the in-flight job.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```


## Section 4: Artifact server: path containment (spec P1.4)

### Task 4.1: Reject path-traversal asset requests that escape the artifact root

**Files:**
- Modify `/Users/micha/Development/model-view/scripts/lib/local-artifact-server.js` (asset handler block at lines 174-180; add helper after the `pathExists` function at lines 247-254)
- Create `/Users/micha/Development/model-view/tests-node/local-artifact-server.test.js`

**Interfaces:**
- Consumes: `createLocalArtifactServer(options)` (unchanged export from `scripts/lib/local-artifact-server.js`); `runtime.artifactRoot`, `runtime.artifactPrefix`, `runtime.getArtifactStoragePath(key)`, `runtime.init()` (unchanged from `local-artifact-runtime.js`).
- Produces: no new public exports. Behavior change is confined to the `/{artifactPrefix}/...` asset route: requests whose resolved filesystem path falls outside `runtime.artifactRoot` now return `404 Not Found`. All in-root asset responses (status, headers, bytes) are byte-identical to before — the renderer/artifact output is untouched (no palette/scale/JSON edits; this is a server request-routing guard only).

Prerequisites: none beyond a working Node install. This is a pure Node HTTP test (`node:test` + `node:http`); it does NOT require the Playwright fixture cache or `npm run install:browsers`.

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-node/local-artifact-server.test.js` with exactly:

```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createLocalArtifactServer } = require("../scripts/lib/local-artifact-server");

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function withServer(run) {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-artifact-server-"));
  const { runtime, server } = createLocalArtifactServer({ cacheRoot });
  await runtime.init();
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run({ runtime, cacheRoot, port: server.address().port });
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.promises.rm(cacheRoot, { recursive: true, force: true });
  }
}

test("asset requests inside the artifact root are still served", async () => {
  await withServer(async ({ runtime, port }) => {
    const key = `${runtime.artifactPrefix}/gfs/20260313-0000Z/conus/000/2t.png`;
    const filePath = runtime.getArtifactStoragePath(key);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const response = await rawGet(port, `/${key}`);
    assert.equal(response.status, 200, "a legit in-root asset must still be served");
  });
});

test("encoded ../ traversal cannot escape the artifact root", async () => {
  await withServer(async ({ runtime, cacheRoot, port }) => {
    // Sentinel file placed OUTSIDE the artifact root (in its parent directory).
    const sentinelPath = path.join(cacheRoot, "secret.txt");
    await fs.promises.writeFile(sentinelPath, "TOP-SECRET");

    // A valid-looking asset path so the hour segment (parts[4]) parses as finite,
    // with the traversal encoded as "..%2F" so the URL parser does not normalize it away.
    const assetKey = `${runtime.artifactPrefix}/gfs/20260313-0000Z/conus/000/2t.png`;
    const assetDir = path.dirname(runtime.getArtifactStoragePath(assetKey));
    const relativeToSentinel = path.relative(assetDir, sentinelPath);
    const encodedTraversal = relativeToSentinel.split(path.sep).map(encodeURIComponent).join("%2F");
    const traversalPath = `/${runtime.artifactPrefix}/gfs/20260313-0000Z/conus/000/${encodedTraversal}`;

    const response = await rawGet(port, traversalPath);
    assert.equal(response.status, 404, "traversal outside the artifact root must be rejected with 404");
    assert.notEqual(response.body, "TOP-SECRET", "the sentinel file must never be served");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Command:
```
node --test tests-node/local-artifact-server.test.js
```
Expected failure (traversal test): the in-root test passes, but "encoded ../ traversal cannot escape the artifact root" FAILS because the server currently serves the out-of-root file. The assertion `assert.equal(response.status, 404, ...)` reports `AssertionError [ERR_ASSERTION]: traversal outside the artifact root must be rejected with 404` with `actual: 200 / expected: 404` (the response body is `TOP-SECRET`). Overall run reports `# fail 1`.

- [ ] **Step 3: Write minimal implementation**

In `/Users/micha/Development/model-view/scripts/lib/local-artifact-server.js`, add a containment guard in `handleAssetRequest`. Replace this existing block (lines 174-180):

```js
  const relativeKey = requestPath.replace(/^\/+/, "");
  const filePath = runtime.getArtifactStoragePath(relativeKey);
  if (!(await pathExists(filePath))) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
```

with:

```js
  const relativeKey = requestPath.replace(/^\/+/, "");
  const filePath = runtime.getArtifactStoragePath(relativeKey);
  // Reject decoded "../" traversal (e.g. "..%2F") that would escape the artifact root.
  if (!isPathWithinRoot(filePath, runtime.artifactRoot)) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  if (!(await pathExists(filePath))) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
```

Then add the helper immediately after the existing `pathExists` function (which ends at line 254, just before `module.exports`):

```js
async function pathExists(filePath) {
  try {
    await fs.promises.access(path.resolve(filePath));
    return true;
  } catch {
    return false;
  }
}

function isPathWithinRoot(filePath, rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(filePath);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
}

module.exports = {
  createLocalArtifactServer,
};
```

(The `path.sep` suffix guard prevents a sibling directory such as `<root>-evil` from being treated as inside `<root>`. `path` and `fs` are already required at the top of the file — no new imports.)

- [ ] **Step 4: Run test to verify it passes**

Command:
```
node --test tests-node/local-artifact-server.test.js
```
Expected: both tests pass — `# pass 2`, `# fail 0`. The traversal request now returns `404` and never emits the sentinel body; the legit in-root asset still returns `200`.

Regression guard (confirm existing behavior unchanged):
```
node --test tests-node/noaa-beta.test.js
```
Expected: still green (`# fail 0`) — this change touches only the asset request-routing guard, not any renderer/formula/manifest path.

- [ ] **Step 5: Commit**

```
git add scripts/lib/local-artifact-server.js tests-node/local-artifact-server.test.js && git commit -m "$(printf 'Reject path-traversal asset requests outside the artifact root\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```
(If `npm run format:check` is part of the phase gate, run `npx prettier --write scripts/lib/local-artifact-server.js tests-node/local-artifact-server.test.js` before `git add`; the code above already follows the repo's double-quote / 2-space / semicolon style.)


## Section 5: Artifact client: refcounted abort for deduped fetches (spec P1.5)

### Task 5.1: Refcounted shared abortable requests in artifact-client (P1.5)

**Files:**
- Create: `/Users/micha/Development/model-view/next/src/core/shared-abortable-request.ts`
- Create: `/Users/micha/Development/model-view/tests-react/abort-race.spec.js`
- Modify: `/Users/micha/Development/model-view/next/src/core/artifact-client.ts` — import block (line 38), in-flight map declarations (lines 86, 88, 90, 92, 94), fetchSynopticVectorPayload (lines 229-249), fetchContourVectorPayload (lines 272-292), fetchWeatherVectorPayload (lines 308-328), fetchHoverGridPayload (lines 352-366), fetchSingleHoverGridPayload (lines 381-403), fetchPointSoundingPayload (lines 461-485)
- Do NOT modify: `next/src/core/frame-prefetch.ts`, `next/src/components/map-panel/use-synoptic-vector.ts`, `use-hover-grid.ts`, `use-contour-vector.ts`, `next/src/core/latest-run-memory-cache.ts` — their existing catch-blocks become correct once rejections are per-consumer.

**Interfaces:**
- Produces (new module `next/src/core/shared-abortable-request.ts`):
  - `type SharedRequestMap<T> = Map<string, SharedRequestEntry<T>>`
  - `createSharedRequestMap<T>(): SharedRequestMap<T>`
  - `runSharedRequest<T>(inFlight: SharedRequestMap<T>, key: string, signal: AbortSignal | undefined, start: (sharedSignal: AbortSignal) => Promise<T>): Promise<T>`
- Consumes/preserves (public API of `artifact-client.ts` — signatures MUST NOT change, so hooks and FramePrefetchEngine stay untouched):
  - `fetchSynopticVectorPayload(frame, options?: PrefetchOptions): Promise<SynopticVectorPayload | null>`
  - `fetchContourVectorPayload(frame, layer, options?): Promise<ContourVectorPayload | null>`
  - `fetchWeatherVectorPayload(frame, layer, options?): Promise<WeatherVectorPayload | null>`
  - `fetchHoverGridPayload(frame, options?): Promise<HoverGridPayload | null>`
  - `fetchPointSoundingPayload({ modelKey, runId, viewKey, hour, lat, lon, signal }): Promise<PointSoundingPayload>`
  - plus the `prefetch*` wrappers (unchanged pass-throughs).
- Semantics contract other tasks rely on (e.g., P1.11 frame-status): each caller gets a promise that rejects with `DOMException("Aborted", "AbortError")` only when ITS signal aborts; the underlying fetch aborts only when every registered consumer has aborted; signal-less consumers (memory warmup) pin the fetch for its lifetime; late joiners attach to the in-flight fetch without a new network request.

**Testing strategy (explicit):** There is no TS unit runner in this repo and none may be added, so the extracted pure helper is verified through (a) module-level Playwright tests that dynamically import the real `/src/core/artifact-client.ts` off the Vite dev server and drive consumer ordering/aborts deterministically via `page.route` gates, and (b) `npm run typecheck`. The user-visible dual-panel regression is Task 5.2. Prerequisites: `npm run install:browsers` once; the Playwright webServer auto-runs `scripts/prepare-react-fixture-cache.js`.

- [ ] **Step 1: Write the failing test** — create `/Users/micha/Development/model-view/tests-react/abort-race.spec.js`:

```js
const { test, expect } = require("@playwright/test");

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
  await page.route("**/fixtures/abort-race/module/hover-grid.json**", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
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

  await page.evaluate(async () => {
    window.__abortRace.second.abort();
    await window.__abortRace.secondPromise;
  });
  expect(await page.evaluate(() => window.__abortRace.secondOutcome)).toBe("AbortError");

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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/micha/Development/model-view
npm run install:browsers   # once, if chromium is not installed
npx playwright test -c playwright.react.config.js tests-react/abort-race.spec.js --workers=1 --reporter=line
```

Expected failure (both tests): `expect(received).toBe(expected) — Expected: null, Received: "AbortError"` at the `secondOutcome` assertion after the first consumer aborts — proving the first caller's signal is bound into the deduped fetch and its abort rejects the joiner.

- [ ] **Step 3: Write minimal implementation**

3a. Create `/Users/micha/Development/model-view/next/src/core/shared-abortable-request.ts`:

```ts
interface SharedRequestEntry<T> {
  controller: AbortController;
  consumers: number;
  promise: Promise<T>;
}

export type SharedRequestMap<T> = Map<string, SharedRequestEntry<T>>;

export function createSharedRequestMap<T>(): SharedRequestMap<T> {
  return new Map<string, SharedRequestEntry<T>>();
}

/**
 * Dedupes concurrent requests by key without binding any single caller's
 * AbortSignal to the underlying fetch. Each caller gets its own promise that
 * rejects when ITS signal aborts; the underlying request is aborted only once
 * every registered consumer has aborted. Consumers without a signal pin the
 * request for its full lifetime. Late joiners attach to the in-flight request.
 */
export function runSharedRequest<T>(
  inFlight: SharedRequestMap<T>,
  key: string,
  signal: AbortSignal | undefined,
  start: (sharedSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  let entry = inFlight.get(key);
  if (!entry) {
    const controller = new AbortController();
    // start() runs before the map entry exists, so a synchronous re-entrant
    // call on the same key (single-URL hover grids nest the per-URL fetch
    // inside the merged fetch) creates its own entry that the set() below
    // replaces; the controller identity checks keep cleanup scoped per entry.
    const promise = start(controller.signal).finally(() => {
      const current = inFlight.get(key);
      if (current && current.controller === controller) {
        inFlight.delete(key);
      }
    });
    // Rejections are delivered through per-consumer promises; keep a handler
    // on the shared promise so fully-detached requests stay silent.
    void promise.catch(() => undefined);
    entry = { controller, consumers: 0, promise };
    inFlight.set(key, entry);
  }
  const attached = entry;
  attached.consumers += 1;
  if (!signal) {
    return attached.promise;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      attached.consumers -= 1;
      if (attached.consumers <= 0) {
        if (inFlight.get(key) === attached) {
          inFlight.delete(key);
        }
        attached.controller.abort();
      }
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    attached.promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}
```

3b. In `/Users/micha/Development/model-view/next/src/core/artifact-client.ts`, apply six edits.

Edit 1 — add the import (line 38). Replace:
```ts
import { buildValidTimeAxis, formatRunLabel, normalizeManifest, resolveFrameByValidTime } from "./manifest-utils";
```
with:
```ts
import { buildValidTimeAxis, formatRunLabel, normalizeManifest, resolveFrameByValidTime } from "./manifest-utils";
import { createSharedRequestMap, runSharedRequest } from "./shared-abortable-request";
```

Edit 2 — refcounted in-flight maps (lines 83-94). Replace:
```ts
const manifestCache = new Map<string, CacheEntry>();
const runListCache = new Map<string, RunListCacheEntry>();
const synopticVectorPayloadCache = new Map<string, SynopticVectorPayload>();
const synopticVectorPayloadInFlight = new Map<string, Promise<SynopticVectorPayload>>();
const contourVectorPayloadCache = new Map<string, ContourVectorPayload>();
const contourVectorPayloadInFlight = new Map<string, Promise<ContourVectorPayload>>();
const weatherVectorPayloadCache = new Map<string, WeatherVectorPayload>();
const weatherVectorPayloadInFlight = new Map<string, Promise<WeatherVectorPayload>>();
const hoverGridPayloadCache = new Map<string, HoverGridPayload>();
const hoverGridPayloadInFlight = new Map<string, Promise<HoverGridPayload>>();
const pointSoundingPayloadCache = new Map<string, PointSoundingPayload>();
const pointSoundingPayloadInFlight = new Map<string, Promise<PointSoundingPayload>>();
```
with:
```ts
const manifestCache = new Map<string, CacheEntry>();
const runListCache = new Map<string, RunListCacheEntry>();
const synopticVectorPayloadCache = new Map<string, SynopticVectorPayload>();
const synopticVectorPayloadInFlight = createSharedRequestMap<SynopticVectorPayload>();
const contourVectorPayloadCache = new Map<string, ContourVectorPayload>();
const contourVectorPayloadInFlight = createSharedRequestMap<ContourVectorPayload>();
const weatherVectorPayloadCache = new Map<string, WeatherVectorPayload>();
const weatherVectorPayloadInFlight = createSharedRequestMap<WeatherVectorPayload>();
const hoverGridPayloadCache = new Map<string, HoverGridPayload>();
const hoverGridPayloadInFlight = createSharedRequestMap<HoverGridPayload>();
const pointSoundingPayloadCache = new Map<string, PointSoundingPayload>();
const pointSoundingPayloadInFlight = createSharedRequestMap<PointSoundingPayload>();
```

Edit 3 — `fetchSynopticVectorPayload` (lines 229-249). Replace:
```ts
  const inFlight = synopticVectorPayloadInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }
  const request = fetch(url, {
    cache: "force-cache",
    signal: options.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Synoptic vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as SynopticVectorPayload;
      cacheParsedPayload(synopticVectorPayloadCache, key, payload);
      return payload;
    })
    .finally(() => {
      synopticVectorPayloadInFlight.delete(key);
    });
  synopticVectorPayloadInFlight.set(key, request);
  return request;
```
with:
```ts
  return runSharedRequest(synopticVectorPayloadInFlight, key, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Synoptic vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as SynopticVectorPayload;
      cacheParsedPayload(synopticVectorPayloadCache, key, payload);
      return payload;
    }),
  );
```

Edit 4 — `fetchContourVectorPayload` (lines 272-292). Replace:
```ts
  const inFlight = contourVectorPayloadInFlight.get(url);
  if (inFlight) {
    return inFlight;
  }
  const request = fetch(url, {
    cache: "force-cache",
    signal: options.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Contour vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as ContourVectorPayload;
      cacheParsedPayload(contourVectorPayloadCache, url, payload);
      return payload;
    })
    .finally(() => {
      contourVectorPayloadInFlight.delete(url);
    });
  contourVectorPayloadInFlight.set(url, request);
  return request;
```
with:
```ts
  return runSharedRequest(contourVectorPayloadInFlight, url, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Contour vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as ContourVectorPayload;
      cacheParsedPayload(contourVectorPayloadCache, url, payload);
      return payload;
    }),
  );
```

Edit 5 — `fetchWeatherVectorPayload` (lines 308-328). Replace:
```ts
  const inFlight = weatherVectorPayloadInFlight.get(url);
  if (inFlight) {
    return inFlight;
  }
  const request = fetch(url, {
    cache: "force-cache",
    signal: options.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Weather vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as WeatherVectorPayload;
      cacheParsedPayload(weatherVectorPayloadCache, url, payload);
      return payload;
    })
    .finally(() => {
      weatherVectorPayloadInFlight.delete(url);
    });
  weatherVectorPayloadInFlight.set(url, request);
  return request;
```
with:
```ts
  return runSharedRequest(weatherVectorPayloadInFlight, url, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Weather vector request failed (${response.status}) for ${url}`);
      }
      const payload = (await response.json()) as WeatherVectorPayload;
      cacheParsedPayload(weatherVectorPayloadCache, url, payload);
      return payload;
    }),
  );
```

Edit 6 — `fetchHoverGridPayload` (lines 352-366). Replace:
```ts
  const inFlight = hoverGridPayloadInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }
  const request = Promise.all(urls.map((url) => fetchSingleHoverGridPayload(url, options)))
    .then((payloads) => {
      const mergedPayload = mergeHoverGridPayloadObjects(payloads);
      cacheParsedPayload(hoverGridPayloadCache, key, mergedPayload);
      return mergedPayload;
    })
    .finally(() => {
      hoverGridPayloadInFlight.delete(key);
    });
  hoverGridPayloadInFlight.set(key, request);
  return request;
```
with:
```ts
  // The merged fetch is itself one consumer of each per-URL fetch, so a
  // caller abort propagates inward only when every merged consumer is gone.
  return runSharedRequest(hoverGridPayloadInFlight, key, options.signal, (sharedSignal) =>
    Promise.all(urls.map((url) => fetchSingleHoverGridPayload(url, { ...options, signal: sharedSignal }))).then(
      (payloads) => {
        const mergedPayload = mergeHoverGridPayloadObjects(payloads);
        cacheParsedPayload(hoverGridPayloadCache, key, mergedPayload);
        return mergedPayload;
      },
    ),
  );
```

Edit 7 — `fetchSingleHoverGridPayload` (lines 381-403). Replace:
```ts
  const inFlight = hoverGridPayloadInFlight.get(url);
  if (inFlight) {
    return inFlight;
  }
  const request = fetch(url, {
    cache: "force-cache",
    signal: options.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Hover grid request failed (${response.status}) for ${url}`);
      }
      const parsedPayload = /\.bin\.gz(?:$|[?#])/.test(url)
        ? normalizeBinaryHoverGridPayload(await response.arrayBuffer())
        : normalizeHoverGridPayload((await response.json()) as HoverGridPayload);
      cacheParsedPayload(hoverGridPayloadCache, url, parsedPayload);
      return parsedPayload;
    })
    .finally(() => {
      hoverGridPayloadInFlight.delete(url);
    });
  hoverGridPayloadInFlight.set(url, request);
  return request;
```
with:
```ts
  return runSharedRequest(hoverGridPayloadInFlight, url, options.signal, (sharedSignal) =>
    fetch(url, { cache: "force-cache", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Hover grid request failed (${response.status}) for ${url}`);
      }
      const parsedPayload = /\.bin\.gz(?:$|[?#])/.test(url)
        ? normalizeBinaryHoverGridPayload(await response.arrayBuffer())
        : normalizeHoverGridPayload((await response.json()) as HoverGridPayload);
      cacheParsedPayload(hoverGridPayloadCache, url, parsedPayload);
      return parsedPayload;
    }),
  );
```

Edit 8 — `fetchPointSoundingPayload` (lines 461-485). Replace:
```ts
  const inFlight = pointSoundingPayloadInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  const request = fetch(url, { cache: "no-store", signal })
    .then(async (response) => {
      if (!response.ok) {
        let reason: string;
        try {
          const payload = (await response.json()) as { error?: string };
          reason = payload.error ? `: ${payload.error}` : "";
        } catch {
          reason = "";
        }
        throw new Error(`Point sounding request failed (${response.status})${reason}`);
      }
      const payload = (await response.json()) as PointSoundingPayload;
      cacheParsedPayload(pointSoundingPayloadCache, cacheKey, payload);
      return payload;
    })
    .finally(() => {
      pointSoundingPayloadInFlight.delete(cacheKey);
    });
  pointSoundingPayloadInFlight.set(cacheKey, request);
  return request;
```
with:
```ts
  return runSharedRequest(pointSoundingPayloadInFlight, cacheKey, signal, (sharedSignal) =>
    fetch(url, { cache: "no-store", signal: sharedSignal }).then(async (response) => {
      if (!response.ok) {
        let reason: string;
        try {
          const payload = (await response.json()) as { error?: string };
          reason = payload.error ? `: ${payload.error}` : "";
        } catch {
          reason = "";
        }
        throw new Error(`Point sounding request failed (${response.status})${reason}`);
      }
      const payload = (await response.json()) as PointSoundingPayload;
      cacheParsedPayload(pointSoundingPayloadCache, cacheKey, payload);
      return payload;
    }),
  );
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/micha/Development/model-view
npx playwright test -c playwright.react.config.js tests-react/abort-race.spec.js --workers=1 --reporter=line
# expected: 2 passed
npm run typecheck
# expected: exit 0
npx eslint next/src/core/shared-abortable-request.ts next/src/core/artifact-client.ts tests-react/abort-race.spec.js
# expected: no errors
npx prettier --check next/src/core/shared-abortable-request.ts next/src/core/artifact-client.ts tests-react/abort-race.spec.js
# expected: all files formatted (run `npx prettier --write` on the same paths first if not)
npx playwright test -c playwright.react.config.js --workers=1 --reporter=line
# expected: full react suite green (no regression from the artifact-client refactor)
```

Byte-parity note: this change is browser-runtime only (`next/src/**`); no `scripts/**` renderer code is touched, so artifact output is byte-identical by construction — no golden-frame run required.

- [ ] **Step 5: Commit**

```bash
cd /Users/micha/Development/model-view
git add next/src/core/shared-abortable-request.ts next/src/core/artifact-client.ts tests-react/abort-race.spec.js
git commit -m "Fix shared-AbortSignal race in deduped artifact fetches with refcounted consumers

Deduped in-flight payload fetches bound the first caller's AbortSignal, so a
prefetch stop or panel unmount rejected the shared promise for every consumer
and other panels wrongly cleared their synoptic vectors / hover grids. Each
consumer now gets its own promise that rejects only on its own signal; the
underlying fetch aborts once all consumers have aborted; signal-less warmup
consumers pin the fetch. Public artifact-client signatures unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5.2: Dual-panel UI regression — removing a panel must not clear the sibling's hover grid (P1.5 / P4.3 abort-race spec)

**Files:**
- Modify: `/Users/micha/Development/model-view/tests-react/abort-race.spec.js` — append UI helpers and one test at end of file (after the last test from Task 5.1)

**Interfaces:**
- Consumes: fixed per-consumer abort semantics from Task 5.1; app UI controls — "Add Map" button (`AppHeader.tsx:82`), per-panel "Remove" button (`PanelChrome.tsx:191`), Model select with `aria-label="Model"` (`PanelChrome.tsx:129`), "Ready" status badge text, hover readout value format `50.0 °F` (temperature legend unit `°F`, one decimal per `hoverDigitsForUnit`). NOTE: the hover readout samples via `sampleHoverVariableAtPoint` (`next/src/components/map-panel/hover-utils.ts:116`), which returns null for any grid with `rows < 2 || cols < 2` — so the UI panel must be served a 2x2 hover grid (constant values keep the bilinear interpolation exact at any cursor position); the 1x1 payload from Task 5.1 is module-test-only.
- Produces: regression coverage for spec P1.5's acceptance criterion "prefetch stop must not clear another panel's synoptic vector/hover grid" (hover-grid path; the synoptic-vector path is covered at module level in Task 5.1 since synoptic is not an active layer by default).

- [ ] **Step 1: Write the failing test** — append to `/Users/micha/Development/model-view/tests-react/abort-race.spec.js`:

```js
const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";
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
    validHourKey: `2026-04-23T${String(12 + hour / 3).padStart(2, "0")}:00:00Z`,
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

  await page.goto("/");
  const firstPanel = page.locator("article").first();
  await expect(firstPanel.getByText("Ready")).toBeVisible();
  await expect.poll(() => countBySuffix(hoverRequestCounts, "/gfs/000/hover-grid.json")).toBe(1);

  await page.getByRole("button", { name: "Add Map" }).click();
  await expect(page.locator("article")).toHaveCount(2);
  const secondPanel = page.locator("article").nth(1);
  await secondPanel.getByLabel("Model").selectOption("gfs");
  await expect(secondPanel.getByText("Ready")).toBeVisible();

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
});
```

- [ ] **Step 2: Run test to verify it fails** — Task 5.1 already landed the fix, so prove the test detects the bug by temporarily restoring the pre-fix `artifact-client.ts` (the helper file may remain; it is unused by the old code):

```bash
cd /Users/micha/Development/model-view
FIX_COMMIT=$(git log -n 1 --format=%H -- next/src/core/shared-abortable-request.ts)
git show "${FIX_COMMIT}~1:next/src/core/artifact-client.ts" > next/src/core/artifact-client.ts
npx playwright test -c playwright.react.config.js tests-react/abort-race.spec.js --workers=1 --reporter=line --grep "removing one panel"
# expected: 1 failed — timeout waiting for getByText("50.0 °F"); the remaining panel's
# hover readout shows "--" because the removed panel's abort rejected the shared fetch
git restore next/src/core/artifact-client.ts
```

- [ ] **Step 3: Write minimal implementation** — none required; this task is regression coverage for the Task 5.1 fix. Confirm the working tree is clean apart from the spec file: `git status --short` should list only `tests-react/abort-race.spec.js`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/micha/Development/model-view
npx playwright test -c playwright.react.config.js tests-react/abort-race.spec.js --workers=1 --reporter=line
# expected: 3 passed (2 module tests from Task 5.1 + this UI regression)
npx eslint tests-react/abort-race.spec.js
npx prettier --check tests-react/abort-race.spec.js
# expected: clean (run `npx prettier --write tests-react/abort-race.spec.js` first if needed)
```

- [ ] **Step 5: Commit**

```bash
cd /Users/micha/Development/model-view
git add tests-react/abort-race.spec.js
git commit -m "Add dual-panel abort-race regression: sibling panel keeps its hover grid

Gates the shared gfs hover-grid response, joins a second panel onto the
in-flight fetch, removes the first panel, then asserts the surviving panel
still renders hover values once the response lands.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```


## Section 6: Renderer: snow bounds fix, observable fallbacks, latest-cycle cache TTL (spec P1.6, P1.9, P1.13)

### Task 6.1: Pass `bounds` through the snow renderMode lazy snowfall fallback (P1.6 — approved output change)

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta/winter.js` (lines 139-152: `buildSnowRenderedArtifacts` signature + `buildSnowfallInGrids` call)
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta-renderer.js` (lines 613-624: call site; line 1891 area: `_test` export)
- Test: `/Users/micha/Development/model-view/tests-node/noaa-beta.test.js`

**Interfaces:**
- Consumes: `buildSnowfallInGrids({ decoded, selection, bounds, modelKey, width, height })` (winter.js:3800, already bounds-aware — do NOT touch it), `view.bounds` in `noaa-beta-renderer.js` (already used at lines 598/629).
- Produces: `buildSnowRenderedArtifacts({ decoded, selection, framePlan, bounds, modelKey, width, height, pngCompressionLevel, pngFilterType, hoverGridFormat, profile })` — new `bounds` option; new export `_testBuildSnowRenderedArtifacts` from `scripts/lib/noaa-beta-renderer.js` (test-only alias, follows existing `_test:` convention).
- Note: rendered layer values are `{ body, bytes, contentType }` objects (raster.js `encodeRawPng`), not raw Buffers — the test asserts on `.body`.

- [ ] **Step 1: Write the failing test**

  In `/Users/micha/Development/model-view/scripts/lib/noaa-beta-renderer.js`, add the test alias (this is test plumbing only, no behavior change). Find the exact line in `module.exports`:
  ```js
  _testBuildSnowfallInGrids: buildSnowfallInGrids,
  ```
  and replace with:
  ```js
  _testBuildSnowfallInGrids: buildSnowfallInGrids,
  _testBuildSnowRenderedArtifacts: buildSnowRenderedArtifacts,
  ```

  In `/Users/micha/Development/model-view/tests-node/noaa-beta.test.js`, extend the renderer import destructure. Find the exact line (currently line 112):
  ```js
  _testBuildSnowfallInGrids,
  ```
  and replace with:
  ```js
  _testBuildSnowfallInGrids,
  _testBuildSnowRenderedArtifacts,
  ```

  Append this test at the end of `/Users/micha/Development/model-view/tests-node/noaa-beta.test.js` (`fs`, `os`, `path`, `SNOW_PROFILE_LEVELS` are already imported at the top of the file):
  ```js
  test("NOAA snow renderMode passes bounds into the lazy snowfall fallback", () => {
    const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "noaa-snow-linear-model-"));
    const modelPath = path.join(modelDir, "western-linear-test.json");
    fs.writeFileSync(
      modelPath,
      JSON.stringify({
        featureKeys: ["T04K", "T24K", "SPD04K", "SPD24K"],
        coefficients: [0, 0, 0, 0],
        intercept: 10,
      }),
    );
    const originalModelPath = process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH;
    process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH = modelPath;
    try {
      const decoded = {
        snowLiquidTotal: new Float32Array([12.7]),
        profileSurfaceHeight: new Float32Array([1500]),
        temperature2m: new Float32Array([265.15]),
        windU10m: new Float32Array([5]),
        windV10m: new Float32Array([0]),
      };
      for (const level of SNOW_PROFILE_LEVELS) {
        const height = 1500 + (1000 - level) * 18;
        decoded[`profileHgt${level}`] = new Float32Array([height]);
        decoded[`profileTmp${level}`] = new Float32Array([265.15 - Math.max(0, height - 1500) * 0.006]);
        decoded[`profileU${level}`] = new Float32Array([8]);
        decoded[`profileV${level}`] = new Float32Array([6]);
      }
      const selection = { availableParameters: ["snowWesternLinear"], records: {} };
      const bounds = { west: -110, east: -109, south: 40, north: 41 };

      // Control: buildSnowfallInGrids itself is already bounds-aware.
      const snowfallIn = _testBuildSnowfallInGrids({ decoded, selection, bounds, modelKey: "nam", width: 1, height: 1 });
      assert.ok(Math.abs(snowfallIn.snowWesternLinear[0] - 5) < 1e-5);

      // Regression: the snow renderMode artifact builder must forward bounds.
      const rendered = _testBuildSnowRenderedArtifacts({
        decoded,
        selection,
        framePlan: { hour: 6, validTime: "2026-04-25T18:00:00.000Z" },
        bounds,
        modelKey: "nam",
        width: 1,
        height: 1,
      });
      assert.ok(
        Buffer.isBuffer(rendered.layers.snowWesternLinear?.body),
        "snowWesternLinear layer should render on the lazy fallback path",
      );
    } finally {
      if (originalModelPath === undefined) {
        delete process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH;
      } else {
        process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH = originalModelPath;
      }
      fs.rmSync(modelDir, { recursive: true, force: true });
    }
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  ```bash
  cd /Users/micha/Development/model-view && node --test --test-name-pattern "lazy snowfall fallback" tests-node/noaa-beta.test.js
  ```
  Expected: 1 failing test. The control assertion passes; the failure is `AssertionError [ERR_ASSERTION]: snowWesternLinear layer should render on the lazy fallback path` (pre-fix, `buildSnowRenderedArtifacts` ignores the `bounds` option, `latLonForGridIndex` yields NaN, the Western-linear grid is all-NaN, the `snowWesternLinear` key is absent from `rendered.layers`, so `rendered.layers.snowWesternLinear?.body` is `undefined`).

- [ ] **Step 3: Write minimal implementation**

  In `/Users/micha/Development/model-view/scripts/lib/noaa-beta/winter.js`, replace:
  ```js
  function buildSnowRenderedArtifacts({
    decoded,
    selection,
    framePlan,
    modelKey,
  ```
  with:
  ```js
  function buildSnowRenderedArtifacts({
    decoded,
    selection,
    framePlan,
    bounds,
    modelKey,
  ```
  and replace (line 152):
  ```js
  const snowfallIn = buildSnowfallInGrids({ decoded, selection, modelKey, width, height });
  ```
  with:
  ```js
  const snowfallIn = buildSnowfallInGrids({ decoded, selection, bounds, modelKey, width, height });
  ```

  In `/Users/micha/Development/model-view/scripts/lib/noaa-beta-renderer.js`, replace (lines 613-617):
  ```js
          ? buildSnowRenderedArtifacts({
              decoded,
              selection,
              framePlan,
              modelKey: resolvedModelKey,
  ```
  with:
  ```js
          ? buildSnowRenderedArtifacts({
              decoded,
              selection,
              framePlan,
              bounds: view.bounds,
              modelKey: resolvedModelKey,
  ```
  Do not modify `buildSnowfallInGrids` (winter.js:3800) or the base-path call at noaa-beta-renderer.js:681 — both are already correct.

- [ ] **Step 4: Run test to verify it passes**
  ```bash
  cd /Users/micha/Development/model-view && node --test --test-name-pattern "lazy snowfall fallback" tests-node/noaa-beta.test.js && npm run test:local-runtime && npx prettier --check scripts/lib/noaa-beta/winter.js scripts/lib/noaa-beta-renderer.js tests-node/noaa-beta.test.js
  ```
  Expected: new test passes, full node suite green, prettier clean.

- [ ] **Step 5: Verify output-change scope (exactness rule, P1.6-approved)**
  This is one of the two spec-approved output-changing fixes; only snow-renderMode products may change, and only on frames where the lazy fallback actually ran. Run the golden-frame protocol (requires an existing local raw cache; may fetch from NOAA if cold). IMPORTANT: a parallel workstream may hold unrelated uncommitted changes in this repo — stash ONLY this task's files, never a bare `git stash`:
  ```bash
  cd /Users/micha/Development/model-view
  git stash push -- scripts/lib/noaa-beta/winter.js scripts/lib/noaa-beta-renderer.js tests-node/noaa-beta.test.js   # baseline = pre-fix versions of this task's files only
  npm run noaa:build:test -- --frames=2
  cp -R output/noaa-beta-cache/artifacts "/private/tmp/claude-501/-Users-micha-Development-model-view/78037a7e-c26e-4910-851d-cea9461c9826/scratchpad/golden-p16"
  git stash pop
  npm run noaa:build:test -- --frames=2
  diff -r --exclude=".complete.json" "/private/tmp/claude-501/-Users-micha-Development-model-view/78037a7e-c26e-4910-851d-cea9461c9826/scratchpad/golden-p16" output/noaa-beta-cache/artifacts
  ```
  Expected: byte-identical (the standard build pre-populates interval snowfall grids via `SNOWFALL_DERIVED_INTERVALS_READY_KEY`, so the fallback normally does not run). If any files differ, every differing path must belong to snow-mode products (snowRfConus / snowWesternLinear tiles or the snow frame's hover grid) — anything else is a regression; stop and investigate (and check whether third-party uncommitted changes to renderer files landed between the two builds). Record the outcome in the PR/commit body.

- [ ] **Step 6: Commit**
  ```bash
  cd /Users/micha/Development/model-view && git add scripts/lib/noaa-beta/winter.js scripts/lib/noaa-beta-renderer.js tests-node/noaa-beta.test.js && git commit -m "Pass bounds through snow renderMode lazy snowfall fallback (P1.6)

  buildSnowRenderedArtifacts dropped bounds, so latLonForGridIndex returned
  NaN and the RF/Western SLR grids went all-NaN whenever the lazy fallback
  ran in snow renderMode. Approved output change confined to snow products.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 6.2: Surface silent renderer fallbacks with warn logs + profile counters (P1.9 — no behavior change)

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta/grib-source.js` (bulk-decode fallback catch ≈line 897; `writeRegriddedBinCache` ≈1199-1216; its call site ≈1373-1379; `finalizeNoaaRenderProfile` allowlist ≈1861-1862 — line numbers drift while a parallel workstream edits this file; the quoted strings below are the authoritative anchors and were verified unique)
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta/selection.js` (lines 688-695 and 709-716: model-loader catch blocks)
- Modify: `/Users/micha/Development/model-view/scripts/build-noaa-beta-artifacts.js` (line 616 area: `formatRenderProfile`)
- Test: `/Users/micha/Development/model-view/tests-node/noaa-beta.test.js`

**Interfaces:**
- Consumes: `incrementProfileCounter(profile, key)` (already imported in grib-source.js line 9), `appendPositiveCounter(parts, label, value)` (build-noaa-beta-artifacts.js:703), log convention `console.warn("[noaa-beta] ...")` (build-noaa-beta-artifacts.js:506-512).
- Produces: profile counters `bulkDecodeFallbacks` and `regridBinCacheWriteFailures` (finalized in `finalizeNoaaRenderProfile`, emitted by `formatRenderProfile` under `--profile`); `writeRegriddedBinCache(cacheContext, { binSourcePath, inventoryText, binBytes, profile })` gains an optional `profile` in its options object. Counters land only in per-frame `.complete.json` markers (excluded from parity) and `--profile` log lines; artifact bytes are untouched.
- CAUTION: grib-source.js contains a literal NUL byte (memo-key separator inside `resolveRegriddedBinCacheContext`, ≈line 1130) — plain `grep` treats the file as binary; use `rg -a` or `grep -a`. Do not modify that line.

- [ ] **Step 1: Write the failing tests**

  Append after the last line of `/Users/micha/Development/model-view/tests-node/noaa-beta.test.js` (note `_testLoadSnowRfModel` and `_testLoadWesternLinearSlrModel` are already imported at the top; the new `require` line goes right after the existing line `const PLANNED_COLOR_MAPS = require("../shared/noaa-beta-planned-color-maps.json");`):

  New require (insert after the `PLANNED_COLOR_MAPS` line):
  ```js
  const { decodeSelectedRecordsToGrids, writeRegriddedBinCache } = require("../scripts/lib/noaa-beta/grib-source");
  ```

  New tests (append at end of file):
  ```js
  test("NOAA bulk decode fallback surfaces a warning and profile counter", async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "noaa-bulk-fallback-"));
    const profile = { stages: {} };
    const warns = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      const decoded = await decodeSelectedRecordsToGrids({
        gribPath: path.join(tempDir, "missing-selected.grib2"),
        selectedPlan: null,
        selection: { catalog: [], records: {} },
        hour: 3,
        tempDir,
        wgrib2Path: path.join(tempDir, "missing-wgrib2"),
        bounds: { west: -110, east: -100, south: 35, north: 45 },
        width: 4,
        height: 4,
        profile,
      });
      assert.deepEqual(decoded, {});
      assert.equal(profile.bulkDecodeFallbacks, 1);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /\[noaa-beta\] bulk decode failed/);
    } finally {
      console.warn = originalWarn;
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("NOAA regridded-bin cache write failure surfaces a warning and profile counter", async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "noaa-regrid-write-"));
    const missingDir = path.join(tempDir, "missing");
    const profile = {};
    const warns = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      await writeRegriddedBinCache(
        {
          payload: { kind: "regridded-bin-v1" },
          payloadHash: "0".repeat(64),
          binPath: path.join(missingDir, "cache.bin"),
          metadataPath: path.join(missingDir, "cache.json"),
        },
        {
          binSourcePath: path.join(missingDir, "missing-source.bin"),
          inventoryText: "1:0:TMP",
          binBytes: 16,
          profile,
        },
      );
      assert.equal(profile.regridBinCacheWriteFailures, 1);
      assert.equal(warns.length, 1);
      assert.match(warns[0], /\[noaa-beta\] regridded-bin cache write failed/);
    } finally {
      console.warn = originalWarn;
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("NOAA snow SLR model load failure surfaces a warning once per path", () => {
    const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "noaa-snow-model-warn-"));
    const badRfPath = path.join(modelDir, "bad-conus-rf.json");
    const badLinearPath = path.join(modelDir, "bad-western-linear.json");
    fs.writeFileSync(badRfPath, "{not json");
    fs.writeFileSync(badLinearPath, JSON.stringify({ featureKeys: ["WRONG"], coefficients: [1], intercept: 0 }));
    const originalRfPath = process.env.MODELVIEW_SNOW_RF_CONUS_PATH;
    const originalLinearPath = process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH;
    const originalWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      process.env.MODELVIEW_SNOW_RF_CONUS_PATH = badRfPath;
      process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH = badLinearPath;
      assert.equal(_testLoadSnowRfModel("conus"), null);
      assert.equal(_testLoadWesternLinearSlrModel(), null);
      assert.equal(warns.length, 2);
      assert.match(warns[0], /snowRfConus model unavailable/);
      assert.match(warns[1], /snowWesternLinear model unavailable/);
      // Path-cached reloads stay silent: the warning fires once per artifact path.
      assert.equal(_testLoadSnowRfModel("conus"), null);
      assert.equal(warns.length, 2);
    } finally {
      console.warn = originalWarn;
      if (originalRfPath === undefined) {
        delete process.env.MODELVIEW_SNOW_RF_CONUS_PATH;
      } else {
        process.env.MODELVIEW_SNOW_RF_CONUS_PATH = originalRfPath;
      }
      if (originalLinearPath === undefined) {
        delete process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH;
      } else {
        process.env.MODELVIEW_SNOW_WESTERN_LINEAR_PATH = originalLinearPath;
      }
      fs.rmSync(modelDir, { recursive: true, force: true });
    }
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**
  ```bash
  cd /Users/micha/Development/model-view && node --test --test-name-pattern "surfaces a warning" tests-node/noaa-beta.test.js
  ```
  Expected: 3 failing tests — `assert.equal(profile.bulkDecodeFallbacks, 1)` fails with `undefined !== 1`; `assert.equal(profile.regridBinCacheWriteFailures, 1)` fails with `undefined !== 1`; `assert.equal(warns.length, 2)` fails with `0 !== 2`.

- [ ] **Step 3: Write minimal implementation**

  In `/Users/micha/Development/model-view/scripts/lib/noaa-beta/grib-source.js`:

  (3a) Bulk-decode fallback — replace:
  ```js
    } catch (error) {
      if (process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE === "1") {
        throw error;
      }
      return decodeSelectedRecordsLegacy({
  ```
  with:
  ```js
    } catch (error) {
      if (process.env.MODELVIEW_NOAA_STRICT_BULK_DECODE === "1") {
        throw error;
      }
      // The legacy per-record path is several times slower; surface every silent downgrade.
      incrementProfileCounter(profile, "bulkDecodeFallbacks");
      console.warn(
        `[noaa-beta] bulk decode failed for ${gribPath}; falling back to legacy per-record decode: ${String(error?.message || error)}`,
      );
      return decodeSelectedRecordsLegacy({
  ```

  (3b) `writeRegriddedBinCache` — replace the signature:
  ```js
  async function writeRegriddedBinCache(cacheContext, { binSourcePath, inventoryText, binBytes }) {
  ```
  with:
  ```js
  async function writeRegriddedBinCache(cacheContext, { binSourcePath, inventoryText, binBytes, profile = null }) {
  ```
  and replace its catch block:
  ```js
    } catch {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      await fs.promises.rm(`${tmp}.json`, { force: true }).catch(() => {});
    }
  }
  ```
  with:
  ```js
    } catch (error) {
      // A failed persist silently forces wgrib2 regrid+export on every warm rebuild.
      incrementProfileCounter(profile, "regridBinCacheWriteFailures");
      console.warn(
        `[noaa-beta] regridded-bin cache write failed for ${cacheContext.binPath}: ${String(error?.message || error)}`,
      );
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      await fs.promises.rm(`${tmp}.json`, { force: true }).catch(() => {});
    }
  }
  ```

  (3c) Its call site — replace:
  ```js
      await writeRegriddedBinCache(cacheContext, {
        binSourcePath: binPath,
        inventoryText,
        binBytes: binSize,
      }).catch(() => {});
  ```
  with:
  ```js
      await writeRegriddedBinCache(cacheContext, {
        binSourcePath: binPath,
        inventoryText,
        binBytes: binSize,
        profile,
      }).catch(() => {});
  ```

  (3d) `finalizeNoaaRenderProfile` allowlist — replace:
  ```js
      regridBinCacheHits: Number(profile.regridBinCacheHits) || 0,
      regridBinCacheMisses: Number(profile.regridBinCacheMisses) || 0,
  ```
  with:
  ```js
      regridBinCacheHits: Number(profile.regridBinCacheHits) || 0,
      regridBinCacheMisses: Number(profile.regridBinCacheMisses) || 0,
      regridBinCacheWriteFailures: Number(profile.regridBinCacheWriteFailures) || 0,
      bulkDecodeFallbacks: Number(profile.bulkDecodeFallbacks) || 0,
  ```

  In `/Users/micha/Development/model-view/scripts/lib/noaa-beta/selection.js`:

  (3e) `loadSnowRfModel` — replace:
  ```js
    } else {
      try {
        model = normalizeSnowRfModel(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
      } catch {
        model = null;
      }
      SNOW_RF_MODEL_CACHE.set(cacheKey, model);
    }
  ```
  with:
  ```js
    } else {
      let loadError = null;
      try {
        model = normalizeSnowRfModel(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
      } catch (error) {
        loadError = error;
        model = null;
      }
      if (!model) {
        // Runs once per artifact path; a null model silently drops snowRfConus grids downstream.
        const reason = loadError ? `: ${String(loadError?.message || loadError)}` : " (failed validation)";
        console.warn(`[noaa-beta] snowRfConus model unavailable at ${artifactPath}${reason}`);
      }
      SNOW_RF_MODEL_CACHE.set(cacheKey, model);
    }
  ```

  (3f) `loadWesternLinearSlrModel` — replace:
  ```js
    } else {
      try {
        model = normalizeWesternLinearSlrModel(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
      } catch {
        model = null;
      }
      SNOW_RF_MODEL_CACHE.set(cacheKey, model);
    }
  ```
  with:
  ```js
    } else {
      let loadError = null;
      try {
        model = normalizeWesternLinearSlrModel(JSON.parse(fs.readFileSync(artifactPath, "utf8")));
      } catch (error) {
        loadError = error;
        model = null;
      }
      if (!model) {
        // Runs once per artifact path; a null model silently drops snowWesternLinear grids downstream.
        const reason = loadError ? `: ${String(loadError?.message || loadError)}` : " (failed validation)";
        console.warn(`[noaa-beta] snowWesternLinear model unavailable at ${artifactPath}${reason}`);
      }
      SNOW_RF_MODEL_CACHE.set(cacheKey, model);
    }
  ```

  In `/Users/micha/Development/model-view/scripts/build-noaa-beta-artifacts.js` (`formatRenderProfile`) — replace:
  ```js
    appendHitMissCounter(parts, "regridBin", profile.regridBinCacheHits, profile.regridBinCacheMisses);
  ```
  with:
  ```js
    appendHitMissCounter(parts, "regridBin", profile.regridBinCacheHits, profile.regridBinCacheMisses);
    appendPositiveCounter(parts, "regridBinWriteFailures", profile.regridBinCacheWriteFailures);
    appendPositiveCounter(parts, "bulkDecodeFallbacks", profile.bulkDecodeFallbacks);
  ```

- [ ] **Step 4: Run tests to verify they pass**
  ```bash
  cd /Users/micha/Development/model-view && node --test --test-name-pattern "surfaces a warning" tests-node/noaa-beta.test.js && npm run test:local-runtime && npx prettier --check scripts/lib/noaa-beta/grib-source.js scripts/lib/noaa-beta/selection.js scripts/build-noaa-beta-artifacts.js tests-node/noaa-beta.test.js
  ```
  Expected: 3 new tests pass, full node suite green, prettier clean.

- [ ] **Step 5: Verify byte parity (exactness rule — this task must not change artifact bytes)**
  IMPORTANT: stash ONLY this task's files (a parallel workstream may hold unrelated uncommitted changes; never use a bare `git stash` here):
  ```bash
  cd /Users/micha/Development/model-view
  git stash push -- scripts/lib/noaa-beta/grib-source.js scripts/lib/noaa-beta/selection.js scripts/build-noaa-beta-artifacts.js tests-node/noaa-beta.test.js
  npm run noaa:build:test -- --frames=2
  cp -R output/noaa-beta-cache/artifacts "/private/tmp/claude-501/-Users-micha-Development-model-view/78037a7e-c26e-4910-851d-cea9461c9826/scratchpad/golden-p19"
  git stash pop
  npm run noaa:build:test -- --frames=2
  diff -r --exclude=".complete.json" "/private/tmp/claude-501/-Users-micha-Development-model-view/78037a7e-c26e-4910-851d-cea9461c9826/scratchpad/golden-p19" output/noaa-beta-cache/artifacts
  ```
  Expected: no output (byte-identical). The new counters appear only inside `.complete.json` frame markers, which the protocol excludes. Any other diff is a regression. Note: if `git status` shows third-party uncommitted changes to grib-source.js at stash time, they will ride along in the stash for that file — coordinate or wait for that workstream to land before running parity.

- [ ] **Step 6: Commit**
  ```bash
  cd /Users/micha/Development/model-view && git add scripts/lib/noaa-beta/grib-source.js scripts/lib/noaa-beta/selection.js scripts/build-noaa-beta-artifacts.js tests-node/noaa-beta.test.js && git commit -m "Surface silent renderer fallbacks with warn logs and profile counters (P1.9)

  Bulk-decode legacy fallback, regridded-bin cache write failures, and snow
  SLR model load failures now warn and count. No behavior change; artifact
  bytes verified identical.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 6.3: Short TTL for recent-cycle in-process idx caches (P1.13 — no artifact change)

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta/grib-source.js` (line 66 area: new constants; lines 216-246: `getNoaaRecordsForHour`; lines 248-262: `readOrFetchNoaaIdxTextCached`; lines 331-345: `readOrFetchNoaaContentLengthCached`; module.exports near end of file — line numbers may drift while a parallel workstream edits this file; the quoted strings below are the authoritative anchors and were verified unique)
- Test: `/Users/micha/Development/model-view/tests-node/noaa-beta.test.js`

**Interfaces:**
- Consumes: `context.date` / `context.cycle` (present on all callers via `buildNoaaIndexCacheContext`, grib-source.js:1831-1838), `trimMapToMaxEntries` (grid-ops.js:562), `clearNoaaIndexCachesForTest` (grib-source.js:401-405, unchanged — `Map.clear()` works on the new entry shape).
- Produces: cache entry shape for `NOAA_INDEX_TEXT_CACHE` / `NOAA_INDEX_CONTENT_LENGTH_CACHE` / `NOAA_INDEX_RECORD_CACHE` changes from `Promise` to `{ promise, expiresAtMs }` (audited: only the three functions above plus `clearNoaaIndexCachesForTest` touch these maps). New exports from grib-source.js: `NOAA_RECENT_CYCLE_PIN_WINDOW_MS` (6 h), `NOAA_RECENT_CYCLE_CACHE_TTL_MS` (60 s), `noaaCycleStartMs(date, cycle)`, `noaaIndexCacheExpiresAtMs(context, nowMs = Date.now())`. On-disk idx cache behavior unchanged (still pinned; refetches after TTL read identical bytes when it exists), so artifact bytes cannot change.

- [ ] **Step 1: Write the failing tests**

  In `/Users/micha/Development/model-view/tests-node/noaa-beta.test.js`, insert after the exact line `const PLANNED_COLOR_MAPS = require("../shared/noaa-beta-planned-color-maps.json");` (kept separate from Task 6.2's require so tasks stay order-independent; if Task 6.2 already added its require after the same line, insert this between the `PLANNED_COLOR_MAPS` line and Task 6.2's require — the order does not matter):
  ```js
  const {
    NOAA_INDEX_TEXT_CACHE,
    NOAA_RECENT_CYCLE_CACHE_TTL_MS,
    noaaIndexCacheExpiresAtMs,
  } = require("../scripts/lib/noaa-beta/grib-source");
  ```

  Append at end of file (`_testClearNoaaIndexCaches`, `_testBuildNoaaIndexCacheContext`, `_testReadOrFetchNoaaIdxTextCached` are already imported):
  ```js
  test("NOAA index cache expiry helper applies TTL only within the recent-cycle window", () => {
    const cycleStart = Date.UTC(2026, 3, 25, 12);
    const during = cycleStart + 60 * 60 * 1000;
    assert.equal(
      noaaIndexCacheExpiresAtMs({ date: "20260425", cycle: "12" }, during),
      during + NOAA_RECENT_CYCLE_CACHE_TTL_MS,
    );
    const after = cycleStart + 7 * 60 * 60 * 1000;
    assert.equal(noaaIndexCacheExpiresAtMs({ date: "20260425", cycle: "12" }, after), Number.POSITIVE_INFINITY);
    assert.equal(noaaIndexCacheExpiresAtMs({ date: "bogus", cycle: "12" }, during), Number.POSITIVE_INFINITY);
    assert.equal(noaaIndexCacheExpiresAtMs({}, during), Number.POSITIVE_INFINITY);
  });

  test("NOAA index cache TTL pins completed cycles and expires recent-cycle entries", async () => {
    const originalFetch = global.fetch;
    const idxText = "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:";
    const requests = [];
    global.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), method: String(options.method || "GET").toUpperCase() });
      return { ok: true, status: 200, text: async () => idxText };
    };
    const formatCycle = (timestampMs) => {
      const at = new Date(timestampMs);
      return {
        date: [
          at.getUTCFullYear(),
          String(at.getUTCMonth() + 1).padStart(2, "0"),
          String(at.getUTCDate()).padStart(2, "0"),
        ].join(""),
        cycle: String(at.getUTCHours()).padStart(2, "0"),
      };
    };
    try {
      _testClearNoaaIndexCaches();
      // No rawCacheDir: no disk idx cache, so every in-process miss is a real fetch.
      const recent = formatCycle(Date.now() - 60 * 60 * 1000);
      const recentContext = _testBuildNoaaIndexCacheContext({
        modelKey: "hrrr",
        date: recent.date,
        cycle: recent.cycle,
      });
      const recentIdxUrl = `https://ttl.example.test/recent/${recent.date}/${recent.cycle}/f03.grib2.idx`;
      assert.equal(await _testReadOrFetchNoaaIdxTextCached(recentIdxUrl, recentContext, 3, {}), idxText);
      const recentEntry = NOAA_INDEX_TEXT_CACHE.get(recentIdxUrl);
      assert.ok(Number.isFinite(recentEntry.expiresAtMs));
      assert.equal(await _testReadOrFetchNoaaIdxTextCached(recentIdxUrl, recentContext, 3, {}), idxText);
      assert.equal(requests.length, 1);
      recentEntry.expiresAtMs = Date.now() - 1;
      assert.equal(await _testReadOrFetchNoaaIdxTextCached(recentIdxUrl, recentContext, 3, {}), idxText);
      assert.equal(requests.length, 2);

      const completed = formatCycle(Date.now() - 24 * 60 * 60 * 1000);
      const completedContext = _testBuildNoaaIndexCacheContext({
        modelKey: "hrrr",
        date: completed.date,
        cycle: completed.cycle,
      });
      const completedIdxUrl = `https://ttl.example.test/completed/${completed.date}/${completed.cycle}/f03.grib2.idx`;
      assert.equal(await _testReadOrFetchNoaaIdxTextCached(completedIdxUrl, completedContext, 3, {}), idxText);
      assert.equal(NOAA_INDEX_TEXT_CACHE.get(completedIdxUrl).expiresAtMs, Number.POSITIVE_INFINITY);
    } finally {
      _testClearNoaaIndexCaches();
      global.fetch = originalFetch;
    }
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**
  ```bash
  cd /Users/micha/Development/model-view && node --test --test-name-pattern "index cache" tests-node/noaa-beta.test.js
  ```
  Expected: exactly the two new tests are selected (the pre-existing "NOAA index metadata cache reuses idx text..." test name does not contain the substring "index cache", so the pattern does not select it — it is covered by the full suite in Step 4). Both new tests fail — the helper test with `TypeError: noaaIndexCacheExpiresAtMs is not a function` (not exported yet), the TTL test with `AssertionError` at `assert.ok(Number.isFinite(recentEntry.expiresAtMs))` (cache currently stores bare promises).

- [ ] **Step 3: Write minimal implementation**

  In `/Users/micha/Development/model-view/scripts/lib/noaa-beta/grib-source.js`:

  (3a) Constants — replace:
  ```js
  const NOAA_INDEX_RECORD_CACHE_MAX_ENTRIES = 96;
  ```
  with:
  ```js
  const NOAA_INDEX_RECORD_CACHE_MAX_ENTRIES = 96;

  // NOAA publishes a cycle's files progressively (up to ~4 h for GFS), so idx text
  // and content lengths under the newest cycle can still change upstream. In-process
  // entries for such cycles expire on a short TTL; completed cycles are immutable
  // and stay pinned (the durable on-disk idx cache is unaffected either way).
  const NOAA_RECENT_CYCLE_PIN_WINDOW_MS = 6 * 60 * 60 * 1000;

  const NOAA_RECENT_CYCLE_CACHE_TTL_MS = 60 * 1000;
  ```

  (3b) `getNoaaRecordsForHour` — replace:
  ```js
    let promise = context.decodeSession?.parsedRecords?.get(sessionKey) || NOAA_INDEX_RECORD_CACHE.get(idxUrl);
    if (!promise) {
  ```
  with:
  ```js
    let promise =
      context.decodeSession?.parsedRecords?.get(sessionKey) ||
      liveNoaaIndexCacheEntry(NOAA_INDEX_RECORD_CACHE, idxUrl)?.promise;
    if (!promise) {
  ```
  and replace:
  ```js
      NOAA_INDEX_RECORD_CACHE.set(idxUrl, promise);
      trimMapToMaxEntries(NOAA_INDEX_RECORD_CACHE, NOAA_INDEX_RECORD_CACHE_MAX_ENTRIES);
  ```
  with:
  ```js
      setNoaaIndexCacheEntry(NOAA_INDEX_RECORD_CACHE, idxUrl, promise, context);
      trimMapToMaxEntries(NOAA_INDEX_RECORD_CACHE, NOAA_INDEX_RECORD_CACHE_MAX_ENTRIES);
  ```

  (3c) `readOrFetchNoaaIdxTextCached` — replace the whole function:
  ```js
  async function readOrFetchNoaaIdxTextCached(idxUrl, context, hour, profile = null) {
    const key = String(idxUrl || "");
    let promise = NOAA_INDEX_TEXT_CACHE.get(key);
    if (promise) {
      incrementProfileCounter(profile, "indexCacheHits");
      return promise;
    }
    promise = readOrFetchNoaaIdxText(idxUrl, context, hour, profile).catch((error) => {
      NOAA_INDEX_TEXT_CACHE.delete(key);
      throw error;
    });
    NOAA_INDEX_TEXT_CACHE.set(key, promise);
    trimMapToMaxEntries(NOAA_INDEX_TEXT_CACHE, NOAA_INDEX_TEXT_CACHE_MAX_ENTRIES);
    return promise;
  }
  ```
  with:
  ```js
  function noaaCycleStartMs(date, cycle) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(date || ""));
    const cycleHour = Number(cycle);
    if (!match || !Number.isInteger(cycleHour) || cycleHour < 0 || cycleHour > 23) {
      return Number.NaN;
    }
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), cycleHour);
  }

  function noaaIndexCacheExpiresAtMs(context, nowMs = Date.now()) {
    const cycleStartMs = noaaCycleStartMs(context?.date, context?.cycle);
    if (!Number.isFinite(cycleStartMs) || nowMs - cycleStartMs >= NOAA_RECENT_CYCLE_PIN_WINDOW_MS) {
      return Number.POSITIVE_INFINITY;
    }
    return nowMs + NOAA_RECENT_CYCLE_CACHE_TTL_MS;
  }

  function liveNoaaIndexCacheEntry(cache, key, nowMs = Date.now()) {
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }
    if (nowMs >= entry.expiresAtMs) {
      cache.delete(key);
      return null;
    }
    return entry;
  }

  function setNoaaIndexCacheEntry(cache, key, promise, context) {
    cache.set(key, { promise, expiresAtMs: noaaIndexCacheExpiresAtMs(context) });
  }

  async function readOrFetchNoaaIdxTextCached(idxUrl, context, hour, profile = null) {
    const key = String(idxUrl || "");
    const live = liveNoaaIndexCacheEntry(NOAA_INDEX_TEXT_CACHE, key);
    if (live) {
      incrementProfileCounter(profile, "indexCacheHits");
      return live.promise;
    }
    const promise = readOrFetchNoaaIdxText(idxUrl, context, hour, profile).catch((error) => {
      NOAA_INDEX_TEXT_CACHE.delete(key);
      throw error;
    });
    setNoaaIndexCacheEntry(NOAA_INDEX_TEXT_CACHE, key, promise, context);
    trimMapToMaxEntries(NOAA_INDEX_TEXT_CACHE, NOAA_INDEX_TEXT_CACHE_MAX_ENTRIES);
    return promise;
  }
  ```

  (3d) `readOrFetchNoaaContentLengthCached` — replace the whole function:
  ```js
  async function readOrFetchNoaaContentLengthCached(gribUrl, context, hour, profile = null) {
    const key = String(gribUrl || "");
    let promise = NOAA_INDEX_CONTENT_LENGTH_CACHE.get(key);
    if (promise) {
      incrementProfileCounter(profile, "contentLengthCacheHits");
      return promise;
    }
    promise = readOrFetchNoaaContentLength(gribUrl, context, hour, profile).catch((error) => {
      NOAA_INDEX_CONTENT_LENGTH_CACHE.delete(key);
      throw error;
    });
    NOAA_INDEX_CONTENT_LENGTH_CACHE.set(key, promise);
    trimMapToMaxEntries(NOAA_INDEX_CONTENT_LENGTH_CACHE, NOAA_INDEX_CONTENT_LENGTH_CACHE_MAX_ENTRIES);
    return promise;
  }
  ```
  with:
  ```js
  async function readOrFetchNoaaContentLengthCached(gribUrl, context, hour, profile = null) {
    const key = String(gribUrl || "");
    const live = liveNoaaIndexCacheEntry(NOAA_INDEX_CONTENT_LENGTH_CACHE, key);
    if (live) {
      incrementProfileCounter(profile, "contentLengthCacheHits");
      return live.promise;
    }
    const promise = readOrFetchNoaaContentLength(gribUrl, context, hour, profile).catch((error) => {
      NOAA_INDEX_CONTENT_LENGTH_CACHE.delete(key);
      throw error;
    });
    setNoaaIndexCacheEntry(NOAA_INDEX_CONTENT_LENGTH_CACHE, key, promise, context);
    trimMapToMaxEntries(NOAA_INDEX_CONTENT_LENGTH_CACHE, NOAA_INDEX_CONTENT_LENGTH_CACHE_MAX_ENTRIES);
    return promise;
  }
  ```

  (3e) Exports — replace:
  ```js
    NOAA_INDEX_TEXT_CACHE,
    NOAA_INDEX_TEXT_CACHE_MAX_ENTRIES,
    PRECIP_TYPE_DECODE_KEYS,
  ```
  with:
  ```js
    NOAA_INDEX_TEXT_CACHE,
    NOAA_INDEX_TEXT_CACHE_MAX_ENTRIES,
    NOAA_RECENT_CYCLE_CACHE_TTL_MS,
    NOAA_RECENT_CYCLE_PIN_WINDOW_MS,
    PRECIP_TYPE_DECODE_KEYS,
  ```
  and replace:
  ```js
    materializeSelectedGribUncached,
    noaaIdxCachePath,
    noaaIdxMetadataCachePath,
    parseNoaaIdx,
  ```
  with:
  ```js
    materializeSelectedGribUncached,
    noaaCycleStartMs,
    noaaIdxCachePath,
    noaaIdxMetadataCachePath,
    noaaIndexCacheExpiresAtMs,
    parseNoaaIdx,
  ```

- [ ] **Step 4: Run tests to verify they pass**
  ```bash
  cd /Users/micha/Development/model-view && node --test --test-name-pattern "index cache" tests-node/noaa-beta.test.js && npm run test:local-runtime && npx prettier --check scripts/lib/noaa-beta/grib-source.js tests-node/noaa-beta.test.js
  ```
  Expected: both new tests pass under the pattern; the full suite (`npm run test:local-runtime`) stays green — in particular the pre-existing "NOAA index metadata cache reuses idx text and content length across split contexts" test still passes unchanged (its 2026-04-25 cycle is far outside the recent window, so entries pin exactly as before); prettier clean.

- [ ] **Step 5: Verify byte parity (exactness rule — this task must not change artifact bytes)**
  IMPORTANT: stash ONLY this task's files (a parallel workstream may hold unrelated uncommitted changes; never use a bare `git stash` here):
  ```bash
  cd /Users/micha/Development/model-view
  git stash push -- scripts/lib/noaa-beta/grib-source.js tests-node/noaa-beta.test.js
  npm run noaa:build:test -- --frames=2
  cp -R output/noaa-beta-cache/artifacts "/private/tmp/claude-501/-Users-micha-Development-model-view/78037a7e-c26e-4910-851d-cea9461c9826/scratchpad/golden-p113"
  git stash pop
  npm run noaa:build:test -- --frames=2
  diff -r --exclude=".complete.json" "/private/tmp/claude-501/-Users-micha-Development-model-view/78037a7e-c26e-4910-851d-cea9461c9826/scratchpad/golden-p113" output/noaa-beta-cache/artifacts
  ```
  Expected: no output (byte-identical). TTL expiry only re-reads the durable on-disk idx cache (identical content); completed cycles never expire. Note: if `git status` shows third-party uncommitted changes to grib-source.js at stash time, they will ride along in the stash for that file — coordinate or wait for that workstream to land before running parity.

- [ ] **Step 6: Commit**
  ```bash
  cd /Users/micha/Development/model-view && git add scripts/lib/noaa-beta/grib-source.js tests-node/noaa-beta.test.js && git commit -m "Expire recent-cycle in-process idx caches on a short TTL (P1.13)

  NOAA_INDEX_TEXT/CONTENT_LENGTH/RECORD cache entries for the newest cycle
  (within 6 h of cycle start) now carry a 60 s TTL; completed cycles stay
  pinned. On-disk idx cache unchanged; artifact bytes verified identical.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```


## Section 7: NAM precip planner: model-native cadence past f36 (spec P1.10)

### Task 7.1: NAM precip planner past f36 — plan candidate hours on model publication cadence (P1.10)

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta/model-config.js` (gfs block lines 14-25, nam block lines 26-37, nam3km block lines 38-49, hrrr block lines 50-61 — add `forecastHourCadence` to each)
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta/accumulation.js` (line 41 require; lines 683-704 `buildPrecipSourceForecastHours`)
- Test: `/Users/micha/Development/model-view/tests-node/noaa-beta.test.js` (new require after the `require("../scripts/lib/noaa-beta-renderer")` destructure ending at line 121; three new tests inserted after the test `"NOAA 1-h precip plan uses exact prior-hour APCP or cumulative differencing"` which ends at line 3720)

**Interfaces:**
- Consumes: `NOAA_BETA_MODEL_CONFIG` (scripts/lib/noaa-beta/model-config.js); existing accumulation.js exports `resolveAvailableForecastHours(latestMetadata, targetHour, modelKey)` and `previousRunMaxSourceHour(context, targetHour)`; existing renderer re-export `_testResolvePrecipAccumulationPlan` (noaa-beta-renderer.js:1897) and `parseNoaaIdx` (already imported in the test file).
- Produces: `NOAA_BETA_MODEL_CONFIG[<model>].forecastHourCadence: ReadonlyArray<{ maxHour: number; stepHours: number }>` — ascending segments; candidate hours advance `stepHours` within each segment starting from the previous segment's boundary (gfs `[{120,1},{384,3}]`, nam `[{36,1},{84,3}]`, nam3km `[{60,1}]`, hrrr `[{48,1}]`). `resolveAvailableForecastHours` keeps its signature but now returns cadence-correct hours for all four models; winter.js (lines 280/370/521/726) and the run-max planner pick this up automatically. No exports removed or renamed (public-mirror rule holds; no palette/scale surface touched).

- [ ] **Step 1: Write the failing tests**

  In `/Users/micha/Development/model-view/tests-node/noaa-beta.test.js`, add a new require immediately after the closing of the noaa-beta-renderer destructure, i.e. after line 121:

  ```js
  } = require("../scripts/lib/noaa-beta-renderer");
  ```

  insert:

  ```js
  const { previousRunMaxSourceHour, resolveAvailableForecastHours } = require("../scripts/lib/noaa-beta/accumulation");
  ```

  Then insert these three tests after the test `"NOAA 1-h precip plan uses exact prior-hour APCP or cumulative differencing"` (its closing `});` is at line 3720, just before `test("NOAA reflectivity selectors handle GFS-style composite levels ...")`):

  ```js
  test("NOAA planner candidate hours follow the model publication cadence", () => {
    const namHours = resolveAvailableForecastHours(null, 84, "nam");
    assert.deepEqual(
      namHours.filter((hour) => hour <= 36),
      Array.from({ length: 37 }, (_, hour) => hour),
    );
    assert.deepEqual(
      namHours.filter((hour) => hour > 36),
      [39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84],
    );

    const expectedGfsHours = [];
    for (let hour = 0; hour <= 120; hour += 1) {
      expectedGfsHours.push(hour);
    }
    for (let hour = 123; hour <= 384; hour += 3) {
      expectedGfsHours.push(hour);
    }
    assert.deepEqual(resolveAvailableForecastHours(null, 384, "gfs"), expectedGfsHours);

    assert.deepEqual(
      resolveAvailableForecastHours(null, 48, "hrrr"),
      Array.from({ length: 49 }, (_, hour) => hour),
    );
    assert.deepEqual(
      resolveAvailableForecastHours(null, 60, "nam3km"),
      Array.from({ length: 61 }, (_, hour) => hour),
    );
  });

  test("NOAA run-max iteration steps to the previous published NAM hour past f36", () => {
    const availableHours = resolveAvailableForecastHours(null, 39, "nam");
    assert.equal(previousRunMaxSourceHour({ availableHours }, 39), 36);
  });

  test("NOAA precip plans for NAM f39 never touch unpublished sub-cadence hours", async () => {
    const publishedRecords = new Map([
      [0, []],
      [12, parseNoaaIdx("1:0:d=2026042512:APCP:surface:0-12 hour acc fcst:", 100)],
      [24, parseNoaaIdx("1:0:d=2026042512:APCP:surface:12-24 hour acc fcst:", 100)],
      [36, parseNoaaIdx("1:0:d=2026042512:APCP:surface:24-36 hour acc fcst:", 100)],
      [39, parseNoaaIdx("1:0:d=2026042512:APCP:surface:36-39 hour acc fcst:", 100)],
    ]);
    const guardHour = (hour) => {
      assert.ok(publishedRecords.has(hour), `planner requested unpublished NAM hour ${hour}`);
    };
    const recordsByHour = {
      has: (hour) => {
        guardHour(hour);
        return publishedRecords.has(hour);
      },
      get: (hour) => {
        guardHour(hour);
        return publishedRecords.get(hour);
      },
      set: (hour, records) => publishedRecords.set(hour, records),
    };
    const availableHours = resolveAvailableForecastHours(null, 39, "nam");
    const context = {
      targetHour: 39,
      availableHours,
      availableHourSet: new Set(availableHours),
      recordsByHour,
      intervalsByHour: new Map(),
      intervalSumPlanCache: new Map(),
      cumulativePlanCache: new Map(),
    };

    const rollingPlan = await _testResolvePrecipAccumulationPlan(
      { accumulationMode: "rolling", accumulationWindowHours: 1 },
      context,
    );
    assert.equal(rollingPlan, null);

    const totalPlan = await _testResolvePrecipAccumulationPlan({ accumulationMode: "total" }, context);
    assert.deepEqual(
      totalPlan.terms.map((term) => `${term.weight}:${term.hour}:${term.record.forecast}`),
      ["1:12:0-12 hour acc fcst", "1:24:12-24 hour acc fcst", "1:36:24-36 hour acc fcst", "1:39:36-39 hour acc fcst"],
    );
  });
  ```

  Why the third test catches the production bug offline: in production, `getNoaaRecordsForHour` fetches `nam.tXXz.awphys38.tm00.grib2.idx` for the unpublished hour 38 and throws `NOAA request failed (404)`. In the test, the guarded `recordsByHour.has(38)` call (the first thing `getNoaaRecordsForHour` does, grib-source.js:218) fails the assertion before any network I/O.

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  cd /Users/micha/Development/model-view && node --test tests-node/noaa-beta.test.js
  ```

  Expected (verified against current code): `# tests 115`, `# pass 112`, `# fail 3` with exactly these failures:
  - `not ok ... NOAA planner candidate hours follow the model publication cadence` — AssertionError deepEqual: NAM hours > 36 are `[37, 38, 39, 40, ...]` instead of `[39, 42, ...]`
  - `not ok ... NOAA run-max iteration steps to the previous published NAM hour past f36` — `38 !== 36`
  - `not ok ... NOAA precip plans for NAM f39 never touch unpublished sub-cadence hours` — `planner requested unpublished NAM hour 38`

- [ ] **Step 3: Write minimal implementation**

  **(a) `/Users/micha/Development/model-view/scripts/lib/noaa-beta/model-config.js` — add `forecastHourCadence` to each model config (4 edits).**

  In the `gfs` block, replace:
  ```js
      productKey: "pgrb2-0p25",
      cycleHours: [0, 6, 12, 18],
      buildUrl: ({ baseUrl, date, cycle, hour }) => {
        const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_GFS_BASE_URL);
        return `${normalizedBase}/gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.pgrb2.0p25.f${padHour(hour)}`;
      },
  ```
  with:
  ```js
      productKey: "pgrb2-0p25",
      cycleHours: [0, 6, 12, 18],
      forecastHourCadence: Object.freeze([
        Object.freeze({ maxHour: 120, stepHours: 1 }),
        Object.freeze({ maxHour: 384, stepHours: 3 }),
      ]),
      buildUrl: ({ baseUrl, date, cycle, hour }) => {
        const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_GFS_BASE_URL);
        return `${normalizedBase}/gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.pgrb2.0p25.f${padHour(hour)}`;
      },
  ```

  In the `nam` block, replace:
  ```js
      productKey: "awphys",
      cycleHours: [0, 6, 12, 18],
      buildUrl: ({ baseUrl, date, cycle, hour }) => {
        const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_NAM_BASE_URL);
        return `${normalizedBase}/nam.${date}/nam.t${cycle}z.awphys${padTwoDigitHour(hour)}.tm00.grib2`;
      },
  ```
  with:
  ```js
      productKey: "awphys",
      cycleHours: [0, 6, 12, 18],
      forecastHourCadence: Object.freeze([
        Object.freeze({ maxHour: 36, stepHours: 1 }),
        Object.freeze({ maxHour: 84, stepHours: 3 }),
      ]),
      buildUrl: ({ baseUrl, date, cycle, hour }) => {
        const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_NAM_BASE_URL);
        return `${normalizedBase}/nam.${date}/nam.t${cycle}z.awphys${padTwoDigitHour(hour)}.tm00.grib2`;
      },
  ```

  In the `nam3km` block, replace:
  ```js
      productKey: "conusnest-hires",
      cycleHours: [0, 6, 12, 18],
  ```
  with:
  ```js
      productKey: "conusnest-hires",
      cycleHours: [0, 6, 12, 18],
      forecastHourCadence: Object.freeze([Object.freeze({ maxHour: 60, stepHours: 1 })]),
  ```

  In the `hrrr` block, replace:
  ```js
      productKey: "wrfprs",
      cycleHours: Array.from({ length: 24 }, (_, hour) => hour),
  ```
  with:
  ```js
      productKey: "wrfprs",
      cycleHours: Array.from({ length: 24 }, (_, hour) => hour),
      forecastHourCadence: Object.freeze([Object.freeze({ maxHour: 48, stepHours: 1 })]),
  ```

  Cadence values verified against the NOAA S3 buckets on 2026-07-02 (nam.20260630/t00z: awphys f37/f38/f40/f41 = 404, f36/f39/f42/f84 = 200; conusnest f60 = 200, f61 = 404; hrrr f48 = 200). Re-verified by the reviewer on 2026-07-01's 00Z run: awphys 36=200, 37/38/40/41=404, 39/42/84=200, 85=404; conusnest f60=200, f61=404.

  **(b) `/Users/micha/Development/model-view/scripts/lib/noaa-beta/accumulation.js` — two edits.**

  Replace line 41:
  ```js
  const { buildNoaaGribUrl } = require("./model-config");
  ```
  with:
  ```js
  const { NOAA_BETA_MODEL_CONFIG, buildNoaaGribUrl } = require("./model-config");
  ```

  Replace the whole function at lines 683-704:
  ```js
  function buildPrecipSourceForecastHours(modelKey, targetHour) {
    const target = Math.max(0, Math.round(Number(targetHour)));
    if (!Number.isFinite(target)) {
      return [];
    }
    const normalizedModel = String(modelKey || "").toLowerCase();
    const hours = [];
    if (normalizedModel === "gfs") {
      const hourlyLimit = Math.min(target, 120);
      for (let hour = 0; hour <= hourlyLimit; hour += 1) {
        hours.push(hour);
      }
      for (let hour = 123; hour <= target; hour += 3) {
        hours.push(hour);
      }
      return hours;
    }
    for (let hour = 0; hour <= target; hour += 1) {
      hours.push(hour);
    }
    return hours;
  }
  ```
  with:
  ```js
  function buildPrecipSourceForecastHours(modelKey, targetHour) {
    const target = Math.max(0, Math.round(Number(targetHour)));
    if (!Number.isFinite(target)) {
      return [];
    }
    const normalizedModel = String(modelKey || "").toLowerCase();
    const cadence = NOAA_BETA_MODEL_CONFIG[normalizedModel]?.forecastHourCadence;
    if (!Array.isArray(cadence) || cadence.length === 0) {
      const hours = [];
      for (let hour = 0; hour <= target; hour += 1) {
        hours.push(hour);
      }
      return hours;
    }
    // Candidate hours must follow the model's publication cadence: NAM only
    // publishes 3-hourly awphys files past f36, so off-cadence candidates 404.
    const hours = [0];
    let hour = 0;
    for (const segment of cadence) {
      const limit = Math.min(target, segment.maxHour);
      while (hour + segment.stepHours <= limit) {
        hour += segment.stepHours;
        hours.push(hour);
      }
    }
    return hours;
  }
  ```

  Notes on parity: the segment walk reproduces the old GFS output exactly for every target 0-384 (asserted element-wise by the new test at target 384; reviewer additionally brute-forced every target 0-384 for gfs, 0-48 hrrr, 0-60 nam3km, 0-36 nam, and 0-400 for null/unknown keys — zero diffs), and is hour-for-hour identical for hrrr (0-48), nam3km (0-60), and nam targets <= 36. Unknown/absent model keys keep the old hourly fallback, so `resolveAvailableForecastHours(..., modelKey = null)` behavior is unchanged. Off-cadence targets (which the frame plan never produces) are still covered because `resolveAvailableForecastHours` (accumulation.js:674-675) pushes `targetHour` explicitly.

- [ ] **Step 4: Run tests to verify they pass**

  ```bash
  cd /Users/micha/Development/model-view && node --test tests-node/noaa-beta.test.js
  ```
  Expected: `# tests 115`, `# pass 115`, `# fail 0` (verified: the fix produces exactly this, with the pre-existing 112 tests unaffected).

  ```bash
  cd /Users/micha/Development/model-view && npx prettier --check scripts/lib/noaa-beta/model-config.js scripts/lib/noaa-beta/accumulation.js tests-node/noaa-beta.test.js && npx eslint scripts/lib/noaa-beta/model-config.js scripts/lib/noaa-beta/accumulation.js tests-node/noaa-beta.test.js --quiet
  ```
  Expected: "All matched files use Prettier code style!" and no eslint output.

- [ ] **Step 5: Targeted NAM build verification (approved output change — spec P1.10 + exactness rule)**

  Requires network and a NAM run still on `noaa-nam-pds` (runs persist for days; yesterday's 00Z is safe). Uses the golden-frame protocol: only NAM frames past f36 may change (broken -> working); NAM <= f36 must stay byte-identical.

  Artifact layout is `output/noaa-beta-cache/artifacts/tiles/<modelKey>/<runId>` (verified on disk: `tiles/nam3km/20260614-0600Z` exists), so the NAM run directory is deterministic. Do NOT locate it with `find ... -path "*nam*"` — that glob also matches the `nam3km` model directory and can return two paths.

  ```bash
  cd /Users/micha/Development/model-view
  D=$(date -v-1d +%Y%m%d)
  SCRATCH=$(mktemp -d)
  NAM_RUN_TILES="output/noaa-beta-cache/artifacts/tiles/nam/${D}-0000Z"

  # (a) Pre-fix failure repro + golden baseline (stash the fix temporarily)
  git stash
  node scripts/build-noaa-beta-artifacts.js --models=nam --hours=39 --date=$D --cycle=00 2>&1 | tee "$SCRATCH/pre-fix-f39.log"
  #   EXPECT: the f39 frame FAILS with an error containing
  #   "NOAA request failed (404)" for a ".../nam.t00z.awphys38.tm00.grib2.idx" URL.
  node scripts/build-noaa-beta-artifacts.js --models=nam --hours=33,36 --date=$D --cycle=00 --force
  cp -R "$NAM_RUN_TILES" "$SCRATCH/golden-nam"
  git stash pop

  # (b) Parity on unaffected NAM hours (<= f36): rebuild the same frames with the fix
  node scripts/build-noaa-beta-artifacts.js --models=nam --hours=33,36 --date=$D --cycle=00 --force
  diff -r --exclude="*.complete.json" "$SCRATCH/golden-nam" "$NAM_RUN_TILES"
  #   EXPECT: no differences reported for any f033/f036 artifact (byte-identical).

  # (c) Fixed behavior past f36
  node scripts/build-noaa-beta-artifacts.js --models=nam --hours=39,42 --date=$D --cycle=00
  #   EXPECT: build completes without frame errors; f039/f042 artifacts exist under the run's
  #   tiles directory (precip3h/precip6h/precip12h/precip24h/precipTotal layers present).
  #   The 1-h "precip" plan is legitimately underivable at 3-hourly hours (window H-1..H does
  #   not exist in NAM data); the layer falls back to the raw APCP bucket exactly as GFS
  #   already does past f120 today (noaa-beta-renderer.js:680,
  #   `transformGridAffine(decoded.precip, MM_TO_IN, 0, 0)`) — no new gating added.
  ```

  Same-tree, same-machine comparison, so the libdeflate PNG-backend caveat does not apply (no need to set MODELVIEW_PNG_DEFLATE_BACKEND). Other models are untouched by construction (candidate lists proven identical in Step 1's cadence test), so no GFS/HRRR/NAM3km parity build is required.

- [ ] **Step 6: Commit**

  ```bash
  cd /Users/micha/Development/model-view && git add scripts/lib/noaa-beta/model-config.js scripts/lib/noaa-beta/accumulation.js tests-node/noaa-beta.test.js && git commit -m "$(cat <<'EOF'
  Plan NOAA accumulation candidates on model publication cadence

  NAM awphys only publishes 3-hourly files past f36; the hourly planner
  candidates 404'd the idx fetch and failed every NAM frame past f36
  (precip accumulation, run-max, and snow/ice planners all consume the
  same candidate list). Derive candidate hours from a per-model
  forecastHourCadence in NOAA_BETA_MODEL_CONFIG instead of hardcoding;
  GFS/HRRR/NAM3km and NAM<=f36 candidate lists are unchanged (P1.10).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  EOF
  )"
  ```


## Section 8: Layer keys from shared config, honest frame chips, bounded memory (spec P1.8, P1.11, P1.12)

### Task 8.1: Derive `isLayerKey` membership from the shared config layer order (P1.8)

**Files:**
- Modify: `/Users/micha/Development/model-view/next/src/config/layers.ts` (insert after `FALLBACK_ORDER`, lines 32-46; replace `isLayerKey`, lines 638-653)
- Test: `/Users/micha/Development/model-view/tests-react/display-menu.spec.js` (append helper + one test)

**Interfaces:**
- Consumes: `sharedConfig.layerOrder` (shared/modelview-config.json — 19 keys incl. 6 snow keys), `FALLBACK_ORDER` (layers.ts:32).
- Produces: `LAYER_STACK_ORDER` now equals the full shared config order (snow keys between `precipTotal` and `reflectivityComposite`; `reflectivity1kmPrecipType` in its config position instead of after `synoptic`). No export is added, removed, or renamed (public-mirror rule: `LAYER_OPTIONS`, `LEGEND_CONFIG`, panes/z-index maps all untouched). Task 8.4 relies on snow keys being valid layer keys.

Prerequisites (once per machine): `npm run install:browsers`. The Playwright web server auto-runs `scripts/prepare-react-fixture-cache.js` (see playwright.react.config.js `webServer`).

- [ ] **Step 1: Write the failing test.** Append to `/Users/micha/Development/model-view/tests-react/display-menu.spec.js`:

```js
async function toggleCheckbox(page, checkbox, checked) {
  if ((await checkbox.isChecked()) === checked) {
    return;
  }
  await checkbox.focus();
  await page.keyboard.press("Space");
  if (checked) {
    await expect(checkbox).toBeChecked();
  } else {
    await expect(checkbox).not.toBeChecked();
  }
}

function buildSnowOrderingManifest() {
  return {
    schemaVersion: 4,
    model: "gfs",
    run: "20260423-1200Z",
    view: "conus",
    generatedAt: "2026-04-23T12:10:00Z",
    referenceTime: "2026-04-23T12:00:00Z",
    openDataModel: "noaa-gfs-pgrb2-0p25",
    hourStatus: { 0: "loaded" },
    parameterOrder: ["temperature", "snow10to1", "reflectivityComposite"],
    parameters: {
      snow10to1: {
        key: "snow10to1",
        label: "10:1 Snow",
        unit: "in",
        group: "Winter / Snow & Ice",
        legendTicks: [1, 6, 12, 24, 48],
        legendStops: [
          [0, [40, 90, 140]],
          [1, [220, 80, 160]],
        ],
      },
    },
    frames: [
      {
        hour: 0,
        validHourKey: "2026-04-23T12:00:00Z",
        bounds: { north: 53, south: 21, west: -129, east: -63 },
        cols: 1600,
        rows: 980,
        layers: {
          temperature: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE },
          snow10to1: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE },
          reflectivityComposite: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE },
        },
      },
    ],
  };
}

test("snow layers follow the shared config stack order ahead of radar", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(latestPointer("gfs", "manifests/gfs/snow-order.json")),
    });
  });
  await page.route("**/__cf/manifests/gfs/snow-order.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildSnowOrderingManifest()),
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.getByText("Ready")).toBeVisible();

  await panel.getByRole("button", { name: /Parameters/ }).click();
  await toggleCheckbox(page, panel.getByRole("checkbox", { name: /10:1 Snow/ }), true);
  await toggleCheckbox(page, panel.getByRole("checkbox", { name: /Composite Reflectivity/ }), true);
  await toggleCheckbox(page, panel.getByRole("checkbox", { name: /Temp/ }).first(), false);

  // Legend cards render in getLayerStackOrder order; shared config puts snow before radar.
  await expect
    .poll(async () => panel.locator(".z-\\[510\\] span.font-medium").allTextContents(), { timeout: 5_000 })
    .toEqual(["10:1 Snow (in)", "Composite Reflectivity (dBZ)"]);
});
```

- [ ] **Step 2: Run test to verify it fails.**
`npx playwright test -c playwright.react.config.js tests-react/display-menu.spec.js --workers=1 --reporter=line`
Expected: the new test fails — the poll keeps returning `["Composite Reflectivity (dBZ)", "10:1 Snow (in)"]` (snow is appended after the base stack today because `isLayerKey("snow10to1")` is false) and times out with `expect.poll ... toEqual` mismatch. The 3 pre-existing tests in the file must still pass.

- [ ] **Step 3: Write minimal implementation.** In `/Users/micha/Development/model-view/next/src/config/layers.ts`, immediately after the `FALLBACK_ORDER` array (which ends at line 46 with `"synoptic",\n];`), insert:

```ts
// Membership derives from the shared config order so configured layers (e.g. the
// snow suite) stay in LAYER_STACK_ORDER instead of being silently filtered out.
const KNOWN_LAYER_KEYS = new Set<string>([
  ...((sharedConfig.layerOrder as string[] | undefined) || []),
  ...FALLBACK_ORDER,
]);
```

Then replace the entire function at lines 638-653:

```ts
function isLayerKey(value: string): value is LayerKey {
  return (
    value === "temperature" ||
    value === "reflectivityComposite" ||
    value === "reflectivity1km" ||
    value === "reflectivity" ||
    value === "wind" ||
    value === "precip" ||
    value === "precip3h" ||
    value === "precip6h" ||
    value === "precip12h" ||
    value === "precip24h" ||
    value === "precipTotal" ||
    value === "synoptic"
  );
}
```

with:

```ts
function isLayerKey(value: string): value is LayerKey {
  return KNOWN_LAYER_KEYS.has(value);
}
```

`KNOWN_LAYER_KEYS` MUST be placed before line 157 (`export const LAYER_STACK_ORDER = sanitizeOrder(...)`) because `sanitizeOrder` runs at module init — placing it after `FALLBACK_ORDER` satisfies this. Do not change `sanitizeOrder`, `LAYER_PANES`, `LAYER_Z_INDEX`, or any exported constant. (Snow keys have no entry in `LAYER_PANES`/`LAYER_Z_INDEX`; `getLayerPane`/`getLayerZIndex` already fall back to the dynamic pane, which is how snow renders today.)

- [ ] **Step 4: Run test to verify it passes.**
`npm run typecheck && npx playwright test -c playwright.react.config.js tests-react/display-menu.spec.js --workers=1 --reporter=line`
Expected: typecheck clean; all 4 tests in the file pass. Also run `npx playwright test -c playwright.react.config.js tests-react/latest-run-memory-cache.spec.js tests-react/smoke-react.spec.js --workers=1 --reporter=line` — must stay green (the warmup fixture manifests contain no snow refs yet, so the enlarged stack order fetches nothing new). This change touches no `scripts/**` renderer code, so artifact byte-parity is unaffected by construction.

- [ ] **Step 5: Commit.**
`git add next/src/config/layers.ts tests-react/display-menu.spec.js && git commit -m "Derive isLayerKey from shared config layer order (P1.8)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 8.2: Browser image-cache budgets: 2 GiB object-URL / 4 GiB decoded defaults with VITE_ overrides (P1.12, budgets half)

**Files:**
- Modify: `/Users/micha/Development/model-view/next/src/core/image-prefetch-cache.ts` (lines 6-10 constants; line 190 budget reference; append dev hook at end of file)
- Create/Test: `/Users/micha/Development/model-view/tests-react/image-cache-budget.spec.js`

**Interfaces:**
- Consumes: existing `resolveCacheLimitBytes(value, fallbackMb)` (image-prefetch-cache.ts:17-21).
- Produces: env vars **`VITE_IMAGE_OBJECT_URL_CACHE_LIMIT_MB`** (new, default 2048 MB = 2 GiB) and **`VITE_DECODED_IMAGE_CACHE_LIMIT_MB`** (existing name kept, default changed 64 GiB → 4096 MB = 4 GiB). Dev-only window hook `window.__wxImagePrefetchCache = { getStats(), setObjectUrlLimitBytes(bytes) }` (gated on `import.meta.env.DEV`; the Playwright server runs Vite dev, so it is present in tests). Task 8.3's eviction test depends on `setObjectUrlLimitBytes`.

- [ ] **Step 1: Write the failing test.** Create `/Users/micha/Development/model-view/tests-react/image-cache-budget.spec.js`:

```js
const { test, expect } = require("@playwright/test");

const GIB = 1024 * 1024 * 1024;

test("image prefetch cache budgets default to 2 GiB object-URL and 4 GiB decoded", async ({ page }) => {
  await page.goto("/");
  const stats = await page.evaluate(() => window.__wxImagePrefetchCache?.getStats() ?? null);
  expect(stats).not.toBeNull();
  expect(stats.objectUrlLimitBytes).toBe(2 * GIB);
  expect(stats.decodedLimitBytes).toBe(4 * GIB);
});
```

- [ ] **Step 2: Run test to verify it fails.**
`npx playwright test -c playwright.react.config.js tests-react/image-cache-budget.spec.js --workers=1 --reporter=line`
Expected: fails at `expect(stats).not.toBeNull()` — `window.__wxImagePrefetchCache` is undefined (hook does not exist yet).

- [ ] **Step 3: Write minimal implementation.** In `/Users/micha/Development/model-view/next/src/core/image-prefetch-cache.ts` replace lines 6-10:

```ts
const IMAGE_OBJECT_URL_CACHE_LIMIT_BYTES = 32 * 1024 * 1024 * 1024;
const DECODED_IMAGE_CACHE_LIMIT_BYTES = resolveCacheLimitBytes(
  import.meta.env.VITE_DECODED_IMAGE_CACHE_LIMIT_MB,
  64 * 1024,
);
```

with:

```ts
// Budgets are configured in MB; defaults per spec P1.12: 2 GiB object-URL blobs, 4 GiB decoded bitmaps.
let imageObjectUrlCacheLimitBytes = resolveCacheLimitBytes(
  import.meta.env.VITE_IMAGE_OBJECT_URL_CACHE_LIMIT_MB,
  2 * 1024,
);
const DECODED_IMAGE_CACHE_LIMIT_BYTES = resolveCacheLimitBytes(
  import.meta.env.VITE_DECODED_IMAGE_CACHE_LIMIT_MB,
  4 * 1024,
);
```

In `enforceLayerImageObjectUrlBudget` replace the loop head (line 190):

```ts
  while (layerImageObjectUrlCacheBytes > IMAGE_OBJECT_URL_CACHE_LIMIT_BYTES && layerImageObjectUrlCache.size > 0) {
```

with:

```ts
  while (layerImageObjectUrlCacheBytes > imageObjectUrlCacheLimitBytes && layerImageObjectUrlCache.size > 0) {
```

Append at the very end of the file:

```ts
interface ImagePrefetchCacheDebugHooks {
  getStats(): {
    decodedBytes: number;
    decodedEntries: number;
    decodedLimitBytes: number;
    objectUrlBytes: number;
    objectUrlEntries: number;
    objectUrlLimitBytes: number;
  };
  setObjectUrlLimitBytes(bytes: number): void;
}

// Dev-only introspection used by the Playwright cache-budget specs.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as Window & { __wxImagePrefetchCache?: ImagePrefetchCacheDebugHooks }).__wxImagePrefetchCache = {
    getStats: () => ({
      decodedBytes: decodedLayerImageCacheBytes,
      decodedEntries: decodedLayerImageCache.size,
      decodedLimitBytes: DECODED_IMAGE_CACHE_LIMIT_BYTES,
      objectUrlBytes: layerImageObjectUrlCacheBytes,
      objectUrlEntries: layerImageObjectUrlCache.size,
      objectUrlLimitBytes: imageObjectUrlCacheLimitBytes,
    }),
    setObjectUrlLimitBytes: (bytes: number) => {
      imageObjectUrlCacheLimitBytes = Math.max(0, Math.round(Number(bytes) || 0));
      enforceLayerImageObjectUrlBudget();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes.**
`npm run typecheck && npx playwright test -c playwright.react.config.js tests-react/image-cache-budget.spec.js --workers=1 --reporter=line`
Expected: 1 test passes (2147483648 / 4294967296). Manual verification of the override path (env vars are baked in at dev-server start, so per-test override is impossible): run `VITE_IMAGE_OBJECT_URL_CACHE_LIMIT_MB=512 VITE_DECODED_IMAGE_CACHE_LIMIT_MB=1024 npm run dev`, open the app, and confirm `window.__wxImagePrefetchCache.getStats()` reports `objectUrlLimitBytes === 536870912` and `decodedLimitBytes === 1073741824` in the browser console.

- [ ] **Step 5: Commit.**
`git add next/src/core/image-prefetch-cache.ts tests-react/image-cache-budget.spec.js && git commit -m "Set 2 GiB / 4 GiB image cache budgets with VITE_ overrides (P1.12)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 8.3: Frame chips — "loading" only while a fetch is in flight; eviction-aware loaded tracking (P1.11)

Note: the spec claim that chips "never resolve to error" is refuted — the error path already exists (use-frame-status.ts:175-176, frame-prefetch.ts:264-267) and is covered by `tests-react/smoke-react.spec.js` ("transient prefetch failures stay selectable and recover after direct frame load"). This task therefore fixes only the two real defects: (1) un-started/queued frames are mislabeled "loading" (engine emits "loading" for every incomplete hour at configure time, and the hook's fallback branch is "loading"); (2) `GLOBAL_LOADED_CACHE_KEYS` is monotonic, so chips stay "loaded" after image-cache eviction. Depends on Task 8.2 (dev hook + `let imageObjectUrlCacheLimitBytes`).

**Files:**
- Modify: `/Users/micha/Development/model-view/next/src/core/image-prefetch-cache.ts` (eviction listener registry; notify in `enforceLayerImageObjectUrlBudget` ~line 189-204 and `clearLayerImageObjectUrlCache` lines 72-80)
- Modify: `/Users/micha/Development/model-view/next/src/core/frame-prefetch.ts` (new export after line 51; `configure` lines 154-165; `pump` lines 185-215; new private method)
- Modify: `/Users/micha/Development/model-view/next/src/core/latest-run-memory-cache.ts` (drop evicted keys from `completedTaskKeys`, after line 61)
- Modify: `/Users/micha/Development/model-view/next/src/components/map-panel/use-frame-status.ts` (lines 172-179)
- Test: `/Users/micha/Development/model-view/tests-react/smoke-react.spec.js` (append lifecycle test), `/Users/micha/Development/model-view/tests-react/image-cache-budget.spec.js` (append eviction test)

**Interfaces:**
- Produces: `subscribeLayerImageObjectUrlEvictions(listener: (requestUrl: string) => void): () => void` exported from image-prefetch-cache.ts; `markFramePrefetchCacheKeyEvicted(cacheKey: string): void` exported from frame-prefetch.ts. Engine layer cache keys are `` `layer|${requestUrl}` `` (frame-prefetch.ts:416-422 and latest-run-memory-cache.ts:232) — the eviction bridge relies on this exact format.
- Consumes: `window.__wxImagePrefetchCache.setObjectUrlLimitBytes` from Task 8.2; existing `subscribeFramePrefetchCacheChanges` → `prefetchCacheRevision` re-render path (MapPanel.tsx:394-398).

- [ ] **Step 1: Write the failing tests.**

(1) Append to `/Users/micha/Development/model-view/tests-react/smoke-react.spec.js` (uses the file's existing `baseManifestFrame` and `ONE_BY_ONE_BYTES` helpers):

```js
test("frame chips stay pending until a prefetch actually starts and load after release", async ({ page }) => {
  const hours = Array.from({ length: 16 }, (_, index) => index * 3);
  let releaseAssets;
  const assetGate = new Promise((resolve) => {
    releaseAssets = resolve;
  });

  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-0600Z",
        view: "conus",
        generatedAt: "2026-02-16T06:10:00Z",
        manifestKey: "manifests/gfs/chips-lifecycle.json",
        frameCount: hours.length,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/chips-lifecycle.json**", async (route) => {
    const hourStatus = {};
    for (const hour of hours) {
      hourStatus[hour] = "loaded";
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260216-0600Z",
        view: "conus",
        generatedAt: "2026-02-16T06:10:00Z",
        referenceTime: "2026-02-16T06:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus,
        frames: hours.map((hour) =>
          baseManifestFrame({
            hour,
            validHourKey: new Date(Date.UTC(2026, 1, 16, 6 + hour)).toISOString().replace(/\.\d{3}Z$/, "Z"),
            layers: {
              temperature: {
                key: `fixtures/gfs/chips-lifecycle/temp-${String(hour).padStart(3, "0")}.png`,
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          }),
        ),
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/chips-lifecycle/**", async (route) => {
    await assetGate;
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: ONE_BY_ONE_BYTES,
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await panel
    .getByRole("button", { name: /Frames/ })
    .first()
    .click();
  const nearChip = panel.getByRole("button", { name: "000" }).first();
  const farChip = panel.getByRole("button", { name: "045" }).first();

  // Prefetch concurrency is 12 (frame-prefetch DEFAULT_CONCURRENCY): hours 000-033
  // start fetching immediately; 036-045 are queued and must NOT claim "loading".
  await expect
    .poll(async () => (await nearChip.getAttribute("class")) || "", { timeout: 5_000 })
    .toContain("bg-sky-500/20");
  const farClass = (await farChip.getAttribute("class")) || "";
  expect(farClass).not.toContain("bg-sky-500/20");
  expect(farClass).not.toContain("bg-cyan-500/20");
  expect(farClass).not.toContain("bg-rose-500/20");
  await expect(panel.getByRole("button", { name: /Frames 0\/16/ })).toBeVisible();

  releaseAssets();
  await expect(panel.getByRole("button", { name: /Frames 16\/16/ })).toBeVisible({ timeout: 15_000 });
});
```

(2) Append to `/Users/micha/Development/model-view/tests-react/image-cache-budget.spec.js` (add `const ONE_BY_ONE_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==", "base64");` below the existing `GIB` const):

```js
test("evicting cached layer images drops frame chips out of loaded", async ({ page }) => {
  await page.route("**/__cf/manifests/gfs/latest.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        model: "gfs",
        run: "20260216-1000Z",
        view: "conus",
        generatedAt: "2026-02-16T10:10:00Z",
        manifestKey: "manifests/gfs/evict-chip.json",
        frameCount: 1,
      }),
    });
  });
  await page.route("**/__cf/manifests/gfs/evict-chip.json**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 4,
        model: "gfs",
        run: "20260216-1000Z",
        view: "conus",
        generatedAt: "2026-02-16T10:10:00Z",
        referenceTime: "2026-02-16T10:00:00Z",
        openDataModel: "noaa-gfs-pgrb2-0p25",
        hourStatus: { 0: "loaded" },
        frames: [
          {
            hour: 0,
            validHourKey: "2026-02-16T10:00:00Z",
            bounds: { north: 53, south: 21, west: -129, east: -63 },
            cols: 1600,
            rows: 980,
            layers: {
              temperature: {
                key: "fixtures/gfs/evict-chip/temp.png",
                bytes: ONE_BY_ONE_BYTES.length,
                contentType: "image/png",
              },
            },
            synopticVectorKey: null,
            hoverGridKey: null,
            hoverGridSchemaVersion: null,
          },
        ],
      }),
    });
  });
  await page.route("**/__cf/fixtures/gfs/evict-chip/temp.png**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "cache-control": "no-store" },
      body: ONE_BY_ONE_BYTES,
    });
  });

  await page.goto("/");
  const panel = page.locator("article").first();
  await panel
    .getByRole("button", { name: /Frames/ })
    .first()
    .click();
  const frameChip = panel.getByRole("button", { name: "000" }).first();
  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 10_000 })
    .toContain("bg-cyan-500/20");

  // Let the background warmup pass over this run finish, so a late warmup success
  // cannot re-mark the evicted key as loaded after we shrink the budget.
  await page.waitForTimeout(1_000);

  const before = await page.evaluate(() => window.__wxImagePrefetchCache.getStats());
  expect(before.objectUrlBytes).toBeGreaterThan(0);

  await page.evaluate(() => window.__wxImagePrefetchCache.setObjectUrlLimitBytes(1));

  await expect
    .poll(async () => (await frameChip.getAttribute("class")) || "", { timeout: 5_000 })
    .not.toContain("bg-cyan-500/20");
  await expect(panel.getByRole("button", { name: /Frames 0\/1/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__wxImagePrefetchCache.getStats().objectUrlBytes)).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail.**
`npx playwright test -c playwright.react.config.js tests-react/smoke-react.spec.js tests-react/image-cache-budget.spec.js --workers=1 --reporter=line`
Expected failures: lifecycle test fails at `expect(farClass).not.toContain("bg-sky-500/20")` — today `configure()` emits "loading" for every incomplete hour, so chip 045 is sky immediately. Eviction test fails at the `.not.toContain("bg-cyan-500/20")` poll — eviction never removes keys from `GLOBAL_LOADED_CACHE_KEYS`, so the chip stays cyan. All pre-existing smoke tests must still pass at this point (they do not depend on the new behavior).

- [ ] **Step 3: Write minimal implementation.**

(3a) `/Users/micha/Development/model-view/next/src/core/image-prefetch-cache.ts` — insert after the `resolveCacheLimitBytes` function (lines 17-21):

```ts
type LayerImageEvictionListener = (requestUrl: string) => void;
const layerImageEvictionListeners = new Set<LayerImageEvictionListener>();

export function subscribeLayerImageObjectUrlEvictions(listener: LayerImageEvictionListener): () => void {
  layerImageEvictionListeners.add(listener);
  return () => {
    layerImageEvictionListeners.delete(listener);
  };
}

function notifyLayerImageObjectUrlEvicted(requestUrl: string): void {
  for (const listener of layerImageEvictionListeners) {
    listener(requestUrl);
  }
}
```

In `enforceLayerImageObjectUrlBudget`, replace:

```ts
    layerImageObjectUrlCacheBytes = Math.max(0, layerImageObjectUrlCacheBytes - oldest.bytes);
    URL.revokeObjectURL(oldest.objectUrl);
    evictDecodedLayerImage(oldestKey);
  }
}
```

with:

```ts
    layerImageObjectUrlCacheBytes = Math.max(0, layerImageObjectUrlCacheBytes - oldest.bytes);
    URL.revokeObjectURL(oldest.objectUrl);
    evictDecodedLayerImage(oldestKey);
    notifyLayerImageObjectUrlEvicted(oldestKey);
  }
}
```

Replace `clearLayerImageObjectUrlCache` (lines 72-80):

```ts
export function clearLayerImageObjectUrlCache(): void {
  for (const [, entry] of layerImageObjectUrlCache.entries()) {
    URL.revokeObjectURL(entry.objectUrl);
  }
  layerImageObjectUrlCache.clear();
  layerImageObjectUrlCacheBytes = 0;
  decodedLayerImageCache.clear();
  decodedLayerImageCacheBytes = 0;
}
```

with:

```ts
export function clearLayerImageObjectUrlCache(): void {
  const evictedKeys = Array.from(layerImageObjectUrlCache.keys());
  for (const [, entry] of layerImageObjectUrlCache.entries()) {
    URL.revokeObjectURL(entry.objectUrl);
  }
  layerImageObjectUrlCache.clear();
  layerImageObjectUrlCacheBytes = 0;
  decodedLayerImageCache.clear();
  decodedLayerImageCacheBytes = 0;
  for (const key of evictedKeys) {
    notifyLayerImageObjectUrlEvicted(key);
  }
}
```

(Decoded-only eviction intentionally does NOT notify: the object URL still serves the bytes without a network refetch, so "loaded" remains truthful.)

(3b) `/Users/micha/Development/model-view/next/src/core/frame-prefetch.ts` — extend the import block (lines 2-12) with the new subscription (image-prefetch-cache imports nothing, so no cycle):

```ts
import { subscribeLayerImageObjectUrlEvictions } from "./image-prefetch-cache";
```

Insert after `markFramePrefetchCacheKeyLoaded` (line 51):

```ts
export function markFramePrefetchCacheKeyEvicted(cacheKey: string): void {
  const key = String(cacheKey || "");
  if (!key || !GLOBAL_LOADED_CACHE_KEYS.delete(key)) {
    return;
  }
  scheduleGlobalLoadedCacheNotify();
}

// Layer cache keys are `layer|${requestUrl}` (see buildLayerCacheKey), so an object-URL
// eviction maps 1:1 onto the loaded-key set.
subscribeLayerImageObjectUrlEvictions((requestUrl) => {
  markFramePrefetchCacheKeyEvicted(`layer|${requestUrl}`);
});
```

In `configure()` replace lines 154-165:

```ts
    for (const [hour, required] of this.requiredByHour.entries()) {
      if (required <= 0) {
        this.emitStatus(hour, "loaded");
        continue;
      }
      const successful = this.successByHour.get(hour) || 0;
      if (successful >= required) {
        this.emitStatus(hour, "loaded");
      } else {
        this.emitStatus(hour, "loading");
      }
    }
```

with:

```ts
    for (const [hour, required] of this.requiredByHour.entries()) {
      if (required <= 0) {
        this.emitStatus(hour, "loaded");
        continue;
      }
      const successful = this.successByHour.get(hour) || 0;
      if (successful >= required) {
        this.emitStatus(hour, "loaded");
      }
    }
```

In `pump()` replace:

```ts
      const existingRequest = this.inFlightByUrl.get(url);
      if (existingRequest) {
        this.attachTaskToRequest(task, existingRequest);
        continue;
      }
      const request = this.createTaskRequest(task);
      this.inFlight += 1;
      this.inFlightByUrl.set(url, request);
      this.attachTaskToRequest(task, request);
```

with:

```ts
      const existingRequest = this.inFlightByUrl.get(url);
      if (existingRequest) {
        this.noteTaskFetchStarted(task);
        this.attachTaskToRequest(task, existingRequest);
        continue;
      }
      const request = this.createTaskRequest(task);
      this.inFlight += 1;
      this.inFlightByUrl.set(url, request);
      this.noteTaskFetchStarted(task);
      this.attachTaskToRequest(task, request);
```

Insert this private method between `pump()` and `createTaskRequest()`:

```ts
  // "loading" is only emitted once a fetch is actually in flight for the hour;
  // queued tasks leave the hour in its prior (pending) state.
  private noteTaskFetchStarted(task: PrefetchTask): void {
    if (!task.affectsStatus || task.revision !== this.planRevision || this.failedHours.has(task.frame.hour)) {
      return;
    }
    this.emitStatus(task.frame.hour, "loading");
  }
```

(3c) `/Users/micha/Development/model-view/next/src/components/map-panel/use-frame-status.ts` — replace lines 172-179:

```ts
    const cachedStatus = getCachedFramePrefetchState(frameEntry, activeLayers, reflectivityGate, synopticDetailMode);
    if (prefetchByHour[hour] === "loaded" || cachedStatus === "loaded") {
      out[hour] = "loaded";
    } else if (prefetchByHour[hour] === "error") {
      out[hour] = "error";
    } else {
      out[hour] = "loading";
    }
```

with:

```ts
    const cachedStatus = getCachedFramePrefetchState(frameEntry, activeLayers, reflectivityGate, synopticDetailMode);
    // Cache state wins over engine history so evicted frames drop back out of "loaded".
    if (cachedStatus === "loaded") {
      out[hour] = "loaded";
    } else if (prefetchByHour[hour] === "error") {
      out[hour] = "error";
    } else if (prefetchByHour[hour] === "loading") {
      out[hour] = "loading";
    } else {
      out[hour] = "pending";
    }
```

(This is safe: the engine only emits "loaded" after `markFramePrefetchCacheKeyLoaded` has run for every required task, so `cachedStatus === "loaded"` whenever the engine reported loaded — dropping the `prefetchByHour[hour] === "loaded"` shortcut changes nothing except after eviction.)

(3d) `/Users/micha/Development/model-view/next/src/core/latest-run-memory-cache.ts` — add to the import block:

```ts
import { subscribeLayerImageObjectUrlEvictions } from "./image-prefetch-cache";
```

and insert after `let inFlight = 0;` (line 61):

```ts
subscribeLayerImageObjectUrlEvictions((requestUrl) => {
  completedTaskKeys.delete(`layer|${requestUrl}`);
});
```

- [ ] **Step 4: Run tests to verify they pass.**
`npm run typecheck && npx playwright test -c playwright.react.config.js tests-react/smoke-react.spec.js tests-react/image-cache-budget.spec.js tests-react/latest-run-memory-cache.spec.js tests-react/display-menu.spec.js --workers=1 --reporter=line`
Expected: everything green, including the pre-existing chip tests ("frame status reaches loaded after visual assets even while hover is pending", "transient prefetch failures...", "layer deselect/reselect...", "model switch does not inherit stale error...") — each was traced against the new emission rules: in-flight gated fetches still show sky, 503s still show rose, direct overlay loads still recover to cyan via `markFrameLayerLoaded`.

- [ ] **Step 5: Commit.**
`git add next/src/core/image-prefetch-cache.ts next/src/core/frame-prefetch.ts next/src/core/latest-run-memory-cache.ts next/src/components/map-panel/use-frame-status.ts tests-react/smoke-react.spec.js tests-react/image-cache-budget.spec.js && git commit -m "Frame chips: loading only while in flight, eviction-aware loaded tracking (P1.11)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 8.4: Scope latest-run memory warmup to the panels' active layer selections (P1.12, warmup half)

Depends on Tasks 1-3. Models stay fully covered (instant model switching is the point of the warmup); the layers × gates × modes cross-product collapses to the panels' active layers, the current reflectivity gate, and the current synoptic detail mode. Hover grids stay warmed unconditionally (they power the hover readout for any layer, matching the prefetch engine).

**Files:**
- Modify: `/Users/micha/Development/model-view/next/src/core/latest-run-memory-cache.ts` (plan interfaces lines 25-36; consts lines 52-54; `startLatestRunMemoryWarmup` lines 63-82; `warmLatestViewMemoryCache` lines 84-110; `buildWarmupTasks` lines 165-211; `buildWarmupKey` lines 271-284)
- Modify: `/Users/micha/Development/model-view/next/src/hooks/useLatestViewWarmup.ts` (full file, 59 lines)
- Modify: `/Users/micha/Development/model-view/next/src/App.tsx` (line 14 type import; lines 109-115 hook call)
- Modify: `/Users/micha/Development/model-view/next/src/components/MapPanel.tsx` (lines 486-499 warmup effect)
- Test: `/Users/micha/Development/model-view/tests-react/latest-run-memory-cache.spec.js` (rewrite)

**Interfaces:**
- Produces: `LatestRunWarmupPlan` and `LatestViewWarmupPlan` gain required fields `activeLayers: Iterable<LayerKey>`, `reflectivityGate: ReflectivityGateDbz`, `synopticDetailMode: SynopticDetailMode`. `useLatestViewWarmup` options gain `activeLayers: LayerKey[]`, `reflectivityGate`, `synopticDetailMode`.
- Consumes: `LAYER_STACK_ORDER` import is removed from latest-run-memory-cache.ts (Task 8.1 made it snow-complete, but warmup no longer iterates it); warmup/task cache keys keep the exact `layer|${url}` / `vector|${url}` / `hover|${urls}` formats shared with frame-prefetch.ts.

- [ ] **Step 1: Write the failing test.** Replace the full contents of `/Users/micha/Development/model-view/tests-react/latest-run-memory-cache.spec.js` with:

```js
const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";
const ONE_BY_ONE_BYTES = Buffer.from(ONE_BY_ONE.split(",")[1], "base64");
const MODELS = ["gfs", "nam", "nam3km", "hrrr"];

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

function frame(model, hour) {
  const padded = String(hour).padStart(3, "0");
  return {
    hour,
    validHourKey: `2026-04-23T${String(12 + hour / 3).padStart(2, "0")}:00:00Z`,
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    cols: 1600,
    rows: 980,
    layers: {
      temperature: {
        key: `fixtures/${model}/full-memory-cache/${padded}/temperature.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
      wind: {
        key: `fixtures/${model}/full-memory-cache/${padded}/wind.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
      precip: {
        key: `fixtures/${model}/full-memory-cache/${padded}/precip.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
      snow10to1: {
        key: `fixtures/${model}/full-memory-cache/${padded}/snow10to1.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
      synoptic: {
        key: `fixtures/${model}/full-memory-cache/${padded}/synoptic.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
    },
    reflectivityVariants: {
      dbz15: {
        key: `fixtures/${model}/full-memory-cache/${padded}/reflectivity-15.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
      dbz20: {
        key: `fixtures/${model}/full-memory-cache/${padded}/reflectivity-20.png`,
        bytes: ONE_BY_ONE_BYTES.length,
        contentType: "image/png",
      },
    },
    synopticVectorKeys: {
      simple: `fixtures/${model}/full-memory-cache/${padded}/synoptic-simple.json`,
      detailed: `fixtures/${model}/full-memory-cache/${padded}/synoptic-detailed.json`,
    },
    synopticStyleVersions: {
      simple: "v4-operational-contrast",
      detailed: "v4-operational-contrast",
    },
    hoverGridKey: `fixtures/${model}/full-memory-cache/${padded}/hover-grid.json.gz`,
    hoverGridSchemaVersion: 1,
  };
}

async function routeWarmupFixtures(page) {
  const fixtureRequests = new Set();
  const fixtureRequestCounts = new Map();

  for (const model of MODELS) {
    await page.route(`**/__cf/manifests/${model}/latest.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          model,
          run: "20260423-1200Z",
          view: "conus",
          generatedAt: "2026-04-23T12:10:00Z",
          manifestKey: `manifests/${model}/full-memory-cache.json`,
          frameCount: 2,
        }),
      });
    });
    await page.route(`**/__cf/manifests/${model}/full-memory-cache.json**`, async (route) => {
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
          frames: [frame(model, 0), frame(model, 3)],
        }),
      });
    });
  }
  await page.route("**/__cf/fixtures/**/full-memory-cache/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    fixtureRequests.add(pathname);
    fixtureRequestCounts.set(pathname, (fixtureRequestCounts.get(pathname) || 0) + 1);
    if (pathname.includes("hover-grid")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildHoverGridPayload()),
      });
      return;
    }
    if (pathname.endsWith(".json")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          styleVersion: "v4-operational-contrast",
          isobars: { lines: [], labels: [] },
          thickness: { lines: [], labels: [] },
          centers: { highs: [], lows: [] },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: ONE_BY_ONE_BYTES,
    });
  });

  return { fixtureRequests, fixtureRequestCounts };
}

function expectedFixturePaths() {
  // Warmup is scoped to the panels' active layers (temperature + synoptic by default),
  // the current gate, and the current synoptic detail mode — not the full cross-product.
  const paths = [];
  for (const model of MODELS) {
    for (const hour of [0, 3]) {
      const padded = String(hour).padStart(3, "0");
      for (const name of ["temperature.png", "synoptic.png", "synoptic-simple.json", "hover-grid.json.gz"]) {
        paths.push(`/__cf/fixtures/${model}/full-memory-cache/${padded}/${name}`);
      }
    }
  }
  return paths.sort();
}

test("latest view memory warmup covers active layers on every model and makes model switching instant", async ({
  page,
}) => {
  const { fixtureRequests, fixtureRequestCounts } = await routeWarmupFixtures(page);

  await page.goto("/");
  await expect(page.locator("article").first().getByText("Ready")).toBeVisible();

  await expect.poll(() => Array.from(fixtureRequests).sort(), { timeout: 10_000 }).toEqual(expectedFixturePaths());

  const panel = page.locator("article").first();
  const hrrrTemperaturePath = "/__cf/fixtures/hrrr/full-memory-cache/000/temperature.png";
  const hrrrTemperatureHitsBeforeSwitch = fixtureRequestCounts.get(hrrrTemperaturePath) || 0;
  await panel.locator("select").first().selectOption("hrrr");
  await expect(panel.getByRole("button", { name: /Frames 2\/2/ }).first()).toBeVisible({ timeout: 1_000 });
  await expect(page.getByText("Loaded 2/2")).toBeVisible({ timeout: 1_000 });
  await page.waitForTimeout(300);
  expect(fixtureRequestCounts.get(hrrrTemperaturePath)).toBe(hrrrTemperatureHitsBeforeSwitch);
});

test("selecting a snow layer warms it across every model", async ({ page }) => {
  const { fixtureRequests } = await routeWarmupFixtures(page);

  await page.goto("/");
  const panel = page.locator("article").first();
  await expect(panel.getByText("Ready")).toBeVisible();
  await expect.poll(() => Array.from(fixtureRequests).sort(), { timeout: 10_000 }).toEqual(expectedFixturePaths());

  await panel.getByRole("button", { name: /Parameters/ }).click();
  const snowCheckbox = panel.getByRole("checkbox", { name: /10:1 Snow/ });
  await snowCheckbox.focus();
  await page.keyboard.press("Space");
  await expect(snowCheckbox).toBeChecked();

  const expectedSnowPaths = [];
  for (const model of MODELS) {
    for (const hour of [0, 3]) {
      expectedSnowPaths.push(
        `/__cf/fixtures/${model}/full-memory-cache/${String(hour).padStart(3, "0")}/snow10to1.png`,
      );
    }
  }
  await expect
    .poll(() => expectedSnowPaths.filter((path) => fixtureRequests.has(path)).length, { timeout: 10_000 })
    .toBe(expectedSnowPaths.length);
});
```

- [ ] **Step 2: Run test to verify it fails.**
`npx playwright test -c playwright.react.config.js tests-react/latest-run-memory-cache.spec.js --workers=1 --reporter=line`
Expected: test 1 fails at the set-equality poll — the unscoped warmup also fetches `wind.png`, `precip.png`, `snow10to1.png` (post Task 8.1), `reflectivity-15.png`, `reflectivity-20.png`, and `synoptic-detailed.json`, so the observed set is a strict superset. (Test 2 may pass pre-change because the unscoped warmup fetches snow indiscriminately; test 1 is the discriminator for scoping.)

- [ ] **Step 3: Write minimal implementation.**

(3a) `/Users/micha/Development/model-view/next/src/core/latest-run-memory-cache.ts`:

Remove the now-unused import on line 1: `import { LAYER_STACK_ORDER } from "../config/layers";` (keep everything else; `MODEL_KEYS` stays).

Replace the plan interfaces (lines 25-36):

```ts
interface LatestRunWarmupPlan {
  modelKey: ModelKey;
  viewKey: ViewKey;
  manifest: ModelManifest;
  anchorHour: number;
}

interface LatestViewWarmupPlan {
  viewKey: ViewKey;
  anchorValidTimeIso?: string | null;
  forceRefresh?: boolean;
}
```

with:

```ts
interface LatestRunWarmupPlan {
  modelKey: ModelKey;
  viewKey: ViewKey;
  manifest: ModelManifest;
  anchorHour: number;
  activeLayers: Iterable<LayerKey>;
  reflectivityGate: ReflectivityGateDbz;
  synopticDetailMode: SynopticDetailMode;
}

interface LatestViewWarmupPlan {
  viewKey: ViewKey;
  anchorValidTimeIso?: string | null;
  forceRefresh?: boolean;
  activeLayers: Iterable<LayerKey>;
  reflectivityGate: ReflectivityGateDbz;
  synopticDetailMode: SynopticDetailMode;
}
```

Delete lines 53-54:

```ts
const REFLECTIVITY_GATES: ReflectivityGateDbz[] = [10, 15, 20];
const SYNOPTIC_DETAIL_MODES: SynopticDetailMode[] = ["simple", "detailed"];
```

In `startLatestRunMemoryWarmup`, replace:

```ts
  const warmupKey = buildWarmupKey(plan);
  if (!warmupKey || startedWarmupKeys.has(warmupKey)) {
    return;
  }
  startedWarmupKeys.add(warmupKey);
  const tasks = buildWarmupTasks(plan);
```

with:

```ts
  const activeLayers = new Set<LayerKey>(plan.activeLayers);
  const warmupKey = buildWarmupKey(plan, activeLayers);
  if (!warmupKey || startedWarmupKeys.has(warmupKey)) {
    return;
  }
  startedWarmupKeys.add(warmupKey);
  const tasks = buildWarmupTasks(plan, activeLayers);
```

In `warmLatestViewMemoryCache`, replace:

```ts
        startLatestRunMemoryWarmup({
          modelKey,
          viewKey: plan.viewKey,
          manifest,
          anchorHour,
        });
```

with:

```ts
        startLatestRunMemoryWarmup({
          modelKey,
          viewKey: plan.viewKey,
          manifest,
          anchorHour,
          activeLayers: plan.activeLayers,
          reflectivityGate: plan.reflectivityGate,
          synopticDetailMode: plan.synopticDetailMode,
        });
```

Replace `buildWarmupTasks` (lines 165-211) entirely with:

```ts
function buildWarmupTasks(plan: LatestRunWarmupPlan, activeLayers: ReadonlySet<LayerKey>): MemoryWarmupTask[] {
  const frames = [...(plan.manifest.frames || [])].sort((left, right) => left.hour - right.hour);
  const tasks: MemoryWarmupTask[] = [];
  for (const frame of frames) {
    const priority = Math.abs(frame.hour - plan.anchorHour);

    for (const layer of activeLayers) {
      if (isReflectivityLayer(layer)) {
        appendLayerTask(tasks, frame, layer, priority, plan.reflectivityGate);
        continue;
      }
      appendLayerTask(tasks, frame, layer, priority);
    }

    if (activeLayers.has("synoptic")) {
      const mode = plan.synopticDetailMode;
      const vectorKey = String(resolveSynopticVectorKey(frame, mode) || "").trim();
      const vectorUrl = String(resolveSynopticVectorRequestUrl(frame, mode) || "").trim();
      if (vectorKey && vectorUrl) {
        tasks.push({
          kind: "vector",
          frame,
          synopticDetailMode: mode,
          urlKey: `vector:${vectorUrl}`,
          taskKey: `vector|${frame.hour}|${mode}|${vectorUrl}`,
          cacheKey: `vector|${vectorUrl}`,
          priority,
        });
      }
    }

    const hoverKey = resolveHoverGridRequestUrls(frame).join("|");
    if (hoverKey) {
      tasks.push({
        kind: "hover",
        frame,
        urlKey: `hover:${hoverKey}`,
        taskKey: `hover|${frame.hour}|${hoverKey}`,
        cacheKey: `hover|${hoverKey}`,
        priority,
      });
    }
  }
  return dedupeWarmupTasks(tasks).sort(compareWarmupTasks);
}
```

Replace `buildWarmupKey` (lines 271-284) with:

```ts
function buildWarmupKey(plan: LatestRunWarmupPlan, activeLayers: ReadonlySet<LayerKey>): string {
  const run = String(plan.manifest.run || "").trim();
  const layersKey = Array.from(activeLayers).sort().join(",");
  if (!run || !plan.manifest.frames?.length || !layersKey) {
    return "";
  }
  return [
    plan.modelKey,
    plan.viewKey,
    run,
    plan.manifest.generatedAt || "",
    String(plan.manifest.frames.length),
    layersKey,
    `g${plan.reflectivityGate}`,
    plan.synopticDetailMode,
    "active-layers-v1",
  ].join("|");
}
```

(3b) Replace the full contents of `/Users/micha/Development/model-view/next/src/hooks/useLatestViewWarmup.ts` with:

```ts
import { useEffect, useMemo } from "react";
import { warmLatestViewMemoryCache } from "../core/latest-run-memory-cache";
import type {
  LayerKey,
  ManifestUiInfo,
  PanelState,
  ReflectivityGateDbz,
  SynopticDetailMode,
  ValidTimeIso,
  ViewKey,
} from "../types";

interface LatestViewWarmupOptions {
  activeLayers: LayerKey[];
  anchorValidTimeIso: ValidTimeIso | null;
  manifestInfoByPanel: Record<string, ManifestUiInfo>;
  panels: PanelState[];
  reflectivityGate: ReflectivityGateDbz;
  resolvePanelSelectedValidTime: (panelId: string) => ValidTimeIso | null;
  synopticDetailMode: SynopticDetailMode;
  viewKey: ViewKey;
}

export function useLatestViewWarmup({
  activeLayers,
  anchorValidTimeIso,
  manifestInfoByPanel,
  panels,
  reflectivityGate,
  resolvePanelSelectedValidTime,
  synopticDetailMode,
  viewKey,
}: LatestViewWarmupOptions): boolean {
  const ready = useMemo(() => {
    for (const panel of panels) {
      const selected = resolvePanelSelectedValidTime(panel.id);
      if (!selected) {
        continue;
      }
      const status = manifestInfoByPanel[panel.id]?.frameStatusByValidTime?.[selected];
      if (status === "loaded") {
        return true;
      }
    }
    return false;
  }, [manifestInfoByPanel, panels, resolvePanelSelectedValidTime]);

  useEffect(() => {
    if (!ready || activeLayers.length === 0) {
      return;
    }
    let cancelled = false;
    const warm = (forceRefresh: boolean) => {
      void warmLatestViewMemoryCache({
        viewKey,
        anchorValidTimeIso,
        forceRefresh,
        activeLayers,
        reflectivityGate,
        synopticDetailMode,
      }).catch(() => {
        if (cancelled) {
          return;
        }
      });
    };
    warm(false);
    const intervalId = window.setInterval(() => warm(true), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeLayers, anchorValidTimeIso, ready, reflectivityGate, synopticDetailMode, viewKey]);

  return ready;
}
```

(3c) `/Users/micha/Development/model-view/next/src/App.tsx` — change line 14:

```ts
import type { ModelKey, ReflectivityGateDbz, SynopticDetailMode, ViewKey } from "./types";
```

to:

```ts
import type { LayerKey, ModelKey, ReflectivityGateDbz, SynopticDetailMode, ViewKey } from "./types";
```

and replace the hook call (lines 109-115):

```ts
  useLatestViewWarmup({
    anchorValidTimeIso: latestViewWarmupAnchorValidTimeIso,
    manifestInfoByPanel,
    panels,
    resolvePanelSelectedValidTime,
    viewKey,
  });
```

with:

```ts
  const warmupActiveLayers = useMemo(() => {
    const keys = new Set<LayerKey>();
    for (const panel of panels) {
      for (const layer of panel.layers) {
        keys.add(layer);
      }
    }
    if (showIsobars || showThickness || showCenters) {
      keys.add("synoptic");
    }
    return Array.from(keys).sort();
  }, [panels, showCenters, showIsobars, showThickness]);

  useLatestViewWarmup({
    activeLayers: warmupActiveLayers,
    anchorValidTimeIso: latestViewWarmupAnchorValidTimeIso,
    manifestInfoByPanel,
    panels,
    reflectivityGate,
    resolvePanelSelectedValidTime,
    synopticDetailMode,
    viewKey,
  });
```

(3d) `/Users/micha/Development/model-view/next/src/components/MapPanel.tsx` — replace the warmup effect (lines 486-499):

```ts
  useEffect(() => {
    if (!manifestState.manifest || !frame || selectedBrowserFrameStatus !== "loaded") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      startLatestRunMemoryWarmup({
        modelKey: panel.modelKey,
        viewKey,
        manifest: manifestState.manifest as NonNullable<typeof manifestState.manifest>,
        anchorHour: frame.hour,
      });
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [frame, frame?.hour, manifestState.manifest, panel.modelKey, selectedBrowserFrameStatus, viewKey]);
```

with:

```ts
  useEffect(() => {
    if (!manifestState.manifest || !frame || selectedBrowserFrameStatus !== "loaded") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      startLatestRunMemoryWarmup({
        modelKey: panel.modelKey,
        viewKey,
        manifest: manifestState.manifest as NonNullable<typeof manifestState.manifest>,
        anchorHour: frame.hour,
        activeLayers,
        reflectivityGate,
        synopticDetailMode,
      });
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [
    activeLayers,
    frame,
    frame?.hour,
    manifestState.manifest,
    panel.modelKey,
    reflectivityGate,
    selectedBrowserFrameStatus,
    synopticDetailMode,
    viewKey,
  ]);
```

- [ ] **Step 4: Run tests to verify they pass, then run the full react suite.**
`npm run typecheck && npx playwright test -c playwright.react.config.js tests-react/latest-run-memory-cache.spec.js --workers=1 --reporter=line`
Expected: both tests pass — the default warm set is exactly temperature/synoptic/simple-vector/hover across all 4 models, model switching stays instant, and selecting 10:1 Snow warms `snow10to1.png` on all 4 models (this end-to-end proves the P1.8 + P1.12 combination: snow keys are valid layer keys AND warmup follows selection).
Then the whole suite and lint (spec-approved output change is fetch traffic only; no `scripts/**` file is touched, so renderer artifact byte-parity is unaffected — confirm with `git status --short scripts/ shared/` showing no changes):
`npx playwright test -c playwright.react.config.js --workers=1 --reporter=line`
`npm run lint -- --quiet`
`npx prettier --check next/src/core/latest-run-memory-cache.ts next/src/core/frame-prefetch.ts next/src/core/image-prefetch-cache.ts next/src/hooks/useLatestViewWarmup.ts next/src/components/map-panel/use-frame-status.ts tests-react/latest-run-memory-cache.spec.js tests-react/image-cache-budget.spec.js`
(Do NOT run prettier --check on `next/src/config/layers.ts`, `App.tsx`, `MapPanel.tsx`, or `PanelChrome.tsx` as a gate — layers.ts/PanelChrome.tsx have pre-existing format:check failures that Phase 4 item 2 fixes; just keep the new hunks formatted like their surroundings.)

- [ ] **Step 5: Commit.**
`git add next/src/core/latest-run-memory-cache.ts next/src/hooks/useLatestViewWarmup.ts next/src/App.tsx next/src/components/MapPanel.tsx tests-react/latest-run-memory-cache.spec.js && git commit -m "Scope latest-run memory warmup to active panel layers, gate, and detail mode (P1.12)" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`


## Section 9: Medium fixes: hover flicker, env unification, CLI guard, CI gating, settings drawer (spec P1.14–P1.18)

## Cluster prerequisites (Tasks 1 and 5 only)

Playwright specs run against the fixture cache. One-time setup: `npm run install:browsers`. The webServer command in playwright.react.config.js auto-runs `scripts/prepare-react-fixture-cache.js test-results/react-cache`, so no separate fixture prep command is needed — but make sure no stray dev server is already listening on port 5173 (the config reuses an existing server locally, which could serve a non-fixture cache root).

None of the tasks in this cluster touch renderer artifact output; the golden-frame byte-parity protocol is not implicated (no P1.6/P1.10-style output-change verification needed).

### Task 9.1: Hover readout flicker — make the hover card click-through (P1.14)
**Files:**
- Create: /Users/micha/Development/model-view/tests-react/hover-card.spec.js
- Modify: /Users/micha/Development/model-view/next/src/components/MapPanel.tsx (line 543)

**Interfaces:** Consumes: `map.on("mousemove"/"mouseout")` wiring in next/src/components/map-panel/use-leaflet-map.ts:88-98 (unchanged — do NOT touch that file; with the card click-through, mouseout only fires when the cursor truly leaves the map, which is the desired hover-clear behavior). Produces: no new exports; visual behavior only.

Background: the hover card at MapPanel.tsx:543 sets `pointer-events-auto` inside a `pointer-events-none` wrapper (lines 536-539). The card is a sibling overlay of the Leaflet container, so entering the card fires the map's `mouseout`, which clears `hoverLatLng` and unmounts the card; the next mousemove remounts it — a mount/unmount oscillation. The card contains only static text (`formatCoordinate` line and `HoverLine` <p> rows, MapPanel.tsx:855-862) — nothing interactive — so removing the pointer-events opt-in is safe and lets mouse events pass through to the map (hover values keep updating under the card; mouseout never fires while over it).

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-react/hover-card.spec.js`:

```js
const { test, expect } = require("@playwright/test");

test("hover readout card stays mounted when the cursor moves onto it", async ({ page }) => {
  await page.goto("/");
  const panel = page.locator("article").first();
  const map = panel.locator(".leaflet-container").first();
  await expect(map).toBeVisible();
  const mapBox = await map.boundingBox();
  if (!mapBox) {
    throw new Error("Map container bounding box is unavailable.");
  }

  await page.mouse.move(mapBox.x + mapBox.width * 0.5, mapBox.y + mapBox.height * 0.5);
  const coordLine = panel
    .locator("p")
    .filter({ hasText: /°[NS]\s+\d+(?:\.\d+)?°[EW]/ })
    .first();
  await expect(coordLine).toBeVisible();
  const card = coordLine.locator("xpath=..");
  const cardBox = await card.boundingBox();
  if (!cardBox) {
    throw new Error("Hover card bounding box is unavailable.");
  }

  // Moving the cursor onto the card must not unmount it: with pointer events
  // disabled the map underneath keeps receiving mousemove and never fires mouseout.
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2, { steps: 5 });
  await page.waitForTimeout(300);
  await expect(coordLine).toBeVisible();
  await expect(card).toHaveCSS("pointer-events", "none");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test -c playwright.react.config.js tests-react/hover-card.spec.js --workers=1 --reporter=line
```

Expected: 1 failed. Entering the card fires the map mouseout, `hoverLatLng` goes null, and the card unmounts, so the second `expect(coordLine).toBeVisible()` typically times out. Note: Chromium's hover recompute can dispatch a synthetic mousemove after the unmount (re-mounting the card under the stationary cursor), so the visibility assertion may occasionally pass pre-fix — in that case the final `toHaveCSS("pointer-events", "none")` assertion fails instead (the card's computed value is `auto` pre-fix). Either way the test fails before the fix; do not weaken the toHaveCSS assertion.

- [ ] **Step 3: Write minimal implementation**

In `/Users/micha/Development/model-view/next/src/components/MapPanel.tsx` line 543, replace:

```tsx
            <div className="pointer-events-auto min-w-[170px] rounded-lg glass-panel px-3 py-2 text-[11px] text-slate-100 shadow-xl">
```

with:

```tsx
            <div className="min-w-[170px] rounded-lg glass-panel px-3 py-2 text-[11px] text-slate-100 shadow-xl">
```

(The card now inherits `pointer-events-none` from its wrapper at line 537 — pointer-events is an inherited CSS property. Do not touch the `pointer-events-auto` on `LegendCard` at line 683 — that is a different element and out of scope.)

- [ ] **Step 4: Run test to verify it passes**

```
npx playwright test -c playwright.react.config.js tests-react/hover-card.spec.js --workers=1 --reporter=line
npm run typecheck
npx prettier --check next/src/components/MapPanel.tsx tests-react/hover-card.spec.js
```

Expected: `1 passed`; typecheck clean; format:check clean.

- [ ] **Step 5: Commit**

```
git add next/src/components/MapPanel.tsx tests-react/hover-card.spec.js && git commit -m "Fix hover readout flicker by making the hover card click-through" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 9.2: Canonical MODELVIEW_CACHE_ROOT everywhere; local-dev loads .env (P1.15)
**Files:**
- Create: /Users/micha/Development/model-view/scripts/lib/env-config.js
- Create: /Users/micha/Development/model-view/tests-node/env-config.test.js
- Modify: /Users/micha/Development/model-view/scripts/build-noaa-beta-artifacts.js (require block after line 46; cache-root resolution lines 83-85; delete duplicated loadDotEnv lines 772-795)
- Modify: /Users/micha/Development/model-view/scripts/local-data-server.js (requires lines 5-7; cache-root line 16; delete duplicated loadDotEnv lines 74-97)
- Modify: /Users/micha/Development/model-view/scripts/local-dev.js (requires lines 5-6; top of main() line 11)

**Interfaces:** Produces `scripts/lib/env-config.js` exporting:
- `loadDotEnv(filePath, env = process.env): void` — parses KEY=VALUE lines, skips comments/blanks, strips matching quotes, never overrides keys already present in `env` (byte-for-byte the behavior of the two private copies it replaces).
- `resolveCacheRootEnv(env = process.env, { warn = console.warn } = {}): string | undefined` — returns `MODELVIEW_CACHE_ROOT` if set (trimmed, non-empty); else returns `MODELVIEW_NOAA_BETA_CACHE_ROOT` with a one-line deprecation warning; else `undefined` (callers apply their own defaults).
Phase 2's `noaa:update`/`cache:prune` and Phase 4's `.env.example` rewrite should consume these same exports.

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-node/env-config.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { loadDotEnv, resolveCacheRootEnv } = require("../scripts/lib/env-config");

test("resolveCacheRootEnv prefers the canonical MODELVIEW_CACHE_ROOT without warning", () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(
    resolveCacheRootEnv({ MODELVIEW_CACHE_ROOT: "canonical", MODELVIEW_NOAA_BETA_CACHE_ROOT: "legacy" }, { warn }),
    "canonical",
  );
  assert.deepEqual(warnings, []);
});

test("resolveCacheRootEnv accepts the deprecated alias with a warning", () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(resolveCacheRootEnv({ MODELVIEW_NOAA_BETA_CACHE_ROOT: "legacy" }, { warn }), "legacy");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /MODELVIEW_NOAA_BETA_CACHE_ROOT is deprecated/);
});

test("resolveCacheRootEnv returns undefined when neither variable is set", () => {
  const warnings = [];
  assert.equal(resolveCacheRootEnv({}, { warn: (message) => warnings.push(message) }), undefined);
  assert.deepEqual(warnings, []);
});

test("loadDotEnv parses quotes, skips comments, and never overrides existing keys", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-env-"));
  const envPath = path.join(dir, ".env");
  await fs.promises.writeFile(
    envPath,
    ["# comment", "", "MODELVIEW_CACHE_ROOT=output/from-dotenv", 'QUOTED="hello world"', "EXISTING=from-dotenv"].join(
      "\n",
    ),
  );
  const env = { EXISTING: "from-process" };
  loadDotEnv(envPath, env);
  assert.equal(env.MODELVIEW_CACHE_ROOT, "output/from-dotenv");
  assert.equal(env.QUOTED, "hello world");
  assert.equal(env.EXISTING, "from-process");
  loadDotEnv(path.join(dir, "missing.env"), env);
  assert.equal(env.MODELVIEW_CACHE_ROOT, "output/from-dotenv");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests-node/env-config.test.js
```

Expected: the run fails immediately with `Cannot find module '../scripts/lib/env-config'`.

- [ ] **Step 3: Write minimal implementation**

3a. Create `/Users/micha/Development/model-view/scripts/lib/env-config.js`:

```js
"use strict";

const fs = require("fs");

// Shared .env loader: never overrides variables already present in env,
// matching the historical behavior of the per-script copies it replaces.
function loadDotEnv(filePath, env = process.env) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in env)) {
      env[key] = value;
    }
  }
}

function resolveCacheRootEnv(env = process.env, { warn = console.warn } = {}) {
  const canonical = String(env.MODELVIEW_CACHE_ROOT || "").trim();
  if (canonical) {
    return canonical;
  }
  const alias = String(env.MODELVIEW_NOAA_BETA_CACHE_ROOT || "").trim();
  if (alias) {
    warn("[modelview] MODELVIEW_NOAA_BETA_CACHE_ROOT is deprecated; set MODELVIEW_CACHE_ROOT instead.");
    return alias;
  }
  return undefined;
}

module.exports = {
  loadDotEnv,
  resolveCacheRootEnv,
};
```

3b. In `/Users/micha/Development/model-view/scripts/build-noaa-beta-artifacts.js`, after the run-resolution require block (line 46), replace:

```js
} = require("./lib/noaa-build/run-resolution");

const ROOT_DIR = path.resolve(__dirname, "..");
```

with:

```js
} = require("./lib/noaa-build/run-resolution");
const { loadDotEnv, resolveCacheRootEnv } = require("./lib/env-config");

const ROOT_DIR = path.resolve(__dirname, "..");
```

Then replace the cache-root resolution (lines 83-85):

```js
  const cacheRoot = path.resolve(
    String(args["cache-root"] || process.env.MODELVIEW_NOAA_BETA_CACHE_ROOT || DEFAULT_CACHE_ROOT),
  );
```

with:

```js
  const cacheRoot = path.resolve(String(args["cache-root"] || resolveCacheRootEnv() || DEFAULT_CACHE_ROOT));
```

Then delete the now-duplicated private loader (lines 772-795) — remove this entire function (the `loadDotEnv` name now resolves to the shared require; keep the `loadDotEnv(path.join(ROOT_DIR, ".env"));` call at line 55 as is):

```js
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
```

(`fs` stays required in this file — `defaultWgrib2Path` at line 740 uses it.)

3c. In `/Users/micha/Development/model-view/scripts/local-data-server.js`, replace the requires (lines 5-7):

```js
const fs = require("fs");
const path = require("path");
const { createLocalArtifactServer } = require("./lib/local-artifact-server");
```

with:

```js
const path = require("path");
const { loadDotEnv, resolveCacheRootEnv } = require("./lib/env-config");
const { createLocalArtifactServer } = require("./lib/local-artifact-server");
```

Replace line 16:

```js
  const cacheRoot = args["cache-root"] || process.env.MODELVIEW_CACHE_ROOT || undefined;
```

with:

```js
  const cacheRoot = args["cache-root"] || resolveCacheRootEnv() || undefined;
```

And delete the private `function loadDotEnv(filePath) { ... }` (lines 74-97 — identical text to the block quoted in 3b). `fs` was only used by that function in this file, which is why its require is removed.

3d. In `/Users/micha/Development/model-view/scripts/local-dev.js`, replace (lines 5-11):

```js
const path = require("path");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");

async function main() {
  const viteArgs = process.argv.slice(2);
```

with:

```js
const path = require("path");
const { spawn } = require("child_process");
const { loadDotEnv } = require("./lib/env-config");

const ROOT_DIR = path.resolve(__dirname, "..");

async function main() {
  loadDotEnv(path.join(ROOT_DIR, ".env"));
  const viteArgs = process.argv.slice(2);
```

(The spawned data server inherits `process.env` and its own loadDotEnv never overrides existing keys, so parent and child now agree on MODELVIEW_DATA_PORT/HOST and cache root.)

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests-node/env-config.test.js
node --check scripts/build-noaa-beta-artifacts.js && node --check scripts/local-data-server.js && node --check scripts/local-dev.js
node -e "process.env.MODELVIEW_NOAA_BETA_CACHE_ROOT='/tmp/legacy-root'; const { resolveCacheRootEnv } = require('./scripts/lib/env-config'); console.log(resolveCacheRootEnv());"
npx eslint scripts/lib/env-config.js scripts/local-dev.js scripts/local-data-server.js scripts/build-noaa-beta-artifacts.js --quiet
npx prettier --check scripts/lib/env-config.js scripts/local-dev.js scripts/local-data-server.js scripts/build-noaa-beta-artifacts.js tests-node/env-config.test.js
```

Expected: 4 tests pass; syntax checks pass; the `node -e` prints the deprecation warning line then `/tmp/legacy-root`; eslint and format:check clean. (Optional manual check: create a throwaway `.env` with `MODELVIEW_DATA_PORT=5175`, run `npm run dev`, confirm both the data server and the vite `/__cf` proxy use 5175, then delete the throwaway `.env` — no repo `.env` exists today.)

- [ ] **Step 5: Commit**

```
git add scripts/lib/env-config.js scripts/build-noaa-beta-artifacts.js scripts/local-data-server.js scripts/local-dev.js tests-node/env-config.test.js && git commit -m "Unify cache-root env on MODELVIEW_CACHE_ROOT with deprecated alias; load .env in local-dev" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 9.3: Error on --date without --cycle instead of silently rendering 00Z (P1.16)
**Files:**
- Modify: /Users/micha/Development/model-view/scripts/lib/noaa-build/run-resolution.js (lines 145-150, inside `resolveNoaaModelRun`)
- Test: /Users/micha/Development/model-view/tests-node/noaa-beta.test.js (add one test after the "NOAA automatic run resolver can select latest and previous available runs" test, which ends at line 3443)

**Interfaces:** Consumes/produces `resolveNoaaModelRun({ modelKey, noaaBaseUrl, date, cycle, hours, runOffset, requireAllHours })` (already exported from run-resolution.js:481 and re-exported by scripts/build-noaa-beta-artifacts.js, which is where tests-node/noaa-beta.test.js:136 imports it from). New behavior: rejects when `date` is provided and `cycle` is not; the explicit date+cycle path is otherwise unchanged and never hits the network. Callers affected: scripts/build-noaa-beta-artifacts.js:182 (passes `args.date`/`args.cycle`) and the `resolveNoaaNamRun` wrapper (build-noaa-beta-artifacts.js:451). `--cycle` without `--date` already throws via `normalizeDate` — leave that path alone.

- [ ] **Step 1: Write the failing test**

In `/Users/micha/Development/model-view/tests-node/noaa-beta.test.js`, insert immediately after this existing test ending (lines 3439-3443):

```js
    assert.ok(requests.every((request) => request.method === "HEAD"));
  } finally {
    global.fetch = originalFetch;
  }
});
```

the new test:

```js
test("NOAA run resolver rejects --date without --cycle instead of defaulting to 00Z", async () => {
  await assert.rejects(
    resolveNoaaModelRun({ modelKey: "nam", noaaBaseUrl: "https://example.test", date: "20260701" }),
    /--cycle/,
  );
  assert.deepEqual(
    await resolveNoaaModelRun({ modelKey: "nam", noaaBaseUrl: "https://example.test", date: "20260701", cycle: "06" }),
    { date: "20260701", cycle: "06" },
  );
});
```

(No fetch mock needed: the explicit-run branch returns before any network probing; NAM cycleHours are [0, 6, 12, 18], so "06" is valid.)

- [ ] **Step 2: Run test to verify it fails**

```
node --test --test-name-pattern "rejects --date without --cycle" tests-node/noaa-beta.test.js
```

Expected: 1 failed with `AssertionError ... Missing expected rejection` — current code resolves `{ date: "20260701", cycle: "00" }` (reproduced during verification).

- [ ] **Step 3: Write minimal implementation**

In `/Users/micha/Development/model-view/scripts/lib/noaa-build/run-resolution.js` (lines 145-150), replace:

```js
  const resolvedModelKey = normalizeNoaaModelKey(modelKey);
  if (date !== undefined || cycle !== undefined) {
    const normalizedDate = normalizeDate(date);
    const normalizedCycle = normalizeCycle(cycle, resolvedModelKey);
    return { date: normalizedDate, cycle: normalizedCycle };
  }
```

with:

```js
  const resolvedModelKey = normalizeNoaaModelKey(modelKey);
  if (date !== undefined || cycle !== undefined) {
    if (date !== undefined && cycle === undefined) {
      // normalizeCycle would pad undefined to "00" and silently render the 00Z run.
      throw new Error("--date requires --cycle=HH (00 through 23).");
    }
    const normalizedDate = normalizeDate(date);
    const normalizedCycle = normalizeCycle(cycle, resolvedModelKey);
    return { date: normalizedDate, cycle: normalizedCycle };
  }
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test --test-name-pattern "rejects --date without --cycle" tests-node/noaa-beta.test.js
node --test --test-name-pattern "NOAA automatic run resolver" tests-node/noaa-beta.test.js
npx prettier --check scripts/lib/noaa-build/run-resolution.js tests-node/noaa-beta.test.js
```

Expected: both patterns pass (new test + the pre-existing auto-resolver test, proving no-flags resolution is untouched); format:check clean. Full-suite confirmation (`node --test tests-node/noaa-beta.test.js`) can run once at phase close since the file is large.

- [ ] **Step 5: Commit**

```
git add scripts/lib/noaa-build/run-resolution.js tests-node/noaa-beta.test.js && git commit -m "Reject --date without --cycle instead of silently rendering the 00Z run" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 9.4: Gate Playwright reuseExistingServer on !CI (P1.17)
**Files:**
- Create: /Users/micha/Development/model-view/tests-node/playwright-config.test.js
- Modify: /Users/micha/Development/model-view/playwright.react.config.js (line 18)

**Interfaces:** Consumes `playwright.react.config.js` module shape (`module.exports = defineConfig({ ..., webServer: { ..., reuseExistingServer } })`). Produces: local runs keep reusing a dev server on 5173; when `process.env.CI` is set (Phase 4's GitHub Actions workflow), Playwright refuses to reuse a stale server. No other config keys change.

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-node/playwright-config.test.js`:

```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const CONFIG_PATH = require.resolve("../playwright.react.config.js");

function loadConfigWithCi(ciValue) {
  const originalCi = process.env.CI;
  try {
    if (ciValue === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = ciValue;
    }
    delete require.cache[CONFIG_PATH];
    return require(CONFIG_PATH);
  } finally {
    if (originalCi === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCi;
    }
    delete require.cache[CONFIG_PATH];
  }
}

test("playwright react config reuses an existing dev server locally", () => {
  assert.equal(loadConfigWithCi(undefined).webServer.reuseExistingServer, true);
});

test("playwright react config never reuses a stale server on CI", () => {
  assert.equal(loadConfigWithCi("true").webServer.reuseExistingServer, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test tests-node/playwright-config.test.js
```

Expected: 1 passed, 1 failed — "never reuses a stale server on CI" fails with `Expected values to be strictly equal: true !== false` (verified: current config yields `true` even with CI=true).

- [ ] **Step 3: Write minimal implementation**

In `/Users/micha/Development/model-view/playwright.react.config.js` line 18, replace:

```js
    reuseExistingServer: true,
```

with:

```js
    reuseExistingServer: !process.env.CI,
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test tests-node/playwright-config.test.js
npx prettier --check playwright.react.config.js tests-node/playwright-config.test.js
```

Expected: 2 passed; format:check clean. Local `npm run smoke:react` behavior is unchanged (CI unset locally → still reuses).

- [ ] **Step 5: Commit**

```
git add playwright.react.config.js tests-node/playwright-config.test.js && git commit -m "Gate Playwright reuseExistingServer on !CI" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 9.5: Settings drawer clipping + custom IANA timezone option (P1.18)
**Files:**
- Create: /Users/micha/Development/model-view/tests-react/app-header-settings.spec.js
- Modify: /Users/micha/Development/model-view/next/src/components/AppHeader.tsx (component body line 64-65; drawer wrapper lines 118-123; closing tags lines 193-197; timezone options lines 187-192)

**Interfaces:** Consumes: `timeZone: string` prop — App.tsx:135 passes the RAW stored setting (may be "UTC", "local", a curated zone, or any valid IANA zone accepted by `normalizeTimeZoneSetting`, next/src/config/timezone.ts:38-51); `TIMEZONE_OPTIONS` (timezone.ts:15-24, already imported); localStorage key `modelview.timezone.v1` (timezone.ts:1, stored as a plain string, not JSON). `useChromeOffsets` measures real header offsetHeight via ResizeObserver (useChromeOffsets.ts:14-22), so letting the drawer grow is safe for map overlay offsets. Note App.tsx:26: the drawer starts OPEN (`useState(true)`). Produces: no new exports.

Test-design note: Playwright's `toBeVisible`/`isVisible` treat clipped-but-laid-out elements as visible (they keep a non-empty bounding box and no `visibility:hidden`), and they ignore opacity — so the collapsed drawer's select still reports "visible" in BOTH the current `max-h-0` state and the new `grid-rows-[0fr]` state (verified empirically against the repo's Playwright 1.52 Chromium). The spec therefore asserts open/closed state via `Element.checkVisibility({ checkOpacity: true, opacityProperty: true })` (false when the drawer's `opacity-0` is applied; both option spellings passed for Chromium compatibility) and asserts the collapse through layout (the header's bounding box shrinks back). Do not "simplify" these to `toBeVisible`/`not.toBeVisible` — the collapse assertion would never pass.

- [ ] **Step 1: Write the failing test**

Create `/Users/micha/Development/model-view/tests-react/app-header-settings.spec.js`:

```js
const { test, expect } = require("@playwright/test");

// Playwright's visibility check treats clipped-but-laid-out elements as visible
// (they keep a non-empty bounding box), so the collapsed drawer's select still
// reports isVisible(). Probe real visibility (ancestor opacity) instead.
function isDrawerShown(zoneSelect) {
  return zoneSelect.evaluate((el) => el.checkVisibility({ checkOpacity: true, opacityProperty: true }));
}

async function openSettingsDrawer(page) {
  const zoneSelect = page.getByLabel("Time zone");
  await expect(zoneSelect).toBeAttached();
  // The drawer currently defaults to open; toggle it open if that ever changes.
  if (!(await isDrawerShown(zoneSelect))) {
    await page.getByRole("button", { name: "Settings" }).click();
  }
  await expect.poll(() => isDrawerShown(zoneSelect)).toBe(true);
  return zoneSelect;
}

test("settings drawer does not clip the timezone row on narrow windows", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/");
  const zoneSelect = await openSettingsDrawer(page);
  await page.waitForTimeout(400); // let the 300ms open transition settle
  const headerBox = await page.locator("header").first().boundingBox();
  const zoneBox = await zoneSelect.boundingBox();
  if (!headerBox || !zoneBox) {
    throw new Error("Header or timezone select bounding box is unavailable.");
  }
  expect(zoneBox.y + zoneBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height + 0.5);
});

test("settings drawer still collapses when toggled closed", async ({ page }) => {
  await page.goto("/");
  const zoneSelect = await openSettingsDrawer(page);
  const header = page.locator("header").first();
  const openBox = await header.boundingBox();
  if (!openBox) {
    throw new Error("Header bounding box is unavailable.");
  }
  await page.getByRole("button", { name: "Settings" }).click();
  // Assert the collapse through layout (the header shrinks back) plus opacity;
  // not.toBeVisible() would never pass because the clipped select keeps a box.
  await expect.poll(async () => (await header.boundingBox())?.height ?? 0).toBeLessThan(openBox.height - 20);
  await expect.poll(() => isDrawerShown(zoneSelect)).toBe(false);
});

test("a stored custom IANA zone renders as a labeled option and stays selected", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("modelview.timezone.v1", "Europe/Berlin");
  });
  await page.goto("/");
  const zoneSelect = await openSettingsDrawer(page);
  await expect(zoneSelect).toHaveValue("Europe/Berlin");
  await expect(zoneSelect.locator("option[value='Europe/Berlin']")).toHaveText("Europe/Berlin");
});
```

- [ ] **Step 2: Run test to verify it fails**

```
npx playwright test -c playwright.react.config.js tests-react/app-header-settings.spec.js --workers=1 --reporter=line
```

Expected: 2 failed, 1 passed. The clip test fails (at 430px the wrapped settings rows exceed the 128px `max-h-32` clip, so the Zone select's box bottom lands below the header's clipped bottom); the custom-zone test fails on `toHaveValue` (an unmatched native select reports value ""); the collapse test passes pre-fix (the `max-h-0` state already shrinks the header and applies `opacity-0`, so `checkVisibility` goes false) — it is a regression guard for the new grid-row collapse.

- [ ] **Step 3: Write minimal implementation**

All edits in `/Users/micha/Development/model-view/next/src/components/AppHeader.tsx`.

3a. Compute the custom-zone flag — replace (lines 64-65):

```tsx
}: AppHeaderProps) {
  return (
```

with:

```tsx
}: AppHeaderProps) {
  const isCustomTimeZone = !TIMEZONE_OPTIONS.some((option) => option.value === timeZone);
  return (
```

3b. Replace the fixed max-height clip with an intrinsically-sized grid-row collapse — replace (lines 118-123):

```tsx
      <div
        className={`overflow-hidden transition-all duration-300 ease-out ${
          settingsOpen ? "mt-2 max-h-32 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.06] pt-2">
```

with:

```tsx
      <div
        className={`grid transition-all duration-300 ease-out ${
          settingsOpen ? "mt-2 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        {/* overflow-hidden zeroes the grid item's min-height so the 0fr row can fully collapse */}
        <div className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.06] pt-2">
```

3c. Close the extra wrapper — replace (lines 193-197):

```tsx
            </label>
          </div>
        </div>
      </div>
    </header>
```

with:

```tsx
            </label>
          </div>
        </div>
        </div>
      </div>
    </header>
```

3d. Surface the stored custom zone as a real option labeled with the raw IANA string — replace (lines 187-192):

```tsx
                {TIMEZONE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} className="bg-slate-900">
                    {option.label}
                  </option>
                ))}
              </select>
```

with:

```tsx
                {TIMEZONE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} className="bg-slate-900">
                    {option.label}
                  </option>
                ))}
                {isCustomTimeZone ? (
                  <option value={timeZone} className="bg-slate-900">
                    {timeZone}
                  </option>
                ) : null}
              </select>
```

3e. Normalize the indentation introduced by 3b/3c:

```
npx prettier --write next/src/components/AppHeader.tsx
```

- [ ] **Step 4: Run test to verify it passes**

```
npx playwright test -c playwright.react.config.js tests-react/app-header-settings.spec.js --workers=1 --reporter=line
npm run typecheck
npx prettier --check next/src/components/AppHeader.tsx tests-react/app-header-settings.spec.js
```

Expected: `3 passed` (open drawer contains the full timezone row on a 430px window; toggling closed shrinks the header back via the 0fr row and fades the drawer so `checkVisibility` goes false; custom zone selected and labeled); typecheck and format:check clean.

- [ ] **Step 5: Commit**

```
git add next/src/components/AppHeader.tsx tests-react/app-header-settings.spec.js && git commit -m "Unclip settings drawer and surface stored custom IANA timezone as an option" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```


## Section 10: Low/latent: calm wind, profile-stage label, dead code, updater purity, bucket-0 tripwire, CIN-cap doc (spec P1.20 + documented-not-changed)

### Task 10.1: Calm wind — payload reports no direction instead of 180°

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta/point-sounding.js` (lines 1526-1540, `windComponentsToMeteorological`)
- Test: `/Users/micha/Development/model-view/tests-node/point-sounding-wind.test.js` (new)

**Interfaces:**
- Consumes: `MPS_TO_KT` (already in scope in point-sounding.js), `roundNullable` (point-sounding.js:1715, maps NaN → null in payloads).
- Produces: `windComponentsToMeteorological(uMps, vMps)` calm contract — for `Math.hypot(u, v) === 0` returns `{ wdir: Number.NaN, wspd: 0, uKt: 0, vKt: 0 }`; serialized sounding levels/summaries then carry `wdir: null` (Task 10.2 relies on this). Non-calm output is bit-identical to today. Point-sounding payloads are computed on demand (not parity-gated artifacts); the selected-GRIB raw cache is untouched so no cache-version bump is needed.

- [ ] **Step 1: Write the failing test** — create `/Users/micha/Development/model-view/tests-node/point-sounding-wind.test.js`:
```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizePointSoundingLevel,
  windComponentsToMeteorological,
} = require("../scripts/lib/noaa-beta/point-sounding");

test("calm wind components produce no meteorological direction", () => {
  const calm = windComponentsToMeteorological(0, 0);
  assert.equal(calm.wspd, 0);
  assert.equal(calm.uKt, 0);
  assert.equal(calm.vKt, 0);
  assert.equal(Number.isNaN(calm.wdir), true);
});

test("calm wind serializes as null direction and zero speed", () => {
  const level = normalizePointSoundingLevel({
    source: "surface",
    press: 1000,
    hght: 10,
    temp: 20,
    dwpt: 15,
    rh: 73,
    ...windComponentsToMeteorological(0, 0),
  });
  assert.equal(level.wdir, null);
  assert.equal(level.wspd, 0);
  assert.equal(level.uKt, 0);
  assert.equal(level.vKt, 0);
});

test("non-calm wind directions are unchanged", () => {
  const north = windComponentsToMeteorological(0, -5);
  assert.equal(north.wdir, 0);
  assert.ok(Math.abs(north.wspd - 5 * 1.943844) < 1e-2);
  assert.equal(north.vKt, -north.wspd);
  const east = windComponentsToMeteorological(-5, 0);
  assert.equal(east.wdir, 90);
  const south = windComponentsToMeteorological(0, 5);
  assert.equal(south.wdir, 180);
  const west = windComponentsToMeteorological(5, 0);
  assert.equal(west.wdir, 270);
});
```
- [ ] **Step 2: Run test to verify it fails** — `node --test tests-node/point-sounding-wind.test.js`. Expected: tests 1 and 2 fail (`Expected values to be strictly equal: false !== true` for `Number.isNaN(calm.wdir)`, and `180 !== null` for `level.wdir`); test 3 passes. Verified against current code: `windComponentsToMeteorological(0, 0)` returns `wdir: 180` today.
- [ ] **Step 3: Write minimal implementation** — in `/Users/micha/Development/model-view/scripts/lib/noaa-beta/point-sounding.js`, replace:
```js
  const speedKt = Math.hypot(u, v) * MPS_TO_KT;
  const direction = (Math.atan2(-u, -v) * 180) / Math.PI;
```
with:
```js
  const speedKt = Math.hypot(u, v) * MPS_TO_KT;
  if (speedKt === 0) {
    // Calm wind has no defined meteorological direction; atan2(-0, -0) would
    // otherwise report 180 degrees.
    return { wdir: Number.NaN, wspd: 0, uKt: 0, vKt: 0 };
  }
  const direction = (Math.atan2(-u, -v) * 180) / Math.PI;
```
(The only occurrence is inside `windComponentsToMeteorological`, lines 1532-1533.)
- [ ] **Step 4: Run test to verify it passes** — `node --test tests-node/point-sounding-wind.test.js` (all 3 pass), then the full suite `node --test tests-node/noaa-beta.test.js` (all pass — nothing consumes `wdir` numerically inside point-sounding.js; hodograph/shear math uses uKt/vKt, which stay 0 for calm). Also `npx prettier --check scripts/lib/noaa-beta/point-sounding.js tests-node/point-sounding-wind.test.js`.
- [ ] **Step 5: Commit** — `git add scripts/lib/noaa-beta/point-sounding.js tests-node/point-sounding-wind.test.js && git commit -m "Report calm wind with no direction in point sounding payloads

Calm (zero-speed) winds previously serialized wdir=180 via atan2(-0,-0).
Calm levels now carry wdir=null; speeds/components stay exact.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 10.2: Calm wind — SoundingDrawer renders calm explicitly

**Files:**
- Modify: `/Users/micha/Development/model-view/next/src/components/SoundingDrawer.tsx` (lines 1274-1276 `WindBarb`, 1411-1418 upper-barb filter, 1609-1612 `meteorologicalFromWindComponentsKt`, 1717-1720 `formatWind`)
- Test: manual verification + existing react smoke regression (see Step 2/4 — automated Playwright assertion is impractical here: it would require a fixture sounding payload containing a calm level driven through the on-demand sounding endpoint; the drawer needs a live GRIB-backed server per the sounding verification recipe. The payload-side contract is already covered by Task 10.1's node test.)

**Interfaces:**
- Consumes: Task 10.1's calm contract (`level.wdir === null`, `level.wspd === 0` for calm); `PointSoundingLevel.wdir?: number | null` (next/src/types.ts:260) already admits null.
- Produces: `formatWind(direction, speed)` returns `"Calm"` for exact numeric speed 0; `WindBarb` renders an open circle for zero speed; `meteorologicalFromWindComponentsKt` mirrors the server calm contract.

- [ ] **Step 1: Record the current (wrong) behavior as the test oracle** — with current code, a calm level renders `180/0` in the Profile table and a south-pointing bare staff barb. The acceptance oracle after this task: table shows `Calm`, barb shows an open circle, no fabricated direction anywhere. (No new automated test — see Files note.)
- [ ] **Step 2: Baseline regression run** — `npm run install:browsers` (once), then `npm run smoke:react`. Expected: green before changes (baseline).
- [ ] **Step 3: Write minimal implementation** — four edits in `/Users/micha/Development/model-view/next/src/components/SoundingDrawer.tsx`:

Edit 1 — `WindBarb` (lines 1274-1276), replace:
```tsx
function WindBarb({ x, y, level }: { x: number; y: number; level: PointSoundingLevel }) {
  const speed = Math.max(0, Number(level.wspd) || 0);
  const direction = Number(level.wdir) || 0;
```
with:
```tsx
function WindBarb({ x, y, level }: { x: number; y: number; level: PointSoundingLevel }) {
  const speed = Math.max(0, Number(level.wspd) || 0);
  if (speed === 0) {
    // Station-plot convention: calm renders as an open circle, not a staff
    // implying a direction.
    return <circle cx={x} cy={y} r={4} fill="none" stroke="#e2e8f0" strokeWidth="1.7" />;
  }
  const direction = Number(level.wdir) || 0;
```

Edit 2 — upper-barb filter (lines 1411-1418), replace:
```tsx
  const upperBarbs = rows
    .filter(
      (level) =>
        Number(level.heightAglM) > topFixedAglM &&
        Number.isFinite(level.press) &&
        Number.isFinite(level.wspd) &&
        Number.isFinite(level.wdir),
    )
```
with:
```tsx
  const upperBarbs = rows
    .filter(
      (level) =>
        Number(level.heightAglM) > topFixedAglM &&
        Number.isFinite(level.press) &&
        Number.isFinite(level.wspd) &&
        // Calm levels carry a null direction but still render (as calm circles).
        (Number.isFinite(level.wdir) || Number(level.wspd) === 0),
    )
```

Edit 3 — `meteorologicalFromWindComponentsKt` (after the NaN guard at lines 1609-1611), replace:
```tsx
  if (!Number.isFinite(u) || !Number.isFinite(v)) {
    return { wdir: Number.NaN, wspd: Number.NaN, uKt: Number.NaN, vKt: Number.NaN };
  }
  const direction = (Math.atan2(-u, -v) * 180) / Math.PI;
```
with:
```tsx
  if (!Number.isFinite(u) || !Number.isFinite(v)) {
    return { wdir: Number.NaN, wspd: Number.NaN, uKt: Number.NaN, vKt: Number.NaN };
  }
  if (Math.hypot(u, v) === 0) {
    // Calm wind has no defined direction (mirrors windComponentsToMeteorological
    // in scripts/lib/noaa-beta/point-sounding.js).
    return { wdir: null, wspd: 0, uKt: 0, vKt: 0 };
  }
  const direction = (Math.atan2(-u, -v) * 180) / Math.PI;
```

Edit 4 — `formatWind` (lines 1717-1720), replace:
```tsx
function formatWind(directionDeg: number | null | undefined, speedKt: number | null | undefined): string {
  if (!Number.isFinite(directionDeg) && !Number.isFinite(speedKt)) {
    return "--";
  }
```
with:
```tsx
function formatWind(directionDeg: number | null | undefined, speedKt: number | null | undefined): string {
  if (!Number.isFinite(directionDeg) && !Number.isFinite(speedKt)) {
    return "--";
  }
  // Strict zero only: Number(null) === 0, so null/undefined speeds must not
  // read as calm.
  if (speedKt === 0) {
    return "Calm";
  }
```
- [ ] **Step 4: Verify** — `npm run typecheck && npm run lint -- --quiet && npm run smoke:react` (all green; smoke covers drawer-adjacent surfaces for regression) and `npx prettier --check next/src/components/SoundingDrawer.tsx`. Manual verification (per docs sounding recipe): start `npm run dev` against a built cache, open a sounding (double-click map, or fill `input[aria-label="Sounding latitude"]`/`"Sounding longitude"` and click "Go"); a truly calm level shows `Calm` in the Profile table Wind column and an open circle barb; alternatively verify headlessly that `buildNoaaPointSounding` (from `scripts/lib/noaa-beta-renderer`) emits `wdir: null` for a calm level. Non-calm levels must render exactly as before.
- [ ] **Step 5: Commit** — `git add next/src/components/SoundingDrawer.tsx && git commit -m "Render calm wind explicitly in the sounding drawer

Calm levels show 'Calm' in the profile table and an open-circle barb
instead of a fabricated 180-degree staff; the UI wind-component mirror
now matches the server calm contract.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 10.3: grib-source — rename mislabeled `rangeConcatMs` profile stage, drop dead `atomic` option

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta/grib-source.js` (lines 530-538, 699-707, 766-768)
- Test: `/Users/micha/Development/model-view/tests-node/grib-source-range-file.test.js` (new)

**Interfaces:**
- Consumes: `writeSelectedGribRangeFile({ targetPath, gribUrl, groups, rangeFetchConcurrency, rangeFetchLimiter, profile })` — already exported from grib-source.js; `recordProfileStage` writes `profile.stages[key]` (cache-io.js:175-180).
- Produces: profile stage key `selectedGribHashMs` replaces `rangeConcatMs` (it times `hashFileSha256`, not any concat — chunks are written at offsets). Consumer-safe: the key is not in `orderedStageKeys` (scripts/build-noaa-beta-artifacts.js:568-597) so it never appears in log lines, `output/noaa-benchmarks/parse-profile-log.js` parses stages from log lines only, and no other code/doc references `rangeConcatMs`. The `atomic` property is absent from the function's destructuring, so removing it from the two call sites is provably behavior-identical (artifact byte parity unaffected; only the `.complete.json` profile sidecar — explicitly excluded from parity — carries the renamed field).

- [ ] **Step 1: Write the failing test** — create `/Users/micha/Development/model-view/tests-node/grib-source-range-file.test.js` (fetch-stubbing pattern matches noaa-beta.test.js:3416):
```js
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { writeSelectedGribRangeFile } = require("../scripts/lib/noaa-beta/grib-source");

test("writeSelectedGribRangeFile assembles ranges and records the sha256 stage", async () => {
  const chunks = {
    "bytes=0-3": Buffer.from("GRIB"),
    "bytes=4-9": Buffer.from("abcdef"),
  };
  const groups = [
    { rangeHeader: "bytes=0-3", byteLength: 4 },
    { rangeHeader: "bytes=4-9", byteLength: 6 },
  ];
  const targetPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "grib-range-test-")), "selected.grib2");
  const profile = { stages: {} };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const chunk = chunks[options.headers?.Range];
    assert.ok(chunk, `unexpected Range header ${options.headers?.Range}`);
    return {
      status: 206,
      arrayBuffer: async () => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
    };
  };
  try {
    const result = await writeSelectedGribRangeFile({
      targetPath,
      gribUrl: "https://example.invalid/file.grib2",
      groups,
      rangeFetchConcurrency: 1,
      profile,
    });
    const expected = Buffer.concat([chunks["bytes=0-3"], chunks["bytes=4-9"]]);
    assert.deepEqual(fs.readFileSync(targetPath), expected);
    assert.equal(result.bytes, expected.length);
    assert.equal(result.sha256, crypto.createHash("sha256").update(expected).digest("hex"));
    assert.equal(profile.selectedBytes, expected.length);
    assert.ok(Number.isFinite(profile.stages.rangeFetchMs));
    assert.ok(Number.isFinite(profile.stages.selectedGribHashMs));
    assert.equal("rangeConcatMs" in profile.stages, false);
  } finally {
    global.fetch = originalFetch;
  }
});
```
- [ ] **Step 2: Run test to verify it fails** — `node --test tests-node/grib-source-range-file.test.js`. Expected failure: `AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: assert.ok(Number.isFinite(profile.stages.selectedGribHashMs))` (current code records the stage as `rangeConcatMs`; all earlier assertions pass, pinning existing behavior).
- [ ] **Step 3: Write minimal implementation** — three edits in `/Users/micha/Development/model-view/scripts/lib/noaa-beta/grib-source.js`:

Edit 1 (lines 766-768), replace:
```js
  const hashStartedAt = performance.now();
  const sha256 = await hashFileSha256(targetPath);
  recordProfileStage(profile, "rangeConcatMs", hashStartedAt);
```
with:
```js
  const hashStartedAt = performance.now();
  const sha256 = await hashFileSha256(targetPath);
  recordProfileStage(profile, "selectedGribHashMs", hashStartedAt);
```

Edit 2 (lines 530-538, in `materializeSelectedGribUncached`), replace:
```js
    await writeSelectedGribRangeFile({
      targetPath: tempPath,
      gribUrl,
      groups,
      rangeFetchConcurrency,
      rangeFetchLimiter,
      profile,
      atomic: false,
    });
```
with:
```js
    await writeSelectedGribRangeFile({
      targetPath: tempPath,
      gribUrl,
      groups,
      rangeFetchConcurrency,
      rangeFetchLimiter,
      profile,
    });
```

Edit 3 (lines 699-707, in `writeCachedSelectedGrib`), replace:
```js
  const result = await writeSelectedGribRangeFile({
    targetPath: tmp,
    gribUrl: descriptor.gribUrl,
    groups: descriptor.groups,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    profile,
    atomic: false,
  });
```
with:
```js
  const result = await writeSelectedGribRangeFile({
    targetPath: tmp,
    gribUrl: descriptor.gribUrl,
    groups: descriptor.groups,
    rangeFetchConcurrency,
    rangeFetchLimiter,
    profile,
  });
```
- [ ] **Step 4: Run test to verify it passes** — `node --test tests-node/grib-source-range-file.test.js` (passes), then `node --test tests-node/noaa-beta.test.js` (all pass), and `grep -rn "rangeConcatMs\|atomic" scripts/lib/noaa-beta/grib-source.js` returns nothing (use `grep -a` if grep flags the file as binary — it contains a control byte). `npx prettier --check scripts/lib/noaa-beta/grib-source.js tests-node/grib-source-range-file.test.js`.
- [ ] **Step 5: Commit** — `git add scripts/lib/noaa-beta/grib-source.js tests-node/grib-source-range-file.test.js && git commit -m "Rename mislabeled rangeConcatMs profile stage; drop dead atomic option

The stage times hashFileSha256 (range chunks are written at offsets, no
concat), so it is now selectedGribHashMs. The stage key is displayed
nowhere and has no consumers. writeSelectedGribRangeFile ignores the
atomic property, so both dead call-site options are removed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 10.4: Remove tautological `renderMode !== "base"` guard in the renderer

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta-renderer.js` (line 564)
- Test: existing suite only — see Step 1. This is a control-flow-identity refactor: the branch sits in an `else if` chain after `} else if (renderMode === "base") {` (line 508), so `renderMode !== "base"` is always true when evaluated (renderMode values across the codebase: "all" (default, line 260), "base", "snow", "snow-delta", "snow-prefix", "runmax-prefix"; the last three are consumed at lines 436/460/484 before this branch). No new test can fail before/after — the behavior is provably identical for every input.

**Interfaces:**
- Consumes/Produces: none — no signature or output changes; exactness rule holds trivially (no reachable path changes).

- [ ] **Step 1: Baseline (behavior pin)** — `node --test tests-node/noaa-beta.test.js` green before the change.
- [ ] **Step 2: Confirm the guard is dead** — `grep -n "renderMode" scripts/lib/noaa-beta-renderer.js scripts/lib/noaa-beta/selection.js scripts/lib/noaa-build/frame-queue.js scripts/lib/local-artifact-runtime.js` and inspect the chain at noaa-beta-renderer.js:436-591: `runmax-prefix` → `snow-delta` → `snow-prefix` → `=== "base"` → `!== "base"`. The final condition cannot be false.
- [ ] **Step 3: Write minimal implementation** — replace (line 564):
```js
    } else if (renderMode !== "base") {
```
with:
```js
    } else {
```
- [ ] **Step 4: Verify** — `node --test tests-node/noaa-beta.test.js && npm run lint -- --quiet` (green). Optional extra safety if a cached run exists locally: golden-frame parity per the renderer protocol — snapshot `output/noaa-beta-cache/artifacts/tiles/...`, re-run `npm run noaa:build:test -- --frames=2`, `cmp` every artifact except `*.complete.json`; expect byte-identical (set `MODELVIEW_PNG_DEFLATE_BACKEND=zlib` on both sides if comparing across machines).
- [ ] **Step 5: Commit** — `git add scripts/lib/noaa-beta-renderer.js && git commit -m "Simplify tautological renderMode guard to plain else

The branch follows renderMode === \"base\" in the same else-if chain, so
the !== \"base\" condition was always true. No control-flow change.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 10.5: usePanelCollection — pure state updater (no setState inside setState)

**Files:**
- Modify: `/Users/micha/Development/model-view/next/src/hooks/usePanelCollection.ts` (whole file, 69 lines)
- Test: `/Users/micha/Development/model-view/tests-react/panel-collection.spec.js` (new; behavior-pinning spec — it passes before AND after the refactor by design, guarding the exact semantics the refactor must preserve: unique monotonic panel ids, model rotation `MODEL_KEYS[counter % 4]`, max-2 guard)

**Interfaces:**
- Consumes: `DEFAULT_PANEL_MODEL` ("gfs"), `MODEL_KEYS` (["gfs","nam","nam3km","hrrr"], insertion order of MODEL_CONFIG) from `next/src/config/constants.ts`; `PanelState` from `next/src/types.ts`.
- Produces: hook return shape unchanged — `{ addPanel(): void; panels: PanelState[]; removePanel(id: string): void; togglePanelLayer(id, layer): void; updatePanelModel(id, modelKey): void; updatePanelRun(id, runId): void }` (App.tsx:28-35 destructures exactly these). Counter semantics preserved exactly: increments only when a panel is actually added; add→remove→add yields panel-2 ("nam3km") then panel-3 ("hrrr").

- [ ] **Step 1: Write the behavior-pinning test** — create `/Users/micha/Development/model-view/tests-react/panel-collection.spec.js`:
```js
const { test, expect } = require("@playwright/test");

const ONE_BY_ONE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9s0NkgAAAABJRU5ErkJggg==";

function latestPointer(model, manifestKey) {
  return {
    model,
    run: "20260423-1200Z",
    view: "conus",
    generatedAt: "2026-04-23T12:10:00Z",
    manifestKey,
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
        layers: {
          temperature: { key: "", bytes: 120, contentType: "image/png", url: ONE_BY_ONE },
        },
      },
    ],
  };
}

async function routeModelFixtures(page, models) {
  for (const model of models) {
    await page.route(`**/__cf/manifests/${model}/latest.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(latestPointer(model, `manifests/${model}/panel-test.json`)),
      });
    });
    await page.route(`**/__cf/manifests/${model}/panel-test.json**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(buildManifest(model)),
      });
    });
  }
}

test("panel add/remove/add keeps monotonic ids and model rotation", async ({ page }) => {
  await routeModelFixtures(page, ["gfs", "nam", "nam3km", "hrrr"]);

  await page.goto("/");
  await expect(page.locator("article")).toHaveCount(1);
  await expect(page.getByLabel("Model").first()).toHaveValue("gfs");

  await page.getByRole("button", { name: "Add Map" }).click();
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.getByLabel("Model").nth(1)).toHaveValue("nam3km");
  await expect(page.getByRole("button", { name: "Add Map" })).toBeDisabled();

  await page.getByRole("button", { name: "Remove" }).last().click();
  await expect(page.locator("article")).toHaveCount(1);

  await page.getByRole("button", { name: "Add Map" }).click();
  await expect(page.locator("article")).toHaveCount(2);
  await expect(page.getByLabel("Model").nth(1)).toHaveValue("hrrr");
});
```
- [ ] **Step 2: Run the pin test against current code** — prerequisites: `npm run install:browsers` (once; the Playwright config auto-runs `scripts/prepare-react-fixture-cache.js`). Run `npx playwright test -c playwright.react.config.js tests-react/panel-collection.spec.js --workers=1 --reporter=line`. Expected: PASSES before the change (this is a refactor pin, not a red test — the current side effect is idempotent so there is no externally observable bug to fail on; stated per plan convention for behavior-preserving refactors).
- [ ] **Step 3: Write minimal implementation** — replace the entire contents of `/Users/micha/Development/model-view/next/src/hooks/usePanelCollection.ts` with:
```ts
import { useCallback, useState } from "react";
import { DEFAULT_PANEL_MODEL, MODEL_KEYS } from "../config/constants";
import type { LayerKey, ModelKey, PanelState } from "../types";

const DEFAULT_PANEL_LAYERS: LayerKey[] = ["temperature"];

function buildPanel(id: number, modelKey: ModelKey): PanelState {
  return { id: `panel-${id}`, modelKey, layers: [...DEFAULT_PANEL_LAYERS] };
}

interface PanelCollectionState {
  panels: PanelState[];
  counter: number;
}

export function usePanelCollection() {
  // Panels and the id counter live in one state object so addPanel's updater
  // stays pure (no setState calls inside another updater).
  const [state, setState] = useState<PanelCollectionState>(() => ({
    panels: [buildPanel(1, DEFAULT_PANEL_MODEL)],
    counter: 1,
  }));

  const addPanel = useCallback((): void => {
    setState((prev) => {
      if (prev.panels.length >= 2) {
        return prev;
      }
      const nextIndex = prev.counter + 1;
      const modelKey = MODEL_KEYS[nextIndex % MODEL_KEYS.length];
      return { counter: nextIndex, panels: [...prev.panels, buildPanel(nextIndex, modelKey)] };
    });
  }, []);

  const removePanel = useCallback((panelId: string): void => {
    setState((prev) => {
      if (prev.panels.length <= 1) {
        return prev;
      }
      return { ...prev, panels: prev.panels.filter((panel) => panel.id !== panelId) };
    });
  }, []);

  const updatePanelModel = useCallback((panelId: string, modelKey: ModelKey): void => {
    setState((prev) => ({
      ...prev,
      panels: prev.panels.map((panel) => (panel.id === panelId ? { ...panel, modelKey, runId: null } : panel)),
    }));
  }, []);

  const updatePanelRun = useCallback((panelId: string, runId: string | null): void => {
    setState((prev) => ({
      ...prev,
      panels: prev.panels.map((panel) => (panel.id === panelId ? { ...panel, runId } : panel)),
    }));
  }, []);

  const togglePanelLayer = useCallback((panelId: string, layer: LayerKey): void => {
    setState((prev) => ({
      ...prev,
      panels: prev.panels.map((panel) => {
        if (panel.id !== panelId) {
          return panel;
        }
        const next = new Set<LayerKey>(panel.layers);
        if (next.has(layer)) {
          next.delete(layer);
        } else {
          next.add(layer);
        }
        return { ...panel, layers: Array.from(next) };
      }),
    }));
  }, []);

  return {
    addPanel,
    panels: state.panels,
    removePanel,
    togglePanelLayer,
    updatePanelModel,
    updatePanelRun,
  };
}
```
- [ ] **Step 4: Run test to verify it still passes** — `npm run typecheck && npm run lint -- --quiet`, then `npx playwright test -c playwright.react.config.js tests-react/panel-collection.spec.js tests-react/display-menu.spec.js --workers=1 --reporter=line` (both green; display-menu.spec.js exercises Add Map too). `npx prettier --check next/src/hooks/usePanelCollection.ts tests-react/panel-collection.spec.js`.
- [ ] **Step 5: Commit** — `git add next/src/hooks/usePanelCollection.ts tests-react/panel-collection.spec.js && git commit -m "Make usePanelCollection updaters pure

addPanel called setPanelCounter inside the setPanels updater; panels and
the id counter now share one state object so every updater is pure.
Counter semantics (monotonic ids, model rotation, max-2 guard) are
unchanged and pinned by a Playwright spec.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 10.6: Step-scale bucket-0 clamp — guard comment + invariant tripwire (latent, no behavior change)

**Files:**
- Modify: `/Users/micha/Development/model-view/scripts/lib/noaa-beta/raster.js` (comment only, above `renderScalarGridStepRaw` at line 338)
- Test: `/Users/micha/Development/model-view/tests-node/raster-step-scale.test.js` (new)

**Interfaces:**
- Consumes: `CATALOG_RENDER_OPTIONS` (Map), `CORE_LAYER_RENDER_OPTIONS`, `createStepColorLookup`, `renderScalarGridStep` — all already exported from raster.js.
- Produces: nothing new — zero behavior change; artifact byte parity holds trivially (comment + tests only).

Investigation result (why no code fix): step bucket selection clamps values below `thresholds[0]` into bucket 0 — the binary search defaults `selected = 0` (raster.js:370-381) and the uniform fast path clamps negatives to 0 (raster.js:363-365); same pattern in the affine/function/wind-step variants. Concrete trace, `reflectivityDbz` palette: core reflectivity options (raster.js:1627-1631) have NO `minVisible`, so a 5 dBZ cell reaches bucket selection, thresholds are [7.5, 10, 12.5, ...] (uniform, step 2.5), `floor((5 - 7.5) * 0.4) = -1 → 0` — but bucket 0's stop is `[7.5, [21,80,180], alpha 0]`, so `alphaByte <= 0` skips the pixel (raster.js:385). Enumerating every current step render option (8 catalog entries on precipIn/reflectivityDbz + core precip/reflectivity — 10 total) confirms each has an alpha-0 first stop, and all but core:reflectivity additionally have `minVisible >= thresholds[0]` (precipIn: 0.01 vs 0; reflectivityDbz: 10 vs 7.5; reflectivity gates are 10/15/20). So no pixel miscolors today — the hazard is real code behavior but unreachable with current palettes, demonstrated by the synthetic-palette test below (value 5 below an opaque threshold-10 stop paints red).

- [ ] **Step 1: Write the tripwire test** — create `/Users/micha/Development/model-view/tests-node/raster-step-scale.test.js`:
```js
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CATALOG_RENDER_OPTIONS,
  CORE_LAYER_RENDER_OPTIONS,
  createStepColorLookup,
  renderScalarGridStep,
} = require("../scripts/lib/noaa-beta/raster");

function stepOptionEntries() {
  const entries = [];
  for (const [key, options] of CATALOG_RENDER_OPTIONS.entries()) {
    if (options?.colorLookup?.kind === "step") {
      entries.push([`catalog:${key}`, options]);
    }
  }
  for (const [key, options] of Object.entries(CORE_LAYER_RENDER_OPTIONS)) {
    if (options?.colorLookup?.kind === "step") {
      entries.push([`core:${key}`, options]);
    }
  }
  return entries;
}

test("step palettes keep below-range values invisible (bucket-0 clamp guard)", () => {
  const entries = stepOptionEntries();
  assert.ok(entries.length >= 2, "expected step render options in catalog/core lookups");
  for (const [key, options] of entries) {
    const lookup = options.colorLookup;
    const firstAlpha = lookup.colors[3];
    const rangeMin = Array.isArray(options.visibleRange) ? Number(options.visibleRange[0]) : Number.NaN;
    const effectiveMin = Number.isFinite(rangeMin) ? rangeMin : Number(options.minVisible);
    const guarded = firstAlpha === 0 || (Number.isFinite(effectiveMin) && effectiveMin >= lookup.thresholds[0]);
    assert.ok(guarded, `${key}: below-range values would paint the first step bucket`);
  }
});

test("bucket-0 clamp paints below-range values when a palette is unguarded", () => {
  // Documents the latent hazard the guard test above protects against: an
  // opaque first stop with no covering minVisible paints out-of-range values
  // with the first bucket color. Intentional pin of current clamp behavior.
  const lookup = createStepColorLookup(
    [
      [10, [255, 0, 0, 1]],
      [20, [0, 255, 0, 1]],
    ],
    1,
  );
  const result = renderScalarGridStep({
    values: Float64Array.from([5]),
    width: 1,
    height: 1,
    colorLookup: lookup,
    minVisible: null,
    maxVisible: null,
    visibleRange: null,
  });
  assert.equal(result.visibleCount, 1);
  assert.equal(result.rgba[0], 255);
  assert.equal(result.rgba[3], 255);
});
```
- [ ] **Step 2: Run the test** — `node --test tests-node/raster-step-scale.test.js`. Expected: BOTH tests pass immediately (verified against current code: all 10 step options are guarded; the synthetic unguarded palette paints [255,0,0,255] for value 5). This is a tripwire, not a red test — there is provably no failing behavior today; the guard test fails in the future if anyone adds a step palette with an opaque first stop and no covering minVisible, or removes an existing guard.
- [ ] **Step 3: Add the guard comment** — in `/Users/micha/Development/model-view/scripts/lib/noaa-beta/raster.js`, replace:
```js
function renderScalarGridStepRaw({ rgba, values, cellCount, colorLookup, visible }) {
```
with:
```js
// Step-bucket selection clamps below-range values into bucket 0: the binary
// search defaults selected=0 and the uniform fast path floors negatives to 0
// (same in the affine/function/wind-step variants). Safe only while every
// step palette pairs an alpha-0 first stop and/or a minVisible/visibleRange
// min at or above thresholds[0]; tests-node/raster-step-scale.test.js pins
// that invariant for all catalog/core step lookups.
function renderScalarGridStepRaw({ rgba, values, cellCount, colorLookup, visible }) {
```
- [ ] **Step 4: Verify no behavior change** — `node --test tests-node/raster-step-scale.test.js tests-node/noaa-beta.test.js` (all green) and `npx prettier --check scripts/lib/noaa-beta/raster.js tests-node/raster-step-scale.test.js`. No parity run needed: the raster.js diff is a comment.
- [ ] **Step 5: Commit** — `git add scripts/lib/noaa-beta/raster.js tests-node/raster-step-scale.test.js && git commit -m "Guard the latent step-scale bucket-0 clamp with an invariant test

Below-range values clamp into step bucket 0; every current step palette
is protected by an alpha-0 first stop and/or covering minVisible, so no
output changes today. A tripwire test pins the invariant and a comment
documents the constraint for future palettes.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

### Task 10.7: Document the gridded-vs-point CIN cap difference in plan.md (documented-not-changed)

**Files:**
- Modify: `/Users/micha/Development/model-view/plan.md` (line 54, end of the "## Severe Products" bullet list, immediately before "## Winter Methodology")
- Test: none (doc-only; verified by reading)

**Interfaces:**
- Consumes: verified code facts — `PARCEL_CIN_TOP_PRESSURE_HPA = 500` (severe.js:56); point pressure-step path gates CIN on `upper.pressureHpa >= PARCEL_CIN_TOP_PRESSURE_HPA` (severe.js:923-924, `calculatePressureStepParcelCapeCinForSource`); gridded segment path accumulates all sub-LFC negative energy with no cap (severe.js:825-826, `calculateSegmentParcelCapeCinForSource`); point-sounding.js always uses the capped path (`{ pressureStep: true }`, point-sounding.js:1004), the gridded row scan (severe.js:597) uses the uncapped one.
- Produces: a durable plan.md record so the difference is an acknowledged trade-off, not a latent surprise. No code change.

- [ ] **Step 1: Confirm the facts still hold** — `grep -n "PARCEL_CIN_TOP_PRESSURE_HPA" scripts/lib/noaa-beta/severe.js` (expect lines 56, 923, 1716) and confirm severe.js:825-826 has no pressure condition on `cin += energy`.
- [ ] **Step 2: N/A (doc-only)** — no failing test; this task records an accepted trade-off per spec Phase 1 "Documented-not-changed".
- [ ] **Step 3: Write the note** — in `/Users/micha/Development/model-view/plan.md`, replace:
```
- MUCAPE-only elevated instability remains masked until an elevated effective-layer base/top calculation exists.
```
with:
```
- MUCAPE-only elevated instability remains masked until an elevated effective-layer base/top calculation exists.
- Gridded vs point CIN integration depth (documented-not-changed, 2026-07-02): the point pressure-step parcel path (`calculatePressureStepParcelCapeCinForSource`, `scripts/lib/noaa-beta/severe.js`) stops accumulating CIN above `PARCEL_CIN_TOP_PRESSURE_HPA` (500 mb), following the SHARPpy convention; the gridded segment path (`calculateSegmentParcelCapeCinForSource`, same file) integrates all sub-LFC negative buoyancy with no pressure cap, so gridded CIN (and CIN-gated products such as effective-inflow masks) can read modestly more negative than a point sounding at the same cell in deep or elevated regimes. Accepted as a gridded compute trade-off; aligning it would be an output-changing renderer edit subject to the exactness rule.
```
- [ ] **Step 4: Verify** — `npx prettier --check plan.md` and re-read the Severe Products section for coherence with the surrounding bullets.
- [ ] **Step 5: Commit** — `git add plan.md && git commit -m "Document gridded-vs-point CIN cap difference as accepted trade-off

Point parcel CIN stops above 500 mb (SHARPpy convention); the gridded
segment path integrates uncapped. Recorded per the app-completion spec
documented-not-changed item; no formula changes.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`
