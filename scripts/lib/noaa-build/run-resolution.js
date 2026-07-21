"use strict";

const { parseBooleanOption } = require("./frame-queue");
const { formatRunIdFromReference } = require("../modelview-runtime");
const { getNoaaGribRendererSignature } = require("../noaa-beta-renderer");

const { MODEL_CONFIG, VIEW_CONFIG } = require("../modelview-runtime");
const {
  getNoaaNamParameterMetadata,
  getNoaaNamParameterOrder,
  resolveNoaaNamParameterCatalog,
} = require("../noaa-nam-parameter-catalog");
const { clampInt } = require("../noaa-beta/util");
const { mapWithConcurrency } = require("../noaa-beta/cache-io");
const { parseNoaaIdx } = require("../noaa-beta/grib-source");
const {
  NOAA_BETA_MODEL_CONFIG,
  NOAA_BETA_MODEL_KEYS,
  NOAA_BETA_SOURCE_NAME,
  buildNoaaGribUrl,
  filterNoaaForecastHoursForCycle,
  getNoaaGribModelConfig,
} = require("../noaa-beta/model-config");
const { selectNoaaNamParameterRecords, selectionAllows } = require("../noaa-beta/selection");
const {
  buildForecastHourRosterIdentity,
  isExactForecastHourPrefix,
  resolveForecastHourSamplingTier,
} = require("../noaa-beta/forecast-hour-roster");

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
  const globalRawText = String(globalRaw).trim();
  // Note args.hours takes precedence in globalRaw: '--hours=full' is the
  // full-run spelling that legitimately overrides a lingering
  // MODELVIEW_NOAA_BETA_HOURS through ordinary flag-over-env precedence (the
  // render server spawns builders that way, with env: process.env). The
  // guard therefore only trips when the surviving global roster genuinely
  // contradicts a full-run request — e.g. a CLI '--full' alongside an
  // explicit or env hours list the expansion would silently discard.
  if (fullRun && globalRawText !== "" && globalRawText.toLowerCase() !== "full") {
    throw new Error(
      "--full contradicts an explicit global --hours list (or MODELVIEW_NOAA_BETA_HOURS): the full-run expansion would silently discard it. Subset one model with --hours-<model> (or MODELVIEW_NOAA_<MODEL>_HOURS), or drop --full to render the explicit roster.",
    );
  }
  const commonHours = !fullRun && globalRaw ? parseHours(globalRaw, "--hours (or MODELVIEW_NOAA_BETA_HOURS)") : null;
  const requireFullHorizon = parseBooleanOption(
    args["require-full-horizon"] || process.env.MODELVIEW_NOAA_REQUIRE_FULL_HORIZON,
    false,
  );
  const gfsHourlyThrough120 = parseBooleanOption(
    args["gfs-hourly-through-120"] || process.env.MODELVIEW_NOAA_GFS_HOURLY_THROUGH_120,
    false,
  );
  if (gfsHourlyThrough120 && !models.includes("gfs")) {
    throw new Error("--gfs-hourly-through-120 requires 'gfs' in --models.");
  }
  if (gfsHourlyThrough120 && !fullRun) {
    throw new Error(
      "--gfs-hourly-through-120 requires --full (or --hours=full); explicit custom hours already derive their cadence identity from the selected roster.",
    );
  }
  // Flag-only, deliberately no env fallback: the render server spawns
  // builders with env: process.env, so a lingering exported variable would
  // silently truncate every full/production build with no log trace.
  const maxHour = parseMaxHour(args["max-hour"]);
  const out = {};
  for (const modelKey of models) {
    const envKey = `MODELVIEW_NOAA_${modelKey.toUpperCase()}_HOURS`;
    const modelRaw = args[`hours-${modelKey}`] || process.env[envKey] || "";
    let hours = modelRaw
      ? parseHours(modelRaw, `--hours-${modelKey} (or ${envKey})`)
      : fullRun
        ? buildFullHoursForModel(modelKey, {
            cycle: args.cycle,
            // NAM's default 0-36 h tier is an intentional compute/storage
            // policy. The existing --require-full-horizon opt-in now means
            // the official 0-36 hourly + 39-84 three-hourly schedule instead
            // of accidentally probing nonexistent F037/F038 and stopping.
            officialHorizon: requireFullHorizon,
            // The default GFS tier intentionally remains 3-hourly. This
            // explicit tier follows the published 0.25-degree cadence:
            // hourly F000-F120, then every 3 h F123-F384.
            gfsHourlyThrough120,
          })
        : commonHours || parseHours(DEFAULT_HOURS.join(","));
    if (maxHour !== null) {
      // Prefix cap only: run-cumulative products (rolling APCP, run-max UH/gust,
      // accumulated snow) integrate over every prior rendered hour, so a prefix
      // subset stays byte-identical to the same hours of a full build while an
      // arbitrary hour gap would not.
      hours = hours.filter((hour) => hour <= maxHour);
      if (hours.length === 0) {
        throw new Error(`--max-hour=${maxHour} leaves no forecast hours for '${modelKey}'.`);
      }
    }
    validateHoursForModel(hours, modelKey);
    out[modelKey] = hours;
  }
  return out;
}

