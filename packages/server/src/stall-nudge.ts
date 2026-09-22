/**
 * The board telling its lead that work has stopped.
 *
 * The gap this closes is the one thing a board can see and nobody acts on
 * until a person notices: a row somebody claimed, or a row the queue cleared,
 * that has gone quiet. Until now the only mechanism was the lead deciding to
 * go and look — which makes the human the watchdog for a fact the board
 * already holds, and measurement of two real lead sessions found the stalls
 * ending when the owner typed, not when anybody checked.
 *
 * So: a timer reads every board, asks `stall-gate.ts` which rows have stopped,
 * and sends ONE frame addressed to that board's lead. The frame rides
 * `sendToAgent` on `ws~<workspaceId>` — the same addressed delivery the
 * ready-work wake and `triage.requested` use, and for the same reason. It is a
 * DELIVERY rather than a change, so it deliberately does not go through the
 * store's emit choke point and never reaches `events.jsonl`.
 *
 * ── Why most of this file is about NOT sending ──────────────────────────
 *
 * Identical to the argument in `ready-nudge.ts`, and worth restating because
 * it is the only thing standing between this feature and being ignored: a
 * wake costs a turn, and one that repeats every tick while nothing has changed
 * costs a turn every tick. The lead learns — correctly — that the signal
 * carries no information, and then the wake that mattered arrives into a
 * session already trained to skim it.
 *
 * The arming rule is therefore a STAMP rather than a cooldown:
 *
 *     stamp = <how many repeat windows the board's oldest row has been quiet>
 *             | <row ids, sorted> | <unreadable rows, sorted>
 *
 * A board is woken when that stamp gets WORSE — a row id that was not stuck
 * before, a higher escalation bucket, or a row the pass could not read that it
 * could read last time. A board where nothing has changed says nothing, and so
 * does a board that has got better.
 *
 * That last clause is load-bearing, and it was the first version's bug. The
 * rule was equality, so a SHRINKING set re-armed the wake exactly as a growing
 * one did: the lead was woken to file an ask, filed it, the row left the list,
 * and the next tick woke the lead again to announce its own fix. A wake that
 * re-arms on the action it asked for cannot extinguish itself — measured on a
 * live board as six wakes in one evening, none of them naming a stalled row,
 * the unfiled count walking 1→2→3→2→1. The comparison lives in `growsOn`.
 *
 * ── Why escalation is folded into the stamp ─────────────────────────────
 *
 * This is the one place the design departs from the ready-work wake. Ready
 * work that nobody picks up is a queue fact and saying it once is enough.
 * A row that was supposed to be moving and is STILL not moving an hour later
 * is a worse fact than it was an hour ago, and a wake that never repeats would
 * let it sit forever behind a stamp that was correct when it was written.
 *
 * The obvious shape — a second timer, or a cooldown after which the wake
 * re-fires — is the wrong one, for the reason the file next door gives at
 * length: a repeat keyed on the clock keeps firing over a row nobody can do
 * anything about, which is how a channel becomes unreadable. So the repeat is
 * keyed on the ROW'S OWN silence instead, quantised into windows. A row that
 * has been quiet for four hours re-enters the stamp when it reaches eight, and
 * a row that recovers stops escalating with nothing to cancel: it simply
 * leaves the list.
 *
 * ── What is NOT checked, and why not ────────────────────────────────────
 *
 * The ticket asked for a capacity condition — only wake when the lead has
 * subagent capacity free. The server cannot know that. Nothing in the store,
 * the attached-agent roster, or the event stream carries how many subagents a
 * session is running; the nearest available number counts ATTACHED SESSIONS,
 * which is a different fact that would answer the question wrongly while
 * looking like an answer. The condition is dropped rather than approximated,
 * on the ticket's own instruction. If it is wanted, the count has to be
 * reported by the sessions themselves first.
 *
 * ── Why the stamps are on disk ──────────────────────────────────────────
 *
 * Prod restarts at every merge, several times a day. A map that lived only in
 * this process would hand every board a clean slate at each restart and
 * re-fire one wake per board over facts their leads had already been told —
 * the "signal carries no information" training above, delivered by the release
 * process rather than by a timer. Best-effort in BOTH directions and
 * deliberately so: a stamp file that cannot be read or written costs at most
 * one duplicate wake, which is much the cheaper failure.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ParallelismCapSummary } from './ready-nudge.ts';
import {
  STALL_MOVED_WITHIN_DEFAULT_MS,
  checkInTokens,
  everyNamedTaskMoved,
  rowBucketTokens,
  undeterminedTokens,
} from './stall-frame-news.ts';
import {
  type AskedBackRow,
  type DeclaredWaitRow,
  type HeldItemRow,
  STALL_QUIET_DEFAULT_MS,
  type StallUndeterminedRow,
  type StalledRow,
  type UnresumedRow,
  type WaitingRow,
} from './stall-gate.ts';
import type { UngatedUiRow } from './ui-review-gate.ts';
import type { UnansweredThreadRow } from './unanswered-thread.ts';
import { type SentSetsJson, WakeSentSets } from './wake-sent-sets.ts';

/**
 * How long a row must stay quiet before the wake says it AGAIN.
 *
 * Four hours: coarse enough that a lead who has seen the row once is not told
 * a second time inside the span it would take them to act on it, and fine
 * enough that a board left alone is named again every half hour it stays so
 * (the owner's number, 2026-09-11: "report again in half an hour if still
 * stalled"). It quantises the silence of the board's OLDEST quiet row — see the
 * header — so nothing here is a timer and nothing needs cancelling.
 *
 * `CW_STALL_REPEAT_HOURS` overrides it, because this is the number that sets
 * what a fleet pays to be told about boards where nothing is changing.
 */
export const STALL_REPEAT_DEFAULT_MS = 30 * 60_000;

/** How often the timer looks, when nobody says otherwise. Ten minutes, the
 *  owner's number (2026-09-11): below the quiet window, so a wake lands within
 *  a tick of being owed, and the window is what decides when that is. */
export const STALL_TICK_DEFAULT_MS = 10 * 60_000;

/**
 * How often ONE task may cost the lead a check-in reminder.
 *
 * Thirty minutes, the same window that makes a row due in the first place
 * (`CHECK_IN_DEFAULT_MS`), so a row that stays silent is re-said once per
 * missed check-in and never more. This is the one clock-keyed repeat in this
 * file, and it is keyed on the TASK rather than on the board: the ask is "get
 * a line out of whoever is on this row", and a row that has now missed two
 * check-ins is a worse fact than one that has missed one — the same argument
 * the escalation bucket makes for stalls, at the granularity the protocol
 * actually asks about.
 *
 * `CW_CHECK_IN_MINUTES` moves it, beside the window itself.
 */
export const CHECK_IN_REPEAT_DEFAULT_MS = 30 * 60_000;

/** Its own event name rather than a reason field on an existing one, because
 *  the plugin renders a board event off the name alone — one name would make a
 *  stall and a ready-work wake indistinguishable in the lead's channel. */
export const STALL_EVENT = 'workspace.stalled';

/**
 * The quality gate telling a FILER their review item is held — at filing
 * time (the route sends it) and again when the hold has stood past the
 * window (this loop sends it, `overdue: true`). Addressed to the filer,
 * never the lead: the lead learns of an overdue hold inside the stall frame,
 * where it sits beside the other things the lead drives.
 */
export const REVIEW_ITEM_HELD_EVENT = 'workspace.review_item_held';

/** The data-dir filename the server uses. Exported so a test can assert the
 *  file the server actually writes rather than a copy of its name. */
export const STALL_NUDGE_STAMP_FILENAME = 'stall-nudge-stamps.json';

/** One board, as the nudger needs to see it — `stall-gate.ts`'s verdict plus
 *  who to tell and whether to tell them at all. */
export interface StallSnapshot {
  workspaceId: string;
  /** The addressee. Absent means an empty seat, which is never woken. */
  leadAgentId?: string;
  retired: boolean;
  /** Work that should be moving and is not, quietest first. */
  stalled: readonly StalledRow[];
  /** Rows whose own agent said it waits on a person, with no question filed
   *  where they would see it. An agent can end each of them. */
  unfiled: readonly StalledRow[];
  /** Rows the BOARD says a person owns, with nothing on that person's queue
   *  (`StallVerdict.awaitingPerson`). A RECORD: nothing here reads it, and
   *  nothing may — it counts toward no verdict, enters no frame and reaches
   *  no review item. Carried on the snapshot so the keep-moving measurement
   *  can write it down. Absent when none, the same as empty. */
  awaitingPerson?: readonly StalledRow[];
  /**
   * Rows whose blockage LIFTED — an ask on them answered, or a done-when line
   * met with later lines still open — and which nothing has touched since
   * (`blockage-lift.ts`). Absent when none, and absent from a caller that
   * does not compute them, which is the same thing.
   */
  unresumed?: readonly UnresumedRow[];
  /** Rows waiting on a person with the question filed, by address. Not a
   *  finding and never woken over; carried so the verdict and the escalation
   *  can check the ask. Absent when none, the same as empty. */
  waiting?: readonly WaitingRow[];
  /**
   * Declared waits on the rows this pass named — what an agent said the row
   * waits on that the board cannot see (`stall-gate.ts`, `task-wait.ts`).
   * Absent when none, the same as empty.
   */
  declaredWaits?: readonly DeclaredWaitRow[];
  /** THE DENOMINATOR: how many open rows the gate examined. */
  considered: number;
  /** Rows the gate could not evaluate. Neither stalled nor healthy. */
  undetermined: readonly StallUndeterminedRow[];
  /** Runnable rows past the board's parallelism cap, which the gate did not
   *  judge (`stall-gate.ts`). Absent when none — the same as zero. */
  beyondCapacity?: number;
  /** The cap itself and its last move, for the wake to name beside
   *  `beyondCapacity`. Absent from a caller that does not read it. */
  parallelismCap?: ParallelismCapSummary;
  /** Review items the quality gate is holding past the window — asks that
   *  exist on a ticket and on nobody's queue. Absent on a snapshot from a
   *  caller that does not read them, which is the same as none. */
  held?: readonly HeldItemRow[];
  /** Review items a person asked a question on that the filer has not
   *  revised past the quiet window — off the reader's queue until revised
   *  (`stall-gate.ts` `AskedBackRow`). Absent when none. */
  askedBack?: readonly AskedBackRow[];
  /** Doc threads whose last speaker is a PERSON, past the day window: a
   *  question nobody has answered, on a doc that may hang on no task at all
   *  (`unanswered-thread.ts`). Absent when none, and absent from a caller
   *  that does not compute them, which is the same thing. */
  unanswered?: readonly UnansweredThreadRow[];
  /**
   * Dispatched, in-progress rows whose holder has not reported inside the
   * check-in window (`stall-gate.ts`, `CHECK_IN_DEFAULT_MS`). Absent when
   * none, and absent from a caller that does not compute them, which is the
   * same thing.
   */
  checkIn?: readonly StalledRow[];
  /**
   * Rows an agent filed that read as UI work and are being built with no
   * answered review item on them — the UI gate's breaches
   * (`ui-review-gate.ts`). Absent when none, and absent from a caller that
   * does not compute them, which is the same thing.
   */
  ungatedUi?: readonly UngatedUiRow[];
  /**
   * When a session last WROTE on this board — the newest agent-written note
   * or agent transition on any row. One of the three reads the escalation's
   * liveness question rests on (`stall-escalation.ts`): can anybody here
   * still act? Absent from a caller that does not compute it, which reads as
   * "never".
   *
   * Deliberately not per-row, and deliberately not the lead alone. Per-row
   * silence is what the gate already measures, and it says nothing about
   * whether the board has anyone on it: the item that prompted this read
   * "nothing has moved" about a row whose lead had written on four OTHER
   * rows in the preceding hour and was merging that row's child PRs at that
   * minute. Notes are written by sessions, so this is the board's pulse.
   */
  agentActiveAt?: number;
  /**
   * Whether any session attached to this board is DELIVERABLE right now — a
   * stream open, or observed inside the store's delivery window
   * (`hasLiveAttachment`). The second liveness read, and the one that
   * answers first: a board with a live session is never dead, whatever its
   * rows say. Absent reads as false.
   */
  sessionLive?: boolean;
  /**
   * The newest heartbeat or tool call the store recorded for any attachment
   * on this board — the third liveness read, for a session that is present
   * but has written nothing on any row. Absent reads as "never".
   */
  sessionObservedAt?: number;
}

