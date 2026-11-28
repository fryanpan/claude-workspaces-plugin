/**
 * A Review Item — the thing an agent DECLARES when it needs a person, as
 * opposed to the thing a server INFERS from prose.
 *
 * The queue this replaces asked "is the newest comment an agent's", which is
 * exactly what a finished exchange looks like: a person comments, an agent
 * fixes it, the agent replies "Done — shipped in #226", and nobody types
 * again. So the queue accumulated one permanent row per thing the agents got
 * RIGHT. Measured on this project's board 2026-08-18: 105 rows, 0 of them
 * decisions, 6 containing a question, 62 opening with a closing verb, and 93
 * of the 105 row TITLES clipped mid-sentence at the 200-character boundary
 * because the title was the agent's status note rather than anything written
 * to be a title.
 *
 * The detector is not the problem and a better one will not help — `asksPerson`
 * was carefully measured and its own header records the result (fires on 1 of
 * 86 real comments, misses 2 of 3 genuine questions). The problem is that the
 * agent knows perfectly well whether it is asking or reporting and has no way
 * to say so. This is that way.
 *
 * Pure and dependency-free on purpose: the MCP tool, the REST route and the
 * browser all check the same rule, and a second copy of a limit is how the
 * card ends up rendering something the API swore it had refused.
 */

import { type ReviewCheck, checkReviewPayload, reviewPayloadMessage } from './review-item-check.ts';
import { withoutHoldHistory } from './review-item-gate.ts';
import { reviewAnswered, reviewWithdrawn } from './review-item-retired.ts';
import type {
  DecisionTaskLike,
  ReviewInfoRequest,
  ReviewItemRange,
  ReviewItemRevision,
  ReviewOption,
  ReviewPayload,
  TaskReviewItem,
} from './review-item-types.ts';
import { readReviewPayload } from './review-item-wire.ts';

export { pendingDeclaration, reviewAnswered, reviewWithdrawn } from './review-item-retired.ts';
export {
  isReviewItemGated,
  isReviewItemHeld,
  isReviewPayloadGated,
  isReviewPayloadHeld,
  judgeReasonClause,
  judgeReasonSentence,
  reviewPayloadVersion,
  storedJudgement,
  withoutHoldHistory,
} from './review-item-gate.ts';

export {
  REVIEW_LIMITS,
  checkReviewPayload,
  reviewPayloadMessage,
  reviewGapAdvice,
} from './review-item-check.ts';
export type { ReviewGap, ReviewCheck } from './review-item-check.ts';

export { answerAsksBack, answerFromReply } from './review-item-reply.ts';
export { isSecretServiceName } from './review-item-secret-wire.ts';
export {
  normalizeReviewType,
  readReviewPayload,
  readTaskReviewItem,
} from './review-item-wire.ts';

/**
 * The contract, re-exported under the name every caller already imports.
 *
 * The types moved to `review-item-types.ts` so the gate and the readers could
 * reach them without importing the verbs; the callers did not move, and
 * `packages/core/src/index.ts` re-exports this module wholesale, so a direct
 * edit at each of them would only churn imports to no reader's benefit.
 */
export type {
  DecisionTaskLike,
  ReviewAnswerUndone,
  ReviewBlocks,
  ReviewInfoRequest,
  ReviewItemAnswer,
  ReviewItemJudgement,
  ReviewItemRange,
  ReviewItemRevision,
  ReviewJudgeVerdictKind,
  ReviewOption,
  ReviewPartialAnswer,
  ReviewPayload,
  ReviewSecretField,
  ReviewShape,
  TaskReviewItem,
} from './review-item-types.ts';

/**
 * The item's ONE body, as markdown.
 *
 * Now just `detail` — every payload reaching a renderer has been through
 * `readReviewPayload`, which folded any legacy `why`/`lookFor` into it. Kept
 * as a named function rather than inlined because THREE surfaces show the same
 * item (Home's walkthrough, the task panel, the doc thread) and "what the body
 * is" is exactly the thing they must not each decide for themselves.
 */
export function reviewItemBodyMarkdown(review: Pick<ReviewPayload, 'detail'>): string {
  return review.detail?.trim() ?? '';
}

/**
 * Compute one revision of a review item: what the new words are, and what the
 * old ones were.
 *
 * PURE, and shared by both surfaces on purpose. A ticket-borne item revises
 * through `TaskStore.reviseReviewItem`; a doc-thread item revises through the
 * doc route, and it arrived second. Writing "what a revision is" twice is how
 * the two would come to disagree about which patches are legal, where the
 * changed span is, or whether an answered item may be rewritten — so the
 * decision lives here once and each caller only decides WHERE to store the
 * result.
 *
 * Returns the new payload and the superseded reading. It deliberately does
 * NOT file `previous` anywhere: a task item keeps its history on the wrapper
 * (`TaskReviewItem.revisions`), a doc-thread item on the payload itself
 * (`ReviewPayload.revisions`, via `withRevision`), and only the caller knows
 * which it holds.
 */
