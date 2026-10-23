/**
 * ── The cross-board review routes: one queue over every board ──
 *
 *   GET /api/review-queue        every open item on every live board, top
 *                                project first, each with its size
 *   GET /api/review-wait?since=  per-board wait and in-order share, read off
 *                                the answer ledger (Team Lead's numbers),
 *                                with every answer record it was summed from
 *                                so the same data can be cut another way
 *   GET /api/review-size         the signed-in person's size choice
 *   PUT /api/review-size         change it: `{ size: "easy"|"medium"|"hard" }`
 *   POST /api/review-queue/rank  the plan lead ranks or tags one item:
 *                                `{ agentId, key, rank?: 1..10000 | null,
 *                                goal?: <plan goal id> | "urgent" |
 *                                "not-this-week" | "drop" | null }`
 *   GET /review                  the page that walks the queue
 *
 * All of them are about ACROSS boards, which is why none is on the share or
 * member allowlist: a share is a grant over one board, and every answer here
 * is about all of them. A visitor gets 403 before anything is read.
 *
 * One write is a person's own size choice, keyed by the session's
 * identity, so it needs a signed-in session and can change nobody else's.
 * Answers go through each board's own routes, so the write gates are the
 * ones those routes already have; and the project order is read off the plan
 * board's goals, so no verb sets the order of projects.
 *
 * The other write is the plan lead's rank for one item (`review-ranks.ts`).
 * Only the agent seated as the plan board's lead may make it, proven by its
 * own agent token from this machine (`auth/agent-token.ts`); any other
 * caller is refused before the key is looked up. The key must name an open
 * item on any board: the lead sees every board the owner does (the owner,
 * 2026-10-23), so a private or coach-off board takes a rank like any other.
 *
 * The goal tag rides the same verb rather than a sibling: the lead places an
 * ask against the week's goals in one decision, rank and goal together, and
 * one route keeps one gate. A call may carry either field or both; a field
 * left out is left as it was.
 */
import { parseReviewSize } from '@claude-workspaces/core';
import type { AgentCallerVerdict } from '../auth/agent-token.ts';
import type { CrossReview } from '../cross-review.ts';
import { reviewWait } from '../review-answer-ledger.ts';
import { type ReviewRanks, parseGoalTag, parseRank } from '../review-ranks.ts';
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
  ranks: ReviewRanks;
  /** Tells open `/` pages a rank or goal tag moved (`landing-changes.ts`):
   *  a rank is written here and broadcast nowhere. */
  onRanked?: () => void;
  /** The plan board's goal ids, in order — what a goal tag may name. */
  planGoalIds: (planWorkspaceId: string) => string[];
  /** The plan board's seated lead, or undefined. */
  leadOf: (workspaceId: string) => string | undefined;
  /** Through the edge, from off this machine, or from a page: refused
   *  before the body is read. */
  refuseNonLocal: (req: Request) => Extract<AgentCallerVerdict, { ok: false }> | null;
  /** The caller proves it is `agentId` (token, loopback, not a browser). */
  authorizeAgent: (req: Request, agentId: string) => AgentCallerVerdict;
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

const RANK_PATH = '/api/review-queue/rank';

const PATHS = new Set([
  '/review',
  '/api/review-queue',
  '/api/review-wait',
  '/api/review-size',
  RANK_PATH,
]);

/** The longest key accepted: a board id, a kind, a doc id and a thread id. */
const MAX_KEY = 512;

/** The largest rank body read: an agent id, a key, a number and a goal. */
const MAX_RANK_BYTES = 4096;

async function handleRank(ctx: ReviewQueueRoutesContext, req: Request): Promise<Response> {
  const { j } = ctx;
  if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
  const notLocal = ctx.refuseNonLocal(req);
  if (notLocal) return j(notLocal.status, notLocal.body);
  const length = Number(req.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length > MAX_RANK_BYTES) return j(413, { error: 'too-large' });
  const body = await ctx.safeJson(req);
  const agentId = body?.agentId;
  if (typeof agentId !== 'string' || !/^[a-z0-9-]{1,128}$/.test(agentId)) {
    return j(400, { error: 'bad-agent', message: 'agentId is required' });
  }
  const verdict = ctx.authorizeAgent(req, agentId);
  if (!verdict.ok) return j(verdict.status, verdict.body);
  // Who the plan lead is, before any key is looked up: a refused caller
  // learns nothing about which items exist.
  const { planWorkspaceId } = ctx.crossReview.projects();
  const lead = planWorkspaceId ? ctx.leadOf(planWorkspaceId) : undefined;
  if (!lead || lead !== agentId) {
    return j(403, {
      error: 'not-plan-lead',
      message: 'Only the lead of the plan board may rank review items.',
    });
  }
  const hasRank = body !== null && 'rank' in body;
  const hasGoal = body !== null && 'goal' in body;
  if (!hasRank && !hasGoal) {
    return j(400, { error: 'bad-rank', message: 'send a rank, a goal, or both' });
  }
  const rank = hasRank ? parseRank(body?.rank) : null;
  if (rank === undefined) {
    return j(400, {
      error: 'bad-rank',
      message: 'rank is a whole number from 1 to 10000, or null',
    });
  }
  const goalIds = ctx.planGoalIds(planWorkspaceId ?? '');
  const goal = hasGoal ? parseGoalTag(body?.goal, goalIds) : null;
  if (goal === undefined) {
    return j(400, {
      error: 'bad-goal',
      message: `goal is one of the plan board's goal ids (${goalIds.join(', ') || 'none'}), urgent, not-this-week, drop, or null`,
    });
  }
  const key = body?.key;
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY) {
    return j(400, { error: 'bad-key', message: 'key is the queue key the feed named' });
  }
  const { item } = await ctx.crossReview.item(key);
  if (!item) {
    return j(404, { error: 'not-found', message: 'No open review item has that key.' });
  }
  if (hasRank) ctx.ranks.set(item.key, rank, agentId);
  if (hasGoal) ctx.ranks.setGoal(item.key, goal, agentId);
  ctx.onRanked?.();
  const taskId =
    item.kind === 'task-review' || item.kind === 'task-thread' ? item.taskId : undefined;
  const movedAt = taskId ? ctx.ranks.personMovedAt(item.workspaceId, taskId) : undefined;
  return j(200, {
    key: item.key,
    ...(hasRank ? { rank } : {}),
    ...(hasGoal ? { goal } : {}),
    ...(movedAt !== undefined ? { personMovedAt: movedAt } : {}),
  });
}

export async function handleReviewQueueRoutes(
  ctx: ReviewQueueRoutesContext,
  rq: ReviewQueueRouteRequest,
): Promise<Response | undefined> {
  const { crossReview, j } = ctx;
  const { req, pathname, url, visitor } = rq;
  if (!PATHS.has(pathname)) return undefined;
  if (visitor) return j(403, { error: 'not available to share visitors' });
  if (pathname === RANK_PATH) return handleRank(ctx, req);

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
  if (pathname === '/api/review-queue') return j(200, await crossReview.queue());

  const since = parseSince(url.searchParams.get('since'));
  if (since === null) return j(400, { error: 'since must be epoch milliseconds' });
  // The records go out beside the summary. Any question about ordering that
  // this summary does not answer — a different threshold, a per-day cut, the
  // shape of the whole distribution — is answerable from them without the
  // route having to guess the question first (Bryan, 2026-09-15).
  const answers = crossReview.ledger.read(since);
  const boards = reviewWait(answers, (id) => ctx.boardName(id) ?? id);
  return j(200, { since, boards, answers });
}
