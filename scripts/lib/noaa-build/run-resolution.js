"use strict";

const { parseBooleanOption } = require("./frame-queue");
const { formatRunIdFromReference } = require("../modelview-runtime");
const { getNoaaGribRendererSignature } = require("../noaa-beta-renderer");

const { MODEL_CONFIG, VIEW_CONFIG } = require("../modelview-runtime");
const {
  NOAA_NAM_PARAMETER_CATALOG,
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
} = require("../noaa-nam-parameter-catalog");
const { clampInt } = require("../noaa-beta/util");
const { parseNoaaIdx } = require("../noaa-beta/grib-source");
const {
  NOAA_BETA_MODEL_CONFIG,
  NOAA_BETA_MODEL_KEYS,
  NOAA_BETA_SOURCE_NAME,
  buildNoaaGribUrl,
  getNoaaGribModelConfig,
} = require("../noaa-beta/model-config");
const { selectNoaaNamParameterRecords } = require("../noaa-beta/selection");

const DEFAULT_HOURS = [0, 3, 6];

function isFullRunRequest(args) {
  const globalRaw = args.hours || process.env.MODELVIEW_NOAA_BETA_HOURS || "";
  return (
    parseBooleanOption(args.full || args["full-run"] || process.env.MODELVIEW_NOAA_FULL_RUN, false) ||
    String(globalRaw).trim().toLowerCase() === "full"
  );
}

function resolveHoursByModel({ args, models, fullRun = isFullRunRequest(args) }) {
  const globalRaw = args.hours || process.env.MODELVIEW_NOAA_BETA_HOURS || "";
  const commonHours = !fullRun && globalRaw ? parseHours(globalRaw) : null;
  const out = {};
  for (const modelKey of models) {
    const envKey = `MODELVIEW_NOAA_${modelKey.toUpperCase()}_HOURS`;
    const modelRaw = args[`hours-${modelKey}`] || process.env[envKey] || "";
    const hours = modelRaw
      ? parseHours(modelRaw)
      : fullRun
        ? buildFullHoursForModel(modelKey)
        : commonHours || parseHours(DEFAULT_HOURS.join(","));
    validateHoursForModel(hours, modelKey);
    out[modelKey] = hours;
  }
  return out;
}

function buildFullHoursForModel(modelKey) {
  const config = MODEL_CONFIG[modelKey] || {};
  const maxHour = Number(config.maxHour);
  const step = Math.max(1, Math.round(Number(config.frameStepHours) || 1));
  if (!Number.isFinite(maxHour) || maxHour < 0) {
    throw new Error(`Cannot build full forecast hour list for '${modelKey}'.`);
  }
  const hours = [];
  for (let hour = 0; hour <= maxHour; hour += step) {
    hours.push(hour);
  }
  return hours;
}

function formatHoursByModel(hoursByModel, models) {
  const values = models.map((modelKey) => `${modelKey}:${(hoursByModel[modelKey] || []).join(",")}`);
  return values.join(" ");
}

async function resolveAvailableNoaaHours({ modelKey, noaaBaseUrl, run, hours }) {
  const requestedHours = Array.isArray(hours) ? hours : [];
  const checks = await mapWithConcurrency(
    requestedHours,
    Math.min(16, Math.max(1, requestedHours.length)),
    async (hour) => ({
      hour,
      available: await noaaForecastHourExists({ modelKey, noaaBaseUrl, run, hour }),
    }),
  );
  const availableHours = [];
  for (const check of checks) {
    if (!check.available) {
      break;
    }
    availableHours.push(check.hour);
  }
  if (availableHours.length === 0) {
    throw new Error(`No available NOAA ${modelKey} forecast hours for ${run.date} ${run.cycle}Z.`);
  }
  if (availableHours.length < requestedHours.length) {
    const lastHour = availableHours[availableHours.length - 1];
    const nextHour = requestedHours[availableHours.length];
    console.log(
      `[noaa-beta] ${modelKey} ${run.date} ${run.cycle}Z capped at F${padHour(lastHour)}; F${padHour(nextHour)} is not published yet`,
    );
  }
  return availableHours;
}

