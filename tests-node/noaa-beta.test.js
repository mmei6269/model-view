"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  decodeHoverGridPayload,
  encodeHoverGridBinaryPayload,
  mergeHoverGridPayloads,
} = require("../scripts/lib/hover-grid-binary");
const { decodeVectorLinePoints, encodeVectorLine } = require("../scripts/lib/vector-encoding");
const { loadColorMaps } = require("../scripts/lib/color-maps");
const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime");
const { SCALES, SNOW_PROFILE_LEVELS } = require("../scripts/lib/noaa-nam-parameter-catalog");
const {
  NOAA_BETA_SOURCE_NAME,
  buildNoaaGribUrl,
  buildNoaaNamAwphysUrl,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
  _testBuildNoaaIndexCacheContext,
  _testBuildNoaaRegridArgs,
  _testClearNoaaIndexCaches,
  _testRepairNoaaIdxFinalRecordRanges,
  _testSelectedGribRecordsHash,
  _testBuildSelectedRecordPlan,
  _testParseWgribSimpleInventory,
  _testBuildBulkDecodedRecordIndex,
  _testTakeBulkDecodedRecordBySelectedPlan,
  _testBulkDecodedRecordOrdinal,
  _testReadOrFetchNoaaContentLengthCached,
  _testReadOrFetchNoaaIdxTextCached,
  _testBuildHeightContourLevels,
  _testMarchingSquares,
  _testMarchingSquaresMany,
  _testRenderHeightContourArtifacts,
  _testCalculateCobbSlr,
  _testCalculateKucheraRatio,
  _testCalculateWarmestProfileTempC,
  _testBuildPletcherRfFeatures,
  _testBuildWesternLinearFeatures,
  _testComposeSnowMaskedPrecipGrid,
  _testComposePhaseMaskedPrecipGrid,
  _testCalculateFramIceLiquidRatio,
  _testBuildFramIceGridsFromChunks,
  _testCreateContinuousColorLookup,
  _testInterpolateStops,
  _testBuildReflectivityPrecipTypeLookups,
  _testBuildPrecipRateTypeLookups,
  _testBuildDerivedParameterGrids,
  _testFilterCatalogForRenderMode,
  _testComposeRunMaxGrid,
  _testEffectiveLayerCellActive,
  _testBoltonThetaE,
  _testBuildRelativeVorticityGrid,
  _testBuildFrontogenesisGrid,
  _testBuildFrontogenesisPresentationGrid,
  _testBuildScpGrid,
  _testBuildStpGrid,
  _testBuildEffectiveLayerScpGrid,
  _testBuildEffectiveLayerStpGrid,
  _testEffectiveParcelSourceStepHpa,
  _testBuildPointSoundingIndices,
  _testBuildPointSoundingAnalysisRows,
  _testCalculateEffectiveLayerBunkersMotionFromRows,
  _testCalculateBunkersMotionFromRows,
  _testCalculateLiftedIndexForPointSoundingSource,
  _testWetBulbTemperatureC,
  _testCalculateReducedProfileDcapeFromSources,
  _testCalculatePointDcapeJkg,
  _testWetBulbTemperatureCAtPressure,
  _testCalculatePointScp,
  _testCalculateParcelCapeCinForSource,
  _testCalculatePressureStepParcelCapeCinForSource,
  _testLogPressureInterpolationFraction,
  _testInterpolateProfileWindRows,
  _testInterpolateProfilePressureRows,
  _testBuildGridDistributionStats,
  _testResolveCatalogSourceGrid,
  _testFindReflectivityPrecipTypeColorOffset,
  _testFindStepColorOffset,
  _testLoadSnowRfModel,
  _testLoadWesternLinearSlrModel,
  _testSnowArtifactCacheIdentity,
  _testPredictLinearSlr,
  _testPredictRandomForest,
  _testRemapSouthNorthLinearLatGridToMercatorRows,
  _testRenderScalarGrid,
  _testRenderPrecipRateTypeGrid,
  _testBuildIntervalSnowfallGrid,
  _testBuildIntervalSnowfallGridsForEntries,
  _testSumSnowfallGrids,
  _testComposePrecipAccumulationGrid,
  _testActiveGridVisitIndicesGreaterThan,
  _testProfileDecodeKey,
  _testProfileGridCachePayload,
  _testProfileSelector,
  _testStandardProfileDecodeKey,
  _testResolvePrecipAccumulationPlan,
  _testWarmPrecipAccumulationRunPlanner,
  _testWarmFreezingRainAccumulationRunPlanner,
  _testResolveFreezingRainLiquidChunks,
  _testResolveSnowfallLiquidChunks,
  _testResolveSnowLiquidTotalPlan,
  _testBuildSnowfallInGrids,
  _testSmoothSnowfallPresentationGrid,
  _testSnowfallDerivedGridKey,
  parseAccumulationHours,
  parseAccumulationWindow,
  parseNoaaIdx,
  selectNoaaNamParameterRecords,
  selectNamAwphysRecords,
  NOAA_NAM_PARAMETER_CATALOG,
} = require("../scripts/lib/noaa-beta-renderer");
const {
  buildNoaaModelMetadata,
  buildFullHoursForModel,
  buildGlobalFrameQueue,
  buildNoaaNamMetadata,
  _testBuildFrameRenderTasks,
  _testCanStartFrameTaskWithDependencies,
  _testMarkFrameTaskDependencyComplete,
  _testRunGlobalFrameTaskQueue,
  parseHours,
  parseReflectivityGates,
  referenceTimeFromRun,
  resolveHoursByModel,
  resolveModels,
  resolveNoaaModelRun,
  resolveNoaaParameterSetFromIdxText,
  resolveNoaaParameterSetFromIdxTexts,
  resolveParallelism,
  selectNoaaParameterProbeHours,
} = require("../scripts/build-noaa-beta-artifacts");
const REFLECTIVITY_PRECIP_TYPE_COLORS = require("../shared/reflectivity-precip-type-colors.json");
const PLANNED_COLOR_MAPS = require("../shared/noaa-beta-planned-color-maps.json");
const CATALOG_SCALE_PALETTES = require("../shared/catalog-scale-palettes.json");

const SAMPLE_IDX = [
  "1:0:d=2026042512:PRMSL:mean sea level:anl:",
  "2:100:d=2026042512:REFD:1 hybrid level:anl:",
  "3:200:d=2026042512:REFC:entire atmosphere (considered as a single layer):anl:",
  "4:240:d=2026042512:REFD:1000 m above ground:anl:",
  "71:300:d=2026042512:HGT:250 mb:anl:",
  "72.1:320:d=2026042512:UGRD:250 mb:anl:",
  "72.2:320:d=2026042512:VGRD:250 mb:anl:",
  "86:340:d=2026042512:HGT:300 mb:anl:",
  "91.1:360:d=2026042512:UGRD:300 mb:anl:",
  "91.2:360:d=2026042512:VGRD:300 mb:anl:",
  "120:400:d=2026042512:HGT:500 mb:anl:",
  "121:520:d=2026042512:TMP:500 mb:anl:",
  "122:560:d=2026042512:RH:500 mb:anl:",
  "123.1:590:d=2026042512:UGRD:500 mb:anl:",
  "123.2:590:d=2026042512:VGRD:500 mb:anl:",
  "200:640:d=2026042512:HGT:1000 mb:anl:",
  "242:660:d=2026042512:HGT:850 mb:anl:",
  "243:680:d=2026042512:TMP:850 mb:anl:",
  "244:700:d=2026042512:RH:850 mb:anl:",
  "247.1:720:d=2026042512:UGRD:850 mb:anl:",
  "247.2:720:d=2026042512:VGRD:850 mb:anl:",
  "199:740:d=2026042512:HGT:700 mb:anl:",
  "200.1:745:d=2026042512:TMP:700 mb:anl:",
  "201:750:d=2026042512:RH:700 mb:anl:",
  "204.1:755:d=2026042512:UGRD:700 mb:anl:",
  "204.2:755:d=2026042512:VGRD:700 mb:anl:",
  "321:760:d=2026042512:TMP:2 m above ground:anl:",
  "322:820:d=2026042512:SPFH:2 m above ground:anl:",
  "323:850:d=2026042512:DPT:2 m above ground:anl:",
  "324:880:d=2026042512:RH:2 m above ground:anl:",
  "325.1:1000:d=2026042512:UGRD:10 m above ground:anl:",
  "325.2:1000:d=2026042512:VGRD:10 m above ground:anl:",
  "326:1240:d=2026042512:APCP:surface:0-3 hour acc fcst:",
  "330:1280:d=2026042512:CSNOW:surface:anl:",
  "333:1300:d=2026042512:CRAIN:surface:anl:",
  "334:1320:d=2026042512:CFRZR:surface:anl:",
  "335:1340:d=2026042512:CICEP:surface:anl:",
  "344:1360:d=2026042512:CAPE:surface:3 hour fcst:",
  "345:1380:d=2026042512:CIN:surface:3 hour fcst:",
  "346:1400:d=2026042512:PWAT:entire atmosphere (considered as a single layer):3 hour fcst:",
  "348:1420:d=2026042512:HLCY:3000-0 m above ground:3 hour fcst:",
  "359.1:1440:d=2026042512:UGRD:80 m above ground:anl:",
  "359.2:1440:d=2026042512:VGRD:80 m above ground:anl:",
  "382:1460:d=2026042512:CAPE:180-0 mb above ground:3 hour fcst:",
].join("\n");

const COLOR_MAPS = loadColorMaps();

function valueStopColors(scale, value) {
  return (scale.valueStops || [])
    .filter(([stopValue]) => Object.is(stopValue, value))
    .map(([, rgb, alpha]) => [...rgb, Number.isFinite(Number(alpha)) ? Number(alpha) : 1]);
}

function legendStopColorsAt(stops, position) {
  return (stops || []).filter(([stopPosition]) => Math.abs(stopPosition - position) < 1e-12).map(([, color]) => color);
}

function assertBrightStopsBecomeOpacityRamp(plannedStops, renderedStops) {
  const renderedByPosition = new Map((renderedStops || []).map(([position, color]) => [position, color]));
  let brightStopCount = 0;
  for (const [position, color] of plannedStops || []) {
    if (!Array.isArray(color) || Math.min(color[0], color[1], color[2]) < 245) {
      continue;
    }
    brightStopCount += 1;
    const rendered = renderedByPosition.get(position);
    assert.ok(rendered, `planned bright stop at ${position} should remain in legend`);
    assert.ok(rendered[3] >= 0 && rendered[3] < 0.13, `planned bright stop at ${position} should become low-alpha`);
  }
  assert.ok(brightStopCount > 0);
}

function rgbaAtPosition(scale, position) {
  return _testInterpolateStops(scale.legendStops, position);
}

function rgbaAtValue(scale, value) {
  return rgbaAtPosition(scale, (value - scale.min) / (scale.max - scale.min));
}

function assertNoPaintedWhite(scale, label) {
  for (const [, color] of scale.legendStops || []) {
    const alpha = Number(color?.[3]);
    assert.ok(
      !Array.isArray(color) || alpha <= 0 || Math.min(color[0], color[1], color[2]) < 245,
      `${label} should not paint visible white`,
    );
  }
}

function legendStopColorsAtValue(scale, value) {
  return legendStopColorsAt(scale.legendStops, (value - scale.min) / (scale.max - scale.min));
}

function assertDuplicateBreakExists(scale, value) {
  const colors = legendStopColorsAtValue(scale, value);
  assert.ok(colors.length >= 2, `${value} should have duplicate legend stops`);
  assert.notDeepEqual(colors[0], colors.at(-1), `${value} duplicate stops should create a visible hard break`);
  assert.deepEqual(rgbaAtValue(scale, value), colors.at(-1), `${value} should enter the upper color band`);
}

function assertDuplicateValueStopExists(scale, value) {
  const colors = valueStopColors(scale, value);
  assert.ok(colors.length >= 2, `${value} should have duplicate value stops`);
  assert.notDeepEqual(colors[0], colors.at(-1), `${value} duplicate value stops should create a visible hard break`);
}

function assertFloatGridClose(actual, expected, epsilon = 1e-6) {
  assert.equal(actual?.length, expected?.length);
  for (let index = 0; index < expected.length; index += 1) {
    if (Number.isNaN(expected[index])) {
      assert.equal(Number.isNaN(actual[index]), true, `index ${index} should be NaN`);
    } else {
      assert.ok(
        Math.abs(actual[index] - expected[index]) <= epsilon,
        `index ${index}: ${actual[index]} != ${expected[index]}`,
      );
    }
  }
}

test("NOAA planned color maps use generated public provenance and stable hashes", () => {
  assert.match(PLANNED_COLOR_MAPS.provenance, /First-party generic/i);
  assert.equal(PLANNED_COLOR_MAPS.sourceDirectory, undefined);
  for (const [mapKey, map] of Object.entries(PLANNED_COLOR_MAPS.maps)) {
    assert.match(map.sourceSha256 || "", /^[a-f0-9]{64}$/, `${mapKey} should record a stable generated hash`);
    assert.equal(map.sourceFile, undefined, `${mapKey} should not reference external palette source files`);
    if (map.types) {
      for (const [typeKey, type] of Object.entries(map.types)) {
        assert.ok(type.valueStops.length >= 2, `${mapKey}.${typeKey} should expose value stops`);
        assert.ok(type.normalizedRgbaStops.length >= 2, `${mapKey}.${typeKey} should expose normalized stops`);
      }
    } else {
      assert.ok(map.valueStops.length >= 2, `${mapKey} should expose value stops`);
      assert.ok(map.normalizedRgbaStops.length >= 2, `${mapKey} should expose normalized stops`);
    }
  }
});

test("NOAA catalog scale palettes use generated public provenance and stable hashes", () => {
  const expectedScaleKeys = [
    "pressureHpa",
    "heightFt",
    "heightContourDam",
    "cape",
    "cin",
    "helicity",
    "pwat",
    "pblHeight",
    "cloudCeilingFt",
    "height250m",
    "height500m",
    "height700m",
    "height850m",
    "snowWaterEqIn",
    "hailSizeIn",
  ];

  assert.match(CATALOG_SCALE_PALETTES.provenance, /First-party generated public/i);
  assert.equal(CATALOG_SCALE_PALETTES.sourceDirectory, undefined);
  for (const scaleKey of expectedScaleKeys) {
    const scale = CATALOG_SCALE_PALETTES.scales[scaleKey];
    assert.ok(scale, `${scaleKey} should be generated`);
    assert.match(scale.sourceSha256 || "", /^[a-f0-9]{64}$/, `${scaleKey} should record a stable generated hash`);
    assert.equal(scale.sourceFile, undefined, `${scaleKey} should not reference external palette source files`);
    assert.ok(scale.valueStops.length >= 2, `${scaleKey} should expose value stops`);
    assert.ok(scale.normalizedRgbaStops.length >= 2, `${scaleKey} should expose normalized stops`);
    assert.deepEqual(SCALES[scaleKey].legendStops, scale.normalizedRgbaStops, `${scaleKey} catalog scale`);
  }
});

test("NOAA supplied planned palettes never render visible white as paint", () => {
  for (const scaleKey of [
    "stormRelativeHelicityM2S2",
    "updraftHelicity2to5kmM2S2",
    "absoluteVorticity1e5S1",
    "relativeVorticity1e5S1",
    "verticalVelocityDPaS",
    "frontogenesisCPer100Km3Hr",
    "lapseRateCKm",
    "capeJkg",
    "dcapeJkg",
    "cinJkg",
    "freezingRainIceIn",
    "framIceIn",
    "significantTornadoParameter",
    "supercellCompositeParameter",
    "surfaceThetaEK",
    "surfaceBasedLclM",
  ]) {
    assertNoPaintedWhite(SCALES[scaleKey], scaleKey);
  }
});

function duplicateLegendStopPositions(stops) {
  const counts = new Map();
  for (const [position] of stops || []) {
    counts.set(position, (counts.get(position) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([position]) => position);
}

function normalizeSegments(segments) {
  return (segments || []).map((segment) => ({
    x0: Number(segment.x0.toFixed(6)),
    y0: Number(segment.y0.toFixed(6)),
    x1: Number(segment.x1.toFixed(6)),
    y1: Number(segment.y1.toFixed(6)),
  }));
}

test("NOAA fast scalar renderer preserves values when no affine transform is requested", () => {
  const colorLookup = _testCreateContinuousColorLookup({
    stops: [
      [0, [0, 0, 255]],
      [1, [255, 0, 0]],
    ],
    min: 0,
    max: 100,
    alpha: 1,
    size: 16,
  });
  const layer = _testRenderScalarGrid({
    values: new Float32Array([0, 50, 100]),
    width: 3,
    height: 1,
    colorLookup,
    minVisible: null,
    maxVisible: null,
    visibleRange: null,
  });

  assert.equal(layer.visibleCount, 3);
  const pixels = [
    Array.from(layer.rgba.subarray(0, 4)),
    Array.from(layer.rgba.subarray(4, 8)),
    Array.from(layer.rgba.subarray(8, 12)),
  ];
  assert.notDeepEqual(pixels[0], pixels[1]);
  assert.notDeepEqual(pixels[1], pixels[2]);
  assert.ok(pixels[0][2] > pixels[0][0], "lowest value should use the blue end of the palette");
  assert.ok(pixels[2][0] > pixels[2][2], "highest value should use the red end of the palette");
});

test("NOAA continuous color interpolation preserves hue through transparent stops", () => {
  const yellowFade = _testCreateContinuousColorLookup({
    stops: [
      [0, [0, 0, 0, 0]],
      [1, [255, 230, 0, 1]],
    ],
    min: 0,
    max: 1,
    alpha: 1,
    size: 257,
  });
  const yellowPixels = _testRenderScalarGrid({
    values: new Float32Array([0.1, 0.5]),
    width: 2,
    height: 1,
    colorLookup: yellowFade,
  }).rgba;
  assert.ok(yellowPixels[0] > 240 && yellowPixels[1] > 200 && yellowPixels[2] < 20);
  assert.ok(yellowPixels[3] > 0 && yellowPixels[3] < 40);
  assert.ok(yellowPixels[4] > 240 && yellowPixels[5] > 200 && yellowPixels[6] < 20);
  assert.ok(yellowPixels[7] > 120 && yellowPixels[7] < 140);

  const grayFade = _testCreateContinuousColorLookup({
    stops: [
      [0, [0, 0, 0, 0]],
      [1, [0, 0, 0, 0.5]],
    ],
    min: 0,
    max: 1,
    alpha: 1,
    size: 257,
  });
  const grayPixels = _testRenderScalarGrid({
    values: new Float32Array([0.1]),
    width: 1,
    height: 1,
    colorLookup: grayFade,
  }).rgba;
  assert.deepEqual(Array.from(grayPixels.slice(0, 3)), [0, 0, 0]);
  assert.ok(grayPixels[3] > 0 && grayPixels[3] < 20);
});

test("NOAA height contour levels honor meteorological dam intervals", () => {
  assert.deepEqual(_testBuildHeightContourLevels(546.2, 579.8, 6), [552, 558, 564, 570, 576]);
  assert.deepEqual(_testBuildHeightContourLevels(142.1, 159.9, 3), [144, 147, 150, 153, 156, 159]);
  assert.deepEqual(_testBuildHeightContourLevels(900.1, 936.1, 12), [912, 924, 936]);
});

test("NOAA compact vector encoding keeps contour points app-readable", () => {
  const line = encodeVectorLine(
    {
      kind: "height-500-major",
      value: 552,
      color: "#171717",
      width: 1.45,
      alpha: 0.82,
    },
    [
      [41.123456, -95.987654],
      [41.223456, -95.887654],
      [41.323456, -95.787654],
    ],
  );

  assert.equal(line.points, undefined);
  assert.equal(line.pointEncoding, "polyline5");
  assert.ok(line.encodedPoints.length > 0);

  const decoded = decodeVectorLinePoints(line);
  assert.equal(decoded.length, 3);
  assert.ok(Math.abs(decoded[0][0] - 41.123456) < 1e-4);
  assert.ok(Math.abs(decoded[0][1] + 95.987654) < 1e-4);
  assert.ok(Math.abs(decoded[2][0] - 41.323456) < 1e-4);
  assert.ok(Math.abs(decoded[2][1] + 95.787654) < 1e-4);
});

test("NOAA multi-level marching squares matches per-level generation", () => {
  const width = 6;
  const height = 5;
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      values[y * width + x] = x * 0.95 + y * 0.7 + Math.sin((x + y) * 0.6) * 0.35;
    }
  }
  const levels = [1, 2, 3, 4, 5];
  const segmentsByLevel = _testMarchingSquaresMany(values, width, height, levels);
  for (const level of levels) {
    assert.deepEqual(
      normalizeSegments(segmentsByLevel.get(level) || []),
      normalizeSegments(_testMarchingSquares(values, width, height, level)),
      `level ${level} should match the single-level contour pass`,
    );
  }
});

test("NOAA height contour smoothing defaults to the simple isobar detail path", () => {
  const cols = 128;
  const rows = 96;
  const values = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      values[y * cols + x] = 500 + x * 0.45 + y * 0.18 + Math.sin(x * 0.7) * 2.5;
    }
  }
  const base = {
    heightGrid: { values, cols, rows },
    targetBounds: { north: 55, south: 20, west: -130, east: -60 },
    width: 1024,
    height: 768,
    modelKey: "gfs",
    levelMb: 500,
    intervalDam: 6,
    drawImage: false,
    style: {
      styleVersion: "test-height-contours",
      smoothing: {
        mslpSigmaKmByModel: { gfs: 60 },
      },
    },
  };

  const implicitSimple = _testRenderHeightContourArtifacts(base);
  const explicitSimple = _testRenderHeightContourArtifacts({ ...base, detailMode: "simple" });
  const detailed = _testRenderHeightContourArtifacts({ ...base, detailMode: "detailed" });
  const countPoints = (artifact) =>
    (artifact.vector?.lines || []).reduce((sum, line) => sum + decodeVectorLinePoints(line).length, 0);

  assert.ok(countPoints(implicitSimple) > 0, "synthetic height field should generate contours");
  assert.ok(implicitSimple.vector.lines.some((line) => line.encodedPoints && !line.points));
  assert.equal(countPoints(implicitSimple), countPoints(explicitSimple));
  assert.ok(countPoints(implicitSimple) < countPoints(detailed));
});

test("precip-type reflectivity palette keeps the opacity-aware ramp", () => {
  assert.match(REFLECTIVITY_PRECIP_TYPE_COLORS.provenance || "", /First-party generic/i);

  for (const type of Object.values(REFLECTIVITY_PRECIP_TYPE_COLORS.precipTypes || {})) {
    let previousAlpha = 0;
    let hasTranslucentDataBin = false;

    for (const bin of type.bins || []) {
      if (bin.belowFilter) {
        assert.equal(bin.webColor.alpha, 0);
        continue;
      }

      const alpha = Number(bin.webColor.alpha);
      assert.ok(alpha > 0 && alpha <= 1, `${type.displayName} ${bin.label} alpha should be visible`);
      assert.ok(alpha >= previousAlpha, `${type.displayName} ${bin.label} alpha should not decrease`);
      hasTranslucentDataBin ||= alpha < 1;
      previousAlpha = alpha;
    }

    assert.ok(hasTranslucentDataBin, `${type.displayName} should retain translucent early bins`);
  }

  const legend = getNoaaNamParameterMetadata().reflectivity1kmPrecipType.precipTypeLegend;
  const rainFirstVisible = legend.find((row) => row.key === "rain").bins.find((bin) => bin.minDbz === 10);
  const sourceRainFirstVisible = REFLECTIVITY_PRECIP_TYPE_COLORS.precipTypes.rain.bins.find(
    (bin) => bin.minDbzInclusive === 10,
  );
  assert.deepEqual(rainFirstVisible.color, [
    ...sourceRainFirstVisible.webColor.rgb,
    sourceRainFirstVisible.webColor.alpha,
  ]);
});

