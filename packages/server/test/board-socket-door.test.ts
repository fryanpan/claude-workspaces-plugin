/**
 * `middleware/board-socket-door.ts` on its own: what a request on
 * Harborlight's socket may reach, with each kind of caller. The server-level
 * cases, over a real socket, are `board-sockets.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type { BoardAgentClaims } from '../src/auth/board-agent-token.ts';
import {
  BOARD_SOCKET_TOKEN_ID,
  type BoardSocketDoorInput,
  admitBoardSocket,
  boardSocketScopeAllows,
} from '../src/middleware/board-socket-door.ts';

const HARBORLIGHT = 'w-harbor';
const RIVERBEND = 'w-river';
const j = (status: number, body: unknown) => Response.json(body, { status });
const grants: Record<string, BoardAgentClaims> = {
  'at2.harborlight': { tokenId: 't-1', agentId: 'agent-alice', boardId: HARBORLIGHT },
  'at2.riverbend': { tokenId: 't-2', agentId: 'agent-alice', boardId: RIVERBEND },
};

function door(
  path: string,
  o: Partial<BoardSocketDoorInput> & { headers?: Record<string, string> } = {},
) {
  const req = new Request(`http://board${path}`, {
    method: o.req?.method ?? 'GET',
    headers: o.headers,
  });
  return admitBoardSocket({
    req,
    pathname: new URL(req.url).pathname,
    boardId: HARBORLIGHT,
    boardBearer: null,
    agentBearer: undefined,
    grantFor: (b) => grants[b] ?? null,
    agentFor: (b) => (b === 'at1.alice' ? 'agent-alice' : null),
    workspacesOf: () => [],
    j,
    ...o,
  });
}

const status = (v: ReturnType<typeof door>) => (v.ok ? 200 : v.response.status);

describe('admitBoardSocket', () => {
  it('admits its own board with no bearer, as a visitor of that board alone', () => {
    const v = door(`/workspaces/${HARBORLIGHT}/tasks`);
    expect(v).toMatchObject({ ok: true, agent: null, target: { workspaceId: HARBORLIGHT } });
    expect(status(door(`/workspaces/${RIVERBEND}/tasks`))).toBe(403);
  });

  it('holds an at1 to the socket’s board, under the socket’s token id', () => {
    const v = door(`/workspaces/${HARBORLIGHT}/tasks`, { agentBearer: 'at1.alice' });
    expect(v).toMatchObject({
      ok: true,
      agent: { tokenId: BOARD_SOCKET_TOKEN_ID, agentId: 'agent-alice', boardId: HARBORLIGHT },
    });
    expect(status(door(`/workspaces/${RIVERBEND}/tasks`, { agentBearer: 'at1.alice' }))).toBe(403);
    expect(status(door(`/workspaces/${HARBORLIGHT}/tasks`, { agentBearer: 'at1.bob' }))).toBe(401);
  });

  it('takes an at2 only for the socket’s board', () => {
    expect(
      status(door(`/workspaces/${HARBORLIGHT}/tasks`, { boardBearer: 'at2.harborlight' })),
    ).toBe(200);
    expect(status(door(`/workspaces/${HARBORLIGHT}/tasks`, { boardBearer: 'at2.riverbend' }))).toBe(
      403,
    );
    expect(status(door(`/workspaces/${HARBORLIGHT}/tasks`, { boardBearer: 'at2.forged' }))).toBe(
      401,
    );
  });

  it('refuses a browser', () => {
    const v = door(`/workspaces/${HARBORLIGHT}/tasks`, {
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
    });
    expect(status(v)).toBe(403);
  });
});

describe('boardSocketScopeAllows', () => {
  const allows = (path: string, method: string, agent: string | null) =>
    boardSocketScopeAllows(path, method, HARBORLIGHT, agent, () => []);

  it('lets a named agent read and add to its own watch set, and nobody else’s', () => {
    expect(allows('/api/agents/agent-alice/watches', 'GET', 'agent-alice')).toBe(true);
    expect(allows('/api/agents/agent-alice/watches', 'POST', 'agent-alice')).toBe(true);
    expect(allows('/api/agents/agent-alice/watches', 'DELETE', 'agent-alice')).toBe(false);
    expect(allows('/api/agents/agent-bob/watches', 'GET', 'agent-alice')).toBe(false);
    expect(allows('/api/agents/agent-alice/watches', 'GET', null)).toBe(false);
  });

  it('refuses the agent stream, the token mint and the doc list', () => {
    for (const path of ['/events/agent/agent-alice', '/api/board-tokens', '/workspaces', '/mcp'])
      expect(allows(path, 'GET', 'agent-alice'), path).toBe(false);
  });
});
