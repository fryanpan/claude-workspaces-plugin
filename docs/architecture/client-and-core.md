# Layers inside `workspaces-app` and `core`

How the browser client and the shared core library are layered, and where each of their modules sits.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

Four top-level modules keep a doc page readable with no network, and none of
them changes a layer. `doc-cache.ts` is a store adapter: the browser's
IndexedDB copy of each opened markdown doc, written only once a server sync
has given it a state vector to check against, tagged with the session's
identity and cleared when another identity answers. Each edit made on the
page is appended to a second database (`cw-doc-cache-updates`) as it happens,
in a transaction committed at once (one left to auto-commit was measured
lost to a reload on a slowed CPU),
and the full copy written 800ms later drops the edits it covers, so a reload
loses at most the keystroke in flight. `doc-cache-boot.ts` is
the controller tier between the router's two hooks and that store: with a
copy, the doc's meta comes from it and the socket's doc is seeded from it
before the socket opens; core's `connect` takes an `acceptServerState` option
so a copy the server's history no longer covers is refused, not merged.
`offline-worker.ts` registers the same root-scoped `/sw.js` push enrolment
uses and tells it what the page loaded, and `sw-offline.ts` is the worker's
offline half, bundled into `sw.js`: a network-first doc shell with a kept
fallback, and the `/app/` bundles. The worker holds no doc content and answers
no API read.

