import type { ImageOverlay, Map as LeafletMap, Marker } from "leaflet";
import {
  COUNTRY_BORDERS_PANE,
  COUNTRY_BORDERS_Z_INDEX,
  DYNAMIC_PARAMETER_PANE,
  getLayerPane,
  getLayerZIndex,
  HEIGHT_CONTOUR_PANE,
  HEIGHT_CONTOUR_Z_INDEX,
  LABELS_PANE,
  LABELS_Z_INDEX,
  LAYER_STACK_ORDER,
  STATE_BORDERS_PANE,
  STATE_BORDERS_Z_INDEX,
  SYNOPTIC_ISOBAR_PANE,
  SYNOPTIC_ISOBAR_Z_INDEX,
  SYNOPTIC_MARKER_PANE,
  SYNOPTIC_MARKER_Z_INDEX,
  SYNOPTIC_THICKNESS_PANE,
  SYNOPTIC_THICKNESS_Z_INDEX,
  WEATHER_VECTOR_PANE,
  WEATHER_VECTOR_Z_INDEX,
} from "../../config/layers";
import type { LayerKey } from "../../types";

export function ensureLayerPanes(map: LeafletMap): void {
  for (const layerKey of LAYER_STACK_ORDER) {
    const paneName = getLayerPane(layerKey);
    const pane = map.getPane(paneName) || map.createPane(paneName);
    pane.style.zIndex = String(getLayerZIndex(layerKey));
    pane.style.pointerEvents = "none";
  }
  const dynamicPane = map.getPane(DYNAMIC_PARAMETER_PANE) || map.createPane(DYNAMIC_PARAMETER_PANE);
  dynamicPane.style.zIndex = String(getLayerZIndex("__dynamic__"));
  dynamicPane.style.pointerEvents = "none";
  const heightContourPane = map.getPane(HEIGHT_CONTOUR_PANE) || map.createPane(HEIGHT_CONTOUR_PANE);
  heightContourPane.style.zIndex = String(HEIGHT_CONTOUR_Z_INDEX);
  heightContourPane.style.pointerEvents = "none";
  const weatherVectorPane = map.getPane(WEATHER_VECTOR_PANE) || map.createPane(WEATHER_VECTOR_PANE);
  weatherVectorPane.style.zIndex = String(WEATHER_VECTOR_Z_INDEX);
  weatherVectorPane.style.pointerEvents = "none";
  const thicknessPane = map.getPane(SYNOPTIC_THICKNESS_PANE) || map.createPane(SYNOPTIC_THICKNESS_PANE);
  thicknessPane.style.zIndex = String(SYNOPTIC_THICKNESS_Z_INDEX);
  thicknessPane.style.pointerEvents = "none";

  const isobarPane = map.getPane(SYNOPTIC_ISOBAR_PANE) || map.createPane(SYNOPTIC_ISOBAR_PANE);
  isobarPane.style.zIndex = String(SYNOPTIC_ISOBAR_Z_INDEX);
  isobarPane.style.pointerEvents = "none";

  const markerPane = map.getPane(SYNOPTIC_MARKER_PANE) || map.createPane(SYNOPTIC_MARKER_PANE);
  markerPane.style.zIndex = String(SYNOPTIC_MARKER_Z_INDEX);
  markerPane.style.pointerEvents = "none";

  const stateBordersPane = map.getPane(STATE_BORDERS_PANE) || map.createPane(STATE_BORDERS_PANE);
  stateBordersPane.style.zIndex = String(STATE_BORDERS_Z_INDEX);
  stateBordersPane.style.pointerEvents = "none";

  const countryBordersPane = map.getPane(COUNTRY_BORDERS_PANE) || map.createPane(COUNTRY_BORDERS_PANE);
  countryBordersPane.style.zIndex = String(COUNTRY_BORDERS_Z_INDEX);
  countryBordersPane.style.pointerEvents = "none";

  const labelsPane = map.getPane(LABELS_PANE) || map.createPane(LABELS_PANE);
  labelsPane.style.zIndex = String(LABELS_Z_INDEX);
  labelsPane.style.pointerEvents = "none";
}

export function clearSynopticMarkers(markers: Marker[], map: LeafletMap): void {
  for (const marker of markers) {
    map.removeLayer(marker);
  }
}

export function syncOverlayBounds(overlays: Map<LayerKey, ImageOverlay>): void {
  for (const overlay of overlays.values()) {
    const current = overlay.getBounds();
    if (current) {
      overlay.setBounds(current);
    }
  }
}
