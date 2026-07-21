"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildPointSoundingDirectDiagnostics,
  calculatePointScp,
  normalizePointSoundingLevel,
  parsePointSoundingGridDefinition,
  pointSoundingValueKey,
  resolvePointSoundingWindRotation,
  rotatePointSoundingWindComponents,
  windComponentsToMeteorological,
} = require("../scripts/lib/noaa-beta/point-sounding");
const { selectPointSoundingRecords } = require("../scripts/lib/noaa-beta/selection");

test("calm wind components produce no meteorological direction", () => {
  const calm = windComponentsToMeteorological(0, 0);
  assert.equal(calm.wspd, 0);
  assert.equal(calm.uKt, 0);
  assert.equal(calm.vKt, 0);
  assert.equal(Number.isNaN(calm.wdir), true);
});

test("calm wind serializes as null direction and zero speed", () => {
  const level = normalizePointSoundingLevel({
    source: "surface",
    press: 1000,
    hght: 10,
    temp: 20,
    dwpt: 15,
    rh: 73,
    ...windComponentsToMeteorological(0, 0),
  });
  assert.equal(level.wdir, null);
  assert.equal(level.wspd, 0);
  assert.equal(level.uKt, 0);
  assert.equal(level.vKt, 0);
});

test("non-calm wind directions are unchanged", () => {
  const north = windComponentsToMeteorological(0, -5);
  assert.equal(north.wdir, 0);
  assert.ok(Math.abs(north.wspd - 5 * 1.943844) < 1e-2);
  assert.equal(north.vKt, -north.wspd);
  const east = windComponentsToMeteorological(-5, 0);
  assert.equal(east.wdir, 90);
  const south = windComponentsToMeteorological(0, 5);
  assert.equal(south.wdir, 180);
  const west = windComponentsToMeteorological(5, 0);
  assert.equal(west.wdir, 270);
});

test("Lambert grid-relative point winds rotate to earth-relative components", () => {
  const definition = parsePointSoundingGridDefinition(`
1:0:grid_template=30:winds(grid):
  Lambert Conformal: (1799 x 1059) input WE:SN output WE:SN res 56
  Lat1 21.138000 Lon1 237.280000 LoV 262.500000
  LatD 38.500000 Latin1 38.500000 Latin2 38.500000
`);
  assert.equal(definition.windFrame, "grid");
  assert.equal(definition.rotationSupported, true);
  assert.ok(Math.abs(definition.centralLongitudeDeg - -97.5) < 1e-9);
  const rotation = resolvePointSoundingWindRotation(definition, -124.992859);
  assert.equal(rotation.applied, true);
  assert.ok(Math.abs(rotation.angleDeg - -17.123) < 0.02);
  const earth = rotatePointSoundingWindComponents(-0.888002, -10.3919, rotation);
  assert.ok(Math.abs(earth.u - 2.214) < 0.01);
  assert.ok(Math.abs(earth.v - -10.188) < 0.02);
  const sourceSpeed = Math.hypot(-0.888002, -10.3919);
  assert.ok(Math.abs(Math.hypot(earth.u, earth.v) - sourceSpeed) < 1e-9);
});

test("earth-relative point winds pass through without rotation", () => {
  const definition = parsePointSoundingGridDefinition("1:0:grid_template=0:winds(earth): latitude-longitude grid");
  const rotation = resolvePointSoundingWindRotation(definition, -100);
  assert.equal(rotation.applied, false);
  assert.deepEqual(rotatePointSoundingWindComponents(4, -7, rotation), { u: 4, v: -7 });
});

test("wgrib2 winds(N/S) is recognized as earth-relative", () => {
  const definition = parsePointSoundingGridDefinition("1:0:grid_template=0:winds(N/S): lat-lon grid: (1440 x 721)");
  assert.equal(definition.windFrame, "earth");
  assert.equal(definition.projection, "latitude-longitude");
  assert.equal(definition.rotationSupported, true);
  const rotation = resolvePointSoundingWindRotation(definition, -100);
  assert.equal(rotation.sourceFrame, "earth");
  assert.equal(rotation.outputFrame, "earth-relative");
  assert.equal(rotation.applied, false);
});

test("unknown wind-reference metadata fails closed instead of contaminating sounding kinematics", () => {
  const definition = parsePointSoundingGridDefinition("grid metadata without a winds reference token");
  const rotation = resolvePointSoundingWindRotation(definition, -100);
  assert.equal(rotation.outputFrame, "unknown");
  const wind = rotatePointSoundingWindComponents(12, -8, rotation);
  assert.equal(Number.isNaN(wind.u), true);
  assert.equal(Number.isNaN(wind.v), true);
});

