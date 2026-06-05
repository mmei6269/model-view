# NOAA Renderer Benchmark History

This file keeps the detailed renderer benchmark chronology and optimization backlog that used to live in `plan.md`. Keep `plan.md` focused on current behavior, durable decisions, and validation expectations.

## Benchmark Fixtures

- Fixed benchmark fixture: cold full render after deleting `output/noaa-beta-cache`, exact run `20260426 12Z`, `view=conus`, models `gfs,nam,nam3km,hrrr`, full horizon, forced render, profile enabled.
- Current benchmark fixture: clear `output/noaa-beta-cache` and NOAA temp caches before every cold render; exact run `20260427 06Z`, `view=conus`, models `gfs,nam,nam3km,hrrr`, full horizon with default available-hour cap, forced render, profile enabled. April 27 06Z and 00Z both have the normal NAM `F036` cap; 06Z was used because 00Z was not more complete.

## 2026-05-10 Optimization Passes

- Implemented the first renderer optimization bundle: selected-GRIB cache paths now include a 24-char selected-record hash plus GRIB URL hash, all selected-GRIB materialization paths use the shared `selected-grib-v2` namespace, selected-GRIB cache writes use locks, SHA/byte validation, and atomic ready metadata, and selected byte chunks are written directly to their file offsets instead of `Buffer.concat`.
- Added frame decode-session plumbing for selected-GRIB promises, decoded-grid promises, parsed records, selected plans, row-remap maps, and profile counters. Snow-only modes now avoid main selected-plan construction until a materialization consumer needs it.
- NOAA `.idx` parsing now assigns next offsets in linear time, attaches lookup metadata, uses selector indexes for exact param/level lookups, defers content-length HEAD requests until a selected final record actually needs repair, and uses disk locks around raw `.idx` cache misses.
- Bulk decode now reads only needed `selected-regridded.bin` field slices, Mercator row-remap lookup tables are cached by geometry/interpolation, and cached Float32 grid reads use aligned zero-copy views with copy fallback. Multi-grid cache writes for profile/cumulative snowfall write ordered slices without concatenating.
- Precip accumulation source-grid cache handling now mirrors the snow-liquid path more closely: bounded parallel cache reads/writes, per-hour disk locks, wait-and-retry cache reads, and lock timeout counters.
- Avoid-work updates landed for target-hour snowfall profile decodes, snowfall rendering with no or fully precomputed entries, surface theta-e allocation when only severe dependencies need CAPE/shear/LCL, and resolved snowfall promise cache cleanup after settlement.
- Complete-frame fast paths now skip the post-write stat sweep for freshly persisted complete frames while preserving refreshes for partial/supplemental hover cases, and empty PNG/hover fallback artifacts are cached by shape/format.
- Validation run: `node --test tests-node/noaa-beta.test.js`, `npm run typecheck`, `npm run lint -- --quiet`, touched-file Prettier check, and `git diff --check` passed.
- Follow-up mixed-frame benchmark used `node scripts/build-noaa-beta-artifacts.js --models=gfs,nam,nam3km,hrrr --view=conus --hours-gfs=24 --hours-nam=12 --hours-nam3km=12 --hours-hrrr=6 --force --profile --global-frame-queue=true --total-frame-concurrency=4 --global-frame-concurrency=4 --worker-count=4 --range-concurrency=3 --decode-concurrency=2 --global-persist-queue=false --persist-manifest-each-frame=false` as the new baseline. Baseline wall time was 89.30s, with snow render parts dominated by cold cumulative snowfall/profile/source cache work: NAM snow 65.45s, NAM 3 km snow 55.00s, HRRR snow 38.84s, and NAM 3 km base 33.23s.
- Implemented the next safe optimization slice: snowfall liquid chunk resolution now memoizes window plans and discovers per-hour snow-liquid intervals with bounded fanout, binary hover-grid encoding direct-packs prefix/header/data into one raw buffer before gzip instead of `Buffer.concat`, and the frame decode session now keeps per-record decoded-grid hits keyed by geometry/interpolation to skip repeated all-hit decode requests.
- Re-running the same benchmark after these changes on the warmed benchmark cache completed in 15.40s wall time. Snow parts hit cumulative caches (`snowCumCache=1/1`) and finished in 0.08-0.43s, so the full wall-time drop is a warm-cache result rather than purely code-path speedup; base frame totals with selected/source/profile caches warm were GFS 8.40s, NAM 8.00s, NAM 3 km 14.46s, and HRRR 13.64s.
- Next implementation-only pass added a specialized wgrib simple-inventory parser and selected-plan ordinal mapping for bulk decode, so duplicate/submessage rows can map directly to binary output ordinals with the richer `.idx` parser used only where needed.
- Interval snowfall now builds all requested supported methods in one active-cell pass per chunk/profile hour, reusing per-profile method state and preserving the existing per-method builders as parity oracles.
- Follow-up micro-optimizations landed for typed bounded active-cell descriptors, one-term/two-term precip accumulation composition fast paths, fused mm-to-inch snow-liquid chunk composition, single-sample phase-mask composition, two-grid run-max merge, and hash-first cache metadata validation for profile/cumulative/source grid caches.
- A cold benchmark was started with a fresh cache root, then stopped at user request to avoid taking over CPU. No new benchmark result should be treated as accepted for this pass; the user will run the comparable cold benchmark locally.
- Previous validation for that pass: `node --test tests-node/noaa-beta.test.js` passed with 90 tests.
- Current snow-prefix pass folded snow-delta precompute into the base split task, replaced the split snow-delta scheduler job with an ordered `snow-prefix` job, and made snow PNG rendering wait on prefix caches rather than building cumulative snowfall prefixes inline.
- Snowfall cumulative prefix building now has an exact iterative cache path for snowfall only: it reads the prior prefix cache when available, merges the current delta cache in chronological order, and leaves run-max prefix planning for a later pass.
- The base snow/FRAM path now batches same-hour winter profile decodes through a frame-session union queue, while preserving each consumer's requested record keys and profile prerequisites. Broader profile union outside this touched path remains future work.
- Snow and winter accumulation builders now clear large source-grid, liquid-chunk, and profile maps after their final local consumer. Render profiles keep/report `snowDelta`, `snowfallCumulative`, `profileDecode`, decoded-record hits, `snowCumCache`, and wall-time labels.
- Validation for the snow-prefix pass: `node --test tests-node/noaa-beta.test.js` passes with 91 tests; `npm run typecheck`, `npm run lint -- --quiet`, touched-file Prettier check, and `git diff --check` passed.
- Current run-max prefix pass added ordered `runmax-prefix` precompute jobs ahead of render work for forecast hours with gust/UH run-max dependencies. Render work for those hours waits on the same-hour run-max prefix marker, while run-max prefix jobs wait only on the prior run-max prefix hour.
- Run-max cumulative grids now use the exact iterative prefix-cache path: read the prior prefix cache when present, otherwise build prior prefixes chronologically, then merge the current source grid with the existing finite/`NaN` carry-forward semantics.
- Precip and freezing-rain accumulation planning now warms and reuses exact per-target planner outputs/chunk paths only. It does not introduce precip/freezing-rain cumulative grid prefixes yet; source priority, phase-mask completeness, direct `FRZR` preference, APCP fallback rules, and missing-value behavior stay unchanged.
- Validation for the run-max/planner pass: `node --check scripts/lib/noaa-beta-renderer.js`, `node --check scripts/build-noaa-beta-artifacts.js`, `node --test tests-node/noaa-beta.test.js` passes with 94 tests, `npm run typecheck`, `npm run lint -- --quiet`, touched-file Prettier check, and `git diff --check` passed.
- Current shared source/decode registry pass added bounded per-run cache stores keyed by model/product/base URL/date/cycle. The renderer now registers exact source grids for precip accumulation, snow-liquid, freezing-rain liquid/FRAM liquid, and profile-grid consumers after cache hits or fresh decodes.
- The raw decoded-record grid cache is now run-local and keyed by hour, selected record identity, target geometry, wgrib interpolation, row interpolation, and categorical/fractional interpolation policy. Main selected decodes seed it, while run-max, precip, snow-liquid/freezing-rain, and profile paths check it before rematerializing selected GRIBs.
- Same-hour profile decode union is now the default frame-session behavior unless explicitly disabled by the union worker itself. Winter, FRAM, and broader profile consumers can share exact selected records without changing required profile levels, source priority, finite/`NaN` handling, or categorical precipitation-mask accuracy.
- Render profiles now keep/report source/profile registry hit counters alongside the existing `snowDelta`, `snowfallCumulative`, `profileDecode`, decoded-record hits, `snowCumCache`, and wall-time labels.
- Validation for the shared source/decode registry pass: `node --check scripts/lib/noaa-beta-renderer.js`, `node --check scripts/build-noaa-beta-artifacts.js`, `node --test tests-node/noaa-beta.test.js` passes with 94 tests, `npm run typecheck`, `npm run lint -- --quiet`, touched-file Prettier check, and `git diff --check` passed.

