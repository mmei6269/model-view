# Renderer Optimization: 20-Pass Campaign (2026-07-22)

Status: implementation and validation complete on `codex/renderer-optimization-20-pass`.

This log is the source of truth for the twenty measured renderer optimization passes requested on 2026-07-22. A pass is counted when a concrete optimization hypothesis has been implemented or isolated, benchmarked against its immediate baseline, reviewed for correctness and scientific impact, and either accepted or reverted. A null or regressive candidate remains in the log; it does not remain in production code.

## Acceptance Contract

- Meteorological correctness remains the first constraint. No broad weather heuristic, source omission, threshold shortcut, reduced spatial resolution, or display-driven calculation skip is allowed.
- Bit-identical output is required for passes that only change scheduling, caching, memory ownership, serialization plumbing, or exact arithmetic. `.complete.json` comparisons normalize only `renderedAt` and `renderProfile`.
- A deliberately numerical pass may move output only when the change is not meteorologically or scientifically meaningful. Such a pass must report finite/missing and classification/threshold flips, per-layer changed RGBA pixels, hover-grid changed samples and maximum deltas in stored/display units, randomized reference-oracle results, and the method/kernel/cache identity change.
- Performance candidates are accepted only when the signal is repeatable outside pooled noise or when a separately measured resource benefit is compelling and the complexity/risk is low. Cumulative improvement is measured fresh against the original tree; pass percentages are not multiplied together.
- Architectural changes are eligible when profiles identify a large end-to-end ceiling. They require a separate implementer and reviewer, root-level review, targeted failure-path/concurrency tests, complete artifact validation, and isolated A/B evidence; speculative restructuring does not qualify as an optimization pass.
- Every accepted pass receives focused tests, full relevant validation, artifact comparison, formatter/linter checks, and a post-pass code review. Rejected passes are reverted before the next cumulative baseline.

## Pinned Fixture and Method

Original source baseline: `a7d7cb7` (`master` at campaign start).

The canonical fixture is a 16-frame CONUS prefix with warm raw NOAA inputs:

| Model    | Run            | Hours              |
| -------- | -------------- | ------------------ |
| GFS      | 2026-07-16 06Z | 000, 003, 006, 009 |
| NAM      | 2026-07-16 12Z | 000, 001, 002, 003 |
| NAM 3 km | 2026-07-16 12Z | 000, 001, 002, 003 |
| HRRR     | 2026-07-16 13Z | 000, 001, 002, 003 |

`scripts/benchmark-noaa-renderer.js` requires an explicit isolated `--cache-root`, records immutable raw logs plus JSON summaries, retains raw samples, and reports median, MAD, p95, sum, frame-kind counts, failures, stage timings, and cache/engagement counters. It isolates renderer inputs from caller and source-tree `.env` values, permits only an explicit shell `WGRIB2` override, and pins the serial renderer controls plus these implementation choices:

```text
MODELVIEW_PARCEL_KERNEL=wasm-f32
MODELVIEW_DERIVED_SLAB=on
MODELVIEW_PNG_DEFLATE_BACKEND=libdeflate
MODELVIEW_NOAA_COMPRESS_MAX_PENDING=2
MODELVIEW_NOAA_HOVER_COMPRESSION=brotli
MODELVIEW_NOAA_HOVER_BROTLI_QUALITY=0
MODELVIEW_NOAA_HOVER_GZIP_LEVEL=1
MODELVIEW_ARTIFACT_PREFIX=tiles
MODELVIEW_REFLECTIVITY_GATES=10,15,20
```

The child process also pins `LANG=C`, `LC_ALL=C`, `TZ=UTC`, `UV_THREADPOOL_SIZE=4`, and clears Node injection/debug/coverage controls. Schema-v2 summaries record the complete resolved builder flags, environment policy, source/diff fingerprint, executable/tool hashes, runtime, CPU, and memory. Every repetition must profile exactly one main frame for every requested model/run/hour; a zero, missing, duplicate, wrong-model, wrong-run, or wrong-hour main roster is retained in the raw log and summary but fails the harness. A source/diff fingerprint change during the session also makes the summary fail instead of silently mixing revisions.

Per-pass timing uses a warm-up followed by interleaved A/B/B/A revisions with at least three measured processes per revision when practical. High-yield cold-cache work is also tested with cloned isolated caches that keep the raw input roster but omit only the cache family under study. Final cumulative timing uses a fresh final-versus-`a7d7cb7` interleave on all four model fixtures.

### Baseline CPU attribution

A V8 CPU profile of the untouched baseline over the four serial HRRR frames separates the remaining ceilings:

| Thread/process      | Largest self-time samples over the 12.2–12.9 s profile window                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Render worker       | idle/wait 6.184 s; Mercator row remap 1.425 s; continuous scalar raster loops 1.005 s; GC 0.355 s; named WASM parcel samples 0.487 s |
| Compression helper  | idle 6.121 s; hover zlib 2.580 s; named libdeflate WASM samples 3.235 s                                                              |
| Parent/orchestrator | idle 12.385 s; no parent CPU hotspot above 0.074 s                                                                                   |

This makes hover compression the largest low-risk lossless target. Remapping and rasterization are the next warm-render compute ceilings. Cold temporal builds additionally justify the cross-family decode/cache architectural passes, which are measured with the affected cache families deliberately absent rather than inferred from this warm profile.

## Pass Table

