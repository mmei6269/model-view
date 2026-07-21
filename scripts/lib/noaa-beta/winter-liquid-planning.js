"use strict";

const { getNoaaRecordsForHour } = require("./grib-source");
const {
  findRecord,
  isSurfaceAccumulatedFreezingRainRecord,
  isSurfaceAccumulatedSnowWaterRecord,
  isSurfacePrecipRecord,
  parseAccumulationWindow,
} = require("./records");
const { mapWithConcurrency } = require("./cache-io");
const {
  SNOW_SOURCE_SELECTORS,
  findExactAverageSnowMaskRecords,
  hasCompletePhaseMaskRecordSet,
} = require("./selection");
const { metadataFanoutConcurrency } = require("./accumulation");

async function resolveSnowLiquidTotalPlan(context) {
  const endHour = Math.round(Number(context.targetHour));
  if (!Number.isFinite(endHour) || endHour <= 0 || !context.availableHourSet.has(endHour)) {
    return null;
  }
  const cumulative = await buildCumulativeSnowLiquidPlan(context, endHour);
  if (cumulative.length > 0) {
    return { terms: cumulative };
  }
  const summed = await buildSnowLiquidIntervalSumPlan(context, 0, endHour);
  return summed.length > 0 ? { terms: summed.map((interval) => snowLiquidTerm(interval, 1)) } : null;
}

async function buildCumulativeSnowLiquidPlan(context, endHour) {
  const targetHour = Math.round(Number(endHour));
  if (!Number.isFinite(targetHour) || targetHour <= 0 || !context.availableHourSet.has(targetHour)) {
    return [];
  }
  const cacheKey = String(targetHour);
  if (context.snowLiquidCumulativePlanCache?.has(cacheKey)) {
    return context.snowLiquidCumulativePlanCache.get(cacheKey);
  }
  let terms = [];
  const directWeasd = await findExactSnowLiquidInterval(context, 0, targetHour, { kind: "weasd" });
  if (directWeasd) {
    terms = [snowLiquidTerm(directWeasd, 1)];
  } else {
    const intervals = await getSnowLiquidIntervalsForHour(context, targetHour);
    const candidates = intervals
      .filter(
        (interval) => interval.endHour === targetHour && interval.startHour >= 0 && interval.startHour < targetHour,
      )
      .sort(compareSnowLiquidEndingIntervalPriority);
    for (const interval of candidates) {
      const prefix = interval.startHour === 0 ? [] : await buildCumulativeSnowLiquidPlan(context, interval.startHour);
      if (interval.startHour === 0 || prefix.length > 0) {
        terms = mergeWeightedSnowLiquidTerms(prefix, [snowLiquidTerm(interval, 1)]);
        break;
      }
    }
    if (terms.length === 0) {
      const summed = await buildSnowLiquidIntervalSumPlan(context, 0, targetHour);
      terms = summed.map((interval) => snowLiquidTerm(interval, 1));
    }
  }
  context.snowLiquidCumulativePlanCache?.set(cacheKey, terms);
  return terms;
}

async function findExactSnowLiquidInterval(context, startHour, endHour, options = {}) {
  const intervals = await getSnowLiquidIntervalsForHour(context, endHour);
  const kind = options.kind ? String(options.kind) : null;
  return (
    intervals
      .filter(
        (interval) =>
          interval.startHour === startHour && interval.endHour === endHour && (!kind || interval.kind === kind),
      )
      .sort(compareSnowLiquidIntervalPriority)[0] || null
  );
}

async function buildSnowLiquidIntervalSumPlan(context, startHour, endHour) {
  const cacheKey = `${Math.round(Number(startHour))}:${Math.round(Number(endHour))}`;
  if (context.snowLiquidIntervalSumPlanCache?.has(cacheKey)) {
    return context.snowLiquidIntervalSumPlanCache.get(cacheKey);
  }
  const intervals = [];
  for (const hour of context.availableHours.filter((candidate) => candidate > startHour && candidate <= endHour)) {
    intervals.push(...(await getSnowLiquidIntervalsForHour(context, hour)));
  }
  const usable = intervals.filter((interval) => {
    return interval.startHour >= startHour && interval.endHour <= endHour && interval.endHour > interval.startHour;
  });
  const terms = findSnowLiquidIntervalPath(usable, startHour, endHour);
  context.snowLiquidIntervalSumPlanCache?.set(cacheKey, terms);
  return terms;
}

