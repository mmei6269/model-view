"use strict";

const { loadSynopticStyle } = require("./synoptic-style");
const { rowToLatMercator } = require("./mercator");
const { encodeVectorLineProjected } = require("./vector-encoding");

function renderSynopticArtifacts({
  pressureGrid,
  thicknessGrid,
  targetBounds,
  width,
  height,
  modelKey = "gfs",
  detailMode = "detailed",
  style = loadSynopticStyle(),
  drawImage = true,
  detectCenters = true,
  // Optional research diagnostic. It recomputes locality and annular
  // prominence with great-circle distances at each Mercator row, attaches the
  // comparison to emitted markers, and never changes the marker roster.
  centerValidationMode = "off",
  // Display-resolution MSLP field for H/L center refinement (Task 4.5, spec
  // §8a.6). Detection happens on the prepared (possibly downsampled) grid;
  // each center's position and value are then refined against this field.
  // Defaults to `pressureGrid` itself, which is already full-resolution in
  // simple mode; detailed mode receives a pre-downsampled grid, so callers
  // pass the display grid here.
  refinementPressureGrid = null,
}) {
  const styleVersion = String(style?.styleVersion || "v4-operational-contrast");
  const shouldDrawImage = drawImage !== false;
  const normalizedDetailMode = detailMode === "simple" ? "simple" : "detailed";
  const normalizedCenterValidationMode =
    centerValidationMode === "row-aware-diagnostic" ? "row-aware-diagnostic" : "off";
  const methodMetadata = buildSynopticMethodMetadata(style, normalizedDetailMode, normalizedCenterValidationMode);
  const empty = createEmptyOutput(width, height, styleVersion, {
    drawImage: shouldDrawImage,
    methodMetadata,
  });
  const sourcePressureGrid = normalizeGridPayload(pressureGrid);
  if (!sourcePressureGrid) {
    return empty;
  }
  const sourceThicknessGrid = normalizeGridPayload(thicknessGrid);

  const simpleGridSize = resolveSimpleGridSize(width, height);
  const preparedPressureGrid =
    normalizedDetailMode === "simple"
      ? resampleGridBilinear(sourcePressureGrid, simpleGridSize.cols, simpleGridSize.rows)
      : sourcePressureGrid;
  const preparedThicknessGrid =
    normalizedDetailMode === "simple"
      ? resampleGridBilinear(sourceThicknessGrid, simpleGridSize.cols, simpleGridSize.rows)
      : sourceThicknessGrid;
  if (!preparedPressureGrid) {
    return empty;
  }

  const pressureValues = preparedPressureGrid.values;
  const pressureRows = preparedPressureGrid.rows;
  const pressureCols = preparedPressureGrid.cols;
  const smoothedPressure = smoothPressureField(
    pressureValues,
    pressureCols,
    pressureRows,
    targetBounds,
    modelKey,
    style,
  );
  const pressureRange = findFiniteRange(smoothedPressure);
  if (!pressureRange) {
    return empty;
  }

  const rgba = shouldDrawImage ? new Uint8Array(width * height * 4) : null;
  const vector = createEmptyVector(styleVersion, methodMetadata);
  let visibleCount = 0;

  const mslpMajorInterval = Number(style?.mslp?.majorIntervalHpa || 8);
  const mslpMinorInterval = Number(style?.mslp?.minorIntervalHpa || 4);
  const mslpStart = Math.floor(pressureRange.min / mslpMinorInterval) * mslpMinorInterval;
  const mslpEnd = Math.ceil(pressureRange.max / mslpMinorInterval) * mslpMinorInterval;
  const mslpLevels = buildSteppedLevels(mslpStart, mslpEnd, mslpMinorInterval);
  const pressureSegmentsByLevel = marchingSquaresMany(smoothedPressure, pressureCols, pressureRows, mslpLevels);
  const projectPressureLatLon = projectGridLatLon(pressureCols, pressureRows, targetBounds);

  for (const level of mslpLevels) {
    const rawSegments = pressureSegmentsByLevel.get(level) || [];
    if (!rawSegments.length) {
      continue;
    }
    const isMajor = nearlyModulo(level, mslpMajorInterval);
    const styleEntry = isMajor ? style?.mslp?.major : style?.mslp?.minor;
    const rawColor = String(styleEntry?.color || (isMajor ? "#000000" : "#111111"));
    const alpha = Number.isFinite(Number(styleEntry?.alpha)) ? Number(styleEntry.alpha) : isMajor ? 0.75 : 0.55;
    const weight = Number.isFinite(Number(styleEntry?.widthPx)) ? Number(styleEntry.widthPx) : isMajor ? 1.6 : 0.95;
    const haloColor = String(styleEntry?.haloColor || "#FFFFFF");
    const haloAlpha = Number.isFinite(Number(styleEntry?.haloAlpha)) ? Number(styleEntry.haloAlpha) : 0.72;
    const haloWeight = Number.isFinite(Number(styleEntry?.haloWidthPx))
      ? Number(styleEntry.haloWidthPx)
      : isMajor
        ? 3.0
        : 2.3;

    const contours = postProcessContours(rawSegments, {
      simplifyTolerance: isMajor ? 0.28 : 0.34,
      minLengthCells: isMajor ? 4 : 5,
      minClosedAreaCells: isMajor ? 8 : 12,
      smoothPasses: 2,
    });

    for (const contour of contours) {
      if (!Array.isArray(contour) || contour.length < 2) {
        continue;
      }
      const lineMeta = {
        kind: isMajor ? "mslp-major" : "mslp-minor",
        value: level,
        color: rawColor,
        alpha,
        width: weight,
      };
      const encodedLine = encodeVectorLineProjected(lineMeta, contour, projectPressureLatLon);
      vector.isobars.lines.push(encodedLine);
      vector.lines.push(encodedLine);

      const dash = [];
      if (rgba) {
        visibleCount += drawStyledContour(rgba, width, height, contour, pressureCols, pressureRows, {
          color: rawColor,
          alpha,
          weight,
          haloColor,
          haloAlpha,
          haloWeight,
          dash,
        });
      }
    }

    appendContourLabels({
      destination: vector.isobars.labels,
      fallback: vector.labels,
      contours,
      level,
      cols: pressureCols,
      rows: pressureRows,
      bounds: targetBounds,
      kind: isMajor ? "mslp-major" : "mslp-minor",
      color: String(style?.mslp?.labels?.fillColor || "#111111"),
      maxPerLevel: Math.min(28, Math.max(12, contours.length + 1)),
      minLength: 12,
    });
  }

  if (
    preparedThicknessGrid &&
    preparedThicknessGrid.values &&
    preparedThicknessGrid.rows > 1 &&
    preparedThicknessGrid.cols > 1
  ) {
    const thicknessValues = preparedThicknessGrid.values;
    const thicknessRows = preparedThicknessGrid.rows;
    const thicknessCols = preparedThicknessGrid.cols;
    const thicknessRange = findFiniteRange(thicknessValues);
    if (thicknessRange) {
      const thicknessMajor = Number(style?.thickness?.majorIntervalDam || 12);
      const thicknessMinor = Number(style?.thickness?.minorIntervalDam || 6);
      const emphasisDam = Number(style?.thickness?.emphasisDam || 540);
      const thicknessStart = Math.ceil(thicknessRange.min / thicknessMinor) * thicknessMinor;
      const thicknessEnd = Math.floor(thicknessRange.max / thicknessMinor) * thicknessMinor;
      const thicknessLevels = buildSteppedLevels(thicknessStart, thicknessEnd, thicknessMinor);
      const thicknessSegmentsByLevel = marchingSquaresMany(
        thicknessValues,
        thicknessCols,
        thicknessRows,
        thicknessLevels,
      );
      const projectThicknessLatLon = projectGridLatLon(thicknessCols, thicknessRows, targetBounds);
      for (const level of thicknessLevels) {
        const rawSegments = thicknessSegmentsByLevel.get(level) || [];
        if (!rawSegments.length) {
          continue;
        }

        const isMajor = nearlyModulo(level, thicknessMajor);
        const isEmphasis = Math.abs(level - emphasisDam) < 0.001;
        const styleEntry = isEmphasis
          ? style?.thickness?.emphasis
          : isMajor
            ? style?.thickness?.major
            : style?.thickness?.minor;
        const colorHex = isEmphasis
          ? String(style?.thickness?.boundaryColor || "#6A1B9A")
          : level < emphasisDam
            ? String(style?.thickness?.coldColor || "#0072B2")
            : String(style?.thickness?.warmColor || "#D7302F");
        const alpha = Number.isFinite(Number(styleEntry?.alpha)) ? Number(styleEntry.alpha) : isMajor ? 0.72 : 0.6;
        const weight = Number.isFinite(Number(styleEntry?.widthPx))
          ? Number(styleEntry.widthPx)
          : isMajor
            ? 1.35
            : 0.95;
        const haloColor = String(styleEntry?.haloColor || "#FFFFFF");
        const haloAlpha = Number.isFinite(Number(styleEntry?.haloAlpha)) ? Number(styleEntry.haloAlpha) : 0.58;
        const haloWeight = Number.isFinite(Number(styleEntry?.haloWidthPx))
          ? Number(styleEntry.haloWidthPx)
          : isMajor
            ? 2.5
            : 2.0;
        const dash = Array.isArray(styleEntry?.dash) ? styleEntry.dash : [];

        const contours = postProcessContours(rawSegments, {
          simplifyTolerance: isMajor || isEmphasis ? 0.3 : 0.36,
          minLengthCells: isMajor || isEmphasis ? 5 : 6,
          minClosedAreaCells: isMajor || isEmphasis ? 10 : 14,
          smoothPasses: 2,
        });

        for (const contour of contours) {
          if (!Array.isArray(contour) || contour.length < 2) {
            continue;
          }
          const kind = isEmphasis ? "thickness-540" : isMajor ? "thickness-major" : "thickness-minor";
          const lineMeta = {
            kind,
            value: level,
            color: colorHex,
            alpha,
            width: weight,
            dash,
          };
          const encodedLine = encodeVectorLineProjected(lineMeta, contour, projectThicknessLatLon);
          vector.thickness.lines.push(encodedLine);
          vector.lines.push(encodedLine);

          if (rgba) {
            visibleCount += drawStyledContour(rgba, width, height, contour, thicknessCols, thicknessRows, {
              color: colorHex,
              alpha,
              weight,
              haloColor,
              haloAlpha,
              haloWeight,
              dash,
            });
          }
        }

        appendContourLabels({
          destination: vector.thickness.labels,
          fallback: vector.labels,
          contours,
          level,
          cols: thicknessCols,
          rows: thicknessRows,
          bounds: targetBounds,
          kind: isEmphasis ? "thickness-540" : isMajor ? "thickness-major" : "thickness-minor",
          color: colorHex,
          maxPerLevel: Math.min(isEmphasis ? 30 : 24, Math.max(isEmphasis ? 14 : 12, contours.length + 1)),
          minLength: 14,
        });
      }
    }
  }

  const centers = [];
  let centerGridCols = pressureCols;
  let centerGridRows = pressureRows;
  if (detectCenters !== false) {
    // H/L analysis has its own bounded, physically sized grid. Reusing the
    // simple contour grid made a declared 200 km locality test operate on
    // ~200-300 km cells, where the forced two-cell radius was really a
    // 400-600 km test. A ~50 km analysis grid gives the 200 km disc about four
    // independent radial samples while remaining tiny beside contour and
    // raster work. It is derived from the same source field regardless of
    // contour detail, so detail mode cannot change the scientific roster.
    const centerAnalysisGrid = prepareCenterAnalysisGrid(sourcePressureGrid, targetBounds);
    centerGridCols = centerAnalysisGrid?.cols || pressureCols;
    centerGridRows = centerAnalysisGrid?.rows || pressureRows;
    const centerPressureValues = centerAnalysisGrid
      ? smoothPressureField(
          centerAnalysisGrid.values,
          centerAnalysisGrid.cols,
          centerAnalysisGrid.rows,
          targetBounds,
          modelKey,
          style,
        )
      : smoothedPressure;
    const centerRefinement = buildCenterRefinementContext({
      grid: normalizeGridPayload(refinementPressureGrid) || sourcePressureGrid,
      bounds: targetBounds,
      modelKey,
      style,
      detectionCols: centerGridCols,
      detectionRows: centerGridRows,
    });
    const detectionSpacingKm = estimateGridSpacingKm(targetBounds, centerGridCols, centerGridRows);
    centers.push(
      ...detectPressureCenters(
        centerPressureValues,
        centerGridCols,
        centerGridRows,
        style,
        centerRefinement,
        detectionSpacingKm,
        normalizedCenterValidationMode === "row-aware-diagnostic"
          ? {
              bounds: targetBounds,
              mode: normalizedCenterValidationMode,
            }
          : null,
      ),
    );
  }
  const centerMetadata = { highs: [], lows: [] };
  for (const center of centers) {
    // Center metadata is an analyst-facing quality statement. Never emit a
    // marker whose refined pressure or annular prominence is non-finite: JSON
    // would silently turn Infinity into null and make a fabricated global
    // extremum look like a valid, unqualified pressure center.
    if (!Number.isFinite(center?.value) || !Number.isFinite(center?.prominence)) {
      continue;
    }
    const latLon = toLatLon(center.x, center.y, centerGridCols, centerGridRows, targetBounds);
    if (!Number.isFinite(latLon[0]) || !Number.isFinite(latLon[1])) {
      continue;
    }
    const metadata = {
      lat: latLon[0],
      lon: latLon[1],
      valueHpa: Math.round(center.value),
      prominenceHpa: Number(center.prominence.toFixed(2)),
    };
    if (center.rowAwareValidation) {
      metadata.rowAwareValidation = { ...center.rowAwareValidation };
    }
    if (center.kind === "high") {
      centerMetadata.highs.push(metadata);
    } else {
      centerMetadata.lows.push(metadata);
    }
  }
  vector.centers = centerMetadata;

  return {
    rgba,
    visibleCount,
    centers: centerMetadata,
    vector,
  };
}

