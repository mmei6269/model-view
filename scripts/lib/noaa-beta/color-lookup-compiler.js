"use strict";

const { clamp01, clampInt, lerp } = require("./util");

const CONTINUOUS_COLOR_LOOKUP_COMPILER_ID = "modelview-continuous-color-lookup-v1";
const DEFAULT_CONTINUOUS_COLOR_LOOKUP_SIZE = 4096;
const IEEE754_HEX_SCRATCH = Buffer.allocUnsafe(8);

function createContinuousColorLookup(
  { stops, min = 0, max = 1, log = false, alpha = 1, size = DEFAULT_CONTINUOUS_COLOR_LOOKUP_SIZE },
  { fallbackStops = stops, defaultSize = DEFAULT_CONTINUOUS_COLOR_LOOKUP_SIZE } = {},
) {
  return compileContinuousColorLookupRecipe(
    resolveContinuousColorLookupRecipe({ stops, min, max, log, alpha, size }, { fallbackStops, defaultSize }),
  );
}

function resolveContinuousColorLookupRecipe(
  { stops, min = 0, max = 1, log = false, alpha = 1, size = DEFAULT_CONTINUOUS_COLOR_LOOKUP_SIZE },
  { fallbackStops = stops, defaultSize = DEFAULT_CONTINUOUS_COLOR_LOOKUP_SIZE } = {},
) {
  const resolvedStops = normalizeColorStops(stops, fallbackStops);
  const bucketCount = clampInt(size, 2, 65536, defaultSize);
  const resolvedMin = Number(min);
  const resolvedMax = Number(max);
  const safeMin = Number.isFinite(resolvedMin) ? resolvedMin : 0;
  const safeMax = Number.isFinite(resolvedMax) ? resolvedMax : safeMin + 1;
  const recipe = {
    // These ordinary packed arrays are intentionally not frozen. V8 optimizes
    // the interpolation loop's indexed reads substantially better than reads
    // from deeply frozen nested arrays. The recipe object itself is frozen and
    // the arrays are module-private for static assignments.
    stops: resolvedStops,
    size: bucketCount,
    min: safeMin,
    max: safeMax,
    log: Boolean(log),
    alpha: Number.isFinite(alpha) ? alpha : 1,
  };
  return Object.freeze(recipe);
}

function compileContinuousColorLookupRecipe(recipe) {
  const normalized = validateResolvedContinuousColorLookupRecipe(recipe);
  const colors = new Uint8Array(normalized.size * 4);
  for (let index = 0; index < normalized.size; index += 1) {
    const position = normalized.size <= 1 ? 0 : index / (normalized.size - 1);
    const color = interpolateStops(normalized.stops, position) || [0, 0, 0, 0];
    const offset = index * 4;
    colors[offset] = clampInt(color[0], 0, 255, 0);
    colors[offset + 1] = clampInt(color[1], 0, 255, 0);
    colors[offset + 2] = clampInt(color[2], 0, 255, 0);
    colors[offset + 3] = clampInt((Number.isFinite(color[3]) ? color[3] : 1) * normalized.alpha * 255, 0, 255, 0);
  }
  return materializeValidatedContinuousColorLookupRecipe(normalized, colors);
}

function materializeContinuousColorLookupRecipe(recipe, colors) {
  return materializeValidatedContinuousColorLookupRecipe(validateResolvedContinuousColorLookupRecipe(recipe), colors);
}

function materializeValidatedContinuousColorLookupRecipe(normalized, colors) {
  if (!(colors instanceof Uint8Array) || colors.byteLength !== normalized.size * 4) {
    throw new Error(
      `Continuous color lookup requires exactly ${normalized.size * 4} color bytes; received ${
        colors?.byteLength ?? "none"
      }.`,
    );
  }
  const safeLogMin = Math.max(1e-6, normalized.min);
  const safeLogMax = Math.max(safeLogMin * 1.01, normalized.max);
  return Object.freeze({
    kind: "continuous",
    colors,
    size: normalized.size,
    min: normalized.min,
    max: normalized.max,
    scale: 1 / Math.max(1e-9, normalized.max - normalized.min),
    log: normalized.log,
    logMin: Math.log(safeLogMin),
    logScale: 1 / Math.max(1e-9, Math.log(safeLogMax) - Math.log(safeLogMin)),
  });
}

