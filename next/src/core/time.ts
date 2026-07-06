import { UTC_TIME_ZONE } from "../config/timezone";
import type { FrameHourStatus, ValidTimeIso } from "../types";

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

// Initial-frame pick (no prior selection): an explicit preferred hour (the URL
// ?hour= param) wins when it parses; otherwise the frame nearest to now.
// Candidates known to be unavailable/errored are skipped when any usable
// alternative exists, so the default never lands on a frame that cannot render.
export function pickInitialValidTime(
  preferredIso: ValidTimeIso | null,
  candidates: ValidTimeIso[],
  statusByValidTime?: Partial<Record<ValidTimeIso, FrameHourStatus>>,
): ValidTimeIso {
  const usable = statusByValidTime
    ? candidates.filter((candidate) => {
        const status = statusByValidTime[candidate];
        return status !== "unavailable" && status !== "error";
      })
    : candidates;
  const pool = usable.length > 0 ? usable : candidates;
  const preferred = preferredIso && Number.isFinite(toEpochMs(preferredIso)) ? preferredIso : null;
  return findNearestValidTime(preferred ?? new Date().toISOString(), pool);
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

function localDateParts(value: string | null, timeZone: string): Record<string, string> | null {
  if (!value || !timeZone || timeZone === UTC_TIME_ZONE) {
    return null;
  }
  const date = new Date(normalizeIsoHour(value));
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(date);
    const out: Record<string, string> = {};
    for (const part of parts) {
      out[part.type] = part.value;
    }
    return out;
  } catch {
    return null;
  }
}

// Full local label, e.g. "2026-06-14 14:00 EDT". The date is included so a
// local day that differs from the UTC day stays unambiguous. Returns null for
// UTC (no local form needed) or unparseable input.
export function formatValidLocalLabel(value: string | null, timeZone: string): string | null {
  const parts = localDateParts(value, timeZone);
  if (!parts) {
    return null;
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

// Compact local label for tight chrome (timeline endpoints), e.g. "14:00 EDT".
export function formatValidLocalShort(value: string | null, timeZone: string): string | null {
  const parts = localDateParts(value, timeZone);
  if (!parts) {
    return null;
  }
  return `${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

// Primary valid-time label. Always keeps the Zulu form; appends the local time
// when a non-UTC zone is selected, e.g. "2026-06-14 18z · 14:00 EDT".
export function formatValidLabel(value: string | null, timeZone: string): string {
  const utc = formatValidUtcLabel(value);
  const local = formatValidLocalLabel(value, timeZone);
  return local ? `${utc} · ${local}` : utc;
}