## Active Optimization Candidates

This backlog only lists optimizations not already described as landed in the 2026-05-10 passes above. Rankings are ordered by expected reward-to-risk: earlier items should generally be tried first, assuming parity coverage is available.

1. [High reward / Medium risk] Add a per-worker hour decode batcher keyed by interpolation policy, with nearest precip-type masks kept separate from bilinear/fractional masks.
2. [High reward / Medium risk] Cache post-wgrib regridded binary and inventory outputs for exact selected subsets, keyed by selected-record hash, view geometry, interpolation policy, renderer signature, and wgrib2 identity.
3. [High reward / Medium risk] Add per-hour packed source-grid caches for snow-liquid, precip accumulation, freezing-rain, and profile grids after the individual-cache path remains stable.
4. [High reward / Medium-high risk] Add precip/freezing-rain cumulative-prefix grid caches, preserving source priority, phase-mask completeness, direct FRZR preference, APCP fallback rules, and missing-value behavior.
5. [High reward / Medium-high risk] Share reduced-profile column work across severe, DCAPE, lapse-rate, shear, and winter RF/linear snowfall calculations without changing formulas, fallback levels, or interpolation semantics.
6. [High reward / High risk] Parallelize independent post-main derived builders once selected/source-grid cache locks are reliable, then merge results deterministically with duplicate-key assertions.
7. [High reward / High risk] Decode winter phase-fraction packs once per hour/window/sample set, then emit snow, freezing rain, rain, and sleet target grids while preserving current summation order and NaN rules.
8. [High reward / High risk] Fuse multi-output accumulation composition where plans share source grids and cell semantics, starting with same-family APCP-only plans and keeping generic composition as the oracle.
9. [Medium-high reward / Low risk] Precompile per-run render, hover, persistence, artifact-path, and manifest-ref descriptor plans so frame code can plug in bodies and byte counts without rebuilding object/path walks.
10. [Medium-high reward / Low risk] Hydrate static run metadata into workers once per model/run/view, then dispatch frame tasks by metadata key, hour, and mode to reduce structured-clone CPU and GC.
11. [Medium-high reward / Low risk] Add directory-level source-grid cache indexes for warm cache-heavy runs, preserving payload hash and metadata validation.
12. [Medium-high reward / Low risk] Add bounded-parallel warm/reuse artifact completeness and stat refreshes, preferably via a single-pass frame-directory stat index before falling back to individual stats.
13. [Medium-high reward / Medium risk] Fold availability probing into shared .idx prefetch so availability checks and renderer workers share raw index cache setup and identical missing-hour behavior.
14. [Medium-high reward / Medium risk] Prepare run-level selected-record manifests from prefetched .idx files and have workers verify them against index content before reuse.
15. [Medium-high reward / Medium risk] Add a bounded in-build range-chunk promise cache keyed by full GRIB URL plus byte range, cleared at build or run boundaries.
16. [Medium reward / Low risk] Return finite and visibility counters from derived-grid builders that already scan every cell, avoiding separate inclusion scans.
17. [Medium reward / Low risk] Add null-input raster fast paths before allocating full RGBA buffers for scalar and reflectivity-variant paths.
18. [Medium reward / Low risk] Bound per-build NOAA .idx, content-length, and canonical-record caches by run key or max entries, keeping disk/raw cache as the durable source.
19. [Medium reward / Low-medium risk] Add exact frame-session affine/unit transform caches for repeated mm-to-inch and similar transforms across precip, snow-liquid, snowfall, and freezing-rain consumers.
20. [Medium reward / Low-medium risk] Build concrete frame geometry tables for row latitude, column longitude, Coriolis terms, spacing/cos-lat helpers, and Mercator-derived helpers beyond the row-remap cache.
21. [Medium reward / Low-medium risk] Cache exact catalog source transforms shared by PNG and hover generation when raw/affine semantics are identical, excluding presentation-smoothed or categorical layers.
22. [Medium reward / Low-medium risk] Normalize RF snowfall model structures into typed arrays once per run and reuse typed feature scratch while preserving sklearn and fixture parity.
23. [Medium reward / Medium risk] Avoid blanket Float32Array.fill(NaN) in hot loops where every cell is assigned, with Object.is parity tests for NaN, -0, zero, trace, and clamp cases.
24. [Medium reward / Medium risk] Reuse worker-local scratch directories and transient Float32Array/PNG raw buffers with deterministic per-task cleanup and clear overwrite semantics.
25. [Medium reward / Medium risk] Make large artifact buffers more transfer-friendly by centralizing owned-buffer decisions and preserving cached transparent PNG transfer safety.
26. [Medium reward / Medium risk] Reduce synoptic/contour allocation churn through lazy empty-output allocation, endpoint-indexed contour chaining, coordinate lookup tables, direct rasterization, cached RGBA paint parsing, direct vector encoding, and chunked string assembly.
27. [Medium reward / Medium risk] Make FRAM environment work sparse without reducing decoded coverage, validating positive, zero, NaN, missing synthetic chunks and a real freezing-rain frame.
28. [Medium reward / Medium risk] Iterate exact sparse candidate-index lists for effective severe diagnostics while keeping dense profile products on their current paths.
29. [Medium reward / Medium risk] Make split snowfall tasks worker-sticky by model/run/view/hour while preserving dependency ordering, task outputs, and retry behavior.
30. [Medium reward / Medium risk] Retry only failed split render parts when dependency markers make that conservative, instead of rebuilding base, snow-prefix, and snow indiscriminately.
31. [Medium reward / Medium risk] Add a measured global wgrib2/stage token system for subprocesses, range fetches, artifact CPU, and persistence; accept only if cold wall time and CPU utilization improve with byte-identical outputs.
32. [Medium reward / Medium-high risk] Evaluate class-based direct write throttles for large PNG/hover binaries, small JSON sidecars, and completion markers; prior global persist-queue experiments regressed.
33. [Medium reward / High risk] Evaluate worker-direct persistence only after byte-count and interruption semantics are hardened.
34. [Medium reward / High risk] Validate a one-pass wgrib2 regrid/export pipeline; reject if duplicate/submessage order, inventory rows, or decoded Float32Array values differ.
35. [Low-medium reward / Low risk] Avoid duplicate detailed synoptic rendering on simple-empty fallback by reusing or delaying detailed work without changing final vector/image content.
36. [Low-medium reward / Low risk] Evaluate content-addressed writes for immutable empty artifacts while preserving artifact keys, byte refs, and completion-marker semantics.
37. [Low-medium reward / Medium risk] Replace full finite-grid sorts in distribution-stat helpers with exact deterministic selection while preserving percentile rounding, duplicate handling, NaN filtering, and clamp semantics.
38. [Low-medium reward / Medium risk] Replace staged NOAA selection object cloning with a transactional overlay that preserves all fallback priorities.
39. [Low-medium reward / Medium risk] Reuse current-frame APCP water grids for APCP-derived snow and freezing-rain source paths only where record identity and interpolation policy exactly match; verify whether the new shared registry already covers this before implementing.
40. [Low-medium reward / High risk] Coalesce adjacent NOAA byte ranges only if selected-record ordering and synthetic record indexing remain exact and byte comparisons pass.
41. [Low reward / High risk] Explore scalar PNG and hover-grid fusion only for layers with identical raw/affine semantics; keep it demoted until parity harnesses prove it safe.
42. [Low reward / High risk] Explore custom/direct PNG filter-0 scanline encoders, RGBA scratch pooling, packed Uint32 RGBA writes, and lazy visible-pixel allocation only after decode/cache work stops dominating.

