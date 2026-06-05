# MacBook Migration And Setup Guide

This guide takes you from a fresh Mac to the current NOAA-backed local app.

Recommended local path:

- `$HOME/Development/model-view`

## 1. Before You Leave The Old Mac

Push the repo state you want to keep:

```bash
cd "$HOME/Development/model-view"
git status
git push
```

Copy these local-only items if you want to preserve them:

- `.env`
- `output/noaa-beta-cache/` if you want to keep rendered NOAA artifacts
- `output/noaa-beta-tools/` if you want to keep the local wgrib2 install
- `output/noaa-benchmarks/` or `output/noaa-debug/` if you care about prior diagnostics

Optional machine-level items:

- `~/.gitconfig`
- `~/.ssh/`

## 2. Prepare The New Mac

Install Apple command line tools:

```bash
xcode-select --install
```

Install Node.js `20.19.0` or newer, then verify:

```bash
node -v
npm -v
```

Install or restore `wgrib2`; NOAA artifact builds require it on `PATH` or via `WGRIB2`.

## 3. Clone And Install

```bash
mkdir -p ~/Development
cd ~/Development
git clone https://github.com/YOUR_GITHUB_USER/model-view.git "model-view"
cd "model-view"
npm install
npm run install:browsers
```

Copy `.env` if you use one:

```bash
cp /Volumes/YOUR_USB_NAME/.env "$HOME/Development/model-view/.env"
```

Typical local keys are:

- `MODELVIEW_DATA_HOST`
- `MODELVIEW_DATA_PORT`
- `MODELVIEW_CACHE_ROOT`
- `MODELVIEW_ARTIFACT_PREFIX`
- `MODELVIEW_ARTIFACT_BASE_URL`
- `MODELVIEW_REFLECTIVITY_GATES`

`MODELVIEW_CACHE_ROOT` defaults to `output/noaa-beta-cache`.

## 4. Build And Run

Render a small all-model NOAA cache:

```bash
npm run noaa:build:test
```

Start the local data server and Vite together:

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

Open:

- `http://127.0.0.1:5173`

## 5. Verify

```bash
node --test tests-node/noaa-beta.test.js
npm run typecheck
npm run lint -- --quiet
npm run smoke:react
```

Optional local integration lane:

```bash
npm run test:local-integration
```

## 6. Common Problems

`node -v` is too old:

- Install Node `20.19.x` or newer.

`npm run noaa:build:test` cannot find wgrib2:

- Install `wgrib2`, or set `WGRIB2=/absolute/path/to/wgrib2`.

The app starts but data is missing:

- Run `npm run noaa:build:test` or `npm run noaa:build:full` before starting the site.
- Confirm the local data server is running.
- Confirm `output/noaa-beta-cache/artifacts/manifests/` contains prebuilt manifests.
- Run `npm run cache:clear` if you suspect a stale cache, then rebuild.

## 7. Minimum New-Mac Command Sequence

```bash
xcode-select --install
mkdir -p ~/Development
cd ~/Development
git clone https://github.com/YOUR_GITHUB_USER/model-view.git "model-view"
cd "$HOME/Development/model-view"
npm install
npm run install:browsers
npm run noaa:build:test
npm run dev -- --host 127.0.0.1 --port 5173
```
