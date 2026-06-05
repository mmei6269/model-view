"use strict";

const SHARED_CONFIG = require("../../shared/modelview-config.json");
const REFLECTIVITY_PRECIP_TYPE_COLORS = require("../../shared/reflectivity-precip-type-colors.json");
const SNOWFALL_LEGEND_COLORS = require("../../shared/snowfall-legend-colors.json");
const PLANNED_COLOR_MAPS = require("../../shared/noaa-beta-planned-color-maps.json");
const { loadColorMaps } = require("./color-maps");

const SURFACE_GROUP = "Surface & Boundary Layer";
const PRECIP_GROUP = "Precipitation";
const RADAR_GROUP = "Radar";
const CLOUD_GROUP = "Clouds & Ceiling";
const WIND_GROUP = SURFACE_GROUP;
const SEVERE_THERMO_GROUP = "Severe: Thermodynamics";
const SEVERE_KINEMATICS_GROUP = "Severe: Kinematics";
const WINTER_GROUP = "Winter / Snow & Ice";
const UPPER_AIR_GROUP = "Upper Air: Height / Wind / Temp";
const UPPER_AIR_DIAGNOSTIC_GROUP = "Upper Air: Omega / Vorticity";
const REFLECTIVITY_LEGEND_TICKS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70];
const REFLECTIVITY_THRESHOLD_NOTE = "Gate selectable: >=10/15/20 dBZ";
const REFLECTIVITY_PRECIP_TYPE_THRESHOLD_NOTE =
  "Instant reflectivity/type, not accumulation; rain/freezing/sleet >=10 dBZ; snow >=5 dBZ";
const PRECIP_ACCUMULATION_THRESHOLD_NOTE = "Hidden < 0.01 in";
const SNOWFALL_THRESHOLD_NOTE = "Accumulated new snow; trace opacity ramp below 0.1 in";
const SNOW_PROFILE_LEVELS = Object.freeze([
  1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 675, 650, 625, 600, 575, 550, 525, 500, 475, 450,
  425, 400, 375, 350, 325, 300,
]);
const EFFECTIVE_LAYER_PROFILE_LEVELS = Object.freeze([
  1000, 975, 950, 925, 900, 875, 850, 825, 800, 775, 750, 725, 700, 650, 600, 550, 500, 450, 400, 350, 300,
]);
const DERIVED_DIAGNOSTIC_PROFILE_LEVELS = Object.freeze([1000, 925, 850, 700, 500, 300]);
const KUCHERA_PROFILE_LEVELS = Object.freeze(SNOW_PROFILE_LEVELS.filter((level) => level >= 500));
const COBB_PROFILE_LEVELS = Object.freeze(SNOW_PROFILE_LEVELS.filter((level) => level >= 300 && level <= 925));

const LEGACY_COLOR_MAPS = loadColorMaps();
const SHARED_LAYERS = SHARED_CONFIG.layers || {};
const SNOWFALL_IN_MAX = Number(SNOWFALL_LEGEND_COLORS.maxInches) || 60;
const SNOWFALL_IN_VALUE_STOPS = Object.freeze(normalizedSnowfallLegendValueStops(SNOWFALL_LEGEND_COLORS));
const LOW_END_STRETCH_LEGEND_SCALE = Object.freeze({ kind: "power", exponent: 0.5 });
const RELATIVE_VORTICITY_POSITIVE_ZERO_RGB = Object.freeze([255, 255, 0]);
const UPPER_HEIGHT_STOPS = [
  [0, [70, 84, 126]],
  [0.25, [67, 137, 176]],
  [0.5, [107, 174, 130]],
  [0.75, [224, 197, 96]],
  [1, [203, 91, 78]],
];

const SCALES = Object.freeze({
  temperatureF: {
    min: LEGACY_COLOR_MAPS.temperatureF.min,
    max: LEGACY_COLOR_MAPS.temperatureF.max,
    alpha: 0.95,
    thresholdNote: SHARED_LAYERS.temperature?.thresholdNote || null,
    legendTicks: sharedLayerTicks("temperature", [-60, -40, -20, 0, 32, 50, 70, 90, 110, 120]),
    legendStops: normalizedStopsFromValueScale(LEGACY_COLOR_MAPS.temperatureF),
  },
  temperature850C: upperTemperatureScale(LEGACY_COLOR_MAPS.temperature850C, [-40, -30, -20, -10, 0, 10, 20, 30, 40]),
  temperature700C: upperTemperatureScale(LEGACY_COLOR_MAPS.temperature700C, [-40, -30, -20, -10, 0, 10, 20, 30]),
  temperature500C: upperTemperatureScale(LEGACY_COLOR_MAPS.temperature500C, [-50, -40, -30, -20, -10, 0]),
  dewPointF: {
    min: LEGACY_COLOR_MAPS.dewPointF.min,
    max: LEGACY_COLOR_MAPS.dewPointF.max,
    alpha: 0.9,
    legendTicks: [-40, -20, 0, 20, 32, 50, 70, 90],
    legendStops: normalizedStopsFromValueScale(LEGACY_COLOR_MAPS.dewPointF),
  },
  humidityPct: {
    min: LEGACY_COLOR_MAPS.humidityPct.min,
    max: LEGACY_COLOR_MAPS.humidityPct.max,
    alpha: 0.82,
    legendTicks: [0, 25, 50, 75, 100],
    legendStops: normalizedStopsFromValueScale(LEGACY_COLOR_MAPS.humidityPct),
  },
  pressureHpa: {
    min: 960,
    max: 1040,
    alpha: 0.8,
    legendTicks: [960, 980, 1000, 1020, 1040],
    legendStops: [
      [0, [93, 70, 140]],
      [0.45, [74, 151, 179]],
      [0.58, [238, 221, 142]],
      [1, [186, 78, 85]],
    ],
  },
  visibilityMi: {
    min: LEGACY_COLOR_MAPS.visibilityMi.min,
    max: LEGACY_COLOR_MAPS.visibilityMi.max,
    maxVisible: LEGACY_COLOR_MAPS.visibilityMi.max,
    alpha: 1,
    thresholdNote: "Hidden > 15 mi",
    legendTicks: [0, 0.5, 1, 2, 3, 4.5, 6, 8, 10, 12.5, 15],
    legendStops: normalizedStopsFromValueScale(LEGACY_COLOR_MAPS.visibilityMi),
  },
  cloudPct: {
    min: LEGACY_COLOR_MAPS.cloudCoverPct.min,
    max: LEGACY_COLOR_MAPS.cloudCoverPct.max,
    alpha: 1,
    legendTicks: [0, 25, 50, 75, 100],
    legendStops: normalizedStopsFromValueScale(LEGACY_COLOR_MAPS.cloudCoverPct),
  },
  heightFt: {
    min: 0,
    max: 20000,
    alpha: 0.78,
    legendTicks: [0, 5000, 10000, 15000, 20000],
    legendStops: [
      [0, [51, 118, 142]],
      [0.33, [86, 168, 132]],
      [0.66, [223, 194, 102]],
      [1, [215, 104, 83]],
    ],
  },
  windMph: {
    min: LEGACY_COLOR_MAPS.windMph.min,
    max: LEGACY_COLOR_MAPS.windMph.max,
    minVisible: LEGACY_COLOR_MAPS.windMph.min,
    alpha: 0.9,
    thresholdNote: `<${formatTick(LEGACY_COLOR_MAPS.windMph.min)} mph transparent`,
    legendTicks: windLegendTicks(LEGACY_COLOR_MAPS.windMph),
    legendStops: normalizedStopsFromValueScale(LEGACY_COLOR_MAPS.windMph),
  },
  windGustMph: {
    min: LEGACY_COLOR_MAPS.windGustMph.min,
    max: LEGACY_COLOR_MAPS.windGustMph.max,
    minVisible: LEGACY_COLOR_MAPS.windGustMph.min,
    alpha: 0.9,
    thresholdNote: `<${formatTick(LEGACY_COLOR_MAPS.windGustMph.min)} mph transparent`,
    legendTicks: windLegendTicks(LEGACY_COLOR_MAPS.windGustMph),
    legendStops: normalizedStopsFromValueScale(LEGACY_COLOR_MAPS.windGustMph),
  },
  wind700850Kt: upperWindScale(LEGACY_COLOR_MAPS.wind850Kt, [20, 30, 40, 50, 60, 70, 80]),
  wind500Kt: upperWindScale(LEGACY_COLOR_MAPS.wind500Kt, [20, 40, 60, 80, 100, 120, 140]),
  wind250Kt: upperWindScale(LEGACY_COLOR_MAPS.wind250Kt, [50, 70, 90, 110, 130, 150, 170]),
  heightContourDam: {
    min: 0,
    max: 1,
    alpha: 1,
    legendTicks: [],
    legendStops: [
      [0, [23, 23, 23]],
      [1, [23, 23, 23]],
    ],
  },
  precipIn: {
    min: 0.01,
    max: LEGACY_COLOR_MAPS.precipIn.max,
    minVisible: 0.01,
    valueStops: valueStopsFromScale(LEGACY_COLOR_MAPS.precipIn),
    lookup: "step",
    log: true,
    alpha: 1,
    thresholdNote: SHARED_LAYERS.precip?.thresholdNote || "Hidden < 0.01 in",
    legendTicks: sharedLayerTicks("precip", [0.01, 0.1, 0.25, 0.5, 1, 2, 4, 8, 15]),
    legendStops: sharedLayerStops("precip", normalizedStepStopsFromValueScale(LEGACY_COLOR_MAPS.precipIn, true)),
  },
  reflectivityDbz: {
    min: LEGACY_COLOR_MAPS.reflectivityDbz.min,
    max: LEGACY_COLOR_MAPS.reflectivityDbz.max,
    minVisible: 10,
    valueStops: valueStopsFromScale(LEGACY_COLOR_MAPS.reflectivityDbz),
    lookup: "step",
    alpha: 1,
    thresholdNote: REFLECTIVITY_THRESHOLD_NOTE,
    legendTicks: REFLECTIVITY_LEGEND_TICKS,
    legendStops: normalizedStepStopsFromValueScale(LEGACY_COLOR_MAPS.reflectivityDbz),
  },
  reflectivityPrecipType: {
    min: 0,
    max: 75,
    alpha: 1,
    legendTicks: [],
    legendStops: [],
  },
  cape: {
    min: 0,
    max: 5000,
    minVisible: 100,
    alpha: 0.82,
    legendTicks: [0, 1000, 2500, 4000, 5000],
    legendStops: [
      [0, [69, 91, 118]],
      [0.2, [76, 154, 128]],
      [0.5, [207, 196, 83]],
      [0.8, [221, 112, 69]],
      [1, [169, 54, 82]],
    ],
  },
  cin: {
    min: 0,
    max: 300,
    minVisible: 25,
    alpha: 0.75,
    thresholdNote: "Hidden < 25 J/kg",
    legendTicks: [0, 50, 100, 200, 300],
    legendStops: [
      [0, [216, 224, 188]],
      [0.35, [120, 169, 191]],
      [0.65, [101, 105, 174]],
      [1, [76, 50, 120]],
    ],
  },
  helicity: {
    min: 0,
    max: 500,
    minVisible: 25,
    alpha: 0.8,
    legendTicks: [0, 100, 200, 300, 400, 500],
    legendStops: [
      [0, [54, 76, 118]],
      [0.25, [69, 154, 148]],
      [0.5, [215, 190, 82]],
      [0.75, [221, 112, 69]],
      [1, [190, 70, 92]],
    ],
  },
  pwat: {
    min: 0,
    max: 70,
    alpha: 0.82,
    legendTicks: [0, 15, 30, 45, 60],
    legendStops: [
      [0, [74, 86, 119]],
      [0.35, [67, 151, 159]],
      [0.7, [94, 180, 117]],
      [1, [224, 184, 87]],
    ],
  },
  pblHeight: {
    min: 0,
    max: 4000,
    alpha: 0.74,
    legendTicks: [0, 1000, 2000, 3000, 4000],
    legendStops: [
      [0, [76, 91, 122]],
      [0.35, [78, 150, 164]],
      [0.7, [179, 192, 100]],
      [1, [214, 111, 81]],
    ],
  },
  absoluteVorticity1e5S1: plannedScale("absoluteVorticity1e5S1", {
    alpha: 1,
    legendTicks: [0, 10, 20, 30, 40, 50, 60, 70],
    whiteTransparent: true,
  }),
  relativeVorticity1e5S1: relativeVorticityScale(),
  verticalVelocityDPaS: plannedScale("verticalVelocityDPaS", {
    alpha: 1,
    legendTicks: [-60, -40, -20, -10, 0, 10, 20, 30, 40],
    positiveGrayOpacityRampFrom: 0,
    whiteTransparent: true,
  }),
  stormRelativeHelicityM2S2: plannedScale("stormRelativeHelicityM2S2", {
    alpha: 1,
    legendTicks: [0, 100, 200, 300, 400, 500, 600, 850],
    thresholdNote: "Low-end opacity ramp",
  }),
  updraftHelicity2to5kmM2S2: plannedScale("updraftHelicity2to5kmM2S2", {
    alpha: 1,
    legendTicks: [0, 50, 100, 150, 200, 300, 400],
    thresholdNote: "Low-end opacity ramp",
  }),
  capeJkg: plannedScale("capeJkg", {
    alpha: 1,
    legendTicks: [0, 1000, 2000, 3000, 4000, 6000, 10000],
    thresholdNote: "Low-end opacity ramp",
  }),
  dcapeJkg: plannedScale("capeJkg", {
    forceMin: 0,
    forceMax: 2500,
    alpha: 1,
    legendTicks: [0, 500, 1000, 1500, 2000, 2500],
    thresholdNote: "Low-end opacity ramp; values above 2500 J/kg clamp to the top color",
  }),
  cinJkg: plannedScale("cinJkg", {
    alpha: 1,
    legendTicks: [-1000, -600, -400, -200, -100, -50, 0],
    thresholdNote: "Signed negative; near-zero values fade out through the source opacity ramp",
  }),
  surfaceBasedLclM: plannedScale("surfaceBasedLclM", {
    alpha: 1,
    legendTicks: [0, 500, 1000, 1500, 2000, 3000, 4000, 6000, 10000],
  }),
  freezingRainIceIn: plannedScale("freezingRainIceIn", {
    alpha: 1,
    legendTicks: [0.01, 0.05, 0.25, 0.5, 1, 2],
    thresholdNote: "Trace opacity ramp",
  }),
  framIceIn: plannedScale("freezingRainIceIn", {
    alpha: 1,
    legendTicks: [0.01, 0.05, 0.25, 0.5, 1, 2],
    thresholdNote: "FRAM accretion; trace opacity ramp",
  }),
  lapseRateCKm: plannedScale("lapseRateCKm", {
    alpha: 1,
    legendTicks: [4, 5, 6, 7, 8, 9, 10],
    thresholdNote: "Low-end gray ramp uses opacity; no hard hidden threshold",
  }),
  surfaceThetaEK: plannedScale("surfaceThetaEK", {
    alpha: 1,
    legendTicks: [280, 300, 320, 340, 360, 380],
  }),
  frontogenesisCPer100Km3Hr: plannedScale("frontogenesisCPer100Km3Hr", {
    alpha: 1,
    legendTicks: [0, 0.5, 1, 2, 5, 10, 15, 22],
    thresholdNote: "Positive frontogenesis; low-end opacity ramp",
  }),
  supercellCompositeParameter: plannedScale("supercellCompositeParameter", {
    alpha: 1,
    legendTicks: [0, 1, 2, 4, 8, 12, 16],
    thresholdNote: "Low-end opacity ramp",
  }),
  significantTornadoParameter: plannedScale("significantTornadoParameter", {
    alpha: 1,
    legendTicks: [0, 1, 2, 4, 6, 8, 10],
    thresholdNote: "Low-end opacity ramp",
  }),
  cloudCeilingFt: {
    min: 0,
    max: 20000,
    alpha: 0.78,
    legendTicks: [0, 500, 1000, 3000, 5000, 10000, 20000],
    legendStops: [
      [0, [81, 92, 128, 0.9]],
      [0.15, [69, 125, 154, 0.86]],
      [0.35, [91, 158, 145, 0.82]],
      [0.6, [187, 186, 104, 0.76]],
      [1, [218, 142, 93, 0.68]],
    ],
  },
  hailSizeIn: {
    min: 0,
    max: 4,
    minVisible: 0.25,
    alpha: 0.86,
    thresholdNote: "HRRR direct HAIL; hidden < 0.25 in",
    legendTicks: [0.25, 0.5, 1, 2, 3, 4],
    legendStops: [
      [0, [105, 105, 105, 0]],
      [0.125, [108, 161, 190, 0.7]],
      [0.25, [219, 206, 113, 0.82]],
      [0.5, [226, 143, 76, 0.9]],
      [0.75, [196, 72, 83, 0.94]],
      [1, [151, 60, 138, 0.98]],
    ],
  },
  precipRateType: {
    min: 0,
    max: 0.5,
    minVisible: 0.01,
    alpha: 1,
    thresholdNote: "Direct PRATE colored by model precip type; hidden < 0.01 in/hr",
    legendTicks: [0.01, 0.05, 0.1, 0.2, 0.5],
    legendStops: buildPrecipRateTypeOverviewStops(),
  },
  height250m: {
    min: 9000,
    max: 11500,
    alpha: 0.74,
    legendTicks: [9000, 9500, 10000, 10500, 11000, 11500],
    legendStops: UPPER_HEIGHT_STOPS,
  },
  height500m: {
    min: 4800,
    max: 6000,
    alpha: 0.74,
    legendTicks: [4800, 5100, 5400, 5700, 6000],
    legendStops: UPPER_HEIGHT_STOPS,
  },
  height700m: {
    min: 2400,
    max: 3400,
    alpha: 0.74,
    legendTicks: [2400, 2600, 2800, 3000, 3200, 3400],
    legendStops: UPPER_HEIGHT_STOPS,
  },
  height850m: {
    min: 900,
    max: 1800,
    alpha: 0.74,
    legendTicks: [900, 1200, 1500, 1800],
    legendStops: UPPER_HEIGHT_STOPS,
  },
  snowDepthIn: {
    min: 0,
    max: SNOWFALL_IN_MAX,
    minVisible: 0.1,
    alpha: 1,
    positionLegendTicks: true,
    legendDisplayScale: LOW_END_STRETCH_LEGEND_SCALE,
    legendTicks: snowfallLegendTicks(SNOWFALL_LEGEND_COLORS, SNOWFALL_IN_MAX),
    legendStops: normalizedStopsFromValueRows(SNOWFALL_IN_VALUE_STOPS, 0, SNOWFALL_IN_MAX),
  },
  snowWaterEqIn: {
    min: 0,
    max: 8,
    minVisible: 0.05,
    alpha: 0.82,
    legendTicks: [0, 0.5, 1, 2, 4, 6, 8],
    legendStops: [
      [0, [45, 85, 120]],
      [0.25, [74, 137, 184]],
      [0.5, [139, 194, 213]],
      [0.75, [207, 226, 235]],
      [1, [244, 248, 252]],
    ],
  },
  snowfallIn: {
    min: 0,
    max: SNOWFALL_IN_MAX,
    minVisible: 0,
    lookupSize: 65536,
    alpha: 1,
    positionLegendTicks: true,
    legendDisplayScale: LOW_END_STRETCH_LEGEND_SCALE,
    thresholdNote: SNOWFALL_THRESHOLD_NOTE,
    legendTicks: snowfallLegendTicks(SNOWFALL_LEGEND_COLORS, SNOWFALL_IN_MAX),
    legendStops: normalizedStopsFromValueRows(SNOWFALL_IN_VALUE_STOPS, 0, SNOWFALL_IN_MAX),
  },
});

