"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  PINNED_BUILDER_FLAGS,
  PINNED_ENV_DEFAULTS,
  PINNED_PROCESS_ENV_DEFAULTS,
  SOURCE_FINGERPRINT_ENTRIES,
  SUMMARY_SCHEMA_VERSION,
  buildBenchmarkEnvironment,
  buildPinnedBuilderArgs,
  collectHostLoadSnapshot,
  collectSourceProvenance,
  collectSystemProvenance,
  collectToolProvenance,
  fingerprintSourceTree,
  normalizeBenchmarkOptions,
  parseBenchmarkReceiptSideband,
  parseRendererBenchmarkLog,
  partitionBenchmarkReceiptSideband,
  resolveBuilderConfig,
  summarizeSamples,
  validateBenchmarkColorLookupTreatment,
  validateBenchmarkMainFrameRoster,
  validateBenchmarkSnowRfTreatment,
} = require("../scripts/benchmark-noaa-renderer");
const { _testFormatRenderProfile: formatRenderProfile } = require("../scripts/build-noaa-beta-artifacts");
const { initializeSnowRfBenchmarkRole } = require("../scripts/lib/noaa-beta/snow-rf-role-receipt");
const { _resetSnowRfLoaderForTest: resetSnowRfLoaderForTest } = require("../scripts/lib/noaa-beta/selection");

const ROOT_DIR = path.resolve(__dirname, "..");

function makeTemporarySourceTree(t) {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-benchmark-harness-"));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  for (const directory of ["scripts", "scripts/lib/noaa-beta/generated", "shared", "tools/parcel-kernel/build"]) {
    fs.mkdirSync(path.join(sourceRoot, directory), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT_DIR, ".gitattributes"), path.join(sourceRoot, ".gitattributes"));
  fs.writeFileSync(path.join(sourceRoot, "package.json"), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(sourceRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(sourceRoot, "scripts/build-noaa-beta-artifacts.js"), 'console.log("builder");\n');
  fs.writeFileSync(path.join(sourceRoot, "scripts/noaa-beta-frame-worker.js"), 'console.log("frame");\n');
  fs.writeFileSync(path.join(sourceRoot, "scripts/noaa-beta-derived-worker.js"), 'console.log("derived");\n');
  fs.writeFileSync(path.join(sourceRoot, "scripts/noaa-beta-compress-worker.js"), 'console.log("compress");\n');
  fs.writeFileSync(path.join(sourceRoot, "shared/config.json"), '{"fixture":true}\n');
  fs.writeFileSync(
    path.join(sourceRoot, "tools/parcel-kernel/build/parcel-kernel.wasm"),
    Buffer.from([0, 97, 115, 109]),
  );
  for (const relativePath of [
    "scripts/lib/noaa-beta/catalog-color-lookup-asset.js",
    "scripts/lib/noaa-beta/color-lookup-compiler.js",
    "scripts/lib/noaa-beta/util.js",
    "scripts/lib/noaa-beta/generated/catalog-color-lookups-v1.json",
    "scripts/lib/noaa-beta/generated/catalog-color-lookups-v1.bin",
    "scripts/lib/noaa-beta/snow-rf-compiler.js",
    "scripts/lib/noaa-beta/snow-rf-asset.js",
    "scripts/lib/noaa-beta/generated/snow-rf-conus-v1.json",
    "scripts/lib/noaa-beta/generated/snow-rf-conus-v1.bin",
  ]) {
    fs.copyFileSync(path.join(ROOT_DIR, relativePath), path.join(sourceRoot, relativePath));
  }
  return sourceRoot;
}

function benchmarkReceiptFixtureSource(...bodyLines) {
  return [
    '"use strict";',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "scripts/lib/noaa-beta/generated/catalog-color-lookups-v1.json"), "utf8"));',
    "const requestedMode = process.env.MODELVIEW_NOAA_COLOR_LOOKUPS;",
    'const effectiveMode = requestedMode === "dynamic" ? "dynamic" : "precompiled";',
    "const state = {",
    "  requestedMode, effectiveMode, fallbackReason: null, fallbackReasonCode: null,",
    "  identity: {",
    "    compilerId: manifest.compiler.id,",
    '    compilerClosureSha256: effectiveMode === "precompiled" ? manifest.compiler.closure.sha256 : null,',
    "    inputSha256: manifest.input.sha256,",
    '    assignmentMappingSha256: effectiveMode === "precompiled" ? manifest.assignmentMapping.sha256 : null,',
    '    binarySha256: effectiveMode === "precompiled" ? manifest.binary.sha256 : null,',
    '    binaryByteLength: effectiveMode === "precompiled" ? manifest.binary.byteLength : null,',
    "    assignmentCount: manifest.input.assignmentCount,",
    '    paletteCount: effectiveMode === "precompiled" ? manifest.paletteCount : null,',
    "  },",
    "  status: {",
    "    assignmentCount: manifest.input.assignmentCount,",
    '    paletteCount: effectiveMode === "precompiled" ? manifest.paletteCount : null,',
    "    logicalColorBytes: 2670592,",
    '    readMs: effectiveMode === "precompiled" ? 0.2 : 0,',
    '    validateMs: effectiveMode === "precompiled" ? 0.3 : 0,',
    '    materializeMs: effectiveMode === "precompiled" ? 0.4 : 0,',
    '    compileMs: effectiveMode === "dynamic" ? 1 : 0,',
    "    fallbackAttemptMs: 0, totalMs: 1.1,",
    "  },",
    "};",
    "function writeFrame(body) {",
    "  const frame = Buffer.alloc(8 + body.length);",
    '  frame.write("MVBR", 0, "ascii");',
    "  frame.writeUInt32BE(body.length, 4);",
    "  body.copy(frame, 8);",
    "  fs.writeSync(3, frame);",
    "}",
    "function writeReceipt(role, spawnOrdinal, threadId) {",
    '  writeFrame(Buffer.from(JSON.stringify({ schemaVersion: 1, type: "noaa-color-lookup-state", role, spawnOrdinal, processId: process.pid, threadId, state })));',
    "}",
    'writeReceipt("builder-main", 0, 0);',
    'writeReceipt("frame-worker", 1, 1);',
    "if (process.env.MODELVIEW_NOAA_SNOW_RF_ASSET) {",
    `  const snowRoleReceipt = require(${JSON.stringify(path.join(ROOT_DIR, "scripts/lib/noaa-beta/snow-rf-role-receipt.js"))});`,
    `  const snowSelection = require(${JSON.stringify(path.join(ROOT_DIR, "scripts/lib/noaa-beta/selection.js"))});`,
    "  const writeSnowReceipt = (role, spawnOrdinal, threadId) => {",
    "    snowSelection._resetSnowRfLoaderForTest();",
    "    writeFrame(Buffer.from(JSON.stringify(snowRoleReceipt.initializeSnowRfBenchmarkRole({ role, spawnOrdinal, threadId }))));",
    "  };",
    '  writeSnowReceipt("builder-main", 0, 0);',
    '  writeSnowReceipt("frame-worker", 1, 1);',
    "}",
    ...bodyLines,
  ].join("\n");
}

function encodeBenchmarkReceiptsForTest(receipts) {
  return Buffer.concat(
    receipts.map((receipt) => {
      const body = Buffer.from(JSON.stringify(receipt));
      const frame = Buffer.alloc(8 + body.byteLength);
      frame.write("MVBR", 0, "ascii");
      frame.writeUInt32BE(body.byteLength, 4);
      body.copy(frame, 8);
      return frame;
    }),
  );
}

// Mode-A role initialization parses the 26 MB Snow-RF JSON, so each pair is
// built by real initializeSnowRfBenchmarkRole calls once and reused. The
// loader cache is reset around every call because each role must observe one
// fresh production load, exactly as the builder main process and its worker
// thread do.
const snowRfReceiptPairCache = new Map();
function snowRfReceiptPairForTest(mode) {
  if (snowRfReceiptPairCache.has(mode)) {
    return snowRfReceiptPairCache.get(mode);
  }
  const previousMode = process.env.MODELVIEW_NOAA_SNOW_RF_ASSET;
  const receipts = [];
  try {
    process.env.MODELVIEW_NOAA_SNOW_RF_ASSET = mode;
    for (const [role, spawnOrdinal, threadId] of [
      ["builder-main", 0, 0],
      ["frame-worker", 1, 1],
    ]) {
      resetSnowRfLoaderForTest();
      receipts.push(initializeSnowRfBenchmarkRole({ role, spawnOrdinal, threadId }));
    }
  } finally {
    if (previousMode === undefined) {
      delete process.env.MODELVIEW_NOAA_SNOW_RF_ASSET;
    } else {
      process.env.MODELVIEW_NOAA_SNOW_RF_ASSET = previousMode;
    }
    resetSnowRfLoaderForTest();
  }
  snowRfReceiptPairCache.set(mode, receipts);
  return receipts;
}

