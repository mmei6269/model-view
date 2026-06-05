import type { Map as LeafletMap } from "leaflet";
import { SYNOPTIC_ISOBAR_PANE, SYNOPTIC_THICKNESS_PANE } from "../../config/layers";
import { bucketNumber, getZoomBucketId, SYNOPTIC_STYLE } from "../../config/synopticStyle";
import { withDecodedVectorLinePoints } from "../../core/vector-encoding";
import type { SynopticCenters, SynopticVectorLabel, SynopticVectorLine, SynopticVectorPayload } from "../../types";

export interface SynopticLinePaint {
  color: string;
  weight: number;
  opacity: number;
  dashArray?: string;
  haloColor?: string;
  haloWeight?: number;
  haloOpacity?: number;
}

export interface SynopticLabelPaint {
  color: string;
  fontSize: number;
  fontWeight: number;
}

export interface CenterVisual {
  markerSize: number;
  valueSize: number;
  valueOffset: number;
  highColor: string;
  lowColor: string;
}

export function stitchSynopticSegments(lines: SynopticVectorLine[]): SynopticVectorLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [];
  }
  const existingPolylines: SynopticVectorLine[] = [];
  const rawSegments: SynopticVectorLine[] = [];
  for (const line of lines) {
    if (!Array.isArray(line.points) || line.points.length < 2) {
      continue;
    }
    if (line.points.length > 2) {
      existingPolylines.push({
        ...line,
        points: dedupeConsecutivePoints(line.points),
      });
    } else {
      rawSegments.push(line);
    }
  }
  if (rawSegments.length === 0) {
    return existingPolylines;
  }

  const groups = new Map<string, SynopticVectorLine[]>();
  for (const line of rawSegments) {
    if (!Array.isArray(line.points) || line.points.length < 2) {
      continue;
    }
    const dashKey = Array.isArray(line.dash) ? line.dash.join(",") : "";
    const key = `${String(line.kind || "line")}|${Number(line.value ?? Number.NaN)}|${String(line.color || "")}|${dashKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(line);
    } else {
      groups.set(key, [line]);
    }
  }

  const stitched: SynopticVectorLine[] = [];
  for (const segments of groups.values()) {
    const chains: [number, number][][] = [];
    for (const segment of segments) {
      const points = segment.points;
      if (!Array.isArray(points) || points.length < 2) {
        continue;
      }
      const start = points[0];
      const end = points[points.length - 1];
      if (!isFinitePoint(start) || !isFinitePoint(end)) {
        continue;
      }

      let startChainIndex = -1;
      let startAtHead = false;
      let endChainIndex = -1;
      let endAtHead = false;
      for (let index = 0; index < chains.length; index += 1) {
        const chain = chains[index];
        if (pointsNear(chain[0], start)) {
          startChainIndex = index;
          startAtHead = true;
        } else if (pointsNear(chain[chain.length - 1], start)) {
          startChainIndex = index;
          startAtHead = false;
        }
        if (pointsNear(chain[0], end)) {
          endChainIndex = index;
          endAtHead = true;
        } else if (pointsNear(chain[chain.length - 1], end)) {
          endChainIndex = index;
          endAtHead = false;
        }
      }

      if (startChainIndex === -1 && endChainIndex === -1) {
        chains.push([start, end]);
        continue;
      }
      if (startChainIndex !== -1 && endChainIndex === -1) {
        const chain = chains[startChainIndex];
        if (startAtHead) {
          chain.unshift(end);
        } else {
          chain.push(end);
        }
        continue;
      }
      if (startChainIndex === -1 && endChainIndex !== -1) {
        const chain = chains[endChainIndex];
        if (endAtHead) {
          chain.unshift(start);
        } else {
          chain.push(start);
        }
        continue;
      }
      if (startChainIndex === endChainIndex) {
        const chain = chains[startChainIndex];
        if (startAtHead && !endAtHead) {
          chain.unshift(end);
        } else if (!startAtHead && endAtHead) {
          chain.push(end);
        }
        continue;
      }

      const first = chains[startChainIndex];
      const second = chains[endChainIndex];
      const merged = mergeChains(first, second, startAtHead, endAtHead);
      const keep = Math.min(startChainIndex, endChainIndex);
      const drop = Math.max(startChainIndex, endChainIndex);
      chains[keep] = merged;
      chains.splice(drop, 1);
    }

    const template = segments[0];
    for (const chain of chains) {
      if (chain.length < 2) {
        continue;
      }
      stitched.push({
        ...template,
        points: dedupeConsecutivePoints(chain),
      });
    }
  }
  return [...existingPolylines, ...stitched];
}

export function resolveSynopticLinePaint(
  line: SynopticVectorLine,
  zoom: number,
  useFallbackStyle: boolean,
): SynopticLinePaint | null {
  const style = SYNOPTIC_STYLE;
  const kind = String(line.kind || "");
  const rawDash = Array.isArray(line.dash) ? line.dash.join(" ") : undefined;

  if (useFallbackStyle || !kind) {
    const fallbackWeight = typeof line.width === "number" ? line.width : 1.4;
    const fallbackOpacity = typeof line.alpha === "number" ? line.alpha : 0.75;
    return {
      color: line.color || "#111111",
      weight: fallbackWeight,
      opacity: fallbackOpacity,
      dashArray: rawDash,
    };
  }

  if (kind === "thickness-minor" && zoom < Number(style?.thickness?.showMinorAtZoomGte || 4)) {
    return null;
  }

  if (kind === "mslp-major" || kind === "mslp-minor") {
    const specificConfig = kind === "mslp-major" ? style?.mslp?.major : style?.mslp?.minor;
    const config = specificConfig || style?.mslp?.uniform;
    const baseWeight = Number(config?.widthPx || line.width || (kind === "mslp-major" ? 1.2 : 1.0));
    return {
      color: String(config?.color || "#171717"),
      weight: baseWeight,
      opacity: Number(config?.alpha || line.alpha || 0.74),
      dashArray: rawDash,
      haloColor: String(config?.haloColor || "#FFFFFF"),
      haloWeight: Number(config?.haloWidthPx || Math.max(1.5, baseWeight + 0.5)),
      haloOpacity: Number(config?.haloAlpha || 0.46),
    };
  }

  if (kind === "thickness-major" || kind === "thickness-minor" || kind === "thickness-540") {
    const config =
      kind === "thickness-540"
        ? style?.thickness?.emphasis
        : kind === "thickness-major"
          ? style?.thickness?.major
          : style?.thickness?.minor;
    const emphasisDam = Number(style?.thickness?.emphasisDam || 540);
    const value = Number(line.value);
    const computedColor =
      kind === "thickness-540"
        ? String(style?.thickness?.boundaryColor || "#6A1B9A")
        : value < emphasisDam
          ? String(style?.thickness?.coldColor || "#0072B2")
          : String(style?.thickness?.warmColor || "#D7302F");
    const dashArray = Array.isArray(config?.dash) && config.dash.length > 0 ? config.dash.join(" ") : rawDash;
    const weight = Number(config?.widthPx || line.width || (kind === "thickness-major" ? 1.6 : 1)) + 0.1;
    return {
      color: computedColor,
      weight,
      opacity: Number(config?.alpha || line.alpha || (kind === "thickness-major" ? 0.72 : 0.6)),
      dashArray,
      haloColor: "transparent",
      haloWeight: 0,
      haloOpacity: 0,
    };
  }

  return {
    color: line.color || "#111111",
    weight: typeof line.width === "number" ? line.width : 1.4,
    opacity: typeof line.alpha === "number" ? line.alpha : 0.75,
    dashArray: rawDash,
  };
}

export function resolveSynopticLabelPaint(
  label: SynopticVectorLabel,
  zoom: number,
  useFallbackStyle: boolean,
): SynopticLabelPaint | null {
  const style = SYNOPTIC_STYLE;
  const kind = String(label.kind || "");

  if (useFallbackStyle || !kind) {
    return {
      color: label.color || "#111111",
      fontSize: 12,
      fontWeight: 700,
    };
  }

  const bucketId = getZoomBucketId(zoom);
  const mslpFontSize = Number(style?.mslp?.labels?.fontSizePxByBucket?.[bucketId] || 12);
  const thicknessFontSize = Number(style?.thickness?.labels?.fontSizePxByBucket?.[bucketId] || 12);
  const isThickness = kind.startsWith("thickness");
  const thicknessValue = Number.parseInt(String(label.text || "").replace(/[^0-9.-]/g, ""), 10);
  const emphasisDam = Number(style?.thickness?.emphasisDam || 540);
  const fillColor = isThickness
    ? Number.isFinite(thicknessValue) && Math.round(thicknessValue) === Math.round(emphasisDam)
      ? String(style?.thickness?.boundaryColor || "#6A1B9A")
      : thicknessValue < emphasisDam
        ? String(style?.thickness?.coldColor || "#0072B2")
        : String(style?.thickness?.warmColor || "#D7302F")
    : String(style?.mslp?.labels?.fillColor || "#111111");
  const fontWeight = isThickness
    ? Number(style?.thickness?.labels?.fontWeight || 700)
    : Number(style?.mslp?.labels?.fontWeight || 700);

  return {
    color: fillColor,
    fontSize: isThickness ? thicknessFontSize : mslpFontSize,
    fontWeight,
  };
}

export function resolveCenterVisual(zoom: number): CenterVisual {
  const style = SYNOPTIC_STYLE;
  return {
    markerSize: bucketNumber(style?.centers?.letterSizePxByBucket, zoom, 24),
    valueSize: bucketNumber(style?.centers?.valueSizePxByBucket, zoom, 11) + 1,
    valueOffset: Number(style?.centers?.valueOffsetPx || 2),
    highColor: String(style?.centers?.highColor || "#0072B2"),
    lowColor: String(style?.centers?.lowColor || "#FF4545"),
  };
}

export function synopticLinePriority(kind?: string): number {
  const value = String(kind || "");
  if (value === "thickness-minor") return 10;
  if (value === "thickness-major") return 20;
  if (value === "thickness-540") return 30;
  if (value === "mslp-minor") return 40;
  if (value === "mslp-major") return 50;
  return 60;
}

export function shouldRenderSynopticKind(
  kind: string | undefined,
  showIsobars: boolean,
  showThickness: boolean,
): boolean {
  const value = String(kind || "");
  if (!value) {
    return showIsobars || showThickness;
  }
  if (value.startsWith("mslp")) {
    return showIsobars;
  }
  if (value.startsWith("thickness")) {
    return showThickness;
  }
  return showIsobars || showThickness;
}

export function synopticLabelPriority(kind?: string): number {
  const value = String(kind || "");
  if (value === "thickness-540") return 10;
  if (value === "mslp-major") return 20;
  if (value === "thickness-major") return 30;
  if (value.includes("minor")) return 40;
  return 50;
}

export function isLineRenderableOnViewport(map: LeafletMap, latLngs: [number, number][], zoom: number): boolean {
  if (latLngs.length < 2) {
    return false;
  }
  let distance = 0;
  for (let index = 1; index < latLngs.length; index += 1) {
    const prev = map.latLngToContainerPoint(latLngs[index - 1]);
    const next = map.latLngToContainerPoint(latLngs[index]);
    const dx = prev.x - next.x;
    const dy = prev.y - next.y;
    distance += Math.sqrt(dx * dx + dy * dy);
  }
  const minDistance = zoom >= 8 ? 2 : zoom >= 5 ? 3 : 4;
  return distance >= minDistance;
}

export function smoothSynopticPolyline(points: [number, number][], kind?: string, zoom = 5): [number, number][] {
  if (!Array.isArray(points) || points.length < 3) {
    return points;
  }

  const kindValue = String(kind || "");
  const isSynopticCurve = kindValue.startsWith("thickness") || kindValue.startsWith("mslp");
  const isClosed = pointsNear(points[0], points[points.length - 1], 1e-6);
  const base = isClosed ? points.slice(0, -1) : [...points];
  if (base.length < 3) {
    return points;
  }

  let iterations = 0;
  if (isSynopticCurve) {
    const longLine = base.length >= 72;
    iterations = zoom >= 7 ? 2 : 1;
    if (zoom >= 10 && longLine) {
      iterations = 3;
    }
    if (zoom <= 5 && longLine) {
      iterations = 2;
    }
    if (base.length >= 900) {
      iterations = Math.min(iterations, 1);
    } else if (base.length >= 500) {
      iterations = Math.min(iterations, 2);
    }
  }

  let current = base;
  for (let pass = 0; pass < iterations; pass += 1) {
    if (current.length < 3) {
      break;
    }
    const next: [number, number][] = [];
    const segmentCount = isClosed ? current.length : current.length - 1;
    if (!isClosed) {
      next.push(current[0]);
    }

    for (let index = 0; index < segmentCount; index += 1) {
      const a = current[index];
      const b = current[(index + 1) % current.length];
      const q: [number, number] = [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]];
      const r: [number, number] = [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]];
      next.push(q, r);
    }

    if (!isClosed) {
      next.push(current[current.length - 1]);
    }
    current = next;
  }

  if (isClosed) {
    return [...current, current[0]];
  }
  return current;
}

export function resolveLabelSpacingPx(kind: string | undefined, zoom: number): number {
  const style = SYNOPTIC_STYLE;
  const bucketId = getZoomBucketId(zoom);
  const value = String(kind || "");
  if (value.startsWith("thickness")) {
    return Number(style?.thickness?.labels?.repeatDistancePxByBucket?.[bucketId] || 220) * 0.45;
  }
  return Number(style?.mslp?.labels?.minSpacingPxByBucket?.[bucketId] || 110);
}

export function resolveSynopticCenters(
  vectorCenters: SynopticCenters | null | undefined,
  fallbackCenters: SynopticCenters | null | undefined,
): SynopticCenters | null {
  if (hasSynopticCenters(vectorCenters)) {
    return vectorCenters as SynopticCenters;
  }
  if (hasSynopticCenters(fallbackCenters)) {
    return fallbackCenters as SynopticCenters;
  }
  if (vectorCenters) {
    return vectorCenters;
  }
  if (fallbackCenters) {
    return fallbackCenters;
  }
  return null;
}

export function synopticPaneForKind(kind?: string): string {
  const value = String(kind || "");
  if (value.startsWith("thickness")) {
    return SYNOPTIC_THICKNESS_PANE;
  }
  if (value.startsWith("mslp")) {
    return SYNOPTIC_ISOBAR_PANE;
  }
  return SYNOPTIC_ISOBAR_PANE;
}

export function normalizeSynopticVectorPayload(input: SynopticVectorPayload | null): Required<SynopticVectorPayload> {
  const source = input || {};
  const isobarsLines: SynopticVectorLine[] = [];
  const thicknessLines: SynopticVectorLine[] = [];
  const isobarsLabels: SynopticVectorLabel[] = [];
  const thicknessLabels: SynopticVectorLabel[] = [];

  const pushLine = (entry: SynopticVectorLine) => {
    const kind = String(entry?.kind || "");
    if (kind.startsWith("thickness")) {
      thicknessLines.push(entry);
    } else {
      isobarsLines.push(entry);
    }
  };

  const pushLabel = (entry: SynopticVectorLabel) => {
    const kind = String(entry?.kind || "");
    if (kind.startsWith("thickness")) {
      thicknessLabels.push(entry);
    } else {
      isobarsLabels.push(entry);
    }
  };

  for (const entry of source.isobars?.lines || []) {
    const line = entry ? withDecodedVectorLinePoints(entry) : null;
    if (line && Array.isArray(line.points) && line.points.length >= 2) {
      isobarsLines.push(line);
    }
  }
  for (const entry of source.thickness?.lines || []) {
    const line = entry ? withDecodedVectorLinePoints(entry) : null;
    if (line && Array.isArray(line.points) && line.points.length >= 2) {
      thicknessLines.push(line);
    }
  }
  for (const entry of source.isobars?.labels || []) {
    if (entry && typeof entry.text === "string" && Number.isFinite(entry.lat) && Number.isFinite(entry.lon)) {
      isobarsLabels.push(entry);
    }
  }
  for (const entry of source.thickness?.labels || []) {
    if (entry && typeof entry.text === "string" && Number.isFinite(entry.lat) && Number.isFinite(entry.lon)) {
      thicknessLabels.push(entry);
    }
  }

  // Backward compatibility for pre-v3 synoptic vector payloads.
  for (const entry of source.lines || []) {
    const line = entry ? withDecodedVectorLinePoints(entry) : null;
    if (line && Array.isArray(line.points) && line.points.length >= 2) {
      pushLine(line);
    }
  }
  for (const entry of source.labels || []) {
    if (entry && typeof entry.text === "string" && Number.isFinite(entry.lat) && Number.isFinite(entry.lon)) {
      pushLabel(entry);
    }
  }

  const centers: SynopticCenters = {
    highs: Array.isArray(source.centers?.highs)
      ? source.centers.highs.filter(
          (entry) => Number.isFinite(entry?.lat) && Number.isFinite(entry?.lon) && Number.isFinite(entry?.valueHpa),
        )
      : [],
    lows: Array.isArray(source.centers?.lows)
      ? source.centers.lows.filter(
          (entry) => Number.isFinite(entry?.lat) && Number.isFinite(entry?.lon) && Number.isFinite(entry?.valueHpa),
        )
      : [],
  };

  return {
    styleVersion: String(source.styleVersion || ""),
    isobars: {
      lines: isobarsLines,
      labels: isobarsLabels,
    },
    thickness: {
      lines: thicknessLines,
      labels: thicknessLabels,
    },
    centers,
    lines: [...isobarsLines, ...thicknessLines],
    labels: [...isobarsLabels, ...thicknessLabels],
  };
}

function mergeChains(
  first: [number, number][],
  second: [number, number][],
  firstAtHead: boolean,
  secondAtHead: boolean,
): [number, number][] {
  const a = [...first];
  const b = [...second];
  if (firstAtHead && secondAtHead) {
    return [...reversePoints(b), ...a];
  }
  if (firstAtHead && !secondAtHead) {
    return [...b, ...a];
  }
  if (!firstAtHead && secondAtHead) {
    return [...a, ...b];
  }
  return [...a, ...reversePoints(b)];
}

function reversePoints(points: [number, number][]): [number, number][] {
  return [...points].reverse();
}

function dedupeConsecutivePoints(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const point of points) {
    if (!out.length || !pointsNear(out[out.length - 1], point)) {
      out.push(point);
    }
  }
  return out;
}

function pointsNear(a: [number, number], b: [number, number], tolerance = 1e-4): boolean {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

function isFinitePoint(point: [number, number]): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function hasSynopticCenters(centers: SynopticCenters | null | undefined): boolean {
  if (!centers) {
    return false;
  }
  const highs = Array.isArray(centers.highs) ? centers.highs.length : 0;
  const lows = Array.isArray(centers.lows) ? centers.lows.length : 0;
  return highs + lows > 0;
}
