/**
 * Which rows the stall loop may name — work that was supposed to be moving
 * and has stopped.
 *
 * ── How this differs from `ready-gate.ts`, which sits next to it ─────────
 *
 * That gate answers "is there work nobody has picked up", and it deliberately
 * refuses to use a clock: a measurement across two real boards found the
 * median gap between task events at about fifteen minutes, so an elapsed-time
 * test flagged working agents at roughly the rate it flagged stalled ones.
 * Read its header before changing anything here — the numbers are all there.
 *
 * This gate asks the opposite question. A row that is `in-progress` has an
 * owner who said they were on it, and the only evidence available that they
 * stopped IS the silence. So the clock is unavoidable here, and the honest
 * thing is to state where it is weak rather than to pretend otherwise:
 *
 *  - **The recipient is the lead, not the worker.** A false positive costs
 *    one check-in by somebody whose job is already to know the board's state.
 *    The measurement that killed the clock next door was about interrupting
 *    the agent mid-flow, which is a much more expensive mistake.
 *  - **Every state that EXPLAINS the silence is checked first**, and each one
 *    is dependency state rather than a second clock: a filed question waiting
 *    on a person, a deliberate park with a date, an unfinished dependency, a
 *    goal outside every ranked band. A row only reaches the clock once none of
 *    those can account for it.
 *  - **The threshold is configurable and the default is somebody's decision,
 *    not a measurement.** Twenty minutes is Bryan's, and the reasoning is in
 *    the constant below.
 *
 * ── Why the verdict carries three lists ─────────────────────────────────
 *
 * `stalled` is work that should be moving and is not — the lead drives it.
 * `unfiled` is a different failure wearing similar clothes: a row waiting on
 * a person with no question filed anywhere they read. Nobody is failing to
 * work it, so it is not a stall, and the remedy is to file the ask rather
 * than to chase the owner. Merging the two would hand the lead one list with
 * two incompatible actions in it. It runs on the same clock as `stalled`,
 * for the reason given where the gate is applied below: an ask that was
 * created a minute ago is one the lead may well be in the middle of filing.
 * A row reaches it two ways — a person owns it, or its band is the owner's
 * own queue — and nothing else: the row's prose is never read for a wait
 * (rebuild step 2). A row that IS legitimately waiting carries the address
 * of its filed item, and the verdict lists those rows too (`waiting`) so a
 * later reader can check the ask rather than trust the bucket.
 *
 * `undetermined` is the load-bearing one, and it is the same argument
 * `ready-gate.ts` makes: a row whose review items cannot be parsed answers
 * "no open questions" identically to a row that genuinely has none — and an
 * open question is precisely what would have exonerated it. Such a row is not
 * named as stalled and is not counted healthy either. It is named as unread,
 * so the silence about it belongs to somebody.
 *
 * `unresumed` is the fourth, and it is the only one that says something GOOD
 * happened: a row whose ask was answered, or whose done-when line went met
 * with later lines still open, and which nothing has touched since. The lead's
 * act is to hand the answer back to whoever was waiting on it, not to look for
 * an owner — so it is its own list and its own sentence. What it rests on is
 * `blockage-lift.ts`; every gate it passes is applied at the reading below.
 */
import { type Lift, type LiftKind, unresumedSince } from './blockage-lift.ts';
import {
  type EventRow,
  type FiledItemAddress,
  type ReviewItemRow,
  type TaskRow,
  classifyOpenTasks,
} from './keep-moving.ts';
import { externalWaitActive } from './task-wait.ts';
import { WAITING_UNFILED_BUCKET } from './waiting-unfiled.ts';

/**
 * Twenty minutes (Bryan, 2026-08-27: "Detect at 20 minutes").
 *
 * The ticket defined a stall as thirty minutes of silence AND asked that
 * stalls surface within thirty minutes. Those cannot both hold — detection
 * cannot precede the definition — so shipping the ticket's own number would
 * have surfaced a stall at about thirty-one minutes and missed the goal by
 * construction. Twenty is what makes the goal reachable: the wake fires
 * inside a tick of the threshold, so a row that goes quiet is named within
 * forty minutes of going quiet (the owner's number, 2026-09-11: "anything
 * that's stalled for more than half an hour").
 *
 * It buys that with false positives, and the trade was made knowing so. This
 * is a decision rather than a finding — see the header for what is and is not
 * known about elapsed time as a signal — so it is exported, overridable via
 * `CW_STALL_NUDGE_MINUTES`, and the one number to reach for first if the wake
 * turns out to be noisy.
 *
 * SINCE 2026-09-17 IT NO LONGER SETS TIME-TO-FIRST-WAKE ON ITS OWN. This is
 * when a row becomes a FINDING; the frame naming it also has to clear the
 * moved-within deferral, which `stall-wiring.ts` sets at twice this number.
 * So an ordinary in-progress row with nothing louder beside it is named at
 * about twice this window, and halving this knob halves both. The reasoning
 * is in `docs/architecture/stall-detection.md`; the name is older than the
 * behaviour, which is why this paragraph is here.
 */
