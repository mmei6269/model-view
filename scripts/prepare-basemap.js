#!/usr/bin/env node

"use strict";

// Fetches the Protomaps basemap extracts that back the MapLibre map engine.
// The full run pulls a North America extract (~16-22 GB download; incl.
// Greenland, Iceland and the Canadian Arctic — Stage B of
// docs/basemap-expansion-plan.md) from the newest Protomaps daily planet
// build into output/basemap/ (gitignored; served by the artifact server's
// HTTP Range route). The extract lands in a .partial file and is renamed
// over the live na.pmtiles only after the size gate passes, so a failed or
// interrupted download never destroys the working basemap. The --fixture run
// then cuts a small committed CI fixture from that LOCAL file, so CI never
// touches the network.
//
//   npm run basemap:fetch                        # NA extract -> output/basemap/na.pmtiles
//   node scripts/prepare-basemap.js --fixture    # CONUS z0-5 -> tests-react/fixtures/basemap-fixture.pmtiles
//   node scripts/prepare-basemap.js --print-url  # discovery probe only; prints the chosen build URL
//
// Requires the `pmtiles` CLI (go-pmtiles) on PATH and network for the full run.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NA_FILE = path.join(ROOT, "output/basemap/na.pmtiles");
const FIXTURE_FILE = path.join(ROOT, "tests-react/fixtures/basemap-fixture.pmtiles");

const BUILD_BASE = "https://build.protomaps.com";
// Full extract: North America incl. Alaska/Hawaii/Central America, plus full
// Greenland (east cape ≈ -11.3°), Iceland, and the Canadian Arctic
// Archipelago (Cape Columbia 83.1°N), full tile depth. Stage B bbox per
// docs/basemap-expansion-plan.md: west is the antimeridian hard floor
// (pmtiles bboxes cannot cross it), east -11 stays short of Ireland (-10.6°).
// PAN_BOUNDS in next/src/config/constants.ts over-pans past these edges by
// design (void reads as ocean via the water-tone style background).
const NA_BBOX = "-180,3,-11,84";
const NA_MAXZOOM = 14;
// Fixture: CONUS-only low zooms (matches VIEW_BBOXES.conus in prepare-map-geodata.js).
const FIXTURE_BBOX = "-131,19,-61,55";
const FIXTURE_MAXZOOM = 5;
// A real z14 extract of the Stage B bbox lands well above this (the smaller
// pre-Stage-B bbox already produced 15.78 GB); anything smaller means the
// extract was truncated or silently clipped and must not be trusted.
const MIN_NA_BYTES = 10 * 1024 ** 3;
// Fixture floor is loose (the file is "a few MB"); this only catches empty output.
const MIN_FIXTURE_BYTES = 100 * 1024;
// Daily builds occasionally lag; probe today then back this many days.
const PROBE_BACK_DAYS = 7;

// The full CLI surface. parseArgs fails closed: any token that is not one of
// these flags aborts the run, so a typo can never silently start a multi-GB
// download with the wrong options.
const KNOWN_FLAGS = Object.freeze(["build", "fixture", "print-url", "help"]);

function parseArgs(argv) {
  const args = {};
  const usage = `Known flags: ${KNOWN_FLAGS.map((f) => `--${f}`).join(", ")}`;
  for (const token of argv) {
    const str = String(token);
    if (str === "-h") {
      args.help = true;
      continue;
    }
    if (!str.startsWith("--")) {
      throw new Error(`Unknown argument "${str}". ${usage}`);
    }
    const trimmed = str.slice(2);
    const eq = trimmed.indexOf("=");
    const name = eq >= 0 ? trimmed.slice(0, eq) : trimmed;
    if (!KNOWN_FLAGS.includes(name)) {
      throw new Error(`Unknown flag "--${name}". ${usage}`);
    }
    if (eq >= 0) args[name] = trimmed.slice(eq + 1);
    else args[name] = true;
  }
  return args;
}

