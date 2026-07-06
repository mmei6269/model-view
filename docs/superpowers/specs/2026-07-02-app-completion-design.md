# Model View — App Completion Design

Date: 2026-07-02
Status: Approved by owner (this session)
Scope owner decisions (2026-07-02):

- Deployment: personal tool, this Mac only. No hosting, no LAN sharing, no mobile layout.
- Ingestion: manual builds stay. Add cache retention/pruning, a one-command update, and UI staleness surfacing. No background daemon.
- Science: keep current audited trade-offs untouched (0-6 km EBWD proxy, masked MUCAPE-only elevated instability, reduced-level gridded DCAPE/Cobb). No formula/threshold/gating changes anywhere in the render path.
- Hidden products (plan.md list): stay hidden; record the rationale in plan.md.
- Geography: CONUS only. `na` view config stays dormant; renderer guards against invalid model/view combos.

Structure: four correctness-first phases. Each phase lands green (typecheck, lint --quiet, node tests, react smoke, format:check on touched files) before the next starts. Renderer-touching changes use the golden-frame byte-parity protocol; the two intentional output-changing fixes (P1.6, P1.10) get correctness spot-verification instead, with all other products held byte-identical.

## Phase 1 — Correctness

Critical:

1. Stale manifest under wrong label — `next/src/hooks/useManifest.ts` (+ `MapPanel.tsx` consumption): reset manifest/frame state when model/run/view deps change; surface manifest fetch failures as a visible per-panel error state with retry; never render prior-model frames under a new model label or show "Ready" on error.
2. Manifest shrink on partial builds — `scripts/lib/local-artifact-manifest.js` + `local-artifact-runtime.js`: partial-hours builds merge frames (union by hour) into an existing run manifest instead of replacing the frame set. Unit-tested against fixture manifests.
3. FrameWorkerPool respawn — `scripts/lib/local-artifact-concurrency.js`: on worker exit/error, reject the in-flight job, remove the dead worker, respawn (bounded restart budget), fail the build loudly if the budget is exhausted. No job may be posted to a terminated worker.
4. Path traversal — `scripts/lib/local-artifact-server.js` / `local-artifact-runtime.js` asset resolution: resolve requested paths and require containment within the artifact root; reject otherwise (404).
5. Shared-AbortSignal race — `next/src/core/artifact-client.ts` (+ `frame-prefetch.ts` interaction): deduped in-flight fetches must not bind the first caller's signal. Refcount consumers; abort the underlying fetch only when every consumer has aborted; a consumer abort rejects only that consumer. Regression test: prefetch stop must not clear another panel's synoptic vector/hover grid.

High:

6. Snow lazy-fallback NaN — `scripts/lib/noaa-beta/winter.js` (~line 152): pass `bounds` to `buildSnowfallInGrids` on the fallback path. Output-changing bug fix: verify affected snow products produce finite grids and spot-check values; all other products byte-identical.
7. `latest.json` flip semantics — `scripts/lib/local-artifact-runtime.js`: verify current behavior first; then make `latest--<view>.json` advance only when the new run is usably complete (build finished, or a completeness threshold), while in-progress runs remain selectable via the run list. Must not regress progressive frame display for a manually selected in-progress run.
8. `isLayerKey` hardcode — `next/src/config/layers.ts`: derive the key set from the shared config layer order so configured snow layers are included in LAYER_STACK_ORDER and warmup.
9. Silent renderer fallbacks — `scripts/lib/noaa-beta/grib-source.js` (bulk-decode fallback, regrid-bin write failures), `selection.js` (snow model parse failures): add warn logs + profile counters. No behavior change.
10. NAM precip planner past f36 — `scripts/lib/noaa-beta/accumulation.js`: verify the suspected hourly-candidate issue on NAM's 3-hourly cadence past f36; if real, plan candidates on model-native cadence. Output-changing only where currently broken; verify with a targeted NAM build.
11. Frame status chips — `next/src/components/map-panel/use-frame-status.ts`, `frame-prefetch.ts`: 'loading' only while a fetch is actually in flight; introduce an 'error' state; make loaded-key tracking reflect cache eviction rather than being monotonic.
12. Browser memory budgets — `next/src/core/image-prefetch-cache.ts`, `latest-run-memory-cache.ts`: LRU budgets with concrete defaults (2 GiB object-URL, 4 GiB decoded; overridable via VITE_ env), warmup scoped to on-screen panels' layer sets rather than all models × layers × gates × modes.
13. Latest-cycle cache TTL — `scripts/lib/noaa-beta/grib-source.js` in-process idx/selected-GRIB caches: short TTL for the most recent cycle's URLs; completed cycles may stay pinned.