export const STALL_QUIET_DEFAULT_MS = 30 * 60_000;

/**
 * How long a DISPATCHED, in-progress row may go without anybody saying
 * anything before its lead is reminded to ask for a check-in.
 *
 * Thirty minutes (Bryan, 2026-09-11: *"let's do something to make sure lead
 * agent or subagents working on a task send an activity update at least once
 * every 30m"*). It is the same half hour the board skills now ask every
 * session to report on, and the same one Home's quiet pill turns amber at, so
 * what the reader sees and what the lead is told cannot drift apart.
 *
 * Not the stall clock, and deliberately a DIFFERENT finding. A stall says
 * nobody is on the row; this says somebody is and has stopped narrating, so
 * the lead's move is to poke the builder rather than to re-home the work.
 * Scoped to rows with a watching dispatch for the reason `builder-silent`
 * below is: a row whose watcher is dead cannot be told apart from a quiet
 * one, and a degraded signal must not manufacture findings.
 *
 * `CW_CHECK_IN_MINUTES` overrides it.
 */
export const CHECK_IN_DEFAULT_MS = 30 * 60_000;

/** The bucket a row due for a check-in carries. Its own word, like
 *  `BUILDER_SILENT_BUCKET`: the lead's move differs, and a frame that
 *  flattened the two would send them hunting for a new owner instead of
 *  asking the one they have for a line. */
export const CHECK_IN_BUCKET = 'check-in-due';

/**
 * How many quiet windows a row with a WATCHING builder dispatch gets before
 * it stalls. Two: the ordinary window, plus one full missed check-in.
 *
 * A registered dispatch changes what the silence means. An undispatched row's
 * silence says nobody is on it, and twenty minutes of that is worth a wake. A
 * row with a builder whose worktree is being watched has somebody on it BY
 * CONSTRUCTION — the builder promised work by existing — so its silence is a
 * missed check-in rather than an empty seat, and one window of it is routine
 * (a builder reading code, or a watcher between events). Two windows of
 * nothing anywhere — no worktree churn, no thread, no board event — is the
 * builder gone, and that IS worth a wake, under its own name (`builder-silent`
 * below) so the lead probes or replaces the builder rather than hunting for
 * someone to claim the row.
 *
 * Like the quiet default above this is a decision, not a measurement, so it
 * is exported and overridable via `CW_BUILDER_SILENT_MULTIPLIER` — the number
 * to turn if silent builders are being named too eagerly or too late. It only
 * ever applies to a dispatch that is actually watching: a dead or unarmed
 * watcher cannot tell activity from absence, and a degraded signal must not
 * loosen detection, so such a row keeps the ordinary clock unchanged.
 */
export const BUILDER_SILENT_MULTIPLIER_DEFAULT = 2;

/**
 * The bucket a dispatch-silent row carries in the wake frame. Not one of
 * `classifyOpenTasks`'s buckets on purpose: the classifier's vocabulary is
 * shared with the keep-moving report and describes board state, while this
 * word describes what the WAKE knows on top of it — a builder that stopped
 * reporting. The remedy differs per bucket (see `StalledRow.bucket`), which
 * is why it is a distinct word rather than a flag on `in-progress`.
 */
export const BUILDER_SILENT_BUCKET = 'builder-silent';

/**
 * The word the `awaitingPerson` RECORD carries for a row the BOARD says a
 * person owns — by assignee or by band — with no item on that person's queue.
 *
 * Named on the row here rather than taken from `Classified.bucket`, because
 * the bucket answers a different question (is this work somebody picks up)
 * and a rule row answers it `scheduled-rule`. Left to speak for the ask, that
 * word told the reader "a schedule rule, whose instances are the work"
 * (`stall-escalation.ts`'s `BUCKET_WORDS`) about a row carrying an unanswered
 * question — the swallowing, moved one file downstream. For every row that is
 * not a rule this is the bucket the row already had.
 *
 * It was an `unfiled` FINDING until 2026-09-22, and is now a record: see
 * `StallVerdict.awaitingPerson`.
 */
export const OWNER_UNFILED_BUCKET = 'blocked-on-owner-unfiled';

/** Why a row could not be evaluated. A closed vocabulary, matching
 *  `ready-gate.ts`, so the rendered line can name the condition rather than
 *  saying that something went wrong. */
export type StallUndeterminedReason = 'review-items-unreadable';

/** One row the lead is being asked to look at. */
export interface StalledRow {
  id: string;
  title: string;
  /** Which keep-moving bucket put it here — `in-progress` (claimed and gone
   *  quiet), `ready-unpicked` (nothing blocking it and nobody on it),
   *  `waiting-unfiled` on the `unfiled` list (the row's own note was READ as
   *  an ask, by a regex over prose), `blocked-on-owner-unfiled` on the
   *  `awaitingPerson` record — or the gate's own `builder-silent` (a watched
   *  builder that stopped reporting; probe or replace it). The lead's next
   *  move differs per bucket, so the frame must not flatten them into one
   *  word. The two ways of waiting on a person were rendered in one sentence
   *  until `nudge-line.ts` learned to read this field, which told the reader
   *  a person was waiting when only a regex over an agent's status note had
   *  said so — the flattening this comment forbids, downstream of it. */
  bucket: string;
  /** How long since anything touched the row — a transition, an edit, or a
   *  comment on its discussion. */
  quietMs: number;
}

