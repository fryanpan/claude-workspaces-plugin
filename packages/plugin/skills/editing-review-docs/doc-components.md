# Charts and maps in an `.mdx` doc

Two tags draw in a bound `.mdx` doc with no import and no build:
`<PlotChart>` for a chart and `<StreetMap>` for a street map. Both draw in
the doc page itself, not in a frame, so a reader can comment beside them and
they follow the board's theme. Write the tag on its own lines, with a blank
line before and after, through the edit tools like any other block
(`insert_blocks_after_thread`, `insert_blocks_under_heading`,
`find_and_replace`). The `.md` fallback does not draw them; the doc's file
must end in `.mdx`.

Every prop is a literal: a string in quotes, or `{…}` holding JSON (numbers,
strings, booleans, null, arrays, objects). A variable, a call or a spread is
not read, and the block shows an error box naming the prop. A tag that does
not read shows the reason in place of the drawing, so read the doc back with
`get_doc` or look at the page after writing one.

## `<PlotChart>`

An Observable Plot chart from a spec: `data` (named row lists), `marks` (each
`{ mark, data, options, transform? }`), `options` (Plot's top-level options),
or a `preset` instead of `marks`. `title`, `subtitle` and `note` are drawn
around it.

```mdx
<PlotChart title="Riverbend school trips"
  subtitle="Trips a year"
  data={{ "rows": [{ "year": 2015, "n": 30 }, { "year": 2020, "n": 24 }, { "year": 2025, "n": 19 }] }}
  marks={[{ "mark": "lineY", "data": "rows", "options": { "x": "year", "y": "n" } }]} />
```

## `<StreetMap>`

A street map with markers, popups, radius rings around each marker, small
points coloured by category, and a legend under the map.

```mdx
<StreetMap title="Reports near each Harborlight hall"
  subtitle="Within 300 ft"
  rings={[150, 300]}
  markers={[{ "lat": 37.7701, "lng": -122.4202, "label": "Harborlight hall", "popup": "Harborlight hall: 12 reports" }]}
  points={[{ "lat": 37.7705, "lng": -122.4199, "category": "Noise" }, { "lat": 37.7698, "lng": -122.4210, "category": "Litter" }]}
  categories={{ "Noise": "#4269d0", "Litter": "#efb118" }}
  note="Synthetic example." />
```

| Prop | What it is |
| --- | --- |
| `markers` | `[{ lat, lng, label?, popup?, category? }]`, up to 2,000. Each is a dot with a popup (its `popup`, else its `label`). |
| `rings` | Circles drawn around every marker: feet as numbers (`[150, 300]`), or `{ feet \| meters, color?, label? }`. Up to 6. |
| `points` | `[{ lat, lng, category?, popup? }]`, up to 50,000, drawn on one canvas. |
| `categories` | `{ "Name": "#hex" }` or `[{ name, color }]`: the legend's order and colours. A category with no colour takes the next one from the palette PlotChart uses. |
| `src` | A `.json` file beside the doc (`"data/reports.json"`) holding any of `markers`, `points`, `rings`, `categories`. A prop on the tag wins over the file. |
| `center`, `zoom` | `[lat, lng]` and 1–20. Leave both out and the map fits its data and rings. |
| `height` | Pixels, 160–1,200; 480 by default. |
| `legend` | `{false}` hides the legend. |
| `basemap` | `"osm"` (default, OpenStreetMap) or `"carto-light"` (CARTO Positron, paler, so coloured points stand out). |
| `title`, `subtitle`, `note` | Words drawn around the map. |

`lng` may be written `lon` or `longitude`, and `lat` may be `latitude`.

**Large data goes in a file.** A few hundred rows inline is fine; thousands
make the tag hard for a person to read and edit. Put them in a JSON file next
to the doc and name it in `src`. The server serves that one named file and
nothing else beside the doc, and only when git lists it (committed, or new
and not ignored), so a gitignored file is refused. The path must stay inside
the doc's folder: no `..`, no leading `/`.

**Tiles come only from the listed basemaps.** A doc names a basemap by key,
never by URL, and the map loads tiles from that provider's origins alone. No
basemap needs a key. The list and each provider's terms are in
`packages/core/src/map-basemaps.ts` in the claude-workspaces repo.
