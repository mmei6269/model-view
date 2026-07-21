// Pure synoptic/contour payload -> GeoJSON conversion (Task 4.2, native GL
// line layers). NO map or engine imports live here: everything operates on
// decoded lat/lon polylines in geographic space, so the module is testable
// from node (tests-node/synoptic-geojson.test.js).
//
// Feature contract (engine-contract.md / task 4.2): every line feature carries
//   kind:     "isobar" | "thickness" | "height"
//   value:    the contour level (hPa for isobars, dam for thickness/heights)
//   label:    display text for the level (Task 4.3 symbol layers read this)
//   emphasis: meteorologically significant line — see EMPHASIS RULE below
// plus per-kind extras:
//   major:    the payload generator's major/minor interval classification
//   band:     thickness only — "cold" (< 540 dam) | "warm" (> 540) | "boundary"
//   color:    height only — the payload palette color analysts see today
//
// EMPHASIS RULE (documented for the redesign):
// - Isobars: emphasis = the payload's own major classification — multiples of
//   8 hPa (shared/synoptic-style-v1.json mslp.majorIntervalHpa; the payload
//   carries 4-hPa minors between them). This matches the generator's semantic
//   marking rather than inventing a new interval client-side; when a pre-v3
//   payload has no kind, the same 8-hPa modulo is derived from the value.
// - Thickness: emphasis = the 540-dam thermal-reference line only (useful
//   synoptic guidance, not a deterministic rain/snow boundary; payload kind
//   "thickness-540"). The
//   12-dam major / 6-dam minor hierarchy travels as `major`, not `emphasis`.
// - Heights: emphasis = the payload's major classification (2x the level's
//   contour interval, e.g. 12 dam at 500 mb where the interval is 6 dam).

import { SYNOPTIC_STYLE } from "../../config/synopticStyle";
import { decodeVectorLinePoints, withDecodedVectorLinePoints } from "../../core/vector-encoding";
import type {
  ContourVectorPayload,
  SynopticCenter,
  SynopticCenters,
  SynopticVectorLabel,
  SynopticVectorLine,
  SynopticVectorPayload,
} from "../../types";

export type SynopticGeoKind = "isobar" | "thickness" | "height";
export type ThicknessBand = "cold" | "warm" | "boundary";

export interface SynopticLineFeatureProperties {
  kind: SynopticGeoKind;
  value: number;
  label: string;
  emphasis: boolean;
  major: boolean;
  band?: ThicknessBand;
  color?: string;
}

export interface SynopticFeatureCollections {
  isobars: GeoJSON.FeatureCollection;
  thickness: GeoJSON.FeatureCollection;
}

// H/L pressure-center point features (Task 4.3 symbol layers). One collection
// per kind because highs and lows render as separate symbol layers (the
// engine's SymbolLayerStyle is a single text color; H is cyan, L is red).
export interface SynopticCenterFeatureProperties {
  kind: "high" | "low";
  value: number; // rounded hPa, for display
  label: "H" | "L"; // the glyph the symbol layer renders (textProperty)
  valueText: string; // rounded hPa as text, rendered beneath the glyph
  sortKey: number; // see SORT KEY below
}

export interface SynopticCenterFeatureCollections {
  highs: GeoJSON.FeatureCollection;
  lows: GeoJSON.FeatureCollection;
}

// One collection per (kind x style class): the engine's LineLayerStyle is a
// single paint, so each class that styles differently (color/weight/dash)
// renders as its own stable line-layer id. Bottom -> top stacking order of
// the corresponding layers is decided by the hook's setLineLayer call order.
export interface SynopticStyleClassCollections {
  thicknessCold: GeoJSON.FeatureCollection;
  thicknessColdMajor: GeoJSON.FeatureCollection;
  thicknessWarm: GeoJSON.FeatureCollection;
  thicknessWarmMajor: GeoJSON.FeatureCollection;
  thicknessBoundary: GeoJSON.FeatureCollection;
  isobars: GeoJSON.FeatureCollection;
  isobarsMajor: GeoJSON.FeatureCollection;
}

