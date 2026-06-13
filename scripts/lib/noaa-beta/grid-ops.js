"use strict";

const { rowToLatMercator } = require("../mercator");
const { incrementDecodeSessionCounter } = require("./util");

const WORKER_ROW_REMAP_CACHE = new Map();

const ROW_REMAP_CACHE_MAX_ENTRIES = 128;

const SNOWFALL_PRESENTATION_SMOOTHING_KERNEL = Object.freeze([1, 4, 6, 4, 1]);

function float32ArrayViewFromBuffer(body, byteOffset = 0, byteLength = null) {
  if (!Buffer.isBuffer(body)) {
    return null;
  }
  const resolvedOffset = Math.max(0, Number(byteOffset) || 0);
  const resolvedLength = Number.isFinite(Number(byteLength)) ? Number(byteLength) : body.byteLength - resolvedOffset;
  if (resolvedLength < 0 || resolvedOffset + resolvedLength > body.byteLength || resolvedLength % 4 !== 0) {
    return null;
  }
  const absoluteOffset = body.byteOffset + resolvedOffset;
  if (absoluteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(body.buffer, absoluteOffset, resolvedLength / 4);
  }
  const copy = body.subarray(resolvedOffset, resolvedOffset + resolvedLength);
  const arrayBuffer = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
  return new Float32Array(arrayBuffer);
}

async function decodeBinaryGridFileSlice({
  fileHandle,
  byteOffset,
  fieldBytes,
  bounds,
  width,
  height,
  rowInterpolation = "bilinear",
  rowMapCache = null,
  decodeSession = null,
  scratchBuffer = null,
}) {
  // Callers that decode many slices sequentially can pass a reusable scratch
  // read buffer; the decode result never aliases it (the remap and sanitize
  // paths allocate fresh outputs, and the guard below copies in the residual
  // degenerate-geometry path that would return the input view).
  const useScratch = Buffer.isBuffer(scratchBuffer) && scratchBuffer.byteLength >= fieldBytes;
  const body = useScratch ? scratchBuffer : Buffer.allocUnsafe(fieldBytes);
  const { bytesRead } = await fileHandle.read(body, 0, fieldBytes, byteOffset);
  if (bytesRead !== fieldBytes) {
    throw new Error(`Decoded NOAA binary slice read ${bytesRead} bytes; expected ${fieldBytes}.`);
  }
  const decoded = decodeSouthNorthBinaryGridBuffer({
    body,
    byteOffset: 0,
    bounds,
    width,
    height,
    rowInterpolation,
    rowMapCache,
    decodeSession,
  });
  if (useScratch && decoded instanceof Float32Array && decoded.buffer === body.buffer) {
    return new Float32Array(decoded);
  }
  return decoded;
}

function decodeBinaryGridBuffer({ body, byteOffset, bounds, width, height, rowInterpolation = "bilinear" }) {
  const expectedBytes = width * height * 4;
  if (byteOffset < 0 || byteOffset + expectedBytes > body.length) {
    throw new Error(`Decoded NOAA binary offset ${byteOffset} is outside ${body.length} bytes.`);
  }
  return decodeSouthNorthBinaryGridBuffer({ body, byteOffset, bounds, width, height, rowInterpolation });
}

function decodeSouthNorthBinaryGridBuffer({
  body,
  byteOffset,
  bounds,
  width,
  height,
  rowInterpolation = "bilinear",
  rowMapCache = null,
  decodeSession = null,
}) {
  const total = width * height;
  const absoluteOffset = body.byteOffset + byteOffset;
  if (absoluteOffset % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return decodeSouthNorthBinaryGridBufferUnaligned({
      body,
      byteOffset,
      bounds,
      width,
      height,
      rowInterpolation,
      rowMapCache,
      decodeSession,
    });
  }
  const source = new Float32Array(body.buffer, absoluteOffset, total);
  return remapSouthNorthLinearLatGridToMercatorRows(source, width, height, bounds, rowInterpolation, {
    rowMapCache,
    decodeSession,
  });
}

