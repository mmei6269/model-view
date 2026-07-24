#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { PNG } = require("pngjs");
const { collectFrameArtifactKeys } = require("./lib/local-artifact-manifest");
const { decodeHoverGridBinaryRaw } = require("./lib/hover-grid-binary");

const REPORT_SCHEMA_VERSION = 3;
const MAX_JSON_DIFFERENCE_DETAILS = 50;
const MAX_PNG_CONTAINER_CHANGE_DETAILS = 100;
const MAX_HOVER_CONTAINER_CHANGE_DETAILS = 100;
const PNG_COMPARISON_CONTAINER = "container";
const PNG_COMPARISON_DECODED_RGBA = "decoded-rgba";
const PNG_COMPARISON_MODES = Object.freeze([PNG_COMPARISON_CONTAINER, PNG_COMPARISON_DECODED_RGBA]);
const HOVER_COMPARISON_CONTAINER = "container";
const HOVER_COMPARISON_DECODED_INT16 = "decoded-int16";
const HOVER_COMPARISON_MODES = Object.freeze([HOVER_COMPARISON_CONTAINER, HOVER_COMPARISON_DECODED_INT16]);
const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([0x0102]).buffer)[0] === 0x02;
const MANIFEST_SPEC_PATTERN = /^(?<model>[a-z0-9][a-z0-9-]*)\/(?<run>\d{8}-\d{4}Z)--(?<view>[a-z0-9][a-z0-9-]*)\.json$/;
const KNOWN_FLAGS = Object.freeze([
  "baseline-cache-root",
  "candidate-cache-root",
  "manifest",
  "png-comparison",
  "hover-comparison",
  "help",
]);

function parseArgs(argv) {
  const parsed = { manifests: [] };
  for (const token of argv) {
    const value = String(token);
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    if (!value.startsWith("--") || !value.includes("=")) {
      throw new Error(`Unknown argument ${JSON.stringify(value)}; flags must use --name=value`);
    }
    const separator = value.indexOf("=");
    const name = value.slice(2, separator);
    const flagValue = value.slice(separator + 1);
    if (!KNOWN_FLAGS.includes(name) || name === "help") {
      throw new Error(`Unknown flag --${name}; known flags: ${KNOWN_FLAGS.map((flag) => `--${flag}`).join(", ")}`);
    }
    if (!flagValue.trim()) {
      throw new Error(`--${name} may not be blank`);
    }
    if (name === "manifest") {
      parsed.manifests.push(flagValue);
    } else {
      if (Object.hasOwn(parsed, name)) {
        throw new Error(`--${name} may only be specified once`);
      }
      parsed[name] = flagValue;
    }
  }
  return parsed;
}

function normalizeOptions(args) {
  const baselineCacheRoot = resolveCacheRoot(args["baseline-cache-root"], "--baseline-cache-root");
  const candidateCacheRoot = resolveCacheRoot(args["candidate-cache-root"], "--candidate-cache-root");
  const pngComparison = normalizePngComparisonMode(args["png-comparison"]);
  const hoverComparison = normalizeHoverComparisonMode(args["hover-comparison"]);
  if (baselineCacheRoot === candidateCacheRoot) {
    throw new Error("baseline and candidate cache roots must be different directories");
  }
  if (!Array.isArray(args.manifests) || args.manifests.length === 0) {
    throw new Error("at least one --manifest=model/run--view.json is required");
  }
  const manifests = args.manifests.map(parseManifestSpec);
  const ids = new Set();
  for (const manifest of manifests) {
    if (ids.has(manifest.id)) {
      throw new Error(`duplicate manifest ${manifest.id}`);
    }
    ids.add(manifest.id);
  }
  manifests.sort((left, right) => left.id.localeCompare(right.id));
  return {
    baselineCacheRoot,
    candidateCacheRoot,
    baselineArtifactRoot: path.join(baselineCacheRoot, "artifacts"),
    candidateArtifactRoot: path.join(candidateCacheRoot, "artifacts"),
    manifests,
    pngComparison,
    hoverComparison,
  };
}

function normalizePngComparisonMode(value) {
  const mode = value === undefined ? PNG_COMPARISON_CONTAINER : String(value).trim();
  if (!PNG_COMPARISON_MODES.includes(mode)) {
    throw new Error(
      `--png-comparison must be one of ${PNG_COMPARISON_MODES.map((entry) => JSON.stringify(entry)).join(", ")}`,
    );
  }
  return mode;
}

function normalizeHoverComparisonMode(value) {
  const mode = value === undefined ? HOVER_COMPARISON_CONTAINER : String(value).trim();
  if (!HOVER_COMPARISON_MODES.includes(mode)) {
    throw new Error(
      `--hover-comparison must be one of ${HOVER_COMPARISON_MODES.map((entry) => JSON.stringify(entry)).join(", ")}`,
    );
  }
  return mode;
}

function resolveCacheRoot(value, flagName) {
  const input = String(value || "").trim();
  if (!input) {
    throw new Error(`${flagName} is required`);
  }
  const cacheRoot = path.resolve(input);
  const artifactRoot = path.join(cacheRoot, "artifacts");
  const manifestsRoot = path.join(artifactRoot, "manifests");
  for (const [label, target] of [
    ["cache root", cacheRoot],
    ["artifact root", artifactRoot],
    ["manifest root", manifestsRoot],
  ]) {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch (error) {
      throw new Error(`${flagName} ${label} is unavailable at ${target}: ${error.message}`, {
        cause: error,
      });
    }
    if (!stat.isDirectory()) {
      throw new Error(`${flagName} ${label} is not a directory: ${target}`);
    }
  }
  return fs.realpathSync(cacheRoot);
}

function parseManifestSpec(value) {
  const id = String(value || "").replaceAll("\\", "/");
  const match = MANIFEST_SPEC_PATTERN.exec(id);
  if (!match) {
    throw new Error(`invalid manifest ${JSON.stringify(value)}; expected canonical model/YYYYMMDD-HHMMZ--view.json`);
  }
  return {
    id,
    model: match.groups.model,
    run: match.groups.run,
    view: match.groups.view,
    relativePath: `manifests/${id}`,
  };
}

function compareArtifactCaches(options) {
  const pngComparison = normalizePngComparisonMode(options.pngComparison);
  const hoverComparison = normalizeHoverComparisonMode(options.hoverComparison);
  const baselineAggregateHash = crypto.createHash("sha256");
  const candidateAggregateHash = crypto.createHash("sha256");
  const baselineInventoryIds = [];
  const candidateInventoryIds = [];
  const manifestReports = [];

  for (const spec of options.manifests) {
    manifestReports.push(
      compareManifestArtifacts({
        spec,
        baselineArtifactRoot: options.baselineArtifactRoot,
        candidateArtifactRoot: options.candidateArtifactRoot,
        baselineAggregateHash,
        candidateAggregateHash,
        baselineInventoryIds,
        candidateInventoryIds,
        pngComparison,
        hoverComparison,
      }),
    );
  }

  const summary = summarizeReports(manifestReports);
  const semanticPngComparison = pngComparison === PNG_COMPARISON_DECODED_RGBA;
  const semanticHoverComparison = hoverComparison === HOVER_COMPARISON_DECODED_INT16;
  const semanticComparison = semanticPngComparison || semanticHoverComparison;
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    comparison: "manifest-referenced-render-artifacts",
    pngComparison,
    hoverComparison,
    exact: summary.mismatches.total === 0,
    roots: {
      baselineCacheRoot: options.baselineCacheRoot,
      candidateCacheRoot: options.candidateCacheRoot,
    },
    requestedManifests: options.manifests.map((manifest) => manifest.id),
    normalization: {
      manifest: {
        removedTopLevelFields: semanticComparison ? ["generatedAt", "rendererSignature"] : ["generatedAt"],
        removedPngReferenceFields: semanticPngComparison ? ["bytes"] : [],
        removedHoverReferenceFields: semanticHoverComparison
          ? ["hoverGridBytes", "hoverGridSchemaVersion", "bytes", "schemaVersion"]
          : [],
        rationale: semanticComparison
          ? "generatedAt is volatile; rendererSignature must transition and is validated separately; selected stored-container identities are normalized only after declared bytes and schema are validated"
          : "generatedAt is the manifest publication timestamp; all identity and scientific metadata remain",
      },
      completion: {
        removedTopLevelFields: semanticComparison
          ? ["renderedAt", "renderProfile", "rendererSignature"]
          : ["renderedAt", "renderProfile"],
        rationale: semanticComparison
          ? "renderedAt and renderProfile are volatile; rendererSignature is validated against each side's manifest before normalization"
          : "renderedAt and renderProfile contain wall-clock/timing diagnostics; identity, provenance, availability, and signatures remain",
      },
      payload: {
        logicalKeyRule: ".bin.gz and .bin.br suffixes canonicalize to .bin",
        byteRule: semanticPngComparison
          ? "gzip and Brotli containers are decompressed; PNGs are decoded to RGBA and framed by uint32 width + uint32 height before hashing and byte comparison"
          : "gzip and Brotli containers are decompressed before hashing and byte comparison",
        pngContainerAuditRule: semanticPngComparison
          ? `stored PNG container changes are counted, hashed, and listed in deterministic logical-key order up to ${MAX_PNG_CONTAINER_CHANGE_DETAILS} entries`
          : "not applicable in exact-container mode",
        hoverByteRule: semanticHoverComparison
          ? "MVHG/MVH3/MVH4 binary hover containers are strictly decoded and framed by rows, cols, sorted variable keys, exact numeric metadata, lengths, and absolute little-endian Int16 values"
          : "decompressed binary hover container bytes are compared exactly",
        hoverContainerAuditRule: semanticHoverComparison
          ? `stored hover container changes are counted, hashed, and listed in deterministic logical-key order up to ${MAX_HOVER_CONTAINER_CHANGE_DETAILS} entries`
          : "not applicable in exact-container mode",
        aggregateHashRule:
          "SHA-256 over sorted logical records framed as uint32 key bytes + key + uint64 decoded bytes + decoded payload",
      },
    },
    counts: summary.counts,
    bytes: summary.bytes,
    hashes: {
      baselineInventorySha256: sha256Json(baselineInventoryIds.sort()),
      candidateInventorySha256: sha256Json(candidateInventoryIds.sort()),
      baselineCanonicalPayloadSha256: baselineAggregateHash.digest("hex"),
      candidateCanonicalPayloadSha256: candidateAggregateHash.digest("hex"),
    },
    pngStoredContainerChanges: summary.pngStoredContainerChanges,
    hoverStoredContainerChanges: summary.hoverStoredContainerChanges,
    mismatches: summary.mismatches,
    manifests: manifestReports,
  };
  return report;
}