// Emphasis/major interval sources — the same shared style file the payload
// generator (scripts/lib/synoptic-render.js) reads, so the value-modulo
// fallbacks can never drift from the kinds the generator emits.
const MSLP_MAJOR_INTERVAL_HPA = Number(SYNOPTIC_STYLE?.mslp?.majorIntervalHpa || 8);
const THICKNESS_MAJOR_INTERVAL_DAM = Number(SYNOPTIC_STYLE?.thickness?.majorIntervalDam || 12);
export const THICKNESS_BOUNDARY_DAM = Number(SYNOPTIC_STYLE?.thickness?.emphasisDam || 540);

// ── Geographic-space contour smoothing (Task 4.3 owner round 2) ──────────────
// WHY: the payload polylines are coarse — the NAM height-contour payloads ship
// ~16–32 vertices across all of CONUS (segments up to ~4.3°, corners up to
// ~33°), and "simple"-mode synoptic lines carry corners up to ~69° — so raw
// geometry reads as a polygon at regional zooms and worse at the app's max
// zoom (native z13). The old leaflet canvas path re-ran Chaikin corner-cutting
// per zoom as a draw-time perf hack (and never smoothed height contours at
// all); GL renders a dense polyline cheaply and re-projects it on the GPU, so
// the geometry is built ONCE in geographic space, smooth at every zoom.
//
// ALGORITHM: iterated midpoint Catmull-Rom subdivision — the interpolatory
// 4-point (Dyn–Levin–Gregory) scheme with w = 1/16. Each pass inserts
//   m_i = (−v_{i−1} + 9·v_i + 9·v_{i+1} − v_{i+2}) / 16
// on qualifying segments (a uniform Catmull-Rom spline evaluated at the
// segment midpoint). The scheme is INTERPOLATORY: every original vertex is
// preserved exactly, so the line still passes through every point the
// marching-squares extraction produced; only the chords between them bend.
//
// ACCURACY BOUND (unit-tested against the real payload fixtures): a pass-1
// midpoint deviates from its chord by ‖Δ²v_i + Δ²v_{i+1}‖/16 ≤ Lmax/4, where
// Lmax is the longer adjacent original segment (≈ the payload's effective
// grid spacing); later passes contract second differences geometrically, so
// the total deviation from the ORIGINAL polyline stays ≤ 0.25 × Lmax — the
// fixtures measure ≈0.1 × Lmax. Values, properties, feature count/order, ring
// closure, and open-line endpoints are unchanged by construction.
//
// ADAPTIVITY: a segment subdivides only while one of its end corners turns
// more than CONTOUR_SMOOTH_MAX_TURN_DEG (straight runs pass through
// untouched); corners flatten by roughly half per pass, and refinement stops
// at CONTOUR_SMOOTH_MAX_PASSES or the per-line point budget. Segments already
// below CONTOUR_SMOOTH_MIN_SEGMENT_DEG (~sub-pixel at native z13, the app's
// max zoom) never split.
const CONTOUR_SMOOTH_MAX_TURN_DEG = 4;
const CONTOUR_SMOOTH_MAX_PASSES = 6;
const CONTOUR_SMOOTH_MAX_POINTS = 4096;
const CONTOUR_SMOOTH_MIN_SEGMENT_DEG = 0.002;

