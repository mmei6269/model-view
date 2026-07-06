import { MODEL_KEYS } from "./constants";
import type { ModelKey, ViewKey } from "../types";

export const RENDER_STORAGE_KEY = "modelview.render.v1";

export type RenderCategoryId = "surface" | "precip" | "radar" | "cloud" | "severe" | "winter" | "upperAir";
export type RenderTier = "simple" | "full";

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

export interface RenderSelection {
  models: ModelKey[];
  view: ViewKey;
  // Per-model picked run ids (e.g. "20260703-1200Z"), consulted when
  // runMode === "pick". Run cycles differ per model (HRRR hourly, NAM3km
  // 4×/day) so one shared run id cannot be valid across models. A model with
  // no entry (or "latest") renders its latest available run.
  runs: Partial<Record<ModelKey, string>>;
  runMode: "latest" | "pick";
  categories: Record<RenderCategoryId, RenderCategoryState>;
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
};

export function cloneRenderSelection(selection: RenderSelection): RenderSelection {
  const categories = {} as Record<RenderCategoryId, RenderCategoryState>;
  for (const id of RENDER_CATEGORY_IDS) {
    categories[id] = { ...selection.categories[id] };
  }
  return {
    models: [...selection.models],
    view: selection.view,
    runs: { ...selection.runs },
    runMode: selection.runMode,
    categories,
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
  const runs: Partial<Record<ModelKey, string>> = {};
  if (runMode === "pick") {
    const rawRuns = raw.runs && typeof raw.runs === "object" ? (raw.runs as Record<string, unknown>) : null;
    if (rawRuns) {
      for (const model of models) {
        const value = rawRuns[model];
        if (typeof value === "string" && value.trim() && value.trim() !== "latest") {
          runs[model] = value.trim();
        }
      }
    } else {
      // Legacy stored shape (single `run` applied to every model): migrate it
      // onto each selected model so an existing pick survives the upgrade.
      const legacy = (raw as { run?: unknown }).run;
      if (typeof legacy === "string" && legacy.trim() && legacy.trim() !== "latest") {
        for (const model of models) {
          runs[model] = legacy.trim();
        }
      }
    }
  }
  return {
    models,
    view: raw.view === "na" ? "na" : "conus",
    runs,
    runMode,
    categories,
  };
}

// The POST body for /actions/render (spec §1.4): tiered categories keep
// {enabled, tier}; non-tiered ones collapse to a bare boolean so the server's
// resolver treats their tier as "full" implicitly. Picked runs go per model
// under `runs` (the server groups models by run and spawns one build per
// distinct run); models the user left alone stay "latest".
export function serializeRenderSelectionWire(selection: RenderSelection): {
  models: ModelKey[];
  view: ViewKey;
  run: string;
  runs: Record<string, string>;
  categories: Record<string, boolean | { enabled: boolean; tier: RenderTier }>;
} {
  const categories: Record<string, boolean | { enabled: boolean; tier: RenderTier }> = {};
  for (const id of RENDER_CATEGORY_IDS) {
    const state = selection.categories[id];
    categories[id] = TIERED_CATEGORY_IDS.has(id) ? { enabled: state.enabled, tier: state.tier } : state.enabled;
  }
  const runs: Record<string, string> = {};
  for (const model of selection.models) {
    runs[model] = selection.runMode === "pick" ? selection.runs[model] || "latest" : "latest";
  }
  return {
    models: [...selection.models],
    view: selection.view,
    run: "latest",
    runs,
    categories,
  };
}

// The run a single-model action (sounding prefetch) should target.
export function effectiveRunForModel(selection: RenderSelection, model: ModelKey): string {
  return selection.runMode === "pick" ? selection.runs[model] || "latest" : "latest";
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
