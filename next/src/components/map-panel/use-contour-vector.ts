import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { BasemapInkTheme } from "../../config/display";
import { heightContourLineLayerIds } from "../../config/layers";
import {
  fetchContourVectorPayload,
  getCachedContourVectorPayload,
  resolveContourVectorRequestUrl,
} from "../../core/artifact-client";
import { markFrameContourVectorLoaded } from "../../core/frame-prefetch";
import type {
  GeoJsonSourceFilter,
  LineLayerStyle,
  MapEngine,
  SymbolLayerStyle,
  ZoomCurve,
} from "../../core/map-engine/types";
import type { ContourVectorPayload, FrameRecord, LayerKey } from "../../types";
import { buildHeightContourFeatureCollection, emptyFeatureCollection } from "./synoptic-geojson";

// ── Native GL height-contour styling (Task 4.3 owner round 2 REDESIGN) ──────
// The Task-4.2 look (payload near-black cores over a shared white halo
// underlay) read as a doubled/cased stroke and was rejected at the owner
// gate ("pretty ugly … not as crisp and clean as they could be"). The
// redesign draws each contour as ONE confident stroke, the way professional
// upper-air charts do — solid, evenly weighted, hierarchy carried by weight
// and brightness instead of casing:
//
// - Per-theme ink (Task 4.3r3, hue retuned in Task 5.1): height contours
//   carry a WARM graphite/sepia identity so the upper-air family reads apart
//   from the cool-slate surface isobars at a glance when both are active
//   (the Task 5.1 co-active audit showed the two solid families were
//   near-identical platinum/graphite). LIGHT basemap: warm graphite minors,
//   deep sepia majors — the classic upper-air ink look, one hue-step warm of
//   the isobars' slate. DARK basemap: the inversion — warm-silver minors,
//   champagne near-white majors against the isobars' cool platinum. Weights
//   and the single-stroke construction are unchanged from the owner-accepted
//   round. The full line-family hierarchy (Task 5.1, both themes):
//     solid + cool slate  = surface pressure (isobars; brighter/darker+wider = major)
//     solid + warm sepia  = upper-air height contours (same rank rule)
//     dashed + chromatic  = thickness (cold blue / warm red, 540 purple emphasis)
// - Ground-matched halos (Task 5.1): a slightly wider stroke in the
//   basemap's ground tone UNDER each core — invisible over the basemap,
//   materializing only over bright weather fills where the contrast audit
//   showed the dark theme's ink vanishing into white-hot temperature pixels
//   (~1.1:1). NOT the rejected Task-4.2 casing: that halo contrasted with
//   the ground (white on navy) and doubled every stroke everywhere; this one
//   IS the ground.
// - Labels ride every line in the SAME ink as the major stroke over the
//   theme's cutout halo (dark chrome on dark, white paper on light — the
//   scheme the synoptic labels already use), so a label reads as part of its
//   line, not a sticker on it.
// No zoom-dependent styling existed for contours and none is added. Height
// contours REPLACE their raster twin, so lines and labels ride the "weather"
// opacity group (the Display Weather slider dims them with the raster they
// stand in for), in the "contours" anchor band: above weather rasters, below
// the synoptic band.
function contourLineStyle(style: Omit<LineLayerStyle, "group" | "anchor">): LineLayerStyle {
  return { ...style, group: "weather", anchor: "contours" };
}

// The two ground tones, as halo inks: the dark theme's navy ground (between
// the water fill #0a1220 and the app chrome), the light theme's paper
// LIGHT_EARTH #f8f7f4. Sub-opaque so crossings under the halo dim instead of
// vanish.
const CONTOUR_HALO_INKS: Record<BasemapInkTheme, string> = {
  dark: "rgba(6, 13, 24, 0.62)",
  light: "rgba(248, 247, 244, 0.66)",
};

const CONTOUR_MINOR_STYLES: Record<BasemapInkTheme, LineLayerStyle> = {
  dark: contourLineStyle({ color: "#CFC2A4", weight: 1.0, opacity: 0.85 }),
  light: contourLineStyle({ color: "#6A5B41", weight: 1.0, opacity: 0.85 }),
};
const CONTOUR_MAJOR_STYLES: Record<BasemapInkTheme, LineLayerStyle> = {
  dark: contourLineStyle({ color: "#F0E2C0", weight: 1.5, opacity: 0.95 }),
  light: contourLineStyle({ color: "#35291A", weight: 1.5, opacity: 0.95 }),
};
// Halo widths: core + 2.2 px (≈1.1 px of ground each side) — enough to lift
// a hairline off a same-luminance fill without reading as a second stroke.
const CONTOUR_MINOR_HALO_STYLES: Record<BasemapInkTheme, LineLayerStyle> = {
  dark: contourLineStyle({ color: CONTOUR_HALO_INKS.dark, weight: 3.2, opacity: 1 }),
  light: contourLineStyle({ color: CONTOUR_HALO_INKS.light, weight: 3.2, opacity: 1 }),
};
const CONTOUR_MAJOR_HALO_STYLES: Record<BasemapInkTheme, LineLayerStyle> = {
  dark: contourLineStyle({ color: CONTOUR_HALO_INKS.dark, weight: 3.7, opacity: 1 }),
  light: contourLineStyle({ color: CONTOUR_HALO_INKS.light, weight: 3.7, opacity: 1 }),
};