const PROFILE_LOG = [
  "[noaa-beta] gfs/20260716-0600Z F000 complete finish=00:42:39 elapsed=2.69s valid=2026-07-16T06:00:00Z profile wall=2283.8ms index=6.9ms derivedGrid=226.6ms raw=cache regridBin=1/1 regridFields=66/152 regridBytes=413952000/953344000 regridSparse=1/1 derivedGrids=1/1",
  "[noaa-beta] gfs/20260716-0600Z F003 base partial finish=00:42:39 elapsed=2.65s valid=2026-07-16T09:00:00Z profile wall=2548.5ms index=6.5ms derivedGrid=229.0ms raw=cache regridBin=1/1 regridFields=64/150 regridBytes=401408000/940800000 regridSparse=1/1 derivedGrids=1/1",
  "[noaa-beta] gfs/20260716-0600Z F003 snow-prefix partial finish=00:42:39 elapsed=2ms valid=2026-07-16T09:00:00Z profile wall=1.7ms index=0.0ms snowfallCumulative=0.5ms snowCumCache=1/1",
  "[noaa-beta] gfs/20260716-0600Z F003 snow complete finish=00:42:39 elapsed=52ms valid=2026-07-16T09:00:00Z profile wall=45.7ms index=0.0ms snowfallCumulative=0.2ms raw=cache snowCumCache=1/1",
  "[noaa-beta] gfs/20260716-0600Z F006 base error finish=00:42:41 elapsed=1.01s valid=2026-07-16T12:00:00Z: failed",
  '{"results":[{"model":"gfs","failed":1}]}',
].join("\n");

test("parser distinguishes F000 complete from later base, snow, and prefix work", () => {
  const parsed = parseRendererBenchmarkLog(PROFILE_LOG);
  assert.deepEqual(
    parsed.frames.map((frame) => [frame.hour, frame.renderPart, frame.status, frame.frameKind]),
    [
      [0, "all", "complete", "complete"],
      [3, "base", "partial", "base"],
      [3, "snow-prefix", "partial", "prefix"],
      [3, "snow", "complete", "snow"],
    ],
  );
  assert.deepEqual(parsed.summary.frameCounts, { complete: 1, base: 1, snow: 1, prefix: 1 });
  assert.equal(parsed.summary.main.frameCount, 2, "main combines only complete and base-equivalent frames");
  assert.equal(parsed.failures.frameErrorLines, 1);
  assert.equal(parsed.failures.reportedFailedFrames, 1);
});

test("scheduler elapsed timing is parsed separately and never becomes a profile stage", () => {
  const parsed = parseRendererBenchmarkLog(PROFILE_LOG);
  assert.equal(parsed.frames[0].elapsedMs, 2690);
  assert.equal(parsed.frames[2].elapsedMs, 2);
  assert.equal(parsed.frames[3].elapsedMs, 52);
  for (const frame of parsed.frames) {
    assert.equal(Object.hasOwn(frame.stagesMs, "elapsed"), false);
  }
  assert.equal(parsed.summary.main.stages.wall.n, 2);
  assert.deepEqual(parsed.summary.main.stages.wall.samplesMs, [2283.8, 2548.5]);
  assert.equal(parsed.summary.main.stages.wall.sumMs, 4832.3);
  assert.equal(parsed.summary.byFrameKind.snow.stages.wall.medianMs, 45.7);
});

test("stage summaries preserve samples and report median, MAD, p95, and sum", () => {
  assert.deepEqual(summarizeSamples([9, 1, 5, 3]), {
    n: 4,
    samplesMs: [9, 1, 5, 3],
    sumMs: 18,
    medianMs: 4,
    madMs: 2,
    p95Ms: 9,
  });
});

test("cache counters aggregate raw samples and hit totals", () => {
  const counters = parseRendererBenchmarkLog(PROFILE_LOG).summary.cacheCounters;
  assert.deepEqual(counters.regridBin.samples, [
    { hits: 1, total: 1 },
    { hits: 1, total: 1 },
  ]);
  assert.equal(counters.regridBin.hits, 2);
  assert.equal(counters.regridBin.total, 2);
  assert.equal(counters.regridBin.hitRate, 1);
  assert.deepEqual(counters.regridFields.samples, [
    { hits: 66, total: 152 },
    { hits: 64, total: 150 },
  ]);
  assert.equal(counters.regridFields.hits, 130);
  assert.equal(counters.regridFields.total, 302);
  assert.equal(counters.regridBytes.hits, 815360000);
  assert.equal(counters.regridBytes.total, 1894144000);
  assert.equal(counters.regridSparse.hitRate, 1);
  assert.equal(counters.raw.cacheHits, 3);
  assert.equal(counters.snowCumCache.hits, 2);
});

test("benchmark options require an explicit dedicated cache root", () => {
  const base = {
    label: "pass 01",
    model: "gfs",
    date: "20260716",
    cycle: "06",
    hours: "0,3,6,9",
    repetitions: "3",
  };
  assert.throws(() => normalizeBenchmarkOptions(base), /--cache-root is required/);
  assert.throws(() => normalizeBenchmarkOptions({ ...base, "cache-root": ROOT_DIR }), /dedicated cache directory/);
  const normalized = normalizeBenchmarkOptions({ ...base, "cache-root": "output/bench-cache" });
  assert.equal(normalized.cacheRoot, path.join(ROOT_DIR, "output/bench-cache"));
  assert.equal(normalized.outputRoot, path.join(ROOT_DIR, "output/noaa-benchmarks/renderer-20pass"));
  assert.equal(normalized.sourceRoot, ROOT_DIR);
  assert.equal(normalized.labelSlug, "pass-01");
  assert.equal(normalized.hoverArena, "auto");
  assert.equal(normalized.fastPack, "auto");
  assert.equal(normalized.colorLookups, "auto");
  assert.equal(
    normalizeBenchmarkOptions({ ...base, "cache-root": "output/bench-cache", "hover-arena": "off" }).hoverArena,
    "off",
  );
  assert.throws(
    () => normalizeBenchmarkOptions({ ...base, "cache-root": "output/bench-cache", "hover-arena": "sometimes" }),
    /--hover-arena must be 'auto' or 'off'/,
  );
  assert.equal(
    normalizeBenchmarkOptions({ ...base, "cache-root": "output/bench-cache", "fast-pack": "off" }).fastPack,
    "off",
  );
  assert.throws(
    () => normalizeBenchmarkOptions({ ...base, "cache-root": "output/bench-cache", "fast-pack": "sometimes" }),
    /--fast-pack must be 'auto' or 'off'/,
  );
  assert.equal(
    normalizeBenchmarkOptions({
      ...base,
      "cache-root": "output/bench-cache",
      "color-lookups": "precompiled",
    }).colorLookups,
    "precompiled",
  );
  assert.throws(
    () =>
      normalizeBenchmarkOptions({
        ...base,
        "cache-root": "output/bench-cache",
        "color-lookups": "sometimes",
      }),
    /--color-lookups must be 'auto', 'dynamic', or 'precompiled'/,
  );
  assert.equal(normalized.snowRf, "auto");
  for (const mode of ["off", "required"]) {
    assert.equal(
      normalizeBenchmarkOptions({ ...base, "cache-root": "output/bench-cache", "snow-rf": mode }).snowRf,
      mode,
    );
  }
  assert.throws(
    () =>
      normalizeBenchmarkOptions({
        ...base,
        "cache-root": "output/bench-cache",
        "snow-rf": "sometimes",
      }),
    /--snow-rf must be 'auto', 'off', or 'required'/,
  );
  const customOutput = normalizeBenchmarkOptions({
    ...base,
    "cache-root": "output/bench-cache",
    "output-root": "output/noaa-benchmarks/renderer-30pass",
  });
  assert.equal(customOutput.outputRoot, path.join(ROOT_DIR, "output/noaa-benchmarks/renderer-30pass"));
  assert.throws(
    () =>
      normalizeBenchmarkOptions({
        ...base,
        "cache-root": "output/bench-cache",
        "output-root": ROOT_DIR,
      }),
    /dedicated benchmark directory/,
  );
  assert.throws(
    () => normalizeBenchmarkOptions({ ...base, "cache-root": "/tmp/renderer-pass-cache", "source-root": "" }),
    /--source-root is required and may not be blank/,
  );
  assert.throws(
    () =>
      normalizeBenchmarkOptions({
        ...base,
        "cache-root": "/tmp/renderer-pass-cache",
        "source-root": "/tmp/definitely-not-a-real-source-tree",
      }),
    /--source-root must be a repository tree/,
  );
});

