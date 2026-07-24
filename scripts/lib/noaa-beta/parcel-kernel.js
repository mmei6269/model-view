"use strict";

// Loader for the WASM effective-inflow origin-scan kernel built from
// tools/parcel-kernel/assembly/index.ts (see that file for the port
// contract). The kernel is the default backend (see parcelKernelRequested
// below); MODELVIEW_PARCEL_KERNEL=js reverts to the pure JS path, which
// also remains the automatic fallback when the module is missing or fails
// to instantiate.
//
// Each thread (render worker, derived sub-worker, main) gets its own
// instance; the kernel's linear memory doubles as the effective-diagnostics
// scratch storage, exposed to JS as typed-array views so profile-row fills
// and downstream wind/mixed-layer consumers read and write the exact same
// buffers the kernel scans.

const fs = require("fs");
const path = require("path");

const KERNEL_WASM_PATH = path.resolve(__dirname, "../../../tools/parcel-kernel/build/parcel-kernel.wasm");

let cachedKernel;

// Backend variants (2026-07-12, owner-approved relaxed tolerance):
//   wasm-f32 (default) — f32x4 SIMD origin scan: parcels integrate in
//     single precision with a vectorized polynomial exp (~7e-7 relative);
//     fastest, validated by dual-run fuzz + real-frame artifact
//     quantification (docs/noaa-renderer-benchmark-history.md).
//   wasm — the scalar f64 NativeMath kernel (previous default; measured
//     byte-identical artifacts vs the JS path on the full fixture).
//   js — pure JS path; also the automatic fallback when the module is
//     missing or fails to instantiate.
// The derived-grid cache keys on the active variant, so grids computed by
// different backends are never served to each other.
const KERNEL_VARIANTS = Object.freeze(["wasm-f32", "wasm", "js"]);

let warnedUnknownVariant = false;

function requestedParcelKernelVariant() {
  const raw = String(process.env.MODELVIEW_PARCEL_KERNEL || "wasm-f32")
    .trim()
    .toLowerCase();
  if (KERNEL_VARIANTS.includes(raw)) {
    return raw;
  }
  // Unrecognized values fall back to the pure-JS path (the historical
  // behavior of any non-"wasm" spelling) so an operator's disable setting
  // can never silently enable a kernel.
  if (!warnedUnknownVariant) {
    warnedUnknownVariant = true;
    console.warn(
      `[noaa-beta] unrecognized MODELVIEW_PARCEL_KERNEL='${raw}'; using the JS parcel path (expected wasm-f32|wasm|js)`,
    );
  }
  return "js";
}

function parcelKernelRequested() {
  return requestedParcelKernelVariant() !== "js";
}

function getParcelKernel() {
  if (cachedKernel !== undefined) {
    return cachedKernel;
  }
  cachedKernel = null;
  if (!parcelKernelRequested()) {
    return cachedKernel;
  }
  cachedKernel = loadParcelKernelVariant(requestedParcelKernelVariant());
  return cachedKernel;
}