/** What the filer's own wake carries. Flat, like every other frame. */
export interface ReviewItemHeldFrame {
  event: typeof REVIEW_ITEM_HELD_EVENT;
  workspaceId: string;
  /** The ticket the item hangs on. Absent for an item filed as a `review`
   *  payload on a plain doc thread, which hangs on a comment instead. */
  taskId?: string;
  title: string;
  /** The item's id on whichever surface holds it — the review item's id on a
   *  ticket, the COMMENT's id on a doc thread. */
  reviewItemId: string;
  /** The doc-thread address, when that is where the item lives. */
  docId?: string;
  threadId?: string;
  commentId?: string;
  /**
   * The paste-ready `revise_review_item(…)` call that ends this hold.
   *
   * Sent rather than left for the reader to assemble, because the two
   * surfaces take different arguments and a filer who guesses gets a
   * refusal. A hold whose wake cannot say how to lift it is the dead end
   * that kept the thread path ungated in the first place.
   */
  revise?: string;
  headline: string;
  reason: string;
  /** Present, and true, only on the loop's complaint — the filing-time wake
   *  is the ask, this one is the ask repeated after the window. */
  overdue?: true;
  heldMs?: number;
  ts: number;
}

/** What goes on the wire. Flat, because the plugin's renderer reads these
 *  fields off the top level — see `nudge-line.ts` in packages/mcp. */
/**
 * A stalled row as a frame names it, plus the board that holds it when that is
 * not the frame's own.
 *
 * Deliberately a widening of `StalledRow` rather than a new shape: the field
 * is additive inside an array entry, which an older plugin bundle ignores
 * without complaint. The frame's unknown-key guard reads the frame's OWN
 * top-level keys (`nudge-line.ts`), so a new key here reaches a seated agent
 * running last week's bundle as silence rather than as a notice it cannot act
 * on.
 */
export type AttributedRow = StalledRow & {
  /** The board that holds this row, set only when the frame carries rows from
   *  more than one. Absent means the frame's own `workspaceId`. */
  workspaceId?: string;
};

export interface StallNudgeFrame {
  event: typeof STALL_EVENT;
  /**
   * The board this frame is ABOUT — and, for every list on it but `unfiled`,
   * the board each row it names is on. `taskId`/`docId` below anchor here too.
   *
   * It is not necessarily the board the frame was delivered over: an
   * escalation forwards a board's frame to Team Lead on whichever board Team
   * Lead holds a stream (`stall-escalation.ts`, `waiting-unfiled-escalation.ts`),
   * and `escalatedFrom` is what says the receiver is a stand-in.
   */
  workspaceId: string;
  /**
   * The row to start with, when that row is a TASK — the quietest stalled
   * one, or the top unfiled row when nothing is stalled. A wake with no
   * subject costs a turn and says nothing.
   *
   * Only ever a task id. Two of the lists this anchor is picked from name a
   * DOC instead: `unanswered` always does (`UnansweredThreadRow.id` is the
   * doc's), and a held review item filed on a doc thread does too
   * (`HeldItemRow.id` falls back to `docId` when no ticket holds the item).
   * Those go in `docId` below, because a field named `taskId` that no task
   * lookup resolves is read as a broken wake — which is what two peers
   * reported it as.
   */
  taskId?: string;
  /** The anchor when it names a DOC rather than a task — see `taskId`. The
   *  two are mutually exclusive; the frame carries whichever the top finding
   *  actually is. */
  docId?: string;
  /** That row's name. Sent because the id alone makes the reader call
   *  `get_task` before they can tell whether the wake was worth the turn. */
  title?: string;
  stalledCount: number;
  /** How many open rows the pass EXAMINED. Sent even when it equals
   *  `stalledCount`, because a reader cannot tell a stated denominator from an
   *  omitted one after the fact. */
  consideredCount: number;
  /**
   * Every stalled row, uncapped.
   *
   * Uncapped on purpose: the lead's job with this frame is to drive each row,
   * and a list clipped to a preview sends them to look up the rest — which is
   * the lookup the frame exists to save. A stalled set large enough to be a
   * wall of text is itself the finding. The RENDERED line is what shortens;
   * see `nudge-line.ts`.
   *
   * **This list never spans boards.** Every row on it comes from the wake for
   * one board, so each belongs to the frame's own `workspaceId` and carries no
   * per-row board of its own — which is why the renderer is handed no frame
   * board for it and names no board on these rows. `unfiled` is the list that
   * can span boards (the fleet escalation), and it is typed `AttributedRow`
   * for exactly that reason. Widen this one and the renderer has to be given
   * the frame board here too, or it will stay silent about a row that moved
   * house.
   */
  rows?: readonly StalledRow[];
  /**
   * Rows waiting on a person with nothing filed. Absent rather than empty,
   * so a frame that carries none says so by omission.
   *
   * The ONE list on this frame that can span boards, so the one whose rows
   * carry their own `workspaceId`. The fleet escalation
   * (`waiting-unfiled-escalation.ts`) reports every board's unfiled asks in a
   * single wake on purpose — a wake is a session's whole turn — and until it
   * set this field, those rows were read under the frame's own tag. One frame
   * tagged with one board named three rows belonging to three different
   * boards, and the peer that got it could only tell which was its own
   * because it recognised the id.
   *
   * So the reading is `row.workspaceId ?? frame.workspaceId`, and a row is
   * ALWAYS attributable. Absent means "this frame's board", which is what
   * every per-board wake means and why it stays optional: a per-board frame
   * spends no bytes restating its own tag.
   */
  unfiled?: readonly AttributedRow[];
  /**
   * Rows the pass could not evaluate. Absent when there were none, which is
   * the ordinary case — its PRESENCE is the whole signal. A frame carrying
   * this with `stalledCount: 0` is the one case where the board wakes its lead
   * with no stuck work to hand over: the pass could not establish that the
   * board is healthy, which is a different message from a healthy board —
   * and that one it does not send at all.
   */
  undetermined?: { count: number; reasons: readonly string[] };
  /**
   * Runnable rows the board's parallelism cap kept out of this pass — ranked
   * past the top `cap` of the queue, so not judged. Absent when none. Sent so
   * the reader can tell "nine rows checked, two stalled" from "nine rows,
   * five judged, two stalled": the unjudged rows are idle by rule, not
   * healthy.
   */
  beyondCapacity?: number;
  /**
   * The cap that kept those rows out, with who moved it and when. Sent ONLY
   * beside `beyondCapacity`, so a wake that never mentions the cap does not
   * grow a field about it; the line names the setter in the same sentence.
   */
  parallelismCap?: ParallelismCapSummary;
  /**
   * Review items held by the quality gate past the window, oldest first.
   * Absent when there are none. A frame carrying ONLY this is a real wake:
   * a question the filer wrote and the reader cannot see is work stopped,
   * even though no row is quiet. `heldItems`, not `held`: the ready_idle
   * frame already spends `held` on its withheld-row counts, and the plugin
   * reads both frames into one payload type.
   */
  heldItems?: readonly HeldItemRow[];
  /**
   * Review items a person asked back on, unrevised past the window, oldest
   * first. Absent when none. A frame carrying only this is a real wake: the
   * reader's question is off their queue, and the filer's reply on the thread
   * does not bring it back — only `revise` does, which is why each row
   * carries that call.
   */
  askedBack?: readonly AskedBackRow[];
  /**
   * Doc threads where a PERSON asked something and no agent has answered,
   * oldest first. Absent when none. A frame carrying only this is a real
   * wake: nothing else on the board mentions it — the doc need hang on no
   * task, and `review-queue.ts` walks the other direction only — so a
   * question addressed to the team can sit for weeks with every other
   * finding here reading clean. The remedy is a reply, which each row
   * carries as a paste-ready call.
   */
  unanswered?: readonly UnansweredThreadRow[];
  /**
   * Rows built past the UI gate, each with the word that made it read as UI
   * work. Absent when none. A frame carrying only this is a real wake: the
   * row is moving, so nothing else here would ever mention it, and the whole
   * point of the gate is that somebody notices before the change ships.
   */
  ungatedUi?: readonly UngatedUiRow[];
  /**
   * Rows whose blockage lifted and whose work has not restarted, longest
   * since the lift first. Absent when none. A frame carrying only this is a
   * real wake, and it is the one finding here that reports something GOOD
   * that nobody acted on: the answer this row was waiting for is already in.
   * Every row names the lift and its timestamp, so the reader can check the
   * event rather than take the frame's word for it.
   */
  unresumed?: readonly UnresumedRow[];
  /**
   * Rows whose holder owes a check-in: somebody IS on them, and has said
   * nothing for half an hour. Absent when none. A frame carrying only this is
   * a real wake — the remedy is a message to the builder, which nothing else
   * in this frame asks for.
   */
  checkIn?: readonly StalledRow[];
  /**
   * What the named rows were DECLARED to be waiting on, for things the board
   * cannot see (`task-wait.ts`). Never a wake by itself, and a standing
   * wait's row is not on `rows`: it rides along as awareness when something
   * else woke the board (`withoutStandingWaits`). Absent when none.
   *
   * A lapsed entry is the important one: it says a declaration the lead wrote
   * has run out, which is why the row is loud again.
   */
  declaredWaits?: readonly DeclaredWaitRow[];
  /**
   * What is new since the last wake this board was sent — the reason the
   * lead is being woken again rather than the whole state of the board.
   *
   * Beside `rows` rather than instead of it. Driving every finding is the
   * frame's job, so the list stays uncapped; but a repeat that re-lists four
   * rows when one of them moved makes the reader diff two frames in their
   * head to find out why they were woken, which is the lookup this frame
   * exists to save.
   *
   * Absent on a board's FIRST wake, where everything in it is new and a
   * second copy of the same list would be noise.
   */
  changed?: {
    /** Rows named here that this board's lead has not been told about, or
     *  that came back under a different bucket. */
    rows?: readonly StalledRow[];
    /** Ids of rows the pass could not read that it could read last time. */
    undetermined?: readonly string[];
    /** Holds placed since the last wake. */
    heldItems?: readonly HeldItemRow[];
    /** Questions asked back since the last wake. */
    askedBack?: readonly AskedBackRow[];
    /** Doc threads that became unanswered news since the last wake — a
     *  question that crossed the window, or another comment from the person
     *  on one the lead had already been told about. */
    unanswered?: readonly UnansweredThreadRow[];
    /** Rows that went past the UI gate since the last wake. */
    ungatedUi?: readonly UngatedUiRow[];
    /** Rows whose blockage lifted since the last wake — a first answer, or a
     *  second one on a row the lead had already been told about. */
    unresumed?: readonly UnresumedRow[];
    /** Rows that became due for a check-in since the last wake — a first
     *  miss, or another half hour on a row that had already missed one. */
    checkIn?: readonly StalledRow[];
    /** The board's worst row crossed another repeat window. Present only when
     *  true, so its absence is "nothing got older", not "false". */
    escalated?: true;
  };
  /**
   * The lead this wake was ADDRESSED to, when it was delivered to somebody
   * else because the lead could not be reached. Absent on the ordinary wake,
   * so its presence is the whole signal: the reader is a stand-in, and the
   * board's lead seat is held by a session that is not there.
   *
   * Carried on the frame rather than left in the log, because the person who
   * needs it is the one who just got woken about a board they may not own —
   * "why am I being told this" is answerable only here.
   */
  escalatedFrom?: string;
  /**
   * Which rung of the unfiled-wait ladder this frame is — set ONLY by the
   * fleet carry (`waiting-unfiled-frame.ts`), and never by the dead-board
   * redirect above.
   *
   * The two are the only frames a lead reads about a board it is not on, and
   * until this field they looked identical on arrival. The redirect's line
   * says the board's seat is unreachable, which is true of that path alone;
   * a lead that read it off a carry frame went looking for a delivery fault
   * that was not there, six times between 20 and 22 September 2026.
   *
   * It is one field for the whole frame because the fact is one fact — every
   * row on `unfiled` has stood on its own board's unfiled list a window with
   * nothing filed — while `boards` keeps the per-board half the rows need,
   * since `unfiled` can span boards and each board's seat is a different
   * agent to tell.
   */
  unfiledCarry?: UnfiledCarry;
  ts: number;
}

