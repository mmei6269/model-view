"use strict";

const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { MM_TO_IN, MPS_TO_KT, MPS_TO_MPH, clamp01, clampInt, lerp } = require("./util");
const { kelvinToCelsius, kelvinToFahrenheit, pascalToHpa } = require("./thermo");
const { smoothFiniteNonnegativeGrid } = require("./grid-ops");
const { encodeRgbaPng } = require("./png-encode");
const { parseAccumulationHours } = require("./records");
const REFLECTIVITY_PRECIP_TYPE_COLORS = require("../../../shared/reflectivity-precip-type-colors.json");
const PLANNED_COLOR_MAPS = require("../../../shared/noaa-beta-planned-color-maps.json");
const { loadColorMaps } = require("../color-maps");
const { SCALES: NOAA_RENDER_SCALES } = require("../noaa-nam-parameter-catalog");

const PRATE_KG_M2_S_TO_IN_HR = 3600 / 25.4;

const PRECIP_RATE_TYPE_LOOKUPS = buildPrecipRateTypeLookups(PLANNED_COLOR_MAPS?.maps?.precipRateByTypeInHr);

const FRONTOGENESIS_PRESENTATION_SMOOTHING_PASSES = 4;

function renderScalarGrid({
  values,
  width,
  height,
  normalize,
  stops,
  minVisible,
  maxVisible,
  visibleRange,
  alpha = 1,
  alphaForValue = null,
  colorForValue = null,
  colorLookup = null,
  transformValue = null,
  transformScale = null,
  transformOffset = 0,
  transformMin = null,
}) {
  if (
    colorLookup?.kind === "continuous" &&
    typeof alphaForValue !== "function" &&
    typeof colorForValue !== "function"
  ) {
    return renderScalarGridContinuous({
      values,
      width,
      height,
      minVisible,
      maxVisible,
      visibleRange,
      colorLookup,
      transformValue,
      transformScale,
      transformOffset,
      transformMin,
    });
  }
  if (colorLookup?.kind === "step" && typeof alphaForValue !== "function" && typeof colorForValue !== "function") {
    return renderScalarGridStep({
      values,
      width,
      height,
      minVisible,
      maxVisible,
      visibleRange,
      colorLookup,
      transformValue,
      transformScale,
      transformOffset,
      transformMin,
    });
  }

  const cellCount = width * height;
  if (!values || values.length !== cellCount) {
    return emptyScalarLayerResult();
  }
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  let visibleCount = 0;
  let validCount = 0;
  const transform = typeof transformValue === "function" ? transformValue : null;
  const affineTransform = buildAffineTransformState(transformScale, transformOffset, transformMin);
  const hasAffineTransform = Boolean(affineTransform);
  const affineScale = hasAffineTransform ? affineTransform.scale : 1;
  const affineOffset = hasAffineTransform ? affineTransform.offset : 0;
  const affineHasMin = hasAffineTransform && affineTransform.hasMin;
  const affineMin = affineHasMin ? affineTransform.min : 0;
  for (let index = 0; index < values.length; index += 1) {
    let value = values[index];
    if (transform) {
      value = transform(value);
    } else if (hasAffineTransform) {
      value = value * affineScale + affineOffset;
      if (affineHasMin && value < affineMin) {
        value = affineMin;
      }
    }
    if (value === value) {
      validCount += 1;
    }
    if (!isValueInVisibleRange(value, minVisible, maxVisible, visibleRange)) {
      continue;
    }
    const color =
      typeof colorForValue === "function" ? colorForValue(value) : interpolateStops(stops, normalize(value));
    const resolvedAlpha = typeof alphaForValue === "function" ? alphaForValue(value) : alpha;
    const stopAlpha = Number.isFinite(color?.[3]) ? color[3] : 1;
    if (!color || resolvedAlpha <= 0 || stopAlpha <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = clampInt(resolvedAlpha * stopAlpha * 255, 0, 255, 0);
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridContinuous({
  values,
  width,
  height,
  minVisible,
  maxVisible,
  visibleRange,
  colorLookup,
  transformValue = null,
  transformScale = null,
  transformOffset = 0,
  transformMin = null,
}) {
  const cellCount = width * height;
  if (!values || values.length !== cellCount || !colorLookup?.colors) {
    return emptyScalarLayerResult();
  }
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  const transform = typeof transformValue === "function" ? transformValue : null;
  const affineTransform = buildAffineTransformState(transformScale, transformOffset, transformMin);
  if (transform) {
    return renderScalarGridContinuousFunction({
      rgba,
      values,
      cellCount,
      colorLookup,
      visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
      transform,
    });
  }
  if (affineTransform) {
    return renderScalarGridContinuousAffine({
      rgba,
      values,
      cellCount,
      colorLookup,
      visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
      affineTransform,
    });
  }
  return renderScalarGridContinuousRaw({
    rgba,
    values,
    cellCount,
    colorLookup,
    visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
  });
}

function renderScalarGridContinuousRaw({ rgba, values, cellCount, colorLookup, visible }) {
  const colors = colorLookup.colors;
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = values[index];
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    const position =
      colorLookup.log && value > 0
        ? (Math.log(value) - colorLookup.logMin) * colorLookup.logScale
        : (value - colorLookup.min) * colorLookup.scale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridContinuousAffine({ rgba, values, cellCount, colorLookup, visible, affineTransform }) {
  const hasAffineTransform = Boolean(affineTransform);
  const affineScale = hasAffineTransform ? affineTransform.scale : 1;
  const affineOffset = hasAffineTransform ? affineTransform.offset : 0;
  const affineHasMin = hasAffineTransform && affineTransform.hasMin;
  const affineMin = affineHasMin ? affineTransform.min : 0;
  const colors = colorLookup.colors;
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    let value = values[index];
    value = value * affineScale + affineOffset;
    if (affineHasMin && value < affineMin) {
      value = affineMin;
    }
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    const position =
      colorLookup.log && value > 0
        ? (Math.log(value) - colorLookup.logMin) * colorLookup.logScale
        : (value - colorLookup.min) * colorLookup.scale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridContinuousFunction({ rgba, values, cellCount, colorLookup, visible, transform }) {
  const colors = colorLookup.colors;
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = transform(values[index]);
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    const position =
      colorLookup.log && value > 0
        ? (Math.log(value) - colorLookup.logMin) * colorLookup.logScale
        : (value - colorLookup.min) * colorLookup.scale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridStep({
  values,
  width,
  height,
  minVisible,
  maxVisible,
  visibleRange,
  colorLookup,
  transformValue = null,
  transformScale = null,
  transformOffset = 0,
  transformMin = null,
}) {
  const cellCount = width * height;
  if (!values || values.length !== cellCount || !colorLookup?.colors || !colorLookup?.thresholds) {
    return emptyScalarLayerResult();
  }
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  const transform = typeof transformValue === "function" ? transformValue : null;
  const affineTransform = buildAffineTransformState(transformScale, transformOffset, transformMin);
  if (transform) {
    return renderScalarGridStepFunction({
      rgba,
      values,
      cellCount,
      colorLookup,
      visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
      transform,
    });
  }
  if (affineTransform) {
    return renderScalarGridStepAffine({
      rgba,
      values,
      cellCount,
      colorLookup,
      visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
      affineTransform,
    });
  }
  return renderScalarGridStepRaw({
    rgba,
    values,
    cellCount,
    colorLookup,
    visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
  });
}

function renderScalarGridStepRaw({ rgba, values, cellCount, colorLookup, visible }) {
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = values[index];
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    let selected;
    if (uniformScale > 0) {
      selected = Math.floor((value - uniformStart) * uniformScale);
      if (selected < 0) {
        selected = 0;
      } else if (selected >= thresholdCount) {
        selected = thresholdCount - 1;
      }
    } else {
      selected = 0;
      let low = 1;
      let high = thresholdCount - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (value < thresholds[mid]) {
          high = mid - 1;
        } else {
          selected = mid;
          low = mid + 1;
        }
      }
    }
    const colorOffset = selected * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridStepAffine({ rgba, values, cellCount, colorLookup, visible, affineTransform }) {
  const hasAffineTransform = Boolean(affineTransform);
  const affineScale = hasAffineTransform ? affineTransform.scale : 1;
  const affineOffset = hasAffineTransform ? affineTransform.offset : 0;
  const affineHasMin = hasAffineTransform && affineTransform.hasMin;
  const affineMin = affineHasMin ? affineTransform.min : 0;
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    let value = values[index];
    value = value * affineScale + affineOffset;
    if (affineHasMin && value < affineMin) {
      value = affineMin;
    }
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    let selected;
    if (uniformScale > 0) {
      selected = Math.floor((value - uniformStart) * uniformScale);
      if (selected < 0) {
        selected = 0;
      } else if (selected >= thresholdCount) {
        selected = thresholdCount - 1;
      }
    } else {
      selected = 0;
      let low = 1;
      let high = thresholdCount - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (value < thresholds[mid]) {
          high = mid - 1;
        } else {
          selected = mid;
          low = mid + 1;
        }
      }
    }
    const colorOffset = selected * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridStepFunction({ rgba, values, cellCount, colorLookup, visible, transform }) {
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = transform(values[index]);
    if (value !== value) {
      continue;
    }
    validCount += 1;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    let selected;
    if (uniformScale > 0) {
      selected = Math.floor((value - uniformStart) * uniformScale);
      if (selected < 0) {
        selected = 0;
      } else if (selected >= thresholdCount) {
        selected = thresholdCount - 1;
      }
    } else {
      selected = 0;
      let low = 1;
      let high = thresholdCount - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (value < thresholds[mid]) {
          high = mid - 1;
        } else {
          selected = mid;
          low = mid + 1;
        }
      }
    }
    const colorOffset = selected * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function buildAffineTransformState(transformScale, transformOffset, transformMin) {
  const hasScale = hasFiniteTransformOption(transformScale);
  const hasOffset = hasFiniteTransformOption(transformOffset) && Number(transformOffset) !== 0;
  const hasMin = hasFiniteTransformOption(transformMin);
  if (!hasScale && !hasOffset && !hasMin) {
    return null;
  }
  return {
    scale: hasScale ? Number(transformScale) : 1,
    offset: hasOffset ? Number(transformOffset) : 0,
    min: Number(transformMin),
    hasMin,
  };
}

function hasFiniteTransformOption(value) {
  if (value === null || value === undefined || value === "") {
    return false;
  }
  return Number.isFinite(Number(value));
}

function isValueInVisibleRange(value, minVisible, maxVisible, visibleRange) {
  if (!Number.isFinite(value)) {
    return false;
  }
  const rangeMin = Array.isArray(visibleRange) ? Number(visibleRange[0]) : Number.NaN;
  const rangeMax = Array.isArray(visibleRange) ? Number(visibleRange[1]) : Number.NaN;
  const min = Number.isFinite(rangeMin) ? rangeMin : minVisible;
  const max = Number.isFinite(rangeMax) ? rangeMax : maxVisible;
  if (Number.isFinite(min) && value < min) {
    return false;
  }
  if (Number.isFinite(max) && value > max) {
    return false;
  }
  return true;
}

function resolveVisibleBounds(minVisible, maxVisible, visibleRange) {
  const rangeMin = Array.isArray(visibleRange) ? Number(visibleRange[0]) : Number.NaN;
  const rangeMax = Array.isArray(visibleRange) ? Number(visibleRange[1]) : Number.NaN;
  return {
    min: Number.isFinite(rangeMin) ? rangeMin : minVisible,
    max: Number.isFinite(rangeMax) ? rangeMax : maxVisible,
  };
}

function encodeLayerOrEmpty(layer, emptyPng, width, height, compressionLevel, filterType) {
  if (!layer || layer.visibleCount <= 0) {
    return encodeRawPng(emptyPng);
  }
  return encodeRawPng(encodeRgbaPng(layer.rgba, width, height, compressionLevel, filterType));
}

// Zero-visible scalar results are only consumed through encodeLayerOrEmpty,
// which returns the cached transparent PNG without reading rgba bytes, so
// null-input renders share one empty buffer instead of allocating and zeroing
// a full RGBA raster per call.
const EMPTY_SCALAR_LAYER_RGBA = Buffer.alloc(0);

function emptyScalarLayerResult() {
  return { rgba: EMPTY_SCALAR_LAYER_RGBA, visibleCount: 0, validCount: 0 };
}

function encodeRawPng(body) {
  return {
    body,
    bytes: body.length,
    contentType: "image/png",
  };
}

function renderReflectivityVariants({
  values,
  width,
  height,
  reflectivityGates,
  emptyPng,
  pngCompressionLevel,
  pngFilterType,
}) {
  const variants = {};
  for (const gate of reflectivityGates) {
    const gateDbz = Math.round(Number(gate));
    if (!Number.isFinite(gateDbz)) {
      continue;
    }
    variants[`dbz${gateDbz}`] = encodeLayerOrEmpty(
      renderScalarGrid({
        values,
        width,
        height,
        ...CORE_LAYER_RENDER_OPTIONS.reflectivity,
        minVisible: gateDbz,
      }),
      emptyPng,
      width,
      height,
      pngCompressionLevel,
      pngFilterType,
    );
  }
  return variants;
}

function renderReflectivityPrecipTypeGrid({ reflectivityDbz, rain, snow, freezingRain, sleet, width, height }) {
  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (
    !reflectivityDbz ||
    reflectivityDbz.length !== cellCount ||
    !rain ||
    rain.length !== cellCount ||
    !snow ||
    snow.length !== cellCount ||
    !freezingRain ||
    freezingRain.length !== cellCount ||
    !sleet ||
    sleet.length !== cellCount
  ) {
    return { rgba, visibleCount: 0 };
  }
  const freezingRainLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.freezing_rain;
  const sleetLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.sleet;
  const snowLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.snow;
  const rainLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.rain;
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const dbz = reflectivityDbz[index];
    if (dbz !== dbz) {
      continue;
    }
    let lookup = null;
    if (freezingRain[index] >= 0.5) {
      lookup = freezingRainLookup;
    } else if (sleet[index] >= 0.5) {
      lookup = sleetLookup;
    } else if (snow[index] >= 0.5) {
      lookup = snowLookup;
    } else if (rain[index] >= 0.5) {
      lookup = rainLookup;
    }
    if (!lookup) {
      continue;
    }
    const colorOffset = findReflectivityPrecipTypeColorOffset(lookup, dbz);
    const colors = lookup.colors;
    if (colorOffset < 0 || !colors || colors[colorOffset + 3] <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = colors[colorOffset + 3];
    visibleCount += 1;
  }
  return { rgba, visibleCount };
}

function renderPrecipRateTypeGrid({ precipRate, rain, snow, freezingRain, sleet, width, height }) {
  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (
    !precipRate ||
    precipRate.length !== cellCount ||
    !rain ||
    rain.length !== cellCount ||
    !snow ||
    snow.length !== cellCount ||
    !freezingRain ||
    freezingRain.length !== cellCount ||
    !sleet ||
    sleet.length !== cellCount
  ) {
    return { rgba, visibleCount: 0 };
  }
  const freezingRainLookup = PRECIP_RATE_TYPE_LOOKUPS.freezing_rain;
  const sleetLookup = PRECIP_RATE_TYPE_LOOKUPS.sleet;
  const snowLookup = PRECIP_RATE_TYPE_LOOKUPS.snow;
  const rainLookup = PRECIP_RATE_TYPE_LOOKUPS.rain;
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const rateInHr = precipRate[index] * PRATE_KG_M2_S_TO_IN_HR;
    if (!(rateInHr >= 0.01)) {
      continue;
    }
    let lookup = null;
    if (freezingRain[index] >= 0.5) {
      lookup = freezingRainLookup;
    } else if (sleet[index] >= 0.5) {
      lookup = sleetLookup;
    } else if (snow[index] >= 0.5) {
      lookup = snowLookup;
    } else if (rain[index] >= 0.5) {
      lookup = rainLookup;
    }
    if (!lookup) {
      continue;
    }
    const colorOffset = findStepColorOffset(lookup, rateInHr);
    const colors = lookup.colors;
    if (colorOffset < 0 || !colors || colors[colorOffset + 3] <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = colors[colorOffset + 3];
    visibleCount += 1;
  }
  return { rgba, visibleCount };
}

function findReflectivityPrecipTypeColorOffset(lookup, dbz) {
  const thresholds = lookup?.thresholds;
  const maxes = lookup?.maxes;
  const count = Number(lookup?.count) || 0;
  if (!thresholds || !maxes || count <= 0) {
    return -1;
  }
  let selected = 0;
  let low = 1;
  let high = count - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (dbz < thresholds[mid]) {
      high = mid - 1;
    } else {
      selected = mid;
      low = mid + 1;
    }
  }
  if (selected === count - 1) {
    return selected * 4;
  }
  return dbz < maxes[selected] ? selected * 4 : -1;
}

function findStepColorOffset(lookup, value) {
  const thresholds = lookup?.thresholds;
  const count = Number(lookup?.count) || 0;
  if (!thresholds || count <= 0 || !Number.isFinite(value)) {
    return -1;
  }
  let selected = 0;
  let low = 1;
  let high = count - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (value < thresholds[mid]) {
      high = mid - 1;
    } else {
      selected = mid;
      low = mid + 1;
    }
  }
  return selected * 4;
}

function resolveHoverTransformValue(entry, selection) {
  if (!entry || !entry.transform || entry.transform === "identity") {
    return null;
  }
  if (entry.transform === "precipRate") {
    const divisor = parseAccumulationHours(selection?.records?.[entry.inputKey]) || 1;
    return {
      transformScale: MM_TO_IN / divisor,
      transformMin: 0,
    };
  }
  return resolveCatalogAffineTransform(entry.transform) || resolveCatalogTransformValue(entry, selection);
}

function renderWindSpeedLayer({
  uValues,
  vValues,
  multiplier = MPS_TO_KT,
  width,
  height,
  colorLookup,
  minVisible,
  maxVisible,
  visibleRange,
}) {
  const cellCount = width * height;
  if (!uValues || !vValues || uValues.length !== cellCount || vValues.length !== cellCount) {
    return null;
  }
  if (colorLookup?.kind === "step") {
    return renderWindSpeedStepLayer({
      uValues,
      vValues,
      multiplier,
      width,
      height,
      colorLookup,
      minVisible,
      maxVisible,
      visibleRange,
    });
  }
  return renderWindSpeedContinuousLayer({
    uValues,
    vValues,
    multiplier,
    width,
    height,
    colorLookup,
    minVisible,
    maxVisible,
    visibleRange,
  });
}

function renderWindSpeedContinuousLayer({
  uValues,
  vValues,
  multiplier,
  width,
  height,
  colorLookup,
  minVisible,
  maxVisible,
  visibleRange,
}) {
  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (!colorLookup?.colors) {
    return { rgba, visibleCount: 0 };
  }
  const colors = colorLookup.colors;
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  const visible = resolveVisibleBounds(minVisible, maxVisible, visibleRange);
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const u = uValues[index];
    const v = vValues[index];
    if (u !== u || v !== v) {
      continue;
    }
    const value = Math.sqrt(u * u + v * v) * multiplier;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    const position =
      colorLookup.log && value > 0
        ? (Math.log(value) - colorLookup.logMin) * colorLookup.logScale
        : (value - colorLookup.min) * colorLookup.scale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount };
}

function renderWindSpeedStepLayer({
  uValues,
  vValues,
  multiplier,
  width,
  height,
  colorLookup,
  minVisible,
  maxVisible,
  visibleRange,
}) {
  const cellCount = width * height;
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  if (!colorLookup?.colors || !colorLookup?.thresholds) {
    return { rgba, visibleCount: 0 };
  }
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  const visible = resolveVisibleBounds(minVisible, maxVisible, visibleRange);
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const u = uValues[index];
    const v = vValues[index];
    if (u !== u || v !== v) {
      continue;
    }
    const value = Math.sqrt(u * u + v * v) * multiplier;
    if (Number.isFinite(visible.min) && value < visible.min) {
      continue;
    }
    if (Number.isFinite(visible.max) && value > visible.max) {
      continue;
    }
    let selected;
    if (uniformScale > 0) {
      selected = Math.floor((value - uniformStart) * uniformScale);
      if (selected < 0) {
        selected = 0;
      } else if (selected >= thresholdCount) {
        selected = thresholdCount - 1;
      }
    } else {
      selected = 0;
      let low = 1;
      let high = thresholdCount - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (value < thresholds[mid]) {
          high = mid - 1;
        } else {
          selected = mid;
          low = mid + 1;
        }
      }
    }
    const colorOffset = selected * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    const offset = index * 4;
    rgba[offset] = colors[colorOffset];
    rgba[offset + 1] = colors[colorOffset + 1];
    rgba[offset + 2] = colors[colorOffset + 2];
    rgba[offset + 3] = alphaByte;
    visibleCount += 1;
  }
  return { rgba, visibleCount };
}

function buildFrontogenesisPresentationGrid(values, width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const cellCount = cols * rows;
  if (!values || values.length !== cellCount || cellCount <= 0) {
    return values;
  }
  // Every cell is written exactly once below, so the previous full-grid NaN
  // prefill was redundant.
  const positive = new Float32Array(cellCount);
  let hasPositive = false;
  for (let index = 0; index < cellCount; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      positive[index] = Number.NaN;
      continue;
    }
    const frontogenesis = Math.max(0, value);
    positive[index] = frontogenesis;
    if (frontogenesis > 0) {
      hasPositive = true;
    }
  }
  return hasPositive
    ? smoothFiniteNonnegativeGrid(positive, cols, rows, FRONTOGENESIS_PRESENTATION_SMOOTHING_PASSES)
    : positive;
}

