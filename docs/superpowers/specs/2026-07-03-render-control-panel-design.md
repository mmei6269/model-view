# Render Control Panel + Point-Sounding Prefetch — Design

Date: 2026-07-03
Status: Approved decisions locked (this session); spec pending owner review
Branch: app-completion (continues after Phase 1 correctness work)

## Goal

Turn the read-only viewer into an app that can trigger **selective** NOAA builds from the UI: pick models and runs, toggle parameter categories on/off, and choose a compute tier within the two expensive families (severe, winter) so an analyst renders only what they need. Plus a point-sounding GRIB prefetch (CLI + UI) so hover soundings are instant instead of a ~5 s on-demand download.

## Owner decisions (locked 2026-07-03)

1. **Severe "simple" tier drops DCAPE** in addition to effective-layer SCP/STP (all parcel-integration work skipped in simple). **Winter "simple" keeps Kuchera** (widely used, cheaper than the ML/Cobb products) and drops only the RF ML model, Western-Linear, and Cobb.
2. **Defaults**: all categories on, both tiers `full`. A default render reproduces today's complete product set; skipping is opt-in.
3. **Persist** the last render selection (models/categories/tiers/run-mode) in localStorage, following the existing `config/display.ts` / `config/timezone.ts` pattern. A reset-to-default affordance is provided.
4. **7 merged categories** (not the 9 raw catalog groups): the render panel controls build/compute scope at the workflow-family level; fine-grained per-product control for *display* already lives in the map panel's parameter menu. Severe thermo+kinematics merge into one Severe toggle; upper-air height/wind/temp + omega/vorticity merge into one Upper Air toggle.
5. **Strictly user-initiated** — no auto-build/cron trigger (consistent with the earlier "manual builds + pruning" decision). Localhost-only.

## Non-goals

Auto-ingestion daemon; remote/hosted use; per-parameter *build* selection (display selection already exists); changing any product's math (skipping omits, never approximates); mobile layout.

---

## 1. Render-selection model

### 1.1 Category taxonomy (7)

Derived from the catalog's `group` field (9 groups → 7 owner categories) via a `GROUP_TO_CATEGORY` map:

| Category id | Merges group(s) | ~count | Tiered? |
|---|---|---|---|
| `surface` | Surface & Boundary Layer (incl. WIND alias) | 10 | no |
| `precip` | Precipitation | 7 | no |
| `radar` | Radar | 3 | no |
| `cloud` | Clouds & Ceiling | 2 | no |
| `severe` | Severe: Thermodynamics + Severe: Kinematics | 21 | **yes** |
| `winter` | Winter / Snow & Ice | 12 | **yes** |
| `upperAir` | Upper Air: Height/Wind/Temp + Omega/Vorticity | 24 | no |

### 1.2 Tier cut (simple vs full)

`costTier` is an **explicit owner-decided set of "full-only" keys**, not a pure heuristic — the owner is making product calls (which SLR methods and severe composites are worth the compute), so membership is an authored constant with a documented rationale, overridable per key. The heuristic (`artifactRequired` OR deep profile OR self-flagged expensive parcel work) is the *default rationale* for any future product, but the authored set is the source of truth so an owner exception like Kuchera is a one-line entry, not a heuristic fight.

- **Winter full-only (dropped in simple):** `snowRfConus`, `snowWesternLinear` (HRRR-only), `snowCobb`. **Simple keeps** (incl. the owner Kuchera exception): `snowKuchera`, `wetBulbZeroHeight`, `snowDepth`, `snowWaterEq`, `snowHrrrAsnow`, `freezingRainLiquidTotal`, `snow10to1`, `framFlatIce`, `framRadialIce`. Note `snowKuchera` has a deep profile so the bare heuristic would call it `full`; the authored set overrides it to `simple` (decision 1).
- **Severe full-only (dropped in simple):** `effectiveLayerSupercellCompositeParameter`, `effectiveLayerSignificantTornadoParameter`, `dcape` (per decision 1). **Simple keeps** all direct CAPE/CIN/SRH/UH fields plus the cheap x6-profile composites/shears (`bulkShear0to6km`, `effectiveBulkShear`, `supercellCompositeParameter`, `significantTornadoParameter`, `lapseRate*`, `surfaceThetaE`, `surfaceBasedLclHeight`).