function validateResolvedContinuousColorLookupRecipe(recipe) {
  if (
    !recipe ||
    !Array.isArray(recipe.stops) ||
    recipe.stops.length < 2 ||
    !Number.isInteger(recipe.size) ||
    recipe.size < 2 ||
    recipe.size > 65536 ||
    !Number.isFinite(recipe.min) ||
    !Number.isFinite(recipe.max) ||
    !Number.isFinite(recipe.alpha) ||
    typeof recipe.log !== "boolean"
  ) {
    throw new Error("Continuous color lookup recipe is malformed.");
  }
  for (const stop of recipe.stops) {
    if (
      !Array.isArray(stop) ||
      stop.length !== 2 ||
      !Number.isFinite(stop[0]) ||
      !Array.isArray(stop[1]) ||
      stop[1].length !== 4 ||
      stop[1].some((value) => !Number.isFinite(value))
    ) {
      throw new Error("Continuous color lookup recipe contains a malformed stop.");
    }
  }
  return recipe;
}

function canonicalContinuousColorLookupRecipe(recipe) {
  const normalized = validateResolvedContinuousColorLookupRecipe(recipe);
  return {
    stops: normalized.stops.map(([position, color]) => [
      finiteNumberToIeee754Hex(position),
      color.map(finiteNumberToIeee754Hex),
    ]),
    size: normalized.size,
    min: finiteNumberToIeee754Hex(normalized.min),
    max: finiteNumberToIeee754Hex(normalized.max),
    log: normalized.log,
    alpha: finiteNumberToIeee754Hex(normalized.alpha),
  };
}

function canonicalContinuousColorLookupRecipeBytes(recipe) {
  const normalized = validateResolvedContinuousColorLookupRecipe(recipe);
  const numberBytes = Buffer.allocUnsafe((3 + normalized.stops.length * 5) * 8);
  let offset = 0;
  numberBytes.writeDoubleBE(normalized.min, offset);
  offset += 8;
  numberBytes.writeDoubleBE(normalized.max, offset);
  offset += 8;
  numberBytes.writeDoubleBE(normalized.alpha, offset);
  offset += 8;
  for (const [position, color] of normalized.stops) {
    numberBytes.writeDoubleBE(position, offset);
    numberBytes.writeDoubleBE(color[0], offset + 8);
    numberBytes.writeDoubleBE(color[1], offset + 16);
    numberBytes.writeDoubleBE(color[2], offset + 24);
    numberBytes.writeDoubleBE(color[3], offset + 32);
    offset += 40;
  }
  return Buffer.from(
    `continuous-color-lookup-recipe-v2\nsize:${normalized.size}\nlog:${normalized.log ? "1" : "0"}\n` +
      `stops:${normalized.stops.length}\nnumbers-f64be-hex:${numberBytes.toString("hex")}\n`,
  );
}

function finiteNumberToIeee754Hex(value) {
  if (!Number.isFinite(value)) {
    throw new Error(`Canonical color lookup numbers must be finite; received ${String(value)}.`);
  }
  IEEE754_HEX_SCRATCH.writeDoubleBE(value, 0);
  return IEEE754_HEX_SCRATCH.toString("hex");
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

module.exports = {
  CONTINUOUS_COLOR_LOOKUP_COMPILER_ID,
  DEFAULT_CONTINUOUS_COLOR_LOOKUP_SIZE,
  canonicalContinuousColorLookupRecipe,
  canonicalContinuousColorLookupRecipeBytes,
  compileContinuousColorLookupRecipe,
  createContinuousColorLookup,
  finiteNumberToIeee754Hex,
  interpolateRgbaColors,
  interpolateStops,
  lerpPremultipliedChannel,
  materializeContinuousColorLookupRecipe,
  normalizeColorStops,
  resolveContinuousColorLookupRecipe,
  validateResolvedContinuousColorLookupRecipe,
};
