import { MODEL_KEYS } from "./constants";
import type { ModelKey, ViewKey } from "../types";

export const RENDER_STORAGE_KEY = "modelview.render.v1";

export type RenderCategoryId = "surface" | "precip" | "radar" | "cloud" | "severe" | "winter" | "upperAir";
export type RenderTier = "simple" | "full";
export type GfsTemporalTier = "three-hourly" | "hourly-through-120";
export type SciencePrototypeId = "camDcape21Level" | "effectiveStp100mbReduced" | "rowAwareCenterValidation";

export const SCIENCE_PROTOTYPE_IDS: readonly SciencePrototypeId[] = [
  "camDcape21Level",
  "effectiveStp100mbReduced",
  "rowAwareCenterValidation",
];

const CAM_SCIENCE_PROTOTYPE_MODELS = new Set<ModelKey>(["hrrr", "nam3km"]);

export interface RenderCategoryDescriptor {
  id: RenderCategoryId;
  label: string;
  count: number;
  tiered: boolean;
  fullAdds?: string;
}

// Taxonomy mirrors spec §1.1. Counts are the catalog group sizes at authoring
// time; they are cosmetic (shown in the panel) and guarded for coherence by the
// Phase A2 parity test, not load-bearing for resolution.
export const RENDER_CATEGORIES: readonly RenderCategoryDescriptor[] = [
  { id: "surface", label: "Surface", count: 10, tiered: false },
  { id: "precip", label: "Precip", count: 7, tiered: false },
  { id: "radar", label: "Radar", count: 3, tiered: false },
  { id: "cloud", label: "Clouds", count: 2, tiered: false },
  { id: "upperAir", label: "Upper Air", count: 24, tiered: false },
  {
    id: "severe",
    label: "Severe",
    count: 21,
    tiered: true,
    fullAdds: "Effective SCP/STP, DCAPE (heavy)",
  },
  {
    id: "winter",
    label: "Winter",
    count: 12,
    tiered: true,
    // Owner decision (progress.md): winter simple KEEPS Kuchera; full adds only
    // the three ML/Cobb SLR products.
    fullAdds: "Snow RF, Western, Cobb",
  },
];

const RENDER_CATEGORY_IDS = RENDER_CATEGORIES.map((category) => category.id);
const TIERED_CATEGORY_IDS = new Set<RenderCategoryId>(
  RENDER_CATEGORIES.filter((category) => category.tiered).map((category) => category.id),
);

export interface RenderCategoryState {
  enabled: boolean;
  tier: RenderTier;
}

// Renderer tuning knobs forwarded per render. Bounds mirror the server's
// RENDER_TUNING_FIELDS (which mirror the builder's clampInt ranges) so a value
// accepted here is used verbatim. null tuning = builder auto-sizing.
export interface RenderTuning {
  workerCount?: number;
  totalFrameConcurrency?: number;
  rangeConcurrency?: number;
  decodeConcurrency?: number;
}

export const RENDER_TUNING_BOUNDS: Record<keyof RenderTuning, { min: number; max: number }> = {
  workerCount: { min: 1, max: 48 },
  totalFrameConcurrency: { min: 1, max: 64 },
  rangeConcurrency: { min: 1, max: 64 },
  decodeConcurrency: { min: 1, max: 8 },
};

// The known-good full-render settings from scripts/build-noaa-beta-recent-runs.js.
export const PRODUCTION_TUNING: Readonly<Required<RenderTuning>> = Object.freeze({
  workerCount: 18,
  totalFrameConcurrency: 24,
  rangeConcurrency: 3,
  decodeConcurrency: 2,
});

// Server-side cap for maxHour (matches the longest model horizon, GFS 384h).
export const MAX_HOUR_LIMIT = 384;

export interface RenderSelection {
  models: ModelKey[];
  view: ViewKey;
  // Per-model picked run ids (e.g. "20260703-1200Z"), consulted when
  // runMode === "pick". Run cycles differ per model (HRRR hourly, NAM3km
  // 4×/day) so one shared run id cannot be valid across models. A model with
  // an empty list renders its latest available run; multiple picks queue one
  // build per run, newest first (server ordering).
  runs: Partial<Record<ModelKey, string[]>>;
  runMode: "latest" | "pick";
  categories: Record<RenderCategoryId, RenderCategoryState>;
  // Prefix frame cap (f000..fN) applied to every selected model; null = full
  // horizon. Prefix-only keeps run-cumulative products byte-identical.
  maxHour: number | null;
  tuning: RenderTuning | null;
  // Optional build expansions. Defaults retain the established renderer
  // cadence and science methods byte-for-byte.
  gfsTemporalTier: GfsTemporalTier;
  sciencePrototypes: SciencePrototypeId[];
}

function buildDefaultCategories(): Record<RenderCategoryId, RenderCategoryState> {
  const out = {} as Record<RenderCategoryId, RenderCategoryState>;
  for (const id of RENDER_CATEGORY_IDS) {
    out[id] = { enabled: true, tier: "full" };
  }
  return out;
}