`workspaces-app` layers the same way — entries, controllers, views, models,
transport — and its models are DOM-free, which is what lets `board/board-model.ts`,
`board/board-review-model.ts` and `board/board-presence-model.ts` be tested without a
document. `suggestions/` sits in the editor tier rather than inside `redline/`,
because Redline is the change view and a suggestion is the proposal: the chip
and the doc-level pending badge render on the plain markdown surface and on the
board's task-body editor, neither of which mounts a redline module. `new-indicator.ts` sits in the view tier as the doc's one report of what the reader has not seen: `comment-hints.ts` measures (threads off screen, and the tinted note blocks `settle-wash.ts` marks) and this draws the two pills. It replaced four controls that counted overlapping halves of that fact — the edge markers, the off-screen hints and the top bar's asks chip — so `recent-note-markers.ts` is gone. `recent-note-cards.ts` joins the same family for the wide layout's other half: it builds and ages the "who wrote this, and when" card and hands it to `redline/markup-margin.ts` to PLACE, which is the one direction that keeps a single stacking pass over the balloon column. `reading-hold.ts` is the same family's other half and changes none of the picture: a view-tier module, mounted by `doc/doc-margin.ts` on the `#editor` scroller, that keeps the reader's topmost visible line on its pixel while an agent writes above it — the page's own scroll anchoring, because Safari had none before 27 and Chrome's anchors a node of its own choosing rather than the line being read. It imports nothing but `mount-scope.ts`. While the reader types, the line it holds is the one they type at instead: `doc/working-line.ts` names the caret, or the words a focused comment box is about, and `doc/remote-edit-scroll.ts` drops the scroll the sync plugin asks for on a remote edit so the hold alone places the page. `meeting-live-hold.ts` joins the meeting family in that same view tier and
changes none of the picture: it is one screenful of geometry that
`meeting-live-zone.ts` owned until the zone crossed 500 lines, holding the
live transcript still across the frame a settled chunk splits off on. Nothing
but the zone imports it. `meeting-speaker-pill.ts` joins it in the same tier
for the same reason — the zone is back on the 500-line bar — and holds one
decision that is not the zone's: a speaker pill is a rename BUTTON where
somebody handed in a way to record a name and the plain span it always was
where nobody did. Nothing but the zone imports it either, today; the strip's
own pill (`meeting-feed.ts`) is the obvious second caller. `meeting-source.ts` sits beside `meeting-audio.ts` in the same family and changes none of the picture: it is where the strip's chosen source — the microphone, or the Mac's own audio through Chrome's share picker — becomes a media stream, split out because the capture module sits on the 500-line bar. `meeting-capture-set.ts` joins that family for the meeting that opens BOTH: it is the tier above one capture, opening each stream in turn and deciding what a meeting runs on when only one of the two doors was answered. It changes no layer — it is a view-tier module calling the same `startMeetingCapture` a single-source meeting always did — and it is named here because the strip now talks to it rather than to the capture directly. `meeting-reconnect.ts` joins the same family one tier below the strip and changes no layer either: it is the policy a dropped audio socket is retried under — how long to wait, when to stop waiting, and the two sentences the strip shows while it happens — with no DOM, no socket and no timer in it, so `meeting-strip.ts` owns the doing and this owns the deciding. Three modules join that family for the capture that dies while the meeting is still running, and they split noticing from deciding for the same reason: `meeting-track-watch.ts` is the noticing — it watches a capture's tracks on the audio graph's own block clock and reports the first loss once, with no DOM, no timer and no policy in it, because a `MediaStreamAudioSourceNode` downstream of a dead track keeps delivering silence and nothing else in the capture path was listening. `meeting-stream-health.ts` is the deciding: which streams can be reopened without a person (a microphone can, the Mac's audio cannot — the share picker is a modal no page may open by itself), what the strip says while one is gone, and what the button is called where only a press will do. Both are pure, so the strip owns every side effect. `meeting-room-audio.ts` changes none of the picture: it is the room-processing constants and constraint builders lifted out of `meeting-audio.ts`, which sits on the 500-line bar, and `meeting-audio.ts` re-exports them so no caller moved. The doc page's own recorder went on 2026-10-30 (Bryan: "Record Audio has
been replaced by the meeting mode with agent"), and with it the strip and the
view modules that hung off it: `meeting-strip.ts`, `meeting-chooser.ts`,
`meeting-advanced.ts`, `meeting-feed.ts`, `meeting-menu.ts`,
`meeting-notetaker.ts`, `meeting-transcript-panel.ts`,
`meeting-record-face.ts`, `meeting-solo.ts`, `meeting-timing-client.ts`,
`meeting-cleanup-offer.ts` and `meeting-tidy-line.ts`. What this paragraph
still names is what the lead chat's meeting runs on. `meeting-live-zone.ts`,
`meeting-live-hold.ts` and `meeting-speaker-pill.ts` are still in the tree
with their tests, but no page mounts them any more.
`notes-link-affordance.ts` joins the editor tier beside
`task-link-chips.ts`, and is the one plugin there that WRITES: the chips are
render-time and change nothing, while accepting a note's suggestion or undoing
a link edits the stored doc and calls the board. `yjs-observer-guard.ts`
joins the editor tier too and changes none of the picture: an extension in
`editor.ts`'s base list that keeps a transaction dispatched from inside a
Yjs observer from writing the editor's not-yet-redrawn doc back over the
change being observed, which is how a reconnecting tab re-inserted an
agent's deleted blocks. `doc-image-src.ts` joins the editor tier as well:
the block image in `editor.ts`'s base list, which fetches a relative `src`
from the doc's own folder (`routes/doc-assets.ts`) while the node, and so the
`.md`, keeps the path as written. `doc-image-upload.ts` beside it takes a
pasted, dropped or picked image file to that route's POST, which stores it in
`images/` beside the `.md` through the server's `doc-image-store.ts` (one of
the `doc-*.ts` the diagram draws), then inserts the path it answers.
A `::html{src="map/index.html"}` line frames a page from the same folder
(`doc/board-embed-frames.ts`, with no board mapping): the server's
`routes/doc-files.ts` serves the page and the scripts, styles and data in
its folder. Four `doc-*.ts` the diagram draws hold the rest.
`doc-file-scope.ts` reads which folders the doc's current content names, so a
doc with no such line serves nothing. `doc-file-listing.ts` asks git, off the
event loop, which files there may be read, so outside a work tree nothing is.
`doc-file-frame.ts` holds the one reader that keeps every read inside that
folder, writes the page's relative scripts and stylesheets into it, and puts
first in it the relay that hands the page's relative `fetch` calls to the doc
page. `doc-file-page-cache.ts` keeps built pages, bounded by bytes.
`doc-image-retry.ts`, which that block image installs, asks again for an
image whose file was not there yet, so it appears once the file lands without
a reload; it changes the DOM's `src` only. `doc-image-versions.ts`, which it
also installs, points each such image at `?v=<mtime>` from the doc's
`imageVersions` map, so an overwritten file is a new address no cache can
answer with the old bytes, and an open page shows it without a reload. The
server's `doc-image-versions.ts` (a `doc-*.ts` the diagram draws) writes that
map from a sweep over docs with a page open, and core's `image-versions.ts`
holds the map's name and key, so the two sides cannot disagree about either.
`comment-delete-guard.ts` and
`mass-delete-undo.ts` join the editor tier and change none of the picture:
two extensions in `editor.ts`'s base list. The first refuses Delete over a
selection spanning blocks right after a tap on a comment, which is how a
select-all reached from a comment wiped a doc; the second puts up an Undo
toast after one local edit removes most of the doc. `core` is three tiers: wire types, the document model (`prose-*.ts`,
`anchor/**`, `redline.ts`), then the rules both sides must compute identically
(`review-item*.ts`, `effort-*.ts`, `goal-effort.ts`, `show-estimates.ts` —
whether a board shows its estimates at all, off unless it says `true`, read by
the settings route and the board page alike — and
`note-suggestion.ts`, which is how a note's written "did you mean this row?"
is spelled — server writes it, browser reads it back, one definition so the
two cannot drift into a suggestion nobody can accept). The `review-item*.ts`
glob is deliberate: `review-item-look-ask.ts` is the gate's two English
heuristics lifted out whole when the gate crossed the line, and it changes no
boundary the diagram draws.

