"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { decodeSouthNorthBinaryGridBuffer } = require("./grid-ops");
const { hashFileSha256 } = require("./selected-grib");

const DEFAULT_WGRIB2_PATH = "wgrib2";

const PRECIP_TYPE_REGRID_PATTERN = ":(CRAIN|CSNOW|CFRZR|CICEP):";

const CLOUD_CEILING_REGRID_PATTERN = ":HGT:cloud ceiling:";

const MAX_UPDRAFT_HELICITY_REGRID_PATTERN = ":MXUPHL:5000-2000 m above ground:";

const PRECIP_TYPE_DECODE_KEYS = new Set([
  "precipTypeRain",
  "precipTypeSnow",
  "precipTypeFreezingRain",
  "precipTypeIcePellets",
]);

const WGRIB2_IDENTITY_PROMISES = new Map();

const WGRIB2_PROVENANCE_IDENTITY_PROMISES = new Map();

async function ensureWgrib2Available(wgrib2Path = DEFAULT_WGRIB2_PATH) {
  try {
    // Share the memoized identity probe with run-level provenance so a build
    // does not launch the same `wgrib2 -version` subprocess twice.
    const output = (await getWgrib2Identity(wgrib2Path)) || "";
    if (!/\d+\.\d+/.test(output)) {
      throw new Error(`unexpected version output '${output.trim()}'`);
    }
  } catch (error) {
    throw new Error(
      `NOAA beta renderer requires '${wgrib2Path}' on PATH. Install wgrib2, then rerun the command. Original error: ${String(error?.message || error)}`,
      { cause: error },
    );
  }
}

function commandVersionOutput(result) {
  const parts = [result?.stdout, result?.stderr].map((value) => String(value || "").trim()).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

function getWgrib2Identity(wgrib2Path) {
  const key = String(wgrib2Path || "");
  let promise = WGRIB2_IDENTITY_PROMISES.get(key);
  if (!promise) {
    promise = runCommand(wgrib2Path, ["-version"], { allowNonZero: true })
      .then(commandVersionOutput)
      .catch(() => null);
    WGRIB2_IDENTITY_PROMISES.set(key, promise);
  }
  return promise;
}

function getWgrib2ProvenanceIdentity(wgrib2Path) {
  const configuredPath = String(wgrib2Path || "").trim();
  let promise = WGRIB2_PROVENANCE_IDENTITY_PROMISES.get(configuredPath);
  if (!promise) {
    promise = (async () => {
      const [resolvedPath, versionOutput] = await Promise.all([
        resolveExecutablePath(configuredPath),
        getWgrib2Identity(configuredPath),
      ]);
      if (!resolvedPath || !versionOutput) {
        throw new Error(`Unable to establish exact wgrib2 identity for '${configuredPath || "(empty)"}'.`);
      }
      const sha256 = await hashFileSha256(resolvedPath);
      return {
        id: `wgrib2-sha256:${sha256}`,
        name: "wgrib2",
        configuredPath,
        resolvedPath,
        versionOutput,
        sha256,
      };
    })();
    WGRIB2_PROVENANCE_IDENTITY_PROMISES.set(configuredPath, promise);
  }
  return promise;
}

async function resolveExecutablePath(command) {
  const configured = String(command || "").trim();
  if (!configured) {
    return null;
  }
  const candidates = configured.includes(path.sep)
    ? [path.resolve(configured)]
    : String(process.env.PATH || "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, configured));
  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return await fs.promises.realpath(candidate);
    } catch {
      // Keep searching PATH entries.
    }
  }
  return null;
}

function decodeRowInterpolationForKey(key, categoricalPrecipTypeInterpolation = true) {
  return categoricalPrecipTypeInterpolation && PRECIP_TYPE_DECODE_KEYS.has(key) ? "nearest" : "bilinear";
}

async function decodeWindPairToGrids({
  gribPath,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  level = "10 m above ground",
  outputUKey = "windU10m",
  outputVKey = "windV10m",
}) {
  const safeName = String(outputUKey || "wind").replace(/[^a-zA-Z0-9_-]+/g, "-");
  const gridPath = path.join(tempDir, `${safeName}-pair.grib2`);
  const dlon = (bounds.east - bounds.west) / Math.max(1, width - 1);
  const dlat = (bounds.north - bounds.south) / Math.max(1, height - 1);
  await fs.promises.rm(gridPath, { force: true }).catch(() => {});
  await runCommand(wgrib2Path, [
    gribPath,
    "-match",
    `:(UGRD|VGRD):${escapeWgrib2MatchLiteral(level)}:`,
    "-new_grid_winds",
    "earth",
    "-new_grid_interpolation",
    "bilinear",
    "-new_grid",
    "latlon",
    `${bounds.west}:${width}:${dlon}`,
    `${bounds.south}:${height}:${dlat}`,
    gridPath,
  ]);
  return {
    [outputUKey]: await decodeRegriddedRecordToGrid({
      gridPath,
      recordIndex: "1",
      binPath: path.join(tempDir, `${outputUKey}.bin`),
      wgrib2Path,
      bounds,
      width,
      height,
    }),
    [outputVKey]: await decodeRegriddedRecordToGrid({
      gridPath,
      recordIndex: "2",
      binPath: path.join(tempDir, `${outputVKey}.bin`),
      wgrib2Path,
      bounds,
      width,
      height,
    }),
  };
}

