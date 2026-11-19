/**
 * ── The home feed: one board's review items for Bryan's Home elsewhere ──
 *
 *   GET /workspaces/:ws/home-feed                one board's open items in
 *                                                the fixed schema (`home-feed.ts`)
 *   GET /workspaces/:ws/home-feed/events:stream  `landing.changed` frames, no
 *                                                content, when any item may
 *                                                have moved
 *
 * A project server answers these; the Mac's server is the only intended
 * caller, and it calls OUT (`home-remotes.ts`). Both paths sit under
 * `/workspaces/<board>/` so the board router Worker routes them to the server
 * that holds the board, at its project's own address, with no second table.
 *
 * Answered ABOVE request admission, with a gate of its own, because the
 * Mac's request carries no person. It arrives through Access with a service
 * token, and admission refuses a stamp that names nobody. So this route asks
 * for exactly one of two callers and nothing else:
 *
 *  - a process on this machine: a loopback peer with no `cf-ray`;
 *  - through the tunnel: a stamp signed for the Access application in front
 *    of the host it arrived on (that host's `CF_ACCESS_HOST_AUDS` entry, else
 *    `CF_ACCESS_AUD`, checked against Cloudflare's keys), so a stamp another
 *    project's application minted is refused, that names no email and whose `common_name` is the
 *    service token client id this server was configured with
 *    (`CW_HOME_FEED_CLIENT_ID`). A person's stamp, a share visitor's, or
 *    another service token's is refused.
 *
 *  - through the tunnel, a board agent token (`at2`, `auth/board-agent-token.ts`)
 *    minted for the board this path names, from no browser. Where an Access
 *    application is in front, its stamp must also pass; under
 *    `CW_SIGNIN=better-auth` there is none, and the token is the proof. This
 *    is how the Mac pulls once Access is gone (`home-remotes.ts`
 *    `boardTokens`).
 *
 * With no client id configured and no token presented, only the first caller
 * is admitted. The two
 * answers carry nothing a board member could not read on the board itself,
 * and the stream frames name no board and no content (`landing-changes.ts`).
 */
import { type BoardAgentClaims, boardAgentBearerOf } from '../auth/board-agent-token.ts';
import type { HomeFeed } from '../home-feed.ts';
import { LANDING_CHANNEL } from '../landing-changes.ts';
import type { CfAccessVerifier } from '../middleware/cf-access.ts';
import { isLoopbackAddress } from '../middleware/host-guard.ts';
import { isBrowserRequest } from '../middleware/write-gate.ts';
import { type SseBus, openSseStream } from '../sse.ts';

const FEED_PATH = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/home-feed(\/events:stream)?$/;

export interface HomeFeedRoutesContext {
  sse: SseBus;
  /** The board's name, or undefined when this server holds no such board. */
  boardName: (workspaceId: string) => string | undefined;
  /** The board's feed, read off the cross-board queue. */
  feed: (workspaceId: string) => Promise<HomeFeed>;
  /** The per-host Access verifier, or null when none is configured. */
  verifier: CfAccessVerifier | null;
  /** The Access service token client id the Mac pulls with, or undefined. */
  clientId: string | undefined;
  /** The connection's own peer address. */
  peerAddress: (req: Request) => string | undefined;
  /** The claims an `at2` still attests to, or null. Absent: no token admits. */
  boardGrantFor?: (bearer: string) => BoardAgentClaims | null;
  /** Whether an Access application fronts this server's hosts. */
  accessInFront?: () => boolean;
  j: (status: number, body: unknown) => Response;
}

/** Whether this caller may read a home feed. Never says which check failed. */
export async function homeFeedCallerAllowed(
  ctx: Pick<
    HomeFeedRoutesContext,
    'verifier' | 'clientId' | 'peerAddress' | 'boardGrantFor' | 'accessInFront'
  >,
  req: Request,
  /** The board the path names; without one, no board token admits. */
  boardId?: string,
): Promise<boolean> {
  if (!req.headers.has('cf-ray')) return isLoopbackAddress(ctx.peerAddress(req));
  const bearer = boardAgentBearerOf(req.headers);
  if (bearer !== null) {
    if (!boardId || !ctx.boardGrantFor || isBrowserRequest(req.headers)) return false;
    if (ctx.boardGrantFor(bearer)?.boardId !== boardId) return false;
    if (ctx.accessInFront?.() === false) return true;
    return ctx.verifier !== null && (await ctx.verifier(req)).ok;
  }
  if (!ctx.verifier || !ctx.clientId) return false;
  const result = await ctx.verifier(req);
  return result.ok && result.email === undefined && result.commonName === ctx.clientId;
}

export async function handleHomeFeedRoute(
  ctx: HomeFeedRoutesContext,
  req: Request,
  pathname: string,
): Promise<Response | null> {
  const m = FEED_PATH.exec(pathname);
  if (!m) return null;
  const boardId = m[1] as string;
  if (!(await homeFeedCallerAllowed(ctx, req, boardId))) {
    return ctx.j(403, { error: 'forbidden' });
  }
  if (req.method !== 'GET') return ctx.j(405, { error: 'method-not-allowed' });
  if (ctx.boardName(boardId) === undefined) return ctx.j(404, { error: 'not_found' });
  if (m[2]) return openSseStream(ctx.sse, LANDING_CHANNEL);
  return ctx.j(200, await ctx.feed(boardId));
}
