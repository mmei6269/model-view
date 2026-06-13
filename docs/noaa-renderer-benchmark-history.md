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

## 2026-06-10 Exact Hot-Path Pass (Severe Parcel Pipeline)

- Fixture: `npm run noaa:build:test -- --frames=6` (24 frames; GFS `20260610-12Z`, NAM/NAM3km `18Z`, HRRR `19Z`, `view=conus`), warm raw-NOAA cache, forced render, profile enabled. June convective regime: ~44% of HRRR CONUS cells (≈696k of 1.568M) pass the effective-layer candidate mask and ≈688k cells/frame produce finite effective SCP/STP, so the parcel pipeline dominates `derivedGrid`.
- Worker `--cpu-prof` attribution before the pass (serial HRRR F005): `calculateEffectiveLayerProductsFromSources` ≈7.9s of a ≈13.8s CPU frame, with `calculateSegmentParcelCapeCinForSource` ≈3.7s self and ≈1.1s of `vaporPressureHpa` exp calls; zlib PNG/hover encode ≈2.1s is output-byte-fixed.
- Implemented exact (operation-order- and NaN-semantics-preserving) optimizations; no formula, threshold, step size, level set, or gating change:
  - segment parcel integrator: hoisted scratch arrays, per-origin dry virtual-temperature factors reused as `(T * numer) / denom`, inlined saturation vapor/mixing-ratio/virtual-temperature chain;
  - `integrateMoistParcelTemperatureK`: inlined the per-step moist-lapse chain (3 calls/step removed);
  - `prepareEffectiveParcelSegments`: hoisted arrays, reused per-row `Math.log`, inlined env mixing-ratio/virtual-temperature with identical guards;
  - `fillEffectiveDiagnosticsProfileRows`: per-cell closure removed, direct typed-array reads with identical finite normalization;
  - pressure/wind/thermo interpolators, SRH, and pressure-mean wind: hoisted typed arrays, removed per-bracket `[..].every` array allocation, indexed near-duplicate sample dedupe;
  - `calculateBunkersMotionFromRows`: unique layer-boundary pressures interpolated once instead of twice;
  - `buildProfileDerivedGrids`: surface HGT/TMP/UGRD/VGRD grid resolution hoisted out of the dense cell loop; scalar surface-wind reads replace ~1.5M per-frame `{u,v}` allocations;
  - reduced-profile DCAPE source loops: direct reads plus level-first short-circuit;
  - Mercator row remap and the 5-tap presentation-smoothing kernel: inlined `normalizeGribFloat`/kernel sampling with an interior fast path that byte-matches the boundary path.
- Interleaved warm A/B on the same fixture (pre-opt rerun via `git stash` immediately after the optimized run, so thermal state is comparable): base-part frame wall avg `20.72s -> 17.95s` (`-13.4%`); `derivedGrid` avg `10.20s -> 8.20s` (`-19.6%`); single-piece GFS frames `derivedGrid` `1.83s -> 1.47s` (`-20%`); `gridMap` `1.05s -> 0.94s`. Logs: `output/noaa-benchmarks/opt-baseline-frames6-run2-warm.log`, `opt-frames6-run5-opt3.log`, `opt-frames6-run6-interleaved-baseline.log`.
- Correctness: byte-for-byte parity on 262 artifact files across three golden frames (`hrrr F005`, `gfs F012`, `nam3km F004`) covering every PNG layer, `hover-grid.bin.gz`, and synoptic payloads; only `.complete.json` timestamp/profile fields differ. `node --test` passes (the planned-color-map fixture test fails only when macOS denies `~/Downloads` fixture reads; environmental).
- Gating audit for empty-cell work: effective SCP/STP parcel scans are already candidate-masked; zero-CAPE cells and frames already skip; snowfall/FRAM profile decode already skips chunks with no positive liquid cells. The June workload is genuinely ~44% candidates, not empty-cell waste. Tighter gating (e.g., skipping low-MUCAPE candidates) would change stored hover/PNG values and is excluded by the no-heuristic-skip rule.
- Remaining hot costs after this pass: wgrib2 subprocess regrid/export (external CPU; only reducible via the regridded-binary cache, backlog item 2), zlib PNG/hover encoding (output bytes are fixed by compression level), and the irreducible exp/pow volume of the SPC parcel methodology over ~700k candidate cells.

