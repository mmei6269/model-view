# Model View

Weather model comparison UI backed by the native NOAA GRIB2 renderer.

## Canonical Paths

- React UI: `/Users/micha/Development/model-view/next/src`
- Local data server: `/Users/micha/Development/model-view/scripts/local-data-server.js`
- NOAA artifact builder: `/Users/micha/Development/model-view/scripts/build-noaa-beta-artifacts.js`
- NOAA renderer (frame orchestration facade): `/Users/micha/Development/model-view/scripts/lib/noaa-beta-renderer.js`
- NOAA renderer domain modules: `/Users/micha/Development/model-view/scripts/lib/noaa-beta/` — `util`/`cache-io` (helpers, cache plumbing, locks), `thermo` (thermodynamic math), `model-config` (model identities/URLs), `records`/`selection` (record parsing and catalog selection), `grib-source` (.idx fetch, selected-GRIB materialization, regrid cache, decode sessions), `grid-ops` (binary decode, Mercator remap, stats, smoothing), `profile-access`/`profile-wind` (grid readers, interpolators, winds), `severe` (parcel pipeline, SCP/STP/DCAPE), `accumulation` (precip/run-max), `slr-methods`/`winter` (snowfall, freezing rain, FRAM), `raster` (scalar/color rendering), `hover` (hover grids), `point-sounding` (Skew-T payloads)
- Shared renderer/catalog config: `/Users/micha/Development/model-view/scripts/lib/noaa-nam-parameter-catalog.js`
- Shared app schema/config: `/Users/micha/Development/model-view/shared/modelview-config.json`

## AI Session Memory (`plan.md`)

Use `/Users/micha/Development/model-view/plan.md` as the AI session mental map and durable handoff memory.

- At the start of each AI session, read `plan.md` before making changes.
- Keep `plan.md` updated with the current objective, checklist, durable decisions, and validation results; put detailed optimization logs/backlogs in `docs/noaa-renderer-benchmark-history.md`.
- When a task is done, clear task-specific noise and preserve durable decisions unless the user explicitly changes them.

## Documentation Index

- `plan.md` - active NOAA renderer plan and durable decisions.
- `docs/migration-checklist.md` - MacBook migration and local setup guide.
- `docs/noaa-beta-implemented-products.md` - NOAA product coverage and rendering behavior notes.
- `docs/noaa-beta-validation-log.md` - NOAA renderer validation notes.
- `docs/noaa-renderer-benchmark-history.md` - renderer benchmark fixtures, optimization history, and active optimization backlog.
- `docs/methodology-audit-2026-05-23.md` - scientific/methodology audit record with corrections and disclosed limitations.
- `docs/methodology-audit-2026-06-11.md` - per-parameter accuracy audit of all 79 catalog parameters with reported compute-bound items.
- `docs/meteorological-scientific-audit-2026-07-10.md` - current end-to-end meteorological, provenance, performance, and analyst-value audit.
- `docs/point-sounding-audit-2026-06-11.md` - point-sounding accuracy audit against SHARPpy-style reference with corrections and verified-match table.
- `tools/noaa-beta/snow-rf/utahrfslr/README.md` - upstream notes for vendored snow-to-liquid-ratio tooling.

## Quick Start

Prerequisite: install `wgrib2` and put it on `PATH`, or set `WGRIB2=/absolute/path/to/wgrib2` in `.env` — NOAA artifact builds require it. Builds also fall back to a local `output/noaa-beta-tools/bin/wgrib2` install when present.

```bash
npm install
npx playwright install chromium
npm run noaa:build:test
npm run dev -- --host 127.0.0.1 --port 5173
```

Open: `http://127.0.0.1:5173`

### Basemap setup

The map is MapLibre GL over a locally served Protomaps vector basemap; panels need `output/basemap/na.pmtiles` to render a map at all.

```bash
brew install pmtiles   # go-pmtiles CLI (or a release from github.com/protomaps/go-pmtiles)
npm run basemap:fetch  # North America extract -> output/basemap/na.pmtiles (~8-12 GB download)
```

