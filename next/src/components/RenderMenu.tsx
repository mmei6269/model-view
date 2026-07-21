import { useId, useRef, useState, type ReactNode } from "react";
import { MODEL_CONFIG, MODEL_KEYS, VIEW_CONFIG, VIEW_KEYS } from "../config/constants";
import AnchoredPopover from "./AnchoredPopover";
import { useAnchoredPopoverPosition } from "../hooks/useAnchoredPopover";
import {
  MAX_HOUR_LIMIT,
  PRODUCTION_TUNING,
  RENDER_CATEGORIES,
  RENDER_TUNING_BOUNDS,
  SCIENCE_PROTOTYPE_IDS,
  effectiveRunForModel,
  type RenderCategoryDescriptor,
  type RenderCategoryId,
  type RenderSelection,
  type RenderTier,
  type RenderTuning,
  type SciencePrototypeId,
} from "../config/render";
import type { BuiltRun, UpstreamRun } from "../core/actions-client";
import type { AvailableRunsState } from "../hooks/useAvailableRuns";
import { formatBytes, useCacheActions, type CacheActions } from "../hooks/useCacheActions";
import type { ModelKey, ViewKey } from "../types";

export type RenderJobView = {
  status: "queued" | "running" | "done" | "failed" | "canceled";
  built: number;
  reused: number;
  failed: number;
  total: number;
  // Server marker scan: markerTotal is the resolved frame target, known
  // mid-run before the builder summary fills `total` (never show n/0).
  markerCount: number;
  markerTotal: number;
  error?: string | null;
};

// One tracked job row. A submit can spawn several builds (the server groups
// models by picked run); `label` distinguishes rows only in that case.
export type RenderJobEntry = RenderJobView & { jobId: string; label: string };

interface RenderMenuProps {
  selection: RenderSelection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (selection: RenderSelection) => void;
  onReset: () => void;
  onSubmit: () => void;
  onPrefetchSoundings: () => void;
  onCancelJob: (jobId: string) => void;
  onDismissJob: (jobId: string) => void;
  jobs: RenderJobEntry[];
  canSubmit: boolean;
  availableRuns: AvailableRunsState;
}

// HRRR/NAM3km are the convection-allowing models; several full-tier winter
// products (Western Linear, HRRR ASNOW) exist only for them. When the selection
// has no CAM, those sub-notes grey out (spec §4.5).
const CAM_MODELS: ModelKey[] = ["hrrr", "nam3km"];
const SEVERE_FULL_PROTOTYPES: SciencePrototypeId[] = ["camDcape21Level", "effectiveStp100mbReduced"];

function estimateCost(selection: RenderSelection): "Light" | "Moderate" | "Heavy" {
  // Coarse per-product weight × models × frames proxy (spec §4.3). Heavy full
  // tiers dominate; no fake seconds.
  let weight = 0;
  for (const category of RENDER_CATEGORIES) {
    const state = selection.categories[category.id];
    if (!state.enabled) {
      continue;
    }
    if (category.tiered) {
      weight += state.tier === "full" ? 3 : 1;
    } else {
      weight += category.id === "upperAir" ? 1.5 : 0.6;
    }
  }
  // A queue renders every picked run; the maxHour prefix caps each model's
  // frame count. Both scale the work linearly, so both scale the proxy.
  const frameProxy = selection.models.reduce((sum, model) => {
    const config = MODEL_CONFIG[model];
    const horizon = selection.maxHour === null ? config.maxHour : Math.min(config.maxHour, selection.maxHour);
    const runCount = selection.runMode === "pick" ? Math.max(1, (selection.runs[model] ?? []).length) : 1;
    // NAM's official schedule is hourly through F036 and 3-hourly through
    // F084. Counting it as 85 hourly frames overstated both work and storage.
    const frameCount =
      model === "gfs" && selection.gfsTemporalTier === "hourly-through-120"
        ? horizon <= 120
          ? Math.floor(horizon) + 1
          : 121 + Math.max(0, Math.floor((horizon - 123) / 3) + 1)
        : model === "nam"
          ? horizon <= 36
            ? Math.floor(horizon) + 1
            : 37 + Math.max(0, Math.floor((horizon - 39) / 3) + 1)
          : Math.floor(horizon / (config.frameStepHours || 1)) + 1;
    return sum + frameCount * runCount;
  }, 0);
  const score = weight * Math.max(1, frameProxy);
  if (score < 120) {
    return "Light";
  }
  if (score < 320) {
    return "Moderate";
  }
  return "Heavy";
}

function costBadgeClass(cost: "Light" | "Moderate" | "Heavy"): string {
  if (cost === "Light") {
    return "bg-emerald-500/15 text-emerald-300";
  }
  if (cost === "Moderate") {
    return "bg-amber-500/15 text-amber-300";
  }
  return "bg-rose-500/15 text-rose-300";
}