Coupling guard: the cheap direct CAPE/SRH/LCL inputs that the kept simple composites chain on already live in the simple set — verified, so simple severe is self-consistent.

A test pins the exact `full`-tier membership (the 3 winter + 3 severe keys above) and asserts `snowKuchera` is `simple`.

### 1.3 Metadata (one source of truth)

Extend `noaa-nam-parameter-catalog.js` `freezeEntry` to stamp `category` (via `GROUP_TO_CATEGORY`) and `costTier` on every entry, and surface both in `getNoaaNamParameterMetadata()`. `costTier` = `"full"` iff the key is in an authored `FULL_TIER_KEYS` set (`snowRfConus`, `snowWesternLinear`, `snowCobb`, `effectiveLayerSupercellCompositeParameter`, `effectiveLayerSignificantTornadoParameter`, `dcape`), else `"simple"` — the authored set is the source of truth (the §1.2 heuristic is documented rationale only). Both the builder and the UI read this — no second table. A client-side parity test guards against drift between the catalog and any client mirror.

### 1.4 Selection wire contract

```json
{
  "models": ["hrrr", "nam3km"],
  "view": "conus",
  "run": "latest",
  "categories": {
    "surface": true, "precip": true, "radar": false, "cloud": true,
    "severe":  { "enabled": true, "tier": "simple" },
    "winter":  { "enabled": false, "tier": "full" },
    "upperAir": true
  }
}
```

Resolution: an entry renders iff its category is enabled AND (`costTier === "simple"` OR the category tier is `full`). Non-tiered categories treat tier as `full`.

---

## 2. Builder selectivity

### 2.1 Choke point

`filterCatalogForRenderMode(catalog, renderMode)` (`selection.js:134`) feeds `selectNoaaNamParameterRecords` at `noaa-beta-renderer.js:302/308` — the per-frame product list. Extend it to `filterCatalogForRenderMode(catalog, renderMode, selection?)`: after the existing mode split, filter by `selectionAllows(selection, entry)`. Fetch/decode/compute/encode all cascade off for excluded products.

### 2.2 Gate group-branched derived builders

Heavy derived stages are branched by `renderMode`, not group, so the catalog filter alone won't skip their *compute*. Guard each with a `selectionWantsCategory` check: if `winter` off, skip `buildWinterDerivedInputGrids`/snowfall/freezing-rain builders (`renderer:513/538/567`); pass the filtered catalog subset to `buildDerivedParameterGrids` (`:595`) so severe effective-layer/dcape work runs only for surviving entries.

### 2.3 CLI flags

