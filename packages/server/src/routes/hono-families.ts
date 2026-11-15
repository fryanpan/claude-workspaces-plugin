/**
 * ── The route families Hono answers (milestone M12) ──
 *
 * Each family here used to be a call in `request-chain-tail.ts`. It is now
 * registered on the Hono app (`hono-front.ts`) under the path patterns it
 * claims, and its handler is the same function the chain called, handed the
 * same per-request values. The chain no longer calls it.
 *
 * The first batch is five families from the tail: prompts, the cross-board
 * review queue, voice (the page and the API), access, and the coach. They
 * were chosen because each one
 *
 * - takes no workspace scope, so moving it above the scope resolver changes
 *   nothing it reads, and claims no path under `/workspaces/`, so the
 *   resolver never refused one of its addresses;
 * - claims paths that no module tried before it in the old chain answers.
 *   Hono runs above the sign-in and share routes, the vendor callbacks, the
 *   upgrades and streams, the scope and the whole board half, so a family
 *   that moves overtakes all of them. Each of these claims a prefix or exact
 *   paths that none of them names (checked by grep, and held by
 *   `test/route-answers.test.ts`);
 * - imports no presence, socket or Yjs code.
 *
 * HOW A FAMILY IS REGISTERED. `claim` mounts one middleware on every pattern
 * the family's handler can answer. The patterns are a SUPERSET of what the
 * handler claims: an address the handler declines goes to `next()`, which
 * ends at Hono's not-found marker, and `honoFront` hands the request back to
 * the chain exactly as an address no family claims. An address the handler
 * WOULD answer but no pattern matched would fall past it, because the chain
 * no longer calls it; that is why the patterns are wide where the handler's
 * own test is loose (`/api/prompts` is a `startsWith`, so its pattern is a
 * regex over the rest of the path).
 *
 * The handler sees the raw request. Hono answers a HEAD by dispatching it as
 * a GET, but the request it hands the handler still says HEAD, so a handler
 * that refused or declined a HEAD in the chain does the same here. Hono then
 * copies the answer's status and headers into a bodyless Response; `claim`
 * cancels the dropped body first, so a HEAD on an event stream does not leave
 * a subscriber open.
 */
import type { Context, Hono, Next } from 'hono';
import type { HonoAppEnv, HonoFamily } from '../hono-env.ts';
import type { OriginPolicy } from '../middleware/browser-origin.ts';
import { SHARING_OFF_PAGE_PATH } from '../sharing-off-door.ts';
import { type AccessRoutesContext, handleAccessRoutes } from './access.ts';
import { type CoachRoutesContext, handleCoachRoutes } from './coach.ts';
import { type PromptRoutesContext, handlePromptRoutes } from './prompts.ts';
import { type ReviewQueueRoutesContext, handleReviewQueueRoutes } from './review-queue.ts';
import { type VoiceApiRoutesContext, handleVoiceApiRoutes } from './voice-api.ts';
import { type VoicePageRoutesContext, handleVoicePageRoutes } from './voice-page.ts';

/** Everything long-lived the moved families read. Built once by `server.ts`. */
export interface HonoFamiliesContext {
  promptRoutesCtx: PromptRoutesContext;
  reviewQueueRoutesCtx: ReviewQueueRoutesContext;
  voicePageRoutesCtx: VoicePageRoutesContext;
  voiceApiRoutesCtx: VoiceApiRoutesContext;
  accessRoutesCtx: AccessRoutesContext;
  coachRoutesCtx: CoachRoutesContext;
  requireSignInToWrite: boolean;
  policyFor: (req: Request) => OriginPolicy;
}

/** The per-request values the chain used to pass, read off `c.env`. */
function chainValues(c: Context<HonoAppEnv>, ctx: HonoFamiliesContext) {
  const req = c.req.raw;
  const url = new URL(req.url);
  const { gate, attribution, ownerProven } = c.env;
  const { authorFor, provenIdentityFor, browserProvedNobody } = attribution;
  return {
    req,
    url,
    pathname: url.pathname,
    visitor: gate.visitor,
    authorFor,
    ownerProven: () => ownerProven(),
    anyoneProven: () => provenIdentityFor() !== null,
    mustSignIn: () => ctx.requireSignInToWrite && browserProvedNobody(),
    requestOrigin: () => ctx.policyFor(req).requestOrigin,
  };
}

type Answer = Response | null | undefined;
type ChainValues = ReturnType<typeof chainValues>;

/**
 * Register one family's handler on every pattern in `patterns`.
 *
 * Two patterns can match one address (`/access` and `/access/*` both match
 * `/access`), and Hono runs every match in turn; a request is tried once per
 * family, so a handler that declined is not asked again.
 */
function claim(
  app: Hono<HonoAppEnv>,
  ctx: HonoFamiliesContext,
  patterns: readonly string[],
  answer: (v: ChainValues) => Answer | Promise<Answer>,
): void {
  const tried = new WeakSet<Request>();
  const middleware = async (c: Context<HonoAppEnv>, next: Next): Promise<Response | undefined> => {
    if (tried.has(c.req.raw)) {
      await next();
      return undefined;
    }
    tried.add(c.req.raw);
    const res = await answer(chainValues(c, ctx));
    if (!res) {
      await next();
      return undefined;
    }
    if (c.req.raw.method === 'HEAD' && res.body) {
      await res.body.cancel();
      return new Response(null, res);
    }
    return res;
  };
  for (const pattern of patterns) app.all(pattern, middleware);
}

/** The families, in the order the chain used to try them. */
export function honoFamilies(ctx: HonoFamiliesContext): HonoFamily[] {
  return [
    // routes/prompts.ts — its own test is `startsWith('/api/prompts')`.
    (app) =>
      claim(app, ctx, ['/api/:rest{prompts.*}'], (v) => handlePromptRoutes(ctx.promptRoutesCtx, v)),
    // routes/review-queue.ts — five exact paths.
    (app) =>
      claim(
        app,
        ctx,
        [
          '/review',
          '/api/review-queue',
          '/api/review-wait',
          '/api/review-size',
          '/api/review-queue/rank',
        ],
        (v) => handleReviewQueueRoutes(ctx.reviewQueueRoutesCtx, v),
      ),
    // routes/voice-page.ts and routes/voice-api.ts — one family, two files.
    (app) => {
      claim(app, ctx, ['/voice', '/api/voice/agents', '/api/voice/events:stream'], (v) =>
        handleVoicePageRoutes(ctx.voicePageRoutesCtx, v),
      );
      claim(
        app,
        ctx,
        ['/v1/models', '/v1/chat/completions', '/api/voice/tokens', '/api/voice/tokens/:id/revoke'],
        (v) =>
          handleVoiceApiRoutes(ctx.voiceApiRoutesCtx, {
            ...v,
            viaTunnel: () => v.req.headers.has('cf-ray'),
          }),
      );
    },
    // routes/access.ts — the sharing-off page, the list and its stream, and
    // `/access`, `/access/<section>` with or without a trailing slash.
    (app) =>
      claim(
        app,
        ctx,
        [SHARING_OFF_PAGE_PATH, '/api/access', '/api/access/events:stream', '/access', '/access/*'],
        (v) => handleAccessRoutes(ctx.accessRoutesCtx, v),
      ),
    // routes/coach.ts — its own test is `startsWith('/coach/')`.
    (app) => claim(app, ctx, ['/coach/*'], (v) => handleCoachRoutes(ctx.coachRoutesCtx, v)),
  ];
}
