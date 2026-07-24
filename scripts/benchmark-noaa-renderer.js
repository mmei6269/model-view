#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { finished } = require("node:stream/promises");
const {
  normalizeCycle,
  normalizeDate,
  normalizeNoaaModelKey,
  parseHours,
  validateHoursForModel,
} = require("./lib/noaa-build/run-resolution");
const { SNOW_RF_RECEIPT_SCHEMA_VERSION, SNOW_RF_RECEIPT_TYPE } = require("./lib/noaa-beta/snow-rf-asset");
const {
  PASS16_REGION_COMMITMENT_COUNT,
  validatePass16TimingAndMemory,
} = require("./lib/noaa-beta/snow-rf-benchmark-contract");

const ROOT_DIR = path.resolve(__dirname, "..");
const BENCHMARK_OUTPUT_ROOT = path.join(ROOT_DIR, "output/noaa-benchmarks/renderer-20pass");
const SUMMARY_SCHEMA_VERSION = 4;
const SOURCE_FINGERPRINT_ENTRIES = Object.freeze([
  ".gitattributes",
  "package.json",
  "package-lock.json",
  "scripts",
  "shared",
  "tools",
]);
const BENCHMARK_RECEIPT_ENV = "MODELVIEW_NOAA_BENCHMARK_RECEIPTS";
const BENCHMARK_RECEIPT_MAGIC = Buffer.from("MVBR");
const BENCHMARK_RECEIPT_SCHEMA_VERSION = 1;
const BENCHMARK_RECEIPT_TYPE = "noaa-color-lookup-state";
const COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING = "sorted-id-palette-sha256-byte-length-nul-v1";
const EXPECTED_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256 =
  "7ce7ec6c56506eecea40d197a18ae1c847217d95439850747838c4eb122fe964";
const SNOW_RF_COMMITMENT_ENCODING = "snow-rf-tree-major-fields-le-v1";
// Each Snow-RF receipt carries 500 region commitments (~90 KB), so the
// per-receipt and whole-sideband ceilings sit well above the 4-receipt load.
const MAX_BENCHMARK_RECEIPT_BYTES = 256 * 1024;
const MAX_BENCHMARK_SIDEBAND_BYTES = 4 * 1024 * 1024;

// These values are benchmark inputs, not user preferences. They are always
// pinned so a caller's shell and a candidate tree's .env cannot silently turn
// an A/B run into a comparison of different renderer configurations.
const PINNED_ENV_DEFAULTS = Object.freeze({
  MODELVIEW_PARCEL_KERNEL: "wasm-f32",
  MODELVIEW_DERIVED_SLAB: "on",
  MODELVIEW_PNG_DEFLATE_BACKEND: "libdeflate",
  MODELVIEW_NOAA_COMPRESS_MAX_PENDING: "2",
  MODELVIEW_NOAA_HOVER_ENCODING: "mvh4",
  MODELVIEW_NOAA_HOVER_ARENA: "auto",
  MODELVIEW_NOAA_FAST_PACK: "auto",
  MODELVIEW_NOAA_COLOR_LOOKUPS: "auto",
  MODELVIEW_NOAA_SNOW_RF_ASSET: "auto",
  [BENCHMARK_RECEIPT_ENV]: "1",
  MODELVIEW_NOAA_HOVER_COMPRESSION: "brotli",
  MODELVIEW_NOAA_HOVER_BROTLI_QUALITY: "0",
  MODELVIEW_NOAA_HOVER_GZIP_LEVEL: "1",
  MODELVIEW_ARTIFACT_PREFIX: "tiles",
  MODELVIEW_REFLECTIVITY_GATES: "10,15,20",
});

// Every currently known environment control on the builder/renderer path is
// made present in the child environment. Empty values intentionally select
// the code default while also preventing loadDotEnv() from filling a hidden
// value. Newly introduced MODELVIEW_* keys exported by the caller or present
// in .env are discovered and sanitized by buildBenchmarkEnvironment too.
const KNOWN_RENDERER_ENV_INPUTS = Object.freeze([
  "MODELVIEW_CACHE_ROOT",
  "MODELVIEW_NOAA_BETA_CACHE_ROOT",
  "MODELVIEW_CACHE_BUDGET_GB",
  "MODELVIEW_DATA_HOST",
  "MODELVIEW_DATA_PORT",
  "MODELVIEW_ARTIFACT_BASE_URL",
  "MODELVIEW_ARTIFACT_PREFIX",
  "MODELVIEW_ARTIFACT_WRITE_CONCURRENCY",
  "MODELVIEW_DERIVED_SLAB",
  "MODELVIEW_FRAME_RETRIES",
  "MODELVIEW_NOAA_BASE_URL",
  "MODELVIEW_NOAA_BETA_HOURS",
  "MODELVIEW_NOAA_BETA_MODELS",
  BENCHMARK_RECEIPT_ENV,
  "MODELVIEW_NOAA_COMPRESS_MAX_PENDING",
  "MODELVIEW_NOAA_COMPRESS_THREADS",
  "MODELVIEW_NOAA_DECODE_CONCURRENCY",
  "MODELVIEW_NOAA_DERIVED_CELL_CONCURRENCY",
  "MODELVIEW_NOAA_FORCE_RENDER",
  "MODELVIEW_NOAA_FRAME_CONCURRENCY",
  "MODELVIEW_NOAA_FULL_RUN",
  "MODELVIEW_NOAA_GFS_BASE_URL",
  "MODELVIEW_NOAA_GFS_HOURLY_THROUGH_120",
  "MODELVIEW_NOAA_GFS_HOURS",
  "MODELVIEW_NOAA_GLOBAL_FRAME_CONCURRENCY",
  "MODELVIEW_NOAA_GLOBAL_FRAME_QUEUE",
  "MODELVIEW_NOAA_GLOBAL_PERSIST_BACKLOG",
  "MODELVIEW_NOAA_GLOBAL_PERSIST_CONCURRENCY",
  "MODELVIEW_NOAA_GLOBAL_PERSIST_QUEUE",
  "MODELVIEW_NOAA_HOVER_BROTLI_QUALITY",
  "MODELVIEW_NOAA_HOVER_COMPRESSION",
  "MODELVIEW_NOAA_HOVER_ENCODING",
  "MODELVIEW_NOAA_HOVER_ARENA",
  "MODELVIEW_NOAA_FAST_PACK",
  "MODELVIEW_NOAA_COLOR_LOOKUPS",
  "MODELVIEW_NOAA_HOVER_GZIP_LEVEL",
  "MODELVIEW_NOAA_HRRR_BASE_URL",
  "MODELVIEW_NOAA_HRRR_HOURS",
  "MODELVIEW_NOAA_INPUT_PREFETCH",
  "MODELVIEW_NOAA_MODEL_CONCURRENCY",
  "MODELVIEW_NOAA_NAM3KM_BASE_URL",
  "MODELVIEW_NOAA_NAM3KM_HOURS",
  "MODELVIEW_NOAA_NAM_BASE_URL",
  "MODELVIEW_NOAA_NAM_HOURS",
  "MODELVIEW_NOAA_PERSIST_MANIFEST_EACH_FRAME",
  "MODELVIEW_NOAA_PROFILE",
  "MODELVIEW_NOAA_RANGE_CONCURRENCY",
  "MODELVIEW_NOAA_REQUIRE_FULL_HORIZON",
  "MODELVIEW_NOAA_RETRY_FRAME_CONCURRENCY",
  "MODELVIEW_NOAA_RUN_OFFSET",
  "MODELVIEW_NOAA_SNOW_PERSIST_BACKLOG",
  "MODELVIEW_NOAA_SNOW_PERSIST_CONCURRENCY",
  "MODELVIEW_NOAA_SNOW_RF_ASSET",
  "MODELVIEW_NOAA_STRICT_BULK_DECODE",
  "MODELVIEW_NOAA_TEST_COMPRESS_SPAWN_ERROR",
  "MODELVIEW_NOAA_TEST_DERIVED_SPAWN_ERROR",
  "MODELVIEW_NOAA_TEST_FRZR_DROP_CHUNK",
  "MODELVIEW_NOAA_TOTAL_FRAME_CONCURRENCY",
  "MODELVIEW_NOAA_TOTAL_RANGE_CONCURRENCY",
  "MODELVIEW_NOAA_WORKER_COUNT",
  "MODELVIEW_NOAA_WORKER_SCRIPT",
  "MODELVIEW_PARCEL_KERNEL",
  "MODELVIEW_PNG_DEFLATE_BACKEND",
  "MODELVIEW_REFLECTIVITY_GATES",
  "MODELVIEW_RETRY_DELAY_MS",
  "MODELVIEW_SNOW_RF_CONUS_PATH",
  "MODELVIEW_SNOW_WESTERN_LINEAR_PATH",
]);

// Node/process controls can materially perturb timings or inject code before
// the builder starts. Pin the meaningful defaults and record them alongside
// the renderer controls in every summary.
const PINNED_PROCESS_ENV_DEFAULTS = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  NODE_DEBUG: "",
  NODE_OPTIONS: "",
  NODE_PATH: "",
  NODE_V8_COVERAGE: "",
  TZ: "UTC",
  UV_THREADPOOL_SIZE: "4",
});

const PINNED_BUILDER_FLAGS = Object.freeze([
  "--view=conus",
  "--force",
  "--profile",
  "--worker-count=1",
  "--total-frame-concurrency=1",
  "--frame-concurrency=1",
  "--model-concurrency=1",
  "--global-frame-queue=false",
  "--global-frame-concurrency=1",
  "--range-concurrency=1",
  "--total-range-concurrency=1",
  "--decode-concurrency=1",
  "--input-prefetch=0",
  "--derived-cell-concurrency=1",
  "--compress-threads=1",
  "--frame-retries=0",
  "--retry-delay-ms=2000",
  "--retry-frame-concurrency=1",
  "--global-persist-queue=false",
  "--global-persist-concurrency=2",
  "--global-persist-backlog=8",
  "--snow-persist-concurrency=2",
  "--snow-persist-backlog=8",
  "--persist-manifest-each-frame=true",
  "--artifact-write-concurrency=0",
  "--artifact-prefix=tiles",
  "--reflectivity-gates=10,15,20",
  "--run-offset=0",
  "--full-run=false",
  "--require-full-horizon=false",
  "--gfs-hourly-through-120=false",
]);

const FRAME_KINDS = Object.freeze(["complete", "base", "snow", "prefix"]);