test("builder command is pinned and contains no cache-clearing operation", () => {
  const options = normalizeBenchmarkOptions({
    label: "pass-01",
    "cache-root": "/tmp/renderer-pass-cache",
    model: "gfs",
    date: "20260716",
    cycle: "06",
    hours: "0,3,6,9",
    repetitions: "1",
  });
  const args = buildPinnedBuilderArgs(options);
  assert.ok(args[0].endsWith("scripts/build-noaa-beta-artifacts.js"));
  assert.ok(args.includes("--models=gfs"));
  assert.ok(args.includes("--hours-gfs=0,3,6,9"));
  assert.ok(args.includes("--cache-root=/tmp/renderer-pass-cache"));
  for (const flag of PINNED_BUILDER_FLAGS) {
    assert.ok(args.includes(flag), `missing pinned flag ${flag}`);
  }
  const resolved = resolveBuilderConfig(args);
  assert.equal(resolved["artifact-prefix"], "tiles");
  assert.equal(resolved["reflectivity-gates"], "10,15,20");
  assert.equal(resolved["retry-delay-ms"], "2000");
  assert.equal(resolved["snow-persist-backlog"], "8");
  assert.equal(resolved.force, true);
  assert.equal(
    args.some((arg) => /clear|prune|delete|remove/i.test(arg)),
    false,
  );
});

test("explicit source root selects that tree's builder and working source", () => {
  const options = normalizeBenchmarkOptions({
    label: "baseline",
    "cache-root": "/tmp/renderer-baseline-cache",
    "source-root": ROOT_DIR,
    model: "nam",
    date: "20260716",
    cycle: "12",
    hours: "0,1,2,3",
    repetitions: "1",
  });
  const args = buildPinnedBuilderArgs(options);
  assert.equal(options.sourceRoot, ROOT_DIR);
  assert.equal(args[0], path.join(ROOT_DIR, "scripts/build-noaa-beta-artifacts.js"));
  assert.ok(args.includes("--models=nam"));
  assert.ok(args.includes("--hours-nam=0,1,2,3"));
});

test("renderer environment is isolated from shell and source-tree .env values", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  fs.writeFileSync(
    path.join(sourceRoot, ".env"),
    [
      "MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK=1",
      "MODELVIEW_FUTURE_RENDERER_TOGGLE=unsafe-dotenv-value",
      "MODELVIEW_NOAA_HOVER_COMPRESSION=gzip",
      "MODELVIEW_NOAA_HOVER_ENCODING=mvh3",
      "MODELVIEW_NOAA_HOVER_ARENA=off",
      "MODELVIEW_NOAA_FAST_PACK=off",
      "MODELVIEW_NOAA_COLOR_LOOKUPS=dynamic",
      "MODELVIEW_NOAA_SNOW_RF_ASSET=off",
      "WGRIB2=/unsafe/dotenv/wgrib2",
    ].join("\n"),
  );
  const inherited = {
    PATH: "/bin",
    WGRIB2: "/opt/weather/wgrib2",
    MODELVIEW_PARCEL_KERNEL: "js",
    MODELVIEW_NOAA_STRICT_BULK_DECODE: "1",
    MODELVIEW_NOAA_HOVER_ENCODING: "mvh3",
    MODELVIEW_NOAA_HOVER_ARENA: "off",
    MODELVIEW_NOAA_FAST_PACK: "off",
    MODELVIEW_NOAA_COLOR_LOOKUPS: "dynamic",
    MODELVIEW_NOAA_SNOW_RF_ASSET: "off",
    MODELVIEW_SHELL_ONLY_RENDERER_TOGGLE: "unsafe-shell-value",
    UNRELATED_VALUE: "preserved",
  };
  const { env, pins, policy } = buildBenchmarkEnvironment(inherited, { sourceRoot });
  assert.equal(env.MODELVIEW_PARCEL_KERNEL, "wasm-f32");
  assert.equal(env.MODELVIEW_NOAA_HOVER_COMPRESSION, "brotli");
  assert.equal(env.MODELVIEW_NOAA_HOVER_ENCODING, "mvh4");
  assert.equal(env.MODELVIEW_NOAA_HOVER_ARENA, "auto");
  assert.equal(env.MODELVIEW_NOAA_FAST_PACK, "auto");
  assert.equal(env.MODELVIEW_NOAA_COLOR_LOOKUPS, "auto");
  assert.equal(env.MODELVIEW_NOAA_SNOW_RF_ASSET, "auto");
  assert.equal(env.MODELVIEW_NOAA_BENCHMARK_RECEIPTS, "1");
  assert.equal(env.MODELVIEW_NOAA_HOVER_BROTLI_QUALITY, "0");
  assert.equal(env.MODELVIEW_NOAA_STRICT_BULK_DECODE, "");
  assert.equal(env.MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK, "");
  assert.equal(env.MODELVIEW_FUTURE_RENDERER_TOGGLE, "");
  assert.equal(env.MODELVIEW_SHELL_ONLY_RENDERER_TOGGLE, "");
  assert.equal(env.UNRELATED_VALUE, "preserved");
  assert.equal(pins.MODELVIEW_PARCEL_KERNEL.source, "harness-pin");
  assert.equal(pins.MODELVIEW_NOAA_STRICT_BULK_DECODE.source, "harness-sanitized-default");
  assert.deepEqual(pins.WGRIB2, { value: "/opt/weather/wgrib2", source: "inherited-explicit" });
  assert.equal(pins.MODELVIEW_NOAA_HOVER_COMPRESSION.value, "brotli");
  assert.deepEqual(pins.MODELVIEW_NOAA_HOVER_ENCODING, { value: "mvh4", source: "harness-pin" });
  assert.deepEqual(pins.MODELVIEW_NOAA_HOVER_ARENA, { value: "auto", source: "harness-option-pin" });
  assert.deepEqual(pins.MODELVIEW_NOAA_FAST_PACK, { value: "auto", source: "harness-option-pin" });
  assert.deepEqual(pins.MODELVIEW_NOAA_COLOR_LOOKUPS, { value: "auto", source: "harness-option-pin" });
  assert.deepEqual(pins.MODELVIEW_NOAA_SNOW_RF_ASSET, { value: "auto", source: "harness-option-pin" });
  assert.deepEqual(pins.MODELVIEW_NOAA_BENCHMARK_RECEIPTS, { value: "1", source: "harness-pin" });
  assert.equal(env.MODELVIEW_PNG_DEFLATE_BACKEND, PINNED_ENV_DEFAULTS.MODELVIEW_PNG_DEFLATE_BACKEND);
  assert.equal(env.NODE_OPTIONS, PINNED_PROCESS_ENV_DEFAULTS.NODE_OPTIONS);
  assert.equal(env.UV_THREADPOOL_SIZE, "4");
  assert.equal(policy.name, "renderer-isolated-v1");
  assert.equal(policy.dotEnv.exists, true);
  assert.equal(policy.dotEnv.wgrib2Blocked, true);
  assert.ok(policy.dotEnv.rendererKeysBlocked.includes("MODELVIEW_FUTURE_RENDERER_TOGGLE"));
  assert.ok(policy.callerRendererKeysSanitized.includes("MODELVIEW_PARCEL_KERNEL"));
  assert.doesNotMatch(JSON.stringify({ pins, policy }), /unsafe-(?:dotenv|shell)-value/);
});

test("renderer candidate benchmark options are the only environment pin overrides", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  fs.writeFileSync(
    path.join(sourceRoot, ".env"),
    "MODELVIEW_NOAA_HOVER_ARENA=auto\nMODELVIEW_NOAA_FAST_PACK=auto\nMODELVIEW_NOAA_COLOR_LOOKUPS=auto\nMODELVIEW_NOAA_SNOW_RF_ASSET=auto\n",
  );
  const inherited = {
    MODELVIEW_NOAA_HOVER_ARENA: "auto",
    MODELVIEW_NOAA_FAST_PACK: "auto",
    MODELVIEW_NOAA_COLOR_LOOKUPS: "auto",
    MODELVIEW_NOAA_SNOW_RF_ASSET: "auto",
  };
  const { env, pins } = buildBenchmarkEnvironment(inherited, {
    sourceRoot,
    hoverArena: "off",
    fastPack: "off",
    colorLookups: "dynamic",
    snowRf: "required",
  });
  assert.equal(env.MODELVIEW_NOAA_HOVER_ARENA, "off");
  assert.equal(env.MODELVIEW_NOAA_FAST_PACK, "off");
  assert.equal(env.MODELVIEW_NOAA_COLOR_LOOKUPS, "dynamic");
  assert.equal(env.MODELVIEW_NOAA_SNOW_RF_ASSET, "required");
  assert.deepEqual(pins.MODELVIEW_NOAA_HOVER_ARENA, {
    value: "off",
    source: "harness-option-pin",
  });
  assert.deepEqual(pins.MODELVIEW_NOAA_FAST_PACK, {
    value: "off",
    source: "harness-option-pin",
  });
  assert.deepEqual(pins.MODELVIEW_NOAA_COLOR_LOOKUPS, {
    value: "dynamic",
    source: "harness-option-pin",
  });
  assert.deepEqual(pins.MODELVIEW_NOAA_SNOW_RF_ASSET, {
    value: "required",
    source: "harness-option-pin",
  });
  assert.throws(
    () => buildBenchmarkEnvironment(inherited, { sourceRoot, hoverArena: "sometimes" }),
    /--hover-arena must be 'auto' or 'off'/,
  );
  assert.throws(
    () => buildBenchmarkEnvironment(inherited, { sourceRoot, fastPack: "sometimes" }),
    /--fast-pack must be 'auto' or 'off'/,
  );
  assert.throws(
    () => buildBenchmarkEnvironment(inherited, { sourceRoot, colorLookups: "sometimes" }),
    /--color-lookups must be 'auto', 'dynamic', or 'precompiled'/,
  );
  assert.throws(
    () => buildBenchmarkEnvironment(inherited, { sourceRoot, snowRf: "sometimes" }),
    /--snow-rf must be 'auto', 'off', or 'required'/,
  );
});

