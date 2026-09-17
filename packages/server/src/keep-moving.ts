/**
 * Pure classification/stall logic for the server's stall loop
 * (`stall-nudge.ts`) and for the keep-moving verdict it records
 * (`keep-moving-verdict.ts`). It began as the library behind a box-cron
 * report script; that script died on a routes change and was removed
 * 2026-09-08, and the measurement now runs in-process off the same snapshot
 * as the wake, so the loop and the verdict cannot drift apart. This module
 * owns every decision about what counts as blocked, stalled, or active.
 *
 * It does NOT own whether a person is owed an answer — that is a separate
 * question with its own module, `owner-ask.ts`, which each row is put to
 * alongside the bucketing rather than through it. A rule row is why: it is
 * never work anybody picks up and can be carrying an unanswered question at
 * the same time.
 *
 * "Waiting on a person" is DECLARED, never inferred (rebuild step 2,
 * 2026-09-08): a row is waiting when an open review item is filed for it —
 * on the ticket, on its own thread, or on a doc it links — and the row then
 * carries the ADDRESS of that item (`Classified.waitingOn`). The note reader
 * that used to guess from an agent's end-of-turn text was removed with that
 * step, and
 * nothing here restored it: `noteClocks` arrives already judged, and the only
 * thing it can do is take a note's movement credit AWAY (`waiting-unfiled.ts`
 * for why that direction is safe when the other was not).
 */

import type { TaskSchedule } from '@claude-workspaces/core/task-schedule';
import type { ExternalWait } from '@claude-workspaces/core/task-wire';
import {
  type FiledItemAddress,
  type OwnerAsk,
  type ReviewItemRow,
  indexFiledAsks,
  ownerAskOf,
} from './owner-ask.ts';
import type { NoteClock } from './waiting-unfiled.ts';

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  goal?: string;
  after?: string[];
  createdAt: number;
  transitions?: Array<{ ts: number; to?: string; by?: { kind?: string; name?: string } }>;
  /**
   * The server's AUTHORITATIVE resolution of who owns the row —
   * `'agent' | 'person' | 'unknown'` from `taskProjection.ownerKindReader`
   * (it resolves assignee + assigneeKind against the attached-agent roster).
   * Prefer this over reading `assignee` / `assigneeKind` here: on the live
   * board `assigneeKind` is often null while `ownerKind` is always present.
   */
  ownerKind?: string;
  assignee?: string;
  /** Present on a rule row (`Task.schedule`). The BUCKETING needs only the
   *  fact; `owner-ask.ts` needs the date, so it is typed rather than left
   *  loose (2026-09-17). */
  schedule?: TaskSchedule;
  /** Row-edit timestamps — activity the /events feed has measurably missed. */
  updatedAt?: number;
  bodyWrittenAt?: number;
  titleWrittenAt?: number;
  /**
   * The agent's own notes on the row (`TaskNote` in tasks.ts: a turn's
   * closing message, a denial, an explicit status). `task.noted` is kept OFF
   * the workspace event stream on purpose — one frame per turn would wake
   * every attached agent — so the stream cannot say a builder reported; the
   * row's notes can. Any kind counts: the question is whether the agent
   * holding the row is still there, and a note is the agent saying so.
   */
  notes?: Array<{ ts: number; kind?: string; text?: string; agent?: string; sessionId?: string }>;
  /**
   * A wait the BOARD cannot see, declared on the row (`task-wait.ts`).
   *
   * Read by `evaluateStalls` and by nothing in this module: it is not a
   * bucket and it must never become one. A bucket is a claim about what the
   * board knows; this is a claim by an agent that the board cannot check, so
   * it may quieten a wake (`stall-nudge.ts`'s `withoutStandingWaits`) and may not change
   * what the keep-moving verdict counts. Carried here only because the gate
   * is handed tasks and a parallel map would be a second thing to disagree.
   */
  externalWait?: ExternalWait;
}
export interface EventRow {
  taskId?: string;
  ts: number;
  actor?: { kind?: string; name?: string };
}
/** The ask reading's own vocabulary, re-exported so the callers that read a
 *  classified row keep one import (`owner-ask.ts` is where it is decided). */
