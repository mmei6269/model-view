"use strict";

const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { MPS_TO_KT, MPS_TO_MPH, clamp01, clampInt } = require("./util");
const { kelvinToCelsius, kelvinToFahrenheit, pascalToHpa } = require("./thermo");
const { smoothFiniteNonnegativeGrid } = require("./grid-ops");
const parcelKernel = require("./parcel-kernel");
const {
  interpolateRgbaColors,
  interpolateStops,
  lerpPremultipliedChannel,
  normalizeColorStops,
} = require("./color-lookup-compiler");
const { loadCatalogColorLookupRoster } = require("./catalog-color-lookup-asset");
const {
  COLOR_LOOKUP_SIZE,
  buildStaticContinuousColorLookupAssignments,
  resolveCatalogScale,
} = require("./catalog-color-lookup-recipes");
const {
  _encodeTrustedIndexedPngFilter0,
  _encodeTrustedIndexedPngFilter0ViaPool,
  _encodeTrustedRgbaPngFilter0ViaPool,
  encodeIndexedPngFilter0,
  encodeIndexedPngFilter0ViaPool,
  encodeRgbaPng,
  encodeRgbaPngFilter0ViaPool,
} = require("./png-encode");
const REFLECTIVITY_PRECIP_TYPE_COLORS = require("../../../shared/reflectivity-precip-type-colors.json");
const PLANNED_COLOR_MAPS = require("../../../shared/noaa-beta-planned-color-maps.json");
const { loadColorMaps } = require("../color-maps");

const PRATE_KG_M2_S_TO_IN_HR = 3600 / 25.4;

const PRECIP_RATE_TYPE_LOOKUPS = buildPrecipRateTypeLookups(PLANNED_COLOR_MAPS?.maps?.precipRateByTypeInHr);

