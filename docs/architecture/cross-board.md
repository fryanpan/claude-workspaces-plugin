# Flows across boards, servers and organizations

The cross-board review, Home across servers, the relay between organizations, GitHub events for other machines, a lead's git push, Incoming Messages, the coach, and how read wait is measured.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

**The cross-board review** reads every board at once and writes through none
of its own routes. `cross-review.ts` builds one queue from each board's Home
rows (`home-pane.ts`), sized by `review-sizing.ts` against the rates in core's
`review-size.ts` and ordered project-first by `review-plan.ts` and
`cross-review-queue.ts`. `/review` walks that queue with the board's own
walkthrough card (`workspaces-app/src/reviews/`), and each answer posts to the
board the item lives on. When an answer lands, `review-answer-ledger.ts`
records where it stood in the order last shown and how long it waited, which
is what `/api/review-wait` reads back per board. The landing page's bar and
project list are `landing-review.ts`, with each project's one-line summary
from `board-summary.ts`; the bar counts waiting items per project and needs no
script, so the app's `landing-review-bar.ts` is gone. Choose-difficulty is off
unless a browser turns it on (`review-sizes.ts`); when on, the size a person
picks is kept per signed-in identity by `review-size-prefs.ts` (the browser's
copy is only a cache), and the project
order comes from a hand-edited `review-plan.json` naming the plan board —
there is no route that sets it.

The plan board's lead may rank single items on any board, and the queue puts
ranked items first, lowest rank first, with every unranked item in the order
above (`applyLeadRanks` in `cross-review-queue.ts`). The ranks are kept on the
plan side in `review-ranks.ts` (`review-ranks.json`), not beside each item,
and a person moving a task after the rank voids it. `POST
/api/review-queue/rank` is the one write, open only to that lead with its own
agent token (MCP verb `rank_review_item`). It takes an item by any name the
lead was handed for it — the feed's queue key, Home's board-relative
`?item=` key, or a ticket item's own `r-` id — and, when a ticket item the
name points at is off the queue, answers why (held, answered, task done)
rather than `not-found` (`review-key.ts`). The lead hears what to rank from
`ask-feed.ts`: every new review item on another board, batched over a
10-minute window into one addressed `workspace.new_asks` frame carrying board,
row, key, headline and filing time, never the detail. The feed and the
ranks cover every board, including one that is private or that the coach is
off for: the lead sees what the owner sees (the owner, 2026-10-23), and
the coach's own switch (`coach/exclusion.ts`) applies to the coach alone. A lead stream opened off this
machine (through the tunnel, or from a peer that is not loopback) gets the
frame without the asks from local-only boards and docs (`offBoxAskView`,
which `routes/upgrade-stream.ts` hands both stream kinds as their transform).
The window is `held-window.ts`, which the coach's session feed uses too, and
`lead-rank-wiring.ts` composes the three against the stores.

The same verb also files an item under a goal tag: a plan-board goal id,
`urgent`, `not-this-week` or `drop`. The tag is stored beside the rank and a
person's move voids it the same way. Once any open item carries a tag that
Home can show, the landing bar becomes `landing-goals.ts`. It shows the lead's
Top 10, and then the items by goal: urgent first, the plan's goals in order,
the untagged items under one count line, and not-this-week and drop folded.
Each row opens `/review?item=<key>`. With no tags, the bar is unchanged.

An open landing page stays current. `landing-changes.ts` taps every SSE
broadcast, keeps the task, goal, review-item, decision and thread events, and
sends one `landing.changed` frame per 250ms burst on
`/landing/events:stream` (`routes/landing-stream.ts`). The page's
`landing-live.ts` then re-reads `/` and swaps the review bar and the board
list, keeping the open tab and folds. A lead's rank is broadcast nowhere, so
the rank route calls the feed directly.