/** The fleet carry's marker: the window every row has already stood unfiled,
 *  and the boards it spans with the seat each holds NOW. */
export interface UnfiledCarry {
  /**
   * The aging window. Every row on `unfiled` has been a finding on its own
   * board's list at LEAST this long (`isDue`) — "at least", because the rows
   * age on their own clocks and only their common floor is true of all of
   * them. The board item's words state the same window
   * (`waiting-unfiled-review.ts`), so the frame and the item cannot drift.
   *
   * It is the row's age, NOT a record of a delivery. Nothing here knows that
   * a particular agent read a particular wake, so neither this field nor the
   * line rendered from it claims one.
   */
  agedAtLeastMs: number;
  /**
   * Every board `unfiled` names, once each, in the order the rows arrive —
   * worst first, so the board holding the oldest wait is named first.
   *
   * `leadAgentId` is the seat as it stands at THIS tick, read off the board's
   * snapshot. A seat can have changed hands, or been empty, while the row
   * aged — so it answers "who do I send this back to", never "who was told".
   * A board with an empty seat carries no `leadAgentId` and is still named:
   * the reader has to act on the row either way.
   */
  boards: readonly { workspaceId: string; leadAgentId?: string }[];
}

export interface StallNudgerOptions {
  /** Every live board, rebuilt each tick. */
  snapshot: () => readonly StallSnapshot[];
  /** Is this agent holding a stream we could actually wake? */
  canReach: (workspaceId: string, agentId: string) => boolean;
  /**
   * Everyone else holding a stream on this board — the fallback addressees
   * when the lead cannot be woken.
   *
   * Same source as `canReach`, deliberately: an enumeration drawn from one
   * place and a predicate from another will disagree eventually, and the
   * disagreement shows up as a wake sent to a session that is not there.
   * Omitted → no escalation, which is the behaviour this option replaced.
   */
  attachedAgents?: (workspaceId: string) => readonly string[];
  /** Addressed delivery. Returns how many sinks it reached. */
  send: (workspaceId: string, agentId: string, frame: StallNudgeFrame) => number;
  /**
   * The same addressed delivery, aimed at a held item's FILER. Optional: a
   * caller that never reads held items never nudges filers. Sent once per
   * item per process — the lead's frame is the durable complaint; this one is
   * the tap on the shoulder that costs the cheaper turn.
   */
  sendToFiler?: (workspaceId: string, agentId: string, frame: ReviewItemHeldFrame) => number;
  /**
   * How old a hold must be before it is the LEAD's finding — named in the
   * stall frame, armed in the stamp, remembered as told. Younger than this
   * it is the filer's alone: the filer hears at the store's shorter window
   * (`HELD_ITEM_DEFAULT_MS`) and can end the hold in one call, and a lead
   * told in the same breath is told about something that is not yet theirs.
   * The verdict counts a hold over this same window (`heldOverMs` in
   * `keep-moving-verdict.ts`), so the lead's frame and the measurement name
   * the same items. Defaults to the quiet window a row may stand in.
   */
  leadHeldMs?: number;
  /** How long a check-in reminder about ONE task silences the next one.
   *  Defaults to `CHECK_IN_REPEAT_DEFAULT_MS`. */
  checkInRepeatMs?: number;
  repeatMs?: number;
  /**
   * A frame whose every named task moved inside this window is not sent yet
   * (`everyNamedTaskMoved`). Defaults to `STALL_MOVED_WITHIN_DEFAULT_MS`, an
   * hour; `0` turns the rule off.
   */
  movedWithinMs?: number;
  now?: () => number;
  /**
   * Where a condition the wake could not evaluate is written when there is no
   * lead to tell. Defaults to `console.error`.
   *
   * It exists because the frame is not a guaranteed reader: the commonest
   * reason a wake is not delivered is that the lead holds no stream, and that
   * is exactly when an unevaluable board would otherwise vanish. Called once
   * per distinct condition per board, never once per tick.
   */
  report?: (message: string) => void;
  /** Where the armed stamps are kept between runs. Omitted → memory only,
   *  which is what every test that is not about persistence wants. */
  stampFile?: string;
  /**
   * The addressees past the lead, run once per board per tick after the wake
   * decision: the board going past its lead when NO session on it is alive
   * (`stall-escalation.ts`). It reads nothing of this object's memory — the
   * wake and the escalation are two decisions on the same snapshot.
   *
   * It hangs here rather than on a timer of its own because a second loop
   * over every board would read the same snapshot twice a minute to answer
   * one more question about it.
   *
   * Called for every live board, including one with nothing wrong: a board
   * that recovered is exactly when a filed item has to be taken back.
   * Omitted → nothing escalates, which is the behaviour this option
   * replaced.
   */
  escalate?: (board: StallSnapshot, now: number) => void;
  /**
   * The FLEET pass, run once after every board's wake and escalation, over
   * the same snapshots they read (declared waits already taken off, as the
   * per-board readers see them). It exists for the one finding that is not
   * about a board: an unfiled wait still unfiled a window after its lead was
   * told, which is reported once for the whole server rather than once per
   * board (`waiting-unfiled-escalation.ts`).
   *
   * Omitted → nothing ages, which is the behaviour every test that is not
   * about it wants.
   */
  escalateFleet?: (boards: readonly StallSnapshot[], now: number) => void;
}

/** The stamp file's shape. Versioned so a later format change can recognise an
 *  older file rather than treating it as corrupt. `told` is additive: a file
 *  written before it existed simply has none, and `loadStamps` seeds it from
 *  the stamp so the upgrade costs no board a wake. */
interface StampFile {
  version: number;
  stamps: Record<string, string>;
  /** workspaceId → rowId → the bucket the row was last named under. */
  told?: Record<string, Record<string, string>>;
  /** workspaceId → session → the ids its last delivered frame named
   *  (`wake-sent-sets.ts`). Additive: an older file has none. */
  sent?: SentSetsJson;
  // A file written by an earlier build may also carry `toldAt` and
  // `undeliverable` maps — the escalation's old clocks. They are ignored:
  // the escalation runs on liveness now (`stall-escalation.ts`) and reads
  // nothing from this file.
}

const STAMP_FORMAT_VERSION = 1;

/**
 * The bucket recorded for a row remembered from a stamp written before this
 * memory existed. It compares equal to every bucket, so such a row is not
 * news until it leaves and stays gone — the alternative is one wake per board
 * on the first tick after this deploys, over rows their leads had been told
 * about already.
 */
const UNKNOWN_BUCKET = '?';

/**
 * How many rows a board may remember. The memory exists so a row that laps
 * its quiet window is not re-said; it must not become a list of every row
 * ever named on a long-lived board. Rows fall out by age first (a whole
 * repeat window without being a finding), and this is the backstop for a
 * board churning faster than that.
 */
const TOLD_ROWS_PER_BOARD = 200;

/** One row this board's lead has already been told about. */
interface ToldRow {
  /** The bucket it was named under. A row coming back under a DIFFERENT one
   *  is news: the lead's next move differs per bucket. */
  bucket: string;
  /** When it was last SEEN as a finding — refreshed every tick it is on the
   *  list, wake or no wake, because the question this answers is how long the
   *  row has been off the list, not how long since anyone was told. */
  seenAt: number;
}

/**
 * The row the wake opens with, and WHICH KIND OF ID that is.
 *
 * The order is the reader's: work that stopped, then a wait nobody filed,
 * then the asks sitting off somebody's queue, then a question on a doc, then
 * the gate and the check-in. That order is unchanged — what is new is that
 * each branch says what its id addresses, because two of these lists name a
 * surface that is not a task and the frame used to put all of them in a field
 * called `taskId`.
 *
 * A held item is the only list that can be either: one filed on a ticket
 * carries `taskId`, one filed on a doc thread carries `docId`, and
 * `HeldItemRow.id` is whichever of those exists. So the kind is read off the
 * row rather than off the list it came from.
 *
 * A row carrying NEITHER yields no anchor and the next list is asked instead.
 * `overdueHeldItems` drops such a row before it can get here — `id` is
 * `taskId ?? docId` and an item with neither is unaddressable — so this is
 * not a state the server produces. It is written as a fall-through rather
 * than as a default to a kind, because defaulting to a kind is the whole
 * defect this function exists to end: an id whose space nobody checked went
 * out in a field named `taskId` and was read as a broken wake.
 */
type StallAnchor = { kind: 'task' | 'doc'; id: string; title: string };

function stallAnchor(
  board: StallSnapshot,
  held: readonly HeldItemRow[],
  askedBack: readonly AskedBackRow[],
  unanswered: readonly UnansweredThreadRow[],
  ungatedUi: readonly UngatedUiRow[],
  checkIn: readonly StalledRow[],
  unresumed: readonly UnresumedRow[],
): StallAnchor | undefined {
  const task = (row?: { id: string; title: string }): StallAnchor | undefined =>
    row ? { kind: 'task', id: row.id, title: row.title } : undefined;
  const heldAnchor = (row?: HeldItemRow): StallAnchor | undefined => {
    if (!row) return undefined;
    if (row.taskId !== undefined) return { kind: 'task', id: row.taskId, title: row.title };
    if (row.docId !== undefined) return { kind: 'doc', id: row.docId, title: row.title };
    return undefined;
  };
  const docAnchor = (row?: UnansweredThreadRow): StallAnchor | undefined =>
    row ? { kind: 'doc', id: row.docId, title: row.title } : undefined;
  return (
    task(board.stalled[0]) ??
    task(board.unfiled[0]) ??
    // Above the item findings and below the two silences: a row whose answer
    // is already in is the cheapest thing on the frame for the lead to move,
    // and it is a ROW, so it anchors before the lists that name a surface
    // somebody else owns.
    task(unresumed[0]) ??
    heldAnchor(held[0]) ??
    task(askedBack[0]) ??
    docAnchor(unanswered[0]) ??
    task(ungatedUi[0]) ??
    task(checkIn[0])
  );
}

