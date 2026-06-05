import rawStyle from "../../../shared/synoptic-style-v1.json";

export interface SynopticBucketRange {
  id: string;
  min: number;
  max: number;
}

export type BucketNumberMap = Record<string, number | undefined>;

export interface SynopticLineStyle {
  color?: string;
  alpha?: number;
  widthPx?: number;
  dash?: number[];
  haloColor?: string;
  haloAlpha?: number;
  haloWidthPx?: number;
}

export interface SynopticLabelStyle {
  fontWeight?: number;
  fontSizePxByBucket?: BucketNumberMap;
  repeatDistancePxByBucket?: BucketNumberMap;
  minSpacingPxByBucket?: BucketNumberMap;
  fillColor?: string;
}

export interface SynopticMslpStyle {
  showMinorAtZoomGte?: number;
  major?: SynopticLineStyle;
  minor?: SynopticLineStyle;
  uniform?: SynopticLineStyle;
  labels?: SynopticLabelStyle;
}

export interface SynopticThicknessStyle {
  showMinorAtZoomGte?: number;
  emphasisDam?: number;
  boundaryColor?: string;
  warmColor?: string;
  coldColor?: string;
  major?: SynopticLineStyle;
  minor?: SynopticLineStyle;
  emphasis?: SynopticLineStyle;
  labels?: SynopticLabelStyle;
}

export interface SynopticCentersStyle {
  letterSizePxByBucket?: BucketNumberMap;
  valueSizePxByBucket?: BucketNumberMap;
  valueOffsetPx?: number;
  highColor?: string;
  lowColor?: string;
  maxMarkersByBucket?: BucketNumberMap;
  markerMinDistancePxByBucket?: BucketNumberMap;
  edgeBufferPxByBucket?: BucketNumberMap;
}

export interface SynopticDeclutterStyle {
  edgeBufferLabelPxByBucket?: BucketNumberMap;
}

export interface SynopticStyleConfig {
  styleVersion: string;
  zoomBuckets: SynopticBucketRange[];
  mslp: SynopticMslpStyle;
  thickness: SynopticThicknessStyle;
  centers: SynopticCentersStyle;
  declutter: SynopticDeclutterStyle;
  smoothing: Record<string, unknown>;
}

export const SYNOPTIC_STYLE = rawStyle as SynopticStyleConfig;

export function getZoomBucketId(zoom: number): string {
  const z = Number.isFinite(zoom) ? zoom : 6;
  const bucket = (SYNOPTIC_STYLE.zoomBuckets || []).find((item) => z >= Number(item.min) && z <= Number(item.max));
  return bucket?.id || "z4_6";
}

export function bucketNumber(table: unknown, zoom: number, fallback: number): number {
  if (!table || typeof table !== "object") {
    return fallback;
  }
  const bucketId = getZoomBucketId(zoom);
  const raw = (table as Record<string, unknown>)[bucketId];
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}
