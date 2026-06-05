import { useEffect, useState, type RefObject } from "react";
import L from "leaflet";
import {
  fetchHoverGridPayload,
  getCachedHoverGridPayload,
  resolveHoverGridRequestUrls,
} from "../../core/artifact-client";
import type { FrameRecord, HoverGridPayload, LayerKey } from "../../types";
import { EMPTY_HOVER, type HoverValues, sampleHoverValuesAtPoint } from "./hover-utils";

interface UseHoverGridArgs {
  activeLayers: Set<LayerKey>;
  frame: FrameRecord | null;
  hoverAbortRef: RefObject<AbortController | null>;
  hoverGridKeyRef: RefObject<string>;
  hoverLatLng: L.LatLng | null;
}

export function useHoverGrid({ activeLayers, frame, hoverAbortRef, hoverGridKeyRef, hoverLatLng }: UseHoverGridArgs) {
  const [hoverValues, setHoverValues] = useState<HoverValues>(EMPTY_HOVER);
  const [hoverLoading, setHoverLoading] = useState(false);
  const [hoverGrid, setHoverGrid] = useState<HoverGridPayload | null>(null);

  useEffect(() => {
    hoverAbortRef.current?.abort();
    const hoverKey = resolveHoverGridRequestUrls(frame).join("|");
    hoverGridKeyRef.current = hoverKey;
    if (!frame || !hoverKey) {
      setHoverGrid(null);
      setHoverLoading(false);
      return;
    }
    const cached = getCachedHoverGridPayload(hoverKey);
    if (cached) {
      setHoverGrid(cached);
      setHoverLoading(false);
      return;
    }
    setHoverGrid(null);
    setHoverLoading(true);
    const controller = new AbortController();
    hoverAbortRef.current = controller;
    void fetchHoverGridPayload(frame, { signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted || hoverGridKeyRef.current !== hoverKey) {
          return;
        }
        setHoverGrid(payload);
      })
      .catch(() => {
        if (!controller.signal.aborted && hoverGridKeyRef.current === hoverKey) {
          setHoverGrid(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && hoverGridKeyRef.current === hoverKey) {
          setHoverLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [
    frame,
    frame?.hoverGridBytes,
    frame?.hoverGridKey,
    frame?.hoverGridSchemaVersion,
    frame?.hoverGridSupplemental,
    frame?.hour,
    hoverAbortRef,
    hoverGridKeyRef,
  ]);

  useEffect(() => {
    if (!hoverLatLng || !frame || activeLayers.size === 0 || !hoverGrid) {
      setHoverValues(EMPTY_HOVER);
      return;
    }
    setHoverValues(
      sampleHoverValuesAtPoint({
        hoverGrid,
        bounds: frame.bounds,
        lat: hoverLatLng.lat,
        lon: hoverLatLng.lng,
      }),
    );
  }, [activeLayers.size, frame, hoverGrid, hoverLatLng]);

  return {
    hoverLoading,
    hoverValues,
    setHoverLoading,
    setHoverValues,
  };
}
