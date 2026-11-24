# Mockups, frames, whiteboards, presence and dev servers

The live surfaces that are not markdown: a bound mockup and its rounds, the sandboxed frame and its hostname, whiteboards, presence and follow, and attached dev servers.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

**A bound mockup is a live surface, and it keeps its rounds.** A mockup's doc
holds no content of its own — its surface is somebody's HTML file — so the
`mockup-*.ts` modules are what make that file behave like an attachment.
`mockup-widget.ts` adds the comment widget on the way out and
`mockup-live.ts` adds the script that makes the page update itself, both at
serve time, so review scaffolding never has to live in a file a build step
writes or git tracks. `file-binding.ts` watches the source through the SAME
shared mtime sweep every bound `.md` uses — a mockup binding is watch-only,
never writes back, and touches no fragment — and hands each change up as a
`mockup.updated` frame on the doc's own channels. What that sweep calls a
change is one stamp, and `file-stamp.ts` is where it is read: the mtime in
NANOSECONDS plus the byte count, so a same-length write landing in the same
millisecond as the last one is still seen. A code file or a live diff member
is flat text, and when its file changes `flat-text-patch.ts` brings the doc's
`content` to the new bytes by rewriting only the lines that differ: a
whole-text replace would leave every comment anchor and every open editor's
collapsed diff stretches pointing at deleted text. An open page fetches the
round it names and swaps its content in place, keeping the reader's scroll and
letting the widget re-anchor its threads onto the new DOM, so a comment whose
element is gone becomes an outdated one rather than a lost one. The page-side half of that script is two modules in the widget package rather
than one: `mockup-live.ts` owns the swap, and `mockup-live-scripts.ts` owns
what re-inserting the round's own `<script>` elements does — including the
redeclaration a second round used to die on, which browsers report two
different ways. It joins no subsystem; it is the swap's other half, split for
size. `mockup-live-state.ts`, also in `mockup-live.js`, is what a mock keeps of
itself through a swap: it fires `cw-round-leaving` and `cw-round-arrived`,
hands the kept value to the new round as `window.cwRoundState`, and calls the
`DOMContentLoaded` and `load` listeners the new round adds, which a page that
does not reload never fires. Same subsystem, no route.
`mock-page-lift.ts`, also in `mockup-live.js`, moves the mock's own fixed
buttons along the bottom up by the review-item dock's height while an item is
docked, so the dock never covers them; the widget's own buttons already rise by
that height. It joins the same subsystem and changes no route.
`mockup-page-links.ts` reads the HTML at bind time for root-relative `<a
href>` and `<form action>` links, which resolve against the workspaces host
inside a mockup, and the bind answers with a warning naming them and the
board's app address when one exists. `attach_app` runs the same detector on
the app's root page, fetched once, and warns about links outside
`/workspaces/<ws>/apps/<doc>/`: a dev server started without that base path.

`mockup-capture.ts`
still keeps the single fallback copy that lets a link outlive its scratch
directory; `mockup-versions.ts` keeps the history beside it, so the page a
reviewer was looking at when he commented is still readable at `?v=<n>` after
the next round replaces it. Same link, every round — which is what a rebind
under an existing id has meant since it started destroying the page underneath
the comments.