## 2026-06-10 Warm-Iteration Pass (Regrid Cache + Exact Compute Turns)

- Fixture: `npm run noaa:build:test -- --frames=8` (32 frames; GFS `20260610-12Z`, NAM/NAM3km `18Z`, HRRR `19Z`, `view=conus`), warm raw-NOAA cache, forced render, profile enabled. Baseline logs: `output/noaa-benchmarks/goal-frames8-baseline-run1.log` and `goal-frames8-baseline-run2-warm.log` (fully warm). Per-turn logs: `goal-frames8-turn1-populate.log`/`goal-frames8-turn1-hit.log` through `goal-frames8-turn5.log`. Stage aggregation helper: `output/noaa-benchmarks/parse-profile-log.js`; CPU-profile summarizer: `output/noaa-benchmarks/summarize-cpuprofile.js`.
- Turn 1 implemented backlog item 2: a regridded bin + inventory disk cache for the bulk decode path. `decodeSelectedRecordsBulk` now persists `selected-regridded.bin` plus the wgrib simple inventory next to the cached selected GRIB (`<selected>.grib2.regrid-<hash>.bin/.json`), keyed by the selected GRIB's sidecar SHA-256 and selected-record hash, the exact regrid argument vector (bounds/size/categorical interpolation pattern), the export argument vector, `wgrib2 -version` identity, and a `regridded-bin-v1` version token. Hits skip both wgrib2 subprocesses and read field slices straight from the cached bin; misses behave exactly as before and persist via tmp+rename with hash-first metadata validation. wgrib2 regrid/export byte determinism was verified empirically (identical grib2/bin/inventory SHA-256 across repeated runs) before caching. Profile counters/log fields added: `regridBin=hits/misses`.
  - Warm A/B on the fixture: per-frame base-part wall avg `6629ms -> 5022ms` (`-24%`); `wgribRegrid` (~80s) and `wgribExport` (~10s) stage time eliminated at `regridBin=1/1` on all 32 base decodes; `derivedGrid` also fell ~10% from removed OpenMP subprocess CPU contention; build wall ~47s -> ~37s.
  - Disk cost: ~0.4-0.7 GB per base frame (raw float32 fields at 1600x980); the 32-frame fixture grew `selected-grib-v2` from 14G to 34G. `npm run cache:clear` removes it with the cache root. Cold builds are unaffected (first decode pays the same regrid and persists it).
