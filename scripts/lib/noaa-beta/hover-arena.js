"use strict";

const {
  _isSafeHoverGridVariableKey: isSafeHoverGridVariableKey,
  _serializeHoverGridBinaryHeader: serializeHoverGridBinaryHeader,
} = require("../hover-grid-binary");
const { HOVER_GRID_ENCODINGS } = require("../hover-grid-encoding");

const HOVER_ARENA_ENV = "MODELVIEW_NOAA_HOVER_ARENA";
const HOVER_ARENA_PREFIX_ALIGNMENT = 128;
const MAX_HOVER_ARENA_HEADER_BYTES = 1024 * 1024;
const MAX_HOVER_ARENA_BYTES = 512 * 1024 * 1024;
const ARENA_BRAND = new WeakSet();

function resolveHoverArenaMode(value = process.env[HOVER_ARENA_ENV]) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === "auto") {
    return "auto";
  }
  if (normalized === "off") {
    return "off";
  }
  throw new Error(`${HOVER_ARENA_ENV} must be 'auto' or 'off' when set; received ${JSON.stringify(value)}`);
}

const HOVER_ARENA_MODE = resolveHoverArenaMode();
let cachedGrowableSharedArrayBufferSupport;

function supportsGrowableSharedArrayBuffer() {
  if (cachedGrowableSharedArrayBufferSupport !== undefined) {
    return cachedGrowableSharedArrayBufferSupport;
  }
  cachedGrowableSharedArrayBufferSupport = false;
  try {
    if (typeof SharedArrayBuffer !== "function" || typeof Buffer?.from !== "function") {
      return false;
    }
    const owner = new SharedArrayBuffer(2, { maxByteLength: 8 });
    if (owner.growable !== true || owner.maxByteLength !== 8 || typeof owner.grow !== "function") {
      return false;
    }
    const fixed = new Uint8Array(owner, 0, 2);
    const tracking = new Uint8Array(owner);
    fixed.set([0x41, 0x42]);
    owner.grow(8);
    const view = Buffer.from(owner, 2, 4);
    view.set([0x43, 0x44, 0x45, 0x46]);
    cachedGrowableSharedArrayBufferSupport =
      fixed.length === 2 &&
      tracking.length === 8 &&
      view.buffer === owner &&
      view.byteOffset === 2 &&
      view.byteLength === 4 &&
      new Uint8Array(owner)[5] === 0x46;
  } catch {
    cachedGrowableSharedArrayBufferSupport = false;
  }
  return cachedGrowableSharedArrayBufferSupport;
}

