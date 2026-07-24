# Renderer Optimization: Follow-up Campaign (Passes 1–16; 17–20 Deferred) (2026-07-22)

Status: performed campaign complete (Passes 1–16) on `codex/renderer-optimization-20-pass-followup`; deferred Passes 17–20 remain roadmap items.

This log is the source of truth for the renderer optimization follow-up requested after the prior twenty-pass campaign merged to `master`. The campaign was initially provisioned with a thirty-candidate queue, reduced to twenty planned passes before Pass 15 was documented, and then revised at the user's direction to stop after Pass 16. The performed campaign therefore contains Passes 1–16. Passes 17–20 are deferred roadmap items: they have not been executed, are not counted as passes, and carry no production, benchmark, or cumulative-improvement claim. Historical filenames, the branch name, and the sealed `renderer-30pass` benchmark namespace remain frozen because renaming provenance identifiers would break traceability; none describes the final performed-pass count. A pass counts only after a concrete hypothesis is implemented or isolated, reviewed, benchmarked against its immediate accepted baseline, checked for scientific and meteorological impact, documented, and either accepted or fully reverted. Null and regressive findings remain in this record but not in production code.

## Acceptance Contract

- Meteorological correctness is the first constraint. No source omission, reduced spatial resolution, display-driven calculation skip, threshold shortcut, or broad weather heuristic is allowed.
- Scheduling, caching, ownership, serialization, and exact-arithmetic passes require decoded artifact equality. Completion and manifest comparisons may normalize only documented volatile timestamps and render-profile telemetry.
- A deliberately numerical pass may move output only when the movement is not meteorologically or scientifically meaningful. It must report finite/missing and sign flips, threshold or classification flips, changed RGBA pixels by layer, changed hover samples and maximum delta in stored and scientific units, randomized oracle results, and the method/kernel/cache identity change.
- A performance candidate is accepted only with a repeatable signal outside pooled noise, or a compelling measured resource reduction with low complexity and risk. Cumulative improvement is remeasured against the campaign baseline; pass percentages are never multiplied.
- Architectural changes and rewrites require separate implementation and review agents, root review, concurrency and failure-path tests, corruption/partial-write recovery where applicable, memory bounds, production-shaped benchmarks, complete artifact validation, and all-model parity.
- Every accepted pass receives focused tests, relevant full validation, artifact comparison, formatter/linter checks, and a post-pass review. A rejected pass is reverted before the next baseline.
- No benchmark or test may clear, mutate, or render into the application cache. Every arm uses a dedicated copy-on-write clone beneath the campaign scratch root.

## Baselines, Fixture, and Evidence Method

Upstream merged baseline: `41ce6e20b33484ddcb7bd03d5524e4f22a7874f0`.

Renderer-semantically-neutral campaign-infrastructure baseline: `0fefbc639b6abffa56551975fe050bb52848b4c1`. Its scoped source-tree SHA-256 is `4f52543575b76508f43fd49f86fbc0c5adddd0dcd22d2232ef5f56c5879fde9b` over 115 files and 101,187,275 bytes (`package.json`, `package-lock.json`, `scripts`, `shared`, and `tools`). Infrastructure adds a campaign-specific benchmark output root, schema-v3 raw-log hashes, start/finish host telemetry, and a manifest-referenced artifact comparator; it is not one of the performed renderer passes.

Canonical warm fixture:

| Model    | Run            | Hours              |
| -------- | -------------- | ------------------ |
| GFS      | 2026-07-16 06Z | 000, 003, 006, 009 |
| NAM      | 2026-07-16 12Z | 000, 001, 002, 003 |
| NAM 3 km | 2026-07-16 12Z | 000, 001, 002, 003 |
| HRRR     | 2026-07-16 13Z | 000, 001, 002, 003 |

The immutable seed is the prior campaign's validated final cache. It is never rendered into directly. Every A/B arm receives an APFS copy-on-write clone, and every source arm is a frozen source snapshot with the same dependency tree and explicit wgrib2 3.8.0 binary.

Warm measurements use an arm warm-up followed by interleaved A/B/B/A source-stable processes, normally at least three samples per revision. Relevant cache counters must remain at 100% hits. Cold or cache-miss work uses one repetition per fresh disposable cache clone; repetitions may not share a mutating cold root. Stage microbenchmarks use real payloads, rotating arm order, JIT warm-up, at least fifteen samples when practical, median/MAD/p95, allocation or RSS evidence where relevant, and an exact output oracle.

The frozen merged-renderer HRRR reference was 9.172, 8.878, and 8.939 seconds (median 8.939 s; MAD 0.060 s). It is retained as a plausibility check.

The committed campaign-baseline samples were 8.859, 8.726, and 8.704 seconds (median 8.726 s; MAD 0.022 s). Its nine base frames had median stage values of 1,923.6 ms wall, 1,632.5 ms artifacts, 1,065.6 ms compression wait, 374.3 ms catalog PNG, and 116.4 ms hover construction. All relevant warm cache counters were 100% hits. The schema-v3 summary is `output/noaa-benchmarks/renderer-30pass/campaign-baseline-hrrr-hrrr-20260716-13z-20260723T034449215Z/summary.json`; its three raw-log SHA-256 values are `fe247f0d…`, `7c2de3b3…`, and `60ea213c…`.

The new comparator was independently implemented and root-reviewed, passed 24 combined harness/comparator tests, ESLint, Prettier, and a real-cache self-parity gate. That real HRRR gate compared 350 manifest-referenced payloads, including seven decompressed hover containers and 1,119,256,570 canonical bytes, with zero inventory, byte, manifest, or completion-marker mismatches. Its framed aggregate canonical SHA-256 is `673899b1c087af628be0d3aeec1a2ebff2c376db1ae760e8f794393d9fe6b0de`.

Raw schema-v3 benchmark logs and summaries live under the frozen historical namespace `output/noaa-benchmarks/renderer-30pass/`. Compact source fingerprints, raw-log hashes, summary paths, samples, decisions, parity hashes, and cumulative arithmetic are committed in `docs/renderer-optimization-20-pass-followup-evidence.json`.

Durability correction (2026-07-23, Pass 16 session review): Passes 06–15 originally cited ephemeral `/private/tmp/...` evidence files that had no copy under the frozen namespace, which violated this section's own durability rule. Every cited file that still existed — 29 of 29 with recorded hashes — was re-verified against its recorded SHA-256 with zero mismatches and copied, together with the surviving `pass14` frozen source tree and the retained pass 13/14 parity-container proofs, into `output/noaa-benchmarks/renderer-30pass/followup-durable-evidence/` (see its `rescue-manifest.json`). Three cited items no longer exist on disk: the sealed Pass 12 and Pass 14 auxiliary roots `/private/tmp/renderer-pass12-fused.Z1fPLw/candidate-src-final-v2` and `/private/tmp/renderer-pass14-parity-v3.lJnjqb`, and `/private/tmp/renderer-pass13.9nr4rm/candidate-provenance.json`. The two sealed source trees remain reproducible from their committed production commits (`5dc9acf` and `3299df9`, fingerprints recorded in the pass records); the Pass 13 provenance summary survives only through its recorded SHA-256 and the retained parity-container proofs. Original citation paths below are preserved unchanged as historical identifiers.

## Initial High-Yield Candidate Sequence

The ordered thirty-candidate queue below was frozen from the merged profiles, the surviving backlog, and three independent read-only audits. Order is expected reward-to-risk, not implementation convenience. The performed campaign now ends after Pass 16. Unselected candidates remain backlog, while the four already-audited next candidates are recorded separately as the deferred Pass 17–20 roadmap; none is silently counted as performed. The order may change only in a future authorized campaign with its own frozen methodology.

1. Remove the redundant libdeflate result copy and prove independent backing-store ownership.
2. Assemble PNG output in one allocation instead of copying IDAT through a chunk and `Buffer.concat`.
3. Use validated derived-sidecar hits to omit dependency-proven profile-only Mercator-pack reads.
4. Submit hover compression early and make artifact production cooperatively asynchronous.
5. Encode categorical products as exact indexed-color PNGs with decoded-RGBA parity.
6. Render eligible layers directly into filter-0 scanlines and rerender only on helper failure.
7. Create exact zero-copy browser views over decoded hover storage with shared-backing-aware cache accounting.
8. Move hover prefix reconstruction into an ownership-safe browser worker.
9. Split hover payloads into stable layer-family shards with atomic publication and lazy client fetch.
10. Evaluate an exactly invertible row-reset/2D hover predictor that permits lazy row sampling.
11. Add a bounded lossless shared-input transport for compression helpers.
12. Port the dominant catalog colorizer shapes to exact WASM/SIMD kernels.
13. Support partial decoded-record cache hits and fill only missing Mercator-pack slices.
14. Evaluate a record-addressable Mercator-grid CAS/per-hour bundle.
15. Quantize directly into the final hover container without per-variable intermediate arrays.
16. Probe validated Mercator packs before selected-GRIB body hashing on the warm path.
17. Fuse eligible scalar-raster and hover-quantization loops while retaining oracle paths.
18. Read bounded adjacent Mercator-pack segments instead of 152 individual slices or one giant read.
19. Cache method-versioned presentation-ready frontogenesis/snowfall smoothing results.
20. Lease or fuse WASM smoothing output into its immediate raster consumer.
21. Sweep Brotli q0 window/block/mode parameters on real 188–226 MB payloads.
22. Precompile exact catalog color lookup tables and remove worker-start interpolation.
23. Normalize the 26 MB Snow RF model in one pass with prediction-oracle parity.
24. Fuse exact multi-output winter phase composition and descriptor statistics.
25. Share a rigorously reviewed reduced-profile feature slab across compatible winter/severe consumers.
26. Add precipitation/freezing-rain cumulative prefixes with documented summation deltas and zero classification changes.
27. Add bounded soft worker affinity for split tasks and run-local decoded/source registries.
28. Evaluate build-global stage/resource tokens under 4/8/12/18-worker pressure.
29. Add a bounded URL/range promise broker plus atomic disk CAS for duplicate NOAA byte ranges.
30. Evaluate display-aligned hover quantization only for audited non-threshold variables, with per-variable scientific error tables.

## Pass Table

| Pass | Candidate and finding                                                                                                                                                                                                                                                                                                               | Measured result                                                                                                                                                                                                                                                                   | Decision                    | Fresh cumulative vs campaign baseline |
| ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------: |
|   01 | Return a guarded zero-copy `Buffer` view over libdeflate's independently owned exact-sized result. Full renderer timing was neutral, but one allocation/memcpy per PNG IDAT and 196.85 MiB of transient copying per four-frame HRRR run are removed.                                                                                | A/B/B/A subprocess `8,838.134 -> 8,867.627 ms` (`+0.33%`, noise); adapter-only `-98.7%`; 350/350 payloads exact.                                                                                                                                                                  | Accepted, resource-only     |                               `0.00%` |
|   02 | Assemble each PNG directly into its final `IDAT bytes + 57` buffer. This removes the intermediate IDAT chunk and one full payload copy: 196.847 MiB over 332 PNGs in the four-frame HRRR fixture.                                                                                                                                   | Final A/B/B/A `8,851.820 -> 8,806.080 ms` (`-0.52%`, directional/noise); real assembly micros `-4.51%` to `-27.06%`; 350/350 payloads exact.                                                                                                                                      | Accepted, resource-only     |                               `0.00%` |
|   03 | On an exact profile-sidecar hit, a selection-owned dependency graph now omits only raw Mercator-pack fields whose consumers are fully restored. HRRR reads 64–66/150–152 fields and avoids 514.4 MiB/frame.                                                                                                                         | A/B/B/A `8,669.672 -> 8,607.345 ms` (`-0.719%`); grid-map median `76.25 -> 38.95 ms` (`-48.92%`); HRRR 350/350 exact.                                                                                                                                                             | Accepted                    |                   `1.36%` directional |
|   04 | Submit hover compression after the first PNG and replace unbounded pool waiters with frame-local cooperative admission plus a pool-scoped global gate. The architecture also bounds arbitrary reflectivity rosters and releases derived planes/caches at their last safe use.                                                       | A/B/B/A `8,546.278 -> 7,244.569 ms` (`-15.231%`); fixed-roster artifact time `-20.304%`; 2.41 GiB cumulative and 646.07 MiB peak parked snapshots eliminated; 1,287/1,287 payloads exact.                                                                                         | Accepted                    |                              `16.98%` |
|   05 | Encode exact categorical rasters as indexed-color PNGs with full alpha palettes. The four allowlisted families now send one byte/pixel to compression instead of four, avoiding 898.464 MB of raw RGBA input across the four-model fixture.                                                                                         | Final hardened A/B/B/A `7,328.649 -> 7,113.499 ms` (`-2.936%`); artifact median `-5.213%`; 191 changed PNG containers decode to exact RGBA across 10.531 GB of canonical data.                                                                                                    | Accepted                    |                              `18.48%` |
|   06 | Isolate direct scanline rendering for the remaining RGBA layers. Real-artifact packing showed only a 31.293 ms (`0.432%`) whole-render ceiling, before accounting for the current rasterizer's faster native `Uint32` stores or a substantially more complex fallback contract.                                                     | 31 real-fixture samples: `2.183 / 0.027 ms` median/MAD per 15 layers; extrapolated 215-job ceiling `31.293 ms`; no production source retained.                                                                                                                                    | Rejected, low ceiling       |                              `18.48%` |
|   07 | Decode canonical browser hover payloads in their exclusively owned `response.arrayBuffer()` and expose 72 exact `Int16Array` views over that one store; refcount shared owners across URL, supplemental, and merged cache entries.                                                                                                  | Real Chromium parser `133.115 -> 54.783 ms` (`-58.846%`); fetch-to-decoded `-19.039%`; retained backing-store accounting `451,591,044 -> 225,799,044 B`; 112,896,000 samples exact.                                                                                               | Accepted, client            |                              `18.48%` |
|   08 | Port the dominant raw/affine continuous catalog colorizer to an exact f64 WASM kernel with ABI gating, a semantic loader canary, per-call poisoned stats, bounded scratch, clean JS fallback, and per-worker ownership.                                                                                                             | Production roster `881.541 -> 506.263 ms` (`-42.571%`); final A/B/B/A `7,068.376 -> 6,994.820 ms` (`-1.041%`); 1,287/1,287 four-model payloads exact.                                                                                                                             | Accepted                    |                              `19.84%` |
|   09 | Transfer the owned hover buffer through a persistent same-origin module worker; cap admission at one active plus one queued owner, refetch once after ownership loss, and validate worker/recovery payloads before caching.                                                                                                         | Real Chromium main-loop gap `55.4 -> 5.1 ms` (`-90.79%`), long task `55 -> 0 ms`, fetch-to-ready `+0.322%`; 112,896,000 samples and one-backing ownership exact.                                                                                                                  | Accepted, responsiveness    |                              `19.84%` |
|   10 | Compare exact row-reset and 2D-gradient predictors over every production-q0 hover container. Row resets add storage despite excellent cold sampling; gradient prediction materially reduces transfer bytes but raises eager decode CPU.                                                                                             | Gradient stored bytes `617,968,460 -> 546,874,878` (`-11.504%`); eager decode `+10.44%`; exact across 5,000,352,000 reconstructed sample comparisons.                                                                                                                             | Accepted for rollout        |                              `19.84%` |
|   11 | Transfer renderer-owned PNG scanlines to compression helpers and pack hover input directly into one immutable shared owner. The versioned, bounded transport preserves generic caller isolation and reconstructs from immutable sources after ownership loss.                                                                       | Wall `7,089.469 -> 7,089.344 ms` (`-0.0018%`, neutral); median peak RSS `3,224,133,632 -> 2,761,981,952 B` (`-14.334%`, `-440.74 MiB`); 1,287/1,287 payloads exact.                                                                                                               | Accepted, resource-only     |                              `19.84%` |
|   12 | Roll out exact MVH4 `gradient2d` hover payloads and fuse the predictor into the existing WASM quantization scratch. The first unfused rollout saved transfer bytes but regressed server wall time; the repaired SIMD path preserves every accepted MVH4 byte.                                                                       | Stored hover `-11.504%`; fused wall `+0.601%` vs MVH3, recovering `92.785%` of the rejected wall regression; browser transfer-ready break-even `777 Mbps`; 1,287/1,287 final payloads exact.                                                                                      | Accepted, transfer/resource |                   `17.96%` contextual |
|   13 | Write canonical MVH4 variables directly into one admitted growable final arena and submit its exact bounded view, eliminating per-variable owners and the later plane-to-container copy.                                                                                                                                            | Causal wall `-3.140%`; hover `-28.503%`; RSS `-117.977 MiB` (`-4.474%`). The predeclared RSS gate failed by `32.756 MiB` and remains failed; 1,287/1,287 payloads exact.                                                                                                          | Accepted; RSS gate failed   |                   `21.27%` contextual |
|   14 | Probe the structurally validated exact Mercator pack before hashing the selected GRIB body, then commit its provenance only after a strict transactional decode. Any race, corruption, or mismatch rolls back all provisional state and retries the authoritative path.                                                             | Causal wall `6,689.957 -> 6,460.420 ms` (`-3.431%`); materialize/probe `243.5 -> 23.5 ms` (`-90.349%`); four exact hashes / `424,695,707 B` avoided; 1,287/1,287 payloads exact.                                                                                                  | Accepted                    |                   `25.81%` contextual |
|   15 | Precompile the 73 static continuous catalog-color assignments into a strict content-addressed asset while preserving exact dynamic generation for custom recipes and rollback. This removes identical interpolation work from the builder and frame worker at every process start.                                                  | Causal wall `6,497.770 -> 6,317.949 ms` (`-2.767%`); receipt-bound initialization `190.316 -> 9.181 ms` (`-95.176%`); 8/8 paired cycles positive; 1,287/1,287 payloads exact.                                                                                                     | Accepted                    |          `25.17%` context only; noisy |
|   16 | Compile the 26 MB Snow-RF CONUS random forest into a content-addressed typed binary asset with prediction-oracle parity, streaming identity captures, an exact JSON fallback, and a fail-closed `required` mode. Startup receipts prove one-owner/500-region typed ownership and byte-identical canonical models on Node 20 and 22. | Receipt gate: loader `430.1 -> 41.0 ms` (`-90.4%`), role-ready `-89.3%`, 124/124 pairs B-lower; observed full gate `-11.620%` (two receipt-forced loads); unobserved contextual wall `6,402.917 -> 6,241.993 ms` (`-2.513%`, 8/8 cycles); 1,287/1,287 and 350/350 payloads exact. | Accepted                    |             `28.66%` fresh interleave |
|   17 | Deferred evaluation-only MVH5/schema-5 signed-int8 escape codec.                                                                                                                                                                                                                                                                    | Not executed; audited census and predeclared gates only. No production or performance claim.                                                                                                                                                                                      | Deferred; not counted       |                                     — |
|   18 | Deferred conditional MVH5 production rollout with bounded ownership and exact MVH4 rollback.                                                                                                                                                                                                                                        | Not executed; depends on Pass 17 clearing every gate. No production or performance claim.                                                                                                                                                                                         | Deferred; not counted       |                                     — |
|   19 | Deferred tolerance-gated adaptive indexed continuous palettes with protected meteorological thresholds.                                                                                                                                                                                                                             | Not executed; audited error/storage gates only. No production or performance claim.                                                                                                                                                                                               | Deferred; not counted       |                                     — |
|   20 | Deferred post-MVH5 Brotli-q0 `LGWIN=10..24` sweep requiring a sealed winner holdout.                                                                                                                                                                                                                                                | Not executed; no sweep or holdout result exists. No production or performance claim.                                                                                                                                                                                              | Deferred; not counted       |                                     — |

