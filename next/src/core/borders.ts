import type { ViewKey } from "../types";

export type ReferenceBoundaryLayer = "country" | "admin1";

const boundaryCache = new Map<string, GeoJSON.FeatureCollection>();
const boundaryPending = new Map<string, Promise<GeoJSON.FeatureCollection | null>>();

export function fetchReferenceBoundaries(
  viewKey: ViewKey,
  layer: ReferenceBoundaryLayer,
): Promise<GeoJSON.FeatureCollection | null> {
  const cacheKey = `${viewKey}:${layer}`;
  const cached = boundaryCache.get(cacheKey);
  if (cached) {
    return Promise.resolve(cached);
  }
  const pending = boundaryPending.get(cacheKey);
  if (pending) {
    return pending;
  }
  const request = fetchGeoJSON(`/geo/boundaries/${viewKey}-${layer}.geojson`).then((data) => {
    if (data) {
      boundaryCache.set(cacheKey, data);
    }
    boundaryPending.delete(cacheKey);
    return data;
  });
  boundaryPending.set(cacheKey, request);
  return request;
}

function fetchGeoJSON(url: string): Promise<GeoJSON.FeatureCollection | null> {
  return (async () => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        return null;
      }
      const data = await resp.json();
      if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
        return null;
      }
      return data as GeoJSON.FeatureCollection;
    } catch {
      return null;
    }
  })();
}
