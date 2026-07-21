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
  minorIntervalHpa?: number;
  majorIntervalHpa?: number;
  showMinorAtZoomGte?: number;
  major?: SynopticLineStyle;
  minor?: SynopticLineStyle;
  uniform?: SynopticLineStyle;
  labels?: SynopticLabelStyle;
}

export interface SynopticThicknessStyle {
  minorIntervalDam?: number;
  majorIntervalDam?: number;
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

// DOMAIN NOTE: the shared style JSON — zoomBuckets included — is consumed
// byte-identically by the server-side renderer (scripts/lib/
// synoptic-style.js) and is public-mirrored, so it must never change shape
// here. Its bucket ranges (and thickness.showMinorAtZoomGte) stay in the
// renderer's historical zoom domain (= native maplibre zoom + 1, the retired
// leaflet scale); the app's remaining consumers (synoptic-geojson interval
// constants, the Task 4.2/4.3 ZoomCurves derived from the bucket tables)
// already account for that offset at their definition site.