- Turn 2 (exact, operation-order-preserving): `calculateMeanWindByPressureFromRows` and `calculateMixedLayerParcelPropertiesFromScratch` now collect Simpson samples into reusable scratch typed arrays with an insertion sort instead of per-call object arrays plus comparator sort (dedupe predicate keeps accepted pressures pairwise >=1e-6 apart, so descending order is unique and identical); PNG chunk CRCs use native `zlib.crc32` (verified bit-identical to the table implementation, table kept as fallback); the filter-0 PNG raw scanline buffer uses `Buffer.allocUnsafe` since every byte is written. Serial HRRR F005 worker CPU fell `14.27s -> 12.54s`.
- Turn 3 (exact): binary-search bracket fast path for `interpolateProfileWindAtPressureRows` and `interpolateProfileThermoAtPressureRows`. `sortEffectiveDiagnosticsRowsByHeight` (the final step of both scratch fill paths) now records a per-fill validity flag requiring all-finite, strictly descending pressures with adjacent gaps > 2e-6, which makes the 1e-6 exact-match row and the bracketing pair unique, so binary search returns exactly what the linear scans return; anything else falls back to the unchanged linear path. Covered by a randomized fast-vs-linear parity unit test (plus a 390k-trial offline fuzz including NaN rows, sub-2e-6 gaps, near-match targets). `interpolateProfileWindAtPressureRows` self time fell `0.571s -> 0.239s` per serial HRRR frame.
- Turn 4 (exact): `buildGridDistributionStats` replaces the full comparator sort with in-place quickselect order statistics (k-th smallest is sort-algorithm-independent; percentile index rounding unchanged; 500-trial fuzz against the sort implementation passed); reduced-profile DCAPE defers the wet-bulb iteration until a candidate passes the theta-e test (acceptance requires all conditions, so the accepted set and order are unchanged); Mercator row remap drops the redundant full-grid NaN prefill in both bilinear and nearest variants by writing NaN explicitly. `derivedGrid` partial avg fell `2561ms -> 2369ms`; build wall ~30s.
- Turn 5 (exact): presentation smoothing (`smoothFiniteNonnegativeGrid`) writes masked cells explicitly and ping-pongs two buffers instead of allocating and NaN-filling two grids per pass; snow RF/western-linear model loaders memoize per artifact path for the process lifetime instead of running `statSync` freshness keys on every call (model artifacts are treated as immutable per render process, matching the once-per-build renderer signature). GFS complete-frame stage time fell ~6.6%; base partials were flat within noise — the remaining profile is parcel-pipeline methodology compute, output-byte-fixed zlib, and per-pixel loops at minimal op counts.
- Cumulative on the 8-frame fixture versus the fully warm baseline: base-part stage wall sum `556.8s -> 378.9s` (`-32%`), GFS complete-frame stage sum `87.4s -> 54.9s` (`-37%`), build wall `~47s -> ~30-33s`, serial HRRR F005 worker CPU `14.27s -> 11.99s` (`-16%`), `derivedGrid` partial avg `3193ms -> 2420ms` (`-24%`).
- Correctness: after every turn, byte-for-byte parity on 336 artifact files across four golden frames (`hrrr F005`, `gfs F012`, `nam3km F004`, `nam F006`) covering every PNG layer, `hover-grid.bin.gz`, and synoptic payloads; only `.complete.json` timestamp/profile fields differ. `node --test tests-node/noaa-beta.test.js` passes with 110 tests (one new interpolator-parity test), `npm run typecheck`, `npm run lint -- --quiet`, touched-file Prettier, and `git diff --check` all pass.
- Benchmark noise note: NOAA was still uploading the HRRR `19Z` run during the session, so a few mid-session runs re-fetched ranges when late-hour `.idx` files gained records (visible as `rangeFetch` in `goal-frames8-turn2.log`); affected stages were excluded from conclusions and clean runs were used for the cumulative numbers.

## 2026-06-10 Renderer Module Split

- Pure code-move refactor: `scripts/lib/noaa-beta-renderer.js` shrank from 17,360 to 15,890 lines by extracting cohesive support modules under `scripts/lib/noaa-beta/`: `thermo.js` (thermodynamic constants/math, Wobus moist lift, moist-adiabat integrator), `png-encode.js` (filter-0 PNG encoder, CRC, transparent-PNG cache), `grid-ops.js` (binary grid decode, Mercator row remap + row-map cache, distribution stats/quickselect, presentation smoothing), `profile-wind.js` (scratch row sort/brackets, pressure interpolators, mean winds, Bunkers, SRH, Corfidi), and `util.js` (clamp/lerp + profile counter helpers).
- The renderer keeps its full export surface; no formula, constant, or renderer-signature change. Each extraction was verified with 110 node tests plus byte-for-byte golden-frame comparisons, and the completed split was verified against a pre-refactor build: 336 artifact files across `gfs F012`, `nam F006`, `nam3km F004`, `hrrr F005` byte-identical (only `.complete.json` differs). `npm run smoke:react` passes (33 tests).
- NOAA kept publishing new runs during the session, so later comparisons regenerate known-good references by rebuilding the same runs from the prior commit (`git checkout <commit> -- scripts/lib` or `git stash`) instead of reusing stale golden snapshots.

## 2026-06-10 Post-Split Optimization Passes (10x)

