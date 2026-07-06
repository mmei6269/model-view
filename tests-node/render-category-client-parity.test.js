"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");
const {
  GROUP_TO_CATEGORY: SERVER_GROUP_TO_CATEGORY,
  RENDER_CATEGORY_IDS: SERVER_CATEGORY_IDS,
} = require("../scripts/lib/noaa-nam-parameter-catalog.js");

// Transpile the client-side TS mirror with esbuild (already a dependency) and evaluate it in a
// throwaway CJS module context so the node test can read the exact map the browser bundle ships.
function loadClientModule() {
  const source = fs.readFileSync(path.join(__dirname, "..", "next", "src", "config", "renderCategories.ts"), "utf8");
  const { code } = esbuild.transformSync(source, { loader: "ts", format: "cjs" });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${code}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

test("client GROUP_TO_CATEGORY matches the server catalog exactly", () => {
  const client = loadClientModule();
  assert.deepEqual(client.GROUP_TO_CATEGORY, { ...SERVER_GROUP_TO_CATEGORY });
});

test("client RENDER_CATEGORY_IDS matches the server order", () => {
  const client = loadClientModule();
  assert.deepEqual([...client.RENDER_CATEGORY_IDS], [...SERVER_CATEGORY_IDS]);
});

test("groupToRenderCategory returns the mapped category and null for unknown groups", () => {
  const client = loadClientModule();
  for (const [group, category] of Object.entries(SERVER_GROUP_TO_CATEGORY)) {
    assert.equal(client.groupToRenderCategory(group), category);
  }
  assert.equal(client.groupToRenderCategory("Not A Real Group"), null);
  assert.equal(client.groupToRenderCategory(null), null);
  assert.equal(client.groupToRenderCategory(undefined), null);
});
