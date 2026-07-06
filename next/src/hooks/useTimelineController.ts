import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MODEL_CONFIG } from "../config/constants";
import { findNearestValidTime, pickInitialValidTime, toEpochMs } from "../core/time";
import type { FrameHourStatus, ManifestUiInfo, PanelState, ResolvedFrame, TimelineMode, ValidTimeIso } from "../types";

const PLAYBACK_BASE_INTERVAL_MS = 1200;
const PLAYBACK_LAST_FRAME_DWELL_MS = 900;
// While holding on an undecoded frame, re-check its status this often so
// playback resumes promptly once the frame lands.
const PLAYBACK_HOLD_POLL_MS = 250;

export type PlaybackSpeed = 0.5 | 1 | 2;

interface TimelineControllerOptions {
  availableValidTimesByPanel: Record<string, ValidTimeIso[]>;
  initialTimelineMode?: TimelineMode;
  initialValidTimeIso?: ValidTimeIso | null;
  manifestInfoByPanel: Record<string, ManifestUiInfo>;
  panels: PanelState[];
  resolvedFrameByPanel: Record<string, ResolvedFrame | null>;
}

export function useTimelineController({
  availableValidTimesByPanel,
  initialTimelineMode = "overlap",
  initialValidTimeIso = null,
  manifestInfoByPanel,
  panels,
  resolvedFrameByPanel,
}: TimelineControllerOptions) {
  const [sharedSelectedValidTimeIso, setSharedSelectedValidTimeIso] = useState<ValidTimeIso | null>(null);
  const [panelSelectedValidTimes, setPanelSelectedValidTimes] = useState<Record<string, ValidTimeIso | null>>({});
  const [timelineMode, setTimelineMode] = useState<TimelineMode>(initialTimelineMode);
  const [playing, setPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);
  const [skipUnloaded, setSkipUnloaded] = useState(false);
  const { effectiveTimelineTargetPanelId, setTimelineTargetPanelId, timelineTargets } = useTimelineTargetState(panels);
  const { overlapValidTimes, timelineValidTimes } = useTimelineValidTimes({
    availableValidTimesByPanel,
    effectiveTimelineTargetPanelId,
    panels,
    timelineMode,
  });

  useSharedTimelineSelection({
    initialValidTimeIso,
    overlapValidTimes,
    setSharedSelectedValidTimeIso,
    sharedSelectedValidTimeIso,
    timelineMode,
  });
  usePanelTimelineDefaults({
    availableValidTimesByPanel,
    initialValidTimeIso,
    panels,
    setPanelSelectedValidTimes,
    timelineMode,
  });
  const selectedTimelineValidTimeIso =
    timelineMode === "panel"
      ? panelSelectedValidTimes[effectiveTimelineTargetPanelId || ""] || null
      : sharedSelectedValidTimeIso;

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

  const playbackHolding = useTimelinePlayback({
    effectiveTimelineTargetPanelId,
    playbackSpeed,
    playing,
    selectedTimelineValidTimeIso,
    setPanelSelectedValidTimes,
    setSharedSelectedValidTimeIso,
    skipUnloaded,
    timelineMode,
    timelineStatusByValidTime,
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

  const togglePlaying = useCallback((): void => {
    setPlaying((prev) => !prev);
  }, []);

  const stepFrame = useCallback(
    (direction: 1 | -1): void => {
      if (!timelineValidTimes.length) {
        return;
      }
      if (timelineMode === "panel") {
        const panelId = effectiveTimelineTargetPanelId || panels[0]?.id || null;
        if (!panelId) {
          return;
        }
        setPanelSelectedValidTimes((prev) => {
          const next = stepTimelineValue(prev[panelId] || null, timelineValidTimes, direction);
          if (prev[panelId] === next) {
            return prev;
          }
          return {
            ...prev,
            [panelId]: next,
          };
        });
        return;
      }
      setSharedSelectedValidTimeIso((prev) => stepTimelineValue(prev, timelineValidTimes, direction));
    },
    [effectiveTimelineTargetPanelId, panels, timelineMode, timelineValidTimes],
  );

  return {
    clearPanelSelection,
    currentFrameLabel,
    effectiveTimelineTargetPanelId,
    handlePanelSelectValidTime,
    handleTimelineModeChange,
    handleTimelineValidTimeChange,
    latestViewWarmupAnchorValidTimeIso,
    panelSelectedValidTimes,
    playbackHolding,
    playbackSpeed,
    playing,
    resolvePanelSelectedValidTime,
    selectedTimelineValidTimeIso,
    setPlaybackSpeed,
    setSkipUnloaded,
    setTimelineTargetPanelId,
    skipUnloaded,
    stepFrame,
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
  initialValidTimeIso,
  overlapValidTimes,
  setSharedSelectedValidTimeIso,
  sharedSelectedValidTimeIso,
  timelineMode,
}: {
  initialValidTimeIso: ValidTimeIso | null;
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
      // Transient empty window (a model/run switch clears panel data before the
      // new manifest lands): keep the last real selection instead of nulling it,
      // so the nearest-to-current-selection mapping below wins when times return.
      // Nulling here would send a mid-session switch through the no-prior branch
      // (nearest-to-now) and jump the user to a far-off frame.
      return;
    }
    if (sharedSelectedValidTimeIso && overlapValidTimes.includes(sharedSelectedValidTimeIso)) {
      return;
    }
    if (sharedSelectedValidTimeIso) {
      setSharedSelectedValidTimeIso(findNearestValidTime(sharedSelectedValidTimeIso, overlapValidTimes));
      return;
    }
    setSharedSelectedValidTimeIso(pickInitialValidTime(initialValidTimeIso, overlapValidTimes));
  }, [initialValidTimeIso, overlapValidTimes, setSharedSelectedValidTimeIso, sharedSelectedValidTimeIso, timelineMode]);
}

