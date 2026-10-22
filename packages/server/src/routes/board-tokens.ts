/**
 * The board-scoped agent token's administration (`auth/board-agent-token.ts`):
 *
 *   GET  /api/board-tokens              every record, without token values
 *   POST /api/board-tokens              mint one: `{ agentId, boardId, label? }`;
 *                                       the value is returned once
 *   POST /api/board-tokens/<id>/revoke  revoke one, and hang up what it opened
 *   POST /api/board-tokens/refresh      a fresh value for the live `at2` presented
 *
 * Loopback only, for the person or lead at this machine's keyboard. All three
 * refuse a request through the edge (`cf-ray`), from a peer address that is
 * not loopback, from a browser, and from any visitor — which includes every
 * `at2` holder, so a token can never mint, list or revoke tokens. A page on
 * this machine also has a loopback peer address and rides the owner's
 * cookie; refusing a browser is what stops one minting a token for itself.
 *
 * Refresh is the one exception, and it is the holder's own: it answers only a
 * request the `at2` door admitted (`middleware/board-agent-door.ts`), so the
 * caller already proved a live token, and it answers a new value for that
 * same record and nothing wider. A revoked or expired token never reaches it.
 */
import { SHARED_AGENT_IDS } from '../agent-watches.ts';
import { refuseNonLocalAgentCaller } from '../auth/agent-token.ts';
import {
  type BoardAgentTokens,
  boardAgentMemberKey,
  isValidBoardId,
  isValidBoardTokenId,
} from '../auth/board-agent-token.ts';
import type { BoardAgentClaims } from '../auth/board-agent-token.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';

export interface BoardTokenRoutesContext {
  tokens: BoardAgentTokens;
  /** Whether a board of this id exists here. */
  boardExists: (boardId: string) => boolean;
  /** The roster row a mint makes sure of, so writes carry the agent's name.
   *  False when the id cannot be an agent (a person's id, the shared one). */
  ensureAgent: (agentId: string) => boolean;
  /** Hang up every socket and stream stamped with this key; the count. */
  closeConnections: (memberKey: string) => number;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  requestAddress: (req: Request) => string | undefined;
}

export interface BoardTokenRouteRequest {
  req: Request;
  pathname: string;
  visitor: ShareTarget | null;
  /** The agent and board an `at2` bearer on this request proved, or null. */
  boardAgent: BoardAgentClaims | null;
}

export const BOARD_TOKEN_REFRESH_PATH = '/api/board-tokens/refresh';

const REVOKE_PATH = /^\/api\/board-tokens\/([^/]+)\/revoke$/;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function handleBoardTokenRoutes(
  ctx: BoardTokenRoutesContext,
  rq: BoardTokenRouteRequest,
): Promise<Response | null> {
  const { req, pathname, visitor } = rq;
  const { j } = ctx;
  if (pathname === BOARD_TOKEN_REFRESH_PATH) {
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    if (!rq.boardAgent) return j(401, { error: 'board_token_required' });
    const fresh = ctx.tokens.refresh(rq.boardAgent);
    if (!fresh) return j(401, { error: 'board_token_invalid' });
    return j(200, { ok: true, ...fresh });
  }
  const revoke = pathname.match(REVOKE_PATH);
  if (pathname !== '/api/board-tokens' && !revoke) return null;
  if (visitor) return j(403, { error: 'not available to share visitors' });
  const notLocal = refuseNonLocalAgentCaller(req, ctx.requestAddress(req));
  if (notLocal) {
    // The same three refusals, named for this route: `agent-stream-proxied`
    // becomes `board-token-proxied`, and so on.
    return j(notLocal.status, {
      error: notLocal.body.error.replace('agent-stream-', 'board-token-'),
      message: 'Board tokens are minted, listed and revoked from this machine only (loopback).',
    });
  }

  if (revoke) {
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    const id = revoke[1] ?? '';
    if (!isValidBoardTokenId(id)) return j(400, { error: 'bad token id' });
    const record = ctx.tokens.revoke(id);
    if (!record) return j(404, { error: 'not_found' });
    // The token stops verifying on its next request; this ends the
    // connections it already holds open, which were authorized once.
    const closed = ctx.closeConnections(boardAgentMemberKey(record.boardId, record.id));
    return j(200, { ok: true, record, ...(closed ? { closed } : {}) });
  }

  if (req.method === 'GET') return j(200, { tokens: ctx.tokens.list() });
  if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
  const body = await ctx.safeJson(req);
  const agentId = body?.agentId;
  const boardId = body?.boardId;
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId) || SHARED_AGENT_IDS.has(agentId)) {
    return j(400, { error: 'bad agentId' });
  }
  if (!isValidBoardId(boardId)) return j(400, { error: 'bad boardId' });
  if (!ctx.boardExists(boardId)) return j(404, { error: 'unknown_workspace', boardId });
  if (!ctx.ensureAgent(agentId)) return j(400, { error: 'not an agent id', agentId });
  const label = typeof body?.label === 'string' ? body.label : '';
  const { record, token, expiresAt } = ctx.tokens.mint(agentId, boardId, label);
  return j(201, { ...record, token, expiresAt });
}
