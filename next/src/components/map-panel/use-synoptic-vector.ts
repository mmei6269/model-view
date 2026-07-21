import { useEffect, useMemo, useState, type RefObject } from "react";
import type { BasemapInkTheme } from "../../config/display";
import { SYNOPTIC_LABEL_LAYER_IDS, SYNOPTIC_LINE_HALO_LAYER_IDS, SYNOPTIC_LINE_LAYER_IDS } from "../../config/layers";
import {
  fetchSynopticVectorPayload,
  getCachedSynopticVectorPayload,
  resolveSynopticVectorKey,
  resolveSynopticVectorRequestUrl,
} from "../../core/artifact-client";
import { markFrameSynopticVectorLoaded } from "../../core/frame-prefetch";
import type {
  GeoJsonSourceFilter,
  LineLayerStyle,
  MapEngine,
  SymbolLayerStyle,
  ZoomCurve,
} from "../../core/map-engine/types";
import type { FrameRecord, LayerKey, SynopticDetailMode, SynopticVectorPayload } from "../../types";
import {
  buildSynopticFeatureCollections,
  normalizeSynopticVectorPayload,
  type SynopticStyleClassCollections,
} from "./synoptic-geojson";

// ── Native GL synoptic line styling (Task 4.2 REDESIGN, per-theme inks since
// Task 4.3r3) ──
// Deliberately NOT a port of the retired leaflet canvas look (near-black
// strokes over white halo pairs — a scheme that needed a second polyline per
// line). The GL redesign styles per basemap theme and for legibility over
// bright weather fills; one ink SET per theme, same weights/dashes/zoom rules
// in both:
//
// - Isobars: solid, desaturated slate — cool/neutral so it never reads as a
//   data hue (thickness owns red/blue, reflectivity owns greens). Minor 4-hPa
//   lines stay thin and quiet; major 8-hPa lines (the payload's own emphasis
//   marking) are wider and stronger, giving the pressure field a
//   read-at-a-glance hierarchy without halos. DARK ground: luminous platinum
//   ramp (brighter = more important). LIGHT ground: the inversion — deep
//   slate ramp (darker = more important) on the near-white paper.
// - Thickness: dashed (the long-standing convention distinguishing thermal
//   from pressure lines), hue by side of the 540-dam boundary — cold blue
//   below, warm red above. DARK: brightened for the navy base; LIGHT:
//   deepened so the hues hold on white. Major 12-dam lines carry a longer
//   dash + more weight than 6-dam minors. The 540 line itself — the classic
//   rain/snow guidance line — is the emphasis line: heaviest, near-opaque,
//   in the app's established boundary purple (brightened from #6A1B9A on
//   dark; the classic #6A1B9A itself on light).
// - Zoom behavior mirrors the old renderer's ONLY zoom rule: minor thickness
//   lines hide below native z3 (style.thickness.showMinorAtZoomGte 4, which
//   is in the shared style JSON's legacy leaflet-scale domain = native + 1);
//   everything else keeps constant opacity. Curves live in the NATIVE
//   maplibre zoom domain (Task 6.2).
// - Ground-matched halos under the SOLID isobar strokes (Task 5.1): the
//   contrast audit showed the dark theme's slate isobars sinking into
//   white-hot temperature fills. A slightly wider stroke in the basemap's
//   own ground tone sits at the very bottom of the band — invisible over the
//   basemap, materializing only over bright fills. The dashed thickness
//   classes deliberately get none: their chromatic inks stayed legible in
//   the same audit, and dash-on-dash halos read as the casing the owner
//   round rejected.
//
// All layers ride the "synoptic" opacity group (Display -> Synoptic slider)
// in the engine's synoptic anchor band: above every weather raster, below
// basemap place labels.
const THICKNESS_MINOR_ZOOM_FADE: ZoomCurve = [
  [2.999, 0],
  [3, 0.78],
];

function synopticLineStyle(style: Omit<LineLayerStyle, "group" | "anchor">): LineLayerStyle {
  return { ...style, group: "synoptic", anchor: "synoptic" };
}