export default function RenderMenu({
  selection,
  open,
  onOpenChange,
  onChange,
  onReset,
  onSubmit,
  onPrefetchSoundings,
  onCancelJob,
  onDismissJob,
  jobs,
  canSubmit,
  availableRuns,
}: RenderMenuProps) {
  const hasCam = selection.models.some((model) => CAM_MODELS.includes(model));
  // The server 400s a zero-category render; keep the degenerate submit
  // unreachable from the UI too.
  const enabledCategoryCount = RENDER_CATEGORIES.filter((category) => selection.categories[category.id].enabled).length;
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const position = useAnchoredPopoverPosition(anchorRef, open);
  const cache = useCacheActions(open, selection.view);

  const toggleModel = (model: ModelKey, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...selection.models, model]))
      : selection.models.filter((value) => value !== model);
    const nextHasCam = next.some((candidate) => CAM_MODELS.includes(candidate));
    onChange({
      ...selection,
      models: next,
      gfsTemporalTier: next.includes("gfs") ? selection.gfsTemporalTier : "three-hourly",
      sciencePrototypes: nextHasCam
        ? selection.sciencePrototypes
        : selection.sciencePrototypes.filter((id) => id !== "camDcape21Level"),
    });
  };
  const setView = (view: ViewKey) => onChange({ ...selection, view });
  const setRunMode = (runMode: "latest" | "pick") => onChange({ ...selection, runMode });
  // Rows toggle membership in the model's pick list (multi-run queue). The
  // "latest" pseudo-row clears the list — an empty list means latest.
  const pickRun = (model: ModelKey, run: string) => {
    if (run === "latest") {
      onChange({
        ...selection,
        runMode: "pick",
        runs: Object.fromEntries(Object.entries(selection.runs).filter(([key]) => key !== model)),
      });
      return;
    }
    const current = selection.runs[model] ?? [];
    const next = current.includes(run) ? current.filter((value) => value !== run) : [...current, run];
    onChange({
      ...selection,
      runMode: "pick",
      runs:
        next.length === 0
          ? Object.fromEntries(Object.entries(selection.runs).filter(([key]) => key !== model))
          : { ...selection.runs, [model]: next },
    });
  };
  const setMaxHour = (maxHour: number | null) => onChange({ ...selection, maxHour });
  const setTuning = (tuning: RenderTuning | null) => onChange({ ...selection, tuning });
  const setGfsHourlyThrough120 = (enabled: boolean) =>
    onChange({ ...selection, gfsTemporalTier: enabled ? "hourly-through-120" : "three-hourly" });
  const toggleSciencePrototype = (id: SciencePrototypeId, enabled: boolean) => {
    const nextPrototypes = new Set(selection.sciencePrototypes);
    if (enabled) {
      nextPrototypes.add(id);
    } else {
      nextPrototypes.delete(id);
    }
    onChange({
      ...selection,
      categories:
        enabled && SEVERE_FULL_PROTOTYPES.includes(id)
          ? {
              ...selection.categories,
              severe: { ...selection.categories.severe, enabled: true, tier: "full" },
            }
          : selection.categories,
      sciencePrototypes: SCIENCE_PROTOTYPE_IDS.filter((candidate) => nextPrototypes.has(candidate)),
    });
  };
  const toggleCategory = (id: RenderCategoryId, enabled: boolean) =>
    onChange({
      ...selection,
      categories: { ...selection.categories, [id]: { ...selection.categories[id], enabled } },
      sciencePrototypes:
        id === "severe" && !enabled
          ? selection.sciencePrototypes.filter((prototype) => !SEVERE_FULL_PROTOTYPES.includes(prototype))
          : selection.sciencePrototypes,
    });
  const setCategoryTier = (id: RenderCategoryId, tier: RenderTier) =>
    onChange({
      ...selection,
      categories: { ...selection.categories, [id]: { ...selection.categories[id], tier } },
      sciencePrototypes:
        id === "severe" && tier !== "full"
          ? selection.sciencePrototypes.filter((prototype) => !SEVERE_FULL_PROTOTYPES.includes(prototype))
          : selection.sciencePrototypes,
    });

  const cost = estimateCost(selection);

  return (
    <div className="relative">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium active:scale-95 ${
          open
            ? "border-cyan-400/30 bg-cyan-500/20 text-cyan-300"
            : "border-white/[0.06] bg-white/[0.04] text-slate-400 hover:bg-white/[0.08]"
        }`}
        aria-expanded={open}
      >
        Render
      </button>
      {open && position ? (
        <AnchoredPopover
          position={position}
          onDismiss={() => onOpenChange(false)}
          widthClassName="w-[min(24rem,calc(100vw-1rem))]"
          role="dialog"
          ariaLabel="Render"
        >
          <div className="grid gap-3">
            <section className="grid gap-2 border-b border-white/[0.06] pb-3">
              <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Models</span>
              <div className="flex flex-wrap gap-2">
                {MODEL_KEYS.map((model) => (
                  <MenuCheckbox
                    key={model}
                    label={MODEL_CONFIG[model].label}
                    checked={selection.models.includes(model)}
                    onChange={(checked) => toggleModel(model, checked)}
                  />
                ))}
              </div>
            </section>

            <section className="grid gap-2 border-b border-white/[0.06] pb-3">
              <MenuSelect
                label="View"
                value={selection.view}
                onChange={(value) => setView(value as ViewKey)}
                options={VIEW_KEYS.map((key) => ({ value: key, label: VIEW_CONFIG[key].label }))}
              />
              <div className="flex items-center gap-4 text-xs">
                <span className="text-[11px] text-slate-400">Run</span>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="render-run-mode"
                    checked={selection.runMode === "latest"}
                    onChange={() => setRunMode("latest")}
                    className="accent-cyan-400"
                  />
                  <span className="text-[11px] text-slate-300">Latest available</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="render-run-mode"
                    checked={selection.runMode === "pick"}
                    onChange={() => setRunMode("pick")}
                    className="accent-cyan-400"
                  />
                  <span className="text-[11px] text-slate-300">Pick from list</span>
                </label>
              </div>
              {selection.runMode === "pick" ? (
                <RunPicker
                  models={selection.models}
                  availableRuns={availableRuns}
                  selectedRuns={selection.runs}
                  gfsTemporalTier={selection.gfsTemporalTier}
                  onPickRun={pickRun}
                />
              ) : null}
            </section>

            <FramesAndTuningSection selection={selection} onMaxHour={setMaxHour} onTuning={setTuning} />

            <section className="grid gap-2 border-b border-white/[0.06] pb-3" data-testid="advanced-render-options">
              <span className="text-[10px] font-medium uppercase tracking-widest text-amber-300/80">
                Advanced / Prototype
              </span>
              <AdvancedRenderCheckbox
                label="GFS hourly F000-F120 (optional)"
                detail="209 official frames through F384 instead of the default 129; hourly through F120, then every 3 h."
                checked={selection.gfsTemporalTier === "hourly-through-120"}
                disabled={!selection.models.includes("gfs")}
                onChange={setGfsHourlyThrough120}
              />
              <AdvancedRenderCheckbox
                label="21-level DCAPE prototype (CAM-only)"
                detail="Denser 21-level vertical sampling; about +3.80 CPU s/frame. Enabling selects Severe Full."
                checked={selection.sciencePrototypes.includes("camDcape21Level")}
                disabled={!hasCam}
                onChange={(checked) => toggleSciencePrototype("camDcape21Level", checked)}
              />
              <AdvancedRenderCheckbox
                label="100-mb reduced-profile prototype"
                detail="No native CAPE gate; about +11.77 CPU s/frame modeled marginal cost. Enabling selects Severe Full."
                checked={selection.sciencePrototypes.includes("effectiveStp100mbReduced")}
                onChange={(checked) => toggleSciencePrototype("effectiveStp100mbReduced", checked)}
              />
              <AdvancedRenderCheckbox
                label="Row-aware center validation diagnostic"
                detail="Diagnostic only; +2.98 ms/frame marginal at 119x73 / 12 retained centers (6.49 ms enabled total)."
                checked={selection.sciencePrototypes.includes("rowAwareCenterValidation")}
                onChange={(checked) => toggleSciencePrototype("rowAwareCenterValidation", checked)}
              />
              <span className="text-[9px] leading-4 text-slate-500">All advanced options default off.</span>
            </section>

            <section className="grid gap-2 border-b border-white/[0.06] pb-3">
              <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Categories</span>
              {RENDER_CATEGORIES.map((category) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  enabled={selection.categories[category.id].enabled}
                  tier={selection.categories[category.id].tier}
                  hasCam={hasCam}
                  onToggle={(checked) => toggleCategory(category.id, checked)}
                  onTier={(tier) => setCategoryTier(category.id, tier)}
                />
              ))}
            </section>

            <div className="flex items-center justify-between gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${costBadgeClass(cost)}`}>
                ● {cost}
              </span>
              <span className="text-[11px] text-slate-500">
                {selection.models.length} model{selection.models.length === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                onClick={onReset}
                className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-slate-300 hover:bg-white/[0.08] active:scale-95"
              >
                Reset
              </button>
            </div>

            <section className="grid gap-2 border-t border-white/[0.06] pt-3">
              <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Soundings</span>
              <button
                type="button"
                onClick={onPrefetchSoundings}
                disabled={selection.models.length === 0}
                className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.08] active:scale-95 disabled:opacity-40"
              >
                Prefetch soundings
              </button>
              {selection.models.length > 0 ? (
                <ul className="grid gap-0.5" aria-label="Sounding prefetch targets">
                  {selection.models.map((model) => {
                    const run = effectiveRunForModel(selection, model);
                    return (
                      <li key={model} className="flex items-baseline justify-between gap-2 text-[10px] text-slate-500">
                        <span>{MODEL_CONFIG[model]?.label || model}</span>
                        <span className="tabular-nums">{run === "latest" ? "latest built run" : run}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <span className="text-[10px] text-slate-500">Select a model to prefetch.</span>
              )}
              <span className="text-[10px] leading-relaxed text-slate-500">
                Warms instant hover soundings. Needs rendered frames; one job per model.
              </span>
            </section>

            <CacheSection cache={cache} />

            <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] pt-3">
              {enabledCategoryCount === 0 ? (
                <span className="mr-auto text-[11px] text-amber-300">Enable at least one category</span>
              ) : null}
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-lg border border-white/[0.06] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-400 hover:bg-white/[0.08] active:scale-95"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSubmit}
                disabled={!canSubmit || selection.models.length === 0 || enabledCategoryCount === 0}
                className="rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 active:scale-95 disabled:opacity-40"
              >
                ▶ Render
              </button>
            </div>

            {jobs.length > 0 ? (
              <div className="grid gap-2 border-t border-white/[0.06] pt-3">
                {jobs.map((job) => (
                  <JobProgress key={job.jobId} job={job} onCancel={onCancelJob} onDismiss={onDismissJob} />
                ))}
              </div>
            ) : null}
          </div>
        </AnchoredPopover>
      ) : null}
    </div>
  );
}