| Pass | Candidate and finding                                                                                                                                                                                                        | Measured result                                                                                                                           | Decision | Fresh cumulative vs original |
| ---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------: |
|   01 | Transfer compression-worker `Uint8Array` backing stores instead of cloning the reply. Large production buffers already owned exact-sized backing stores, so the transfer avoided no material copy.                           | HRRR warm A/B/B/A subprocess median `13,209.85 -> 13,212.57 ms` (`+0.02%`, regression/noise); `compressWait` `1,569.3 -> 1,571.0 ms`.     | Reverted |                      `0.00%` |
|   02 | Cross-family same-hour selected-GRIB union. The first barrier was vacuous; the production-engaged redesign saved only 2/13 calls, added union materialization, and broke provenance identity.                                | NAM3km temporal A/B `12,469.58 -> 12,438.37 ms` (`-0.25%`, noise); main wall `+43.1 ms`, decode only `-1.4 ms`.                           | Reverted |                      `0.00%` |
|   03 | Replace hover gzip level 1 with lossless Brotli q0; q1 was also measured. Raw hover values remain exact, while q0 removes the largest compression-helper hotspot.                                                            | HRRR warm A/B/B/A subprocess median `12,886.19 -> 10,926.98 ms` (`-15.20%`); `compressWait -30.57%`; hover bytes `-0.88%`.                | Accepted |                    `-15.14%` |
|   04 | Classify each source row once and use unchecked Mercator-remap loops for finite rows. The extra classification pass defeated V8's already-efficient fused loop.                                                              | 1,600×980 bilinear median `2.644 -> 3.375 ms` (`+27.6%`); nearest `1.822 -> 2.420 ms` (`+32.8%`).                                         | Reverted |                    `-15.14%` |
|   05 | Replace `Number.isFinite(x) && Math.abs(x) < 1e19` with the equivalent bounded comparison in Mercator cell loops.                                                                                                            | HRRR A/B/B/A median `11,134.87 -> 10,930.10 ms` (`-1.84%`); `gridMap` median `440.55 -> 395.95 ms` (`-10.12%`).                           | Accepted |                    `-16.05%` |
|   06 | Parent-global compression-service architecture. Saturated throughput is already faster inline; routing/copies would add complexity without removing the CPU floor.                                                           | 16-way inline `7.470 s`; current helpers `8.350–8.690 s` (`+11.8–16.3%`) and roughly `+10–12 GiB` RSS.                                    | Rejected |                    `-16.05%` |
|   07 | Resolve compression helpers once per build: two only with spare cores/memory, otherwise inline; preserve explicit overrides.                                                                                                 | Two helpers: serial `-12.0%`, 4-way `-7.6%`, 8-way `-6.9%`; inline avoids `+4.6%` at 12-way and `+11.8–14.2%` at 16-way.                  | Accepted |                    `-15.06%` |
|   08 | Do not create compression helpers for snow/delta/prefix render modes, which never submit compression jobs.                                                                                                                   | 16-process micro: median RSS `55.21 -> 37.17 MB` (`-18.05 MB/worker`); process wall `128.66 -> 122.73 ms` (`-4.6%`).                      | Accepted |                    `-16.31%` |
|   09 | Replace `base + x` typed-array addressing with independently incremented indices in Mercator loops. Microbench improved, but the actual worker optimized the original loop better.                                           | HRRR A/B/B/A process `10,805.09 -> 10,939.59 ms` (`+1.24%`); `gridMap` `407.8 -> 443.3 ms` (`+8.71%`).                                    | Reverted |                    `-16.31%` |
|   10 | Raise libdeflate PNG compression from level 1 to 2 to test whether lower write volume offsets codec work. It does not on renderer-scale payloads.                                                                            | 83 F003 PNGs: `927.22 -> 1,516.36 ms` (`+63.5%`) for only `53.53 -> 50.26 MB` (`-6.1%`).                                                  | Rejected |                    `-16.31%` |
|   11 | Copy complete RGBA palette entries through endian-safe aligned `Uint32` views, with a byte-store fallback for unusual views.                                                                                                 | Scalar micro `-4.77%`; HRRR wall `+0.09%` (neutral), but `catalogPng -2.27%` and `corePng -1.60%`.                                        | Accepted |                    `-16.33%` |
|   12 | Hoist visibility bounds, finite flags, and continuous lookup/log constants out of every scalar pixel loop.                                                                                                                   | HRRR A/B/B/A `11,002.04 -> 10,821.71 ms` (`-1.64%`); `catalogPng -9.02%`, `artifacts -2.67%`.                                             | Accepted |                    `-17.39%` |
|   13 | Replace scalar-loop `Number.isFinite(value)` with a value-self comparison. V8 optimized the explicit built-in better.                                                                                                        | Five-workload 1,600×980 micro aggregate `55.766 -> 56.925 ms` (`+2.08%`).                                                                 | Reverted |                    `-17.39%` |
|   14 | Replace generic overflow-scaled `Math.hypot` with a direct finite Euclidean norm in frontogenesis. Broad weather values remain f32-identical; only constructed cancellation at numerical zero moves.                         | HRRR A/B/B/A `10,660.25 -> 10,468.37 ms` (`-1.80%`); `derivedGrid` stage sum `-19.09%`; all 367 payload artifacts exact.                  | Accepted |                    `-18.19%` |
|   15 | Replace warm selected-GRIB reread plus JavaScript Mercator remapping with a validated `mercator-grid-pack-v2` cache of final Float32 grids. Independent review fixed legacy memo identity, overlap rejection, and profiling. | HRRR A/B/B/A `10,407.06 -> 9,158.28 ms` (`-12.00%`); `gridMap -83.22%`; active-cache bytes `+2.72%`; all 367 payload artifacts exact.     | Accepted |                    `-27.95%` |
|   16 | Vectorize masked presentation smoothing with exact WebAssembly `f64x2` lanes and scalar tails. Adversarial review covered non-finite values, masks, odd lengths, memory guards, and deterministic rebuilds.                  | HRRR A/B/B/A `9,402.17 -> 9,213.08 ms` (`-2.01%`); `catalogPng -6.79%`; terrain-mask micro `-29.00%`; all 367 payload artifacts exact.    | Accepted |                    `-28.31%` |
|   17 | Supply Brotli q0 with the explicit uncompressed `SIZE_HINT`. The one-shot API already receives the whole buffer, so the hint added no stable information or benefit.                                                         | Real HRRR pooled median `213.826 -> 213.503 ms` (`-0.15%`, noise); independent repeat `+0.035%`; compressed bytes and SHA-256 exact.      | Rejected |                    `-28.31%` |
|   18 | Fuse exact Int16 delta encoding into each hot WASM hover quantizer chunk, then adjust one residue per variable to preserve the global v3 stream. Cross-review fixed bounds, JSON misuse, and fallback speed.                 | Independent 225.8 MB rerun `100.834 -> 82.872 ms` (`-17.81%`); raw/worker bytes exact; full suites 924 Node + 164 browser tests.          | Accepted |                    `-28.95%` |
|   19 | Add a versioned, checksummed, atomic/fail-open sidecar for exact raw LCL, theta-e, and 850/700-mb frontogenesis grids. Independent architecture review tightened method identity.                                            | HRRR warm process mean `9,035.38 -> 8,543.93 ms` (`-5.44%`); `derivedGrid -70.59%`; cold neutral; `+23.93 MiB/frame`; 367 payloads exact. | Accepted |                    `-32.14%` |
|   20 | Read each v2 Mercator pack in one 0.95 GB operation and expose zero-copy Float32 views. Node's very-large `readFile` path was slower than the current large sequential slices.                                               | Real 953,344,000-byte HRRR pack `42.449 -> 60.909 ms` (`+43.49%`); all 152 fields/full SHA-256 exact.                                     | Rejected |                    `-32.14%` |

## Final Cumulative Evidence

The cumulative column is a fresh direct comparison with the reconstructed original tree, not a product of the per-pass percentages. The original HRRR checkpoint ran before and after the accepted-checkpoint sequence. Its six subprocess samples were `13,222.748`, `13,000.653`, `12,964.901`, `13,191.937`, `13,011.302`, and `13,069.420 ms`; the combined median is `13,040.361 ms`. Rejected/reverted passes carry the immediately preceding accepted checkpoint because none of their candidate code remains.

| Accepted checkpoint | Subprocess samples (ms)            | Median / MAD (ms)   | Direct cumulative vs original |
| ------------------: | ---------------------------------- | ------------------- | ----------------------------: |
|                  03 | 11,446.412, 10,995.081, 11,065.409 | 11,065.409 / 70.328 |                       -15.14% |
|                  05 | 10,936.620, 10,973.099, 10,946.750 | 10,946.750 / 10.130 |                       -16.05% |
|                  07 | 11,213.151, 11,030.847, 11,077.005 | 11,077.005 / 46.158 |                       -15.06% |
|                  08 | 10,913.692, 10,910.326, 10,951.345 | 10,913.692 / 3.367  |                       -16.31% |
|                  11 | 10,898.795, 10,910.971, 10,984.395 | 10,910.971 / 12.175 |                       -16.33% |
|                  12 | 10,773.170, 10,712.583, 10,793.210 | 10,773.170 / 20.040 |                       -17.39% |
|                  14 | 10,631.535, 10,668.237, 10,737.444 | 10,668.237 / 36.701 |                       -18.19% |
|                  15 | 9,485.665, 9,377.902, 9,395.678    | 9,395.678 / 17.776  |                       -27.95% |
|                  16 | 9,371.438, 9,348.133, 9,341.277    | 9,348.133 / 6.856   |                       -28.31% |
|                  18 | 9,265.530, 9,246.146, 9,340.413    | 9,265.530 / 19.384  |                       -28.95% |
|                  19 | 8,860.446, 8,848.836, 8,843.248    | 8,848.836 / 5.588   |                       -32.14% |