## Deferred Roadmap — Not Executed or Counted

These items preserve reviewed future work without extending the current campaign. The census figures below are read-only design evidence, not retained pass benchmarks, accepted results, or cumulative-improvement claims.

### Deferred Pass 17 — Evaluation-only MVH5 Signed-int8 Escape Codec

Evaluate a new `MVH5`/schema-5 container using the exact MVH4 `gradient2d` predictor and `sint8-escape80-int16le-v1` residual packing: residuals `-127..127` occupy one byte; all others use marker `0x80` plus signed Int16 little-endian. Exact `-128` therefore encodes as `80 80 ff`. The audited 28-container census covers `1,666,784,000` residuals: `99.2588007%` fit the one-byte range, `12,354,191` require escapes (`0.7411993%`), and `22,144` are exact `-128` marker collisions handled by the escape form. The census projects raw container bytes from `3,333,672,590` to `1,691,619,188` (`-49.257%`) and Brotli-q0 bytes from `546,874,878` to `438,566,964` (`-19.805%`); these are codec-census projections, not a production-pass result.

Any future evaluation must remain evaluation-only under a new `MVH5` identity and pass all frozen gates: raw reduction at least `45%`, Brotli reduction at least `15%`, no variable growth, decode median no worse than `+15%`, decode p90 no worse than `+20%`, active peak ownership at most `1.55x`, steady ownership at most `1.01x`, combined pack-plus-Brotli time no worse than `+5%`, exact reconstruction of all 28 containers, exhaustive malformed-input rejection, and independent format, memory, science, and benchmark reviews.

### Deferred Pass 18 — Conditional MVH5 Production Rollout

Proceed only if the independent Pass 17 evaluation clears every gate without threshold revision. A rollout must decode first, retain MVH4 as the exact production rollback, construct the packed final arena directly, bound quantization/packing scratch, and never retain a second full-container owner. It must prove exact parity for all 28 production containers, 1,063 variables, and all `1,666,784,000` samples, plus browser/worker recovery, mixed-schema, malformed-container, ownership, RSS, and four-model artifact parity before any production or performance claim.

### Deferred Pass 19 — Tolerance-gated Adaptive Indexed Continuous Palettes

Evaluate only the pre-audited continuous-palette allowlist; exact palettes, categorical products, callback/dynamic palettes, contours, and other excluded families remain unchanged. Compilation must segment at repeated stops, alpha-zero transitions, and protected meteorological thresholds so no indexed bin crosses the exact `10/15 mph`, `20/50 kt`, or `0.05 in SWE` boundaries. The candidate must fail closed to the exact path.

Acceptance requires OKLab×100 error no greater than `2.0` maximum, `1.25` p99, `0.75` p95, and `0.30` mean; RGB-channel error no greater than `4`; alpha error no greater than `6/255`; exact zero/nonzero alpha classification; no finite/missing, visibility, hover, derived-grid, or protected-threshold change; at least `55%` stored-byte reduction on the complete changed-PNG census; at least `1.5%` wall improvement with `6/8` favorable paired cycles and no p90 regression; and no RSS or browser regression. These are future gates, not evidence that the candidate has run or passed.

### Deferred Pass 20 — Post-MVH5 Brotli-q0 Window Sweep

Run only after an accepted MVH5 rollout. At quality 0, the meaningful standard parameter is `LGWIN`; evaluate `10..24` and exclude nonstandard `25..30`. First screen broadly, then run the full 16-container base set under identical source and cache seals. Acceptance requires a winner to survive a separately sealed holdout from the next production-shaped run with exact decoded parity and all wall, encode, decode, memory, and size guardrails. Without that holdout, the result remains exploratory or rejected; no parameter change or performance claim is permitted.

## Detailed Pass Records

### Pass 01 — Guarded Zero-copy Libdeflate Result View

Hypothesis: `libdeflate` 0.1.0 already returns `HEAPU8.slice(...)`, an exact-sized ordinary `Uint8Array` whose backing store is independent of WASM memory. Wrapping it with `Buffer.from(Uint8Array)` copied every IDAT body again before the helper transferred it. A guarded `Buffer.from(arrayBuffer, offset, length)` view can remove that copy without changing codec bytes.

Implementation and review:

- The view path engages only for a plain `Uint8Array`, fixed ordinary `ArrayBuffer`, zero offset, and exact backing length. Subarrays, subclasses, pooled `Buffer` instances, shared/resizable storage, and unexpected values retain the copying fallback.
- Installed dependency source inspection proved `HEAPU8.slice` completes before the WASM pointers are freed. Later-call and mutation tests prove independent results; a real dependency result now must preserve its backing-store identity through the adapter.
- A transfer/detachment test proves the helper can transfer that real backing store and reconstruct exact compressed bytes. Forced-zlib, synchronous/worker-failure fallback, scratch reuse, backpressure, and mid-job worker-death paths remain exact.
- Independent review found no ownership or lifetime defect, requested the real-result engagement/transfer test, and approved the pass after that gap was fixed. The final focused set passes 28/28.

The real-payload micro used 15 rotating HRRR PNG scanline streams, 31 samples per arm, 94,094,700 raw bytes and 15,790,250 deflated bytes. Both arms produced aggregate SHA-256 `f3890cb09200fb5b332e8d69bbfe029a94ed146b3128469ebd245264caf057c9`.

| Measurement                                         |               Baseline |              Candidate |        Result |
| --------------------------------------------------- | ---------------------: | ---------------------: | ------------: |
| Adapter-only median / MAD per 32 MiB logical output | 0.425167 / 0.010624 ms | 0.006000 / 0.001791 ms |       -98.59% |
| Complete deflate + adapter median / MAD             |   13.707792 / 1.106 ms |   13.738750 / 1.518 ms | +0.23%, noise |
| Transient copies over four HRRR frames              |       332 / 196.85 MiB |              0 / 0 MiB |         -100% |

The source-stable warm A/B/B/A renderer gate used two repetitions per leg:

| Arm             | Subprocess samples (ms)                    |          Median / MAD |
| --------------- | ------------------------------------------ | --------------------: |
| Baseline A1+A2  | 8,808.466, 8,826.820, 8,849.448, 8,854.988 | 8,838.134 / 14.084 ms |
| Candidate B1+B2 | 8,868.825, 8,866.428, 8,918.267, 8,833.149 | 8,867.627 / 17.838 ms |

The candidate was 0.334% slower at subprocess median, while base `artifacts` was 0.229% faster and `compressWait` was 0.208% faster; these mixed movements are inside noise. It is accepted only under the contract's compelling low-risk resource clause: approximately 49 MiB of allocation/copy traffic is removed per HRRR frame, with no end-to-end speed claim. Cumulative timing remains `0.00%`.

All warm raw, regrid, derived, supplemental, APCP, freezing-rain, snow-delta, profile, and snowfall-cumulative cache gates remained full hits. The independent comparator found 350/350 manifest-referenced payloads exact across 1,119,256,570 canonical bytes, seven hover containers, one normalized manifest, and four completion markers. There were no meteorological values, finite/missing states, classifications, PNG pixels, hover samples, artifact sizes, signatures, or provenance changes.

Raw schema-v3 summaries:

- `output/noaa-benchmarks/renderer-30pass/pass01-a1-hrrr-20260716-13z-20260723T035345337Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass01-b1-hrrr-20260716-13z-20260723T035410597Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass01-b2-hrrr-20260716-13z-20260723T035437662Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass01-a2-hrrr-20260716-13z-20260723T035506350Z/summary.json`

### Pass 02 — Single-allocation PNG Assembly

Hypothesis: the PNG encoder built an intermediate `IDAT` chunk and then copied that whole chunk again through `Buffer.concat`. Writing the fixed signature, IHDR, IDAT header/body/CRC, and IEND directly into one final buffer can eliminate one payload-sized allocation and copy without changing compression, pixels, PNG bytes, or meteorology.

Implementation and review:

- `assemblePngFromIdat` now allocates exactly `idat.length + 57` bytes and initializes every byte. IHDR occupies bytes 8–32, IDAT 33–`44 + L`, and IEND `45 + L`–`56 + L`.
- The IDAT CRC is calculated from the bytes after they have been copied into the final buffer, so input aliasing or later mutation cannot create a body/CRC disagreement.
- The existing generic `createPngChunk` helper remains allocating and behaviorally unchanged for other callers.
- Independent review found two exported-helper compatibility edges: out-of-range dimensions could lose their former error precedence, and detached IDAT views could throw instead of assembling as empty. Both were fixed and regression-tested. A follow-up review caught an overly broad detached-view fix that would have changed detached RGBA errors; the compatibility path was narrowed to IDAT assembly.
- The final audit validated native and forced fallback CRC implementations, pooled transfer/failure/scratch lifetimes, all buffer boundaries, 1,000 randomized differential cases, range-error ordering, detached IDAT and RGBA behavior, and full initialization of the unsafe allocation. No review finding remains.

Resource accounting on the final four-frame HRRR output found 332 PNGs and 206,409,328 IDAT bytes. The old intermediate chunks allocated `IDAT bytes + 12` each, or 206,413,312 bytes total, and caused one additional 206,409,328-byte (196.847 MiB) payload copy. Both are removed. The final output allocation and its one required input-to-output copy remain.

Two real-payload micros show the benefit and its payload-shape sensitivity:

| Measurement                                             |               Baseline |              Candidate |             Result |
| ------------------------------------------------------- | ---------------------: | ---------------------: | -----------------: |
| Rotating 15-IDAT assembly batch                         |               3.378 ms |               3.226 ms |             -4.51% |
| 1,232,607-byte HRRR `mlcape` IDAT, median / MAD, 31/arm | 0.062399 / 0.001434 ms | 0.045514 / 0.001219 ms |            -27.06% |
| Logical allocation for that `mlcape` PNG                |            2,465,329 B |            1,232,664 B | -1,232,665 B, -50% |

The large-fixture micro used 12 calls per sample, eight warm-up pairs, alternating A/B then B/A order, and GC before each arm. Both implementations and the fixture had SHA-256 `1b6dec6db455ec9da65fce4058c851769c08a33f862d693be75faad57f08f4d5`. A broader golden sweep rebuilt 235/235 real PNGs, totaling 210,557,502 bytes, exactly; its rebuilt aggregate SHA-256 was `b15719d687576c8e11d505b6d6c87b7a0c5425bdaf394499f23a1913cfd5f5eb`.

The final post-review source-stable warm A/B/B/A gate used two repetitions per leg:

| Arm             | Subprocess samples (ms)                    |          Median / MAD |
| --------------- | ------------------------------------------ | --------------------: |
| Baseline A1+A2  | 8,869.829, 8,813.639, 8,885.295, 8,833.811 | 8,851.820 / 25.742 ms |
| Candidate B1+B2 | 8,758.732, 8,815.625, 8,796.535, 8,836.885 | 8,806.080 / 20.175 ms |

The final subprocess median was 0.517% faster. Base-stage medians moved in the same direction (`wall -1.37%`, `artifacts -1.35%`, `compressWait -0.41%`, `catalogPng -0.37%`, `corePng -1.14%`), but the pre-review interleave was only 0.133% faster. This spread is too large for a repeatable end-to-end claim. The pass is accepted only for its exact, low-risk allocation/copy reduction, and verified cumulative timing remains `0.00%` until a fresh campaign-baseline comparison establishes otherwise.

All warm raw, regrid, derived, supplemental, APCP, freezing-rain, snow-delta, profile, and snowfall-cumulative gates remained full hits. The final-source comparator found 350/350 manifest-referenced payloads exact across 1,119,256,570 canonical bytes, seven hover containers, one normalized manifest, and four completion markers; canonical SHA-256 remained `673899b1c087af628be0d3aeec1a2ebff2c376db1ae760e8f794393d9fe6b0de`. There were no meteorological values, finite/missing states, classifications, pixels, hover samples, artifact sizes, signatures, identities, or provenance changes.

Validation passed 29 independent focused PNG/pool/failure tests, the 134-test renderer suite, ESLint, Prettier, and `git diff --check`. Final candidate source-tree SHA-256 is `480ca40196189e48fed236b9490c2e078aa451fe736a365b94c36f3436a5e87d`.

Raw schema-v3 summaries:

- `output/noaa-benchmarks/renderer-30pass/pass02f-a1-hrrr-20260716-13z-20260723T041251582Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass02f-b1-hrrr-20260716-13z-20260723T041316481Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass02f-b2-hrrr-20260716-13z-20260723T041342928Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass02f-a2-hrrr-20260716-13z-20260723T041408109Z/summary.json`

### Pass 03 — Dependency-proven Sparse Mercator-pack Reads

Hypothesis: a warm profile-derived sidecar already restores the expensive severe/profile outputs, but the renderer still reads all 150–152 physical Mercator grids—about 0.9 GiB per HRRR frame—before discarding the profile-only inputs. A fail-closed dependency graph can omit only physical fields whose complete consumer set is satisfied by an exact-provenance sidecar.

Implementation and architectural review:

- Selection now owns a deterministic, versioned dependency graph with direct, source, profile, and support roles. Failed staged catalog entries leak neither records nor ownership. Reused physical records accumulate owners, aliases remain retained if any alias is live, and selection identity is built from immutable decode-cache identities so later byte-range repair cannot invalidate a valid plan.
- The restored-grid contract uses actual emitted names rather than availability aliases: legacy SCP restores `effectiveBulkShear`, and fixed-layer STP restores `bulkShear0to6km`. Every grid must be an exact-size `Float32Array`, and the sorted restored roster must match the exact selection-derived roster.
- Pressure-height fields used implicitly by terrain masks are support dependencies, including levels introduced through `sourceSelectors` for frontogenesis and vorticity. Winter/lazy-snow profile owners are legitimate but never satisfiable by this severe-profile sidecar, so those records remain live.
- The renderer accepts a sparse plan only after the full Mercator-pack descriptor validates and only when the call-scoped decode outcome proves the same exact pack payload hash. Mixed record-cache provenance, a legacy fallback, a stale/tampered plan, a partial roster, a shape mismatch, or an unknown outcome discards the sidecar and computes from the grids actually returned.
- The pack format is now `mercator-grid-pack-v3-entry-crc32`. It validates exact contiguous key/offset/missing coverage, checks every consumed entry before registry seeding, and binds that layout plus every CRC in a canonical SHA-256 manifest. CRC32 is deliberately an accidental local-cache corruption guard, not authentication; the residual random-collision probability is approximately `2^-32` per corrupted consumed entry. A same-size mismatch closes/rechecks the slice, avoids false hit counters, blacklists and invalidates metadata before body, falls back safely, then cold-rebuilds.
- Native CRC32 requires Node 20.15; the declared floor is raised to Node 20.19, which is already required by the installed Vite toolchain. An independent real-volume micro over 413,952,000 bytes measured CRC32 at 8.987 ms versus SHA-256 at 118.562 ms, 13.19x checksum throughput. The earlier SHA-per-entry prototype was rejected because its roughly 119–131 ms/frame verification cost erased the I/O benefit.
- The deliberate v2-to-v3 first run is cold. Only exact recomputable v2/v1 pack siblings are removed after successful v3 body-plus-metadata publication. Profile-derived v1 namespace files and exact winter-profile v2 siblings are likewise removed only after their replacement publishes; publication or cleanup failure preserves correctness. This avoids retaining approximately 38.7 GiB of unreachable profile bodies observed in the campaign fixture.