async function noaaForecastHourExists({ modelKey, noaaBaseUrl, run, hour }) {
  const url = `${buildNoaaGribUrl({
    modelKey,
    baseUrl: noaaBaseUrl,
    date: run.date,
    cycle: run.cycle,
    hour,
  })}.idx`;
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  if (list.length === 0) {
    return out;
  }
  const workerCount = clampInt(concurrency, 1, list.length, 1);
  let index = 0;
  const runners = Array.from({ length: workerCount }, async () => {
    while (index < list.length) {
      const current = index;
      index += 1;
      out[current] = await worker(list[current], current);
    }
  });
  await Promise.all(runners);
  return out;
}

async function resolveNoaaModelRun({
  modelKey = "nam",
  noaaBaseUrl,
  date,
  cycle,
  hours,
  runOffset = 0,
  requireAllHours = false,
}) {
  const resolvedModelKey = normalizeNoaaModelKey(modelKey);
  if (date !== undefined || cycle !== undefined) {
    const normalizedDate = normalizeDate(date);
    const normalizedCycle = normalizeCycle(cycle, resolvedModelKey);
    return { date: normalizedDate, cycle: normalizedCycle };
  }
  const selectedRunOffset = clampInt(runOffset, 0, 24, 0);
  const candidates = buildRecentCycleCandidates(resolvedModelKey);
  const selectedHours = Array.isArray(hours) && hours.length > 0 ? hours : [0];
  const probeHours = requireAllHours
    ? Array.from(new Set([selectedHours[0] || 0, selectedHours[selectedHours.length - 1] || 0]))
    : [selectedHours[0] || 0];
  let availableIndex = 0;
  for (const candidate of candidates) {
    try {
      const responses = await Promise.all(
        probeHours.map((hour) =>
          fetch(
            `${buildNoaaGribUrl({
              modelKey: resolvedModelKey,
              baseUrl: noaaBaseUrl,
              date: candidate.date,
              cycle: candidate.cycle,
              hour,
            })}.idx`,
            { method: "HEAD" },
          ),
        ),
      );
      if (responses.every((response) => response.ok)) {
        if (availableIndex < selectedRunOffset) {
          availableIndex += 1;
          continue;
        }
        return candidate;
      }
    } catch {
      // Keep trying older cycles.
    }
  }
  throw new Error(
    `Unable to find a recent NOAA ${getNoaaGribModelConfig(resolvedModelKey).label} run. Try passing --date=YYYYMMDD --cycle=HH.`,
  );
}

async function resolveNoaaParameterSetForRun({ modelKey = "nam", noaaBaseUrl, run, hours }) {
  const probeHours = selectNoaaParameterProbeHours(hours);
  const indexTexts = await mapWithConcurrency(probeHours, Math.min(4, probeHours.length), async (hour) => {
    const idxUrl = `${buildNoaaGribUrl({
      modelKey,
      baseUrl: noaaBaseUrl,
      date: run.date,
      cycle: run.cycle,
      hour,
    })}.idx`;
    const response = await fetch(idxUrl);
    if (!response.ok) {
      throw new Error(`NOAA parameter probe failed (${response.status}) for ${idxUrl}`);
    }
    return response.text();
  });
  return resolveNoaaParameterSetFromIdxTexts(indexTexts, { modelKey });
}

function resolveNoaaParameterSetFromIdxTexts(indexTexts, options = {}) {
  const selections = (Array.isArray(indexTexts) ? indexTexts : [])
    .map((indexText) => selectNoaaNamParameterRecords(parseNoaaIdx(indexText, null), { modelKey: options.modelKey }))
    .filter(Boolean);
  const availableParameters = new Set();
  for (const selection of selections) {
    for (const key of selection.availableParameters || []) {
      availableParameters.add(key);
    }
  }
  const requiredParameters = new Set(
    NOAA_NAM_PARAMETER_CATALOG.filter((entry) => entry.required).map((entry) => entry.key),
  );
  const parameters = getNoaaNamParameterMetadata();
  const parameterOrder = getNoaaNamParameterOrder();
  const removeParameter = (key) => {
    delete parameters[key];
  };
  const unavailable = parameterOrder.filter((key) => !availableParameters.has(key) && !requiredParameters.has(key));
  unavailable.forEach(removeParameter);
  return {
    parameters,
    parameterOrder: parameterOrder.filter((key) => !unavailable.includes(key)),
  };
}