async function resolveSnowfallLiquidChunksForWindow(context, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const targetHour = Math.round(Number(endHour));
  const cacheKey = `${start}:${targetHour}`;
  if (context?.snowfallLiquidChunksByWindow?.has(cacheKey)) {
    return context.snowfallLiquidChunksByWindow.get(cacheKey);
  }
  const promise = resolveSnowfallLiquidChunksForWindowUncached(context, start, targetHour).catch((error) => {
    context?.snowfallLiquidChunksByWindow?.delete(cacheKey);
    throw error;
  });
  context?.snowfallLiquidChunksByWindow?.set(cacheKey, promise);
  return promise;
}

async function resolveSnowfallLiquidChunksForWindowUncached(context, start, targetHour) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(targetHour) ||
    start < 0 ||
    targetHour <= start ||
    !context.availableHourSet.has(targetHour)
  ) {
    return [];
  }
  const candidates = [];
  const cumulativeWeasdByHour = new Map();
  const sourceHours = context.availableHours.filter((candidate) => {
    return candidate <= targetHour && (candidate > start || (start > 0 && candidate === start));
  });
  const intervalsByHour = await mapWithConcurrency(sourceHours, metadataFanoutConcurrency(context, 8), async (hour) => [
    hour,
    await getSnowLiquidIntervalsForHour(context, hour),
  ]);
  for (const [hour, intervals] of intervalsByHour) {
    const directWeasd = intervals
      .filter((interval) => interval.kind === "weasd" && interval.startHour === 0 && interval.endHour === hour)
      .sort(compareSnowLiquidIntervalPriority)[0];
    if (directWeasd) {
      cumulativeWeasdByHour.set(hour, directWeasd);
    }
    if (hour <= start) {
      continue;
    }
    for (const interval of intervals) {
      if (interval.startHour < start || interval.endHour > targetHour || interval.endHour <= interval.startHour) {
        continue;
      }
      candidates.push(
        snowfallLiquidChunkFromTerms({
          kind: interval.kind,
          startHour: interval.startHour,
          endHour: interval.endHour,
          terms: [snowLiquidTerm(interval, 1)],
        }),
      );
    }
  }
  const cumulativeHours =
    cumulativeWeasdByHour.has(start) || start === 0
      ? [
          start,
          ...Array.from(cumulativeWeasdByHour.keys())
            .filter((hour) => hour > start)
            .sort((left, right) => left - right),
        ]
      : [];
  for (let index = 1; index < cumulativeHours.length; index += 1) {
    const startHour = cumulativeHours[index - 1];
    const chunkEndHour = cumulativeHours[index];
    const endInterval = cumulativeWeasdByHour.get(chunkEndHour);
    if (!endInterval) {
      continue;
    }
    const terms = [snowLiquidTerm(endInterval, 1)];
    if (startHour > 0) {
      const startInterval = cumulativeWeasdByHour.get(startHour);
      if (!startInterval) {
        continue;
      }
      terms.push(snowLiquidTerm(startInterval, -1));
    }
    candidates.push(
      snowfallLiquidChunkFromTerms({
        kind: "weasdDelta",
        startHour,
        endHour: chunkEndHour,
        terms,
      }),
    );
  }
  return findSnowfallLiquidChunkPath(candidates, start, targetHour);
}

function snowfallLiquidChunkFromTerms({ kind, startHour, endHour, terms }) {
  const start = Math.round(Number(startHour));
  const end = Math.round(Number(endHour));
  return {
    key: `snowfall-liquid:${kind}:${start}-${end}:${terms.map((term) => `${term.sourceKey}:${term.weight}`).join("|")}`,
    kind,
    startHour: start,
    endHour: end,
    profileHour: end,
    terms,
  };
}

