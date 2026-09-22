/**
 * How the board's two WAKE events read to the lead agent that receives them.
 *
 * Everything else on the board channel reports something a person or an agent
 * just did, and arrives while the recipient is already in the loop. These two
 * are the opposite: the board woke a session that was not thinking about this
 * board, at the cost of a turn, to say that work is waiting. That makes the
 * line the entire message — there is no surrounding context to fall back on.
 *
 * Both landed in the renderer's `default:` case, which renders an unknown board
 * event as `[<event>] task <id>`. For a task transition among a stream of them
 * that is thin but survivable; for a wake it is the failure the nudger's
 * arming rules were written to prevent, reintroduced at the last hop. A lead
 * that must call `get_task` before it can tell whether the interruption was
 * worth answering learns to skim wakes, and then the one that mattered is
 * skimmed too.
 *
 * Kept out of mcp.ts — a bundle entry point that exports nothing — for the
 * same reason `voice-line.ts` is: the wording is a
 * decision, and inline in a 3,000-line switch it cannot be asserted.
 */
import { fromMockNote, openPartsClause } from './decision-line.ts';

/**
 * The board's parallelism cap as a wake carries it: the number and, once
 * somebody has moved it, who, when and from what. Every field loose, like
 * the rest of the payload — the server stamps it, an older one does not.
 */
export interface ParallelismCapPayload {
  value?: number;
  lastChange?: {
    actor?: { id?: string; name?: string; kind?: string };
    ts?: number;
    from?: number;
    to?: number;
  };
}

/**
 * "cap 1, set by Jordan 2h ago, was 4" — the cap named WITH its author in
 * one clause, so wherever a line holds rows for the cap the reader learns who
 * moved it in the same sentence (a moved cap is never a mystery). A cap nobody
 * has moved is stated bare: inventing a setter would be the lie the clause
 * exists to prevent. Empty when the frame carries no cap at all, which is
 * what an older server sends.
 */
function capClause(
  cap: ParallelismCapPayload | undefined,
  now: number | undefined,
  style: 'ready' | 'stall',
): string {
  if (cap === undefined || typeof cap.value !== 'number') return '';
  const change = cap.lastChange;
  const name = change?.actor?.name;
  let setter = '';
  if (change !== undefined && typeof name === 'string' && name.length > 0) {
    const at = typeof change.ts === 'number' ? change.ts : undefined;
    const clock = typeof now === 'number' ? now : Date.now();
    const ago = at === undefined ? '' : ` ${humanDuration(Math.max(0, clock - at))} ago`;
    const was = typeof change.from === 'number' ? `, was ${change.from}` : '';
    setter = `, set by ${name}${ago}${was}`;
  }
  return style === 'ready'
    ? ` (cap ${cap.value}${setter})`
    : ` of ${cap.value}${setter ? `${setter.replace(/, was (\d+)$/, ' (was $1)')},` : ''}`;
}

export interface NudgePayload {
  /** The row to start with (idle) or the row the answer was about
   *  (answered). Absent on an answer recorded against a comment rather than
   *  a task row — that route moves no task and has no id to carry. */
  taskId?: string;
  /** The row's title, which the server stamps onto both frames. Absent from a
   *  server older than that; the id is then all there is to name it by. */
  title?: string;
  /** What was asked — the answered item's headline. Answer frames only, and
   *  absent from a server older than the field. */
  headline?: string;
  /** The answer was sent from inside a mock page. Answer frames only. */
  via?: string;
  /** The item's questions a partial answer left open. Answer frames only. */
  openParts?: unknown[];
  /** How many rows were ready when the wake fired. Idle nudges only. */
  readyCount?: number;
  /**
   * How many OPEN ROWS the pass examined to arrive at `readyCount` — the
   * denominator. Idle nudges only, and absent from a server older than the
   * dependency-state gate, in which case the line simply does not claim one.
   */
  consideredCount?: number;
  /** What the pass withheld and why — `{ 'awaiting-person': 2, backlog: 1 }`.
   *  Absent rather than empty when nothing was held. */
  held?: Record<string, number>;
  /**
   * Rows the pass could NOT evaluate. Its presence is the whole signal, so it
   * is absent on the ordinary wake rather than sent as a zero.
   *
   * A frame carrying this with `readyCount: 0` is the one case where the
   * board wakes its lead with no work to hand over: the pass could not
   * establish that the board is quiet, and that is a different message from
   * a quiet board — which is a message it does not send at all.
   */
  undetermined?: { count?: number; reasons?: string[] };
  /**
   * Rows a PERSON's single act just freed — a goal band agreed, a blocker
   * closed. `count` is every row released; `rows` is the first few of them in
   * the board's priority order.
   *
   * Its PRESENCE is what makes this a different sentence: the server sets it
   * only on the release path, so a frame carrying it is one where somebody was
   * at the board seconds ago and work that was held is now dispatchable. Absent
   * on the timed pass and from a server older than the field, in which case the
   * line renders exactly as it did — off `taskId`/`title`, which the server
   * sets to the first freed row for that reason.
   */
  freed?: { count?: number; rows?: Array<{ id?: string; title?: string }> };
  /** How long the board had stood still. Idle nudges only. */
  idleMs?: number;
  /** The cap that held rows, with who moved it and when. Sent only beside a
   *  `parallelism-cap` hold; see `capClause`. */
  parallelismCap?: ParallelismCapPayload;
  /** When the frame was sent — the clock "set by X 2h ago" is read against.
   *  Absent from an older server; the renderer's own clock stands in. */
  ts?: number;
  /** The answered row's own links. Answer nudges only, and routinely EMPTY —
   *  most rows annotate nothing. Absent from a server older than the field,
   *  and absent by construction on an answer recorded against a comment,
   *  which moves no row and so has no links to send. */
  links?: unknown[];
}

/** One stuck row, as `stall-nudge.ts` puts it on the wire. Every field is
 *  optional here and required there, deliberately: this renderer also has to
 *  survive a frame from a server older than the field it is reading. */
export interface StalledRowPayload {
  id?: string;
  title?: string;
  bucket?: string;
  quietMs?: number;
  /**
   * The board that holds this row, when it is not the frame's own.
   *
   * Set only on the `unfiled` list, and only by the fleet escalation
   * (`waiting-unfiled-escalation.ts`), which reports every board's unfiled
   * asks in ONE wake. Before it existed those rows were read under the
   * frame's single tag, so a lead was handed rows from boards it is not on
   * with nothing in the frame to say so, and could only tell by recognising
   * the ids.
   *
   * Absent means the frame's own `workspaceId` — which is what every
   * per-board wake means, so a single-board frame spends nothing restating
   * its own tag.
   */
  workspaceId?: string;
}