function CategoryRow({
  category,
  enabled,
  tier,
  hasCam,
  onToggle,
  onTier,
}: {
  category: RenderCategoryDescriptor;
  enabled: boolean;
  tier: RenderTier;
  hasCam: boolean;
  onToggle: (checked: boolean) => void;
  onTier: (tier: RenderTier) => void;
}) {
  // Winter's full tier includes CAM-only products (Western Linear, HRRR ASNOW),
  // so its sub-note greys when no CAM is selected.
  const camOnly = category.id === "winter" && !hasCam;
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onToggle(event.target.checked)}
            className="h-4 w-4 accent-cyan-400"
            aria-label={`${category.label} (${category.count})`}
          />
          <span className="text-[11px] text-slate-300">
            {category.label} ({category.count})
          </span>
        </label>
        {category.tiered ? (
          <div className="flex items-center gap-2">
            <TierRadio
              label={`${category.label} Simple`}
              checked={tier === "simple"}
              onChange={() => onTier("simple")}
            />
            <TierRadio label={`${category.label} Full`} checked={tier === "full"} onChange={() => onTier("full")} />
          </div>
        ) : null}
      </div>
      {category.tiered && category.fullAdds ? (
        <span
          className={`pl-6 text-[10px] ${camOnly ? "text-slate-600" : "text-slate-500"}`}
          data-cam-only={camOnly ? "true" : "false"}
        >
          └ Full adds: {category.fullAdds}
        </span>
      ) : null}
    </div>
  );
}

