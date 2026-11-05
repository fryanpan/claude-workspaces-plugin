/**
 * A keeper client tells this server that a request waits for Bryan's
 * passkey (`keeper/keeper-announce.ts`), so it shows on his Home.
 *
 *   POST /api/keeper/holds   body: { id, pollToken, requester }
 *
 * Who may call: a loopback TCP peer, with no `cf-ray`, no browser headers,
 * not a share visitor and not a board's own socket. That is every process on
 * this Mac, so the post is a claim and not a fact. `KeeperHomeCards` files a
 * card only after the keeper itself says the request is pending, and writes
 * the card and its link from the keeper's answer.
 */
import type { FeatureRequest } from '../feature-module.ts';
import { HOLDS_PATH } from '../keeper/keeper-announce.ts';
import type { KeeperHomeCards } from '../keeper/keeper-home-card.ts';
import { isLoopbackAddress } from '../middleware/host-guard.ts';
import { browserCannotOperateBody, isBrowserRequest } from '../middleware/write-gate.ts';

export interface KeeperHoldsRoutesContext {
  /** Null when this server has no keeper (`CW_KEEPER_URL` unset). */
  cards: KeeperHomeCards | null;
  requestAddress: (req: Request) => string | undefined;
  boardOfSocket: (req: Request) => string | null;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
}

export async function handleKeeperHoldsRoutes(
  ctx: KeeperHoldsRoutesContext,
  rq: FeatureRequest,
): Promise<Response | null> {
  const { req, pathname, visitor } = rq;
  if (pathname !== HOLDS_PATH) return null;
  const { j } = ctx;
  if (req.method.toUpperCase() !== 'POST') return j(405, { error: 'method not allowed' });
  if (visitor) return j(403, { error: 'not available to share visitors' });
  if (ctx.boardOfSocket(req) !== null || !isLoopbackAddress(ctx.requestAddress(req))) {
    return j(403, { error: 'keeper holds are posted from this machine only (loopback)' });
  }
  if (req.headers.has('cf-ray')) {
    return j(403, { error: 'keeper holds cannot be posted through the edge' });
  }
  if (isBrowserRequest(req.headers)) return j(403, browserCannotOperateBody());
  if (!ctx.cards) return j(501, { error: 'this server has no keeper (CW_KEEPER_URL is unset)' });
  const body = await ctx.safeJson(req);
  if (!body) return j(400, { error: 'body must be a JSON object' });
  const res = await ctx.cards.announce({
    id: body.id,
    pollToken: body.pollToken,
    requester: body.requester,
  });
  return 'error' in res
    ? j(res.status, { error: res.error })
    : j(res.status, { itemId: res.itemId });
}
