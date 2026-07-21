"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

const { NOAA_NAM_PARAMETER_CATALOG } = require("../scripts/lib/noaa-nam-parameter-catalog.js");
const {
  _testApplyRealizedPrecipAccumulationGrids: applyRealizedPrecipAccumulationGrids,
  _testBuildRenderedArtifacts: buildRenderedArtifacts,
  _testHasConclusiveNoCloudCeilingEvidence: hasConclusiveNoCloudCeilingEvidence,
} = require("../scripts/lib/noaa-beta-renderer.js");
const {
  SNOW_LIQUID_TOTAL_KEY,
  buildSnowfallInGrids,
  snowfallDerivedGridKey,
  snowfallEntryHasAvailableData,
} = require("../scripts/lib/noaa-beta/winter.js");
const { buildHoverGridVariables } = require("../scripts/lib/noaa-beta/hover.js");
const { hasColocatedFiniteGridData, hasFiniteGridData } = require("../scripts/lib/noaa-beta/parameter-availability.js");
const {
  applyRenderedFrameToManifestFrame,
  collectFrameArtifactKeys,
  mergeManifestWithTemplate,
  normalizeRenderedFrameArtifacts,
} = require("../scripts/lib/local-artifact-manifest.js");
const { LocalArtifactRuntime } = require("../scripts/lib/local-artifact-runtime.js");
const { serializeFrameArtifacts } = require("../scripts/noaa-beta-frame-worker.js");
const {
  buildFrameSourceProvenance,
  buildRunSourceProvenanceCatalog,
  mergeFrameSourceProvenance,
} = require("../scripts/lib/noaa-beta/source-provenance.js");