// Per-model run lists: run cycles differ per model (HRRR hourly, NAM3km
// 4×/day), so each selected model picks its own run. A model left on its
// "Latest available" pseudo-row renders latest; frame chips show how many
// frames NOAA has published for each run (it varies while a run uploads and
// across short-horizon off-cycles).
function RunPicker({
  models,
  availableRuns,
  selectedRuns,
  gfsTemporalTier,
  onPickRun,
}: {
  models: ModelKey[];
  availableRuns: AvailableRunsState;
  selectedRuns: Partial<Record<ModelKey, string[]>>;
  gfsTemporalTier: RenderSelection["gfsTemporalTier"];
  onPickRun: (model: ModelKey, run: string) => void;
}) {
  if (models.length === 0) {
    return <span className="text-[11px] text-slate-500">Select a model to pick a run.</span>;
  }
  return (
    <div className="grid gap-2.5">
      {models.map((model) => (
        <ModelRunList
          key={model}
          model={model}
          availableRuns={availableRuns}
          selectedRuns={selectedRuns[model] ?? []}
          gfsTemporalTier={gfsTemporalTier}
          onPickRun={(run) => onPickRun(model, run)}
        />
      ))}
    </div>
  );
}

function formatFrameChip(frameCount: number | null): string | null {
  return frameCount === null ? null : `${frameCount} frame${frameCount === 1 ? "" : "s"}`;
}

function gfsBuiltFrameChip(run: BuiltRun): string | null {
  const sourceCount = run.upstreamSourceFrameCount ?? run.upstreamFrameCount;
  const defaultCount = run.upstreamDefaultRenderFrameCount;
  if (sourceCount === null || defaultCount === null || defaultCount === undefined) {
    return formatFrameChip(run.frameCount);
  }
  if (run.frameCount === defaultCount && sourceCount !== defaultCount) {
    return `${run.frameCount} built/default · ${sourceCount} hourly-tier source`;
  }
  if (run.frameCount === sourceCount && sourceCount !== defaultCount) {
    return `${run.frameCount} built/hourly-tier · ${defaultCount} default`;
  }
  return `${run.frameCount} built · ${defaultCount} default · ${sourceCount} hourly-tier source`;
}

function gfsUpstreamFrameChip(run: UpstreamRun): string | null {
  const sourceCount = run.sourceFrameCount ?? run.frameCount;
  const defaultCount = run.defaultRenderFrameCount;
  if (sourceCount === null || defaultCount === null || defaultCount === undefined) {
    return formatFrameChip(sourceCount);
  }
  return `${defaultCount} 3-hourly default · ${sourceCount} hourly-tier source`;
}

function builtRunHasAdditionalSelectedFrames(
  model: ModelKey,
  run: BuiltRun,
  gfsTemporalTier: RenderSelection["gfsTemporalTier"],
): boolean {
  const rawTarget =
    model === "gfs" && gfsTemporalTier === "three-hourly"
      ? run.upstreamDefaultRenderFrameCount
      : (run.upstreamSourceFrameCount ?? run.upstreamFrameCount);
  const target = Number(rawTarget);
  return rawTarget !== null && rawTarget !== undefined && Number.isFinite(target) && target > run.frameCount;
}