Rejected unless new benchmarks prove otherwise: reflectivity gate fan-out, higher global frame/persist concurrency, and decoupled persistence queues.

## Scheduler History

- Cold per-model scheduler baseline: `real 350.53s`, `user 2525.71s`, `sys 389.69s`, 276/276 frames, 0 failures.
- Cold global-frame-queue run: `real 338.25s`, `user 2498.75s`, `sys 381.79s`, 276/276 frames, 0 failures.
- Implemented scheduler path treats the full run as one global frame workload, interleaves all models, starts long forecast hours early, schedules retries through the same queue, and logs queue depth plus worker-pool stats during `--profile`.
- The old per-model scheduler produced a long GFS-only tail. The global queue kept all 24 render workers busy until much later, but the final tail still appears once remaining frame count drops below worker count or frames leave workers and spend time in post-worker artifact persistence.

## Early Renderer Findings

- The largest remaining cold-render costs were renderer efficiency issues rather than source/website loading:
  - After the renderer hot-path pass, final default cold run averages were about `catalogPng=3.6s`, `synoptic=4.1s`, `hoverGrid=1.6s`, and `persist=7.4s` per frame.
  - NAM 3km high-hour accumulated precipitation remained expensive because source grids and composition can involve many APCP records.
  - Manifest persistence is now deferred by default for global full runs, but artifact writes still showed occasional multi-second spikes.
