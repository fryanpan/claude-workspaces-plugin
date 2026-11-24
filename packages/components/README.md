# @claude-workspaces/components

Components that run unchanged in a Claude Workspaces doc and on any site.
Today there is one: the street map a board doc's `<StreetMap>` draws, with
markers, popups, radius rings, category-coloured points and a legend, plus
GeoJSON line, polygon, circle and heatmap layers that a reader or the host
page can switch on and off.

A site mounts it from a JSON snapshot of its state and needs no Workspaces
server. In a board doc the same file runs with live state, so a write from an
agent or another reader redraws every open page.

## Install

The package is a tarball. It has no dependencies (Leaflet is bundled in), so
it installs offline from the file alone:

```bash
mkdir -p vendor && cp claude-workspaces-components-0.4.1.tgz vendor/
bun add ./vendor/claude-workspaces-components-0.4.1.tgz   # or npm install
```

Your `package.json` then names it as
`"@claude-workspaces/components": "file:./vendor/claude-workspaces-components-0.4.1.tgz"`.

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
  // cleanup() removes the map; cleanup.setVisible(id, on) switches a layer.
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
   `points` row, and any radius circles a `rings` entry in feet. Each GeoJSON
   source the old map drew as a line, fill or heatmap layer becomes a
   `layers` entry (below), keeping its file: pass its path as `url`.
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
| `layers` | GeoJSON layers, at most 24, drawn in the order given beneath the points and markers. See [Layers](#layers). |
| `rings` | Distances in feet (`150`), or `{ feet \| meters, color?, label? }`, at most 6. |
| `categories` | `{ name: "#hex" }` or `[{ name, color }]`: the legend's order and colours. |
| `center`, `zoom` | `[lat, lng]` and 1 to 20; without them the map fits its data. |
| `height` | Pixels, 160 to 1200; 480 by default. |
| `legend` | `false` hides the legend. |
| `title`, `subtitle`, `note` | Words above and below the map, as text. |
| `basemap` | `osm`, `carto-light` (drawn on OpenStreetMap) or `google`. See below. |
| `basemapKey` | The key for a basemap that needs one. |
| `id` | The state's id, which a refused write names. |

`lat`/`latitude` and `lng`/`lon`/`longitude` are all read. A map needs
`markers`, `points` or `layers`, in its props or its state; a prop it cannot
read draws a message in the map's place, not an exception.

## Layers

Each entry of `layers` is one GeoJSON layer. Its data is inline (`data`: a
FeatureCollection, a Feature, a list of Features or a bare geometry) or a
GeoJSON file the page fetches (`url`, a path on your site or an http(s)
URL, which your Content Security Policy's `connect-src` must allow). Every
layer takes:

| Field | What it is |
| --- | --- |
| `type` | `line`, `polygon`, `circle` or `heatmap`. |
| `data` or `url` | One of the two. |
| `id` | Unique on the map; `layer-<index>` without. |
| `name` | The words beside its switch under the map; its id without. |
| `visible` | `false` starts it switched off. |
| `minZoom`, `maxZoom` | Optional. The zooms it draws at, 0 to 24, both ends included; `minZoom` above `maxZoom` is refused. Outside the range the map takes the layer off, and puts it back when the zoom returns. Without them it draws at every zoom. |
| `popup` | Line, polygon and circle only. A template whose `{key}` is filled from the tapped feature's properties, as text: `"{name}: {speed} mph"`. Without it the layer takes no taps. |

A switch per layer sits under the map, in the order given, and the reader's
choice holds through every redraw. `legend: false` hides the switches with
the legend. A file that fails to load, or data that breaks a rule, is named
in that layer's row and the other layers still draw. A null geometry is
skipped; a geometry of another kind is refused, naming the feature.

**Line** (`LineString`, `MultiLineString`):

```ts
{
  type: 'line',
  id: 'paths',
  name: 'Riverbend paths',
  url: './riverbend-paths.geojson',
  color: '#ff725c',   // default #4269d0
  width: 3,           // pixels, 0.5 to 20; default 2
  opacity: 0.9,       // 0 to 1; default 0.9
  dash: [6, 4],       // optional; or "6 4"
  popup: '{name}: {speed} mph',
}
```

**Polygon** (`Polygon`, `MultiPolygon`):

```ts
{
  type: 'polygon',
  name: 'Saltmarsh quarter',
  data: { type: 'FeatureCollection', features: [/* … */] },
  fill: '#a463f2',     // default #4269d0
  fillOpacity: 0.25,   // 0 to 1; default 0.25
  outline: '#6d28d9',  // default: the fill
  outlineWidth: 1,     // pixels, 0 to 20; 0 draws no outline
  outlineOpacity: 0.9, // 0 to 1; default 0.9
  popup: 'Quarter: {name}',
}
```

**Circle** (`Point`, `MultiPoint`): one dot per position, a fixed number
of pixels across at every zoom.

```ts
{
  type: 'circle',
  id: 'reports',
  name: 'Riverbend reports',
  url: './riverbend-reports.geojson',
  fill: '#e11d48',     // default #4269d0
  fillOpacity: 0.8,    // 0 to 1; default 0.8
  stroke: '#ffffff',   // default #ffffff
  strokeWidth: 1,      // pixels, 0 to 20; 0 draws no stroke
  strokeOpacity: 1,    // 0 to 1; default 1
  radius: 5,           // pixels, 1 to 40; default 5
  popup: '{kind} on {date}',
  visible: false,      // starts switched off
}
```

**Heatmap** (`Point`, `MultiPoint`):

```ts
{
  type: 'heatmap',
  name: 'Harborlight reports',
  url: './harborlight-reports.geojson',
  weight: 'count',     // optional property; without it every point weighs 1,
                       // with it a missing or non-positive value weighs 0
  radius: 18,          // pixels, 2 to 80; default 18
  intensity: 1,        // 0.05 to 10; above 1 reaches the hot end sooner
  colors: ['#2563eb', '#22d3ee', '#a3e635', '#facc15', '#ef4444'], // 2 to 8, cold to hot
  opacity: 0.8,        // 0 to 1; default 0.8
}
```

Colours are hex, a CSS colour name, or `rgb()`/`hsl()`. Numbers past their
range are held at its edge.

**Zoom ranges.** The map follows its own zoom, so the page needs no zoom
listener. A heatmap that hands over to dots as the reader zooms in is two
layers over the same data:

```ts
layers: [
  { type: 'heatmap', id: 'heat', name: 'Harborlight reports', url, maxZoom: 13.75 },
  { type: 'circle', id: 'dots', name: 'Harborlight crashes', url, minZoom: 14 },
]
```

The map zooms in steps of 0.25, so a `maxZoom` of 13.75 and a `minZoom` of
14 never draw together; 14 and 14 would both draw at 14. The zoom range is
separate from the switch: a layer switched off stays off when the zoom
enters its range, and one switched on outside its range draws once the zoom
enters it. Its row under the map shows the switch, not the zoom.

**Switching from the page.** The handle `mount` and `mountWithSnapshot`
return is the cleanup function, and it also carries `setVisible(id, on)`.
It switches the layer with that `id` as the reader's switch would, for
every type and for inline data as well as `url` data, and the switch under
the map shows the new state. It works whether or not the switches are shown
(`legend: false`), and the choice holds through redraws until either the
reader or the page changes it. An id the map does not draw changes nothing
now; if a layer with that id arrives later, it starts the way the last call
said.

```ts
const map = mountWithSnapshot(el, { layers: [/* … { id: 'reports', … } */] });
toggle.addEventListener('change', () => map.setVisible('reports', toggle.checked));
```

**Order.** Line, polygon and circle layers draw in the order given, beneath
the points and markers, and a tap opens the popup of the topmost one under
it. A heatmap takes no taps. One listed before every line, polygon and
circle layer draws beneath them; one listed after any draws above all of
them and the points, still under the markers. A heatmap between two such
layers cannot sit between them.

**Caps.** A map draws at most 50,000 line and polygon features with
1,000,000 vertices between them, 20,000 circles (each position of a
`MultiPoint` counts) and 200,000 heatmap points. Paths draw on
one canvas and go on in chunks of 2,000 features a frame, so a big layer
fills in over a few frames rather than holding the page; heatmap points are
binned into cells half a radius wide before they are drawn. In headless
Chromium on an M-series Mac, 20,000 five-vertex lines and 18,523 heatmap
points drew with no task longer than 135 ms, including a zoom.

**In the state.** `layers` is a state key like `markers`. The state's limits
(eight levels deep, 256 KB) leave no room for GeoJSON inline, so a layer
written to the state names its file with `url`.

## State

Each of `markers`, `points`, `rings`, `categories`, `center`, `zoom`,
`title`, `subtitle`, `note` and `layers` that the state holds replaces the prop of the
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

`carto-light` draws on OpenStreetMap. CARTO's Positron tiles now need a CARTO
key and draw "API key required" on every tile without one, so the name is kept
only so that a map naming it still shows streets.

Every basemap's tiles come from the origins listed in the package, never from
a prop: `tile.openstreetmap.org` for `osm` and `carto-light`, and Google's Maps
JavaScript API origins for `google`. A
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

- 0.4.1: a map naming `carto-light` draws on OpenStreetMap, because CARTO
  now stamps "API key required" on every tile requested without a key. No
  page needs `cartocdn.com` in its Content Security Policy any more.
- 0.4.0: `minZoom` and `maxZoom` on every layer, so the map shows or
  hides it as the zoom crosses that range. A switch that turns a layer off
  now closes only that layer's open popup. Every 0.3.0 prop draws as
  before.
- 0.3.0: `circle` layers (a dot per point, with fill, stroke, radius,
  popup and `visible`), and `setVisible(id, on)` on the handle the map
  returns, which switches any layer from the host page and moves its switch
  under the map to match. Every 0.2.0 prop draws as before.
- 0.2.0: GeoJSON `layers` on the street map: `line`, `polygon` and
  `heatmap`, inline or by `url`, each with a switch under the map, popups
  from feature properties, and `layers` as a state key. Every 0.1.0 prop
  draws as before. The markers' SVG no longer takes a tap that lands between markers,
  so it reaches the points and layers beneath.
- 0.1.0: the street map (`./map`: default `mount`, `mountWithSnapshot`), the
  snapshot host (`mountFromSnapshot`, `snapshotState`), compiled `.js` with
  Leaflet 1.9.4 and GoogleMutant 0.15.0 bundled in, and `.d.ts`.

## Testing this package

```bash
bunx vitest run packages/components                          # unit and pack tests
CW_BROWSER_TESTS=1 bunx vitest run packages/components/test/static-page-browser.test.ts
CW_BROWSER_TESTS=1 bunx vitest run packages/components/test/layers-browser.test.ts
```

The browser test packs the tarball, installs it into a temporary folder and
draws the map on a plain HTML page in headless Chromium, with every tile
request answered locally.