function ModelRunList({
  model,
  availableRuns,
  selectedRuns,
  gfsTemporalTier,
  onPickRun,
}: {
  model: ModelKey;
  availableRuns: AvailableRunsState;
  selectedRuns: string[];
  gfsTemporalTier: RenderSelection["gfsTemporalTier"];
  onPickRun: (run: string) => void;
}) {
  const entry = availableRuns.runsByModel[model];
  const built = entry?.built ?? [];
  const builtIds = new Set(built.map((run) => run.run));
  // ONE chronological list (newest cycle first): being built is a row STATE,
  // not a grouping — a built 20z must not sit above an unbuilt 21z. Run ids
  // (YYYYMMDD-HHMMZ) sort lexicographically = chronologically. Upstream
  // candidates already built locally show once, as built rows.
  const rows = [
    ...built.map((run) => ({ runId: run.run, built: run, upstream: null as UpstreamRun | null })),
    ...(entry?.upstream ?? [])
      .filter((run) => !builtIds.has(run.runId))
      .map((run) => ({ runId: run.runId, built: null as BuiltRun | null, upstream: run })),
  ].sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0));
  return (
    <div className="grid gap-1.5" data-run-list={model}>
      <span className="text-[11px] font-medium text-slate-300">Runs for {MODEL_CONFIG[model].label}</span>
      {selectedRuns.length >= 2 ? (
        <span className="text-[10px] text-cyan-300/80" data-testid={`run-queue-note-${model}`}>
          {selectedRuns.length} runs queued · newest builds first
        </span>
      ) : null}
      {availableRuns.loading ? (
        <span className="text-[11px] text-slate-500">Checking available runs…</span>
      ) : (
        <div className="grid max-h-40 gap-1 overflow-y-auto pr-0.5">
          <RunRow runId="latest" label="Latest available" selected={selectedRuns.length === 0} onPick={onPickRun} />
          {rows.length === 0 ? (
            <span className="text-[11px] text-slate-500">
              {availableRuns.error ? `Run list unavailable: ${availableRuns.error}` : "No runs found"}
            </span>
          ) : null}
          {rows.map(({ runId, built: builtRun, upstream: upstreamRun }) => (
            <RunRow key={runId} runId={runId} selected={selectedRuns.includes(runId)} onPick={onPickRun}>
              {builtRun ? (
                <>
                  {(
                    model === "gfs"
                      ? gfsBuiltFrameChip(builtRun)
                      : formatFrameChip(builtRun.upstreamFrameCount ?? builtRun.frameCount)
                  ) ? (
                    <RunTag
                      tone={builtRunHasAdditionalSelectedFrames(model, builtRun, gfsTemporalTier) ? "amber" : "slate"}
                    >
                      {model === "gfs"
                        ? gfsBuiltFrameChip(builtRun)
                        : builtRun.upstreamFrameCount !== null && builtRun.upstreamFrameCount > builtRun.frameCount
                          ? `${builtRun.frameCount}/${builtRun.upstreamFrameCount} frames`
                          : formatFrameChip(builtRun.frameCount)}
                    </RunTag>
                  ) : null}
                  <RunTag tone="cyan">Built</RunTag>
                  {builtRun.latest ? <RunTag tone="emerald">Latest built</RunTag> : null}
                  {builtRun.complete ? (
                    <RunTag tone="slate">Build complete</RunTag>
                  ) : (
                    <RunTag tone="amber">Partial</RunTag>
                  )}
                </>
              ) : upstreamRun ? (
                <>
                  {(model === "gfs" ? gfsUpstreamFrameChip(upstreamRun) : formatFrameChip(upstreamRun.frameCount)) ? (
                    <RunTag tone="slate">
                      {model === "gfs" ? gfsUpstreamFrameChip(upstreamRun) : formatFrameChip(upstreamRun.frameCount)}
                    </RunTag>
                  ) : null}
                  <RunTag tone="slate">Upstream (not built)</RunTag>
                </>
              ) : null}
            </RunRow>
          ))}
        </div>
      )}
    </div>
  );
}

function RunRow({
  runId,
  label,
  selected,
  onPick,
  children,
}: {
  runId: string;
  label?: string;
  selected: boolean;
  onPick: (run: string) => void;
  children?: ReactNode;
}) {
  const descriptionId = useId();
  return (
    <button
      type="button"
      aria-label={label || runId}
      aria-describedby={children ? descriptionId : undefined}
      aria-pressed={selected}
      onClick={() => onPick(runId)}
      className={`flex w-full min-w-0 items-start justify-between gap-2 rounded-md border px-2 py-1 text-left text-[11px] tabular-nums active:scale-[0.99] ${
        selected
          ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
          : "border-white/[0.06] bg-white/[0.03] text-slate-300 hover:bg-white/[0.07]"
      }`}
    >
      <span className="shrink-0">
        {selected ? "✓ " : ""}
        {label || runId}
      </span>
      <span id={descriptionId} className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1 text-right">
        {children}
      </span>
    </button>
  );
}

const RUN_TAG_TONES = {
  cyan: "bg-cyan-500/15 text-cyan-300",
  emerald: "bg-emerald-500/15 text-emerald-300",
  amber: "bg-amber-500/15 text-amber-300",
  slate: "bg-white/[0.06] text-slate-400",
} as const;

