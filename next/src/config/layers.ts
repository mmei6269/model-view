import sharedConfig from "../../../shared/modelview-config.json";
import type { LayerDefinition, LayerKey, ModelManifest, ParameterMetadata, PrecipTypeLegendRow } from "../types";
import { scaleToGradient, TEMP_F_SCALE, WIND_MPH_SCALE } from "./colorMaps";
import { SYNOPTIC_STYLE } from "./synopticStyle";

interface SharedLayerConfig {
  label: string;
  unit: string;
  thresholdNote: string | null;
  legendTicks: unknown[];
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

const RAW_LAYERS = (sharedConfig.layers || {}) as Record<string, SharedLayerConfig>;
const DYNAMIC_LAYER_PANE = "wx-dynamic-pane";
const DYNAMIC_LAYER_Z_INDEX = 365;
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
  parameterFallback("pblHeight", "PBL Height", SURFACE_BOUNDARY_GROUP, "m"),
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
  parameterFallback("cloudCeiling", "Cloud Ceiling", CLOUD_GROUP, "ft"),
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
  parameterFallback("surfaceBasedLclHeight", "Surface LCL", SEVERE_THERMO_GROUP, "m"),
  parameterFallback("surfaceThetaE", "Surface Theta-e", SEVERE_THERMO_GROUP, "K"),
  parameterFallback("lapseRate700to500", "700-500 mb Lapse Rate", SEVERE_THERMO_GROUP, "C/km"),
  parameterFallback("lapseRate0to3km", "0-3 km Lapse Rate", SEVERE_THERMO_GROUP, "C/km"),
  parameterFallback("dcape", "DCAPE", SEVERE_THERMO_GROUP, "J/kg"),
  parameterFallback("maxSimulatedHailSize", "Max Hail Size", SEVERE_THERMO_GROUP, "in"),
  parameterFallback("srh0to1km", "0-1 km SRH", SEVERE_KINEMATICS_GROUP, "m2/s2"),
  parameterFallback("srh0to3km", "0-3 km SRH", SEVERE_KINEMATICS_GROUP, "m2/s2"),
  parameterFallback("bulkShear0to6km", "0-6 km Bulk Shear", SEVERE_KINEMATICS_GROUP, "kt"),
  parameterFallback("effectiveBulkShear", "Effective Bulk Shear", SEVERE_KINEMATICS_GROUP, "kt"),
  parameterFallback("supercellCompositeParameter", "SCP (0-3 km Proxy)", SEVERE_KINEMATICS_GROUP),
  parameterFallback("effectiveLayerSupercellCompositeParameter", "SCP (Effective Layer)", SEVERE_KINEMATICS_GROUP),
  parameterFallback("significantTornadoParameter", "STP (Fixed Layer)", SEVERE_KINEMATICS_GROUP),
  parameterFallback("effectiveLayerSignificantTornadoParameter", "STP (Effective Layer)", SEVERE_KINEMATICS_GROUP),
  parameterFallback("updraftHelicity2to5km1h", "2-5 km UH", SEVERE_KINEMATICS_GROUP, "m2/s2"),
  parameterFallback("updraftHelicity2to5kmRunMax", "Run Max 2-5 km UH", SEVERE_KINEMATICS_GROUP, "m2/s2"),
  parameterFallback("wetBulbZeroHeight", "Wet Bulb Zero", WINTER_GROUP, "ft"),
  parameterFallback("freezingRainLiquidTotal", "Freezing Rain Liquid", WINTER_GROUP, "in"),
  parameterFallback("snowDepth", "Snow Depth", WINTER_GROUP, "in"),
  parameterFallback("snowWaterEq", "Snow Water Eq", WINTER_GROUP, "in"),
  parameterFallback("snow10to1", "10:1 Snow", WINTER_GROUP, "in"),
  parameterFallback("snowKuchera", "Kuchera Snow", WINTER_GROUP, "in"),
  parameterFallback("snowCobb", "Cobb Snow", WINTER_GROUP, "in"),
  parameterFallback("snowRfConus", "RF Snow", WINTER_GROUP, "in"),
  parameterFallback("snowWesternLinear", "Western Linear Snow", WINTER_GROUP, "in"),
  parameterFallback("snowHrrrAsnow", "HRRR ASNOW", WINTER_GROUP, "in"),
  parameterFallback("framFlatIce", "FRAM Flat Ice", WINTER_GROUP, "in"),
  parameterFallback("framRadialIce", "FRAM Radial Ice", WINTER_GROUP, "in"),
];
const PARAMETER_OPTION_FALLBACK_BY_KEY = new Map(PARAMETER_OPTION_FALLBACKS.map((option) => [option.key, option]));

export const MANIFEST_SCHEMA_VERSION = Number(sharedConfig.manifestSchemaVersion) || 2;
export const RAW_PIXEL_MODE = true;
export const WEATHER_OVERLAY_CLASS = "wx-weather-overlay";
export const SYNOPTIC_STYLE_VERSION = String(SYNOPTIC_STYLE.styleVersion || "v1-operational-contrast");

export const LAYER_STACK_ORDER: LayerKey[] = sanitizeOrder(sharedConfig.layerOrder as string[] | undefined);

