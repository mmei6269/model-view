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
      kernel.quantize = {
        chunk: quantChunk,
        inA: new Float32Array(memory.buffer, Number(exports.QIN_A_PTR?.value ?? exports.QIN_A_PTR), quantChunk),
        inB: new Float32Array(memory.buffer, Number(exports.QIN_B_PTR?.value ?? exports.QIN_B_PTR), quantChunk),
        out: new Int16Array(memory.buffer, Number(exports.QOUT_PTR?.value ?? exports.QOUT_PTR), quantChunk),
        stats: new Int32Array(memory.buffer, Number(exports.QSTATS_PTR?.value ?? exports.QSTATS_PTR), 3),
        raw: exports.quantizeRawF64,
        affine: exports.quantizeAffineF64,
        wind: exports.quantizeWindF64,
      };
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
  activeParcelKernelId,
  derivedSlabRequested,
  getParcelKernel,
  loadParcelKernelVariant,
  parcelKernelRequested,
  requestedParcelKernelVariant,
  KERNEL_WASM_PATH,
};