**A served mock runs in a sandboxed frame, and speaks to the board through
the page around it.** A mock's scripts are somebody else's code, so the mock
is never served on the board's origin beside the reader's session.
`mockup-frame.ts` (server, beside the other `mockup-*.ts` modules) makes
`/workspaces/<ws>/mockups/<id>` answer a small host page. That page holds one
frame of the same address plus `?cw-frame=1`, whose response is sandboxed by
CSP. The frame fetches nothing from the board by itself, because an
opaque-origin frame's requests carry no Lax cookie and Access would redirect
them: the server writes the bridge, the widget, `mockup-live.js` and any
board script or stylesheet the mock names (`/widget/…`, `/app/…`) into the
frame's bytes, and voice feedback's script and each round's page come through
the host. Three new top-level modules in the widget package are
the two ends of that line, and each is a separately built asset rather than
part of `widget.iife.js`. `mock-bridge.ts` runs first in the frame and hands
the widget's board-bound fetch, WebSocket and EventSource calls to the host.
`mock-host.ts` is the host page's script: it builds the frame, and it makes a
call only when `mock-relay-policy.ts` (pure, tested alone) says it is this
mock's own. `mock-door.ts` (pure, tested alone) puts an app's frame back under
the host page's door when the app's own address took it outside.
`mock-host-liveness.ts` keeps the page live when the doc socket stops carrying
bytes with nothing telling the browser, as when a tablet sleeps. The host sends
the one-byte probe in core's `ws-probe.ts` every 20s and when the page wakes,
`yjs-protocol.ts` answers it, and a socket silent for 5s is closed to the
frame, whose widget reconnects and syncs what it missed. It runs only here: the
widget bundle has no bytes for it, so a page outside a frame has no such watch.
The host stamps every call it makes with `x-cw-via: mock-frame`, or
`cw-via=mock-frame` on a socket. The stamp travels as `via` on the
comment or answer it writes, and agents read it as "sent from inside the mock
page". Nothing else changes in the data flow: the calls are the same routes
and sockets, made from a different page. The rule and its limits are in
[security.md](security.md).

