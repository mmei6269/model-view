"use strict";

const crypto = require("crypto");

const SOURCE_PROVENANCE_SCHEMA_VERSION = 2;

const SOURCE_PROVENANCE_CATALOG_SCHEMA_VERSION = 1;

const SOURCE_PROVENANCE_METHODS = Object.freeze({
  targetGrid: "wgrib2-regular-latlon-then-webmercator-row-remap-v1",
  scalarInterpolation: "wgrib2-bilinear-plus-webmercator-row-bilinear-v1",
  categoricalInterpolation: "wgrib2-neighbor-plus-webmercator-row-nearest-v1",
  vectorWind: "wgrib2-new-grid-winds-earth-v1",
  sentinelMask: "pre-regrid-cloud-ceiling-19900-20100m-and-mxuphl-minus999-undefine-v1",
  decodedMissing: "nonfinite-or-abs-gte-1e19-to-nan-v1",
  pressureLevelTerrainMask: "pressure-level-height-at-or-below-surface-height-to-nan-v1",
});

function buildRunSourceProvenanceCatalog({ toolIdentity } = {}) {
  const tool = normalizeExactToolIdentity(toolIdentity);
  if (!tool) {
    throw new Error("Exact source provenance requires a resolved, versioned, SHA-256-identified wgrib2 binary.");
  }
  return {
    schemaVersion: SOURCE_PROVENANCE_CATALOG_SCHEMA_VERSION,
    scope: "run-deduplicated-tool-identities",
    tools: [tool],
  };
}

function buildFrameSourceProvenance({
  gribUrl,
  idxUrl,
  selection,
  bounds,
  width,
  height,
  renderMode = "all",
  toolRef = null,
  sourceInputs = [],
  temporalDerivations = [],
  parameterAvailability = null,
}) {
  const catalog = Array.isArray(selection?.catalog) ? selection.catalog : [];
  const source = { gribUrl: normalizeString(gribUrl), idxUrl: normalizeString(idxUrl) };
  const sources = normalizeSources(sourceInputs);
  let currentSourceRefs = sources.filter((entry) => entry.gribUrl === source.gribUrl).map((entry) => entry.id);
  if (currentSourceRefs.length === 0) {
    // The selected-record summary is only consumed by this fallback (the
    // normal build path always registers a hashed current source), so it is
    // built lazily instead of summarizing and sorting every frame.
    const fallback = buildUnhashedCurrentSource(source, summarizeSelectedRecords(selection?.records));
    sources.push(fallback);
    currentSourceRefs = [fallback.id];
  }
  const resolvedDerivations = resolveTemporalDerivations(temporalDerivations, sources);
  const availableParameterSet = Array.isArray(selection?.availableParameters)
    ? new Set(selection.availableParameters.map((key) => String(key)))
    : null;
  const expectedTemporalOutputKeys = normalizeStrings(
    catalog
      .filter(
        (entry) =>
          isTemporalDerivedEntry(entry) &&
          (!availableParameterSet || availableParameterSet.has(String(entry?.key))) &&
          parameterAvailability?.[entry?.key] !== "unavailable",
      )
      .map((entry) => entry?.key),
  );
  const mayUseEarlierForecastHours = expectedTemporalOutputKeys.length > 0 || resolvedDerivations.length > 0;
  return {
    schemaVersion: SOURCE_PROVENANCE_SCHEMA_VERSION,
    scope: "exact-selected-record-lineage",
    renderModes: normalizeStrings([renderMode]),
    source,
    toolRef: normalizeString(toolRef),
    currentSourceRefs: normalizeStrings(currentSourceRefs),
    sources: sources.sort(compareSources),
    targetGrid: {
      cols: normalizePositiveInteger(width),
      rows: normalizePositiveInteger(height),
      bounds: normalizeBounds(bounds),
    },
    methods: { ...SOURCE_PROVENANCE_METHODS },
    temporalDerivedInputs: buildTemporalDisclosure(
      mayUseEarlierForecastHours,
      resolvedDerivations,
      sources,
      expectedTemporalOutputKeys,
    ),
  };
}