The HRRR F001–F003 base frames read 66/152 physical fields and 413,952,000/953,344,000 bytes; F000 read 64/150 and 401,408,000/940,800,000 bytes. Every frame therefore avoids 86 fields and 539,392,000 bytes (514.404 MiB), or 2,157,568,000 bytes across four base frames, while keeping the full disk pack as the cold authoritative source. The warm CRC candidate's grid-map median fell from 76.25 to 38.95 ms (`-48.92%`).

The independent four-model migration/warm gate confirmed the same fail-closed behavior and the model-dependent resource ceiling:

| Model    | Representative warm fields | Representative warm bytes | Bytes skipped/frame | Skipped | Exact payloads / canonical bytes |
| -------- | -------------------------: | ------------------------: | ------------------: | ------: | -------------------------------: |
| GFS      |                      61/72 |   382,592,000/451,584,000 |          68,992,000 |  15.28% |              305 / 1,008,674,503 |
| NAM      |                      53/64 |   332,416,000/401,408,000 |          68,992,000 |  17.19% |                289 / 926,260,411 |
| NAM 3 km |                     65/151 |   407,680,000/947,072,000 |         539,392,000 |  56.95% |              343 / 1,130,204,756 |
| HRRR     |                     66/152 |   413,952,000/953,344,000 |         539,392,000 |  56.58% |              350 / 1,119,256,570 |

All 16 warm base frames reported pack hits, sparse hits, derived-sidecar hits, and supplemental-sidecar hits with no corruption, fallback, or write-failure diagnostic. Across all models, 1,287/1,287 manifest-referenced payloads and 4,184,396,240 canonical bytes were exact.

The final source-stable A/B/B/A gate used two repetitions per leg:

| Arm           | Subprocess samples (ms)                    |          Median / MAD |
| ------------- | ------------------------------------------ | --------------------: |
| Pass 02 A1+A2 | 8,881.222, 8,696.415, 8,573.187, 8,642.930 | 8,669.672 / 61.614 ms |
| Pass 03 B1+B2 | 8,698.146, 8,625.162, 8,580.448, 8,589.527 | 8,607.345 / 22.357 ms |

The candidate is 0.719% faster at subprocess median. The directly affected stage is repeatable and much larger than its noise (`gridMap -48.92%`); end-to-end movement is still modest relative to baseline variability, so the accepted claim is the exact 514.4 MiB/frame resource reduction plus the stage result, not a guaranteed 0.719% wall-clock speedup. Against the committed campaign-baseline median, this candidate is directionally 1.363% faster; the campaign's final aggregate interleave will re-establish the cumulative claim.

The manifest-referenced HRRR comparator found 350/350 payloads exact across seven decoded hover containers and 1,119,256,570 canonical bytes. Manifest identity/science metadata and four completion markers were exact after timestamp/profile normalization; canonical SHA-256 remained `673899b1c087af628be0d3aeec1a2ebff2c376db1ae760e8f794393d9fe6b0de`. The full and sparse terrain regression also proves byte-identical derived output while a counterfactual missing 850-mb height produces a scientifically invalid finite frontogenesis value below terrain.

Validation passed the complete 990/990 Node suite and the independently isolated 205/205 focused/relevant matrix, plus typecheck, ESLint, Prettier, and `git diff --check`. The test matrix includes cold/full and warm/sparse decode, exact cell/roster validation, physical aliases, immutable post-range-repair identity, non-sidecar winter owners, pressure-terrain support, mixed record-cache provenance, full/sparse concurrent promise isolation, same-size corruption, short reads, strict mode, atomic publication, writer races, publication/cleanup failure, telemetry parsing, and exact legacy-migration boundaries. Three independent reviews covered selection/science dependencies, renderer/provenance orchestration, and bulk-cache integrity/concurrency.

Final candidate source-tree SHA-256 is `5d273b5a1d292e60ca3456649ede541e36a77b60d53d9b20636e94a37defe968` over 116 scoped files and 101,232,616 bytes.

Raw schema-v3 summaries:

- `output/noaa-benchmarks/renderer-30pass/pass03-final-a1-hrrr-20260716-13z-20260723T050255432Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass03-final-b1-hrrr-20260716-13z-20260723T050320875Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass03-final-b2-hrrr-20260716-13z-20260723T050350057Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass03-final-a2-hrrr-20260716-13z-20260723T050457897Z/summary.json`
- Migration-only evidence: `output/noaa-benchmarks/renderer-30pass/pass03-crc-migration-hrrr-20260716-13z-20260723T045952588Z/summary.json`
- Warm sparse validation: `output/noaa-benchmarks/renderer-30pass/pass03-crc-sparse-validation-hrrr-20260716-13z-20260723T050219827Z/summary.json`
- GFS migration/warm: `output/noaa-benchmarks/renderer-30pass/pass03-crc-gfs-migration-gfs-20260716-06z-20260723T050722475Z/summary.json`, `output/noaa-benchmarks/renderer-30pass/pass03-crc-gfs-warm-validation-gfs-20260716-06z-20260723T050748830Z/summary.json`
- NAM migration/warm: `output/noaa-benchmarks/renderer-30pass/pass03-crc-nam-migration-nam-20260716-12z-20260723T050714313Z/summary.json`, `output/noaa-benchmarks/renderer-30pass/pass03-crc-nam-warm-validation-nam-20260716-12z-20260723T050740395Z/summary.json`
- NAM 3 km migration/warm: `output/noaa-benchmarks/renderer-30pass/pass03-crc-migration-nam3km-20260716-12z-20260723T050647701Z/summary.json`, `output/noaa-benchmarks/renderer-30pass/pass03-crc-warm-validation-nam3km-20260716-12z-20260723T050732191Z/summary.json`

### Pass 04 — Bounded Cooperative Artifact Encoding

Hypothesis: the compression helpers already run off-thread, but synchronous artifact production can submit almost an entire frame before consuming a result. Once the two-slot pool fills, every additional submission makes a full input snapshot and joins an unbounded waiter list; hover is also compressed late, leaving a long final codec-only tail. Submitting hover immediately after the first PNG and cooperatively admitting later work should overlap more compression with raster work while bounding retained raw buffers.

This is an architectural scheduling and ownership change, so it received separate implementation, concurrency/failure, science/output, and benchmark-method reviews. Findings discovered during those reviews were fixed before the benchmark candidate was frozen:

- A frame-local `ArtifactEncodeCoordinator` now queues start functions rather than prepared PNG scanlines. It admits at most the pool's pending budget, preserves FIFO start order, owns every rejection in the creation turn, drains all work, and reports the earliest submission failure only after the full drain.
- A pool-scoped admission gate prevents two concurrent frame builders from independently exceeding the real shared pool cap. Tests cover two simultaneous frames, real one- and two-thread pools, zero pool waiters, worker death while work is active/global-gated/frame-queued, and exact inline fallback.
- The temperature PNG is submitted first and the packed hover body within the first two codec jobs. The hover variable planes are expression-local and leave scope before the first cooperative await. A fail-closed exact-shape gate reproduces the old late `hoverValueCounts` behavior for malformed tracked grids; untracked reflectivity, height, pressure, and precipitation-rate compatibility remains unchanged.
- Layer jobs retain immutable RGBA until admission and create filter-0 scanlines only after a slot exists. The one reusable main-thread scratch is released immediately after the helper's synchronous structured clone. Decoded masked-raster caches are released at the original last-raster boundary, with idempotent exception cleanup.
- Composite and 1-km reflectivity keep the normal three-gate roster in one fused scan with no phase drain. Unusual rosters are processed in batches of four to eight; at most eight raw planes, or `32 × width × height` bytes, are materialized for a roster regardless of gate count. A following batch begins only after the previous batch's queued owners drain.
- Profile telemetry separates cooperative `artifactBackpressureMs` from the final `compressWaitMs`, records checkpoint/submission/peak-active/peak-queued counters, and preserves the existing serialized stage-key order. Stage values that moved across the new accounting boundary are not compared directly.
- Error review fixed out-of-order checkpoint failure reporting, cross-frame global overflow, frozen-error mutation, cache retention through the drain, arbitrary-roster RGBA growth, normal-roster drain barriers, and variable-plane retention. Every issue has a focused regression.

The final frozen candidate matched the live source before and after timing: SHA-256 `e8504e00565c85933aaa4b539853d3b1c504b70355212a5166b55b940eab2b0c` over 117 scoped files and 101,250,435 bytes. The Pass 03 arm remained `5d273b5a1d292e60ca3456649ede541e36a77b60d53d9b20636e94a37defe968`. Symmetric warmups preceded the source-stable A/B/B/A interleave; every session reported zero process, fixture, frame, or source-stability failures.

| Arm           | Subprocess samples (ms)                    |          Median / MAD |
| ------------- | ------------------------------------------ | --------------------: |
| Pass 03 A1+A2 | 8,575.303, 8,571.529, 8,519.573, 8,521.027 | 8,546.278 / 25.978 ms |
| Pass 04 B1+B2 | 7,291.770, 7,259.523, 7,226.740, 7,229.616 | 7,244.569 / 16.391 ms |

Pass 04 is 15.231% faster at subprocess median. To avoid pooling unlike F000–F003 workloads, affected-stage evidence uses the sum of the same four main frames within each repetition:

| Fixed four-frame measure | Pass 03 median / MAD | Pass 04 median / MAD |    Delta |
| ------------------------ | -------------------: | -------------------: | -------: |
| Main-frame wall sum      |   7,600.65 / 7.70 ms |   6,298.90 / 4.60 ms | -17.127% |
| Artifact-stage sum       |  6,449.25 / 10.95 ms |   5,139.80 / 4.45 ms | -20.304% |
| Exposed codec stall      |   4,128.95 / 8.40 ms |   2,930.35 / 2.80 ms | -29.030% |

“Exposed codec stall” is diagnostic, not a direct stage-equivalence claim: the old value is the late `compressWait` sum, while the candidate is cooperative backpressure plus final wait. Candidate backpressure was 2,904.30 ms median and the final drain was only 26.00 ms; subprocess wall and fixed-roster artifact sums are the performance claims. Every forecast hour moved in the same direction:

| Hour | Main wall, Pass 03 -> 04 |   Delta | Artifact time, Pass 03 -> 04 |   Delta |
| ---: | -----------------------: | ------: | ---------------------------: | ------: |
| F000 |     1,555.15 -> 1,281.15 | -17.62% |         1,393.50 -> 1,116.20 | -19.90% |
| F001 |     1,841.35 -> 1,515.45 | -17.70% |         1,610.20 -> 1,283.40 | -20.30% |
| F002 |     1,891.70 -> 1,568.65 | -17.08% |         1,628.80 -> 1,309.70 | -19.59% |
| F003 |     2,312.20 -> 1,930.55 | -16.51% |         1,818.00 -> 1,429.45 | -21.37% |

An untimed real-HRRR resource probe used separate copy-on-write cache clones and frozen source copies instrumented with one append-only observation at `CompressPool.submit`; these runs are resource evidence only and are excluded from timing. Both arms made 287 codec submissions. Pass 03 created 279 parked full-buffer snapshots totaling 2,590,632,500 bytes (2,470.620 MiB, or 2.412715 GiB): 275 PNG snapshots totaling 1,725,069,500 bytes and four Brotli snapshots totaling 865,563,000 bytes. Its resulting queue peak was 73 simultaneous waiters retaining 677,453,604 bytes (646.070 MiB); the earlier pre-submit counters at that same peak-producing call were 72 waiters and 451,654,560 bytes. Pass 04 created zero pool waiters and zero waiter-snapshot bytes. In the clean timed candidate, each base frame reported `artifactPeakActive=2`, an omitted/zero queued peak, submissions exactly equal to compression jobs (`63/74/75/75`), `62/73/74/74` cooperative checkpoints, and no fallback.

The manifest-referenced four-model gate compared 1,287/1,287 payloads, 28 decoded hover containers, 4,184,396,240 canonical bytes, four normalized manifests, and 16 completion markers with zero mismatch. Aggregate canonical SHA-256 was identical at `a015c6a0c7fa4c9300c56eda4a27012bc78c657892b718bb14909c8b2826b7c7`; the HRRR-only canonical hash remained `673899b1c087af628be0d3aeec1a2ebff2c376db1ae760e8f794393d9fe6b0de`. A second independent full-directory comparison covered 1,348/1,348 rendered payloads, including non-manifest-referenced files, and found every payload byte-identical; only volatile timestamps differed before normalization. Science/output review additionally covered filters 0/1/2, binary and JSON hover, rich masked and smoothed catalog output, gate ordering/aliases, empty and malformed grids, and no-pool fallback. The change is byte-exact and has no meteorological or scientific movement.

Validation passed 1,001/1,001 Node tests and 164/164 browser smoke tests. Focused matrices separately exercised coordinator FIFO/error semantics, shared-pool admission, normal and 24-gate reflectivity, worker death, malformed hover shapes, deferred descriptors, parameter availability, cache lifetime, and full-catalog byte parity. Typecheck, ESLint, Prettier, and `git diff --check` passed. Four independent reviews covered implementation, concurrency/failure/memory bounds, scientific/output compatibility, and benchmark/evidence validity.

Against the committed campaign baseline median of 8,726.318 ms, Pass 04 is freshly 16.980% faster. This replaces the earlier directional cumulative estimate; the final campaign interleave will remeasure the total after all twenty passes.

Raw schema-v3 summaries:

- `output/noaa-benchmarks/renderer-30pass/pass04-final-a1-hrrr-20260716-13z-20260723T055534250Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass04-final-b1-hrrr-20260716-13z-20260723T055559283Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass04-final-b2-hrrr-20260716-13z-20260723T055621523Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass04-final-a2-hrrr-20260716-13z-20260723T055734892Z/summary.json`
- Four-model candidate renders: `output/noaa-benchmarks/renderer-30pass/pass04-allmodel-gfs-gfs-20260716-06z-20260723T060646455Z/summary.json`, `output/noaa-benchmarks/renderer-30pass/pass04-allmodel-nam-nam-20260716-12z-20260723T060710351Z/summary.json`, `output/noaa-benchmarks/renderer-30pass/pass04-allmodel-nam3km-nam3km-20260716-12z-20260723T060731928Z/summary.json`
- Untimed instrumented resource probes: `output/noaa-benchmarks/renderer-30pass/pass04-resource-probe-a6-hrrr-20260716-13z-20260723T060554441Z/summary.json`, `output/noaa-benchmarks/renderer-30pass/pass04-resource-probe-b5-hrrr-20260716-13z-20260723T060517393Z/summary.json`

### Pass 05 — Exact Indexed-color Categorical PNGs

Hypothesis: categorical layers already choose from small, fixed RGBA palettes, but the PNG pipeline still materializes and compresses four bytes per pixel. Encoding the category index directly as PNG color type 3 can reduce compression input, worker-transfer volume, and stored artifacts without changing a decoded pixel or any meteorological calculation.

Implementation and architectural review:

- Only four exact categorical families are eligible: precipitation accumulations, precipitation rate/type, composite and 1-km reflectivity gates, and 1-km reflectivity precipitation type. Continuous scalar fields, snow, severe, synoptic, contours, and transparent fallback artifacts remain color type 6.
- Each eligible raster is produced in one branded scan that returns its index plane and exact palette. The encoder writes a deterministic color-type-3 PNG with filter 0, `PLTE`, a full `tRNS`, `IDAT`, and checked CRCs. Decoding reconstructs the same RGBA bytes that the previous raster path produced.
- Generic public encoder and pool APIs validate every palette index. Separately named private trusted helpers may skip a second bounds scan only after receiving a raster privately branded by the categorical renderer. An independent review found that the first implementation let generic callers request the trusted path; the API was split and regression-tested before timing.
- The final trust-boundary audit then found four defensive gaps and held the benchmark until all were fixed. Internal indexed layers now expose only frozen metadata while their buffers stay in a module-private `WeakMap`; generic encoders snapshot both caller-controlled views before validating either; width and height are canonicalized exactly once at the public boundary; and palette caches rebuild after any exact content mutation. Stateful `valueOf`, buffer-swapping, queued mutation, and scalar/multi-phase palette-mutation regressions cover each finding.
- Indexed jobs use a dedicated reusable scanline scratch and obey the existing frame-local and shared-pool ownership limits. Tests cover queued-buffer mutation, transfer detachment, submit failure, worker death, inline fallback, pool recovery, and scratch reuse. A real worker-death test includes an indexed job.
- The renderer signature advances to `noaa-grib2-beta-v52-indexed-categorical-png`. Telemetry reports indexed job count, indexed raw bytes, and avoided RGBA raw bytes. The artifact comparator advances to schema v2 with a new opt-in `--png-comparison=decoded-rgba` mode; its default exact-container mode remains unchanged. The decoded mode validates dimensions and declared byte counts, compares dimension-framed RGBA, verifies the signature transition in manifests and completion markers, inventories every changed container deterministically, and fails closed on malformed PNG or metadata.
- Separate implementation, science/browser, hotspot/resource, and root reviews examined palette completeness, alpha, threshold and precedence behavior, NaN/missing handling, API trust boundaries, helper failures, concurrency, container validation, and benchmark method. All findings were fixed before the source was frozen.
- The final no-edit audit found no P0–P2 issue. It recorded one P3 cleanup candidate: the trusted cross-module fast-path helpers are CommonJS-exported even though the current call graph reaches them only after the raster module's private-owner gate. Encapsulating that surface without restoring the eliminated bounds scan requires a separate module-boundary refactor and is retained in the queue rather than mixed into this measured pass.

