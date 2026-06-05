import type { ReactNode, RefObject } from "react";
import DisplayMenu from "./DisplayMenu";
import { VIEW_CONFIG, VIEW_KEYS } from "../config/constants";
import type { MapDisplaySettings } from "../config/display";
import type { ReflectivityGateDbz, SynopticDetailMode, ViewKey } from "../types";

interface AppHeaderProps {
  canAddPanel: boolean;
  display: MapDisplaySettings;
  displayMenuOpen: boolean;
  headerRef: RefObject<HTMLElement | null>;
  linkViewports: boolean;
  reflectivityGate: ReflectivityGateDbz;
  settingsOpen: boolean;
  showCenters: boolean;
  showIsobars: boolean;
  showThickness: boolean;
  summaryText: string;
  synopticDetailMode: SynopticDetailMode;
  viewKey: ViewKey;
  onAddPanel: () => void;
  onChangeDisplay: (display: MapDisplaySettings) => void;
  onChangeDisplayMenuOpen: (open: boolean) => void;
  onChangeReflectivityGate: (gate: ReflectivityGateDbz) => void;
  onChangeSynopticDetailMode: (mode: SynopticDetailMode) => void;
  onChangeView: (viewKey: ViewKey) => void;
  onToggleCenters: () => void;
  onToggleIsobars: () => void;
  onToggleLinkViewports: () => void;
  onToggleSettings: () => void;
  onToggleThickness: () => void;
}

export default function AppHeader({
  canAddPanel,
  display,
  displayMenuOpen,
  headerRef,
  linkViewports,
  reflectivityGate,
  settingsOpen,
  showCenters,
  showIsobars,
  showThickness,
  summaryText,
  synopticDetailMode,
  viewKey,
  onAddPanel,
  onChangeDisplay,
  onChangeDisplayMenuOpen,
  onChangeReflectivityGate,
  onChangeSynopticDetailMode,
  onChangeView,
  onToggleCenters,
  onToggleIsobars,
  onToggleLinkViewports,
  onToggleSettings,
  onToggleThickness,
}: AppHeaderProps) {
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
        </div>
      </div>

      <div
        className={`overflow-hidden transition-all duration-300 ease-out ${
          settingsOpen ? "mt-2 max-h-24 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
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
            <TogglePill active={showIsobars} onClick={onToggleIsobars}>
              Isobars
            </TogglePill>
            <TogglePill active={showThickness} onClick={onToggleThickness}>
              Thickness
            </TogglePill>
            <TogglePill active={showCenters} onClick={onToggleCenters}>
              Centers
            </TogglePill>
            <label className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2.5 py-1.5 text-xs">
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
        </div>
      </div>
    </header>
  );
}

function TogglePill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
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