// Sizes mirror the synoptic value labels (native-domain ZoomCurve, Task 6.2)
// so the two contour families read as one typographic system.
const CONTOUR_LABEL_TEXT_SIZE: ZoomCurve = [
  [1, 11],
  [4, 12],
  [7, 13],
  [10, 14],
];

function contourLabelStyle(color: string, haloColor: string): SymbolLayerStyle {
  return {
    textProperty: "label",
    textSize: CONTOUR_LABEL_TEXT_SIZE,
    color,
    haloColor,
    haloWidth: 1.5,
    placement: "line",
    repeatSpacing: 300,
    opacity: 0.95,
    group: "weather",
    anchor: "contours",
  };
}

const CONTOUR_LABEL_STYLES: Record<BasemapInkTheme, SymbolLayerStyle> = {
  dark: contourLabelStyle("#F0E2C0", "rgba(4, 11, 18, 0.88)"),
  light: contourLabelStyle("#35291A", "rgba(255, 255, 255, 0.9)"),
};

const HEIGHT_MINOR_FILTER: GeoJsonSourceFilter = [
  "all",
  ["==", ["get", "kind"], "height"],
  ["==", ["get", "major"], false],
];
const HEIGHT_MAJOR_FILTER: GeoJsonSourceFilter = [
  "all",
  ["==", ["get", "kind"], "height"],
  ["==", ["get", "major"], true],
];
const HEIGHT_LABEL_FILTER: GeoJsonSourceFilter = ["==", ["get", "kind"], "height"];

interface UseContourVectorLayersArgs {
  activeLayers: Set<LayerKey>;
  // Active basemap ink theme (from the panel's display settings): selects the
  // per-theme contour ink sets above.
  basemapTheme: BasemapInkTheme;
  // The panel's MapEngine; contours render natively via setLineLayer.
  engineRef: RefObject<MapEngine | null>;
  frame: FrameRecord | null;
  mapReady: boolean;
}