/** The distinct reasons a pass could not evaluate rows, sorted so the same
 *  condition renders the same way twice. */
function reasonsOf(undetermined: readonly StallUndeterminedRow[]): string[] {
  return Array.from(new Set(undetermined.map((u) => u.reason))).sort();
}

/** One armed stamp, read back apart. A stamp written by an older build simply
 *  parses into tokens the current one never produces, which reads as all-new
 *  and costs the board a single wake — see `stampFor`. */
function parseStamp(stamp: string): {
  bucket: number;
  ids: Set<string>;
  undetermined: Set<string>;
} {
  const [bucket = '', ids = '', undetermined = ''] = stamp.split('|');
  const parsed = Number.parseInt(bucket, 10);
  return {
    // A bucket that will not parse must not read as an escalation, so it
    // floors rather than becoming NaN — every comparison against NaN is false,
    // which would silently disable the escalation half of the rule.
    bucket: Number.isFinite(parsed) ? parsed : 0,
    ids: new Set(ids.split(',').filter((token) => token.length > 0)),
    undetermined: new Set(undetermined.split(',').filter((token) => token.length > 0)),
  };
}

/**
 * The board as the wake reads it: every STALLED row carrying a declared wait
 * that has not lapsed is taken off `stalled`, and its id handed back.
 *
 * A standing wait is not a finding. It used to be one: the row stayed on
 * `stalled`, so a board whose only quiet rows were waiting woke its lead once,
 * and every wake that fired for some OTHER reason — an unfiled ask crossing a
 * window, a lapsed wait on another row — listed the waiting rows under
 * "stopped moving" and addressed the frame to the first of them. Measured on
 * the live board, 2026-09-14: a wake every half hour for five hours naming two
 * waiting rows as the stall, while the row actually driving it sat further
 * down the frame as an unfiled ask. The lead read the waits as the cause.
 *
 * So the rows leave the finding and stay on the frame only as `declaredWaits`,
 * which rides along when something else wakes the board and never arms it.
 * Past `until` the gate marks the wait lapsed, the row is back on `stalled`
 * carrying all the silence it accumulated, and it is news on that tick.
 *
 * `unfiled` is left alone on purpose — see `clockRows` for why a sentence
 * about waiting on something else cannot excuse a question filed nowhere.
 */
function withoutStandingWaits(board: StallSnapshot): {
  board: StallSnapshot;
  waited: ReadonlySet<string>;
} {
  const standing = new Set(
    (board.declaredWaits ?? []).filter((wait) => wait.lapsed !== true).map((wait) => wait.id),
  );
  const waited = new Set(board.stalled.filter((row) => standing.has(row.id)).map((row) => row.id));
  if (waited.size === 0) return { board, waited };
  return {
    board: { ...board, stalled: board.stalled.filter((row) => !waited.has(row.id)) },
    waited,
  };
}

/**
 * One HOLD, not one item: the same review item revised, passed and held
 * again is a new hold with a new `heldAt`, and its filer is owed a fresh
 * nudge even when no tick happened to see the item pass in between.
 */
function filerKey(workspaceId: string, item: HeldItemRow): string {
  return `${workspaceId}|${item.reviewItemId}|${item.heldAt}`;
}

export class StallNudger {
  private readonly opts: StallNudgerOptions;
  private readonly now: () => number;
  private readonly repeatMs: number;
  private readonly leadHeldMs: number;
  private readonly checkInRepeatMs: number;
  private readonly movedWithinMs: number;
  /**
   * The task set each session's last delivered frame named, per board. The
   * last question asked before a frame goes out: a frame naming exactly what
   * its reader was last handed is not sent, whatever the stamp says changed.
   * Persisted beside the stamps, so a restart does not re-send a set.
   */
  private readonly sentSets: WakeSentSets;
  private readonly report: (message: string) => void;
  /** The stamp each workspace was last woken for. */
  private readonly armed = new Map<string, string>();
  /**
   * The board's escalation high-water mark, and the ROW that set it — see
   * `priorFor`. Held so a finding flickering off the list for a pass cannot
   * lower the bucket and make its own return read as an escalation; scoped to
   * the row so the hold cannot outlive it and swallow the next row's repeat.
   */
  private readonly held = new Map<string, { rowId: string; bucket: number }>();
  /**
   * Which rows each board's lead has already been told about, and when each
   * was last seen on the list.
   *
   * Separate from `armed`, and the reason this exists: the stamp is the
   * board's CURRENT set, so a row leaving it was forgotten, and the row
   * lapping its quiet window again read as a brand-new stall. On a board
   * whose owner posts a status every turn that is one wake per window
   * forever — measured 2026-09-04 as five wakes in sixty-five minutes over
   * two rows that were being actively worked, one of them with an open
   * question sitting on the reader's queue the whole time.
   *
   * Deliberately NOT cleared when a board goes wholly clean, which is where
   * the obvious version puts it: on a one-row board every wake is followed by
   * a clean board the moment the owner posts anything, and forgetting there
   * would restore the exact loop this removes.
   */
  private readonly told = new Map<string, Map<string, ToldRow>>();
  /** The unevaluable condition each workspace was last REPORTED for. Separate
   *  from `armed` because the two fire on different rules: a wake is owed once
   *  per board stamp, while the report is owed once per distinct condition
   *  however many stamps pass under it. Deliberately NOT persisted — a
   *  condition worth naming is worth naming again after a restart, and a
   *  duplicate log line is the cheapest failure in this file. */
  private readonly reported = new Map<string, string>();
  /**
   * Held items whose filer has been nudged, by `<workspaceId>|<reviewItemId>`.
   * Once per item per process, and deliberately NOT persisted: a filer's
   * nudge is the cheap turn (the filer is the party who can end it in one
   * call), and a duplicate after a deploy is worth less than the code to
   * avoid it. Pruned when the item leaves the held list.
   */
  private readonly filersTold = new Set<string>();
  /**
   * When each task last cost the lead a check-in reminder, by
   * `<workspaceId>|<taskId>`.
   *
   * Its own clock rather than the stamp, because the stamp is the board's
   * CURRENT set and a check-in is owed per task per window — a row that keeps
   * missing has to be said again, and a row that reported and went quiet
   * again has to be said afresh. Memory only: after a restart a board pays at
   * most one duplicate reminder, the same trade every other map here makes.
   */
  private readonly checkInTold = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stampFile: string | null;
  /** What the file already holds, so an unchanged map costs no write. `tick`
   *  runs once a minute forever; rewriting a byte-identical file each time
   *  would be the one part of this feature with an ongoing cost. */
  private lastPersisted = '';

  constructor(opts: StallNudgerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.repeatMs = opts.repeatMs ?? STALL_REPEAT_DEFAULT_MS;
    this.leadHeldMs = opts.leadHeldMs ?? STALL_QUIET_DEFAULT_MS;
    this.checkInRepeatMs = opts.checkInRepeatMs ?? CHECK_IN_REPEAT_DEFAULT_MS;
    this.movedWithinMs = opts.movedWithinMs ?? STALL_MOVED_WITHIN_DEFAULT_MS;
    this.sentSets = new WakeSentSets(this.repeatMs);
    this.report = opts.report ?? ((message) => console.error(message));
    this.stampFile = opts.stampFile ?? null;
    this.loadStamps();
  }

  /** One pass over every board. Never throws — this runs on a timer. */
  tick(): void {
    let boards: readonly StallSnapshot[];
    try {
      boards = this.opts.snapshot();
    } catch {
      // A snapshot can fail mid-hydrate or mid-shutdown. A wake must never
      // take the server down with it.
      return;
    }
    const now = this.now();
    const live = new Set<string>();
    // The boards as the per-board readers saw them, kept for the fleet pass
    // below: it must judge the same rows the lead was woken about, not the
    // raw snapshot with declared waits still on it.
    const read: StallSnapshot[] = [];
    for (const snapshot of boards) {
      live.add(snapshot.workspaceId);
      // Both readers below see the board with its declared waits taken off
      // `stalled` — see `withoutStandingWaits`. The snapshot itself is left
      // whole, because the keep-moving measurement reads it too.
      const { board, waited } = withoutStandingWaits(snapshot);
      this.forgetWhileWaiting(board.workspaceId, waited);
      // Every reader here sees the same `unfiled` list, because the gate no
      // longer puts a person-blocked row on it at all (2026-09-22): such a
      // row is a record on `awaitingPerson` and a finding for nobody. The
      // wake used to filter it out itself (`withoutPersonBlocked`), which
      // left the gate and the wake holding two readings of one bucket word.
      read.push(board);
      this.considerBoard(board, now);
      // After the wake, so a row told for the first time on this very tick is
      // measured from now and cannot escalate in the same pass. Isolated: a
      // filer that throws must cost its own board, never the boards behind it.
      this.escalate(board, now);
    }
    // The one finding that belongs to no board: an unfiled wait the lead was
    // told about a window ago and still nobody has filed. After every board,
    // so a task named for the first time on this tick starts its clock now
    // and cannot age in the same pass. Isolated for the same reason the
    // per-board escalation is.
    this.escalateFleet(read, now);
    // Forget boards that are gone, so neither map outlives what it describes.
    // The pruning has to reach the FILE too, or the durable copy grows for the
    // life of the install while the in-memory one stays bounded.
    for (const key of this.armed.keys()) if (!live.has(key)) this.armed.delete(key);
    for (const key of this.held.keys()) if (!live.has(key)) this.held.delete(key);
    for (const key of this.told.keys()) if (!live.has(key)) this.told.delete(key);
    for (const key of this.reported.keys()) if (!live.has(key)) this.reported.delete(key);
    for (const key of this.filersTold) {
      if (!live.has(key.slice(0, key.indexOf('|')))) this.filersTold.delete(key);
    }
    for (const key of this.checkInTold.keys()) {
      if (!live.has(key.slice(0, key.indexOf('|')))) this.checkInTold.delete(key);
    }
    this.sentSets.retain(live);
    this.saveStamps();
  }

  /** Arm the timer. Unref'd, so it can never hold a dying process open. */
  start(tickMs: number = STALL_TICK_DEFAULT_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }

  /** Idempotent: a shutdown path that already stopped must not throw. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  running(): boolean {
    return this.timer !== null;
  }

  /** How many boards are currently holding a spent wake. Test surface for the
   *  pruning above — a map that grows forever is invisible otherwise. */
  armedCount(): number {
    return this.armed.size;
  }

  /**
   * Drop a waited row from the board's memory of what the lead was told.
   *
   * This is what makes the lapse loud on the very tick it happens. A row the
   * lead heard about before its wait was declared would otherwise still be
   * remembered when a short wait ran out, and come back as an old row under
   * the same bucket — news only if the board's bucket happened to climb, which
   * another quieter row can prevent. Forgotten, it is a new finding again.
   */
  private forgetWhileWaiting(workspaceId: string, waited: ReadonlySet<string>): void {
    if (waited.size === 0) return;
    const rows = this.told.get(workspaceId);
    if (!rows) return;
    for (const id of waited) rows.delete(id);
  }

  private escalateFleet(boards: readonly StallSnapshot[], now: number): void {
    const hook = this.opts.escalateFleet;
    if (!hook) return;
    try {
      hook(boards, now);
    } catch (err) {
      console.error('[stall] fleet escalation failed:', err);
    }
  }

