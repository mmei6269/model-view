#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Generation never consumes the asset it is replacing. The recipe factory
// returns a fresh roster and all bytes are rebuilt by the authoritative
// compiler in this process.
const { buildStaticContinuousColorLookupAssignments } = require("./lib/noaa-beta/catalog-color-lookup-recipes");
const {
  CATALOG_COLOR_LOOKUP_ASSET_ALIGNMENT,
  CATALOG_COLOR_LOOKUP_ASSET_SCHEMA_VERSION,
  CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256,
  CATALOG_COLOR_LOOKUP_INPUT_ENCODING,
  CATALOG_COLOR_LOOKUP_RECIPE_ENCODING,
  DEFAULT_BINARY_PATH,
  DEFAULT_MANIFEST_PATH,
  buildCanonicalCatalogColorLookupInput,
  buildCatalogColorLookupAssignmentMappingIdentity,
  buildCatalogColorLookupCompilerClosure,
  compareAscii,
  normalizeAssignments,
  sha256,
} = require("./lib/noaa-beta/catalog-color-lookup-asset");
const {
  CONTINUOUS_COLOR_LOOKUP_COMPILER_ID,
  compileContinuousColorLookupRecipe,
} = require("./lib/noaa-beta/color-lookup-compiler");

function main(argv = process.argv.slice(2)) {
  const options = parseGeneratorOptions(argv);
  const outputDir = options.outputDir || path.dirname(DEFAULT_BINARY_PATH);
  const binaryPath = path.join(outputDir, path.basename(DEFAULT_BINARY_PATH));
  const manifestPath = path.join(outputDir, path.basename(DEFAULT_MANIFEST_PATH));
  const generated = generateCatalogColorLookupAsset(buildStaticContinuousColorLookupAssignments(), {
    binaryFile: path.basename(binaryPath),
  });
  if (options.mode === "check") {
    checkGeneratedFile(binaryPath, generated.binary);
    checkGeneratedFile(manifestPath, generated.manifestBytes);
    process.stdout.write(
      `[noaa-color-lookups] committed asset is deterministic and current ` +
        `(${generated.assignmentCount} assignments, ${generated.paletteCount} palettes, ` +
        `${generated.binary.byteLength} bytes)\n`,
    );
    return;
  }
  fs.mkdirSync(outputDir, { recursive: true });
  writeFileAtomically(binaryPath, generated.binary);
  // The manifest is the publication record and is deliberately renamed last.
  // This is fail-closed pair publication, not a rollback-atomic two-file
  // transaction or a directory-fsync durability claim: interruption between
  // renames leaves a manifest/binary identity mismatch that strict loading
  // rejects and auto mode rebuilds completely.
  writeFileAtomically(manifestPath, generated.manifestBytes);
  process.stdout.write(
    `[noaa-color-lookups] wrote ${binaryPath} and ${manifestPath} ` +
      `(${generated.assignmentCount} assignments, ${generated.paletteCount} palettes, ` +
      `${generated.binary.byteLength} bytes)\n`,
  );
}

