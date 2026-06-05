import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useState } from "react";
import { MODEL_CONFIG } from "../config/constants";
import { findNearestValidTime, toEpochMs } from "../core/time";
import type { FrameHourStatus, ManifestUiInfo, PanelState, ResolvedFrame, TimelineMode, ValidTimeIso } from "../types";

const PLAYBACK_INTERVAL_MS = 1200;

interface TimelineControllerOptions {
  availableValidTimesByPanel: Record<string, ValidTimeIso[]>;
  manifestInfoByPanel: Record<string, ManifestUiInfo>;
  panels: PanelState[];
  resolvedFrameByPanel: Record<string, ResolvedFrame | null>;
}

export function useTimelineController({
  availableValidTimesByPanel,
  manifestInfoByPanel,
  panels,
  resolvedFrameByPanel,
}: TimelineControllerOptions) {
  const [sharedSelectedValidTimeIso, setSharedSelectedValidTimeIso] = useState<ValidTimeIso | null>(null);
  const [panelSelectedValidTimes, setPanelSelectedValidTimes] = useState<Record<string, ValidTimeIso | null>>({});
  const [timelineMode, setTimelineMode] = useState<TimelineMode>("overlap");
  const [playing, setPlaying] = useState(false);
  const { effectiveTimelineTargetPanelId, setTimelineTargetPanelId, timelineTargets } = useTimelineTargetState(panels);
  const { overlapValidTimes, timelineValidTimes } = useTimelineValidTimes({
    availableValidTimesByPanel,
    effectiveTimelineTargetPanelId,
    panels,
    timelineMode,
  });

  useSharedTimelineSelection({
    overlapValidTimes,
    setSharedSelectedValidTimeIso,
    sharedSelectedValidTimeIso,
    timelineMode,
  });
  usePanelTimelineDefaults({
    availableValidTimesByPanel,
    panels,
    setPanelSelectedValidTimes,
    timelineMode,
  });
  useTimelinePlayback({
    effectiveTimelineTargetPanelId,
    playing,
    setPanelSelectedValidTimes,
    setSharedSelectedValidTimeIso,
    timelineMode,
    timelineValidTimes,
  });

  const handleTimelineModeChange = useCallback(
    (mode: TimelineMode) => {
      setTimelineMode(mode);
      if (mode === "overlap") {
        const sourcePanelId = effectiveTimelineTargetPanelId || panels[0]?.id || null;
        if (sourcePanelId) {
          const sourceValue = panelSelectedValidTimes[sourcePanelId] || sharedSelectedValidTimeIso;
          if (sourceValue) {
            setSharedSelectedValidTimeIso(sourceValue);
          }
        }
        return;
      }
      const sourcePanelId = effectiveTimelineTargetPanelId || panels[0]?.id || null;
      if (!sourcePanelId) {
        return;
      }
      setPanelSelectedValidTimes((prev) => {
        if (prev[sourcePanelId]) {
          return prev;
        }
        const fallback = sharedSelectedValidTimeIso || (availableValidTimesByPanel[sourcePanelId] || [])[0] || null;
        if (!fallback) {
          return prev;
        }
        return {
          ...prev,
          [sourcePanelId]: fallback,
        };
      });
    },
    [
      availableValidTimesByPanel,
      effectiveTimelineTargetPanelId,
      panelSelectedValidTimes,
      panels,
      sharedSelectedValidTimeIso,
    ],
  );

  const handleTimelineValidTimeChange = useCallback(
    (value: ValidTimeIso) => {
      if (timelineMode === "panel") {
        const panelId = effectiveTimelineTargetPanelId || panels[0]?.id || null;
        if (!panelId) {
          return;
        }
        setPanelSelectedValidTimes((prev) => {
          if (prev[panelId] === value) {
            return prev;
          }
          return {
            ...prev,
            [panelId]: value,
          };
        });
        return;
      }
      setSharedSelectedValidTimeIso(value);
    },
    [effectiveTimelineTargetPanelId, panels, timelineMode],
  );

  const handlePanelSelectValidTime = useCallback(
    (panelId: string, value: ValidTimeIso) => {
      if (timelineMode === "panel") {
        setPanelSelectedValidTimes((prev) => {
          if (prev[panelId] === value) {
            return prev;
          }
          return {
            ...prev,
            [panelId]: value,
          };
        });
        return;
      }
      setSharedSelectedValidTimeIso(value);
    },
    [timelineMode],
  );

  const resolvePanelSelectedValidTime = useCallback(
    (panelId: string): ValidTimeIso | null => {
      if (timelineMode === "panel") {
        return panelSelectedValidTimes[panelId] || null;
      }
      return sharedSelectedValidTimeIso;
    },
    [panelSelectedValidTimes, sharedSelectedValidTimeIso, timelineMode],
  );

  const clearPanelSelection = useCallback((panelId: string): void => {
    setPanelSelectedValidTimes((prev) => omitKey(prev, panelId));
  }, []);

  const latestViewWarmupAnchorValidTimeIso = useMemo(() => {
    if (timelineMode === "panel") {
      const panelId = effectiveTimelineTargetPanelId || panels[0]?.id || "";
      return panelSelectedValidTimes[panelId] || sharedSelectedValidTimeIso || null;
    }
    return sharedSelectedValidTimeIso;
  }, [effectiveTimelineTargetPanelId, panelSelectedValidTimes, panels, sharedSelectedValidTimeIso, timelineMode]);

  const currentFrameLabel = useMemo(() => {
    const panelId = timelineMode === "panel" ? effectiveTimelineTargetPanelId || panels[0]?.id : panels[0]?.id;
    const frame = panelId ? resolvedFrameByPanel[panelId] : null;
    return frame ? `F${String(frame.hour).padStart(3, "0")}` : "F---";
  }, [effectiveTimelineTargetPanelId, panels, resolvedFrameByPanel, timelineMode]);

  const timelineStatusByValidTime = useMemo(
    () =>
      getTimelineStatusByValidTime({
        effectiveTimelineTargetPanelId,
        manifestInfoByPanel,
        panels,
        timelineMode,
        timelineValidTimes,
      }),
    [effectiveTimelineTargetPanelId, manifestInfoByPanel, panels, timelineMode, timelineValidTimes],
  );

  const selectedTimelineValidTimeIso =
    timelineMode === "panel"
      ? panelSelectedValidTimes[effectiveTimelineTargetPanelId || ""] || null
      : sharedSelectedValidTimeIso;

  const togglePlaying = useCallback((): void => {
    setPlaying((prev) => !prev);
  }, []);

  return {
    clearPanelSelection,
    currentFrameLabel,
    effectiveTimelineTargetPanelId,
    handlePanelSelectValidTime,
    handleTimelineModeChange,
    handleTimelineValidTimeChange,
    latestViewWarmupAnchorValidTimeIso,
    panelSelectedValidTimes,
    playing,
    resolvePanelSelectedValidTime,
    selectedTimelineValidTimeIso,
    setTimelineTargetPanelId,
    timelineMode,
    timelineStatusByValidTime,
    timelineTargets,
    timelineValidTimes,
    togglePlaying,
  };
}

