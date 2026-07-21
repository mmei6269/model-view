"use strict";

const PARAMETER_AVAILABLE = "available";
const PARAMETER_UNAVAILABLE = "unavailable";

function buildSelectedParameterAvailability(selection) {
  const out = {};
  const catalog = Array.isArray(selection?.catalog) ? selection.catalog : [];
  const hasExplicitAvailability = Array.isArray(selection?.availableParameters);
  const available = new Set(selection?.availableParameters || []);
  for (const entry of catalog) {
    const key = String(entry?.key || "").trim();
    if (!key) {
      continue;
    }
    out[key] = !hasExplicitAvailability || available.has(key) ? PARAMETER_AVAILABLE : PARAMETER_UNAVAILABLE;
  }
  return out;
}

function setParameterAvailability(target, key, available) {
  const normalizedKey = String(key || "").trim();
  if (!target || !normalizedKey) {
    return;
  }
  target[normalizedKey] = available ? PARAMETER_AVAILABLE : PARAMETER_UNAVAILABLE;
}

function renderedLayerHasValidData(layer) {
  if (!layer || typeof layer !== "object") {
    return false;
  }
  const validCount = Number(layer.validCount);
  return Number.isFinite(validCount) ? validCount > 0 : true;
}

function hasGrid(values, width, height) {
  const expected = Math.max(0, Math.round(Number(width) * Number(height)));
  return Boolean(values && expected > 0 && Number(values.length) === expected);
}

function hasFiniteGridData(values, width, height) {
  if (!hasGrid(values, width, height)) {
    return false;
  }
  for (let index = 0; index < values.length; index += 1) {
    if (Number.isFinite(Number(values[index]))) {
      return true;
    }
  }
  return false;
}

function hasColocatedFiniteGridData(grids, width, height) {
  const valuesByGrid = Array.isArray(grids) ? grids : [];
  if (valuesByGrid.length === 0 || valuesByGrid.some((values) => !hasGrid(values, width, height))) {
    return false;
  }
  const cellCount = valuesByGrid[0].length;
  for (let index = 0; index < cellCount; index += 1) {
    if (valuesByGrid.every((values) => Number.isFinite(Number(values[index])))) {
      return true;
    }
  }
  return false;
}

module.exports = {
  PARAMETER_AVAILABLE,
  PARAMETER_UNAVAILABLE,
  buildSelectedParameterAvailability,
  hasColocatedFiniteGridData,
  hasFiniteGridData,
  hasGrid,
  renderedLayerHasValidData,
  setParameterAvailability,
};
