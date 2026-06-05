import L, { type LatLng, type Map as LeafletMap } from "leaflet";
import { getZoomBucketId, SYNOPTIC_STYLE } from "../../config/synopticStyle";
import type { SynopticCenter, SynopticCenters, SynopticVectorLabel } from "../../types";
import {
  resolveLabelSpacingPx,
  resolveSynopticLabelPaint,
  synopticLabelPriority,
  type SynopticLabelPaint,
} from "./synoptic-utils";

export interface RenderableSynopticLabel extends SynopticVectorLabel {
  style: SynopticLabelPaint;
}

export interface RenderableSynopticCenter {
  center: SynopticCenter;
  kind: "high" | "low";
}

export interface RenderedSynopticLine {
  kind: string;
  value: number | null;
  points: [number, number][];
}

export function pickReadableSynopticLabels(
  map: LeafletMap,
  labels: SynopticVectorLabel[],
  zoom: number,
  useFallbackStyle: boolean,
): RenderableSynopticLabel[] {
  const style = SYNOPTIC_STYLE;
  const bucketId = getZoomBucketId(zoom);
  const edgeBuffer = Number(style?.declutter?.edgeBufferLabelPxByBucket?.[bucketId] || 20);
  const selected: RenderableSynopticLabel[] = [];
  const placedPoints: { x: number; y: number; spacing: number }[] = [];
  const sorted = [...labels]
    .filter((entry) => Number.isFinite(entry.lat) && Number.isFinite(entry.lon) && Boolean(entry.text))
    .sort((left, right) => synopticLabelPriority(left.kind) - synopticLabelPriority(right.kind));

  const size = map.getSize();
  const maxLabels = zoom >= 10 ? 240 : zoom >= 7 ? 180 : zoom >= 4 ? 140 : 100;
  for (const label of sorted) {
    const labelStyle = resolveSynopticLabelPaint(label, zoom, useFallbackStyle);
    if (!labelStyle) {
      continue;
    }
    const point = map.latLngToContainerPoint([label.lat, label.lon]);
    if (
      point.x < edgeBuffer ||
      point.y < edgeBuffer ||
      point.x > size.x - edgeBuffer ||
      point.y > size.y - edgeBuffer
    ) {
      continue;
    }
    const spacing = resolveLabelSpacingPx(label.kind, zoom);
    let tooClose = false;
    for (const placed of placedPoints) {
      const dx = placed.x - point.x;
      const dy = placed.y - point.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < Math.min(spacing, placed.spacing)) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) {
      continue;
    }
    placedPoints.push({ x: point.x, y: point.y, spacing });
    selected.push({
      ...label,
      style: labelStyle,
    });
    if (selected.length >= maxLabels) {
      break;
    }
  }
  return selected;
}

export function ensureSynopticLineCoverageLabels(
  map: LeafletMap,
  selectedLabels: RenderableSynopticLabel[],
  renderedLines: RenderedSynopticLine[],
  zoom: number,
  useFallbackStyle: boolean,
): RenderableSynopticLabel[] {
  if (renderedLines.length === 0) {
    return selectedLabels;
  }
  const style = SYNOPTIC_STYLE;
  const bucketId = getZoomBucketId(zoom);
  const edgeBuffer = Number(style?.declutter?.edgeBufferLabelPxByBucket?.[bucketId] || 20);
  const size = map.getSize();
  const placedPoints = selectedLabels.map((entry) => {
    const point = map.latLngToContainerPoint([entry.lat, entry.lon]);
    return {
      x: point.x,
      y: point.y,
      spacing: resolveLabelSpacingPx(entry.kind, zoom),
    };
  });
  const augmented = [...selectedLabels];

  for (const line of renderedLines) {
    if (!Number.isFinite(line.value) || line.points.length < 2) {
      continue;
    }
    if (lineAlreadyLabeled(map, line, augmented, zoom)) {
      continue;
    }
    const generated = buildLineCoverageLabel(line, zoom);
    if (!generated) {
      continue;
    }
    const labelStyle = resolveSynopticLabelPaint(generated, zoom, useFallbackStyle);
    if (!labelStyle) {
      continue;
    }
    const point = map.latLngToContainerPoint([generated.lat, generated.lon]);
    if (
      point.x < edgeBuffer ||
      point.y < edgeBuffer ||
      point.x > size.x - edgeBuffer ||
      point.y > size.y - edgeBuffer
    ) {
      continue;
    }
    const spacing = Math.max(12, resolveLabelSpacingPx(generated.kind, zoom) * 0.08);
    let tooClose = false;
    for (const placed of placedPoints) {
      const dx = placed.x - point.x;
      const dy = placed.y - point.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < spacing) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) {
      continue;
    }
    placedPoints.push({ x: point.x, y: point.y, spacing });
    augmented.push({
      ...generated,
      style: labelStyle,
    });
  }
  return augmented;
}