/**
 * The bucket the server sends for the row whose OWN CLOSING NOTE was read as
 * an ask — the one door into `unfiled` that is not a board fact.
 *
 * Two things put a row on that list, and until this constant existed the line
 * said the same words about both. `blocked-on-owner-unfiled` is the BOARD
 * saying a person owns the row (its `ownerKind`, or its goal band) with
 * nothing filed. This one is `detectAsk` — a regex over the agent's prose —
 * reading a status note as an ask. Measured case: a note ending "Merge waits
 * on the classifier block on <person>'s queue" put an agent-assigned row
 * under an ordinary dispatched goal into the flat sentence, and its reader
 * was told to go and file an ask that nobody had asked for.
 *
 * **The rendered sentence quotes no error RATE, on purpose.** There are two
 * measured ones — 86% precision over 631 closing messages, and 94% after the
 * tuning, both in `docs/architecture/unfiled-ask.md` — and both were measured
 * over end-of-turn NOTES, while the rows reaching this sentence also had to
 * survive the quiet clock. So any figure here is an extrapolation onto a
 * different population, and a precise-sounding wrong number on a calibration
 * line is the very failure this split exists to end. The qualitative claim —
 * this came from a regex over the agent's words, not from the board — is the
 * part that is true and the part the reader acts on.
 *
 * **A row with NO `bucket` renders as the board-declared sentence, and that
 * is right rather than merely tolerable.** `bucket` has been on `StalledRow`
 * since #404, the frame's inception; a row could only reach `unfiled` through
 * this door from #1050. So a server old enough to omit the field can only
 * ever have carried board-declared rows, and the default reproduces the old
 * wording byte for byte for exactly those frames.
 *
 * A reader who learns the notice overclaims stops acting on the true rows
 * too, which is why the fix is the wording rather than the finding: both rows
 * are still named, and both still age and escalate exactly as before.
 *
 * `stall-escalation.ts` has carried two wordings for these two buckets since
 * it was written (`BUCKET_WORDS`); this line had one, so the renderer had
 * fallen behind a distinction the model already makes. The spelling is the
 * server's `WAITING_UNFILED_BUCKET` — restated rather than imported, because
 * this package may not reach into the server's, and pinned against it by
 * `agent-owned-unfiled-wording.test.ts` so the two cannot drift apart.
 */
const NOTE_INFERRED_UNFILED = 'waiting-unfiled';

/** One review item the quality gate is holding past its window, as
 *  `stall-nudge.ts` puts it on the wire. `id` is the ticket's. */
export interface HeldRowPayload {
  id?: string;
  title?: string;
  reviewItemId?: string;
  headline?: string;
  reason?: string;
  heldMs?: number;
  filedBy?: string;
  /** The paste-ready `revise_review_item(…)` call for whichever surface the
   *  item is on. See `ReviewItemHeldPayload.revise`. */
  revise?: string;
}

/** A review item a person asked a question on that its filer has not
 *  revised, as `stall-nudge.ts` puts it on the wire. `id` is the ticket's. */
export interface AskedBackRowPayload {
  id?: string;
  title?: string;
  reviewItemId?: string;
  headline?: string;
  askedBy?: string;
  askedMs?: number;
  /** The paste-ready `revise_review_item(…)` call that puts it back. */
  revise?: string;
}

/**
 * A doc thread whose last speaker is a PERSON and where no agent has replied
 * (`unanswered-thread.ts` on the server). The doc need hang on no task at
 * all, which is why nothing else in this frame can name it. Absent from a
 * server older than this, whose frames carried no such list.
 */
export interface UnansweredRowPayload {
  /** The doc's id — what the reader opens. */
  id?: string;
  title?: string;
  threadId?: string;
  askedBy?: string;
  /** How long the person has been waiting, from their first unanswered
   *  comment rather than their latest. */
  askedMs?: number;
  /** The opening of what they wrote, so deciding whether it is yours costs
   *  no doc read. */
  excerpt?: string;
  /** The paste-ready `post_reply(…)` call that answers it. */
  reply?: string;
}

/** A row an agent filed that reads as UI work and is being built with no
 *  answered review item on it — the UI gate's breach (`ui-review-gate.ts`
 *  on the server). `file` is the changed file that made it UI work, and it
 *  is the finding's evidence: the gate reads the builder's diff, not the
 *  ticket's prose. `keyword` is the word in the row's own words that agrees,
 *  when there is one — carried so the lead can weigh the finding without
 *  re-reading the ticket, and absent on the rows a word list could never
 *  have caught. Both are absent from a server older than this, whose frames
 *  named a row and a keyword alone. */
export interface UngatedUiRowPayload {
  id: string;
  title?: string;
  file?: string;
  keyword?: string;
  /** Where `file` was measured from: `dispatch` is the commit pinned when
   *  this task's dispatch was registered, so the file is this task's work;
   *  `trunk` is the merge base the read fell back to, which also counts
   *  anything else committed in that checkout since. Absent from a server
   *  older than this — see `ungatedRowClause`. */
  from?: 'dispatch' | 'trunk';
}

/**
 * One row whose blockage LIFTED and whose work has not restarted —
 * `stall-nudge.ts`'s `unresumed`, read off `blockage-lift.ts`. It is the one
 * finding on this frame that reports something GOOD nobody acted on, so the
 * line it renders asks for a different act from every other: hand the answer
 * back, rather than go looking for an owner.
 *
 * `liftedAt` and `lift` are carried so the reader can CHECK the event. A
 * finding that fires once on a snapshot boundary reads exactly like one that
 * has been true for two days unless it says what it rests on.
 */
export interface UnresumedRowPayload {
  id: string;
  title?: string;
  /** Which signal said so. */
  lift?: 'review-item-answered' | 'done-when-met';
  /** When it lifted, and how long ago in ms. */
  liftedAt?: number;
  liftedMs?: number;
  /** What is now unblocked, in the board's own words. */
  what?: string;
  /** What is open now — the first open line after the met one. `done-when-met`
   *  only. */
  next?: string;
}

/**
 * One wait an agent DECLARED on a row, for something the board cannot see —
 * `stall-nudge.ts`'s `declaredWaits`. Not a finding: it explains a row the
 * frame already names, which is what makes the wake say something new instead
 * of repeating a silence.
 */
export interface DeclaredWaitPayload {
  id?: string;
  title?: string;
  /** What the declarer said it waits on, verbatim. */
  what?: string;
  /** When the wait first started, surviving renewals of the same words. */
  since?: number;
  /** When it lapses. */
  until?: number;
  by?: string;
  /** `until` has passed — the row is back on the escalation clock. */
  lapsed?: boolean;
}

/** What `workspace.stalled` carries. Eight lists, because the lead's next act
 *  differs for each — see `stalledLine`. */
export interface StallPayload {
  /** The anchor row, when it is a TASK. Never a doc id: a doc-anchored wake
   *  carries `docId` instead, because a reader that fed this field to a task
   *  lookup got a miss and read it as a broken wake. */
  taskId?: string;
  /** The anchor row when it is a DOC — a question on a doc thread, or a
   *  review item filed on one, neither of which hangs on a task. Absent from
   *  a server older than the split, whose doc-anchored wakes put the doc's id
   *  in `taskId`. */
  docId?: string;
  title?: string;
  stalledCount?: number;
  consideredCount?: number;
  rows?: StalledRowPayload[];
  unfiled?: StalledRowPayload[];
  undetermined?: { count?: number; reasons?: string[] };
  /** `heldItems`, not `held` — ready_idle spends that name on its counts. */
  heldItems?: HeldRowPayload[];
  /** Rows somebody holds and has not reported on for the check-in window. */
  checkIn?: StalledRowPayload[];
  /** Items a person asked back on, unrevised — off that person's queue. */
  askedBack?: AskedBackRowPayload[];
  /** Doc threads a person asked something on that no agent has answered. */
  unanswered?: UnansweredRowPayload[];
  /** Rows built past the UI gate. A frame carrying only this is a real
   *  wake: the row is MOVING, so no other list here would ever name it. */
  ungatedUi?: UngatedUiRowPayload[];
  /** Rows whose blockage lifted with nothing done since. A frame carrying
   *  only this is a real wake: the answer is in and nobody read it. */
  unresumed?: UnresumedRowPayload[];
  /** Runnable rows past the board's parallelism cap, which the pass did not
   *  judge — idle by rule, not healthy. Absent when none. */
  beyondCapacity?: number;
  /** What the named rows were declared to be waiting on, off the board. */
  declaredWaits?: DeclaredWaitPayload[];
  /** What is new since this board's last wake — see `changedClause`. Absent
   *  on a first wake, and on any frame from a server older than it. */
  changed?: {
    rows?: StalledRowPayload[];
    undetermined?: string[];
    heldItems?: HeldRowPayload[];
    askedBack?: AskedBackRowPayload[];
    unanswered?: UnansweredRowPayload[];
    ungatedUi?: UngatedUiRowPayload[];
    unresumed?: UnresumedRowPayload[];
    checkIn?: StalledRowPayload[];
    escalated?: boolean;
  };
  /** The cap that kept them out, with who moved it and when. Sent only
   *  beside `beyondCapacity`; see `capClause`. */
  parallelismCap?: ParallelismCapPayload;
  /** When the frame was sent — see `NudgePayload.ts`. */
  ts?: number;
  /** The lead this wake was addressed to, when it could not be reached and
   *  came here instead. Absent on the ordinary wake — its presence is the
   *  whole signal, and without it the reader has no way to tell why it was
   *  woken about a board it does not lead. */
  escalatedFrom?: string;
  /** Set only by the fleet carry of unfiled waits — see `unfiledCarryLine`.
   *  The other reason a lead is woken about a board it does not lead, and
   *  the one that used to be indistinguishable from the line above. */
  unfiledCarry?: UnfiledCarryPayload;
}