function usePanelTimelineDefaults({
  availableValidTimesByPanel,
  initialValidTimeIso,
  panels,
  setPanelSelectedValidTimes,
  timelineMode,
}: {
  availableValidTimesByPanel: Record<string, ValidTimeIso[]>;
  initialValidTimeIso: ValidTimeIso | null;
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
        changed =
          syncPanelDefaultSelection(next, panel, availableValidTimesByPanel[panel.id] || [], initialValidTimeIso) ||
          changed;
      }
      return changed ? next : prev;
    });
  }, [availableValidTimesByPanel, initialValidTimeIso, panels, setPanelSelectedValidTimes, timelineMode]);
}

function useTimelinePlayback({
  effectiveTimelineTargetPanelId,
  playbackSpeed,
  playing,
  selectedTimelineValidTimeIso,
  setPanelSelectedValidTimes,
  setSharedSelectedValidTimeIso,
  skipUnloaded,
  timelineMode,
  timelineStatusByValidTime,
  timelineValidTimes,
}: {
  effectiveTimelineTargetPanelId: string | null;
  playbackSpeed: PlaybackSpeed;
  playing: boolean;
  selectedTimelineValidTimeIso: ValidTimeIso | null;
  setPanelSelectedValidTimes: Dispatch<SetStateAction<Record<string, ValidTimeIso | null>>>;
  setSharedSelectedValidTimeIso: Dispatch<SetStateAction<ValidTimeIso | null>>;
  skipUnloaded: boolean;
  timelineMode: TimelineMode;
  timelineStatusByValidTime: Partial<Record<ValidTimeIso, FrameHourStatus>>;
  timelineValidTimes: ValidTimeIso[];
}): boolean {
  const [playbackHolding, setPlaybackHolding] = useState(false);
  // Tracks the currently displayed frame without restarting the timer loop on
  // every advance; the loop reads it to decide whether the next delay dwells.
  const selectedValidTimeRef = useRef<ValidTimeIso | null>(selectedTimelineValidTimeIso);
  selectedValidTimeRef.current = selectedTimelineValidTimeIso;
  // Frame statuses change on every prefetch landing; read them through a ref
  // so the timer loop sees fresh statuses without restarting on each change.
  const statusByValidTimeRef = useRef(timelineStatusByValidTime);
  statusByValidTimeRef.current = timelineStatusByValidTime;

  useEffect(() => {
    if (!playing || timelineValidTimes.length <= 1) {
      // Not running (paused, or nothing to animate): clear any hold indicator.
      setPlaybackHolding(false);
      return;
    }
    if (skipUnloaded) {
      // Skip mode never holds; clear any indicator left over from a hold that
      // was in progress when the toggle flipped.
      setPlaybackHolding(false);
    }
    const lastValidTime = timelineValidTimes[timelineValidTimes.length - 1];
    const delayFor = (displayed: ValidTimeIso | null): number => {
      const dwell = displayed === lastValidTime ? PLAYBACK_LAST_FRAME_DWELL_MS : 0;
      return (PLAYBACK_BASE_INTERVAL_MS + dwell) / playbackSpeed;
    };
    const applySelection = (next: ValidTimeIso) => {
      if (timelineMode === "panel" && effectiveTimelineTargetPanelId) {
        setPanelSelectedValidTimes((prev) => withPanelSelection(prev, effectiveTimelineTargetPanelId, next));
      } else {
        setSharedSelectedValidTimeIso(next);
      }
    };
    let timer = 0;
    let heldForDecode = false;
    const tick = () => {
      // Read the displayed frame from the ref (fresh even after scrubbing or
      // stepping mid-playback) so delays and holds track what is on screen.
      const current = selectedValidTimeRef.current;
      const currentStatus = current ? statusByValidTimeRef.current[current] : undefined;
      if (!skipUnloaded && (currentStatus === "loading" || currentStatus === "pending")) {
        // Hold in place until the frame decodes instead of advancing past it
        // while the map still shows the previous frame's stale imagery.
        // "error"/"unavailable" frames advance normally — they will never
        // decode, so holding on them would stall playback forever.
        heldForDecode = true;
        setPlaybackHolding(true);
        timer = window.setTimeout(tick, PLAYBACK_HOLD_POLL_MS);
        return;
      }
      setPlaybackHolding(false);
      if (heldForDecode) {
        // The held frame just decoded; give it a normal on-screen interval
        // before advancing so the wait actually shows the frame.
        heldForDecode = false;
        timer = window.setTimeout(tick, delayFor(current));
        return;
      }
      const next = skipUnloaded
        ? nextLoadedValidTime(current, timelineValidTimes, statusByValidTimeRef.current).value
        : advanceTimelineValue(current, timelineValidTimes);
      applySelection(next);
      timer = window.setTimeout(tick, delayFor(next));
    };
    timer = window.setTimeout(tick, delayFor(selectedValidTimeRef.current));
    return () => window.clearTimeout(timer);
  }, [
    effectiveTimelineTargetPanelId,
    playbackSpeed,
    playing,
    setPanelSelectedValidTimes,
    setSharedSelectedValidTimeIso,
    skipUnloaded,
    timelineMode,
    timelineValidTimes,
  ]);

  return playbackHolding;
}