export function buildInlineLabelGapSegment(
  map: LeafletMap,
  label: RenderableSynopticLabel,
  zoom: number,
): { start: LatLng; end: LatLng; weight: number } | null {
  if (!label.style || !Number.isFinite(label.lat) || !Number.isFinite(label.lon)) {
    return null;
  }
  const center = map.latLngToContainerPoint([label.lat, label.lon]);
  const angleDeg = normalizeContourLabelAngle(label.angleDeg);
  const theta = angleDeg * (Math.PI / 180);
  const halfLength = Math.max(8, label.text.length * label.style.fontSize * 0.22 + 2);
  const dx = Math.cos(theta) * halfLength;
  const dy = Math.sin(theta) * halfLength;
  const startPoint = L.point(center.x - dx, center.y - dy);
  const endPoint = L.point(center.x + dx, center.y + dy);
  return {
    start: map.containerPointToLatLng(startPoint),
    end: map.containerPointToLatLng(endPoint),
    weight: resolveInlineLabelGapWidth(label.kind, zoom),
  };
}

export function pickReadableSynopticCenters(
  map: LeafletMap,
  centers: SynopticCenters,
  zoom: number,
): RenderableSynopticCenter[] {
  const style = SYNOPTIC_STYLE;
  const bucketId = getZoomBucketId(zoom);
  const maxMarkers = Number(style?.centers?.maxMarkersByBucket?.[bucketId] || 12);
  const minSpacing = Number(style?.centers?.markerMinDistancePxByBucket?.[bucketId] || 200);
  const edgeBuffer = Number(style?.centers?.edgeBufferPxByBucket?.[bucketId] || 30);
  const size = map.getSize();
  const placed: { x: number; y: number }[] = [];

  const candidates: RenderableSynopticCenter[] = [
    ...(centers.highs || [])
      .sort((left, right) => right.valueHpa - left.valueHpa)
      .map((center) => ({ center, kind: "high" as const })),
    ...(centers.lows || [])
      .sort((left, right) => left.valueHpa - right.valueHpa)
      .map((center) => ({ center, kind: "low" as const })),
  ];

  const selected: RenderableSynopticCenter[] = [];
  for (const candidate of candidates) {
    const point = map.latLngToContainerPoint([candidate.center.lat, candidate.center.lon]);
    if (
      point.x < edgeBuffer ||
      point.y < edgeBuffer ||
      point.x > size.x - edgeBuffer ||
      point.y > size.y - edgeBuffer
    ) {
      continue;
    }
    let near = false;
    for (const existing of placed) {
      const dx = existing.x - point.x;
      const dy = existing.y - point.y;
      if (Math.sqrt(dx * dx + dy * dy) < minSpacing) {
        near = true;
        break;
      }
    }
    if (near) {
      continue;
    }
    placed.push({ x: point.x, y: point.y });
    selected.push(candidate);
    if (selected.length >= maxMarkers) {
      break;
    }
  }
  return selected;
}