**Home across servers.** Bryan's Home on the Mac also lists the review items
on boards that other servers hold. The Mac pulls them and no server calls the
Mac. `home-remotes.ts` reads the board router Worker's own table
(`infra/board-router-worker/`, `BOARD_ORIGINS`) with the Worker's own parser,
and for each board listed under another origin it holds one stream open
through the one address: `GET /workspaces/<board>/home-feed/events:stream`,
with that server's Access service token. Each `landing.changed` frame on it
makes the Mac re-read `GET /workspaces/<board>/home-feed`
(`routes/home-feed.ts`), and a feed that changed tells open Home pages to
redraw through the Mac's own `landing.changed`. `home-feed.ts` is the fixed
schema both ends spell, and the check the Mac runs on every row: named fields
only, each type- and length-checked, a bad row dropped and counted, and a link
kept only when it is a same-origin path to a board the table says that server
holds. `landing-remote.ts` draws the rows as escaped text inside
`#landing-review`, so the page's existing swap redraws them. The feed route
answers above request admission, with its own gate, because a service token's
stamp names nobody (security.md).
A server running `CW_SIGNIN=better-auth` has no Access in front, so the Mac
pulls its boards with each board's own agent token (`at2`) instead, named in
the config's `boardTokens`; `home-remote-tokens.ts` renews each one past half
its life and keeps the renewed value in the data directory, mode 600. The feed
route admits an `at2` only for the board its path names. The org relay's
`at2` needs no service token there either: the board agent door skips the
Access check when no Access is in front.

**The relay between organizations.** `org-relay/` carries agent messages
between project servers, and runs as a process of its own, not inside the
server: it holds every project's token so that no lead has to. A seat sends by
opening a thread on its outbox doc on its own board, first line `to: <seat>`.
The relay reads each outbox with that server's credentials, so the sender is
the outbox's seat, never a name the message gives. `relay-config.ts` reads a
mode-600 file naming the servers, their organizations and the seats on them;
a seat's organization is its server's. `relay-rule.ts` delivers inside an
organization, refuses across one unless the sender and the recipient both
hold cross-organization access, and runs the fixed checks. `relay-filter.ts` is the Haiku classifier,
on the review judge's model and key path, which every cross-organization or
untrusted message passes; a flag, an error or a timeout holds the message.
`relay.ts` delivers onto the recipient's inbox doc as a quoted subject thread
marked with its source, and `relay-log.ts` keeps the append-only log (no
bodies) and the hold queue that `relay-bin.ts release <id>` empties. Every
call is an existing thread verb (`relay-client.ts`). The relay takes a
thread as the seat's only when the server says the seat's own board token
opened it: `thread-opener-proofs.ts`, top-level in the server beside the doc
store it decorates, keeps that record outside the doc and the thread list
returns it as `openerProof`. It joins the doc-store group and moves no
boundary. Tests: `org-relay-two-servers.test.ts` (two real servers),
`org-relay-units.test.ts`, `org-relay-sender.test.ts`.