function renderHeightContourArtifacts({
  heightGrid,
  targetBounds,
  width,
  height,
  modelKey = "gfs",
  levelMb,
  intervalDam,
  detailMode = "simple",
  style = loadSynopticStyle(),
  drawImage = true,
}) {
  const styleVersion = String(style?.styleVersion || "v4-operational-contrast");
  const shouldDrawImage = drawImage !== false;
  const methodMetadata = buildHeightContourMethodMetadata(style, levelMb, intervalDam);
  const empty = createEmptyHeightContourOutput(width, height, styleVersion, {
    drawImage: shouldDrawImage,
    levelMb,
    intervalDam,
    methodMetadata,
  });
  const sourceHeightGrid = normalizeGridPayload(heightGrid);
  if (!sourceHeightGrid) {
    return empty;
  }

  const contourInterval = Number(intervalDam);
  if (!Number.isFinite(contourInterval) || contourInterval <= 0) {
    return empty;
  }

  const normalizedDetailMode = detailMode === "detailed" ? "detailed" : "simple";
  const simpleGridSize = resolveSimpleGridSize(width, height);
  const preparedHeightGrid =
    normalizedDetailMode === "simple"
      ? resampleGridBilinear(sourceHeightGrid, simpleGridSize.cols, simpleGridSize.rows)
      : sourceHeightGrid;
  if (!preparedHeightGrid) {
    return empty;
  }

  const heightValues = preparedHeightGrid.values;
  const rows = preparedHeightGrid.rows;
  const cols = preparedHeightGrid.cols;
  const smoothedHeight = smoothHeightContourField(heightValues, cols, rows, targetBounds, modelKey, style);
  const heightRange = findFiniteRange(smoothedHeight);
  if (!heightRange) {
    return empty;
  }

  const rgba = shouldDrawImage ? new Uint8Array(width * height * 4) : null;
  const vector = createEmptyHeightContourVector(styleVersion, levelMb, contourInterval, methodMetadata);
  let visibleCount = 0;
  const levels = buildHeightContourLevels(heightRange.min, heightRange.max, contourInterval);
  const segmentsByLevel = marchingSquaresMany(smoothedHeight, cols, rows, levels);
  for (const contourLevel of levels) {
    visibleCount += appendHeightContourLevel({
      contourLevel,
      contourInterval,
      rawSegments: segmentsByLevel.get(contourLevel) || [],
      cols,
      rows,
      targetBounds,
      levelMb,
      vector,
      rgba,
      width,
      height,
    });
  }

  return {
    rgba,
    visibleCount,
    vector,
  };
}

function appendHeightContourLevel({
  contourLevel,
  contourInterval,
  rawSegments,
  cols,
  rows,
  targetBounds,
  levelMb,
  vector,
  rgba,
  width,
  height,
}) {
  if (!rawSegments.length) {
    return 0;
  }
  const isMajor = nearlyModulo(contourLevel, contourInterval * 2);
  const kind = isMajor ? `height-${levelMb}-major` : `height-${levelMb}-minor`;
  const paint = resolveHeightContourPaint(isMajor);
  const contours = postProcessContours(rawSegments, {
    simplifyTolerance: isMajor ? 0.26 : 0.32,
    minLengthCells: isMajor ? 4 : 5,
    minClosedAreaCells: isMajor ? 8 : 12,
    smoothPasses: 2,
  });
  const visibleCount = appendHeightContourLines({
    contours,
    contourLevel,
    cols,
    rows,
    targetBounds,
    kind,
    paint,
    vector,
    rgba,
    width,
    height,
  });
  appendContourLabels({
    destination: vector.labels,
    fallback: null,
    contours,
    level: contourLevel,
    cols,
    rows,
    bounds: targetBounds,
    kind,
    color: paint.color,
    maxPerLevel: Math.min(isMajor ? 18 : 14, Math.max(isMajor ? 8 : 6, contours.length + 1)),
    minLength: isMajor ? 10 : 12,
  });
  return visibleCount;
}

function appendHeightContourLines({
  contours,
  contourLevel,
  cols,
  rows,
  targetBounds,
  kind,
  paint,
  vector,
  rgba,
  width,
  height,
}) {
  let visibleCount = 0;
  const projectLatLon = projectGridLatLon(cols, rows, targetBounds);
  for (const contour of contours) {
    if (!Array.isArray(contour) || contour.length < 2) {
      continue;
    }
    vector.lines.push(
      encodeVectorLineProjected(
        {
          kind,
          value: contourLevel,
          color: paint.color,
          alpha: paint.alpha,
          width: paint.weight,
        },
        contour,
        projectLatLon,
      ),
    );

    if (rgba) {
      visibleCount += drawStyledContour(rgba, width, height, contour, cols, rows, {
        color: paint.color,
        alpha: paint.alpha,
        weight: paint.weight,
        haloColor: paint.haloColor,
        haloAlpha: paint.haloAlpha,
        haloWeight: paint.haloWeight,
        dash: [],
      });
    }
  }
  return visibleCount;
}

function createEmptyOutput(width, height, styleVersion, { drawImage = true, methodMetadata = null } = {}) {
  return {
    rgba: drawImage ? new Uint8Array(width * height * 4) : null,
    visibleCount: 0,
    centers: { highs: [], lows: [] },
    vector: createEmptyVector(styleVersion, methodMetadata),
  };
}

function createEmptyVector(styleVersion, methodMetadata = null) {
  return {
    styleVersion,
    method: methodMetadata,
    isobars: {
      lines: [],
      labels: [],
    },
    thickness: {
      lines: [],
      labels: [],
    },
    centers: { highs: [], lows: [] },
    // Backward compatibility for older readers.
    lines: [],
    labels: [],
  };
}

function createEmptyHeightContourOutput(
  width,
  height,
  styleVersion,
  { drawImage = true, levelMb, intervalDam, methodMetadata = null } = {},
) {
  return {
    rgba: drawImage ? new Uint8Array(width * height * 4) : null,
    visibleCount: 0,
    vector: createEmptyHeightContourVector(styleVersion, levelMb, intervalDam, methodMetadata),
  };
}

function createEmptyHeightContourVector(styleVersion, levelMb, intervalDam, methodMetadata = null) {
  return {
    styleVersion,
    layerType: "height-contour",
    method: methodMetadata,
    contourLevelMb: Number.isFinite(Number(levelMb)) ? Number(levelMb) : null,
    contourIntervalDam: Number.isFinite(Number(intervalDam)) ? Number(intervalDam) : null,
    lines: [],
    labels: [],
  };
}

function buildSynopticMethodMetadata(style, detailMode, centerValidationMode = "off") {
  const minorIntervalHpa = Number(style?.mslp?.minorIntervalHpa || 4);
  const majorIntervalHpa = Number(style?.mslp?.majorIntervalHpa || 8);
  const thicknessMinorIntervalDam = Number(style?.thickness?.minorIntervalDam || 6);
  const thicknessMajorIntervalDam = Number(style?.thickness?.majorIntervalDam || 12);
  const thicknessEmphasisDam = Number(style?.thickness?.emphasisDam || 540);
  return {
    methodVersion: "synoptic-mslp-thickness-automated-centers-v3",
    detailMode,
    isobars: {
      minorIntervalHpa,
      majorIntervalHpa,
      presentationSmoothing: "model-dependent Gaussian smoothing",
    },
    thickness: {
      minorIntervalDam: thicknessMinorIntervalDam,
      majorIntervalDam: thicknessMajorIntervalDam,
      emphasisDam: thicknessEmphasisDam,
      emphasisRole: "synoptic thermal reference; not a deterministic precipitation-phase boundary",
    },
    centers: {
      classification: "automated model-guidance MSLP centers; not a human surface analysis",
      localityRadiusKm: CENTER_DETECTION_RADIUS_KM,
      analysisGridTargetSpacingKm: CENTER_ANALYSIS_TARGET_SPACING_KM,
      analysisGridMaxShape: [CENTER_ANALYSIS_MAX_ROWS, CENTER_ANALYSIS_MAX_COLS],
      prominenceMinHpa: resolveCenterProminenceThreshold(style),
      prominenceAnnulusKm: [CENTER_RING_INNER_KM, CENTER_RING_OUTER_KM],
      sameKindMinSeparationKm: CENTER_SAME_KIND_MIN_KM,
      maxPerKind: Number(style?.centers?.maxMarkersByBucket?.z4_6 || 18),
      emittedPressureField: "unsmoothed source/refinement MSLP",
      detailInvariant: true,
      ...(centerValidationMode === "row-aware-diagnostic"
        ? {
            rowAwareValidation: {
              methodVersion: ROW_AWARE_CENTER_VALIDATION_METHOD_VERSION,
              mode: "diagnostic-only",
              effectOnRoster: "none",
              distanceMethod: "great-circle distance at each Mercator analysis-grid row",
              evaluatedField: "once-smoothed center-analysis MSLP at the pre-refinement detection candidate",
              rosterDistanceEvaluation: "final refined and deduplicated emitted marker roster",
              coverageRule:
                "finite in-domain row-aware locality samples must cover at least 60% of a complete local-grid 200 km disc",
              disclosure:
                "Reports whether each retained marker independently passes row-aware locality, 300-500 km prominence, and retained-roster 450/300 km separation checks; it does not reject or reprioritize markers.",
            },
          }
        : {}),
    },
  };
}

function buildHeightContourMethodMetadata(style, levelMb, intervalDam) {
  const minorIntervalDam = Number(intervalDam);
  return {
    methodVersion: "hgt-pressure-contour-model-smoothed-v2",
    pressureLevelMb: Number.isFinite(Number(levelMb)) ? Number(levelMb) : null,
    minorIntervalDam: Number.isFinite(minorIntervalDam) ? minorIntervalDam : null,
    majorIntervalDam: Number.isFinite(minorIntervalDam) ? minorIntervalDam * 2 : null,
    presentationSmoothing: "model-dependent Gaussian smoothing",
    hoverField: "unsmoothed decoded HGT converted to dam",
    presentationInk: "theme-aware warm upper-air ink",
    styleVersion: String(style?.styleVersion || "v4-operational-contrast"),
  };
}

function normalizeGridPayload(grid) {
  if (!grid || !grid.values) {
    return null;
  }
  const rows = Number(grid.rows);
  const cols = Number(grid.cols);
  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 2 || cols < 2) {
    return null;
  }
  if (grid.values.length < rows * cols) {
    return null;
  }
  return {
    rows,
    cols,
    values: grid.values,
  };
}

