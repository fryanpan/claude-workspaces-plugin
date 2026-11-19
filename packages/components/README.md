# @claude-workspaces/components

Components that run unchanged in a Claude Workspaces doc and on any site.
Today there is one: the street map a board doc's `<StreetMap>` draws, with
markers, popups, radius rings, category-coloured points and a legend.

A site mounts it from a JSON snapshot of its state and needs no Workspaces
server. In a board doc the same file runs with live state, so a write from an
agent or another reader redraws every open page.

## Install

The package is a tarball. It has no dependencies (Leaflet is bundled in), so
it installs offline from the file alone:

```bash
mkdir -p vendor && cp claude-workspaces-components-0.1.0.tgz vendor/
bun add ./vendor/claude-workspaces-components-0.1.0.tgz   # or npm install
```

Your `package.json` then names it as
`"@claude-workspaces/components": "file:./vendor/claude-workspaces-components-0.1.0.tgz"`.

## Mount the map

With a bundler (Astro, Vite, esbuild):

```ts
import { mountWithSnapshot } from '@claude-workspaces/components/map';
import snapshot from './harborlight-map-state.json';

const el = document.getElementById('map');
if (el) {
  const cleanup = mountWithSnapshot(el, {
    id: 'map',
    title: 'Harborlight sites',
    markers: [{ lat: 37.761, lng: -122.441, label: 'Harborlight hall' }],
    rings: [150, 300],
  }, snapshot);
  // cleanup() removes the map.
}
```

On a page with no bundler, import the built file by path:

```html
<div id="map"></div>
<script type="module">
  import { mountWithSnapshot } from './node_modules/@claude-workspaces/components/lib/map.js';
  const snapshot = await (await fetch('./harborlight-map-state.json')).json();
  mountWithSnapshot(document.getElementById('map'), { markers: [] }, snapshot);
</script>
```

The map puts Leaflet's stylesheet and its own few rules on the page itself
the first time it draws, so there is nothing to link. The words around the
map (subtitle, note, notices) take `--cw-map-muted` as their colour.

## Replace a map already on your page

To switch a page whose map is drawn some other way:

1. Keep the element the old map drew into, and remove the code that started
   the old map (its `new Map(...)`, `L.map(...)` or equivalent) and the
   stylesheet and script tags it needed.
2. Move the old map's data into props: each pin becomes a `markers` row
   (`{ lat, lng, label?, popup?, category? }`), each dot of a dense layer a
   `points` row, and any radius circles a `rings` entry in feet.
3. Call `mountWithSnapshot(el, props, snapshot)` on that element. Pass the
   snapshot when the doc's map has state you want shown; leave it out to draw
   the props alone.
4. If the old map ran behind a switch, put the mount call behind the same
   switch and the old code on the other side, so either can be turned back on.

The element keeps its place on the page. The map sets its own height
(`height`, 480 pixels by default), so drop any fixed height the old map
needed on the element.

## Props

| Prop | What it is |
| --- | --- |
| `markers` | `[{ lat, lng, label?, popup?, category? }]`, at most 2,000. Each is a dot with a popup and every ring around it. |
| `points` | `[{ lat, lng, popup?, category? }]`, at most 50,000, small dots on one canvas. |
| `rings` | Distances in feet (`150`), or `{ feet \| meters, color?, label? }`, at most 6. |
| `categories` | `{ name: "#hex" }` or `[{ name, color }]`: the legend's order and colours. |
| `center`, `zoom` | `[lat, lng]` and 1 to 20; without them the map fits its data. |
| `height` | Pixels, 160 to 1200; 480 by default. |
| `legend` | `false` hides the legend. |
| `title`, `subtitle`, `note` | Words above and below the map, as text. |
| `basemap` | `osm`, `carto-light` or `google`. See below. |
| `basemapKey` | The key for a basemap that needs one. |
| `id` | The state's id, which a refused write names. |

`lat`/`latitude` and `lng`/`lon`/`longitude` are all read. A map needs
`markers` or `points`, in its props or its state; a prop it cannot read
draws a message in the map's place, not an exception.

## State

Each of `markers`, `points`, `rings`, `categories`, `center`, `zoom`,
`title`, `subtitle` and `note` that the state holds replaces the prop of the
same name, and the map redraws whenever the state changes. The view moves
only when what it frames changes, so a title edit leaves a reader's pan
alone. Layout and basemap stay props.

On a site the state is the snapshot: the JSON `get_component_state` returns
for the doc's map, saved beside the page. `mountWithSnapshot` gives the map a
hook over a copy of it. Writes through that hook (`set`, `push`, `delete`)
redraw the page and reach no doc. `snapshotState` and `mountFromSnapshot`
are exported too, for a host that keeps the hook itself.

In a board doc the doc page hands the map a live hook instead:

```mdx
import CwMap from './components/claude-workspaces-components/lib/map.js'

<CwMap id="map" title="Harborlight sites" markers={[{ lat: 37.761, lng: -122.441 }]} />
```

with the unpacked tarball in a folder that holds a `component.json`.

## Basemap and key

With no `basemap` prop the map draws on OpenStreetMap, which needs no key, or
on Google's roadmap when you pass `basemapKey`. Name a basemap to choose it.

Google's key is a browser key: restrict it to your site's hostnames in the
Google Cloud console, because the page hands it to Google in the open. A map
that names `google` and has no key draws on OpenStreetMap and says so under
the map; one whose key Google refuses does the same.

Every basemap's tiles come from the origins listed in the package, never from
a prop: `tile.openstreetmap.org` for `osm`, `{a,b,c,d}.basemaps.cartocdn.com`
for `carto-light`, and Google's Maps JavaScript API origins for `google`. A
site with a Content Security Policy allows those in `img-src` (and, for
Google, `script-src` and `connect-src`). OpenStreetMap's tiles are for light
use and need the credit the map shows
(https://operations.osmfoundation.org/policies/tiles/).

## Versions

It is distributed as a tarball, `claude-workspaces-components-<version>.tgz`,
built from the claude-workspaces repo with
`bun run --cwd packages/components pack <outDir>`. A site names it in its
`package.json` and moves to a new version by replacing the tarball and that
line.

- 0.1.0: the street map (`./map`: default `mount`, `mountWithSnapshot`), the
  snapshot host (`mountFromSnapshot`, `snapshotState`), compiled `.js` with
  Leaflet 1.9.4 and GoogleMutant 0.15.0 bundled in, and `.d.ts`.

## Testing this package

```bash
bunx vitest run packages/components                          # unit and pack tests
CW_BROWSER_TESTS=1 bunx vitest run packages/components/test/static-page-browser.test.ts
```

The browser test packs the tarball, installs it into a temporary folder and
draws the map on a plain HTML page in headless Chromium, with every tile
request answered locally.