- Additional optimization findings:
  - Detailed synoptic vectors still render and persist, but detailed synoptic raster drawing is skipped when the simple raster is used for the PNG layer.
  - Detailed NOAA beta synoptic vectors now use a bounded contour grid instead of the full PNG raster grid. Simple and detailed vector payloads are still both generated/persisted; the cold profile dropped average `synoptic` time to about `0.32s/frame`.
  - Catalog scalar renders now use affine numeric transforms for common unit conversions instead of per-pixel JS callbacks, and step-color lookups use binary search.
  - Worker-to-main artifact transfer avoids an extra buffer copy when encoded artifacts already own their `ArrayBuffer`.
  - Frame artifact files now write directly while the per-frame completion marker and manifests remain atomic. The marker is removed before frame artifact persistence and restored only after all artifacts succeed, so interrupted forced renders are not treated as complete.

## Persist Queue And Concurrency Experiments

- Experimental decoupled persistence is available behind `--global-persist-queue`, but it is disabled by default after cold tests showed worse wall time and CPU utilization from write backpressure.
- Increasing persist concurrency/backlog to `16/96` was a failed experiment: it produced `real 309.99s` and much worse CPU utilization.
- A later decoupled persist retest with direct writes + bounded synoptic (`8/96`) was stopped early: render stayed busy, but persistence fell far behind (`persisted=9/83`, backlog `66/96`), implying a large final drain rather than a real wall-time win.
- Increasing `--global-frame-concurrency` to `96` was also stopped early: it kept workers busy but inflated per-frame materialize/decode costs and lagged the 48-slot run.

