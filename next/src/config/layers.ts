import sharedConfig from "../../../shared/modelview-config.json";
import type { LayerDefinition, LayerKey, ModelManifest, ParameterMetadata, PrecipTypeLegendRow } from "../types";
import { groupToRenderCategory } from "./renderCategories";

interface SharedLayerConfig {
  label: string;
  unit: string;
  thresholdNote: string | null;
  legendTicks: unknown[];
  legendTickPositions?: unknown[];
  legendStops: unknown[];
}

type LegendColor = [number, number, number] | [number, number, number, number];
type LegendDisplayScale = NonNullable<ParameterMetadata["legendDisplayScale"]>;

export interface LayerLegendConfig {
  key: LayerKey;
  label: string;
  unit: string;
  thresholdNote: string | null;
  legendTicks: number[];
  legendTickPositions?: number[];
  legendGradientCss: string;
  legendType?: string | null;
  precipTypeLegend?: PrecipTypeLegendRow[];
  precipRateTypeLegend?: PrecipTypeLegendRow[];
  contourIntervalDam?: number | null;
  contourLevelMb?: number | null;
}

const FALLBACK_ORDER: LayerKey[] = [
  "temperature",
  "wind",
  "precip",
  "precip3h",
  "precip6h",
  "precip12h",
  "precip24h",
  "precipTotal",
  "reflectivityComposite",
  "reflectivity1km",
  "reflectivity1kmPrecipType",
  "reflectivity",
  "synoptic",
];

// Membership derives from the shared config order so configured layers (e.g. the
// snow suite) stay in LAYER_STACK_ORDER instead of being silently filtered out.
const KNOWN_LAYER_KEYS = new Set<string>([
  ...((sharedConfig.layerOrder as string[] | undefined) || []),
  ...FALLBACK_ORDER,
]);

const RAW_LAYERS = (sharedConfig.layers || {}) as Record<string, SharedLayerConfig>;
const HIDDEN_PARAMETER_OPTION_KEYS = new Set(["reflectivity", "synoptic"]);
const SURFACE_BOUNDARY_GROUP = "Surface & Boundary Layer";
const PRECIPITATION_GROUP = "Precipitation";
const RADAR_GROUP = "Radar";
const CLOUD_GROUP = "Clouds & Ceiling";
const UPPER_AIR_STANDARD_GROUP = "Upper Air: Height / Wind / Temp";
const UPPER_AIR_DIAGNOSTIC_GROUP = "Upper Air: Omega / Vorticity";
const SEVERE_THERMO_GROUP = "Severe: Thermodynamics";
const SEVERE_KINEMATICS_GROUP = "Severe: Kinematics";
const WINTER_GROUP = "Winter / Snow & Ice";

const parameterFallback = (key: string, label: string, group: string, unit: string | null = null): LayerDefinition => ({
  key,
  label,
  group,
  unit,
});