function createHoverGridArena({
  rows,
  cols,
  candidates,
  encoding,
  allocateShared = (byteLength, options) => new SharedArrayBuffer(byteLength, options),
} = {}) {
  if (HOVER_ARENA_MODE !== "auto") {
    return { arena: null, reason: "disabled" };
  }
  if (!supportsGrowableSharedArrayBuffer()) {
    return { arena: null, reason: "growable-shared-array-buffer-unavailable" };
  }
  const preflight = preflightHoverGridArena({ rows, cols, candidates, encoding });
  if (!preflight.ok) {
    return { arena: null, reason: preflight.reason };
  }

  // Allocation occurs only after every fallback-eligible property has been
  // checked. Once this owner exists, allocation/grow/finalization failures
  // propagate instead of allocating the legacy per-variable representation
  // alongside a partially materialized arena.
  const owner = allocateShared(preflight.headerReserve, {
    maxByteLength: preflight.maxByteLength,
  });
  if (
    !(owner instanceof SharedArrayBuffer) ||
    owner.growable !== true ||
    owner.byteLength !== preflight.headerReserve ||
    owner.maxByteLength !== preflight.maxByteLength ||
    typeof owner.grow !== "function"
  ) {
    throw new Error("hover arena allocator did not return the requested growable SharedArrayBuffer");
  }

  let state = "building";
  let bodyBytes = 0;
  let openSlot = null;
  let nextCandidateIndex = 0;
  const entries = [];

  const assertBuilding = () => {
    if (state !== "building") {
      throw new Error(`hover arena is ${state}, not building`);
    }
  };
  const fail = (error) => {
    state = "failed";
    openSlot = null;
    throw error;
  };

  const arena = Object.freeze({
    abort() {
      if (state === "building") {
        state = "failed";
        openSlot = null;
      }
    },

    openPlane(key) {
      assertBuilding();
      if (openSlot) {
        return fail(new Error(`hover arena plane '${openSlot.candidate.key}' is still open`));
      }
      const candidate = preflight.candidates[nextCandidateIndex];
      if (!candidate || candidate.key !== key) {
        return fail(
          new Error(
            `hover arena expected canonical plane ${JSON.stringify(candidate?.key ?? null)}; received ${JSON.stringify(
              key,
            )}`,
          ),
        );
      }
      const absoluteOffset = preflight.headerReserve + bodyBytes;
      const requiredLength = absoluteOffset + preflight.planeBytes;
      try {
        if (owner.byteLength < requiredLength) {
          owner.grow(requiredLength);
        }
        const values = new Int16Array(owner, absoluteOffset, preflight.cells);
        openSlot = { candidate, values };
        return values;
      } catch (error) {
        return fail(error);
      }
    },

    discardPlane(key) {
      assertBuilding();
      if (!openSlot || openSlot.candidate.key !== key) {
        return fail(new Error(`hover arena cannot discard unopened plane ${JSON.stringify(key)}`));
      }
      openSlot = null;
      nextCandidateIndex += 1;
    },

    commitPlane(key, variable) {
      assertBuilding();
      if (!openSlot || openSlot.candidate.key !== key) {
        return fail(new Error(`hover arena cannot commit unopened plane ${JSON.stringify(key)}`));
      }
      if (variable?.values !== openSlot.values) {
        return fail(new Error(`hover arena plane '${key}' lost its exact target view`));
      }
      if (variable?.predictorEncoded !== "gradient2d") {
        return fail(new Error(`hover arena plane '${key}' was not finalized as gradient2d`));
      }
      const scale = Number(variable.scale);
      const offset = Number(variable.offset);
      const missing = Number(variable.missing);
      if (
        scale !== openSlot.candidate.scale ||
        offset !== openSlot.candidate.offset ||
        missing !== openSlot.candidate.missing
      ) {
        return fail(new Error(`hover arena plane '${key}' changed its canonical quantization metadata`));
      }
      entries.push({
        key,
        scale,
        offset,
        missing,
        byteOffset: bodyBytes,
        length: preflight.cells,
        clampCount: Math.max(0, Number(variable.clampCount) || 0),
        nonFiniteCount: Math.max(0, Number(variable.nonFiniteCount) || 0),
      });
      bodyBytes += preflight.planeBytes;
      openSlot = null;
      nextCandidateIndex += 1;
    },

    seal() {
      assertBuilding();
      if (openSlot) {
        return fail(new Error(`hover arena plane '${openSlot.candidate.key}' is still open at seal`));
      }
      if (nextCandidateIndex !== preflight.candidates.length) {
        return fail(new Error("hover arena cannot seal before every canonical candidate is finalized"));
      }
      const headerVariables = {};
      for (const entry of entries) {
        headerVariables[entry.key] = {
          scale: entry.scale,
          offset: entry.offset,
          missing: entry.missing,
          byteOffset: entry.byteOffset,
          length: entry.length,
        };
      }
      const header = serializeHoverGridBinaryHeader({
        schemaVersion: encoding.schemaVersion,
        rows: preflight.rows,
        cols: preflight.cols,
        encoding,
        variables: headerVariables,
      });
      const prefixBytes = 8 + header.length;
      if (prefixBytes > preflight.headerReserve) {
        return fail(
          new Error(
            `hover arena header ${prefixBytes} exceeds its precomputed ${preflight.headerReserve}-byte reserve`,
          ),
        );
      }
      const wireOffset = preflight.headerReserve - prefixBytes;
      const wireBytes = prefixBytes + bodyBytes;
      const wireEnd = wireOffset + wireBytes;
      if (!Number.isSafeInteger(wireEnd) || wireEnd > owner.byteLength) {
        return fail(new Error("hover arena wire range exceeds its published backing"));
      }
      let raw;
      try {
        raw = Buffer.from(owner, wireOffset, wireBytes);
        raw.write(encoding.magic, 0, "ascii");
        raw.writeUInt32LE(header.length, 4);
        header.copy(raw, 8);
      } catch (error) {
        return fail(error);
      }
      state = "sealed";
      const telemetry = Object.freeze({
        variables: entries.length,
        cells: preflight.cells,
        planeBytes: preflight.planeBytes,
        headerReserveBytes: preflight.headerReserve,
        viewOffsetBytes: wireOffset,
        viewBytes: wireBytes,
        backingBytes: owner.byteLength,
        maxBytes: owner.maxByteLength,
        backingSlackBytes: owner.byteLength - wireBytes,
        speculativeTailBytes: Math.max(0, owner.byteLength - preflight.headerReserve - bodyBytes),
        uniqueOwners: 1,
        copyBytes: 0,
      });
      return Object.freeze({
        raw,
        telemetry,
        diagnostics: summarizeArenaEntries(entries),
      });
    },
  });
  ARENA_BRAND.add(arena);
  return { arena, reason: null };
}