async function main() {
  const toolStartedAt = new Date();
  const toolStartNs = process.hrtime.bigint();
  const options = normalizeBenchmarkOptions(parseCliArgs(process.argv.slice(2)));
  const sessionDir = createSessionDirectory(options);
  const {
    env,
    pins,
    policy: environmentPolicy,
  } = buildBenchmarkEnvironment(process.env, {
    sourceRoot: options.sourceRoot,
    hoverArena: options.hoverArena,
    fastPack: options.fastPack,
    colorLookups: options.colorLookups,
    snowRf: options.snowRf,
  });
  const builderArgs = buildPinnedBuilderArgs(options);
  const sourceAtStart = collectSourceProvenance(options.sourceRoot);
  const provenance = {
    capturedAt: new Date().toISOString(),
    source: sourceAtStart,
    tools: collectToolProvenance({ sourceRoot: options.sourceRoot, env }),
    system: collectSystemProvenance(),
    environment: environmentPolicy,
    builderConfig: {
      entrypoint: builderArgs[0],
      flags: resolveBuilderConfig(builderArgs),
      environment: pins,
    },
  };
  const repetitions = [];

  console.log(`[renderer-benchmark] output=${sessionDir}`);
  console.log(
    `[renderer-benchmark] fixture=${options.model} ${options.date} ${options.cycle}Z hours=${options.hours.join(",")} repetitions=${options.repetitions}`,
  );

  for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
    const rawLogPath = path.join(sessionDir, `repetition-${String(repetition).padStart(2, "0")}.log`);
    console.log(`[renderer-benchmark] repetition ${repetition}/${options.repetitions} starting`);
    const result = await runBuilderProcess({ builderArgs, env, rawLogPath, sourceRoot: options.sourceRoot });
    const rawLogBody = fs.readFileSync(rawLogPath);
    const parsed = parseRendererBenchmarkLog(rawLogBody.toString("utf8"));
    const partitioned = partitionBenchmarkReceiptSideband(result.colorLookupReceiptSideband);
    parsed.colorLookupReceipts = partitioned.colorLookup.receipts;
    parsed.snowRfReceipts = partitioned.snowRf.receipts;
    const rosterValidation = validateBenchmarkMainFrameRoster(parsed.frames, options);
    const colorLookupTreatment = validateBenchmarkColorLookupTreatment(
      partitioned.colorLookup,
      options,
      provenance.tools,
      result.processId,
    );
    const snowRfTreatment = validateBenchmarkSnowRfTreatment(
      partitioned.snowRf,
      options,
      provenance.tools,
      result.processId,
    );
    parsed.fixtureValidation = {
      ...rosterValidation,
      valid: rosterValidation.valid && colorLookupTreatment.valid && snowRfTreatment.valid,
      rosterValidation,
      colorLookupTreatment,
      snowRfTreatment,
      errors: [...rosterValidation.errors, ...colorLookupTreatment.errors, ...snowRfTreatment.errors],
    };
    repetitions.push({
      repetition,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      subprocessWallMs: result.subprocessWallMs,
      exitCode: result.exitCode,
      signal: result.signal,
      subprocessPid: result.processId,
      rawLogPath: path.relative(ROOT_DIR, rawLogPath),
      rawLogIntegrity: {
        bytes: rawLogBody.length,
        sha256: sha256Bytes(rawLogBody),
      },
      colorLookupReceiptSideband: {
        framing: result.colorLookupReceiptSideband.framing,
        bytes: result.colorLookupReceiptSideband.bytes,
        sha256: result.colorLookupReceiptSideband.sha256,
        valid: partitioned.errors.length === 0,
        errors: partitioned.errors,
      },
      parsed,
    });
    console.log(
      `[renderer-benchmark] repetition ${repetition}/${options.repetitions} exit=${result.exitCode ?? "signal"} wall=${formatMilliseconds(result.subprocessWallMs)} profiledFrames=${parsed.frames.length} fixture=${parsed.fixtureValidation.valid ? "valid" : "invalid"}`,
    );
    const rendererReportedFailure = parsed.failures.frameErrorLines > 0 || parsed.failures.reportedFailedFrames > 0;
    if (result.exitCode !== 0 || result.signal || rendererReportedFailure || !parsed.fixtureValidation.valid) {
      const reason =
        result.exitCode !== 0 || result.signal
          ? "failed renderer process"
          : rendererReportedFailure
            ? `renderer-reported frame failures (${parsed.failures.frameErrorLines} error lines, ${parsed.failures.reportedFailedFrames} summary failures)`
            : `invalid profiled fixture (${parsed.fixtureValidation.errors.join("; ")})`;
      console.error(`[renderer-benchmark] stopping after ${reason}; existing cache contents were left intact`);
      break;
    }
  }

  const finishedAt = new Date();
  const sourceAtFinish = collectSourceProvenance(options.sourceRoot);
  provenance.system.finishSnapshot = collectHostLoadSnapshot();
  provenance.source.stableDuringSession = sourceProvenanceMatches(sourceAtStart, sourceAtFinish);
  if (!provenance.source.stableDuringSession) {
    provenance.source.observedAtFinish = sourceAtFinish;
  }
  const dotEnvAtFinish = summarizeDotEnvInspection(inspectDotEnv(options.sourceRoot));
  provenance.environment.stableDuringSession =
    JSON.stringify(provenance.environment.dotEnv) === JSON.stringify(dotEnvAtFinish);
  if (!provenance.environment.stableDuringSession) {
    provenance.environment.observedAtFinish = dotEnvAtFinish;
  }
  const allFrames = repetitions.flatMap((run) =>
    run.parsed.frames.map((frame) => ({ ...frame, repetition: run.repetition })),
  );
  const summary = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    label: options.label,
    fixture: {
      model: options.model,
      view: "conus",
      date: options.date,
      cycle: options.cycle,
      hours: options.hours,
      repetitionsRequested: options.repetitions,
      repetitionsCompleted: repetitions.length,
      hoverArena: options.hoverArena,
      fastPack: options.fastPack,
      colorLookups: options.colorLookups,
      snowRf: options.snowRf,
      cacheRoot: options.cacheRoot,
      sourceRoot: options.sourceRoot,
    },
    command: {
      executable: process.execPath,
      cwd: options.sourceRoot,
      script: builderArgs[0],
      args: builderArgs.slice(1),
      environmentPins: pins,
      resolvedBuilderConfig: provenance.builderConfig.flags,
    },
    treatment: summarizeBenchmarkTreatment(repetitions, options),
    provenance,
    timing: {
      startedAt: toolStartedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      toolWallMs: durationMilliseconds(toolStartNs, process.hrtime.bigint()),
      subprocessWall: summarizeSamples(repetitions.map((run) => run.subprocessWallMs)),
    },
    failures: {
      ...summarizeRunFailures(repetitions),
      sourceChangedDuringSession: !provenance.source.stableDuringSession,
      environmentChangedDuringSession: !provenance.environment.stableDuringSession,
    },
    aggregate: summarizeFrameRecords(allFrames),
    repetitions,
  };
  const summaryPath = path.join(sessionDir, "summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  console.log(`[renderer-benchmark] summary=${summaryPath}`);

  if (
    summary.failures.processFailures > 0 ||
    summary.failures.fixtureValidationFailures > 0 ||
    summary.failures.frameErrorLines > 0 ||
    summary.failures.reportedFailedFrames > 0 ||
    summary.failures.sourceChangedDuringSession ||
    summary.failures.environmentChangedDuringSession
  ) {
    process.exitCode = 1;
  }
}

