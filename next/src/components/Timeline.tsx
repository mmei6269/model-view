import { useMemo, type CSSProperties } from "react";
import { formatValidUtcShort, toEpochMs } from "../core/time";
import type { FrameHourStatus, TimelineMode, ValidTimeIso } from "../types";

const TIMELINE_THUMB_SIZE_PX = 14;
const TIMELINE_THUMB_RADIUS_PX = TIMELINE_THUMB_SIZE_PX / 2;

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
  currentFrameLabel: string;
  statusByValidTime?: Partial<Record<ValidTimeIso, FrameHourStatus>>;
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
  currentFrameLabel,
  statusByValidTime,
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
  const loadedCount = useMemo(
    () => timelineValidTimes.reduce((count, valid) => count + (statusByValidTime?.[valid] === "loaded" ? 1 : 0), 0),
    [statusByValidTime, timelineValidTimes],
  );
  const timelineTrackBackground = useMemo(
    () => buildTimelineTrackBackground(timelineValidTimes, statusByValidTime),
    [statusByValidTime, timelineValidTimes],
  );
  const timelineTrackStyle = { "--timeline-track-fill": timelineTrackBackground } as CSSProperties;

  return (
    <section className="glass-panel px-4 py-2.5">
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={onTogglePlay}
          className={`col-start-1 row-start-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-500 text-sm text-slate-950 shadow-[0_0_16px_rgba(34,211,238,0.25)] hover:bg-cyan-400 active:scale-95 ${
            playing ? "animate-[pulseGlow_2s_ease-in-out_infinite]" : ""
          }`}
        >
          {playing ? "\u23F8" : "\u25B6"}
        </button>
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
          className="timeline-range col-start-2 row-start-1 w-full min-w-0"
        />
        <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-2">
          <span className="shrink-0 rounded-full border border-white/[0.08] px-2 py-0.5 font-mono text-[11px] text-slate-300">
            {currentFrameLabel}
          </span>
          <div className="flex shrink-0 items-center gap-2">
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
          <div className="flex items-center justify-between text-[10px] text-slate-400">
            <span>{formatValidUtcShort(firstValid)}</span>
            <span className="text-slate-300/80">
              Loaded {loadedCount}/{timelineValidTimes.length || 0}
            </span>
            <span>{formatValidUtcShort(lastValid)}</span>
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
