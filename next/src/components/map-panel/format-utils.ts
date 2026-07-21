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
  if (!Number.isFinite(value)) {
    return "--";
  }
  // Integer ticks render bare ("0", not "0.00") so mixed-magnitude tick rows
  // read consistently; fractional ticks keep just enough precision.
  if (Number.isInteger(value)) {
    return String(value);
  }
  const abs = Math.abs(value);
  const decimals = abs >= 10 ? 0 : abs >= 1 ? 1 : 2;
  return value
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

// Display-only unit normalization: catalog units are plain ASCII data (F,
// m2/s2, x10^-5 s^-1, ...) shared with the render pipeline and public mirror,
// so prettifying happens here at the presentation edge only.
const UNIT_DISPLAY: Record<string, string> = {
  F: "°F",
  "°F": "°F",
  C: "°C",
  "°C": "°C",
  "C/km": "°C/km",
  "C/100km/3hr": "°C/100km/3hr",
  "m2/s2": "m²/s²",
  "x10^-5 s^-1": "10⁻⁵ s⁻¹",
};

export function formatUnitDisplay(unit: string | null | undefined): string {
  const raw = String(unit ?? "").trim();
  return UNIT_DISPLAY[raw] ?? raw;
}

export function formatCoordinate(value: number, positive: string, negative: string): string {
  const suffix = value >= 0 ? positive : negative;
  return `${Math.abs(value).toFixed(2)}°${suffix}`;
}