async function getSnowLiquidIntervalsForHour(context, hour) {
  const targetHour = Math.round(Number(hour));
  if (!context.availableHourSet.has(targetHour)) {
    return [];
  }
  if (context.snowLiquidIntervalsByHour?.has(targetHour)) {
    return context.snowLiquidIntervalsByHour.get(targetHour);
  }
  const records = await getNoaaRecordsForHour(context, targetHour);
  const intervals = [];
  for (const record of records) {
    if (!isSurfaceAccumulatedSnowWaterRecord(record) && !isSurfacePrecipRecord(record)) {
      continue;
    }
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour < window.startHour) {
      continue;
    }
    if (isSurfaceAccumulatedSnowWaterRecord(record)) {
      intervals.push({
        kind: "weasd",
        hour: targetHour,
        record,
        startHour: window.startHour,
        endHour: window.endHour,
      });
    } else {
      const intervalMaskRecords = findExactAverageSnowMaskRecords(records, window.startHour, window.endHour);
      const maskSamples = intervalMaskRecords
        ? []
        : await buildSnowMaskSamplesForInterval(context, window.startHour, window.endHour);
      if (!intervalMaskRecords && maskSamples.length === 0) {
        continue;
      }
      intervals.push({
        kind: "apcpSnow",
        hour: targetHour,
        record,
        maskTargetKey: "snow",
        maskRecords: intervalMaskRecords || null,
        maskSamples,
        startHour: window.startHour,
        endHour: window.endHour,
      });
    }
  }
  context.snowLiquidIntervalsByHour?.set(targetHour, intervals);
  return intervals;
}

async function buildSnowMaskSamplesForInterval(context, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const end = Math.round(Number(endHour));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [];
  }
  const sampleHours = context.availableHours
    .map((hour) => Math.round(Number(hour)))
    .filter((hour) => Number.isFinite(hour) && hour > start && hour <= end)
    .sort((left, right) => left - right);
  if (!sampleHours.includes(end) && context.availableHourSet.has(end)) {
    sampleHours.push(end);
    sampleHours.sort((left, right) => left - right);
  }
  const sampled = await mapWithConcurrency(sampleHours, metadataFanoutConcurrency(context, 8), async (sampleHour) => {
    const records = await getNoaaRecordsForHour(context, sampleHour);
    const maskRecords = {
      snow: findRecord(records, SNOW_SOURCE_SELECTORS.snow),
      rain: findRecord(records, SNOW_SOURCE_SELECTORS.rain),
      freezingRain: findRecord(records, SNOW_SOURCE_SELECTORS.freezingRain),
      icePellets: findRecord(records, SNOW_SOURCE_SELECTORS.icePellets),
    };
    return hasCompletePhaseMaskRecordSet(maskRecords) ? { hour: sampleHour, maskRecords } : null;
  });
  if (sampled.length === 0 || sampled.some((sample) => !sample)) {
    return [];
  }
  const out = [];
  let previousHour = start;
  for (const sample of sampled) {
    out.push({
      hour: sample.hour,
      weight: Math.max(0, sample.hour - previousHour),
      ...sample.maskRecords,
    });
    previousHour = sample.hour;
  }
  return previousHour === end ? out : [];
}

async function resolveDirectFreezingRainLiquidChunksForWindow(context, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const targetHour = Math.round(Number(endHour));
  const cacheKey = `${start}:${targetHour}`;
  if (context?.freezingRainDirectChunksByWindow?.has(cacheKey)) {
    return context.freezingRainDirectChunksByWindow.get(cacheKey);
  }
  const promise = resolveDirectFreezingRainLiquidChunksForWindowUncached(context, start, targetHour).catch((error) => {
    context?.freezingRainDirectChunksByWindow?.delete(cacheKey);
    throw error;
  });
  context?.freezingRainDirectChunksByWindow?.set(cacheKey, promise);
  return promise;
}

