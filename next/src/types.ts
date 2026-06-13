export type ModelKey = "gfs" | "nam" | "nam3km" | "hrrr";
export type ViewKey = "conus" | "na";
export type LayerKey = string;
export type FrameHourStatus = "loaded" | "loading" | "error" | "pending" | "unavailable";
export type ValidTimeIso = string;
export type PrefetchState = "idle" | "loading" | "loaded" | "error";
export type TimelineMode = "overlap" | "panel";
export type ReflectivityGateDbz = 10 | 15 | 20;
export type SynopticDetailMode = "simple" | "detailed";

export interface ViewBounds {
  north: number;
  south: number;
  west: number;
  east: number;
}

export interface ViewDefinition {
  label: string;
  center: [number, number];
  zoom: number;
  bounds: ViewBounds;
}

export interface ModelDefinition {
  label: string;
  maxHour: number;
  frameStepHours?: number;
}

export interface LayerDefinition {
  key: LayerKey;
  label: string;
  group?: string;
  unit?: string | null;
  available?: boolean;
  thresholdNote?: string | null;
  sourceNote?: string | null;
  methodVersion?: string | null;
  derivation?: string | null;
  applicability?: string | null;
  formulaReference?: string | null;
}

export interface FrameLayerRef {
  key: string;
  bytes: number;
  contentType: string;
  url?: string | null;
}

export interface HoverGridSupplementalRef {
  key: string;
  bytes?: number | null;
  schemaVersion?: number | null;
}

export interface ReflectivityVariants {
  dbz10?: FrameLayerRef;
  dbz15?: FrameLayerRef;
  dbz20?: FrameLayerRef;
}

export type ReflectivityVariantsByLayer = Record<string, ReflectivityVariants | undefined>;

export interface PrecipTypeLegendBin {
  label: string;
  startDbz?: number | null;
  minDbz?: number | null;
  maxDbz?: number | null;
  minRate?: number | null;
  maxRate?: number | null;
  color: [number, number, number, number];
}

export interface PrecipTypeLegendRow {
  key: string;
  label: string;
  filterDbz?: number | null;
  tickLabels?: number[];
  bins: PrecipTypeLegendBin[];
}

export interface ParameterMetadata {
  key: string;
  label: string;
  unit?: string | null;
  group?: string | null;
  thresholdNote?: string | null;
  sourceNote?: string | null;
  legendTicks?: number[];
  legendTickPositions?: number[];
  legendStops?: [number, [number, number, number] | [number, number, number, number]][];
  legendDisplayScale?: { kind?: string | null; exponent?: number | null } | null;
  legendType?:
    | "gradient"
    | "precip-type-reflectivity"
    | "precip-rate-type"
    | "height-contour"
    | "vector"
    | string
    | null;
  precipTypeLegend?: PrecipTypeLegendRow[];
  precipRateTypeLegend?: PrecipTypeLegendRow[];
  contourIntervalDam?: number | null;
  contourLevelMb?: number | null;
  accumulationWindowHours?: number | null;
  accumulationMode?: "rolling" | "total" | string | null;
  minForecastHour?: number | null;
  methodVersion?: string | null;
  derivation?: string | null;
  applicability?: string | null;
  formulaReference?: string | null;
  artifactRequired?: string | null;
}

export interface SynopticCenter {
  lat: number;
  lon: number;
  valueHpa: number;
  prominenceHpa?: number;
}

export interface SynopticCenters {
  highs: SynopticCenter[];
  lows: SynopticCenter[];
}

export interface SynopticVectorLine {
  points?: [number, number][];
  encodedPoints?: string;
  pointEncoding?: string;
  kind?: string;
  value?: number;
  color?: string;
  width?: number;
  alpha?: number;
  dash?: number[];
}

export interface SynopticVectorLabel {
  lat: number;
  lon: number;
  text: string;
  kind?: string;
  color?: string;
  angleDeg?: number;
}