test("precip-type reflectivity clamps values above the top bin to the last color", () => {
  const lookups = _testBuildReflectivityPrecipTypeLookups(REFLECTIVITY_PRECIP_TYPE_COLORS);

  for (const [typeKey, type] of Object.entries(REFLECTIVITY_PRECIP_TYPE_COLORS.precipTypes || {})) {
    const lookup = lookups[typeKey];
    const offset = _testFindReflectivityPrecipTypeColorOffset(lookup, 75);
    const lastBin = type.bins.at(-1);

    assert.equal(offset, (lookup.count - 1) * 4, `${type.displayName} should use the last bin above max`);
    assert.deepEqual(Array.from(lookup.colors.slice(offset, offset + 4)), [
      lastBin.webColor.rgb[0],
      lastBin.webColor.rgb[1],
      lastBin.webColor.rgb[2],
      Math.round(lastBin.webColor.alpha * 255),
    ]);
  }
});

test("precipitation-rate type renderer reuses direct PRATE and categorical masks", () => {
  const lookups = _testBuildPrecipRateTypeLookups(PLANNED_COLOR_MAPS.maps.precipRateByTypeInHr);
  const offset = _testFindStepColorOffset(lookups.rain, 0.1);

  assert.ok(offset >= 0);
  assert.ok(lookups.rain.colors[offset + 3] > 0);

  const prateForPointOneInHr = (0.1 * 25.4) / 3600;
  const layer = _testRenderPrecipRateTypeGrid({
    precipRate: new Float32Array([
      prateForPointOneInHr,
      prateForPointOneInHr,
      prateForPointOneInHr,
      prateForPointOneInHr,
    ]),
    rain: new Float32Array([1, 0, 0, 0]),
    snow: new Float32Array([0, 1, 0, 0]),
    freezingRain: new Float32Array([0, 0, 1, 0]),
    sleet: new Float32Array([0, 0, 0, 1]),
    width: 4,
    height: 1,
  });

  assert.equal(layer.visibleCount, 4);
  assert.notDeepEqual(Array.from(layer.rgba.subarray(0, 4)), Array.from(layer.rgba.subarray(4, 8)));
  assert.notDeepEqual(Array.from(layer.rgba.subarray(4, 8)), Array.from(layer.rgba.subarray(8, 12)));
});

test("NOAA precip-rate type requires direct PRATE instead of APCP fallback", () => {
  const rows = [
    "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
    "2.1:100:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
    "2.2:100:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
    "3:200:d=2026042512:APCP:surface:0-3 hour acc fcst:",
    "4:300:d=2026042512:CRAIN:surface:3 hour fcst:",
    "5:400:d=2026042512:CSNOW:surface:3 hour fcst:",
    "6:500:d=2026042512:CFRZR:surface:3 hour fcst:",
    "7:600:d=2026042512:CICEP:surface:3 hour fcst:",
  ];
  const selection = selectNoaaNamParameterRecords(parseNoaaIdx(rows.join("\n"), 800), {
    modelKey: "hrrr",
    targetHour: 3,
  });

  assert.ok(!selection.availableParameters.includes("precipRateAndType"));
});

test("NOAA derived grids do not synthesize precip-rate type from APCP", () => {
  const precipRecord = parseNoaaIdx("1:0:d=2026042512:APCP:surface:0-3 hour acc fcst:", 100)[0];
  const grids = _testBuildDerivedParameterGrids({
    decoded: {
      precip: new Float32Array([25.4]),
    },
    selection: {
      availableParameters: ["precipRateAndType"],
      records: { precip: precipRecord },
    },
    bounds: { west: -105, east: -104, south: 39, north: 40 },
    width: 1,
    height: 1,
  });

  assert.equal(grids.precipRate, undefined);
});

test("supplied palettes preserve clean hard threshold color breaks", () => {
  assertDuplicateValueStopExists(COLOR_MAPS.temperatureF, 32);
  assertDuplicateValueStopExists(COLOR_MAPS.temperature850C, 0);
  assertDuplicateValueStopExists(COLOR_MAPS.temperature700C, 0);
  assertDuplicateValueStopExists(COLOR_MAPS.temperature500C, -20);
  assert.equal(valueStopColors(COLOR_MAPS.temperatureF, 32).length, 2);
  assert.equal(valueStopColors(COLOR_MAPS.temperature850C, 0).length, 2);
  assert.equal(valueStopColors(COLOR_MAPS.temperature700C, 0).length, 2);
  assert.equal(valueStopColors(COLOR_MAPS.temperature500C, -20).length, 2);
  for (const value of [50, 60, 70, 80]) {
    assertDuplicateValueStopExists(COLOR_MAPS.dewPointF, value);
    assert.equal(valueStopColors(COLOR_MAPS.dewPointF, value).length, 2);
  }
  for (const value of [1, 3, 6, 10]) {
    assertDuplicateValueStopExists(COLOR_MAPS.visibilityMi, value);
    assert.equal(valueStopColors(COLOR_MAPS.visibilityMi, value).length, 2);
  }

  for (const value of [1, 6, 12, 24, 36]) {
    const colors = legendStopColorsAt(SCALES.snowfallIn.legendStops, value / 60);
    assert.ok(colors.length >= 2, `${value} inches should have duplicate snowfall legend stops`);
    assert.notDeepEqual(colors[0], colors.at(-1), `${value} inches should create a hard category break`);
  }
  assert.deepEqual(duplicateLegendStopPositions(SCALES.snowfallIn.legendStops), [
    1 / 60,
    6 / 60,
    12 / 60,
    24 / 60,
    36 / 60,
  ]);
});

test("NOAA categorical Mercator row remap preserves precip-type masks", () => {
  const width = 2;
  const height = 5;
  const bounds = { north: 50, south: 20, west: -130, east: -60 };
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    values[row * width] = row < 2 ? 0 : 1;
    values[row * width + 1] = row < 2 ? 0 : 1;
  }

  const bilinear = _testRemapSouthNorthLinearLatGridToMercatorRows(values, width, height, bounds, "bilinear");
  const nearest = _testRemapSouthNorthLinearLatGridToMercatorRows(values, width, height, bounds, "nearest");

  assert.ok(
    Array.from(bilinear).some((value) => value > 0 && value < 1),
    "bilinear row remap blends binary masks near category boundaries",
  );
  assert.ok(
    Array.from(nearest).every((value) => value === 0 || value === 1),
    "nearest row remap keeps masks categorical",
  );
});

test("NOAA regrid args keep categorical precip-type masks on nearest-neighbor interpolation", () => {
  const args = _testBuildNoaaRegridArgs({
    gribPath: "input.grib2",
    gridPath: "output.grib2",
    bounds: { west: -130, east: -60, south: 20, north: 55 },
    width: 8,
    height: 5,
    useCategoricalPrecipTypeInterpolation: true,
  });
  const joined = args.join(" ");

  assert.match(joined, /-new_grid_interpolation bilinear/);
  assert.match(joined, /-if :\(CRAIN\|CSNOW\|CFRZR\|CICEP\): -new_grid_interpolation neighbor -fi/);
  assert.ok(args.indexOf("-fi") < args.indexOf("-new_grid"));

  const single = _testBuildNoaaRegridArgs({
    gribPath: "input.grib2",
    recordIndex: 4,
    gridPath: "output.grib2",
    bounds: { west: -130, east: -60, south: 20, north: 55 },
    width: 8,
    height: 5,
    interpolation: "neighbor",
  });

  assert.deepEqual(single.slice(0, 7), [
    "input.grib2",
    "-d",
    "4",
    "-new_grid_winds",
    "earth",
    "-new_grid_interpolation",
    "neighbor",
  ]);
});

test("NOAA snow-liquid decodes can keep precipitation masks fractional", () => {
  const args = _testBuildNoaaRegridArgs({
    gribPath: "input.grib2",
    gridPath: "output.grib2",
    bounds: { west: -130, east: -60, south: 20, north: 55 },
    width: 8,
    height: 5,
    useCategoricalPrecipTypeInterpolation: false,
  });
  const joined = args.join(" ");

  assert.match(joined, /-new_grid_interpolation bilinear/);
  assert.doesNotMatch(joined, /-new_grid_interpolation neighbor/);
});

test("NOAA idx parser resolves byte ranges and record metadata", () => {
  const records = parseNoaaIdx(SAMPLE_IDX, 1500);

  assert.equal(records.length, 44);
  assert.equal(records[0].record, "1");
  assert.equal(records[0].param, "PRMSL");
  assert.equal(records[0].level, "mean sea level");
  assert.equal(records[0].rangeHeader, "bytes=0-99");
  assert.equal(records.find((record) => record.record === "325.1").rangeHeader, "bytes=1000-1239");
  assert.equal(records.find((record) => record.record === "325.2").rangeHeader, "bytes=1000-1239");
  assert.equal(records.at(-1).rangeHeader, "bytes=1460-1499");
});

test("NOAA NAM expanded catalog selectors and metadata expose app-ready parameters", () => {
  const records = parseNoaaIdx(SAMPLE_IDX, 1500);
  const selection = selectNoaaNamParameterRecords(records);
  const metadata = getNoaaNamParameterMetadata();
  const order = getNoaaNamParameterOrder();

  assert.deepEqual(selection.missingRequired, []);
  assert.equal(selection.records.dewpoint2m.record, "323");
  assert.equal(selection.records.specificHumidity2m, undefined);
  assert.equal(selection.records.surfacePressure, undefined);
  assert.equal(selection.records.liftedIndex, undefined);
  assert.equal(selection.records.bestLiftedIndex, undefined);
  assert.equal(selection.records.height300.record, "86");
  assert.equal(selection.records.wind300U.record, "91.1");
  assert.equal(selection.records.wind300V.record, "91.2");
  assert.equal(selection.records.wind500U.record, "123.1");
  assert.equal(selection.records.wind500V.record, "123.2");
  assert.equal(selection.records.wind80mU.record, "359.1");
  assert.equal(selection.records.wind80mV.record, "359.2");
  assert.equal(selection.records.reflectivityComposite.record, "3");
  assert.equal(selection.records.reflectivity1km.record, "4");
  assert.ok(selection.availableParameters.includes("dewpoint2m"));
  assert.ok(selection.availableParameters.includes("height300"));
  assert.ok(selection.availableParameters.includes("wind300"));
  assert.ok(selection.availableParameters.includes("wind500"));
  assert.ok(selection.availableParameters.includes("precip"));
  assert.equal(selection.records.precip, undefined);
  assert.ok(selection.availableParameters.includes("reflectivityComposite"));
  assert.ok(selection.availableParameters.includes("reflectivity1km"));
  assert.ok(selection.availableParameters.includes("reflectivity1kmPrecipType"));
  assert.ok(selection.availableParameters.includes("sbcape"));
  assert.ok(selection.availableParameters.includes("sbcin"));
  assert.ok(selection.availableParameters.includes("srh0to3km"));
  assert.ok(selection.availableParameters.includes("snow10to1"));
  assert.ok(!selection.availableParameters.includes("snowKuchera"));
  assert.ok(!selection.availableParameters.includes("snowCobb"));
  assert.ok(!selection.availableParameters.includes("snowRfConus"));
  assert.equal(selection.records.precipTypeRain.record, "333");
  assert.equal(selection.records.precipTypeSnow.record, "330");
  assert.equal(selection.records.precipTypeFreezingRain.record, "334");
  assert.equal(selection.records.precipTypeIcePellets.record, "335");
  assert.equal(selection.records.precipTypeSnow.record, "330");
  assert.equal(metadata.dewpoint2m.group, "Surface & Boundary Layer");
  assert.equal(metadata.specificHumidity2m, undefined);
  assert.equal(metadata.surfacePressure, undefined);
  assert.equal(metadata.liftedIndex, undefined);
  assert.equal(metadata.bestLiftedIndex, undefined);
  assert.equal(metadata.cloudBaseHeight, undefined);
  assert.equal(metadata.freezingLevel, undefined);
  assert.equal(metadata.snowCover, undefined);
  assert.equal(metadata.absoluteVorticity850, undefined);
  assert.equal(metadata.verticalVelocity850, undefined);
  assert.equal(metadata.stormMotionVectors, undefined);
  assert.equal(metadata.simulatedIrProxy, undefined);
  assert.equal(metadata.temp250, undefined);
  assert.equal(metadata.temp300, undefined);
  assert.equal(metadata.rh250, undefined);
  assert.equal(metadata.rh300, undefined);
  assert.equal(metadata.cape, undefined);
  assert.equal(metadata.cin, undefined);
  assert.equal(metadata.helicity03km, undefined);
  assert.equal(metadata.sbcape.label, "SBCAPE");
  assert.equal(metadata.sbcape.group, "Severe: Thermodynamics");
  assert.equal(metadata.sbcin.label, "SBCIN");
  assert.equal(metadata.srh0to3km.label, "0-3 km SRH");
  assert.equal(metadata.srh0to3km.group, "Severe: Kinematics");
  assert.equal(metadata.precipRateAndType.legendType, "precip-rate-type");
  assert.equal(metadata.precipRateAndType.group, "Precipitation");
  assert.ok(metadata.precipRateAndType.precipRateTypeLegend.length >= 4);
  assert.equal(metadata.reflectivityComposite.group, "Radar");
  assert.equal(metadata.cloudCeiling.group, "Clouds & Ceiling");
  assert.equal(metadata.height300.legendType, "height-contour");
  assert.equal(metadata.height300.group, "Upper Air: Height / Wind / Temp");
  assert.equal(metadata.height300.contourIntervalDam, 12);
  assert.equal(metadata.height300.contourLevelMb, 300);
  assert.equal(metadata.height300.unit, "dam");
  assert.equal(metadata.wind500.unit, "kt");
  assert.equal(metadata.absoluteVorticity500.group, "Upper Air: Omega / Vorticity");
  assert.equal(metadata.verticalVelocity500.group, "Upper Air: Omega / Vorticity");
  assert.equal(metadata.snow10to1.group, "Winter / Snow & Ice");
  assert.equal(metadata.snow10to1.methodVersion, "snow10to1-v1");
  assert.equal(metadata.snowKuchera.methodVersion, "kuchera-surface-to-500mb-profile-v2");
  assert.equal(metadata.snowCobb.methodVersion, "cobb-waldstreicher-925to300mb-profile-v2");
  assert.equal(metadata.snowRfConus.artifactRequired, "snow-rf/conus-rf.json");
  assert.equal(metadata.snowWesternLinear.artifactRequired, "snow-rf/western-linear-v1c.json");
  assert.match(metadata.snowWesternLinear.applicability, /HRRR western elevated terrain/);
  assert.ok(order.indexOf("temperature") < order.indexOf("dewpoint2m"));
  assert.ok(order.includes("absoluteVorticity500"));
  assert.ok(order.includes("verticalVelocity500"));
  assert.ok(!order.includes("absoluteVorticity850"));
  assert.ok(!order.includes("verticalVelocity850"));
  assert.ok(!order.includes("simulatedIrProxy"));
});

test("NOAA snowfall selector does not advertise APCP-derived snow without complete phase masks", () => {
  const baseRows = [
    "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
    "2.1:100:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
    "2.2:100:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
  ];
  const incomplete = selectNoaaNamParameterRecords(
    parseNoaaIdx(
      [
        ...baseRows,
        "3:200:d=2026042512:APCP:surface:0-3 hour acc fcst:",
        "4:300:d=2026042512:CSNOW:surface:3 hour fcst:",
      ].join("\n"),
      500,
    ),
    { modelKey: "hrrr", targetHour: 3 },
  );
  const directSnowWater = selectNoaaNamParameterRecords(
    parseNoaaIdx([...baseRows, "3:200:d=2026042512:WEASD:surface:0-3 hour acc fcst:"].join("\n"), 400),
    { modelKey: "hrrr", targetHour: 3 },
  );

  assert.ok(!incomplete.availableParameters.includes("snow10to1"));
  assert.ok(directSnowWater.availableParameters.includes("snow10to1"));
});

test("NOAA snowfall profile selectors honor complete-profile requirements", () => {
  const rows = [
    "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
    "2.1:100:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
    "2.2:100:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
    "3:200:d=2026042512:WEASD:surface:0-3 hour acc fcst:",
    "4:300:d=2026042512:HGT:850 mb:3 hour fcst:",
    "5:400:d=2026042512:TMP:850 mb:3 hour fcst:",
    "6:500:d=2026042512:RH:850 mb:3 hour fcst:",
    "7:600:d=2026042512:VVEL:850 mb:3 hour fcst:",
  ];
  const selection = selectNoaaNamParameterRecords(parseNoaaIdx(rows.join("\n"), 800), {
    modelKey: "hrrr",
    targetHour: 3,
  });

  assert.ok(selection.availableParameters.includes("snow10to1"));
  assert.ok(!selection.availableParameters.includes("snowKuchera"));
  assert.ok(!selection.availableParameters.includes("snowCobb"));
});

test("NOAA direct planned parameters use model gates and staged palettes", () => {
  const rows = [
    "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
    "2.1:100:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
    "2.2:100:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
    "3:200:d=2026042512:ABSV:500 mb:3 hour fcst:",
    "4:300:d=2026042512:VVEL:500 mb:3 hour fcst:",
    "5:400:d=2026042512:ABSV:700 mb:3 hour fcst:",
    "6:500:d=2026042512:VVEL:700 mb:3 hour fcst:",
    "7:600:d=2026042512:ABSV:850 mb:3 hour fcst:",
    "8:700:d=2026042512:VVEL:850 mb:3 hour fcst:",
    "9:800:d=2026042512:PRATE:surface:3 hour fcst:",
    "10:900:d=2026042512:CRAIN:surface:3 hour fcst:",
    "11:1000:d=2026042512:CSNOW:surface:3 hour fcst:",
    "12:1100:d=2026042512:CFRZR:surface:3 hour fcst:",
    "13:1200:d=2026042512:CICEP:surface:3 hour fcst:",
    "14:1300:d=2026042512:HGT:cloud ceiling:3 hour fcst:",
    "15:1400:d=2026042512:HAIL:entire atmosphere:3 hour fcst:",
    "16:1500:d=2026042512:HLCY:3000-0 m above ground:3 hour fcst:",
    "17:1600:d=2026042512:HLCY:1000-0 m above ground:3 hour fcst:",
    "18:1700:d=2026042512:CAPE:surface:3 hour fcst:",
    "19:1800:d=2026042512:CIN:surface:3 hour fcst:",
    "20:1900:d=2026042512:CAPE:90-0 mb above ground:3 hour fcst:",
    "21:2000:d=2026042512:CIN:90-0 mb above ground:3 hour fcst:",
    "22:2100:d=2026042512:CAPE:255-0 mb above ground:3 hour fcst:",
    "23:2200:d=2026042512:HGT:level of adiabatic condensation from sfc:3 hour fcst:",
    "24:2300:d=2026042512:MXUPHL:5000-2000 m above ground:2-3 hour max fcst:",
    "27:2600:d=2026042512:FRZR:surface:0-3 hour acc fcst:",
    "28:2700:d=2026042512:WEASD:surface:0-3 hour acc fcst:",
    "29:2800:d=2026042512:HGT:500 mb:3 hour fcst:",
    "30:2900:d=2026042512:TMP:500 mb:3 hour fcst:",
    "31:3000:d=2026042512:RH:500 mb:3 hour fcst:",
    "32:3100:d=2026042512:HGT:surface:3 hour fcst:",
  ];
  const hrrrSelection = selectNoaaNamParameterRecords(parseNoaaIdx(rows.join("\n"), 3400), { modelKey: "hrrr" });
  const namSelection = selectNoaaNamParameterRecords(parseNoaaIdx(rows.join("\n"), 3400), { modelKey: "nam" });
  const directKeys = [
    "absoluteVorticity500",
    "absoluteVorticity700",
    "verticalVelocity500",
    "verticalVelocity700",
    "precipRateAndType",
    "cloudCeiling",
    "maxSimulatedHailSize",
    "srh0to1km",
    "srh0to3km",
    "sbcape",
    "sbcin",
    "mlcape",
    "mlcin",
    "mucape",
    "surfaceBasedLclHeight",
    "updraftHelicity2to5km1h",
    "freezingRainLiquidTotal",
  ];

  for (const key of directKeys) {
    assert.ok(hrrrSelection.availableParameters.includes(key), `${key} should be direct on HRRR fixture`);
  }
  assert.equal(hrrrSelection.records.profileSurfaceHeight.record, "32");
  assert.ok(namSelection.availableParameters.includes("absoluteVorticity500"));
  assert.ok(namSelection.availableParameters.includes("verticalVelocity500"));
  assert.ok(!hrrrSelection.availableParameters.includes("absoluteVorticity850"));
  assert.ok(!hrrrSelection.availableParameters.includes("verticalVelocity850"));
  assert.ok(namSelection.availableParameters.includes("srh0to3km"));
  assert.ok(!namSelection.availableParameters.includes("precipRateAndType"));
  assert.equal(_testStandardProfileDecodeKey("VVEL", 500), "verticalVelocity500");

  const metadata = getNoaaNamParameterMetadata();
  assertBrightStopsBecomeOpacityRamp(
    PLANNED_COLOR_MAPS.maps.absoluteVorticity1e5S1.normalizedRgbaStops,
    metadata.absoluteVorticity500.legendStops,
  );
  assertBrightStopsBecomeOpacityRamp(
    PLANNED_COLOR_MAPS.maps.verticalVelocityDPaS.normalizedRgbaStops,
    metadata.verticalVelocity500.legendStops,
  );
  const omegaZeroPosition =
    (0 - PLANNED_COLOR_MAPS.maps.verticalVelocityDPaS.min) /
    (PLANNED_COLOR_MAPS.maps.verticalVelocityDPaS.max - PLANNED_COLOR_MAPS.maps.verticalVelocityDPaS.min);
  for (const color of legendStopColorsAt(metadata.verticalVelocity500.legendStops, omegaZeroPosition)) {
    assert.deepEqual(color, [0, 0, 0, 0]);
  }
  assertNoPaintedWhite(SCALES.verticalVelocityDPaS, "vertical velocity");
  for (const [position, color] of metadata.verticalVelocity500.legendStops) {
    if (position > omegaZeroPosition + 1e-6) {
      assert.deepEqual(color.slice(0, 3), [0, 0, 0]);
    }
  }
  const relativeVorticityZeroPosition =
    (0 - SCALES.relativeVorticity1e5S1.min) / (SCALES.relativeVorticity1e5S1.max - SCALES.relativeVorticity1e5S1.min);
  const relativeVorticityZeroColors = legendStopColorsAt(
    metadata.relativeVorticity500.legendStops,
    relativeVorticityZeroPosition,
  );
  assert.equal(relativeVorticityZeroColors.length, 2);
  assert.ok(relativeVorticityZeroColors.every((color) => color[3] === 0));
  assert.equal(SCALES.relativeVorticity1e5S1.alpha, 1);
  assert.equal(SCALES.relativeVorticity1e5S1.thresholdNote, "0 transparent; weak values fade from zero");
  assertNoPaintedWhite(SCALES.relativeVorticity1e5S1, "relative vorticity");
  const relVortLookup = _testCreateContinuousColorLookup({
    stops: metadata.relativeVorticity500.legendStops,
    min: SCALES.relativeVorticity1e5S1.min,
    max: SCALES.relativeVorticity1e5S1.max,
    alpha: 1,
  });
  const relVortPixels = _testRenderScalarGrid({
    values: new Float32Array([-0.1, 0, 0.1, 0.6, 2.5]),
    width: 5,
    height: 1,
    colorLookup: relVortLookup,
  }).rgba;
  assert.deepEqual(Array.from(relVortPixels.slice(0, 3)), [0, 0, 0]);
  assert.ok(relVortPixels[3] > 0 && relVortPixels[3] < 8);
  assert.equal(relVortPixels[7], 0);
  assert.ok(relVortPixels[8] > 0 || relVortPixels[9] > 0 || relVortPixels[10] > 0);
  assert.ok(relVortPixels[11] > 0 && relVortPixels[11] < 24);
  assert.ok(relVortPixels[12] > 0 || relVortPixels[13] > 0 || relVortPixels[14] > 0);
  assert.ok(relVortPixels[15] > 30);
  assert.ok(relVortPixels[16] > 0 || relVortPixels[17] > 0 || relVortPixels[18] > 0);
  assert.ok(relVortPixels[19] > relVortPixels[15]);

  assert.equal(SCALES.lapseRateCKm.minVisible, null);
  assert.equal(SCALES.lapseRateCKm.alpha, 1);
  assertNoPaintedWhite(SCALES.lapseRateCKm, "lapse rate");
  for (const value of [7, 8, 9]) {
    assertDuplicateBreakExists(SCALES.lapseRateCKm, value);
  }
  const lapseLookup = _testCreateContinuousColorLookup({
    stops: metadata.lapseRate700to500.legendStops,
    min: SCALES.lapseRateCKm.min,
    max: SCALES.lapseRateCKm.max,
    alpha: SCALES.lapseRateCKm.alpha,
  });
  const lapsePixels = _testRenderScalarGrid({
    values: new Float32Array([0, 3, 6]),
    width: 3,
    height: 1,
    colorLookup: lapseLookup,
  }).rgba;
  assert.equal(lapsePixels[3], 0);
  assert.ok(lapsePixels[7] > 0 && lapsePixels[7] < lapsePixels[11]);
  assert.equal(lapsePixels[11], 255);
  assert.ok(lapsePixels[8] < lapsePixels[9]);
  assert.ok(lapsePixels[10] > lapsePixels[8]);
  assert.equal(SCALES.updraftHelicity2to5kmM2S2.minVisible, null);
  assert.equal(SCALES.updraftHelicity2to5kmM2S2.alpha, 1);
  for (const value of [50, 100, 150, 200, 300]) {
    assertDuplicateBreakExists(SCALES.updraftHelicity2to5kmM2S2, value);
  }
  const uhLookup = _testCreateContinuousColorLookup({
    stops: SCALES.updraftHelicity2to5kmM2S2.legendStops,
    min: SCALES.updraftHelicity2to5kmM2S2.min,
    max: SCALES.updraftHelicity2to5kmM2S2.max,
    alpha: SCALES.updraftHelicity2to5kmM2S2.alpha,
    size: 65536,
  });
  const uhPixels = _testRenderScalarGrid({
    values: new Float32Array([0, 5, 20, 25]),
    width: 4,
    height: 1,
    colorLookup: uhLookup,
  }).rgba;
  assert.equal(uhPixels[3], 0);
  assert.ok(uhPixels[7] > 0, "UH values under 25 should be visible through generated opacity ramp");
  assert.ok(uhPixels[11] > uhPixels[7]);
  assert.ok(uhPixels[15] > uhPixels[11]);
  assert.deepEqual(metadata.sbcape.legendStops, PLANNED_COLOR_MAPS.maps.capeJkg.normalizedRgbaStops);
  assert.deepEqual(metadata.sbcin.legendStops, PLANNED_COLOR_MAPS.maps.cinJkg.normalizedRgbaStops);
  assert.equal(
    NOAA_NAM_PARAMETER_CATALOG.find((entry) => entry.key === "stormMotionVectors"),
    undefined,
  );
});