export type { FiledItemAddress, ReviewItemRow } from './owner-ask.ts';

export type Bucket =
  | 'blocked-on-owner'
  | 'blocked-on-owner-unfiled'
  | 'blocked-on-dependency'
  | 'in-progress'
  | 'ready-unpicked'
  | 'backlog-unranked'
  /** Carries a schedule rule: `todo` for life by design, its instances are
   *  the work. Never stalled, never dispatched. */
  | 'scheduled-rule';

export interface Classified {
  id: string;
  title: string;
  bucket: Bucket;
  /** ms in the current bucket (entered current status, or created). */
  ageMs: number;
  /** ms since ANY activity touched it (transition, board event, thread
   *  comment, or the agent's own note on the row). */
  sinceActivityMs: number;
  stalled: boolean;
  blockers?: string[];
  /** blocked-on-owner only: ms since the NEWEST pending review item was
   *  filed. Old asks go on the "re-verify the blocker is still real" list —
   *  measured: a live row waited on two PRs that had already merged. */
  askAgeMs?: number;
  /** blocked-on-dependency only: the far end of the `after` chain — the row
   *  the whole chain is actually waiting on, and what state it is in. Absent
   *  when every branch loops (see `cycle`): a cycle has no terminal. */
  terminal?: { id: string; label: string };
  /** blocked-on-dependency only: a dependency loop found through this row,
   *  as the id path that closes it (e.g. ['a','b','a']). A cycle is a
   *  malformed graph — the report names it as such rather than presenting a
   *  loop member as its own blocker. */
  cycle?: string[];
  /**
   * Whether a person is owed an answer here, and whether the ask is where
   * they read it: `'filed'` when a pending review item exists, `'unfiled'`
   * when the board says a person is waited on and nothing is filed, absent
   * when nobody is waiting. Answered separately from `bucket` — see the
   * branch that sets it for why the two may never share one.
   */
  ownerAsk?: OwnerAsk;
  /**
   * `ownerAsk === 'filed'` only: every open item filed for this row, newest
   * first — the declaration that makes the wait legitimate, by address. A row
   * waiting on a person names the ask it waits on; nothing else may say a row
   * is waiting.
   */
  waitingOn?: FiledItemAddress[];
  /** TRUE means this row is waiting on the owner with NO pending review item
   *  — here or anywhere on its chain's terminal — an ask that exists only in
   *  someone's head. The owner cannot see it on the Home queue, so it counts
   *  toward FAIL (7 of 10 "blocked-on-owner" rows on the 08-27 "PASS" board
   *  were this). Read off `ownerAsk`, never off `bucket`. */
  unfiledAsk: boolean;
  /**
   * TRUE means the task's own newest words ASK a person for something and
   * nothing is filed on that person's queue — the wait an agent declared in
   * chat and nowhere else (`waiting-unfiled.ts`).
   *
   * It is not a bucket, and that is deliberate: a bucket is a claim about
   * what the BOARD knows, and prose is not that. What it does is refuse the
   * note the movement credit it would otherwise get — such a note is left out
   * of `sinceActivityMs` above — so the task reaches the ordinary quiet
   * window instead of being reset every turn by the agent saying it is stuck.
   * The gate names it under its own bucket word from there.
   */
  waitingUnfiled: boolean;
}

/** A ticket's own clock: when it entered its current status. */
function enteredStatusAt(t: TaskRow): number {
  const last = t.transitions?.[t.transitions.length - 1];
  return last?.ts ?? t.createdAt;
}

/** The newest note on the row, of any kind; 0 when it has none. Read off the
 *  row rather than the events, because that is the only place a note lives
 *  (see `TaskRow.notes`). Notes append in arrival order but carry the
 *  poster's clock, so the max is taken rather than the last. */
function newestNoteAt(t: TaskRow): number {
  let newest = 0;
  for (const n of t.notes ?? []) if (typeof n.ts === 'number' && n.ts > newest) newest = n.ts;
  return newest;
}

