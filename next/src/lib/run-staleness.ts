export type RunStalenessLevel = "fresh" | "aging" | "stale";

export interface RunStaleness {
  ageHours: number | null;
  level: RunStalenessLevel;
  newerLikely: boolean;
}

// Pure client computation from the manifest's referenceTime plus static cycle
// cadence. No network. `newerLikely` is true once a full cycle interval has
// elapsed past this run's reference time (a newer cycle should be published),
// scaled by the model's own cadence (hourly HRRR flips fast; 6-hourly GFS slow).
export function computeRunStaleness({
  referenceTime,
  cycleHours,
  now = Date.now(),
}: {
  referenceTime?: string | null;
  cycleHours?: number[] | null;
  now?: number;
}): RunStaleness {
  const refMs = referenceTime ? Date.parse(referenceTime) : NaN;
  if (!Number.isFinite(refMs)) {
    return { ageHours: null, level: "fresh", newerLikely: false };
  }
  const ageHours = Math.max(0, (now - refMs) / 3_600_000);
  const cadence = cadenceHours(cycleHours);
  // Amber once past one cadence interval, red past two — the window in which a
  // newer run should exist (plus provider publish latency headroom).
  const level: RunStalenessLevel = ageHours >= cadence * 2 ? "stale" : ageHours >= cadence ? "aging" : "fresh";
  const newerLikely = ageHours >= cadence;
  return { ageHours, level, newerLikely };
}

function cadenceHours(cycleHours?: number[] | null): number {
  if (!Array.isArray(cycleHours) || cycleHours.length === 0) {
    return 6; // conservative default cadence
  }
  if (cycleHours.length === 1) {
    return 24;
  }
  const sorted = [...cycleHours].sort((a, b) => a - b);
  let minGap = 24 - (sorted[sorted.length - 1] - sorted[0]);
  for (let i = 1; i < sorted.length; i += 1) {
    minGap = Math.min(minGap, sorted[i] - sorted[i - 1]);
  }
  return minGap > 0 ? minGap : 6;
}