/** A row legitimately waiting on a person: the ask is filed, and this is
 *  where. Not a finding — the reader has it on their queue. */
export interface WaitingRow {
  id: string;
  title: string;
  /** Every open item filed for the row, newest first. Never empty: a row
   *  with none is `unfiled`, not waiting. */
  waitingOn: FiledItemAddress[];
}

/**
 * A wait an agent DECLARED on a row, for a thing the board cannot see
 * (`task-wait.ts`). Named on the frame in the declarer's own words, so the
 * lead reads "waiting on the fleet restart" rather than being told a second
 * time that a row is quiet.
 *
 * Emitted for every NAMED row carrying a declaration — stalled or unfiled —
 * because the point is that nothing is hidden; which of those the wake stops
 * treating as a finding is `stall-nudge.ts`'s `withoutStandingWaits`, and it
 * is only ever the stalled ones.
 */
export interface DeclaredWaitRow {
  id: string;
  title: string;
  /** What it waits on, verbatim. */
  what: string;
  /** When the wait first started — surviving renewals of the same words, so a
   *  wait that has been rolling over all day reads as one. */
  since: number;
  /** When the declaration lapses. */
  until: number;
  /** Who declared it. */
  by: string;
  /**
   * `until` has passed. Present rather than absent-and-false so a reader
   * cannot mistake an old server's silence for "still standing": a lapsed
   * wait is the one that has to be SAID, because the row is loud again and
   * the lead needs to know the sentence they wrote has run out.
   */
  lapsed?: true;
}

/**
 * A row whose blockage LIFTED and whose work has not restarted
 * (`blockage-lift.ts`): an ask on it was answered, or a done-when line went
 * met with later lines still open, and nothing has touched the row since.
 *
 * Its own list, beside `stalled` rather than inside it, because the lead's
 * act differs and so does the evidence. A stalled row says nobody is on this
 * and the lead goes looking for somebody; this row says the answer that was
 * being waited for is IN, and names it — the lead hands it back to whoever
 * asked. It is also the only list that can speak for a row whose declared
 * wait is still standing (`stall-nudge.ts`'s `withoutStandingWaits` takes
 * those off `stalled` and nothing else), which is exactly the 21-hour shape:
 * a wait declared on a person who had already answered.
 *
 * A wait declared AT OR AFTER the lift is the exception, and the only one: it
 * is itself the record that somebody read the answer, so such a row is not
 * named here at all. The ordering is what separates the two, and the reading
 * is at the `unresumed` push below.
 */
export interface UnresumedRow {
  id: string;
  title: string;
  /** The classifier's bucket, as `StalledRow` carries it. */
  bucket: string;
  /** How long since anything touched the row — the same reading every other
   *  finding here runs on. */
  quietMs: number;
  /** Which signal said the blockage lifted. */
  lift: LiftKind;
  /** When it lifted, and how long ago. Carried so a reader can check the
   *  event — the way `ungatedUi` carries the file that convicted a row —
   *  rather than take the finding's word for it. */
  liftedAt: number;
  liftedMs: number;
  /** What is now unblocked, in the board's own words. */
  what: string;
  /** What is open now: the first open line after the met one. `done-when-met`
   *  only. */
  next?: string;
}

/** A row the gate could not evaluate. */
export interface StallUndeterminedRow {
  id: string;
  reason: StallUndeterminedReason;
}