export function classifyOpenTasks(
  tasks: TaskRow[],
  events: EventRow[],
  reviewItems: ReviewItemRow[],
  now: number,
  stallMs: number,
  bands: {
    dispatchable: Set<string>;
    ownerBand: Set<string>;
    /** Goals nobody has agreed to yet. A row under one is not judged at all
     *  — see the skip in the loop below. Optional because the report's older
     *  callers never learned goal status; absent reads as "no band in
     *  triage", the same as before. */
    triage?: ReadonlySet<string>;
  },
  /**
   * The row's newest movement that the board's own timestamps cannot see, per
   * taskId — this classifier's ONE seam for such evidence, kept single on
   * purpose so callers merge into it rather than growing parallel notions of
   * activity. Callers take the max of everything they can see:
   *
   *  - `thread.lastActivity` from the row's discussion doc
   *    (`GET /api/docs/task:<id>/threads`). A comment IS activity: a row whose
   *    whole decision conversation is live on its thread is not quiet.
   *  - a registered builder's worktree churn (`dispatches.activityFor`).
   *  - the last content change to a doc the row LINKS (server.ts): an agent
   *    rewriting the doc a row is about is the row moving. Only a LINKED doc
   *    — an unlinked one is invisible here, so such a row still reads as
   *    quiet while its doc is being written; server.ts states why at the
   *    merge site.
   *
   * The CLI fetches these only for rows a first pass reported stalled, which
   * caps the per-row calls at the handful being reported. (The `/api/docs`
   * listing's `lastActivityAt` is NOT usable here — it is a `.ydoc` mtime,
   * refreshed by server-side snapshot rewrites; see
   * packages/server/src/landing.ts rule 1. Nor is a doc's `lastTouchedAt`,
   * which mere reads set. `LiveDoc.lastContentChangeAt` is the signal that
   * means somebody actually changed the content.)
   */
  threadActivity?: Map<string, number>,
  /**
   * What each task's newest notes say, by id (`waiting-unfiled.ts`). The
   * caller reads the prose; this module only ever consumes the verdict, so
   * the rule that no bucket here is set from an agent's words still holds.
   *
   * Absent — every caller that does not compute it — reads exactly as it did
   * before: every note counts as movement and nothing is `waitingUnfiled`.
   */
  noteClocks?: Map<string, NoteClock>,
): Classified[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const asks = indexFiledAsks(reviewItems);
  const lastEventByTask = new Map<string, number>();
  for (const e of events) {
    if (e.taskId && e.ts > (lastEventByTask.get(e.taskId) ?? 0))
      lastEventByTask.set(e.taskId, e.ts);
  }
  const out: Classified[] = [];
  for (const t of tasks) {
    if (t.status !== 'todo' && t.status !== 'in-progress') continue;
    // A row under a band in TRIAGE is not judged at all — not bucketed, not
    // counted. The band's status is already the verdict: `goal-triage` holds
    // every row under it out of every dispatch read (ready-gate.ts), so
    // nobody was supposed to be moving it, and a clock over it would only
    // measure how long the goal has gone unagreed. Every bucket below is a
    // claim about work somebody could act on; here the only thing to act on
    // is the goal, and a wake over its rows would ask the lead to drive work
    // the board itself says is not ready. Skipped one line after the status
    // filter because it is the same kind of exclusion: a row deferred by its
    // own status and a row deferred by its band's are both deliberate.
    if (bands.triage?.has(t.goal ?? '')) continue;
    const unmet = (t.after ?? []).filter((dep) => {
      const d = byId.get(dep);
      return d !== undefined && d.status !== 'done';
    });
    const ageMs = now - enteredStatusAt(t);
    // Read before the clock, because it decides what the clock may count: an
    // asking note is refused its movement credit only while nothing is filed.
    // With an ask on the person's queue the task is `blocked-on-owner` below
    // and never stalls anyway, so leaving the note counted there keeps one
    // fewer surprise for the tick after the item is answered.
    const hasPendingAsk = asks.has(t.id);
    const clock = noteClocks?.get(t.id);
    const waitingNote = !hasPendingAsk && clock?.askedAt !== undefined;
    const noteAt = waitingNote ? (clock?.newestPlainAt ?? 0) : newestNoteAt(t);
    const sinceActivityMs =
      now -
      Math.max(
        enteredStatusAt(t),
        lastEventByTask.get(t.id) ?? 0,
        threadActivity?.get(t.id) ?? 0,
        noteAt,
      );
    // A deliberately-deferred row does not reach this loop at all: parking
    // moves it to `triage` (2026-08-27), and the status filter above keeps
    // only `todo` and `in-progress`. The `parked` bucket that used to sit
    // here existed to stop such a row reading as stalled — a measured
    // false-FAIL, a live row deferred to 2026-08-28 reported "ready-unpicked
    // stalled" at 07:59Z — and the exclusion now does that job one step
    // earlier, for the unfiled-ask bucket below as well.
    const inBacklog = !bands.dispatchable.has(t.goal ?? '') && !bands.ownerBand.has(t.goal ?? '');
    const boardSaysOwnerWaits = t.ownerKind === 'person' || bands.ownerBand.has(t.goal ?? '');
    // TWO QUESTIONS, ANSWERED SEPARATELY (2026-09-17). Is a person owed an
    // answer here (`owner-ask.ts`, which is also where what counts as an ask
    // is written down), and is this row work somebody picks up (the bucket
    // below). They shared one branch until a rule row showed why they cannot:
    // `scheduled-rule` is decided FIRST, so no scheduled row ever reached the
    // unfiled reading, and a question left on one went unread while the rule
    // kept closing green. That precedence is right for dispatch and was never
    // right for asks, so the ask is read off the same facts, separately.
    // The schedule goes in as a FOURTH FACT rather than being re-derived
    // here: a row whose rule has not fired yet is deferred, not asked, and
    // #1077 lost that by reading the ask off three facts none of which can
    // see a date. `owner-ask.ts` still reads no bucket, and the bucketing
    // below still reads nothing of the ask.
    const ownerAsk = ownerAskOf({
      hasPendingAsk,
      boardSaysOwnerWaits,
      inBacklog,
      ...(t.schedule !== undefined ? { schedule: t.schedule } : {}),
      now,
    });
    let bucket: Bucket;
    // A rule row first: not work anyone picks up whatever else is true of it,
    // and reading it as ready-unpicked sent a session at a runbook
    // (2026-09-07). Then a FILED ask, which outranks even the backlog.
    if (t.schedule !== undefined) bucket = 'scheduled-rule';
    else if (hasPendingAsk) bucket = 'blocked-on-owner';
    else if (boardSaysOwnerWaits)
      bucket = inBacklog ? 'backlog-unranked' : 'blocked-on-owner-unfiled';
    else if (unmet.length > 0) bucket = 'blocked-on-dependency';
    else if (t.status === 'in-progress') bucket = 'in-progress';
    // The standing owner rule (2026-08-22): the backlog is NOT auto-dispatched
    // — goal bands run in priority order, everything else waits for a person
    // to rank it. Idle BY RULE, never a failure; 53 unranked rows is a finding.
    else if (inBacklog) bucket = 'backlog-unranked';
    else bucket = 'ready-unpicked';
    out.push({
      id: t.id,
      title: t.title,
      bucket,
      ageMs,
      sinceActivityMs,
      // A blocked ticket is allowed to be old; only unblocked buckets stall.
      stalled:
        (bucket === 'in-progress' || bucket === 'ready-unpicked') && sinceActivityMs > stallMs,
      ...(unmet.length > 0 ? { blockers: unmet } : {}),
      ...(ownerAsk !== undefined ? { ownerAsk } : {}),
      ...(ownerAsk === 'filed' && asks.newestAt(t.id) !== undefined
        ? { askAgeMs: now - (asks.newestAt(t.id) ?? now) }
        : {}),
      ...(ownerAsk === 'filed' && asks.addressesFor(t.id) !== undefined
        ? { waitingOn: asks.addressesFor(t.id) }
        : {}),
      unfiledAsk: ownerAsk === 'unfiled',
      // Only on a task that would otherwise read as work in flight, or as a
      // rule. A task the BOARD already says waits on a person with nothing
      // filed is the `blocked-on-owner-unfiled` finding, and naming one
      // failure twice would hand the lead one action wearing two hats; a
      // dependency-blocked or backlog row has its silence explained already.
      // A rule row is here because its agent's words ask a person for
      // something whether or not anybody picks the row up.
      waitingUnfiled:
        waitingNote &&
        (bucket === 'in-progress' || bucket === 'ready-unpicked' || bucket === 'scheduled-rule'),
    });
  }
  // Second pass: attribute each dependency chain to its TERMINAL blocker —
  // the row the whole chain is actually waiting on. "after t-X" is only half
  // an answer when t-X is itself waiting on the owner; and a chain that bottoms
  // out in an UNFILED ask is an unfiled ask for every row behind it too.
  //
  // Two Codex findings on #396 shape the walk:
  //  - EVERY unmet branch is traversed (P1): a row with several `after` edges
  //    is unfiled when ANY branch ends unfiled — inspecting only the first
  //    branch produced a false PASS.
  //  - Only a dependency-blocked intermediate is transparent (P2): a dep that
  //    is itself owner-blocked / unfiled / in-progress IS the
  //    effective blocker, so the walk stops there instead of naming a deeper
  //    task and suppressing the intermediate's own state.
  const rowById = new Map(out.map((r) => [r.id, r]));
  for (const r of out) {
    if (r.bucket !== 'blocked-on-dependency') continue;
    const visited = new Set<string>([r.id]);
    const terminals: TaskRow[] = [];
    let cycle: string[] | undefined;
    const walk = (task: TaskRow, path: string[]): void => {
      for (const dep of task.after ?? []) {
        const d = byId.get(dep);
        if (d === undefined || d.status === 'done') continue;
        if (visited.has(d.id)) {
          // Revisited node. An ANCESTOR on the current path is a loop —
          // record how it closes; a node merely reached via another branch
          // is ordinary DAG sharing and is not.
          const idx = path.indexOf(d.id);
          if (idx >= 0 && cycle === undefined) cycle = [...path.slice(idx), d.id];
          continue;
        }
        visited.add(d.id);
        if (rowById.get(d.id)?.bucket === 'blocked-on-dependency') walk(d, [...path, d.id]);
        else terminals.push(d);
      }
    };
    const rootTask = byId.get(r.id);
    if (rootTask) walk(rootTask, [r.id]);
    if (cycle) r.cycle = cycle;
    const bucketOf = (task: TaskRow): Bucket | undefined => rowById.get(task.id)?.bucket;
    // Off the terminal's ASK, not its bucket: a chain ending on a rule row
    // that carries an unanswered question waits on that question. Terminals
    // are never `blocked-on-dependency` and this loop writes only to rows
    // that are, so no terminal's reading here has been touched already.
    const askOf = (task: TaskRow): Classified['ownerAsk'] => rowById.get(task.id)?.ownerAsk;
    const anyUnfiled = terminals.some((d) => askOf(d) === 'unfiled');
    // One terminal is displayed; the worst branch wins the slot: an unfiled
    // ask, else a filed owner-block, else whatever came first.
    const pick =
      terminals.find((d) => askOf(d) === 'unfiled') ??
      terminals.find((d) => askOf(d) === 'filed') ??
      terminals[0];
    // A pure cycle sets no terminal: a loop member is not its own blocker,
    // and `cycle` above is what the report presents instead.
    if (pick) r.terminal = { id: pick.id, label: bucketOf(pick) ?? pick.status };
    if (anyUnfiled) r.unfiledAsk = true;
  }
  return out.sort((a, b) => b.sinceActivityMs - a.sinceActivityMs);
}

