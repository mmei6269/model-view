"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");
const { getNoaaNamParameterMetadata } = require("../scripts/lib/noaa-nam-parameter-catalog");

function loadModule(relativePath) {
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", "next", "src", relativePath)],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
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

test("early rolling-accumulation legends identify the actual run-to-frame window", () => {
  const { getFrameAwareLayerLegendConfig } = loadModule("config/layers.ts");
  const manifest = {
    parameters: {
      precip24h: {
        key: "precip24h",
        label: "24-h Precip",
        unit: "in",
        accumulationMode: "rolling",
        accumulationWindowHours: 24,
        legendTicks: [0.01, 1, 4],
        legendTickPositions: [0, 0.5, 1],
      },
    },
  };
  const partial = getFrameAwareLayerLegendConfig("precip24h", manifest, 12);
  const full = getFrameAwareLayerLegendConfig("precip24h", manifest, 24);
  assert.match(partial.label, /Run-to-F012 Precip \(0-12 h\)/);
  assert.match(partial.thresholdNote, /Partial 24-h window/);
  assert.equal(full.label, "24-h Precip");
});

test("cloud-ceiling hover distinguishes a supported no-ceiling state from unavailable", () => {
  const { describeMissingHoverValue } = loadModule("components/map-panel/hover-utils.ts");
  assert.equal(describeMissingHoverValue("cloudCeiling", { cloudCeiling: null, cloudCover: 42 }), "No ceiling");
  assert.equal(describeMissingHoverValue("cloudCeiling", { cloudCeiling: null, cloudCover: null }), null);
  assert.equal(describeMissingHoverValue("cloudCeiling", { cloudCeiling: null, cloudCover: 75 }), null);
});

test("sounding ceiling fallback uses an unambiguous unavailable message", () => {
  const { formatPointCloudCeiling } = loadModule("components/SoundingDrawer.tsx");
  assert.equal(
    formatPointCloudCeiling({ cloudCeilingState: "unavailable" }),
    "Unavailable (ceiling state could not be established)",
  );
});

test("catalog transparency metadata matches the deliberate rate threshold and state/datum semantics", () => {
  const metadata = getNoaaNamParameterMetadata();
  assert.match(metadata.precipRateAndType.thresholdNote, /0\.02 in\/hr/);
  assert.equal(metadata.cloudCeiling.label, "Cloud Ceiling (AGL)");
  assert.equal(metadata.wetBulbZeroHeight.label, "Wet-Bulb Zero (MSL)");
  assert.equal(metadata.snowDepth.label, "Snow Depth (State)");
  assert.match(metadata.snowKuchera.derivation, /3-50:1/);
  assert.match(metadata.effectiveLayerSignificantTornadoParameter.derivation, /90-mb.*100-mb/);
});

test("physical precipitation-rate legends retain the open-ended top color as an endpoint cap", () => {
  const { buildPhysicalRateLegend } = loadModule("components/map-panel/legend-utils.ts");
  const topColor = [1, 2, 3, 1];
  const scale = buildPhysicalRateLegend({
    key: "rain",
    label: "Rain",
    tickLabels: [0.02, 0.5],
    bins: [
      { label: "0.02", minRate: 0.02, maxRate: 0.1, color: [10, 20, 30, 1] },
      { label: "0.1", minRate: 0.1, maxRate: 0.5, color: [40, 50, 60, 1] },
      { label: "0.5+", minRate: 0.5, maxRate: null, color: topColor },
    ],
  });
  assert.ok(scale);
  assert.equal(scale.domainEnd, 0.5);
  assert.deepEqual(scale.endCap.color, topColor);
  assert.equal(scale.tickPositions.at(-1), 1);
});

test("cross-panel hover broadcasts carry run and valid-time identity", () => {
  const hoverBus = loadModule("core/hover-bus.ts");
  const broadcast = {
    sourcePanelId: "panel-1",
    sourceModelLabel: "GFS",
    sourceRunId: "20260711-0000Z",
    sourceValidTimeIso: "2026-07-11T12:00:00Z",
    lat: 39,
    lon: -95,
    values: { temperature: 80 },
    pressureHpa: 1012,
  };
  hoverBus.publishHover(broadcast);
  assert.deepEqual(hoverBus.getHoverBroadcast(), broadcast);
  assert.equal(hoverBus.clearHoverBroadcastIfOwnedBy("panel-2"), false, "another panel cannot clear the owner");
  assert.equal(hoverBus.clearHoverBroadcastIfOwnedBy("panel-1"), true, "unmount/mouseout clears the owning panel");
  assert.equal(hoverBus.getHoverBroadcast(), null);
});

test("selected unavailable layers produce a visible analyst-facing label", () => {
  const { getUnavailableActiveLayerLabels } = loadModule("components/map-panel/use-panel-chrome-data.ts");
  const labels = getUnavailableActiveLayerLabels(
    new Set(["precip", "temperature"]),
    {
      hour: 123,
      parameterAvailability: { precip: "unavailable", temperature: "available" },
      layers: {},
    },
    null,
    null,
  );
  assert.deepEqual(labels, ["1-h Precip"]);
});

test("unavailable synoptic components are named independently", () => {
  const { getUnavailableActiveLayerLabels } = loadModule("components/map-panel/use-panel-chrome-data.ts");
  const labels = getUnavailableActiveLayerLabels(
    new Set(["synoptic"]),
    {
      hour: 12,
      parameterAvailability: {
        synoptic: "available",
        synopticIsobars: "unavailable",
        synopticThickness: "available",
      },
      layers: {},
    },
    null,
    { showCenters: true, showIsobars: true, showThickness: true },
  );
  assert.deepEqual(labels, ["Surface pressure isobars/centers"]);
});

test("convective heuristic never downgrades outcome-changing missing inputs to LOW", () => {
  const { deriveHazardSignal } = loadModule("components/SoundingDrawer.tsx");
  const incomplete = deriveHazardSignal({
    sbcapeJkg: 1200,
    shear0to6kmKt: 40,
    srh0to1kmM2S2: 200,
    supercellCompositeEffective: 0,
    maxHailSizeIn: 0,
  });
  assert.equal(incomplete.label, "N/A", "missing STP could change the highest category");

  const completeLow = deriveHazardSignal({
    sbcapeJkg: 100,
    shear0to6kmKt: 10,
    significantTornadoEffective: 0,
    supercellCompositeEffective: 0,
    srh0to1kmM2S2: 0,
    maxHailSizeIn: 0,
  });
  assert.equal(completeLow.label, "LOW");

  const severeWithoutHail = deriveHazardSignal({
    sbcapeJkg: 1200,
    shear0to6kmKt: 35,
    significantTornadoEffective: 0,
    supercellCompositeEffective: 0,
    srh0to1kmM2S2: 0,
  });
  assert.equal(severeWithoutHail.label, "SVR", "known CAPE/shear severe signal makes missing hail irrelevant");

  const tornado = deriveHazardSignal({
    sbcapeJkg: 1500,
    shear0to6kmKt: 40,
    srh0to1kmM2S2: 150,
    significantTornadoEffective: 2.5,
    supercellCompositeEffective: 5,
    maxHailSizeIn: 0,
  });
  assert.equal(tornado.label, "TOR");

  const irrelevantMissingComposites = deriveHazardSignal({
    sbcapeJkg: 100,
    shear0to6kmKt: 10,
    maxHailSizeIn: 0,
  });
  assert.equal(irrelevantMissingComposites.label, "LOW", "known low CAPE/shear makes missing STP/SCP/SRH irrelevant");

  const hailCouldChangeOutcome = deriveHazardSignal({
    sbcapeJkg: 100,
    shear0to6kmKt: 10,
    significantTornadoEffective: 0,
    supercellCompositeEffective: 0,
    srh0to1kmM2S2: 0,
  });
  assert.equal(hailCouldChangeOutcome.label, "N/A", "missing hail could still establish the SVR category");

  const gfsWithoutImpossibleHail = deriveHazardSignal(
    {
      sbcapeJkg: 100,
      shear0to6kmKt: 10,
      significantTornadoEffective: 0,
      supercellCompositeEffective: 0,
      srh0to1kmM2S2: 0,
    },
    "gfs",
  );
  assert.equal(gfsWithoutImpossibleHail.label, "LOW", "GFS omits its unavailable hail-only branch");
  assert.match(gfsWithoutImpossibleHail.detail, /missing hail was not required/i);

  const hrrrWithoutExpectedHail = deriveHazardSignal(
    {
      sbcapeJkg: 100,
      shear0to6kmKt: 10,
      significantTornadoEffective: 0,
      supercellCompositeEffective: 0,
      srh0to1kmM2S2: 0,
    },
    "hrrr",
  );
  assert.equal(hrrrWithoutExpectedHail.label, "N/A", "HRRR hail remains an expected, outcome-changing input");

  const nam3kmWithoutUndefinedHail = deriveHazardSignal(
    {
      sbcapeJkg: 100,
      shear0to6kmKt: 10,
      significantTornadoEffective: 0,
      supercellCompositeEffective: 0,
      srh0to1kmM2S2: 0,
    },
    "nam3km",
  );
  assert.equal(nam3kmWithoutUndefinedHail.label, "LOW", "NAM3km has no simulated-hail source in its roster");

  const gfsWithProvidedHail = deriveHazardSignal(
    {
      sbcapeJkg: 100,
      shear0to6kmKt: 10,
      significantTornadoEffective: 0,
      supercellCompositeEffective: 0,
      srh0to1kmM2S2: 0,
      maxHailSizeIn: 1.25,
    },
    "gfs",
  );
  assert.equal(gfsWithProvidedHail.label, "SVR", "finite hail is evaluated even when its model may omit missing hail");

  const futureModelWithoutHail = deriveHazardSignal(
    {
      sbcapeJkg: 100,
      shear0to6kmKt: 10,
      significantTornadoEffective: 0,
      supercellCompositeEffective: 0,
      srh0to1kmM2S2: 0,
    },
    "future-model",
  );
  assert.equal(futureModelWithoutHail.label, "N/A", "unknown models receive no missing-hail exemption");
});

test("unresolved point-wind metadata is disclosed as suppressed, never as no rotation required", () => {
  const { formatWindReference } = loadModule("components/SoundingDrawer.tsx");
  const text = formatWindReference({
    windReference: {
      sourceFrame: "unknown",
      outputFrame: "unknown",
      projection: "unknown",
      rotationApplied: false,
    },
  });
  assert.match(text, /unresolved reference; profile-wind diagnostics suppressed/i);
  assert.doesNotMatch(text, /no rotation required/i);
});

test("pressure-only sounding rows never fabricate AGL from the lowest pressure level", () => {
  const { profileLevelsWithAgl } = loadModule("components/SoundingDrawer.tsx");
  const levels = [
    { source: "pressure", press: 900, hght: 1200, temp: 10, dwpt: 5 },
    { source: "pressure", press: 800, hght: 2200, temp: 4, dwpt: 0 },
  ];
  const unresolved = profileLevelsWithAgl(levels, null);
  assert.equal(
    unresolved.every((level) => Number.isNaN(level.heightAglM)),
    true,
  );
  const fromSurfaceSummary = profileLevelsWithAgl(levels, 700);
  assert.deepEqual(
    fromSurfaceSummary.map((level) => level.heightAglM),
    [500, 1500],
  );
});