function useTimelineTargetState(panels: PanelState[]) {
  const [timelineTargetPanelId, setTimelineTargetPanelId] = useState<string | null>(null);

  const timelineTargets = useMemo(
    () =>
      panels.map((panel, index) => ({
        id: panel.id,
        label: `${MODEL_CONFIG[panel.modelKey].label}${panels.length > 1 ? ` (${index + 1})` : ""}`,
      })),
    [panels],
  );

  const effectiveTimelineTargetPanelId = useMemo(() => {
    if (timelineTargetPanelId && panels.some((panel) => panel.id === timelineTargetPanelId)) {
      return timelineTargetPanelId;
    }
    return panels[0]?.id || null;
  }, [panels, timelineTargetPanelId]);

  useEffect(() => {
    setTimelineTargetPanelId((current) => {
      if (current && panels.some((panel) => panel.id === current)) {
        return current;
      }
      return panels[0]?.id || null;
    });
  }, [panels]);

  return {
    effectiveTimelineTargetPanelId,
    setTimelineTargetPanelId,
    timelineTargets,
  };
}

function useTimelineValidTimes({
  availableValidTimesByPanel,
  effectiveTimelineTargetPanelId,
  panels,
  timelineMode,
}: {
  availableValidTimesByPanel: Record<string, ValidTimeIso[]>;
  effectiveTimelineTargetPanelId: string | null;
  panels: PanelState[];
  timelineMode: TimelineMode;
}) {
  const overlapValidTimes = useMemo(
    () => getOverlapValidTimes(panels, availableValidTimesByPanel),
    [availableValidTimesByPanel, panels],
  );

  const timelineValidTimes = useMemo(() => {
    if (timelineMode === "panel") {
      if (!effectiveTimelineTargetPanelId) {
        return [] as ValidTimeIso[];
      }
      const panelTimes = availableValidTimesByPanel[effectiveTimelineTargetPanelId] || [];
      return uniqueSortedValidTimes(panelTimes);
    }
    return overlapValidTimes;
  }, [availableValidTimesByPanel, effectiveTimelineTargetPanelId, overlapValidTimes, timelineMode]);

  return {
    overlapValidTimes,
    timelineValidTimes,
  };
}