function renderCatalogParameterLayer({ entry, decoded, selection, width, height, getWindSpeedGrid = null }) {
  if (!entry || !decoded) {
    return null;
  }
  const renderOptions = getCatalogRenderOptions(entry);
  if (entry.kind === "wind") {
    const values = typeof getWindSpeedGrid === "function" ? getWindSpeedGrid(entry) : null;
    if (values) {
      return renderScalarGrid({
        values,
        width,
        height,
        ...renderOptions,
      });
    }
    return renderWindSpeedLayer({
      uValues: decoded[entry.uKey],
      vValues: decoded[entry.vKey],
      multiplier: entry.transform === "windMph" ? MPS_TO_MPH : MPS_TO_KT,
      width,
      height,
      ...renderOptions,
    });
  }
  if (entry.kind === "heightContour") {
    return null;
  }
  const source = resolveCatalogSourceGrid(entry, decoded, width, height);
  if (!source) {
    return null;
  }
  const values = resolveCatalogPresentationGrid(entry, source, width, height);
  const transformOptions = resolveCatalogTransformOptions(entry, selection);
  return renderScalarGrid({
    values,
    width,
    height,
    ...transformOptions,
    ...renderOptions,
  });
}

function resolveCatalogSourceGrid(entry, decoded, width, height) {
  const source = decoded?.[entry?.inputKey];
  if (!source) {
    return null;
  }
  if (entry?.key === "cloudCeiling") {
    return buildAglHeightMetersGrid(source, decoded?.profileSurfaceHeight, width, height);
  }
  return source;
}

