"use strict";

const NOAA_RECORD_INDEX_SYMBOL = Symbol("noaaRecordIndex");
const WARNED_AMBIGUOUS_SELECTORS = new Set();

function findRecord(records, selector) {
  if (!Array.isArray(records) || !selector) {
    return null;
  }
  const index = getNoaaRecordIndex(records);
  const source =
    selector.level && !selector.levelPattern
      ? index.byParamLevel.get(noaaRecordSelectorKey(selector.param, selector.level)) || []
      : index.byParam.get(String(selector.param || "")) || [];
  const candidates = source.filter((record) => {
    if (record.param !== selector.param) {
      return false;
    }
    if (selector.level && record.level !== selector.level) {
      return false;
    }
    if (selector.levelPattern && !selector.levelPattern.test(record.level)) {
      return false;
    }
    if (selector.forecastPattern && !selector.forecastPattern.test(`${record.forecast || ""} ${record.extra || ""}`)) {
      return false;
    }
    return recordMatchesStatistic(record, selector.statistic);
  });
  if (selector.param === "CAPE" && !selector.level && !selector.levelPattern) {
    const selected =
      candidates.find((record) => /180-0 mb above ground|surface|255-0 mb above ground/i.test(record.level)) ||
      candidates[0] ||
      null;
    warnOnAmbiguousRecordSelection(selector, candidates, selected);
    return selected;
  }
  const selected = candidates[0] || null;
  warnOnAmbiguousRecordSelection(selector, candidates, selected);
  return selected;
}

function recordMatchesStatistic(record, statistic) {
  const requested = String(statistic || "any")
    .trim()
    .toLowerCase();
  if (!requested || requested === "any") {
    return true;
  }
  const text = `${record?.forecast || ""} ${record?.extra || ""} ${record?.line || ""}`;
  const hasAccumulation = Boolean(parseAccumulationWindow(record));
  const hasAverage = Boolean(parseAverageWindow(record));
  const hasMaximum = /(?:\d+\s*-\s*\d+|\d+)\s*hour\s+(?:max|maximum)|\bmax(?:imum)?\b/i.test(text);
  const hasMinimum = /(?:\d+\s*-\s*\d+|\d+)\s*hour\s+(?:min|minimum)|\bmin(?:imum)?\b/i.test(text);
  if (requested === "accumulation" || requested === "acc") {
    return hasAccumulation;
  }
  if (requested === "average" || requested === "ave") {
    return hasAverage;
  }
  if (requested === "maximum" || requested === "max") {
    return hasMaximum;
  }
  if (requested === "minimum" || requested === "min") {
    return hasMinimum;
  }
  if (requested === "instant" || requested === "instantaneous") {
    return !hasAccumulation && !hasAverage && !hasMaximum && !hasMinimum;
  }
  return true;
}

function warnOnAmbiguousRecordSelection(selector, candidates, selected) {
  if (!selected || candidates.length <= 1 || selector?.allowAmbiguous === true) {
    return;
  }
  const key = JSON.stringify({
    param: selector?.param || "",
    level: selector?.level || "",
    levelPattern: String(selector?.levelPattern || ""),
    statistic: selector?.statistic || "any",
  });
  if (WARNED_AMBIGUOUS_SELECTORS.has(key)) {
    return;
  }
  WARNED_AMBIGUOUS_SELECTORS.add(key);
  console.warn(
    `[noaa-beta] ambiguous GRIB selector ${selector?.param || "?"}:${selector?.level || selector?.levelPattern || "*"}:${
      selector?.statistic || "any"
    } matched ${candidates.length} records; using ${selected.record || "first"}. Add a statistic/window predicate.`,
  );
}

function noaaRecordSelectorKey(param, level) {
  return `${String(param || "")}\u0000${String(level || "")}`;
}