  private escalate(board: StallSnapshot, now: number): void {
    const hook = this.opts.escalate;
    if (!hook) return;
    try {
      hook(board, now);
    } catch (err) {
      console.error('[stall] escalation failed:', err);
    }
  }

  private considerBoard(board: StallSnapshot, now: number): void {
    const key = board.workspaceId;
    const lead = board.leadAgentId;
    const heldAll = board.retired ? [] : (board.held ?? []);
    this.pruneFilersTold(key, heldAll);
    // The filer first, before the lead's seat is even looked at: the filer
    // can end a hold in one call, their nudge is per item rather than per
    // board stamp, and a board with an empty lead seat still has filers.
    this.nudgeFilers(key, heldAll, now);
    // The lead's list is the OLDER subset. A hold the filer has only just
    // been told about is not yet a finding against the board; one that has
    // outlived the window is — the same window the verdict counts it under,
    // so nothing below this line can name a hold the measurement omits.
    const held = heldAll.filter((item) => item.heldMs > this.leadHeldMs);
    // Already the lead's subset: the wiring hands over only questions older
    // than the quiet window, and there is no filer tap to come first.
    const askedBack = board.retired ? [] : (board.askedBack ?? []);
    // Already the lead's subset too: `stall-wiring.ts` applies the day window
    // before the snapshot is built, and there is no filer to tap first —
    // whoever owes the reply is whoever the lead assigns it to.
    const unanswered = board.retired ? [] : (board.unanswered ?? []);
    // Nobody to tell. Drop the arming so a board that becomes woken again
    // starts from a clean slate rather than from a stamp recorded under
    // different conditions.
    if (board.retired || lead === undefined) {
      this.armed.delete(key);
      this.held.delete(key);
      this.sentSets.observe(key, [], now);
      // …but an unreadable row on a board with no lead is exactly the case
      // the reporter exists for, so it is named BEFORE returning.
      this.reportUnevaluable(board);
      return;
    }
    // "Nothing to say" takes all four being empty. A pass that examined nine
    // rows and could not evaluate one of them has not established that the
    // board is healthy, and returning on the stalled list alone is precisely
    // how "I could not look" comes to be delivered as "I looked and saw
    // nothing".
    // The gate's breaches count here beside the other four: a row being
    // BUILT past the UI gate is never quiet, never unfiled and never held, so
    // a check that omitted it would report the board healthy at exactly the
    // moment the rule it exists for is being broken.
    const ungatedUi = board.ungatedUi ?? [];
    // Already the lead's subset: the gate applies the quiet window to the
    // lift before the snapshot is built, and there is nobody to tap first —
    // the answer is in, and handing it back is the lead's own move.
    const unresumed = board.retired ? [] : (board.unresumed ?? []);
    // The rows owing a check-in whose window has actually come round again.
    // Filtered HERE rather than in `changeOn`, because this finding's repeat
    // is its own clock and the stamp must never see a row it is holding back.
    const checkIn = this.dueCheckIns(key, board.checkIn ?? [], now);
    // Which due window a check-in row is in, as the last telling dates it —
    // the same reading `dueCheckIns` just made, so the token a tick observes
    // and the token it names can only ever agree. Read BEFORE the frame goes,
    // because delivering it moves the row to the next window.
    const checkInWindow = (id: string): number | undefined => this.checkInTold.get(`${key}|${id}`);
    // Every token the board could name this pass, whether or not a frame goes
    // out and whether or not a check-in is due yet, so a token stays
    // remembered in the sent sets for as long as it is still a finding. A
    // check-in that has merely not come round again must not be forgotten and
    // then re-sent as if it were a new one — which is why the check-in tokens
    // here read the FULL list and not `checkIn`, and why they carry the window
    // (`checkInTokens`): this pass's window must stay remembered, and the next
    // one must not be mistaken for it.
    const boardIds = this.newsIds(board, held, askedBack, unanswered, ungatedUi, unresumed);
    this.sentSets.observe(
      key,
      [
        ...boardIds,
        ...rowBucketTokens([...board.stalled, ...board.unfiled]),
        ...checkInTokens(board.checkIn ?? [], checkInWindow),
        ...undeterminedTokens(board.undetermined),
      ],
      now,
    );
    if (
      board.stalled.length === 0 &&
      board.unfiled.length === 0 &&
      board.undetermined.length === 0 &&
      held.length === 0 &&
      askedBack.length === 0 &&
      unanswered.length === 0 &&
      ungatedUi.length === 0 &&
      unresumed.length === 0 &&
      checkIn.length === 0
    ) {
      this.armed.delete(key);
      this.held.delete(key);
      this.reported.delete(key);
      return;
    }
    // The rows whose silence may drive the board's escalation clock — see
    // `clockRows`. Computed once and threaded through both the stamp and the
    // high-water mark, because a row excluded from one and counted in the
    // other would put the clock back through the side door.
    const clock = this.clockRows(board, held, askedBack);
    const stamp = this.stampFor(boardIds, board, clock);
    // Named before both the wake decision and the reachability check below,
    // and that ordering is the point: the commonest reason a wake is not
    // delivered is a lead holding no stream, which is exactly when an
    // unevaluable board would otherwise leave no trace anywhere. It dedupes on
    // the condition itself, so a tick that says nothing costs no line.
    this.reportUnevaluable(board);
    const memory = this.rememberSeen(key, board, now);
    const change = this.changeOn(
      this.priorFor(key, memory.rows),
      stamp,
      board,
      memory.before,
      held,
      askedBack,
      unanswered,
      ungatedUi,
      unresumed,
      checkIn,
    );
    if (!change) {
      // Silent, but RECORDED. A shrink that left the old stamp standing would
      // keep naming rows that are no longer on the list, so the board's
      // escalation bucket would be read against a set it no longer has.
      this.armed.set(key, stamp);
      this.rememberHighWater(key, clock, memory.rows);
      return;
    }
    // Checked LAST, and deliberately not recorded when it says no: a wake that
    // reached nobody must stay owed, or the lead returns to a board that has
    // already decided it told them.
    const to = this.addressee(key, lead);
    // The wake stays owed — nothing is recorded in `told`. Whether the board
    // has ANYBODY on it is the escalation's question, and it answers it from
    // the store's liveness reads rather than from a failed delivery here.
    if (to === undefined) return;
    const anchor = stallAnchor(board, held, askedBack, unanswered, ungatedUi, checkIn, unresumed);
    const frame: StallNudgeFrame = {
      event: STALL_EVENT,
      workspaceId: key,
      ...(anchor
        ? {
            ...(anchor.kind === 'task' ? { taskId: anchor.id } : { docId: anchor.id }),
            title: anchor.title,
          }
        : {}),
      stalledCount: board.stalled.length,
      consideredCount: board.considered,
      ...(board.stalled.length > 0 ? { rows: board.stalled } : {}),
      ...(board.unfiled.length > 0 ? { unfiled: board.unfiled } : {}),
      ...(board.beyondCapacity !== undefined && board.beyondCapacity > 0
        ? {
            beyondCapacity: board.beyondCapacity,
            ...(board.parallelismCap ? { parallelismCap: board.parallelismCap } : {}),
          }
        : {}),
      // `heldItems`, not `held`: the ready_idle frame already spends `held` on
      // its withheld-row counts, and the plugin reads both frames into one type.
      ...(held.length > 0 ? { heldItems: held } : {}),
      ...(askedBack.length > 0 ? { askedBack } : {}),
      ...(unanswered.length > 0 ? { unanswered } : {}),
      ...(ungatedUi.length > 0 ? { ungatedUi } : {}),
      ...(unresumed.length > 0 ? { unresumed } : {}),
      ...(checkIn.length > 0 ? { checkIn } : {}),
      // Awareness only. Never a reason for the frame — `changeOn` above has
      // already decided that on the findings themselves. A standing wait's
      // row is off `stalled` (`withoutStandingWaits`) and off nothing else,
      // so it can still be on `unresumed`: a wait declared BEFORE the lift it
      // sits over answers nothing, and the gate names the row (`stall-gate.ts`).
      ...(board.declaredWaits && board.declaredWaits.length > 0
        ? { declaredWaits: board.declaredWaits }
        : {}),
      ...(board.undetermined.length > 0
        ? {
            undetermined: {
              count: board.undetermined.length,
              reasons: reasonsOf(board.undetermined),
            },
          }
        : {}),
      // Omitted on a board this process has never woken: there everything is
      // new, and a second copy of the same list says nothing.
      ...(memory.firstWake ? {} : { changed: change }),
      ...(to.escalatedFrom !== undefined ? { escalatedFrom: to.escalatedFrom } : {}),
      ts: now,
    };
    // Every task it names moved inside the hour: not yet, and nothing is
    // recorded — the wake stays owed, so the tick a named task crosses the
    // window sends it with everything the stamp saw change since.
    if (everyNamedTaskMoved(frame, this.movedWithinMs)) return;
    // What this frame names — the stamp's own tokens, so a second hold, a new
    // question and a person's new comment all read as different findings,
    // WITHOUT the escalation bucket the stamp carries in front of them. That
    // omission is the rule: a board whose oldest row merely crossed another
    // repeat window is naming exactly what it named last time.
    const named = [
      ...boardIds,
      ...rowBucketTokens([...board.stalled, ...board.unfiled]),
      ...checkInTokens(checkIn, checkInWindow),
      ...undeterminedTokens(board.undetermined),
    ];
    // The same findings this session was last handed: silent, but RECORDED the
    // way a board with no change is, so the escalation bucket is read against
    // the set the board actually has. A set that gained or lost one is not a
    // repeat, and nor is one whose tokens were forgotten after a whole repeat
    // window off the findings (`wake-sent-sets.ts`).
    if (this.sentSets.nothingNew(key, to.agentId, named)) {
      this.armed.set(key, stamp);
      this.rememberHighWater(key, clock, memory.rows);
      return;
    }
    const delivered = this.emit(key, to.agentId, frame);
    // Nothing below is recorded for a wake nobody took: the stamp, the told
    // rows and the check-in clocks all assert that the lead has heard.
    if (!delivered) return;
    this.armed.set(key, stamp);
    this.sentSets.record(key, to.agentId, named, now);
    // Recorded only now, after a delivered wake — a row named while the lead
    // held no stream must stay news, or the lead comes back to a board that
    // has decided it told them.
    for (const row of [...board.stalled, ...board.unfiled]) {
      memory.rows.set(row.id, { bucket: row.bucket, seenAt: now });
    }
    // A held item's TICKET counts as told, under no bucket in particular:
    // the lead has been handed that ticket, so the same ticket later going
    // quiet or reading as unfiled over the same held ask is not a second
    // wake. That was the stamp's job when held ids lived in it beside the
    // row ids; it is this memory's now, and it must not be dropped in the
    // move.
    // An asked-back item's ticket likewise: its later silence is the same
    // unrevised question the lead was just told about.
    // A waiting doc thread enters under its DOC's id, which is never a row
    // id, so it suppresses nothing. It is here for the other half of this
    // memory's job: `firstWake` is read off it, and a board whose only
    // findings are waiting questions would otherwise read as never having
    // been woken and send no `changed` block ever — the second wake would
    // re-list the whole set with nothing saying why.
    for (const item of [...held, ...askedBack, ...unanswered]) {
      if (!memory.rows.has(item.id))
        memory.rows.set(item.id, { bucket: UNKNOWN_BUCKET, seenAt: now });
    }
    this.rememberHighWater(key, clock, memory.rows);
    // Recorded only on a DELIVERED wake, like every other memory here: a
    // reminder nobody received must stay owed.
    for (const row of checkIn) this.checkInTold.set(`${key}|${row.id}`, now);
    this.capTold(memory.rows);
  }

