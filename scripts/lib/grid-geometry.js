"use strict";

const { rowToLatMercator } = require("./mercator");

const CONUS_ANCHORS = {
  south: [
    { name: "Miami", lat: 25.76, lon: -80.19 },
    { name: "Houston", lat: 29.76, lon: -95.37 },
    { name: "Phoenix", lat: 33.45, lon: -112.07 },
  ],
  north: [
    { name: "Seattle", lat: 47.61, lon: -122.33 },
    { name: "Minneapolis", lat: 44.98, lon: -93.27 },
    { name: "Portland", lat: 45.52, lon: -122.68 },
  ],
  plausibility: [
    { name: "Seattle", lat: 47.61, lon: -122.33 },
    { name: "Denver", lat: 39.74, lon: -104.99 },
    { name: "Dallas", lat: 32.77, lon: -96.79 },
    { name: "NYC", lat: 40.71, lon: -74.0 },
    { name: "Miami", lat: 25.76, lon: -80.19 },
  ],
};

function parseBboxFromWkt(wkt) {
  if (typeof wkt !== "string") {
    return null;
  }
  const match = wkt.match(/BBOX\[\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]/i);
  if (!match) {
    return null;
  }
  const south = Number(match[1]);
  const west = Number(match[2]);
  const north = Number(match[3]);
  const east = Number(match[4]);
  if (![south, west, north, east].every(Number.isFinite)) {
    return null;
  }
  if (north <= south || east <= west) {
    return null;
  }
  return { north, south, west, east };
}

function detectCrsKind(crsWkt) {
  const raw = String(crsWkt || "").toUpperCase();
  if (
    raw.includes("PROJCRS") ||
    raw.includes("PROJECTEDCRS") ||
    raw.includes("PROJCS") ||
    raw.includes("LAMBERT CONIC CONFORMAL")
  ) {
    return "projected";
  }
  if (raw.includes("GEOGCRS") || raw.includes("GEOGRAPHIC")) {
    return "geographic";
  }
  return "unknown";
}

function parseLambertParams(crsWkt) {
  const text = String(crsWkt || "");
  const params = {
    lat0: readWktParam(text, ["Latitude of false origin", "Latitude of natural origin"]),
    lon0: readWktParam(text, ["Longitude of false origin", "Longitude of natural origin"]),
    lat1: readWktParam(text, ["Latitude of 1st standard parallel", "Standard parallel 1"]),
    lat2: readWktParam(text, ["Latitude of 2nd standard parallel", "Standard parallel 2"]),
    falseEasting: readWktParam(text, ["Easting at false origin", "False easting"]),
    falseNorthing: readWktParam(text, ["Northing at false origin", "False northing"]),
    earthRadius: readWktEllipsoidRadius(text),
  };

  if (![params.lat0, params.lon0, params.lat1, params.lat2].every(Number.isFinite)) {
    return null;
  }
  if (!Number.isFinite(params.falseEasting)) {
    params.falseEasting = 0;
  }
  if (!Number.isFinite(params.falseNorthing)) {
    params.falseNorthing = 0;
  }
  if (!Number.isFinite(params.earthRadius) || params.earthRadius <= 0) {
    params.earthRadius = 6_371_229;
  }
  return params;
}

