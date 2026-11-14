/**
 * The street maps a `<StreetMap>` may draw under its data, and the one seam a
 * different provider plugs into.
 *
 * A doc names a basemap by key (`basemap="carto-light"`), never by URL, so the
 * origins a map loads tiles from are the ones listed here and nowhere else
 * (components design, decision 7: network origins come from a list the owner
 * controls, not from a doc). Adding a provider is one entry. A provider that
 * needs a key names it in `key`; the key itself is never written here or in a
 * doc. The server holds it and hands it only to a page whose doc draws a map
 * on that basemap (`routes/doc-map-key.ts`); with no key set, the map draws
 * on `fallback` and says so.
 *
 * Terms, read 13 Nov 2026:
 *  - `osm`: the OpenStreetMap Foundation's standard tiles. Free and keyless,
 *    attribution required, no bulk prefetch, and "heavy use" is not allowed
 *    (https://operations.osmfoundation.org/policies/tiles/). A board's doc
 *    readers are a handful of people, which is light use.
 *  - `carto-light`: CARTO's Positron raster tiles over OpenStreetMap data.
 *    Keyless; attribution to OpenStreetMap and CARTO required; free for
 *    non-commercial use up to 75,000 map views a month
 *    (https://github.com/CartoDB/basemap-styles#1-web-raster-basemaps).
 *  - `google`: Google's roadmap, drawn by the Maps JavaScript API under a
 *    browser key restricted to the board's site, and moved under Leaflet's
 *    layers by GoogleMutant (`map-entry.ts`). The API puts Google's logo and
 *    terms link on the map itself, as the terms require; billed per map load
 *    (https://cloud.google.com/maps-platform/terms).
 */

export interface Basemap {
  /** Shown in the source and in errors. */
  label: string;
  /** An XYZ tile template: `{z}/{x}/{y}`, and `{s}` for a subdomain. Empty
   *  for a provider whose own script draws the map (`script`). */
  tiles: string;
  /** The provider's map script, for one drawn by its own API rather than
   *  from XYZ tiles. The page adds the key the server handed it. */
  script?: string;
  subdomains?: string;
  /** The credit the provider's terms require, drawn in the map's corner.
   *  Leaflet writes it as HTML, which is why only this file supplies it. */
  attribution: string;
  maxZoom: number;
  /** Every origin the map's requests go to. `https://*.example.com` stands
   *  for any subdomain of it (`basemapAllows`). */
  origins: string[];
  /** The environment variable the server reads the provider's key from. */
  key?: string;
  /** The basemap drawn instead when the server holds no key. */
  fallback?: string;
  /** Where the provider's terms are. */
  terms: string;
}

const OSM_CREDIT =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

export const BASEMAPS: Readonly<Record<string, Basemap>> = Object.freeze({
  osm: {
    label: 'OpenStreetMap',
    tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_CREDIT,
    maxZoom: 19,
    origins: ['https://tile.openstreetmap.org'],
    terms: 'https://operations.osmfoundation.org/policies/tiles/',
  },
  'carto-light': {
    label: 'CARTO Positron',
    tiles: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    subdomains: 'abcd',
    attribution: `${OSM_CREDIT} &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>`,
    maxZoom: 20,
    origins: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com`),
    terms: 'https://github.com/CartoDB/basemap-styles#1-web-raster-basemaps',
  },
  google: {
    label: 'Google Maps',
    tiles: '',
    script: 'https://maps.googleapis.com/maps/api/js',
    // The script writes Google's own credit and logo onto the map.
    attribution: '',
    maxZoom: 21,
    // Google's list for the Maps JavaScript API, read 14 Nov 2026:
    // https://developers.google.com/maps/documentation/javascript/content-security-policy
    origins: [
      'https://*.googleapis.com',
      'https://*.gstatic.com',
      'https://*.google.com',
      'https://*.ggpht.com',
      'https://*.googleusercontent.com',
    ],
    key: 'CW_GOOGLE_MAPS_KEY',
    fallback: 'osm',
    terms: 'https://cloud.google.com/maps-platform/terms',
  },
});

/** The basemap a tag with no `basemap` prop draws on. */
export const DEFAULT_BASEMAP = 'osm';

export function basemapOf(name: string): Basemap | undefined {
  return Object.hasOwn(BASEMAPS, name) ? BASEMAPS[name] : undefined;
}

/** Whether `url` goes to one of the origins `base` lists. */
export function basemapAllows(base: Basemap, url: string): boolean {
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return false;
  }
  return base.origins.some((o) => {
    const wild = /^https:\/\/\*\.(.+)$/.exec(o);
    if (!wild) return o === at.origin;
    return at.protocol === 'https:' && !at.port && at.hostname.endsWith(`.${wild[1]}`);
  });
}