test("NOAA derived planned parameters gate on source inputs and expose formula metadata", () => {
  const rows = [
    "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
    "2.1:100:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
    "2.2:100:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
    "3:200:d=2026042512:DPT:2 m above ground:3 hour fcst:",
    "4:300:d=2026042512:RH:2 m above ground:3 hour fcst:",
    "5:400:d=2026042512:HGT:surface:3 hour fcst:",
    "6:500:d=2026042512:PRMSL:mean sea level:3 hour fcst:",
    "7:600:d=2026042512:ABSV:500 mb:3 hour fcst:",
    "8:700:d=2026042512:ABSV:700 mb:3 hour fcst:",
    "9:800:d=2026042512:APCP:surface:0-3 hour acc fcst:",
    "10:900:d=2026042512:CFRZR:surface:3 hour fcst:",
    "10.1:910:d=2026042512:CSNOW:surface:3 hour fcst:",
    "10.2:920:d=2026042512:CRAIN:surface:3 hour fcst:",
    "10.3:930:d=2026042512:CICEP:surface:3 hour fcst:",
    "11:1000:d=2026042512:GUST:surface:3 hour fcst:",
    "12:1100:d=2026042512:MXUPHL:5000-2000 m above ground:2-3 hour max fcst:",
    "13:1200:d=2026042512:CAPE:90-0 mb above ground:3 hour fcst:",
    "14:1300:d=2026042512:CIN:90-0 mb above ground:3 hour fcst:",
    "15:1400:d=2026042512:CAPE:255-0 mb above ground:3 hour fcst:",
    "16:1500:d=2026042512:HLCY:1000-0 m above ground:3 hour fcst:",
    "17:1600:d=2026042512:HLCY:3000-0 m above ground:3 hour fcst:",
    "18:1700:d=2026042512:CAPE:surface:3 hour fcst:",
  ];
  for (const level of SNOW_PROFILE_LEVELS) {
    const base = 2000 + level;
    rows.push(
      `${base}.1:${base * 10}:d=2026042512:HGT:${level} mb:3 hour fcst:`,
      `${base}.2:${base * 10 + 1}:d=2026042512:TMP:${level} mb:3 hour fcst:`,
      `${base}.3:${base * 10 + 2}:d=2026042512:RH:${level} mb:3 hour fcst:`,
      `${base}.4:${base * 10 + 3}:d=2026042512:UGRD:${level} mb:3 hour fcst:`,
      `${base}.5:${base * 10 + 4}:d=2026042512:VGRD:${level} mb:3 hour fcst:`,
    );
  }

  const selection = selectNoaaNamParameterRecords(parseNoaaIdx(rows.join("\n"), 999999), {
    modelKey: "hrrr",
    targetHour: 3,
  });
  for (const key of [
    "surfaceThetaE",
    "lapseRate700to500",
    "lapseRate0to3km",
    "bulkShear0to6km",
    "effectiveBulkShear",
    "supercellCompositeParameter",
    "effectiveLayerSupercellCompositeParameter",
    "significantTornadoParameter",
    "effectiveLayerSignificantTornadoParameter",
    "dcape",
    "frontogenesis850",
    "frontogenesis700",
    "relativeVorticity700",
    "relativeVorticity500",
    "freezingRainLiquidTotal",
    "framFlatIce",
    "framRadialIce",
    "gustRunMax",
    "updraftHelicity2to5kmRunMax",
  ]) {
    assert.ok(selection.availableParameters.includes(key), `${key} should be gated available`);
  }

  const metadata = getNoaaNamParameterMetadata();
  assert.equal(metadata.surfaceThetaE.methodVersion, "bolton-thetae-v1");
  assert.match(metadata.surfaceThetaE.formulaReference, /Bolton/);
  assert.match(metadata.surfaceThetaE.sourceNote, /TMP at 2 m above ground/);
  assert.equal(metadata.lapseRate700to500.group, "Severe: Thermodynamics");
  assert.match(metadata.lapseRate0to3km.sourceNote, /Profile inputs: TMP\/HGT/);
  assert.equal(metadata.dcape.methodVersion, "reduced-profile-dcape-v4");
  assert.match(metadata.dcape.formulaReference, /pseudoadiabatic descent/);
  assert.match(metadata.dcape.sourceNote, /Profile inputs: TMP\/HGT\/RH at 1000, 925, 850, 700, 500, 300 mb/);
  assert.deepEqual(metadata.dcape.legendTicks, [0, 500, 1000, 1500, 2000, 2500]);
  assert.equal(SCALES.dcapeJkg.max, 2500);
  assert.equal(SCALES.dcapeJkg.minVisible, null);
  assert.deepEqual(metadata.bulkShear0to6km.legendStops, SCALES.wind500Kt.legendStops);
  assert.deepEqual(metadata.effectiveBulkShear.legendStops, SCALES.wind500Kt.legendStops);
  assert.equal(metadata.bulkShear0to6km.thresholdNote, "<20 kt transparent");
  assert.equal(
    metadata.effectiveBulkShear.thresholdNote,
    "Masked where effective inflow is absent; <20 kt transparent",
  );
  assert.equal(metadata.effectiveBulkShear.methodVersion, "spc-effective-inflow-gated-0-6km-v1");
  assert.match(metadata.effectiveBulkShear.derivation, /heuristic layer-top estimates are masked/);
  assert.equal(metadata.supercellCompositeParameter.label, "SCP (0-3 km Proxy)");
  assert.equal(metadata.supercellCompositeParameter.methodVersion, "scp-0to3km-srh-effective-shear-proxy-v1");
  assert.equal(metadata.effectiveLayerSupercellCompositeParameter.label, "SCP (Effective Layer)");
  assert.match(metadata.effectiveLayerSupercellCompositeParameter.sourceNote, /25\/50 mb spacing/);
  assert.equal(metadata.effectiveLayerSupercellCompositeParameter.methodVersion, "spc-effective-scp-parcel-sparse-v3");
  assert.equal(_testEffectiveParcelSourceStepHpa, 25);
  assert.match(metadata.effectiveLayerSupercellCompositeParameter.derivation, /50 mb spacing from 700-300 mb/);
  assert.match(metadata.effectiveLayerSupercellCompositeParameter.derivation, /fixed 0-6 km Bunkers fallback/);
  assert.equal(metadata.significantTornadoParameter.label, "STP (Fixed Layer)");
  assert.equal(metadata.significantTornadoParameter.methodVersion, "spc-fixed-layer-stp-v2");
  assert.match(metadata.significantTornadoParameter.derivation, /surface-based CAPE/);
  assert.equal(metadata.effectiveLayerSignificantTornadoParameter.label, "STP (Effective Layer)");
  assert.equal(metadata.effectiveLayerSignificantTornadoParameter.methodVersion, "spc-effective-stp-parcel-sparse-v3");
  assert.match(metadata.effectiveLayerSignificantTornadoParameter.derivation, /50 mb spacing from 700-300 mb/);
  assert.match(metadata.effectiveLayerSignificantTornadoParameter.derivation, /fixed 0-6 km Bunkers fallback/);
  assert.equal(metadata.gustRunMax.methodVersion, "run-max-gust-v2");
  assert.equal(metadata.updraftHelicity2to5kmRunMax.methodVersion, "run-max-interval-mxuphl-v2");
  assert.equal(metadata.updraftHelicity2to5kmRunMax.thresholdNote, "Low-end opacity ramp from generated palette");
  assert.equal(metadata.freezingRainLiquidTotal.accumulationMode, "total");
  assert.match(metadata.framRadialIce.derivation, /FRAM/);
  assert.equal(metadata.framRadialIce.thresholdNote, "FRAM accretion; trace opacity ramp from generated palette");
  const firstFramVisibleStop = SCALES.framIceIn.legendStops.find(([, color]) => Number(color?.[3]) > 0);
  assert.ok(firstFramVisibleStop, "FRAM ice scale should have visible stops");
  assert.deepEqual(firstFramVisibleStop[1].slice(0, 3), [130, 130, 130]);
});

test("NOAA filtered optional derived parameters do not leak staged profile records", () => {
  const rows = [
    "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
    "2.1:100:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
    "2.2:100:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
    "3:200:d=2026042512:DPT:2 m above ground:3 hour fcst:",
    "4:300:d=2026042512:HGT:surface:3 hour fcst:",
    "5:400:d=2026042512:CAPE:255-0 mb above ground:3 hour fcst:",
    "6.1:500:d=2026042512:HGT:1000 mb:3 hour fcst:",
    "6.2:501:d=2026042512:TMP:1000 mb:3 hour fcst:",
    "6.3:502:d=2026042512:RH:1000 mb:3 hour fcst:",
    "6.4:503:d=2026042512:UGRD:1000 mb:3 hour fcst:",
    "6.5:504:d=2026042512:VGRD:1000 mb:3 hour fcst:",
    "7.1:600:d=2026042512:HGT:975 mb:3 hour fcst:",
    "7.2:601:d=2026042512:TMP:975 mb:3 hour fcst:",
    "7.3:602:d=2026042512:RH:975 mb:3 hour fcst:",
    "7.4:603:d=2026042512:UGRD:975 mb:3 hour fcst:",
    "7.5:604:d=2026042512:VGRD:975 mb:3 hour fcst:",
  ];
  const selection = selectNoaaNamParameterRecords(parseNoaaIdx(rows.join("\n"), 1000), {
    modelKey: "hrrr",
    targetHour: 3,
  });

  assert.ok(!selection.availableParameters.includes("effectiveLayerSupercellCompositeParameter"));
  assert.ok(!selection.availableParameters.includes("effectiveLayerSignificantTornadoParameter"));
  assert.equal(selection.records.profileHgt975, undefined);
  assert.equal(selection.records.profileTmp975, undefined);
  assert.equal(selection.records.profileU975, undefined);
});

test("NOAA parameter metadata exposes source and method tooltip notes", () => {
  const metadata = getNoaaNamParameterMetadata();

  assert.match(metadata.wind.sourceNote, /UGRD\/VGRD at 10 m above ground/);
  assert.match(metadata.wind.sourceNote, /converted from m\/s components to mph/);
  assert.match(metadata.temperature.sourceNote, /TMP at 2 m above ground/);
  assert.match(metadata.temperature.sourceNote, /converted from K to F/);

  assert.equal(metadata.precip.methodVersion, "apcp-rolling-window-accumulation-v1");
  assert.match(metadata.precip.sourceNote, /APCP at surface/);
  assert.match(metadata.precip.sourceNote, /1-hour rolling accumulation/);
  assert.equal(metadata.precipTotal.methodVersion, "apcp-run-total-accumulation-v1");

  assert.equal(metadata.reflectivity1kmPrecipType.methodVersion, "direct-1km-refd-categorical-ptype-v1");
  assert.match(metadata.reflectivity1kmPrecipType.sourceNote, /REFD at 1000 m above ground/);
  assert.match(metadata.reflectivity1kmPrecipType.derivation, /instantaneous reflectivity\/type/);

  assert.equal(metadata.height500.methodVersion, "hgt-pressure-contour-simple-v1");
  assert.match(metadata.height500.sourceNote, /HGT at 500 mb/);
  assert.match(metadata.height500.sourceNote, /6 dam contour interval/);
});

test("NOAA base render mode keeps derived parameters after split frame zero", () => {
  const baseKeys = _testFilterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "base").map((entry) => entry.key);
  assert.ok(baseKeys.includes("surfaceThetaE"));
  assert.ok(baseKeys.includes("bulkShear0to6km"));
  assert.ok(baseKeys.includes("dcape"));
  assert.ok(baseKeys.includes("framFlatIce"));
  assert.equal(baseKeys.includes("snow10to1"), false);

  const snowKeys = _testFilterCatalogForRenderMode(NOAA_NAM_PARAMETER_CATALOG, "snow").map((entry) => entry.key);
  assert.ok(snowKeys.includes("snow10to1"));
  assert.equal(snowKeys.includes("dcape"), false);
});

test("NOAA freezing-rain and FRAM selectors require accumulated liquid sources", () => {
  const rows = [
    "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
    "2.1:100:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
    "2.2:100:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
    "3:200:d=2026042512:DPT:2 m above ground:3 hour fcst:",
    "4:300:d=2026042512:FRZR:surface:3 hour fcst:",
  ];
  const selection = selectNoaaNamParameterRecords(parseNoaaIdx(rows.join("\n"), 500), {
    modelKey: "hrrr",
    targetHour: 3,
  });

  assert.ok(!selection.availableParameters.includes("freezingRainLiquidTotal"));
  assert.ok(!selection.availableParameters.includes("framFlatIce"));
  assert.ok(!selection.availableParameters.includes("framRadialIce"));
});

test("NOAA derived formula fixtures cover theta-e, vorticity, frontogenesis, and DCAPE stats", () => {
  const thetaE = _testBoltonThetaE(303.15, 293.15, 1000);
  assert.ok(Math.abs(thetaE - 349.87) < 0.05);

  const absvAt45N = 2 * 7.2921e-5 * Math.sin((45 * Math.PI) / 180) + 2e-5;
  const relVort = _testBuildRelativeVorticityGrid(
    new Float32Array([absvAt45N, absvAt45N]),
    { north: 45, south: 44, west: -100, east: -100 },
    1,
    2,
  );
  assert.ok(Math.abs(relVort[0] - 2) < 1e-5);

  const width = 5;
  const height = 5;
  const cellCount = width * height;
  const temp850 = new Float32Array(cellCount);
  const wind850U = new Float32Array(cellCount);
  const wind850V = new Float32Array(cellCount);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      temp850[index] = 280 + x;
      wind850U[index] = 10;
      wind850V[index] = 0;
    }
  }
  const frontogenesis = _testBuildFrontogenesisGrid(
    { temp850, wind850U, wind850V },
    850,
    { north: 45, south: 40, west: -105, east: -95 },
    width,
    height,
  );
  assert.ok(Math.abs(frontogenesis[12]) < 1e-12);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      wind850U[y * width + x] = 20 - x;
    }
  }
  const convergentFrontogenesis = _testBuildFrontogenesisGrid(
    { temp850, wind850U, wind850V },
    850,
    { north: 45, south: 40, west: -105, east: -95 },
    width,
    height,
  );
  assert.ok(convergentFrontogenesis[12] > 0);

  const spikeWidth = 7;
  const spikeHeight = 7;
  const spike = new Float32Array(spikeWidth * spikeHeight).fill(0);
  spike[3 * spikeWidth + 3] = 8;
  spike[3 * spikeWidth + 2] = -8;
  const smoothedSpike = _testBuildFrontogenesisPresentationGrid(spike, spikeWidth, spikeHeight);
  assert.ok(smoothedSpike[3 * spikeWidth + 3] > 0);
  assert.ok(smoothedSpike[3 * spikeWidth + 3] < spike[3 * spikeWidth + 3]);
  assert.ok(smoothedSpike[2 * spikeWidth + 3] > 0);
  assert.equal(smoothedSpike[3 * spikeWidth + 2] >= 0, true);

  const stats = _testBuildGridDistributionStats(new Float32Array([0, 100, 500, 2500, 3000, Number.NaN]), {
    clampMax: 2500,
  });
  assert.deepEqual(stats, {
    finiteCount: 5,
    min: 0,
    p50: 500,
    p90: 3000,
    p99: 3000,
    max: 3000,
    topClampPct: 40,
  });
});

test("NOAA MSL height diagnostics are converted to AGL before display/use", () => {
  const cloudEntry = NOAA_NAM_PARAMETER_CATALOG.find((entry) => entry.key === "cloudCeiling");
  const cloudCeilingAgl = _testResolveCatalogSourceGrid(
    cloudEntry,
    {
      cloudCeiling: new Float32Array([1500, 900, Number.NaN]),
      profileSurfaceHeight: new Float32Array([500, 1000, 200]),
    },
    3,
    1,
  );
  assert.ok(cloudCeilingAgl);
  assert.deepEqual(Array.from(cloudCeilingAgl), [1000, 0, Number.NaN]);

  const derived = _testBuildDerivedParameterGrids({
    decoded: {
      surfaceBasedLclHeightDirect: new Float32Array([1800, 900]),
      profileSurfaceHeight: new Float32Array([800, 1000]),
    },
    selection: {
      availableParameters: ["surfaceBasedLclHeight"],
    },
    bounds: { north: 1, south: 0, west: 0, east: 1 },
    width: 2,
    height: 1,
  });
  assert.ok(derived.surfaceBasedLclHeight);
  assert.deepEqual(Array.from(derived.surfaceBasedLclHeight), [1000, 0]);
});

test("NOAA SCP and fixed-layer STP use SPC-normalized capped terms", () => {
  const scp = _testBuildScpGrid(
    {
      mucape: new Float32Array([2000]),
      srh0to3km: new Float32Array([100]),
    },
    new Float32Array([30 * 1.9438444924406046]),
    1,
  );
  assert.ok(scp);
  assert.ok(Math.abs(scp[0] - 4) < 1e-6);

  const stp = _testBuildStpGrid(
    {
      sbcape: new Float32Array([3000]),
      mlcape: new Float32Array([500]),
      mlcin: new Float32Array([-25]),
      srh0to1km: new Float32Array([150]),
    },
    new Float32Array([750]),
    new Float32Array([25]),
    1,
  );
  assert.ok(stp);
  assert.ok(Math.abs(stp[0] - 1.2861111) < 1e-6);

  const effectiveDiagnostics = {
    baseAglM: new Float32Array([0, 500]),
    ebwdKt: new Float32Array([30 * 1.9438444924406046, 30 * 1.9438444924406046]),
    esrh: new Float32Array([150, 150]),
    mixedLayerLclM: new Float32Array([750, 750]),
  };
  const effectiveScp = _testBuildEffectiveLayerScpGrid(
    {
      mucape: new Float32Array([2000, 2000]),
    },
    effectiveDiagnostics,
    2,
  );
  assert.ok(effectiveScp);
  assert.ok(Math.abs(effectiveScp[0] - 6) < 1e-6);
  assert.ok(Math.abs(effectiveScp[1] - 6) < 1e-6);

  const effectiveScpWithCin = _testBuildEffectiveLayerScpGrid(
    {},
    {
      ...effectiveDiagnostics,
      muCapeJkg: new Float32Array([2000, 2000]),
      muCinJkg: new Float32Array([-80, -40]),
    },
    2,
  );
  assert.ok(effectiveScpWithCin);
  assert.ok(Math.abs(effectiveScpWithCin[0] - 6) < 1e-6);
  assert.ok(Math.abs(effectiveScpWithCin[1] - 6) < 1e-6);

  const effectiveStp = _testBuildEffectiveLayerStpGrid(
    {
      mlcape: new Float32Array([3000, 3000]),
      mlcin: new Float32Array([-25, -25]),
    },
    effectiveDiagnostics,
    2,
  );
  assert.ok(effectiveStp);
  assert.ok(Math.abs(effectiveStp[0] - 3) < 1e-6);
  assert.equal(effectiveStp[1], 0);

  const effectiveStpUncappedShear = _testBuildEffectiveLayerStpGrid(
    {
      mlcape: new Float32Array([1500]),
      mlcin: new Float32Array([-25]),
    },
    {
      baseAglM: new Float32Array([0]),
      ebwdKt: new Float32Array([15 * 1.9438444924406046]),
      esrh: new Float32Array([150]),
      mixedLayerLclM: new Float32Array([750]),
    },
    1,
  );
  assert.ok(effectiveStpUncappedShear);
  assert.ok(Math.abs(effectiveStpUncappedShear[0] - 0.75) < 1e-6);
});

