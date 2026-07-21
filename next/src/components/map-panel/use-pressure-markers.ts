import { useEffect, useMemo, type RefObject } from "react";
import type { BasemapInkTheme } from "../../config/display";
import { SYNOPTIC_CENTER_LAYER_IDS } from "../../config/layers";
import type { GeoJsonSourceFilter, MapEngine, SymbolLayerStyle, ZoomCurve } from "../../core/map-engine/types";
import type { LayerKey, SynopticCenters } from "../../types";
import { buildSynopticCenterFeatureCollections, resolveSynopticCenters } from "./synoptic-geojson";

// ── Native GL H/L pressure centers (Task 4.3 REDESIGN) ───────────────────────
// H/L glyphs with the pressure value beneath, rendered as two engine symbol
// layers (one per kind — a symbol layer has one text color) and placed by
// MapLibre's collision engine, which replaced the old renderer's screen-space
// declutter (per-bucket max-marker caps, min-spacing loops, edge buffers) —
// feature-level priority travels as symbol-sort-key (deepest anomaly first,
// see synoptic-geojson's SORT KEY note) and the collision engine owns
// density. No max-marker cap is reapplied: every center the collision engine
// can place legibly renders, so synoptic scales cannot silently lose a real
// center to an arbitrary budget.
//
// Visual design vs the retired leaflet divIcons (.pressure-marker CSS):
// - Colors keep the semantic convention analysts see today (blue-ish HIGH,
//   red LOW), per basemap theme (Task 4.3r3). DARK ground: HIGH cyan-blue
//   #59D8FF, LOW red #FF5858 (index.css .pressure-high/.pressure-low), with
//   the same dark-chrome halo tone the CSS text-shadow used, sized up (2 px)
//   for legibility over bright reflectivity/CAPE fills. LIGHT ground: the
//   cyan washes out on near-white, so HIGH deepens to #0072B2 (the
//   colorblind-safe blue the leaflet marker CSS already uses as its default
//   ink) and LOW to #C62828, both over a white cutout halo.
// - The value renders BENEATH the glyph (surface-analysis convention) at
//   half the glyph size — the old divIcon put it above; flagged for the
//   owner eyeball as a deliberate redesign choice. Glyph+value are one
//   ["format"] text, so the pair places/collides/drops atomically.
// - Glyph sizes mirror the old centers.letterSizePxByBucket (20/24/28/32
//   across the legacy leaflet-scale buckets z0_3/z4_6/z7_9/z10_12) as a
//   NATIVE-domain ZoomCurve (stops = legacy bucket anchors − 1, Task 6.2);
//   the 0.5 secondary scale lands the value text at 10/12/14/16 px, matching
//   the old valueSizePxByBucket (+1) within a pixel.
// - Lows stack ABOVE highs (set later): MapLibre resolves cross-layer
//   collisions top-down, and in a contested spot the low is the feature a
//   forecaster cannot afford to lose.
// - Centers ride the "centers" anchor band — ABOVE the basemap symbol stack
//   (Task 4.3 owner round, spec §8a.3). App symbol bands sit below the
//   basemap labels, and MapLibre places collisions top-down, so a basemap
//   city label used to claim its box FIRST and silently suppress a
//   coinciding H/L center. In the top band the centers place first: the
//   center always renders and the CITY LABEL is the one suppressed. Centers
//   still collide among themselves (deepest-anomaly sortKey wins), which is
//   the meteorologically correct thinning. They keep the "synoptic" opacity
//   group — the Display slider dims them with the rest of the overlay.
// Both layers stay set while synoptic is active. During a vector fetch the
// manifest roster remains visible; only an authoritative resolved payload
// may replace it with present-empty. Hidden centers still use empty
// collections so layer order and the collision index stay stable.
const CENTER_GLYPH_SIZE: ZoomCurve = [
  [1, 20],
  [4, 24],
  [7, 28],
  [10, 32],
];