`review-hold.ts` is the newest member of that same glob's neighbourhood, and
it is there for the usual reason: the BOUND on what a hold may say — a quote
must be the item's own words, a diagnosis may carry no figure the item does
not state — is checked on the server before the hold is sent, while the
derived note a card draws from a stored verdict is read in the browser. One
definition, two readers, no boundary moved.

`review-refusal.ts` sits beside it: the five fleet rules that answer an ask
outright (spend of $50 or less, a push or merge the ship method already
consents to, a reversible implementation choice, a fact the agent can read,
a decision whose options only re-ask whether to do work the reader already
requested),
the block of the judge's prompt that teaches them, and the one fixed sentence
per rule a refused filer is told. The judge's prompt reads it, the gate
records a refusal under its rule name, and the stored verdict is read back on
both sides. `review-judge-sentence.ts` is the judge reason's one-sentence clip,
moved out of `review-judge-prompt.ts` to keep that file under the line limit.
Neither moves a boundary.

`review-blocks.ts` and `review-stale.ts` (core) join the same contract, and
`review-stale-notify.ts` joins the server's Board group; none moves a
boundary. `review-blocks.ts` reads a payload's `blocks` field — the asker
is idle until the answer — which sorts the item first on Home, gives its
row and its one push the "Stopped until you answer" line, and marks its
answer `blocking` in the answer ledger, whose week `GET /api/metrics`
reports as `blockingWait`. `review-stale.ts` decides from the thread alone
that an open ask stopped applying (its anchor orphaned, or the asker's own
later reply settled it), so `review-queue.ts` drops it and the thread card
marks it, with nothing written. `review-stale-notify.ts` is the one half that
cannot be a read: it listens for the posted comment and the edit-triggered
re-anchor sweep that make an ask stale, and sends its asker one addressed
`workspace.review_item_stale` frame carrying the withdraw call.

`secret-name.ts` joins that third tier for the same reason, with the two
readers furthest apart in this repo: the server's writer spells the stored
name when it runs `security`, and the MCP tool descriptions tell an agent the
name to read back. Neither package can import the other, and the two used to
be hand-written copies of one prefix — one in code, one in prose — so a rename
could leave every agent reading an entry that does not exist. It changes no
boundary the diagram draws; it holds names and one command string, and no
value passes through it. `secret-line.ts` sits beside it: the command line a
value is stored with, its budget, and whether a value fits — measured by the
server's writer and by the board's secret form before it sends. Apart from
`secret-name.ts` only so the MCP bundle, which never measures a line, does
not carry the budget.

`mock-swap-noise.ts` joins that third tier for the same reason and an unusual
pair of readers: the widget's mockup swap raises a flag there while it inserts
a script it is about to retry, and the page's Sentry init reads it in
`beforeSend` to drop the redeclaration the swap already recovered from. They
are separate bundles that share nothing but the page, so the flag's name and
the "is this a declaration collision" test have to have one definition — and
the narrowness is the point, since a collision nothing recovers still files.

`meeting-streams.ts` belongs to core's wire-types tier beside `meeting.ts`, and
is there for the usual core reason: a two-stream meeting's group names and
namespaced speaker labels are rendered by the browser, written by the server
and read back by the notes composer, so one spelling has to serve three
processes.

