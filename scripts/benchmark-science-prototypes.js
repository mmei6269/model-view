#!/usr/bin/env node
"use strict";

// Reproducible, allocation-light microbenchmarks for the opt-in meteorological
// prototypes. These isolate the numerical kernels on one synthetic column and
// extrapolate CPU time linearly to the production 1600x980 CONUS grid; they are
// not end-to-end renderer wall times and do not include GRIB I/O, regridding,
// PNG/hover encoding, worker contention, or cache effects.

const { performance } = require("node:perf_hooks");
const { loadSynopticStyle } = require("./lib/synoptic-style");
const { _testCenterDetection } = require("./lib/synoptic-render");
const {
  buildDerivedProfileSources,
  buildEffectiveLayerProfileSources,
  buildMixedLayerPointSoundingSourceFromScratch,
  calculateEffectiveLayerProductsFromSources,
  calculateEffectiveParcelLayerFromRows,
  calculatePressureStepParcelCapeCinForSource,
  calculateReducedProfileDcapeFromSources,
  createEffectiveDiagnosticsScratch,
  fillEffectiveDiagnosticsProfileRows,
  hasEffectiveDiagnosticsCandidateCape,
  hasEffectiveDiagnosticsSurfacePrerequisites,
} = require("./lib/noaa-beta/severe");
const { calculatePointDcapeJkg } = require("./lib/noaa-beta/point-sounding");
const { EFFECTIVE_LAYER_PROFILE_LEVELS } = require("./lib/noaa-nam-parameter-catalog");

const CONUS_CELL_COUNT = 1600 * 980;
const AUDITED_HRRR_NATIVE_CANDIDATES = 696000;
const SYNTHETIC_COLUMN_REPETITIONS = 9;
const SYNTHETIC_COLUMN_ITERATIONS = 50000;

function buildSyntheticColumn() {
  const decoded = {
    profileSurfaceHeight: new Float32Array([0]),
    temperature2m: new Float32Array([303]),
    dewpoint2m: new Float32Array([298]),
    derivedSurfacePressure: new Float32Array([100000]),
    windU10m: new Float32Array([0]),
    windV10m: new Float32Array([0]),
    mlcape: new Float32Array([2000]),
    mlcin: new Float32Array([-25]),
    sbcape: new Float32Array([1500]),
    sbcin: new Float32Array([-10]),
    mucape: new Float32Array([2500]),
  };
  for (const level of EFFECTIVE_LAYER_PROFILE_LEVELS) {
    const height = 44330 * (1 - Math.pow(level / 1000, 0.1903));
    decoded[`profileHgt${level}`] = new Float32Array([height]);
    decoded[`profileTmp${level}`] = new Float32Array([303 - 0.0085 * height]);
    decoded[`profileRh${level}`] = new Float32Array([level <= 850 && level >= 700 ? 28 : 72]);
    decoded[`profileU${level}`] = new Float32Array([1 + 0.0042 * height]);
    decoded[`profileV${level}`] = new Float32Array([4 * Math.sin(height / 2600)]);
  }
  return decoded;
}

function benchmarkMicroseconds(
  name,
  fn,
  {
    iterations = SYNTHETIC_COLUMN_ITERATIONS,
    repetitions = SYNTHETIC_COLUMN_REPETITIONS,
    warmupIterations = Math.min(5000, iterations),
  } = {},
) {
  for (let warm = 0; warm < warmupIterations; warm += 1) {
    fn();
  }
  const samplesUs = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      fn();
    }
    samplesUs.push(((performance.now() - started) * 1000) / iterations);
  }
  samplesUs.sort((left, right) => left - right);
  return {
    name,
    warmupIterations,
    iterationsPerRepetition: iterations,
    repetitions,
    medianUs: quantileSorted(samplesUs, 0.5),
    p95Us: quantileSorted(samplesUs, 0.95),
    minUs: samplesUs[0],
    maxUs: samplesUs.at(-1),
    samplesUs,
  };
}

function buildPointDcapeLevels(decoded) {
  const levels = [
    {
      source: "surface",
      press: decoded.derivedSurfacePressure[0] / 100,
      hght: decoded.profileSurfaceHeight[0],
      temp: decoded.temperature2m[0] - 273.15,
      dwpt: decoded.dewpoint2m[0] - 273.15,
    },
  ];
  for (const level of EFFECTIVE_LAYER_PROFILE_LEVELS) {
    // The synthetic 1000-hPa profile row is colocated with the explicit
    // surface row. Excluding that duplicate avoids a zero-width interpolation
    // interval without changing the represented column.
    if (level >= 1000) {
      continue;
    }
    levels.push({
      source: `profile-${level}-hpa`,
      press: level,
      hght: decoded[`profileHgt${level}`][0],
      temp: decoded[`profileTmp${level}`][0] - 273.15,
      rh: decoded[`profileRh${level}`][0],
    });
  }
  return levels;
}