function selector(param, level, options = {}) {
  return { param, level, ...options };
}

function scalar(key, label, unit, group, inputKey, sourceSelector, options = {}) {
  const sourceSelectors = Array.isArray(options.sourceSelectors)
    ? options.sourceSelectors.map((source) => ({
        ...source,
        required: source.required !== false,
      }))
    : [];
  return {
    key,
    label,
    unit,
    group,
    kind: "scalar",
    inputKey,
    selector: options.levelPattern ? { ...sourceSelector, levelPattern: options.levelPattern } : sourceSelector,
    transform: options.transform || "identity",
    scale: options.scale || "humidityPct",
    required: Boolean(options.required),
    thresholdNote: options.thresholdNote || null,
    sourceNote: options.sourceNote || null,
    sourceSelectors,
    anySourceKeyGroups: Array.isArray(options.anySourceKeyGroups)
      ? options.anySourceKeyGroups.map((groupKeys) => [...groupKeys])
      : undefined,
    methodVersion: options.methodVersion || null,
    derivation: options.derivation || null,
    applicability: options.applicability || null,
    formulaReference: options.formulaReference || null,
    hidden: Boolean(options.hidden),
    legendType: options.legendType || null,
    models: Array.isArray(options.models)
      ? options.models.map((model) => String(model || "").toLowerCase()).filter(Boolean)
      : null,
  };
}

function derivedScalar(key, label, unit, group, options = {}) {
  const sourceSelectors = Array.isArray(options.sourceSelectors)
    ? options.sourceSelectors.map((source) => ({
        ...source,
        required: source.required !== false,
      }))
    : [];
  const profileVariables = Array.isArray(options.profileVariables) ? options.profileVariables : [];
  const profileLevels = Array.isArray(options.profileLevels)
    ? options.profileLevels.map((level) => Number(level)).filter(Number.isFinite)
    : profileVariables.length > 0
      ? [...SNOW_PROFILE_LEVELS]
      : [];
  return {
    key,
    label,
    unit,
    group,
    kind: options.kind || "derivedScalar",
    inputKey: options.inputKey || key,
    scale: options.scale || "humidityPct",
    required: Boolean(options.required),
    thresholdNote: options.thresholdNote || null,
    sourceNote: options.sourceNote || null,
    minForecastHour: Number.isFinite(Number(options.minForecastHour)) ? Number(options.minForecastHour) : null,
    accumulationMode: options.accumulationMode || null,
    directInputKey: options.directInputKey || null,
    directSelector: options.directSelector || null,
    sourceSelectors,
    anySourceKeyGroups: Array.isArray(options.anySourceKeyGroups)
      ? options.anySourceKeyGroups.map((groupKeys) => groupKeys.map(String))
      : [],
    profileVariables,
    profileLevels,
    surfaceHeightRequired: Boolean(options.surfaceHeightRequired),
    lazyProfile: Boolean(options.lazyProfile),
    transform: options.transform || "identity",
    methodVersion: options.methodVersion || "derived-noaa-v1",
    derivation: options.derivation || null,
    applicability: options.applicability || null,
    formulaReference: options.formulaReference || null,
    models: Array.isArray(options.models)
      ? options.models.map((model) => String(model || "").toLowerCase()).filter(Boolean)
      : null,
  };
}

function derivedAccumulation(key, label, unit, group, options = {}) {
  return derivedScalar(key, label, unit, group, {
    ...options,
    kind: "derivedAccumulation",
    accumulationMode: options.accumulationMode || "total",
    minForecastHour: Number.isFinite(Number(options.minForecastHour)) ? Number(options.minForecastHour) : 1,
  });
}

function wind(key, label, group, level, options = {}) {
  return {
    key,
    label,
    unit: options.unit || "mph",
    group,
    kind: "wind",
    uKey: options.uKey || `${key}U`,
    vKey: options.vKey || `${key}V`,
    uSelector: selector("UGRD", level),
    vSelector: selector("VGRD", level),
    transform: options.transform || "windMph",
    scale: options.scale || "windMph",
    required: Boolean(options.required),
    thresholdNote: options.thresholdNote || null,
    sourceNote: options.sourceNote || null,
  };
}