`meeting-parse.ts` joins that tier too and moves the boundary rather than the
picture: `meeting.ts` keeps the VOCABULARY — the frame shapes, the capture
modes, the engine names, the bounds — and this holds the reading of an
untrusted frame against it, which is a different job under a different rule.
It imports from `meeting.ts` and never the other way, because both sides of
the socket use the types and only the server reads the frames. It was split
out when a new frame took `meeting.ts` past the 500-line bar.

`speaker-name.ts` sits in that same wire-types tier, and joins the picture
without changing it: what a voice is CALLED — the placeholder until somebody
names it, and the normalisation that keeps a stale display string from being
read back as a name — was a function inside `meeting.ts` until the rules
outgrew it. Four processes render it (strip, notes editor, notes composer, raw
transcript), which is the same reason `meeting-streams.ts` is here.

`footnotes.ts` belongs to that document-model tier too and does not move the
picture: it is the grammar of a `^[a note]` inline footnote — where the notes
are in a line, whether the author wrote "Unconfirmed", and which words a note
is about. Nothing about a footnote is stored, so this is a pure text question
asked at parse time (the inline parser skips a note's body rather than reading
citation punctuation as emphasis) and again at render time by the editor's
decoration plugin, which is why the answer lives in `core` rather than in
either caller.

