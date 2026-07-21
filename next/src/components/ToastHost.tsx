import { useSyncExternalStore } from "react";
import { dismissToast, getToasts, subscribeToasts, type ToastTone } from "../core/toasts";

const TONE_STYLES: Record<ToastTone, { frame: string; accent: string }> = {
  error: { frame: "border-rose-400/30 bg-rose-950/90", accent: "text-rose-300" },
  success: { frame: "border-emerald-400/30 bg-emerald-950/90", accent: "text-emerald-300" },
  info: { frame: "border-sky-400/30 bg-sky-950/90", accent: "text-sky-300" },
};

// Fixed bottom-right notification stack. Sits above the timeline (z-50) but
// never intercepts map interaction outside its own cards.
export default function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div
      className="pointer-events-none fixed right-3 bottom-16 z-50 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2"
      role="status"
      aria-live="polite"
      data-testid="toast-host"
    >
      {toasts.map((toast) => {
        const tone = TONE_STYLES[toast.tone];
        return (
          <div
            key={toast.id}
            data-testid="toast"
            data-tone={toast.tone}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 shadow-lg backdrop-blur ${tone.frame}`}
          >
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className={`text-xs font-semibold ${tone.accent}`}>{toast.title}</span>
              {toast.detail ? <span className="text-[11px] break-words text-slate-300">{toast.detail}</span> : null}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
              className="rounded px-1 text-xs text-slate-400 hover:bg-white/[0.08] hover:text-slate-200"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
