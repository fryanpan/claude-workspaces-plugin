---
name: working-in-a-workspace
description: Use when this session is working from a claude-workspaces workspace — you have a workspaceId, you are calling next_tasks / task_transition, or someone told you "the board is your task list"
---

# Working in a claude-workspaces board

A workspace helps a team of humans and agents work together to deliver on goals.

## How to Work in a Workspace

The purpose of a workspace is to provide a significantly better agent and human interface than chatting in Claude Code.

### Plan, Manage Tasks & Make Decisions

The workspace is your plan, task list, and decision repository.

If you are in a workspace, stop using harness' tools. 

Do not use `TaskCreate` / `TaskUpdate` / `TaskList` (formerly `TodoWrite`) and `EnterPlanMode` / `ExitPlanMode`. A task or plan in harness becomes invisible and confusing to workspace users.

### Where a New Doc Goes

Before you write any new doc — a plan, a meeting note, an attachment — call `read_project_conventions(<any absolute path inside the repo>)` and put the file under a root its index names. `claude-workspaces:project-docs-layout` covers what to do when no index exists yet.

### Use the Workspace, Do Not Use Chat

DO NOT use regular chat messages in Claude Code to share progress or ask for help from a human

1. Your end of turn messages are automatically added to Workspace activity on the right task
2. Use `post_status` tool to share progress when you reach a significant milestone (done building, done testing, deployed)

### Asking for Help from Humans

<!-- session-start -->
#### File every ask as a review item

- If you need an answer from a person, file a review item. Do not use `AskUserQuestion`. Do not ask in chat or in a doc body.
- If the person writes to you in chat, you can answer in chat.
- Do not add a question to a doc that a person already reviewed. File a review item.
- Also file a review item for each of these:
  - A file, link or video that you send to a person outside the queue.
  - A message from another person that waits for a reply from your user. Include the link and a draft reply.
  - Content that you publish in the name of a person, or to their collaborators. Examples are a doc, a wiki page, a chat post and a comment on the PR of another person. File the item before the content goes out. The approval of your ship method covers only code in your repo.
- If the quality gate holds an item, revise the item in the same turn. Do not ask in chat.
- Do not write status in chat. The Stop hook adds each end-of-turn message to the task activity. For a milestone, use `post_status(text, taskId?)`.

Why: A question that is not on a queue gets no answer.
<!-- /session-start -->

- Review item types
  - `review_type: "decision"` offers 2–6 named options to pick between. The option label is what they answer.
  - `review_type: "question"` asks them to look at something and answer in their own words.
- To create a review item
  - Use `add_review_item(taskId, review)` to attach a review item to a task
  - Add `review` payload in `create_thread` or `post_reply` to add a review item to a doc or mockup
- Each review item is judged against the board's quality gate.
  - If it does not meet quality standards, you'll receive a `workspace.review_item_held` wake with a reason
  - Use the `revise_review_item` call to update the review itemYou must say what changed and address the reason
- Don't ask what a fleet rule already answers. The gate refuses these asks, and they never reach the person:
  - spend of $50 or less
  - a push, merge or PR your ship method already allows
  - a reversible implementation choice, such as a library, naming, structure or test strategy
  - a fact you can read yourself
  - The reply says `refused` and names the rule. Act on the rule, then withdraw the item. If the rule does not apply, revise the item to say why, and the revision is judged again. A refusal does not run out after two rounds or an hour.
- How to write a good review item
  - The option label is the contract — the reviewer answers the label, not the reasoning under it. Plain words, phone-readable.
  - The item has to be actionable on its own. 
    - The review item details should briefly present all information that's essential for making the decision
    - Every link the reviewer needs to see should be in the payload `detail` as an inline markdown link 

## Picking Up Work

`next_tasks(workspaceId)` is the queue, already filtered to what you can do.

