# Which channel carries what, and when an agent is woken

The three transports (Yjs, REST, SSE), how an agent reads outside comments as quoted data, and the rules that keep an agent from being woken by news it cannot act on.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

**Which channel carries what.** *Yjs*, one WebSocket per document, carries what
two people watch change under each other's cursors: text, threads, replies,
suggestions, anchors, presence, live notes. Agents hold no replica, so an agent
edit is a REST call the server applies to the doc. *REST* carries what needs the
server as an authority — sign-in, binds, diffs, shares, deploys, and the board,
where a write is a decision with an author and a gate rather than a merged
value. *SSE* pushes changes to anyone holding no Yjs socket for them: one stream per
document at `/events/<docId>`, and one per board at
`/workspaces/<id>/events:stream`, which carries every thread event on any
member doc of that board or diff review — what an agent's `watch_doc` holds
instead of a stream per file (`routes/upgrade-stream.ts`, and
`board/board-live-wiring.ts` in `workspaces-app`). Both the colon and the
`/workspaces` prefix are deliberate, and the board stream moved to this
address on 2026-09-05 to get them: a bare `events` segment under a board path
is the activity feed's name, and a workspace id sitting outside `/workspaces`
could not be read by the guard that reads every other board path. The address
it moved off is recorded once, in [glossary.md](glossary.md).

**An agent reads a comment from outside the board as quoted data.** Every
member of a board directs its lead (Bryan, 29 Oct), and anyone else who can
reach a doc can still comment on it. The server stamps each thread frame's
comment, and the comment a reply answers, `owner` when the author's identity
id is the owner's (`commentTrustOf` in `packages/server/src/actor-identity.ts`)
and `member` when that id names a person whose email the audience of every
board the doc reaches admits at that moment (`packages/server/src/comment-trust.ts`,
asking `audienceMemberOf` in `board-membership.ts`). Never by display name,
which a visitor types. A `member` stamp carries the boards it was decided
against (`trustBoards`), and the child trusts it only on a board the session
is attached to. The MCP child renders both as ordinary lines and quotes
every other comment, an unstamped one and an unknown stamp inside a labelled
`untrusted-comment` block whose markers a comment cannot forge
(`packages/mcp/src/untrusted-quote.ts`).

**An agent gets no wake for an event it cannot act on.** Three rules give that,
and none of them hides state.

*Its own action.* The MCP child drops a frame whose actor is this session, so
an agent's own comment, review item or task move costs it no turn. Every other
reader still gets the frame, and one whose actor the child cannot identify is
always delivered, because an agent cannot detect silence. Rules in
`packages/mcp/src/self-authored.ts`.

*A comment addressed to somebody else.* A comment can name who it is for
(`to` on thread create and reply). The server resolves each entry against the
roster of the doc's boards (`addressees.ts`: the owner, a member, or an
attached agent) and writes the result as `addressedTo` on the comment; core's
`addressed-to.ts` reads it back defensively, like every comment field. Only
those agents get a comment-queue row and the board-channel frame
(`stall-wiring.ts`, through `SseBus.broadcast`'s `agentAudience`), and each
person named hears it on their own `person~<id>` channel, which only that
person's proof opens (`GET /workspaces/<id>/me/events:stream`). Pages still
show the comment. A doc channel cannot tell an agent's stream from a page's,
so the MCP child drops a comment addressed to others there
(`packages/mcp/src/addressed-elsewhere.ts`). An open thread whose latest
comment names people carries `waitingOn`.

*A private message.* A person writes to their own linked lead agent at
`/api/me/messages`, and the agent answers at
`/api/agents/<id>/messages/<personId>` (`routes/private-messages.ts`). The
log is one append-only file per pair (`private-messages.ts`, mode 600, no
delete verb). The person's message becomes one comment-queue row and one
`sendToAgent` frame for that agent alone; the agent's reply goes out on the
person's `person~<id>` channel. Nothing is broadcast on a board channel.

*An analytics event.* `review_item.viewed` records that a person opened a card
and changes nothing, so the server keeps it off the fan-out while the audit log
still gets the row. `review_item.answered` is kept off too: a ticket answer
reaches its filer and the lead as `decision.answered`, which carries the
words, the task's title and the item's id, so one answer is one wake. The
list is in
`packages/server/src/review-items/analytics.ts`.

*An act with no words.* A resolve is a status flip and carries no text, so the
MCP child drops the frame before it becomes a wake. It drops it for every
reader, not only the session that resolved the thread, which is what separates
this rule from the self-echo one. A resolve retires each review item on its
thread, so a resolve that closed an unanswered ask still wakes: it is the only
report that reaches the agent who asked. Rule in
`packages/mcp/src/bookkeeping-events.ts`.

*A second frame for one act.* A question asked on a review item's thread
arrives as the thread's `thread.created`, with the words, and as
`decision.info_requested`. The board page reads the second, so the server
sends it, and the child drops it when it carries a `threadId`. A typed "tell
me more" has no thread, so its `decision.info_requested` still wakes. Rule in
`packages/mcp/src/bookkeeping-events.ts`; `packages/server/test/one-wake-per-answer.test.ts`
counts the wakes for an answer and for a comment.

*An act with one reader.* A review item WITHDRAWN on a ticket does carry a
request, but only for the agent that RAISED the ask: its question went away.
Nobody else on the board has anything to do, and everybody else is the common
case — any agent may retire a stale ask, and the server's own auto-withdrawals
fire as a board actor that the self-echo rule suppresses for no one. So the
store stamps the filer's id on that event and the child delivers to that
session alone
(`readsThisReviewItemEvent` in `packages/mcp/src/review-item-line.ts`). A
filing and a revision are not addressed this way: those are news to the board.
The id is stripped from a visitor's copy with every other id
(`packages/server/src/share/redact-board-events.ts`).

Which rule runs where depends on what it reads. The server drops by event name,
which reaches every attached session at the next prod restart. The child drops
by what the frame carries, because that is where the frame is — and the third
rule needs the reader's own identity, which only the child has.
