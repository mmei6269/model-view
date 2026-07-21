# UX Ops Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the viewer into a complete self-serve control surface (cache management, multi-run queue, cancel, renderer tuning, frame subsets, global toasts) and deepen its comparison core (full permalinks, accuracy tooltips, 4-panel compare, cross-panel hover diff, sounding compare + export).

**Architecture:** All server work extends `scripts/lib/local-artifact-server.js` and its `JobRegistry` (jobs stay in-memory, chained via `after`, spawned as child processes; progress by 2 s polling). Cache logic reuses `planPrune`/`runPrune` from `scripts/prune-render-cache.js` in-process. Frontend work extends the existing render-panel stack (`RenderMenu.tsx` + `useRenderActions.ts` + `core/actions-client.ts` + `config/render.ts`) and the panel/timeline stack (`App.tsx`, `MapPanel.tsx`, `useTimelineController.ts`). Every new mutating route reuses `isAllowedPostOrigin` + enum allowlists + `SAFE_PATH_COMPONENT`/`parseRunId` gates.

**Tech Stack:** Node 20 http server (no framework), React 19 + TS + Tailwind 4 + Leaflet, node:test, Playwright.

## Global Constraints

- Accuracy first: no formula/threshold/gating changes anywhere in the render path (`plan.md`).
- Byte-identical invariant: a FULL selection emits NO selection flags (`buildBuilderArgv` B.3 convention). Tuning flags and `--max-hour` are orthogonal: concurrency never changes artifact bytes; a max-hour build is a **prefix** of the full hour list, so rendered frames (incl. accumulation/run-max products) stay byte-identical to a full build's same-hour frames. The UI must only offer prefix subsets (max hour), never arbitrary hour gaps.
- Never delete/rename public palette exports or scale constants (public mirror constraint).
- New mutating `/actions/*` routes MUST check `isAllowedPostOrigin` and refuse while conflicting jobs run.
- Validation baseline before handoff: `node --test tests-node/*.test.js`, `npm run typecheck`, `npm run lint -- --quiet`, `npm run format:check`, `npm run smoke:react`.
- Cache clear/prune verification against the REAL 203 GB cache must use dry-run only; destructive paths are tested exclusively against temp cacheRoots (node tests use `withServer` mkdtemp harness in `tests-node/local-artifact-actions.test.js`).
- Commit per task; branch `ux-ops-suite`.

---

### Task 1: Cache stats/prune/clear server endpoints

**Files:**
- Modify: `scripts/prune-render-cache.js` (export `dirSize`, `formatBytes`)
- Create: `scripts/lib/local-artifact-cache-actions.js`
- Modify: `scripts/lib/local-artifact-server.js` (route wiring only)
- Test: `tests-node/local-artifact-cache-actions.test.js`

**Interfaces (produces):**
- `GET /actions/cache-stats` → `{ cacheRoot, totalBytes, artifactsBytes, rawBytes, models: [{ model, runs: [{ runId, bytes, latest }] }], computedAt }`. 60 s TTL cache + in-flight dedup; `?refresh=1` busts.
- `POST /actions/cache/prune` body `{ dryRun?: bool, keep?: int 1-24, budgetGb?: number }` → `{ dryRun, deletions: [{ path (relative to cacheRoot), bytes, runId, model, kind }], removedBytes, projectedBytes, budgetUnmet }`. 409 when any render/prefetch job is running or queued. Wraps `planPrune` (dry) / `runPrune`.
- `POST /actions/cache/clear` body `{ confirm: "CLEAR" }` → `{ removedBytes }`; removes `cacheRoot/artifacts` + `cacheRoot/raw-noaa` (never tools). 400 without exact confirm token; 409 while jobs active. Invalidate stats cache after prune/clear.
- Registry helper `hasActiveJobs()` on `JobRegistry` (any job status queued|running).

**Steps:** failing node tests first (stats totals from seeded temp cache; prune dry-run parity with planPrune; prune 409 while job running via fake spawn that never exits; clear requires confirm token; clear 409 while active; POST origin guard 403), then implement, then commit `feat: in-app cache stats, prune, and clear endpoints`.

### Task 2: Job cancel + `canceled` status

**Files:**
- Modify: `scripts/lib/local-artifact-server.js` (JobRegistry.cancelJob, route `POST /actions/cancel/:jobId`, launch() flushes successors when not queued)
- Test: extend `tests-node/local-artifact-actions.test.js`