Pass 07's topology policy is deliberately suppressed by the serial harness's explicit one-helper pin, so its cumulative row is a direct but neutral/noisy serial checkpoint; the separately reviewed 1/4/8/12/16-frame crossover matrix is its acceptance evidence. One earlier Pass 07 session was quarantined rather than cherry-picked: it overlapped with concurrent browser/snapshot review work, its samples degraded from `11,139.425` to `13,723.375` to `18,495.815 ms`, and free-memory telemetry fell to 1–2 GiB. Because that session was not isolated, all other work was stopped before the idle rerun above, which had a `46.158 ms` MAD. The machine-readable evidence records both sessions and the exclusion reason.

### Final 16-frame original-versus-final gate

Each arm used three source-stable processes, warm raw/model caches, the same explicit wgrib2 binary, and the harness's exact four-frame roster gate. Every final process reported all supplemental-derived sidecars as hits.

| Model    | Original median / MAD (ms) | Final median / MAD (ms) |  Change |
| -------- | -------------------------- | ----------------------- | ------: |
| GFS      | 11,879.869 / 48.111        | 8,520.395 / 5.987       | -28.28% |
| NAM      | 11,152.262 / 60.781        | 7,558.128 / 15.002      | -32.23% |
| NAM 3 km | 14,151.268 / 183.102       | 9,489.754 / 8.626       | -32.94% |
| HRRR     | 13,448.596 / 6.298         | 9,169.238 / 7.125       | -31.82% |
| Sum      | 50,631.995                 | 34,737.515              | -31.39% |

Final artifact parity traversed only the 16 manifests' referenced payloads, canonicalized `.bin.gz` and `.bin.br` to the same logical key, and decompressed the hover container before comparison. All `1,348` payloads (`4,184,780,835` canonical bytes, including 28 hover payloads) were exact with no missing keys or mismatches; aggregate canonical SHA-256 is `7187e7456c945025563e11a22636b8b841bdd002d1ff9128278e3f561c7a47c6`. This includes all 367 HRRR payloads. Pass 14's allowed numerical relaxation therefore changed no real-fixture payload: its only observed movement remains constructed cancellation at numerical zero, bounded to `3.68e-15 C/100 km/3 h` with six sign flips in 500,000 adversarial samples and no meteorological threshold/finite-state effect.

A real Chromium integration used the production local server and browser decoder. Brotli decoded `37,609,354 -> 188,165,868` bytes with all 60 variable fingerprints exact; legacy gzip decoded `38,962,388 -> 191,301,966` bytes with all 61 exact. The adversarial encoder check established fused/legacy raw-stream byte identity in Node; Chromium then decoded that exact fused stream and restored every value across signed-Int16 extremes and cross-variable carry boundaries.

Final review found and fixed an opposite-codec publication race by retaining both `.br` and `.gz` bodies until normal run pruning/cache clear; a deterministic two-process race now proves the winning manifest always resolves. It also made the benchmark fail on empty/missing/duplicate/wrong-frame rosters, renderer-reported failures, or mid-session source mutation, and derives missing content encoding from actual container bytes. The completed gates are 940/940 Node tests, 164/164 React Playwright tests, TypeScript, ESLint, full Prettier, and `git diff --check`, followed by an independent no-open-P0/P1/P2 campaign audit.

Compact samples, fingerprints, summary paths, final-model results, exclusion rationale, tool identity, and parity hashes are committed in `docs/renderer-optimization-20-pass-evidence.json`; full raw logs and schema-v2 summaries remain under `output/noaa-benchmarks/renderer-20pass/`.

## Detailed Pass Records

### Pass 01 — Compression Reply Transfer

Hypothesis: the compression worker was returning an `ArrayBuffer` to the parent and the parent reconstructed a `Buffer`; explicitly transferring the result's safe backing store might remove a large structured-clone copy from every PNG/hover compression result.

Implementation under test:

- Transfer exact-sized, safe `Uint8Array` backing stores with offset and length metadata.
- Reconstruct a zero-copy `Buffer` view in the parent.
- Copy pooled or otherwise unsafe backing stores, retain compatibility with legacy `ArrayBuffer` replies, and keep a conservative Node 20 fallback.

Review and correctness:

- A production 225,799,044-byte hover payload returned an exact-sized backing store before and after the change (`buffer.byteLength / byteLength = 1`, offset 0), explaining the lack of benefit.
- The microbenchmark returned the same 41,887,536-byte gzip stream with SHA-256 `59b306…` in both revisions.
- The full HRRR four-frame artifact trees contained 371 files each and compared byte-identically after normalizing only `.complete.json` `renderedAt` and `renderProfile`.
- Compression/PNG parity tests passed 22/22 after implementation and again after the review-driven revert.

Performance evidence:

| Revision        | Subprocess samples (ms)                               | Median / MAD / p95 (ms)        |
| --------------- | ----------------------------------------------------- | ------------------------------ |
| Baseline A1+A2  | 13076.567, 13161.125, 13333.580, 13209.855, 13287.857 | 13209.855 / 78.003 / 13333.580 |
| Candidate B1+B2 | 13282.700, 13195.916, 13208.927, 13232.724, 13212.571 | 13212.571 / 16.655 / 13282.700 |

The candidate was 0.02% slower at subprocess median and 0.11% slower in `compressWait`, both far inside observed noise. It was reverted in full. No output, cache identity, format, meteorological calculation, or scientific value changed.

### Pass 02 — Cross-Family Same-Hour Decode Union

Hypothesis: temporal precipitation, freezing-rain, snow-liquid, and profile consumers often request different records from the same GRIB hour. Unioning their selected records could reduce repeated wgrib2 materialize/regrid/decode executions while retaining exact per-record interpolation policy and logical provenance.

The first implementation used a same-tick request barrier keyed by URL, hour, cache/temp geometry, concurrency, interpolation policy, and limiter identity. Focused tests passed, but a real cold-temporal NAM3km F000–F003 run proved the test was vacuous: all 13 logical requests became 13 executions and `hourDecodeCallsSaved=0` because production consumers await one family before scheduling the next.

The redesigned production-shaped barrier explicitly planned snow-liquid invocations. It demonstrated real engagement: F002 and F003 each combined two logical requests into one union execution, for 13 requests, 11 executions, and two calls saved. The fair warm-selected-cache comparison then showed the ceiling was negligible:

| Measurement          |      Disabled |       Enabled |               Delta |
| -------------------- | ------------: | ------------: | ------------------: |
| Subprocess wall      | 12,469.577 ms | 12,438.369 ms | -31.207 ms (-0.25%) |
| Main-frame wall sum  |   11,386.2 ms |   11,429.3 ms |            +43.1 ms |
| Decode stage sum     |    1,810.8 ms |    1,809.4 ms |             -1.4 ms |
| Snow-delta stage sum |      697.7 ms |      753.3 ms |            +55.6 ms |

All 360 payload artifacts were byte-identical, but three completion markers and manifests failed the exact gate: the union selected-GRIB source remained alongside the two logical sources (`17 -> 19` provenance entries). Attempts to relabel or suppress it were rejected in independent review because provenance is frame-global and the production barrier bypassed the path exercised by the cleaner unit fixture. The redesign also materialized logical A, logical B, and union A∪B sources on the cold path, hid some union work behind `profile: null`, and added failure/counter ambiguity for a result inside process noise.