function quantileSorted(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

function cpuSecondsForCells(microsecondsPerCell, cellCount) {
  return (microsecondsPerCell * cellCount) / 1000000;
}

function benchmarkDcape(decoded) {
  const sixLevelSources = buildDerivedProfileSources(decoded);
  const twentyOneLevelSources = buildEffectiveLayerProfileSources(decoded);
  const scratchSize = Math.max(sixLevelSources.length, twentyOneLevelSources.length) + 1;
  const scratch = {
    heights: new Float64Array(scratchSize),
    temps: new Float64Array(scratchSize),
    pressures: new Float64Array(scratchSize),
    dewpoints: new Float64Array(scratchSize),
    thetaE: new Float64Array(scratchSize),
  };
  const sixLevel = () => calculateReducedProfileDcapeFromSources(sixLevelSources, 0, 0, 303, 1000, scratch);
  const twentyOneLevel = () => calculateReducedProfileDcapeFromSources(twentyOneLevelSources, 0, 0, 303, 1000, scratch);
  const sixLevelTiming = benchmarkMicroseconds("dcape-6-level", sixLevel);
  const twentyOneLevelTiming = benchmarkMicroseconds("dcape-21-level", twentyOneLevel);
  return {
    columnResultsJkg: {
      sixLevel: sixLevel(),
      twentyOneLevel: twentyOneLevel(),
    },
    sixLevel: sixLevelTiming,
    twentyOneLevel: twentyOneLevelTiming,
    extrapolatedConusCpuSeconds: {
      sixLevel: cpuSecondsForCells(sixLevelTiming.medianUs, CONUS_CELL_COUNT),
      twentyOneLevel: cpuSecondsForCells(twentyOneLevelTiming.medianUs, CONUS_CELL_COUNT),
      replacementDeltaTwentyOneMinusSix: cpuSecondsForCells(
        twentyOneLevelTiming.medianUs - sixLevelTiming.medianUs,
        CONUS_CELL_COUNT,
      ),
      additiveMarginalWhenDefaultIsAlsoRendered: cpuSecondsForCells(twentyOneLevelTiming.medianUs, CONUS_CELL_COUNT),
      defaultPlusPrototype: cpuSecondsForCells(
        sixLevelTiming.medianUs + twentyOneLevelTiming.medianUs,
        CONUS_CELL_COUNT,
      ),
    },
  };
}

function benchmarkDenseDcape(decoded) {
  const pointLevels = buildPointDcapeLevels(decoded);
  const densePoint = () => calculatePointDcapeJkg(pointLevels);
  const timing = benchmarkMicroseconds("dcape-current-point-method", densePoint, {
    iterations: 1000,
    repetitions: SYNTHETIC_COLUMN_REPETITIONS,
    warmupIterations: 100,
  });
  return {
    method:
      "current point-dcape-v4: 1-hPa source-layer means on log-pressure-interpolated T/Td, followed by level-to-level pseudoadiabatic descent",
    boundary:
      "reference numerical kernel on the same 21-row synthetic input; not an end-to-end gridded renderer time or an independent SHARPpy invocation",
    columnResultJkg: densePoint(),
    timing,
    extrapolatedConusCpuSeconds: cpuSecondsForCells(timing.medianUs, CONUS_CELL_COUNT),
  };
}

function benchmarkStp(decoded) {
  const sources = buildEffectiveLayerProfileSources(decoded);
  const scratch = createEffectiveDiagnosticsScratch(sources.length);
  const run = (options) => calculateEffectiveLayerProductsFromSources(decoded, sources, 0, 0, 0, 0, scratch, options);
  const prerequisite = benchmarkMicroseconds(
    "stp-surface-prerequisite-screen",
    () => hasEffectiveDiagnosticsSurfacePrerequisites(decoded, 0),
    { iterations: 2000000, repetitions: SYNTHETIC_COLUMN_REPETITIONS },
  );
  const nativeMask = benchmarkMicroseconds(
    "stp-native-candidate-mask",
    () => hasEffectiveDiagnosticsCandidateCape(decoded, 0, { needsStp: true }),
    { iterations: 2000000, repetitions: SYNTHETIC_COLUMN_REPETITIONS },
  );
  const prototypeMask = benchmarkMicroseconds(
    "stp-prototype-candidate-mask",
    () => hasEffectiveDiagnosticsCandidateCape(decoded, 0, { needsStp100mb: true }),
    { iterations: 2000000, repetitions: SYNTHETIC_COLUMN_REPETITIONS },
  );
  const combinedMask = benchmarkMicroseconds(
    "stp-native-plus-prototype-candidate-mask",
    () => hasEffectiveDiagnosticsCandidateCape(decoded, 0, { needsStp: true, needsStp100mb: true }),
    { iterations: 2000000, repetitions: SYNTHETIC_COLUMN_REPETITIONS },
  );
  const native = benchmarkMicroseconds("stp-native-only", () => run({ needsStp: true }));
  const prototype = benchmarkMicroseconds("stp-100mb-prototype-only", () => run({ needsStp100mb: true }));
  const both = benchmarkMicroseconds("stp-native-plus-prototype", () => run({ needsStp: true, needsStp100mb: true }));
  const otherCells = CONUS_CELL_COUNT - AUDITED_HRRR_NATIVE_CANDIDATES;
  const nativeOnlyCoreSeconds = cpuSecondsForCells(native.medianUs, AUDITED_HRRR_NATIVE_CANDIDATES);
  const prototypeOnlyCoreSeconds = cpuSecondsForCells(prototype.medianUs, CONUS_CELL_COUNT);
  const combinedCoreSeconds =
    cpuSecondsForCells(both.medianUs, AUDITED_HRRR_NATIVE_CANDIDATES) +
    cpuSecondsForCells(prototype.medianUs, otherCells);
  const nativeMaskSeconds = cpuSecondsForCells(nativeMask.medianUs, CONUS_CELL_COUNT);
  const prototypeMaskSeconds = cpuSecondsForCells(prototypeMask.medianUs, CONUS_CELL_COUNT);
  const combinedMaskSeconds = cpuSecondsForCells(combinedMask.medianUs, CONUS_CELL_COUNT);
  const nativeOnlySeconds = nativeMaskSeconds + nativeOnlyCoreSeconds;
  const prototypeOnlySeconds = prototypeMaskSeconds + prototypeOnlyCoreSeconds;
  const combinedSeconds = combinedMaskSeconds + combinedCoreSeconds;
  return {
    columnResult: run({ needsStp: true, needsStp100mb: true }),
    prerequisite,
    nativeMask,
    prototypeMask,
    combinedMask,
    native,
    prototype,
    both,
    extrapolationInputs: {
      conusCells: CONUS_CELL_COUNT,
      auditedHrrrNativeCandidates: AUDITED_HRRR_NATIVE_CANDIDATES,
      otherCells,
    },
    extrapolatedConusCpuSeconds: {
      mask: {
        nativeOnly: nativeMaskSeconds,
        prototypeOnly: prototypeMaskSeconds,
        nativePlusPrototype: combinedMaskSeconds,
      },
      core: {
        nativeOnlyAtAuditedCandidateCount: nativeOnlyCoreSeconds,
        prototypeOnlyAllPrerequisiteValidCells: prototypeOnlyCoreSeconds,
        nativePlusPrototypeSharedScan: combinedCoreSeconds,
      },
      total: {
        nativeOnlyAtAuditedCandidateCount: nativeOnlySeconds,
        prototypeOnlyAllPrerequisiteValidCells: prototypeOnlySeconds,
        nativePlusPrototypeSharedScan: combinedSeconds,
        incrementalOverNativeOnly: combinedSeconds - nativeOnlySeconds,
      },
      prerequisiteAllCells: cpuSecondsForCells(prerequisite.medianUs, CONUS_CELL_COUNT),
    },
  };
}

function benchmarkDenseStp(decoded) {
  const sources = buildEffectiveLayerProfileSources(decoded);
  const scratch = createEffectiveDiagnosticsScratch(sources.length);
  const rowCount = fillEffectiveDiagnosticsProfileRows(decoded, sources, 0, 0, 0, 0, scratch);
  const denseMixedLayerParcel = () => {
    const source = buildMixedLayerPointSoundingSourceFromScratch(scratch, rowCount);
    return source ? calculatePressureStepParcelCapeCinForSource(scratch, rowCount, source) : null;
  };
  const denseEffectiveLayerThermodynamics = () => ({
    effectiveLayer: calculateEffectiveParcelLayerFromRows(scratch, rowCount, {
      pressureStep: true,
      sourceStepHpa: 0,
    }),
    mixedLayerParcel: denseMixedLayerParcel(),
  });
  const mixedLayerParcelTiming = benchmarkMicroseconds("stp-dense-100mb-mixed-parcel", denseMixedLayerParcel, {
    iterations: 200,
    repetitions: SYNTHETIC_COLUMN_REPETITIONS,
    warmupIterations: 20,
  });
  const effectiveLayerPlusMixedParcelTiming = benchmarkMicroseconds(
    "stp-point-style-dense-effective-layer-plus-100mb-mixed-parcel",
    denseEffectiveLayerThermodynamics,
    { iterations: 20, repetitions: 7, warmupIterations: 3 },
  );
  return {
    method:
      "current point-sounding pressure-step thermodynamics on the same 21-row synthetic input; effective-layer source scan uses every loaded source row in the lowest 300 hPa",
    boundary:
      "the mixed-parcel timing is the minimum dense thermodynamic component, not full STP; the combined timing adds the dense effective-inflow source scan but excludes wind interpolation, Bunkers/ESRH/EBWD, final scalar arithmetic, masks, I/O, and rendering",
    rowCount,
    columnResult: denseEffectiveLayerThermodynamics(),
    mixedLayerParcelTiming,
    effectiveLayerPlusMixedParcelTiming,
    extrapolatedConusCpuSeconds: {
      mixedLayerParcelAtAuditedNativeCandidateCount: cpuSecondsForCells(
        mixedLayerParcelTiming.medianUs,
        AUDITED_HRRR_NATIVE_CANDIDATES,
      ),
      mixedLayerParcelAllCells: cpuSecondsForCells(mixedLayerParcelTiming.medianUs, CONUS_CELL_COUNT),
      effectiveLayerPlusMixedParcelAtAuditedNativeCandidateCount: cpuSecondsForCells(
        effectiveLayerPlusMixedParcelTiming.medianUs,
        AUDITED_HRRR_NATIVE_CANDIDATES,
      ),
      effectiveLayerPlusMixedParcelAllCells: cpuSecondsForCells(
        effectiveLayerPlusMixedParcelTiming.medianUs,
        CONUS_CELL_COUNT,
      ),
    },
  };
}

function buildCenterBenchmarkField(width, height) {
  const values = new Float32Array(width * height);
  const systems = [
    { x: 16, y: 16, amplitude: -13, sigma: 7 },
    { x: 42, y: 18, amplitude: 11, sigma: 8 },
    { x: 70, y: 15, amplitude: -10, sigma: 7 },
    { x: 98, y: 18, amplitude: 12, sigma: 8 },
    { x: 25, y: 39, amplitude: 10, sigma: 8 },
    { x: 52, y: 38, amplitude: -14, sigma: 7 },
    { x: 82, y: 40, amplitude: 11, sigma: 8 },
    { x: 106, y: 42, amplitude: -12, sigma: 7 },
    { x: 18, y: 61, amplitude: -10, sigma: 7 },
    { x: 47, y: 59, amplitude: 12, sigma: 8 },
    { x: 76, y: 61, amplitude: -11, sigma: 7 },
    { x: 103, y: 60, amplitude: 10, sigma: 8 },
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let pressure = 1013.25;
      for (const system of systems) {
        const dx = x - system.x;
        const dy = y - system.y;
        pressure += system.amplitude * Math.exp(-(dx * dx + dy * dy) / (2 * system.sigma * system.sigma));
      }
      values[y * width + x] = pressure;
    }
  }
  return values;
}