**The frame can live on its project's own frame hostname.** `frame-host.ts`
(server, top level, beside `mockup-frame.ts`) is off unless `CW_FRAME_ORIGIN`
names the project's frame hostname, `<project>.<frame domain>`, on a domain
that is not the board's. Set, a host page on one of the board hostnames
(`CW_FRAME_BOARD_HOSTS`, default the operator's proxied hostnames) points its
frame at the same path on that hostname, and the frame gets a real origin on
another site: storage of its own, and no way to read or set the board's
cookies. The host page writes a frame ticket into the frame's address
(`frame-ticket.ts`), which the frame hostname trades for a partitioned cookie,
because Safari sends a frame on another site no Access cookie. The ticket and
the cookie are two signed formats, so a cookie cannot be redeemed for another
one, and the cookie ends twelve hours after its ticket was minted. A share or
collaboration visitor's page keeps the opaque frame. Request admission checks
the frame hostname before any other kind, and answers there only a mock's
frame, an app door's paths and the widget's public scripts, each only as the
fetch type it is loaded as, and an app's files only to a page on the same
frame hostname; everything else is a 404 before a route runs. The board
router sends `<project>.<frame domain>` to that project's server. The
bridge learns the host page's origin from the frame's seed and relays every
call by path, so the host still resolves it against the board's hostname.

**A whiteboard is a doc whose content is a drawing.** Its type is
`whiteboard`, and its `.ydoc` holds one Y.Map of Excalidraw elements keyed by
element id, with no bound file. Every write replaces a whole element, and the
copy with the higher `version` wins, then the lower `versionNonce`
(`incomingWins` in core's `whiteboard-scene.ts`). That is Excalidraw's own
reconcile rule, so the server, every page and every agent converge on the same
scene. A delete is a newer copy with `isDeleted` set, never a removed key.
A page writes after its gesture ends and after its socket returns, so an agent's
`replace` raises every version it writes by `REPLACE_VERSION_STEP`, past any copy
an open tab still holds, and the board ends as the replace left it. Yjs settles
two concurrent writes by client id, not by version, so the server puts back a
copy the rule says should have won (`keepWinningCopies`, `whiteboard/scene.ts`).
`/workspaces/<ws>/whiteboards/<id>` serves `whiteboard/page-shell.ts`, and the
page is its own bundle, `whiteboard.js`. It is the one place the app runs real
React, because Excalidraw needs it; React and Excalidraw load behind one
`import()` so the header and socket come up first. The page wears the doc
page's `#topbar`, draws the mock page's nav (`board-host-nav.ts`, which both
shells render because neither has the board's bundle, and a share visitor gets
on neither) and mounts the same `lead-chat-mount.ts`, so a voice chat carries
onto it as onto any page of the board. The agent button sits in
Excalidraw's foot row, and the docked chat takes width from the canvas down to
what its desktop layout needs (`data-lc-page-min`, read by `lead-chat-dock.ts`)
(`whiteboard.css`). The page writes to the
scene only when no gesture is in progress, so a half-drawn stroke never
reaches anyone. It holds back a remote copy of an element the person is still
drawing, and every remote change while they move a selection, until they let go
(`whiteboard/scene-sync.ts` in the app). Agents draw through `POST …/docs/<id>/whiteboard`
(`routes/whiteboard-routes.ts`), which turns boxes, ellipses, arrows and text
into elements (`whiteboard/elements.ts` on the server) and can set the one
spot the agent points at. That pointer lives in the server's awareness state
under `agentPointers`, keyed by agent, because the server holds one awareness
state per doc. A burst of strokes from one actor becomes one
`whiteboard.changed` frame once that actor has been still for
`whiteboardSettleMs` (`whiteboard/scene-events.ts`), and the MCP child drops a
frame its own agent caused (`self-authored.ts`). Comments on a whiteboard are
not wired yet.

**Presence is one room per workspace, and following leads across its
pages.** The rule is in [decisions](../product/decisions.md) (2026-10-15,
narrowed 2026-11-04): a person is one spot, the place they are; an agent is
only where it directs its followers, never where it is working. The room is
the board doc's own awareness, `ws:<id>`. The board page holds it with its full
socket; a doc page and a whiteboard page join it with `?presence=1`, a socket
that `yjs-protocol.ts` syncs against an empty doc, so awareness flows both ways
and none of the board's megabyte does. Each page announces `user` and its
person's `spot` (core's `workspace-presence.ts`), but the server sets the
name: `presence-identity.ts` decides at the upgrade who the socket is (the
proven person; the owner for a writable loopback socket that proved nobody;
otherwise a guest whose `guest-` id is hashed from the page's own browser id,
so it matches the guest's comments), and `yjs-protocol.ts` writes that over
`user` in every state the socket sends. It strips the fields only the server
writes, and drops any entry for the server's own client id or for one another
socket holds, unless that state is gone or the new socket is the same person
(a reconnect). The server announces no
`user`; its own state carries `agentSpots`, one entry per agent, written by
`agent-spots.ts` when an agent calls `point_at` (`routes/workspace-point.ts`:
a board page, a panel, a thread, the review queue, the workspaces list, or a
thread, block, phrase or scroll in a doc, mock, app, diff or folder file), a
whiteboard `point` is set, or the planning voice moves its cursor
(`agentFocus`, through `voicePointer` in `spoken-reply/interview-docs.ts`), and
never by a comment or an edit. The voice holds no event stream, so its entry is drawn while
its cursor is on a doc rather than while a stream is open. In the app, `presence/` holds
the shared half: `follow-model.ts` resolves a chip's key to a spot,
`follower.ts` takes the view there (scrolls on the same page, opens another,
keeps the follow in `sessionStorage` across the load, ends on the reader's own
input), `page-presence.ts` draws the board's presence circles on a doc or
whiteboard page, and `doc-spot.ts` reads and shows a block or thread in the
markdown editor. The other surfaces plug into the same slot
(`doc-spot-slot.ts`): `flat-doc-spot.ts` serves code, diffs and redlines, which
have no blocks, so a spot there is a scroll, a phrase or a thread, and
`page-scroll.ts` finds what scrolls a page that has no block to name.
`mock-presence.ts` does this for a mock's or an app's host page, through
`mock-where.ts` in the widget, the half inside the sandboxed frame. The review
queue and the workspaces list belong to no board, so
`carried-follow.ts` checks `sessionStorage` for a follow arriving at that
address, and only then loads the room (`off-board-presence.ts`). The board's own
follow is the same follower. Each page also announces `following` (whom it
follows) and `leads`: a follow goes to the newest of a person's tabs that
leads, so a tab they open while followed elsewhere starts not leading and,
once its room syncs, offers "Bring them here" (`bring-along.ts`; a browser's
tabs find each other through a list of client ids in `localStorage`, because
the server writes the proven name over the one a page announces).

**An agent can hear where the owner is and move the one tab they are
attending to.** Each page also announces `attending` (visible and focused,
`presence/attention.ts`). `person-presence.ts` on the server reads the room:
the owner's tab is the attended one most recently seen, counted only from a
socket whose upgrade proved the owner (`personProof` in
`routes/upgrade-stream.ts`), or one that proved nobody and announces an owner
id; a share visitor's never counts. An agent that called `watch_person` gets a
transient `person.landed` frame when that tab lands on another page, after a
300ms settle so the page has said what is in view (`describeLanding` names the
doc, diff, mock, task or goal; `mcp/src/person-line.ts` renders it).
`show_person` writes a `personDirective` into the server's awareness state
naming that tab's client id; only that page obeys (`directiveFor` in
`follower.ts`), carrying the spot across a page load in `sessionStorage`. A
landing that follows an agent's own show carries it as `actor`, so its MCP
child drops it. Both routes are `routes/workspace-point.ts`, token-gated; the
wall between boards is the room itself.

**An attached dev server is served like a mock, from the board's own
address.** An agent runs a site's dev server on a loopback port and binds it
with the `attach_app` MCP verb, which posts to `/workspaces/<ws>/apps`. That
makes a doc of type `app` whose `sourceUrl` is the origin, filed on the board.
`routes/apps.ts` then answers `/workspaces/<ws>/apps/<id>/<path>` by fetching
`<origin>/<path>`. A document gets the mock's host page and sandboxed frame,
with the widget and bridge written into the frame. Everything else is relayed
as a stream, so the dev server's reload event stream reaches the page, and the
bridge relays the page's own fetches and event streams under the app's prefix
(`mock-relay-policy.ts`). `app-proxy.ts` is the pure half: the loopback rule,
the path check and which headers cross. A websocket under the prefix is the
dev server's own reload channel: `routes/app-socket.ts` admits it from
`routes/upgrade-stream.ts`, and `app-socket-link.ts` holds the socket to the dev
server and relays frames and close codes between the two. The bridge in the
frame hands the page's `WebSocket` to the host page, so the socket opens on the
board's origin with the reader's cookie. Nothing inside the page is rewritten,
so the site builds its links under the prefix. The page's query reaches the dev
server byte for byte minus the frame flag, and the host page hands its
fragment to the frame. Every answer at an app's address carries
`Cloudflare-CDN-Cache-Control: no-store`, stamped last in `routes/hono-app.ts`,
so the edge keeps no copy of an app's files, whatever the dev server said. What this does not carry
behind a sign-in is in [security.md](security.md).

**A dev server that stops answering is news for whoever can start it.** When
the proxy's fetch throws, the reader gets a waiting page as a 503, not a 502:
Cloudflare replaces an origin 502 with its own "Bad gateway" page, which is
what the owner read on 24 September while this server was up. The page
(`app-waiting-page.ts`, an HTML renderer beside `shells.ts`) names who was
asked and when, polls its own address with HEAD, and opens the app when that
stops answering with the `x-cw-app-down` mark. After two minutes it offers
"Ask again", a `POST` to the bare `apps/<id>` address that sends a second
notice marked `askedAgain`, at most once per two minutes.
`app-outage.ts` (beside `app-proxy.ts` in the doc-store group) turns the first
failure into one addressed `workspace.app_unreachable` frame on the board
stream and one `[apps]` log line, and stays quiet until a request the app
answers re-arms it. The frame goes to the agent the attach recorded as
`producedBy.agentId`, else the board's lead; `app-unreachable-line.ts` in
`mcp` words it, beside the other line modules.