function buildAglHeightMetersGrid(heightMslMeters, surfaceHeightMeters, width, height) {
  const cellCount = Math.round(Number(width) * Number(height));
  if (
    !Number.isFinite(cellCount) ||
    cellCount <= 0 ||
    !heightMslMeters ||
    !surfaceHeightMeters ||
    heightMslMeters.length !== cellCount ||
    surfaceHeightMeters.length !== cellCount
  ) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(Number.NaN);
  for (let index = 0; index < cellCount; index += 1) {
    const heightMsl = Number(heightMslMeters[index]);
    const surfaceHeight = Number(surfaceHeightMeters[index]);
    if (Number.isFinite(heightMsl) && Number.isFinite(surfaceHeight)) {
      out[index] = Math.max(0, heightMsl - surfaceHeight);
    }
  }
  return out;
}

function resolveCatalogPresentationGrid(entry, values, width, height) {
  if (entry?.key === "frontogenesis850" || entry?.key === "frontogenesis700") {
    return buildFrontogenesisPresentationGrid(values, width, height);
  }
  return values;
}

function resolveCatalogTransformOptions(entry, selection) {
  if (!entry || !entry.transform || entry.transform === "identity") {
    return {};
  }
  if (entry.transform === "precipRate") {
    const divisor = parseAccumulationHours(selection?.records?.[entry.inputKey]) || 1;
    return {
      transformScale: 1 / divisor,
      transformMin: 0,
    };
  }
  const affine = resolveCatalogAffineTransform(entry.transform);
  if (affine) {
    return affine;
  }
  return {
    transformValue: (value) => applyCatalogTransform(value, entry.transform),
  };
}

