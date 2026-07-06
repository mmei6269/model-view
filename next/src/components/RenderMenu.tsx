import { useRef, type ReactNode } from "react";
import { MODEL_CONFIG, MODEL_KEYS, VIEW_CONFIG, VIEW_KEYS } from "../config/constants";
import AnchoredPopover from "./AnchoredPopover";
import { useAnchoredPopoverPosition } from "../hooks/useAnchoredPopover";
import {
  RENDER_CATEGORIES,
  effectiveRunForModel,
  type RenderCategoryDescriptor,
  type RenderCategoryId,
  type RenderSelection,
  type RenderTier,
} from "../config/render";
import type { BuiltRun, UpstreamRun } from "../core/actions-client";
import type { AvailableRunsState } from "../hooks/useAvailableRuns";
import type { ModelKey, ViewKey } from "../types";

export type RenderJobView = {
  status: "queued" | "running" | "done" | "failed";
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
  jobs: RenderJobEntry[];
  canSubmit: boolean;
  availableRuns: AvailableRunsState;
}

// HRRR/NAM3km are the convection-allowing models; several full-tier winter
// products (Western Linear, HRRR ASNOW) exist only for them. When the selection
// has no CAM, those sub-notes grey out (spec §4.5).
const CAM_MODELS: ModelKey[] = ["hrrr", "nam3km"];

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
  const frameProxy = selection.models.reduce((sum, model) => {
    const config = MODEL_CONFIG[model];
    const step = config.frameStepHours || 1;
    return sum + Math.round(config.maxHour / step) + 1;
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

  const toggleModel = (model: ModelKey, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...selection.models, model]))
      : selection.models.filter((value) => value !== model);
    onChange({ ...selection, models: next });
  };
  const setView = (view: ViewKey) => onChange({ ...selection, view });
  const setRunMode = (runMode: "latest" | "pick") => onChange({ ...selection, runMode });
  // "latest" clears the model's entry so its row set falls back to the
  // latest-available pseudo-row.
  const pickRun = (model: ModelKey, run: string) =>
    onChange({
      ...selection,
      runMode: "pick",
      runs:
        run === "latest"
          ? Object.fromEntries(Object.entries(selection.runs).filter(([key]) => key !== model))
          : { ...selection.runs, [model]: run },
    });
  const toggleCategory = (id: RenderCategoryId, enabled: boolean) =>
    onChange({
      ...selection,
      categories: { ...selection.categories, [id]: { ...selection.categories[id], enabled } },
    });
  const setCategoryTier = (id: RenderCategoryId, tier: RenderTier) =>
    onChange({
      ...selection,
      categories: { ...selection.categories, [id]: { ...selection.categories[id], tier } },
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
                  onPickRun={pickRun}
                />
              ) : null}
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
                  <JobProgress key={job.jobId} job={job} />
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
  onPickRun,
}: {
  models: ModelKey[];
  availableRuns: AvailableRunsState;
  selectedRuns: Partial<Record<ModelKey, string>>;
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
          selectedRun={selectedRuns[model] || "latest"}
          onPickRun={(run) => onPickRun(model, run)}
        />
      ))}
    </div>
  );
}

function formatFrameChip(frameCount: number | null): string | null {
  return frameCount === null ? null : `${frameCount} frame${frameCount === 1 ? "" : "s"}`;
}

function ModelRunList({
  model,
  availableRuns,
  selectedRun,
  onPickRun,
}: {
  model: ModelKey;
  availableRuns: AvailableRunsState;
  selectedRun: string;
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
      {availableRuns.loading ? (
        <span className="text-[11px] text-slate-500">Checking available runs…</span>
      ) : (
        <div className="grid max-h-40 gap-1 overflow-y-auto pr-0.5">
          <RunRow runId="latest" label="Latest available" selected={selectedRun === "latest"} onPick={onPickRun} />
          {rows.length === 0 ? (
            <span className="text-[11px] text-slate-500">
              {availableRuns.error ? `Run list unavailable: ${availableRuns.error}` : "No runs found"}
            </span>
          ) : null}
          {rows.map(({ runId, built: builtRun, upstream: upstreamRun }) => (
            <RunRow key={runId} runId={runId} selected={selectedRun === runId} onPick={onPickRun}>
              {builtRun ? (
                <>
                  {formatFrameChip(builtRun.upstreamFrameCount ?? builtRun.frameCount) ? (
                    <RunTag
                      tone={
                        builtRun.upstreamFrameCount !== null && builtRun.upstreamFrameCount > builtRun.frameCount
                          ? "amber"
                          : "slate"
                      }
                    >
                      {builtRun.upstreamFrameCount !== null && builtRun.upstreamFrameCount > builtRun.frameCount
                        ? `${builtRun.frameCount}/${builtRun.upstreamFrameCount} frames`
                        : formatFrameChip(builtRun.frameCount)}
                    </RunTag>
                  ) : null}
                  <RunTag tone="cyan">Built</RunTag>
                  {builtRun.latest ? <RunTag tone="emerald">Latest built</RunTag> : null}
                  {builtRun.complete ? <RunTag tone="slate">Complete</RunTag> : <RunTag tone="amber">Partial</RunTag>}
                </>
              ) : upstreamRun ? (
                <>
                  {formatFrameChip(upstreamRun.frameCount) ? (
                    <RunTag tone="slate">{formatFrameChip(upstreamRun.frameCount)}</RunTag>
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
  return (
    <button
      type="button"
      aria-label={label || runId}
      aria-pressed={selected}
      onClick={() => onPick(runId)}
      className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-left text-[11px] tabular-nums active:scale-[0.99] ${
        selected
          ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
          : "border-white/[0.06] bg-white/[0.03] text-slate-300 hover:bg-white/[0.07]"
      }`}
    >
      <span>
        {selected ? "✓ " : ""}
        {label || runId}
      </span>
      <span className="flex shrink-0 items-center gap-1">{children}</span>
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
  return <span className={`rounded-full px-1.5 py-px text-[9px] font-medium ${RUN_TAG_TONES[tone]}`}>{children}</span>;
}

function TierRadio({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-slate-400">
      <input type="radio" checked={checked} onChange={onChange} className="accent-cyan-400" aria-label={label} />
      <span>{label.split(" ").at(-1)}</span>
    </label>
  );
}

function JobProgress({ job }: { job: RenderJobEntry }) {
  // Mid-run the builder summary hasn't landed yet (total 0) but the server's
  // marker scan already knows the resolved frame target — prefer it so the
  // bar never reads n/0. Numerator takes the larger of the builder's own
  // counts and the on-disk markers, capped at the target.
  const target = job.markerTotal > 0 ? job.markerTotal : job.total;
  const rawDone = Math.max(job.built + job.reused, job.markerCount);
  const done = target > 0 ? Math.min(rawDone, target) : rawDone;
  const pct = target > 0 ? Math.min(100, Math.round((done / target) * 100)) : 0;
  return (
    <div className="grid gap-1" role="status" aria-label="Render job">
      {job.label ? <span className="text-[10px] uppercase tracking-widest text-slate-500">{job.label}</span> : null}
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-cyan-400/70 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-slate-400">
        {job.status === "failed"
          ? `failed: ${job.error || "unknown error"}`
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
