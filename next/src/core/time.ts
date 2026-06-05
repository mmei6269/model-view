import type { ValidTimeIso } from "../types";

export function normalizeIsoHour(value: string): string {
  const raw = String(value || "")
    .trim()
    .replace(" ", "T");
  if (!raw) {
    return raw;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(raw)) {
    return raw;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(raw)) {
    return raw.replace("Z", ":00Z");
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    return `${raw}:00Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(raw)) {
    return `${raw}:00:00Z`;
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    return raw;
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function toEpochMs(value: string): number {
  const date = new Date(normalizeIsoHour(String(value || "")));
  return Number.isFinite(date.getTime()) ? date.getTime() : Number.NaN;
}

export function findNearestValidTime(targetIso: ValidTimeIso, candidates: ValidTimeIso[]): ValidTimeIso {
  if (candidates.length === 0) {
    return targetIso;
  }
  const targetMs = toEpochMs(targetIso);
  if (!Number.isFinite(targetMs)) {
    return candidates[0];
  }

  let best = candidates[0];
  let bestDelta = Math.abs(toEpochMs(best) - targetMs);
  for (const candidate of candidates.slice(1)) {
    const delta = Math.abs(toEpochMs(candidate) - targetMs);
    if (delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

export function formatValidUtcLabel(value: string | null): string {
  if (!value) {
    return "--";
  }
  const date = new Date(normalizeIsoHour(value));
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}z`;
}

export function formatValidUtcShort(value: string | null): string {
  if (!value) {
    return "--";
  }
  const date = new Date(normalizeIsoHour(value));
  if (!Number.isFinite(date.getTime())) {
    return value;
  }
  const hh = String(date.getUTCHours()).padStart(2, "0");
  return `${hh}z`;
}