// Loads a specific variant (uncached); getParcelKernel() caches the
// env-selected one per thread. Tests use this to compare variants.
function loadParcelKernelVariant(variant) {
  if (variant === "js") {
    return null;
  }
  try {
    const wasmBytes = fs.readFileSync(KERNEL_WASM_PATH);
    const module = new WebAssembly.Module(wasmBytes);
    const instance = new WebAssembly.Instance(module, {
      env: {
        abort() {
          throw new Error("parcel-kernel abort");
        },
      },
    });
    const exports = instance.exports;
    const memory = exports.memory;
    const rowsCap = Number(exports.ROWS_CAP?.value ?? exports.ROWS_CAP);
    const outPtr = Number(exports.OUT_PTR?.value ?? exports.OUT_PTR);
    const runOriginScan = variant === "wasm-f32" ? exports.runOriginScanF32 : exports.runOriginScan;
    if (typeof runOriginScan !== "function") {
      throw new Error(`parcel kernel is missing the '${variant}' scan export`);
    }
    const kernel = {
      variant,
      rowsCap,
      // Stale binaries without the version export count as revision 1.
      numericsVersion: Number(exports.KERNEL_NUMERICS_VERSION?.value ?? exports.KERNEL_NUMERICS_VERSION) || 1,
      runOriginScan,
      views: {
        heights: new Float64Array(memory.buffer, Number(exports.HEIGHTS_PTR?.value ?? exports.HEIGHTS_PTR), rowsCap),
        pressure: new Float64Array(memory.buffer, Number(exports.PRESSURE_PTR?.value ?? exports.PRESSURE_PTR), rowsCap),
        temp: new Float64Array(memory.buffer, Number(exports.TEMP_PTR?.value ?? exports.TEMP_PTR), rowsCap),
        dewpoint: new Float64Array(memory.buffer, Number(exports.DEWPOINT_PTR?.value ?? exports.DEWPOINT_PTR), rowsCap),
        segmentValid: new Uint8Array(
          memory.buffer,
          Number(exports.SEGMENT_VALID_PTR?.value ?? exports.SEGMENT_VALID_PTR),
          rowsCap,
        ),
        segmentDz: new Float64Array(
          memory.buffer,
          Number(exports.SEGMENT_DZ_PTR?.value ?? exports.SEGMENT_DZ_PTR),
          rowsCap,
        ),
        segmentMidHeight: new Float64Array(
          memory.buffer,
          Number(exports.SEGMENT_MID_HEIGHT_PTR?.value ?? exports.SEGMENT_MID_HEIGHT_PTR),
          rowsCap,
        ),
        segmentMidPressure: new Float64Array(
          memory.buffer,
          Number(exports.SEGMENT_MID_PRESSURE_PTR?.value ?? exports.SEGMENT_MID_PRESSURE_PTR),
          rowsCap,
        ),
        segmentEnvVirtualTemp: new Float64Array(
          memory.buffer,
          Number(exports.SEGMENT_ENV_VIRTUAL_TEMP_PTR?.value ?? exports.SEGMENT_ENV_VIRTUAL_TEMP_PTR),
          rowsCap,
        ),
        out: new Float64Array(memory.buffer, outPtr, Number(exports.OUT_SLOTS?.value ?? exports.OUT_SLOTS)),
      },
    };
    // Stage G1 (2026-07-12): wind rows + the in-kernel effective-layer
    // product chain (f64 NativeMath port of the post-fill JS glue).
    if (
      typeof exports.runEffectiveProducts === "function" &&
      exports.ROW_U_PTR !== undefined &&
      exports.EP_OUT_PTR !== undefined
    ) {
      kernel.views.u = new Float64Array(memory.buffer, Number(exports.ROW_U_PTR?.value ?? exports.ROW_U_PTR), rowsCap);
      kernel.views.v = new Float64Array(memory.buffer, Number(exports.ROW_V_PTR?.value ?? exports.ROW_V_PTR), rowsCap);
      kernel.views.productsOut = new Float64Array(
        memory.buffer,
        Number(exports.EP_OUT_PTR?.value ?? exports.EP_OUT_PTR),
        Number(exports.EP_OUT_SLOTS?.value ?? exports.EP_OUT_SLOTS),
      );
      kernel.effectiveProducts = exports.runEffectiveProducts;
    }
    // Hover quantize + int16 delta ports (2026-07-12): EXACT f64 arithmetic
    // (see the kernel's Stage D section) — available under every wasm
    // variant because they carry no numeric deviation from the JS loops.
    if (
      typeof exports.quantizeRawF64 === "function" &&
      typeof exports.quantizeAffineF64 === "function" &&
      typeof exports.quantizeWindF64 === "function"
    ) {
      const quantChunk = Number(exports.QUANT_CHUNK?.value ?? exports.QUANT_CHUNK);
      const quantize = {
        chunk: quantChunk,
        inA: new Float32Array(memory.buffer, Number(exports.QIN_A_PTR?.value ?? exports.QIN_A_PTR), quantChunk),
        inB: new Float32Array(memory.buffer, Number(exports.QIN_B_PTR?.value ?? exports.QIN_B_PTR), quantChunk),
        out: new Int16Array(memory.buffer, Number(exports.QOUT_PTR?.value ?? exports.QOUT_PTR), quantChunk),
        stats: new Int32Array(memory.buffer, Number(exports.QSTATS_PTR?.value ?? exports.QSTATS_PTR), 3),
        raw: exports.quantizeRawF64,
        affine: exports.quantizeAffineF64,
        wind: exports.quantizeWindF64,
        deltaOutput: typeof exports.deltaEncodeQuantizedI16 === "function" ? exports.deltaEncodeQuantizedI16 : null,
      };
      kernel.quantize = attachQuantizedGradientCapability(exports, memory, quantize);
    }
    // Exact continuous raw/affine RGBA colorizer. This capability is
    // independently guarded so an old or malformed optional export cannot
    // disable the parcel/derived kernel; the rasterizer simply retains its
    // authoritative JS path.
    const colorize = createContinuousColorizerCapability(exports, memory);
    if (colorize) {
      kernel.colorize = colorize;
    }
    // Presentation smoothing port (2026-07-12): EXACT f64 arithmetic with
    // f32 intermediate rounding identical to the JS scratch stores.
    if (typeof exports.smoothGrid === "function") {
      const smoothCap = Number(exports.SMOOTH_CELLS_CAP?.value ?? exports.SMOOTH_CELLS_CAP);
      kernel.smooth = {
        cap: smoothCap,
        input: new Float32Array(
          memory.buffer,
          Number(exports.SMOOTH_IN_PTR?.value ?? exports.SMOOTH_IN_PTR),
          smoothCap,
        ),
        output: new Float32Array(
          memory.buffer,
          Number(exports.SMOOTH_OUT_PTR?.value ?? exports.SMOOTH_OUT_PTR),
          smoothCap,
        ),
        run: exports.smoothGrid,
      };
    }
    if (typeof exports.deltaEncodeI16 === "function") {
      const deltaChunk = Number(exports.DELTA_CHUNK?.value ?? exports.DELTA_CHUNK);
      kernel.delta = {
        chunk: deltaChunk,
        buf: new Int16Array(memory.buffer, Number(exports.DELTA_PTR?.value ?? exports.DELTA_PTR), deltaChunk),
        encode: exports.deltaEncodeI16,
      };
    }
    if (variant === "wasm-f32" && typeof exports.computeDcapeF32 === "function") {
      const dcapeCap = Number(exports.DCAPE_KNOTS_CAP?.value ?? exports.DCAPE_KNOTS_CAP);
      kernel.dcape = {
        cap: dcapeCap,
        compute: exports.computeDcapeF32,
        levels: new Float32Array(memory.buffer, Number(exports.DK_LEVEL_PTR?.value ?? exports.DK_LEVEL_PTR), dcapeCap),
        hgt: new Float32Array(memory.buffer, Number(exports.DK_HGT_PTR?.value ?? exports.DK_HGT_PTR), dcapeCap),
        tmp: new Float32Array(memory.buffer, Number(exports.DK_TMP_PTR?.value ?? exports.DK_TMP_PTR), dcapeCap),
        rh: new Float32Array(memory.buffer, Number(exports.DK_RH_PTR?.value ?? exports.DK_RH_PTR), dcapeCap),
      };
    }
    // Stage G2 (2026-07-12): whole-cell-loop slab pipeline. Gated to the
    // wasm-f32 variant because the per-cell DCAPE inside the loop uses the
    // f32 DCAPE port; other variants keep the JS cell loop.
    if (
      variant === "wasm-f32" &&
      typeof exports.runDerivedSlab === "function" &&
      kernel.dcape &&
      kernel.effectiveProducts
    ) {
      const slabCells = Number(exports.SLAB_CELLS?.value ?? exports.SLAB_CELLS);
      const slabSlots = Number(exports.SLAB_SLOTS?.value ?? exports.SLAB_SLOTS);
      const slabOutRows = Number(exports.SLAB_OUT_ROWS?.value ?? exports.SLAB_OUT_ROWS);
      kernel.derivedSlab = {
        cells: slabCells,
        slots: slabSlots,
        auxSlots: Number(exports.SLAB_AUX_SLOTS?.value ?? exports.SLAB_AUX_SLOTS),
        outRows: slabOutRows,
        arena: new Float32Array(
          memory.buffer,
          Number(exports.SLAB_ARENA_PTR?.value ?? exports.SLAB_ARENA_PTR),
          slabSlots * slabCells,
        ),
        present: new Uint8Array(
          memory.buffer,
          Number(exports.SLAB_PRESENT_PTR?.value ?? exports.SLAB_PRESENT_PTR),
          slabSlots,
        ),
        mask: new Uint8Array(memory.buffer, Number(exports.SLAB_MASK_PTR?.value ?? exports.SLAB_MASK_PTR), slabCells),
        out: new Float32Array(
          memory.buffer,
          Number(exports.SLAB_OUT_PTR?.value ?? exports.SLAB_OUT_PTR),
          slabOutRows * slabCells,
        ),
        levels6: new Float64Array(memory.buffer, Number(exports.SRC6_LEVELS_PTR?.value ?? exports.SRC6_LEVELS_PTR), 64),
        slots6: new Int32Array(memory.buffer, Number(exports.SRC6_SLOTS_PTR?.value ?? exports.SRC6_SLOTS_PTR), 320),
        levels21: new Float64Array(
          memory.buffer,
          Number(exports.SRC21_LEVELS_PTR?.value ?? exports.SRC21_LEVELS_PTR),
          64,
        ),
        slots21: new Int32Array(memory.buffer, Number(exports.SRC21_SLOTS_PTR?.value ?? exports.SRC21_SLOTS_PTR), 320),
        run: exports.runDerivedSlab,
      };
    }
    return kernel;
  } catch (error) {
    console.warn(`[noaa-beta] parcel kernel unavailable, using JS path: ${String(error?.message || error)}`);
    return null;
  }
}