function resolveSimpleGridSize(width, height) {
  return {
    cols: clampInt(Math.round(Number(width) / 64), 18, 48, 28),
    rows: clampInt(Math.round(Number(height) / 64), 10, 32, 16),
  };
}

// Center analysis is intentionally independent of contour density. At the
// 50 km target, a 200 km locality disc spans ~4 cells; a CONUS analysis is
// only about 119x73 (~8,700 cells). That resolution also represents the
// configured 30-60 km MSLP smoothing without a floor-strength substitute.
// Caps bound unusual domains and keep this work negligible beside the
// display-grid interpolation and PNG encoding.
const CENTER_ANALYSIS_TARGET_SPACING_KM = 50;
const CENTER_ANALYSIS_MAX_COLS = 128;
const CENTER_ANALYSIS_MAX_ROWS = 80;

function prepareCenterAnalysisGrid(sourceGrid, bounds) {
  if (!sourceGrid || !sourceGrid.values) {
    return null;
  }
  const size = resolveCenterAnalysisGridSize(bounds, sourceGrid.cols, sourceGrid.rows);
  return resampleGridBilinear(sourceGrid, size.cols, size.rows);
}

function resolveCenterAnalysisGridSize(bounds, sourceCols, sourceRows) {
  const cols = clampInt(sourceCols, 2, 4096, 2);
  const rows = clampInt(sourceRows, 2, 4096, 2);
  if (!bounds) {
    return {
      cols: Math.min(cols, CENTER_ANALYSIS_MAX_COLS),
      rows: Math.min(rows, CENTER_ANALYSIS_MAX_ROWS),
    };
  }
  const latSpanKm = Math.abs(Number(bounds.north) - Number(bounds.south)) * 111;
  const meanLat = ((Number(bounds.north) + Number(bounds.south)) / 2) * (Math.PI / 180);
  const lonSpanKm = Math.abs(Number(bounds.east) - Number(bounds.west)) * 111 * Math.max(0.2, Math.cos(meanLat));
  const requestedCols = clampInt(
    Math.ceil(lonSpanKm / CENTER_ANALYSIS_TARGET_SPACING_KM) + 1,
    18,
    CENTER_ANALYSIS_MAX_COLS,
    48,
  );
  const requestedRows = clampInt(
    Math.ceil(latSpanKm / CENTER_ANALYSIS_TARGET_SPACING_KM) + 1,
    10,
    CENTER_ANALYSIS_MAX_ROWS,
    32,
  );
  return {
    cols: Math.max(2, Math.min(cols, requestedCols)),
    rows: Math.max(2, Math.min(rows, requestedRows)),
  };
}

function resampleGridBilinear(grid, outCols, outRows) {
  if (!grid || !grid.values) {
    return null;
  }
  const srcCols = Number(grid.cols);
  const srcRows = Number(grid.rows);
  const targetCols = clampInt(outCols, 2, 4096, srcCols);
  const targetRows = clampInt(outRows, 2, 4096, srcRows);
  if (!Number.isFinite(srcCols) || !Number.isFinite(srcRows) || srcCols < 2 || srcRows < 2) {
    return null;
  }
  if (targetCols === srcCols && targetRows === srcRows) {
    return {
      rows: srcRows,
      cols: srcCols,
      values: grid.values,
    };
  }

  // Every target cell is assigned in the loop below (sampleGridBilinear
  // returns NaN when no tap is usable), so the NaN prefill was redundant.
  const out = new Float32Array(targetRows * targetCols);
  for (let y = 0; y < targetRows; y += 1) {
    const gy = (y / Math.max(1, targetRows - 1)) * (srcRows - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(srcRows - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < targetCols; x += 1) {
      const gx = (x / Math.max(1, targetCols - 1)) * (srcCols - 1);
      const x0 = Math.floor(gx);
      const x1 = Math.min(srcCols - 1, x0 + 1);
      const tx = gx - x0;
      out[y * targetCols + x] = sampleGridBilinear(grid.values, srcCols, x0, x1, y0, y1, tx, ty);
    }
  }
  return {
    rows: targetRows,
    cols: targetCols,
    values: out,
  };
}

function sampleGridBilinear(values, cols, x0, x1, y0, y1, tx, ty) {
  const i00 = y0 * cols + x0;
  const i10 = y0 * cols + x1;
  const i01 = y1 * cols + x0;
  const i11 = y1 * cols + x1;
  const v00 = Number(values[i00]);
  const v10 = Number(values[i10]);
  const v01 = Number(values[i01]);
  const v11 = Number(values[i11]);
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  let sum = 0;
  let weight = 0;
  if (Number.isFinite(v00)) {
    sum += v00 * w00;
    weight += w00;
  }
  if (Number.isFinite(v10)) {
    sum += v10 * w10;
    weight += w10;
  }
  if (Number.isFinite(v01)) {
    sum += v01 * w01;
    weight += w01;
  }
  if (Number.isFinite(v11)) {
    sum += v11 * w11;
    weight += w11;
  }
  return weight > 0 ? sum / weight : Number.NaN;
}

function appendContourLabels({
  destination,
  fallback,
  contours,
  level,
  cols,
  rows,
  bounds,
  kind,
  color,
  maxPerLevel = 10,
  minLength = 18,
}) {
  let placed = 0;
  const ranked = [...contours]
    .map((contour) => ({ contour, length: contourLength(contour) }))
    .filter((entry) => Number.isFinite(entry.length) && entry.length >= minLength)
    .sort((left, right) => right.length - left.length);

  for (const entry of ranked) {
    if (placed >= maxPerLevel) {
      break;
    }
    const candidate = interpolateContourMidpoint(entry.contour);
    if (!candidate) {
      continue;
    }
    let angleDeg = Number(candidate.angleDeg || 0);
    if (angleDeg > 90) {
      angleDeg -= 180;
    } else if (angleDeg < -90) {
      angleDeg += 180;
    }
    const point = toLatLon(candidate.x, candidate.y, cols, rows, bounds);
    const label = {
      kind,
      text: String(Math.round(level)),
      lat: point[0],
      lon: point[1],
      color,
      angleDeg,
    };
    destination.push(label);
    if (fallback && fallback !== destination) {
      fallback.push(label);
    }
    placed += 1;
  }
}

function postProcessContours(
  segments,
  { simplifyTolerance = 0.28, minLengthCells = 6, minClosedAreaCells = 20, smoothPasses = 1 } = {},
) {
  const polylines = segmentsToPolylines(segments);
  const out = [];
  for (const polyline of polylines) {
    if (!Array.isArray(polyline) || polyline.length < 2) {
      continue;
    }
    const simplified = simplifyRdp(polyline, simplifyTolerance);
    if (!Array.isArray(simplified) || simplified.length < 2) {
      continue;
    }
    const length = contourLength(simplified);
    if (!Number.isFinite(length) || length < minLengthCells) {
      continue;
    }
    const closed = pointsNear(simplified[0], simplified[simplified.length - 1], 0.25);
    if (closed) {
      const area = Math.abs(polygonArea(simplified));
      if (!Number.isFinite(area) || area < minClosedAreaCells) {
        continue;
      }
    }
    const smoothed = smoothContourPolyline(simplified, smoothPasses);
    out.push(smoothed.length >= 2 ? smoothed : simplified);
  }
  return out;
}

function smoothContourPolyline(points, passes = 1) {
  if (!Array.isArray(points) || points.length < 3 || !Number.isFinite(passes) || passes <= 0) {
    return points;
  }
  const isClosed = pointsNear(points[0], points[points.length - 1], 0.25);
  let current = isClosed ? points.slice(0, -1) : [...points];
  if (current.length < 3) {
    return points;
  }

  for (let pass = 0; pass < Math.floor(passes); pass += 1) {
    if (current.length < 3) {
      break;
    }
    const next = [];
    const segmentCount = isClosed ? current.length : current.length - 1;
    if (!isClosed) {
      next.push(current[0]);
    }
    for (let index = 0; index < segmentCount; index += 1) {
      const a = current[index];
      const b = current[(index + 1) % current.length];
      next.push(
        {
          x: 0.75 * a.x + 0.25 * b.x,
          y: 0.75 * a.y + 0.25 * b.y,
        },
        {
          x: 0.25 * a.x + 0.75 * b.x,
          y: 0.25 * a.y + 0.75 * b.y,
        },
      );
    }
    if (!isClosed) {
      next.push(current[current.length - 1]);
    }
    current = dedupeContourPoints(next);
  }

  if (isClosed && current.length > 1) {
    return [...current, current[0]];
  }
  return current;
}

function dedupeContourPoints(points) {
  const out = [];
  for (const point of points) {
    if (!out.length || !pointsNear(out[out.length - 1], point, 1e-6)) {
      out.push(point);
    }
  }
  return out;
}

function resolveMslpSigmaKm(modelKey, style) {
  const sigmaByModel = style?.smoothing?.mslpSigmaKmByModel || {};
  return Number(sigmaByModel?.[modelKey] || sigmaByModel?.gfs || 45);
}

// Both smoothers may return the input array itself when no kernel runs
// (aliasing, not a copy) — smoothed fields are read-only downstream.
function smoothPressureField(values, width, height, bounds, modelKey, style) {
  const sigmaKm = resolveMslpSigmaKm(modelKey, style);
  if (!Number.isFinite(sigmaKm) || sigmaKm <= 0) {
    return values;
  }
  const spacingKm = estimateGridSpacingKm(bounds, width, height);
  const rawSigmaCells = sigmaKm / Math.max(1e-6, spacingKm);
  // Sub-floor sigma means the per-model policy is inert on this grid: the 64x
  // downsample has already low-passed far beyond it, and the floor-clamped
  // kernel was silent extra smoothing. Skip it (slightly sharpens the field).
  if (rawSigmaCells < 0.6) {
    return values;
  }
  const sigmaCells = clamp(rawSigmaCells, 0.6, 4.5);
  return gaussianBlur(values, width, height, sigmaCells);
}

function smoothHeightContourField(values, width, height, bounds, modelKey, style) {
  const sigmaByModel = style?.smoothing?.heightSigmaKmByModel || style?.smoothing?.mslpSigmaKmByModel || {};
  const sigmaKm = Number(sigmaByModel?.[modelKey] || sigmaByModel?.gfs || 45);
  if (!Number.isFinite(sigmaKm) || sigmaKm <= 0) {
    return values;
  }
  const spacingKm = estimateGridSpacingKm(bounds, width, height);
  const rawSigmaCells = sigmaKm / Math.max(1e-6, spacingKm);
  // Same sub-floor skip as smoothPressureField: an inert sigma policy must
  // not smuggle in a floor-strength kernel.
  if (rawSigmaCells < 0.6) {
    return values;
  }
  const sigmaCells = clamp(rawSigmaCells, 0.6, 4.5);
  return gaussianBlur(values, width, height, sigmaCells);
}

function buildHeightContourLevels(minValue, maxValue, intervalDam) {
  const interval = Number(intervalDam);
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue) || !Number.isFinite(interval) || interval <= 0) {
    return [];
  }
  const start = Math.ceil(minValue / interval) * interval;
  const end = Math.floor(maxValue / interval) * interval;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return [];
  }
  const levels = [];
  const maxLevels = 512;
  for (let level = start; level <= end + interval * 0.001 && levels.length < maxLevels; level += interval) {
    levels.push(Number(level.toFixed(6)));
  }
  return levels;
}

function buildSteppedLevels(startValue, endValue, intervalValue) {
  const start = Number(startValue);
  const end = Number(endValue);
  const interval = Number(intervalValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(interval) || interval <= 0 || end < start) {
    return [];
  }
  const levels = [];
  // Same guard as buildHeightContourLevels: a mis-scaled field (e.g. Pa
  // instead of hPa) must yield a bounded bad frame, not tens of thousands of
  // contour levels. Real MSLP/thickness level counts sit far below the cap.
  const maxLevels = 512;
  for (let level = start; level <= end + interval * 0.001 && levels.length < maxLevels; level += interval) {
    levels.push(Number(level.toFixed(6)));
  }
  return levels;
}

