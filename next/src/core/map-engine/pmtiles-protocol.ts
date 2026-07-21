// Module-singleton registration of the pmtiles:// protocol with MapLibre.
// ONE Protocol instance backs every map in the app, so all panels share the
// same PMTiles header/directory caches for the (identical) basemap archive
// instead of re-fetching them per panel. MapLibre's protocol registry is
// itself global, so re-registering per map would also silently discard the
// previous instance's caches.
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

let protocolInstance: Protocol | null = null;

export function ensurePmtilesProtocol(): void {
  if (protocolInstance) {
    return;
  }
  protocolInstance = new Protocol();
  maplibregl.addProtocol("pmtiles", protocolInstance.tile);
}

// Drop the shared Protocol's cached PMTiles instance for one archive URL
// (plain http(s) form, no pmtiles:// prefix — the Protocol keys instances on
// the stripped URL). Needed by the basemap-fatal retry (Task 5.2): pmtiles
// 4.4 caches the header fetch as a promise inside the instance and NEVER
// evicts a rejection, so after one failed boot every future source load
// re-rejects instantly from cache without touching the network — a recovered
// artifact server could never un-stick the panel. Deleting the instance
// forces the next source load to build a fresh one and re-fetch. Only the
// retry path calls this; normal theme switches keep the warm shared caches.
export function resetPmtilesArchive(url: string): void {
  // CAUTION: `Protocol.tiles` is marked @hidden in pmtiles' d.ts (typed, so a
  // rename fails typecheck loudly) — re-verify this line on any pmtiles/v6 bump.
  protocolInstance?.tiles.delete(url);
}
