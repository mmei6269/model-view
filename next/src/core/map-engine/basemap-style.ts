// Purpose-built basemap styles for the MapLibre engine: the generated
// @protomaps/basemaps flavors, filtered down to what a weather viewer needs
// (roads + boundaries + place/water labels stay; POI/building/landuse noise
// goes) and recolored with meteorology tuning per theme (spec §8a.1):
//
// - LIGHT (the app default): the weather color maps were designed for a
//   white background, so land must read as near-white paper. Built from the
//   "light" flavor with color overrides BEFORE generation (the flavor is a
//   flat color-knob object) — near-white earth, whisper-tint landcover,
//   desaturated warm-gray roads, a soft steel-blue water, white label halos.
//   The "white" flavor was evaluated and rejected: its land is pure #ffffff
//   (no land/water/road articulation left to recolor against) AND it
//   generates a DIFFERENT layer set (no landcover/pois layers), which would
//   break the theme-neutral layer-id contract verified below.
// - DARK: the "dark" flavor, water recolored to near-black navy under
//   weather rasters (unchanged from Task 2.1).
//
// Glyphs and sprites are vendored app-origin assets (next/public/basemap/,
// see its README; each theme references its own flavor-matched v4 sprite
// sheet); the tile data is the local PMTiles archive served by the artifact
// server's Range route.
import { layers, namedFlavor, type Flavor } from "@protomaps/basemaps";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

// Source id every basemap layer hangs off; the engine uses it to tell fatal
// basemap failures apart from app-layer errors.
export const BASEMAP_SOURCE_ID = "protomaps";

// Font stacks vendored under next/public/basemap/fonts/. If a package bump
// makes the generated style reference anything else, fail loudly in dev
// (labels would silently 404 otherwise).
const VENDORED_FONT_STACKS = new Set(["Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic"]);

// Generated layer ids to DROP, as prefix patterns with the human reason kept
// alongside. Pattern-based on purpose: a @protomaps/basemaps bump that
// renames its layer ids must fail loudly (see the unmatched-pattern check in
// buildThemedStyle), not silently re-admit POI clutter.
const DROPPED_LAYER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^pois/, reason: "POI icons/labels — visual noise under weather rasters" },
  { pattern: /^buildings/, reason: "building footprints — irrelevant at forecast zooms" },
  { pattern: /^landuse_/, reason: "minor landuse fills (parks/hospitals/schools/…)" },
  { pattern: /^address_/, reason: "housenumber/address labels" },
  // Task 5.1 deliberate call on the non-motor transport riders of the roads_
  // prefix: an analyst's "Roads" toggle means the motor network + its labels
  // and shields. Rail reads as boundary-like noise at mid zoom; runway/
  // taxiway/pier geometry floats context-free once the aerodrome/pier landuse
  // fills are stripped (and the light flavor paints them near-invisibly
  // anyway, so keeping them was theme-inconsistent); one-way arrows are
  // street-navigation detail with no forecast value.
  { pattern: /^roads_rail$/, reason: "rail lines — non-motor transport, boundary-like noise at mid zoom" },
  { pattern: /^roads_(runway|taxiway)$/, reason: "airport surfaces — context-free once aerodrome landuse is stripped" },
  { pattern: /^roads_pier$/, reason: "pier decks — harbor micro-detail" },
  { pattern: /^roads_oneway$/, reason: "one-way arrows — street-navigation detail" },
];

// ── DARK theme tuning ────────────────────────────────────────────────────────
// Water recolor: near-black navy, harmonious with the app's #020914 chrome.
// Streams/rivers sit a touch lighter so they stay legible against the fill.
// Post-generation recolor (not flavor overrides) so the dark style's output
// stays byte-identical to the Task 2.1 original.
const DARK_WATER_FILL_COLOR = "#0a1220";
const DARK_WATER_LINE_COLOR = "#101a2b";