`prose-integrity.ts` belongs to that document-model tier and does not move the
picture: it is the check the server runs after a write, asserting the live doc
holds no markdown syntax that should have become blocks. It is named here so the
next reader knows a new `prose-*` module was placed rather than missed.
`prose-keep-source.ts` sits in the same tier and does not move the picture
either. It is the serializer the file write-back uses. It keeps the file's own
bytes for every block an edit did not touch, so editing one paragraph rewrites
one paragraph, and a note added to a list rewrites only that list item. A block
counts as touched when its content changed, whoever changed it. Before it, the
first edit re-serialized the whole file, which in an `.mdx` post joined the
`import` lines onto one line.
`prose-mdx.ts` is the other half of that fix, in the same tier. For a file
ending `.mdx` it finds each JSX component, `{…}` expression and import run,
and the parser stores it as a code block whose language is `mdx-flow` and
whose text is the exact source lines. A component is then one block the
writer serializes byte for byte, not a paragraph that an edit could reflow.
`prose-mdx-retype.ts` sits beside it and does not move the picture. A doc
parsed before that grammar holds its components as paragraphs, and once a
flush had written one onto a single line, the doc and its file serialized
alike, so the attach never re-read it. The attach now re-types each such
paragraph in place into the block the grammar makes, with the same text, so
the file does not change.
`prose-image-line.ts` is the same repair for images and does not move the
picture. An agent's text edit could leave a standalone `![alt](src)` line as
paragraph text, which serializes to the same line as an image node, so no
reconcile rebuilt it. A doc now promotes such a paragraph to an image node
when it loads and when the edit writes it; an open thread in the paragraph
holds it as text until that thread is resolved.
The editor draws that block through four client modules beside
`mermaid-code-block.ts`, and they do not move the picture either.
`mdx-flow-block.ts` is the node view and the plugin that makes the block
read-only. `mdx-preview.ts` reads a component's props with a literal parser,
never by running them, and shows a component's title and words.
`mdx-chart-props.ts` takes those props by shape rather than by component
name — a `series` of x/y points is lines, a `data` list of label/value rows is
bars — and `mdx-chart.ts` draws what it returns as SVG whose every string is a
text node. The two were one file until the drawing had to follow the published
site's chart: a band shades a stretch of x over the whole plot rather than a
y range, each line carries its name and last value at its own end instead of a
legend below, an indexed chart's reference line is drawn and labelled, and the
component's own `width` decides the drawing's width. The drawing is now four
files: `mdx-chart.ts` draws lines, `mdx-chart-bars.ts` draws bars,
`mdx-chart-waterfall.ts` draws a waterfall (a `data` list whose rows carry a
`kind` of start, step or end, each step floating between running totals), and
`mdx-chart-svg.ts` holds the SVG helpers they share. None of the four changes
the picture above. `mdx-chart-props.ts` also uses the site's defaults (horizontal
bars, percent) and lists every prop the preview does not draw, or that the site
itself ignores, so `mdx-preview.ts` can print them under the chart.
A `<PlotChart>` is read by name instead, and does not move the picture.
Its props are an Observable Plot spec, and `packages/core/src/plot-spec.mjs`
turns them into a chart. It is plain JavaScript that imports nothing, because
other repos copy its bytes. Every mark, transform and pointer it names must be
on an allowlist, as must every reducer a groupX, groupY or binX `outputs`
names, and every `data` reference must be a key or an inline array, so a bad spec throws before any Plot function runs. The file also holds what
makes a chart look and behave the same on every site: the house style (font,
grid, axes and palette, each a CSS variable with a fallback), three presets
that expand into ordinary marks (a preset's series take Observable 10
unless it marks them `ordered`, when they take the sequential ramp; and
stackedArea and lines draw `events` as dashed rules labelled at the top), named formats in place of functions, and
`renderPlot`, the one call each page makes. `renderPlot` draws a chart at
its container's width and the spec's height, and draws it again when that
width changes, so a narrow column gets a narrower chart with the same 13px
text; under 600px it also drops explicit x ticks, keeping the first, until
no two labels overlap, and a stacked chart names each series inside its
own band and its goal above the rule, so the right margin goes to the data.
At 600px and wider a stacked chart's end labels are set in ink beside a dot
of the series' colour, and labels whose bands are too thin to keep them
apart are moved apart on y around where they want to be (`spreadEnds`).
A lines chart's end labels are set in ink too, at every width, each beside
the dot of its series' colour that ends its line, because no Observable 10
colour reaches 4.5:1 as text on the paper; the same `spreadEnds` moves them
apart while the dots stay on the lines, and the baseline label is placed
against where they were moved to.
A band label's width is estimated glyph by glyph against Chrome's system-ui
widths, because a thin band's level window is often only a few px wider than
its name. The file's first line names its version and the
sha256 of every byte after that line, so a copy that has fallen behind shows
in the line a site compares, or in `tail -n +2 plot-spec.mjs | shasum -a 256`.
`bun run plot-spec:stamp` (`scripts/plot-spec-stamp.ts`) rewrites the line
after an edit, moving the version past origin/main's, and a test in
`plot-spec.test.ts` fails while the line and the contents disagree.
`mdx-plot-chart.ts` draws the subtitle, the note and the chart slot,
which it sets to the chart's height (`plotHeight`) before Plot arrives, so
the doc does not move when it does. It fetches Plot and `buildPlot`
from `/app/plot/plot.js` the first time a doc shows one, for KaTeX's reason
below; `plot-entry.ts` is what the build compiles to that path.
A `<StreetMap>` is read by name the same way. Core's `map-spec.ts` turns its
literal props, and the JSON file its `src` names beside the doc, into a
spec (markers, radius rings in feet, category-coloured points, legend
entries); core's `map-basemaps.ts` is the list of street maps a tag may name
by key, with the origins each loads tiles from, and is the one place a
provider is added. `mdx-street-map.ts` draws nothing itself: it reads the
`src` file through the doc's files route, asks for a keyed basemap's key,
and mounts the components package's map (`components/src/map.ts`, fetched
from `/app/map/map.js`, built from `map-entry.ts`, with Leaflet the first
time a doc shows a map) with the merged props and the doc's live state hook
for the tag's `id`, so an agent's `set_component_state` moves the pins on
every open page. A site mounts the same file, so a site's map and a doc's
are one component: one legend, one basemap fallback, one renderer
(`draw.ts`; markers and rings are SVG paths, points one canvas).
The files route serves a `src` file only when a `<StreetMap>` in the doc's
live content names exactly that path (`doc-file-scope.ts` `mapDataFolder`).
`google` is the one keyed basemap and the default for a tag that names
none: `mdx-street-map.ts` asks `routes/doc-map-key.ts` for the key, which the
server answers only while the doc's live content draws
on that basemap (`doc-file-scope.ts` `mapBasemapsNamed`), and draws on
OpenStreetMap when it gets none, with a line saying why if the tag named
Google itself. The server reads that key once at boot in `google-maps-key.ts`,
from `CW_GOOGLE_MAPS_KEY` or else the mode-600 file `infra/gcp-maps` writes
under prod's boot-disk root. The components package's `google.ts`, in the
same chunk, loads Google's Maps JavaScript API with that key and puts its
tiles under the Leaflet layers through GoogleMutant, which reads the global
`L` that its `leaflet-global.ts` sets.