Add to `parseArgs` (`build-noaa-beta-artifacts.js:749`), back-compatible (omitted ⇒ all/full = today's behavior):
- `--categories=surface,precip,cloud,severe,upperAir` (allowlist; unknown ⇒ non-zero exit)
- `--severe-tier=simple|full` (default `full`)
- `--winter-tier=simple|full` (default `full`)

### 2.4 Manifest representation

Partial renders are already native (shorter `parameterOrder` ⇒ partial `layers`; no schema change for omission). Add one additive manifest field `renderSelection: { categories, builtAt }` written **only for a supplied selection** — a no-flags / full-selection default build omits the field entirely, so its manifest stays byte-identical to today (absent `renderSelection` ⇒ full render, which also matches every legacy manifest). The UI reads a present `renderSelection` to distinguish *intentionally omitted* (simple tier / category off) from *data-gated unavailable*. Implemented as of B.3: the default build must pass `null` (not a normalized full selection) so the field is absent. Re-render coherence: when a new selection's layer set differs from an existing partial run's `renderSelection` (e.g. simple → full on the same run), the render endpoint passes `--force`. **Exactness preserved:** a dropped category yields no layer; kept products compute at full fidelity.

---

## 3. Server action layer

Extend `handleRequest` (`local-artifact-server.js:37`) with `/actions/*` branches before the 404 fallthrough. GET routes stay read-only; mutating actions are POST (manual `req` stream read + `JSON.parse`).

### 3.1 Endpoints
| Method + path | Purpose |
|---|---|
| `GET /actions/available-runs?models=&view=` | Built runs (`listRunManifests`) + upstream HEAD-probed candidates (`buildRecentCycleCandidates` + `noaaForecastHourExists`/`resolveNoaaModelRun`), cached |
| `POST /actions/render` | Validate §1.4 selection → build argv → spawn builder; returns `{jobId}` |
| `POST /actions/prefetch-soundings` | Body `{model, run, view, hours?}` → spawn prefetch; returns `{jobId}` |
| `GET /actions/status/:jobId` | Job progress from registry + on-disk marker count |
| `GET /actions/jobs` | List active/recent jobs (panel re-attach after reload) |

### 3.2 Spawn + jobs
Spawn `process.execPath` with an **argv array (`shell:false`)** — no shell string. Reuse the `local-dev.js:20` spawn pattern; marshal flags like `build-noaa-beta-recent-runs.js` `pushDefaultArg`. In-memory `Map<jobId, {status, model, run, view, pid, built, reused, failed, total, log[], error}>`. Progress from (1) live stdout scrape of the builder's `logNoaaProgress` frame lines + final JSON summary, and (2) an on-disk `.complete.json` marker count fallback (denominator = the build's resolved hours, NOT union-manifest length). Track children so the existing SIGINT/SIGTERM shutdown kills them (no zombies). Reject a second job for the same `(model, run, view)` while one is running.

### 3.3 Security
- **Loopback only** (`127.0.0.1`) — the primary control now that the server spawns processes. Do not bind `0.0.0.0`; do not add permissive CORS.
- Validate every path-like arg with `isSafePathComponent` (Task 4.x) before it reaches spawn/fs; allowlist `model`/`view`/`category`/`tier` enums; 400 on anything else; 405 on wrong method.

---

## 4. UI control panel

### 4.1 Component + mount
New `next/src/components/RenderMenu.tsx`, modeled on `DisplayMenu.tsx` (backdrop + glass panel, reusing `MenuSelect`/`MenuCheckbox`), as a right-side **drawer** (a build is long-lived). A "Render" button in the `AppHeader` cluster opens it. State lifts into `App.tsx` (`renderMenuOpen`, `renderSelection`), mirroring `displayMenuOpen`; `renderSelection` persists via localStorage (decision 3).

### 4.2 Data sources
- Models/views from `constants.ts`; category tree client-side from catalog `group`/`category` metadata (parity-tested against the server catalog).
- Runs from `GET /actions/available-runs` (upstream + built) and the existing `useModelRuns` hook for built runs.

### 4.3 Cost hint
Coarse **Light / Moderate / Heavy** badge from a static per-product weight (heavy `full` = 3, simple-profile = 1, direct = 0.2) × models × frame count. No fake seconds; subtext notes severe/winter full-tier and cold builds cost most.

### 4.4 Hooks
- `useAvailableRuns(models, view)` — poll `/actions/available-runs` (copy `useModelRuns` interval pattern).
- `useRenderJob(jobId)` — poll `/actions/status/:jobId` ~2 s; on `done`, force-refresh runs + manifests (`{forceRefresh:true}`) so artifacts appear immediately.