test("NOAA effective shear gates cells by effective inflow CAPE and CIN", () => {
  const decoded = {
    mlcape: new Float32Array([99, 150, 150, 0, 0]),
    mlcin: new Float32Array([-10, -300, -10, 0, 0]),
    sbcape: new Float32Array([0, 0, 0, 150, 0]),
    sbcin: new Float32Array([0, 0, 0, -10, 0]),
    mucape: new Float32Array([500, 500, 500, 500, 500]),
  };
  assert.equal(_testEffectiveLayerCellActive(decoded, 0), false);
  assert.equal(_testEffectiveLayerCellActive(decoded, 1), false);
  assert.equal(_testEffectiveLayerCellActive(decoded, 2), true);
  assert.equal(_testEffectiveLayerCellActive(decoded, 3), true);
  assert.equal(_testEffectiveLayerCellActive(decoded, 4), false);
});

test("NOAA effective-layer SCP and STP use shared sparse parcel diagnostics", () => {
  const decoded = {
    profileSurfaceHeight: new Float32Array([0]),
    temperature2m: new Float32Array([300]),
    dewpoint2m: new Float32Array([294]),
    derivedSurfacePressure: new Float32Array([100000]),
    windU10m: new Float32Array([0]),
    windV10m: new Float32Array([0]),
    mlcape: new Float32Array([2000]),
    mlcin: new Float32Array([-25]),
    sbcape: new Float32Array([1500]),
    sbcin: new Float32Array([-10]),
    mucape: new Float32Array([2500]),
    profileHgt1000: new Float32Array([100]),
    profileTmp1000: new Float32Array([298]),
    profileRh1000: new Float32Array([70]),
    profileU1000: new Float32Array([1]),
    profileV1000: new Float32Array([1]),
    profileHgt925: new Float32Array([800]),
    profileTmp925: new Float32Array([294]),
    profileRh925: new Float32Array([70]),
    profileU925: new Float32Array([5]),
    profileV925: new Float32Array([2]),
    profileHgt850: new Float32Array([1500]),
    profileTmp850: new Float32Array([288]),
    profileRh850: new Float32Array([65]),
    profileU850: new Float32Array([10]),
    profileV850: new Float32Array([4]),
    profileHgt700: new Float32Array([3000]),
    profileTmp700: new Float32Array([270]),
    profileRh700: new Float32Array([50]),
    profileU700: new Float32Array([15]),
    profileV700: new Float32Array([5]),
    profileHgt500: new Float32Array([5600]),
    profileTmp500: new Float32Array([250]),
    profileRh500: new Float32Array([40]),
    profileU500: new Float32Array([28]),
    profileV500: new Float32Array([0]),
    profileHgt300: new Float32Array([9000]),
    profileTmp300: new Float32Array([230]),
    profileRh300: new Float32Array([30]),
    profileU300: new Float32Array([38]),
    profileV300: new Float32Array([-5]),
  };
  const derived = _testBuildDerivedParameterGrids({
    decoded,
    selection: {
      availableParameters: ["effectiveLayerSupercellCompositeParameter", "effectiveLayerSignificantTornadoParameter"],
    },
    bounds: { north: 1, south: 0, west: 0, east: 1 },
    width: 1,
    height: 1,
  });
  assert.ok(derived.effectiveLayerSupercellCompositeParameter);
  assert.ok(derived.effectiveLayerSignificantTornadoParameter);
  assert.ok(derived.effectiveLayerSupercellCompositeParameter[0] > 0.1);
  assert.ok(derived.effectiveLayerSignificantTornadoParameter[0] > 0.1);
});

test("NOAA 0-6 km bulk shear interpolates to 6 km AGL, not MSL", () => {
  const decoded = {
    profileSurfaceHeight: new Float32Array([1000]),
    windU10m: new Float32Array([5]),
    windV10m: new Float32Array([0]),
    profileHgt1000: new Float32Array([1200]),
    profileU1000: new Float32Array([10]),
    profileV1000: new Float32Array([0]),
    profileHgt500: new Float32Array([6500]),
    profileU500: new Float32Array([20]),
    profileV500: new Float32Array([0]),
    profileHgt300: new Float32Array([9500]),
    profileU300: new Float32Array([50]),
    profileV300: new Float32Array([0]),
  };
  const derived = _testBuildDerivedParameterGrids({
    decoded,
    selection: {
      availableParameters: ["bulkShear0to6km"],
    },
    bounds: { north: 1, south: 0, west: 0, east: 1 },
    width: 1,
    height: 1,
  });
  assert.ok(derived.bulkShear0to6km);
  assert.ok(Math.abs(derived.bulkShear0to6km[0] - 38.8769) < 0.001);
});

test("NOAA 0-6 km bulk shear is missing when 6 km AGL is above the available profile", () => {
  const decoded = {
    profileSurfaceHeight: new Float32Array([3500]),
    windU10m: new Float32Array([5]),
    windV10m: new Float32Array([0]),
    profileHgt700: new Float32Array([3600]),
    profileU700: new Float32Array([15]),
    profileV700: new Float32Array([0]),
    profileHgt500: new Float32Array([5700]),
    profileU500: new Float32Array([30]),
    profileV500: new Float32Array([0]),
    profileHgt300: new Float32Array([9000]),
    profileU300: new Float32Array([45]),
    profileV300: new Float32Array([0]),
  };
  const derived = _testBuildDerivedParameterGrids({
    decoded,
    selection: {
      availableParameters: ["bulkShear0to6km"],
    },
    bounds: { north: 1, south: 0, west: 0, east: 1 },
    width: 1,
    height: 1,
  });
  assert.equal(derived.bulkShear0to6km, undefined);
});

test("point sounding parcel CIN ignores positive dry-layer energy below the LCL", () => {
  const scratch = {
    heights: new Float64Array([0, 200, 400]),
    pressure: new Float64Array([1000, 990, 980]),
    temp: new Float64Array([300, 296, 306]),
    dewpoint: new Float64Array([270, 270, 270]),
    segmentValid: new Uint8Array([0, 1, 1]),
    segmentDz: new Float64Array([0, 100, 100]),
    segmentMidHeight: new Float64Array([0, 100, 300]),
    segmentMidPressure: new Float64Array([0, 990, 980]),
    segmentEnvVirtualTemp: new Float64Array([0, 280, 310]),
  };
  const parcel = _testCalculateParcelCapeCinForSource(scratch, 3, {
    pressureHpa: 1000,
    heightAglM: 0,
    tempK: 300,
    dewpointK: 270,
  });
  assert.ok(parcel);
  assert.equal(parcel.capeJkg, 0);
  assert.ok(parcel.cinJkg < -30);
});

test("point sounding pressure interpolation handles descending pressure layers", () => {
  const fraction = _testLogPressureInterpolationFraction(950, 1000, 900);
  const expected = (Math.log(950) - Math.log(1000)) / (Math.log(900) - Math.log(1000));
  assert.ok(Math.abs(fraction - expected) < 1e-12);
  assert.ok(fraction > 0);
  assert.ok(fraction < 1);
});

test("profile row interpolation does not extrapolate below the lowest finite row", () => {
  const scratch = {
    heights: new Float64Array([100, 1000]),
    pressure: new Float64Array([990, 900]),
    u: new Float64Array([5, 20]),
    v: new Float64Array([0, 5]),
  };
  assert.equal(_testInterpolateProfileWindRows(scratch, 2, 0), null);
  assert.ok(Number.isNaN(_testInterpolateProfilePressureRows(scratch, 2, 0)));
});

test("point sounding parcel CAPE uses pressure-step virtual-temperature buoyancy", () => {
  const indices = _testBuildPointSoundingIndices([
    { source: "surface", press: 1000, hght: 0, temp: 26.85, dwpt: 20.85, uKt: 0, vKt: 0 },
    { source: "pressure", press: 925, hght: 800, temp: 20.85, dwpt: 15.15, uKt: 10, vKt: 2 },
    { source: "pressure", press: 850, hght: 1500, temp: 14.85, dwpt: 8.15, uKt: 20, vKt: 4 },
    { source: "pressure", press: 700, hght: 3000, temp: -3.15, dwpt: -12.05, uKt: 30, vKt: 5 },
    { source: "pressure", press: 500, hght: 5600, temp: -23.15, dwpt: -34.35, uKt: 50, vKt: 0 },
    { source: "pressure", press: 300, hght: 9000, temp: -43.15, dwpt: -55.15, uKt: 60, vKt: -5 },
  ]);
  assert.ok(Math.abs(indices.sbcapeJkg - 4552) <= 2);
  assert.ok(Math.abs(indices.lclM - 881) <= 2);
  assert.equal(indices.sbcinJkg, 0);
});

test("point sounding effective inflow top uses the last passing parcel level", () => {
  const indices = _testBuildPointSoundingIndices([
    { source: "surface", press: 1000, hght: 0, temp: 26.85, dwpt: 20.85, uKt: 0, vKt: 0 },
    { source: "pressure", press: 925, hght: 800, temp: 20.85, dwpt: 15.15, uKt: 10, vKt: 2 },
    { source: "pressure", press: 850, hght: 1500, temp: 14.85, dwpt: 8.15, uKt: 20, vKt: 4 },
    { source: "pressure", press: 700, hght: 3000, temp: -3.15, dwpt: -12.05, uKt: 30, vKt: 5 },
    { source: "pressure", press: 500, hght: 5600, temp: -23.15, dwpt: -34.35, uKt: 50, vKt: 0 },
    { source: "pressure", press: 300, hght: 9000, temp: -43.15, dwpt: -55.15, uKt: 60, vKt: -5 },
  ]);
  assert.equal(indices.effectiveBaseM, 0);
  assert.equal(indices.effectiveTopM, 1500);
});

test("point sounding wet-bulb uses pressure-aware Normand lift, not the surface-pressure formula", () => {
  const surfaceWetBulb = _testWetBulbTemperatureCAtPressure(293.15, 283.15, 1000);
  assert.ok(Math.abs(surfaceWetBulb - _testWetBulbTemperatureC(293.15, 283.15)) < 0.3);
  const saturated = _testWetBulbTemperatureCAtPressure(283.15, 283.15, 850);
  assert.ok(Math.abs(saturated - 10) < 0.05);
  const aloft = _testWetBulbTemperatureCAtPressure(268.15, 258.15, 500);
  assert.ok(aloft < _testWetBulbTemperatureC(268.15, 258.15) - 0.5);
  assert.ok(aloft > -15 && aloft < -5);
});

test("point sounding lifted index uses virtual temperatures", () => {
  const rows = _testBuildPointSoundingAnalysisRows([
    { source: "surface", press: 1000, hght: 0, temp: 26.85, dwpt: 20.85, uKt: 0, vKt: 0 },
    { source: "pressure", press: 925, hght: 800, temp: 20.85, dwpt: 15.15, uKt: 10, vKt: 2 },
    { source: "pressure", press: 850, hght: 1500, temp: 14.85, dwpt: 8.15, uKt: 20, vKt: 4 },
    { source: "pressure", press: 700, hght: 3000, temp: -3.15, dwpt: -12.05, uKt: 30, vKt: 5 },
    { source: "pressure", press: 500, hght: 5600, temp: -23.15, dwpt: -34.35, uKt: 50, vKt: 0 },
    { source: "pressure", press: 300, hght: 9000, temp: -43.15, dwpt: -55.15, uKt: 60, vKt: -5 },
  ]);
  const liftedIndex = _testCalculateLiftedIndexForPointSoundingSource(rows, rows[0]);
  assert.ok(Math.abs(liftedIndex - -20.14) < 0.05);
});

test("Bunkers storm motion deviates 7.5 m/s orthogonal to point-wind shear", () => {
  const scratch = {
    heights: new Float64Array([0, 500, 3000, 5500, 6000]),
    pressure: new Float64Array([1000, 950, 700, 500, 450]),
    u: new Float64Array([0, 0, 15, 30, 30]),
    v: new Float64Array([0, 10, 0, 0, 10]),
  };
  const motion = _testCalculateBunkersMotionFromRows(scratch, 5);
  assert.ok(motion);
  const shearU = 30;
  const shearV = 10;
  const deviationU = (motion.right.u - motion.left.u) / 2;
  const deviationV = (motion.right.v - motion.left.v) / 2;
  assert.ok(Math.abs(Math.hypot(deviationU, deviationV) - 7.5) < 1e-6);
  assert.ok(Math.abs(deviationU * shearU + deviationV * shearV) < 1e-6);
  assert.ok(shearU * deviationV - shearV * deviationU < 0);

  const weightedMotion = _testCalculateBunkersMotionFromRows(scratch, 5, { pressureWeightedMean: true });
  assert.ok(weightedMotion.right.u < motion.right.u);
});

test("effective-layer Bunkers motion uses effective-layer shear", () => {
  const scratch = {
    heights: new Float64Array([0, 500, 1000, 1500, 3500, 4000, 5500, 6000]),
    pressure: new Float64Array([1000, 950, 900, 850, 650, 600, 500, 450]),
    u: new Float64Array([0, 0, 0, 0, 0, 0, 30, 30]),
    v: new Float64Array([0, 0, 10, 10, 40, 40, 0, 0]),
  };
  const layer = {
    baseAglM: 1000,
    muElAglM: 1000 + 3000 / 0.65,
    muCapeJkg: 1000,
  };
  const motion = _testCalculateEffectiveLayerBunkersMotionFromRows(scratch, 8, layer);
  const effectiveShearMotion = _testCalculateBunkersMotionFromRows(scratch, 8, {
    meanBottomAglM: 1000,
    meanTopAglM: 4000,
    shearBottomAglM: 1000,
    shearTopAglM: 4000,
    pressureWeightedMean: true,
  });
  const fixedShearMotion = _testCalculateBunkersMotionFromRows(scratch, 8, {
    meanBottomAglM: 1000,
    meanTopAglM: 4000,
    pressureWeightedMean: true,
  });
  assert.ok(motion);
  assert.ok(effectiveShearMotion);
  assert.ok(fixedShearMotion);
  assert.ok(Math.abs(motion.right.u - effectiveShearMotion.right.u) < 1e-6);
  assert.ok(Math.abs(motion.right.v - effectiveShearMotion.right.v) < 1e-6);
  assert.ok(motion.right.u > fixedShearMotion.right.u + 5);
  assert.ok(motion.right.v > fixedShearMotion.right.v + 5);
});

test("point sounding SCP uses the SHARPlib effective-shear cap without CIN damping", () => {
  const scp = _testCalculatePointScp({
    mucapeJkg: 1000,
    srh0to3kmM2S2: 50,
    effectiveBulkShearKt: 40 * 1.943844,
    mucinJkg: -100,
  });
  assert.equal(scp, 1);
});

test("point sounding diagnostics do not synthesize surface parcels from pressure-only profiles", () => {
  const indices = _testBuildPointSoundingIndices([
    { source: "pressure", press: 1000, hght: 120, temp: 22, dwpt: 16, rh: 70, uKt: 5, vKt: 0 },
    { source: "pressure", press: 900, hght: 1000, temp: 12, dwpt: 6, rh: 65, uKt: 15, vKt: 0 },
    { source: "pressure", press: 800, hght: 2000, temp: 2, dwpt: -4, rh: 60, uKt: 25, vKt: 0 },
  ]);
  assert.equal(indices.surfacePressureHpa, null);
  assert.equal(indices.surfaceTempC, null);
  assert.equal(indices.lclM, null);
  assert.equal(indices.sbcapeJkg, null);
  assert.equal(indices.sbcinJkg, null);
  assert.equal(indices.shear0to1kmKt, null);
});

test("point sounding storm diagnostics do not synthesize surface wind from pressure levels", () => {
  const indices = _testBuildPointSoundingIndices([
    {
      source: "surface",
      press: 1000,
      hght: 0,
      temp: 20,
      dwpt: 15,
      rh: 70,
      wdir: null,
      wspd: null,
      uKt: null,
      vKt: null,
    },
    { source: "pressure", press: 900, hght: 1000, temp: 10, dwpt: 5, rh: 65, uKt: 20, vKt: 0 },
    { source: "pressure", press: 800, hght: 2000, temp: 0, dwpt: -5, rh: 60, uKt: 30, vKt: 5 },
    { source: "pressure", press: 700, hght: 3000, temp: -10, dwpt: -15, rh: 55, uKt: 40, vKt: 10 },
    { source: "pressure", press: 500, hght: 5600, temp: -25, dwpt: -35, rh: 40, uKt: 55, vKt: 20 },
    { source: "pressure", press: 300, hght: 9000, temp: -45, dwpt: -55, rh: 30, uKt: 70, vKt: 25 },
  ]);
  assert.equal(indices.surfaceWindDirDeg, null);
  assert.equal(indices.surfaceWindKt, null);
  assert.equal(indices.meanWind0to6kmKt, null);
  assert.equal(indices.bunkersRightKt, null);
  assert.equal(indices.profileSrh0to1kmM2S2, null);
});

