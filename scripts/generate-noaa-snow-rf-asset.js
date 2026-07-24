#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { compileSnowRfModel } = require("./lib/noaa-beta/snow-rf-compiler");
const {
  DEFAULT_BINARY_PATH,
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SOURCE_PATH,
  SNOW_RF_ASSET_ORACLES,
  SNOW_RF_MODEL_ORACLES,
  SNOW_RF_SOURCE_IDENTITY,
  buildSnowRfAssetBinary,
  buildSnowRfAssetManifest,
  buildSnowRfCompilerClosure,
  materializeSnowRfAsset,
  serializeSnowRfAssetManifest,
  sha256,
} = require("./lib/noaa-beta/snow-rf-asset");

const PUBLICATION_LOCK_BASENAME = ".snow-rf-conus-v1.generate.lock";

function main(argv = process.argv.slice(2)) {
  const options = parseGeneratorOptions(argv);
  const outputDir = options.outputDir || path.dirname(DEFAULT_BINARY_PATH);
  const paths = resolveOutputPaths(outputDir);
  const generated = generateSnowRfAsset();
  if (options.mode === "check") {
    checkGeneratedFile(paths.binaryPath, generated.binary);
    checkGeneratedFile(paths.manifestPath, generated.manifestBytes);
    rereadAndValidatePublishedPair(paths, generated);
    process.stdout.write(
      `[noaa-snow-rf] committed asset is deterministic and current ` +
        `(${SNOW_RF_MODEL_ORACLES.treeCount} trees, ${SNOW_RF_MODEL_ORACLES.nodeCount} nodes, ` +
        `${generated.binary.byteLength} bytes, binary ${generated.binarySha256}, ` +
        `manifest ${generated.manifestSha256})\n`,
    );
    return;
  }
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
  publishSnowRfAsset(paths, generated);
  process.stdout.write(
    `[noaa-snow-rf] wrote ${paths.binaryPath} and ${paths.manifestPath} ` +
      `(${SNOW_RF_MODEL_ORACLES.treeCount} trees, ${SNOW_RF_MODEL_ORACLES.nodeCount} nodes, ` +
      `${generated.binary.byteLength} bytes, binary ${generated.binarySha256}, ` +
      `manifest ${generated.manifestSha256})\n`,
  );
}