### 4.5 Layout (mockup)
```
┌─ RENDER ───────────────────────────────────────── [x] ┐
│  MODELS   [✓] HRRR  [✓] NAM3km  [ ] NAM  [ ] GFS       │
│  VIEW     (CONUS ▾)                                    │
│  RUN      (•) Latest available   ( ) Pick from list…  │
│  CATEGORIES                                            │
│    [✓] Surface (10)   [✓] Precip (7)   [ ] Radar (3)   │
│    [✓] Clouds (2)     [✓] Upper Air (24)              │
│    [✓] Severe   tier: (•)Simple ( )Full   (21)        │
│         └ Full adds: Effective SCP/STP, DCAPE (heavy)  │
│    [ ] Winter   tier: ( )Simple (•)Full   (12)        │
│         └ Full adds: Snow RF, Western, Cobb (heavy)   │
│  EST. COST  ● Moderate  (2 models × 49 frames)  [reset]│
│  ── SOUNDINGS ──  [ Prefetch soundings for run ]      │
│              [ Cancel ]        [ ▶ Render ]           │
│  ── JOB ── ▓▓▓▓▓▓░░░░ 22/49  built 18·reused 4·fail 0  │
└────────────────────────────────────────────────────────┘
```
HRRR/CAM-only products grey out when the model set lacks them (driven off catalog `models`).

---

## 5. Sounding prefetch

Reuse the on-demand path so prefetch and click hit the same cache. `buildNoaaPointSounding` is point-*dependent*, but the expensive part — the `selected-grib-v2` byte-range cache — is point-*independent*, so one warm per `(model, run, hour)` makes every later click at that frame decode-only.

- **CLI** `scripts/prefetch-point-soundings.js` → `npm run noaa:prefetch-soundings`. Flags `--models=` (default `nam3km,hrrr`), `--runs=latest|all|<list>`, `--view=`, `--hours=`, concurrency knobs. Enumerate loaded frames from manifests; one global `AsyncSemaphore` as `rangeFetchLimiter` (courtesy to NOAA S3); idempotent (validated cache short-circuits); progress summary (warmed / already-cached / failed / bytes). Caches raw fields only — **no** parcel diagnostics (plan.md durable decision).
- **UI** the panel's "Prefetch soundings for run" button POSTs `/actions/prefetch-soundings` and uses the same job/progress flow; no manifest refresh needed (soundings served live).

---

## 6. Phasing & task breakdown (TDD)

- **Phase A — Catalog metadata (no behavior change):** A1 stamp `category`/`costTier` + surface in metadata; A2 client parity test.
- **Phase B — Builder selectivity:** B1 `selectionAllows` + extend `filterCatalogForRenderMode`; B2 gate derived builders by category; B3 manifest `renderSelection` + superset/`--force` reuse.
- **Phase C — CLI:** C1 `--categories`/`--severe-tier`/`--winter-tier` parsed+validated+threaded; C2 `scripts/prefetch-point-soundings.js`.
- **Phase D — Server actions:** D1 available-runs; D2 render + job registry + child tracking + shutdown kill; D3 prefetch-soundings + status/jobs.
- **Phase E — UI:** E1 `RenderMenu` + header button + App state + persistence; E2 `useAvailableRuns`/`useRenderJob` + submit/poll/refresh; E3 sounding-prefetch button.

Each phase lands green (node tests, typecheck, lint, format:check on touched files, react smoke). Renderer-touching changes hold byte parity for the full-selection default (a no-flags build must remain byte-identical to today).

## 7. Relation to the app-completion phases

This subsumes the *control surface* of the original Phase 2 (build orchestration) and part of Phase 3 (UX): it makes builds selectable and observable from the app. Phases A–C are pure builder/CLI and independent. The remaining original Phase 2 (cache pruning/retention) and Phase 4 (tests/CI/docs) still stand and follow.

## Constraints (unchanged)

- Exactness: a no-flags/full-selection build stays byte-identical to today; skipping omits, never approximates.
- Public-mirror: no palette/scale export deletions/renames.
- Accuracy-first: products stay gated by required inputs; `renderSelection` records intent, doesn't fabricate.