// Per-theme line hues; everything else (weights, dashes, opacities, zoom
// fades) is theme-invariant and lives in buildSynopticLineStyles.
const SYNOPTIC_LINE_INKS: Record<BasemapInkTheme, Record<keyof SynopticStyleClassCollections, string>> = {
  dark: {
    thicknessCold: "#58A6DE",
    thicknessColdMajor: "#7CC0EC",
    thicknessWarm: "#E4694F",
    thicknessWarmMajor: "#F18D71",
    thicknessBoundary: "#B784E8",
    isobars: "#9FB3C8",
    isobarsMajor: "#D7E3EE",
  },
  light: {
    thicknessCold: "#4B94C9",
    thicknessColdMajor: "#1F6BA6",
    thicknessWarm: "#CE5B39",
    thicknessWarmMajor: "#A83E20",
    thicknessBoundary: "#6A1B9A",
    isobars: "#5B6B7B",
    isobarsMajor: "#33414F",
  },
};

function buildSynopticLineStyles(theme: BasemapInkTheme): Record<keyof SynopticStyleClassCollections, LineLayerStyle> {
  const ink = SYNOPTIC_LINE_INKS[theme];
  return {
    thicknessCold: synopticLineStyle({
      color: ink.thicknessCold,
      weight: 1.05,
      opacity: THICKNESS_MINOR_ZOOM_FADE,
      dashArray: [6, 4],
    }),
    thicknessColdMajor: synopticLineStyle({
      color: ink.thicknessColdMajor,
      weight: 1.55,
      opacity: 0.85,
      dashArray: [10, 4],
    }),
    thicknessWarm: synopticLineStyle({
      color: ink.thicknessWarm,
      weight: 1.05,
      opacity: THICKNESS_MINOR_ZOOM_FADE,
      dashArray: [6, 4],
    }),
    thicknessWarmMajor: synopticLineStyle({
      color: ink.thicknessWarmMajor,
      weight: 1.55,
      opacity: 0.85,
      dashArray: [10, 4],
    }),
    thicknessBoundary: synopticLineStyle({
      color: ink.thicknessBoundary,
      weight: 2.0,
      opacity: 0.95,
      dashArray: [10, 4],
    }),
    isobars: synopticLineStyle({ color: ink.isobars, weight: 1.0, opacity: 0.85 }),
    isobarsMajor: synopticLineStyle({ color: ink.isobarsMajor, weight: 1.9, opacity: 0.95 }),
  };
}

const SYNOPTIC_LINE_STYLES: Record<BasemapInkTheme, Record<keyof SynopticStyleClassCollections, LineLayerStyle>> = {
  dark: buildSynopticLineStyles("dark"),
  light: buildSynopticLineStyles("light"),
};

// Ground-tone halo inks (see the header block): the dark theme's navy ground,
// the light theme's paper. Same tones as the height-contour halos so the two
// solid families lift off bright fills identically.
const SYNOPTIC_HALO_INKS: Record<BasemapInkTheme, string> = {
  dark: "rgba(6, 13, 24, 0.62)",
  light: "rgba(248, 247, 244, 0.66)",
};

// Halo width = core + 2.2 px (minor 1.0 -> 3.2, major 1.9 -> 4.1).
const SYNOPTIC_LINE_HALO_STYLES: Record<
  BasemapInkTheme,
  Record<keyof typeof SYNOPTIC_LINE_HALO_LAYER_IDS, LineLayerStyle>
> = {
  dark: {
    isobars: synopticLineStyle({ color: SYNOPTIC_HALO_INKS.dark, weight: 3.2, opacity: 1 }),
    isobarsMajor: synopticLineStyle({ color: SYNOPTIC_HALO_INKS.dark, weight: 4.1, opacity: 1 }),
  },
  light: {
    isobars: synopticLineStyle({ color: SYNOPTIC_HALO_INKS.light, weight: 3.2, opacity: 1 }),
    isobarsMajor: synopticLineStyle({ color: SYNOPTIC_HALO_INKS.light, weight: 4.1, opacity: 1 }),
  },
};

const SYNOPTIC_HALO_ORDER = Object.keys(SYNOPTIC_LINE_HALO_LAYER_IDS) as Array<
  keyof typeof SYNOPTIC_LINE_HALO_LAYER_IDS
>;

// Bottom -> top inside the synoptic band == SYNOPTIC_LINE_LAYER_IDS object
// order (thickness under isobars, 540 on top of its band-mates, majors over
// minors) — the engine stacks same-anchor layers in call order.
const SYNOPTIC_CLASS_ORDER = Object.keys(SYNOPTIC_LINE_LAYER_IDS) as Array<keyof SynopticStyleClassCollections>;

