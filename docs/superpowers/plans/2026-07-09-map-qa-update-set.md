# Map QA Update Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the owner-approved post-migration QA set: 2 hPa detailed isobars, exclusive border modes with basemap width/color controls, Stage A pan bounds, P1–P3 hygiene, and the four meteorological-soundness fixes.

**Architecture:** Four disjoint workstreams (S: server synoptic renderer, E: map engine + display settings/UI, P: pan bounds, H: doc/DX hygiene) that touch non-overlapping files and can run in parallel; each workstream is internally sequential. Spec: `docs/superpowers/specs/2026-07-09-map-qa-update-set-design.md`.

**Tech Stack:** Node (`node --test`), TypeScript/React (Vite), MapLibre GL 5.24, Playwright.

## Global Constraints

- Branch: `map-qa-update-set` (already created). Commit per task; never push.
- `shared/synoptic-style-v1.json` is public-mirrored and **shape-frozen**: do not add/remove/rename fields; do not change values (simple mode must keep 4/8 hPa from it).
- Simple-mode synoptic MSLP/thickness contour geometry must stay byte-identical **except** where Tasks S2/S4/S5 intentionally change centers/smoothing — every intentional diff must be named in the task's commit message.
- Full gate: `npm test` (node tests + `tsc --noEmit` + eslint --quiet + prettier check + Playwright smoke). Renderer-only quick gate: `node --test tests-node/synoptic-*.test.js`.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- If `git commit` fails on `index.lock` (parallel workstreams), wait 2s and retry.

---

## Workstream S — server synoptic renderer

Files owned: `scripts/lib/synoptic-render.js`, `scripts/lib/noaa-beta-renderer.js`, `tests-node/synoptic-*.test.js` (new + existing), `docs/superpowers/specs/2026-07-09-map-qa-update-set-design.md` (§6c wording fix).

### Task S1: 2 hPa detailed isobars via derived style

**Files:**
- Modify: `scripts/lib/noaa-beta-renderer.js` (~line 898 region; calls at :914-925 and :928-938)
- Test: `tests-node/synoptic-detailed-interval.test.js` (create)

**Interfaces:**
- Produces: module const `DETAILED_SYNOPTIC_STYLE` used by both detailed `renderSynopticArtifacts` calls; detailed vector `styleVersion` becomes `"<jsonVersion>+mslp2"`.