async function resolveDirectFreezingRainLiquidChunksForWindowUncached(context, start, targetHour) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(targetHour) ||
    start < 0 ||
    targetHour <= start ||
    !context.availableHourSet.has(targetHour)
  ) {
    return [];
  }
  const targetIntervals = await getDirectFreezingRainLiquidIntervalsForHour(context, targetHour);
  if (
    !targetIntervals.some((interval) => {
      return interval.startHour >= start && interval.endHour === targetHour && interval.endHour > interval.startHour;
    })
  ) {
    return [];
  }
  const sourceHours = context.availableHours.filter((candidate) => {
    return candidate <= targetHour && (candidate > start || (start > 0 && candidate === start));
  });
  const intervalsByHour = await mapWithConcurrency(sourceHours, metadataFanoutConcurrency(context, 8), async (hour) => [
    hour,
    await getDirectFreezingRainLiquidIntervalsForHour(context, hour),
  ]);
  const candidates = [];
  const cumulativeFrzrByHour = new Map();
  for (const [hour, intervals] of intervalsByHour) {
    const directFrzr = intervals
      .filter((interval) => interval.kind === "frzr" && interval.startHour === 0 && interval.endHour === hour)
      .sort(compareFreezingRainLiquidIntervalPriority)[0];
    if (directFrzr) {
      cumulativeFrzrByHour.set(hour, directFrzr);
    }
    if (hour <= start) {
      continue;
    }
    for (const interval of intervals) {
      if (interval.startHour < start || interval.endHour > targetHour || interval.endHour <= interval.startHour) {
        continue;
      }
      candidates.push(
        snowfallLiquidChunkFromTerms({
          kind: interval.kind,
          startHour: interval.startHour,
          endHour: interval.endHour,
          terms: [snowLiquidTerm(interval, 1)],
        }),
      );
    }
  }
  const cumulativeHours =
    cumulativeFrzrByHour.has(start) || start === 0
      ? [
          start,
          ...Array.from(cumulativeFrzrByHour.keys())
            .filter((hour) => hour > start)
            .sort((left, right) => left - right),
        ]
      : [];
  for (let index = 1; index < cumulativeHours.length; index += 1) {
    const startHour = cumulativeHours[index - 1];
    const chunkEndHour = cumulativeHours[index];
    const endInterval = cumulativeFrzrByHour.get(chunkEndHour);
    if (!endInterval) {
      continue;
    }
    const terms = [snowLiquidTerm(endInterval, 1)];
    if (startHour > 0) {
      const startInterval = cumulativeFrzrByHour.get(startHour);
      if (!startInterval) {
        continue;
      }
      terms.push(snowLiquidTerm(startInterval, -1));
    }
    candidates.push(
      snowfallLiquidChunkFromTerms({
        kind: "frzrDelta",
        startHour,
        endHour: chunkEndHour,
        terms,
      }),
    );
  }
  return findSnowfallLiquidChunkPath(candidates, start, targetHour);
}

async function resolveFreezingRainLiquidChunksForWindow(context, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const targetHour = Math.round(Number(endHour));
  const cacheKey = `${start}:${targetHour}`;
  if (context?.freezingRainLiquidChunksByWindow?.has(cacheKey)) {
    return context.freezingRainLiquidChunksByWindow.get(cacheKey);
  }
  const promise = resolveFreezingRainLiquidChunksForWindowUncached(context, start, targetHour).catch((error) => {
    context?.freezingRainLiquidChunksByWindow?.delete(cacheKey);
    throw error;
  });
  context?.freezingRainLiquidChunksByWindow?.set(cacheKey, promise);
  return promise;
}

