"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

// Transpile the client-side TS hook with esbuild and evaluate it in a throwaway CJS module
// context (same pattern as render-category-client-parity.test.js) so the node test exercises
// the exact guard the browser bundle ships. isEditableTarget must stay DOM-shape-duck-typed
// so it evaluates in a bare vm without jsdom.
function loadHookModule() {
  const source = fs.readFileSync(path.join(__dirname, "..", "next", "src", "hooks", "useKeyboardShortcuts.ts"), "utf8");
  const { code } = esbuild.transformSync(source, { loader: "ts", format: "cjs" });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${code}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

test("isEditableTarget is true for typing surfaces", () => {
  const { isEditableTarget } = loadHookModule();
  assert.equal(isEditableTarget({ tagName: "INPUT" }), true);
  assert.equal(isEditableTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditableTarget({ tagName: "SELECT" }), true);
  assert.equal(isEditableTarget({ isContentEditable: true }), true);
});

test("isEditableTarget is false for non-editable targets", () => {
  const { isEditableTarget } = loadHookModule();
  assert.equal(isEditableTarget({ tagName: "DIV" }), false);
  assert.equal(isEditableTarget(null), false);
});

test("isInteractiveTarget duck-types on Element.closest", () => {
  const { isInteractiveTarget } = loadHookModule();
  assert.equal(isInteractiveTarget({ closest: () => ({}) }), true);
  assert.equal(isInteractiveTarget({ closest: () => null }), false);
  assert.equal(isInteractiveTarget({}), false);
  assert.equal(isInteractiveTarget(null), false);
});