function syncPanelDefaultSelection(
  selections: Record<string, ValidTimeIso | null>,
  panel: PanelState,
  available: ValidTimeIso[],
  initialValidTimeIso: ValidTimeIso | null,
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
  selections[panel.id] = current
    ? findNearestValidTime(current, available)
    : pickInitialValidTime(initialValidTimeIso, available);
  return true;
}

function withPanelSelection(
  previous: Record<string, ValidTimeIso | null>,
  panelId: string,
  next: ValidTimeIso,
): Record<string, ValidTimeIso | null> {
  if (previous[panelId] === next) {
    return previous;
  }
  return {
    ...previous,
    [panelId]: next,
  };
}

// Walks from `current` to the next "loaded" frame (wrapping, bounded to one
// full loop) so skip-unloaded playback never lands on an undecoded frame. If
// no frame is loaded it falls back to the plain advance result.
function nextLoadedValidTime(
  current: ValidTimeIso | null,
  timelineValidTimes: ValidTimeIso[],
  statusByValidTime: Partial<Record<ValidTimeIso, FrameHourStatus>>,
  direction: 1 | -1 = 1,
): { value: ValidTimeIso; holding: boolean } {
  let candidate = current;
  for (let step = 0; step < timelineValidTimes.length; step += 1) {
    candidate = stepTimelineValue(candidate, timelineValidTimes, direction);
    if (statusByValidTime[candidate] === "loaded") {
      return { holding: false, value: candidate };
    }
  }
  return { holding: false, value: advanceTimelineValue(current, timelineValidTimes) };
}

function advanceTimelineValue(current: ValidTimeIso | null, timelineValidTimes: ValidTimeIso[]): ValidTimeIso {
  const active = current && timelineValidTimes.includes(current) ? current : timelineValidTimes[0];
  const index = timelineValidTimes.indexOf(active);
  return timelineValidTimes[(index + 1) % timelineValidTimes.length];
}

function stepTimelineValue(
  current: ValidTimeIso | null,
  timelineValidTimes: ValidTimeIso[],
  direction: 1 | -1,
): ValidTimeIso {
  const active = current && timelineValidTimes.includes(current) ? current : timelineValidTimes[0];
  const index = timelineValidTimes.indexOf(active);
  const length = timelineValidTimes.length;
  return timelineValidTimes[(index + direction + length) % length];
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