export type ReviseReviewResult =
  | {
      ok: true;
      next: ReviewPayload;
      previous: ReviewItemRevision;
      /** The quality gate's gaps in the NEW words — the caller turns these
       *  into advice (`reviewGapAdvice`). Returned rather than re-derived, so
       *  the words that were judged are the words that were stored. */
      gaps: ReviewCheck['gaps'];
    }
  | {
      ok: false;
      error: 'answered' | 'withdrawn' | 'empty-patch' | 'no-change' | 'bad-review' | 'bad-range';
      message?: string;
    };

/**
 * Do these two payloads say the same thing to the judge?
 *
 * The judged content is the headline, the detail and the options — nothing
 * else on a payload reaches the prompt. Compared because a revision that
 * changes none of it is not a revision: it re-runs the gate, spends one of
 * the two rounds the filer gets, and leaves the item exactly as it was. A
 * filer doing it by accident loses their remaining round; a filer doing it on
 * purpose reaches the cap without ever addressing a word of the feedback.
 */
export function sameJudgedContent(a: ReviewPayload, b: ReviewPayload): boolean {
  if (a.headline !== b.headline) return false;
  if ((a.detail ?? '') !== (b.detail ?? '')) return false;
  const left = a.options ?? [];
  const right = b.options ?? [];
  if (left.length !== right.length) return false;
  return left.every((o, i) => {
    const other = right[i];
    return (
      other !== undefined &&
      o.id === other.id &&
      o.label === other.label &&
      (o.detail ?? '') === (other.detail ?? '')
    );
  });
}

export function applyReviewRevision(
  current: ReviewPayload,
  patch: { headline?: unknown; detail?: unknown; options?: unknown },
  opts: {
    by: string;
    at: number;
    revisedRange?: { start: number; end: number };
    threadId?: string;
  },
): ReviseReviewResult {
  // An answered item is not revised: the answer is an answer to the words it
  // had, and rewriting them under it leaves a reply to text nobody can see.
  //
  // This reads the PAYLOAD's own answer stamps, which is the whole story for
  // a doc-thread item. A ticket-borne one records its answer on the wrapper
  // instead (`TaskReviewItem.answer`), so that caller checks there as well —
  // this is not the only gate, and it is not meant to be.
  if (reviewAnswered(current)) {
    return {
      ok: false,
      error: 'answered',
      message:
        'this review item is already answered — the answer is to the words it has; raise a new item instead of rewriting these',
    };
  }
  // A withdrawn item is not revised either, for the mirror-image reason: its
  // words were retracted, and rewriting retracted words leaves the reader a
  // correction to something nobody is being asked about. Reinstate it first
  // (`reinstateReview`) if the ask is live again, or file a new one.
  if (reviewWithdrawn(current)) {
    return {
      ok: false,
      error: 'withdrawn',
      message: 'this review item was withdrawn — reinstate it before revising, or raise a new item',
    };
  }
  const touches = (['headline', 'detail', 'options'] as const).filter(
    (k) => patch[k] !== undefined,
  );
  if (touches.length === 0) return { ok: false, error: 'empty-patch' };

  const merged: Record<string, unknown> = { ...current };
  for (const k of touches) merged[k] = patch[k];
  const check = checkReviewPayload(merged);
  if (!check.ok) return { ok: false, error: 'bad-review', message: reviewPayloadMessage(check) };
  const next = readReviewPayload(merged);
  if (!next) return { ok: false, error: 'bad-review', message: reviewPayloadMessage(check) };
  if (sameJudgedContent(current, next)) {
    return {
      ok: false,
      error: 'no-change',
      message:
        'this revision leaves the headline, detail and options exactly as they are — say what changed, or the gate judges the same words again',
    };
  }

  // An explicit range is offsets into the NEW detail; one that runs past it
  // would be served to the queue as-is and highlight to the end of whatever
  // text is there. The derived range is bounded by construction.
  const detailLength = (next.detail ?? '').length;
  if (opts.revisedRange && opts.revisedRange.end > detailLength) {
    return {
      ok: false,
      error: 'bad-range',
      message: `revisedRange ${opts.revisedRange.start}\u2013${opts.revisedRange.end} runs past the new detail (${detailLength} characters)`,
    };
  }
  const range =
    opts.revisedRange ??
    (next.detail !== current.detail
      ? changedRange(current.detail ?? '', next.detail ?? '')
      : undefined);
  const previous: ReviewItemRevision = {
    at: opts.at,
    by: opts.by,
    headline: current.headline,
    ...(current.detail !== undefined ? { detail: current.detail } : {}),
    ...(current.options !== undefined ? { options: current.options } : {}),
    ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
    ...(range !== undefined ? { revisedRange: range } : {}),
  };
  return { ok: true, next, previous, gaps: check.gaps };
}

