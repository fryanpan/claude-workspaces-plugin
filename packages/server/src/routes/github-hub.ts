/**
 * ── GitHub events for a board that holds no GitHub token ──
 *
 *   POST /api/github-push-keys                    mint the board's push key:
 *                                                 `{ workspaceId }`; the value
 *                                                 is returned once
 *   GET|PUT /workspaces/:ws/github-subscriptions  read or replace the board's
 *                                                 list (`set_github_subscriptions`)
 *   GET  /workspaces/:ws/github/subscriptions     the list, for the relay
 *   POST /workspaces/:ws/github/events            one event, for the relay
 *
 * The first two are for this machine: a loopback peer with no `cf-ray` and
 * no browser marks (`refuseNonLocalAgentCaller`), which is the board's own
 * agents and the person at its keyboard. Nothing through the edge, no
 * browser, no visitor.
 *
 * The last two are the relay's, and each needs two things. The caller is the
 * one the home feed admits (`homeFeedCallerAllowed`): a loopback peer, or
 * through the tunnel an Access stamp for this host's application that names
 * no email and whose `common_name` is the service token the Mac calls out
 * with. And the request carries this board's live push key
 * (`auth/github-push-key.ts`). A request with a cookie is refused before
 * either, because the relay never sends one and every share or collab
 * visitor does; a visitor's Access stamp names an email, so it fails the
 * caller check too.
 *
 * Answered ABOVE request admission, for the home feed's reason: the relay's
 * request names nobody, and admission refuses a stamp that names nobody. So
 * the relay's two routes ask the external-access master switch themselves,
 * first (`refuseWhileExternalAccessOff`): while it is off, nothing through the
 * tunnel reads a subscription list or posts an event, key or no key. The
 * first two are this machine's only, so the switch has nothing to add there.
 *
 * A pushed event is checked against the board's list here, whatever the
 * relay thought, and reaches each agent holding a stream on the board as one
 * addressed `workspace.github_event` frame. Pages never receive it.
 */
import { refuseNonLocalAgentCaller } from '../auth/agent-token.ts';
import { githubPushBearerOf } from '../auth/github-push-key.ts';
import {
  GITHUB_EVENT,
  type GithubHub,
  parseGithubEventPush,
  parseGithubSubscriptions,
} from '../github-hub.ts';
import {
  type HomeFeedRoutesContext,
  homeFeedCallerAllowed,
  refuseWhileExternalAccessOff,
} from './home-feed.ts';
import { sent } from './route-contract.ts';
import { type RouteRow, rowHandlers } from './row-dispatch.ts';
import type { GithubSubscriptionsBody } from './workspace-board-contract.ts';

/** A board id this family answers for: any other segment in its place is not its address. */
const BOARD_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const GITHUB_PUSH_KEYS_PATH = '/api/github-push-keys';

export interface GithubHubRoutesContext {
  hub: GithubHub;
  boardExists: (boardId: string) => boolean;
  /** The home feed's caller check, which these routes share. */
  caller: Pick<
    HomeFeedRoutesContext,
    'verifier' | 'clientId' | 'peerAddress' | 'externalAccessOpen' | 'j'
  >;
  /** Send the frame to every agent on the board; how many streams it reached. */
  deliver: (boardId: string, frame: Record<string, unknown> & { event: string }) => number;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  now?: () => number;
}

export async function handleGithubHubRoute(
  ctx: GithubHubRoutesContext,
  req: Request,
  row: RouteRow,
): Promise<Response | null> {
  return ROWS(ctx, { req, row });
}

type Rq = { req: Request; row: RouteRow };

const ROWS = rowHandlers<GithubHubRoutesContext, Rq, Promise<Response | null>>('github-hub.ts', {
  [GITHUB_PUSH_KEYS_PATH]: pushKeys,
  '/workspaces/:ws/github-subscriptions': localSubscriptions,
  '/workspaces/:ws/github/subscriptions': (ctx, rq) => relayRoute(ctx, rq, 'subscriptions'),
  '/workspaces/:ws/github/events': (ctx, rq) => relayRoute(ctx, rq, 'events'),
});