test("formatted optimization telemetry survives raw main-frame benchmark parsing", () => {
  const suffix = formatRenderProfile({
    stages: { totalMs: 123.4 },
    selectedGribFastPackProbes: 1,
    selectedGribFastPackMetadataHits: 1,
    selectedGribHashBypasses: 1,
    selectedGribHashBypassBytes: 106_654_321,
    selectedGribVerifyHashes: 1,
    selectedGribVerifyHashBytes: 106_654_321,
    compressSharedInputViewBytes: 225_799_068,
    compressSharedInputBackingBytes: 225_799_168,
    compressSharedInputMaxBytes: 226_000_000,
    compressSharedInputUniqueOwners: 1,
    hoverArena: {
      variables: 22,
      cells: 5_131_636,
      planeBytes: 10_263_272,
      headerReserveBytes: 128,
      viewOffsetBytes: 28,
      viewBytes: 225_799_068,
      backingBytes: 225_799_168,
      maxBytes: 226_000_000,
      backingSlackBytes: 100,
      speculativeTailBytes: 0,
      uniqueOwners: 1,
      copyBytes: 0,
    },
    hoverArenaFallbackReason: "growable shared/buffer unavailable",
  });
  const parsed = parseRendererBenchmarkLog(
    `[noaa-beta] hrrr/20260716-0600Z F003 base partial finish=00:42:39 elapsed=2.65s valid=2026-07-16T09:00:00Z${suffix}`,
  );
  assert.equal(parsed.frames.length, 1);
  const counters = parsed.frames[0].counters;
  for (const [name, value] of Object.entries({
    compressSharedInputViewBytes: 225_799_068,
    compressSharedInputBackingBytes: 225_799_168,
    compressSharedInputMaxBytes: 226_000_000,
    compressSharedInputUniqueOwners: 1,
    hoverArenaVariables: 22,
    hoverArenaCells: 5_131_636,
    hoverArenaPlaneBytes: 10_263_272,
    hoverArenaHeaderReserveBytes: 128,
    hoverArenaViewOffsetBytes: 28,
    hoverArenaViewBytes: 225_799_068,
    hoverArenaBackingBytes: 225_799_168,
    hoverArenaMaxBytes: 226_000_000,
    hoverArenaBackingSlackBytes: 100,
    hoverArenaSpeculativeTailBytes: 0,
    hoverArenaUniqueOwners: 1,
    hoverArenaCopyBytes: 0,
    fastPackProbes: 1,
    fastPackMetadataHits: 1,
    hashBypasses: 1,
    hashBypassBytes: 106_654_321,
    verifyHashes: 1,
    verifyHashBytes: 106_654_321,
  })) {
    assert.deepEqual(counters[name], { type: "number", value }, name);
  }
  assert.deepEqual(counters.hoverArenaFallbackReason, {
    type: "string",
    value: "growable shared/buffer unavailable",
  });
});

test("benchmark summary records when wgrib2 uses builder discovery", () => {
  const { env, pins } = buildBenchmarkEnvironment({});
  assert.equal(env.WGRIB2, "", "explicit emptiness blocks an unrecorded .env tool override");
  assert.deepEqual(pins.WGRIB2, { value: null, source: "builder-discovery" });
});

test("source provenance fingerprints the commit and the effective renderer tree", (t) => {
  assert.ok(SOURCE_FINGERPRINT_ENTRIES.includes(".gitattributes"));
  const sourceRoot = makeTemporarySourceTree(t);
  execFileSync("git", ["init", "-q"], { cwd: sourceRoot });
  execFileSync("git", ["add", "."], { cwd: sourceRoot });
  execFileSync(
    "git",
    ["-c", "user.name=Benchmark Test", "-c", "user.email=benchmark@example.invalid", "commit", "-qm", "fixture"],
    { cwd: sourceRoot },
  );

  const clean = collectSourceProvenance(sourceRoot);
  assert.equal(clean.git.available, true);
  assert.match(clean.git.commit, /^[0-9a-f]{40,64}$/);
  assert.equal(clean.git.dirty, false);
  assert.match(clean.tree.sha256, /^[0-9a-f]{64}$/);
  assert.match(clean.diffFingerprintSha256, /^[0-9a-f]{64}$/);

  fs.mkdirSync(path.join(sourceRoot, "output"));
  fs.writeFileSync(path.join(sourceRoot, "output/ignored-benchmark-artifact.bin"), "ignored");
  assert.equal(
    fingerprintSourceTree(sourceRoot).sha256,
    clean.tree.sha256,
    "generated output is outside the renderer-source fingerprint scope",
  );

  fs.appendFileSync(path.join(sourceRoot, ".gitattributes"), "\n# fixture normalization change\n");
  const normalizationDirty = collectSourceProvenance(sourceRoot);
  assert.equal(normalizationDirty.git.dirty, true);
  assert.notEqual(normalizationDirty.tree.sha256, clean.tree.sha256);
  assert.notEqual(normalizationDirty.git.trackedDiffSha256, clean.git.trackedDiffSha256);
  assert.notEqual(normalizationDirty.diffFingerprintSha256, clean.diffFingerprintSha256);

  fs.appendFileSync(path.join(sourceRoot, "scripts/build-noaa-beta-artifacts.js"), 'console.log("changed");\n');
  const dirty = collectSourceProvenance(sourceRoot);
  assert.equal(dirty.git.dirty, true);
  assert.notEqual(dirty.tree.sha256, clean.tree.sha256);
  assert.notEqual(dirty.git.trackedDiffSha256, clean.git.trackedDiffSha256);
  assert.notEqual(dirty.diffFingerprintSha256, clean.diffFingerprintSha256);
});

test("source fingerprint records a deterministic missing .gitattributes contract", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  fs.unlinkSync(path.join(sourceRoot, ".gitattributes"));
  const firstMissing = fingerprintSourceTree(sourceRoot);
  const secondMissing = fingerprintSourceTree(sourceRoot);
  assert.equal(firstMissing.sha256, secondMissing.sha256);
  fs.writeFileSync(path.join(sourceRoot, ".gitattributes"), "*.js text eol=lf\n");
  assert.notEqual(fingerprintSourceTree(sourceRoot).sha256, firstMissing.sha256);
});

test("source fingerprint rejects scoped symlinks instead of hashing only target text", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  const symlinkPath = path.join(sourceRoot, "shared/linked-config.json");
  try {
    fs.symlinkSync("config.json", symlinkPath);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => fingerprintSourceTree(sourceRoot), /rejects scoped symlink 'shared\/linked-config\.json'/);
});