// ── LIGHT theme tuning ───────────────────────────────────────────────────────
// Flavor color overrides applied BEFORE generation, so every expression the
// generator derives from a knob (river width ramps, ocean-label halos == the
// water color, …) stays internally consistent. Goal: land reads as
// near-white paper — the surface the weather color maps were designed for —
// with just enough basemap articulation to orient by.
const LIGHT_EARTH = "#f8f7f4"; // near-white paper, faintly warm so pure-white colormap highlights still pop
const LIGHT_WATER = "#bfd7e6"; // soft steel blue: unmistakably water, quiet under weather fills
const LIGHT_FLAVOR_OVERRIDES: Partial<Flavor> = {
  // Background = WATER tone, not earth (Stage B, docs/basemap-expansion-plan.md):
  // PAN_BOUNDS over-pans past the PMTiles extract edges, and the un-tiled
  // strips there render the raw background — which must read as open ocean
  // (the over-pan areas are Pacific/Atlantic/Arctic water). Land inside
  // coverage is painted by the tiled earth layer, so nothing else changes.
  background: LIGHT_WATER,
  earth: LIGHT_EARTH,
  water: LIGHT_WATER,
  // Low-zoom landcover tints large land areas; neutralize the flavor's
  // saturated greens to whisper tints a few steps off the paper tone so land
  // stays near-white under (and between) weather fills.
  landcover: {
    grassland: "#eff3ec",
    barren: "#f5f0e6",
    urban_area: "#edebe8",
    farmland: "#f0f3e9",
    glacier: "#f7fafc",
    scrub: "#eef1e7",
    forest: "#e9f0e9",
  },
  // Roads: the flavor draws them WHITE (invisible on paper land). Desaturate
  // to warm grays — a classic road-atlas underlay: darker = more important.
  highway: "#d2cec6",
  major: "#dcd8d1",
  minor_a: "#eae7e2",
  minor_b: "#e4e1db",
  minor_service: "#eae7e2",
  link: "#dcd8d1",
  other: "#eae7e2",
  minor_service_casing: "#cbc7c0",
  minor_casing: "#cbc7c0",
  link_casing: "#cbc7c0",
  major_casing_early: "#cbc7c0",
  major_casing_late: "#cbc7c0",
  highway_casing_early: "#cbc7c0",
  highway_casing_late: "#cbc7c0",
  bridges_other: "#eae7e2",
  bridges_minor: "#e4e1db",
  bridges_link: "#dcd8d1",
  bridges_major: "#dcd8d1",
  bridges_highway: "#d2cec6",
  bridges_other_casing: "#cbc7c0",
  bridges_minor_casing: "#cbc7c0",
  bridges_link_casing: "#cbc7c0",
  bridges_major_casing: "#cbc7c0",
  bridges_highway_casing: "#cbc7c0",
  tunnel_other: "#efedea",
  tunnel_minor: "#efedea",
  tunnel_link: "#efedea",
  tunnel_major: "#efedea",
  tunnel_highway: "#efedea",
  tunnel_other_casing: "#dedbd5",
  tunnel_minor_casing: "#dedbd5",
  tunnel_link_casing: "#dedbd5",
  tunnel_major_casing: "#dedbd5",
  tunnel_highway_casing: "#dedbd5",
  // Labels: white halos "cut" text out of the paper ground (the flavor's
  // gray #e0e0e0 halos read as smudges on near-white); region/country tiers
  // darken so orientation labels survive bright weather fills (Task 5.1
  // audit: the previous #8a939c state ink washed out over CAPE/reflectivity
  // pastels even with the white halo — the halo needs a text tone dark
  // enough to anchor).
  city_label_halo: "#ffffff",
  subplace_label_halo: "#ffffff",
  state_label: "#6f7a85",
  state_label_halo: "#ffffff",
  country_label: "#67717b",
  ocean_label: "#64809c",
  boundaries: "#a3aab2",
};

export function buildDarkStyle(pmtilesUrl: string): StyleSpecification {
  return buildThemedStyle(pmtilesUrl, {
    label: "buildDarkStyle",
    flavor: namedFlavor("dark"),
    sprite: "dark",
    recolor: recolorDarkWater,
  });
}

export function buildLightStyle(pmtilesUrl: string): StyleSpecification {
  return buildThemedStyle(pmtilesUrl, {
    label: "buildLightStyle",
    flavor: { ...namedFlavor("light"), ...LIGHT_FLAVOR_OVERRIDES },
    sprite: "light",
  });
}