function preflightHoverGridArena({ rows, cols, candidates, encoding }) {
  const resolvedRows = Number(rows);
  const resolvedCols = Number(cols);
  if (
    !Number.isSafeInteger(resolvedRows) ||
    resolvedRows <= 0 ||
    !Number.isSafeInteger(resolvedCols) ||
    resolvedCols <= 0 ||
    resolvedRows > Number.MAX_SAFE_INTEGER / resolvedCols
  ) {
    return { ok: false, reason: "noncanonical-dimensions" };
  }
  // Bind the private path to the process-frozen canonical descriptor object.
  // Matching only a subset of fields would allow a forged clone to omit or
  // alter wire-affecting fields such as headerPredictor.
  if (encoding !== HOVER_GRID_ENCODINGS.mvh4) {
    return { ok: false, reason: "noncanonical-encoding" };
  }
  if (!Array.isArray(candidates)) {
    return { ok: false, reason: "noncanonical-plan" };
  }
  const cells = resolvedRows * resolvedCols;
  const planeBytes = cells * Int16Array.BYTES_PER_ELEMENT;
  if (!Number.isSafeInteger(planeBytes) || planeBytes <= 0) {
    return { ok: false, reason: "unsafe-plane-size" };
  }
  const seen = new Set();
  const canonicalCandidates = [];
  const maximumVariables = {};
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const key = candidate?.key;
    if (
      typeof key !== "string" ||
      !key ||
      !isSafeHoverGridVariableKey(key) ||
      isCanonicalArrayIndexKey(key) ||
      seen.has(key)
    ) {
      return { ok: false, reason: "noncanonical-variable-roster" };
    }
    const scale = Number(candidate.scale);
    const offset = Number(candidate.offset);
    const missing = Number(candidate.missing);
    if (
      !Number.isFinite(scale) ||
      scale <= 0 ||
      !Number.isFinite(offset) ||
      !Number.isInteger(missing) ||
      missing < -32768 ||
      missing > 32767
    ) {
      return { ok: false, reason: "noncanonical-variable-metadata" };
    }
    const byteOffset = index * planeBytes;
    if (!Number.isSafeInteger(byteOffset)) {
      return { ok: false, reason: "unsafe-arena-size" };
    }
    seen.add(key);
    canonicalCandidates.push(Object.freeze({ key, scale, offset, missing }));
    maximumVariables[key] = { scale, offset, missing, byteOffset, length: cells };
  }
  const maximumHeader = serializeHoverGridBinaryHeader({
    schemaVersion: encoding.schemaVersion,
    rows: resolvedRows,
    cols: resolvedCols,
    encoding,
    variables: maximumVariables,
  });
  const maximumPrefixBytes = 8 + maximumHeader.length;
  if (maximumPrefixBytes > MAX_HOVER_ARENA_HEADER_BYTES) {
    return { ok: false, reason: "header-cap-exceeded" };
  }
  const headerReserve = alignUp(maximumPrefixBytes, HOVER_ARENA_PREFIX_ALIGNMENT);
  const maximumBodyBytes = candidates.length * planeBytes;
  const maxByteLength = headerReserve + maximumBodyBytes;
  if (
    !Number.isSafeInteger(maximumBodyBytes) ||
    !Number.isSafeInteger(maxByteLength) ||
    maxByteLength > MAX_HOVER_ARENA_BYTES
  ) {
    return { ok: false, reason: "arena-cap-exceeded" };
  }
  return {
    ok: true,
    rows: resolvedRows,
    cols: resolvedCols,
    cells,
    planeBytes,
    headerReserve,
    maxByteLength,
    candidates: Object.freeze(canonicalCandidates),
  };
}

function summarizeArenaEntries(entries) {
  const byVariable = {};
  let clampCount = 0;
  let nonFiniteCount = 0;
  for (const entry of entries) {
    if (entry.clampCount > 0 || entry.nonFiniteCount > 0) {
      byVariable[entry.key] = {
        clampCount: entry.clampCount,
        nonFiniteCount: entry.nonFiniteCount,
      };
    }
    clampCount += entry.clampCount;
    nonFiniteCount += entry.nonFiniteCount;
  }
  return { clampCount, nonFiniteCount, byVariable };
}

function alignUp(value, alignment) {
  const remainder = value % alignment;
  return remainder === 0 ? value : value + alignment - remainder;
}

function isCanonicalArrayIndexKey(key) {
  const numeric = Number(key);
  return Number.isInteger(numeric) && numeric >= 0 && numeric < 0xffffffff && String(numeric) === key;
}

module.exports = {
  HOVER_ARENA_ENV,
  HOVER_ARENA_MODE,
  HOVER_ARENA_PREFIX_ALIGNMENT,
  MAX_HOVER_ARENA_BYTES,
  MAX_HOVER_ARENA_HEADER_BYTES,
  createHoverGridArena,
  resolveHoverArenaMode,
  supportsGrowableSharedArrayBuffer,
  _isHoverGridArena: (value) => ARENA_BRAND.has(value),
  _preflightHoverGridArena: preflightHoverGridArena,
  _testResetGrowableSharedArrayBufferSupport() {
    cachedGrowableSharedArrayBufferSupport = undefined;
  },
};
