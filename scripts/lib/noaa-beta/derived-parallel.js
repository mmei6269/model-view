"use strict";

// Intra-frame parallelism for buildProfileDerivedGrids: the per-cell
// computation is fully index-independent (per-cell scratch, no cross-cell
// state, no absolute-index geometry), so disjoint cell ranges computed by
// sub-workers running the IDENTICAL buildProfileDerivedGrids code over
// range-sliced input grids produce byte-identical results to one serial
// full-range call. This trades one full copy of the pipeline's input grids
// per frame (~transfered slices summing to one grid set) for wall-clock
// latency, which is the right trade only when frame-level parallelism
// leaves cores idle — --derived-cell-concurrency resolves to that
// automatically ("auto") and full builds keep it at 1 (off).
//
// Dispatch is pull-based over chunks a few slabs wide rather than one
// static 1/N split: per-cell cost varies enormously across the grid (the
// candidate screen makes convective regions orders of magnitude more
// expensive than oceans) and the pool can land on asymmetric cores, so
// equal ranges make the slowest worker the critical path. Chunk boundaries
// cannot change output bytes — only which worker computes which disjoint
// range — and every worker still runs the identical serial code per chunk.
//
// The facsimile ships every grid the pipeline can touch, under the exact
// decoded key that resolves in the coordinator: the surface decode keys,
// the candidate screens, the MSLP fallback, and each reduced/CAM profile
// level grid under whichever of its primary/standard keys is present. The
// sub-worker rebuilds a decoded-like object from those keys, so
// buildDerivedProfileSources/profile-access resolve the same grids.

const path = require("path");
const { Worker } = require("worker_threads");
const { EFFECTIVE_LAYER_PROFILE_LEVELS } = require("../noaa-nam-parameter-catalog");
const { DERIVED_DIAGNOSTIC_PROFILE_LEVELS } = require("./severe");
const { activeParcelKernelId } = require("./parcel-kernel");
const { PROFILE_SURFACE_DECODE_KEYS, profileDecodeKey, standardProfileDecodeKey } = require("./profile-access");
const { clampInt } = require("./util");

const DERIVED_WORKER_PATH = path.resolve(__dirname, "../../noaa-beta-derived-worker.js");

// Matches the wasm kernel's derived-slab height (a perf alignment only:
// full chunks keep sub-worker slab runs full; correctness never depends
// on where chunk boundaries fall).
const DERIVED_SLAB_ALIGN_CELLS = 8192;

// ~this many chunks per worker; enough spread for the pull queue to absorb
// expensive convective regions without drowning in message overhead.
const DERIVED_CHUNKS_PER_WORKER = 5;

const SCREEN_GRID_KEYS = Object.freeze(["mucape", "mlcape", "mlcin", "sbcape", "sbcin", "pressureMsl"]);

const PROFILE_VARIABLES = Object.freeze(["HGT", "TMP", "RH", "UGRD", "VGRD"]);

let pool = null;

function spawnDerivedWorker() {
  if (process.env.MODELVIEW_NOAA_TEST_DERIVED_SPAWN_ERROR) {
    // Test-only fault injection: lets suites prove that spawn pressure
    // degrades to the serial fallback instead of failing frames.
    throw new Error("test-injected derived sub-worker spawn failure");
  }
  const state = { worker: new Worker(DERIVED_WORKER_PATH), dead: false };
  state.worker.unref();
  // A dead worker silently drops postMessage, which would leave range
  // promises pending forever; mark it so dispatch rejects immediately and
  // the next pool acquisition replaces it.
  state.worker.on("exit", () => {
    state.dead = true;
  });
  state.worker.on("error", () => {
    state.dead = true;
  });
  return state;
}

function getDerivedWorkerPool(size) {
  const workers = (pool ? pool.workers : []).filter((state) => !state.dead);
  // Publish the pool BEFORE topping it up: if a spawn throws mid-loop
  // (thread/fd pressure), the workers already spawned in this call stay
  // reachable through the module pool and the next acquisition reuses them
  // instead of orphaning live unref'd threads.
  pool = { size: workers.length, workers, nextId: pool ? pool.nextId : 1 };
  while (workers.length < size) {
    workers.push(spawnDerivedWorker());
    pool.size = workers.length;
  }
  return pool;
}