function createGridGeometry({
  crsWkt,
  sourceBounds,
  sourceProjectedBounds = null,
  rowOrderHint = null,
  rows,
  cols,
  modelKey: _modelKey,
  targetBounds,
  temperatureValues = null,
}) {
  const kind = detectCrsKind(crsWkt);
  const supportMask = buildFiniteSupportMask({
    values: temperatureValues,
    rows,
    cols,
    erosionIterations: kind === "projected" ? 1 : 0,
  });
  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows <= 1 || cols <= 1) {
    throw new Error("Invalid source grid dimensions/bounds.");
  }

  if (!sourceBounds && !sourceProjectedBounds) {
    throw new Error("Missing source grid bounds.");
  }

  const geographicBounds = looksLikeGeographicBounds(sourceBounds) ? sourceBounds : null;
  const lonMode =
    geographicBounds && geographicBounds.west >= 0 && geographicBounds.east > 180 ? "0to360" : "-180to180";
  const projectedBounds = resolveProjectedBounds({
    kind,
    sourceBounds,
    sourceProjectedBounds,
    crsWkt,
    lonMode,
  });

  if (kind === "projected" && projectedBounds) {
    const lambert = parseLambertParams(crsWkt);
    if (lambert) {
      const detectedOrder = detectRowOrder({
        mode: "lambert",
        rows,
        cols,
        sourceBounds: projectedBounds,
        lambert,
        lonMode,
        targetBounds,
        temperatureValues,
      });
      const rowOrder =
        rowOrderHint === "south_to_north" || rowOrderHint === "north_to_south" ? rowOrderHint : detectedOrder;
      return {
        kind: "lambert",
        rowOrder,
        lonMode,
        supportMask,
        mapLatLonToGrid(lat, lon) {
          const projected = projectLambert(lat, normalizeLon(lon, lonMode), lambert);
          if (!projected) {
            return null;
          }
          const fx =
            ((projected.x - projectedBounds.west) / (projectedBounds.east - projectedBounds.west)) * (cols - 1);
          const fySouth =
            ((projected.y - projectedBounds.south) / (projectedBounds.north - projectedBounds.south)) * (rows - 1);
          const fy = rowOrder === "south_to_north" ? fySouth : rows - 1 - fySouth;
          if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
            return null;
          }
          return { fx, fy };
        },
      };
    }
  }

  const effectiveGeographic = geographicBounds || sourceBounds;
  if (!effectiveGeographic) {
    throw new Error("Missing effective geographic bounds.");
  }
  const rowOrder = detectRowOrder({
    mode: "geographic",
    rows,
    cols,
    sourceBounds: effectiveGeographic,
    lonMode,
    targetBounds,
    temperatureValues,
  });
  return {
    kind: kind === "projected" ? "projected-geographic-bbox" : "geographic",
    rowOrder,
    lonMode,
    supportMask,
    mapLatLonToGrid(lat, lon) {
      const normalizedLon = normalizeLon(lon, lonMode);
      const fx =
        ((normalizedLon - effectiveGeographic.west) / (effectiveGeographic.east - effectiveGeographic.west)) *
        (cols - 1);
      const fySouth =
        ((lat - effectiveGeographic.south) / (effectiveGeographic.north - effectiveGeographic.south)) * (rows - 1);
      const fy = rowOrder === "south_to_north" ? fySouth : rows - 1 - fySouth;
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
        return null;
      }
      return { fx, fy };
    },
  };
}

function resolveProjectedBounds({ kind, sourceBounds, sourceProjectedBounds, crsWkt, lonMode }) {
  if (kind !== "projected") {
    return null;
  }
  if (isLikelyProjectedBounds(sourceProjectedBounds)) {
    return sourceProjectedBounds;
  }
  if (isLikelyProjectedBounds(sourceBounds)) {
    return sourceBounds;
  }
  const lambert = parseLambertParams(crsWkt);
  if (!lambert || !looksLikeGeographicBounds(sourceBounds)) {
    return null;
  }
  return estimateProjectedBoundsFromGeographicBounds(sourceBounds, lambert, lonMode);
}

function isLikelyProjectedBounds(bounds) {
  if (!bounds) {
    return false;
  }
  const spanX = Number(bounds.east) - Number(bounds.west);
  const spanY = Number(bounds.north) - Number(bounds.south);
  if (!Number.isFinite(spanX) || !Number.isFinite(spanY) || spanX <= 0 || spanY <= 0) {
    return false;
  }
  if (looksLikeGeographicBounds(bounds)) {
    return false;
  }
  const magnitude = Math.max(
    Math.abs(Number(bounds.west)),
    Math.abs(Number(bounds.east)),
    Math.abs(Number(bounds.south)),
    Math.abs(Number(bounds.north)),
  );
  return magnitude > 1000 && spanX > 1000 && spanY > 1000;
}

