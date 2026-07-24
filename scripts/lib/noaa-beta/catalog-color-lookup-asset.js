"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  CONTINUOUS_COLOR_LOOKUP_COMPILER_ID,
  canonicalContinuousColorLookupRecipeBytes,
  compileContinuousColorLookupRecipe,
  materializeContinuousColorLookupRecipe,
} = require("./color-lookup-compiler");

const CATALOG_COLOR_LOOKUP_ENV = "MODELVIEW_NOAA_COLOR_LOOKUPS";
const CATALOG_COLOR_LOOKUP_ASSET_SCHEMA_VERSION = 1;
const CATALOG_COLOR_LOOKUP_ASSET_ALIGNMENT = 4;
const GENERATED_ASSET_BASENAME = "catalog-color-lookups-v1";
const CATALOG_COLOR_LOOKUP_RECIPE_ENCODING = "ieee754-f64be-hex-v1";
const CATALOG_COLOR_LOOKUP_INPUT_ENCODING = "ordered-id-canonical-recipe-nul-v1";
const CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING = "sorted-id-palette-sha256-byte-length-nul-v1";
const CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256 =
  "7ce7ec6c56506eecea40d197a18ae1c847217d95439850747838c4eb122fe964";
const DEFAULT_MANIFEST_PATH = path.join(__dirname, "generated", `${GENERATED_ASSET_BASENAME}.json`);
const DEFAULT_BINARY_PATH = path.join(__dirname, "generated", `${GENERATED_ASSET_BASENAME}.bin`);
const DEFAULT_COMPILER_PATH = require.resolve("./color-lookup-compiler");
const DEFAULT_COMPILER_DEPENDENCY_PATH = require.resolve("./util");
const CATALOG_COLOR_LOOKUP_COMPILER_CLOSURE_ENCODING = "ordered-file-bytes-nul-v1";
const CATALOG_COLOR_LOOKUP_RECEIPT_SCHEMA_VERSION = 1;
const CATALOG_COLOR_LOOKUP_RECEIPT_TYPE = "noaa-color-lookup-state";
const CATALOG_COLOR_LOOKUP_STATUS_FIELDS = Object.freeze([
  "assignmentCount",
  "paletteCount",
  "logicalColorBytes",
  "readMs",
  "validateMs",
  "materializeMs",
  "compileMs",
  "fallbackAttemptMs",
  "totalMs",
]);

let warnedAboutAutoFallback = false;
let warnedAboutUnknownMode = false;

function resolveCatalogColorLookupMode(value = process.env[CATALOG_COLOR_LOOKUP_ENV], { warn = console.warn } = {}) {
  const normalized =
    value === undefined || value === null || value === "" ? "auto" : String(value).trim().toLowerCase();
  if (normalized === "auto" || normalized === "dynamic" || normalized === "precompiled") {
    return normalized;
  }
  if (!warnedAboutUnknownMode) {
    warnedAboutUnknownMode = true;
    warn(
      `[noaa-color-lookups] ${CATALOG_COLOR_LOOKUP_ENV} must be 'auto', 'dynamic', or 'precompiled'; ` +
        `received ${JSON.stringify(value)}. Building the complete lookup roster dynamically.`,
    );
  }
  return "dynamic";
}