function parseMaxHour(raw) {
  if (raw === undefined || raw === null || typeof raw === "boolean" || String(raw).trim() === "") {
    if (raw === true) {
      throw new Error("--max-hour requires a value (e.g. --max-hour=24).");
    }
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--max-hour must be a non-negative integer, got '${raw}'.`);
  }
  return value;
}

function buildFullHoursForModel(modelKey, { cycle = null, officialHorizon = false, gfsHourlyThrough120 = false } = {}) {
  const config = MODEL_CONFIG[modelKey] || {};
  const maxHour = Number(config.maxHour);
  const step = Math.max(1, Math.round(Number(config.frameStepHours) || 1));
  if (!Number.isFinite(maxHour) || maxHour < 0) {
    throw new Error(`Cannot build full forecast hour list for '${modelKey}'.`);
  }
  const hours =
    modelKey === "nam"
      ? officialHorizon
        ? buildForecastHoursFromCadence(getNoaaGribModelConfig(modelKey).forecastHourCadence)
        : Array.from({ length: 37 }, (_, hour) => hour)
      : modelKey === "gfs" && gfsHourlyThrough120
        ? buildForecastHoursFromCadence(getNoaaGribModelConfig(modelKey).forecastHourCadence)
        : Array.from({ length: Math.floor(maxHour / step) + 1 }, (_, index) => index * step);
  return cycle === null || cycle === undefined ? hours : filterNoaaForecastHoursForCycle(modelKey, cycle, hours);
}

function buildForecastHoursFromCadence(cadence) {
  const hours = [];
  let previousMax = -1;
  for (const tier of Array.isArray(cadence) ? cadence : []) {
    const maxHour = Math.round(Number(tier?.maxHour));
    const stepHours = Math.max(1, Math.round(Number(tier?.stepHours) || 1));
    if (!Number.isFinite(maxHour) || maxHour < 0) {
      continue;
    }
    const firstHour = previousMax < 0 ? 0 : previousMax + stepHours;
    for (let hour = firstHour; hour <= maxHour; hour += stepHours) {
      hours.push(hour);
    }
    previousMax = Math.max(previousMax, maxHour);
  }
  return hours;
}

function formatHoursByModel(hoursByModel, models) {
  const values = models.map((modelKey) => `${modelKey}:${(hoursByModel[modelKey] || []).join(",")}`);
  return values.join(" ");
}

// Bounds the in-flight lookahead of the roster-ordered availability probe. A
// mid-publication latest-run build wastes at most LOOKAHEAD - 1 HEAD requests
// past the first unpublished hour; the pre-lookahead implementation probed the
// ENTIRE requested roster 16-wide before keeping the published prefix (~88
// wasted probes on a 40/129-published GFS roster). Results are unchanged: the
// probe consumes verdicts strictly in roster order and stops at the first
// miss, so the returned list is the same contiguous published prefix.
const AVAILABILITY_PROBE_LOOKAHEAD = 4;

// One transient-error guard per boundary: a single failed HEAD (NOMADS hiccup,
// throttled connection, posting race) must not truncate the published prefix.
// The first miss at the boundary is confirmed once after a short delay; a
// persistent miss truncates at exactly the same hour as before, and every
// confirmed hour keeps the probe moving in roster order.
const AVAILABILITY_MISS_CONFIRM_DELAY_MS = 500;

// The public NOAA Open Data endpoints used here are S3-compatible bucket
// roots. Listing the narrow, run/product-specific object prefix returns the
// complete set of forecast-hour `.idx` keys in one request (well below S3's
// 1,000-key page limit, including the 209-hour GFS source roster). This lets
// picker availability derive the exact contiguous prefix without issuing one
// HEAD per hour. Custom mirrors that do not expose ListObjectsV2 return null
// and keep the existing ordered-HEAD fallback.
const NOAA_RUN_LISTING_MAX_KEYS = 1_000;

// Module-internal (deliberately not exported: the contract requires `hours`
// to already be cycle-filtered — resolveAvailableNoaaHours, the only caller,
// passes its requestedHours; re-filtering here would hide which roster the
// membership test actually runs against).
async function resolveAvailableNoaaHoursFromObjectListing({ modelKey, noaaBaseUrl, run, hours }) {
  const requestedHours = Array.isArray(hours) ? hours : [];
  if (requestedHours.length === 0) {
    return [];
  }

  let listingUrl;
  let expectedKeys;
  try {
    listingUrl = new URL(String(noaaBaseUrl || getNoaaGribModelConfig(modelKey).baseUrl));
    const basePath = listingUrl.pathname.replace(/\/+$/, "");
    expectedKeys = requestedHours.map((hour) => {
      const objectUrl = new URL(
        `${buildNoaaGribUrl({ modelKey, baseUrl: noaaBaseUrl, date: run.date, cycle: run.cycle, hour })}.idx`,
      );
      let objectPath = objectUrl.pathname;
      if (basePath && basePath !== "/" && (objectPath === basePath || objectPath.startsWith(`${basePath}/`))) {
        objectPath = objectPath.slice(basePath.length);
      }
      return objectPath.replace(/^\/+/, "");
    });
  } catch {
    return null;
  }

  const prefix = commonStringPrefix(expectedKeys);
  if (!prefix) {
    return null;
  }
  listingUrl.search = "";
  listingUrl.hash = "";
  listingUrl.searchParams.set("list-type", "2");
  listingUrl.searchParams.set("prefix", prefix);
  listingUrl.searchParams.set("max-keys", String(NOAA_RUN_LISTING_MAX_KEYS));
  listingUrl.searchParams.set("encoding-type", "url");

  let response;
  let body;
  try {
    response = await fetch(listingUrl, { method: "GET" });
    if (!response.ok || typeof response.text !== "function") {
      return null;
    }
    body = await response.text();
  } catch {
    return null;
  }

  // A generic mirror can return an HTML index with status 200. Only trust a
  // complete S3 ListObjectsV2 document; a truncated/unknown response falls
  // back to ordered HEADs rather than risking a false gap or lifetime cache.
  if (!/<(?:[\w.-]+:)?ListBucketResult(?:\s|>)/i.test(body) || !/<\/(?:[\w.-]+:)?ListBucketResult\s*>/i.test(body)) {
    return null;
  }
  const truncatedMatch = body.match(/<(?:[\w.-]+:)?IsTruncated>\s*(true|false)\s*<\/(?:[\w.-]+:)?IsTruncated>/i);
  if (!truncatedMatch || truncatedMatch[1].toLowerCase() === "true") {
    return null;
  }

  const listedKeys = new Set();
  const keyPattern = /<(?:[\w.-]+:)?Key>([\s\S]*?)<\/(?:[\w.-]+:)?Key>/gi;
  for (const match of body.matchAll(keyPattern)) {
    try {
      listedKeys.add(decodeURIComponent(decodeXmlText(match[1])));
    } catch {
      return null;
    }
  }

  const availableHours = [];
  for (let index = 0; index < requestedHours.length; index += 1) {
    if (!listedKeys.has(expectedKeys[index])) {
      break;
    }
    availableHours.push(requestedHours[index]);
  }
  return availableHours;
}

function commonStringPrefix(values) {
  const list = Array.isArray(values) ? values : [];
  if (list.length === 0) {
    return "";
  }
  let prefix = String(list[0]);
  for (let index = 1; index < list.length && prefix; index += 1) {
    const value = String(list[index]);
    let length = Math.min(prefix.length, value.length);
    while (length > 0 && prefix.slice(0, length) !== value.slice(0, length)) {
      length -= 1;
    }
    prefix = prefix.slice(0, length);
  }
  return prefix;
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function resolveAvailableNoaaHours({
  modelKey,
  noaaBaseUrl,
  run,
  hours,
  lookahead = AVAILABILITY_PROBE_LOOKAHEAD,
  missConfirmDelayMs = AVAILABILITY_MISS_CONFIRM_DELAY_MS,
  logCappedPrefix = true,
}) {
  const requestedHours = filterNoaaForecastHoursForCycle(modelKey, run?.cycle, hours);
  // Listing first: one narrow ListObjectsV2 GET derives the identical strict
  // published prefix the ordered HEAD probe would (a fully published GFS
  // roster is one request instead of ~209 HEADs). Mirrors without listing
  // support return null and keep the ordered fallback.
  let availableHours = await resolveAvailableNoaaHoursFromObjectListing({
    modelKey,
    noaaBaseUrl,
    run,
    hours: requestedHours,
  });
  if (availableHours !== null && availableHours.length < requestedHours.length) {
    // Trust-but-verify the listing's cap. Keys PRESENT in a listing are
    // reliable (the buckets are append-only), but an omission can be replica
    // lag, so the first "missing" hour gets the same treatment the ordered
    // probe gives its boundary: probe, and re-confirm a miss once after the
    // settle delay (a single transient HEAD failure must not truncate a
    // published run). If the hour answers after all, keep the
    // listing-confirmed prefix and let the ordered probe continue from the
    // boundary instead of re-probing hours the listing already proved.
    const boundaryIndex = availableHours.length;
    const probeBoundary = () =>
      noaaForecastHourExists({ modelKey, noaaBaseUrl, run, hour: requestedHours[boundaryIndex] });
    let boundaryExists = await probeBoundary();
    if (!boundaryExists) {
      if (missConfirmDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, missConfirmDelayMs));
      }
      boundaryExists = await probeBoundary();
    }
    if (boundaryExists) {
      availableHours = availableHours.concat(
        await probeAvailableNoaaHoursInRosterOrder({
          modelKey,
          noaaBaseUrl,
          run,
          requestedHours: requestedHours.slice(boundaryIndex),
          lookahead,
          missConfirmDelayMs,
        }),
      );
    }
  }
  if (availableHours === null) {
    availableHours = await probeAvailableNoaaHoursInRosterOrder({
      modelKey,
      noaaBaseUrl,
      run,
      requestedHours,
      lookahead,
      missConfirmDelayMs,
    });
  }
  if (availableHours.length === 0) {
    throw new Error(`No available NOAA ${modelKey} forecast hours for ${run.date} ${run.cycle}Z.`);
  }
  if (logCappedPrefix && availableHours.length < requestedHours.length) {
    const lastHour = availableHours[availableHours.length - 1];
    const nextHour = requestedHours[availableHours.length];
    console.log(
      `[noaa-beta] ${modelKey} ${run.date} ${run.cycle}Z capped at F${padHour(lastHour)}; F${padHour(nextHour)} is not published yet`,
    );
  }
  return availableHours;
}

async function probeAvailableNoaaHoursInRosterOrder({
  modelKey,
  noaaBaseUrl,
  run,
  requestedHours,
  lookahead,
  missConfirmDelayMs,
}) {
  const availableHours = [];
  // noaaForecastHourExists never rejects (fetch errors read as unavailable),
  // so probes launched past the first miss and never awaited are harmless.
  const inFlight = new Map();
  let nextLaunch = 0;
  const launchNext = () => {
    if (nextLaunch >= requestedHours.length) {
      return;
    }
    const index = nextLaunch;
    nextLaunch += 1;
    inFlight.set(index, noaaForecastHourExists({ modelKey, noaaBaseUrl, run, hour: requestedHours[index] }));
  };
  while (nextLaunch < Math.min(Math.max(1, lookahead), requestedHours.length)) {
    launchNext();
  }
  for (let index = 0; index < requestedHours.length; index += 1) {
    let available = await inFlight.get(index);
    inFlight.delete(index);
    if (!available) {
      if (missConfirmDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, missConfirmDelayMs));
      }
      available = await noaaForecastHourExists({ modelKey, noaaBaseUrl, run, hour: requestedHours[index] });
    }
    if (!available) {
      break;
    }
    availableHours.push(requestedHours[index]);
    launchNext();
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
    // A blank '--cycle=' (e.g. an unset shell variable) is as absent as no flag
    // at all: normalizeCycle would pad either to "00" and silently render the
    // 00Z run.
    const blankCycle = typeof cycle === "string" && cycle.trim() === "";
    if (date !== undefined && (cycle === undefined || blankCycle)) {
      throw new Error("--date requires --cycle=HH (00 through 23).");
    }
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

async function resolveNoaaParameterSetForRun({ modelKey = "nam", noaaBaseUrl, run, hours, renderSelection = null }) {
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
  return resolveNoaaParameterSetFromIdxTexts(indexTexts, { modelKey, renderSelection });
}

function resolveNoaaParameterSetFromIdxTexts(indexTexts, options = {}) {
  const catalog = resolveNoaaNamParameterCatalog(options.renderSelection);
  const selections = (Array.isArray(indexTexts) ? indexTexts : [])
    .map((indexText) =>
      selectNoaaNamParameterRecords(parseNoaaIdx(indexText, null), {
        catalog,
        modelKey: options.modelKey,
      }),
    )
    .filter(Boolean);
  const availableParameters = new Set();
  for (const selection of selections) {
    for (const key of selection.availableParameters || []) {
      availableParameters.add(key);
    }
  }
  const requiredParameters = new Set(catalog.filter((entry) => entry.required).map((entry) => entry.key));
  const parameters = getNoaaNamParameterMetadata(options.renderSelection);
  const parameterOrder = getNoaaNamParameterOrder(options.renderSelection);
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

// Mirrors the renderer's selection gate (selectionAllows) so the manifest layer
// plan and the rendered artifact set stay in lockstep. A null selection returns
// the inputs untouched (same references) so a no-flags default build stays
// byte-identical to today.
function filterNoaaParameterSetByRenderSelection({ parameters, parameterOrder }, renderSelection) {
  if (!renderSelection) {
    return { parameters, parameterOrder };
  }
  const entryByKey = new Map(resolveNoaaNamParameterCatalog(renderSelection).map((entry) => [entry.key, entry]));
  const order = Array.isArray(parameterOrder) ? parameterOrder : [];
  const allowedOrder = order.filter((key) => {
    const entry = entryByKey.get(key);
    return !entry || selectionAllows(renderSelection, entry);
  });
  if (allowedOrder.length === order.length) {
    return { parameters, parameterOrder };
  }
  const allowedKeys = new Set(allowedOrder);
  const filteredParameters = {};
  for (const [key, value] of Object.entries(parameters || {})) {
    if (allowedKeys.has(key) || !entryByKey.has(key)) {
      filteredParameters[key] = value;
    }
  }
  return { parameters: filteredParameters, parameterOrder: allowedOrder };
}

function buildNoaaModelMetadata({
  modelKey = "nam",
  run,
  hours,
  noaaBaseUrl,
  parameters = null,
  parameterOrder = null,
  renderSelection = null,
  gfsHourlyThrough120 = false,
  sourceProvenanceCatalog = null,
  reflectivityGates = null,
}) {
  const resolvedModelKey = normalizeNoaaModelKey(modelKey);
  const modelConfig = getNoaaGribModelConfig(resolvedModelKey);
  const baseUrl = String(noaaBaseUrl || modelConfig.baseUrl)
    .trim()
    .replace(/\/+$/, "");
  const referenceTime = referenceTimeFromRun(run);
  const runId = formatRunIdFromReference(referenceTime);
  const validTimes = hours.map((hour) => addHours(referenceTime, hour));
  const parameterSet = filterNoaaParameterSetByRenderSelection(
    {
      parameters: parameters || getNoaaNamParameterMetadata(renderSelection),
      parameterOrder: parameterOrder || getNoaaNamParameterOrder(renderSelection),
    },
    renderSelection,
  );
  const forecastHourPolicy = buildForecastHourPolicy(resolvedModelKey, hours, { gfsHourlyThrough120 });
  const forecastHourSamplingTier = resolveForecastHourSamplingTier(resolvedModelKey, hours, {
    gfsHourlyThrough120,
  });
  const forecastHourRoster = buildForecastHourRosterIdentity({
    modelKey: resolvedModelKey,
    hours,
    tier: forecastHourSamplingTier,
    cycle: run.cycle,
  });
  const wgrib2ToolRef = String(sourceProvenanceCatalog?.tools?.[0]?.id || "").trim() || null;
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
      forecastHourPolicy,
      forecastHourRosterId: forecastHourRoster.id,
      forecastHourCompletionIdentity: forecastHourRoster.completionIdentity,
    },
    noaa: {
      model: resolvedModelKey,
      baseUrl,
      date: run.date,
      cycle: run.cycle,
      product: modelConfig.productKey,
    },
    rendererSignature: getNoaaGribRendererSignature(renderSelection, {
      forecastHourRosterIdentity: forecastHourRoster.completionIdentity,
      wgrib2ToolRef,
      reflectivityGates,
    }),
    forecastHourPolicy,
    forecastHourRoster,
    ...(sourceProvenanceCatalog ? { sourceProvenanceCatalog } : {}),
    hoverGridFormat: "binary",
    parameters: parameterSet.parameters,
    parameterOrder: parameterSet.parameterOrder,
    parameterKeys: parameterSet.parameterOrder,
    // Additive: only selective builds carry the selection so a null selection
    // leaves the metadata (and thus the manifest) without the key entirely.
    ...(renderSelection ? { renderSelection } : {}),
  };
}

function buildForecastHourPolicy(modelKey, hours, { gfsHourlyThrough120 = false } = {}) {
  const normalizedHours = Array.from(
    new Set(
      (Array.isArray(hours) ? hours : [])
        .map((hour) => Math.round(Number(hour)))
        .filter((hour) => Number.isFinite(hour) && hour >= 0),
    ),
  ).sort((left, right) => left - right);
  const maxRenderedHour = normalizedHours.at(-1) ?? null;
  if (modelKey === "nam") {
    const officialHours = buildForecastHoursFromCadence(getNoaaGribModelConfig(modelKey).forecastHourCadence);
    const shortHours = officialHours.filter((hour) => hour <= 36);
    const completeOfficial = equalHourLists(normalizedHours, officialHours);
    const completeShort = equalHourLists(normalizedHours, shortHours);
    const officialPrefix = isExactForecastHourPrefix(normalizedHours, officialHours);
    const shortPrefix = isExactForecastHourPrefix(normalizedHours, shortHours);
    const extended = maxRenderedHour !== null && maxRenderedHour > 36;
    const policy = completeOfficial
      ? "official-f000-f084"
      : extended && officialPrefix
        ? "official-cadence-prefix"
        : completeShort
          ? "configured-short-f000-f036"
          : shortPrefix
            ? "configured-short-prefix"
            : "configured-sparse";
    const sparse = policy === "configured-sparse";
    return {
      policy,
      maxRenderedHour,
      frameCount: normalizedHours.length,
      cadence: sparse
        ? "custom sparse roster (see forecastHourRoster.hours)"
        : extended
          ? "hourly F000-F036; every 3 h F039-F084"
          : "hourly F000-F036",
      officialMaxHour: officialHours.at(-1) ?? 84,
      disclosure: completeOfficial
        ? "Complete official NAM horizon: 53 frames, hourly F000-F036 and every 3 h F039-F084."
        : extended && officialPrefix
          ? `Configured official-cadence NAM selection has ${normalizedHours.length} frames through F${padHour(
              maxRenderedHour,
            )}; it is not the complete 53-frame F084 horizon.`
          : completeShort
            ? "Complete configured NAM short tier: 37 hourly frames F000-F036. The official F084 tier adds 16 frames (about 43% more frame work)."
            : shortPrefix
              ? `Configured NAM short-tier prefix has ${normalizedHours.length} frames through F${padHour(
                  maxRenderedHour,
                )}; it is not the complete 37-frame F036 short tier.`
              : `Configured sparse NAM roster has ${normalizedHours.length} frames through F${padHour(
                  maxRenderedHour,
                )}; it is not a contiguous prefix of the hourly-short or official cadence.`,
    };
  }
  if (modelKey === "gfs") {
    const defaultHours = buildFullHoursForModel("gfs");
    const mixedHours = buildFullHoursForModel("gfs", { gfsHourlyThrough120: true });
    const completeDefault = equalHourLists(normalizedHours, defaultHours);
    const completeMixed = equalHourLists(normalizedHours, mixedHours);
    const defaultPrefix = isExactForecastHourPrefix(normalizedHours, defaultHours);
    const mixedPrefix = isExactForecastHourPrefix(normalizedHours, mixedHours);
    const usesHourlyTier =
      Boolean(gfsHourlyThrough120) || normalizedHours.some((hour) => hour <= 120 && hour % 3 !== 0);
    const policy = completeMixed
      ? "hourly-f000-f120-then-3h-f123-f384"
      : usesHourlyTier && mixedPrefix
        ? "hourly-through-f120-cadence-prefix"
        : completeDefault
          ? "configured-3h-f000-f384"
          : !usesHourlyTier && defaultPrefix
            ? "configured-3h-prefix"
            : "configured-sparse";
    const sparse = policy === "configured-sparse";
    return {
      policy,
      maxRenderedHour,
      frameCount: normalizedHours.length,
      cadence: sparse
        ? "custom sparse roster (see forecastHourRoster.hours)"
        : usesHourlyTier || completeMixed
          ? "hourly F000-F120; every 3 h F123-F384"
          : "every 3 h F000-F384",
      officialMaxHour: 384,
      disclosure: completeMixed
        ? "Optional GFS mixed-cadence tier: 209 frames, hourly F000-F120 and every 3 h F123-F384."
        : usesHourlyTier && mixedPrefix
          ? `Optional GFS mixed-cadence prefix has ${normalizedHours.length} frames through F${padHour(
              maxRenderedHour,
            )}; it is not the complete 209-frame F384 tier.`
          : completeDefault
            ? "Configured low-compute GFS tier: 129 frames every 3 h F000-F384. The optional mixed-cadence tier adds 80 frames through hourly sampling to F120."
            : !usesHourlyTier && defaultPrefix
              ? `Configured GFS 3-hour tier prefix has ${normalizedHours.length} frames through F${padHour(
                  maxRenderedHour,
                )}; it is not the complete 129-frame F384 tier.`
              : `Configured sparse GFS roster has ${normalizedHours.length} frames through F${padHour(
                  maxRenderedHour,
                )}; it is not a contiguous prefix of the three-hourly or mixed-cadence tier.`,
    };
  }
  return {
    policy: "configured",
    maxRenderedHour,
    frameCount: normalizedHours.length,
  };
}

function equalHourLists(left, right) {
  return left.length === right.length && left.every((hour, index) => hour === right[index]);
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
  // Blank input must not pad to "00": '--cycle=' from an unset shell variable
  // would otherwise silently select the 00Z run.
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`Expected NOAA cycle as HH, 00 through 23; got blank --cycle value '${value ?? ""}'.`);
  }
  const text = String(value).padStart(2, "0");
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

function parseHours(raw, sourceLabel = "--hours") {
  if (raw === true) {
    throw new Error(`${sourceLabel} requires a value (e.g. --hours=0,3,6).`);
  }
  // Empty tokens (trailing/doubled commas) are ignored; anything else that is
  // not a non-negative integer throws instead of being silently dropped or
  // rounded — a lenient parse would alter the production frame roster with no
  // log trace.
  const tokens = String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const hours = tokens.map((token) => {
    const value = Number(token);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `Invalid forecast hour '${token}' in ${sourceLabel}; expected non-negative integers (e.g. 0,3,6).`,
      );
    }
    return value;
  });
  const unique = Array.from(new Set(hours)).sort((left, right) => left - right);
  if (unique.length === 0) {
    throw new Error(`No forecast hours selected in ${sourceLabel}. Use --hours=0,3,6.`);
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
  AVAILABILITY_PROBE_LOOKAHEAD,
  AVAILABILITY_MISS_CONFIRM_DELAY_MS,
  DEFAULT_HOURS,
  addHours,
  buildFullHoursForModel,
  buildForecastHourPolicy,
  buildForecastHoursFromCadence,
  buildNoaaModelMetadata,
  buildNoaaNamMetadata,
  buildRecentCycleCandidates,
  filterNoaaParameterSetByRenderSelection,
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