function precipRateType(key, label, group, options = {}) {
  return {
    key,
    label,
    unit: "in/hr",
    group,
    kind: "precipRateType",
    rateKey: options.rateKey || "precipRate",
    rateSelector: selector("PRATE", "surface"),
    precipTypeKeys: {
      rain: "precipRateTypeRain",
      snow: "precipRateTypeSnow",
      freezingRain: "precipRateTypeFreezingRain",
      sleet: "precipRateTypeIcePellets",
    },
    precipTypeSelectors: {
      rain: selector("CRAIN", "surface"),
      snow: selector("CSNOW", "surface"),
      freezingRain: selector("CFRZR", "surface"),
      sleet: selector("CICEP", "surface"),
    },
    scale: "precipRateType",
    required: Boolean(options.required),
    thresholdNote: options.thresholdNote || SCALES.precipRateType.thresholdNote,
    sourceNote: options.sourceNote || null,
    methodVersion: options.methodVersion || "direct-prate-categorical-ptype-v2",
    derivation:
      options.derivation ||
      "Uses direct PRATE with colocated categorical precipitation-type masks. APCP interval-average fallback is intentionally omitted to avoid mixing a past-window rate with valid-time phase.",
    legendType: "precip-rate-type",
    models: Array.isArray(options.models)
      ? options.models.map((model) => String(model || "").toLowerCase()).filter(Boolean)
      : null,
  };
}

function heightContour(level, intervalDam) {
  return {
    key: `height${level}`,
    label: `${level} mb Height`,
    unit: "dam",
    group: UPPER_AIR_GROUP,
    kind: "heightContour",
    inputKey: `height${level}`,
    selector: selector("HGT", `${level} mb`),
    transform: "metersToDam",
    scale: "heightContourDam",
    required: false,
    thresholdNote: `${intervalDam} dam contours`,
    sourceNote: null,
    contourIntervalDam: intervalDam,
    contourLevelMb: level,
    legendType: "height-contour",
    methodVersion: "hgt-pressure-contour-simple-v1",
    derivation: `NOAA HGT at ${level} mb converted from meters to decameters and rendered as ${intervalDam} dam height contours.`,
  };
}

function reflectivityPrecipType(key, label, group, options = {}) {
  return {
    key,
    label,
    unit: "dBZ",
    group,
    kind: "reflectivityPrecipType",
    reflectivityKey: options.reflectivityKey || "reflectivity1km",
    reflectivitySelector: selector("REFD", "1000 m above ground"),
    precipTypeKeys: {
      rain: "precipTypeRain",
      snow: "precipTypeSnow",
      freezingRain: "precipTypeFreezingRain",
      sleet: "precipTypeIcePellets",
    },
    precipTypeSelectors: {
      rain: selector("CRAIN", "surface"),
      snow: selector("CSNOW", "surface"),
      freezingRain: selector("CFRZR", "surface"),
      sleet: selector("CICEP", "surface"),
    },
    scale: "reflectivityPrecipType",
    required: Boolean(options.required),
    thresholdNote: options.thresholdNote || REFLECTIVITY_PRECIP_TYPE_THRESHOLD_NOTE,
    sourceNote: options.sourceNote || null,
    methodVersion: options.methodVersion || "direct-1km-refd-categorical-ptype-v1",
    derivation:
      options.derivation ||
      "Uses direct 1 km AGL reflectivity colored by colocated surface categorical precipitation-type masks; it is instantaneous reflectivity/type, not accumulated precipitation.",
  };
}

function precipAccumulation(key, label, options = {}) {
  const windowHours = Number(options.windowHours);
  const total = Boolean(options.total);
  return {
    key,
    label,
    unit: "in",
    group: options.group || PRECIP_GROUP,
    kind: "precipAccumulation",
    inputKey: key,
    selector: selector("APCP", "surface"),
    scale: "precipIn",
    required: false,
    transform: "identity",
    accumulationWindowHours: Number.isFinite(windowHours) ? windowHours : null,
    accumulationMode: total ? "total" : "rolling",
    minForecastHour: 1,
    thresholdNote: options.thresholdNote || PRECIP_ACCUMULATION_THRESHOLD_NOTE,
    sourceNote: options.sourceNote || null,
    methodVersion: total ? "apcp-run-total-accumulation-v1" : "apcp-rolling-window-accumulation-v1",
    derivation: total
      ? "Run-total accumulated surface APCP from forecast hour 0 through the current frame, converted to inches."
      : `${formatTick(windowHours)}-hour accumulated surface APCP window, converted to inches.`,
  };
}

function snowfallDerived(key, label, options = {}) {
  const profileVariables = Array.isArray(options.profileVariables) ? options.profileVariables : [];
  const profileLevels = Array.isArray(options.profileLevels)
    ? options.profileLevels.map((level) => Number(level)).filter(Number.isFinite)
    : profileVariables.length > 0
      ? [...SNOW_PROFILE_LEVELS]
      : [];
  return {
    key,
    label,
    unit: "in",
    group: WINTER_GROUP,
    kind: "snowfallDerived",
    scale: options.scale || "snowfallIn",
    required: false,
    thresholdNote: options.thresholdNote || SNOWFALL_THRESHOLD_NOTE,
    sourceNote: options.sourceNote || null,
    minForecastHour: 1,
    accumulationMode: "total",
    methodVersion: options.methodVersion || "snowfall-derived-v1",
    derivation: options.derivation || null,
    applicability: options.applicability || "Accumulated new snowfall from run start.",
    artifactRequired: options.artifactRequired || null,
    profileVariables,
    profileLevels,
    completeProfileRequired: Boolean(options.completeProfileRequired),
    surfaceHeightRequired: Boolean(options.surfaceHeightRequired),
    lazyProfile: Boolean(options.lazyProfile),
    models: Array.isArray(options.models)
      ? options.models.map((model) => String(model || "").toLowerCase()).filter(Boolean)
      : null,
  };
}

function snowfallDirect(key, label, inputKey, sourceSelector, options = {}) {
  return {
    key,
    label,
    unit: "in",
    group: WINTER_GROUP,
    kind: "snowfallDirect",
    inputKey,
    selector: sourceSelector,
    transform: options.transform || "metersToInches",
    scale: options.scale || "snowfallIn",
    required: false,
    thresholdNote: options.thresholdNote || SNOWFALL_THRESHOLD_NOTE,
    sourceNote: options.sourceNote || null,
    minForecastHour: 1,
    accumulationMode: "total",
    methodVersion: options.methodVersion || "direct-model-field-v1",
    derivation: options.derivation || null,
    applicability: options.applicability || null,
  };
}

const BASE_PARAMETERS = [
  scalar("temperature", "Temp", "F", SURFACE_GROUP, "temperature2m", selector("TMP", "2 m above ground"), {
    transform: "kelvinToFahrenheit",
    scale: "temperatureF",
    required: true,
  }),
  scalar("dewpoint2m", "2 m Dewpoint", "F", SURFACE_GROUP, "dewpoint2m", selector("DPT", "2 m above ground"), {
    transform: "kelvinToFahrenheit",
    scale: "dewPointF",
  }),
  scalar("humidity2m", "2 m RH", "%", SURFACE_GROUP, "humidity2m", selector("RH", "2 m above ground"), {
    scale: "humidityPct",
  }),
  scalar("visibility", "Visibility", "mi", SURFACE_GROUP, "visibility", selector("VIS", "surface"), {
    transform: "metersToMiles",
    scale: "visibilityMi",
  }),
  wind("wind", "Wind", WIND_GROUP, "10 m above ground", {
    required: true,
    uKey: "windU10m",
    vKey: "windV10m",
  }),
  scalar("gust", "Wind Gust", "mph", WIND_GROUP, "gust", selector("GUST", "surface"), {
    transform: "metersPerSecondToMph",
    scale: "windGustMph",
  }),
  wind("wind80m", "80 m Wind", WIND_GROUP, "80 m above ground"),
  precipAccumulation("precip", "1-h Precip", { windowHours: 1 }),
  precipRateType("precipRateAndType", "Precip Rate + Type", PRECIP_GROUP, {
    models: ["gfs", "nam3km", "hrrr"],
  }),
  precipAccumulation("precip3h", "3-h Precip", { windowHours: 3 }),
  precipAccumulation("precip6h", "6-h Precip", { windowHours: 6 }),
  precipAccumulation("precip12h", "12-h Precip", { windowHours: 12 }),
  precipAccumulation("precip24h", "24-h Precip", { windowHours: 24 }),
  precipAccumulation("precipTotal", "Total Precip", { total: true }),
  scalar(
    "reflectivityComposite",
    "Composite Reflectivity",
    "dBZ",
    RADAR_GROUP,
    "reflectivityComposite",
    selector("REFC", null),
    {
      levelPattern: /entire atmosphere/i,
      scale: "reflectivityDbz",
      thresholdNote: REFLECTIVITY_THRESHOLD_NOTE,
    },
  ),
  scalar(
    "reflectivity1km",
    "1 km AGL Reflectivity",
    "dBZ",
    RADAR_GROUP,
    "reflectivity1km",
    selector("REFD", "1000 m above ground"),
    { scale: "reflectivityDbz", thresholdNote: REFLECTIVITY_THRESHOLD_NOTE },
  ),
  reflectivityPrecipType("reflectivity1kmPrecipType", "1 km Reflectivity + Precip Type", RADAR_GROUP),
  scalar("cloudCover", "Total Cloud Cover", "%", CLOUD_GROUP, "cloudCover", selector("TCDC", null), {
    levelPattern: /entire atmosphere/i,
    scale: "cloudPct",
  }),
  scalar("cloudCeiling", "Cloud Ceiling", "ft", CLOUD_GROUP, "cloudCeiling", selector("HGT", "cloud ceiling"), {
    transform: "metersToFeet",
    scale: "cloudCeilingFt",
    models: ["gfs", "nam3km", "hrrr"],
    sourceSelectors: [{ key: "profileSurfaceHeight", selector: selector("HGT", "surface") }],
    sourceNote: "NOAA HGT at cloud ceiling minus surface HGT, converted from meters to feet AGL",
    methodVersion: "cloud-ceiling-msl-to-agl-v1",
    derivation:
      "Cloud-ceiling geopotential height converted to AGL height by subtracting model surface HGT and clamping at zero.",
  }),
  scalar(
    "wetBulbZeroHeight",
    "Wet Bulb Zero",
    "ft",
    WINTER_GROUP,
    "wetBulbZeroHeight",
    selector("HGT", "lowest level of the wet bulb zero"),
    {
      transform: "metersToFeet",
      scale: "heightFt",
      sourceNote: "NOAA HGT at lowest level of the wet bulb zero; converted from meters MSL to feet MSL",
    },
  ),
  scalar("sbcape", "SBCAPE", "J/kg", SEVERE_THERMO_GROUP, "sbcape", selector("CAPE", "surface"), {
    scale: "capeJkg",
    models: ["gfs", "nam3km", "hrrr"],
  }),
  scalar("sbcin", "SBCIN", "J/kg", SEVERE_THERMO_GROUP, "sbcin", selector("CIN", "surface"), {
    scale: "cinJkg",
    models: ["gfs", "nam3km", "hrrr"],
  }),
  scalar("mlcape", "MLCAPE", "J/kg", SEVERE_THERMO_GROUP, "mlcape", selector("CAPE", "90-0 mb above ground"), {
    scale: "capeJkg",
    models: ["gfs", "nam3km", "hrrr"],
  }),
  scalar("mlcin", "MLCIN", "J/kg", SEVERE_THERMO_GROUP, "mlcin", selector("CIN", "90-0 mb above ground"), {
    scale: "cinJkg",
    models: ["gfs", "nam3km", "hrrr"],
  }),
  scalar("mucape", "MUCAPE", "J/kg", SEVERE_THERMO_GROUP, "mucape", selector("CAPE", "255-0 mb above ground"), {
    scale: "capeJkg",
    models: ["gfs", "nam3km", "hrrr"],
  }),
  scalar(
    "srh0to3km",
    "0-3 km SRH",
    "m2/s2",
    SEVERE_KINEMATICS_GROUP,
    "srh0to3km",
    selector("HLCY", "3000-0 m above ground"),
    {
      scale: "stormRelativeHelicityM2S2",
    },
  ),
  scalar(
    "srh0to1km",
    "0-1 km SRH",
    "m2/s2",
    SEVERE_KINEMATICS_GROUP,
    "srh0to1km",
    selector("HLCY", "1000-0 m above ground"),
    {
      scale: "stormRelativeHelicityM2S2",
      models: ["nam3km", "hrrr"],
    },
  ),
  derivedScalar("surfaceBasedLclHeight", "Surface LCL", "m", SEVERE_THERMO_GROUP, {
    scale: "surfaceBasedLclM",
    directInputKey: "surfaceBasedLclHeightDirect",
    directSelector: selector("HGT", "level of adiabatic condensation from sfc"),
    sourceSelectors: [
      { key: "temperature2m", selector: selector("TMP", "2 m above ground") },
      { key: "dewpoint2m", selector: selector("DPT", "2 m above ground"), required: false },
      { key: "humidity2m", selector: selector("RH", "2 m above ground"), required: false },
      { key: "profileSurfaceHeight", selector: selector("HGT", "surface"), required: false },
    ],
    anySourceKeyGroups: [["dewpoint2m", "humidity2m"]],
    methodVersion: "direct-lcl-msl-to-agl-bolton-fallback-v2",
    derivation:
      "Uses direct NOAA LCL HGT minus surface HGT when present; otherwise computes a Bolton-style surface parcel LCL from 2 m temperature and dew point/RH.",
    applicability: "All NOAA beta models with 2 m temperature plus 2 m dew point or RH.",
    formulaReference: "Bolton 1980 LCL temperature approximation.",
  }),
  scalar(
    "updraftHelicity2to5km1h",
    "2-5 km UH",
    "m2/s2",
    SEVERE_KINEMATICS_GROUP,
    "updraftHelicity2to5km1h",
    selector("MXUPHL", "5000-2000 m above ground"),
    { scale: "updraftHelicity2to5kmM2S2", models: ["nam3km", "hrrr"] },
  ),
  scalar(
    "maxSimulatedHailSize",
    "Max Hail Size",
    "in",
    SEVERE_THERMO_GROUP,
    "maxSimulatedHailSize",
    selector("HAIL", null),
    {
      levelPattern: /entire atmosphere/i,
      transform: "metersToInches",
      scale: "hailSizeIn",
      models: ["hrrr"],
    },
  ),
  derivedAccumulation("freezingRainLiquidTotal", "Freezing Rain Liquid", "in", WINTER_GROUP, {
    scale: "freezingRainIceIn",
    directInputKey: "freezingRainLiquidTotalDirect",
    directSelector: selector("FRZR", "surface"),
    sourceSelectors: [
      { key: "precip", selector: selector("APCP", "surface") },
      { key: "precipRateTypeFreezingRain", selector: selector("CFRZR", "surface") },
    ],
    methodVersion: "direct-frzr-or-interval-apcp-cfrzr-v2",
    derivation:
      "Uses direct accumulated FRZR when present; otherwise multiplies accumulated liquid precipitation by interval-average or sampled categorical freezing-rain fraction.",
    applicability:
      "All NOAA beta models after forecast hour 0 when accumulated precipitation and CFRZR are present; direct HRRR FRZR takes precedence.",
    formulaReference: "NOAA categorical precipitation mask weighted liquid accumulation.",
  }),
  scalar("pwat", "Precipitable Water", "mm", SURFACE_GROUP, "pwat", selector("PWAT", null), {
    levelPattern: /entire atmosphere/i,
    scale: "pwat",
  }),
  scalar("pblHeight", "PBL Height", "m", SURFACE_GROUP, "pblHeight", selector("HPBL", "surface"), {
    scale: "pblHeight",
    sourceNote: "NOAA HPBL at surface; model planetary-boundary-layer height in meters AGL",
  }),
  scalar("snowDepth", "Snow Depth", "in", WINTER_GROUP, "snowDepth", selector("SNOD", "surface"), {
    transform: "metersToInches",
    scale: "snowDepthIn",
  }),
  scalar("snowWaterEq", "Snow Water Eq", "in", WINTER_GROUP, "snowWaterEq", selector("WEASD", "surface"), {
    transform: "kgM2ToWaterInches",
    scale: "snowWaterEqIn",
  }),
];