function compareManifestArtifacts({
  spec,
  baselineArtifactRoot,
  candidateArtifactRoot,
  baselineAggregateHash,
  candidateAggregateHash,
  baselineInventoryIds,
  candidateInventoryIds,
  pngComparison,
  hoverComparison,
}) {
  const baselineManifest = readJsonArtifact(baselineArtifactRoot, spec.relativePath);
  const candidateManifest = readJsonArtifact(candidateArtifactRoot, spec.relativePath);
  const semanticPngComparison = pngComparison === PNG_COMPARISON_DECODED_RGBA;
  const semanticHoverComparison = hoverComparison === HOVER_COMPARISON_DECODED_INT16;
  const semanticComparison = semanticPngComparison || semanticHoverComparison;
  const manifestComparison = compareJsonArtifacts(
    baselineManifest,
    candidateManifest,
    semanticComparison
      ? (json) =>
          normalizeSemanticManifestJson(json, {
            normalizePng: semanticPngComparison,
            normalizeHover: semanticHoverComparison,
          })
      : normalizeManifestJson,
  );
  const signatureTransition = semanticComparison
    ? compareRendererSignatureTransition(baselineManifest, candidateManifest)
    : null;
  const baselineInventory = collectReferencedInventory(baselineManifest.json, spec);
  const candidateInventory = collectReferencedInventory(candidateManifest.json, spec);
  for (const logicalKey of baselineInventory.entries.keys()) {
    baselineInventoryIds.push(`${spec.id}\0${logicalKey}`);
  }
  for (const logicalKey of candidateInventory.entries.keys()) {
    candidateInventoryIds.push(`${spec.id}\0${logicalKey}`);
  }

  const payloads = comparePayloadInventories({
    spec,
    baselineArtifactRoot,
    candidateArtifactRoot,
    baselineInventory,
    candidateInventory,
    baselineAggregateHash,
    candidateAggregateHash,
    pngComparison,
    hoverComparison,
  });
  const completions = compareCompletionMarkers({
    spec,
    baselineArtifactRoot,
    candidateArtifactRoot,
    baselineManifest: baselineManifest.json,
    candidateManifest: candidateManifest.json,
    pngComparison,
    hoverComparison,
  });

  return {
    id: spec.id,
    manifest: {
      baseline: summarizeJsonRead(baselineManifest),
      candidate: summarizeJsonRead(candidateManifest),
      comparison: manifestComparison,
    },
    inventory: {
      baselineLogicalKeys: baselineInventory.entries.size,
      candidateLogicalKeys: candidateInventory.entries.size,
      baselineRawReferences: baselineInventory.rawReferenceCount,
      candidateRawReferences: candidateInventory.rawReferenceCount,
      baselineDeclaredPngReferences: baselineInventory.declaredPngReferences.length,
      candidateDeclaredPngReferences: candidateInventory.declaredPngReferences.length,
      baselineDeclaredHoverReferences: baselineInventory.declaredHoverReferences.length,
      candidateDeclaredHoverReferences: candidateInventory.declaredHoverReferences.length,
      baselineCollisions: baselineInventory.collisions,
      candidateCollisions: candidateInventory.collisions,
    },
    payloads,
    completions,
    signatureTransition,
  };
}

function collectReferencedInventory(manifest, spec) {
  const entries = new Map();
  const collisions = [];
  const declaredPngReferences = [];
  const declaredHoverReferences = [];
  let rawReferenceCount = 0;
  const frames = Array.isArray(manifest?.frames) ? manifest.frames : [];
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    collectDeclaredPngReferences(frame, `/frames/${frameIndex}`, Number(frame?.hour), declaredPngReferences);
    collectDeclaredHoverReferences(frame, `/frames/${frameIndex}`, Number(frame?.hour), declaredHoverReferences);
    for (const physicalKey of collectFrameArtifactKeys(frame)) {
      rawReferenceCount += 1;
      let safeKey;
      try {
        safeKey = normalizeArtifactKey(physicalKey);
      } catch (error) {
        collisions.push({
          logicalKey: null,
          physicalKeys: [String(physicalKey)],
          reason: error.message,
        });
        continue;
      }
      const logicalKey = canonicalizeArtifactKey(safeKey);
      const existing = entries.get(logicalKey);
      if (!existing) {
        entries.set(logicalKey, {
          logicalKey,
          physicalKey: safeKey,
          hours: [Number(frame.hour)],
        });
      } else {
        if (!existing.hours.includes(Number(frame.hour))) {
          existing.hours.push(Number(frame.hour));
        }
        if (existing.physicalKey !== safeKey) {
          collisions.push({
            logicalKey,
            physicalKeys: [existing.physicalKey, safeKey].sort(),
            reason: "multiple physical containers map to one logical payload",
          });
        }
      }
    }
  }
  for (const collision of collisions) {
    if (collision.logicalKey) {
      entries.delete(collision.logicalKey);
    }
  }
  return { entries, collisions, declaredPngReferences, declaredHoverReferences, rawReferenceCount, spec };
}

function collectDeclaredPngReferences(value, pointer, hour, references) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectDeclaredPngReferences(value[index], `${pointer}/${index}`, hour, references);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  if (typeof value.key === "string" && isPngArtifactKey(value.key)) {
    let physicalKey = null;
    let keyError = null;
    try {
      physicalKey = normalizeArtifactKey(value.key);
    } catch (error) {
      keyError = error.message;
    }
    references.push({
      hour,
      pointer,
      bytesPointer: `${pointer}/bytes`,
      physicalKey,
      rawKey: value.key,
      declaredBytes: Object.hasOwn(value, "bytes") ? value.bytes : undefined,
      ...(keyError ? { keyError } : {}),
    });
  }

  for (const [key, child] of Object.entries(value)) {
    const escapedKey = key.replaceAll("~", "~0").replaceAll("/", "~1");
    collectDeclaredPngReferences(child, `${pointer}/${escapedKey}`, hour, references);
  }
}

function isPngArtifactKey(value) {
  return typeof value === "string" && value.toLowerCase().endsWith(".png");
}