- Fixture: `npm run noaa:build:test -- --frames=8` against the evening 2026-06-10 runs (GFS/NAM/NAM3km `18Z`, HRRR advancing `21Z -> 22Z` during the session). Because NOAA kept publishing runs, every pass was verified with an interleaved known-good rebuild: candidate build, snapshot four golden frames, `git stash`, baseline build on the same runs, byte-compare, restore (`/tmp/pass-verify.sh` pattern); 336 artifact files matched after every pass, and `node --test` (110 tests) passed throughout.
- Pass 1: null-input scalar raster fast paths (backlog item landed) - null/shape-mismatched renders return a shared empty layer result before allocating the RGBA raster; zero-visible layers are only consumed via `encodeLayerOrEmpty`.
- Pass 2: frame sessions memoize the regrid-bin cache context (selected-GRIB sidecar read + payload hash) per path/signature, and cache hits skip the redundant second bin stat.
- Pass 3: presentation smoothing tracks per-buffer finiteness and uses an unchecked interior 5-tap kernel with the identical accumulator statement sequence on fully finite grids; the horizontal scratch is reused per worker; frontogenesis positive-grid prefill writes explicitly. 400-grid randomized parity fuzz against the prior implementation passed.
- Pass 4: RF snowfall trees store links/features as Int32Array and thresholds/values/coefficients as Float64Array (backlog item landed); sklearn fixture predictions bit-identical.
- Pass 5: FRAM environment grid lookups hoisted out of the dense cell loop (gridValue/surfaceDewpointK/profileSpeedAtLevel semantics replicated exactly); synoptic resample prefill dropped. A one-pass wgrib2 regrid/export pipe was tested and REJECTED: bins byte-identical but inventory offsets shift, failing the stated acceptance criteria.
- Pass 6: fused u/v derived-profile column interpolation for bulk shear reads each height grid once with independent per-component state machines; 30k-trial randomized parity fuzz against the single-variable reference passed.
- Pass 7: surface thermo (LCL/theta-e) grid lookups hoisted out of the cell loop, replicating the direct-dewpoint preference and hypsometric MSLP fallback chain exactly.
- Pass 8: per-worker NOAA `.idx` text/content-length/canonical-record promise caches FIFO-bounded (backlog item landed); the on-disk raw `.idx` cache stays the durable source.
- Pass 9: redundant NaN prefills dropped in full-write loops (`transformRunMaxSourceGrid`, frontogenesis theta, `buildThicknessGrid`); sparse-write builders keep theirs. A suspected `hasFinite` bug in `composeTwoRunMaxGrids` was investigated and refuted (the identifier belongs to `sumLiquidChunksIn`, where it is a defined local).
- Pass 10: bulk decode reuses one per-call slice read buffer (~6.3MB per field previously) with an alias-guard copy on the degenerate-geometry path.
- Aggregate effect on the warm fixture is modest and partially masked by run-to-run NOAA differences; the clearest signals are the interleaved per-pass A/Bs (candidate stage sums consistently at or below baseline) and the serial worker profile, where remaining CPU is the SPC parcel methodology (~37%), zlib at the configured levels (~17%), and per-pixel loops already at minimal op counts. Per-frame worker compute is considered at the exact-optimization floor; remaining backlog items are cold-path, scheduling, or high-risk fusions.

## 2026-06-10 Full Renderer Decomposition

- The remaining monolith was decomposed into 17 domain modules under `scripts/lib/noaa-beta/`; `noaa-beta-renderer.js` is now a ~2.1k-line frame orchestrator (render modes, artifact assembly, renderer signature, persistence glue) with an unchanged export surface. Module boundaries were chosen by static reference-closure analysis, extracted bottom-up (shared layers first), each step verified with 110 node tests plus interleaved byte-parity rebuilds (336 artifact files across all four models).
- Relocation hazards the verification caught: `__dirname`-relative snow model artifact paths (caught by sklearn/Veals fixture tests), a missing hover schema-version import in the winter module, and a missing `normalizeBaseUrl` import in the grib-source run-local cache key (caught by the parity build failing fast on worker errors). All modules were then rescanned for unresolved call targets.
- Cleanup: 119 unused import bindings pruned (eslint-driven, require-destructure lines only), the renderer's orphaned `calculateEffectiveLayerDiagnosticsFromSources` deleted (uncalled since an earlier SCP/STP pass, never exported). Aggressive dead-code deletion beyond lint-verified cases was deliberately skipped: the `_test` export aliasing makes static usage counting unreliable. The wgrib2 availability and identity probes stay separate (different validation semantics).
- Validation: byte parity on the 8-frame fixture after every step, 110 node tests, typecheck, lint --quiet, Prettier, `npm run build`, `npm run smoke:react` (33 tests), `npm run test:local-runtime`, and a live `buildNoaaPointSounding` end-to-end exercise against a cached HRRR run (32 levels with plausible severe indices).