const PARAMETER_OPTION_FALLBACKS: LayerDefinition[] = [
  parameterFallback("temperature", "Temp", SURFACE_BOUNDARY_GROUP, "F"),
  parameterFallback("dewpoint2m", "2 m Dewpoint", SURFACE_BOUNDARY_GROUP, "F"),
  parameterFallback("humidity2m", "2 m RH", SURFACE_BOUNDARY_GROUP, "%"),
  parameterFallback("visibility", "Visibility", SURFACE_BOUNDARY_GROUP, "mi"),
  parameterFallback("wind", "Wind", SURFACE_BOUNDARY_GROUP, "mph"),
  parameterFallback("gust", "Wind Gust", SURFACE_BOUNDARY_GROUP, "mph"),
  parameterFallback("wind80m", "80 m Wind", SURFACE_BOUNDARY_GROUP, "mph"),
  parameterFallback("pwat", "Precipitable Water", SURFACE_BOUNDARY_GROUP, "mm"),
  parameterFallback("pblHeight", "PBL Height (AGL)", SURFACE_BOUNDARY_GROUP, "m"),
  parameterFallback("gustRunMax", "Run Max Gust", SURFACE_BOUNDARY_GROUP, "mph"),
  parameterFallback("precip", "1-h Precip", PRECIPITATION_GROUP, "in"),
  parameterFallback("precipRateAndType", "Precip Rate + Type", PRECIPITATION_GROUP, "in/hr"),
  parameterFallback("precip3h", "3-h Precip", PRECIPITATION_GROUP, "in"),
  parameterFallback("precip6h", "6-h Precip", PRECIPITATION_GROUP, "in"),
  parameterFallback("precip12h", "12-h Precip", PRECIPITATION_GROUP, "in"),
  parameterFallback("precip24h", "24-h Precip", PRECIPITATION_GROUP, "in"),
  parameterFallback("precipTotal", "Total Precip", PRECIPITATION_GROUP, "in"),
  parameterFallback("reflectivityComposite", "Composite Reflectivity", RADAR_GROUP, "dBZ"),
  parameterFallback("reflectivity1km", "1 km AGL Reflectivity", RADAR_GROUP, "dBZ"),
  parameterFallback("reflectivity1kmPrecipType", "1 km Reflectivity + Precip Type", RADAR_GROUP, "dBZ"),
  parameterFallback("cloudCover", "Total Cloud Cover", CLOUD_GROUP, "%"),
  parameterFallback("cloudCeiling", "Cloud Ceiling (AGL)", CLOUD_GROUP, "ft"),
  parameterFallback("height850", "850 mb Height", UPPER_AIR_STANDARD_GROUP, "dam"),
  parameterFallback("wind850", "850 mb Wind", UPPER_AIR_STANDARD_GROUP, "kt"),
  parameterFallback("temp850", "850 mb Temp", UPPER_AIR_STANDARD_GROUP, "C"),
  parameterFallback("rh850", "850 mb RH", UPPER_AIR_STANDARD_GROUP, "%"),
  parameterFallback("height700", "700 mb Height", UPPER_AIR_STANDARD_GROUP, "dam"),
  parameterFallback("wind700", "700 mb Wind", UPPER_AIR_STANDARD_GROUP, "kt"),
  parameterFallback("temp700", "700 mb Temp", UPPER_AIR_STANDARD_GROUP, "C"),
  parameterFallback("rh700", "700 mb RH", UPPER_AIR_STANDARD_GROUP, "%"),
  parameterFallback("height500", "500 mb Height", UPPER_AIR_STANDARD_GROUP, "dam"),
  parameterFallback("wind500", "500 mb Wind", UPPER_AIR_STANDARD_GROUP, "kt"),
  parameterFallback("temp500", "500 mb Temp", UPPER_AIR_STANDARD_GROUP, "C"),
  parameterFallback("rh500", "500 mb RH", UPPER_AIR_STANDARD_GROUP, "%"),
  parameterFallback("height300", "300 mb Height", UPPER_AIR_STANDARD_GROUP, "dam"),
  parameterFallback("wind300", "300 mb Wind", UPPER_AIR_STANDARD_GROUP, "kt"),
  parameterFallback("height250", "250 mb Height", UPPER_AIR_STANDARD_GROUP, "dam"),
  parameterFallback("wind250", "250 mb Wind", UPPER_AIR_STANDARD_GROUP, "kt"),
  parameterFallback("absoluteVorticity700", "700 mb Abs Vort", UPPER_AIR_DIAGNOSTIC_GROUP, "x10^-5 s^-1"),
  parameterFallback("verticalVelocity700", "700 mb Omega", UPPER_AIR_DIAGNOSTIC_GROUP, "dPa/s"),
  parameterFallback("relativeVorticity700", "700 mb Rel Vort", UPPER_AIR_DIAGNOSTIC_GROUP, "x10^-5 s^-1"),
  parameterFallback("absoluteVorticity500", "500 mb Abs Vort", UPPER_AIR_DIAGNOSTIC_GROUP, "x10^-5 s^-1"),
  parameterFallback("verticalVelocity500", "500 mb Omega", UPPER_AIR_DIAGNOSTIC_GROUP, "dPa/s"),
  parameterFallback("relativeVorticity500", "500 mb Rel Vort", UPPER_AIR_DIAGNOSTIC_GROUP, "x10^-5 s^-1"),
  parameterFallback("frontogenesis850", "850 mb Frontogenesis", UPPER_AIR_DIAGNOSTIC_GROUP, "C/100km/3hr"),
  parameterFallback("frontogenesis700", "700 mb Frontogenesis", UPPER_AIR_DIAGNOSTIC_GROUP, "C/100km/3hr"),
  parameterFallback("sbcape", "SBCAPE", SEVERE_THERMO_GROUP, "J/kg"),
  parameterFallback("sbcin", "SBCIN", SEVERE_THERMO_GROUP, "J/kg"),
  parameterFallback("mlcape", "MLCAPE", SEVERE_THERMO_GROUP, "J/kg"),
  parameterFallback("mlcin", "MLCIN", SEVERE_THERMO_GROUP, "J/kg"),
  parameterFallback("mucape", "MUCAPE", SEVERE_THERMO_GROUP, "J/kg"),
  parameterFallback("surfaceBasedLclHeight", "Surface LCL (AGL)", SEVERE_THERMO_GROUP, "m"),
  parameterFallback("surfaceThetaE", "Surface Theta-e", SEVERE_THERMO_GROUP, "K"),
  parameterFallback("lapseRate700to500", "700-500 mb Lapse Rate", SEVERE_THERMO_GROUP, "C/km"),
  parameterFallback("lapseRate0to3km", "0-3 km Lapse Rate", SEVERE_THERMO_GROUP, "C/km"),
  parameterFallback("dcape", "DCAPE", SEVERE_THERMO_GROUP, "J/kg"),
  parameterFallback("maxSimulatedHailSize", "Max Model-Simulated Hail", SEVERE_THERMO_GROUP, "in"),
  parameterFallback("srh0to1km", "0-1 km SRH", SEVERE_KINEMATICS_GROUP, "m2/s2"),
  parameterFallback("srh0to3km", "0-3 km SRH", SEVERE_KINEMATICS_GROUP, "m2/s2"),
  parameterFallback("bulkShear0to6km", "0-6 km Bulk Shear", SEVERE_KINEMATICS_GROUP, "kt"),
  parameterFallback("effectiveBulkShear", "Effective Bulk Shear", SEVERE_KINEMATICS_GROUP, "kt"),
  parameterFallback("supercellCompositeParameter", "SCP (0-3 km Proxy)", SEVERE_KINEMATICS_GROUP),
  parameterFallback("effectiveLayerSupercellCompositeParameter", "SCP (Effective Layer)", SEVERE_KINEMATICS_GROUP),
  parameterFallback("significantTornadoParameter", "STP (Fixed Layer)", SEVERE_KINEMATICS_GROUP),
  parameterFallback("effectiveLayerSignificantTornadoParameter", "STP (Effective Layer)", SEVERE_KINEMATICS_GROUP),
  parameterFallback("updraftHelicity2to5km1h", "1-h Max 2-5 km UH", SEVERE_KINEMATICS_GROUP, "m2/s2"),
  parameterFallback("updraftHelicity2to5kmRunMax", "Run Max of 1-h 2-5 km UH", SEVERE_KINEMATICS_GROUP, "m2/s2"),
  parameterFallback("wetBulbZeroHeight", "Wet-Bulb Zero (MSL)", WINTER_GROUP, "ft"),
  parameterFallback("freezingRainLiquidTotal", "Freezing Rain Liquid", WINTER_GROUP, "in"),
  parameterFallback("snowDepth", "Snow Depth (State)", WINTER_GROUP, "in"),
  parameterFallback("snowWaterEq", "Snow Water Eq (State)", WINTER_GROUP, "in"),
  parameterFallback("snow10to1", "10:1 Snow", WINTER_GROUP, "in"),
  parameterFallback("snowKuchera", "Kuchera Snow", WINTER_GROUP, "in"),
  parameterFallback("snowCobb", "Cobb Snow", WINTER_GROUP, "in"),
  parameterFallback("snowRfConus", "CONUS RF Snow", WINTER_GROUP, "in"),
  parameterFallback("snowWesternLinear", "Western HRRR Linear Snow", WINTER_GROUP, "in"),
  parameterFallback("snowHrrrAsnow", "HRRR ASNOW", WINTER_GROUP, "in"),
  parameterFallback("framFlatIce", "FRAM Flat Ice", WINTER_GROUP, "in"),
  parameterFallback("framRadialIce", "FRAM Radial Ice", WINTER_GROUP, "in"),
];
const PARAMETER_OPTION_FALLBACK_BY_KEY = new Map(PARAMETER_OPTION_FALLBACKS.map((option) => [option.key, option]));