function applyCatalogTransform(value, transform) {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  if (transform === "kelvinToFahrenheit") {
    return kelvinToFahrenheit(value);
  }
  if (transform === "kelvinToCelsius") {
    return kelvinToCelsius(value);
  }
  if (transform === "pascalToHpa") {
    return pascalToHpa(value);
  }
  if (transform === "kgKgToGkg") {
    return value * 1000;
  }
  if (transform === "metersToMiles") {
    return value / 1609.344;
  }
  if (transform === "metersToFeet") {
    return value * 3.28084;
  }
  if (transform === "metersToDam") {
    return value * 0.1;
  }
  if (transform === "metersToInches") {
    return value * 39.3701;
  }
  if (transform === "kgM2ToWaterInches") {
    return value / 25.4;
  }
  if (transform === "absoluteVorticity1e5") {
    return value * 100000;
  }
  if (transform === "paSToDPaS") {
    return value * 10;
  }
  if (transform === "metersPerSecondToKnots") {
    return value * MPS_TO_KT;
  }
  if (transform === "metersPerSecondToMph") {
    return value * MPS_TO_MPH;
  }
  return value;
}

function resolveCatalogAffineTransform(transform) {
  if (transform === "kelvinToFahrenheit") {
    return {
      transformScale: 9 / 5,
      transformOffset: -459.67,
    };
  }
  if (transform === "kelvinToCelsius") {
    return {
      transformOffset: -273.15,
    };
  }
  if (transform === "pascalToHpa") {
    return {
      transformScale: 0.01,
    };
  }
  if (transform === "kgKgToGkg") {
    return {
      transformScale: 1000,
    };
  }
  if (transform === "metersToMiles") {
    return {
      transformScale: 1 / 1609.344,
    };
  }
  if (transform === "metersToFeet") {
    return {
      transformScale: 3.28084,
    };
  }
  if (transform === "metersToDam") {
    return {
      transformScale: 0.1,
    };
  }
  if (transform === "metersToInches") {
    return {
      transformScale: 39.3701,
    };
  }
  if (transform === "kgM2ToWaterInches") {
    return {
      transformScale: 1 / 25.4,
    };
  }
  if (transform === "absoluteVorticity1e5") {
    return {
      transformScale: 100000,
    };
  }
  if (transform === "paSToDPaS") {
    return {
      transformScale: 10,
    };
  }
  if (transform === "metersPerSecondToKnots") {
    return {
      transformScale: MPS_TO_KT,
    };
  }
  if (transform === "metersPerSecondToMph") {
    return {
      transformScale: MPS_TO_MPH,
    };
  }
  return null;
}

