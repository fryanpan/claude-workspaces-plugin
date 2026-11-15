/**
 * ── The request chain, last third: the top-level families and the tail ──
 *
 * The families that belong to the server rather than to one board and are
 * still on the chain — the workspaces list's stream, the git-push feature
 * (`features.ts`) and private messages — and then the tail: the shell and
 * static serving, the task address, the stale-client 410, the wrong-prefix
 * hint, the board's own not-found page and the bare 404. Moved whole and in
 * order out of `createServer`'s `route()`; see `request-chain.ts` for why
 * the order is behaviour.
 *
 * The prompt settings, the cross-board review queue, the voice page and API,
 * the access page, Incoming Messages, the keeper holds, the goal coach and
 * the webhook log were here too, interleaved with these. They are answered
 * by Hono now (`hono-families.ts`), which is tried above the whole chain
 * below the gates; each claims paths nothing in the chain answers, so taking
 * them out of this run reorders nothing that is left.
 *
 * Always answers: the last line is the 404.
 */
import { handleBoardLinkRoutes } from './board-links.ts';
import { handleLandingStreamRoute } from './landing-stream.ts';
import { handlePrivateMessageRoutes } from './private-messages.ts';
import type { ChainRequest, RequestChainContext } from './request-chain-context.ts';
import { handleStaleClient } from './stale-client.ts';
import { handleTaskPageRoutes } from './task-page.ts';
import { handleWorkspaceNotFound } from './workspace-not-found.ts';
import { handleWrongPrefix } from './wrong-prefix.ts';

export async function serveTopLevelRoutes(
  ctx: RequestChainContext,
  rq: ChainRequest,
): Promise<Response> {
  const {
    sse,
    j,
    policyFor,
    featureRoutes,
    privateMessageRoutesCtx,
    serveShellRoutes,
    boardLinkRoutesCtx,
  } = ctx;
  const { req, url, pathname, gate, attribution, ownerProven } = rq;
  const { visitor, visitorHome, boardAgent } = gate;
  const { provenIdentityFor } = attribution;

  // --- SSE: the workspaces list's change feed --- see
  // ./routes/landing-stream.ts. Top-level, like `/` it serves.
  {
    const handled = handleLandingStreamRoute({ sse, j }, { req, pathname, visitor });
    if (handled) return handled;
  }

  // --- The registered features still on the chain --- see ./features.ts.
  // Git push alone: it claims `/workspaces/<board>/git/`, which sits below
  // the workspace scope above. Incoming Messages and the keeper holds were
  // here too and are answered by Hono now (hono-families.ts).
  {
    const handled = await featureRoutes({
      req,
      pathname,
      visitor,
      ownerProven: () => ownerProven(),
      requestOrigin: () => policyFor(req).requestOrigin,
    });
    if (handled) return handled;
  }

  // --- REST: private messages --- see ./routes/private-messages.ts. Here
  // rather than in the board chain because `/api/me/messages` names no board,
  // and beside the features for the inbox's reason: a person's own, not a
  // board's. `/api/me/` and `/api/agents/<id>/messages/` are claimed by
  // nothing above.
  {
    const handled = await handlePrivateMessageRoutes(privateMessageRoutesCtx, {
      req,
      pathname,
      visitor,
      boardAgent,
      provenIdentityFor,
    });
    if (handled) return handled;
  }

  // ── Shell and static serving ── see routes/shell-static.ts.
  // The tail of the router: an HTML shell, a built asset, a mockup's
  // own file, or a redirect to the address that has one. Null means no
  // block there claimed this address, which is the same fall-through
  // the run did in place, and it lands on the 404 below.
  const shell = await serveShellRoutes({
    req,
    url,
    pathname,
    visitor,
    visitorHome,
    ownerProven: ownerProven(),
    isBoardOwner: (workspaceId) => gate.requireOwner(workspaceId) === null,
    mayMintAppVoice: rq.mayMintAppVoice(),
  });
  if (shell) return shell;

  // ── The task address ── see routes/task-page.ts. Below the shell
  // because it answers no page of its own, and below every task route so
  // it shadows none of them: what reaches here is the BARE
  // `/workspaces/<ws>/tasks/<taskId>`, which is the API prefix rather
  // than an address, and it redirects to the board with that task open.
  const taskPage = handleTaskPageRoutes({ method: req.method, pathname, url });
  if (taskPage) return taskPage;

  // ── Board links in the wrong form ── see routes/board-links.ts. Beside
  // the task address and for its reason: `review/<id>`, an escaped `?` and
  // `open?path=` are addresses no route above claims, each redirected to the
  // page it names or answered with a page naming it.
  const boardLink = handleBoardLinkRoutes(boardLinkRoutesCtx, {
    method: req.method,
    pathname,
    url,
  });
  if (boardLink) return boardLink;

  // ── Stale-client 410 ── see routes/stale-client.ts. Above the
  // wrong-prefix hint and below everything that exists: an address the
  // pre-cutover client used is told the client is behind, rather than
  // getting the bare 404 a deleted board also answers.
  const stale = handleStaleClient(pathname);
  if (stale) return stale;

  // ── Wrong-prefix 404 ── see routes/wrong-prefix.ts. Below everything
  // that exists, so it shadows nothing: a guess at a board route with
  // `/api` in front is told the address without it.
  const wrongPrefix = handleWrongPrefix(pathname);
  if (wrongPrefix) return wrongPrefix;

  // ── The board's own not-found page ── see routes/workspace-not-found.ts.
  // The last thing tried, so it shadows nothing: a browser that asked for
  // an address under a board nothing serves gets a PAGE saying the link is
  // wrong and linking back to the board, rather than the bodyless 404
  // below — which Chrome paints as ERR_INVALID_RESPONSE, indistinguishable
  // from the server being down.
  const wsNotFound = handleWorkspaceNotFound({ pathname, method: req.method, url });
  if (wsNotFound) return wsNotFound;

  return new Response('not found', { status: 404 });
}