## Point-Hover Optimization Pass

- Latest renderer state after point-hover support for all public parameters:
  - Cold baseline on `20260427-0600Z`: `real 230.37s`, `user 2277.99s`, `sys 364.59s`, 276/276 frames, 0 failures.
  - Baseline averages: `artifacts=11.29s/frame`, `artifactPrep=0.76s`, `corePng=1.49s`, `catalogPng=3.76s`, `hoverGrid=5.05s`, `persist=0.22s`.
  - Implemented hover/math hot-path pass: affine grid transforms replace callback transforms for common unit conversions, `1-h precip` inches conversion is one pass instead of two, scalar raster affine transforms avoid a per-pixel helper call, and hover-grid quantization avoids full missing-value fills while using raw/affine/function-specialized loops.
  - Optimized cold render on `20260427-0600Z`: `real 205.86s`, `user 2082.16s`, `sys 368.37s`, 276/276 frames, 0 failures.
  - Optimized averages: `artifacts=9.24s/frame`, `artifactPrep=0.20s`, `corePng=1.38s`, `catalogPng=3.60s`, `hoverGrid=3.82s`, `persist=0.25s`.
  - Net result: wall time improved by `24.51s` / `10.6%`; user CPU dropped by `195.83s` / `8.6%`; artifact-stage average dropped `18.2%`; hover-grid average dropped `24.4%`.

## Scalar/Wind Optimization Pass

- Implemented scalar/wind hot-path pass: scalar rastering now uses raw/affine/function-specialized loops for continuous and stepped layers, avoiding per-pixel transform branches in common paths; catalog wind layers and wind hover grids share cached speed grids instead of rebuilding the same magnitude arrays.
- Scalar/wind optimized cold render on `20260427-0600Z`: `real 176.93s`, `user 1890.56s`, `sys 336.49s`, 276/276 frames, 0 failures.
- Scalar/wind optimized averages: `artifacts=7.86s/frame`, `artifactPrep=0.14s`, `corePng=1.09s`, `catalogPng=3.07s`, `hoverGrid=3.36s`, `persist=0.14s`, `materialize=3.68s`, `decode=2.86s`.
- Net result versus the `20260427-0600Z` point-hover baseline: wall time improved by `53.44s` / `23.2%`; user CPU dropped by `387.43s` / `17.0%`; total CPU dropped by `415.53s` / `15.7%`; artifact-stage average dropped `30.4%`; core PNG average dropped `26.8%`; catalog PNG average dropped `18.4%`; hover-grid average dropped `33.5%`.
- Rejected reflectivity gate fan-out experiment after the `176.93s` run: combined gate rastering reduced repeated reflectivity-loop work on paper but caused visibly worse CPU utilization and was aborted/reverted. Keep reflectivity variants on the independent scalar-render path unless a future implementation proves it keeps worker CPU saturated on a full cold render.
- Rejected scalar visibility-bound hoist experiment after the `176.93s` run: a full cache-cleared `20260427-0600Z` cold render was started, but early frame profiles ballooned across decode, artifact, hover-grid, and persist stages while CPU usage fell to a few cores, making the run non-comparable and clearly worse. The code change was reverted and the partial log was kept only as a rejected-run record.