function printHelp() {
  console.log(`Fetch Protomaps basemap extracts for the MapLibre map engine.

Usage:
  npm run basemap:fetch                        Full North America extract -> output/basemap/na.pmtiles (~8-12 GB)
  node scripts/prepare-basemap.js --fixture    CONUS z0-${FIXTURE_MAXZOOM} CI fixture from the LOCAL NA file
                                               -> tests-react/fixtures/basemap-fixture.pmtiles
  node scripts/prepare-basemap.js --print-url  Discover the newest daily build and print its URL (no extract)

Flags:
  --build=YYYYMMDD   Pin a specific Protomaps daily build. Default: newest available,
                     probed from today back up to ${PROBE_BACK_DAYS} days at ${BUILD_BASE}/YYYYMMDD.pmtiles
  --fixture          Build the committed CI fixture (requires output/basemap/na.pmtiles to exist)
  --print-url        Build-discovery probe only; prints the chosen source URL and exits
  --help, -h         Show this help`);
}

function requirePmtiles() {
  try {
    execFileSync("pmtiles", ["--help"], { stdio: "ignore" });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        "`pmtiles` CLI not found on PATH. Install go-pmtiles first: `brew install pmtiles` " +
          "(or download a release from https://github.com/protomaps/go-pmtiles/releases).",
      );
    }
    throw error;
  }
}

function pmtiles(args) {
  execFileSync("pmtiles", args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
}

function utcDateStamp(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}${month}${day}`;
}

function gb(file) {
  return `${(fs.statSync(file).size / 1024 ** 3).toFixed(2)} GB`;
}

function mb(file) {
  return `${(fs.statSync(file).size / 1024 ** 2).toFixed(1)} MB`;
}

// Resolves the source build URL: an explicit --build=YYYYMMDD is trusted as-is
// (still probed, so a bad date fails before any download); otherwise HEAD-probe
// today's dated build and walk backwards until one exists.
async function resolveBuildUrl(buildArg) {
  const probe = async (stamp) => {
    const url = `${BUILD_BASE}/${stamp}.pmtiles`;
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok) {
        const size = Number(res.headers.get("content-length"));
        console.log(
          `  ${stamp}: found${Number.isFinite(size) && size > 0 ? ` (${(size / 1024 ** 3).toFixed(1)} GB planet build)` : ""}`,
        );
        return url;
      }
      console.log(`  ${stamp}: HTTP ${res.status}`);
    } catch (error) {
      console.log(`  ${stamp}: ${error && error.message ? error.message : error}`);
    }
    return null;
  };

  if (buildArg !== undefined) {
    const stamp = String(buildArg);
    if (!/^\d{8}$/.test(stamp)) {
      throw new Error(`--build must be YYYYMMDD (got "${stamp}").`);
    }
    console.log(`Probing pinned build ${BUILD_BASE}/${stamp}.pmtiles ...`);
    const url = await probe(stamp);
    if (!url) {
      throw new Error(`Pinned build ${stamp} is not available at ${BUILD_BASE}/${stamp}.pmtiles.`);
    }
    return url;
  }

  console.log(`Probing for the newest Protomaps daily build (today back ${PROBE_BACK_DAYS} days, UTC) ...`);
  for (let daysAgo = 0; daysAgo <= PROBE_BACK_DAYS; daysAgo += 1) {
    const url = await probe(utcDateStamp(daysAgo));
    if (url) return url;
  }
  throw new Error(
    `No Protomaps daily build found in the last ${PROBE_BACK_DAYS + 1} days at ${BUILD_BASE}/YYYYMMDD.pmtiles — ` +
      "check https://maps.protomaps.com/builds/ or pass --build=YYYYMMDD explicitly.",
  );
}

async function fetchNorthAmerica(buildArg) {
  requirePmtiles();
  const url = await resolveBuildUrl(buildArg);
  const partialFile = `${NA_FILE}.partial`;
  console.log(`\nSource build: ${url}`);
  console.log(`Extracting bbox=${NA_BBOX} maxzoom=${NA_MAXZOOM} -> ${path.relative(ROOT, partialFile)}`);
  console.log("This downloads ~16-22 GB and can take a while.\n");
  fs.mkdirSync(path.dirname(NA_FILE), { recursive: true });
  // Extract into a .partial and rename over the live file only after the size
  // gate passes: an interrupted download must never destroy a working
  // basemap (pmtiles extract cannot resume).
  fs.rmSync(partialFile, { force: true });
  pmtiles(["extract", url, partialFile, `--bbox=${NA_BBOX}`, `--maxzoom=${NA_MAXZOOM}`]);

  console.log(`\npmtiles show ${path.relative(ROOT, partialFile)}:`);
  pmtiles(["show", partialFile]);
  if (fs.statSync(partialFile).size < MIN_NA_BYTES) {
    throw new Error(
      `${path.relative(ROOT, partialFile)} is only ${gb(partialFile)} — a full z${NA_MAXZOOM} NA extract must be >10 GB. ` +
        "The extract was truncated or mis-scoped. Most often this means the download/extract was " +
        `interrupted (partial file). Delete ${path.relative(ROOT, partialFile)} and re-run; resume is not supported. ` +
        "The previous na.pmtiles (if any) is untouched.",
    );
  }
  fs.renameSync(partialFile, NA_FILE);

  console.log(`\nDone: ${path.relative(ROOT, NA_FILE)} (${gb(NA_FILE)})`);
  console.log(`
Refresh instructions:
  Protomaps daily builds drift from upstream OSM over time. Re-run
  \`npm run basemap:fetch\` roughly quarterly (per the MapLibre migration design
  spec) to pick up the newest build, then rebuild + commit the CI fixture with
  \`node scripts/prepare-basemap.js --fixture\`.`);
}