function generateSnowRfAsset({
  sourcePath = DEFAULT_SOURCE_PATH,
  compilerClosureOptions,
  binaryFile = path.basename(DEFAULT_BINARY_PATH),
} = {}) {
  const compilerClosureAtStart = buildSnowRfCompilerClosure(compilerClosureOptions);
  const sourceAtStart = captureSnowRfSource(sourcePath, { retainBytes: true });
  assertFrozenSourceIdentity(sourceAtStart.identity);
  let raw;
  try {
    raw = JSON.parse(sourceAtStart.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Authoritative Snow-RF source is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  const model = compileSnowRfModel(raw);
  raw = null;
  if (!model) {
    throw new Error("Authoritative Snow-RF source failed strict compilation.");
  }
  const built = buildSnowRfAssetBinary(model);
  const compilerClosureAtFinish = buildSnowRfCompilerClosure(compilerClosureOptions);
  if (!sameJson(compilerClosureAtStart, compilerClosureAtFinish)) {
    throw new Error("Snow-RF generator/compiler closure changed during asset generation.");
  }
  const sourceAtFinish = captureSnowRfSource(sourcePath, { retainBytes: false });
  if (
    !sameJson(sourceAtStart.identity, sourceAtFinish.identity) ||
    !sameJson(sourceAtStart.fileIdentity, sourceAtFinish.fileIdentity)
  ) {
    throw new Error("Authoritative Snow-RF source changed during asset generation.");
  }
  const manifest = buildSnowRfAssetManifest({
    built,
    compilerClosure: compilerClosureAtStart,
    binaryFile,
  });
  const manifestBytes = serializeSnowRfAssetManifest(manifest);
  materializeSnowRfAsset({
    manifest,
    binaryBytes: built.binary,
    compilerClosure: compilerClosureAtStart,
  });
  return Object.freeze({
    binary: built.binary,
    binarySha256: built.binarySha256,
    manifest,
    manifestBytes,
    manifestSha256: sha256(manifestBytes),
    compilerClosure: compilerClosureAtStart,
    sourcePath: path.resolve(sourcePath),
    sourceIdentity: sourceAtStart.identity,
    sourceFileIdentity: sourceAtStart.fileIdentity,
    regionDiagnostics: built.regionDiagnostics,
  });
}

function publishSnowRfAsset(paths, generated) {
  return withSnowRfPublicationLock(paths, ({ token, outputDirectoryIdentity }) => {
    const directoryContext = {
      outputDir: paths.outputDir,
      outputDirectoryIdentity,
    };
    const binaryTempPath = `${paths.binaryPath}.tmp-${token}`;
    const manifestTempPath = `${paths.manifestPath}.tmp-${token}`;
    let binaryIdentity = null;
    let manifestIdentity = null;
    let binaryTempPresent = false;
    let manifestTempPresent = false;
    let primaryError = null;
    try {
      binaryIdentity = writeExclusiveOwnedFile(binaryTempPath, generated.binary, 0o644, directoryContext);
      binaryTempPresent = true;
      manifestIdentity = writeExclusiveOwnedFile(manifestTempPath, generated.manifestBytes, 0o644, directoryContext);
      manifestTempPresent = true;
      assertGenerationInputsStable(generated);
      assertOutputDirectoryIdentity(paths.outputDir, outputDirectoryIdentity);
      assertOwnedPath(binaryTempPath, binaryIdentity);
      fs.renameSync(binaryTempPath, paths.binaryPath);
      binaryTempPresent = false;
      assertOwnedPath(paths.binaryPath, binaryIdentity);
      fsyncOutputDirectory(paths.outputDir, outputDirectoryIdentity);
      assertOwnedPath(paths.binaryPath, binaryIdentity);
      assertOwnedPath(manifestTempPath, manifestIdentity);
      fs.renameSync(manifestTempPath, paths.manifestPath);
      manifestTempPresent = false;
      assertOwnedPath(paths.manifestPath, manifestIdentity);
      fsyncOutputDirectory(paths.outputDir, outputDirectoryIdentity);
      assertOwnedPath(paths.manifestPath, manifestIdentity);
      assertOutputDirectoryIdentity(paths.outputDir, outputDirectoryIdentity);
      rereadAndValidatePublishedPair(paths, generated, {
        outputDirectoryIdentity,
        binaryIdentity,
        manifestIdentity,
      });
      assertGenerationInputsStable(generated);
      assertPublishedPairIdentities(paths, {
        outputDirectoryIdentity,
        binaryIdentity,
        manifestIdentity,
      });
    } catch (error) {
      primaryError = error;
    }
    const cleanupErrors = [];
    for (const [filePath, identity, present] of [
      [binaryTempPath, binaryIdentity, binaryTempPresent],
      [manifestTempPath, manifestIdentity, manifestTempPresent],
    ]) {
      if (!identity || !present) {
        continue;
      }
      try {
        unlinkOwnedPath(filePath, identity, directoryContext);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (primaryError && cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        "Snow-RF publication and owned temporary-file cleanup both failed.",
      );
    }
    if (primaryError) {
      throw primaryError;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Snow-RF owned temporary-file cleanup failed.");
    }
  });
}

function withSnowRfPublicationLock(paths, action) {
  const outputDirectoryIdentity = inspectOutputDirectory(paths.outputDir);
  const directoryContext = {
    outputDir: paths.outputDir,
    outputDirectoryIdentity,
  };
  const token = crypto.randomBytes(16).toString("hex");
  const record = Buffer.from(
    `${JSON.stringify({
      schema: "modelview-snow-rf-generator-lock-v1",
      token,
      pid: process.pid,
      binaryPath: paths.binaryPath,
      manifestPath: paths.manifestPath,
    })}\n`,
  );
  let lockIdentity;
  try {
    lockIdentity = writeExclusiveOwnedFile(paths.lockPath, record, 0o600, directoryContext);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Snow-RF generation lock already exists at ${paths.lockPath}.`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    fsyncOutputDirectory(paths.outputDir, outputDirectoryIdentity);
  } catch (error) {
    try {
      unlinkOwnedPath(paths.lockPath, lockIdentity, directoryContext);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Snow-RF exclusive-lock publication and cleanup both failed.");
    }
    throw error;
  }
  let result;
  let primaryError = null;
  try {
    assertOutputDirectoryIdentity(paths.outputDir, outputDirectoryIdentity);
    result = action({ token, lockIdentity, outputDirectoryIdentity });
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try {
    unlinkOwnedPath(paths.lockPath, lockIdentity, directoryContext);
    assertOutputDirectoryIdentity(paths.outputDir, outputDirectoryIdentity);
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Snow-RF publication and exclusive-lock cleanup both failed.",
    );
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  return result;
}

function assertGenerationInputsStable(generated) {
  const source = captureSnowRfSource(generated.sourcePath, { retainBytes: false });
  const compilerClosure = buildSnowRfCompilerClosure();
  if (
    !sameJson(source.identity, generated.sourceIdentity) ||
    !sameJson(source.fileIdentity, generated.sourceFileIdentity) ||
    !sameJson(compilerClosure, generated.compilerClosure)
  ) {
    throw new Error("Snow-RF source or generator/compiler closure changed before publication completed.");
  }
}

function rereadAndValidatePublishedPair(
  paths,
  generated,
  {
    outputDirectoryIdentity = inspectOutputDirectory(paths.outputDir),
    binaryIdentity = inspectOwnedPath(paths.binaryPath),
    manifestIdentity = inspectOwnedPath(paths.manifestPath),
  } = {},
) {
  const directoryContext = {
    outputDir: paths.outputDir,
    outputDirectoryIdentity,
  };
  assertPublishedPairIdentities(paths, {
    outputDirectoryIdentity,
    binaryIdentity,
    manifestIdentity,
  });
  const binary = readOwnedPublishedFile(paths.binaryPath, binaryIdentity, directoryContext);
  const manifestBytes = readOwnedPublishedFile(paths.manifestPath, manifestIdentity, directoryContext);
  assertPublishedPairIdentities(paths, {
    outputDirectoryIdentity,
    binaryIdentity,
    manifestIdentity,
  });
  if (!binary.equals(generated.binary) || !manifestBytes.equals(generated.manifestBytes)) {
    throw new Error("Published Snow-RF pair differs from the generated bytes.");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Published Snow-RF manifest is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  materializeSnowRfAsset({
    manifest,
    binaryBytes: binary,
    compilerClosure: generated.compilerClosure,
  });
  assertPublishedPairIdentities(paths, {
    outputDirectoryIdentity,
    binaryIdentity,
    manifestIdentity,
  });
}

function assertPublishedPairIdentities(paths, { outputDirectoryIdentity, binaryIdentity, manifestIdentity }) {
  assertOutputDirectoryIdentity(paths.outputDir, outputDirectoryIdentity);
  assertOwnedPath(paths.binaryPath, binaryIdentity);
  assertOwnedPath(paths.manifestPath, manifestIdentity);
  assertOutputDirectoryIdentity(paths.outputDir, outputDirectoryIdentity);
}

function captureSnowRfSource(filePath, { retainBytes }) {
  const resolvedPath = path.resolve(filePath);
  const pathBefore = fs.lstatSync(resolvedPath, { bigint: true });
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink()) {
    throw new Error(`Snow-RF source must be a regular non-symlink file: ${resolvedPath}.`);
  }
  const descriptor = fs.openSync(resolvedPath, "r");
  let before;
  let after;
  let bytes;
  try {
    before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new Error(`Snow-RF source descriptor is not a regular file: ${resolvedPath}.`);
    }
    bytes = fs.readFileSync(descriptor);
    after = fs.fstatSync(descriptor, { bigint: true });
  } finally {
    fs.closeSync(descriptor);
  }
  const pathAfter = fs.lstatSync(resolvedPath, { bigint: true });
  const beforeIdentity = stableFileIdentity(before);
  if (
    !sameJson(beforeIdentity, stableFileIdentity(after)) ||
    !sameJson(beforeIdentity, stableFileIdentity(pathBefore)) ||
    !sameJson(beforeIdentity, stableFileIdentity(pathAfter))
  ) {
    throw new Error("Snow-RF source identity changed around its descriptor-captured read.");
  }
  const identity = Object.freeze({
    artifactRequired: SNOW_RF_SOURCE_IDENTITY.artifactRequired,
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
  });
  assertFrozenSourceIdentity(identity);
  return Object.freeze({
    identity,
    fileIdentity: Object.freeze(beforeIdentity),
    bytes: retainBytes ? bytes : null,
  });
}

function assertFrozenSourceIdentity(identity) {
  if (!sameJson(identity, SNOW_RF_SOURCE_IDENTITY)) {
    throw new Error(
      `Snow-RF source differs from the frozen oracle: expected=${JSON.stringify(
        SNOW_RF_SOURCE_IDENTITY,
      )} actual=${JSON.stringify(identity)}.`,
    );
  }
}

function stableFileIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    links: String(stat.nlink),
    uid: String(stat.uid),
    gid: String(stat.gid),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function resolveOutputPaths(outputDir) {
  const resolvedOutputDir = path.resolve(outputDir);
  return Object.freeze({
    outputDir: resolvedOutputDir,
    binaryPath: path.join(resolvedOutputDir, path.basename(DEFAULT_BINARY_PATH)),
    manifestPath: path.join(resolvedOutputDir, path.basename(DEFAULT_MANIFEST_PATH)),
    lockPath: path.join(resolvedOutputDir, PUBLICATION_LOCK_BASENAME),
  });
}

function inspectOutputDirectory(outputDir) {
  const stat = fs.lstatSync(outputDir, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Snow-RF output directory must be a real directory: ${outputDir}.`);
  }
  return Object.freeze(stableDirectoryIdentity(stat));
}

function assertOutputDirectoryIdentity(outputDir, expected) {
  const actual = inspectOutputDirectory(outputDir);
  if (!sameJson(actual, expected)) {
    throw new Error(`Snow-RF output directory identity changed during publication: ${outputDir}.`);
  }
}

function stableDirectoryIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
  };
}