/** The fleet carry's marker: the window every unfiled row has already spent
 *  past its own board's lead, and the leads that were told. Every field
 *  optional — a server may send the marker with a board list this bundle's
 *  own server would not. */
export interface UnfiledCarryPayload {
  toldAtLeastMs?: number;
  boards?: { workspaceId?: string; leadAgentId?: string }[];
}

/** What `workspace.review_item_held` carries — the filer's own wake. */
export interface ReviewItemHeldPayload {
  taskId?: string;
  title?: string;
  reviewItemId?: string;
  /** The doc-thread address, when the item was filed as a `review` payload
   *  on a comment rather than on a ticket. */
  docId?: string;
  threadId?: string;
  commentId?: string;
  /** The paste-ready `revise_review_item(…)` call, spelled by the server for
   *  whichever surface the item is on. Preferred over anything assembled
   *  here: the two forms take different arguments, and a filer that guesses
   *  spends a call finding out. */
  revise?: string;
  headline?: string;
  reason?: string;
  overdue?: boolean;
  heldMs?: number;
}

/** Mirrors mcp.ts's helper of the same name. Duplicated rather than shared
 *  because mcp.ts exports nothing; the copy is what lets the rendered line be
 *  asserted from a test. */
function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * A duration as a person reads one. Coarse on purpose: the recipient is
 * deciding whether the wait is unusual, not measuring it, and "1h 35m" makes
 * that call at a glance where "95m" makes it after arithmetic.
 */
function humanDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** The row, named by whatever the frame actually carries. A title with its id
 *  in tow when both are there, because the title is what the reader
 *  recognises and the id is what the tools take. */
function namedTask(p: NudgePayload): string | null {
  const title = p.title ? `"${truncate(p.title, 60)}"` : null;
  if (title && p.taskId) return `${title} (${p.taskId})`;
  return title ?? p.taskId ?? null;
}

/** How many rows the pass could not read, or 0 — tolerant of a `count` a
 *  server omitted while sending reasons, which would otherwise render as a
 *  present-but-silent field. */
function undeterminedCount(p: NudgePayload): number {
  const u = p.undetermined;
  if (!u) return 0;
  if (typeof u.count === 'number' && u.count > 0) return u.count;
  return u.reasons && u.reasons.length > 0 ? u.reasons.length : 0;
}

/** The reasons as one clause, or a placeholder — never an empty parenthesis. */
function reasonsClause(p: NudgePayload): string {
  const reasons = p.undetermined?.reasons ?? [];
  return reasons.length > 0 ? reasons.join(', ') : 'reason not reported';
}

/**
 * The parenthetical that stops "1 task is ready" from meaning two different
 * boards.
 *
 * Absent entirely when the server sent no denominator — a line that invented
 * one, or wrote "unknown", would be worse than one that does not claim to
 * know. Present whenever it was sent, even when it equals `readyCount`,
 * because a stated denominator that agrees and an omitted one are exactly
 * what a reader must be able to tell apart.
 */
function denominatorClause(p: NudgePayload): string {
  if (p.consideredCount === undefined) return '';
  const parts = [`${p.consideredCount} open ${p.consideredCount === 1 ? 'task' : 'tasks'} checked`];
  const held = Object.entries(p.held ?? {})
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([reason, n]) =>
        `${n} ${reason}${reason === 'parallelism-cap' ? capClause(p.parallelismCap, p.ts, 'ready') : ''}`,
    );
  if (held.length > 0) parts.push(`held: ${held.join(', ')}`);
  const unread = undeterminedCount(p);
  // Spelled loudly, and with which way the uncertainty falls. A row nobody
  // could read that reads as "already handled" is the exact swap this clause
  // exists to prevent.
  if (unread > 0) {
    parts.push(`${unread} could NOT be evaluated (${reasonsClause(p)}) and is not counted ready`);
  }
  return ` (${parts.join('; ')})`;
}

/**
 * The freed rows as a list, with the overflow said rather than dropped.
 *
 * A band agreement can release forty rows and the wake is still one message,
 * so the frame names the first few and carries the true total. "and 35 more"
 * is the part that stops the named few from reading as the whole release —
 * which would send the lead back to the board believing they had seen it all.
 */