const SYNOPTIC_SOURCE_FAMILY = "synoptic-lines";
const HIDDEN_SOURCE_FILTER: GeoJsonSourceFilter = ["==", ["get", "kind"], "__hidden__"];
const SYNOPTIC_CLASS_FILTERS: Record<keyof SynopticStyleClassCollections, GeoJsonSourceFilter> = {
  thicknessCold: [
    "all",
    ["==", ["get", "kind"], "thickness"],
    ["==", ["get", "band"], "cold"],
    ["==", ["get", "major"], false],
  ],
  thicknessColdMajor: [
    "all",
    ["==", ["get", "kind"], "thickness"],
    ["==", ["get", "band"], "cold"],
    ["==", ["get", "major"], true],
  ],
  thicknessWarm: [
    "all",
    ["==", ["get", "kind"], "thickness"],
    ["==", ["get", "band"], "warm"],
    ["==", ["get", "major"], false],
  ],
  thicknessWarmMajor: [
    "all",
    ["==", ["get", "kind"], "thickness"],
    ["==", ["get", "band"], "warm"],
    ["==", ["get", "major"], true],
  ],
  thicknessBoundary: ["all", ["==", ["get", "kind"], "thickness"], ["==", ["get", "band"], "boundary"]],
  isobars: ["all", ["==", ["get", "kind"], "isobar"], ["==", ["get", "major"], false]],
  isobarsMajor: ["all", ["==", ["get", "kind"], "isobar"], ["==", ["get", "major"], true]],
};

// ── Native GL synoptic value labels (Task 4.3 REDESIGN, owner round 2) ───────
// Along-line value labels placed by MapLibre's collision engine (which
// replaced the retired leaflet path's custom screen-space declutter). Labels
// ride the SAME line features as the line layers (properties.label =
// String(value)), one symbol layer per line class:
//
// - EVERY line is labeled (owner decision, spec §8a.2): minors and majors
//   alike, at every zoom their line is visible. Density is managed by
//   repeatSpacing + the collision engine, never by hiding label classes —
//   the round-1 z6 opacity gate is gone. (It also left phantom collision
//   boxes: text-opacity is paint, MapLibre collision ignores it, so the
//   invisible minor labels were suppressing visible labels beneath them.)
// - The ONE zoom gate that remains mirrors a LINE-visibility rule: minor
//   thickness lines hide below native z3 (their Task-4.2 opacity curve), so
//   their labels carry minZoom 3 — a layer property, which is the contract's
//   only legal zoom-gating mechanism for symbols (no phantom boxes).
// - Text colors are each class's line ink nudged for contrast (brighter on
//   dark ground, deeper on light ground); the halo is theme-conditional —
//   the app's dark chrome tone on dark, near-white paper on light — which
//   "cuts" the label out of its own line stroke and keeps it legible over
//   bright reflectivity/CAPE fills (replacing the old white text-shadow +
//   line-gap hack).
// - Sizes mirror the old fontSizePxByBucket (11/12/13/14 across the legacy
//   leaflet-scale buckets z0_3/z4_6/z7_9/z10_12) as a NATIVE-domain ZoomCurve
//   (stops = legacy bucket anchors − 1, Task 6.2); minors run one px smaller
//   so the major/minor hierarchy survives into the labels.
// - repeatSpacing: majors keep the old per-bucket repeat distances (isobars
//   300 px, thickness 360 px); the now-always-on minors run sparser along
//   their line (isobars 380 px, thickness 460 px) so a CONUS viewport reads
//   values without wallpapering — between lines, the collision engine plus
//   top-down priority (below) thins naturally.
//
// Stacking (bottom -> top): all 7 line layers, then labels in
// SYNOPTIC_LABEL_LAYER_IDS order — MapLibre places collisions top-down, so
// meteorological priority = 540 > thickness majors > isobar majors > minors
// (H/L centers, set by use-pressure-markers into the top band, above all).
const SYNOPTIC_LABEL_TEXT_SIZE: ZoomCurve = [
  [1, 11],
  [4, 12],
  [7, 13],
  [10, 14],
];
const SYNOPTIC_MINOR_LABEL_TEXT_SIZE: ZoomCurve = [
  [1, 10],
  [4, 11],
  [7, 12],
  [10, 13],
];
// Theme-conditional label halo: the app's dark chrome tone on dark ground,
// near-opaque white on light ground (the classic paper-chart cutout).
const SYNOPTIC_LABEL_HALOS: Record<BasemapInkTheme, string> = {
  dark: "rgba(4, 11, 18, 0.88)",
  light: "rgba(255, 255, 255, 0.9)",
};

