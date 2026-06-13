"use strict";

const { padHour, padTwoDigitHour } = require("./cache-io");

const NOAA_BETA_SOURCE_NAME = "noaa-grib2-beta";

const NOAA_NAM_BASE_URL = "https://noaa-nam-pds.s3.amazonaws.com";

const NOAA_GFS_BASE_URL = "https://noaa-gfs-bdp-pds.s3.amazonaws.com";

const NOAA_HRRR_BASE_URL = "https://noaa-hrrr-bdp-pds.s3.amazonaws.com";

const NOAA_BETA_MODEL_CONFIG = Object.freeze({
  gfs: Object.freeze({
    key: "gfs",
    label: "GFS",
    openDataModel: "noaa-gfs-pgrb2-0p25",
    baseUrl: NOAA_GFS_BASE_URL,
    productKey: "pgrb2-0p25",
    cycleHours: [0, 6, 12, 18],
    buildUrl: ({ baseUrl, date, cycle, hour }) => {
      const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_GFS_BASE_URL);
      return `${normalizedBase}/gfs.${date}/${cycle}/atmos/gfs.t${cycle}z.pgrb2.0p25.f${padHour(hour)}`;
    },
  }),
  nam: Object.freeze({
    key: "nam",
    label: "NAM",
    openDataModel: "noaa-nam-awphys",
    baseUrl: NOAA_NAM_BASE_URL,
    productKey: "awphys",
    cycleHours: [0, 6, 12, 18],
    buildUrl: ({ baseUrl, date, cycle, hour }) => {
      const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_NAM_BASE_URL);
      return `${normalizedBase}/nam.${date}/nam.t${cycle}z.awphys${padTwoDigitHour(hour)}.tm00.grib2`;
    },
  }),
  nam3km: Object.freeze({
    key: "nam3km",
    label: "NAM 3km",
    openDataModel: "noaa-nam-conusnest",
    baseUrl: NOAA_NAM_BASE_URL,
    productKey: "conusnest-hires",
    cycleHours: [0, 6, 12, 18],
    buildUrl: ({ baseUrl, date, cycle, hour }) => {
      const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_NAM_BASE_URL);
      return `${normalizedBase}/nam.${date}/nam.t${cycle}z.conusnest.hiresf${padTwoDigitHour(hour)}.tm00.grib2`;
    },
  }),
  hrrr: Object.freeze({
    key: "hrrr",
    label: "HRRR",
    openDataModel: "noaa-hrrr-wrfprs",
    baseUrl: NOAA_HRRR_BASE_URL,
    productKey: "wrfprs",
    cycleHours: Array.from({ length: 24 }, (_, hour) => hour),
    buildUrl: ({ baseUrl, date, cycle, hour }) => {
      const normalizedBase = normalizeBaseUrl(baseUrl || NOAA_HRRR_BASE_URL);
      return `${normalizedBase}/hrrr.${date}/conus/hrrr.t${cycle}z.wrfprsf${padTwoDigitHour(hour)}.grib2`;
    },
  }),
});

const NOAA_BETA_MODEL_KEYS = Object.freeze(Object.keys(NOAA_BETA_MODEL_CONFIG));

function formatNoaaRunId(date, cycle) {
  return `${String(date).slice(0, 8)}-${String(cycle).padStart(2, "0")}00Z`;
}

function referenceTimeIsoFromNoaaRun(date, cycle) {
  return validTimeIsoFromNoaaRun(date, cycle, 0);
}

function validTimeIsoFromNoaaRun(date, cycle, hour) {
  const text = String(date || "");
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const cycleHour = Number(cycle);
  const forecastHour = Number(hour);
  if (![year, month, day, cycleHour, forecastHour].every(Number.isFinite)) {
    return null;
  }
  return new Date(Date.UTC(year, month - 1, day, cycleHour + forecastHour, 0, 0)).toISOString();
}

function buildNoaaGribUrl({ modelKey = "nam", baseUrl = null, date, cycle, hour }) {
  const config = getNoaaGribModelConfig(modelKey);
  const normalizedDate = String(date || "").trim();
  const normalizedCycle = String(cycle || "").padStart(2, "0");
  return config.buildUrl({
    baseUrl: baseUrl || config.baseUrl,
    date: normalizedDate,
    cycle: normalizedCycle,
    hour,
  });
}

function buildNoaaNamAwphysUrl({ baseUrl = NOAA_NAM_BASE_URL, date, cycle, hour }) {
  return buildNoaaGribUrl({ modelKey: "nam", baseUrl, date, cycle, hour });
}

function getNoaaGribModelConfig(modelKey = "nam") {
  const normalized = normalizeNoaaModelKey(modelKey);
  return NOAA_BETA_MODEL_CONFIG[normalized];
}

function normalizeNoaaModelKey(modelKey = "nam") {
  const key = String(modelKey || "nam")
    .trim()
    .toLowerCase();
  if (!NOAA_BETA_MODEL_CONFIG[key]) {
    throw new Error(`Unsupported NOAA beta model '${modelKey}'. Supported: ${NOAA_BETA_MODEL_KEYS.join(", ")}`);
  }
  return key;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

module.exports = {
  NOAA_BETA_MODEL_CONFIG,
  NOAA_BETA_MODEL_KEYS,
  NOAA_BETA_SOURCE_NAME,
  NOAA_GFS_BASE_URL,
  NOAA_HRRR_BASE_URL,
  NOAA_NAM_BASE_URL,
  buildNoaaGribUrl,
  buildNoaaNamAwphysUrl,
  formatNoaaRunId,
  getNoaaGribModelConfig,
  normalizeBaseUrl,
  normalizeNoaaModelKey,
  referenceTimeIsoFromNoaaRun,
  validTimeIsoFromNoaaRun,
};
