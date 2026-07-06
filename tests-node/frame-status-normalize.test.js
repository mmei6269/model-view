"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

function loadUseFrameStatus() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "next", "src", "components", "map-panel", "use-frame-status.ts"),
    "utf8",
  );
  const { code } = esbuild.transformSync(source, { loader: "ts", format: "cjs" });
  const moduleShim = { exports: {} };
  const stubRequire = (specifier) => {
    if (specifier === "react") return { useMemo: (fn) => fn() };
    return {};
  };
  const fn = new vm.Script(`(function (module, exports, require) { ${code}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, stubRequire);
  return moduleShim.exports;
}

test("normalizeFrameHourStatus passes the five valid states through", () => {
  const { normalizeFrameHourStatus } = loadUseFrameStatus();
  for (const value of ["loaded", "loading", "error", "pending", "unavailable"]) {
    assert.equal(normalizeFrameHourStatus(value), value);
  }
});

test("normalizeFrameHourStatus coerces unknown/empty values to pending", () => {
  const { normalizeFrameHourStatus } = loadUseFrameStatus();
  for (const value of [undefined, null, "", "loaded ", "LOADED", "ready", 3, {}]) {
    assert.equal(normalizeFrameHourStatus(value), "pending");
  }
});
