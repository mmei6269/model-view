# Renderer Exact-Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the 2026-07-11 renderer-optimization audit: Tier 1 (derived-grid disk cache, DCAPE exact restructure, gated WASM parcel-kernel attempt), all Tier 2 redundancy fixes, and opt-in intra-frame parallelism — every change byte-identical on golden frames.

**Architecture:** All compute changes are exact restructures (identical operation order, guards, and NaN semantics) or pure memoization/caching of deterministic values; the two new subsystems (derived-grid cache, WASM kernel) are validated by construction (cache stores exact Float32 outputs) and by bit-parity fuzzing plus golden-frame comparison. Every task gates on the golden-frame parity harness before commit.

**Tech Stack:** Node 22 (worker_threads, SharedArrayBuffer), existing cache-io conventions (tmp+rename, hash-first metadata), AssemblyScript → WASM for the parcel kernel (fdlibm-exact transcendentals).

## Global Constraints

- Byte-for-byte artifact parity on all four golden frames (gfs 20260711-12Z F009, nam 18Z F003, nam3km 18Z F003, hrrr 20Z F003); only the dot-file `.complete.json` may differ (timestamps/profile).
- No formula, threshold, step-size, level-set, or gating change; no heuristic skips that change stored hover/PNG values.
- Meteorological/scientific accuracy untouchable; rounding-level deviation allowed only for provably-identical-formula reassociations and must be flagged (none planned).
- Parity harness: `$SCRATCH/parity.sh` (rebuilds the four pinned frames with `--force` against the warm cache, `cmp`s every artifact vs `$SCRATCH/golden/*`).
- Validation suite before PR: `node --test tests-node/noaa-beta.test.js`, `npm run typecheck`, `npm run lint -- --quiet`, Prettier on touched files, `git diff --check`.
- Benchmarks: interleaved serial HRRR F003 warm builds (flags: `--force --profile --total-frame-concurrency=1 --frame-concurrency=1 --worker-count=1 --decode-concurrency=1 --range-concurrency=1 --total-range-concurrency=1`), stage sums via `output/noaa-benchmarks/parse-profile-log.js`.
- Results and rejected experiments go to `docs/noaa-renderer-benchmark-history.md`; operational flags to `plan.md`.

---

### Task 1: Parcel micro-trio (measured reference port)

**Files:**
- Modify: `scripts/lib/noaa-beta/severe.js` (~798-935: `calculateParcelCapeCinFromRows`, `calculateSegmentParcelCapeCinForSource`; ~365-375: per-cell re-screen)
- Test: existing `tests-node/noaa-beta.test.js` (severe parity tests) + parity harness

**Interfaces:**
- Produces: `calculateSegmentParcelCapeCinForSourceValues(scratch, rowCount, sourcePressure, sourceHeight, sourceTemp, rawSourceDewpoint, startRow)` — internal; existing exported `calculateSegmentParcelCapeCinForSource(scratch, rowCount, source)` becomes a thin wrapper with `startRow=1`.

- [ ] Port the three verified edits from the session scratch tree (`$SCRATCH/ab-tree/scripts/lib/noaa-beta/severe.js`): (1) `calculateParcelCapeCinFromRows` passes positional values + `startRow = sourceRow + 1` instead of allocating a `source` object (pressure-step path keeps the object); (2) segment loop starts at `startRow` (rows at/below origin always fail the mid-height/mid-pressure guards — comment this invariant); (3) the per-cell SCP/STP re-screen reads `mucape/mlcape/mlcin/sbcape` once via fused logic replicating `hasEffectiveDiagnosticsCandidateCape({needsScp:true})` and `({needsStp:true})` exactly.
- [ ] `node --check`, run `node --test tests-node/noaa-beta.test.js`.
- [ ] Run parity harness → 0 diffs on all four frames.
- [ ] Commit: `perf(severe): exact parcel-scan micro-restructures (origin-row start, no per-origin alloc, fused re-screen)`

### Task 2: DCAPE v4 exact restructure

**Files:**
- Modify: `scripts/lib/noaa-beta/severe.js` (~1605-1815: `calculateReducedProfileDcapeFromSources`)

**Interfaces:**
- Produces: module-level `interpolateDcapeKnotThermoInto(sample, knotHeights, knotTemps, knotPressures, knotDewpoints, knotCount, pressureHpa)` and `dcapeThetaEAtPressure(...)`; per-cell closures removed; interpolation sample reused via `scratch.knotSample`.

