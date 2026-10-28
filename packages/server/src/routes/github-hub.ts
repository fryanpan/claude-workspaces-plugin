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
 * request names nobody, and admission refuses a stamp that names nobody.
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
import { type HomeFeedRoutesContext, homeFeedCallerAllowed } from './home-feed.ts';

const LOCAL_SUBSCRIPTIONS = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/github-subscriptions$/;
const RELAY_PATH = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/github\/(subscriptions|events)$/;
export const GITHUB_PUSH_KEYS_PATH = '/api/github-push-keys';

export interface GithubHubRoutesContext {
  hub: GithubHub;
  boardExists: (boardId: string) => boolean;
  /** The home feed's caller check, which these routes share. */
  caller: Pick<HomeFeedRoutesContext, 'verifier' | 'clientId' | 'peerAddress'>;
  /** Send the frame to every agent on the board; how many streams it reached. */
  deliver: (boardId: string, frame: Record<string, unknown> & { event: string }) => number;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  now?: () => number;
}

export async function handleGithubHubRoute(
  ctx: GithubHubRoutesContext,
  req: Request,
  pathname: string,
): Promise<Response | null> {
  const { j } = ctx;
  if (pathname === GITHUB_PUSH_KEYS_PATH) {
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

  const local = LOCAL_SUBSCRIPTIONS.exec(pathname);
  if (local) {
    const refused = refuseLocal(ctx, req);
    if (refused) return refused;
    const boardId = local[1] as string;
    if (!ctx.boardExists(boardId)) return j(404, { error: 'not_found' });
    if (req.method === 'GET') {
      return j(200, { workspaceId: boardId, subscriptions: ctx.hub.subscriptions(boardId) });
    }
    if (req.method !== 'PUT') return j(405, { error: 'method-not-allowed' });
    const parsed = parseGithubSubscriptions((await ctx.safeJson(req))?.subscriptions);
    if (typeof parsed === 'string') return j(400, { error: parsed });
    return j(200, {
      workspaceId: boardId,
      subscriptions: ctx.hub.setSubscriptions(boardId, parsed),
    });
  }

  const relay = RELAY_PATH.exec(pathname);
  if (!relay) return null;
  if (req.headers.has('cookie')) return j(403, { error: 'forbidden' });
  if (!(await homeFeedCallerAllowed(ctx.caller, req))) return j(403, { error: 'forbidden' });
  const boardId = relay[1] as string;
  // Key before board: a caller without this board's key learns nothing,
  // not even whether a board of that id is held here.
  if (!ctx.hub.verifyKey(githubPushBearerOf(req.headers), boardId)) {
    return j(401, { error: 'push_key_required' });
  }
  if (!ctx.boardExists(boardId)) return j(404, { error: 'not_found' });
  if (relay[2] === 'subscriptions') {
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