export const MANIFEST_SCHEMA_VERSION = Number(sharedConfig.manifestSchemaVersion) || 2;
export const RAW_PIXEL_MODE = true;

export const LAYER_STACK_ORDER: LayerKey[] = sanitizeOrder(sharedConfig.layerOrder as string[] | undefined);

// MapEngine line-layer ids for the reference boundaries: shared vocabulary
// between the display hook and the engine.
export const COUNTRY_BOUNDARY_LINE_LAYER_ID = "reference-country-borders";
export const STATE_BOUNDARY_LINE_LAYER_ID = "reference-state-borders";

// Within-band stacking ranks for the engine's known line layers (consumed by
// maplibre-engine's LINE_LAYER_BAND_RANK): higher rank renders above a lower
// one inside the same anchor band, whatever order their fetches resolve. The
// values are the historical leaflet pane z-indexes, kept verbatim so the
// relative order (graticule < counties in the detail band; state < country in
// the reference band) is provably unchanged by the leaflet deletion.
export const GRATICULE_BAND_RANK = 375;
export const COUNTY_LINES_BAND_RANK = 378;
export const STATE_BORDERS_BAND_RANK = 380;
export const COUNTRY_BORDERS_BAND_RANK = 382;

// Native GL synoptic line-layer ids (Task 4.2): one id per style class
// (LineLayerStyle is a single paint, so classes that differ in color/weight/
// dash are separate layers). The object-literal order IS the bottom -> top
// stacking order inside the engine's synoptic band — the hook calls
// setLineLayer in exactly this order, and all seven ids are always set (empty
// collections included) so introspection layerOrder stays stable for specs.
export const SYNOPTIC_LINE_LAYER_IDS = {
  thicknessCold: "synoptic-thickness-cold",
  thicknessColdMajor: "synoptic-thickness-cold-major",
  thicknessWarm: "synoptic-thickness-warm",
  thicknessWarmMajor: "synoptic-thickness-warm-major",
  thicknessBoundary: "synoptic-thickness-540",
  isobars: "synoptic-isobars",
  isobarsMajor: "synoptic-isobars-major",
} as const;