- [ ] Hoist both per-cell closures to module functions taking explicit knot arrays; reuse one `{tempK, dewpointK, heightM}` sample object per scratch (write-before-read per call; no interpolation call intervenes between the final source sample's write and its reads — preserve that invariant with a comment).
- [ ] Identical float ops and early-return structure; `node --check` + full test run.
- [ ] Parity harness → 0 diffs.
- [ ] Commit: `perf(severe): hoist DCAPE per-cell closures and interpolation sample`

### Task 3: Raster/hover shared source grids + below-terrain mask cache

**Files:**
- Modify: `scripts/lib/noaa-beta/raster.js` (`resolveCatalogSourceGrid` :1057, `maskPressureLevelGridBelowTerrain` :1090, `renderCatalogParameterLayer` :1007)
- Modify: `scripts/lib/noaa-beta/hover.js` (`buildHoverGridVariables` :30/:126)
- Modify: `scripts/lib/noaa-beta-renderer.js` (`buildRenderedArtifacts` :728 — create shared caches; frontogenesis/vorticity call sites :1329/:1337/:1511-1514; wind/height caches :1895/:1909)

**Interfaces:**
- Produces: `resolveCatalogSourceGrid(entry, decoded, width, height, modelKey, sourceGridCache?)` — a `Map` keyed by `entry.key` shared by the PNG and hover passes; `maskPressureLevelGridBelowTerrain(values, surfaceHeights, pressureHeights, width, height, maskCache?, maskKey?)` — optional per-frame `Map` of level → below-terrain evaluation reuse. Cache lookups must return the identical Float32Array reference the PNG pass computed.

- [ ] Add `catalogSourceGridCache = new Map()` in `buildRenderedArtifacts`, thread through `renderCatalogParameterLayer` and `buildHoverGridVariables`.
- [ ] Add per-level below-terrain mask reuse (Uint8Array of the boolean condition) so N variables at one level evaluate the condition once; masked output arrays still allocated per variable (values differ), bytes unchanged.
- [ ] Parity harness → 0 diffs. Commit: `perf(raster): share catalog source grids between PNG and hover; per-level terrain mask reuse`

### Task 4: grib-source warm-path memos

**Files:**
- Modify: `scripts/lib/noaa-beta/grib-source.js` (readCachedSelectedGribPath :717-746, regrid-bin context/read :1762-1830, bulk-decode inventory/index :1896-2120, run-local stores :2582-2630)
- Modify: `scripts/lib/noaa-beta-renderer.js` :362-365 (idx parse)
- Modify: `scripts/lib/noaa-beta/cache-io.js` :97-106 (payload-hash reuse)
- Modify: `scripts/lib/noaa-beta/forecast-hour-roster.js` :194-220 (roster identity memo)

**Interfaces:**
- Produces (all run-local, bounded, keyed under the existing `RUN_LOCAL_CACHE_STORES` entry or module-bounded Maps): `verifiedSelectedGribs: Map<cachePath, {size, sha256}>`; `selectedGribMetadataCache: Map<gribPath, metadata>`; parsed-idx reuse for the renderer via the existing `NOAA_INDEX_RECORD_CACHE`; `regridBinDecodePlanCache: Map<payloadHash, {inventory, index-template}>` with per-frame non-destructive consumption; `resolveBoundedForecastHourRosterIdentity` memo keyed by `(modelKey, tier, targetHour, hoursIdentity)` string instead of the per-frame context WeakMap; `cacheMetadataPayloadMatches(metadata, expectedPayload, precomputedHash?)`.

- [ ] Selected-GRIB verification memo: first read per (run, path) stats + full-SHA-verifies as today, then records; subsequent frame reads trust the memo (files are tmp+rename immutable per build). Invalidate entry if a later stat size mismatches.
- [ ] Sidecar metadata memo shared by `readCachedSelectedGribPath`, `registerSelectedGribProvenance`, `resolveRegriddedBinCacheContextUncached`.
- [ ] Renderer idx parse: route through the cached parsed-records path (same parse options), keyed by idx URL + text identity.
- [ ] Regrid-bin hit path: memoize parsed wgrib simple inventory + record index per payloadHash; consumers get a fresh cheap index view per frame (used-record tracking stays per frame).
- [ ] Roster identity: run-level memo; keep `BOUNDED_ROSTER_IDENTITY_CACHE` semantics for in-frame hits.
- [ ] `cacheMetadataPayloadMatches` accepts the caller's precomputed `payloadHash` (regrid-bin caller already holds it).
- [ ] Parity harness → 0 diffs; `node --test`. Commit: `perf(grib-source): run-level memos for selected-GRIB verification, sidecars, idx parse, regrid-bin plans, roster identity`

### Task 5: Provenance assembly de-duplication

**Files:**
- Modify: `scripts/lib/noaa-beta/source-provenance.js` (:45, :55-67, :133-134, :176-218)
- Modify: `scripts/lib/local-artifact-manifest.js` :393, `scripts/lib/local-artifact-runtime.js` :615/:758/:782

**Interfaces:**
- Produces: `normalizeFrameSourceProvenance` stamps a non-enumerable `Symbol` marker and returns already-normalized inputs unchanged; `mergeFrameSourceProvenance` fast-paths null/marked inputs; `summarizeSelectedRecords` computed lazily only in the no-hashed-source fallback; `expectedTemporalOutputKeys` memoized per selection object (WeakMap).

- [ ] Implement the marker + fast paths (output objects byte-identical when serialized: same key order as today — the marker is non-enumerable so JSON output is unchanged).
- [ ] Parity harness (frame + marker artifacts) → 0 diffs on artifacts; `.complete.json` provenance sections must remain deep-equal (verify once with `jq`-normalized diff).
- [ ] Commit: `perf(provenance): normalize-once marking, lazy selected-record summaries, memoized temporal keys`

### Task 6: Worker run-metadata hydration

**Files:**
- Modify: `scripts/lib/local-artifact-concurrency.js` (:110-135 postMessage payload)
- Modify: `scripts/noaa-beta-frame-worker.js` (message handler)
- Modify: `scripts/lib/local-artifact-runtime.js` (:588 payload assembly)

**Interfaces:**
- Produces: frame payloads carry `latestMetadataRef: {key, metadata?}` — `key` is `modelKey:runId:view` plus a monotonically-increasing metadata revision; the first task per key ships the metadata, workers cache the last 8 by key; on cache miss the worker replies `need-metadata` → coordinator resends (or: coordinator tracks which workers have which key and ships metadata proactively — pick the simpler deterministic option: per-worker sent-keys set on the coordinator).
- [ ] Implement coordinator-side per-worker sent-keys tracking (no round trips); reset on worker respawn.
- [ ] Full 4-model build (`npm run noaa:build:test -- --frames=2`) completes; parity harness → 0 diffs; kill-a-worker path exercised by existing tests.
- [ ] Commit: `perf(workers): hydrate run-constant metadata once per worker instead of per frame`

### Task 7: Derived-grid disk cache (Tier 1.1)

**Files:**
- Create: `scripts/lib/noaa-beta/derived-grid-cache.js`
- Modify: `scripts/lib/noaa-beta/severe.js` (export `DERIVED_PROFILE_METHODOLOGY_VERSION`)
- Modify: `scripts/lib/noaa-beta-renderer.js` :656-669 (call site becomes cache-aware), plumbing for `decodeSession` regrid-bin payload hash
- Test: new cases in `tests-node/noaa-beta.test.js` (roundtrip, key mismatch → miss, corrupted bin → miss)

**Interfaces:**
- Produces: `readDerivedGridCache({dir, payloadKey, products, cellCount}) → {grids: {name: Float32Array}} | null` and `writeDerivedGridCache({dir, payloadKey, grids})`; payloadKey = SHA-256 over `{regridBinPayloadHash, DERIVED_PROFILE_METHODOLOGY_VERSION, CATALOG_VERSION, sorted productList, width, height}`. Storage next to the selected GRIB (same dir as the regrid bin): `<selected>.derived-<hash>.bin` + `.json` metadata (tmp+rename, hash-first validation via cache-io helpers). Only the `buildProfileDerivedGrids` outputs are cached (lapse/bulk/effective/dcape/effectiveLayerScp/effectiveLayerStp and prototype grids when active); the cheap non-profile derived grids always recompute.
- [ ] On hit: skip `buildProfileDerivedGrids` entirely, mark `profile.derivedGridCache = "hit"`; grids restored as exact Float32 bytes. On miss: compute, then persist (await, with lock, mirroring regrid-bin write discipline).
- [ ] Guard: cache disabled when the frame's regrid-bin payload hash is unavailable (cold wgrib2 path without bin context) — compute as today.
- [ ] Tests: roundtrip byte-equality incl. NaN patterns; parity harness twice (first run populates, second hits) → 0 diffs both times; verify hit-run `derivedGrid` stage collapses.
- [ ] Commit: `perf(renderer): derived-grid disk cache for profile-derived severe products`

### Task 8: Intra-frame parallelism (opt-in)

**Files:**
- Create: `scripts/noaa-beta-derived-worker.js`
- Modify: `scripts/lib/noaa-beta/severe.js` (range refactor: `buildProfileDerivedGridsRange`)
- Modify: `scripts/lib/noaa-beta-renderer.js`, `scripts/build-noaa-beta-artifacts.js` (flag `--derived-cell-concurrency=N`, default 1)

**Interfaces:**
- Produces: `buildProfileDerivedGrids` keeps its signature and calls `buildProfileDerivedGridsRange(inputs, startIndex, endIndex, outputs)` (serial = one full-range call — same code path). Parallel path: coordinator copies the enumerated input grids into one SharedArrayBuffer, spawns/reuses a per-render-worker sub-pool, each sub-worker computes a disjoint `[start,end)` range into SAB-backed outputs, coordinator copies outputs to fresh Float32Arrays. Per-cell computation is fully independent (per-cell scratch, no cross-cell state) → partitioning cannot change values.
- [ ] Parity: build HRRR F003 with `--derived-cell-concurrency=1` and `=4`, byte-compare all artifacts → identical; parity harness → 0 diffs.
- [ ] Benchmark single-frame wall time serial vs 4-way; record in benchmark history.
- [ ] Commit: `perf(renderer): opt-in intra-frame parallelism for profile-derived grids`

### Task 9: WASM parcel kernel (gated attempt; relaxed tolerance per owner)

**Owner ruling (2026-07-11):** bit perfection is NOT required for the WASM kernel. Scientifically-valid, negligible numeric shifts are acceptable; the shift must be measured and documented. Everything else in this plan stays byte-exact.

**Files:**
- Create: `tools/parcel-kernel/assembly/*.ts` (AssemblyScript origin-scan kernel using AS NativeMath — musl-derived, ≤1-ulp exp/log/pow), build script, committed `.wasm`
- Create: `scripts/lib/noaa-beta/parcel-kernel.js` (loader; `MODELVIEW_PARCEL_KERNEL=wasm|js`, default `js`)
- Modify: `scripts/lib/noaa-beta/severe.js` (scratch arrays become wasm-memory views when kernel active; `calculateEffectiveParcelLayerFromRows` delegates the origin scan to the kernel)
- Test: `tests-node/parcel-kernel-parity.test.js` (kernel-vs-JS parcel results over randomized profiles: assert tight numeric tolerance, e.g. |Δ| ≤ 1e-6 J/kg CAPE-scale and ≤ 1e-6 m height-scale, and identical null/NaN classification)

**Interfaces:**
- Produces: `loadParcelKernel() → {memory, scratchViews, runOriginScan(rowCount, ...constants)} | null`; JS fallback always present and default; kernel writes `{baseAglM, topAglM, muCapeJkg, muCinJkg, muElAglM}` to fixed memory slots.
- [ ] Implement the origin scan (segment prep + per-origin segment parcel integration) as a faithful port — same formulas, guards, and operation order; transcendentals via AS NativeMath (documented source of the shift).
- [ ] Shift documentation gate: run a real HRRR frame with kernel on vs off and record per-product max abs/rel grid deltas, count of PNG pixels whose rendered color changes, and count of hover Int16 cells that shift by ±1 — publish in benchmark history; any non-negligible or scientifically meaningful deviation → kernel stays default-off with findings documented.
- [ ] Interleaved serial HRRR benchmark js vs wasm; record honestly (including a null/negative result).
- [ ] Commit: `feat(severe): gated WASM parcel kernel (NativeMath transcendentals, default off, shift documented)`

### Task 10: Docs, validation suite, benchmarks, PR

- [ ] Update `docs/noaa-renderer-benchmark-history.md` (new section: 2026-07-11 pass — measurements per task, A/B logs) and `plan.md` (new flags: derived cache behavior, `--derived-cell-concurrency`, `MODELVIEW_PARCEL_KERNEL`).
- [ ] Full validation: `node --test tests-node/noaa-beta.test.js`, `npm run typecheck`, `npm run lint -- --quiet`, Prettier on touched files, `git diff --check`, final parity harness, final interleaved benchmark.
- [ ] superpowers:verification-before-completion, then /code-review on the branch diff; fix findings; re-verify.
- [ ] Push branch, open PR to `master` with measurements and parity evidence.
