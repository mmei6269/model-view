"use strict";

const { MPS_TO_KT } = require("./util");
const { dewpointFromTempRhK, wetBulbTemperatureC } = require("./thermo");
const {
  PROFILE_SURFACE_DECODE_KEYS,
  profileSpeedAtLevel,
  profileValue,
  resolveProfileGrid,
  surfaceDewpointK,
} = require("./profile-access");
const { getNoaaRecordsForHour } = require("./grib-source");
const { findRecord, parseAccumulationHours } = require("./records");
const { mapWithConcurrency, padHour } = require("./cache-io");
const { PROFILE_SURFACE_SELECTORS } = require("./selection");
const { activeVisitCount, activeVisitIndex, buildLiquidChunkDescriptors } = require("./winter-sparse");
const { decodeHourFanoutConcurrency } = require("./winter-source-grids");
const { addProfileRecord, materializeDecodedProfileGridsForHour } = require("./winter-profile-decode");

async function decodeFramSurfaceProfiles({ chunks, context, decoded }) {
  const profileHours = Array.from(new Set((chunks || []).flatMap((chunk) => framProfileHoursForChunk(chunk, context))))
    .filter((hour) => Number.isFinite(Number(hour)))
    .sort((left, right) => left - right);
  if (profileHours.length === 0) {
    return new Map();
  }
  const pairs = await mapWithConcurrency(profileHours, decodeHourFanoutConcurrency(context, 6), async (hour) => {
    const records = await getNoaaRecordsForHour(context, hour);
    const baseDecoded = hour === context.targetHour ? decoded || {} : {};
    const profileDecoded = await decodeFramSurfaceGridsForHour({
      hour,
      records,
      context,
      decoded: baseDecoded,
    });
    return [hour, { ...baseDecoded, ...profileDecoded }];
  });
  return new Map(pairs.filter(Boolean));
}

function framProfileHoursForChunk(chunk, context = null) {
  const start = Math.round(Number(chunk?.startHour));
  const end = Math.round(Number(chunk?.endHour ?? chunk?.profileHour));
  const explicit = Array.isArray(chunk?.profileHours)
    ? chunk.profileHours.map((hour) => Math.round(Number(hour))).filter(Number.isFinite)
    : [];
  if (explicit.length > 0) {
    return Array.from(new Set(explicit)).sort((left, right) => left - right);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    const fallback = Math.round(Number(chunk?.profileHour));
    return Number.isFinite(fallback) ? [fallback] : [];
  }
  const source = Array.isArray(context?.availableHours) ? context.availableHours : [];
  const hours = source
    .map((hour) => Math.round(Number(hour)))
    .filter((hour) => Number.isFinite(hour) && hour > start && hour <= end)
    .sort((left, right) => left - right);
  if (!hours.includes(end)) {
    hours.push(end);
    hours.sort((left, right) => left - right);
  }
  return Array.from(new Set(hours));
}

async function decodeFramSurfaceGridsForHour({ hour, records, context, decoded = null }) {
  const recordsByKey = {};
  const addRecord = (key, record) => {
    if (record && !decoded?.[key] && !recordsByKey[key]) {
      recordsByKey[key] = record;
    }
  };
  addFramSurfaceRecords({ records, addRecord });
  return materializeDecodedProfileGridsForHour({ recordsByKey, hour, context });
}

function addFramSurfaceRecords({ records, addRecord }) {
  for (const variable of ["TMP", "DPT", "RH", "UGRD", "VGRD"]) {
    const key = PROFILE_SURFACE_DECODE_KEYS[variable];
    const selector = PROFILE_SURFACE_SELECTORS[variable];
    if (key && selector) {
      addProfileRecord({ addRecord, key, record: findRecord(records, selector) });
    }
  }
}

function buildFramIceGrids(decoded, selection, liquidIn, cellCount) {
  const flat = new Float32Array(cellCount).fill(Number.NaN);
  const radial = new Float32Array(cellCount).fill(Number.NaN);
  const accumulationHours = parseAccumulationHours(selection?.records?.precip) || 1;
  for (let index = 0; index < cellCount; index += 1) {
    const liquid = Number(liquidIn?.[index]);
    if (!Number.isFinite(liquid)) {
      continue;
    }
    if (liquid <= 0) {
      flat[index] = 0;
      radial[index] = 0;
      continue;
    }
    const tempK = profileValue(decoded, "TMP", "surface", index);
    const dewpointK = surfaceDewpointK(decoded, index);
    const wetBulbC = wetBulbTemperatureC(tempK, dewpointK);
    const windKt = profileSpeedAtLevel(decoded, "surface", index) * MPS_TO_KT;
    if (!Number.isFinite(wetBulbC) || !Number.isFinite(windKt)) {
      continue;
    }
    const rateInHr = liquid / Math.max(1 / 60, accumulationHours);
    const ilr = calculateFramIceLiquidRatio(rateInHr, wetBulbC, windKt);
    if (!Number.isFinite(ilr)) {
      continue;
    }
    flat[index] = liquid * ilr;
    radial[index] = flat[index] * 0.394;
  }
  return { flat, radial };
}