test("point sounding analysis rows do not coerce null thermodynamics or wind to zero", () => {
  const rows = _testBuildPointSoundingAnalysisRows([
    { source: "surface", press: 1000, hght: 0, temp: 20, dwpt: 15, rh: 70, uKt: null, vKt: null },
    { source: "pressure", press: 900, hght: 1000, temp: 10, dwpt: null, rh: null, uKt: 20, vKt: 0 },
    { source: "pressure", press: 800, hght: 2000, temp: 0, dwpt: -5, rh: 60, uKt: 30, vKt: 5 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(
    rows.some((row) => row.pressureHpa === 900),
    false,
  );
  assert.ok(Number.isNaN(rows[0].uMps));
  assert.ok(Number.isNaN(rows[0].vMps));
});

test("point sounding height-derived diagnostics are missing above the sampled profile", () => {
  const indices = _testBuildPointSoundingIndices([
    { source: "surface", press: 1000, hght: 0, temp: 20, dwpt: 15, rh: 70, uKt: 0, vKt: 0 },
    { source: "pressure", press: 900, hght: 1000, temp: 10, dwpt: 5, rh: 65, uKt: 10, vKt: 0 },
    { source: "pressure", press: 800, hght: 2000, temp: 0, dwpt: -5, rh: 60, uKt: 20, vKt: 0 },
    { source: "pressure", press: 700, hght: 3000, temp: -10, dwpt: -15, rh: 55, uKt: 30, vKt: 0 },
  ]);
  assert.equal(indices.lapseRate0to3kmCPerKm, 10);
  assert.equal(indices.shear0to3kmKt, 30);
  assert.equal(indices.lapseRate3to6kmCPerKm, null);
  assert.equal(indices.virtualLapseRate3to6kmCPerKm, null);
  assert.equal(indices.shear0to6kmKt, null);
  assert.equal(indices.shear0to8kmKt, null);
});

test("NOAA effective shear uses gated 0-6 km shear instead of the theta-e top heuristic", () => {
  const decoded = {
    profileSurfaceHeight: new Float32Array([0, 0]),
    windU10m: new Float32Array([0, 0]),
    windV10m: new Float32Array([0, 0]),
    mlcape: new Float32Array([150, 160]),
    mlcin: new Float32Array([-10, -20]),
    profileHgt1000: new Float32Array([100, 100]),
    profileU1000: new Float32Array([2, 2]),
    profileV1000: new Float32Array([0, 0]),
    profileHgt500: new Float32Array([5600, 5600]),
    profileU500: new Float32Array([28, 28]),
    profileV500: new Float32Array([0, 0]),
    profileHgt300: new Float32Array([9000, 9000]),
    profileU300: new Float32Array([36, 36]),
    profileV300: new Float32Array([0, 0]),
  };
  const derived = _testBuildDerivedParameterGrids({
    decoded,
    selection: {
      availableParameters: ["bulkShear0to6km", "effectiveBulkShear"],
    },
    bounds: { north: 1, south: 0, west: 0, east: 1 },
    width: 2,
    height: 1,
  });
  assert.ok(derived.bulkShear0to6km);
  assert.ok(derived.effectiveBulkShear);
  assert.deepEqual(Array.from(derived.effectiveBulkShear), Array.from(derived.bulkShear0to6km));
});

test("NOAA UH run max composes pixelwise maxima instead of current-frame values", () => {
  const runMax = _testComposeRunMaxGrid(
    [new Float32Array([0, 60, 40, Number.NaN]), new Float32Array([25, 30, 80, 10])],
    4,
  );
  assert.deepEqual(Array.from(runMax), [25, 60, 80, 10]);
});

test("NOAA UH run max generated opacity ramp is not gated off below 25", () => {
  const decoded = {
    updraftHelicity2to5km1h: new Float32Array([0, 5, 10, 20]),
  };
  const derived = _testBuildDerivedParameterGrids({
    decoded,
    selection: {
      availableParameters: ["updraftHelicity2to5kmRunMax"],
    },
    bounds: { north: 1, south: 0, west: 0, east: 1 },
    width: 4,
    height: 1,
  });
  assert.ok(derived.updraftHelicity2to5kmRunMax);
  assert.deepEqual(Array.from(derived.updraftHelicity2to5kmRunMax), [0, 5, 10, 20]);
});

test("NOAA derived pass short-circuits empty winter and severe grids", () => {
  const decoded = {
    temperature2m: new Float32Array([293.15, 293.15]),
    dewpoint2m: new Float32Array([283.15, 283.15]),
    windU10m: new Float32Array([0, 0]),
    windV10m: new Float32Array([0, 0]),
    pressureMsl: new Float32Array([101325, 101325]),
    precip: new Float32Array([0, 0]),
    precipRateTypeFreezingRain: new Float32Array([0, 0]),
    gust: new Float32Array([0, 0]),
    sbcape: new Float32Array([0, 0]),
  };
  const derived = _testBuildDerivedParameterGrids({
    decoded,
    selection: {
      availableParameters: [
        "freezingRainLiquidTotal",
        "framFlatIce",
        "framRadialIce",
        "gustRunMax",
        "dcape",
        "surfaceThetaE",
      ],
      records: {
        precip: { forecast: "0-1 hour acc fcst" },
      },
    },
    bounds: { north: 45, south: 44, west: -100, east: -99 },
    width: 2,
    height: 1,
  });
  assert.equal(derived.freezingRainLiquidTotal, undefined);
  assert.equal(derived.framFlatIce, undefined);
  assert.equal(derived.framRadialIce, undefined);
  assert.equal(derived.gustRunMax, undefined);
  assert.ok(derived.surfaceThetaE);
});

test("NOAA freezing-rain rendering only uses trusted precomputed liquid", () => {
  const unsafeFallback = _testBuildDerivedParameterGrids({
    decoded: {
      precip: new Float32Array([25.4]),
      precipRateTypeFreezingRain: new Float32Array([1]),
      temperature2m: new Float32Array([270.15]),
      dewpoint2m: new Float32Array([270.15]),
      windU10m: new Float32Array([5]),
      windV10m: new Float32Array([0]),
    },
    selection: {
      availableParameters: ["freezingRainLiquidTotal", "framFlatIce", "framRadialIce"],
      records: { precip: { forecast: "0-1 hour acc fcst" } },
    },
    bounds: { north: 45, south: 44, west: -100, east: -99 },
    width: 1,
    height: 1,
  });
  assert.equal(unsafeFallback.freezingRainLiquidTotal, undefined);
  assert.equal(unsafeFallback.framFlatIce, undefined);
  assert.equal(unsafeFallback.framRadialIce, undefined);

  const trustedLiquid = _testBuildDerivedParameterGrids({
    decoded: {
      freezingRainLiquidTotal: new Float32Array([0.005]),
    },
    selection: {
      availableParameters: ["freezingRainLiquidTotal"],
    },
    bounds: { north: 45, south: 44, west: -100, east: -99 },
    width: 1,
    height: 1,
  });
  assert.ok(Math.abs(trustedLiquid.freezingRainLiquidTotal[0] - 0.005) < 1e-8);

  const trustedZeroLiquid = _testBuildDerivedParameterGrids({
    decoded: {
      freezingRainLiquidTotal: new Float32Array([0]),
      framFlatIce: new Float32Array([0]),
      framRadialIce: new Float32Array([0]),
    },
    selection: {
      availableParameters: ["freezingRainLiquidTotal", "framFlatIce", "framRadialIce"],
    },
    bounds: { north: 45, south: 44, west: -100, east: -99 },
    width: 1,
    height: 1,
  });
  assert.equal(trustedZeroLiquid.freezingRainLiquidTotal[0], 0);
  assert.equal(trustedZeroLiquid.framFlatIce[0], 0);
  assert.equal(trustedZeroLiquid.framRadialIce[0], 0);
});

test("NOAA NAM catalog uses generated public palettes", () => {
  const metadata = getNoaaNamParameterMetadata();
  const surfaceWindKeys = ["wind", "wind80m"];
  const humidityKeys = ["humidity2m", "rh500", "rh700", "rh850"];

  for (const key of surfaceWindKeys) {
    assert.deepEqual(metadata[key].legendStops, COLOR_MAPS.windMph.normalizedRgbaStops, `${key} wind palette`);
    assert.equal(metadata[key].thresholdNote, "<10 mph transparent");
    assert.deepEqual(metadata[key].legendTicks, [0, 10, 20, 30, 40, 50, 60]);
  }
  assert.deepEqual(
    metadata.temperature.legendStops,
    COLOR_MAPS.temperatureF.normalizedRgbaStops,
    "surface temp palette",
  );
  assert.equal(metadata.temperature.unit, "F");
  assert.deepEqual(metadata.temp850.legendStops, SCALES.temperature850C.legendStops, "850 mb temp palette");
  assert.deepEqual(metadata.temp700.legendStops, SCALES.temperature700C.legendStops, "700 mb temp palette");
  assert.deepEqual(metadata.temp500.legendStops, SCALES.temperature500C.legendStops, "500 mb temp palette");
  assert.deepEqual(metadata.temp850.legendStops, COLOR_MAPS.temperature850C.normalizedRgbaStops);
  assert.deepEqual(metadata.temp700.legendStops, COLOR_MAPS.temperature700C.normalizedRgbaStops);
  assert.deepEqual(metadata.temp500.legendStops, COLOR_MAPS.temperature500C.normalizedRgbaStops);
  assert.equal(SCALES.temperature850C.lookup, undefined);
  assert.equal(SCALES.temperature700C.lookup, undefined);
  assert.equal(SCALES.temperature500C.lookup, undefined);
  assert.equal(metadata.temp850.unit, "C");
  assert.equal(metadata.temp700.unit, "C");
  assert.equal(metadata.temp500.unit, "C");
  assert.deepEqual(metadata.wind850.legendStops, SCALES.wind700850Kt.legendStops, "850 mb wind palette");
  assert.deepEqual(metadata.wind700.legendStops, SCALES.wind700850Kt.legendStops, "700 mb wind palette");
  assert.deepEqual(metadata.wind500.legendStops, SCALES.wind500Kt.legendStops, "500 mb wind palette");
  assert.deepEqual(metadata.wind300.legendStops, SCALES.wind250Kt.legendStops, "300 mb wind palette");
  assert.deepEqual(metadata.wind250.legendStops, SCALES.wind250Kt.legendStops, "250 mb wind palette");
  assert.deepEqual(metadata.wind850.legendStops, COLOR_MAPS.wind850Kt.normalizedRgbaStops);
  assert.deepEqual(metadata.wind700.legendStops, COLOR_MAPS.wind700Kt.normalizedRgbaStops);
  assert.deepEqual(metadata.wind500.legendStops, COLOR_MAPS.wind500Kt.normalizedRgbaStops);
  assert.deepEqual(metadata.wind300.legendStops, COLOR_MAPS.wind250Kt.normalizedRgbaStops);
  assert.deepEqual(metadata.wind250.legendStops, COLOR_MAPS.wind250Kt.normalizedRgbaStops);
  assert.equal(SCALES.wind700850Kt.lookup, undefined);
  assert.equal(SCALES.wind500Kt.lookup, undefined);
  assert.equal(SCALES.wind250Kt.lookup, undefined);
  assert.equal(metadata.wind850.unit, "kt");
  assert.equal(metadata.wind700.unit, "kt");
  assert.equal(metadata.wind500.unit, "kt");
  assert.equal(metadata.wind300.unit, "kt");
  assert.equal(metadata.wind250.unit, "kt");
  assert.equal(metadata.wind850.thresholdNote, "<20 kt transparent");
  assert.equal(metadata.wind700.thresholdNote, "<20 kt transparent");
  assert.equal(metadata.wind500.thresholdNote, "<20 kt transparent");
  assert.equal(metadata.wind300.thresholdNote, "<50 kt transparent");
  assert.equal(metadata.wind250.thresholdNote, "<50 kt transparent");
  assert.deepEqual(metadata.wind850.legendTicks, [20, 30, 40, 50, 60, 70, 80]);
  assert.deepEqual(metadata.wind700.legendTicks, [20, 30, 40, 50, 60, 70, 80]);
  assert.deepEqual(metadata.wind500.legendTicks, [20, 40, 60, 80, 100, 120, 140]);
  assert.deepEqual(metadata.wind300.legendTicks, [50, 70, 90, 110, 130, 150, 170]);
  assert.deepEqual(metadata.wind250.legendTicks, [50, 70, 90, 110, 130, 150, 170]);
  for (const key of humidityKeys) {
    assert.deepEqual(metadata[key].legendStops, COLOR_MAPS.humidityPct.normalizedRgbaStops, `${key} RH palette`);
  }

  assert.deepEqual(metadata.dewpoint2m.legendStops, COLOR_MAPS.dewPointF.normalizedRgbaStops);
  assert.deepEqual(metadata.visibility.legendStops, COLOR_MAPS.visibilityMi.normalizedRgbaStops);
  assert.equal(metadata.visibility.unit, "mi");
  assert.equal(metadata.precip.label, "1-h Precip");
  assert.equal(metadata.precip.unit, "in");
  assert.equal(metadata.precip.thresholdNote, "Hidden < 0.01 in");
  assert.equal(metadata.precip.accumulationWindowHours, 1);
  assert.equal(metadata.precip.accumulationMode, "rolling");
  assert.equal(metadata.precip.minForecastHour, 1);
  assert.equal(metadata.precip3h.label, "3-h Precip");
  assert.equal(metadata.precip6h.label, "6-h Precip");
  assert.equal(metadata.precip12h.label, "12-h Precip");
  assert.equal(metadata.precip24h.label, "24-h Precip");
  assert.equal(metadata.precipTotal.label, "Total Precip");
  assert.equal(metadata.precip3h.accumulationMode, "rolling");
  assert.equal(metadata.precip24h.accumulationWindowHours, 24);
  assert.equal(metadata.precip24h.minForecastHour, 1);
  assert.equal(metadata.precipTotal.accumulationMode, "total");
  assert.equal(SCALES.precipIn.min, 0.01);
  assert.equal(SCALES.precipIn.max, 15);
  assert.equal(SCALES.precipIn.minVisible, 0.01);
  assert.equal(SCALES.precipIn.lookup, "step");
  assert.equal(metadata.precip.legendStops[0][1][3], 0);
  assert.equal(metadata.reflectivityComposite.label, "Composite Reflectivity");
  assert.equal(metadata.reflectivity1km.label, "1 km AGL Reflectivity");
  assert.equal(metadata.reflectivityComposite.unit, "dBZ");
  assert.equal(metadata.reflectivityComposite.thresholdNote, "Gate selectable: >=10/15/20 dBZ");
  assert.deepEqual(metadata.reflectivityComposite.legendTicks, [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70]);
  assert.equal(SCALES.reflectivityDbz.lookup, "step");
  assert.equal(SCALES.reflectivityDbz.min, 7.5);
  assert.equal(SCALES.reflectivityDbz.max, 72.5);
  assert.equal(SCALES.reflectivityDbz.minVisible, 10);
  assert.equal(metadata.reflectivityComposite.legendStops[0][1][3], 0);
  assert.deepEqual(
    metadata.reflectivityComposite.legendStops[0][1].slice(0, 3),
    COLOR_MAPS.reflectivityDbz.valueStops[0][1],
  );
  assert.deepEqual(metadata.reflectivity1km.legendStops, metadata.reflectivityComposite.legendStops);
  assert.equal(metadata.reflectivity1kmPrecipType.label, "1 km Reflectivity + Precip Type");
  assert.equal(metadata.reflectivity1kmPrecipType.legendType, "precip-type-reflectivity");
  assert.equal(
    metadata.reflectivity1kmPrecipType.thresholdNote,
    "Instant reflectivity/type, not accumulation; rain/freezing/sleet >=10 dBZ; snow >=5 dBZ",
  );
  assert.equal(metadata.reflectivity1kmPrecipType.precipTypeLegend.length, 4);
  assert.equal(metadata.reflectivity1kmPrecipType.precipTypeLegend.find((row) => row.key === "rain").filterDbz, 10);
  assert.equal(metadata.reflectivity1kmPrecipType.precipTypeLegend.find((row) => row.key === "snow").filterDbz, 5);
  assert.deepEqual(metadata.cloudCover.legendStops, COLOR_MAPS.cloudCoverPct.normalizedRgbaStops);
  assert.deepEqual(metadata.gust.legendStops, COLOR_MAPS.windGustMph.normalizedRgbaStops);
  assert.equal(metadata.gust.thresholdNote, "<15 mph transparent");
  assert.deepEqual(metadata.gust.legendTicks, [0, 10, 20, 30, 40, 50, 60, 70, 75]);
  assert.equal(SCALES.windMph.min, 10);
  assert.equal(SCALES.windMph.max, 60);
  assert.equal(SCALES.windGustMph.min, 15);
  assert.equal(SCALES.windGustMph.max, 75);
  assert.equal(SCALES.wind700850Kt.min, 20);
  assert.equal(SCALES.wind700850Kt.max, 80);
  assert.equal(SCALES.wind500Kt.min, 20);
  assert.equal(SCALES.wind500Kt.max, 140);
  assert.equal(SCALES.wind250Kt.min, 50);
  assert.equal(SCALES.wind250Kt.max, 170);
  assert.equal(SCALES.visibilityMi.max, 15);
  assert.equal(metadata.wind.legendStops[0][1][3], COLOR_MAPS.windMph.normalizedRgbaStops[0][1][3]);
  assert.deepEqual(metadata.wind.legendStops[0][1].slice(0, 3), COLOR_MAPS.windMph.valueStops[0][1]);
  assert.equal(metadata.gust.legendStops[0][1][3], COLOR_MAPS.windGustMph.normalizedRgbaStops[0][1][3]);
  assert.deepEqual(metadata.gust.legendStops[0][1].slice(0, 3), COLOR_MAPS.windGustMph.valueStops[0][1]);
  assert.deepEqual(SCALES.height250m.legendTicks, [9000, 9500, 10000, 10500, 11000, 11500]);
  assert.deepEqual(SCALES.height500m.legendTicks, [4800, 5100, 5400, 5700, 6000]);
  assert.deepEqual(SCALES.height700m.legendTicks, [2400, 2600, 2800, 3000, 3200, 3400]);
  assert.deepEqual(SCALES.height850m.legendTicks, [900, 1200, 1500, 1800]);
  assert.equal(metadata.height250.unit, "dam");
  assert.equal(metadata.height300.unit, "dam");
  assert.equal(metadata.height500.unit, "dam");
  assert.equal(metadata.height700.unit, "dam");
  assert.equal(metadata.height850.unit, "dam");
  assert.equal(metadata.height850.contourIntervalDam, 3);
  assert.equal(metadata.height700.contourIntervalDam, 3);
  assert.equal(metadata.height500.contourIntervalDam, 6);
  assert.equal(metadata.height300.contourIntervalDam, 12);
  assert.equal(metadata.height250.contourIntervalDam, 12);
  assert.deepEqual(
    getNoaaNamParameterOrder().filter((key) => /^(height|temp|rh|wind)(250|300|500|700|850)$/.test(key)),
    [
      "height850",
      "temp850",
      "rh850",
      "wind850",
      "height700",
      "temp700",
      "rh700",
      "wind700",
      "height500",
      "temp500",
      "rh500",
      "wind500",
      "height300",
      "wind300",
      "height250",
      "wind250",
    ],
  );
  assert.equal(SCALES.snowDepthIn.max, 60);
  assert.equal(SCALES.snowfallIn.max, 60);
  assert.equal(SCALES.snowfallIn.minVisible, 0);
  assert.equal(SCALES.snowfallIn.lookupSize, 65536);
  assert.equal(metadata.snowDepth.legendStops[0][1][3], 0);
  assert.deepEqual(metadata.snowDepth.legendStops, SCALES.snowDepthIn.legendStops);
  assert.deepEqual(metadata.snow10to1.legendStops, SCALES.snowfallIn.legendStops);
  assert.ok(SCALES.snowfallIn.legendStops.some(([position]) => Math.abs(position - 0.1 / 60) < 1e-12));
  assert.equal(metadata.snow10to1.thresholdNote, "Accumulated new snow; trace opacity ramp below 0.1 in");
  assert.deepEqual(metadata.snow10to1.legendDisplayScale, { kind: "power", exponent: 0.5 });
  assert.deepEqual(metadata.snowRfConus.legendTicks, [0.1, 6, 12, 24, 36, 48, 60]);
  assert.equal(metadata.snowRfConus.legendTickPositions.length, metadata.snowRfConus.legendTicks.length);
  assert.ok(metadata.snowRfConus.legendTickPositions[0] > 0.03);
  assert.ok(metadata.snowRfConus.legendTickPositions[1] > 0.3);
  assert.equal(metadata.snowRfConus.legendTickPositions.at(-1), 1);
  assert.equal(SCALES.snowWaterEqIn.max, 8);
  assert.equal(metadata.precipTypeRain, undefined);
  assert.equal(metadata.precipTypeSnow, undefined);
  assert.equal(metadata.precipTypeFreezingRain, undefined);
  assert.equal(metadata.precipTypeIcePellets, undefined);
});

test("NOAA snowfall trace values render through the low-end opacity ramp", () => {
  const colorLookup = _testCreateContinuousColorLookup({
    stops: SCALES.snowfallIn.legendStops,
    min: SCALES.snowfallIn.min,
    max: SCALES.snowfallIn.max,
    alpha: SCALES.snowfallIn.alpha,
    size: SCALES.snowfallIn.lookupSize,
  });
  const layer = _testRenderScalarGrid({
    values: new Float32Array([0, 0.005, 0.01, 0.05, 0.1]),
    width: 5,
    height: 1,
    colorLookup,
    minVisible: SCALES.snowfallIn.minVisible,
  });
  const alphaBytes = [3, 7, 11, 15, 19].map((offset) => layer.rgba[offset]);
  assert.equal(alphaBytes[0], 0);
  assert.ok(alphaBytes[1] > 0);
  assert.ok(alphaBytes[2] >= alphaBytes[1]);
  assert.ok(alphaBytes[3] > alphaBytes[2]);
  assert.ok(alphaBytes[4] > alphaBytes[3]);
  assert.equal(layer.visibleCount, 4);
});

test("NOAA snowfall selectors expose profile-derived members only when support fields exist", () => {
  const profileIdx = [
    "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
    "2.1:100:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
    "2.2:100:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
    "3:200:d=2026042512:APCP:surface:0-3 hour acc fcst:",
    "4:300:d=2026042512:CSNOW:surface:3 hour fcst:",
    "5:400:d=2026042512:CRAIN:surface:3 hour fcst:",
    "6:500:d=2026042512:CFRZR:surface:3 hour fcst:",
    "7:600:d=2026042512:CICEP:surface:3 hour fcst:",
    "8:700:d=2026042512:HGT:surface:3 hour fcst:",
    "9:800:d=2026042512:ASNOW:surface:0-3 hour acc fcst:",
  ];
  let record = 14;
  for (const level of SNOW_PROFILE_LEVELS) {
    for (const param of ["HGT", "TMP", "RH", "VVEL"]) {
      profileIdx.push(`${record}:${record * 100}:d=2026042512:${param}:${level} mb:3 hour fcst:`);
      record += 1;
    }
  }
  const profileText = profileIdx.join("\n");
  const selection = selectNoaaNamParameterRecords(parseNoaaIdx(profileText, record * 100));

  assert.ok(selection.availableParameters.includes("snow10to1"));
  assert.ok(selection.availableParameters.includes("snowKuchera"));
  assert.ok(selection.availableParameters.includes("snowCobb"));
  assert.ok(selection.availableParameters.includes("snowHrrrAsnow"));
  assert.equal(selection.records.profileSurfaceHeight.record, "8");
  assert.ok(selection.records.profileTmp850 || selection.records.temp850);
  assert.equal(selection.records.profileVvel700, undefined);
  assert.ok(!selection.availableParameters.includes("snowRfConus"));
  assert.ok(!selection.availableParameters.includes("snowWesternLinear"));
});

test("NOAA derived profile helpers use generic cache keys", () => {
  const records = parseNoaaIdx(
    [
      "1:0:d=2026042512:HGT:850 mb:3 hour fcst:",
      "2:100:d=2026042512:TMP:850 mb:3 hour fcst:",
      "3:200:d=2026042512:RH:850 mb:3 hour fcst:",
    ].join("\n"),
    300,
  );
  const payload = _testProfileGridCachePayload({
    recordsByKey: {
      [_testProfileDecodeKey("TMP", 850)]: records[1],
      [_testProfileDecodeKey("HGT", 850)]: records[0],
    },
    hour: 3,
    context: {
      modelKey: "hrrr",
      modelConfig: { productKey: "wrfprs" },
      date: "20260425",
      cycle: "12",
      width: 10,
      height: 5,
      bounds: { north: 50, south: 20, west: -130, east: -60 },
    },
  });

  assert.equal(_testProfileDecodeKey("TMP", 850), "profileTmp850");
  assert.deepEqual(_testProfileSelector("UGRD", 700), { param: "UGRD", level: "700 mb" });
  assert.equal(payload.version, "derived-profile-grid-v1");
  assert.deepEqual(Object.keys(payload.records), ["profileHgt850", "profileTmp850"]);
});

test("NOAA snowfall selectors gate western linear member to HRRR full profiles", () => {
  const levels = SNOW_PROFILE_LEVELS;
  const rows = [
    "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
    "2:100:d=2026042512:APCP:surface:0-3 hour acc fcst:",
    "3:200:d=2026042512:CSNOW:surface:3 hour fcst:",
    "4:300:d=2026042512:CRAIN:surface:3 hour fcst:",
    "5:400:d=2026042512:CFRZR:surface:3 hour fcst:",
    "6:500:d=2026042512:CICEP:surface:3 hour fcst:",
    "7:600:d=2026042512:HGT:surface:3 hour fcst:",
  ];
  let record = rows.length + 1;
  for (const level of levels) {
    for (const param of ["HGT", "TMP", "UGRD", "VGRD"]) {
      rows.push(`${record}:${record * 100}:d=2026042512:${param}:${level} mb:3 hour fcst:`);
      record += 1;
    }
  }
  const hrrrSelection = selectNoaaNamParameterRecords(parseNoaaIdx(rows.join("\n"), record * 100), {
    modelKey: "hrrr",
  });
  const gfsSelection = selectNoaaNamParameterRecords(parseNoaaIdx(rows.join("\n"), record * 100), {
    modelKey: "gfs",
  });

  assert.ok(hrrrSelection.availableParameters.includes("snowWesternLinear"));
  assert.ok(!hrrrSelection.availableParameters.includes("snowRfConus"));
  assert.ok(!gfsSelection.availableParameters.includes("snowWesternLinear"));
});

test("NOAA western linear SLR artifact matches Veals V1c coefficients", () => {
  const model = _testLoadWesternLinearSlrModel();
  const slr = _testPredictLinearSlr(model, [265.12524, 252.721327, 10.260052, 18.35802]);

  assert.deepEqual(model.featureKeys, ["T04K", "T24K", "SPD04K", "SPD24K"]);
  assert.ok(Math.abs(slr - 12.879740230926302) < 1e-9);
});

test("NOAA CONUS RF artifact matches sklearn fixture predictions", () => {
  const model = _testLoadSnowRfModel("conus");
  const samples = [
    {
      features: [
        5, 8, 10, 12, 15, 18, 20, 22, 270, 268, 266, 264, 262, 260, 258, 256, 92, 91, 90, 88, 86, 84, 82, 80, 500, 42,
        -111,
      ],
      expected: 13.019582796042528,
    },
    {
      features: [
        2, 3, 4, 5, 7, 9, 11, 12, 268, 265, 262, 259, 255, 251, 248, 245, 98, 97, 96, 94, 91, 88, 84, 80, 1800, 39.5,
        -106.5,
      ],
      expected: 15.658695999664602,
    },
    {
      features: [
        12, 14, 17, 20, 22, 25, 28, 30, 274, 272, 269, 266, 263, 260, 257, 254, 85, 86, 87, 88, 89, 90, 90, 88, 100, 44,
        -75,
      ],
      expected: 13.260978049978435,
    },
  ];

  for (const sample of samples) {
    assert.ok(Math.abs(_testPredictRandomForest(model, sample.features) - sample.expected) < 1e-12);
  }
});

test("NOAA snow artifact cache identity is content-addressed", () => {
  const identity = _testSnowArtifactCacheIdentity("snow-rf/conus-rf.json");

  assert.equal(identity.artifactRequired, "snow-rf/conus-rf.json");
  assert.equal(identity.sha256.length, 64);
  assert.ok(identity.bytes > 0);
});

test("NOAA snowfall AGL features stay finite when low-level pressure brackets are sparse", () => {
  const decoded = {
    profileSurfaceHeight: new Float32Array([100]),
    temperature2m: new Float32Array([271.15]),
    humidity2m: new Float32Array([90]),
    windU10m: new Float32Array([3]),
    windV10m: new Float32Array([4]),
  };
  for (const level of [925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300]) {
    const height = 100 + (1000 - level) * 10;
    decoded[`profileHgt${level}`] = new Float32Array([height]);
    decoded[`profileTmp${level}`] = new Float32Array([271.15 - (height - 100) * 0.006]);
    decoded[`profileRh${level}`] = new Float32Array([90]);
    decoded[`profileU${level}`] = new Float32Array([6]);
    decoded[`profileV${level}`] = new Float32Array([8]);
  }

  const features = _testBuildPletcherRfFeatures({
    decoded,
    index: 0,
    bounds: { west: -105, east: -104, south: 39, north: 40 },
    width: 2,
    height: 2,
  });

  assert.equal(features.length, 27);
  assert.ok(features.every(Number.isFinite));
});

test("NOAA snowfall AGL features require bracketing low-level data", () => {
  const decoded = {
    profileSurfaceHeight: new Float32Array([1500]),
  };
  for (const level of SNOW_PROFILE_LEVELS) {
    const height = 1500 + 500 + (1000 - level) * 10;
    decoded[`profileHgt${level}`] = new Float32Array([height]);
    decoded[`profileTmp${level}`] = new Float32Array([268.15 - Math.max(0, height - 1500) * 0.006]);
    decoded[`profileRh${level}`] = new Float32Array([85]);
    decoded[`profileU${level}`] = new Float32Array([6]);
    decoded[`profileV${level}`] = new Float32Array([8]);
  }

  const features = _testBuildPletcherRfFeatures({
    decoded,
    index: 0,
    bounds: { west: -105, east: -104, south: 39, north: 40 },
    width: 2,
    height: 2,
  });

  assert.equal(features, null);
});

test("NOAA western linear features use surface row for mountain low-AGL interpolation", () => {
  const decoded = {
    profileSurfaceHeight: new Float32Array([1500]),
    temperature2m: new Float32Array([265.15]),
    windU10m: new Float32Array([5]),
    windV10m: new Float32Array([0]),
  };
  for (const level of SNOW_PROFILE_LEVELS) {
    const height = 1500 + (1000 - level) * 18;
    decoded[`profileHgt${level}`] = new Float32Array([height]);
    decoded[`profileTmp${level}`] = new Float32Array([265.15 - Math.max(0, height - 1500) * 0.006]);
    decoded[`profileU${level}`] = new Float32Array([8]);
    decoded[`profileV${level}`] = new Float32Array([6]);
  }

  const features = _testBuildWesternLinearFeatures({
    decoded,
    index: 0,
    bounds: { west: -110, east: -109, south: 40, north: 41 },
    width: 2,
    height: 2,
  });

  assert.equal(features.length, 4);
  assert.ok(features.every(Number.isFinite));
});

test("NOAA snowfall math masks liquid input and computes deterministic SLRs", () => {
  const masked = _testComposeSnowMaskedPrecipGrid({
    precipMm: new Float32Array([10, 10, 10, Number.NaN]),
    snow: new Float32Array([1, 0.25, 0, 1]),
    rain: new Float32Array([0, 1, 0, 0]),
    freezingRain: new Float32Array([0, 0, 0, 0]),
    icePellets: new Float32Array([0, 0, 1, 0]),
    width: 4,
    height: 1,
  });

  assert.deepEqual(Array.from(masked.slice(0, 3)), [10, 2, 0]);
  assert.equal(Number.isNaN(masked[3]), true);

  const incompletePhaseMasks = _testComposeSnowMaskedPrecipGrid({
    precipMm: new Float32Array([10]),
    snow: new Float32Array([1]),
    width: 1,
    height: 1,
  });
  assert.equal(Number.isNaN(incompletePhaseMasks[0]), true);

  const sampledChangeover = _testComposeSnowMaskedPrecipGrid({
    precipMm: new Float32Array([12, 12]),
    maskSamples: [
      {
        weight: 1,
        snow: new Float32Array([1, 1]),
        rain: new Float32Array([0, 0]),
        freezingRain: new Float32Array([0, 0]),
        icePellets: new Float32Array([0, 0]),
      },
      {
        weight: 2,
        snow: new Float32Array([0, 1]),
        rain: new Float32Array([1, 1]),
        freezingRain: new Float32Array([0, 0]),
        icePellets: new Float32Array([0, 0]),
      },
    ],
    width: 2,
    height: 1,
  });

  assert.deepEqual(Array.from(sampledChangeover), [4, 8]);
  const freezingRainChangeover = _testComposePhaseMaskedPrecipGrid({
    precipMm: new Float32Array([12, 12]),
    targetType: "freezingRain",
    maskSamples: [
      {
        weight: 1,
        snow: new Float32Array([0, 0]),
        rain: new Float32Array([0, 0]),
        freezingRain: new Float32Array([1, 1]),
        icePellets: new Float32Array([0, 0]),
      },
      {
        weight: 2,
        snow: new Float32Array([0, 0]),
        rain: new Float32Array([1, 0]),
        freezingRain: new Float32Array([0, 1]),
        icePellets: new Float32Array([0, 0]),
      },
    ],
    width: 2,
    height: 1,
  });

  assert.deepEqual(Array.from(freezingRainChangeover), [4, 12]);
  assert.ok(Math.abs(_testCalculateFramIceLiquidRatio(0.05, -2, 10) - 0.76180484) < 1e-6);
  assert.equal(_testCalculateKucheraRatio(-12), 22);
  assert.equal(_testCalculateKucheraRatio(-1), 10);
  assert.equal(_testCalculateKucheraRatio(5), 3);
  assert.ok(
    Math.abs(
      _testCalculateWarmestProfileTempC(
        {
          profileSurfaceHeight: new Float32Array([0]),
          profileHgt925: new Float32Array([800]),
          profileTmp925: new Float32Array([273.15]),
          profileHgt850: new Float32Array([1500]),
          profileTmp850: new Float32Array([263.15]),
          temperature2m: new Float32Array([268.15]),
        },
        0,
      ),
    ) < 1e-4,
  );

  const decoded = {
    profileSurfaceHeight: new Float32Array([0]),
    profileHgt875: new Float32Array([1200]),
    profileTmp875: new Float32Array([259.15]),
    profileRh875: new Float32Array([94]),
    profileVvel875: new Float32Array([-1.1]),
    profileHgt925: new Float32Array([800]),
    profileTmp925: new Float32Array([263.15]),
    profileRh925: new Float32Array([95]),
    profileVvel925: new Float32Array([-1]),
    profileHgt850: new Float32Array([1500]),
    profileTmp850: new Float32Array([260.15]),
    profileRh850: new Float32Array([90]),
    profileVvel850: new Float32Array([-1.2]),
    profileHgt700: new Float32Array([3000]),
    profileTmp700: new Float32Array([252.15]),
    profileRh700: new Float32Array([85]),
    profileVvel700: new Float32Array([-0.8]),
  };
  const cobb = _testCalculateCobbSlr(decoded, 0);
  assert.ok(Number.isFinite(cobb));
  assert.ok(cobb > 0 && cobb <= 50);

  const cobbFullProfileOnly = {
    profileSurfaceHeight: new Float32Array([0]),
    profileHgt875: new Float32Array([1200]),
    profileTmp875: new Float32Array([259.15]),
    profileRh875: new Float32Array([94]),
    profileVvel875: new Float32Array([-1.1]),
  };
  assert.ok(Number.isFinite(_testCalculateCobbSlr(cobbFullProfileOnly, 0)));

  const descendingOnly = {
    profileSurfaceHeight: new Float32Array([0]),
    profileHgt850: new Float32Array([1500]),
    profileTmp850: new Float32Array([263.15]),
    profileRh850: new Float32Array([95]),
    profileVvel850: new Float32Array([1]),
  };
  assert.equal(Number.isNaN(_testCalculateCobbSlr(descendingOnly, 0)), true);
});

test("NOAA snowfall accumulation planner prefers accumulated WEASD before APCP snow masks", async () => {
  const directRecords = parseNoaaIdx("1:0:d=2026042512:WEASD:surface:0-3 hour acc fcst:", 100);
  const directPlan = await _testResolveSnowLiquidTotalPlan({
    targetHour: 3,
    availableHours: [0, 3],
    availableHourSet: new Set([0, 3]),
    recordsByHour: new Map([[3, directRecords]]),
    snowLiquidIntervalsByHour: new Map(),
  });
  assert.equal(directPlan.terms.length, 1);
  assert.equal(directPlan.terms[0].kind, "weasd");

  const hour1 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-1 hour acc fcst:",
      "2:100:d=2026042512:CSNOW:surface:1 hour fcst:",
      "3:200:d=2026042512:CRAIN:surface:1 hour fcst:",
      "4:300:d=2026042512:CFRZR:surface:1 hour fcst:",
      "5:400:d=2026042512:CICEP:surface:1 hour fcst:",
    ].join("\n"),
    600,
  );
  const hour3 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:1-3 hour acc fcst:",
      "2:100:d=2026042512:CSNOW:surface:3 hour fcst:",
      "3:200:d=2026042512:CRAIN:surface:3 hour fcst:",
      "4:300:d=2026042512:CFRZR:surface:3 hour fcst:",
      "5:400:d=2026042512:CICEP:surface:3 hour fcst:",
    ].join("\n"),
    600,
  );
  const fallbackPlan = await _testResolveSnowLiquidTotalPlan({
    targetHour: 3,
    availableHours: [0, 1, 3],
    availableHourSet: new Set([0, 1, 3]),
    recordsByHour: new Map([
      [1, hour1],
      [3, hour3],
    ]),
    snowLiquidIntervalsByHour: new Map(),
  });
  assert.deepEqual(
    fallbackPlan.terms.map((term) => term.kind),
    ["apcpSnow", "apcpSnow"],
  );
});