function fsyncOutputDirectory(outputDir, expectedIdentity = inspectOutputDirectory(outputDir)) {
  assertOutputDirectoryIdentity(outputDir, expectedIdentity);
  const descriptor = fs.openSync(outputDir, fs.constants.O_RDONLY);
  let primaryError = null;
  try {
    assertDirectoryDescriptorIdentity(descriptor, expectedIdentity, outputDir);
    fs.fsyncSync(descriptor);
    assertDirectoryDescriptorIdentity(descriptor, expectedIdentity, outputDir);
  } catch (error) {
    primaryError = error;
  }
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    primaryError = primaryError
      ? new AggregateError(
          [primaryError, error],
          `Snow-RF output-directory fsync and descriptor close failed for ${outputDir}.`,
        )
      : error;
  }
  if (primaryError) {
    throw primaryError;
  }
  assertOutputDirectoryIdentity(outputDir, expectedIdentity);
}

function assertDirectoryDescriptorIdentity(descriptor, expectedIdentity, outputDir) {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameJson(stableDirectoryIdentity(stat), expectedIdentity)) {
    throw new Error(`Snow-RF output directory descriptor identity changed during publication: ${outputDir}.`);
  }
}

function writeExclusiveOwnedFile(filePath, bytes, mode, directoryContext = null) {
  const descriptor = fs.openSync(filePath, "wx", mode);
  let identity = null;
  let primaryError = null;
  try {
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    identity = stableOwnedFileIdentity(fs.fstatSync(descriptor, { bigint: true }));
  } catch (error) {
    primaryError = error;
    try {
      identity = stableOwnedFileIdentity(fs.fstatSync(descriptor, { bigint: true }));
    } catch (identityError) {
      primaryError = new AggregateError(
        [primaryError, identityError],
        `Snow-RF owned-file write and identity capture failed for ${filePath}.`,
      );
    }
  }
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    primaryError = primaryError
      ? new AggregateError(
          [primaryError, error],
          `Snow-RF owned-file write and descriptor close failed for ${filePath}.`,
        )
      : error;
  }
  if (primaryError) {
    let cleanupError = null;
    if (identity) {
      try {
        unlinkOwnedPath(filePath, identity, directoryContext);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        `Snow-RF owned-file write and safe cleanup failed for ${filePath}.`,
      );
    }
    throw primaryError;
  }
  assertOwnedPath(filePath, identity);
  return Object.freeze(identity);
}