const MAX_COLOR_CHUNK = 65536;
const MAX_COLOR_PALETTE = 65536;
const CONTINUOUS_COLORIZER_ABI_VERSION = 1;
const MAX_GRADIENT_COLS = 32768;
const QUANTIZED_GRADIENT_ABI_VERSION = 1;
const QUANTIZED_GRADIENT_CANARY = 0x47523244;
const COLORIZER_CANARY_INPUT = [-1, 0.25, 0.5, 0.75, 1, Number.NaN];
const COLORIZER_CANARY_PALETTE = [3, 5, 7, 255, 11, 13, 17, 0, 19, 23, 29, 128, 31, 37, 41, 211];
const COLORIZER_CANARY_OUTPUT = [0, 0, 0, 0, 3, 5, 7, 255, 0, 0, 0, 0, 31, 37, 41, 211, 0, 0, 0, 0, 0, 0, 0, 0];

function createContinuousColorizerCapability(exports, memory) {
  try {
    if (!exports || typeof exports.colorizeContinuousF64 !== "function" || !memory?.buffer) {
      return null;
    }
    const abiVersion = exportedNumber(exports.COLORIZER_ABI_VERSION);
    const chunk = exportedNumber(exports.COLOR_CHUNK);
    const paletteCap = exportedNumber(exports.COLOR_PALETTE_CAP);
    const inputPtr = exportedNumber(exports.QIN_A_PTR);
    const outputPtr = exportedNumber(exports.COLOR_OUT_PTR);
    const palettePtr = exportedNumber(exports.COLOR_PALETTE_PTR);
    const statsPtr = exportedNumber(exports.COLOR_STATS_PTR);
    if (
      abiVersion !== CONTINUOUS_COLORIZER_ABI_VERSION ||
      !isBoundedPositiveInteger(chunk, MAX_COLOR_CHUNK) ||
      chunk < COLORIZER_CANARY_INPUT.length ||
      !isBoundedPositiveInteger(paletteCap, MAX_COLOR_PALETTE) ||
      paletteCap < COLORIZER_CANARY_PALETTE.length / 4 ||
      !isAlignedPointer(inputPtr, 4) ||
      !isAlignedPointer(outputPtr, 4) ||
      !isAlignedPointer(palettePtr, 4) ||
      !isAlignedPointer(statsPtr, 4)
    ) {
      return null;
    }
    const ranges = [
      [inputPtr, chunk * 4],
      [outputPtr, chunk * 4],
      [palettePtr, paletteCap * 4],
      [statsPtr, 8],
    ];
    const byteLength = Number(memory.buffer.byteLength);
    if (ranges.some(([start, length]) => start + length > byteLength) || rangesOverlap(ranges)) {
      return null;
    }
    const capability = {
      abiVersion,
      chunk,
      paletteCap,
      memory,
      input: new Float32Array(memory.buffer, inputPtr, chunk),
      output: new Uint8Array(memory.buffer, outputPtr, chunk * 4),
      palette: new Uint8Array(memory.buffer, palettePtr, paletteCap * 4),
      stats: new Int32Array(memory.buffer, statsPtr, 2),
      run: exports.colorizeContinuousF64,
    };
    if (!passesContinuousColorizerCanary(capability)) {
      return null;
    }
    return Object.freeze(capability);
  } catch {
    return null;
  }
}

