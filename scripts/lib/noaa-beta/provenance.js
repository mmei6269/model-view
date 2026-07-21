"use strict";

const crypto = require("crypto");
const { boundedRunCacheGet, boundedRunCacheSet, createBoundedRunCacheMap } = require("./cache-io");
const { normalizeStatisticalWindow } = require("./selected-grib");

const GRID_SOURCE_REFS = new WeakMap();

function getFrameSourceProvenanceSources(decodeSession) {
  return [...(decodeSession?.sourceProvenanceSources?.values?.() || [])].sort((left, right) =>
    String(left.id).localeCompare(String(right.id)),
  );
}

const TEMPORAL_DERIVATION_ID_CACHE = createBoundedRunCacheMap(2048);

function registerTemporalProvenanceDerivation(
  decodeSession,
  { family, outputKey = null, targetHour = null, terms = [], inputCoverage = null } = {},
) {
  if (!decodeSession || !family) {
    return null;
  }
  const normalizedTerms = collectTemporalProvenanceTerms(terms);
  const derivation = {
    family: String(family),
    outputKey: String(outputKey || "") || null,
    targetHour: finiteForecastHour(targetHour),
    terms: normalizedTerms,
  };
  const normalizedCoverage = normalizeTemporalInputCoverage(inputCoverage);
  if (normalizedCoverage) {
    derivation.inputCoverage = normalizedCoverage;
  }
  // The same derivation is re-registered by every frame that consumes the
  // same temporal chain (registration on cache hits is part of the lineage
  // contract), so the content-hash id is memoized by its JSON form.
  const derivationJson = JSON.stringify(derivation);
  let id = boundedRunCacheGet(TEMPORAL_DERIVATION_ID_CACHE, derivationJson);
  if (!id) {
    id = `temporal:${crypto.createHash("sha256").update(derivationJson).digest("hex")}`;
    boundedRunCacheSet(TEMPORAL_DERIVATION_ID_CACHE, derivationJson, id);
  }
  derivation.id = id;
  if (!(decodeSession.temporalProvenanceDerivations instanceof Map)) {
    decodeSession.temporalProvenanceDerivations = new Map();
  }
  decodeSession.temporalProvenanceDerivations.set(derivation.id, derivation);
  markTemporalTermSourcesUsed(decodeSession, derivation.terms);
  return derivation;
}

