import type { FrameRecord, ModelKey, ModelManifest, ResolvedFrame, ValidTimeIso, ViewKey } from "../types";
import { normalizeIsoHour, toEpochMs } from "./time";

const DISABLED_PARAMETER_KEYS = new Set([
  "absoluteVorticity850",
  "cloudBaseHeight",
  "freezingLevel",
  "simulatedIrProxy",
  "snowCover",
  "stormMotionVectors",
  "verticalVelocity850",
]);

export function resolveFrameByValidTime(
  manifest: ModelManifest | null | undefined,
  validTimeIso: ValidTimeIso | null | undefined,
  fallbackMode: "nearest-absolute" | "nearest-future" | "hour-index" = "nearest-absolute",
): ResolvedFrame | null {
  if (!manifest || !Array.isArray(manifest.frames) || manifest.frames.length === 0) {
    return null;
  }
  const frames = [...manifest.frames].sort((left, right) => left.hour - right.hour);
  if (!validTimeIso) {
    const first = frames[0];
    return first
      ? {
          validHourKey: normalizeIsoHour(first.validHourKey),
          hour: first.hour,
          exact: false,
          deltaMinutes: 0,
        }
      : null;
  }
  const targetMs = toEpochMs(validTimeIso);
  if (!Number.isFinite(targetMs)) {
    const first = frames[0];
    return first
      ? {
          validHourKey: normalizeIsoHour(first.validHourKey),
          hour: first.hour,
          exact: false,
          deltaMinutes: 0,
        }
      : null;
  }
  let exact: FrameRecord | null = null;
  for (const frame of frames) {
    if (toEpochMs(frame.validHourKey) === targetMs) {
      exact = frame;
      break;
    }
  }
  if (exact) {
    return {
      validHourKey: normalizeIsoHour(exact.validHourKey),
      hour: exact.hour,
      exact: true,
      deltaMinutes: 0,
    };
  }

  let best: FrameRecord | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const frameMs = toEpochMs(frame.validHourKey);
    if (!Number.isFinite(frameMs)) {
      continue;
    }
    const delta = Math.abs(frameMs - targetMs);
    if (fallbackMode === "nearest-future" && frameMs < targetMs && best && toEpochMs(best.validHourKey) >= targetMs) {
      continue;
    }
    if (delta < bestDelta) {
      best = frame;
      bestDelta = delta;
    }
  }
  if (!best) {
    return null;
  }
  return {
    validHourKey: normalizeIsoHour(best.validHourKey),
    hour: best.hour,
    exact: false,
    deltaMinutes: Math.round(bestDelta / 60_000),
  };
}

export function buildValidTimeAxis(
  manifests: Array<ModelManifest | null | undefined>,
  mode: "intersection-first" | "primary" | "union" = "intersection-first",
): ValidTimeIso[] {
  const lists = manifests
    .map((manifest) => (manifest?.frames || []).map((frame) => normalizeIsoHour(frame.validHourKey)).filter(Boolean))
    .filter((values) => values.length > 0)
    .map((values) => Array.from(new Set(values)).sort((left, right) => toEpochMs(left) - toEpochMs(right)));

  if (lists.length === 0) {
    return [];
  }
  if (mode === "primary") {
    return lists[0];
  }
  if (mode === "union") {
    const set = new Set<string>();
    for (const values of lists) {
      for (const value of values) {
        set.add(value);
      }
    }
    return Array.from(set).sort((left, right) => toEpochMs(left) - toEpochMs(right));
  }
  if (lists.length === 1) {
    return lists[0];
  }
  const intersection = lists.slice(1).reduce((current, next) => {
    const nextSet = new Set(next);
    return current.filter((value) => nextSet.has(value));
  }, lists[0]);
  return intersection.length > 0 ? intersection : lists[0];
}

