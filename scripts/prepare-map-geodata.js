#!/usr/bin/env node

"use strict";

// Builds the bundled map geodata under next/public/geo/ from public-domain
// sources: Natural Earth 10m for the high-resolution country/state boundaries
// per view (replacing the original ~100 KB stubs that fell apart past z7);
// US Census cartographic boundaries (cb_2023, 1:5m) for the county lines —
// far crisper than NE's generalized admin-2 shapes at state/metro zooms.
// (The old roads/place-label outputs are gone since Task 6.3: the vector
// basemap renders roads and ranked place labels itself.)
// Sources are cached in .geodata-cache/ (gitignored); OUTPUTS are committed
// so the app never needs this script (or the network) at runtime.
//
//   node scripts/prepare-map-geodata.js
//
// Requires network for the first run and `npx mapshaper` (fetched on demand).

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CACHE_DIR = path.join(ROOT, ".geodata-cache");
const OUT_BOUNDARIES = path.join(ROOT, "next/public/geo/boundaries");
const OUT_FEATURES = path.join(ROOT, "next/public/geo/features");

const NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";
const SOURCES = {
  countries: "ne_10m_admin_0_countries_lakes.geojson",
  states: "ne_10m_admin_1_states_provinces_lakes.geojson",
};

// US Census cartographic boundary counties, 1:5,000,000 (public domain).
// Distributed as a zipped shapefile; mapshaper reads the unzipped .shp.
const CENSUS_COUNTIES_ZIP = "cb_2023_us_county_5m.zip";
const CENSUS_COUNTIES_URL = `https://www2.census.gov/geo/tiger/GENZ2023/shp/${CENSUS_COUNTIES_ZIP}`;

// Clip boxes = view maxBounds plus a pan pad so strokes never end mid-screen.
const VIEW_BBOXES = {
  conus: [-131, 19, -61, 55],
  na: [-172, 5, -43, 76],
};

function sh(args) {
  execFileSync("npx", ["--yes", "mapshaper", ...args], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
}

function download(name, file) {
  const target = path.join(CACHE_DIR, file);
  if (isValidGeoJsonFile(target)) {
    return target;
  }
  console.log(`Downloading ${file} ...`);
  // -f: an HTTP error must fail the run, not cache the error body as data.
  execFileSync("curl", ["-sfL", "-o", target, `${NE_BASE}/${file}`], { stdio: "inherit" });
  if (!isValidGeoJsonFile(target)) {
    fs.rmSync(target, { force: true });
    throw new Error(`${file} did not download as GeoJSON — check the Natural Earth source URL.`);
  }
  return target;
}

// Cheap validity gate for cached sources: non-trivial size and a JSON object
// start. Protects against truncated downloads poisoning the cache forever.
function isValidGeoJsonFile(target) {
  return hasMagicHead(target, "{");
}

// Same gate for the Census zip: non-trivial size and the PK zip magic.
function isValidZipFile(target) {
  return hasMagicHead(target, "PK");
}

function hasMagicHead(target, magic) {
  try {
    const stat = fs.statSync(target);
    if (stat.size < 100_000) {
      return false;
    }
    const fd = fs.openSync(target, "r");
    const head = Buffer.alloc(magic.length);
    fs.readSync(fd, head, 0, magic.length, 0);
    fs.closeSync(fd);
    return head.toString("utf8") === magic;
  } catch {
    return false;
  }
}

// Census counties arrive as a zipped shapefile: fetch the zip into the cache
// (same truncation-proof gate as the GeoJSON sources), unzip it next to
// itself, and hand mapshaper the .shp.
function downloadCensusCounties() {
  const zipTarget = path.join(CACHE_DIR, CENSUS_COUNTIES_ZIP);
  if (!isValidZipFile(zipTarget)) {
    console.log(`Downloading ${CENSUS_COUNTIES_ZIP} ...`);
    // -f: an HTTP error must fail the run, not cache the error body as data.
    execFileSync("curl", ["-sfL", "-o", zipTarget, CENSUS_COUNTIES_URL], { stdio: "inherit" });
    if (!isValidZipFile(zipTarget)) {
      fs.rmSync(zipTarget, { force: true });
      throw new Error(`${CENSUS_COUNTIES_ZIP} did not download as a zip — check the Census source URL.`);
    }
  }
  const shpDir = path.join(CACHE_DIR, path.basename(CENSUS_COUNTIES_ZIP, ".zip"));
  const shp = path.join(shpDir, `${path.basename(CENSUS_COUNTIES_ZIP, ".zip")}.shp`);
  if (!fs.existsSync(shp)) {
    execFileSync("unzip", ["-o", "-q", zipTarget, "-d", shpDir], { stdio: "inherit" });
  }
  return shp;
}

function bboxArg(view) {
  return VIEW_BBOXES[view].join(",");
}

function kb(file) {
  return `${(fs.statSync(file).size / 1024).toFixed(0)} KB`;
}

function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(OUT_BOUNDARIES, { recursive: true });
  fs.mkdirSync(OUT_FEATURES, { recursive: true });

  const countries = download("countries", SOURCES.countries);
  const states = download("states", SOURCES.states);
  const counties = downloadCensusCounties();

  for (const view of Object.keys(VIEW_BBOXES)) {
    sh([
      countries,
      "-clip",
      `bbox=${bboxArg(view)}`,
      "-simplify",
      "12%",
      "keep-shapes",
      "-filter-fields",
      "ADMIN",
      "-o",
      `precision=0.0005`,
      `${path.join(OUT_BOUNDARIES, `${view}-country.geojson`)}`,
    ]);
    // Deliberately unfiltered by country: every admin-1 boundary inside the
    // clip bbox is real, useful context (the committed bundles were built
    // this way).
    sh([
      states,
      "-clip",
      `bbox=${bboxArg(view)}`,
      "-simplify",
      "12%",
      "keep-shapes",
      "-filter-fields",
      "name,admin",
      "-o",
      `precision=0.0005`,
      `${path.join(OUT_BOUNDARIES, `${view}-admin1.geojson`)}`,
    ]);
  }

  // US counties (CONUS clip), from the Census 1:5m cartographic boundaries.
  // 60% keeps ~3x the vertex density of the old NE 10m build (counties stay
  // crisp along state borders at z8-14) while the committed output stays
  // under the ~3 MB bundle budget. Same downstream schema as before:
  // FeatureCollection of (Multi)Polygons with a NAME property.
  // STATEFP 02 (Alaska) is excluded explicitly: the southeast-Alaska
  // panhandle (Ketchikan Gateway borough) dips below 55°N into the CONUS
  // clip bbox's northwest corner and survived the clip as a stray offshore
  // sliver (Task 4.1 review finding). The filter must run before
  // -filter-fields drops STATEFP.
  sh([
    counties,
    "-clip",
    `bbox=${bboxArg("conus")}`,
    "-filter",
    'STATEFP != "02"',
    "-simplify",
    "60%",
    "keep-shapes",
    "-filter-fields",
    "NAME",
    "-o",
    `precision=0.0005`,
    `${path.join(OUT_FEATURES, "us-counties.geojson")}`,
  ]);

  for (const dir of [OUT_BOUNDARIES, OUT_FEATURES]) {
    for (const file of fs.readdirSync(dir)) {
      console.log(path.join(path.relative(ROOT, dir), file), kb(path.join(dir, file)));
    }
  }
}

main();
