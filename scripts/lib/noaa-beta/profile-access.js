"use strict";

const { dewpointFromTempRhK } = require("./thermo");

const PROFILE_VARIABLE_PREFIX = Object.freeze({
  TMP: "profileTmp",
  HGT: "profileHgt",
  RH: "profileRh",
  DPT: "profileDpt",
  SPFH: "profileSpfh",
  PRES: "profilePres",
  VVEL: "profileVvel",
  UGRD: "profileU",
  VGRD: "profileV",
});

const PROFILE_SURFACE_DECODE_KEYS = Object.freeze({
  HGT: "profileSurfaceHeight",
  TMP: "temperature2m",
  RH: "humidity2m",
  DPT: "dewpoint2m",
  SPFH: "derivedSpecificHumidity2m",
  PRES: "derivedSurfacePressure",
  UGRD: "windU10m",
  VGRD: "windV10m",
});

function profileDecodeKey(variable, level) {
  const prefix = PROFILE_VARIABLE_PREFIX[variable] || `profile${String(variable || "").toLowerCase()}`;
  return `${prefix}${Math.round(Number(level))}`;
}

function profileDataGrid(decoded, variable, level) {
  if (!decoded) {
    return null;
  }
  return decoded[profileDecodeKey(variable, level)] || decoded[standardProfileDecodeKey(variable, level)] || null;
}

function surfaceDewpointK(decoded, index) {
  const direct = gridValue(decoded?.dewpoint2m, index);
  if (Number.isFinite(direct)) {
    return direct;
  }
  const tempK = profileValue(decoded, "TMP", "surface", index);
  const rh = profileValue(decoded, "RH", "surface", index);
  return dewpointFromTempRhK(tempK, rh);
}

function surfacePressureHpa(decoded, index) {
  const surfacePressure = gridValue(decoded?.derivedSurfacePressure, index);
  if (Number.isFinite(surfacePressure) && surfacePressure > 1000) {
    return surfacePressure / 100;
  }
  const mslp = gridValue(decoded?.pressureMsl, index);
  if (!Number.isFinite(mslp)) {
    return Number.NaN;
  }
  const mslpHpa = mslp / 100;
  const elevation = profileValue(decoded, "HGT", "surface", index);
  const tempK = profileValue(decoded, "TMP", "surface", index);
  if (!Number.isFinite(elevation) || !Number.isFinite(tempK) || elevation <= 1) {
    return mslpHpa;
  }
  const lapseRate = 0.0065;
  const denominator = tempK + lapseRate * elevation;
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return mslpHpa;
  }
  return mslpHpa * Math.pow(1 - (lapseRate * elevation) / denominator, 5.257);
}

function profileValue(decoded, variable, level, index) {
  return gridValue(resolveProfileGrid(decoded, variable, level), index);
}

function standardProfileDecodeKey(variable, level) {
  const normalizedLevel = Math.round(Number(level));
  if (!Number.isFinite(normalizedLevel)) {
    return null;
  }
  if (variable === "TMP") {
    return `temp${normalizedLevel}`;
  }
  if (variable === "HGT") {
    return `height${normalizedLevel}`;
  }
  if (variable === "RH") {
    return `rh${normalizedLevel}`;
  }
  if (variable === "UGRD") {
    return `wind${normalizedLevel}U`;
  }
  if (variable === "VGRD") {
    return `wind${normalizedLevel}V`;
  }
  if (variable === "VVEL") {
    return `verticalVelocity${normalizedLevel}`;
  }
  return null;
}

function gridValue(values, index) {
  const value = values ? Number(values[index]) : Number.NaN;
  return Number.isFinite(value) ? value : Number.NaN;
}

function resolveProfileGrid(decoded, variable, level) {
  if (!decoded) {
    return null;
  }
  if (level === "surface") {
    return decoded[PROFILE_SURFACE_DECODE_KEYS[variable]] || null;
  }
  const primary = decoded[profileDecodeKey(variable, level)];
  if (primary) {
    return primary;
  }
  const fallbackKey = standardProfileDecodeKey(variable, level);
  return fallbackKey ? decoded[fallbackKey] || null : null;
}

function profileSpeedAtLevel(decoded, level, index) {
  const u = profileValue(decoded, "UGRD", level, index);
  const v = profileValue(decoded, "VGRD", level, index);
  return Number.isFinite(u) && Number.isFinite(v) ? Math.hypot(u, v) : Number.NaN;
}

module.exports = {
  PROFILE_SURFACE_DECODE_KEYS,
  PROFILE_VARIABLE_PREFIX,
  gridValue,
  profileDataGrid,
  profileDecodeKey,
  profileSpeedAtLevel,
  profileValue,
  resolveProfileGrid,
  standardProfileDecodeKey,
  surfaceDewpointK,
  surfacePressureHpa,
};