function passesContinuousColorizerCanary(capability) {
  let valid = false;
  try {
    capability.input.set(COLORIZER_CANARY_INPUT, 0);
    capability.output.fill(0xa5, 0, COLORIZER_CANARY_OUTPUT.length);
    capability.palette.set(COLORIZER_CANARY_PALETTE, 0);
    capability.stats.fill(-1);
    capability.run(
      COLORIZER_CANARY_INPUT.length,
      COLORIZER_CANARY_PALETTE.length / 4,
      0,
      1,
      1,
      0,
      1,
      1,
      2,
      -0.5,
      1,
      -1,
    );
    valid =
      capability.stats[0] === 2 &&
      capability.stats[1] === 5 &&
      COLORIZER_CANARY_OUTPUT.every((value, index) => capability.output[index] === value);
  } catch {
    valid = false;
  } finally {
    // The canary runs before the capability becomes reachable. Leave every
    // touched scratch byte neutral so optional validation cannot leak state
    // into the parcel, hover, or first raster call.
    try {
      capability.input.fill(0, 0, COLORIZER_CANARY_INPUT.length);
      capability.output.fill(0, 0, COLORIZER_CANARY_OUTPUT.length);
      capability.palette.fill(0, 0, COLORIZER_CANARY_PALETTE.length);
      capability.stats.fill(0);
    } catch {
      valid = false;
    }
  }
  return valid;
}