function estimateProjectedBoundsFromGeographicBounds(bounds, lambert, lonMode) {
  if (!looksLikeGeographicBounds(bounds)) {
    return null;
  }
  const sw = projectLambert(bounds.south, normalizeLon(bounds.west, lonMode), lambert);
  const ne = projectLambert(bounds.north, normalizeLon(bounds.east, lonMode), lambert);
  if (sw && ne && Number.isFinite(sw.x) && Number.isFinite(sw.y) && Number.isFinite(ne.x) && Number.isFinite(ne.y)) {
    const cornerAligned = {
      west: Math.min(sw.x, ne.x),
      east: Math.max(sw.x, ne.x),
      south: Math.min(sw.y, ne.y),
      north: Math.max(sw.y, ne.y),
    };
    if (cornerAligned.east > cornerAligned.west && cornerAligned.north > cornerAligned.south) {
      return cornerAligned;
    }
  }

  const nw = projectLambert(bounds.north, normalizeLon(bounds.west, lonMode), lambert);
  const se = projectLambert(bounds.south, normalizeLon(bounds.east, lonMode), lambert);
  const xs = [sw?.x, ne?.x, nw?.x, se?.x].filter(Number.isFinite);
  const ys = [sw?.y, ne?.y, nw?.y, se?.y].filter(Number.isFinite);
  if (xs.length < 2 || ys.length < 2) {
    return null;
  }
  const west = Math.min(...xs);
  const east = Math.max(...xs);
  const south = Math.min(...ys);
  const north = Math.max(...ys);
  if (!Number.isFinite(west) || !Number.isFinite(east) || !Number.isFinite(south) || !Number.isFinite(north)) {
    return null;
  }
  if (east <= west || north <= south) {
    return null;
  }
  return { west, east, south, north };
}

function looksLikeGeographicBounds(bounds) {
  if (!bounds) {
    return false;
  }
  const { north, south, west, east } = bounds;
  return (
    Number.isFinite(north) &&
    Number.isFinite(south) &&
    Number.isFinite(west) &&
    Number.isFinite(east) &&
    north <= 90 &&
    south >= -90 &&
    east <= 360 &&
    west >= -180 &&
    east > west &&
    north > south
  );
}

function buildSampleLookup({ width, height, rows, cols, targetBounds, geometry, edgeMode = "mask" }) {
  const clampEdges = edgeMode === "clamp";
  const count = width * height;
  const baseIndex = new Int32Array(count);
  const nearestIndex = new Int32Array(count);
  const tx = new Float32Array(count);
  const ty = new Float32Array(count);
  const stepX = new Uint8Array(count);
  const stepY = new Uint8Array(count);
  const valid = new Uint8Array(count);

  let index = 0;
  for (let y = 0; y < height; y += 1) {
    const lat = rowToLatMercator(y, height, targetBounds);
    for (let x = 0; x < width; x += 1) {
      const lon = targetBounds.west + (x / Math.max(1, width - 1)) * (targetBounds.east - targetBounds.west);
      const mapped = geometry.mapLatLonToGrid(lat, lon);
      if (!mapped) {
        valid[index] = 0;
        index += 1;
        continue;
      }
      const fx = mapped.fx;
      const fy = mapped.fy;
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
        valid[index] = 0;
        index += 1;
        continue;
      }

      const constrainedFx = clampEdges ? clamp(fx, 0, cols - 1) : fx;
      const constrainedFy = clampEdges ? clamp(fy, 0, rows - 1) : fy;
      if (constrainedFx < 0 || constrainedFy < 0 || constrainedFx > cols - 1 || constrainedFy > rows - 1) {
        valid[index] = 0;
        index += 1;
        continue;
      }

      const x0 = Math.floor(constrainedFx);
      const y0 = Math.floor(constrainedFy);
      const xCanStep = x0 < cols - 1 ? 1 : 0;
      const yCanStep = y0 < rows - 1 ? 1 : 0;
      const x1 = xCanStep ? x0 + 1 : x0;
      const y1 = yCanStep ? y0 + 1 : y0;
      if (edgeMode === "mask" && !bilinearNeighborhoodSupported(geometry?.supportMask, cols, rows, x0, y0, x1, y1)) {
        valid[index] = 0;
        index += 1;
        continue;
      }
      const nearestX = clampInt(Math.round(constrainedFx), 0, cols - 1, 0);
      const nearestY = clampInt(Math.round(constrainedFy), 0, rows - 1, 0);
      baseIndex[index] = y0 * cols + x0;
      nearestIndex[index] = nearestY * cols + nearestX;
      tx[index] = constrainedFx - x0;
      ty[index] = constrainedFy - y0;
      stepX[index] = xCanStep;
      stepY[index] = yCanStep;
      valid[index] = 1;
      index += 1;
    }
  }

  return {
    baseIndex,
    nearestIndex,
    tx,
    ty,
    stepX,
    stepY,
    valid,
    cols,
  };
}