## Renderer Math Hot-Path Follow-Up

- NOAA palette gradient/step audit:
  - Changed only lookup style, not palette stop values/colors: upper-air temp and upper-air wind scales are now gradient/continuous; precipitation amount and reflectivity remain stepped; combined precip-type reflectivity remains categorical by precip type.
  - Core precipitation rendering now uses the same explicit stepped threshold lookup as the catalog metadata, instead of relying on duplicated legend stops to mimic a stepped gradient.
  - Compute-cost expectation: no extra decodes, fields, files, or raster passes; per-pixel lookup cost should be effectively unchanged, with upper-air continuous lookup O(1) and precip step lookup avoiding log scaling.
  - Validation: `node --test tests-node/noaa-beta.test.js` passed; `npm run typecheck` passed; `npm run lint` passed with the existing 42 warning-class hotspots; `npx prettier --check scripts/lib/noaa-nam-parameter-catalog.js scripts/lib/noaa-beta-renderer.js tests-node/noaa-beta.test.js` passed; `git diff --check` passed.
- Renderer compute hot-path follow-up, exact `20260427-0600Z`, `view=conus`:
  - Initial sandboxed availability probes falsely reported no `nam3km` hours for both 06Z and 00Z because sandboxed network failures are treated as unavailable. Direct NOAA HEAD check for `nam.t06z.conusnest.hiresf00.tm00.grib2.idx` returned `HTTP 200`, so 06Z was used.
  - Current-checkout cold baseline after deleting `output/noaa-beta-cache`: `output/noaa-benchmarks/global-queue-cold-current-baseline-20260427-06z.log`.
  - Result: `real 152.23s`, `user 1799.81s`, `sys 315.80s`, 276/276 frames, 0 failures.
  - Averages: `artifacts=6.25s/frame`, `corePng=0.87s`, `catalogPng=2.50s`, `hoverGrid=2.59s`, `materialize=3.87s`, `decode=2.39s`.
  - Implemented low-risk renderer math shortcuts in `scripts/lib/noaa-beta-renderer.js`:
    - direct index selection for uniformly spaced stepped color lookups, with binary search retained for non-uniform scales
    - typed-array/binary-search lookup for reflectivity precip-type bins instead of per-pixel bin scans and RGBA array reads
    - cheaper NaN checks in decoded-grid hot loops, relying on the decode path's existing non-finite-to-NaN normalization
    - hover-grid quantization uses `Math.floor(x + 0.5)` instead of `Math.round(x)` while preserving the existing Int16 clamp
  - Byte-for-byte one-frame artifact comparison for `hrrr F024` passed: all rendered artifacts matched the pre-change frame exactly; only `.complete.json` differed due timestamp/profile fields.
  - Warm one-frame A/B for `hrrr F024`, same populated cache, forced render/profile:
    - Original renderer: `real 6.01s`, `user 12.27s`, `artifacts=3.216s`, `corePng=0.537s`, `catalogPng=1.330s`, `hoverGrid=1.243s`.
    - Optimized renderer: `real 3.39s`, `user 8.70s`, `artifacts=1.657s`, `corePng=0.227s`, `catalogPng=0.715s`, `hoverGrid=0.665s`.
  - Added a cleaner warm serial hot-test matrix with `--force --profile --total-frame-concurrency=1 --frame-concurrency=1 --worker-count=1 --decode-concurrency=1 --range-concurrency=1 --total-range-concurrency=1`; this is the preferred signal for compute-only renderer changes because it avoids full-run queue, download, and thermal noise:
    - `hrrr F024`: `real 3.36s -> 3.22s`, `artifacts=1.848s -> 1.732s`, `hoverGrid=0.813s -> 0.730s`.
    - `nam3km F060`: `real 3.89s -> 3.69s`, `artifacts=2.134s -> 1.944s`, `hoverGrid=0.953s -> 0.771s`.
    - `gfs F384`: `real 3.41s -> 3.20s`, `artifacts=2.021s -> 1.782s`, `hoverGrid=0.848s -> 0.695s`.
    - `nam F036`: `real 3.67s -> 3.43s`, `artifacts=2.077s -> 1.900s`, `hoverGrid=0.896s -> 0.749s`.
  - Cooled-down full cold rerun after deleting `output/noaa-beta-cache` and stale OS-temp `noaa-*` render workdirs: `output/noaa-benchmarks/global-queue-cold-after-cooldown-20260427-06z.log`.
  - Result: `real 141.66s`, `user 1620.17s`, `sys 307.12s`, 276/276 frames, 0 failures; regenerated cache size was about `29G`.
  - Averages: `artifacts=4.82s/frame`, `corePng=0.69s`, `catalogPng=2.02s`, `hoverGrid=1.83s`, `materialize=4.37s`, `decode=2.26s`.
  - Versus the current-checkout cold baseline above: wall improved by `10.57s` (`6.9%`), user CPU by `179.64s` (`10.0%`), artifact average by `1.43s/frame` (`22.9%`), and hover-grid average by `0.75s/frame` (`29.2%`).