const HEIGHT_CONTOUR_INTERVALS_DAM = Object.freeze({
  850: 3,
  700: 3,
  500: 6,
  300: 12,
  250: 12,
});

const UPPER_AIR_PARAMETERS = [];
for (const level of [850, 700, 500, 300, 250]) {
  UPPER_AIR_PARAMETERS.push(heightContour(level, HEIGHT_CONTOUR_INTERVALS_DAM[level]));
  if (level !== 250 && level !== 300) {
    UPPER_AIR_PARAMETERS.push(
      scalar(`temp${level}`, `${level} mb Temp`, "C", UPPER_AIR_GROUP, `temp${level}`, selector("TMP", `${level} mb`), {
        transform: "kelvinToCelsius",
        scale: `temperature${level}C`,
      }),
      scalar(`rh${level}`, `${level} mb RH`, "%", UPPER_AIR_GROUP, `rh${level}`, selector("RH", `${level} mb`), {
        scale: "humidityPct",
      }),
    );
  }
  if (level === 500 || level === 700) {
    UPPER_AIR_PARAMETERS.push(
      scalar(
        `absoluteVorticity${level}`,
        `${level} mb Abs Vort`,
        "x10^-5 s^-1",
        UPPER_AIR_DIAGNOSTIC_GROUP,
        `absoluteVorticity${level}`,
        selector("ABSV", `${level} mb`),
        {
          transform: "absoluteVorticity1e5",
          scale: "absoluteVorticity1e5S1",
        },
      ),
      scalar(
        `verticalVelocity${level}`,
        `${level} mb Omega`,
        "dPa/s",
        UPPER_AIR_DIAGNOSTIC_GROUP,
        `verticalVelocity${level}`,
        selector("VVEL", `${level} mb`),
        {
          transform: "paSToDPaS",
          scale: "verticalVelocityDPaS",
        },
      ),
    );
  }
  const upperWindScale = level === 250 || level === 300 ? "wind250Kt" : level === 500 ? "wind500Kt" : "wind700850Kt";
  UPPER_AIR_PARAMETERS.push(
    wind(`wind${level}`, `${level} mb Wind`, UPPER_AIR_GROUP, `${level} mb`, {
      unit: "kt",
      transform: "windKt",
      scale: upperWindScale,
    }),
  );
}