function selectNoaaParameterProbeHours(hours) {
  const orderedHours = Array.from(
    new Set(
      (Array.isArray(hours) ? hours : [])
        .map((hour) => Math.round(Number(hour)))
        .filter((hour) => Number.isFinite(hour) && hour >= 0),
    ),
  ).sort((left, right) => left - right);
  if (orderedHours.length === 0) {
    return [0];
  }
  const maxHour = orderedHours[orderedHours.length - 1];
  const selected = new Set([orderedHours[0], maxHour]);
  for (const anchor of [0, 1, 3, 6, 12, 24, 36, 48]) {
    const atOrAfter = orderedHours.find((hour) => hour >= anchor);
    if (Number.isFinite(atOrAfter)) {
      selected.add(atOrAfter);
    }
  }
  return Array.from(selected).sort((left, right) => left - right);
}

function buildNoaaModelMetadata({
  modelKey = "nam",
  run,
  hours,
  noaaBaseUrl,
  parameters = null,
  parameterOrder = null,
}) {
  const resolvedModelKey = normalizeNoaaModelKey(modelKey);
  const modelConfig = getNoaaGribModelConfig(resolvedModelKey);
  const baseUrl = String(noaaBaseUrl || modelConfig.baseUrl)
    .trim()
    .replace(/\/+$/, "");
  const referenceTime = referenceTimeFromRun(run);
  const runId = formatRunIdFromReference(referenceTime);
  const validTimes = hours.map((hour) => addHours(referenceTime, hour));
  return {
    modelKey: resolvedModelKey,
    openDataModel: modelConfig.openDataModel,
    latestUrl: `${buildNoaaGribUrl({
      modelKey: resolvedModelKey,
      baseUrl,
      date: run.date,
      cycle: run.cycle,
      hour: 0,
    })}.idx`,
    referenceTime,
    runId,
    runPath: `${resolvedModelKey}.${run.date}/${modelConfig.productKey}.t${run.cycle}z`,
    validTimes,
    crsWkt: null,
    sourceBounds: VIEW_CONFIG.conus.bounds,
    rawLatest: {
      source: NOAA_BETA_SOURCE_NAME,
      model: resolvedModelKey,
      date: run.date,
      cycle: run.cycle,
      hours,
    },
    noaa: {
      model: resolvedModelKey,
      baseUrl,
      date: run.date,
      cycle: run.cycle,
      product: modelConfig.productKey,
    },
    rendererSignature: getNoaaGribRendererSignature(),
    hoverGridFormat: "binary",
    parameters: parameters || getNoaaNamParameterMetadata(),
    parameterOrder: parameterOrder || getNoaaNamParameterOrder(),
    parameterKeys: parameterOrder || getNoaaNamParameterOrder(),
  };
}

function buildNoaaNamMetadata({ modelKey = "nam", run, hours, noaaBaseUrl }) {
  return buildNoaaModelMetadata({ modelKey, run, hours, noaaBaseUrl });
}

function buildRecentCycleCandidates(modelKey = "nam") {
  const modelConfig = getNoaaGribModelConfig(modelKey);
  const cycleHours = new Set((modelConfig.cycleHours || [0, 6, 12, 18]).map((hour) => Number(hour)));
  const nowMs = Date.now();
  const candidates = [];
  const seen = new Set();
  for (let hourOffset = 0; hourOffset <= 72; hourOffset += 1) {
    const date = new Date(nowMs - hourOffset * 60 * 60 * 1000);
    const cycleHour = date.getUTCHours();
    if (!cycleHours.has(cycleHour)) {
      continue;
    }
    const ymd = [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    ].join("");
    const cycle = String(cycleHour).padStart(2, "0");
    const key = `${ymd}-${cycle}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ date: ymd, cycle });
    }
  }
  return candidates;
}

function referenceTimeFromRun(run) {
  const date = normalizeDate(run.date);
  const cycle = normalizeCycle(run.cycle);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${cycle}:00:00Z`;
}

function addHours(referenceTime, hour) {
  const date = new Date(Date.parse(referenceTime) + (Number(hour) || 0) * 60 * 60 * 1000);
  return date.toISOString().replace(".000Z", "Z");
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{8}$/.test(text)) {
    throw new Error("Expected NOAA date as YYYYMMDD.");
  }
  return text;
}