An agent reaches a doc's components through `doc-components-agent.ts`, in the
doc-store group's `doc-*.ts` glob, and so does not move the picture. It lists
each tag with its build and state id, and lists a state whose tag is gone as
unplaced. It writes a component's state through the same core module the page
uses, so the write reaches every open page over the doc socket. It places a tag
with the block-edit path every agent edit takes. `routes/doc-component-agent.ts`
answers the MCP tools `list_components`, `get_component_state`,
`set_component_state`, `place_component` and `request_component_grant`.
`component-grants.ts` sits beside `component-build.ts` and holds the folders
whose git-ignored files the owner let a build read. Only the owner's Approve on
an access card writes it.

A component tag in an `.mdx` doc runs, not just previews, and the modules
that do it are described in [mdx-components](mdx-components.md). Core's
`mdx-components.ts` joins the document-model tier: it decides which tags
are component tags and the key each build is filed under, and
`mdx-component-runtime.ts` is the JSX runtime each bundle carries.
`mdx-component-state.ts` is a tag's live state: one root Y.Map per component
id in the doc's Y.Doc (not one shared map, so two pages' first writes both
survive), with the size, depth and rate limits checked on the writing page
and a read-only page's writes refused there and dropped by the socket. On the
server, `component-build.ts` builds one tag with esbuild and holds the rules
on what a build may read, `component-cdn.ts` fetches and stores esm.sh
modules, `doc-component-builds.ts` is the sweep that builds what changed in
each open doc (a `doc-*.ts` the diagram draws), and `routes/doc-components.ts`
serves a bundle. On the client, `mdx-component.ts` mounts the bundle in the
`mdx-flow` node view, and `selection-range.ts` maps a reader's selection of
words a component drew to the tag's source, quoting those words, so a comment
can anchor where the doc has no text. None of them changes the picture.

Two more core modules serve the components a site shares with a doc, and
neither changes the picture. `plot-chart.ts` is the library chart: one
component file over `plot-spec.mjs` that a doc builds from the pair copied
side by side, and an Astro page imports as it is. It imports Plot from
esm.sh at an exact version, which a doc build accepts; `esm-sh-plot.d.ts`
types that address, and vitest and a site's bundler map it to the installed
copy. `component-snapshot.ts` is the host wrapper for a page that is not a
doc: a state hook over a JSON snapshot, whose writes stay on the page.
`component-state-rules.ts` holds what both hooks refuse (paths, JSON-only
values, `__proto__`, the depth, size and rate limits), taken out of
`mdx-component-state.ts` so a site and a doc refuse the same writes.
`templates/astro-chart` is the Astro page that proves the chart runs there
unchanged.

`prose-math.ts` joins the same tier and does not move the picture. It is the
grammar of a remark-math equation — `$x$` inline, `$$` … `$$` on lines of
their own — measured against remark-math 6, with two places where it reads
less math (a price like `$5 and $10`, an unclosed fence). The parser holds
inline TeX as a `math` text attribute that is never parsed for emphasis or
escapes, and a display equation as a code block in the `math-display`
language holding its exact lines, the way an `.mdx` component is held, so the
file comes back byte for byte. Four client modules draw it and do not move
the picture either. `math-inline.ts` is the mark and the decorations that
fold the TeX behind a KaTeX widget until the caret reaches it;
`mermaid-code-block.ts` draws the display block. `math-katex.ts` fetches
KaTeX from `/app/katex/` the first time a doc shows an equation, never
before, and fixes its options (`trust: false`, `throwOnError: false`);
`katex-entry.ts` is what the build compiles to that path.
`math-markdown-it.ts` gives tiptap-markdown, which the redline and paste use,
the same boundaries through the same core functions.