/**
 * Agent activity per recent hour — the "busy or not spawned" evidence.
 *
 * What is counted, exactly:
 *  - every `/events` row whose `actor.kind === 'agent'` — on the live server
 *    that is the task.* family (transitioned, created, regrouped, body_edited,
 *    parked, assigned, retitled, archived, evidence_amended, restored),
 *    decision.answered, and workspace.* edits. Rows with no actor
 *    (agent.heartbeat, agent.attached, server.started) are excluded: they are
 *    liveness, not work.
 *  - `extraTicks`: timestamps from `collectActivityTicks` below — row edits
 *    and review-item filings the events feed does not reliably carry.
 */
export function agentActivityByHour(
  events: EventRow[],
  now: number,
  hours: number,
  extraTicks: number[] = [],
): number[] {
  const buckets = new Array<number>(hours).fill(0);
  const add = (ts: number) => {
    const h = Math.floor((now - ts) / 3_600_000);
    if (h >= 0 && h < hours) buckets[h] = (buckets[h] ?? 0) + 1;
  };
  for (const e of events) {
    if (e.actor?.kind !== 'agent') continue;
    add(e.ts);
  }
  for (const ts of extraTicks) add(ts);
  return buckets; // index 0 = the most recent hour
}

/**
 * A row timestamp within this of an event for the same task is the SAME
 * action seen through two lenses, not two actions. Measured skew between an
 * event's `ts` and the row fields the same handler writes is tens of
 * milliseconds; 5s covers any debounced flush without swallowing a genuinely
 * separate edit.
 */