test("NOAA FRAM ice samples surface environment across multi-hour chunks", () => {
  const liquidByChunk = new Map([["chunk", new Float32Array([1])]]);
  const coldProfile = {
    temperature2m: new Float32Array([268.15]),
    dewpoint2m: new Float32Array([268.15]),
    windU10m: new Float32Array([5]),
    windV10m: new Float32Array([0]),
  };
  const warmProfile = {
    temperature2m: new Float32Array([272.95]),
    dewpoint2m: new Float32Array([272.95]),
    windU10m: new Float32Array([5]),
    windV10m: new Float32Array([0]),
  };
  const base = {
    chunkDescriptors: [
      { chunk: { key: "chunk", startHour: 0, endHour: 2 }, liquidIn: liquidByChunk.get("chunk"), activeIndices: null },
    ],
    liquidByChunk,
    profilesByHour: new Map([
      [1, coldProfile],
      [2, warmProfile],
    ]),
    decoded: {},
    width: 1,
    height: 1,
  };
  const sampled = _testBuildFramIceGridsFromChunks({
    ...base,
    chunks: [{ key: "chunk", startHour: 0, endHour: 2, profileHour: 2, profileHours: [1, 2] }],
    chunkDescriptors: [
      {
        chunk: { key: "chunk", startHour: 0, endHour: 2, profileHour: 2, profileHours: [1, 2] },
        liquidIn: liquidByChunk.get("chunk"),
        activeIndices: null,
      },
    ],
  });
  const endOnly = _testBuildFramIceGridsFromChunks({
    ...base,
    chunks: [{ key: "chunk", startHour: 0, endHour: 2, profileHour: 2, profileHours: [2] }],
    chunkDescriptors: [
      {
        chunk: { key: "chunk", startHour: 0, endHour: 2, profileHour: 2, profileHours: [2] },
        liquidIn: liquidByChunk.get("chunk"),
        activeIndices: null,
      },
    ],
  });

  assert.notEqual(sampled.flat[0], endOnly.flat[0]);
  assert.notEqual(sampled.radial[0], endOnly.radial[0]);
});

test("NOAA snowfall accumulation planner avoids masking run-total APCP with final-hour ptype", async () => {
  const hour1 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-1 hour acc fcst:",
      "2:100:d=2026042512:CSNOW:surface:1 hour fcst:",
      "3:200:d=2026042512:CRAIN:surface:1 hour fcst:",
      "4:300:d=2026042512:CFRZR:surface:1 hour fcst:",
      "5:400:d=2026042512:CICEP:surface:1 hour fcst:",
    ].join("\n"),
    600,
  );
  const hour2 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-2 hour acc fcst:",
      "2:100:d=2026042512:APCP:surface:1-2 hour acc fcst:",
      "3:200:d=2026042512:CSNOW:surface:2 hour fcst:",
      "4:300:d=2026042512:CRAIN:surface:2 hour fcst:",
      "5:400:d=2026042512:CFRZR:surface:2 hour fcst:",
      "6:500:d=2026042512:CICEP:surface:2 hour fcst:",
    ].join("\n"),
    700,
  );
  const plan = await _testResolveSnowLiquidTotalPlan({
    targetHour: 2,
    availableHours: [0, 1, 2],
    availableHourSet: new Set([0, 1, 2]),
    recordsByHour: new Map([
      [1, hour1],
      [2, hour2],
    ]),
    snowLiquidIntervalsByHour: new Map(),
    snowLiquidCumulativePlanCache: new Map(),
    snowLiquidIntervalSumPlanCache: new Map(),
  });

  assert.deepEqual(
    plan.terms.map((term) => term.record.forecast),
    ["0-1 hour acc fcst", "1-2 hour acc fcst"],
  );
});

test("NOAA snowfall fallback samples precip type across APCP interval changeovers", async () => {
  const hour1 = parseNoaaIdx(
    [
      "1:0:d=2026042512:CSNOW:surface:1 hour fcst:",
      "2:100:d=2026042512:CRAIN:surface:1 hour fcst:",
      "3:200:d=2026042512:CFRZR:surface:1 hour fcst:",
      "4:300:d=2026042512:CICEP:surface:1 hour fcst:",
    ].join("\n"),
    500,
  );
  const hour2 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-2 hour acc fcst:",
      "2:100:d=2026042512:CSNOW:surface:2 hour fcst:",
      "3:200:d=2026042512:CRAIN:surface:2 hour fcst:",
      "4:300:d=2026042512:CFRZR:surface:2 hour fcst:",
      "5:400:d=2026042512:CICEP:surface:2 hour fcst:",
    ].join("\n"),
    600,
  );
  const plan = await _testResolveSnowLiquidTotalPlan({
    targetHour: 2,
    availableHours: [0, 1, 2],
    availableHourSet: new Set([0, 1, 2]),
    recordsByHour: new Map([
      [1, hour1],
      [2, hour2],
    ]),
    snowLiquidIntervalsByHour: new Map(),
    snowLiquidCumulativePlanCache: new Map(),
    snowLiquidIntervalSumPlanCache: new Map(),
  });

  assert.equal(plan.terms.length, 1);
  assert.equal(plan.terms[0].kind, "apcpSnow");
  assert.deepEqual(
    plan.terms[0].maskSamples.map((sample) => [sample.hour, sample.snow?.param || null, sample.rain?.param || null]),
    [
      [1, "CSNOW", "CRAIN"],
      [2, "CSNOW", "CRAIN"],
    ],
  );
});

test("NOAA snowfall APCP fallback requires complete phase-mask records", async () => {
  const hour1 = parseNoaaIdx(
    ["1:0:d=2026042512:APCP:surface:0-1 hour acc fcst:", "2:100:d=2026042512:CSNOW:surface:1 hour fcst:"].join("\n"),
    300,
  );
  const plan = await _testResolveSnowLiquidTotalPlan({
    targetHour: 1,
    availableHours: [0, 1],
    availableHourSet: new Set([0, 1]),
    recordsByHour: new Map([[1, hour1]]),
    snowLiquidIntervalsByHour: new Map(),
    snowLiquidCumulativePlanCache: new Map(),
    snowLiquidIntervalSumPlanCache: new Map(),
  });

  assert.equal(plan, null);
});

test("NOAA snowfall APCP fallback rejects sampled phase-mask gaps", async () => {
  const hour1 = parseNoaaIdx(
    [
      "1:0:d=2026042512:CSNOW:surface:1 hour fcst:",
      "2:100:d=2026042512:CRAIN:surface:1 hour fcst:",
      "3:200:d=2026042512:CFRZR:surface:1 hour fcst:",
    ].join("\n"),
    400,
  );
  const hour2 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-2 hour acc fcst:",
      "2:100:d=2026042512:CSNOW:surface:2 hour fcst:",
      "3:200:d=2026042512:CRAIN:surface:2 hour fcst:",
      "4:300:d=2026042512:CFRZR:surface:2 hour fcst:",
      "5:400:d=2026042512:CICEP:surface:2 hour fcst:",
    ].join("\n"),
    600,
  );
  const plan = await _testResolveSnowLiquidTotalPlan({
    targetHour: 2,
    availableHours: [0, 1, 2],
    availableHourSet: new Set([0, 1, 2]),
    recordsByHour: new Map([
      [1, hour1],
      [2, hour2],
    ]),
    snowLiquidIntervalsByHour: new Map(),
    snowLiquidCumulativePlanCache: new Map(),
    snowLiquidIntervalSumPlanCache: new Map(),
  });

  assert.equal(plan, null);
});

test("NOAA freezing-rain liquid fallback samples precip type across APCP interval changeovers", async () => {
  const hour1 = parseNoaaIdx(
    [
      "1:0:d=2026042512:CSNOW:surface:1 hour fcst:",
      "2:100:d=2026042512:CRAIN:surface:1 hour fcst:",
      "3:200:d=2026042512:CFRZR:surface:1 hour fcst:",
      "4:300:d=2026042512:CICEP:surface:1 hour fcst:",
    ].join("\n"),
    500,
  );
  const hour2 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-2 hour acc fcst:",
      "2:100:d=2026042512:CSNOW:surface:2 hour fcst:",
      "3:200:d=2026042512:CRAIN:surface:2 hour fcst:",
      "4:300:d=2026042512:CFRZR:surface:2 hour fcst:",
      "5:400:d=2026042512:CICEP:surface:2 hour fcst:",
    ].join("\n"),
    600,
  );
  const chunks = await _testResolveFreezingRainLiquidChunks(
    {
      targetHour: 2,
      availableHours: [0, 1, 2],
      availableHourSet: new Set([0, 1, 2]),
      recordsByHour: new Map([
        [1, hour1],
        [2, hour2],
      ]),
      freezingRainLiquidIntervalsByHour: new Map(),
    },
    0,
    2,
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].terms[0].kind, "apcpFreezingRain");
  assert.deepEqual(
    chunks[0].terms[0].maskSamples.map((sample) => [
      sample.hour,
      sample.freezingRain?.param || null,
      sample.rain?.param || null,
    ]),
    [
      [1, "CFRZR", "CRAIN"],
      [2, "CFRZR", "CRAIN"],
    ],
  );
});

test("NOAA freezing-rain run planner warms the exact target chunk path", async () => {
  const hour1 = parseNoaaIdx(
    [
      "1:0:d=2026042512:CSNOW:surface:1 hour fcst:",
      "2:100:d=2026042512:CRAIN:surface:1 hour fcst:",
      "3:200:d=2026042512:CFRZR:surface:1 hour fcst:",
      "4:300:d=2026042512:CICEP:surface:1 hour fcst:",
    ].join("\n"),
    500,
  );
  const hour2 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-2 hour acc fcst:",
      "2:100:d=2026042512:CSNOW:surface:2 hour fcst:",
      "3:200:d=2026042512:CRAIN:surface:2 hour fcst:",
      "4:300:d=2026042512:CFRZR:surface:2 hour fcst:",
      "5:400:d=2026042512:CICEP:surface:2 hour fcst:",
    ].join("\n"),
    600,
  );
  const context = {
    targetHour: 2,
    availableHours: [0, 1, 2],
    availableHourSet: new Set([0, 1, 2]),
    recordsByHour: new Map([
      [1, hour1],
      [2, hour2],
    ]),
    freezingRainLiquidIntervalsByHour: new Map(),
    freezingRainDirectIntervalsByHour: new Map(),
    freezingRainLiquidChunksByWindow: new Map(),
    freezingRainAccumulationPlannerReady: false,
    freezingRainAccumulationChunksByTarget: null,
  };

  const warmed = await _testWarmFreezingRainAccumulationRunPlanner(context, 2);
  const resolved = await _testResolveFreezingRainLiquidChunks(context, 0, 2);

  assert.equal(warmed.length, 1);
  assert.equal(resolved, warmed);
  assert.equal(context.freezingRainAccumulationPlannerReady, true);
  assert.equal(context.freezingRainLiquidChunksByWindow.has("0:2"), true);
  assert.equal(warmed[0].terms[0].kind, "apcpFreezingRain");
});

test("NOAA snowfall fallback prefers exact interval-average precip type masks", async () => {
  const hour3 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-3 hour acc fcst:",
      "2:100:d=2026042512:CSNOW:surface:3 hour fcst:",
      "3:200:d=2026042512:CRAIN:surface:3 hour fcst:",
      "4:300:d=2026042512:CFRZR:surface:3 hour fcst:",
      "5:400:d=2026042512:CICEP:surface:3 hour fcst:",
      "6:500:d=2026042512:CSNOW:surface:0-3 hour ave fcst:",
      "7:600:d=2026042512:CICEP:surface:0-3 hour ave fcst:",
      "8:700:d=2026042512:CFRZR:surface:0-3 hour ave fcst:",
      "9:800:d=2026042512:CRAIN:surface:0-3 hour ave fcst:",
    ].join("\n"),
    900,
  );
  const plan = await _testResolveSnowLiquidTotalPlan({
    targetHour: 3,
    availableHours: [0, 3],
    availableHourSet: new Set([0, 3]),
    recordsByHour: new Map([[3, hour3]]),
    snowLiquidIntervalsByHour: new Map(),
    snowLiquidCumulativePlanCache: new Map(),
    snowLiquidIntervalSumPlanCache: new Map(),
  });

  assert.equal(plan.terms.length, 1);
  assert.equal(plan.terms[0].kind, "apcpSnow");
  assert.deepEqual(plan.terms[0].maskSamples, []);
  assert.equal(plan.terms[0].maskRecords.snow.forecast, "0-3 hour ave fcst");
  assert.equal(plan.terms[0].maskRecords.rain.forecast, "0-3 hour ave fcst");
  assert.equal(plan.terms[0].maskRecords.freezingRain.forecast, "0-3 hour ave fcst");
  assert.equal(plan.terms[0].maskRecords.icePellets.forecast, "0-3 hour ave fcst");
});

test("NOAA GFS snowfall presentation smoothing softens native-grid seams only for GFS", () => {
  const width = 9;
  const height = 5;
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      values[y * width + x] = x >= 4 ? 8 : 0;
    }
  }
  values[2 * width + 0] = Number.NaN;

  const nam = _testSmoothSnowfallPresentationGrid(values, { modelKey: "nam", width, height });
  assert.equal(nam, values);

  const gfs = _testSmoothSnowfallPresentationGrid(values, { modelKey: "gfs", width, height });
  assert.notEqual(gfs, values);
  assert.equal(Number.isNaN(gfs[2 * width + 0]), true);
  assert.equal(values[2 * width + 3], 0);
  assert.equal(values[2 * width + 4], 8);
  assert.ok(gfs[2 * width + 3] > 0);
  assert.ok(gfs[2 * width + 4] < 8);
  assert.ok(Math.abs(gfs[2 * width + 4] - gfs[2 * width + 3]) < 8);
});

test("NOAA snowfall interval chunks favor shortest valid accumulation windows", async () => {
  const hour1 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-1 hour acc fcst:",
      "2:100:d=2026042512:CSNOW:surface:1 hour fcst:",
      "3:200:d=2026042512:CRAIN:surface:1 hour fcst:",
      "4:300:d=2026042512:CFRZR:surface:1 hour fcst:",
      "5:400:d=2026042512:CICEP:surface:1 hour fcst:",
    ].join("\n"),
    600,
  );
  const hour2 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-2 hour acc fcst:",
      "2:100:d=2026042512:APCP:surface:1-2 hour acc fcst:",
      "3:200:d=2026042512:CSNOW:surface:2 hour fcst:",
      "4:300:d=2026042512:CRAIN:surface:2 hour fcst:",
      "5:400:d=2026042512:CFRZR:surface:2 hour fcst:",
      "6:500:d=2026042512:CICEP:surface:2 hour fcst:",
    ].join("\n"),
    700,
  );
  const chunks = await _testResolveSnowfallLiquidChunks(
    {
      targetHour: 2,
      availableHours: [0, 1, 2],
      availableHourSet: new Set([0, 1, 2]),
      recordsByHour: new Map([
        [1, hour1],
        [2, hour2],
      ]),
      snowLiquidIntervalsByHour: new Map(),
    },
    2,
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.terms[0].record.forecast),
    ["0-1 hour acc fcst", "1-2 hour acc fcst"],
  );
});