function stableOwnedFileIdentity(stat) {
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    uid: String(stat.uid),
    gid: String(stat.gid),
    mode: String(stat.mode),
    links: String(stat.nlink),
    size: String(stat.size),
  };
}

function assertOwnedPath(filePath, expected) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  const actual = stableOwnedFileIdentity(stat);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !sameJson(actual, expected)) {
    throw new Error(`Refusing to operate on replaced or multiply linked owned file ${filePath}.`);
  }
  return Object.freeze(actual);
}

function inspectOwnedPath(filePath) {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error(`Snow-RF published path must be a regular non-symlink single-link file: ${filePath}.`);
  }
  return Object.freeze(stableOwnedFileIdentity(stat));
}

function readOwnedPublishedFile(filePath, expectedIdentity, directoryContext) {
  const { outputDir, outputDirectoryIdentity } = directoryContext;
  assertOutputDirectoryIdentity(outputDir, outputDirectoryIdentity);
  assertOwnedPath(filePath, expectedIdentity);
  const descriptor = fs.openSync(filePath, "r");
  let bytes;
  let primaryError = null;
  try {
    assertOwnedDescriptor(descriptor, expectedIdentity, filePath);
    bytes = fs.readFileSync(descriptor);
    assertOwnedDescriptor(descriptor, expectedIdentity, filePath);
  } catch (error) {
    primaryError = error;
  }
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    primaryError = primaryError
      ? new AggregateError(
          [primaryError, error],
          `Snow-RF published-file reread and descriptor close failed for ${filePath}.`,
        )
      : error;
  }
  if (primaryError) {
    throw primaryError;
  }
  assertOwnedPath(filePath, expectedIdentity);
  assertOutputDirectoryIdentity(outputDir, outputDirectoryIdentity);
  return bytes;
}