const DERIVED_PARAMETERS = [
  derivedScalar("surfaceThetaE", "Surface Theta-e", "K", SEVERE_THERMO_GROUP, {
    scale: "surfaceThetaEK",
    sourceSelectors: [
      { key: "temperature2m", selector: selector("TMP", "2 m above ground") },
      { key: "dewpoint2m", selector: selector("DPT", "2 m above ground"), required: false },
      { key: "humidity2m", selector: selector("RH", "2 m above ground"), required: false },
      { key: "pressureMsl", selector: selector("PRMSL", "mean sea level"), required: false },
      { key: "derivedSurfacePressure", selector: selector("PRES", "surface"), required: false },
      { key: "profileSurfaceHeight", selector: selector("HGT", "surface"), required: false },
    ],
    anySourceKeyGroups: [["dewpoint2m", "humidity2m"]],
    methodVersion: "bolton-thetae-v1",
    derivation:
      "Bolton equivalent potential temperature from 2 m temperature, 2 m dew point/RH, and station pressure; station pressure is estimated from MSLP when a surface pressure field is absent.",
    applicability: "All NOAA beta models with near-surface thermodynamics and either surface pressure or MSLP.",
    formulaReference: "Bolton 1980 equivalent potential temperature approximation.",
  }),
  derivedScalar("lapseRate700to500", "700-500 mb Lapse Rate", "C/km", SEVERE_THERMO_GROUP, {
    scale: "lapseRateCKm",
    sourceSelectors: [
      { key: "temp700", selector: selector("TMP", "700 mb") },
      { key: "temp500", selector: selector("TMP", "500 mb") },
      { key: "height700", selector: selector("HGT", "700 mb") },
      { key: "height500", selector: selector("HGT", "500 mb") },
    ],
    methodVersion: "pressure-layer-lapse-rate-v1",
    derivation: "Temperature difference between 700 and 500 mb divided by geopotential-height separation.",
    applicability: "All NOAA beta models with 700 and 500 mb temperature and height.",
  }),
  derivedScalar("lapseRate0to3km", "0-3 km Lapse Rate", "C/km", SEVERE_THERMO_GROUP, {
    scale: "lapseRateCKm",
    profileVariables: ["TMP", "HGT"],
    profileLevels: DERIVED_DIAGNOSTIC_PROFILE_LEVELS,
    surfaceHeightRequired: true,
    methodVersion: "agl-linear-profile-lapse-rate-v1",
    derivation:
      "Linear interpolation of the pressure-level temperature profile to 3 km AGL, differenced against 2 m temperature.",
    applicability: "All NOAA beta models with surface height, 2 m temperature, and pressure-level temperature/height.",
  }),
  derivedScalar("bulkShear0to6km", "0-6 km Bulk Shear", "kt", SEVERE_KINEMATICS_GROUP, {
    scale: "wind500Kt",
    profileVariables: ["HGT", "UGRD", "VGRD"],
    profileLevels: DERIVED_DIAGNOSTIC_PROFILE_LEVELS,
    surfaceHeightRequired: true,
    methodVersion: "agl-vector-difference-v1",
    derivation: "Vector wind difference between 10 m AGL wind and linearly interpolated 6 km AGL profile wind.",
    applicability: "All NOAA beta models with 10 m wind, surface height, and pressure-level wind/height profiles.",
    formulaReference: "Bulk shear vector difference.",
  }),
  derivedScalar("effectiveBulkShear", "Effective Bulk Shear", "kt", SEVERE_KINEMATICS_GROUP, {
    scale: "wind500Kt",
    thresholdNote: "Masked where effective inflow is absent; <20 kt transparent",
    sourceSelectors: [
      { key: "mlcape", selector: selector("CAPE", "90-0 mb above ground"), required: false },
      { key: "sbcape", selector: selector("CAPE", "surface"), required: false },
      { key: "mlcin", selector: selector("CIN", "90-0 mb above ground"), required: false },
      { key: "sbcin", selector: selector("CIN", "surface"), required: false },
    ],
    anySourceKeyGroups: [
      ["mlcape", "sbcape"],
      ["mlcin", "sbcin"],
    ],
    profileVariables: ["HGT", "UGRD", "VGRD"],
    profileLevels: DERIVED_DIAGNOSTIC_PROFILE_LEVELS,
    surfaceHeightRequired: true,
    methodVersion: "spc-effective-inflow-gated-0-6km-v1",
    derivation:
      "Gates cells by surface or mixed-layer CAPE/CIN effective-inflow thresholds and reports 0-6 km vector shear inside that mask. MUCAPE-only elevated instability and heuristic layer-top estimates are masked until an elevated effective-layer base/top calculation is available.",
    applicability: "All NOAA beta models with near-surface severe thermodynamics and pressure-level wind profiles.",
    formulaReference:
      "SPC effective inflow layer CAPE >= 100 J/kg and CIN >= -250 J/kg thresholds; 0-6 km vector shear proxy.",
  }),
  derivedScalar("supercellCompositeParameter", "SCP (0-3 km Proxy)", "", SEVERE_KINEMATICS_GROUP, {
    scale: "supercellCompositeParameter",
    sourceSelectors: [
      { key: "mucape", selector: selector("CAPE", "255-0 mb above ground") },
      { key: "srh0to3km", selector: selector("HLCY", "3000-0 m above ground") },
      { key: "mlcin", selector: selector("CIN", "90-0 mb above ground"), required: false },
    ],
    profileVariables: ["HGT", "TMP", "RH", "UGRD", "VGRD"],
    profileLevels: DERIVED_DIAGNOSTIC_PROFILE_LEVELS,
    surfaceHeightRequired: true,
    methodVersion: "scp-0to3km-srh-effective-shear-proxy-v1",
    derivation:
      "Legacy/proxy SCP from MUCAPE, direct 0-3 km SRH, and the current effective-inflow-gated 0-6 km shear proxy with SPC-style normalization and nonnegative term clipping.",
    applicability: "All NOAA beta models with MUCAPE, SRH, and wind-profile support.",
    formulaReference: "Legacy fixed/deep-layer SCP proxy; kept alongside the effective-layer SCP product.",
  }),
  derivedScalar("effectiveLayerSupercellCompositeParameter", "SCP (Effective Layer)", "", SEVERE_KINEMATICS_GROUP, {
    scale: "supercellCompositeParameter",
    sourceSelectors: [
      { key: "mucape", selector: selector("CAPE", "255-0 mb above ground") },
      { key: "mlcape", selector: selector("CAPE", "90-0 mb above ground"), required: false },
      { key: "mlcin", selector: selector("CIN", "90-0 mb above ground"), required: false },
      { key: "sbcape", selector: selector("CAPE", "surface"), required: false },
      { key: "sbcin", selector: selector("CIN", "surface"), required: false },
      { key: "temperature2m", selector: selector("TMP", "2 m above ground") },
      { key: "dewpoint2m", selector: selector("DPT", "2 m above ground"), required: false },
      { key: "humidity2m", selector: selector("RH", "2 m above ground"), required: false },
      { key: "pressureMsl", selector: selector("PRMSL", "mean sea level"), required: false },
      { key: "derivedSurfacePressure", selector: selector("PRES", "surface"), required: false },
    ],
    anySourceKeyGroups: [["dewpoint2m", "humidity2m"]],
    profileVariables: ["HGT", "TMP", "RH", "UGRD", "VGRD"],
    profileLevels: EFFECTIVE_LAYER_PROFILE_LEVELS,
    surfaceHeightRequired: true,
    methodVersion: "spc-effective-scp-parcel-sparse-v2",
    derivation:
      "SPC effective-layer SCP formula using every loaded pressure-profile source row for the effective inflow layer: 25 mb spacing from 1000-700 mb and 50 mb spacing from 700-300 mb. Uses model MUCAPE where available, parcel-scanned MU EL, effective-layer Bunkers SRH when valid with fixed 0-6 km Bunkers fallback, and effective bulk wind difference.",
    applicability:
      "All NOAA beta models with MUCAPE, near-surface thermodynamics, and effective-layer pressure-level thermodynamic/wind profiles. Expensive parcel work is limited to conservatively prefiltered instability candidates.",
    formulaReference: "SPC Supercell Composite Parameter effective-layer formula.",
  }),
  derivedScalar("significantTornadoParameter", "STP (Fixed Layer)", "", SEVERE_KINEMATICS_GROUP, {
    scale: "significantTornadoParameter",
    sourceSelectors: [
      { key: "sbcape", selector: selector("CAPE", "surface") },
      { key: "srh0to1km", selector: selector("HLCY", "1000-0 m above ground") },
    ],
    profileVariables: ["HGT", "TMP", "RH", "UGRD", "VGRD"],
    profileLevels: DERIVED_DIAGNOSTIC_PROFILE_LEVELS,
    surfaceHeightRequired: true,
    methodVersion: "spc-fixed-layer-stp-v2",
    derivation:
      "SPC fixed-layer STP from surface-based CAPE, surface LCL, 0-1 km SRH, and 0-6 km bulk shear using standard capped shear/LCL terms.",
    applicability: "All NOAA beta models with surface-based CAPE, 0-1 km SRH, and wind-profile support.",
    formulaReference: "SPC fixed-layer Significant Tornado Parameter.",
  }),
  derivedScalar("effectiveLayerSignificantTornadoParameter", "STP (Effective Layer)", "", SEVERE_KINEMATICS_GROUP, {
    scale: "significantTornadoParameter",
    sourceSelectors: [
      { key: "mlcape", selector: selector("CAPE", "90-0 mb above ground") },
      { key: "mlcin", selector: selector("CIN", "90-0 mb above ground") },
      { key: "sbcape", selector: selector("CAPE", "surface"), required: false },
      { key: "sbcin", selector: selector("CIN", "surface"), required: false },
      { key: "temperature2m", selector: selector("TMP", "2 m above ground") },
      { key: "dewpoint2m", selector: selector("DPT", "2 m above ground"), required: false },
      { key: "humidity2m", selector: selector("RH", "2 m above ground"), required: false },
      { key: "pressureMsl", selector: selector("PRMSL", "mean sea level"), required: false },
      { key: "derivedSurfacePressure", selector: selector("PRES", "surface"), required: false },
    ],
    anySourceKeyGroups: [["dewpoint2m", "humidity2m"]],
    profileVariables: ["HGT", "TMP", "RH", "UGRD", "VGRD"],
    profileLevels: EFFECTIVE_LAYER_PROFILE_LEVELS,
    surfaceHeightRequired: true,
    methodVersion: "spc-effective-stp-parcel-sparse-v2",
    derivation:
      "SPC effective-layer STP formula using MLCAPE and every loaded pressure-profile source row for the effective inflow layer: 25 mb spacing from 1000-700 mb and 50 mb spacing from 700-300 mb. Uses mixed-layer LCL, effective-layer Bunkers SRH when valid with fixed 0-6 km Bunkers fallback, EBWD, and MLCIN. The index is zeroed when the effective inflow base is above ground.",
    applicability:
      "All NOAA beta models with mixed-layer CAPE/CIN, near-surface thermodynamics, and effective-layer pressure-level thermodynamic/wind profiles. Expensive parcel work is limited to conservatively prefiltered instability candidates.",
    formulaReference: "SPC effective-layer Significant Tornado Parameter.",
  }),
  derivedScalar("dcape", "DCAPE", "J/kg", SEVERE_THERMO_GROUP, {
    scale: "dcapeJkg",
    sourceSelectors: [
      { key: "temperature2m", selector: selector("TMP", "2 m above ground") },
      { key: "dewpoint2m", selector: selector("DPT", "2 m above ground"), required: false },
      { key: "humidity2m", selector: selector("RH", "2 m above ground"), required: false },
      { key: "pressureMsl", selector: selector("PRMSL", "mean sea level"), required: false },
      { key: "derivedSurfacePressure", selector: selector("PRES", "surface"), required: false },
      { key: "profileSurfaceHeight", selector: selector("HGT", "surface"), required: false },
    ],
    anySourceKeyGroups: [["dewpoint2m", "humidity2m"]],
    profileVariables: ["TMP", "HGT", "RH"],
    profileLevels: DERIVED_DIAGNOSTIC_PROFILE_LEVELS,
    surfaceHeightRequired: false,
    methodVersion: "reduced-profile-dcape-v2",
    derivation:
      "Reduced-profile downdraft CAPE approximation using the minimum wet-bulb/theta-e layer from 500-800 mb and a dry-adiabatic descent buoyancy integration against the sampled environmental temperature profile.",
    applicability: "All NOAA beta models with near-surface thermodynamics plus pressure-level temperature/RH/height.",
    formulaReference:
      "Fast reduced-profile DCAPE approximation; not a full MetPy/Emanuel downdraft parcel calculation.",
  }),
  derivedScalar("frontogenesis850", "850 mb Frontogenesis", "C/100km/3hr", UPPER_AIR_DIAGNOSTIC_GROUP, {
    scale: "frontogenesisCPer100Km3Hr",
    sourceSelectors: [
      { key: "temp850", selector: selector("TMP", "850 mb") },
      { key: "wind850U", selector: selector("UGRD", "850 mb") },
      { key: "wind850V", selector: selector("VGRD", "850 mb") },
    ],
    methodVersion: "petterssen-latlon-finite-difference-v2",
    derivation:
      "Petterssen frontogenesis from 850 mb potential-temperature and wind gradients using latitude-aware finite differences; PNG rendering applies positive-only display smoothing while hover values remain raw.",
    applicability: "All NOAA beta models with 850 mb temperature and winds.",
    formulaReference: "Petterssen two-dimensional frontogenesis.",
  }),
  derivedScalar("frontogenesis700", "700 mb Frontogenesis", "C/100km/3hr", UPPER_AIR_DIAGNOSTIC_GROUP, {
    scale: "frontogenesisCPer100Km3Hr",
    sourceSelectors: [
      { key: "temp700", selector: selector("TMP", "700 mb") },
      { key: "wind700U", selector: selector("UGRD", "700 mb") },
      { key: "wind700V", selector: selector("VGRD", "700 mb") },
    ],
    methodVersion: "petterssen-latlon-finite-difference-v2",
    derivation:
      "Petterssen frontogenesis from 700 mb potential-temperature and wind gradients using latitude-aware finite differences; PNG rendering applies positive-only display smoothing while hover values remain raw.",
    applicability: "All NOAA beta models with 700 mb temperature and winds.",
    formulaReference: "Petterssen two-dimensional frontogenesis.",
  }),
  derivedScalar("relativeVorticity700", "700 mb Rel Vort", "x10^-5 s^-1", UPPER_AIR_DIAGNOSTIC_GROUP, {
    scale: "relativeVorticity1e5S1",
    sourceSelectors: [{ key: "absoluteVorticity700", selector: selector("ABSV", "700 mb") }],
    methodVersion: "absv-minus-coriolis-v1",
    derivation: "Relative vorticity computed as absolute vorticity minus f = 2 * Omega * sin(latitude).",
    applicability: "All NOAA beta models with 700 mb absolute vorticity.",
    formulaReference: "NOAA/MetPy Coriolis parameter with Omega = 7.2921e-5 rad/s.",
  }),
  derivedScalar("relativeVorticity500", "500 mb Rel Vort", "x10^-5 s^-1", UPPER_AIR_DIAGNOSTIC_GROUP, {
    scale: "relativeVorticity1e5S1",
    sourceSelectors: [{ key: "absoluteVorticity500", selector: selector("ABSV", "500 mb") }],
    methodVersion: "absv-minus-coriolis-v1",
    derivation: "Relative vorticity computed as absolute vorticity minus f = 2 * Omega * sin(latitude).",
    applicability: "All NOAA beta models with 500 mb absolute vorticity.",
    formulaReference: "NOAA/MetPy Coriolis parameter with Omega = 7.2921e-5 rad/s.",
  }),
  derivedAccumulation("gustRunMax", "Run Max Gust", "mph", WIND_GROUP, {
    scale: "windGustMph",
    sourceSelectors: [{ key: "gust", selector: selector("GUST", "surface") }],
    methodVersion: "run-max-gust-v2",
    derivation: "Pixelwise run maximum of surface gust fields from forecast hour 1 through the current frame.",
    applicability: "All NOAA beta models with surface gust.",
  }),
  derivedAccumulation("updraftHelicity2to5kmRunMax", "Run Max 2-5 km UH", "m2/s2", SEVERE_KINEMATICS_GROUP, {
    scale: "updraftHelicity2to5kmM2S2",
    sourceSelectors: [{ key: "updraftHelicity2to5km1h", selector: selector("MXUPHL", "5000-2000 m above ground") }],
    methodVersion: "run-max-interval-mxuphl-v2",
    derivation:
      "Pixelwise run maximum of 2-5 km updraft-helicity interval-maximum fields from forecast hour 1 through the current frame.",
    applicability: "NOAA beta convective-allowing models with MXUPHL.",
  }),
  derivedAccumulation("framFlatIce", "FRAM Flat Ice", "in", WINTER_GROUP, {
    scale: "framIceIn",
    sourceSelectors: [
      { key: "precip", selector: selector("APCP", "surface") },
      { key: "precipRateTypeFreezingRain", selector: selector("CFRZR", "surface") },
      { key: "temperature2m", selector: selector("TMP", "2 m above ground") },
      { key: "humidity2m", selector: selector("RH", "2 m above ground"), required: false },
      { key: "dewpoint2m", selector: selector("DPT", "2 m above ground"), required: false },
      { key: "windU10m", selector: selector("UGRD", "10 m above ground") },
      { key: "windV10m", selector: selector("VGRD", "10 m above ground") },
    ],
    anySourceKeyGroups: [["dewpoint2m", "humidity2m"]],
    methodVersion: "sanders-barjenbruch-fram-flat-v1",
    derivation:
      "Sanders-Barjenbruch FRAM elevated-horizontal ice accretion from interval freezing-rain liquid, precipitation rate, wet-bulb temperature, and wind speed.",
    applicability:
      "All NOAA beta models after forecast hour 0 when freezing-rain liquid, near-surface wet-bulb inputs, and wind are present.",
    formulaReference: "Sanders and Barjenbruch 2016 FRAM ILR equations.",
  }),
  derivedAccumulation("framRadialIce", "FRAM Radial Ice", "in", WINTER_GROUP, {
    scale: "framIceIn",
    sourceSelectors: [
      { key: "precip", selector: selector("APCP", "surface") },
      { key: "precipRateTypeFreezingRain", selector: selector("CFRZR", "surface") },
      { key: "temperature2m", selector: selector("TMP", "2 m above ground") },
      { key: "humidity2m", selector: selector("RH", "2 m above ground"), required: false },
      { key: "dewpoint2m", selector: selector("DPT", "2 m above ground"), required: false },
      { key: "windU10m", selector: selector("UGRD", "10 m above ground") },
      { key: "windV10m", selector: selector("VGRD", "10 m above ground") },
    ],
    anySourceKeyGroups: [["dewpoint2m", "humidity2m"]],
    methodVersion: "sanders-barjenbruch-fram-radial-v1",
    derivation:
      "Sanders-Barjenbruch FRAM elevated-horizontal ice accretion converted to equivalent radial ice using Req = 0.394 * Ti.",
    applicability:
      "All NOAA beta models after forecast hour 0 when freezing-rain liquid, near-surface wet-bulb inputs, and wind are present.",
    formulaReference: "Sanders and Barjenbruch 2016 FRAM plus Ryerson/Ramsay radial conversion.",
  }),
];

