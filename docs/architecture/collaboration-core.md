# The collaboration core and the apps built on it

The folder of collaboration code another app can take, the app kit, the Cloudflare Worker host, and how a Workspaces board runs on the core.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

**The collaboration core is a folder another app can take.**
`core/src/collab/` (a new top-level core directory, exported as
`@claude-workspaces/core/collab`) holds rooms that sync a Yjs doc between
pages over the app's storage (`room-host.ts`, speaking the same
`[0, syncMessage]` frames as `yjs-protocol.ts`), and a private-message store
kept apart from every room (`private-messages.ts`, one log per pair). It
imports nothing but `yjs`, `y-protocols` and `lib0`
(`core/test/collab/collab-imports.test.ts`). Two rules hold for every app: no
room opens without a role function, and an action whose body names a room,
board or doc is refused, because the room comes from the connection. A view
or comment connection gets the doc and its edits are dropped unread, and an
action is an edit, refused for those roles, unless the app marks it
read-only, when it runs on a copy of the doc. The
server's `DocStateStore` fits its storage interface as it is, and
`server/src/private-messages.ts` is the file-backed store behind its
private-message interface. A room host can instead be handed the app's own
live docs (`docs` in place of `storage`), which it syncs in place and never
saves or destroys, for an app that already holds and persists its docs. The
proof that it
runs without Workspaces is `server/test/collab-test-app.test.ts`, a Bun app
that imports only the core. `server/src/collab-rooms.ts` is the registry of
room hosts the server runs; every revoke calls its `recheck` beside the
sweep that closes the server's own sockets, so a core connection loses a
revoked role on the same call.

**A new app starts from the app kit.** `bun run new-app <dir>`
(`scripts/new-app.ts`) copies `templates/app-kit` into `<dir>` and names it
after the folder: a Bun server with Hono routes, a doc socket the core's
room host syncs, a sign-in slot, and pages drawn in the board's Web Awesome
theme. The core and the theme reach the app as one versioned package,
`packages/app-kit` (`@claude-workspaces/app-kit`, exporting `./collab` and
`./theme.css`). In this repo its two files re-export `core/src/collab/` and
`@import` `workspaces-app/src/wa-theme.css`; `packages/app-kit/scripts/pack.ts`
packs a tarball whose copies of those files are the real ones, and the
generator puts that tarball in the app's `vendor/` and names it as a
`file:` dependency, so the made app holds no copy of their source and
depends on nothing here. A tarball rather than GitHub Packages (which needs
a token even to install) or a git dependency (which cannot name one
package inside this monorepo). Sign-in is a typed slot
(`SignIn.principal(request)`) filled by password sign-in on Better Auth over
bun:sqlite (`templates/app-kit/src/password-sign-in.ts`). Its rules are
`passwordAuthOptions` (`packages/app-kit/src/auth/password.ts`, exported as
`@claude-workspaces/app-kit/auth`), which `templates/signin`, the Cloudflare
Worker on D1, spreads into its own Better Auth config too, so hashing,
verification and session rules have one source. `server/test/app-kit.test.ts` makes,
builds and runs an app outside the repo and syncs a doc between two of its
pages; `scripts/app-kit-browser.test.ts` does the same in two browser tabs.
A made app also carries a role table and presence, with no board:
`templates/app-kit/src/doc-roles.ts` is the app's `RoleFn`, one row per doc
and person in its own SQLite (the first to open a doc owns it; the owner
sets the rest at `POST /docs/<id>/roles`), and `src/presence.ts` runs the
core's presence hub on `/docs/<id>/presence`, scoped by the same function.
Its four words are the board's `AccessRole`, so an app reached through a
board swaps the table for a read of that board's membership and nothing that
calls it changes. `server/test/app-kit-roles.test.ts` signs two people in,
shows each on the other's doc page, and shows a view-only person's edit
dropped before it reaches the other page or the stored doc.

**A Cloudflare Worker app hosts the same core in its own Durable Objects**
(kit 0.3.0). `packages/app-kit/src/do/` wraps the room host for the
hibernation API: each socket's grant rides in its attachment, so a woken
instance re-attaches every socket with its role, and the doc saves to the
object's SQLite inside the message that changed it. `src/markdown-file/`
holds a doc whose record is a file the app loads and saves itself, with the
save debounce on the object's alarm so an eviction cannot drop it.
`src/agent/` names an agent session as a principal (`agent:<sessionId>`) and
gives the app's tool dispatch two edits, `editDoc` and `setTile`.
`src/client/` is the page side (moved out of the template, which re-exports
it), and `scripts/build-client.ts` prebuilds it as `cw-collab.js` for a page
with no bundler. `src/text/` holds `splice`, which the page, the file merge
and the agent's edit share; it imports nothing, so the server half pulls in
no DOM code. Since 0.3.1 the tarball ships compiled `.js` and `.d.ts`
(`scripts/compile-lib.ts`), so an outside app needs no
`allowImportingTsExtensions`, and Web Awesome is an optional peer that only
`./theme.css` needs. The tests in `packages/app-kit/test/` run real Workers in a
local workerd through Miniflare, hibernation included; `outside-app.test.ts`
installs the tarball beside a Worker app with a plain tsconfig and checks its
typecheck and server bundle.

