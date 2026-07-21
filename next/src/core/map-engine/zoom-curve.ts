// ZoomCurve helpers. Curves live in the NATIVE MapLibre zoom domain (the
// app-wide zoom unit since Task 6.2); the engine compiles them into
// ["interpolate"] expressions and also evaluates them here for
// __introspect().lineLayerOpacity.
import type { ZoomCurve } from "./types";

// Piecewise-linear ZoomCurve evaluation over the native zoom domain, clamped
// to the end stops. Zoom is continuous — fractional inputs interpolate
// linearly between stops, no integer snapping anywhere in this walk.
export function evalZoomCurve(curve: ZoomCurve, zoom: number): number {
  if (curve.length === 0) {
    // Callers should never submit an empty curve; if one slips through,
    // fully visible beats an invisible layer with no error signal.
    return 1;
  }
  // The piecewise walk below assumes stops ascend by zoom; a mis-ordered
  // caller curve would silently evaluate garbage, so sort a copy first.
  let stops = curve;
  for (let i = 1; i < stops.length; i += 1) {
    if (stops[i][0] < stops[i - 1][0]) {
      stops = [...curve].sort((a, b) => a[0] - b[0]);
      break;
    }
  }
  const first = stops[0];
  if (zoom <= first[0]) {
    return first[1];
  }
  for (let i = 1; i < stops.length; i += 1) {
    const [z1, v1] = stops[i];
    if (zoom <= z1) {
      const [z0, v0] = stops[i - 1];
      const t = z1 === z0 ? 1 : (zoom - z0) / (z1 - z0);
      return v0 + (v1 - v0) * t;
    }
  }
  return stops[stops.length - 1][1];
}

// Stops sorted ascending by zoom with exact-duplicate zooms collapsed to the
// LAST value — maplibre's ["interpolate"] rejects non-strictly-ascending
// inputs, and keeping the later stop mirrors evalZoomCurve's t=1 resolution
// at coincident stops.
export function normalizedZoomStops(curve: ZoomCurve): ZoomCurve {
  const sorted = [...curve].sort((a, b) => a[0] - b[0]);
  const out: ZoomCurve = [];
  for (const stop of sorted) {
    if (out.length > 0 && out[out.length - 1][0] === stop[0]) {
      out[out.length - 1] = stop;
    } else {
      out.push(stop);
    }
  }
  return out;
}
