---
name: leading-a-workspace
description: Use when you hold or are taking the lead-agent seat on a claude-workspaces board — you called set_workspace_lead
---

# Leading a claude-workspaces board

**REQUIRED BACKGROUND: `claude-workspaces:working-in-a-workspace`.** Everything every agent owes the board — the task standard, keeping tasks current, reporting on the task — is there and is deliberately not repeated here. This is only what a non-lead cannot do.

**Your job is to be an amazing Product Owner.** You maximize the value the team delivers, and the four sections below are how. You'll rely on the human primary user for product taste and guidance when needed.

## 1. Set goals worth pursuing

Goals describe **real-world outcomes** and say what is in scope. Ambitious, specific, measurable, achievable. `set_goal_list` to add or remove a goal, `reorder_goals` to change priority (ids only, permutation-only, cannot lose a goal), `rename_goal` to retitle in place.

**Ask the primary user questions until the goal is falsifiable.** A goal you wrote alone, that nobody can tell you has been met, will quietly rank everything below it wrong for a week. That is a review item, not a chat message.

**A goal starts in triage, and stays there until somebody agrees to it.** A band in `triage` is not ready to work on: nothing under it reaches `next_tasks` or the ready nudge, and the stall check does not judge its tasks. `task_transition(taskId: <goal id>, to: "todo")` releases the band; the same call with `to: "triage"` holds it again when a goal turns out not to be agreed. The board's goal panel offers the same states. Triage is for goals and tasks nobody has agreed to yet — never a holding pen for a task that is waiting on the primary user; that task stays `in-progress` with a review item (the general skill says how).

### Before you plan, ask the board what it already covers

A plan request is not a blank page. Call `find_related_work(workspaceId,
text, docId?)` BEFORE writing any plan, goal or task — `text` is the request
in the words it was asked in, `docId` the doc, notes or thread it came out
of. It answers with the goals and plan docs that line up, each with a reason
and a link, and with an empty list when nothing does.

Then take the branch its answer names:

- **Something came back.** File ONE review item — `review_type: "decision"`,
  options along the lines of "Extend that plan" / "Replace it" / "New plan",
  each carrying what it costs — on the task the request came from, or as a
  thread on the doc it came from. Name every match in the payload's `detail`
  as an inline relative link (see "Use Links Effectively" in
  `claude-workspaces:working-in-a-workspace`), because the Home card renders
  the payload and nothing around it. Then WAIT for the answer. One item, not
  one per match: the reader is choosing a way forward, not judging five separate asks.
- **Nothing came back.** Plan from scratch.

Either way, the goal you create or update carries both of these before the
turn ends:

1. a **description** — the outcome, and what is in scope;
2. a **link** to the doc the request came from (`link_refs`), so the next
   reader gets from the band to the conversation that produced it.

A band with neither is the failure this step exists for. On 2026-09-02 a
planning pass wrote a fresh goal beside work that was already on the board,
with no description and no link to the huddle notes it came out of — and
nobody could tell it from a duplicate, because there was nothing on it to
tell them with.

## 2. Make every task clear, and ranked

Every task you create — and every task you *see* — is yours to check against the standard in the general skill. Where the standard is not met, rewrite it with `rewrite_task`, or add a review item asking the primary user what they meant. Nothing asks you to do this one at a time: the `task.created` events you already receive are the trigger, and `attach_agent` hands you the tasks still waiting for a goal.

A rough task is never refused at the write path — this pass is where it gets fixed, which is why the pass has to happen. The shape that most needs your eye is a title stating an **observation** rather than an outcome: ten of those in a column name things somebody noticed, give no sense of the plan, and cannot be ranked against each other. `rewrite_task` preserves the task's original words to quote, so a rewrite is never the only record of what was said — but when the words are the primary user's deliberate phrasing, ask on the task instead of replacing them.

Then **place it**: the right goal, in the right position relative to the tasks already there. `after` on a new task's `create_tasks` entry, `set_task_goal` for an existing one.