// Ground-matched halo underlays for the SOLID synoptic strokes (Task 5.1):
// a slightly wider line in the basemap's own ground tone, set BEFORE every
// line/label layer above so it sits at the bottom of the synoptic band. Over
// the plain basemap it is invisible (ground on ground); over bright weather
// fills it materializes as the separation that keeps the stroke legible —
// the same trick the label halos already use, applied to lines. Dashed
// thickness lines deliberately get none (their chromatic inks stay legible
// per the Task 5.1 evidence pass, and dash-on-dash halos read as casing).
export const SYNOPTIC_LINE_HALO_LAYER_IDS = {
  isobars: "synoptic-isobars-halo",
  isobarsMajor: "synoptic-isobars-major-halo",
} as const;

// Native GL synoptic SYMBOL-layer ids (Task 4.3): contour value labels along
// every line class, plus the H/L pressure centers. Same stability rule as
// the line ids above — always set while synoptic is active (empty
// collections during frame gaps), object-literal order == bottom -> top
// stacking inside the synoptic band, ABOVE all seven line layers (the hook
// sets lines first, then labels, then centers). MapLibre resolves symbol
// collisions top-down, so the deliberate priority order is: centers (low
// over high) > 540 > major thickness > major isobars > minor thickness >
// minor isobars.
export const SYNOPTIC_LABEL_LAYER_IDS = {
  isobars: "synoptic-labels-isobars",
  thicknessCold: "synoptic-labels-thickness-cold-minor",
  thicknessWarm: "synoptic-labels-thickness-warm-minor",
  isobarsMajor: "synoptic-labels-isobars-major",
  thicknessWarmMajor: "synoptic-labels-thickness-warm",
  thicknessColdMajor: "synoptic-labels-thickness-cold",
  thicknessBoundary: "synoptic-labels-thickness-540",
} as const;

export const SYNOPTIC_CENTER_LAYER_IDS = {
  high: "synoptic-centers-high",
  low: "synoptic-centers-low",
} as const;

// Native GL height-contour layer ids, per active contour parameter (e.g.
// "height500"): single-stroke minor/major line cores and the along-line
// value-label symbol layer above them (Task 4.3). The Task-4.2 white halo
// underlay is gone — the owner round rejected the doubled/cased stroke; the
// redesigned single-stroke inks carry the emphasis hierarchy alone.
// Task 5.1 adds GROUND-MATCHED halo underlays (minorHalo/majorHalo, set
// before the cores): unlike the rejected white underlay these carry the
// basemap's own ground tone, so they are invisible over the basemap and
// only materialize over bright weather fills, where the Task 5.1 contrast
// audit showed the dark theme's platinum ink disappearing into white-hot
// temperature pixels.
export function heightContourLineLayerIds(layerKey: string): {
  minorHalo: string;
  majorHalo: string;
  minor: string;
  major: string;
  labels: string;
} {
  return {
    minorHalo: `contour-${layerKey}-halo`,
    majorHalo: `contour-${layerKey}-major-halo`,
    minor: `contour-${layerKey}`,
    major: `contour-${layerKey}-major`,
    labels: `contour-${layerKey}-labels`,
  };
}

// MapEngine line-layer ids for the detail feature layers (Display menu
// toggles), same scheme as the reference boundary ids above. Roads and place
// labels have no app-side layer since Task 6.3 — the vector basemap renders
// them and the Display toggles ride engine.setBasemapDetail instead.
export const COUNTY_LINE_LAYER_ID = "feature-county-lines";
export const GRATICULE_LINE_LAYER_ID = "feature-graticule";