function decodeSouthNorthBinaryGridBufferUnaligned({
  body,
  byteOffset,
  bounds,
  width,
  height,
  rowInterpolation = "bilinear",
  rowMapCache = null,
  decodeSession = null,
}) {
  const total = width * height;
  const source = new Float32Array(total);
  for (let index = 0; index < total; index += 1) {
    source[index] = body.readFloatLE(byteOffset + index * 4);
  }
  return remapSouthNorthLinearLatGridToMercatorRows(source, width, height, bounds, rowInterpolation, {
    rowMapCache,
    decodeSession,
  });
}

function remapSouthNorthLinearLatGridToMercatorRows(
  values,
  width,
  height,
  bounds,
  rowInterpolation = "bilinear",
  options = {},
) {
  if (!values || values.length !== width * height || !bounds) {
    return values;
  }
  const rowMap = getMercatorRowRemapTable({
    width,
    height,
    bounds,
    rowInterpolation,
    rowMapCache: options.rowMapCache,
    decodeSession: options.decodeSession,
  });
  if (!rowMap) {
    return sanitizeGridValues(values);
  }
  if (rowMap.mode === "nearest") {
    return remapSouthNorthLinearLatGridToMercatorRowsNearest(values, width, height, rowMap);
  }
  // Every cell is written exactly once below (valid rows assign all columns,
  // including an explicit NaN branch; skipped rows NaN-fill their own span),
  // so the previous full-grid NaN prefill was redundant.
  const out = new Float32Array(width * height);
  const base0Map = rowMap.base0;
  const base1Map = rowMap.base1;
  const weightMap = rowMap.weight;
  for (let y = 0; y < height; y += 1) {
    const base0 = base0Map[y];
    const base1 = base1Map[y];
    const outBase = y * width;
    if (base0 < 0 || base1 < 0) {
      out.fill(Number.NaN, outBase, outBase + width);
      continue;
    }
    const ty = weightMap[y];
    const tyComplement = 1 - ty;
    for (let x = 0; x < width; x += 1) {
      // Inlined normalizeGribFloat with identical finite/sentinel semantics.
      const lowerRaw = values[base0 + x];
      const upperRaw = values[base1 + x];
      const lowerUsable = Number.isFinite(lowerRaw) && Math.abs(lowerRaw) < 1e19;
      const upperUsable = Number.isFinite(upperRaw) && Math.abs(upperRaw) < 1e19;
      if (lowerUsable && upperUsable) {
        out[outBase + x] = lowerRaw * tyComplement + upperRaw * ty;
      } else if (lowerUsable) {
        out[outBase + x] = lowerRaw;
      } else if (upperUsable) {
        out[outBase + x] = upperRaw;
      } else {
        out[outBase + x] = Number.NaN;
      }
    }
  }
  return out;
}

function remapSouthNorthLinearLatGridToMercatorRowsNearest(values, width, height, rowMap) {
  // Every cell is written exactly once below, so the previous full-grid NaN
  // prefill was redundant.
  const out = new Float32Array(width * height);
  const baseMap = rowMap.base;
  for (let y = 0; y < height; y += 1) {
    const base = baseMap[y];
    const outBase = y * width;
    if (base < 0) {
      out.fill(Number.NaN, outBase, outBase + width);
      continue;
    }
    for (let x = 0; x < width; x += 1) {
      // Inlined normalizeGribFloat with identical finite/sentinel semantics.
      const raw = values[base + x];
      out[outBase + x] = Number.isFinite(raw) && Math.abs(raw) < 1e19 ? raw : Number.NaN;
    }
  }
  return out;
}

function getMercatorRowRemapTable({
  width,
  height,
  bounds,
  rowInterpolation = "bilinear",
  rowMapCache = null,
  decodeSession = null,
}) {
  const north = Number(bounds?.north);
  const south = Number(bounds?.south);
  const latSpan = north - south;
  if (!Number.isFinite(north) || !Number.isFinite(south) || Math.abs(latSpan) < 1e-9) {
    return null;
  }
  const mode = isNearestRowInterpolation(rowInterpolation) ? "nearest" : "bilinear";
  const cache = rowMapCache || WORKER_ROW_REMAP_CACHE;
  const key = `${mode}:${Math.round(Number(width))}x${Math.round(Number(height))}:${bounds.west},${bounds.east},${bounds.south},${bounds.north}`;
  const cached = cache.get(key);
  if (cached) {
    incrementDecodeSessionCounter(decodeSession, "rowMapHits");
    return cached;
  }
  incrementDecodeSessionCounter(decodeSession, "rowMapMisses");
  const table =
    mode === "nearest"
      ? buildNearestMercatorRowRemapTable({ width, height, bounds, south, latSpan })
      : buildBilinearMercatorRowRemapTable({ width, height, bounds, south, latSpan });
  cache.set(key, table);
  trimMapToMaxEntries(cache, ROW_REMAP_CACHE_MAX_ENTRIES);
  return table;
}

