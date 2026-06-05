"use strict";

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(num)));
}

function emitProgress(onProgress, payload) {
  if (typeof onProgress !== "function") {
    return;
  }
  onProgress({
    timestamp: new Date().toISOString(),
    ...payload,
  });
}

function parseOptionalNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseBooleanOption(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function padHour(hour) {
  return String(Math.max(0, Math.round(Number(hour) || 0))).padStart(3, "0");
}

module.exports = {
  clampInt,
  emitProgress,
  padHour,
  parseBooleanOption,
  parseOptionalNumber,
  sleep,
};