function createQuantizedGradientCapability(exports, memory, quantize) {
  try {
    if (
      !exports ||
      typeof exports.resetQuantizedGradient2d !== "function" ||
      typeof exports.gradientEncodeQuantizedI16 !== "function" ||
      !memory?.buffer ||
      !(quantize?.out instanceof Int16Array)
    ) {
      return null;
    }
    const abiVersion = exportedNumber(exports.GRADIENT_ABI_VERSION);
    const cap = exportedNumber(exports.GRADIENT_COLS_CAP);
    const canary = exportedNumber(exports.GRADIENT_CANARY);
    const previousRowPtr = exportedNumber(exports.GRADIENT_PREVIOUS_ROW_PTR);
    if (
      abiVersion !== QUANTIZED_GRADIENT_ABI_VERSION ||
      canary !== QUANTIZED_GRADIENT_CANARY ||
      !isBoundedPositiveInteger(cap, MAX_GRADIENT_COLS) ||
      !isBoundedPositiveInteger(quantize.chunk, MAX_GRADIENT_COLS) ||
      !isAlignedPointer(previousRowPtr, Int16Array.BYTES_PER_ELEMENT)
    ) {
      return null;
    }
    const previousRowBytes = cap * Int16Array.BYTES_PER_ELEMENT;
    const ranges = [
      [previousRowPtr, previousRowBytes],
      [quantize.inA.byteOffset, quantize.inA.byteLength],
      [quantize.inB.byteOffset, quantize.inB.byteLength],
      [quantize.out.byteOffset, quantize.out.byteLength],
      [quantize.stats.byteOffset, quantize.stats.byteLength],
    ];
    if (previousRowPtr + previousRowBytes > Number(memory.buffer.byteLength) || rangesOverlap(ranges)) {
      return null;
    }
    const capability = {
      abiVersion,
      canary,
      cap,
      chunk: quantize.chunk,
      output: quantize.out,
      previousRow: new Int16Array(memory.buffer, previousRowPtr, cap),
      resetRaw: exports.resetQuantizedGradient2d,
      encodeRaw: exports.gradientEncodeQuantizedI16,
    };
    if (!passesQuantizedGradientCanary(capability)) {
      return null;
    }
    return Object.freeze({
      abiVersion,
      cap,
      canEncode(cols, cells) {
        return isBoundedPositiveInteger(cols, cap) && Number.isSafeInteger(cells) && cells > 0 && cells % cols === 0;
      },
      reset(cols) {
        if (!isBoundedPositiveInteger(cols, cap)) {
          return false;
        }
        return Number(capability.resetRaw(cols)) === cols;
      },
      encode(count) {
        if (!isBoundedPositiveInteger(count, capability.chunk)) {
          throw new RangeError(`quantized gradient chunk ${String(count)} is outside 1..${capability.chunk}`);
        }
        const progress = Number(capability.encodeRaw(count));
        if (progress !== count) {
          throw new Error(`quantized gradient advanced ${progress} values; expected ${count}`);
        }
        return progress;
      },
    });
  } catch {
    return null;
  }
}

