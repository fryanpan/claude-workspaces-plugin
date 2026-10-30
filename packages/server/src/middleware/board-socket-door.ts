/**
 * The door a request on a board's own socket (`board-sockets.ts`) comes in
 * through, and what it may reach once in.
 *
 * The socket names the board: the lead's sandbox profile lets it connect to
 * its own board's socket and to no other (`scripts/lead-sandbox-wall.ts`).
 * So no bearer is needed. What one may add is who the caller is:
 *
 * - an `at1` (`auth/agent-token.ts`) names the agent, and the request is
 *   held to the socket's board as a board agent token's would be;
 * - an `at2` (`auth/board-agent-token.ts`) is judged as everywhere else, and
 *   must name this socket's board, or a token for another board would open
 *   that board through this socket;
 * - no bearer is a board visitor with no agent: it reads, and writes as a
 *   guest.
 *
 * One path is let through that `collabScope` refuses: `/mcp`, the hosted
 * connector. `routes/mcp-connector.ts` opens a session there held to this
 * socket's board, whose REST calls carry a board agent token the server
 * mints and keeps in its own process (`connector/board-token-lease.ts`). So
 * the relay a walled lead runs needs no token of its own.
 *
 * The socket is a lead's (`middleware/lead-scope.ts`), so on this board it
 * also reaches task notes and the plugin hooks' notes and prompt marks,
 * which `collabScope` refuses a member. The doc list, a whole-doc rewrite
 * and a folder bind stay refused: each has the server act on files the
 * lead can write.
 *
 * Every other case reaches `collabScope` with the socket's board as the only board
 * it is a member of, plus, for a named agent, its own watch set cut to that
 * board (`routes/agent-identity.ts`, `boardWatches`). An agent's stream
 * across boards (`/events/agent/<id>`), the token mint, the doc list and every
 * other board stay refused by those lines. A browser is refused.
 */
import type { BoardAgentClaims } from '../auth/board-agent-token.ts';
import { boardAgentMemberKey } from '../auth/board-agent-token.ts';
import { type ShareTarget, collabScope } from './host-guard.ts';
import { leadScopeAllows } from './lead-scope.ts';
import { isBrowserRequest } from './write-gate.ts';

/**
 * The token id a socket-proved agent carries in place of a board token's.
 * Not a record: nothing revokes it, and `routes/doc-threads-routes.ts` keeps
 * the relay's opener proofs to real `at2` holders by checking for it.
 */
export const BOARD_SOCKET_TOKEN_ID = 'board-socket';

export interface BoardSocketDoorInput {
  req: Request;
  pathname: string;
  /** The board whose socket the request arrived on. */
  boardId: string;
  /** The `at2` presented, or null. */
  boardBearer: string | null;
  /** The `at1` presented, or undefined. */
  agentBearer: string | undefined;
  /** What an `at2` still grants, or null. */
  grantFor: (bearer: string) => BoardAgentClaims | null;
  /** The agent an `at1` names, or null. */
  agentFor: (bearer: string) => string | null;
  workspacesOf: (id: string) => string[];
  j: (status: number, body: unknown) => Response;
}

export type BoardSocketDoorVerdict =
  | { ok: false; response: Response }
  | { ok: true; agent: BoardAgentClaims | null; target: ShareTarget; memberKey: string };

const WATCHES_PATH = /^\/api\/agents\/([^/]+)\/watches$/;

/** The hosted connector's path (`routes/mcp-connector.ts`'s `MCP_CONNECTOR_PATH`). */
const MCP_PATH = '/mcp';
const MCP_METHODS = new Set(['GET', 'POST', 'DELETE']);

/** May a caller on `boardId`'s socket reach this path, as `agentId` if named? */
export function boardSocketScopeAllows(
  pathname: string,
  method: string,
  boardId: string,
  agentId: string | null,
  workspacesOf: (id: string) => string[],
): boolean {
  if (pathname === MCP_PATH) return MCP_METHODS.has(method.toUpperCase());
  const watches = pathname.match(WATCHES_PATH);
  if (watches) {
    const m = method.toUpperCase();
    return (
      agentId !== null && decoded(watches[1] ?? '') === agentId && (m === 'GET' || m === 'POST')
    );
  }
  if (leadScopeAllows(pathname, method, boardId, workspacesOf)) return true;
  const scope = collabScope(pathname, method, {
    workspacesOf,
    isMember: (workspaceId) => workspaceId === boardId,
  });
  return scope.allowed && scope.target.workspaceId === boardId;
}

export function admitBoardSocket(input: BoardSocketDoorInput): BoardSocketDoorVerdict {
  const { req, pathname, boardId, j } = input;
  const refuse = (status: number, error: string): BoardSocketDoorVerdict => ({
    ok: false,
    response: j(status, { error }),
  });
  if (isBrowserRequest(req.headers)) return refuse(403, 'board_socket_browser');
  let agent: BoardAgentClaims | null = null;
  if (input.boardBearer !== null) {
    const grant = input.grantFor(input.boardBearer);
    if (!grant) return refuse(401, 'board_token_invalid');
    if (grant.boardId !== boardId) return refuse(403, 'out_of_board_socket_scope');
    agent = grant;
  } else if (input.agentBearer !== undefined) {
    const agentId = input.agentFor(input.agentBearer);
    if (!agentId) return refuse(401, 'agent_token_invalid');
    agent = { tokenId: BOARD_SOCKET_TOKEN_ID, agentId, boardId };
  }
  if (
    !boardSocketScopeAllows(
      pathname,
      req.method,
      boardId,
      agent?.agentId ?? null,
      input.workspacesOf,
    )
  )
    return refuse(403, 'out_of_board_socket_scope');
  return {
    ok: true,
    agent,
    target: { workspaceId: boardId },
    memberKey: boardAgentMemberKey(boardId, agent?.tokenId ?? BOARD_SOCKET_TOKEN_ID),
  };
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
