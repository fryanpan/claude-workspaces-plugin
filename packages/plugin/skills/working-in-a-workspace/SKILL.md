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

- DO NOT use `AskUserQuestion`. Create a review item instead.
- DO NOT ask for help in chat.  Create a review item instead.The only exception to this rule is if the human is using chat, then it's okay to reply in chat
- DO NOT share status updates in chat.End of turn updates are automatically shared to the workspace with a Stop hook.And for any significant milestones (e.g. done build, test, deploy) use `post_status(text, taskId?)`
- Review item types
  - `review_type: "decision"` offers 2–6 named options to pick between. The option label is what they answer.
  - `review_type: "question"` asks them to look at something and answer in their own words.
- To create a review item
  - Use `add_review_item(taskId, review)` to attach a review item to a task
  - Add `review` payload in `create_thread` or `post_reply` to add a review item to a doc or mockup
- Each review item is judged against the board's quality gate.
  - If it does not meet quality standards, you'll receive a `workspace.review_item_held` wake with a reason
  - Use the `revise_review_item` call to update the review itemYou must say what changed and address the reason
- How to write a good review item
  - The option label is the contract — the reviewer answers the label, not the reasoning under it. Plain words, phone-readable.
  - The item has to be actionable on its own. 
    - The review item details should briefly present all information that's essential for making the decision
    - Every link the reviewer needs to see should be in the payload `detail` as an inline markdown link 

## Picking Up Work

`next_tasks(workspaceId)` is the queue, already filtered to what you can do.

- **Take every ready task that does not collide with another.** Each task carries its full description; whether two touch the same code is your judgment from that text. Call `next_tasks` again whenever a line of work finishes, because priorities move while you work.
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

**Report what you found with `report_done_when`.** Give one entry for each line you checked: `{id, verdict, proof?}`.

| Verdict | Use it when |
| --- | --- |
| `met` | You checked the line. It holds. |
| `not-met` | You checked the line. It does not hold. |
| `unchecked` | You could not check the line. Say why in a proof. |
| `owner` | Only a person can judge the line. |

`met` needs one proof or more. The board refuses a `met` with no proof, and it names the line. A proof is `{text, url?}`: what you ran or read, and where a reader sees it.

**The board closes the task for you.** When you report the last open line as `met`, the board moves the task to done. It also records which line closed the task. Do not call `task_transition` after that.

**A line you report as `owner` goes to the person who owns the task.** They get two buttons on the task. Do not wait for a tool to answer. Take other work.

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

## When You Are Blocked

- When you have done everything that you can on a task, and you need to wait on another taskUse `block_task` tool to indicate this happened.
- Every time a task is unblocked, you will receive an event and be woken up to continue working

## When Someone Comments on Your Review Item

A reader can select a phrase in your review item and ask about it. The question arrives as a thread on the task (the channel frame's `review_item_id` names the item), and the item leaves their queue until you act, so an answer in chat leaves it stuck. Rewrite the item in place with `revise_review_item(taskId, reviewItemId, headline?, detail?, options?, reply?)`, passing only what changes; `reply` posts your answer on the thread, so do not also `post_reply` it. Write the revision to stand alone: plain English, why it matters, what each option costs. The item returns to their queue marked Revised, with the old words kept as history. Use `post_reply` alone only when the item already answers the question.

## Use Links Effectively

- Every resource (task, workspace, document, mockup, folder diff) has its own URL.
- In a workspace, links are relative and inline with link text, never a raw URL: `[this link](/workspaces/<workspaceId>/docs/<docId>?thread=<threadId>)`. 
- A task's page is `[this task](/workspaces/<workspaceId>?task=<taskId>)`.
- In terminal chat, send the absolute URL bare on its own line with no markdown around it.
- Link the thing under review, not the workspace: hand over the `reviewUrl` / `entryUrl` the tool returned. Link the workspace only when the workspace itself is the subject.
- A workspace URL is not a durable address. Durable artifacts (committed docs, exports) cite repo paths or GitHub URLs.
