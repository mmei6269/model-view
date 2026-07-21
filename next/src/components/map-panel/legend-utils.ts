import type { LayerLegendConfig } from "../../config/layers";

type PrecipRateLegendRow = NonNullable<LayerLegendConfig["precipRateTypeLegend"]>[number];

export function buildPhysicalRateLegend(row: PrecipRateLegendRow): {
  domainStart: number;
  domainEnd: number;
  segments: Array<{ bin: PrecipRateLegendRow["bins"][number]; left: number; width: number }>;
  tickPositions: number[];
  endCap: PrecipRateLegendRow["bins"][number] | null;
} | null {
  const physicalBins = row.bins
    .map((bin) => ({ bin, start: finiteOptionalNumber(bin.minRate), end: finiteOptionalNumber(bin.maxRate) }))
    .filter(
      (entry): entry is { bin: PrecipRateLegendRow["bins"][number]; start: number; end: number } =>
        entry.start !== null && entry.end !== null && entry.end > entry.start && Number(entry.bin.color?.[3]) > 0,
    );
  if (physicalBins.length === 0) {
    return null;
  }
  const domainStart = Math.min(...physicalBins.map((entry) => entry.start));
  const domainEnd = Math.max(...physicalBins.map((entry) => entry.end));
  const span = domainEnd - domainStart;
  if (!(span > 0)) {
    return null;
  }
  const endCap =
    row.bins
      .filter(
        (bin) =>
          finiteOptionalNumber(bin.minRate) !== null &&
          finiteOptionalNumber(bin.maxRate) === null &&
          Number(bin.color?.[3]) > 0,
      )
      .sort((left, right) => Number(right.minRate) - Number(left.minRate))[0] || null;
  return {
    domainStart,
    domainEnd,
    segments: physicalBins.map(({ bin, start, end }) => ({
      bin,
      left: (start - domainStart) / span,
      width: (end - start) / span,
    })),
    tickPositions: (row.tickLabels || []).map((tick) => Math.max(0, Math.min(1, (tick - domainStart) / span))),
    endCap,
  };
}

function finiteOptionalNumber(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
