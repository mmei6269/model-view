import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import L, { type Map as LeafletMap } from "leaflet";
import { HEIGHT_CONTOUR_PANE } from "../../config/layers";
import { fetchContourVectorPayload, resolveContourVectorRequestUrl } from "../../core/artifact-client";
import { decodeVectorLinePoints } from "../../core/vector-encoding";
import type { ContourVectorLine, ContourVectorPayload, FrameRecord, LayerKey } from "../../types";
import { getPaneCanvasRenderer } from "./canvas-renderer";
import { normalizeContourLabelAngle } from "./synoptic-render";

interface UseContourVectorLayersArgs {
  activeLayers: Set<LayerKey>;
  frame: FrameRecord | null;
  mapReady: boolean;
  mapRef: RefObject<LeafletMap | null>;
}

export function useContourVectorLayers({
  activeLayers,
  frame,
  mapReady,
  mapRef,
}: UseContourVectorLayersArgs): Set<LayerKey> {
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [payloads, setPayloads] = useState<Record<string, ContourVectorPayload>>({});

  const activeContourLayers = useMemo(() => {
    const refs = frame?.contourVectorRefs || {};
    return Array.from(activeLayers).filter((layerKey) => Boolean(refs[layerKey]?.key));
  }, [activeLayers, frame]);

  const requestKey = useMemo(
    () =>
      activeContourLayers
        .map((layerKey) => `${layerKey}:${resolveContourVectorRequestUrl(frame, layerKey) || ""}`)
        .sort()
        .join("|"),
    [activeContourLayers, frame],
  );

  useEffect(() => {
    abortRef.current?.abort();
    setPayloads({});
    if (!frame || activeContourLayers.length === 0) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    void Promise.all(
      activeContourLayers.map(async (layerKey) => {
        try {
          const payload = await fetchContourVectorPayload(frame, layerKey, { signal: controller.signal });
          return payload ? ([layerKey, payload] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (controller.signal.aborted) {
        return;
      }
      const next: Record<string, ContourVectorPayload> = {};
      for (const entry of entries) {
        if (entry) {
          next[entry[0]] = entry[1];
        }
      }
      setPayloads(next);
    });
    return () => controller.abort();
  }, [activeContourLayers, frame, requestKey]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) {
      return;
    }
    const map = mapRef.current;
    if (layerGroupRef.current) {
      map.removeLayer(layerGroupRef.current);
      layerGroupRef.current = null;
    }
    const entries = Object.entries(payloads);
    if (entries.length === 0) {
      return;
    }
    const group = L.layerGroup();
    for (const [, payload] of entries) {
      renderContourPayload(group, payload, map);
    }
    group.addTo(map);
    layerGroupRef.current = group;
    return () => {
      if (layerGroupRef.current) {
        map.removeLayer(layerGroupRef.current);
        layerGroupRef.current = null;
      }
    };
  }, [mapReady, mapRef, payloads]);

  return useMemo(() => new Set(Object.keys(payloads)), [payloads]);
}

function renderContourPayload(group: L.LayerGroup, payload: ContourVectorPayload, map: LeafletMap): void {
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  for (const line of lines) {
    renderContourLine(group, line, map);
  }
  const labels = Array.isArray(payload.labels) ? payload.labels : [];
  for (const label of labels) {
    if (!Number.isFinite(label.lat) || !Number.isFinite(label.lon) || !label.text) {
      continue;
    }
    const angle = normalizeContourLabelAngle(label.angleDeg);
    L.marker([label.lat, label.lon], {
      pane: HEIGHT_CONTOUR_PANE,
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "synoptic-contour-label-icon",
        html: `<div class="synoptic-contour-label" style="color:${label.color || "#171717"};transform:rotate(${angle.toFixed(1)}deg)">${label.text}</div>`,
        iconSize: [54, 20],
        iconAnchor: [27, 10],
      }),
    }).addTo(group);
  }
}

function renderContourLine(group: L.LayerGroup, line: ContourVectorLine, map: LeafletMap): void {
  const latLngs = decodeVectorLinePoints(line);
  if (latLngs.length < 2) {
    return;
  }
  const isMajor = String(line.kind || "").includes("major");
  const weight = Number.isFinite(line.width) ? Number(line.width) : isMajor ? 1.45 : 1.08;
  const opacity = Number.isFinite(line.alpha) ? Number(line.alpha) : isMajor ? 0.82 : 0.72;
  const renderer = getPaneCanvasRenderer(map, HEIGHT_CONTOUR_PANE);
  L.polyline(latLngs, {
    pane: HEIGHT_CONTOUR_PANE,
    renderer,
    color: "#FFFFFF",
    weight: isMajor ? 2.8 : 2.25,
    opacity: isMajor ? 0.52 : 0.44,
    lineCap: "round",
    lineJoin: "round",
    smoothFactor: 0,
    interactive: false,
  }).addTo(group);
  L.polyline(latLngs, {
    pane: HEIGHT_CONTOUR_PANE,
    renderer,
    color: line.color || "#171717",
    weight,
    opacity,
    lineCap: "round",
    lineJoin: "round",
    smoothFactor: 0,
    interactive: false,
  }).addTo(group);
}
