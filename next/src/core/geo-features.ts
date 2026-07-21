// Bundled map-feature data (built by scripts/prepare-map-geodata.js from US
// Census cartographic boundary files, committed under
// next/public/geo/features/). Fetched lazily when a feature is first enabled
// and cached module-wide so four panels share one parse. Roads and place
// labels are basemap-rendered since Task 6.3 — counties are the one remaining
// app-drawn detail feature (the basemap's own county lines stop at z14 tile
// detail; the app layer keeps the meteorologist-tuned fade curve).

export type GeoFeatureKey = "us-counties";

const featureCache = new Map<string, GeoJSON.FeatureCollection>();
const featurePending = new Map<string, Promise<GeoJSON.FeatureCollection | null>>();

export function fetchGeoFeature(key: GeoFeatureKey): Promise<GeoJSON.FeatureCollection | null> {
  const cached = featureCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const pending = featurePending.get(key);
  if (pending) {
    return pending;
  }
  const request = (async () => {
    try {
      const response = await fetch(`/geo/features/${key}.geojson`);
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as GeoJSON.FeatureCollection;
      if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) {
        return null;
      }
      featureCache.set(key, data);
      return data;
    } catch {
      return null;
    } finally {
      featurePending.delete(key);
    }
  })();
  featurePending.set(key, request);
  return request;
}
