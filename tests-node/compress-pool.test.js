"use strict";

// The compression pool must be invisible in the bytes: pooled PNG IDAT
// deflate and hover gzip/Brotli run the exact codec entry points the render thread
// would run inline, and every failure mode (spawn failure, worker death
// mid-job) falls back to the identical inline call. Engagement is observable
// through the jobs/fallbacks counters that feed the render profile.
// Backpressure (bounded in-flight jobs, parked FIFO waiters) must hold the
// same contract: waiters drain in submit order, snapshot their inputs at
// submit time, and a dead pool releases them into the inline fallback.

const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("zlib");
const {
  CompressPool,
  compressSync,
  createCompressor,
  resolveCompressMaxPending,
  _testResetSharedCompressPool,
  getSharedCompressPool,
} = require("../scripts/lib/noaa-beta/compress-pool");
const { deflatePngIdatSync } = require("../scripts/lib/noaa-beta/deflate-backend");

function patternBuffer(bytes) {
  const out = Buffer.allocUnsafe(bytes);
  for (let index = 0; index < bytes; index += 1) {
    out[index] = (index * 31 + ((index >> 3) % 7)) & 255;
  }
  return out;
}

test("pooled outputs are byte-identical to the inline codecs (engagement via jobs counter)", async () => {
  const pool = new CompressPool(1);
  const counters = { jobs: 0, fallbacks: 0 };
  const compress = createCompressor(pool, counters);
  try {
    for (const size of [0, 1, 4096, 262144]) {
      const input = patternBuffer(size);
      const pooledIdat = await compress("png-idat", input, 1);
      assert.deepEqual(pooledIdat, deflatePngIdatSync(input, 1), `png-idat mismatch at ${size} bytes`);
      const pooledGzip = await compress("gzip", input, 1);
      assert.deepEqual(pooledGzip, zlib.gzipSync(input, { level: 1 }), `gzip mismatch at ${size} bytes`);
      const pooledBrotli = await compress("brotli", input, 0);
      assert.deepEqual(
        pooledBrotli,
        zlib.brotliCompressSync(input, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 0 } }),
        `brotli mismatch at ${size} bytes`,
      );
    }
    assert.equal(counters.jobs, 12, "every job must run on the pool (engagement)");
    assert.equal(counters.fallbacks, 0);
  } finally {
    pool.markDead(new Error("test done"));
  }
});

test("spawn failure falls back inline with identical bytes (fault injection)", async (t) => {
  process.env.MODELVIEW_NOAA_TEST_COMPRESS_SPAWN_ERROR = "1";
  t.after(() => {
    delete process.env.MODELVIEW_NOAA_TEST_COMPRESS_SPAWN_ERROR;
    _testResetSharedCompressPool();
  });
  _testResetSharedCompressPool();
  const pool = getSharedCompressPool(1);
  assert.equal(pool, null, "spawn failure must yield no pool");
  const counters = { jobs: 0, fallbacks: 0 };
  const compress = createCompressor(pool, counters);
  const input = patternBuffer(8192);
  assert.deepEqual(await compress("png-idat", input, 1), deflatePngIdatSync(input, 1));
  assert.deepEqual(await compress("gzip", input, 1), zlib.gzipSync(input, { level: 1 }));
  assert.equal(counters.jobs, 0);
  assert.equal(counters.fallbacks, 2, "inline fallbacks must be counted (engagement)");
});

test("worker death mid-job falls back inline and the pool stays dead", async () => {
  const pool = new CompressPool(1);
  const counters = { jobs: 0, fallbacks: 0 };
  const compress = createCompressor(pool, counters);
  const input = patternBuffer(65536);
  // Kill the helper while a job is in flight; the submitter kept its input
  // copy, so the fallback must still produce the exact inline bytes.
  const inFlight = compress("gzip", input, 1);
  pool.markDead(new Error("simulated worker death"));
  assert.deepEqual(await inFlight, zlib.gzipSync(input, { level: 1 }));
  assert.equal(counters.fallbacks, 1);
  // Later jobs skip the dead pool entirely.
  assert.deepEqual(await compress("png-idat", input, 1), deflatePngIdatSync(input, 1));
  assert.equal(counters.fallbacks, 2);
  assert.equal(counters.jobs, 0);
});

test("compressSync mirrors the codec entry points", () => {
  const input = patternBuffer(1024);
  assert.deepEqual(compressSync("png-idat", input, 1), deflatePngIdatSync(input, 1));
  assert.deepEqual(compressSync("gzip", input, 1), zlib.gzipSync(input, { level: 1 }));
  assert.deepEqual(
    compressSync("brotli", input, 0),
    zlib.brotliCompressSync(input, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 0 } }),
  );
});

test("resolveCompressMaxPending defaults to 2x threads and clamps", () => {
  assert.equal(resolveCompressMaxPending(null, 1), 2);
  assert.equal(resolveCompressMaxPending(undefined, 2), 4);
  assert.equal(resolveCompressMaxPending("", 4), 8);
  assert.equal(resolveCompressMaxPending("3", 1), 3);
  assert.equal(resolveCompressMaxPending("0", 1), 1, "clamped to at least one in-flight job");
  assert.equal(resolveCompressMaxPending("500", 1), 64, "clamped to the hard cap");
  assert.equal(resolveCompressMaxPending("not-a-number", 2), 4, "invalid values fall back to the default");
  const pool = new CompressPool(2);
  assert.equal(pool.maxPending, 4, "constructor default is 2x threads");
  pool.markDead(new Error("test done"));
});