function attachQuantizedGradientCapability(exports, memory, quantize) {
  const gradient = createQuantizedGradientCapability(exports, memory, quantize);
  if (gradient) {
    quantize.gradient = gradient;
  }
  return quantize;
}

const QUANTIZED_GRADIENT_CANARY_INPUT = Object.freeze([
  32767, -32768, -1, 0, 1, 12345, -23456, 99, -100, -32768, 32767, 45, -46, 30000, -30000, 7, 8, 9, 101, 103, 107, 109,
  113, 127, 131, 137, 139,
]);

function passesQuantizedGradientCanary(capability) {
  const cols = 9;
  const splits = [7, 11, QUANTIZED_GRADIENT_CANARY_INPUT.length - 18];
  const expected = gradientEncodeInt16Oracle(QUANTIZED_GRADIENT_CANARY_INPUT, cols);
  const outputTouched = Math.max(...splits) + 2;
  const outputSnapshot = capability.output.slice(0, outputTouched);
  const previousSnapshot = capability.previousRow.slice(0, cols + 1);
  const actual = [];
  let sourceOffset = 0;
  let valid;
  try {
    capability.previousRow.fill(0x1234, 0, cols + 1);
    if (Number(capability.resetRaw(cols)) !== cols) {
      return false;
    }
    for (const count of splits) {
      capability.output.fill(0x2a2a, 0, count + 2);
      capability.output.set(QUANTIZED_GRADIENT_CANARY_INPUT.slice(sourceOffset, sourceOffset + count), 0);
      if (Number(capability.encodeRaw(count)) !== count) {
        return false;
      }
      if (capability.output[count] !== 0x2a2a || capability.output[count + 1] !== 0x2a2a) {
        return false;
      }
      for (let index = 0; index < count; index += 1) {
        actual.push(capability.output[index]);
      }
      sourceOffset += count;
    }
    valid =
      capability.previousRow[cols] === 0x1234 &&
      actual.length === expected.length &&
      expected.every((value, index) => actual[index] === value);
  } catch {
    valid = false;
  } finally {
    try {
      capability.output.set(outputSnapshot, 0);
      capability.previousRow.set(previousSnapshot, 0);
      capability.resetRaw(0);
    } catch {
      valid = false;
    }
  }
  return valid;
}