test("tool provenance hashes the harness and concrete builder executables", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  const localWgrib2 = path.join(sourceRoot, "output/noaa-beta-tools/bin/wgrib2");
  fs.mkdirSync(path.dirname(localWgrib2), { recursive: true });
  fs.writeFileSync(localWgrib2, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const tools = collectToolProvenance({ sourceRoot, env: { PATH: "", WGRIB2: "" } });
  for (const name of [
    "benchmarkHarness",
    "nodeExecutable",
    "builderEntrypoint",
    "frameWorker",
    "colorLookupCompiler",
    "colorLookupCompilerDependency",
    "colorLookupAssetLoader",
    "colorLookupManifest",
    "colorLookupBinary",
    "snowRfCompiler",
    "snowRfAssetLoader",
    "snowRfManifest",
    "snowRfBinary",
    "parcelKernelWasm",
  ]) {
    assert.equal(tools[name].available, true, `${name} should resolve`);
    assert.match(tools[name].sha256, /^[0-9a-f]{64}$/);
    assert.ok(tools[name].bytes > 0);
  }
  assert.equal(tools.wgrib2.available, true);
  assert.equal(tools.wgrib2.configured, localWgrib2);
  assert.match(tools.wgrib2.sha256, /^[0-9a-f]{64}$/);
  assert.match(tools.colorLookupAssetBinding.compiler.closure.sha256, /^[0-9a-f]{64}$/);
  assert.match(tools.colorLookupAssetBinding.input.sha256, /^[0-9a-f]{64}$/);
  assert.match(tools.colorLookupAssetBinding.assignmentMapping.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    tools.colorLookupAssetBinding.assignmentMapping.sha256,
    tools.colorLookupAssetBinding.computedAssignmentMappingSha256,
  );
  assert.match(tools.colorLookupAssetBinding.binary.sha256, /^[0-9a-f]{64}$/);
  assert.equal(tools.colorLookupAssetBinding.binary.sha256, tools.colorLookupBinary.sha256);
  assert.equal(tools.colorLookupAssetBinding.binary.byteLength, tools.colorLookupBinary.bytes);
  assert.equal(tools.colorLookupAssetBinding.logicalColorBytes, 2_670_592);
  assert.equal(
    tools.colorLookupAssetBinding.compiler.closure.files.find((file) => file.name === "color-lookup-compiler.js")
      .sha256,
    tools.colorLookupCompiler.sha256,
  );
  assert.equal(
    tools.colorLookupAssetBinding.compiler.closure.files.find((file) => file.name === "util.js").sha256,
    tools.colorLookupCompilerDependency.sha256,
  );
  assert.match(tools.snowRfAssetBinding.compiler.closure.sha256, /^[0-9a-f]{64}$/);
  assert.match(tools.snowRfAssetBinding.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(tools.snowRfAssetBinding.binary.sha256, tools.snowRfBinary.sha256);
  assert.equal(tools.snowRfAssetBinding.binary.bytes, tools.snowRfBinary.bytes);
  assert.equal(tools.snowRfAssetBinding.layout.regionCount, 500);
  assert.equal(tools.snowRfAssetBinding.layout.binaryBytes, tools.snowRfBinary.bytes);
  assert.equal(
    tools.snowRfAssetBinding.compiler.closure.files.find((file) => file.name === "snow-rf-compiler.js").sha256,
    tools.snowRfCompiler.sha256,
  );
  assert.equal(
    tools.snowRfAssetBinding.compiler.closure.files.find((file) => file.name === "snow-rf-asset.js").sha256,
    tools.snowRfAssetLoader.sha256,
  );
});

test("framed sideband proves the main and worker color lookup treatments", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  const tools = collectToolProvenance({ sourceRoot, env: { PATH: "", WGRIB2: "" } });
  const child = spawnSync(process.execPath, ["-e", benchmarkReceiptFixtureSource()], {
    cwd: sourceRoot,
    env: { ...process.env, MODELVIEW_NOAA_COLOR_LOOKUPS: "dynamic", MODELVIEW_NOAA_SNOW_RF_ASSET: "" },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  assert.equal(child.status, 0, child.stderr?.toString("utf8"));
  const sideband = parseBenchmarkReceiptSideband(child.output[3]);
  assert.equal(sideband.errors.length, 0);
  assert.equal(sideband.receipts.length, 2);
  assert.match(sideband.sha256, /^[0-9a-f]{64}$/);
  const validation = validateBenchmarkColorLookupTreatment(sideband, { colorLookups: "dynamic" }, tools, child.pid);
  assert.equal(validation.valid, true, validation.errors.join("; "));
  assert.deepEqual(
    validation.observed.map(({ role, spawnOrdinal, requestedMode, effectiveMode }) => ({
      role,
      spawnOrdinal,
      requestedMode,
      effectiveMode,
    })),
    [
      {
        role: "builder-main",
        spawnOrdinal: 0,
        requestedMode: "dynamic",
        effectiveMode: "dynamic",
      },
      {
        role: "frame-worker",
        spawnOrdinal: 1,
        requestedMode: "dynamic",
        effectiveMode: "dynamic",
      },
    ],
  );

  let autoCase = null;
  for (const mode of ["auto", "precompiled"]) {
    const strictChild = spawnSync(process.execPath, ["-e", benchmarkReceiptFixtureSource()], {
      cwd: sourceRoot,
      env: { ...process.env, MODELVIEW_NOAA_COLOR_LOOKUPS: mode, MODELVIEW_NOAA_SNOW_RF_ASSET: "" },
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    assert.equal(strictChild.status, 0, strictChild.stderr?.toString("utf8"));
    const strictSideband = parseBenchmarkReceiptSideband(strictChild.output[3]);
    const strictValidation = validateBenchmarkColorLookupTreatment(
      strictSideband,
      { colorLookups: mode },
      tools,
      strictChild.pid,
    );
    assert.equal(strictValidation.valid, true, `${mode}: ${strictValidation.errors.join("; ")}`);
    assert.deepEqual(
      strictValidation.observed.map(({ requestedMode, effectiveMode }) => ({
        requestedMode,
        effectiveMode,
      })),
      [
        { requestedMode: mode, effectiveMode: "precompiled" },
        { requestedMode: mode, effectiveMode: "precompiled" },
      ],
    );
    if (mode === "auto") {
      autoCase = { child: strictChild, sideband: strictSideband };
    }
  }

  const forged = structuredClone(sideband);
  forged.receipts[1].receipt.state.effectiveMode = "precompiled";
  const forgedValidation = validateBenchmarkColorLookupTreatment(forged, { colorLookups: "dynamic" }, tools, child.pid);
  assert.equal(forgedValidation.valid, false);
  assert.match(forgedValidation.errors.join("; "), /body length or SHA-256|treatment/);

  const firstFrameBytes = 8 + child.output[3].readUInt32BE(4);
  const missing = parseBenchmarkReceiptSideband(child.output[3].subarray(0, firstFrameBytes));
  const missingValidation = validateBenchmarkColorLookupTreatment(
    missing,
    { colorLookups: "dynamic" },
    tools,
    child.pid,
  );
  assert.equal(missingValidation.valid, false);
  assert.match(missingValidation.errors.join("; "), /exactly 2|exactly 1 frame-worker/);

  const duplicate = parseBenchmarkReceiptSideband(
    Buffer.concat([child.output[3], child.output[3].subarray(firstFrameBytes)]),
  );
  const duplicateValidation = validateBenchmarkColorLookupTreatment(
    duplicate,
    { colorLookups: "dynamic" },
    tools,
    child.pid,
  );
  assert.equal(duplicateValidation.valid, false);
  assert.match(duplicateValidation.errors.join("; "), /exactly 2|exactly 1 frame-worker/);

  const fallbackReceipts = autoCase.sideband.receipts.map(({ receipt }) => {
    const fallback = structuredClone(receipt);
    fallback.state.effectiveMode = "dynamic";
    fallback.state.fallbackReason = "fixture asset failure";
    fallback.state.fallbackReasonCode = "asset-validation-failed";
    fallback.state.identity.compilerClosureSha256 = null;
    fallback.state.identity.assignmentMappingSha256 = null;
    fallback.state.identity.binarySha256 = null;
    fallback.state.identity.binaryByteLength = null;
    fallback.state.identity.paletteCount = null;
    fallback.state.status.paletteCount = null;
    fallback.state.status.readMs = 0;
    fallback.state.status.validateMs = 0;
    fallback.state.status.materializeMs = 0;
    fallback.state.status.compileMs = 1;
    return fallback;
  });
  const fallbackSideband = parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest(fallbackReceipts));
  const fallbackValidation = validateBenchmarkColorLookupTreatment(
    fallbackSideband,
    { colorLookups: "auto" },
    tools,
    autoCase.child.pid,
  );
  assert.equal(fallbackValidation.valid, false);
  assert.match(fallbackValidation.errors.join("; "), /expected auto\/precompiled|reports a color lookup fallback/);

  for (const [name, mutate, expectedPattern] of [
    [
      "missing strict assignment mapping identity",
      (identity) => delete identity.assignmentMappingSha256,
      /assignment mapping identity is missing|precompiled asset identity/,
    ],
    [
      "null strict assignment mapping identity",
      (identity) => {
        identity.assignmentMappingSha256 = null;
      },
      /precompiled asset identity/,
    ],
    [
      "wrong strict assignment mapping identity",
      (identity) => {
        identity.assignmentMappingSha256 = "f".repeat(64);
      },
      /precompiled asset identity/,
    ],
  ]) {
    const receipts = autoCase.sideband.receipts.map(({ receipt }) => {
      const mutated = structuredClone(receipt);
      mutate(mutated.state.identity);
      return mutated;
    });
    const validation = validateBenchmarkColorLookupTreatment(
      parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest(receipts)),
      { colorLookups: "auto" },
      tools,
      autoCase.child.pid,
    );
    assert.equal(validation.valid, false, name);
    assert.match(validation.errors.join("; "), expectedPattern, name);
  }

  for (const [name, mutate] of [
    ["missing dynamic assignment mapping identity", (identity) => delete identity.assignmentMappingSha256],
    [
      "non-null dynamic assignment mapping identity",
      (identity) => {
        identity.assignmentMappingSha256 = tools.colorLookupAssetBinding.assignmentMapping.sha256;
      },
    ],
  ]) {
    const receipts = sideband.receipts.map(({ receipt }) => {
      const mutated = structuredClone(receipt);
      mutate(mutated.state.identity);
      return mutated;
    });
    const validation = validateBenchmarkColorLookupTreatment(
      parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest(receipts)),
      { colorLookups: "dynamic" },
      tools,
      child.pid,
    );
    assert.equal(validation.valid, false, name);
    assert.match(
      validation.errors.join("; "),
      /assignment mapping identity is missing|dynamic treatment unexpectedly reports/,
      name,
    );
  }

  const mismatchedTools = structuredClone(tools);
  mismatchedTools.colorLookupAssetBinding.input.sha256 = "f".repeat(64);
  const mismatchValidation = validateBenchmarkColorLookupTreatment(
    sideband,
    { colorLookups: "dynamic" },
    mismatchedTools,
    child.pid,
  );
  assert.equal(mismatchValidation.valid, false);
  assert.match(mismatchValidation.errors.join("; "), /compiler or input identity/);

  for (const [name, mutate] of [
    [
      "missing manifest assignment mapping",
      (binding) => {
        binding.assignmentMapping = null;
      },
    ],
    [
      "wrong manifest assignment mapping",
      (binding) => {
        binding.assignmentMapping.sha256 = "f".repeat(64);
      },
    ],
    [
      "wrong computed manifest assignment mapping",
      (binding) => {
        binding.computedAssignmentMappingSha256 = "f".repeat(64);
      },
    ],
  ]) {
    const mutatedTools = structuredClone(tools);
    mutate(mutatedTools.colorLookupAssetBinding);
    const validation = validateBenchmarkColorLookupTreatment(
      sideband,
      { colorLookups: "dynamic" },
      mutatedTools,
      child.pid,
    );
    assert.equal(validation.valid, false, name);
    assert.match(validation.errors.join("; "), /manifest assignment mapping/, name);
  }

  const wrongPidValidation = validateBenchmarkColorLookupTreatment(
    sideband,
    { colorLookups: "dynamic" },
    tools,
    child.pid + 1,
  );
  assert.equal(wrongPidValidation.valid, false);
  assert.match(wrongPidValidation.errors.join("; "), /does not match spawned renderer PID/);

  const truncated = parseBenchmarkReceiptSideband(child.output[3].subarray(0, child.output[3].byteLength - 1));
  assert.match(truncated.errors.join("; "), /truncated receipt body/);
});

test("framed sideband proves the main and worker snow-rf treatments", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  const tools = collectToolProvenance({ sourceRoot, env: { PATH: "", WGRIB2: "" } });
  const offReceipts = snowRfReceiptPairForTest("off");
  const requiredReceipts = snowRfReceiptPairForTest("required");
  const offSideband = parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest(offReceipts));
  const requiredSideband = parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest(requiredReceipts));
  assert.equal(offSideband.errors.length, 0);
  assert.equal(requiredSideband.errors.length, 0);

  const offValidation = validateBenchmarkSnowRfTreatment(offSideband, { snowRf: "off" }, tools, process.pid);
  assert.equal(offValidation.valid, true, offValidation.errors.join("; "));
  assert.deepEqual(
    offValidation.observed.map(({ role, spawnOrdinal, resolvedMode, effectiveMode, commitments, ownership }) => ({
      role,
      spawnOrdinal,
      resolvedMode,
      effectiveMode,
      commitments,
      ownership,
    })),
    [
      ["builder-main", 0],
      ["frame-worker", 1],
    ].map(([role, spawnOrdinal]) => ({
      role,
      spawnOrdinal,
      resolvedMode: "off",
      effectiveMode: "json",
      commitments: { regionCount: 500, canonicalModelBinarySha256: tools.snowRfBinary.sha256 },
      ownership: null,
    })),
  );

  const requiredValidation = validateBenchmarkSnowRfTreatment(
    requiredSideband,
    { snowRf: "required" },
    tools,
    process.pid,
  );
  assert.equal(requiredValidation.valid, true, requiredValidation.errors.join("; "));
  assert.equal(requiredValidation.expected.canonicalModelBinarySha256, tools.snowRfBinary.sha256);
  for (const observed of requiredValidation.observed) {
    assert.equal(observed.resolvedMode, "required");
    assert.equal(observed.effectiveMode, "typed-asset");
    assert.deepEqual(observed.commitments, {
      regionCount: 500,
      canonicalModelBinarySha256: tools.snowRfBinary.sha256,
    });
    assert.deepEqual(observed.ownership, {
      commonOwner: true,
      ownerAllocationCount: 1,
      ownerByteLength: tools.snowRfBinary.bytes,
      regionCount: 500,
      privateRegionOwnerCount: 0,
    });
  }

  const mismatchValidation = validateBenchmarkSnowRfTreatment(offSideband, { snowRf: "required" }, tools, process.pid);
  assert.equal(mismatchValidation.valid, false);
  assert.match(mismatchValidation.errors.join("; "), /treatment is off\/json, expected required\/typed-asset/);

  const missing = parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest([requiredReceipts[0]]));
  const missingValidation = validateBenchmarkSnowRfTreatment(missing, { snowRf: "required" }, tools, process.pid);
  assert.equal(missingValidation.valid, false);
  assert.match(missingValidation.errors.join("; "), /exactly 2 snow-rf receipts|exactly 1 frame-worker/);

  const tamperedDigest = requiredReceipts.map((receipt) => structuredClone(receipt));
  tamperedDigest[0].state.commitments.canonicalModelBinarySha256 = "f".repeat(64);
  const tamperedDigestValidation = validateBenchmarkSnowRfTreatment(
    parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest(tamperedDigest)),
    { snowRf: "required" },
    tools,
    process.pid,
  );
  assert.equal(tamperedDigestValidation.valid, false);
  assert.match(tamperedDigestValidation.errors.join("; "), /canonical model binary digest/);

  const tamperedOwnership = requiredReceipts.map((receipt) => structuredClone(receipt));
  tamperedOwnership[1].state.ownership.ownerAllocationCount = 2;
  const tamperedOwnershipValidation = validateBenchmarkSnowRfTreatment(
    parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest(tamperedOwnership)),
    { snowRf: "required" },
    tools,
    process.pid,
  );
  assert.equal(tamperedOwnershipValidation.valid, false);
  assert.match(tamperedOwnershipValidation.errors.join("; "), /typed-asset ownership does not match the one-owner/);

  const jsonOwnership = offReceipts.map((receipt) => structuredClone(receipt));
  jsonOwnership[0].state.ownership = structuredClone(requiredReceipts[0].state.ownership);
  const jsonOwnershipValidation = validateBenchmarkSnowRfTreatment(
    parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest(jsonOwnership)),
    { snowRf: "off" },
    tools,
    process.pid,
  );
  assert.equal(jsonOwnershipValidation.valid, false);
  assert.match(jsonOwnershipValidation.errors.join("; "), /json treatment unexpectedly reports typed-asset ownership/);
});