function loadCatalogColorLookupRoster({
  assignments,
  mode = process.env[CATALOG_COLOR_LOOKUP_ENV],
  manifestPath = DEFAULT_MANIFEST_PATH,
  binaryPath = DEFAULT_BINARY_PATH,
  compilerPath = DEFAULT_COMPILER_PATH,
  compilerDependencyPath = DEFAULT_COMPILER_DEPENDENCY_PATH,
  warn = console.warn,
} = {}) {
  const totalStartedAt = performance.now();
  const resolvedMode = resolveCatalogColorLookupMode(mode, { warn });
  const normalizedAssignments = normalizeAssignments(assignments);
  if (resolvedMode === "dynamic") {
    return buildDynamicRoster(normalizedAssignments, {
      requestedMode: resolvedMode,
      fallbackReason: null,
      fallbackReasonCode: null,
      totalStartedAt,
    });
  }
  try {
    return loadPrecompiledRoster({
      assignments: normalizedAssignments,
      manifestPath,
      binaryPath,
      compilerPath,
      compilerDependencyPath,
      requestedMode: resolvedMode,
      totalStartedAt,
    });
  } catch (error) {
    if (resolvedMode === "precompiled") {
      const strictError = new Error(`Strict precompiled NOAA color lookup loading failed: ${error.message}`, {
        cause: error,
      });
      strictError.code = "ERR_NOAA_COLOR_LOOKUP_PRECOMPILED";
      strictError.reasonCode = classifyCatalogColorLookupFailure(error);
      throw strictError;
    }
    if (!warnedAboutAutoFallback) {
      warnedAboutAutoFallback = true;
      warn(
        `[noaa-color-lookups] Precompiled lookup asset validation failed; ` +
          `building the complete lookup roster dynamically. ${error.message}`,
      );
    }
    return buildDynamicRoster(normalizedAssignments, {
      requestedMode: resolvedMode,
      fallbackReason: error.message,
      fallbackReasonCode: classifyCatalogColorLookupFailure(error),
      fallbackAttemptMs: performance.now() - totalStartedAt,
      totalStartedAt,
    });
  }
}

