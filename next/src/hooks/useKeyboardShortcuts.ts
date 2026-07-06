import { useEffect, useRef } from "react";

export interface KeyboardShortcutHandlers {
  onStepFrame: (direction: 1 | -1) => void;
  onTogglePlay: () => void;
  onEscape: () => void;
  onHelp: () => void;
}

// Duck-typed on tagName/isContentEditable (rather than instanceof checks) so the
// guard stays evaluable in a bare node vm without jsdom (see
// tests-node/keyboard-shortcut-guard.test.js).
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") {
    return false;
  }
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  const tagName = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  return element.isContentEditable === true;
}

// Focused interactive controls (buttons, links, summaries) activate natively on
// Space; the play/pause shortcut must not preventDefault over them or keyboard
// users lose the control they tabbed to. Duck-typed on Element.closest for the
// same bare-vm reason as isEditableTarget.
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") {
    return false;
  }
  const element = target as { closest?: unknown };
  if (typeof element.closest !== "function") {
    return false;
  }
  return (element.closest as (selector: string) => unknown)("button, [role='button'], a[href], summary") != null;
}

// Global keyboard shortcuts: Left/Right step frames, Space toggles playback,
// Escape closes transient surfaces, ? toggles help. One window keydown listener
// for the app lifetime; latest handlers live in a ref so the listener never
// re-binds as callers pass fresh closures each render.
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // Leave browser/OS combos (Cmd+Left history back, Ctrl/Alt chords) alone.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      // Escape works regardless of focus (WAI-ARIA dialog pattern: Esc from the
      // drawer's lat/lon inputs must still close the drawer); every other key
      // stays suppressed in editable targets so typing is never hijacked.
      if (event.key !== "Escape" && isEditableTarget(event.target)) {
        return;
      }
      switch (event.key) {
        case "ArrowLeft":
          handlersRef.current.onStepFrame(-1);
          break;
        case "ArrowRight":
          handlersRef.current.onStepFrame(1);
          break;
        case " ":
        case "Space":
          // Let a focused button/link/summary activate natively instead of
          // hijacking Space for playback.
          if (isInteractiveTarget(event.target)) {
            break;
          }
          event.preventDefault();
          handlersRef.current.onTogglePlay();
          break;
        case "Escape":
          handlersRef.current.onEscape();
          break;
        case "?":
          handlersRef.current.onHelp();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
}
