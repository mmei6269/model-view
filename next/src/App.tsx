import { useCallback, useEffect, useState } from "react";
import AppHeader from "./components/AppHeader";
import MapPanel from "./components/MapPanel";
import Timeline from "./components/Timeline";
import { DEFAULT_VIEW } from "./config/constants";
import { loadStoredDisplaySettings, storeDisplaySettings } from "./config/display";
import { useChromeOffsets } from "./hooks/useChromeOffsets";
import { useLatestViewWarmup } from "./hooks/useLatestViewWarmup";
import { usePanelCollection } from "./hooks/usePanelCollection";
import { usePanelManifests } from "./hooks/usePanelManifests";
import { useTimelineController } from "./hooks/useTimelineController";
import { useViewportSync } from "./hooks/useViewportSync";
import type { ModelKey, ReflectivityGateDbz, SynopticDetailMode, ViewKey } from "./types";

export default function App() {
  const [viewKey, setViewKey] = useState<ViewKey>(DEFAULT_VIEW);
  const [showIsobars, setShowIsobars] = useState(true);
  const [showCenters, setShowCenters] = useState(true);
  const [showThickness, setShowThickness] = useState(true);
  const [synopticDetailMode, setSynopticDetailMode] = useState<SynopticDetailMode>("simple");
  const [reflectivityGate, setReflectivityGate] = useState<ReflectivityGateDbz>(15);
  const [display, setDisplay] = useState(loadStoredDisplaySettings);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const {
    addPanel,
    panels,
    removePanel: removePanelFromCollection,
    togglePanelLayer,
    updatePanelModel: updatePanelModelInCollection,
    updatePanelRun: updatePanelRunInCollection,
  } = usePanelCollection();
  const { headerRef, rootRef, timelineRef } = useChromeOffsets(settingsOpen);
  const {
    availableValidTimesByPanel,
    clearPanelData,
    manifestInfoByPanel,
    resolvedFrameByPanel,
    summaryText,
    updatePanelAvailableValidTimes,
    updatePanelManifestInfo,
    updatePanelResolvedFrame,
  } = usePanelManifests(panels, viewKey);
  const {
    clearPanelSelection,
    currentFrameLabel,
    effectiveTimelineTargetPanelId,
    handlePanelSelectValidTime,
    handleTimelineModeChange,
    handleTimelineValidTimeChange,
    latestViewWarmupAnchorValidTimeIso,
    playing,
    resolvePanelSelectedValidTime,
    selectedTimelineValidTimeIso,
    setTimelineTargetPanelId,
    timelineMode,
    timelineStatusByValidTime,
    timelineTargets,
    timelineValidTimes,
    togglePlaying,
  } = useTimelineController({
    availableValidTimesByPanel,
    manifestInfoByPanel,
    panels,
    resolvedFrameByPanel,
  });
  const { handleMapDestroyed, handleMapReady, layoutVersion, linkViewports, setLinkViewports, unregisterPanel } =
    useViewportSync(panels.length);

  useEffect(() => {
    storeDisplaySettings(display);
  }, [display]);

  const removePanel = useCallback(
    (panelId: string): void => {
      removePanelFromCollection(panelId);
      unregisterPanel(panelId);
      clearPanelData(panelId);
      clearPanelSelection(panelId);
    },
    [clearPanelData, clearPanelSelection, removePanelFromCollection, unregisterPanel],
  );

  const updatePanelModel = useCallback(
    (panelId: string, modelKey: ModelKey): void => {
      updatePanelModelInCollection(panelId, modelKey);
      clearPanelData(panelId);
      clearPanelSelection(panelId);
    },
    [clearPanelData, clearPanelSelection, updatePanelModelInCollection],
  );

  const updatePanelRun = useCallback(
    (panelId: string, runId: string | null): void => {
      updatePanelRunInCollection(panelId, runId);
      clearPanelData(panelId);
      clearPanelSelection(panelId);
    },
    [clearPanelData, clearPanelSelection, updatePanelRunInCollection],
  );

  useLatestViewWarmup({
    anchorValidTimeIso: latestViewWarmupAnchorValidTimeIso,
    manifestInfoByPanel,
    panels,
    resolvePanelSelectedValidTime,
    viewKey,
  });

  return (
    <div
      ref={rootRef}
      className="grid h-screen w-screen grid-cols-1 grid-rows-[auto_1fr_auto] overflow-hidden bg-[#020914] text-slate-100"
    >
      <AppHeader
        canAddPanel={panels.length < 2}
        display={display}
        displayMenuOpen={displayMenuOpen}
        headerRef={headerRef}
        linkViewports={linkViewports}
        reflectivityGate={reflectivityGate}
        settingsOpen={settingsOpen}
        showCenters={showCenters}
        showIsobars={showIsobars}
        showThickness={showThickness}
        summaryText={summaryText}
        synopticDetailMode={synopticDetailMode}
        viewKey={viewKey}
        onAddPanel={addPanel}
        onChangeDisplay={setDisplay}
        onChangeDisplayMenuOpen={setDisplayMenuOpen}
        onChangeReflectivityGate={setReflectivityGate}
        onChangeSynopticDetailMode={setSynopticDetailMode}
        onChangeView={setViewKey}
        onToggleCenters={() => setShowCenters((value) => !value)}
        onToggleIsobars={() => setShowIsobars((value) => !value)}
        onToggleLinkViewports={() => setLinkViewports((value) => !value)}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
        onToggleThickness={() => setShowThickness((value) => !value)}
      />

      {/* ── Map grid (spans all rows, behind header/timeline for glass effect) ── */}
      <main
        className={`z-0 col-start-1 row-span-full row-start-1 grid ${panels.length === 1 ? "grid-cols-1" : "grid-cols-2"} gap-px bg-slate-800/30`}
      >
        {panels.map((panel) => (
          <MapPanel
            key={panel.id}
            panel={panel}
            viewKey={viewKey}
            selectedValidTimeIso={resolvePanelSelectedValidTime(panel.id)}
            showIsobars={showIsobars}
            showThickness={showThickness}
            showCenters={showCenters}
            synopticDetailMode={synopticDetailMode}
            reflectivityGate={reflectivityGate}
            display={display}
            canRemove={panels.length > 1}
            layoutVersion={layoutVersion}
            onMapReady={handleMapReady}
            onMapDestroyed={handleMapDestroyed}
            onAvailableValidTimesChange={updatePanelAvailableValidTimes}
            onResolvedFrameChange={updatePanelResolvedFrame}
            onLayerToggle={togglePanelLayer}
            onSelectValidTime={handlePanelSelectValidTime}
            onModelChange={updatePanelModel}
            onRunChange={updatePanelRun}
            onRemove={removePanel}
            onManifestInfoChange={updatePanelManifestInfo}
          />
        ))}
      </main>

      {/* ── Bottom timeline (row 3, overlaps map) ── */}
      <div ref={timelineRef} className="z-40 col-start-1 row-start-3">
        <Timeline
          availableValidTimes={timelineValidTimes}
          selectedValidTimeIso={selectedTimelineValidTimeIso}
          onChangeValidTime={handleTimelineValidTimeChange}
          timelineMode={timelineMode}
          onChangeTimelineMode={handleTimelineModeChange}
          timelineTargets={timelineTargets}
          timelineTargetId={effectiveTimelineTargetPanelId}
          onChangeTimelineTargetId={setTimelineTargetPanelId}
          onTogglePlay={togglePlaying}
          playing={playing}
          currentFrameLabel={currentFrameLabel}
          statusByValidTime={timelineStatusByValidTime}
        />
      </div>
    </div>
  );
}