function freedList(rows: Array<{ id?: string; title?: string }>, total: number): string {
  const named = rows
    .map((r) => {
      const title = r.title ? `"${truncate(r.title, 60)}"` : null;
      if (title && r.id) return `${title} (${r.id})`;
      return title ?? r.id ?? null;
    })
    .filter((s): s is string => s !== null);
  if (named.length === 0) return '';
  const more = total - named.length;
  return `${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * Render the RELEASE wake — a person's single act made held work dispatchable.
 *
 * A different sentence from the idle one rather than the same with different
 * numbers, because the reader's question is different. The idle line answers
 * "has this been sitting here"; this one answers "what just changed", and the
 * answer is that somebody agreed a band or closed a blocker moments ago. Told
 * in the past tense with no duration, because there is none — nothing here has
 * been waiting.
 *
 * The rows are named rather than counted alone. One gesture can release ten,
 * and a wake that said only "10 tasks became ready" would make the lead open
 * the board to find out whether it was their band or somebody else's.
 */
function releasedLine(p: NudgePayload, freed: NonNullable<NudgePayload['freed']>): string {
  const rows = freed.rows ?? [];
  const total = freed.count ?? rows.length;
  const one = total === 1;
  const list = freedList(rows, total);
  // The list can be empty only if a server sent a count with no rows. Fall back
  // to whatever the frame names the top row as, rather than to a colon with
  // nothing after it.
  const named = list || namedTask(p);
  const subject = `${total} ${one ? 'task' : 'tasks'} just became ready`;
  return `[workspace.ready_idle] ${subject}${named ? `: ${named}` : ''} — held work a person released just now. Take ${one ? 'it' : 'them'} in priority order with next_tasks / task_transition.`;
}

/**
 * Render `workspace.ready_idle` — ready work nobody has picked up, or the one
 * case where the board could not tell whether there is any.
 *
 * Ordered so the two facts that decide whether to act come first (how much is
 * waiting, how long it has waited), the denominator that says what those
 * numbers are OUT OF next, the row to start with after that, and the tool to
 * start with last. The count is spelled out even at one, because a lone row
 * and a queue are different asks and a bare title says neither.
 *
 * The zero-ready branch is a different sentence rather than the same one with
 * a zero in it. The server sends that frame ONLY when rows could not be
 * evaluated — a genuinely quiet board is silence — so telling its reader to
 * "take the top of the queue" would send them to an empty queue and teach
 * them, correctly, that the wake carries no information.
 */
export function readyIdleLine(p: NudgePayload): string {
  // The release wake first: it is the one frame here that is not about elapsed
  // time at all, so none of the idle line's clauses apply to it.
  const freed = p.freed;
  if (freed && (freed.count ?? freed.rows?.length ?? 0) > 0) return releasedLine(p, freed);
  const count = p.readyCount;
  const unread = undeterminedCount(p);
  if (count === 0 && unread > 0) {
    const of = p.consideredCount === undefined ? `${unread}` : `${unread} of ${p.consideredCount}`;
    return `[workspace.ready_idle] nothing is ready to hand over, and this pass could not establish that the board is quiet: ${of} open task(s) could not be evaluated (${reasonsClause(p)}). Read them with list_tasks before treating this board as clear.`;
  }
  const one = count === 1;
  const subject =
    count === undefined ? 'ready work has' : `${count} ${one ? 'task has' : 'tasks have'}`;
  const stood = p.idleMs === undefined ? '' : ` for ${humanDuration(p.idleMs)}`;
  const nobody = count !== undefined && !one ? 'them' : 'it';
  const top = namedTask(p);
  const start = top ? ` Start with ${top}.` : '';
  return `[workspace.ready_idle] ${subject} been ready${stood} with nobody on ${nobody}${denominatorClause(p)}.${start} Take the top of the queue with next_tasks / task_transition.`;
}

/**
 * Render `workspace.review_answered` — an ask the lead raised has an answer.
 *
 * No duration and no count: this frame is sent the moment the answer lands,
 * and it is about one thing. What it must carry is which ask was answered and
 * that the answer is now the input to something — an answered item nobody
 * reads is the same dead end as an unasked question.
 *
 * The propagation clause follows that ONLY when the row actually has links.
 * It used to be unconditional, on a frame that carried no links field at all
 * — so the commonest wake on this board told its reader to walk a checklist
 * nothing anywhere could produce, and an instruction that cannot be followed
 * cannot be told apart from one that can. Worse here than on
 * `decision.answered`, which at least sometimes had links to walk: an answer
 * recorded against a COMMENT names no row whatsoever, and this line still
 * sent its reader after that row's links.
 */
export function reviewAnsweredLine(p: NudgePayload): string {
  const about = namedTask(p);
  // The headline names WHICH ask on the row — a row can carry several, and
  // "You merge it" against two candidate merges is not an answer.
  const item = p.headline ? `your review item "${truncate(p.headline, 100)}"` : 'your review item';
  const subject = about ? `${item} on ${about}` : p.headline ? item : 'a review item you raised';
  const walk =
    Array.isArray(p.links) && p.links.length > 0
      ? '; walk its links as the propagation checklist'
      : '';
  return `[workspace.review_answered] ${subject} has an answer${fromMockNote(p.via)}${openPartsClause(p.openParts)} — read it and act on it now${walk}.`;
}

/** How many rows the line names before it starts counting instead. Five is
 *  what fits in a channel message a reader takes in at a glance; the rest are
 *  summarised rather than dropped, because a truncated list a reader cannot
 *  tell from a complete one is worse than either. The FRAME carries them all
 *  — see `stall-nudge.ts`. */
const STALL_ROWS_SHOWN = 5;

/**
 * One stuck row as the line names it: what it is, how long it has been
 * silent, and — only when the frame spans boards — which board it is on.
 *
 * The bucket is left out: the reader's action is the same for both stalled
 * kinds, and the word "in-progress" beside a title reads as status rather
 * than as diagnosis.
 *
 * The board is named only when it DIFFERS from the frame's own, so an
 * ordinary per-board wake reads exactly as it always did and the words are
 * spent only where the reader needs them — telling a row it owns from one it
 * must route to another board's lead.
 */
function stalledRowClause(row: StalledRowPayload, frameBoard?: string): string {
  const named = row.title ? `"${truncate(row.title, 50)}" (${row.id})` : (row.id ?? 'a task');
  const quiet = row.quietMs === undefined ? named : `${named} quiet ${humanDuration(row.quietMs)}`;
  return row.workspaceId === undefined || row.workspaceId === frameBoard
    ? quiet
    : `${quiet} on board ${row.workspaceId}`;
}

/** One declared wait as the line names it: the row, the words the declarer
 *  wrote, and how long the wait has been standing. The words are what stop
 *  this being a second way of saying the row is quiet. */
function declaredWaitClause(wait: DeclaredWaitPayload, now: number | undefined): string {
  const named = wait.title ? `"${truncate(wait.title, 50)}" (${wait.id})` : (wait.id ?? 'a task');
  const what = wait.what ? ` on ${truncate(wait.what, 80)}` : '';
  const held =
    now !== undefined && wait.since !== undefined
      ? `, ${humanDuration(now - wait.since)} so far`
      : '';
  return `${named}${what}${held}`;
}

/** The named rows, then a count of whatever did not fit. `frameBoard` is what
 *  lets a row say it belongs to a DIFFERENT board — see `stalledRowClause`. */
function stalledRowsClause(rows: readonly StalledRowPayload[], frameBoard?: string): string {
  const shown = rows.slice(0, STALL_ROWS_SHOWN).map((row) => stalledRowClause(row, frameBoard));
  const rest = rows.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ');
}

/**
 * What is new since the last wake — the sentence that answers "why am I being
 * told this again".
 *
 * It goes FIRST in the body, ahead of the full lists, because that is the
 * order the reader needs: which of these four rows moved, and only then the
 * four rows to drive. Absent on a board's first wake, where the whole frame
 * is the news.
 *
 * "Nothing new" is not renderable here — the server only sets `changed` when
 * something did — so an empty object renders nothing rather than a claim.
 */
function changedClause(changed: StallPayload['changed']): string {
  if (!changed) return '';
  const bits: string[] = [];
  const rows = changed.rows ?? [];
  if (rows.length > 0) bits.push(`${stalledRowsClause(rows)}`);
  const unread = changed.undetermined ?? [];
  if (unread.length > 0) bits.push(`${unread.join(', ')} became unreadable`);
  const held = changed.heldItems ?? [];
  if (held.length > 0) bits.push(`${held.length} review item(s) newly held`);
  const asked = changed.askedBack ?? [];
  if (asked.length > 0) bits.push(`${asked.length} review item(s) newly asked back`);
  const waiting = changed.unanswered ?? [];
  if (waiting.length > 0)
    bits.push(`${waiting.length} unanswered question(s) from a person on a doc`);
  const ungated = changed.ungatedUi ?? [];
  if (ungated.length > 0) bits.push(`${ungated.length} task built past the UI gate`);
  const lifted = changed.unresumed ?? [];
  if (lifted.length > 0)
    bits.push(`${lifted.length} task(s) newly unblocked with nothing done since`);
  const checkIn = changed.checkIn ?? [];
  if (checkIn.length > 0) bits.push(`${checkIn.length} task(s) owe a check-in`);
  if (changed.escalated === true)
    bits.push('the board\u2019s quietest task crossed another repeat window');
  if (bits.length === 0) return '';
  return `NEW since the last wake: ${bits.join('; ')}.`;
}

/**
 * Every key a `workspace.stalled` frame carries that THIS bundle can read —
 * the eight finding lists, the fields that qualify them, and the envelope the
 * frame rides in.
 *
 * It exists so the renderer can tell "the server sent findings I do not know"
 * from "the server sent nothing", which it could not before: a key nobody
 * reads is simply not read, so a frame carrying only `unanswered` looked
 * exactly like a frame carrying nothing at all, and the body fell through to
 * a sentence blaming the wake. Two peers read that sentence on three boards
 * on 2026-09-16, one of them 85 rows deep.
 *
 * The blame it corrects is not a guess. `stall-nudge.ts` RETURNS before
 * emitting when every one of its lists is empty, so a frame that arrives
 * carries at least one finding by construction — which means an empty render
 * is this bundle's inability to read the frame, not the board's emptiness,
 * whenever the frame holds a key this set does not.
 *
 * The payload half is BOUND to `StallPayload` by its type rather than typed
 * out beside it: `Record<keyof StallPayload, true>` fails the build when a
 * field is added to the payload and not to this table, and when a name here
 * matches no field. Before that binding the two agreed only by coincidence,
 * and a missing name is the worst failure this file has — it makes the notice
 * below fire on every ordinary wake. The envelope half cannot be bound that
 * way, because those fields belong to the transport rather than to the
 * payload type; `watchKey` is the one that was missed, and a test takes a
 * frame off a real mux stream rather than trusting this list.
 *
 * Kept as a set of names rather than a version number on the wire because the
 * reader is the half that is OLD: a version the server states only helps
 * against servers that already state it, while this comparison works against
 * every server, including ones deployed before the renderer that reads it.
 * See the PR that added it.
 */
const STALL_PAYLOAD_KEYS: Record<keyof StallPayload, true> = {
  // The anchor.
  taskId: true,
  docId: true,
  title: true,
  // The counts and their denominator.
  stalledCount: true,
  consideredCount: true,
  beyondCapacity: true,
  parallelismCap: true,
  // The eight finding lists, and the things that qualify them.
  rows: true,
  unfiled: true,
  undetermined: true,
  heldItems: true,
  askedBack: true,
  unanswered: true,
  ungatedUi: true,
  unresumed: true,
  checkIn: true,
  declaredWaits: true,
  changed: true,
  escalatedFrom: true,
  unfiledCarry: true,
  ts: true,
};

/** The wire fields that are NOT part of the payload type — the envelope the
 *  frame rides in, and the transport's own tag. */
const STALL_ENVELOPE_KEYS = [
  'event',
  'workspaceId',
  'eid',
  'actor',
  // TRANSPORT, not a finding: `sse-mux.ts` spreads the frame and stamps the
  // watch key it arrived on into EVERY multiplexed frame, which is what makes
  // one socket equivalent to N. It is on the wire of the path this plugin
  // actually uses, so omitting it made the notice below fire on every
  // ordinary stall wake — caught by review before it shipped, and pinned by
  // the mux case in `stall-wake-blame.test.ts` rather than by this comment.
  'watchKey',
] as const;

const KNOWN_STALL_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(STALL_PAYLOAD_KEYS),
  ...STALL_ENVELOPE_KEYS,
]);

/**
 * Does this value SAY anything? An absent key, an empty list and a zero are
 * all "the server had none of these", and a renderer that cried version skew
 * over them would fire on every ordinary frame — which is how a notice
 * becomes the thing people skim.
 */
function carriesContent(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/**
 * The frame's own keys that this bundle does not know AND that carry
 * something — in wire order, so the names read as the server spelled them.
 *
 * Deliberately not claiming they are findings. A future server may add a key
 * that is neither a list nor a row, and this line would then name it; the
 * advice it carries is right either way, because the reader is a plugin older
 * than the server it is talking to in both cases.
 *
 * It sees TOP-LEVEL keys only. A new sub-key inside `changed` is invisible to
 * it, and that is the accepted hole: `changed` repeats findings the lists
 * below it already carry, so a skew there costs the "what moved" sentence and
 * never the findings themselves.
 */
function unknownStallKeys(p: StallPayload): string[] {
  return Object.entries(p as Record<string, unknown>)
    .filter(([key, value]) => !KNOWN_STALL_KEYS.has(key) && carriesContent(value))
    .map(([key]) => key);
}

/**
 * The body for a frame that rendered to nothing — and WHOSE FAULT that is.
 *
 * Both versions stay loud, on purpose. A peer that met the old sentence spent
 * one call confirming the board rather than reading it as finished, which is
 * the three-state behaviour the fleet's own rules ask for; the defect was
 * never the volume, it was that the sentence accused the server of a bug in
 * the wake when the reader's own bundle was the thing that could not read it.
 * So the loudness is unchanged and only the blame moves.
 *
 * Which of the two the reader gets is decided by evidence rather than by a
 * guess: keys on the frame that this bundle does not know are the version
 * skew, and none of them means the frame really did arrive with nothing
 * renderable on it, which remains a bug worth reporting.
 */
function unrenderableBody(unknown: readonly string[]): string {
  if (unknown.length === 0) {
    return 'the board reported a stall with no tasks on it — treat this as a bug in the wake, not as a clear board.';
  }
  return (
    `the board reported findings this plugin cannot read — the frame carries ${unknown.join(', ')}, ` +
    'which this bundle does not know. Your plugin is OLDER than this server, which is the likely ' +
    'cause rather than a broken wake. The board is NOT clear: update the plugin ' +
    '(command claude plugin update claude-workspaces@claude-workspaces), restart this session, and ' +
    'read the board with next_tasks / list_tasks meanwhile.'
  );
}

/**
 * The first line of a fleet carry — the wake that is NOT about this board.
 *
 * Two sentences, and neither of them is the redirect's. The redirect says the
 * board's lead seat is unreachable; this says the leads were reached, were
 * told a window ago, and the asks are still unfiled. A reader handed the
 * wrong one of those goes hunting a delivery fault, which is what six wakes
 * between 20 and 22 September 2026 cost.
 *
 * The window is stated as a floor. The rows are due on their own clocks and
 * only the common one is true of every row on the frame, so the line says
 * "over" rather than a number it would have to pick a row to justify.
 *
 * A board whose seat is empty is named with "(no lead named)" rather than
 * dropped: the reader still has to act on the row, and a silently missing
 * board reads as a shorter list rather than as an unanswered question.
 */
function unfiledCarryLine(carry: UnfiledCarryPayload): string {
  const boards = (carry.boards ?? [])
    .filter((b): b is { workspaceId: string; leadAgentId?: string } => Boolean(b.workspaceId))
    .map((b) => `${b.workspaceId} (${b.leadAgentId ? `lead ${b.leadAgentId}` : 'no lead named'})`);
  const named = boards.length > 0 ? ` — ${boards.join(', ')}` : '';
  const window =
    carry.toldAtLeastMs === undefined ? '' : ` over ${humanDuration(carry.toldAtLeastMs)}`;
  return (
    `You were woken as Team Lead, not as this board's lead: every row below was named to its own ` +
    `board's lead${window} ago and is still unfiled${named}. ` +
    'Tell that lead to file the ask with add_review_item, or file it yourself.'
  );
}

