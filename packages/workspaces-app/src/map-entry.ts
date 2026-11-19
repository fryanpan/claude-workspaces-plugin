/**
 * The entry `scripts/build.ts` builds into `/app/map/map.js`: Leaflet, fetched
 * by `mdx-street-map.ts` the first time a doc shows a `<StreetMap>`. No page
 * bundle imports this file, so a page with no map pays nothing for it.
 *
 * The drawing itself is the components package's (`components/src/draw.ts`),
 * the same code its map component draws with on a site.
 */
export {
  type KeyedBase,
  type MapDrawn,
  renderMapInto,
} from '@claude-workspaces/components/draw';