export interface StallVerdict {
  /** Work that should be moving and is not, quietest first. */
  stalled: StalledRow[];
  /**
   * Rows whose own agent said, in its closing words, that it waits on a
   * person, with no question filed where that person would see it
   * (`waiting-unfiled.ts`). One bucket, `waiting-unfiled`, and one remedy the
   * agent can perform: file the ask, or say there was none.
   *
   * It carried a second bucket until 2026-09-22 — `blocked-on-owner-unfiled`,
   * the BOARD saying a person owns the row. That one is `awaitingPerson`
   * below now, because it is not a finding: nobody has an act to perform on
   * it.
   */
  unfiled: StalledRow[];
  /**
   * Rows the BOARD says a person owns, with nothing on that person's queue —
   * `OWNER_UNFILED_BUCKET`. A RECORD, never a finding: it counts toward no
   * FAIL, enters no frame and reaches no review item.
   *
   * Why it is not a finding. There is no act for anyone here. An agent cannot
   * hand the row back — the board itself says a person holds it — so a wake
   * spends a turn that ends where it started, and stall frames naming such
   * rows were part of the 11% of fleet model spend measured on repeat or
   * empty reminders. The person cannot act either: the only thing the item
   * asked them to do was file a question to themselves about work already on
   * their own queue. One row reached the owner on three review items in five
   * days before this was retired (Bryan, 2026-09-21: "The first one is
   * assigned to me already. Work with workspaces to stop alerting me.").
   *
   * Kept as a record rather than dropped so that a week of verdicts still
   * answers "why is this row not moving" — the ready gate already holds the
   * same rows as `awaiting-person` (`ready-gate.ts`), and this is the same
   * fact where the verdict can be read.
   */
  awaitingPerson: StalledRow[];
  /**
   * Rows whose blockage lifted and whose work has not restarted, longest
   * since the lift first. NOT disjoint from `stalled`: a quiet row that was
   * answered is usually both, and the two sentences say different things
   * about it — one that nobody is driving it, one that the answer it was
   * waiting for is already in. The check-in list is the only one here that
   * has to be disjoint, because its remedy contradicts a stall's.
   */
  unresumed: UnresumedRow[];
  /** Rows waiting on a person WITH the question filed — by address. Listed
   *  so the wait is checkable, not so anyone is woken. */
  waiting: WaitingRow[];
  /**
   * Declared waits on rows this pass NAMED — what an agent said the row is
   * waiting on that the board cannot see (`DeclaredWaitRow`). Lapsed ones
   * included: the lapse is the finding.
   */
  declaredWaits: DeclaredWaitRow[];
  /** THE DENOMINATOR: how many open rows were examined. Stated so an empty
   *  `stalled` reads as "nine rows, all accounted for" rather than as an
   *  empty board. */
  considered: number;
  /** Rows whose state could not be read. Not stalled, and not healthy. */
  undetermined: StallUndeterminedRow[];
  /**
   * Dispatched, in-progress rows whose holder has not reported for
   * `CHECK_IN_DEFAULT_MS` — the missed half-hourly check-in, quietest first.
   *
   * Disjoint from `stalled` by construction: a row the gate already named as
   * stalled or builder-silent is not listed here too, because the lead would
   * then be asked to do two different things about one row in one frame.
   */
  checkIn: StalledRow[];
  /**
   * Runnable rows the board's parallelism cap put out of reach — ranked past
   * the top `parallelismCap` of `priorityOrder` — and so NOT judged for
   * stalling. Zero when no cap was given. Stated for the same reason
   * `considered` is: a board with two quiet rows and a cap of one must read
   * as "one judged, one beyond the cap", never as one healthy row.
   */
  beyondCapacity: number;
}

export interface EvaluateStallsInput {
  /** Every task on the board. Rows that are neither `todo` nor `in-progress`
   *  are dropped by the classifier and never reach the denominator. */
  tasks: readonly TaskRow[];
  /** Activity per row. The caller supplies these; on the server they are the
   *  row's own edit timestamps, which the board's event feed has measurably
   *  missed. */
  events: readonly EventRow[];
  /** Open questions waiting on a person, by row. Presence is what "an ask is
   *  filed" means. */
  reviewItems: readonly ReviewItemRow[];
  /** Which goals dispatch, which are the owner's own queue, and which are
   *  still in triage — a row under a triage band is not judged at all, not
   *  even as backlog (`classifyOpenTasks` states why at the skip). */
  bands: { dispatchable: Set<string>; ownerBand: Set<string>; triage?: ReadonlySet<string> };
  /**
   * Rows whose stored review items could not be PARSED. Passed in rather than
   * derived, because only the caller holds the store that failed to read them
   * — and a row that arrives here is excluded from every other list.
   */
  unreadableReviewTaskIds?: ReadonlySet<string>;
  now: number;
  quietMs?: number;
  /** Test seam over `CHECK_IN_DEFAULT_MS` — same reason `quietMs` is one. */
  checkInMs?: number;
  /** Newest comment per row, for the rows worth the lookup. A comment IS the
   *  row moving; without this a ticket whose whole conversation is live on its
   *  thread reads as abandoned. */
  threadActivity?: Map<string, number>;
  /**
   * What each row's newest notes say (`waiting-unfiled.ts`), by row id. The
   * caller does the reading; this gate and the classifier only consume the
   * verdict. Absent leaves every note counting as movement, exactly as before
   * the check existed.
   */
  noteClocks?: Map<string, import('./waiting-unfiled.ts').NoteClock>;
  /**
   * When each row's blockage last LIFTED, by row id (`blockage-lift.ts`). The
   * caller reads the two surfaces an answer can live on and the row's
   * done-when lines; this gate only ever consumes the verdict, exactly as it
   * does for `noteClocks`.
   *
   * Absent — every caller that does not compute it — leaves `unresumed`
   * empty, which is what every caller saw before the finding existed.
   */
  lifts?: Map<string, Lift>;
  /**
   * Rows with an OPEN dispatch whose worktree watcher is WATCHING — and only
   * those. The caller must exclude a dispatch whose watcher failed to arm or
   * died: such a row's activity cannot be seen, so it keeps the ordinary
   * clock, exactly the pre-dispatch behavior — a degraded signal must never
   * make detection stricter or looser than it was. Worktree activity itself
   * arrives merged into `threadActivity` by the caller; this set only says
   * whose silence is a builder's.
   */
  watchingDispatchTaskIds?: ReadonlySet<string>;
  /** Test seam over `BUILDER_SILENT_MULTIPLIER_DEFAULT` — same reason
   *  `quietMs` is one. */
  builderSilentMultiplier?: number;
  /**
   * The board's parallelism cap, with the rows in the board's own priority
   * order (`buildQueue`'s, the order `next_tasks` serves). Together they say
   * which rows the board is ALLOWED to have in flight: the first `cap`
   * runnable rows of `priorityOrder`. Only those are judged for stalling
   * (Bryan, 2026-08-31: *"the stall check takes the cap into account and
   * only checks that the top <n> tasks are in flight"*). A runnable row past
   * them is idle by rule — there is no slot for it — so its silence is not a
   * finding; it is counted in `beyondCapacity` instead.
   *
   * "Runnable" is the classifier's word, not a new one: `in-progress` or
   * `ready-unpicked`, the two buckets that can stall at all. A row waiting on
   * a person or a dependency takes no slot, so the cap does not skip over
   * it — otherwise a blocked row at the top of the queue would spend a slot
   * on nothing and hide a real stall two rows down.
   *
   * Both absent: every row is judged, exactly as before the cap existed.
   * `unfiled` and `undetermined` are untouched either way — a question filed
   * nowhere and a row nobody could read are findings whatever the capacity.
   * That sentence used to be a claim about which rows this set CONTAINS, and
   * it was false the day `waiting-unfiled` arrived: that finding rides the
   * two runnable buckets, so the cap held it. It is now a claim about what
   * the cap SUPPRESSES — the stall, builder-silence and check-in readings
   * only — enforced at each of those three readings rather than by skipping
   * the row (`beyondCap` in the loop below).
   */
  parallelismCap?: number;
  priorityOrder?: readonly string[];
}

