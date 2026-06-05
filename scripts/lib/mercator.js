"use strict";

const WEB_MERCATOR_MAX_LAT = 85.05112878;

function latToMercatorY(latDeg) {
  const clamped = clampLatitude(latDeg);
  if (!Number.isFinite(clamped)) {
    return Number.NaN;
  }
  const rad = toRad(clamped);
  return Math.log(Math.tan(Math.PI * 0.25 + rad * 0.5));
}

function mercatorYToLat(mercatorY) {
  if (!Number.isFinite(mercatorY)) {
    return Number.NaN;
  }
  const latRad = 2 * Math.atan(Math.exp(mercatorY)) - Math.PI / 2;
  return clampLatitude(toDeg(latRad));
}

function rowToLatMercator(row, rowCount, bounds) {
  const rows = Number(rowCount);
  if (!bounds || !Number.isFinite(rows) || rows < 2) {
    return Number.NaN;
  }
  const span = rows - 1;
  const t = clamp(Number(row) / span, 0, 1);
  const north = Number(bounds.north);
  const south = Number(bounds.south);
  const northY = latToMercatorY(north);
  const southY = latToMercatorY(south);
  if (!Number.isFinite(northY) || !Number.isFinite(southY) || Math.abs(southY - northY) < 1e-12) {
    return north - t * (north - south);
  }
  const y = northY + t * (southY - northY);
  return mercatorYToLat(y);
}

function latToRowMercator(lat, rowCount, bounds) {
  const rows = Number(rowCount);
  if (!bounds || !Number.isFinite(rows) || rows < 2) {
    return Number.NaN;
  }
  const span = rows - 1;
  const north = Number(bounds.north);
  const south = Number(bounds.south);
  const northY = latToMercatorY(north);
  const southY = latToMercatorY(south);
  const latY = latToMercatorY(lat);
  if (
    !Number.isFinite(northY) ||
    !Number.isFinite(southY) ||
    !Number.isFinite(latY) ||
    Math.abs(southY - northY) < 1e-12
  ) {
    return ((north - Number(lat)) / Math.max(1e-12, north - south)) * span;
  }
  const t = (latY - northY) / (southY - northY);
  return clamp(t, 0, 1) * span;
}

function clampLatitude(latDeg) {
  const lat = Number(latDeg);
  if (!Number.isFinite(lat)) {
    return Number.NaN;
  }
  return clamp(lat, -WEB_MERCATOR_MAX_LAT, WEB_MERCATOR_MAX_LAT);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Math.max(min, Math.min(max, value));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

module.exports = {
  WEB_MERCATOR_MAX_LAT,
  latToMercatorY,
  mercatorYToLat,
  rowToLatMercator,
  latToRowMercator,
};