test("sideband partition separates snow-rf from color receipts and rejects unknown types", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  const tools = collectToolProvenance({ sourceRoot, env: { PATH: "", WGRIB2: "" } });
  const requiredReceipts = snowRfReceiptPairForTest("required");

  const unknownTyped = structuredClone(requiredReceipts[1]);
  unknownTyped.type = "noaa-mystery-state";
  const unknownPartition = partitionBenchmarkReceiptSideband(
    parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest([requiredReceipts[0], unknownTyped])),
  );
  assert.match(unknownPartition.errors.join("; "), /receipt 2 has an unknown type "noaa-mystery-state"/);
  assert.equal(unknownPartition.colorLookup.receipts.length, 0);
  assert.equal(unknownPartition.snowRf.receipts.length, 1);
  const unknownValidation = validateBenchmarkSnowRfTreatment(
    unknownPartition.snowRf,
    { snowRf: "required" },
    tools,
    process.pid,
  );
  assert.equal(unknownValidation.valid, false);
  assert.match(unknownValidation.errors.join("; "), /unknown type/);

  const missingTyped = structuredClone(requiredReceipts[1]);
  delete missingTyped.type;
  const missingPartition = partitionBenchmarkReceiptSideband(
    parseBenchmarkReceiptSideband(encodeBenchmarkReceiptsForTest([missingTyped])),
  );
  assert.match(missingPartition.errors.join("; "), /receipt 1 has an unknown type null/);

  const child = spawnSync(process.execPath, ["-e", benchmarkReceiptFixtureSource()], {
    cwd: sourceRoot,
    env: { ...process.env, MODELVIEW_NOAA_COLOR_LOOKUPS: "auto", MODELVIEW_NOAA_SNOW_RF_ASSET: "required" },
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  assert.equal(child.status, 0, child.stderr?.toString("utf8"));
  const mixed = parseBenchmarkReceiptSideband(child.output[3]);
  assert.equal(mixed.errors.length, 0);
  const mixedPartition = partitionBenchmarkReceiptSideband(mixed);
  assert.equal(mixedPartition.errors.length, 0);
  assert.equal(mixedPartition.colorLookup.receipts.length, 2);
  assert.equal(mixedPartition.snowRf.receipts.length, 2);
  const mixedColorValidation = validateBenchmarkColorLookupTreatment(
    mixedPartition.colorLookup,
    { colorLookups: "auto" },
    tools,
    child.pid,
  );
  assert.equal(mixedColorValidation.valid, true, mixedColorValidation.errors.join("; "));
  const mixedSnowValidation = validateBenchmarkSnowRfTreatment(
    mixedPartition.snowRf,
    { snowRf: "required" },
    tools,
    child.pid,
  );
  assert.equal(mixedSnowValidation.valid, true, mixedSnowValidation.errors.join("; "));
});