const SNOWFALL_PARAMETERS = [
  snowfallDerived("snow10to1", "10:1 Snow", {
    methodVersion: "snow10to1-v1",
    derivation: "Run-total snow-liquid water equivalent multiplied by a fixed 10:1 snow-to-liquid ratio.",
    applicability: "All NOAA beta models when accumulated precipitation and categorical snow masks are present.",
  }),
  snowfallDerived("snowKuchera", "Kuchera Snow", {
    methodVersion: "kuchera-surface-to-500mb-profile-v2",
    derivation:
      "Interval snow-liquid water equivalent multiplied by a Kuchera ratio from the warmest available surface-to-500 mb profile temperature.",
    applicability:
      "All NOAA beta models with accumulated snow-liquid input and surface-to-500 mb pressure-profile temperature/height fields.",
    profileVariables: ["TMP", "HGT"],
    profileLevels: KUCHERA_PROFILE_LEVELS,
    completeProfileRequired: true,
    lazyProfile: true,
  }),
  snowfallDerived("snowCobb", "Cobb Snow", {
    methodVersion: "cobb-waldstreicher-925to300mb-profile-v2",
    derivation:
      "Interval snow-liquid water equivalent multiplied by a Cobb/Waldstreicher profile SLR using 925-300 mb temperature, humidity, height, and omega.",
    applicability:
      "All NOAA beta models with accumulated snow-liquid input plus 925-300 mb TMP/HGT/RH/VVEL pressure profiles.",
    profileVariables: ["TMP", "HGT", "RH", "VVEL"],
    profileLevels: COBB_PROFILE_LEVELS,
    completeProfileRequired: true,
    lazyProfile: true,
  }),
  snowfallDerived("snowRfConus", "RF Snow", {
    methodVersion: "pletcher-conus-rf-2d35566",
    derivation:
      "Pletcher CONUS random-forest SLR using SPD/T/RH at 300-2400 m AGL plus latitude, longitude, and elevation, then multiplied by snow-liquid water equivalent.",
    applicability:
      "All NOAA beta models after the pinned utahrfslr model has been exported to compact Node tree arrays.",
    artifactRequired: "snow-rf/conus-rf.json",
    profileVariables: ["TMP", "HGT", "RH", "UGRD", "VGRD"],
    surfaceHeightRequired: true,
    lazyProfile: true,
  }),
  snowfallDerived("snowWesternLinear", "Western Linear Snow", {
    methodVersion: "veals-western-v1c-linear-5304094",
    derivation:
      "Veals et al. V1c HRRR linear SLR using T04K, T24K, SPD04K, and SPD24K, then multiplied by snow-liquid water equivalent.",
    applicability:
      "HRRR western elevated terrain only; restricted to areas west of 103W with surface elevation >=1000 m.",
    artifactRequired: "snow-rf/western-linear-v1c.json",
    profileVariables: ["TMP", "HGT", "UGRD", "VGRD"],
    surfaceHeightRequired: true,
    lazyProfile: true,
    models: ["hrrr"],
  }),
  snowfallDirect("snowHrrrAsnow", "HRRR ASNOW", "snowHrrrAsnow", selector("ASNOW", "surface"), {
    methodVersion: "hrrr-asnow-v1",
    derivation: "Direct HRRR internal accumulated snowfall field converted to inches.",
    applicability: "HRRR only when ASNOW:surface is present.",
  }),
];

const NOAA_NAM_PARAMETER_CATALOG = Object.freeze(
  [...BASE_PARAMETERS, ...UPPER_AIR_PARAMETERS, ...DERIVED_PARAMETERS, ...SNOWFALL_PARAMETERS].map(freezeEntry),
);
const NOAA_NAM_PARAMETER_ORDER = Object.freeze(NOAA_NAM_PARAMETER_CATALOG.map((entry) => entry.key));

const SUPPORT_SELECTORS = Object.freeze({
  pressureMsl: selector("PRMSL", "mean sea level"),
  height500: selector("HGT", "500 mb"),
  height1000: selector("HGT", "1000 mb"),
});

function getNoaaNamParameterMetadata() {
  const out = {};
  for (const entry of NOAA_NAM_PARAMETER_CATALOG) {
    if (entry.hidden) {
      continue;
    }
    const scale = resolveScale(entry);
    const stops = buildLegendStops(entry, scale);
    out[entry.key] = {
      key: entry.key,
      label: entry.label,
      unit: entry.unit,
      group: entry.group,
      thresholdNote: entry.thresholdNote || scale.thresholdNote || null,
      legendTicks: [...(scale.legendTicks || [])],
      legendTickPositions: buildLegendTickPositions(scale),
      legendStops: stops,
    };
    const sourceNote = entry.sourceNote || buildParameterSourceNote(entry);
    if (sourceNote) {
      out[entry.key].sourceNote = sourceNote;
    }
    copyParameterMethodMetadata(out[entry.key], entry);
    if (scale.legendDisplayScale) {
      out[entry.key].legendDisplayScale = { ...scale.legendDisplayScale };
    }
    if (entry.kind === "reflectivityPrecipType") {
      out[entry.key].legendType = "precip-type-reflectivity";
      out[entry.key].precipTypeLegend = buildReflectivityPrecipTypeLegend();
    }
    if (entry.kind === "precipRateType") {
      out[entry.key].legendType = entry.legendType || "precip-rate-type";
      out[entry.key].precipRateTypeLegend = buildPrecipRateTypeLegend();
    }
    if (entry.kind === "precipAccumulation") {
      out[entry.key].accumulationWindowHours = entry.accumulationWindowHours;
      out[entry.key].accumulationMode = entry.accumulationMode;
      out[entry.key].minForecastHour = entry.minForecastHour;
    }
    if (entry.kind === "derivedScalar" || entry.kind === "derivedAccumulation") {
      if (entry.kind === "derivedAccumulation") {
        out[entry.key].accumulationMode = entry.accumulationMode;
        out[entry.key].minForecastHour = entry.minForecastHour;
      }
      out[entry.key].methodVersion = entry.methodVersion;
      out[entry.key].derivation = entry.derivation;
      out[entry.key].applicability = entry.applicability;
      out[entry.key].formulaReference = entry.formulaReference || null;
    }
    if (entry.kind === "heightContour") {
      out[entry.key].legendType = entry.legendType || "height-contour";
      out[entry.key].contourIntervalDam = entry.contourIntervalDam;
      out[entry.key].contourLevelMb = entry.contourLevelMb;
    }
    if (entry.kind === "snowfallDerived" || entry.kind === "snowfallDirect") {
      out[entry.key].accumulationMode = entry.accumulationMode;
      out[entry.key].minForecastHour = entry.minForecastHour;
      out[entry.key].methodVersion = entry.methodVersion;
      out[entry.key].derivation = entry.derivation;
      out[entry.key].applicability = entry.applicability;
      out[entry.key].artifactRequired = entry.artifactRequired || null;
    }
  }
  return out;
}

function copyParameterMethodMetadata(target, entry) {
  if (entry.methodVersion) {
    target.methodVersion = entry.methodVersion;
  }
  if (entry.derivation) {
    target.derivation = entry.derivation;
  }
  if (entry.applicability) {
    target.applicability = entry.applicability;
  }
  if (entry.formulaReference) {
    target.formulaReference = entry.formulaReference;
  }
}

function buildParameterSourceNote(entry) {
  if (!entry) {
    return null;
  }
  if (entry.kind === "scalar") {
    return buildScalarSourceNote(entry);
  }
  if (entry.kind === "wind") {
    return buildWindSourceNote(entry);
  }
  if (entry.kind === "precipAccumulation") {
    return buildPrecipAccumulationSourceNote(entry);
  }
  if (entry.kind === "precipRateType") {
    return buildPrecipRateTypeSourceNote(entry);
  }
  if (entry.kind === "reflectivityPrecipType") {
    return buildReflectivityPrecipTypeSourceNote(entry);
  }
  if (entry.kind === "heightContour") {
    return buildHeightContourSourceNote(entry);
  }
  if (entry.kind === "derivedScalar" || entry.kind === "derivedAccumulation") {
    return buildDerivedSourceNote(entry);
  }
  if (entry.kind === "snowfallDerived") {
    return buildSnowfallDerivedSourceNote(entry);
  }
  if (entry.kind === "snowfallDirect") {
    return buildScalarSourceNote(entry);
  }
  return null;
}

function buildScalarSourceNote(entry) {
  return joinNoteParts([formatNoaaSelector(entry.selector), formatTransformNote(entry.transform)]);
}

function buildWindSourceNote(entry) {
  return joinNoteParts([
    `NOAA UGRD/VGRD at ${formatSelectorLevel(entry.uSelector) || "selected level"}`,
    `vector speed converted from m/s components to ${entry.unit || "display units"}`,
  ]);
}

function buildPrecipAccumulationSourceNote(entry) {
  const mode =
    entry.accumulationMode === "total"
      ? "run-total accumulation"
      : `${formatTick(entry.accumulationWindowHours)}-hour rolling accumulation`;
  return joinNoteParts([formatNoaaSelector(entry.selector), `${mode} converted from millimeters to inches`]);
}

function buildPrecipRateTypeSourceNote(entry) {
  const masks = Object.values(entry.precipTypeSelectors || {})
    .map((selector) => selector.param)
    .filter(Boolean)
    .join("/");
  return joinNoteParts([
    `${formatNoaaSelector(entry.rateSelector)} converted from kg/m2/s to in/hr`,
    masks ? `${masks} surface masks color the precipitation type` : null,
  ]);
}

function buildReflectivityPrecipTypeSourceNote(entry) {
  const masks = Object.values(entry.precipTypeSelectors || {})
    .map((selector) => selector.param)
    .filter(Boolean)
    .join("/");
  return joinNoteParts([
    formatNoaaSelector(entry.reflectivitySelector),
    masks ? `${masks} surface masks color the precipitation type` : null,
  ]);
}

function buildHeightContourSourceNote(entry) {
  return joinNoteParts([
    formatNoaaSelector(entry.selector),
    formatTransformNote(entry.transform),
    `${entry.contourIntervalDam} dam contour interval`,
  ]);
}

function buildDerivedSourceNote(entry) {
  return joinNoteParts([
    entry.directSelector ? `Direct field when present: ${formatSelectorRef(entry.directSelector)}` : null,
    formatSourceSelectorSummary(entry.sourceSelectors),
    formatProfileSourceSummary(entry),
  ]);
}