interface ThemeSpec {
  label: string; // fail-loud log prefix
  flavor: Flavor;
  sprite: "dark" | "light"; // vendored v4 sprite sheet matching the flavor
  recolor?: (layer: LayerSpecification) => LayerSpecification;
}

function buildThemedStyle(pmtilesUrl: string, theme: ThemeSpec): StyleSpecification {
  const generated = layers(BASEMAP_SOURCE_ID, theme.flavor, { lang: "en" });
  const kept: LayerSpecification[] = [];
  const matched = new Set<RegExp>();
  for (const layer of generated) {
    const drop = DROPPED_LAYER_PATTERNS.find((rule) => rule.pattern.test(layer.id));
    if (drop) {
      matched.add(drop.pattern);
      continue;
    }
    const tuned = strengthenPlaceLabelHalos(layer);
    kept.push(theme.recolor ? theme.recolor(tuned) : tuned);
  }
  for (const rule of DROPPED_LAYER_PATTERNS) {
    if (!matched.has(rule.pattern)) {
      console.error(
        `${theme.label}: drop pattern ${String(rule.pattern)} (${rule.reason}) matched no generated layer id — ` +
          "@protomaps/basemaps likely renamed its layers in an upgrade; re-derive the filter list.",
      );
    }
  }
  checkFontStacks(theme.label, kept);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return {
    version: 8,
    // Vendored, app-origin assets (Vite serves next/public/ at /): boot stays
    // on localhost end to end.
    glyphs: `${origin}/basemap/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/basemap/sprites/v4/${theme.sprite}`,
    sources: {
      [BASEMAP_SOURCE_ID]: {
        type: "vector",
        url: `pmtiles://${pmtilesUrl}`,
        attribution: "© OpenStreetMap",
      },
    },
    layers: kept,
  };
}

// The engine's theme switch keeps its derived layer-id sets (labels/roads/
// places) and anchor insertion points across styles, which is only sound if
// both generated styles expose the SAME layer ids in the same order. True
// for the current @protomaps/basemaps (a flavor is colors only, verified
// 5.7.2) — fail loudly if a bump ever makes flavors structural.
export function verifyThemeLayerIdParity(a: StyleSpecification, b: StyleSpecification): boolean {
  const idsA = a.layers.map((layer) => layer.id);
  const idsB = b.layers.map((layer) => layer.id);
  const equal = idsA.length === idsB.length && idsA.every((id, i) => id === idsB[i]);
  if (!equal) {
    console.error(
      "verifyThemeLayerIdParity: the light and dark generated styles expose different layer ids — " +
        "@protomaps/basemaps flavors are no longer color-only; re-derive the id-set helpers " +
        `(light: ${idsA.length} layers, dark: ${idsB.length} layers).`,
    );
  }
  return equal;
}

// Symbol layers of the generated style == the basemap's label layers; the
// engine's setBasemap({labels}) toggles exactly these.
export function basemapLabelLayerIds(style: StyleSpecification): string[] {
  return style.layers.filter((layer) => layer.type === "symbol").map((layer) => layer.id);
}

// Road-network layers of the generated style: every id under the roads_
// prefix that survives the drop filter — the MOTOR-road line stacks
// (casings/tunnels/bridges) and the road symbol layers (labels, shields).
// The non-motor riders of the prefix (rail/runway/taxiway/pier/oneway) are
// dropped from the style entirely (Task 5.1 decision, see
// DROPPED_LAYER_PATTERNS), so the Display "Roads" toggle now has clean
// analyst semantics: motor roads + their labels/shields, nothing else (a
// shield with no road under it is noise, not orientation).
export function basemapRoadLayerIds(style: StyleSpecification): string[] {
  const ids = style.layers.filter((layer) => layer.id.startsWith("roads_")).map((layer) => layer.id);
  if (ids.length === 0) {
    console.error(
      "basemapRoadLayerIds: no generated layer id under the roads_ prefix — " +
        "@protomaps/basemaps likely renamed its layers in an upgrade; re-derive the id set.",
    );
  }
  return ids;
}