function centerSymbolStyle(color: string, haloColor: string): SymbolLayerStyle {
  return {
    textProperty: "label",
    secondaryTextProperty: "valueText",
    secondaryTextScale: 0.5,
    textSize: CENTER_GLYPH_SIZE,
    color,
    haloColor,
    haloWidth: 2,
    sortKeyProperty: "sortKey",
    placement: "point",
    opacity: 0.95,
    group: "synoptic",
    anchor: "centers",
  };
}

const CENTER_SYMBOL_STYLES: Record<BasemapInkTheme, { high: SymbolLayerStyle; low: SymbolLayerStyle }> = {
  dark: {
    high: centerSymbolStyle("#59D8FF", "rgba(4, 11, 18, 0.9)"),
    low: centerSymbolStyle("#FF5858", "rgba(4, 11, 18, 0.9)"),
  },
  light: {
    high: centerSymbolStyle("#0072B2", "rgba(255, 255, 255, 0.92)"),
    low: centerSymbolStyle("#C62828", "rgba(255, 255, 255, 0.92)"),
  },
};

const CENTER_SOURCE_FAMILY = "synoptic-centers";
const HIGH_CENTER_FILTER: GeoJsonSourceFilter = ["==", ["get", "kind"], "high"];
const LOW_CENTER_FILTER: GeoJsonSourceFilter = ["==", ["get", "kind"], "low"];
const HIDDEN_CENTER_FILTER: GeoJsonSourceFilter = ["==", ["get", "kind"], "__hidden__"];

interface UsePressureMarkersArgs {
  activeLayers: Set<LayerKey>;
  // Active basemap ink theme (from the panel's display settings): selects the
  // per-theme H/L ink set above.
  basemapTheme: BasemapInkTheme;
  // The panel's MapEngine; H/L centers render natively via setSymbolLayer.
  engineRef: RefObject<MapEngine | null>;
  frameSynopticCenters: SynopticCenters | null | undefined;
  mapReady: boolean;
  normalizedSynopticCenters: SynopticCenters | null | undefined;
  showCenters: boolean;
}

export function usePressureMarkers({
  activeLayers,
  basemapTheme,
  engineRef,
  frameSynopticCenters,
  mapReady,
  normalizedSynopticCenters,
  showCenters,
}: UsePressureMarkersArgs): void {
  const centerCollections = useMemo(
    () =>
      buildSynopticCenterFeatureCollections(
        resolveSynopticCenters(normalizedSynopticCenters, frameSynopticCenters || null),
      ),
    [frameSynopticCenters, normalizedSynopticCenters],
  );
  const centerCollection = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: [...centerCollections.highs.features, ...centerCollections.lows.features],
    }),
    [centerCollections],
  );
  const centerStyles = useMemo(
    () => ({
      high: {
        ...CENTER_SYMBOL_STYLES[basemapTheme].high,
        sourceFamily: CENTER_SOURCE_FAMILY,
        sourceFilter: showCenters ? HIGH_CENTER_FILTER : HIDDEN_CENTER_FILTER,
      },
      low: {
        ...CENTER_SYMBOL_STYLES[basemapTheme].low,
        sourceFamily: CENTER_SOURCE_FAMILY,
        sourceFilter: showCenters ? LOW_CENTER_FILTER : HIDDEN_CENTER_FILTER,
      },
    }),
    [basemapTheme, showCenters],
  );

  useEffect(() => {
    if (!mapReady) {
      return;
    }
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    if (!activeLayers.has("synoptic")) {
      engine.removeLayer(SYNOPTIC_CENTER_LAYER_IDS.high);
      engine.removeLayer(SYNOPTIC_CENTER_LAYER_IDS.low);
      return;
    }
    // Highs first, lows last == lows on top (see the design note above).
    engine.setSymbolLayer(SYNOPTIC_CENTER_LAYER_IDS.high, centerCollection, centerStyles.high);
    engine.setSymbolLayer(SYNOPTIC_CENTER_LAYER_IDS.low, centerCollection, centerStyles.low);
    // No per-run cleanup: deactivation is the branch above; engine teardown
    // (panel unmount) drops the layers wholesale.
  }, [activeLayers, centerCollection, centerStyles, engineRef, mapReady]);
}
