import { useMemo, useState, type CSSProperties } from "react";
import { formatValidLabel, formatValidLocalShort, formatValidUtcShort, toEpochMs } from "../core/time";
import { PLAYBACK_BASE_INTERVAL_MS, type PlaybackSpeed } from "../hooks/useTimelineController";
import type { FrameHourStatus, TimelineMode, ValidTimeIso } from "../types";
import { computeDayBoundaryTicks } from "./timeline-track";

const TIMELINE_THUMB_SIZE_PX = 14;
const TIMELINE_THUMB_RADIUS_PX = TIMELINE_THUMB_SIZE_PX / 2;

const PLAYBACK_SPEED_OPTIONS: PlaybackSpeed[] = [0.5, 1, 2];

interface TimelineTargetOption {
  id: string;
  label: string;
}

interface TimelineProps {
  availableValidTimes: ValidTimeIso[];
  selectedValidTimeIso: ValidTimeIso | null;
  onChangeValidTime: (value: ValidTimeIso) => void;
  timelineMode: TimelineMode;
  onChangeTimelineMode: (value: TimelineMode) => void;
  timelineTargets: TimelineTargetOption[];
  timelineTargetId: string | null;
  onChangeTimelineTargetId: (value: string) => void;
  onTogglePlay: () => void;
  playing: boolean;
  playbackSpeed: PlaybackSpeed;
  onChangePlaybackSpeed: (value: PlaybackSpeed) => void;
  onStepFrame: (direction: 1 | -1) => void;
  currentFrameLabel: string;
  skipUnloaded: boolean;
  onChangeSkipUnloaded: (value: boolean) => void;
  playbackHolding: boolean;
  statusByValidTime?: Partial<Record<ValidTimeIso, FrameHourStatus>>;
  timeZone: string;
}