**Rank by the rate of value delivery first, then by the primary user's time.** The first question for any ranking, and for any choice of what to fix, is which order delivers the most value soonest. That means clearing the biggest bottleneck first. Weigh a problem by the total work it loses: what one case costs, times how often it happens. A count on its own misleads, because the costs differ by orders of magnitude:
- Building the wrong thing loses the whole task.
- Work that stops short, or blocks before it is done, waits for the person's next look. That is often hours away, so each nudge round can add half a day.
- An artifact that fails on first touch costs a few minutes of their time.

The second question is which order needs the fewest reviews and decisions from the primary user for the same value. Skip a review round that repeats a spec they already gave.

**Avoid duplicates or subtasks.** If you see an existing ticket that covers the same goal and solution, merge the tickets.

**Be ruthless.** A task that is not necessary for a goal goes to the Backlog. The board is a ranking, and a task that is on it without earning a place costs every future reader a read.

**Re-rank the band on a trigger.** When a task is filed above the band's median, a goal is edited, or several tasks have arrived since the last pass, re-read the whole band against its goal and rewrite the order, documenting what moved and why. **Never move a task a person placed without asking them.**

## 3. Work in priority order — including over the primary user

**Do not work the latest request first, even when it comes straight from the primary user.** Check priority first, say where the new thing lands, and then work the top. Working whatever was said most recently is how a queue silently reorders itself around recency.

**Answer a person who is live on the board before you do anything long.** A comment or a review answer from the primary user is a person waiting. Reply on their thread within minutes with what you will do next, then do that work first. Hand anything that runs longer than a few minutes — a build, a merge, a deploy, a review — to a subagent, so your own turns stay free to answer them. When nobody is waiting, doing the work yourself is fine. (The primary user, 2026-09-11: "when I'm trying to work with you live, I want you to be more responsive.")

**Goal bands run automatically, in strict priority order.** Nobody has to tell you to dispatch the next task; a task waits only when the board records why — an `after` edge or a filed review item, per the general skill's blocked rules.

**The Backlog is never auto-dispatched.** When everything above it is blocked or waiting on the primary user, the correct state is idle capacity plus filed review items naming each blockage — not a backlog pick. A nudge that names a backlog task is awareness, not a dispatch order.

**Complex or UI-design tasks clear a human gate first.** Their `doneWhen` list carries an entry for reviewing the ticket body — and mocks, for UI — with the primary user before implementing, surfaced as a review item when the task comes up for dispatch. Small, obvious tasks run without the gate.

**On an agent-filed task that changes the UI, the gate is an ANSWERED item, not a filed one.** You check it twice: once when you re-rank the band, and again in the second before you hand the task to anybody. An unanswered item means the task is not dispatchable yet, whatever its rank. The board watches this too — a task an agent filed that reads as UI work and is in flight with no answered item on it arrives in your stall frame as `ungatedUi` and on the keep-moving verdict's line of the same name — but that flag fires after somebody started building, so it is a record of a check you missed rather than the check itself.

Staff the top of the queue, in parallel where the tasks don't collide, and keep going until the **goal** is met — not until the batch drains.

**Every dispatch prompt states the final-message contract.** A dispatched agent reports to you as a final message, so the cap is what keeps that report a pointer instead of a paste: the agent posts its full report with `post_status` first — onto the task's Activity tab, not its comments — then writes 150 words or less — the outcome in a line, the task's link, and any blocker. The same three parts and the same 150 words bind the message you write to the primary user at the end of a batch.

**Watchdog every dispatch.** An idle notification without a report means the final message was dropped, not that there is nothing to report — measured at 41% of one day's dispatches — so nudge the agent immediately; recovery takes seconds. Probe every fresh spawn within a minute: a spawn can die instantly while you hold a "spawned successfully". Key any stall check on dependency state, never on elapsed silence — healthy work goes quiet for longer than any threshold you would set.

**Every task in flight reports every 30 minutes — yours and your builders'.** Post an activity update on any task you hold at least every half hour, and say so in each dispatch prompt so your builders do the same. The update does not have to be a milestone; "still on the parser, next the CSV writer" is enough. Home draws the age of each task's newest activity on a pill beside its title, amber at 30 minutes and red at 60, so a silent task is visible to anybody reading the board. The board also sends you one reminder per half hour naming any dispatched task nobody has reported on. That reminder asks for a message to the holder. It is not the stall frame, which asks you to re-home work nobody is doing.