const EVENT_TICK_EPSILON_MS = 5_000;

/**
 * Activity timestamps the `/events` feed misses (measured: a Team Lead board
 * row update at 07:19Z never appeared in `/events`, so the histogram read
 * "0/12 hours" across a worked window). Sources, exactly:
 *  - task rows: `updatedAt`, `bodyWrittenAt`, `titleWrittenAt` — deduped per
 *    row, and emitted ONLY as a fallback: a normal transition moves
 *    `updatedAt` AND appears in `/events`, so a timestamp within
 *    EVENT_TICK_EPSILON_MS of any event for the same task is skipped rather
 *    than counted twice (an unconditional tick inflated the histogram exactly
 *    when the events feed worked). The dedup compares against ALL events for
 *    the task, whatever the actor — a person's transition should not re-enter
 *    as an unattributed tick either. These fields carry no actor, so a rare
 *    uncovered person edit still counts — the histogram's question is "was
 *    the board being worked", and an unattributed tick beats a false 0.
 *  - review items: `askedAt` — filing an ask is agent work; deduped the same
 *    way against the item's task, should a filing ever start emitting events.
 */
export function collectActivityTicks(
  tasks: TaskRow[],
  reviewItems: ReviewItemRow[],
  events: EventRow[] = [],
): number[] {
  const eventTsByTask = new Map<string, number[]>();
  for (const e of events) {
    if (!e.taskId) continue;
    const list = eventTsByTask.get(e.taskId);
    if (list) list.push(e.ts);
    else eventTsByTask.set(e.taskId, [e.ts]);
  }
  const coveredByEvent = (taskId: string | undefined, ts: number): boolean => {
    if (!taskId) return false;
    const list = eventTsByTask.get(taskId);
    return list?.some((et) => Math.abs(et - ts) <= EVENT_TICK_EPSILON_MS) ?? false;
  };
  const ticks: number[] = [];
  for (const t of tasks) {
    const seen = new Set<number>();
    for (const ts of [t.updatedAt, t.bodyWrittenAt, t.titleWrittenAt]) {
      if (typeof ts === 'number' && ts > 0 && !seen.has(ts) && !coveredByEvent(t.id, ts)) {
        seen.add(ts);
        ticks.push(ts);
      }
    }
  }
  for (const r of reviewItems) {
    if (typeof r.askedAt === 'number' && r.askedAt > 0 && !coveredByEvent(r.taskId, r.askedAt))
      ticks.push(r.askedAt);
  }
  return ticks;
}
