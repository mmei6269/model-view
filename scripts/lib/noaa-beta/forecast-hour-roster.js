"use strict";

const crypto = require("crypto");

const { normalizeNoaaCycleHour } = require("./model-config");

const FORECAST_HOUR_ROSTER_SCHEMA_VERSION = 1;

const BOUNDED_ROSTER_IDENTITY_CACHE = new WeakMap();

// The WeakMap above is keyed on per-frame context objects, so it only
// dedupes repeated calls within one frame. Bounded identities are
// run-constant per (modelKey, tier, targetHour, availableHours), so a
// process-level string-keyed memo avoids re-normalizing and re-hashing the
// same roster on every frame of a build.
const BOUNDED_ROSTER_IDENTITY_STRING_CACHE = new Map();

const BOUNDED_ROSTER_IDENTITY_STRING_CACHE_MAX_ENTRIES = 1024;

function normalizeForecastHours(hours) {
  return Array.from(
    new Set(
      (Array.isArray(hours) ? hours : [])
        .map((hour) => Math.round(Number(hour)))
        .filter((hour) => Number.isFinite(hour) && hour >= 0),
    ),
  ).sort((left, right) => left - right);
}

function buildForecastHourRosterIdentity({ modelKey, hours, tier = "configured", cycle = null } = {}) {
  const normalizedModelKey = String(modelKey || "")
    .trim()
    .toLowerCase();
  const normalizedTier = String(tier || "configured").trim() || "configured";
  const normalizedHours = normalizeForecastHours(hours);
  const canonical = {
    schemaVersion: FORECAST_HOUR_ROSTER_SCHEMA_VERSION,
    modelKey: normalizedModelKey,
    tier: normalizedTier,
    hours: normalizedHours,
  };
  const canonicalTierHours = canonicalForecastHoursForTier(normalizedModelKey, normalizedTier, cycle);
  const canonicalPrefix = isExactForecastHourPrefix(normalizedHours, canonicalTierHours);
  const regularStepHours = regularForecastHourStep(normalizedHours);
  const exactIdentity = exactForecastHourRosterIdentity(canonical);
  return {
    ...canonical,
    id: exactIdentity,
    completionIdentity: canonicalPrefix
      ? `forecast-sampling-v${FORECAST_HOUR_ROSTER_SCHEMA_VERSION}:${normalizedModelKey}:${normalizedTier}`
      : regularStepHours !== null
        ? `forecast-sampling-v${FORECAST_HOUR_ROSTER_SCHEMA_VERSION}:${normalizedModelKey}:${normalizedTier}:regular-${regularStepHours}h`
        : exactIdentity,
    canonicalPrefix,
    regularStepHours,
    frameCount: normalizedHours.length,
    firstHour: normalizedHours[0] ?? null,
    lastHour: normalizedHours.at(-1) ?? null,
  };
}

function exactForecastHourRosterIdentity({ modelKey, tier, hours }) {
  const normalizedModelKey = String(modelKey || "")
    .trim()
    .toLowerCase();
  const normalizedTier = String(tier || "configured").trim() || "configured";
  const digest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: FORECAST_HOUR_ROSTER_SCHEMA_VERSION,
        modelKey: normalizedModelKey,
        tier: normalizedTier,
        hours: normalizeForecastHours(hours),
      }),
    )
    .digest("hex");
  return `forecast-hours-v${FORECAST_HOUR_ROSTER_SCHEMA_VERSION}-sha256:${digest}`;
}

function regularForecastHourStep(hours) {
  if (!Array.isArray(hours) || hours.length < 2 || hours[0] !== 0) {
    return null;
  }
  const step = hours[1] - hours[0];
  return Number.isFinite(step) &&
    step > 0 &&
    hours.every((hour, index) => index === 0 || hour - hours[index - 1] === step)
    ? step
    : null;
}

function resolveForecastHourSamplingTier(modelKey, hours, { gfsHourlyThrough120 = false } = {}) {
  const normalizedModelKey = String(modelKey || "")
    .trim()
    .toLowerCase();
  const normalizedHours = normalizeForecastHours(hours);
  if (normalizedModelKey === "gfs") {
    const hasSubThreeHourSampling = normalizedHours.some((hour) => hour <= 120 && hour % 3 !== 0);
    return gfsHourlyThrough120 || hasSubThreeHourSampling ? "hourly-through-f120" : "three-hourly";
  }
  return "operational-cadence";
}

function canonicalForecastHoursForTier(modelKey, tier, cycle = null) {
  if (modelKey === "gfs") {
    if (tier === "hourly-through-f120") {
      return [...rangeHours(0, 120, 1), ...rangeHours(123, 384, 3)];
    }
    if (tier === "three-hourly") {
      return rangeHours(0, 384, 3);
    }
  }
  if (modelKey === "nam") {
    return [...rangeHours(0, 36, 1), ...rangeHours(39, 84, 3)];
  }
  if (modelKey === "nam3km") {
    return rangeHours(0, 60, 1);
  }
  if (modelKey === "hrrr") {
    // Mirror model-config: an unknown cycle assumes the full cadence rather
    // than masquerading as 00Z (Number(null) is 0) or as an off-cycle
    // (Number("latest") is NaN).
    const cycleHour = normalizeNoaaCycleHour(cycle);
    const extended = cycleHour === null || new Set([0, 6, 12, 18]).has(cycleHour);
    return rangeHours(0, extended ? 48 : 18, 1);
  }
  return null;
}

function rangeHours(start, end, step) {
  const out = [];
  for (let hour = start; hour <= end; hour += step) {
    out.push(hour);
  }
  return out;
}