function bundleTs(relativeEntry) {
  const entry = path.join(__dirname, "..", relativeEntry);
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    external: ["react"],
    define: {
      "import.meta.env.VITE_ARTIFACT_BASE_URL": "undefined",
      "import.meta.env.VITE_IMAGE_OBJECT_URL_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_DECODED_IMAGE_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_HOVER_GRID_CACHE_LIMIT_MB": "undefined",
      "import.meta.env.VITE_PARSED_PAYLOAD_CACHE_MAX_ENTRIES": "undefined",
      "import.meta.env.DEV": "false",
    },
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function layerRef(key) {
  return { key, bytes: 100, contentType: "image/png" };
}

test("finite zero grids are available while absent/all-missing grids are not", () => {
  assert.equal(hasFiniteGridData(new Float32Array([0, 0, 0, 0]), 2, 2), true);
  assert.equal(hasFiniteGridData(new Float32Array([Number.NaN, Number.NaN, Number.NaN, Number.NaN]), 2, 2), false);
  assert.equal(hasFiniteGridData(null, 2, 2), false);
});

test("compound availability requires colocated finite support", () => {
  const at = (finiteIndex) => Float32Array.from({ length: 5 }, (_, index) => (index === finiteIndex ? 0 : Number.NaN));
  assert.equal(hasColocatedFiniteGridData([at(0), at(1), at(2), at(3), at(4)], 5, 1), false);
  assert.equal(
    hasColocatedFiniteGridData(
      Array.from({ length: 5 }, () => new Float32Array(5)),
      5,
      1,
    ),
    true,
    "finite dry-zero categorical inputs are still valid support",
  );
});

test("renderer marks missing derived fields and disjoint compound inputs unavailable", () => {
  const wanted = new Set([
    "lapseRate700to500",
    "freezingRainLiquidTotal",
    "dcape",
    "significantTornadoParameter",
    "precipRateAndType",
    "reflectivity1kmPrecipType",
  ]);
  const catalog = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => wanted.has(entry.key));
  const at = (finiteIndex) => Float32Array.from({ length: 5 }, (_, index) => (index === finiteIndex ? 0 : Number.NaN));
  const rendered = buildRenderedArtifacts({
    decoded: {
      reflectivity1km: at(0),
      precipTypeRain: at(1),
      precipTypeSnow: at(2),
      precipTypeFreezingRain: at(3),
      precipTypeIcePellets: at(4),
      precipRate: at(0),
      precipRateTypeRain: at(1),
      precipRateTypeSnow: at(2),
      precipRateTypeFreezingRain: at(3),
      precipRateTypeIcePellets: at(4),
    },
    selection: { catalog, availableParameters: [...wanted], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 5,
    height: 1,
    reflectivityGates: [15],
    pngCompressionLevel: 1,
    pngFilterType: 0,
  });

  for (const key of wanted) {
    assert.equal(rendered.parameterAvailability[key], "unavailable", `${key} must not inherit run capability`);
  }
});

test("renderer uses realized accumulation windows and never relabels raw 3-hour APCP as 1-hour", () => {
  const wanted = new Set(["temperature", "wind", "precip", "precip3h"]);
  const catalog = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => wanted.has(entry.key));
  const zero = new Float32Array([0, 0, 0, 0]);
  const decoded = {
    temperature2m: new Float32Array([273, 274, 275, 276]),
    windU10m: zero,
    windV10m: zero,
    // At long GFS leads the current APCP record may span three hours. It is a
    // valid source for precip3h but is not itself a valid precip (1-hour) grid.
    precip: new Float32Array([3, 3, 3, 3]),
  };
  applyRealizedPrecipAccumulationGrids(decoded, { precip3h: zero });

  const rendered = buildRenderedArtifacts({
    decoded,
    selection: { catalog, availableParameters: [...wanted], records: {} },
    framePlan: { hour: 123, validTime: "2026-07-16T03:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: [15],
    pngCompressionLevel: 1,
    pngFilterType: 0,
  });

  assert.equal(rendered.parameterAvailability.temperature, "available");
  assert.equal(rendered.parameterAvailability.wind, "available");
  assert.equal(rendered.parameterAvailability.precip, "unavailable");
  assert.equal(rendered.parameterAvailability.precip3h, "available");
});

test("renderer marks all-NaN accumulations, height contours, and compound inputs unavailable", () => {
  const wanted = new Set(["precip6h", "height500", "reflectivity1kmPrecipType"]);
  const catalog = NOAA_NAM_PARAMETER_CATALOG.filter((entry) => wanted.has(entry.key));
  const missing = new Float32Array([Number.NaN, Number.NaN, Number.NaN, Number.NaN]);
  const zero = new Float32Array([0, 0, 0, 0]);
  const decoded = {
    precip6h: missing,
    height500: missing,
    reflectivity1km: missing,
    precipTypeRain: zero,
    precipTypeSnow: zero,
    precipTypeFreezingRain: zero,
    precipTypeIcePellets: zero,
  };
  applyRealizedPrecipAccumulationGrids(decoded, { precip6h: missing });
  const rendered = buildRenderedArtifacts({
    decoded,
    selection: { catalog, availableParameters: [...wanted], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: [15],
    pngCompressionLevel: 1,
    pngFilterType: 0,
  });
  assert.equal(rendered.parameterAvailability.precip6h, "unavailable");
  assert.equal(rendered.parameterAvailability.height500, "unavailable");
  assert.equal(rendered.parameterAvailability.reflectivity1kmPrecipType, "unavailable");

  const finiteZeroDecoded = {
    ...decoded,
    reflectivity1km: zero,
  };
  applyRealizedPrecipAccumulationGrids(finiteZeroDecoded, { precip6h: zero });
  const finiteZero = buildRenderedArtifacts({
    decoded: finiteZeroDecoded,
    selection: { catalog, availableParameters: [...wanted], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: [15],
    pngCompressionLevel: 1,
    pngFilterType: 0,
  });
  assert.equal(finiteZero.parameterAvailability.precip6h, "available");
  assert.equal(finiteZero.parameterAvailability.reflectivity1kmPrecipType, "available");
});

test("synoptic availability distinguishes pressure guidance from thickness", () => {
  const zero = new Float32Array([0, 0, 0, 0]);
  const missing = new Float32Array([Number.NaN, Number.NaN, Number.NaN, Number.NaN]);
  const rendered = buildRenderedArtifacts({
    decoded: { pressureMsl: missing, height1000: zero, height500: new Float32Array([5400, 5400, 5400, 5400]) },
    selection: { catalog: [], availableParameters: [], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: [15],
    pngCompressionLevel: 1,
    pngFilterType: 0,
  });
  assert.equal(rendered.parameterAvailability.synoptic, "available");
  assert.equal(rendered.parameterAvailability.synopticIsobars, "unavailable");
  assert.equal(rendered.parameterAvailability.synopticThickness, "available");

  const pressureOnly = buildRenderedArtifacts({
    decoded: {
      pressureMsl: new Float32Array([101300, 101300, 101300, 101300]),
      height1000: missing,
      height500: missing,
    },
    selection: { catalog: [], availableParameters: [], records: {} },
    framePlan: { hour: 6, validTime: "2026-07-11T06:00:00Z" },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    modelKey: "gfs",
    width: 2,
    height: 2,
    reflectivityGates: [15],
    pngCompressionLevel: 1,
    pngFilterType: 0,
  });
  assert.equal(pressureOnly.parameterAvailability.synoptic, "available");
  assert.equal(pressureOnly.parameterAvailability.synopticIsobars, "available");
  assert.equal(pressureOnly.parameterAvailability.synopticThickness, "unavailable");
});

test("all-sentinel cloud ceiling is available only with conclusive all-clear cloud-cover evidence", () => {
  assert.equal(hasConclusiveNoCloudCeilingEvidence(new Float32Array([0, 10, 20, 49]), 2, 2), true);
  assert.equal(
    hasConclusiveNoCloudCeilingEvidence(new Float32Array([Number.NaN, Number.NaN, Number.NaN, Number.NaN]), 2, 2),
    false,
  );
  const entry = NOAA_NAM_PARAMETER_CATALOG.find((candidate) => candidate.key === "cloudCeiling");
  assert.ok(entry);
  const missing = new Float32Array([Number.NaN, Number.NaN, Number.NaN, Number.NaN]);
  const render = (cloudCover) =>
    buildRenderedArtifacts({
      decoded: { cloudCeiling: missing, cloudCover, profileSurfaceHeight: new Float32Array(4) },
      selection: { catalog: [entry], availableParameters: [entry.key], records: {} },
      framePlan: { hour: 3, validTime: "2026-07-11T03:00:00Z" },
      bounds: { north: 53, south: 21, west: -129, east: -63 },
      modelKey: "gfs",
      width: 2,
      height: 2,
      reflectivityGates: [15],
      pngCompressionLevel: 1,
      pngFilterType: 0,
    });
  assert.equal(render(new Float32Array([0, 10, 20, 49])).parameterAvailability.cloudCeiling, "available");
  assert.equal(render(missing).parameterAvailability.cloudCeiling, "unavailable");
});

test("dry snowfall remains available even when presentation intentionally omits its transparent layer", () => {
  const entry = NOAA_NAM_PARAMETER_CATALOG.find((candidate) => candidate.key === "snow10to1");
  assert.ok(entry);
  const dry = new Float32Array([0, 0, 0, 0]);
  assert.equal(
    snowfallEntryHasAvailableData({
      entry,
      decoded: { [snowfallDerivedGridKey(entry.key)]: dry },
      values: null,
      width: 2,
      height: 2,
    }),
    true,
  );
  assert.equal(
    snowfallEntryHasAvailableData({
      entry,
      decoded: { [SNOW_LIQUID_TOTAL_KEY]: dry },
      values: null,
      width: 2,
      height: 2,
    }),
    true,
  );
  assert.equal(
    snowfallEntryHasAvailableData({
      entry,
      decoded: { [SNOW_LIQUID_TOTAL_KEY]: new Float32Array([10, 10, 10, 10]) },
      values: null,
      width: 2,
      height: 2,
    }),
    false,
    "wet liquid with no derived result is a failed/missing method result, not dry zero",
  );
});

test("dry and trace snowfall remain numeric in raw hover even when the raster is transparent", () => {
  const entry = NOAA_NAM_PARAMETER_CATALOG.find((candidate) => candidate.key === "snow10to1");
  assert.ok(entry);
  const selection = { catalog: [entry], availableParameters: [entry.key], records: {} };
  const decoded = { [SNOW_LIQUID_TOTAL_KEY]: new Float32Array([0, 0.04]) };
  const snowfallIn = buildSnowfallInGrids({
    decoded,
    selection,
    bounds: { north: 40, south: 39, west: -100, east: -99 },
    width: 2,
    height: 1,
  });
  assert.equal(snowfallIn.snow10to1[0], 0);
  assert.ok(snowfallIn.snow10to1[1] > 0 && snowfallIn.snow10to1[1] < 0.1);

  const variables = buildHoverGridVariables({ decoded, selection, snowfallIn, width: 2, height: 1 });
  assert.equal(variables.snow10to1.validCount, 2);
  assert.equal(variables.snow10to1.values[0], 0);
  assert.ok(variables.snow10to1.values[1] > 0);
});

test("availability survives normalization, worker serialization, template merge, and base/snow partial merges", () => {
  const sourceProvenance = buildFrameSourceProvenance({
    gribUrl: "https://example.test/gfs.f003.grib2",
    idxUrl: "https://example.test/gfs.f003.grib2.idx",
    wgrib2Path: "/opt/bin/wgrib2",
    selection: { catalog: [], records: {} },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    width: 1,
    height: 1,
    renderMode: "all",
  });
  const normalized = normalizeRenderedFrameArtifacts(
    {
      hour: 3,
      validHourKey: "2026-07-11T03:00:00Z",
      parameterAvailability: { precip: "unavailable" },
      sourceProvenance,
      layers: {},
    },
    {
      hour: 3,
      validHourKey: "2026-07-11T03:00:00Z",
      rows: 1,
      cols: 1,
      layers: {},
      reflectivityVariants: {},
      reflectivityVariantsByLayer: {},
      contourVectorRefs: {},
      weatherVectorRefs: {},
    },
    [15],
  );
  assert.deepEqual(normalized.parameterAvailability, { precip: "unavailable" });
  assert.deepEqual(normalized.sourceProvenance, sourceProvenance);

  const serialized = serializeFrameArtifacts(normalized).frameArtifacts;
  assert.deepEqual(serialized.parameterAvailability, { precip: "unavailable" });
  assert.deepEqual(serialized.sourceProvenance, sourceProvenance);

  const frame = { hour: 3, rows: 1, cols: 1, layers: {}, parameterAvailability: { temperature: "available" } };
  applyRenderedFrameToManifestFrame(frame, { parameterAvailability: { precip: "unavailable" } });
  applyRenderedFrameToManifestFrame(frame, { parameterAvailability: { snow10to1: "available" } });
  assert.deepEqual(frame.parameterAvailability, {
    temperature: "available",
    precip: "unavailable",
    snow10to1: "available",
  });

  const merged = mergeManifestWithTemplate(
    {
      run: "20260711-0000Z",
      view: "conus",
      generatedAt: "old",
      frames: [frame, { hour: 6, parameterAvailability: { precip: "available" } }],
      hourStatus: { 3: "loaded", 6: "loaded" },
    },
    {
      run: "20260711-0000Z",
      view: "conus",
      generatedAt: "new",
      frames: [{ hour: 3, layers: {}, parameterAvailability: { precip: "unavailable" } }],
      hourStatus: { 3: "pending" },
    },
  );
  assert.deepEqual(merged.frames[0].parameterAvailability, frame.parameterAvailability);
  assert.deepEqual(merged.frames[1].parameterAvailability, { precip: "available" });
});

test("forensic provenance de-duplicates exact source, temporal, and run-level tool identities", () => {
  const record = {
    record: "42",
    param: "APCP",
    level: "surface",
    forecast: "0-3 hour acc fcst",
    extra: "",
    offset: 100,
    endExclusive: 250,
  };
  const precipEntry = NOAA_NAM_PARAMETER_CATALOG.find((entry) => entry.key === "precip3h");
  const earlierRecord = {
    ...record,
    record: "41",
    forecast: "0-1 hour acc fcst",
    referenceTimeToken: "d=2026071100",
    rawInventory: "41:100:d=2026071100:APCP:surface:0-1 hour acc fcst:",
    statisticalWindow: { statistic: "accumulation", startHour: 0, endHour: 1 },
    byteRange: { start: 20, endInclusive: 99 },
  };
  const currentSource = {
    id: `noaa-selected:${"a".repeat(64)}`,
    modelKey: "gfs",
    productKey: "pgrb2-0p25",
    date: "20260711",
    cycle: "00",
    forecastHour: 3,
    referenceTime: "2026-07-11T00:00:00.000Z",
    validTime: "2026-07-11T03:00:00.000Z",
    gribUrl: "https://example.test/gfs.f003.grib2",
    idxUrl: "https://example.test/gfs.f003.grib2.idx",
    selectedHash: "current-selected-hash",
    selectedSha256: "a".repeat(64),
    selectedBytes: 150,
    records: [
      {
        ...record,
        statisticalWindow: { statistic: "accumulation", startHour: 0, endHour: 3 },
        byteRange: { start: 100, endInclusive: 249 },
      },
    ],
  };
  const earlierSource = {
    ...currentSource,
    id: `noaa-selected:${"b".repeat(64)}`,
    forecastHour: 0,
    validTime: "2026-07-11T00:00:00.000Z",
    gribUrl: "https://example.test/gfs.f000.grib2",
    idxUrl: "https://example.test/gfs.f000.grib2.idx",
    selectedHash: "earlier-selected-hash",
    selectedSha256: "b".repeat(64),
    selectedBytes: 80,
    records: [earlierRecord],
  };
  const toolRef = `wgrib2-sha256:${"c".repeat(64)}`;
  const toolCatalog = buildRunSourceProvenanceCatalog({
    toolIdentity: {
      id: toolRef,
      name: "wgrib2",
      configuredPath: "/opt/bin/wgrib2",
      resolvedPath: "/opt/bin/wgrib2",
      versionOutput: "v3.8.0",
      sha256: "c".repeat(64),
    },
  });
  const base = buildFrameSourceProvenance({
    gribUrl: "https://example.test/gfs.f003.grib2",
    idxUrl: "https://example.test/gfs.f003.grib2.idx",
    toolRef,
    sourceInputs: [currentSource, currentSource, earlierSource],
    temporalDerivations: [
      {
        family: "precipitation-accumulation",
        outputKey: "precip3h",
        targetHour: 3,
        terms: [{ sourceHour: 0, role: "value", weight: 1, startHour: 0, endHour: 1, record: earlierRecord }],
      },
    ],
    selection: {
      catalog: [precipEntry],
      records: { firstWithoutRange: { ...record, endExclusive: null }, precip: record, duplicate: record },
    },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    width: 1600,
    height: 980,
    renderMode: "base",
  });
  assert.equal(base.schemaVersion, 2);
  const baseCurrentSource = base.sources.find((source) => base.currentSourceRefs.includes(source.id));
  assert.equal(baseCurrentSource.records.length, 1);
  assert.deepEqual(baseCurrentSource.records[0].byteRange, { start: 100, endInclusive: 249 });
  assert.equal(baseCurrentSource.validTime, "2026-07-11T03:00:00.000Z");
  assert.deepEqual(baseCurrentSource.records[0].statisticalWindow, {
    statistic: "accumulation",
    startHour: 0,
    endHour: 3,
  });
  assert.equal(base.source.gribUrl, "https://example.test/gfs.f003.grib2");
  assert.equal(base.methods.vectorWind, "wgrib2-new-grid-winds-earth-v1");
  assert.equal(base.toolRef, toolRef);
  assert.equal(toolCatalog.tools.length, 1, "tool identity is stored once at run scope");
  assert.equal(toolCatalog.tools[0].sha256, "c".repeat(64));
  assert.equal(base.sources.length, 2, "duplicate selected-source identities collapse");
  assert.equal(base.temporalDerivedInputs.mayUseEarlierForecastHours, true);
  assert.equal(base.temporalDerivedInputs.exactTemporalReferencesRecorded, true);
  assert.equal(base.temporalDerivedInputs.derivations[0].terms[0].sourceRef, earlierSource.id);
  assert.match(base.temporalDerivedInputs.disclosure, /SHA-256-identified selected GRIB/i);

  const snow = buildFrameSourceProvenance({
    gribUrl: base.source.gribUrl,
    idxUrl: base.source.idxUrl,
    toolRef,
    selection: {
      catalog: [{ kind: "snowfallDerived" }],
      records: {
        snow: { record: "50", param: "WEASD", level: "surface", forecast: "3 hour fcst", offset: 250 },
      },
    },
    bounds: base.targetGrid.bounds,
    width: 1600,
    height: 980,
    renderMode: "snow",
  });
  const merged = mergeFrameSourceProvenance(base, snow);
  assert.deepEqual(merged.renderModes, ["base", "snow"]);
  assert.equal(merged.currentSourceRefs.length, 2);
  assert.equal(merged.temporalDerivedInputs.exactTemporalReferencesRecorded, true);
});

test("artifact completeness skips only explicit unavailable refs and restores marker availability after a crash", async (t) => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-parameter-availability-"));
  t.after(() => fs.promises.rm(cacheRoot, { recursive: true, force: true }));
  const runtime = new LocalArtifactRuntime({ cacheRoot });
  const signature = "availability-test-v1";
  const frame = {
    hour: 3,
    rows: 1,
    cols: 1,
    layers: {
      temperature: layerRef("tiles/availability/temp-003.png"),
      precip: layerRef("tiles/availability/precip-003.png"),
    },
  };
  const markerPath = runtime.getFrameMarkerPath("gfs", "20260711-0000Z", "conus", 3);
  await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.promises.writeFile(
    markerPath,
    JSON.stringify({ rendererSignature: signature, parameterAvailability: { precip: "unavailable" } }),
  );
  const temperaturePath = runtime.getArtifactStoragePath(frame.layers.temperature.key);
  await fs.promises.mkdir(path.dirname(temperaturePath), { recursive: true });
  await fs.promises.writeFile(temperaturePath, Buffer.from([1]));

  assert.equal(
    await runtime.isFrameComplete("gfs", "20260711-0000Z", "conus", frame, {
      expectedRendererSignature: signature,
    }),
    true,
  );
  assert.deepEqual(frame.parameterAvailability, { precip: "unavailable" });
  assert.deepEqual(collectFrameArtifactKeys(frame), [frame.layers.temperature.key]);

  const legacy = { ...frame, hour: 6, parameterAvailability: null };
  const legacyMarkerPath = runtime.getFrameMarkerPath("gfs", "20260711-0000Z", "conus", 6);
  await fs.promises.mkdir(path.dirname(legacyMarkerPath), { recursive: true });
  await fs.promises.writeFile(legacyMarkerPath, JSON.stringify({ rendererSignature: signature }));
  assert.equal(
    await runtime.isFrameComplete("gfs", "20260711-0000Z", "conus", legacy, {
      expectedRendererSignature: signature,
    }),
    false,
    "legacy unknown must still require every artifact ref",
  );
});

test("split base then snow persistence writes their union to the completion marker", async (t) => {
  const cacheRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wx-split-availability-"));
  t.after(() => fs.promises.rm(cacheRoot, { recursive: true, force: true }));
  const runtime = new LocalArtifactRuntime({ cacheRoot });
  const frame = {
    hour: 3,
    validHourKey: "2026-07-11T03:00:00Z",
    rows: 1,
    cols: 1,
    layers: {},
    parameterAvailability: {},
  };
  const state = {
    modelKey: "gfs",
    runId: "20260711-0000Z",
    viewKey: "conus",
    framePlanByHour: new Map([[3, { validTime: frame.validHourKey }]]),
    latestMetadata: {
      openDataModel: "noaa-gfs-pgrb2-0p25",
      rendererSignature: "availability-test-v1",
    },
    manifest: { frames: [frame], hourStatus: {} },
    frameByHour: new Map([[3, frame]]),
    latestPointer: {},
  };
  const baseProvenance = buildFrameSourceProvenance({
    gribUrl: "https://example.test/gfs.f003.grib2",
    idxUrl: "https://example.test/gfs.f003.grib2.idx",
    wgrib2Path: "wgrib2",
    selection: {
      catalog: [],
      records: { temperature: { record: "1", param: "TMP", level: "2 m above ground", offset: 0 } },
    },
    bounds: { north: 53, south: 21, west: -129, east: -63 },
    width: 1,
    height: 1,
    renderMode: "base",
  });
  const snowProvenance = buildFrameSourceProvenance({
    gribUrl: baseProvenance.source.gribUrl,
    idxUrl: baseProvenance.source.idxUrl,
    wgrib2Path: "wgrib2",
    selection: {
      catalog: [{ kind: "snowfallDerived" }],
      records: { snow: { record: "2", param: "WEASD", level: "surface", offset: 100 } },
    },
    bounds: baseProvenance.targetGrid.bounds,
    width: 1,
    height: 1,
    renderMode: "snow",
  });
  await runtime.persistRenderedFrameForState(
    state,
    frame,
    {
      layers: {},
      parameterAvailability: { temperature: "available", precip: "unavailable" },
      sourceProvenance: baseProvenance,
      renderProfile: { sourceProvenance: baseProvenance, stages: {} },
    },
    { partialFrame: true },
  );
  await runtime.persistRenderedFrameForState(state, frame, {
    layers: {},
    parameterAvailability: { snow10to1: "available" },
    sourceProvenance: snowProvenance,
    renderProfile: { sourceProvenance: snowProvenance, stages: {} },
  });

  const marker = JSON.parse(
    await fs.promises.readFile(runtime.getFrameMarkerPath("gfs", state.runId, "conus", 3), "utf8"),
  );
  assert.deepEqual(marker.parameterAvailability, {
    temperature: "available",
    precip: "unavailable",
    snow10to1: "available",
  });
  assert.deepEqual(frame.parameterAvailability, marker.parameterAvailability);
  assert.deepEqual(marker.sourceProvenance.renderModes, ["base", "snow"]);
  assert.equal(marker.sourceProvenance.currentSourceRefs.length, 2);
  assert.equal(marker.renderProfile.sourceProvenance, undefined, "marker stores one provenance copy, not two");
  assert.equal(marker.sourceProvenance.temporalDerivedInputs.exactTemporalReferencesRecorded, false);
});

test("client resolvers and active-frame status reject explicit unavailable placeholders but preserve legacy fallback", () => {
  const layerRefs = bundleTs("next/src/core/layer-refs.ts");
  const frameStatus = bundleTs("next/src/components/map-panel/use-frame-status.ts");
  const base = {
    hour: 3,
    validHourKey: "2026-07-11T03:00:00Z",
    layers: {
      precip: layerRef("tiles/availability/precip-003.png"),
      temperature: layerRef("tiles/availability/temperature-003.png"),
      synoptic: layerRef("tiles/availability/synoptic-003.png"),
    },
    contourVectorRefs: { precip: layerRef("vectors/availability/precip-003.json") },
    weatherVectorRefs: { precip: layerRef("vectors/availability/weather-003.json") },
    synopticVectorKeys: { simple: "vectors/availability/synoptic-003.json" },
    synopticVectorBytes: { simple: 100 },
  };
  const unavailable = {
    ...base,
    parameterAvailability: { precip: "unavailable", synoptic: "unavailable" },
  };
  assert.equal(layerRefs.resolveLayerRequestUrl(unavailable, "precip"), null);
  assert.equal(layerRefs.resolveContourVectorRequestUrl(unavailable, "precip"), null);
  assert.equal(layerRefs.resolveWeatherVectorRequestUrl(unavailable, "precip"), null);
  assert.equal(layerRefs.resolveSynopticVectorKey(unavailable), null);
  assert.equal(layerRefs.resolveSynopticVectorRequestUrl(unavailable), null);

  const statuses = frameStatus.buildBrowserHourStatus(
    new Map([[3, unavailable]]),
    { hourStatus: { 3: "loaded" } },
    {},
    new Set(["precip"]),
    15,
    "simple",
  );
  assert.equal(statuses[3], "unavailable");

  const mixedLayerStatus = frameStatus.buildBrowserHourStatus(
    new Map([
      [
        3,
        {
          ...base,
          parameterAvailability: { precip: "unavailable", temperature: "available" },
        },
      ],
    ]),
    { hourStatus: { 3: "loaded" } },
    {},
    new Set(["precip", "temperature"]),
    15,
    "simple",
  );
  assert.notEqual(mixedLayerStatus[3], "unavailable", "one unavailable layer must not dim renderable siblings");

  const partialSynoptic = {
    ...base,
    parameterAvailability: {
      synoptic: "available",
      synopticIsobars: "unavailable",
      synopticThickness: "available",
    },
  };
  assert.equal(
    frameStatus.buildBrowserHourStatus(
      new Map([[3, partialSynoptic]]),
      { hourStatus: { 3: "loaded" } },
      {},
      new Set(["synoptic"]),
      15,
      "simple",
      { showCenters: false, showIsobars: true, showThickness: false },
    )[3],
    "unavailable",
  );
  assert.notEqual(
    frameStatus.buildBrowserHourStatus(
      new Map([[3, partialSynoptic]]),
      { hourStatus: { 3: "loaded" } },
      {},
      new Set(["synoptic"]),
      15,
      "simple",
      { showCenters: false, showIsobars: false, showThickness: true },
    )[3],
    "unavailable",
  );
  assert.notEqual(
    frameStatus.buildBrowserHourStatus(
      new Map([[3, partialSynoptic]]),
      { hourStatus: { 3: "loaded" } },
      {},
      new Set(["synoptic"]),
      15,
      "simple",
      { showCenters: false, showIsobars: true, showThickness: true },
    )[3],
    "unavailable",
    "an unavailable synoptic component must not hide a selected available component",
  );

  const legacy = { ...base, parameterAvailability: null };
  assert.match(layerRefs.resolveLayerRequestUrl(legacy, "precip"), /precip-003\.png/);
  assert.match(layerRefs.resolveContourVectorRequestUrl(legacy, "precip"), /precip-003\.json/);
  assert.notEqual(
    frameStatus.buildBrowserHourStatus(
      new Map([[3, legacy]]),
      { hourStatus: { 3: "loaded" } },
      {},
      new Set(["precip"]),
      15,
      "simple",
    )[3],
    "unavailable",
  );
});
