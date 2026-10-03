/**
 * ── The coach: the owner's learning goals, where he is, and his answers ──
 *
 *   POST /coach/setup                make the learning-goals doc, once → `{ url }`
 *   POST /coach/goals/add            add a goal's four empty parts to it
 *   POST /coach/review               `{ answer: 'no-update' }` to the weekly offer
 *   POST /coach/prefs                `{ readiness: 'less' | 'normal' | 'more' }`
 *   POST /coach/here                 where he is or what he wrote: `{ kind?:
 *                                    'view' | 'wrote', workspaceId, docId?,
 *                                    visible, heading?, text?, timeZone? }`
 *   GET  /coach/stream               the moments, as server-sent events
 *   POST /coach/moments/:id/answer   `{ answer: 'thanks' | 'not-now' | 'not-this' }`
 *   POST /coach/moments              the coach session raises a moment, from
 *                                    this machine only: `{ goal, matched,
 *                                    observed, line }`
 *
 * Owner-level, not under a board: everything here is the owner's, so nothing is
 * on a share or member allowlist and a visitor is refused before anything
 * is read.
 *
 *  - Every page route is for the owner alone: a person proof that resolves to
 *    the owner, from this server's own pages. A POST must also carry this
 *    origin; the stream is a GET, which a browser sends without one, so it
 *    asks for the same-origin fetch mark alone. The gate is Incoming
 *    Messages' (`routes/inbox.ts`), repeated rather than imported so neither
 *    family reaches into the other.
 *  - `/coach/here` answers anyone but the owner with an empty 204, which
 *    the page reads as "stop": every board and doc page sends it.
 *  - Raising a moment is for the coach session, a process on this machine
 *    (`refuseNonLocal`). What it sends is checked before it reaches a page:
 *    a goal to act on, no other moment open, and a quote of that goal's
 *    "Act differently when" (`coach/judge.ts`).
 *
 * What he does reaches one agent stream, the coach session's
 * (`coach/session-feed.ts`).
 */
import type { AgentCallerVerdict } from '../auth/agent-token.ts';
import { addGoal, ensureGoalsDoc } from '../coach/setup.ts';
import type { HereSignal } from '../coach/stream.ts';
import {
  COACH_READINESS,
  type CoachReadiness,
  MOMENT_ANSWERS,
  type MomentAnswer,
} from '../coach/types.ts';
import type { CoachWiring } from '../coach/wiring.ts';

export interface CoachRoutesContext {
  wiring: CoachWiring;
  boardExists: (workspaceId: string) => boolean;
  docOnBoard: (workspaceId: string, docId: string) => boolean;
  refuseNonLocal: (req: Request) => Extract<AgentCallerVerdict, { ok: false }> | null;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  now?: () => number;
}

export interface CoachRouteRequest {
  req: Request;
  pathname: string;
  visitor: unknown;
  ownerProven: () => boolean;
  requestOrigin: () => string | undefined;
}

/** A paragraph he wrote is up to 1,500 characters, sent as JSON. */
const MAX_BODY_BYTES = 8_000;
const ANSWER_PATH = /^\/coach\/moments\/(cm-[A-Za-z0-9_-]{12})\/answer$/;
const ID = /^[A-Za-z0-9_:.-]{1,128}$/;

/** The owner's own pages, and nobody else's. */
function refuseNonOwner(ctx: CoachRoutesContext, rq: CoachRouteRequest): Response | null {
  const { j } = ctx;
  if (rq.visitor) return j(403, { error: 'not available to share visitors' });
  if (!rq.ownerProven()) {
    return j(403, {
      error: 'owner-proof-required',
      message: 'Only the owner, signed in, has a coach.',
    });
  }
  if (rq.req.headers.get('sec-fetch-site') !== 'same-origin') {
    return j(403, { error: 'same-origin-only', message: 'Use this server’s own pages.' });
  }
  if (rq.req.method !== 'GET') {
    const own = rq.requestOrigin();
    if (own === undefined || rq.req.headers.get('origin') !== own) {
      return j(403, { error: 'same-origin-only', message: 'Use this server’s own pages.' });
    }
  }
  return null;
}

const tooLarge = (req: Request): boolean => {
  const length = Number(req.headers.get('content-length') ?? '0');
  return !Number.isFinite(length) || length > MAX_BODY_BYTES;
};

/** The where-I-am body, or the reason it is refused. Text is trimmed to
 *  size by the stream, so only its type is checked here. */
