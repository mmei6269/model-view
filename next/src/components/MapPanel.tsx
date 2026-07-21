import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import SoundingDrawer from "./SoundingDrawer";
import { MODEL_CONFIG } from "../config/constants";
import { basemapInkTheme, type BasemapInkTheme, type MapDisplaySettings } from "../config/display";
import { getFrameAwareLayerLegendConfig, getLayerStackOrder, type LayerLegendConfig } from "../config/layers";
import { fetchPointSoundingPayload, formatRunLabel, resolveFrameByValidTime } from "../core/artifact-client";
import { FramePrefetchEngine, subscribeFramePrefetchCacheChanges } from "../core/frame-prefetch";
import { humanizeArtifactError } from "../core/humanize-error";
import { startLatestRunMemoryWarmup } from "../core/latest-run-memory-cache";
import type { EngineFatal, LatLon, MapEngine, MarkerHandle } from "../core/map-engine/types";
import { formatValidLabel, normalizeIsoHour, pickInitialValidTime } from "../core/time";
import { useManifest } from "../hooks/useManifest";
import { useModelRuns } from "../hooks/useModelRuns";
import { formatCoordinate, formatTick, formatUnitDisplay } from "./map-panel/format-utils";
import { PanelChrome } from "./map-panel/PanelChrome";
import { useFrameStatus } from "./map-panel/use-frame-status";
import { useHoverGrid } from "./map-panel/use-hover-grid";
import { describeMissingHoverValue } from "./map-panel/hover-utils";
import { buildPhysicalRateLegend } from "./map-panel/legend-utils";
import { useMapDisplayLayers } from "./map-panel/use-map-display-layers";
import { useMapFeatureLayers } from "./map-panel/use-map-feature-layers";
import { useContourVectorLayers } from "./map-panel/use-contour-vector";
import { usePanelMap } from "./map-panel/use-panel-map";
import { clearHoverBroadcastIfOwnedBy, publishHover, subscribeHover, type HoverBroadcast } from "../core/hover-bus";
import { usePanelChromeData } from "./map-panel/use-panel-chrome-data";
import { usePressureMarkers } from "./map-panel/use-pressure-markers";
import { normalizeExplicitSynopticCenters } from "./map-panel/synoptic-geojson";
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

// DOM map-marker accents per basemap ink theme (Task 4.3r3): the app's cyan
// accent (#22d3ee) reads on dark ground but washes out on the near-white
// light basemap — the light variants deepen to cyan-700.
const MAP_MARKER_ACCENTS = {
  dark: { ring: "#22d3ee", crosshairFill: "rgba(34,211,238,0.2)", crosshairGlow: "rgba(34,211,238,0.6)" },
  light: { ring: "#0e7490", crosshairFill: "rgba(14,116,144,0.15)", crosshairGlow: "rgba(14,116,144,0.45)" },
} as const;

interface MapPanelProps {
  panel: PanelState;
  viewKey: ViewKey;
  selectedValidTimeIso: ValidTimeIso | null;
  initialValidTimeIso: ValidTimeIso | null;
  showIsobars: boolean;
  showThickness: boolean;
  showCenters: boolean;
  synopticDetailMode: SynopticDetailMode;
  reflectivityGate: ReflectivityGateDbz;
  display: MapDisplaySettings;
  timeZone: string;
  canRemove: boolean;
  layoutVersion: number;
  onMapReady: (panelId: string, engine: MapEngine) => void;
  onMapDestroyed: (panelId: string) => void;
  onAvailableValidTimesChange: (panelId: string, validTimes: ValidTimeIso[]) => void;
  onResolvedFrameChange: (panelId: string, frame: ResolvedFrame | null) => void;
  onLayerToggle: (panelId: string, layer: LayerKey) => void;
  onSelectValidTime: (panelId: string, value: ValidTimeIso) => void;
  onModelChange: (panelId: string, modelKey: ModelKey) => void;
  onRunChange: (panelId: string, runId: string | null) => void;
  onRemove: (panelId: string) => void;
  onManifestInfoChange: (panelId: string, info: ManifestUiInfo) => void;
  // Grid-row awareness: overlays clear the app header only when this panel is
  // in the top row, and the timeline only when it is in the bottom row.
  insetForHeader: boolean;
  insetForTimeline: boolean;
  // Quarter-height panels render tighter chrome and narrower legends.
  compact: boolean;
  // Restored center/zoom for this view; applied on the map's initial fit.
  initialViewport: { lat: number; lon: number; zoom: number } | null;
  onViewportChange: (panelId: string, viewport: { lat: number; lon: number; zoom: number }) => void;
  // Bumped by App when Escape is pressed; the panel closes its own transient
  // surfaces (sounding drawer, panel menus) in response.
  escapeNonce: number;
}

const MAP_OVERLAY_GAP = "12px";
// Per-panel insets (set as CSS vars on the panel root from the grid-row
// props); every overlay offsets from these instead of the global chrome vars.
const MAP_OVERLAY_TOP = `calc(var(--panel-inset-top, 0px) + ${MAP_OVERLAY_GAP})`;
const MAP_OVERLAY_BOTTOM = `calc(var(--panel-inset-bottom, 0px) + ${MAP_OVERLAY_GAP})`;