function normalizeCycle(value, modelKey = null) {
  const text = String(value || "").padStart(2, "0");
  if (!/^\d{2}$/.test(text) || Number(text) < 0 || Number(text) > 23) {
    throw new Error("Expected NOAA cycle as HH, 00 through 23.");
  }
  if (modelKey) {
    const config = getNoaaGribModelConfig(modelKey);
    const cycleHour = Number(text);
    if (!(config.cycleHours || []).includes(cycleHour)) {
      const supported = (config.cycleHours || []).map((hour) => String(hour).padStart(2, "0")).join(", ");
      throw new Error(`Expected NOAA ${config.label} cycle as one of ${supported}.`);
    }
  }
  return text;
}

function parseHours(raw) {
  const hours = String(raw || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.round(value));
  const unique = Array.from(new Set(hours)).sort((left, right) => left - right);
  if (unique.length === 0) {
    throw new Error("No forecast hours selected. Use --hours=0,3,6.");
  }
  return unique;
}

function validateHoursForModel(hours, modelKey) {
  const maxHour = MODEL_CONFIG[modelKey]?.maxHour;
  if (!Number.isFinite(maxHour)) {
    return;
  }
  const outOfRange = hours.find((hour) => hour > maxHour);
  if (outOfRange !== undefined) {
    throw new Error(`${modelKey} forecast hour ${outOfRange} exceeds max hour ${maxHour}.`);
  }
}

function resolveModels(raw) {
  const requested = String(raw || "nam")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const models = [];
  for (const token of requested) {
    const expanded = token === "all" || token === "noaa" ? NOAA_BETA_MODEL_KEYS : [token];
    for (const modelKey of expanded) {
      const normalized = normalizeNoaaModelKey(modelKey);
      if (!models.includes(normalized)) {
        models.push(normalized);
      }
    }
  }
  if (models.length === 0) {
    throw new Error(`No NOAA beta models selected. Supported: ${NOAA_BETA_MODEL_KEYS.join(", ")}`);
  }
  return models;
}

function normalizeNoaaModelKey(modelKey) {
  const key = String(modelKey || "")
    .trim()
    .toLowerCase();
  if (!NOAA_BETA_MODEL_CONFIG[key]) {
    throw new Error(`Unsupported NOAA beta model '${modelKey}'. Supported: ${NOAA_BETA_MODEL_KEYS.join(", ")}`);
  }
  return key;
}

function resolveNoaaBaseUrls(args, models) {
  const sharedNamBaseUrl = args["noaa-base-url"] || process.env.MODELVIEW_NOAA_BASE_URL || null;
  const out = {};
  for (const modelKey of NOAA_BETA_MODEL_KEYS) {
    const config = getNoaaGribModelConfig(modelKey);
    const envKey = `MODELVIEW_NOAA_${modelKey.toUpperCase()}_BASE_URL`;
    const argKey = `${modelKey}-base-url`;
    const raw =
      args[argKey] ||
      process.env[envKey] ||
      ((modelKey === "nam" || modelKey === "nam3km") && sharedNamBaseUrl ? sharedNamBaseUrl : null) ||
      config.baseUrl;
    out[modelKey] = String(raw || config.baseUrl)
      .trim()
      .replace(/\/+$/, "");
  }
  for (const modelKey of models) {
    if (!out[modelKey]) {
      throw new Error(`No NOAA base URL configured for '${modelKey}'.`);
    }
  }
  return out;
}

function padHour(hour) {
  return String(Math.max(0, Math.round(Number(hour) || 0))).padStart(3, "0");
}

module.exports = {
  DEFAULT_HOURS,
  addHours,
  buildFullHoursForModel,
  buildNoaaModelMetadata,
  buildNoaaNamMetadata,
  buildRecentCycleCandidates,
  formatHoursByModel,
  isFullRunRequest,
  mapWithConcurrency,
  noaaForecastHourExists,
  normalizeCycle,
  normalizeDate,
  normalizeNoaaModelKey,
  padHour,
  parseHours,
  referenceTimeFromRun,
  resolveAvailableNoaaHours,
  resolveHoursByModel,
  resolveModels,
  resolveNoaaBaseUrls,
  resolveNoaaModelRun,
  resolveNoaaParameterSetForRun,
  resolveNoaaParameterSetFromIdxTexts,
  selectNoaaParameterProbeHours,
  validateHoursForModel,
};