function summarizeSelectedRecords(recordsByKey) {
  const out = [];
  const indexByIdentity = new Map();
  for (const record of Object.values(recordsByKey || {})) {
    if (!record || typeof record !== "object") {
      continue;
    }
    const summary = normalizeRecordSummary({
      record: record.record,
      param: record.param,
      level: record.level,
      forecast: record.forecast,
      extra: record.extra,
      referenceTimeToken: record.dateToken,
      rawInventory: record.line,
      accumulationWindow: record.accumulationWindow,
      averageWindow: record.averageWindow,
      statisticalWindow: record.statisticalWindow,
      byteRange:
        finiteNumber(record.offset) !== null && finiteNumber(record.endExclusive) !== null
          ? { start: Number(record.offset), endInclusive: Number(record.endExclusive) - 1 }
          : null,
    });
    if (!summary) {
      continue;
    }
    const identity = recordSummaryIdentity(summary);
    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex !== undefined) {
      if (!out[existingIndex].byteRange && summary.byteRange) {
        out[existingIndex] = summary;
      }
      continue;
    }
    indexByIdentity.set(identity, out.length);
    out.push(summary);
  }
  return out.sort(compareRecordSummaries);
}

function mergeFrameSourceProvenance(existingValue, incomingValue) {
  const existing = normalizeFrameSourceProvenance(existingValue);
  const incoming = normalizeFrameSourceProvenance(incomingValue);
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  const sources = deduplicateById([...existing.sources, ...incoming.sources]).sort(compareSources);
  const derivations = deduplicateById([
    ...existing.temporalDerivedInputs.derivations,
    ...incoming.temporalDerivedInputs.derivations,
  ]);
  const mayUseEarlierForecastHours = Boolean(
    existing.temporalDerivedInputs.mayUseEarlierForecastHours ||
    incoming.temporalDerivedInputs.mayUseEarlierForecastHours,
  );
  const expectedTemporalOutputKeys = normalizeStrings([
    ...(existing.temporalDerivedInputs.expectedOutputKeys || []),
    ...(incoming.temporalDerivedInputs.expectedOutputKeys || []),
  ]);
  // The merge of two normalized inputs is itself in normalized form (same
  // normalizers produce every field), so it carries the marker; the
  // idempotence unit test covers normalize(merge(a, b)) === merge(a, b).
  return markNormalizedFrameSourceProvenance({
    schemaVersion: SOURCE_PROVENANCE_SCHEMA_VERSION,
    scope: "exact-selected-record-lineage",
    renderModes: normalizeStrings([...existing.renderModes, ...incoming.renderModes]),
    source: {
      gribUrl: incoming.source.gribUrl || existing.source.gribUrl,
      idxUrl: incoming.source.idxUrl || existing.source.idxUrl,
    },
    toolRef: incoming.toolRef || existing.toolRef,
    currentSourceRefs: normalizeStrings([...existing.currentSourceRefs, ...incoming.currentSourceRefs]),
    sources,
    targetGrid: incoming.targetGrid || existing.targetGrid,
    methods: { ...existing.methods, ...incoming.methods },
    temporalDerivedInputs: buildTemporalDisclosure(
      mayUseEarlierForecastHours,
      derivations,
      sources,
      expectedTemporalOutputKeys,
    ),
  });
}

// Objects produced by normalizeFrameSourceProvenance/mergeFrameSourceProvenance
// are stamped with this non-enumerable marker so the runtime's repeated
// normalize/merge passes over the same frame provenance short-circuit
// instead of re-walking sources x records several times per frame part.
// Normalization is idempotent (covered by a unit test), so returning a
// marked object unchanged is byte-identical to re-normalizing it. The
// marker is non-enumerable: JSON serialization and object spreads are
// unaffected, and deserialized copies are simply re-normalized once.
const NORMALIZED_FRAME_SOURCE_PROVENANCE = Symbol("normalizedFrameSourceProvenance");