function buildFramIceGridsFromChunks({
  chunks,
  chunkDescriptors = null,
  liquidByChunk,
  profilesByHour,
  decoded,
  width,
  height,
}) {
  const cellCount = Number(width) * Number(height);
  const flat = new Float32Array(cellCount).fill(0);
  const radial = new Float32Array(cellCount).fill(0);
  if (!Number.isFinite(cellCount) || cellCount <= 0 || !Array.isArray(chunks) || chunks.length === 0) {
    return { flat: null, radial: null };
  }
  const descriptors = Array.isArray(chunkDescriptors)
    ? chunkDescriptors
    : buildLiquidChunkDescriptors({ chunks, liquidByChunk, width, height, threshold: 0 });
  if (descriptors.length === 0) {
    return { flat: null, radial: null };
  }
  const environmentByHour = buildFramEnvironmentByHour({
    chunkDescriptors: descriptors,
    profilesByHour,
    decoded,
    cellCount,
  });
  for (const descriptor of descriptors) {
    const { chunk, liquidIn: liquidGrid, activeIndices } = descriptor;
    if (!liquidGrid || liquidGrid.length !== cellCount) {
      return { flat: null, radial: null };
    }
    const durationHours = Math.max(1 / 60, Math.max(0, Number(chunk.endHour) - Number(chunk.startHour)));
    const environmentSegments = framEnvironmentSegmentsForChunk(chunk, profilesByHour, durationHours);
    const segmentEnvironments = environmentSegments.map((segment) => environmentByHour.get(segment.hour));
    const visitCount = activeVisitCount(activeIndices, cellCount);
    for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
      const index = activeVisitIndex(activeIndices, visitIndex);
      if (Number.isNaN(flat[index])) {
        continue;
      }
      const liquid = Number(liquidGrid[index]);
      if (!Number.isFinite(liquid)) {
        flat[index] = Number.NaN;
        radial[index] = Number.NaN;
        continue;
      }
      if (liquid <= 0) {
        continue;
      }
      let flatIce = 0;
      let validWeight = 0;
      let missingEnvironment = false;
      for (let segmentIndex = 0; segmentIndex < environmentSegments.length; segmentIndex += 1) {
        const segment = environmentSegments[segmentIndex];
        const environment = segmentEnvironments[segmentIndex];
        const wetBulbC = environment?.wetBulbC?.[index];
        const windKt = environment?.windKt?.[index];
        const ilr = calculateFramIceLiquidRatio(liquid / durationHours, wetBulbC, windKt);
        if (!Number.isFinite(ilr)) {
          missingEnvironment = true;
          break;
        }
        flatIce += liquid * segment.weight * ilr;
        validWeight += segment.weight;
      }
      if (missingEnvironment || validWeight <= 0) {
        flat[index] = Number.NaN;
        radial[index] = Number.NaN;
        continue;
      }
      flat[index] += flatIce;
      radial[index] += flatIce * 0.394;
    }
  }
  // The null-vs-grid decision is descriptor-based so sparse and dense visits of
  // the same liquid grid return the same shape: a present descriptor means the
  // window holds liquid (or unknown) cells, and only the grid values — never
  // the visit mode — decide which cells carry ice.
  return { flat, radial };
}

