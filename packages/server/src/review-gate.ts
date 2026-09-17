/**
 * The review-item quality gate.
 *
 * ONE module because "judged, then announced, in that order" is the rule the
 * whole family exists to keep. A declaration can be filed on a TICKET or on a
 * COMMENT; both land in the same reader's queue, so both go through the same
 * judge, and a push whose title is the item's headline must never be sent for
 * an item that queue omits. `announceReviewItem` arrives in the context
 * rather than being called from the routes, so the ordering is the shape of
 * this file rather than a convention two callers have to remember.
 *
 * Lifted verbatim out of `createServer`. Every collaborator arrives in
 * `ReviewGateContext` rather than being captured from that closure,
 * following `task-routes-context.ts`.
 */
import {
  type ReviewItemJudgement,
  type ReviewPayload,
  type TaskReviewItem,
  type Thread,
  type User,
  isReviewItemHeld,
  isReviewPayloadHeld,
  judgeReasonClause,
  latestThreadedQuestion,
  locateReviewItemRange,
  readTaskReviewItem,
  reviewItemState,
  reviewPayloadVersion,
} from '@claude-workspaces/core';
import {
  boundHoldWords,
  holdCountWord,
  holdGapKey,
  judgedText,
} from '@claude-workspaces/core/review-hold';
import type { DocStore } from './doc-store.ts';
import { taskDeepLink } from './home-brief.ts';
import type { ReviewGate, ThreadReviewGate } from './review-gate-types.ts';
import {
  admittedLessSpecificMessage,
  admittedUnjudgedMessage,
  holdMessage,
} from './review-hold-message.ts';
import { linkHoldReason } from './review-items/link-check.ts';
import { type PriorAskRow, priorAsksFor } from './review-items/prior-asks.ts';
import type { ReviewJudge, ReviewJudgeVerdict } from './review-judge.ts';
import type { SseBus } from './sse.ts';
import type { HeldItemInput } from './stall-gate.ts';
import { REVIEW_ITEM_HELD_EVENT, type ReviewItemHeldFrame } from './stall-nudge.ts';
import type { TaskProjection } from './task-projection.ts';
import {
  LEGACY_REVIEW_ITEM_ID,
  type Task,
  type TaskStore,
  reviewItemVersion,
  wordsRevisionOf,
} from './tasks.ts';

/**
 * How many times the gate may hold ONE item before it admits it anyway.
 *
 * Two, because two is the most a check can ask for and still be a check: the
 * filer files, is told the gap, and fixes it. A third round is where a gate
 * stops being read as feedback — a peer whose decision item was held eight
 * times with a different reason each round gave up and posted the ask as a
 * plain comment, which is precisely the outcome the gate exists to prevent
 * (2026-09-04).
 *
 * The item is not silently waved through: it reaches the reader carrying the
 * gate's FIRST concern, which is the one thing the judge cannot have
 * contradicted later.
 */
export const REVIEW_GATE_MAX_HOLDS = 2;

/**
 * How long a hold may stand UNREVISED before the item reaches the reader's
 * queue as filed.
 *
 * One hour (owner, 2026-09-14). The cap above ends a hold its filer keeps
 * revising; nothing ended one its filer never came back to — an urgency
 * question sat off the queue for two days, told to a filer that had moved
 * on. A hold is a judge's opinion about words, and a question the reader
 * never sees is worse than one they find a little rough. Revising inside the
 * hour is still judged again, and a revision's verdict restarts the clock
 * because it stamps a fresh `judge.at`.
 */
export const REVIEW_GATE_RELEASE_MS = 60 * 60_000;

/**
 * WHERE a held item lives, and therefore how its filer addresses the fix.
 *
 * Two surfaces file review items and both are gated, so the hold has to be
 * able to name either address. A hold whose message points at the wrong
 * verb is a dead end — the item sits off the queue, the stall loop
 * complains at five minutes, and the filer cannot comply — which is
 * exactly the objection that kept the thread path ungated until
 * `revise_review_item` grew its doc form.
 */
export type ReviewGateAddress =
  | { kind: 'task'; taskId: string; reviewItemId: string }
  | { kind: 'thread'; docId: string; threadId: string; commentId: string }
  // The ticket's OWN decision — a row that IS the question rather than one
  // carrying it. It has no item id to name (`legacyReviewItem` derives it
  // at read time under the fixed `r-legacy`, which is the same string on
  // every such ticket), so the address is the ticket, and
  // `revise_review_item` takes it with `reviewItemId` omitted — the shape
  // `answer_decision` has always used for the same row.
  | { kind: 'decision'; taskId: string };

/** The long-lived collaborators the gate reads. */
export interface ReviewGateContext {
  /** Doc store — a comment-borne declaration is judged and stamped on one. */
  docStore: DocStore;
  /** The board store — the tickets, their items and the board's criteria. */
  taskStore: TaskStore;
  /** The ydoc projection, refreshed after a verdict the store does not emit. */
  taskProjection: TaskProjection;
  /** The event bus a held-item frame is pushed down. */
  sse: SseBus;

  /**
   * The one `ServerOptions` field this module reads.
   *
   * Structural on purpose, the way `WorkspaceRoutesContext` narrows its own:
   * naming `ServerOptions` here would make a collaborator import a type out
   * of server.ts, which imports this module back.
   */
  opts: { reviewJudge?: ReviewJudge };

  /** JSON response helper — status plus body, no CORS. */
  j: (status: number, body: unknown) => Response;

  /** This server's externally reachable origin, as links are minted from. */
  externalBaseUrl: () => string;
  /** Where a thread opens, or undefined when it has no reachable URL. */
  threadUrl: (docId: string, isVisitor: boolean) => string | undefined;
  /** The board a doc belongs to, or null when none holds it. */
  resolveWorkspaceForDoc: (docId: string) => string | null;
  /** Tell every enrolled device an item landed — see push-announce.ts. It
   *  arrives here, and is called from here, so a held item cannot be
   *  announced by a caller that forgot to ask the gate first. */
  announceReviewItem: (input: {
    ask: string;
    context: string;
    askedBy: string;
    url: string | undefined;
    key: string;
  }) => void;
}

/**
 * Build the gate once per server.
 *
 * `warnedJudgeThrew` lives inside, so a thrown judge is named once per server
 * rather than once per item — which is what it was as a `let` in the
 * `createServer` closure.
 */