This pass is exact, not approximate. A randomized differential oracle covered 600,245 scalar probes around palette thresholds, adjacent floating-point values, NaN/missing inputs, alpha, and precipitation-type precedence with zero RGBA mismatch. A direct Chromium gate decoded synthetic output through `createImageBitmap`, `<img>`, and canvas and matched all bytes, including alpha; a targeted renderer/browser matrix passed 60/60. There are no changed meteorological values, finite/missing states, threshold decisions, classifications, or decoded pixels.

The four-model resource result is deterministic:

| Model    | Indexed PNGs | Indexed raw bytes | RGBA raw bytes avoided |
| -------- | -----------: | ----------------: | ---------------------: |
| GFS      |           47 |        73,742,060 |            221,088,000 |
| NAM      |           46 |        72,173,080 |            216,384,000 |
| NAM 3 km |           50 |        78,449,000 |            235,200,000 |
| HRRR     |           48 |        75,311,040 |            225,792,000 |
| Total    |          191 |       299,675,180 |            898,464,000 |

The final source-stable A/B/B/A gate used two repetitions per leg:

| Arm           | Subprocess samples (ms)                    |          Median / MAD |
| ------------- | ------------------------------------------ | --------------------: |
| Pass 04 A1+A2 | 7,344.621, 7,312.678, 7,363.850, 7,308.739 | 7,328.649 / 17.941 ms |
| Pass 05 B1+B2 | 7,165.039, 7,118.167, 7,108.830, 7,087.877 | 7,113.499 / 15.145 ms |

Pass 05 is 2.936% faster at subprocess median. The same 16 main-frame samples per arm moved in the expected direction:

| Main-frame stage      | Pass 04 median / MAD | Pass 05 median / MAD |   Delta |
| --------------------- | -------------------: | -------------------: | ------: |
| Main wall             | 1,560.45 / 149.50 ms | 1,492.50 / 129.65 ms | -4.355% |
| Artifacts             |  1,309.20 / 75.15 ms |  1,240.95 / 74.20 ms | -5.213% |
| Artifact backpressure |    746.95 / 17.95 ms |    683.70 / 14.95 ms | -8.468% |

Against the committed campaign baseline median of 8,726.318 ms, the frozen Pass 05 candidate is freshly 18.482% faster. The candidate source-tree SHA-256 is `a741df0f2fe385f498a48ac64d6f4f53b3df05920ae6f3220046b10ad4faadc0` over 117 scoped files and 101,298,247 bytes; the Pass 04 arm remained `e8504e00565c85933aaa4b539853d3b1c504b70355212a5166b55b940eab2b0c`.

The manifest-referenced HRRR comparison found 350/350 payloads semantically exact, including seven hover payloads and 712 declared PNG references. Exactly 48 allowlisted PNG containers changed; their stored bytes fell from 1,836,479 to 888,785 (`-51.604%`) while 2,888,616,903 dimension-framed canonical bytes remained exact at SHA-256 `d2fc6d85e95efbfbe7da521f6918da1c5fe4237a0b54ff9048668ff4186ea05f`. The changed-container inventory SHA-256 is `76031da7f75fb9814685b3879f2a590e6b136402f0197ddd45e287564412affa`.

The four-model comparison found 1,287/1,287 payloads, 28 hover payloads, four manifests, and 16 completion markers semantically exact. Exactly 191 allowlisted PNG containers changed. Total stored bytes fell from 1,468,692,788 to 1,463,910,578, and the changed active containers fell from 9,767,675 to 4,985,465 bytes (`-48.960%`). All 10,530,606,664 decoded/dimension-framed canonical bytes matched at SHA-256 `84c54df19c11124617132bde108459c1863637d141984ae4491a2a11629f0454`, with zero inventory, decode, byte-count, manifest, marker, or signature-transition errors.

Validation passed the complete 1,034/1,034 Node suite, 164/164 browser smoke tests, typecheck, targeted ESLint with zero errors, Prettier, and `git diff --check`. The randomized 600,245-probe science oracle and 60/60 targeted renderer/browser matrix remained exact. All final benchmark sessions reported stable sources, valid fixtures, full warm cache hits, no process/frame failures, and no codec fallback. GFS, NAM, and NAM 3 km candidate renders were cold validation runs and support parity/resource claims only.

The first attempted baseline warm-up (`pass05-warm-a`) could not resolve the pinned NOAA run because sandbox networking was denied; it failed fixture validation and is excluded from all evidence. The successful migration warm-ups and the final-source `pass05final2-warm-a`/`pass05final2-warm-b` symmetry warm-ups are also excluded from performance evidence. All timing made before the final trust-boundary fixes is superseded by the source-stable `pass05final2-*` interleave. No application cache was cleared or rendered into.

Raw schema-v3 summaries:

- `output/noaa-benchmarks/renderer-30pass/pass05final2-a1-hrrr-20260716-13z-20260723T074419953Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass05final2-b1-hrrr-20260716-13z-20260723T074442848Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass05final2-b2-hrrr-20260716-13z-20260723T074500319Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass05final2-a2-hrrr-20260716-13z-20260723T074517576Z/summary.json`
- Four-model candidate renders: `output/noaa-benchmarks/renderer-30pass/pass05final2-allmodel-gfs-gfs-20260716-06z-20260723T074605360Z/summary.json`, `output/noaa-benchmarks/renderer-30pass/pass05final2-allmodel-nam-nam-20260716-12z-20260723T074615005Z/summary.json`, `output/noaa-benchmarks/renderer-30pass/pass05final2-allmodel-nam3km-nam3km-20260716-12z-20260723T074624269Z/summary.json`

### Pass 06 — Direct RGBA-to-scanline Rendering (Rejected)

Hypothesis: the remaining type-6 PNG layers first materialize RGBA and then copy it into filter-0 scanlines. Rendering directly into the scanline layout might remove that copy and one live plane.

The architectural audit rejected implementation after measuring the full opportunity:

- The final four-frame HRRR roster has 215 eligible active type-6 jobs: 157 continuous layers and 58 affine-vector layers, totaling 1,348,480,000 RGBA bytes. The current bounded coordinator retains at most two such planes, about 11.96 MiB, rather than the entire roster.
- A reproducible micro decoded 15 real HRRR PNGs once, then packed 94,080,000 RGBA bytes into one reused filter-0 scratch per trial. Across 31 samples it measured `2.183209 ms` median, `0.027251 ms` MAD, `2.151125 ms` p10, and `2.248750 ms` p90. Linear extrapolation to all 215 jobs is only `31.292662 ms`, or `0.431947%` of the accepted Pass 04 renderer median.
- That number is an upper bound, not an expected gain. A direct writer would duplicate substantial colorization logic, complicate the helper-failure rerender contract, and forfeit the existing rasterizer's measured native `Uint32` store advantage (about 4.77%) on the common aligned path. The likely net gain is therefore smaller than the ceiling and below this campaign's architectural risk threshold.
- Review of the neighboring indexed path did uncover the stateful-dimension trust-boundary issue described in Pass 05. It was fixed and regression-tested before Pass 05's final freeze; no direct-scanline production code was written or retained.

The hypothesis is rejected with no meteorological or artifact change and no renderer A/B claim. Cumulative measured improvement remains 18.482%. The persisted evidence is `/private/tmp/pass06-scanline-pack-evidence.json` (SHA-256 `f216c7991de6295a71b058862d430cb1acf72ff7a2a129d1be54830d3433ae51`); its reproducer is `/private/tmp/pass06-scanline-pack-micro.js` (SHA-256 `57996a2f6e1f7615dd3ea22a6fdeab9a76024503cb928c1b72bb2d7e849ae4d5`) and binds the 15-artifact fixture at aggregate SHA-256 `b2f490d94403dc7a00fec800fdbdf87e6c7f97e761b2ecbe30f00faa6d148708`.

### Pass 07 — Owned-buffer Browser Hover Decoding

Hypothesis: `response.arrayBuffer()` already gives the browser exclusive ownership of the decompressed 225.8 MB hover container, but the parser copied each of its 72 variable planes into a separate allocation. Validating the canonical binary layout once, reconstructing its global v3 delta stream in place, and returning typed-array views over the response owner can remove all per-variable copies without changing one stored sample.

Implementation and review:

- The fetch path alone calls the ownership-consuming parser. The generic exported parser first copies its input and therefore preserves its former caller-isolation contract. Canonical zero-copy engagement requires native little-endian storage, positive safe dimensions and product, matching magic/schema, aligned descriptors in exact insertion order, exact `rows × cols` lengths, contiguous non-overlapping coverage, and no trailing bytes.
- Noncanonical legacy layouts retain a copy decoder, but aggregate allocation is capped at twice the referenced data. Every descriptor must resolve to exactly `rows × cols` and prove its complete byte range in-bounds before any v3 reconstruction. Truncation, partial descriptors, unsafe dimensions, hostile descriptor counts, dangerous object keys, and malformed maps fail empty.
- JSON/base64 normalization now also fails before allocation on unsafe products, more than 16,777,216 cells, more than 512 MiB aggregate decoded data, more than 768 MiB encoded text, short data, or excessive per-variable amplification. The actual 980 × 1,600, 72-variable producer payload is inside every bound.
- Cache accounting charges each retained `ArrayBuffer.byteLength` once globally and refcounts it across URL, supplemental, and merged entries; metadata remains per entry. Replacement, LRU promotion, multi-entry byte eviction, and final-owner release use one deletion path.
- Independent review found that the first fallback could turn a truncated v3 tail into valid meteorological zeros and that hostile JSON dimensions could request a multi-gigabyte allocation. Both findings were reproduced, fixed, regression-tested, and re-reviewed before the final benchmark.

The final source-bound Chromium benchmark used the actual HRRR F003 Brotli artifact: 41,461,711 stored bytes, 225,799,044 decompressed bytes, 72 variables, and 112,896,000 `Int16` samples. It alternated ABBA/BAAB for eight cycles, excluded one warm-up per arm, and retained 16 samples per arm:

| Browser measurement        | Baseline median / MAD | Candidate median / MAD |    Delta |
| -------------------------- | --------------------: | ---------------------: | -------: |
| Parser boundary            |    133.115 / 0.678 ms |      54.783 / 0.278 ms | -58.846% |
| Fetch through decoded      |    409.887 / 0.772 ms |     331.848 / 0.425 ms | -19.039% |
| 4,718,592 steady reads     |     41.602 / 0.113 ms |      40.510 / 0.142 ms |  -2.626% |
| Peak held backing bytes    |         451,591,044 B |          225,799,044 B | -49.999% |
| Distinct variable backings |                    72 |                      1 | -98.611% |

Both bundled implementations produced exact aggregate sample SHA-256 `591853278cfd9406961af78a9965650545825e0f4b7d8e9ce869b41e0c04d3f4`; all 72 candidate views were backed by the response buffer. The byte result is exact backing-store accounting at the parser boundary, not a claim about whole-process JS heap. The fetch-to-decoded measurement ends immediately after normalization and therefore excludes cache description/refcount and supplemental merge work.

A separate audit validated all 28 real four-model containers as canonical, covering 1,666,784,000 samples and 3,333,568,000 bytes of avoidable copies. Final browser evidence is `/private/tmp/pass07-hover-zero-copy-production-browser-final-evidence.json` (SHA-256 `ec13eb6d6bd9da3309425a63d732fca5d6d615883706c31c687c25455c36ffa6`); the layout audit is `/private/tmp/pass07-hover-zero-copy-layout-evidence.json` (SHA-256 `6a330bfe7ba532570570b5bbcf70e4ae20c0d662b1b83d0301208a675102d722`). The final parser source SHA-256 is `ff6d5a85b7ed3e35e10f469bb13c952a81f3b6b97701e92ca6107547a6055c47`.

Validation passed the 35-test focused cache/parser/v3/lifecycle set, the independently reviewed 89-test wider client/manifest matrix, typecheck, ESLint, Prettier, and `git diff --check`. This is a client decode/resource pass, so server renderer cumulative timing remains 18.482%. It changes no sample, scale, offset, missing sentinel, weather classification, threshold, raster pixel, server artifact, or meteorological value.

### Pass 08 — Exact Continuous Catalog Colorizer in WASM

The original queue placed this kernel at Pass 12, but Pass 06 removed the intervening direct-scanline opportunity and a production roster audit measured continuous colorization as the largest remaining compute-only renderer loop. It was therefore pulled forward under the high-yield-first rule.

Hypothesis: the raw and affine continuous catalog colorizers perform hundreds of millions of identical scalar f64 lookup operations in JavaScript. Porting only those exact shapes into the already thread-local parcel WASM module can reduce catalog preparation while retaining the JavaScript implementation as the authoritative fallback.

This is an architectural native-kernel extension and received separate implementation, arithmetic/memory/failure, benchmark, and root reviews:

- The AssemblyScript kernel reads `Float32` source cells but preserves JavaScript f64 operation order for affine scale/offset/min clamp, finite checks, visibility gates, lookup position, bucket selection, alpha, RGBA byte order, and visible/valid counters. Log lookups, callback transforms, non-`Float32Array` inputs, invalid lookup shapes, and nonpositive scales remain on JavaScript.
- Scratch is bounded to 32,768 cells and a 65,536-entry palette. Input, output, palette, and stats ranges must be aligned, in-bounds, and mutually non-overlapping in the current module memory. The synchronous driver copies every output chunk into an owned `Buffer`; one unshared kernel instance per render worker makes reuse non-reentrant.
- Review reproduced a malformed same-shape export that returned no stats and was initially accepted as a blank 0/0 layer. The final loader requires colorizer ABI version 1 and runs a deterministic six-value/four-color semantic canary covering affine operations, visibility, nonfinite input, endpoint buckets, transparent alpha, output bytes, and both counters. Every call poisons its counters to `-1`; traps, detached/grown memory, stale semantics, invalid counters, or partial writes quarantine only the optional colorizer, zero the partial destination, and rerun exact JavaScript. The parcel kernel remains available.
- The tracked 53,726-byte WASM binary rebuilt byte-identically in an independent location at SHA-256 `0673dbd155f2f63216e7ab9171f8852d0d93dd650b9c2c82c01911dcfe405c93`; it has zero imports. The frozen candidate source tree is `c3533b29fdf4a5abc70295901b0006fca6eee6f5e0b05828e3ed2e2e76acd1e4` over 117 scoped files and 101,311,455 bytes.

The exact production-roster A/B used real HRRR F000–F003 fields: 226 colorizations, 354,368,000 cells, and 1,417,472,000 output RGBA bytes per arm. Sixteen alternating retained samples per arm, after excluded warm-ups, matched every RGBA byte and visible/valid counter:

| Roster measurement |               Baseline |            Candidate |                    Result |
| ------------------ | ---------------------: | -------------------: | ------------------------: |
| Median / MAD       |    881.541 / 64.545 ms |   506.263 / 1.489 ms |                  -42.571% |
| p10 / p90          | 836.584 / 1,017.160 ms | 503.933 / 507.930 ms | positive conservative gap |
| Median saved       |                        |                      |                375.278 ms |

The stricter sum of per-fixture baseline-p10 minus candidate-p90 gaps was still positive at 284.203 ms. The 5.276% ratio to the accepted Pass 05 wall median is an isolated ceiling, not an end-to-end claim. Evidence is `/private/tmp/pass08-production-colorizer-ab-evidence.json` (SHA-256 `3b45b3efe84c423b76035eb69fa345cfa89412a5780bae5fd39127dd40323c4c`).

The final source-stable renderer A/B/B/A used two repetitions per leg:

| Arm           | Subprocess samples (ms)                    |          Median / MAD |
| ------------- | ------------------------------------------ | --------------------: |
| Pass 05 A1+A2 | 7,072.836, 7,063.916, 7,053.092, 7,138.525 |  7,068.376 / 9.872 ms |
| Pass 08 B1+B2 | 7,025.097, 6,962.641, 6,981.805, 7,007.835 | 6,994.820 / 21.646 ms |

