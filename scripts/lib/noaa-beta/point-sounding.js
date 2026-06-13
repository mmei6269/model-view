"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { NOAA_NAM_PARAMETER_CATALOG } = require("../noaa-nam-parameter-catalog");
const { MPS_TO_KT, M_TO_IN, clamp, clamp01 } = require("./util");
const {
  CP_OVER_RD,
  DRY_ADIABATIC_LAPSE_K_M,
  GRAVITY_M_S2,
  RD_OVER_CP,
  boltonLclTemperatureK,
  boltonThetaE,
  dewpointFromTempRhK,
  kelvinToCelsius,
  mixingRatioFromDewpointK,
  moistLiftTemperatureK,
  saturationMixingRatioHpa,
  virtualTemperatureK,
  wetBulbTemperatureC,
  wetBulbTemperatureCAtPressure,
} = require("./thermo");
const {
  calculateBunkersMotionFromRows,
  calculateCorfidiMcsMotionFromRows,
  calculatePointSoundingMeanWindInLayerFromRows,
  calculateStormRelativeHelicityFromRows,
  interpolateProfileThermoAtPressureRows,
  interpolateProfileWindRows,
  logPressureInterpolationFraction,
  sortEffectiveDiagnosticsRowsByHeight,
} = require("./profile-wind");
const {
  EFFECTIVE_INFLOW_MIN_CAPE_JKG,
  EFFECTIVE_INFLOW_MIN_CIN_JKG,
  EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M,
  PARCEL_INTEGRATION_STEP_HPA,
  buildMixedLayerPointSoundingSourceFromScratch,
  calculateEffectiveLayerBunkersMotionFromRows,
  calculateEffectiveParcelLayerFromRows,
  calculateParcelCapeCinFromRows,
  calculateParcelLclAglM,
  calculatePressureStepParcelCapeCinForSource,
  findTopPressureHpaForScratch,
  prepareEffectiveParcelSegments,
} = require("./severe");
const {
  CATALOG_VERSION,
  DEFAULT_WGRIB2_PATH,
  attachRunLocalDecodeSession,
  buildNoaaIndexCacheContext,
  createFrameDecodeSession,
  createNoaaRenderProfile,
  finalizeNoaaRenderProfile,
  getSelectedRecordPlan,
  materializeSelectedGrib,
  parseNoaaIdx,
  readOrFetchNoaaIdxTextCached,
  runCommand,
} = require("./grib-source");
const { padHour, recordProfileStage } = require("./cache-io");
const {
  buildNoaaGribUrl,
  formatNoaaRunId,
  getNoaaGribModelConfig,
  normalizeNoaaModelKey,
  referenceTimeIsoFromNoaaRun,
  validTimeIsoFromNoaaRun,
} = require("./model-config");
const {
  POINT_SOUNDING_PROFILE_LEVELS,
  mergeSelectedNoaaRecords,
  selectNoaaNamParameterRecords,
  selectPointSoundingRecords,
} = require("./selection");
const { ensureSelectedRecordByteRangesForHour } = require("./accumulation");

const M_TO_FT = 3.280839895;

const POINT_SOUNDING_CACHE_VERSION = "point-sounding-selected-v1";

