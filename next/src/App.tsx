import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppHeader from "./components/AppHeader";
import HelpPopover from "./components/HelpPopover";
import MapPanel from "./components/MapPanel";
import Timeline from "./components/Timeline";
import { loadStoredDisplaySettings, storeDisplaySettings } from "./config/display";
import { loadStoredSessionState, storeSessionState } from "./config/session";
import {
  cloneRenderSelection,
  DEFAULT_RENDER_SELECTION,
  loadStoredRenderSelection,
  storeRenderSelection,
  type RenderSelection,
} from "./config/render";
import { useAvailableRuns } from "./hooks/useAvailableRuns";
import { useRenderActions } from "./hooks/useRenderActions";
import { loadStoredTimeZone, resolveTimeZone, storeTimeZone } from "./config/timezone";
import { useChromeOffsets } from "./hooks/useChromeOffsets";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useLatestViewWarmup } from "./hooks/useLatestViewWarmup";
import { usePanelCollection } from "./hooks/usePanelCollection";
import { usePanelManifests } from "./hooks/usePanelManifests";
import { useTimelineController } from "./hooks/useTimelineController";
import { useViewportSync } from "./hooks/useViewportSync";
import { readUrlState, writeUrlState } from "./core/url-state";
import type { LayerKey, ModelKey, ReflectivityGateDbz, SynopticDetailMode, ValidTimeIso, ViewKey } from "./types";