The implementer, independent reviewer, and root therefore rejected the architecture. Its code, tests, counters, and environment gate were surgically removed while preserving unrelated campaign work. No output or scientific behavior from this pass remains; a future decode union must start from an explicit frame-wide plan before any logical materialization and show a materially larger real call roster.

### Pass 03 — Lossless Brotli Hover Artifacts

Hypothesis: hover gzip was the largest remaining lossless compression hotspot. Node's built-in Brotli q0 can encode the schema-v3 delta payload materially faster without changing any decoded Int16 value or adding a dependency.

Implementation and compatibility:

- New hover artifacts use `.bin.br`/`Content-Encoding: br`, with codec and quality included in renderer completion identity (`v50`).
- `MODELVIEW_NOAA_HOVER_COMPRESSION=gzip` retains legacy gzip generation; the decoder, supplemental merge path, empty artifacts, local server, browser binary detection, and cache keys accept both `.br` and `.gz`.
- Render persistence deliberately retains an alternate-codec counterpart within the same retained run. Automatic deletion was removed after a two-process opposite-codec race showed it could delete the body selected by the winning manifest; standard run pruning or explicit cache clear performs cleanup outside active publication.
- The helper-thread and inline paths invoke the same synchronous codec, preserving per-call failure fallback behavior.
- Brotli q0 is the default. Q1 was measured but rejected as the default because it spent another ~152 ms per dense F003 payload to save ~706 KiB.

Real-payload microbenchmarks used seven rotating samples per codec:

| Payload                          | Codec     | Median / MAD / p95           |      Bytes | Result vs gzip              |
| -------------------------------- | --------- | ---------------------------- | ---------: | --------------------------- |
| HRRR F003, 225,799,044 raw bytes | gzip L1   | 658.811 / 1.182 / 667.169 ms | 41,887,536 | baseline                    |
| HRRR F003                        | Brotli q0 | 202.704 / 0.358 / 208.560 ms | 41,461,711 | 3.25x faster, 1.02% smaller |
| HRRR F003                        | Brotli q1 | 354.888 / 0.901 / 355.789 ms | 40,756,001 | 1.86x faster, 2.70% smaller |
| HRRR F000, 188,165,868 raw bytes | gzip L1   | 617.334 / 3.495 / — ms       | 38,670,900 | baseline                    |
| HRRR F000                        | Brotli q0 | 194.826 / 2.869 / — ms       | 38,768,462 | 3.17x faster, 0.25% larger  |
| HRRR F000                        | Brotli q1 | 344.148 / 1.432 / — ms       | 37,609,354 | 1.79x faster, 2.75% smaller |

All nine codec/payload combinations decompressed exactly to their source buffers. F003's raw SHA-256 begins `afef33fb4f16c88a`; gzip's deterministic compressed SHA-256 begins `59b306f449e0a614`.

The full warm HRRR F000-F003 interleave produced these subprocess samples:

| Revision        | Samples (ms)                               | Median / MAD / p95 (ms)        |
| --------------- | ------------------------------------------ | ------------------------------ |
| gzip A1+A2      | 12864.973, 12782.734, 12907.406, 13016.307 | 12886.189 / 62.336 / 13016.307 |
| Brotli q0 B1+B2 | 10858.315, 10914.819, 10970.647, 10939.140 | 10926.980 / 27.913 / 10970.647 |
| Brotli q1       | 11563.782, 11683.079, 11688.917            | 11683.079 / 5.839 / 11688.917  |

Q0 improved subprocess median 15.20%, the median per-run base-frame wall sum 16.01%, `compressWait` 30.57%, and `artifacts` 21.57%. Across the seven base/supplemental hover artifacts, transfer bytes changed from 163,162,484 (gzip) to 161,728,223 (q0, -0.879%); q1 reached 158,408,395 bytes (-2.914%) but was 6.47% slower than q0.

Correctness review compared 367-file inventories: 360 non-hover files were byte-identical, and all seven hover artifacts decompressed byte-identically. Root review added an end-to-end local-server test proving `.br` receives `Content-Encoding: br` while `.gz` still receives `gzip`; browser, codec, merge, pool fallback, and server suites pass. This pass changes only the lossless container, not any meteorological value, threshold, finite/missing state, PNG pixel, hover sample, or scientific interpretation.

### Pass 04 — Mercator Source-Row Usability Fast Path

Hypothesis: many Web Mercator output rows reuse the same source rows. Caching one all-finite/sentinel-safe classification per source row would let the common bilinear path omit two `Number.isFinite`/sentinel checks per output cell, while rows containing missing values would retain the existing exact cell-wise fallback.

The candidate used a tri-state `Uint8Array` row cache and separate unchecked loops for rows whose two sources were usable. A deterministic 1,600×980 microbenchmark used four warm-ups and 15 timed samples per case. It covered bilinear and nearest remaps with both entirely finite grids and sparse `NaN` values. Output checksums were identical in every case.

| Case                     | Baseline median / MAD | Candidate median / MAD | Result        |
| ------------------------ | --------------------- | ---------------------- | ------------- |
| Bilinear, finite         | 2.644 / 0.025 ms      | 3.375 / 0.303 ms       | 27.6% slower  |
| Bilinear, sparse missing | 2.781 / 0.026 ms      | 3.280 / 0.364 ms       | 17.9% slower  |
| Nearest, finite          | 1.822 / 0.031 ms      | 2.420 / 0.176 ms       | 32.8% slower  |
| Nearest, sparse missing  | 1.161 / 0.022 ms      | 2.417 / 0.118 ms       | 108.2% slower |

Review found that the up-front full-grid classification adds another memory traversal and inhibits V8's optimization of the compact fused validation/write loop. The regression was large and consistent enough that a full renderer run could not reverse the local cost. The candidate was reverted completely before the next pass. No artifact, cache identity, meteorological value, or scientific behavior changed.

### Pass 05 — Bounded GRIB Usability Predicate

Hypothesis: the remap hot loop can test `x > -1e19 && x < 1e19` instead of `Number.isFinite(x) && Math.abs(x) < 1e19`. The predicates are equivalent for all JavaScript numbers: both reject `NaN`, infinities, and the inclusive sentinel boundaries while accepting exactly the same finite interior values.

A rotating in-process microbenchmark compared the old reference and candidate over 24 samples after five paired warm-ups on 1,600×980 grids. Every output cell matched with `Object.is`:

| Case                     | Baseline median / MAD | Candidate median / MAD | Result       |
| ------------------------ | --------------------- | ---------------------- | ------------ |
| Bilinear, finite         | 3.762 / 0.042 ms      | 2.620 / 0.016 ms       | 30.4% faster |
| Bilinear, sparse missing | 3.771 / 0.028 ms      | 2.958 / 0.015 ms       | 21.6% faster |
| Nearest, finite          | 3.183 / 0.064 ms      | 1.984 / 0.031 ms       | 37.7% faster |
| Nearest, sparse missing  | 3.174 / 0.012 ms      | 1.170 / 0.012 ms       | 63.1% faster |

The warm four-frame HRRR renderer interleave used separate APFS-cloned caches and two repetitions in each A/B/B/A leg:

| Revision        | Subprocess samples (ms)                    | Median (ms) |
| --------------- | ------------------------------------------ | ----------: |
| Reference A1+A2 | 11067.812, 10943.342, 11201.922, 11512.878 |   11134.867 |
| Candidate B1+B2 | 10932.663, 10921.759, 10927.545, 11089.865 |   10930.104 |