Pass 08 is 1.041% faster at subprocess median. Baseline p10 was 7,056.339 ms while candidate p90 was 7,019.918 ms, leaving a positive conservative separation. Against the campaign baseline of 8,726.318 ms, fresh cumulative improvement is 19.842%.

The final all-model gate rebuilt GFS, NAM, NAM 3 km, and HRRR from the isolated candidate cache clone. It compared 1,287/1,287 manifest-referenced payloads, 28 decoded hover containers, 4,179,614,030 canonical bytes, four normalized manifests, and 16 completion markers with zero inventory, container, byte, metadata, or marker mismatch. Aggregate canonical payload SHA-256 was exact at `5b87eb008e1906ba08078b3d87780847cb782cdf08c3b6448b2354cf92b9f526`.

Validation passed 11/11 dedicated ABI/canary/exactness/failure/ownership/thread tests, the independent 84/84 kernel/raster matrix, typecheck, ESLint, Prettier, reproducible WASM build, and `git diff --check`. No approximation was used: every PNG container, decoded pixel, visible/valid count, meteorological value, finite/missing state, threshold decision, classification, manifest, and completion marker is exact.

Raw schema-v3 summaries:

- `output/noaa-benchmarks/renderer-30pass/pass08f-final-a1-hrrr-20260716-13z-20260723T083417154Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass08f-final-b1-hrrr-20260716-13z-20260723T083445802Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass08f-final-b2-hrrr-20260716-13z-20260723T083513815Z/summary.json`
- `output/noaa-benchmarks/renderer-30pass/pass08f-final-a2-hrrr-20260716-13z-20260723T083538584Z/summary.json`
- Four-model candidate renders: `output/noaa-benchmarks/renderer-30pass/pass08f-all-model-gfs-gfs-20260716-06z-20260723T083714498Z/summary.json`, `output/noaa-benchmarks/renderer-30pass/pass08f-all-model-nam-nam-20260716-12z-20260723T083728941Z/summary.json`, `output/noaa-benchmarks/renderer-30pass/pass08f-all-model-nam3km-nam3km-20260716-12z-20260723T083742935Z/summary.json`

### Pass 09 — Bounded Browser-worker Hover Reconstruction

Hypothesis: Pass 07 removed copies but still performed the 112,896,000-sample v3 prefix reconstruction synchronously on the browser main thread. Transferring exclusive ownership to a persistent module worker can remove that long task while returning the same one-owner typed-array graph.

This is a client architecture change and received separate implementation, race/ownership, failure/recovery, benchmark, and root reviews:

- The worker is prewarmed while fetch and browser decompression are in flight. It receives the response `ArrayBuffer` by transfer, runs the exact hardened Pass 07 parser, and transfers every result backing store to the page. Canonical output remains 72 views over one 225,799,044-byte owner; compatible noncanonical layouts may return multiple isolated owners.
- Only one buffer is active in the worker and one page-owned buffer may wait. A third or later owner is consumed immediately by the in-place main parser rather than joining an unbounded FIFO. This bounds internal admission to two raw owners; two production-sized concurrent results account for 451,598,088 bytes.
- Queued aborts never transfer. An active abort rejects the caller but leaves the worker as sole owner until the result is discarded or the timeout fires. Request IDs, worker identity, protocol version, stale responses, `messageerror`, crash, timeout, CSP/constructor failure, and SSR/no-Worker paths all fail closed.
- If a worker dies after transfer, the original owner is irrecoverable. Retaining a 225.8 MB backup would undo Pass 07, so the artifact client circuit-breaks the worker for the session, refetches exactly once (normally from HTTP cache), and decodes on the main thread. A failed recovery stops after two total fetch attempts and throws; it never caches blank weather.
- Both worker results and recovery results must be a positive safe-dimension plain payload with a nonempty safe-key map, finite metadata, exact `Int16Array(rows × cols)` values, and ordinary `ArrayBuffer` backing before cache publication.

Independent review reproduced two pre-freeze defects. Eight simultaneous completed fetches could retain one detached active owner plus seven page-owned queue entries—approximately 1.472 GiB for the real fixture—and the original shallow result gate accepted blank or wrong-view payloads. The admission cap and deep result gate above fixed both. Independent adversarial tests then covered eight-owner pressure, malformed typed views, blank/stale messages, exact one-refetch recovery, cache exclusion, active/queued abort races, and crash circuit breaking; no P0–P3 finding remains.

The final actual Vite/Chromium benchmark used the same real HRRR F003 Brotli artifact as Pass 07. It alternated main/worker in ABBA/BAAB order, excluded one warm-up per arm, and retained 16 samples per arm:

| Browser measurement    | Main parser median | Worker median |  Result |
| ---------------------- | -----------------: | ------------: | ------: |
| Synchronous page work  |           55.30 ms |       0.00 ms |   -100% |
| Maximum event-loop gap |           55.40 ms |       5.10 ms | -90.79% |
| Maximum long task      |              55 ms |          0 ms | removed |
| Decode-ready latency   |           55.30 ms |      56.20 ms |  +1.63% |
| Fetch-to-ready         |          357.50 ms |     358.65 ms | +0.322% |
| p95 event-loop gap     |           56.95 ms |       5.55 ms | -90.25% |

The output oracle remained exact at aggregate sample SHA-256 `591853278cfd9406961af78a9965650545825e0f4b7d8e9ce869b41e0c04d3f4`. A cold worker was ready in 59.20 ms with a 5.70 ms maximum gap and no long task. Two concurrent real owners serialized exactly in 112.70 ms. The deliberately crashed prototype recovered exact output with one refetch and main decode in 643.9 ms; that is a failure ceiling, not normal performance.

The production build emitted a same-origin 5,382-byte module worker at SHA-256 `e1c93ae94e4b6ee9a4dea15a2d83c26d3869b59ee20b688e3d63fe25abde24d0`. Final source-bound evidence is `/private/tmp/pass09-hover-worker-production-evidence.json` (SHA-256 `d40e310865132c55f2468dd6c7e70f1099b65424859c59297c337b42ac770fba`); crash/recovery prototype evidence is `/private/tmp/pass09-hover-worker-browser-evidence.json` (SHA-256 `1ba6d414591f9086d37a476cda8c87857bb9b5a9727495407e4d716162d55bad`).

Validation passed 1,073/1,073 Node tests, typecheck, ESLint, Prettier, 164/164 Playwright tests, production build, the root 34-test focused matrix, the independent 38-test matrix, three adversarial reviewer tests, and `git diff --check`. This pass changes scheduling and ownership only: every sample, backing-store byte, scale, offset, missing sentinel, weather classification, threshold, server artifact, and meteorological value is exact. It is accepted for responsiveness; server renderer cumulative timing remains 19.842%.

### Pass 10 — Exact Hover Predictor Evaluation

Hypothesis: the schema-v3 global horizontal delta leaves spatial redundancy for Brotli. Row-local horizontal resets might also enable cheap cold sampling, while a two-dimensional gradient predictor could reduce stored transfer bytes enough to justify additional reconstruction work.

This was an exact format-design pass over all 28 production-q0 hover containers rather than a production-format mutation. The final idle benchmark ran seven rotated, interleaved samples per arm over 1,666,784,000 samples. It reproduced every existing MVH3 raw and stored byte, then reconstructed all three predictor arms exactly: 5,000,352,000 signed-int16 sample comparisons with no value, missing-state, threshold, classification, or meteorological change. It also passed 262,142 modular-wrap identities, a signed-boundary vector, the native little-endian gate, and three malformed/truncated-container cases.

| Predictor                 | Stored bytes | Change vs current | Encode-to-stored median | Decode-to-absolute median | Cold point median | Cold row median |
| ------------------------- | -----------: | ----------------: | ----------------------: | ------------------------: | ----------------: | --------------: |
| Current global horizontal |  617,968,460 |                 — |             4,089.96 ms |               5,250.33 ms |         822.22 ms |       804.81 ms |
| Row-reset horizontal      |  618,504,811 |           +0.087% |             4,097.42 ms |               5,281.60 ms |           0.65 ms |         2.18 ms |
| Two-dimensional gradient  |  546,874,878 |          -11.504% |             4,274.46 ms |               5,805.58 ms |         175.16 ms |       482.62 ms |

Row resets are rejected as the primary stored format. Their excellent lazy point and row behavior does not offset 536,351 additional stored bytes, slightly slower eager reconstruction, and the cost of changing the producer, browser parser, worker protocol, manifest, and cache contract.

The exact two-dimensional gradient is accepted for a separately gated rollout. It saves 71,093,582 bytes (`11.504%`) across the measured roster and makes Brotli decompression 5.34% faster. Its optimized streaming reconstruction is 1.99× the current predictor cost, so complete decode-to-absolute readiness is 10.44% slower (`5,250.33 -> 5,805.58 ms`). The measured 549.43 ms paired decode penalty versus 71.09 MB saved gives a transfer/CPU break-even near 129.4 MB/s, or 1.04 Gbps; below that throughput the transfer saving dominates. Lazy gradient sampling is not part of the initial rollout because a point can still cost roughly 6 ms per container on the main thread.

The bounded production design is a new MVH4/schema-v4 payload with an explicit top-level `predictor: gradient2d`, dual v3/v4 decoding in the Pass 09 worker, eager off-main reconstruction, per-artifact schema propagation, a producer rollback flag, and the existing fail-closed range/truncation gates. Old magic remains rejected rather than guessed. Implementation acceptance will require exact boundary/golden vectors, legacy-v3 compatibility, worker failure/recovery tests, real-browser timing, and all-model artifact comparison.

The final evidence is `/private/tmp/pass10-hover-predictor-evidence.json` (SHA-256 `decd97548e447d414d84321ea33d2634af0d2e6254bc835077cdd911c0dc4131`), reproduced by `/private/tmp/pass10-hover-predictor-bench.js` (SHA-256 `6fb52ca4ea937d6ae2ca90dd7245bfde230b9810f01733b422268d8c0e9cc217`). No production source was retained in this pass, so verified server-renderer cumulative timing remains 19.842%.

### Pass 11 — Bounded Compression-input Ownership

Hypothesis: the helper pool's safety contract retained or cloned every large codec input. Renderer-created filter-0 scanlines and the fully packed hover body have stronger ownership guarantees than arbitrary callers, so a versioned transport can transfer exact PNG owners and share one immutable hover owner without giving up deterministic fallback behavior.

This is an architectural ownership change. It was implemented and reviewed independently, then root-reviewed. The final design has three explicit modes:

- Generic `submit()` remains isolated by a synchronous snapshot and structured clone, including `SharedArrayBuffer` values and subviews. No public options object can opt caller-owned data into transfer.
- The renderer-private PNG path acquires an exact standalone `ArrayBuffer` only after frame-local and pool-scoped admission, writes filter-0 scanlines directly into it, transfers it to the helper, receives it back, and recycles at most the global admission cap. A helper death after detachment discards the lost owner and rebuilds from the still-immutable RGBA or index source.
- Hover packing writes directly into one exact `SharedArrayBuffer` after admission. The helper reads it without a clone, and the submitting renderer retains that same immutable owner for inline fallback. The dead/null-helper path also creates only that one owner.

The protocol is versioned and validates request/result type, mode, safe numeric job ID, never-reused `BigInt` token, nonempty exact output, returned owner size, and output/input non-aliasing. It contains spawn errors, `messageerror`, post failures before and after detachment, codec errors, stale/duplicate replies, numeric-ID reuse, worker error/exit, pool death, and concurrent frame pressure. Owned inputs never enter the generic waiter queue. Telemetry separately reports owned/shared jobs, bytes, fallbacks, rebuilds, retained recycler bytes, and peak transport bytes.

Review found and fixed fifteen issues before freeze, including dropped profile telemetry, a second transient backing allocation, missing `messageerror` containment, zero-byte result acceptance, public SAB trust bypass, a pre-admission RGBA mutation race, unbounded-looking job-ID allocation, incomplete retained-memory accounting, a contaminated temporary comparison clone, double hover allocation with a dead/null pool, inaccurate deferred-pack timing, double subtraction from `corePngMs`, stale scheduling doubles, a writable evidence snapshot, and a returned output alias that could be corrupted when its owner was recycled. Every partial or mutable evidence run was disqualified. The final sealed 1,216-file snapshot had zero writable files/directories; its 117-file benchmark source scope has SHA-256 `597577cbc44395f9de92c7714edcd09b3c87d719078d075b422a60776d3c5d93`.

The final production HRRR wall-time benchmark used four excluded A/B/B/A warm-up cycles followed by eight retained A/B/B/A cycles (`n=16` per arm), each process using the same warm fixture and frozen source:

| Wall measurement |         Pass 08 baseline |        Pass 11 candidate | Candidate change |
| ---------------- | -----------------------: | -----------------------: | ---------------: |
| Median           |             7,089.469 ms |             7,089.344 ms |         -0.0018% |
| MAD              |                21.116 ms |                 8.629 ms |                — |
| Mean             |             7,098.757 ms |             7,095.176 ms |          -0.050% |
| p10 / p90        | 7,067.821 / 7,147.171 ms | 7,075.963 / 7,117.556 ms |    bands overlap |

Cycle signs were mixed and the dispersion bands overlap, so Pass 11 makes no throughput claim. A contemporaneous candidate-to-campaign-baseline comparison was 18.759% faster, but that cross-run value is contextual and noisier than the already verified Pass 08 cumulative result. The campaign table therefore leaves the official server-renderer cumulative timing at 19.842% until the final aggregate interleave remeasures it.

The resource gate ran the actual production builder under `/usr/bin/time -l`, with one fresh process per sample and one distinct fresh APFS copy-on-write cache clone per arm. After one excluded A/B/B/A warm-up cycle, two retained cycles produced four samples per arm:

| Peak-RSS measurement     |                                             Pass 08 baseline | Pass 11 candidate | Candidate change |
| ------------------------ | -----------------------------------------------------------: | ----------------: | ---------------: |
| Median                   |                                              3,224,133,632 B |   2,761,981,952 B |   -462,151,680 B |
| Median MiB               |                                                    3,074.773 |         2,634.031 |     -440.742 MiB |
| Median percentage        |                                                            — |                 — |         -14.334% |
| Arm MAD                  |                                                  2,924,544 B |      13,541,376 B |                — |
| Strict sample separation | baseline minimum exceeded candidate maximum by 441,565,184 B |                   |                  |

The observed whole-process high-water reduction is not asserted to equal live-byte arithmetic. The deterministic conservative effect is removal of one redundant 225,799,044-byte hover backing at the measured peak, while per-PNG structured clones are also avoided. The remainder was not decomposed and may include serializer, allocator, garbage-collector, scheduling high-water, and PNG-clone effects. Every candidate build reported 287 helper jobs (`283` owned plus `4` shared), 1,549,461,340 owned bytes, 865,563,000 shared bytes, zero clone jobs, zero fallbacks, zero rebuilds, a 12,545,960-byte bounded recycler, and a 238,345,004-byte transport peak.

The candidate was rebuilt and sealed; the baseline was a separate read-only copy-on-write clone of the untouched accepted Pass 08 seed and was first self-verified exact. The two roots then compared at 4/4 normalized manifests (excluding documented volatile `generatedAt` timestamps), 16/16 normalized completion markers (excluding volatile time/profile/transport telemetry), and 1,287/1,287 exact referenced payloads including 28/28 hover containers, spanning 4,179,614,030 canonical bytes and 1,463,910,578 stored bytes per arm. The canonical payload SHA-256 was `5b87eb008e1906ba08078b3d87780847cb782cdf08c3b6448b2354cf92b9f526` in both arms. No referenced payload/container byte, sample, finite/missing state, threshold, classification, pixel, signature, nonvolatile provenance field, or meteorological value changed.

Validation passed the final 1,107-test Node suite, typecheck, ESLint, Prettier, 164/164 Playwright tests, production build, 128/128 focused tests, 31/31 ownership tests, `git diff --check`, and independent source/evidence/statistics review with no remaining P0–P3 finding. Durable evidence is:

- Peak RSS: `/private/tmp/pass11-final-rss-evidence.json` (SHA-256 `c4b7f3511e3720e6190589cf2580ffa99f3f4a40fbd9c70c0b5435fe9ac09dca`).
- Wall time: `/private/tmp/pass11-final-wall-evidence.json` (SHA-256 `f2d324461aab6787d12d1dbf08bdafe796ee0db4c9e673cae895b56debb6cb4e`); its independently recomputed 32-summary index is `42c0e232e59fe752ad1b76eb51ad9e0f30790d8c91bc0de8012cdddfc790fa04`.
- Exact parity: `/private/tmp/pass11-final-parity-evidence.json` (SHA-256 `14234471bbd4d3556cd90960a6e22a8ea8c7da2ceb38fcc67a704d56346acb47`).
- Production RSS runner: `/private/tmp/pass11-production-rss.js` (SHA-256 `146f7866fdb4982723750702dd66eed11b3d80c63b04b654186e20ff0b94977f`).

Pass 11 is accepted for its repeatable peak-memory reduction. Its production source commit is `1a98f869533cad17ee69092d445a1cc3b7d082e3`.

### Pass 12 — Exact MVH4 Rollout with Fused Gradient Prediction