export interface SynopticVectorPayload {
  styleVersion?: string;
  isobars?: {
    lines?: SynopticVectorLine[];
    labels?: SynopticVectorLabel[];
  };
  thickness?: {
    lines?: SynopticVectorLine[];
    labels?: SynopticVectorLabel[];
  };
  centers?: SynopticCenters;
  // Backward compatibility for pre-v3 vector payloads.
  lines?: SynopticVectorLine[];
  labels?: SynopticVectorLabel[];
}

export interface ContourVectorLine {
  points?: [number, number][];
  encodedPoints?: string;
  pointEncoding?: string;
  kind?: string;
  value?: number;
  color?: string;
  width?: number;
  alpha?: number;
  dash?: number[];
}

export interface ContourVectorLabel {
  lat: number;
  lon: number;
  text: string;
  kind?: string;
  color?: string;
  angleDeg?: number;
}

export interface ContourVectorPayload {
  styleVersion?: string;
  layerType?: string | null;
  contourLevelMb?: number | null;
  contourIntervalDam?: number | null;
  lines?: ContourVectorLine[];
  labels?: ContourVectorLabel[];
}

export interface WeatherVector {
  lat: number;
  lon: number;
  uKt?: number | null;
  vKt?: number | null;
  speedKt?: number | null;
}

export interface WeatherVectorPayload {
  schemaVersion?: number;
  layerType?: string | null;
  unit?: string | null;
  stride?: { x?: number | null; y?: number | null } | null;
  vectors?: WeatherVector[];
}

export interface SynopticVectorKeys {
  simple?: string | null;
  detailed?: string | null;
}

export interface SynopticVectorBytes {
  simple?: number | null;
  detailed?: number | null;
}

export interface SynopticStyleVersions {
  simple?: string | null;
  detailed?: string | null;
}

export interface PressureUploadMeta {
  source: "om-grid" | "open-data-fallback" | "forecast-fallback" | "none";
  inputRows: number | null;
  inputCols: number | null;
  hoverRows: number;
  hoverCols: number;
  fullResolutionInput: boolean;
}

export type HoverGridVariableKey = string;

export interface HoverGridVariable {
  scale: number;
  offset: number;
  missing: number;
  data?: string;
  values?: Int16Array;
}

export interface HoverGridPayload {
  schemaVersion: number;
  rows: number;
  cols: number;
  variables: Partial<Record<HoverGridVariableKey, HoverGridVariable>>;
}

export interface PointSoundingLevel {
  source?: "surface" | "pressure" | string;
  press: number | null;
  hght: number | null;
  temp: number | null;
  dwpt: number | null;
  rh?: number | null;
  wdir?: number | null;
  wspd?: number | null;
  uKt?: number | null;
  vKt?: number | null;
}

export interface PointSoundingSurface {
  pressureHpa?: number | null;
  heightM?: number | null;
  temperatureC?: number | null;
  dewpointC?: number | null;
  rhPct?: number | null;
  windDirDeg?: number | null;
  windSpeedKt?: number | null;
  mslpHpa?: number | null;
}

export interface PointSoundingParcelTraceLevel {
  press: number | null;
  temp: number | null;
}

export interface PointSoundingParcelTrace {
  type?: "SFC" | "ML" | "MU" | string;
  label?: string | null;
  sourcePressureHpa?: number | null;
  sourceHeightM?: number | null;
  sourceTemperatureC?: number | null;
  sourceDewpointC?: number | null;
  capeJkg?: number | null;
  cinJkg?: number | null;
  lclM?: number | null;
  lfcM?: number | null;
  elM?: number | null;
  liftedIndexC?: number | null;
  levels?: PointSoundingParcelTraceLevel[];
}