Subprocess median improved 1.84% and sample-sum time improved 1.91%. Across the 16 main-frame samples, `gridMap` median improved `440.55 -> 395.95 ms` (10.12%) and stage-sum time improved 8.98%. All 367 non-marker artifacts compared byte-for-byte, the randomized 128-case bilinear/nearest oracle passed every cell including `NaN`, infinities, signed zero, and sentinels, and the 133-test focused renderer suite passed. This exact arithmetic-predicate pass changes no meteorological value, missing state, threshold, pixel, or cache identity.

### Pass 06 — Parent-Global Compression Service Architecture

Hypothesis: replacing the isolate-local helper pools with one parent-global compression service might prevent the default build from creating up to 18 independent pools and improve machine-wide throughput.

This was treated as the campaign's large-architecture gate: one subagent mapped and benchmarked the topology, a second independently reviewed failure semantics, queueing, memory ownership, and the evidence, and root reviewed the recommendation before any implementation. The audit established that the current `threads=1` default can create 18 compression helpers in addition to 18 frame workers; `threads=2` can create 36. Inputs are cloned, outputs transferred, and `maxPending` only moves excess copied inputs into an unbounded waiter FIFO rather than applying byte-level producer backpressure.

The 16-frame warm NAM3km matrix used Brotli q0, libdeflate, 18 workers, forward/reverse ordering, focused ABBA confirmation, and exact artifact parity:

| Helpers | Pending | Mean wall | vs inline | Mean user CPU |  Peak RSS |
| ------: | ------: | --------: | --------: | ------------: | --------: |
|       0 |       1 |   7.470 s |         — |       98.48 s | 31.11 GiB |
|       1 |       1 |   8.350 s |    +11.8% |      108.62 s | 42.23 GiB |
|       1 |       2 |   8.410 s |    +12.6% |      111.48 s | 42.95 GiB |
|       1 |       4 |   8.560 s |    +14.6% |      113.62 s | 42.04 GiB |
|       2 |       2 |   8.530 s |    +14.2% |      113.39 s | 43.21 GiB |
|       2 |       4 |   8.690 s |    +16.3% |      115.31 s | 40.94 GiB |

The focused ABBA checks confirmed `threads=1/pending=1` was 11.4% slower and `threads=2/pending=4` was 6.6% slower than inline under saturation. Across all modes, 1,439 PNG/hover/synoptic artifacts (1.762 GiB) had the identical aggregate SHA-256 `987e0700b15cb32997710f3e471fd50672695e8fb035c9527e0977e7c78106db`; all 44 benchmark/parity legs completed without frame errors.

Review rejected the refactor. At saturation, both designs share the same total codec-plus-render CPU/core floor, while a broker would add routing, structured clones, scheduling, fairness, cancellation, epoching, worker-death recovery, and a new global failure domain. A safe broker would first require byte-weighted admission before raw scanline/hover construction and direct transferable routing; a token added to today's `submit()` is too late to prevent retained copies. The measured acceptance threshold for revisiting this architecture is a repeatable 5% gain over the adaptive baseline while lowering RSS. The smaller adaptive policy isolated by the crossover study proceeds as a separate pass.

### Pass 07 — Adaptive Compression-Helper Topology

Hypothesis: resolving helper count once from the final roster, active outer-pool width, CPU count, and memory headroom can retain the low-concurrency latency win while eliminating the saturated-build regression identified in Pass 06.

The accepted policy uses two helpers per active main-frame worker only when active main frames are strictly below half the logical cores; otherwise it compresses inline. On the measured 18-core host this means 1–8 active main frames use two helpers and 9+ use none. One helper is never selected automatically because Brotli q0 made it neutral serially and regressive under load. The policy keeps an 8 GiB reserve plus 1.5 GiB per active helper-producing frame, fails closed to inline when measured free memory is lower, does not spend cores withheld through explicit frame throttles, and preserves explicit `0..4`, `off`, and `auto` overrides. The resolved count is logged and included in the terminal JSON summary.

The independently reviewed crossover ABBA supplies the performance evidence:

| Active frames |   Inline | Two helpers | Selected auto mode | Effect of selection     |
| ------------: | -------: | ----------: | ------------------ | ----------------------- |
|             1 | 10.793 s |     9.495 s | 2 helpers          | 12.0% faster            |
|             4 |  4.070 s |     3.760 s | 2 helpers          | 7.6% faster             |
|             8 |  5.300 s |     4.935 s | 2 helpers          | 6.9% faster             |
|            12 |  6.465 s |     6.760 s | inline             | avoids 4.6% regression  |
|            16 |  7.470 s |     8.530 s | inline             | avoids 14.2% regression |

Against the old automatic one-helper default, the saturated 16-frame selection avoids an independently confirmed 11.4% regression and roughly 11 GiB of additional RSS. All 1,439 compared codec artifacts are exact across helper counts. Root added 15 policy/failure/backpressure/harness checks (25 focused tests total), including boundary, memory, explicit-throttle, explicit-override, blank-template, garbage, worker-spawn, mid-job death, and waiter-release cases. A production-shaped run under deliberate low-memory pressure logged `compress-threads=0` and completed all four HRRR frames without failures, confirming the conservative fallback. No codec, meteorological calculation, artifact byte, or scientific value changes in this pass.

### Pass 08 — Base-Only Compression-Pool Creation

Hypothesis: snow, snow-delta, snow-prefix, and run-max-prefix tasks pass no asynchronous compressor into their artifact builders, yet the renderer created a worker pool before choosing the render-mode branch. Restricting pool creation to `all` and `base` avoids helpers that can never receive a job.

A 16-process rotating microbenchmark compared the real two-helper construction path with the gated no-op path, holding each process for 75 ms so worker startup and resident memory were observable:

| Measurement                 |        Unused two-helper pool |         Gated path | Result                    |
| --------------------------- | ----------------------------: | -----------------: | ------------------------- |
| Synchronous selection/spawn |               2.273 ms median |          0.0004 ms | removes 2.27 ms           |
| Child process wall          | 128.655 / 2.574 ms median/MAD | 122.731 / 1.644 ms | 4.6% faster               |
| Resident set at sample      |              55.214 MB median |          37.167 MB | 18.047 MB less per worker |

In a wide split-frame queue, this prevents hundreds of megabytes of idle helper overhead when workers receive only prerequisite or snow tasks; workers that later receive a base task still create and reuse their pool lazily. The focused mode-engagement test proves only `all`/`base` can construct a pool and all six render-mode cases are covered. Compression fallback/backpressure tests and the renderer suite pass. Because these modes never used the pool for output, the change is exact by construction: no bytes, values, thresholds, pixels, cache identities, or scientific results change.

### Pass 09 — Monotonic Mercator Array Indices

Hypothesis: carrying `lowerIndex`, `upperIndex`, and `outIndex` loop variables would remove three repeated `base + x` expressions from bilinear remapping and two from nearest remapping.

The isolated 1,600×980 paired microbenchmark appeared promising: bilinear medians improved 18.7–19.5% and nearest medians 36.5–64.1%, with exact `Object.is` output. The production worker result contradicted it. Two samples in every A/B/B/A leg on separate warm cache clones produced:

| Revision         | Subprocess samples (ms)                    | Median (ms) |
| ---------------- | ------------------------------------------ | ----------: |
| `base + x` A1+A2 | 10826.307, 10854.230, 10761.030, 10783.875 |   10805.091 |
| Monotonic B1+B2  | 10970.508, 10999.293, 10908.671, 10867.780 |   10939.589 |