function parseCliArgs(argv) {
  const known = new Set([
    "label",
    "cache-root",
    "source-root",
    "output-root",
    "model",
    "date",
    "cycle",
    "hours",
    "repetitions",
    "hover-arena",
    "fast-pack",
    "color-lookups",
    "snow-rf",
  ]);
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (token === "--help" || token === "-h") {
      printUsage();
      process.exit(0);
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument '${token}'.`);
    }
    const equalsAt = token.indexOf("=");
    const name = token.slice(2, equalsAt >= 0 ? equalsAt : undefined);
    if (!known.has(name)) {
      throw new Error(`Unknown benchmark option '--${name}'.`);
    }
    let value;
    if (equalsAt >= 0) {
      value = token.slice(equalsAt + 1);
    } else {
      value = argv[index + 1];
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error(`--${name} requires a value.`);
      }
      index += 1;
    }
    if (Object.hasOwn(out, name)) {
      throw new Error(`--${name} may only be supplied once.`);
    }
    out[name] = value;
  }
  return out;
}

function normalizeBenchmarkOptions(raw, rootDir = ROOT_DIR) {
  const label = requiredString(raw.label, "--label");
  const cacheRootInput = requiredString(raw["cache-root"], "--cache-root");
  const model = normalizeNoaaModelKey(requiredString(raw.model, "--model"));
  const date = normalizeDate(requiredString(raw.date, "--date"));
  const cycle = normalizeCycle(requiredString(raw.cycle, "--cycle"), model);
  const hours = parseHours(requiredString(raw.hours, "--hours"), "--hours");
  validateHoursForModel(hours, model);
  const repetitions = Number(requiredString(raw.repetitions, "--repetitions"));
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 50) {
    throw new Error("--repetitions must be an integer from 1 through 50.");
  }
  const hoverArena = normalizeHoverArenaOption(raw["hover-arena"]);
  const fastPack = normalizeFastPackOption(raw["fast-pack"]);
  const colorLookups = normalizeColorLookupsOption(raw["color-lookups"]);
  const snowRf = normalizeSnowRfOption(raw["snow-rf"]);
  const cacheRoot = path.resolve(rootDir, cacheRootInput);
  const sourceRootInput =
    raw["source-root"] === undefined ? rootDir : requiredString(raw["source-root"], "--source-root");
  const sourceRoot = path.resolve(rootDir, sourceRootInput);
  const outputRootInput =
    raw["output-root"] === undefined ? BENCHMARK_OUTPUT_ROOT : requiredString(raw["output-root"], "--output-root");
  const outputRoot = path.resolve(rootDir, outputRootInput);
  const builderScript = path.join(sourceRoot, "scripts/build-noaa-beta-artifacts.js");
  if (!isDirectory(sourceRoot) || !isFile(path.join(sourceRoot, "package.json")) || !isFile(builderScript)) {
    throw new Error(
      `--source-root must be a repository tree containing package.json and scripts/build-noaa-beta-artifacts.js; got '${sourceRoot}'.`,
    );
  }
  if (cacheRoot === path.parse(cacheRoot).root || cacheRoot === rootDir || cacheRoot === sourceRoot) {
    throw new Error("--cache-root must name a dedicated cache directory, not a filesystem or repository root.");
  }
  if (fs.existsSync(cacheRoot) && !isDirectory(cacheRoot)) {
    throw new Error(`--cache-root must be a directory path; '${cacheRoot}' is not a directory.`);
  }
  if (
    outputRoot === path.parse(outputRoot).root ||
    outputRoot === rootDir ||
    outputRoot === sourceRoot ||
    outputRoot === cacheRoot
  ) {
    throw new Error("--output-root must name a dedicated benchmark directory.");
  }
  if (fs.existsSync(outputRoot) && !isDirectory(outputRoot)) {
    throw new Error(`--output-root must be a directory path; '${outputRoot}' is not a directory.`);
  }
  return {
    label,
    labelSlug: slugify(label),
    cacheRoot,
    sourceRoot,
    outputRoot,
    model,
    date,
    cycle,
    hours,
    repetitions,
    hoverArena,
    fastPack,
    colorLookups,
    snowRf,
  };
}

function buildPinnedBuilderArgs(options) {
  return [
    path.join(options.sourceRoot, "scripts/build-noaa-beta-artifacts.js"),
    `--models=${options.model}`,
    `--date=${options.date}`,
    `--cycle=${options.cycle}`,
    `--hours-${options.model}=${options.hours.join(",")}`,
    `--cache-root=${options.cacheRoot}`,
    ...PINNED_BUILDER_FLAGS,
  ];
}

function buildBenchmarkEnvironment(
  sourceEnv,
  {
    sourceRoot = null,
    hoverArena = PINNED_ENV_DEFAULTS.MODELVIEW_NOAA_HOVER_ARENA,
    fastPack = PINNED_ENV_DEFAULTS.MODELVIEW_NOAA_FAST_PACK,
    colorLookups = PINNED_ENV_DEFAULTS.MODELVIEW_NOAA_COLOR_LOOKUPS,
    snowRf = PINNED_ENV_DEFAULTS.MODELVIEW_NOAA_SNOW_RF_ASSET,
  } = {},
) {
  sourceEnv = sourceEnv || {};
  const env = { ...sourceEnv };
  const pins = {};
  const hoverArenaPin = normalizeHoverArenaOption(hoverArena);
  const fastPackPin = normalizeFastPackOption(fastPack);
  const colorLookupsPin = normalizeColorLookupsOption(colorLookups);
  const snowRfPin = normalizeSnowRfOption(snowRf);
  const dotEnv = inspectDotEnv(sourceRoot);
  const rendererNames = new Set(KNOWN_RENDERER_ENV_INPUTS);
  for (const name of Object.keys(sourceEnv || {})) {
    if (isRendererEnvironmentName(name)) {
      rendererNames.add(name);
    }
  }
  for (const name of dotEnv.rendererKeys) {
    rendererNames.add(name);
  }

  for (const name of Array.from(rendererNames).sort()) {
    const isHoverArena = name === "MODELVIEW_NOAA_HOVER_ARENA";
    const isFastPack = name === "MODELVIEW_NOAA_FAST_PACK";
    const isColorLookups = name === "MODELVIEW_NOAA_COLOR_LOOKUPS";
    const isSnowRf = name === "MODELVIEW_NOAA_SNOW_RF_ASSET";
    const value = isHoverArena
      ? hoverArenaPin
      : isFastPack
        ? fastPackPin
        : isColorLookups
          ? colorLookupsPin
          : isSnowRf
            ? snowRfPin
            : Object.hasOwn(PINNED_ENV_DEFAULTS, name)
              ? PINNED_ENV_DEFAULTS[name]
              : "";
    env[name] = value;
    pins[name] = {
      value,
      source:
        isHoverArena || isFastPack || isColorLookups || isSnowRf
          ? "harness-option-pin"
          : Object.hasOwn(PINNED_ENV_DEFAULTS, name)
            ? "harness-pin"
            : "harness-sanitized-default",
    };
  }
  for (const [name, value] of Object.entries(PINNED_PROCESS_ENV_DEFAULTS)) {
    env[name] = value;
    pins[name] = { value, source: "harness-process-pin" };
  }

  // WGRIB2 is the only supported inherited renderer tool input. It remains
  // useful for fixtures that deliberately compare a non-default binary, and
  // it is represented by configured path, resolved path, and content hash in
  // the summary. An absent shell value becomes an explicit empty variable so
  // a source tree's .env cannot choose the tool invisibly.
  const inheritedWgrib2 = Object.hasOwn(sourceEnv, "WGRIB2") && sourceEnv.WGRIB2 != null;
  env.WGRIB2 = inheritedWgrib2 ? String(sourceEnv.WGRIB2) : "";
  pins.WGRIB2 = inheritedWgrib2
    ? { value: env.WGRIB2, source: "inherited-explicit" }
    : { value: null, source: "builder-discovery" };

  const inheritedRendererKeys = Object.keys(sourceEnv || {})
    .filter((name) => isRendererEnvironmentName(name))
    .sort();
  return {
    env,
    pins: Object.fromEntries(Object.entries(pins).sort(([left], [right]) => left.localeCompare(right))),
    policy: {
      name: "renderer-isolated-v1",
      inheritedAllowlist: ["WGRIB2"],
      callerRendererKeysSanitized: inheritedRendererKeys,
      dotEnv: {
        exists: dotEnv.exists,
        sha256: dotEnv.sha256,
        rendererKeysBlocked: dotEnv.rendererKeys,
        wgrib2Blocked: dotEnv.wgrib2Blocked,
      },
      processPins: Object.keys(PINNED_PROCESS_ENV_DEFAULTS).sort(),
    },
  };
}

function summarizeDotEnvInspection(dotEnv) {
  return {
    exists: Boolean(dotEnv?.exists),
    sha256: dotEnv?.sha256 ?? null,
    rendererKeysBlocked: Array.isArray(dotEnv?.rendererKeys) ? dotEnv.rendererKeys : [],
    wgrib2Blocked: Boolean(dotEnv?.wgrib2Blocked),
  };
}

function isRendererEnvironmentName(name) {
  return String(name || "").startsWith("MODELVIEW_");
}

function normalizeHoverArenaOption(value) {
  const normalized =
    value === undefined ? PINNED_ENV_DEFAULTS.MODELVIEW_NOAA_HOVER_ARENA : String(value).trim().toLowerCase();
  if (normalized === "auto" || normalized === "off") {
    return normalized;
  }
  throw new Error(`--hover-arena must be 'auto' or 'off'; received ${JSON.stringify(value)}.`);
}

function normalizeFastPackOption(value) {
  const normalized =
    value === undefined ? PINNED_ENV_DEFAULTS.MODELVIEW_NOAA_FAST_PACK : String(value).trim().toLowerCase();
  if (normalized === "auto" || normalized === "off") {
    return normalized;
  }
  throw new Error(`--fast-pack must be 'auto' or 'off'; received ${JSON.stringify(value)}.`);
}

function normalizeColorLookupsOption(value) {
  const normalized =
    value === undefined ? PINNED_ENV_DEFAULTS.MODELVIEW_NOAA_COLOR_LOOKUPS : String(value).trim().toLowerCase();
  if (normalized === "auto" || normalized === "dynamic" || normalized === "precompiled") {
    return normalized;
  }
  throw new Error(`--color-lookups must be 'auto', 'dynamic', or 'precompiled'; received ${JSON.stringify(value)}.`);
}

function normalizeSnowRfOption(value) {
  const normalized =
    value === undefined ? PINNED_ENV_DEFAULTS.MODELVIEW_NOAA_SNOW_RF_ASSET : String(value).trim().toLowerCase();
  if (normalized === "auto" || normalized === "off" || normalized === "required") {
    return normalized;
  }
  throw new Error(`--snow-rf must be 'auto', 'off', or 'required'; received ${JSON.stringify(value)}.`);
}

function inspectDotEnv(sourceRoot) {
  const filePath = sourceRoot ? path.join(sourceRoot, ".env") : null;
  if (!filePath || !isFile(filePath)) {
    return { exists: false, sha256: null, rendererKeys: [], wgrib2Blocked: false };
  }
  const body = fs.readFileSync(filePath);
  const keys = new Set();
  for (const rawLine of body.toString("utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsAt = line.indexOf("=");
    if (equalsAt > 0) {
      keys.add(line.slice(0, equalsAt).trim());
    }
  }
  return {
    exists: true,
    sha256: sha256Bytes(body),
    rendererKeys: Array.from(keys).filter(isRendererEnvironmentName).sort(),
    wgrib2Blocked: keys.has("WGRIB2"),
  };
}

function resolveBuilderConfig(builderArgs) {
  const config = {};
  for (const rawArg of builderArgs.slice(1)) {
    const arg = String(rawArg || "");
    if (!arg.startsWith("--")) {
      continue;
    }
    const equalsAt = arg.indexOf("=");
    const name = arg.slice(2, equalsAt >= 0 ? equalsAt : undefined);
    const value = equalsAt >= 0 ? arg.slice(equalsAt + 1) : true;
    if (!Object.hasOwn(config, name)) {
      config[name] = value;
    } else if (Array.isArray(config[name])) {
      config[name].push(value);
    } else {
      config[name] = [config[name], value];
    }
  }
  return Object.fromEntries(Object.entries(config).sort(([left], [right]) => left.localeCompare(right)));
}

function collectSourceProvenance(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const tree = fingerprintSourceTree(root);
  const git = collectGitProvenance(root, tree);
  return {
    root,
    fingerprintScope: SOURCE_FINGERPRINT_ENTRIES,
    tree,
    git,
    diffFingerprintSha256: git.diffFingerprintSha256,
  };
}

function fingerprintSourceTree(sourceRoot) {
  const hash = crypto.createHash("sha256");
  let fileCount = 0;
  let symlinkCount = 0;
  let totalBytes = 0;

  const visit = (absolutePath, relativePath) => {
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        hash.update(`missing\0${relativePath}\0`);
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolutePath);
      throw new Error(
        `Benchmark source fingerprint rejects scoped symlink '${relativePath}' -> '${target}'; ` +
          "use a self-contained source tree so provenance hashes the bytes the renderer executes.",
      );
    }
    if (stat.isDirectory()) {
      hash.update(`directory\0${relativePath}\0`);
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, name), path.posix.join(relativePath, name));
      }
      return;
    }
    if (!stat.isFile()) {
      hash.update(`other\0${relativePath}\0${stat.mode & 0o777}\0`);
      return;
    }
    hash.update(`file\0${relativePath}\0${stat.mode & 0o777}\0${stat.size}\0`);
    updateHashFromFile(hash, absolutePath);
    hash.update("\0");
    fileCount += 1;
    totalBytes += stat.size;
  };

  for (const entry of SOURCE_FINGERPRINT_ENTRIES) {
    visit(path.join(sourceRoot, entry), entry);
  }
  return {
    algorithm: "sha256",
    sha256: hash.digest("hex"),
    fileCount,
    symlinkCount,
    totalBytes,
  };
}

function collectGitProvenance(sourceRoot, tree) {
  const topLevel = runGit(sourceRoot, ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (!topLevel.ok || !sameRealPath(topLevel.stdout.trim(), sourceRoot)) {
    return {
      available: false,
      commit: null,
      dirty: null,
      statusEntryCount: null,
      statusSha256: null,
      trackedDiffSha256: null,
      diffFingerprintSha256: sha256Parts(["renderer-tree-fallback-v1", tree.sha256]),
    };
  }
  const commitResult = runGit(sourceRoot, ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  const scopedArgs = ["--", ...SOURCE_FINGERPRINT_ENTRIES];
  const statusResult = runGit(sourceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...scopedArgs], {
    encoding: null,
  });
  const diffResult = runGit(sourceRoot, ["diff", "--binary", "--no-ext-diff", "HEAD", ...scopedArgs], {
    encoding: null,
  });
  if (!commitResult.ok || !statusResult.ok || !diffResult.ok) {
    return {
      available: true,
      commit: commitResult.ok ? commitResult.stdout.trim() : null,
      dirty: null,
      statusEntryCount: null,
      statusSha256: null,
      trackedDiffSha256: null,
      diffFingerprintSha256: sha256Parts(["renderer-tree-git-degraded-v1", tree.sha256]),
    };
  }
  const status = statusResult.stdout;
  const trackedDiff = diffResult.stdout;
  const commit = commitResult.stdout.trim();
  const statusEntryCount = status.length === 0 ? 0 : status.toString("utf8").split("\0").filter(Boolean).length;
  return {
    available: true,
    commit,
    dirty: status.length > 0,
    statusEntryCount,
    statusSha256: sha256Bytes(status),
    trackedDiffSha256: sha256Bytes(trackedDiff),
    diffFingerprintSha256: sha256Parts([
      "renderer-git-diff-v1",
      commit,
      tree.sha256,
      sha256Bytes(status),
      sha256Bytes(trackedDiff),
    ]),
  };
}

function runGit(sourceRoot, args, { encoding = "utf8" } = {}) {
  const result = spawnSync("git", ["-C", sourceRoot, ...args], {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout || (encoding ? "" : Buffer.alloc(0)),
  };
}

function sameRealPath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function sourceProvenanceMatches(left, right) {
  return (
    left?.tree?.sha256 === right?.tree?.sha256 &&
    left?.git?.commit === right?.git?.commit &&
    left?.diffFingerprintSha256 === right?.diffFingerprintSha256
  );
}

function collectToolProvenance({ sourceRoot, env }) {
  const sourceTool = (relativePath) => describeFile(path.join(sourceRoot, relativePath), relativePath);
  const libdeflateEntry = resolveModuleFromSource("libdeflate", sourceRoot);
  const libdeflateWasm = libdeflateEntry ? path.join(path.dirname(libdeflateEntry), "dist/libdeflate.wasm.mjs") : null;
  const configuredWgrib2 = resolveConfiguredWgrib2(sourceRoot, env);
  return {
    benchmarkHarness: describeFile(__filename, __filename),
    nodeExecutable: describeFile(process.execPath, process.execPath),
    builderEntrypoint: sourceTool("scripts/build-noaa-beta-artifacts.js"),
    frameWorker: sourceTool("scripts/noaa-beta-frame-worker.js"),
    derivedWorker: sourceTool("scripts/noaa-beta-derived-worker.js"),
    compressionWorker: sourceTool("scripts/noaa-beta-compress-worker.js"),
    colorLookupCompiler: sourceTool("scripts/lib/noaa-beta/color-lookup-compiler.js"),
    colorLookupCompilerDependency: sourceTool("scripts/lib/noaa-beta/util.js"),
    colorLookupAssetLoader: sourceTool("scripts/lib/noaa-beta/catalog-color-lookup-asset.js"),
    colorLookupManifest: sourceTool("scripts/lib/noaa-beta/generated/catalog-color-lookups-v1.json"),
    colorLookupBinary: sourceTool("scripts/lib/noaa-beta/generated/catalog-color-lookups-v1.bin"),
    colorLookupAssetBinding: collectColorLookupAssetBinding(sourceRoot),
    snowRfCompiler: sourceTool("scripts/lib/noaa-beta/snow-rf-compiler.js"),
    snowRfAssetLoader: sourceTool("scripts/lib/noaa-beta/snow-rf-asset.js"),
    snowRfManifest: sourceTool("scripts/lib/noaa-beta/generated/snow-rf-conus-v1.json"),
    snowRfBinary: sourceTool("scripts/lib/noaa-beta/generated/snow-rf-conus-v1.bin"),
    snowRfAssetBinding: collectSnowRfAssetBinding(sourceRoot),
    parcelKernelWasm: sourceTool("tools/parcel-kernel/build/parcel-kernel.wasm"),
    libdeflateEntrypoint: describeFile(libdeflateEntry, libdeflateEntry),
    libdeflateWasmModule: describeFile(libdeflateWasm, libdeflateWasm),
    wgrib2: {
      configured: configuredWgrib2.configured,
      ...describeFile(configuredWgrib2.resolvedPath, configuredWgrib2.resolvedPath),
    },
  };
}

function collectColorLookupAssetBinding(sourceRoot) {
  const manifestPath = path.join(sourceRoot, "scripts/lib/noaa-beta/generated/catalog-color-lookups-v1.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return {
      schemaVersion: manifest.schemaVersion ?? null,
      compiler: manifest.compiler ?? null,
      input: manifest.input ?? null,
      assignmentMapping: manifest.assignmentMapping ?? null,
      computedAssignmentMappingSha256: computeColorLookupAssignmentMappingSha256(
        manifest.assignments,
        manifest.schemaVersion,
      ),
      binary: manifest.binary ?? null,
      paletteCount: manifest.paletteCount ?? null,
      logicalColorBytes: Array.isArray(manifest.assignments)
        ? manifest.assignments.reduce(
            (sum, assignment) =>
              Number.isSafeInteger(assignment?.byteLength) && assignment.byteLength > 0
                ? sum + assignment.byteLength
                : NaN,
            0,
          )
        : null,
    };
  } catch (error) {
    return {
      schemaVersion: null,
      error: String(error?.code || error?.message || error),
    };
  }
}

function collectSnowRfAssetBinding(sourceRoot) {
  const manifestPath = path.join(sourceRoot, "scripts/lib/noaa-beta/generated/snow-rf-conus-v1.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return {
      schemaVersion: manifest.schemaVersion ?? null,
      format: manifest.format ?? null,
      endian: manifest.endian ?? null,
      source: manifest.source ?? null,
      compiler: manifest.compiler ?? null,
      model: manifest.model ?? null,
      layout: isPlainObject(manifest.layout)
        ? {
            alignmentBytes: manifest.layout.alignmentBytes ?? null,
            regionCount: manifest.layout.regionCount ?? null,
            payloadBytes: manifest.layout.payloadBytes ?? null,
            paddingBytes: manifest.layout.paddingBytes ?? null,
            binaryBytes: manifest.layout.binaryBytes ?? null,
          }
        : null,
      binary: manifest.binary ?? null,
    };
  } catch (error) {
    return {
      schemaVersion: null,
      error: String(error?.code || error?.message || error),
    };
  }
}

function computeColorLookupAssignmentMappingSha256(assignments, schemaVersion) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return null;
  }
  const rows = assignments
    .map((assignment) => ({
      id: assignment?.id,
      paletteSha256: assignment?.paletteSha256,
      byteLength: assignment?.byteLength,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (
    !Number.isSafeInteger(schemaVersion) ||
    rows.some(
      (row, index) =>
        typeof row.id !== "string" ||
        row.id.length === 0 ||
        row.id.includes("\0") ||
        !isSha256(row.paletteSha256) ||
        !Number.isSafeInteger(row.byteLength) ||
        row.byteLength <= 0 ||
        (index > 0 && rows[index - 1].id === row.id),
    )
  ) {
    return null;
  }
  const hash = crypto.createHash("sha256");
  hash.update(`${COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING}\0${schemaVersion}\0${rows.length}\0`);
  for (const row of rows) {
    hash.update(`${row.id}\0${row.paletteSha256}\0${row.byteLength}\0`);
  }
  return hash.digest("hex");
}

function resolveModuleFromSource(moduleName, sourceRoot) {
  try {
    return require.resolve(moduleName, { paths: [sourceRoot] });
  } catch {
    return null;
  }
}

function resolveConfiguredWgrib2(sourceRoot, env) {
  const inherited = String(env?.WGRIB2 || "").trim();
  const localTool = path.join(sourceRoot, "output/noaa-beta-tools/bin/wgrib2");
  const configured = inherited || (isFile(localTool) ? localTool : "wgrib2");
  return {
    configured,
    resolvedPath: resolveExecutable(configured, env?.PATH, sourceRoot),
  };
}

function resolveExecutable(configured, pathValue, cwd) {
  const value = String(configured || "").trim();
  if (!value) {
    return null;
  }
  if (path.isAbsolute(value) || value.includes(path.sep)) {
    const candidate = path.resolve(cwd, value);
    return isExecutableFile(candidate) ? candidate : null;
  }
  for (const directory of String(pathValue || "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, value);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function describeFile(filePath, displayPath = filePath) {
  if (!filePath) {
    return { available: false, path: displayPath || null, realPath: null, bytes: null, sha256: null };
  }
  try {
    const realPath = fs.realpathSync(filePath);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      throw new Error("not a file");
    }
    return {
      available: true,
      path: displayPath,
      realPath,
      bytes: stat.size,
      sha256: sha256File(realPath),
    };
  } catch {
    return { available: false, path: displayPath || null, realPath: null, bytes: null, sha256: null };
  }
}

function collectSystemProvenance() {
  const cpus = os.cpus() || [];
  const models = new Map();
  for (const cpu of cpus) {
    const model = String(cpu?.model || "unknown").trim() || "unknown";
    models.set(model, (models.get(model) || 0) + 1);
  }
  const speeds = cpus
    .map((cpu) => Number(cpu?.speed))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return {
    node: {
      version: process.version,
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      versions: Object.fromEntries(
        Object.entries(process.versions).sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
    os: {
      platform: os.platform(),
      release: os.release(),
      version: typeof os.version === "function" ? os.version() : null,
      arch: os.arch(),
      endianness: os.endianness(),
    },
    cpu: {
      logicalCount: cpus.length,
      availableParallelism: typeof os.availableParallelism === "function" ? os.availableParallelism() : cpus.length,
      models: Array.from(models, ([model, count]) => ({ model, count })).sort((left, right) =>
        left.model.localeCompare(right.model),
      ),
      speedMhz:
        speeds.length > 0
          ? { min: speeds[0], median: medianSorted(speeds), max: speeds[speeds.length - 1] }
          : { min: null, median: null, max: null },
    },
    memory: {
      totalBytes: os.totalmem(),
      freeBytesAtStart: os.freemem(),
    },
    startSnapshot: collectHostLoadSnapshot(),
  };
}

function collectHostLoadSnapshot() {
  return {
    capturedAt: new Date().toISOString(),
    freeBytes: os.freemem(),
    loadAverage: safeSystemMetric(() => os.loadavg()),
    uptimeSeconds: safeSystemMetric(() => os.uptime()),
  };
}

function safeSystemMetric(readMetric) {
  try {
    return readMetric();
  } catch {
    return null;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  updateHashFromFile(hash, filePath);
  return hash.digest("hex");
}

function updateHashFromFile(hash, filePath) {
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Parts(parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    const body = Buffer.from(String(part));
    hash.update(String(body.length));
    hash.update("\0");
    hash.update(body);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function runBuilderProcess({ builderArgs, env, rawLogPath, sourceRoot }) {
  const startedAt = new Date();
  const startNs = process.hrtime.bigint();
  const rawLog = fs.createWriteStream(rawLogPath, { flags: "wx" });
  const sidebandChunks = [];
  let sidebandBytes = 0;
  let sidebandOverflow = false;
  const child = spawn(process.execPath, builderArgs, {
    cwd: sourceRoot,
    env,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const processId = child.pid;

  child.stdout.on("data", (chunk) => {
    rawLog.write(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    rawLog.write(chunk);
    process.stderr.write(chunk);
  });
  child.stdio[3].on("data", (chunk) => {
    sidebandBytes += chunk.byteLength;
    if (sidebandBytes <= MAX_BENCHMARK_SIDEBAND_BYTES) {
      sidebandChunks.push(chunk);
    } else {
      sidebandOverflow = true;
    }
  });

  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  rawLog.end();
  await finished(rawLog);
  const finishedAt = new Date();
  const colorLookupReceiptSideband = parseBenchmarkReceiptSideband(Buffer.concat(sidebandChunks), {
    overflow: sidebandOverflow,
    observedBytes: sidebandBytes,
  });
  return {
    ...result,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    subprocessWallMs: durationMilliseconds(startNs, process.hrtime.bigint()),
    processId,
    colorLookupReceiptSideband,
  };
}

function parseBenchmarkReceiptSideband(input, { overflow = false, observedBytes = null } = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const receipts = [];
  const errors = [];
  let offset = 0;
  if (overflow) {
    errors.push(`receipt sideband exceeded ${MAX_BENCHMARK_SIDEBAND_BYTES} bytes`);
  }
  while (offset < buffer.byteLength) {
    const frameOffset = offset;
    if (buffer.byteLength - offset < BENCHMARK_RECEIPT_MAGIC.byteLength + 4) {
      errors.push(`truncated receipt header at byte ${offset}`);
      break;
    }
    if (!buffer.subarray(offset, offset + BENCHMARK_RECEIPT_MAGIC.byteLength).equals(BENCHMARK_RECEIPT_MAGIC)) {
      errors.push(`invalid receipt magic at byte ${offset}`);
      break;
    }
    offset += BENCHMARK_RECEIPT_MAGIC.byteLength;
    const bodyByteLength = buffer.readUInt32BE(offset);
    offset += 4;
    if (bodyByteLength <= 0 || bodyByteLength > MAX_BENCHMARK_RECEIPT_BYTES) {
      errors.push(`invalid receipt length ${bodyByteLength} at byte ${frameOffset}`);
      break;
    }
    if (buffer.byteLength - offset < bodyByteLength) {
      errors.push(`truncated receipt body at byte ${frameOffset}`);
      break;
    }
    const body = buffer.subarray(offset, offset + bodyByteLength);
    offset += bodyByteLength;
    try {
      const receipt = JSON.parse(body.toString("utf8"));
      receipts.push({
        bodyBytes: body.byteLength,
        bodySha256: sha256Bytes(body),
        receipt,
      });
    } catch (error) {
      errors.push(`invalid receipt JSON at byte ${frameOffset}: ${error.message}`);
    }
  }
  return {
    framing: "MVBR-u32be-json-v1",
    bytes: observedBytes ?? buffer.byteLength,
    sha256: overflow ? null : sha256Bytes(buffer),
    receipts,
    errors,
  };
}

function partitionBenchmarkReceiptSideband(sideband) {
  const errors = [...(sideband?.errors || [])];
  const records = Array.isArray(sideband?.receipts) ? sideband.receipts : [];
  const colorLookupRecords = [];
  const snowRfRecords = [];
  for (const [index, record] of records.entries()) {
    const type = record?.receipt?.type;
    if (type === BENCHMARK_RECEIPT_TYPE) {
      colorLookupRecords.push(record);
    } else if (type === SNOW_RF_RECEIPT_TYPE) {
      snowRfRecords.push(record);
    } else {
      errors.push(`receipt ${index + 1} has an unknown type ${JSON.stringify(type ?? null)}`);
    }
  }
  const partitionView = (receipts) => ({
    framing: sideband?.framing ?? null,
    bytes: sideband?.bytes ?? null,
    sha256: sideband?.sha256 ?? null,
    receipts,
    errors,
  });
  return {
    colorLookup: partitionView(colorLookupRecords),
    snowRf: partitionView(snowRfRecords),
    errors,
  };
}

function parseRendererBenchmarkLog(input) {
  const frames = [];
  const lines = String(input || "").split(/\r?\n/);
  let frameErrorLines = 0;
  for (const line of lines) {
    if (/^\[noaa-beta\].*\sF\d{3}(?:\s+[a-z0-9-]+)?\s+error\s+finish=/.test(line)) {
      frameErrorLines += 1;
    }
    const frame = parseProfileFrameLine(line);
    if (frame) {
      frames.push(frame);
    }
  }
  const reportedFailedFrames = Array.from(String(input || "").matchAll(/"failed"\s*:\s*(\d+)/g)).reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
  return {
    frames,
    failures: { frameErrorLines, reportedFailedFrames },
    summary: summarizeFrameRecords(frames),
  };
}

function parseProfileFrameLine(line) {
  const profileAt = line.indexOf(" profile ");
  if (profileAt < 0) {
    return null;
  }
  const prefix = line.slice(0, profileAt);
  const profileText = line.slice(profileAt + " profile ".length);
  const match = prefix.match(
    /^\[noaa-beta\]\s+([^/\s]+)\/([^\s]+)\s+F(\d{3})(?:\s+([a-z0-9-]+))?\s+(complete|partial)\s+finish=/,
  );
  if (!match) {
    return null;
  }
  const model = match[1];
  const run = match[2];
  const hour = Number(match[3]);
  const renderPart = match[4] || "all";
  const status = match[5];
  const elapsedMatch = prefix.match(/\selapsed=([^\s]+)/);
  const { stagesMs, counters } = parseProfileFields(profileText);
  return {
    model,
    run,
    hour,
    renderPart,
    status,
    frameKind: classifyFrameKind(renderPart, status),
    elapsedMs: elapsedMatch ? parseDurationMilliseconds(elapsedMatch[1]) : null,
    stagesMs,
    counters,
  };
}

function classifyFrameKind(renderPart, status) {
  if (renderPart === "all") {
    return status === "complete" ? "complete" : "other";
  }
  if (renderPart === "base") {
    return "base";
  }
  if (renderPart === "snow") {
    return "snow";
  }
  if (renderPart.endsWith("-prefix")) {
    return "prefix";
  }
  return "other";
}

function parseProfileFields(profileText) {
  const stagesMs = {};
  const counters = {};
  const tokens = String(profileText || "")
    .trim()
    .split(/\s+/);
  for (const token of tokens) {
    const match = token.match(/^([A-Za-z][A-Za-z0-9]*)=(.+)$/);
    if (!match) {
      continue;
    }
    const [, name, rawValue] = match;
    if (name === "hoverArenaFallbackReason") {
      counters[name] = { type: "string", value: decodeProfileStringCounter(rawValue) };
      continue;
    }
    const stage = rawValue.match(/^(\d+(?:\.\d+)?)ms$/);
    if (stage) {
      stagesMs[name] = Number(stage[1]);
      continue;
    }
    const ratio = rawValue.match(/^(\d+)\/(\d+)$/);
    if (ratio) {
      counters[name] = { type: "ratio", hits: Number(ratio[1]), total: Number(ratio[2]) };
      continue;
    }
    if (/^\d+(?:\.\d+)?$/.test(rawValue)) {
      counters[name] = { type: "number", value: Number(rawValue) };
      continue;
    }
    if (rawValue === "cache") {
      counters[name] = { type: "cache", value: true };
    }
  }
  return { stagesMs, counters };
}

function decodeProfileStringCounter(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function summarizeFrameRecords(frames) {
  const byFrameKind = {};
  for (const kind of FRAME_KINDS) {
    byFrameKind[kind] = summarizeFrameGroup(frames.filter((frame) => frame.frameKind === kind));
  }
  const otherFrames = frames.filter((frame) => !FRAME_KINDS.includes(frame.frameKind));
  if (otherFrames.length > 0) {
    byFrameKind.other = summarizeFrameGroup(otherFrames);
  }
  return {
    frameCount: frames.length,
    frameCounts: Object.fromEntries(Object.entries(byFrameKind).map(([kind, value]) => [kind, value.frameCount])),
    all: summarizeFrameGroup(frames),
    main: summarizeFrameGroup(frames.filter((frame) => frame.frameKind === "complete" || frame.frameKind === "base")),
    byFrameKind,
    cacheCounters: summarizeCacheCounters(frames),
  };
}

function summarizeFrameGroup(frames) {
  const stageSamples = new Map();
  for (const frame of frames) {
    for (const [name, value] of Object.entries(frame.stagesMs || {})) {
      if (!stageSamples.has(name)) {
        stageSamples.set(name, []);
      }
      stageSamples.get(name).push(value);
    }
  }
  return {
    frameCount: frames.length,
    elapsed: summarizeSamples(frames.map((frame) => frame.elapsedMs).filter(Number.isFinite)),
    stages: Object.fromEntries(
      Array.from(stageSamples.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, samples]) => [name, summarizeSamples(samples)]),
    ),
  };
}

function summarizeCacheCounters(frames) {
  const out = {};
  for (const frame of frames) {
    for (const [name, counter] of Object.entries(frame.counters || {})) {
      if (!isCacheCounter(name, counter)) {
        continue;
      }
      const entry = out[name] || { type: counter.type, samples: [] };
      if (counter.type === "ratio") {
        entry.samples.push({ hits: counter.hits, total: counter.total });
        entry.hits = (entry.hits || 0) + counter.hits;
        entry.total = (entry.total || 0) + counter.total;
        entry.hitRate = entry.total > 0 ? entry.hits / entry.total : null;
      } else if (counter.type === "number") {
        entry.samples.push(counter.value);
        entry.sum = (entry.sum || 0) + counter.value;
      } else if (counter.type === "cache") {
        entry.samples.push(true);
        entry.cacheHits = (entry.cacheHits || 0) + 1;
      }
      entry.n = entry.samples.length;
      out[name] = entry;
    }
  }
  return out;
}

function isCacheCounter(name, counter) {
  return (
    counter?.type === "cache" ||
    /cache|fastPack|hashBypass|verifyHash|regridBin|regridFields|regridBytes|regridSparse|derivedGrids|recordGridHits|RegistryHits/i.test(
      String(name || ""),
    )
  );
}

function summarizeSamples(values) {
  const samplesMs = values.map(Number).filter(Number.isFinite);
  if (samplesMs.length === 0) {
    return { n: 0, samplesMs: [], sumMs: 0, medianMs: null, madMs: null, p95Ms: null };
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const medianMs = medianSorted(sorted);
  const deviations = sorted.map((value) => Math.abs(value - medianMs)).sort((left, right) => left - right);
  return {
    n: samplesMs.length,
    samplesMs,
    sumMs: samplesMs.reduce((sum, value) => sum + value, 0),
    medianMs,
    madMs: medianSorted(deviations),
    // Nearest-rank p95 keeps observed samples intact and is predictable for
    // the intentionally small (usually 3-5) benchmark repetition counts.
    p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

function medianSorted(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeRunFailures(repetitions) {
  return {
    processFailures: repetitions.filter((run) => run.exitCode !== 0 || run.signal).length,
    fixtureValidationFailures: repetitions.filter((run) => run.parsed?.fixtureValidation?.valid === false).length,
    frameErrorLines: repetitions.reduce((sum, run) => sum + run.parsed.failures.frameErrorLines, 0),
    reportedFailedFrames: repetitions.reduce((sum, run) => sum + run.parsed.failures.reportedFailedFrames, 0),
  };
}

function validateBenchmarkColorLookupTreatment(sideband, options, tools, expectedProcessId = null) {
  const errors = [...(sideband?.errors || [])];
  const records = Array.isArray(sideband?.receipts) ? sideband.receipts : [];
  const expectedRequestedMode = String(options?.colorLookups || "");
  const expectedEffectiveMode = expectedRequestedMode === "dynamic" ? "dynamic" : "precompiled";
  const binding = tools?.colorLookupAssetBinding;
  const compilerTool = tools?.colorLookupCompiler;
  const compilerDependencyTool = tools?.colorLookupCompilerDependency;
  const assetLoaderTool = tools?.colorLookupAssetLoader;
  const binaryTool = tools?.colorLookupBinary;
  const manifestTool = tools?.colorLookupManifest;

  if (!isPlainObject(binding) || binding.error) {
    errors.push("color lookup manifest provenance is unavailable");
  }
  if (!manifestTool?.available || !isSha256(manifestTool.sha256)) {
    errors.push("color lookup manifest file hash is unavailable");
  }
  if (!binaryTool?.available || !isSha256(binaryTool.sha256)) {
    errors.push("color lookup binary file hash is unavailable");
  }
  if (!compilerTool?.available || !isSha256(compilerTool.sha256)) {
    errors.push("color lookup compiler file hash is unavailable");
  }
  if (!compilerDependencyTool?.available || !isSha256(compilerDependencyTool.sha256)) {
    errors.push("color lookup compiler dependency hash is unavailable");
  }
  if (!assetLoaderTool?.available || !isSha256(assetLoaderTool.sha256)) {
    errors.push("color lookup asset loader hash is unavailable");
  }

  const closureFiles = Array.isArray(binding?.compiler?.closure?.files) ? binding.compiler.closure.files : [];
  const compilerBinding = closureFiles.find((file) => file?.name === "color-lookup-compiler.js");
  const dependencyBinding = closureFiles.find((file) => file?.name === "util.js");
  if (!isSha256(binding?.compiler?.closure?.sha256)) {
    errors.push("manifest compiler closure digest is invalid");
  }
  if (compilerBinding?.sha256 !== compilerTool?.sha256) {
    errors.push("manifest compiler hash does not match tool provenance");
  }
  if (dependencyBinding?.sha256 !== compilerDependencyTool?.sha256) {
    errors.push("manifest compiler dependency hash does not match tool provenance");
  }
  if (!isSha256(binding?.input?.sha256)) {
    errors.push("manifest input digest is invalid");
  }
  if (
    binding?.assignmentMapping?.encoding !== COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING ||
    binding?.assignmentMapping?.assignmentCount !== binding?.input?.assignmentCount ||
    binding?.assignmentMapping?.sha256 !== EXPECTED_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256 ||
    binding?.computedAssignmentMappingSha256 !== EXPECTED_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256
  ) {
    errors.push("manifest assignment mapping does not match the pinned compiled output");
  }
  if (!isSha256(binding?.binary?.sha256) || binding?.binary?.sha256 !== binaryTool?.sha256) {
    errors.push("manifest binary digest does not match tool provenance");
  }
  if (
    !Number.isSafeInteger(binding?.binary?.byteLength) ||
    binding.binary.byteLength < 1 ||
    binding.binary.byteLength !== binaryTool?.bytes
  ) {
    errors.push("manifest binary length does not match tool provenance");
  }

  for (const [index, record] of records.entries()) {
    const canonicalBody = Buffer.from(JSON.stringify(record?.receipt));
    if (
      record?.bodyBytes !== canonicalBody.byteLength ||
      !isSha256(record?.bodySha256) ||
      record.bodySha256 !== sha256Bytes(canonicalBody)
    ) {
      errors.push(`receipt ${index + 1} body length or SHA-256 is invalid`);
    }
  }

  const receipts = records.map((record) => record?.receipt);
  const mainReceipts = receipts.filter((receipt) => receipt?.role === "builder-main");
  const workerReceipts = receipts.filter((receipt) => receipt?.role === "frame-worker");
  if (records.length !== 2) {
    errors.push(`expected exactly 2 color lookup receipts, observed ${records.length}`);
  }
  if (mainReceipts.length !== 1) {
    errors.push(`expected exactly 1 builder-main receipt, observed ${mainReceipts.length}`);
  }
  if (workerReceipts.length !== 1) {
    errors.push(`expected exactly 1 frame-worker receipt, observed ${workerReceipts.length}`);
  }

  for (const [index, receipt] of receipts.entries()) {
    validateColorLookupReceipt(receipt, {
      index,
      expectedRequestedMode,
      expectedEffectiveMode,
      binding,
      errors,
    });
  }

  const mainReceipt = mainReceipts[0];
  const workerReceipt = workerReceipts[0];
  if (mainReceipt) {
    if (mainReceipt.spawnOrdinal !== 0 || mainReceipt.threadId !== 0) {
      errors.push("builder-main receipt must have spawnOrdinal=0 and threadId=0");
    }
  }
  if (workerReceipt) {
    if (workerReceipt.spawnOrdinal !== 1) {
      errors.push(`frame-worker receipt must have spawnOrdinal=1; observed ${String(workerReceipt.spawnOrdinal)}`);
    }
    if (!Number.isSafeInteger(workerReceipt.threadId) || workerReceipt.threadId <= 0) {
      errors.push("frame-worker receipt must identify a positive worker threadId");
    }
  }
  if (mainReceipt && workerReceipt) {
    if (mainReceipt.processId !== workerReceipt.processId) {
      errors.push("builder-main and frame-worker receipts must come from the same renderer process");
    }
    if (JSON.stringify(mainReceipt.state?.identity) !== JSON.stringify(workerReceipt.state?.identity)) {
      errors.push("builder-main and frame-worker lookup identities differ");
    }
    if (
      mainReceipt.state?.requestedMode !== workerReceipt.state?.requestedMode ||
      mainReceipt.state?.effectiveMode !== workerReceipt.state?.effectiveMode
    ) {
      errors.push("builder-main and frame-worker lookup treatments differ");
    }
  }
  if (!Number.isSafeInteger(expectedProcessId) || expectedProcessId <= 0) {
    errors.push("spawned renderer process ID is unavailable");
  } else {
    for (const receipt of receipts) {
      if (receipt?.processId !== expectedProcessId) {
        errors.push(
          `${String(receipt?.role || "unknown")} receipt processId ${String(receipt?.processId)} ` +
            `does not match spawned renderer PID ${expectedProcessId}`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    expected: {
      requestedMode: expectedRequestedMode,
      effectiveMode: expectedEffectiveMode,
      receiptRoles: ["builder-main", "frame-worker"],
      processId: expectedProcessId,
      compilerClosureSha256: binding?.compiler?.closure?.sha256 ?? null,
      inputSha256: binding?.input?.sha256 ?? null,
      assignmentMappingSha256:
        expectedEffectiveMode === "precompiled" ? (binding?.assignmentMapping?.sha256 ?? null) : null,
      binarySha256: expectedEffectiveMode === "precompiled" ? (binding?.binary?.sha256 ?? null) : null,
    },
    observed: receipts.map(summarizeColorLookupReceipt),
    errors,
  };
}

function validateColorLookupReceipt(receipt, { index, expectedRequestedMode, expectedEffectiveMode, binding, errors }) {
  const label = `receipt ${index + 1}`;
  if (!isPlainObject(receipt)) {
    errors.push(`${label} is not an object`);
    return;
  }
  if (receipt.schemaVersion !== BENCHMARK_RECEIPT_SCHEMA_VERSION || receipt.type !== BENCHMARK_RECEIPT_TYPE) {
    errors.push(`${label} schema or type is invalid`);
  }
  if (receipt.role !== "builder-main" && receipt.role !== "frame-worker") {
    errors.push(`${label} role is invalid`);
  }
  if (!Number.isSafeInteger(receipt.spawnOrdinal) || receipt.spawnOrdinal < 0) {
    errors.push(`${label} spawnOrdinal is invalid`);
  }
  if (!Number.isSafeInteger(receipt.processId) || receipt.processId <= 0) {
    errors.push(`${label} processId is invalid`);
  }
  if (!Number.isSafeInteger(receipt.threadId) || receipt.threadId < 0) {
    errors.push(`${label} threadId is invalid`);
  }
  const state = receipt.state;
  if (!isPlainObject(state) || !isPlainObject(state.identity) || !isPlainObject(state.status)) {
    errors.push(`${label} state is invalid`);
    return;
  }
  if (state.requestedMode !== expectedRequestedMode || state.effectiveMode !== expectedEffectiveMode) {
    errors.push(
      `${label} treatment is ${String(state.requestedMode)}/${String(state.effectiveMode)}, expected ` +
        `${expectedRequestedMode}/${expectedEffectiveMode}`,
    );
  }
  if (state.fallbackReason !== null || state.fallbackReasonCode !== null) {
    errors.push(`${label} reports a color lookup fallback`);
  }
  const identity = state.identity;
  if (
    identity.compilerId !== binding?.compiler?.id ||
    identity.inputSha256 !== binding?.input?.sha256 ||
    identity.assignmentCount !== binding?.input?.assignmentCount
  ) {
    errors.push(`${label} compiler or input identity does not match manifest provenance`);
  }
  if (!Object.hasOwn(identity, "assignmentMappingSha256")) {
    errors.push(`${label} assignment mapping identity is missing`);
  }
  if (expectedEffectiveMode === "precompiled") {
    if (
      identity.compilerClosureSha256 !== binding?.compiler?.closure?.sha256 ||
      identity.assignmentMappingSha256 !== binding?.assignmentMapping?.sha256 ||
      identity.binarySha256 !== binding?.binary?.sha256 ||
      identity.binaryByteLength !== binding?.binary?.byteLength ||
      identity.paletteCount !== binding?.paletteCount
    ) {
      errors.push(`${label} precompiled asset identity does not match manifest provenance`);
    }
  } else if (
    identity.compilerClosureSha256 !== null ||
    identity.assignmentMappingSha256 !== null ||
    identity.binarySha256 !== null ||
    identity.binaryByteLength !== null ||
    identity.paletteCount !== null
  ) {
    errors.push(`${label} dynamic treatment unexpectedly reports a precompiled asset identity`);
  }

  const status = state.status;
  const timingFields = ["readMs", "validateMs", "materializeMs", "compileMs", "fallbackAttemptMs", "totalMs"];
  for (const field of timingFields) {
    if (!Number.isFinite(status[field]) || status[field] < 0) {
      errors.push(`${label} timing '${field}' is invalid`);
    }
  }
  if (
    status.assignmentCount !== binding?.input?.assignmentCount ||
    !Number.isSafeInteger(status.logicalColorBytes) ||
    status.logicalColorBytes <= 0 ||
    status.logicalColorBytes !== binding?.logicalColorBytes
  ) {
    errors.push(`${label} lookup status counts are invalid`);
  }
  if (status.fallbackAttemptMs !== 0) {
    errors.push(`${label} fallback timing must be zero`);
  }
  if (expectedEffectiveMode === "dynamic") {
    if (status.paletteCount !== null || status.readMs !== 0 || status.validateMs !== 0 || status.materializeMs !== 0) {
      errors.push(`${label} dynamic timing/status fields are inconsistent`);
    }
  } else if (status.paletteCount !== binding?.paletteCount || status.compileMs !== 0) {
    errors.push(`${label} precompiled timing/status fields are inconsistent`);
  }
  const measuredPhaseMs = status.readMs + status.validateMs + status.materializeMs + status.compileMs;
  if (Number.isFinite(measuredPhaseMs) && Number.isFinite(status.totalMs) && status.totalMs + 0.001 < measuredPhaseMs) {
    errors.push(`${label} totalMs is smaller than its measured phases`);
  }
}

function summarizeColorLookupReceipt(receipt) {
  return {
    role: receipt?.role ?? null,
    spawnOrdinal: receipt?.spawnOrdinal ?? null,
    processId: receipt?.processId ?? null,
    threadId: receipt?.threadId ?? null,
    requestedMode: receipt?.state?.requestedMode ?? null,
    effectiveMode: receipt?.state?.effectiveMode ?? null,
    fallbackReasonCode: receipt?.state?.fallbackReasonCode ?? null,
    identity: receipt?.state?.identity ?? null,
    timings: receipt?.state?.status ?? null,
  };
}

function validateBenchmarkSnowRfTreatment(sideband, options, tools, expectedProcessId = null) {
  const errors = [...(sideband?.errors || [])];
  const records = Array.isArray(sideband?.receipts) ? sideband.receipts : [];
  const expectedResolvedMode = String(options?.snowRf || "");
  const expectedEffectiveMode = expectedResolvedMode === "off" ? "json" : "typed-asset";
  const expectedTimingMode = expectedResolvedMode === "off" ? "A" : "B";
  const binding = tools?.snowRfAssetBinding;
  const compilerTool = tools?.snowRfCompiler;
  const assetLoaderTool = tools?.snowRfAssetLoader;
  const binaryTool = tools?.snowRfBinary;
  const manifestTool = tools?.snowRfManifest;

  if (!isPlainObject(binding) || binding.error) {
    errors.push("snow-rf manifest provenance is unavailable");
  }
  if (!manifestTool?.available || !isSha256(manifestTool.sha256)) {
    errors.push("snow-rf manifest file hash is unavailable");
  }
  if (!binaryTool?.available || !isSha256(binaryTool.sha256)) {
    errors.push("snow-rf binary file hash is unavailable");
  }
  if (!compilerTool?.available || !isSha256(compilerTool.sha256)) {
    errors.push("snow-rf compiler file hash is unavailable");
  }
  if (!assetLoaderTool?.available || !isSha256(assetLoaderTool.sha256)) {
    errors.push("snow-rf asset loader hash is unavailable");
  }
  if (!isSha256(binding?.binary?.sha256) || binding?.binary?.sha256 !== binaryTool?.sha256) {
    errors.push("snow-rf manifest binary digest does not match tool provenance");
  }
  if (
    !Number.isSafeInteger(binding?.binary?.bytes) ||
    binding.binary.bytes < 1 ||
    binding.binary.bytes !== binaryTool?.bytes
  ) {
    errors.push("snow-rf manifest binary length does not match tool provenance");
  }

  for (const [index, record] of records.entries()) {
    const canonicalBody = Buffer.from(JSON.stringify(record?.receipt));
    if (
      record?.bodyBytes !== canonicalBody.byteLength ||
      !isSha256(record?.bodySha256) ||
      record.bodySha256 !== sha256Bytes(canonicalBody)
    ) {
      errors.push(`receipt ${index + 1} body length or SHA-256 is invalid`);
    }
  }

  const receipts = records.map((record) => record?.receipt);
  const mainReceipts = receipts.filter((receipt) => receipt?.role === "builder-main");
  const workerReceipts = receipts.filter((receipt) => receipt?.role === "frame-worker");
  if (records.length !== 2) {
    errors.push(`expected exactly 2 snow-rf receipts, observed ${records.length}`);
  }
  if (mainReceipts.length !== 1) {
    errors.push(`expected exactly 1 builder-main receipt, observed ${mainReceipts.length}`);
  }
  if (workerReceipts.length !== 1) {
    errors.push(`expected exactly 1 frame-worker receipt, observed ${workerReceipts.length}`);
  }

  for (const [index, receipt] of receipts.entries()) {
    validateSnowRfReceipt(receipt, {
      index,
      expectedResolvedMode,
      expectedEffectiveMode,
      expectedTimingMode,
      binding,
      binaryTool,
      errors,
    });
  }

  const mainReceipt = mainReceipts[0];
  const workerReceipt = workerReceipts[0];
  if (mainReceipt) {
    if (mainReceipt.spawnOrdinal !== 0 || mainReceipt.threadId !== 0) {
      errors.push("builder-main receipt must have spawnOrdinal=0 and threadId=0");
    }
  }
  if (workerReceipt) {
    if (workerReceipt.spawnOrdinal !== 1) {
      errors.push(`frame-worker receipt must have spawnOrdinal=1; observed ${String(workerReceipt.spawnOrdinal)}`);
    }
    if (!Number.isSafeInteger(workerReceipt.threadId) || workerReceipt.threadId <= 0) {
      errors.push("frame-worker receipt must identify a positive worker threadId");
    }
  }
  if (mainReceipt && workerReceipt) {
    if (mainReceipt.processId !== workerReceipt.processId) {
      errors.push("builder-main and frame-worker receipts must come from the same renderer process");
    }
    if (JSON.stringify(mainReceipt.state?.identity) !== JSON.stringify(workerReceipt.state?.identity)) {
      errors.push("builder-main and frame-worker snow-rf identities differ");
    }
    if (
      mainReceipt.state?.configuration?.resolvedMode !== workerReceipt.state?.configuration?.resolvedMode ||
      mainReceipt.state?.status?.effectiveMode !== workerReceipt.state?.status?.effectiveMode
    ) {
      errors.push("builder-main and frame-worker snow-rf treatments differ");
    }
  }
  if (!Number.isSafeInteger(expectedProcessId) || expectedProcessId <= 0) {
    errors.push("spawned renderer process ID is unavailable");
  } else {
    for (const receipt of receipts) {
      if (receipt?.processId !== expectedProcessId) {
        errors.push(
          `${String(receipt?.role || "unknown")} receipt processId ${String(receipt?.processId)} ` +
            `does not match spawned renderer PID ${expectedProcessId}`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    expected: {
      resolvedMode: expectedResolvedMode,
      effectiveMode: expectedEffectiveMode,
      timingMode: expectedTimingMode,
      receiptRoles: ["builder-main", "frame-worker"],
      processId: expectedProcessId,
      commitmentEncoding: SNOW_RF_COMMITMENT_ENCODING,
      regionCount: PASS16_REGION_COMMITMENT_COUNT,
      binaryByteLength: binding?.binary?.bytes ?? null,
      canonicalModelBinarySha256: binding?.binary?.sha256 ?? null,
    },
    observed: receipts.map(summarizeSnowRfReceipt),
    errors,
  };
}

function validateSnowRfReceipt(
  receipt,
  { index, expectedResolvedMode, expectedEffectiveMode, expectedTimingMode, binding, binaryTool, errors },
) {
  const label = `receipt ${index + 1}`;
  if (!isPlainObject(receipt)) {
    errors.push(`${label} is not an object`);
    return;
  }
  if (receipt.schemaVersion !== SNOW_RF_RECEIPT_SCHEMA_VERSION || receipt.type !== SNOW_RF_RECEIPT_TYPE) {
    errors.push(`${label} schema or type is invalid`);
  }
  if (receipt.role !== "builder-main" && receipt.role !== "frame-worker") {
    errors.push(`${label} role is invalid`);
  }
  if (!Number.isSafeInteger(receipt.spawnOrdinal) || receipt.spawnOrdinal < 0) {
    errors.push(`${label} spawnOrdinal is invalid`);
  }
  if (!Number.isSafeInteger(receipt.processId) || receipt.processId <= 0) {
    errors.push(`${label} processId is invalid`);
  }
  if (!Number.isSafeInteger(receipt.threadId) || receipt.threadId < 0) {
    errors.push(`${label} threadId is invalid`);
  }
  const state = receipt.state;
  if (
    !isPlainObject(state) ||
    !isPlainObject(state.configuration) ||
    !isPlainObject(state.status) ||
    !isPlainObject(state.commitments)
  ) {
    errors.push(`${label} state is invalid`);
    return;
  }
  if (
    state.configuration.resolvedMode !== expectedResolvedMode ||
    state.status.effectiveMode !== expectedEffectiveMode
  ) {
    errors.push(
      `${label} treatment is ${String(state.configuration.resolvedMode)}/${String(state.status.effectiveMode)}, ` +
        `expected ${expectedResolvedMode}/${expectedEffectiveMode}`,
    );
  }
  if (state.status.fallbackUsed !== false || state.status.fallbackReasonCode !== null) {
    errors.push(`${label} reports a snow-rf fallback`);
  }
  const commitments = state.commitments;
  if (
    commitments.encoding !== SNOW_RF_COMMITMENT_ENCODING ||
    commitments.regionCount !== PASS16_REGION_COMMITMENT_COUNT
  ) {
    errors.push(`${label} commitment encoding or region count is invalid`);
  }
  if (
    !isSha256(commitments.canonicalModelBinarySha256) ||
    commitments.canonicalModelBinarySha256 !== binaryTool?.sha256 ||
    commitments.canonicalModelBinarySha256 !== binding?.binary?.sha256
  ) {
    errors.push(`${label} canonical model binary digest does not match the committed asset`);
  }
  if (expectedEffectiveMode === "typed-asset") {
    const ownership = state.ownership;
    if (
      !isPlainObject(ownership) ||
      ownership.commonOwner !== true ||
      ownership.ownerAllocationCount !== 1 ||
      ownership.ownerByteLength !== binaryTool?.bytes ||
      ownership.regionCount !== PASS16_REGION_COMMITMENT_COUNT ||
      ownership.privateRegionOwnerCount !== 0
    ) {
      errors.push(`${label} typed-asset ownership does not match the one-owner contract`);
    }
  } else if (state.ownership !== null) {
    errors.push(`${label} json treatment unexpectedly reports typed-asset ownership`);
  }
  try {
    validatePass16TimingAndMemory(state.timing, { mode: expectedTimingMode, teardownTrial: false });
  } catch (error) {
    errors.push(`${label} timing is invalid: ${String(error?.message || error)}`);
  }
}

function summarizeSnowRfReceipt(receipt) {
  const commitments = receipt?.state?.commitments;
  return {
    role: receipt?.role ?? null,
    spawnOrdinal: receipt?.spawnOrdinal ?? null,
    processId: receipt?.processId ?? null,
    threadId: receipt?.threadId ?? null,
    resolvedMode: receipt?.state?.configuration?.resolvedMode ?? null,
    effectiveMode: receipt?.state?.status?.effectiveMode ?? null,
    fallbackReasonCode: receipt?.state?.status?.fallbackReasonCode ?? null,
    commitments: isPlainObject(commitments)
      ? {
          regionCount: commitments.regionCount ?? null,
          canonicalModelBinarySha256: commitments.canonicalModelBinarySha256 ?? null,
        }
      : null,
    ownership: receipt?.state?.ownership ?? null,
  };
}

function summarizeBenchmarkTreatment(repetitions, options) {
  const treatmentValidations = (name) =>
    repetitions.map((run) => run.parsed?.fixtureValidation?.[name]).filter(Boolean);
  const observedEffectiveModes = (validations) =>
    Array.from(
      new Set(
        validations.flatMap((validation) =>
          (validation.observed || []).map((receipt) => receipt.effectiveMode).filter(Boolean),
        ),
      ),
    ).sort();
  const colorLookupValidations = treatmentValidations("colorLookupTreatment");
  const snowRfValidations = treatmentValidations("snowRfTreatment");
  return {
    colorLookups: {
      requestedMode: options.colorLookups,
      expectedEffectiveMode: options.colorLookups === "dynamic" ? "dynamic" : "precompiled",
      repetitionsValidated: colorLookupValidations.filter((validation) => validation.valid).length,
      repetitionsObserved: colorLookupValidations.length,
      effectiveModes: observedEffectiveModes(colorLookupValidations),
    },
    snowRf: {
      requestedMode: options.snowRf,
      expectedEffectiveMode: options.snowRf === "off" ? "json" : "typed-asset",
      repetitionsValidated: snowRfValidations.filter((validation) => validation.valid).length,
      repetitionsObserved: snowRfValidations.length,
      effectiveModes: observedEffectiveModes(snowRfValidations),
    },
  };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validateBenchmarkMainFrameRoster(frames, options) {
  const expectedModel = String(options?.model || "").trim();
  const expectedRun =
    options?.date && options?.cycle ? `${String(options.date)}-${String(options.cycle).padStart(2, "0")}00Z` : null;
  const expectedHours = Array.from(
    new Set((options?.hours || []).map(Number).filter((hour) => Number.isInteger(hour))),
  ).sort((left, right) => left - right);
  const expectedHourSet = new Set(expectedHours);
  const mainFrames = (frames || []).filter((frame) => frame?.frameKind === "complete" || frame?.frameKind === "base");
  const wrongModelFrames = mainFrames.filter((frame) => frame.model !== expectedModel).map(summarizeRosterFrame);
  const wrongRunFrames = expectedRun
    ? mainFrames.filter((frame) => frame.model === expectedModel && frame.run !== expectedRun).map(summarizeRosterFrame)
    : [];
  const unexpectedHourFrames = mainFrames
    .filter(
      (frame) =>
        frame.model === expectedModel &&
        (!expectedRun || frame.run === expectedRun) &&
        !expectedHourSet.has(Number(frame.hour)),
    )
    .map(summarizeRosterFrame);
  const countsByExpectedHour = new Map(expectedHours.map((hour) => [hour, 0]));
  for (const frame of mainFrames) {
    const hour = Number(frame.hour);
    if (
      frame.model === expectedModel &&
      (!expectedRun || frame.run === expectedRun) &&
      countsByExpectedHour.has(hour)
    ) {
      countsByExpectedHour.set(hour, countsByExpectedHour.get(hour) + 1);
    }
  }
  const missingHours = expectedHours.filter((hour) => countsByExpectedHour.get(hour) === 0);
  const duplicateHours = expectedHours
    .filter((hour) => countsByExpectedHour.get(hour) > 1)
    .map((hour) => ({ hour, count: countsByExpectedHour.get(hour) }));
  const errors = [];
  if (mainFrames.length === 0) errors.push("no profiled main frames");
  if (missingHours.length > 0) errors.push(`missing main hours ${missingHours.join(",")}`);
  if (duplicateHours.length > 0) {
    errors.push(`duplicate main hours ${duplicateHours.map(({ hour, count }) => `${hour}x${count}`).join(",")}`);
  }
  if (wrongModelFrames.length > 0) {
    errors.push(`wrong-model main frames ${formatRosterFrames(wrongModelFrames)}`);
  }
  if (wrongRunFrames.length > 0) {
    errors.push(`wrong-run main frames ${formatRosterFrames(wrongRunFrames)}`);
  }
  if (unexpectedHourFrames.length > 0) {
    errors.push(`wrong-hour main frames ${formatRosterFrames(unexpectedHourFrames)}`);
  }
  return {
    valid: errors.length === 0,
    expected: { model: expectedModel, run: expectedRun, hours: expectedHours },
    observedMainFrames: mainFrames.map(summarizeRosterFrame),
    missingHours,
    duplicateHours,
    wrongModelFrames,
    wrongRunFrames,
    unexpectedHourFrames,
    errors,
  };
}

function summarizeRosterFrame(frame) {
  return {
    model: String(frame?.model || ""),
    run: String(frame?.run || ""),
    hour: Number(frame?.hour),
    frameKind: String(frame?.frameKind || ""),
  };
}

function formatRosterFrames(frames) {
  return frames.map((frame) => `${frame.model}/F${String(frame.hour).padStart(3, "0")}`).join(",");
}

function parseDurationMilliseconds(raw) {
  const text = String(raw || "").trim();
  let match = text.match(/^(\d+(?:\.\d+)?)ms$/);
  if (match) {
    return Number(match[1]);
  }
  match = text.match(/^(\d+(?:\.\d+)?)s$/);
  if (match) {
    return Number(match[1]) * 1000;
  }
  match = text.match(/^(\d+)m(\d+(?:\.\d+)?)s$/);
  if (match) {
    return Number(match[1]) * 60_000 + Number(match[2]) * 1000;
  }
  return null;
}

function createSessionDirectory(options) {
  const outputRoot = options.outputRoot || BENCHMARK_OUTPUT_ROOT;
  fs.mkdirSync(outputRoot, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z");
  const base = `${options.labelSlug}-${options.model}-${options.date}-${options.cycle}z-${timestamp}`;
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const directory = path.join(outputRoot, suffix === 0 ? base : `${base}-${suffix}`);
    try {
      fs.mkdirSync(directory);
      return directory;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error(`Unable to allocate a unique benchmark directory below ${outputRoot}.`);
}

function slugify(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) {
    throw new Error("--label must contain at least one letter or digit.");
  }
  return slug;
}

function requiredString(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${label} is required and may not be blank.`);
  }
  return String(value).trim();
}