function normalizeTemporalInputCoverage(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const normalizeRoles = (roles) =>
    Array.from(
      new Set((Array.isArray(roles) ? roles : []).map((role) => String(role || "").trim()).filter(Boolean)),
    ).sort();
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

function collectTemporalProvenanceTerms(terms) {
  const normalizedTerms = [];
  for (const term of Array.isArray(terms) ? terms : []) {
    const sourceHour = finiteForecastHour(term?.hour ?? term?.sourceHour ?? term?.endHour);
    const base = normalizeTemporalProvenanceTerm(term, sourceHour, "value");
    if (base) {
      normalizedTerms.push(base);
    }
    for (const [role, record] of Object.entries(term?.maskRecords || {})) {
      const mask = normalizeTemporalProvenanceTerm({ ...term, record, role }, sourceHour, role);
      if (mask) {
        normalizedTerms.push(mask);
      }
    }
    for (const sample of Array.isArray(term?.maskSamples) ? term.maskSamples : []) {
      const sampleHour = finiteForecastHour(sample?.hour ?? sourceHour);
      for (const [role, record] of Object.entries(sample || {})) {
        if (role === "hour" || role === "weight") {
          continue;
        }
        const mask = normalizeTemporalProvenanceTerm(
          { ...term, record, role, weight: sample?.weight },
          sampleHour,
          role,
        );
        if (mask) {
          normalizedTerms.push(mask);
        }
      }
    }
  }
  return deduplicateTemporalTerms(normalizedTerms);
}

function markTemporalTermSourcesUsed(decodeSession, terms) {
  if (!decodeSession) {
    return;
  }
  if (!(decodeSession.sourceProvenanceSources instanceof Map)) {
    decodeSession.sourceProvenanceSources = new Map();
  }
  const catalog = decodeSession.runSourceProvenanceCatalog;
  for (const sourceRef of temporalSourceRefsForTerms(decodeSession, terms)) {
    if (decodeSession.sourceProvenanceSources.has(sourceRef)) {
      continue;
    }
    const source = catalog instanceof Map ? catalog.get(sourceRef) : null;
    if (source) {
      decodeSession.sourceProvenanceSources.set(sourceRef, source);
    }
  }
}

function temporalSourceRefsForTerms(decodeSession, terms) {
  const currentSources = [...(decodeSession?.sourceProvenanceSources?.values?.() || [])];
  const catalogSources = [...(decodeSession?.runSourceProvenanceCatalog?.values?.() || [])];
  const refs = new Set();
  for (const term of Array.isArray(terms) ? terms : []) {
    const sourceHour = finiteForecastHour(term?.sourceHour ?? term?.hour ?? term?.endHour);
    const record = term?.record;
    if (sourceHour === null || !record) {
      continue;
    }
    // Prefer the selected artifact actually registered by this frame. The
    // run catalog is only a fallback for a grid reused from a run-local cache.
    // This avoids attributing a record to a different selected-GRIB bundle
    // that happens to contain the same raw inventory row.
    let matches = currentSources.filter((source) => temporalSourceMatchesTerm(source, sourceHour, record));
    if (matches.length === 0) {
      matches = catalogSources.filter((source) => temporalSourceMatchesTerm(source, sourceHour, record));
    }
    for (const source of matches) {
      if (source?.id) {
        refs.add(String(source.id));
      }
    }
  }
  return [...refs].sort();
}

function temporalSourceMatchesTerm(source, sourceHour, record) {
  return (
    Number(source?.forecastHour) === Number(sourceHour) &&
    (source?.records || []).some((candidate) => temporalRecordMatches(candidate, record))
  );
}

function buildRunLocalGridCacheEntry(values, decodeSession, terms, exactSourceRefs = null) {
  const inheritedSourceRefs = GRID_SOURCE_REFS.get(values);
  const sourceRefs = normalizeSourceRefs(
    Array.isArray(exactSourceRefs)
      ? exactSourceRefs
      : Array.isArray(inheritedSourceRefs)
        ? inheritedSourceRefs
        : temporalSourceRefsForTerms(decodeSession, terms),
  );
  GRID_SOURCE_REFS.set(values, sourceRefs);
  return {
    values,
    sourceRefs,
  };
}

function normalizeSourceRefs(values) {
  return Array.from(
    new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean)),
  ).sort();
}

function restoreRunLocalGridCacheEntry(entry, decodeSession) {
  const wrapped = entry && !(entry instanceof Float32Array) && typeof entry === "object" ? entry : null;
  const values = wrapped?.values || entry;
  if (!(values instanceof Float32Array)) {
    return null;
  }
  if (Array.isArray(wrapped?.sourceRefs)) {
    GRID_SOURCE_REFS.set(values, normalizeSourceRefs(wrapped.sourceRefs));
  }
  if (decodeSession && Array.isArray(wrapped?.sourceRefs)) {
    if (!(decodeSession.sourceProvenanceSources instanceof Map)) {
      decodeSession.sourceProvenanceSources = new Map();
    }
    const catalog = decodeSession.runSourceProvenanceCatalog;
    for (const sourceRef of wrapped.sourceRefs) {
      const source =
        decodeSession.sourceProvenanceSources.get(String(sourceRef)) ||
        (catalog instanceof Map ? catalog.get(String(sourceRef)) : null);
      if (source) {
        decodeSession.sourceProvenanceSources.set(String(sourceRef), source);
      }
    }
  }
  return values;
}

function temporalRecordMatches(left, right) {
  if (left?.record && right?.record && String(left.record) === String(right.record)) {
    return true;
  }
  return (
    String(left?.param || "") === String(right?.param || "") &&
    String(left?.level || "") === String(right?.level || "") &&
    String(left?.forecast || "") === String(right?.forecast || "")
  );
}

