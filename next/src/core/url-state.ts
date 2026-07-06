import { MODEL_KEYS, VIEW_KEYS } from "../config/constants";
import { normalizeIsoHour } from "./time";
import type { LayerKey, ModelKey, ValidTimeIso, ViewKey } from "../types";

export interface UrlState {
  view: ViewKey | null;
  model: ModelKey | null;
  layer: LayerKey | null;
  hour: ValidTimeIso | null;
}

export function readUrlState(): UrlState {
  if (typeof window === "undefined") {
    return { view: null, model: null, layer: null, hour: null };
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const rawView = params.get("view");
    const rawModel = params.get("model");
    const rawLayer = params.get("layer");
    const rawHour = params.get("hour");
    return {
      view: rawView && (VIEW_KEYS as string[]).includes(rawView) ? (rawView as ViewKey) : null,
      model: rawModel && (MODEL_KEYS as string[]).includes(rawModel) ? (rawModel as ModelKey) : null,
      layer: rawLayer ? rawLayer : null,
      hour: rawHour ? normalizeIsoHour(rawHour) : null,
    };
  } catch {
    return { view: null, model: null, layer: null, hour: null };
  }
}

export function writeUrlState(state: UrlState): void {
  if (typeof window === "undefined" || !window.history) {
    return;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    setOrDelete(params, "view", state.view);
    setOrDelete(params, "model", state.model);
    setOrDelete(params, "layer", state.layer);
    setOrDelete(params, "hour", state.hour);
    const query = params.toString();
    const next = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    window.history.replaceState(window.history.state, "", next);
  } catch {
    // Ignore history failures; URL mirroring is a bookmarking nicety, never load-bearing.
  }
}

function setOrDelete(params: URLSearchParams, key: string, value: string | null): void {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}
