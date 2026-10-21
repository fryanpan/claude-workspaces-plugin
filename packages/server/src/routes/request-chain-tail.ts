/**
 * ── The request chain, last third: the top-level families and the tail ──
 *
 * The families that belong to the server rather than to one board — the
 * prompt settings, the workspaces list's stream, the cross-board review
 * queue, the voice page and API, the registered features (`features.ts`),
 * the goal coach and the webhook log — and then the tail: the shell and
 * static serving, the task address, the stale-client 410, the wrong-prefix
 * hint, the board's own not-found page and the bare 404. Moved whole and in
 * order out of `createServer`'s `route()`; see `request-chain.ts` for why the
 * order is behaviour.
 *
 * The registered features sit where the Incoming Messages routes sat, which
 * was the first family moved behind them: below the voice API, above the
 * coach. Each family above and below claims a prefix nothing else answers,
 * so a registered family added there shadows nothing.
 *
 * Always answers: the last line is the 404.
 */
import { handleCoachRoutes } from './coach.ts';
import { handleLandingStreamRoute } from './landing-stream.ts';
import { handleWebhookLogRoute } from './ops.ts';
import { handlePromptRoutes } from './prompts.ts';
import type { ChainRequest, RequestChainContext } from './request-chain-context.ts';
import { handleReviewQueueRoutes } from './review-queue.ts';
import { handleStaleClient } from './stale-client.ts';
import { handleTaskPageRoutes } from './task-page.ts';
import { handleVoiceApiRoutes } from './voice-api.ts';
import { handleVoicePageRoutes } from './voice-page.ts';
import { handleWorkspaceNotFound } from './workspace-not-found.ts';
import { handleWrongPrefix } from './wrong-prefix.ts';

export async function serveTopLevelRoutes(
  ctx: RequestChainContext,
  rq: ChainRequest,
): Promise<Response> {
  const {
    promptRoutesCtx,
    sse,
    j,
    reviewQueueRoutesCtx,
    voicePageRoutesCtx,
    voiceApiRoutesCtx,
    requireSignInToWrite,
    policyFor,
    featureRoutes,
    coachRoutesCtx,
    opsRoutesCtx,
    serveShellRoutes,
  } = ctx;
  const { req, url, pathname, gate, attribution, ownerProven } = rq;
  const { visitor, visitorHome } = gate;
  const { authorFor, provenIdentityFor, browserProvedNobody } = attribution;

  // --- REST: the prompt settings --- see ./routes/prompts.ts.
  // Top-level rather than under a board: `/settings/prompts` is a page
  // outside any board, and five of the seven prompts belong to the
  // server rather than to one of them.
  {
    const handled = await handlePromptRoutes(promptRoutesCtx, {
      req,
      pathname,
      visitor,
      authorFor,
    });
    if (handled) return handled;
  }

  // --- SSE: the workspaces list's change feed --- see
  // ./routes/landing-stream.ts. Top-level, like `/` it serves.
  {
    const handled = handleLandingStreamRoute({ sse, j }, { req, pathname, visitor });
    if (handled) return handled;
  }

  // --- REST + page: the cross-board review queue --- see
  // ./routes/review-queue.ts. Top-level for the prompts' reason: it is
  // about every board, not one.
  {
    const handled = await handleReviewQueueRoutes(reviewQueueRoutesCtx, {
      req,
      pathname,
      url,
      visitor,
    });
    if (handled) return handled;
  }

  // --- Page + REST: the voice page --- see ./routes/voice-page.ts.
  // Top-level for the review queue's reason; claims `/voice` and
  // `/api/voice/agents` alone, which nothing above answers.
  {
    const handled = handleVoicePageRoutes(voicePageRoutesCtx, {
      req,
      pathname,
      visitor,
      ownerProven: () => ownerProven(),
      anyoneProven: () => provenIdentityFor() !== null,
      mustSignIn: () => requireSignInToWrite && browserProvedNobody(),
    });
    if (handled) return handled;
  }

  // --- REST: the voice conversation API --- see ./routes/voice-api.ts.
  // Claims `/v1/models`, `/v1/chat/completions` and `/api/voice/tokens`
  // alone; nothing above answers them.
  {
    const handled = await handleVoiceApiRoutes(voiceApiRoutesCtx, {
      req,
      pathname,
      visitor,
      ownerProven: () => ownerProven(),
      anyoneProven: () => provenIdentityFor() !== null,
      mustSignIn: () => requireSignInToWrite && browserProvedNobody(),
      requestOrigin: () => policyFor(req).requestOrigin,
      viaTunnel: () => req.headers.has('cf-ray'),
    });
    if (handled) return handled;
  }

  // --- The registered features --- see ./features.ts. At the position
  // Incoming Messages held, the first family moved behind them: messages
  // are the owner's, not a board's, and `/inbox/` is a prefix nothing above
  // answers. Every family registered there claims a prefix of its own.
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

  // --- REST: the goal coach --- see ./routes/coach.ts. Top-level for
  // the inbox's reason: the goals are the owner's, not a board's.
  // Claims `/coach/` alone, which nothing above answers.
  {
    const handled = await handleCoachRoutes(coachRoutesCtx, {
      req,
      pathname,
      visitor,
      ownerProven: () => ownerProven(),
      requestOrigin: () => policyFor(req).requestOrigin,
    });
    if (handled) return handled;
  }

  // --- Web log --- see ./routes/ops.ts. Same chain position as before
  // the split: under the doc resource routes, above the shell tail.
  {
    const handled = handleWebhookLogRoute(opsRoutesCtx, {
      req,
      pathname,
      visitor,
      authorFor,
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
