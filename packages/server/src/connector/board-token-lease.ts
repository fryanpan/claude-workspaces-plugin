/**
 * The board agent token a hosted session opened on a board's socket carries
 * on its REST calls (`session-factory.ts`).
 *
 * The lead's relay holds no token: the socket it connected through names the
 * board, and its profile is what let it connect there. So the server mints
 * one `at2` for that agent and board, in the existing format and record
 * (`auth/board-agent-token.ts`), and keeps it in this process. It is minted
 * at the session's first REST call, renewed past half its life, and revoked
 * when the hosted session is retired. A crash leaves it to expire. One
 * revoked from outside is not replaced: the session's calls are refused
 * until it is retired and a new one opens.
 */
import { BOARD_AGENT_TOKEN_TTL_MS, type BoardAgentTokens } from '../auth/board-agent-token.ts';
import type { BoardTokenLease } from './session-factory.ts';

/** What the label on each record says, so the token list names its holder. */
export const BOARD_SOCKET_SESSION_LABEL = 'board socket session';

export function boardTokenLease(
  tokens: Pick<BoardAgentTokens, 'mint' | 'refresh' | 'revoke'>,
  agentId: string,
  boardId: string,
  log: (line: string) => void,
  now: () => number = Date.now,
): BoardTokenLease {
  let held: { tokenId: string; token: string; expiresAt: number } | null = null;
  return {
    token() {
      if (held && held.expiresAt - now() > BOARD_AGENT_TOKEN_TTL_MS / 2) return held.token;
      try {
        if (held) {
          const renewed = tokens.refresh({ tokenId: held.tokenId, agentId, boardId });
          if (!renewed) return null;
          held = { tokenId: held.tokenId, ...renewed };
          return held.token;
        }
        const minted = tokens.mint(agentId, boardId, BOARD_SOCKET_SESSION_LABEL);
        held = { tokenId: minted.record.id, token: minted.token, expiresAt: minted.expiresAt };
        return held.token;
      } catch (err) {
        log(
          `[board-token-lease] no token for ${agentId} on ${boardId}: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      }
    },
    release() {
      if (held) tokens.revoke(held.tokenId);
      held = null;
    },
  };
}
