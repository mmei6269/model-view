"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const esbuild = require("esbuild");

// Transpile the pure helper with esbuild and evaluate it in a throwaway CJS
// module context (same pattern as keyboard-shortcut-guard.test.js) so the node
// test exercises the exact code the browser bundle ships.
function loadHelperModule() {
  const source = fs.readFileSync(path.join(__dirname, "..", "next", "src", "core", "humanize-error.ts"), "utf8");
  const { code } = esbuild.transformSync(source, { loader: "ts", format: "cjs" });
  const moduleShim = { exports: {} };
  const fn = new vm.Script(`(function (module, exports, require) { ${code}\n})`).runInThisContext();
  fn(moduleShim, moduleShim.exports, require);
  return moduleShim.exports;
}

test("collapses a multi-URL fetch dump into one short URL-free sentence", () => {
  const { humanizeArtifactError } = loadHelperModule();
  const raw = "Failed to fetch https://a/x.json\nhttps://a/y.json\nhttps://a/z.json";
  const result = humanizeArtifactError(raw);
  assert.equal(typeof result, "string");
  assert.ok(result.trim().length > 0, "must be non-empty");
  assert.ok(!/https?:\/\//i.test(result), `must not contain raw URLs: ${result}`);
  assert.ok(!result.includes("\n"), "must be a single line");
  assert.ok(result.length <= 120, `must be a short sentence, got length ${result.length}`);
});

test("maps an AbortError-shaped input to a cancelled-style message", () => {
  const { humanizeArtifactError } = loadHelperModule();
  const abortError = Object.assign(new Error("The user aborted a request."), { name: "AbortError" });
  assert.match(humanizeArtifactError(abortError), /cancel/i);
});

test("maps TypeError: Failed to fetch to a network-style message", () => {
  const { humanizeArtifactError } = loadHelperModule();
  const result = humanizeArtifactError(new TypeError("Failed to fetch"));
  assert.match(result, /network|reach|connect/i);
  assert.ok(!/https?:\/\//i.test(result));
});

test("maps a 404 status message to a friendly not-available message", () => {
  const { humanizeArtifactError } = loadHelperModule();
  const result = humanizeArtifactError(
    new Error("Request failed (404): https://example.com/manifests/gfs/latest.json"),
  );
  assert.match(result, /not available|isn't available|missing/i);
  assert.ok(!/https?:\/\//i.test(result));
});

test("maps timeout-shaped messages to a friendly timeout message", () => {
  const { humanizeArtifactError } = loadHelperModule();
  assert.match(humanizeArtifactError(new Error("The operation timed out")), /timed out/i);
});

test("collapses the multi-origin run-list failover dump to a single readable sentence", () => {
  const { humanizeArtifactError } = loadHelperModule();
  const raw =
    "Unable to load runs for gfs/conus. Tried: /__cf: Request failed (500): /__cf/manifests/gfs/runs.json?view=conus " +
    "| http://127.0.0.1:5174: Network request failed for http://127.0.0.1:5174/manifests/gfs/runs.json (Failed to fetch)";
  const result = humanizeArtifactError(raw);
  assert.ok(!/https?:\/\//i.test(result), `must not contain raw URLs: ${result}`);
  assert.ok(!result.includes("\n"), "must be a single line");
  assert.ok(result.length < raw.length, "must be shorter than the raw dump");
});

test("returns a trimmed non-empty string for a plain Error", () => {
  const { humanizeArtifactError } = loadHelperModule();
  const result = humanizeArtifactError(new Error("boom"));
  assert.equal(typeof result, "string");
  assert.ok(result.trim().length > 0);
  assert.equal(result, result.trim());
});

test("returns a trimmed non-empty string for a bare string", () => {
  const { humanizeArtifactError } = loadHelperModule();
  const result = humanizeArtifactError("   plain failure   ");
  assert.equal(typeof result, "string");
  assert.ok(result.trim().length > 0);
  assert.equal(result, result.trim());
});

test("truncates very long unrecognized messages", () => {
  const { humanizeArtifactError } = loadHelperModule();
  const result = humanizeArtifactError("x".repeat(4000));
  assert.ok(result.length <= 200, `must be truncated, got length ${result.length}`);
});

test("returns a non-empty fallback for null/undefined/empty input", () => {
  const { humanizeArtifactError } = loadHelperModule();
  for (const input of [null, undefined, "", "   "]) {
    const result = humanizeArtifactError(input);
    assert.equal(typeof result, "string");
    assert.ok(result.trim().length > 0, `fallback must be non-empty for ${String(input)}`);
  }
});
