"use strict";

const { loadSynopticStyle } = require("./synoptic-style");
const { rowToLatMercator } = require("./mercator");
const { encodeVectorLine } = require("./vector-encoding");

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
}) {
  const styleVersion = String(style?.styleVersion || "v1-operational-contrast");
  const shouldDrawImage = drawImage !== false;
  const empty = createEmptyOutput(width, height, styleVersion, { drawImage: shouldDrawImage });
  const normalizedDetailMode = detailMode === "simple" ? "simple" : "detailed";
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
  const vector = createEmptyVector(styleVersion);
  let visibleCount = 0;

  const mslpMajorInterval = Number(style?.mslp?.majorIntervalHpa || 8);
  const mslpMinorInterval = Number(style?.mslp?.minorIntervalHpa || 4);
  const mslpStart = Math.floor(pressureRange.min / mslpMinorInterval) * mslpMinorInterval;
  const mslpEnd = Math.ceil(pressureRange.max / mslpMinorInterval) * mslpMinorInterval;
  const mslpLevels = buildSteppedLevels(mslpStart, mslpEnd, mslpMinorInterval);
  const pressureSegmentsByLevel = marchingSquaresMany(smoothedPressure, pressureCols, pressureRows, mslpLevels);

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
      const latLonPoints = contour.map((point) => toLatLon(point.x, point.y, pressureCols, pressureRows, targetBounds));
      const lineMeta = {
        kind: isMajor ? "mslp-major" : "mslp-minor",
        value: level,
        color: rawColor,
        alpha,
        width: weight,
      };
      const encodedLine = encodeVectorLine(lineMeta, latLonPoints);
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
          ? String(style?.thickness?.boundaryColor || "#7A1FA2")
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
          const encodedLine = encodeVectorLine(
            lineMeta,
            contour.map((point) => toLatLon(point.x, point.y, thicknessCols, thicknessRows, targetBounds)),
          );
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

  const centers = detectPressureCenters(smoothedPressure, pressureValues, pressureCols, pressureRows, style);
  const centerMetadata = { highs: [], lows: [] };
  for (const center of centers) {
    const latLon = toLatLon(center.x, center.y, pressureCols, pressureRows, targetBounds);
    const metadata = {
      lat: latLon[0],
      lon: latLon[1],
      valueHpa: Math.round(center.value),
      prominenceHpa: Number(center.prominence.toFixed(2)),
    };
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
  const styleVersion = String(style?.styleVersion || "v1-operational-contrast");
  const shouldDrawImage = drawImage !== false;
  const empty = createEmptyHeightContourOutput(width, height, styleVersion, {
    drawImage: shouldDrawImage,
    levelMb,
    intervalDam,
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
  const vector = createEmptyHeightContourVector(styleVersion, levelMb, contourInterval);
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
  for (const contour of contours) {
    if (!Array.isArray(contour) || contour.length < 2) {
      continue;
    }
    vector.lines.push(
      encodeVectorLine(
        {
          kind,
          value: contourLevel,
          color: paint.color,
          alpha: paint.alpha,
          width: paint.weight,
        },
        contour.map((point) => toLatLon(point.x, point.y, cols, rows, targetBounds)),
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

function createEmptyOutput(width, height, styleVersion, { drawImage = true } = {}) {
  return {
    rgba: drawImage ? new Uint8Array(width * height * 4) : null,
    visibleCount: 0,
    centers: { highs: [], lows: [] },
    vector: createEmptyVector(styleVersion),
  };
}

function createEmptyVector(styleVersion) {
  return {
    styleVersion,
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

function createEmptyHeightContourOutput(width, height, styleVersion, { drawImage = true, levelMb, intervalDam } = {}) {
  return {
    rgba: drawImage ? new Uint8Array(width * height * 4) : null,
    visibleCount: 0,
    vector: createEmptyHeightContourVector(styleVersion, levelMb, intervalDam),
  };
}

function createEmptyHeightContourVector(styleVersion, levelMb, intervalDam) {
  return {
    styleVersion,
    layerType: "height-contour",
    contourLevelMb: Number.isFinite(Number(levelMb)) ? Number(levelMb) : null,
    contourIntervalDam: Number.isFinite(Number(intervalDam)) ? Number(intervalDam) : null,
    lines: [],
    labels: [],
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

  const out = new Float32Array(targetRows * targetCols).fill(Number.NaN);
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

function smoothPressureField(values, width, height, bounds, modelKey, style) {
  const sigmaByModel = style?.smoothing?.mslpSigmaKmByModel || {};
  const sigmaKm = Number(sigmaByModel?.[modelKey] || sigmaByModel?.gfs || 45);
  if (!Number.isFinite(sigmaKm) || sigmaKm <= 0) {
    return Float32Array.from(values);
  }
  const spacingKm = estimateGridSpacingKm(bounds, width, height);
  const sigmaCells = clamp(sigmaKm / Math.max(1e-6, spacingKm), 0.6, 4.5);
  return gaussianBlur(values, width, height, sigmaCells);
}

function smoothHeightContourField(values, width, height, bounds, modelKey, style) {
  const sigmaByModel = style?.smoothing?.heightSigmaKmByModel || style?.smoothing?.mslpSigmaKmByModel || {};
  const sigmaKm = Number(sigmaByModel?.[modelKey] || sigmaByModel?.gfs || 45);
  if (!Number.isFinite(sigmaKm) || sigmaKm <= 0) {
    return Float32Array.from(values);
  }
  const spacingKm = estimateGridSpacingKm(bounds, width, height);
  const sigmaCells = clamp(sigmaKm / Math.max(1e-6, spacingKm), 0.6, 4.5);
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
  for (let level = start; level <= end + interval * 0.001; level += interval) {
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

function detectPressureCenters(values, rawValues, width, height, style) {
  const prominenceThreshold = Number(style?.centers?.prominenceMinHpa || 2.4);
  const radius = 4; // 9x9 neighborhood
  const extremumEpsilon = 0.03;
  const neighborhood = offsetsWithinRadius(radius, true);
  const ring = offsetsInAnnulus(3, 5);
  const candidates = [];

  for (let y = radius; y < height - radius; y += 1) {
    for (let x = radius; x < width - radius; x += 1) {
      const centerValue = Number(values[y * width + x]);
      if (!Number.isFinite(centerValue)) {
        continue;
      }
      let strictMax = true;
      let strictMin = true;
      let hasHigher = false;
      let hasLower = false;
      let ringSum = 0;
      let ringCount = 0;

      for (const offset of neighborhood) {
        const sample = Number(values[(y + offset.dy) * width + (x + offset.dx)]);
        if (!Number.isFinite(sample)) {
          continue;
        }
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

      for (const offset of ring) {
        const sample = Number(values[(y + offset.dy) * width + (x + offset.dx)]);
        if (!Number.isFinite(sample)) {
          continue;
        }
        ringSum += sample;
        ringCount += 1;
      }

      if (ringCount < 8) {
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

  includeGlobalPressureExtrema(values, width, height, candidates);

  const highs = selectDistinctCenters(
    candidates.filter((entry) => entry.kind === "high"),
    width,
    height,
    style,
  ).map((entry) => alignCenterValues(entry, values, rawValues, width, height, "high"));
  const lows = selectDistinctCenters(
    candidates.filter((entry) => entry.kind === "low"),
    width,
    height,
    style,
  ).map((entry) => alignCenterValues(entry, values, rawValues, width, height, "low"));

  const resolved = resolveOpposingCenterOverlaps(highs, lows, width, height);
  return [...resolved.highs, ...resolved.lows];
}

function refineCenterToRawGrid(center, rawValues, width, height, kind) {
  if (!Array.isArray(rawValues) && !(rawValues instanceof Float32Array) && !(rawValues instanceof Float64Array)) {
    return center;
  }
  const radius = 2;
  let bestX = center.x;
  let bestY = center.y;
  let bestValue = Number(rawValues[center.y * width + center.x]);
  if (!Number.isFinite(bestValue)) {
    bestValue = center.value;
  }

  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = center.x + dx;
      const y = center.y + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) {
        continue;
      }
      const candidate = Number(rawValues[y * width + x]);
      if (!Number.isFinite(candidate)) {
        continue;
      }
      if (kind === "low") {
        if (candidate < bestValue) {
          bestValue = candidate;
          bestX = x;
          bestY = y;
        }
      } else if (candidate > bestValue) {
        bestValue = candidate;
        bestX = x;
        bestY = y;
      }
    }
  }

  return {
    ...center,
    x: bestX,
    y: bestY,
    value: Number.isFinite(bestValue) ? bestValue : center.value,
  };
}

function selectDistinctCenters(candidates, width, height, style) {
  const sorted = [...candidates].sort((left, right) => right.score - left.score);
  const out = [];
  const maxMarkers = Number(style?.centers?.maxMarkersByBucket?.z4_6 || 18);
  const minDistance = Math.max(6, Math.floor(Math.min(width, height) * 0.075));
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

function alignCenterValues(center, smoothedValues, rawValues, width, height, kind) {
  const refined = refineCenterToRawGrid(center, rawValues, width, height, kind);
  const smoothedValue = Number(smoothedValues[refined.y * width + refined.x]);
  const rawValue = Number(rawValues[refined.y * width + refined.x]);
  const chosen = Number.isFinite(rawValue) ? rawValue : smoothedValue;

  return {
    ...refined,
    value: Number.isFinite(chosen) ? chosen : refined.value,
  };
}

function includeGlobalPressureExtrema(values, width, height, candidates) {
  const margin = clamp(Math.round(Math.min(width, height) / 28), 2, 8);
  let globalMin = null;
  let globalMax = null;
  for (let y = margin; y < height - margin; y += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      const value = Number(values[y * width + x]);
      if (!Number.isFinite(value)) {
        continue;
      }
      if (!globalMin || value < globalMin.value) {
        globalMin = { x, y, value };
      }
      if (!globalMax || value > globalMax.value) {
        globalMax = { x, y, value };
      }
    }
  }
  if (globalMax) {
    candidates.push({
      kind: "high",
      ...globalMax,
      prominence: Number.POSITIVE_INFINITY,
      score: Number.POSITIVE_INFINITY,
    });
  }
  if (globalMin) {
    candidates.push({
      kind: "low",
      ...globalMin,
      prominence: Number.POSITIVE_INFINITY,
      score: Number.POSITIVE_INFINITY,
    });
  }
}

function resolveOpposingCenterOverlaps(highs, lows, width, height) {
  const keptHighs = [...highs];
  const keptLows = [...lows];
  const minDistance = Math.max(4, Math.floor(Math.min(width, height) * 0.052));
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

function offsetsWithinRadius(radius, excludeCenter = false) {
  const key = `disc:${radius}:${excludeCenter ? 1 : 0}`;
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
      if (dx * dx + dy * dy <= radiusSq) {
        out.push({ dx, dy });
      }
    }
  }
  OFFSET_CACHE.set(key, out);
  return out;
}

function offsetsInAnnulus(innerRadius, outerRadius) {
  const key = `annulus:${innerRadius}:${outerRadius}`;
  const cached = OFFSET_CACHE.get(key);
  if (cached) {
    return cached;
  }
  const out = [];
  const innerSq = innerRadius * innerRadius;
  const outerSq = outerRadius * outerRadius;
  for (let dy = -outerRadius; dy <= outerRadius; dy += 1) {
    for (let dx = -outerRadius; dx <= outerRadius; dx += 1) {
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
    const x0 = scaleX(a.x, cols, width);
    const y0 = scaleY(a.y, rows, height);
    const x1 = scaleX(b.x, cols, width);
    const y1 = scaleY(b.y, rows, height);
    const pixels = rasterizeSegment(x0, y0, x1, y1, dashPattern);
    for (const pixel of pixels) {
      for (let oy = -radius; oy <= radius; oy += 1) {
        for (let ox = -radius; ox <= radius; ox += 1) {
          const px = pixel.x + ox;
          const py = pixel.y + oy;
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
  }
  return painted;
}

function rasterizeSegment(x0, y0, x1, y1, dashPattern) {
  const out = [];
  let cx = x0;
  let cy = y0;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  let dashIndex = 0;
  let dashRemaining = dashPattern && dashPattern.length > 0 ? dashPattern[0] : Number.POSITIVE_INFINITY;
  let draw = true;

  while (true) {
    if (draw) {
      out.push({ x: cx, y: cy });
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

  return out;
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
  const a = [...first];
  const b = [...second];
  if (firstAtHead && secondAtHead) {
    return [...reversePoints(b), ...a];
  }
  if (firstAtHead && !secondAtHead) {
    return [...b, ...a];
  }
  if (!firstAtHead && secondAtHead) {
    return [...a, ...b];
  }
  return [...a, ...reversePoints(b)];
}

function reversePoints(points) {
  return [...points].reverse();
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
  const centerAbove = (a + b + c + d) / 4 >= level;
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
};
