import type { ReactNode } from "react";

interface HelpPopoverProps {
  open: boolean;
  onClose: () => void;
}

const KEYBOARD_SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: "← / →", action: "Step one frame back / forward" },
  { keys: "Space", action: "Play / pause the timeline" },
  { keys: "Esc", action: "Close menus, drawers, and this help" },
  { keys: "?", action: "Toggle this help" },
];

// Accessible help & about dialog. Open state is owned by App (helpOpen); the
// backdrop click mirrors DisplayMenu's fixed-inset dismissal idiom and Escape
// is handled globally by useKeyboardShortcuts via App's handleEscape.
export default function HelpPopover({ open, onClose }: HelpPopoverProps) {
  if (!open) {
    return null;
  }
  return (
    <>
      <div className="fixed inset-0 z-[890] bg-slate-950/45" onClick={onClose} />
      <div
        role="dialog"
        aria-label="Help & shortcuts"
        data-testid="help-popover"
        className="fixed left-1/2 top-1/2 z-[900] max-h-[min(34rem,calc(100vh-2rem))] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-white/10 bg-[#02060d]/95 px-4 py-3 text-xs shadow-2xl backdrop-blur-xl"
      >
        <div className="flex items-center justify-between gap-3">
          <p className="m-0 text-sm font-semibold text-slate-50">Help &amp; shortcuts</p>
          <button
            type="button"
            aria-label="Close help"
            onClick={onClose}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-[11px] text-slate-300 hover:bg-white/[0.1] hover:text-slate-100 active:scale-95"
          >
            {"✕"}
          </button>
        </div>
        <div className="mt-3 grid gap-3 text-slate-300">
          <HelpSection title="Map readout">
            <p className="m-0">Hover the map to read the value of every active parameter under the cursor.</p>
          </HelpSection>
          <HelpSection title="Point soundings">
            <p className="m-0">Double-click anywhere on the map to open a Skew-T sounding for that point.</p>
          </HelpSection>
          <HelpSection title="Keyboard">
            <ul className="m-0 grid list-none gap-1 p-0">
              {KEYBOARD_SHORTCUTS.map((shortcut) => (
                <li key={shortcut.keys} className="flex items-baseline gap-2">
                  <span className="w-16 shrink-0 rounded border border-white/[0.08] bg-white/[0.05] px-1.5 py-0.5 text-center font-mono text-[10px] text-slate-100">
                    {shortcut.keys}
                  </span>
                  <span>{shortcut.action}</span>
                </li>
              ))}
            </ul>
          </HelpSection>
          <HelpSection title="Run staleness">
            <p className="m-0">
              Each panel shows a run-age chip: green is fresh, amber is aging, and red means the run is stale.
              &ldquo;Newer likely&rdquo; flags that a newer model cycle should be available.
            </p>
          </HelpSection>
        </div>
      </div>
    </>
  );
}

function HelpSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="m-0 mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">{title}</h3>
      {children}
    </section>
  );
}
