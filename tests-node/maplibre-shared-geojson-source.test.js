"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

function loadModule() {
  const entry = path.join(__dirname, "..", "next", "src", "core", "map-engine", "shared-geojson-source.ts");
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    write: false,
    logLevel: "silent",
  });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${outputFiles[0].text}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

function collection(id) {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { id }, geometry: null }],
  };
}

function fakeHost() {
  const sources = new Map();
  const calls = { add: [], remove: [], setData: [] };
  return {
    calls,
    sources,
    host: {
      addSource(id, data) {
        assert.equal(sources.has(id), false, `duplicate addSource for ${id}`);
        sources.set(id, data);
        calls.add.push([id, data]);
      },
      setData(id, data) {
        assert.equal(sources.has(id), true, `setData before addSource for ${id}`);
        sources.set(id, data);
        calls.setData.push([id, data]);
      },
      removeSource(id) {
        assert.equal(sources.delete(id), true, `removeSource for missing ${id}`);
        calls.remove.push(id);
      },
    },
  };
}

test("one family adds one source and updates it once per collection identity", () => {
  const { SharedGeoJsonSourceRegistry } = loadModule();
  const registry = new SharedGeoJsonSourceRegistry();
  const fake = fakeHost();
  const first = collection("first");
  const second = collection("second");

  registry.attach("synoptic", "line:minor", first, fake.host);
  registry.attach("synoptic", "line:major", first, fake.host);
  registry.attach("synoptic", "symbol:labels", first, fake.host);
  assert.equal(fake.sources.size, 1);
  assert.equal(fake.calls.add.length, 1);
  assert.equal(fake.calls.setData.length, 0);

  registry.attach("synoptic", "line:minor", second, fake.host);
  registry.attach("synoptic", "line:major", second, fake.host);
  registry.attach("synoptic", "symbol:labels", second, fake.host);
  assert.equal(fake.calls.setData.length, 1);
  assert.equal(fake.calls.setData[0][1], second);
});

test("a shared source survives member removal and disappears after the final member", () => {
  const { SharedGeoJsonSourceRegistry } = loadModule();
  const registry = new SharedGeoJsonSourceRegistry();
  const fake = fakeHost();
  const data = collection("frame");

  registry.attach("height500", "line:minor", data, fake.host);
  registry.attach("height500", "symbol:labels", data, fake.host);
  registry.release("height500", "line:minor", fake.host);
  assert.equal(fake.sources.size, 1);
  assert.equal(fake.calls.remove.length, 0);
  registry.release("height500", "symbol:labels", fake.host);
  assert.equal(fake.sources.size, 0);
  assert.equal(fake.calls.remove.length, 1);
});

test("style recreation re-adds each family once with its current data", () => {
  const { SharedGeoJsonSourceRegistry } = loadModule();
  const registry = new SharedGeoJsonSourceRegistry();
  const firstHost = fakeHost();
  const recreatedHost = fakeHost();
  const data = collection("frame");

  registry.attach("synoptic", "line:minor", data, firstHost.host);
  registry.attach("synoptic", "symbol:labels", data, firstHost.host);
  registry.markUnadded();
  registry.ensure("synoptic", recreatedHost.host);
  registry.ensure("synoptic", recreatedHost.host);
  assert.equal(recreatedHost.sources.size, 1);
  assert.equal(recreatedHost.calls.add.length, 1);
  assert.equal(recreatedHost.calls.add[0][1], data);
});

test("conflicting collection references in one family pass fail loudly", () => {
  const { SharedGeoJsonSourceRegistry } = loadModule();
  const registry = new SharedGeoJsonSourceRegistry();
  const fake = fakeHost();
  const first = collection("first");

  registry.attach("synoptic", "line:minor", first, fake.host);
  assert.throws(
    () => registry.attach("synoptic", "line:major", collection("conflict"), fake.host),
    /conflicting FeatureCollection references/,
  );
  assert.equal(fake.calls.setData.length, 0);

  const registryWithExistingMembers = new SharedGeoJsonSourceRegistry();
  registryWithExistingMembers.attach("height", "line:minor", first, fake.host);
  registryWithExistingMembers.attach("height", "line:major", first, fake.host);
  const next = collection("next");
  registryWithExistingMembers.attach("height", "line:minor", next, fake.host);
  assert.throws(
    () => registryWithExistingMembers.attach("height", "line:major", collection("same-pass-conflict"), fake.host),
    /conflicting FeatureCollection references/,
  );
});

test("filtered symbol counts remain per layer over a combined family collection", () => {
  const { countFilteredGeoJsonFeatures } = loadModule();
  const combined = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { kind: "high" }, geometry: null },
      { type: "Feature", properties: { kind: "low" }, geometry: null },
      { type: "Feature", properties: { kind: "high" }, geometry: null },
    ],
  };
  assert.equal(countFilteredGeoJsonFeatures(combined, ["==", ["get", "kind"], "high"]), 2);
  assert.equal(countFilteredGeoJsonFeatures(combined, ["==", ["get", "kind"], "low"]), 1);
  assert.equal(countFilteredGeoJsonFeatures(combined, ["==", ["get", "kind"], "__hidden__"]), 0);
});