// Admin boundary line layers of the generated style: boundaries_country
// (admin<=2) and boundaries (admin>2), both off the boundaries source-layer.
// The engine's setBasemapBoundaries verb (Display border modes — basemap
// lines show ONLY in mode "basemap") toggles/restyles exactly these.
export function basemapBoundaryLayerIds(style: StyleSpecification): string[] {
  const ids = style.layers.filter((layer) => /^boundaries(_country)?$/.test(layer.id)).map((layer) => layer.id);
  if (ids.length === 0) {
    console.error(
      "basemapBoundaryLayerIds: no boundaries/boundaries_country layer in the generated style — " +
        "@protomaps/basemaps likely renamed its layers in an upgrade; re-derive the id set.",
    );
  }
  return ids;
}

// City/town label layers (the locality + subplace tiers of the places
// source-layer). The engine's setBasemapDetail "cities" flag toggles exactly
// these: the Display "Cities" toggle governs city-label density, while the
// region/country orientation labels deliberately stay with the Labels toggle
// (basemapLabelLayerIds above).
export function basemapPlaceLabelLayerIds(style: StyleSpecification): string[] {
  const ids = style.layers
    .filter((layer) => layer.type === "symbol" && /^places_(locality|subplace)$/.test(layer.id))
    .map((layer) => layer.id);
  if (ids.length === 0) {
    console.error(
      "basemapPlaceLabelLayerIds: no places_locality/places_subplace layer in the generated style — " +
        "@protomaps/basemaps likely renamed its layers in an upgrade; re-derive the id set.",
    );
  }
  return ids;
}

// Both flavors generate every place tier with a 1 px text halo — enough on a
// plain basemap, thin over busy weather fills (Task 5.1 label audit with
// reflectivity + CAPE active). 1.5 px keeps the same halo COLOR scheme per
// theme but gives the cutout enough body to hold at CONUS and regional
// zooms; theme-neutral on purpose, so the tweak survives flavor recolors.
function strengthenPlaceLabelHalos(layer: LayerSpecification): LayerSpecification {
  if (layer.type !== "symbol" || !/^places_/.test(layer.id)) {
    return layer;
  }
  return { ...layer, paint: { ...layer.paint, "text-halo-width": 1.5 } };
}

function recolorDarkWater(layer: LayerSpecification): LayerSpecification {
  // Background = water tone for the same Stage B over-pan reason as the light
  // flavor's `background: LIGHT_WATER` override (un-tiled strips past the
  // extract edges must read as ocean); dark stays a post-generation recolor
  // so the style otherwise remains byte-identical to the generated flavor.
  if (layer.type === "background") {
    return { ...layer, paint: { ...layer.paint, "background-color": DARK_WATER_FILL_COLOR } };
  }
  if (layer.id === "water" && layer.type === "fill") {
    return { ...layer, paint: { ...layer.paint, "fill-color": DARK_WATER_FILL_COLOR } };
  }
  if ((layer.id === "water_stream" || layer.id === "water_river") && layer.type === "line") {
    return { ...layer, paint: { ...layer.paint, "line-color": DARK_WATER_LINE_COLOR } };
  }
  return layer;
}

// text-font values are either literal string arrays or expressions embedding
// them (the flavor uses a ["case", …] between Medium and Regular). Collect
// every embedded font-stack-looking string (capitalized words — expression
// operators and property names are lowercase) and verify it is vendored.
function checkFontStacks(label: string, kept: LayerSpecification[]): void {
  const referenced = new Set<string>();
  for (const layer of kept) {
    const layout = (layer as { layout?: Record<string, unknown> }).layout;
    if (layout && layout["text-font"] !== undefined) {
      collectFontNames(layout["text-font"], referenced);
    }
  }
  for (const name of referenced) {
    if (!VENDORED_FONT_STACKS.has(name)) {
      console.error(
        `${label}: generated style references font stack "${name}" which is not vendored under ` +
          "next/public/basemap/fonts/ — its labels will fail to load. Vendor the stack (see the README there).",
      );
    }
  }
}

function collectFontNames(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (/^[A-Z][\w -]*$/.test(value)) {
      out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectFontNames(entry, out);
    }
  }
}