/**
 * Sort every open row into stalled / waiting-on-an-unfiled-ask / unreadable.
 *
 * The classification itself is `classifyOpenTasks`'s, unchanged and shared
 * with the keep-moving report — which is the point of importing it rather
 * than restating its rules. What this function adds is the split into the
 * three lists above and the removal of rows nothing could read.
 */
export function evaluateStalls(input: EvaluateStallsInput): StallVerdict {
  const quietMs = input.quietMs ?? STALL_QUIET_DEFAULT_MS;
  const builderQuietMs =
    quietMs * (input.builderSilentMultiplier ?? BUILDER_SILENT_MULTIPLIER_DEFAULT);
  const watchingDispatches = input.watchingDispatchTaskIds ?? new Set<string>();
  const unreadable = input.unreadableReviewTaskIds ?? new Set<string>();
  const rows = classifyOpenTasks(
    [...input.tasks],
    [...input.events],
    [...input.reviewItems],
    input.now,
    quietMs,
    input.bands,
    input.threadActivity,
    input.noteClocks,
  );

  // Which runnable rows the cap leaves out of reach — see `parallelismCap` on
  // the input. Walked in priority order, spending a slot only on a row that
  // could actually be in flight, and only when a cap was given at all.
  const beyond = new Set<string>();
  if (input.parallelismCap !== undefined && input.priorityOrder !== undefined) {
    const runnable = new Map(
      rows
        .filter((r) => r.bucket === 'in-progress' || r.bucket === 'ready-unpicked')
        .map((r) => [r.id, r] as const),
    );
    let slots = Math.max(0, input.parallelismCap);
    for (const id of input.priorityOrder) {
      if (!runnable.has(id)) continue;
      if (slots > 0) slots -= 1;
      else beyond.add(id);
    }
  }

  // The declarations, by row, for the named lists below to draw on. Read off
  // the tasks the caller already handed over rather than through a second
  // input, so there is nothing for a parallel map to disagree with.
  const declared = new Map(
    input.tasks
      .filter((t) => t.externalWait !== undefined)
      .map((t) => [t.id, t.externalWait as NonNullable<TaskRow['externalWait']>] as const),
  );
  const declaredWaits: DeclaredWaitRow[] = [];
  const checkInMs = input.checkInMs ?? CHECK_IN_DEFAULT_MS;
  const stalled: StalledRow[] = [];
  const checkIn: StalledRow[] = [];
  const unfiled: StalledRow[] = [];
  const awaitingPerson: StalledRow[] = [];
  const unresumed: UnresumedRow[] = [];
  const waiting: WaitingRow[] = [];
  const undetermined: StallUndeterminedRow[] = [];
  for (const row of rows) {
    // Before every other verdict, deliberately: an unreadable review array is
    // the one thing that could have explained this row's silence, so a
    // reading taken without it is not a reading.
    if (unreadable.has(row.id)) {
      undetermined.push({ id: row.id, reason: 'review-items-unreadable' });
      continue;
    }
    // A row the cap keeps out of flight is not judged FOR STALLING — nobody
    // was supposed to be on it, so its silence is idleness by rule. It is
    // still judged for an unanswered ask: capacity says why nobody picked the
    // row up and says nothing about a question already asked and filed
    // nowhere. Read as a whole-row skip it swallowed exactly that — a
    // `waiting-unfiled` row rides `in-progress`, `ready-unpicked` or
    // `scheduled-rule` (`keep-moving.ts`), and the first two are the buckets
    // this set is built from, so on any board with more runnable rows than
    // its cap such a row was never named, never aged and escalated to nobody
    // (`waiting-unfiled-escalation.ts`). The sibling reading has always
    // worked, because a board-declared `blocked-on-owner-unfiled` row is not
    // runnable and so was never in this set at all.
    const beyondCap = beyond.has(row.id);
    const named: StalledRow = {
      id: row.id,
      title: row.title,
      bucket: row.bucket,
      quietMs: row.sinceActivityMs,
    };
    // A row with a watching builder is re-judged on the builder's own clock.
    // `classifyOpenTasks` stays untouched — the keep-moving report keeps its
    // shared meaning of "stalled" — and the gate narrows the WAKE's reading
    // on top, the same move the unfiled clock below makes. `sinceActivityMs`
    // already folds in every signal the caller had (board events, thread
    // comments, and worktree churn via `threadActivity`), so past the doubled
    // window the builder has been silent EVERYWHERE, which is a missed
    // check-in — named as `builder-silent` so the lead probes the builder
    // instead of hunting for someone to claim the row.
    const dispatched = watchingDispatches.has(row.id);
    let namedStalled = false;
    // Checked before every stall reading, because it is a DIFFERENT finding
    // about the same silence and the lead's act differs. The row's own agent
    // has said, in its closing words, that it is waiting on a person, and
    // nothing is filed where that person reads — so the remedy is one call to
    // file the ask (or one line saying there was no ask), not a hunt for
    // somebody to pick the row up. It joins the `unfiled` list, which is the
    // list whose whole meaning is "a person is being waited on and cannot
    // see it", under its own bucket word so the frame says which of the two
    // ways a row got there.
    //
    // On the ordinary quiet window, and the builder's doubled one does not
    // apply: a dispatch says somebody is working, and an unfiled ask is a
    // protocol breach whether or not work is happening around it.
    if (row.waitingUnfiled && row.sinceActivityMs > quietMs) {
      unfiled.push({ ...named, bucket: WAITING_UNFILED_BUCKET });
      namedStalled = true;
    } else if (!beyondCap && row.stalled && dispatched) {
      if (row.sinceActivityMs > builderQuietMs) {
        stalled.push({ ...named, bucket: BUILDER_SILENT_BUCKET });
        namedStalled = true;
      }
    } else if (!beyondCap && row.stalled) {
      stalled.push(named);
      namedStalled = true;
    }
    // A row the BOARD says a person owns, with nothing on their queue. A
    // RECORD and not a finding — `StallVerdict.awaitingPerson` says why — so
    // it leaves this function on a list nothing counts and nothing sends.
    //
    // Restricted to the row that actually owes the answer. `unfiledAsk` is
    // also set on rows BEHIND such a row, whose chain bottoms out in it —
    // recording those would say the same single fact several times over,
    // attached to rows it is not true of.
    //
    // The clock is kept, so the record names what the FRAME would have named
    // had this still been a finding: a row counted the moment it was created
    // read as a gap while the turn that filed it was still running, which is
    // how it produced six wakes in one evening with nothing stalled in any of
    // them. `classifyOpenTasks` is unchanged either way.
    //
    // Both of the readings below are `ownerAsk`, never `bucket`: whether a
    // person is owed an answer is not the same question as whether the row is
    // work anyone picks up, and a rule row answers the second one in a way
    // that used to swallow the first (`keep-moving.ts`).
    else if (row.ownerAsk === 'unfiled' && row.sinceActivityMs > quietMs)
      awaitingPerson.push({ ...named, bucket: OWNER_UNFILED_BUCKET });
    // A filed wait, by address. Not gated on the clock: it is not a finding.
    else if (row.ownerAsk === 'filed' && row.waitingOn && row.waitingOn.length > 0)
      waiting.push({ id: row.id, title: row.title, waitingOn: row.waitingOn });

    // The check-in, judged on its own and AFTER the lists above — a row the
    // gate has already named as stalled must not be named a second time under
    // a bucket asking for a different act.
    //
    // In-progress and dispatched, and both halves are load-bearing. The claim
    // is what says somebody took this work; the dispatch is what says their
    // activity can be seen at all, so a row whose watcher is dead keeps the
    // silence it always had. `sinceActivityMs` already folds in worktree
    // churn, comments and board events, so past this window the holder has
    // been silent everywhere, which is the missed check-in the protocol asks
    // about.
    if (
      !beyondCap &&
      dispatched &&
      !namedStalled &&
      row.bucket === 'in-progress' &&
      row.sinceActivityMs > checkInMs
    )
      checkIn.push({ ...named, bucket: CHECK_IN_BUCKET });

    // A blockage that lifted with nothing done since (`blockage-lift.ts`).
    // Judged on its own, after every list above and independent of all of
    // them, because it answers a different question: not "is anybody on this"
    // but "did the thing this was waiting for already arrive".
    //
    // Restricted to the two RUNNABLE buckets, and that is the exclusion that
    // keeps it honest. A row still blocked on an unfinished dependency, on
    // another open ask, or sitting under an unranked band cannot restart
    // whatever was answered on it — naming it would tell the lead to drive
    // work the board itself says is not startable. `in-progress` and
    // `ready-unpicked` are the only buckets where "the work has not restarted"
    // is a statement about anybody's behaviour.
    //
    // The parallelism cap is deliberately NOT applied, for the reason it is
    // not applied to an unfiled ask: the cap says why nobody picked the row
    // up and says nothing about an answer already given and read by nobody.
    // It is one line for the lead and no slot is needed to read it.
    //
    // And a DECLARED WAIT can answer it, which is the one thing that reads
    // the answer back. The finding's sentence is that nobody has recorded
    // reading the answer; an agent that declares, after the lift, what the row
    // now waits on HAS recorded exactly that, in its own words. Measured
    // 2026-09-22: two done-when lines reported met at 13:59:38Z, a wait
    // declared eleven seconds later standing until 21:59Z, and the 15:05Z pass
    // still naming the row as unresumed.
    //
    // THE ORDERING IS THE WHOLE RULE. A wait declared BEFORE the lift says
    // nothing about the answer — it is the 21-hour shape this finding was
    // built from, a wait declared on a person who then answered and was never
    // read — so it does not cover it. A lapsed wait does not cover it either:
    // the declaration has run out, and the row is loud again by every other
    // reading here. `declaredAt` rather than `since`, so a wait RENEWED after
    // the lift covers it: the renewal is the act of somebody looking at the
    // row again. `since` is the fallback for a sidecar written before
    // `declaredAt` existed, where it is the only stamp on the wait at all.
    const lift = input.lifts?.get(row.id);
    const wait = declared.get(row.id);
    const waitCoversLift =
      lift !== undefined &&
      wait !== undefined &&
      externalWaitActive(wait, input.now) &&
      (typeof wait.declaredAt === 'number' ? wait.declaredAt : wait.since) >= lift.at;
    if (
      lift !== undefined &&
      !waitCoversLift &&
      (row.bucket === 'in-progress' || row.bucket === 'ready-unpicked') &&
      unresumedSince(lift, { now: input.now, sinceActivityMs: row.sinceActivityMs, quietMs })
    )
      unresumed.push({
        ...named,
        lift: lift.kind,
        liftedAt: lift.at,
        liftedMs: input.now - lift.at,
        what: lift.what,
        ...(lift.next !== undefined ? { next: lift.next } : {}),
      });
  }
  // Longest since the lift first: the answer nobody has acted on for longest
  // is the one to hand back first.
  unresumed.sort((a, b) => b.liftedMs - a.liftedMs);
  // Every NAMED row's declaration, after the lists are settled: a wait is an
  // annotation on a finding, never a finding of its own, so a row nothing
  // named contributes nothing here. Longest-standing first, matching the
  // order the lists themselves carry.
  for (const row of [...stalled, ...unfiled]) {
    const wait = declared.get(row.id);
    if (wait === undefined) continue;
    declaredWaits.push({
      id: row.id,
      title: row.title,
      what: wait.what,
      since: wait.since,
      until: wait.until,
      by: wait.by,
      ...(externalWaitActive(wait, input.now) ? {} : { lapsed: true as const }),
    });
  }
  declaredWaits.sort((a, b) => a.since - b.since);
  // `classifyOpenTasks` already sorts by silence, longest first, and both
  // lists inherit that order — the row at the top is the one to start with.
  return {
    stalled,
    unfiled,
    awaitingPerson,
    unresumed,
    waiting,
    declaredWaits,
    considered: rows.length,
    undetermined,
    checkIn,
    beyondCapacity: beyond.size,
  };
}