  /**
   * The check-in rows this board may actually spend a reminder on: those
   * never said, or said longer ago than the repeat window.
   *
   * The filter is what bounds the cost. Without it a row that stays quiet
   * would be named on every tick for as long as it stays quiet, which is the
   * once-a-minute wake the whole file is built to refuse.
   */
  private dueCheckIns(
    workspaceId: string,
    rows: readonly StalledRow[],
    now: number,
  ): readonly StalledRow[] {
    const due = rows.filter((row) => {
      const told = this.checkInTold.get(`${workspaceId}|${row.id}`);
      return told === undefined || now - told >= this.checkInRepeatMs;
    });
    // A row that has reported since must not keep a stale told-time that
    // would swallow its NEXT miss inside the window.
    const live = new Set(rows.map((row) => row.id));
    const prefix = `${workspaceId}|`;
    for (const key of this.checkInTold.keys()) {
      if (key.startsWith(prefix) && !live.has(key.slice(prefix.length)))
        this.checkInTold.delete(key);
    }
    return due;
  }

  /**
   * The armed stamp, with the board's escalation bucket held UP while the row
   * that earned it is still remembered.
   *
   * The bucket is read off the findings a tick can see, and every tick re-arms
   * the board with it — so a remembered row that drops off the list for a
   * single pass took the bucket down with it, and the tick that saw the row
   * again read `after.bucket > before.bucket` as another repeat window
   * crossed. A wake naming a row the lead was already told about, repeatable
   * as often as the row flickers: two wakes three minutes apart in prod over
   * one row quiet for twelve hours.
   *
   * The flicker is not the row moving. A row on the parallelism cap's
   * boundary leaves the judged set whenever another row starts or stops
   * being runnable (`stall-gate.ts`). (An escalation item used to mask its
   * own anchor row the same way; the wiring now skips the board's own items
   * when it reads a row's asks, so that source of flicker is gone.)
   *
   * ── Why the hold is SCOPED to one row ───────────────────────────────────
   *
   * A hold that only ever dropped on a wholly clean board would be a ratchet:
   * on a board that always has at least one finding the high-water mark would
   * stand forever, and every later row's escalation would be swallowed until
   * it passed a number some other row set hours ago — which is the repeat
   * window, the thing that says a bad board again, silently switched off
   * (found in review of this fix). So the hold is remembered WITH the row it
   * came from and lasts exactly as long as that row does: `told` forgets a row
   * that has been off the list for a whole repeat window, and the hold goes
   * with it. The next row escalates on its own clock.
   *
   * Memory only, never persisted: after a restart a board falls back to the
   * stamp on disk and pays at most the one wake this file has always been
   * willing to pay for a lost stamp.
   */
  private priorFor(key: string, told: Map<string, ToldRow>): string | undefined {
    const prior = this.armed.get(key);
    if (prior === undefined) return undefined;
    const held = this.held.get(key);
    if (held === undefined || !told.has(held.rowId)) return prior;
    const parsed = parseStamp(prior);
    if (held.bucket <= parsed.bucket) return prior;
    return `${held.bucket}${prior.slice(prior.indexOf('|'))}`;
  }

  /**
   * The rows whose silence may drive the board's escalation clock.
   *
   * The clock is the one thing in this file that may re-say a finding the lead
   * has already been told about: the board's bucket is the oldest quiet row's
   * silence divided by the repeat window, and every window it crosses arms
   * another wake. That is what makes a board the lead is ignoring get louder,
   * and it stays (the owner's number, 2026-09-11: "report again in half an
   * hour if still stalled").
   *
   * But it is a CLOCK, and a clock re-says a row whether or not anything about
   * it is different. For a row the lead can act on that is the point. For a row
   * whose silence the snapshot has already EXPLAINED — a wait somebody else
   * owns — the repeat is the same sentence with a bigger number on it, and it
   * arrives beside the finding that actually names the wait, so the lead is
   * woken to re-read something they cannot move. Measured before this filter:
   * a board whose only quiet row was a ticket with a held review item woke its
   * lead every repeat window forever, each frame carrying
   * `changed: { escalated: true }` and nothing else.
   *
   * So three kinds of row are taken out of the clock, and the same three are
   * still NAMED — none of this hides anything:
   *
   *  - a ticket carrying a **held** review item. The filer revises it; the
   *    lead's frame names it under `heldItems`, armed on `held:<item>@<heldAt>`.
   *  - a ticket carrying a question a reader **asked back**. Same shape,
   *    armed on `ask:<item>@<askedAt>`.
   *  - a row on the **`waiting`** list: an ask filed and pending on somebody's
   *    Home queue. Disjoint from the named lists today (`stall-gate.ts` sorts
   *    a row into exactly one), and listed here anyway so a later classifier
   *    change cannot quietly put the clock back.
   *
   * A stalled row carrying a DECLARED wait never reaches this method: it is
   * not a finding at all while the wait stands (`withoutStandingWaits`), so
   * it is neither named nor on the clock. Past `until` it is back on
   * `stalled` carrying its whole accumulated silence, so the escalation is
   * deferred rather than cancelled, and the frame says the declaration lapsed.
   *
   * ── Why a declared wait does NOT quieten an unfiled row ─────────────────
   *
   * `unfiled` is a row waiting on a PERSON with the question filed nowhere
   * they read. Its remedy is the lead's and available right now — file the
   * ask — so a sentence about waiting on something else cannot excuse it,
   * and letting it would make the one finding that catches a protocol
   * violation the easiest of all to silence. `withoutStandingWaits`
   * therefore takes waited rows off `stalled` and nothing wider.
   *
   * ── What counts as the SAME wait ────────────────────────────────────────
   *
   * The identity is the token the stamp already writes, and nothing new is
   * remembered for it. A new hold, a re-hold after a revision, or a second
   * question mints a different `@<timestamp>`, so the wake fires at once
   * rather than waiting out a window. An answer arriving, or the hold lifting,
   * takes the ticket off these lists — its silence is nobody else's any more,
   * it re-enters the clock, and the ordinary half-hourly escalation resumes.
   * The memory therefore survives a restart exactly as far as the stamp file
   * does, and a lost stamp costs the one duplicate wake this file has always
   * been willing to pay.
   *
   * Rows past the parallelism cap need no mention here: `stall-gate.ts` does
   * not judge them at all, so they reach neither list, and `beyondCapacity` is
   * a count on the frame that never enters the stamp.
   */
  private clockRows(
    board: StallSnapshot,
    held: readonly HeldItemRow[],
    askedBack: readonly AskedBackRow[],
  ): readonly StalledRow[] {
    const rows = [...board.stalled, ...board.unfiled];
    const waits = new Set<string>([
      ...held.map((item) => item.id),
      ...askedBack.map((item) => item.id),
      ...(board.waiting ?? []).map((row) => row.id),
    ]);
    if (waits.size === 0) return rows;
    return rows.filter((row) => !waits.has(row.id));
  }

  /**
   * Record which row is speaking for the board's bucket, so the hold above can
   * expire with it. Keeps the standing hold while the row that set it is still
   * remembered and still the worse fact; otherwise the board's current oldest
   * row takes over.
   */
  private rememberHighWater(
    key: string,
    rows: readonly StalledRow[],
    told: Map<string, ToldRow>,
  ): void {
    let oldest = rows[0];
    for (const row of rows) if (row.quietMs > (oldest?.quietMs ?? -1)) oldest = row;
    if (oldest === undefined) {
      this.held.delete(key);
      return;
    }
    const bucket = Math.floor(oldest.quietMs / this.repeatMs);
    const held = this.held.get(key);
    if (held !== undefined && held.bucket > bucket && told.has(held.rowId)) return;
    this.held.set(key, { rowId: oldest.id, bucket });
  }

  /**
   * Refresh how recently each finding row was SEEN, drop rows that have been
   * off the list for a whole repeat window, and hand back what the board
   * remembered BEFORE this tick — which is what the news is measured against.
   *
   * The age is measured from last seen rather than from last told on purpose:
   * a row that sits on the list untouched would otherwise be forgotten one
   * repeat window after its wake and re-fire, which is a repeat keyed on the
   * clock — the shape this whole file refuses. Escalation is the only clock
   * that may re-say a row, and it is the board's, not the row's.
   */
  private rememberSeen(
    key: string,
    board: StallSnapshot,
    now: number,
  ): { rows: Map<string, ToldRow>; before: Map<string, ToldRow>; firstWake: boolean } {
    let rows = this.told.get(key);
    if (!rows) {
      rows = new Map<string, ToldRow>();
      this.told.set(key, rows);
    }
    // Refresh BEFORE pruning, and the order is the whole point: pruning first
    // would drop a row that is a finding on this very tick the moment its
    // window elapsed, and the next tick would then read it as brand new. That
    // is a repeat keyed on the clock — one wake per row per window, which is
    // the amortisation `stampFor` refuses on the escalation bucket for exactly
    // the same reason.
    for (const id of [
      ...board.stalled.map((r) => r.id),
      ...board.unfiled.map((r) => r.id),
      ...(board.held ?? []).map((r) => r.id),
      ...(board.askedBack ?? []).map((r) => r.id),
      ...(board.unanswered ?? []).map((r) => r.id),
    ]) {
      const seen = rows.get(id);
      if (seen) seen.seenAt = now;
    }
    for (const [id, seen] of rows) {
      if (now - seen.seenAt > this.repeatMs) rows.delete(id);
    }
    // Snapshot AFTER both, so what the news is measured against is what the
    // board still remembers rather than what it remembered a moment ago.
    const before = new Map(rows);
    return { rows, before, firstWake: before.size === 0 };
  }

