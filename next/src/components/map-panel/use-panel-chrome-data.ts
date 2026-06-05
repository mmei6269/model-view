import { useMemo } from "react";
import { getLayerLegendConfig, getLayerStackOrder, getManifestParameterOptions } from "../../config/layers";
import { normalizeIsoHour } from "../../core/time";
import type { FrameHourStatus, FrameRecord, LayerKey, ModelManifest } from "../../types";
import type { PanelFrameOption } from "./PanelChrome";

interface ManifestStateLike {
  error: string | null;
  loading: boolean;
  manifest: ModelManifest | null;
}

interface UsePanelChromeDataArgs {
  activeLayers: Set<LayerKey>;
  browserHourStatus: Record<number, FrameHourStatus>;
  effectiveHourStatus: Record<number, FrameHourStatus>;
  frame: FrameRecord | null;
  frameByHour: Map<number, FrameRecord>;
  manifestState: ManifestStateLike;
  plannedHours: number[];
  selectedLayers: Set<LayerKey>;
}

export function usePanelChromeData({
  activeLayers,
  browserHourStatus,
  effectiveHourStatus,
  frame,
  frameByHour,
  manifestState,
  plannedHours,
  selectedLayers,
}: UsePanelChromeDataArgs) {
  const renderableParamKeys = useMemo(
    () =>
      getLayerStackOrder(manifestState.manifest, selectedLayers).filter(
        (key) => key !== "synoptic" && selectedLayers.has(key),
      ),
    [manifestState.manifest, selectedLayers],
  );
  const legendItems = useMemo(
    () =>
      renderableParamKeys
        .map((key) => getLayerLegendConfig(key, manifestState.manifest))
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    [manifestState.manifest, renderableParamKeys],
  );
  const parameterOptions = useMemo(() => {
    const options = getManifestParameterOptions(manifestState.manifest);
    const seen = new Set(options.map((option) => option.key));
    for (const key of selectedLayers) {
      if (key === "synoptic" || seen.has(key)) {
        continue;
      }
      options.push({ key, label: key, group: "Selected", unit: null, available: false });
    }
    return options;
  }, [manifestState.manifest, selectedLayers]);
  const hasAnyLayer = activeLayers.size > 0;
  const emptyMessage = !hasAnyLayer
    ? "No layers selected"
    : manifestState.loading
      ? "Loading manifest..."
      : !frame
        ? "Frame unavailable for selected valid time"
        : null;
  const frameOptions = useMemo<PanelFrameOption[]>(
    () =>
      plannedHours.map((hour) => {
        const targetFrame = frameByHour.get(hour) || null;
        return {
          hour,
          status: browserHourStatus[hour] || effectiveHourStatus[hour] || "pending",
          selected: frame?.hour === hour,
          selectable: Boolean(targetFrame) && effectiveHourStatus[hour] === "loaded",
          validHourKey: targetFrame ? normalizeIsoHour(targetFrame.validHourKey) : null,
        };
      }),
    [browserHourStatus, effectiveHourStatus, frame?.hour, frameByHour, plannedHours],
  );
  const panelStatus = useMemo(() => {
    if (manifestState.loading) {
      return { label: "Loading", kind: "loading" as const };
    }
    if (manifestState.error) {
      return { label: "Manifest Error", kind: "error" as const };
    }
    if (activeLayers.size === 0) {
      return { label: "No Layers", kind: "error" as const };
    }
    if (!frame) {
      return { label: "Frame Missing", kind: "error" as const };
    }
    return { label: "Ready", kind: "ready" as const };
  }, [activeLayers.size, frame, manifestState.error, manifestState.loading]);

  return {
    emptyMessage,
    frameOptions,
    legendItems,
    panelStatus,
    parameterOptions,
  };
}