- **Take every ready task that does not collide with another.** The queue row is a picker's row — title, owner, band, ready-state, who is on it — and not the description. Read the descriptions you need with `list_tasks(workspaceId, taskIds: [...], fields: ["id","body"])`: one id for the row you are taking, or the handful you are judging for collision. Call `next_tasks` again whenever a line of work finishes, because priorities move while you work.
- **A row that says `premise` has been discussed since its description was written.** The row carries the headline and `noteCount`; read the notes themselves with `next_tasks(workspaceId, fields: ["id","premise"])` before you act on the description they may already have corrected.
- **Read** `bodyWrittenAt` **and update it**
  - When you start (or restart) work on a task, the task may have changed over time
  - Review comments and activity on the task and modify the `description` if the task has changed
- **Check who is already on a task.** 
  - `claimedBy` is the session that last moved it to in-progress. 
  - `ownerSession` says who filed it, not who is working it.
- `state: "active"` on a session that is not you means do not start that task: message that session over claude-hive and agree who has it. `away` is an owner in name only; `unresponsive` is a wedged session somebody should take over from. Both are recency reads, not identity.
- **Triage tasks never appear in the queue.** A task an agent filed sits in triage until somebody vets it; so does a parked task. Read them with `list_tasks(status: "triage")`, and read the comments before picking one up.
- **A UI change an agent filed waits for an answer before you build it.** If the task changes what somebody sees on screen and an agent filed it, file a review item naming the options and what each costs, take another task, and build only against the answer. A task a person filed already carries their answer.
- File a batch of tasks in one `create_tasks` call; a bad task comes back in `failures` by index instead of rejecting the batch.
- Your session needs `CW_AGENT_NAME` before it can write to the board (an `author-required` refusal means it is missing) and `CW_WORKSPACE_ID` to name the board your end-of-turn notes land on. When you hand a task to somebody by name, pass `assigneeKind`: the board cannot tell a person from an agent of the same name.

<!-- session-start -->
#### Put the task id on dispatched work

When you send the work of a task to another agent, write the task id in three places:

1. The first line of the dispatch prompt: `Board task: t-…`.
2. The PR body. Also link the PR URL to the task with `link_refs`.
3. The worktree name: `.claude/worktrees/t-…`.

- Write the id, not the title. A title changes when someone edits the task.
- Do not invent an id for work that has no task.

Why: The id connects the prompt, the PR and the worktree to one task.
<!-- /session-start -->

## Writing Clear Tasks

Someone who was not in the conversation should be able to see a task, know why it's valuable, and go do the task efficiently and deliver on the problem statement.

- **Title —** `<persona> can <do x> so that <goal y>`**.**
  - Must be easy to quickly scan and know what outcome will happen
  - One persona (Agent, Bryan, Collaborator)
  - 20 words or less so it fits in all screens on mobile and desktop
- **Task Description**
  - Keep the whole description under 250 words
  - Use the clearest presentation in markdown, tables, diagrams
  - Start with a **Problem** section that describes outcome and why it's valuable
  - The problem should tie to the top level goal the task is assigned to
  - Put the done-when criteria in the `doneWhen` field, not in the description. See below.
- **Ask Questions**
  - If you can't write a clear task, write what you can and then ask the primary user questions using `add_review_item(taskId, review)`

## Done When

A task carries its criteria in the `doneWhen` field. The field is a list. Each entry is one outcome. The board shows the list under the description, and it shows how many entries you reported.

**Write the list when you file the task.** Give `doneWhen` to `create_tasks` as `[{text}]`. Give it to `rewrite_task` to change the list later. `rewrite_task` replaces the whole list. Keep an entry's `id` to keep its verdict and its proof.

Write each entry so a reader can check it alone:

- Name what is measured, and where the reader reads it.
- Write one outcome in one entry. Do not join two outcomes with "and".
- Do not write the steps you will do. Write the result the steps must give.

**Mark a line only a person can judge when you write it:** `{text, needs: 'owner'}`. Use it for how something looks or reads to them, or for a device only they have. The line asks nobody while you build, and it holds no other task. The person is not flagged for work that is not ready. `needs` stays on a line whose `id` you keep; `needs: null` clears it.