Hypothesis: the exact two-dimensional hover predictor accepted by Pass 10 can reduce transfer storage enough to outweigh its eager browser reconstruction cost, provided the server does not pay a second full JavaScript sweep over every quantized sample.

The rollout introduces an immutable `mvh4` descriptor (`MVH4`, schema 4, `gradient2d`) while retaining a strict `mvh3` rollback (`MVH3`, schema 3, `global1d`). Blank configuration selects MVH4; only those two values are accepted. The renderer signature, manifests, browser parser, worker protocol, cache bindings, merge path, comparator, and benchmark harness now carry the effective schema. Both server and browser parsers require exact magic/schema/predictor identity, positive safe dimensions, canonical contiguous ranges, finite quantization metadata, exact payload length, and safe variable keys. Mixed-schema merges decode to absolute Int16 values and explicitly re-encode the requested target.

The first production candidate was deliberately rejected. It quantized each variable to absolute Int16 values and then ran the exact reverse two-dimensional predictor in JavaScript. A four-warm-up/eight-retained A/B/B/A production benchmark found:

| Rejected unfused measurement | MVH3 baseline | Unfused MVH4 |   Change |
| ---------------------------- | ------------: | -----------: | -------: |
| Wall median                  |  7,096.037 ms | 7,688.909 ms |  +8.355% |
| Hover-stage median           |     733.65 ms |  1,317.75 ms | +79.616% |

The candidate lost all eight paired cycles; hover explained 99.53% of the mean wall increase. That source was not accepted. The exact wire-format and browser evidence from it remained valid because the repair below changes only the server producer and reproduces every accepted MVH4 byte.

The repaired producer adds a bounded optional Stage-D WASM capability. Raw, affine, and wind quantizers now replace their existing `QOUT` scratch with exact modular Int16 gradient residues before JavaScript copies the chunk. A 65,536-byte previous-row arena supports up to 32,768 columns, maintains row state across arbitrary 32,768-sample chunks, and uses eight-lane SIMD with scalar row edges and tails. The JavaScript loader validates ABI version, constant canary, alignment, disjoint ranges, progress, and a split-row semantic canary before exposing the capability. Missing or incompatible capability falls back before mutation to the authoritative absolute-plus-packer path. MVH3 remains byte-frozen.

An internal `predictorEncoded: "gradient2d"` marker prevents the packer from applying the predictor twice. It is never serialized. Independent review found that a prototype-inherited marker could bypass the packer transform even though validation intentionally recognized only own properties. The skip decision now also requires an own marker, and a prototype-pollution regression proves inherited markers are treated as absolute. A second review found that the main/winter activation test inspected source text rather than behavior; it was replaced with real binary-versus-JSON producer calls and a gradient-reset spy. Final independent review reports no P0–P3 finding.

The direct production-shape microbenchmark used 980 × 1,600 cells, 16 variables, 25,088,000 samples per run, two warm-ups, and twelve retained Latin-rotated samples per arm:

| Quantize + raw-pack arm |     Median |
| ----------------------- | ---------: |
| MVH3 fused delta        | 16.9075 ms |
| MVH4 unfused gradient   | 45.6237 ms |
| MVH4 fused gradient     | 19.5945 ms |

Fusion improved the rejected MVH4 hot path by 57.052% and recovered 90.643% of its MVH3-relative regression. The final production wall gate used four excluded warm-up cycles followed by eight retained A/B/B/A cycles (`n=16` per arm):

| Final wall measurement | MVH3 baseline |   Fused MVH4 |               Change |
| ---------------------- | ------------: | -----------: | -------------------: |
| Median                 |  7,116.574 ms | 7,159.347 ms | +42.773 ms / +0.601% |
| MAD                    |     14.708 ms |    18.143 ms |                    — |
| Mean                   |  7,120.023 ms | 7,160.889 ms | +40.866 ms / +0.574% |
| Hover median           |     744.55 ms |    792.80 ms |  +48.25 ms / +6.480% |

The fused candidate remained slower in all eight paired cycles, so no server-speed claim is made. It recovered 92.785% of the rejected wall penalty and 91.739% of the rejected hover penalty, passing the predeclared `≤1.5%` production-wall guardrail.

The actual Chromium benchmark used the real HRRR F003 Brotli artifact, production parser/worker modules, two excluded and six retained A/B/B/A cycles:

| Browser measurement     |       MVH3 |       MVH4 |           Change |
| ----------------------- | ---------: | ---------: | ---------------: |
| Stored bytes            | 41,461,711 | 37,993,758 |          -8.364% |
| Fetch to raw median     |   316.6 ms |   304.9 ms |          -3.696% |
| Worker decode median    |    71.5 ms |   107.2 ms |         +49.930% |
| Adjusted fetch to ready |     388 ms |     412 ms | +24 ms / +6.186% |
| Long tasks              |          0 |          0 |            equal |

The measured transfer/decode break-even is approximately 97.14 MB/s (`777.13 Mbps`). Below that throughput, the byte saving dominates; above it, MVH3 reaches eager readiness sooner. The browser evidence remains source-bound after the server repair: all six production browser module sizes and hashes are unchanged, as are the HRRR MVH4 stored hash `22b3101d…`, raw hash `3ccea4b7…`, and exact semantic hash `cc535d17…`.

Across all 28 production containers, MVH3 stored bytes were 617,968,460 and MVH4 stored bytes were 546,874,878: `-71,093,582` bytes (`-11.504%`). The frozen oracle compared 3,333,568,000 decoded samples across both formats with identical quantization metadata and zero finite/missing, threshold, classification, or scientific-value change. It also proved exact MVH3 rollback bytes, ordinary/shared-buffer parity, malformed-container rejection, and mixed-schema merge behavior.

The final fused source was rendered again into a fresh copy-on-write four-model cache. Comparing it with the accepted unfused MVH4 artifact set produced 4/4 equal normalized manifests, 16/16 equal normalized completion markers, and 1,287/1,287 exact stored and canonical payloads, including all 28 hover containers. Each arm contained 1,392,816,996 stored bytes and 4,179,614,708 canonical bytes; aggregate canonical SHA-256 was exact at `a76833698b3707cbe65c46805e52049427caae883191fb08e3b3383d6b4e277e`. The final cache and source snapshot have zero writable files or directories.

Validation passed 1,166/1,166 Node tests, the final 11/11 fused-gradient matrix, 97/97 hover tests, 500/500 independent arbitrary-split predictor cases, typecheck, ESLint, Prettier, production build, deterministic three-way WASM rebuild, browser smoke, and `git diff --check`. The final WASM SHA-256 is `a9837c69f74d3823744c7279d927896a875468c73975f3e023139a4abac71429`. The sealed production source is `/private/tmp/renderer-pass12-fused.Z1fPLw/candidate-src-final-v2`; its mode-sensitive 118-file fingerprint is `518bb8baf8f88150f722df90dd6570675571eefcf79760115ae0cb6c841e63e9`.

Durable evidence:

- Exact production-format oracle: `/private/tmp/pass12-production-format-evidence.json` (SHA-256 `55aec8c71f469105c068d896e1bd6115a788e8746acbe92ac2ab9cf3321daf1c`).
- Independent parser/merge oracle: `/private/tmp/pass12-independent-hover-evidence.json` (SHA-256 `373d09d61ba7668c745bb996e4bd750741ce66046265573d7beee98625886748`).
- Rejected unfused wall benchmark: `/private/tmp/pass12-final-wall-evidence.json` (SHA-256 `09bc176a866f332f8ffa270e2ceede7d69a59e99a5266a6c8ce142f249cd1625`).
- Actual browser benchmark: `/private/tmp/pass12-browser-benchmark-evidence-browser-scoped.json` (SHA-256 `5dda1528bbd3e2e00e2d37422a37476822a0d04808c3b83f2860fbce4b7f4de4`); independent audit SHA-256 `ec60dbda339c1cd31de9b1000e227551944f766f205e5508a05b0ebc9443c9eb`.
- Fused exactness and hot-path recovery: `/private/tmp/pass12-fused-gradient-evidence.json` (SHA-256 `a00ba81597a6b4dc4180b80d078e980474a80a3bddf08b6e7c4a4a79a04b7eed`).
- Final fused wall benchmark: `/private/tmp/pass12-fused-final-wall-evidence.json` (SHA-256 `f48daaa4670fa3822c9764bb669c506eaa1dc74c6c278c1f632516ae69c40cfd`).

Pass 12 is accepted as an exact transfer/resource optimization with a bounded `0.601%` measured server cost. Its production source commit is `5dc9acf6177afb1a65b80c40fda37026a6965ce3`. Its current non-interleaved candidate-to-campaign-baseline context is `17.957%` faster; the official aggregate value will be replaced by the final baseline-versus-final interleave.

### Pass 13 — Direct-final MVH4 Hover Arena

Hypothesis: Pass 12 fused the exact MVH4 predictor into quantization, but the server still allocated one full `Int16Array` per retained variable and then copied all planes into a second full shared container. A renderer-private growable `SharedArrayBuffer` can reserve the canonical header, quantize each admitted variable directly into its final body slot, serialize the same final header, and submit only the exact bounded wire view. This was queue item 15; it was pulled ahead of the two cache-format experiments because the accepted MVH4 rollout made the redundant 430.7 MiB F003 ownership shape both immediate and higher-yield.

This is an architectural ownership and protocol change. The final implementation:

- engages only for the canonical binary MVH4 producer, exact plan/artifact dimensions, supported direct transforms, the trusted shared compressor, and a proven growable-SAB runtime; MVH3, JSON, winter/supplemental, arbitrary compressors, noncanonical plans, and unsupported runtimes remain on the exact eager path;
- allocates and quantizes only inside frame-local and global encode admission. Queued coordinators retain neither start closures nor meteorological source plans after admission or cancellation;
- uses one immutable canonical plan and the common header serializer for roster order, escaped keys, offsets, omissions, and final publication. At most one uncommitted speculative plane exists, discarded slots are reused without compaction, and post-allocation failures abort rather than creating a second legacy representation;
- extends the compression protocol to carry a shared owner plus exact `byteOffset`/`byteLength`. The worker and inline fallback validate and compress only that bounded range, echo the range in success/error responses, and reject malformed, stale, overflowing, or whole-backing responses;
- exposes `MODELVIEW_NOAA_HOVER_ARENA=auto|off` as a signature-neutral rollout/benchmark control and reports direct owners, view/backing/max bytes, header reserve, speculative tail, copy bytes, and fallback reason.

Independent architecture and final-diff reviews found and fixed retained promise/source closures, delayed rollback allocation on the off path, incomplete descriptor validation, arena reopen/reorder states, weak commit metadata binding, valid-count/wrong-target conflation, unsupported GSAB fallback, plan/artifact dimension disagreement, benchmark treatment leakage, and several evidence-runner provenance/accounting issues. The final source audit passed 102/102 focused cases with no remaining P0–P3 finding; the reviewed manifest SHA-256 is `b621583d0032dae234ef4a73d9a6e56608d5d360bc5543775f4454c225e8fe66`.

The causal production wall campaign compared the same frozen Pass 13 source with the arena forced off and auto. A contextual campaign separately interleaved the frozen Pass 12 source and Pass 13 auto. Each used four excluded warm-up cycles followed by eight retained cycles, alternating A/B/B/A and B/A/A/B (`n=16` per arm):

| Production wall measurement | Baseline median | Candidate median | Median change | Mean change | p90 change |
| --------------------------- | --------------: | ---------------: | ------------: | ----------: | ---------: |
| Causal: Pass 13 off → auto  |    7,111.002 ms |     6,887.695 ms |       -3.140% |     -3.329% |    -3.343% |
| Context: Pass 12 → Pass 13  |    7,106.999 ms |     6,870.169 ms |       -3.332% |     -3.282% |    -3.196% |

The causal hover stage fell from `768.35` to `549.35 ms` (`-28.503%` median, `-28.375%` mean, `-28.050%` p90). Artifact time improved `4.373%`; catalog PNG and compression wait were neutral. All 96 wall processes succeeded, every required cache counter and sanitized work signature matched, and every auto main frame reported one arena owner, zero arena copy bytes, one bounded transport owner, and no fallback.

The adversarial plan declared unique backing-owner accounting primary and RSS secondary. Its original F003 table assumed the final arena would have no committed omitted-plane tail:

| F003 deterministic owner accounting | Legacy owners |  Direct owner |                                    Saved |
| ----------------------------------- | ------------: | ------------: | ---------------------------------------: |
| Predeclared ideal                   | 451,591,068 B | 225,799,168 B |            225,791,900 B (`215.332 MiB`) |
| Actual production telemetry         | 451,591,068 B | 228,935,168 B | 222,655,900 B (`212.341 MiB`, `49.305%`) |

The actual bounded wire view is `225,799,068 B`, but the growable owner is `228,935,168 B`: one of 73 candidates is omitted only after materialization, leaving one allowed `3,136,000 B` speculative tail plane behind the 72 retained variables. That is a real bounded inefficiency and is not hidden or reclassified. Eliminating it could recover at most `2.991 MiB`, far below the whole-process RSS gate deficit.

The separate direct-builder `/usr/bin/time -l` campaign used the same four-excluded/eight-retained ABBA/BAAB design (`n=16` per arm):

| Memory measurement                 |       Arena off |      Arena auto |                                  Saving |
| ---------------------------------- | --------------: | --------------: | --------------------------------------: |
| Median peak RSS                    | 2,765,193,216 B | 2,641,485,824 B | 123,707,392 B (`117.977 MiB`, `4.474%`) |
| Median peak memory footprint       | 2,747,809,064 B | 2,626,600,076 B | 121,208,988 B (`115.594 MiB`, `4.411%`) |
| Paired-cycle median RSS saving     |               — |               — |                           127,905,792 B |
| Predeclared RSS corroboration gate |               — |               — |                           158,054,330 B |

The RSS effect is causal and repeatable: auto was lower in all 8/8 paired cycles, its highest sample was `76,775,424 B` below the lowest off sample, and peak-memory-footprint independently agreed. The fixed `158,054,330 B` corroboration target nevertheless **failed by `34,346,938 B`**; none of the eight paired cycles met it. The target is not lowered, recalculated, or reported as passing.

Three independent post-measurement reviewers reproduced that conclusion and found no arena, source-plan, coordinator, pool, or worker leak. The `--expose-gc` lifetime probe proves the source plan is dead while the codec remains pending and after settlement; transport returns to the same bounded floor. The production renderer creates hover early, then continues raster, catalog, synoptic, owned-compression, and persistence work while unrelated multi-gigabyte owners remain live. Removing the local hover peak therefore moves the whole-process `max()` to a later, noisier phase instead of exposing the full instantaneous `222.7 MB` owner delta. Off RSS had only `0.94 MB` MAD while auto had `12.29 MB` MAD, and a local production-shaped allocation probe exposed approximately the full owner saving, supporting that phase-switch explanation.

Pass 13 is accepted under the plan's previously declared hierarchy because deterministic owner identity, lifetime, transport, exactness, and all wall gates passed, and the production wall improvement is large and repeatable. Its disposition is explicitly **accepted with failed RSS corroboration**. A future phase-timeline/lifetime refactor may target the later global high-water, but this pass is not altered with an unrelated change to chase the failed threshold.

Four-model validation rendered both arena modes from two fresh APFS clones whose complete pre-render `88,622,146,368 B` content fingerprints exactly matched the sealed Pass 12 seed. Candidate off versus auto and Pass 12 versus auto each produced 4/4 equal normalized manifests, 16/16 equal completion markers, 1,287/1,287 exact referenced payloads, and 28/28 exact stored hover containers. The canonical payload SHA-256 remained `a76833698b3707cbe65c46805e52049427caae883191fb08e3b3383d6b4e277e`. An independent inventory also matched all 1,348 physical payload files and `1,393,201,591` stored bytes at SHA-256 `52300b411b4e31e94e8951757df7267f93742abcc79ca3b1d6aaff42d7b0fcba`. Finally, the production strict decoder framed 28 containers, 1,063 variables, and all `1,666,784,000` absolute `Int16` samples; all three arms matched SHA-256 `49bdcb671aaf2ef27682cf41bb77410fa79336c5bb8db72e394c135d30e6b116`.

The parity runner used a hash-bound offline adapter for the builder's mandatory parameter-index probes; it served only exact `.idx` files from the sealed seed and denied any unexpected network fetch. Two preliminary validation attempts were excluded: the ordinary harness exposed that network probe before rendering, and the first adapter invocation loaded rather than executed the builder and produced zero frames. A separate decoded-comparator diagnostic was also inapplicable because that mode deliberately requires a renderer-signature transition, while this exact pass is signature-neutral. None was treated as a correctness or performance sample; the final run started from new clones and used exact-container comparison plus the independent strict decoder.

Validation passed 1,198/1,198 Node tests, typecheck, ESLint, Prettier, 164/164 Playwright tests, production build, three exact WASM rebuilds, 123/123 focused current-runtime cases, and 102/102 cases on exact Node 20.19.0. The final WASM SHA-256 remains `a9837c69f74d3823744c7279d927896a875468c73975f3e023139a4abac71429`. The sealed 119-file source fingerprint is `8f27c702cfb72da0dc0e5c0e895803aaff333240b55384e09deec0f425d5634c`; production source commit is `890872b04e696cf58bc0590881b78f63b726ea9b`.