test("MODELVIEW_NOAA_COMPRESS_MAX_PENDING tunes the shared pool cap", (t) => {
  process.env.MODELVIEW_NOAA_COMPRESS_MAX_PENDING = "1";
  t.after(() => {
    delete process.env.MODELVIEW_NOAA_COMPRESS_MAX_PENDING;
    _testResetSharedCompressPool();
  });
  _testResetSharedCompressPool();
  const pool = getSharedCompressPool(2);
  assert.equal(pool.maxPending, 1);
});

test("backpressure bounds in-flight jobs; every caller still gets its own bytes", async () => {
  const pool = new CompressPool(1, 1);
  const counters = { jobs: 0, fallbacks: 0 };
  const compress = createCompressor(pool, counters);
  try {
    const inputs = [patternBuffer(4096), patternBuffer(8192), patternBuffer(16384)];
    const pendingGzip = compress("gzip", inputs[0], 1);
    const pendingIdat = compress("png-idat", inputs[1], 1);
    const parkedGzip = compress("gzip", inputs[2], 1);
    // Synchronous state right after the flood: only one job in flight, the
    // other two parked FIFO (worker replies can only arrive via the event
    // loop, which cannot run during this synchronous block).
    assert.equal(pool.pendingById.size, 1, "in-flight jobs must be capped");
    assert.equal(pool.waiters.length, 2, "excess submitters must park");
    assert.equal(pool.waiters[0].kind, "png-idat", "waiters drain in submit order");
    assert.equal(pool.waiters[1].kind, "gzip");
    const [gzipBody, idatBody, parkedBody] = await Promise.all([pendingGzip, pendingIdat, parkedGzip]);
    // No completion reordering: each caller settles with its own job's bytes.
    assert.deepEqual(gzipBody, zlib.gzipSync(inputs[0], { level: 1 }));
    assert.deepEqual(idatBody, deflatePngIdatSync(inputs[1], 1));
    assert.deepEqual(parkedBody, zlib.gzipSync(inputs[2], { level: 1 }));
    assert.equal(counters.jobs, 3, "parked jobs still ran on the pool (engagement)");
    assert.equal(counters.fallbacks, 0);
    assert.equal(pool.waiters.length, 0);
  } finally {
    pool.markDead(new Error("test done"));
  }
});

test("parked jobs snapshot their input at submit time (scratch-reuse safety)", async () => {
  // deflatePngIdatViaPool releases its shared scanline scratch the moment
  // submit returns; a later layer overwrites that buffer while the parked
  // job still waits. The parked copy must freeze the submit-time bytes.
  const pool = new CompressPool(1, 1);
  try {
    const original = patternBuffer(65536);
    const buf = Buffer.from(original);
    const expected = zlib.gzipSync(original, { level: 1 });
    const inFlight = pool.submit("gzip", buf, 1);
    const parked = pool.submit("gzip", buf, 1);
    assert.equal(pool.waiters.length, 1, "second submit must park at cap 1");
    buf.fill(0xa5); // overwrite like a reused scratch slot
    const [inFlightBody, parkedBody] = await Promise.all([inFlight, parked]);
    assert.deepEqual(inFlightBody, expected);
    assert.deepEqual(parkedBody, expected, "parked job must deflate the submit-time bytes, not the scratch");
  } finally {
    pool.markDead(new Error("test done"));
  }
});

test("dead pool releases backpressured waiters into the inline fallback (no deadlock)", async () => {
  const pool = new CompressPool(1, 1);
  const counters = { jobs: 0, fallbacks: 0 };
  const compress = createCompressor(pool, counters);
  const big = patternBuffer(4 * 1024 * 1024);
  const inputs = [patternBuffer(4096), patternBuffer(8192)];
  const inFlight = compress("gzip", big, 1);
  const parkedGzip = compress("gzip", inputs[0], 1);
  const parkedIdat = compress("png-idat", inputs[1], 1);
  assert.equal(pool.pendingById.size, 1);
  assert.equal(pool.waiters.length, 2);
  pool.markDead(new Error("simulated worker death"));
  assert.equal(pool.waiters.length, 0, "waiters must be released, not left hanging");
  // Every caller falls back per call to the identical inline codec bytes.
  assert.deepEqual(await inFlight, zlib.gzipSync(big, { level: 1 }));
  assert.deepEqual(await parkedGzip, zlib.gzipSync(inputs[0], { level: 1 }));
  assert.deepEqual(await parkedIdat, deflatePngIdatSync(inputs[1], 1));
  assert.equal(counters.jobs, 0);
  assert.equal(counters.fallbacks, 3, "in-flight and parked jobs both count a fallback");
});

test("real worker death mid-flight releases waiters into the inline fallback (fault injection)", async () => {
  const pool = new CompressPool(1, 1);
  const counters = { jobs: 0, fallbacks: 0 };
  const compress = createCompressor(pool, counters);
  const big = patternBuffer(8 * 1024 * 1024);
  const small = patternBuffer(4096);
  // The level-9 8 MiB gzip cannot finish in the microseconds before
  // terminate() lands, so the death is deterministic: in-flight job plus one
  // parked waiter, both released by the exit event through markDead.
  const inFlight = compress("gzip", big, 9);
  const parked = compress("gzip", small, 1);
  assert.equal(pool.waiters.length, 1);
  await pool.workers[0].terminate();
  assert.equal(pool.dead, true, "non-zero worker exit must kill the pool");
  assert.deepEqual(await inFlight, zlib.gzipSync(big, { level: 9 }));
  assert.deepEqual(await parked, zlib.gzipSync(small, { level: 1 }));
  assert.equal(counters.jobs, 0);
  assert.equal(counters.fallbacks, 2);
  // The pool stays dead: later jobs go straight inline.
  assert.deepEqual(await compress("gzip", small, 1), zlib.gzipSync(small, { level: 1 }));
  assert.equal(counters.fallbacks, 3);
});