The candidate was 1.24% slower at process median and 1.20% slower by sample-sum. More decisively, the 16 main-frame `gridMap` samples regressed from a 407.8 ms median to 443.3 ms (8.71%) and by 7.69% in stage-sum time. The worker's optimization context evidently strength-reduces the compact `base + x` form better than the extra induction variables, despite the standalone result. All 367 artifacts were byte-identical, but review rejected and fully reverted the slower code before the next pass. This pass is a useful warning that renderer-worker evidence, not an isolated V8 microbenchmark, is authoritative.

### Pass 10 — Libdeflate PNG Level 2

Hypothesis: libdeflate level 2 might reduce artifact write bytes enough to offset its extra codec work. The compression helper profile made PNG deflate a plausible high-yield target, while decompressed RGBA pixels would remain exact.

The real-payload benchmark loaded all 83 PNG scanline streams from HRRR F003 (520,657,340 raw bytes), used alternating level order, one warm-up per level, explicit GC between trials, and seven samples. Every candidate stream inflated byte-identically:

| Level |         Median / MAD | Total IDAT bytes | Result vs level 1          |
| ----: | -------------------: | ---------------: | -------------------------- |
|     1 |   927.224 / 9.262 ms |       53,531,814 | baseline                   |
|     2 | 1,516.363 / 5.331 ms |       50,262,207 | 63.5% slower, 6.1% smaller |

The extra 589 ms per dense frame is far larger than the write-time value of 3.27 MB on the local artifact path and would amplify helper saturation. A single large PNG sweep through levels 1, 2, 3, 4, 6, 9, and 12 also confirmed level 1 is the fastest supported libdeflate level; level 0 is invalid. No implementation was retained. Since this was an isolated codec choice and every decoded stream matched, it changes no pixels, values, or scientific behavior.

### Pass 11 — Native-Word RGBA Stores

Hypothesis: scalar rasterization can copy a four-byte palette entry with one aligned native `Uint32` load/store instead of four indexed byte stores. Reading and writing the same native word preserves its underlying byte sequence on little- and big-endian hosts; misaligned or non-four-byte views retain the original byte path.

The implementation covers continuous and step raw/affine/function specializations, continuous and step wind, and reflectivity-gate fan-out. A production-shaped 1,600×980 five-workload microbenchmark improved its median-of-block aggregate `62.406 -> 59.427 ms` (4.77%), with continuous affine 8.69% faster and both step paths about 4–5% faster.

The two-repetition A/B/B/A HRRR process interleave was wall-neutral:

| Revision     | Subprocess samples (ms)                    | Median (ms) |
| ------------ | ------------------------------------------ | ----------: |
| Byte stores  | 11142.842, 11045.558, 10996.276, 11013.836 |   11029.697 |
| Native words | 11067.614, 11078.702, 11012.458, 10919.929 |   11040.036 |

The 0.09% process delta is noise dominated by compression, while the attributed work moved consistently: `catalogPng` stage-sum improved `7,696.4 -> 7,521.6 ms` (2.27%) and `corePng` `818.0 -> 804.9 ms` (1.60%). Review retained the exact, low-complexity stage win because scalar raster loops account for a measured 8% of worker self time and the following pass compounds it. Misalignment differential tests cover all six scalar specializations plus wind and reflectivity gates. All 367 non-completion artifacts were byte-identical across matching 371-file inventories; 135 focused tests passed.

### Pass 12 — Scalar-Loop Invariant Hoists

Hypothesis: visibility finiteness, visible bounds, logarithmic-mode selection, and lookup scale/minimum values are immutable for a layer and should not be re-read or re-tested for every one of its 1.568 million cells.

The candidate hoists those values once in each continuous/step raw, affine, and function specialization and both wind specializations. On top of Pass 11, the same micro aggregate improved `59.376 -> 56.487 ms` (4.87%). A one-sample-per-leg A/B/B/A renderer interleave showed an attributable end-to-end signal:

| Revision      | Subprocess samples (ms) | Median (ms) |
| ------------- | ----------------------- | ----------: |
| Before hoists | 11006.383, 10997.690    |   11002.036 |
| Hoisted       | 10854.488, 10788.934    |   10821.711 |

Process median improved 1.64%, main-frame elapsed sum 1.97%, artifacts sum 2.67%, `catalogPng` `3,778.2 -> 3,437.4 ms` (9.02%), and `corePng` `408.7 -> 392.0 ms` (4.09%); `gridMap` and `compressWait` stayed neutral. Cumulative output remained exact for all 367 artifacts. Root review confirmed the objects are immutable for each render call and the existing visible/lookup selection occurs before these loops, so hoisting cannot change a value, category, threshold, pixel, or scientific result.

### Pass 13 — Scalar Finite Self-Comparison

Hypothesis: replacing `Number.isFinite(value)` with an exact value-self fast path plus infinity guards might reduce call overhead in scalar loops. The implementation retained identical acceptance of finite values and rejection of `NaN`/infinities.

The interleaved five-workload 1,600×980 micro gate regressed from `55.766` to `56.925 ms` at median-of-block aggregate (2.08%). V8 already optimizes the explicit built-in better than the expanded predicate in this context. Per the post-pass review rule, the candidate was reverted before any expensive full renderer run; the stronger local regression made an end-to-end win implausible. Tests on the retained Pass 11/12 code pass, and this rejected pass changes no output or science.

### Pass 14 — Direct Frontogenesis Gradient Norm

Hypothesis: frontogenesis derivatives are finite and many orders below overflow, so `sqrt(dx² + dy²)` can replace `Math.hypot(dx, dy)` and avoid the generic routine's overflow/underflow scaling in a measured derived-grid hotspot.

The benchmark was restarted after Pass 02's concurrent revert and used frozen, clean source snapshots plus isolated warm cache clones. One warm-up per revision preceded two repetitions in every A/B/B/A leg:

| Revision           | Subprocess samples (ms)                    | Median (ms) |
| ------------------ | ------------------------------------------ | ----------: |
| `Math.hypot` A1+A2 | 10677.106, 10650.598, 10669.908, 10643.669 |   10660.253 |
| Direct norm B1+B2  | 10522.606, 10504.895, 10357.951, 10431.851 |   10468.373 |

Subprocess median improved 1.80%. Across the two-run summary legs, median main-frame stage sum improved `19,364.5 -> 18,952.0 ms` (2.13%) and `derivedGrid` improved `1,524.35 -> 1,233.25 ms` (19.09%). The generic ten-million-norm micro gate improved about 94.7% locally, consistent with the attributed stage signal.

Scientific and correctness review deliberately does not claim universal bit identity:

- All 367 real HRRR payload artifacts matched byte-for-byte, so the fixture had zero changed PNG pixels, hover samples, finite/missing states, or threshold classifications.
- More than 10,000 finite full-kernel cells across 300 randomized meteorological fixtures had zero Float32 changes and zero validity changes versus the prior `Math.hypot` implementation.
- A 500,000-case adversarial near-cancellation oracle intentionally found 181,122 changed Float32 results and six sign flips, but every affected value was essentially numerical zero; maximum absolute movement was `3.68e-15 C/100km/3hr`, many orders below a scientifically or visually meaningful signal.
- Derivatives still pass the existing finite and `1e-12` gradient gate. The direct norm cannot overflow or underflow for reachable gridded meteorological magnitudes.

