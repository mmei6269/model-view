import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppHeader from "./components/AppHeader";
import HelpPopover from "./components/HelpPopover";
import ToastHost from "./components/ToastHost";
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
import { readUrlState, writeUrlState, type UrlViewport } from "./core/url-state";
import { MAX_PANELS } from "./config/panels";
import { pushToast } from "./core/toasts";
import { installTestBridge, registerTestBridgePanel, unregisterTestBridgePanel } from "./core/map-engine/test-bridge";
import type { MapEngine } from "./core/map-engine/types";
import type { LayerKey, ModelKey, ReflectivityGateDbz, SynopticDetailMode, ValidTimeIso, ViewKey } from "./types";

// window.__wx for Playwright specs — installed unconditionally (localhost-only
// app); panel registration piggybacks on the map ready/destroyed callbacks.
installTestBridge();

export default function App() {
  const initialSession = useMemo(() => loadStoredSessionState(), []);
  const initialUrl = useMemo(() => readUrlState(), []);
  const [viewKey, setViewKey] = useState<ViewKey>(initialUrl.view ?? initialSession.viewKey);
  // URL ?hour= steers the initial frame pick only; once any frame is selected
  // it is consumed so later re-defaults fall back to nearest-to-now.
  const [initialFrameValidTimeIso, setInitialFrameValidTimeIso] = useState<ValidTimeIso | null>(initialUrl.hour);
  // Per-view map viewports: session-restored, with the URL ?c= param winning
  // for the view the link opens in. Updated from the primary panel's moveend.
  const [viewports, setViewports] = useState<Partial<Record<ViewKey, UrlViewport>>>(() => {
    if (initialUrl.center) {
      return { ...initialSession.viewports, [initialUrl.view ?? initialSession.viewKey]: initialUrl.center };
    }
    return { ...initialSession.viewports };
  });
  const [showIsobars, setShowIsobars] = useState(initialUrl.synoptic?.isobars ?? initialSession.showIsobars);
  const [showCenters, setShowCenters] = useState(initialUrl.synoptic?.centers ?? initialSession.showCenters);
  const [showThickness, setShowThickness] = useState(initialUrl.synoptic?.thickness ?? initialSession.showThickness);
  const [synopticDetailMode, setSynopticDetailMode] = useState<SynopticDetailMode>(
    initialUrl.synopticDetailMode ?? initialSession.synopticDetailMode,
  );
  const [reflectivityGate, setReflectivityGate] = useState<ReflectivityGateDbz>(
    initialUrl.reflectivityGate ?? initialSession.reflectivityGate,
  );
  const [display, setDisplay] = useState(loadStoredDisplaySettings);
  const [timeZone, setTimeZone] = useState(() => initialUrl.timeZone ?? loadStoredTimeZone());
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
    cancelJob: cancelRenderJob,
    dismissJob: dismissRenderJob,
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
    applyPanelPreset,
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
    initialTimelineMode: initialUrl.timelineMode ?? initialSession.timelineMode,
    initialValidTimeIso: initialFrameValidTimeIso,
    manifestInfoByPanel,
    panels,
    resolvedFrameByPanel,
  });
  const { handleMapDestroyed, handleMapReady, layoutVersion, linkViewports, setLinkViewports, unregisterPanel } =
    useViewportSync(panels.length, initialSession.viewportLink);
  // Same lifecycle as viewport sync, plus the test bridge's panel registry.
  const handlePanelMapReady = useCallback(
    (panelId: string, engine: MapEngine): void => {
      registerTestBridgePanel(panelId, engine);
      handleMapReady(panelId, engine);
    },
    [handleMapReady],
  );
  const handlePanelMapDestroyed = useCallback(
    (panelId: string): void => {
      unregisterTestBridgePanel(panelId);
      handleMapDestroyed(panelId);
    },
    [handleMapDestroyed],
  );

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
    writeUrlState({
      view: viewKey,
      hour: selectedTimelineValidTimeIso,
      panels: panels.map((panel) => ({ model: panel.modelKey, run: panel.runId ?? null, layers: [...panel.layers] })),
      center: viewports[viewKey] ?? null,
      timelineMode,
      synoptic: { isobars: showIsobars, thickness: showThickness, centers: showCenters },
      synopticDetailMode,
      reflectivityGate,
      // Preserve the preference token in a share/reload URL. In particular,
      // `local` must resolve afresh in the next browser instead of freezing
      // this browser's current IANA zone into the link.
      timeZone,
    });
  }, [
    panels,
    reflectivityGate,
    timeZone,
    selectedTimelineValidTimeIso,
    showCenters,
    showIsobars,
    showThickness,
    synopticDetailMode,
    timelineMode,
    viewKey,
    viewports,
  ]);

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
      viewports,
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
    viewports,
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

  // A permalink may steer this session to a concrete display zone, but it
  // must never rewrite the user's durable "Local" preference on hydration.
  // Persist only an explicit settings-menu choice.
  const handleTimeZoneChange = useCallback((setting: string): void => {
    setTimeZone(setting);
    storeTimeZone(setting);
  }, []);

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

  // One-time URL override (URL wins over the stored panel collection restored
  // in usePanelCollection). A full ?p1=…&p2=… roster replaces every panel;
  // the legacy ?model=&layer= pair still steers the first panel for old links.
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
    if (initialUrl.panels && initialUrl.panels.length > 0) {
      applyPanelPreset(
        initialUrl.panels.map((entry) => ({ modelKey: entry.model, runId: entry.run, layers: [...entry.layers] })),
      );
      return;
    }
    if (initialUrl.model && initialUrl.model !== firstPanel.modelKey) {
      updatePanelModel(firstPanel.id, initialUrl.model);
    }
    if (initialUrl.layer && !firstPanel.layers.includes(initialUrl.layer)) {
      togglePanelLayer(firstPanel.id, initialUrl.layer);
    }
  }, [
    applyPanelPreset,
    initialUrl.layer,
    initialUrl.model,
    initialUrl.panels,
    panels,
    togglePanelLayer,
    updatePanelModel,
  ]);

  // Persist the primary panel's viewport per view; linked panels mirror it, so
  // one writer is enough and unlinked secondary panels never fight over it.
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const handleViewportChange = useCallback(
    (panelId: string, viewport: UrlViewport): void => {
      if (panelsRef.current[0]?.id !== panelId) {
        return;
      }
      setViewports((prev) => {
        const current = prev[viewKey];
        if (
          current &&
          Math.abs(current.lat - viewport.lat) < 1e-6 &&
          Math.abs(current.lon - viewport.lon) < 1e-6 &&
          current.zoom === viewport.zoom
        ) {
          return prev;
        }
        return { ...prev, [viewKey]: viewport };
      });
    },
    [viewKey],
  );

  const copyShareLink = useCallback(() => {
    const url = window.location.href;
    if (!navigator.clipboard?.writeText) {
      pushToast({ tone: "error", title: "Copy failed", detail: "Clipboard is unavailable in this browser context." });
      return;
    }
    navigator.clipboard.writeText(url).then(
      () => pushToast({ tone: "success", title: "Link copied", detail: "The current view is in your clipboard." }),
      () => pushToast({ tone: "error", title: "Copy failed", detail: "Clipboard write was blocked." }),
    );
  }, []);

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
        canAddPanel={panels.length < MAX_PANELS}
        onCopyLink={copyShareLink}
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
        onChangeTimeZone={handleTimeZoneChange}
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
        onCancelRenderJob={cancelRenderJob}
        onDismissRenderJob={dismissRenderJob}
      />

      {/* ── Map grid (spans all rows, behind header/timeline for glass effect) ── */}
      <main
        className={`z-0 col-start-1 row-span-full row-start-1 grid ${
          panels.length === 1
            ? "grid-cols-1"
            : panels.length === 2
              ? "grid-cols-2"
              : // 3-4 panels: 2×2 grid; a lone third panel spans the bottom row.
                "grid-cols-2 grid-rows-2 [&>*:nth-child(3):last-child]:col-span-2"
        } gap-px bg-slate-800/30`}
      >
        {panels.map((panel, index) => {
          // Overlays inset for the app header only in the top grid row and for
          // the timeline only in the bottom row; middle-of-screen rows keep
          // their full height (the global offsets used to apply to every row,
          // wasting ~100px at the top of bottom-row panels).
          const columns = panels.length === 1 ? 1 : 2;
          const rowIndex = Math.floor(index / columns);
          const rowCount = Math.ceil(panels.length / columns);
          return (
            <MapPanel
              key={panel.id}
              panel={panel}
              insetForHeader={rowIndex === 0}
              insetForTimeline={rowIndex === rowCount - 1}
              compact={panels.length > 2}
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
              onMapReady={handlePanelMapReady}
              onMapDestroyed={handlePanelMapDestroyed}
              onAvailableValidTimesChange={updatePanelAvailableValidTimes}
              onResolvedFrameChange={updatePanelResolvedFrame}
              onLayerToggle={togglePanelLayer}
              onSelectValidTime={handlePanelSelectValidTime}
              onModelChange={updatePanelModel}
              onRunChange={updatePanelRun}
              onRemove={removePanel}
              onManifestInfoChange={updatePanelManifestInfo}
              initialViewport={viewports[viewKey] ?? null}
              onViewportChange={handleViewportChange}
              escapeNonce={escapeNonce}
            />
          );
        })}
      </main>

      {/* ── Help dialog (opened by the ? shortcut or the header Help button) ── */}
      <HelpPopover open={helpOpen} onClose={() => setHelpOpen(false)} />

      {/* ── Global notification stack (job outcomes, cache ops, copy-link) ── */}
      <ToastHost />

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
