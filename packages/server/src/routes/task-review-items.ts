/**
 * A ticket's review items — 0..n, several possibly open at once.
 *
 * A decision task used to BE a decision — one `needs` flag and one embedded
 * `options` array — so the ticket title doubled as the question and a second
 * open question had nowhere to go. Here the question is a row with its own
 * headline and why, and `:reviewItemId` says which one an answer lands on.
 * The old one-decision doors stay in `task-answers.ts` for sessions on an old
 * plugin bundle; `answerTaskReview` on the derived `r-legacy` row delegates
 * back into `answerDecision`, so one implementation records both. The two
 * doors that record a question rather than move the item are
 * `task-review-ask-back.ts`, and taking an item back is
 * `task-review-withdraw.ts`.
 */
import {
  type Thread,
  isReviewItemGated,
  isReviewItemHeld,
  latestThreadedQuestion,
} from '@claude-workspaces/core';
import { ticketOpenParts } from '../answer-coverage.ts';
import { matchRest } from '../middleware/workspace-scope.ts';
import { writeViaOf } from '../mockup-frame.ts';
import { reviewItemAnsweredEvent, reviewItemFilerId } from '../review-items/analytics.ts';
import { ACCESS_ANSWER_DENIAL } from '../review-items/answer-doors.ts';
import { PERSON_PROOF_REQUIRED, unprovenPersonAnswer } from '../review-items/answer-proof.ts';
import { provenEmailFor } from '../review-items/approver.ts';
import {
  GRANT_ANSWER_DENIAL,
  GRANT_FILING_DENIAL,
  SECRET_ANSWER_DENIAL,
  SECRET_FILING_DENIAL,
  asksForGrant,
  asksForSecret,
} from '../share/board-role.ts';
import { SHARING_NOTICE_ACTOR } from '../sharing-notice.ts';
import { LEGACY_REVIEW_ITEM_ID } from '../tasks.ts';
import type * as C from './review-items-contract.ts';
import { answerAs, sent } from './route-contract.ts';
import { askBackFromAnswer } from './task-review-ask-back.ts';
import {
  type TaskRouteRequest,
  type TaskRoutesContext,
  ownerOnlyDenial,
  reviewItemUrlFor,
} from './task-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleTaskReviewItems(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    taskProjection,
    docStore,
    j,
    safeJson,
    parseRevisedRange,
    announceTaskReview,
    heldFields,
    judgeReviewItem,
    judgeTaskDecision,
    answerCoverage,
  } = ctx;
  const { req, scope, visitor, authorFor, roleFor } = rq;

  const workspaceId = scope?.workspaceId ?? '';
  const taskReviewAddMatch = matchRest(scope, /^tasks\/([^/]+)\/review-items$/);
  if (taskReviewAddMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskReviewAddMatch[1] ?? '');
    const body = sent<C.AddReviewItemBody>(await safeJson(req));
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    // A SHARE VISITOR MAY NOT FILE THIS SHAPE — see `SECRET_FILING_DENIAL`.
    // Before the store, so nothing is written and no judge runs on an ask
    // that is not going to exist.
    if (visitor && asksForSecret(body?.review)) return j(403, SECRET_FILING_DENIAL);
    if (visitor && asksForGrant(body?.review)) return j(403, GRANT_FILING_DENIAL);
    // Unvalidated on purpose: `addReviewItem` runs `checkReviewPayload`,
    // and that IS the gate. A pre-check here would be a second copy of
    // the limits, free to drift from the one the card renders against.
    const res = taskStore.addReviewItem(taskId, body?.review, { actor: author });
    if (!res.ok) {
      return j(res.error === 'not-found' ? 404 : 400, {
        error: res.error,
        ...(res.message !== undefined ? { message: res.message } : {}),
      });
    }
    taskProjection.refreshTask(res.task);
    // The gate, BEFORE the announcement: a held item is not on anybody's
    // queue, so nothing may say it is.
    // The hold is in this route's own reply, so no second copy is pushed at
    // the author (`GateRunOpts.heldInReply`).
    const gate = await judgeReviewItem(res.task, res.item, author, { heldInReply: true });
    if (!gate.held) announceTaskReview(res.task, res.item, author);
    // `reviewAdvice`, the same key a comment-borne declaration answers
    // with. The divergent `shapeGaps` vocabulary stays exactly where it
    // is for the callers that already read it — this is a new door, and
    // a new door has no old callers to keep.
    const url = reviewItemUrlFor(ctx, workspaceId, taskId, res.item.id, Boolean(visitor));
    return j(
      200,
      answerAs<C.AddReviewItemAnswer>({
        task: res.task,
        item: gate.item,
        url,
        reviewAdvice: res.advice,
        ...heldFields(gate),
      }),
    );
  }
  const taskReviewAnswerMatch = matchRest(scope, /^tasks\/([^/]+)\/review-items\/([^/]+)\/answer$/);
  if (taskReviewAnswerMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskReviewAnswerMatch[1] ?? '');
    const reviewItemId = decodeURIComponent(taskReviewAnswerMatch[2] ?? '');
    const body = sent<C.ReviewAnswerBody>(await safeJson(req));
    const text = body?.text;
    if (typeof text !== 'string' || text.length === 0) {
      return j(400, { error: 'text required' });
    }
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    // `answeredWith` is this entity's spelling of the legacy `optionId`:
    // provenance for a tapped answer, never a substitute for the words.
    const answeredWith = body?.answeredWith;
    if (answeredWith !== undefined && typeof answeredWith !== 'string') {
      return j(400, { error: 'answeredWith must be a string' });
    }
    // A SECRET ASK IS NOT ANSWERED IN WORDS, and this is the door that decides
    // it. Checked before the owner-only gate below and before the ask-back
    // conversion, because both of those are writes: the shape is wrong for
    // this route whoever is asking, so it is refused first and refused the
    // same way for every caller — a browser on a surface that renders the
    // wrong card, an agent that reached for the wrong tool, or a bare POST.
    // The card was got wrong once (the task page drew the verbatim box and
    // recorded a typed value); this is why that could only ever be a display
    // bug and not a leak.
    {
      const item = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
      if (asksForSecret(item?.review)) return j(400, SECRET_ANSWER_DENIAL);
      // A GRANT card likewise, for a stronger reason: its approval writes the
      // owner's settings, so no recorded words — an agent's through
      // answer_review_item, or anyone's — may stand in for the owner's own
      // press of Approve. See `routes/task-grants.ts`.
      if (asksForGrant(item?.review)) return j(400, GRANT_ANSWER_DENIAL);
      // An ACCESS change likewise: approving it changes who is in the board,
      // so only the owner's own press of Approve does (`routes/task-access.ts`).
      if (item?.access !== undefined) return j(400, ACCESS_ANSWER_DENIAL);
      // And the sharing notice, whatever shape it was filed in: one filed
      // before it was an access card is a plain decision, and an answer here
      // takes the author the body names.
      const task = taskStore.getTask(taskId);
      if (task && reviewItemFilerId(task, reviewItemId) === SHARING_NOTICE_ACTOR.id) {
        return j(400, ACCESS_ANSWER_DENIAL);
      }
    }
    // A person's answer only from that person's own proof, before any write:
    // a body naming the owner is how an agent approved its own ask
    // (`review-items/answer-proof.ts`).
    if (unprovenPersonAnswer(author, rq.answerProof)) return j(403, PERSON_PROOF_REQUIRED);
    // Checked HERE, before any write and before the ask-back conversion below,
    // because the conversion is itself a write on the item: a Regular User's
    // question would otherwise land on the thread of an ask they may not
    // touch, and the refusal would arrive after the board had already changed.
    {
      const denied = ownerOnlyDenial(ctx, rq, taskId, reviewItemId);
      if (denied) return denied;
    }
    // A question typed where the answer goes is an ASK BACK, not a decision
    // (`task-review-ask-back.ts`).
    const askedBack = await askBackFromAnswer(ctx, rq, {
      taskId,
      reviewItemId,
      text,
      author,
      answeredWith,
    });
    if (askedBack) return askedBack;
    const via = writeViaOf(req);
    // An item that asks several things can be answered on one of them. Such
    // an answer is recorded as PARTIAL and the item stays on the reader's
    // queue naming what is left — it used to close, and the rest waited on
    // the reader with nothing on their queue (2026-09-14). Not asked for the
    // ticket's own decision or an owner-line item, which each ask one thing.
    const openParts = await ticketOpenParts(
      answerCoverage,
      taskStore,
      taskId,
      reviewItemId,
      text,
      answeredWith,
    );
    const provenEmail = provenEmailFor(rq.provenIdentityFor, author.id);
    const res = taskStore.answerTaskReview(taskId, reviewItemId, text, {
      actor: author,
      ...(answeredWith !== undefined ? { answeredWith } : {}),
      ...(via ? { via } : {}),
      ...(openParts.length > 0 ? { openParts } : {}),
      ...(provenEmail ? { provenEmail } : {}),
    });
    // Somebody else's answer stands: a conflict, not a malformed request.
    if (!res.ok) {
      return j(
        res.error === 'not-found' ? 404 : res.error === 'answered-by-other' ? 409 : 400,
        res,
      );
    }
    taskProjection.refreshTask(res.task);
    // MEASUREMENT, beside `decision.answered` rather than instead of it: one
    // ids-only row per landed answer, so the minutes between this reader
    // being SHOWN the item and answering it are a subtraction over one log.
    // See `review-items/analytics.ts`.
    taskStore.emit(
      reviewItemAnsweredEvent({
        workspaceId,
        reviewItemId,
        taskId,
        actorId: author.id,
        isOwner: roleFor(workspaceId) === 'owner',
        // Who the wake is addressed to: the agent that filed the ask is the
        // one that stopped for the answer. See `ReviewItemAnsweredEvent`.
        ...(reviewItemFilerId(res.task, reviewItemId) !== undefined
          ? { filedById: reviewItemFilerId(res.task, reviewItemId) }
          : {}),
        ts: Date.now(),
      }),
    );
    const stillOpen =
      res.item.answer === undefined ? res.item.partialAnswers?.at(-1)?.open : undefined;
    return j(
      200,
      answerAs<C.TicketAnswer>({ ...res, ...(stillOpen ? { openParts: stillOpen } : {}) }),
    );
  }
  /**
   * RELEASE a held review item — the reader overruling the gate.
   *
   * The gate is a judge, and a judge can be wrong about one item. Until
   * this route existed the only way off a hold was the filer revising,
   * so a reader looking at a question they could answer in ten seconds
   * had to wait for an agent to reword it (UX review, 2026-08-29).
   *
   * It records an `ok` verdict naming the person, which is the truth of
   * what happened: the item passed, on their authority rather than the
   * judge's. That puts it on the queue by the same rule every passed
   * item reaches it, and it is announced exactly as a filing is —
   * nothing downstream needs to know a person did this.
   *
   * Releasing an item nothing is holding is a no-op success: two taps
   * on a slow connection must not turn into an error the reader has to
   * think about.
   */
  const taskReviewReleaseMatch = matchRest(
    scope,
    /^tasks\/([^/]+)\/review-items\/([^/]+)\/release$/,
  );
  if (taskReviewReleaseMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskReviewReleaseMatch[1] ?? '');
    const reviewItemId = decodeURIComponent(taskReviewReleaseMatch[2] ?? '');
    {
      const denied = ownerOnlyDenial(ctx, rq, taskId, reviewItemId);
      if (denied) return denied;
    }
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const task = taskStore.getTask(taskId);
    if (!task) return j(404, { error: 'not-found' });
    const before = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
    if (!before) return j(404, { error: 'not-found' });
    if (!isReviewItemGated(before)) {
      return j(200, { taskId, item: before, released: false });
    }
    const overruled = {
      at: Date.now(),
      verdict: 'ok' as const,
      reason: `Released by ${author.name} — the gate was overruled.`,
    };
    // The ticket's OWN decision is releasable too, and unlike a held
    // comment it has a surface to press the button from: the row is on
    // the board, and the held note renders on it. The verdict lands on
    // the task rather than on an item, which is the only difference.
    const res =
      reviewItemId === LEGACY_REVIEW_ITEM_ID
        ? taskStore.recordDecisionJudgement(taskId, overruled, { actor: author })
        : taskStore.recordReviewJudgement(taskId, reviewItemId, overruled, {
            actor: author,
          });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    taskProjection.refreshTask(res.task);
    announceTaskReview(res.task, res.item, author);
    return j(200, { taskId, item: res.item, released: true });
  }
  // revise_review_item: the owner's answer to a question asked ON the
  // item — the words made clearer in place, the old words kept, and an
  // optional reply on the thread that asked. Refusals happen before
  // any write: a reply with no thread to land on is refused here rather
  // than dropped after the revision applied, because "revised, and the
  // reply went nowhere" is the accepted-and-discarded shape this repo
  // keeps re-shipping.
  const taskReviewReviseMatch = matchRest(scope, /^tasks\/([^/]+)\/review-items\/([^/]+)\/revise$/);
  if (taskReviewReviseMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskReviewReviseMatch[1] ?? '');
    const reviewItemId = decodeURIComponent(taskReviewReviseMatch[2] ?? '');
    const url = reviewItemUrlFor(ctx, workspaceId, taskId, reviewItemId, Boolean(visitor));
    const denied = ownerOnlyDenial(ctx, rq, taskId, reviewItemId);
    if (denied) return denied;
    const body = sent<C.ReviseReviewItemBody>(await safeJson(req));
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const task = taskStore.getTask(taskId);
    if (!task) return j(404, { error: 'not-found' });
    const reply = body?.reply;
    if (reply !== undefined && (typeof reply !== 'string' || reply.trim() === '')) {
      return j(400, { error: 'reply must be a non-empty string' });
    }
    const parsedRange = parseRevisedRange(body?.revisedRange);
    if (!parsedRange.ok) return j(400, { error: parsedRange.error });
    const revisedRange = parsedRange.range;
    // The filer's answer to a hold that asked for a specific their source
    // does not carry. A string or nothing: anything else is a caller getting
    // the shape wrong, and silently ignoring it would leave them thinking
    // they had answered the hold.
    const lessSpecific = body?.lessSpecific;
    if (
      lessSpecific !== undefined &&
      (typeof lessSpecific !== 'string' || lessSpecific.trim() === '')
    ) {
      return j(400, { error: 'lessSpecific must be a non-empty string' });
    }
    const gateOpts = lessSpecific !== undefined ? { lessSpecific } : {};
    // The TICKET'S OWN decision. `reviseReviewItem` refuses the derived
    // id — rightly: its words are the task's title, body and options,
    // and there is no stored row to patch. So this door delegates into
    // the store method that rewrites THOSE words through the ordinary
    // title/body doors, exactly as `answerTaskReview` delegates the
    // same id into `answerDecision`. Without it a held decision is a
    // dead end: off the reader's queue, complained about at five
    // minutes, and with no verb its filer can call.
    if (reviewItemId === LEGACY_REVIEW_ITEM_ID) {
      // Refused, never dropped. The ticket's own decision has no item
      // thread of its own to answer on, and forwarding a `reply` this
      // branch does not act on would answer 200 while discarding the
      // one sentence the caller wrote for a person to read — the
      // accepted-and-discarded shape this file refuses everywhere else
      // (codex review).
      if (reply !== undefined) {
        return j(400, {
          error: 'no-thread',
          message:
            "a ticket's own decision has no item thread to reply on — revise it without `reply`, and point at what changed with post_reply on the task",
        });
      }
      const wasHeldDecision = taskStore
        .listReviewItems(taskId)
        .some((r) => r.id === LEGACY_REVIEW_ITEM_ID && isReviewItemHeld(r));
      const revised = taskStore.reviseTaskDecision(
        taskId,
        { headline: body?.headline, detail: body?.detail, options: body?.options },
        {
          actor: author,
          ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
        },
      );
      if (!revised.ok) {
        return j(revised.error === 'not-found' ? 404 : 400, revised);
      }
      taskProjection.refreshTask(revised.task);
      // Judged again, on the new words — the promise the hold's message
      // makes. A revision that still misses comes back held.
      const gate = await judgeTaskDecision(revised.task, author, {
        ...gateOpts,
        heldInReply: true,
      });
      if (wasHeldDecision && gate && !gate.held) {
        announceTaskReview(revised.task, gate.item, author);
      }
      return j(
        200,
        answerAs<C.ReviseReviewItemAnswer>({
          task: revised.task,
          item: gate?.item ?? revised.item,
          url,
          ...heldFields(gate),
        }),
      );
    }
    if (reply !== undefined) {
      const item = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
      if (item && !latestThreadedQuestion(item)?.threadId) {
        return j(400, {
          error: 'no-thread',
          message:
            'nobody has asked on this item, so there is no thread for the reply — revise without `reply`, or post_reply on the thread you mean',
        });
      }
    }
    // Whether the gate was holding it BEFORE this revision — a hold
    // that clears is the moment the item first reaches the queue, and
    // that is announced exactly as a fresh filing would be.
    const before = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
    const wasHeld = before !== undefined && isReviewItemHeld(before);
    const res = taskStore.reviseReviewItem(
      taskId,
      reviewItemId,
      { headline: body?.headline, detail: body?.detail, options: body?.options },
      { actor: author, ...(revisedRange ? { revisedRange } : {}) },
    );
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    taskProjection.refreshTask(res.task);
    // Re-judged on every revision: the verdict was about the old words.
    const gate = await judgeReviewItem(res.task, res.item, author, {
      ...gateOpts,
      heldInReply: true,
    });
    if (wasHeld && !gate.held) announceTaskReview(res.task, gate.item, author);
    let thread: Thread | null = null;
    if (reply !== undefined && res.threadId) {
      const docId = taskProjection.ensureBodyDoc(res.task);
      thread = await docStore.postComment(docId, res.threadId, author, reply, undefined, {
        generate: !visitor,
      });
    }
    return j(
      200,
      answerAs<C.ReviseReviewItemAnswer>({
        task: res.task,
        item: gate.item,
        url,
        threadId: res.threadId,
        thread: thread ?? undefined,
        reviewAdvice: res.advice,
        ...heldFields(gate),
      }),
    );
  }
  return undefined;
}
