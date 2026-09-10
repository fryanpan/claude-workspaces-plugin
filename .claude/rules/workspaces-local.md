# Local Workflow Facts

How to work in general — autonomy and the decision framework, planning,
implementation, verification, batching inbound PR feedback, hive etiquette,
security posture, public-content scrubbing, capturing learnings — comes from the
`team-lead-fleet` rules that are injected into every session on this machine.
This repo used to keep its own forks of five of those; they had all drifted into
stale paraphrases, so four were deleted (`security-posture.md` still sits beside
this file only because tooling would not let it be removed). What follows is the
residue that is true of THIS repo and nowhere else.

- **This project's ship skill is `ship-it`**, not the fleet default `ship-auto`.
  It runs the code review, opens the PR, and follows CI and Copilot. Invoke it
  once implementation is done and `bun run verify` passes, before handing
  control back.
- **The multi-agent recipe that actually worked here is written down.** Grep
  `docs/process/learnings.md` for "Multi-agent workflow implementation" before
  fanning a plan out with the `Workflow` tool. It carries the shape that shipped
  two features (one persistent worktree, sequential TDD implement-agents chained
  by structured results, parallel review lenses tailored to the feature's risks,
  a verify-then-fix agent) and the finding that an independent `codex review`
  afterwards still caught bugs every lens had passed.
- **Board work has its own two rules files.** How to run a task, keep rows
  current and ask for review is in `workspace-board.md`; which surface a doc or
  dev server gets bound to is in `workspaces-default.md`. Neither has a fleet
  twin.
- **Sentry alarms reach a session only if that session holds the watch.** This
  board raises into two projects: `workspaces-server` (the server process —
  `SlowLoadAlarm`, and everything else through `captureServerError`) and
  `claude-workspaces` (the browser). The subscription is keyed on the
  claude-hive stable id, and that id is `sha256(<the session's LAUNCH path>)`
  truncated to 12 hex. So it is not session state: a session launched at the
  repo root inherits whatever a previous one subscribed to, across restarts,
  having never called subscribe itself — and `cd` into a worktree mid-session
  changes nothing, because the id is fixed at launch. A session *started*
  elsewhere starts from a different id, and holds whatever has been subscribed
  under THAT path — nothing, until somebody does: inside a worktree, in prod's
  checkout under `Application Support`, under the home-directory spelling of
  this repo (the boot disk symlinks into `/Volumes/Data`, so one tree hashes
  two ways), or on another machine. Which is why the check below is the answer
  and this list is only where to expect a surprise: subscribe once from such a
  path and its sessions inherit it thereafter, exactly as the root's do. Measured both ways on 2026-09-10 — the repo root hashes to
  `2a6518a92270` and holds both projects; a session launched in
  `.claude/worktrees/` reported its own path's hash and held nothing.
  **Check:** `sentry_list_my_watches` names the id it answered for, and "No
  active subscriptions" means alarms are raising and reaching nobody here.
  **Fix:** `sentry_watch_project` on each slug — idempotent, so calling it
  when you already hold the watch changes nothing. **What is not a check:**
  `POST /api/sentry` (loopback, `routes/ops.ts`) captures at `info`, below the
  `warning` floor these watches use, so a green self-test — `flushed: true`
  with an `eventId` — proves the server's path TO Sentry and nothing about
  whether a session is told. Only a warning-or-above event exercises the half
  that reaches a person, and the obvious tool tests the other one. There is
  deliberately no automatic version: the server knows only the numeric project
  id its DSN carries (`sentryProjectOf`, `packages/server/src/sentry.ts`) and
  cannot turn that into a slug without the Sentry API, so anything automatic
  would be a second place to configure the slugs, for a hole that opens only
  when somebody launches a lead outside the repo root.
