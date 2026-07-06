import { UTC_TIME_ZONE } from "../config/timezone";
import { normalizeIsoHour } from "../core/time";
import type { ValidTimeIso } from "../types";

export interface DayBoundaryTick {
  index: number;
  positionPercent: number;
  label: string;
}

// Calendar day of a frame in the target zone: a comparison key plus a compact
// display label ("Jul 2"). Returns null for unparseable timestamps; falls back
// to UTC when the zone is unknown to ICU (mirrors localDateParts in time.ts).
function calendarDay(value: ValidTimeIso, timeZone: string): { key: string; label: string } | null {
  const date = new Date(normalizeIsoHour(value));
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { ...options, timeZone }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { ...options, timeZone: UTC_TIME_ZONE }).formatToParts(date);
  }
  const byType: Record<string, string> = {};
  for (const part of parts) {
    byType[part.type] = part.value;
  }
  if (!byType.year || !byType.month || !byType.day) {
    return null;
  }
  return { key: `${byType.year}-${byType.month}-${byType.day}`, label: `${byType.month} ${byType.day}` };
}

// Pure helper: one tick at each frame whose calendar day (in the selected
// zone, else UTC) differs from the previous frame's. positionPercent uses the
// same proportional (index / (len - 1)) * 100 mapping as the track fill, so
// ticks line up with the frames they mark.
export function computeDayBoundaryTicks(validTimes: ValidTimeIso[], timeZone: string): DayBoundaryTick[] {
  if (!Array.isArray(validTimes) || validTimes.length < 2) {
    return [];
  }
  const zone = timeZone && timeZone !== UTC_TIME_ZONE ? timeZone : UTC_TIME_ZONE;
  const ticks: DayBoundaryTick[] = [];
  let previousKey = calendarDay(validTimes[0], zone)?.key ?? null;
  for (let index = 1; index < validTimes.length; index += 1) {
    const day = calendarDay(validTimes[index], zone);
    if (!day) {
      continue;
    }
    if (previousKey !== null && day.key !== previousKey) {
      ticks.push({
        index,
        positionPercent: (index / (validTimes.length - 1)) * 100,
        label: day.label,
      });
    }
    previousKey = day.key;
  }
  return ticks;
}