**A dead board on another server reaches Team Lead on the Mac.** A board's
own stall escalation looks for Team Lead only among the boards its server
holds, and Team Lead's stream is on the Mac, so a project machine whose lead
dies files its last-resort item for the owner and Team Lead hears nothing.
The machine's home feed carries the board's escalation while it stands
(`escalation`: when the board was first found dead, how many tasks are
stuck, the lead's agent id), and the Mac's stall pass hands each remote
board's view to `remote-escalations.ts` (Keep-moving group), which sends
Team Lead one `workspace.stalled` frame per dead stretch with a `remote`
field naming the origin. It rides the existing pull; nothing new calls the
Mac. Tests: `remote-escalations.test.ts`,
`remote-escalation-across-servers.test.ts`.

**GitHub events for boards on other machines.** GitHub is read once, by the
broker on the Mac (`~/dev/github-claude-channel`, 127.0.0.1:7902, the
owner's token). A board on another server holds no GitHub token: it stores a
subscription list, each entry a repo and the kinds wanted (ci, review,
mention, merge, issue, deploy), and the id of its one live push key
(`github-hub.ts`, `<dataDir>/github-hub.json`). Agents set the list with
`set_github_subscriptions`, from the board's own machine.
`github-relay/` runs on the Mac as a process of its own, like `org-relay/`:
for each configured board it reads the list with the board's push key, holds
one broker session watching those repos, and pushes each matching line
(`routes/github-hub.ts`). It reads the broker's `/state` every pass and
registers again when its session is gone, because the broker answers a poll
for a session it forgot with an empty list. The board checks every push
against its own list again and sends it to each agent holding a stream on it
as one addressed `workspace.github_event` frame, which the MCP child renders
with the text quoted (`github-event-line.ts`). Pages never receive it. Tests:
`github-relay-two-servers.test.ts` (two real servers and a stand-in broker,
restarted), `github-hub-routes.test.ts`, `github-hub.test.ts`,
`github-relay-units.test.ts`.

**A lead pushes a branch through its board server.** A sandboxed lead,
walled on the Mac or the `lead` user on a project machine, holds no GitHub
credential. It makes a git bundle of its branch and posts it over its
board's own socket to `POST /workspaces/<board>/git/push?repo&branch[&task]`
(`routes/git-push.ts`, a registered feature). `git-push/pusher.ts` judges
it against the board's list in `<dataDir>/git-push.json` (`policy.ts`; no
route writes it), reads upstream's default branch and the branch's tip,
refuses the default branch and any tip that does not descend from upstream's,
and pushes from a work repository made for that push, which borrows only
upstream's objects from a mirror (`run.ts`, `git.ts`). git reads the
credential from a mode-600 file for each call, never its arguments or
environment (`credential.ts`: a Fly secret on a project server, a Keychain
item on the Mac). Unless the repo opts out with `"approval": false`, and on
every repo when the push touches `.github/`, it files a decision item with
`step: 'push'` and pushes only when a person's answer chose Push and that
person is a member of the board. Only the board's
socket may ask; loopback TCP is refused. Tests: `git-push-route.test.ts`, `git-push-approval.test.ts`,
`git-push-units.test.ts`.

**Incoming Messages** is a section on the landing page that lists the
message threads an inbox reader agent judged worth Bryan's time. It is not a
board feature. `inbox/` holds the store (`rows.json`, with
the message text kept apart in `bodies.json`, both mode 600, soft delete
only), the per-field checks the reader's rows pass, the rank and the
server-drawn section. `routes/inbox.ts` has two gates that never overlap.
`POST /inbox/rows` is the one write path, open only to the configured
posters, each with its own agent token: the reader, and the agents in
`posterAgentIds` (Job Search posts the recruiter leads it judges worth his
time). The MCP verb for it is `post_inbox_rows` (`mcp/src/tools/inbox.ts`).
A post may also dismiss rows as handled elsewhere, by thread id; the move
is a history entry by `agent`, and the row waits in the removed fold for
Bryan to bring back. A post may name the poster's own scheduled run,
and `inbox/run-close.ts` moves it to done through the task store's
transition, the one place this section touches a board. The body read and Bryan's taps need an owner
person proof from the front page's origin. `landing.ts` in the same folder
draws the section only for that proof. The behaviour is
`workspaces-app/src/landing-inbox.ts`, inside the landing bundle. Nothing
here emits an event of its own, so no row reaches an agent's stream; the run
close emits the ordinary `task.transitioned`, with counts and no row text.
Bryan's Send is `inbox/reply.ts`: it checks the words and the nonce,
rebuilds the destination from the row (`reply-target.ts`), and hands it to
the one transport seam (`send-transport.ts`), behind which `send-gmail.ts`
and `send-slack.ts` read their Keychain credentials (`send-keychain.ts`).
`sends.ts` keeps the ledger the nonce and the hourly limit read. The reply
box is `workspaces-app/src/landing-inbox-reply.ts`, and the snooze picker,
the key list behind `?` and the Undo toast are `landing-inbox-modals.ts`
beside it. Bryan's Remove is a tap like snooze: the row goes to `dismissed`
with no reason, and a new message on its thread reopens it.
`workspaces-app/src/standalone-viewport.ts`, in the same bundle, makes iOS
re-measure the viewport after a text field blurs in a home-screen app, because
iOS is reported to leave it at keyboard height.

**The coach** helps the owner with habits he names, in three parts. It is not a
board feature; the one agent it reaches is its own session.
(A) *Goals*: `POST /coach/setup` makes one learning-goals doc
and the session's Coach memory doc on a board of their own (`coach/setup.ts`,
`coach/goals-doc.ts`). The docs are filed on the Coach board and name no
attachment set, so its Library lists them; `library.ts` also treats a set
field holding the board's own id as no set, for docs made before that; the planning interview fills the goals when he taps
Talk. The doc has the coach's name and one section, "What I want to do
better": each top-level bullet or paragraph there is one goal and names its
own trigger. A doc in the older layout, one section of four parts per goal,
still reads, its "Act differently when" joined to each goal. Home carries no coach (the owner: "Coach should not be on home page"); the
card and the goals doc live on the Coach board.
(B) *Observe*: board and doc pages send what he is looking at, and each
paragraph he writes when he pauses, to `/coach/here`
(`workspaces-app/src/coach-card.ts`); the review walk,
which names no board, sends which page it is (`PAGE_PLACES`, which still
accepts `home` from a Home page loaded before the coach left it); `coach/stream.ts` turns that and his
own comment, reply and open rows (through `onActivity` in `activity.ts`)
into one event per thing he does, dropping repeats. The coach's visibility
is the owner's own: every board he can see, local-only, sharing-locked and
shared ones included, minus the boards he turned off from the card ("Coach
off for this board", `POST /coach/boards`), from which `coach/exclusion.ts`
drops everything (the owner, 2026-10-28: "All boards. Team Lead and Coach may
have access to everything I have access to."). A doc on a board he turned off
is off wherever it is viewed, and when the boards holding a doc cannot be read
it counts as off. What reaches the coach from a shared board is only his own
actions there.
(C) *Intervene*: `coach/moment.ts` sends every event, his answers and his
how-readily setting to the coach's Claude Code session, the Coach board's
lead, as addressed frames (`coach/session-feed.ts`). Events are held: the
first opens a 15-minute window, which then goes as one digest
(`coach/digest.ts`: a run of views is a place and its minutes, and what he
wrote, commented or replied keeps its words). Each digest also carries the
plan board's goals in board order with the day the list was last set, marked
possibly stale past eight days, or says there is no current week plan
(`coach/week-plan.ts`). It also lists his Claude Code time per attached session, the repo and its
active minutes, counted from each prompt he typed (the plugin's
UserPromptSubmit hook posts typed-or-not, and a typed prompt's reduced text,
to `routes/prompt-marks.ts`) through the turn notes and injected prompts after
it, each crediting the gap since the session's previous mark, capped, never
for the coach (`coach/session-minutes.ts`). Haiku says each prompt and turn
in a line, 40 marks a call (`coach/summary.ts`); the text stays on the
server. A hook in a session launched with no board posts to the one board
where that session holds a stream (`plugin/hooks/lib/joined-board.ts`), and a
`claude -p` or SDK run counts as nobody typing. A typed prompt opens a window as
a board event does, and so does any mark in his run after it; a mark outside a
run never does. `coach/coverage.ts` counts, per hour, what he sent by source
(desktop, iPad, phone, Remote Control, terminal), what the coach let go and
why, and what the digests carried, for the loopback `GET /coach/coverage`. A quiet stretch sends nothing,
and answers and the setting go at once. With no session holding a stream
the windows wait in `coach/backlog.json` (`coach/backlog.ts`, bounded to 96
windows and 48 hours, across a restart) and go as one digest when its stream
comes back. Past 400 turns in a day it sends
nothing until the next day. The session raises a moment on `POST /coach/moments`, and
`coach/judge.ts` refuses one that does not copy three words in order from the
goal it names, or arrives while another is open. A moment goes to his pages over
`/coach/stream` (`coach/hub.ts`) and follows him: every page he has open
shows it until he answers in any one, which clears it on the rest. That is
the board (task pages included), every doc surface (`doc/doc-coach.ts`,
mounted for markdown, folder files, diffs and code alike), the review walk,
and the host page around a mock or dev server (`coach-page.ts`, its own
`/app/coach.js`, since the sandboxed frame cannot draw it). A page on a
board that is off for the coach shows it too, marked so, and tells the
session nothing. He answers with a thumbs up, or a thumbs down with a few
words of why that reach the session in `coach.answer`. In the session, `mcp/src/coach-line.ts` renders each frame and
`coach_moment` raises a moment; the persona is the plugin's `coaching` skill.
With no session holding a stream only the digests wait for it. `coach/store.ts` keeps it all in `coach/state.json`, mode 600;
`coach/wiring.ts` composes it for `server.ts`. `scripts/coach-eval.ts` plays
the fixture days to a real coach session and scores it.

**How long an item waited to be READ** is two rows on the board's own event
log, and nothing else: `review_item.viewed` when somebody's client first puts
an item on screen, `review_item.answered` when an answer lands on it. Both are
built in `server/src/review-items/analytics.ts` and nowhere else, so
"ids and timestamps only, never the ask and never the answer" is a property of
one function rather than a rule six emit sites remember; they land in
`<dataDir>/workspaces/<ws>.events.jsonl` beside every other board event, and
`workspace-next.ts` strips them from the Activity feed the way it strips ticks.
The browser half is `workspaces-app/src/review-item-seen.ts` — one
`IntersectionObserver` and one per-page ledger shared by the three surfaces
that show an item (the walk card, the task panel's card, a doc thread's card),
so meeting the same ask twice in one page load is one row. Neither adds a
subsystem: the server module joins the review-item family under `routes/`, and
the client module is chrome-free measurement with no UI of its own.