export function normalizeManifest(raw: ModelManifest, modelKey: ModelKey, viewKey: ViewKey): ModelManifest {
  if (!raw || raw.model !== modelKey || raw.view !== viewKey) {
    throw new Error(`Manifest mismatch for ${modelKey}/${viewKey}.`);
  }
  const frames = Array.isArray(raw.frames) ? raw.frames : [];
  const normalizedFrames: FrameRecord[] = frames
    .map((frame) => {
      const normalizedVectorKeys = normalizeSynopticVectorKeys(frame.synopticVectorKeys, frame.synopticVectorKey);
      const normalizedVectorBytes = normalizeSynopticVectorBytes(frame.synopticVectorBytes);
      const normalizedStyleVersions = normalizeSynopticStyleVersions(
        frame.synopticStyleVersions,
        frame.synopticStyleVersion,
      );
      const legacyVectorKey =
        String(
          frame.synopticVectorKey || normalizedVectorKeys?.simple || normalizedVectorKeys?.detailed || "",
        ).trim() || null;
      const legacyStyleVersion =
        String(
          frame.synopticStyleVersion || normalizedStyleVersions?.simple || normalizedStyleVersions?.detailed || "",
        ).trim() || null;
      return {
        ...frame,
        referenceTime: frame.referenceTime || raw.referenceTime || null,
        synopticCenters: frame.synopticCenters || { highs: [], lows: [] },
        synopticVectorKey: legacyVectorKey,
        synopticVectorKeys: normalizedVectorKeys,
        synopticVectorBytes: normalizedVectorBytes,
        synopticVector: frame.synopticVector || null,
        contourVectorRefs: normalizeContourVectorRefs(frame.contourVectorRefs),
        weatherVectorRefs: normalizeWeatherVectorRefs(frame.weatherVectorRefs),
        synopticStyleVersion: legacyStyleVersion,
        synopticStyleVersions: normalizedStyleVersions,
        pressureUploadMeta: normalizePressureUploadMeta(frame.pressureUploadMeta, frame.rows, frame.cols),
        hoverGridKey: frame.hoverGridKey || null,
        hoverGridBytes: Number(frame.hoverGridBytes) || null,
        hoverGridSchemaVersion: Number(frame.hoverGridSchemaVersion) || null,
        hoverGridSupplemental: normalizeHoverGridSupplemental(frame.hoverGridSupplemental),
        reflectivityVariants: frame.reflectivityVariants || null,
        reflectivityVariantsByLayer: frame.reflectivityVariantsByLayer || null,
        layers: frame.layers || {},
      };
    })
    .sort((left, right) => left.hour - right.hour);

  const normalizedParameters = normalizeParameterMetadata(raw.parameters);
  return {
    ...raw,
    schemaVersion: Number(raw.schemaVersion) || 1,
    referenceTime: raw.referenceTime || null,
    openDataModel: raw.openDataModel || null,
    hourStatus: raw.hourStatus || buildDefaultHourStatus(normalizedFrames),
    parameters: normalizedParameters,
    parameterOrder: normalizeParameterOrder(raw.parameterOrder, normalizedParameters),
    frames: normalizedFrames,
  };
}