function collectDeclaredHoverReferences(frame, pointer, hour, references) {
  const baseDeclaredSchemaVersion =
    frame && Object.hasOwn(frame, "hoverGridSchemaVersion") ? frame.hoverGridSchemaVersion : undefined;
  if (typeof frame?.hoverGridKey === "string") {
    pushDeclaredHoverReference(references, {
      hour,
      pointer: `${pointer}/hoverGridKey`,
      bytesPointer: `${pointer}/hoverGridBytes`,
      schemaPointer: `${pointer}/hoverGridSchemaVersion`,
      rawKey: frame.hoverGridKey,
      declaredBytes: Object.hasOwn(frame, "hoverGridBytes") ? frame.hoverGridBytes : undefined,
      declaredSchemaVersion: baseDeclaredSchemaVersion,
    });
  }
  for (const [name, reference] of Object.entries(frame?.hoverGridSupplemental || {})) {
    if (!reference || typeof reference !== "object" || typeof reference.key !== "string") {
      continue;
    }
    const escapedName = name.replaceAll("~", "~0").replaceAll("/", "~1");
    const referencePointer = `${pointer}/hoverGridSupplemental/${escapedName}`;
    const rawDeclaredSchemaVersion = Object.hasOwn(reference, "schemaVersion") ? reference.schemaVersion : undefined;
    pushDeclaredHoverReference(references, {
      hour,
      pointer: `${referencePointer}/key`,
      bytesPointer: `${referencePointer}/bytes`,
      schemaPointer: `${referencePointer}/schemaVersion`,
      rawKey: reference.key,
      declaredBytes: Object.hasOwn(reference, "bytes") ? reference.bytes : undefined,
      rawDeclaredSchemaVersion,
      declaredSchemaVersion: rawDeclaredSchemaVersion ?? baseDeclaredSchemaVersion ?? 0,
    });
  }
}

function pushDeclaredHoverReference(references, reference) {
  let physicalKey = null;
  let keyError = null;
  try {
    physicalKey = normalizeArtifactKey(reference.rawKey);
    if (!isHoverBinaryArtifactKey(physicalKey)) {
      throw new Error(`hover reference is not a binary .bin.gz/.bin.br artifact: ${reference.rawKey}`);
    }
  } catch (error) {
    keyError = error.message;
  }
  references.push({
    ...reference,
    physicalKey,
    ...(keyError ? { keyError } : {}),
  });
}

function isHoverBinaryArtifactKey(value) {
  return typeof value === "string" && /\.bin\.(?:gz|br)$/i.test(value);
}

function comparePayloadInventories({
  spec,
  baselineArtifactRoot,
  candidateArtifactRoot,
  baselineInventory,
  candidateInventory,
  baselineAggregateHash,
  candidateAggregateHash,
  pngComparison,
  hoverComparison,
}) {
  const baselineKeys = new Set(baselineInventory.entries.keys());
  const candidateKeys = new Set(candidateInventory.entries.keys());
  const logicalKeys = Array.from(new Set([...baselineKeys, ...candidateKeys])).sort();
  const baselineManifestHash = crypto.createHash("sha256");
  const candidateManifestHash = crypto.createHash("sha256");
  const pngContainerChanges = createPngContainerChangeTracker();
  const hoverContainerChanges = createHoverContainerChangeTracker();
  const mismatches = [];
  const counts = {
    baselineLogicalKeys: baselineKeys.size,
    candidateLogicalKeys: candidateKeys.size,
    unionLogicalKeys: logicalKeys.length,
    intersectionLogicalKeys: 0,
    containerChanges: 0,
    decodedCompared: 0,
    decodedEqual: 0,
    decodedMismatched: 0,
    missingFromBaselineInventory: 0,
    missingFromCandidateInventory: 0,
    readOrDecodeErrors: 0,
    hoverPayloadsCompared: 0,
    declaredPngByteReferencesChecked: 0,
    declaredPngByteMismatches: 0,
    declaredHoverReferencesChecked: 0,
    declaredHoverWildcardReferences: 0,
    declaredHoverReferenceMismatches: 0,
    pngStoredContainerChanges: 0,
    hoverStoredContainerChanges: 0,
  };
  const bytes = {
    baselineStored: 0,
    candidateStored: 0,
    baselineDecoded: 0,
    candidateDecoded: 0,
    comparedCanonical: 0,
    equalCanonical: 0,
  };

  for (const collision of baselineInventory.collisions) {
    mismatches.push({ kind: "baseline-inventory-collision", ...collision });
  }
  for (const collision of candidateInventory.collisions) {
    mismatches.push({ kind: "candidate-inventory-collision", ...collision });
  }
  const declaredBytes = compareDeclaredPngReferenceBytes({
    pngComparison,
    baselineArtifactRoot,
    candidateArtifactRoot,
    baselineReferences: baselineInventory.declaredPngReferences,
    candidateReferences: candidateInventory.declaredPngReferences,
  });
  counts.declaredPngByteReferencesChecked = declaredBytes.checked;
  counts.declaredPngByteMismatches = declaredBytes.mismatches.length;
  mismatches.push(...declaredBytes.mismatches);
  const baselineHoverDeclarations = prepareDeclaredHoverValidation(
    hoverComparison,
    baselineInventory.declaredHoverReferences,
    "baseline",
  );
  const candidateHoverDeclarations = prepareDeclaredHoverValidation(
    hoverComparison,
    candidateInventory.declaredHoverReferences,
    "candidate",
  );
  const declaredHoverMismatches = [...baselineHoverDeclarations.mismatches, ...candidateHoverDeclarations.mismatches];
  counts.declaredHoverReferencesChecked = baselineHoverDeclarations.checked + candidateHoverDeclarations.checked;
  counts.declaredHoverWildcardReferences = baselineHoverDeclarations.wildcards + candidateHoverDeclarations.wildcards;

  for (const logicalKey of logicalKeys) {
    const baselineEntry = baselineInventory.entries.get(logicalKey) || null;
    const candidateEntry = candidateInventory.entries.get(logicalKey) || null;
    if (!baselineEntry) {
      counts.missingFromBaselineInventory += 1;
      mismatches.push({
        kind: "missing-from-baseline-inventory",
        logicalKey,
        candidateKey: candidateEntry.physicalKey,
      });
    }
    if (!candidateEntry) {
      counts.missingFromCandidateInventory += 1;
      mismatches.push({
        kind: "missing-from-candidate-inventory",
        logicalKey,
        baselineKey: baselineEntry.physicalKey,
      });
    }
    if (baselineEntry && candidateEntry) {
      counts.intersectionLogicalKeys += 1;
      if (baselineEntry.physicalKey !== candidateEntry.physicalKey) {
        counts.containerChanges += 1;
      }
    }

    const baselinePayload = baselineEntry
      ? readCanonicalPayload(baselineArtifactRoot, baselineEntry.physicalKey, pngComparison, hoverComparison)
      : null;
    const candidatePayload = candidateEntry
      ? readCanonicalPayload(candidateArtifactRoot, candidateEntry.physicalKey, pngComparison, hoverComparison)
      : null;
    if (baselineEntry) {
      declaredHoverMismatches.push(
        ...validateDeclaredHoverPayloadReferences(
          baselineHoverDeclarations,
          baselineEntry.physicalKey,
          baselinePayload,
        ),
      );
    }
    if (candidateEntry) {
      declaredHoverMismatches.push(
        ...validateDeclaredHoverPayloadReferences(
          candidateHoverDeclarations,
          candidateEntry.physicalKey,
          candidatePayload,
        ),
      );
    }
    if (baselinePayload?.ok) {
      bytes.baselineStored += baselinePayload.storedBytes;
      bytes.baselineDecoded += baselinePayload.decodedBytes;
      updateAggregatePayloadHash(baselineManifestHash, logicalKey, baselinePayload.decoded);
      updateAggregatePayloadHash(baselineAggregateHash, `${spec.id}\0${logicalKey}`, baselinePayload.decoded);
    } else if (baselinePayload) {
      counts.readOrDecodeErrors += 1;
      mismatches.push({
        kind: "baseline-payload-error",
        logicalKey,
        baselineKey: baselineEntry.physicalKey,
        error: baselinePayload.error,
      });
    }
    if (candidatePayload?.ok) {
      bytes.candidateStored += candidatePayload.storedBytes;
      bytes.candidateDecoded += candidatePayload.decodedBytes;
      updateAggregatePayloadHash(candidateManifestHash, logicalKey, candidatePayload.decoded);
      updateAggregatePayloadHash(candidateAggregateHash, `${spec.id}\0${logicalKey}`, candidatePayload.decoded);
    } else if (candidatePayload) {
      counts.readOrDecodeErrors += 1;
      mismatches.push({
        kind: "candidate-payload-error",
        logicalKey,
        candidateKey: candidateEntry.physicalKey,
        error: candidatePayload.error,
      });
    }
    if (!baselinePayload?.ok || !candidatePayload?.ok) {
      continue;
    }

    trackPngContainerChange({
      tracker: pngContainerChanges,
      logicalKey,
      baselineEntry,
      candidateEntry,
      baselinePayload,
      candidatePayload,
    });
    trackHoverContainerChange({
      tracker: hoverContainerChanges,
      logicalKey,
      baselineEntry,
      candidateEntry,
      baselinePayload,
      candidatePayload,
    });

    counts.decodedCompared += 1;
    counts.hoverPayloadsCompared += Number(logicalKey.endsWith(".bin"));
    bytes.comparedCanonical += baselinePayload.decodedBytes;
    if (baselinePayload.decoded.equals(candidatePayload.decoded)) {
      counts.decodedEqual += 1;
      bytes.equalCanonical += baselinePayload.decodedBytes;
    } else {
      counts.decodedMismatched += 1;
      mismatches.push({
        kind: payloadMismatchKind(baselinePayload, candidatePayload),
        logicalKey,
        baseline: summarizePayload(baselineEntry.physicalKey, baselinePayload),
        candidate: summarizePayload(candidateEntry.physicalKey, candidatePayload),
        firstDifferentByte: findFirstDifferentByte(baselinePayload.decoded, candidatePayload.decoded),
      });
    }
  }

  const pngStoredContainerChanges = summarizePngContainerChanges(pngContainerChanges);
  const hoverStoredContainerChanges = summarizeHoverContainerChanges(hoverContainerChanges);
  declaredHoverMismatches.push(
    ...finalizeDeclaredHoverValidation(baselineHoverDeclarations),
    ...finalizeDeclaredHoverValidation(candidateHoverDeclarations),
  );
  counts.declaredHoverReferenceMismatches = declaredHoverMismatches.length;
  mismatches.push(...declaredHoverMismatches);
  counts.pngStoredContainerChanges = pngStoredContainerChanges.count;
  counts.hoverStoredContainerChanges = hoverStoredContainerChanges.count;
  return {
    exact: mismatches.length === 0,
    counts,
    bytes,
    hashes: {
      baselineCanonicalSha256: baselineManifestHash.digest("hex"),
      candidateCanonicalSha256: candidateManifestHash.digest("hex"),
    },
    pngStoredContainerChanges,
    hoverStoredContainerChanges,
    mismatches,
  };
}