function buildSnowfallDerivedSourceNote(entry) {
  return joinNoteParts([
    "Snow-liquid accumulation from direct model snow-water fields when available or APCP with complete snow phase masks",
    formatProfileSourceSummary(entry),
    entry.artifactRequired ? `Uses artifact ${entry.artifactRequired}` : null,
  ]);
}

function formatSourceSelectorSummary(selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    return null;
  }
  const required = selectors.filter((selector) => selector.required !== false).map(formatSelectorRef);
  const optional = selectors.filter((selector) => selector.required === false).map(formatSelectorRef);
  const requiredSummary = required.length > 0 ? `Inputs include ${formatShortList(required, 4)}` : null;
  const optionalSummary =
    optional.length > 0 ? `Optional/fallback inputs include ${formatShortList(optional, 4)}` : null;
  return joinNoteParts([requiredSummary, optionalSummary]);
}

function formatProfileSourceSummary(entry) {
  if (!Array.isArray(entry.profileVariables) || entry.profileVariables.length === 0) {
    return null;
  }
  return `Profile inputs: ${entry.profileVariables.join("/")} at ${formatProfileLevels(entry.profileLevels)}`;
}

function formatShortList(values, limit) {
  const clean = values.filter(Boolean);
  if (clean.length <= limit) {
    return clean.join(", ");
  }
  return `${clean.slice(0, limit).join(", ")} +${clean.length - limit} more`;
}

function formatProfileLevels(levels) {
  if (!Array.isArray(levels) || levels.length === 0) {
    return "configured pressure levels";
  }
  if (levels.length <= 8) {
    return `${levels.join(", ")} mb`;
  }
  const first = levels[0];
  const last = levels[levels.length - 1];
  const spacing = uniqueLevelSpacing(levels);
  return `${first}-${last} mb (${levels.length} levels; ${spacing.join("/")} mb spacing)`;
}

function uniqueLevelSpacing(levels) {
  const out = [];
  for (let index = 1; index < levels.length; index += 1) {
    const spacing = Math.abs(Number(levels[index - 1]) - Number(levels[index]));
    if (Number.isFinite(spacing) && spacing > 0 && !out.includes(spacing)) {
      out.push(spacing);
    }
  }
  return out.length > 0 ? out : ["mixed"];
}

function formatNoaaSelector(selector) {
  const ref = formatSelectorRef(selector);
  return ref ? `NOAA ${ref}` : null;
}

function formatSelectorRef(selector) {
  const source = selector?.selector || selector;
  if (!source?.param) {
    return null;
  }
  const level = formatSelectorLevel(source);
  return level ? `${source.param} at ${level}` : String(source.param);
}

function formatSelectorLevel(selector) {
  if (selector?.level) {
    return String(selector.level);
  }
  if (!selector?.levelPattern) {
    return null;
  }
  const source = String(selector.levelPattern.source || selector.levelPattern);
  if (/entire atmosphere/i.test(source)) {
    return "entire atmosphere";
  }
  return `level matching ${String(selector.levelPattern)}`;
}

function formatTransformNote(transform) {
  if (!transform || transform === "identity") {
    return null;
  }
  const notes = {
    kelvinToFahrenheit: "converted from K to F",
    kelvinToCelsius: "converted from K to C",
    pascalToHpa: "converted from Pa to hPa",
    kgKgToGkg: "converted from kg/kg to g/kg",
    metersToMiles: "converted from meters to miles",
    metersToFeet: "converted from meters to feet",
    metersToDam: "converted from meters to decameters",
    metersToInches: "converted from meters to inches",
    kgM2ToWaterInches: "converted from kg/m2 water equivalent to inches",
    absoluteVorticity1e5: "scaled to x10^-5 s^-1",
    paSToDPaS: "converted from Pa/s to dPa/s",
    metersPerSecondToKnots: "converted from m/s to knots",
    metersPerSecondToMph: "converted from m/s to mph",
    windMph: "converted from m/s components to mph",
    windKt: "converted from m/s components to kt",
  };
  return notes[transform] || `transform: ${transform}`;
}

function joinNoteParts(parts) {
  return parts.filter(Boolean).join("; ");
}

function getNoaaNamParameterOrder() {
  return NOAA_NAM_PARAMETER_CATALOG.filter((entry) => !entry.hidden).map((entry) => entry.key);
}

function resolveScale(entry) {
  return SCALES[entry.scale] || SCALES.humidityPct;
}

function buildLegendStops(entry, scale) {
  if (entry.kind === "reflectivityPrecipType") {
    return buildReflectivityPrecipTypeOverviewStops();
  }
  if (entry.kind === "precipRateType") {
    return buildPrecipRateTypeOverviewStops();
  }
  return (scale.legendStops || []).map(([position, color]) => [position, [...color]]);
}

function buildLegendTickPositions(scale) {
  if (!scale?.positionLegendTicks) {
    return [];
  }
  const ticks = Array.isArray(scale?.legendTicks) ? scale.legendTicks : [];
  return ticks.map((tick) =>
    normalizeValueForLegend(tick, scale?.min ?? 0, scale?.max ?? 1, {
      displayScale: scale?.legendDisplayScale,
      log: Boolean(scale?.legendLog ?? scale?.log),
    }),
  );
}

function buildReflectivityPrecipTypeLegend() {
  const types = REFLECTIVITY_PRECIP_TYPE_COLORS.precipTypes || {};
  return ["rain", "snow", "freezing_rain", "sleet"]
    .map((key) => {
      const type = types[key];
      if (!type || !Array.isArray(type.bins)) {
        return null;
      }
      return {
        key,
        label: type.displayName || key,
        filterDbz: Number(type.filterDbz),
        tickLabels: Array.isArray(type.visibleTickLabelsDbz)
          ? type.visibleTickLabelsDbz.map((value) => Number(value)).filter(Number.isFinite)
          : [],
        bins: type.bins.map((bin) => ({
          label: String(bin.label || ""),
          startDbz: Number.isFinite(Number(bin.startDbz)) ? Number(bin.startDbz) : null,
          minDbz: Number.isFinite(Number(bin.minDbzInclusive)) ? Number(bin.minDbzInclusive) : null,
          maxDbz: Number.isFinite(Number(bin.maxDbzExclusive)) ? Number(bin.maxDbzExclusive) : null,
          color: normalizeLegendRgba(bin.webColor?.rgb, bin.webColor?.alpha),
        })),
      };
    })
    .filter(Boolean);
}

function buildPrecipRateTypeLegend() {
  const types = PLANNED_COLOR_MAPS?.maps?.precipRateByTypeInHr?.types || {};
  return [
    ["rain", "Rain", types.rain],
    ["snow", "Snow", types.snow],
    ["freezing_rain", "Freezing Rain", types.freezing_rain],
    ["sleet", "Sleet", types.sleet],
  ]
    .map(([key, label, type]) => {
      const bins = precipRateTypeBins(type);
      if (bins.length === 0) {
        return null;
      }
      return {
        key,
        label,
        unit: "in/hr",
        tickLabels: Array.isArray(type?.legendTicks)
          ? type.legendTicks.map((tick) => Number(tick)).filter(Number.isFinite)
          : [],
        bins,
      };
    })
    .filter(Boolean);
}

function precipRateTypeBins(type) {
  const stops = Array.isArray(type?.valueStops) ? type.valueStops : [];
  return stops
    .map((stop, index) => {
      const value = Number(stop?.[0]);
      const color = normalizeLegendRgba(stop?.[1], stop?.[2]);
      if (!Number.isFinite(value)) {
        return null;
      }
      return {
        label: formatRateTick(value),
        minRate: value,
        maxRate: Number.isFinite(Number(stops[index + 1]?.[0])) ? Number(stops[index + 1][0]) : null,
        color,
      };
    })
    .filter(Boolean)
    .filter((bin, index, rows) => {
      if (Number(bin.color?.[3]) > 0) {
        return true;
      }
      const next = rows[index + 1];
      return next && Number(next.color?.[3]) > 0;
    });
}

function buildPrecipRateTypeOverviewStops() {
  const rows = buildPrecipRateTypeLegend();
  if (rows.length === 0) {
    return [
      [0, [47, 175, 34, 0.45]],
      [0.333333, [66, 183, 245, 0.45]],
      [0.666667, [213, 58, 130, 0.45]],
      [1, [116, 65, 149, 0.45]],
    ];
  }
  return rows.map((row, index) => {
    const visible = row.bins.find((bin) => Number(bin.color?.[3]) > 0) || row.bins[0];
    return [rows.length <= 1 ? 0 : index / (rows.length - 1), [...visible.color]];
  });
}

function buildReflectivityPrecipTypeOverviewStops() {
  const rows = buildReflectivityPrecipTypeLegend();
  if (rows.length === 0) {
    return [];
  }
  return rows.map((row, index) => {
    const visible = row.bins.find((bin) => Number(bin.color?.[3]) > 0) || row.bins[0];
    return [rows.length <= 1 ? 0 : index / (rows.length - 1), [...visible.color]];
  });
}

function normalizeLegendRgba(rgb, alpha) {
  const source = Array.isArray(rgb) ? rgb : [0, 0, 0];
  const numericAlpha = Number(alpha);
  return [
    clampInt(source[0], 0, 255),
    clampInt(source[1], 0, 255),
    clampInt(source[2], 0, 255),
    Number.isFinite(numericAlpha) ? clamp01(numericAlpha) : 0,
  ];
}

function upperTemperatureScale(scale, legendTicks) {
  return {
    min: scale.min,
    max: scale.max,
    alpha: 0.95,
    legendTicks,
    legendStops: normalizedStopsFromValueScale(scale),
  };
}

function upperWindScale(scale, legendTicks) {
  return {
    min: scale.min,
    max: scale.max,
    minVisible: scale.min,
    alpha: 0.9,
    thresholdNote: `<${formatTick(scale.min)} kt transparent`,
    legendTicks,
    legendStops: normalizedStopsFromValueScale(scale),
  };
}

function relativeVorticityScale() {
  const base = plannedScale("relativeVorticity1e5S1", {
    alpha: 1,
    legendTicks: [-40, -20, -10, 0, 10, 20, 40, 60],
    thresholdNote: "0 transparent; weak values fade from zero",
    whiteTransparent: true,
  });
  const valueStops = relativeVorticityStopsWithZeroAlphaRamp(
    valueStopsFromPlannedMap(PLANNED_COLOR_MAPS?.maps?.relativeVorticity1e5S1, {
      whiteTransparent: true,
    }),
  );
  return {
    ...base,
    legendStops: normalizedStopsFromValueRows(valueStops, base.min, base.max),
    valueStops,
  };
}

function relativeVorticityStopsWithZeroAlphaRamp(valueStops) {
  const negativeStops = [];
  const positiveStops = [];
  for (const [value, color] of valueStops) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || isDarkRelativeVorticityZeroStop(numericValue, color)) {
      continue;
    }
    if (numericValue < 0 && !isTransparentColorStop(color)) {
      negativeStops.push([numericValue, color]);
    } else if (numericValue > 0) {
      positiveStops.push([numericValue, color]);
    }
  }
  negativeStops.sort((a, b) => a[0] - b[0]);
  positiveStops.sort((a, b) => a[0] - b[0]);
  const nearestNegative = negativeStops[negativeStops.length - 1]?.[1];
  const positiveZero = transparentColorLike(positiveStops[0]?.[1], RELATIVE_VORTICITY_POSITIVE_ZERO_RGB);
  return [
    ...negativeStops,
    ...(nearestNegative ? [[-1, nearestNegative]] : []),
    [0, [0, 0, 0, 0]],
    [0, positiveZero],
    ...positiveStops,
  ];
}

function transparentColorLike(color, fallbackRgb = [0, 0, 0]) {
  const source = Array.isArray(color) && color.length >= 3 ? color : fallbackRgb;
  return [clampInt(source[0], 0, 255), clampInt(source[1], 0, 255), clampInt(source[2], 0, 255), 0];
}

function isTransparentColorStop(color) {
  return Array.isArray(color) && Number.isFinite(Number(color[3])) && Number(color[3]) <= 1e-6;
}