## 2026-06-11 Vapor-Pressure LUT Experiment (Rejected)

- Tested under the relaxed rounding-error tolerance: a cubic-Hermite lookup table for the Bolton/Magnus saturation vapor pressure (1/16 C spacing, max relative error 1.7e-10) replacing the inline exp chain in the parcel segment integrator, moist ascent/descent integrators, and vaporPressureHpa. Microbenchmark showed 2.35x on isolated back-to-back evaluation.
- Interleaved same-run serial HRRR A/B showed the parcel core shrink only 4.75s -> 4.40s with total frame CPU flat (14.62s vs 14.68s): the real loops are instruction-throughput-bound, with out-of-order execution hiding exp latency behind surrounding arithmetic, while the LUT adds 2-4 cache-line loads per evaluation that compete with existing typed-array traffic. Reverted; isolated transcendental microbenchmarks do not transfer to these loops.
- Remaining frontier beyond the current dependency set and pure-JS implementation, with honest estimates: a faster deflate backend (libdeflate/zlib-ng; identical pixels, different artifact bytes; ~1.2-1.6s of the ~2.4s zlib share per dense frame; requires a native or WASM dependency), a WASM SIMD parcel kernel (~1.5-2.5s of the ~4.5s parcel core; large port plus dual-implementation parity burden), and GPU compute (largest possible win, largest lift). Within pure JS, current dependencies, and the established methodology, the measured floor stands.

## 2026-06-11 Pure-JS Frontier Experiments (All Measured Null)

- Dry-adiabat pow factorization: hoisting midPressure^kappa per cell segment and reducing the per-(origin, dry-segment) lift to one multiply (ulp-level deviation) measured 11.78s vs 11.96s total on an interleaved same-run serial HRRR frame - the kernel lost 0.09s while segment prep gained the hoisted pows back. Convective origins sit mostly at or above their LCLs, so dry-lift pows are rare; the kernel cost is the saturated branch and plain arithmetic throughput. Reverted.
- zlib strategy on real artifacts: Z_RLE gzip of the 225MB HRRR hover payload ran 1195ms vs 840ms for the level-1 default and produced 62% larger output (40.0% vs 24.7% ratio); Z_HUFFMAN_ONLY was worse still. zlib level 1 already wins on this data; only a faster codec implementation (libdeflate-class) reduces this cost.
- Together with the vapor-pressure LUT null, these establish the measured pure-JS floor: per-frame worker CPU is bounded by methodology transcendental volume, plain arithmetic throughput, and zlib codec speed.
- Remaining candidates requiring a decision or larger lift: libdeflate/zlib-ng backend (zlib is ~2.0s of ~12s frame CPU; projected save ~1.0-1.3s/frame; new native or WASM dependency; bytes change, decoded artifacts identical), WASM SIMD parcel kernel (~4.3s kernel+prep+integrator share; projected 1.5-2.5s; large port and parity burden), hover byte-plane layout (better/faster compression of Int16 planes; requires hover schema version bump and client decode change; modest), GPU compute (largest, heaviest).

## 2026-06-11 libdeflate PNG Backend (Landed)

