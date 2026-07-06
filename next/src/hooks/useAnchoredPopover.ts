import { useLayoutEffect, useState, type RefObject } from "react";

export interface AnchoredPopoverPosition {
  top: number;
  right: number;
}

// Position for a header popover PORTALED to <body>. The popovers must not
// render inside the glass header: in Gecko/WebRender a backdrop-filter
// ancestor composites its whole subtree, and hover repaints inside the
// popover re-snap that surface — the panel visibly shifts (screen-capture
// verified: removing the header's backdrop-filter is the variable that makes
// it rock-solid; the popover's own blur is not). Chromium separately
// resamples composited text at fractional offsets. Portaling out of the
// header plus integer fixed coordinates (Math.round) sidesteps both engines'
// failure modes — same architecture as HelpPopover and the map-panel menus,
// which never glitched.
export function useAnchoredPopoverPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
): AnchoredPopoverPosition | null {
  const [position, setPosition] = useState<AnchoredPopoverPosition | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) {
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const top = Math.round(rect.bottom + 8);
      const right = Math.round(window.innerWidth - rect.right);
      // Keep the same reference when nothing moved — the capture-phase scroll
      // listener also fires for the popover's own inner scroller.
      setPosition((prev) => (prev && prev.top === top && prev.right === right ? prev : { top, right }));
    };
    update();
    // Resizes (and browser zoom changes, which fire resize) move the anchor;
    // capture-phase scroll catches any scrolling ancestor, so the popover
    // follows its button instead of pinning to a stale viewport position.
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open]);
  return position;
}
