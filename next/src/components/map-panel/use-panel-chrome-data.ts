import { useMemo } from "react";
import { getFrameAwareLayerLegendConfig, getLayerStackOrder, getManifestParameterOptions } from "../../config/layers";
import { resolveFrameParameterAvailability, type SynopticComponentSelection } from "../../core/layer-refs";
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
  hasRuns: boolean;
  manifestState: ManifestStateLike;
  plannedHours: number[];
  selectedBrowserFrameStatus: FrameHourStatus;
  selectedLayers: Set<LayerKey>;
  synopticSelection: SynopticComponentSelection;
}

export function usePanelChromeData({
  activeLayers,
  browserHourStatus,
  effectiveHourStatus,
  frame,
  frameByHour,
  hasRuns,
  manifestState,
  plannedHours,
  selectedBrowserFrameStatus,
  selectedLayers,
  synopticSelection,
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
        .map((key) => getFrameAwareLayerLegendConfig(key, manifestState.manifest, frame?.hour))
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    [frame?.hour, manifestState.manifest, renderableParamKeys],
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
  const unavailableLayerLabels = useMemo(
    () => getUnavailableActiveLayerLabels(activeLayers, frame, manifestState.manifest, synopticSelection),
    [activeLayers, frame, manifestState.manifest, synopticSelection],
  );
  // Empty-cache onboarding: the manifest loaded cleanly but holds zero frames
  // and the run list confirmed there are no runs at all — a fresh checkout, not
  // a transient failure (loading and error states are handled above/elsewhere).
  const isEmptyCache =
    !hasRuns && !manifestState.error && manifestState.manifest !== null && manifestState.manifest.frames.length === 0;
  const emptyMessage = !hasAnyLayer
    ? "No layers selected"
    : manifestState.loading
      ? "Loading manifest..."
      : manifestState.error && !manifestState.manifest
        ? "Manifest unavailable"
        : isEmptyCache
          ? "No runs built yet — run npm run noaa:update"
          : !frame
            ? "Frame unavailable for selected valid time"
            : selectedBrowserFrameStatus === "unavailable"
              ? unavailableLayerLabels.length > 0
                ? `Unavailable for this frame: ${unavailableLayerLabels.join(", ")}`
                : "Selected layer unavailable for this frame"
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
    if (selectedBrowserFrameStatus === "unavailable") {
      return { label: "Layer Unavailable", kind: "error" as const };
    }
    return { label: "Ready", kind: "ready" as const };
  }, [activeLayers.size, frame, manifestState.error, manifestState.loading, selectedBrowserFrameStatus]);

  return {
    emptyMessage,
    frameOptions,
    legendItems,
    panelStatus,
    parameterOptions,
    unavailableLayerLabels,
  };
}

export function getUnavailableActiveLayerLabels(
  activeLayers: Set<LayerKey>,
  frame: FrameRecord | null,
  manifest: ModelManifest | null,
  synopticSelection?: SynopticComponentSelection | null,
): string[] {
  if (!frame) {
    return [];
  }
  const labels: string[] = [];
  for (const layer of activeLayers) {
    if (layer === "synoptic" && synopticSelection) {
      const priorLabelCount = labels.length;
      if (
        (synopticSelection.showIsobars || synopticSelection.showCenters) &&
        resolveFrameParameterAvailability(frame, "synopticIsobars") === "unavailable"
      ) {
        labels.push("Surface pressure isobars/centers");
      }
      if (
        synopticSelection.showThickness &&
        resolveFrameParameterAvailability(frame, "synopticThickness") === "unavailable"
      ) {
        labels.push("1000-500 mb thickness");
      }
      if (labels.length > priorLabelCount) {
        continue;
      }
    }
    if (resolveFrameParameterAvailability(frame, layer) !== "unavailable") {
      continue;
    }
    labels.push(
      layer === "synoptic"
        ? "Synoptic analysis"
        : getFrameAwareLayerLegendConfig(layer, manifest, frame.hour)?.label || layer,
    );
  }
  return labels;
}