- PNG IDAT deflate now uses the libdeflate WASM package (whole-buffer, level 1) through scripts/lib/noaa-beta/deflate-backend.js, with node zlib as the automatic fallback when the module is absent and via MODELVIEW_PNG_DEFLATE_BACKEND=zlib. Non-default compression levels always use node zlib.
- Hover gzip intentionally stays on node zlib: libdeflate measured ~1.0x on the real 226MB hover payload and would pin ~300MB of WASM linear memory per render worker.
- Measured on interleaved same-run builds: serial HRRR PNG deflate 0.831s -> 0.585s (1.42x, -0.25s/frame CPU); fixture PNG artifact bytes 7.6% smaller (241.6MB vs 261.5MB over 4 frames). Decoded-content identity verified on all 300 fixture PNGs (IDAT inflate equality), hover and all other artifacts byte-identical.
- PARITY PROTOCOL NOTE: PNG container bytes differ between backends. Byte-parity comparisons against pre-libdeflate baselines (or across backend availability) must either force MODELVIEW_PNG_DEFLATE_BACKEND=zlib on both sides or compare decoded IDAT content. Same-tree interleaved comparisons are unaffected (the backend is deterministic).

## Active Optimization Candidates

This backlog only lists optimizations not already described as landed in the 2026-05-10 passes above. Rankings are ordered by expected reward-to-risk: earlier items should generally be tried first, assuming parity coverage is available.