async function resolveFreezingRainLiquidChunksForWindowUncached(context, start, targetHour) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(targetHour) ||
    start < 0 ||
    targetHour <= start ||
    !context.availableHourSet.has(targetHour)
  ) {
    return [];
  }
  const candidates = [];
  const cumulativeFrzrByHour = new Map();
  const sourceHours = context.availableHours.filter((candidate) => {
    return candidate <= targetHour && (candidate > start || (start > 0 && candidate === start));
  });
  const intervalsByHour = await mapWithConcurrency(sourceHours, metadataFanoutConcurrency(context, 8), async (hour) => [
    hour,
    await getFreezingRainLiquidIntervalsForHour(context, hour),
  ]);
  for (const [hour, intervals] of intervalsByHour) {
    const directFrzr = intervals
      .filter((interval) => interval.kind === "frzr" && interval.startHour === 0 && interval.endHour === hour)
      .sort(compareFreezingRainLiquidIntervalPriority)[0];
    if (directFrzr) {
      cumulativeFrzrByHour.set(hour, directFrzr);
    }
    if (hour <= start) {
      continue;
    }
    for (const interval of intervals) {
      if (interval.startHour < start || interval.endHour > targetHour || interval.endHour <= interval.startHour) {
        continue;
      }
      candidates.push(
        snowfallLiquidChunkFromTerms({
          kind: interval.kind,
          startHour: interval.startHour,
          endHour: interval.endHour,
          terms: [snowLiquidTerm(interval, 1)],
        }),
      );
    }
  }
  const cumulativeHours =
    cumulativeFrzrByHour.has(start) || start === 0
      ? [
          start,
          ...Array.from(cumulativeFrzrByHour.keys())
            .filter((hour) => hour > start)
            .sort((left, right) => left - right),
        ]
      : [];
  for (let index = 1; index < cumulativeHours.length; index += 1) {
    const startHour = cumulativeHours[index - 1];
    const chunkEndHour = cumulativeHours[index];
    const endInterval = cumulativeFrzrByHour.get(chunkEndHour);
    if (!endInterval) {
      continue;
    }
    const terms = [snowLiquidTerm(endInterval, 1)];
    if (startHour > 0) {
      const startInterval = cumulativeFrzrByHour.get(startHour);
      if (!startInterval) {
        continue;
      }
      terms.push(snowLiquidTerm(startInterval, -1));
    }
    candidates.push(
      snowfallLiquidChunkFromTerms({
        kind: "frzrDelta",
        startHour,
        endHour: chunkEndHour,
        terms,
      }),
    );
  }
  return findSnowfallLiquidChunkPath(candidates, start, targetHour);
}

async function warmFreezingRainAccumulationRunPlanner(context, targetHour) {
  if (!context) {
    return [];
  }
  if (context.freezingRainAccumulationPlannerReady) {
    return context.freezingRainAccumulationChunksByTarget || [];
  }
  context.freezingRainAccumulationPlannerReady = true;
  const target = Math.round(Number(targetHour ?? context.targetHour));
  if (!Number.isFinite(target) || target <= 0) {
    context.freezingRainAccumulationChunksByTarget = [];
    return [];
  }
  const chunks = await resolveFreezingRainLiquidChunksForWindow(context, 0, target);
  context.freezingRainAccumulationChunksByTarget = chunks;
  return chunks;
}

async function getFreezingRainLiquidIntervalsForHour(context, hour) {
  const targetHour = Math.round(Number(hour));
  if (!context.availableHourSet.has(targetHour)) {
    return [];
  }
  if (context.freezingRainLiquidIntervalsByHour?.has(targetHour)) {
    return context.freezingRainLiquidIntervalsByHour.get(targetHour);
  }
  const directIntervals = await getDirectFreezingRainLiquidIntervalsForHour(context, targetHour);
  const directWindowKeys = new Set(directIntervals.map((interval) => `${interval.startHour}:${interval.endHour}`));
  const records = await getNoaaRecordsForHour(context, targetHour);
  const intervals = [...directIntervals];
  for (const record of records) {
    if (!isSurfacePrecipRecord(record)) {
      continue;
    }
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour < window.startHour) {
      continue;
    }
    if (directWindowKeys.has(`${window.startHour}:${window.endHour}`)) {
      continue;
    }
    const intervalMaskRecords = findExactAverageSnowMaskRecords(records, window.startHour, window.endHour);
    const maskSamples = intervalMaskRecords
      ? []
      : await buildSnowMaskSamplesForInterval(context, window.startHour, window.endHour);
    if (!intervalMaskRecords && maskSamples.length === 0) {
      continue;
    }
    intervals.push({
      kind: "apcpFreezingRain",
      hour: targetHour,
      record,
      maskTargetKey: "freezingRain",
      maskRecords: intervalMaskRecords || null,
      maskSamples,
      startHour: window.startHour,
      endHour: window.endHour,
    });
  }
  intervals.sort(compareFreezingRainLiquidIntervalPriority);
  context.freezingRainLiquidIntervalsByHour?.set(targetHour, intervals);
  return intervals;
}