test("schema v4 system provenance records runtime, CPU, memory, and host load", () => {
  assert.equal(SUMMARY_SCHEMA_VERSION, 4);
  const system = collectSystemProvenance();
  assert.equal(system.node.version, process.version);
  assert.equal(system.node.arch, process.arch);
  assert.ok(system.cpu.logicalCount >= 1);
  assert.ok(system.cpu.availableParallelism >= 1);
  assert.ok(system.cpu.models.length >= 1);
  assert.ok(system.memory.totalBytes > 0);
  assert.ok(system.memory.freeBytesAtStart > 0);
  assert.match(system.startSnapshot.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(system.startSnapshot.freeBytes > 0);
  if (system.startSnapshot.loadAverage !== null) {
    assert.equal(system.startSnapshot.loadAverage.length, 3);
  }
  if (system.startSnapshot.uptimeSeconds !== null) {
    assert.ok(system.startSnapshot.uptimeSeconds > 0);
  }
  const finishSnapshot = collectHostLoadSnapshot();
  assert.match(finishSnapshot.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(finishSnapshot.freeBytes > 0);
});

test("fixture validation requires every requested main frame exactly once", () => {
  const parsed = parseRendererBenchmarkLog(PROFILE_LOG);
  assert.equal(
    validateBenchmarkMainFrameRoster(parsed.frames, {
      model: "gfs",
      date: "20260716",
      cycle: "06",
      hours: [0, 3],
    }).valid,
    true,
  );

  const invalid = validateBenchmarkMainFrameRoster(
    [
      ...parsed.frames,
      { ...parsed.frames[0] },
      { ...parsed.frames[0], model: "hrrr", hour: 6 },
      { ...parsed.frames[0], run: "20260716-0000Z", hour: 6 },
      { ...parsed.frames[0], hour: 9 },
    ],
    { model: "gfs", date: "20260716", cycle: "06", hours: [0, 3, 6] },
  );
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.missingHours, [6]);
  assert.deepEqual(invalid.duplicateHours, [{ hour: 0, count: 2 }]);
  assert.deepEqual(
    invalid.wrongModelFrames.map(({ model, hour }) => ({ model, hour })),
    [{ model: "hrrr", hour: 6 }],
  );
  assert.deepEqual(
    invalid.wrongRunFrames.map(({ run, hour }) => ({ run, hour })),
    [{ run: "20260716-0000Z", hour: 6 }],
  );
  assert.deepEqual(
    invalid.unexpectedHourFrames.map(({ model, hour }) => ({ model, hour })),
    [{ model: "gfs", hour: 9 }],
  );
  assert.match(invalid.errors.join("; "), /missing main hours 6/);
  assert.match(invalid.errors.join("; "), /duplicate main hours 0x2/);
  assert.match(invalid.errors.join("; "), /wrong-model main frames hrrr\/F006/);
  assert.match(invalid.errors.join("; "), /wrong-run main frames gfs\/F006/);
  assert.match(invalid.errors.join("; "), /wrong-hour main frames gfs\/F009/);
});

test("fixture validation rejects an empty profile roster", () => {
  const validation = validateBenchmarkMainFrameRoster([], { model: "gfs", hours: [0, 3] });
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missingHours, [0, 3]);
  assert.match(validation.errors.join("; "), /no profiled main frames/);
});