function compareDeclaredPngReferenceBytes({
  pngComparison,
  baselineArtifactRoot,
  candidateArtifactRoot,
  baselineReferences,
  candidateReferences,
}) {
  if (pngComparison !== PNG_COMPARISON_DECODED_RGBA) {
    return { checked: 0, mismatches: [] };
  }
  const baseline = validateDeclaredPngReferenceBytes(baselineArtifactRoot, baselineReferences, "baseline");
  const candidate = validateDeclaredPngReferenceBytes(candidateArtifactRoot, candidateReferences, "candidate");
  return {
    checked: baseline.checked + candidate.checked,
    mismatches: [...baseline.mismatches, ...candidate.mismatches],
  };
}

function prepareDeclaredHoverValidation(hoverComparison, references, side) {
  if (hoverComparison !== HOVER_COMPARISON_DECODED_INT16) {
    return {
      enabled: false,
      side,
      checked: 0,
      wildcards: 0,
      byPhysicalKey: new Map(),
      processed: new Set(),
      mismatches: [],
    };
  }
  const mismatches = [];
  const byPhysicalKey = new Map();
  for (const reference of references) {
    if (reference.keyError) {
      mismatches.push({
        kind: `${side}-declared-hover-validation-error`,
        physicalKey: reference.rawKey,
        path: reference.pointer,
        error: reference.keyError,
      });
      continue;
    }
    const existing = byPhysicalKey.get(reference.physicalKey) || [];
    existing.push(reference);
    byPhysicalKey.set(reference.physicalKey, existing);
  }
  return {
    enabled: true,
    side,
    checked: references.length,
    wildcards: references.filter(
      (reference) =>
        reference.declaredSchemaVersion === null ||
        reference.declaredSchemaVersion === undefined ||
        reference.declaredSchemaVersion === 0,
    ).length,
    byPhysicalKey,
    processed: new Set(),
    mismatches,
  };
}

function validateDeclaredHoverPayloadReferences(validation, physicalKey, payload) {
  if (!validation.enabled) {
    return [];
  }
  const references = validation.byPhysicalKey.get(physicalKey) || [];
  if (references.length === 0 || validation.processed.has(physicalKey)) {
    return [];
  }
  validation.processed.add(physicalKey);
  const mismatches = [];
  for (const reference of references) {
    if (!payload?.ok) {
      mismatches.push({
        kind: `${validation.side}-declared-hover-validation-error`,
        physicalKey: reference.physicalKey,
        path: reference.schemaPointer,
        error: payload?.error || "referenced hover payload was not read",
      });
      continue;
    }
    if (
      !Number.isSafeInteger(reference.declaredBytes) ||
      reference.declaredBytes < 0 ||
      reference.declaredBytes !== payload.storedBytes
    ) {
      mismatches.push({
        kind: `${validation.side}-declared-hover-byte-mismatch`,
        physicalKey: reference.physicalKey,
        path: reference.bytesPointer,
        declaredBytes: reference.declaredBytes,
        actualStoredBytes: payload.storedBytes,
      });
    }
    const declaredSchemaVersion = reference.declaredSchemaVersion ?? 0;
    if (
      typeof declaredSchemaVersion !== "number" ||
      !Number.isSafeInteger(declaredSchemaVersion) ||
      declaredSchemaVersion < 0 ||
      declaredSchemaVersion > 4
    ) {
      mismatches.push({
        kind: `${validation.side}-declared-hover-schema-invalid`,
        physicalKey: reference.physicalKey,
        path: reference.schemaPointer,
        declaredSchemaVersion,
      });
    } else if (declaredSchemaVersion !== 0 && payload.hoverSchemaVersion !== declaredSchemaVersion) {
      mismatches.push({
        kind: `${validation.side}-declared-hover-schema-mismatch`,
        physicalKey: reference.physicalKey,
        path: reference.schemaPointer,
        declaredSchemaVersion,
        actualSchemaVersion: payload.hoverSchemaVersion,
        magic: payload.hoverMagic,
      });
    }
  }
  return mismatches;
}

function finalizeDeclaredHoverValidation(validation) {
  if (!validation.enabled) {
    return [];
  }
  const mismatches = [];
  for (const [physicalKey, references] of validation.byPhysicalKey) {
    if (validation.processed.has(physicalKey)) {
      continue;
    }
    for (const reference of references) {
      mismatches.push({
        kind: `${validation.side}-declared-hover-validation-error`,
        physicalKey,
        path: reference.pointer,
        error: "declared hover reference was excluded from the readable logical inventory",
      });
    }
  }
  return mismatches;
}

function payloadMismatchKind(baseline, candidate) {
  const dimensionsDiffer = baseline.width !== candidate.width || baseline.height !== candidate.height;
  if (
    baseline.kind === "png-dimension-framed-rgba" &&
    candidate.kind === "png-dimension-framed-rgba" &&
    dimensionsDiffer
  ) {
    return "png-dimension-mismatch";
  }
  return "decoded-byte-mismatch";
}

function hoverStoredContainersDiffer(baseline, candidate) {
  return (
    baseline.kind === "hover-absolute-framed-int16" &&
    candidate.kind === "hover-absolute-framed-int16" &&
    !baseline.stored.equals(candidate.stored)
  );
}

function pngStoredContainersDiffer(baseline, candidate) {
  return (
    baseline.kind === "png-dimension-framed-rgba" &&
    candidate.kind === "png-dimension-framed-rgba" &&
    !baseline.stored.equals(candidate.stored)
  );
}

function createPngContainerChangeTracker() {
  return {
    count: 0,
    entries: [],
    hash: crypto.createHash("sha256"),
  };
}

function trackPngContainerChange({
  tracker,
  logicalKey,
  baselineEntry,
  candidateEntry,
  baselinePayload,
  candidatePayload,
}) {
  if (!pngStoredContainersDiffer(baselinePayload, candidatePayload)) {
    return;
  }
  const change = {
    logicalKey,
    baseline: summarizeStoredContainer(baselineEntry.physicalKey, baselinePayload),
    candidate: summarizeStoredContainer(candidateEntry.physicalKey, candidatePayload),
  };
  tracker.count += 1;
  updateFramedJsonHash(tracker.hash, change);
  if (tracker.entries.length < MAX_PNG_CONTAINER_CHANGE_DETAILS) {
    tracker.entries.push(change);
  }
}

function summarizePngContainerChanges(tracker) {
  return {
    count: tracker.count,
    entries: tracker.entries,
    detailsTruncated: tracker.count > tracker.entries.length,
    sha256: tracker.hash.digest("hex"),
  };
}

function createHoverContainerChangeTracker() {
  return {
    count: 0,
    entries: [],
    hash: crypto.createHash("sha256"),
  };
}