async function getDirectFreezingRainLiquidIntervalsForHour(context, hour) {
  const targetHour = Math.round(Number(hour));
  if (!context.availableHourSet.has(targetHour)) {
    return [];
  }
  if (context.freezingRainDirectIntervalsByHour?.has(targetHour)) {
    return context.freezingRainDirectIntervalsByHour.get(targetHour);
  }
  const records = await getNoaaRecordsForHour(context, targetHour);
  const intervals = [];
  for (const record of records) {
    if (!isSurfaceAccumulatedFreezingRainRecord(record)) {
      continue;
    }
    const window = parseAccumulationWindow(record);
    if (!window || window.endHour < window.startHour) {
      continue;
    }
    intervals.push({
      kind: "frzr",
      hour: targetHour,
      record,
      startHour: window.startHour,
      endHour: window.endHour,
    });
  }
  intervals.sort(compareFreezingRainLiquidIntervalPriority);
  context.freezingRainDirectIntervalsByHour?.set(targetHour, intervals);
  return intervals;
}

function compareFreezingRainLiquidIntervalPriority(left, right) {
  const leftKind = left?.kind === "frzr" ? 0 : 1;
  const rightKind = right?.kind === "frzr" ? 0 : 1;
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  return (right?.endHour || 0) - (left?.endHour || 0);
}

function compareSnowLiquidIntervalPriority(left, right) {
  const leftKind = left?.kind === "weasd" ? 0 : 1;
  const rightKind = right?.kind === "weasd" ? 0 : 1;
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  return (right?.endHour || 0) - (left?.endHour || 0);
}

function compareSnowLiquidEndingIntervalPriority(left, right) {
  const leftKind = left?.kind === "weasd" ? 0 : 1;
  const rightKind = right?.kind === "weasd" ? 0 : 1;
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  if (left?.kind === "weasd" && right?.kind === "weasd") {
    return (left?.startHour || 0) - (right?.startHour || 0);
  }
  return (right?.startHour || 0) - (left?.startHour || 0);
}

function compareSnowLiquidPathIntervalPriority(left, right) {
  const leftKind = left?.kind === "weasd" ? 0 : 1;
  const rightKind = right?.kind === "weasd" ? 0 : 1;
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  if (left?.kind === "weasd" && right?.kind === "weasd") {
    return (right?.endHour || 0) - (left?.endHour || 0);
  }
  return (left?.endHour || 0) - (right?.endHour || 0);
}

function findSnowLiquidIntervalPath(intervals, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const end = Math.round(Number(endHour));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [];
  }
  const byStart = new Map();
  for (const interval of intervals || []) {
    const intervalStart = Math.round(Number(interval?.startHour));
    const intervalEnd = Math.round(Number(interval?.endHour));
    if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) {
      continue;
    }
    const group = byStart.get(intervalStart) || [];
    group.push(interval);
    byStart.set(intervalStart, group);
  }
  for (const group of byStart.values()) {
    group.sort(compareSnowLiquidPathIntervalPriority);
  }
  const memo = new Map();
  const search = (cursor) => {
    if (cursor === end) {
      return [];
    }
    if (cursor > end) {
      return null;
    }
    if (memo.has(cursor)) {
      return memo.get(cursor);
    }
    for (const interval of byStart.get(cursor) || []) {
      if (interval.endHour > end) {
        continue;
      }
      const tail = search(interval.endHour);
      if (tail) {
        const path = [interval, ...tail];
        memo.set(cursor, path);
        return path;
      }
    }
    memo.set(cursor, null);
    return null;
  };
  return search(start) || [];
}

function compareSnowfallLiquidChunkPriority(left, right) {
  const leftKind = snowfallLiquidChunkKindRank(left?.kind);
  const rightKind = snowfallLiquidChunkKindRank(right?.kind);
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  const leftDuration = Math.max(0, (left?.endHour || 0) - (left?.startHour || 0));
  const rightDuration = Math.max(0, (right?.endHour || 0) - (right?.startHour || 0));
  if (leftDuration !== rightDuration) {
    return leftDuration - rightDuration;
  }
  return (left?.endHour || 0) - (right?.endHour || 0);
}

function snowfallLiquidChunkKindRank(kind) {
  if (kind === "weasdDelta" || kind === "frzrDelta") {
    return 0;
  }
  if (kind === "weasd" || kind === "frzr") {
    return 1;
  }
  if (kind === "apcpSnow" || kind === "apcpFreezingRain") {
    return 2;
  }
  return 3;
}