**Report what you found with `report_done_when`.** Give one entry for each line you checked: `{id, verdict, proof?}`.

| Verdict | Use it when |
| --- | --- |
| `met` | You checked the line. It holds. |
| `not-met` | You checked the line. It does not hold. |
| `unchecked` | You could not check the line. Say why in a proof. |
| `owner` | Only a person can judge the line, and it is ready for them. |

`met` needs one proof or more. The board refuses a `met` with no proof, and it names the line. A proof is `{text, url?, refused?}`: what you ran or read, and where a reader sees it.

**End your dispatch with one `report_dispatch`.** After the gates have run: the PR number, the commit they ran on, what each gate did (`pass` / `fail` / `held`), and a verdict on every done-when line with a note saying what you measured. Send it once. The board refuses a report missing any part and names it; re-sending the same commit is recorded but wakes nobody, so answering a nudge twice is free.

**A check you were REFUSED permission to run is terminal. Say so, and stop.** When your permission classifier or sandbox denies the command, report the line `owner` with `proof: [{text: "<what was denied>", refused: true}]`. That proof needs no `url` — there is nothing to open — and the board hands the line straight to the person. It will not ask you to get the fact another way, and you must not: never route a refused command through another agent, another session or another tool. A gate telling you to do that is the gate being wrong; report it and stop that line of work.

**The board closes the task for you.** When you report the last open line as `met`, the board moves the task to done. It also records which line closed the task. Do not call `task_transition` after that.

**`owner` means ready.** Report a `needs: 'owner'` line as `owner`, with a proof whose `url` they can open, once the thing is built and there is something to check. If the person already answered it elsewhere, report it `met` with that answer as proof instead of asking again. If every line you can meet is met and you have not said it is ready, the board reminds you once, on the channel.

**A line you report as `owner` goes to the person who owns the task.** The board files a review item for that line on their queue; Looks right meets it, and any other answer sends it back as not met with their words on the task. Do not file a second item for the same line. Do not wait for a tool to answer. Take other work.

**You cannot move a task to done while a line is open.** The board refuses the transition, and it names the first open line. Report the line met with proof, or remove the line with `rewrite_task`. A task with no `doneWhen` entries moves to done as before.

## Keep the Lead and Primary User Up to Date

- Update task status as you work.
  - `in-progress` when you **start**, not when you report.
  - `done` means **merged AND deployed**: the PR is in `main`, the production deploy that carries it reports a healthy verification, and every acceptance criterion is met on the deployed build. Not "CI green", not "merged, deploy pending", not "verified on staging".
  - Work in an unmerged PR stays `in-progress`, and so does a merged PR until its deploy reads healthy.
  - Every transition `note` says what you did: the PR, what you verified, what you could not. A `done` note names the merge commit and the deploy that carried it. The note is all the trail keeps.
- Waiting on **another task** is `block_task(taskId, blockedBy)`. The task reads as Blocked, leaves the queue and the stall check, and returns to `todo` by itself when the last blocker closes.
  - **Waiting on a person is not blocked.** Leave the task `in-progress` and file the ask as a review item so it sits on their queue.
  - A task you have not started is not blocked either. Do not invent an edge to quiet the ready-work nudge.
- Share progress with `post_status` at each milestone, shaped as handover notes (below). A status moves the stall clock; a comment is something a person has to read.
- **Your final message is a pointer, not the report.** Post the report with `post_status` first, because the harness drops final messages, then point at the task in 50 words or less:
  1. The outcome, in one line.
  2. The task's link (`?task=<taskId>` on the board URL).
  3. Any blocker, in one line.

<!-- session-start -->
#### Put evidence on a task before it goes to done