`npm run basemap:fetch` discovers the newest Protomaps daily planet build and extracts North America (incl. Alaska/Hawaii/Central America) at full z14 tile depth into `output/basemap/na.pmtiles` (gitignored). The artifact server serves it over an HTTP Range route, so after the one-time download the whole app — basemap tiles, place labels, roads — runs fully offline.

React specs never touch the real extract: they route a small committed CONUS z0–5 fixture (`tests-react/fixtures/basemap-fixture.pmtiles`, regenerated from the local NA file via `node scripts/prepare-basemap.js --fixture`), so CI needs no network and no multi-GB download.

Default local runtime behavior:

- serves prebuilt NOAA GRIB2 artifacts from `output/noaa-beta-cache`
- uses NOAA S3 byte-range reads from `.idx` inventories during builds
- supports `gfs`, `nam`, `nam3km`, and `hrrr`
- does not render on page request; run a build first when manifests are missing

### Daily Flow

```bash
npm run noaa:update
npm run cache:prune
```

`npm run noaa:update` resolves the latest available run for each model, builds only missing frames in each model's configured default tier (including NAM F000-F036 and three-hourly GFS), then prunes stale runs automatically (pass `--no-prune` to skip the prune step). `npm run cache:prune` also runs standalone: it keeps the newest 4 rendered runs per model, keeps only the latest run's raw GRIB inputs, and enforces the optional `MODELVIEW_CACHE_BUDGET_GB` ceiling by deleting the oldest prunable runs first — the newest run per model is never deleted.

### In-App Operations

The header's Render menu is a full control surface over the local pipeline (all served by `/actions/*` on the data server, localhost-origin guarded):

- **Selective builds**: models, per-model runs (multi-select queues one chained build per run, newest first), 7 category toggles with severe/winter simple-vs-full tiers.
- **Frames cap**: model default/published prefix, first 24 h, first 48 h, custom `maxHour`, or an applicable official horizon. Prefix-only by design so run-cumulative products stay byte-identical to the same hours in a larger build (`--max-hour` on the builder).
- **Tuning**: auto (CPU-sized), the production preset (18 workers · 24 frame queue · 3 range reads · 2 decode slots), or custom bounded values (`--worker-count`, `--total-frame-concurrency`, `--range-concurrency`, `--decode-concurrency` per request).
- **Job control**: per-job Cancel (`POST /actions/cancel/:jobId`, queued jobs cancel instantly, running jobs SIGTERM to a `canceled` status) and dismissible terminal rows; outcomes surface as global toasts.
- **Disk cache**: live size stats (`GET /actions/cache-stats`, 60 s TTL), preview-then-confirm retention prune (`POST /actions/cache/prune`, dry-run by default), and a typed-CLEAR full clear (`POST /actions/cache/clear`). Cache mutations refuse while any job is active.

Comparison features: up to 4 map panels (2×2), cross-panel hover mirroring with per-layer Δ readouts, a sounding Compare picker that overlays a second model's profile on one Skew-T/hodograph with an A/B index table, and sounding PNG export/copy. The URL carries the full app state (`?p1..p4`, `?c=lat,lon,zoom`, `?tl`, `?hour`, `?view`) — the header Share button copies it.

Useful local commands:

```bash
npm run noaa:build -- --hours=0,3,6 --view=conus
npm run noaa:build:full
npm run noaa:build:test
npm run noaa:data
npm run dev
npm run dev:vite
npm run cache:clear
```

`npm run dev` and `npm run local:dev` both start the full local stack: the artifact server on
`127.0.0.1:5174` plus Vite on `127.0.0.1:5173`. Use `npm run dev:vite` only when the artifact server is already running.

`npm run noaa:build:full` renders the latest available run plus the previous available run for GFS, NAM, NAM 3km, and HRRR with the current full-product/default-cadence settings: `conus`, configured model tier, forced frame render, profiling enabled, 18 render workers, a 48-slot global frame queue, 3 range reads per worker, 2 decode slots per worker, and the persist queue disabled. Opt into official NAM or hourly-through-F120 GFS cadence explicitly.

`npm run noaa:build:test` uses the same render settings for one recent run, but renders only the first 18 native forecast frames per model so iteration still exercises every NOAA model without a full run.

NOAA render command modifiers:

```bash
npm run noaa:build:full -- --runs=3
npm run noaa:build:full -- --models=hrrr,nam3km
npm run noaa:build:test -- --frames=6
npm run noaa:build:test -- --models=hrrr
npm run noaa:build:test -- --worker-count=8 --total-frame-concurrency=8
npm run noaa:build -- --models=hrrr --hours=0,1,2,3 --view=conus --force --profile
npm run noaa:build -- --models=gfs --full --gfs-hourly-through-120
npm run noaa:build -- --models=hrrr,nam3km --science-prototypes=camDcape21Level,effectiveStp100mbReduced,rowAwareCenterValidation
```

GFS remains on the 129-frame, three-hourly F000-F384 default. The explicit
`--gfs-hourly-through-120` tier follows the published 0.25-degree cadence:
hourly F000-F120, then every three hours F123-F384 (209 frames, +80). On the
audited cold-render fixture, those 80 frames imply about 17.05 additional
worker-minutes, 9.53 GiB of generated artifacts, and 3.86 GiB of selected
source cache per run; actual wall time depends on worker and I/O concurrency.
The run picker labels the 129 default frames separately from the 209-frame
optional source cadence. Concrete runs use their currently published prefix;
an unbounded latest official-horizon request requires a completed horizon, while
default/capped latest requests may use a contiguous published prefix. Mixed selections say so explicitly;
progress denominators come from the builder's resolved per-model hour plan.
Canonical tier prefixes keep one stable frame-completion identity, so a still-
publishing run or a larger `--max-hour` cap reuses completed common frames.
Cadence-sensitive accumulation, run-max, and snowfall caches separately hash
the exact source-hour roster through each target frame; hourly and three-hourly
GFS products therefore cannot cross-reuse temporal artifacts.

Cache clearing:

```bash
npm run cache:clear
npm run cache:clear -- --dry-run
npm run cache:clear -- --no-temp
```

The clear command preserves `output/noaa-benchmarks`, `output/noaa-debug`, and `output/noaa-beta-tools` by default. Add `--include-tools` only when you want to remove the local wgrib2 tool install too.

## Validation

Maintenance guardrails:

```bash
node --test tests-node/noaa-beta.test.js
npm run typecheck
npm run lint -- --quiet
npm run format:check
npm run build
npm run smoke:react
node scripts/benchmark-science-prototypes.js
node scripts/benchmark-science-prototypes.js --section=dense
node scripts/benchmark-map-geojson.js
```

React smoke tests use a small generated NOAA fixture cache (`scripts/prepare-react-fixture-cache.js`) so they validate app behavior without a live NOAA render.

The two benchmark scripts emit their complete sample arrays and workload assumptions. Science timings are isolated CPU-work measurements plus explicitly labeled grid extrapolations, not end-to-end render wall time. The GeoJSON benchmark reports exact source/duplicated-byte changes and a JSON-serialization proxy; it does not claim MapLibre structured-clone, worker-index, or browser frame time.

## Local Runtime Notes

- The React app consumes `manifests/{model}/latest.json`, run manifests, PNG layers, synoptic JSON, and lossless hover artifacts. New renders default to `hover-grid.bin.br` (Brotli q0); legacy `.json.gz`/`.bin.gz` artifacts remain readable.
- `npm run noaa:build` writes artifacts under `output/noaa-beta-cache`.
- `npm run local:data` serves only files already present in the configured cache root.
- `output/` is gitignored, so local artifact caches stay out of the repo.
- Prior run artifacts are retained for the panel run selector.

## Maintenance Map

- Artifact client facade: `/Users/micha/Development/model-view/next/src/core/artifact-client.ts`
- Artifact URL helpers: `/Users/micha/Development/model-view/next/src/core/artifact-url.ts`
- Manifest normalization: `/Users/micha/Development/model-view/next/src/core/manifest-utils.ts`
- App state hooks: `/Users/micha/Development/model-view/next/src/hooks`
- Timeline/status chrome: `/Users/micha/Development/model-view/next/src/components/Timeline.tsx`
- Map panel behavior hooks: `/Users/micha/Development/model-view/next/src/components/map-panel`
- Local artifact runtime helpers: `/Users/micha/Development/model-view/scripts/lib/local-artifact-*.js`