1. [High reward / Medium risk] Add a per-worker hour decode batcher keyed by interpolation policy, with nearest precip-type masks kept separate from bilinear/fractional masks.
2. [High reward / Medium risk] Add per-hour packed source-grid caches for snow-liquid, precip accumulation, freezing-rain, and profile grids after the individual-cache path remains stable.
3. [High reward / Medium-high risk] Add precip/freezing-rain cumulative-prefix grid caches, preserving source priority, phase-mask completeness, direct FRZR preference, APCP fallback rules, and missing-value behavior.
4. [High reward / Medium-high risk] Share reduced-profile column work across severe, DCAPE, lapse-rate, shear, and winter RF/linear snowfall calculations without changing formulas, fallback levels, or interpolation semantics.
5. [High reward / High risk] Parallelize independent post-main derived builders once selected/source-grid cache locks are reliable, then merge results deterministically with duplicate-key assertions.
6. [High reward / High risk] Decode winter phase-fraction packs once per hour/window/sample set, then emit snow, freezing rain, rain, and sleet target grids while preserving current summation order and NaN rules.
7. [High reward / High risk] Fuse multi-output accumulation composition where plans share source grids and cell semantics, starting with same-family APCP-only plans and keeping generic composition as the oracle.
8. [Medium-high reward / Low risk] Precompile per-run render, hover, persistence, artifact-path, and manifest-ref descriptor plans so frame code can plug in bodies and byte counts without rebuilding object/path walks.
9. [Medium-high reward / Low risk] Hydrate static run metadata into workers once per model/run/view, then dispatch frame tasks by metadata key, hour, and mode to reduce structured-clone CPU and GC.
10. [Medium-high reward / Low risk] Add directory-level source-grid cache indexes for warm cache-heavy runs, preserving payload hash and metadata validation.
11. [Medium-high reward / Low risk] Add bounded-parallel warm/reuse artifact completeness and stat refreshes, preferably via a single-pass frame-directory stat index before falling back to individual stats.
12. [Medium-high reward / Medium risk] Fold availability probing into shared .idx prefetch so availability checks and renderer workers share raw index cache setup and identical missing-hour behavior.
13. [Medium-high reward / Medium risk] Prepare run-level selected-record manifests from prefetched .idx files and have workers verify them against index content before reuse.
14. [Medium-high reward / Medium risk] Add a bounded in-build range-chunk promise cache keyed by full GRIB URL plus byte range, cleared at build or run boundaries.
15. [Medium reward / Low risk] Return finite and visibility counters from derived-grid builders that already scan every cell, avoiding separate inclusion scans.
16. [Medium reward / Low-medium risk] Add exact frame-session affine/unit transform caches for repeated mm-to-inch and similar transforms across precip, snow-liquid, snowfall, and freezing-rain consumers.
17. [Medium reward / Low-medium risk] Build concrete frame geometry tables for row latitude, column longitude, Coriolis terms, spacing/cos-lat helpers, and Mercator-derived helpers beyond the row-remap cache.
18. [Medium reward / Low-medium risk] Cache exact catalog source transforms shared by PNG and hover generation when raw/affine semantics are identical, excluding presentation-smoothed or categorical layers.
19. [Medium reward / Medium risk] Avoid blanket Float32Array.fill(NaN) in remaining hot loops where every cell is assigned (landed 2026-06-10 for Mercator row remap, presentation smoothing, frontogenesis theta/positive grids, run-max source transform, thickness, and synoptic resample), with Object.is parity tests for NaN, -0, zero, trace, and clamp cases.
20. [Medium reward / Medium risk] Reuse worker-local scratch directories and remaining transient Float32Array/PNG raw buffers (landed 2026-06-10 for smoothing scratch and the bulk-decode slice read buffer) with deterministic per-task cleanup and clear overwrite semantics.
21. [Medium reward / Medium risk] Make large artifact buffers more transfer-friendly by centralizing owned-buffer decisions and preserving cached transparent PNG transfer safety.
22. [Medium reward / Medium risk] Reduce synoptic/contour allocation churn through lazy empty-output allocation, endpoint-indexed contour chaining, coordinate lookup tables, direct rasterization, cached RGBA paint parsing, direct vector encoding, and chunked string assembly.
23. [Medium reward / Medium risk] Make FRAM environment work sparse without reducing decoded coverage, validating positive, zero, NaN, missing synthetic chunks and a real freezing-rain frame.
24. [Medium reward / Medium risk] Iterate exact sparse candidate-index lists for effective severe diagnostics while keeping dense profile products on their current paths.
25. [Medium reward / Medium risk] Make split snowfall tasks worker-sticky by model/run/view/hour while preserving dependency ordering, task outputs, and retry behavior.
26. [Medium reward / Medium risk] Retry only failed split render parts when dependency markers make that conservative, instead of rebuilding base, snow-prefix, and snow indiscriminately.
27. [Medium reward / Medium risk] Add a measured global wgrib2/stage token system for subprocesses, range fetches, artifact CPU, and persistence; accept only if cold wall time and CPU utilization improve with byte-identical outputs.
28. [Medium reward / Medium-high risk] Evaluate class-based direct write throttles for large PNG/hover binaries, small JSON sidecars, and completion markers; prior global persist-queue experiments regressed.
29. [Medium reward / High risk] Evaluate worker-direct persistence only after byte-count and interruption semantics are hardened.
30. [Low-medium reward / Low risk] Avoid duplicate detailed synoptic rendering on simple-empty fallback by reusing or delaying detailed work without changing final vector/image content.
31. [Low-medium reward / Low risk] Evaluate content-addressed writes for immutable empty artifacts while preserving artifact keys, byte refs, and completion-marker semantics.
32. [Low-medium reward / Medium risk] Replace staged NOAA selection object cloning with a transactional overlay that preserves all fallback priorities.
33. [Low-medium reward / Medium risk] Reuse current-frame APCP water grids for APCP-derived snow and freezing-rain source paths only where record identity and interpolation policy exactly match; verify whether the new shared registry already covers this before implementing.
34. [Low-medium reward / High risk] Coalesce adjacent NOAA byte ranges only if selected-record ordering and synthetic record indexing remain exact and byte comparisons pass.
35. [Low reward / High risk] Explore scalar PNG and hover-grid fusion only for layers with identical raw/affine semantics; keep it demoted until parity harnesses prove it safe.
36. [Low reward / High risk] Explore custom/direct PNG filter-0 scanline encoders, RGBA scratch pooling, packed Uint32 RGBA writes, and lazy visible-pixel allocation only after decode/cache work stops dominating.

Rejected unless new benchmarks prove otherwise: reflectivity gate fan-out, higher global frame/persist concurrency, decoupled persistence queues, and the one-pass wgrib2 regrid/export pipe (bins byte-identical but inventory offsets shift, failing the acceptance criteria).

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