function isNearestRowInterpolation(rowInterpolation) {
  const normalized = String(rowInterpolation || "").toLowerCase();
  return normalized === "nearest" || normalized === "neighbor";
}

function sanitizeGridValues(values) {
  const out = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    out[index] = normalizeGribFloat(values[index]);
  }
  return out;
}

function normalizeGribFloat(value) {
  return Number.isFinite(value) && Math.abs(value) < 1e19 ? value : Number.NaN;
}

function buildGridDistributionStats(values, options = {}) {
  if (!values) {
    return null;
  }
  const finite = new Float64Array(values.length);
  let count = 0;
  let topClampCount = 0;
  const clampMax = Number(options.clampMax);
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }
    finite[count] = value;
    count += 1;
    if (Number.isFinite(clampMax) && value >= clampMax) {
      topClampCount += 1;
    }
  }
  if (count === 0) {
    return { finiteCount: 0 };
  }
  // Exact selection replaces the full comparator sort: the k-th smallest of a
  // multiset is independent of sort algorithm, so each percentile value is
  // identical to the previous sorted-array lookup. The percentile index
  // rounding is unchanged.
  const percentileIndex = (p) => Math.min(count - 1, Math.max(0, Math.round((count - 1) * p)));
  const selection = finite.subarray(0, count);
  const k50 = percentileIndex(0.5);
  const k90 = percentileIndex(0.9);
  const k99 = percentileIndex(0.99);
  quickselectInPlace(selection, k50, 0, count - 1);
  quickselectInPlace(selection, k90, k50, count - 1);
  quickselectInPlace(selection, k99, k90, count - 1);
  let minValue = finite[0];
  let maxValue = finite[0];
  for (let index = 1; index < count; index += 1) {
    const value = finite[index];
    if (value < minValue) {
      minValue = value;
    }
    if (value > maxValue) {
      maxValue = value;
    }
  }
  return {
    finiteCount: count,
    min: roundTo(minValue, 1),
    p50: roundTo(selection[k50], 1),
    p90: roundTo(selection[k90], 1),
    p99: roundTo(selection[k99], 1),
    max: roundTo(maxValue, 1),
    topClampPct: roundTo((100 * topClampCount) / count, 3),
  };
}

function quickselectInPlace(values, k, lo, hi) {
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1];
    let left = lo;
    let right = hi;
    while (left <= right) {
      while (values[left] < pivot) {
        left += 1;
      }
      while (values[right] > pivot) {
        right -= 1;
      }
      if (left <= right) {
        const swap = values[left];
        values[left] = values[right];
        values[right] = swap;
        left += 1;
        right -= 1;
      }
    }
    if (k <= right) {
      hi = right;
    } else if (k >= left) {
      lo = left;
    } else {
      return;
    }
  }
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, Math.max(0, Math.round(decimals || 0)));
  return Number.isFinite(value) ? Math.round(value * factor) / factor : Number.NaN;
}

const SMOOTHING_SCRATCH_BY_LENGTH = new Map();

function smoothingScratchBuffer(length) {
  // Smoothing is synchronous and never re-entered within a worker, and the
  // scratch is fully rewritten each pass, so one buffer per grid length can be
  // reused across calls.
  let scratch = SMOOTHING_SCRATCH_BY_LENGTH.get(length);
  if (!scratch) {
    scratch = new Float32Array(length);
    SMOOTHING_SCRATCH_BY_LENGTH.set(length, scratch);
  }
  return scratch;
}

function gridIsAllFinite(values, cellCount) {
  for (let index = 0; index < cellCount; index += 1) {
    if (!Number.isFinite(values[index])) {
      return false;
    }
  }
  return true;
}