function indexNoaaRecords(records) {
  if (!Array.isArray(records)) {
    return null;
  }
  const byParam = new Map();
  const byParamLevel = new Map();
  for (const record of records) {
    const param = String(record?.param || "");
    const paramGroup = byParam.get(param) || [];
    paramGroup.push(record);
    byParam.set(param, paramGroup);
    const exactKey = noaaRecordSelectorKey(param, record?.level);
    const exactGroup = byParamLevel.get(exactKey) || [];
    exactGroup.push(record);
    byParamLevel.set(exactKey, exactGroup);
  }
  const index = { byParam, byParamLevel };
  try {
    Object.defineProperty(records, NOAA_RECORD_INDEX_SYMBOL, {
      value: index,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // If the array is non-extensible, callers still get the returned index.
  }
  return index;
}

function getNoaaRecordIndex(records) {
  return (
    records?.[NOAA_RECORD_INDEX_SYMBOL] || indexNoaaRecords(records) || { byParam: new Map(), byParamLevel: new Map() }
  );
}

function compareRecordIds(left, right) {
  const leftParts = String(left || "")
    .split(".")
    .map((part) => Number(part));
  const rightParts = String(right || "")
    .split(".")
    .map((part) => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : -1;
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : -1;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }
  return 0;
}

function parseAccumulationHours(record) {
  const window = parseAccumulationWindow(record);
  return window ? Math.max(0, window.endHour - window.startHour) : null;
}

function parseAccumulationWindow(record) {
  const text = `${record?.forecast || ""} ${record?.extra || ""} ${record?.line || ""}`;
  const hourRange = text.match(/(\d+)\s*-\s*(\d+)\s*hour\s+acc/i);
  if (hourRange) {
    return {
      startHour: Math.max(0, Number(hourRange[1])),
      endHour: Math.max(0, Number(hourRange[2])),
    };
  }
  const dayRange = text.match(/(\d+)\s*-\s*(\d+)\s*day\s+acc/i);
  if (dayRange) {
    return {
      startHour: Math.max(0, Number(dayRange[1]) * 24),
      endHour: Math.max(0, Number(dayRange[2]) * 24),
    };
  }
  return null;
}

function parseAverageWindow(record) {
  const text = `${record?.forecast || ""} ${record?.extra || ""} ${record?.line || ""}`;
  const hourRange = text.match(/(\d+)\s*-\s*(\d+)\s*hour\s+ave/i);
  if (hourRange) {
    return {
      startHour: Math.max(0, Number(hourRange[1])),
      endHour: Math.max(0, Number(hourRange[2])),
    };
  }
  const dayRange = text.match(/(\d+)\s*-\s*(\d+)\s*day\s+ave/i);
  if (dayRange) {
    return {
      startHour: Math.max(0, Number(dayRange[1]) * 24),
      endHour: Math.max(0, Number(dayRange[2]) * 24),
    };
  }
  return null;
}

function isSurfacePrecipRecord(record) {
  return record?.param === "APCP" && record?.level === "surface";
}

function isSurfacePrecipAccumulationRecord(record) {
  const window = isSurfacePrecipRecord(record) ? parseAccumulationWindow(record) : null;
  return Boolean(window && window.endHour > window.startHour);
}

function isSurfaceAccumulatedSnowWaterRecord(record) {
  const window = record?.param === "WEASD" && record?.level === "surface" ? parseAccumulationWindow(record) : null;
  return Boolean(window && window.endHour > window.startHour);
}

function isSurfaceAccumulatedFreezingRainRecord(record) {
  const window = record?.param === "FRZR" && record?.level === "surface" ? parseAccumulationWindow(record) : null;
  return Boolean(window && window.endHour > window.startHour);
}

function recordsMatch(left, right) {
  if (!left || !right) {
    return false;
  }
  return (
    left === right ||
    (left.record === right.record &&
      left.param === right.param &&
      left.level === right.level &&
      left.forecast === right.forecast)
  );
}

function uniqueRecords(records) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    if (!record || seen.has(record.record)) {
      continue;
    }
    seen.add(record.record);
    out.push(record);
  }
  return out;
}

module.exports = {
  NOAA_RECORD_INDEX_SYMBOL,
  compareRecordIds,
  findRecord,
  getNoaaRecordIndex,
  indexNoaaRecords,
  isSurfaceAccumulatedFreezingRainRecord,
  isSurfaceAccumulatedSnowWaterRecord,
  isSurfacePrecipAccumulationRecord,
  isSurfacePrecipRecord,
  noaaRecordSelectorKey,
  parseAccumulationHours,
  parseAccumulationWindow,
  parseAverageWindow,
  recordMatchesStatistic,
  recordsMatch,
  uniqueRecords,
};