`prose-choice.ts` joins the same tier and does not move the picture. A
```` ```choice ```` block is an ordinary code block whose one line names its
options and its pick (`id=… options="yes,maybe,no" picked=maybe`), so the
parser and serializer need nothing new. The client's `choice-block.ts` is
the node view that draws the buttons, and a tap rewrites `picked` in the
block's text, so a pick reaches other pages and the file the way typing does.

`prose-identity.ts`, `prose-outline.ts` and `prose-batch.ts` join that same
document-model tier, and together they are how an agent addresses a block
rather than a region of text. `prose-identity.ts` is the leaf that names the
two attributes a block can carry — its stable id, and the agent that wrote it.
`prose-address.ts` says which blocks are addressable and the id each answers
to, writing nothing: a block with no stored id answers to its Yjs item id, and
only a write stores that value, so an outline read is a pure read and an id it
handed out still names its block after the next edit. Writes store ids as
blocks land: the browser's `block-identity.ts` stamps the blocks a person
inserts inside that person's own change, `storeBlockIdsOnWrite` stores them
after a server-side write, and a hydrate stores them in memory without a save.
So only a block nobody has written since load goes by a derived id.
`prose-outline.ts` reads a document as a list of those ids with their headings
and text, and installs the observer that drops the authorship attribute the
moment a person edits the block. `prose-batch.ts` applies a list of scoped
edits in one transaction, refusing to rewrite what the agent no longer owns and
raising a suggestion instead. That suggestion is written by `suggest-blocks.ts`,
which proposes whole blocks rather than a run of text: the target's words
struck, the replacement offered as real blocks beside it under the same sid,
so `suggest-ops.ts` resolves it with no new code and a replacement that is
itself a heading, a list or a fence is accepted as one rather than as
characters. `prose-batch-write.ts` is the writer under the batch: it turns
markdown into elements at a position — growing a list rather than starting a
second one, rewriting one bullet as several, keeping a rewritten block's id —
and knows nothing about ops, outcomes or who owns a block.
`prose-batch-structure.ts` holds what an applied edit must leave
standing around itself: the notes nested under a bullet it replaces, the
editor's trailing blank line kept at the end rather than stranded above an
insert, and a block with no words, which applies directly whoever owns it.
`prose-nest.ts` is one of those edits given a
module of its own: `nest_blocks` MOVES existing list items under a lead bullet
rather than restating them, which is what lets a note-taker regroup a topic
without retyping a point or orphaning the comment threads anchored to it.
`prose-split.ts` is the second, and it is the only insert in the product that
lands anywhere but an END. Every other one appends — to the document, or to
the end of the section it names — so a heading could be written and never
PLACED, and a topic that had swallowed half an hour could not be broken up at
all. `insert_before_block` opens a slot in front of a named block, splitting
its list when the block is in the middle of one, and a heading written there
re-parents every note below it by ARRIVING: an outline reads a block's topic
as the nearest heading above it, so nothing is moved, nothing is retyped, and
every note keeps its words, its id and its comment threads. What it does
disturb is the list it splits, whose tail is carried by the same clone
`prose-nest.ts` uses — so it asks the same ownership question before it does,
and refuses rather than carry a line a person owns. Server-side they are reached through
`doc-outline-ops.ts`, which sits beside `doc-edit-ops.ts` in the services tier
for the reason that module already gives: `doc-edit-ops.ts` was at the
500-line bar, and the outline verbs are a family of their own.
`doc-suggest-ops.ts` joins them on the same terms: the suggestion verbs
(list, propose, accept, reject, resolve-all) moved out of `doc-edit-ops.ts`
because they are the only ones that announce and the only async one, and they
resolve docs through `DocEditOps.live` so a dry run's copy is what they see.

The scoped edit verbs — find_and_replace, rewrite_thread_region, the anchor
inserts and the block deletes — run through `DocEditOps.guardScopedEdit`, the
rule `set_doc_content` already had, narrowed to blocks. `scoped-edit-guard.ts`
holds the pieces: the per-block stamps `live-doc-fanout.ts` takes when a
person's edit arrives over the websocket, the dry run that tries an edit on a
copy of the doc to learn which blocks it would change, and the 409 it returns
when one of them changed after the agent's last read. A doc a person edited in
the last ten minutes is backed up before the first scoped edit after each of
their edits. `block_edits` is not guarded: it already turns an edit to a
person's block into a proposal.

The note-taker is the first caller and deliberately not a privileged one. It
holds no private write path into a document: it reads an outline and posts
block edits through the same `DocStore` verbs the MCP tools expose, which is
why the modules that used to give it one — a section finder, an ownership
ledger, a whole-section merge planner — are gone rather than moved.
