// Global toast store. Module-level (not React context) so non-component code
// — job pollers, cache actions, fetch error paths — can push notifications
// without threading callbacks through the component tree. ToastHost renders
// the store via useSyncExternalStore.

export type ToastTone = "error" | "success" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

export interface ToastInput {
  tone: ToastTone;
  title: string;
  detail?: string;
  /** Auto-dismiss delay; errors default to sticky (0 = never auto-dismiss). */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 8_000;
const MAX_TOASTS = 5;

let toasts: readonly Toast[] = [];
let nextToastId = 1;
const listeners = new Set<() => void>();
const expiryTimers = new Map<number, ReturnType<typeof setTimeout>>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): readonly Toast[] {
  return toasts;
}

export function dismissToast(id: number): void {
  const timer = expiryTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(id);
  }
  if (toasts.some((toast) => toast.id === id)) {
    toasts = toasts.filter((toast) => toast.id !== id);
    notify();
  }
}

export function pushToast(input: ToastInput): number {
  const id = nextToastId;
  nextToastId += 1;
  const toast: Toast = { id, tone: input.tone, title: input.title, detail: input.detail };
  const next = [...toasts, toast];
  // Cap the stack: drop the oldest (and its timer) rather than growing forever.
  toasts = next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
  for (const dropped of next.slice(0, next.length - toasts.length)) {
    const timer = expiryTimers.get(dropped.id);
    if (timer) {
      clearTimeout(timer);
      expiryTimers.delete(dropped.id);
    }
  }
  const ttlMs = input.ttlMs ?? (input.tone === "error" ? 0 : DEFAULT_TTL_MS);
  if (ttlMs > 0) {
    expiryTimers.set(
      id,
      setTimeout(() => {
        expiryTimers.delete(id);
        dismissToast(id);
      }, ttlMs),
    );
  }
  notify();
  return id;
}

/** Test/reset hook: drops every toast and timer. */
export function clearAllToasts(): void {
  for (const timer of expiryTimers.values()) {
    clearTimeout(timer);
  }
  expiryTimers.clear();
  if (toasts.length > 0) {
    toasts = [];
    notify();
  }
}