function buildFramEnvironmentByHour({ chunkDescriptors, profilesByHour, decoded, cellCount }) {
  const indicesByHour = new Map();
  const denseHours = new Set();
  for (const descriptor of chunkDescriptors || []) {
    for (const hour of framProfileHoursForChunk(descriptor?.chunk)) {
      if (!Number.isFinite(Number(hour))) {
        continue;
      }
      if (descriptor.activeIndices === null) {
        denseHours.add(hour);
        indicesByHour.delete(hour);
        continue;
      }
      if (denseHours.has(hour)) {
        continue;
      }
      const group = indicesByHour.get(hour) || new Set();
      for (let visitIndex = 0; visitIndex < descriptor.activeIndices.length; visitIndex += 1) {
        group.add(descriptor.activeIndices[visitIndex]);
      }
      indicesByHour.set(hour, group);
    }
  }
  const out = new Map();
  for (const hour of denseHours) {
    indicesByHour.set(hour, null);
  }
  for (const [hour, activeIndexSet] of indicesByHour.entries()) {
    const profileDecoded = profilesByHour?.get(hour) || decoded || {};
    // Grid resolution is hoisted out of the dense cell loop; the per-cell
    // reads below replicate gridValue/surfaceDewpointK/profileSpeedAtLevel
    // exactly (Number conversion, finite normalization, direct-dewpoint
    // preference, and hypot order are unchanged).
    const tempGrid = resolveProfileGrid(profileDecoded, "TMP", "surface");
    const rhGrid = resolveProfileGrid(profileDecoded, "RH", "surface");
    const directDewpointGrid = profileDecoded?.dewpoint2m || null;
    const uGrid = resolveProfileGrid(profileDecoded, "UGRD", "surface");
    const vGrid = resolveProfileGrid(profileDecoded, "VGRD", "surface");
    const wetBulbC = new Float32Array(cellCount).fill(Number.NaN);
    const windKt = new Float32Array(cellCount).fill(Number.NaN);
    const visitCount = activeIndexSet === null ? cellCount : activeIndexSet.size;
    const sparseIndices = activeIndexSet === null ? null : Array.from(activeIndexSet);
    for (let visitIndex = 0; visitIndex < visitCount; visitIndex += 1) {
      const index = sparseIndices ? sparseIndices[visitIndex] : visitIndex;
      const tempRaw = tempGrid ? Number(tempGrid[index]) : Number.NaN;
      const tempK = Number.isFinite(tempRaw) ? tempRaw : Number.NaN;
      let dewpointK = directDewpointGrid ? Number(directDewpointGrid[index]) : Number.NaN;
      if (!Number.isFinite(dewpointK)) {
        const rhRaw = rhGrid ? Number(rhGrid[index]) : Number.NaN;
        dewpointK = dewpointFromTempRhK(tempK, Number.isFinite(rhRaw) ? rhRaw : Number.NaN);
      }
      const wetBulb = wetBulbTemperatureC(tempK, dewpointK);
      const uRaw = uGrid ? Number(uGrid[index]) : Number.NaN;
      const vRaw = vGrid ? Number(vGrid[index]) : Number.NaN;
      const u = Number.isFinite(uRaw) ? uRaw : Number.NaN;
      const v = Number.isFinite(vRaw) ? vRaw : Number.NaN;
      const wind = (Number.isFinite(u) && Number.isFinite(v) ? Math.hypot(u, v) : Number.NaN) * MPS_TO_KT;
      if (Number.isFinite(wetBulb)) {
        wetBulbC[index] = wetBulb;
      }
      if (Number.isFinite(wind)) {
        windKt[index] = wind;
      }
    }
    out.set(hour, { wetBulbC, windKt });
  }
  return out;
}

function framEnvironmentSegmentsForChunk(chunk, profilesByHour, durationHours) {
  const start = Math.round(Number(chunk?.startHour));
  const end = Math.round(Number(chunk?.endHour ?? chunk?.profileHour));
  const totalDuration = Math.max(1 / 60, Number(durationHours));
  let previousHour = Number.isFinite(start) ? start : end;
  const segments = [];
  for (const hour of framProfileHoursForChunk(chunk)) {
    if (!profilesByHour?.has(hour)) {
      continue;
    }
    const duration = Math.max(0, Number(hour) - previousHour);
    previousHour = Number(hour);
    if (duration <= 0) {
      continue;
    }
    segments.push({ hour, weight: duration / totalDuration });
  }
  if (segments.length === 0) {
    const fallback = Math.round(Number(chunk?.profileHour ?? end));
    if (Number.isFinite(fallback)) {
      segments.push({ hour: fallback, weight: 1 });
    }
  }
  return segments;
}