  /** Keep the newest `TOLD_ROWS_PER_BOARD` — see the constant. */
  private capTold(rows: Map<string, ToldRow>): void {
    if (rows.size <= TOLD_ROWS_PER_BOARD) return;
    const oldestFirst = [...rows.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (const [id] of oldestFirst.slice(0, rows.size - TOLD_ROWS_PER_BOARD)) rows.delete(id);
  }

  /**
   * Who actually gets this wake.
   *
   * The lead when the lead is there. Otherwise ANY attached session, because
   * the alternative — the current behaviour — is a monitor whose whole output
   * is addressed to one identity it cannot verify: a board whose lead seat is
   * held by a session that has stopped listening goes quiet, and the silence
   * is indistinguishable from a healthy board. That is the shape of the
   * failure this exists to end.
   *
   * The lead is still tried FIRST and the ordinary frame is unchanged, so a
   * healthy board keeps waking exactly the session it always woke.
   *
   * Sorted, and the lead excluded: the stand-in must be the same session on
   * every tick, or a board with three attached agents wakes a different one
   * each time and none of them can tell that the others were told.
   */
  private addressee(
    workspaceId: string,
    lead: string,
  ): { agentId: string; escalatedFrom?: string } | undefined {
    if (this.reachable(workspaceId, lead)) return { agentId: lead };
    let attached: readonly string[] = [];
    try {
      attached = this.opts.attachedAgents?.(workspaceId) ?? [];
    } catch {
      attached = [];
    }
    const standIn = attached
      .filter((id) => id !== lead && this.reachable(workspaceId, id))
      .slice()
      .sort()[0];
    if (standIn === undefined) return undefined;
    return { agentId: standIn, escalatedFrom: lead };
  }

  /**
   * Say — once per distinct condition — that this board holds rows the gate
   * could not read.
   *
   * Once per CONDITION rather than once per tick, and not persisted across a
   * restart. Both choices point the same way: a line nobody can act on twice
   * is worse than no line, and a condition that outlives a deploy is worth
   * stating again to whoever is watching now.
   */
  private reportUnevaluable(board: StallSnapshot): void {
    if (board.undetermined.length === 0) {
      this.reported.delete(board.workspaceId);
      return;
    }
    const condition = board.undetermined
      .map((u) => `${u.id}:${u.reason}`)
      .slice()
      .sort()
      .join(',');
    if (this.reported.get(board.workspaceId) === condition) return;
    this.reported.set(board.workspaceId, condition);
    try {
      this.report(
        `[stall] ${board.workspaceId}: ${board.undetermined.length} of ${board.considered} ` +
          `row(s) could not be evaluated and were NOT counted healthy — ${condition}`,
      );
    } catch {
      // A reporter that throws must not take the pass down with it. The whole
      // point of this method is that a board is not left unmentioned; losing
      // the mention is bad, losing every other board's wake is worse.
    }
  }

  /**
   * Every token a frame would name, deduped and sorted. The stamp is built
   * from these and so is the per-session sent set (`wake-sent-sets.ts`), and
   * they must be the same tokens: the stamp decides whether the BOARD got
   * worse, the sent set whether this READER has already been handed exactly
   * this, and a reader handed a token the stamp never saw would be woken by a
   * finding nothing is arming.
   */
  private newsIds(
    board: StallSnapshot,
    held: readonly HeldItemRow[],
    askedBack: readonly AskedBackRow[],
    unanswered: readonly UnansweredThreadRow[],
    ungatedUi: readonly UngatedUiRow[],
    unresumed: readonly UnresumedRow[],
  ): string[] {
    const rows = [...board.stalled, ...board.unfiled];
    // Ids alone, without the bucket they used to carry. A row changing bucket
    // is most often the lead's OWN action landing — dispatching a worker moves
    // a row from `ready-unpicked` to `in-progress` — and a token that changed
    // would read as a new row under the growth rule below, waking the lead to
    // announce what it just did. The frame still carries every row's bucket;
    // it is the ARMING that must not turn on it.
    // A held item enters the stamp twice: under its TICKET's id, deduped
    // with the stalled and unfiled rows — so the same ticket later going
    // quiet or reading as unfiled over the same held ask is not a second
    // wake; the lead was already told to get that item revised — and under
    // its OWN id and hold time, so a second item held on a ticket the lead
    // already heard about is news, and so is the same item held AGAIN after
    // a revision (codex review: ticket-only stamping swallowed the first;
    // an id-only key needed a tick to see the gap between two holds). It
    // stays OUT of the escalation bucket below: a hold is the filer's to
    // end, and re-saying it every repeat window would bill the lead for
    // the filer's silence. Only the lead's subset of the holds is armed —
    // `considerBoard` passes the ones past `leadHeldMs` — so a hold that is
    // still the filer's alone does not arm the board either.
    const ids = Array.from(
      new Set([
        ...rows.map((row) => row.id),
        ...held.map((row) => row.id),
        ...held.map((row) => `held:${row.reviewItemId}@${row.heldAt}`),
        // The same two keys as a hold, for the same reasons: the ticket, and
        // this question on this item — so a new question is news.
        ...askedBack.map((row) => row.id),
        ...askedBack.map((row) => `ask:${row.reviewItemId}@${row.askedAt}`),
        // The THREAD and its newest comment, and neither half is spare. The
        // thread alone would say nothing when the person came back and added
        // a third comment to a conversation the lead had already been told
        // about — which is the same silence this whole finding exists to end.
        // `latestAt` rather than `askedAt`, because `askedAt` is the run's
        // start and does not move when they speak again. The DOC's id stays
        // out: a doc is not a row, so folding it in would let one waiting
        // thread stand in for another on the same document.
        ...unanswered.map((row) => `unanswered:${row.threadId}@${row.latestAt}`),
        // Under its OWN key, not the row id: a row can be stalled AND built
        // past the gate, and folding the two together would let a wake about
        // the silence stand in for the one about the rule.
        ...ungatedUi.map((row) => `ui:${row.id}`),
        // Under its own key AND its LIFT's time, for the two reasons a hold
        // carries both: a row can be stalled and unresumed at once, so
        // folding it into the row id would let a wake about the silence stand
        // in for the one about the answer; and a SECOND answer on the same
        // row is a second thing nobody acted on, which an id-only token would
        // swallow.
        ...unresumed.map((row) => `lift:${row.id}@${row.liftedAt}`),
      ]),
    ).sort();
    return ids;
  }

  /**
   * Which rows are stuck, what kind of stuck, and how many repeat windows deep
   * THE BOARD is. One string, so a new stall, a recovery, a row changing
   * bucket and the board escalating all arm the wake through the same door.
   *
   * The quiet time is QUANTISED rather than carried exactly, and that is the
   * whole escalation design: a raw duration changes on every tick and would
   * make the stamp a clock, waking the lead every minute over a row they have
   * already seen.
   *
   * ── Why the window is the board's and not each row's ──────────────────
   *
   * It was per-row first, and that amortises catastrophically. Every stalled
   * row crosses its own boundary at its own wall-clock moment, each crossing
   * moves the stamp, and the ceiling becomes one wake per row per window
   * rather than one per board. On the boards this shipped against — 32
   * eligible rows on one, 24 on another — that is seven or eight wakes an hour
   * forever, with nothing about the board having changed. The frugality rules
   * at the top of this file were doing their job on the SET and being
   * completely defeated on the clock.
   *
   * So the bucket is computed once, from the OLDEST row: one re-wake per board
   * per window. Escalation survives intact — the board still gets louder the
   * longer its worst row sits — and the row ids stay in the stamp, so a
   * genuinely new stall still fires immediately rather than waiting out
   * somebody else's window.
   */
  private stampFor(
    ids: readonly string[],
    board: StallSnapshot,
    clock: readonly StalledRow[],
  ): string {
    // The oldest row speaks for the board — of the rows the clock may speak
    // for at all (`clockRows`). `0` on a board whose only finding is
    // unreadable rows, which is right: there is no silence to escalate. `0`
    // too on a board whose every quiet row is waiting on somebody else, which
    // is the same statement: the board said it once and has nothing to add.
    const oldestQuietMs = clock.reduce((max, row) => Math.max(max, row.quietMs), 0);
    const bucket = Math.floor(oldestQuietMs / this.repeatMs);
    const undetermined = board.undetermined
      .map((u) => `${u.id}:${u.reason}`)
      .slice()
      .sort();
    // Still appended only when non-empty, so a board with nothing unreadable —
    // which is almost all of them — keeps computing a stable string from one
    // process to the next. (Dropping the per-row bucket is a format change, so
    // every stored stamp reads as all-new on the first tick after this deploys
    // and each board is billed one extra wake — the same one-time cost the
    // move of the escalation bucket to the front paid, against a standing one.)
    return undetermined.length > 0
      ? `${bucket}|${ids.join(',')}|${undetermined.join(',')}`
      : `${bucket}|${ids.join(',')}`;
  }

  /**
   * Is the new stamp WORSE than the armed one? The only question that may
   * spend a lead's turn.
   *
   * The rule used to be equality — any different stamp re-armed the wake — and
   * that made the loop self-sustaining rather than self-extinguishing. A
   * shrinking set moves the stamp exactly as a growing one does, so the lead
   * was woken to file an ask, filed it, the row left the unfiled list, and the
   * next tick woke the lead again over its own remedy. Six wakes in one
   * evening on a live board, `stalled=0` in all six, the unfiled count walking
   * 1→2→3→2→1.
   *
   * So three things, and only these three, are news:
   *
   *  - a row id on the list that was not on it before — a NEW thing stuck;
   *  - the board's escalation bucket higher than it was — its worst row has
   *    crossed another repeat window;
   *  - a row the pass could not read that it could read before.
   *
   * Everything else is a board getting better, and a recovery is never
   * announced: rows leaving lowers the count, and rows leaving also lowers the
   * oldest quiet time, which is why the bucket is compared for GREATER rather
   * than for difference.
   *
   * An absent stamp is a board this process has never woken, which is news by
   * definition.
   *
   * ── What "a NEW thing stuck" means, and why it is not the stamp ────────
   *
   * It used to be a row id absent from the previous stamp, and the previous
   * stamp is the board's CURRENT set — so a row that left the list was
   * forgotten and its next quiet window read as a brand-new stall. See
   * `told`: that is one wake per window, forever, on any board whose owner
   * keeps reporting. A row is news now when the board has never been woken
   * about it, or when it comes back under a different BUCKET — which is the
   * case the id-only rule was protecting, a dispatched row whose builder then
   * died coming back as `builder-silent` rather than as the same row.
   *
   * The bucket is compared out here rather than being folded back into the
   * stamp, and that distinction is load-bearing: a row changing bucket while
   * it stays on the list is most often the lead's OWN action landing, and a
   * stamp token that moved would wake them to announce it.
   *
   * Returns what changed, or `undefined` for "say nothing" — one value, so
   * the decision to wake and the account of why cannot disagree.
   */
  private changeOn(
    prior: string | undefined,
    next: string,
    board: StallSnapshot,
    told: Map<string, ToldRow>,
    held: readonly HeldItemRow[],
    askedBack: readonly AskedBackRow[],
    unanswered: readonly UnansweredThreadRow[],
    ungatedUi: readonly UngatedUiRow[],
    unresumed: readonly UnresumedRow[],
    checkIn: readonly StalledRow[],
  ): StallNudgeFrame['changed'] | undefined {
    const before = prior === undefined ? undefined : parseStamp(prior);
    const after = parseStamp(next);
    const escalated = before !== undefined && after.bucket > before.bucket;
    const rows = [...board.stalled, ...board.unfiled].filter((row) => {
      const seen = told.get(row.id);
      if (seen === undefined) return true;
      // A row remembered from a stamp written before this memory existed
      // carries no bucket to compare — see UNKNOWN_BUCKET.
      return seen.bucket !== UNKNOWN_BUCKET && seen.bucket !== row.bucket;
    });
    // The token is only ever the LOOKUP; the id comes off the row it came
    // from. Building the token and then cutting the reason back off it made
    // the id depend on neither reason nor id containing the separator, which
    // is a promise about two unrelated vocabularies rather than a fact.
    const undetermined = board.undetermined
      .filter((u) => before === undefined || !before.undetermined.has(`${u.id}:${u.reason}`))
      .map((u) => u.id);
    const heldItems = held.filter(
      (item) => before === undefined || !before.ids.has(`held:${item.reviewItemId}@${item.heldAt}`),
    );
    const asked = askedBack.filter(
      (item) => before === undefined || !before.ids.has(`ask:${item.reviewItemId}@${item.askedAt}`),
    );
    const waiting = unanswered.filter(
      (row) =>
        before === undefined || !before.ids.has(`unanswered:${row.threadId}@${row.latestAt}`),
    );
    // Keyed on the token the stamp writes, so a row already reported stays
    // silent while the same row reported again after a wake it was absent
    // from is news — the same rule every other finding here follows.
    const ungated = ungatedUi.filter(
      (row) => before === undefined || !before.ids.has(`ui:${row.id}`),
    );
    // Keyed on the same token the stamp writes, so the lead hears about each
    // lift once and about a second one on the same row afresh.
    const lifted = unresumed.filter(
      (row) => before === undefined || !before.ids.has(`lift:${row.id}@${row.liftedAt}`),
    );
    // Already filtered to the rows whose window has come round (`dueCheckIns`)
    // — so every row still here is news by its own clock, and it does not ride
    // the stamp. That is the one departure from the stamp rule in this method,
    // and it is deliberate: a missed check-in repeats per task per window.
    // Since 2026-09-17 the sent sets have a say as well, and this is the one
    // finding whose token had to carry a WINDOW rather than a row to survive
    // them (`checkInTokens`) — a bare row id sits on the board between windows
    // and would make the second ask a repeat of the first.
    if (
      !escalated &&
      rows.length === 0 &&
      undetermined.length === 0 &&
      heldItems.length === 0 &&
      asked.length === 0 &&
      waiting.length === 0 &&
      ungated.length === 0 &&
      lifted.length === 0 &&
      checkIn.length === 0
    )
      return undefined;
    return {
      ...(rows.length > 0 ? { rows } : {}),
      ...(undetermined.length > 0 ? { undetermined } : {}),
      ...(heldItems.length > 0 ? { heldItems } : {}),
      ...(asked.length > 0 ? { askedBack: asked } : {}),
      ...(waiting.length > 0 ? { unanswered: waiting } : {}),
      ...(ungated.length > 0 ? { ungatedUi: ungated } : {}),
      ...(lifted.length > 0 ? { unresumed: lifted } : {}),
      ...(checkIn.length > 0 ? { checkIn } : {}),
      ...(escalated ? { escalated: true as const } : {}),
    };
  }

  /**
   * Tell each overdue item's filer, once per item, that the hold has stood
   * past the window. Silent — and NOT recorded — when the filer holds no
   * stream: a nudge delivered to nobody would spend the one this item is
   * owed, and the filer would return to an item the loop had decided it told
   * them about. An item with no known filer is left to the lead's frame.
   */
  private nudgeFilers(workspaceId: string, held: readonly HeldItemRow[], now: number): void {
    const send = this.opts.sendToFiler;
    if (!send) return;
    for (const item of held) {
      if (item.filerAgentId === undefined) continue;
      const key = filerKey(workspaceId, item);
      if (this.filersTold.has(key)) continue;
      if (!this.reachable(workspaceId, item.filerAgentId)) continue;
      let delivered = 0;
      try {
        delivered = send(workspaceId, item.filerAgentId, {
          event: REVIEW_ITEM_HELD_EVENT,
          workspaceId,
          // The ROW's own address, not `item.id` alone: on a doc thread `id`
          // is the DOC, and a filer handed a docId under the name `taskId`
          // would spend a call finding out it is not one. A row with no doc
          // address is a ticket row by construction (`overdueHeldItems`), so
          // there `id` IS the ticket — and reading it that way keeps every
          // caller that predates the doc surface sending what it always did.
          ...(item.docId === undefined
            ? { taskId: item.taskId ?? item.id }
            : item.taskId !== undefined
              ? { taskId: item.taskId }
              : {}),
          ...(item.docId !== undefined ? { docId: item.docId } : {}),
          ...(item.threadId !== undefined ? { threadId: item.threadId } : {}),
          ...(item.commentId !== undefined ? { commentId: item.commentId } : {}),
          ...(item.revise !== undefined ? { revise: item.revise } : {}),
          title: item.title,
          reviewItemId: item.reviewItemId,
          headline: item.headline,
          reason: item.reason,
          overdue: true,
          heldMs: item.heldMs,
          ts: now,
        });
      } catch (err) {
        console.error('[stall] filer nudge failed:', err);
        continue;
      }
      // Told means DELIVERED. A filer that dropped between `reachable` and
      // the send got nothing, and marking the item told would silence every
      // later pass for a nudge nobody heard (codex review).
      if (delivered > 0) this.filersTold.add(key);
    }
  }

  /** Forget filers told about items no longer held, so a fresh hold on the
   *  same item (revised, judged, held again) is nudged afresh. */
  private pruneFilersTold(workspaceId: string, held: readonly HeldItemRow[]): void {
    const live = new Set(held.map((item) => filerKey(workspaceId, item)));
    const prefix = `${workspaceId}|`;
    for (const key of this.filersTold) {
      if (key.startsWith(prefix) && !live.has(key)) this.filersTold.delete(key);
    }
  }

  private reachable(workspaceId: string, agentId: string): boolean {
    try {
      return this.opts.canReach(workspaceId, agentId);
    } catch {
      return false;
    }
  }

  /**
   * Read the stamps a previous run left. A file that cannot be read starts
   * this run empty — never throws, and deliberately does NOT move the file
   * aside: a lost stamp is one extra wake that the next tick re-arms on its
   * own, which is not a loss worth a recovery path.
   */
  private loadStamps(): void {
    if (!this.stampFile || !existsSync(this.stampFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.stampFile, 'utf8')) as Partial<StampFile>;
      if (!parsed || typeof parsed.stamps !== 'object' || parsed.stamps === null) return;
      for (const [workspaceId, stamp] of Object.entries(parsed.stamps)) {
        // Row-level tolerance, matching the store next door: one hand-edited
        // entry must not cost every other board its arming.
        if (typeof stamp === 'string') this.armed.set(workspaceId, stamp);
      }
      // The rows each board has been told about. Seen-times are NOT stored —
      // every remembered row is given a fresh window at boot, so a restart can
      // extend a row's memory but never cut it short. That keeps the file
      // byte-stable between ticks, which is what lets `saveStamps` write only
      // when something actually changed rather than once a minute forever.
      const now = this.now();
      const told = parsed.told;
      if (told && typeof told === 'object') {
        for (const [workspaceId, rows] of Object.entries(told)) {
          if (!rows || typeof rows !== 'object') continue;
          const map = new Map<string, ToldRow>();
          for (const [id, bucket] of Object.entries(rows)) {
            if (typeof bucket !== 'string') continue;
            map.set(id, { bucket, seenAt: now });
          }
          if (map.size > 0) this.told.set(workspaceId, map);
        }
      }
      // A file written before this memory existed: seed it from the stamp, so
      // the upgrade costs no board the one wake it would otherwise re-fire
      // over rows their leads had already been told about.
      for (const [workspaceId, stamp] of this.armed) {
        if (this.told.has(workspaceId)) continue;
        const map = new Map<string, ToldRow>();
        for (const id of parseStamp(stamp).ids)
          map.set(id, { bucket: UNKNOWN_BUCKET, seenAt: now });
        if (map.size > 0) this.told.set(workspaceId, map);
      }
      this.sentSets.load(parsed.sent, now);
      this.lastPersisted = this.serializeStamps();
    } catch {
      this.armed.clear();
    }
  }