function resolveHeightContourPaint(isMajor) {
  return {
    color: "#171717",
    alpha: isMajor ? 0.82 : 0.72,
    weight: isMajor ? 1.45 : 1.08,
    haloColor: "#FFFFFF",
    haloAlpha: isMajor ? 0.52 : 0.44,
    haloWeight: isMajor ? 2.8 : 2.25,
  };
}

function estimateGridSpacingKm(bounds, cols, rows) {
  if (!bounds || !Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) {
    return 25;
  }
  const latSpanKm = Math.abs(bounds.north - bounds.south) * 111.0;
  const meanLat = ((bounds.north + bounds.south) / 2) * (Math.PI / 180);
  const lonSpanKm = Math.abs(bounds.east - bounds.west) * 111.0 * Math.max(0.2, Math.cos(meanLat));
  const dLat = latSpanKm / Math.max(1, rows - 1);
  const dLon = lonSpanKm / Math.max(1, cols - 1);
  return Math.max(4, (dLat + dLon) * 0.5);
}

function gaussianBlur(values, width, height, sigma) {
  const kernel = buildGaussianKernel(sigma);
  const temp = convolve1D(values, width, height, kernel, "x");
  return convolve1D(temp, width, height, kernel, "y");
}

function buildGaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 2.6));
  const size = radius * 2 + 1;
  const out = new Float32Array(size);
  let sum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    out[i + radius] = weight;
    sum += weight;
  }
  for (let i = 0; i < out.length; i += 1) {
    out[i] /= sum;
  }
  return { radius, weights: out };
}

function convolve1D(values, width, height, kernel, axis) {
  const out = new Float32Array(values.length).fill(Number.NaN);
  const radius = kernel.radius;
  const weights = kernel.weights;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let weightedSum = 0;
      let weightTotal = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const xx = axis === "x" ? x + k : x;
        const yy = axis === "y" ? y + k : y;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) {
          continue;
        }
        const sample = Number(values[yy * width + xx]);
        if (!Number.isFinite(sample)) {
          continue;
        }
        const weight = weights[k + radius];
        weightedSum += sample * weight;
        weightTotal += weight;
      }
      if (weightTotal > 0) {
        out[y * width + x] = weightedSum / weightTotal;
      }
    }
  }
  return out;
}

// H/L detection scales in PHYSICAL units (audit 2026-07-09): the legacy
// fixed cell counts meant ~1000 km windows on the simple grid but ~64 km on
// the detailed grid — a 15× mismatch. Kilometre targets, converted per grid
// and clamped to sane cell counts, gate both modes on the same synoptic
// scale. Prominence 1.8 hPa over a 300–500 km annulus ≈ the classic "at
// least one closed 2 hPa isobar" center-marking rule.
//
// Role separation (met review 2026-07-10): the strict-extremum disc tests
// LOCALITY only — at 400 km it conflated "is a local closed center" with "is
// the deepest system within 400 km", erasing a real 1007 hPa New England low
// sitting ~390 km from a deeper cell of the separate Quebec trough (NAM
// 20260710-00Z f003). Multi-system separation belongs to curation (450 km
// same-kind minimum), and roster RANKING weighs prominence re-measured on a
// SYNOPTIC_MERIT_SIGMA_KM-smoothed field, where mesoscale terrain-reduction
// bullseyes collapse but real broad systems survive.
const CENTER_DETECTION_RADIUS_KM = 200; // strict-extremum disc (locality only)
const CENTER_RING_INNER_KM = 300; // prominence annulus (background env)
const CENTER_RING_OUTER_KM = 500;
const CENTER_SAME_KIND_MIN_KM = 450; // distinct same-kind systems
const CENTER_OPPOSING_MIN_KM = 300; // H/L pair suppression radius
const SYNOPTIC_MERIT_SIGMA_KM = 120; // roster-ranking smoothing scale
const DEFAULT_CENTER_PROMINENCE_MIN_HPA = 1.8;
const ROW_AWARE_CENTER_VALIDATION_METHOD_VERSION = "row-aware-center-validation-diagnostic-v1";

function resolveCenterProminenceThreshold(style) {
  const configured = Number(style?.centers?.prominenceMinHpa);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_CENTER_PROMINENCE_MIN_HPA;
}

function detectPressureCenters(values, width, height, style, refinement, spacingKm, validationContext = null) {
  const prominenceThreshold = resolveCenterProminenceThreshold(style);
  const cellKm = Number.isFinite(spacingKm) && spacingKm > 0 ? spacingKm : 25;
  // Min 2 cells keeps the disc from degenerating to the ±1 ring for direct
  // callers with coarse inputs. Production center analysis uses the bounded
  // ~50 km grid above, where four cells genuinely approximate the 200 km
  // locality declared in method metadata.
  const radius = clamp(Math.round(CENTER_DETECTION_RADIUS_KM / cellKm), 2, 24);
  const ringInner = clamp(Math.round(CENTER_RING_INNER_KM / cellKm), 1, 31);
  const ringOuter = clamp(Math.round(CENTER_RING_OUTER_KM / cellKm), ringInner + 1, 32);
  // Perf guard (renderer hot path): stride-sample large discs so the per-pixel
  // sample count stays near the legacy 9x9 cost on the detailed grid. The
  // strided disc always retains the ±1 ring (see offsetsWithinRadius), which
  // keeps the strict-extremum test stride-independent: a cell adjacent to a
  // higher/lower cell can never pass, whatever the stride. The annulus gets
  // its own (coarser) stride — it only estimates a background mean, and ~50
  // samples are statistically plenty.
  const stride = Math.max(1, Math.floor(radius / 4));
  const ringStride = Math.max(1, Math.floor(ringOuter / 5));
  const extremumEpsilon = 0.03;
  const neighborhood = offsetsWithinRadius(radius, true, stride);
  const ring = offsetsInAnnulus(ringInner, ringOuter, ringStride);
  const candidates = [];
  // Near-edge recovery (met review 2026-07-10): a full-disc inset of ~radius
  // cells meant landfalling/offshore systems got no marker until their core
  // crossed ~radius·spacing into the domain and popped into existence. Scan
  // every cell whose full ±1 adjacent ring is in-domain and judge the strict
  // test on the disc samples that exist, gated by a quorum: >=60% of the disc
  // must be in-domain AND finite (native model domains can end inside the
  // view), plus the existing ringCount >= 8 annulus floor.
  const discQuorum = Math.ceil(neighborhood.length * 0.6);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const centerValue = Number(values[y * width + x]);
      if (!Number.isFinite(centerValue)) {
        continue;
      }
      let strictMax = true;
      let strictMin = true;
      let hasHigher = false;
      let hasLower = false;
      let discCount = 0;
      let ringSum = 0;
      let ringCount = 0;

      for (const offset of neighborhood) {
        const xx = x + offset.dx;
        const yy = y + offset.dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) {
          continue;
        }
        const sample = Number(values[yy * width + xx]);
        if (!Number.isFinite(sample)) {
          continue;
        }
        discCount += 1;
        if (sample > centerValue + extremumEpsilon) {
          strictMax = false;
        }
        if (sample < centerValue - extremumEpsilon) {
          strictMin = false;
        }
        if (sample > centerValue + 0.04) {
          hasHigher = true;
        }
        if (sample < centerValue - 0.04) {
          hasLower = true;
        }
      }

      // The annulus extends past the ±1 scan inset, so bounds-check every
      // sample (the legacy 3-5 ring read past row 0 into wrapped indices).
      for (const offset of ring) {
        const xx = x + offset.dx;
        const yy = y + offset.dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) {
          continue;
        }
        const sample = Number(values[yy * width + xx]);
        if (!Number.isFinite(sample)) {
          continue;
        }
        ringSum += sample;
        ringCount += 1;
      }

      if (discCount < discQuorum || ringCount < 8) {
        continue;
      }
      const ringMean = ringSum / ringCount;
      if (strictMax && hasLower) {
        const prominence = centerValue - ringMean;
        if (prominence >= prominenceThreshold) {
          candidates.push({
            kind: "high",
            x,
            y,
            value: centerValue,
            prominence,
            score: prominence + Math.max(0, (centerValue - 1013.25) * 0.12),
          });
        }
      }
      if (strictMin && hasHigher) {
        const prominence = ringMean - centerValue;
        if (prominence >= prominenceThreshold) {
          candidates.push({
            kind: "low",
            x,
            y,
            value: centerValue,
            prominence,
            score: prominence + Math.max(0, (1013.25 - centerValue) * 0.12),
          });
        }
      }
    }
  }

  rescoreCandidatesBySynopticMerit(candidates, values, width, height, cellKm, ring);

  // Marker curation (same-kind spacing, opposing-overlap suppression) is a
  // detection-scale concern, so it runs on detection-grid positions BEFORE
  // refinement; sub-cell position refinement must not flip curation decisions.
  // Deliberate consequence: separation is enforced at detection positions, so
  // two same-kind markers can RENDER closer than the minimum after refinement.
  const resolved = resolveOpposingCenterOverlaps(
    selectDistinctCenters(
      candidates.filter((entry) => entry.kind === "high"),
      style,
      cellKm,
    ),
    selectDistinctCenters(
      candidates.filter((entry) => entry.kind === "low"),
      style,
      cellKm,
    ),
    cellKm,
  );
  const annotateRowAwareValidation = (entry) => {
    if (validationContext?.mode !== "row-aware-diagnostic" || !validationContext?.bounds) {
      return entry;
    }
    const rowAwareValidation = validateCenterCandidateRowAware({
      values,
      width,
      height,
      bounds: validationContext.bounds,
      candidate: entry,
      prominenceThreshold,
    });
    return rowAwareValidation
      ? {
          ...entry,
          rowAwareValidation,
        }
      : entry;
  };
  let highs = dedupeRefinedCenters(
    resolved.highs.map(annotateRowAwareValidation).map((entry) => refineCenterAgainstField(entry, refinement, "high")),
    refinement,
  );
  let lows = dedupeRefinedCenters(
    resolved.lows.map(annotateRowAwareValidation).map((entry) => refineCenterAgainstField(entry, refinement, "low")),
    refinement,
  );
  if (validationContext?.mode === "row-aware-diagnostic" && validationContext?.bounds) {
    const rowAwareRosterDistances = validateCenterRosterDistancesRowAware({
      highs,
      lows,
      width,
      height,
      bounds: validationContext.bounds,
    });
    const attachRosterValidation = (entry) => {
      if (!entry?.rowAwareValidation) {
        return entry;
      }
      const rosterValidation = rowAwareRosterDistances.get(entry) || {};
      return {
        ...entry,
        rowAwareValidation: {
          ...entry.rowAwareValidation,
          rosterEvaluatedAt: "final refined emitted roster",
          ...rosterValidation,
          passesAllChecks: entry.rowAwareValidation.passesAllChecks && rosterValidation.rosterSeparationPass !== false,
        },
      };
    };
    highs = highs.map(attachRosterValidation);
    lows = lows.map(attachRosterValidation);
  }
  return [...highs, ...lows];
}