/**
 * Render `workspace.stalled` — work that was supposed to be moving and is not.
 *
 * This wake differs from `readyIdleLine` in what it asks for. Ready work needs
 * one row picked up, so that line names one and points at the queue. A stall
 * frame names work that already has an owner who stopped, and the lead's job
 * is to go and drive EACH row — so the list is what the line is for, and it
 * carries several rather than a head and a count.
 *
 * Two other lists ride the same frame and each asks for something different,
 * which is why they are separate sentences rather than one merged total:
 *
 *  - `unfiled` is a row waiting on a person nobody actually asked. Nothing is
 *    stalled there; the remedy is to file the question where they read it, and
 *    telling the lead to "drive" it would send them to chase somebody who was
 *    never asked. It renders as TWO sentences, split on the row's bucket: what
 *    the board declares, and what the row's own note was read to say. See
 *    `NOTE_INFERRED_UNFILED` for why one sentence was not enough.
 *  - `undetermined` is rows the pass could not read. Spelled loudly and with
 *    which way the uncertainty falls, for the reason the ready line spells it:
 *    a row nobody could read that arrives as "already handled" is the exact
 *    swap this clause exists to prevent.
 */
export function stalledLine(p: StallPayload, frameBoard?: string): string {
  const parts: string[] = [];
  const rows = p.rows ?? [];
  const count = p.stalledCount ?? rows.length;
  // The cap's unjudged rows ride inside the denominator clause, so "of 9
  // open rows checked" cannot read as nine judged when five were.
  //
  // It says WHICH reading the cap held, because it no longer holds all of
  // them. The clause used to end "and not judged" flat, which read as a
  // contradiction of the beyond-cap rows the frame lists a few lines later —
  // and since PR 1078 it is also untrue: `stall-gate.ts` applies the cap to
  // the stall, builder-silence and check-in readings ONLY, and still asks
  // every beyond-cap row whether somebody is waiting on a question nobody
  // filed. A reader who believes the flat version skips the rows the unfiled
  // sentence is about.
  const beyond =
    p.beyondCapacity !== undefined && p.beyondCapacity > 0
      ? `; ${p.beyondCapacity} beyond the parallelism cap${capClause(p.parallelismCap, p.ts, 'stall')} and not judged for stalling — still checked for an unfiled ask`
      : '';
  const denominator =
    p.consideredCount === undefined
      ? ''
      : ` (of ${p.consideredCount} open task(s) checked${beyond})`;
  if (count > 0) {
    const subject = count === 1 ? '1 task has' : `${count} tasks have`;
    const list = rows.length > 0 ? ` — ${stalledRowsClause(rows)}` : '';
    parts.push(
      `${subject} stopped moving${denominator}${list}. Drive each one: read its thread, ` +
        'then unblock it, hand it to somebody, or park it with a reason.',
    );
  }
  // TWO SENTENCES, because two different things put a row on this list and
  // the reader's next act differs. See `NOTE_INFERRED_UNFILED` for the story.
  const unfiled = p.unfiled ?? [];
  const declaredUnfiled = unfiled.filter((r) => r.bucket !== NOTE_INFERRED_UNFILED);
  const saidUnfiled = unfiled.filter((r) => r.bucket === NOTE_INFERRED_UNFILED);
  // Said ONCE, ahead of both sentences, when the unfiled list reaches past the
  // frame's own board — the fleet escalation reports every board's unfiled
  // asks in a single wake. Without it the reader has to notice the per-row
  // board suffix to realise some of these are not theirs to file.
  const foreign = unfiled.filter(
    (r) => r.workspaceId !== undefined && r.workspaceId !== frameBoard,
  );
  if (foreign.length > 0) {
    parts.push(
      `This is a FLEET report, not just this board: ${foreign.length} of the ${unfiled.length} ` +
        'unfiled rows below sit on other boards, each named with the board it is on. Act on the ' +
        'ones on your own board and route the rest to their board’s lead.',
    );
  }
  if (declaredUnfiled.length > 0) {
    const noun = declaredUnfiled.length === 1 ? 'task is' : 'tasks are';
    parts.push(
      `${declaredUnfiled.length} ${noun} waiting on a person with NO question filed — ` +
        `${stalledRowsClause(declaredUnfiled, frameBoard)}. File the ask where they will see it, or the wait is invisible.`,
    );
  }
  if (saidUnfiled.length > 0) {
    const one = saidUnfiled.length === 1;
    // Every clause agrees in number with its subject. Written out rather than
    // pluralised by a helper: "an ask", "the row" and "the note" each had to
    // move, and a reader who meets "3 tasks' own closing notes read as an ask
    // to a person" is being told the sentence was not proof-read.
    const subject = one
      ? 'task’s own closing note reads as an ask to a person, with nothing filed on the row'
      : 'tasks’ own closing notes read as asks to a person, with nothing filed on those rows';
    parts.push(
      `${saidUnfiled.length} ${subject} — ${stalledRowsClause(saidUnfiled, frameBoard)}. This is NOT the board ` +
        `saying a person owns ${one ? 'the row' : 'those rows'} — it is a regex over the agent’s ` +
        `own words. Read ${one ? 'the note' : 'each note'}, then file the ask where they will see ` +
        'it, or say in one line that there was none.',
    );
  }
  // The declared waits, in two sentences rather than one, because the reader's
  // move differs. A standing wait is why a row above is named and not being
  // escalated — information, said once. A LAPSED one is a sentence the reader
  // wrote that has run out, and the row is loud again because of it; that is
  // the half they have to act on, so it is said separately and last.
  const waits = p.declaredWaits ?? [];
  const standing = waits.filter((w) => w.lapsed !== true);
  const lapsed = waits.filter((w) => w.lapsed === true);
  if (standing.length > 0) {
    const noun = standing.length === 1 ? 'task is' : 'tasks are';
    parts.push(
      `${standing.length} ${noun} declared to be waiting on something off the board — ` +
        `${standing.map((w) => declaredWaitClause(w, p.ts)).join('; ')}. ` +
        'Not escalated while the wait stands; clear it with declare_wait(clear: true) when the thing arrives.',
    );
  }
  if (lapsed.length > 0) {
    const noun = lapsed.length === 1 ? 'declared wait has' : 'declared waits have';
    parts.push(
      `${lapsed.length} ${noun} LAPSED and the task(s) are back on the escalation clock — ` +
        `${lapsed.map((w) => declaredWaitClause(w, p.ts)).join('; ')}. ` +
        'Either the wait is over and the work is yours to drive, or it is still real and needs declaring again.',
    );
  }
  const unread = p.undetermined?.count ?? p.undetermined?.reasons?.length ?? 0;
  if (unread > 0) {
    const reasons = p.undetermined?.reasons ?? [];
    parts.push(
      `${unread} open task(s) could NOT be evaluated (${
        reasons.length > 0 ? reasons.join(', ') : 'reason not reported'
      }) and are not counted healthy. Read them with list_tasks before treating this board as fine.`,
    );
  }
  const held = p.heldItems ?? [];
  if (held.length > 0) {
    const noun = held.length === 1 ? 'review item is' : 'review items are';
    parts.push(
      `${held.length} ${noun} HELD by the quality gate and off the reader's queue — ` +
        `${heldRowsClause(held)}. Get each filer to revise_review_item; nobody can answer a held ask.`,
    );
  }
  // Said in so many words, because the filer's natural move — answering on
  // the thread — changes nothing: two items sat off the queue 38 hours on
  // 2026-09-09 behind a line that said only how long the ticket was quiet.
  const asked = p.askedBack ?? [];
  if (asked.length > 0) {
    const noun = asked.length === 1 ? 'review item has' : 'review items have';
    parts.push(
      `${asked.length} ${noun} an unrevised question from a person and ${
        asked.length === 1 ? 'is' : 'are'
      } OFF their queue until revised — ${askedBackRowsClause(asked)}. ` +
        'A reply on the thread does not put an item back; only revise_review_item does, with the answer in its words.',
    );
  }
  // Its own sentence, because its remedy is the one nothing else here asks
  // for: somebody has to REPLY. The other person-shaped finding above is a
  // review item that needs revising; this one is a person who wrote on a doc
  // and has been met with silence, on a surface that may hang on no task, so
  // no row in this frame would ever mention it.
  const waiting = p.unanswered ?? [];
  if (waiting.length > 0) {
    const noun = waiting.length === 1 ? 'question' : 'questions';
    parts.push(
      `${waiting.length} ${noun} from a person on a doc ${
        waiting.length === 1 ? 'has' : 'have'
      } had NO agent reply — ${unansweredRowsClause(waiting)}. ` +
        'Answer it or give it to somebody who can; nothing else on this board is tracking it.',
    );
  }
  const ungated = p.ungatedUi ?? [];
  if (ungated.length > 0) {
    const noun = ungated.length === 1 ? 'UI task is' : 'UI tasks are';
    // A trunk read cannot say whose the change is, so it is not the builder's.
    const who = ungated.some((row) => row.from === 'trunk') ? 'its worktree' : 'its builder';
    parts.push(
      `${ungated.length} ${noun} being built past the review gate — an agent filed it, ${who} ` +
        'has changed a file a person looks at, and nobody answered a review item on it — ' +
        `${ungatedRowsClause(ungated)}. ` +
        'Only an answered review item clears it: file the item and hold the build, or say why the gate does not apply.',
    );
  }
  // The one finding here that reports something GOOD. Its remedy is to hand
  // the answer back to whoever was waiting on it — which is not what any
  // other sentence in this line asks for, and is why it is its own sentence
  // rather than a qualifier on the stall list that usually names the same
  // rows. It says nothing about how long the row has been quiet: the number
  // that matters is how long the ANSWER has been sitting there.
  const unresumed = p.unresumed ?? [];
  if (unresumed.length > 0) {
    const noun = unresumed.length === 1 ? 'task is' : 'tasks are';
    parts.push(
      `${unresumed.length} ${noun} unblocked with nothing done since — the answer ` +
        `${unresumed.length === 1 ? 'it was' : 'they were'} waiting on is already in, and nothing ` +
        `has touched ${unresumed.length === 1 ? 'it' : 'them'} since it landed: ` +
        `${unresumedRowsClause(unresumed)}. ` +
        'Restart each one or say why it is still blocked; the board has no record that anybody read the answer.',
    );
  }
  // The one finding here about a row that has somebody on it and is not yet
  // stalled. Its remedy is a message to that somebody, which no other sentence
  // in this line asks for, so it is its own sentence.
  //
  // What it does NOT do is name the server's window. `CW_CHECK_IN_MINUTES`
  // moves when this finding fires, and a sentence that said "over half an
  // hour" would be false on a board configured shorter — while every row
  // here already carries its own `quietMs`, which `stalledRowClause` renders
  // as "quiet 47m". So the observation is the rows' own numbers and nothing
  // else. The one duration stated out loud is the PROTOCOL's, which is 30
  // minutes wherever the plugin ships it: the skills ask for it and Home's
  // quiet pill draws it. That is the number the reader quotes at the holder,
  // and it does not move with the server's knob.
  const checkIn = p.checkIn ?? [];
  if (checkIn.length > 0) {
    const noun = checkIn.length === 1 ? 'task has' : 'tasks have';
    parts.push(
      `${checkIn.length} ${noun} somebody on ${checkIn.length === 1 ? 'it' : 'them'} who has gone ` +
        `quiet past the check-in window — ${stalledRowsClause(checkIn)}. Ask each holder for a ` +
        'line now: the protocol is an activity update every 30 minutes, even if it is ' +
        '"still on X, next Y".',
    );
  }
  // What this bundle could not read. Said LAST among the lists when there is
  // something else to say — the sentences above are work the reader can do
  // now, and this one is a caveat on how complete they are — and it becomes
  // the whole body when there is nothing else, where it replaces a sentence
  // that blamed the wake for the reader's own version.
  const unknown = unknownStallKeys(p);
  // Whether a FINDING rendered, read before the `changed` clause joins the
  // list. `changed` is news ABOUT findings rather than a finding, so letting
  // it stand in for one hid the whole notice: a frame with an unreadable list
  // and a renderable `changed` clause used to render as an ordinary wake that
  // mentioned neither the unreadable findings nor the plugin. Not reachable
  // against today's server — every `changed` sub-key mirrors a top-level list
  // that would have rendered — but that sentence was equally true of
  // `askedBack` before `unanswered` shipped, and it stayed true right up to
  // the day it was not.
  const renderedFindings = parts.length > 0;
  if (renderedFindings && unknown.length > 0) {
    parts.push(
      `This frame ALSO carried ${unknown.join(', ')}, which this plugin cannot read, so there is ` +
        'more on this board than the sentences above. Update the plugin ' +
        '(command claude plugin update claude-workspaces@claude-workspaces) and restart this session.',
    );
  }
  // Ahead of the lists, so a repeat says what moved before it says what to
  // drive. Empty on a first wake, where the whole frame is the news.
  const changed = changedClause(p.changed);
  if (changed) parts.unshift(changed);
  // After the unshift, so the news keeps the front of the body and the
  // no-subject sentence reads as the verdict on the rest of it.
  if (!renderedFindings) parts.push(unrenderableBody(unknown));
  const body = parts.join(' ');
  // FIRST, when it is there. The reader of an escalated wake is not the lead:
  // before it can weigh the rows it has to know that it is standing in, and
  // that the board's own addressee is unreachable — which is a finding of its
  // own, and the one nobody could see before.
  //
  // It says UNREACHABLE, never "gone" or "has not answered for N": the sender
  // knows only that the seat holder holds no stream right now, which a
  // reconnecting session also looks like. Deciding a session is dead takes
  // evidence over a window (`leadSeatHealth`), and this line is not where
  // that call is made.
  if (p.escalatedFrom !== undefined && p.escalatedFrom !== '') {
    return (
      `[workspace.stalled] You are not this board's lead — ${p.escalatedFrom} holds the seat and ` +
      'is not reachable, so this came to you instead. Nothing addressed to that seat is arriving: ' +
      'take it (attach_agent) or hand it to a session that is here. Then, on the board itself: ' +
      body
    );
  }
  // Then the fleet carry, which is the OTHER reason this reader holds no
  // stream on the board it is being told about. Never both: the redirect
  // above is the dead-board path and sets no carry, so if a server ever sends
  // the two together the reachability claim wins — a seat nobody holds is the
  // bigger fact, and it is the one whose remedy differs.
  if (p.unfiledCarry !== undefined) {
    return `[workspace.stalled] ${unfiledCarryLine(p.unfiledCarry)} ${body}`;
  }
  return `[workspace.stalled] ${body}`;
}

