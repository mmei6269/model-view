"use strict";

const MPS_TO_KT = 1.943844;
const MPS_TO_MPH = 2.2369362920544;
const MM_TO_IN = 1 / 25.4;
const M_TO_IN = 39.3701;

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return Number.NaN;
  }
  return Math.max(min, Math.min(max, num));
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(num)));
}

function lerp(left, right, t) {
  return left + (right - left) * t;
}

function incrementProfileCounter(profile, key) {
  if (!profile || !key) {
    return;
  }
  profile[key] = (Number(profile[key]) || 0) + 1;
}

function incrementDecodeSessionCounter(session, key) {
  if (!session?.counters || !key) {
    return;
  }
  session.counters[key] = (Number(session.counters[key]) || 0) + 1;
  incrementProfileCounter(session.profile, key);
}

module.exports = {
  MPS_TO_KT,
  MPS_TO_MPH,
  MM_TO_IN,
  M_TO_IN,
  clamp,
  clamp01,
  clampInt,
  incrementDecodeSessionCounter,
  incrementProfileCounter,
  lerp,
};