export function smoothGeographicPolyline(points: [number, number][]): [number, number][] {
  if (!Array.isArray(points) || points.length < 3) {
    return points;
  }
  const isClosed = pointsNear(points[0], points[points.length - 1], 1e-6);
  let current = dedupeConsecutivePoints(isClosed ? points.slice(0, -1) : points);
  if (current.length < 3) {
    return points;
  }
  // Turn angles and segment lengths are measured in a local plane with
  // longitude compressed by cos(mean lat) — true ground proportions, so a
  // corner reads the same number of degrees the analyst sees on screen.
  const meanLatRad = (current.reduce((sum, p) => sum + p[0], 0) / current.length) * (Math.PI / 180);
  const lonScale = Math.max(0.2, Math.cos(meanLatRad));

  for (let pass = 0; pass < CONTOUR_SMOOTH_MAX_PASSES; pass += 1) {
    const n = current.length;
    if (n >= CONTOUR_SMOOTH_MAX_POINTS) {
      break;
    }
    const turns = turnAnglesDeg(current, isClosed, lonScale);
    const next: [number, number][] = [];
    let inserted = 0;
    const segmentCount = isClosed ? n : n - 1;
    for (let index = 0; index < segmentCount; index += 1) {
      const v1 = current[index];
      const v2 = current[(index + 1) % n];
      next.push(v1);
      if (
        n + inserted >= CONTOUR_SMOOTH_MAX_POINTS ||
        Math.max(turns[index], turns[(index + 1) % n]) <= CONTOUR_SMOOTH_MAX_TURN_DEG ||
        planeDistance(v1, v2, lonScale) < CONTOUR_SMOOTH_MIN_SEGMENT_DEG
      ) {
        continue;
      }
      const v0 = index > 0 ? current[index - 1] : isClosed ? current[n - 1] : v1;
      const v3 = index + 2 <= n - 1 || isClosed ? current[(index + 2) % n] : v2;
      next.push([(-v0[0] + 9 * v1[0] + 9 * v2[0] - v3[0]) / 16, (-v0[1] + 9 * v1[1] + 9 * v2[1] - v3[1]) / 16]);
      inserted += 1;
    }
    if (!isClosed) {
      next.push(current[n - 1]);
    }
    current = next;
    if (inserted === 0) {
      break;
    }
  }
  return isClosed ? [...current, [current[0][0], current[0][1]]] : current;
}

// Per-vertex turn (deviation from straight-through) in degrees; endpoints of
// open lines turn 0. Points are [lat, lon]; lon deltas scale by cos(mean lat).
function turnAnglesDeg(points: [number, number][], isClosed: boolean, lonScale: number): number[] {
  const n = points.length;
  const turns = new Array<number>(n).fill(0);
  const start = isClosed ? 0 : 1;
  const end = isClosed ? n : n - 1;
  for (let index = start; index < end; index += 1) {
    const prev = points[(index - 1 + n) % n];
    const here = points[index];
    const nextPoint = points[(index + 1) % n];
    const ax = (here[1] - prev[1]) * lonScale;
    const ay = here[0] - prev[0];
    const bx = (nextPoint[1] - here[1]) * lonScale;
    const by = nextPoint[0] - here[0];
    const na = Math.hypot(ax, ay);
    const nb = Math.hypot(bx, by);
    if (na < 1e-12 || nb < 1e-12) {
      continue;
    }
    const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (na * nb)));
    turns[index] = (Math.acos(cos) * 180) / Math.PI;
  }
  return turns;
}

function planeDistance(a: [number, number], b: [number, number], lonScale: number): number {
  return Math.hypot((b[1] - a[1]) * lonScale, b[0] - a[0]);
}

export function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

// ── Payload -> FeatureCollection conversion ──────────────────────────────────

export function buildSynopticFeatureCollections(
  payload: SynopticVectorPayload | null | undefined,
): SynopticFeatureCollections {
  // v3+ payloads carry the kind buckets AND a pre-v3 top-level `lines` compat
  // copy of the very same lines; normalizeSynopticVectorPayload merges both
  // (the leaflet canvas path harmlessly overdraws the duplicates with
  // identical paint). GeoJSON features must not be doubled, so consume the
  // buckets when they exist and fall back to the compat copy only for true
  // pre-v3 payloads.
  const source = payload ?? {};
  const hasBuckets = (source.isobars?.lines?.length || 0) + (source.thickness?.lines?.length || 0) > 0;
  const normalized = normalizeSynopticVectorPayload(hasBuckets ? { ...source, lines: [], labels: [] } : source);
  return {
    isobars: {
      type: "FeatureCollection",
      features: stitchSynopticSegments(normalized.isobars.lines || []).flatMap((line) => {
        const feature = synopticLineFeature(line, "isobar");
        return feature ? [feature] : [];
      }),
    },
    thickness: {
      type: "FeatureCollection",
      features: stitchSynopticSegments(normalized.thickness.lines || []).flatMap((line) => {
        const feature = synopticLineFeature(line, "thickness");
        return feature ? [feature] : [];
      }),
    },
  };
}