/**
 * The judge's reason as a CLAUSE — no trailing full stops — because every
 * line here continues after it. Without this the channel read "…'see
 * below'.. It has been held for 4m" and the lead's row read "…see below.;
 * and 2 more" (UX review, 2026-08-29).
 *
 * Spelled here rather than imported: this package publishes standalone and
 * does not depend on `@claude-workspaces/core`, whose `judgeReasonClause` is the same
 * rule for the server and the board.
 */
function judgeReasonClauseLocal(reason: string): string {
  return reason.trim().replace(/\.+$/, '').trimEnd();
}

/** One held item as the lead's line names it: the ask, the ticket, who filed
 *  it, how long it has been held, and the gap the judge named. */
function heldRowClause(row: HeldRowPayload): string {
  const ask = row.headline ? `"${truncate(row.headline, 50)}"` : (row.reviewItemId ?? 'an item');
  const on = row.title ? ` on "${truncate(row.title, 40)}"` : '';
  const id = row.id ? ` (${row.id})` : '';
  const by = row.filedBy ? ` filed by ${row.filedBy}` : '';
  const age = row.heldMs === undefined ? '' : ` held ${humanDuration(row.heldMs)}`;
  // The lead's remedy is to get the FILER to revise, and the two surfaces
  // take different arguments — so the call rides along rather than being
  // guessed from the row id.
  const how = row.revise ? `, revise with ${row.revise}` : '';
  // Trailing full stop off for the same reason as `reviewItemHeldLine` below:
  // these clauses are joined with "; ", so a reason that ends in one reads
  // "…see below.; and 2 more".
  const why = row.reason ? ` — ${truncate(judgeReasonClauseLocal(row.reason), 120)}` : '';
  return `${ask}${on}${id}${by}${age}${why}${how}`;
}