// Independent diagnostic for the latitude/row approximation used by the hot
// detection path. It samples the retained candidate against the same smoothed
// field, but distance membership is determined with great-circle kilometres
// for every analysis-grid row. Results are attached only in the explicit
// prototype mode and are never consumed by selection or curation.
function validateCenterCandidateRowAware({
  values,
  width,
  height,
  bounds,
  candidate,
  prominenceThreshold = DEFAULT_CENTER_PROMINENCE_MIN_HPA,
}) {
  if (
    !values ||
    !bounds ||
    !(width >= 2) ||
    !(height >= 2) ||
    !candidate ||
    (candidate.kind !== "high" && candidate.kind !== "low")
  ) {
    return null;
  }
  const centerValue = Number(candidate.value);
  const [centerLat, centerLon] = toLatLon(candidate.x, candidate.y, width, height, bounds);
  if (!Number.isFinite(centerValue) || !Number.isFinite(centerLat) || !Number.isFinite(centerLon)) {
    return null;
  }

  const extremumEpsilon = 0.03;
  const contrastEpsilon = 0.04;
  let localExtremum = true;
  let contrastObserved = false;
  let finiteLocalSamples = 0;
  let finiteAnnulusSamples = 0;
  let annulusSum = 0;
  const lonSpan = Number(bounds.east) - Number(bounds.west);
  for (let y = 0; y < height; y += 1) {
    const lat = rowToLatMercator(y, height, bounds);
    if (!Number.isFinite(lat)) {
      continue;
    }
    for (let x = 0; x < width; x += 1) {
      const value = Number(values[y * width + x]);
      if (!Number.isFinite(value)) {
        continue;
      }
      const lon = Number(bounds.west) + (x / Math.max(1, width - 1)) * lonSpan;
      const distanceKm = greatCircleDistanceKm(centerLat, centerLon, lat, lon);
      if (!Number.isFinite(distanceKm) || distanceKm < 1e-6) {
        continue;
      }
      if (distanceKm <= CENTER_DETECTION_RADIUS_KM) {
        finiteLocalSamples += 1;
        if (candidate.kind === "high") {
          if (value > centerValue + extremumEpsilon) {
            localExtremum = false;
          }
          if (value < centerValue - contrastEpsilon) {
            contrastObserved = true;
          }
        } else {
          if (value < centerValue - extremumEpsilon) {
            localExtremum = false;
          }
          if (value > centerValue + contrastEpsilon) {
            contrastObserved = true;
          }
        }
      }
      if (distanceKm >= CENTER_RING_INNER_KM && distanceKm <= CENTER_RING_OUTER_KM) {
        finiteAnnulusSamples += 1;
        annulusSum += value;
      }
    }
  }

  const annularProminence =
    finiteAnnulusSamples > 0
      ? (candidate.kind === "high" ? 1 : -1) * (centerValue - annulusSum / finiteAnnulusSamples)
      : Number.NaN;
  const expectedFullLocalSamples = expectedRowAwareLocalSampleCount({
    width,
    height,
    bounds,
    candidate,
    centerLat,
    centerLon,
  });
  const localCoverageFraction =
    expectedFullLocalSamples > 0 ? Math.min(1, finiteLocalSamples / expectedFullLocalSamples) : 0;
  const localCoverageMeets60Pct = localCoverageFraction >= 0.6;
  const threshold = Number.isFinite(Number(prominenceThreshold))
    ? Number(prominenceThreshold)
    : DEFAULT_CENTER_PROMINENCE_MIN_HPA;
  const meetsProminenceThreshold =
    finiteAnnulusSamples >= 8 && Number.isFinite(annularProminence) && annularProminence >= threshold;
  const distanceToDomainEdgeKm = Math.min(
    greatCircleDistanceKm(centerLat, centerLon, centerLat, Number(bounds.west)),
    greatCircleDistanceKm(centerLat, centerLon, centerLat, Number(bounds.east)),
    greatCircleDistanceKm(centerLat, centerLon, Number(bounds.south), centerLon),
    greatCircleDistanceKm(centerLat, centerLon, Number(bounds.north), centerLon),
  );
  return {
    methodVersion: ROW_AWARE_CENTER_VALIDATION_METHOD_VERSION,
    diagnosticOnly: true,
    evaluatedAt: "pre-refinement detection-grid candidate",
    localityRadiusKm: CENTER_DETECTION_RADIUS_KM,
    prominenceAnnulusKm: [CENTER_RING_INNER_KM, CENTER_RING_OUTER_KM],
    finiteLocalSamples,
    expectedFullLocalSamples,
    localCoverageFraction: Number(localCoverageFraction.toFixed(3)),
    localCoverageMeets60Pct,
    finiteAnnulusSamples,
    localExtremum,
    contrastObserved,
    annularProminenceHpa: Number.isFinite(annularProminence) ? Number(annularProminence.toFixed(2)) : null,
    meetsProminenceThreshold,
    passesAllChecks: localCoverageMeets60Pct && localExtremum && contrastObserved && meetsProminenceThreshold,
    domainTruncatedWithin500Km:
      Number.isFinite(distanceToDomainEdgeKm) && distanceToDomainEdgeKm < CENTER_RING_OUTER_KM,
  };
}

function expectedRowAwareLocalSampleCount({ width, height, bounds, candidate, centerLat, centerLon }) {
  const lonStepDeg = Math.abs(Number(bounds.east) - Number(bounds.west)) / Math.max(1, width - 1);
  const row = Math.max(0, Math.min(height - 1, Math.round(Number(candidate.y))));
  const neighborLats = [];
  if (row > 0) {
    neighborLats.push(rowToLatMercator(row - 1, height, bounds));
  }
  if (row < height - 1) {
    neighborLats.push(rowToLatMercator(row + 1, height, bounds));
  }
  const latStepDeg =
    neighborLats
      .map((lat) => Math.abs(Number(lat) - centerLat))
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((sum, value, _index, values) => sum + value / values.length, 0) ||
    Math.abs(Number(bounds.north) - Number(bounds.south)) / Math.max(1, height - 1);
  const xStepKm = greatCircleDistanceKm(centerLat, centerLon, centerLat, centerLon + lonStepDeg);
  const yStepKm = greatCircleDistanceKm(centerLat, centerLon, centerLat + latStepDeg, centerLon);
  if (!(xStepKm > 0) || !(yStepKm > 0)) {
    return 0;
  }
  const maxDx = Math.ceil(CENTER_DETECTION_RADIUS_KM / xStepKm) + 1;
  const maxDy = Math.ceil(CENTER_DETECTION_RADIUS_KM / yStepKm) + 1;
  let count = 0;
  for (let dy = -maxDy; dy <= maxDy; dy += 1) {
    for (let dx = -maxDx; dx <= maxDx; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      const virtualLat = centerLat - dy * latStepDeg;
      const virtualLon = centerLon + dx * lonStepDeg;
      const distanceKm = greatCircleDistanceKm(centerLat, centerLon, virtualLat, virtualLon);
      if (Number.isFinite(distanceKm) && distanceKm <= CENTER_DETECTION_RADIUS_KM) {
        count += 1;
      }
    }
  }
  return count;
}

function greatCircleDistanceKm(lat1, lon1, lat2, lon2) {
  const phi1 = (Number(lat1) * Math.PI) / 180;
  const phi2 = (Number(lat2) * Math.PI) / 180;
  const deltaPhi = ((Number(lat2) - Number(lat1)) * Math.PI) / 180;
  const deltaLambda = ((Number(lon2) - Number(lon1)) * Math.PI) / 180;
  if (![phi1, phi2, deltaPhi, deltaLambda].every(Number.isFinite)) {
    return Number.NaN;
  }
  const sinLat = Math.sin(deltaPhi / 2);
  const sinLon = Math.sin(deltaLambda / 2);
  const a = sinLat * sinLat + Math.cos(phi1) * Math.cos(phi2) * sinLon * sinLon;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(Math.max(0, a)), Math.sqrt(Math.max(0, 1 - a)));
}

function validateCenterRosterDistancesRowAware({ highs, lows, width, height, bounds }) {
  const highEntries = Array.isArray(highs) ? highs : [];
  const lowEntries = Array.isArray(lows) ? lows : [];
  const all = [
    ...highEntries.map((entry) => ({ entry, kind: "high" })),
    ...lowEntries.map((entry) => ({ entry, kind: "low" })),
  ];
  const locations = new Map(all.map(({ entry }) => [entry, toLatLon(entry.x, entry.y, width, height, bounds)]));
  const out = new Map();
  for (const current of all) {
    const location = locations.get(current.entry);
    let nearestSameKindKm = Number.POSITIVE_INFINITY;
    let nearestOpposingKindKm = Number.POSITIVE_INFINITY;
    for (const other of all) {
      if (other.entry === current.entry) {
        continue;
      }
      const otherLocation = locations.get(other.entry);
      const distanceKm = greatCircleDistanceKm(location?.[0], location?.[1], otherLocation?.[0], otherLocation?.[1]);
      if (!Number.isFinite(distanceKm)) {
        continue;
      }
      if (other.kind === current.kind) {
        nearestSameKindKm = Math.min(nearestSameKindKm, distanceKm);
      } else {
        nearestOpposingKindKm = Math.min(nearestOpposingKindKm, distanceKm);
      }
    }
    out.set(current.entry, {
      nearestSameKindKm: Number.isFinite(nearestSameKindKm) ? Number(nearestSameKindKm.toFixed(1)) : null,
      sameKindSeparationAtLeast450Km:
        !Number.isFinite(nearestSameKindKm) || nearestSameKindKm >= CENTER_SAME_KIND_MIN_KM,
      nearestOpposingKindKm: Number.isFinite(nearestOpposingKindKm) ? Number(nearestOpposingKindKm.toFixed(1)) : null,
      opposingSeparationAtLeast300Km:
        !Number.isFinite(nearestOpposingKindKm) || nearestOpposingKindKm >= CENTER_OPPOSING_MIN_KM,
      rosterSeparationPass:
        (!Number.isFinite(nearestSameKindKm) || nearestSameKindKm >= CENTER_SAME_KIND_MIN_KM) &&
        (!Number.isFinite(nearestOpposingKindKm) || nearestOpposingKindKm >= CENTER_OPPOSING_MIN_KM),
    });
  }
  return out;
}

// Roster ranking by synoptic-scale prominence (met review 2026-07-10):
// mesoscale terrain-reduction bullseyes (e.g. nocturnal Great Basin highs)
// carry raw annulus prominences that crowd real broad systems out of the
// capped, score-ordered roster. Re-measure each candidate's prominence on a
// SYNOPTIC_MERIT_SIGMA_KM-smoothed copy of the field — bullseyes collapse
// there, real closed systems survive — and rank by that. The 1.8 hPa
// detection GATE and emitted prominenceHpa stay on the once-smoothed detection
// field (rather than the additionally smoothed merit-ranking field).
function rescoreCandidatesBySynopticMerit(candidates, values, width, height, spacingKm, ringOffsets) {
  if (!candidates.length) {
    return;
  }
  const sigmaCells = SYNOPTIC_MERIT_SIGMA_KM / Math.max(1e-6, spacingKm);
  if (sigmaCells < 0.6) {
    // The grid's cells are already coarser than bullseye scale (simple mode):
    // the raw score is already synoptic-scale.
    return;
  }
  const smoothedField = gaussianBlur(values, width, height, Math.min(sigmaCells, 12));
  for (const candidate of candidates) {
    const centerValue = Number(smoothedField[candidate.y * width + candidate.x]);
    if (!Number.isFinite(centerValue)) {
      continue;
    }
    let ringSum = 0;
    let ringCount = 0;
    for (const offset of ringOffsets) {
      const xx = candidate.x + offset.dx;
      const yy = candidate.y + offset.dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) {
        continue;
      }
      const sample = Number(smoothedField[yy * width + xx]);
      if (!Number.isFinite(sample)) {
        continue;
      }
      ringSum += sample;
      ringCount += 1;
    }
    if (ringCount < 8) {
      continue;
    }
    const sign = candidate.kind === "high" ? 1 : -1;
    const synopticProminence = Math.max(0, sign * (centerValue - ringSum / ringCount));
    candidate.score = synopticProminence + Math.max(0, sign * (candidate.value - 1013.25) * 0.12);
  }
}

