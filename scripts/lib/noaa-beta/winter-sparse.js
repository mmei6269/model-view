"use strict";

const { MM_TO_IN } = require("./util");
const { composePrecipAccumulationGrid } = require("./accumulation");

const SPARSE_ACTIVE_GRID_MAX_FRACTION = 0.45;

function buildSnowfallLiquidInByChunk(chunks, sourceGrids, width, height) {
  const out = new Map();
  for (const chunk of chunks) {
    const liquidIn = composePrecipAccumulationGrid(chunk.terms, sourceGrids, width, height, {
      outputScale: MM_TO_IN,
    });
    out.set(chunk.key, liquidIn);
  }
  return out;
}

// Chunk-set completeness gate shared by every liquid-chunk consumer. A chunk
// whose liquid grid failed to compose (missing source records, decode failure)
// must make the whole accumulation window unknown — never a partial sum that
// silently undercounts (plan.md's NaN-as-unknown rule).
function hasIncompleteLiquidChunks(chunks, liquidByChunk, cellCount) {
  return chunks.some((chunk) => {
    const grid = liquidByChunk.get(chunk.key);
    return !grid || grid.length !== cellCount;
  });
}

function buildLiquidChunkDescriptors({ chunks, liquidByChunk, width, height, threshold = 0 }) {
  const cellCount = Number(width) * Number(height);
  if (!Number.isFinite(cellCount) || cellCount <= 0 || !Array.isArray(chunks) || chunks.length === 0) {
    return [];
  }
  const out = [];
  for (const chunk of chunks) {
    const liquidIn = liquidByChunk?.get(chunk.key);
    if (!liquidIn || liquidIn.length !== cellCount) {
      continue;
    }
    const active = activeGridVisitIndicesGreaterThan(liquidIn, threshold);
    if (active.positiveCount > 0 || active.missingCount > 0) {
      out.push({
        chunk,
        liquidIn,
        activeIndices: active.indices,
        positiveCount: active.positiveCount,
        missingCount: active.missingCount,
      });
    }
  }
  return out;
}

function activeGridVisitIndicesGreaterThan(values, threshold) {
  if (!values) {
    return { indices: new Uint32Array(0), positiveCount: 0, missingCount: 0 };
  }
  const resolvedThreshold = Number.isFinite(Number(threshold)) ? Number(threshold) : 0;
  const denseLimit = Math.max(1, Math.floor(values.length * SPARSE_ACTIVE_GRID_MAX_FRACTION));
  let indices = new Uint32Array(Math.min(denseLimit, 4096));
  let indexCount = 0;
  let positiveCount = 0;
  let missingCount = 0;
  let overflowed = false;
  const trackIndex = (index) => {
    if (overflowed) {
      return;
    }
    if (indexCount >= denseLimit) {
      overflowed = true;
      return;
    }
    if (indexCount >= indices.length) {
      const next = new Uint32Array(Math.min(denseLimit, indices.length * 2));
      next.set(indices);
      indices = next;
    }
    indices[indexCount] = index;
    indexCount += 1;
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (Number.isFinite(value) && value > resolvedThreshold) {
      positiveCount += 1;
      trackIndex(index);
    } else if (!Number.isFinite(value)) {
      missingCount += 1;
      trackIndex(index);
    }
  }
  const activeCount = positiveCount + missingCount;
  return {
    indices: overflowed && activeCount > 0 ? null : indices.slice(0, indexCount),
    positiveCount,
    missingCount,
  };
}

function activeDescriptorCellCount(descriptor, cellCount) {
  return descriptor?.activeIndices === null ? cellCount : descriptor?.activeIndices?.length || 0;
}

function activeVisitCount(activeIndices, fallbackCount) {
  return activeIndices === null ? fallbackCount : activeIndices?.length || 0;
}

function activeVisitIndex(activeIndices, visitIndex) {
  return activeIndices === null ? visitIndex : activeIndices[visitIndex];
}

function sumLiquidChunksIn(chunks, liquidByChunk, width, height) {
  const cellCount = Number(width) * Number(height);
  if (!Number.isFinite(cellCount) || cellCount <= 0 || !Array.isArray(chunks) || chunks.length === 0) {
    return null;
  }
  const out = new Float32Array(cellCount).fill(0);
  let hasFinite = false;
  for (const chunk of chunks) {
    const values = liquidByChunk.get(chunk.key);
    if (!values || values.length !== cellCount) {
      return null;
    }
    for (let index = 0; index < cellCount; index += 1) {
      if (Number.isNaN(out[index])) {
        continue;
      }
      const value = Number(values[index]);
      if (Number.isFinite(value)) {
        out[index] += Math.max(0, value);
        hasFinite = true;
      } else {
        out[index] = Number.NaN;
      }
    }
  }
  return hasFinite ? out : null;
}

module.exports = {
  SPARSE_ACTIVE_GRID_MAX_FRACTION,
  activeDescriptorCellCount,
  activeGridVisitIndicesGreaterThan,
  activeVisitCount,
  activeVisitIndex,
  buildLiquidChunkDescriptors,
  buildSnowfallLiquidInByChunk,
  hasIncompleteLiquidChunks,
  sumLiquidChunksIn,
};