export function buildHeightContourFeatureCollection(
  payload: ContourVectorPayload | null | undefined,
): GeoJSON.FeatureCollection {
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  const intervalDam = Number(payload?.contourIntervalDam);
  const features: GeoJSON.Feature[] = [];
  for (const line of lines) {
    // Height contour polylines arrive complete (no stitching needed) but
    // COARSE: the generator's grid-space smoothing still leaves multi-degree
    // segments with visible corners. Subdivide in geographic space (see the
    // smoothing block above) so contours render smooth at every zoom — the
    // owner-round fix for the jagged 500-mb contours.
    const points = smoothGeographicPolyline(decodeVectorLinePoints(line));
    const value = Number(line?.value);
    if (points.length < 2 || !Number.isFinite(value)) {
      continue;
    }
    const kind = String(line.kind || "");
    const major = kind
      ? /-major$/.test(kind)
      : Number.isFinite(intervalDam) && intervalDam > 0 && nearlyModulo(value, intervalDam * 2);
    features.push({
      type: "Feature",
      properties: {
        kind: "height",
        value,
        label: String(value),
        emphasis: major,
        major,
        color: String(line.color || "#171717"),
      } satisfies SynopticLineFeatureProperties,
      geometry: { type: "LineString", coordinates: toLonLatRing(points) },
    });
  }
  return { type: "FeatureCollection", features };
}

// SORT KEY (documented formula): sortKey = -(|valueHpa - 1013.25|), the
// negated MSLP anomaly magnitude from the standard atmosphere. MapLibre
// places symbols in ascending symbol-sort-key order within a layer, so the
// most negative key — the deepest low / strongest high — claims collision
// space first and weak centers are the ones dropped in dense fields.
const STANDARD_MSLP_HPA = 1013.25;

export function buildSynopticCenterFeatureCollections(
  centers: SynopticCenters | null | undefined,
): SynopticCenterFeatureCollections {
  const collect = (entries: SynopticCenters["highs"] | undefined, kind: "high" | "low"): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: (Array.isArray(entries) ? entries : []).flatMap((entry) => {
      const feature = synopticCenterFeature(entry, kind);
      return feature ? [feature] : [];
    }),
  });
  return {
    highs: collect(centers?.highs, "high"),
    lows: collect(centers?.lows, "low"),
  };
}

function synopticCenterFeature(entry: SynopticCenter, kind: "high" | "low"): GeoJSON.Feature | null {
  const lat = Number(entry?.lat);
  const lon = Number(entry?.lon);
  const raw = Number(entry?.valueHpa);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(raw)) {
    return null;
  }
  const value = Math.round(raw);
  return {
    type: "Feature",
    properties: {
      kind,
      value,
      label: kind === "high" ? "H" : "L",
      valueText: String(value),
      // Raw (unrounded) anomaly: two centers rounding to the same display
      // value still keep their true relative priority.
      sortKey: -Math.abs(raw - STANDARD_MSLP_HPA),
    } satisfies SynopticCenterFeatureProperties,
    geometry: { type: "Point", coordinates: [lon, lat] },
  };
}

function synopticLineFeature(line: SynopticVectorLine, kind: "isobar" | "thickness"): GeoJSON.Feature | null {
  const points = Array.isArray(line.points) ? line.points : [];
  const value = Number(line.value);
  if (points.length < 2 || !Number.isFinite(value)) {
    // The generator always sets a finite level; anything else is malformed
    // data and value is contractual on the feature, so drop the line.
    return null;
  }
  const payloadKind = String(line.kind || "");
  const smoothed = smoothGeographicPolyline(points);
  const band = kind === "thickness" ? thicknessBand(value, payloadKind) : undefined;
  // The payload's own major/minor kind wins when present (it is the
  // generator's semantic marking); the interval modulo is only a fallback for
  // kindless lines.
  const major =
    kind === "isobar"
      ? payloadKind
        ? payloadKind === "mslp-major"
        : nearlyModulo(value, MSLP_MAJOR_INTERVAL_HPA)
      : payloadKind
        ? payloadKind === "thickness-major" || payloadKind === "thickness-540"
        : nearlyModulo(value, THICKNESS_MAJOR_INTERVAL_DAM);
  const emphasis = kind === "isobar" ? major : band === "boundary";
  return {
    type: "Feature",
    properties: {
      kind,
      value,
      label: String(value),
      emphasis,
      major,
      ...(band ? { band } : {}),
    } satisfies SynopticLineFeatureProperties,
    geometry: { type: "LineString", coordinates: toLonLatRing(smoothed) },
  };
}