test("CLI writes a durable schema-v4 summary with isolated effective inputs", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  const cacheRoot = path.join(sourceRoot, "benchmark-cache");
  fs.writeFileSync(
    path.join(sourceRoot, ".env"),
    [
      "MODELVIEW_NOAA_HOVER_COMPRESSION=gzip",
      "MODELVIEW_NOAA_HOVER_ARENA=auto",
      "MODELVIEW_NOAA_FAST_PACK=auto",
      "MODELVIEW_NOAA_COLOR_LOOKUPS=auto",
      "MODELVIEW_NOAA_SNOW_RF_ASSET=off",
      "MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK=1",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(sourceRoot, "scripts/build-noaa-beta-artifacts.js"),
    benchmarkReceiptFixtureSource(
      'console.log(`[fixture-env] hover=${process.env.MODELVIEW_NOAA_HOVER_COMPRESSION} arena=${process.env.MODELVIEW_NOAA_HOVER_ARENA} fastPack=${process.env.MODELVIEW_NOAA_FAST_PACK} colorLookups=${process.env.MODELVIEW_NOAA_COLOR_LOOKUPS} snowRf=${process.env.MODELVIEW_NOAA_SNOW_RF_ASSET} fault=${process.env.MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK || "off"}`);',
      'console.log("[noaa-beta] gfs/20260716-0600Z F000 complete finish=00:00:01 elapsed=1ms valid=2026-07-16T06:00:00Z profile wall=1.0ms raw=cache");',
    ),
  );
  const label = `harness-schema-test-${process.pid}-${Date.now()}`;
  const stdout = execFileSync(
    process.execPath,
    [
      path.join(ROOT_DIR, "scripts/benchmark-noaa-renderer.js"),
      `--label=${label}`,
      `--cache-root=${cacheRoot}`,
      `--source-root=${sourceRoot}`,
      "--model=gfs",
      "--date=20260716",
      "--cycle=06",
      "--hours=0",
      "--repetitions=1",
      "--hover-arena=off",
      "--fast-pack=off",
      "--color-lookups=dynamic",
      "--snow-rf=required",
    ],
    {
      cwd: ROOT_DIR,
      encoding: "utf8",
      env: {
        ...process.env,
        MODELVIEW_NOAA_HOVER_ARENA: "auto",
        MODELVIEW_NOAA_FAST_PACK: "auto",
        MODELVIEW_NOAA_COLOR_LOOKUPS: "auto",
        MODELVIEW_NOAA_SNOW_RF_ASSET: "off",
        MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK: "1",
      },
    },
  );
  const summaryMatch = stdout.match(/^\[renderer-benchmark\] summary=(.+)$/m);
  assert.ok(summaryMatch, "CLI should report its durable summary path");
  const summaryPath = summaryMatch[1];
  t.after(() => fs.rmSync(path.dirname(summaryPath), { recursive: true, force: true }));
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  assert.equal(summary.schemaVersion, 4);
  assert.equal(summary.provenance.source.stableDuringSession, true);
  assert.match(summary.provenance.source.tree.sha256, /^[0-9a-f]{64}$/);
  assert.match(summary.provenance.tools.benchmarkHarness.sha256, /^[0-9a-f]{64}$/);
  assert.equal(summary.provenance.system.node.version, process.version);
  assert.equal(summary.command.resolvedBuilderConfig["artifact-prefix"], "tiles");
  assert.equal(summary.command.environmentPins.MODELVIEW_NOAA_HOVER_COMPRESSION.value, "brotli");
  assert.deepEqual(summary.command.environmentPins.MODELVIEW_NOAA_HOVER_ARENA, {
    value: "off",
    source: "harness-option-pin",
  });
  assert.deepEqual(summary.command.environmentPins.MODELVIEW_NOAA_FAST_PACK, {
    value: "off",
    source: "harness-option-pin",
  });
  assert.deepEqual(summary.command.environmentPins.MODELVIEW_NOAA_COLOR_LOOKUPS, {
    value: "dynamic",
    source: "harness-option-pin",
  });
  assert.deepEqual(summary.command.environmentPins.MODELVIEW_NOAA_SNOW_RF_ASSET, {
    value: "required",
    source: "harness-option-pin",
  });
  assert.equal(summary.command.environmentPins.MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK.value, "");
  assert.deepEqual(summary.command.environmentPins.MODELVIEW_NOAA_BENCHMARK_RECEIPTS, {
    value: "1",
    source: "harness-pin",
  });
  assert.equal(summary.fixture.hoverArena, "off");
  assert.equal(summary.fixture.fastPack, "off");
  assert.equal(summary.fixture.colorLookups, "dynamic");
  assert.equal(summary.fixture.snowRf, "required");
  assert.match(summary.provenance.system.finishSnapshot.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(summary.provenance.system.finishSnapshot.freeBytes > 0);
  assert.ok(summary.repetitions[0].rawLogIntegrity.bytes > 0);
  assert.match(summary.repetitions[0].rawLogIntegrity.sha256, /^[0-9a-f]{64}$/);
  assert.equal(summary.repetitions[0].colorLookupReceiptSideband.valid, true);
  assert.match(summary.repetitions[0].colorLookupReceiptSideband.sha256, /^[0-9a-f]{64}$/);
  assert.equal(summary.repetitions[0].parsed.colorLookupReceipts.length, 2);
  assert.equal(summary.repetitions[0].parsed.snowRfReceipts.length, 2);
  assert.ok(summary.repetitions[0].subprocessPid > 0);
  assert.ok(
    summary.repetitions[0].parsed.colorLookupReceipts.every(
      ({ receipt }) => receipt.processId === summary.repetitions[0].subprocessPid,
    ),
  );
  assert.ok(
    summary.repetitions[0].parsed.snowRfReceipts.every(
      ({ receipt }) => receipt.processId === summary.repetitions[0].subprocessPid,
    ),
  );
  assert.equal(summary.repetitions[0].parsed.fixtureValidation.colorLookupTreatment.valid, true);
  assert.equal(summary.repetitions[0].parsed.fixtureValidation.snowRfTreatment.valid, true);
  assert.deepEqual(summary.treatment.colorLookups, {
    requestedMode: "dynamic",
    expectedEffectiveMode: "dynamic",
    repetitionsValidated: 1,
    repetitionsObserved: 1,
    effectiveModes: ["dynamic"],
  });
  assert.deepEqual(summary.treatment.snowRf, {
    requestedMode: "required",
    expectedEffectiveMode: "typed-asset",
    repetitionsValidated: 1,
    repetitionsObserved: 1,
    effectiveModes: ["typed-asset"],
  });
  assert.match(
    fs.readFileSync(path.join(path.dirname(summaryPath), "repetition-01.log"), "utf8"),
    /hover=brotli arena=off fastPack=off colorLookups=dynamic snowRf=required fault=off/,
  );
  assert.equal(summary.failures.fixtureValidationFailures, 0);
  assert.equal(summary.repetitions[0].parsed.fixtureValidation.valid, true);
});

test("CLI preserves the raw log and writes a failing summary for an invalid fixture roster", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  const cacheRoot = path.join(sourceRoot, "benchmark-cache");
  fs.writeFileSync(
    path.join(sourceRoot, "scripts/build-noaa-beta-artifacts.js"),
    benchmarkReceiptFixtureSource('console.log("renderer exited cleanly without a profiled main frame");'),
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT_DIR, "scripts/benchmark-noaa-renderer.js"),
      `--label=invalid-roster-${process.pid}-${Date.now()}`,
      `--cache-root=${cacheRoot}`,
      `--source-root=${sourceRoot}`,
      "--model=gfs",
      "--date=20260716",
      "--cycle=06",
      "--hours=0",
      "--repetitions=2",
    ],
    { cwd: ROOT_DIR, encoding: "utf8", env: process.env },
  );
  assert.equal(result.status, 1, result.stderr);
  const summaryMatch = result.stdout.match(/^\[renderer-benchmark\] summary=(.+)$/m);
  assert.ok(summaryMatch, "invalid fixture should still write a durable summary");
  const summaryPath = summaryMatch[1];
  t.after(() => fs.rmSync(path.dirname(summaryPath), { recursive: true, force: true }));
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  assert.equal(summary.failures.processFailures, 0);
  assert.equal(summary.failures.fixtureValidationFailures, 1);
  assert.equal(summary.repetitions.length, 1, "the harness should stop before a second invalid repetition");
  assert.equal(summary.repetitions[0].parsed.fixtureValidation.valid, false);
  assert.match(summary.repetitions[0].parsed.fixtureValidation.errors.join("; "), /no profiled main frames/);
  const rawLogPath = path.join(path.dirname(summaryPath), "repetition-01.log");
  assert.match(fs.readFileSync(rawLogPath, "utf8"), /exited cleanly without a profiled main frame/);
});

test("CLI fails a benchmark whose renderer source changes during the session", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  const cacheRoot = path.join(sourceRoot, "benchmark-cache");
  fs.writeFileSync(
    path.join(sourceRoot, "scripts/build-noaa-beta-artifacts.js"),
    benchmarkReceiptFixtureSource(
      'require("node:fs").appendFileSync(require("node:path").join(process.cwd(), "shared/config.json"), " ");',
      'console.log("[noaa-beta] gfs/20260716-0600Z F000 complete finish=00:00:01 elapsed=1ms valid=2026-07-16T06:00:00Z profile wall=1.0ms raw=cache");',
    ),
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT_DIR, "scripts/benchmark-noaa-renderer.js"),
      `--label=source-mutation-${process.pid}-${Date.now()}`,
      `--cache-root=${cacheRoot}`,
      `--source-root=${sourceRoot}`,
      "--model=gfs",
      "--date=20260716",
      "--cycle=06",
      "--hours=0",
      "--repetitions=1",
    ],
    { cwd: ROOT_DIR, encoding: "utf8", env: process.env },
  );
  assert.equal(result.status, 1, result.stderr);
  const summaryMatch = result.stdout.match(/^\[renderer-benchmark\] summary=(.+)$/m);
  assert.ok(summaryMatch);
  const summaryPath = summaryMatch[1];
  t.after(() => fs.rmSync(path.dirname(summaryPath), { recursive: true, force: true }));
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  assert.equal(summary.repetitions[0].parsed.fixtureValidation.valid, true);
  assert.equal(summary.provenance.source.stableDuringSession, false);
  assert.equal(summary.failures.sourceChangedDuringSession, true);
  assert.ok(summary.provenance.source.observedAtFinish);
});

test("CLI fails when the source .env changes without persisting its values", (t) => {
  const sourceRoot = makeTemporarySourceTree(t);
  const cacheRoot = path.join(sourceRoot, "benchmark-cache");
  fs.writeFileSync(
    path.join(sourceRoot, ".env"),
    "MODELVIEW_NOAA_COLOR_LOOKUPS=auto\nPRIVATE_FIXTURE_TOKEN=do-not-persist\n",
  );
  fs.writeFileSync(
    path.join(sourceRoot, "scripts/build-noaa-beta-artifacts.js"),
    benchmarkReceiptFixtureSource(
      'require("node:fs").appendFileSync(require("node:path").join(process.cwd(), ".env"), "# changed during run\\n");',
      'console.log("[noaa-beta] gfs/20260716-0600Z F000 complete finish=00:00:01 elapsed=1ms valid=2026-07-16T06:00:00Z profile wall=1.0ms raw=cache");',
    ),
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT_DIR, "scripts/benchmark-noaa-renderer.js"),
      `--label=environment-mutation-${process.pid}-${Date.now()}`,
      `--cache-root=${cacheRoot}`,
      `--source-root=${sourceRoot}`,
      "--model=gfs",
      "--date=20260716",
      "--cycle=06",
      "--hours=0",
      "--repetitions=1",
    ],
    { cwd: ROOT_DIR, encoding: "utf8", env: process.env },
  );
  assert.equal(result.status, 1, result.stderr);
  const summaryMatch = result.stdout.match(/^\[renderer-benchmark\] summary=(.+)$/m);
  assert.ok(summaryMatch);
  const summaryPath = summaryMatch[1];
  t.after(() => fs.rmSync(path.dirname(summaryPath), { recursive: true, force: true }));
  const summaryBody = fs.readFileSync(summaryPath, "utf8");
  const summary = JSON.parse(summaryBody);
  assert.equal(summary.repetitions[0].parsed.fixtureValidation.valid, true);
  assert.equal(summary.provenance.source.stableDuringSession, true);
  assert.equal(summary.provenance.environment.stableDuringSession, false);
  assert.equal(summary.failures.environmentChangedDuringSession, true);
  assert.notEqual(summary.provenance.environment.dotEnv.sha256, summary.provenance.environment.observedAtFinish.sha256);
  assert.doesNotMatch(summaryBody, /do-not-persist|PRIVATE_FIXTURE_TOKEN/);
});
