/**
 * The street maps a `<StreetMap>` may draw under its data, and the one seam a
 * different provider plugs into.
 *
 * A doc names a basemap by key (`basemap="carto-light"`), never by URL, so the
 * origins a map loads tiles from are the ones listed here and nowhere else
 * (components design, decision 7: network origins come from a list the owner
 * controls, not from a doc). Adding a provider is one entry. A provider that
 * needs a key names it in `key`; the key itself is never written here or in a
 * doc. No entry needs one today.
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
 */

export interface Basemap {
  /** Shown in the source and in errors. */
  label: string;
  /** An XYZ tile template: `{z}/{x}/{y}`, and `{s}` for a subdomain. */
  tiles: string;
  subdomains?: string;
  /** The credit the provider's terms require, drawn in the map's corner.
   *  Leaflet writes it as HTML, which is why only this file supplies it. */
  attribution: string;
  maxZoom: number;
  /** Every origin a tile request goes to. */
  origins: string[];
  /** The name of a server-held key the provider needs; none needs one yet. */
  key?: string;
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
});

/** The basemap a tag with no `basemap` prop draws on. */
export const DEFAULT_BASEMAP = 'osm';

export function basemapOf(name: string): Basemap | undefined {
  return Object.hasOwn(BASEMAPS, name) ? BASEMAPS[name] : undefined;
}
