import { useEffect, useRef, useState, type RefObject } from "react";
import {
  fetchHoverGridPayload,
  getCachedHoverGridPayload,
  resolveHoverGridRequestUrls,
} from "../../core/artifact-client";
import type { LatLon } from "../../core/map-engine/types";
import type { FrameRecord, HoverGridPayload, LayerKey } from "../../types";
import { EMPTY_HOVER, type HoverValues, sampleHoverValuesAtPoint } from "./hover-utils";

interface UseHoverGridArgs {
  activeLayers: Set<LayerKey>;
  frame: FrameRecord | null;
  hoverAbortRef: RefObject<AbortController | null>;
  hoverGridKeyRef: RefObject<string>;
  hoverLatLng: LatLon | null;
}

// Longer than 1x playback's 600 ms frame dwell: fast scrubbing/playback does
// not launch a hundreds-of-MiB hover download for every transient frame, but
// a settled selected frame is still warm before a typical analyst moves the
// pointer back onto the map. Pointer entry bypasses this delay.
const HOVER_IDLE_WARM_DELAY_MS = 750;

export function useHoverGrid({ activeLayers, frame, hoverAbortRef, hoverGridKeyRef, hoverLatLng }: UseHoverGridArgs) {
  const [hoverValueState, setHoverValueState] = useState<{
    frame: FrameRecord | null;
    requestKey: string;
    values: HoverValues;
  }>({ frame: null, requestKey: "", values: EMPTY_HOVER });
  const [hoverLoading, setHoverLoading] = useState(false);
  const [hoverGridState, setHoverGridState] = useState<{
    requestKey: string;
    payload: HoverGridPayload | null;
  }>({ requestKey: "", payload: null });
  const hoverActive = Boolean(hoverLatLng);
  const hoverActiveRef = useRef(hoverActive);
  const pointerWasActiveRef = useRef(false);
  const startHoverFetchRef = useRef<((showLoading: boolean) => void) | null>(null);
  hoverActiveRef.current = hoverActive;
  const hoverKey = resolveHoverGridRequestUrls(frame).join("|");
  const currentHoverIdentityRef = useRef({ frame, requestKey: hoverKey });
  currentHoverIdentityRef.current = { frame, requestKey: hoverKey };
  const setHoverValuesRef = useRef<((value: HoverValues) => void) | null>(null);
  if (!setHoverValuesRef.current) {
    // Map-engine teardown/mouseout needs a stable imperative clear function.
    // Stamp it with the identity current at call time so it can never revive a
    // sample belonging to a prior frame.
    setHoverValuesRef.current = (values) => {
      const identity = currentHoverIdentityRef.current;
      setHoverValueState({ ...identity, values });
    };
  }
  const setHoverValues = setHoverValuesRef.current;
  const cachedCurrentGrid = getCachedHoverGridPayload(hoverKey);
  const hoverGrid =
    hoverGridState.requestKey === hoverKey ? hoverGridState.payload || cachedCurrentGrid : cachedCurrentGrid;
  // Effects run after MapPanel has rendered. Gate the sample synchronously so
  // its broadcast effect cannot attach frame A's values to frame B's run or
  // valid-time identity during that intervening render.
  const hoverValues =
    hoverValueState.frame === frame && hoverValueState.requestKey === hoverKey ? hoverValueState.values : EMPTY_HOVER;

  useEffect(() => {
    hoverAbortRef.current?.abort();
    hoverGridKeyRef.current = hoverKey;
    if (!frame || !hoverKey) {
      startHoverFetchRef.current = null;
      setHoverGridState({ requestKey: hoverKey, payload: null });
      setHoverLoading(false);
      return;
    }
    const cached = getCachedHoverGridPayload(hoverKey);
    if (cached) {
      startHoverFetchRef.current = null;
      setHoverGridState({ requestKey: hoverKey, payload: cached });
      setHoverLoading(false);
      return;
    }
    // Do not retain the previous decoded payload for the whole debounce/fetch
    // interval. The bounded artifact-client LRU is the sole cross-frame owner.
    setHoverGridState({ requestKey: hoverKey, payload: null });
    setHoverLoading(false);
    const controller = new AbortController();
    hoverAbortRef.current = controller;
    let started = false;
    let warmTimer: number | null = null;
    const startFetch = (showLoading: boolean) => {
      if (showLoading) {
        setHoverLoading(true);
      }
      if (started) {
        return;
      }
      if (controller.signal.aborted) {
        return;
      }
      started = true;
      if (warmTimer !== null) {
        window.clearTimeout(warmTimer);
        warmTimer = null;
      }
      void fetchHoverGridPayload(frame, { signal: controller.signal })
        .then((payload) => {
          if (controller.signal.aborted || hoverGridKeyRef.current !== hoverKey) {
            return;
          }
          setHoverGridState({ requestKey: hoverKey, payload });
        })
        .catch(() => {
          if (!controller.signal.aborted && hoverGridKeyRef.current === hoverKey) {
            setHoverGridState({ requestKey: hoverKey, payload: null });
          }
        })
        .finally(() => {
          if (startHoverFetchRef.current === startFetch) {
            startHoverFetchRef.current = null;
          }
          if (!controller.signal.aborted && hoverGridKeyRef.current === hoverKey) {
            setHoverLoading(false);
          }
        });
    };
    startHoverFetchRef.current = startFetch;
    // A cursor that merely remains over the map while the timeline changes is
    // not a new pointer entry. Debounce that frame exactly like idle warmup;
    // the separate transition effect below is the only bypass.
    warmTimer = window.setTimeout(() => startFetch(hoverActiveRef.current), HOVER_IDLE_WARM_DELAY_MS);

    return () => {
      if (warmTimer !== null) {
        window.clearTimeout(warmTimer);
      }
      if (startHoverFetchRef.current === startFetch) {
        startHoverFetchRef.current = null;
      }
      controller.abort();
    };
  }, [frame, hoverAbortRef, hoverKey, hoverGridKeyRef]);

  // Pointer entry accelerates the selected-frame idle warmup. Pointer exit
  // deliberately does not abort an already-started fetch; doing so caused a
  // map -> timeline/menu gesture to throw away useful work and refetch it.
  useEffect(() => {
    const pointerEntered = hoverActive && !pointerWasActiveRef.current;
    pointerWasActiveRef.current = hoverActive;
    if (pointerEntered) {
      startHoverFetchRef.current?.(true);
    }
    // React StrictMode replays mount effects. Resetting only when this effect
    // itself cleans up preserves a genuine initial entry across that replay,
    // while frame changes (which do not change hoverActive) remain debounced.
    return () => {
      pointerWasActiveRef.current = false;
    };
  }, [hoverActive]);

  useEffect(() => {
    if (!hoverLatLng || !frame || activeLayers.size === 0 || !hoverGrid) {
      setHoverValueState({ frame, requestKey: hoverKey, values: EMPTY_HOVER });
      return;
    }
    setHoverValueState({
      frame,
      requestKey: hoverKey,
      values: sampleHoverValuesAtPoint({
        hoverGrid,
        bounds: frame.bounds,
        lat: hoverLatLng.lat,
        lon: hoverLatLng.lon,
      }),
    });
  }, [activeLayers.size, frame, hoverGrid, hoverKey, hoverLatLng]);

  return {
    hoverLoading,
    hoverValues,
    setHoverLoading,
    setHoverValues,
  };
}
