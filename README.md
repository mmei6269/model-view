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
- `docs/point-sounding-audit-2026-06-11.md` - point-sounding accuracy audit against SHARPpy-style reference with corrections and verified-match table.
- `tools/noaa-beta/snow-rf/utahrfslr/README.md` - upstream notes for vendored snow-to-liquid-ratio tooling.

## Quick Start

```bash
npm install
npm run install:browsers
npm run noaa:build:test
npm run dev -- --host 127.0.0.1 --port 5173
```

Open: `http://127.0.0.1:5173`

Default local runtime behavior:

- serves prebuilt NOAA GRIB2 artifacts from `output/noaa-beta-cache`
- uses NOAA S3 byte-range reads from `.idx` inventories during builds
- supports `gfs`, `nam`, `nam3km`, and `hrrr`
- does not render on page request; run a build first when manifests are missing

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

`npm run noaa:build:full` renders the latest available run plus the previous available run for GFS, NAM, NAM 3km, and HRRR with the current full-render defaults: `conus`, full horizon, forced frame render, profiling enabled, 18 render workers, a 48-slot global frame queue, 3 range reads per worker, 2 decode slots per worker, and the persist queue disabled.

`npm run noaa:build:test` uses the same render settings for one recent run, but renders only the first 18 native forecast frames per model so iteration still exercises every NOAA model without a full run.

NOAA render command modifiers:

```bash
npm run noaa:build:full -- --runs=3
npm run noaa:build:full -- --models=hrrr,nam3km
npm run noaa:build:test -- --frames=6
npm run noaa:build:test -- --models=hrrr
npm run noaa:build:test -- --worker-count=8 --total-frame-concurrency=8
npm run noaa:build -- --models=hrrr --hours=0,1,2,3 --view=conus --force --profile
```

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
```

React smoke tests use a small generated NOAA fixture cache (`scripts/prepare-react-fixture-cache.js`) so they validate app behavior without a live NOAA render.

## Local Runtime Notes

- The React app consumes `manifests/{model}/latest.json`, run manifests, PNG layers, synoptic JSON, and `hover-grid.json.gz` or `hover-grid.bin.gz`.
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