function benchmarkCenterValidation() {
  const bounds = { north: 53, south: 21, west: -129, east: -63 };
  const width = 119;
  const height = 73;
  const values = buildCenterBenchmarkField(width, height);
  const style = loadSynopticStyle();
  const spacingKm = _testCenterDetection.estimateGridSpacingKm(bounds, width, height);
  const baseline = () => _testCenterDetection.detectPressureCenters(values, width, height, style, null, spacingKm);
  const diagnostic = () =>
    _testCenterDetection.detectPressureCenters(values, width, height, style, null, spacingKm, {
      mode: "row-aware-diagnostic",
      bounds,
    });
  for (let warm = 0; warm < 12; warm += 1) {
    baseline();
    diagnostic();
  }
  const baselineSamplesMs = [];
  const diagnosticSamplesMs = [];
  const pairedDeltaSamplesMs = [];
  let retainedCenters = 0;
  for (let repetition = 0; repetition < 80; repetition += 1) {
    let baselineElapsedMs = Number.NaN;
    let diagnosticElapsedMs = Number.NaN;
    const measureBaseline = () => {
      const started = performance.now();
      baseline();
      baselineElapsedMs = performance.now() - started;
      baselineSamplesMs.push(baselineElapsedMs);
    };
    const measureDiagnostic = () => {
      const started = performance.now();
      retainedCenters = diagnostic().length;
      diagnosticElapsedMs = performance.now() - started;
      diagnosticSamplesMs.push(diagnosticElapsedMs);
    };
    if (repetition % 2 === 0) {
      measureBaseline();
      measureDiagnostic();
    } else {
      measureDiagnostic();
      measureBaseline();
    }
    pairedDeltaSamplesMs.push(diagnosticElapsedMs - baselineElapsedMs);
  }
  baselineSamplesMs.sort((left, right) => left - right);
  diagnosticSamplesMs.sort((left, right) => left - right);
  pairedDeltaSamplesMs.sort((left, right) => left - right);
  const baselineMedian = quantileSorted(baselineSamplesMs, 0.5);
  const diagnosticMedian = quantileSorted(diagnosticSamplesMs, 0.5);
  const baselineP95 = quantileSorted(baselineSamplesMs, 0.95);
  const diagnosticP95 = quantileSorted(diagnosticSamplesMs, 0.95);
  return {
    grid: [width, height],
    retainedCenters,
    warmupPairs: 12,
    measuredPairs: 80,
    order: "alternating baseline-first/diagnostic-first by repetition",
    baselineMs: {
      median: baselineMedian,
      p95: baselineP95,
      min: baselineSamplesMs[0],
      max: baselineSamplesMs.at(-1),
      samples: baselineSamplesMs,
    },
    diagnosticMs: {
      median: diagnosticMedian,
      p95: diagnosticP95,
      min: diagnosticSamplesMs[0],
      max: diagnosticSamplesMs.at(-1),
      samples: diagnosticSamplesMs,
    },
    deltaMs: {
      definition:
        "median/p95 are diagnostic marginal quantile minus baseline marginal quantile; pairedDelta reports within-repetition differences",
      median: diagnosticMedian - baselineMedian,
      p95: diagnosticP95 - baselineP95,
      medianRatio: diagnosticMedian / baselineMedian,
      pairedDelta: {
        median: quantileSorted(pairedDeltaSamplesMs, 0.5),
        p95: quantileSorted(pairedDeltaSamplesMs, 0.95),
        min: pairedDeltaSamplesMs[0],
        max: pairedDeltaSamplesMs.at(-1),
        samples: pairedDeltaSamplesMs,
      },
    },
  };
}