/** `POST /api/github-push-keys` — mint a board's push key, from this machine. */
async function pushKeys(ctx: GithubHubRoutesContext, { req }: Rq): Promise<Response> {
  const { j } = ctx;
  const local = refuseLocal(ctx, req);
  if (local) return local;
  if (req.method !== 'POST') return j(405, { error: 'method-not-allowed' });
  const body = await ctx.safeJson(req);
  const boardId = body?.workspaceId;
  if (typeof boardId !== 'string' || !ctx.boardExists(boardId)) {
    return j(404, { error: 'not_found' });
  }
  return j(200, { workspaceId: boardId, ...ctx.hub.mintKey(boardId) });
}

/** A board's own subscriptions, read and set from this machine. */
async function localSubscriptions(
  ctx: GithubHubRoutesContext,
  { req, row }: Rq,
): Promise<Response | null> {
  const { j } = ctx;
  const boardId = row.params.ws ?? '';
  if (!BOARD_ID.test(boardId)) return null;
  const refused = refuseLocal(ctx, req);
  if (refused) return refused;
  if (!ctx.boardExists(boardId)) return j(404, { error: 'not_found' });
  if (req.method === 'GET') {
    return j(200, { workspaceId: boardId, subscriptions: ctx.hub.subscriptions(boardId) });
  }
  if (req.method !== 'PUT') return j(405, { error: 'method-not-allowed' });
  const parsed = parseGithubSubscriptions(
    sent<GithubSubscriptionsBody>(await ctx.safeJson(req))?.subscriptions,
  );
  if (typeof parsed === 'string') return j(400, { error: parsed });
  return j(200, {
    workspaceId: boardId,
    subscriptions: ctx.hub.setSubscriptions(boardId, parsed),
  });
}

/** The relay's read of a board's subscriptions, and its event pushes. */
async function relayRoute(
  ctx: GithubHubRoutesContext,
  { req, row }: Rq,
  verb: 'subscriptions' | 'events',
): Promise<Response | null> {
  const { j } = ctx;
  const boardId = row.params.ws ?? '';
  if (!BOARD_ID.test(boardId)) return null;
  const shut = refuseWhileExternalAccessOff(ctx.caller, req);
  if (shut) return shut;
  if (req.headers.has('cookie')) return j(403, { error: 'forbidden' });
  if (!(await homeFeedCallerAllowed(ctx.caller, req))) return j(403, { error: 'forbidden' });
  // Key before board: a caller without this board's key learns nothing,
  // not even whether a board of that id is held here.
  if (!ctx.hub.verifyKey(githubPushBearerOf(req.headers), boardId)) {
    return j(401, { error: 'push_key_required' });
  }
  if (!ctx.boardExists(boardId)) return j(404, { error: 'not_found' });
  if (verb === 'subscriptions') {
    if (req.method !== 'GET') return j(405, { error: 'method-not-allowed' });
    return j(200, { workspaceId: boardId, subscriptions: ctx.hub.subscriptions(boardId) });
  }
  if (req.method !== 'POST') return j(405, { error: 'method-not-allowed' });
  const push = parseGithubEventPush(await ctx.safeJson(req));
  if (typeof push === 'string') return j(400, { error: push });
  if (!ctx.hub.wants(boardId, push.repo, push.kind)) {
    // Answered, not failed: the relay's copy of the list is stale, and a
    // retry would be refused the same way.
    return j(200, { delivered: false, reason: 'not_subscribed' });
  }
  if (!ctx.hub.firstSight(boardId, push.id)) {
    return j(200, { delivered: false, reason: 'duplicate' });
  }
  const reached = ctx.deliver(boardId, {
    event: GITHUB_EVENT,
    workspaceId: boardId,
    eventId: push.id,
    repo: push.repo,
    kind: push.kind,
    text: push.text,
    ts: (ctx.now ?? Date.now)(),
  });
  return j(200, { delivered: true, reached });
}

function refuseLocal(ctx: GithubHubRoutesContext, req: Request): Response | null {
  const notLocal = refuseNonLocalAgentCaller(req, ctx.caller.peerAddress(req));
  if (!notLocal) return null;
  return ctx.j(notLocal.status, {
    error: notLocal.body.error.replace('agent-stream', 'github-hub'),
    message: 'GitHub subscriptions and push keys are set on this machine only.',
  });
}
