import { useEffect, useMemo, useState, type RefObject } from "react";
import L, { type Map as LeafletMap } from "leaflet";
import { SYNOPTIC_STYLE_VERSION } from "../../config/layers";
import {
  fetchSynopticVectorPayload,
  resolveSynopticStyleVersion,
  resolveSynopticVectorKey,
  resolveSynopticVectorRequestUrl,
} from "../../core/artifact-client";
import { markFrameSynopticVectorLoaded } from "../../core/frame-prefetch";
import type { FrameRecord, LayerKey, SynopticDetailMode, SynopticVectorPayload } from "../../types";
import { getPaneCanvasRenderer } from "./canvas-renderer";
import {
  isLineRenderableOnViewport,
  normalizeSynopticVectorPayload,
  resolveSynopticLinePaint,
  shouldRenderSynopticKind,
  smoothSynopticPolyline,
  stitchSynopticSegments,
  synopticLinePriority,
  synopticPaneForKind,
} from "./synoptic-utils";
import {
  buildInlineLabelGapSegment,
  ensureSynopticLineCoverageLabels,
  normalizeContourLabelAngle,
  pickReadableSynopticLabels,
  type RenderedSynopticLine,
} from "./synoptic-render";

interface UseSynopticVectorPayloadArgs {
  activeLayers: Set<LayerKey>;
  frame: FrameRecord | null;
  synopticDetailMode: SynopticDetailMode;
  synopticVectorKeyRef: RefObject<string>;
  vectorAbortRef: RefObject<AbortController | null>;
}

interface UseSynopticVectorLayerArgs {
  activeLayers: Set<LayerKey>;
  activeSynopticVectorKey: string | null;
  expectedSynopticStyleVersion: string | null;
  frame: FrameRecord | null;
  mapReady: boolean;
  mapRef: RefObject<LeafletMap | null>;
  mapZoom: number;
  normalizedSynopticVector: ReturnType<typeof normalizeSynopticVectorPayload>;
  showIsobars: boolean;
  showThickness: boolean;
  stitchedSynopticLines: SynopticVectorPayload["lines"];
  synopticVector: SynopticVectorPayload | null;
  synopticVectorLayerRef: RefObject<L.LayerGroup | null>;
}

export function useSynopticVectorPayload({
  activeLayers,
  frame,
  synopticDetailMode,
  synopticVectorKeyRef,
  vectorAbortRef,
}: UseSynopticVectorPayloadArgs) {
  const [synopticVector, setSynopticVector] = useState<SynopticVectorPayload | null>(null);
  const normalizedSynopticVector = useMemo(() => normalizeSynopticVectorPayload(synopticVector), [synopticVector]);
  const synopticIsobarLines = useMemo(
    () => stitchSynopticSegments(normalizedSynopticVector.isobars.lines || []),
    [normalizedSynopticVector.isobars.lines],
  );
  const synopticThicknessLines = useMemo(
    () => stitchSynopticSegments(normalizedSynopticVector.thickness.lines || []),
    [normalizedSynopticVector.thickness.lines],
  );
  const stitchedSynopticLines = useMemo(
    () => [...synopticThicknessLines, ...synopticIsobarLines],
    [synopticIsobarLines, synopticThicknessLines],
  );
  const activeSynopticVectorKey = useMemo(
    () =>
      resolveSynopticVectorRequestUrl(frame, synopticDetailMode) || resolveSynopticVectorKey(frame, synopticDetailMode),
    [frame, synopticDetailMode],
  );
  const expectedSynopticStyleVersion = useMemo(
    () => resolveSynopticStyleVersion(frame, synopticDetailMode),
    [frame, synopticDetailMode],
  );

  useEffect(() => {
    vectorAbortRef.current?.abort();
    const vectorKey = String(activeSynopticVectorKey || "").trim();
    synopticVectorKeyRef.current = vectorKey;
    if (!activeLayers.has("synoptic") || !vectorKey) {
      setSynopticVector(null);
      return;
    }
    setSynopticVector(null);
    const controller = new AbortController();
    vectorAbortRef.current = controller;

    void fetchSynopticVectorPayload(frame, {
      signal: controller.signal,
      synopticDetailMode,
    })
      .then((payload) => {
        if (controller.signal.aborted || synopticVectorKeyRef.current !== vectorKey) {
          return;
        }
        markFrameSynopticVectorLoaded(frame, synopticDetailMode);
        setSynopticVector(payload);
      })
      .catch(() => {
        if (!controller.signal.aborted && synopticVectorKeyRef.current === vectorKey) {
          setSynopticVector(null);
        }
      });

    return () => controller.abort();
  }, [
    activeLayers,
    activeSynopticVectorKey,
    frame,
    frame?.hour,
    synopticDetailMode,
    synopticVectorKeyRef,
    vectorAbortRef,
  ]);

  return {
    activeSynopticVectorKey,
    expectedSynopticStyleVersion,
    normalizedSynopticVector,
    stitchedSynopticLines,
    synopticVector,
  };
}