const sectionArg = process.argv.find((argument) => argument.startsWith("--section="));
const benchmarkSection = sectionArg ? sectionArg.slice("--section=".length).trim() : "all";
if (!new Set(["all", "dense"]).has(benchmarkSection)) {
  throw new Error(`unknown benchmark section '${benchmarkSection}'; expected all or dense`);
}
const decoded = buildSyntheticColumn();
const results = {};
if (benchmarkSection === "dense") {
  results.denseReferences = {
    dcape: benchmarkDenseDcape(decoded),
    stp: benchmarkDenseStp(decoded),
  };
} else {
  const dcape = benchmarkDcape(decoded);
  const stp = benchmarkStp(decoded);
  results.rowAwareCenterValidation = benchmarkCenterValidation();
  // Dense references run last so their much larger pressure-step workload does
  // not thermally bias the prototype or row-aware timings reported above.
  dcape.denseReference = benchmarkDenseDcape(decoded);
  stp.denseReference = benchmarkDenseStp(decoded);
  results.dcape = dcape;
  results.stp = stp;
}
process.stdout.write(
  `${JSON.stringify(
    {
      methodology: {
        clock: "node:perf_hooks performance.now",
        syntheticColumnIterationsPerRepetition: SYNTHETIC_COLUMN_ITERATIONS,
        syntheticColumnRepetitions: SYNTHETIC_COLUMN_REPETITIONS,
        conusExtrapolation: "median microseconds per call * 1,568,000 / 1,000,000",
        excluded:
          "GRIB I/O, regridding, PNG/hover encoding, worker scheduling/contention, cache behavior, and model-dependent candidate/profile validity",
        denseReferenceWarning:
          "dense timings use the app's current point-analysis kernels on one synthetic 21-row column; linear grid extrapolations are CPU-work models, not measured renderer wall times or forecast-skill validation",
      },
      ...results,
    },
    null,
    2,
  )}\n`,
);