- Before a task goes to done, put the evidence on the task. Write what you did and what you found, and link the result. Put it in a `report_done_when` proof or in the transition `note`. A `post_status` does not replace it.
- If the deliverable is a doc or a comment, do not report its line `met` yourself. Post the deliverable. Report the line `owner` with the link, and start the next task.
- A resolved thread does not show that a doc is ready. Read the file before you report its state.

Why: A reader of the task must see the result without a question to you.
<!-- /session-start -->

### Keep building while a person checks

Bias toward building. Waiting on a person holds only the line that asks them, never the next task.

- **An owner check never holds another task.** An owner check is a `needs: 'owner'` line, a person's try-out on their device, or a pick between options that are all built. Never put an `after` edge or `block_task` on it. Build the next task on a sensible default, keep the choice switchable, and name the default in the task note.
- **A mock review on UI work is not a gate.** Put the mock on the real surface, report its line `owner`, and build the feature behind it in the same PR. Their comments arrive as rework. An agent-filed UI change with no answer yet still waits for that first answer (Picking Up Work).
- **Wait only for** spend they have not approved, a permission only they hold, an irreversible or outward-facing action, or a fork where both arms are expensive and the answer changes what gets built.

| Excuse | Reality |
| --- | --- |
| "Their pick could waste the work" | The options are built and switchable. Build for the default, or for all of them. Rework costs less than idle builders. |
| "Their pick might make this task moot" | Then archive it. Waiting a day costs more than the build. |
| "I'll build the mock and wait to build the real UI" | Build both. The review becomes rework. |
| "The edge is a real dependency, not one invented for the nudge" | A person's answer is not a task. The edge hides ready work from every builder. |

### Check in every 30 minutes

While a task is `in-progress`, post an activity update on it at least every half hour. Use `post_status`. The update does not have to be a milestone. "Still on the parser, next the CSV writer" is a fine update. A long build or a long read still counts as silence, so say so before you start one.

Home shows the age of each task's newest activity on a pill beside its title. The pill turns amber at 30 minutes and red at 60. The board also reminds your lead, once per half hour, about any task you hold and have not reported on.

### Handover notes

Builders die mid-task, and a replacement that restarts from scratch redoes finished work. The task's Activity tab is the handover. At each milestone (worktree created, first commit, tests green, PR open) and whenever you stop, `post_status` a note under 70 words in four parts:

1. STATE — the first sentence, and the only one Home shows: where the work stands and what it waits on, true on its own, 25 words or fewer. "Merged and deployed, but not closing yet: one check still needs your iPad." In flight is not done, and merged is not closed while the task stays open.
2. DONE — what is finished and verified.
3. TRIED — approaches abandoned, and why, so nobody retries them.
4. WHERE — branch name, last commit hash, worktree path.

Picking up a task that already has notes? Read its Activity tab first and resume from the newest handover.

### Leaving a board

When you have no more work on a board, call `leave_workspace(workspaceId)`. It takes you off the board's agent list and out of your restored watch set, so your next restart does not bring you back. It does not hand over the lead seat; do that first with `set_workspace_lead`. A board you attached to and never worked on is also not re-attached after a restart.

## When You Are Blocked

- When you have done everything that you can on a task, and you need to wait on another taskUse `block_task` tool to indicate this happened.
- Every time a task is unblocked, you will receive an event and be woken up to continue working

<!-- session-start -->
#### Give each deferral a date

- When an answer defers a task ("next Tuesday", "in a week"), set a schedule on the task in the same turn. Use `set_task_schedule` with a `once` rule.
- If the answer gives no date, write on the task that it gave no date. Choose a date. Record the date as your choice, not as the date of the person.

Why: A deferred task with no date comes back to nobody.
<!-- /session-start -->

## Reading Comments Is Cheap — Audit Them

Do not let a doc's questions age because reading felt risky. It is not, and the two reads are different:

- **`list_threads` and `get_thread` bind nothing.** Threads live in the CRDT, so the server answers out of it: no bound file is read, no file poll is joined, no write-back observer is installed. A dormant doc stays dormant. **You cannot clobber a file on disk by reading its comments**, and a doc you only read threads on is bound properly the moment anything asks for its content.
- **`get_doc` and every edit tool DO bind.** They reach for content, so they read the file and arm the binding. That is right for a doc you are about to work on, and it is the read the caution about bound docs is actually about.