function smoothFiniteNonnegativeGrid(values, width, height, passes) {
  const kernel = SNOWFALL_PRESENTATION_SMOOTHING_KERNEL;
  const radius = Math.floor(kernel.length / 2);
  // Buffer strategy: masked cells now write NaN explicitly, so every cell of
  // `horizontal` and the pass output is assigned each pass and the previous
  // full-grid NaN prefills were redundant. After the horizontal step the
  // prior pass's output buffer is no longer read, so it can host the next
  // vertical output; the caller's `values` (also the finite mask) is never
  // written.
  const cellCount = values.length;
  const maskAllFinite = gridIsAllFinite(values, cellCount);
  let current = values;
  let currentAllFinite = maskAllFinite;
  const horizontal = smoothingScratchBuffer(cellCount);
  for (let pass = 0; pass < passes; pass += 1) {
    // The unchecked interior kernel is exact only when every tap it reads is
    // finite, which the per-buffer finiteness flags guarantee.
    const fastHorizontal = maskAllFinite && currentAllFinite && radius === 2;
    let horizontalAllFinite = true;
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = rowOffset + x;
        let smoothed;
        if (fastHorizontal && x >= 2 && x <= width - 3) {
          smoothed = smoothKernelSampleInterior5AllFinite(current, index, 1, kernel);
        } else if (Number.isFinite(values[index])) {
          smoothed = smoothFiniteKernelSampleInline(current, index, 1, x, width, radius, kernel);
        } else {
          smoothed = Number.NaN;
        }
        horizontal[index] = smoothed;
        if (smoothed !== smoothed || smoothed === Number.POSITIVE_INFINITY || smoothed === Number.NEGATIVE_INFINITY) {
          horizontalAllFinite = false;
        }
      }
    }
    const out = current === values ? new Float32Array(cellCount) : current;
    const fastVertical = maskAllFinite && horizontalAllFinite && radius === 2;
    let outAllFinite = true;
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width;
      const fastRow = fastVertical && y >= 2 && y <= height - 3;
      for (let x = 0; x < width; x += 1) {
        const index = rowOffset + x;
        let result;
        if (fastRow) {
          const smoothed = smoothKernelSampleInterior5AllFinite(horizontal, index, width, kernel);
          result = Number.isFinite(smoothed) ? Math.max(0, smoothed) : Number.NaN;
        } else if (Number.isFinite(values[index])) {
          const smoothed = smoothFiniteKernelSampleInline(horizontal, index, width, y, height, radius, kernel);
          result = Number.isFinite(smoothed) ? Math.max(0, smoothed) : Number.NaN;
        } else {
          result = Number.NaN;
        }
        out[index] = result;
        if (result !== result) {
          outAllFinite = false;
        }
      }
    }
    current = out;
    currentAllFinite = outAllFinite;
  }
  return current;
}

function smoothKernelSampleInterior5AllFinite(values, centerIndex, stride, kernel) {
  // Identical statement sequence to the checked interior fast path with every
  // finite branch taken, so accumulation order and results are bit-identical
  // whenever all five taps are finite.
  const w0 = Number(kernel[0]) || 0;
  const w1 = Number(kernel[1]) || 0;
  const w2 = Number(kernel[2]) || 0;
  const w3 = Number(kernel[3]) || 0;
  const w4 = Number(kernel[4]) || 0;
  let weighted = 0;
  let weightTotal = 0;
  weighted += values[centerIndex - 2 * stride] * w0;
  weightTotal += w0;
  weighted += values[centerIndex - stride] * w1;
  weightTotal += w1;
  weighted += values[centerIndex] * w2;
  weightTotal += w2;
  weighted += values[centerIndex + stride] * w3;
  weightTotal += w3;
  weighted += values[centerIndex + 2 * stride] * w4;
  weightTotal += w4;
  return weightTotal > 0 ? weighted / weightTotal : Number.NaN;
}