async function buildFramProfileProvenance({ chunks, profilesByHour, context }) {
  const terms = [];
  const requiredRoles = [];
  const recordedRoles = [];
  const missingRoles = [];
  for (const chunk of chunks || []) {
    const durationHours = Math.max(1 / 60, Math.max(0, Number(chunk.endHour) - Number(chunk.startHour)));
    for (const segment of framEnvironmentSegmentsForChunk(chunk, profilesByHour, durationHours)) {
      const hour = Number(segment.hour);
      const records = await getNoaaRecordsForHour(context, hour);
      const recordsByKey = {};
      addFramSurfaceRecords({
        records,
        addRecord: (key, record) => {
          recordsByKey[key] = record;
        },
      });
      const prefix = `${chunk?.key || "chunk"}:F${padHour(hour)}`;
      const requirements = [
        [`${prefix}:temperature`, Boolean(recordsByKey[PROFILE_SURFACE_DECODE_KEYS.TMP])],
        [
          `${prefix}:dewpoint-or-rh`,
          Boolean(recordsByKey[PROFILE_SURFACE_DECODE_KEYS.DPT] || recordsByKey[PROFILE_SURFACE_DECODE_KEYS.RH]),
        ],
        [`${prefix}:wind-u`, Boolean(recordsByKey[PROFILE_SURFACE_DECODE_KEYS.UGRD])],
        [`${prefix}:wind-v`, Boolean(recordsByKey[PROFILE_SURFACE_DECODE_KEYS.VGRD])],
      ];
      for (const [role, present] of requirements) {
        requiredRoles.push(role);
        if (present) {
          recordedRoles.push(role);
        } else {
          missingRoles.push(role);
        }
      }
      for (const [key, record] of Object.entries(recordsByKey)) {
        terms.push({
          hour,
          role: `fram-profile:${key}`,
          sourceKey: key,
          kind: `fram-environment:${chunk?.key || "chunk"}`,
          startHour: chunk?.startHour,
          endHour: chunk?.endHour,
          weight: segment.weight,
          record,
        });
      }
    }
  }
  return {
    terms,
    inputCoverage: {
      complete: requiredRoles.length > 0 && missingRoles.length === 0,
      requiredRoles,
      recordedRoles,
      missingRoles,
    },
  };
}

function buildFramOutputProvenance({ sourceRefs, profileProvenance = null, requiresProfile = true } = {}) {
  const liquidTerms = Array.isArray(sourceRefs) ? sourceRefs.filter(Boolean) : [];
  const profileTerms = requiresProfile && Array.isArray(profileProvenance?.terms) ? profileProvenance.terms : [];
  const profileCoverage = requiresProfile ? profileProvenance?.inputCoverage : null;
  const liquidRole = "freezing-rain-liquid-chunks";
  const requiredRoles = [
    liquidRole,
    ...(Array.isArray(profileCoverage?.requiredRoles) ? profileCoverage.requiredRoles : []),
  ];
  const recordedRoles = [
    ...(liquidTerms.length > 0 ? [liquidRole] : []),
    ...(Array.isArray(profileCoverage?.recordedRoles) ? profileCoverage.recordedRoles : []),
  ];
  const missingRoles = [
    ...(liquidTerms.length > 0 ? [] : [liquidRole]),
    ...(Array.isArray(profileCoverage?.missingRoles) ? profileCoverage.missingRoles : []),
  ];
  return {
    terms: [...liquidTerms, ...profileTerms],
    inputCoverage: {
      complete:
        liquidTerms.length > 0 && (!requiresProfile || profileCoverage?.complete === true) && missingRoles.length === 0,
      requiredRoles,
      recordedRoles,
      missingRoles,
    },
  };
}

function calculateFramIceLiquidRatio(precipRateInHr, wetBulbC, windKt) {
  const rate = Number(precipRateInHr);
  const wetBulb = Number(wetBulbC);
  const wind = Number(windKt);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(wetBulb) || !Number.isFinite(wind)) {
    return Number.NaN;
  }
  const rateForRegression = Math.max(0.02, rate);
  const wetBulbForRegression = Math.max(-7, wetBulb);
  const ilrP = 0.1395 * Math.pow(rateForRegression, -0.541);
  const ilrTw =
    -0.0071 * wetBulbForRegression * wetBulbForRegression * wetBulbForRegression -
    0.1039 * wetBulbForRegression * wetBulbForRegression -
    0.3904 * wetBulbForRegression +
    0.5545;
  const ilrV = 0.0014 * wind * wind + 0.0027 * wind + 0.7574;
  let ilr;
  if (wetBulbForRegression > -0.35) {
    ilr = 0.7 * ilrP + 0.29 * ilrTw + 0.01 * ilrV;
  } else if (wind > 12) {
    ilr = 0.73 * ilrP + 0.01 * ilrTw + 0.26 * ilrV;
  } else {
    ilr = 0.79 * ilrP + 0.2 * ilrTw + 0.01 * ilrV;
  }
  return Number.isFinite(ilr) ? Math.max(0, ilr) : Number.NaN;
}

module.exports = {
  addFramSurfaceRecords,
  buildFramEnvironmentByHour,
  buildFramIceGrids,
  buildFramIceGridsFromChunks,
  buildFramOutputProvenance,
  buildFramProfileProvenance,
  calculateFramIceLiquidRatio,
  decodeFramSurfaceGridsForHour,
  decodeFramSurfaceProfiles,
  framEnvironmentSegmentsForChunk,
  framProfileHoursForChunk,
};