export default function Timeline({
  availableValidTimes,
  selectedValidTimeIso,
  onChangeValidTime,
  timelineMode,
  onChangeTimelineMode,
  timelineTargets,
  timelineTargetId,
  onChangeTimelineTargetId,
  onTogglePlay,
  playing,
  playbackSpeed,
  onChangePlaybackSpeed,
  onStepFrame,
  currentFrameLabel,
  skipUnloaded,
  onChangeSkipUnloaded,
  playbackHolding,
  statusByValidTime,
  timeZone,
}: TimelineProps) {
  const timelineValidTimes = useMemo(() => {
    if (!Array.isArray(availableValidTimes) || availableValidTimes.length === 0) {
      return [];
    }
    const unique = Array.from(new Set(availableValidTimes.filter(Boolean)));
    unique.sort((left, right) => toEpochMs(left) - toEpochMs(right));
    return unique;
  }, [availableValidTimes]);

  const index = useMemo(() => {
    if (!timelineValidTimes.length) {
      return 0;
    }
    const found = selectedValidTimeIso ? timelineValidTimes.indexOf(selectedValidTimeIso) : -1;
    return found >= 0 ? found : 0;
  }, [selectedValidTimeIso, timelineValidTimes]);
  const firstValid = timelineValidTimes[0] || null;
  const lastValid = timelineValidTimes[timelineValidTimes.length - 1] || null;
  const firstLocal = formatValidLocalShort(firstValid, timeZone);
  const lastLocal = formatValidLocalShort(lastValid, timeZone);
  const loadedCount = useMemo(
    () => timelineValidTimes.reduce((count, valid) => count + (statusByValidTime?.[valid] === "loaded" ? 1 : 0), 0),
    [statusByValidTime, timelineValidTimes],
  );
  const timelineTrackBackground = useMemo(
    () => buildTimelineTrackBackground(timelineValidTimes, statusByValidTime),
    [statusByValidTime, timelineValidTimes],
  );
  const timelineTrackStyle = { "--timeline-track-fill": timelineTrackBackground } as CSSProperties;
  const dayBoundaryTicks = useMemo(
    () => computeDayBoundaryTicks(timelineValidTimes, timeZone),
    [timeZone, timelineValidTimes],
  );
  // Scrub tooltip: the native title reflects the hovered frame while the
  // pointer is over the track, else the selected frame.
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const hoveredValid = hoveredIndex !== null ? (timelineValidTimes[hoveredIndex] ?? null) : null;
  const scrubTitle = formatValidLabel(hoveredValid ?? selectedValidTimeIso, timeZone);

  return (
    <section className="glass-panel px-4 py-2.5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-x-3 gap-y-1">
        <div className="col-start-1 row-start-1 flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label="Previous frame"
            onClick={() => onStepFrame(-1)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-[11px] text-slate-300 hover:bg-white/[0.08] hover:text-slate-100 active:scale-95"
          >
            {"\u23EE"}
          </button>
          <button
            type="button"
            aria-label={playing ? "Pause playback" : "Play timeline"}
            // The scheduling contract, exposed for specs: wall-clock speed
            // ratios are unobservable on render-bound CI shards, so tests
            // assert the interval the playback loop will actually schedule.
            data-playback-interval-ms={Math.round(PLAYBACK_BASE_INTERVAL_MS / playbackSpeed)}
            onClick={onTogglePlay}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-500 text-sm text-slate-950 shadow-[0_0_16px_rgba(34,211,238,0.25)] hover:bg-cyan-400 active:scale-95 ${
              playing ? "animate-[pulseGlow_2s_ease-in-out_infinite]" : ""
            }`}
          >
            {playing ? "\u23F8" : "\u25B6"}
          </button>
          <button
            type="button"
            aria-label="Next frame"
            onClick={() => onStepFrame(1)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-[11px] text-slate-300 hover:bg-white/[0.08] hover:text-slate-100 active:scale-95"
          >
            {"\u23ED"}
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0, timelineValidTimes.length - 1)}
          value={index}
          disabled={timelineValidTimes.length === 0}
          onChange={(event) => {
            const nextIndex = Number(event.target.value);
            const nextValid = timelineValidTimes[nextIndex] ?? firstValid;
            if (nextValid) {
              onChangeValidTime(nextValid);
            }
          }}
          style={timelineTrackStyle}
          title={scrubTitle}
          onPointerMove={(event) => {
            if (timelineValidTimes.length === 0) {
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width <= 0) {
              return;
            }
            const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            setHoveredIndex(Math.round(ratio * (timelineValidTimes.length - 1)));
          }}
          onPointerLeave={() => setHoveredIndex(null)}
          className="timeline-range col-start-2 row-start-1 w-full min-w-0"
        />
        <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-2">
          {playbackHolding ? (
            <span
              data-testid="playback-holding"
              title="Waiting for this frame to load"
              className="flex shrink-0 animate-pulse items-center gap-1 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] text-cyan-200"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
              Loading
            </span>
          ) : null}
          <span
            data-testid="frame-label"
            aria-label={`Current frame ${currentFrameLabel}`}
            className="shrink-0 rounded-full border border-white/[0.08] px-2 py-0.5 font-mono text-[11px] text-slate-300"
          >
            {currentFrameLabel}
          </span>
          <div
            role="group"
            aria-label="Playback speed"
            className="flex shrink-0 items-center overflow-hidden rounded-lg border border-white/[0.06] bg-white/[0.04]"
          >
            {PLAYBACK_SPEED_OPTIONS.map((speed) => (
              <button
                key={speed}
                type="button"
                aria-pressed={playbackSpeed === speed}
                onClick={() => onChangePlaybackSpeed(speed)}
                className={`px-2 py-1 text-[11px] ${
                  playbackSpeed === speed
                    ? "bg-cyan-500/20 text-cyan-200"
                    : "text-slate-300 hover:bg-white/[0.06] hover:text-slate-100"
                }`}
              >
                {`${speed}×`}
              </button>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={skipUnloaded}
                onChange={(event) => onChangeSkipUnloaded(event.target.checked)}
                className="h-3 w-3 accent-cyan-400"
              />
              Skip unloaded
            </label>
            <label className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-slate-300">
              Axis
              <select
                value={timelineMode}
                onChange={(event) => onChangeTimelineMode(event.target.value as TimelineMode)}
                className="bg-transparent text-[11px] text-slate-100 outline-none"
              >
                <option value="overlap" className="bg-slate-900">
                  Overlap
                </option>
                <option value="panel" className="bg-slate-900">
                  Panel
                </option>
              </select>
            </label>
            {timelineMode === "panel" && timelineTargets.length > 0 ? (
              <label className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-slate-300">
                Track
                <select
                  value={timelineTargetId || timelineTargets[0]?.id || ""}
                  onChange={(event) => onChangeTimelineTargetId(event.target.value)}
                  className="bg-transparent text-[11px] text-slate-100 outline-none"
                >
                  {timelineTargets.map((target) => (
                    <option key={target.id} value={target.id} className="bg-slate-900">
                      {target.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>

        <div className="col-start-2 row-start-2 min-w-0">
          {dayBoundaryTicks.length > 0 ? (
            <div className="relative h-4 min-w-0">
              {dayBoundaryTicks.map((tick) => (
                <span
                  key={tick.index}
                  data-testid="timeline-day-label"
                  className="absolute top-0 flex -translate-x-1/2 flex-col items-center leading-none"
                  style={{ left: `${formatPercent(tick.positionPercent)}%` }}
                >
                  <span className="h-1 w-px bg-slate-500" />
                  <span className="whitespace-nowrap pt-0.5 font-mono text-[9px] text-slate-400">{tick.label}</span>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex items-start justify-between text-[10px] text-slate-400">
            <span className="flex flex-col items-start leading-tight">
              <span>{formatValidUtcShort(firstValid)}</span>
              {firstLocal ? <span className="text-slate-500">{firstLocal}</span> : null}
            </span>
            <span
              aria-label={`Loaded ${loadedCount} of ${timelineValidTimes.length || 0} frames`}
              className="pt-px text-slate-300/80"
            >
              Loaded {loadedCount}/{timelineValidTimes.length || 0}
            </span>
            <span className="flex flex-col items-end leading-tight">
              <span>{formatValidUtcShort(lastValid)}</span>
              {lastLocal ? <span className="text-slate-500">{lastLocal}</span> : null}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function buildTimelineTrackBackground(
  timelineValidTimes: ValidTimeIso[],
  statusByValidTime?: Partial<Record<ValidTimeIso, FrameHourStatus>>,
): string {
  if (timelineValidTimes.length === 0) {
    return "rgba(148, 163, 184, 0.2)";
  }
  if (timelineValidTimes.length === 1) {
    return `linear-gradient(to right, ${timelineStatusColor(statusByValidTime?.[timelineValidTimes[0]])} 0% 100%)`;
  }

  const stops = timelineValidTimes.map((valid, index) => {
    const color = timelineStatusColor(statusByValidTime?.[valid]);
    return `${color} ${timelineSegmentBoundary(index - 0.5, timelineValidTimes.length)} ${timelineSegmentBoundary(
      index + 0.5,
      timelineValidTimes.length,
    )}`;
  });

  return `linear-gradient(to right, ${stops.join(", ")})`;
}

function timelineSegmentBoundary(rawFrameIndex: number, frameCount: number): string {
  if (rawFrameIndex <= 0) {
    return "0%";
  }
  if (rawFrameIndex >= frameCount - 1) {
    return "100%";
  }
  const travelRatio = rawFrameIndex / (frameCount - 1);
  return formatCalcPosition(travelRatio * 100, TIMELINE_THUMB_RADIUS_PX - TIMELINE_THUMB_SIZE_PX * travelRatio);
}

function timelineStatusColor(status: FrameHourStatus | undefined): string {
  if (status === "loaded") {
    return "rgba(52, 211, 153, 0.9)";
  }
  if (status === "loading") {
    return "rgba(34, 211, 238, 0.8)";
  }
  if (status === "error") {
    return "rgba(244, 63, 94, 0.8)";
  }
  if (status === "unavailable") {
    return "rgb(51, 65, 85)";
  }
  return "rgba(71, 85, 105, 0.7)";
}

function formatPercent(value: number): string {
  return String(Number(value.toFixed(4)));
}

function formatPx(value: number): string {
  return String(Number(value.toFixed(4)));
}

function formatCalcPosition(percent: number, pxOffset: number): string {
  const operator = pxOffset < 0 ? "-" : "+";
  return `calc(${formatPercent(percent)}% ${operator} ${formatPx(Math.abs(pxOffset))}px)`;
}