// Fallback legends for panels without manifest metadata (e.g. a model with no
// built runs). All data comes straight from shared/modelview-config.json,
// which is GENERATED from the parameter catalog (scripts/
// generate-shared-layer-legends.js) — no hand-tuned gradients or tick lists
// here, so the fallback can never drift from what the renderer paints.
export const LEGEND_CONFIG: Record<Exclude<LayerKey, "synoptic">, LayerLegendConfig> = {
  temperature: buildLegend("temperature", "Temp", "°F"),
  reflectivityComposite: buildLegend("reflectivityComposite", "Composite Reflectivity", "dBZ"),
  reflectivity1km: buildLegend("reflectivity1km", "1 km AGL Reflectivity", "dBZ"),
  reflectivity1kmPrecipType: buildLegend("reflectivity1kmPrecipType", "1 km Refl + Type", "dBZ"),
  reflectivity: buildLegend("reflectivity", "Reflectivity", "dBZ*"),
  wind: buildLegend("wind", "Wind", "mph"),
  precip: buildLegend("precip", "1-h Precip", "in"),
  precip3h: buildLegend("precip3h", "3-h Precip", "in"),
  precip6h: buildLegend("precip6h", "6-h Precip", "in"),
  precip12h: buildLegend("precip12h", "12-h Precip", "in"),
  precip24h: buildLegend("precip24h", "24-h Precip", "in"),
  precipTotal: buildLegend("precipTotal", "Total Precip", "in"),
};

export function getManifestParameterOptions(manifest: ModelManifest | null | undefined): LayerDefinition[] {
  const metadata = manifest?.parameters || {};
  const orderedKeys = resolveManifestParameterOrder(manifest);
  for (const option of PARAMETER_OPTION_FALLBACKS) {
    if (!orderedKeys.includes(option.key)) {
      orderedKeys.push(option.key);
    }
  }
  for (const key of collectManifestLayerKeys(manifest)) {
    if (!orderedKeys.includes(key)) {
      orderedKeys.push(key);
    }
  }
  return orderedKeys
    .filter((key) => !HIDDEN_PARAMETER_OPTION_KEYS.has(key))
    .map((key) =>
      buildManifestParameterOption(manifest, key, metadata[key], PARAMETER_OPTION_FALLBACK_BY_KEY.get(key)),
    );
}

function buildManifestParameterOption(
  manifest: ModelManifest | null | undefined,
  key: LayerKey,
  entry: ParameterMetadata | undefined,
  fallback: LayerDefinition | undefined,
): LayerDefinition {
  return {
    key,
    label: getParameterOptionLabel(key, entry, fallback),
    group: getParameterOptionGroup(entry, fallback),
    unit: getParameterOptionUnit(entry, fallback),
    available: hasParameterOptionLayer(manifest, key, entry, fallback),
    ...getParameterOptionMethodDetails(entry),
  };
}

function getParameterOptionLabel(
  key: LayerKey,
  entry: ParameterMetadata | undefined,
  fallback: LayerDefinition | undefined,
): string {
  return entry?.label || fallback?.label || key;
}

function getParameterOptionGroup(entry: ParameterMetadata | undefined, fallback: LayerDefinition | undefined): string {
  return entry?.group || fallback?.group || "Parameters";
}

function getParameterOptionUnit(
  entry: ParameterMetadata | undefined,
  fallback: LayerDefinition | undefined,
): string | null {
  return entry?.unit ?? fallback?.unit ?? null;
}

function hasParameterOptionLayer(
  manifest: ModelManifest | null | undefined,
  key: LayerKey,
  entry: ParameterMetadata | undefined,
  fallback: LayerDefinition | undefined,
): boolean {
  return Boolean(
    isParameterSelectionEnabled(manifest, entry, fallback) &&
    hasManifestLayer(manifest, key) &&
    hasMinimumForecastHour(manifest, entry?.minForecastHour),
  );
}

// Selective builds (manifest.renderSelection present) still write the base
// "floor" layers (temperature, wind, precip, reflectivity) as empty
// transparent-PNG placeholders even when their category was deselected, so
// hasManifestLayer alone cannot distinguish INTENTIONALLY-OMITTED from
// "no echoes anywhere" (spec §2.4). Mirror the server's selectionAllows gate:
// a parameter is available only when its category is enabled AND — for
// full-tier products — the category was built at the "full" tier. When the
// stamp is ABSENT (full/default build) this is a strict no-op.
function isParameterSelectionEnabled(
  manifest: ModelManifest | null | undefined,
  entry: ParameterMetadata | undefined,
  fallback: LayerDefinition | undefined,
): boolean {
  const categories = manifest?.renderSelection?.categories;
  if (!categories || typeof categories !== "object") {
    return true;
  }
  // Deselected parameters get their metadata filtered from the manifest, so
  // fall back to the option's group to classify placeholder-only keys.
  const category = entry?.category ?? groupToRenderCategory(entry?.group ?? fallback?.group);
  if (!category) {
    return true;
  }
  const state = readRenderSelectionCategoryState(categories[category]);
  if (!state.enabled) {
    return false;
  }
  return entry?.costTier !== "full" || state.tier === "full";
}