function sampleBilinearAtLatLon({ values, rows, cols, geometry, lat, lon }) {
  if (!values || values.length !== rows * cols) {
    return Number.NaN;
  }
  const mapped = geometry.mapLatLonToGrid(lat, lon);
  if (!mapped) {
    return Number.NaN;
  }
  const fx = mapped.fx;
  const fy = mapped.fy;
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fy < 0 || fx > cols - 1 || fy > rows - 1) {
    return Number.NaN;
  }

  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  if (!bilinearNeighborhoodSupported(geometry?.supportMask, cols, rows, x0, y0, x1, y1)) {
    return Number.NaN;
  }
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = Number(values[y0 * cols + x0]);
  const v10 = Number(values[y0 * cols + x1]);
  const v01 = Number(values[y1 * cols + x0]);
  const v11 = Number(values[y1 * cols + x1]);
  if (![v00, v10, v01, v11].every(Number.isFinite)) {
    return Number.NaN;
  }

  const top = v00 * (1 - tx) + v10 * tx;
  const bottom = v01 * (1 - tx) + v11 * tx;
  return top * (1 - ty) + bottom * ty;
}

function runTemperatureSanityCheck({ values, rows, cols, geometry, targetBounds, modelKey }) {
  if (!values || values.length !== rows * cols) {
    return {
      ok: true,
      reason: "temperature-missing",
      diagnostics: { finiteAnchors: 0, minC: null, maxC: null },
    };
  }

  const anchors = CONUS_ANCHORS.plausibility.filter((point) => containsLatLon(targetBounds, point.lat, point.lon));
  const sampled = [];
  for (const point of anchors) {
    const raw = sampleBilinearAtLatLon({ values, rows, cols, geometry, lat: point.lat, lon: point.lon });
    const celsius = toCelsiusMaybe(raw);
    if (Number.isFinite(celsius)) {
      sampled.push(celsius);
    }
  }

  const minC = sampled.length > 0 ? Math.min(...sampled) : null;
  const maxC = sampled.length > 0 ? Math.max(...sampled) : null;
  const finiteAnchors = sampled.length;

  const diagnostics = {
    modelKey,
    geometry: geometry.kind,
    rowOrder: geometry.rowOrder,
    lonMode: geometry.lonMode,
    finiteAnchors,
    minC,
    maxC,
  };

  if (finiteAnchors < 3) {
    return {
      ok: false,
      reason: "insufficient-anchor-coverage",
      diagnostics,
    };
  }
  if (Number.isFinite(minC) && minC < -95) {
    return {
      ok: false,
      reason: "implausible-min-temperature",
      diagnostics,
    };
  }
  if (Number.isFinite(maxC) && maxC > 65) {
    return {
      ok: false,
      reason: "implausible-max-temperature",
      diagnostics,
    };
  }

  return {
    ok: true,
    reason: "ok",
    diagnostics,
  };
}

