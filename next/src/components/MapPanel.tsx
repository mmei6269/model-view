import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L, { type Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import SoundingDrawer from "./SoundingDrawer";
import type { MapDisplaySettings } from "../config/display";
import { getLayerLegendConfig, getLayerStackOrder, type LayerLegendConfig } from "../config/layers";
import { fetchPointSoundingPayload, formatRunLabel, resolveFrameByValidTime } from "../core/artifact-client";
import { FramePrefetchEngine, subscribeFramePrefetchCacheChanges } from "../core/frame-prefetch";
import { startLatestRunMemoryWarmup } from "../core/latest-run-memory-cache";
import { formatValidUtcLabel, normalizeIsoHour } from "../core/time";
import { useManifest } from "../hooks/useManifest";
import { useModelRuns } from "../hooks/useModelRuns";
import { formatCoordinate, formatTick } from "./map-panel/format-utils";
import { PanelChrome } from "./map-panel/PanelChrome";
import { useFrameStatus } from "./map-panel/use-frame-status";
import { useHoverGrid } from "./map-panel/use-hover-grid";
import { useMapDisplayLayers } from "./map-panel/use-map-display-layers";
import { useContourVectorLayers } from "./map-panel/use-contour-vector";
import { useLeafletMap } from "./map-panel/use-leaflet-map";
import { usePanelChromeData } from "./map-panel/use-panel-chrome-data";
import { usePressureMarkers } from "./map-panel/use-pressure-markers";
import { useSynopticVectorLayer, useSynopticVectorPayload } from "./map-panel/use-synoptic-vector";
import { useWeatherOverlays } from "./map-panel/use-weather-overlays";
import type {
  LayerKey,
  ManifestUiInfo,
  ModelKey,
  PanelState,
  PointSoundingPayload,
  PrefetchState,
  ReflectivityGateDbz,
  ResolvedFrame,
  SynopticDetailMode,
  ValidTimeIso,
  ViewKey,
} from "../types";

interface MapPanelProps {
  panel: PanelState;
  viewKey: ViewKey;
  selectedValidTimeIso: ValidTimeIso | null;
  showIsobars: boolean;
  showThickness: boolean;
  showCenters: boolean;
  synopticDetailMode: SynopticDetailMode;
  reflectivityGate: ReflectivityGateDbz;
  display: MapDisplaySettings;
  canRemove: boolean;
  layoutVersion: number;
  onMapReady: (panelId: string, map: LeafletMap) => void;
  onMapDestroyed: (panelId: string) => void;
  onAvailableValidTimesChange: (panelId: string, validTimes: ValidTimeIso[]) => void;
  onResolvedFrameChange: (panelId: string, frame: ResolvedFrame | null) => void;
  onLayerToggle: (panelId: string, layer: LayerKey) => void;
  onSelectValidTime: (panelId: string, value: ValidTimeIso) => void;
  onModelChange: (panelId: string, modelKey: ModelKey) => void;
  onRunChange: (panelId: string, runId: string | null) => void;
  onRemove: (panelId: string) => void;
  onManifestInfoChange: (panelId: string, info: ManifestUiInfo) => void;
}

const MAP_OVERLAY_GAP = "12px";
const MAP_OVERLAY_TOP = `calc(var(--chrome-top, 96px) + ${MAP_OVERLAY_GAP})`;
const MAP_OVERLAY_BOTTOM = `calc(var(--chrome-bottom, 72px) + ${MAP_OVERLAY_GAP})`;

export default function MapPanel({
  panel,
  viewKey,
  selectedValidTimeIso,
  showIsobars,
  showThickness,
  showCenters,
  synopticDetailMode,
  reflectivityGate,
  display,
  canRemove,
  layoutVersion,
  onMapReady,
  onMapDestroyed,
  onAvailableValidTimesChange,
  onResolvedFrameChange,
  onLayerToggle,
  onSelectValidTime,
  onModelChange,
  onRunChange,
  onRemove,
  onManifestInfoChange,
}: MapPanelProps) {
  const mapHostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const overlayRef = useRef<Map<LayerKey, L.ImageOverlay>>(new Map());
  const synopticMarkersRef = useRef<L.Marker[]>([]);
  const synopticVectorLayerRef = useRef<L.LayerGroup | null>(null);
  const synopticVectorKeyRef = useRef<string>("");
  const hoverAbortRef = useRef<AbortController | null>(null);
  const hoverGridKeyRef = useRef<string>("");
  const vectorAbortRef = useRef<AbortController | null>(null);
  const soundingAbortRef = useRef<AbortController | null>(null);
  const soundingMarkerRef = useRef<L.CircleMarker | null>(null);
  const prefetchEngineRef = useRef<FramePrefetchEngine | null>(null);
  const hasInitialViewportFitRef = useRef(false);
  const lastViewportFitKeyRef = useRef<string>("");

  const [menuOpen, setMenuOpen] = useState(false);
  const [parameterMenuOpen, setParameterMenuOpen] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [mapZoom, setMapZoom] = useState(0);
  const [hoverLatLng, setHoverLatLng] = useState<L.LatLng | null>(null);
  const [soundingPoint, setSoundingPoint] = useState<L.LatLng | null>(null);
  const [sounding, setSounding] = useState<PointSoundingPayload | null>(null);
  const [soundingLoading, setSoundingLoading] = useState(false);
  const [soundingError, setSoundingError] = useState<string | null>(null);
  const [soundingOpen, setSoundingOpen] = useState(false);
  const [prefetchByHour, setPrefetchByHour] = useState<Record<number, PrefetchState>>({});
  const [prefetchCacheRevision, setPrefetchCacheRevision] = useState(0);

  const runState = useModelRuns(panel.modelKey, viewKey);
  const selectedRunId = panel.runId || null;
  const manifestState = useManifest(panel.modelKey, viewKey, selectedRunId);
  const selectedLayers = useMemo(() => new Set<LayerKey>(panel.layers), [panel.layers]);
  const activeLayers = useMemo(() => {
    const next = new Set<LayerKey>(selectedLayers);
    if (showIsobars || showThickness || showCenters) {
      next.add("synoptic");
    } else {
      next.delete("synoptic");
    }
    return next;
  }, [selectedLayers, showCenters, showIsobars, showThickness]);

  const frameByHour = useMemo(() => {
    const entries = new Map<number, NonNullable<typeof manifestState.manifest>["frames"][number]>();
    for (const frame of manifestState.manifest?.frames || []) {
      entries.set(frame.hour, frame);
    }
    return entries;
  }, [manifestState.manifest]);

  const availableValidTimes = useMemo(
    () => (manifestState.manifest?.frames || []).map((entry) => normalizeIsoHour(entry.validHourKey)).filter(Boolean),
    [manifestState.manifest],
  );

  const resolvedFrame = useMemo(
    () => resolveFrameByValidTime(manifestState.manifest, selectedValidTimeIso, "nearest-absolute"),
    [manifestState.manifest, selectedValidTimeIso],
  );
  const frame = resolvedFrame ? frameByHour.get(resolvedFrame.hour) || null : null;
  const runLabel = useMemo(() => formatRunLabel(manifestState.manifest), [manifestState.manifest]);
  const validLabel = useMemo(() => formatValidUtcLabel(frame?.validHourKey || null), [frame?.validHourKey]);
  const {
    browserHourStatus,
    browserLoadedCount,
    browserStatusByValidTime,
    browserStatusRevision,
    effectiveHourStatus,
    frameStatusByValidTime,
    frameStatusRevision,
    loadedFrameCountByValidTime,
    plannedHours,
    selectedBrowserFrameStatus,
    totalFrameCountByValidTime,
    totalHours,
  } = useFrameStatus({
    activeLayers,
    frame,
    frameByHour,
    manifest: manifestState.manifest,
    modelKey: panel.modelKey,
    prefetchByHour,
    prefetchCacheRevision,
    reflectivityGate,
    synopticDetailMode,
  });
  const prefetchPlanKey = useMemo(() => {
    if (!manifestState.manifest) {
      return "";
    }
    return [
      panel.modelKey,
      viewKey,
      manifestState.manifest.run,
      String(manifestState.manifest.frames.length),
      Array.from(activeLayers).sort().join(","),
      `refl-g${reflectivityGate}`,
      `synoptic-${synopticDetailMode}`,
    ].join("|");
  }, [activeLayers, manifestState.manifest, panel.modelKey, reflectivityGate, synopticDetailMode, viewKey]);
  const {
    activeSynopticVectorKey,
    expectedSynopticStyleVersion,
    normalizedSynopticVector,
    stitchedSynopticLines,
    synopticVector,
  } = useSynopticVectorPayload({
    activeLayers,
    frame,
    synopticDetailMode,
    synopticVectorKeyRef,
    vectorAbortRef,
  });
  const { hoverLoading, hoverValues, setHoverLoading, setHoverValues } = useHoverGrid({
    activeLayers,
    frame,
    hoverAbortRef,
    hoverGridKeyRef,
    hoverLatLng,
  });
  const { emptyMessage, frameOptions, legendItems, panelStatus, parameterOptions } = usePanelChromeData({
    activeLayers,
    browserHourStatus,
    effectiveHourStatus,
    frame,
    frameByHour,
    manifestState,
    plannedHours,
    selectedLayers,
  });
  const hasExpandedLegend = legendItems.some(
    (legend) => legend.legendType === "precip-type-reflectivity" || legend.legendType === "precip-rate-type",
  );
  const hoverParameterRows = useMemo(
    () =>
      getLayerStackOrder(manifestState.manifest, selectedLayers)
        .filter((key) => key !== "synoptic" && selectedLayers.has(key))
        .map((key) => getLayerLegendConfig(key, manifestState.manifest))
        .filter((legend): legend is LayerLegendConfig => Boolean(legend)),
    [manifestState.manifest, selectedLayers],
  );

  const requestPointSounding = useCallback(
    (latLng: L.LatLng) => {
      if (!frame || !manifestState.manifest) {
        setSoundingOpen(true);
        setSounding(null);
        setSoundingError("Load a model frame before requesting a point sounding.");
        setSoundingLoading(false);
        return;
      }
      soundingAbortRef.current?.abort();
      const controller = new AbortController();
      soundingAbortRef.current = controller;
      setSoundingPoint(latLng);
      setSoundingOpen(true);
      setSounding(null);
      setSoundingError(null);
      setSoundingLoading(true);
      void fetchPointSoundingPayload({
        modelKey: panel.modelKey,
        runId: manifestState.manifest.run,
        viewKey,
        hour: frame.hour,
        lat: latLng.lat,
        lon: latLng.lng,
        signal: controller.signal,
      })
        .then((payload) => {
          if (!controller.signal.aborted) {
            setSounding(payload);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setSoundingError(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSoundingLoading(false);
          }
        });
    },
    [frame, manifestState.manifest, panel.modelKey, viewKey],
  );
  const handleMapDoubleClick = useCallback((latLng: L.LatLng) => requestPointSounding(latLng), [requestPointSounding]);

  useLeafletMap({
    panelId: panel.id,
    viewKey,
    layoutVersion,
    frameHour: frame?.hour ?? null,
    mapReady,
    mapHostRef,
    mapRef,
    overlayRef,
    synopticMarkersRef,
    synopticVectorLayerRef,
    hoverAbortRef,
    vectorAbortRef,
    prefetchEngineRef,
    hasInitialViewportFitRef,
    lastViewportFitKeyRef,
    setMapReady,
    setMapZoom,
    setHoverLatLng,
    setHoverValues,
    setHoverLoading,
    onMapReady,
    onMapDestroyed,
    onMapDoubleClick: handleMapDoubleClick,
  });

  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      return;
    }
    const map = mapRef.current;
    if (!soundingPoint) {
      if (soundingMarkerRef.current) {
        map.removeLayer(soundingMarkerRef.current);
        soundingMarkerRef.current = null;
      }
      return;
    }
    if (!soundingMarkerRef.current) {
      soundingMarkerRef.current = L.circleMarker(soundingPoint, {
        radius: 6,
        color: "#22d3ee",
        weight: 2,
        fillColor: "#020914",
        fillOpacity: 0.85,
        opacity: 1,
        interactive: false,
        pane: "markerPane",
      }).addTo(map);
      return;
    }
    soundingMarkerRef.current.setLatLng(soundingPoint);
  }, [mapReady, mapRef, soundingPoint]);

  useEffect(() => {
    return () => {
      soundingAbortRef.current?.abort();
    };
  }, []);

  useMapDisplayLayers({
    viewKey,
    display,
    mapReady,
    mapZoom,
    mapRef,
    baseLayerRef,
  });
  const contourVectorLayerKeys = useContourVectorLayers({
    activeLayers,
    frame,
    mapReady,
    mapRef,
  });
  useWeatherOverlays({
    activeLayers,
    frame,
    mapReady,
    mapRef,
    overlayRef,
    reflectivityGate,
    contourVectorLayerKeys,
    synopticVector,
  });
  useSynopticVectorLayer({
    activeLayers,
    activeSynopticVectorKey,
    expectedSynopticStyleVersion,
    frame,
    mapReady,
    mapRef,
    mapZoom,
    normalizedSynopticVector,
    showIsobars,
    showThickness,
    stitchedSynopticLines,
    synopticVector,
    synopticVectorLayerRef,
  });
  usePressureMarkers({
    activeLayers,
    frameHour: frame?.hour ?? null,
    frameSynopticCenters: frame?.synopticCenters,
    mapReady,
    mapRef,
    mapZoom,
    normalizedSynopticCenters: normalizedSynopticVector.centers,
    showCenters,
    synopticMarkersRef,
  });

  useEffect(() => {
    return subscribeFramePrefetchCacheChanges(() => {
      setPrefetchCacheRevision((revision) => revision + 1);
    });
  }, []);

  useEffect(() => {
    onAvailableValidTimesChange(panel.id, availableValidTimes);
    if (!selectedValidTimeIso && availableValidTimes.length > 0) {
      onSelectValidTime(panel.id, availableValidTimes[0]);
    }
  }, [availableValidTimes, onAvailableValidTimesChange, onSelectValidTime, panel.id, selectedValidTimeIso]);

  useEffect(() => {
    onResolvedFrameChange(panel.id, resolvedFrame);
  }, [onResolvedFrameChange, panel.id, resolvedFrame]);

  useEffect(() => {
    const info: ManifestUiInfo = {
      runLabel,
      validLabel,
      validHourKey: resolvedFrame?.validHourKey || null,
      resolvedHour: resolvedFrame?.hour ?? null,
      frameStatusByValidTime,
      browserStatusByValidTime,
      loadedFrameCount: loadedFrameCountByValidTime,
      totalFrameCount: totalFrameCountByValidTime,
      statusRevision: frameStatusRevision,
      browserStatusRevision,
    };
    onManifestInfoChange(panel.id, info);
  }, [
    browserStatusByValidTime,
    browserStatusRevision,
    frameStatusByValidTime,
    frameStatusRevision,
    loadedFrameCountByValidTime,
    onManifestInfoChange,
    panel.id,
    resolvedFrame?.hour,
    resolvedFrame?.validHourKey,
    runLabel,
    totalFrameCountByValidTime,
    validLabel,
  ]);

  useEffect(() => {
    setPrefetchByHour({});
  }, [prefetchPlanKey]);

  useEffect(() => {
    if (!manifestState.manifest) {
      prefetchEngineRef.current?.stop();
      setPrefetchByHour({});
      return;
    }
    if (!prefetchPlanKey) {
      prefetchEngineRef.current?.stop();
      return;
    }
    const anchorHour = Number(manifestState.manifest.frames[0]?.hour);
    if (!Number.isFinite(anchorHour)) {
      prefetchEngineRef.current?.stop();
      setPrefetchByHour({});
      return;
    }
    const engine = prefetchEngineRef.current || new FramePrefetchEngine();
    prefetchEngineRef.current = engine;
    engine.configure({
      cacheKey: prefetchPlanKey,
      frames: manifestState.manifest.frames,
      activeLayers,
      currentHour: anchorHour,
      reflectivityGate,
      synopticDetailMode,
      onStatus: (hour, status) => {
        setPrefetchByHour((prev) => {
          if (prev[hour] === status) {
            return prev;
          }
          return { ...prev, [hour]: status };
        });
      },
    });
  }, [activeLayers, manifestState.manifest, prefetchPlanKey, reflectivityGate, synopticDetailMode]);

  useEffect(() => {
    return () => {
      prefetchEngineRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (!manifestState.manifest || !frame || selectedBrowserFrameStatus !== "loaded") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      startLatestRunMemoryWarmup({
        modelKey: panel.modelKey,
        viewKey,
        manifest: manifestState.manifest as NonNullable<typeof manifestState.manifest>,
        anchorHour: frame.hour,
      });
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [frame, frame?.hour, manifestState.manifest, panel.modelKey, selectedBrowserFrameStatus, viewKey]);

  return (
    <article className="relative flex min-h-0 flex-col bg-slate-950 overflow-hidden animate-[fadeIn_300ms_ease-out]">
      {/* ── Map fills entire panel ── */}
      <div className="relative z-0 min-h-0 flex-1">
        <div ref={mapHostRef} className="h-full w-full" />

        {/* ── Panel header overlay (top-left, below app header, clears zoom controls) ── */}
        <div className="pointer-events-none absolute left-14 right-14 z-[530]" style={{ top: MAP_OVERLAY_TOP }}>
          <PanelChrome
            modelKey={panel.modelKey}
            status={panelStatus}
            loadedCount={browserLoadedCount}
            totalHours={totalHours}
            runLabel={runLabel}
            selectedRunId={selectedRunId}
            runOptions={runState.runs}
            frameHour={resolvedFrame?.hour ?? null}
            validLabel={validLabel}
            frameOptions={frameOptions}
            menuOpen={menuOpen}
            parameterMenuOpen={parameterMenuOpen}
            parameterOptions={parameterOptions}
            selectedLayers={selectedLayers}
            canRemove={canRemove}
            onToggleMenu={() => setMenuOpen((open) => !open)}
            onToggleParameterMenu={() => setParameterMenuOpen((open) => !open)}
            onLayerToggle={(layer) => onLayerToggle(panel.id, layer)}
            onModelChange={(modelKey) => onModelChange(panel.id, modelKey)}
            onRunChange={(runId) => onRunChange(panel.id, runId)}
            onSelectValidTime={(validTime) => onSelectValidTime(panel.id, validTime)}
            onRemove={() => onRemove(panel.id)}
          />
        </div>

        {/* ── Hover overlay (top-right) ── */}
        <div
          className={`pointer-events-none absolute right-3 z-[520] transition-opacity duration-150 ${
            hoverLatLng ? "opacity-100" : "opacity-0"
          }`}
          style={{ top: "calc(var(--chrome-top, 96px) + 112px)" }}
        >
          {hoverLatLng ? (
            <div className="pointer-events-auto min-w-[170px] rounded-lg glass-panel px-3 py-2 text-[11px] text-slate-100 shadow-xl">
              <p className="m-0 font-mono text-slate-400">
                {formatCoordinate(hoverLatLng.lat, "N", "S")} {formatCoordinate(hoverLatLng.lng, "E", "W")}
              </p>
              <div className="mt-1.5 grid gap-0.5">
                {hoverLoading ? (
                  <p className="m-0 text-slate-400">Loading values...</p>
                ) : (
                  <>
                    {hoverParameterRows.map((legend) => (
                      <HoverLine
                        key={legend.key}
                        label={legend.label}
                        value={formatHoverLayerValue(hoverValues.byLayer[legend.key], legend.unit)}
                      />
                    ))}
                    {activeLayers.has("synoptic") && (showIsobars || showCenters) ? (
                      <HoverLine label="MSLP" value={formatHoverLayerValue(hoverValues.pressureHpa, "hPa")} />
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* ── Legends (bottom-left, above timeline) ── */}
        {legendItems.length > 0 ? (
          <div
            className={`pointer-events-none absolute left-3 z-[510] grid gap-2 ${
              hasExpandedLegend ? "w-[min(440px,calc(100%-1.5rem))]" : "w-[min(300px,calc(100%-1.5rem))]"
            }`}
            style={{ bottom: MAP_OVERLAY_BOTTOM }}
          >
            {legendItems.map((legend) => (
              <LegendCard key={legend.key} legend={legend} />
            ))}
          </div>
        ) : null}

        {/* ── Empty / error states ── */}
        {emptyMessage ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/35 text-sm text-slate-200">
            {emptyMessage}
          </div>
        ) : null}
        {manifestState.error ? (
          <div
            className="pointer-events-none absolute left-14 z-[520] rounded-lg bg-rose-950/80 px-3 py-1.5 text-xs text-rose-200 shadow-lg"
            style={{ top: "calc(var(--chrome-top, 96px) + 70px)" }}
          >
            {manifestState.error}
          </div>
        ) : null}

        <SoundingDrawer
          open={soundingOpen}
          loading={soundingLoading}
          error={soundingError}
          sounding={sounding}
          point={soundingPoint ? { lat: soundingPoint.lat, lon: soundingPoint.lng } : null}
          forecastHour={frame?.hour ?? null}
          validLabel={validLabel}
          onRequestPoint={(lat, lon) => requestPointSounding(L.latLng(lat, lon))}
          onClose={() => {
            soundingAbortRef.current?.abort();
            setSoundingLoading(false);
            setSoundingOpen(false);
            setSoundingPoint(null);
          }}
        />

        {/* ── Footer gradient overlay (above timeline) ── */}
        <footer
          className="pointer-events-none absolute inset-x-0 z-[505] flex items-center justify-between bg-gradient-to-t from-slate-950/50 to-transparent px-3 py-1.5 text-[10px] text-slate-400/70"
          style={{ bottom: "var(--chrome-bottom, 72px)" }}
        >
          <span>Source {manifestState.manifest?.openDataModel || "NOAA"}</span>
          <span>Valid {validLabel}</span>
        </footer>
      </div>
    </article>
  );
}

function formatHoverLayerValue(value: number | null | undefined, unit: string | null | undefined): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  const formattedUnit = formatHoverUnit(unit);
  const suffix = formattedUnit ? ` ${formattedUnit}` : "";
  return `${(value as number).toFixed(hoverDigitsForUnit(unit))}${suffix}`;
}

function formatHoverUnit(unit: string | null | undefined): string {
  const normalized = String(unit || "").trim();
  if (normalized === "F") {
    return "°F";
  }
  if (normalized === "C") {
    return "°C";
  }
  return normalized;
}

function hoverDigitsForUnit(unit: string | null | undefined): number {
  const normalized = String(unit || "").trim();
  if (normalized === "F" || normalized === "C" || normalized === "mi" || normalized === "mm") {
    return 1;
  }
  if (normalized === "in") {
    return 2;
  }
  if (normalized === "in/hr") {
    return 3;
  }
  if (
    normalized === "%" ||
    normalized === "mph" ||
    normalized === "kt" ||
    normalized === "dBZ" ||
    normalized === "hPa" ||
    normalized === "m" ||
    normalized === "ft" ||
    normalized === "J/kg" ||
    normalized === "m2/s2"
  ) {
    return 0;
  }
  return 1;
}

function LegendCard({ legend }: { legend: LayerLegendConfig }) {
  const title = legend.unit ? `${legend.label} (${legend.unit})` : legend.label;
  const isPrecipTypeLegend = legend.legendType === "precip-type-reflectivity" && Array.isArray(legend.precipTypeLegend);
  const isPrecipRateTypeLegend = legend.legendType === "precip-rate-type" && Array.isArray(legend.precipRateTypeLegend);
  const isHeightContourLegend = legend.legendType === "height-contour";
  const isVectorLegend = legend.legendType === "vector";
  return (
    <div className="pointer-events-auto rounded-lg glass-panel px-3 py-2 text-[11px] text-slate-100 shadow-lg">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span className="font-medium leading-tight">{title}</span>
        {legend.thresholdNote ? (
          <span className="max-w-[210px] text-right text-[10px] leading-tight text-slate-300/70">
            {legend.thresholdNote}
          </span>
        ) : null}
      </div>
      {isPrecipTypeLegend ? (
        <PrecipTypeReflectivityLegend legend={legend} />
      ) : isPrecipRateTypeLegend ? (
        <PrecipRateTypeLegend legend={legend} />
      ) : isHeightContourLegend ? (
        <HeightContourLegend legend={legend} />
      ) : isVectorLegend ? (
        <VectorLegend />
      ) : (
        <GradientLegend legend={legend} />
      )}
    </div>
  );
}

function HeightContourLegend({ legend }: { legend: LayerLegendConfig }) {
  const interval = Number(legend.contourIntervalDam);
  return (
    <div className="flex items-center gap-2 text-[10px] text-slate-300">
      <span className="h-0 w-16 rounded-full border-t-[2px] border-slate-950 shadow-[0_0_0_1px_rgba(255,255,255,0.45)]" />
      <span className="font-mono">
        {Number.isFinite(interval) && interval > 0 ? `${formatTick(interval)} dam` : "contours"}
      </span>
    </div>
  );
}

function VectorLegend() {
  return (
    <div className="flex items-center gap-2 text-[10px] text-slate-300">
      <span className="relative h-4 w-16">
        <span className="absolute left-1 top-1/2 h-0 w-11 -translate-y-1/2 rounded-full border-t-[2px] border-slate-50 shadow-[0_0_0_2px_rgba(7,17,31,0.65)]" />
        <span className="absolute right-1 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45 border-r-[2px] border-t-[2px] border-slate-50 shadow-[1px_-1px_0_1px_rgba(7,17,31,0.45)]" />
      </span>
      <span>sampled motion vectors</span>
    </div>
  );
}

function GradientLegend({ legend }: { legend: LayerLegendConfig }) {
  const hasPositionedTicks =
    Array.isArray(legend.legendTickPositions) &&
    legend.legendTickPositions.length === legend.legendTicks.length &&
    legend.legendTicks.length > 0;
  return (
    <>
      <div className="h-3 rounded-full shadow-sm" style={{ background: legend.legendGradientCss }} />
      {hasPositionedTicks ? (
        <div className="relative mt-1 h-3 font-mono text-[10px] text-slate-400">
          {legend.legendTicks.map((tick, index) => {
            const position = Math.max(0, Math.min(1, Number(legend.legendTickPositions?.[index]) || 0));
            const transform =
              position <= 0.035 ? "translateX(0)" : position >= 0.965 ? "translateX(-100%)" : "translateX(-50%)";
            return (
              <span
                key={`${legend.key}-${tick}`}
                className="absolute top-0 whitespace-nowrap"
                style={{ left: `${(position * 100).toFixed(3)}%`, transform }}
              >
                {formatTick(tick)}
              </span>
            );
          })}
        </div>
      ) : legend.legendTicks.length > 0 ? (
        <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-400">
          {legend.legendTicks.map((tick) => (
            <span key={`${legend.key}-${tick}`}>{formatTick(tick)}</span>
          ))}
        </div>
      ) : null}
    </>
  );
}

function PrecipRateTypeLegend({ legend }: { legend: LayerLegendConfig }) {
  const rows = legend.precipRateTypeLegend || [];
  return (
    <div className="grid gap-1.5">
      {rows.map((row) => {
        const visibleBins = row.bins.filter((bin) => Number(bin.color?.[3]) > 0);
        const bins = visibleBins.length > 0 ? visibleBins : row.bins;
        return (
          <div key={row.key} className="grid grid-cols-[82px_1fr] items-center gap-2">
            <span className="truncate text-[10px] font-medium text-slate-200">{row.label}</span>
            <div className="min-w-0">
              <div
                className="grid h-3.5 overflow-hidden rounded-sm shadow-sm ring-1 ring-white/10"
                style={{ gridTemplateColumns: `repeat(${Math.max(1, bins.length)}, minmax(0, 1fr))` }}
              >
                {bins.map((bin, index) => (
                  <span
                    key={`${row.key}-${bin.label || index}`}
                    className="block h-full"
                    style={{ background: legendColorToCss(bin.color) }}
                  />
                ))}
              </div>
              {row.tickLabels && row.tickLabels.length > 0 ? (
                <div className="mt-0.5 flex justify-between font-mono text-[9px] leading-none text-slate-400">
                  {row.tickLabels.map((tick) => (
                    <span key={`${row.key}-${tick}`}>{formatTick(tick)}</span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PrecipTypeReflectivityLegend({ legend }: { legend: LayerLegendConfig }) {
  const rows = legend.precipTypeLegend || [];
  return (
    <div className="grid gap-1.5">
      {rows.map((row) => {
        const visibleBins = row.bins.filter((bin) => Number(bin.color?.[3]) > 0);
        const bins = visibleBins.length > 0 ? visibleBins : row.bins;
        return (
          <div key={row.key} className="grid grid-cols-[82px_1fr] items-center gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[10px] font-medium text-slate-200">{row.label}</span>
              {row.filterDbz != null && Number.isFinite(Number(row.filterDbz)) ? (
                <span className="shrink-0 rounded-sm bg-slate-950/45 px-1 py-0.5 font-mono text-[9px] text-slate-300">
                  &gt;={formatTick(Number(row.filterDbz))}
                </span>
              ) : null}
            </div>
            <div className="min-w-0">
              <div
                className="grid h-3.5 overflow-hidden rounded-sm shadow-sm ring-1 ring-white/10"
                style={{ gridTemplateColumns: `repeat(${Math.max(1, bins.length)}, minmax(0, 1fr))` }}
              >
                {bins.map((bin, index) => (
                  <span
                    key={`${row.key}-${bin.label || index}`}
                    className="block h-full"
                    style={{ background: legendColorToCss(bin.color) }}
                  />
                ))}
              </div>
              {row.tickLabels && row.tickLabels.length > 0 ? (
                <div className="mt-0.5 flex justify-between font-mono text-[9px] leading-none text-slate-400">
                  {row.tickLabels.map((tick) => (
                    <span key={`${row.key}-${tick}`}>{formatTick(tick)}</span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function legendColorToCss(color: [number, number, number, number]): string {
  const alpha = Math.max(0, Math.min(1, Number(color[3]) || 0));
  return `rgba(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])}, ${alpha.toFixed(3)})`;
}

function HoverLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="m-0 flex items-center justify-between gap-2 text-[11px] text-slate-100">
      <span className="min-w-0 truncate text-slate-400">{label}</span>
      <span className="shrink-0 font-mono">{value}</span>
    </p>
  );
}
