# MapLibre Phase-0 verdict — ImageSource animation spike (Task 0.3)

**VERDICT: updateImage** — Task 3.1 implements direct `ImageSource.updateImage()` swaps, no double-buffering.

Direct `updateImage()` on all 12 image sources (4 panels × 3 stacked weather rasters) costs ~0.2 ms
of main thread per swap batch — two orders of magnitude under the 20 ms target — and produced zero
dropped rAF frames over 60 swaps per config, including a 3 s `easeTo` pan running concurrently with
playback. Double-buffering was also comfortably green but is strictly worse: ~1.75× the main-thread
cost (extra `setPaintProperty` churn), double the source/layer count, double the GPU texture
residency, and a state machine Phase 3 doesn't need.

## Setup

- Spike: `next/src/spike/MapLibreSpike.tsx` behind `?spike=maplibre` (dev-only guard in
  `next/src/main.tsx`; both deleted in Task 6.3).
- Deps: `maplibre-gl@5.24.0` (exact), `pmtiles@^4.4.1` (resolved 4.4.1), `@protomaps/basemaps@5.7.2`
  (exact).
- Basemap: real NA extract — `pmtiles://http://127.0.0.1:5174/basemap/na.pmtiles` (15.78 GB, z0–14,
  Range route from Task 0.1), dark flavor via `@protomaps/basemaps` `layers()`/`namedFlavor("dark")`.
  Glyphs/sprite from protomaps GitHub Pages (spike-only; offline vendoring is Task 5.2).
- Weather frames: real nam3km `20260707-1800Z` conus renders, hours 000–009, layers `mlcape`,
  `wind500`, `precip6h` (1600×980 PNGs, bounds N53/S21/W-129/E-63 from the run manifest). All 30
  PNGs prefetched to blob object URLs before playback (mimics the app's image-prefetch-cache), so
  the benchmark measures swap + decode + upload cost, not network.
- Load: 625 ms/frame cadence, 6 full cycles = 60 swap batches per config; every batch swaps all
  3 layers on all panels. `raster-fade-duration: 0`, map `fadeDuration: 0`.
- Modes: `update` = `getSource(id).updateImage({url})` per slot. `doublebuffer` = two sources+layers
  per slot; per tick: toggle `raster-opacity` 0↔0.75 on the pair, then `updateImage` the now-hidden
  buffer with the next frame (back buffer pre-seeded with frame 1 so the first flip is honest).
- Instrumentation: `performance.now()` around each full swap batch; rAF-gap monitor counting gaps
  >34 ms as dropped frames (cycles phase and pan phase counted separately);
  `performance.memory.usedJSHeapSize` sampled at start, per cycle wrap, and at finish;
  `UNMASKED_RENDERER_WEBGL` from the map canvas context. Live results in an on-screen stats panel
  and `window.__spikeResults`; `window.__spikeDone` set after cycles + pan complete.
- Interaction-under-playback: after the 60 swap batches, a scripted 3 s `easeTo` pan
  (+6° lng, +2° lat) ran on every panel while the 625 ms playback kept ticking; rAF drops during it
  recorded as `panDroppedFrames`.

## How it was run

Headed Chrome via the Playwright MCP browser (navigate + `browser_evaluate` polling
`window.__spikeDone`), 1440×900 viewport, macOS. GPU verified real hardware — renderer string on
every run:

```
ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version)
```

Not SwiftShader/llvmpipe, so the numbers are valid. Zero console errors or warnings across all
four runs.

## Results (60 swap batches per config, 10 frames × 6 cycles)

| mode × panels    | sources swapped/batch | swap avg ms | swap p95 ms | swap max ms | rAF drops (cycles) | rAF drops (3 s pan) | heap MB start → end             |
| ---------------- | --------------------- | ----------- | ----------- | ----------- | ------------------ | ------------------- | ------------------------------- |
| update × 1       | 3                     | 0.13        | 0.3         | 0.4         | 0                  | 0                   | 33.97 → 25.94                   |
| update × 4       | 12                    | 0.20        | 0.4         | 0.4         | 0                  | 0                   | 55.66 → 41.41                   |
| doublebuffer × 1 | 3 (+6 opacity sets)   | 0.26        | 0.4         | 0.4         | 0                  | 0                   | 29.72 → 45.68                   |
| doublebuffer × 4 | 12 (+24 opacity sets) | 0.35        | 0.5         | 0.7         | 0                  | 0                   | 66.64 → 66.72                   |

Per-cycle heap traces (MB) — sawtooth, no monotonic growth (GC reclaims blob-decode garbage):

- update × 4: 55.66, 78.48, 58.02, 80.58, 43.25, 74.21, 63.24, 41.41
- doublebuffer × 4: 66.64, 42.47, 39.74, 41.27, 40.11, 64.96, 39.24, 66.72
- update × 1: 33.97, 41.89, 39.51, 25.73, 51.88, 28.37, 46.33, 25.94
- doublebuffer × 1: 29.72, 24.74, 47.75, 45.61, 23.94, 45.92, 46.57, 45.68

The 2-panel column was skipped per the task brief: results are not ambiguous (both modes pass every
target at 1 and 4 panels with two orders of magnitude of headroom).

## Comparison against targets

| Target                                                    | Result                                                        | Verdict |
| --------------------------------------------------------- | ------------------------------------------------------------- | ------- |
| <20 ms main-thread per swap batch at 4 panels × 3 layers   | update: avg 0.20 ms, p95 0.4 ms, max 0.4 ms                    | PASS    |
| No dropped-frame accumulation over the loop               | 0 drops in every config over 60 swaps                          | PASS    |
| Heap not monotonically growing                            | sawtooth around a flat baseline; update×4 ends below its start | PASS    |
| (bonus) interaction under playback                        | 0 drops during 3 s `easeTo` pan in every config                | PASS    |

Caveat: `updateImage()` wall time is the synchronous dispatch cost; PNG decode/texture upload
happens off the measured call. That async cost is exactly what the rAF-gap monitor would surface as
dropped frames — and it surfaced none, even with 12 concurrent 1600×980 decodes per tick plus a
camera animation.

## What Task 3.1 should implement

- One `ImageSource` + raster layer per weather slot; frame advance = `updateImage({url})` with the
  prefetched blob object URL. No ping-pong sources, no opacity toggling.
- `raster-fade-duration: 0` on every weather layer (and `fadeDuration: 0` on the map) — this is
  what keeps swaps atomic-looking; without it MapLibre cross-fades rasters.
- Keep the existing blob-object-URL prefetch cache; swap cost is independent of network by design.
- Hardware note: numbers were gathered on an Apple M5 Max. The margin (100× under target) is large
  enough that mid-tier hardware still clears it, but if a low-end regression is ever suspected,
  re-run this spike matrix — the harness stays parameterized until Task 6.3 deletes it.

## Addendum — Task 3.2 real-app-path numbers (2026-07-08)

Gate: the REAL app path must be within 2× of the spike's equivalent (update × 4: avg 0.20 ms,
p95 0.4 ms per 12-source swap batch). **PASS — the app path measured at or below the spike.**

