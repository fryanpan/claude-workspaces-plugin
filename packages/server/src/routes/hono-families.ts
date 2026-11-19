/**
 * ── The route families Hono answers (milestone M12) ──
 *
 * Each family here used to be a call in the hand-ordered chain that
 * `hono-app.ts` replaced. It is now registered on the Hono app
 * (`hono-front.ts`) under the path patterns it claims, and its handler is
 * the same function the chain called, handed the same per-request values.
 *
 * Moved so far: sign-in and share (`auth-share.ts`), the two vendor
 * callbacks (the voice agent's LLM call and Recall's status webhook), the
 * hosted MCP connector, agent identity, board tokens, a walled lead's
 * folders, the repo registry, load reports, ops, mounts, the workspaces
 * list's stream, prompts, the cross-board review queue, voice (the page and
 * the API), access, Incoming Messages, private messages, the keeper holds
 * and the coach. Each one
 *
 * - takes no workspace scope, so moving it above the scope resolver changes
 *   nothing it reads, and claims no path under `/workspaces/`, so the
 *   resolver never refused one of its addresses;
 * - claims paths that no module tried before it in the old chain answers.
 *   Hono runs above the sign-in and share routes, the vendor callbacks, the
 *   upgrades and streams, the scope and the whole board half, so a family
 *   that moves overtakes all of them. Each of these claims a prefix or exact
 *   paths that none of them names (checked by grep, and held by
 *   `test/route-answers.test.ts`). Sign-in and share, then the two vendor
 *   callbacks, sat immediately below Hono, so for them there was nothing to
 *   overtake;
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
import type { Context, Env, Hono, Next } from 'hono';
import type { FeatureRoutes } from '../feature-module.ts';
import type { HonoAppEnv, HonoFamily, HonoGateEnv } from '../hono-env.ts';
import { HOLDS_PATH } from '../keeper/keeper-announce.ts';
import type { OriginPolicy } from '../middleware/browser-origin.ts';
import { RECALL_STATUS_PATH } from '../middleware/recall-callback-gate.ts';
import { SHARING_OFF_PAGE_PATH } from '../sharing-off-door.ts';
import { VOICE_AGENT_LLM_PATH } from '../spoken-reply/agent-llm.ts';
import { type AccessRoutesContext, handleAccessRoutes } from './access.ts';
import { type AgentIdentityRoutesContext, handleAgentIdentityRoutes } from './agent-identity.ts';
import { type AuthShareRoutesContext, handleAuthShareRoutes } from './auth-share.ts';
import {
  type BoardSocketRootsRoutesContext,
  handleBoardSocketRootsRoutes,
} from './board-socket-roots.ts';
import { type BoardTokenRoutesContext, handleBoardTokenRoutes } from './board-tokens.ts';
import { type CoachRoutesContext, handleCoachRoutes } from './coach.ts';
import {
  LANDING_STREAM_PATH,
  type LandingStreamRoutesContext,
  handleLandingStreamRoute,
} from './landing-stream.ts';
import { type LoadReportRoutesContext, handleLoadReportRoutes } from './load-reports.ts';
import {
  MCP_CONNECTOR_PATH,
  type McpConnectorRouteContext,
  handleMcpConnectorRoute,
} from './mcp-connector.ts';
import { type MountRoutesContext, handleMountRoutes } from './mounts.ts';
import {
  type OpsRoutesContext,
  handleOpsMetricsRoute,
  handleOpsRoutes,
  handleSummaryBackfillRoute,
  handleWebhookLogRoute,
} from './ops.ts';
import {
  type PrivateMessageRoutesContext,
  handlePrivateMessageRoutes,
} from './private-messages.ts';
import { type PromptRoutesContext, handlePromptRoutes } from './prompts.ts';
import { type RecallWebhookRoutesContext, handleRecallWebhookRoute } from './recall-webhook.ts';
import { type RepoRoutesContext, handleRepoRoutes } from './repos.ts';
import { type ReviewQueueRoutesContext, handleReviewQueueRoutes } from './review-queue.ts';
import { type VoiceAgentLlmRoutesContext, handleVoiceAgentLlmRoute } from './voice-agent-llm.ts';
import { type VoiceApiRoutesContext, handleVoiceApiRoutes } from './voice-api.ts';
import { type VoicePageRoutesContext, handleVoicePageRoutes } from './voice-page.ts';

/** Everything long-lived the moved families read. Built once by `server.ts`. */
export interface HonoFamiliesContext {
  authShareRoutesCtx: AuthShareRoutesContext;
  voiceAgentLlmRoutesCtx: VoiceAgentLlmRoutesContext;
  recallWebhookRoutesCtx: RecallWebhookRoutesContext;
  mcpConnectorCtx: McpConnectorRouteContext;
  agentIdentityRoutesCtx: AgentIdentityRoutesContext;
  boardTokenRoutesCtx: BoardTokenRoutesContext;
  boardSocketRootsRoutesCtx: BoardSocketRootsRoutesContext;
  repoRoutesCtx: RepoRoutesContext;
  loadReportRoutesCtx: LoadReportRoutesContext;
  landingStreamCtx: LandingStreamRoutesContext;
  privateMessageRoutesCtx: PrivateMessageRoutesContext;
  opsRoutesCtx: OpsRoutesContext;
  mountRoutesCtx: MountRoutesContext;
  /** Incoming Messages and the keeper holds, two of the registered features
   *  (`features.ts`); git-push, the third, claims `/workspaces/` and stays on
   *  the chain. */
  inboxRoutes: FeatureRoutes;
  keeperHoldsRoutes: FeatureRoutes;
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
export function chainValues<A extends { Bindings: HonoGateEnv }>(
  c: Context<A>,
  ctx: Pick<HonoFamiliesContext, 'requireSignInToWrite' | 'policyFor'>,
) {
  const req = c.req.raw;
  const url = new URL(req.url);
  const { gate, attribution, ownerProven } = c.env;
  const { authorFor, provenIdentityFor, browserProvedNobody } = attribution;
  return {
    req,
    url,
    pathname: url.pathname,
    visitor: gate.visitor,
    boardAgent: gate.boardAgent,
    authorFor,
    widgetIdentity: attribution.widgetIdentity,
    browserProvedNobody,
    provenIdentityFor,
    accessIdentityFor: attribution.accessIdentityFor,
    ownerProven: () => ownerProven(),
    anyoneProven: () => provenIdentityFor() !== null,
    mustSignIn: () => ctx.requireSignInToWrite && browserProvedNobody(),
    requestOrigin: () => ctx.policyFor(req).requestOrigin,
  };
}

type Answer = Response | null | undefined;
type ChainValues = ReturnType<typeof chainValues<HonoAppEnv>>;

/**
 * Register one family's handler on every pattern in `patterns`, handing it
 * what `values` reads off the request.
 *
 * Two patterns can match one address (`/access` and `/access/*` both match
 * `/access`), and Hono runs every match in turn; a request is tried once per
 * family, so a handler that declined is not asked again.
 */
export function claimWith<A extends Env, V>(
  app: Hono<A>,
  values: (c: Context<A>) => V,
  patterns: readonly string[],
  answer: (v: V) => Answer | Promise<Answer>,
): void {
  const tried = new WeakSet<Request>();
  const middleware = async (c: Context<A>, next: Next): Promise<Response | undefined> => {
    if (tried.has(c.req.raw)) {
      await next();
      return undefined;
    }
    tried.add(c.req.raw);
    const res = await answer(values(c));
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

/** `claimWith` over the front's own values. */
function claim(
  app: Hono<HonoAppEnv>,
  ctx: HonoFamiliesContext,
  patterns: readonly string[],
  answer: (v: ChainValues) => Answer | Promise<Answer>,
): void {
  claimWith(app, (c) => chainValues(c, ctx), patterns, answer);
}

/** The families, in the order the chain used to try them. */
export function honoFamilies(ctx: HonoFamiliesContext): HonoFamily[] {
  return [
    // routes/auth-share.ts — sign-in, session and share links. It sat
    // immediately below Hono, so moving it reorders nothing. Its internal
    // order (the browser refusal on `/api/share*` above every share route,
    // `/share/<slug>` above `/s/<slug>`, both above the mints) is one
    // function's source order and moves with it.
    (app) =>
      claim(
        app,
        ctx,
        ['/widget-auth', '/api/auth/*', '/api/share', '/api/share/*', '/share/:slug', '/s/:slug'],
        (v) => handleAuthShareRoutes(ctx.authShareRoutesCtx, v),
      ),
    // routes/voice-agent-llm.ts — one exact path, a vendor calling in.
    (app) =>
      claim(app, ctx, [VOICE_AGENT_LLM_PATH], (v) =>
        handleVoiceAgentLlmRoute(ctx.voiceAgentLlmRoutesCtx, {
          req: v.req,
          pathname: v.pathname,
          shareVisitor: v.visitor !== null,
        }),
      ),
    // routes/recall-webhook.ts — Recall's status POST. It must be tried
    // before the `/recall/` websocket upgrade in the chain's stream block,
    // whose own test is `startsWith('/recall/')`. Hono is tried above that
    // block, and nothing between claims `/recall/status`, so it still is.
    (app) =>
      claim(app, ctx, [RECALL_STATUS_PATH], (v) =>
        handleRecallWebhookRoute(ctx.recallWebhookRoutesCtx, v),
      ),
    // routes/mcp-connector.ts — `/mcp`, the hosted connector.
    (app) =>
      claim(app, ctx, [MCP_CONNECTOR_PATH], (v) => handleMcpConnectorRoute(ctx.mcpConnectorCtx, v)),
    // routes/agent-identity.ts — `/api/agent-token` and
    // `/api/agents/<id>/{token,person,watches,merge}`. Registered before the
    // private messages, which share the `/api/agents/` prefix, as in the chain.
    (app) =>
      claim(app, ctx, ['/api/agent-token', '/api/agents/:agentId/:verb'], (v) =>
        handleAgentIdentityRoutes(ctx.agentIdentityRoutesCtx, v),
      ),
    // routes/board-tokens.ts — `/api/board-tokens` and below it.
    (app) =>
      claim(app, ctx, ['/api/board-tokens', '/api/board-tokens/*'], (v) =>
        handleBoardTokenRoutes(ctx.boardTokenRoutesCtx, v),
      ),
    // routes/board-socket-roots.ts — one pattern, a walled lead's folders.
    (app) =>
      claim(app, ctx, ['/api/board-sockets/:ws/roots'], (v) =>
        handleBoardSocketRootsRoutes(ctx.boardSocketRootsRoutesCtx, v),
      ),
    // routes/repos.ts — `/api/repos` and below it.
    (app) =>
      claim(app, ctx, ['/api/repos', '/api/repos/*'], (v) =>
        handleRepoRoutes(ctx.repoRoutesCtx, v),
      ),
    // routes/load-reports.ts — two exact paths.
    (app) =>
      claim(app, ctx, ['/api/load-reports', '/api/load-reports/slowest'], (v) =>
        handleLoadReportRoutes(ctx.loadReportRoutesCtx, v),
      ),
    // routes/ops.ts — eight exact paths, four handlers that sat at three
    // positions in the chain. Each handler keeps its own visitor, loopback
    // and `cf-ray` refusals in its own order.
    (app) => {
      claim(app, ctx, ['/api/summaries/backfill'], (v) =>
        handleSummaryBackfillRoute(ctx.opsRoutesCtx, v),
      );
      claim(app, ctx, ['/api/metrics'], (v) => handleOpsMetricsRoute(ctx.opsRoutesCtx, v));
      claim(
        app,
        ctx,
        [
          '/api/plugin/refresh',
          '/api/push/key',
          '/api/push/subscriptions',
          '/api/deploy',
          '/api/sentry',
          '/api/signin/owner',
        ],
        (v) => handleOpsRoutes(ctx.opsRoutesCtx, v),
      );
      claim(app, ctx, ['/api/webhooks/log'], (v) => handleWebhookLogRoute(ctx.opsRoutesCtx, v));
    },
    // routes/mounts.ts — `/mounts`, `/mounts/<fileId>…` and `/api/mounts…`.
    (app) =>
      claim(app, ctx, ['/mounts', '/mounts/*', '/api/mounts', '/api/mounts/*'], (v) =>
        handleMountRoutes(ctx.mountRoutesCtx, v),
      ),
    // routes/landing-stream.ts — the workspaces list's change feed.
    (app) =>
      claim(app, ctx, [LANDING_STREAM_PATH], (v) =>
        handleLandingStreamRoute(ctx.landingStreamCtx, v),
      ),
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
    // routes/inbox.ts through its feature — its own test is `startsWith('/inbox/')`.
    (app) => claim(app, ctx, ['/inbox/*'], (v) => ctx.inboxRoutes(v)),
    // routes/private-messages.ts — `/api/me/messages` and an agent's reply
    // to one person.
    (app) =>
      claim(app, ctx, ['/api/me/messages', '/api/agents/:agentId/messages/:personId'], (v) =>
        handlePrivateMessageRoutes(ctx.privateMessageRoutesCtx, v),
      ),
    // routes/keeper-holds.ts through its feature — one exact path.
    (app) => claim(app, ctx, [HOLDS_PATH], (v) => ctx.keeperHoldsRoutes(v)),
    // routes/coach.ts — its own test is `startsWith('/coach/')`.
    (app) => claim(app, ctx, ['/coach/*'], (v) => handleCoachRoutes(ctx.coachRoutesCtx, v)),
  ];
}