**Interfaces:**
- `POST /actions/cancel/:jobId` → `{ ok: true, status: "canceled" }` (404 unknown job; 200 idempotent on terminal jobs, returns current status).
- Job status union gains `"canceled"`. Queued cancel: status set immediately; its launch() no-ops but MUST flush its own `_queue` so successors still run (predecessor exit → launch(J canceled) → flush J's queue). Running cancel: set `job.cancelRequested`, SIGTERM child; exit handler maps to `canceled` (not failed) when flagged.
- `publicJobView` unchanged shape otherwise.

### Task 3: `--max-hour` builder flag + tuning passthrough in render wire

**Files:**
- Modify: `scripts/lib/noaa-build/run-resolution.js` (`resolveHoursByModel` accepts `args["max-hour"]`, filters each model list to `hour <= maxHour`)
- Modify: `scripts/build-noaa-beta-artifacts.js` (none expected beyond args passthrough — verify)
- Modify: `scripts/lib/local-artifact-server.js` (`validateRenderSelection` accepts `maxHour` int 0-384 and `tuning` object; `buildBuilderArgv` appends `--max-hour=N` and tuning flags; job `targetHours` = `buildFullHoursForModel(model).filter(h => h <= maxHour)`)
- Test: `tests-node/render-selection-args.test.js` (max-hour filtering), `tests-node/local-artifact-actions.test.js` (wire validation + argv assembly via injected spawn capture)

**Interfaces:**
- Wire body additions: `maxHour?: number|null` (null/absent = full), `tuning?: { workerCount?: 1-48, totalFrameConcurrency?: 1-64, rangeConcurrency?: 1-64, decodeConcurrency?: 1-8 } | null`. Reject non-integer/out-of-range with 400. Tuning maps to `--worker-count`, `--total-frame-concurrency`, `--range-concurrency`, `--decode-concurrency`.
- Selection-flag parity rule untouched: full category selection still emits no `--categories/--severe-tier/--winter-tier`.

### Task 4: Multi-run queue (server)

**Files:**
- Modify: `scripts/lib/local-artifact-server.js` (`validateRenderSelection` accepts `runs[model]` as string OR string[]; `groupModelsByRun` explodes to (run → models) groups; group launch order: `latest` first, then run ids descending — newest first)
- Test: extend `tests-node/local-artifact-actions.test.js` (multi-run request spawns N chained jobs newest-first; 409 covers every group before any spawn; duplicate run ids deduped)

**Interfaces:** response `{ jobId, jobs: [{ jobId, models, run }] }` unchanged in shape; jobs array now ordered newest-first and may contain several entries per model.

### Task 5: Render panel client — tuning, max hour, multi-run, cancel/dismiss, cache section

**Files:**
- Modify: `next/src/config/render.ts` (RenderSelection gains `maxHour: number|null`, `tuning: RenderTuning|null`; `runs` values become `string[]`; normalize migrates legacy string; serialize emits new wire)
- Modify: `next/src/core/actions-client.ts` (`postCancelJob`, `fetchCacheStats`, `postCachePrune`, `postCacheClear` typed clients)
- Modify: `next/src/hooks/useRenderActions.ts` (canceled terminal status; `cancelJob`, `dismissJob`; expose cache ops with busy state + post-op force-refresh of runs/manifests like render-done path)
- Modify: `next/src/components/RenderMenu.tsx` (Frames section: Full / ≤48 h / ≤24 h / custom number input; Tuning section: Auto | Production preset (18 workers · 48 queue · 3 range · 2 decode) | Custom with bounded numeric inputs; run rows become multi-toggle with per-model "queued newest-first" note; job rows get Cancel (queued/running) and Dismiss (terminal) buttons; Cache section: total + per-model sizes, Prune preview→confirm flow showing "frees X GB", Clear with typed CLEAR confirm)
- Test: `tests-react/render-menu.spec.js`, `tests-react/render-actions.spec.js` extensions; new `tests-react/cache-panel.spec.js`

**Interfaces (consumes):** Tasks 1-4 wire contracts. estimateCost frame proxy scales by `min(maxHour, model.maxHour)`.

### Task 6: Global toast surface

**Files:**
- Create: `next/src/components/ToastHost.tsx` + `next/src/hooks/useToasts.ts` (module-level store + `pushToast({ tone: "error"|"success"|"info", title, detail?, actionLabel?, onAction? })`, auto-expire 8 s, stacked bottom-right, dismiss button, aria-live polite)
- Modify: `next/src/App.tsx` (mount host), `useRenderActions.ts` (job failed/canceled/done + cache op outcomes push toasts), `MapPanel.tsx` manifest/run errors push error toast once per error transition
- Test: `tests-react/toasts.spec.js`

### Task 7: Full permalink + viewport persistence + Copy link

**Files:**
- Modify: `next/src/core/url-state.ts` (encode/decode: view, hour, timeline mode, per-panel `p1`,`p2`,… = `model:layer+layer2`, viewport `c=lat,lon,z`)
- Modify: `next/src/config/session.ts` (persist viewport center/zoom per view)
- Modify: `next/src/App.tsx`, `MapPanel.tsx`/map-panel Leaflet setup (apply restored viewport; report moveend)
- Modify: `next/src/components/AppHeader.tsx` (Copy link button → clipboard + success toast)
- Test: `tests-react/url-state.spec.js` extensions (round-trip 2 panels + viewport; legacy params still parse)

### Task 8: Parameter accuracy tooltips

**Files:**
- Create: `next/src/config/parameter-caveats.ts` — static map keyed by parameter key: reflectivity precip-type instantaneous; effectiveBulkShear 0-6 km proxy; rolling accumulations run-start until window fills; gridded DCAPE/Cobb reduced levels; gridded CIN no 500 mb cap vs point; snowfall members need complete profiles; CAM-first labeling. Sources: `plan.md` + methodology audits (cite doc name in a comment per entry).
- Modify: `next/src/components/map-panel/PanelChrome.tsx` parameter menu rows: ⓘ affordance with popover text when a caveat exists.
- Test: `tests-react/parameter-caveats.spec.js`

### Task 9: Four-panel compare

**Files:**
- Modify: `next/src/App.tsx` (MAX_PANELS 2→4; grid: 1 col / 2 cols / 2×2; Add Map disabled at 4)
- Modify: `next/src/hooks/useTimelineController.ts` (overlap = intersection across N panels; track picker lists all panels)
- Modify: `next/src/hooks/useViewportSync.ts` (N-way sync), `next/src/config/panels.ts` (persist up to 4)
- Test: `tests-react/panel-collection.spec.js` extensions

### Task 10: Cross-panel hover numeric diff

**Files:**
- Create: `next/src/core/hover-bus.ts` (tiny pub/sub: `{ lat, lon, sourcePanelId } | null`)
- Modify: `next/src/components/MapPanel.tsx` + hover grid module (publish on hover; subscribe when 2+ panels: sample own hover grid at broadcast lat/lon, render mirrored crosshair + readout row `value (Δ±x vs Panel N)` for parameter keys shared with source panel at same valid time; Δ only when both finite)
- Test: `tests-react/hover-diff.spec.js`

### Task 11: Sounding export (PNG + clipboard)

**Files:**
- Modify: `next/src/components/SoundingDrawer.tsx` (Export PNG / Copy image buttons: serialize the Skew-T + hodograph SVG(s) to canvas on dark bg, `canvas.toBlob` → download `sounding_<model>_<run>_f<hour>_<lat>_<lon>.png`; clipboard via `navigator.clipboard.write` with graceful fallback toast when unavailable)
- Test: `tests-react/sounding-drawer.spec.js` extension (export button produces a download event in Playwright)

### Task 12: Sounding comparison overlay

**Files:**
- Modify: `next/src/components/SoundingDrawer.tsx` (Compare control: pick model (≠ current, from loaded models) or run/hour variant; fetch second profile via existing sounding client at same lat/lon + nearest valid-time hour; overlay secondary T/Td traces (distinct hue, dashed) + secondary hodograph trace + compact A/B table for key indices: SBCAPE/SBCIN/MLCAPE/MUCAPE/SRH01/SRH03/Shear06/PWAT/LCL; clear/close resets)
- Possibly extract: `next/src/components/sounding/compare.ts` helpers if drawer file growth is unwieldy
- Test: `tests-react/sounding-compare.spec.js`

### Task 13: Docs + verification + independent review

- Update `README.md` (new endpoints/UI), `plan.md` (durable decisions: prefix-only frame subsets, canceled status, cache endpoint guards), memory files.
- Full validation baseline (all commands above) + live drive via Playwright MCP against the real stack (`npm run dev`), dry-run-only against real cache.
- Independent review: `/code-review` at high effort on the branch diff; fix confirmed findings; commit.
