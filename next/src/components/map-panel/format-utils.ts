import type { FrameHourStatus } from "../../types";

export function hourChipClass(status: FrameHourStatus, selected: boolean): string {
  const base = "rounded px-1 py-0.5 text-center text-[10px] font-mono border transition-colors duration-150";
  const selectedClass = selected ? " ring-1 ring-cyan-300" : "";
  if (status === "loaded") {
    return `${base} border-cyan-400/30 bg-cyan-500/20 text-cyan-200${selectedClass}`;
  }
  if (status === "loading") {
    return `${base} border-sky-400/30 bg-sky-500/20 text-sky-200${selectedClass}`;
  }
  if (status === "error") {
    return `${base} border-rose-400/30 bg-rose-500/20 text-rose-200${selectedClass}`;
  }
  if (status === "unavailable") {
    return `${base} border-white/[0.06] bg-slate-900 text-slate-500${selectedClass}`;
  }
  return `${base} border-white/[0.06] bg-white/[0.04] text-slate-400${selectedClass}`;
}

export function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10) {
    return value.toFixed(0);
  }
  if (abs >= 1) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

export function formatMaybe(value: number | null, unit: string, digits: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${(value as number).toFixed(digits)} ${unit}`;
}

export function formatCoordinate(value: number, positive: string, negative: string): string {
  const suffix = value >= 0 ? positive : negative;
  return `${Math.abs(value).toFixed(2)}°${suffix}`;
}
