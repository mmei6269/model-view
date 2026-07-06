export const TIMEZONE_STORAGE_KEY = "modelview.timezone.v1";

export const UTC_TIME_ZONE = "UTC";
// Sentinel resolved at runtime to the browser's IANA zone.
export const LOCAL_TIME_ZONE = "local";

export interface TimeZoneOption {
  value: string;
  label: string;
}

// UTC stays first/default so the app keeps its Zulu-only behavior until the
// analyst opts into a local zone. NOAA models are US-centric, so the curated
// list favors the CONUS/OConUS zones plus a browser-local shortcut.
export const TIMEZONE_OPTIONS: readonly TimeZoneOption[] = [
  { value: UTC_TIME_ZONE, label: "UTC (Zulu)" },
  { value: LOCAL_TIME_ZONE, label: "Local" },
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
];

const KNOWN_TIMEZONE_VALUES = new Set(TIMEZONE_OPTIONS.map((option) => option.value));

function isSupportedIanaZone(value: string): boolean {
  try {
    // Throws RangeError for unknown zones in every ICU build we target.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZoneSetting(value: unknown): string {
  if (typeof value !== "string") {
    return UTC_TIME_ZONE;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return UTC_TIME_ZONE;
  }
  if (KNOWN_TIMEZONE_VALUES.has(trimmed)) {
    return trimmed;
  }
  // Accept any previously stored IANA zone so custom selections survive reloads.
  return isSupportedIanaZone(trimmed) ? trimmed : UTC_TIME_ZONE;
}

// Resolves a stored setting into a concrete zone usable by Intl. The "local"
// sentinel becomes the browser zone; everything else passes through.
export function resolveTimeZone(setting: string): string {
  if (!setting || setting === UTC_TIME_ZONE) {
    return UTC_TIME_ZONE;
  }
  if (setting === LOCAL_TIME_ZONE) {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || UTC_TIME_ZONE;
    } catch {
      return UTC_TIME_ZONE;
    }
  }
  return setting;
}

export function loadStoredTimeZone(): string {
  if (typeof window === "undefined") {
    return UTC_TIME_ZONE;
  }
  try {
    return normalizeTimeZoneSetting(window.localStorage.getItem(TIMEZONE_STORAGE_KEY));
  } catch {
    return UTC_TIME_ZONE;
  }
}

export function storeTimeZone(setting: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(TIMEZONE_STORAGE_KEY, normalizeTimeZoneSetting(setting));
  } catch {
    // Ignore private-mode and quota failures; timezone choice should never block the app.
  }
}