Durable evidence:

- Source/provenance: `/private/tmp/renderer-pass13.9nr4rm/candidate-provenance.json` (SHA-256 `100e75014581201aa38a05d2dd759dcd4655cb588678338414a8cec258ae06b5`).
- Wall benchmark: `/private/tmp/pass13-arena-wall-evidence.json` (SHA-256 `78f7b6d6849b091c5bb9ff7334f1dd64ebbf020aa137965c7f42e84a9a450f6a`); runner SHA-256 `011928a42ab479ec853123d8da0122bc49c1466635819f2d24972f38fab7a05e`.
- Peak RSS: `/private/tmp/pass13-arena-rss-evidence.json` (SHA-256 `8f4a1ed2745860b6d7959266938dc06c1507cad4659f448a65b76f8a5f3a3164`); runner SHA-256 `ec9544e8d69493d22bcbec4cb51fb7b8feec75fcfa25e034b52783f629caed39`.
- Four-model exact parity: `/private/tmp/pass13-four-model-parity-evidence.json` (SHA-256 `294dd57d40d24888f1d2969459c63ba83310af519f241fcf733589176f83ffb6`); runner SHA-256 `1692fec8edf84487c79f41bf0e9d427412cae3a77021fe196594f1cfe1f2449a`.
- Adversarial acceptance plan: `/private/tmp/pass13-arena-adversarial-audit-plan.md` (SHA-256 `69bd729020c85ca9f7c018e203aef5dd3d1db38325d91e2b7dbf1532c844109e`).
- Exact Node 20.19 evidence: `/private/tmp/pass13-node20-floor-evidence.json` (SHA-256 `599f51b8f975c41bb86fe77912c12b090773171659b57a797d4efd772830ed87`).

The current contextual candidate-to-campaign-baseline value is `21.271%` faster. It is not a fresh baseline/final interleave and will be replaced by the campaign's final aggregate measurement.

### Pass 14 — Transactional Warm-pack Hash Bypass

Hypothesis: on a warm exact-pack hit, the selected GRIB body was read and SHA-256 hashed before the renderer could trust the already validated Mercator pack that is the actual science input. The selected-GRIB cache descriptor plus stable body and ready-sidecar filesystem identities and the pack's exact metadata can authorize a provisional strict decode first, avoiding one approximately 9.8–218.8 MB body hash per frame across the four-model roster (approximately 106 MB in the causal HRRR fixture) while retaining authoritative verification and repair for every failure path.

The production path is a two-attempt transaction. `MODELVIEW_NOAA_FAST_PACK=auto|off` is signature-neutral and defaults to `auto`. The auto attempt captures the selected-GRIB cache descriptor plus stable body and ready-sidecar filesystem identities, structurally probes the exact Mercator pack without seeding an authoritative selected-body cache, and issues an opaque token bound to the GRIB path, tool identity, mapping, dimensions, regrid arguments, payload identity, and exact pack/metadata generations. Required-pack decode checks pre-open, open-file-descriptor, and post-read identities plus CRC for each consumed field. Only complete strict success commits provenance and promotes decoded grids.

Any missing field, CRC failure, generation change, identity race, decode error, or token mismatch disposes every provisional strong map and speculative derived grid before retrying the normal path. That retry materializes and verifies the selected body, rebuilds or rereads the pack as required, and never reuses the rejected transaction. Required-path corruption is blacklisted without deleting the shared file. `off` preserves the former authoritative order. Profile telemetry separately reports probes, metadata hits, bypasses and bytes, fallbacks, verification hashes and bytes, and probe time.

Independent implementation and source-diff review found and fixed a forgeable current-generation token, retention of a rejected provisional promise during cold retry, speculative derived-grid retention across rollback, the absence of a renderer-level state-machine test, and missing rollback documentation. Subsequent integration and whole-diff audits found no P0–P2 defect. Two bounded P3 observations remain documented: the aggregate fallback counter does not distinguish every reason, although CRC failures remain separately attributable; and the pre-existing ordinary corrupt-cache stat/unlink sequence may race with a republisher, while this new required path explicitly does not remove shared files and protects correctness through blacklist plus fallback.

The causal wall campaign compared the same frozen Pass 14 source with fast pack forced `off` and `auto`. A contextual campaign separately compared frozen Pass 13 with Pass 14 auto. Each campaign used four excluded warm-up cycles and eight retained ABBA/BAAB cycles, one fresh process per observation and `n=16` per arm. All four arms used distinct writable APFS copy-on-write clones whose complete pre-timing byte fingerprints matched the untouched sealed seed:

| Production wall measurement     | Baseline median | Candidate median | Median change | Mean change | p90 change | Paired median |
| ------------------------------- | --------------: | ---------------: | ------------: | ----------: | ---------: | ------------: |
| Causal: Pass 14 off → auto      |    6,689.957 ms |     6,460.420 ms |       -3.431% |     -3.472% |    -3.433% |       -3.474% |
| Context: Pass 13 → Pass 14      |    6,708.581 ms |     6,474.183 ms |       -3.494% |     -3.509% |    -3.557% |       -3.530% |
| Causal materialize → pack probe |      243.500 ms |        23.500 ms |      -90.349% |    -90.332% |   -90.325% |             — |

All 8/8 causal and 8/8 contextual paired cycles favored the candidate. The exact causal differential was one selected-GRIB verification hash in `off` and zero in `auto` for every frame: F000 `105,874,115 B`, F001 `106,332,959 B`, F002 `105,908,609 B`, and F003 `106,580,024 B`, totaling `424,695,707 B`. All 96 processes succeeded, all 384 main-frame raw-cache ratios were hits, every regrid-pack ratio was `1/1`, all 3,648 emitted cache ratios were hits, all 192 raw logs matched their sealed hashes, and there were no fallbacks, retries, corruption events, or unexpected network requests.

The four-model exact gate rendered GFS, NAM, NAM 3 km, and HRRR in off and auto modes. Candidate off versus auto and the Pass 13 seed versus candidate auto each matched 4/4 normalized manifests, 16/16 completion markers, 1,287/1,287 referenced payloads, and 28/28 hover containers with no stored-container change. All six seed/off/auto/fault inventories contained exactly 1,348 physical payload files and `1,393,201,591 B` at SHA-256 `52300b411b4e31e94e8951757df7267f93742abcc79ca3b1d6aaff42d7b0fcba`. The strict production decoder matched 28 containers, 1,063 variables, `1,666,784,000` Int16 samples, `546,874,878` stored bytes, and `3,333,672,590` raw bytes at SHA-256 `49bdcb671aaf2ef27682cf41bb77410fa79336c5bb8db72e394c135d30e6b116`.

Three fresh disposable-clone fault gates exercised the complete transaction:

| Fault                                                               | Required result                                                                             | Observed result                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Late consumed pack-entry CRC mutation                               | Reject provisional pack, hash selected body once, rebuild exact pack, publish exact science | One corruption, one `106,580,024 B` verification, zero pack hits / one miss, exact rebuilt cache and artifacts                                                                                                                                                             |
| Same-size selected-body mutation with valid exact pack              | Treat the exact pack as authoritative science input and bypass the irrelevant body          | Mutated body and inode remained stable, pack/sidecars remained exact, zero verification hashes, exact artifacts                                                                                                                                                            |
| Same-size selected body plus invalid pack under worker fetch denial | Fail closed before F003 science publication                                                 | Exactly one worker F003 range GET received a non-retryable 403; process exited normally with one F003 error, F000–F002 remained complete, F003 artifacts and completion marker were unchanged, manifest recorded F003 error, and no completed F003 science profile existed |

The fail-closed receipt was bound to worker PID/thread, method, URL, exact range `bytes=41945699-42655144`, status 403, and SHA-256 `be80ffc76d1fdd234b84e1b0cf0cf96b609fb7e0b86e8c19d70bf01d17cda5d7`. Review iterations fixed false acceptance of unrelated early failure, incomplete sealing of publication sidecars/control-plane files, one mistyped oracle hash, incorrect attribution of worker fetches to the main wrapper, retryable denial semantics, an imprecise byte range, an out-of-band environment name, and the need to require normal child-process completion. A final independent read-only audit replayed 234 evidence checks plus the six-root physical and three-root decoded inventories and found no P0–P3 evidence defect. The append-only receipt is protected by a private absent root, preflight, exact-one parsing, and complete end seals but is not opened with `O_EXCL`; APFS shared extents are inferred from the clone method rather than cryptographically attested. Neither affects the exact correctness result or timed inference.

Two wall preflights were excluded with zero observations and untouched caches: the first runner encountered sandbox-denied `os.uptime`; the second rejected an obsolete pre-render seed digest before timing, after which an independent complete rehash established the correct post-Pass-13 seed SHA-256 `16fb4474ecca9a579d89e568a3f890678782db546aaea7cc318c1200a6ed5adf`. Two parity/fault attempts were also excluded and preserved: v1 stopped before mutation on a 63-character mistyped ready-sidecar hash; v2 passed parity, CRC repair, and opaque-body behavior but its runner looked for a frame-worker fetch in the main-thread receipt. No excluded root or observation was reused.

Validation passed 1,205/1,205 Node tests, typecheck, ESLint, Prettier, 164/164 Playwright tests, production build, 44/44 focused tests on both the current runtime and exact Node 20.19.0, renderer-level transactional tests, and process-isolated candidate/token tests. The sealed 119-file candidate source fingerprint is `8a53591c5a44d39470705f2aa2f3762a602ab039efcf5e7edfd52e4b58d5dc90`; production source commit is `3299df954b4f848291ffdd8c570f5f923448ffc6`.

Durable evidence:

- Wall benchmark: `/private/tmp/pass14-fast-pack-wall-evidence.json` (SHA-256 `7b0cd8f771a370fb0025619950fad2062472e538ac9dae1579f1878fb63a49b5`); runner SHA-256 `f61a8a10f5afa73af6bb66f7ec17ba2b08c2e86b7112520d73578ed084c96a28`; 96-line progress SHA-256 `35def27da1ca0297cb02a1de9b773c07f2ffcb99793c9fc9e29d53ed19680643`.
- Four-model parity and faults: `/private/tmp/pass14-four-model-parity-fault-evidence-v3.json` (SHA-256 `c9b4e92c6fff97a6a2965530f7b25a2279927874055579aa5a44b1d34b1ea061`); runner SHA-256 `c9b36c03aab4d19e85bbe28a582b381112744c72b4436e0c9caece71118e29f1`; worker deny preload SHA-256 `bb1bd0c3d4731f117b8e051e6d99be05719ffbd6c6b6e9fef1e251d22b032993`.
- Frozen source: `/private/tmp/renderer-pass14.8vu9ZV/candidate-src-3299df9`; final parity/fault root: `/private/tmp/renderer-pass14-parity-v3.lJnjqb`.

Pass 14 is accepted as an exact warm-cache I/O and hashing optimization. It changes neither renderer signatures nor any artifact, sample, finite/missing state, threshold, classification, pixel, or meteorological value; no relaxed tolerance was used. Its current non-interleaved candidate-to-campaign-baseline context is `25.809%` faster and will be replaced by the final campaign interleave.

### Pass 15 — Precompiled Static Catalog Color Lookups

Hypothesis: every fresh builder and frame-worker process reconstructed the same large continuous-color lookup roster from immutable recipes. The interpolation was exact and deterministic, but repeating it in every process consumed approximately 180 ms of startup time in the production fixture. Compiling the static roster once into a content-addressed binary can remove that work while leaving dynamic and custom recipes on the existing compiler.

The implementation introduces one shared recipe catalog, compiler, generator, and fail-closed asset loader. The generated asset contains 38 unique palettes covering 73 assignments: `868,352 B` of unique binary palette data replacing `2,670,592` logical color bytes. The binary SHA-256 is `d29d3860eca1f55039638d5e49d30d795618974890d4d0866b3dc3297833fd07`; the manifest SHA-256 is `b4260cacd32f292f0f9d2ed7dc46542d9575c27cd9fe09ffe0f072664510fe4b`; the assignment mapping SHA-256 is `f61591e37552df5ffe3e94cad5951ef544e8ac5658def8e892bfb31683387422`; and the compiler closure SHA-256 is `9ad53c9938c168d26e2c79b44e4a558353c88ba9bdc3bd7264714f0f8db6ea22`.

`MODELVIEW_NOAA_COLOR_LOOKUPS=auto` is the production default: it validates all manifest, compiler, recipe-input, assignment, offset, length, checksum, and binary identities before exposing the complete roster, and warns before a complete dynamic fallback if validation fails. `precompiled` is the strict benchmark and deployment-verification mode and fails closed instead of falling back. `dynamic` is the explicit rollback. Static catalog recipes use the asset; public runtime and custom lookup builders retain the exact compiler path. Builder and worker startup receipts are framed on a private descriptor and bind PID, role, requested/effective mode, mode-appropriate loader identities, timings, and fallback state.

The official causal wall campaign compared the same sealed Pass 15 source with `dynamic` and strict `precompiled` modes. It used four excluded warm-up cycles and eight retained ABBA/BAAB cycles, a fresh Node process for every observation, `n=16` per arm, distinct private same-device cache clones, exact pre/post cache fingerprints, an offline hash-bound index fixture, and exact non-timing work counters. Every predeclared gate passed:

| Causal measurement                  | Dynamic baseline | Precompiled candidate |     Improvement |
| ----------------------------------- | ---------------: | --------------------: | --------------: |
| Wall median                         |     6,497.770 ms |          6,317.949 ms |          2.767% |
| Wall mean                           |     6,498.829 ms |          6,317.826 ms |          2.785% |
| Wall p90                            |     6,513.828 ms |          6,334.085 ms |          2.759% |
| Receipt-bound lookup initialization |       190.316 ms |              9.181 ms |         95.176% |
| `catalogPng` guardrail median       |     1,042.650 ms |          1,040.150 ms | 2.500 ms faster |

The eight paired-cycle improvements were `2.858%`, `2.667%`, `2.465%`, `3.154%`, `2.683%`, `3.081%`, `2.854%`, and `2.517%`; the paired median was `2.768%` and all 8/8 cycles favored precompiled loading. The observed wall saving of `179.821 ms` aligns with the receipt-bound `181.135 ms` initialization saving. The `catalogPng` result is only a pooled-noise guardrail and is not attributed causally.

A separate fresh-isolate benchmark exercised both exact Node 22.23.1 and the Node 20.19.0 runtime floor. Node 22 initialization moved from `93.999 -> 4.499 ms` (`-95.214%`), and Node 20 moved from `93.543 -> 4.396 ms` (`-95.301%`). This projection is corroborative rather than the official role-matched gate. Across 124 retained samples, dynamic runs bound the recipe-input identity; precompiled runs additionally bound the assignment mapping and binary identities, and separate exact-output oracles established equivalence.

The Pass 14-versus-Pass 15 contextual campaign is descriptive only and is not an acceptance or cumulative inference. Host load rose from approximately `1.70` at benchmark start to `5.69` at finish; the contextual arm medians were `6,803.317 -> 6,529.697 ms`, but MAD expanded to `324.504/224.075 ms`, and the final paired cycle regressed `3.474%`. Its pooled `4.022%` apparent improvement and the resulting `25.172%` campaign-baseline context are therefore reported only for traceability. The final campaign interleave will replace them.

The fresh four-model exact gate rendered GFS, NAM, NAM 3 km, and HRRR in dynamic and strict precompiled modes and also compared the precompiled result with the accepted Pass 14 oracle. Both comparisons matched 4/4 normalized manifests, 16/16 completion markers, 1,287/1,287 referenced payloads, and 28/28 stored hover containers over `4,179,614,708` canonical bytes. The canonical payload SHA-256 remained `a76833698b3707cbe65c46805e52049427caae883191fb08e3b3383d6b4e277e`.

Independent physical-payload inventories matched all three roots at 1,348 files, `1,393,201,591 B`, and SHA-256 `52300b411b4e31e94e8951757df7267f93742abcc79ca3b1d6aaff42d7b0fcba`; volatile completion markers and manifests were validated separately. Strict hover decoding matched 28 containers, 1,063 variables, and `1,666,784,000` Int16 samples at SHA-256 `49bdcb671aaf2ef27682cf41bb77410fa79336c5bb8db72e394c135d30e6b116`. Eight render runs emitted the expected 16 builder/worker receipts with correct modes, roles, PIDs, mode-appropriate loader identities, and zero fallback. The change is byte-exact; it moves no finite/missing state, threshold, classification, pixel, hover sample, or meteorological value, so no relaxed scientific tolerance was used.

The first parity attempt was excluded after both artifact comparators had passed: its post-render oracle incorrectly required equal byte lengths for completion markers whose allowed `renderedAt` and `renderProfile` fields legitimately differ. Review replaced that generic size oracle with an exact 16-path volatile-marker allowlist while retaining strict pre-render equality and strict post-render equality for every nonvolatile file. The accepted second attempt sealed 5,354 corresponding regular cache paths across the oracle, dynamic, and precompiled roots, required same-device distinct inodes with link count one, and found exactly the 16 allowed marker-size differences and zero unexpected differences. The rejected runner and its two exact comparator reports remain compactly archived; no rejected cache or observation was reused.

