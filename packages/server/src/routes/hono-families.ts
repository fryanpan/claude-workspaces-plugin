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
 * the API), access, Incoming Messages, private messages and the coach. Each one
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
 * WHERE THE PATTERNS COME FROM. A family whose handler answers only the
 * addresses its rows in `route-table-rows.ts` name is registered on those
 * rows (`rowPatterns`), so the table is what dispatches it: a row added there
 * is claimed here with nothing else written, and a path with no row is not
 * claimed at all. A family whose handler answers wider than its rows — a 404
 * for any path under its prefix, a visitor refusal on a loose `startsWith` —
 * keeps hand-written patterns, because narrowing them to the rows would hand
 * those addresses to whatever is tried next. `test/hono-row-dispatch.test.ts`
 * names both sets.
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
import type { OriginPolicy } from '../middleware/browser-origin.ts';
import { ROUTE_TABLE } from '../route-table-rows.ts';
import { SHARING_OFF_PAGE_PATH } from '../sharing-off-door.ts';
import { type AccessRoutesContext, handleAccessRoutes } from './access.ts';
import { type AgentIdentityRoutesContext, handleAgentIdentityRoutes } from './agent-identity.ts';
import { type AuthShareRoutesContext, handleAuthShareRoutes } from './auth-share.ts';
import {
  type BoardSocketRootsRoutesContext,
  handleBoardSocketRootsRoutes,
} from './board-socket-roots.ts';
import { type BoardTokenRoutesContext, handleBoardTokenRoutes } from './board-tokens.ts';
import { type CoachRoutesContext, handleCoachRoutes } from './coach.ts';
import { type LandingStreamRoutesContext, handleLandingStreamRoute } from './landing-stream.ts';
import { type LoadReportRoutesContext, handleLoadReportRoutes } from './load-reports.ts';
import { type McpConnectorRouteContext, handleMcpConnectorRoute } from './mcp-connector.ts';
import { type MountRoutesContext, handleMountRoutes } from './mounts.ts';
import {
  type OpsRoutesContext,
  handleHomeRemotesRoute,
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
  /** Incoming Messages, one of the registered features (`features.ts`);
   *  git-push, the other, claims `/workspaces/` and stays on the chain. */
  inboxRoutes: FeatureRoutes;
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

/**
 * Every distinct pattern the route table holds for one module, in table
 * order — the patterns a row-dispatched family is registered on. `module` is
 * relative to `routes/`, as a row names it without the prefix. A module with
 * no rows throws at boot, so a misspelt name cannot register a family on
 * nothing and silently answer no address.
 */
export function rowPatterns(module: string): string[] {
  const patterns = [
    ...new Set(ROUTE_TABLE.filter((r) => r.module === `routes/${module}`).map((r) => r.pattern)),
  ];
  if (patterns.length === 0) throw new Error(`rowPatterns: no route-table rows for ${module}`);
  return patterns;
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
      claim(app, ctx, rowPatterns('voice-agent-llm.ts'), (v) =>
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
      claim(app, ctx, rowPatterns('recall-webhook.ts'), (v) =>
        handleRecallWebhookRoute(ctx.recallWebhookRoutesCtx, v),
      ),
    // routes/mcp-connector.ts — `/mcp`, the hosted connector.
    (app) =>
      claim(app, ctx, rowPatterns('mcp-connector.ts'), (v) =>
        handleMcpConnectorRoute(ctx.mcpConnectorCtx, v),
      ),
    // routes/agent-identity.ts — `/api/agent-token` and
    // `/api/agents/<id>/{token,person,watches,merge}`. Registered before the
    // private messages, which share the `/api/agents/` prefix, as in the chain;
    // no row of one matches an address of the other.
    (app) =>
      claim(app, ctx, rowPatterns('agent-identity.ts'), (v) =>
        handleAgentIdentityRoutes(ctx.agentIdentityRoutesCtx, v),
      ),
    // routes/board-tokens.ts — the list and mint, one token's revoke, the refresh.
    (app) =>
      claim(app, ctx, rowPatterns('board-tokens.ts'), (v) =>
        handleBoardTokenRoutes(ctx.boardTokenRoutesCtx, v),
      ),
    // routes/board-socket-roots.ts — one pattern, a walled lead's folders.
    (app) =>
      claim(app, ctx, rowPatterns('board-socket-roots.ts'), (v) =>
        handleBoardSocketRootsRoutes(ctx.boardSocketRootsRoutesCtx, v),
      ),
    // routes/repos.ts — `/api/repos` and below it.
    (app) =>
      claim(app, ctx, ['/api/repos', '/api/repos/*'], (v) =>
        handleRepoRoutes(ctx.repoRoutesCtx, v),
      ),
    // routes/load-reports.ts — two exact paths.
    (app) =>
      claim(app, ctx, rowPatterns('load-reports.ts'), (v) =>
        handleLoadReportRoutes(ctx.loadReportRoutesCtx, v),
      ),
    // routes/ops.ts — eight exact paths, four handlers that sat at three
    // positions in the chain. Each handler declines every path but its own,
    // so trying them in turn on the module's rows answers each path with the
    // handler that answered it alone. Each keeps its own visitor, loopback
    // and `cf-ray` refusals in its own order.
    (app) =>
      claim(
        app,
        ctx,
        rowPatterns('ops.ts'),
        async (v) =>
          (await handleSummaryBackfillRoute(ctx.opsRoutesCtx, v)) ??
          handleOpsMetricsRoute(ctx.opsRoutesCtx, v) ??
          handleHomeRemotesRoute(ctx.opsRoutesCtx, v) ??
          (await handleOpsRoutes(ctx.opsRoutesCtx, v)) ??
          handleWebhookLogRoute(ctx.opsRoutesCtx, v),
      ),
    // routes/mounts.ts — `/mounts`, `/mounts/<fileId>…` and `/api/mounts…`.
    (app) =>
      claim(app, ctx, ['/mounts', '/mounts/*', '/api/mounts', '/api/mounts/*'], (v) =>
        handleMountRoutes(ctx.mountRoutesCtx, v),
      ),
    // routes/landing-stream.ts — the workspaces list's change feed.
    (app) =>
      claim(app, ctx, rowPatterns('landing-stream.ts'), (v) =>
        handleLandingStreamRoute(ctx.landingStreamCtx, v),
      ),
    // routes/prompts.ts — its own test is `startsWith('/api/prompts')`.
    (app) =>
      claim(app, ctx, ['/api/:rest{prompts.*}'], (v) => handlePromptRoutes(ctx.promptRoutesCtx, v)),
    // routes/review-queue.ts — five exact paths.
    (app) =>
      claim(app, ctx, rowPatterns('review-queue.ts'), (v) =>
        handleReviewQueueRoutes(ctx.reviewQueueRoutesCtx, v),
      ),
    // routes/voice-page.ts and routes/voice-api.ts — two files, no address
    // in common.
    (app) =>
      claim(app, ctx, rowPatterns('voice-page.ts'), (v) =>
        handleVoicePageRoutes(ctx.voicePageRoutesCtx, v),
      ),
    (app) =>
      claim(app, ctx, rowPatterns('voice-api.ts'), (v) =>
        handleVoiceApiRoutes(ctx.voiceApiRoutesCtx, {
          ...v,
          viaTunnel: () => v.req.headers.has('cf-ray'),
        }),
      ),
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
      claim(app, ctx, rowPatterns('private-messages.ts'), (v) =>
        handlePrivateMessageRoutes(ctx.privateMessageRoutesCtx, v),
      ),
    // routes/coach.ts — its own test is `startsWith('/coach/')`.
    (app) => claim(app, ctx, ['/coach/*'], (v) => handleCoachRoutes(ctx.coachRoutesCtx, v)),
  ];
}