function isExactForecastHourPrefix(hours, canonicalHours) {
  return (
    Array.isArray(canonicalHours) &&
    hours.length > 0 &&
    hours.length <= canonicalHours.length &&
    hours.every((hour, index) => hour === canonicalHours[index])
  );
}

function resolveForecastHourRosterIdentity(latestMetadata, { modelKey = null } = {}) {
  const declared = latestMetadata?.forecastHourRoster;
  const declaredId = String(declared?.id || "").trim();
  if (declaredId) {
    return declaredId;
  }
  const hours = latestMetadata?.rawLatest?.hours || latestMetadata?.noaa?.hours || latestMetadata?.hours;
  if (!Array.isArray(hours)) {
    return null;
  }
  const resolvedModelKey = modelKey || latestMetadata?.modelKey || latestMetadata?.noaa?.model;
  return buildForecastHourRosterIdentity({
    modelKey: resolvedModelKey,
    hours,
    tier: resolveForecastHourSamplingTier(resolvedModelKey, hours, {
      gfsHourlyThrough120: /hourly/.test(String(latestMetadata?.forecastHourPolicy?.cadence || "")),
    }),
    cycle: latestMetadata?.noaa?.cycle || latestMetadata?.rawLatest?.cycle,
  }).id;
}

function resolveForecastHourCompletionIdentity(latestMetadata, { modelKey = null } = {}) {
  const declared = String(latestMetadata?.forecastHourRoster?.completionIdentity || "").trim();
  if (declared) {
    return declared;
  }
  const hours = latestMetadata?.rawLatest?.hours || latestMetadata?.noaa?.hours || latestMetadata?.hours;
  if (!Array.isArray(hours)) {
    return null;
  }
  const resolvedModelKey = modelKey || latestMetadata?.modelKey || latestMetadata?.noaa?.model;
  const tier =
    latestMetadata?.forecastHourRoster?.tier ||
    resolveForecastHourSamplingTier(resolvedModelKey, hours, {
      gfsHourlyThrough120: /hourly/.test(String(latestMetadata?.forecastHourPolicy?.cadence || "")),
    });
  return buildForecastHourRosterIdentity({
    modelKey: resolvedModelKey,
    hours,
    tier,
    cycle: latestMetadata?.noaa?.cycle || latestMetadata?.rawLatest?.cycle,
  }).completionIdentity;
}

function resolveForecastHourSamplingTierFromMetadata(latestMetadata, { modelKey = null } = {}) {
  const declared = String(latestMetadata?.forecastHourRoster?.tier || "").trim();
  if (declared) {
    return declared;
  }
  const hours = latestMetadata?.rawLatest?.hours || latestMetadata?.noaa?.hours || latestMetadata?.hours || [];
  return resolveForecastHourSamplingTier(modelKey || latestMetadata?.modelKey || latestMetadata?.noaa?.model, hours, {
    gfsHourlyThrough120: /hourly/.test(String(latestMetadata?.forecastHourPolicy?.cadence || "")),
  });
}

function buildBoundedForecastHourRosterIdentity(context, targetHour) {
  // Cache identity is deliberately stricter than canonical-prefix completion
  // identity: only source hours that can affect this target are hashed. Future
  // prefix extension stays reusable, but hourly/3-hourly tiers and holes do not.
  const target = Math.round(Number(targetHour));
  const cacheKey = Number.isFinite(target) ? target : "all";
  const cachedByTarget = context && typeof context === "object" ? BOUNDED_ROSTER_IDENTITY_CACHE.get(context) : null;
  if (cachedByTarget?.has(cacheKey)) {
    return cachedByTarget.get(cacheKey);
  }
  const availableHours = Array.isArray(context?.availableHours) ? context.availableHours : [];
  const stringKey = `${String(context?.modelKey || "")}|${String(
    context?.forecastHourSamplingTier || "configured",
  )}|${cacheKey}|${availableHours.join(",")}`;
  let identity = BOUNDED_ROSTER_IDENTITY_STRING_CACHE.get(stringKey);
  if (identity === undefined) {
    const hours = normalizeForecastHours(availableHours).filter((hour) => !Number.isFinite(target) || hour <= target);
    identity = exactForecastHourRosterIdentity({
      modelKey: context?.modelKey,
      hours,
      tier: context?.forecastHourSamplingTier || "configured",
    });
    if (BOUNDED_ROSTER_IDENTITY_STRING_CACHE.size >= BOUNDED_ROSTER_IDENTITY_STRING_CACHE_MAX_ENTRIES) {
      BOUNDED_ROSTER_IDENTITY_STRING_CACHE.delete(BOUNDED_ROSTER_IDENTITY_STRING_CACHE.keys().next().value);
    }
    BOUNDED_ROSTER_IDENTITY_STRING_CACHE.set(stringKey, identity);
  }
  if (context && typeof context === "object") {
    const targetMap = cachedByTarget || new Map();
    targetMap.set(cacheKey, identity);
    if (!cachedByTarget) {
      BOUNDED_ROSTER_IDENTITY_CACHE.set(context, targetMap);
    }
  }
  return identity;
}

module.exports = {
  FORECAST_HOUR_ROSTER_SCHEMA_VERSION,
  buildBoundedForecastHourRosterIdentity,
  buildForecastHourRosterIdentity,
  canonicalForecastHoursForTier,
  isExactForecastHourPrefix,
  normalizeForecastHours,
  regularForecastHourStep,
  resolveForecastHourCompletionIdentity,
  resolveForecastHourRosterIdentity,
  resolveForecastHourSamplingTier,
  resolveForecastHourSamplingTierFromMetadata,
};