export function useSynopticVectorLayer({
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
}: UseSynopticVectorLayerArgs): void {
  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      return;
    }
    const map = mapRef.current;
    if (synopticVectorLayerRef.current) {
      map.removeLayer(synopticVectorLayerRef.current);
      synopticVectorLayerRef.current = null;
    }
    if (!activeLayers.has("synoptic") || !synopticVector) {
      return;
    }
    const vectorStyleVersion = String(normalizedSynopticVector.styleVersion || "").trim();
    const expectedStyleVersion = String(
      expectedSynopticStyleVersion || frame?.synopticStyleVersion || SYNOPTIC_STYLE_VERSION,
    );
    const useFallbackStyle = !vectorStyleVersion || vectorStyleVersion !== expectedStyleVersion;

    const layer = L.layerGroup();
    const renderedLines = renderSynopticLines({
      layer,
      lines: stitchedSynopticLines || [],
      map,
      mapZoom,
      showIsobars,
      showThickness,
      useFallbackStyle,
    });
    renderSynopticLabels({
      layer,
      map,
      mapZoom,
      normalizedSynopticVector,
      renderedLines,
      showIsobars,
      showThickness,
      useFallbackStyle,
    });
    layer.addTo(map);
    synopticVectorLayerRef.current = layer;
    return () => {
      if (synopticVectorLayerRef.current) {
        map.removeLayer(synopticVectorLayerRef.current);
        synopticVectorLayerRef.current = null;
      }
    };
  }, [
    activeLayers,
    activeSynopticVectorKey,
    expectedSynopticStyleVersion,
    frame?.hour,
    frame?.synopticStyleVersion,
    mapReady,
    mapRef,
    mapZoom,
    normalizedSynopticVector,
    showIsobars,
    showThickness,
    stitchedSynopticLines,
    synopticVector,
    synopticVectorLayerRef,
  ]);
}

function renderSynopticLines({
  layer,
  lines,
  map,
  mapZoom,
  showIsobars,
  showThickness,
  useFallbackStyle,
}: {
  layer: L.LayerGroup;
  lines: NonNullable<SynopticVectorPayload["lines"]>;
  map: LeafletMap;
  mapZoom: number;
  showIsobars: boolean;
  showThickness: boolean;
  useFallbackStyle: boolean;
}): RenderedSynopticLine[] {
  const renderedLines: RenderedSynopticLine[] = [];
  const sortedLines = [...lines].sort(
    (left, right) => synopticLinePriority(left.kind) - synopticLinePriority(right.kind),
  );
  for (const line of sortedLines) {
    if (!Array.isArray(line.points) || line.points.length < 2) {
      continue;
    }
    if (!shouldRenderSynopticKind(line.kind, showIsobars, showThickness)) {
      continue;
    }
    const paint = resolveSynopticLinePaint(line, mapZoom, useFallbackStyle);
    if (!paint) {
      continue;
    }
    const latLngs = smoothSynopticPolyline(
      line.points.map((point) => [point[0], point[1]] as [number, number]),
      line.kind,
      mapZoom,
    );
    if (!isLineRenderableOnViewport(map, latLngs, mapZoom)) {
      continue;
    }
    renderedLines.push({
      kind: String(line.kind || ""),
      value: Number.isFinite(line.value) ? Number(line.value) : null,
      points: latLngs,
    });
    renderLine(layer, map, latLngs, line.kind, paint);
  }
  return renderedLines;
}