Validation passed 1,266/1,266 Node tests, 164/164 browser tests, typecheck, production build, formatting, ESLint with zero errors, 87/87 focused tests, 256 renderer tests on Node 22, and 79 asset/harness tests on exact Node 20.19.0. Deterministic generation rebuilt the asset exactly. Independent benchmark, parity-evidence, and science audits found no P0–P2 issue; the final evidence audit found no P0–P3 issue. The science review recorded two P3 archival notes: the failed attempt's deleted 5,354-file forensic roster is represented by retained compact reports rather than the full failed cache, and identical pre-existing GFS ambiguous-selector warnings occurred in both arms.

The sealed 126-file source fingerprint is `76c361d1cf04438d237a75f55fc2ffd6cf9348e2b592452f6fa7407a465a20e9` over `102,414,981 B`; production source commit is `6e4d05984c54160c9ac1f43c11b2cf8f8be4678f`.

Durable evidence:

- Fresh-isolate initialization: `/private/tmp/pass15-color-lookup-init-evidence.json` (SHA-256 `114b7d1775db1fca459bf81d6a739ea61ae69c21b585be3286730bfb82ba1ae3`).
- Causal and contextual wall benchmark: `/private/tmp/pass15-color-lookup-wall-evidence-v1.json` (SHA-256 `547ff2a6f4e485813d2b76e42247aba2cc9c3ef6d5f9bee1407fafb6f86f2001`); runner SHA-256 `d568d8c031c8b0265e4369da8cb01e898d87aeba8d61397b4e5cb38332ebae10`; 96-line progress SHA-256 `7db336118d97631d6f4485567664f0c343ad3372ef82b70e465f0db15491f920`; sealed 288-file raw-log tree SHA-256 `6daa181f21ebed78e2b031f249b44d13ba9057d761e899c951d6782bf9354b5d`.
- Four-model exact parity: `/private/tmp/renderer-pass15-parity-final.v1/pass15-four-model-color-parity-evidence-v1.json` (SHA-256 `28eae35bd225a59569be0af21dba7471dbe24daa490351fde6e62d07897ebb50`); runner SHA-256 `aa5d69e4acf22de86a609941cd4e6a191ba2b442abe59eea84016faafdf88778`; sealed 28-file log-tree SHA-256 `68185291607e3907c7b1b607d0b06c092ca2f485769ecf656ef7d4eaf8794193`.

Pass 15 is accepted as an exact process-start optimization. Its official causal result is `2.767%`; its current `25.172%` campaign-baseline number is explicitly load-contaminated context, not a fresh cumulative claim, and will be replaced by the final aggregate interleave.

### Pass 16 — Content-addressed Snow-RF Typed Asset

Hypothesis: every process that renders a snowfall product parses and strictly validates the 26 MB Snow-RF CONUS random-forest JSON (`tools/noaa-beta/snow-rf/conus-rf.json`, 100 trees, 666,406 nodes) from scratch. Compiling that model once into a content-addressed, aligned Int32/Float64 binary asset — the Pass 15 catalog-color-lookup pattern — removes identical parse/validate work from the builder main process and every frame worker while preserving bit-exact predictions, an exact JSON fallback, and a fail-closed `required` mode.

Implementation and review:

- `scripts/lib/noaa-beta/snow-rf-compiler.js` owns the strict compile (feature roster, per-tree Int32 `feature`/`childrenLeft`/`childrenRight` and Float64 `threshold`/`value` arrays, structural and cross-reference validation) and now owns `predictRandomForest`/`predictRfTree`, moved from the selection/SLR modules so both load paths share one prediction implementation. A deliberate hardening rides along: the JSON path uses the same strict compile, so custom `MODELVIEW_SNOW_RF_CONUS_PATH` artifacts that only loaded through the old lenient normalization (extra keys, nested wrappers, coercible strings) now fail closed with one warning. `scripts/export-snow-rf-model.js` emits exactly the strict shape; the bundled model is unaffected.
- `scripts/generate-noaa-snow-rf-asset.js` (`npm run noaa:snow-rf:generate|check`) publishes `scripts/lib/noaa-beta/generated/snow-rf-conus-v1.bin` (18,660,568 bytes, 500 aligned regions) plus a manifest binding the frozen source identity (SHA-256 `b3bc9395…`), compiler closure, layout, and binary SHA-256 (`b60056d4…`) under an exclusive publication lock; `--check` re-derives everything and fails on any drift. CI now verifies this asset and the Pass 15 color-lookup asset on every push.
- `scripts/lib/noaa-beta/selection.js` `loadSnowRfState`: `MODELVIEW_NOAA_SNOW_RF_ASSET` = `auto` (typed asset with exact JSON fallback; default) | `off` (JSON) | `required` (typed or fail closed). The loader captures the source twice with an identity gate against mid-load replacement, validates manifest-then-binary hashes against frozen oracles, re-derives the region layout rather than trusting the manifest, materializes 500 typed views over one owner buffer, and publishes one frozen state with a nanosecond phase timeline and memory snapshots. Configuration latches once per process; failures are path-cached and warn once.
- The sealed B-mode memory ceilings forced a real fix during this pass: both source captures stream through one bounded 8 MiB scratch whenever the typed asset is attempted (no transient 26 MB whole-file buffer), and the auto fallback re-reads the source under an identity gate inside `jsonParseNs`, refusing to model replaced bytes. Peak B-mode `arrayBuffers`/`rss` deltas fell from ~67/79 MiB (ceiling violations) to well inside the sealed 56/72 MiB limits.
- Observability follows Pass 15: in receipt mode the builder main and every frame worker run the Snow-RF benchmark role (`scripts/lib/noaa-beta/snow-rf-role-receipt.js`), which loads the production state, proves the one-owner/500-region typed ownership contract, rebuilds the canonical 18.66 MB binary from the in-memory model, and commits 500 per-region SHA-256s plus the whole-binary SHA-256 — so every observed run, in both modes, proves its live model is byte-equivalent to the frozen asset. `FrameWorkerPool` gained exact multi-receipt startup support (unknown, duplicate, and job-response-masquerading receipts kill the worker); the harness gained a pinned `--snow-rf` treatment, receipt-sideband partitioning, and a strict Snow-RF treatment validator. Receipt mode deliberately fails fast on fallback states, so benchmark runs cannot silently measure the wrong path.
- The sealed contract (`scripts/lib/noaa-beta/snow-rf-benchmark-contract.js`) freezes both schedules, nearest-rank BigInt statistics, exact one-sided binomial sign tails (ties count against the candidate), absolute B-mode latency ceilings, and B-mode memory-delta ceilings. Drivers: `scripts/benchmark-snow-rf-receipts.js` (272 runs across Node 20.20.2 and 22.23.1) and `scripts/benchmark-snow-rf-full-gate.js` (72 sealed-harness runs; it now also records a structural clone-preflight manifest — added after the method review noted the sign test is powerless against arm-constant cache bias; the executed gate relied on the documented mitigations: both clones cloned from the same immutable seed, symmetric 4A/4B warmups absorbing the one-time migrations, one shared source root, and per-run harness fixture/treatment validation).
- Three independent reviews ran on the final tree. Implementation: no P0–P2; six P3 notes, of which two were fixed (the receipt child now write-fully-loops its fd-3 frame; the LE-vs-BE framing difference against the builder sideband is documented at the write site) and four are recorded deliberate designs — required-mode failures are never negative-cached (fail-closed correctness over retry cost, sealed by the loader tests), explicit-option cache keys fold unnormalized `requestedMode`/`configurationOrigin` (test/tool surface only), unknown `MODELVIEW_NOAA_SNOW_RF_ASSET` values warn once and select the exact-but-slower JSON path (the safe direction for this toggle, unlike `MODELVIEW_NOAA_FAST_PACK`, whose unknown values now throw because its risky path must never win a typo), and directly symlinked generated assets fail the anti-swap lstat/fstat identity gate (auto degrades to JSON with one warning; `required` fails loudly). Science/output: exactness verified independently (details under Exactness). Benchmark-method: statistics re-derived and confirmed exact (nearest-rank BigInt ranks, exact binomial tails with ties counted against the candidate; the 24/31 pair minimum strictly implies its 1/100 tail, and 12/16 blocks is exactly the minimal count meeting the 1/20 tail), the receipt-gate evidence was replayed and certified internally consistent, and the wall-claim wording below follows its recommendation.

Receipt gate (PASSED, 272/272 runs, all four cells; `output/noaa-benchmarks/renderer-30pass/pass16-receipt-gate-20260724T010031487Z/summary.json`):

| Cell                  | A role-ready median | B role-ready median | B loader median / p95 / max | B-lower pairs | Sign tail |
| --------------------- | ------------------: | ------------------: | --------------------------: | ------------: | --------: |
| node20 / builder-main |          454.953 ms |           48.743 ms | 40.897 / 43.214 / 43.244 ms |         31/31 |     2^-31 |
| node20 / frame-worker |          454.878 ms |           48.892 ms | 40.977 / 41.383 / 42.502 ms |         31/31 |     2^-31 |
| node22 / builder-main |          447.047 ms |           47.715 ms | 40.606 / 41.281 / 41.663 ms |         31/31 |     2^-31 |
| node22 / frame-worker |          446.520 ms |           47.483 ms | 40.378 / 41.123 / 41.302 ms |         31/31 |     2^-31 |

The headline claim is per loading process: Snow-RF cold-load role-ready time drops from ~450 ms to ~48 ms (−89.3%), and the loader itself from 421.5–430.1 ms to 40.4–41.0 ms (−90.4%), with every sealed absolute ceiling met with headroom on both runtimes and both roles. B-mode intervals carry ten in-phase memory snapshots versus A's five, a small measurement bias against the candidate. Every one of the 272 receipts — A and B alike — reproduced the identical canonical commitment roster and whole-binary SHA-256.

Full gate (PASSED, 72 sealed-harness runs, 16 ABBA/BAAB blocks, `--snow-rf=off` (A) versus `required` (B), both arms the identical candidate source on dedicated seed clones; `output/noaa-benchmarks/renderer-30pass/pass16-full-gate-summary.json`):

| Arm                |    Median |       p95 |   Maximum | B-lower blocks | Sign tail |
| ------------------ | --------: | --------: | --------: | -------------: | --------: |
| A (off, n=32)      | 7,164.153 | 7,277.558 | 7,541.871 |                |           |
| B (required, n=32) | 6,331.705 | 6,369.031 | 6,390.700 |          16/16 |  1/65,536 |

The observed-mode wall fell 832.448 ms (−11.620%) — corroboration, not a production claim: receipts force one eager load in builder-main plus one in the frame worker in both arms, so the delta is consistent with exactly two receipt-forced loads at ~0.41 s saved each, with no regression elsewhere; both arms also pay the symmetric commitment-building overhead that production runs never pay.

Contextual unobserved interleave (production shape: no receipts, lazy loads only; Pass 15 source at `6787627` versus the candidate, dedicated clones, one warmup cycle then 8 ABBA/BAAB cycles, 32 retained runs per arm; `output/noaa-benchmarks/renderer-30pass/pass16-contextual-summary.json`):

| Arm                | Warm HRRR subprocess median |
| ------------------ | --------------------------: |
| Pass 15 unobserved |                6,402.917 ms |
| Pass 16 unobserved |                6,241.993 ms |

The candidate is 2.513% faster at median with 8/8 cycle sums candidate-lower. This is the honest production-shaped result for this fixture: the warm render path loads the model lazily once per build, and the typed asset returns ~161 ms of wall per four-frame HRRR run (partially overlapped compute hides the rest of the ~374 ms per-load delta).

Exactness:

- Mode A versus mode B artifacts from the 68 full-gate renders per clone: 350/350 manifest-referenced payloads exact across 1,118,309,044 canonical bytes, seven decompressed hover containers, one normalized manifest, and four completion markers with zero mismatches (`output/noaa-benchmarks/renderer-30pass/pass16-offvsrequired-hrrr-comparison.json`).
- Pass 15 baseline source versus the candidate across the full four-model fixture (derived sidecars purged so the compute paths engaged): 1,287/1,287 manifest-referenced payloads exact across 4,179,614,708 canonical bytes, 28 decompressed hover containers, four normalized manifests, and 16 completion markers, with zero container changes and zero mismatches (`output/noaa-benchmarks/renderer-30pass/pass16-parity-comparison.json`).
- The independent science review reimplemented the pre-pass lenient loader from `6787627`, built all three models (lenient JSON, strict JSON, typed) from the real 26 MB source, and found all 3,332,030 array elements bit-identical (`Object.is`) with 20,000 randomized predictions identical, including exact-threshold tie-break, NaN, ±Infinity, and −0 probes. The renderer cache identity remains source-only and unchanged, so the frame signature does not move.

Validation: full `npm test` (Node suites including the four Snow-RF suites, the gate-driver suite, pool and harness suites; typecheck; ESLint; Prettier; browser smoke) passes on the final tree. Hover payloads, schemas, and catalog outputs are untouched by this pass, so the previously validated browser decoding evidence remains authoritative.

Raw schema-v3 summaries: `pass16-full-*` per-run harness sessions and the gate/receipt/contextual/parity evidence files named above, all under `output/noaa-benchmarks/renderer-30pass/`.

## Campaign Storage Hygiene

At the user's explicit request, obsolete campaign clones, failed scratch roots, measurements no longer needed after audit, and the ignored/regenerable application NOAA cache were removed. Free space rose from approximately `208 GiB` to `1.0 TiB`, recovering about `800 GiB` of physical storage. The application cache accounted for approximately `670 GiB`; source, committed evidence, tool binaries, compact sealed logs, and one immutable approximately `84 GiB` four-model seed required to complete Pass 16 and the final aggregate review were retained. Cleanup is not counted as an optimization pass and no timing evidence was taken from a deleted root.

Detailed records are appended immediately after each pass review. Rejected candidates include the measured ceiling or regression, correctness result, and explicit confirmation that their code was reverted before the next pass.

## Aggregate, Final Review, and Pull Request

The performed campaign is complete: Passes 1–16 executed, reviewed, benchmarked, and documented; deferred Passes 17–20 are excluded from pass counts, aggregate arithmetic, acceptance claims, and the pull request.

Final aggregate gate (2026-07-24): a fresh four-model campaign-baseline-versus-final interleave ran on dedicated CoW clones of the immutable seed — one warmup cycle then two ABBA/BAAB cycles per model (8 retained runs per arm per model), unobserved (no benchmark receipts), sealed pinned builder flags and environment, campaign-infrastructure baseline `0fefbc6` versus the final Pass 16 candidate:

| Model    | Campaign-baseline median | Final median |    Delta | Candidate-lower cycles |
| -------- | -----------------------: | -----------: | -------: | ---------------------: |
| GFS      |             8,227.345 ms | 5,994.680 ms | -27.137% |                    2/2 |
| NAM      |             7,385.816 ms | 5,407.926 ms | -26.780% |                    2/2 |
| NAM 3 km |             9,262.557 ms | 6,596.245 ms | -28.786% |                    2/2 |
| HRRR     |             8,675.765 ms | 6,225.608 ms | -28.241% |                    2/2 |

The four-model median sum fell from 33,551.482 ms to 24,224.459 ms (`-27.799%`). Against the committed campaign-baseline HRRR median of 8,726.318 ms, the final HRRR median of 6,225.608 ms is a fresh cumulative improvement of `28.657%`; the fresh interleaved baseline arm re-measured that committed value within 0.58% (8,675.765 ms), corroborating thermal comparability. Per-model evidence lives in `output/noaa-benchmarks/renderer-30pass/pass16-aggregate-{gfs,nam,nam3km,hrrr}-summary.json`.

Exactness at the final source: the Pass 16 parity comparisons above (four-model baseline-versus-candidate and HRRR off-versus-required, 1,287/1,287 and 350/350 payloads exact) are the campaign's closing artifact-parity evidence. Hover payload formats and browser decode paths are unchanged since their Pass 07–13 validations; the one client change in the closing review (graceful handling of future hover schema identities in manifest normalization) is covered by the Node-run esbuild client suites, typecheck, and browser smoke inside the full `npm test` gate, which passes on the final tree.

Independent reviews at the final tree: implementation (no P0–P2; six P3 notes, two fixed and four recorded as deliberate designs), science/output (bit-exactness independently reproduced), and benchmark-method (statistics re-derived; receipt-gate evidence replayed and certified; claim wording adopted). The closing session also reviewed the merged upstream campaign (PR #29) and every branch commit with scored multi-agent reviews; the accepted findings — a pass 10/12 commit swap in the evidence file, missing durable copies of passes 06–15 ephemeral evidence, a stale `.env.example` compress-threads comment, a fail-open `MODELVIEW_NOAA_FAST_PACK` resolver, unwired generated-asset CI checks, a manifest-wide client failure on future hover schema identities, a misleading hover shortcut comment, and an incorrect comparator usage text — are fixed in this branch, and the one deferred item (folding compiler identities into the renderer signature) is recorded in `docs/noaa-renderer-benchmark-history.md` with its rationale.

The pull request follows this record.