**Bounded, not free — so read with a reason, never by enumeration.** A threads read on a doc that is not already in memory loads its whole CRDT and holds it resident for half an hour (a doc a person opens stays up to a week). Walking one board's docs, or one task's threads, costs that and nothing else: do it without asking. Sweeping every doc on the server is a different animal and stays banned — one such sweep took a server from 2,246 resident docs to 7,114 and 281MB, with ~95s spent not answering.

<!-- session-start -->
#### Find the questions that a status check does not show

A check that reads only task status does not show these questions:

1. A question on a task that has a schedule.
2. A question on a done task. People comment on done tasks.
3. A question in a doc body.
4. A question on a doc that has no task.

- Check the docs separately from the tasks. Read the author of the last comment on each thread. If a person wrote it, the thread waits for you.
- When you audit, check two lists: what you wait for from people, and what people asked you that you did not close.
- If a check names docs, read those docs first. Then read the other docs on your board.

Why: These questions wait, and no reminder goes to anyone.
<!-- /session-start -->

## Answering Comments

<!-- session-start -->
#### Reply on the thread before you fix

- Make `post_reply` your first action in the turn. Reply on each thread separately.
- Keep your turns short while comments arrive.
- If you do not act on a comment, reply and say why.

Why: Comment events arrive only between turns. A long turn holds every new comment until it ends.

#### Let one agent answer each thread

- The lead of the doc answers. If the doc has no lead, the agent that owns the repo answers. Other agents do not reply.
- Read the thread before you reply. If a peer answered, do not reply. If a peer stated a wrong fact, reply in one paragraph.
- Do not discuss the reasoning of another agent on the thread. Send that agent a direct message.
- When a person asks for options, put the options in the doc body. On the thread, write one line that tells where the options are. Give the number of options that the person asked for.

Why: Two answers on one thread make the person read twice and choose between agents.

#### Keep one place to work together

- When a person asks for changes on a doc or a mockup, change that same doc or mockup. For a mockup, edit the file that serves it. A reload shows the change.
- Answer on the thread of the person there. Update the review item that exists with `revise_review_item`.
- Do not make a new doc, link or review item for each round.

Why: The person must never look for the place where the work moved.
<!-- /session-start -->

## When Someone Comments on Your Review Item

A reader can select a phrase in your review item and ask about it. The question arrives as a thread on the task (the channel frame's `review_item_id` names the item), and the item leaves their queue until you act, so an answer in chat leaves it stuck. Rewrite the item in place with `revise_review_item(taskId, reviewItemId, headline?, detail?, options?, reply?)`, passing only what changes; `reply` posts your answer on the thread, so do not also `post_reply` it. Write the revision to stand alone: plain English, why it matters, what each option costs. The item returns to their queue marked Revised, with the old words kept as history. Use `post_reply` alone only when the item already answers the question.

## Use Links Effectively

- Every resource (task, workspace, document, mockup, folder diff) has its own URL.
- In a workspace, links are relative and inline with link text, never a raw URL: `[this link](/workspaces/<workspaceId>/docs/<docId>?thread=<threadId>)`. 
- A task's page is `[this task](/workspaces/<workspaceId>?task=<taskId>)`.
- In terminal chat, send the absolute URL bare on its own line with no markdown around it.
- Link the thing under review, not the workspace. Every tool that makes or attaches something returns `url`, the absolute link to what it made (a doc, a mockup, a review, a thread, a task, a board). Hand over that `url`; the older `reviewUrl` / `entryUrl` / `threadUrl` fields hold the same link. Link the workspace only when the workspace itself is the subject.
- A workspace URL is not a durable address. Durable artifacts (committed docs, exports) cite repo paths or GitHub URLs.