// The benchmark sideband must never serialize the live lookup Map, its
// independently owned palette buffers, or the WeakRef used by ownership
// tests. Copy only the immutable treatment identity and timings needed to
// prove what each process/thread actually loaded.
function buildCatalogColorLookupStateSnapshot(state) {
  if (!isPlainObject(state) || !isPlainObject(state.identity) || !isPlainObject(state.status)) {
    throw new Error("Cannot snapshot an invalid catalog color lookup state.");
  }
  const expectedAssignmentMappingSha256 =
    state.effectiveMode === "precompiled"
      ? CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256
      : state.effectiveMode === "dynamic"
        ? null
        : undefined;
  if (
    expectedAssignmentMappingSha256 === undefined ||
    !Object.hasOwn(state.identity, "assignmentMappingSha256") ||
    state.identity.assignmentMappingSha256 !== expectedAssignmentMappingSha256
  ) {
    throw new Error("Cannot snapshot a catalog color lookup state with an invalid assignment mapping identity.");
  }
  const status = {};
  for (const field of CATALOG_COLOR_LOOKUP_STATUS_FIELDS) {
    const value = state.status[field];
    if (field === "paletteCount" && value === null) {
      status[field] = null;
      continue;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Cannot snapshot invalid catalog color lookup status field '${field}'.`);
    }
    status[field] = value;
  }
  return {
    requestedMode: state.requestedMode,
    effectiveMode: state.effectiveMode,
    fallbackReason: state.fallbackReason,
    fallbackReasonCode: state.fallbackReasonCode,
    identity: {
      compilerId: state.identity.compilerId,
      compilerClosureSha256: state.identity.compilerClosureSha256 ?? null,
      inputSha256: state.identity.inputSha256,
      assignmentMappingSha256: state.identity.assignmentMappingSha256,
      binarySha256: state.identity.binarySha256 ?? null,
      binaryByteLength: state.identity.binaryByteLength ?? null,
      assignmentCount: state.identity.assignmentCount,
      paletteCount: state.identity.paletteCount ?? null,
    },
    status,
  };
}

function buildCatalogColorLookupBenchmarkReceipt(
  state,
  { role, spawnOrdinal, processId = process.pid, threadId = 0 } = {},
) {
  if (role !== "builder-main" && role !== "frame-worker") {
    throw new Error(`Invalid catalog color lookup benchmark receipt role '${String(role)}'.`);
  }
  if (!Number.isSafeInteger(spawnOrdinal) || spawnOrdinal < 0) {
    throw new Error("Catalog color lookup benchmark receipt spawnOrdinal must be a nonnegative integer.");
  }
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("Catalog color lookup benchmark receipt processId must be a positive integer.");
  }
  if (!Number.isSafeInteger(threadId) || threadId < 0) {
    throw new Error("Catalog color lookup benchmark receipt threadId must be a nonnegative integer.");
  }
  return {
    schemaVersion: CATALOG_COLOR_LOOKUP_RECEIPT_SCHEMA_VERSION,
    type: CATALOG_COLOR_LOOKUP_RECEIPT_TYPE,
    role,
    spawnOrdinal,
    processId,
    threadId,
    state: buildCatalogColorLookupStateSnapshot(state),
  };
}

function buildDynamicRoster(
  assignments,
  {
    requestedMode = "dynamic",
    fallbackReason = null,
    fallbackReasonCode = null,
    fallbackAttemptMs = 0,
    totalStartedAt = performance.now(),
  } = {},
) {
  const compileStartedAt = performance.now();
  const lookups = new Map();
  let logicalColorBytes = 0;
  for (const assignment of assignments) {
    const lookup = compileContinuousColorLookupRecipe(assignment.recipe);
    lookups.set(assignment.id, lookup);
    logicalColorBytes += lookup.colors.byteLength;
  }
  const compileMs = performance.now() - compileStartedAt;
  const input = buildCanonicalCatalogColorLookupInput(assignments);
  return Object.freeze({
    requestedMode,
    effectiveMode: "dynamic",
    fallbackReason,
    fallbackReasonCode,
    identity: Object.freeze({
      compilerId: CONTINUOUS_COLOR_LOOKUP_COMPILER_ID,
      inputSha256: input.sha256,
      assignmentMappingSha256: null,
      assignmentCount: assignments.length,
    }),
    status: Object.freeze({
      assignmentCount: assignments.length,
      paletteCount: null,
      logicalColorBytes,
      readMs: 0,
      validateMs: 0,
      materializeMs: 0,
      compileMs,
      fallbackAttemptMs,
      totalMs: performance.now() - totalStartedAt,
    }),
    lookups,
    assetOwnerWeakRef: null,
  });
}

function loadPrecompiledRoster({
  assignments,
  manifestPath,
  binaryPath,
  compilerPath,
  compilerDependencyPath,
  requestedMode = "precompiled",
  totalStartedAt = performance.now(),
}) {
  const readStartedAt = performance.now();
  const manifestBytes = fs.readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Color lookup manifest is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
  const compilerClosure = buildCatalogColorLookupCompilerClosure({
    compilerPath,
    compilerDependencyPath,
  });
  const binaryOwner = { bytes: fs.readFileSync(binaryPath) };
  const readMs = performance.now() - readStartedAt;
  const assetOwnerWeakRef = typeof WeakRef === "function" ? new WeakRef(binaryOwner) : null;
  const validateStartedAt = performance.now();
  const input = buildCanonicalCatalogColorLookupInput(assignments);
  validateAssetManifest({
    manifest,
    input,
    assignments,
    compilerClosure,
    binary: binaryOwner.bytes,
    binaryPath,
  });
  const validateMs = performance.now() - validateStartedAt;

  const materializeStartedAt = performance.now();
  const assignmentEntries = new Map(manifest.assignments.map((entry) => [entry.id, entry]));
  const paletteEntries = new Map(manifest.palettes.map((entry) => [entry.sha256, entry]));
  const lookups = new Map();
  const ownedBuffers = [];
  for (const assignment of assignments) {
    const assignmentEntry = assignmentEntries.get(assignment.id);
    const palette = paletteEntries.get(assignmentEntry.paletteSha256);
    const colors = new Uint8Array(palette.byteLength);
    colors.set(binaryOwner.bytes.subarray(palette.offset, palette.offset + palette.byteLength));
    const lookup = materializeContinuousColorLookupRecipe(assignment.recipe, colors);
    lookups.set(assignment.id, lookup);
    ownedBuffers.push(colors.buffer);
  }
  if (new Set(ownedBuffers).size !== ownedBuffers.length) {
    throw new Error("Precompiled color lookup assignments unexpectedly share an ArrayBuffer.");
  }
  const materializeMs = performance.now() - materializeStartedAt;

  const identity = Object.freeze({
    schemaVersion: manifest.schemaVersion,
    compilerId: manifest.compiler.id,
    compilerClosureSha256: manifest.compiler.closure.sha256,
    compilerFiles: Object.freeze(
      manifest.compiler.closure.files.map((file) =>
        Object.freeze({
          name: file.name,
          byteLength: file.byteLength,
          sha256: file.sha256,
        }),
      ),
    ),
    inputSha256: manifest.input.sha256,
    assignmentMappingSha256: manifest.assignmentMapping.sha256,
    binarySha256: manifest.binary.sha256,
    binaryByteLength: manifest.binary.byteLength,
    assignmentCount: manifest.input.assignmentCount,
    paletteCount: manifest.paletteCount,
  });
  return Object.freeze({
    requestedMode,
    effectiveMode: "precompiled",
    fallbackReason: null,
    fallbackReasonCode: null,
    identity,
    status: Object.freeze({
      assignmentCount: manifest.input.assignmentCount,
      paletteCount: manifest.paletteCount,
      logicalColorBytes: assignments.reduce((sum, assignment) => sum + assignment.recipe.size * 4, 0),
      readMs,
      validateMs,
      materializeMs,
      compileMs: 0,
      fallbackAttemptMs: 0,
      totalMs: performance.now() - totalStartedAt,
    }),
    lookups,
    assetOwnerWeakRef,
  });
}

function validateAssetManifest({ manifest, input, assignments, compilerClosure, binary, binaryPath }) {
  if (!isPlainObject(manifest)) {
    throw new Error("Color lookup manifest root must be an object.");
  }
  if (manifest.schemaVersion !== CATALOG_COLOR_LOOKUP_ASSET_SCHEMA_VERSION) {
    throw new Error(
      `Color lookup manifest schema ${String(manifest.schemaVersion)} does not match ` +
        `${CATALOG_COLOR_LOOKUP_ASSET_SCHEMA_VERSION}.`,
    );
  }
  if (
    !isPlainObject(manifest.compiler) ||
    manifest.compiler.id !== CONTINUOUS_COLOR_LOOKUP_COMPILER_ID ||
    !isCompilerClosure(manifest.compiler.closure) ||
    JSON.stringify(manifest.compiler.closure) !== JSON.stringify(compilerClosure)
  ) {
    throw new Error("Color lookup manifest compiler closure does not match the authoritative compiler sources.");
  }
  if (
    !isPlainObject(manifest.input) ||
    manifest.input.assignmentCount !== assignments.length ||
    manifest.input.recipeEncoding !== CATALOG_COLOR_LOOKUP_RECIPE_ENCODING ||
    manifest.input.encoding !== CATALOG_COLOR_LOOKUP_INPUT_ENCODING ||
    !isSha256(manifest.input.sha256) ||
    manifest.input.sha256 !== input.sha256
  ) {
    throw new Error("Color lookup manifest input identity or assignment count does not match the resolved recipes.");
  }
  if (
    !isPlainObject(manifest.binary) ||
    manifest.binary.file !== path.basename(binaryPath) ||
    manifest.binary.alignment !== CATALOG_COLOR_LOOKUP_ASSET_ALIGNMENT ||
    !Number.isSafeInteger(manifest.binary.byteLength) ||
    manifest.binary.byteLength < 0 ||
    binary.byteLength !== manifest.binary.byteLength ||
    !isSha256(manifest.binary.sha256) ||
    sha256(binary) !== manifest.binary.sha256
  ) {
    throw new Error("Color lookup binary length, alignment, filename, or whole-file digest is invalid.");
  }
  if (
    !Number.isSafeInteger(manifest.paletteCount) ||
    manifest.paletteCount < 1 ||
    manifest.paletteCount > assignments.length ||
    !Array.isArray(manifest.palettes) ||
    manifest.palettes.length !== manifest.paletteCount
  ) {
    throw new Error("Color lookup palette count is invalid.");
  }
  validatePalettes(manifest.palettes, binary);
  validateManifestAssignments(manifest.assignments, input.assignments, manifest.palettes);
  const assignmentMapping = buildCatalogColorLookupAssignmentMappingIdentity(manifest.assignments);
  if (
    !isPlainObject(manifest.assignmentMapping) ||
    manifest.assignmentMapping.encoding !== CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING ||
    manifest.assignmentMapping.assignmentCount !== assignments.length ||
    !isSha256(manifest.assignmentMapping.sha256) ||
    manifest.assignmentMapping.sha256 !== assignmentMapping.sha256 ||
    assignmentMapping.sha256 !== CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256
  ) {
    throw new Error("Color lookup manifest assignment mapping does not match the source-pinned compiled output.");
  }
  const referencedPalettes = new Set(manifest.assignments.map((entry) => entry.paletteSha256));
  const declaredPalettes = new Set(manifest.palettes.map((entry) => entry.sha256));
  if (
    referencedPalettes.size !== declaredPalettes.size ||
    [...declaredPalettes].some((digest) => !referencedPalettes.has(digest))
  ) {
    throw new Error("Color lookup manifest contains an unreferenced or undeclared palette.");
  }
}

function validatePalettes(palettes, binary) {
  let expectedOffset = 0;
  let previousSha = null;
  const seen = new Set();
  for (const palette of palettes) {
    if (
      !isPlainObject(palette) ||
      !isSha256(palette.sha256) ||
      !Number.isSafeInteger(palette.offset) ||
      !Number.isSafeInteger(palette.byteLength) ||
      palette.byteLength <= 0 ||
      palette.byteLength % CATALOG_COLOR_LOOKUP_ASSET_ALIGNMENT !== 0 ||
      palette.offset % CATALOG_COLOR_LOOKUP_ASSET_ALIGNMENT !== 0
    ) {
      throw new Error("Color lookup palette metadata contains an invalid digest, offset, alignment, or length.");
    }
    if (seen.has(palette.sha256)) {
      throw new Error(`Color lookup palette digest ${palette.sha256} is duplicated.`);
    }
    if (previousSha !== null && compareAscii(palette.sha256, previousSha) <= 0) {
      throw new Error("Color lookup palettes are not strictly sorted by SHA-256.");
    }
    if (palette.offset !== expectedOffset) {
      throw new Error("Color lookup palettes must form one gap-free, non-overlapping binary layout.");
    }
    const end = palette.offset + palette.byteLength;
    if (!Number.isSafeInteger(end) || end > binary.byteLength) {
      throw new Error("Color lookup palette range extends outside the binary asset.");
    }
    if (sha256(binary.subarray(palette.offset, end)) !== palette.sha256) {
      throw new Error(`Color lookup palette ${palette.sha256} has a mismatched slice digest.`);
    }
    seen.add(palette.sha256);
    previousSha = palette.sha256;
    expectedOffset = end;
  }
  if (expectedOffset !== binary.byteLength) {
    throw new Error("Color lookup palette layout does not consume the complete binary asset.");
  }
}

function validateManifestAssignments(manifestAssignments, inputAssignments, palettes) {
  if (!Array.isArray(manifestAssignments) || manifestAssignments.length !== inputAssignments.length) {
    throw new Error("Color lookup manifest assignment coverage is incomplete.");
  }
  const paletteBySha = new Map(palettes.map((entry) => [entry.sha256, entry]));
  const seen = new Set();
  let previousId = null;
  for (let index = 0; index < manifestAssignments.length; index += 1) {
    const entry = manifestAssignments[index];
    const expected = inputAssignments[index];
    if (
      !isPlainObject(entry) ||
      typeof entry.id !== "string" ||
      !isSha256(entry.paletteSha256) ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength <= 0
    ) {
      throw new Error("Color lookup manifest contains malformed assignment metadata.");
    }
    if (seen.has(entry.id) || (previousId !== null && compareAscii(entry.id, previousId) <= 0)) {
      throw new Error("Color lookup manifest assignments must be unique and strictly sorted by ID.");
    }
    if (entry.id !== expected.id || entry.byteLength !== expected.byteLength) {
      throw new Error(`Color lookup assignment ${entry.id} does not match its canonical resolved recipe.`);
    }
    const palette = paletteBySha.get(entry.paletteSha256);
    if (!palette || palette.byteLength !== entry.byteLength) {
      throw new Error(`Color lookup assignment ${entry.id} references a missing or wrong-sized palette.`);
    }
    seen.add(entry.id);
    previousId = entry.id;
  }
}

function normalizeAssignments(assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new Error("Color lookup assignments must be a non-empty array.");
  }
  const normalized = assignments
    .map((assignment) => {
      const id = String(assignment?.id || "");
      if (!id || id.includes("\0")) {
        throw new Error("Color lookup assignment IDs must be non-empty strings without NUL bytes.");
      }
      return Object.freeze({
        id,
        recipe: assignment?.recipe,
      });
    })
    .sort((left, right) => compareAscii(left.id, right.id));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].id === normalized[index].id) {
      throw new Error(`Color lookup assignment ID ${normalized[index].id} is duplicated.`);
    }
  }
  return Object.freeze(normalized);
}

function buildCanonicalCatalogColorLookupInput(assignments) {
  const normalized = normalizeAssignments(assignments);
  const hash = crypto.createHash("sha256");
  hash.update(
    `${CATALOG_COLOR_LOOKUP_INPUT_ENCODING}\0${CATALOG_COLOR_LOOKUP_ASSET_SCHEMA_VERSION}\0` +
      `${CONTINUOUS_COLOR_LOOKUP_COMPILER_ID}\0${CATALOG_COLOR_LOOKUP_RECIPE_ENCODING}\0`,
  );
  const canonicalRecipeBytes = new WeakMap();
  const canonicalAssignments = normalized.map(({ id, recipe }) => {
    let recipeBytes = canonicalRecipeBytes.get(recipe);
    if (!recipeBytes) {
      recipeBytes = canonicalContinuousColorLookupRecipeBytes(recipe);
      canonicalRecipeBytes.set(recipe, recipeBytes);
    }
    hash.update(`${id}\0${recipeBytes.byteLength}\0`);
    hash.update(recipeBytes);
    return {
      id,
      byteLength: recipe.size * 4,
    };
  });
  return Object.freeze({
    sha256: hash.digest("hex"),
    assignments: Object.freeze(canonicalAssignments.map((assignment) => Object.freeze(assignment))),
  });
}

function buildCatalogColorLookupAssignmentMappingIdentity(assignments) {
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw new Error("Color lookup assignment mapping must be a non-empty array.");
  }
  const normalized = assignments
    .map((assignment) => {
      const id = String(assignment?.id || "");
      if (
        !id ||
        id.includes("\0") ||
        !isSha256(assignment?.paletteSha256) ||
        !Number.isSafeInteger(assignment?.byteLength) ||
        assignment.byteLength <= 0
      ) {
        throw new Error("Color lookup assignment mapping contains a malformed row.");
      }
      return {
        id,
        paletteSha256: assignment.paletteSha256,
        byteLength: assignment.byteLength,
      };
    })
    .sort((left, right) => compareAscii(left.id, right.id));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].id === normalized[index].id) {
      throw new Error(`Color lookup assignment mapping ID ${normalized[index].id} is duplicated.`);
    }
  }
  const hash = crypto.createHash("sha256");
  hash.update(
    `${CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING}\0` +
      `${CATALOG_COLOR_LOOKUP_ASSET_SCHEMA_VERSION}\0${normalized.length}\0`,
  );
  for (const assignment of normalized) {
    hash.update(`${assignment.id}\0${assignment.paletteSha256}\0${assignment.byteLength}\0`);
  }
  return Object.freeze({
    encoding: CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING,
    assignmentCount: normalized.length,
    sha256: hash.digest("hex"),
  });
}

function resetCatalogColorLookupWarningsForTest() {
  warnedAboutAutoFallback = false;
  warnedAboutUnknownMode = false;
}

function buildCatalogColorLookupCompilerClosure({
  compilerPath = DEFAULT_COMPILER_PATH,
  compilerDependencyPath = DEFAULT_COMPILER_DEPENDENCY_PATH,
} = {}) {
  const sources = [
    { name: "color-lookup-compiler.js", filePath: compilerPath },
    { name: "util.js", filePath: compilerDependencyPath },
  ];
  const hash = crypto.createHash("sha256");
  hash.update(`${CATALOG_COLOR_LOOKUP_COMPILER_CLOSURE_ENCODING}\0`);
  const files = sources.map(({ name, filePath }) => {
    const bytes = fs.readFileSync(filePath);
    hash.update(`${name}\0${bytes.byteLength}\0`);
    hash.update(bytes);
    return Object.freeze({
      name,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
  });
  return Object.freeze({
    encoding: CATALOG_COLOR_LOOKUP_COMPILER_CLOSURE_ENCODING,
    sha256: hash.digest("hex"),
    files: Object.freeze(files),
  });
}

function classifyCatalogColorLookupFailure(error) {
  if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EISDIR") {
    return "asset-read-failed";
  }
  if (/not valid JSON/i.test(String(error?.message || ""))) {
    return "manifest-json-invalid";
  }
  return "asset-validation-failed";
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompilerClosure(value) {
  return (
    isPlainObject(value) &&
    value.encoding === CATALOG_COLOR_LOOKUP_COMPILER_CLOSURE_ENCODING &&
    isSha256(value.sha256) &&
    Array.isArray(value.files) &&
    value.files.length === 2 &&
    value.files.every(
      (file) =>
        isPlainObject(file) &&
        (file.name === "color-lookup-compiler.js" || file.name === "util.js") &&
        Number.isSafeInteger(file.byteLength) &&
        file.byteLength > 0 &&
        isSha256(file.sha256),
    ) &&
    value.files[0].name === "color-lookup-compiler.js" &&
    value.files[1].name === "util.js"
  );
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

module.exports = {
  CATALOG_COLOR_LOOKUP_ASSET_ALIGNMENT,
  CATALOG_COLOR_LOOKUP_ASSET_SCHEMA_VERSION,
  CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_ENCODING,
  CATALOG_COLOR_LOOKUP_ASSIGNMENT_MAPPING_SHA256,
  CATALOG_COLOR_LOOKUP_COMPILER_CLOSURE_ENCODING,
  CATALOG_COLOR_LOOKUP_ENV,
  CATALOG_COLOR_LOOKUP_INPUT_ENCODING,
  CATALOG_COLOR_LOOKUP_RECIPE_ENCODING,
  CATALOG_COLOR_LOOKUP_RECEIPT_SCHEMA_VERSION,
  CATALOG_COLOR_LOOKUP_RECEIPT_TYPE,
  DEFAULT_BINARY_PATH,
  DEFAULT_COMPILER_PATH,
  DEFAULT_COMPILER_DEPENDENCY_PATH,
  DEFAULT_MANIFEST_PATH,
  GENERATED_ASSET_BASENAME,
  _resetCatalogColorLookupWarningsForTest: resetCatalogColorLookupWarningsForTest,
  buildCanonicalCatalogColorLookupInput,
  buildCatalogColorLookupAssignmentMappingIdentity,
  buildCatalogColorLookupBenchmarkReceipt,
  buildCatalogColorLookupCompilerClosure,
  buildCatalogColorLookupStateSnapshot,
  buildDynamicRoster,
  classifyCatalogColorLookupFailure,
  compareAscii,
  loadCatalogColorLookupRoster,
  normalizeAssignments,
  resolveCatalogColorLookupMode,
  sha256,
  validateAssetManifest,
};