function isDarkRelativeVorticityZeroStop(value, color) {
  return (
    Math.abs(Number(value)) < 1e-9 &&
    Array.isArray(color) &&
    Number(color[0]) < 10 &&
    Number(color[1]) < 10 &&
    Number(color[2]) < 10 &&
    Number(color[3]) > 0.5
  );
}

function plannedScale(key, options = {}) {
  const map = PLANNED_COLOR_MAPS?.maps?.[key] || {};
  const min = Number.isFinite(Number(options.forceMin))
    ? Number(options.forceMin)
    : Number.isFinite(Number(map.min))
      ? Number(map.min)
      : Number(options.min) || 0;
  const max = Number.isFinite(Number(options.forceMax))
    ? Number(options.forceMax)
    : Number.isFinite(Number(map.max))
      ? Number(map.max)
      : Number(options.max) || min + 1;
  return {
    min,
    max,
    minVisible: Number.isFinite(Number(options.minVisible)) ? Number(options.minVisible) : null,
    maxVisible: Number.isFinite(Number(options.maxVisible)) ? Number(options.maxVisible) : null,
    alpha: Number.isFinite(Number(options.alpha)) ? Number(options.alpha) : 0.84,
    thresholdNote: options.thresholdNote || null,
    legendTicks: Array.isArray(options.legendTicks) ? options.legendTicks : plannedLegendTicks(map, min, max),
    legendStops: normalizedStopsFromPlannedMap(map, min, max, options),
    valueStops: valueStopsFromPlannedMap(map, options),
    lookup: options.lookup || (map.lookup === "step" || map.interpolation === "step" ? "step" : null),
  };
}

function plannedLegendTicks(map, min, max) {
  const source = Array.isArray(map?.legendTicks) && map.legendTicks.length > 0 ? map.legendTicks : [min, max];
  return source.map((tick) => Number(tick)).filter(Number.isFinite);
}

function normalizedStopsFromPlannedMap(map, min, max, options = {}) {
  const normalized = map?.normalizedRgbaStops || map?.normalizedStops;
  if (Array.isArray(normalized) && normalized.length >= 2) {
    return normalized.map(([position, color]) => [
      clamp01(Number(position)),
      normalizePlannedColor(color, color?.[3], options, min + clamp01(Number(position)) * (max - min)),
    ]);
  }
  return normalizedStopsFromValueRows(valueStopsFromPlannedMap(map, options), min, max);
}

function valueStopsFromPlannedMap(map, options = {}) {
  const stops = Array.isArray(map?.valueStops) ? map.valueStops : [];
  return stops
    .map((stop) => {
      const value = Number(stop?.[0]);
      const color = normalizePlannedColor(stop?.[1], stop?.[2], options, value);
      return Number.isFinite(value) ? [value, color] : null;
    })
    .filter(Boolean);
}

function normalizePlannedColor(color, alpha, options = {}, value = null) {
  const rgba = normalizeLegendRgba(color, alpha);
  if (shouldUsePositiveGrayOpacityRamp(options, value)) {
    return grayOpacityRampFromWhite(rgba, value, Number(options.positiveGrayOpacityRampFrom));
  }
  return options.whiteTransparent ? unCompositeWhiteToTransparent(rgba) : rgba;
}

function shouldUsePositiveGrayOpacityRamp(options, value) {
  const start = Number(options.positiveGrayOpacityRampFrom);
  const num = Number(value);
  return Number.isFinite(start) && Number.isFinite(num) && num >= start - 1e-6;
}

function grayOpacityRampFromWhite(color, value, start) {
  const num = Number(value);
  if (Number.isFinite(num) && num <= start + 1e-6) {
    return [0, 0, 0, 0];
  }
  const r = clampInt(color?.[0], 0, 255);
  const g = clampInt(color?.[1], 0, 255);
  const b = clampInt(color?.[2], 0, 255);
  const sourceAlpha = Number.isFinite(Number(color?.[3])) ? clamp01(Number(color[3])) : 1;
  const gray = (r + g + b) / 3;
  return [0, 0, 0, sourceAlpha * (1 - gray / 255)];
}

function unCompositeWhiteToTransparent(color) {
  if (!Array.isArray(color) || color.length < 3) {
    return [0, 0, 0, 0];
  }
  const r = clampInt(color[0], 0, 255);
  const g = clampInt(color[1], 0, 255);
  const b = clampInt(color[2], 0, 255);
  const sourceAlpha = Number.isFinite(Number(color[3])) ? clamp01(Number(color[3])) : 1;
  const whiteShare = Math.min(r, g, b) / 255;
  const alpha = sourceAlpha * (1 - whiteShare);
  if (alpha <= 1e-6) {
    return [0, 0, 0, 0];
  }
  const whiteComponent = (1 - alpha) * 255;
  return [
    clampInt((r - whiteComponent) / alpha, 0, 255),
    clampInt((g - whiteComponent) / alpha, 0, 255),
    clampInt((b - whiteComponent) / alpha, 0, 255),
    alpha,
  ];
}

function normalizedSnowfallLegendValueStops(source) {
  const rows = Array.isArray(source?.stops)
    ? source.stops
        .map((stop) => {
          const value = Number(stop?.valueInches);
          const rgba = Array.isArray(stop?.rgba) ? stop.rgba : null;
          if (!Number.isFinite(value) || !rgba || rgba.length < 3) {
            return null;
          }
          return [
            value,
            [
              clampInt(rgba[0], 0, 255),
              clampInt(rgba[1], 0, 255),
              clampInt(rgba[2], 0, 255),
              Number.isFinite(Number(rgba[3])) ? clamp01(Number(rgba[3])) : 1,
            ],
          ];
        })
        .filter(Boolean)
        .sort((left, right) => left[0] - right[0])
    : [];
  return rows.length >= 2
    ? rows
    : [
        [0, [150, 150, 150, 0]],
        [60, [250, 250, 221, 1]],
      ];
}

function snowfallLegendTicks(source, max) {
  const ticks = Array.isArray(source?.labeledTicksInches) ? source.labeledTicksInches : [];
  const out = ticks.map((tick) => Number(tick)).filter((tick) => Number.isFinite(tick) && tick >= 0 && tick <= max);
  return out.length > 0 ? out : [0.1, 1, 3, 6, 12, 24, 36, 48, max];
}

function normalizedStopsFromValueScale(scale) {
  const stops = scale.normalizedRgbaStops || scale.normalizedStops || [];
  return stops.map(([position, color]) => [position, [...color]]);
}

function normalizedStopsFromValueRows(rows, min, max, options = {}) {
  return (rows || []).map(([value, color]) => [normalizeValueForLegend(value, min, max, options), [...color]]);
}

function normalizedStepStopsFromValueScale(scale, log = false) {
  const stops = scale.valueStops || [];
  if (!Array.isArray(stops) || stops.length < 2) {
    return normalizedStopsFromValueScale(scale);
  }
  const positiveMin = stops.map(([value]) => Number(value)).find((value) => Number.isFinite(value) && value > 0);
  const min = log ? positiveMin || scale.min || 1e-6 : scale.min;
  const max = scale.max;
  const out = [];
  for (let index = 0; index < stops.length; index += 1) {
    const [value, rgb, alpha] = stops[index];
    const nextValue = index + 1 < stops.length ? stops[index + 1][0] : max;
    const color = Array.isArray(rgb) ? [...rgb] : [0, 0, 0];
    if (Number.isFinite(Number(alpha)) && Number(alpha) < 1) {
      color.push(Number(alpha));
    }
    out.push([normalizeValueForLegend(value, min, max, { log }), color]);
    out.push([normalizeValueForLegend(nextValue, min, max, { log }), [...color]]);
  }
  return out;
}

function normalizeValueForLegend(value, min, max, options = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  const displayScale = options?.displayScale;
  const log = Boolean(options?.log || displayScale?.kind === "log");
  if (!log) {
    const normalized = clamp01((num - min) / Math.max(1e-9, max - min));
    const displayExponent = displayScale?.kind === "power" ? Number(displayScale.exponent) : 1;
    return displayExponent > 0 && displayExponent !== 1 ? normalized ** displayExponent : normalized;
  }
  if (num <= min) {
    return 0;
  }
  return clamp01((Math.log(num) - Math.log(min)) / Math.max(1e-9, Math.log(max) - Math.log(min)));
}

function valueStopsFromScale(scale) {
  const stops = scale.valueStops || [];
  return stops.map(([value, rgb, alpha]) => {
    const color = [...rgb];
    if (Number.isFinite(Number(alpha)) && Number(alpha) < 1) {
      color.push(Number(alpha));
    }
    return [value, color];
  });
}

function sharedLayerTicks(key, fallback) {
  const ticks = SHARED_LAYERS[key]?.legendTicks;
  return Array.isArray(ticks) && ticks.length > 0
    ? ticks.map((tick) => Number(tick)).filter(Number.isFinite)
    : fallback;
}

function sharedLayerStops(key, fallback) {
  const stops = SHARED_LAYERS[key]?.legendStops;
  if (!Array.isArray(stops) || stops.length < 2) {
    return fallback;
  }
  return stops
    .map((stop) => {
      if (!Array.isArray(stop) || stop.length !== 2 || !Array.isArray(stop[1]) || stop[1].length < 3) {
        return null;
      }
      const position = clamp01(Number(stop[0]));
      const color = stop[1].map((value) => clampInt(value, 0, 255));
      if (Number.isFinite(Number(stop[1][3]))) {
        color[3] = clamp01(Number(stop[1][3]));
      }
      return [position, color];
    })
    .filter(Boolean);
}

function windLegendTicks(scale) {
  const roundedMax = formatTick(scale.max);
  const ticks = [0, 10, 20, 30, 40, 50, 60, 70].filter((tick) => tick <= roundedMax);
  if (!ticks.includes(roundedMax)) {
    ticks.push(roundedMax);
  }
  return ticks;
}

function formatTick(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.round(num);
}

function formatRateTick(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "0";
  }
  if (num < 0.1) {
    return num.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }
  return num.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function clampInt(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(num)));
}

function freezeEntry(entry) {
  return Object.freeze({
    ...entry,
    selector: entry.selector ? Object.freeze({ ...entry.selector }) : undefined,
    directSelector: entry.directSelector ? Object.freeze({ ...entry.directSelector }) : undefined,
    uSelector: entry.uSelector ? Object.freeze({ ...entry.uSelector }) : undefined,
    vSelector: entry.vSelector ? Object.freeze({ ...entry.vSelector }) : undefined,
    rateSelector: entry.rateSelector ? Object.freeze({ ...entry.rateSelector }) : undefined,
    precipTypeKeys: entry.precipTypeKeys ? Object.freeze({ ...entry.precipTypeKeys }) : undefined,
    precipTypeSelectors: entry.precipTypeSelectors ? Object.freeze({ ...entry.precipTypeSelectors }) : undefined,
    sourceSelectors: entry.sourceSelectors
      ? Object.freeze(
          entry.sourceSelectors.map((source) =>
            Object.freeze({ ...source, selector: Object.freeze({ ...source.selector }) }),
          ),
        )
      : undefined,
    anySourceKeyGroups: entry.anySourceKeyGroups
      ? Object.freeze(entry.anySourceKeyGroups.map((groupKeys) => Object.freeze([...groupKeys])))
      : undefined,
    profileVariables: entry.profileVariables ? Object.freeze([...entry.profileVariables]) : undefined,
    profileLevels: entry.profileLevels ? Object.freeze([...entry.profileLevels]) : undefined,
    completeProfileRequired: Boolean(entry.completeProfileRequired),
    models: entry.models ? Object.freeze([...entry.models]) : undefined,
  });
}

module.exports = {
  NOAA_NAM_PARAMETER_CATALOG,
  NOAA_NAM_PARAMETER_ORDER,
  SCALES,
  SNOW_PROFILE_LEVELS,
  EFFECTIVE_LAYER_PROFILE_LEVELS,
  KUCHERA_PROFILE_LEVELS,
  COBB_PROFILE_LEVELS,
  SUPPORT_SELECTORS,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
};