async function buildNoaaPointSounding({
  modelKey,
  runId = null,
  date = null,
  cycle = null,
  hour,
  lat,
  lon,
  noaaBaseUrl = null,
  wgrib2Path = DEFAULT_WGRIB2_PATH,
  rawCacheDir = null,
  tempRoot = os.tmpdir(),
  rangeFetchConcurrency = 4,
  rangeFetchLimiter = null,
}) {
  const resolvedModelKey = normalizeNoaaModelKey(modelKey);
  const modelConfig = getNoaaGribModelConfig(resolvedModelKey);
  const runParts = resolvePointSoundingRunParts({ runId, date, cycle });
  const targetHour = Math.round(Number(hour));
  const targetLat = Number(lat);
  const targetLon = normalizeLongitudeForRequest(lon);
  if (!runParts || !Number.isFinite(targetHour) || targetHour < 0) {
    throw new Error("Point sounding request is missing a valid run or forecast hour.");
  }
  if (!Number.isFinite(targetLat) || !Number.isFinite(targetLon)) {
    throw new Error("Point sounding request is missing a valid latitude/longitude.");
  }

  const resolvedBaseUrl = noaaBaseUrl || modelConfig.baseUrl;
  const gribUrl = buildNoaaGribUrl({
    modelKey: resolvedModelKey,
    baseUrl: resolvedBaseUrl,
    date: runParts.date,
    cycle: runParts.cycle,
    hour: targetHour,
  });
  const profile = createNoaaRenderProfile();
  const decodeSession = createFrameDecodeSession(profile);
  attachRunLocalDecodeSession(decodeSession, {
    modelKey: resolvedModelKey,
    modelConfig,
    baseUrl: resolvedBaseUrl,
    date: runParts.date,
    cycle: runParts.cycle,
  });

  const indexCacheContext = buildNoaaIndexCacheContext({
    modelKey: resolvedModelKey,
    date: runParts.date,
    cycle: runParts.cycle,
    rawCacheDir,
  });
  let stageStartedAt = performance.now();
  const indexText = await readOrFetchNoaaIdxTextCached(`${gribUrl}.idx`, indexCacheContext, targetHour, profile);
  recordProfileStage(profile, "indexMs", stageStartedAt);
  const records = parseNoaaIdx(indexText, null);
  const soundingSelection = selectPointSoundingRecords(records);
  const renderedSelection = selectNoaaNamParameterRecords(records, {
    catalog: NOAA_NAM_PARAMETER_CATALOG,
    modelKey: resolvedModelKey,
    targetHour,
  });
  let selectedRecords = Object.values(renderedSelection.records || {}).filter(Boolean);
  let selectedCacheVersion = CATALOG_VERSION;
  if (selectedRecords.length > 0) {
    const mergedRecords = mergeSelectedNoaaRecords(
      selectedRecords,
      Object.values(soundingSelection.records).filter(Boolean),
    );
    if (mergedRecords.length !== selectedRecords.length) {
      selectedRecords = mergedRecords;
      selectedCacheVersion = POINT_SOUNDING_CACHE_VERSION;
    }
  } else {
    selectedRecords = Object.values(soundingSelection.records).filter(Boolean);
    selectedCacheVersion = POINT_SOUNDING_CACHE_VERSION;
  }
  if (selectedRecords.length === 0) {
    throw new Error(`No point sounding records were available for ${modelConfig.label} f${padHour(targetHour)}.`);
  }

  stageStartedAt = performance.now();
  await ensureSelectedRecordByteRangesForHour({
    context: {
      modelKey: resolvedModelKey,
      baseUrl: resolvedBaseUrl,
      date: runParts.date,
      cycle: runParts.cycle,
      sourceIndexCacheDir: indexCacheContext.sourceIndexCacheDir,
      recordsByHour: new Map([[targetHour, records]]),
    },
    hour: targetHour,
    selectedRecords,
    gribUrl,
    profile,
  });
  recordProfileStage(profile, "headMs", stageStartedAt);

  const selectedPlan = getSelectedRecordPlan(selectedRecords, decodeSession);
  const tempDir = await fs.promises.mkdtemp(
    path.join(tempRoot, `noaa-sounding-${resolvedModelKey}-${runParts.date}-${runParts.cycle}-${padHour(targetHour)}-`),
  );
  try {
    stageStartedAt = performance.now();
    const gribPath = await materializeSelectedGrib({
      modelKey: resolvedModelKey,
      productKey: modelConfig.productKey,
      gribUrl,
      recordGroups: selectedPlan.groups,
      rawCacheDir,
      date: runParts.date,
      cycle: runParts.cycle,
      hour: targetHour,
      cacheVersion: selectedCacheVersion,
      rangeFetchConcurrency,
      rangeFetchLimiter,
      profile,
      decodeSession,
    });
    recordProfileStage(profile, "materializeMs", stageStartedAt);

    stageStartedAt = performance.now();
    const output = await runCommand(wgrib2Path, [
      gribPath,
      "-s",
      "-lon",
      String(roundForCommand(targetLon)),
      String(roundForCommand(targetLat)),
    ]);
    recordProfileStage(profile, "pointExtractMs", stageStartedAt);
    const sampled = parsePointSoundingLonOutput(output.stdout);
    return buildPointSoundingPayload({
      modelKey: resolvedModelKey,
      modelConfig,
      date: runParts.date,
      cycle: runParts.cycle,
      hour: targetHour,
      requestLat: targetLat,
      requestLon: targetLon,
      selectedRecordCount: selectedRecords.length,
      sampled,
      selection: soundingSelection,
      renderProfile: finalizeNoaaRenderProfile(profile),
    });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolvePointSoundingRunParts({ runId, date, cycle }) {
  const explicitDate = String(date || "").trim();
  const explicitCycle = String(cycle || "")
    .trim()
    .padStart(2, "0");
  if (/^\d{8}$/.test(explicitDate) && /^\d{2}$/.test(explicitCycle)) {
    return { date: explicitDate, cycle: explicitCycle };
  }
  const match = String(runId || "")
    .trim()
    .match(/^(\d{8})-(\d{2})00Z$/);
  return match ? { date: match[1], cycle: match[2] } : null;
}

function parsePointSoundingLonOutput(text) {
  const values = new Map();
  let sampleLat = Number.NaN;
  let sampleLon = Number.NaN;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const parts = line.split(":");
    const param = String(parts[3] || "").trim();
    const level = String(parts[4] || "").trim();
    const valueMatch = line.match(/(?:^|[,\s])val=([^,\s]+)/);
    if (!param || !level || !valueMatch) {
      continue;
    }
    const value = Number(valueMatch[1]);
    if (!Number.isFinite(value) || Math.abs(value) > 9e19) {
      continue;
    }
    values.set(pointSoundingValueKey(param, level), value);
    const lonMatch = line.match(/(?:^|[:,\s])lon=([^,\s]+)/);
    const latMatch = line.match(/(?:^|[:,\s])lat=([^,\s]+)/);
    if (lonMatch) {
      sampleLon = normalizeLongitudeForDisplay(Number(lonMatch[1]));
    }
    if (latMatch) {
      sampleLat = Number(latMatch[1]);
    }
  }
  return { values, sampleLat, sampleLon };
}

function buildPointSoundingPayload({
  modelKey,
  modelConfig,
  date,
  cycle,
  hour,
  requestLat,
  requestLon,
  selectedRecordCount,
  sampled,
  selection,
  renderProfile,
}) {
  const values = sampled.values || new Map();
  const warnings = [];
  const surface = buildPointSoundingSurface(values);
  const direct = buildPointSoundingDirectDiagnostics(values, surface);
  if (!Number.isFinite(surface.press)) {
    warnings.push("Surface pressure was unavailable; pressure-level rows are shown without a plotted surface parcel.");
  }
  const levels = [];
  if (isUsableSoundingLevel(surface)) {
    levels.push(surface);
  }
  for (const level of selection.availableLevels || POINT_SOUNDING_PROFILE_LEVELS) {
    const profileLevel = buildPointSoundingPressureLevel(values, level, surface.press);
    if (profileLevel) {
      levels.push(profileLevel);
    }
  }
  levels.sort((left, right) => Number(right.press) - Number(left.press));
  const dedupedLevels = dedupePointSoundingLevels(levels);
  if (dedupedLevels.length < 3) {
    warnings.push("Only a shallow profile was available at this point.");
  }
  const analysisRows = buildPointSoundingAnalysisRows(dedupedLevels);
  const parcelDiagnostics = buildPointSoundingParcelDiagnostics(analysisRows);

  return {
    schemaVersion: 1,
    source: "noaa-grib2-point",
    model: modelKey,
    modelLabel: modelConfig.label,
    run: formatNoaaRunId(date, cycle),
    referenceTime: referenceTimeIsoFromNoaaRun(date, cycle),
    forecastHour: Math.round(Number(hour)),
    validTime: validTimeIsoFromNoaaRun(date, cycle, hour),
    lat: roundNullable(requestLat, 4),
    lon: roundNullable(requestLon, 4),
    sampleLat: roundNullable(sampled.sampleLat, 4),
    sampleLon: roundNullable(sampled.sampleLon, 4),
    selectedRecordCount,
    surface: buildPointSoundingSurfaceSummary(surface, direct),
    levels: dedupedLevels,
    parcelTrace: buildPointSoundingParcelTrace(analysisRows, parcelDiagnostics),
    indices: buildPointSoundingIndices(dedupedLevels, direct, analysisRows, parcelDiagnostics),
    warnings,
    renderProfile,
  };
}

function buildPointSoundingDirectDiagnostics(values, surface) {
  const surfaceHeightM = Number(surface?.hght);
  const mslpPa = pointSoundingValue(values, "PRMSL", "mean sea level");
  const lclMsl = pointSoundingValue(values, "HGT", "level of adiabatic condensation from sfc");
  const wetBulbZeroMsl = pointSoundingValue(values, "HGT", "lowest level of the wet bulb zero");
  const cloudCeilingMsl = pointSoundingValue(values, "HGT", "cloud ceiling");
  const direct = {
    mslpHpa: Number.isFinite(mslpPa) ? mslpPa / 100 : Number.NaN,
    pblHeightM: pointSoundingValue(values, "HPBL", "surface"),
    pwatMm: pointSoundingValueByLevelPattern(values, "PWAT", /entire atmosphere/i),
    cloudCeilingM:
      Number.isFinite(cloudCeilingMsl) && Number.isFinite(surfaceHeightM)
        ? Math.max(0, cloudCeilingMsl - surfaceHeightM)
        : cloudCeilingMsl,
    wetBulbZeroM: wetBulbZeroMsl,
    lclM:
      Number.isFinite(lclMsl) && Number.isFinite(surfaceHeightM) ? Math.max(0, lclMsl - surfaceHeightM) : Number.NaN,
    cape0to3kmJkg: pointSoundingValue(values, "CAPE", "3000-0 m above ground"),
    sbcapeJkg: pointSoundingValue(values, "CAPE", "surface"),
    sbcinJkg: pointSoundingValue(values, "CIN", "surface"),
    mlcapeJkg: pointSoundingValue(values, "CAPE", "90-0 mb above ground"),
    mlcinJkg: pointSoundingValue(values, "CIN", "90-0 mb above ground"),
    mucapeJkg: finiteOrNumber(
      pointSoundingValue(values, "CAPE", "255-0 mb above ground"),
      pointSoundingValue(values, "CAPE", "180-0 mb above ground"),
    ),
    srh0to1kmM2S2: pointSoundingValue(values, "HLCY", "1000-0 m above ground"),
    srh0to3kmM2S2: pointSoundingValue(values, "HLCY", "3000-0 m above ground"),
    updraftHelicity2to5kmM2S2: pointSoundingValue(values, "MXUPHL", "5000-2000 m above ground"),
    maxHailSizeIn: pointSoundingValueByLevelPattern(values, "HAIL", /entire atmosphere/i) * M_TO_IN,
  };
  return direct;
}

function buildPointSoundingSurfaceSummary(surface, direct) {
  return {
    pressureHpa: roundNullable(surface?.press, 1),
    heightM: roundNullable(surface?.hght, 0),
    temperatureC: roundNullable(surface?.temp, 1),
    dewpointC: roundNullable(surface?.dwpt, 1),
    rhPct: roundNullable(surface?.rh, 0),
    windDirDeg: roundNullable(surface?.wdir, 0),
    windSpeedKt: roundNullable(surface?.wspd, 1),
    mslpHpa: roundNullable(direct?.mslpHpa, 1),
  };
}

function buildPointSoundingSurface(values) {
  const tempC = kelvinToCelsius(pointSoundingValue(values, "TMP", "2 m above ground"));
  const rhPct = pointSoundingValue(values, "RH", "2 m above ground");
  const dptC = finiteOrNumber(
    kelvinToCelsius(pointSoundingValue(values, "DPT", "2 m above ground")),
    dewpointCFromTemperatureRh(tempC, rhPct),
  );
  const wind = windComponentsToMeteorological(
    pointSoundingValue(values, "UGRD", "10 m above ground"),
    pointSoundingValue(values, "VGRD", "10 m above ground"),
  );
  const pressurePa = pointSoundingValue(values, "PRES", "surface");
  return normalizePointSoundingLevel({
    source: "surface",
    press: Number.isFinite(pressurePa) ? pressurePa / 100 : Number.NaN,
    hght: pointSoundingValue(values, "HGT", "surface"),
    temp: tempC,
    dwpt: dptC,
    rh: rhPct,
    ...wind,
  });
}

function buildPointSoundingPressureLevel(values, pressureHpa, surfacePressureHpa) {
  const pressure = Math.round(Number(pressureHpa));
  if (!Number.isFinite(pressure) || pressure <= 0) {
    return null;
  }
  if (Number.isFinite(surfacePressureHpa) && pressure > surfacePressureHpa + 1) {
    return null;
  }
  if (Number.isFinite(surfacePressureHpa) && Math.abs(pressure - surfacePressureHpa) < 2) {
    return null;
  }
  const levelName = `${pressure} mb`;
  const tempC = kelvinToCelsius(pointSoundingValue(values, "TMP", levelName));
  const rhPct = pointSoundingValue(values, "RH", levelName);
  const dptC = finiteOrNumber(
    kelvinToCelsius(pointSoundingValue(values, "DPT", levelName)),
    dewpointCFromTemperatureRh(tempC, rhPct),
  );
  const wind = windComponentsToMeteorological(
    pointSoundingValue(values, "UGRD", levelName),
    pointSoundingValue(values, "VGRD", levelName),
  );
  const level = normalizePointSoundingLevel({
    source: "pressure",
    press: pressure,
    hght: pointSoundingValue(values, "HGT", levelName),
    temp: tempC,
    dwpt: dptC,
    rh: rhPct,
    ...wind,
  });
  return isUsableSoundingLevel(level) ? level : null;
}

function normalizePointSoundingLevel(level) {
  return {
    source: level.source || "pressure",
    press: roundNullable(level.press, 1),
    hght: roundNullable(level.hght, 1),
    temp: roundNullable(level.temp, 1),
    dwpt: roundNullable(level.dwpt, 1),
    rh: roundNullable(level.rh, 0),
    wdir: roundNullable(level.wdir, 0),
    wspd: roundNullable(level.wspd, 1),
    uKt: roundNullable(level.uKt, 1),
    vKt: roundNullable(level.vKt, 1),
  };
}

function isUsableSoundingLevel(level) {
  return Number.isFinite(level?.press) && Number.isFinite(level?.temp) && Number.isFinite(level?.hght);
}

function dedupePointSoundingLevels(levels) {
  const out = [];
  const seen = new Set();
  for (const level of levels) {
    const key = `${Math.round(Number(level.press) * 10)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(level);
  }
  return out;
}

function buildPointSoundingIndices(levels, direct = {}, analysisRows = null, precomputedParcelDiagnostics = null) {
  const usable = (Array.isArray(levels) ? levels : [])
    .filter((level) => Number.isFinite(level.hght))
    .sort((left, right) => Number(left.hght) - Number(right.hght));
  const surface = usable.find((level) => level.source === "surface") || null;
  const freezingLevelM = interpolateHeightForTemperature(usable, 0);
  const minus10CHeightM = interpolateHeightForTemperature(usable, -10);
  const minus20CHeightM = interpolateHeightForTemperature(usable, -20);
  const minus30CHeightM = interpolateHeightForTemperature(usable, -30);
  const wetBulbZeroM = finiteOrNumber(direct?.wetBulbZeroM, interpolateHeightForWetBulbZero(usable));
  const temp700 = interpolateProfileValueByPressure(levels, 700, "temp");
  const temp500 = interpolateProfileValueByPressure(levels, 500, "temp");
  const temp850 = interpolateProfileValueByPressure(levels, 850, "temp");
  const temp3km = surface ? interpolateProfileValueByHeight(usable, Number(surface.hght) + 3000, "temp") : Number.NaN;
  const temp6km = surface ? interpolateProfileValueByHeight(usable, Number(surface.hght) + 6000, "temp") : Number.NaN;
  const dewpoint850 = interpolateProfileValueByPressure(levels, 850, "dwpt");
  const dewpoint700 = interpolateProfileValueByPressure(levels, 700, "dwpt");
  const hgt700 = interpolateProfileValueByPressure(levels, 700, "hght");
  const hgt500 = interpolateProfileValueByPressure(levels, 500, "hght");
  const hgt850 = interpolateProfileValueByPressure(levels, 850, "hght");
  const tv700 = virtualTemperatureCAtPressure(levels, 700);
  const tv500 = virtualTemperatureCAtPressure(levels, 500);
  const tv850 = virtualTemperatureCAtPressure(levels, 850);
  const tvSurface = surface
    ? virtualTemperatureC(Number(surface.temp), Number(surface.dwpt), Number(surface.press))
    : Number.NaN;
  const tv3km = surface ? virtualTemperatureCAtHeight(usable, Number(surface.hght) + 3000) : Number.NaN;
  const tv6km = surface ? virtualTemperatureCAtHeight(usable, Number(surface.hght) + 6000) : Number.NaN;
  const lapse700to500 =
    Number.isFinite(temp700) && Number.isFinite(temp500) && Number.isFinite(hgt700) && Number.isFinite(hgt500)
      ? ((temp700 - temp500) / Math.max(1, hgt500 - hgt700)) * 1000
      : Number.NaN;
  const lapse850to500 =
    Number.isFinite(temp850) && Number.isFinite(temp500) && Number.isFinite(hgt850) && Number.isFinite(hgt500)
      ? ((temp850 - temp500) / Math.max(1, hgt500 - hgt850)) * 1000
      : Number.NaN;
  const lapse0to3km =
    surface && Number.isFinite(temp3km) ? ((Number(surface.temp) - temp3km) / 3000) * 1000 : Number.NaN;
  const lapse3to6km =
    Number.isFinite(temp3km) && Number.isFinite(temp6km) ? ((temp3km - temp6km) / 3000) * 1000 : Number.NaN;
  const lapse700to500Tv =
    Number.isFinite(tv700) && Number.isFinite(tv500) && Number.isFinite(hgt700) && Number.isFinite(hgt500)
      ? ((tv700 - tv500) / Math.max(1, hgt500 - hgt700)) * 1000
      : Number.NaN;
  const lapse850to500Tv =
    Number.isFinite(tv850) && Number.isFinite(tv500) && Number.isFinite(hgt850) && Number.isFinite(hgt500)
      ? ((tv850 - tv500) / Math.max(1, hgt500 - hgt850)) * 1000
      : Number.NaN;
  const lapse0to3kmTv =
    Number.isFinite(tvSurface) && Number.isFinite(tv3km) ? ((tvSurface - tv3km) / 3000) * 1000 : Number.NaN;
  const lapse3to6kmTv = Number.isFinite(tv3km) && Number.isFinite(tv6km) ? ((tv3km - tv6km) / 3000) * 1000 : Number.NaN;
  const shear0to1km = pointSoundingLayerShearKt(usable, surface, 1000);
  const shear0to3km = pointSoundingLayerShearKt(usable, surface, 3000);
  const shear0to6km = pointSoundingLayerShearKt(usable, surface, 6000);
  const shear0to8km = pointSoundingLayerShearKt(usable, surface, 8000);
  const shearSurfaceTo500 = pointSoundingPressureShearKt(usable, surface, 500);
  const maxWind = usable.reduce(
    (max, level) => (Number.isFinite(level.wspd) && Number(level.wspd) > max ? Number(level.wspd) : max),
    Number.NEGATIVE_INFINITY,
  );
  const kIndex =
    Number.isFinite(temp850) &&
    Number.isFinite(temp700) &&
    Number.isFinite(temp500) &&
    Number.isFinite(dewpoint850) &&
    Number.isFinite(dewpoint700)
      ? temp850 - temp500 + dewpoint850 - (temp700 - dewpoint700)
      : Number.NaN;
  const totalTotals =
    Number.isFinite(temp850) && Number.isFinite(dewpoint850) && Number.isFinite(temp500)
      ? temp850 + dewpoint850 - 2 * temp500
      : Number.NaN;
  const verticalTotals = Number.isFinite(temp850) && Number.isFinite(temp500) ? temp850 - temp500 : Number.NaN;
  const crossTotals = Number.isFinite(dewpoint850) && Number.isFinite(temp500) ? dewpoint850 - temp500 : Number.NaN;
  const rows = Array.isArray(analysisRows) ? analysisRows : buildPointSoundingAnalysisRows(usable);
  const parcelDiagnostics = precomputedParcelDiagnostics || buildPointSoundingParcelDiagnostics(rows);
  const lclM = finiteOrNumber(parcelDiagnostics.surfaceLclM, direct?.lclM);
  const sbcapeJkg = finiteOrNumber(parcelDiagnostics.surfaceCapeJkg, direct?.sbcapeJkg);
  const sbcinJkg = finiteOrNumber(parcelDiagnostics.surfaceCinJkg, direct?.sbcinJkg);
  const mlcapeJkg = finiteOrNumber(parcelDiagnostics.mixedLayerCapeJkg, direct?.mlcapeJkg);
  const mlcinJkg = finiteOrNumber(parcelDiagnostics.mixedLayerCinJkg, direct?.mlcinJkg);
  const mucapeJkg = finiteOrNumber(parcelDiagnostics.mostUnstableCapeJkg, direct?.mucapeJkg);
  const mucinJkg = parcelDiagnostics.mostUnstableCinJkg;
  const stormDiagnostics = buildPointSoundingStormDiagnostics(rows, direct, {
    surface,
    sbcapeJkg,
    sbcinJkg,
    mucapeJkg,
    mlcapeJkg,
    mlcinJkg,
    lclM,
  });
  const liftedIndexC = calculateLiftedIndexC(rows, 0);
  const showalterIndexC = calculateShowalterIndexC(rows);
  const calculatedPwatMm = calculatePrecipitableWaterMm(usable);
  const dcapeJkg = calculatePointDcapeJkg(usable);
  const cape0to3kmJkg = finiteOrNumber(parcelDiagnostics.mixedLayerCape0to3kmJkg, direct?.cape0to3kmJkg);
  const shipParameter = calculatePointShip({
    mucapeJkg,
    muSourcePressureHpa: parcelDiagnostics.mostUnstableSource?.pressureHpa,
    muSourceDewpointK: parcelDiagnostics.mostUnstableSource?.dewpointK,
    lapseRate700to500CPerKm: finiteOrNumber(lapse700to500Tv, lapse700to500),
    temp500C: temp500,
    shear0to6kmKt: shear0to6km,
    freezingLevelMslM: freezingLevelM,
  });
  const srh0to1km = finiteOrNumber(stormDiagnostics.srh0to1kmM2S2, direct?.srh0to1kmM2S2);
  const srh0to3km = finiteOrNumber(stormDiagnostics.srh0to3kmM2S2, direct?.srh0to3kmM2S2);
  const ehi0to1 =
    Number.isFinite(sbcapeJkg) && Number.isFinite(srh0to1km) ? (sbcapeJkg * srh0to1km) / 160000 : Number.NaN;
  const ehi0to3 =
    Number.isFinite(sbcapeJkg) && Number.isFinite(srh0to3km) ? (sbcapeJkg * srh0to3km) / 160000 : Number.NaN;
  const fixedStp = calculatePointFixedStp({
    sbcapeJkg,
    lclM,
    srh0to1kmM2S2: srh0to1km,
    shear0to6kmKt: shear0to6km,
  });
  const scpProxy = calculatePointScp({
    mucapeJkg,
    srh0to3kmM2S2: srh0to3km,
    effectiveBulkShearKt: shear0to6km,
    mucinJkg: Number.NaN,
  });
  const scpEffective = calculatePointScp({
    mucapeJkg,
    srh0to3kmM2S2: stormDiagnostics.effectiveSrhM2S2,
    effectiveBulkShearKt: stormDiagnostics.effectiveBulkShearKt,
    mucinJkg: finiteOrNumber(stormDiagnostics.muCinJkg, mucinJkg),
  });
  const effectiveStp = calculatePointEffectiveStp({
    mlcapeJkg,
    mlcinJkg,
    mixedLayerLclM: stormDiagnostics.mixedLayerLclM,
    effectiveSrhM2S2: stormDiagnostics.effectiveSrhM2S2,
    effectiveBulkShearKt: stormDiagnostics.effectiveBulkShearKt,
    effectiveBaseM: stormDiagnostics.effectiveBaseM,
  });
  const surfaceThetaE =
    surface && Number.isFinite(surface.temp) && Number.isFinite(surface.dwpt) && Number.isFinite(surface.press)
      ? boltonThetaE(Number(surface.temp) + 273.15, Number(surface.dwpt) + 273.15, Number(surface.press))
      : Number.NaN;
  return {
    surfacePressureHpa: roundNullable(surface?.press, 1),
    surfaceHeightM: roundNullable(surface?.hght, 0),
    surfaceTempC: roundNullable(surface?.temp, 1),
    surfaceDewpointC: roundNullable(surface?.dwpt, 1),
    surfaceRhPct: roundNullable(surface?.rh, 0),
    surfaceWindDirDeg: roundNullable(surface?.wdir, 0),
    surfaceWindKt: roundNullable(surface?.wspd, 1),
    mslpHpa: roundNullable(direct?.mslpHpa, 1),
    pblHeightM: roundNullable(direct?.pblHeightM, 0),
    cloudCeilingM: roundNullable(direct?.cloudCeilingM, 0),
    surfaceThetaEK: roundNullable(surfaceThetaE, 1),
    pwatMm: roundNullable(finiteOrNumber(direct?.pwatMm, calculatedPwatMm), 1),
    lclM: roundNullable(lclM, 0),
    mixedLayerLclM: roundNullable(finiteOrNumber(stormDiagnostics.mixedLayerLclM, parcelDiagnostics.mixedLayerLclM), 0),
    mixedLayerLiftedIndexC: roundNullable(parcelDiagnostics.mixedLayerLiftedIndexC, 1),
    mixedLayerLfcM: roundNullable(parcelDiagnostics.mixedLayerLfcM, 0),
    mixedLayerElM: roundNullable(parcelDiagnostics.mixedLayerElM, 0),
    lfcM: roundNullable(parcelDiagnostics.surfaceLfcM, 0),
    elM: roundNullable(parcelDiagnostics.surfaceElM, 0),
    temp0CHeightM: roundNullable(freezingLevelM, 0),
    temp0CHeightFt: roundNullable(freezingLevelM * M_TO_FT, 0),
    tempMinus10CHeightM: roundNullable(minus10CHeightM, 0),
    tempMinus10CHeightFt: roundNullable(minus10CHeightM * M_TO_FT, 0),
    tempMinus20CHeightM: roundNullable(minus20CHeightM, 0),
    tempMinus20CHeightFt: roundNullable(minus20CHeightM * M_TO_FT, 0),
    tempMinus30CHeightM: roundNullable(minus30CHeightM, 0),
    tempMinus30CHeightFt: roundNullable(minus30CHeightM * M_TO_FT, 0),
    freezingLevelM: roundNullable(freezingLevelM, 0),
    wetBulbZeroM: roundNullable(wetBulbZeroM, 0),
    lapseRate700to500CPerKm: roundNullable(lapse700to500, 1),
    lapseRate850to500CPerKm: roundNullable(lapse850to500, 1),
    lapseRate0to3kmCPerKm: roundNullable(lapse0to3km, 1),
    lapseRate3to6kmCPerKm: roundNullable(lapse3to6km, 1),
    virtualLapseRate700to500CPerKm: roundNullable(lapse700to500Tv, 1),
    virtualLapseRate850to500CPerKm: roundNullable(lapse850to500Tv, 1),
    virtualLapseRate0to3kmCPerKm: roundNullable(lapse0to3kmTv, 1),
    virtualLapseRate3to6kmCPerKm: roundNullable(lapse3to6kmTv, 1),
    kIndexC: roundNullable(kIndex, 1),
    totalTotalsC: roundNullable(totalTotals, 1),
    verticalTotalsC: roundNullable(verticalTotals, 1),
    crossTotalsC: roundNullable(crossTotals, 1),
    liftedIndexC: roundNullable(liftedIndexC, 1),
    showalterIndexC: roundNullable(showalterIndexC, 1),
    cape0to3kmJkg: roundNullable(cape0to3kmJkg, 0),
    mixedLayerCape0to3kmJkg: roundNullable(parcelDiagnostics.mixedLayerCape0to3kmJkg, 0),
    modelCape0to3kmJkg: roundNullable(direct?.cape0to3kmJkg, 0),
    shipParameter: roundNullable(shipParameter, 1),
    sbcapeJkg: roundNullable(sbcapeJkg, 0),
    sbcinJkg: roundNullable(sbcinJkg, 0),
    mlcapeJkg: roundNullable(mlcapeJkg, 0),
    mlcinJkg: roundNullable(mlcinJkg, 0),
    mucapeJkg: roundNullable(mucapeJkg, 0),
    mucinJkg: roundNullable(mucinJkg, 0),
    mostUnstableLclM: roundNullable(parcelDiagnostics.mostUnstableLclM, 0),
    mostUnstableLiftedIndexC: roundNullable(parcelDiagnostics.mostUnstableLiftedIndexC, 1),
    mostUnstableLfcM: roundNullable(parcelDiagnostics.mostUnstableLfcM, 0),
    mostUnstableElM: roundNullable(parcelDiagnostics.mostUnstableElM, 0),
    dcapeJkg: roundNullable(dcapeJkg, 0),
    shear0to1kmKt: roundNullable(shear0to1km, 0),
    shear0to3kmKt: roundNullable(shear0to3km, 0),
    shear0to6kmKt: roundNullable(shear0to6km, 0),
    shear0to8kmKt: roundNullable(shear0to8km, 0),
    shearSurfaceTo500mbKt: roundNullable(shearSurfaceTo500, 0),
    srh0to1kmM2S2: roundNullable(srh0to1km, 0),
    srh0to3kmM2S2: roundNullable(srh0to3km, 0),
    profileSrh0to1kmM2S2: roundNullable(stormDiagnostics.srh0to1kmM2S2, 0),
    profileSrh0to3kmM2S2: roundNullable(stormDiagnostics.srh0to3kmM2S2, 0),
    modelSrh0to1kmM2S2: roundNullable(direct?.srh0to1kmM2S2, 0),
    modelSrh0to3kmM2S2: roundNullable(direct?.srh0to3kmM2S2, 0),
    effectiveSrhM2S2: roundNullable(stormDiagnostics.effectiveSrhM2S2, 0),
    effectiveBulkShearKt: roundNullable(stormDiagnostics.effectiveBulkShearKt, 0),
    effectiveBaseM: roundNullable(stormDiagnostics.effectiveBaseM, 0),
    effectiveTopM: roundNullable(stormDiagnostics.effectiveTopM, 0),
    effectiveLayerMuCapeJkg: roundNullable(stormDiagnostics.muCapeJkg, 0),
    effectiveLayerMuCinJkg: roundNullable(stormDiagnostics.muCinJkg, 0),
    meanWind0to6kmDirDeg: roundNullable(stormDiagnostics.meanWind0to6kmDirDeg, 0),
    meanWind0to6kmKt: roundNullable(stormDiagnostics.meanWind0to6kmKt, 0),
    bunkersRightDirDeg: roundNullable(stormDiagnostics.bunkersRightDirDeg, 0),
    bunkersRightKt: roundNullable(stormDiagnostics.bunkersRightKt, 0),
    bunkersLeftDirDeg: roundNullable(stormDiagnostics.bunkersLeftDirDeg, 0),
    bunkersLeftKt: roundNullable(stormDiagnostics.bunkersLeftKt, 0),
    bunkersMethod: stormDiagnostics.bunkersMethod || null,
    corfidiUpshearDirDeg: roundNullable(stormDiagnostics.corfidiUpshearDirDeg, 0),
    corfidiUpshearKt: roundNullable(stormDiagnostics.corfidiUpshearKt, 0),
    corfidiDownshearDirDeg: roundNullable(stormDiagnostics.corfidiDownshearDirDeg, 0),
    corfidiDownshearKt: roundNullable(stormDiagnostics.corfidiDownshearKt, 0),
    stormRelativeWind0to2kmKt: roundNullable(stormDiagnostics.stormRelativeWind0to2kmKt, 0),
    stormRelativeWind4to6kmKt: roundNullable(stormDiagnostics.stormRelativeWind4to6kmKt, 0),
    ehi0to1km: roundNullable(ehi0to1, 2),
    ehi0to3km: roundNullable(ehi0to3, 2),
    supercellComposite: roundNullable(scpProxy, 1),
    supercellCompositeProxy: roundNullable(scpProxy, 1),
    supercellCompositeEffective: roundNullable(scpEffective, 1),
    significantTornadoFixed: roundNullable(fixedStp, 1),
    significantTornadoEffective: roundNullable(effectiveStp, 1),
    updraftHelicity2to5kmM2S2: roundNullable(direct?.updraftHelicity2to5kmM2S2, 0),
    maxHailSizeIn: roundNullable(direct?.maxHailSizeIn, 2),
    maxWindKt: roundNullable(Number.isFinite(maxWind) ? maxWind : Number.NaN, 0),
  };
}

function buildPointSoundingParcelTrace(rows, parcelDiagnostics = null) {
  const usable = (Array.isArray(rows) ? rows : [])
    .filter(
      (row) =>
        Number.isFinite(row.pressureHpa) &&
        Number.isFinite(row.heightAglM) &&
        Number.isFinite(row.tempK) &&
        Number.isFinite(row.dewpointK),
    )
    .sort((left, right) => Number(left.heightAglM) - Number(right.heightAglM));
  if (usable.length < 3) {
    return null;
  }
  const diagnostics = parcelDiagnostics || buildPointSoundingParcelDiagnostics(usable);
  const selected = selectPointSoundingParcelTraceSource(usable, diagnostics);
  if (!selected?.row) {
    return null;
  }
  const source = selected.row;
  const scratch = createPointSoundingScratch(usable.length);
  const rowCount = fillPointSoundingScratch(usable, scratch);
  prepareEffectiveParcelSegments(scratch, rowCount);
  const parcelResult = selected.parcel || calculatePressureStepParcelCapeCinForSource(scratch, rowCount, source);
  const liftedIndexC = calculateLiftedIndexForPointSoundingSource(usable, source);
  // Sample the trace densely (every 20 hPa plus each profile row and the
  // exact LCL pressure) so the dry-adiabat/pseudoadiabat kink at the LCL is
  // rendered instead of being interpolated across coarse profile rows.
  const samplePressures = [];
  const addSamplePressure = (pressureHpa) => {
    const pressure = Number(pressureHpa);
    if (!Number.isFinite(pressure) || pressure <= 0 || pressure > Number(source.pressureHpa) + 1e-6) {
      return;
    }
    if (samplePressures.some((existing) => Math.abs(existing - pressure) < 0.6)) {
      return;
    }
    samplePressures.push(pressure);
  };
  const topPressure = usable.reduce(
    (top, row) => (Number.isFinite(row.pressureHpa) && row.pressureHpa < top ? Number(row.pressureHpa) : top),
    Number(source.pressureHpa),
  );
  addSamplePressure(source.pressureHpa);
  const sourceDewpointK = Math.min(Number(source.dewpointK), Number(source.tempK));
  const lclTempK = boltonLclTemperatureK(Number(source.tempK), sourceDewpointK);
  if (Number.isFinite(lclTempK)) {
    addSamplePressure(Number(source.pressureHpa) * Math.pow(lclTempK / Number(source.tempK), CP_OVER_RD));
  }
  for (const row of usable) {
    if (Number(row.heightAglM) < Number(source.heightAglM) - 1) {
      continue;
    }
    addSamplePressure(row.pressureHpa);
  }
  for (let pressure = Math.floor(Number(source.pressureHpa)); pressure >= topPressure; pressure -= 20) {
    addSamplePressure(pressure);
  }
  samplePressures.sort((left, right) => right - left);
  const levels = [];
  for (const pressure of samplePressures) {
    const parcelTempK =
      Math.abs(pressure - Number(source.pressureHpa)) < 1e-6
        ? Number(source.tempK)
        : calculateParcelTemperatureAtPressureK(source, pressure);
    if (!Number.isFinite(parcelTempK)) {
      continue;
    }
    levels.push({
      press: roundNullable(pressure, 1),
      temp: roundNullable(kelvinToCelsius(parcelTempK), 1),
    });
  }
  if (levels.length < 2) {
    return null;
  }
  return {
    type: selected.type,
    label: `${selected.type} Parcel`,
    sourcePressureHpa: roundNullable(source.pressureHpa, 1),
    sourceHeightM: roundNullable(source.heightAglM, 0),
    sourceTemperatureC: roundNullable(kelvinToCelsius(source.tempK), 1),
    sourceDewpointC: roundNullable(kelvinToCelsius(source.dewpointK), 1),
    capeJkg: roundNullable(parcelResult?.capeJkg, 0),
    cinJkg: roundNullable(parcelResult?.cinJkg, 0),
    lclM: roundNullable(parcelResult?.lclAglM, 0),
    lfcM: roundNullable(parcelResult?.lfcAglM, 0),
    elM: roundNullable(parcelResult?.elAglM, 0),
    liftedIndexC: roundNullable(liftedIndexC, 1),
    levels,
  };
}

function selectPointSoundingParcelTraceSource(rows, diagnostics = {}) {
  const surface = rows?.[0];
  if (!surface) {
    return null;
  }
  const sbcape = Number(diagnostics?.surfaceCapeJkg);
  const mlcape = Number(diagnostics?.mixedLayerCapeJkg);
  const mucape = Number(diagnostics?.mostUnstableCapeJkg);
  const sfcScore = Number.isFinite(sbcape) ? sbcape : Number.NEGATIVE_INFINITY;
  const mlScore = Number.isFinite(mlcape) ? mlcape : Number.NEGATIVE_INFINITY;
  const muScore = Number.isFinite(mucape) ? mucape : Number.NEGATIVE_INFINITY;
  if (muScore > Math.max(sfcScore, mlScore, 0) + 100) {
    const source = diagnostics?.mostUnstableSource || findMostUnstablePointSoundingRow(rows);
    if (source) {
      return { type: "MU", row: source, parcel: diagnostics?.mostUnstableParcel || null };
    }
  }
  if (mlScore > Math.max(sfcScore, 0) + 100) {
    const source = diagnostics?.mixedLayerSource || buildMixedLayerPointSoundingSourceRow(rows);
    if (source) {
      return { type: "ML", row: source, parcel: diagnostics?.mixedLayerParcel || null };
    }
  }
  return { type: "SFC", row: surface, parcel: diagnostics?.surfaceParcel || null };
}

function findMostUnstablePointSoundingRow(rows) {
  const scratch = createPointSoundingScratch(Array.isArray(rows) ? rows.length : 0);
  const rowCount = fillPointSoundingScratch(rows, scratch);
  return findMostUnstablePointSoundingSourceFromScratch(scratch, rowCount);
}

function findMostUnstablePointSoundingSourceFromScratch(scratch, rowCount) {
  const surfacePressure = Number(scratch?.pressure?.[0]);
  if (!Number.isFinite(surfacePressure) || rowCount < 2) {
    return null;
  }
  const pressureFloor = Math.max(findTopPressureHpaForScratch(scratch, rowCount), surfacePressure - 300);
  let best = null;
  let bestThetaE = Number.NEGATIVE_INFINITY;
  for (let pressure = surfacePressure; pressure >= pressureFloor; pressure -= PARCEL_INTEGRATION_STEP_HPA) {
    const sample = interpolateProfileThermoAtPressureRows(scratch, rowCount, pressure);
    if (!sample || Number(sample.heightAglM) > EFFECTIVE_PARCEL_SOURCE_MAX_AGL_M) {
      continue;
    }
    const thetaE = boltonThetaE(sample.tempK, sample.dewpointK, pressure);
    if (Number.isFinite(thetaE) && thetaE > bestThetaE) {
      bestThetaE = thetaE;
      best = {
        source: "mostUnstable",
        pressureHpa: pressure,
        heightAglM: sample.heightAglM,
        heightMslM: Number.NaN,
        tempK: sample.tempK,
        dewpointK: sample.dewpointK,
      };
    }
  }
  return best;
}

function buildMixedLayerPointSoundingSourceRow(rows) {
  const surface = rows?.[0];
  if (!surface) {
    return null;
  }
  const scratch = createPointSoundingScratch(rows.length);
  const rowCount = fillPointSoundingScratch(rows, scratch);
  const source = buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount);
  if (!source) {
    return null;
  }
  return {
    ...source,
    source: "mixedLayer",
    heightMslM: surface.heightMslM,
    uMps: surface.uMps,
    vMps: surface.vMps,
  };
}

function buildPointSoundingAnalysisRows(levels) {
  const usable = (Array.isArray(levels) ? levels : [])
    .filter((level) => Number.isFinite(level.hght) && Number.isFinite(level.press))
    .sort((left, right) => Number(left.hght) - Number(right.hght));
  const surface = usable.find((level) => level.source === "surface") || null;
  const surfaceHeight = Number(surface?.hght);
  if (!surface || !Number.isFinite(surfaceHeight)) {
    return [];
  }
  return usable
    .map((level) => {
      const tempC = finiteOptionalNumber(level.temp);
      const dewpointC = finiteOptionalNumber(level.dwpt);
      const uKt = finiteOptionalNumber(level.uKt);
      const vKt = finiteOptionalNumber(level.vKt);
      const heightAglM = Number(level.hght) - (Number.isFinite(surfaceHeight) ? surfaceHeight : 0);
      return {
        source: level.source || "pressure",
        pressureHpa: Number(level.press),
        heightAglM: level.source === "surface" ? 0 : Math.max(0, heightAglM),
        heightMslM: Number(level.hght),
        tempK: Number.isFinite(tempC) ? tempC + 273.15 : Number.NaN,
        dewpointK: Number.isFinite(dewpointC) ? dewpointC + 273.15 : Number.NaN,
        uMps: Number.isFinite(uKt) ? uKt / MPS_TO_KT : Number.NaN,
        vMps: Number.isFinite(vKt) ? vKt / MPS_TO_KT : Number.NaN,
      };
    })
    .filter(
      (row) =>
        Number.isFinite(row.pressureHpa) &&
        Number.isFinite(row.heightAglM) &&
        Number.isFinite(row.tempK) &&
        Number.isFinite(row.dewpointK),
    )
    .sort((left, right) => left.heightAglM - right.heightAglM);
}

function createPointSoundingScratch(rowCount) {
  const size = Math.max(4, Number(rowCount) || 0);
  return {
    heights: new Float64Array(size),
    u: new Float64Array(size),
    v: new Float64Array(size),
    pressure: new Float64Array(size),
    temp: new Float64Array(size),
    dewpoint: new Float64Array(size),
    segmentValid: new Uint8Array(size),
    segmentDz: new Float64Array(size),
    segmentMidHeight: new Float64Array(size),
    segmentMidPressure: new Float64Array(size),
    segmentEnvVirtualTemp: new Float64Array(size),
  };
}

function fillPointSoundingScratch(rows, scratch) {
  let rowCount = 0;
  for (const row of rows || []) {
    if (!Number.isFinite(row.heightAglM) || !Number.isFinite(row.pressureHpa)) {
      continue;
    }
    scratch.heights[rowCount] = row.heightAglM;
    scratch.pressure[rowCount] = row.pressureHpa;
    scratch.temp[rowCount] = row.tempK;
    scratch.dewpoint[rowCount] = row.dewpointK;
    scratch.u[rowCount] = row.uMps;
    scratch.v[rowCount] = row.vMps;
    rowCount += 1;
  }
  sortEffectiveDiagnosticsRowsByHeight(scratch, rowCount);
  return rowCount;
}

function buildPointSoundingParcelDiagnostics(rows) {
  const scratch = createPointSoundingScratch(rows.length);
  const rowCount = fillPointSoundingScratch(rows, scratch);
  const out = {
    surfaceCapeJkg: Number.NaN,
    surfaceCinJkg: Number.NaN,
    surfaceLclM: Number.NaN,
    surfaceLfcM: Number.NaN,
    surfaceElM: Number.NaN,
    mixedLayerCapeJkg: Number.NaN,
    mixedLayerCape0to3kmJkg: Number.NaN,
    mixedLayerCinJkg: Number.NaN,
    mixedLayerLclM: Number.NaN,
    mixedLayerLfcM: Number.NaN,
    mixedLayerElM: Number.NaN,
    mixedLayerLiftedIndexC: Number.NaN,
    mostUnstableCapeJkg: Number.NaN,
    mostUnstableCinJkg: Number.NaN,
    mostUnstableLclM: Number.NaN,
    mostUnstableLfcM: Number.NaN,
    mostUnstableElM: Number.NaN,
    mostUnstableLiftedIndexC: Number.NaN,
    surfaceParcel: null,
    mixedLayerParcel: null,
    mixedLayerSource: null,
    mostUnstableParcel: null,
    mostUnstableSource: null,
  };
  if (rowCount < 3) {
    return out;
  }
  prepareEffectiveParcelSegments(scratch, rowCount);
  out.surfaceLclM = calculateParcelLclAglM({
    pressureHpa: scratch.pressure[0],
    heightAglM: scratch.heights[0],
    tempK: scratch.temp[0],
    dewpointK: scratch.dewpoint[0],
  });
  const surfaceParcel = calculateParcelCapeCinFromRows(scratch, rowCount, 0, { pressureStep: true });
  if (surfaceParcel) {
    out.surfaceParcel = surfaceParcel;
    out.surfaceCapeJkg = surfaceParcel.capeJkg;
    out.surfaceCinJkg = surfaceParcel.cinJkg;
    out.surfaceLclM = finiteOrNumber(surfaceParcel.lclAglM, out.surfaceLclM);
    out.surfaceLfcM = surfaceParcel.lfcAglM;
    out.surfaceElM = surfaceParcel.elAglM;
  }
  const mixedLayerSource = buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount);
  const mixedLayerParcel = mixedLayerSource
    ? calculatePressureStepParcelCapeCinForSource(scratch, rowCount, mixedLayerSource)
    : null;
  if (mixedLayerSource && mixedLayerParcel) {
    out.mixedLayerSource = mixedLayerSource;
    out.mixedLayerParcel = mixedLayerParcel;
    out.mixedLayerCapeJkg = mixedLayerParcel.capeJkg;
    out.mixedLayerCape0to3kmJkg = finiteOptionalNumber(mixedLayerParcel.cape0to3kmJkg);
    out.mixedLayerCinJkg = mixedLayerParcel.cinJkg;
    out.mixedLayerLclM = mixedLayerParcel.lclAglM;
    out.mixedLayerLfcM = mixedLayerParcel.lfcAglM;
    out.mixedLayerElM = mixedLayerParcel.elAglM;
    out.mixedLayerLiftedIndexC = calculateLiftedIndexForPointSoundingSource(rows, mixedLayerSource);
  }
  const mostUnstableSource = findMostUnstablePointSoundingSourceFromScratch(scratch, rowCount);
  const mostUnstableParcel = mostUnstableSource
    ? calculatePressureStepParcelCapeCinForSource(scratch, rowCount, mostUnstableSource)
    : null;
  if (mostUnstableSource && mostUnstableParcel) {
    out.mostUnstableSource = mostUnstableSource;
    out.mostUnstableParcel = mostUnstableParcel;
    out.mostUnstableCapeJkg = mostUnstableParcel.capeJkg;
    out.mostUnstableCinJkg = mostUnstableParcel.cinJkg;
    out.mostUnstableLclM = mostUnstableParcel.lclAglM;
    out.mostUnstableLfcM = mostUnstableParcel.lfcAglM;
    out.mostUnstableElM = mostUnstableParcel.elAglM;
    out.mostUnstableLiftedIndexC = calculateLiftedIndexForPointSoundingSource(rows, mostUnstableSource);
  }
  return out;
}

function buildPointSoundingStormDiagnostics(rows, direct = {}, options = {}) {
  const scratch = createPointSoundingScratch(rows.length);
  const rowCount = fillPointSoundingScratch(rows, scratch);
  const out = {};
  if (rowCount < 2) {
    return out;
  }
  prepareEffectiveParcelSegments(scratch, rowCount);
  const meanWind0to6km = calculatePointSoundingMeanWindInLayerFromRows(scratch, rowCount, 0, 6000);
  if (meanWind0to6km) {
    const mean = windComponentsToMeteorological(meanWind0to6km.u, meanWind0to6km.v);
    out.meanWind0to6kmDirDeg = mean.wdir;
    out.meanWind0to6kmKt = mean.wspd;
  }
  const corfidi = calculateCorfidiMcsMotionFromRows(scratch, rowCount);
  if (corfidi) {
    const upshear = windComponentsToMeteorological(corfidi.upshear.u, corfidi.upshear.v);
    const downshear = windComponentsToMeteorological(corfidi.downshear.u, corfidi.downshear.v);
    out.corfidiUpshearDirDeg = upshear.wdir;
    out.corfidiUpshearKt = upshear.wspd;
    out.corfidiDownshearDirDeg = downshear.wdir;
    out.corfidiDownshearKt = downshear.wspd;
  }
  const layer = calculateEffectiveParcelLayerFromRows(scratch, rowCount, { pressureStep: true, sourceStepHpa: 0 });
  let activeBunkersRight = null;
  let activeBunkersLeft = null;
  let activeBunkersMethod = "";
  if (layer && Number.isFinite(layer.baseAglM) && Number.isFinite(layer.topAglM)) {
    out.effectiveBaseM = layer.baseAglM;
    out.effectiveTopM = layer.topAglM;
    out.muCapeJkg = layer.muCapeJkg;
    out.muCinJkg = layer.muCinJkg;
    const effectiveBunkers = calculateEffectiveLayerBunkersMotionFromRows(scratch, rowCount, layer);
    if (effectiveBunkers?.right && effectiveBunkers?.left) {
      activeBunkersRight = effectiveBunkers.right;
      activeBunkersLeft = effectiveBunkers.left;
      activeBunkersMethod = "effective";
    }
  }
  const fixedBunkers = calculateBunkersMotionFromRows(scratch, rowCount);
  if (fixedBunkers?.right && fixedBunkers?.left) {
    if (!activeBunkersRight || !activeBunkersLeft) {
      activeBunkersRight = fixedBunkers.right;
      activeBunkersLeft = fixedBunkers.left;
      activeBunkersMethod = "fixed-0-6km";
    }
  }
  if (activeBunkersRight) {
    const motion = windComponentsToMeteorological(activeBunkersRight.u, activeBunkersRight.v);
    out.bunkersRightDirDeg = motion.wdir;
    out.bunkersRightKt = motion.wspd;
    out.bunkersMethod = activeBunkersMethod;
    out.srh0to1kmM2S2 = calculateStormRelativeHelicityFromRows(scratch, rowCount, 0, 1000, activeBunkersRight);
    out.srh0to3kmM2S2 = calculateStormRelativeHelicityFromRows(scratch, rowCount, 0, 3000, activeBunkersRight);
    out.stormRelativeWind0to2kmKt = calculateStormRelativeMeanWindKt(scratch, rowCount, 0, 2000, activeBunkersRight);
    out.stormRelativeWind4to6kmKt = calculateStormRelativeMeanWindKt(scratch, rowCount, 4000, 6000, activeBunkersRight);
  }
  if (activeBunkersLeft) {
    const motion = windComponentsToMeteorological(activeBunkersLeft.u, activeBunkersLeft.v);
    out.bunkersLeftDirDeg = motion.wdir;
    out.bunkersLeftKt = motion.wspd;
  }
  if (layer && Number.isFinite(layer.baseAglM) && Number.isFinite(layer.topAglM)) {
    const windAtBase = interpolateProfileWindRows(scratch, rowCount, layer.baseAglM);
    const muElAglM = Number.isFinite(layer.muElAglM) ? layer.muElAglM : layer.topAglM;
    const ebwdTopAglM = layer.baseAglM + 0.5 * Math.max(0, muElAglM - layer.baseAglM);
    const windAtEbwdTop = interpolateProfileWindRows(scratch, rowCount, ebwdTopAglM);
    if (windAtBase && windAtEbwdTop) {
      out.effectiveBulkShearKt = Math.hypot(windAtEbwdTop.u - windAtBase.u, windAtEbwdTop.v - windAtBase.v) * MPS_TO_KT;
    }
    if (activeBunkersRight) {
      out.effectiveSrhM2S2 = calculateStormRelativeHelicityFromRows(
        scratch,
        rowCount,
        layer.baseAglM,
        Math.max(layer.topAglM, layer.baseAglM + 1),
        activeBunkersRight,
      );
    }
  }
  out.mixedLayerLclM = calculatePointSoundingMixedLayerLclMFromRows(scratch, rowCount);
  if (
    !Number.isFinite(out.effectiveBaseM) &&
    Number.isFinite(options.sbcapeJkg) &&
    Number.isFinite(options.sbcinJkg) &&
    options.sbcapeJkg >= EFFECTIVE_INFLOW_MIN_CAPE_JKG &&
    options.sbcinJkg >= EFFECTIVE_INFLOW_MIN_CIN_JKG
  ) {
    out.effectiveBaseM = 0;
    out.effectiveTopM = Number.NaN;
  }
  return out;
}

function calculateStormRelativeMeanWindKt(scratch, rowCount, bottomAglM, topAglM, stormMotion) {
  const meanWind = calculatePointSoundingMeanWindInLayerFromRows(scratch, rowCount, bottomAglM, topAglM);
  if (!meanWind || !stormMotion) {
    return Number.NaN;
  }
  return Math.hypot(meanWind.u - stormMotion.u, meanWind.v - stormMotion.v) * MPS_TO_KT;
}

function pointSoundingLayerShearKt(levels, surface, topAglM) {
  if (!surface || !Number.isFinite(surface.hght) || !Number.isFinite(surface.uKt) || !Number.isFinite(surface.vKt)) {
    return Number.NaN;
  }
  const targetHeight = Number(surface.hght) + Number(topAglM);
  const uTop = interpolateProfileValueByHeight(levels, targetHeight, "uKt");
  const vTop = interpolateProfileValueByHeight(levels, targetHeight, "vKt");
  return Number.isFinite(uTop) && Number.isFinite(vTop)
    ? Math.hypot(uTop - Number(surface.uKt), vTop - Number(surface.vKt))
    : Number.NaN;
}

function pointSoundingPressureShearKt(levels, surface, pressureHpa) {
  if (!surface || !Number.isFinite(surface.uKt) || !Number.isFinite(surface.vKt)) {
    return Number.NaN;
  }
  const uTop = levelValueByPressure(levels, pressureHpa, "uKt");
  const vTop = levelValueByPressure(levels, pressureHpa, "vKt");
  return Number.isFinite(uTop) && Number.isFinite(vTop)
    ? Math.hypot(uTop - Number(surface.uKt), vTop - Number(surface.vKt))
    : Number.NaN;
}

function calculatePrecipitableWaterMm(levels) {
  const profile = (Array.isArray(levels) ? levels : [])
    .filter((level) => Number.isFinite(level.press) && Number.isFinite(level.dwpt))
    .sort((left, right) => Number(right.press) - Number(left.press));
  let total = 0;
  for (let index = 1; index < profile.length; index += 1) {
    const lower = profile[index - 1];
    const upper = profile[index];
    const qLower = specificHumidityFromDewpointC(Number(lower.dwpt), Number(lower.press));
    const qUpper = specificHumidityFromDewpointC(Number(upper.dwpt), Number(upper.press));
    const dpPa = Math.abs((Number(lower.press) - Number(upper.press)) * 100);
    if (!Number.isFinite(qLower) || !Number.isFinite(qUpper) || !Number.isFinite(dpPa)) {
      continue;
    }
    total += ((qLower + qUpper) / 2) * (dpPa / GRAVITY_M_S2);
  }
  return Number.isFinite(total) && total > 0 ? total : Number.NaN;
}

function specificHumidityFromDewpointC(dewpointC, pressureHpa) {
  const mixingRatio = mixingRatioFromDewpointK(Number(dewpointC) + 273.15, pressureHpa);
  return Number.isFinite(mixingRatio) ? mixingRatio / (1 + mixingRatio) : Number.NaN;
}

function interpolateHeightForWetBulbZero(levels) {
  const wetBulbLevels = (Array.isArray(levels) ? levels : [])
    .map((level) => ({
      hght: Number(level.hght),
      wetBulb: wetBulbTemperatureCAtPressure(
        Number(level.temp) + 273.15,
        Number(level.dwpt) + 273.15,
        Number(level.press),
      ),
    }))
    .filter((level) => Number.isFinite(level.hght) && Number.isFinite(level.wetBulb))
    .sort((left, right) => left.hght - right.hght);
  for (let index = 1; index < wetBulbLevels.length; index += 1) {
    const lower = wetBulbLevels[index - 1];
    const upper = wetBulbLevels[index];
    if ((lower.wetBulb >= 0 && upper.wetBulb <= 0) || (lower.wetBulb <= 0 && upper.wetBulb >= 0)) {
      if (Math.abs(upper.wetBulb - lower.wetBulb) < 1e-9) {
        return lower.hght;
      }
      const t = (0 - lower.wetBulb) / (upper.wetBulb - lower.wetBulb);
      return lower.hght + (upper.hght - lower.hght) * clamp01(t);
    }
  }
  return Number.NaN;
}

function calculateLiftedIndexC(rows, sourceRow) {
  const env500 = pointSoundingRowAtPressure(rows, 500);
  const source = rows?.[sourceRow || 0];
  return calculateLiftedIndexForPointSoundingSource(rows, source, env500);
}

function calculateShowalterIndexC(rows) {
  const source850 = pointSoundingRowAtPressure(rows, 850);
  const env500 = pointSoundingRowAtPressure(rows, 500);
  const parcelTemp500K = calculateParcelTemperatureAtPressureK(source850, 500, env500?.heightAglM);
  return env500 && Number.isFinite(parcelTemp500K) ? env500.tempK - parcelTemp500K : Number.NaN;
}

function pointSoundingRowAtPressure(rows, pressureHpa) {
  const profile = (Array.isArray(rows) ? rows : [])
    .filter((row) => Number.isFinite(row.pressureHpa) && Number.isFinite(row.heightAglM))
    .sort((left, right) => Number(right.pressureHpa) - Number(left.pressureHpa));
  for (let index = 1; index < profile.length; index += 1) {
    const lower = profile[index - 1];
    const upper = profile[index];
    if (
      (lower.pressureHpa >= pressureHpa && upper.pressureHpa <= pressureHpa) ||
      (lower.pressureHpa <= pressureHpa && upper.pressureHpa >= pressureHpa)
    ) {
      const t = logPressureInterpolationFraction(pressureHpa, lower.pressureHpa, upper.pressureHpa);
      return {
        pressureHpa,
        heightAglM: lower.heightAglM + (upper.heightAglM - lower.heightAglM) * clamp01(t),
        tempK: lower.tempK + (upper.tempK - lower.tempK) * clamp01(t),
        dewpointK: lower.dewpointK + (upper.dewpointK - lower.dewpointK) * clamp01(t),
      };
    }
  }
  return null;
}

function calculateParcelTemperatureAtPressureK(source, targetPressureHpa, _targetHeightAglM) {
  if (
    !source ||
    !Number.isFinite(source.pressureHpa) ||
    !Number.isFinite(source.tempK) ||
    !Number.isFinite(source.dewpointK) ||
    !Number.isFinite(targetPressureHpa) ||
    targetPressureHpa <= 0 ||
    targetPressureHpa > source.pressureHpa + 1
  ) {
    return Number.NaN;
  }
  const sourceDewpointK = Math.min(source.dewpointK, source.tempK);
  const lclTempK = boltonLclTemperatureK(source.tempK, sourceDewpointK);
  if (!Number.isFinite(lclTempK)) {
    return Number.NaN;
  }
  const lclPressure = source.pressureHpa * Math.pow(lclTempK / source.tempK, CP_OVER_RD);
  if (!Number.isFinite(lclPressure)) {
    return Number.NaN;
  }
  if (targetPressureHpa >= lclPressure) {
    return source.tempK * Math.pow(targetPressureHpa / source.pressureHpa, RD_OVER_CP);
  }
  return moistLiftTemperatureK(lclPressure, lclTempK, targetPressureHpa);
}

// Reference downdraft CAPE for point soundings (point-dcape-v4).
// SHARPpy/NSHARP parity (params.dcape adapted from John Hart's SPC code):
// the downdraft source is found by scanning every profile level in the
// lowest 400 mb above ground and computing the 100 mb layer-mean theta-e of
// the layer extending upward from that level (1 hPa steps on log-pressure
// interpolated T/Td). The parcel starts at the midpoint of the
// minimum-mean-theta-e layer (candidate pressure minus 50 mb) from the
// pressure-aware Normand wet-bulb of the interpolated T/Td there, then
// descends pseudoadiabatically (exact Wobus) level-by-level to the surface.
// DCAPE is the net plain-temperature trapezoid buoyancy integral, clamped to
// [0, 4000] J/kg. The pre-v4 point-min-theta-e/100-mb-mean-parcel variant
// understated DCAPE by ~40% against SHARPpy on LLJ/dry-slot soundings.
function calculatePointDcapeJkg(levels) {
  const usable = (Array.isArray(levels) ? levels : [])
    .filter(
      (level) =>
        Number.isFinite(level.hght) &&
        Number.isFinite(level.temp) &&
        Number.isFinite(level.press) &&
        (Number.isFinite(level.dwpt) || Number.isFinite(level.rh)),
    )
    .sort((left, right) => Number(right.press) - Number(left.press));
  const surface = usable.find((level) => level.source === "surface") || null;
  const surfacePressure = Number(surface?.press);
  if (!surface || usable.length < 3 || !Number.isFinite(surfacePressure) || surfacePressure <= 100) {
    return Number.NaN;
  }
  const pressureFloor = surfacePressure - 400;

  const dewpointKOf = (level) =>
    Number.isFinite(level.dwpt)
      ? Number(level.dwpt) + 273.15
      : dewpointFromTempRhK(Number(level.temp) + 273.15, Number(level.rh));

  const interpolateThermo = (pressureHpa) => {
    for (let index = 1; index < usable.length; index += 1) {
      const lower = usable[index - 1];
      const upper = usable[index];
      const lowerPressure = Number(lower.press);
      const upperPressure = Number(upper.press);
      if (!(lowerPressure >= pressureHpa && upperPressure <= pressureHpa)) {
        continue;
      }
      const t = clamp01(logPressureInterpolationFraction(pressureHpa, lowerPressure, upperPressure));
      const lowerDewpointK = dewpointKOf(lower);
      const upperDewpointK = dewpointKOf(upper);
      if (!Number.isFinite(lowerDewpointK) || !Number.isFinite(upperDewpointK)) {
        return null;
      }
      return {
        tempK: Number(lower.temp) + 273.15 + (Number(upper.temp) - Number(lower.temp)) * t,
        dewpointK: lowerDewpointK + (upperDewpointK - lowerDewpointK) * t,
        heightM: Number(lower.hght) + (Number(upper.hght) - Number(lower.hght)) * t,
      };
    }
    return null;
  };

  const layerMeanThetaE = (bottomPressureHpa) => {
    let sum = 0;
    let count = 0;
    for (let pressure = bottomPressureHpa; pressure >= bottomPressureHpa - 100; pressure -= 1) {
      const sample = interpolateThermo(pressure);
      if (!sample) {
        return Number.NaN;
      }
      const thetaE = boltonThetaE(sample.tempK, sample.dewpointK, pressure);
      if (!Number.isFinite(thetaE)) {
        return Number.NaN;
      }
      sum += thetaE;
      count += 1;
    }
    return count > 0 ? sum / count : Number.NaN;
  };

  let bestMeanThetaE = Number.POSITIVE_INFINITY;
  let sourcePressureHpa = Number.NaN;
  for (const level of usable) {
    const pressure = Number(level.press);
    if (!Number.isFinite(pressure) || pressure < pressureFloor || pressure > surfacePressure) {
      continue;
    }
    const meanThetaE = layerMeanThetaE(pressure);
    if (Number.isFinite(meanThetaE) && meanThetaE < bestMeanThetaE) {
      bestMeanThetaE = meanThetaE;
      sourcePressureHpa = pressure - 50;
    }
  }
  if (!Number.isFinite(sourcePressureHpa)) {
    return Number.NaN;
  }

  const source = interpolateThermo(sourcePressureHpa);
  if (!source) {
    return Number.NaN;
  }
  const sourceDewpointK = Math.min(source.dewpointK, source.tempK);
  const sourceWetBulbC = wetBulbTemperatureCAtPressure(source.tempK, sourceDewpointK, sourcePressureHpa);
  if (!Number.isFinite(sourceWetBulbC)) {
    return Number.NaN;
  }

  // Descend from the source midpoint to the surface across the profile
  // levels below it, in increasing-pressure order. With downward steps the
  // height delta is negative and a colder-than-environment parcel yields a
  // positive accumulated energy, matching SHARPpy's tote convention.
  const descentLevels = usable
    .filter((level) => Number(level.press) > sourcePressureHpa)
    .sort((left, right) => Number(left.press) - Number(right.press));
  let parcelPressure = sourcePressureHpa;
  let parcelTempK = sourceWetBulbC + 273.15;
  let envTempK = source.tempK;
  let heightM = source.heightM;
  let energy = 0;
  for (const level of descentLevels) {
    const pressure = Number(level.press);
    const nextParcelTempK = moistLiftTemperatureK(parcelPressure, parcelTempK, pressure);
    const nextEnvTempK = Number(level.temp) + 273.15;
    const nextHeightM = Number(level.hght);
    if (!Number.isFinite(nextParcelTempK)) {
      continue;
    }
    const deficitLower = (parcelTempK - envTempK) / envTempK;
    const deficitUpper = (nextParcelTempK - nextEnvTempK) / nextEnvTempK;
    const segment = ((GRAVITY_M_S2 * (deficitLower + deficitUpper)) / 2) * (nextHeightM - heightM);
    if (Number.isFinite(segment)) {
      energy += segment;
    }
    parcelPressure = pressure;
    parcelTempK = nextParcelTempK;
    envTempK = nextEnvTempK;
    heightM = nextHeightM;
  }
  return Number.isFinite(energy) ? Math.min(4000, Math.max(0, energy)) : Number.NaN;
}

// Significant Hail Parameter (SHIP), SHARPpy params.ship parity (SPC 2014,
// Johnson and Sugden 2014): MUCAPE, MU parcel mixing ratio (clipped to
// 11-13.6 g/kg), 700-500 mb lapse rate (SHARPpy's lapse_rate is
// virtual-temperature based), 500 mb temperature (capped at -5.5 C), and
// surface-6 km bulk shear (clipped to 7-27 m/s), normalized by 42,000,000,
// with low-CAPE, low-lapse-rate, and low-freezing-level (MSL) reductions.
function calculatePointShip({
  mucapeJkg,
  muSourcePressureHpa,
  muSourceDewpointK,
  lapseRate700to500CPerKm,
  temp500C,
  shear0to6kmKt,
  freezingLevelMslM,
}) {
  const mucape = Number(mucapeJkg);
  const lr75 = Number(lapseRate700to500CPerKm);
  const freezingLevelM = Number(freezingLevelMslM);
  const mixingRatio = mixingRatioFromDewpointK(Number(muSourceDewpointK), Number(muSourcePressureHpa));
  if (
    ![mucape, lr75, Number(temp500C), Number(shear0to6kmKt), freezingLevelM].every(Number.isFinite) ||
    !Number.isFinite(mixingRatio)
  ) {
    return Number.NaN;
  }
  const mumrGkg = clamp(mixingRatio * 1000, 11, 13.6);
  const shear06Ms = clamp(Math.max(0, Number(shear0to6kmKt)) / MPS_TO_KT, 7, 27);
  const h5TempC = Math.min(Number(temp500C), -5.5);
  let ship = (-1 * (Math.max(0, mucape) * mumrGkg * lr75 * h5TempC * shear06Ms)) / 42000000;
  if (mucape < 1300) {
    ship *= mucape / 1300;
  }
  if (lr75 < 5.8) {
    ship *= lr75 / 5.8;
  }
  if (freezingLevelM < 2400) {
    ship *= freezingLevelM / 2400;
  }
  return Number.isFinite(ship) ? Math.max(0, ship) : Number.NaN;
}

function calculatePointFixedStp({ sbcapeJkg, lclM, srh0to1kmM2S2, shear0to6kmKt }) {
  if (![sbcapeJkg, lclM, srh0to1kmM2S2, shear0to6kmKt].every(Number.isFinite)) {
    return Number.NaN;
  }
  const shearMs = Math.max(0, shear0to6kmKt) / MPS_TO_KT;
  const shearTerm = shearMs < 12.5 ? 0 : clamp(shearMs / 20, 0, 1.5);
  const lclTerm = clamp((2000 - lclM) / 1000, 0, 1);
  return Math.max(0, (Math.max(0, sbcapeJkg) / 1500) * (Math.max(0, srh0to1kmM2S2) / 150) * shearTerm * lclTerm);
}

function calculatePointScp({ mucapeJkg, srh0to3kmM2S2, effectiveBulkShearKt }) {
  if (![mucapeJkg, srh0to3kmM2S2, effectiveBulkShearKt].every(Number.isFinite)) {
    return Number.NaN;
  }
  const shearMs = Math.max(0, effectiveBulkShearKt) / MPS_TO_KT;
  const shearTerm = shearMs < 10 ? 0 : clamp(shearMs / 20, 0, 1);
  return Math.max(0, (Math.max(0, mucapeJkg) / 1000) * (Math.max(0, srh0to3kmM2S2) / 50) * shearTerm);
}

function calculatePointEffectiveStp({
  mlcapeJkg,
  mlcinJkg,
  mixedLayerLclM,
  effectiveSrhM2S2,
  effectiveBulkShearKt,
  effectiveBaseM,
}) {
  if (![mlcapeJkg, mlcinJkg, mixedLayerLclM, effectiveSrhM2S2, effectiveBulkShearKt].every(Number.isFinite)) {
    return Number.NaN;
  }
  if (Number.isFinite(effectiveBaseM) && effectiveBaseM > 0) {
    return 0;
  }
  const shearMs = Math.max(0, effectiveBulkShearKt) / MPS_TO_KT;
  const shearTerm = shearMs < 12.5 ? 0 : clamp(shearMs / 20, 0, 1.5);
  const lclTerm = clamp((2000 - mixedLayerLclM) / 1000, 0, 1);
  const cinTerm = mlcinJkg > -50 ? 1 : clamp((mlcinJkg + 200) / 150, 0, 1);
  return Math.max(
    0,
    (Math.max(0, mlcapeJkg) / 1500) * (Math.max(0, effectiveSrhM2S2) / 150) * shearTerm * lclTerm * cinTerm,
  );
}

function pointSoundingValue(values, param, level) {
  const value = values?.get(pointSoundingValueKey(param, level));
  return Number.isFinite(value) ? value : Number.NaN;
}

function pointSoundingValueByLevelPattern(values, param, pattern) {
  if (!values || !pattern) {
    return Number.NaN;
  }
  for (const [key, value] of values.entries()) {
    const [entryParam, entryLevel] = String(key).split("\u0000");
    if (entryParam === param && pattern.test(entryLevel || "") && Number.isFinite(value)) {
      return value;
    }
  }
  return Number.NaN;
}

function pointSoundingValueKey(param, level) {
  return `${String(param || "").trim()}\u0000${String(level || "").trim()}`;
}

function windComponentsToMeteorological(uMps, vMps) {
  const u = Number(uMps);
  const v = Number(vMps);
  if (!Number.isFinite(u) || !Number.isFinite(v)) {
    return { wdir: Number.NaN, wspd: Number.NaN, uKt: Number.NaN, vKt: Number.NaN };
  }
  const speedKt = Math.hypot(u, v) * MPS_TO_KT;
  const direction = (Math.atan2(-u, -v) * 180) / Math.PI;
  return {
    wdir: (direction + 360) % 360,
    wspd: speedKt,
    uKt: u * MPS_TO_KT,
    vKt: v * MPS_TO_KT,
  };
}

function dewpointCFromTemperatureRh(tempC, rhPct) {
  const temp = Number(tempC);
  const rh = Number(rhPct);
  if (!Number.isFinite(temp) || !Number.isFinite(rh) || rh <= 0) {
    return Number.NaN;
  }
  const clampedRh = Math.max(1, Math.min(100, rh));
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(clampedRh / 100) + (a * temp) / (b + temp);
  return (b * gamma) / (a - gamma);
}

function interpolateHeightForTemperature(levels, targetTempC) {
  const target = Number(targetTempC);
  if (!Number.isFinite(target)) {
    return Number.NaN;
  }
  for (let index = 1; index < levels.length; index += 1) {
    const lower = levels[index - 1];
    const upper = levels[index];
    const lowerTemp = Number(lower.temp);
    const upperTemp = Number(upper.temp);
    if (!Number.isFinite(lowerTemp) || !Number.isFinite(upperTemp)) {
      continue;
    }
    if ((lowerTemp >= target && upperTemp <= target) || (lowerTemp <= target && upperTemp >= target)) {
      if (Math.abs(upperTemp - lowerTemp) < 1e-9) {
        return Number(lower.hght);
      }
      const t = (target - lowerTemp) / (upperTemp - lowerTemp);
      return Number(lower.hght) + (Number(upper.hght) - Number(lower.hght)) * Math.max(0, Math.min(1, t));
    }
  }
  return Number.NaN;
}

function levelValueByPressure(levels, pressureHpa, key) {
  const target = Number(pressureHpa);
  const level = (Array.isArray(levels) ? levels : []).find((entry) => Math.abs(Number(entry.press) - target) < 0.6);
  const value = level ? Number(level[key]) : Number.NaN;
  return Number.isFinite(value) ? value : Number.NaN;
}

function interpolateProfileValueByPressure(levels, pressureHpa, key) {
  const target = Number(pressureHpa);
  if (!Number.isFinite(target) || target <= 0) {
    return Number.NaN;
  }
  const exact = levelValueByPressure(levels, target, key);
  if (Number.isFinite(exact)) {
    return exact;
  }
  const profile = (Array.isArray(levels) ? levels : [])
    .map((level) => ({ pressure: Number(level.press), value: Number(level[key]) }))
    .filter((level) => Number.isFinite(level.pressure) && level.pressure > 0 && Number.isFinite(level.value))
    .sort((left, right) => right.pressure - left.pressure);
  for (let index = 1; index < profile.length; index += 1) {
    const lower = profile[index - 1];
    const upper = profile[index];
    const brackets =
      (lower.pressure >= target && upper.pressure <= target) || (lower.pressure <= target && upper.pressure >= target);
    if (!brackets) {
      continue;
    }
    const t = logPressureInterpolationFraction(target, lower.pressure, upper.pressure);
    return lower.value + (upper.value - lower.value) * clamp01(t);
  }
  return Number.NaN;
}

function virtualTemperatureCAtPressure(levels, pressureHpa) {
  const pressure = Number(pressureHpa);
  const tempC = interpolateProfileValueByPressure(levels, pressure, "temp");
  const dewpointC = interpolateProfileValueByPressure(levels, pressure, "dwpt");
  return virtualTemperatureC(tempC, dewpointC, pressure);
}

function virtualTemperatureCAtHeight(levels, targetHeightM) {
  const tempC = interpolateProfileValueByHeight(levels, targetHeightM, "temp");
  const dewpointC = interpolateProfileValueByHeight(levels, targetHeightM, "dwpt");
  const pressureHpa = interpolateProfilePressureByHeight(levels, targetHeightM);
  return virtualTemperatureC(tempC, dewpointC, pressureHpa);
}

function virtualTemperatureC(tempC, dewpointC, pressureHpa) {
  const tempK = Number(tempC) + 273.15;
  const dewpointK = Number(dewpointC) + 273.15;
  const pressure = Number(pressureHpa);
  if (![tempK, dewpointK, pressure].every(Number.isFinite) || pressure <= 0) {
    return Number.NaN;
  }
  const mixingRatio = mixingRatioFromDewpointK(dewpointK, pressure);
  const virtualTempK = virtualTemperatureK(tempK, mixingRatio);
  return Number.isFinite(virtualTempK) ? virtualTempK - 273.15 : Number.NaN;
}

function interpolateProfilePressureByHeight(levels, targetHeightM) {
  const target = Number(targetHeightM);
  if (!Number.isFinite(target)) {
    return Number.NaN;
  }
  let lower = null;
  for (const level of levels) {
    const height = Number(level.hght);
    const pressure = Number(level.press);
    if (!Number.isFinite(height) || !Number.isFinite(pressure) || pressure <= 0) {
      continue;
    }
    if (height === target) {
      return pressure;
    }
    if (height < target) {
      lower = { height, pressure };
      continue;
    }
    if (!lower) {
      return Number.NaN;
    }
    const t = (target - lower.height) / Math.max(1e-9, height - lower.height);
    return Math.exp(Math.log(lower.pressure) + (Math.log(pressure) - Math.log(lower.pressure)) * clamp01(t));
  }
  return Number.NaN;
}

function interpolateProfileValueByHeight(levels, targetHeightM, key) {
  const target = Number(targetHeightM);
  if (!Number.isFinite(target)) {
    return Number.NaN;
  }
  let lower = null;
  for (const level of levels) {
    const height = Number(level.hght);
    const value = Number(level[key]);
    if (!Number.isFinite(height) || !Number.isFinite(value)) {
      continue;
    }
    if (height === target) {
      return value;
    }
    if (height < target) {
      lower = { height, value };
      continue;
    }
    if (!lower) {
      return Number.NaN;
    }
    const t = (target - lower.height) / Math.max(1e-9, height - lower.height);
    return lower.value + (value - lower.value) * Math.max(0, Math.min(1, t));
  }
  return Number.NaN;
}

function normalizeLongitudeForRequest(value) {
  const lon = Number(value);
  if (!Number.isFinite(lon)) {
    return Number.NaN;
  }
  return lon > 180 ? lon - 360 : lon;
}

function normalizeLongitudeForDisplay(value) {
  const lon = Number(value);
  if (!Number.isFinite(lon)) {
    return Number.NaN;
  }
  return lon > 180 ? lon - 360 : lon;
}

function roundForCommand(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function roundNullable(value, digits = 1) {
  const num = finiteOptionalNumber(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  const factor = 10 ** Math.max(0, Math.round(Number(digits) || 0));
  return Math.round(num * factor) / factor;
}

function finiteOptionalNumber(value) {
  if (value === null || value === undefined || value === "") {
    return Number.NaN;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : Number.NaN;
}

function finiteOrNumber(...values) {
  for (const value of values) {
    const num = finiteOptionalNumber(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return Number.NaN;
}

function calculateLiftedIndexForPointSoundingSource(rows, source, precomputedEnv500 = null) {
  const env500 = precomputedEnv500 || pointSoundingRowAtPressure(rows, 500);
  if (!env500) {
    return Number.NaN;
  }
  const envMixingRatio = mixingRatioFromDewpointK(Math.min(env500.dewpointK, env500.tempK), 500);
  const envVirtualTemp500K = virtualTemperatureK(env500.tempK, envMixingRatio);
  const parcelVirtualTemp500K = calculateParcelVirtualTemperatureAtPressureK(source, 500);
  return Number.isFinite(envVirtualTemp500K) && Number.isFinite(parcelVirtualTemp500K)
    ? envVirtualTemp500K - parcelVirtualTemp500K
    : Number.NaN;
}

function calculateParcelVirtualTemperatureAtPressureK(source, targetPressureHpa) {
  if (
    !source ||
    !Number.isFinite(source.pressureHpa) ||
    !Number.isFinite(source.tempK) ||
    !Number.isFinite(source.dewpointK) ||
    !Number.isFinite(targetPressureHpa) ||
    targetPressureHpa <= 0 ||
    targetPressureHpa > source.pressureHpa + 1
  ) {
    return Number.NaN;
  }
  const sourceDewpointK = Math.min(source.dewpointK, source.tempK);
  const parcelTempK = calculateParcelTemperatureAtPressureK(source, targetPressureHpa);
  const lclTempK = boltonLclTemperatureK(source.tempK, sourceDewpointK);
  const lclPressure = source.pressureHpa * Math.pow(lclTempK / source.tempK, CP_OVER_RD);
  if (![parcelTempK, lclPressure].every(Number.isFinite)) {
    return Number.NaN;
  }
  const mixingRatio =
    targetPressureHpa >= lclPressure
      ? mixingRatioFromDewpointK(sourceDewpointK, source.pressureHpa)
      : saturationMixingRatioHpa(parcelTempK, targetPressureHpa);
  return virtualTemperatureK(parcelTempK, mixingRatio);
}

function calculatePointSoundingMixedLayerLclMFromRows(scratch, rowCount) {
  return calculateParcelLclAglM(buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount));
}

module.exports = {
  M_TO_FT,
  POINT_SOUNDING_CACHE_VERSION,
  buildMixedLayerPointSoundingSourceRow,
  buildNoaaPointSounding,
  buildPointSoundingAnalysisRows,
  buildPointSoundingDirectDiagnostics,
  buildPointSoundingIndices,
  buildPointSoundingParcelDiagnostics,
  buildPointSoundingParcelTrace,
  buildPointSoundingPayload,
  buildPointSoundingPressureLevel,
  buildPointSoundingStormDiagnostics,
  buildPointSoundingSurface,
  buildPointSoundingSurfaceSummary,
  calculateLiftedIndexC,
  calculateLiftedIndexForPointSoundingSource,
  calculateParcelTemperatureAtPressureK,
  calculateParcelVirtualTemperatureAtPressureK,
  calculatePointDcapeJkg,
  calculatePointEffectiveStp,
  calculatePointFixedStp,
  calculatePointScp,
  calculatePointShip,
  calculatePointSoundingMixedLayerLclMFromRows,
  calculatePrecipitableWaterMm,
  calculateShowalterIndexC,
  calculateStormRelativeMeanWindKt,
  createPointSoundingScratch,
  dedupePointSoundingLevels,
  dewpointCFromTemperatureRh,
  fillPointSoundingScratch,
  findMostUnstablePointSoundingRow,
  findMostUnstablePointSoundingSourceFromScratch,
  finiteOptionalNumber,
  finiteOrNumber,
  interpolateHeightForTemperature,
  interpolateHeightForWetBulbZero,
  interpolateProfilePressureByHeight,
  interpolateProfileValueByHeight,
  interpolateProfileValueByPressure,
  isUsableSoundingLevel,
  levelValueByPressure,
  normalizeLongitudeForDisplay,
  normalizeLongitudeForRequest,
  normalizePointSoundingLevel,
  parsePointSoundingLonOutput,
  pointSoundingLayerShearKt,
  pointSoundingPressureShearKt,
  pointSoundingRowAtPressure,
  pointSoundingValue,
  pointSoundingValueByLevelPattern,
  pointSoundingValueKey,
  resolvePointSoundingRunParts,
  roundForCommand,
  roundNullable,
  selectPointSoundingParcelTraceSource,
  specificHumidityFromDewpointC,
  virtualTemperatureC,
  virtualTemperatureCAtHeight,
  virtualTemperatureCAtPressure,
  windComponentsToMeteorological,
};