test("point ceiling handling distinguishes no-ceiling sentinel and model datum", () => {
  const values = new Map();
  values.set(pointSoundingValueKey("HGT", "cloud ceiling"), 20000);
  values.set(pointSoundingValueKey("TCDC", "entire atmosphere"), 20);
  const noCeiling = buildPointSoundingDirectDiagnostics(values, { hght: 1500 }, { modelKey: "nam3km" });
  assert.equal(noCeiling.cloudCeilingState, "none");
  assert.equal(Number.isNaN(noCeiling.cloudCeilingM), true);

  values.set(pointSoundingValueKey("HGT", "cloud ceiling"), 2500);
  values.set(pointSoundingValueKey("TCDC", "entire atmosphere"), 80);
  const nam = buildPointSoundingDirectDiagnostics(values, { hght: 1500 }, { modelKey: "nam3km" });
  const hrrr = buildPointSoundingDirectDiagnostics(values, { hght: 1500 }, { modelKey: "hrrr" });
  assert.equal(nam.cloudCeilingM, 1000);
  assert.equal(hrrr.cloudCeilingM, 2500);

  // Production surface rows come from normalizePointSoundingLevel, which
  // stores missing HGT:surface as null — pass that shape, not {}, so a
  // Number(null) === 0 coercion cannot slip through as fabricated terrain.
  values.set(pointSoundingValueKey("HGT", "level of adiabatic condensation from sfc"), 1800);
  const namMissingTerrain = buildPointSoundingDirectDiagnostics(values, { hght: null }, { modelKey: "nam3km" });
  const hrrrMissingTerrain = buildPointSoundingDirectDiagnostics(values, { hght: null }, { modelKey: "hrrr" });
  assert.equal(namMissingTerrain.cloudCeilingState, "unavailable", "MSL ceiling cannot be labeled AGL without terrain");
  assert.equal(Number.isNaN(namMissingTerrain.cloudCeilingM), true);
  assert.equal(Number.isNaN(namMissingTerrain.lclM), true, "MSL LCL cannot be labeled AGL without terrain");
  assert.equal(hrrrMissingTerrain.cloudCeilingState, "reported", "native HRRR AGL ceiling does not require terrain");
  assert.equal(hrrrMissingTerrain.cloudCeilingM, 2500);
  assert.equal(Number.isNaN(hrrrMissingTerrain.lclM), true, "MSL LCL cannot be labeled AGL without terrain");
});

test("point sounding selection retains total cloud cover for independent no-ceiling truth", () => {
  const selected = selectPointSoundingRecords([
    {
      record: "1",
      param: "TCDC",
      level: "entire atmosphere",
      forecast: "6 hour fcst",
      extra: "",
      line: "1:0:d=2026071100:TCDC:entire atmosphere:6 hour fcst:",
    },
    {
      record: "2",
      param: "HGT",
      level: "cloud ceiling",
      forecast: "6 hour fcst",
      extra: "",
      line: "2:100:d=2026071100:HGT:cloud ceiling:6 hour fcst:",
    },
  ]);
  assert.equal(selected.records.directCloudCover?.record, "1");
  assert.equal(selected.records.directCloudCeiling?.record, "2");
});

test("point UH rejects only the finite -999 missing sentinel", () => {
  const values = new Map();
  values.set(pointSoundingValueKey("MXUPHL", "5000-2000 m above ground"), -999);
  const missing = buildPointSoundingDirectDiagnostics(values, { hght: 0 }, { modelKey: "nam3km" });
  assert.equal(Number.isNaN(missing.updraftHelicity2to5kmM2S2), true);
  values.set(pointSoundingValueKey("MXUPHL", "5000-2000 m above ground"), -10);
  const legitimate = buildPointSoundingDirectDiagnostics(values, { hght: 0 }, { modelKey: "nam3km" });
  assert.equal(legitimate.updraftHelicity2to5kmM2S2, -10);
});

test("effective SCP applies the current SPC MUCIN term while proxy SCP does not", () => {
  const inputs = { mucapeJkg: 2000, srh0to3kmM2S2: 100, effectiveBulkShearKt: 20 * 1.943844 };
  assert.ok(Math.abs(calculatePointScp(inputs) - 4) < 1e-9);
  assert.ok(Math.abs(calculatePointScp({ ...inputs, mucinJkg: -100, applyCinTerm: true }) - 1.6) < 1e-9);
  assert.ok(Math.abs(calculatePointScp({ ...inputs, mucinJkg: -250, applyCinTerm: true }) - 0.64) < 1e-9);
  assert.equal(Number.isNaN(calculatePointScp({ ...inputs, applyCinTerm: true })), true);
});