Because legitimate constructed inputs can move at rounding level, renderer completion identity advances from `v50-hover-brotli` to `v51-frontogenesis-direct-norm`; the scientific method version remains unchanged because the Petterssen formula, constants, masks, thresholds, and stored units are unchanged. The new differential suite pins the full-kernel validity contract and the documented near-zero tolerance. The candidate is accepted as the campaign's explicitly permitted meteorologically insignificant numerical pass.

### Pass 15 — Packed Final-Grid Cache Architecture

Hypothesis: the selected-GRIB cache avoids network and range assembly, but a warm frame still rereads the selected binary and repeats wgrib2-bin parsing plus the full JavaScript Web Mercator row remap. Persisting the already remapped Float32 grids should remove that work without changing interpolation, missing-value, provenance, or scientific behavior.

The accepted `mercator-grid-pack-v2` format stores canonical final-grid Float32 bytes plus validated metadata. Its payload identity covers the selected subset, output geometry, interpolation policy, tool/method versions, and complete expected record/interpolation mapping; metadata separately validates the exact present/missing partition. Publication is temporary-file plus atomic rename, invalid/corrupt entries fall back to the existing decode/remap path, and a successful v2 publish replaces obsolete exact v1 siblings. The legacy two-argument memo key remains byte-compatible. Independent review also fixed rejection of a record appearing in both present and missing sets and added the `regridBinPersistMs` profile field.

An isolated real-data audit of all 148 HRRR fields measured the immediate cache operation:

| Operation                                      |       Time | Result                   |
| ---------------------------------------------- | ---------: | ------------------------ |
| Warm v1 binary read, parse, and Mercator remap | 406.935 ms | baseline                 |
| Warm v2 final-grid pack read                   |  64.082 ms | 84.25% faster            |
| Cold v2 pack write                             | 143.494 ms | one-time population cost |

The authoritative four-frame warm renderer comparison used two repetitions in each A/B/B/A leg:

| Revision | Subprocess samples (ms)                    | Median (ms) |
| -------- | ------------------------------------------ | ----------: |
| v1 A1+A2 | 10425.020, 10389.102, 10388.685, 10448.005 |   10407.061 |
| v2 B1+B2 | 9173.633, 9181.826, 9142.918, 9139.947     |    9158.275 |

Wall time improved 12.00%. Two-run `gridMap` sums moved from `3,083.5/3,092.4` to `522.7/513.1 ms` (83.22% at the mean), while corresponding main-frame sums improved about 12.76%. All 367 payload artifacts were byte-identical. The four active HRRR packs occupy 3.540 GiB versus 3.446 GiB for their old v1 siblings, a 96.0 MiB/2.72% active-cache increase; old exact siblings are silently removed only after successful publication. A migration run starting with v1 but no v2 took 32.790 s and is retained as a conservative one-time upper bound rather than a warm comparison. The implementer and independent reviewer ran 145 focused tests, including corrupt/truncated metadata, roster identity, atomicity, successful legacy-sibling cleanup, missing records, and legacy memo behavior. Root review accepts the architecture because the large repeatable warm win materially exceeds its bounded disk and one-time migration costs, with exact output and safe fallback.

### Pass 16 — Exact Masked-Smoothing SIMD

Hypothesis: presentation smoothing repeatedly applies the same masked three-point stencil over 1.568 million-cell grids. The parcel-kernel WebAssembly module can process two independent interior values with `f64x2` while retaining the scalar path for boundaries, tails, masks, and non-finite lanes.

The implementation changes only execution width. It preserves the scalar operation order inside each lane, writes identical Float64 values, and retains the existing input/output memory contract. The rebuilt module SHA-256 is `74fc2d54…` (prior `61ae…`). Independent review exercised 8,393 adversarial cases across odd/even and tiny lengths, randomized masks, `NaN`, infinities, signed zero, alias guards, memory sentinels, and deterministic rebuilds; every result matched with `Object.is`. The focused renderer/kernel suite passed 143 tests.

The independent production-sized microbenchmark reported:

| Workload           | Scalar median | SIMD median | Result        |
| ------------------ | ------------: | ----------: | ------------- |
| Terrain-style mask |     27.218 ms |   19.326 ms | 29.00% faster |
| Sparse mask        |     38.295 ms |   19.506 ms | 49.06% faster |
| All finite         |       neutral |     neutral | no regression |

After discarding an ENOSPC-contaminated attempt and rebuilding two warm cache clones, the renderer A/B/B/A comparison produced:

| Revision     | Subprocess samples (ms)                | Median (ms) |
| ------------ | -------------------------------------- | ----------: |
| Scalar A1+A2 | 9589.466, 9375.074, 9387.214, 9417.118 |    9402.166 |
| SIMD B1+B2   | 9519.328, 9187.053, 9181.097, 9239.104 |    9213.078 |

The first SIMD sample included several precipitation-cache misses after cache duplication; retaining it is conservative. Even so, subprocess median improved 2.01%. Two-run-summary mean `catalogPng` time improved `1,734.225 -> 1,616.450 ms` (6.79%) and artifact time improved `6,799.675 -> 6,641.900 ms` (2.32%). The 367 payload files outside runtime completion markers and generated manifests matched byte-for-byte. No meteorological grid, missing state, category, threshold, pixel, hover sample, cache identity, or scientific value changes.

### Pass 17 — Brotli Uncompressed-Size Hint

Hypothesis: setting `BROTLI_PARAM_SIZE_HINT` might let the q0 encoder avoid size discovery or choose a faster internal allocation strategy for very large hover buffers.

The experiment used Node 22.23.1, real HRRR F000-F003 raw MVH3 payloads, and interleaved q0 calls with and without the exact input length. Eight samples per arm per frame produced:

| Frame |   Raw bytes | Plain median | Hint median |   Delta |
| ----- | ----------: | -----------: | ----------: | ------: |
| F000  | 188,165,868 |   195.134 ms |  194.855 ms | -0.143% |
| F001  | 225,799,044 |   213.004 ms |  212.715 ms | -0.136% |
| F002  | 225,799,044 |   213.993 ms |  214.007 ms | +0.007% |
| F003  | 225,799,044 |   215.238 ms |  215.480 ms | +0.112% |

The frame-median sum moved only `837.369 -> 837.057 ms` (-0.037%); pooled medians moved `213.826 -> 213.503 ms` (-0.151%), well inside the roughly 2 ms MAD. A separate 20-sample-per-arm F003 repeat reversed direction (`215.992 -> 216.067 ms`, +0.035%; paired median +0.235 ms). Every hinted stream had the exact same length and SHA-256 as its unhinted counterpart and decompressed byte-identically. The 17 codec/pool tests pass. Review concludes that the one-shot Brotli API already knows the complete buffer length, so the explicit hint supplies no repeatable timing, size, memory, or correctness benefit. No production change is retained.

### Pass 18 — Fused Hover Quantization and Delta Encoding

Hypothesis: schema-v3 hover generation quantizes every field into an Int16 buffer and later copies the complete 188–226 MB data region into a second WebAssembly port and back solely to apply exact wrapping deltas. Delta-encoding each quantizer chunk while its output is hot should remove that full round trip; one first-residue adjustment per variable can preserve the existing global carry across concatenated fields.