export interface PointSoundingIndices {
  surfacePressureHpa?: number | null;
  surfaceHeightM?: number | null;
  surfaceTempC?: number | null;
  surfaceDewpointC?: number | null;
  surfaceRhPct?: number | null;
  surfaceWindDirDeg?: number | null;
  surfaceWindKt?: number | null;
  mslpHpa?: number | null;
  pblHeightM?: number | null;
  cloudCeilingM?: number | null;
  surfaceThetaEK?: number | null;
  pwatMm?: number | null;
  lclM?: number | null;
  mixedLayerLclM?: number | null;
  mixedLayerLiftedIndexC?: number | null;
  mixedLayerLfcM?: number | null;
  mixedLayerElM?: number | null;
  lfcM?: number | null;
  elM?: number | null;
  temp0CHeightM?: number | null;
  temp0CHeightFt?: number | null;
  tempMinus10CHeightM?: number | null;
  tempMinus10CHeightFt?: number | null;
  tempMinus20CHeightM?: number | null;
  tempMinus20CHeightFt?: number | null;
  tempMinus30CHeightM?: number | null;
  tempMinus30CHeightFt?: number | null;
  freezingLevelM?: number | null;
  wetBulbZeroM?: number | null;
  lapseRate700to500CPerKm?: number | null;
  lapseRate850to500CPerKm?: number | null;
  lapseRate0to3kmCPerKm?: number | null;
  lapseRate3to6kmCPerKm?: number | null;
  virtualLapseRate700to500CPerKm?: number | null;
  virtualLapseRate850to500CPerKm?: number | null;
  virtualLapseRate0to3kmCPerKm?: number | null;
  virtualLapseRate3to6kmCPerKm?: number | null;
  kIndexC?: number | null;
  totalTotalsC?: number | null;
  verticalTotalsC?: number | null;
  crossTotalsC?: number | null;
  liftedIndexC?: number | null;
  showalterIndexC?: number | null;
  cape0to3kmJkg?: number | null;
  mixedLayerCape0to3kmJkg?: number | null;
  modelCape0to3kmJkg?: number | null;
  shipParameter?: number | null;
  sbcapeJkg?: number | null;
  sbcinJkg?: number | null;
  mlcapeJkg?: number | null;
  mlcinJkg?: number | null;
  mucapeJkg?: number | null;
  mucinJkg?: number | null;
  mostUnstableLclM?: number | null;
  mostUnstableLiftedIndexC?: number | null;
  mostUnstableLfcM?: number | null;
  mostUnstableElM?: number | null;
  dcapeJkg?: number | null;
  shear0to1kmKt?: number | null;
  shear0to3kmKt?: number | null;
  shear0to6kmKt?: number | null;
  shear0to8kmKt?: number | null;
  shearSurfaceTo500mbKt?: number | null;
  srh0to1kmM2S2?: number | null;
  srh0to3kmM2S2?: number | null;
  profileSrh0to1kmM2S2?: number | null;
  profileSrh0to3kmM2S2?: number | null;
  modelSrh0to1kmM2S2?: number | null;
  modelSrh0to3kmM2S2?: number | null;
  effectiveSrhM2S2?: number | null;
  effectiveBulkShearKt?: number | null;
  effectiveBaseM?: number | null;
  effectiveTopM?: number | null;
  effectiveLayerMuCapeJkg?: number | null;
  effectiveLayerMuCinJkg?: number | null;
  meanWind0to6kmDirDeg?: number | null;
  meanWind0to6kmKt?: number | null;
  bunkersRightDirDeg?: number | null;
  bunkersRightKt?: number | null;
  bunkersLeftDirDeg?: number | null;
  bunkersLeftKt?: number | null;
  bunkersMethod?: string | null;
  corfidiUpshearDirDeg?: number | null;
  corfidiUpshearKt?: number | null;
  corfidiDownshearDirDeg?: number | null;
  corfidiDownshearKt?: number | null;
  stormRelativeWind0to2kmKt?: number | null;
  stormRelativeWind4to6kmKt?: number | null;
  ehi0to1km?: number | null;
  ehi0to3km?: number | null;
  supercellComposite?: number | null;
  supercellCompositeProxy?: number | null;
  supercellCompositeEffective?: number | null;
  significantTornadoFixed?: number | null;
  significantTornadoEffective?: number | null;
  updraftHelicity2to5kmM2S2?: number | null;
  maxHailSizeIn?: number | null;
  maxWindKt?: number | null;
}

