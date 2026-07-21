import type { HoverGridPayload, HoverGridVariable, HoverGridVariableKey } from "../../types";

export interface HoverValues {
  byLayer: Record<string, number | null>;
  temperatureF: number | null;
  dewpoint2mF: number | null;
  humidity2mPct: number | null;
  windKt: number | null;
  precipMm: number | null;
  reflectivityDbz: number | null;
  reflectivityCompositeDbz: number | null;
  reflectivity1kmDbz: number | null;
  pressureHpa: number | null;
}

export const EMPTY_HOVER: HoverValues = {
  byLayer: {},
  temperatureF: null,
  dewpoint2mF: null,
  humidity2mPct: null,
  windKt: null,
  precipMm: null,
  reflectivityDbz: null,
  reflectivityCompositeDbz: null,
  reflectivity1kmDbz: null,
  pressureHpa: null,
};

export function describeMissingHoverValue(layerKey: string, values: Record<string, number | null>): string | null {
  if (
    layerKey === "cloudCeiling" &&
    !Number.isFinite(values.cloudCeiling) &&
    Number.isFinite(values.cloudCover) &&
    Number(values.cloudCover) < 50
  ) {
    return "No ceiling";
  }
  return null;
}

const WEB_MERCATOR_MAX_LAT = 85.05112878;

interface HoverBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export function sampleHoverValuesAtPoint({
  hoverGrid,
  bounds,
  lat,
  lon,
}: {
  hoverGrid: HoverGridPayload;
  bounds: HoverBounds;
  lat: number;
  lon: number;
}): HoverValues {
  const byLayer: Record<string, number | null> = {};
  for (const key of Object.keys(hoverGrid?.variables || {})) {
    byLayer[key] = toFinite(sampleHoverVariableAtPoint(hoverGrid, bounds, lat, lon, key));
  }
  applyLegacyHoverFallbacks(byLayer);

  const temperatureF = finiteOr(byLayer.temperature, byLayer.temperatureF);
  const dewpoint2mF = finiteOr(byLayer.dewpoint2m, byLayer.dewpoint2mF);
  const humidity2mPct = finiteOr(byLayer.humidity2m, byLayer.humidity2mPct);
  const windKt = finiteOr(byLayer.windKt, mphToKnots(byLayer.wind));
  const precipMm = finiteOr(byLayer.precipMm, inchesToMm(byLayer.precip));
  const reflectivityCompositeDbz = finiteOr(byLayer.reflectivityComposite, byLayer.reflectivityCompositeDbz);
  const reflectivity1kmDbz = finiteOr(byLayer.reflectivity1km, byLayer.reflectivity1kmDbz);
  const pressureHpa = byLayer.pressureHpa;

  return {
    byLayer,
    temperatureF,
    dewpoint2mF,
    humidity2mPct,
    windKt,
    precipMm,
    reflectivityDbz: toFinite(byLayer.reflectivity),
    reflectivityCompositeDbz,
    reflectivity1kmDbz,
    pressureHpa: toFinite(pressureHpa),
  };
}

function applyLegacyHoverFallbacks(byLayer: Record<string, number | null>): void {
  assignFallback(byLayer, "temperature", byLayer.temperatureF);
  assignFallback(byLayer, "dewpoint2m", byLayer.dewpoint2mF);
  assignFallback(byLayer, "humidity2m", byLayer.humidity2mPct);
  assignFallback(byLayer, "wind", knotsToMph(byLayer.windKt));
  assignFallback(byLayer, "precip", mmToInches(byLayer.precipMm));
  assignFallback(byLayer, "reflectivityComposite", byLayer.reflectivityCompositeDbz);
  assignFallback(byLayer, "reflectivity1km", byLayer.reflectivity1kmDbz);
  assignFallback(byLayer, "reflectivity1kmPrecipType", byLayer.reflectivity1km);
  assignFallback(byLayer, "reflectivity", byLayer.reflectivityComposite);
  assignFallback(byLayer, "cape", byLayer.capeJkg);
}

function assignFallback(byLayer: Record<string, number | null>, key: string, value: number | null | undefined): void {
  if (Number.isFinite(byLayer[key]) || !Number.isFinite(value)) {
    return;
  }
  byLayer[key] = value as number;
}

export function sampleHoverVariableAtPoint(
  hoverGrid: HoverGridPayload,
  bounds: HoverBounds,
  lat: number,
  lon: number,
  key: HoverGridVariableKey,
): number | null {
  if (!hoverGrid || !hoverGrid.variables) {
    return null;
  }
  const variable = hoverGrid.variables[key];
  const values = variable?.values;
  if (!variable || !(values instanceof Int16Array)) {
    return null;
  }

  const rows = Number(hoverGrid.rows);
  const cols = Number(hoverGrid.cols);
  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 1 || cols < 1) {
    return null;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const lonSpan = bounds.east - bounds.west;
  if (!Number.isFinite(lonSpan) || lonSpan <= 0) {
    return null;
  }

  const fx = ((lon - bounds.west) / lonSpan) * (cols - 1);
  const fy = latToMercatorRow(lat, rows, bounds);
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fy < 0 || fx > cols - 1 || fy > rows - 1) {
    return null;
  }

  // The displayed PNG is a nearest-cell raster. Sampling the same cell keeps
  // the analyst readout visually honest at sharp fronts, maxima, and mask
  // boundaries while also avoiding four-sample interpolation work.
  const x = Math.max(0, Math.min(cols - 1, Math.round(fx)));
  const y = Math.max(0, Math.min(rows - 1, Math.round(fy)));
  const value = decodeHoverSample(values[y * cols + x], variable);
  return Number.isFinite(value) ? value : null;
}

function decodeHoverSample(value: number, variable: HoverGridVariable): number {
  const missing = Number(variable?.missing);
  const scale = Number(variable?.scale);
  const offset = Number(variable?.offset);
  const sample = Number(value);
  if (!Number.isFinite(sample) || sample === missing) {
    return Number.NaN;
  }
  if (!Number.isFinite(scale) || !Number.isFinite(offset)) {
    return Number.NaN;
  }
  return sample * scale + offset;
}

function latToMercatorRow(lat: number, rows: number, bounds: HoverBounds): number {
  const northY = latToMercatorY(bounds.north);
  const southY = latToMercatorY(bounds.south);
  const targetY = latToMercatorY(lat);
  if (
    !Number.isFinite(northY) ||
    !Number.isFinite(southY) ||
    !Number.isFinite(targetY) ||
    Math.abs(southY - northY) < 1e-12
  ) {
    const latSpan = bounds.north - bounds.south;
    if (!Number.isFinite(latSpan) || latSpan <= 0) {
      return Number.NaN;
    }
    return ((bounds.north - lat) / latSpan) * (rows - 1);
  }
  const t = (targetY - northY) / (southY - northY);
  return t * (rows - 1);
}

function latToMercatorY(latDeg: number): number {
  const clamped = clamp(latDeg, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
  const rad = (clamped * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI * 0.25 + rad * 0.5));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  return Math.max(min, Math.min(max, value));
}

function toFinite(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function finiteOr(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return value as number;
    }
  }
  return null;
}

function knotsToMph(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? (value as number) * 1.1507794480235425 : null;
}

function mphToKnots(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? (value as number) / 1.1507794480235425 : null;
}

function mmToInches(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? (value as number) / 25.4 : null;
}

function inchesToMm(value: number | null | undefined): number | null {
  return Number.isFinite(value) ? (value as number) * 25.4 : null;
}