function gradientEncodeInt16Oracle(input, cols) {
  const absolute = Int16Array.from(input);
  const encoded = new Int16Array(absolute.length);
  for (let index = 0; index < absolute.length; index += 1) {
    const row = Math.floor(index / cols);
    const col = index - row * cols;
    const predictor =
      row === 0
        ? col === 0
          ? 0
          : absolute[index - 1]
        : col === 0
          ? absolute[index - cols]
          : absolute[index - 1] + absolute[index - cols] - absolute[index - cols - 1];
    encoded[index] = absolute[index] - predictor;
  }
  return encoded;
}

function exportedNumber(value) {
  return Number(value?.value ?? value);
}

function isBoundedPositiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isAlignedPointer(value, alignment) {
  return Number.isSafeInteger(value) && value >= 0 && value % alignment === 0;
}

function rangesOverlap(ranges) {
  for (let left = 0; left < ranges.length; left += 1) {
    const [leftStart, leftLength] = ranges[left];
    const leftEnd = leftStart + leftLength;
    for (let right = left + 1; right < ranges.length; right += 1) {
      const [rightStart, rightLength] = ranges[right];
      const rightEnd = rightStart + rightLength;
      if (leftStart < rightEnd && rightStart < leftEnd) {
        return true;
      }
    }
  }
  return false;
}

// Identity of the parcel backend that buildProfileDerivedGrids will
// actually use in this process. Part of the derived-grid cache key so
// grids computed by different backends — including different kernel
// BUILDS (a stale binary without the DCAPE port, or any future numeric
// revision) — are never served to each other. The kernel's numerics
// version and its capability set are folded into the id for that reason.
let warnedUnknownSlabMode = false;

function derivedSlabRequested() {
  // Escape hatch for the Stage G2 slab pipeline: MODELVIEW_DERIVED_SLAB=off
  // keeps the JS cell loop while leaving the kernel scan/DCAPE/product
  // ports active (contrast with MODELVIEW_PARCEL_KERNEL=js, which reverts
  // every numeric deviation at once). Same fail-closed contract as the
  // variant hatch: an unrecognized value can never silently ENABLE the
  // slab pipeline — it disables it with a warning.
  const raw = String(process.env.MODELVIEW_DERIVED_SLAB || "on")
    .trim()
    .toLowerCase();
  if (raw === "on" || raw === "1" || raw === "true") {
    return true;
  }
  if (raw !== "off" && raw !== "js" && raw !== "0" && raw !== "false" && !warnedUnknownSlabMode) {
    warnedUnknownSlabMode = true;
    console.warn(
      `[noaa-beta] unrecognized MODELVIEW_DERIVED_SLAB='${raw}'; using the JS derived cell loop (expected on|off)`,
    );
  }
  return false;
}

function activeParcelKernelId() {
  const kernel = getParcelKernel();
  if (!kernel) {
    return "js";
  }
  // The slab toggle changes derived outputs at the ulp level (JS fill and
  // glue vs the in-kernel ports), so it must be part of the cache identity.
  const slabSuffix = kernel.derivedSlab && !derivedSlabRequested() ? "-noslab" : "";
  return `${kernel.variant}-k${kernel.numericsVersion}${kernel.dcape ? "" : "-nodcape"}${slabSuffix}`;
}

module.exports = {
  CONTINUOUS_COLORIZER_ABI_VERSION,
  QUANTIZED_GRADIENT_ABI_VERSION,
  activeParcelKernelId,
  derivedSlabRequested,
  getParcelKernel,
  loadParcelKernelVariant,
  parcelKernelRequested,
  requestedParcelKernelVariant,
  _testCreateContinuousColorizerCapability: createContinuousColorizerCapability,
  _testCreateQuantizedGradientCapability: createQuantizedGradientCapability,
  KERNEL_WASM_PATH,
};