function detectRowOrder({ mode, rows, cols, sourceBounds, lambert, lonMode, targetBounds, temperatureValues }) {
  if (!temperatureValues || !targetBounds || !intersectsConus(targetBounds)) {
    return "south_to_north";
  }

  const southToNorthScore = rowOrderScore({
    mode,
    rowOrder: "south_to_north",
    rows,
    cols,
    sourceBounds,
    lambert,
    lonMode,
    values: temperatureValues,
    targetBounds,
  });

  const northToSouthScore = rowOrderScore({
    mode,
    rowOrder: "north_to_south",
    rows,
    cols,
    sourceBounds,
    lambert,
    lonMode,
    values: temperatureValues,
    targetBounds,
  });

  if (northToSouthScore > southToNorthScore + 0.5) {
    return "north_to_south";
  }
  return "south_to_north";
}

function rowOrderScore({ mode, rowOrder, rows, cols, sourceBounds, lambert, lonMode, values, targetBounds }) {
  const south = [];
  const north = [];

  for (const point of CONUS_ANCHORS.south) {
    if (!containsLatLon(targetBounds, point.lat, point.lon)) {
      continue;
    }
    south.push(sampleByOrder({ mode, point, rowOrder, rows, cols, sourceBounds, lambert, lonMode, values }));
  }
  for (const point of CONUS_ANCHORS.north) {
    if (!containsLatLon(targetBounds, point.lat, point.lon)) {
      continue;
    }
    north.push(sampleByOrder({ mode, point, rowOrder, rows, cols, sourceBounds, lambert, lonMode, values }));
  }

  const southFinite = south.filter(Number.isFinite);
  const northFinite = north.filter(Number.isFinite);
  if (southFinite.length === 0 || northFinite.length === 0) {
    return -999;
  }

  const avgSouth = average(southFinite.map(toCelsiusMaybe).filter(Number.isFinite));
  const avgNorth = average(northFinite.map(toCelsiusMaybe).filter(Number.isFinite));
  if (!Number.isFinite(avgSouth) || !Number.isFinite(avgNorth)) {
    return -999;
  }
  return avgSouth - avgNorth;
}

function sampleByOrder({ mode, point, rowOrder, rows, cols, sourceBounds, lambert, lonMode, values }) {
  let fx;
  let fy;

  if (mode === "lambert" && lambert) {
    const projected = projectLambert(point.lat, normalizeLon(point.lon, lonMode), lambert);
    if (!projected) {
      return Number.NaN;
    }
    fx = ((projected.x - sourceBounds.west) / (sourceBounds.east - sourceBounds.west)) * (cols - 1);
    const fySouth = ((projected.y - sourceBounds.south) / (sourceBounds.north - sourceBounds.south)) * (rows - 1);
    fy = rowOrder === "south_to_north" ? fySouth : rows - 1 - fySouth;
  } else {
    const lon = normalizeLon(point.lon, lonMode);
    fx = ((lon - sourceBounds.west) / (sourceBounds.east - sourceBounds.west)) * (cols - 1);
    const fySouth = ((point.lat - sourceBounds.south) / (sourceBounds.north - sourceBounds.south)) * (rows - 1);
    fy = rowOrder === "south_to_north" ? fySouth : rows - 1 - fySouth;
  }

  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fy < 0 || fx > cols - 1 || fy > rows - 1) {
    return Number.NaN;
  }
  const x = clampInt(Math.round(fx), 0, cols - 1, 0);
  const y = clampInt(Math.round(fy), 0, rows - 1, 0);
  return Number(values[y * cols + x]);
}

function projectLambert(latDeg, lonDeg, params) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) {
    return null;
  }
  const lat = toRad(latDeg);
  const lon = toRad(lonDeg);
  const lat0 = toRad(params.lat0);
  const lon0 = toRad(params.lon0);
  const lat1 = toRad(params.lat1);
  const lat2 = toRad(params.lat2);

  let n =
    Math.log(Math.cos(lat1) / Math.cos(lat2)) /
    Math.log(Math.tan(Math.PI / 4 + lat2 / 2) / Math.tan(Math.PI / 4 + lat1 / 2));
  if (!Number.isFinite(n) || Math.abs(n) < 1e-12) {
    n = Math.sin(lat1);
  }
  if (!Number.isFinite(n) || Math.abs(n) < 1e-12) {
    return null;
  }

  const f = (Math.cos(lat1) * Math.pow(Math.tan(Math.PI / 4 + lat1 / 2), n)) / n;
  const earthRadius = Number.isFinite(params.earthRadius) ? params.earthRadius : 6_371_229;
  const rho = (earthRadius * f) / Math.pow(Math.tan(Math.PI / 4 + lat / 2), n);
  const rho0 = (earthRadius * f) / Math.pow(Math.tan(Math.PI / 4 + lat0 / 2), n);
  const theta = n * (lon - lon0);

  const x = params.falseEasting + rho * Math.sin(theta);
  const y = params.falseNorthing + rho0 - rho * Math.cos(theta);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y };
}