export function useContourVectorLayers({
  activeLayers,
  basemapTheme,
  engineRef,
  frame,
  mapReady,
}: UseContourVectorLayersArgs): { vectorLayerKeys: Set<LayerKey>; failedLayerKeys: Set<LayerKey> } {
  const abortRef = useRef<AbortController | null>(null);
  const requestKeyRef = useRef("");
  // Native-path line-layer ids currently set on the engine, for the eviction
  // sweep when a contour parameter is toggled off or its payload goes away.
  const nativeIdsRef = useRef<Set<string>>(new Set());
  const [payloadState, setPayloadState] = useState<
    Record<string, { requestUrl: string; payload: ContourVectorPayload }>
  >({});
  const [failedRequestByLayer, setFailedRequestByLayer] = useState<Record<string, string>>({});

  const activeContourRequests = useMemo(() => {
    const refs = frame?.contourVectorRefs || {};
    return Array.from(activeLayers)
      .filter((layerKey) => Boolean(refs[layerKey]?.key))
      .map((layerKey) => ({ layerKey, requestUrl: resolveContourVectorRequestUrl(frame, layerKey) || "" }))
      .filter((entry) => Boolean(entry.requestUrl));
  }, [activeLayers, frame]);
  const activeContourLayers = useMemo(
    () => activeContourRequests.map((entry) => entry.layerKey),
    [activeContourRequests],
  );
  const activeContourLayersKey = activeContourLayers.join("|");

  const requestKey = useMemo(
    () =>
      activeContourRequests
        .map(({ layerKey, requestUrl }) => `${layerKey}:${requestUrl}`)
        .sort()
        .join("|"),
    [activeContourRequests],
  );

  // A state update from the preceding frame is harmless unless its URL
  // matches the current request. Pull prefetched current payloads directly
  // from the artifact cache so they can render on the first frame paint.
  const payloads = useMemo(() => {
    const current: Record<string, ContourVectorPayload> = {};
    for (const { layerKey, requestUrl } of activeContourRequests) {
      const stateEntry = payloadState[layerKey];
      const payload =
        stateEntry?.requestUrl === requestUrl ? stateEntry.payload : getCachedContourVectorPayload(frame, layerKey);
      if (payload) {
        current[layerKey] = payload;
      }
    }
    return current;
  }, [activeContourRequests, frame, payloadState]);

  useEffect(() => {
    abortRef.current?.abort();
    requestKeyRef.current = requestKey;
    if (!frame || activeContourLayers.length === 0) {
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    for (const { layerKey, requestUrl } of activeContourRequests) {
      void fetchContourVectorPayload(frame, layerKey, { signal: controller.signal })
        .then((payload) => {
          if (!payload || controller.signal.aborted || requestKeyRef.current !== requestKey) {
            return;
          }
          markFrameContourVectorLoaded(frame, layerKey);
          setPayloadState((current) => ({
            ...current,
            [layerKey]: { requestUrl, payload },
          }));
        })
        .catch(() => {
          // A missing/failed vector intentionally leaves this layer on its
          // raster fallback; sibling contour layers resolve independently.
          if (!controller.signal.aborted && requestKeyRef.current === requestKey) {
            setFailedRequestByLayer((current) => ({ ...current, [layerKey]: requestUrl }));
          }
        });
    }
    return () => controller.abort();
  }, [activeContourLayers.length, activeContourRequests, frame, requestKey]);

  // Decoded payload polylines subdivided smooth in geographic space (see
  // synoptic-geojson's smoothing block — the payload ships coarse vertices),
  // drawn from one collection into filtered minor/major halo, core, and label
  // layers per contour parameter. Their call order keeps the band stacking
  // deterministic.
  const nativeCollections = useMemo(() => {
    const out: Record<string, GeoJSON.FeatureCollection> = {};
    for (const [layerKey, payload] of Object.entries(payloads)) {
      out[layerKey] = buildHeightContourFeatureCollection(payload);
    }
    return out;
  }, [payloads]);

  const sharedStylesByLayer = useMemo(() => {
    const out: Record<
      string,
      {
        labels: SymbolLayerStyle;
        major: LineLayerStyle;
        majorHalo: LineLayerStyle;
        minor: LineLayerStyle;
        minorHalo: LineLayerStyle;
      }
    > = {};
    for (const layerKey of activeContourLayersKey.split("|").filter(Boolean)) {
      const sourceFamily = `height-contour:${layerKey}`;
      out[layerKey] = {
        minorHalo: {
          ...CONTOUR_MINOR_HALO_STYLES[basemapTheme],
          sourceFamily,
          sourceFilter: HEIGHT_MINOR_FILTER,
        },
        majorHalo: {
          ...CONTOUR_MAJOR_HALO_STYLES[basemapTheme],
          sourceFamily,
          sourceFilter: HEIGHT_MAJOR_FILTER,
        },
        minor: {
          ...CONTOUR_MINOR_STYLES[basemapTheme],
          sourceFamily,
          sourceFilter: HEIGHT_MINOR_FILTER,
        },
        major: {
          ...CONTOUR_MAJOR_STYLES[basemapTheme],
          sourceFamily,
          sourceFilter: HEIGHT_MAJOR_FILTER,
        },
        labels: {
          ...CONTOUR_LABEL_STYLES[basemapTheme],
          sourceFamily,
          sourceFilter: HEIGHT_LABEL_FILTER,
        },
      };
    }
    return out;
  }, [activeContourLayersKey, basemapTheme]);

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    // Keep-alive parity with the synoptic path (Task 4.4): a contour
    // parameter's five layer ids stay mounted for as long as the parameter
    // is ACTIVE (selected + contour refs on the current frame). A frame
    // change exposes only a matching cached/request-key payload; when the
    // next one is not warm, swapping in EMPTY collections during that gap — instead of the old
    // sweep-on-empty-payloads + re-add-on-arrival churn — keeps ids, band
    // order and the label collision index stable through timeline playback.
    // The sweep below now fires only on real deactivation (parameter toggled
    // off, or a frame without contour artifacts).
    const liveIds = new Set<string>();
    for (const layerKey of activeContourLayers) {
      const ids = heightContourLineLayerIds(layerKey);
      const collection = nativeCollections[layerKey] ?? emptyFeatureCollection();
      const styles = sharedStylesByLayer[layerKey];
      // Ground-matched halos first (bottom of the band), then the ink cores,
      // then labels — call order == stacking order within the anchor band.
      engine.setLineLayer(ids.minorHalo, collection, styles.minorHalo);
      engine.setLineLayer(ids.majorHalo, collection, styles.majorHalo);
      engine.setLineLayer(ids.minor, collection, styles.minor);
      engine.setLineLayer(ids.major, collection, styles.major);
      // Value labels ride the full collection, above the strokes (call order).
      engine.setSymbolLayer(ids.labels, collection, styles.labels);
      liveIds.add(ids.minorHalo);
      liveIds.add(ids.majorHalo);
      liveIds.add(ids.minor);
      liveIds.add(ids.major);
      liveIds.add(ids.labels);
    }
    for (const id of nativeIdsRef.current) {
      if (!liveIds.has(id)) {
        engine.removeLayer(id);
      }
    }
    nativeIdsRef.current = liveIds;
    // No per-run cleanup: eviction is the sweep above, and engine teardown
    // (panel unmount) drops the layers wholesale.
  }, [activeContourLayers, engineRef, mapReady, nativeCollections, sharedStylesByLayer]);

  return useMemo(() => {
    const vectorLayerKeys = new Set<LayerKey>(Object.keys(payloads));
    const failedLayerKeys = new Set<LayerKey>();
    for (const { layerKey, requestUrl } of activeContourRequests) {
      if (!vectorLayerKeys.has(layerKey) && failedRequestByLayer[layerKey] === requestUrl) {
        failedLayerKeys.add(layerKey);
      }
    }
    return { vectorLayerKeys, failedLayerKeys };
  }, [activeContourRequests, failedRequestByLayer, payloads]);
}