function RunTag({ tone, children }: { tone: keyof typeof RUN_TAG_TONES; children: React.ReactNode }) {
  return (
    <span
      className={`max-w-full whitespace-normal rounded-full px-1.5 py-px text-[9px] font-medium ${RUN_TAG_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

function TierRadio({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-slate-400">
      <input type="radio" checked={checked} onChange={onChange} className="accent-cyan-400" aria-label={label} />
      <span>{label.split(" ").at(-1)}</span>
    </label>
  );
}

function JobProgress({
  job,
  onCancel,
  onDismiss,
}: {
  job: RenderJobEntry;
  onCancel: (jobId: string) => void;
  onDismiss: (jobId: string) => void;
}) {
  // Mid-run the builder summary hasn't landed yet (total 0) but the server's
  // marker scan already knows the resolved frame target — prefer it so the
  // bar never reads n/0. Numerator takes the larger of the builder's own
  // counts and the on-disk markers, capped at the target.
  const target = job.markerTotal > 0 ? job.markerTotal : job.total;
  const targetKnown = target > 0;
  const rawDone = Math.max(job.built + job.reused, job.markerCount);
  const done = targetKnown ? Math.min(rawDone, target) : rawDone;
  const pct = targetKnown ? Math.min(100, Math.round((done / target) * 100)) : 0;
  const active = job.status === "queued" || job.status === "running";
  return (
    <div className="grid gap-1" role="status" aria-label="Render job">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[10px] uppercase tracking-widest text-slate-500">{job.label}</span>
        {active ? (
          <button
            type="button"
            onClick={() => onCancel(job.jobId)}
            className="shrink-0 rounded-md border border-rose-400/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-300 hover:bg-rose-500/20 active:scale-95"
            aria-label={`Cancel job${job.label ? ` ${job.label}` : ""}`}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onDismiss(job.jobId)}
            className="shrink-0 rounded px-1 text-[11px] text-slate-500 hover:bg-white/[0.08] hover:text-slate-300"
            aria-label={`Dismiss job${job.label ? ` ${job.label}` : ""}`}
          >
            ✕
          </button>
        )}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={`h-full rounded-full bg-cyan-400/70 transition-all ${!targetKnown ? (active ? "w-1/3 animate-pulse" : "w-0") : ""}`}
          style={targetKnown ? { width: `${pct}%` } : undefined}
        />
      </div>
      <span className="text-[11px] tabular-nums text-slate-400">
        {job.status === "failed"
          ? `failed: ${job.error || "unknown error"}`
          : job.status === "canceled"
            ? "canceled"
            : !targetKnown && active
              ? `planning target · built ${job.built} · reused ${job.reused} · fail ${job.failed}`
              : `${done}/${target} · built ${job.built} · reused ${job.reused} · fail ${job.failed}`}
      </span>
    </div>
  );
}

function MenuSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span className="text-[11px] text-slate-400">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-lg border border-white/[0.08] bg-slate-950/80 px-2 text-xs text-slate-100 outline-none hover:border-white/20 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-300/20"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-slate-950">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MenuCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 accent-cyan-400"
        aria-label={label}
      />
      <span className="text-[11px] text-slate-300">{label}</span>
    </label>
  );
}

function AdvancedRenderCheckbox({
  label,
  detail,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const detailId = useId();
  return (
    <label
      className={`flex items-start gap-2 rounded-lg border border-amber-300/10 bg-amber-400/[0.03] px-2 py-1.5 ${
        disabled ? "opacity-45" : ""
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-amber-400"
        aria-label={label}
        aria-describedby={detailId}
      />
      <span className="grid gap-0.5">
        <span className="text-[11px] text-slate-200">{label}</span>
        <span id={detailId} className="text-[9px] leading-4 text-slate-500">
          {detail}
        </span>
      </span>
    </label>
  );
}

const FRAME_CAP_PRESETS: readonly number[] = [24, 48];

const TUNING_LABELS: Record<keyof RenderTuning, string> = {
  workerCount: "Workers",
  totalFrameConcurrency: "Frame queue",
  rangeConcurrency: "Range reads / worker",
  decodeConcurrency: "Decode slots / worker",
};

function tuningEqualsProduction(tuning: RenderTuning | null): boolean {
  if (!tuning) {
    return false;
  }
  return (Object.keys(RENDER_TUNING_BOUNDS) as Array<keyof RenderTuning>).every(
    (key) => tuning[key] === PRODUCTION_TUNING[key],
  );
}

type UnboundedFramePolicy = "latest-full" | "picked-prefix" | "mixed";

function unboundedFramePolicy(selection: RenderSelection): UnboundedFramePolicy {
  if (selection.runMode !== "pick") {
    return "latest-full";
  }
  const pickedModelCount = selection.models.filter((model) => (selection.runs[model] ?? []).length > 0).length;
  if (pickedModelCount === 0) {
    return "latest-full";
  }
  return pickedModelCount === selection.models.length ? "picked-prefix" : "mixed";
}

// Frames (prefix hour cap) + renderer tuning. Local "custom" flags keep the
// selects from snapping back to a preset option while the user types a value
// that happens to equal one.
function FramesAndTuningSection({
  selection,
  onMaxHour,
  onTuning,
}: {
  selection: RenderSelection;
  onMaxHour: (maxHour: number | null) => void;
  onTuning: (tuning: RenderTuning | null) => void;
}) {
  const [customFrames, setCustomFrames] = useState(false);
  const [customTuning, setCustomTuning] = useState(false);
  const framePolicy = unboundedFramePolicy(selection);

  const framesValue =
    selection.maxHour === null
      ? "full"
      : customFrames || !FRAME_CAP_PRESETS.includes(selection.maxHour)
        ? "custom"
        : String(selection.maxHour);
  const handleFrames = (value: string) => {
    if (value === "full") {
      setCustomFrames(false);
      onMaxHour(null);
    } else if (value === "custom") {
      setCustomFrames(true);
      onMaxHour(selection.maxHour ?? 24);
    } else {
      setCustomFrames(false);
      onMaxHour(Number(value));
    }
  };

  const tuningValue =
    selection.tuning === null
      ? "auto"
      : customTuning || !tuningEqualsProduction(selection.tuning)
        ? "custom"
        : "production";
  const handleTuning = (value: string) => {
    if (value === "auto") {
      setCustomTuning(false);
      onTuning(null);
    } else if (value === "production") {
      setCustomTuning(false);
      onTuning({ ...PRODUCTION_TUNING });
    } else {
      setCustomTuning(true);
      onTuning(selection.tuning ?? { ...PRODUCTION_TUNING });
    }
  };
  const setTuningField = (key: keyof RenderTuning, raw: string) => {
    const next: RenderTuning = { ...(selection.tuning ?? {}) };
    if (raw.trim() === "") {
      delete next[key];
    } else {
      const bounds = RENDER_TUNING_BOUNDS[key];
      const value = Math.round(Number(raw));
      if (!Number.isFinite(value)) {
        return;
      }
      next[key] = Math.min(bounds.max, Math.max(bounds.min, value));
    }
    onTuning(next);
  };

  return (
    <section className="grid gap-2 border-b border-white/[0.06] pb-3" data-testid="frames-tuning-section">
      <MenuSelect
        label="Frames"
        value={framesValue}
        onChange={handleFrames}
        options={[
          {
            value: "full",
            label:
              framePolicy === "picked-prefix"
                ? "Published prefix"
                : framePolicy === "mixed"
                  ? "Mixed: prefix + full"
                  : "Full horizon",
          },
          { value: "24", label: "First 24 h" },
          { value: "48", label: "First 48 h" },
          { value: "custom", label: "Custom cap…" },
        ]}
      />
      {framesValue === "custom" ? (
        <label className="flex items-center justify-between gap-3 text-xs">
          <span className="text-[11px] text-slate-400">Max forecast hour</span>
          <input
            type="number"
            min={0}
            max={MAX_HOUR_LIMIT}
            value={selection.maxHour ?? 24}
            onChange={(event) => {
              const value = Math.round(Number(event.target.value));
              if (Number.isFinite(value)) {
                onMaxHour(Math.min(MAX_HOUR_LIMIT, Math.max(0, value)));
              }
            }}
            aria-label="Max forecast hour"
            className="h-8 w-20 rounded-lg border border-white/[0.08] bg-slate-950/80 px-2 text-right text-xs text-slate-100 outline-none tabular-nums hover:border-white/20 focus:border-cyan-300/60"
          />
        </label>
      ) : null}
      {selection.maxHour !== null ? (
        <span className="text-[10px] leading-relaxed text-slate-500">
          Renders f000–f{String(selection.maxHour).padStart(3, "0")} only (prefix cap; totals stay exact).
        </span>
      ) : (
        <span className="text-[10px] leading-relaxed text-slate-500">
          {framePolicy === "picked-prefix" ? (
            <>
              Requests each concrete picked run&apos;s currently published contiguous prefix. A run that is still
              uploading may stop before its official horizon; the resulting manifest reports the realized first/last
              hour and frame count.
            </>
          ) : framePolicy === "mixed" ? (
            <>
              Concrete picked cycles use their currently published prefix; models left on Latest available require a
              completed official horizon. Each resulting manifest reports its realized first/last hour and frame count.
            </>
          ) : (
            <>
              Requests the latest completed official horizon
              {selection.models.includes("nam")
                ? "; NAM is 53 frames (hourly F000–F036, then every 3 h through F084), about 43% more frame work than its 37-frame short tier"
                : ""}
              .
            </>
          )}
        </span>
      )}
      <MenuSelect
        label="Tuning"
        value={tuningValue}
        onChange={handleTuning}
        options={[
          { value: "auto", label: "Auto (CPU-sized)" },
          { value: "production", label: "Production preset" },
          { value: "custom", label: "Custom…" },
        ]}
      />
      {tuningValue === "custom" ? (
        <div className="grid gap-1.5" data-testid="tuning-fields">
          {(Object.keys(RENDER_TUNING_BOUNDS) as Array<keyof RenderTuning>).map((key) => {
            const bounds = RENDER_TUNING_BOUNDS[key];
            return (
              <label key={key} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-[11px] text-slate-400">
                  {TUNING_LABELS[key]}{" "}
                  <span className="text-slate-600">
                    ({bounds.min}–{bounds.max})
                  </span>
                </span>
                <input
                  type="number"
                  min={bounds.min}
                  max={bounds.max}
                  value={selection.tuning?.[key] ?? ""}
                  placeholder="auto"
                  onChange={(event) => setTuningField(key, event.target.value)}
                  aria-label={TUNING_LABELS[key]}
                  className="h-8 w-20 rounded-lg border border-white/[0.08] bg-slate-950/80 px-2 text-right text-xs text-slate-100 outline-none tabular-nums hover:border-white/20 focus:border-cyan-300/60"
                />
              </label>
            );
          })}
        </div>
      ) : tuningValue === "production" ? (
        <span className="text-[10px] leading-relaxed text-slate-500">
          18 workers · 24 frame queue · 3 range reads · 2 decode slots
        </span>
      ) : null}
    </section>
  );
}

function CacheSection({ cache }: { cache: CacheActions }) {
  const [clearArmed, setClearArmed] = useState(false);
  const [clearText, setClearText] = useState("");
  const stats = cache.stats;
  const disarmClear = () => {
    setClearArmed(false);
    setClearText("");
  };
  return (
    <section className="grid gap-2 border-t border-white/[0.06] pt-3" data-testid="cache-section">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-widest text-slate-400">Disk cache</span>
        <button
          type="button"
          onClick={() => cache.refreshStats({ refresh: true })}
          disabled={cache.statsLoading}
          className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-400 hover:bg-white/[0.08] active:scale-95 disabled:opacity-40"
        >
          {cache.statsLoading ? "Measuring…" : "Refresh"}
        </button>
      </div>
      {cache.statsError ? (
        <span className="text-[11px] text-rose-300">Cache stats unavailable: {cache.statsError}</span>
      ) : null}
      {stats ? (
        <>
          <div className="flex items-baseline justify-between gap-2 text-[11px]">
            <span className="font-semibold text-slate-200 tabular-nums" data-testid="cache-total">
              {formatBytes(stats.totalBytes)}
            </span>
            <span className="text-slate-500 tabular-nums">
              artifacts {formatBytes(stats.artifactsBytes)} · raw {formatBytes(stats.rawBytes)}
            </span>
          </div>
          {stats.models.length > 0 ? (
            <ul className="grid gap-0.5" aria-label="Cache size by model">
              {stats.models.map((entry) => (
                <li key={entry.model} className="flex items-baseline justify-between text-[10px] text-slate-500">
                  <span>
                    {MODEL_CONFIG[entry.model as ModelKey]?.label || entry.model} · {entry.runs.length} run
                    {entry.runs.length === 1 ? "" : "s"}
                  </span>
                  <span className="tabular-nums">{formatBytes(entry.totalBytes)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-[10px] text-slate-500">No rendered runs on disk.</span>
          )}
        </>
      ) : cache.statsLoading ? (
        <span className="text-[11px] text-slate-500">Measuring cache…</span>
      ) : null}
      {cache.prunePreview ? (
        <div
          className="grid gap-1.5 rounded-lg border border-amber-400/20 bg-amber-500/[0.06] p-2"
          data-testid="prune-preview"
        >
          <span className="text-[11px] text-amber-200">
            Prune would free {formatBytes(cache.prunePreview.removedBytes)} across {cache.prunePreview.deletions.length}{" "}
            target{cache.prunePreview.deletions.length === 1 ? "" : "s"} (keeps the newest 4 runs per model).
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={cache.confirmPrune}
              disabled={cache.busy || cache.prunePreview.deletions.length === 0}
              className="rounded-md border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20 active:scale-95 disabled:opacity-40"
            >
              Prune now
            </button>
            <button
              type="button"
              onClick={cache.cancelPrunePreview}
              className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-slate-400 hover:bg-white/[0.08] active:scale-95"
            >
              Keep everything
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={cache.previewPrune}
          disabled={cache.busy}
          className="rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/[0.08] active:scale-95 disabled:opacity-40"
        >
          Preview prune
        </button>
        {!clearArmed ? (
          <button
            type="button"
            onClick={() => setClearArmed(true)}
            disabled={cache.busy}
            className="rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20 active:scale-95 disabled:opacity-40"
          >
            Clear…
          </button>
        ) : null}
      </div>
      {clearArmed ? (
        <div className="grid gap-1.5 rounded-lg border border-rose-400/20 bg-rose-500/[0.06] p-2">
          <span className="text-[10px] leading-relaxed text-rose-200">
            Deletes every rendered run and raw input on disk. Type CLEAR to confirm.
          </span>
          <div className="flex items-center gap-2">
            <input
              value={clearText}
              onChange={(event) => setClearText(event.target.value)}
              placeholder="CLEAR"
              aria-label="Clear confirmation"
              className="h-8 w-24 rounded-lg border border-white/[0.08] bg-slate-950/80 px-2 text-xs text-slate-100 outline-none hover:border-white/20 focus:border-rose-300/60"
            />
            <button
              type="button"
              onClick={() => {
                cache.clearCache(clearText);
                disarmClear();
              }}
              disabled={clearText !== "CLEAR" || cache.busy}
              className="rounded-md border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-500/20 active:scale-95 disabled:opacity-40"
            >
              Clear cache
            </button>
            <button
              type="button"
              onClick={disarmClear}
              className="rounded-md border border-white/[0.06] bg-white/[0.04] px-2 py-1 text-[11px] text-slate-400 hover:bg-white/[0.08] active:scale-95"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