### Method

Live dev app (`npm run dev`), real nam3km `20260707-1800Z` conus run (61 frames), four maplibre
panels (`?p1..p4=nam3km:temperature,wind,precip&engine=maplibre`), the three synoptic Display
toggles switched off so each panel runs exactly 3 weather rasters (12 sources total — the spike's
4p×3 shape), all 61 frames prefetched before measurement, 1× playback (600 ms base cadence).
Instrumentation: a TEMPORARY (not committed) `performance.now()` pair around the whole
`use-weather-overlays` frame pass — URL resolution, load-listener re-arm, and the engine's
`setWeatherImage` per layer — pushing per-pass timings to a window array read via the Playwright
MCP browser; plus an independent rAF-gap monitor (gaps > 34 ms, the spike's dropped-frame
definition). Passes were grouped into per-tick batches (4 panel passes within 200 ms = one
timeline tick = 12 `updateImage` dispatches). GPU verified real hardware, same machine as the
spike: `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version)`.

Comparison honesty: the spike timed a bare loop of 12 raw `updateImage` calls on a page with no
app; the app number below includes everything the hook does around the engine calls (and the
engine's own `setPaintProperty` + band-order microtask scheduling from Task 3.1), so it is the
STRICTER measurement of the two. Note the app's frame advance goes through `setWeatherImage`
(update path — `updateImage` with coordinates + one `setPaintProperty`), not the bare
`swapWeatherImage` verb, which still has no app caller.

### Results (160 full swap batches ≈ 100 s of playback)

| metric (4 panels × 3 layers)               | spike (raw updateImage loop) | app path (full hook pass) |
| ------------------------------------------ | ---------------------------- | ------------------------- |
| swap batch avg ms                          | 0.20                         | **0.164**                 |
| swap batch p95 ms                          | 0.4                          | **0.3**                   |
| swap batch max ms                          | 0.4                          | **0.4**                   |
| per-panel pass avg ms (3 layers)           | —                            | 0.041                     |

Per-pass p50 read 0 ms — `performance.now()` quantization (~0.1 ms) dominates individual passes;
the batch statistics are the meaningful ones.

### rAF gaps (async-side cost, disclosed)

The main-thread swap dispatch is drop-free, but the playback run recorded ~1 rAF gap per 3–4
ticks (40 over 160 ticks; typically 41.7 ms, worst 50 ms), each landing ~110–140 ms AFTER a swap
dispatch — the async fetch+decode+texture-upload window for 12 concurrent 1600×980 rasters
(Task 3.1 measured ~58 ms decode for one such PNG), stacked on the app's per-tick React commit.
Paused/idle on the same page: **0 gaps in 15 s**, so nothing ambient. The spike's zero-drop run
had no app chrome on the main thread, hence the difference. Impact assessment: a ≤50 ms stall
every ~2 s during 4-panel-full-stack playback, invisible at the 600 ms cadence (no missed ticks:
the frame label advanced through every measured batch) and absent at idle — accepted for Phase 3;
worth re-checking at Task 6.4's final gate on the default-engine flip.

### Parity screenshots

`node scripts/map-parity-shot.js --label task32 --panels nam3km:temperature --center 38.5,-96,5
--settle-ms 8000` → `output/map-parity/task32-{leaflet,maplibre}.png`. Same F021 field, same
palette and gradient detail, weather raster registered correctly against the vector basemap
coastline/labels (Gulf coast, Great Lakes, Florida). Expected differences: the documented
mixed-grid fractional-zoom boot residual (the maplibre panel sits visibly deeper than the
integer-zoom leaflet panel); basemap label styling (Protomaps dark vector vs CARTO raster);
leaflet draws the vector synoptic stack + H/L markers while maplibre shows the RASTER synoptic
fallback (Task 3.2's strangler gate) with no H/L markers until Task 4.3.