function synopticLabelStyle(
  theme: BasemapInkTheme,
  color: string,
  overrides: Partial<Pick<SymbolLayerStyle, "minZoom" | "repeatSpacing" | "textSize">> = {},
): SymbolLayerStyle {
  return {
    textProperty: "label",
    textSize: SYNOPTIC_LABEL_TEXT_SIZE,
    color,
    haloColor: SYNOPTIC_LABEL_HALOS[theme],
    haloWidth: 1.5,
    placement: "line",
    repeatSpacing: 300,
    opacity: 0.95,
    group: "synoptic",
    anchor: "synoptic",
    ...overrides,
  };
}

function synopticMinorLabelStyle(
  theme: BasemapInkTheme,
  color: string,
  repeatSpacing: number,
  minZoom?: number,
): SymbolLayerStyle {
  return synopticLabelStyle(theme, color, {
    textSize: SYNOPTIC_MINOR_LABEL_TEXT_SIZE,
    repeatSpacing,
    ...(minZoom === undefined ? {} : { minZoom }),
  });
}

// Native zoom where minor THICKNESS lines appear (matches
// THICKNESS_MINOR_ZOOM_FADE above): labels must never outlive their line.
const THICKNESS_MINOR_LABEL_MIN_ZOOM = 3;

// Per-theme label inks: on dark ground each class's line color nudged
// brighter; on light ground nudged deeper than its line so the text carries
// the contrast against the white halo.
const SYNOPTIC_LABEL_STYLES: Record<
  BasemapInkTheme,
  Record<keyof typeof SYNOPTIC_LABEL_LAYER_IDS, SymbolLayerStyle>
> = {
  dark: {
    isobars: synopticMinorLabelStyle("dark", "#BECFDE", 380),
    thicknessCold: synopticMinorLabelStyle("dark", "#8FC6EA", 460, THICKNESS_MINOR_LABEL_MIN_ZOOM),
    thicknessWarm: synopticMinorLabelStyle("dark", "#F09B80", 460, THICKNESS_MINOR_LABEL_MIN_ZOOM),
    isobarsMajor: synopticLabelStyle("dark", "#E9F1F8"),
    thicknessWarmMajor: synopticLabelStyle("dark", "#F6A78C", { repeatSpacing: 360 }),
    thicknessColdMajor: synopticLabelStyle("dark", "#9CD1F1", { repeatSpacing: 360 }),
    thicknessBoundary: synopticLabelStyle("dark", "#CDA9EF", { repeatSpacing: 360 }),
  },
  light: {
    isobars: synopticMinorLabelStyle("light", "#45535F", 380),
    thicknessCold: synopticMinorLabelStyle("light", "#3D7FB0", 460, THICKNESS_MINOR_LABEL_MIN_ZOOM),
    thicknessWarm: synopticMinorLabelStyle("light", "#B54E2E", 460, THICKNESS_MINOR_LABEL_MIN_ZOOM),
    isobarsMajor: synopticLabelStyle("light", "#22303D"),
    thicknessWarmMajor: synopticLabelStyle("light", "#8F3315", { repeatSpacing: 360 }),
    thicknessColdMajor: synopticLabelStyle("light", "#175A8E", { repeatSpacing: 360 }),
    thicknessBoundary: synopticLabelStyle("light", "#5E1F87", { repeatSpacing: 360 }),
  },
};

// Each label layer draws from the split line-feature collection of its class.
const SYNOPTIC_LABEL_SOURCES: Record<keyof typeof SYNOPTIC_LABEL_LAYER_IDS, keyof SynopticStyleClassCollections> = {
  isobars: "isobars",
  thicknessCold: "thicknessCold",
  thicknessWarm: "thicknessWarm",
  isobarsMajor: "isobarsMajor",
  thicknessWarmMajor: "thicknessWarmMajor",
  thicknessColdMajor: "thicknessColdMajor",
  thicknessBoundary: "thicknessBoundary",
};

const SYNOPTIC_LABEL_ORDER = Object.keys(SYNOPTIC_LABEL_LAYER_IDS) as Array<keyof typeof SYNOPTIC_LABEL_LAYER_IDS>;