**Workspaces runs a board on the core when two switches say so** (D1 step
5). `server/src/collab-core-switch.ts` holds the per-board setting
(`collab-core-boards.json`, set by `POST /workspaces/<id>/collab-core`, every
board off) and the server-wide one (`collab-core-server.json`, set by the
same route, off until set; `CW_COLLAB_CORE` fixes it when the environment
sets it); a board takes the core only when both are on, so turning the
server-wide one off returns every board to the current code for every socket
opened afterwards. The owner moves a board with one tap on the settings
page's Collab core row (`workspaces-app/src/board/collab-core-row.ts`), which
sends both settings in one request.
The board and doc socket upgrades read it at connect and stamp the socket
`core`. `server/src/collab-core-path.ts` is one core room host over the doc
store's live docs: for a `core` socket it sends sync step 1 and answers the
sync frames, after `yjs-protocol.ts` has run the dead-state check and the
write gate; presence, the access frame and the probe stay in
`yjs-protocol.ts`, and the socket is still in its doc's `conns`, so the
share sweeps and eviction holds see it. Both paths sync the same Y.Doc the
doc store persists to the same `.ydoc`, so switching loses nothing.
`server/test/collab-core-board.test.ts` drives both paths side by side.
`CW_COLLAB_CORE_DEFAULT=on` starts every board and the server-wide setting
on instead of off; it is how core mode runs the suites with every test board
on the core and no test changed (`bun run test:server --core`, which leaves
out the switch's own three test files, `scripts/server-core-mode.ts`; ci.yml's
`server-core` and `client-browser-core` jobs).
`server/test/collab-core-mode.test.ts` is the control that the mode reached
the test servers, `collab-core-edit-latency.test.ts` measures an edit
reaching a second page's stored state, and
`workspaces-app/test/core-edit-latency-browser.test.ts` measures the board's
doc page's screen and has a page on another origin join a room on the core.

**A board on the core draws its presence strip from Web Awesome** (D1 step
10). The board record (`GET /workspaces/<id>?format=json`) carries
`collabCore.active`, and the switch sends the board's open pages a page-only
`collab-core.changed` frame, so `workspaces-app/src/board/presence-core-switch.ts`
swaps the strip on an open page and re-reads the record after a stream gap.
`presence-island-wa.tsx` is an `import()` chunk: `<wa-avatar>` faces inside
the strip's own buttons (`presence-island.tsx` takes the face as an option,
so press, follow and clamp are shared), and it links the Web Awesome theme
file `workspaces-app/src/wa-theme.css`, built to `/app/wa-theme.css` by
`scripts/build-wa-theme.ts`. A board on the current code fetches neither.

**A board on the core keeps history** (D1 step 12). `server/src/doc-history/`
records every saved change to a doc of a board on the core, with who made it:
the identity a socket's upgrade proved, or the identity the request being
answered proved (`event-origin.ts` carries it below the route), never a name
a page sends. `log.ts` is one append-only file per doc,
`_history/<docId>.yhist`, beside the `.ydoc` and never instead of it, so the
current code reads nothing new and switching a board off loses nothing.
`replay.ts` reads a doc as it was after any record and names who changed
each part since; `restore.ts` puts a past version back as one forward edit,
which `recorder.ts` records as a change of its own. `recorder.ts` attaches to
every doc the store wires (`DocStore`'s `onDocWired`) and records nothing
for a board on the current code. A doc destroyed (a purge, a forced board
delete) takes its log with it (`onDocPurged`); an archived doc keeps it, as it
keeps its `.ydoc`. No route serves it yet; `ServerHandle`'s
`docHistory` is the server function.

Presence and follow sit in the same folder. `presence.ts` is the server
half: one entry per tab, a person shown once at their most recently active
tab among the tabs the viewer may see (the rule
`core/src/workspace-presence.ts` already states), identity and board taken
from the connection, the role function asked again on every update and view,
a change announced only to connections that may see it, and updates past a
per-person rate limit dropped and counted. Each app passes which pages have presence and whether
app-wide presence is on; with it on, a page also shows people elsewhere, but
only on boards the app's role function gives the viewer a role on. The spot
shape and its page key are the app's, so Workspaces can pass `parseSpot` and
`samePage` unchanged in step 5. `follow.ts` is the page half, DOM-free: a
follow armed in one tab's storage, carried across the navigation it caused
(to another board too, the one the server named), and ended by the reader's
own move, as `workspaces-app/src/presence/follower.ts`
does today. `server/test/collab-presence-app.test.ts` drives both over
sockets in an app that imports only the core.