- Follow-up small-test iteration accepted a per-process transparent-empty-PNG cache in `scripts/lib/noaa-beta-renderer.js`. The cache stores an internal copy but returns a fresh `Buffer` per frame so worker transfer does not detach the cached bytes.
  - Warm serial HRRR `F024-F027` baseline: `output/noaa-benchmarks/hot-empty-png-baseline-hrrr-f024-f027-20260427-06z.log`, 4/4 frames, `real 27.49s`, `user 34.95s`, `artifactPrep=101.8ms/frame`, `artifacts=4.168s/frame`.
  - Cached run: `output/noaa-benchmarks/hot-empty-png-cache-hrrr-f024-f027-20260427-06z.log`, 4/4 frames, `real 24.37s`, `user 30.83s`, `artifactPrep=89.0ms/frame`, `artifacts=3.782s/frame`.
  - Correctness: HRRR `F024` artifacts compared byte-for-byte against the pre-change frame; only `.complete.json` differed. Decompressed `hover-grid.bin.gz` SHA matched.
  - A lower-level visibility/unsafe-buffer/hover-pack experiment was rejected during small tests after it produced non-comparable noisy timings and initially exposed a visible-bound semantics bug; those changes were backed out.
- Full cold render after deleting `output/noaa-beta-cache` and stale OS-temp NOAA workdirs with the transparent-empty-PNG cache: `output/noaa-benchmarks/global-queue-cold-empty-png-cache-20260427-06z.log`.
  - Result: `real 139.55s`, `user 1617.46s`, `sys 329.87s`, 276/276 frames, 0 failures; regenerated cache size was about `29G`.
  - Averages: `artifacts=4.65s/frame`, `artifactPrep=0.088s`, `corePng=0.67s`, `catalogPng=1.99s`, `hoverGrid=1.74s`, `materialize=4.61s`, `decode=2.21s`.
  - Versus the prior cooled-down full cold run: wall improved by `2.11s` (`1.5%`) and artifact average improved by `0.18s/frame` (`3.7%`); materialize was slower, so treat this as a modest full-run confirmation rather than a large isolated renderer win.
- Full-run benchmark caveat:
  - First optimized cold run before the hover-rounding tweak: `output/noaa-benchmarks/global-queue-cold-hotpath-opt-20260427-06z.log`, `real 153.96s`, `user 1693.55s`, 276/276 frames. Artifact average improved slightly but wall time was flat/slightly worse.
  - Later full cold and warm A/B runs after repeated renders showed broad decode/wgrib/grid-map/artifact inflation and are recorded as noisy/rejected comparison runs, not accepted renderer-signal wins: `global-queue-cold-hover-round-opt-20260427-06z.log`, `global-queue-warm-baseline-20260427-06z.log`, and `global-queue-warm-hotpath-opt-20260427-06z.log`.
  - Validation: `node --test tests-node/noaa-beta.test.js` passed; `npm run typecheck` passed; `npm run lint` passed with the existing 42 warning-class hotspots; `npx prettier --check scripts/lib/noaa-beta-renderer.js` passed; `git diff --check` passed.