  private serializeStamps(): string {
    // Key order is the map's insertion order, which differs between a fresh
    // load and a run that has re-armed boards — sorted, so the content compare
    // below answers "did anything change" rather than "did anything move".
    const stamps: Record<string, string> = {};
    for (const key of Array.from(this.armed.keys()).sort()) {
      stamps[key] = this.armed.get(key) as string;
    }
    const told: Record<string, Record<string, string>> = {};
    for (const key of Array.from(this.told.keys()).sort()) {
      const rows = this.told.get(key);
      if (!rows || rows.size === 0) continue;
      const out: Record<string, string> = {};
      for (const id of Array.from(rows.keys()).sort()) {
        out[id] = (rows.get(id) as ToldRow).bucket;
      }
      told[key] = out;
    }
    const file: StampFile = {
      version: STAMP_FORMAT_VERSION,
      stamps,
      told,
      sent: this.sentSets.toJSON(),
    };
    return `${JSON.stringify(file, null, 2)}\n`;
  }

  /** Write the map back, when it has actually moved. Never throws: this runs
   *  inside a timer tick, and a full disk must not stop the wakes. */
  private saveStamps(): void {
    if (!this.stampFile) return;
    const next = this.serializeStamps();
    if (next === this.lastPersisted) return;
    try {
      writeFileSync(this.stampFile, next);
      this.lastPersisted = next;
    } catch (err) {
      console.error('[stall] could not persist stamps:', err);
    }
  }

  /**
   * Deliver one wake. True only when at least one stream took it: the caller
   * arms the stamp and records `told` on that answer, so a wake that reached
   * nobody stays owed. `send` used to be called for its side effect and its
   * count thrown away, which let a board decide it had told a lead whose
   * stream had closed between the reachability check and the write.
   */
  private emit(workspaceId: string, agentId: string, frame: StallNudgeFrame): boolean {
    let sent: number;
    try {
      sent = this.opts.send(workspaceId, agentId, frame);
    } catch (err) {
      console.error('[stall] send failed:', err);
      // No line: a send that threw spent nobody's turn, and the count below
      // is meant to be countable.
      return false;
    }
    if (typeof sent === 'number' && sent <= 0) {
      this.report(`[stall] wake undelivered ws=${workspaceId} lead=${agentId} streams=0`);
      return false;
    }
    this.noteWake(workspaceId, agentId, frame, typeof sent === 'number' ? sent : undefined);
    return true;
  }

  /**
   * One line per DELIVERED wake, so what this feature costs can be counted.
   *
   * The unit of spend here is a lead's turn, and the number worth watching is
   * wakes per board per hour — a loop that fires more often than anyone
   * realises is precisely the failure the arming rules exist to prevent, and a
   * claim nobody can check is how that failure survives. So the line is
   * emitted at the one point a turn is actually billed: after `send` returned,
   * never beside the decision to send.
   *
   * The three counts stay SEPARATE rather than summed. They are three
   * different asks — drive it, file the question, go and read it — and a board
   * waking its lead nine times about unreadable rows is a different finding
   * from one waking it nine times about stalled work. A total cannot tell them
   * apart.
   *
   * It rides the injectable `report`, not `console.error`, for the same reason
   * the unevaluable notice does: a line only a human tailing a log can see is
   * one no test can assert, and this has to stay true as the arming rules move
   * around it.
   */
  private noteWake(
    workspaceId: string,
    agentId: string,
    frame: StallNudgeFrame,
    streams?: number,
  ): void {
    try {
      this.report(
        `[stall] wake ws=${workspaceId} lead=${frame.escalatedFrom ?? agentId} ` +
          // How many streams took the frame — the number that tells a wake
          // the lead can read from one written into a closed socket.
          (streams !== undefined ? `streams=${streams} ` : '') +
          // `lead=` keeps naming the SEAT HOLDER in both cases, so a log
          // grepped for one board reads as one story; `to=` appears only when
          // those two are different people.
          (frame.escalatedFrom !== undefined ? `to=${agentId} ` : '') +
          `stalled=${frame.stalledCount} unfiled=${frame.unfiled?.length ?? 0} ` +
          `undetermined=${frame.undetermined?.count ?? 0} held=${frame.heldItems?.length ?? 0} ` +
          `askedBack=${frame.askedBack?.length ?? 0} ` +
          `unanswered=${frame.unanswered?.length ?? 0} ` +
          `checkIn=${frame.checkIn?.length ?? 0}`,
      );
    } catch {
      // A reporter that throws must not undo a wake that was already
      // delivered — the frame is out, and the arming below has to record it.
    }
  }
}