/**
 * Five minutes (Bryan, 2026-08-29: *"If a review item's been unacceptable for
 * more than 5 minutes. Complain."*).
 *
 * Much shorter than the stall window, and the difference is what it
 * measures. A stalled row's silence is ambiguous — reading code looks like
 * absence — so twenty minutes buys confidence. A held item is not ambiguous:
 * its filer was told, in the same tool result, that the item is off the
 * queue until they revise it, and a revision is a one-call edit. Five minutes
 * of not doing it is the filer having moved on, and the reader's question is
 * sitting on nobody's list. A decision rather than a measurement, so it is
 * exported and `CW_HELD_ITEM_MINUTES` overrides it.
 */
export const HELD_ITEM_DEFAULT_MS = 5 * 60_000;

/** One held review item as the wake names it. `id` is the TICKET's id — the
 *  row the lead drives — and `reviewItemId` the item on it. */
export interface HeldItemRow {
  /** The row's opaque key — its TICKET's id for an item filed on a ticket,
   *  its DOC's id for one filed on a comment. It is what the stall stamp
   *  dedupes on, so it only has to be stable and unique, and both id spaces
   *  already are. */
  id: string;
  title: string;
  /** The item's id on whichever surface holds it: the review item's id on a
   *  ticket, the COMMENT's id on a doc thread. Both address exactly one ask,
   *  which is all `filerKey` and the stamp need of it. */
  reviewItemId: string;
  headline: string;
  /** The judge's reason: the gap the filer was asked to close. */
  reason: string;
  /** How long the item has been held. */
  heldMs: number;
  /** When THIS hold was placed (the judge's stamp). A revision that is held
   *  again gets a new one, which is what tells one hold from the next. */
  heldAt: number;
  /** The filer's display name — who the lead nudges. */
  filedBy: string;
  /** The filer's agent id, for the addressed nudge. Absent when unknown. */
  filerAgentId?: string;
  /**
   * The paste-ready `revise_review_item(…)` call that ends this hold —
   * spelled by whoever built the row, because only they know which surface
   * the item is on. Carried rather than re-derived so the lead's line, the
   * filer's wake and the filing route's own result cannot name three
   * different addresses for one item.
   */
  revise?: string;
  /** The doc-thread address, when that is where the item lives. Absent on a
   *  ticket item, which has `taskId` instead. */
  docId?: string;
  threadId?: string;
  commentId?: string;
  /** The ticket the item hangs on, when it hangs on one. */
  taskId?: string;
}

