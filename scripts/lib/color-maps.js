"use strict";

const fs = require("fs");
const path = require("path");

const COLOR_MAP_PATH = path.resolve(__dirname, "../../shared/color-mapping-v2.json");
const KNOTS_TO_MPH = 1.1507794480235425;

let cached = null;

function loadColorMaps() {
  if (cached) {
    return cached;
  }
  const raw = fs.readFileSync(COLOR_MAP_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const surface = loadSurfaceColorMaps(parsed);
  const upperAir = loadUpperAirColorMaps(parsed, surface.temperature, surface.wind);
  const thresholds = loadWindThresholds(parsed && parsed.notes, surface.wind, surface.windGustMph);
  cached = Object.freeze({
    temperatureF: surface.temperature,
    dewPointF: surface.dewPoint,
    temperature850C: upperAir.temperature850C,
    temperature700C: upperAir.temperature700C,
    temperature500C: upperAir.temperature500C,
    humidityPct: surface.humidity,
    cloudCoverPct: surface.cloudCover,
    precipIn: surface.precip,
    precipMm: surface.precip,
    reflectivityDbz: surface.reflectivity,
    visibilityMi: surface.visibility,
    windKt: surface.wind,
    windMph: surface.windMph,
    windGustMph: surface.windGustMph,
    wind850Kt: upperAir.wind700850Kt,
    wind700Kt: upperAir.wind700850Kt,
    wind500Kt: upperAir.wind500Kt,
    wind250Kt: upperAir.wind250Kt,
    windBelowMinHex: thresholds.windBelowMinHex,
    windBelowMinKt: thresholds.windBelowMinKt,
    windBelowMinMph: thresholds.windBelowMinMph,
    windGustBelowMinHex: thresholds.windGustBelowMinHex,
    windGustBelowMinMph: thresholds.windGustBelowMinMph,
    windBelow10Hex: thresholds.windBelowMinHex,
    path: COLOR_MAP_PATH,
  });
  return cached;
}

function loadSurfaceColorMaps(parsed) {
  const temperature = normalizeHexScale(parsed && parsed.temp_f);
  const wind = normalizeHexScale(parsed && parsed.wind_kt);
  const windMph = normalizeOptionalHexScale(parsed && parsed.wind_mph, () => convertScaleValues(wind, KNOTS_TO_MPH));
  const windGustMph = normalizeOptionalHexScale(parsed && parsed.wind_gust_mph, windMph);
  const precip = normalizeHexScale((parsed && parsed.precip_in) || (parsed && parsed.precip_mm));
  return {
    temperature,
    dewPoint: normalizeHexScale(parsed && parsed.dew_point_f),
    humidity: normalizeHexScale(parsed && parsed.relative_humidity_pct),
    cloudCover: normalizeHexScale(parsed && parsed.cloud_cover_pct),
    precip,
    reflectivity: normalizeHexScale(parsed && parsed.reflectivity_dbz),
    visibility: normalizeHexScale(parsed && parsed.visibility_mi),
    wind,
    windMph,
    windGustMph,
  };
}

function loadUpperAirColorMaps(parsed, temperature, wind) {
  const celsiusTemperature = () => mapScaleValues(temperature, fahrenheitToCelsius);
  const wind700850Kt = normalizeOptionalHexScale(parsed && parsed.wind_700_850mb_kt, wind);
  const wind500Kt = normalizeOptionalHexScale(parsed && parsed.wind_500mb_kt, wind700850Kt);
  return {
    temperature850C: normalizeOptionalHexScale(parsed && parsed.temp_850mb_c, celsiusTemperature),
    temperature700C: normalizeOptionalHexScale(parsed && parsed.temp_700mb_c, celsiusTemperature),
    temperature500C: normalizeOptionalHexScale(parsed && parsed.temp_500mb_c, celsiusTemperature),
    wind700850Kt,
    wind500Kt,
    wind250Kt: normalizeOptionalHexScale(parsed && parsed.wind_250mb_kt, wind500Kt),
  };
}

function loadWindThresholds(notes, wind, windGustMph) {
  const windBelowMinHex = normalizeHexColor(
    (notes && notes.wind_below_min_hex) || (notes && notes.wind_below_10_kt),
    "#FEFEFE",
  );
  const windBelowMinKt = numberOr(notes && notes.wind_below_min_kt, wind.min);
  return {
    windBelowMinHex,
    windBelowMinKt,
    windBelowMinMph: numberOr(notes && notes.wind_below_min_mph, windBelowMinKt * KNOTS_TO_MPH),
    windGustBelowMinHex: normalizeHexColor(notes && notes.wind_gust_below_min_hex, windBelowMinHex),
    windGustBelowMinMph: numberOr(notes && notes.wind_gust_below_min_mph, windGustMph.min),
  };
}

function convertScaleValues(scale, factor) {
  return mapScaleValues(scale, (value) => value * factor);
}

function normalizeOptionalHexScale(candidate, fallback) {
  if (Array.isArray(candidate)) {
    return normalizeHexScale(candidate);
  }
  return typeof fallback === "function" ? fallback() : fallback;
}

function mapScaleValues(scale, mapValue) {
  const rows = (scale.valueStops || []).map(([value, rgb, alpha]) => [mapValue(value), rgbToHex(rgb), alpha]);
  return normalizeHexScale(rows);
}

function numberOr(candidate, fallback) {
  const value = Number(candidate);
  return Number.isFinite(value) ? value : fallback;
}

function fahrenheitToCelsius(value) {
  return ((value - 32) * 5) / 9;
}

function normalizeHexScale(candidate) {
  if (!Array.isArray(candidate) || candidate.length < 2) {
    throw new Error("Invalid color scale: expected at least 2 stops.");
  }
  const valueStops = [];
  for (const row of candidate) {
    if (!Array.isArray(row) || row.length < 2) {
      continue;
    }
    const value = Number(row[0]);
    const rgb = hexToRgb(row[1]);
    if (!Number.isFinite(value) || !rgb) {
      continue;
    }
    const alpha = normalizeAlpha(row[2]);
    valueStops.push([value, rgb, alpha]);
  }
  if (valueStops.length < 2) {
    throw new Error("Invalid color scale: unable to parse stops.");
  }
  valueStops.sort((left, right) => left[0] - right[0]);
  const min = valueStops[0][0];
  const max = valueStops[valueStops.length - 1][0];
  const span = Math.max(1e-9, max - min);
  const normalizedStops = valueStops.map(([value, rgb]) => [clamp01((value - min) / span), rgb]);
  const normalizedRgbaStops = valueStops.map(([value, rgb, alpha]) => [clamp01((value - min) / span), [...rgb, alpha]]);
  return {
    min,
    max,
    valueStops,
    normalizedStops,
    normalizedRgbaStops,
  };
}

function normalizeAlpha(candidate) {
  const alpha = Number(candidate);
  return Number.isFinite(alpha) ? clamp01(alpha) : 1;
}

function normalizeHexColor(candidate, fallbackHex) {
  const parsed = hexToRgb(candidate);
  if (parsed) {
    return rgbToHex(parsed);
  }
  const fallback = hexToRgb(fallbackHex);
  return rgbToHex(fallback || [254, 254, 254]);
}

function hexToRgb(input) {
  const text = String(input || "").trim();
  if (!text) {
    return null;
  }
  const hex = text.startsWith("#") ? text.slice(1) : text;
  const normalized =
    hex.length === 3
      ? hex
          .split("")
          .map((piece) => `${piece}${piece}`)
          .join("")
      : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return null;
  }
  const value = Number.parseInt(normalized, 16);
  return [clampInt((value >> 16) & 255, 0, 255), clampInt((value >> 8) & 255, 0, 255), clampInt(value & 255, 0, 255)];
}

function rgbToHex(rgb) {
  const parts = rgb.map((value) => clampInt(value, 0, 255).toString(16).padStart(2, "0"));
  return `#${parts.join("")}`.toUpperCase();
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

function clampInt(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(num)));
}

module.exports = {
  COLOR_MAP_PATH,
  loadColorMaps,
};