function trackHoverContainerChange({
  tracker,
  logicalKey,
  baselineEntry,
  candidateEntry,
  baselinePayload,
  candidatePayload,
}) {
  if (!hoverStoredContainersDiffer(baselinePayload, candidatePayload)) {
    return;
  }
  const change = {
    logicalKey,
    baseline: {
      ...summarizeStoredContainer(baselineEntry.physicalKey, baselinePayload),
      magic: baselinePayload.hoverMagic,
      schemaVersion: baselinePayload.hoverSchemaVersion,
      predictor: baselinePayload.hoverPredictor,
    },
    candidate: {
      ...summarizeStoredContainer(candidateEntry.physicalKey, candidatePayload),
      magic: candidatePayload.hoverMagic,
      schemaVersion: candidatePayload.hoverSchemaVersion,
      predictor: candidatePayload.hoverPredictor,
    },
  };
  tracker.count += 1;
  updateFramedJsonHash(tracker.hash, change);
  if (tracker.entries.length < MAX_HOVER_CONTAINER_CHANGE_DETAILS) {
    tracker.entries.push(change);
  }
}

function summarizeHoverContainerChanges(tracker) {
  return {
    count: tracker.count,
    entries: tracker.entries,
    detailsTruncated: tracker.count > tracker.entries.length,
    sha256: tracker.hash.digest("hex"),
  };
}

function validateDeclaredPngReferenceBytes(artifactRoot, references, side) {
  const mismatches = [];
  let checked = 0;
  for (const reference of references) {
    checked += 1;
    if (reference.keyError) {
      mismatches.push({
        kind: `${side}-declared-byte-validation-error`,
        physicalKey: reference.rawKey,
        path: reference.bytesPointer,
        error: reference.keyError,
      });
      continue;
    }

    let actualStoredBytes;
    try {
      actualStoredBytes = fs.statSync(resolveContainedFile(artifactRoot, reference.physicalKey)).size;
    } catch (error) {
      mismatches.push({
        kind: `${side}-declared-byte-validation-error`,
        physicalKey: reference.physicalKey,
        path: reference.bytesPointer,
        error: error.message,
      });
      continue;
    }

    if (
      !Number.isSafeInteger(reference.declaredBytes) ||
      reference.declaredBytes < 0 ||
      reference.declaredBytes !== actualStoredBytes
    ) {
      mismatches.push({
        kind: `${side}-declared-byte-mismatch`,
        physicalKey: reference.physicalKey,
        path: reference.bytesPointer,
        declaredBytes: reference.declaredBytes,
        actualStoredBytes,
      });
    }
  }
  return { checked, mismatches };
}

function compareCompletionMarkers({
  spec,
  baselineArtifactRoot,
  candidateArtifactRoot,
  baselineManifest,
  candidateManifest,
  pngComparison,
  hoverComparison,
}) {
  const semanticPngComparison = pngComparison === PNG_COMPARISON_DECODED_RGBA;
  const semanticHoverComparison = hoverComparison === HOVER_COMPARISON_DECODED_INT16;
  const semanticComparison = semanticPngComparison || semanticHoverComparison;
  const baselineFrames = framesByHour(baselineManifest);
  const candidateFrames = framesByHour(candidateManifest);
  const hours = Array.from(new Set([...baselineFrames.keys(), ...candidateFrames.keys()])).sort(
    (left, right) => left - right,
  );
  const markers = [];
  let equal = 0;
  let mismatched = 0;
  let signatureMarkersChecked = 0;
  let signatureMarkersMismatched = 0;

  for (const hour of hours) {
    const baselineFrame = baselineFrames.get(hour);
    const candidateFrame = candidateFrames.get(hour);
    const baselineMarker = baselineFrame
      ? readJsonArtifact(baselineArtifactRoot, deriveFrameMarkerKey(baselineFrame, spec))
      : missingJsonArtifact("frame absent from baseline manifest");
    const candidateMarker = candidateFrame
      ? readJsonArtifact(candidateArtifactRoot, deriveFrameMarkerKey(candidateFrame, spec))
      : missingJsonArtifact("frame absent from candidate manifest");
    const comparison = compareJsonArtifacts(
      baselineMarker,
      candidateMarker,
      semanticComparison
        ? (json) =>
            normalizeSemanticCompletionJson(json, {
              normalizePng: semanticPngComparison,
              normalizeHover: semanticHoverComparison,
            })
        : normalizeCompletionJson,
    );
    const signatureValidation = semanticComparison
      ? validateCompletionRendererSignatures({
          baselineMarker,
          candidateMarker,
          baselineManifest,
          candidateManifest,
        })
      : null;
    if (signatureValidation) {
      signatureMarkersChecked += signatureValidation.checked;
      signatureMarkersMismatched += signatureValidation.issues.length;
    }
    if (comparison.equal && (!signatureValidation || signatureValidation.valid)) {
      equal += 1;
    } else {
      mismatched += 1;
      markers.push({
        hour,
        baseline: summarizeJsonRead(baselineMarker),
        candidate: summarizeJsonRead(candidateMarker),
        comparison,
        ...(signatureValidation ? { signatureValidation } : {}),
      });
    }
  }

  return {
    exact: mismatched === 0,
    counts: {
      expectedUnion: hours.length,
      equal,
      mismatched,
      signatureMarkersChecked,
      signatureMarkersMismatched,
    },
    mismatches: markers,
  };
}

function compareRendererSignatureTransition(baselineManifest, candidateManifest) {
  const baselineSignature = readRendererSignature(baselineManifest);
  const candidateSignature = readRendererSignature(candidateManifest);
  const issues = [];
  if (!baselineSignature) {
    issues.push({ side: "baseline", kind: "missing-renderer-signature" });
  }
  if (!candidateSignature) {
    issues.push({ side: "candidate", kind: "missing-renderer-signature" });
  }
  const changed = Boolean(baselineSignature) && Boolean(candidateSignature) && baselineSignature !== candidateSignature;
  if (baselineSignature && candidateSignature && !changed) {
    issues.push({
      kind: "renderer-signature-did-not-transition",
      baseline: baselineSignature,
      candidate: candidateSignature,
    });
  }
  return {
    required: true,
    baseline: baselineSignature,
    candidate: candidateSignature,
    changed,
    valid: issues.length === 0,
    issues,
  };
}

function readRendererSignature(read) {
  if (!read?.ok) {
    return null;
  }
  const signature = read.json?.rendererSignature;
  return typeof signature === "string" && signature.trim() ? signature : null;
}

function validateCompletionRendererSignatures({
  baselineMarker,
  candidateMarker,
  baselineManifest,
  candidateManifest,
}) {
  const issues = [];
  let checked = 0;
  for (const [side, marker, manifest] of [
    ["baseline", baselineMarker, baselineManifest],
    ["candidate", candidateMarker, candidateManifest],
  ]) {
    if (!marker.ok) {
      continue;
    }
    checked += 1;
    const expected = typeof manifest?.rendererSignature === "string" ? manifest.rendererSignature : null;
    const actual = typeof marker.json?.rendererSignature === "string" ? marker.json.rendererSignature : null;
    if (!expected || actual !== expected) {
      issues.push({
        side,
        kind: "completion-renderer-signature-mismatch",
        expected,
        actual,
      });
    }
  }
  return {
    valid: issues.length === 0,
    checked,
    issues,
  };
}

function framesByHour(manifest) {
  const frames = new Map();
  for (const frame of Array.isArray(manifest?.frames) ? manifest.frames : []) {
    const hour = Number(frame?.hour);
    if (Number.isInteger(hour) && hour >= 0 && !frames.has(hour)) {
      frames.set(hour, frame);
    }
  }
  return frames;
}

function deriveFrameMarkerKey(frame, spec) {
  const hour = Number(frame?.hour);
  if (!Number.isInteger(hour) || hour < 0) {
    throw new Error(`manifest ${spec.id} has an invalid frame hour`);
  }
  const paddedHour = String(hour).padStart(3, "0");
  const expectedSuffix = `${spec.model}/${spec.run}/${spec.view}/${paddedHour}`;
  const directories = new Set();
  for (const key of collectFrameArtifactKeys(frame)) {
    const normalized = normalizeArtifactKey(key);
    const directory = path.posix.dirname(normalized);
    if (directory === expectedSuffix || directory.endsWith(`/${expectedSuffix}`)) {
      directories.add(directory);
    }
  }
  if (directories.size > 1) {
    throw new Error(`manifest ${spec.id} F${paddedHour} references more than one frame artifact directory`);
  }
  const directory = directories.size === 1 ? directories.values().next().value : `tiles/${expectedSuffix}`;
  return `${directory}/.complete.json`;
}