export interface HeldItemInput {
  /** Absent for an item filed on a plain doc thread — there is no ticket.
   *  `docId` is then what identifies the row. */
  taskId?: string;
  title: string;
  reviewItemId: string;
  headline: string;
  reason: string;
  heldAt: number;
  filedBy: string;
  filerAgentId?: string;
  revise?: string;
  docId?: string;
  threadId?: string;
  commentId?: string;
}

/**
 * Which held items have been held long enough to complain about. Strictly
 * longer than the window, oldest first: a four-minute hold is the filer
 * still on it, and a wake over it would train the lead to skim the one that
 * is not.
 */
export function overdueHeldItems(
  items: readonly HeldItemInput[],
  now: number,
  heldMs: number = HELD_ITEM_DEFAULT_MS,
): HeldItemRow[] {
  const out: HeldItemRow[] = [];
  for (const item of items) {
    const age = now - item.heldAt;
    if (age <= heldMs) continue;
    // Ticket id where there is one, doc id where there is not — see `id`. An
    // item with neither is unaddressable: it would render as a hold nobody
    // can find and would collide with every other such row in the stamp, so
    // it is dropped rather than shown.
    const id = item.taskId ?? item.docId;
    if (id === undefined) continue;
    out.push({
      id,
      title: item.title,
      reviewItemId: item.reviewItemId,
      headline: item.headline,
      reason: item.reason,
      heldMs: age,
      heldAt: item.heldAt,
      filedBy: item.filedBy,
      ...(item.filerAgentId !== undefined ? { filerAgentId: item.filerAgentId } : {}),
      ...(item.revise !== undefined ? { revise: item.revise } : {}),
      ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
      ...(item.docId !== undefined ? { docId: item.docId } : {}),
      ...(item.threadId !== undefined ? { threadId: item.threadId } : {}),
      ...(item.commentId !== undefined ? { commentId: item.commentId } : {}),
    });
  }
  return out.sort((a, b) => b.heldMs - a.heldMs);
}