function normalizeTemporalProvenanceTerm(term, sourceHour, fallbackRole) {
  const record = term?.record;
  if (!record || !Number.isFinite(sourceHour)) {
    return null;
  }
  const statisticalWindow = normalizeStatisticalWindow(record);
  return {
    sourceHour,
    role: String(term?.role || fallbackRole || "value"),
    weight: Number.isFinite(Number(term?.weight)) ? Number(term.weight) : 1,
    sourceKey: String(term?.sourceKey || "") || null,
    kind: String(term?.kind || "") || null,
    startHour: finiteForecastHour(
      term?.startHour ??
        record?.accumulationWindow?.startHour ??
        record?.averageWindow?.startHour ??
        statisticalWindow?.startHour,
    ),
    endHour: finiteForecastHour(
      term?.endHour ??
        record?.accumulationWindow?.endHour ??
        record?.averageWindow?.endHour ??
        statisticalWindow?.endHour,
    ),
    record: {
      record: String(record.record || "") || null,
      param: String(record.param || "") || null,
      level: String(record.level || "") || null,
      forecast: String(record.forecast || "") || null,
      extra: String(record.extra || "") || null,
      referenceTimeToken: String(record.dateToken || "") || null,
      rawInventory: String(record.line || "") || null,
    },
  };
}

function finiteForecastHour(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
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

function getFrameTemporalProvenanceDerivations(decodeSession) {
  return [...(decodeSession?.temporalProvenanceDerivations?.values?.() || [])].sort((left, right) =>
    String(left.id).localeCompare(String(right.id)),
  );
}

function buildFrameProvenanceCacheSnapshot(
  decodeSession,
  {
    family = null,
    families = null,
    outputKey = null,
    maxTargetHour = null,
    terms = null,
    includeDerivations = true,
  } = {},
) {
  const familySet = new Set(
    [...(Array.isArray(families) ? families : []), ...(family ? [family] : [])]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  const targetHourCeiling = finiteForecastHour(maxTargetHour);
  const derivations = getFrameTemporalProvenanceDerivations(decodeSession).filter(
    (derivation) =>
      (familySet.size === 0 || familySet.has(derivation.family)) &&
      (!outputKey || derivation.outputKey === outputKey) &&
      (targetHourCeiling === null ||
        (Number.isFinite(Number(derivation.targetHour)) && Number(derivation.targetHour) <= targetHourCeiling)),
  );
  const usedTerms = Array.isArray(terms)
    ? collectTemporalProvenanceTerms(terms)
    : derivations.flatMap((derivation) => derivation.terms || []);
  markTemporalTermSourcesUsed(decodeSession, usedTerms);
  const sources = getFrameSourceProvenanceSources(decodeSession).filter((source) =>
    usedTerms.some(
      (term) =>
        Number(source.forecastHour) === Number(term.sourceHour) &&
        (source.records || []).some((record) => temporalRecordMatches(record, term.record)),
    ),
  );
  return {
    schemaVersion: 1,
    sources,
    temporalDerivations: includeDerivations ? derivations : [],
  };
}

function restoreFrameProvenanceCacheSnapshot(decodeSession, snapshot) {
  if (!decodeSession || snapshot?.schemaVersion !== 1) {
    return;
  }
  if (!(decodeSession.sourceProvenanceSources instanceof Map)) {
    decodeSession.sourceProvenanceSources = new Map();
  }
  for (const source of Array.isArray(snapshot.sources) ? snapshot.sources : []) {
    if (source?.id && /^[a-f0-9]{64}$/i.test(String(source.selectedSha256 || ""))) {
      decodeSession.sourceProvenanceSources.set(String(source.id), source);
      decodeSession.runSourceProvenanceCatalog?.set(String(source.id), source);
    }
  }
  if (!(decodeSession.temporalProvenanceDerivations instanceof Map)) {
    decodeSession.temporalProvenanceDerivations = new Map();
  }
  for (const derivation of Array.isArray(snapshot.temporalDerivations) ? snapshot.temporalDerivations : []) {
    if (derivation?.id) {
      decodeSession.temporalProvenanceDerivations.set(String(derivation.id), derivation);
    }
  }
}

module.exports = {
  buildFrameProvenanceCacheSnapshot,
  buildRunLocalGridCacheEntry,
  getFrameSourceProvenanceSources,
  getFrameTemporalProvenanceDerivations,
  registerTemporalProvenanceDerivation,
  restoreFrameProvenanceCacheSnapshot,
  restoreRunLocalGridCacheEntry,
};
