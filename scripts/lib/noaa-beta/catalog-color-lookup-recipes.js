"use strict";

const { NOAA_NAM_PARAMETER_CATALOG, SCALES: NOAA_RENDER_SCALES } = require("../noaa-nam-parameter-catalog");
const { loadColorMaps } = require("../color-maps");
const { normalizeColorStops, resolveContinuousColorLookupRecipe } = require("./color-lookup-compiler");

const COLOR_LOOKUP_SIZE = 4096;
const COLOR_MAPS = loadColorMaps();
const REFLECTIVITY_STOPS = COLOR_MAPS.reflectivityDbz.normalizedRgbaStops || COLOR_MAPS.reflectivityDbz.normalizedStops;
const TEMPERATURE_STOPS = COLOR_MAPS.temperatureF.normalizedStops;
const WIND_STOPS = COLOR_MAPS.windMph.normalizedRgbaStops || COLOR_MAPS.windMph.normalizedStops;

function buildCatalogContinuousColorLookupRecipe(entry, scale = resolveCatalogScale(entry)) {
  if (scale?.lookup === "step" && Array.isArray(scale.valueStops)) {
    return null;
  }
  const alpha = Number.isFinite(scale.alpha) ? Number(scale.alpha) : 0.82;
  return resolveContinuousColorLookupRecipe(
    {
      stops: normalizeColorStops(scale.legendStops || [], REFLECTIVITY_STOPS),
      min: scale?.min ?? 0,
      max: scale?.max ?? 1,
      log: Boolean(scale?.log),
      alpha,
      size: scale?.lookupSize,
    },
    { fallbackStops: REFLECTIVITY_STOPS, defaultSize: COLOR_LOOKUP_SIZE },
  );
}

function buildStaticContinuousColorLookupAssignments() {
  const catalogRecipesByScale = new Map();
  const assignments = [
    Object.freeze({
      id: "core:temperature",
      recipe: resolveContinuousColorLookupRecipe(
        {
          stops: TEMPERATURE_STOPS,
          min: COLOR_MAPS.temperatureF.min,
          max: COLOR_MAPS.temperatureF.max,
          alpha: 0.95,
          size: COLOR_LOOKUP_SIZE,
        },
        { fallbackStops: REFLECTIVITY_STOPS, defaultSize: COLOR_LOOKUP_SIZE },
      ),
    }),
    Object.freeze({
      id: "core:wind",
      recipe: resolveContinuousColorLookupRecipe(
        {
          stops: WIND_STOPS,
          min: COLOR_MAPS.windMph.min,
          max: COLOR_MAPS.windMph.max,
          alpha: 0.9,
          size: COLOR_LOOKUP_SIZE,
        },
        { fallbackStops: REFLECTIVITY_STOPS, defaultSize: COLOR_LOOKUP_SIZE },
      ),
    }),
  ];
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    const scaleKey = entry?.scale || "";
    let recipe = catalogRecipesByScale.get(scaleKey);
    if (recipe === undefined) {
      recipe = buildCatalogContinuousColorLookupRecipe(entry, resolveCatalogScaleByKey(scaleKey));
      catalogRecipesByScale.set(scaleKey, recipe);
    }
    if (recipe) {
      assignments.push(Object.freeze({ id: `catalog:${entry.key}`, recipe }));
    }
  }
  return Object.freeze(assignments);
}

function resolveCatalogScale(entry) {
  return resolveCatalogScaleByKey(entry?.scale);
}

function resolveCatalogScaleByKey(scaleKey) {
  return (
    NOAA_RENDER_SCALES[scaleKey] || {
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

module.exports = {
  COLOR_LOOKUP_SIZE,
  buildCatalogContinuousColorLookupRecipe,
  buildStaticContinuousColorLookupAssignments,
  resolveCatalogScale,
  resolveCatalogScaleByKey,
};