function readCanonicalPayload(
  artifactRoot,
  physicalKey,
  pngComparison = PNG_COMPARISON_CONTAINER,
  hoverComparison = HOVER_COMPARISON_CONTAINER,
) {
  try {
    const absolutePath = resolveContainedFile(artifactRoot, physicalKey);
    const stored = fs.readFileSync(absolutePath);
    let decoded;
    let kind = "container-bytes";
    let width;
    let height;
    let hoverIdentity = null;
    if (hoverComparison === HOVER_COMPARISON_DECODED_INT16 && isHoverBinaryArtifactKey(physicalKey)) {
      const raw = decompressStoredHoverGrid(stored, physicalKey);
      const payload = decodeHoverGridBinaryRaw(raw);
      hoverIdentity = readHoverGridContainerIdentity(raw);
      decoded = frameCanonicalHoverGridPayload(payload);
      if (hoverIdentity.schemaVersion !== payload.schemaVersion) {
        throw new Error(
          `decoded hover schema disagreement: header ${hoverIdentity.schemaVersion}, payload ${payload.schemaVersion}`,
        );
      }
      kind = "hover-absolute-framed-int16";
    } else if (physicalKey.endsWith(".bin.gz")) {
      decoded = zlib.gunzipSync(stored);
      kind = "decompressed-bytes";
    } else if (physicalKey.endsWith(".bin.br")) {
      decoded = zlib.brotliDecompressSync(stored);
      kind = "decompressed-bytes";
    } else if (pngComparison === PNG_COMPARISON_DECODED_RGBA && isPngArtifactKey(physicalKey)) {
      const png = PNG.sync.read(stored);
      width = png.width;
      height = png.height;
      if (
        !Number.isSafeInteger(width) ||
        width <= 0 ||
        !Number.isSafeInteger(height) ||
        height <= 0 ||
        png.data.length !== width * height * 4
      ) {
        throw new Error(`invalid decoded PNG dimensions/data: ${width}x${height}, ${png.data.length} RGBA bytes`);
      }
      const dimensionFrame = Buffer.allocUnsafe(8);
      dimensionFrame.writeUInt32BE(width, 0);
      dimensionFrame.writeUInt32BE(height, 4);
      decoded = Buffer.concat([dimensionFrame, Buffer.from(png.data)]);
      kind = "png-dimension-framed-rgba";
    } else {
      decoded = stored;
    }
    return {
      ok: true,
      kind,
      storedBytes: stored.length,
      decodedBytes: decoded.length,
      decoded,
      ...(kind === "png-dimension-framed-rgba" || kind === "hover-absolute-framed-int16" ? { stored } : {}),
      ...(width === undefined ? {} : { width, height }),
      ...(hoverIdentity
        ? {
            hoverMagic: hoverIdentity.magic,
            hoverSchemaVersion: hoverIdentity.schemaVersion,
            hoverPredictor: hoverIdentity.predictor,
          }
        : {}),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function frameCanonicalHoverGridPayload(payload) {
  const rows = payload?.rows;
  const cols = payload?.cols;
  if (
    !Number.isSafeInteger(rows) ||
    rows <= 0 ||
    !Number.isSafeInteger(cols) ||
    cols <= 0 ||
    rows > Number.MAX_SAFE_INTEGER / cols
  ) {
    throw new Error(`invalid decoded hover dimensions ${JSON.stringify(rows)}x${JSON.stringify(cols)}`);
  }
  const expectedLength = rows * cols;
  const rawVariables = payload?.variables;
  if (!rawVariables || typeof rawVariables !== "object" || Array.isArray(rawVariables)) {
    throw new Error("decoded hover variables must be an object");
  }
  const keys = Object.keys(rawVariables).sort();
  if (keys.length === 0 && payload.schemaVersion !== 3 && payload.schemaVersion !== 4) {
    throw new Error(`decoded empty hover payload is unsupported for schema ${payload.schemaVersion}`);
  }
  const variables = [];
  let valueBytes = 0;
  for (const key of keys) {
    if (!key || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`decoded hover variable key is unsafe: ${JSON.stringify(key)}`);
    }
    const variable = rawVariables[key];
    if (!variable || typeof variable !== "object" || !(variable.values instanceof Int16Array)) {
      throw new Error(`decoded hover variable '${key}' has no Int16Array values`);
    }
    if (variable.values.length !== expectedLength) {
      throw new Error(
        `decoded hover variable '${key}' length ${variable.values.length} does not match ${rows}x${cols}`,
      );
    }
    if (
      typeof variable.scale !== "number" ||
      !Number.isFinite(variable.scale) ||
      variable.scale <= 0 ||
      typeof variable.offset !== "number" ||
      !Number.isFinite(variable.offset) ||
      typeof variable.missing !== "number" ||
      !Number.isInteger(variable.missing) ||
      variable.missing < -32768 ||
      variable.missing > 32767
    ) {
      throw new Error(`decoded hover variable '${key}' has invalid quantization metadata`);
    }
    variables.push({
      key,
      scaleF64le: float64LittleEndianHex(variable.scale),
      offsetF64le: float64LittleEndianHex(variable.offset),
      missing: variable.missing,
      length: variable.values.length,
      values: variable.values,
    });
    valueBytes += variable.values.byteLength;
  }
  const header = Buffer.from(
    stableStringify({
      rows,
      cols,
      variables: variables.map(({ values: _values, ...metadata }) => metadata),
    }),
  );
  if (header.length > 0xffffffff) {
    throw new Error("canonical hover header exceeds uint32 framing");
  }
  const framed = Buffer.allocUnsafe(8 + header.length + valueBytes);
  framed.write("MVHC", 0, "ascii");
  framed.writeUInt32BE(header.length, 4);
  header.copy(framed, 8);
  let cursor = 8 + header.length;
  for (const variable of variables) {
    if (NATIVE_LITTLE_ENDIAN) {
      Buffer.from(variable.values.buffer, variable.values.byteOffset, variable.values.byteLength).copy(framed, cursor);
      cursor += variable.values.byteLength;
    } else {
      for (const value of variable.values) {
        framed.writeInt16LE(value, cursor);
        cursor += Int16Array.BYTES_PER_ELEMENT;
      }
    }
  }
  return framed;
}

function float64LittleEndianHex(value) {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleLE(value, 0);
  return bytes.toString("hex");
}

function decompressStoredHoverGrid(stored, physicalKey) {
  return physicalKey.endsWith(".bin.gz")
    ? zlib.gunzipSync(stored)
    : physicalKey.endsWith(".bin.br")
      ? zlib.brotliDecompressSync(stored)
      : stored;
}

function readHoverGridContainerIdentity(raw) {
  if (raw.length < 8) {
    throw new Error("decoded hover container is shorter than its fixed header");
  }
  const magic = raw.subarray(0, 4).toString("ascii");
  const headerLength = raw.readUInt32LE(4);
  const dataStart = 8 + headerLength;
  if (!Number.isSafeInteger(dataStart) || dataStart > raw.length) {
    throw new Error("decoded hover container header is truncated");
  }
  const header = JSON.parse(raw.subarray(8, dataStart).toString("utf8"));
  return {
    magic,
    schemaVersion: header.schemaVersion,
    predictor: Object.hasOwn(header, "predictor") ? header.predictor : null,
  };
}

function readJsonArtifact(artifactRoot, relativePath) {
  try {
    const absolutePath = resolveContainedFile(artifactRoot, relativePath);
    const raw = fs.readFileSync(absolutePath);
    return {
      ok: true,
      relativePath,
      rawBytes: raw.length,
      rawSha256: sha256Bytes(raw),
      json: JSON.parse(raw.toString("utf8")),
    };
  } catch (error) {
    return {
      ok: false,
      relativePath,
      error: error.message,
      json: null,
    };
  }
}

function missingJsonArtifact(error) {
  return { ok: false, relativePath: null, error, json: null };
}

function resolveContainedFile(root, relativePath) {
  const normalized = normalizeArtifactKey(relativePath);
  const absoluteRoot = fs.realpathSync(root);
  const target = path.resolve(absoluteRoot, ...normalized.split("/"));
  if (!isContainedPath(absoluteRoot, target)) {
    throw new Error(`artifact path escapes root: ${relativePath}`);
  }
  const stat = fs.statSync(target);
  if (!stat.isFile()) {
    throw new Error(`artifact is not a file: ${relativePath}`);
  }
  const realTarget = fs.realpathSync(target);
  if (!isContainedPath(absoluteRoot, realTarget)) {
    throw new Error(`artifact symlink escapes root: ${relativePath}`);
  }
  return realTarget;
}

function isContainedPath(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function normalizeArtifactKey(value) {
  const key = String(value || "");
  if (
    !key ||
    key.includes("\0") ||
    key.includes("\\") ||
    key.startsWith("/") ||
    key.includes("?") ||
    key.includes("#")
  ) {
    throw new Error(`unsafe artifact key ${JSON.stringify(key)}`);
  }
  const normalized = path.posix.normalize(key);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== key) {
    throw new Error(`non-canonical artifact key ${JSON.stringify(key)}`);
  }
  return normalized;
}

function canonicalizeArtifactKey(key) {
  return key.replace(/\.bin\.(?:gz|br)$/, ".bin");
}

function normalizeManifestJson(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return json;
  }
  const normalized = { ...json };
  delete normalized.generatedAt;
  return normalized;
}

function normalizeSemanticManifestJson(json, { normalizePng = false, normalizeHover = false } = {}) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return json;
  }
  const normalized = cloneWithoutSelectedContainerIdentity(json, { normalizePng, normalizeHover }, "manifest-root");
  delete normalized.generatedAt;
  delete normalized.rendererSignature;
  return normalized;
}

