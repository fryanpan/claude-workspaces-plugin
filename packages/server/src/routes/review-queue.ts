/**
 * ── The cross-board review routes: one queue over every board ──
 *
 *   GET /api/review-queue        every open item on every live board, top
 *                                project first, each with its size
 *   GET /api/review-wait?since=  per-board wait and in-order share, read off
 *                                the answer ledger (Team Lead's numbers)
 *   GET /api/review-size         the signed-in person's size choice
 *   PUT /api/review-size         change it: `{ size: "easy"|"medium"|"hard" }`
 *   GET /review                  the page that walks the queue
 *
 * All of them are about ACROSS boards, which is why none is on the share or
 * member allowlist: a share is a grant over one board, and every answer here
 * is about all of them. A visitor gets 403 before anything is read.
 *
 * The one write is a person's own size choice, keyed by the session's
 * identity, so it needs a signed-in session and can change nobody else's.
 * Answers go through each board's own routes, so the write gates are the
 * ones those routes already have; and the project order is read off the plan
 * board's goals, so there is no verb here — or anywhere an agent can reach —
 * that sets a ranking.
 */
import { parseReviewSize } from '@claude-workspaces/core';
import type { CrossReview } from '../cross-review.ts';
import { reviewWait } from '../review-answer-ledger.ts';
import type { ReviewSizePrefs } from '../review-size-prefs.ts';

export interface ReviewQueueRoutesContext {
  crossReview: CrossReview;
  /** A board's display name, for the wait report. */
  boardName: (workspaceId: string) => string | undefined;
  sizePrefs: ReviewSizePrefs;
  /** The identity id a live session cookie names, or null. */
  sessionIdentityId: (req: Request) => string | null;
  /** The `/review` page's HTML. */
  renderPage: () => string;
  pageHeaders: Record<string, string>;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
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

const PATHS = new Set(['/review', '/api/review-queue', '/api/review-wait', '/api/review-size']);

export async function handleReviewQueueRoutes(
  ctx: ReviewQueueRoutesContext,
  rq: ReviewQueueRouteRequest,
): Promise<Response | undefined> {
  const { crossReview, j } = ctx;
  const { req, pathname, url, visitor } = rq;
  if (!PATHS.has(pathname)) return undefined;
  if (visitor) return j(403, { error: 'not available to share visitors' });

  if (pathname === '/api/review-size') {
    const identityId = ctx.sessionIdentityId(req);
    if (req.method === 'GET') {
      return j(200, { size: identityId ? (ctx.sizePrefs.get(identityId) ?? null) : null });
    }
    if (req.method !== 'PUT') return j(405, { error: 'method not allowed' });
    if (!identityId) return j(401, { error: 'not_signed_in' });
    const size = parseReviewSize((await ctx.safeJson(req))?.size);
    if (!size) return j(400, { error: 'size must be easy, medium or hard' });
    ctx.sizePrefs.set(identityId, size);
    return j(200, { size });
  }

  if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
  if (pathname === '/review') return new Response(ctx.renderPage(), { headers: ctx.pageHeaders });
  if (pathname === '/api/review-queue') return j(200, crossReview.queue());

  const since = parseSince(url.searchParams.get('since'));
  if (since === null) return j(400, { error: 'since must be epoch milliseconds' });
  const boards = reviewWait(crossReview.ledger.read(since), (id) => ctx.boardName(id) ?? id);
  return j(200, { since, boards });
}
