/**
 * ── The cross-board review routes: one queue over every board ──
 *
 *   GET /api/review-queue        every open item on every live board, top
 *                                project first, each with its size
 *   GET /api/review-wait?since=  per-board wait and in-order share, read off
 *                                the answer ledger (Team Lead's numbers)
 *   GET /reviews                 the page that walks the queue
 *
 * All three read ACROSS boards, which is why none of them is on the share or
 * member allowlist: a share is a grant over one board, and every answer here
 * is about all of them. A visitor gets 403 before anything is read.
 *
 * Nothing here writes. Answers go through each board's own routes, so the
 * write gates are the ones those routes already have; and the project order
 * is read off the plan board's goals, so there is no verb here — or anywhere
 * an agent can reach — that sets a ranking.
 */
import type { CrossReview } from '../cross-review.ts';
import { reviewWait } from '../review-answer-ledger.ts';

export interface ReviewQueueRoutesContext {
  crossReview: CrossReview;
  /** A board's display name, for the wait report. */
  boardName: (workspaceId: string) => string | undefined;
  /** The `/reviews` page's HTML. */
  renderPage: () => string;
  pageHeaders: Record<string, string>;
  j: (status: number, body: unknown) => Response;
}

export interface ReviewQueueRouteRequest {
  req: Request;
  pathname: string;
  url: URL;
  /** Truthy for a share or collaboration visitor — refused here. */
  visitor: unknown;
}

/** `since` is epoch milliseconds: absent reads everything, anything but a
 *  non-negative integer is refused rather than coerced. */
export function parseSince(raw: string | null): number | null {
  if (raw === null || raw === '') return 0;
  if (!/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function handleReviewQueueRoutes(
  ctx: ReviewQueueRoutesContext,
  rq: ReviewQueueRouteRequest,
): Response | undefined {
  const { crossReview, j } = ctx;
  const { req, pathname, url, visitor } = rq;
  const page = pathname === '/reviews';
  if (!page && pathname !== '/api/review-queue' && pathname !== '/api/review-wait') {
    return undefined;
  }
  if (visitor) return j(403, { error: 'not available to share visitors' });
  if (req.method !== 'GET') return j(405, { error: 'method not allowed' });

  if (page) return new Response(ctx.renderPage(), { headers: ctx.pageHeaders });

  if (pathname === '/api/review-queue') return j(200, crossReview.queue());

  const since = parseSince(url.searchParams.get('since'));
  if (since === null) return j(400, { error: 'since must be epoch milliseconds' });
  const boards = reviewWait(crossReview.ledger.read(since), (id) => ctx.boardName(id) ?? id);
  return j(200, { since, boards });
}