function cloneWithoutSelectedContainerIdentity(value, options, hoverRole = "none") {
  if (Array.isArray(value)) {
    const childRole =
      hoverRole === "manifest-frames"
        ? "manifest-frame"
        : hoverRole === "supplemental-map"
          ? "supplemental-reference"
          : "none";
    return value.map((entry) => cloneWithoutSelectedContainerIdentity(entry, options, childRole));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const pngReference = options.normalizePng && isPngArtifactKey(value.key);
  const hoverReference =
    options.normalizeHover && hoverRole === "supplemental-reference" && isHoverBinaryArtifactKey(value.key);
  const hoverFrame =
    options.normalizeHover &&
    (hoverRole === "manifest-frame" || hoverRole === "completion-root") &&
    isHoverBinaryArtifactKey(value.hoverGridKey);
  const cloned = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !(pngReference && key === "bytes") &&
          !(hoverReference && (key === "bytes" || key === "schemaVersion")) &&
          !(hoverFrame && (key === "hoverGridBytes" || key === "hoverGridSchemaVersion")),
      )
      .map(([key, child]) => {
        let childRole = "none";
        if (hoverRole === "manifest-root" && key === "frames" && Array.isArray(child)) {
          childRole = "manifest-frames";
        } else if (hoverRole === "manifest-frame" && key === "hoverGridSupplemental") {
          childRole = "supplemental-map";
        } else if (hoverRole === "supplemental-map") {
          childRole = "supplemental-reference";
        }
        return [key, cloneWithoutSelectedContainerIdentity(child, options, childRole)];
      }),
  );
  if (hoverReference) {
    cloned.key = canonicalizeArtifactKey(value.key);
  }
  if (hoverFrame) {
    cloned.hoverGridKey = canonicalizeArtifactKey(value.hoverGridKey);
  }
  return cloned;
}

function normalizeCompletionJson(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return json;
  }
  const normalized = { ...json };
  delete normalized.renderedAt;
  delete normalized.renderProfile;
  return normalized;
}

function normalizeSemanticCompletionJson(json, options) {
  const normalized = cloneWithoutSelectedContainerIdentity(normalizeCompletionJson(json), options, "completion-root");
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return normalized;
  }
  delete normalized.rendererSignature;
  return normalized;
}

function compareJsonArtifacts(baseline, candidate, normalize) {
  if (!baseline.ok || !candidate.ok) {
    return {
      equal: false,
      status: !baseline.ok && !candidate.ok ? "both-unreadable" : "missing-or-unreadable",
      differenceCount: 1,
      differences: [
        {
          path: "",
          baseline: baseline.ok ? "present" : baseline.error,
          candidate: candidate.ok ? "present" : candidate.error,
        },
      ],
    };
  }
  const baselineNormalized = normalize(baseline.json);
  const candidateNormalized = normalize(candidate.json);
  const baselineBody = stableStringify(baselineNormalized);
  const candidateBody = stableStringify(candidateNormalized);
  const differences = diffJson(baselineNormalized, candidateNormalized);
  return {
    equal: differences.count === 0,
    status: differences.count === 0 ? "equal" : "mismatch",
    baselineNormalizedBytes: Buffer.byteLength(baselineBody),
    candidateNormalizedBytes: Buffer.byteLength(candidateBody),
    baselineNormalizedSha256: sha256Bytes(Buffer.from(baselineBody)),
    candidateNormalizedSha256: sha256Bytes(Buffer.from(candidateBody)),
    differenceCount: differences.count,
    detailsTruncated: differences.count > differences.details.length,
    differences: differences.details,
  };
}

function diffJson(baseline, candidate) {
  const details = [];
  let count = 0;

  function visit(left, right, pointer) {
    if (Object.is(left, right)) {
      return;
    }
    const leftArray = Array.isArray(left);
    const rightArray = Array.isArray(right);
    const leftObject = left !== null && typeof left === "object" && !leftArray;
    const rightObject = right !== null && typeof right === "object" && !rightArray;
    if (leftArray && rightArray) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index += 1) {
        if (index >= left.length || index >= right.length) {
          addDifference(`${pointer}/${index}`, index < left.length, left[index], index < right.length, right[index]);
        } else {
          visit(left[index], right[index], `${pointer}/${index}`);
        }
      }
      return;
    }
    if (leftObject && rightObject) {
      const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
      for (const key of keys) {
        const escapedKey = key.replaceAll("~", "~0").replaceAll("/", "~1");
        if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
          addDifference(
            `${pointer}/${escapedKey}`,
            Object.hasOwn(left, key),
            left[key],
            Object.hasOwn(right, key),
            right[key],
          );
        } else {
          visit(left[key], right[key], `${pointer}/${escapedKey}`);
        }
      }
      return;
    }
    addDifference(pointer, true, left, true, right);
  }

  function addDifference(pointer, baselinePresent, baselineValue, candidatePresent, candidateValue) {
    count += 1;
    if (details.length >= MAX_JSON_DIFFERENCE_DETAILS) {
      return;
    }
    details.push({
      path: pointer,
      baselinePresent,
      candidatePresent,
      ...(baselinePresent ? { baseline: previewJsonValue(baselineValue) } : {}),
      ...(candidatePresent ? { candidate: previewJsonValue(candidateValue) } : {}),
    });
  }

  visit(baseline, candidate, "");
  return { count, details };
}

function previewJsonValue(value) {
  const body = stableStringify(value);
  return body.length <= 300 ? JSON.parse(body) : `${body.slice(0, 297)}...`;
}