// Mirrors the server's normalizeRenderSelection defaults (scripts/lib/
// noaa-beta/selection.js): a missing or malformed entry reads as enabled at
// full tier; bare booleans are the compact wire form for non-tiered categories.
function readRenderSelectionCategoryState(raw: unknown): { enabled: boolean; tier: "simple" | "full" } {
  if (raw === false) {
    return { enabled: false, tier: "full" };
  }
  if (raw && typeof raw === "object") {
    const state = raw as { enabled?: unknown; tier?: unknown };
    return { enabled: state.enabled !== false, tier: state.tier === "simple" ? "simple" : "full" };
  }
  return { enabled: true, tier: "full" };
}

function getParameterOptionMethodDetails(
  entry: ParameterMetadata | undefined,
): Pick<
  LayerDefinition,
  "thresholdNote" | "sourceNote" | "methodVersion" | "derivation" | "applicability" | "formulaReference"
> {
  return {
    thresholdNote: entry?.thresholdNote ?? null,
    sourceNote: entry?.sourceNote ?? null,
    methodVersion: entry?.methodVersion ?? null,
    derivation: entry?.derivation ?? null,
    applicability: entry?.applicability ?? null,
    formulaReference: entry?.formulaReference ?? null,
  };
}

export function getLayerStackOrder(manifest: ModelManifest | null | undefined, activeLayers?: Iterable<LayerKey>) {
  const order = [...LAYER_STACK_ORDER];
  const manifestOrder = resolveManifestParameterOrder(manifest);
  for (const key of manifestOrder) {
    if (key !== "synoptic" && !order.includes(key)) {
      order.push(key);
    }
  }
  if (activeLayers) {
    for (const key of activeLayers) {
      if (key !== "synoptic" && !order.includes(key)) {
        order.push(key);
      }
    }
  }
  return order;
}

export function shouldUseRawPixelRendering(_layerKey: LayerKey): boolean {
  return RAW_PIXEL_MODE;
}

export function getLayerLegendConfig(
  layerKey: LayerKey,
  manifest: ModelManifest | null | undefined,
): LayerLegendConfig | null {
  const metadata = manifest?.parameters?.[layerKey];
  if (metadata) {
    return buildLegendFromParameter(metadata);
  }
  const fixed = LEGEND_CONFIG[layerKey as Exclude<LayerKey, "synoptic">];
  return fixed || null;
}

const ROLLING_ACCUMULATION_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  precip: 1,
  precip3h: 3,
  precip6h: 6,
  precip12h: 12,
  precip24h: 24,
});

export function getFrameAwareLayerLegendConfig(
  layerKey: LayerKey,
  manifest: ModelManifest | null | undefined,
  frameHour: number | null | undefined,
): LayerLegendConfig | null {
  const legend = getLayerLegendConfig(layerKey, manifest);
  if (!legend || !Number.isFinite(frameHour)) {
    return legend;
  }
  const metadata = manifest?.parameters?.[layerKey];
  const windowHours = Number(metadata?.accumulationWindowHours ?? ROLLING_ACCUMULATION_WINDOWS[layerKey]);
  const hour = Math.max(0, Math.round(Number(frameHour)));
  const rolling = metadata?.accumulationMode
    ? metadata.accumulationMode === "rolling"
    : layerKey in ROLLING_ACCUMULATION_WINDOWS;
  if (!rolling || !Number.isFinite(windowHours) || windowHours <= 0 || hour >= windowHours) {
    return legend;
  }
  const frameLabel = `F${String(hour).padStart(3, "0")}`;
  const label = hour > 0 ? `Run-to-${frameLabel} Precip (0-${hour} h)` : `Run-start Precip (${frameLabel})`;
  const earlyWindowNote = `Partial ${windowHours}-h window: only run start through ${frameLabel} is accumulated`;
  return {
    ...legend,
    label,
    thresholdNote: legend.thresholdNote ? `${earlyWindowNote}; ${legend.thresholdNote}` : earlyWindowNote,
  };
}