function smoothFiniteKernelSampleInline(values, centerIndex, stride, coordinate, limit, radius, kernel) {
  // Interior fast path for the fixed 5-tap kernel; identical tap order,
  // finite-skip, and weight accumulation as smoothFiniteKernelSample.
  if (radius !== 2 || coordinate < 2 || coordinate > limit - 3) {
    return smoothFiniteKernelSample(values, centerIndex, stride, coordinate, limit, radius, kernel);
  }
  const w0 = Number(kernel[0]) || 0;
  const w1 = Number(kernel[1]) || 0;
  const w2 = Number(kernel[2]) || 0;
  const w3 = Number(kernel[3]) || 0;
  const w4 = Number(kernel[4]) || 0;
  let weighted = 0;
  let weightTotal = 0;
  const v0 = values[centerIndex - 2 * stride];
  if (Number.isFinite(v0)) {
    weighted += v0 * w0;
    weightTotal += w0;
  }
  const v1 = values[centerIndex - stride];
  if (Number.isFinite(v1)) {
    weighted += v1 * w1;
    weightTotal += w1;
  }
  const v2 = values[centerIndex];
  if (Number.isFinite(v2)) {
    weighted += v2 * w2;
    weightTotal += w2;
  }
  const v3 = values[centerIndex + stride];
  if (Number.isFinite(v3)) {
    weighted += v3 * w3;
    weightTotal += w3;
  }
  const v4 = values[centerIndex + 2 * stride];
  if (Number.isFinite(v4)) {
    weighted += v4 * w4;
    weightTotal += w4;
  }
  return weightTotal > 0 ? weighted / weightTotal : Number.NaN;
}

function smoothFiniteKernelSample(values, centerIndex, stride, coordinate, limit, radius, kernel) {
  let weighted = 0;
  let weightTotal = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const sampleCoordinate = coordinate + offset;
    if (sampleCoordinate < 0 || sampleCoordinate >= limit) {
      continue;
    }
    const value = Number(values[centerIndex + offset * stride]);
    if (!Number.isFinite(value)) {
      continue;
    }
    const weight = Number(kernel[offset + radius]) || 0;
    weighted += value * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weighted / weightTotal : Number.NaN;
}

function buildBilinearMercatorRowRemapTable({ width, height, bounds, south, latSpan }) {
  const base0 = new Int32Array(height);
  const base1 = new Int32Array(height);
  const weight = new Float64Array(height);
  base0.fill(-1);
  base1.fill(-1);
  weight.fill(Number.NaN);
  for (let y = 0; y < height; y += 1) {
    const lat = rowToLatMercator(y, height, bounds);
    const sourceY = ((lat - south) / latSpan) * (height - 1);
    if (!Number.isFinite(sourceY)) {
      continue;
    }
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(sourceY)));
    const y1 = Math.max(0, Math.min(height - 1, y0 + 1));
    base0[y] = y0 * width;
    base1[y] = y1 * width;
    weight[y] = Math.max(0, Math.min(1, sourceY - y0));
  }
  return { mode: "bilinear", base0, base1, weight };
}

function buildNearestMercatorRowRemapTable({ width, height, bounds, south, latSpan }) {
  const base = new Int32Array(height);
  base.fill(-1);
  for (let y = 0; y < height; y += 1) {
    const lat = rowToLatMercator(y, height, bounds);
    const sourceY = ((lat - south) / latSpan) * (height - 1);
    if (!Number.isFinite(sourceY)) {
      continue;
    }
    const sourceRow = Math.max(0, Math.min(height - 1, Math.round(sourceY)));
    base[y] = sourceRow * width;
  }
  return { mode: "nearest", base };
}

function trimMapToMaxEntries(map, maxEntries) {
  const limit = Math.max(1, Number(maxEntries) || 1);
  while (map.size > limit) {
    const first = map.keys().next().value;
    map.delete(first);
  }
}

module.exports = {
  buildBilinearMercatorRowRemapTable,
  buildNearestMercatorRowRemapTable,
  trimMapToMaxEntries,
  ROW_REMAP_CACHE_MAX_ENTRIES,
  SNOWFALL_PRESENTATION_SMOOTHING_KERNEL,
  WORKER_ROW_REMAP_CACHE,
  buildGridDistributionStats,
  decodeBinaryGridBuffer,
  decodeBinaryGridFileSlice,
  decodeSouthNorthBinaryGridBuffer,
  decodeSouthNorthBinaryGridBufferUnaligned,
  float32ArrayViewFromBuffer,
  getMercatorRowRemapTable,
  isNearestRowInterpolation,
  normalizeGribFloat,
  quickselectInPlace,
  remapSouthNorthLinearLatGridToMercatorRows,
  remapSouthNorthLinearLatGridToMercatorRowsNearest,
  roundTo,
  sanitizeGridValues,
  smoothFiniteKernelSample,
  smoothFiniteKernelSampleInline,
  smoothFiniteNonnegativeGrid,
};