function markNormalizedFrameSourceProvenance(value) {
  if (value && typeof value === "object") {
    Object.defineProperty(value, NORMALIZED_FRAME_SOURCE_PROVENANCE, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return value;
}

function normalizeFrameSourceProvenance(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value[NORMALIZED_FRAME_SOURCE_PROVENANCE] === true) {
    return value;
  }
  const source = value.source && typeof value.source === "object" ? value.source : {};
  const records = mergeRecordSummaries(
    [],
    Array.isArray(value.currentSelectedRecords)
      ? value.currentSelectedRecords.map(normalizeRecordSummary).filter(Boolean)
      : [],
  );
  let sources = normalizeSources(value.sources);
  let currentSourceRefs = normalizeStrings(value.currentSourceRefs);
  if (sources.length === 0) {
    const fallback = buildUnhashedCurrentSource(
      { gribUrl: normalizeString(source.gribUrl), idxUrl: normalizeString(source.idxUrl) },
      records,
    );
    sources = [fallback];
    currentSourceRefs = [fallback.id];
  }
  const derivations = resolveTemporalDerivations(value.temporalDerivedInputs?.derivations, sources);
  return markNormalizedFrameSourceProvenance({
    schemaVersion: SOURCE_PROVENANCE_SCHEMA_VERSION,
    scope: "exact-selected-record-lineage",
    renderModes: normalizeStrings(value.renderModes),
    source: {
      gribUrl: normalizeString(source.gribUrl),
      idxUrl: normalizeString(source.idxUrl),
    },
    toolRef: normalizeString(value.toolRef),
    currentSourceRefs,
    sources: sources.sort(compareSources),
    targetGrid: normalizeTargetGrid(value.targetGrid),
    methods: normalizeMethods(value.methods),
    temporalDerivedInputs: buildTemporalDisclosure(
      Boolean(value.temporalDerivedInputs?.mayUseEarlierForecastHours),
      derivations,
      sources,
      value.temporalDerivedInputs?.expectedOutputKeys,
    ),
  });
}

function normalizeExactToolIdentity(value) {
  const sha256 = normalizeString(value?.sha256)?.toLowerCase() || null;
  const id = normalizeString(value?.id);
  const resolvedPath = normalizeString(value?.resolvedPath);
  const versionOutput = normalizeString(value?.versionOutput);
  if (!id || !resolvedPath || !versionOutput || !/^[a-f0-9]{64}$/.test(sha256 || "")) {
    return null;
  }
  return {
    id,
    name: normalizeString(value?.name) || "wgrib2",
    configuredPath: normalizeString(value?.configuredPath),
    resolvedPath,
    versionOutput,
    sha256,
  };
}

function normalizeSources(values) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const source = normalizeSource(value);
    if (source) {
      out.push(source);
    }
  }
  return deduplicateById(out);
}

function normalizeSource(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const records = mergeRecordSummaries(
    [],
    Array.isArray(value.records) ? value.records.map(normalizeRecordSummary).filter(Boolean) : [],
  );
  const gribUrl = normalizeString(value.gribUrl);
  const id = normalizeString(value.id);
  if (!id || !gribUrl) {
    return null;
  }
  const selectedSha256 = normalizeString(value.selectedSha256)?.toLowerCase() || null;
  return {
    id,
    modelKey: normalizeString(value.modelKey),
    productKey: normalizeString(value.productKey),
    date: normalizeString(value.date),
    cycle: normalizeString(value.cycle),
    forecastHour: finiteNumber(value.forecastHour),
    referenceTime: normalizeIsoTime(value.referenceTime),
    validTime: normalizeIsoTime(value.validTime),
    gribUrl,
    idxUrl: normalizeString(value.idxUrl) || `${gribUrl}.idx`,
    selectedHash: normalizeString(value.selectedHash),
    selectedSha256: /^[a-f0-9]{64}$/.test(selectedSha256 || "") ? selectedSha256 : null,
    selectedBytes: finiteNumber(value.selectedBytes),
    records,
  };
}

