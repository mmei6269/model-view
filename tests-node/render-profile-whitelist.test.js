"use strict";

// finalizeNoaaRenderProfile rebuilds render profiles from an explicit key
// whitelist, so a counter written anywhere in the renderer but missing from
// that whitelist silently vanishes from finalized profiles, logs, and marker
// sidecars (a repeated incident class). This suite scans the renderer sources
// for every profile-key write site and asserts finalization preserves each
// key, so adding a counter without whitelisting it fails here instead of
// disappearing quietly.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { finalizeNoaaRenderProfile, createNoaaRenderProfile } = require(
  path.join(ROOT, "scripts/lib/noaa-beta/grib-source.js"),
);

const SCAN_FILES = [
  "scripts/lib/noaa-beta-renderer.js",
  "scripts/noaa-beta-derived-worker.js",
  "scripts/noaa-beta-frame-worker.js",
  ...listJsFiles("scripts/lib/noaa-beta"),
  ...listJsFiles("scripts/lib/noaa-build"),
];

// Keys finalizeNoaaRenderProfile intentionally handles through non-whitelist
// mechanisms (stage map, retry-status map, base fields) or that are internal
// bookkeeping never meant to survive finalization.
const HANDLED_ELSEWHERE = new Set([
  "stages", // per-stage timings copied via the stages loop
  "rangeFetchRetryStatuses", // copied conditionally on rangeFetchRetries > 0
  "selectedGribCacheHit", // base field preserved via Boolean(), not Number()
]);

// slr-methods.js names its AGL profile-column struct `profile`; those writes
// are science state, not render-profile counters.
const SCAN_EXCLUDES = new Set(["scripts/lib/noaa-beta/slr-methods.js"]);

// Dynamic `${prefix}Xxx` profile keys are written through
// context.sourceProfilePrefix; expand every prefix the winter module uses.
const SOURCE_PROFILE_PREFIXES = ["snowLiquid", "freezingRainLiquid"];

function listJsFiles(relDir) {
  return fs
    .readdirSync(path.join(ROOT, relDir))
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(relDir, name));
}

function collectWrittenProfileKeys() {
  const keys = new Set();
  const templateSuffixes = new Set();
  const incrementRe = /incrementProfileCounter\(\s*[^,]+,\s*"([A-Za-z0-9]+)"/g;
  const sessionCounterRe = /incrementSessionProfileCounter\(\s*[^,]+,\s*"([A-Za-z0-9]+)"/g;
  const assignRe =
    /(?:^|[^.\w])(?:renderProfile|profile|context\.profile|session\.profile)\.([A-Za-z0-9]+)\s*(?:=[^=]|\+=)/g;
  const templateRe =
    /(?:context\.profile|profile)\[`\$\{(?:prefix|context\.sourceProfilePrefix)\}([A-Za-z0-9]+)`\]\s*(?:=[^=]|\+=)/g;
  for (const rel of SCAN_FILES) {
    if (SCAN_EXCLUDES.has(rel)) {
      continue;
    }
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const match of source.matchAll(incrementRe)) {
      keys.add(match[1]);
    }
    for (const match of source.matchAll(sessionCounterRe)) {
      keys.add(match[1]);
    }
    for (const match of source.matchAll(assignRe)) {
      keys.add(match[1]);
    }
    for (const match of source.matchAll(templateRe)) {
      templateSuffixes.add(match[1]);
    }
  }
  for (const suffix of templateSuffixes) {
    for (const prefix of SOURCE_PROFILE_PREFIXES) {
      keys.add(`${prefix}${suffix}`);
    }
  }
  for (const key of HANDLED_ELSEWHERE) {
    keys.delete(key);
  }
  return keys;
}

test("source scan finds the render-profile write surface", () => {
  const keys = collectWrittenProfileKeys();
  // Guard the scanner itself: these long-standing counters must be found, or
  // the regexes have rotted and the suite is asserting nothing.
  for (const expected of [
    "selectedGribCacheHits",
    "regridBinCacheHits",
    "derivedParallelChunks",
    "snowLiquidGridCacheHits",
    "freezingRainLiquidGridCacheHits",
  ]) {
    assert.ok(keys.has(expected), `scanner lost expected key ${expected}`);
  }
  assert.ok(keys.size >= 40, `scanner found only ${keys.size} keys`);
});

test("every written profile key survives finalizeNoaaRenderProfile", () => {
  const keys = collectWrittenProfileKeys();
  const profile = createNoaaRenderProfile();
  const sentinelByKey = new Map();
  let sentinel = 7;
  for (const key of keys) {
    sentinel += 1;
    // Objects pass through as references; numbers must survive Number().
    profile[key] = typeof profile[key] === "object" && profile[key] !== null ? profile[key] : sentinel;
    sentinelByKey.set(key, profile[key]);
  }
  const finalized = finalizeNoaaRenderProfile(profile);
  const missing = [];
  for (const key of keys) {
    const value = finalized[key];
    const wanted = sentinelByKey.get(key);
    const survived = typeof wanted === "number" ? value === wanted : value !== undefined && value !== null;
    if (!survived) {
      missing.push(key);
    }
  }
  assert.deepStrictEqual(
    missing.sort(),
    [],
    `profile keys written in renderer sources but dropped by finalizeNoaaRenderProfile: ${missing.join(", ")}`,
  );
});
