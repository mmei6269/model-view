import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AnchoredPopoverPosition } from "../hooks/useAnchoredPopover";

// Shared shell for header-anchored glass popovers (Display/Render menus):
// click-away backdrop + glass box portaled to <body> (it must not live inside
// the glass header's backdrop-filter subtree — see useAnchoredPopoverPosition)
// + an inner scroller, because fixed boxes don't extend page scroll and the
// glass ::before must stay on a non-scrolling element.
export default function AnchoredPopover({
  position,
  onDismiss,
  widthClassName,
  role,
  ariaLabel,
  children,
}: {
  position: AnchoredPopoverPosition;
  onDismiss: () => void;
  widthClassName: string;
  role?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onDismiss} />
      <div
        role={role}
        aria-label={ariaLabel}
        style={{ top: position.top, right: position.right }}
        className={`glass-popover fixed z-50 ${widthClassName} rounded-lg border border-transparent shadow-2xl shadow-slate-950/60`}
      >
        <div className="overflow-y-auto p-3" style={{ maxHeight: `calc(100vh - ${position.top + 12}px)` }}>
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
