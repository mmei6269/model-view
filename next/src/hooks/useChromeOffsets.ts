import { useLayoutEffect, useRef } from "react";

export function useChromeOffsets(settingsOpen: boolean) {
  const headerRef = useRef<HTMLElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const update = () => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const headerHeight = headerRef.current?.offsetHeight ?? 0;
      const timelineHeight = timelineRef.current?.offsetHeight ?? 0;
      root.style.setProperty("--chrome-top", `${headerHeight}px`);
      root.style.setProperty("--chrome-bottom", `${timelineHeight}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    if (headerRef.current) {
      observer.observe(headerRef.current);
    }
    if (timelineRef.current) {
      observer.observe(timelineRef.current);
    }
    return () => observer.disconnect();
  }, [settingsOpen]);

  return {
    headerRef,
    rootRef,
    timelineRef,
  };
}