- [ ] **Step 1: Write the failing test.** In `tests-node/synoptic-detailed-interval.test.js`, require `scripts/lib/synoptic-render.js` directly. Build a synthetic MSLP grid (e.g. 120×80, `1016 - 18*exp(-((x-cx)^2+(y-cy)^2)/(2*20^2))` — a ~998 hPa low on a 1016 field) and a null thickness grid. Call `renderSynopticArtifacts` twice: once with `loadSynopticStyle()` + `detailMode:"detailed"`, once with a derived style `{...style, styleVersion: style.styleVersion + "+mslp2", mslp: {...style.mslp, minorIntervalHpa: 2}}`. Assert: (a) derived-run isobar levels (from `vector.isobars.lines[].value` — decode via the payload's line meta) include at least one level `≡ 2 (mod 4)` (e.g. 1002 or 1006); (b) every level `% 2 === 0`; (c) lines with `value % 8 === 0` have `kind === "mslp-major"`, others `"mslp-minor"`; (d) the un-derived run has only `% 4 === 0` levels; (e) `loadSynopticStyle().mslp.minorIntervalHpa === 4` after building the derived object (no mutation).
- [ ] **Step 2: Run** `node --test tests-node/synoptic-detailed-interval.test.js` — the derived-style assertions PASS already (the renderer honors style input); what must FAIL is a final assertion you add against `noaa-beta-renderer.js`: require it and assert its exported test hook `_testDetailedSynopticStyle` exists with `mslp.minorIntervalHpa === 2` and `styleVersion` ending `"+mslp2"`. Expected: FAIL (`_testDetailedSynopticStyle` undefined).
- [ ] **Step 3: Implement.** In `noaa-beta-renderer.js`, next to the `SYNOPTIC_STYLE` module const:

```js
// Detailed-mode MSLP interval override (owner decision 2026-07-09): thin
// isobar every 2 hPa, bold every 8 — high-density with WPC-style major
// emphasis. The shared style JSON is shape-frozen (public mirror) and feeds
// simple mode byte-identically, so the override lives at this call site.
// The +mslp2 styleVersion suffix marks detailed vectors so stale caches are
// distinguishable from rebuilt ones.
const DETAILED_SYNOPTIC_STYLE = Object.freeze({
  ...SYNOPTIC_STYLE,
  styleVersion: `${SYNOPTIC_STYLE.styleVersion}+mslp2`,
  mslp: Object.freeze({ ...SYNOPTIC_STYLE.mslp, minorIntervalHpa: 2 }),
});
```

Replace `style: SYNOPTIC_STYLE` with `style: DETAILED_SYNOPTIC_STYLE` in BOTH detailed calls (:923 and :937). Leave the simple call (:912) untouched. Export `_testDetailedSynopticStyle: DETAILED_SYNOPTIC_STYLE` alongside the existing `_test*` exports (see :1900 region).
- [ ] **Step 4: Grep the client for styleVersion gating** — `grep -rn "styleVersion" next/src/` — confirm nothing rejects unknown versions (expected: value is carried, not compared; if a comparison exists, make it prefix-tolerant and note it in the commit).
- [ ] **Step 5: Run** `node --test tests-node/synoptic-detailed-interval.test.js tests-node/synoptic-geojson.test.js tests-node/synoptic-center-refinement.test.js` — all PASS.
- [ ] **Step 6: Commit** `feat(synoptic): detailed-mode isobars at 2 hPa minor / 8 hPa major`.

### Task S2: physical-units (km) H/L center detection

**Files:**
- Modify: `scripts/lib/synoptic-render.js` — `detectPressureCenters` (:883-995), its call site (~:258-266), `selectDistinctCenters` (:1254-1278), `resolveOpposingCenterOverlaps` (:1316-1342), `includeGlobalPressureExtrema` margin (:1280-1314)
- Test: `tests-node/synoptic-center-detection-scale.test.js` (create)

**Interfaces:**
- Consumes: `estimateGridSpacingKm(bounds, width, height)` (already in synoptic-render.js).
- Produces: `detectPressureCenters(values, width, height, style, refinement, spacingKm)` — new trailing param; curation helpers likewise take `spacingKm`.

Physical constants (name them exactly, top of the centers section, with this comment block):

```js
// H/L detection scales in PHYSICAL units (audit 2026-07-09): the legacy
// fixed cell counts meant ~1000 km windows on the simple grid but ~64 km on
// the detailed grid — a 15× mismatch. Kilometre targets, converted per grid
// and clamped to sane cell counts, gate both modes on the same synoptic
// scale. Prominence 1.8 hPa over a 300–500 km annulus ≈ the classic "at
// least one closed 2 hPa isobar" center-marking rule.
const CENTER_DETECTION_RADIUS_KM = 400; // strict-extremum disc
const CENTER_RING_INNER_KM = 300; // prominence annulus (background env)
const CENTER_RING_OUTER_KM = 500;
const CENTER_SAME_KIND_MIN_KM = 450; // distinct same-kind systems
const CENTER_OPPOSING_MIN_KM = 300; // H/L pair suppression radius
```

- [ ] **Step 1: Write the failing test.** Synthetic field 200×120 over CONUS-like bounds (`{north:53,south:21,west:-129,east:-63}`): two lows of equal 8 hPa depth at 350 km separation and a third at 900 km. Assert with the new signature: (a) coarse grid (25×15 resample of the same field) and fine grid detect the SAME number of lows (the 350 km pair merges to one on both — same-kind min 450 km; the 900 km one stays distinct); (b) a shallow 1.2 hPa dimple is rejected on both grids. Expected: FAIL (signature/behavior).
- [ ] **Step 2: Implement.** In `detectPressureCenters`: `const radius = clamp(Math.round(CENTER_DETECTION_RADIUS_KM / spacingKm), 1, 24)`; ring inner/outer likewise (inner ≥ 1, outer ≥ inner+1, outer ≤ 32). **Perf guard (renderer hot path):** stride-sample large discs — `const stride = Math.max(1, Math.floor(radius / 4));` and build `offsetsWithinRadius(radius, true, stride)` / `offsetsInAnnulus(inner, outer, stride)` variants that skip offsets where `dx % stride || dy % stride` — keeps sample counts near the legacy 9×9 cost on the detailed grid (the field is Gaussian-smoothed, so stride sampling cannot miss a real extremum by more than ε). Keep `ringCount >= 8` (relax to `>= 6` only if the coarse-grid annulus yields fewer — assert actual count in the test). `selectDistinctCenters`: min distance `Math.max(2, Math.round(CENTER_SAME_KIND_MIN_KM / spacingKm))` cells. `resolveOpposingCenterOverlaps`: `Math.max(2, Math.round(CENTER_OPPOSING_MIN_KM / spacingKm))`. Thread `spacingKm` from `renderSynopticArtifacts` (it has `targetBounds`, `pressureCols/Rows`; compute once: `estimateGridSpacingKm(targetBounds, pressureCols, pressureRows)`).
- [ ] **Step 3: Run the new test + `tests-node/synoptic-center-refinement.test.js`.** Refinement tests exercise detection; update any fixture expectations that legitimately change and NAME each in the commit body. PASS.
- [ ] **Step 4: Perf sanity:** `node -e` micro-bench detection on a 360×221 grid < 150 ms. Record the number in the commit body.
- [ ] **Step 5: Commit** `fix(synoptic): H/L detection scales in km, not grid cells`.

### Task S3: height contours on the detailed grid

**Files:**
- Modify: `scripts/lib/noaa-beta-renderer.js` `renderHeightContourLayer` (:1698-1714)
- Test: extend `tests-node/synoptic-detailed-interval.test.js`

- [ ] **Step 1: Failing test.** Via the exported `_testRenderHeightContourArtifacts` (:1900): render a synthetic 500 mb height field (sinusoidal trough, 1600-col input is unnecessary — use 400×240) at `detailMode:"simple"` vs `"detailed"` with interval 6; assert the detailed run's longest contour has ≥ 3× the vertex count (resolution actually used) and that `renderHeightContourLayer`-level behavior switches: add `_testRenderHeightContourLayer` export if not present, assert its output vector `gridMode === "detailed"`… simpler concrete assertion: contour vertex counts. Expected: FAIL while the layer still passes `detailMode:"simple"`.
- [ ] **Step 2: Implement.** In `renderHeightContourLayer`: `heightGrid: buildSynopticDetailGridPayload(values, width, height)` and `detailMode: "detailed"`. Check `renderHeightContourArtifacts`'s `drawImage` default — if the PNG raster from this path is consumed (grep the caller for `.image`/`rgba` use), keep it; if only `.vector` is consumed (the `rendered?.vector ? rendered : null` return suggests so), pass `drawImage:false` and note the perf win in the commit.
- [ ] **Step 3: Run** the test file + `npm run test:local-runtime` (noaa-beta.test.js exercises the full artifact build). Update any golden expectations; name them. PASS.
- [ ] **Step 4: Commit** `fix(synoptic): height contours render from the detailed-cap grid (was 25×15)`.

### Task S4: honest simple-mode smoothing + fallback drift

**Files:**
- Modify: `scripts/lib/synoptic-render.js` `smoothPressureField` (:755-763), `smoothHeightContourField` (:765-774), fallback strings (:25, :304, boundaryColor fallback :182)
- Modify: `docs/superpowers/specs/2026-07-09-map-qa-update-set-design.md` §6c (wording: skipping the floor-clamped Gaussian slightly SHARPENS simple-mode fields — it is an intentional visual change, not a no-op)
- Test: extend `tests-node/synoptic-center-detection-scale.test.js`

- [ ] **Step 1: Failing test.** Field where σ policy is inert: spacing 250 km, model gfs (σ 60 km → 0.24 cells). Assert `smoothPressureField` output === input values array (reference or element-equal). Expected: FAIL (floor clamp currently smooths at 0.6).
- [ ] **Step 2: Implement.** Before the clamp: `const rawSigmaCells = sigmaKm / Math.max(1e-6, spacingKm); if (rawSigmaCells < 0.6) return values;` with comment: the 64× downsample has already low-passed far beyond the per-model σ policy; the floor-clamped kernel was silent extra smoothing. Same guard in `smoothHeightContourField`. Align fallback strings: `"v1-operational-contrast"` → `"v4-operational-contrast"` (:25, :304); `"#7A1FA2"` → `"#6A1B9A"` (:182) — fallbacks only fire without the JSON; aligning removes drift.
- [ ] **Step 3: Run** all `tests-node/synoptic-*.test.js` + `npm run test:local-runtime`; update/name any legitimately changed expectations. PASS.
- [ ] **Step 4: Commit** `fix(synoptic): skip inert sub-floor Gaussian in simple mode; align style fallbacks`.

### Task S5: model-honest center refinement precision

**Files:**
- Modify: `scripts/lib/synoptic-render.js` — refinement constants (:1024-1026), `buildCenterRefinementContext` (:1029-1065), `refineCenterAgainstField` (:1089-1192); thread `modelKey`
- Test: extend `tests-node/synoptic-center-refinement.test.js`

- [ ] **Step 1: Failing test.** Build a display grid that upsamples a coarse 27 km field bilinearly with a small interpolation ripple (add ±0.05 hPa sawtooth at display resolution). Assert refined GFS (`modelKey:"gfs"`) center lands within one NATIVE cell (27 km) of the coarse-field minimum and does NOT chase the ripple; assert `modelKey:"nam3km"` behavior on the existing fixtures is unchanged. Expected: FAIL.
- [ ] **Step 2: Implement.**

```js
// Native grid spacing per model (km): refinement must not report positions
// sharper than the source physics. Presmooth σ scales with native spacing so
// GFS (0.25° ≈ 27 km) centers stop resolving bilinear-upsample ripples at
// ~4 km false precision; the 3 km nests keep the tuned behavior.
const MODEL_NATIVE_SPACING_KM = { gfs: 27, nam: 12, nam3km: 3, hrrr: 3 };
```

`presmoothSigmaKm = Math.max(CENTER_CLIMB_PRESMOOTH_SIGMA_KM, (MODEL_NATIVE_SPACING_KM[modelKey] ?? 6) / 2)`; snap radius already derives from presmooth σ (`snapRadiusPx ≈ 2·presmoothσ`) so it follows. Thread `modelKey` through `buildCenterRefinementContext` (callers already have it).
- [ ] **Step 3: Run** `node --test tests-node/synoptic-center-refinement.test.js` and the full synoptic set; reconcile `docs/synoptic-center-refinement.md` expectations if its tables are asserted anywhere (name diffs). PASS.
- [ ] **Step 4: Commit** `fix(synoptic): center refinement precision capped by model native grid spacing`.

---

## Workstream E — map engine, display settings, menu UI

Files owned: `next/src/core/map-engine/maplibre-engine.ts`, `next/src/core/map-engine/types.ts`, `next/src/core/map-engine/basemap-style.ts`, `next/src/config/display.ts`, `next/src/components/DisplayMenu.tsx`, `next/src/components/map-panel/use-map-display-layers.ts`, `tests-node/basemap-style.test.js`, display-settings node test file (locate via `grep -rl "normalizeDisplaySettings" tests-node/`), `tests-react/display-menu.spec.js`.

### Task E1: engine hygiene (P1a, P1b, P2c, P2d)

**Files:** Modify `maplibre-engine.ts` (:1031-1037, :1436-1461, :1563), `types.ts` (:57), `tests-node/basemap-style.test.js` (:88-96 comment only).

- [ ] **Step 1 (P1b, type-first):** In `types.ts:57` change `opacity?: number | ZoomCurve` → `opacity?: number` on `SymbolLayerStyle` ONLY (line layers keep curves). Run `npm run typecheck` — expect errors at `symbolOpacityValue` (:1436-1461): simplify it to the number-only path (delete the ZoomCurve branch). Re-run typecheck: clean.
- [ ] **Step 2 (P1a):** At the recreate-cap early-return (:1031-1037): before emitting the fatal, tear down the dead map — call the same disposal `destroy()` uses for the map instance (`map.remove()` + clearing `this.map` and any listeners/registries destroy clears; read `destroy()` at :335 and extract a private `disposeMap()` if the logic is >3 lines, used by both). The panel banner path must still work (fatal emitted after disposal).
- [ ] **Step 3 (P2c):** `:1563` `console.error` → `console.warn` (message unchanged).
- [ ] **Step 4 (P2d):** In `tests-node/basemap-style.test.js:88-96` correct the size rationale: "~57 KB per theme" → "~208 KB per theme (~416 KB total, measured 2026-07-09)"; keep the pin-the-whole-array decision, stating it survives at the true size because layer-set drift is exactly what it exists to catch.
- [ ] **Step 5: Run** `npm run typecheck && node --test tests-node/basemap-style.test.js && npx eslint next/src/core/map-engine --quiet`. PASS.
- [ ] **Step 6: Commit** `fix(engine): dispose dead map at recreate cap; ban symbol opacity curves at type level; quieter stale-image log; true snapshot size`.

### Task E2: basemap boundary layer ids + engine verb

**Files:** Modify `basemap-style.ts`, `maplibre-engine.ts`, `types.ts` (MapEngine interface). Test: `tests-node/basemap-style.test.js`.

**Interfaces (produced, exact):**

```ts
// basemap-style.ts
export function basemapBoundaryLayerIds(style: StyleSpecification): string[]; // ["boundaries_country","boundaries"], fail-loud console.error if empty
// types.ts (MapEngine)
export interface BasemapBoundaryStyle { visible: boolean; widthScale: number; color: string | null; } // color null = theme default
setBasemapBoundaries(style: BasemapBoundaryStyle): void;
```

- [ ] **Step 1: Failing test.** In `tests-node/basemap-style.test.js`: `basemapBoundaryLayerIds(buildLightStyle("x.pmtiles"))` returns exactly the set `{"boundaries_country","boundaries"}`; both are `type:"line"`. Run — FAIL (helper missing).
- [ ] **Step 2: Implement the helper** mirroring `basemapRoadLayerIds` (:237-246) with pattern `/^boundaries(_country)?$/` and the same fail-loud empty check. Test PASSES.
- [ ] **Step 3: Engine verb.** In `maplibre-engine.ts`: instance field `private basemapBoundaries: BasemapBoundaryStyle = { visible: true, widthScale: 1, color: null };`. On style build/load, capture each boundary layer's ORIGINAL `line-width` and `line-color` from the generated style spec (before user scaling) into a map `boundaryLayerBase: Map<string, {width: number; color: unknown}>` — widths are plain numbers (0.7/0.4), colors theme-dependent. `setBasemapBoundaries(s)` stores and calls `applyBasemapBoundaries()`, which for each id: `map.setLayoutProperty(id, "visibility", s.visible ? "visible" : "none")`, `map.setPaintProperty(id, "line-width", base.width * s.widthScale)`, `map.setPaintProperty(id, "line-color", s.color ?? base.color)`. Call `applyBasemapBoundaries()` from `applyLoadedStyle()` right after `applyBasemapLayerVisibility()` (:1243) so theme switches and context-loss recreates re-assert it. Guard every call on style-loaded the same way `applyBasemapLayerVisibility` does.
- [ ] **Step 4:** `npm run typecheck && node --test tests-node/basemap-style.test.js`. PASS.
- [ ] **Step 5: Commit** `feat(engine): setBasemapBoundaries verb (visibility, width scale, color) re-asserted across style reloads`.

### Task E3: exclusive border modes + settings + Display menu

**Files:** Modify `display.ts`, `use-map-display-layers.ts`, `DisplayMenu.tsx` (:172-242 Borders block). Tests: display-settings node test (locate), `tests-react/display-menu.spec.js`.

**Interfaces (settings shape):** `boundaries` gains `basemapWidthScale: number` (0.5–3, default 1) and `basemapColor: string` (`"auto"` or `#rrggbb`, default `"auto"`). `DISPLAY_SCHEMA_VERSION` 4 → 5 (comment documents: v5 added basemap-boundary width/color + exclusive modes).

- [ ] **Step 1: Failing node test:** normalize a legacy v4 payload without the new fields → defaults (`1`, `"auto"`); clamp `basemapWidthScale: 9` → 3; invalid color → `"auto"`. FAIL.
- [ ] **Step 2: Implement settings** in `display.ts`: add fields to all three presets, `cloneDisplaySettings`, `normalizeDisplaySettings` (`clampNumber(raw, base, 0.5, 3)`; color: `normalizeColor` result or `"auto"`), bump `DISPLAY_SCHEMA_VERSION = 5` with comment. Node test PASSES.
- [ ] **Step 3: Exclusive-mode policy** in `use-map-display-layers.ts`: in the `setBasemap` effect (or a dedicated effect keyed on `display.boundaries.mode`, `basemapWidthScale`, `basemapColor`, `mapReady`), call `engine.setBasemapBoundaries({ visible: display.boundaries.mode === "basemap", widthScale: display.boundaries.basemapWidthScale, color: display.boundaries.basemapColor === "auto" ? null : display.boundaries.basemapColor })`. Comment: owner decision 2026-07-09 — one border source at a time; auto/reference draw the NE overlay so OSM lines hide; off means off.
- [ ] **Step 4: Menu UI** in the Borders block of `DisplayMenu.tsx`: a "Basemap weight" `MenuSlider` (min 0.5, max 3, step 0.1) and a color row reusing the `DISPLAY_BOUNDARY_COLORS` swatches plus an "Auto" swatch, both `disabled={display.boundaries.mode !== "basemap"}`, wired via the block's existing `updateNested("boundaries", …)` pattern.
- [ ] **Step 5: Playwright:** extend `tests-react/display-menu.spec.js`: (a) mode=basemap → slider enabled; mode=reference → disabled; (b) via the test bridge (see how the spec already asserts engine state; follow its pattern) assert `boundaries_country` visibility is `none` in reference mode and `visible` in basemap mode.
- [ ] **Step 6: Run** `npm run typecheck && node --test tests-node/*.test.js && npx playwright test -c playwright.react.config.js tests-react/display-menu.spec.js --reporter=line`. PASS.
- [ ] **Step 7: Commit** `feat(display): exclusive border modes; basemap border width/color controls (schema v5)`.

---

## Workstream P — Stage A pan bounds

Files owned: `next/src/config/constants.ts`, `next/src/components/map-panel/use-panel-map.ts`, `tests-react/viewport-sync.spec.js`.

### Task P1: decouple pan cage from fit bounds

- [ ] **Step 1:** In `constants.ts` add below `VIEW_CONFIG`:

```ts
// Stage A pan bounds (docs/basemap-expansion-plan.md): panning is capped by
// BASEMAP COVERAGE (the PMTiles extract bbox, prepare-basemap.js NA_BBOX),
// not by the active view's data bbox — the view bbox stays the FIT target
// only. Fixes the min-zoom force-zoom cage (MapLibre constrains zoom up
// when maxBounds is narrower than the viewport). Stage B widens these after
// the re-extract.
export const PAN_BOUNDS = { south: 7, west: -170, north: 74, east: -45 } as const;
```

- [ ] **Step 2:** In `use-panel-map.ts`: import `PAN_BOUNDS`; at :224 `engine.setMaxBounds(view.bounds)` → `engine.setMaxBounds(PAN_BOUNDS)` (keep `setMinZoom(view.zoom)`); update the effect's comment. Consider the creation-time `maxBounds: WORLD_GEO_BOUNDS` at :117 — leave as-is (the view effect immediately narrows it; note this in the comment).
- [ ] **Step 3:** Update `tests-react/viewport-sync.spec.js` — the :28 comment ("maxBounds = the view bounds") and any assertion that pans against the old cage; assert the new behavior: from the CONUS default fit, pan west until center lon < −135 succeeds at min zoom (previously impossible).
- [ ] **Step 4: Run** `npm run typecheck && npx playwright test -c playwright.react.config.js tests-react/viewport-sync.spec.js --reporter=line`. PASS.
- [ ] **Step 5: Commit** `feat(map): Stage A pan bounds — NA-wide panning decoupled from view fit bounds`.

---

## Workstream H — DX/doc hygiene (P3e, P3f)

Files owned: `next/src/core/url-state.ts`, `scripts/prepare-basemap.js`.

### Task H1: comments + error message

- [ ] **Step 1:** `url-state.ts` near :67 and :83 — comment: any `zs` value other than `"2"` (including a future `"3"`) parses as LEGACY leaflet zoom (`rawZoom − 1`); a future scale bump must extend the explicit whitelist here AND keep emitting the old marker for back-compat links.
- [ ] **Step 2:** `prepare-basemap.js` :177-182 — extend both size-guard messages: "…Most often this means the download/extract was interrupted (partial file). Delete <file> and re-run; resume is not supported."
- [ ] **Step 3:** `npx eslint scripts/prepare-basemap.js next/src/core/url-state.ts --quiet` then commit `chore: zs forward-compat note; partial-download hint in prepare-basemap`.

---

## Integration phase (sequential, after all workstreams)

### Task I1: full gate + artifact rebuild + live verify

- [ ] `npm test` (full: node + typecheck + lint + format + smoke). Fix fallout.
- [ ] `npm run test:react` (full Playwright suite). Fix fallout.
- [ ] Rebuild synoptic artifacts for one cached frame (`npm run noaa:build:test`, or the render control panel selective build for the synoptic category on the latest cached run) and live-drive with the `verify` skill: detailed mode shows 2 hPa isobars with 8 hPa bolds and clean labels at CONUS zoom; simple mode unchanged visually except centers; heights smooth; borders exclusive + slider/color live; NA-wide pan at min zoom.
- [ ] Screenshot the detailed synoptic view for the PR.

### Task I2: adversarial review

- [ ] Meteorological-soundness review by a fresh subagent judging ONLY against operational-analysis standards (intervals, anchoring, center gating physics, precision honesty, label/emphasis conventions) with the diff + screenshots.
- [ ] `superpowers:requesting-code-review` on the whole branch diff. Fix both reviews' findings; re-run gates.

### Task I3: PR

- [ ] `superpowers:finishing-a-development-branch` → push branch, `gh pr create` with summary, verification evidence, screenshots, and the intentional-diff ledger (every simple-mode byte change named with its cause).