test("NOAA snowfall interval chunks prefer direct snow-water sources over APCP masks", async () => {
  const hour1 = parseNoaaIdx(
    [
      "1:0:d=2026042512:APCP:surface:0-1 hour acc fcst:",
      "2:100:d=2026042512:CSNOW:surface:1 hour fcst:",
      "3:200:d=2026042512:CRAIN:surface:1 hour fcst:",
      "4:300:d=2026042512:CFRZR:surface:1 hour fcst:",
      "5:400:d=2026042512:CICEP:surface:1 hour fcst:",
    ].join("\n"),
    600,
  );
  const hour2 = parseNoaaIdx(
    [
      "1:0:d=2026042512:WEASD:surface:0-2 hour acc fcst:",
      "2:100:d=2026042512:APCP:surface:1-2 hour acc fcst:",
      "3:200:d=2026042512:CSNOW:surface:2 hour fcst:",
      "4:300:d=2026042512:CRAIN:surface:2 hour fcst:",
      "5:400:d=2026042512:CFRZR:surface:2 hour fcst:",
      "6:500:d=2026042512:CICEP:surface:2 hour fcst:",
    ].join("\n"),
    700,
  );
  const chunks = await _testResolveSnowfallLiquidChunks(
    {
      targetHour: 2,
      availableHours: [0, 1, 2],
      availableHourSet: new Set([0, 1, 2]),
      recordsByHour: new Map([
        [1, hour1],
        [2, hour2],
      ]),
      snowLiquidIntervalsByHour: new Map(),
    },
    2,
  );

  assert.deepEqual(
    chunks.map((chunk) => chunk.kind),
    ["weasdDelta"],
  );
});

test("NOAA snowfall rendering only uses trusted precomputed snow liquid", () => {
  const unsafeFallback = _testBuildSnowfallInGrids({
    decoded: {
      precipTotal: new Float32Array([25.4]),
      precipTypeSnow: new Float32Array([1]),
      precipTypeRain: new Float32Array([0]),
      precipTypeFreezingRain: new Float32Array([0]),
      precipTypeIcePellets: new Float32Array([0]),
    },
    selection: { availableParameters: ["snow10to1"] },
    bounds: { west: -105, east: -104, south: 39, north: 40 },
    modelKey: "nam",
    width: 1,
    height: 1,
  });
  assert.equal(unsafeFallback.snow10to1, undefined);

  const trustedSnowLiquid = _testBuildSnowfallInGrids({
    decoded: {
      snowLiquidTotal: new Float32Array([0.127]),
    },
    selection: { availableParameters: ["snow10to1"] },
    bounds: { west: -105, east: -104, south: 39, north: 40 },
    modelKey: "nam",
    width: 1,
    height: 1,
  });
  assert.ok(Math.abs(trustedSnowLiquid.snow10to1[0] - 0.05) < 1e-5);
});

test("NOAA direct HRRR ASNOW traces remain available for hover", () => {
  const snowfall = _testBuildSnowfallInGrids({
    decoded: {
      snowHrrrAsnow: new Float32Array([0.001]),
    },
    selection: { availableParameters: ["snowHrrrAsnow"] },
    bounds: { west: -105, east: -104, south: 39, north: 40 },
    modelKey: "hrrr",
    width: 1,
    height: 1,
  });

  assert.ok(snowfall.snowHrrrAsnow);
  assert.ok(snowfall.snowHrrrAsnow[0] > 0);
  assert.ok(snowfall.snowHrrrAsnow[0] < 0.1);
});

test("NOAA interval snowfall applies SLR per interval before summing", () => {
  const chunks = [
    { key: "chunk1", profileHour: 1 },
    { key: "chunk2", profileHour: 2 },
  ];
  const liquidByChunk = new Map([
    ["chunk1", new Float32Array([1])],
    ["chunk2", new Float32Array([1])],
  ]);
  const profilesByHour = new Map([
    [
      1,
      {
        profileSurfaceHeight: new Float32Array([0]),
        profileHgt850: new Float32Array([1500]),
        profileTmp850: new Float32Array([272.15]),
      },
    ],
    [
      2,
      {
        profileSurfaceHeight: new Float32Array([0]),
        profileHgt850: new Float32Array([1500]),
        profileTmp850: new Float32Array([261.15]),
      },
    ],
  ]);

  const grid = _testBuildIntervalSnowfallGrid({
    entry: { key: "snowKuchera" },
    chunks,
    liquidByChunk,
    profilesByHour,
    decoded: {},
    bounds: { west: -105, east: -104, south: 39, north: 40 },
    width: 1,
    height: 1,
  });

  assert.ok(Math.abs(grid[0] - 32) < 1e-4);
  assert.equal(_testSnowfallDerivedGridKey("snowKuchera"), "snowfallDerivedIn:snowKuchera");
});

test("NOAA fused interval snowfall matches per-method interval grids", () => {
  const chunks = [
    { key: "chunk1", profileHour: 1 },
    { key: "chunk2", profileHour: 2 },
  ];
  const liquidByChunk = new Map([
    ["chunk1", new Float32Array([1, Number.NaN])],
    ["chunk2", new Float32Array([1, 2])],
  ]);
  const profilesByHour = new Map([
    [
      1,
      {
        profileSurfaceHeight: new Float32Array([0, 0]),
        profileHgt850: new Float32Array([1500, 1500]),
        profileTmp850: new Float32Array([272.15, 270.15]),
      },
    ],
    [
      2,
      {
        profileSurfaceHeight: new Float32Array([0, 0]),
        profileHgt850: new Float32Array([1500, 1500]),
        profileTmp850: new Float32Array([261.15, 263.15]),
      },
    ],
  ]);
  const base = {
    chunks,
    liquidByChunk,
    profilesByHour,
    decoded: {},
    bounds: { west: -105, east: -104, south: 39, north: 40 },
    width: 2,
    height: 1,
  };
  const descriptors = chunks.map((chunk) => ({
    chunk,
    liquidIn: liquidByChunk.get(chunk.key),
    activeIndices: null,
  }));

  const fused = _testBuildIntervalSnowfallGridsForEntries({
    entries: [{ key: "snow10to1" }, { key: "snowKuchera" }],
    chunkDescriptors: descriptors,
    profilesByHour,
    decoded: {},
    bounds: base.bounds,
    width: base.width,
    height: base.height,
  });

  assertFloatGridClose(
    fused.get("snow10to1"),
    _testBuildIntervalSnowfallGrid({ entry: { key: "snow10to1" }, ...base }),
  );
  assertFloatGridClose(
    fused.get("snowKuchera"),
    _testBuildIntervalSnowfallGrid({ entry: { key: "snowKuchera" }, ...base }),
  );
});

test("NOAA interval snowfall sparse path preserves missing snow liquid", () => {
  const grid = _testBuildIntervalSnowfallGrid({
    entry: { key: "snow10to1" },
    chunks: [{ key: "chunk1", profileHour: 1 }],
    liquidByChunk: new Map([["chunk1", new Float32Array([0, Number.NaN, 1])]]),
    profilesByHour: new Map(),
    decoded: {},
    bounds: { west: -105, east: -104, south: 39, north: 40 },
    width: 3,
    height: 1,
  });

  assert.equal(grid[0], 0);
  assert.equal(Number.isNaN(grid[1]), true);
  assert.equal(grid[2], 10);
});

test("NOAA interval snowfall preserves missing-only no-active-liquid cells", () => {
  const grid = _testBuildIntervalSnowfallGrid({
    entry: { key: "snow10to1" },
    chunks: [{ key: "chunk1", profileHour: 1 }],
    liquidByChunk: new Map([["chunk1", new Float32Array([0, Number.NaN, 0])]]),
    profilesByHour: new Map(),
    decoded: {},
    bounds: { west: -105, east: -104, south: 39, north: 40 },
    width: 3,
    height: 1,
  });

  assert.equal(grid[0], 0);
  assert.equal(Number.isNaN(grid[1]), true);
  assert.equal(grid[2], 0);
});

test("NOAA cumulative snowfall merge preserves unknown intervals", () => {
  const grid = _testSumSnowfallGrids(
    new Float32Array([1, Number.NaN, 2, 3]),
    new Float32Array([0.5, 0.5, Number.NaN, 0]),
    4,
  );

  assert.equal(grid[0], 1.5);
  assert.equal(Number.isNaN(grid[1]), true);
  assert.equal(Number.isNaN(grid[2]), true);
  assert.equal(grid[3], 3);
});

test("NOAA sparse active-index helper uses typed bounded descriptors", () => {
  const sparse = _testActiveGridVisitIndicesGreaterThan(new Float32Array([0, 1, Number.NaN, 0, 2, 0, 0, 0, 0, 0]), 0);
  assert.ok(sparse.indices instanceof Uint32Array);
  assert.deepEqual(Array.from(sparse.indices), [1, 2, 4]);
  assert.equal(sparse.positiveCount, 2);
  assert.equal(sparse.missingCount, 1);

  const dense = _testActiveGridVisitIndicesGreaterThan(new Float32Array([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]), 0);
  assert.equal(dense.indices, null);
  assert.equal(dense.positiveCount, 5);
});

test("NOAA precip accumulation composition fast paths preserve clamp and NaN semantics", () => {
  const sourceGrids = new Map([
    ["a", new Float32Array([2, -1, Number.NaN, 5])],
    ["b", new Float32Array([1, 4, 3, Number.NaN])],
  ]);
  assertFloatGridClose(
    _testComposePrecipAccumulationGrid([{ sourceKey: "a", weight: 1 }], sourceGrids, 4, 1),
    new Float32Array([2, 0, Number.NaN, 5]),
  );
  assertFloatGridClose(
    _testComposePrecipAccumulationGrid(
      [
        { sourceKey: "a", weight: 1 },
        { sourceKey: "b", weight: -1 },
      ],
      sourceGrids,
      4,
      1,
      { outputScale: 0.5 },
    ),
    new Float32Array([0.5, 0, Number.NaN, Number.NaN]),
  );
});

test("NOAA run-max two-grid merge preserves finite carry-forward semantics", () => {
  assertFloatGridClose(
    _testComposeRunMaxGrid([new Float32Array([1, Number.NaN, 3]), new Float32Array([2, 4, Number.NaN])], 3),
    new Float32Array([2, 4, 3]),
  );
  assert.equal(_testComposeRunMaxGrid([new Float32Array([Number.NaN]), new Float32Array([Number.NaN])], 1), null);
});

test("NOAA NAM selector picks records needed by the current UI contract", () => {
  const records = parseNoaaIdx(SAMPLE_IDX, 1500);
  const selection = selectNamAwphysRecords(records);

  assert.deepEqual(selection.missingRequired, []);
  assert.equal(selection.records.temperature2m.record, "321");
  assert.equal(selection.records.windU10m.record, "325.1");
  assert.equal(selection.records.windV10m.record, "325.2");
  assert.equal(selection.records.precip.record, "326");
  assert.equal(selection.records.reflectivity.record, "3");
  assert.equal(selection.records.reflectivityComposite.record, "3");
  assert.equal(selection.records.reflectivity1km.record, "4");
  assert.equal(selection.records.pressureMsl.record, "1");
  assert.equal(selection.records.height500.record, "120");
  assert.equal(selection.records.height1000.record, "200");
  assert.equal(selection.records.cape.record, "344");
});

test("NOAA helper parses hours, URLs, run times, and precip accumulation", () => {
  assert.deepEqual(parseHours("6,0,3,3"), [0, 3, 6]);
  assert.deepEqual(parseHours("0,3,6,9,12"), [0, 3, 6, 9, 12]);
  assert.deepEqual(parseReflectivityGates("20,10,15,10,5"), [10, 15, 20]);
  assert.deepEqual(resolveModels("all"), ["gfs", "nam", "nam3km", "hrrr"]);
  assert.deepEqual(buildFullHoursForModel("gfs").slice(0, 5), [0, 3, 6, 9, 12]);
  assert.equal(buildFullHoursForModel("gfs").at(-1), 384);
  assert.equal(buildFullHoursForModel("nam").at(-1), 84);
  assert.deepEqual(resolveHoursByModel({ args: { full: true }, models: ["gfs", "hrrr"] }), {
    gfs: buildFullHoursForModel("gfs"),
    hrrr: buildFullHoursForModel("hrrr"),
  });
  assert.equal(referenceTimeFromRun({ date: "20260425", cycle: "12" }), "2026-04-25T12:00:00Z");
  assert.equal(
    buildNoaaNamAwphysUrl({
      baseUrl: "https://example.test/",
      date: "20260425",
      cycle: "12",
      hour: 3,
    }),
    "https://example.test/nam.20260425/nam.t12z.awphys03.tm00.grib2",
  );
  assert.equal(
    buildNoaaGribUrl({
      modelKey: "gfs",
      baseUrl: "https://example.test/",
      date: "20260425",
      cycle: "12",
      hour: 3,
    }),
    "https://example.test/gfs.20260425/12/atmos/gfs.t12z.pgrb2.0p25.f003",
  );
  assert.equal(
    buildNoaaGribUrl({
      modelKey: "nam3km",
      baseUrl: "https://example.test/",
      date: "20260425",
      cycle: "12",
      hour: 3,
    }),
    "https://example.test/nam.20260425/nam.t12z.conusnest.hiresf03.tm00.grib2",
  );
  assert.equal(
    buildNoaaGribUrl({
      modelKey: "hrrr",
      baseUrl: "https://example.test/",
      date: "20260425",
      cycle: "12",
      hour: 3,
    }),
    "https://example.test/hrrr.20260425/conus/hrrr.t12z.wrfprsf03.grib2",
  );

  const precip = parseNoaaIdx(SAMPLE_IDX, 1500).find((record) => record.param === "APCP");
  assert.equal(parseAccumulationHours(precip), 3);
  assert.deepEqual(parseAccumulationWindow(precip), { startHour: 0, endHour: 3 });
  assert.deepEqual(parseAccumulationWindow({ forecast: "0-1 day acc fcst" }), { startHour: 0, endHour: 24 });
});

test("NOAA automatic run resolver can select latest and previous available runs", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method });
    return { ok: true, status: 200 };
  };

  try {
    const latest = await resolveNoaaModelRun({
      modelKey: "hrrr",
      noaaBaseUrl: "https://example.test",
      hours: [0],
      runOffset: 0,
    });
    const previous = await resolveNoaaModelRun({
      modelKey: "hrrr",
      noaaBaseUrl: "https://example.test",
      hours: [0],
      runOffset: 1,
    });

    assert.notDeepEqual(previous, latest);
    assert.equal(Date.parse(referenceTimeFromRun(latest)) - Date.parse(referenceTimeFromRun(previous)), 60 * 60 * 1000);
    assert.ok(requests.every((request) => request.method === "HEAD"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("NOAA index metadata cache reuses idx text and content length across split contexts", async () => {
  const originalFetch = global.fetch;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "noaa-index-cache-"));
  const date = "20260425";
  const cycle = "12";
  const hour = 3;
  const gribUrl = buildNoaaGribUrl({
    modelKey: "hrrr",
    baseUrl: "https://cache.example.test",
    date,
    cycle,
    hour,
  });
  const idxUrl = `${gribUrl}.idx`;
  const idxText = [
    "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
    "2:100:d=2026042512:APCP:surface:0-3 hour acc fcst:",
  ].join("\n");
  const requests = [];
  global.fetch = async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    requests.push({ url: String(url), method });
    if (method === "HEAD") {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => (String(name).toLowerCase() === "content-length" ? "250" : null),
        },
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => idxText,
    };
  };

  try {
    _testClearNoaaIndexCaches();
    const context = _testBuildNoaaIndexCacheContext({
      modelKey: "hrrr",
      date,
      cycle,
      rawCacheDir: tempDir,
    });
    const firstProfile = {};
    const firstText = await _testReadOrFetchNoaaIdxTextCached(idxUrl, context, hour, firstProfile);
    const firstLength = await _testReadOrFetchNoaaContentLengthCached(gribUrl, context, hour, firstProfile);
    assert.equal(firstText, idxText);
    assert.equal(firstLength, 250);
    assert.deepEqual(
      requests.map((request) => request.method),
      ["GET", "HEAD"],
    );
    assert.equal(firstProfile.indexCacheMisses, 1);
    assert.equal(firstProfile.contentLengthCacheMisses, 1);

    _testClearNoaaIndexCaches();
    const secondProfile = {};
    const secondText = await _testReadOrFetchNoaaIdxTextCached(idxUrl, context, hour, secondProfile);
    const secondLength = await _testReadOrFetchNoaaContentLengthCached(gribUrl, context, hour, secondProfile);
    assert.equal(secondText, idxText);
    assert.equal(secondLength, 250);
    assert.equal(requests.length, 2);
    assert.equal(secondProfile.indexCacheHits, 1);
    assert.equal(secondProfile.contentLengthCacheHits, 1);
    const records = parseNoaaIdx(secondText, secondLength);
    assert.equal(records.at(-1).rangeHeader, "bytes=100-249");
  } finally {
    _testClearNoaaIndexCaches();
    global.fetch = originalFetch;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test("NOAA idx parsing assigns duplicate offsets linearly and repairs final record lazily", () => {
  const records = parseNoaaIdx(
    [
      "1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:",
      "2.1:100:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
      "2.2:100:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
      "3:200:d=2026042512:APCP:surface:0-3 hour acc fcst:",
    ].join("\n"),
    null,
  );

  assert.equal(records[0].rangeHeader, "bytes=0-99");
  assert.equal(records[1].rangeHeader, "bytes=100-199");
  assert.equal(records[2].rangeHeader, "bytes=100-199");
  assert.equal(records[3].rangeHeader, null);

  _testRepairNoaaIdxFinalRecordRanges(records, 260);
  assert.equal(records[3].rangeHeader, "bytes=200-259");
});

test("NOAA selected GRIB record hash has cache-path strength and changes with selected ranges", () => {
  const first = parseNoaaIdx(
    ["1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:", "2:100:d=2026042512:APCP:surface:0-3 hour acc fcst:"].join(
      "\n",
    ),
    200,
  );
  const second = parseNoaaIdx(
    ["1:0:d=2026042512:TMP:2 m above ground:3 hour fcst:", "2:100:d=2026042512:APCP:surface:0-3 hour acc fcst:"].join(
      "\n",
    ),
    220,
  );

  const firstHash = _testSelectedGribRecordsHash([{ rangeHeader: first[0].rangeHeader, records: [first[0]] }]);
  const secondHash = _testSelectedGribRecordsHash([{ rangeHeader: second[0].rangeHeader, records: [second[0]] }]);

  assert.match(firstHash, /^[a-f0-9]{24}$/);
  assert.equal(firstHash, secondHash);
  assert.notEqual(
    _testSelectedGribRecordsHash([{ rangeHeader: first[1].rangeHeader, records: [first[1]] }]),
    _testSelectedGribRecordsHash([{ rangeHeader: second[1].rangeHeader, records: [second[1]] }]),
  );
});

test("NOAA bulk inventory parser preserves output ordinals for selected-plan mapping", () => {
  const source = parseNoaaIdx(
    [
      "12:1000:d=2026042512:TMP:2 m above ground:3 hour fcst:",
      "20.1:2000:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
      "20.2:2000:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
      "30:3000:d=2026042512:APCP:surface:0-3 hour acc fcst:",
    ].join("\n"),
    4000,
  );
  const selectedPlan = _testBuildSelectedRecordPlan([source[3], source[1], source[2]]);
  const inventory = _testParseWgribSimpleInventory(
    [
      "1.1:0:d=2026042512:UGRD:10 m above ground:3 hour fcst:",
      "1.2:0:d=2026042512:VGRD:10 m above ground:3 hour fcst:",
      "2:120:d=2026042512:APCP:surface:0-3 hour acc fcst:",
    ].join("\n"),
  );
  const index = _testBuildBulkDecodedRecordIndex(inventory);
  const used = new Set();

  const u = _testTakeBulkDecodedRecordBySelectedPlan(index, selectedPlan.recordIndexByOriginalRecord, source[1], used);
  used.add(_testBulkDecodedRecordOrdinal(u));
  const v = _testTakeBulkDecodedRecordBySelectedPlan(index, selectedPlan.recordIndexByOriginalRecord, source[2], used);
  used.add(_testBulkDecodedRecordOrdinal(v));
  const apcp = _testTakeBulkDecodedRecordBySelectedPlan(
    index,
    selectedPlan.recordIndexByOriginalRecord,
    source[3],
    used,
  );

  assert.equal(u.record, "1.1");
  assert.equal(v.record, "1.2");
  assert.equal(apcp.record, "2");
  assert.equal(_testBulkDecodedRecordOrdinal(u), 1);
  assert.equal(_testBulkDecodedRecordOrdinal(v), 2);
  assert.equal(_testBulkDecodedRecordOrdinal(apcp), 3);
});

test("NOAA precip accumulation plan derives rolling windows from cumulative interval differences", async () => {
  const recordsByHour = new Map([
    [0, []],
    [1, parseNoaaIdx("1:0:d=2026042512:APCP:surface:0-1 hour acc fcst:", 100)],
    [2, []],
    [3, parseNoaaIdx("1:0:d=2026042512:APCP:surface:0-3 hour acc fcst:", 100)],
    [4, parseNoaaIdx("1:0:d=2026042512:APCP:surface:3-4 hour acc fcst:", 100)],
  ]);
  const context = {
    targetHour: 4,
    availableHours: [0, 1, 2, 3, 4],
    availableHourSet: new Set([0, 1, 2, 3, 4]),
    recordsByHour,
    intervalsByHour: new Map(),
    intervalSumPlanCache: new Map(),
    cumulativePlanCache: new Map(),
  };

  const plan = await _testResolvePrecipAccumulationPlan(
    { accumulationMode: "rolling", accumulationWindowHours: 3 },
    context,
  );

  assert.deepEqual(
    plan.terms.map((term) => `${term.weight}:${term.hour}:${term.record.forecast}`),
    ["1:3:0-3 hour acc fcst", "1:4:3-4 hour acc fcst", "-1:1:0-1 hour acc fcst"],
  );
});

test("NOAA precip run planner warms exact per-target accumulation plans", async () => {
  const recordsByHour = new Map([
    [0, []],
    [1, parseNoaaIdx("1:0:d=2026042512:APCP:surface:0-1 hour acc fcst:", 100)],
    [2, []],
    [3, parseNoaaIdx("1:0:d=2026042512:APCP:surface:0-3 hour acc fcst:", 100)],
    [4, parseNoaaIdx("1:0:d=2026042512:APCP:surface:3-4 hour acc fcst:", 100)],
  ]);
  const context = {
    targetHour: 4,
    availableHours: [0, 1, 2, 3, 4],
    availableHourSet: new Set([0, 1, 2, 3, 4]),
    recordsByHour,
    intervalsByHour: new Map(),
    intervalSumPlanCache: new Map(),
    cumulativePlanCache: new Map(),
    precipAccumulationPlanCache: new Map(),
    runAccumulationPlannerReady: false,
    runAccumulationPlansByKey: new Map(),
  };

  const warmed = await _testWarmPrecipAccumulationRunPlanner(context);
  const rolling3 = NOAA_NAM_PARAMETER_CATALOG.find((entry) => entry.key === "precip3h");
  const plan = await _testResolvePrecipAccumulationPlan(rolling3, context);

  assert.equal(warmed.get("precip3h"), plan);
  assert.equal(context.runAccumulationPlannerReady, true);
  assert.deepEqual(
    plan.terms.map((term) => `${term.weight}:${term.hour}:${term.record.forecast}`),
    ["1:3:0-3 hour acc fcst", "1:4:3-4 hour acc fcst", "-1:1:0-1 hour acc fcst"],
  );
});

test("NOAA 1-h precip plan uses exact prior-hour APCP or cumulative differencing", async () => {
  const exactContext = {
    targetHour: 3,
    availableHours: [0, 1, 2, 3],
    availableHourSet: new Set([0, 1, 2, 3]),
    recordsByHour: new Map([
      [
        3,
        parseNoaaIdx(
          [
            "1:0:d=2026042512:APCP:surface:0-3 hour acc fcst:",
            "2:100:d=2026042512:APCP:surface:2-3 hour acc fcst:",
          ].join("\n"),
          200,
        ),
      ],
    ]),
    intervalsByHour: new Map(),
    intervalSumPlanCache: new Map(),
    cumulativePlanCache: new Map(),
  };

  const exactPlan = await _testResolvePrecipAccumulationPlan(
    { accumulationMode: "rolling", accumulationWindowHours: 1 },
    exactContext,
  );
  assert.deepEqual(
    exactPlan.terms.map((term) => `${term.weight}:${term.hour}:${term.record.forecast}`),
    ["1:3:2-3 hour acc fcst"],
  );

  const cumulativeContext = {
    targetHour: 3,
    availableHours: [0, 1, 2, 3],
    availableHourSet: new Set([0, 1, 2, 3]),
    recordsByHour: new Map([
      [2, parseNoaaIdx("1:0:d=2026042512:APCP:surface:0-2 hour acc fcst:", 100)],
      [3, parseNoaaIdx("1:0:d=2026042512:APCP:surface:0-3 hour acc fcst:", 100)],
    ]),
    intervalsByHour: new Map(),
    intervalSumPlanCache: new Map(),
    cumulativePlanCache: new Map(),
  };

  const cumulativePlan = await _testResolvePrecipAccumulationPlan(
    { accumulationMode: "rolling", accumulationWindowHours: 1 },
    cumulativeContext,
  );
  assert.deepEqual(
    cumulativePlan.terms.map((term) => `${term.weight}:${term.hour}:${term.record.forecast}`),
    ["1:3:0-3 hour acc fcst", "-1:2:0-2 hour acc fcst"],
  );
});

test("NOAA reflectivity selectors handle GFS-style composite levels and filter missing 1 km reflectivity", () => {
  const gfsStyleIdx = [
    "1:0:d=2026042512:TMP:2 m above ground:anl:",
    "2:100:d=2026042512:UGRD:10 m above ground:anl:",
    "3:200:d=2026042512:VGRD:10 m above ground:anl:",
    "4:300:d=2026042512:REFC:entire atmosphere:anl:",
  ].join("\n");
  const records = parseNoaaIdx(gfsStyleIdx, 400);
  const selection = selectNoaaNamParameterRecords(records);
  const filtered = resolveNoaaParameterSetFromIdxText(gfsStyleIdx);

  assert.equal(selection.records.reflectivityComposite.record, "4");
  assert.ok(selection.availableParameters.includes("reflectivityComposite"));
  assert.ok(!selection.availableParameters.includes("reflectivity1km"));
  assert.ok(!selection.availableParameters.includes("reflectivity1kmPrecipType"));
  assert.equal(filtered.parameters.reflectivity1km, undefined);
  assert.equal(filtered.parameters.reflectivity1kmPrecipType, undefined);
  assert.ok(!filtered.parameterOrder.includes("reflectivity1km"));
  assert.ok(!filtered.parameterOrder.includes("reflectivity1kmPrecipType"));
});

test("NOAA run parameter metadata uses multiple probe hours and drops unsupported optional layers", () => {
  const f000Idx = [
    "1:0:d=2026042512:TMP:2 m above ground:anl:",
    "2.1:100:d=2026042512:UGRD:10 m above ground:anl:",
    "2.2:100:d=2026042512:VGRD:10 m above ground:anl:",
    "3:200:d=2026042512:REFC:entire atmosphere:anl:",
  ].join("\n");
  const f024Idx = [
    "1:0:d=2026042512:TMP:2 m above ground:24 hour fcst:",
    "2.1:100:d=2026042512:UGRD:10 m above ground:24 hour fcst:",
    "2.2:100:d=2026042512:VGRD:10 m above ground:24 hour fcst:",
    "3:200:d=2026042512:REFC:entire atmosphere:24 hour fcst:",
    "4:300:d=2026042512:APCP:surface:0-24 hour acc fcst:",
    "5:400:d=2026042512:GUST:surface:24 hour fcst:",
  ].join("\n");

  const filtered = resolveNoaaParameterSetFromIdxTexts([f000Idx, f024Idx]);

  assert.ok(filtered.parameterOrder.includes("precip24h"));
  assert.ok(filtered.parameterOrder.includes("precipTotal"));
  assert.ok(filtered.parameterOrder.includes("gust"));
  assert.ok(!filtered.parameterOrder.includes("cloudBaseHeight"));
  assert.equal(filtered.parameters.cloudBaseHeight, undefined);
});

test("NOAA parameter probes cover early, accumulation, and tail forecast hours", () => {
  assert.deepEqual(selectNoaaParameterProbeHours([0, 3, 6]), [0, 3, 6]);
  assert.deepEqual(
    selectNoaaParameterProbeHours([0, 1, 2, 3, 6, 12, 24, 36, 48, 60]),
    [0, 1, 3, 6, 12, 24, 36, 48, 60],
  );
  assert.deepEqual(selectNoaaParameterProbeHours([0, 3, 6, 9, 12, 15, 18, 21, 24]), [0, 3, 6, 12, 24]);
});

test("NOAA default parallelism stays below S3-thrashing concurrency", () => {
  const parallelism = resolveParallelism({
    args: {},
    resources: { cpuCount: 18, memGb: 128, freeGb: 32 },
    models: ["gfs", "nam", "nam3km", "hrrr"],
  });

  assert.equal(parallelism.modelConcurrency, 4);
  assert.equal(parallelism.frameConcurrency, 24);
  assert.equal(parallelism.workerCount, 18);
  assert.equal(parallelism.totalFrameConcurrency, 24);
  assert.equal(parallelism.rangeFetchConcurrency, 4);
  assert.equal(parallelism.totalRangeFetchConcurrency, 72);
});

test("NOAA global frame queue interleaves models and starts GFS long-horizon work early", () => {
  const queue = buildGlobalFrameQueue([
    {
      modelKey: "gfs",
      index: 0,
      targetFrames: [0, 3, 6, 9, 12, 15, 18, 21].map((hour) => ({ hour })),
    },
    {
      modelKey: "nam",
      index: 1,
      targetFrames: [0, 1, 2].map((hour) => ({ hour })),
    },
    {
      modelKey: "hrrr",
      index: 2,
      targetFrames: [0, 1, 2, 3].map((hour) => ({ hour })),
    },
  ]);

  assert.equal(queue.length, 15);
  assert.equal(queue[0].modelKey, "gfs");
  assert.equal(queue[0].hour, 21);
  assert.equal(queue.find((task) => task.modelKey === "nam").hour, 2);
  assert.equal(queue.find((task) => task.modelKey === "hrrr").hour, 3);
  const firstHalfModels = queue.slice(0, 8).map((task) => task.modelKey);
  assert.ok(firstHalfModels.includes("nam"));
  assert.ok(firstHalfModels.includes("hrrr"));
  assert.ok(firstHalfModels.filter((modelKey) => modelKey === "gfs").length >= 3);
  assert.ok(new Set(queue.slice(-4).map((task) => task.modelKey)).size > 1);
});

test("NOAA frame queue defers snowfall-dependent frames without occupying workers", async () => {
  const entry = {
    hasSnowfallFrameDependency: true,
    snowfallDependencyFrameHours: [0, 1, 2, 3],
    completedDependencyHours: new Set(),
  };
  const started = [];
  const tasks = [3, 2, 1, 0].map((hour) => ({ entry, frame: { hour }, hour }));

  await _testRunGlobalFrameTaskQueue(
    tasks,
    3,
    async (task) => {
      started.push(task.hour);
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    {
      canStartTask: _testCanStartFrameTaskWithDependencies,
      onTaskFinished: _testMarkFrameTaskDependencyComplete,
    },
  );

  assert.deepEqual(started, [0, 1, 2, 3]);
});

test("NOAA frame queue splits derived snowfall frames into base, prefix, and snow jobs", () => {
  const entry = {
    hasSnowfallFrameDependency: true,
    snowfallDependencyFrameHours: [0, 1],
    completedDependencyHours: new Set(),
    completedBaseHours: new Set(),
    completedDeltaHours: new Set(),
    completedSnowPrefixHours: new Set(),
  };
  const tasks = _testBuildFrameRenderTasks([
    { entry, modelKey: "nam", frame: { hour: 0 }, hour: 0, sortKey: 0, modelIndex: 0, frameIndex: 0 },
    { entry, modelKey: "nam", frame: { hour: 1 }, hour: 1, sortKey: 1, modelIndex: 0, frameIndex: 1 },
  ]);

  assert.deepEqual(
    tasks.map((task) => [task.hour, task.renderPart, task.renderMode, task.completesFrame]),
    [
      [0, "all", "all", true],
      [1, "base", "base", false],
      [1, "snow-prefix", "snow-prefix", false],
      [1, "snow", "snow", true],
    ],
  );
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[1]), true);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[2]), false);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[3]), false);
  _testMarkFrameTaskDependencyComplete(tasks[1]);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[2]), false);
  _testMarkFrameTaskDependencyComplete(tasks[2]);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[3]), false);
  _testMarkFrameTaskDependencyComplete(tasks[0]);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[3]), true);
});