export const DEFAULT_RENDER_SELECTION: RenderSelection = {
  models: ["hrrr", "nam3km"],
  view: "conus",
  runs: {},
  runMode: "latest",
  categories: buildDefaultCategories(),
  maxHour: null,
  tuning: null,
  gfsTemporalTier: "three-hourly",
  sciencePrototypes: [],
};

export function cloneRenderSelection(selection: RenderSelection): RenderSelection {
  const categories = {} as Record<RenderCategoryId, RenderCategoryState>;
  for (const id of RENDER_CATEGORY_IDS) {
    categories[id] = { ...selection.categories[id] };
  }
  const runs: Partial<Record<ModelKey, string[]>> = {};
  for (const [model, picked] of Object.entries(selection.runs)) {
    if (Array.isArray(picked) && picked.length > 0) {
      runs[model as ModelKey] = [...picked];
    }
  }
  return {
    models: [...selection.models],
    view: selection.view,
    runs,
    runMode: selection.runMode,
    categories,
    maxHour: selection.maxHour,
    tuning: selection.tuning ? { ...selection.tuning } : null,
    gfsTemporalTier: selection.gfsTemporalTier,
    sciencePrototypes: [...selection.sciencePrototypes],
  };
}

function normalizeModels(candidate: unknown): ModelKey[] {
  const raw = Array.isArray(candidate) ? candidate : [];
  const out: ModelKey[] = [];
  for (const value of raw) {
    if (typeof value === "string" && (MODEL_KEYS as string[]).includes(value) && !out.includes(value as ModelKey)) {
      out.push(value as ModelKey);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_RENDER_SELECTION.models];
}

function normalizeTier(value: unknown): RenderTier {
  return value === "simple" ? "simple" : "full";
}

export function normalizeRenderSelection(candidate: unknown): RenderSelection {
  const fallback = DEFAULT_RENDER_SELECTION;
  if (!candidate || typeof candidate !== "object") {
    return cloneRenderSelection(fallback);
  }
  const raw = candidate as Partial<RenderSelection>;
  const rawCategories =
    raw.categories && typeof raw.categories === "object" ? (raw.categories as Record<string, unknown>) : {};
  const categories = {} as Record<RenderCategoryId, RenderCategoryState>;
  for (const id of RENDER_CATEGORY_IDS) {
    const entry = rawCategories[id];
    if (entry && typeof entry === "object") {
      const state = entry as Partial<RenderCategoryState>;
      categories[id] = {
        enabled: typeof state.enabled === "boolean" ? state.enabled : true,
        tier: TIERED_CATEGORY_IDS.has(id) ? normalizeTier(state.tier) : "full",
      };
    } else if (typeof entry === "boolean") {
      // Accept the compact wire form (bare boolean) on the way in.
      categories[id] = { enabled: entry, tier: "full" };
    } else {
      categories[id] = { enabled: true, tier: "full" };
    }
  }
  const runMode = raw.runMode === "pick" ? "pick" : "latest";
  const models = normalizeModels(raw.models);
  const runs: Partial<Record<ModelKey, string[]>> = {};
  if (runMode === "pick") {
    const rawRuns = raw.runs && typeof raw.runs === "object" ? (raw.runs as Record<string, unknown>) : null;
    if (rawRuns) {
      for (const model of models) {
        const picked = normalizeRunList(rawRuns[model]);
        if (picked.length > 0) {
          runs[model] = picked;
        }
      }
    } else {
      // Legacy stored shape (single `run` applied to every model): migrate it
      // onto each selected model so an existing pick survives the upgrade.
      const legacy = normalizeRunList((raw as { run?: unknown }).run);
      if (legacy.length > 0) {
        for (const model of models) {
          runs[model] = [...legacy];
        }
      }
    }
  }
  const sciencePrototypes = normalizeSciencePrototypes(raw.sciencePrototypes, models, categories);
  const gfsTemporalTier: GfsTemporalTier =
    models.includes("gfs") && raw.gfsTemporalTier === "hourly-through-120" ? "hourly-through-120" : "three-hourly";
  return {
    models,
    view: raw.view === "na" ? "na" : "conus",
    runs,
    runMode,
    categories,
    maxHour: normalizeMaxHour((raw as { maxHour?: unknown }).maxHour),
    tuning: normalizeTuning((raw as { tuning?: unknown }).tuning),
    gfsTemporalTier,
    sciencePrototypes,
  };
}

function normalizeSciencePrototypes(
  candidate: unknown,
  models: readonly ModelKey[],
  categories: Record<RenderCategoryId, RenderCategoryState>,
): SciencePrototypeId[] {
  if (!Array.isArray(candidate)) {
    return [];
  }
  const selected = new Set(candidate);
  const severeFull = categories.severe.enabled && categories.severe.tier === "full";
  const hasCam = models.some((model) => CAM_SCIENCE_PROTOTYPE_MODELS.has(model));
  return SCIENCE_PROTOTYPE_IDS.filter((id) => {
    if (!selected.has(id)) {
      return false;
    }
    if (id === "camDcape21Level") {
      return hasCam && severeFull;
    }
    if (id === "effectiveStp100mbReduced") {
      return severeFull;
    }
    // MSLP/height support selectors and synoptic center detection are core
    // artifacts in every category selection, so the row-aware diagnostic has
    // no category prerequisite to normalize away.
    return true;
  });
}

// Accepts a single run id or a list (multi-run queue); drops "latest" (an
// empty pick list means latest) and anything that is not a non-empty string.
function normalizeRunList(candidate: unknown): string[] {
  const raw = Array.isArray(candidate) ? candidate : [candidate];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed && trimmed !== "latest" && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}

function normalizeMaxHour(candidate: unknown): number | null {
  // Number(null) === 0 and Number("") === 0: without this guard the default
  // "no cap" (null) would round-trip through storage as an explicit 0-hour
  // cap and every subsequent render would silently build only f000.
  if (candidate === null || candidate === undefined || candidate === "") {
    return null;
  }
  const value = Number(candidate);
  if (!Number.isInteger(value) || value < 0 || value > MAX_HOUR_LIMIT) {
    return null;
  }
  return value;
}

function normalizeTuning(candidate: unknown): RenderTuning | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const raw = candidate as Record<string, unknown>;
  const out: RenderTuning = {};
  for (const key of Object.keys(RENDER_TUNING_BOUNDS) as Array<keyof RenderTuning>) {
    const bounds = RENDER_TUNING_BOUNDS[key];
    const value = Number(raw[key]);
    if (Number.isInteger(value) && value >= bounds.min && value <= bounds.max) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface RenderSelectionWire {
  models: ModelKey[];
  view: ViewKey;
  run: string;
  runs: Record<string, string[]>;
  categories: Record<string, boolean | { enabled: boolean; tier: RenderTier }>;
  maxHour?: number;
  tuning?: RenderTuning;
  gfsTemporalTier?: "hourly-through-120";
  sciencePrototypes?: SciencePrototypeId[];
}

// The POST body for /actions/render (spec §1.4): tiered categories keep
// {enabled, tier}; non-tiered ones collapse to a bare boolean so the server's
// resolver treats their tier as "full" implicitly. Picked runs go per model
// under `runs` as ARRAYS (the server spawns one chained build per distinct
// run, newest first); models the user left alone stay ["latest"]. maxHour and
// tuning are omitted entirely when unset so default builds stay byte-stable.
export function serializeRenderSelectionWire(selection: RenderSelection): RenderSelectionWire {
  const sciencePrototypes = normalizeSciencePrototypes(
    selection.sciencePrototypes,
    selection.models,
    selection.categories,
  );
  const categories: Record<string, boolean | { enabled: boolean; tier: RenderTier }> = {};
  for (const id of RENDER_CATEGORY_IDS) {
    const state = selection.categories[id];
    categories[id] = TIERED_CATEGORY_IDS.has(id) ? { enabled: state.enabled, tier: state.tier } : state.enabled;
  }
  const runs: Record<string, string[]> = {};
  for (const model of selection.models) {
    const picked = selection.runMode === "pick" ? (selection.runs[model] ?? []) : [];
    runs[model] = picked.length > 0 ? [...picked] : ["latest"];
  }
  const wire: RenderSelectionWire = {
    models: [...selection.models],
    view: selection.view,
    run: "latest",
    runs,
    categories,
  };
  if (selection.maxHour !== null) {
    wire.maxHour = selection.maxHour;
  }
  if (selection.tuning) {
    wire.tuning = { ...selection.tuning };
  }
  if (selection.models.includes("gfs") && selection.gfsTemporalTier === "hourly-through-120") {
    wire.gfsTemporalTier = "hourly-through-120";
  }
  if (sciencePrototypes.length > 0) {
    wire.sciencePrototypes = sciencePrototypes;
  }
  return wire;
}

// The run a single-model action (sounding prefetch) should target: the newest
// picked run (run ids sort lexicographically = chronologically), else latest.
export function effectiveRunForModel(selection: RenderSelection, model: ModelKey): string {
  if (selection.runMode !== "pick") {
    return "latest";
  }
  const picked = selection.runs[model] ?? [];
  if (picked.length === 0) {
    return "latest";
  }
  return [...picked].sort().reverse()[0];
}

export function loadStoredRenderSelection(): RenderSelection {
  if (typeof window === "undefined") {
    return cloneRenderSelection(DEFAULT_RENDER_SELECTION);
  }
  try {
    const stored = window.localStorage.getItem(RENDER_STORAGE_KEY);
    return stored ? normalizeRenderSelection(JSON.parse(stored)) : cloneRenderSelection(DEFAULT_RENDER_SELECTION);
  } catch {
    return cloneRenderSelection(DEFAULT_RENDER_SELECTION);
  }
}

export function storeRenderSelection(selection: RenderSelection): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(RENDER_STORAGE_KEY, JSON.stringify(normalizeRenderSelection(selection)));
  } catch {
    // Ignore private-mode and quota failures; render selection should never block the app.
  }
}
