/**
 * The entry `scripts/build.ts` builds into `/app/map/map.js`: Leaflet and the
 * components package's map, fetched by `mdx-street-map.ts` the first time a
 * doc shows a `<StreetMap>`. No page bundle imports this file, so a page with
 * no map pays nothing for it.
 *
 * The map is the components package's own mount (`components/src/map.ts`),
 * the same file a site mounts, so a board doc and a site draw one map with
 * one legend, one basemap fallback and one live state hook.
 */
export { type MapHandle, default as mountMap } from '@claude-workspaces/components/map';