function removeSynopticLineLayers(engine: MapEngine): void {
  for (const haloClass of SYNOPTIC_HALO_ORDER) {
    engine.removeLayer(SYNOPTIC_LINE_HALO_LAYER_IDS[haloClass]);
  }
  for (const styleClass of SYNOPTIC_CLASS_ORDER) {
    engine.removeLayer(SYNOPTIC_LINE_LAYER_IDS[styleClass]);
  }
  for (const labelClass of SYNOPTIC_LABEL_ORDER) {
    engine.removeLayer(SYNOPTIC_LABEL_LAYER_IDS[labelClass]);
  }
}

interface UseSynopticVectorPayloadArgs {
  activeLayers: Set<LayerKey>;
  frame: FrameRecord | null;
  synopticDetailMode: SynopticDetailMode;
  synopticVectorKeyRef: RefObject<string>;
  vectorAbortRef: RefObject<AbortController | null>;
}

interface UseSynopticVectorLayerArgs {
  activeLayers: Set<LayerKey>;
  // Active basemap ink theme (from the panel's display settings): selects the
  // per-theme line/label ink sets above.
  basemapTheme: BasemapInkTheme;
  // The panel's MapEngine; synoptic lines/labels render natively via
  // setLineLayer/setSymbolLayer.
  engineRef: RefObject<MapEngine | null>;
  mapReady: boolean;
  showIsobars: boolean;
  showThickness: boolean;
  synopticVector: SynopticVectorPayload | null;
}

