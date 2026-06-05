import L, { type Map as LeafletMap } from "leaflet";

interface MapWithCanvasRenderers extends LeafletMap {
  __wxCanvasRenderers?: Map<string, L.Renderer>;
}

export function getPaneCanvasRenderer(map: LeafletMap, pane: string): L.Renderer {
  const host = map as MapWithCanvasRenderers;
  host.__wxCanvasRenderers = host.__wxCanvasRenderers || new Map<string, L.Renderer>();
  const existing = host.__wxCanvasRenderers.get(pane);
  if (existing) {
    return existing;
  }
  const renderer = L.canvas({
    pane,
    padding: 0.35,
  });
  host.__wxCanvasRenderers.set(pane, renderer);
  return renderer;
}