function readWktEllipsoidRadius(text) {
  if (typeof text !== "string" || text.length === 0) {
    return Number.NaN;
  }
  const match = text.match(/ELLIPSOID\[[^\]]*?,\s*([-+]?[\d.]+)/i);
  if (!match) {
    return Number.NaN;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : Number.NaN;
}

function normalizeLon(lon, lonMode) {
  if (!Number.isFinite(lon)) {
    return lon;
  }
  if (lonMode === "0to360") {
    let out = lon;
    while (out < 0) {
      out += 360;
    }
    while (out >= 360) {
      out -= 360;
    }
    return out;
  }
  let out = lon;
  while (out < -180) {
    out += 360;
  }
  while (out > 180) {
    out -= 360;
  }
  return out;
}

function readWktParam(text, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(`PARAMETER\\["${escaped}",\\s*([-+]?\\d*\\.?\\d+)`, "i"));
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        return value;
      }
    }
  }
  return Number.NaN;
}

function intersectsConus(bounds) {
  const conus = { north: 53, south: 21, west: -129, east: -63 };
  const north = Math.min(bounds.north, conus.north);
  const south = Math.max(bounds.south, conus.south);
  const west = Math.max(bounds.west, conus.west);
  const east = Math.min(bounds.east, conus.east);
  return north > south && east > west;
}

function containsLatLon(bounds, lat, lon) {
  if (!bounds) {
    return false;
  }
  return lat >= bounds.south && lat <= bounds.north && lon >= bounds.west && lon <= bounds.east;
}

function toCelsiusMaybe(value) {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  if (value > 120) {
    return value - 273.15;
  }
  return value;
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return Number.NaN;
  }
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }
    sum += value;
    count += 1;
  }
  return count > 0 ? sum / count : Number.NaN;
}

function buildFiniteSupportMask({ values, rows, cols, erosionIterations = 0 }) {
  if (!values || values.length !== rows * cols) {
    return null;
  }
  let mask = new Uint8Array(rows * cols);
  for (let i = 0; i < values.length; i += 1) {
    mask[i] = Number.isFinite(values[i]) ? 1 : 0;
  }
  for (let pass = 0; pass < erosionIterations; pass += 1) {
    mask = erodeMask(mask, rows, cols);
  }
  return mask;
}

function erodeMask(mask, rows, cols) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      let keep = 1;
      for (let dy = -1; dy <= 1 && keep; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= rows) {
          keep = 0;
          break;
        }
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= cols) {
            keep = 0;
            break;
          }
          if (mask[yy * cols + xx] === 0) {
            keep = 0;
            break;
          }
        }
      }
      out[y * cols + x] = keep ? 1 : 0;
    }
  }
  return out;
}

function bilinearNeighborhoodSupported(mask, cols, rows, x0, y0, x1, y1) {
  if (!mask || mask.length !== rows * cols) {
    return true;
  }
  const a = mask[y0 * cols + x0];
  const b = mask[y0 * cols + x1];
  const c = mask[y1 * cols + x0];
  const d = mask[y1 * cols + x1];
  return a === 1 && b === 1 && c === 1 && d === 1;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return value;
  }
  return Math.max(min, Math.min(max, value));
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(num)));
}

module.exports = {
  parseBboxFromWkt,
  detectCrsKind,
  createGridGeometry,
  buildSampleLookup,
  sampleBilinearAtLatLon,
  runTemperatureSanityCheck,
};