function buildUnhashedCurrentSource(source, records) {
  const payload = { gribUrl: source.gribUrl, idxUrl: source.idxUrl, records };
  return {
    id: `unhashed-current:${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
    modelKey: null,
    productKey: null,
    date: null,
    cycle: null,
    forecastHour: null,
    referenceTime: null,
    validTime: null,
    gribUrl: source.gribUrl,
    idxUrl: source.idxUrl,
    selectedHash: null,
    selectedSha256: null,
    selectedBytes: null,
    records,
  };
}

function resolveTemporalDerivations(values, sources) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const family = normalizeString(value?.family);
    if (!family) {
      continue;
    }
    const terms = [];
    for (const rawTerm of Array.isArray(value?.terms) ? value.terms : []) {
      const term = normalizeTemporalTerm(rawTerm);
      if (!term) {
        continue;
      }
      const matches = findSourceRecordsForTerm(sources, term);
      const explicitSourceRef = normalizeString(rawTerm?.sourceRef);
      const explicitMatch = explicitSourceRef
        ? matches.find((candidate) => candidate.source.id === explicitSourceRef)
        : null;
      const match = explicitMatch || (matches.length === 1 ? matches[0] : null);
      terms.push({
        ...term,
        sourceRef: match?.source.id || null,
        recordRef: match ? `${match.source.id}#${match.recordIndex}` : null,
        ...(matches.length > 1 && !explicitMatch
          ? { ambiguousSourceRefs: normalizeStrings(matches.map((candidate) => candidate.source.id)) }
          : {}),
      });
    }
    const normalized = {
      family,
      outputKey: normalizeString(value.outputKey),
      targetHour: finiteNumber(value.targetHour),
      terms: deduplicateTemporalTerms(terms),
    };
    const inputCoverage = normalizeTemporalInputCoverage(value.inputCoverage);
    if (inputCoverage) {
      normalized.inputCoverage = inputCoverage;
    }
    normalized.id =
      normalizeString(value.id) ||
      `temporal:${crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
    out.push(normalized);
  }
  return deduplicateById(out).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function normalizeTemporalInputCoverage(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const normalizeRoles = (roles) => normalizeStrings(Array.isArray(roles) ? roles : []);
  const requiredRoles = normalizeRoles(value.requiredRoles);
  const recordedRoles = normalizeRoles(value.recordedRoles);
  const recordedSet = new Set(recordedRoles);
  const missingRoles = normalizeRoles([
    ...(Array.isArray(value.missingRoles) ? value.missingRoles : []),
    ...requiredRoles.filter((role) => !recordedSet.has(role)),
  ]);
  return {
    complete: Boolean(value.complete) && missingRoles.length === 0,
    requiredRoles,
    recordedRoles,
    missingRoles,
  };
}

function normalizeTemporalTerm(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const sourceHour = finiteNumber(value.sourceHour);
  const record = normalizeRecordSummary(value.record);
  if (sourceHour === null || !record) {
    return null;
  }
  return {
    sourceHour,
    role: normalizeString(value.role) || "value",
    weight: finiteNumber(value.weight) ?? 1,
    sourceKey: normalizeString(value.sourceKey),
    kind: normalizeString(value.kind),
    startHour: finiteNumber(value.startHour),
    endHour: finiteNumber(value.endHour),
    record,
  };
}

function findSourceRecordsForTerm(sources, term) {
  const matches = [];
  for (const source of sources) {
    if (Number(source.forecastHour) !== Number(term.sourceHour)) {
      continue;
    }
    const recordIndex = source.records.findIndex((record) => recordsMatch(record, term.record));
    if (recordIndex >= 0) {
      matches.push({ source, recordIndex });
    }
  }
  return matches;
}

function compareTemporalDerivations(left, right) {
  const outputDelta = String(left?.outputKey || "").localeCompare(String(right?.outputKey || ""));
  if (outputDelta !== 0) {
    return outputDelta;
  }
  const hourDelta =
    Number(left?.targetHour ?? Number.MAX_SAFE_INTEGER) - Number(right?.targetHour ?? Number.MAX_SAFE_INTEGER);
  if (hourDelta !== 0) {
    return hourDelta;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function buildTemporalDisclosure(mayUseEarlierForecastHours, rawDerivations, sources, expectedOutputKeys = []) {
  // Canonical derivation order (2026-07-11): the recorded lineage set is a
  // deterministic function of the frame's computations, but its array order
  // previously depended on merge/normalization sequence. Sorting here makes
  // marker provenance byte-stable across cache states and merge orders;
  // content is unchanged.
  const derivations = [...rawDerivations].sort(compareTemporalDerivations);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const terms = derivations.flatMap((derivation) => derivation.terms || []);
  const expected = normalizeStrings(expectedOutputKeys);
  const recordedOutputKeys = normalizeStrings(derivations.map((derivation) => derivation.outputKey));
  const recordedOutputSet = new Set(recordedOutputKeys);
  const missingOutputKeys = expected.filter((key) => !recordedOutputSet.has(key));
  const completeDerivations =
    derivations.length > 0 &&
    derivations.every(
      (derivation) =>
        Boolean(derivation.outputKey) &&
        Array.isArray(derivation.terms) &&
        derivation.terms.length > 0 &&
        derivation.inputCoverage?.complete !== false,
    );
  const exact =
    mayUseEarlierForecastHours &&
    missingOutputKeys.length === 0 &&
    completeDerivations &&
    terms.every((term) => {
      const source = sourceById.get(term.sourceRef);
      const recordIndex = Number(
        String(term.recordRef || "")
          .split("#")
          .at(-1),
      );
      const record = source?.records?.[recordIndex];
      return Boolean(
        source?.selectedSha256 &&
        source?.referenceTime &&
        source?.validTime &&
        Number(source.forecastHour) === Number(term.sourceHour) &&
        Number.isFinite(term.weight) &&
        term.role &&
        record?.rawInventory &&
        record?.forecast &&
        recordReferenceTimeMatchesSource(record, source) &&
        statisticalWindowMatchesTerm(record, term) &&
        recordsMatch(record, term.record) &&
        record?.byteRange &&
        Number.isFinite(record.byteRange.start) &&
        Number.isFinite(record.byteRange.endInclusive),
      );
    });
  return {
    mayUseEarlierForecastHours: Boolean(mayUseEarlierForecastHours),
    exactTemporalReferencesRecorded: exact,
    expectedOutputKeys: expected,
    recordedOutputKeys,
    missingOutputKeys,
    derivations,
    disclosure: !mayUseEarlierForecastHours
      ? "No temporal derived input was selected for this render part."
      : exact
        ? "Every required temporal input role is recorded and resolves to a SHA-256-identified selected GRIB, exact byte range, raw inventory/time text, and explicit composition weight/window."
        : "A temporal output derivation or term is missing, at least one required input role is missing, a producer is ambiguous, source-time/statistical-window semantics disagree, or a term lacks raw-inventory, SHA-256 selected-source, or exact byte-range identity; this sidecar does not claim exact lineage.",
  };
}

function recordReferenceTimeMatchesSource(record, source) {
  const referenceTime = normalizeIsoTime(source?.referenceTime);
  const token = normalizeString(record?.referenceTimeToken);
  const rawInventory = normalizeString(record?.rawInventory);
  if (!referenceTime || !token || !rawInventory) {
    return false;
  }
  const date = new Date(referenceTime);
  const expected = `d=${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(
    date.getUTCDate(),
  ).padStart(2, "0")}${String(date.getUTCHours()).padStart(2, "0")}`;
  return token === expected && rawInventory.split(":").includes(token);
}

function statisticalWindowMatchesTerm(record, term) {
  const window = normalizeStatisticalWindow(record?.statisticalWindow);
  if (!window) {
    return true;
  }
  return Number(term?.startHour) === window.startHour && Number(term?.endHour) === window.endHour;
}

function normalizeRecordSummary(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const summary = {
    record: normalizeString(value.record),
    param: normalizeString(value.param),
    level: normalizeString(value.level),
    forecast: normalizeString(value.forecast),
    extra: normalizeString(value.extra),
    referenceTimeToken: normalizeString(value.referenceTimeToken),
    rawInventory: normalizeString(value.rawInventory),
    accumulationWindow: normalizeWindow(value.accumulationWindow),
    averageWindow: normalizeWindow(value.averageWindow),
    statisticalWindow: normalizeStatisticalWindow(value.statisticalWindow),
  };
  const start = finiteNumber(value.byteRange?.start);
  const endInclusive = finiteNumber(value.byteRange?.endInclusive);
  if (start !== null && endInclusive !== null && endInclusive >= start) {
    summary.byteRange = { start, endInclusive };
  } else {
    summary.byteRange = null;
  }
  return summary;
}

function normalizeWindow(value) {
  const startHour = finiteNumber(value?.startHour);
  const endHour = finiteNumber(value?.endHour);
  return startHour !== null && endHour !== null && endHour >= startHour ? { startHour, endHour } : null;
}

function normalizeStatisticalWindow(value) {
  const window = normalizeWindow(value);
  const statistic = normalizeString(value?.statistic);
  return window && statistic ? { statistic, ...window } : null;
}

function normalizeIsoTime(value) {
  const text = normalizeString(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(Date.parse(text)).toISOString() : null;
}

function normalizeTargetGrid(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    cols: normalizePositiveInteger(value.cols),
    rows: normalizePositiveInteger(value.rows),
    bounds: normalizeBounds(value.bounds),
  };
}

function normalizeMethods(value) {
  const out = { ...SOURCE_PROVENANCE_METHODS };
  if (!value || typeof value !== "object") {
    return out;
  }
  for (const key of Object.keys(SOURCE_PROVENANCE_METHODS)) {
    const method = normalizeString(value[key]);
    if (method) {
      out[key] = method;
    }
  }
  return out;
}

function isTemporalDerivedEntry(entry) {
  const kind = String(entry?.kind || "");
  return Boolean(
    entry?.accumulationMode ||
    kind === "precipAccumulation" ||
    kind === "derivedAccumulation" ||
    kind === "snowfallDerived",
  );
}

function normalizeBounds(value) {
  return {
    north: finiteNumber(value?.north),
    south: finiteNumber(value?.south),
    west: finiteNumber(value?.west),
    east: finiteNumber(value?.east),
  };
}

function normalizeStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(normalizeString).filter(Boolean))).sort();
}

function normalizeString(value) {
  return String(value || "").trim() || null;
}

function normalizePositiveInteger(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function recordSummaryIdentity(summary) {
  return [
    summary.record,
    summary.param,
    summary.level,
    summary.forecast,
    summary.extra,
    summary.referenceTimeToken,
    summary.rawInventory,
    JSON.stringify(summary.statisticalWindow),
  ].join("|");
}

function compareRecordSummaries(left, right) {
  const leftNumber = Number(String(left.record || "").split(".")[0]);
  const rightNumber = Number(String(right.record || "").split(".")[0]);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return recordSummaryIdentity(left).localeCompare(recordSummaryIdentity(right));
}

function mergeRecordSummaries(left, right) {
  const byIdentity = new Map();
  for (const summary of [...(left || []), ...(right || [])]) {
    const normalized = normalizeRecordSummary(summary);
    if (!normalized) {
      continue;
    }
    const identity = recordSummaryIdentity(normalized);
    const existing = byIdentity.get(identity);
    if (!existing || (!existing.byteRange && normalized.byteRange)) {
      byIdentity.set(identity, normalized);
    }
  }
  return [...byIdentity.values()].sort(compareRecordSummaries);
}

function recordsMatch(left, right) {
  if (left.record && right.record && String(left.record) === String(right.record)) {
    return true;
  }
  return (
    left.param === right.param &&
    left.level === right.level &&
    left.forecast === right.forecast &&
    left.extra === right.extra
  );
}

function deduplicateTemporalTerms(terms) {
  const byIdentity = new Map();
  for (const term of terms) {
    const identity = JSON.stringify(term);
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, term);
    }
  }
  return [...byIdentity.values()].sort((left, right) => {
    if (left.sourceHour !== right.sourceHour) {
      return left.sourceHour - right.sourceHour;
    }
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
}

function deduplicateById(values) {
  const byId = new Map();
  for (const value of values || []) {
    if (value?.id) {
      byId.set(String(value.id), value);
    }
  }
  return [...byId.values()];
}

function compareSources(left, right) {
  const hourDelta =
    Number(left.forecastHour ?? Number.MAX_SAFE_INTEGER) - Number(right.forecastHour ?? Number.MAX_SAFE_INTEGER);
  return hourDelta || String(left.id).localeCompare(String(right.id));
}

module.exports = {
  SOURCE_PROVENANCE_CATALOG_SCHEMA_VERSION,
  SOURCE_PROVENANCE_METHODS,
  SOURCE_PROVENANCE_SCHEMA_VERSION,
  buildFrameSourceProvenance,
  buildRunSourceProvenanceCatalog,
  mergeFrameSourceProvenance,
  normalizeFrameSourceProvenance,
  summarizeSelectedRecords,
};
