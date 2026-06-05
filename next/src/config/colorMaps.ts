import rawColorMaps from "../../../shared/color-mapping-v2.json";

export interface ValueStop {
  value: number;
  rgb: [number, number, number];
  alpha: number;
}

export interface ParsedColorScale {
  min: number;
  max: number;
  valueStops: ValueStop[];
  normalizedStops: [number, [number, number, number]][];
  normalizedRgbaStops: [number, [number, number, number, number]][];
}

interface RawColorMaps {
  temp_f?: unknown;
  wind_kt?: unknown;
  wind_mph?: unknown;
  wind_gust_mph?: unknown;
  visibility_mi?: unknown;
  dew_point_f?: unknown;
  relative_humidity_pct?: unknown;
  notes?: {
    wind_below_10_kt?: string;
    wind_below_min_hex?: string;
    wind_below_min_kt?: unknown;
    wind_below_min_mph?: unknown;
    wind_gust_below_min_hex?: string;
    wind_gust_below_min_mph?: unknown;
  };
}

const RAW = rawColorMaps as RawColorMaps;
const KNOTS_TO_MPH = 1.1507794480235425;

export const TEMP_F_SCALE = parseColorScale(RAW.temp_f);
export const WIND_KT_SCALE = parseColorScale(RAW.wind_kt);
export const WIND_MPH_SCALE = RAW.wind_mph
  ? parseColorScale(RAW.wind_mph)
  : convertScaleValues(WIND_KT_SCALE, KNOTS_TO_MPH);
export const WIND_GUST_MPH_SCALE = RAW.wind_gust_mph ? parseColorScale(RAW.wind_gust_mph) : WIND_MPH_SCALE;
export const VISIBILITY_MI_SCALE = parseColorScale(RAW.visibility_mi);
export const DEW_POINT_F_SCALE = parseColorScale(RAW.dew_point_f);
export const RH_PCT_SCALE = parseColorScale(RAW.relative_humidity_pct);
export const WIND_BELOW_MIN_HEX = normalizeHex(RAW.notes?.wind_below_min_hex || RAW.notes?.wind_below_10_kt, "#FEFEFE");
export const WIND_BELOW_MIN_KT = Number.isFinite(Number(RAW.notes?.wind_below_min_kt))
  ? Number(RAW.notes?.wind_below_min_kt)
  : WIND_KT_SCALE.min;
export const WIND_BELOW_MIN_MPH = Number.isFinite(Number(RAW.notes?.wind_below_min_mph))
  ? Number(RAW.notes?.wind_below_min_mph)
  : WIND_BELOW_MIN_KT * KNOTS_TO_MPH;
export const WIND_GUST_BELOW_MIN_HEX = normalizeHex(RAW.notes?.wind_gust_below_min_hex, WIND_BELOW_MIN_HEX);
export const WIND_GUST_BELOW_MIN_MPH = Number.isFinite(Number(RAW.notes?.wind_gust_below_min_mph))
  ? Number(RAW.notes?.wind_gust_below_min_mph)
  : WIND_GUST_MPH_SCALE.min;
export const WIND_BELOW_10_HEX = WIND_BELOW_MIN_HEX;

export function parseColorScale(candidate: unknown): ParsedColorScale {
  if (!Array.isArray(candidate) || candidate.length < 2) {
    throw new Error("Invalid color scale.");
  }
  const valueStops: ValueStop[] = [];
  for (const row of candidate) {
    if (!Array.isArray(row) || row.length < 2) {
      continue;
    }
    const value = Number(row[0]);
    const rgb = hexToRgb(row[1]);
    if (!Number.isFinite(value) || !rgb) {
      continue;
    }
    valueStops.push({ value, rgb, alpha: normalizeAlpha(row[2]) });
  }
  if (valueStops.length < 2) {
    throw new Error("Invalid color scale stops.");
  }
  valueStops.sort((left, right) => left.value - right.value);
  const min = valueStops[0].value;
  const max = valueStops[valueStops.length - 1].value;
  const span = Math.max(1e-9, max - min);
  const normalizedStops: [number, [number, number, number]][] = valueStops.map((stop) => [
    clamp01((stop.value - min) / span),
    stop.rgb,
  ]);
  const normalizedRgbaStops: [number, [number, number, number, number]][] = valueStops.map((stop) => [
    clamp01((stop.value - min) / span),
    [...stop.rgb, stop.alpha],
  ]);
  return {
    min,
    max,
    valueStops,
    normalizedStops,
    normalizedRgbaStops,
  };
}

export function scaleToGradient(stops: ValueStop[]): string {
  if (!Array.isArray(stops) || stops.length < 2) {
    return "linear-gradient(90deg, rgb(40,90,140) 0%, rgb(220,80,80) 100%)";
  }
  const min = stops[0].value;
  const max = stops[stops.length - 1].value;
  const span = Math.max(1e-9, max - min);
  const parts = stops.map((stop) => {
    const pct = clamp01((stop.value - min) / span) * 100;
    return `rgb(${stop.rgb[0]}, ${stop.rgb[1]}, ${stop.rgb[2]}) ${pct.toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

function convertScaleValues(scale: ParsedColorScale, factor: number): ParsedColorScale {
  return parseColorScale(scale.valueStops.map((stop) => [stop.value * factor, rgbToHex(stop.rgb), stop.alpha]));
}

function hexToRgb(input: unknown): [number, number, number] | null {
  const text = String(input || "").trim();
  if (!text) {
    return null;
  }
  const hex = text.startsWith("#") ? text.slice(1) : text;
  const normalized =
    hex.length === 3
      ? hex
          .split("")
          .map((value) => `${value}${value}`)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return null;
  }
  const num = Number.parseInt(normalized, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function normalizeHex(input: unknown, fallback: string): string {
  const rgb = hexToRgb(input) || hexToRgb(fallback) || [254, 254, 254];
  return `#${rgb
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function normalizeAlpha(input: unknown): number {
  const alpha = Number(input);
  return Number.isFinite(alpha) ? clamp01(alpha) : 1;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
