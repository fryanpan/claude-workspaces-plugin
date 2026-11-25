# The server's edge: routes, Hono, the MCP connector, sign-in and clock loops

How a request reaches the server: how routes are placed, named and gated, how the MCP connector and its relay reach `/mcp`, the machine's own sign-in, and the loops that run on a clock.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

**A traced request is named by its route, and the table of routes is
checked.** Both sides send Sentry events, and neither may send a raw path: a
span or transaction name goes through `routePatternForSpan`
(`core/src/route-templates.ts`), which matches the path against every route
this server has as a whole-path template and collapses every segment it
cannot place to `:id`. The degrade is safe by construction, so the risk is not
a leak but a NAME: a route missing from the table arrives as `/:id/:id/:id`
alongside unrelated ones, and Sentry's N+1 detector reads two different calls
as one call twice. The templates are not written by hand: `bun run
routes:table` generates them from `ROUTE_TABLE` into a marked block of
`route-templates.ts` (core cannot import the server, so it holds a copy), and
`packages/server/test/route-templates-drift.test.ts` fails when that copy is
stale. Adding a route is its row and that one command. A route the server
answers with no row sits in the file's hand-written `WITHOUT_A_ROW` list, and
`packages/server/test/span-route-names.test.ts` still fails on any fixed-length
row the templates cannot name. The scrub floors
either side of it — key-targeted, then id-shaped — stay in
`core/src/trace-privacy.ts`, which re-exports the function.

**A file somebody else can write is read and replaced through one module.**
A walled lead runs as the owner's user and can write parts of `~/.claude` and
its own projects, so a file there may be a FIFO (a plain read blocks forever)
or a link (a plain write lands at its target). `core/src/safe-file.ts`, a new
top-level core module and, with `discovery-file.ts`, the exception to core's
no-I/O rule, holds the two moves: a non-blocking, no-follow read of a small
regular file, and a replace through a random-named `O_EXCL` temp file whose
inode is checked before the rename. The server, the plugin's hooks and the MCP
children all read the discovery file through it. Inside a walled lead's roots
the server's own reads go through `PathGuards` (`server/src/bound-path-guard.ts`)
instead. Which parts of `~/.claude` the lead may write is
`core/src/lead-wall.ts`, another new top-level core module: the wall's
profile (`scripts/lead-sandbox-lib.ts`) is built from its lists, and the
guard refuses exactly those parts and the lead's own scratch folders, while
the owner's part of `~/.claude` still reads through the guard's checked open.

**Two callers wanting the same thing share one read.** The board shell mounts
`<meeting-banner>` in each pane, so the calendar read is
`workspaces-app/src/calendar-events-source.ts` rather than the element: it
hands a second caller the request already in flight and forgets it the moment
that round settles, which is a shared read and not a cache with a lifetime.
`link-titles.ts` holds the same shape for its lookup POST, keyed per URL.

