import { useEffect, useRef, type RefObject } from "react";
import type { MapDisplaySettings } from "../../config/display";
import { COUNTY_LINE_LAYER_ID, GRATICULE_LINE_LAYER_ID } from "../../config/layers";
import { fetchGeoFeature } from "../../core/geo-features";
import type { LineLayerStyle, MapEngine, ZoomCurve } from "../../core/map-engine/types";

interface UseMapFeatureLayersArgs {
  display: MapDisplaySettings;
  mapReady: boolean;
  mapZoom: number;
  engineRef: RefObject<MapEngine | null>;
}

// County lines are reference detail: invisible at synoptic scale, fading in
// as the map reaches state/metro zooms. All zoom stops/thresholds in this
// hook are NATIVE maplibre zoom (Task 6.2) — every value below is the old
// leaflet-scale number minus 1, the same ground scale. Same math as the old
// inline countyOpacity(): 0 below native z5 (old z6), then
// 0.12 + (zoom - 5) * 0.09 capped at 0.4. The x.999 stop encodes the old
// step edge (0 for zoom < 5, 0.12 at exactly z5); the 0.001-wide ramp is
// visually unobservable even at maplibre's fractional zooms. The last stop
// is where the 0.09/zoom slope meets the cap.
const COUNTY_OPACITY_CURVE: ZoomCurve = [
  [4.999, 0],
  [5, 0.12],
  [5 + 0.28 / 0.09, 0.4],
];

// Stroke weights stay hook-side: LineLayerStyle.weight is a plain number, so
// the zoom-keyed values are re-submitted by the restyle effects below.
function countyWeight(zoom: number): number {
  return zoom >= 8 ? 0.7 : 0.5;
}

// Counties join the graticule's detail band: the engine derives each layer's
// within-band slot from the anchor + id (LINE_LAYER_BAND_RANK).
function countyLineStyle(color: string, weight: number): LineLayerStyle {
  return { color, weight, opacity: COUNTY_OPACITY_CURVE, group: "boundaries", anchor: "graticule" };
}

const GRATICULE_STYLE: LineLayerStyle = {
  color: "#94a3b8",
  weight: 0.5,
  opacity: 0.3,
  dashArray: [2, 5],
  group: "boundaries",
  anchor: "graticule",
};

// Degree spacing for the graticule by (native) zoom: coarse at CONUS scale,
// 1° when zoomed to metro scale.
function graticuleSpacing(zoom: number): number {
  if (zoom < 3.5) {
    return 10;
  }
  if (zoom < 5.5) {
    return 5;
  }
  if (zoom < 7.5) {
    return 2;
  }
  return 1;
}

export function useMapFeatureLayers({ display, mapReady, mapZoom, engineRef }: UseMapFeatureLayersArgs): void {
  // Feature collection currently pushed to the engine; the restyle effect
  // re-submits the SAME reference so the engine restyles in place instead of
  // re-parsing geometry.
  const countyDataRef = useRef<GeoJSON.FeatureCollection | null>(null);

  // Roads/cities Display toggles ride the basemap (decision #5 of the
  // MapLibre migration): the vector basemap renders its own road network and
  // ranked place labels, so the app only flips their visibility.
  useEffect(() => {
    if (!mapReady) {
      return;
    }
    engineRef.current?.setBasemapDetail({ roads: display.features.roads, cities: display.features.cities });
  }, [display.features.cities, display.features.roads, engineRef, mapReady]);

  // ── County lines ──
  useEffect(() => {
    if (!mapReady || !display.features.counties) {
      return;
    }
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    let cancelled = false;
    void fetchGeoFeature("us-counties").then((data) => {
      if (cancelled || !data || !engineRef.current) {
        return;
      }
      // Creation weight is the base 0.5, as the old hook hard-coded it; the
      // restyle effect below applies the zoom-keyed weight from the next
      // zoom/color change on.
      engineRef.current.setLineLayer(COUNTY_LINE_LAYER_ID, data, countyLineStyle(display.boundaries.color, 0.5));
      countyDataRef.current = data;
    });
    return () => {
      cancelled = true;
      engineRef.current?.removeLayer(COUNTY_LINE_LAYER_ID);
      countyDataRef.current = null;
    };
    // Color changes restyle via the effect below; recreating on color change
    // would re-parse 1 MB of counties for a stroke tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display.features.counties, mapReady, engineRef]);

  useEffect(() => {
    if (!countyDataRef.current) {
      return;
    }
    engineRef.current?.setLineLayer(
      COUNTY_LINE_LAYER_ID,
      countyDataRef.current,
      countyLineStyle(display.boundaries.color, countyWeight(mapZoom)),
    );
  }, [display.boundaries.color, engineRef, mapZoom]);

  // ── Lat/lon graticule ──
  // Keyed on the SPACING BUCKET, not raw zoom: zoom changes within a bucket
  // leave the ~120-line collection untouched instead of tearing it down and
  // rebuilding on every zoom step.
  const graticuleSpacingDeg = display.features.graticule ? graticuleSpacing(mapZoom) : 0;
  useEffect(() => {
    if (!mapReady || graticuleSpacingDeg <= 0) {
      return;
    }
    const engine = engineRef.current;
    if (!engine) {
      return;
    }
    engine.setLineLayer(GRATICULE_LINE_LAYER_ID, buildGraticule(graticuleSpacingDeg), GRATICULE_STYLE);
    return () => {
      engineRef.current?.removeLayer(GRATICULE_LINE_LAYER_ID);
    };
  }, [engineRef, graticuleSpacingDeg, mapReady]);
}

// Procedural graticule as GeoJSON: one LineString per meridian/parallel with
// the same extents as the old L.polyline grid (meridians clipped to ±85°
// lat, parallels spanning ±80° lat).
function buildGraticule(spacingDeg: number): GeoJSON.FeatureCollection {
  const line = (coordinates: [number, number][]): GeoJSON.Feature => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates },
  });
  const features: GeoJSON.Feature[] = [];
  for (let lon = -180; lon <= 180; lon += spacingDeg) {
    features.push(
      line([
        [lon, -85],
        [lon, 85],
      ]),
    );
  }
  for (let lat = -80; lat <= 80; lat += spacingDeg) {
    features.push(
      line([
        [-180, lat],
        [180, lat],
      ]),
    );
  }
  return { type: "FeatureCollection", features };
}