function normalizeParameterMetadata(parameters: ModelManifest["parameters"]): ModelManifest["parameters"] | undefined {
  if (!parameters || typeof parameters !== "object") {
    return undefined;
  }
  const out: NonNullable<ModelManifest["parameters"]> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (DISABLED_PARAMETER_KEYS.has(key)) {
      continue;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    const legendTicks = Array.isArray(value.legendTicks)
      ? value.legendTicks.map((tick) => Number(tick)).filter(Number.isFinite)
      : [];
    const legendTickPositions = Array.isArray(value.legendTickPositions)
      ? value.legendTickPositions
          .map((position) => Number(position))
          .filter((position) => Number.isFinite(position))
          .map((position) => Math.max(0, Math.min(1, position)))
      : [];
    const legendStops = Array.isArray(value.legendStops)
      ? value.legendStops
          .map((stop) => normalizeLegendStop(stop))
          .filter((stop): stop is [number, [number, number, number] | [number, number, number, number]] =>
            Boolean(stop),
          )
      : [];
    out[key] = {
      key: String(value.key || key),
      label: String(value.label || key),
      unit: value.unit ? String(value.unit) : null,
      group: value.group ? String(value.group) : null,
      thresholdNote: value.thresholdNote ? String(value.thresholdNote) : null,
      sourceNote: value.sourceNote ? String(value.sourceNote) : null,
      legendTicks,
      legendTickPositions,
      legendStops,
      legendDisplayScale: normalizeLegendDisplayScale(value.legendDisplayScale),
      legendType: value.legendType ? String(value.legendType) : null,
      precipTypeLegend: normalizePrecipTypeLegend(value.precipTypeLegend),
      precipRateTypeLegend: normalizePrecipTypeLegend(value.precipRateTypeLegend),
      contourIntervalDam: normalizeOptionalNumber(value.contourIntervalDam),
      contourLevelMb: normalizeOptionalNumber(value.contourLevelMb),
      accumulationWindowHours: normalizeOptionalNumber(value.accumulationWindowHours),
      accumulationMode: value.accumulationMode ? String(value.accumulationMode) : null,
      minForecastHour: normalizeOptionalNumber(value.minForecastHour),
      methodVersion: value.methodVersion ? String(value.methodVersion) : null,
      derivation: value.derivation ? String(value.derivation) : null,
      applicability: value.applicability ? String(value.applicability) : null,
      formulaReference: value.formulaReference ? String(value.formulaReference) : null,
      artifactRequired: value.artifactRequired ? String(value.artifactRequired) : null,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeLegendDisplayScale(candidate: unknown) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const source = candidate as { kind?: unknown; exponent?: unknown };
  const kind = String(source.kind || "").trim();
  if (!kind) {
    return null;
  }
  const exponent = Number(source.exponent);
  return {
    kind,
    exponent: Number.isFinite(exponent) ? exponent : null,
  };
}

function normalizePrecipTypeLegend(rows: unknown) {
  if (!Array.isArray(rows)) {
    return undefined;
  }
  const normalized = rows
    .map((row) => {
      if (!row || typeof row !== "object") {
        return null;
      }
      const source = row as {
        key?: unknown;
        label?: unknown;
        filterDbz?: unknown;
        tickLabels?: unknown;
        bins?: unknown;
      };
      const bins = Array.isArray(source.bins)
        ? source.bins
            .map((bin) => {
              if (!bin || typeof bin !== "object") {
                return null;
              }
              const binSource = bin as {
                label?: unknown;
                startDbz?: unknown;
                minDbz?: unknown;
                maxDbz?: unknown;
                minRate?: unknown;
                maxRate?: unknown;
                color?: unknown;
              };
              const color = normalizeLegendColor(binSource.color);
              if (!color) {
                return null;
              }
              return {
                label: String(binSource.label || ""),
                startDbz: normalizeOptionalNumber(binSource.startDbz),
                minDbz: normalizeOptionalNumber(binSource.minDbz),
                maxDbz: normalizeOptionalNumber(binSource.maxDbz),
                minRate: normalizeOptionalNumber(binSource.minRate),
                maxRate: normalizeOptionalNumber(binSource.maxRate),
                color,
              };
            })
            .filter((bin): bin is NonNullable<typeof bin> => Boolean(bin))
        : [];
      if (bins.length === 0) {
        return null;
      }
      return {
        key: String(source.key || ""),
        label: String(source.label || source.key || ""),
        filterDbz: normalizeOptionalNumber(source.filterDbz),
        tickLabels: Array.isArray(source.tickLabels)
          ? source.tickLabels.map((tick) => Number(tick)).filter(Number.isFinite)
          : [],
        bins,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeParameterOrder(
  parameterOrder: ModelManifest["parameterOrder"],
  parameters: ModelManifest["parameters"],
): string[] | undefined {
  const metadataKeys = new Set(Object.keys(parameters || {}));
  const out: string[] = [];
  const source = Array.isArray(parameterOrder) ? parameterOrder : Array.from(metadataKeys);
  for (const key of source) {
    const value = String(key || "").trim();
    if (
      value &&
      !DISABLED_PARAMETER_KEYS.has(value) &&
      (metadataKeys.size === 0 || metadataKeys.has(value)) &&
      !out.includes(value)
    ) {
      out.push(value);
    }
  }
  return out.length > 0 ? out : undefined;
}

function normalizeLegendStop(
  stop: unknown,
): [number, [number, number, number] | [number, number, number, number]] | null {
  if (!Array.isArray(stop) || stop.length !== 2 || !Array.isArray(stop[1]) || stop[1].length < 3) {
    return null;
  }
  const position = Number(stop[0]);
  const color = stop[1].map((value) => Number(value));
  if (!Number.isFinite(position) || color.slice(0, 3).some((component) => !Number.isFinite(component))) {
    return null;
  }
  const alpha = Number.isFinite(color[3]) ? Math.max(0, Math.min(1, color[3])) : null;
  const rgb: [number, number, number] = [
    Math.max(0, Math.min(255, Math.round(color[0]))),
    Math.max(0, Math.min(255, Math.round(color[1]))),
    Math.max(0, Math.min(255, Math.round(color[2]))),
  ];
  return [Math.max(0, Math.min(1, position)), alpha === null ? rgb : [...rgb, alpha]];
}

function normalizeLegendColor(color: unknown): [number, number, number, number] | null {
  if (!Array.isArray(color) || color.length < 4) {
    return null;
  }
  const values = color.map((value) => Number(value));
  if (values.slice(0, 4).some((value) => !Number.isFinite(value))) {
    return null;
  }
  return [
    Math.max(0, Math.min(255, Math.round(values[0]))),
    Math.max(0, Math.min(255, Math.round(values[1]))),
    Math.max(0, Math.min(255, Math.round(values[2]))),
    Math.max(0, Math.min(1, values[3])),
  ];
}

function normalizeOptionalNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatRunLabel(manifest: ModelManifest | null | undefined): string {
  if (!manifest) {
    return "--";
  }
  const source = manifest.referenceTime || manifest.run;
  const parsed = parseRunTimestamp(source);
  if (!parsed) {
    return manifest.run || "--";
  }
  const yyyy = parsed.getUTCFullYear();
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  const hh = String(parsed.getUTCHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}z`;
}

function normalizeSynopticVectorKeys(
  vectorKeys: FrameRecord["synopticVectorKeys"],
  legacyKey: FrameRecord["synopticVectorKey"],
): FrameRecord["synopticVectorKeys"] {
  const simpleValue = String(vectorKeys?.simple || "").trim();
  const detailedValue = String(vectorKeys?.detailed || "").trim();
  const legacyValue = String(legacyKey || "").trim();
  const resolvedSimple = simpleValue || legacyValue || detailedValue || "";
  const resolvedDetailed = detailedValue || simpleValue || legacyValue || "";
  if (!resolvedSimple && !resolvedDetailed) {
    return null;
  }
  return {
    simple: resolvedSimple || null,
    detailed: resolvedDetailed || null,
  };
}

function normalizeSynopticVectorBytes(
  vectorBytes: FrameRecord["synopticVectorBytes"],
): FrameRecord["synopticVectorBytes"] {
  if (!vectorBytes || typeof vectorBytes !== "object") {
    return null;
  }
  const simple = Number(vectorBytes.simple);
  const detailed = Number(vectorBytes.detailed);
  return {
    simple: Number.isFinite(simple) && simple > 0 ? simple : null,
    detailed: Number.isFinite(detailed) && detailed > 0 ? detailed : null,
  };
}

function normalizeHoverGridSupplemental(
  supplemental: FrameRecord["hoverGridSupplemental"],
): FrameRecord["hoverGridSupplemental"] {
  if (!supplemental || typeof supplemental !== "object") {
    return null;
  }
  const normalized: NonNullable<FrameRecord["hoverGridSupplemental"]> = {};
  for (const [name, ref] of Object.entries(supplemental)) {
    const key = String(ref?.key || "").trim();
    if (!key) {
      continue;
    }
    normalized[name] = {
      key,
      bytes: Number(ref?.bytes) || null,
      schemaVersion: Number(ref?.schemaVersion) || null,
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeContourVectorRefs(refs: FrameRecord["contourVectorRefs"]): FrameRecord["contourVectorRefs"] {
  if (!refs || typeof refs !== "object") {
    return null;
  }
  const normalized: NonNullable<FrameRecord["contourVectorRefs"]> = {};
  for (const [layerKey, ref] of Object.entries(refs)) {
    const key = String(ref?.key || "").trim();
    if (!key) {
      continue;
    }
    normalized[layerKey] = {
      key,
      bytes: Math.max(0, Number(ref?.bytes) || 0),
      contentType: ref?.contentType || "application/json",
      url: ref?.url || null,
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeWeatherVectorRefs(refs: FrameRecord["weatherVectorRefs"]): FrameRecord["weatherVectorRefs"] {
  const normalized = normalizeContourVectorRefs(refs);
  if (!normalized) {
    return null;
  }
  for (const key of DISABLED_PARAMETER_KEYS) {
    delete normalized[key];
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeSynopticStyleVersions(
  styleVersions: FrameRecord["synopticStyleVersions"],
  legacyVersion: FrameRecord["synopticStyleVersion"],
): FrameRecord["synopticStyleVersions"] {
  const simpleValue = String(styleVersions?.simple || "").trim();
  const detailedValue = String(styleVersions?.detailed || "").trim();
  const legacyValue = String(legacyVersion || "").trim();
  const resolvedSimple = simpleValue || legacyValue || detailedValue || "";
  const resolvedDetailed = detailedValue || simpleValue || legacyValue || "";
  if (!resolvedSimple && !resolvedDetailed) {
    return null;
  }
  return {
    simple: resolvedSimple || null,
    detailed: resolvedDetailed || null,
  };
}

function normalizePressureUploadMeta(
  meta: FrameRecord["pressureUploadMeta"],
  fallbackRows: unknown,
  fallbackCols: unknown,
): FrameRecord["pressureUploadMeta"] {
  if (!meta || typeof meta !== "object") {
    return null;
  }
  const sourceValue = String(meta.source || "").trim();
  const source =
    sourceValue === "om-grid" ||
    sourceValue === "open-data-fallback" ||
    sourceValue === "forecast-fallback" ||
    sourceValue === "none"
      ? sourceValue
      : "none";
  const inputRows = Number(meta.inputRows);
  const inputCols = Number(meta.inputCols);
  const hoverRows = Number(meta.hoverRows);
  const hoverCols = Number(meta.hoverCols);
  const defaultRows = Math.max(1, Math.round(Number(fallbackRows) || 1));
  const defaultCols = Math.max(1, Math.round(Number(fallbackCols) || 1));
  return {
    source,
    inputRows: Number.isFinite(inputRows) && inputRows > 0 ? Math.round(inputRows) : null,
    inputCols: Number.isFinite(inputCols) && inputCols > 0 ? Math.round(inputCols) : null,
    hoverRows: Number.isFinite(hoverRows) && hoverRows > 0 ? Math.round(hoverRows) : defaultRows,
    hoverCols: Number.isFinite(hoverCols) && hoverCols > 0 ? Math.round(hoverCols) : defaultCols,
    fullResolutionInput: source === "om-grid",
  };
}

function buildDefaultHourStatus(frames: FrameRecord[]): Record<string, "loaded"> {
  const out: Record<string, "loaded"> = {};
  for (const frame of frames) {
    out[String(frame.hour)] = "loaded";
  }
  return out;
}

function parseRunTimestamp(value: string | null | undefined): Date | null {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const isoLike = raw.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(isoLike)) {
    const date = new Date(isoLike.replace("Z", ":00Z"));
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(isoLike)) {
    const date = new Date(isoLike);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(isoLike)) {
    const date = new Date(`${isoLike}:00:00Z`);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const runMatch = raw.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})\d{2}Z$/);
  if (!runMatch) {
    const fallback = new Date(isoLike);
    return Number.isFinite(fallback.getTime()) ? fallback : null;
  }
  const iso = `${runMatch[1]}-${runMatch[2]}-${runMatch[3]}T${runMatch[4]}:00:00Z`;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