function buildLegend(
  key: Exclude<LayerKey, "synoptic">,
  fallbackLabel: string,
  fallbackUnit: string,
): LayerLegendConfig {
  const layer = RAW_LAYERS[key];
  const stops = parseLegendStops(layer?.legendStops);
  const fallbackStops: [number, LegendColor][] = [
    [0, [40, 90, 140]],
    [1, [220, 80, 80]],
  ];
  const finalStops = stops.length > 1 ? stops : fallbackStops;
  return {
    key,
    label: layer?.label || fallbackLabel,
    unit: layer?.unit || fallbackUnit,
    thresholdNote: layer?.thresholdNote || null,
    legendTicks: parseLegendTicks(layer?.legendTicks),
    legendTickPositions: parseLegendTickPositions(layer?.legendTickPositions),
    legendGradientCss: legendStopsToGradient(finalStops),
    legendType: null,
    precipTypeLegend: undefined,
    precipRateTypeLegend: undefined,
    contourIntervalDam: null,
    contourLevelMb: null,
  };
}

function buildLegendFromParameter(parameter: ParameterMetadata): LayerLegendConfig {
  const stops = parseLegendStops(parameter.legendStops);
  const fallbackStops: [number, LegendColor][] = [
    [0, [40, 90, 140]],
    [1, [220, 80, 80]],
  ];
  const displayScale = resolveLegendDisplayScale(parameter, stops);
  const finalStops = applyLegendDisplayScale(stops.length > 1 ? stops : fallbackStops, displayScale.scale);
  const tickPositions = parseLegendTickPositions(parameter.legendTickPositions);
  return {
    key: parameter.key,
    label: parameter.label || parameter.key,
    unit: parameter.unit || "",
    thresholdNote: parameter.thresholdNote || null,
    legendTicks: parseLegendTicks(parameter.legendTicks),
    legendTickPositions: displayScale.transformTickPositions
      ? applyLegendPositionScale(tickPositions, displayScale.scale)
      : tickPositions,
    legendGradientCss: legendStopsToGradient(finalStops),
    legendType: parameter.legendType || null,
    precipTypeLegend: parameter.precipTypeLegend,
    precipRateTypeLegend: parameter.precipRateTypeLegend,
    contourIntervalDam: parameter.contourIntervalDam ?? null,
    contourLevelMb: parameter.contourLevelMb ?? null,
  };
}

function resolveLegendDisplayScale(
  parameter: ParameterMetadata,
  stops: [number, LegendColor][],
): { scale: LegendDisplayScale | null; transformTickPositions: boolean } {
  const explicit = normalizeLegendDisplayScale(parameter.legendDisplayScale);
  if (explicit) {
    return { scale: explicit, transformTickPositions: false };
  }
  const legacy = inferLegacyLowEndStretchScale(parameter, stops);
  return { scale: legacy, transformTickPositions: Boolean(legacy) };
}

function normalizeLegendDisplayScale(scale: ParameterMetadata["legendDisplayScale"]): LegendDisplayScale | null {
  if (!scale || typeof scale !== "object") {
    return null;
  }
  const kind = String(scale.kind || "").trim();
  if (kind !== "power") {
    return null;
  }
  const exponent = Number(scale.exponent);
  if (!Number.isFinite(exponent) || exponent <= 0 || exponent === 1) {
    return null;
  }
  return { kind, exponent };
}

function inferLegacyLowEndStretchScale(
  parameter: ParameterMetadata,
  stops: [number, LegendColor][],
): LegendDisplayScale | null {
  const label = `${parameter.key || ""} ${parameter.label || ""}`;
  const unit = String(parameter.unit || "").toLowerCase();
  const ticks = parseLegendTicks(parameter.legendTicks);
  const firstVisibleStop = stops.find(([position, color]) => position > 0 && Number(color[3] ?? 1) > 0);
  const hasSnowfallTicks = ticks.length >= 7 && ticks[0] === 0.1 && ticks.includes(6) && ticks.at(-1) === 60;
  if (!/snow/i.test(label) || unit !== "in" || !hasSnowfallTicks || !firstVisibleStop || firstVisibleStop[0] >= 0.02) {
    return null;
  }
  return { kind: "power", exponent: 0.5 };
}

function applyLegendDisplayScale(stops: [number, LegendColor][], scale: LegendDisplayScale | null) {
  if (!scale) {
    return stops;
  }
  return stops.map(
    ([position, color]) => [applyLegendPositionScaleValue(position, scale), color] as [number, LegendColor],
  );
}

function applyLegendPositionScale(positions: number[], scale: LegendDisplayScale | null) {
  if (!scale) {
    return positions;
  }
  return positions.map((position) => applyLegendPositionScaleValue(position, scale));
}

function applyLegendPositionScaleValue(position: number, scale: LegendDisplayScale) {
  const normalized = Math.max(0, Math.min(1, Number(position) || 0));
  if (scale.kind === "power") {
    return normalized ** Number(scale.exponent);
  }
  return normalized;
}

