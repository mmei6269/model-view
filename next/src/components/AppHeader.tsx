import type { ReactNode, RefObject } from "react";
import DisplayMenu from "./DisplayMenu";
import RenderMenu, { type RenderJobEntry } from "./RenderMenu";
import { VIEW_CONFIG, VIEW_KEYS } from "../config/constants";
import { MAX_PANELS } from "../config/panels";
import type { MapDisplaySettings } from "../config/display";
import type { RenderSelection } from "../config/render";
import type { AvailableRunsState } from "../hooks/useAvailableRuns";
import { TIMEZONE_OPTIONS } from "../config/timezone";
import type { ReflectivityGateDbz, SynopticDetailMode, ViewKey } from "../types";

interface AppHeaderProps {
  canAddPanel: boolean;
  onCopyLink: () => void;
  display: MapDisplaySettings;
  displayMenuOpen: boolean;
  headerRef: RefObject<HTMLElement | null>;
  helpOpen: boolean;
  onToggleHelp: () => void;
  linkViewports: boolean;
  reflectivityGate: ReflectivityGateDbz;
  settingsOpen: boolean;
  showCenters: boolean;
  showIsobars: boolean;
  showThickness: boolean;
  summaryText: string;
  synopticDetailMode: SynopticDetailMode;
  timeZone: string;
  viewKey: ViewKey;
  onAddPanel: () => void;
  onChangeDisplay: (display: MapDisplaySettings) => void;
  onChangeDisplayMenuOpen: (open: boolean) => void;
  onChangeReflectivityGate: (gate: ReflectivityGateDbz) => void;
  onChangeSynopticDetailMode: (mode: SynopticDetailMode) => void;
  onChangeTimeZone: (value: string) => void;
  onChangeView: (viewKey: ViewKey) => void;
  onToggleCenters: () => void;
  onToggleIsobars: () => void;
  onToggleLinkViewports: () => void;
  onToggleSettings: () => void;
  onToggleThickness: () => void;
  renderSelection: RenderSelection;
  renderMenuOpen: boolean;
  renderJobs: RenderJobEntry[];
  canSubmitRender: boolean;
  renderAvailableRuns: AvailableRunsState;
  onChangeRenderSelection: (selection: RenderSelection) => void;
  onChangeRenderMenuOpen: (open: boolean) => void;
  onResetRenderSelection: () => void;
  onSubmitRender: () => void;
  onPrefetchSoundings: () => void;
  onCancelRenderJob: (jobId: string) => void;
  onDismissRenderJob: (jobId: string) => void;
}