function buildFixture() {
  requirePmtiles();
  if (!fs.existsSync(NA_FILE)) {
    throw new Error(
      `${path.relative(ROOT, NA_FILE)} not found — the fixture is cut from the local NA extract. ` +
        "Run `npm run basemap:fetch` first (~8-12 GB download), then re-run with --fixture.",
    );
  }
  if (fs.statSync(NA_FILE).size < MIN_NA_BYTES) {
    throw new Error(
      `${path.relative(ROOT, NA_FILE)} is only ${gb(NA_FILE)} — a full z${NA_MAXZOOM} NA extract must be >2 GB. ` +
        "Most often this means the download/extract was interrupted (partial file). " +
        `Delete ${path.relative(ROOT, NA_FILE)} and re-run \`npm run basemap:fetch\`; resume is not supported.`,
    );
  }
  console.log(
    `Extracting fixture bbox=${FIXTURE_BBOX} z0-${FIXTURE_MAXZOOM} from ${path.relative(ROOT, NA_FILE)} -> ` +
      `${path.relative(ROOT, FIXTURE_FILE)}`,
  );
  fs.mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
  pmtiles(["extract", NA_FILE, FIXTURE_FILE, `--bbox=${FIXTURE_BBOX}`, `--maxzoom=${FIXTURE_MAXZOOM}`]);

  console.log(`\npmtiles show ${path.relative(ROOT, FIXTURE_FILE)}:`);
  pmtiles(["show", FIXTURE_FILE]);
  if (fs.statSync(FIXTURE_FILE).size < MIN_FIXTURE_BYTES) {
    throw new Error(
      `${path.relative(ROOT, FIXTURE_FILE)} is only ${mb(FIXTURE_FILE)} — suspiciously small for CONUS z0-${FIXTURE_MAXZOOM}. ` +
        "Most often this means the local extract was interrupted (partial file). " +
        "Delete the file and re-run with --fixture; resume is not supported.",
    );
  }
  console.log(`\nDone: ${path.relative(ROOT, FIXTURE_FILE)} (${mb(FIXTURE_FILE)}) — commit this file.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.fixture && (args["print-url"] || args.build !== undefined)) {
    throw new Error("--fixture reads the local NA file; it cannot be combined with --build or --print-url.");
  }
  if (args.fixture) {
    buildFixture();
    return;
  }
  if (args["print-url"]) {
    const url = await resolveBuildUrl(args.build);
    console.log(url);
    return;
  }
  await fetchNorthAmerica(args.build);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = { parseArgs, utcDateStamp, KNOWN_FLAGS, NA_BBOX, NA_MAXZOOM, FIXTURE_BBOX, FIXTURE_MAXZOOM };