function parseHere(
  ctx: CoachRoutesContext,
  body: Record<string, unknown> | null,
): Omit<HereSignal, 'at'> | string {
  const kind = body?.kind ?? 'view';
  if (kind !== 'view' && kind !== 'wrote') return 'kind is view or wrote';
  const ws = body?.workspaceId;
  if (typeof ws !== 'string' || !ID.test(ws) || !ctx.boardExists(ws)) return 'unknown board';
  const doc = body?.docId;
  if (doc !== undefined && (typeof doc !== 'string' || !ID.test(doc) || !ctx.docOnBoard(ws, doc))) {
    return 'unknown doc';
  }
  if (kind === 'wrote' && doc === undefined) return 'wrote needs a doc';
  if (typeof body?.visible !== 'boolean') return 'visible must be true or false';
  const { heading, text } = body;
  if (heading !== undefined && typeof heading !== 'string') return 'heading must be text';
  if (text !== undefined && typeof text !== 'string') return 'text must be text';
  return {
    kind,
    workspaceId: ws,
    ...(typeof doc === 'string' ? { docId: doc } : {}),
    visible: body.visible,
    ...(typeof heading === 'string' ? { heading } : {}),
    ...(typeof text === 'string' ? { text } : {}),
  };
}

export async function handleCoachRoutes(
  ctx: CoachRoutesContext,
  rq: CoachRouteRequest,
): Promise<Response | undefined> {
  const { pathname, req } = rq;
  if (!pathname.startsWith('/coach/')) return undefined;
  const { j } = ctx;
  const { store, coach, hub, setup } = ctx.wiring;
  const now = ctx.now ?? Date.now;

  if (pathname === '/coach/stream') {
    if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
    const denied = refuseNonOwner(ctx, rq);
    if (denied) return denied;
    return hub.open(coach.openFrame());
  }
  if (req.method !== 'POST') return j(405, { error: 'method not allowed' });

  if (pathname === '/coach/moments') {
    // The coach session's moment, checked before it reaches a page.
    if (rq.visitor) return j(403, { error: 'not available to share visitors' });
    const notLocal = ctx.refuseNonLocal(req);
    if (notLocal) return j(notLocal.status, notLocal.body);
    if (tooLarge(req)) return j(413, { error: 'too-large' });
    const raised = coach.raise(await ctx.safeJson(req));
    if (!raised.ok) {
      const status = raised.error === 'bad-moment' ? 422 : 409;
      return j(status, { error: raised.error, message: raised.message });
    }
    return j(200, { id: raised.id });
  }

  // Every board and doc page sends where he is, whoever is reading it, and
  // only the owner's is used. Anyone else's gets an empty answer that the
  // page reads as "no coach here", so it stops, and a reader's console shows
  // no refusal for a feature that was never theirs.
  if (pathname === '/coach/here' && (rq.visitor || !rq.ownerProven())) {
    return new Response(null, { status: 204 });
  }
  const denied = refuseNonOwner(ctx, rq);
  if (denied) return denied;
  if (tooLarge(req)) return j(413, { error: 'too-large' });
  const body = await ctx.safeJson(req);

  if (pathname === '/coach/setup') {
    const doc = await ensureGoalsDoc(store, setup, now());
    if (!doc) return j(500, { error: 'setup-failed', message: 'The goals doc could not be made.' });
    return j(200, {
      url: `/workspaces/${encodeURIComponent(doc.workspaceId)}/docs/${encodeURIComponent(doc.docId)}`,
    });
  }
  if (pathname === '/coach/goals/add') {
    if (!store.goalsDoc) return j(409, { error: 'not-set-up' });
    return addGoal(store, setup) ? j(200, { ok: true }) : j(500, { error: 'add-failed' });
  }
  if (pathname === '/coach/review') {
    if (body?.answer !== 'no-update')
      return j(400, { error: 'bad-answer', message: 'answer is no-update' });
    store.declineReview(now());
    return j(200, { ok: true });
  }
  if (pathname === '/coach/prefs') {
    const readiness = body?.readiness;
    if (!COACH_READINESS.includes(readiness as CoachReadiness)) {
      return j(400, {
        error: 'bad-readiness',
        message: `readiness is one of ${COACH_READINESS.join(', ')}`,
      });
    }
    coach.setReadiness(readiness as CoachReadiness);
    return j(200, { ok: true });
  }
  if (pathname === '/coach/here') {
    const here = parseHere(ctx, body);
    if (typeof here === 'string') return j(400, { error: 'bad-here', message: here });
    store.noteTimeZone(body?.timeZone);
    coach.here(here);
    return j(200, { ok: true });
  }

  const m = pathname.match(ANSWER_PATH);
  if (!m) return j(404, { error: 'not-found' });
  const answer = body?.answer;
  if (!MOMENT_ANSWERS.includes(answer as MomentAnswer)) {
    return j(400, {
      error: 'bad-answer',
      message: `answer is one of ${MOMENT_ANSWERS.join(', ')}`,
    });
  }
  if (!coach.answer(m[1] ?? '', answer as MomentAnswer)) return j(404, { error: 'no-open-moment' });
  return j(200, { ok: true });
}