test("NOAA frame queue precomputes run-max prefixes before render work", () => {
  const entry = {
    hasRunMaxFrameDependency: true,
    runMaxDependencyFrameHours: [1, 2],
    completedRunMaxPrefixHours: new Set(),
  };
  const tasks = _testBuildFrameRenderTasks([
    { entry, modelKey: "hrrr", frame: { hour: 1 }, hour: 1, sortKey: 1, modelIndex: 0, frameIndex: 0 },
    { entry, modelKey: "hrrr", frame: { hour: 2 }, hour: 2, sortKey: 2, modelIndex: 0, frameIndex: 1 },
  ]);

  assert.deepEqual(
    tasks.map((task) => [task.hour, task.renderPart, task.renderMode, task.completesFrame]),
    [
      [1, "runmax-prefix", "runmax-prefix", false],
      [1, "all", "all", true],
      [2, "runmax-prefix", "runmax-prefix", false],
      [2, "all", "all", true],
    ],
  );
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[0]), true);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[1]), false);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[2]), false);
  _testMarkFrameTaskDependencyComplete(tasks[0]);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[1]), true);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[2]), true);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[3]), false);
  _testMarkFrameTaskDependencyComplete(tasks[2]);
  assert.equal(_testCanStartFrameTaskWithDependencies(tasks[3]), true);
});

test("NOAA hover grid binary helper can merge variable payloads", () => {
  const base = encodeHoverGridBinaryPayload({
    rows: 1,
    cols: 2,
    variables: {
      temperature: { scale: 0.1, offset: 0, missing: -32768, values: new Int16Array([100, 120]) },
    },
  });
  const snow = encodeHoverGridBinaryPayload({
    rows: 1,
    cols: 2,
    variables: {
      snowRfConus: { scale: 0.1, offset: 0, missing: -32768, values: new Int16Array([5, 10]) },
    },
  });

  const merged = decodeHoverGridPayload(mergeHoverGridPayloads(base, snow));

  assert.deepEqual(Array.from(merged.variables.temperature.values), [100, 120]);
  assert.deepEqual(Array.from(merged.variables.snowRfConus.values), [5, 10]);
});

test("NOAA split snow hover grids persist as supplemental hover artifacts", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-noaa-hover-supplemental-"));
  const runtime = new LocalArtifactRuntime({
    cacheRoot: tempDir,
    sourceName: NOAA_BETA_SOURCE_NAME,
    renderWidth: 2,
    renderHeight: 1,
    fetchLatestMetadata: async () => null,
    renderFrameArtifacts: async () => null,
  });
  await runtime.init();
  const frame = {
    hour: 1,
    validHourKey: "2026-04-25T13:00:00Z",
    bounds: { north: 1, south: 0, east: 1, west: 0 },
    rows: 1,
    cols: 2,
    hoverGridKey: "artifacts/nam/20260425-1200Z/conus/001/hover-grid.bin.gz",
    hoverGridBytes: 0,
    hoverGridSchemaVersion: 3,
    layers: {},
    reflectivityVariants: {},
    reflectivityVariantsByLayer: {},
  };
  const state = {
    modelKey: "nam",
    runId: "20260425-1200Z",
    viewKey: "conus",
    framePlanByHour: new Map([[1, { validTime: "2026-04-25T13:00:00Z" }]]),
    latestMetadata: {
      openDataModel: "noaa-nam-awphys",
      runPath: "nam.20260425",
      rendererSignature: "test-signature",
    },
    manifest: { frames: [frame], hourStatus: {} },
    latestPointer: {},
  };
  const base = encodeHoverGridBinaryPayload({
    rows: 1,
    cols: 2,
    variables: {
      temperature: { scale: 0.1, offset: 0, missing: -32768, values: new Int16Array([100, 120]) },
    },
  });
  const snow = encodeHoverGridBinaryPayload({
    rows: 1,
    cols: 2,
    variables: {
      snowRfConus: { scale: 0.1, offset: 0, missing: -32768, values: new Int16Array([5, 10]) },
    },
  });
  const basePath = runtime.getArtifactStoragePath(frame.hoverGridKey);
  await fs.promises.mkdir(path.dirname(basePath), { recursive: true });
  await fs.promises.writeFile(basePath, base);

  await runtime.persistFrameArtifacts(
    state,
    frame,
    { layers: {}, hoverGrid: { body: snow }, hoverGridSchemaVersion: 3, renderProfile: {} },
    { supplementalHoverGridName: "snow" },
  );

  const baseAfterSnowPersist = decodeHoverGridPayload(await fs.promises.readFile(basePath));
  assert.deepEqual(Array.from(baseAfterSnowPersist.variables.temperature.values), [100, 120]);
  assert.ok(frame.hoverGridSupplemental.snow.key.endsWith("/hover-grid-snow.bin.gz"));
  assert.equal(frame.hoverGridBytes, base.length);
  assert.equal(frame.hoverGridSupplemental.snow.bytes, snow.length);
  const supplemental = decodeHoverGridPayload(
    await fs.promises.readFile(runtime.getArtifactStoragePath(frame.hoverGridSupplemental.snow.key)),
  );
  assert.deepEqual(Array.from(supplemental.variables.snowRfConus.values), [5, 10]);
});

test("NOAA model metadata carries model-specific native product identity", () => {
  const metadata = buildNoaaModelMetadata({
    modelKey: "hrrr",
    run: { date: "20260425", cycle: "12" },
    hours: [0, 3, 6],
    noaaBaseUrl: "https://example.test",
  });

  assert.equal(metadata.modelKey, "hrrr");
  assert.equal(metadata.openDataModel, "noaa-hrrr-wrfprs");
  assert.equal(metadata.noaa.product, "wrfprs");
  assert.equal(metadata.latestUrl, "https://example.test/hrrr.20260425/conus/hrrr.t12z.wrfprsf00.grib2.idx");
  assert.match(metadata.rendererSignature, /^[a-f0-9]{16}$/);
  assert.deepEqual(metadata.validTimes, ["2026-04-25T12:00:00Z", "2026-04-25T15:00:00Z", "2026-04-25T18:00:00Z"]);
});

test("NOAA beta runtime writes current manifest contract into separate cache root", async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "modelview-noaa-beta-"));
  const metadata = buildNoaaNamMetadata({
    modelKey: "nam",
    run: { date: "20260425", cycle: "12" },
    hours: [0, 3, 6],
    noaaBaseUrl: "https://example.test",
  });
  const runtime = new LocalArtifactRuntime({
    cacheRoot: tempDir,
    sourceName: NOAA_BETA_SOURCE_NAME,
    renderWidth: 4,
    renderHeight: 3,
    fetchLatestMetadata: async () => metadata,
    renderFrameArtifacts: async () => null,
  });
  await runtime.init();

  const summary = await runtime.buildLatestState("nam", "conus", { frameRetries: 0, frameConcurrency: 1 });
  const latest = await runtime.readLatestPointerFromDisk("nam", "conus");
  const manifest = await runtime.readManifestFromDisk("nam", summary.runId, "conus");

  assert.equal(summary.runId, "20260425-1200Z");
  assert.equal(latest.manifestKey, "manifests/nam/20260425-1200Z.json?view=conus");
  assert.equal(manifest.source, NOAA_BETA_SOURCE_NAME);
  assert.match(metadata.rendererSignature, /^[a-f0-9]{16}$/);
  assert.equal(manifest.rendererSignature, metadata.rendererSignature);
  assert.deepEqual(
    manifest.frames.map((frame) => frame.hour),
    [0, 3, 6],
  );
  assert.equal(manifest.openDataModel, "noaa-nam-awphys");
  for (const frame of manifest.frames) {
    assert.equal(manifest.hourStatus[String(frame.hour)], "loaded");
    assert.ok(frame.layers.temperature.key.endsWith("/temperature.png"));
    assert.ok(frame.layers.wind.key.endsWith("/wind.png"));
    assert.ok(frame.layers.precip.key.endsWith("/precip.png"));
    assert.ok(frame.layers.precip3h.key.endsWith("/precip3h.png"));
    assert.ok(frame.layers.precip6h.key.endsWith("/precip6h.png"));
    assert.ok(frame.layers.precip12h.key.endsWith("/precip12h.png"));
    assert.ok(frame.layers.precip24h.key.endsWith("/precip24h.png"));
    assert.ok(frame.layers.precipTotal.key.endsWith("/precipTotal.png"));
    assert.ok(frame.layers.reflectivityComposite.key.endsWith("/reflectivity-composite-g15.png"));
    assert.ok(frame.layers.reflectivity1km.key.endsWith("/reflectivity-1km-g15.png"));
    assert.ok(frame.layers.reflectivity1kmPrecipType.key.endsWith("/reflectivity1kmPrecipType.png"));
    assert.ok(frame.layers.reflectivity.key.endsWith("/reflectivity-composite-g15.png"));
    assert.ok(frame.reflectivityVariants.dbz10.key.endsWith("/reflectivity-composite-g10.png"));
    assert.ok(frame.reflectivityVariants.dbz15.key.endsWith("/reflectivity-composite-g15.png"));
    assert.ok(
      frame.reflectivityVariantsByLayer.reflectivityComposite.dbz20.key.endsWith("/reflectivity-composite-g20.png"),
    );
    assert.ok(frame.reflectivityVariantsByLayer.reflectivity1km.dbz10.key.endsWith("/reflectivity-1km-g10.png"));
    assert.ok(frame.synopticVectorKeys.simple.endsWith("/synoptic-vector-simple.json"));
    assert.ok(frame.synopticVectorBytes.simple > 0);
    assert.ok(frame.synopticVectorBytes.detailed > 0);
    assert.ok(frame.hoverGridKey.endsWith("/hover-grid.bin.gz"));
    assert.ok(frame.hoverGridBytes > 0);
  }
  const marker = JSON.parse(
    await fs.promises.readFile(runtime.getFrameMarkerPath("nam", summary.runId, "conus", 0), "utf8"),
  );
  assert.equal(marker.rendererSignature, metadata.rendererSignature);
});

test("NOAA DCAPE v4 uses pseudoadiabatic descent with consistent gridded and point paths", () => {
  const rows = [
    { p: 1000, z: 110, t: 36.0, rh: 14 },
    { p: 925, z: 790, t: 29.5, rh: 18 },
    { p: 850, z: 1500, t: 22.5, rh: 24 },
    { p: 700, z: 3100, t: 8.0, rh: 55 },
    { p: 500, z: 5800, t: -12.5, rh: 40 },
    { p: 300, z: 9600, t: -38.0, rh: 30 },
  ];
  const sources = rows.map((row) => ({ level: row.p, hgt: [row.z], tmp: [row.t + 273.15], rh: [row.rh] }));
  const scratch = {
    heights: new Float64Array(8),
    temps: new Float64Array(8),
    pressures: new Float64Array(8),
    dewpoints: new Float64Array(8),
    thetaE: new Float64Array(8),
  };
  const gridded = _testCalculateReducedProfileDcapeFromSources(sources, 0, 80, 38 + 273.15, 1008, scratch);
  const dewpointC = (tempC, rh) => {
    const gamma = Math.log(rh / 100) + (17.625 * tempC) / (243.04 + tempC);
    return (243.04 * gamma) / (17.625 - gamma);
  };
  const levels = [
    { source: "surface", press: 1008, hght: 80, temp: 38, dwpt: 2, rh: 12 },
    ...rows.map((row) => ({
      source: "pressure",
      press: row.p,
      hght: row.z,
      temp: row.t,
      dwpt: dewpointC(row.t, row.rh),
      rh: row.rh,
    })),
  ];
  const point = _testCalculatePointDcapeJkg(levels);
  assert.ok(gridded > 500 && gridded < 1100, `gridded DCAPE out of band: ${gridded}`);
  assert.ok(point > 500 && point < 1100, `point DCAPE out of band: ${point}`);
  assert.ok(Math.abs(gridded - point) / Math.max(gridded, point) < 0.02);

  const wetRows = [
    { p: 1000, z: 110, t: 14.0, rh: 99 },
    { p: 925, z: 760, t: 10.0, rh: 99 },
    { p: 850, z: 1430, t: 6.5, rh: 99 },
    { p: 700, z: 2990, t: -1.5, rh: 99 },
    { p: 500, z: 5560, t: -16, rh: 95 },
    { p: 300, z: 9100, t: -40, rh: 90 },
  ];
  const wetSources = wetRows.map((row) => ({ level: row.p, hgt: [row.z], tmp: [row.t + 273.15], rh: [row.rh] }));
  const wet = _testCalculateReducedProfileDcapeFromSources(wetSources, 0, 80, 14 + 273.15, 1008, scratch);
  assert.ok(wet >= 0 && wet < 50, `saturated stable DCAPE should be near zero: ${wet}`);
});

test("PNG deflate backend produces IDAT streams that inflate to identical raw bytes", () => {
  const zlibNode = require("zlib");
  const { deflatePngIdatSync, pngDeflateBackendName } = require("../scripts/lib/noaa-beta/deflate-backend");
  const cols = 320;
  const rows = 200;
  const raw = Buffer.alloc(rows * (1 + cols * 4));
  for (let y = 0; y < rows; y += 1) {
    const rowOffset = y * (1 + cols * 4);
    raw[rowOffset] = 0;
    for (let x = 0; x < cols; x += 1) {
      const offset = rowOffset + 1 + x * 4;
      if ((x + y) % 3 === 0) {
        continue;
      }
      raw[offset] = (x * 7 + y) & 255;
      raw[offset + 1] = (x + y * 5) & 255;
      raw[offset + 2] = (x * 3) & 255;
      raw[offset + 3] = 255;
    }
  }
  const compressed = deflatePngIdatSync(raw, 1);
  assert.ok(zlibNode.inflateSync(compressed).equals(raw), `${pngDeflateBackendName()} roundtrip mismatch`);
  const levelSix = deflatePngIdatSync(raw, 6);
  assert.ok(levelSix.equals(zlibNode.deflateSync(raw, { level: 6 })));
  assert.ok(zlibNode.inflateSync(levelSix).equals(raw));
});