function thicknessBand(value: number, kind: string): ThicknessBand {
  if (kind === "thickness-540" || value === THICKNESS_BOUNDARY_DAM) {
    return "boundary";
  }
  return value < THICKNESS_BOUNDARY_DAM ? "cold" : "warm";
}

// Payload points are [lat, lon]; GeoJSON positions are [lon, lat]. Closed
// rings (first ~= last after polyline decode) are snapped to EXACT closure so
// GL round joins render a seamless ring instead of a hairline gap.
function toLonLatRing(points: [number, number][]): [number, number][] {
  const coordinates = points.map(([lat, lon]) => [lon, lat] as [number, number]);
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (coordinates.length >= 4 && pointsNear(first, last, 1e-6)) {
    coordinates[coordinates.length - 1] = [first[0], first[1]];
  }
  return coordinates;
}

function nearlyModulo(value: number, interval: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(interval) || interval <= 0) {
    return false;
  }
  return Math.abs(value / interval - Math.round(value / interval)) <= 1e-6;
}

// ── Style-class splits (one collection per line-layer id) ────────────────────

export function splitSynopticStyleClasses(collections: SynopticFeatureCollections): SynopticStyleClassCollections {
  const thicknessOf = (predicate: (props: SynopticLineFeatureProperties) => boolean): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: collections.thickness.features.filter((f) => predicate(f.properties as SynopticLineFeatureProperties)),
  });
  const isobarsOf = (major: boolean): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: collections.isobars.features.filter(
      (f) => Boolean((f.properties as SynopticLineFeatureProperties).major) === major,
    ),
  });
  return {
    thicknessCold: thicknessOf((p) => p.band === "cold" && !p.major),
    thicknessColdMajor: thicknessOf((p) => p.band === "cold" && p.major),
    thicknessWarm: thicknessOf((p) => p.band === "warm" && !p.major),
    thicknessWarmMajor: thicknessOf((p) => p.band === "warm" && p.major),
    thicknessBoundary: thicknessOf((p) => p.band === "boundary"),
    isobars: isobarsOf(false),
    isobarsMajor: isobarsOf(true),
  };
}

export function splitHeightContourClasses(collection: GeoJSON.FeatureCollection): {
  minor: GeoJSON.FeatureCollection;
  major: GeoJSON.FeatureCollection;
} {
  const of = (major: boolean): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: collection.features.filter(
      (f) => Boolean((f.properties as SynopticLineFeatureProperties).major) === major,
    ),
  });
  return { minor: of(false), major: of(true) };
}

// ── Pure geometry + payload helpers ──────────────────────────────────────────

// The synoptic vector payload's centers with the manifest frame's as fallback.
// Presence, not array length, is authoritative: an explicitly empty vector
// collection means the analysis found no qualifying centers and must not
// resurrect a stale or legacy manifest marker.
export function resolveSynopticCenters(
  vectorCenters: SynopticCenters | null | undefined,
  fallbackCenters: SynopticCenters | null | undefined,
): SynopticCenters | null {
  if (vectorCenters !== null && vectorCenters !== undefined) {
    return vectorCenters;
  }
  return fallbackCenters ?? null;
}

// Preserve the distinction between an omitted center roster (legacy payload,
// loading/failure represented by null input) and an explicitly present-empty
// roster. The latter is an authoritative analysis result; the former must let
// the manifest's canonical centers remain visible.
export function normalizeExplicitSynopticCenters(
  input: SynopticVectorPayload | null | undefined,
): SynopticCenters | undefined {
  if (input?.centers === null || input?.centers === undefined) {
    return undefined;
  }
  return {
    highs: Array.isArray(input.centers.highs)
      ? input.centers.highs.filter(
          (entry) => Number.isFinite(entry?.lat) && Number.isFinite(entry?.lon) && Number.isFinite(entry?.valueHpa),
        )
      : [],
    lows: Array.isArray(input.centers.lows)
      ? input.centers.lows.filter(
          (entry) => Number.isFinite(entry?.lat) && Number.isFinite(entry?.lon) && Number.isFinite(entry?.valueHpa),
        )
      : [],
  };
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

  const centers: SynopticCenters = normalizeExplicitSynopticCenters(input) || { highs: [], lows: [] };

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