Medium:

14. Hover readout flicker — `MapPanel.tsx` hover card pointer-events + `use-leaflet-map.ts` mouseout interplay.
15. Cache-root env split-brain — accept one canonical `MODELVIEW_CACHE_ROOT` everywhere with `MODELVIEW_NOAA_BETA_CACHE_ROOT` as deprecated alias (warn); `local-dev.js` loads `.env` like the data server does.
16. `--date` without `--cycle` — `scripts/lib/noaa-build/run-resolution.js`: error out instead of silently rendering 00Z.
17. Playwright `reuseExistingServer` — gate on `!process.env.CI`.
18. Settings drawer clipping + custom timezone — `AppHeader.tsx`: remove the fixed max-height clip; a stored custom IANA zone renders as a labeled option instead of an unmatched select.
19. Run-list fetch errors surfaced in the panel UI — `MapPanel.tsx`.

Low (fix only where provably wrong; keep parity elsewhere):

20. Calm-wind direction display (point-sounding.js), mislabeled `rangeConcatMs` profile stage (grib-source.js), dead `atomic`/renderMode-guard options, `setPanelCounter` inside a state updater (usePanelCollection.ts). Investigate the latent step-scale bucket-0 miscolor (raster.js); fix only with proof + parity validation on unaffected products.

Documented-not-changed: gridded-vs-point effective-inflow CIN cap difference (severe.js) — recorded in plan.md as an accepted gridded compute trade-off.

## Phase 2 — Ops

1. `npm run noaa:update` — one command for daily use: resolve the latest available run per model (gfs, nam, nam3km, hrrr; `--models=` filter), build only missing frames (no `--force`), print a per-model outcome summary, then run pruning. Reuses existing availability probing (`run-resolution.js`) and `.complete.json` resume.
2. Cache retention — `npm run cache:prune` + auto-run after `noaa:update`:
   - Keep artifacts (tiles/manifests/synoptic/hover) for the last 4 runs per model per view — preserving run-selector history.
   - Keep raw `selected-grib-v2` (and derived-grid caches) only for the latest run per model; prune older.
   - Optional `MODELVIEW_CACHE_BUDGET_GB` total ceiling: delete oldest prunable data beyond it.
   - `--dry-run` prints what would be deleted and sizes. Never touches `output/noaa-benchmarks`, `output/noaa-debug`, `output/noaa-beta-tools`.
   - The existing dead `pruneStaleRuns` is replaced by this (it deletes run-selector history and is unused).
3. Staleness surfacing — UI: per-panel run age chip ("HRRR 12Z · 3 h old"; green/amber/red thresholds scaled per model cadence) and a passive "newer run likely available — run `npm run noaa:update`" hint computed from cycle cadence vs now. No browser-to-NOAA requests.
4. Non-dev serving path: CORS headers on the artifact server; `vite preview` gets the same `/__cf` proxy as dev; ETag/304 + short-TTL stat-cache for manifest completeness checks (currently thousands of fs.stat per manifest read, every 5 s per client); `npm run start` = data server + built app preview.

## Phase 3 — UX completion