function resolveCatalogTransformValue(entry, selection) {
  if (!entry || !entry.transform || entry.transform === "identity") {
    return null;
  }
  if (entry.transform === "precipRate") {
    const divisor = parseAccumulationHours(selection.records?.[entry.inputKey]) || 1;
    return (value) => (Number.isFinite(value) ? Math.max(0, value) / divisor : Number.NaN);
  }
  if (entry.transform === "kelvinToFahrenheit") {
    return kelvinToFahrenheit;
  }
  if (entry.transform === "kelvinToCelsius") {
    return kelvinToCelsius;
  }
  if (entry.transform === "pascalToHpa") {
    return pascalToHpa;
  }
  if (entry.transform === "kgKgToGkg") {
    return (value) => (Number.isFinite(value) ? value * 1000 : Number.NaN);
  }
  if (entry.transform === "metersToMiles") {
    return (value) => (Number.isFinite(value) ? value / 1609.344 : Number.NaN);
  }
  if (entry.transform === "metersToFeet") {
    return (value) => (Number.isFinite(value) ? value * 3.28084 : Number.NaN);
  }
  if (entry.transform === "metersToInches") {
    return (value) => (Number.isFinite(value) ? value * 39.3701 : Number.NaN);
  }
  if (entry.transform === "kgM2ToWaterInches") {
    return (value) => (Number.isFinite(value) ? value / 25.4 : Number.NaN);
  }
  if (entry.transform === "absoluteVorticity1e5") {
    return (value) => (Number.isFinite(value) ? value * 100000 : Number.NaN);
  }
  if (entry.transform === "paSToDPaS") {
    return (value) => (Number.isFinite(value) ? value * 10 : Number.NaN);
  }
  if (entry.transform === "metersPerSecondToKnots") {
    return (value) => (Number.isFinite(value) ? value * MPS_TO_KT : Number.NaN);
  }
  if (entry.transform === "metersPerSecondToMph") {
    return (value) => (Number.isFinite(value) ? value * MPS_TO_MPH : Number.NaN);
  }
  return (value) => applyCatalogTransform(value, entry.transform);
}

