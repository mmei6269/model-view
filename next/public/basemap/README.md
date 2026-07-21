# Vendored basemap assets (glyphs + sprites)

Self-hosted font glyphs and sprites for the MapLibre PMTiles basemap
(`next/src/core/map-engine/basemap-style.ts`). Served by Vite at the app
origin (`/basemap/fonts/{fontstack}/{range}.pbf`, `/basemap/sprites/v4/{light,dark}`)
so map boot never touches the network beyond localhost.

## Provenance

Copied verbatim from https://github.com/protomaps/basemaps-assets (`main`
branch), the asset companion of `@protomaps/basemaps`:

- `fonts/Noto Sans Regular`, `fonts/Noto Sans Medium`, `fonts/Noto Sans Italic`
  — the ONLY font stacks the generated light/dark-flavor styles reference (~13 MB).
  License: SIL Open Font License (see `fonts/OFL.txt`).
- `sprites/v4/{light,dark}{,@2x}.{json,png}` — the v4 light + dark spritesheets
  (~52 KB each; each themed style references its flavor-matched sheet).
  License: derived from MIT-licensed tangrams/icons (per upstream README).

## Refresh

```sh
curl -sL https://codeload.github.com/protomaps/basemaps-assets/tar.gz/refs/heads/main | tar -xz
cp "basemaps-assets-main/fonts/Noto Sans Regular"/*.pbf "next/public/basemap/fonts/Noto Sans Regular/"
cp "basemaps-assets-main/fonts/Noto Sans Medium"/*.pbf "next/public/basemap/fonts/Noto Sans Medium/"
cp "basemaps-assets-main/fonts/Noto Sans Italic"/*.pbf "next/public/basemap/fonts/Noto Sans Italic/"
cp basemaps-assets-main/fonts/OFL.txt next/public/basemap/fonts/
cp basemaps-assets-main/sprites/v4/{light,dark}*.{json,png} next/public/basemap/sprites/v4/
```

After an `@protomaps/basemaps` bump, re-check which stacks the generated styles
reference (`text-font` values) — the style builders fail loudly in dev if a
style names a stack that is not vendored here.

The PMTiles tile data itself is NOT here: it lives in `output/basemap/`
(gitignored, multi-GB) via `npm run basemap:fetch`.