export default function MapPanel({
  panel,
  viewKey,
  selectedValidTimeIso,
  initialValidTimeIso,
  showIsobars,
  showThickness,
  showCenters,
  synopticDetailMode,
  reflectivityGate,
  display,
  timeZone,
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
  insetForHeader,
  insetForTimeline,
  compact,
  initialViewport,
  onViewportChange,
  escapeNonce,
}: MapPanelProps) {
  const mapHostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapEngine | null>(null);
  const synopticVectorKeyRef = useRef<string>("");
  const hoverAbortRef = useRef<AbortController | null>(null);
  const hoverGridKeyRef = useRef<string>("");
  const vectorAbortRef = useRef<AbortController | null>(null);
  const soundingAbortRef = useRef<AbortController | null>(null);
  const soundingMarkerRef = useRef<MarkerHandle | null>(null);
  // The pin's caller-owned DOM element, kept so a basemap theme flip can
  // restyle the live marker in place (MarkerHandle exposes no element).
  const soundingMarkerElRef = useRef<HTMLDivElement | null>(null);
  // Model/run that produced the current sounding payload; compared against the
  // panel's current model/run to detect a stale profile under an open drawer.
  const soundingSourceRef = useRef<{ model: ModelKey; runId: string } | null>(null);
  // Last frame hour the sounding was sampled at (or tracked while follow is
  // off); guards the follow-timeline effect against firing on mount/toggle.
  const followHourRef = useRef<number | null>(null);
  const prefetchEngineRef = useRef<FramePrefetchEngine | null>(null);
  const pendingPrefetchStatusRef = useRef<Map<number, PrefetchState>>(new Map());
  const prefetchStatusRafRef = useRef<number | null>(null);
  const hasInitialViewportFitRef = useRef(false);
  const lastViewportFitKeyRef = useRef<string>("");

  const [menuOpen, setMenuOpen] = useState(false);
  const [parameterMenuOpen, setParameterMenuOpen] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  // Fatal engine failure, classed (basemap unavailable vs repeated GL
  // context loss — the banner headline keys on it); cleared by usePanelMap
  // whenever a fresh engine boots and by the engine itself on recovery.
  const [engineFatal, setEngineFatal] = useState<EngineFatal | null>(null);
  const [mapZoom, setMapZoom] = useState(0);
  const [hoverLatLng, setHoverLatLng] = useState<LatLon | null>(null);
  // Another panel's live cursor (cross-panel hover mirror); null while this
  // panel is hovered directly or nothing is hovered anywhere.
  const [remoteHover, setRemoteHover] = useState<HoverBroadcast | null>(null);
  const remoteCrosshairRef = useRef<MarkerHandle | null>(null);
  // Same element-restyle hatch as soundingMarkerElRef above.
  const remoteCrosshairElRef = useRef<HTMLDivElement | null>(null);
  const [soundingPoint, setSoundingPoint] = useState<LatLon | null>(null);
  const [sounding, setSounding] = useState<PointSoundingPayload | null>(null);
  const [soundingLoading, setSoundingLoading] = useState(false);
  const [soundingError, setSoundingError] = useState<string | null>(null);
  const [soundingOpen, setSoundingOpen] = useState(false);
  const [soundingPointManual, setSoundingPointManual] = useState(false);
  const [followTimeline, setFollowTimeline] = useState(false);
  const [prefetchByHour, setPrefetchByHour] = useState<Record<number, PrefetchState>>({});
  const [prefetchCacheRevision, setPrefetchCacheRevision] = useState(0);

  const flushPendingPrefetchStatuses = useCallback((): void => {
    prefetchStatusRafRef.current = null;
    if (pendingPrefetchStatusRef.current.size === 0) {
      return;
    }
    const pending = new Map(pendingPrefetchStatusRef.current);
    pendingPrefetchStatusRef.current.clear();
    setPrefetchByHour((prev) => {
      let next = prev;
      for (const [hour, status] of pending) {
        if (prev[hour] === status) {
          continue;
        }
        if (next === prev) {
          next = { ...prev };
        }
        next[hour] = status;
      }
      return next;
    });
  }, []);
  const queuePrefetchStatus = useCallback(
    (hour: number, status: PrefetchState): void => {
      pendingPrefetchStatusRef.current.set(hour, status);
      if (prefetchStatusRafRef.current === null) {
        // A hot cache can complete a full horizon in one burst. Commit at most
        // one React state update per paint instead of one update per asset;
        // every hour still receives its latest state from the map above.
        prefetchStatusRafRef.current = window.requestAnimationFrame(flushPendingPrefetchStatuses);
      }
    },
    [flushPendingPrefetchStatuses],
  );
  const clearPendingPrefetchStatuses = useCallback((): void => {
    if (prefetchStatusRafRef.current !== null) {
      window.cancelAnimationFrame(prefetchStatusRafRef.current);
      prefetchStatusRafRef.current = null;
    }
    pendingPrefetchStatusRef.current.clear();
  }, []);

  const runState = useModelRuns(panel.modelKey, viewKey);
  const selectedRunId = panel.runId || null;
  const manifestState = useManifest(panel.modelKey, viewKey, selectedRunId);
  // Which ground the overlays ink against: selects the per-theme
  // synoptic/contour/center ink sets and the DOM marker accents.
  const inkTheme = basemapInkTheme(display.basemap);
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
  const synopticSelection = useMemo(
    () => ({ showCenters, showIsobars, showThickness }),
    [showCenters, showIsobars, showThickness],
  );

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
  const validLabel = useMemo(
    () => formatValidLabel(frame?.validHourKey || null, timeZone),
    [frame?.validHourKey, timeZone],
  );
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
    synopticSelection,
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
  const { normalizedSynopticVector, synopticVector, synopticVectorStatus } = useSynopticVectorPayload({
    activeLayers,
    frame,
    synopticDetailMode,
    synopticVectorKeyRef,
    vectorAbortRef,
  });
  // Sample this panel's own grid at the local cursor, or at the mirrored
  // cross-panel cursor when another panel is the one being hovered.
  const effectiveHoverLatLng = useMemo<LatLon | null>(() => {
    if (hoverLatLng) {
      return hoverLatLng;
    }
    return remoteHover ? { lat: remoteHover.lat, lon: remoteHover.lon } : null;
  }, [hoverLatLng, remoteHover]);
  const { hoverLoading, hoverValues, setHoverLoading, setHoverValues } = useHoverGrid({
    activeLayers,
    frame,
    hoverAbortRef,
    hoverGridKeyRef,
    hoverLatLng: effectiveHoverLatLng,
  });
  const remoteHoverValidTimesMatch = useMemo(() => {
    if (!remoteHover?.sourceValidTimeIso || !frame?.validHourKey) {
      return false;
    }
    return normalizeIsoHour(remoteHover.sourceValidTimeIso) === normalizeIsoHour(frame.validHourKey);
  }, [frame?.validHourKey, remoteHover?.sourceValidTimeIso]);

  // Broadcast this panel's cursor + sampled values; mirror everyone else's.
  useEffect(() => {
    return subscribeHover((broadcast) => {
      setRemoteHover(broadcast && broadcast.sourcePanelId !== panel.id ? broadcast : null);
    });
  }, [panel.id]);
  useEffect(
    () => () => {
      clearHoverBroadcastIfOwnedBy(panel.id);
    },
    [panel.id],
  );
  useEffect(() => {
    if (hoverLatLng) {
      publishHover({
        sourcePanelId: panel.id,
        sourceModelLabel: MODEL_CONFIG[panel.modelKey].label,
        sourceRunId: manifestState.manifest?.run ?? null,
        sourceValidTimeIso: frame?.validHourKey ?? null,
        lat: hoverLatLng.lat,
        lon: hoverLatLng.lon,
        values: hoverValues.byLayer,
        pressureHpa: hoverValues.pressureHpa,
      });
      return;
    }
    // Only the panel that owns the current broadcast clears it; otherwise a
    // late mouseout would wipe another panel's live broadcast.
    clearHoverBroadcastIfOwnedBy(panel.id);
  }, [frame?.validHourKey, hoverLatLng, hoverValues, manifestState.manifest?.run, panel.id, panel.modelKey]);

  // Mirrored-cursor crosshair on this panel's map.
  useEffect(() => {
    const engine = mapRef.current;
    if (!engine || !mapReady || !remoteHover || hoverLatLng) {
      remoteCrosshairRef.current?.remove();
      remoteCrosshairRef.current = null;
      remoteCrosshairElRef.current = null;
      return;
    }
    const position: LatLon = { lat: remoteHover.lat, lon: remoteHover.lon };
    if (!remoteCrosshairRef.current) {
      // DOM marker: stays crisp above raster overlays at any zoom.
      const el = document.createElement("div");
      el.className = "remote-hover-crosshair";
      el.style.cssText = "width:10px;height:10px;border-radius:9999px";
      remoteCrosshairElRef.current = el;
      remoteCrosshairRef.current = engine.addMarker(el, position, { interactive: false });
    } else {
      remoteCrosshairRef.current.setLatLon(position);
    }
    // Theme-conditional accent, (re)applied every run so a live crosshair
    // follows a basemap theme flip.
    const el = remoteCrosshairElRef.current;
    if (el) {
      const accent = MAP_MARKER_ACCENTS[inkTheme];
      el.style.border = `1.5px solid ${accent.ring}`;
      el.style.background = accent.crosshairFill;
      el.style.boxShadow = `0 0 4px ${accent.crosshairGlow}`;
    }
  }, [hoverLatLng, inkTheme, mapReady, remoteHover]);
  useEffect(() => {
    return () => {
      remoteCrosshairRef.current?.remove();
      remoteCrosshairRef.current = null;
      remoteCrosshairElRef.current = null;
    };
  }, []);
  const { emptyMessage, frameOptions, legendItems, panelStatus, parameterOptions, unavailableLayerLabels } =
    usePanelChromeData({
      activeLayers,
      browserHourStatus,
      effectiveHourStatus,
      frame,
      frameByHour,
      // While the run list is still loading (or failed) we cannot distinguish a
      // fresh empty cache from a transient gap, so treat runs as present to keep
      // the onboarding hint scoped to a confirmed empty cache.
      hasRuns: runState.loading || Boolean(runState.error) || runState.runs.length > 0,
      manifestState,
      plannedHours,
      selectedBrowserFrameStatus,
      selectedLayers,
      synopticSelection,
    });
  const showUnavailableLayerNotice = unavailableLayerLabels.length > 0 && selectedBrowserFrameStatus !== "unavailable";
  const hasExpandedLegend = legendItems.some(
    (legend) => legend.legendType === "precip-type-reflectivity" || legend.legendType === "precip-rate-type",
  );
  const hoverParameterRows = useMemo(
    () =>
      getLayerStackOrder(manifestState.manifest, selectedLayers)
        .filter((key) => key !== "synoptic" && selectedLayers.has(key))
        .map((key) => getFrameAwareLayerLegendConfig(key, manifestState.manifest, frame?.hour))
        .filter((legend): legend is LayerLegendConfig => Boolean(legend)),
    [frame?.hour, manifestState.manifest, selectedLayers],
  );

  const requestPointSounding = useCallback(
    (point: LatLon) => {
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
      setSoundingPoint(point);
      setSoundingOpen(true);
      setSounding(null);
      setSoundingError(null);
      setSoundingLoading(true);
      const requestModel = panel.modelKey;
      const requestRunId = manifestState.manifest.run;
      followHourRef.current = frame.hour;
      void fetchPointSoundingPayload({
        modelKey: requestModel,
        runId: requestRunId,
        viewKey,
        hour: frame.hour,
        lat: point.lat,
        lon: point.lon,
        signal: controller.signal,
      })
        .then((payload) => {
          if (!controller.signal.aborted) {
            soundingSourceRef.current = { model: requestModel, runId: requestRunId };
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
  const handleMapDoubleClick = useCallback(
    (latlon: LatLon) => {
      setSoundingPointManual(false);
      requestPointSounding(latlon);
    },
    [requestPointSounding],
  );
  const handleManualPointRequest = useCallback(
    (lat: number, lon: number) => {
      setSoundingPointManual(true);
      requestPointSounding({ lat, lon });
    },
    [requestPointSounding],
  );

  const closeSounding = useCallback(() => {
    soundingAbortRef.current?.abort();
    setSoundingLoading(false);
    setSoundingOpen(false);
    setSoundingPoint(null);
    setSoundingPointManual(false);
  }, []);

  // Stale notice: the panel's model/run moved underneath an open drawer. The
  // old profile is never silently presented as current; the user chooses to
  // refresh (re-request at the new model/run) or close. Reading the ref during
  // render is safe because it is only written alongside a setSounding call.
  const soundingSource = soundingSourceRef.current;
  const soundingStale =
    soundingOpen &&
    sounding &&
    soundingSource &&
    (soundingSource.model !== panel.modelKey ||
      (manifestState.manifest != null && manifestState.manifest.run !== soundingSource.runId))
      ? `Profile is ${MODEL_CONFIG[soundingSource.model].label} run ${soundingSource.runId}; the panel is now ${
          MODEL_CONFIG[panel.modelKey].label
        }${manifestState.manifest ? ` run ${manifestState.manifest.run}` : ""}.`
      : null;

  const refreshSounding = useCallback(() => {
    if (soundingPoint) {
      requestPointSounding(soundingPoint);
    }
  }, [requestPointSounding, soundingPoint]);

  const recenterOnSoundingPoint = useCallback((lat: number, lon: number) => {
    const engine = mapRef.current;
    if (!engine) {
      return;
    }
    engine.jumpTo({ center: { lat, lon }, zoom: engine.getZoom() });
  }, []);

  // Follow-timeline: an open drawer re-samples the profile when the selected
  // frame hour changes. Debounced so scrubbing coalesces into one request; the
  // hour ref (synced on every request and while the guard fails) keeps the
  // initial mount and toggling follow on from firing a request by themselves.
  // A stale profile never auto-refreshes: the model/run change must stay a
  // visible, user-acknowledged transition.
  useEffect(() => {
    const hour = frame?.hour ?? null;
    if (!followTimeline || !soundingOpen || !soundingPoint || soundingStale !== null || hour === null) {
      followHourRef.current = hour;
      return;
    }
    if (followHourRef.current === hour) {
      return;
    }
    const timer = window.setTimeout(() => {
      requestPointSounding(soundingPoint);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [followTimeline, frame?.hour, requestPointSounding, soundingOpen, soundingPoint, soundingStale]);

  // Escape (global keyboard shortcut) closes this panel's transient surfaces.
  useEffect(() => {
    if (escapeNonce === 0) {
      return;
    }
    closeSounding();
    setMenuOpen(false);
    setParameterMenuOpen(false);
  }, [closeSounding, escapeNonce]);

  usePanelMap({
    panelId: panel.id,
    viewKey,
    layoutVersion,
    mapReady,
    initialViewport,
    onViewportChange,
    mapHostRef,
    mapRef,
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
    onEngineFatal: setEngineFatal,
  });

  useEffect(() => {
    const engine = mapRef.current;
    if (!mapReady || !engine) {
      return;
    }
    if (!soundingPoint) {
      soundingMarkerRef.current?.remove();
      soundingMarkerRef.current = null;
      soundingMarkerElRef.current = null;
      return;
    }
    if (!soundingMarkerRef.current) {
      // DOM circle (radius 6, stroke 2): 14px outer ring (6 + half the
      // stroke each side), theme-accent stroke (cyan on dark, cyan-700 on
      // light), dark 85%-opacity fill — the dark dot reads on both grounds.
      const el = document.createElement("div");
      el.style.cssText = "width:14px;height:14px;border-radius:9999px;background:rgba(2,9,20,0.85)";
      soundingMarkerElRef.current = el;
      soundingMarkerRef.current = engine.addMarker(el, soundingPoint, { interactive: false });
    } else {
      soundingMarkerRef.current.setLatLon(soundingPoint);
    }
    // Theme-conditional ring, (re)applied every run so a live pin follows a
    // basemap theme flip.
    if (soundingMarkerElRef.current) {
      soundingMarkerElRef.current.style.border = `2px solid ${MAP_MARKER_ACCENTS[inkTheme].ring}`;
    }
  }, [inkTheme, mapReady, mapRef, soundingPoint]);

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
    engineRef: mapRef,
  });
  useMapFeatureLayers({
    display,
    mapReady,
    mapZoom,
    engineRef: mapRef,
  });
  // Synoptic/contour vector renderers (Tasks 4.2/4.3): native GL line +
  // symbol layers (contour lines, value labels, H/L centers) through the
  // engine.
  const { failedLayerKeys: failedContourVectorLayerKeys, vectorLayerKeys: contourVectorLayerKeys } =
    useContourVectorLayers({
      activeLayers,
      basemapTheme: inkTheme,
      engineRef: mapRef,
      frame,
      mapReady,
    });
  const vectorFallbackLabels = useMemo(() => {
    const labels: string[] = [];
    for (const layerKey of failedContourVectorLayerKeys) {
      labels.push(getFrameAwareLayerLegendConfig(layerKey, manifestState.manifest, frame?.hour)?.label || layerKey);
    }
    return labels;
  }, [failedContourVectorLayerKeys, frame?.hour, manifestState.manifest]);
  const allowSynopticRasterFallback = showIsobars && showThickness;
  const synopticVectorNotice = useMemo(() => {
    if (!activeLayers.has("synoptic") || (!showIsobars && !showThickness)) {
      return null;
    }
    const hasCombinedRaster = Boolean(frame?.layers?.synoptic);
    const fallbackDescription = allowSynopticRasterFallback
      ? hasCombinedRaster
        ? "Simple combined isobar/thickness raster shown."
        : "No line fallback is available."
      : "Combined raster hidden to honor the independent Isobars/Thickness toggles.";
    if (synopticDetailMode === "detailed" && synopticVectorStatus === "loading") {
      return `Detailed synoptic vectors loading. ${fallbackDescription}`;
    }
    if (synopticVectorStatus === "fallback") {
      return `${synopticDetailMode === "detailed" ? "Detailed" : "Simple"} synoptic vectors unavailable. ${fallbackDescription}`;
    }
    if (synopticVectorStatus === "loading" && !allowSynopticRasterFallback) {
      return `Synoptic vectors loading. ${fallbackDescription}`;
    }
    return null;
  }, [
    activeLayers,
    allowSynopticRasterFallback,
    frame?.layers?.synoptic,
    showIsobars,
    showThickness,
    synopticDetailMode,
    synopticVectorStatus,
  ]);
  useWeatherOverlays({
    activeLayers,
    frame,
    mapReady,
    engineRef: mapRef,
    reflectivityGate,
    // A fetched vector payload suppresses its raster twin (no double-render).
    contourVectorLayerKeys,
    synopticVector,
    allowSynopticRasterFallback,
  });
  useSynopticVectorLayer({
    activeLayers,
    basemapTheme: inkTheme,
    engineRef: mapRef,
    mapReady,
    showIsobars,
    showThickness,
    synopticVector,
  });
  usePressureMarkers({
    activeLayers,
    basemapTheme: inkTheme,
    engineRef: mapRef,
    frameSynopticCenters: frame?.synopticCenters,
    mapReady,
    // A normalized null payload contains an empty center collection, but
    // null here means the selected frame/mode is still loading or failed.
    // Preserve the manifest's canonical H/L roster until a vector payload
    // actually resolves with a `centers` field; an explicitly present-empty
    // field then remains authoritative and clears the markers. Legacy vector
    // payloads that omit centers continue to use the manifest roster.
    normalizedSynopticCenters: normalizeExplicitSynopticCenters(synopticVector),
    showCenters,
  });

  useEffect(() => {
    return subscribeFramePrefetchCacheChanges(() => {
      setPrefetchCacheRevision((revision) => revision + 1);
    });
  }, []);

  useEffect(() => {
    onAvailableValidTimesChange(panel.id, availableValidTimes);
    if (!selectedValidTimeIso && availableValidTimes.length > 0) {
      // No prior selection: URL hour (when present and valid) > nearest-to-now,
      // skipping frames the manifest marks unavailable/errored.
      onSelectValidTime(
        panel.id,
        pickInitialValidTime(initialValidTimeIso, availableValidTimes, frameStatusByValidTime),
      );
    }
  }, [
    availableValidTimes,
    frameStatusByValidTime,
    initialValidTimeIso,
    onAvailableValidTimesChange,
    onSelectValidTime,
    panel.id,
    selectedValidTimeIso,
  ]);

  useEffect(() => {
    onResolvedFrameChange(panel.id, resolvedFrame);
  }, [onResolvedFrameChange, panel.id, resolvedFrame]);

  useEffect(() => {
    const info: ManifestUiInfo = {
      runLabel,
      validLabel,
      manifestPhase: manifestState.error
        ? "error"
        : manifestState.loading
          ? "loading"
          : manifestState.manifest
            ? "ready"
            : "empty",
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
    manifestState.error,
    manifestState.loading,
    manifestState.manifest,
    onManifestInfoChange,
    panel.id,
    resolvedFrame?.hour,
    resolvedFrame?.validHourKey,
    runLabel,
    totalFrameCountByValidTime,
    validLabel,
  ]);

  useEffect(() => {
    clearPendingPrefetchStatuses();
    setPrefetchByHour({});
  }, [clearPendingPrefetchStatuses, prefetchPlanKey]);

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
    const anchorHour = Number(frame?.hour ?? manifestState.manifest.frames[0]?.hour);
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
      onStatus: queuePrefetchStatus,
    });
  }, [
    activeLayers,
    frame?.hour,
    manifestState.manifest,
    prefetchPlanKey,
    queuePrefetchStatus,
    reflectivityGate,
    synopticDetailMode,
  ]);

  useEffect(() => {
    return () => {
      clearPendingPrefetchStatuses();
      prefetchEngineRef.current?.stop();
    };
  }, [clearPendingPrefetchStatuses]);

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
        activeLayers,
        reflectivityGate,
        synopticDetailMode,
      });
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [
    activeLayers,
    frame,
    frame?.hour,
    manifestState.manifest,
    panel.modelKey,
    reflectivityGate,
    selectedBrowserFrameStatus,
    synopticDetailMode,
    viewKey,
  ]);

  return (
    <article
      className="relative flex min-h-0 flex-col overflow-hidden bg-slate-950 animate-[fadeIn_300ms_ease-out]"
      style={
        {
          "--panel-inset-top": insetForHeader ? "var(--chrome-top, 96px)" : "0px",
          "--panel-inset-bottom": insetForTimeline ? "var(--chrome-bottom, 72px)" : "0px",
        } as CSSProperties
      }
    >
      {/* ── Map fills entire panel ── */}
      <div className="relative z-0 min-h-0 flex-1">
        <div ref={mapHostRef} data-testid="map-canvas-host" className="h-full w-full" />

        {/* ── Panel header overlay (top-left, below app header, clears zoom controls) ── */}
        <div className="pointer-events-none absolute left-14 right-14 z-[530]" style={{ top: MAP_OVERLAY_TOP }}>
          <PanelChrome
            compact={compact}
            modelKey={panel.modelKey}
            referenceTime={manifestState.manifest?.referenceTime ?? null}
            status={panelStatus}
            loadedCount={browserLoadedCount}
            totalHours={totalHours}
            runLabel={runLabel}
            currentRunId={manifestState.manifest?.run ?? null}
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

        {/* ── Hover overlay (top-right): local cursor, or the mirrored
            cross-panel cursor with Δ vs the hovered panel ── */}
        <div
          className={`pointer-events-none absolute right-3 z-[520] transition-opacity duration-150 ${
            effectiveHoverLatLng ? "opacity-100" : "opacity-0"
          }`}
          style={{ top: "calc(var(--panel-inset-top, 0px) + 112px)" }}
        >
          {effectiveHoverLatLng ? (
            <div
              className="min-w-[170px] rounded-lg glass-panel px-3 py-2 text-[11px] text-slate-100 shadow-xl"
              data-testid={hoverLatLng ? "hover-readout" : "hover-readout-mirrored"}
            >
              <p className="m-0 font-mono text-slate-400">
                {formatCoordinate(effectiveHoverLatLng.lat, "N", "S")}{" "}
                {formatCoordinate(effectiveHoverLatLng.lon, "E", "W")}
              </p>
              {!hoverLatLng && remoteHover ? (
                <>
                  <p className="m-0 text-[10px] text-cyan-300/80">
                    {remoteHoverValidTimesMatch ? "Δ" : "Cursor"} vs {remoteHover.sourceModelLabel}
                    {remoteHover.sourceRunId ? ` · ${remoteHover.sourceRunId}` : ""}
                  </p>
                  {!remoteHoverValidTimesMatch ? (
                    <p
                      className="m-0 mt-0.5 max-w-[260px] text-[10px] leading-3 text-amber-200"
                      data-testid="hover-valid-time-mismatch"
                    >
                      Numeric Δ suppressed: source valid {formatValidLabel(remoteHover.sourceValidTimeIso, timeZone)};
                      this panel valid {formatValidLabel(frame?.validHourKey ?? null, timeZone)}.
                    </p>
                  ) : null}
                </>
              ) : null}
              <div className="mt-1.5 grid gap-0.5">
                {hoverLoading ? (
                  <p className="m-0 text-slate-400">Loading values...</p>
                ) : (
                  <>
                    {hoverParameterRows.map((legend) => (
                      <HoverLine
                        key={legend.key}
                        label={legend.label}
                        value={formatHoverLayerReadout(legend.key, hoverValues.byLayer, legend.unit)}
                        diff={
                          !hoverLatLng && remoteHover && remoteHoverValidTimesMatch
                            ? formatHoverDiff(hoverValues.byLayer[legend.key], remoteHover.values[legend.key])
                            : null
                        }
                      />
                    ))}
                    {activeLayers.has("synoptic") && (showIsobars || showCenters) ? (
                      <HoverLine
                        label="MSLP"
                        value={formatHoverLayerValue(hoverValues.pressureHpa, "hPa")}
                        diff={
                          !hoverLatLng && remoteHover && remoteHoverValidTimesMatch
                            ? formatHoverDiff(hoverValues.pressureHpa, remoteHover.pressureHpa)
                            : null
                        }
                      />
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
              hasExpandedLegend
                ? compact
                  ? "w-[min(340px,calc(100%-1.5rem))]"
                  : "w-[min(440px,calc(100%-1.5rem))]"
                : compact
                  ? "w-[min(240px,calc(100%-1.5rem))]"
                  : "w-[min(300px,calc(100%-1.5rem))]"
            }`}
            style={{ bottom: MAP_OVERLAY_BOTTOM }}
          >
            {legendItems.map((legend) => (
              <LegendCard key={legend.key} legend={legend} basemapTheme={inkTheme} />
            ))}
          </div>
        ) : null}

        {synopticVectorNotice || vectorFallbackLabels.length > 0 || showUnavailableLayerNotice ? (
          <div
            className="pointer-events-none absolute right-3 z-[515] max-w-[300px] rounded border border-amber-300/25 bg-amber-950/80 px-2 py-1 text-[10px] leading-4 text-amber-100 shadow-lg"
            style={{ bottom: MAP_OVERLAY_BOTTOM }}
            role="status"
            data-testid="vector-raster-fallback-status"
          >
            {showUnavailableLayerNotice ? (
              <span data-testid="layer-unavailable-status">
                Unavailable for this frame: {unavailableLayerLabels.join(", ")}. Other selected layers remain visible.
                {synopticVectorNotice || vectorFallbackLabels.length > 0 ? " " : null}
              </span>
            ) : null}
            {synopticVectorNotice}
            {synopticVectorNotice && vectorFallbackLabels.length > 0 ? " " : null}
            {vectorFallbackLabels.length > 0
              ? `Raster fallback active: ${vectorFallbackLabels.join(", ")} vector data could not be loaded.`
              : null}
          </div>
        ) : null}

        {/* ── Empty / error states ── */}
        {emptyMessage ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/35 text-sm text-slate-200">
            {emptyMessage}
          </div>
        ) : null}
        {manifestState.error || runState.error || engineFatal ? (
          <div
            className="pointer-events-auto absolute left-14 z-[540] grid max-w-md gap-1 rounded-lg bg-rose-950/80 px-3 py-1.5 text-xs text-rose-200 shadow-lg"
            style={{ top: "calc(var(--panel-inset-top, 0px) + 70px)" }}
          >
            {engineFatal ? (
              // Headline keyed on the failure class (Task 5.2): a missing
              // basemap has a one-command fix; repeated context loss is a
              // GPU/driver problem and telling the user to re-fetch data
              // would be a lie; WebGL never initializing at all (Task 6.1)
              // is a browser/GPU setting, so name that.
              <div data-testid="engine-fatal-error" className="grid gap-0.5">
                <span className="min-w-0 break-words">
                  {engineFatal.kind === "context-loss" ? (
                    <>
                      Map rendering failed — the browser lost its GPU (WebGL) context repeatedly. Check hardware
                      acceleration (<code className="font-mono">chrome://gpu</code>) or close other GPU-heavy tabs, then
                      reload.
                    </>
                  ) : engineFatal.kind === "webgl-init" ? (
                    <>
                      Map rendering unavailable — WebGL could not be initialized in this browser. Enable WebGL /
                      hardware acceleration (<code className="font-mono">chrome://gpu</code>) or try another browser,
                      then reload.
                    </>
                  ) : (
                    <>
                      Basemap unavailable — run <code className="font-mono">npm run basemap:fetch</code> (see README).
                    </>
                  )}
                </span>
                <span className="min-w-0 break-words text-[10px] text-rose-300/70">{engineFatal.message}</span>
              </div>
            ) : null}
            {manifestState.error ? (
              <div data-testid="manifest-error" className="flex items-start gap-2">
                <span className="min-w-0 break-words">{manifestState.error}</span>
                <button
                  type="button"
                  onClick={manifestState.retry}
                  className="h-6 shrink-0 rounded border border-rose-300/40 bg-rose-500/15 px-2 text-[11px] font-semibold text-rose-100 hover:bg-rose-500/30 active:scale-95"
                >
                  Retry
                </button>
              </div>
            ) : null}
            {runState.error ? (
              <div data-testid="run-list-error" className="flex items-start gap-2">
                <span className="min-w-0 break-words">Runs unavailable: {humanizeArtifactError(runState.error)}</span>
                <button
                  type="button"
                  data-testid="run-list-retry"
                  onClick={runState.retry}
                  className="h-6 shrink-0 rounded border border-rose-300/40 bg-rose-500/15 px-2 text-[11px] font-semibold text-rose-100 hover:bg-rose-500/30 active:scale-95"
                >
                  Retry
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <SoundingDrawer
          open={soundingOpen}
          loading={soundingLoading}
          error={soundingError}
          sounding={sounding}
          viewKey={viewKey}
          point={soundingPoint}
          forecastHour={frame?.hour ?? null}
          validLabel={validLabel}
          timeZone={timeZone}
          followTimeline={followTimeline}
          onToggleFollowTimeline={() => setFollowTimeline((value) => !value)}
          staleNotice={soundingStale}
          onRefresh={refreshSounding}
          recenterEnabled={soundingPointManual}
          onRecenter={recenterOnSoundingPoint}
          onRequestPoint={handleManualPointRequest}
          onClose={closeSounding}
        />

        {/* ── Footer gradient overlay (above timeline) ── */}
        <footer
          className="pointer-events-none absolute inset-x-0 z-[505] flex items-center justify-between bg-gradient-to-t from-slate-950/50 to-transparent px-3 py-1.5 text-[10px] text-slate-400/70"
          style={{ bottom: "var(--panel-inset-bottom, 0px)" }}
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

function formatHoverLayerReadout(
  layerKey: string,
  values: Record<string, number | null>,
  unit: string | null | undefined,
): string {
  const value = values[layerKey];
  const missingLabel = describeMissingHoverValue(layerKey, values);
  if (!Number.isFinite(value) && missingLabel) return missingLabel;
  return formatHoverLayerValue(value, unit);
}

function formatHoverUnit(unit: string | null | undefined): string {
  // One display normalization everywhere (legend titles, menu chips, hover).
  return formatUnitDisplay(unit);
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

function LegendCard({ legend, basemapTheme }: { legend: LayerLegendConfig; basemapTheme: BasemapInkTheme }) {
  const unitDisplay = formatUnitDisplay(legend.unit);
  const title = unitDisplay ? `${legend.label} (${unitDisplay})` : legend.label;
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
        <HeightContourLegend legend={legend} basemapTheme={basemapTheme} />
      ) : isVectorLegend ? (
        <VectorLegend />
      ) : (
        <GradientLegend legend={legend} />
      )}
    </div>
  );
}

function HeightContourLegend({ legend, basemapTheme }: { legend: LayerLegendConfig; basemapTheme: BasemapInkTheme }) {
  const interval = Number(legend.contourIntervalDam);
  const inks =
    basemapTheme === "light" ? { minor: "#6A5B41", major: "#35291A" } : { minor: "#CFC2A4", major: "#F0E2C0" };
  const ground = basemapTheme === "light" ? "#F8F7F4" : "#06101C";
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-300">
      <span className="flex h-3 w-12 items-center rounded-sm px-1" style={{ backgroundColor: ground }}>
        <span className="h-0 w-full rounded-full border-t" style={{ borderTopColor: inks.minor }} />
      </span>
      <span className="font-mono">
        {Number.isFinite(interval) && interval > 0 ? `${formatTick(interval)} dam minor` : "minor"}
      </span>
      <span className="flex h-3 w-12 items-center rounded-sm px-1" style={{ backgroundColor: ground }}>
        <span className="h-0 w-full rounded-full border-t-2" style={{ borderTopColor: inks.major }} />
      </span>
      <span className="font-mono">
        {Number.isFinite(interval) && interval > 0 ? `${formatTick(interval * 2)} dam major` : "major"}
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

// Positioned ticks can cluster (e.g. 110/120 near the warm end); keep the
// first and last labels and drop any label closer than this to the previous
// kept one so neighbors never overprint.
const LEGEND_TICK_MIN_GAP = 0.08;

function thinPositionedTicks(ticks: number[], positions: number[]): Array<{ tick: number; position: number }> {
  const rows = ticks
    .map((tick, index) => ({ tick, position: Math.max(0, Math.min(1, Number(positions[index]) || 0)) }))
    .sort((left, right) => left.position - right.position);
  if (rows.length <= 2) {
    return rows;
  }
  const kept: Array<{ tick: number; position: number }> = [rows[0]];
  const last = rows[rows.length - 1];
  for (const row of rows.slice(1, -1)) {
    if (
      row.position - kept[kept.length - 1].position >= LEGEND_TICK_MIN_GAP &&
      last.position - row.position >= LEGEND_TICK_MIN_GAP
    ) {
      kept.push(row);
    }
  }
  kept.push(last);
  return kept;
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
          {thinPositionedTicks(legend.legendTicks, legend.legendTickPositions || []).map(({ tick, position }) => {
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
        const scale = buildPhysicalRateLegend(row);
        const visibleBins = row.bins.filter((bin) => Number(bin.color?.[3]) > 0);
        const fallbackBins = visibleBins.length > 0 ? visibleBins : row.bins;
        return (
          <div key={row.key} className="grid grid-cols-[82px_1fr] items-center gap-2">
            <span className="truncate text-[10px] font-medium text-slate-200">{row.label}</span>
            <div className="min-w-0">
              {scale ? (
                <div
                  className="relative h-3.5 overflow-hidden rounded-sm bg-slate-950/50 shadow-sm ring-1 ring-white/10"
                  aria-label={`${row.label} physical precipitation-rate scale ${formatTick(scale.domainStart)} to ${formatTick(
                    scale.domainEnd,
                  )} in/hr${scale.endCap ? `; ${formatTick(scale.domainEnd)} in/hr and above uses the endpoint cap` : ""}`}
                >
                  {scale.segments.map(({ bin, left, width }, index) => (
                    <span
                      key={`${row.key}-${bin.label || index}`}
                      className="absolute inset-y-0 block"
                      style={{
                        left: `${(left * 100).toFixed(4)}%`,
                        width: `${(width * 100).toFixed(4)}%`,
                        background: legendColorToCss(bin.color),
                      }}
                    />
                  ))}
                  {scale.endCap ? (
                    <span
                      className="absolute inset-y-0 right-0 block w-[3px]"
                      style={{ background: legendColorToCss(scale.endCap.color) }}
                      aria-hidden="true"
                    />
                  ) : null}
                </div>
              ) : (
                <div
                  className="grid h-3.5 overflow-hidden rounded-sm shadow-sm ring-1 ring-white/10"
                  style={{ gridTemplateColumns: `repeat(${Math.max(1, fallbackBins.length)}, minmax(0, 1fr))` }}
                >
                  {fallbackBins.map((bin, index) => (
                    <span
                      key={`${row.key}-${bin.label || index}`}
                      className="block h-full"
                      style={{ background: legendColorToCss(bin.color) }}
                    />
                  ))}
                </div>
              )}
              {scale && row.tickLabels && row.tickLabels.length > 0 ? (
                <div className="relative mt-0.5 h-2.5 font-mono text-[9px] leading-none text-slate-400">
                  {thinPositionedTicks(row.tickLabels, scale.tickPositions).map(({ tick, position }) => {
                    const transform =
                      position <= 0.035
                        ? "translateX(0)"
                        : position >= 0.965
                          ? "translateX(-100%)"
                          : "translateX(-50%)";
                    return (
                      <span
                        key={`${row.key}-${tick}`}
                        className="absolute top-0 whitespace-nowrap"
                        style={{ left: `${(position * 100).toFixed(3)}%`, transform }}
                      >
                        {formatTick(tick)}
                      </span>
                    );
                  })}
                </div>
              ) : !scale && row.tickLabels && row.tickLabels.length > 0 ? (
                <div className="mt-0.5 flex justify-between font-mono text-[9px] leading-none text-slate-400">
                  {row.tickLabels.map((tick, tickIndex) => (
                    <span key={`${row.key}-${tickIndex}-${tick}`}>{formatTick(tick)}</span>
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
                  {row.tickLabels.map((tick, tickIndex) => (
                    <span key={`${row.key}-${tickIndex}-${tick}`}>{formatTick(tick)}</span>
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

function HoverLine({ label, value, diff = null }: { label: string; value: string; diff?: string | null }) {
  return (
    <p className="m-0 flex items-center justify-between gap-2 text-[11px] text-slate-100">
      <span className="min-w-0 truncate text-slate-400">{label}</span>
      <span className="shrink-0 font-mono">
        {value}
        {diff ? <span className="pl-1 text-cyan-300/90">{diff}</span> : null}
      </span>
    </p>
  );
}

// Δ(this panel − hovered panel) at the mirrored cursor; both samples come
// from raw hover grids in the same unit, so the difference is unit-safe.
function formatHoverDiff(own: number | null | undefined, source: number | null | undefined): string | null {
  if (!Number.isFinite(own) || !Number.isFinite(source)) {
    return null;
  }
  const diff = (own as number) - (source as number);
  const magnitude = Math.abs(diff);
  const decimals = magnitude >= 10 ? 0 : 1;
  if (magnitude < 0.5 * 10 ** -decimals) {
    return "Δ0";
  }
  return `Δ${diff > 0 ? "+" : "−"}${magnitude.toFixed(decimals)}`;
}