function heldRowsClause(rows: readonly HeldRowPayload[]): string {
  const shown = rows.slice(0, STALL_ROWS_SHOWN).map(heldRowClause);
  const rest = rows.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ');
}

/** One asked-back item: the ask, the ticket, who asked and how long ago, and
 *  the call that puts it back on the queue. */
function askedBackRowClause(row: AskedBackRowPayload): string {
  const ask = row.headline ? `"${truncate(row.headline, 50)}"` : (row.reviewItemId ?? 'an item');
  const on = row.title ? ` on "${truncate(row.title, 40)}"` : '';
  const id = row.id ? ` (${row.id})` : '';
  const who = row.askedBy ?? 'a person';
  const age = row.askedMs === undefined ? '' : ` ${humanDuration(row.askedMs)} ago`;
  const how = row.revise ? `, revise with ${row.revise}` : '';
  return `${ask}${on}${id}: ${who} asked${age}, off ${who}'s queue since${how}`;
}

function askedBackRowsClause(rows: readonly AskedBackRowPayload[]): string {
  const shown = rows.slice(0, STALL_ROWS_SHOWN).map(askedBackRowClause);
  const rest = rows.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ');
}

/** One waiting question: who asked, how long ago, what they said, where it
 *  is, and the call that answers it. */
function unansweredRowClause(row: UnansweredRowPayload): string {
  const who = row.askedBy ?? 'a person';
  const age = row.askedMs === undefined ? '' : ` ${humanDuration(row.askedMs)} ago`;
  const on = row.title ? ` on "${truncate(row.title, 40)}"` : '';
  const said = row.excerpt ? ` — "${truncate(row.excerpt, 60)}"` : '';
  const how = row.reply ? `, answer with ${row.reply}` : '';
  return `${who} asked${age}${on}${said}${how}`;
}