/** File a superseded reading onto the payload that carries its own history —
 *  the doc-thread half of `applyReviewRevision`. Appends, never replaces. */
export function withRevision(next: ReviewPayload, previous: ReviewItemRevision): ReviewPayload {
  return { ...next, revisions: [...(next.revisions ?? []), previous] };
}

/**
 * Take an item back, or put it back — the asker's own exit from its own ask.
 *
 * PURE and shared, for the same reason `applyReviewRevision` is: what
 * "withdrawn" means must not be decided twice. The doc route holds the only
 * write door today (a doc-thread item is a bare payload on a comment, which
 * is where the gap was measured), but every surface READS the stamp through
 * `reviewWithdrawn`, so the rule cannot be surface-local.
 *
 * The authored words are never touched by either direction. A withdrawal is a
 * change of standing, not a deletion: `headline`, `detail` and `options` read
 * afterwards exactly as they read before, which is what makes this a soft
 * retirement rather than an erasure of text a person may already have read.
 *
 * Refusals, both of them about not lying to the reader:
 *
 * - **answered** — a settled item is the record of a decision somebody made.
 *   Retracting it would take their answer off the board along with the
 *   question, and the asker does not get to un-ask something already
 *   answered. Undo the answer first if it was a mistake.
 * - **already-withdrawn / not-withdrawn** — a no-op, refused rather than
 *   silently accepted so a caller cannot overwrite the original `withdrawnAt`
 *   (and with it the record of when the reader stopped being asked) by
 *   repeating itself.
 */
export type WithdrawReviewResult =
  | { ok: true; next: ReviewPayload }
  | { ok: false; error: 'answered' | 'already-withdrawn' | 'not-withdrawn'; message: string };

export function withdrawReview(
  current: ReviewPayload,
  opts: { by: string; at: number; reason?: string },
): WithdrawReviewResult {
  if (reviewAnswered(current)) {
    return {
      ok: false,
      error: 'answered',
      message:
        'this review item is already answered — withdrawing it would retract an answer somebody gave; undo the answer first if it was a mistake',
    };
  }
  if (reviewWithdrawn(current)) {
    return {
      ok: false,
      error: 'already-withdrawn',
      message: 'this review item is already withdrawn',
    };
  }
  const reason = opts.reason?.trim();
  return {
    ok: true,
    next: {
      ...current,
      withdrawnAt: opts.at,
      withdrawnBy: opts.by,
      ...(reason !== undefined && reason !== '' ? { withdrawnReason: reason } : {}),
      // Taking the ask back ends this round of it. The standing verdict is
      // kept — a reinstated item the gate held is still held, and still off
      // the reader's queue — but the COUNT starts again, so a re-filed ask
      // gets the two rounds a fresh one gets. Without this the cap outlived
      // the ask it was counted for.
      ...(current.judge ? { judge: withoutHoldHistory(current.judge) } : {}),
    },
  };
}

/**
 * Put a withdrawn item back in front of the reader.
 *
 * Clears the three stamps and nothing else. They are state rather than
 * content — the item's words never went anywhere — so dropping them loses no
 * authored text; the `withdrawnReason` goes with them because a reason for a
 * withdrawal that has been undone describes nothing that is still true.
 */
export function reinstateReview(
  current: ReviewPayload,
  _opts?: { by: string; at: number },
): WithdrawReviewResult {
  if (!reviewWithdrawn(current)) {
    return { ok: false, error: 'not-withdrawn', message: 'this review item is not withdrawn' };
  }
  const { withdrawnAt: _a, withdrawnBy: _b, withdrawnReason: _c, ...rest } = current;
  return { ok: true, next: rest };
}

/**
 * The reading this payload superseded most recently, or undefined if its
 * words have never changed (or it is closed, where "revised" is not the thing
 * the reader needs to see — the answer is).
 *
 * The payload-level twin of the `revisions?.at(-1)` the task queue reads. It
 * is what lets a doc-thread row say Revised and highlight the changed span
 * instead of arriving as an indistinguishable second ask.
 */
export function reviewPayloadRevision(review: ReviewPayload): ReviewItemRevision | undefined {
  if (reviewAnswered(review)) return undefined;
  return review.revisions?.at(-1);
}