function collectProfileDerivedGridKeys(decoded) {
  const keys = new Set();
  for (const key of SCREEN_GRID_KEYS) {
    if (decoded[key]) {
      keys.add(key);
    }
  }
  for (const key of Object.values(PROFILE_SURFACE_DECODE_KEYS)) {
    if (decoded[key]) {
      keys.add(key);
    }
  }
  const levels = new Set([...DERIVED_DIAGNOSTIC_PROFILE_LEVELS, ...EFFECTIVE_LAYER_PROFILE_LEVELS]);
  for (const level of levels) {
    for (const variable of PROFILE_VARIABLES) {
      const primaryKey = profileDecodeKey(variable, level);
      if (decoded[primaryKey]) {
        keys.add(primaryKey);
        continue;
      }
      const standardKey = standardProfileDecodeKey(variable, level);
      if (standardKey && decoded[standardKey]) {
        keys.add(standardKey);
      }
    }
  }
  return [...keys].filter((key) => decoded[key] instanceof Float32Array);
}

// Fire-and-forget pool warmup: spawning a sub-worker pays its require
// graph and first use pays the wasm kernel compile. Both are large enough
// to show up inside the first frame's derived stage, so the frame worker
// warms the pool as soon as it knows a payload wants intra-frame
// parallelism — the warmup then overlaps range fetch/decode.
function prewarmDerivedWorkerPool(concurrency) {
  const workerCount = clampInt(concurrency, 2, 16, 2);
  let activePool;
  try {
    activePool = getDerivedWorkerPool(workerCount);
  } catch {
    // A synchronous Worker-spawn throw (thread/fd pressure) must never
    // escape the fire-and-forget prewarm call and fail the frame — the
    // render path re-attempts acquisition and falls back to serial there.
    return Promise.resolve(null);
  }
  return Promise.all(
    activePool.workers.slice(0, workerCount).map((state) => {
      if (state.warmup) {
        return state.warmup;
      }
      const jobId = activePool.nextId++;
      state.warmup = runDerivedRange(state, jobId, { type: "derived-warmup", id: jobId }, undefined).catch(() => {
        // A failed warmup only loses the head start; dispatch re-detects
        // dead workers and the coordinator falls back to serial on error.
        state.warmup = null;
      });
      return state.warmup;
    }),
  );
}

function runDerivedRange(workerState, jobId, message, transfers) {
  return new Promise((resolve, reject) => {
    if (workerState.dead) {
      reject(new Error("derived sub-worker is dead"));
      return;
    }
    const worker = workerState.worker;
    const onMessage = (reply) => {
      if (reply?.id !== jobId) {
        return;
      }
      cleanup();
      if (reply.ok) {
        resolve(reply);
      } else {
        reject(new Error(String(reply.error || "derived-range-failed")));
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`derived sub-worker exited with code ${code} mid-job`));
    };
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.postMessage(message, transfers);
  });
}

function resolveDerivedChunkCells(cellCount, workerCount) {
  const target = Math.max(1, Math.ceil(cellCount / (workerCount * DERIVED_CHUNKS_PER_WORKER)));
  if (cellCount >= DERIVED_SLAB_ALIGN_CELLS * workerCount * 2) {
    return Math.ceil(target / DERIVED_SLAB_ALIGN_CELLS) * DERIVED_SLAB_ALIGN_CELLS;
  }
  return target;
}

