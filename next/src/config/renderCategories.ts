// Client mirror of the server catalog's render taxonomy (scripts/lib/noaa-nam-parameter-catalog.js:
// GROUP_TO_CATEGORY / RENDER_CATEGORY_IDS). The render panel builds its category tree before any
// manifest is loaded, so it cannot rely on per-parameter metadata alone; it keys off the group
// string. Guarded against drift by tests-node/render-category-client-parity.test.js, which
// transpiles this module and asserts it equals the server map. (The AUTHORED FULL_TIER_KEYS set
// stays server-side, but manifests now stamp each parameter's resolved `category`/`costTier`,
// which layers.ts reads together with manifest.renderSelection to gate availability on
// selective builds.)

export type RenderCategoryId = "surface" | "precip" | "radar" | "cloud" | "severe" | "winter" | "upperAir";

export const RENDER_CATEGORY_IDS: readonly RenderCategoryId[] = [
  "surface",
  "precip",
  "radar",
  "cloud",
  "severe",
  "winter",
  "upperAir",
];

export const GROUP_TO_CATEGORY: Readonly<Record<string, RenderCategoryId>> = {
  "Surface & Boundary Layer": "surface",
  Precipitation: "precip",
  Radar: "radar",
  "Clouds & Ceiling": "cloud",
  "Severe: Thermodynamics": "severe",
  "Severe: Kinematics": "severe",
  "Winter / Snow & Ice": "winter",
  "Upper Air: Height / Wind / Temp": "upperAir",
  "Upper Air: Omega / Vorticity": "upperAir",
};

export function groupToRenderCategory(group: string | null | undefined): RenderCategoryId | null {
  if (!group) {
    return null;
  }
  return GROUP_TO_CATEGORY[group] ?? null;
}