The accepted path is opt-in only for binary schema-v3 artifacts and only when the exact WASM delta port is active. Each variable is fused from a zero carry, records its final absolute Int16 value, and is copied normally. The packer subtracts the preceding variable's final value from only the new variable's first residue, yielding the exact prior global stream. JSON and public default quantizer APIs remain absolute; mixed absolute/pre-delta payloads, invalid carries, pre-v3 use, and pre-delta JSON input fail closed. Pure-JavaScript operation retains the prior one-pass global delta path, while function/non-Float32 transforms use the chunked exact WASM region port when available.

Independent hostile review found and fixed three issues before acceptance:

1. The shared delta helper inherited the 65,536-element delta-buffer cap when invoked on the 32,768-element quantizer output. Production passed at most 32,768, but an oversized direct call could corrupt adjacent WASM state. The helper now receives the pointer-specific capacity and a guard test probes the boundary.
2. JSON entry points could accept pre-delta variables and serialize residues as absolute values. Both direct and artifact JSON paths now reject them.
3. Non-Float32/function-transform fallbacks initially used a JavaScript delta pass. Routing those exact bodies through the existing chunked WASM port improved the raw fallback 5.47% and function path 2.69% relative to the old pack path.

The post-review benchmark used 72 production-shaped 1,600×980 planes (48 raw, 16 affine, 8 wind), five warm-ups, and 15 alternating samples per arm. The packed data region is 225,792,000 bytes:

| Stage                                     |  Prior median |     Fused median | Result                  |
| ----------------------------------------- | ------------: | ---------------: | ----------------------- |
| Quantize, including fused candidate delta |      75.17 ms |      about 78 ms | small expected increase |
| Separate full-region delta                | about 20.9 ms | effectively zero | removed                 |
| Total quantize/pack/delta                 |    100.834 ms |        82.872 ms | 17.81% faster           |

Both arms produced the exact same complete raw SHA-256 and the real compression-worker output compared byte-for-byte. A separate post-fix run measured `99.532 -> 82.291 ms` (-17.32%), and the kernel-disabled path was neutral (`8.933 -> 8.916 ms`, -0.19% noise) after the review gate. The new test suite covers raw, affine, function transform, wind, multiple WASM chunks, short tails, empty planes, sentinels, saturation, infinities, cross-variable wraparound, mixed-mode rejection, JSON safety, fallback, worker compression, memory guards, and deterministic rebuilds. Post-fix validation passed 924/924 Node tests, TypeScript, error-level ESLint, and 164/164 React browser smoke tests. This exact plumbing pass changes no quantized sample, missing sentinel, diagnostic count, wire byte, compressed body, pixel, threshold, meteorological value, or scientific interpretation.

### Pass 19 — Supplemental Derived-Grid Sidecar Architecture

Hypothesis: Pass 15 removes warm GRIB remapping, but every render still recomputes raw surface LCL, surface theta-e, and two full-grid frontogenesis diagnostics. A separate exact sidecar keyed to the final main grids can skip that work without coupling its method lifecycle to the existing, larger profile-derived cache.

The architecture stores four canonical Float32 grids—`surfaceBasedLclHeight`, `surfaceThetaE`, `frontogenesis850`, and `frontogenesis700`—and deliberately excludes the two presentation-smoothed grids: another 12.544 MB/frame would save only about 10 ms. Identity covers the selected-GRIB body, sorted v2 regrid payload hashes, native byte order, cell count, catalog version, complete product roster, and explicit catalog method/kernel tokens. The reader requires exact byte length and SHA-256 and restores zero-copy typed views; the writer requires the complete canonical roster and correct Float32 shapes, holds a stale-recoverable cross-process lock, writes a unique temporary body and metadata, publishes metadata last, cleans temporary/final orphans after failure, and fails open to normal computation. Cross-review replaced an initially vague composite method string with the exact catalog LCL/theta-e/frontogenesis method identities plus the direct-norm kernel token.

The isolated HRRR F000–F003 comparison used identical Pass 18 sources and cloned warm caches. Three independent samples per arm were interleaved A/B/B/A plus A/B:

| Measurement          | Baseline samples (ms)        | Cached samples (ms)          | Mean result                  |
| -------------------- | ---------------------------- | ---------------------------- | ---------------------------- |
| Subprocess wall      | 8983.826, 9156.573, 8965.749 | 8513.240, 8640.234, 8478.328 | 9035.383 → 8543.934 (-5.44%) |
| Main-frame wall sum  | 8046.6, 8090.6, 7973.7       | 7592.6, 7705.0, 7505.6       | 8036.967 → 7601.067 (-5.42%) |
| Decode sum           | 1065.4, 1074.1, 1069.0       | 655.5, 687.3, 663.2          | 1069.5 → 668.667 (-37.48%)   |
| Derived-grid sum     | 626.7, 617.9, 614.5          | 182.1, 185.9, 178.7          | 619.7 → 182.233 (-70.59%)    |
| Artifact sum control | 6410.6, 6462.2, 6332.1       | 6396.4, 6454.7, 6289.8       | -0.33% (noise)               |

Every warm candidate run recorded four of four supplemental-cache hits and zero process/frame failures. A paired cold population run was neutral: subprocess `9,225.040 -> 9,200.373 ms` (-0.27%) and main wall `8,239.0 -> 8,211.8 ms` (-0.33%); asynchronous writes are drained safely at completion. Each sidecar body is exactly 25,088,000 bytes (23.9258 MiB). Four frames add 100,354,588 bytes including metadata (95.7056 MiB).

Parity covered both 373-file artifact trees. All 367 payloads—332 PNGs, 28 vector JSON files, and seven Brotli hover bodies—were byte-identical. The run/latest manifests and four completion markers became recursively identical after removing only `generatedAt`, `renderedAt`, and `renderProfile`. The independent post-fix F000 rerun confirmed subprocess `2,617.371 -> 2,513.731 ms` (-3.96%), frame wall `1,917.1 -> 1,823.8 ms` (-4.87%), and `derivedGrid 166.1 -> 57.3 ms` (-65.50%), with exact payload trees and one of one cache hits. The focused architecture/renderer review suite passed 212 tests, and the combined full validation passed 924 Node and 164 browser tests. The warm gain, exact output, neutral cold path, bounded disk cost, checksummed atomic fallback, and independent implementer/reviewer satisfy the campaign's large-architecture gate.

### Pass 20 — Whole-Pack Read with Zero-Copy Views

Hypothesis: Pass 15's warm v2 cache reader could replace 152 sequential 6,272,000-byte reads and Float32 allocations with one 953,344,000-byte `readFile` and zero-copy typed-array views, reducing syscall/allocation overhead while retaining the same resident payload size.

The real HRRR F003 `mercator-grid-pack-v2` was page-cache warm. After one warm-up per method, six samples per arm alternated order and forced garbage collection before each measurement:

| Method                                | Samples (ms)                                   | Median (ms) |
| ------------------------------------- | ---------------------------------------------- | ----------: |
| Current sequential typed-array slices | 42.222, 41.410, 41.069, 42.676, 42.915, 42.767 |      42.449 |
| Whole-file read plus views            | 61.388, 60.377, 61.368, 61.844, 59.758, 60.450 |      60.909 |

The candidate regressed 43.49%. Node's very-large `readFile` implementation outweighed the saved per-field calls, while retaining one nearly-gigabyte backing store also couples every field's lifetime. Correctness was not ambiguous: hashing the direct whole body and the 152 validated slices in metadata order produced the same SHA-256, `f0c8d9e4f0436759b554e823407e2ddd214974004dba982a651234698652d12e`, across all 953,344,000 bytes. Review rejected the design at the real-cache gate; no code, allocation behavior, cache format, output, or scientific value changed.