function stableStringify(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function updateAggregatePayloadHash(hash, logicalKey, decoded) {
  const keyBytes = Buffer.from(logicalKey, "utf8");
  const header = Buffer.allocUnsafe(12);
  header.writeUInt32BE(keyBytes.length, 0);
  header.writeBigUInt64BE(BigInt(decoded.length), 4);
  hash.update(header);
  hash.update(keyBytes);
  hash.update(decoded);
}

function updateFramedJsonHash(hash, value) {
  const body = Buffer.from(stableStringify(value));
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  hash.update(header);
  hash.update(body);
}

function summarizeStoredContainer(physicalKey, payload) {
  return {
    physicalKey,
    storedBytes: payload.storedBytes,
    storedSha256: sha256Bytes(payload.stored),
  };
}

function summarizePayload(physicalKey, payload) {
  return {
    physicalKey,
    kind: payload.kind,
    storedBytes: payload.storedBytes,
    decodedBytes: payload.decodedBytes,
    decodedSha256: sha256Bytes(payload.decoded),
    ...(payload.width === undefined ? {} : { width: payload.width, height: payload.height }),
  };
}

function summarizeJsonRead(read) {
  return read.ok
    ? {
        status: "read",
        relativePath: read.relativePath,
        rawBytes: read.rawBytes,
        rawSha256: read.rawSha256,
      }
    : {
        status: "error",
        relativePath: read.relativePath,
        error: read.error,
      };
}

function findFirstDifferentByte(baseline, candidate) {
  const commonLength = Math.min(baseline.length, candidate.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (baseline[index] !== candidate[index]) {
      return index;
    }
  }
  return baseline.length === candidate.length ? null : commonLength;
}

function summarizeReports(reports) {
  const counts = {
    manifestsRequested: reports.length,
    manifestsEqual: 0,
    manifestsMismatched: 0,
    completionMarkersEqual: 0,
    completionMarkersMismatched: 0,
    baselinePayloads: 0,
    candidatePayloads: 0,
    payloadsCompared: 0,
    payloadsEqual: 0,
    payloadsMismatched: 0,
    payloadMismatchDetails: 0,
    missingFromBaselineInventory: 0,
    missingFromCandidateInventory: 0,
    payloadReadOrDecodeErrors: 0,
    hoverPayloadsCompared: 0,
    containerChanges: 0,
    declaredPngByteReferencesChecked: 0,
    declaredPngByteMismatches: 0,
    declaredHoverReferencesChecked: 0,
    declaredHoverWildcardReferences: 0,
    declaredHoverReferenceMismatches: 0,
    rendererSignatureTransitionsChecked: 0,
    rendererSignatureTransitionsValid: 0,
    rendererSignatureTransitionsInvalid: 0,
    pngStoredContainerChanges: 0,
    hoverStoredContainerChanges: 0,
  };
  const bytes = {
    baselineStored: 0,
    candidateStored: 0,
    baselineCanonical: 0,
    candidateCanonical: 0,
    comparedCanonical: 0,
    equalCanonical: 0,
  };
  const mismatches = {
    total: 0,
    manifests: 0,
    completionMarkers: 0,
    payloads: 0,
    rendererSignatureTransitions: 0,
  };
  const aggregatePngContainerChangeHash = crypto.createHash("sha256");
  const aggregatePngContainerChangeEntries = [];
  let manifestsWithPngContainerChanges = 0;
  const aggregateHoverContainerChangeHash = crypto.createHash("sha256");
  const aggregateHoverContainerChangeEntries = [];
  let manifestsWithHoverContainerChanges = 0;

  for (const report of reports) {
    if (report.manifest.comparison.equal) {
      counts.manifestsEqual += 1;
    } else {
      counts.manifestsMismatched += 1;
      mismatches.manifests += 1;
    }
    counts.completionMarkersEqual += report.completions.counts.equal;
    counts.completionMarkersMismatched += report.completions.counts.mismatched;
    mismatches.completionMarkers += report.completions.counts.mismatched;
    counts.baselinePayloads += report.payloads.counts.baselineLogicalKeys;
    counts.candidatePayloads += report.payloads.counts.candidateLogicalKeys;
    counts.payloadsCompared += report.payloads.counts.decodedCompared;
    counts.payloadsEqual += report.payloads.counts.decodedEqual;
    counts.payloadsMismatched += report.payloads.counts.decodedMismatched;
    counts.payloadMismatchDetails += report.payloads.mismatches.length;
    counts.missingFromBaselineInventory += report.payloads.counts.missingFromBaselineInventory;
    counts.missingFromCandidateInventory += report.payloads.counts.missingFromCandidateInventory;
    counts.payloadReadOrDecodeErrors += report.payloads.counts.readOrDecodeErrors;
    counts.hoverPayloadsCompared += report.payloads.counts.hoverPayloadsCompared;
    counts.containerChanges += report.payloads.counts.containerChanges;
    counts.declaredPngByteReferencesChecked += report.payloads.counts.declaredPngByteReferencesChecked;
    counts.declaredPngByteMismatches += report.payloads.counts.declaredPngByteMismatches;
    counts.declaredHoverReferencesChecked += report.payloads.counts.declaredHoverReferencesChecked;
    counts.declaredHoverWildcardReferences += report.payloads.counts.declaredHoverWildcardReferences;
    counts.declaredHoverReferenceMismatches += report.payloads.counts.declaredHoverReferenceMismatches;
    counts.pngStoredContainerChanges += report.payloads.counts.pngStoredContainerChanges;
    counts.hoverStoredContainerChanges += report.payloads.counts.hoverStoredContainerChanges;
    if (report.payloads.pngStoredContainerChanges.count > 0) {
      manifestsWithPngContainerChanges += 1;
      updateFramedJsonHash(aggregatePngContainerChangeHash, {
        manifest: report.id,
        count: report.payloads.pngStoredContainerChanges.count,
        sha256: report.payloads.pngStoredContainerChanges.sha256,
      });
      for (const entry of report.payloads.pngStoredContainerChanges.entries) {
        if (aggregatePngContainerChangeEntries.length >= MAX_PNG_CONTAINER_CHANGE_DETAILS) {
          break;
        }
        aggregatePngContainerChangeEntries.push({ manifest: report.id, ...entry });
      }
    }
    if (report.payloads.hoverStoredContainerChanges.count > 0) {
      manifestsWithHoverContainerChanges += 1;
      updateFramedJsonHash(aggregateHoverContainerChangeHash, {
        manifest: report.id,
        count: report.payloads.hoverStoredContainerChanges.count,
        sha256: report.payloads.hoverStoredContainerChanges.sha256,
      });
      for (const entry of report.payloads.hoverStoredContainerChanges.entries) {
        if (aggregateHoverContainerChangeEntries.length >= MAX_HOVER_CONTAINER_CHANGE_DETAILS) {
          break;
        }
        aggregateHoverContainerChangeEntries.push({ manifest: report.id, ...entry });
      }
    }
    if (report.signatureTransition) {
      counts.rendererSignatureTransitionsChecked += 1;
      if (report.signatureTransition.valid) {
        counts.rendererSignatureTransitionsValid += 1;
      } else {
        counts.rendererSignatureTransitionsInvalid += 1;
        mismatches.rendererSignatureTransitions += 1;
      }
    }
    mismatches.payloads += report.payloads.mismatches.length;
    bytes.baselineStored += report.payloads.bytes.baselineStored;
    bytes.candidateStored += report.payloads.bytes.candidateStored;
    bytes.baselineCanonical += report.payloads.bytes.baselineDecoded;
    bytes.candidateCanonical += report.payloads.bytes.candidateDecoded;
    bytes.comparedCanonical += report.payloads.bytes.comparedCanonical;
    bytes.equalCanonical += report.payloads.bytes.equalCanonical;
  }
  mismatches.total =
    mismatches.manifests + mismatches.completionMarkers + mismatches.payloads + mismatches.rendererSignatureTransitions;
  const pngStoredContainerChanges = {
    count: counts.pngStoredContainerChanges,
    manifestsWithChanges: manifestsWithPngContainerChanges,
    entries: aggregatePngContainerChangeEntries,
    detailsTruncated: counts.pngStoredContainerChanges > aggregatePngContainerChangeEntries.length,
    sha256: aggregatePngContainerChangeHash.digest("hex"),
  };
  const hoverStoredContainerChanges = {
    count: counts.hoverStoredContainerChanges,
    manifestsWithChanges: manifestsWithHoverContainerChanges,
    entries: aggregateHoverContainerChangeEntries,
    detailsTruncated: counts.hoverStoredContainerChanges > aggregateHoverContainerChangeEntries.length,
    sha256: aggregateHoverContainerChangeHash.digest("hex"),
  };
  return { counts, bytes, mismatches, pngStoredContainerChanges, hoverStoredContainerChanges };
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256Json(value) {
  return sha256Bytes(Buffer.from(stableStringify(value)));
}

function printUsage() {
  process.stdout.write(`Usage:
  node scripts/compare-render-artifacts.js \\
    --baseline-cache-root=/path/to/baseline-cache \\
    --candidate-cache-root=/path/to/candidate-cache \\
    --manifest=hrrr/20260716-1300Z--conus.json \\
    [--manifest=gfs/20260716-0600Z--conus.json] \\
    [--png-comparison=container|decoded-rgba] \\
    [--hover-comparison=container|decoded-int16]

The comparator is read-only. It compares only payloads referenced by the
specified run manifests and prints one machine-readable JSON report. PNG
comparison defaults to exact container bytes; container bytes are only
comparable when both trees used the same PNG deflate backend
(MODELVIEW_PNG_DEFLATE_BACKEND), so cross-backend trees must use
decoded-rgba. decoded-rgba is available for any pair of trees (the
renderer-signature transition is reported, not required) and validates
declared PNG sizes.
Hover comparison defaults to exact decompressed container bytes. decoded-int16
strictly validates and compares absolute signed Int16 grids and declarations;
base schema 0/null/absence is a strict-decode wildcard, supplemental null/absence
inherits the base declaration, and effective schemas 1-4 bind exactly.
`);
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
    } else {
      const report = compareArtifactCaches(normalizeOptions(args));
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.exact ? 0 : 1;
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: REPORT_SCHEMA_VERSION,
          comparison: "manifest-referenced-render-artifacts",
          exact: false,
          fatal: { message: error.message },
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 2;
  }
}

module.exports = {
  REPORT_SCHEMA_VERSION,
  HOVER_COMPARISON_CONTAINER,
  HOVER_COMPARISON_DECODED_INT16,
  PNG_COMPARISON_CONTAINER,
  PNG_COMPARISON_DECODED_RGBA,
  canonicalizeArtifactKey,
  collectReferencedInventory,
  compareArtifactCaches,
  compareJsonArtifacts,
  deriveFrameMarkerKey,
  normalizeCompletionJson,
  normalizeHoverComparisonMode,
  normalizeManifestJson,
  normalizePngComparisonMode,
  normalizeOptions,
  parseArgs,
  parseManifestSpec,
};