export function createReviewGate(ctx: ReviewGateContext) {
  const {
    docStore,
    taskStore,
    taskProjection,
    sse,
    opts,
    j,
    externalBaseUrl,
    threadUrl,
    resolveWorkspaceForDoc,
    announceReviewItem,
  } = ctx;
  /** Where a comment-borne review item opens. A task discussion opens the
   *  TICKET — the board reveals the thread from its own state — while a doc
   *  thread opens the doc at the comment rather than at its top. */
  function reviewThreadLink(docId: string, threadId: string): string | undefined {
    const base = threadUrl(docId, false);
    if (!base) return undefined;
    if (docId.startsWith('task:')) return base;
    return `${base}?thread=${encodeURIComponent(threadId)}`;
  }

  /** What the reader is being asked ABOUT: the ticket's title for a task
   *  discussion, the doc's label otherwise. Same choice `reviewThreadItems`
   *  makes when it builds the queue row. */
  function reviewThreadContext(docId: string): string {
    if (docId.startsWith('task:')) {
      const task = taskStore.getTask(docId.slice('task:'.length));
      if (task) return task.title;
    }
    return docStore.peekMeta(docId)?.title ?? 'A document';
  }

  /** One spelling of "a declaration just landed on a comment", for the three
   *  routes that can carry one. */
  function announceThreadReview(
    docId: string,
    threadId: string,
    review: ReviewPayload,
    author: User,
  ): void {
    announceReviewItem({
      ask: review.headline,
      context: reviewThreadContext(docId),
      askedBy: author.name,
      url: reviewThreadLink(docId, threadId),
      key: `${docId}:${threadId}`,
    });
  }

  /**
   * The comment a just-written declaration landed on.
   *
   * The write routes hand back the whole THREAD, not the comment, so the id
   * the gate addresses has to be recovered from it. Newest-first and matched
   * on the payload's own identity — a thread can already carry other
   * declarations, and holding the wrong one would take somebody else's live
   * ask off the queue.
   */
  function commentBearing(thread: Thread, review: ReviewPayload): string | undefined {
    for (let i = thread.comments.length - 1; i >= 0; i--) {
      const c = thread.comments[i];
      if (c?.review === review || (c?.review && c.review.headline === review.headline)) {
        return c.id;
      }
    }
    return undefined;
  }

  /**
   * The hold on a declaration, read back off what is STORED.
   *
   * For the deduplicated request, which never ran the filing closure and so
   * holds no gate of its own while the first request's verdict is already on
   * the comment. Answering that request without `held` would tell a retrying
   * client its filing was accepted and leave it waiting on a reader who
   * cannot see the item (codex review). Both callers await the same closure,
   * so by the time this runs the verdict is recorded.
   *
   * `undefined` for anything that is not a live hold — no declaration, no
   * recoverable comment, a verdict that passed.
   */
  function recordedThreadHold(
    docId: string,
    thread: Thread,
    review: ReviewPayload | undefined,
  ): ThreadReviewGate | undefined {
    if (!review) return undefined;
    const commentId = commentBearing(thread, review);
    if (commentId === undefined) return undefined;
    const stored = thread.comments.find((c) => c.id === commentId)?.review;
    if (!stored || !isReviewPayloadHeld(stored) || stored.judge === undefined) return undefined;
    const reason = stored.judge.reason;
    return {
      held: true,
      review: stored,
      reason,
      message: heldMessage({ kind: 'thread', docId, threadId: thread.id, commentId }, reason),
    };
  }

  /**
   * File a comment-borne declaration through the gate, then announce it only
   * if it passed.
   *
   * ONE funnel for the routes that can write one — `create_thread`,
   * `threads/by_find`, `post_reply` — because "judged, then announced, in
   * that order" is the rule that keeps a held item off every surface at
   * once. A push whose title is the item's headline says "here is something
   * to review"; sending it for an item the reader's queue omits is the exact
   * lie the gate exists to prevent.
   *
   * A comment whose id cannot be recovered is announced unjudged, which is
   * the same fail-open answer every other judge failure gets.
   */
  async function gateThreadDeclaration(
    docId: string,
    thread: Thread,
    review: ReviewPayload,
    author: User,
  ): Promise<ThreadReviewGate> {
    const commentId = commentBearing(thread, review);
    if (commentId === undefined) {
      announceThreadReview(docId, thread.id, review, author);
      return { held: false, review };
    }
    const gate = await judgeThreadReview(docId, thread.id, commentId, review, author);
    if (!gate.held) announceThreadReview(docId, thread.id, gate.review, author);
    return gate;
  }

  /** The same, for a declaration that hangs on a TICKET rather than a
   *  comment. Both land in the reviewer's queue, so both are announced. */
  function announceTaskReview(task: Task, item: TaskReviewItem, author: User): void {
    announceReviewItem({
      ask: item.review.headline,
      context: task.title,
      askedBy: author.name,
      url: `${externalBaseUrl()}${taskDeepLink(task.workspaceId, task.id)}`,
      key: `${task.id}:${item.id}`,
    });
  }

  /** The paste-ready call that ends a hold, per surface. One spelling, used by
   *  the tool result, the filer's wake and the stall report alike — three
   *  copies of an address is how one of them ends up naming a verb that
   *  refuses. */
  function reviseCallFor(address: ReviewGateAddress): string {
    switch (address.kind) {
      case 'task': {
        // A done-when check is the server's template over a line, so the
        // builder's next REPORT is what changes its words — a revision of the
        // item would be written over by the next sync.
        const lineId = ownerLineOf(address);
        if (lineId !== undefined) {
          return `report_done_when(taskId="${address.taskId}", lines=[{id: "${lineId}", verdict: "met" or "owner", proof: [{text, url}]}])`;
        }
        return `revise_review_item(taskId="${address.taskId}", reviewItemId="${address.reviewItemId}")`;
      }
      case 'decision':
        return `revise_review_item(taskId="${address.taskId}")`;
      default:
        return `revise_review_item(docId="${address.docId}", threadId="${address.threadId}", commentId="${address.commentId}")`;
    }
  }

  /**
   * The one sentence a reader is given about an item the gate stopped
   * holding — never a fresh reason.
   *
   * It quotes the FIRST hold, deliberately. That reason is the only one in
   * the history the judge cannot have contradicted with a later one, and
   * repeating it is what makes "we stopped holding this" a statement about a
   * standing concern rather than a fourth opinion.
   */
  function admittedReason(heldFor: string[]): string {
    // The clause form — the judge's own words with the trailing full stop
    // taken off, so the sentence built around them has exactly one.
    const first = judgeReasonClause(heldFor[0] ?? '');
    const held = `held ${holdCountWord(heldFor.length)}`;
    if (first === '')
      return `Admitted to the queue unjudged after being ${held}; nobody judged these words good.`;
    return `Admitted to the queue unjudged after being ${held}; the standing concern is unchanged — ${first}.`;
  }

  /** The done-when line a ticket item checks, when it is an owner check. */
  function ownerLineOf(address: ReviewGateAddress): string | undefined {
    if (address.kind !== 'task') return undefined;
    return taskStore.getTask(address.taskId)?.reviews?.find((r) => r.id === address.reviewItemId)
      ?.doneWhenLineId;
  }

  /**
   * What a filing route says when the gate held the item — composed in
   * `review-hold-message.ts`, which is where the wording and its test live.
   *
   * This function's only job is to supply the four facts the wording needs
   * that only the gate knows: where the item lives, whether it is an owner
   * check, and the hold count. It supplies NO words of its own, which is what
   * keeps "a hold invents nothing" a property one test can check.
   */
  function heldMessage(
    address: ReviewGateAddress,
    reason: string,
    quote?: string,
    /** How many holds this item now carries, THIS one included. */
    holds = 0,
  ): string {
    return holdMessage({
      reason,
      ...(quote !== undefined ? { quote } : {}),
      reviseCall: reviseCallFor(address),
      ownerCheck: ownerLineOf(address) !== undefined,
      surface: address.kind === 'thread' ? 'thread' : 'ticket',
      holds,
      maxHolds: REVIEW_GATE_MAX_HOLDS,
    });
  }

  /** Process-wide: a judge that throws is named once, not once per filing. */
  let warnedJudgeThrew = false;

  /**
   * One review item as the gate needs to see and write it — the seam that
   * lets a TICKET item and a COMMENT-borne one run the same gate.
   *
   * It exists because "gated" must not become two rules. The gate shipped for
   * the ticket form alone, and the fleet rule tells every peer to file asks
   * with `create_thread(review=…)` — so the documented path reached the
   * reader's queue with the judge called zero times, and the confidence the
   * gate produced was confidence it had not earned. A second implementation
   * for the second surface would have re-created that gap one drift at a
   * time; this way there is one order of operations, one failure policy, and
   * one shape of hold, and a route only says where the words live.
   *
   * `T` is the surface's own row — a `TaskReviewItem` or a bare
   * `ReviewPayload` — so a caller gets back the thing it already holds.
   */
  interface ReviewGateTarget<T> {
    workspaceId: string;
    /** How the filer addresses the fix. See `ReviewGateAddress`. */
    address: ReviewGateAddress;
    /** The ticket's or the doc's name — what the wake calls the thing the
     *  item hangs on. */
    title: string;
    /** The row as it stands NOW, re-read from the store. `undefined` means it
     *  has gone. */
    current: () => T | undefined;
    words: (row: T) => ReviewPayload;
    version: (row: T) => number;
    held: (row: T) => boolean;
    judgement: (row: T) => ReviewItemJudgement | undefined;
    /** Conditionally stamp a verdict — refuses on `stale`, on an answered
     *  row, and on a row that has gone. */
    record: (
      judgement: ReviewItemJudgement,
      opts: { forVersion?: number; forPendingAt?: number },
    ) => { ok: true; row: T } | { ok: false };
    /** Whatever the surface must do once a verdict is durable — refresh the
     *  projection, broadcast, both. Called only on a write that landed. */
    settled: (row: T) => void;
    /** The item hands over a done-when line — see `ReviewJudgeItem.ownerCheck`. */
    ownerCheck?: boolean;
  }

  type GateOutcome<T> =
    // `message` on a PASS is not decoration: it is how a filer is told the
    // item reached the reader without the judge passing it. Absent on the
    // ordinary pass, where there is nothing to say.
    | { held: false; row: T; message?: string }
    | { held: true; row: T; reason: string; message: string };

  /** Whether the ids a relative link names actually exist here. */
  const linkTargets = {
    boardExists: (id: string) => taskStore.getWorkspace(id) !== undefined,
    taskExists: (id: string) => taskStore.getTask(id) !== undefined,
    docExists: (id: string) => docStore.docExists(id),
  };

  /**
   * The row an address hangs on, for the prior-ask gather.
   *
   * A thread on a ticket's BODY DOC is a question on that ticket, not on some
   * separate document — `task:<id>` is the ticket's own doc id — so it
   * resolves to the same row the ticket channel does. That equivalence is the
   * whole point: it is what lets one channel see what the other asked.
   */
  function priorAskRowFor(address: ReviewGateAddress): PriorAskRow {
    if (address.kind === 'task') {
      return { kind: 'task', taskId: address.taskId, exceptItemId: address.reviewItemId };
    }
    if (address.kind === 'decision') return { kind: 'task', taskId: address.taskId };
    const taskId = address.docId.startsWith('task:') ? address.docId.slice('task:'.length) : '';
    return taskId === ''
      ? { kind: 'doc', docId: address.docId, exceptCommentId: address.commentId }
      : { kind: 'task', taskId, exceptCommentId: address.commentId };
  }

  /**
   * What a REVISE may say to the gate beyond the words themselves.
   *
   * One field, and it exists because of what the gate was measured teaching:
   * every hold asked for a concrete specific, so a fabricated specific read
   * as more responsive than a vague truth and the revision loop selected for
   * invention. The filer needs a way to say "the source does not support
   * that", and it has to be an answer the gate ACCEPTS, or it is not an
   * answer at all.
   */
  interface GateRunOpts {
    /** The filer's own words for why the honest answer is less specific than
     *  the hold asked for. Only acted on when the item is currently held —
     *  on an unheld item there is no hold to answer, and honouring it there
     *  would be a one-field bypass of a gate nobody had raised. */
    lessSpecific?: string;
  }

  /**
   * Put a filed or revised review item through the quality gate — the ONE
   * implementation, whichever surface the item was filed on.
   *
   * ONE call, no retries, and every failure is a pass: no judge configured,
   * a judge that answers `null`, a judge that throws — the item goes through
   * and the record says `unavailable` (Bryan, 2026-08-29: don't refuse; never
   * block on the judge being down). A hold records the verdict on the item,
   * keeps it off the queue (`review-queue.ts` skips a gated row on either
   * surface), and wakes the FILER — addressed, the way `review_answered`
   * wakes the lead — with which item, why, and the exact call that lifts it.
   * The lead is not told here: an item held for five minutes reaches the lead
   * through the stall loop.
   *
   * Returns the row as recorded, so a route hands back the verdict it just
   * made rather than the pre-judgement row.
   */
  async function runReviewGate<T>(
    target: ReviewGateTarget<T>,
    row: T,
    author: { id: string; name: string; kind?: string },
    /** The filer's answer to a hold that asked for a specific their source
     *  does not carry — see `GateRunOpts`. */
    runOpts: GateRunOpts = {},
  ): Promise<GateOutcome<T>> {
    const judge = opts.reviewJudge;
    const criteria = taskStore.reviewItemCriteria(target.workspaceId);
    if (!judge || !criteria) {
      // Gate off. An UNHELD item is left unjudged, as before the gate
      // existed. A held one — held by a judge that has since been turned
      // off or lost its key — is released on this revision, or it would
      // stay off the reader's queue with nothing left that could clear it
      // (codex review).
      if (!target.held(row)) return { held: false, row };
      const released = target.record(
        { at: Date.now(), verdict: 'unavailable', reason: 'the judge is off' },
        {},
      );
      if (released.ok) target.settled(released.row);
      return { held: false, row: released.ok ? released.row : row };
    }
    // The words this verdict will be about. A revision landing while the
    // judge is out gets its own call; this one's verdict must not be
    // stamped onto words it never read (codex review).
    const forVersion = target.version(row);
    // Every reason this item has been held for already. Read off the ROW, so
    // it survives the revision that produced this call: the gate is a check
    // and not a wall precisely because this number stops growing.
    const priorJudgement = target.judgement(row);
    const heldFor = priorJudgement?.heldFor ?? [];
    // How the item got to the reader, when it did not get there by passing.
    // Carried forward on every later verdict for the same reason `heldFor`
    // is: an item that reached the reader unjudged is still one that reached
    // the reader unjudged, whatever a later revision says.
    const carriedAdmission: Pick<
      ReviewItemJudgement,
      'admitted' | 'lessSpecific' | 'lessSpecificFor'
    > = {
      ...(priorJudgement?.admitted !== undefined ? { admitted: priorJudgement.admitted } : {}),
      ...(priorJudgement?.lessSpecific !== undefined
        ? { lessSpecific: priorJudgement.lessSpecific }
        : {}),
      ...(priorJudgement?.lessSpecificFor !== undefined
        ? { lessSpecificFor: priorJudgement.lessSpecificFor }
        : {}),
    };
    // The filer answered the hold by saying the source does not support what
    // it asked for.
    //
    // It does NOT skip the judge, and that is the whole shape of this. A
    // `revise` carrying the note also carries new words — the route refuses a
    // revision that changes nothing — so admitting here would let any content
    // at all reach the reader unjudged behind a sentence about a source
    // (codex review). Instead the note is recorded as the gap it answers, the
    // new words are judged like any others, and the ONE thing the note buys
    // is that this gap will not be held again: when the judge comes back
    // making the same demand, `answeredAgain` below admits it. Anything else
    // the judge finds in the new words is a hold, exactly as before.
    const lessSpecific = runOpts.lessSpecific?.trim();
    if (lessSpecific !== undefined && lessSpecific !== '' && target.held(row)) {
      carriedAdmission.lessSpecific = lessSpecific;
      // The standing hold is the gap it answers. Absent — a held row with no
      // stored reason — leaves the note on the record with nothing exempted,
      // which is the safe direction.
      if (priorJudgement?.gapKey !== undefined) {
        carriedAdmission.lessSpecificFor = priorJudgement.gapKey;
      }
    }
    // Off the queue from THIS moment, not from the verdict: the item is
    // already in the store, and the seconds the judge takes were seconds the
    // reader could see — and answer — an item about to be held (codex
    // review). `pending` is what the queue reads meanwhile; the ticket says
    // nothing about it.
    const pendingAt = Date.now();
    target.record(
      {
        at: pendingAt,
        verdict: 'pending',
        reason: 'being judged',
        ...(heldFor.length > 0 ? { heldFor } : {}),
        ...carriedAdmission,
      },
      { forVersion },
    );
    const words = target.words(row);
    /**
     * The deterministic half, and it runs FIRST — a link that goes nowhere is
     * a fact, and spending a model call to have it described back is both
     * slower and less certain than checking it. When it fires the judge is
     * not called at all: the item has one gap, it is named, and naming a
     * second one in the same breath is what the single-biggest-gap rule
     * exists to stop.
     *
     * Only while the gate is ON. The branch above releases held items when
     * the judge is off, so a hold placed here in that state would be a hold
     * with nothing left that could lift it.
     */
    const linkReason = linkHoldReason(words.detail, linkTargets);
    let verdict: ReviewJudgeVerdict | null = null;
    if (linkReason !== undefined) {
      verdict = { ok: false, reason: linkReason };
    } else {
      // What the reader still has open on this row, down BOTH channels —
      // never an answered ask (see `prior-asks.ts`). Gathered at judging time
      // rather than at filing time, so a revision is judged against what is
      // open now: a question answered while this item sat held stops
      // counting against it. Inside this
      // branch because a held link means no judge call, so no prompt to fill.
      const priorAsks = priorAsksFor(
        priorAskRowFor(target.address),
        {
          getTask: (id) => taskStore.getTask(id),
          listThreads: (id) => docStore.listThreads(id),
        },
        Date.now(),
      );
      try {
        verdict = await judge({
          criteria: criteria.value,
          item: {
            headline: words.headline,
            ...(words.detail !== undefined ? { detail: words.detail } : {}),
            ...(words.options !== undefined ? { options: words.options } : {}),
            // The fields a secret ask asks for — see `ReviewJudgeItem.secrets`.
            // Names only; there is no value anywhere on this side to send.
            ...(words.secrets !== undefined ? { secrets: words.secrets } : {}),
            ...(heldFor.length > 0 ? { priorHolds: heldFor } : {}),
            ...(priorAsks.length > 0 ? { priorAsks } : {}),
            ...(target.ownerCheck ? { ownerCheck: true } : {}),
          },
        });
      } catch (err) {
        if (!warnedJudgeThrew) {
          warnedJudgeThrew = true;
          console.error(
            '[review-gate] judge threw; items pass through:',
            err instanceof Error ? err.message : err,
          );
        }
        verdict = null;
      }
    }
    const at = Date.now();
    const carried = { ...(heldFor.length > 0 ? { heldFor } : {}), ...carriedAdmission };
    // The hold's words, with everything the judge could not have known taken
    // out: a quote the item does not contain is dropped, and a diagnosis
    // carrying a figure the item never states is replaced whole. The judge is
    // never shown the SOURCE an item was written from, so any specific it
    // supplies is one it invented — which is what four live cards were
    // carrying on 2026-09-14.
    const bounded =
      verdict !== null && !verdict.ok
        ? boundHoldWords(
            {
              reason: verdict.reason,
              ...(verdict.quote !== undefined ? { quote: verdict.quote } : {}),
            },
            judgedText({
              headline: words.headline,
              ...(words.detail !== undefined ? { detail: words.detail } : {}),
              ...(words.options !== undefined ? { options: words.options } : {}),
            }),
          )
        : undefined;
    /**
     * A judge that could not answer must not ADMIT a held item.
     *
     * Fail-open is Bryan's rule and it stands: an item nobody has judged
     * goes through when the judge is down. But an item already HELD is a
     * different fact, and releasing it on a failed call made every hold
     * clearable by revising until a call timed out or a reply truncated.
     * So a failure keeps the standing verdict, stamp and history exactly as
     * they were — the hold's own clock does not restart either, or a judge
     * failing repeatedly would hide the item from the stall monitor forever.
     */
    const restoredHold =
      verdict === null && priorJudgement?.verdict === 'held' ? priorJudgement : undefined;
    // The cap. A third hold is not placed: the item goes to the reader with
    // the concern the gate has been making all along, and the reader decides
    // whether it is answerable. Two rounds is a check; a third is the wall
    // the peer walked into, and a gate that can refuse forever is a gate
    // agents route around.
    //
    // The gap the filer already answered with "the source is less specific
    // than that" is admitted here too, and for a stronger reason: they have
    // said in their own words that the specific the gate wants does not exist
    // to be written, so asking again is the gate repeating a demand it has
    // been told cannot be met. THAT GAP ONLY: a wider rule would let one note
    // admit every later verdict for the life of the item, so a revision that
    // introduced an unrelated defect would reach the reader with nobody
    // having looked (codex review).
    //
    // Matched on `holdGapKey` of the judge's RAW sentence, which is what was
    // keyed when the note was given. Neither end of this comparison can be
    // the stored reason: that one is replaced by a single constant whenever
    // the diagnosis carried an invented figure, so every such hold would
    // share one identity and one answered gap would exempt every later
    // numeric concern (codex review).
    const gapKey = verdict !== null && !verdict.ok ? holdGapKey(verdict.reason) : undefined;
    const answeredAgain =
      gapKey !== undefined &&
      carriedAdmission.lessSpecificFor !== undefined &&
      gapKey === carriedAdmission.lessSpecificFor;
    const admitAfterHolds =
      verdict !== null && !verdict.ok && (heldFor.length >= REVIEW_GATE_MAX_HOLDS || answeredAgain);
    const judgement: ReviewItemJudgement =
      restoredHold !== undefined
        ? { ...restoredHold }
        : verdict === null
          ? {
              at,
              verdict: 'unavailable' as const,
              reason: 'the judge could not answer',
              ...carried,
            }
          : admitAfterHolds
            ? {
                at,
                verdict: 'ok' as const,
                reason: admittedReason(heldFor),
                ...carried,
                // Not "passed": nobody judged these words good, the gate
                // simply stopped asking. The message the filer gets back says
                // which; the reader's card deliberately does not (Bryan,
                // 2026-09-16). An item already admitted
                // keeps HOW it got through: running out of holds afterwards
                // does not rewrite the filer's note into a wall they hit.
                admitted: answeredAgain
                  ? ('less-specific' as const)
                  : (carriedAdmission.admitted ?? ('holds' as const)),
              }
            : verdict.ok
              ? { at, verdict: 'ok' as const, reason: verdict.reason, ...carried }
              : {
                  at,
                  verdict: 'held' as const,
                  reason: bounded?.reason ?? verdict.reason,
                  heldFor: [...heldFor, bounded?.reason ?? verdict.reason],
                  // Which gap this is, so a `lessSpecific` answer to it can be
                  // matched when the judge makes the same demand again.
                  ...(gapKey !== undefined ? { gapKey } : {}),
                  ...(bounded?.quote !== undefined ? { quote: bounded.quote } : {}),
                  ...carriedAdmission,
                };
    const recorded = target.record(judgement, {
      forVersion,
      // Also refused if the reader overruled the gate while we were out: a
      // release does not change the item's words, so the version still
      // matches and only the pending stamp tells us the row moved under us
      // (codex review).
      forPendingAt: pendingAt,
    });
    // A row the store would not stamp (answered under us, revised under us,
    // or the derived legacy row) is left exactly as it was. For a stale
    // verdict the revision's own judgement is the one that stands — so the
    // gate state handed back is read off the row as it is NOW, which may be
    // a hold the newer call just placed (codex review): saying "passed"
    // here would announce to the reader an item the queue still omits.
    if (!recorded.ok) {
      const current = target.current();
      if (current !== undefined && target.held(current)) {
        const reason = target.judgement(current)?.reason ?? '';
        return {
          held: true,
          row: current,
          reason,
          message: heldMessage(
            target.address,
            reason,
            target.judgement(current)?.quote,
            target.judgement(current)?.heldFor?.length ?? 0,
          ),
        };
      }
      return { held: false, row: current ?? row };
    }
    // The projection carries `judge`, so the card can say "Held: …".
    target.settled(recorded.row);
    if (judgement.verdict !== 'held') {
      // The last-hold rule used to fire in silence: the filer read a 200 with
      // no `held` and saw an item that had passed. It had not.
      if (!admitAfterHolds) return { held: false, row: recorded.row };
      return {
        held: false,
        row: recorded.row,
        // Which sentence depends on WHY the gate stopped holding: the filer
        // who answered with a note is told their note still stands, and the
        // filer who ran out of rounds is told nobody judged these words.
        message:
          judgement.admitted === 'less-specific'
            ? admittedLessSpecificMessage()
            : admittedUnjudgedMessage(heldFor.length),
      };
    }
    const address = target.address;
    const frame: ReviewItemHeldFrame = {
      event: REVIEW_ITEM_HELD_EVENT,
      workspaceId: target.workspaceId,
      ...(address.kind === 'thread'
        ? { docId: address.docId, threadId: address.threadId, commentId: address.commentId }
        : { taskId: address.taskId }),
      revise: reviseCallFor(address),
      title: target.title,
      reviewItemId:
        address.kind === 'task'
          ? address.reviewItemId
          : address.kind === 'decision'
            ? LEGACY_REVIEW_ITEM_ID
            : address.commentId,
      headline: words.headline,
      reason: judgement.reason,
      ts: at,
    };
    sse.sendToAgent(`ws~${target.workspaceId}`, author.id, { ...frame });
    return {
      held: true,
      row: recorded.row,
      reason: judgement.reason,
      message:
        // A restored hold is not a new verdict on the new words, and saying
        // so is the difference between "you did not fix it" and "nobody
        // looked". The filer's next act is the same call either way.
        (restoredHold
          ? 'The judge could not answer, so this stays held on its standing verdict. '
          : '') +
        heldMessage(address, judgement.reason, judgement.quote, judgement.heldFor?.length ?? 0),
    };
  }

  /**
   * The gate for an item filed on a TICKET — `add_review_item`, a `review`
   * on `create_tasks`, and every `revise_review_item` that follows.
   */
  async function judgeReviewItem(
    task: Task,
    item: TaskReviewItem,
    author: { id: string; name: string; kind?: string },
    runOpts: GateRunOpts = {},
  ): Promise<ReviewGate> {
    const out = await runReviewGate<TaskReviewItem>(
      {
        workspaceId: task.workspaceId,
        address: { kind: 'task', taskId: task.id, reviewItemId: item.id },
        title: task.title,
        current: () => {
          const raw = taskStore.getTask(task.id)?.reviews?.find((r) => r.id === item.id);
          return raw ? readTaskReviewItem(raw) : undefined;
        },
        words: (row) => row.review,
        version: (row) => reviewItemVersion(row),
        held: (row) => isReviewItemHeld(row),
        judgement: (row) => row.judge,
        record: (judgement, o) => {
          const res = taskStore.recordReviewJudgement(task.id, item.id, judgement, {
            actor: author,
            ...(o.forVersion !== undefined ? { forVersion: o.forVersion } : {}),
            ...(o.forPendingAt !== undefined ? { forPendingAt: o.forPendingAt } : {}),
          });
          return res.ok ? { ok: true, row: res.item } : { ok: false };
        },
        settled: () => taskProjection.refreshTask(task),
        ...(ownerLineOf({ kind: 'task', taskId: task.id, reviewItemId: item.id }) !== undefined
          ? { ownerCheck: true }
          : {}),
      },
      item,
      author,
      runOpts,
    );
    return out.held
      ? { held: true, item: out.row, reason: out.reason, message: out.message }
      : { held: false, item: out.row, ...(out.message ? { message: out.message } : {}) };
  }

  /**
   * The gate for a ticket that IS the decision — `needs: 'decision'` with the
   * question in its own title and body, filed by `create_tasks` (single or
   * batch) and rewritten by every door that moves those words.
   *
   * The third surface, and the one the ticket for this work was written
   * about: a decision ticket reaches the reader's queue as the derived
   * `r-legacy` row, so before this it was the one filing path that put a row
   * in front of Bryan with the judge never called.
   *
   * Identical to the other two in everything a filer can observe — same
   * judge, same criteria, same fail-open policy, same `held` / `heldReason` /
   * `message`, same `workspace.review_item_held` wake. Two things differ, and
   * both follow from the row having no item of its own:
   *
   *  - the address is the TICKET (`revise_review_item(taskId=…)`), because
   *    there is no `reviewItemId` — minting one would make the ticket's own
   *    decision a second, competing row beside itself;
   *  - the version is `wordsRevisionOf`, not a count of revisions, because
   *    the words being judged are the row's own and every writer of them
   *    (the title route, the body route, this revise door) already moves it.
   */
  async function judgeTaskDecision(
    task: Task,
    author: { id: string; name: string; kind?: string },
    runOpts: GateRunOpts = {},
  ): Promise<ReviewGate | undefined> {
    const derived = taskStore.listReviewItems(task.id).find((r) => r.id === LEGACY_REVIEW_ITEM_ID);
    // Not a decision — no derived row, so nothing is on the queue to hold.
    // `undefined` rather than a synthesised pass, so a caller cannot report
    // "judged and fine" about a ticket the judge was never asked about.
    if (!derived) return undefined;
    const out = await runReviewGate<TaskReviewItem>(
      {
        workspaceId: task.workspaceId,
        address: { kind: 'decision', taskId: task.id },
        title: task.title,
        current: () =>
          taskStore.listReviewItems(task.id).find((r) => r.id === LEGACY_REVIEW_ITEM_ID),
        words: (row) => row.review,
        version: () => wordsRevisionOf(taskStore.getTask(task.id) ?? task),
        held: (row) => isReviewItemHeld(row),
        judgement: (row) => row.judge,
        record: (judgement, o) => {
          const res = taskStore.recordDecisionJudgement(task.id, judgement, {
            actor: author,
            ...(o.forVersion !== undefined ? { forVersion: o.forVersion } : {}),
            ...(o.forPendingAt !== undefined ? { forPendingAt: o.forPendingAt } : {}),
          });
          return res.ok ? { ok: true, row: res.item } : { ok: false };
        },
        settled: () => taskProjection.refreshTask(task),
      },
      derived,
      author,
      runOpts,
    );
    return out.held
      ? { held: true, item: out.row, reason: out.reason, message: out.message }
      : { held: false, item: out.row, ...(out.message ? { message: out.message } : {}) };
  }

  /**
   * The gate for an item filed as a `review` payload ON A COMMENT —
   * `create_thread`, `threads/by_find`, `post_reply`, and the doc form of
   * `revise_review_item`.
   *
   * Identical to the ticket form in every respect a filer can observe: the
   * same judge, the same criteria, the same fail-open policy, the same
   * `held` / `heldReason` / `message` on the result, and the same
   * `workspace.review_item_held` wake. What differs is only the address the
   * hold names — `revise_review_item(docId=…, threadId=…, commentId=…)`,
   * which is why this could not be gated until that form existed.
   *
   * The item is addressed by `(docId, threadId, commentId)`, the identity the
   * queue already keys a doc-thread row on.
   */
  async function judgeThreadReview(
    docId: string,
    threadId: string,
    commentId: string,
    review: ReviewPayload,
    author: User,
    runOpts: GateRunOpts = {},
  ): Promise<ThreadReviewGate> {
    const workspaceId = resolveWorkspaceForDoc(docId);
    // A doc no board claims has no criteria to judge against and no queue to
    // be held off. Passing it through is the same answer "gate off" gives.
    if (!workspaceId) return { held: false, review };
    const out = await runReviewGate<ReviewPayload>(
      {
        workspaceId,
        address: { kind: 'thread', docId, threadId, commentId },
        title: reviewThreadContext(docId),
        current: () =>
          docStore.getThread(docId, threadId)?.comments.find((c) => c.id === commentId)?.review,
        words: (row) => row,
        version: (row) => reviewPayloadVersion(row),
        held: (row) => isReviewPayloadHeld(row),
        judgement: (row) => row.judge,
        record: (judgement, o) => {
          const res = docStore.judgeCommentReview(docId, threadId, commentId, judgement, o);
          return res.ok ? { ok: true, row: res.review } : { ok: false };
        },
        // Nothing to project: the payload lives in the doc's own CRDT, and
        // `setCommentReview` has already broadcast it to everyone in the doc.
        settled: () => {},
      },
      review,
      author,
      runOpts,
    );
    return out.held
      ? { held: true, review: out.row, reason: out.reason, message: out.message }
      : { held: false, review: out.row, ...(out.message ? { message: out.message } : {}) };
  }

  /**
   * One create can put TWO things through the gate: the ticket's own decision
   * and a `review` payload filed with it. Both are judged — never one instead
   * of the other — and this is how both are reported through a response shape
   * that carries a single hold.
   *
   * The explicitly filed item leads, because it is the thing the caller wrote
   * a payload for. A second hold is not dropped: its own paste-ready call is
   * appended, so a caller that fixes only what the first sentence names is
   * still told the row has not arrived.
   */
  function mergedHold(
    filed: ReviewGate | undefined,
    decision: ReviewGate | undefined,
  ): ReviewGate | undefined {
    if (!filed?.held) return decision?.held ? decision : (filed ?? decision);
    if (!decision?.held) return filed;
    return {
      ...filed,
      message: `${filed.message} The ticket's own decision is held as well: ${decision.message}`,
    };
  }

  /**
   * Re-judge a ticket's own decision after its WORDS moved.
   *
   * The decision's words are the row's title, body and options, so every
   * door that rewrites those is a revision of it — `rewrite_task` most of
   * all. Without this a filer who fixed a held decision the obvious way
   * would leave the stale verdict standing and the row off the queue
   * forever: the hold is keyed on the item, and nothing else would ever ask
   * the judge again. That is the dead end the whole gate is written to avoid,
   * arriving through a different door.
   *
   * A no-op on a row that is not a decision. Announces the row exactly when
   * this edit is what released it, the same rule the revise door follows.
   */
  async function regateDecisionWords(taskId: string, author: User): Promise<void> {
    const task = taskStore.getTask(taskId);
    if (!task || task.needs !== 'decision') return;
    const wasHeld = taskStore
      .listReviewItems(taskId)
      .some((r) => r.id === LEGACY_REVIEW_ITEM_ID && isReviewItemHeld(r));
    const gate = await judgeTaskDecision(task, author);
    if (wasHeld && gate && !gate.held) announceTaskReview(task, gate.item, author);
  }

  /**
   * The response fields a filing route adds for whatever the gate said.
   *
   * A hold reports `held`, the reason and the message. A PASS reports a
   * message only when the item reached the reader without the judge passing
   * it — the last-hold rule, or the filer's own less-specific answer —
   * because until that was said the filer read a bare 200 as "it passed".
   * `admittedUnjudged` is the machine-readable half of the same fact.
   */
  function heldFields(gate: ReviewGate | ThreadReviewGate | undefined): Record<string, unknown> {
    if (gate?.held) return { held: true, heldReason: gate.reason, message: gate.message };
    if (gate && !gate.held && gate.message !== undefined) {
      // Which admission it was, read off the row the gate just stamped —
      // `held`/`less-specific` rather than a second copy of the fact carried
      // alongside the message.
      const judged = 'item' in gate ? gate.item.judge : gate.review.judge;
      return {
        held: false,
        ...(judged?.admitted !== undefined ? { admitted: judged.admitted } : {}),
        message: gate.message,
      };
    }
    return {};
  }

  /**
   * A hold nobody revised within `REVIEW_GATE_RELEASE_MS`, put on the
   * reader's queue as filed — called from the stall tick, which already
   * walks every held item on both surfaces once a minute.
   *
   * The verdict becomes `ok` with a reason that says what happened and quotes
   * the standing concern, the way the two-hold cap does, and the item is
   * announced exactly as a passed filing is. The filer stays the filer: the
   * store stamps `filedBy` from the actor, so the actor is the filer as the
   * held row recorded them, never the server.
   *
   * No judge call and no version guard: this runs synchronously between the
   * read that listed the item and the write, so no revision can land in
   * between, and a row answered or withdrawn since is refused by the store
   * or no longer reads as held. Returns whether the item was released.
   */
  function releaseUnrevisedHold(item: HeldItemInput): boolean {
    const filer = {
      id: item.filerAgentId ?? '',
      name: item.filedBy,
      kind: 'agent',
    };
    const clause = judgeReasonClause(item.reason);
    const released = (heldFor: string[] | undefined): ReviewItemJudgement => ({
      at: Date.now(),
      verdict: 'ok',
      reason:
        clause === ''
          ? 'Released to the queue after an hour unrevised.'
          : `Released to the queue after an hour unrevised; the gate's concern was — ${clause}.`,
      ...(heldFor !== undefined && heldFor.length > 0 ? { heldFor } : {}),
    });
    const person = { ...filer, kind: 'known' as const, color: '' };
    // A comment-borne item carries its thread address; a ticket item never
    // does, even when the comment sits in the ticket's own body doc.
    if (item.docId !== undefined && item.threadId !== undefined && item.commentId !== undefined) {
      const stored = docStore
        .getThread(item.docId, item.threadId)
        ?.comments.find((c) => c.id === item.commentId)?.review;
      if (!stored || !isReviewPayloadHeld(stored)) return false;
      const res = docStore.judgeCommentReview(
        item.docId,
        item.threadId,
        item.commentId,
        released(stored.judge?.heldFor),
      );
      if (!res.ok) return false;
      announceThreadReview(item.docId, item.threadId, res.review, person);
      return true;
    }
    if (item.taskId === undefined) return false;
    const task = taskStore.getTask(item.taskId);
    if (!task) return false;
    const current = taskStore.listReviewItems(task.id).find((r) => r.id === item.reviewItemId);
    if (!current || !isReviewItemHeld(current)) return false;
    const judgement = released(current.judge?.heldFor);
    const res =
      item.reviewItemId === LEGACY_REVIEW_ITEM_ID
        ? taskStore.recordDecisionJudgement(task.id, judgement, { actor: filer })
        : taskStore.recordReviewJudgement(task.id, item.reviewItemId, judgement, { actor: filer });
    if (!res.ok) return false;
    taskProjection.refreshTask(res.task);
    announceTaskReview(res.task, res.item, person);
    return true;
  }

  /**
   * A person's QUESTION typed where an answer goes, turned into the ask it
   * is: a thread on the task doc anchored to the item, recorded on the item
   * WITH that thread — which is what takes the item off the reader's queue
   * (`reviewItemState` reads a threaded question as `waiting`) until the
   * owner revises it. ONE implementation for the two answer routes — the
   * review-item route and the task's own `/answer` — so a question typed
   * into a stored item's card and one typed into the ticket's own decision
   * card make the same thread and leave the queue by the same rule. `item`
   * may be the derived `r-legacy` row: its `id` addresses it on the store,
   * and its `detail` is the task body.
   *
   * The caller has already refused an ANSWERED item, which it can see on its
   * own row; everything else about the conversion is here.
   */
  async function askBackOnItem(
    task: Task,
    item: TaskReviewItem,
    text: string,
    author: User,
    visitor: boolean,
  ): Promise<Response> {
    // One open question at a time, the anchored ask's own rule: a second
    // would orphan the first, because revise only answers the newest
    // threaded question (`latestThreadedQuestion`).
    if (reviewItemState(item) === 'waiting') {
      const openThreadId = latestThreadedQuestion(item)?.threadId;
      const owner = item.createdBy.trim() || 'the owner';
      return j(409, {
        error: 'waiting',
        message: `Already waiting on ${owner} — add to the open thread instead`,
        ...(openThreadId !== undefined ? { threadId: openThreadId } : {}),
      });
    }
    // The question becomes a real thread on the item, exactly as a
    // phrase-anchored ask does — the thread is where the owner replies, and
    // what the card opens onto. It is about the WHOLE item, so the anchor
    // quotes the headline (offsets only if those words happen to sit
    // uniquely in the detail) and the recorded question carries no range:
    // there is no phrase to mark.
    const headlineRange = locateReviewItemRange(item.review.detail, {
      text: item.review.headline,
    });
    const created = await docStore.postComment(
      taskProjection.ensureBodyDoc(task),
      null,
      author,
      text,
      {
        kind: 'review-item',
        reviewItemId: item.id,
        snippet: { text: item.review.headline },
        ...(headlineRange?.start !== undefined && headlineRange?.end !== undefined
          ? { start: headlineRange.start, end: headlineRange.end }
          : {}),
      },
      { generate: !visitor },
    );
    if (!created) return j(500, { error: 'could not create thread' });
    // Re-checked in the same synchronous stretch as the record — the
    // `onlyIfUnanswered` discipline the fold path uses. The waiting check
    // above is a claim about a moment before the thread write's await, and
    // two readers can both pass it; recording both would bury the first
    // question where revise can never answer it (`latestThreadedQuestion`
    // reads only the newest). The loser is refused like any late asker; its
    // thread stays on the item as an ordinary comment — the reader's words
    // are user content, and this project does not delete those to tidy a
    // race (codex review).
    const now = taskStore.listReviewItems(task.id).find((r) => r.id === item.id);
    if (now && reviewItemState(now) === 'answered') {
      return j(409, {
        error: 'answered',
        message:
          'this item was answered while your question was being posted — it stands as a comment on the item; undo the answer first, or ask on the item’s thread',
      });
    }
    if (now && reviewItemState(now) === 'waiting') {
      const openThreadId = latestThreadedQuestion(now)?.threadId;
      const owner = now.createdBy.trim() || 'the owner';
      return j(409, {
        error: 'waiting',
        message: `Already waiting on ${owner} — your question was posted as a comment on the item; add to the open thread instead`,
        ...(openThreadId !== undefined ? { threadId: openThreadId } : {}),
      });
    }
    const asked = taskStore.requestMoreInfoOnReview(task.id, item.id, text, {
      actor: author,
      threadId: created.id,
    });
    if (!asked.ok) return j(asked.error === 'not-found' ? 404 : 400, asked);
    taskProjection.refreshTask(asked.task);
    return j(200, {
      asked: true,
      task: asked.task,
      item: asked.item,
      threadId: created.id,
    });
  }
  return {
    announceTaskReview,
    announceThreadReview,
    recordedThreadHold,
    gateThreadDeclaration,
    reviseCallFor,
    judgeReviewItem,
    judgeTaskDecision,
    judgeThreadReview,
    mergedHold,
    regateDecisionWords,
    heldFields,
    askBackOnItem,
    releaseUnrevisedHold,
  };
}
