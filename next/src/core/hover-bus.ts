// Cross-panel hover bus. The hovered panel broadcasts its cursor position and
// its sampled values; other panels mirror the point on their own hover grids
// and show a numeric Δ against the source panel. Module-level pub/sub (like
// the toast store) so panels never need App-threaded callbacks.

export interface HoverBroadcast {
  sourcePanelId: string;
  sourceModelLabel: string;
  sourceRunId: string | null;
  sourceValidTimeIso: string | null;
  lat: number;
  lon: number;
  /** Source panel's sampled per-layer values (HoverValues.byLayer). */
  values: Record<string, number | null>;
  pressureHpa: number | null;
}

type Listener = (broadcast: HoverBroadcast | null) => void;

let current: HoverBroadcast | null = null;
const listeners = new Set<Listener>();

export function publishHover(broadcast: HoverBroadcast | null): void {
  current = broadcast;
  for (const listener of listeners) {
    listener(broadcast);
  }
}

export function subscribeHover(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHoverBroadcast(): HoverBroadcast | null {
  return current;
}

export function clearHoverBroadcastIfOwnedBy(panelId: string): boolean {
  if (current?.sourcePanelId !== panelId) {
    return false;
  }
  publishHover(null);
  return true;
}