function resolveCatalogScale(entry) {
  return (
    NOAA_RENDER_SCALES[entry?.scale] || {
      min: 0,
      max: 1,
      alpha: 0.82,
      legendStops: [
        [0, [40, 90, 140]],
        [1, [220, 80, 80]],
      ],
    }
  );
}

function getCatalogRenderOptions(entry) {
  return CATALOG_RENDER_OPTIONS.get(entry?.key) || buildCatalogRenderOptions(entry);
}

function buildCatalogRenderOptions(entry) {
  const scale = resolveCatalogScale(entry);
  const alpha = Number.isFinite(scale.alpha) ? Number(scale.alpha) : 0.82;
  const colorLookup =
    scale?.lookup === "step" && Array.isArray(scale.valueStops)
      ? createStepColorLookup(scale.valueStops, alpha)
      : createContinuousColorLookup({
          stops: normalizeColorStops(resolveCatalogStops(entry, scale), REFLECTIVITY_STOPS),
          min: scale?.min ?? 0,
          max: scale?.max ?? 1,
          log: Boolean(scale?.log),
          alpha,
          size: scale?.lookupSize,
        });
  return Object.freeze({
    colorLookup,
    minVisible: Number.isFinite(scale.minVisible) ? Number(scale.minVisible) : null,
    maxVisible: Number.isFinite(scale.maxVisible) ? Number(scale.maxVisible) : null,
    visibleRange: Array.isArray(scale.visibleRange) ? scale.visibleRange : null,
  });
}

function resolveCatalogStops(entry, scale) {
  return scale.legendStops || [];
}

function interpolateStops(stops, position) {
  if (!Array.isArray(stops) || stops.length === 0) {
    return null;
  }
  const t = clamp01(position);
  const samePositionEpsilon = 1e-12;
  if (t <= stops[0][0]) {
    let lastAtStart = 0;
    while (
      lastAtStart + 1 < stops.length &&
      Math.abs(Number(stops[lastAtStart + 1][0]) - Number(stops[0][0])) <= samePositionEpsilon
    ) {
      lastAtStart += 1;
    }
    if (lastAtStart > 0) {
      return stops[lastAtStart][1];
    }
    return stops[0][1];
  }
  for (let index = 1; index < stops.length; index += 1) {
    const [rightPosition, rightColor] = stops[index];
    const [leftPosition, leftColor] = stops[index - 1];
    if (t <= rightPosition) {
      if (Math.abs(t - rightPosition) <= samePositionEpsilon) {
        let lastAtPosition = index;
        while (
          lastAtPosition + 1 < stops.length &&
          Math.abs(Number(stops[lastAtPosition + 1][0]) - Number(rightPosition)) <= samePositionEpsilon
        ) {
          lastAtPosition += 1;
        }
        return stops[lastAtPosition][1];
      }
      const span = Math.max(1e-9, rightPosition - leftPosition);
      const local = (t - leftPosition) / span;
      return interpolateRgbaColors(leftColor, rightColor, local);
    }
  }
  return stops[stops.length - 1][1];
}

function interpolateRgbaColors(leftColor, rightColor, local) {
  const leftAlpha = Number.isFinite(leftColor?.[3]) ? clamp01(leftColor[3]) : 1;
  const rightAlpha = Number.isFinite(rightColor?.[3]) ? clamp01(rightColor[3]) : 1;
  const alpha = lerp(leftAlpha, rightAlpha, local);
  if (alpha <= 1e-9) {
    const source = local < 0.5 ? leftColor : rightColor;
    return [clampInt(source?.[0], 0, 255, 0), clampInt(source?.[1], 0, 255, 0), clampInt(source?.[2], 0, 255, 0), 0];
  }
  return [
    clampInt(lerpPremultipliedChannel(leftColor, leftAlpha, rightColor, rightAlpha, local, 0, alpha), 0, 255, 0),
    clampInt(lerpPremultipliedChannel(leftColor, leftAlpha, rightColor, rightAlpha, local, 1, alpha), 0, 255, 0),
    clampInt(lerpPremultipliedChannel(leftColor, leftAlpha, rightColor, rightAlpha, local, 2, alpha), 0, 255, 0),
    alpha,
  ];
}

function lerpPremultipliedChannel(leftColor, leftAlpha, rightColor, rightAlpha, local, channel, alpha) {
  const left = clampInt(leftColor?.[channel], 0, 255, 0) * leftAlpha;
  const right = clampInt(rightColor?.[channel], 0, 255, 0) * rightAlpha;
  return lerp(left, right, local) / alpha;
}

function createContinuousColorLookup({ stops, min = 0, max = 1, log = false, alpha = 1, size = COLOR_LOOKUP_SIZE }) {
  const resolvedStops = normalizeColorStops(stops, REFLECTIVITY_STOPS);
  const bucketCount = clampInt(size, 2, 65536, COLOR_LOOKUP_SIZE);
  const colors = new Uint8Array(bucketCount * 4);
  const alphaMultiplier = Number.isFinite(alpha) ? alpha : 1;
  for (let index = 0; index < bucketCount; index += 1) {
    const position = bucketCount <= 1 ? 0 : index / (bucketCount - 1);
    const color = interpolateStops(resolvedStops, position) || [0, 0, 0, 0];
    const offset = index * 4;
    colors[offset] = clampInt(color[0], 0, 255, 0);
    colors[offset + 1] = clampInt(color[1], 0, 255, 0);
    colors[offset + 2] = clampInt(color[2], 0, 255, 0);
    colors[offset + 3] = clampInt((Number.isFinite(color[3]) ? color[3] : 1) * alphaMultiplier * 255, 0, 255, 0);
  }
  const resolvedMin = Number(min);
  const resolvedMax = Number(max);
  const safeMin = Number.isFinite(resolvedMin) ? resolvedMin : 0;
  const safeMax = Number.isFinite(resolvedMax) ? resolvedMax : safeMin + 1;
  const safeLogMin = Math.max(1e-6, safeMin);
  const safeLogMax = Math.max(safeLogMin * 1.01, safeMax);
  return Object.freeze({
    kind: "continuous",
    colors,
    size: bucketCount,
    min: safeMin,
    max: safeMax,
    scale: 1 / Math.max(1e-9, safeMax - safeMin),
    log: Boolean(log),
    logMin: Math.log(safeLogMin),
    logScale: 1 / Math.max(1e-9, Math.log(safeLogMax) - Math.log(safeLogMin)),
  });
}