// ── Full-resolution center refinement (Task 4.5, owner-blessed, spec §8a.6) ──
//
// Detection runs on the smoothed center-analysis grid, which quantizes each
// center to a grid node. Coarse interpolation can sample off the true core and
// report a less-extreme value than the display field (mean ~1 hPa, max 6.7
// hPa; mean 46 km displaced in the 2026-07-07 audit). Refinement walks each
// candidate to the true extremum of the display-resolution MSLP field:
//
// 1. Hill-climb on a lightly pre-smoothed copy of the display field. NAM3km
//    MSLP carries grid-scale (~3-9 km) terrain-reduction artifacts; a 6 km
//    Gaussian (~2 native grid lengths) suppresses single-pixel noise pockets
//    while leaving synoptic cores (>=100 km scale) unattenuated, so the climb
//    settles on the physical core rather than a noise pixel.
// 2. Travel budget: detection quantizes position by up to half a detection
//    cell (diagonal ~0.71 cell) and Gaussian smoothing displaces an asymmetric
//    extremum by O(sigma), so the climb may travel one detection cell plus
//    2*sigma, floored at 120 km. Containment: the climb only ever moves to a
//    strictly better value within a 5x5 neighborhood (step = 2), so regardless
//    of budget it cannot cross a col/saddle wider than ~2 display pixels
//    (~7 km at CONUS display resolution) into a neighboring system. Narrower
//    cols are below the artifact scale that the sigma=6 km pre-smooth (step 1)
//    declares noise, so hopping them is intended noise-rejection, not a
//    containment defect.
// 3. Snap the emitted value AND position to the raw display-field extremum
//    within ~2 pre-smoothing sigmas of the settled core, so the marker agrees
//    with what hover inspection of the field reports. Values keep full
//    precision here; rounding happens once, at payload emit.
const CENTER_CLIMB_PRESMOOTH_SIGMA_KM = 6;
const CENTER_MIN_TRAVEL_KM = 120;
const CENTER_SAME_EXTREMUM_KM = 25;
// Native grid spacing per model (km): refinement must not report positions
// sharper than the source physics. Presmooth σ scales with native spacing so
// GFS (0.25° ≈ 27 km) centers stop resolving bilinear-upsample ripples at
// ~4 km false precision; the 3 km nests keep the tuned behavior.
const MODEL_NATIVE_SPACING_KM = { gfs: 27, nam: 12, nam3km: 3, hrrr: 3 };
const CLIMB_FIELD_CACHE = new WeakMap();
// Per-candidate climb patches (audit 2026-07-17, backlog #43): every climb-
// field read in refineCenterAgainstField stays inside the closed Euclidean
// disc of radius travelPx around the candidate's clamped seed — the seed tap,
// the no-data rescue ring scan (distSq <= limit^2, limit = travelPx), and the
// hill-climb neighborhood (travelSq = travelPx^2) — so the Gaussian + NaN
// re-mask only has to exist inside that disc. The blur kernel radius is
// max(1, ceil(sigmaPx * 2.6)) (buildGaussianKernel); a patch padded by that
// radius plus CLIMB_PATCH_SAFETY_PX beyond the disc is bit-identical to the
// full-grid blur across the whole disc: out-of-patch kernel taps are skipped
// (weights renormalized) exactly like out-of-grid taps, and the blit into the
// shared scratch field is shrunk by the radius on every side that does not
// coincide with the grid edge. Candidates whose patches would tile half the
// grid are cheaper as one full blur — identical bytes either way — so the
// path falls back. Patches bypass CLIMB_FIELD_CACHE: patch state lives on the
// per-grid context (rebuilt every render), so it can never serve values
// across grids; the full-blur fallback keeps the WeakMap and its guard.
const CLIMB_PATCH_SAFETY_PX = 2;
const CLIMB_PATCH_FULL_BLUR_FRACTION = 0.5;

function buildCenterRefinementContext({ grid, bounds, modelKey, style, detectionCols, detectionRows }) {
  if (!grid || !grid.values || !(grid.cols >= 2) || !(grid.rows >= 2)) {
    return null;
  }
  const resolvedStyle = style || loadSynopticStyle();
  const detectionSpacingKm = estimateGridSpacingKm(bounds, detectionCols, detectionRows);
  const spacingKm = estimateGridSpacingKm(bounds, grid.cols, grid.rows);
  const sigmaKm = resolveMslpSigmaKm(modelKey, resolvedStyle);
  const travelKm = Math.max(detectionSpacingKm + 2 * Math.max(0, sigmaKm), CENTER_MIN_TRAVEL_KM);
  const travelPx = Math.max(1, Math.round(travelKm / Math.max(1e-6, spacingKm)));
  // Half the model's native spacing floors the pre-smooth (see
  // MODEL_NATIVE_SPACING_KM); the artifact-scale 6 km sigma remains the
  // minimum, so the 3 km nests keep the tuned behavior. The snap radius below
  // derives from this sigma (~2 sigma), so it follows the native scale too.
  const presmoothSigmaKm = Math.max(CENTER_CLIMB_PRESMOOTH_SIGMA_KM, (MODEL_NATIVE_SPACING_KM[modelKey] ?? 6) / 2);
  const presmoothSigmaPx = clamp(presmoothSigmaKm / Math.max(1e-6, spacingKm), 0, 3);
  // The climb field (Gaussian + NaN re-mask) is the most expensive piece of
  // H/L analysis, so nothing builds it up front: detection never samples it,
  // and a frame whose detection finds no candidates skips the blur entirely.
  // refineCenterAgainstField resolves it per seed as padded patches (see
  // CLIMB_PATCH_SAFETY_PX); the climbValues getter keeps the full-grid build
  // as the fallback path and this context's public contract. gaussianBlur
  // always returns a fresh array, so snapRadiusPx keys off whether the
  // pre-smooth applies, not field identity.
  const appliesPresmooth = presmoothSigmaPx >= 0.45;
  const context = {
    values: grid.values,
    get climbValues() {
      return resolveFullClimbField(context);
    },
    cols: grid.cols,
    rows: grid.rows,
    travelPx,
    snapRadiusPx: appliesPresmooth ? Math.max(1, Math.round(presmoothSigmaPx * 2)) : 0,
    detectionCols,
    detectionRows,
    detectionSpacingKm,
    climbSigmaPx: appliesPresmooth ? presmoothSigmaPx : 0,
    climbPatchState: null,
    climbBuildStats: { fullBuilds: 0, patchBuilds: 0, patchedCells: 0 },
  };
  return context;
}

function resolveFullClimbField(refinement) {
  if (!(refinement.climbSigmaPx > 0)) {
    return refinement.values;
  }
  const state = ensureClimbPatchState(refinement);
  if (!state.full) {
    state.full = resolveClimbField(
      { values: refinement.values, cols: refinement.cols, rows: refinement.rows },
      refinement.climbSigmaPx,
    );
    refinement.climbBuildStats.fullBuilds += 1;
  }
  return state.full;
}

function ensureClimbPatchState(refinement) {
  if (!refinement.climbPatchState) {
    refinement.climbPatchState = { full: null, field: null, rects: [] };
  }
  return refinement.climbPatchState;
}

// Climb field for one candidate, blurred only over the padded patch around
// its seed. Reads never leave the travelPx disc (see CLIMB_PATCH_SAFETY_PX),
// and the patch is bit-identical to the full-grid blur across that disc.
function resolveClimbFieldForSeed(refinement, seedX, seedY) {
  if (!(refinement.climbSigmaPx > 0)) {
    return refinement.values;
  }
  const { cols, rows, travelPx } = refinement;
  const state = ensureClimbPatchState(refinement);
  if (state.full) {
    return state.full;
  }
  const read = {
    x0: Math.max(0, seedX - travelPx),
    x1: Math.min(cols - 1, seedX + travelPx),
    y0: Math.max(0, seedY - travelPx),
    y1: Math.min(rows - 1, seedY + travelPx),
  };
  if (state.field) {
    for (const rect of state.rects) {
      if (rect.x0 <= read.x0 && rect.x1 >= read.x1 && rect.y0 <= read.y0 && rect.y1 >= read.y1) {
        return state.field;
      }
    }
  }
  const radiusPx = Math.max(1, Math.ceil(refinement.climbSigmaPx * 2.6));
  const pad = travelPx + radiusPx + CLIMB_PATCH_SAFETY_PX;
  const patch = {
    x0: Math.max(0, seedX - pad),
    x1: Math.min(cols - 1, seedX + pad),
    y0: Math.max(0, seedY - pad),
    y1: Math.min(rows - 1, seedY + pad),
  };
  const patchCells = (patch.x1 - patch.x0 + 1) * (patch.y1 - patch.y0 + 1);
  if ((refinement.climbBuildStats.patchedCells + patchCells) / (cols * rows) >= CLIMB_PATCH_FULL_BLUR_FRACTION) {
    return resolveFullClimbField(refinement);
  }
  if (!state.field) {
    state.field = new Float32Array(cols * rows).fill(Number.NaN);
  }
  const patchCols = patch.x1 - patch.x0 + 1;
  const patchRows = patch.y1 - patch.y0 + 1;
  const patchValues = new Float32Array(patchCols * patchRows);
  for (let y = 0; y < patchRows; y += 1) {
    for (let x = 0; x < patchCols; x += 1) {
      patchValues[y * patchCols + x] = refinement.values[(patch.y0 + y) * cols + patch.x0 + x];
    }
  }
  const blurred = gaussianBlur(patchValues, patchCols, patchRows, refinement.climbSigmaPx);
  // Valid region: shrink the patch by the kernel radius on every side that
  // does not coincide with the grid edge; inside it the patch blur matches
  // the full-grid blur bit for bit. Apply the same NaN re-mask as
  // resolveClimbField while blitting into the shared scratch field.
  const bx0 = patch.x0 === 0 ? 0 : radiusPx;
  const by0 = patch.y0 === 0 ? 0 : radiusPx;
  const bx1 = patch.x1 === cols - 1 ? patchCols - 1 : patchCols - 1 - radiusPx;
  const by1 = patch.y1 === rows - 1 ? patchRows - 1 : patchRows - 1 - radiusPx;
  for (let y = by0; y <= by1; y += 1) {
    for (let x = bx0; x <= bx1; x += 1) {
      const patchIndex = y * patchCols + x;
      state.field[(patch.y0 + y) * cols + patch.x0 + x] = Number.isFinite(Number(patchValues[patchIndex]))
        ? blurred[patchIndex]
        : Number.NaN;
    }
  }
  state.rects.push({ x0: patch.x0 + bx0, x1: patch.x0 + bx1, y0: patch.y0 + by0, y1: patch.y0 + by1 });
  refinement.climbBuildStats.patchBuilds += 1;
  refinement.climbBuildStats.patchedCells += patchCells;
  return state.field;
}

function resolveClimbField(grid, sigmaPx) {
  const key = grid.values;
  const cached = typeof key === "object" && key !== null ? CLIMB_FIELD_CACHE.get(key) : null;
  if (cached && cached.cols === grid.cols && cached.rows === grid.rows && cached.sigmaPx === sigmaPx) {
    return cached.values;
  }
  const blurred = gaussianBlur(grid.values, grid.cols, grid.rows, sigmaPx);
  // The blur extrapolates a few pixels into no-data regions (the native model
  // domain can end inside the view, e.g. NAM3km in the SE Atlantic corner of
  // the CONUS frame). Mask those back to NaN so the climb cannot leave the
  // physical field and every emitted center has a raw, hover-readable value.
  for (let index = 0; index < blurred.length; index += 1) {
    if (!Number.isFinite(Number(grid.values[index]))) {
      blurred[index] = Number.NaN;
    }
  }
  if (typeof key === "object" && key !== null) {
    CLIMB_FIELD_CACHE.set(key, { cols: grid.cols, rows: grid.rows, sigmaPx, values: blurred });
  }
  return blurred;
}