function findSnowfallLiquidChunkPath(chunks, startHour, endHour) {
  const start = Math.round(Number(startHour));
  const end = Math.round(Number(endHour));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return [];
  }
  const byStart = new Map();
  for (const chunk of chunks || []) {
    if (!chunk || chunk.startHour < start || chunk.endHour > end || chunk.endHour <= chunk.startHour) {
      continue;
    }
    const group = byStart.get(chunk.startHour) || [];
    group.push(chunk);
    byStart.set(chunk.startHour, group);
  }
  for (const group of byStart.values()) {
    group.sort(compareSnowfallLiquidChunkPriority);
  }
  const memo = new Map();
  const search = (cursor) => {
    if (cursor === end) {
      return [];
    }
    if (cursor > end) {
      return null;
    }
    if (memo.has(cursor)) {
      return memo.get(cursor);
    }
    for (const chunk of byStart.get(cursor) || []) {
      const tail = search(chunk.endHour);
      if (tail) {
        const path = [chunk, ...tail];
        memo.set(cursor, path);
        return path;
      }
    }
    memo.set(cursor, null);
    return null;
  };
  return search(start) || [];
}

function mergeWeightedSnowLiquidTerms(...termLists) {
  const merged = new Map();
  for (const terms of termLists) {
    for (const term of terms || []) {
      const weight = Number(term.weight) || 0;
      if (!term?.sourceKey || weight === 0) {
        continue;
      }
      const existing = merged.get(term.sourceKey);
      if (existing) {
        existing.weight += weight;
      } else {
        merged.set(term.sourceKey, { ...term, weight });
      }
    }
  }
  return Array.from(merged.values()).filter((term) => Math.abs(Number(term.weight) || 0) > 1e-9);
}

function snowLiquidTerm(interval, weight) {
  return {
    sourceKey: snowLiquidSourceKey(interval),
    kind: interval.kind,
    hour: interval.hour,
    record: interval.record,
    maskTargetKey: interval.maskTargetKey || null,
    maskRecords: interval.maskRecords || null,
    maskSamples: interval.maskSamples || null,
    weight,
  };
}

function snowLiquidSourceKey(interval) {
  const mask = interval?.maskRecords || {};
  const maskToken = ["snow", "rain", "freezingRain", "icePellets"].map((key) => mask[key]?.record || "").join(".");
  const sampleToken = (interval?.maskSamples || [])
    .map(
      (sample) =>
        `${Math.round(Number(sample?.hour))}:${Number(sample?.weight) || 0}:${[
          "snow",
          "rain",
          "freezingRain",
          "icePellets",
        ]
          .map((key) => sample?.[key]?.record || "")
          .join(".")}`,
    )
    .join("|");
  return `snow-liquid:${interval?.kind || "unknown"}:${interval?.maskTargetKey || ""}:${Math.round(Number(interval?.hour))}:${
    interval?.record?.record || ""
  }:${interval?.record?.forecast || ""}:${maskToken}:${sampleToken}`;
}

module.exports = {
  buildCumulativeSnowLiquidPlan,
  buildSnowLiquidIntervalSumPlan,
  buildSnowMaskSamplesForInterval,
  compareFreezingRainLiquidIntervalPriority,
  compareSnowLiquidEndingIntervalPriority,
  compareSnowLiquidIntervalPriority,
  compareSnowLiquidPathIntervalPriority,
  compareSnowfallLiquidChunkPriority,
  findExactSnowLiquidInterval,
  findSnowLiquidIntervalPath,
  findSnowfallLiquidChunkPath,
  getDirectFreezingRainLiquidIntervalsForHour,
  getFreezingRainLiquidIntervalsForHour,
  getSnowLiquidIntervalsForHour,
  mergeWeightedSnowLiquidTerms,
  resolveDirectFreezingRainLiquidChunksForWindow,
  resolveDirectFreezingRainLiquidChunksForWindowUncached,
  resolveFreezingRainLiquidChunksForWindow,
  resolveFreezingRainLiquidChunksForWindowUncached,
  resolveSnowLiquidTotalPlan,
  resolveSnowfallLiquidChunksForWindow,
  resolveSnowfallLiquidChunksForWindowUncached,
  snowLiquidSourceKey,
  snowLiquidTerm,
  snowfallLiquidChunkFromTerms,
  snowfallLiquidChunkKindRank,
  warmFreezingRainAccumulationRunPlanner,
};