/**
 * Where an item stands with the person it is waiting on.
 *
 *  - `open`     — nothing asked back; it is on the queue.
 *  - `waiting`  — a question was asked on it and the owner has not revised
 *                 since; it is OFF the queue, waiting on the owner.
 *  - `revised`  — the owner revised the words (after a question, or just
 *                 because); it is back on the queue, marked.
 *  - `answered` — closed.
 *
 * DERIVED, never stored, for the reason `isReviewItemOpen` gives: a status
 * field is a second spelling of facts the item already carries, free to
 * disagree with them. Here the facts are the thread each revision was made
 * against and the two clocks: a revision stamped with the latest question's
 * thread answers it, and so does one made strictly after it. The stamp
 * decides first because the clocks can TIE — a revision and the next
 * question in the same millisecond, measured four runs in five at the route
 * level — and a tie read by the clocks alone put the item back on the queue
 * with its new question unanswered.
 */
export type ReviewItemState = 'open' | 'waiting' | 'revised' | 'answered';

export function reviewItemState(item: TaskReviewItem): ReviewItemState {
  if (item.answer) return 'answered';
  const question = latestThreadedQuestion(item);
  const revision = item.revisions?.at(-1);
  if (question) {
    const answered =
      revision !== undefined &&
      (revision.threadId === question.threadId || revision.at > question.ts);
    if (!answered) return 'waiting';
  }
  if (revision) return 'revised';
  return 'open';
}

/** The newest question asked doc-style on the item, if any. */
export function latestThreadedQuestion(item: TaskReviewItem): ReviewInfoRequest | undefined {
  const reqs = item.infoRequests ?? [];
  for (let i = reqs.length - 1; i >= 0; i--) {
    const r = reqs[i];
    if (r?.threadId) return r;
  }
  return undefined;
}

/**
 * The span of `after` that differs from `before` — common prefix and suffix
 * trimmed — or undefined when nothing did. What the card highlights as the
 * revised phrase when the reviser did not say.
 */
export function changedRange(
  before: string,
  after: string,
): { start: number; end: number } | undefined {
  if (before === after) return undefined;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < max - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return { start, end: after.length - tail };
}

/**
 * Locate a phrase in the item's detail: the caller's offsets when they spell
 * the phrase, else the phrase's unique occurrence, else nothing (the snippet
 * still says what was meant). `null` means the caller's offsets are WRONG —
 * they point at other words — which is a refusal, not a fallback: a
 * highlight on the wrong phrase is worse than none.
 */
export function locateReviewItemRange(
  detail: string | undefined,
  range: { text: string; start?: number; end?: number },
): ReviewItemRange | null {
  const text = detail ?? '';
  if (range.start !== undefined && range.end !== undefined) {
    if (text.slice(range.start, range.end) !== range.text) return null;
    return { text: range.text, start: range.start, end: range.end };
  }
  const first = text.indexOf(range.text);
  if (first < 0 || text.indexOf(range.text, first + 1) >= 0) return { text: range.text };
  return { text: range.text, start: first, end: first + range.text.length };
}

/**
 * Is this item still waiting on a person?
 *
 * Deliberately `answer === undefined` and nothing else. An info request is a
 * question asked back, not an answer, so an item with three of them is still
 * open — and a separate `status` field would be a second spelling of a fact
 * the answer already states, free to disagree with it.
 */
export function isReviewItemOpen(item: TaskReviewItem): boolean {
  return item.answer === undefined;
}

/**
 * The one legacy decision a task carried, expressed as a `ReviewPayload`.
 *
 * MECHANICAL, and every mapping in it is a copy rather than a judgement:
 *
 *  - `headline` is the task TITLE verbatim. A title is an authored string —
 *    somebody wrote it to be a title — so this is not the clip-prose-into-a-
 *    headline move `review-migration.ts` refuses to make. Nothing is generated.
 *  - `detail` is the body verbatim, unbudgeted for the same reason: a limit
 *    invented after the fact cannot retroactively make stored content invalid.
 *  - `options` keep their SERVER-MINTED ids. `ReviewOption.id` only promises
 *    to be stable within the payload, which a minted id satisfies, and
 *    `answer.optionId` already points at these — re-minting would orphan every
 *    answer already recorded.
 *
 * Pure: no store, no clock, no I/O, nothing minted. Read-side migration, so a
 * caller can derive this on every read without ever rewriting stored data.
 */
export function reviewFromDecisionTask(task: DecisionTaskLike): ReviewPayload {
  const out: ReviewPayload = { shape: 'decision', headline: task.title };
  if (typeof task.body === 'string' && task.body.trim() !== '') out.detail = task.body;
  if (task.options && task.options.length > 0) {
    out.options = task.options.map((o) => {
      const opt: ReviewOption = { id: o.id, label: o.label };
      if (o.detail !== undefined) opt.detail = o.detail;
      return opt;
    });
  }
  if (typeof task.answer?.optionId === 'string') out.answeredWith = task.answer.optionId;
  return out;
}