function refineCenterAgainstField(center, refinement, kind = center?.kind) {
  if (!refinement) {
    return center;
  }
  const { values, cols, rows, travelPx, snapRadiusPx, detectionCols, detectionRows } = refinement;
  const scaleX = (cols - 1) / Math.max(1, detectionCols - 1);
  const scaleY = (rows - 1) / Math.max(1, detectionRows - 1);
  const seedX = clampInt(Math.round(center.x * scaleX), 0, cols - 1, 0);
  const seedY = clampInt(Math.round(center.y * scaleY), 0, rows - 1, 0);
  const climbValues = resolveClimbFieldForSeed(refinement, seedX, seedY);
  const sign = kind === "low" ? -1 : 1;
  const budgetPx = travelPx;
  let cx = seedX;
  let cy = seedY;
  let currentValue = Number(climbValues[cy * cols + cx]);
  if (!Number.isFinite(currentValue)) {
    // Detection grids extend into no-data zones through partial bilinear taps
    // and NaN-skipping smoothing, so a candidate can seed where the display
    // field is undefined (native model domain ending inside the view). Rescue
    // to the nearest real-data pixel so the marker reports the field's actual
    // edge extremum instead of an extrapolated value at an undefined position.
    const rescued = findNearestFinitePixel(climbValues, cols, rows, seedX, seedY, budgetPx);
    if (!rescued) {
      return center;
    }
    cx = rescued.x;
    cy = rescued.y;
    currentValue = rescued.value;
  }

  const travelSq = budgetPx * budgetPx;
  const step = 2;
  for (let iteration = 0; iteration < 4096; iteration += 1) {
    let bestX = cx;
    let bestY = cy;
    let bestValue = currentValue;
    for (let dy = -step; dy <= step; dy += 1) {
      for (let dx = -step; dx <= step; dx += 1) {
        if (dx === 0 && dy === 0) {
          continue;
        }
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) {
          continue;
        }
        const travelX = x - seedX;
        const travelY = y - seedY;
        if (travelX * travelX + travelY * travelY > travelSq) {
          continue;
        }
        const sample = Number(climbValues[y * cols + x]);
        if (!Number.isFinite(sample)) {
          continue;
        }
        if (sign * (sample - bestValue) > 0) {
          bestValue = sample;
          bestX = x;
          bestY = y;
        }
      }
    }
    if (bestX === cx && bestY === cy) {
      break;
    }
    cx = bestX;
    cy = bestY;
    currentValue = bestValue;
  }

  let outX = cx;
  let outY = cy;
  let outValue = Number(values[cy * cols + cx]);
  for (let dy = -snapRadiusPx; dy <= snapRadiusPx; dy += 1) {
    for (let dx = -snapRadiusPx; dx <= snapRadiusPx; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= cols || y >= rows) {
        continue;
      }
      const sample = Number(values[y * cols + x]);
      if (!Number.isFinite(sample)) {
        continue;
      }
      if (!Number.isFinite(outValue) || sign * (sample - outValue) > 0) {
        outValue = sample;
        outX = x;
        outY = y;
      }
    }
  }
  if (!Number.isFinite(outValue)) {
    outValue = currentValue;
    outX = cx;
    outY = cy;
  }

  return {
    ...center,
    x: outX / scaleX,
    y: outY / scaleY,
    value: outValue,
  };
}

function findNearestFinitePixel(values, cols, rows, seedX, seedY, maxRadiusPx) {
  const limit = Math.max(1, Math.round(maxRadiusPx));
  let best = null;
  for (let ring = 1; ring <= limit; ring += 1) {
    for (let dy = -ring; dy <= ring; dy += 1) {
      const onVerticalEdge = Math.abs(dy) === ring;
      const stepX = onVerticalEdge ? 1 : 2 * ring;
      for (let dx = -ring; dx <= ring; dx += stepX) {
        const x = seedX + dx;
        const y = seedY + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) {
          continue;
        }
        const distSq = dx * dx + dy * dy;
        if (distSq > limit * limit || (best && distSq >= best.distSq)) {
          continue;
        }
        const value = Number(values[y * cols + x]);
        if (!Number.isFinite(value)) {
          continue;
        }
        best = { x, y, value, distSq };
      }
    }
    // A pixel at Chebyshev ring r can be beaten (in Euclidean distance) only
    // by rings up to its Euclidean distance; once found, scan that far and stop.
    if (best && ring >= Math.ceil(Math.sqrt(best.distSq))) {
      break;
    }
  }
  return best;
}

// Refinement can walk two detection candidates onto the same physical
// extremum; collapse same-kind centers closer than ~CENTER_SAME_EXTREMUM_KM
// (input is score-ordered, so the stronger candidate survives).
function dedupeRefinedCenters(centers, refinement) {
  if (!refinement || !Array.isArray(centers) || centers.length <= 1) {
    return centers;
  }
  const thresholdCells = CENTER_SAME_EXTREMUM_KM / Math.max(1e-6, refinement.detectionSpacingKm);
  const thresholdSq = thresholdCells * thresholdCells;
  const out = [];
  for (const center of centers) {
    let duplicate = false;
    for (const existing of out) {
      const dx = existing.x - center.x;
      const dy = existing.y - center.y;
      if (dx * dx + dy * dy <= thresholdSq) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      out.push(center);
    }
  }
  return out;
}

function selectDistinctCenters(candidates, style, spacingKm) {
  const sorted = [...candidates].sort((left, right) => right.score - left.score);
  const out = [];
  const maxMarkers = Number(style?.centers?.maxMarkersByBucket?.z4_6 || 18);
  const minDistance = Math.max(2, Math.round(CENTER_SAME_KIND_MIN_KM / spacingKm));
  const minDistanceSq = minDistance * minDistance;
  for (const candidate of sorted) {
    if (out.length >= maxMarkers) {
      break;
    }
    let near = false;
    for (const existing of out) {
      const dx = existing.x - candidate.x;
      const dy = existing.y - candidate.y;
      if (dx * dx + dy * dy < minDistanceSq) {
        near = true;
        break;
      }
    }
    if (!near) {
      out.push(candidate);
    }
  }
  return out;
}

function resolveOpposingCenterOverlaps(highs, lows, spacingKm) {
  const keptHighs = [...highs];
  const keptLows = [...lows];
  const minDistance = Math.max(2, Math.round(CENTER_OPPOSING_MIN_KM / spacingKm));
  const minDistanceSq = minDistance * minDistance;

  for (let hi = keptHighs.length - 1; hi >= 0; hi -= 1) {
    const high = keptHighs[hi];
    for (let li = keptLows.length - 1; li >= 0; li -= 1) {
      const low = keptLows[li];
      const dx = high.x - low.x;
      const dy = high.y - low.y;
      if (dx * dx + dy * dy >= minDistanceSq) {
        continue;
      }
      const highScore = Math.abs(high.value - 1013.25) + Math.max(0, Number(high.prominence) || 0);
      const lowScore = Math.abs(low.value - 1013.25) + Math.max(0, Number(low.prominence) || 0);
      if (highScore >= lowScore) {
        keptLows.splice(li, 1);
      } else {
        keptHighs.splice(hi, 1);
        break;
      }
    }
  }
  return { highs: keptHighs, lows: keptLows };
}

const OFFSET_CACHE = new Map();

// stride > 1 keeps only offsets on the stride lattice (dx and dy both
// multiples of stride) — the detection perf guard for km-sized discs. The
// eight ±1-ring offsets are always retained regardless of stride: adjacent
// cells are what disqualify a near-extremum cell, so the strict-extremum
// property stays stride-independent (a cell beside a higher/lower cell can
// never pass, with no reliance on the field having been pre-smoothed).
function offsetsWithinRadius(radius, excludeCenter = false, stride = 1) {
  const key = `disc:${radius}:${excludeCenter ? 1 : 0}:${stride}`;
  const cached = OFFSET_CACHE.get(key);
  if (cached) {
    return cached;
  }
  const out = [];
  const radiusSq = radius * radius;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (excludeCenter && dx === 0 && dy === 0) {
        continue;
      }
      const inAdjacentRing = Math.max(Math.abs(dx), Math.abs(dy)) === 1;
      if (stride > 1 && !inAdjacentRing && (dx % stride || dy % stride)) {
        continue;
      }
      if (dx * dx + dy * dy <= radiusSq) {
        out.push({ dx, dy });
      }
    }
  }
  OFFSET_CACHE.set(key, out);
  return out;
}

function offsetsInAnnulus(innerRadius, outerRadius, stride = 1) {
  const key = `annulus:${innerRadius}:${outerRadius}:${stride}`;
  const cached = OFFSET_CACHE.get(key);
  if (cached) {
    return cached;
  }
  const out = [];
  const innerSq = innerRadius * innerRadius;
  const outerSq = outerRadius * outerRadius;
  for (let dy = -outerRadius; dy <= outerRadius; dy += 1) {
    for (let dx = -outerRadius; dx <= outerRadius; dx += 1) {
      if (stride > 1 && (dx % stride || dy % stride)) {
        continue;
      }
      const distSq = dx * dx + dy * dy;
      if (distSq >= innerSq && distSq <= outerSq) {
        out.push({ dx, dy });
      }
    }
  }
  OFFSET_CACHE.set(key, out);
  return out;
}

function drawStyledContour(buffer, width, height, contour, cols, rows, style) {
  if (!Array.isArray(contour) || contour.length < 2) {
    return 0;
  }
  let count = 0;
  const halo = hexToRgba(style.haloColor || "#FFFFFF", style.haloAlpha ?? 0.7);
  const stroke = hexToRgba(style.color || "#111111", style.alpha ?? 0.75);

  if (style.haloWeight > style.weight) {
    count += drawPolyline(buffer, width, height, contour, cols, rows, {
      rgba: halo,
      widthPx: style.haloWeight,
      dash: style.dash,
    });
  }
  count += drawPolyline(buffer, width, height, contour, cols, rows, {
    rgba: stroke,
    widthPx: style.weight,
    dash: style.dash,
  });
  return count;
}

function drawPolyline(buffer, width, height, contour, cols, rows, { rgba, widthPx = 1, dash = [] }) {
  const lineWidth = Math.max(1, Math.round(widthPx));
  const radius = Math.max(0, Math.floor((lineWidth - 1) / 2));
  let painted = 0;
  const dashPattern =
    Array.isArray(dash) && dash.length > 0
      ? dash.map((value) => Math.max(1, Number(value))).filter(Number.isFinite)
      : null;

  for (let i = 1; i < contour.length; i += 1) {
    const a = contour[i - 1];
    const b = contour[i];
    // Direct rasterization (backlog #22): the Bresenham walk below is the old
    // rasterizeSegment fused with the stamp loop — same pixel sequence, same
    // per-segment dash state machine, same painted count — without the
    // per-segment pixel {x,y} arrays.
    let cx = scaleX(a.x, cols, width);
    let cy = scaleY(a.y, rows, height);
    const x1 = scaleX(b.x, cols, width);
    const y1 = scaleY(b.y, rows, height);
    const dx = Math.abs(x1 - cx);
    const sx = cx < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - cy);
    const sy = cy < y1 ? 1 : -1;
    let err = dx + dy;

    let dashIndex = 0;
    let dashRemaining = dashPattern && dashPattern.length > 0 ? dashPattern[0] : Number.POSITIVE_INFINITY;
    let draw = true;

    while (true) {
      if (draw) {
        for (let oy = -radius; oy <= radius; oy += 1) {
          for (let ox = -radius; ox <= radius; ox += 1) {
            const px = cx + ox;
            const py = cy + oy;
            if (px < 0 || py < 0 || px >= width || py >= height) {
              continue;
            }
            const idx = (py * width + px) * 4;
            buffer[idx] = rgba[0];
            buffer[idx + 1] = rgba[1];
            buffer[idx + 2] = rgba[2];
            buffer[idx + 3] = rgba[3];
            painted += 1;
          }
        }
      }
      dashRemaining -= 1;
      if (dashPattern && dashRemaining <= 0) {
        dashIndex = (dashIndex + 1) % dashPattern.length;
        dashRemaining = dashPattern[dashIndex];
        draw = !draw;
      }

      if (cx === x1 && cy === y1) {
        break;
      }
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        cx += sx;
      }
      if (e2 <= dx) {
        err += dx;
        cy += sy;
      }
    }
  }
  return painted;
}

function segmentsToPolylines(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }
  const chains = [];
  for (const segment of segments) {
    const start = { x: segment.x0, y: segment.y0 };
    const end = { x: segment.x1, y: segment.y1 };
    if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y)) {
      continue;
    }

    let startChainIndex = -1;
    let startAtHead = false;
    let endChainIndex = -1;
    let endAtHead = false;

    for (let index = 0; index < chains.length; index += 1) {
      const chain = chains[index];
      if (pointsNear(chain[0], start)) {
        startChainIndex = index;
        startAtHead = true;
      } else if (pointsNear(chain[chain.length - 1], start)) {
        startChainIndex = index;
        startAtHead = false;
      }
      if (pointsNear(chain[0], end)) {
        endChainIndex = index;
        endAtHead = true;
      } else if (pointsNear(chain[chain.length - 1], end)) {
        endChainIndex = index;
        endAtHead = false;
      }
    }

    if (startChainIndex === -1 && endChainIndex === -1) {
      chains.push([start, end]);
      continue;
    }
    if (startChainIndex !== -1 && endChainIndex === -1) {
      const chain = chains[startChainIndex];
      if (startAtHead) {
        chain.unshift(end);
      } else {
        chain.push(end);
      }
      continue;
    }
    if (startChainIndex === -1 && endChainIndex !== -1) {
      const chain = chains[endChainIndex];
      if (endAtHead) {
        chain.unshift(start);
      } else {
        chain.push(start);
      }
      continue;
    }
    if (startChainIndex === endChainIndex) {
      const chain = chains[startChainIndex];
      if (startAtHead && !endAtHead) {
        chain.unshift(end);
      } else if (!startAtHead && endAtHead) {
        chain.push(end);
      }
      continue;
    }

    const first = chains[startChainIndex];
    const second = chains[endChainIndex];
    const merged = mergeChains(first, second, startAtHead, endAtHead);
    const keep = Math.min(startChainIndex, endChainIndex);
    const drop = Math.max(startChainIndex, endChainIndex);
    chains[keep] = merged;
    chains.splice(drop, 1);
  }

  return chains.map((chain) => dedupeConsecutivePoints(chain)).filter((chain) => chain.length >= 2);
}