function useSharedTimelineSelection({
  overlapValidTimes,
  setSharedSelectedValidTimeIso,
  sharedSelectedValidTimeIso,
  timelineMode,
}: {
  overlapValidTimes: ValidTimeIso[];
  setSharedSelectedValidTimeIso: Dispatch<SetStateAction<ValidTimeIso | null>>;
  sharedSelectedValidTimeIso: ValidTimeIso | null;
  timelineMode: TimelineMode;
}) {
  useEffect(() => {
    if (timelineMode !== "overlap") {
      return;
    }

    if (!overlapValidTimes.length) {
      setSharedSelectedValidTimeIso(null);
      return;
    }
    if (sharedSelectedValidTimeIso && overlapValidTimes.includes(sharedSelectedValidTimeIso)) {
      return;
    }
    if (sharedSelectedValidTimeIso) {
      setSharedSelectedValidTimeIso(findNearestValidTime(sharedSelectedValidTimeIso, overlapValidTimes));
      return;
    }
    setSharedSelectedValidTimeIso(overlapValidTimes[0]);
  }, [overlapValidTimes, setSharedSelectedValidTimeIso, sharedSelectedValidTimeIso, timelineMode]);
}

function usePanelTimelineDefaults({
  availableValidTimesByPanel,
  panels,
  setPanelSelectedValidTimes,
  timelineMode,
}: {
  availableValidTimesByPanel: Record<string, ValidTimeIso[]>;
  panels: PanelState[];
  setPanelSelectedValidTimes: Dispatch<SetStateAction<Record<string, ValidTimeIso | null>>>;
  timelineMode: TimelineMode;
}) {
  useEffect(() => {
    if (timelineMode !== "panel") {
      return;
    }
    if (!panels.length) {
      return;
    }
    setPanelSelectedValidTimes((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const panel of panels) {
        changed = syncPanelDefaultSelection(next, panel, availableValidTimesByPanel[panel.id] || []) || changed;
      }
      return changed ? next : prev;
    });
  }, [availableValidTimesByPanel, panels, setPanelSelectedValidTimes, timelineMode]);
}