function renderLine(
  layer: L.LayerGroup,
  map: LeafletMap,
  latLngs: L.LatLngExpression[],
  kind: string | undefined,
  paint: NonNullable<ReturnType<typeof resolveSynopticLinePaint>>,
): void {
  const pane = synopticPaneForKind(kind);
  const renderer = getPaneCanvasRenderer(map, pane);
  if (paint.haloWeight && paint.haloWeight > paint.weight) {
    L.polyline(latLngs, {
      pane,
      renderer,
      color: paint.haloColor || "#FFFFFF",
      weight: paint.haloWeight,
      opacity: Number.isFinite(paint.haloOpacity) ? paint.haloOpacity : 0.7,
      lineCap: "round",
      lineJoin: "round",
      smoothFactor: 0,
      interactive: false,
    }).addTo(layer);
  }
  L.polyline(latLngs, {
    pane,
    renderer,
    color: paint.color,
    weight: paint.weight,
    opacity: paint.opacity,
    dashArray: paint.dashArray,
    lineCap: "round",
    lineJoin: "round",
    smoothFactor: 0,
    interactive: false,
  }).addTo(layer);
}

function renderSynopticLabels({
  layer,
  map,
  mapZoom,
  normalizedSynopticVector,
  renderedLines,
  showIsobars,
  showThickness,
  useFallbackStyle,
}: {
  layer: L.LayerGroup;
  map: LeafletMap;
  mapZoom: number;
  normalizedSynopticVector: ReturnType<typeof normalizeSynopticVectorPayload>;
  renderedLines: RenderedSynopticLine[];
  showIsobars: boolean;
  showThickness: boolean;
  useFallbackStyle: boolean;
}): void {
  const combinedLabels = [
    ...(showIsobars ? normalizedSynopticVector.isobars.labels || [] : []),
    ...(showThickness ? normalizedSynopticVector.thickness.labels || [] : []),
  ];
  const selectedLabels = pickReadableSynopticLabels(
    map,
    combinedLabels.filter((entry) => shouldRenderSynopticKind(entry.kind, showIsobars, showThickness)),
    mapZoom,
    useFallbackStyle,
  );
  const labelsToRender = ensureSynopticLineCoverageLabels(
    map,
    selectedLabels,
    renderedLines,
    mapZoom,
    useFallbackStyle,
  );
  for (const label of labelsToRender) {
    if (!Number.isFinite(label.lat) || !Number.isFinite(label.lon) || !label.text) {
      continue;
    }
    const gapSegment = buildInlineLabelGapSegment(map, label, mapZoom);
    if (!gapSegment) {
      continue;
    }
    L.polyline([gapSegment.start, gapSegment.end], {
      pane: synopticPaneForKind(label.kind),
      renderer: getPaneCanvasRenderer(map, synopticPaneForKind(label.kind)),
      color: "rgba(236, 242, 248, 0.78)",
      weight: gapSegment.weight,
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
      smoothFactor: 0,
      interactive: false,
    }).addTo(layer);
  }
  for (const label of labelsToRender) {
    if (!Number.isFinite(label.lat) || !Number.isFinite(label.lon) || !label.text || !label.style) {
      continue;
    }
    const angle = normalizeContourLabelAngle(label.angleDeg);
    L.marker([label.lat, label.lon], {
      pane: synopticPaneForKind(label.kind),
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "synoptic-contour-label-icon",
        html: `<div class="synoptic-contour-label" style="color:${label.style.color};font-size:${label.style.fontSize}px;font-weight:${label.style.fontWeight};transform:rotate(${angle.toFixed(1)}deg)">${label.text}</div>`,
        iconSize: [54, 20],
        iconAnchor: [27, 10],
      }),
    }).addTo(layer);
  }
}