/**
 * A review item a person asked a question on, still unrevised: OFF the
 * reader's queue (`pendingQuestionOf`) until its filer calls
 * `revise_review_item` — a reply on the question's thread does not put it
 * back. Measured 2026-09-09: two such items sat off the queue 38 hours behind
 * a wake that said only "quiet 1h 46m".
 */
export interface AskedBackRow {
  /** The TICKET's id — the row the lead drives. */
  id: string;
  title: string;
  reviewItemId: string;
  headline: string;
  /** Who asked, by display name. */
  askedBy: string;
  /** When THIS question was asked; a later question is a new finding. */
  askedAt: number;
  /** How long the question has stood unrevised. */
  askedMs: number;
  /** The paste-ready call that puts the item back, from `reviseCallFor`. */
  revise: string;
}

/** The asked-back items the LEAD is told about: a question standing longer
 *  than the quiet window, oldest first — the window a held item waits out. */
export function overdueAskedBack(
  items: readonly Omit<AskedBackRow, 'askedMs'>[],
  now: number,
  windowMs: number = STALL_QUIET_DEFAULT_MS,
): AskedBackRow[] {
  return items
    .map((item) => ({ ...item, askedMs: now - item.askedAt }))
    .filter((item) => item.askedMs > windowMs)
    .sort((a, b) => b.askedMs - a.askedMs);
}
