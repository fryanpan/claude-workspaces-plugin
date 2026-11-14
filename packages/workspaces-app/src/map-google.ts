/**
 * Google's roadmap under a `<StreetMap basemap="google">`, built into the map
 * chunk beside Leaflet (`map-entry.ts`), so a page with no Google map loads
 * none of it and asks Google for nothing.
 *
 * The map is drawn by Google's Maps JavaScript API, loaded once per page with
 * the browser key the server handed this doc (`routes/doc-map-key.ts`).
 * GoogleMutant moves the tiles the API draws into a Leaflet layer, so the
 * markers, rings, points, popups and legend are the same Leaflet code every
 * other basemap uses, and Google's logo and terms link are moved into the
 * map's corners. GoogleMutant 0.15 is the last release for Leaflet 1; it
 * reads a global `L`, which `leaflet-global.ts` sets before it loads.
 *
 * A key Google refuses (`gm_authFailure`) or a script that does not load
 * swaps the map onto its fallback basemap, and the caller says so under it.
 */
import './leaflet-global.ts';
// Its `module` entry by path: the package names no `main`, so vitest's
// resolver finds no entry for the bare name.
import 'leaflet.gridlayer.googlemutant/src/Leaflet.GoogleMutant.mjs';
import L from 'leaflet';

/** What GoogleMutant adds to Leaflet; it ships no types. */
interface MutantFactory {
  googleMutant(options: { type: 'roadmap'; maxZoom: number }): L.GridLayer;
}

const READY_CALLBACK = '__cwGoogleMapsReady';

interface GoogleWindow {
  google?: { maps?: { importLibrary?: (name: string) => Promise<unknown> } };
  gm_authFailure?: () => void;
  [READY_CALLBACK]?: () => void;
}

/** How long Google's script has to call back before the map falls back. */
const LOAD_MS = 15_000;

// One load per page, under the first key it was asked with. A server holds
// one key, so a rotated key reaches a page on its next load.
let loading: Promise<void> | null = null;
const refused = new Set<() => void>();
let wasRefused = false;

/** Load the Maps JavaScript API once per page. */
function loadGoogle(script: string, key: string): Promise<void> {
  if (loading) return loading;
  const w = window as unknown as GoogleWindow;
  w.gm_authFailure = () => {
    wasRefused = true;
    for (const f of refused) f();
    refused.clear();
  };
  loading = new Promise<void>((resolve, reject) => {
    const tag = document.createElement('script');
    // A failed load is forgotten, so the next map on the page tries again.
    const failed = () => {
      clearTimeout(late);
      tag.remove();
      loading = null;
      reject(new Error('did not load'));
    };
    const late = setTimeout(failed, LOAD_MS);
    w[READY_CALLBACK] = () => {
      const lib = w.google?.maps?.importLibrary;
      const ready = () => {
        clearTimeout(late);
        resolve();
      };
      if (lib) lib('maps').then(ready, failed);
      else ready();
    };
    const url = new URL(script);
    url.searchParams.set('key', key);
    url.searchParams.set('v', 'weekly');
    url.searchParams.set('loading', 'async');
    url.searchParams.set('callback', READY_CALLBACK);
    tag.src = url.href;
    tag.async = true;
    tag.dataset.cwGoogleMaps = '';
    tag.onerror = failed;
    document.head.appendChild(tag);
  });
  return loading;
}

/**
 * Put Google's roadmap under `map` once the API has loaded. `fallBack` runs at
 * most once, with the reason, if Google cannot draw it; the caller then draws
 * the fallback basemap.
 */
export function addGoogleLayer(
  map: L.Map,
  script: string,
  key: string,
  maxZoom: number,
  fallBack: (why: 'refused' | 'unloaded') => void,
): void {
  let done = false;
  let layer: L.GridLayer | null = null;
  const fail = (why: 'refused' | 'unloaded') => {
    if (done) return;
    done = true;
    refused.delete(onRefused);
    if (layer) map.removeLayer(layer);
    fallBack(why);
  };
  const onRefused = () => fail('refused');
  if (wasRefused) {
    onRefused();
    return;
  }
  refused.add(onRefused);
  map.once('unload', () => {
    done = true;
    refused.delete(onRefused);
  });
  loadGoogle(script, key).then(
    () => {
      // Redrawn away while the script loaded: a Google map built now would
      // be a billed load nobody sees.
      if (done || !map.getContainer().isConnected) {
        done = true;
        refused.delete(onRefused);
        return;
      }
      layer = (L.gridLayer as unknown as MutantFactory).googleMutant({ type: 'roadmap', maxZoom });
      layer.addTo(map);
    },
    () => fail('unloaded'),
  );
}

/** Forget the page's loaded API, so a test starts from a page without it. */
export function resetGoogleForTest(): void {
  loading = null;
  wasRefused = false;
  refused.clear();
}
