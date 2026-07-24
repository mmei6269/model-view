# Snow-RF model and typed asset

The CONUS snow-to-liquid-ratio (SLR) product uses a random-forest model (100 trees, 666,406 nodes, 27 features) exported from the University of Utah `utahrfslr` project (the Pletcher RF SLR model), pinned to upstream commit `2d35566fd41e99dcdc75a0f107ddb6bdc6a46b61`.

Everything needed ships in this repository and is enabled by default — no setup is required to render RF-based snowfall products.

## What ships

- `tools/noaa-beta/snow-rf/conus-rf.json` — the exported model (JSON).
- `tools/noaa-beta/snow-rf/utahrfslr/` — the curated upstream artifacts the export derives from (`models/rf/rf_slr_model.pkl`, `models/rf/rf_slr_model_keys.npy`, upstream `README.md`, and `source-manifest.json`, which pins the upstream commit so regeneration can be verified without a git checkout of `utahrfslr`).
- `scripts/lib/noaa-beta/generated/snow-rf-conus-v1.bin` + `snow-rf-conus-v1.json` — a content-addressed typed binary asset and its manifest, compiled from the model. The renderer loads this by default; it is bit-exact with the JSON path and roughly 10× faster to load per process.

## Runtime configuration

- `MODELVIEW_NOAA_SNOW_RF_ASSET` — `auto` (default: use the typed asset when it validates against the committed model, otherwise fall back to parsing the JSON), `off` (always parse the JSON), or `required` (fail loudly if the typed asset cannot be used). Unknown values warn once and behave like `off`.
- `MODELVIEW_SNOW_RF_CONUS_PATH` — point the renderer at a custom model JSON. Custom paths always use the JSON parse path; the typed asset only serves the committed model.

## Regenerating (only needed if the model or compiler changes)

1. `npm run noaa:snow-rf:export` — re-export `conus-rf.json` from the vendored `utahrfslr` artifacts. Requires `python3` with a scikit-learn version able to unpickle the model; the script hash-pins the `.pkl`/`.npy` inputs and the upstream commit before exporting.
2. `npm run noaa:snow-rf:generate` — recompile the typed asset from `conus-rf.json`.
3. `npm run noaa:snow-rf:check` — verify the committed asset byte-matches a fresh compile. CI runs this on every push, so committed-asset drift cannot land silently.

## Exactness

The typed asset and JSON paths produce identical predictions (verified element-by-element across all tree arrays and a 20,000-point prediction sweep). The guarantees are enforced by `tests-node/snow-rf-compiler.test.js`, `tests-node/snow-rf-asset.test.js`, and `tests-node/snow-rf-loader.test.js`.