function assertOwnedDescriptor(descriptor, expectedIdentity, filePath) {
  const stat = fs.fstatSync(descriptor, { bigint: true });
  const actual = stableOwnedFileIdentity(stat);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !sameJson(actual, expectedIdentity)) {
    throw new Error(`Snow-RF published descriptor identity changed for ${filePath}.`);
  }
}

function unlinkOwnedPath(filePath, identity, directoryContext = null) {
  const outputDir = directoryContext?.outputDir || path.dirname(filePath);
  const outputDirectoryIdentity = directoryContext?.outputDirectoryIdentity || inspectOutputDirectory(outputDir);
  assertOutputDirectoryIdentity(outputDir, outputDirectoryIdentity);
  assertOwnedPath(filePath, identity);
  fs.unlinkSync(filePath);
  fsyncOutputDirectory(outputDir, outputDirectoryIdentity);
}

function checkGeneratedFile(filePath, expected) {
  let actual;
  try {
    actual = fs.readFileSync(filePath);
  } catch (error) {
    throw new Error(`Generated Snow-RF asset is missing at ${filePath}: ${error.message}`, {
      cause: error,
    });
  }
  if (!actual.equals(expected)) {
    throw new Error(
      `Generated Snow-RF asset is stale at ${filePath}; run ` +
        "`npm run noaa:snow-rf:generate` and commit both outputs.",
    );
  }
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
    throw new Error(`Unknown Snow-RF generator option ${JSON.stringify(token)}.`);
  }
  if (mode === null) {
    throw new Error("Usage: node scripts/generate-noaa-snow-rf-asset.js --write|--check [--output-dir=PATH]");
  }
  return { mode, outputDir };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[noaa-snow-rf] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  PUBLICATION_LOCK_BASENAME,
  assertGenerationInputsStable,
  captureSnowRfSource,
  checkGeneratedFile,
  fsyncOutputDirectory,
  generateSnowRfAsset,
  inspectOwnedPath,
  main,
  parseGeneratorOptions,
  publishSnowRfAsset,
  readOwnedPublishedFile,
  rereadAndValidatePublishedPair,
  resolveOutputPaths,
  withSnowRfPublicationLock,
};