export default function App() {
  const initialSession = useMemo(() => loadStoredSessionState(), []);
  const initialUrl = useMemo(() => readUrlState(), []);
  const [viewKey, setViewKey] = useState<ViewKey>(initialUrl.view ?? initialSession.viewKey);
  // URL ?hour= steers the initial frame pick only; once any frame is selected
  // it is consumed so later re-defaults fall back to nearest-to-now.
  const [initialFrameValidTimeIso, setInitialFrameValidTimeIso] = useState<ValidTimeIso | null>(initialUrl.hour);
  const [showIsobars, setShowIsobars] = useState(initialSession.showIsobars);
  const [showCenters, setShowCenters] = useState(initialSession.showCenters);
  const [showThickness, setShowThickness] = useState(initialSession.showThickness);
  const [synopticDetailMode, setSynopticDetailMode] = useState<SynopticDetailMode>(initialSession.synopticDetailMode);
  const [reflectivityGate, setReflectivityGate] = useState<ReflectivityGateDbz>(initialSession.reflectivityGate);
  const [display, setDisplay] = useState(loadStoredDisplaySettings);
  const [timeZone, setTimeZone] = useState(loadStoredTimeZone);
  const resolvedTimeZone = useMemo(() => resolveTimeZone(timeZone), [timeZone]);
  const [settingsOpen, setSettingsOpen] = useState(initialSession.settingsOpen);
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const [renderMenuOpen, setRenderMenuOpen] = useState(false);
  // Help dialog open state, toggled by the ? shortcut and the header button.
  const [helpOpen, setHelpOpen] = useState(false);
  // The sounding drawer state lives inside each MapPanel, so Escape bumps a
  // nonce that panels consume via an effect to close their own drawer/menus.
  const [escapeNonce, setEscapeNonce] = useState(0);
  const [renderSelection, setRenderSelection] = useState<RenderSelection>(loadStoredRenderSelection);
  const {
    jobs: renderJobs,
    submitRender,
    prefetchSoundings,
    canSubmit: canSubmitRender,
  } = useRenderActions(renderSelection);
  // Run-picker data: only fetched while the menu is open in "pick" mode.
  const availableRuns = useAvailableRuns(
    renderSelection.models,
    renderSelection.view,
    renderMenuOpen && renderSelection.runMode === "pick",
  );
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
  } = useTimelineController({
    availableValidTimesByPanel,
    initialTimelineMode: initialSession.timelineMode,
    initialValidTimeIso: initialFrameValidTimeIso,
    manifestInfoByPanel,
    panels,
    resolvedFrameByPanel,
  });
  const { handleMapDestroyed, handleMapReady, layoutVersion, linkViewports, setLinkViewports, unregisterPanel } =
    useViewportSync(panels.length, initialSession.viewportLink);

  // Escape closes transient surfaces only. The Settings strip is deliberately
  // excluded: it is session-persisted, so collapsing it here would also persist
  // it closed across reloads from an Escape aimed at the drawer or a menu.
  const handleEscape = useCallback(() => {
    setEscapeNonce((nonce) => nonce + 1);
    setDisplayMenuOpen(false);
    setRenderMenuOpen(false);
    setHelpOpen(false);
  }, []);
  const toggleHelp = useCallback(() => setHelpOpen((open) => !open), []);
  useKeyboardShortcuts({
    onStepFrame: stepFrame,
    onTogglePlay: togglePlaying,
    onEscape: handleEscape,
    onHelp: toggleHelp,
  });

  useEffect(() => {
    if (initialFrameValidTimeIso && selectedTimelineValidTimeIso) {
      setInitialFrameValidTimeIso(null);
    }
  }, [initialFrameValidTimeIso, selectedTimelineValidTimeIso]);

  useEffect(() => {
    const firstPanel = panels[0];
    writeUrlState({
      view: viewKey,
      model: firstPanel?.modelKey ?? null,
      layer: firstPanel?.layers[0] ?? null,
      hour: selectedTimelineValidTimeIso,
    });
  }, [panels, selectedTimelineValidTimeIso, viewKey]);

  useEffect(() => {
    storeSessionState({
      viewKey,
      showIsobars,
      showCenters,
      showThickness,
      synopticDetailMode,
      reflectivityGate,
      settingsOpen,
      timelineMode,
      viewportLink: linkViewports,
    });
  }, [
    viewKey,
    showIsobars,
    showCenters,
    showThickness,
    synopticDetailMode,
    reflectivityGate,
    settingsOpen,
    timelineMode,
    linkViewports,
  ]);

  useEffect(() => {
    storeDisplaySettings(display);
  }, [display]);

  useEffect(() => {
    storeRenderSelection(renderSelection);
  }, [renderSelection]);

  const resetRenderSelection = useCallback(() => {
    setRenderSelection(cloneRenderSelection(DEFAULT_RENDER_SELECTION));
  }, []);

  useEffect(() => {
    storeTimeZone(timeZone);
  }, [timeZone]);

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

  // One-time URL override for the first panel's model/layer (URL wins over the
  // stored panel collection restored in usePanelCollection).
  const didApplyUrlOverridesRef = useRef(false);
  useEffect(() => {
    if (didApplyUrlOverridesRef.current) {
      return;
    }
    const firstPanel = panels[0];
    if (!firstPanel) {
      return;
    }
    didApplyUrlOverridesRef.current = true;
    if (initialUrl.model && initialUrl.model !== firstPanel.modelKey) {
      updatePanelModel(firstPanel.id, initialUrl.model);
    }
    if (initialUrl.layer && !firstPanel.layers.includes(initialUrl.layer)) {
      togglePanelLayer(firstPanel.id, initialUrl.layer);
    }
  }, [initialUrl.layer, initialUrl.model, panels, togglePanelLayer, updatePanelModel]);

  const updatePanelRun = useCallback(
    (panelId: string, runId: string | null): void => {
      updatePanelRunInCollection(panelId, runId);
      clearPanelData(panelId);
      clearPanelSelection(panelId);
    },
    [clearPanelData, clearPanelSelection, updatePanelRunInCollection],
  );

  const warmupActiveLayers = useMemo(() => {
    const keys = new Set<LayerKey>();
    for (const panel of panels) {
      for (const layer of panel.layers) {
        keys.add(layer);
      }
    }
    if (showIsobars || showThickness || showCenters) {
      keys.add("synoptic");
    }
    return Array.from(keys).sort();
  }, [panels, showCenters, showIsobars, showThickness]);

  useLatestViewWarmup({
    activeLayers: warmupActiveLayers,
    anchorValidTimeIso: latestViewWarmupAnchorValidTimeIso,
    manifestInfoByPanel,
    panels,
    reflectivityGate,
    resolvePanelSelectedValidTime,
    synopticDetailMode,
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
        helpOpen={helpOpen}
        onToggleHelp={toggleHelp}
        linkViewports={linkViewports}
        reflectivityGate={reflectivityGate}
        settingsOpen={settingsOpen}
        showCenters={showCenters}
        showIsobars={showIsobars}
        showThickness={showThickness}
        summaryText={summaryText}
        synopticDetailMode={synopticDetailMode}
        timeZone={timeZone}
        viewKey={viewKey}
        onAddPanel={addPanel}
        onChangeDisplay={setDisplay}
        onChangeDisplayMenuOpen={setDisplayMenuOpen}
        onChangeReflectivityGate={setReflectivityGate}
        onChangeSynopticDetailMode={setSynopticDetailMode}
        onChangeTimeZone={setTimeZone}
        onChangeView={setViewKey}
        onToggleCenters={() => setShowCenters((value) => !value)}
        onToggleIsobars={() => setShowIsobars((value) => !value)}
        onToggleLinkViewports={() => setLinkViewports((value) => !value)}
        onToggleSettings={() => setSettingsOpen((open) => !open)}
        onToggleThickness={() => setShowThickness((value) => !value)}
        renderSelection={renderSelection}
        renderMenuOpen={renderMenuOpen}
        renderJobs={renderJobs}
        canSubmitRender={canSubmitRender}
        renderAvailableRuns={availableRuns}
        onChangeRenderSelection={setRenderSelection}
        onChangeRenderMenuOpen={setRenderMenuOpen}
        onResetRenderSelection={resetRenderSelection}
        onSubmitRender={submitRender}
        onPrefetchSoundings={prefetchSoundings}
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
            initialValidTimeIso={initialFrameValidTimeIso}
            showIsobars={showIsobars}
            showThickness={showThickness}
            showCenters={showCenters}
            synopticDetailMode={synopticDetailMode}
            reflectivityGate={reflectivityGate}
            display={display}
            timeZone={resolvedTimeZone}
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
            escapeNonce={escapeNonce}
          />
        ))}
      </main>

      {/* ── Help dialog (opened by the ? shortcut or the header Help button) ── */}
      <HelpPopover open={helpOpen} onClose={() => setHelpOpen(false)} />

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
          playbackSpeed={playbackSpeed}
          onChangePlaybackSpeed={setPlaybackSpeed}
          onStepFrame={stepFrame}
          currentFrameLabel={currentFrameLabel}
          skipUnloaded={skipUnloaded}
          onChangeSkipUnloaded={setSkipUnloaded}
          playbackHolding={playbackHolding}
          statusByValidTime={timelineStatusByValidTime}
          timeZone={resolvedTimeZone}
        />
      </div>
    </div>
  );
}