function createStepColorLookup(valueStops, alpha = 1) {
  const rows = Array.isArray(valueStops)
    ? valueStops
        .map((stop) => {
          const value = Number(stop?.[0]);
          const color = stop?.[1];
          return Number.isFinite(value) && Array.isArray(color) ? [value, color] : null;
        })
        .filter(Boolean)
        .sort((left, right) => left[0] - right[0])
    : [];
  const thresholds = new Float64Array(rows.length);
  const colors = new Uint8Array(rows.length * 4);
  const alphaMultiplier = Number.isFinite(alpha) ? alpha : 1;
  for (let index = 0; index < rows.length; index += 1) {
    const [value, color] = rows[index];
    const offset = index * 4;
    thresholds[index] = value;
    colors[offset] = clampInt(color[0], 0, 255, 0);
    colors[offset + 1] = clampInt(color[1], 0, 255, 0);
    colors[offset + 2] = clampInt(color[2], 0, 255, 0);
    colors[offset + 3] = clampInt((Number.isFinite(color[3]) ? color[3] : 1) * alphaMultiplier * 255, 0, 255, 0);
  }
  const uniform = detectUniformStepThresholds(thresholds);
  return Object.freeze({
    kind: "step",
    thresholds,
    colors,
    uniformStart: uniform?.start ?? null,
    uniformScale: uniform?.scale ?? 0,
  });
}

function detectUniformStepThresholds(thresholds) {
  if (!thresholds || thresholds.length < 3) {
    return null;
  }
  const start = thresholds[0];
  const step = thresholds[1] - thresholds[0];
  if (!Number.isFinite(start) || !Number.isFinite(step) || step <= 0) {
    return null;
  }
  const epsilon = Math.max(1e-9, Math.abs(step) * 1e-6);
  for (let index = 2; index < thresholds.length; index += 1) {
    if (Math.abs(thresholds[index] - thresholds[index - 1] - step) > epsilon) {
      return null;
    }
  }
  return { start, scale: 1 / step };
}

function normalizeColorStops(stops, fallback) {
  const source = Array.isArray(stops) && stops.length >= 2 ? stops : fallback;
  return source.map(([position, rgb]) => [
    clamp01(position),
    [
      clampInt(rgb?.[0], 0, 255, 0),
      clampInt(rgb?.[1], 0, 255, 0),
      clampInt(rgb?.[2], 0, 255, 0),
      Number.isFinite(Number(rgb?.[3])) ? clamp01(Number(rgb[3])) : 1,
    ],
  ]);
}

function buildReflectivityPrecipTypeLookups(source) {
  const types = source?.precipTypes || {};
  const out = {};
  for (const [typeKey, type] of Object.entries(types)) {
    const bins = Array.isArray(type?.bins)
      ? type.bins
          .map((bin) => {
            const color = normalizeRgbaBytes(bin?.webColor?.rgb, bin?.webColor?.alpha);
            const minDbz = nullableFiniteNumber(bin?.minDbzInclusive);
            const maxDbz = nullableFiniteNumber(bin?.maxDbzExclusive);
            return {
              minDbz,
              maxDbz,
              rgba: color,
            };
          })
          .sort((left, right) => {
            const leftMin = Number.isFinite(left.minDbz) ? left.minDbz : Number.NEGATIVE_INFINITY;
            const rightMin = Number.isFinite(right.minDbz) ? right.minDbz : Number.NEGATIVE_INFINITY;
            return leftMin - rightMin;
          })
      : [];
    const thresholds = new Float64Array(bins.length);
    const maxes = new Float64Array(bins.length);
    const colors = new Uint8Array(bins.length * 4);
    for (let index = 0; index < bins.length; index += 1) {
      const bin = bins[index];
      thresholds[index] = Number.isFinite(bin.minDbz) ? bin.minDbz : Number.NEGATIVE_INFINITY;
      maxes[index] = Number.isFinite(bin.maxDbz) ? bin.maxDbz : Number.POSITIVE_INFINITY;
      const offset = index * 4;
      colors[offset] = bin.rgba[0];
      colors[offset + 1] = bin.rgba[1];
      colors[offset + 2] = bin.rgba[2];
      colors[offset + 3] = bin.rgba[3];
    }
    out[typeKey] = Object.freeze({
      bins: Object.freeze(bins),
      thresholds,
      maxes,
      colors,
      count: bins.length,
    });
  }
  return Object.freeze(out);
}

function buildPrecipRateTypeLookups(source) {
  const types = source?.types || {};
  const out = {};
  for (const [typeKey, type] of Object.entries(types)) {
    const rows = Array.isArray(type?.valueStops)
      ? type.valueStops
          .map((stop) => {
            const threshold = Number(stop?.[0]);
            const color = normalizeRgbaBytes(stop?.[1], stop?.[2]);
            return Number.isFinite(threshold) ? { threshold, color } : null;
          })
          .filter(Boolean)
          .sort((left, right) => left.threshold - right.threshold)
      : [];
    const thresholds = new Float64Array(rows.length);
    const colors = new Uint8Array(rows.length * 4);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const offset = index * 4;
      thresholds[index] = row.threshold;
      colors[offset] = row.color[0];
      colors[offset + 1] = row.color[1];
      colors[offset + 2] = row.color[2];
      colors[offset + 3] = row.color[3];
    }
    out[typeKey] = Object.freeze({
      thresholds,
      colors,
      count: rows.length,
    });
  }
  return Object.freeze(out);
}

function nullableFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeRgbaBytes(rgb, alpha) {
  const source = Array.isArray(rgb) ? rgb : [0, 0, 0];
  const numericAlpha = Number(alpha);
  return Object.freeze([
    clampInt(source[0], 0, 255, 0),
    clampInt(source[1], 0, 255, 0),
    clampInt(source[2], 0, 255, 0),
    clampInt((Number.isFinite(numericAlpha) ? clamp01(numericAlpha) : 0) * 255, 0, 255, 0),
  ]);
}

const COLOR_LOOKUP_SIZE = 4096;

const COLOR_MAPS = loadColorMaps();

const TEMPERATURE_STOPS = COLOR_MAPS.temperatureF.normalizedStops;

const WIND_STOPS = COLOR_MAPS.windMph.normalizedRgbaStops || COLOR_MAPS.windMph.normalizedStops;

const PRECIP_VALUE_STOPS = COLOR_MAPS.precipIn.valueStops.map(([value, rgb, alpha]) => {
  const color = [...rgb];
  if (Number.isFinite(Number(alpha))) {
    color.push(Number(alpha));
  }
  return [value, color];
});

const REFLECTIVITY_VALUE_STOPS = COLOR_MAPS.reflectivityDbz.valueStops.map(([value, rgb, alpha]) => {
  const color = [...rgb];
  if (Number.isFinite(Number(alpha))) {
    color.push(Number(alpha));
  }
  return [value, color];
});

const REFLECTIVITY_STOPS = COLOR_MAPS.reflectivityDbz.normalizedRgbaStops || COLOR_MAPS.reflectivityDbz.normalizedStops;

const REFLECTIVITY_PRECIP_TYPE_LOOKUPS = buildReflectivityPrecipTypeLookups(REFLECTIVITY_PRECIP_TYPE_COLORS);

const CORE_LAYER_RENDER_OPTIONS = Object.freeze({
  temperature: Object.freeze({
    colorLookup: createContinuousColorLookup({
      stops: TEMPERATURE_STOPS,
      min: COLOR_MAPS.temperatureF.min,
      max: COLOR_MAPS.temperatureF.max,
      alpha: 0.95,
    }),
    minVisible: null,
    maxVisible: null,
    visibleRange: null,
  }),
  wind: Object.freeze({
    colorLookup: createContinuousColorLookup({
      stops: WIND_STOPS,
      min: COLOR_MAPS.windMph.min,
      max: COLOR_MAPS.windMph.max,
      alpha: 0.9,
    }),
    minVisible: COLOR_MAPS.windMph.min,
    maxVisible: null,
    visibleRange: null,
  }),
  precip: Object.freeze({
    colorLookup: createStepColorLookup(PRECIP_VALUE_STOPS, 1),
    minVisible: 0.01,
    maxVisible: null,
    visibleRange: null,
  }),
  reflectivity: Object.freeze({
    colorLookup: createStepColorLookup(REFLECTIVITY_VALUE_STOPS, 1),
    maxVisible: null,
    visibleRange: null,
  }),
});

const CATALOG_RENDER_OPTIONS = new Map(
  NOAA_NAM_PARAMETER_CATALOG.map((entry) => [entry.key, buildCatalogRenderOptions(entry)]),
);

module.exports = {
  CATALOG_RENDER_OPTIONS,
  COLOR_LOOKUP_SIZE,
  COLOR_MAPS,
  CORE_LAYER_RENDER_OPTIONS,
  EMPTY_SCALAR_LAYER_RGBA,
  FRONTOGENESIS_PRESENTATION_SMOOTHING_PASSES,
  PRATE_KG_M2_S_TO_IN_HR,
  PRECIP_RATE_TYPE_LOOKUPS,
  PRECIP_VALUE_STOPS,
  REFLECTIVITY_PRECIP_TYPE_LOOKUPS,
  REFLECTIVITY_STOPS,
  REFLECTIVITY_VALUE_STOPS,
  TEMPERATURE_STOPS,
  WIND_STOPS,
  applyCatalogTransform,
  buildAffineTransformState,
  buildAglHeightMetersGrid,
  buildCatalogRenderOptions,
  buildFrontogenesisPresentationGrid,
  buildPrecipRateTypeLookups,
  buildReflectivityPrecipTypeLookups,
  createContinuousColorLookup,
  createStepColorLookup,
  detectUniformStepThresholds,
  emptyScalarLayerResult,
  encodeLayerOrEmpty,
  encodeRawPng,
  findReflectivityPrecipTypeColorOffset,
  findStepColorOffset,
  getCatalogRenderOptions,
  hasFiniteTransformOption,
  interpolateRgbaColors,
  interpolateStops,
  isValueInVisibleRange,
  lerpPremultipliedChannel,
  normalizeColorStops,
  normalizeRgbaBytes,
  nullableFiniteNumber,
  renderCatalogParameterLayer,
  renderPrecipRateTypeGrid,
  renderReflectivityPrecipTypeGrid,
  renderReflectivityVariants,
  renderScalarGrid,
  renderScalarGridContinuous,
  renderScalarGridContinuousAffine,
  renderScalarGridContinuousFunction,
  renderScalarGridContinuousRaw,
  renderScalarGridStep,
  renderScalarGridStepAffine,
  renderScalarGridStepFunction,
  renderScalarGridStepRaw,
  renderWindSpeedContinuousLayer,
  renderWindSpeedLayer,
  renderWindSpeedStepLayer,
  resolveCatalogAffineTransform,
  resolveCatalogPresentationGrid,
  resolveCatalogScale,
  resolveCatalogSourceGrid,
  resolveCatalogStops,
  resolveCatalogTransformOptions,
  resolveCatalogTransformValue,
  resolveHoverTransformValue,
  resolveVisibleBounds,
};