function useTimelinePlayback({
  effectiveTimelineTargetPanelId,
  playing,
  setPanelSelectedValidTimes,
  setSharedSelectedValidTimeIso,
  timelineMode,
  timelineValidTimes,
}: {
  effectiveTimelineTargetPanelId: string | null;
  playing: boolean;
  setPanelSelectedValidTimes: Dispatch<SetStateAction<Record<string, ValidTimeIso | null>>>;
  setSharedSelectedValidTimeIso: Dispatch<SetStateAction<ValidTimeIso | null>>;
  timelineMode: TimelineMode;
  timelineValidTimes: ValidTimeIso[];
}) {
  useEffect(() => {
    if (!playing || timelineValidTimes.length <= 1) {
      return;
    }
    const timer = window.setInterval(() => {
      if (timelineMode === "panel" && effectiveTimelineTargetPanelId) {
        setPanelSelectedValidTimes((prev) =>
          advancePanelSelection(prev, effectiveTimelineTargetPanelId, timelineValidTimes),
        );
        return;
      }
      setSharedSelectedValidTimeIso((prev) => advanceTimelineValue(prev, timelineValidTimes));
    }, PLAYBACK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [
    effectiveTimelineTargetPanelId,
    playing,
    setPanelSelectedValidTimes,
    setSharedSelectedValidTimeIso,
    timelineMode,
    timelineValidTimes,
  ]);
}

function syncPanelDefaultSelection(
  selections: Record<string, ValidTimeIso | null>,
  panel: PanelState,
  available: ValidTimeIso[],
): boolean {
  if (!available.length) {
    if (selections[panel.id] !== null) {
      selections[panel.id] = null;
      return true;
    }
    return false;
  }
  const current = selections[panel.id];
  if (current && available.includes(current)) {
    return false;
  }
  selections[panel.id] = current ? findNearestValidTime(current, available) : available[0];
  return true;
}

function advancePanelSelection(
  previous: Record<string, ValidTimeIso | null>,
  panelId: string,
  timelineValidTimes: ValidTimeIso[],
): Record<string, ValidTimeIso | null> {
  const next = advanceTimelineValue(previous[panelId] || null, timelineValidTimes);
  if (previous[panelId] === next) {
    return previous;
  }
  return {
    ...previous,
    [panelId]: next,
  };
}

function advanceTimelineValue(current: ValidTimeIso | null, timelineValidTimes: ValidTimeIso[]): ValidTimeIso {
  const active = current && timelineValidTimes.includes(current) ? current : timelineValidTimes[0];
  const index = timelineValidTimes.indexOf(active);
  return timelineValidTimes[(index + 1) % timelineValidTimes.length];
}

function getOverlapValidTimes(
  panels: PanelState[],
  availableValidTimesByPanel: Record<string, ValidTimeIso[]>,
): ValidTimeIso[] {
  if (panels.length === 0) {
    return [];
  }
  const panelLists = panels
    .map((panel) => availableValidTimesByPanel[panel.id] || [])
    .filter((list) => list.length > 0)
    .map(uniqueSortedValidTimes);

  if (panelLists.length === 0) {
    return [];
  }
  if (panelLists.length === 1) {
    return panelLists[0];
  }
  const intersection = panelLists.slice(1).reduce((current, next) => {
    const nextSet = new Set(next);
    return current.filter((value) => nextSet.has(value));
  }, panelLists[0]);
  return intersection.length > 0 ? intersection : panelLists[0];
}

function uniqueSortedValidTimes(values: ValidTimeIso[]): ValidTimeIso[] {
  return Array.from(new Set(values)).sort((left, right) => toEpochMs(left) - toEpochMs(right));
}

function getTimelineStatusByValidTime({
  effectiveTimelineTargetPanelId,
  manifestInfoByPanel,
  panels,
  timelineMode,
  timelineValidTimes,
}: {
  effectiveTimelineTargetPanelId: string | null;
  manifestInfoByPanel: Record<string, ManifestUiInfo>;
  panels: PanelState[];
  timelineMode: TimelineMode;
  timelineValidTimes: ValidTimeIso[];
}): Partial<Record<ValidTimeIso, FrameHourStatus>> {
  const out: Partial<Record<ValidTimeIso, FrameHourStatus>> = {};
  if (timelineValidTimes.length === 0) {
    return out;
  }

  if (timelineMode === "panel") {
    for (const valid of timelineValidTimes) {
      out[valid] = getPanelTimelineStatus(
        valid,
        effectiveTimelineTargetPanelId || panels[0]?.id || null,
        manifestInfoByPanel,
      );
    }
    return out;
  }

  for (const valid of timelineValidTimes) {
    out[valid] = getOverlapTimelineStatus(valid, panels, manifestInfoByPanel);
  }

  return out;
}

function getPanelTimelineStatus(
  valid: ValidTimeIso,
  panelId: string | null,
  manifestInfoByPanel: Record<string, ManifestUiInfo>,
): FrameHourStatus {
  const statuses = panelId
    ? manifestInfoByPanel[panelId]?.browserStatusByValidTime ||
      manifestInfoByPanel[panelId]?.frameStatusByValidTime ||
      {}
    : {};
  return normalizeTimelineStatus(statuses[valid]);
}

function getOverlapTimelineStatus(
  valid: ValidTimeIso,
  panels: PanelState[],
  manifestInfoByPanel: Record<string, ManifestUiInfo>,
): FrameHourStatus {
  let sawAny = false;
  let allLoaded = true;
  let hasLoading = false;
  let hasError = false;
  for (const panel of panels) {
    const status = getPanelTimelineStatus(valid, panel.id, manifestInfoByPanel);
    if (status === "loaded") {
      sawAny = true;
      continue;
    }
    allLoaded = false;
    if (status === "loading") {
      hasLoading = true;
    } else if (status === "error") {
      hasError = true;
    }
  }
  if (allLoaded && sawAny) {
    return "loaded";
  }
  if (hasError) {
    return "error";
  }
  if (hasLoading) {
    return "loading";
  }
  return "pending";
}

function normalizeTimelineStatus(value: unknown): FrameHourStatus {
  if (
    value === "loaded" ||
    value === "loading" ||
    value === "error" ||
    value === "pending" ||
    value === "unavailable"
  ) {
    return value;
  }
  return "pending";
}

function omitKey<T extends Record<string, unknown>>(input: T, key: string): T {
  if (!(key in input)) {
    return input;
  }
  const next = { ...input };
  delete next[key];
  return next;
}