function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function isFile(value) {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

function durationMilliseconds(startNs, endNs) {
  return Number(endNs - startNs) / 1e6;
}

function formatMilliseconds(value) {
  return `${(Number(value) / 1000).toFixed(3)}s`;
}

function printUsage() {
  console.log(`Usage:
  node scripts/benchmark-noaa-renderer.js \\
    --label=pass-01-baseline \\
    --cache-root=/absolute/path/to/dedicated-cache \\
    --source-root=/optional/baseline/repository \\
    --output-root=output/noaa-benchmarks/renderer-30pass \\
    --model=gfs --date=20260716 --cycle=06 \\
    --hours=0,3,6,9 --repetitions=3 \\
    --hover-arena=auto --fast-pack=auto --color-lookups=auto --snow-rf=auto

The harness never clears or deletes caches. It runs the pinned serial renderer
fixture, stores raw logs below --output-root (default:
output/noaa-benchmarks/renderer-20pass), and
writes a versioned JSON summary next to those logs. --hover-arena and
--fast-pack accept auto (the default) or off. --color-lookups accepts auto,
dynamic, or precompiled. --snow-rf accepts auto, off, or required. All four
are pinned against shell and .env overrides.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  BENCHMARK_OUTPUT_ROOT,
  KNOWN_RENDERER_ENV_INPUTS,
  PINNED_BUILDER_FLAGS,
  PINNED_ENV_DEFAULTS,
  PINNED_PROCESS_ENV_DEFAULTS,
  SOURCE_FINGERPRINT_ENTRIES,
  SUMMARY_SCHEMA_VERSION,
  buildBenchmarkEnvironment,
  buildPinnedBuilderArgs,
  classifyFrameKind,
  collectHostLoadSnapshot,
  collectSourceProvenance,
  collectSystemProvenance,
  collectToolProvenance,
  fingerprintSourceTree,
  normalizeBenchmarkOptions,
  parseBenchmarkReceiptSideband,
  parseDurationMilliseconds,
  parseProfileFrameLine,
  parseRendererBenchmarkLog,
  partitionBenchmarkReceiptSideband,
  resolveBuilderConfig,
  summarizeFrameRecords,
  summarizeSamples,
  validateBenchmarkColorLookupTreatment,
  validateBenchmarkMainFrameRoster,
  validateBenchmarkSnowRfTreatment,
};