export const LAYER_PANES: Record<LayerKey, string> = {
  temperature: "wx-temp-pane",
  wind: "wx-wind-pane",
  precip: "wx-precip-pane",
  precip3h: "wx-precip-pane",
  precip6h: "wx-precip-pane",
  precip12h: "wx-precip-pane",
  precip24h: "wx-precip-pane",
  precipTotal: "wx-precip-pane",
  reflectivityComposite: "wx-reflectivity-pane",
  reflectivity1km: "wx-reflectivity-1km-pane",
  reflectivity1kmPrecipType: "wx-reflectivity-ptype-pane",
  reflectivity: "wx-reflectivity-pane",
  synoptic: "wx-synoptic-isobar-pane",
};

export const LAYER_Z_INDEX: Record<LayerKey, number> = {
  temperature: 340,
  wind: 350,
  precip: 360,
  precip3h: 361,
  precip6h: 362,
  precip12h: 363,
  precip24h: 364,
  precipTotal: 365,
  reflectivityComposite: 370,
  reflectivity1km: 371,
  reflectivity1kmPrecipType: 372,
  reflectivity: 370,
  synoptic: 410,
};

export const DYNAMIC_PARAMETER_PANE = DYNAMIC_LAYER_PANE;
export const HEIGHT_CONTOUR_PANE = "wx-height-contour-pane";
export const HEIGHT_CONTOUR_Z_INDEX = 430;
export const WEATHER_VECTOR_PANE = "wx-weather-vector-pane";
export const WEATHER_VECTOR_Z_INDEX = 440;

export const SYNOPTIC_THICKNESS_PANE = "wx-synoptic-thickness-pane";
export const SYNOPTIC_ISOBAR_PANE = "wx-synoptic-isobar-pane";
export const SYNOPTIC_MARKER_PANE = "wx-synoptic-marker-pane";
export const SYNOPTIC_THICKNESS_Z_INDEX = 390;
export const SYNOPTIC_ISOBAR_Z_INDEX = 410;
export const SYNOPTIC_MARKER_Z_INDEX = 650;

export const STATE_BORDERS_PANE = "wx-state-borders-pane";
export const STATE_BORDERS_Z_INDEX = 380;
export const COUNTRY_BORDERS_PANE = "wx-country-borders-pane";
export const COUNTRY_BORDERS_Z_INDEX = 382;

export const LABELS_PANE = "wx-labels-pane";
export const LABELS_Z_INDEX = 450;

export const LEGEND_CONFIG: Record<Exclude<LayerKey, "synoptic">, LayerLegendConfig> = {
  temperature: {
    ...buildLegend("temperature", "Temp", "°F"),
    legendGradientCss: buildTemperatureLegendGradient(),
    legendTicks: [-60, -40, -20, 0, 32, 50, 70, 90, 110, 120],
  },
  reflectivityComposite: buildLegend("reflectivityComposite", "Composite Reflectivity", "dBZ"),
  reflectivity1km: buildLegend("reflectivity1km", "1 km AGL Reflectivity", "dBZ"),
  reflectivity1kmPrecipType: buildLegend("reflectivity1kmPrecipType", "1 km Refl + Type", "dBZ"),
  reflectivity: buildLegend("reflectivity", "Reflectivity", "dBZ*"),
  wind: {
    ...buildLegend("wind", "Wind", "mph"),
    legendGradientCss: buildWindLegendGradient(),
    legendTicks: [0, 10, 20, 30, 40, 50, 60],
  },
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
    available: hasParameterOptionLayer(manifest, key, entry),
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
): boolean {
  return Boolean(hasManifestLayer(manifest, key) && hasMinimumForecastHour(manifest, entry?.minForecastHour));
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

export function getLayerPane(layerKey: LayerKey): string {
  return LAYER_PANES[layerKey] || DYNAMIC_LAYER_PANE;
}

export function getLayerZIndex(layerKey: LayerKey, indexOffset = 0): number {
  return LAYER_Z_INDEX[layerKey] || DYNAMIC_LAYER_Z_INDEX + indexOffset;
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
    legendTickPositions: [],
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

function buildWindLegendGradient(): string {
  const min = WIND_MPH_SCALE.min;
  const max = WIND_MPH_SCALE.max;
  const span = Math.max(1e-9, max - min);
  const segments = [];
  for (const stop of WIND_MPH_SCALE.valueStops) {
    const pct = ((stop.value - min) / span) * 100;
    segments.push(`${legendColorToCss([...stop.rgb, stop.alpha])} ${pct.toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${segments.join(", ")})`;
}

function buildTemperatureLegendGradient(): string {
  return scaleToGradient(TEMP_F_SCALE.valueStops);
}

function parseLegendTicks(candidate: unknown): number[] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.map((value) => Number(value)).filter(Number.isFinite);
}

function parseLegendTickPositions(candidate: unknown): number[] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate
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
    const position = Number(stop[0]);
    const colorRaw = stop[1];
    if (!Number.isFinite(position) || !Array.isArray(colorRaw) || colorRaw.length < 3) {
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
  return (
    value === "temperature" ||
    value === "reflectivityComposite" ||
    value === "reflectivity1km" ||
    value === "reflectivity" ||
    value === "wind" ||
    value === "precip" ||
    value === "precip3h" ||
    value === "precip6h" ||
    value === "precip12h" ||
    value === "precip24h" ||
    value === "precipTotal" ||
    value === "synoptic"
  );
}