function lineAlreadyLabeled(
  map: LeafletMap,
  line: RenderedSynopticLine,
  labels: RenderableSynopticLabel[],
  zoom: number,
): boolean {
  const family = synopticKindFamily(line.kind);
  const roundedLineValue = Number.isFinite(line.value) ? Math.round(Number(line.value)) : null;
  const threshold = zoom >= 8 ? 12 : 16;
  for (const label of labels) {
    if (synopticKindFamily(label.kind) !== family) {
      continue;
    }
    if (roundedLineValue !== null) {
      const roundedLabelValue = Number.parseInt(String(label.text || "").replace(/[^0-9.-]/g, ""), 10);
      if (Number.isFinite(roundedLabelValue) && roundedLabelValue !== roundedLineValue) {
        continue;
      }
    }
    const point = map.latLngToContainerPoint([label.lat, label.lon]);
    if (distancePointToPolylinePx(map, point.x, point.y, line.points) <= threshold) {
      return true;
    }
  }
  return false;
}

function buildLineCoverageLabel(line: RenderedSynopticLine, zoom: number): SynopticVectorLabel | null {
  if (!Number.isFinite(line.value) || line.points.length < 2) {
    return null;
  }
  const text = String(Math.round(Number(line.value)));
  const fractions = zoom >= 8 ? [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9] : [0.5, 0.4, 0.6, 0.25, 0.75];

  for (const fraction of fractions) {
    const anchor = pointOnPolyline(line.points, fraction);
    if (!anchor) {
      continue;
    }
    const angle = normalizeContourLabelAngle(estimateLineAngleDeg(line.points, anchor.index));
    return {
      lat: anchor.point[0],
      lon: anchor.point[1],
      text,
      kind: line.kind,
      angleDeg: angle,
    };
  }
  return null;
}

function synopticKindFamily(kind: string | undefined): "thickness" | "mslp" | "other" {
  const value = String(kind || "");
  if (value.startsWith("thickness")) {
    return "thickness";
  }
  if (value.startsWith("mslp")) {
    return "mslp";
  }
  return "other";
}

function pointOnPolyline(
  points: [number, number][],
  fraction: number,
): { point: [number, number]; index: number } | null {
  if (points.length < 2) {
    return null;
  }
  const safeFraction = Math.max(0, Math.min(1, fraction));
  const target = (points.length - 1) * safeFraction;
  const index = Math.max(0, Math.min(points.length - 2, Math.floor(target)));
  const t = target - index;
  const a = points[index];
  const b = points[index + 1];
  return {
    point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    index,
  };
}

function estimateLineAngleDeg(points: [number, number][], index: number): number {
  const left = points[Math.max(0, index - 1)] || points[index];
  const right = points[Math.min(points.length - 1, index + 1)] || points[index + 1] || left;
  const dy = right[0] - left[0];
  const dx = right[1] - left[1];
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return 0;
  }
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  if (!Number.isFinite(angle)) {
    return 0;
  }
  return angle;
}

export function normalizeContourLabelAngle(angleInput: unknown): number {
  const raw = Number(angleInput);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  let angle = raw % 360;
  if (angle > 180) {
    angle -= 360;
  } else if (angle < -180) {
    angle += 360;
  }
  if (angle > 90) {
    angle -= 180;
  } else if (angle < -90) {
    angle += 180;
  }
  return angle;
}

function distancePointToPolylinePx(map: LeafletMap, x: number, y: number, points: [number, number][]): number {
  if (points.length < 2) {
    return Number.POSITIVE_INFINITY;
  }
  let minDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    const prev = map.latLngToContainerPoint(points[index - 1]);
    const next = map.latLngToContainerPoint(points[index]);
    const distance = pointToSegmentDistancePx(x, y, prev.x, prev.y, next.x, next.y);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }
  return minDistance;
}

function pointToSegmentDistancePx(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const denom = abx * abx + aby * aby;
  if (denom <= 0) {
    const dx = px - ax;
    const dy = py - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

function resolveInlineLabelGapWidth(kind: string | undefined, zoom: number): number {
  const value = String(kind || "");
  if (value.startsWith("thickness")) {
    return zoom >= 8 ? 2.0 : 2.3;
  }
  return zoom >= 8 ? 2.1 : 2.4;
}