## Older Full-Run Benchmark Summary

- Renderer math/hover/scalar/wind optimization, exact cold fixture `20260427-0600Z`, `view=conus`, models `gfs,nam,nam3km,hrrr`, full horizon, forced render, profile enabled:
  - Availability probe: GFS complete through `F384`, NAM 3km through `F060`, HRRR through `F048`; NAM has the normal `F036` cap, and `20260427 00Z` was not more complete.
  - Baseline log: `output/noaa-benchmarks/global-queue-cold-baseline-20260427-06z.log`.
  - Hover/math optimized log: `output/noaa-benchmarks/global-queue-cold-hover-math-opt-20260427-06z.log`.
  - Scalar/wind optimized log: `output/noaa-benchmarks/global-queue-cold-scalar-wind-opt-20260427-06z.log`.
  - Rejected reflectivity fan-out logs: `output/noaa-benchmarks/global-queue-cold-reflectivity-fanout-20260427-06z.log` and `output/noaa-benchmarks/global-queue-cold-reflectivity-fanout-v2-20260427-06z.log`.
  - Rejected visibility-hoist log: `output/noaa-benchmarks/global-queue-cold-visible-hoist-20260427-06z.log`; the run was aborted after early frames showed non-comparable slowdowns and low CPU utilization.
  - Scalar/wind optimized result: GFS 129/129, NAM 37/37, NAM 3km 61/61, HRRR 49/49; 276 built, 0 reused, 0 failed.
  - Byte-for-byte renderer correctness comparison against the pre-optimization renderer passed on identical synthetic decoded grids covering 44 layer artifacts, 6 reflectivity gate variants, synoptic payloads, and the binary hover grid.
  - `node --test tests-node/noaa-beta.test.js`: passed.
  - `npm run typecheck`: passed.
  - `npm run lint`: passed with the repo's existing warning-class hotspot map (42 warnings, 0 errors).
  - `npm run format:check`: still fails on pre-existing formatting drift in 7 files after formatting touched renderer file.
  - `npm run build`: passed.
  - `git diff --check`: passed.
  - `npm run test:local-runtime`: first sandboxed attempt failed on `127.0.0.1` bind `EPERM`; escalated rerun passed all 29 tests.
- NOAA full-render scheduler optimization:
  - `node --test tests-node/noaa-beta.test.js`: passed.
  - `npm run typecheck`: passed.
  - `npm run build`: passed.
  - `git diff --check`: passed.
  - Cold legacy/per-model benchmark after deleting `output/noaa-beta-cache`: `real 350.53s`, 276 frames, 0 failures.
  - Cold global-frame-queue benchmark after deleting `output/noaa-beta-cache`: `real 338.25s`, 276 frames, 0 failures.
  - Best observed cold renderer-hot-path benchmark after deleting `output/noaa-beta-cache`: `real 189.59s`, 276 frames, 0 failures.
  - Final default cold benchmark after deleting `output/noaa-beta-cache`: `real 234.70s`, 276 frames, 0 failures, `globalPersistQueue=false`.
  - Failed write-throttle benchmark (`artifact-write-concurrency=96`): `real 287.02s`; rejected because average `persist` rose to about `10.1s/frame`.
  - Direct artifact writes + bounded detailed synoptic cold benchmark after deleting `output/noaa-beta-cache`: `real 234.52s`, 276 frames, 0 failures. Wall time was effectively flat versus the 234.70s default, but CPU work fell (`user 1735.45s` vs `2018.86s`) and average `synoptic` fell to about `0.32s/frame`.
  - Aborted `--global-frame-concurrency=96` retest: workers stayed busy but per-frame costs inflated and progress lagged the 48-slot run.
  - Aborted persist-queue retest (`--global-persist-queue --global-persist-concurrency=8 --global-persist-backlog=96`): renderer stayed busy, but persistence backlog ballooned (`persisted=9/83`, `persistQueue=66/96`), so it remains disabled by default.
  - Experimental persist queue benchmark (`--global-persist-concurrency=16 --global-persist-backlog=96`): `real 309.99s`; rejected as a default because CPU utilization visibly fell off and write backlog ballooned.
  - Benchmark logs saved under `output/noaa-benchmarks/`.
