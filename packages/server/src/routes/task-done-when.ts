/**
 * The done-when routes: writing the list, reporting against it, and the
 * owner's word on a line only a person can judge.
 *
 * Three paths under `tasks/:id/`, matched here rather than in `task-fields.ts`
 * because they are one family with one vocabulary — a line id, a verdict and
 * a proof — and the field routes next door share none of it.
 *
 * Gated exactly as every other row-addressed task route is: the scope
 * middleware resolves the board first, so nothing here can reach a row the
 * caller could not already read. Nothing is added to any allowlist, and the
 * prefix (`tasks/`) is one a board member already holds.
 */
import { DONE_WHEN_VERDICTS } from '@claude-workspaces/core/done-when';
import { matchRest } from '../middleware/workspace-scope.ts';
import { type OwnerCheckHold, gateOwnerItems } from '../review-items/done-when-owner.ts';
import {
  type DoneWhenReportInput,
  type DoneWhenResult,
  parseDoneWhenInput,
} from '../task-done-when.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Which HTTP status a refusal earns. `not-found` is the row; everything
 *  else is something the caller sent, bar the actor rule, which is a refusal
 *  of WHO is asking rather than of what they sent. */
function statusFor(error: string): number {
  if (error === 'not-found') return 404;
  if (error === 'not-a-person') return 403;
  return 400;
}

/** Answers the three routes below, or `undefined` when the path is none. */
export async function handleTaskDoneWhen(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, j, safeJson } = ctx;
  const { req, scope, authorFor } = rq;

  /**
   * The answer every write gives: the list, whether it closed the ticket,
   * and — AFTER the owner items it filed or revised have been through the
   * quality gate — any the gate held, each with the call that lifts it. The
   * gate runs before the reply for the reason the add route's does: a builder
   * told "filed" must not be left waiting on a reader who cannot see it.
   */
  async function answered(
    taskId: string,
    res: DoneWhenResult & { ok: true },
    author: { id: string; name: string; kind?: string },
  ): Promise<Response> {
    taskProjection.refreshTask(res.task);
    const held: OwnerCheckHold[] = res.ownerItemsToJudge
      ? await gateOwnerItems(taskId, res.ownerItemsToJudge, author, {
          getTask: (id) => taskStore.getTask(id),
          judgeReviewItem: ctx.judgeReviewItem,
          announceTaskReview: ctx.announceTaskReview,
        })
      : [];
    return j(200, {
      taskId,
      lines: res.lines,
      closed: res.closed,
      status: res.task.status,
      ...(held.length > 0 ? { held } : {}),
    });
  }

  // The WHOLE list, every time: the panel's add, its in-place edit and its ×
  // all send the sequence they want. A line sent with an `id` the row already
  // holds keeps that line's verdict and proof — editing words is not a
  // retraction — and a line the list omits is gone.
  const linesMatch = matchRest(scope, /^tasks\/([^/]+)\/done-when$/);
  if (linesMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(linesMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    // `lines` must be PRESENT, even to clear: an absent key is a caller that
    // mistyped the field name, and reading that as "remove every criterion"
    // is the quiet direction to be wrong in.
    if (body?.lines === undefined) {
      return j(400, { error: 'bad-lines', message: 'lines required — send [] to clear the list' });
    }
    const parsed = parseDoneWhenInput(body.lines);
    if (!parsed.ok) return j(400, { error: parsed.error, message: parsed.message });
    const res = taskStore.setDoneWhen(taskId, parsed.lines ?? [], { actor: author });
    if (!res.ok) return j(statusFor(res.error), res);
    return answered(taskId, res, author);
  }

  // The builder's report. Partial by design — it names the lines it has
  // something to say about — and `met` without proof is refused naming the
  // line.
  const reportMatch = matchRest(scope, /^tasks\/([^/]+)\/done-when\/report$/);
  if (reportMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(reportMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    if (!Array.isArray(body?.lines) || body.lines.length === 0) {
      return j(400, { error: 'bad-lines', message: 'lines must be a non-empty array' });
    }
    const entries: DoneWhenReportInput[] = [];
    for (const raw of body.lines as Array<Record<string, unknown>>) {
      const id = typeof raw?.id === 'string' ? raw.id : '';
      if (id === '') return j(400, { error: 'bad-lines', message: 'every entry needs a line id' });
      const verdict = DONE_WHEN_VERDICTS.find((v) => v === raw?.verdict);
      if (verdict === undefined) {
        return j(400, {
          error: 'bad-verdict',
          message: `verdict must be one of ${DONE_WHEN_VERDICTS.join(', ')}`,
        });
      }
      // Proof shape is read in the store — one reader, so the route and the
      // verb cannot disagree about what counts as an attachment.
      entries.push({ id, verdict, proof: raw?.proof as DoneWhenReportInput['proof'] });
    }
    // A proof's board path ("/workspaces/…?task=…") is made absolute against
    // the base review links use, so the owner's item links somewhere they can open.
    const baseUrl = ctx.externalBaseUrl?.();
    const res = taskStore.reportDoneWhen(taskId, entries, { actor: author, baseUrl });
    if (!res.ok) return j(statusFor(res.error), res);
    return answered(taskId, res, author);
  }

  // The owner's two buttons. Person-only, checked in the store against the
  // same `classifyActor` every other actor rule on this board reads.
  const checkMatch = matchRest(scope, /^tasks\/([^/]+)\/done-when\/([^/]+)\/check$/);
  if (checkMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(checkMatch[1] ?? '');
    const lineId = decodeURIComponent(checkMatch[2] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const verdict = body?.verdict;
    if (verdict !== 'met' && verdict !== 'not-met') {
      return j(400, { error: 'bad-verdict', message: 'verdict must be met or not-met' });
    }
    const res = taskStore.checkDoneWhen(taskId, lineId, verdict, { actor: author });
    if (!res.ok) return j(statusFor(res.error), res);
    return answered(taskId, res, author);
  }

  return undefined;
}