export default function AppHeader({
  canAddPanel,
  onCopyLink,
  display,
  displayMenuOpen,
  headerRef,
  helpOpen,
  onToggleHelp,
  linkViewports,
  reflectivityGate,
  settingsOpen,
  showCenters,
  showIsobars,
  showThickness,
  summaryText,
  synopticDetailMode,
  timeZone,
  viewKey,
  onAddPanel,
  onChangeDisplay,
  onChangeDisplayMenuOpen,
  onChangeReflectivityGate,
  onChangeSynopticDetailMode,
  onChangeTimeZone,
  onChangeView,
  onToggleCenters,
  onToggleIsobars,
  onToggleLinkViewports,
  onToggleSettings,
  onToggleThickness,
  renderSelection,
  renderMenuOpen,
  renderJobs,
  canSubmitRender,
  renderAvailableRuns,
  onChangeRenderSelection,
  onChangeRenderMenuOpen,
  onResetRenderSelection,
  onSubmitRender,
  onPrefetchSoundings,
  onCancelRenderJob,
  onDismissRenderJob,
}: AppHeaderProps) {
  const isCustomTimeZone = !TIMEZONE_OPTIONS.some((option) => option.value === timeZone);
  return (
    <header ref={headerRef} className="z-40 col-start-1 row-start-1 glass-panel px-4 py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">Model View</h1>
          <span className="hidden rounded-full border border-white/[0.1] px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-slate-400 sm:inline-block">
            Forecast Workbench
          </span>
        </div>
        <p className="hidden flex-1 text-center text-xs text-slate-400 md:block">{summaryText}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onAddPanel}
            disabled={!canAddPanel}
            title={canAddPanel ? undefined : `Maximum ${MAX_PANELS} maps`}
            className="rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 active:scale-95 disabled:opacity-40"
          >
            Add Map
          </button>
          <label className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-xs">
            <span className="text-slate-400">View</span>
            <select
              value={viewKey}
              onChange={(event) => onChangeView(event.target.value as ViewKey)}
              className="bg-transparent text-xs outline-none"
            >
              {VIEW_KEYS.map((key) => (
                <option key={key} value={key} className="bg-slate-900">
                  {VIEW_CONFIG[key].label}
                </option>
              ))}
            </select>
          </label>
          <DisplayMenu
            display={display}
            open={displayMenuOpen}
            onOpenChange={onChangeDisplayMenuOpen}
            onChange={onChangeDisplay}
          />
          <RenderMenu
            selection={renderSelection}
            open={renderMenuOpen}
            onOpenChange={onChangeRenderMenuOpen}
            onChange={onChangeRenderSelection}
            onReset={onResetRenderSelection}
            onSubmit={onSubmitRender}
            onPrefetchSoundings={onPrefetchSoundings}
            onCancelJob={onCancelRenderJob}
            onDismissJob={onDismissRenderJob}
            jobs={renderJobs}
            canSubmit={canSubmitRender}
            availableRuns={renderAvailableRuns}
          />
          <button
            type="button"
            onClick={onCopyLink}
            title="Copy a link to the current view (panels, layers, frame, viewport)"
            className="rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-xs font-medium text-slate-400 hover:bg-white/[0.08] active:scale-95"
          >
            Share
          </button>
          <button
            type="button"
            onClick={onToggleSettings}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium active:scale-95 ${
              settingsOpen
                ? "border-cyan-400/30 bg-cyan-500/20 text-cyan-300"
                : "border-white/[0.06] bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]"
            }`}
          >
            Settings
          </button>
          <button
            type="button"
            aria-label="Help"
            aria-haspopup="dialog"
            aria-expanded={helpOpen}
            title="Help & shortcuts"
            onClick={onToggleHelp}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold active:scale-95 ${
              helpOpen
                ? "border-cyan-400/30 bg-cyan-500/20 text-cyan-300"
                : "border-white/[0.06] bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]"
            }`}
          >
            ?
          </button>
        </div>
      </div>

      <div
        className={`grid transition-all duration-300 ease-out ${
          settingsOpen ? "mt-2 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        {/* overflow-hidden zeroes the grid item's min-height so the 0fr row can fully collapse */}
        <div className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/[0.06] pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Map</span>
              <TogglePill active={linkViewports} onClick={onToggleLinkViewports}>
                Link Viewports
              </TogglePill>
            </div>
            <div className="hidden h-5 w-px bg-white/[0.06] sm:block" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Overlays</span>
              <TogglePill
                active={showIsobars}
                onClick={onToggleIsobars}
                title="Model MSLP contours: 4 hPa in Simple mode, 2 hPa in Detailed mode, with 8 hPa major contours. Presentation smoothing is model-dependent."
              >
                Isobars
              </TogglePill>
              <TogglePill
                active={showThickness}
                onClick={onToggleThickness}
                title="1000-500 mb thickness: 6 dam contours with 12 dam majors. The emphasized 540 dam line is a synoptic thermal reference, not a universal rain/snow boundary."
              >
                Thickness
              </TogglePill>
              <TogglePill
                active={showCenters}
                onClick={onToggleCenters}
                title="Automated model-guidance H/L centers: local MSLP extrema with at least 1.8 hPa annular prominence, capped at 12 highs and 12 lows. These are not an analyzed surface chart."
              >
                Centers
              </TogglePill>
              <label
                className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-xs"
                title="Changes isobar contour density only; the automated H/L center roster is identical in both modes. While Detailed vectors load or if unavailable, any displayed combined raster is explicitly identified as Simple."
              >
                <span className="text-slate-400">Isobar Detail</span>
                <select
                  value={synopticDetailMode}
                  onChange={(event) => onChangeSynopticDetailMode(event.target.value as SynopticDetailMode)}
                  className="bg-transparent text-xs outline-none"
                >
                  <option value="simple" className="bg-slate-900">
                    Simple
                  </option>
                  <option value="detailed" className="bg-slate-900">
                    Detailed
                  </option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-xs">
                <span className="text-slate-400">Refl Gate</span>
                <select
                  value={String(reflectivityGate)}
                  onChange={(event) => onChangeReflectivityGate(Number(event.target.value) as ReflectivityGateDbz)}
                  className="bg-transparent text-xs outline-none"
                >
                  <option value="10" className="bg-slate-900">
                    &ge; 10 dBZ
                  </option>
                  <option value="15" className="bg-slate-900">
                    &ge; 15 dBZ
                  </option>
                  <option value="20" className="bg-slate-900">
                    &ge; 20 dBZ
                  </option>
                </select>
              </label>
            </div>
            <div className="hidden h-5 w-px bg-white/[0.06] sm:block" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Time</span>
              <label className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-xs">
                <span className="text-slate-400">Zone</span>
                <select
                  value={timeZone}
                  onChange={(event) => onChangeTimeZone(event.target.value)}
                  className="bg-transparent text-xs outline-none"
                  aria-label="Time zone"
                >
                  {TIMEZONE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value} className="bg-slate-900">
                      {option.label}
                    </option>
                  ))}
                  {isCustomTimeZone ? (
                    <option value={timeZone} className="bg-slate-900">
                      {timeZone}
                    </option>
                  ) : null}
                </select>
              </label>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function TogglePill({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium active:scale-95 ${
        active
          ? "border-cyan-400/30 bg-cyan-500/20 text-cyan-300"
          : "border-white/[0.06] bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]"
      }`}
    >
      {children}
    </button>
  );
}