export interface PointSoundingPayload {
  schemaVersion?: number;
  source?: string;
  model: ModelKey | string;
  modelLabel?: string;
  run: string;
  referenceTime?: string | null;
  forecastHour: number;
  validTime?: string | null;
  lat: number;
  lon: number;
  sampleLat?: number | null;
  sampleLon?: number | null;
  selectedRecordCount?: number | null;
  surface?: PointSoundingSurface | null;
  levels: PointSoundingLevel[];
  parcelTrace?: PointSoundingParcelTrace | null;
  indices?: PointSoundingIndices | null;
  warnings?: string[];
}

export interface FrameRecord {
  hour: number;
  validHourKey: ValidTimeIso;
  bounds: ViewBounds;
  cols: number;
  rows: number;
  modelToken?: string | null;
  referenceTime?: string | null;
  synopticCenters?: SynopticCenters | null;
  synopticVectorKey?: string | null;
  synopticVectorKeys?: SynopticVectorKeys | null;
  synopticVectorBytes?: SynopticVectorBytes | null;
  synopticVector?: SynopticVectorPayload | null;
  contourVectorRefs?: Record<string, FrameLayerRef | undefined> | null;
  weatherVectorRefs?: Record<string, FrameLayerRef | undefined> | null;
  synopticStyleVersion?: string | null;
  synopticStyleVersions?: SynopticStyleVersions | null;
  pressureUploadMeta?: PressureUploadMeta | null;
  hoverGridKey?: string | null;
  hoverGridBytes?: number | null;
  hoverGridSchemaVersion?: number | null;
  hoverGridSupplemental?: Record<string, HoverGridSupplementalRef> | null;
  reflectivityVariants?: ReflectivityVariants | null;
  reflectivityVariantsByLayer?: ReflectivityVariantsByLayer | null;
  layers: Record<string, FrameLayerRef | undefined>;
}

export interface ModelManifest {
  schemaVersion?: number;
  model: ModelKey;
  run: string;
  view: ViewKey;
  generatedAt: string;
  referenceTime?: string | null;
  openDataModel?: string | null;
  hourStatus?: Record<string, FrameHourStatus>;
  parameters?: Record<string, ParameterMetadata>;
  parameterOrder?: string[];
  source?: string;
  frames: FrameRecord[];
}

export interface LatestManifestPointer {
  model: ModelKey;
  run: string;
  view: ViewKey;
  generatedAt: string;
  manifestKey: string;
  frameCount: number;
}

export interface RunManifestPointer extends LatestManifestPointer {
  loadedFrameCount?: number;
  complete?: boolean;
  latest?: boolean;
}

export interface PanelState {
  id: string;
  modelKey: ModelKey;
  runId?: string | null;
  layers: LayerKey[];
}

export interface ViewportState {
  sourcePanelId: string;
  center: [number, number];
  zoom: number;
}

export interface ManifestUiInfo {
  runLabel: string;
  validLabel: string;
  validHourKey?: ValidTimeIso | null;
  resolvedHour?: number | null;
  frameStatusByValidTime?: Partial<Record<ValidTimeIso, FrameHourStatus>>;
  browserStatusByValidTime?: Partial<Record<ValidTimeIso, FrameHourStatus>>;
  loadedFrameCount?: number;
  totalFrameCount?: number;
  statusRevision?: string;
  browserStatusRevision?: string;
}

export interface ResolvedFrame {
  validHourKey: ValidTimeIso;
  hour: number;
  exact: boolean;
  deltaMinutes: number;
}