**A link says when what it points at waits on the reader.** The same lookup
answers `needsReview` per URL: `server/src/link-review-marks.ts` decides it
from the rules the Home queue already uses (a task's open review count, a
doc's own declared thread asks, and ticket items that link the doc), and the
route cuts the answer to the visitor's scope (`share/ref-scope.ts`). The
client draws one mark after the link and re-asks on the board stream's
review, thread and transition events.

**Each machine can run its own sign-in in place of Cloudflare Access.**
`CW_SIGNIN` (`middleware/signin-door.ts`) picks `access`, `both` or
`better-auth` per machine. `auth/board-signin.ts` runs Better Auth on
`<dataDir>/signin.sqlite` with Google, and loads the library only when a
machine turns it on (`auth/board-signin-auth.ts`).
`auth/board-signin-password.ts` adds email and password beside Google: four
form routes under `/auth/`, Turnstile on each, and the verification and
reset mail, with the mailer and the Turnstile check injected so tests stub
both. `auth/owner-signin-record.ts` keeps `better-auth` acting as `both`
until the owner has signed in once, so switching cannot lock the owner out.
The rules are in [security.md](security.md).

**A destructive action asks for a recent sign-in, decided in one place on
each side.** `core/src/counted-routes.ts` is the one list of the counted
methods and paths; `server/src/fresh-signin.ts` reads it, decides the
cases the body settles, and refuses one with 403 `confirm-required` when the person proof on the request
is more than ten minutes old; the request chain calls it below the gates that
proved the person. `workspaces-app/src/fresh-signin-client.ts` is the page's
half: it holds the refused request in sessionStorage across the trip to sign
in again and offers it once more on return. A page that sends a counted
action goes through `sendCounted` rather than `fetch`; the two access
writes that widen who is in, Add and Approve, go through
`board/access-writes.ts`, which wraps it for the board's Settings and
`/access` alike. The rules are in
[security.md](security.md).

**The MCP connector can run inside the server.** `server/src/connector/` hosts
the same `connector-session.ts` the stdio child builds, one per agent,
working directory and default board, behind `/mcp` (Streamable HTTP, loopback only). It is the
one place `server` imports from `packages/mcp/src`, and the direction is
deliberate: the connector is the mcp package's code, and the server only
supplies its two seams — REST over a loopback socket, so every route gate
sees what it saw from the child, and the event stream opened in-process, so
an agent the previous process was hosting is subscribed again before the
first request after a restart.

**A session's MCP child is a relay to `/mcp`.** `.mcp.json` still names
`bin/claude-workspaces-mcp.sh`. The launcher tries three children in order,
and every step down is silent and safe:

1. On macOS, a Swift relay (`plugin/relay/relay.swift`). It is compiled with
   `/usr/bin/swiftc` into a per-user cache keyed by the source's hash, and must
   pass `--self-test` before it is used. It uses about 11–15 MB idle.
2. The node relay (`mcp/src/relay/`, bundled as `plugin/mcp/relay.js`). It is
   used when the compile is impossible or failed; a failed compile is not
   retried for a day.
3. The full stdio child. It is used only with `CW_MCP_RELAY=0` (the rollback
   lever). A session whose name, board or directory is not ASCII runs a relay
   like any other: an HTTP header cannot carry those characters, so both relays
   percent-encode the identity values and send `x-cw-identity-encoding:
   percent`, and `server/src/connector/identity.ts` decodes them before it
   checks them.

A board behind Cloudflare Access (`CW_ACCESS_CLIENT_ID` or
`CW_ACCESS_SECRET_SERVICE` set) skips step 1. The node relay, the full child
and the plugin's hooks each wrap their one fetch with
`plugin/hooks/lib/access-headers.ts` (it lives with the hooks because they
import nothing from the monorepo). It reads the service token's secret from
Keychain and adds both Access headers to requests to the base URL's origin
only, following redirects itself so a hop to another origin goes without them.

Either relay does four things. It mints the agent's token at
`GET /api/agent-token`, and every `/mcp` request carries the session's
identity headers and that token. It holds a push while a tool call is in
flight. When the server is down it answers `initialize` itself, and sends
`tools/list_changed` once the server answers. Everything else — frame
handling, self-authored and bookkeeping drops, acks, watches — runs in the
hosted session. `packages/server/test/relay-stdio.test.ts` drives the
compiled relay and the node relay through the launcher against a real server:
one table of cases, each run against both, one per job (the push hold goes
through a proxy that keeps a tool call's answer back). CI runs on Linux, where
the launcher cannot build Swift, so there the compiled arm skips itself and
only the node relay runs. The Swift side is checked by running that file on a
Mac with `/usr/bin/swiftc`, which builds it; do that whenever `relay.swift`
changes.

**Where a route lives.** Everything that decides which URL paths it answers is
under `routes/`, `server.ts` composes and delegates to it and matches nothing
itself, and imports point one way: `server.ts` → `routes/` → everything else.
So `routes/shell-static.ts` (which page or asset an address gets) and
`routes/upgrade-stream.ts` (this request wants a connection, not a response)
sit there rather than at the top level, while `request-admission.ts`,
`request-attribution.ts` and `socket-handlers.ts` stay top-level because they
run for a request whatever path it named. `board-sockets.ts` joins them: it
opens one more listener per board, a unix socket, that records the board for
each request it accepts and hands it to the same front door, where
`middleware/board-socket-door.ts` holds the request to that board. It names
no path. `board-socket-roots.ts` sits beside it as a store: the projects
each walled lead can write, which `routes/board-socket-roots.ts` sets from
loopback. `bound-path-guard.ts` is the read and write the bound-file
reader (`slow-fs.ts`) uses under those roots. On macOS a path under a root
goes through `tree-fs.ts`, which walks from the root's pinned descriptor one
name at a time and never follows a link below it (its system calls are bound
in `tree-fs-native.ts`); `fs-scan-contained.ts` is the folder listing done
the same way, and `tree-fs-create.ts` holds the two calls added after it
(is a name there, make a new file). Every other covered path, and every path
off macOS, takes the plain-path checks in `bound-path-checked.ts`, judged by
where the open file really is; those helpers refuse a root's file themselves,
through `bound-root-view.ts`, a leaf module the guard registers itself in so
the helpers can ask without importing it. `guard-refused.ts` is the one error
all of them throw. `git-hardening.ts` decides where the server runs no
git at all (a repository holding such a project) and the options every
other git read passes, so a repository's settings cannot make that read
run a program. `git-contained.ts` is the one exception: an asynchronous
read inside a walled lead's own repository runs under a deny-default
`sandbox-exec` profile the server writes from the root
([lead-tree-containment](lead-tree-containment.md)). `server-options.ts` holds
`ServerOptions` so a route can name it without importing the router back, and
`review-gate-types.ts` holds the two verdict shapes a route and the gate both
need. `review-hold-message.ts` joins those two at the top level: it is the
sentences the gate says to a filer when it holds an item or admits one
unjudged, out of `review-gate.ts` so that "a hold proposes no replacement
text" is a rule with a unit test rather than a habit of one long function.
It sees no `Request` and names no path, so it is not a route. Full rule: [.claude/rules/code-health.md](../../.claude/rules/code-health.md).
The board-roles work added `routes/workspace-members.ts` — who has access and
at what level — inside a directory this picture already draws, so the picture
does not move; what a board's Owner may do that a Regular User may not is
decided in `request-admission.ts`, beside the rest of admission.
`member-home.ts` sits beside it for the same reason: the list of boards a
signed-in member sees at `/`, and the one refusal page for a board they were
not given, are answered BY the gate from the membership it just checked, so a
board the list names always opens and one it leaves out never does. It sees a
`Request` only to ask whether it is a navigation, and names no path of its own.
`socket-write-gate.ts` joins them: it judges each doc and board socket's
write against the person's role and the board's roles mode, for whatever path
opened the socket.

Share audiences (only the machine's owner changes who is in) add no box
either. `share/board-audience.ts` is each board's list of addresses and
`@domain`s, checked beside every link's; `share/access-proposals.ts` turns an
agent's widening call into an owner-only access card on a task;
`share/owner-proof.ts` is the one test that a request came from the owner's
own browser; `share/access-view.ts` builds what `/access` shows. The routes
are `routes/task-access.ts` (the door that answers a card) and
`routes/access.ts` (the owner's page and its nameless `access~` stream). In
`review-items/`, `approver.ts` records who answered, `answer-proof.ts` refuses
a person's answer the request did not prove (every answer door asks it), and
`owner-steps.ts` makes an ask owner-only when its step is one the board reserves. The one new
top-level module is `core/src/review-access.ts`: the shape of an access change
and the sentence a card says about it, read by the server and the page alike.

**And every one of those paths is written down once.** `route-table.ts`
holds the vocabulary — a gate is `trusted-local`, `loopback-only`,
`share-scope`, `owner-in-handler`, `collab-scope`, `recall-callback` or `open`
— and `route-table-rows.ts` holds the rows, one per path pattern.
`Bun.serve` mounts them as its `routes` object, so the table is a value the
process holds rather than a document that rots, and
[routes.md](routes.md) is the rendered copy (`bun run routes:table`). Both
files sit directly under `server/src/`, not under `routes/`: they name URL
paths but answer none, and the host guard reads them, and only `server.ts`
may import out of `routes/`.

The gate column IS the share allowlist, not a description of it.
`shareScopeAllows` (`middleware/host-guard.ts`) is built from the rows: a
share visitor reaches exactly the rows filed `share-scope`, `owner-in-handler`
or `collab-scope`, for the methods each lists, with every id in the path
checked against the shared board by its parameter's rule (`PARAM_SCOPE`). A
new address is refused to a visitor until its row says otherwise, and a share
row whose parameter has no rule fails at load. `test/route-table.test.ts`
still drives the guard with each row's own example address, which catches a
share row whose pattern also matches a `trusted-local` address, and
`test/share-scope-parity.test.ts` holds the guard to the verdicts the
hand-written allowlist gave before the rows replaced it. What the table still cannot see is whether an
`owner-in-handler` route really carries its refusal — that one is the
reviewer's, and the routes that have it carry their own tests.

Dispatch is one ordered Hono router on purpose: `routes/hono-app.ts`
(shared shapes in `hono-app-context.ts`). Since M12 it holds no route family
itself, only the order in which the gates, the three Hono apps and the
upgrade-and-stream run are tried, each as a middleware on `*`.
`createServer` builds its context once and matches no route itself. Bun
matches by specificity; this router's order is behaviour in eight documented
places, among them the Recall status webhook immediately above the
`/recall/` upgrade and every `…/docs/:docId/meetings…` pattern above the doc
resource catch-all. So every mounted entry's handler is the same front door an
unmatched address reaches through `fetch`, and the table is the registry
rather than the router.

**Hono, below the gates (M12).** Every route family now answers through one
of three Hono apps (`routes/hono-front.ts` builds each), each called from the
router's middleware at the position its families held in the old
hand-ordered chain, so the order is unchanged. The gates — the preflight, the
cross-origin write gates, admission, the local-only gate, attribution and the
two sign-in gates — are the router's first middleware
(`routes/hono-gates.ts`), and they run once per request. The front door
around the router — the bad-path refusal, the Sentry span, conditional GETs,
compression, the session refresh, CORS and the slow log — stays a plain
function in `hono-app.ts`: those rewrite the finished `Response`, and Hono's
`c.res` setter copies the old response's headers onto the new one, which would
put a stale `content-length` on a compressed body.

- **The open app** (`routes/hono-open-families.ts`) is tried inside the gates,
  above admission: the home feed, the board import and the GitHub hub, whose
  callers name nobody and which check their own caller. Its env is empty.
- **The front app** (`routes/hono-families.ts`) is tried below the gates with
  what they proved as `c.env`: sign-in and share (`auth-share.ts`), ops,
  mounts, prompts, the cross-board review queue, voice (page and API), access,
  Incoming Messages, the coach, the voice agent's LLM call,
  Recall's status webhook, the hosted MCP connector, agent identity, board
  tokens, board-socket roots, the repo registry, the load reports, the
  workspaces list's stream and private messages. It is tried above the
  upgrade block, so Recall's webhook still precedes the `/recall/` upgrade,
  and a websocket upgrade never enters it.
- **The upgrade-and-stream run** (`routes/upgrade-stream.ts`) is a router
  middleware. When it upgrades a socket, the middleware returns an empty
  `Response`, the router marks the request, and the front door hands Bun
  `undefined` as `fetch` did before. `test/hono-upgrade-probe.test.ts` reads
  the raw bytes on the connection and proves Bun writes exactly one status
  line, the 101, whether the upgrade happens at once or after an await, and
  whatever the handler returns afterwards. The
  three SSE openers in that run share its per-request socket judgements, so
  they stay with it.
- **The board app** is tried below that run. Its first middleware is the
  workspace scope, which puts the resolved scope in `c.var` or answers with
  its refusal; then the board families (`routes/hono-board-families.ts`) in
  the old board run's order — docs, apps, the board's own routes, tasks,
  goals, the promote, dispatches and notes, chat-audit, the Library, the doc
  move, agent attachments, archive, the board delete, a review's files,
  meetings, and the doc resource catch-all, which the meetings still precede;
  then the tail (`routes/hono-tail-families.ts`) in its order — the git-push
  feature, shell and static serving, the task address, board links, the
  stale-client 410, the wrong-prefix hint and the board's not-found page. An
  address none of them claims gets the chain's bare 404.

**Row-dispatched families.** Eighteen families are registered on their own
rows of the route table (`claimRowsWith` in `routes/hono-families.ts`), and
their handlers do not test the path. The router finds the row the raw path
matches and hands it to the handler with its `:name` params, still
percent-encoded as the request spelt them. Each module keeps a map from row
pattern to the function that answers it (`rowHandlers` in
`routes/row-dispatch.ts`). The map is checked against the table when the
module loads, and a row with no entry, or an entry with no row, throws at
boot. Adding a route to one of these families is one row and one map entry.
`test/hono-row-dispatch.test.ts` names which families are registered this
way and which still use hand-written patterns.

**Converting a family so the MCP calls it typed.** There are two ways, and
a family takes the second unless its handler is small.

- **A serving app.** The mounts family (PR 1661) moved its handler bodies
  into a chained Hono app, `routes/mounts-api.ts`, behind the family's
  existing `claimWith` line and `offBox` gate. Its `notFound` answers the
  old 405, and `mounts.ts` refuses HEAD before the app, because Hono would
  answer HEAD with the GET handler. This is right for a family of a few
  hundred lines.
- **A contract.** A family whose handler is long keeps serving as it does,
  and a contract declares the routes the MCP calls
  (`routes/route-contract.ts`; the doc threads' is
  `routes/doc-threads-contract.ts`, the doc edits' `doc-edits-contract.ts`,
  a doc's lifecycle `doc-lifecycle-contract.ts`, attachment sets'
  `attachments-contract.ts`, sharing `share-contract.ts`, an agent's
  status notes `agent-notes-contract.ts`, one task's status and fields
  `task-state-contract.ts`, filing tasks and their done-when lists and links
  `task-content-contract.ts`, the queue, the task list and the goal bands
  `task-board-contract.ts`, a ticket's review items
  `review-items-contract.ts`).
  The steps:
  1. In `routes/<family>-contract.ts`, export one interface per body and a
     chained `new Hono()` declaring each route with `json<Body>()` or
     `query<Q>()` and the handler `contractOnly`, which never runs. Use the
     path the route-answers fixture uses, parameter names included.
  2. In each handler branch, read the body as
     `sent<Body>(await safeJson(req))`. A field the branch reads that the
     interface does not declare is now a type error, so the interface has
     to match what the server reads.
  3. Where an MCP tool reads a field of the answer, declare the answer type
     and give that route `answers<Answer>()` instead of `contractOnly`. The
     branch builds its JSON as `answerAs<Answer>({...})`, naming each field
     the tool reads as a property rather than spreading it in, because a
     spread escapes TypeScript's excess-property check (`JSON.stringify` drops
     an `undefined` one, so the bytes do not change). Delete the tool's
     `as {...}` cast so it reads the typed answer. A route whose answer no
     tool reads stays untyped; the PR body lists them.
  4. Add the contract to `CONTRACTS` in `test/route-contracts.test.ts`, with
     the handlers that may answer it. A declared route whose row in
     `fixtures/route-answers.json` is missing, or answered by another
     handler, fails there. A route with no row is missing from
     `ROUTE_TABLE` too (`block_edits` was): add its row in
     `route-table-rows.ts` with the gate `route-table.test.ts` confirms, run
     `bun run routes:table`, and regenerate the fixture, whose diff must be
     that one new row. Then run `get-routes-change-nothing.test.ts`: a new
     GET row is called there too, and a GET that writes fails it. `GET
     …/docs/:docId/outline` used to (it minted missing block ids as it read)
     and had no row until it stopped. A row whose answer is the scope's 404
     (`workspace-scope.ts`) names no family: its parameter is a stand-in the
     seed never made. `route-answers.test.ts` seeds a board, task and doc
     for every row, and a folder attachment for rows naming `:setId`; a
     parameter it does not seed yet needs a real one there first, and a read
     that only answers with a query needs its `READ_QUERY` entry.

Either way, add one `export type` line for it to `routes/contracts.ts` —
the only file under `routes/` another package may import, and
`bun run check:imports` refuses the rest — add a client to `mcp/src/server-client.ts` (`import type` only), and switch
each tool's call site to `client.workspaces[':ws']….$post({ param, json })`,
passing each parameter through `encodeURIComponent`, because `hc` does not
encode them. Name each optional body field rather than spreading
`...(x !== undefined ? { x } : {})`: the spread escapes the excess-property
check, and the JSON body drops an `undefined` field anyway. Prove it with a vitest case that records each tool's method,
path and body against the old spelling (the existing tool tests must pass
unchanged), `@ts-expect-error` probes for an unknown field, a missing field,
a missing route and a wrong method, at least one probe per family on a
request field and one on an answer field, and three mutations: rename a
body field and an answer field and see both the server handler and the MCP
fail typecheck, and misspell a declared path and see
`route-contracts.test.ts` fail. No existing row of `route-answers.json`
may change. Report `build:mcp`'s bundle size before and after.

The shared types are the
top-level `hono-env.ts`, outside `routes/` only because `server-options.ts`
names one of them. `test/route-answers.test.ts` drives one request per
route-table row, plus a HEAD beside every GET, and holds every answer to
`test/fixtures/route-answers.json`: the status, the body's shape, the headers
that matter, and the module and function that answered, which
`test/route-handler-spy.ts` reads without any hook in production code. A
family that moves and answers anything differently, or from anywhere else,
fails CI.

**How a family wires itself in.** `feature-module.ts` is the shape: a family's
`start` takes the long-lived values it reads and returns its routes, its
`stop` and any values other families read. A family whose routes claim a
prefix nothing else answers is registered in `routes/features.ts`: the chain
tries every registered family at one position (where Incoming Messages sat,
below the voice API and above the coach) and shutdown stops them at one
position, so adding one is a module plus a line in that list, with no edit to
`server.ts`. `routes/inbox-feature.ts` is the first; what a registered family
may read is `routes/feature-routes-context.ts`. A family whose construction
others read, or whose teardown has a fixed place, is started by hand from
where its block sat: `meeting-wiring.ts` (in the Meetings group) builds every
meeting relay before the doc store and is disposed after the sockets close.

**What runs on a clock.** Three loops in the server tick rather than answer a
request, and all three take an injected `now` so a test moves the clock
instead of waiting: the two board wakes in the Keep-moving group (the
stall tick also records `keep-moving-verdict.ts`, the PASS/FAIL measurement
of that group, off the same snapshot the wake reads, and reads
`ui-review-gate.ts` — the one finding in the group about a task that is
MOVING, an agent-filed UI task being built with nobody's answer on it. It
stays a pure module while judging real work: the changed-file list comes in
as an injected read, which `stall-wiring.ts` builds from the dispatch
registry's worktree path and `git-diff.ts` —
[stall-check/](stall-check/README.md); the ready-work wake's idle clock —
which of the two halves counts which events — is `board-activity.ts`, read by
both `ready-nudge.ts` in memory and the store's emit choke point on disk, and
which rows one act made dispatchable is `ready-release.ts`, the pure diff of
two readings of that same ready set — the wake for a person agreeing a goal
band or closing a blocker, neither of which is a transition on the row that
became ready), and
`task-scheduler.ts`, which files an instance each time a task's schedule comes
due ([scheduled-tasks](scheduled-tasks.md)) and, on the same pass, has
`task-run-record.ts` read each rule's last run back — recording the success,
and filing one review item when a rule has gone stale — and
`task-scheduled-wake.ts` get somebody onto the instance: an addressed frame
to an attached owner, one spawn request to the fleet's spawner for a detached
one, bounded retries, then a review item. `task-run-output.ts` runs on the
same pass: a run that wrote files into the rule's declared output folder
files ONE review item linking them, replaced by the next run. It reads the
project's files through the Library's listing, which `server.ts` hands it from
`routes/workspace-library.ts`, so the scheduler never imports a route. What the loop reads — every rule
task with its cursor resolved, including the last change of the doc or task an
on-change rule watches — is `task-scheduler-rows.ts`. All of them join the
Board group under its `task-*.ts` glob rather than changing the picture — they
read and write the same tasks through the same store, and only the clock is
new. The two
wake frames render in `mcp` through `scheduled-line.ts`, beside the other
line modules.

**A verb says what it can do, in its own answer.** Two small modules exist
because a capability announced only in a skill goes unused: a skill is read
once, at session start. `attach-mounts.ts` in `server` words what an attaching
session is told about its project's mounted folders — the count and the names,
or, when there are none, what `mount_folder` does and that `.gitignore` is not
a privacy control. It sits beside `sentry-projects.ts` in the Ops group and
for the same reason: the attach answer is where a session learns what this
deployment can do for it. `schedule-output-line.ts` in `mcp` is the same shape
one layer out — it words `set_task_schedule`'s answer about the folder a
rule's runs write into — and joins the line modules beside
`scheduled-line.ts`. Neither moves a boundary: both are pure wording, read by
one caller each. `review-item-line.ts` is the third and joins them: it words
the frame for a review item filed, revised or reinstated on a TASK. Those
events carry `taskId` and no doc, so they fell through the doc-shaped tail of
`channel-messages.ts` and reached readers naming `doc_id: "unknown"` with no
task and no ask; the line module holds the wording and the two-part test for
which items are ticket-borne, and the routing decision stays in
`emitChannelMessage`.
`meeting-feed-line.ts` is the fourth: it words the two frames that put the
board's lead in a meeting, the start and each batch of the room's lines, the
lines inside an untrusted quote. Pure wording again, one caller.

`task-wait.ts` joins the Board group under the same `task-*.ts` glob and
moves no boundary either. It writes one field on a task — what an agent
declared the row is waiting on when the thing is NOT on the board, with the
time the declaration lapses — and the Keep-moving group is its only reader:
`stall-gate.ts` annotates the rows it names with the declarer's words, and
`stall-nudge.ts` stops escalating a stalled row while the declaration stands,
a filter `keep-moving-verdict.ts` shares so the row does not read as a FAIL.
The direction is one way, Board written and Keep-moving read, which is why the
new module sits beside the store rather than inside the group that consumes
it. Nothing about dispatch changes: a declared wait alters what the wake
SAYS, and `block_task` remains the verb for a blocker the board can verify.
