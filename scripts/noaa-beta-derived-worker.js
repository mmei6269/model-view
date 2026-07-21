#!/usr/bin/env node

"use strict";

// Sub-worker for intra-frame derived-grid parallelism (default-on via the
// build script's auto resolution when planned frames leave cores idle; see
// scripts/lib/noaa-beta/derived-parallel.js). Rebuilds a decoded-like
// object from the transferred range-sliced grids and runs the IDENTICAL
// buildProfileDerivedGrids code the serial path runs, so partitioning can
// never change values.

const { parentPort } = require("worker_threads");
const { buildProfileDerivedGrids } = require("./lib/noaa-beta/severe");
const { activeParcelKernelId, getParcelKernel } = require("./lib/noaa-beta/parcel-kernel");

if (parentPort) {
  parentPort.on("message", handleMessage);
}

function handleMessage(message) {
  if (message && message.type === "derived-warmup") {
    // Force the lazy wasm kernel compile now (the require graph was paid at
    // spawn), so the first real chunk doesn't carry the startup cost.
    try {
      getParcelKernel();
      parentPort.postMessage({ id: message.id, ok: true, parcelBackend: activeParcelKernelId() });
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        ok: false,
        error: String(error && error.message ? error.message : error),
      });
    }
    return;
  }
  if (!message || message.type !== "derived-range") {
    return;
  }
  try {
    const decoded = {};
    for (const [key, buffer] of Object.entries(message.grids || {})) {
      decoded[key] = new Float32Array(buffer);
    }
    const available = new Set(message.availableParameters || []);
    const profile = {};
    const out = buildProfileDerivedGrids(decoded, available, Number(message.rangeLength) || 0, profile);
    const outputs = {};
    const transfers = [];
    for (const [name, grid] of Object.entries(out)) {
      if (grid instanceof Float32Array) {
        outputs[name] = grid.buffer;
        transfers.push(grid.buffer);
      }
    }
    parentPort.postMessage(
      {
        id: message.id,
        ok: true,
        outputs,
        candidateCount: Number(profile.effectiveDiagnosticsCandidateCount) || 0,
        // Reported so the coordinator can refuse to persist grids computed
        // under a different parcel backend than its cache key assumes.
        parcelBackend: activeParcelKernelId(),
      },
      transfers,
    );
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      ok: false,
      error: String(error && error.message ? error.message : error),
    });
  }
}
