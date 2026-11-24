# Comments, review items on a page, and the widget's thread list

How a comment is made, placed, delivered and answered on a doc, a mock or an app, and how a review item is answered where its comment lives.

> Moved out of [overview.md](overview.md) on 2026-11-24, when the overview was cut to a map. "The diagram" and "the picture" below mean the package diagram there.

**An agent comments on a page it cannot see.** `create_thread` on an app or a
mock takes `find` as the words the page shows, and an app also takes `path`,
the page inside it. `page-thread.ts` (beside `app-proxy.ts`) turns those into
an element anchor whose fingerprint is the words alone, with the address the
widget in the frame reads as its context, and refuses what it cannot honour
before anything is written. Such a fingerprint resolves to the smallest
element that says the words (`resolveWords` in core's `anchor/element.ts`),
which the budgeted bundle reaches only through `window.cwWords`: the lazy
edit chunk installs it when the doc holds a words anchor, then redraws the
pins. An optional `suggest` stores new words on the first comment; the same
chunk (`edit/edit-suggest.ts`) shows them in the popover with Accept, which
files a pencil-style `pageEdits` thread and resolves the suggestion, and
Reject, which only resolves it. The same chunk redraws an edit's comment in the widget
as its word diff (`edit/edit-diff-view.ts`), since the budgeted bundle shows
every comment as plain text.

Every link to such a thread is the page plus `?thread=<id>`, built by
`page-thread-link.ts`, a top-level module of core so the server and the
board client share it: the agent's `threadUrl`, a review item's push
(`review-gate.ts`), the Home opener (`board-queue-open.ts`) and the
cross-board review (`cross-walk-model.ts`), the last two through
`board/doc-thread-href.ts`. An app's Home-queue row carries `pageUrl`, its
thread's anchor context, because the client has no anchors to read it from.
A page outside the doc falls back to the doc itself.

**A review item raised on a mockup is answerable on the mockup.** The ask used
to live only on the ticket, so a reader opened the mock, looked at it, and
then left for the Home queue to say what they thought. `widget-dock.ts` — a
new top-level module of the widget package, beside `widget-picker.ts` and
`widget-threads.ts` — draws the standing ask as a bar across the bottom of the
page it was raised on, opens it with every earlier ROUND still readable, and
answers it through the route the doc page already answers through
(`…/threads/:id/answer`). It joins no new data flow: a review item IS a
payload on a comment, so the dock reads the same synced threads the pins read
and adds no fetch of its own. The Home-queue entry for such an item deep-links
to `/workspaces/<ws>/mockups/<doc>?thread=<id>`, which is why a queue entry now
carries the doc's `type`.

An ask filed on a TICKET is docked on the mock it links, too. Those items live
in `task.reviews`, not in the mock's threads, so the server resolves them
instead: `mockup-linked-items.ts` (server, beside the other `mockup-*.ts`
modules) takes the Home queue's own ticket rows (`taskReviewItems`), keeps the
ones whose detail links this mock — or, for an ask that names no page, whose
task links it — and writes them into the served page as a JSON data block. The
widget reads that block once at load and answers such an item through the
ticket's own route (`…/tasks/:id/review-items/:rid/answer`). Still no new fetch
and no poll, and a share visitor is served no block: the dock shows a visitor
only the mock's own thread asks.

**The doc page draws the same dock.** A bound doc that a ticket's open ask
links shows that ask in the same bar, answered through the same ticket route.
So the dock's rules, markup, sheet wiring and stylesheet moved to `core`:
`review-dock.ts` (third tier, beside `review-item*.ts` — which asks dock, the
bar and sheet as strings, and a wiring function over the element its caller
made, so core still touches no `document`) and `review-dock-styles.ts` (the
one CSS literal, which the widget build's minifier matches by name). The
widget keeps `widget-dock.ts` for its own half. The doc page's half is
`workspaces-app/src/doc/linked-dock.ts`, mounted by `doc-floats.ts` off the
same doc-record read, in a shadow root so the sheet applies unchanged. The
items ride the doc record the page already reads — `linkedItems` on
`GET …/docs/<id>?format=json`, from `mockup-linked-items.ts`'s
`boardLinkedItems`, left out for a share visitor and when empty — so this too
adds no fetch. The bar's measured height is `--doc-dock-h`, which `doc.css`
takes out of `#shell` and adds to the composer, toast and phone comment sheet.

**A meeting's notes take comments like any other doc.** `doc-floats.ts`
mounts one float, the plan gate's Approve (`plan-gate.ts`), on a doc an agent
marked a pending plan. Meeting-notes and plan docs also carried Make Plan and
a Review float (`review-float.ts`), and a range selection there grew a
separate pointer pill (`pointer-pill.ts`, `doc/doc-pointer-pill.ts`) instead
of the round comment pill. Bryan removed both buttons on 2026-11-09, and the
three modules went with them: every markdown doc now gets the same comment
pill (`doc/doc-comment-pill.ts`). The server's `plan-request` and
`review-request` routes are unchanged and now have no caller in the page.

**A thread's ask is answerable in that thread's popover.** When an agent
answers a reader's comment with a review item, the popover the reader opens
shows the item: its latest round, the detail with its links, a button per
option or a question's answer box, and how it was answered once it was.
`widget-ask.ts` is a top-level widget module, but it ships in `mic.js` and
`mockup-live.js`, not in the budgeted bundle. Its source of truth is core's
`threadAsk`, which `dockItems` now also calls, and it reuses core's
`wireAnswer`, so the two places that answer an item cannot disagree. It reads
the raw thread map, as `edit/edit-suggest.ts` does, so the chunk carries no
Yjs. The budgeted bundle's only addition is a `data-thread-id` on each panel
row, which the module uses to mark rows that have an open ask. No new route:
the answer goes to `…/threads/:id/answer`, which a mock frame's relay already
allows for this doc alone.

**A thread can carry a review item from another board.** An agent attaches an
existing item, filed on any board this server holds, to a doc or mock thread
with `link_review_item`, which posts to `…/threads/:id/linked-items`
(`routes/doc-thread-linked-item.ts`, closed to share visitors).
`linked-review-item.ts` (server, beside `mockup-linked-items.ts`) resolves the
item on its own board, a ticket item from `task.reviews` or a thread's review
payload, and checks it is on the board the caller named. The route posts one
comment through the ordinary reply path, so an open page gets it over the
doc's sync. The comment's `linkedItem` is a snapshot: that board's name, the
headline and the root-relative link the board opens the item at. Its `text`
says the same in words for surfaces that render only text. Core's
`linked-item.ts` reads the stored field and drops one whose link leaves the
origin. Its `listThreadsWithLinks` is what the server's thread reads call;
`readThread` leaves the field out, because `schema.ts` ships in the widget's
budgeted bundle and the reader does not fit under its ceiling.

**The widget's panel lists the threads on the page the reader is on.**
`widget-page-list.ts` draws the list, this page's threads newest first, then
the ones with no spot left, then other pages. A tap on a row takes the reader
to the thread's page state and shows its spot. Like `widget-ask.ts`, it ships
in `mic.js` and `mockup-live.js`, and the board mounts it beside its mic. The
budgeted bundle no longer draws a list. Each render hands the threads it read
to the element's `listHook`. A pin now matches on the path
(`samePage` in `core/anchor/context.ts`), and a thread made with other query
controls set gets a dimmed pin. Tapping it loads that address through
`widget-goto.ts`, which leaves the thread's id in session storage for the next
render to show. `widget-thread-text.ts` holds the snippet and receipt markup
that the popover and the list share. No new route and no new fetch.

**On a served mock the list is the comment view.** It shows every open
thread in the doc, not only this page's: the threads with a reply the reader
has not opened under New at the top, then one group per page in the order
the page's own links name them, then the ones with no spot. A pin's tap opens
its thread in the view, and the popover the budgeted bundle draws moves into
that thread's card. `comment-view-model.ts` decides the groups without a page,
`comment-view-card.ts` draws a folded card and a linked item's row,
`comment-view-css.ts` holds the view's and the page's styles, and
`link-badges.ts` puts each page's open count on the links to it.
`comment-seen-store.ts` keeps what this reader has opened under
`cfw:seen:<docId>`; in a mock's frame `mock-bridge.ts` hands that one key to
`mock-host.ts`, which keeps it for its own doc only. The board's bar above a
served mock (`mockup-frame.ts`) carries the Comments button and a steady dot
for something new: the host posts the frame `{cw:'comments'}` on a tap, and
the frame answers with `{cw:'comments-state'}` after each render. All of it
ships in `mockup-live.js` and `mic.js`, outside the budgeted bundle. No new
route and no new fetch.

**An agent marks a person's comment in progress or done, and the comment
stays until the person resolves it.** `set_thread_progress` posts to
`…/threads/:id/progress` (closed to share visitors), which writes a
`progress` field — state, who, when — on the thread's Yjs map, so an open
page sees it as the doc syncs. No thread frame is fired: an agent has
nothing to act on in another agent's mark. Core's `thread-progress.ts` reads
and writes the field; `listThreadsWithLinks` adds it to every server thread
read, and `readThread` leaves it out for the budget reason above. Any status
change clears it, and so does a person's reply on a done thread. In the
widget, `comment-extras.ts` reads it off the doc with the linked items, puts
the state word in each card, the "working on this" line in the opened card,
and the state on each pin. It ships in `mic.js` and `mockup-live.js`. The
board's own doc and task pages do not draw the mark yet.

**A comment's markdown is drawn rendered in its popover.**
`widget-comment-markdown.ts` rewrites each popover comment the budgeted bundle
drew as escaped words: links (`http:`, `https:` and `mailto:` only), bold,
italics, inline code, lists and fenced code, built as DOM nodes so no comment
text is parsed as markup. Like `widget-ask.ts`, it ships in `mic.js` and
`mockup-live.js`; the budgeted bundle is unchanged. It leaves a page-edit
comment alone, because `edit/edit-diff-view.ts` finds those by their exact
words.

**A pin follows an element whose words change a little each round.** The
resolver in core's `anchor/element.ts` takes the element of the anchor's tag
that says most of its words, over half of them, and none when two are equally
close. Over three rounds of a rewritten mock that is not enough, so the page
reports what each pinned element says now: `widget-anchor-refresh.ts`, called
from the page list's `listHook` in `mic.js` and `mockup-live.js`, posts the
element's fresh description to the thread's existing `…/reanchor` route with
`refresh: true`. It reports only an element that says over half of the
anchor's words with no other element of its tag as close, on the page state
the thread was made in, and not while a mock shows an older round. The server
(`core/anchor/refresh.ts`) moves only the fingerprint and snippet, keeps the
thread's context and tap spot, and stores the anchor as first made under
`firstAnchor`, once. The write lands in the doc's Yjs map, so every open page
redraws from it. A share visitor's report is refused unless the visitor is
the board's owner.

**A comment that never reached the server says so, on the comment.** Every
composer on every surface already handed the words back when a post was
refused; none of them left anything standing to say why, so a box holding your
sentence looked exactly like one you had never sent from.
`workspaces-app/src/not-sent.ts` is the one affordance all of them now draw —
a button reading "Not sent — tap to retry", beside the draft, clearing on a
retry, on a send that lands, or on the next keystroke. It joins no data flow
and reads no state: the four call sites (the board's `ComposerForm`, the doc
card's reply and its folded answer field, the doc's new-comment composer) hand
it the box, the control to sit beside, and the same send to run again. The
widget says it in its own `composerNote`, for the bundle's sake. The server
half is `server/src/comment-log.ts`, one stamped `[comment]` line per write
through `docStore.postComment` — the choke point all three write paths share —
carrying the doc, the thread, the author and the LENGTH of the text, never the
text. Between them, the next lost comment can be told from one nobody sent.

**Enter sends in every comment box.** `core/src/send-key.ts` (a new top-level
core module) is the one keydown rule: Enter or Cmd/Ctrl+Enter sends,
Shift+Enter is a line, and an IME's Enter never sends. The board's
`ComposerForm`, the walkthrough's answer box, the doc card's reply and answer
field, the doc's new-comment composer and thread view, and the widget's two
boxes all call it, and each hands it the same send its button runs, so an
empty box refuses Enter the way it refuses the button. It takes structural
types, not DOM ones, so it touches no `document`.

**And a comment that DID reach somebody says that too, on the comment.** The
other half of the same question: one grey tick means the server has it, two
mean a session watching the doc was handed it, and both disappear once a reply
lands. The decision is `core/src/comment-receipt.ts` — pure, DOM-free, so the
board, the review editor and (one day) the widget cannot come to disagree
about what a tick means — and the durable fact is a write-once `deliveredAt`
on the comment itself, stamped through `core/src/comment-delivery.ts` so it
syncs, survives a reload and rides the REST threads payload the board already
reads. The judgement is `server/src/comment-receipt.ts`, dependency-injected
over `SseBus.agentsOn` because delivery means a LIVE stream, never a line in
`agent-watches.json`; `stall-wiring.ts` calls it where it already knows a
comment's board channels, and `recordDelivery` writes the stamp once and
broadcasts a transient `comment.delivered` to pages on every channel the
comment travelled. Its other caller is the heartbeat route's hand-over of a
PARKED comment (`routes/workspace-attachments.ts`), which is where most second
ticks are set: a comment written while nobody was listening reaches a session
when that session attaches, and no doc event fires for it. On the client every app surface now draws its comment header
through `workspaces-app/src/comment-view.ts`, one module owning the structure
and the mark's position with a class-name variant per stylesheet — because a
feature added to "comments" that reaches one surface out of four is the
failure that module exists to make impossible.

**The comment card stands where its comment will live.** In comment mode the
composer is a card fixed to the right edge of the viewport at its element's
height, joined to the element by a faint line, and on post it becomes the saved
card with a tick; at phone width it is a compact panel along the bottom.
`widget-card.ts`, a top-level module of the widget package beside
`widget-picker.ts`, decides where the card goes — beside the element, or below
or above it when the element reaches into the margin, never over it — and is
asked again every frame from the widget's existing rAF loop. It joins no data
flow: it reads layout and writes only the widget's own shadow DOM.
`widget-page-bar.ts`, beside it, finds the page's own fixed or sticky bar
along the bottom of the screen and adds its height to the offset every bottom
control rides, so the FAB, the phone prompt and the dock stand on a mock's tab
bar instead of covering it. Also layout only, and re-measured on resize,
scroll and DOM change rather than per frame.

**Who hears the Workspaces feedback doc.** That doc (`lf-hub-feedback`) sits
on no board, so its comments once reached only a session that had called
`watch_doc` on it. `feedback-owner.ts`, a new top-level server module in the
domain tier, names the board that owns it: `CW_FEEDBACK_BOARD` by id or name,
else the board named Workspaces. When that board does not hold the doc,
`onLiveDocEvent` in `stall-wiring.ts` queues each comment for that board's
lead (and no other watcher) and sends the frame to the lead's stream alone, not to the board's
channel, so pages and share visitors on that board are not sent it. It is a
delivery owner only: the doc is not added to the board's `docIds`, so
`boardsForDoc`, share scope and the board's rows are unchanged.