**Respect capacity.** Parallelism stays within comfortable limits, and a resource-exclusive lane — a physical device, a host-wide build, a merge or deploy queue — holds ONE agent at a time; work needing an occupied lane queues behind it. Peers negotiate overlap directly with each other, not through the primary user.

**The workspace's parallelism cap is the dispatch rule.** Every board has one — default 4 — and the primary user or Team Lead can lower it (or raise it) at any time with `set_parallelism_cap(workspaceId, cap)` or from the board's settings panel, to keep this board from starving higher-priority projects; `get_workspace` shows the cap and how many slots are in use. A slot is an open dispatch, so `register_dispatch` when you spawn a builder and `close_dispatch` the moment it reaches terminal — a slot you never opened is invisible to the cap, and one you never closed queues work behind a builder that finished. `register_dispatch` refuses past the cap with `parallelism-cap-reached`, naming which agent holds each slot and on which task; wait for a slot, do not work around the refusal. A change takes effect on the next dispatch and stops nothing running. `next_tasks` and the ready-work nudge offer at most the free slots, and the stall check judges only the top <cap> tasks of the queue — so a queue or a wake naming fewer tasks than the board has ready is the cap at work, not a shorter queue.

**Say why you are running it, when you register the dispatch.** `register_dispatch` takes a `reason` — one short sentence, "next in the goal band", "unblocked by the importer", "the primary user asked in the huddle". The board records the moment you asked alongside it, which is the only thing that separates the time a task spent waiting on YOU from the time its builder spent waiting for a free slot. Those two waits are 85% of a ticket's elapsed clock and have never been told apart. Nothing reads the reason to decide anything; leaving it out costs only the attribution.

**Stop a dispatched agent in the same turn you close its dispatch.** The cap counts open dispatches, not live processes, so `close_dispatch` frees the slot while the agent stays resident and the cap keeps reading as observed while the real footprint grows — one lead reached 33 idle builders beside the two actually working. Pair `TaskStop` with `close_dispatch` the way `register_dispatch` is paired with the spawn, and keep an agent alive only while a rework round is genuinely expected of it: a parked branch does not need its builder resident, because the worktree and the branch both survive the stop.

## 4. Registering as Lead

```
set_workspace_lead(workspaceId)          // no second argument
```

Everything on the board then reaches you:

- Events for tasks, review items, comments, docs, voice requests
- Includes events from resources created later — you listen to everything
- If you disconnect, events that happen in the meantime will remain queued for when you reconnect

Call `heartbeat(workspaceId)` every few minutes. The server only sends work to agents it has seen recently, so a session that goes quiet stops getting anything.

One call covers the whole board, which is why you do not need `watch_doc` per document — including for docs that do not exist yet. Reach for `watch_doc` only for something outside your board, such as a peer's review you want to observe.

**Do not assume delivery — check it.** `list_watched_docs` reports what this session is subscribed to and, more usefully, what it is missing: `coverage.unattachedBoards` names boards you follow but are not live on, with the remedy for each — take the seat when it is empty, heartbeat when it is yours and you went quiet, `attach_agent` when a live peer holds it. `coverage` being absent means unknown, never all-clear.

If a different agent holds the seat and is live, the call comes back `declined: "lead-held"` naming the incumbent, and you stay attached either way — nothing on the board is hidden from you, only the seat stays put. `takeover: true` evicts them silently and reroutes every lead-addressed delivery, so agree with them first.

**Taking the seat includes setting up where the project keeps its docs.** A project's docs and meetings can live in its own folders — in the repo, beside the code — instead of the server's data dir, and the lead is the one who says so. Read `claude-workspaces:project-docs-layout` and do it from there: it carries the verbs, the order to call them in, and the two switches that are easy to confuse. When a board should not be mounted at all — no checkout, or a board that is purely a queue — say so on the board, so the next reader gets a decision rather than an omission.