const FRONTOGENESIS_PRESENTATION_SMOOTHING_PASSES = 4;
const INDEXED_PIXEL_FORMAT = "indexed8";
const SINGLE_LOOKUP_INDEXED_PALETTES = new WeakMap();
const INTERNALLY_OWNED_INDEXED_LAYERS = new WeakMap();

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
  outputFormat = "rgba8",
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
      outputFormat,
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
    if (Number.isFinite(value)) {
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
  if (!transform) {
    const kernelResult = renderScalarGridContinuousKernel({
      rgba,
      values,
      cellCount,
      colorLookup,
      visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
      affineTransform,
    });
    if (kernelResult) {
      return kernelResult;
    }
  }
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

const FAILED_CONTINUOUS_COLORIZERS = new WeakSet();
const MAX_CONTINUOUS_COLOR_CHUNK = 65536;
const MAX_CONTINUOUS_COLOR_PALETTE = 65536;

function renderScalarGridContinuousKernel({ rgba, values, cellCount, colorLookup, visible, affineTransform }) {
  if (
    !(values instanceof Float32Array) ||
    !(rgba instanceof Uint8Array) ||
    !Number.isSafeInteger(cellCount) ||
    cellCount <= 0 ||
    values.length < cellCount ||
    cellCount > Math.floor(rgba.length / 4) ||
    colorLookup?.log ||
    !(colorLookup?.colors instanceof Uint8Array) ||
    !Number.isInteger(colorLookup.size) ||
    colorLookup.size <= 0 ||
    colorLookup.colors.length !== colorLookup.size * 4 ||
    !Number.isFinite(colorLookup.min) ||
    !Number.isFinite(colorLookup.scale) ||
    colorLookup.scale <= 0
  ) {
    return null;
  }
  let colorizer;
  try {
    colorizer = parcelKernel.getParcelKernel()?.colorize || null;
  } catch {
    return null;
  }
  if (!isUsableContinuousColorizer(colorizer, colorLookup.size)) {
    return null;
  }
  const affineScale = affineTransform ? affineTransform.scale : 1;
  const affineOffset = affineTransform ? affineTransform.offset : 0;
  const affineHasMin = Boolean(affineTransform?.hasMin);
  const affineMin = affineHasMin ? affineTransform.min : 0;
  if (
    !Number.isFinite(affineScale) ||
    !Number.isFinite(affineOffset) ||
    (affineHasMin && !Number.isFinite(affineMin))
  ) {
    return null;
  }
  const hasVisibleMin = Number.isFinite(visible?.min);
  const hasVisibleMax = Number.isFinite(visible?.max);
  try {
    colorizer.palette.set(colorLookup.colors, 0);
    let visibleCount = 0;
    let validCount = 0;
    for (let start = 0; start < cellCount; start += colorizer.chunk) {
      const count = Math.min(colorizer.chunk, cellCount - start);
      colorizer.input.set(values.subarray(start, start + count), 0);
      colorizer.stats.fill(-1);
      colorizer.run(
        count,
        colorLookup.size,
        colorLookup.min,
        colorLookup.scale,
        hasVisibleMin ? 1 : 0,
        hasVisibleMin ? visible.min : 0,
        hasVisibleMax ? 1 : 0,
        hasVisibleMax ? visible.max : 0,
        affineScale,
        affineOffset,
        affineHasMin ? 1 : 0,
        affineMin,
      );
      const chunkVisibleCount = colorizer.stats[0];
      const chunkValidCount = colorizer.stats[1];
      if (
        !Number.isInteger(chunkVisibleCount) ||
        !Number.isInteger(chunkValidCount) ||
        chunkVisibleCount < 0 ||
        chunkValidCount < chunkVisibleCount ||
        chunkValidCount > count
      ) {
        throw new Error("continuous colorizer returned invalid counters");
      }
      rgba.set(colorizer.output.subarray(0, count * 4), start * 4);
      visibleCount += chunkVisibleCount;
      validCount += chunkValidCount;
    }
    return { rgba, visibleCount, validCount };
  } catch {
    FAILED_CONTINUOUS_COLORIZERS.add(colorizer);
    // A failed chunk may have populated only a prefix. Restore the fresh
    // zero-buffer invariant before the authoritative JS loop reruns.
    rgba.fill(0);
    return null;
  }
}

function isUsableContinuousColorizer(colorizer, paletteSize) {
  if (
    !colorizer ||
    (typeof colorizer !== "object" && typeof colorizer !== "function") ||
    FAILED_CONTINUOUS_COLORIZERS.has(colorizer) ||
    colorizer.abiVersion !== parcelKernel.CONTINUOUS_COLORIZER_ABI_VERSION ||
    !Number.isSafeInteger(colorizer.chunk) ||
    colorizer.chunk <= 0 ||
    colorizer.chunk > MAX_CONTINUOUS_COLOR_CHUNK ||
    !Number.isSafeInteger(colorizer.paletteCap) ||
    colorizer.paletteCap < paletteSize ||
    colorizer.paletteCap > MAX_CONTINUOUS_COLOR_PALETTE ||
    typeof colorizer.run !== "function" ||
    !(colorizer.input instanceof Float32Array) ||
    colorizer.input.length < colorizer.chunk ||
    !(colorizer.output instanceof Uint8Array) ||
    colorizer.output.length < colorizer.chunk * 4 ||
    !(colorizer.palette instanceof Uint8Array) ||
    colorizer.palette.length < colorizer.paletteCap * 4 ||
    !(colorizer.stats instanceof Int32Array) ||
    colorizer.stats.length < 2 ||
    !colorizer.memory?.buffer
  ) {
    return false;
  }
  const buffer = colorizer.memory.buffer;
  return (
    colorizer.input.buffer === buffer &&
    colorizer.output.buffer === buffer &&
    colorizer.palette.buffer === buffer &&
    colorizer.stats.buffer === buffer
  );
}

function renderScalarGridContinuousRaw({ rgba, values, cellCount, colorLookup, visible }) {
  const colors = colorLookup.colors;
  const colorWords = nativeUint32View(colors);
  const rgbaWords = nativeUint32View(rgba);
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  const visibleMin = visible.min;
  const visibleMax = visible.max;
  const hasVisibleMin = Number.isFinite(visibleMin);
  const hasVisibleMax = Number.isFinite(visibleMax);
  const useLogScale = Boolean(colorLookup.log);
  const lookupMin = colorLookup.min;
  const lookupScale = colorLookup.scale;
  const logMin = colorLookup.logMin;
  const logScale = colorLookup.logScale;
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      continue;
    }
    validCount += 1;
    if (hasVisibleMin && value < visibleMin) {
      continue;
    }
    if (hasVisibleMax && value > visibleMax) {
      continue;
    }
    const position =
      useLogScale && value > 0 ? (Math.log(value) - logMin) * logScale : (value - lookupMin) * lookupScale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    if (rgbaWords && colorWords) {
      rgbaWords[index] = colorWords[bucket];
    } else {
      const offset = index * 4;
      rgba[offset] = colors[colorOffset];
      rgba[offset + 1] = colors[colorOffset + 1];
      rgba[offset + 2] = colors[colorOffset + 2];
      rgba[offset + 3] = alphaByte;
    }
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
  const colorWords = nativeUint32View(colors);
  const rgbaWords = nativeUint32View(rgba);
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  const visibleMin = visible.min;
  const visibleMax = visible.max;
  const hasVisibleMin = Number.isFinite(visibleMin);
  const hasVisibleMax = Number.isFinite(visibleMax);
  const useLogScale = Boolean(colorLookup.log);
  const lookupMin = colorLookup.min;
  const lookupScale = colorLookup.scale;
  const logMin = colorLookup.logMin;
  const logScale = colorLookup.logScale;
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    let value = values[index];
    value = value * affineScale + affineOffset;
    if (affineHasMin && value < affineMin) {
      value = affineMin;
    }
    if (!Number.isFinite(value)) {
      continue;
    }
    validCount += 1;
    if (hasVisibleMin && value < visibleMin) {
      continue;
    }
    if (hasVisibleMax && value > visibleMax) {
      continue;
    }
    const position =
      useLogScale && value > 0 ? (Math.log(value) - logMin) * logScale : (value - lookupMin) * lookupScale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    if (rgbaWords && colorWords) {
      rgbaWords[index] = colorWords[bucket];
    } else {
      const offset = index * 4;
      rgba[offset] = colors[colorOffset];
      rgba[offset + 1] = colors[colorOffset + 1];
      rgba[offset + 2] = colors[colorOffset + 2];
      rgba[offset + 3] = alphaByte;
    }
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridContinuousFunction({ rgba, values, cellCount, colorLookup, visible, transform }) {
  const colors = colorLookup.colors;
  const colorWords = nativeUint32View(colors);
  const rgbaWords = nativeUint32View(rgba);
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  const visibleMin = visible.min;
  const visibleMax = visible.max;
  const hasVisibleMin = Number.isFinite(visibleMin);
  const hasVisibleMax = Number.isFinite(visibleMax);
  const useLogScale = Boolean(colorLookup.log);
  const lookupMin = colorLookup.min;
  const lookupScale = colorLookup.scale;
  const logMin = colorLookup.logMin;
  const logScale = colorLookup.logScale;
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = transform(values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }
    validCount += 1;
    if (hasVisibleMin && value < visibleMin) {
      continue;
    }
    if (hasVisibleMax && value > visibleMax) {
      continue;
    }
    const position =
      useLogScale && value > 0 ? (Math.log(value) - logMin) * logScale : (value - lookupMin) * lookupScale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    if (rgbaWords && colorWords) {
      rgbaWords[index] = colorWords[bucket];
    } else {
      const offset = index * 4;
      rgba[offset] = colors[colorOffset];
      rgba[offset + 1] = colors[colorOffset + 1];
      rgba[offset + 2] = colors[colorOffset + 2];
      rgba[offset + 3] = alphaByte;
    }
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
  outputFormat = "rgba8",
}) {
  const cellCount = width * height;
  if (!values || values.length !== cellCount || !colorLookup?.colors || !colorLookup?.thresholds) {
    return emptyScalarLayerResult();
  }
  const transform = typeof transformValue === "function" ? transformValue : null;
  const affineTransform = buildAffineTransformState(transformScale, transformOffset, transformMin);
  if (outputFormat === INDEXED_PIXEL_FORMAT && !transform && !affineTransform) {
    return renderScalarGridStepIndexedRaw({
      values,
      cellCount,
      colorLookup,
      visible: resolveVisibleBounds(minVisible, maxVisible, visibleRange),
    });
  }
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
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

function renderScalarGridStepIndexedRaw({ values, cellCount, colorLookup, visible }) {
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const thresholdCount = thresholds.length;
  const indexedPalette = indexedPaletteForLookup(colorLookup);
  const paletteIndices = indexedPalette.indicesByLookup.get(colorLookup);
  const indices = Buffer.alloc(Math.max(0, cellCount));
  if (thresholdCount <= 0) {
    return indexedLayerResult(indices, indexedPalette.rgba, 0, 0);
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  const visibleMin = visible.min;
  const visibleMax = visible.max;
  const hasVisibleMin = Number.isFinite(visibleMin);
  const hasVisibleMax = Number.isFinite(visibleMax);
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      continue;
    }
    validCount += 1;
    if (hasVisibleMin && value < visibleMin) {
      continue;
    }
    if (hasVisibleMax && value > visibleMax) {
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
    if (colors[selected * 4 + 3] <= 0) {
      continue;
    }
    indices[index] = paletteIndices[selected];
    visibleCount += 1;
  }
  return indexedLayerResult(indices, indexedPalette.rgba, visibleCount, validCount);
}

// Step-bucket selection clamps below-range values into bucket 0: the binary
// search defaults selected=0 and the uniform fast path floors negatives to 0
// (same in the affine/function/wind-step variants). Safe only while every
// step palette pairs an alpha-0 first stop and/or a minVisible/visibleRange
// min at or above thresholds[0]; tests-node/raster-step-scale.test.js pins
// that invariant for all catalog/core step lookups.
function renderScalarGridStepRaw({ rgba, values, cellCount, colorLookup, visible }) {
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const colorWords = nativeUint32View(colors);
  const rgbaWords = nativeUint32View(rgba);
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  const visibleMin = visible.min;
  const visibleMax = visible.max;
  const hasVisibleMin = Number.isFinite(visibleMin);
  const hasVisibleMax = Number.isFinite(visibleMax);
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      continue;
    }
    validCount += 1;
    if (hasVisibleMin && value < visibleMin) {
      continue;
    }
    if (hasVisibleMax && value > visibleMax) {
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
    if (rgbaWords && colorWords) {
      rgbaWords[index] = colorWords[selected];
    } else {
      const offset = index * 4;
      rgba[offset] = colors[colorOffset];
      rgba[offset + 1] = colors[colorOffset + 1];
      rgba[offset + 2] = colors[colorOffset + 2];
      rgba[offset + 3] = alphaByte;
    }
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
  const colorWords = nativeUint32View(colors);
  const rgbaWords = nativeUint32View(rgba);
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  const visibleMin = visible.min;
  const visibleMax = visible.max;
  const hasVisibleMin = Number.isFinite(visibleMin);
  const hasVisibleMax = Number.isFinite(visibleMax);
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    let value = values[index];
    value = value * affineScale + affineOffset;
    if (affineHasMin && value < affineMin) {
      value = affineMin;
    }
    if (!Number.isFinite(value)) {
      continue;
    }
    validCount += 1;
    if (hasVisibleMin && value < visibleMin) {
      continue;
    }
    if (hasVisibleMax && value > visibleMax) {
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
    if (rgbaWords && colorWords) {
      rgbaWords[index] = colorWords[selected];
    } else {
      const offset = index * 4;
      rgba[offset] = colors[colorOffset];
      rgba[offset + 1] = colors[colorOffset + 1];
      rgba[offset + 2] = colors[colorOffset + 2];
      rgba[offset + 3] = alphaByte;
    }
    visibleCount += 1;
  }
  return { rgba, visibleCount, validCount };
}

function renderScalarGridStepFunction({ rgba, values, cellCount, colorLookup, visible, transform }) {
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const colorWords = nativeUint32View(colors);
  const rgbaWords = nativeUint32View(rgba);
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0, validCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  const visibleMin = visible.min;
  const visibleMax = visible.max;
  const hasVisibleMin = Number.isFinite(visibleMin);
  const hasVisibleMax = Number.isFinite(visibleMax);
  let visibleCount = 0;
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = transform(values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }
    validCount += 1;
    if (hasVisibleMin && value < visibleMin) {
      continue;
    }
    if (hasVisibleMax && value > visibleMax) {
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
    if (rgbaWords && colorWords) {
      rgbaWords[index] = colorWords[selected];
    } else {
      const offset = index * 4;
      rgba[offset] = colors[colorOffset];
      rgba[offset + 1] = colors[colorOffset + 1];
      rgba[offset + 2] = colors[colorOffset + 2];
      rgba[offset + 3] = alphaByte;
    }
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

// Reading and writing the same native Uint32 word preserves the underlying
// RGBA byte order on both little- and big-endian hosts. Production palettes
// and Buffer.alloc outputs are naturally aligned; unusual external views
// retain the byte-store fallback in the render loops.
function nativeUint32View(bytes) {
  if (
    !bytes?.buffer ||
    !Number.isInteger(bytes.byteOffset) ||
    !Number.isInteger(bytes.byteLength) ||
    bytes.byteOffset % Uint32Array.BYTES_PER_ELEMENT !== 0 ||
    bytes.byteLength % Uint32Array.BYTES_PER_ELEMENT !== 0
  ) {
    return null;
  }
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Uint32Array.BYTES_PER_ELEMENT);
}

function captureIndexedPaletteLookups(lookups) {
  return (Array.isArray(lookups) ? lookups : [])
    .filter((lookup) => lookup?.colors)
    .map((lookup) => ({
      lookup,
      colors: Buffer.from(lookup.colors),
    }));
}

function buildIndexedPaletteFromCapturedLookups(capturedLookups) {
  const colors = [[0, 0, 0, 0]];
  const colorIndices = new Map([["0,0,0,0", 0]]);
  const indicesByLookup = new Map();
  for (const { lookup, colors: source } of capturedLookups) {
    const entryCount = Math.floor(source.length / 4);
    const lookupIndices = new Uint8Array(entryCount);
    for (let index = 0; index < entryCount; index += 1) {
      const offset = index * 4;
      const alpha = source[offset + 3];
      if (alpha <= 0) {
        lookupIndices[index] = 0;
        continue;
      }
      const key = `${source[offset]},${source[offset + 1]},${source[offset + 2]},${alpha}`;
      let paletteIndex = colorIndices.get(key);
      if (paletteIndex === undefined) {
        paletteIndex = colors.length;
        if (paletteIndex >= 256) {
          throw new RangeError(`Indexed PNG palette exceeds 256 entries (${paletteIndex + 1}).`);
        }
        colorIndices.set(key, paletteIndex);
        colors.push([source[offset], source[offset + 1], source[offset + 2], alpha]);
      }
      lookupIndices[index] = paletteIndex;
    }
    indicesByLookup.set(lookup, lookupIndices);
  }
  const rgba = Buffer.allocUnsafe(colors.length * 4);
  for (let index = 0; index < colors.length; index += 1) {
    const offset = index * 4;
    const color = colors[index];
    rgba[offset] = color[0];
    rgba[offset + 1] = color[1];
    rgba[offset + 2] = color[2];
    rgba[offset + 3] = color[3];
  }
  return Object.freeze({
    rgba,
    entries: colors.length,
    indicesByLookup,
  });
}

function buildIndexedPalette(lookups) {
  return buildIndexedPaletteFromCapturedLookups(captureIndexedPaletteLookups(lookups));
}

function indexedPaletteCacheMatches(record, lookups) {
  if (!record || record.lookups.length !== lookups.length) {
    return false;
  }
  for (let index = 0; index < lookups.length; index += 1) {
    const lookup = lookups[index];
    const snapshot = record.lookups[index];
    const colors = lookup?.colors;
    if (
      lookup !== snapshot.lookup ||
      !(colors instanceof Uint8Array) ||
      colors.length !== snapshot.colors.length ||
      !Buffer.from(colors).equals(snapshot.colors)
    ) {
      return false;
    }
  }
  return true;
}

function refreshIndexedPaletteCache(cache, lookups) {
  if (!indexedPaletteCacheMatches(cache.record, lookups)) {
    const captured = captureIndexedPaletteLookups(lookups);
    cache.record = {
      lookups: captured,
      palette: buildIndexedPaletteFromCapturedLookups(captured),
    };
  }
  return cache.record.palette;
}

function indexedPaletteForLookup(lookup) {
  let cache = SINGLE_LOOKUP_INDEXED_PALETTES.get(lookup);
  if (!cache) {
    cache = { record: null };
    SINGLE_LOOKUP_INDEXED_PALETTES.set(lookup, cache);
  }
  return refreshIndexedPaletteCache(cache, [lookup]);
}

function indexedLayerResult(indices, paletteRgba, visibleCount, validCount = undefined) {
  const owner = {
    indices,
    // Palettes are small and shared between renderer calls. Take a private
    // copy so neither a previously returned layer nor an exported lookup can
    // mutate bytes that a queued encode still owns.
    paletteRgba: Buffer.from(paletteRgba),
    internallyOwned: true,
  };
  const layer = {
    pixelFormat: INDEXED_PIXEL_FORMAT,
    paletteEntries: owner.paletteRgba.length / 4,
    visibleCount,
    ...(validCount === undefined ? {} : { validCount }),
  };
  // Indexed bytes stay privately owned by the renderer. The frozen public
  // layer carries metadata only, so callers cannot capture or mutate bytes
  // used by either an immediate encode or coordinator-queued work.
  INTERNALLY_OWNED_INDEXED_LAYERS.set(layer, owner);
  return Object.freeze(layer);
}

function indexedLayerOwner(layer) {
  const internal = INTERNALLY_OWNED_INDEXED_LAYERS.get(layer);
  if (internal) {
    return internal;
  }
  return {
    indices: layer?.indices,
    paletteRgba: layer?.paletteRgba,
    internallyOwned: false,
  };
}

function resolveIndexedLayerOwner(layer, width, height) {
  if (!layer || layer.pixelFormat !== INDEXED_PIXEL_FORMAT) {
    return null;
  }
  const cellCount = Math.max(0, Math.round(Number(width) || 0) * Math.round(Number(height) || 0));
  const owner = indexedLayerOwner(layer);
  const indices = owner.indices;
  const palette = owner.paletteRgba;
  if (
    indices instanceof Uint8Array &&
    indices.length >= cellCount &&
    palette instanceof Uint8Array &&
    palette.length >= 4 &&
    palette.length <= 256 * 4 &&
    palette.length % 4 === 0
  ) {
    return owner;
  }
  return null;
}

function isIndexedLayer(layer, width, height) {
  return Boolean(resolveIndexedLayerOwner(layer, width, height));
}

function expandIndexedLayerToRgba(layer, width, height) {
  const owner = resolveIndexedLayerOwner(layer, width, height);
  if (!owner) {
    return null;
  }
  const cellCount = Math.max(0, Math.round(Number(width) || 0) * Math.round(Number(height) || 0));
  const indices = owner.indices;
  const palette = owner.paletteRgba;
  const paletteEntries = palette.length / 4;
  const rgba = Buffer.allocUnsafe(cellCount * 4);
  for (let index = 0; index < cellCount; index += 1) {
    const paletteIndex = indices[index];
    if (paletteIndex >= paletteEntries) {
      return null;
    }
    const sourceOffset = paletteIndex * 4;
    const targetOffset = index * 4;
    rgba[targetOffset] = palette[sourceOffset];
    rgba[targetOffset + 1] = palette[sourceOffset + 1];
    rgba[targetOffset + 2] = palette[sourceOffset + 2];
    rgba[targetOffset + 3] = palette[sourceOffset + 3];
  }
  return rgba;
}

function indexedLayerOwnerIndicesAreValid(owner, width, height) {
  if (owner.internallyOwned) {
    return true;
  }
  const cellCount = Math.max(0, Math.round(Number(width) || 0) * Math.round(Number(height) || 0));
  const paletteEntries = owner.paletteRgba.length / 4;
  for (let index = 0; index < cellCount; index += 1) {
    if (owner.indices[index] >= paletteEntries) {
      return false;
    }
  }
  return true;
}

function encodeLayerOrEmpty(layer, emptyPng, width, height, compressionLevel, filterType) {
  if (!layer || layer.visibleCount <= 0) {
    return encodeRawPng(emptyPng);
  }
  const indexedOwner = resolveIndexedLayerOwner(layer, width, height);
  if (indexedOwner) {
    if (!indexedLayerOwnerIndicesAreValid(indexedOwner, width, height)) {
      return encodeRawPng(emptyPng);
    }
    if (Number(filterType) === 0) {
      const encodeIndexed = indexedOwner.internallyOwned ? _encodeTrustedIndexedPngFilter0 : encodeIndexedPngFilter0;
      return encodeRawPng(
        encodeIndexed(indexedOwner.indices, indexedOwner.paletteRgba, width, height, compressionLevel),
      );
    }
    const rgba = expandIndexedLayerToRgba(layer, width, height);
    return rgba
      ? encodeRawPng(encodeRgbaPng(rgba, width, height, compressionLevel, filterType))
      : encodeRawPng(emptyPng);
  }
  if (!(layer.rgba instanceof Uint8Array)) {
    return encodeRawPng(emptyPng);
  }
  return encodeRawPng(encodeRgbaPng(layer.rgba, width, height, compressionLevel, filterType));
}

// Deferred variant for the compression pool: the descriptor is returned
// immediately (empty layers resolve inline from the shared transparent PNG),
// while non-empty filter-0 bodies fill in when the pooled deflate completes.
// Callers collect `pending` promises and await them once before the
// descriptors are consumed. Non-filter-0 encodes stay inline (pngjs path).
// The public entry point always retains generic snapshot + structured-clone
// semantics, regardless of options/context properties a caller supplies.
function encodeLayerOrEmptyDeferred(layer, emptyPng, width, height, compressionLevel, filterType, encodeContext) {
  return encodeLayerOrEmptyDeferredInternal(
    layer,
    emptyPng,
    width,
    height,
    compressionLevel,
    filterType,
    encodeContext,
    false,
  );
}

// Renderer-private entry point: buildRenderedArtifacts creates every layer
// owner locally and never publishes it before pending encodes settle. Keeping
// this separate from the generic function is the unforgeable-by-options gate
// to transferred scanline ownership.
function _encodeRendererOwnedLayerOrEmptyDeferred(
  layer,
  emptyPng,
  width,
  height,
  compressionLevel,
  filterType,
  encodeContext,
) {
  return encodeLayerOrEmptyDeferredInternal(
    layer,
    emptyPng,
    width,
    height,
    compressionLevel,
    filterType,
    encodeContext,
    true,
  );
}

function encodeLayerOrEmptyDeferredInternal(
  layer,
  emptyPng,
  width,
  height,
  compressionLevel,
  filterType,
  encodeContext,
  rendererOwnedContext,
) {
  if (!encodeContext || Number(filterType) !== 0) {
    return {
      descriptor: encodeLayerOrEmpty(layer, emptyPng, width, height, compressionLevel, filterType),
      pending: null,
    };
  }
  if (!layer || layer.visibleCount <= 0) {
    return { descriptor: encodeRawPng(emptyPng), pending: null };
  }
  const descriptor = { body: null, bytes: 0, contentType: "image/png" };
  const owner = resolveIndexedLayerOwner(layer, width, height);
  const indexed = Boolean(owner);
  if (!indexed && !(layer.rgba instanceof Uint8Array)) {
    return { descriptor: encodeRawPng(emptyPng), pending: null };
  }
  if (indexed && !indexedLayerOwnerIndicesAreValid(owner, width, height)) {
    return { descriptor: encodeRawPng(emptyPng), pending: null };
  }
  const internallyOwned = Boolean(owner?.internallyOwned);
  // A generic indexed layer is caller-owned and may be mutated as soon as
  // this function returns, including while a coordinator keeps `encode`
  // queued. Snapshot before queue admission. Renderer layers retain private
  // immutable owners and remain allocation-free here.
  const indexedOwner =
    indexed && !internallyOwned
      ? {
          indices: Buffer.from(
            owner.indices.subarray(0, Math.max(0, Math.round(Number(width) || 0) * Math.round(Number(height) || 0))),
          ),
          paletteRgba: Buffer.from(owner.paletteRgba),
        }
      : owner;
  const rgbaOwner =
    !indexed && !rendererOwnedContext
      ? Buffer.from(
          layer.rgba.subarray(0, Math.max(0, Math.round(Number(width) || 0) * Math.round(Number(height) || 0) * 4)),
        )
      : layer.rgba;
  const encode = () => {
    const encodeIndexed =
      internallyOwned && rendererOwnedContext ? _encodeTrustedIndexedPngFilter0ViaPool : encodeIndexedPngFilter0ViaPool;
    const pending = indexed
      ? encodeIndexed(
          indexedOwner.indices,
          indexedOwner.paletteRgba,
          width,
          height,
          compressionLevel,
          encodeContext.pool,
          encodeContext.counters,
        )
      : rendererOwnedContext
        ? _encodeTrustedRgbaPngFilter0ViaPool(
            rgbaOwner,
            width,
            height,
            compressionLevel,
            encodeContext.pool,
            encodeContext.counters,
          )
        : encodeRgbaPngFilter0ViaPool(
            rgbaOwner,
            width,
            height,
            compressionLevel,
            encodeContext.pool,
            encodeContext.counters,
          );
    return pending.then((body) => {
      descriptor.body = body;
      descriptor.bytes = body.length;
    });
  };
  const pending =
    encodeContext.coordinator && typeof encodeContext.coordinator.schedule === "function"
      ? encodeContext.coordinator.schedule(encode, "png-idat")
      : encode();
  return { descriptor, pending };
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

// Reflectivity gate variants share one grid scan: the step bucket and the
// valid count depend only on the cell value, not on the gate, so a single
// pass writes each gate's buffer wherever the gate's minVisible predicate
// holds. Produces byte-identical layers to running renderScalarGridStepRaw
// once per gate with minVisible set to that gate.
function renderReflectivityGateLayers({ values, width, height, colorLookup, gates, outputFormat = "rgba8" }) {
  const cellCount = width * height;
  if (gates.length <= 0) {
    return [];
  }
  if (!values || values.length !== cellCount || !colorLookup?.colors || !colorLookup?.thresholds) {
    return gates.map(() => emptyScalarLayerResult());
  }
  if (outputFormat === INDEXED_PIXEL_FORMAT) {
    return renderReflectivityGateIndexedLayers({ values, cellCount, colorLookup, gates });
  }
  const rgbaByGate = gates.map(() => Buffer.alloc(Math.max(0, cellCount * 4)));
  const rgbaWordsByGate = rgbaByGate.map(nativeUint32View);
  const visibleCountByGate = gates.map(() => 0);
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const colorWords = nativeUint32View(colors);
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return gates.map((_, gateIndex) => ({ rgba: rgbaByGate[gateIndex], visibleCount: 0, validCount: 0 }));
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  // Cells below every gate fail all gate predicates, so skip their bucket
  // math entirely (mirrors the per-gate renders, which never bucket
  // sub-gate cells).
  let minGate = Infinity;
  for (const gate of gates) {
    if (gate < minGate) {
      minGate = gate;
    }
  }
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      continue;
    }
    validCount += 1;
    if (value < minGate) {
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
    for (let gateIndex = 0; gateIndex < gates.length; gateIndex += 1) {
      if (value < gates[gateIndex]) {
        continue;
      }
      const rgba = rgbaByGate[gateIndex];
      const rgbaWords = rgbaWordsByGate[gateIndex];
      if (rgbaWords && colorWords) {
        rgbaWords[index] = colorWords[selected];
      } else {
        rgba[offset] = colors[colorOffset];
        rgba[offset + 1] = colors[colorOffset + 1];
        rgba[offset + 2] = colors[colorOffset + 2];
        rgba[offset + 3] = alphaByte;
      }
      visibleCountByGate[gateIndex] += 1;
    }
  }
  return gates.map((_, gateIndex) => ({
    rgba: rgbaByGate[gateIndex],
    visibleCount: visibleCountByGate[gateIndex],
    validCount,
  }));
}

function renderReflectivityGateIndexedLayers({ values, cellCount, colorLookup, gates }) {
  const indexedPalette = indexedPaletteForLookup(colorLookup);
  const paletteIndices = indexedPalette.indicesByLookup.get(colorLookup);
  const indicesByGate = gates.map(() => Buffer.alloc(Math.max(0, cellCount)));
  const visibleCountByGate = gates.map(() => 0);
  const thresholds = colorLookup.thresholds;
  const colors = colorLookup.colors;
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return gates.map((_, gateIndex) => indexedLayerResult(indicesByGate[gateIndex], indexedPalette.rgba, 0, 0));
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  let minGate = Infinity;
  for (const gate of gates) {
    if (gate < minGate) {
      minGate = gate;
    }
  }
  let validCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      continue;
    }
    validCount += 1;
    if (value < minGate) {
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
    if (colors[selected * 4 + 3] <= 0) {
      continue;
    }
    const paletteIndex = paletteIndices[selected];
    for (let gateIndex = 0; gateIndex < gates.length; gateIndex += 1) {
      if (value < gates[gateIndex]) {
        continue;
      }
      indicesByGate[gateIndex][index] = paletteIndex;
      visibleCountByGate[gateIndex] += 1;
    }
  }
  return gates.map((_, gateIndex) =>
    indexedLayerResult(indicesByGate[gateIndex], indexedPalette.rgba, visibleCountByGate[gateIndex], validCount),
  );
}

function renderReflectivityVariants({
  values,
  width,
  height,
  reflectivityGates,
  emptyPng,
  pngCompressionLevel,
  pngFilterType,
  encodeLayer = null,
  outputFormat = "rgba8",
}) {
  const encode =
    encodeLayer || ((layer) => encodeLayerOrEmpty(layer, emptyPng, width, height, pngCompressionLevel, pngFilterType));
  const { gates, layers } = prepareReflectivityVariantLayers({
    values,
    width,
    height,
    reflectivityGates,
    outputFormat,
  });
  const variants = {};
  for (let index = 0; index < gates.length; index += 1) {
    variants[`dbz${gates[index]}`] = encode(layers[index]);
  }
  return variants;
}

async function renderReflectivityVariantsCooperative({
  values,
  width,
  height,
  reflectivityGates,
  emptyPng,
  pngCompressionLevel,
  pngFilterType,
  encodeLayer = null,
  waitForEncodeCapacity = null,
  waitForEncodeIdle = null,
  maxBatchSize = 1,
  outputFormat = "rgba8",
}) {
  const encode =
    encodeLayer || ((layer) => encodeLayerOrEmpty(layer, emptyPng, width, height, pngCompressionLevel, pngFilterType));
  const gates = normalizeReflectivityGates(reflectivityGates);
  const batchSize = Math.max(1, Math.min(gates.length || 1, Math.floor(Number(maxBatchSize) || 1)));
  const variants = {};
  for (let batchStart = 0; batchStart < gates.length; batchStart += batchSize) {
    const batchGates = gates.slice(batchStart, batchStart + batchSize);
    const batchLayers = renderReflectivityGateLayers({
      values,
      width,
      height,
      colorLookup: CORE_LAYER_RENDER_OPTIONS.reflectivity.colorLookup,
      gates: batchGates,
      outputFormat,
    });
    for (let batchIndex = 0; batchIndex < batchGates.length; batchIndex += 1) {
      if (typeof waitForEncodeCapacity === "function") {
        await waitForEncodeCapacity();
      }
      variants[`dbz${batchGates[batchIndex]}`] = encode(batchLayers[batchIndex]);
    }
    // Drop the complete batch before allocating the next one. The next batch
    // cannot overlap retained RGBA/indexed pixel planes from this batch, so
    // arbitrary gate rosters remain bounded by maxBatchSize rather than roster
    // length.
    if (batchStart + batchSize < gates.length && typeof waitForEncodeIdle === "function") {
      await waitForEncodeIdle();
    }
  }
  return variants;
}

function prepareReflectivityVariantLayers({ values, width, height, reflectivityGates, outputFormat = "rgba8" }) {
  const gates = normalizeReflectivityGates(reflectivityGates);
  const layers = renderReflectivityGateLayers({
    values,
    width,
    height,
    colorLookup: CORE_LAYER_RENDER_OPTIONS.reflectivity.colorLookup,
    gates,
    outputFormat,
  });
  return { gates, layers };
}

function normalizeReflectivityGates(reflectivityGates) {
  const gates = [];
  for (const gate of reflectivityGates) {
    const gateDbz = Math.round(Number(gate));
    if (Number.isFinite(gateDbz)) {
      gates.push(gateDbz);
    }
  }
  return gates;
}

function renderReflectivityPrecipTypeGrid({
  reflectivityDbz,
  rain,
  snow,
  freezingRain,
  sleet,
  width,
  height,
  outputFormat = "rgba8",
}) {
  const cellCount = width * height;
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
    return { rgba: Buffer.alloc(Math.max(0, cellCount * 4)), visibleCount: 0 };
  }
  if (outputFormat === INDEXED_PIXEL_FORMAT) {
    return renderReflectivityPrecipTypeIndexedGrid({
      reflectivityDbz,
      rain,
      snow,
      freezingRain,
      sleet,
      cellCount,
    });
  }
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
  const freezingRainLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.freezing_rain;
  const sleetLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.sleet;
  const snowLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.snow;
  const rainLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.rain;
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const dbz = reflectivityDbz[index];
    if (!Number.isFinite(dbz)) {
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

function renderReflectivityPrecipTypeIndexedGrid({ reflectivityDbz, rain, snow, freezingRain, sleet, cellCount }) {
  const indices = Buffer.alloc(Math.max(0, cellCount));
  const indexedPalette = refreshIndexedPaletteCache(
    REFLECTIVITY_PRECIP_TYPE_INDEXED_PALETTE_CACHE,
    REFLECTIVITY_PRECIP_TYPE_INDEXED_LOOKUPS,
  );
  const freezingRainLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.freezing_rain;
  const sleetLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.sleet;
  const snowLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.snow;
  const rainLookup = REFLECTIVITY_PRECIP_TYPE_LOOKUPS.rain;
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const dbz = reflectivityDbz[index];
    if (!Number.isFinite(dbz)) {
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
    const lookupIndices = indexedPalette.indicesByLookup.get(lookup);
    indices[index] = lookupIndices[colorOffset >> 2];
    visibleCount += 1;
  }
  return indexedLayerResult(indices, indexedPalette.rgba, visibleCount);
}

function renderPrecipRateTypeGrid({
  precipRate,
  rain,
  snow,
  freezingRain,
  sleet,
  width,
  height,
  outputFormat = "rgba8",
}) {
  const cellCount = width * height;
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
    return { rgba: Buffer.alloc(Math.max(0, cellCount * 4)), visibleCount: 0 };
  }
  if (outputFormat === INDEXED_PIXEL_FORMAT) {
    return renderPrecipRateTypeIndexedGrid({
      precipRate,
      rain,
      snow,
      freezingRain,
      sleet,
      cellCount,
    });
  }
  const rgba = Buffer.alloc(Math.max(0, cellCount * 4));
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

function renderPrecipRateTypeIndexedGrid({ precipRate, rain, snow, freezingRain, sleet, cellCount }) {
  const indices = Buffer.alloc(Math.max(0, cellCount));
  const indexedPalette = refreshIndexedPaletteCache(
    PRECIP_RATE_TYPE_INDEXED_PALETTE_CACHE,
    PRECIP_RATE_TYPE_INDEXED_LOOKUPS,
  );
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
    const lookupIndices = indexedPalette.indicesByLookup.get(lookup);
    indices[index] = lookupIndices[colorOffset >> 2];
    visibleCount += 1;
  }
  return indexedLayerResult(indices, indexedPalette.rgba, visibleCount);
}

function findReflectivityPrecipTypeColorOffset(lookup, dbz) {
  const thresholds = lookup?.thresholds;
  const maxes = lookup?.maxes;
  const count = Number(lookup?.count) || 0;
  if (!thresholds || !maxes || count <= 0 || !Number.isFinite(dbz)) {
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

function resolveHoverTransformValue(entry) {
  if (!entry || !entry.transform || entry.transform === "identity") {
    return null;
  }
  return resolveCatalogAffineTransform(entry.transform) || ((value) => applyCatalogTransform(value, entry.transform));
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
  const colorWords = nativeUint32View(colors);
  const rgbaWords = nativeUint32View(rgba);
  const lastBucket = Math.max(0, (colorLookup.size || 1) - 1);
  const visible = resolveVisibleBounds(minVisible, maxVisible, visibleRange);
  const visibleMin = visible.min;
  const visibleMax = visible.max;
  const hasVisibleMin = Number.isFinite(visibleMin);
  const hasVisibleMax = Number.isFinite(visibleMax);
  const useLogScale = Boolean(colorLookup.log);
  const lookupMin = colorLookup.min;
  const lookupScale = colorLookup.scale;
  const logMin = colorLookup.logMin;
  const logScale = colorLookup.logScale;
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const u = uValues[index];
    const v = vValues[index];
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      continue;
    }
    const value = Math.sqrt(u * u + v * v) * multiplier;
    if (hasVisibleMin && value < visibleMin) {
      continue;
    }
    if (hasVisibleMax && value > visibleMax) {
      continue;
    }
    const position =
      useLogScale && value > 0 ? (Math.log(value) - logMin) * logScale : (value - lookupMin) * lookupScale;
    const bucket = position <= 0 ? 0 : position >= 1 ? lastBucket : Math.floor(position * lastBucket);
    const colorOffset = bucket * 4;
    const alphaByte = colors[colorOffset + 3];
    if (alphaByte <= 0) {
      continue;
    }
    if (rgbaWords && colorWords) {
      rgbaWords[index] = colorWords[bucket];
    } else {
      const offset = index * 4;
      rgba[offset] = colors[colorOffset];
      rgba[offset + 1] = colors[colorOffset + 1];
      rgba[offset + 2] = colors[colorOffset + 2];
      rgba[offset + 3] = alphaByte;
    }
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
  const colorWords = nativeUint32View(colors);
  const rgbaWords = nativeUint32View(rgba);
  const thresholdCount = thresholds.length;
  if (thresholdCount <= 0) {
    return { rgba, visibleCount: 0 };
  }
  const uniformScale = Number(colorLookup.uniformScale) || 0;
  const uniformStart = Number(colorLookup.uniformStart) || 0;
  const visible = resolveVisibleBounds(minVisible, maxVisible, visibleRange);
  const visibleMin = visible.min;
  const visibleMax = visible.max;
  const hasVisibleMin = Number.isFinite(visibleMin);
  const hasVisibleMax = Number.isFinite(visibleMax);
  let visibleCount = 0;
  for (let index = 0; index < cellCount; index += 1) {
    const u = uValues[index];
    const v = vValues[index];
    if (!Number.isFinite(u) || !Number.isFinite(v)) {
      continue;
    }
    const value = Math.sqrt(u * u + v * v) * multiplier;
    if (hasVisibleMin && value < visibleMin) {
      continue;
    }
    if (hasVisibleMax && value > visibleMax) {
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
    if (rgbaWords && colorWords) {
      rgbaWords[index] = colorWords[selected];
    } else {
      const offset = index * 4;
      rgba[offset] = colors[colorOffset];
      rgba[offset + 1] = colors[colorOffset + 1];
      rgba[offset + 2] = colors[colorOffset + 2];
      rgba[offset + 3] = alphaByte;
    }
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

function renderCatalogParameterLayer({ entry, decoded, modelKey = null, width, height, getWindSpeedGrid = null }) {
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
  const source = resolveCatalogSourceGrid(entry, decoded, width, height, modelKey);
  if (!source) {
    return null;
  }
  const values = resolveCatalogPresentationGrid(entry, source, width, height);
  const transformOptions = resolveCatalogTransformOptions(entry);
  return renderScalarGrid({
    values,
    width,
    height,
    ...transformOptions,
    ...renderOptions,
  });
}

// Per-frame memo caches attached to the decoded-grid object itself so the
// PNG pass, the hover pass, and the derived-grid phase all share the same
// computed source grids without any plumbing. Non-enumerable so the caches
// never travel through Object.assign/spread copies of decoded.
const CATALOG_SOURCE_GRID_CACHE = Symbol("catalogSourceGridCache");
const BELOW_TERRAIN_MASK_CACHE = Symbol("belowTerrainMaskCache");

function frameLocalCache(decoded, symbolKey) {
  let cache = decoded[symbolKey];
  if (!cache) {
    cache = new Map();
    Object.defineProperty(decoded, symbolKey, { value: cache, enumerable: false, configurable: true });
  }
  return cache;
}

// Frees the masked-grid copies once the last consumer (the hover pass) has
// run, so a frame doesn't retain one Float32Array copy per pressure-level
// entry for the rest of its lifetime.
function releaseFrameLocalRasterCaches(decoded) {
  if (!decoded || typeof decoded !== "object") {
    return;
  }
  if (decoded[CATALOG_SOURCE_GRID_CACHE]) {
    decoded[CATALOG_SOURCE_GRID_CACHE].clear();
  }
  if (decoded[BELOW_TERRAIN_MASK_CACHE]) {
    decoded[BELOW_TERRAIN_MASK_CACHE].clear();
  }
}

function resolveCatalogSourceGrid(entry, decoded, width, height, modelKey = null) {
  const source = decoded?.[entry?.inputKey];
  if (!source) {
    return null;
  }
  if (entry?.key === "cloudCeiling") {
    // UPP's GFS/NAM family cloud-ceiling HGT is MSL, while HRRR's RAPR
    // branch emits AGL directly. Subtracting terrain from HRRR would apply
    // the datum conversion twice.
    if (String(modelKey || "").toLowerCase() === "hrrr") {
      return source;
    }
    const cache = frameLocalCache(decoded, CATALOG_SOURCE_GRID_CACHE);
    let out = cache.get(entry.key);
    if (out === undefined) {
      out = buildAglHeightMetersGrid(source, decoded?.profileSurfaceHeight, width, height);
      cache.set(entry.key, out);
    }
    return out;
  }
  const pressureLevelMb = resolveCatalogPressureLevelMb(entry);
  if (!Number.isFinite(pressureLevelMb)) {
    return source;
  }
  const cache = frameLocalCache(decoded, CATALOG_SOURCE_GRID_CACHE);
  let out = cache.get(entry.key);
  if (out === undefined) {
    out = maskPressureLevelGridBelowTerrain(source, decoded, pressureLevelMb, width, height);
    cache.set(entry.key, out);
  }
  return out;
}

function resolveCatalogPressureLevelMb(entry) {
  const directLevel = Number(entry?.contourLevelMb);
  if (Number.isFinite(directLevel) && directLevel > 0) {
    return directLevel;
  }
  for (const selector of [entry?.selector, entry?.uSelector, entry?.vSelector]) {
    const match = String(selector?.level || "").match(/^\s*(\d+(?:\.\d+)?)\s*mb\s*$/i);
    if (match) {
      return Number(match[1]);
    }
  }
  return Number.NaN;
}

function maskPressureLevelGridBelowTerrain(values, decoded, levelMb, width, height) {
  const cols = Math.max(0, Math.round(Number(width) || 0));
  const rows = Math.max(0, Math.round(Number(height) || 0));
  const cellCount = cols * rows;
  const level = Math.round(Number(levelMb));
  const surfaceHeight = decoded?.profileSurfaceHeight;
  const pressureHeight = decoded?.[`height${level}`] || decoded?.[`profileHgt${level}`];
  if (
    !values ||
    values.length !== cellCount ||
    !surfaceHeight ||
    surfaceHeight.length !== cellCount ||
    !pressureHeight ||
    pressureHeight.length !== cellCount
  ) {
    return values || null;
  }

  // The below-terrain condition depends only on (surface height, pressure
  // height at this level), so its boolean mask is shared per level across
  // every variable masked at that level in the frame (temperature, RH,
  // wind components, vorticity, frontogenesis inputs, hover). A null mask
  // records "no below-terrain cells" so the copy is skipped exactly as the
  // unshared loop skipped it.
  const maskCache = frameLocalCache(decoded, BELOW_TERRAIN_MASK_CACHE);
  let mask = maskCache.get(level);
  if (mask === undefined) {
    mask = null;
    for (let index = 0; index < cellCount; index += 1) {
      const terrainM = Number(surfaceHeight[index]);
      const pressureSurfaceM = Number(pressureHeight[index]);
      if (Number.isFinite(terrainM) && Number.isFinite(pressureSurfaceM) && pressureSurfaceM <= terrainM) {
        if (!mask) {
          mask = new Uint8Array(cellCount);
        }
        mask[index] = 1;
      }
    }
    maskCache.set(level, mask);
  }
  if (!mask) {
    return values;
  }
  const out = new Float32Array(values);
  for (let index = 0; index < cellCount; index += 1) {
    if (mask[index]) {
      out[index] = Number.NaN;
    }
  }
  return out;
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

function resolveCatalogTransformOptions(entry) {
  if (!entry || !entry.transform || entry.transform === "identity") {
    return {};
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

function getCatalogRenderOptions(entry) {
  return CATALOG_RENDER_OPTIONS.get(entry?.key) || buildCatalogRenderOptions(entry);
}

function buildCatalogRenderOptions(entry) {
  return buildCatalogRenderOptionsWithStaticLookup(entry, null);
}

function buildCatalogRenderOptionsWithStaticLookup(entry, staticColorLookup) {
  const scale = resolveCatalogScale(entry);
  const alpha = Number.isFinite(scale.alpha) ? Number(scale.alpha) : 0.82;
  const colorLookup =
    scale?.lookup === "step" && Array.isArray(scale.valueStops)
      ? createStepColorLookup(scale.valueStops, alpha)
      : staticColorLookup ||
        createContinuousColorLookup({
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

const PRECIP_TYPE_LOOKUP_PRIORITY = Object.freeze(["freezing_rain", "sleet", "snow", "rain"]);

const PRECIP_RATE_TYPE_INDEXED_LOOKUPS = Object.freeze(
  PRECIP_TYPE_LOOKUP_PRIORITY.map((key) => PRECIP_RATE_TYPE_LOOKUPS[key]),
);
const REFLECTIVITY_PRECIP_TYPE_INDEXED_LOOKUPS = Object.freeze(
  PRECIP_TYPE_LOOKUP_PRIORITY.map((key) => REFLECTIVITY_PRECIP_TYPE_LOOKUPS[key]),
);
const PRECIP_RATE_TYPE_INDEXED_PALETTE_CACHE = { record: null };
const REFLECTIVITY_PRECIP_TYPE_INDEXED_PALETTE_CACHE = { record: null };

const STATIC_CONTINUOUS_COLOR_LOOKUP_ASSIGNMENTS = buildStaticContinuousColorLookupAssignments();

const STATIC_CONTINUOUS_COLOR_LOOKUP_STATE = loadCatalogColorLookupRoster({
  assignments: STATIC_CONTINUOUS_COLOR_LOOKUP_ASSIGNMENTS,
});

const CORE_LAYER_RENDER_OPTIONS = Object.freeze({
  temperature: Object.freeze({
    colorLookup: STATIC_CONTINUOUS_COLOR_LOOKUP_STATE.lookups.get("core:temperature"),
    minVisible: null,
    maxVisible: null,
    visibleRange: null,
  }),
  wind: Object.freeze({
    colorLookup: STATIC_CONTINUOUS_COLOR_LOOKUP_STATE.lookups.get("core:wind"),
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
  NOAA_NAM_PARAMETER_CATALOG.map((entry) => [
    entry.key,
    buildCatalogRenderOptionsWithStaticLookup(
      entry,
      STATIC_CONTINUOUS_COLOR_LOOKUP_STATE.lookups.get(`catalog:${entry.key}`) || null,
    ),
  ]),
);

module.exports = {
  CATALOG_RENDER_OPTIONS,
  COLOR_LOOKUP_SIZE,
  COLOR_MAPS,
  CORE_LAYER_RENDER_OPTIONS,
  EMPTY_SCALAR_LAYER_RGBA,
  FRONTOGENESIS_PRESENTATION_SMOOTHING_PASSES,
  INDEXED_PIXEL_FORMAT,
  PRATE_KG_M2_S_TO_IN_HR,
  PRECIP_RATE_TYPE_LOOKUPS,
  PRECIP_VALUE_STOPS,
  REFLECTIVITY_PRECIP_TYPE_LOOKUPS,
  REFLECTIVITY_STOPS,
  REFLECTIVITY_VALUE_STOPS,
  STATIC_CONTINUOUS_COLOR_LOOKUP_STATE,
  TEMPERATURE_STOPS,
  WIND_STOPS,
  applyCatalogTransform,
  buildAffineTransformState,
  buildAglHeightMetersGrid,
  buildCatalogRenderOptions,
  buildFrontogenesisPresentationGrid,
  buildIndexedPalette,
  buildPrecipRateTypeLookups,
  buildReflectivityPrecipTypeLookups,
  createContinuousColorLookup,
  createStepColorLookup,
  detectUniformStepThresholds,
  emptyScalarLayerResult,
  _encodeRendererOwnedLayerOrEmptyDeferred,
  encodeLayerOrEmpty,
  encodeLayerOrEmptyDeferred,
  encodeRawPng,
  expandIndexedLayerToRgba,
  findReflectivityPrecipTypeColorOffset,
  findStepColorOffset,
  getCatalogRenderOptions,
  hasFiniteTransformOption,
  interpolateRgbaColors,
  interpolateStops,
  isValueInVisibleRange,
  isIndexedLayer,
  lerpPremultipliedChannel,
  normalizeColorStops,
  normalizeRgbaBytes,
  nullableFiniteNumber,
  renderCatalogParameterLayer,
  renderPrecipRateTypeGrid,
  renderReflectivityGateLayers,
  renderReflectivityGateIndexedLayers,
  renderReflectivityPrecipTypeGrid,
  renderReflectivityVariants,
  renderReflectivityVariantsCooperative,
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
  maskPressureLevelGridBelowTerrain,
  releaseFrameLocalRasterCaches,
  resolveCatalogPressureLevelMb,
  resolveCatalogAffineTransform,
  resolveCatalogPresentationGrid,
  resolveCatalogScale,
  resolveCatalogSourceGrid,
  resolveCatalogStops,
  resolveCatalogTransformOptions,
  resolveHoverTransformValue,
  resolveVisibleBounds,
};