function escapeWgrib2MatchLiteral(value) {
  return String(value || "").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function decodeRecordToGrid({
  gribPath,
  recordIndex,
  key,
  tempDir,
  wgrib2Path,
  bounds,
  width,
  height,
  categoricalPrecipTypeInterpolation = true,
}) {
  const gridPath = path.join(tempDir, `${key}.grib2`);
  const binPath = path.join(tempDir, `${key}.bin`);
  await fs.promises.rm(gridPath, { force: true }).catch(() => {});
  await fs.promises.rm(binPath, { force: true }).catch(() => {});
  await runCommand(
    wgrib2Path,
    buildNoaaRegridArgs({
      gribPath,
      recordIndex,
      gridPath,
      bounds,
      width,
      height,
      interpolation: categoricalPrecipTypeInterpolation && PRECIP_TYPE_DECODE_KEYS.has(key) ? "neighbor" : "bilinear",
    }),
  );
  return decodeRegriddedRecordToGrid({
    gridPath,
    recordIndex: "1",
    binPath,
    wgrib2Path,
    bounds,
    width,
    height,
    rowInterpolation: categoricalPrecipTypeInterpolation && PRECIP_TYPE_DECODE_KEYS.has(key) ? "nearest" : "bilinear",
  });
}

function buildNoaaRegridArgs({
  gribPath,
  recordIndex = null,
  gridPath,
  bounds,
  width,
  height,
  interpolation = "bilinear",
  useCategoricalPrecipTypeInterpolation = false,
}) {
  const dlon = (bounds.east - bounds.west) / Math.max(1, width - 1);
  const dlat = (bounds.north - bounds.south) / Math.max(1, height - 1);
  const args = [gribPath];
  if (recordIndex !== null && recordIndex !== undefined) {
    args.push("-d", String(recordIndex));
  }
  // NOAA UPP writes a finite 20,000 m sentinel when no cloud ceiling exists,
  // and some convection-allowing MXUPHL records carry finite -999 missing
  // values. They must become undefined before bilinear interpolation, which
  // would otherwise smear them into apparently physical neighboring values.
  args.push("-if", CLOUD_CEILING_REGRID_PATTERN, "-undefine_val", "19900:20100", "-fi");
  args.push("-if", MAX_UPDRAFT_HELICITY_REGRID_PATTERN, "-undefine_val", "-999", "-fi");
  args.push("-new_grid_winds", "earth", "-new_grid_interpolation", interpolation);
  if (useCategoricalPrecipTypeInterpolation) {
    args.push("-if", PRECIP_TYPE_REGRID_PATTERN, "-new_grid_interpolation", "neighbor", "-fi");
  }
  args.push("-new_grid", "latlon", `${bounds.west}:${width}:${dlon}`, `${bounds.south}:${height}:${dlat}`, gridPath);
  return args;
}

async function decodeRegriddedRecordToGrid({
  gridPath,
  recordIndex,
  binPath,
  wgrib2Path,
  bounds,
  width,
  height,
  rowInterpolation = "bilinear",
}) {
  await fs.promises.rm(binPath, { force: true }).catch(() => {});
  await runCommand(wgrib2Path, [gridPath, "-d", String(recordIndex), "-order", "we:sn", "-no_header", "-bin", binPath]);
  const expectedBytes = width * height * 4;
  const body = await fs.promises.readFile(binPath);
  if (body.length !== expectedBytes) {
    throw new Error(`Decoded NOAA grid has ${body.length} bytes; expected ${expectedBytes}.`);
  }
  return decodeSouthNorthBinaryGridBuffer({ body, byteOffset: 0, bounds, width, height, rowInterpolation });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowNonZero) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

module.exports = {
  DEFAULT_WGRIB2_PATH,
  PRECIP_TYPE_DECODE_KEYS,
  PRECIP_TYPE_REGRID_PATTERN,
  CLOUD_CEILING_REGRID_PATTERN,
  MAX_UPDRAFT_HELICITY_REGRID_PATTERN,
  WGRIB2_IDENTITY_PROMISES,
  WGRIB2_PROVENANCE_IDENTITY_PROMISES,
  buildNoaaRegridArgs,
  decodeRecordToGrid,
  decodeRegriddedRecordToGrid,
  decodeRowInterpolationForKey,
  decodeWindPairToGrids,
  ensureWgrib2Available,
  escapeWgrib2MatchLiteral,
  getWgrib2ProvenanceIdentity,
  getWgrib2Identity,
  runCommand,
};