function generateCatalogColorLookupAsset(assignments, { binaryFile = path.basename(DEFAULT_BINARY_PATH) } = {}) {
  const compilerClosureAtStart = buildCatalogColorLookupCompilerClosure();
  const normalizedAssignments = normalizeAssignments(assignments);
  const input = buildCanonicalCatalogColorLookupInput(normalizedAssignments);
  const uniquePalettes = new Map();
  const compiledAssignments = [];

  for (const assignment of normalizedAssignments) {
    const lookup = compileContinuousColorLookupRecipe(assignment.recipe);
    const bytes = Buffer.from(lookup.colors);
    const digest = sha256(bytes);
    const existing = uniquePalettes.get(digest);
    if (existing && !existing.equals(bytes)) {
      throw new Error(`SHA-256 collision while generating color lookup palette ${digest}.`);
    }
    if (!existing) {
      uniquePalettes.set(digest, bytes);
    }
    compiledAssignments.push({
      id: assignment.id,
      paletteSha256: digest,
      byteLength: bytes.byteLength,
    });
  }

  const sortedPalettes = Array.from(uniquePalettes, ([digest, bytes]) => ({ digest, bytes })).sort((left, right) =>
    compareAscii(left.digest, right.digest),
  );
  const assignmentMapping = buildCatalogColorLookupAssignmentMappingIdentity(compiledAssignments);
  if (assignmentMapping.sha256 !== CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256) {
    throw new Error(
      "Generated color lookup assignment mapping differs from the source-pinned compiled output; " +
        "review the compiler/catalog change and update the pinned digest deliberately.",
    );
  }
  let offset = 0;
  const paletteManifest = sortedPalettes.map(({ digest, bytes }) => {
    if (offset % CATALOG_COLOR_LOOKUP_ASSET_ALIGNMENT !== 0) {
      throw new Error(`Generated palette offset ${offset} is not aligned.`);
    }
    const entry = {
      sha256: digest,
      offset,
      byteLength: bytes.byteLength,
    };
    offset += bytes.byteLength;
    return entry;
  });
  const binary = Buffer.concat(
    sortedPalettes.map(({ bytes }) => bytes),
    offset,
  );
  const compilerClosureAtFinish = buildCatalogColorLookupCompilerClosure();
  if (JSON.stringify(compilerClosureAtStart) !== JSON.stringify(compilerClosureAtFinish)) {
    throw new Error("Color lookup compiler closure changed during asset generation.");
  }
  const manifest = {
    schemaVersion: CATALOG_COLOR_LOOKUP_ASSET_SCHEMA_VERSION,
    compiler: {
      id: CONTINUOUS_COLOR_LOOKUP_COMPILER_ID,
      closure: compilerClosureAtStart,
    },
    input: {
      sha256: input.sha256,
      assignmentCount: normalizedAssignments.length,
      encoding: CATALOG_COLOR_LOOKUP_INPUT_ENCODING,
      recipeEncoding: CATALOG_COLOR_LOOKUP_RECIPE_ENCODING,
    },
    assignmentMapping,
    binary: {
      file: binaryFile,
      alignment: CATALOG_COLOR_LOOKUP_ASSET_ALIGNMENT,
      byteLength: binary.byteLength,
      sha256: sha256(binary),
    },
    paletteCount: paletteManifest.length,
    palettes: paletteManifest,
    assignments: compiledAssignments,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return Object.freeze({
    binary,
    manifest,
    manifestBytes,
    assignmentCount: normalizedAssignments.length,
    paletteCount: paletteManifest.length,
  });
}

function parseGeneratorOptions(argv) {
  let mode = null;
  let outputDir = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--write" || token === "--check") {
      if (mode !== null) {
        throw new Error("Exactly one of --write or --check is required.");
      }
      mode = token.slice(2);
      continue;
    }
    if (token === "--output-dir") {
      const value = argv[index + 1];
      if (outputDir !== null || value === undefined || String(value).trim() === "" || String(value).startsWith("--")) {
        throw new Error("--output-dir requires exactly one non-empty path that is not another option.");
      }
      outputDir = path.resolve(String(argv[++index]));
      continue;
    }
    if (token.startsWith("--output-dir=")) {
      if (outputDir !== null || token.slice("--output-dir=".length).trim() === "") {
        throw new Error("--output-dir requires exactly one non-empty path.");
      }
      outputDir = path.resolve(token.slice("--output-dir=".length));
      continue;
    }
    throw new Error(`Unknown generator option ${JSON.stringify(token)}.`);
  }
  if (mode === null) {
    throw new Error("Usage: node scripts/generate-noaa-catalog-color-lookups.js --write|--check [--output-dir=PATH]");
  }
  return { mode, outputDir };
}

function checkGeneratedFile(filePath, expected) {
  let actual;
  try {
    actual = fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(`Generated color lookup asset is missing at ${filePath}: ${error.message}`, {
      cause: error,
    });
  }
  if (!actual.equals(expected)) {
    throw new Error(
      `Generated color lookup asset is stale at ${filePath}; run ` +
        "`npm run noaa:color-lookups:generate` and commit both outputs.",
    );
  }
}

function writeFileAtomically(filePath, bytes) {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  let tempExists = false;
  try {
    const fd = fs.openSync(tempPath, "wx", 0o644);
    tempExists = true;
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
    tempExists = false;
  } finally {
    if (tempExists) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup of an unpublished adjacent temporary file.
      }
    }
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[noaa-color-lookups] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  checkGeneratedFile,
  generateCatalogColorLookupAsset,
  main,
  parseGeneratorOptions,
  writeFileAtomically,
};