function mergeChains(first, second, firstAtHead, secondAtHead) {
  // Same point sequence as the legacy spread merge ([...a, ...b] etc.); one
  // parent array is extended in place instead of spreading both chains into a
  // fresh array per merge (backlog #22 — 2,132 merges / ~314k copied point
  // refs on a CONUS detailed frame).
  const a = first;
  const b = second;
  if (firstAtHead && secondAtHead) {
    b.reverse();
    return appendChainPoints(b, a);
  }
  if (firstAtHead && !secondAtHead) {
    return appendChainPoints(b, a);
  }
  if (!firstAtHead && secondAtHead) {
    return appendChainPoints(a, b);
  }
  b.reverse();
  return appendChainPoints(a, b);
}

function appendChainPoints(destination, source) {
  for (const point of source) {
    destination.push(point);
  }
  return destination;
}

function dedupeConsecutivePoints(points) {
  const out = [];
  for (const point of points) {
    if (!out.length || !pointsNear(out[out.length - 1], point)) {
      out.push(point);
    }
  }
  return out;
}

function pointsNear(a, b, tolerance = 1e-4) {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

function findFiniteRange(values) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }
  return { min, max };
}

function toLatLon(x, y, cols, rows, bounds) {
  const lat = rowToLatMercator(y, rows, bounds);
  const lon = bounds.west + (x / Math.max(1, cols - 1)) * (bounds.east - bounds.west);
  return [lat, lon];
}

// Projector for encodeVectorLineProjected: writes the same [lat, lon] doubles
// toLatLon computes into the encoder's scratch pair, so encoded bytes match
// the previous contour.map(toLatLon) + encodeVectorLine path exactly.
function projectGridLatLon(cols, rows, bounds) {
  const lonSpan = bounds.east - bounds.west;
  const lonScale = Math.max(1, cols - 1);
  return (point, out) => {
    out[0] = rowToLatMercator(point.y, rows, bounds);
    out[1] = bounds.west + (point.x / lonScale) * lonSpan;
  };
}

function scaleX(x, cols, width) {
  return Math.round((x / Math.max(1, cols - 1)) * (width - 1));
}

function scaleY(y, rows, height) {
  return Math.round((y / Math.max(1, rows - 1)) * (height - 1));
}

function hexToRgba(hex, alpha = 1) {
  const normalized = String(hex || "")
    .replace("#", "")
    .trim();
  const padded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((part) => `${part}${part}`)
          .join("")
      : normalized;
  const num = Number.parseInt(padded || "000000", 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return [r, g, b, a];
}

function contourLength(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return 0;
  }
  let distance = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    distance += Math.sqrt(dx * dx + dy * dy);
  }
  return distance;
}

function interpolateContourMidpoint(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }
  const total = contourLength(points);
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  const target = total * 0.5;
  let traversed = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const next = points[i];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const segmentLength = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(segmentLength) || segmentLength <= 0) {
      continue;
    }
    if (traversed + segmentLength >= target) {
      const t = (target - traversed) / segmentLength;
      return {
        x: prev.x + dx * t,
        y: prev.y + dy * t,
        angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
      };
    }
    traversed += segmentLength;
  }
  const prev = points[points.length - 2];
  const next = points[points.length - 1];
  return {
    x: next.x,
    y: next.y,
    angleDeg: (Math.atan2(next.y - prev.y, next.x - prev.x) * 180) / Math.PI,
  };
}

function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return 0;
  }
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function simplifyRdp(points, epsilon) {
  if (!Array.isArray(points) || points.length < 3 || !Number.isFinite(epsilon) || epsilon <= 0) {
    return points || [];
  }
  const out = [points[0]];
  simplifyRdpRecursive(points, 0, points.length - 1, epsilon, out);
  out.push(points[points.length - 1]);
  return dedupeConsecutivePoints(out);
}

function simplifyRdpRecursive(points, start, end, epsilon, out) {
  if (end <= start + 1) {
    return;
  }
  let maxDistance = -1;
  let maxIndex = -1;
  const a = points[start];
  const b = points[end];
  for (let i = start + 1; i < end; i += 1) {
    const distance = perpendicularDistance(points[i], a, b);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }
  if (maxDistance > epsilon && maxIndex > start && maxIndex < end) {
    simplifyRdpRecursive(points, start, maxIndex, epsilon, out);
    out.push(points[maxIndex]);
    simplifyRdpRecursive(points, maxIndex, end, epsilon, out);
  }
}

function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  if (dx === 0 && dy === 0) {
    return Math.sqrt((point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2);
  }
  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (dx * dx + dy * dy);
  const clamped = clamp(t, 0, 1);
  const projX = lineStart.x + clamped * dx;
  const projY = lineStart.y + clamped * dy;
  return Math.sqrt((point.x - projX) ** 2 + (point.y - projY) ** 2);
}

function marchingSquares(values, width, height, level) {
  const segments = [];
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const a = values[y * width + x];
      const b = values[y * width + x + 1];
      const c = values[(y + 1) * width + x + 1];
      const d = values[(y + 1) * width + x];

      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) {
        continue;
      }

      appendMarchingSquaresCellSegments(segments, level, a, b, c, d, x, y);
    }
  }
  return segments;
}

function marchingSquaresMany(values, width, height, levels) {
  const sortedLevels = Array.from(
    new Set((Array.isArray(levels) ? levels : []).map((level) => Number(level)).filter(Number.isFinite)),
  ).sort((left, right) => left - right);
  const segmentsByLevel = new Map(sortedLevels.map((level) => [level, []]));
  if (sortedLevels.length === 0) {
    return segmentsByLevel;
  }
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const a = values[y * width + x];
      const b = values[y * width + x + 1];
      const c = values[(y + 1) * width + x + 1];
      const d = values[(y + 1) * width + x];

      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) {
        continue;
      }
      const minValue = Math.min(a, b, c, d);
      const maxValue = Math.max(a, b, c, d);
      let levelIndex = lowerBound(sortedLevels, minValue);
      while (levelIndex < sortedLevels.length) {
        const level = sortedLevels[levelIndex];
        if (level > maxValue) {
          break;
        }
        appendMarchingSquaresCellSegments(segmentsByLevel.get(level), level, a, b, c, d, x, y);
        levelIndex += 1;
      }
    }
  }
  return segmentsByLevel;
}

function appendMarchingSquaresCellSegments(segments, level, a, b, c, d, x, y) {
  const caseId = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
  if (caseId === 0 || caseId === 15) {
    return;
  }

  const edges = [
    interp(level, a, b, x, y, x + 1, y),
    interp(level, b, c, x + 1, y, x + 1, y + 1),
    interp(level, d, c, x, y + 1, x + 1, y + 1),
    interp(level, a, d, x, y, x, y + 1),
  ];
  const centerAbove = resolveAmbiguousCellCenterAbove(caseId, level, a, b, c, d);
  const pairs = pairing(caseId, centerAbove);
  for (const pair of pairs) {
    const p0 = edges[pair[0]];
    const p1 = edges[pair[1]];
    if (!p0 || !p1) {
      continue;
    }
    segments.push({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y });
  }
}

// Cases 5 and 10 are bilinear saddles. The arithmetic cell-center average is
// not topology preserving: it can connect the wrong pair of contour arms when
// one diagonal's magnitudes are asymmetric. The asymptotic decider evaluates
// the bilinear saddle determinant relative to the contour level. An exactly
// (or numerically near) degenerate saddle has no preferred topology, so retain
// the stable arithmetic-center tie-break used by older artifacts.
function resolveAmbiguousCellCenterAbove(caseId, level, a, b, c, d) {
  if (caseId !== 5 && caseId !== 10) {
    return false;
  }
  const av = a - level;
  const bv = b - level;
  const cv = c - level;
  const dv = d - level;
  const positiveDiagonal = av * cv;
  const negativeDiagonal = bv * dv;
  const determinant = positiveDiagonal - negativeDiagonal;
  const determinantScale = Math.max(1, Math.abs(positiveDiagonal), Math.abs(negativeDiagonal));
  if (Math.abs(determinant) <= Number.EPSILON * 64 * determinantScale) {
    return (a + b + c + d) / 4 >= level;
  }
  return caseId === 5 ? determinant > 0 : determinant < 0;
}

function lowerBound(values, target) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (values[mid] < target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}

function interp(level, v0, v1, x0, y0, x1, y1) {
  const delta = v1 - v0;
  const t = delta === 0 ? 0.5 : clamp((level - v0) / delta, 0, 1);
  return {
    x: lerp(x0, x1, t),
    y: lerp(y0, y1, t),
  };
}

function pairing(caseId, centerAbove) {
  switch (caseId) {
    case 1:
      return [[3, 0]];
    case 2:
      return [[0, 1]];
    case 3:
      return [[3, 1]];
    case 4:
      return [[1, 2]];
    case 5:
      return centerAbove
        ? [
            [0, 1],
            [2, 3],
          ]
        : [
            [3, 0],
            [1, 2],
          ];
    case 6:
      return [[0, 2]];
    case 7:
      return [[3, 2]];
    case 8:
      return [[2, 3]];
    case 9:
      return [[0, 2]];
    case 10:
      return centerAbove
        ? [
            [3, 0],
            [1, 2],
          ]
        : [
            [0, 1],
            [2, 3],
          ];
    case 11:
      return [[1, 2]];
    case 12:
      return [[3, 1]];
    case 13:
      return [[0, 1]];
    case 14:
      return [[3, 0]];
    default:
      return [];
  }
}

function nearlyModulo(value, divisor) {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor === 0) {
    return false;
  }
  const ratio = value / divisor;
  return Math.abs(ratio - Math.round(ratio)) < 1e-3;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Number.isFinite(fallback) ? Number(fallback) : min;
  }
  const rounded = Math.round(numeric);
  return Math.max(min, Math.min(max, rounded));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

module.exports = {
  buildHeightContourLevels,
  marchingSquares,
  marchingSquaresMany,
  renderHeightContourArtifacts,
  renderSynopticArtifacts,
  _testCenterRefinement: {
    buildCenterRefinementContext,
    refineCenterAgainstField,
    dedupeRefinedCenters,
    resolveClimbFieldForSeed,
  },
  _testCenterDetection: {
    defaultProminenceMinHpa: DEFAULT_CENTER_PROMINENCE_MIN_HPA,
    detectPressureCenters,
    estimateGridSpacingKm,
    offsetsWithinRadius,
    resolveCenterProminenceThreshold,
  },
  _testCenterValidation: {
    expectedRowAwareLocalSampleCount,
    greatCircleDistanceKm,
    methodVersion: ROW_AWARE_CENTER_VALIDATION_METHOD_VERSION,
    validateCenterCandidateRowAware,
    validateCenterRosterDistancesRowAware,
  },
  _testCenterAnalysis: {
    prepareCenterAnalysisGrid,
    resolveCenterAnalysisGridSize,
    targetSpacingKm: CENTER_ANALYSIS_TARGET_SPACING_KM,
    maxCols: CENTER_ANALYSIS_MAX_COLS,
    maxRows: CENTER_ANALYSIS_MAX_ROWS,
  },
  _testSmoothing: {
    smoothPressureField,
    smoothHeightContourField,
  },
  _testContours: {
    drawPolyline,
    postProcessContours,
    projectGridLatLon,
    segmentsToPolylines,
    toLatLon,
  },
  _testLevels: {
    buildSteppedLevels,
  },
  _testResampleGridBilinear: resampleGridBilinear,
};