function unansweredRowsClause(rows: readonly UnansweredRowPayload[]): string {
  const shown = rows.slice(0, STALL_ROWS_SHOWN).map(unansweredRowClause);
  const rest = rows.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ');
}

/** One row past the UI gate: title, id, the changed file that made it UI
 *  work, and — when the row's own words agree — the matched word too. The
 *  file is what makes the finding checkable from the line itself; the word
 *  is what made dismissing the old prose-only false positives cheap, and it
 *  costs four characters to keep.
 *
 *  The file says which baseline it was read from, because the two are not
 *  the same claim. Read from the dispatch's pinned commit it is this task's
 *  work. Read from the trunk merge base it is everything committed in that
 *  checkout since, which includes whoever held it before, so the line says it
 *  cannot tell rather than handing the file to this builder. A frame from an
 *  older server names no baseline, and neither does the line. */
function ungatedRowClause(row: UngatedUiRowPayload): string {
  const title = row.title ? `"${row.title}" ` : '';
  const since =
    row.from === 'dispatch'
      ? 'changed since dispatch commit'
      : row.from === 'trunk'
        ? 'changed since trunk merge base, cannot tell this task\u2019s work from other work'
        : 'changed';
  const file = row.file ? `, ${since}: ${row.file}` : '';
  const word = row.keyword ? `, matched: ${row.keyword}` : '';
  return `${title}(${row.id}${file}${word})`;
}

function ungatedRowsClause(rows: readonly UngatedUiRowPayload[]): string {
  const shown = rows.slice(0, STALL_ROWS_SHOWN).map(ungatedRowClause);
  const rest = rows.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ');
}

/** One row whose blockage lifted: the row, WHICH event lifted it, how long
 *  ago, and what it said. The event is named rather than summarised because
 *  the reader's first move is to go and look at it — a finding that fires on
 *  a snapshot boundary and one that has stood for two days read identically
 *  otherwise. */
function unresumedRowClause(row: UnresumedRowPayload): string {
  const title = row.title ? `"${truncate(row.title, 40)}" ` : '';
  const ago = row.liftedMs === undefined ? '' : ` ${humanDuration(row.liftedMs)} ago`;
  const event =
    row.lift === 'done-when-met'
      ? `done-when line met${ago}`
      : row.lift === 'review-item-answered'
        ? `review item answered${ago}`
        : `unblocked${ago}`;
  const what = row.what ? `: "${truncate(row.what, 60)}"` : '';
  const next = row.next ? `, still open: "${truncate(row.next, 60)}"` : '';
  return `${title}(${row.id}, ${event}${what}${next})`;
}

function unresumedRowsClause(rows: readonly UnresumedRowPayload[]): string {
  const shown = rows.slice(0, STALL_ROWS_SHOWN).map(unresumedRowClause);
  const rest = rows.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; and ${rest} more` : shown.join('; ');
}

/**
 * Render `workspace.review_item_held` — the quality gate telling the FILER
 * that one of their items is off the reader's queue until they revise it.
 *
 * Two moments send it: the filing itself (the route's tool result already
 * said so; this is the same fact on the channel, for a session whose tool
 * result scrolled past) and the stall loop, once the hold has stood past the
 * window (`overdue`). The line carries the item id and the reason because
 * the reader's next act is one call with exactly those inputs.
 */
export function reviewItemHeldLine(p: ReviewItemHeldPayload): string {
  const ask = p.headline ? `"${truncate(p.headline, 60)}"` : 'a review item you filed';
  const on = p.title ? ` on "${truncate(p.title, 40)}"` : '';
  const ids = p.taskId
    ? p.reviewItemId
      ? ` (taskId ${p.taskId}, reviewItemId ${p.reviewItemId})`
      : ''
    : p.docId && p.threadId && p.commentId
      ? ` (docId ${p.docId}, threadId ${p.threadId}, commentId ${p.commentId})`
      : '';
  const why = p.reason ? ` — ${judgeReasonClauseLocal(p.reason)}` : '';
  const stood =
    p.overdue === true
      ? ` It has been held${p.heldMs === undefined ? '' : ` for ${humanDuration(p.heldMs)}`} and the reader still cannot see it.`
      : '';
  // The exact call, when the server spelled one. A comment-borne item and a
  // ticket item take different arguments, so "call revise_review_item" alone
  // is an instruction the filer can carry out wrongly.
  const fix = p.revise
    ? `Fix the gap named and call ${p.revise} now; it is judged again on every revision.`
    : 'Fix the gap named and call revise_review_item now; it is judged again on every revision.';
  return `[workspace.review_item_held] your review item ${ask}${on}${ids} was held off the queue by the quality gate${why}.${stood} ${fix}`;
}