function resolveManifestParameterOrder(manifest: ModelManifest | null | undefined): string[] {
  const metadata = manifest?.parameters || {};
  const hasMetadata = Object.keys(metadata).length > 0;
  const ordered = Array.isArray(manifest?.parameterOrder) ? manifest.parameterOrder : [];
  const out: string[] = [];
  for (const key of ordered) {
    const value = String(key || "").trim();
    if (
      value &&
      !HIDDEN_PARAMETER_OPTION_KEYS.has(value) &&
      (metadata[value] || !hasMetadata || PARAMETER_OPTION_FALLBACK_BY_KEY.has(value)) &&
      !out.includes(value)
    ) {
      out.push(value);
    }
  }
  for (const key of Object.keys(metadata)) {
    if (!HIDDEN_PARAMETER_OPTION_KEYS.has(key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

function collectManifestLayerKeys(manifest: ModelManifest | null | undefined): string[] {
  const out: string[] = [];
  if (!manifest?.frames?.length) {
    return out;
  }
  for (const frame of manifest.frames) {
    const refs = [frame.layers || {}, frame.contourVectorRefs || {}, frame.weatherVectorRefs || {}] as Array<
      Record<string, unknown>
    >;
    for (const ref of refs) {
      for (const key of Object.keys(ref)) {
        if (!HIDDEN_PARAMETER_OPTION_KEYS.has(key) && !out.includes(key)) {
          out.push(key);
        }
      }
    }
  }
  return out;
}

function hasManifestLayer(manifest: ModelManifest | null | undefined, layerKey: string): boolean {
  if (!manifest?.frames?.length) {
    return true;
  }
  return manifest.frames.some(
    (frame) =>
      Boolean(frame.layers?.[layerKey]) ||
      Boolean(frame.contourVectorRefs?.[layerKey]?.key) ||
      Boolean(frame.weatherVectorRefs?.[layerKey]?.key),
  );
}

function hasMinimumForecastHour(
  manifest: ModelManifest | null | undefined,
  minForecastHour: number | null | undefined,
): boolean {
  const minHour = Number(minForecastHour);
  if (!Number.isFinite(minHour) || minHour <= 0) {
    return true;
  }
  return Boolean(manifest?.frames?.some((frame) => Number(frame.hour) >= minHour));
}

function legendStopsToGradient(stops: [number, LegendColor][]): string {
  const segments = stops.map(([position, rgb]) => {
    const pct = Math.max(0, Math.min(1, Number(position))) * 100;
    return `${legendColorToCss(rgb)} ${pct.toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${segments.join(", ")})`;
}

function parseLegendTicks(candidate: unknown): number[] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => Number(value))
    .filter(Number.isFinite);
}

function parseLegendTickPositions(candidate: unknown): number[] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => Number(value))
    .filter(Number.isFinite)
    .map((value) => Math.max(0, Math.min(1, value)));
}

function parseLegendStops(candidate: unknown): [number, LegendColor][] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  const out: [number, LegendColor][] = [];
  for (const stop of candidate) {
    if (!Array.isArray(stop) || stop.length !== 2) {
      continue;
    }
    if (stop[0] === null || stop[0] === undefined || stop[0] === "") {
      continue;
    }
    const position = Number(stop[0]);
    const colorRaw = stop[1];
    if (!Number.isFinite(position) || !Array.isArray(colorRaw) || colorRaw.length < 3) {
      continue;
    }
    if (colorRaw.slice(0, 3).some((value) => value === null || value === undefined || value === "")) {
      continue;
    }
    const color = colorRaw.map((value) => Number(value));
    if (color.slice(0, 3).some((value) => !Number.isFinite(value))) {
      continue;
    }
    const rgb: [number, number, number] = [toColorInt(color[0]), toColorInt(color[1]), toColorInt(color[2])];
    const alpha = Number.isFinite(color[3]) ? Math.max(0, Math.min(1, color[3])) : null;
    out.push([Math.max(0, Math.min(1, position)), alpha === null ? rgb : [...rgb, alpha]]);
  }
  out.sort((left, right) => left[0] - right[0]);
  return out;
}

function legendColorToCss(color: LegendColor): string {
  const alpha = Number(color[3]);
  if (Number.isFinite(alpha) && alpha < 1) {
    return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
  }
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function toColorInt(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function sanitizeOrder(input?: string[]): LayerKey[] {
  const candidate = Array.isArray(input) ? input : FALLBACK_ORDER;
  const deduped: LayerKey[] = [];
  for (const key of candidate) {
    if (isLayerKey(key) && !deduped.includes(key)) {
      deduped.push(key);
    }
  }
  for (const key of FALLBACK_ORDER) {
    if (!deduped.includes(key)) {
      deduped.push(key);
    }
  }
  return deduped;
}

function isLayerKey(value: string): value is LayerKey {
  return KNOWN_LAYER_KEYS.has(value);
}