1. Persistence (localStorage, following the existing `config/display.ts` pattern): view key, per-panel model + layer selections, synoptic toggles (isobars/centers/thickness/detail mode), reflectivity gate, viewport link, timeline mode, settings-drawer open state. Model/layer/hour additionally mirrored to URL query params for bookmarking (URL wins over storage on load). Pinned runs intentionally reset to latest on reload (pinned runs may be pruned away).
2. Default frame = valid time nearest to now (prefer available frames), replacing the F000 default.
3. Playback: do not display never-loaded frames as stale imagery — default behavior holds on the frame with a loading indicator until it decodes, with a "skip unloaded" toggle as the alternative; playback speed control (0.5×/1×/2×); prev/next frame buttons; dwell-on-last-frame before loop.
4. Keyboard: ← / → frame step, Space play/pause, Esc closes sounding drawer and open menus, ? opens help. Shortcuts disabled while typing in inputs.
5. Sounding drawer: follow-timeline mode (auto-resample on selected-hour change, debounced; off by default with a visible toggle); on model/run change either refresh or clear with an explicit notice — never silently stale; Esc close; recenter-map affordance for manually entered coordinates.
6. Error/empty states: friendly per-panel manifest and run-list error cards with retry; humanized toast for artifact errors (no raw multi-URL dumps); empty-cache onboarding hint ("No runs built yet — run npm run noaa:update").
7. Timeline: day-boundary date labels, scrub tooltip with full valid time, existing status chips gain the error state from P1.11.
8. Chrome: favicon + title + meta description; help popover documenting hover readout, double-click soundings, keyboard map, staleness chips; menu outside-click dismissal; aria labels for play button and hour chips; Add-Map disabled-state tooltip.

## Phase 4 — Tests, CI, docs

1. `npm test` composite script: node tests → typecheck → lint --quiet → format:check → react smoke.
2. Fix current `format:check` failures (PanelChrome.tsx, config/layers.ts + 4 others); add generated/vendored paths (shared/noaa-beta-planned-color-maps.json, tools/noaa-beta/**) to `.prettierignore`.
3. New tests: manifest merge (P1.2), pruning dry-run inventory (P2.2), worker respawn (P1.3), abort-race regression (P1.5), SoundingDrawer Playwright spec scripted from the validated manual recipe (fixture cache + on-demand sounding endpoint), frame-status lifecycle spec.
4. GitHub Actions workflow: install, lint, typecheck, node tests, vite build on push/PR. Fixture-based; no NOAA network. React smoke included if fixture generation is CI-feasible; otherwise documented as local-only.
5. Doc repairs:
   - DCAPE version chain: mark v2/v3 audit sections superseded, point to v4 as current.
   - Benchmark history: remove the landed libdeflate entry from pending candidates.
   - Validation log: add entries for the 2026-06-11 DCAPE v4 / Bunkers / critical-height fixes; retitle the stale "Latest" section.
   - README: add wgrib2 prerequisite to Quick Start; document `noaa:update` + `cache:prune` as the daily flow; remove the manifest-shrink footgun caveat once P1.2 lands.
   - Env docs: `.env.example` rewritten to variables the code actually reads (drop MODELVIEW_DEFAULT_VIEW / MAX_PREGENT_Z / DYNAMIC_MIN_Z; add WGRIB2 path, canonical cache root, MODELVIEW_PNG_DEFLATE_BACKEND, key MODELVIEW_NOAA_* knobs, MODELVIEW_CACHE_BUDGET_GB); migration checklist aligned.
   - plan.md: refresh with today's durable decisions (hidden products stay hidden + rationale; CONUS-only; science trade-offs affirmed; CIN-cap note; retention policy).
   - Note MODEL_CONFIG GFS frameStepHours=3 as manifest-fallback-only.
6. Repo hygiene: delete the 13 fully-merged branches (verified zero unmerged work); package.json `engines` field.

## Constraints (unchanged, load-bearing)

- Public-mirror rule: no deletion/renaming of public palette exports, generated palette JSONs, or scale constants — even if unreferenced here.
- Exactness rule: renderer changes hold byte-for-byte artifact parity unless the change is an approved bug fix, in which case only the affected product may change and its new output is verified for correctness.
- Accuracy-first: no heuristic fills; products stay manifest-gated by required inputs.

## Non-goals

Ingestion daemon/launchd, mobile/responsive layout, public hosting/deploy pipeline, science methodology changes, un-hiding products, `na` view enablement, new parameters.