export function useSynopticVectorPayload({
  activeLayers,
  frame,
  synopticDetailMode,
  synopticVectorKeyRef,
  vectorAbortRef,
}: UseSynopticVectorPayloadArgs) {
  const [payloadState, setPayloadState] = useState<{
    requestKey: string;
    payload: SynopticVectorPayload | null;
    failed: boolean;
  }>({ requestKey: "", payload: null, failed: false });
  const activeSynopticVectorKey = useMemo(
    () =>
      resolveSynopticVectorRequestUrl(frame, synopticDetailMode) || resolveSynopticVectorKey(frame, synopticDetailMode),
    [frame, synopticDetailMode],
  );
  const vectorKey = String(activeSynopticVectorKey || "").trim();
  // Effects run after render. Key the visible payload during render so the
  // prior frame can never suppress the new frame's raster fallback for one
  // paint; a prefetched current payload is available synchronously.
  const cachedCurrentPayload =
    activeLayers.has("synoptic") && vectorKey ? getCachedSynopticVectorPayload(frame, { synopticDetailMode }) : null;
  const synopticVector =
    activeLayers.has("synoptic") && vectorKey
      ? payloadState.requestKey === vectorKey
        ? payloadState.payload || cachedCurrentPayload
        : cachedCurrentPayload
      : null;
  const normalizedSynopticVector = useMemo(() => normalizeSynopticVectorPayload(synopticVector), [synopticVector]);
  const synopticVectorStatus = !activeLayers.has("synoptic")
    ? "inactive"
    : !frame
      ? "loading"
      : !vectorKey
        ? "fallback"
        : synopticVector
          ? "vector"
          : payloadState.requestKey === vectorKey && payloadState.failed
            ? "fallback"
            : "loading";

  useEffect(() => {
    vectorAbortRef.current?.abort();
    synopticVectorKeyRef.current = vectorKey;
    if (!activeLayers.has("synoptic") || !vectorKey) {
      return;
    }
    const controller = new AbortController();
    vectorAbortRef.current = controller;
    setPayloadState((current) =>
      current.requestKey === vectorKey && !current.failed
        ? current
        : { requestKey: vectorKey, payload: null, failed: false },
    );

    void fetchSynopticVectorPayload(frame, {
      signal: controller.signal,
      synopticDetailMode,
    })
      .then((payload) => {
        if (controller.signal.aborted || synopticVectorKeyRef.current !== vectorKey) {
          return;
        }
        markFrameSynopticVectorLoaded(frame, synopticDetailMode);
        setPayloadState({ requestKey: vectorKey, payload, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted && synopticVectorKeyRef.current === vectorKey) {
          setPayloadState({ requestKey: vectorKey, payload: null, failed: true });
        }
      });

    return () => controller.abort();
  }, [
    activeLayers,
    activeSynopticVectorKey,
    frame,
    frame?.hour,
    synopticDetailMode,
    synopticVectorKeyRef,
    vectorKey,
    vectorAbortRef,
  ]);

  return {
    normalizedSynopticVector,
    synopticVector,
    synopticVectorStatus,
  };
}

export function useSynopticVectorLayer({
  activeLayers,
  basemapTheme,
  engineRef,
  mapReady,
  showIsobars,
  showThickness,
  synopticVector,
}: UseSynopticVectorLayerArgs): void {
  // Geometry is built once per payload (normalize -> stitch -> smooth in
  // geographic space; the GPU clips, so no screen-space viewport culling);
  // presentation is the redesigned SYNOPTIC_LINE_STYLES above. The filtered
  // line/label ids stay mounted for as long as the synoptic parameter is active —
  // a frame change briefly nulls the payload while the next one fetches. One
  // combined collection feeds filtered style layers; visibility changes swap
  // filters (not sources/layers), keeping order and collision state stable.
  const nativeCollections = useMemo(() => buildSynopticFeatureCollections(synopticVector), [synopticVector]);
  const nativeCollection = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: [...nativeCollections.thickness.features, ...nativeCollections.isobars.features],
    }),
    [nativeCollections],
  );
  const sharedStyles = useMemo(() => {
    const line = {} as Record<keyof SynopticStyleClassCollections, LineLayerStyle>;
    const halo = {} as Record<keyof typeof SYNOPTIC_LINE_HALO_LAYER_IDS, LineLayerStyle>;
    const label = {} as Record<keyof typeof SYNOPTIC_LABEL_LAYER_IDS, SymbolLayerStyle>;
    for (const styleClass of SYNOPTIC_CLASS_ORDER) {
      const visible = styleClass.startsWith("thickness") ? showThickness : showIsobars;
      line[styleClass] = {
        ...SYNOPTIC_LINE_STYLES[basemapTheme][styleClass],
        sourceFamily: SYNOPTIC_SOURCE_FAMILY,
        sourceFilter: visible ? SYNOPTIC_CLASS_FILTERS[styleClass] : HIDDEN_SOURCE_FILTER,
      };
    }
    for (const haloClass of SYNOPTIC_HALO_ORDER) {
      halo[haloClass] = {
        ...SYNOPTIC_LINE_HALO_STYLES[basemapTheme][haloClass],
        sourceFamily: SYNOPTIC_SOURCE_FAMILY,
        sourceFilter: showIsobars ? SYNOPTIC_CLASS_FILTERS[haloClass] : HIDDEN_SOURCE_FILTER,
      };
    }
    for (const labelClass of SYNOPTIC_LABEL_ORDER) {
      const sourceClass = SYNOPTIC_LABEL_SOURCES[labelClass];
      const visible = sourceClass.startsWith("thickness") ? showThickness : showIsobars;
      label[labelClass] = {
        ...SYNOPTIC_LABEL_STYLES[basemapTheme][labelClass],
        sourceFamily: SYNOPTIC_SOURCE_FAMILY,
        sourceFilter: visible ? SYNOPTIC_CLASS_FILTERS[sourceClass] : HIDDEN_SOURCE_FILTER,
      };
    }
    return { halo, label, line };
  }, [basemapTheme, showIsobars, showThickness]);

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    if (!activeLayers.has("synoptic")) {
      removeSynopticLineLayers(engine);
      return;
    }
    // Ground-matched isobar halos first: bottom of the band, so they lift the
    // solid strokes off bright weather fills without dimming any line class
    // (every line layer stacks above them).
    for (const haloClass of SYNOPTIC_HALO_ORDER) {
      engine.setLineLayer(SYNOPTIC_LINE_HALO_LAYER_IDS[haloClass], nativeCollection, sharedStyles.halo[haloClass]);
    }
    for (const styleClass of SYNOPTIC_CLASS_ORDER) {
      engine.setLineLayer(SYNOPTIC_LINE_LAYER_IDS[styleClass], nativeCollection, sharedStyles.line[styleClass]);
    }
    // Value labels ride the same features, as symbol layers above the lines
    // (same call-order stacking rule; see SYNOPTIC_LABEL_STYLES). Like the
    // line ids, all label ids stay set while synoptic is active — empty
    // collections during frame-fetch gaps — so layer order and the collision
    // index stay stable through timeline playback.
    for (const labelClass of SYNOPTIC_LABEL_ORDER) {
      engine.setSymbolLayer(SYNOPTIC_LABEL_LAYER_IDS[labelClass], nativeCollection, sharedStyles.label[labelClass]);
    }
    // No per-run cleanup: deactivation is handled by the branch above, and
    // engine teardown (panel unmount) drops the layers wholesale.
  }, [activeLayers, engineRef, mapReady, nativeCollection, sharedStyles]);
}