async function buildProfileDerivedGridsParallel({ decoded, availableParameters, cellCount, concurrency }) {
  const workerCount = clampInt(concurrency, 2, 16, 2);
  const gridKeys = collectProfileDerivedGridKeys(decoded);
  if (gridKeys.length === 0 || cellCount < workerCount) {
    return null;
  }
  const activePool = getDerivedWorkerPool(workerCount);
  const chunkCells = resolveDerivedChunkCells(cellCount, workerCount);
  const ranges = [];
  for (let start = 0; start < cellCount; start += chunkCells) {
    ranges.push([start, Math.min(cellCount, start + chunkCells)]);
  }
  const replies = new Array(ranges.length);
  const parameters = [...availableParameters];
  // Pull loop: each worker takes the next unclaimed chunk when it finishes
  // its current one, so cheap ocean chunks and expensive convective chunks
  // even out across workers. Slices are cut on demand right before
  // dispatch, which also overlaps the coordinator's copy work with worker
  // compute instead of paying it all up front.
  let cursor = 0;
  let aborted = false;
  const pump = async (workerState) => {
    while (!aborted) {
      const index = cursor;
      if (index >= ranges.length) {
        return;
      }
      cursor += 1;
      const [start, end] = ranges[index];
      const grids = {};
      const transfers = [];
      for (const key of gridKeys) {
        const slice = new Float32Array(decoded[key].subarray(start, end));
        grids[key] = slice.buffer;
        transfers.push(slice.buffer);
      }
      const jobId = activePool.nextId++;
      try {
        replies[index] = await runDerivedRange(
          workerState,
          jobId,
          {
            type: "derived-range",
            id: jobId,
            rangeLength: end - start,
            availableParameters: parameters,
            grids,
          },
          transfers,
        );
      } catch (error) {
        // Stop the other pumps from claiming further chunks; the caller
        // falls back to the serial path on rejection.
        aborted = true;
        throw error;
      }
    }
  };
  await Promise.all(activePool.workers.slice(0, workerCount).map((workerState) => pump(workerState)));
  const merged = mergeDerivedRangeReplies({ ranges, replies, cellCount, localBackend: activeParcelKernelId() });
  merged.chunkCount = ranges.length;
  merged.workerCount = workerCount;
  return merged;
}

function mergeDerivedRangeReplies({ ranges, replies, cellCount, localBackend }) {
  for (let index = 0; index < replies.length; index += 1) {
    const parcelBackend = String(replies[index]?.parcelBackend || "");
    if (parcelBackend !== localBackend) {
      throw new Error(
        `derived parallel parcel backend mismatch in range ${index}: coordinator=${localBackend}, worker=${parcelBackend || "unknown"}`,
      );
    }
  }
  const outputs = {};
  let candidateCount = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const [start, end] = ranges[index];
    const reply = replies[index];
    const expectedBytes = (end - start) * Float32Array.BYTES_PER_ELEMENT;
    candidateCount += Number(reply.candidateCount) || 0;
    for (const [name, buffer] of Object.entries(reply.outputs || {})) {
      // Reject any reply grid whose byte length disagrees with its cell
      // range, like the missing-grid check below: a short reply would .set
      // fewer cells and leave the target's zero-initialized cells in place —
      // and zero is a meaningful rendered value (0 J/kg) where the compute
      // path writes NaN — while an oversized reply is the same protocol
      // violation (previously only the final range's threw, by accidental
      // .set overflow). Throwing engages the caller's serial fallback.
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== expectedBytes) {
        throw new Error(
          `derived parallel range ${index} output grid '${name}' has ${
            buffer instanceof ArrayBuffer ? buffer.byteLength : "unknown"
          } bytes; expected ${expectedBytes} for cells [${start}, ${end})`,
        );
      }
      if (!outputs[name]) {
        outputs[name] = new Float32Array(cellCount);
      }
      outputs[name].set(new Float32Array(buffer), start);
    }
  }
  // Every range must contribute the same grid set; a partial union would
  // leave uninitialized zeros where the compute path writes NaN.
  for (const name of Object.keys(outputs)) {
    for (const reply of replies) {
      if (!reply.outputs?.[name]) {
        throw new Error(`derived parallel range missing output grid '${name}'`);
      }
    }
  }
  return { outputs, candidateCount };
}

module.exports = {
  buildProfileDerivedGridsParallel,
  collectProfileDerivedGridKeys,
  prewarmDerivedWorkerPool,
  _testDerivedWorkerPool: () => pool,
  _testMergeDerivedRangeReplies: mergeDerivedRangeReplies,
  _testResolveDerivedChunkCells: resolveDerivedChunkCells,
};
