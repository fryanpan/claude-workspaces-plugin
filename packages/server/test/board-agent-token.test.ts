/**
 * Unit cases for the board agent token (`auth/board-agent-token.ts`) and the
 * door that admits it (`middleware/board-agent-door.ts`). The route-level
 * cases are board-agent-token-routes.test.ts.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentTokenKey, mintAgentToken } from '../src/auth/agent-token.ts';
import {
  BOARD_AGENT_TOKEN_TTL_MS,
  BoardAgentTokens,
  boardAgentBearerOf,
  boardAgentMemberKey,
  boardAgentToken,
  boardAgentTokenKey,
  boardTokensPath,
} from '../src/auth/board-agent-token.ts';
import { mintToken, verifyToken } from '../src/auth/signed-token.ts';
import { admitBoardAgent, boardAgentScopeAllows } from '../src/middleware/board-agent-door.ts';
import { memberKeyOnBoard } from '../src/share/collab-member-key.ts';

const BASE_KEY = 'a'.repeat(64);
const AGENT = 'agent-riverbend';
const BOARD = 'w-harbor';
const OTHER = 'w-salt';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function store(): { tokens: BoardAgentTokens; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'at2-'));
  dirs.push(dir);
  const path = boardTokensPath(dir);
  return { tokens: new BoardAgentTokens(path, () => boardAgentTokenKey(BASE_KEY)), path };
}

describe('the at2 format', () => {
  it('has a key of its own: an at1 value never verifies as at2', () => {
    expect(boardAgentTokenKey(BASE_KEY)).not.toBe(agentTokenKey(BASE_KEY));
    const at1 = mintAgentToken(AGENT, agentTokenKey(BASE_KEY));
    expect(verifyToken(boardAgentToken, at1, boardAgentTokenKey(BASE_KEY)).ok).toBe(false);
  });

  it('round-trips its claims and refuses a payload with a dot in a field', () => {
    const key = boardAgentTokenKey(BASE_KEY);
    const claims = {
      tokenId: 'abcdefghijklmnop',
      agentId: AGENT,
      boardId: BOARD,
      expiresAt: Date.now() + 60_000,
    };
    const v = verifyToken(boardAgentToken, mintToken(boardAgentToken, claims, key), key);
    expect(v).toEqual({ ok: true, claims });
    expect(boardAgentToken.decode(`at2.abcdefghijklmnop.${AGENT}.${BOARD}.extra`)).toBeNull();
  });

  it('is read only from an at2 bearer', () => {
    expect(boardAgentBearerOf(new Headers({ authorization: 'Bearer at2.x.y' }))).toBe('at2.x.y');
    expect(boardAgentBearerOf(new Headers({ authorization: 'Bearer at1.x.y' }))).toBeNull();
    expect(boardAgentBearerOf(new Headers())).toBeNull();
  });

  it('stamps a key the board lock sweep finds, and only on its board', () => {
    const key = boardAgentMemberKey(BOARD, 'abcdefghijklmnop');
    expect(memberKeyOnBoard(BOARD)(key)).toBe(true);
    expect(memberKeyOnBoard(OTHER)(key)).toBe(false);
  });
});

describe('the revocation record', () => {
  it('verifies a minted token, then refuses it once revoked, keeping the record', () => {
    const { tokens } = store();
    const { record, token } = tokens.mint(AGENT, BOARD, 'lead');
    expect(tokens.verify(token)).toEqual({ tokenId: record.id, agentId: AGENT, boardId: BOARD });
    expect(tokens.revoke(record.id)?.revokedAt).toBeNumber();
    expect(tokens.verify(token)).toBeNull();
    expect(tokens.list().find((r) => r.id === record.id)?.revokedAt).toBeNumber();
  });

  it('refuses a genuine signature over an id the record never issued', () => {
    const { tokens } = store();
    const unissued = mintToken(
      boardAgentToken,
      { tokenId: 'neverissued00000', agentId: AGENT, boardId: BOARD, expiresAt: null },
      boardAgentTokenKey(BASE_KEY),
    );
    expect(tokens.verify(unissued)).toBeNull();
  });

  it('refuses a token whose board disagrees with its record', () => {
    const { tokens } = store();
    const { record } = tokens.mint(AGENT, BOARD, '');
    const moved = mintToken(
      boardAgentToken,
      { tokenId: record.id, agentId: AGENT, boardId: OTHER, expiresAt: null },
      boardAgentTokenKey(BASE_KEY),
    );
    expect(tokens.verify(moved)).toBeNull();
  });

  it('writes the file mode 600, never holding a token value, and survives a restart', () => {
    const { tokens, path } = store();
    const { record, token } = tokens.mint(AGENT, BOARD, '');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const reread = new BoardAgentTokens(path, () => boardAgentTokenKey(BASE_KEY));
    expect(reread.verify(token)?.tokenId).toBe(record.id);
    expect(JSON.stringify(reread.list())).not.toContain(token);
  });
});

describe('the expiry', () => {
  /** A store whose clock the test moves. */
  function clocked(): { tokens: BoardAgentTokens; clock: { now: number } } {
    const dir = mkdtempSync(join(tmpdir(), 'at2-clock-'));
    dirs.push(dir);
    const clock = { now: 1_800_000_000_000 };
    const tokens = new BoardAgentTokens(
      boardTokensPath(dir),
      () => boardAgentTokenKey(BASE_KEY),
      () => clock.now,
    );
    return { tokens, clock };
  }

  it('carries its expiry, and is refused once past it', () => {
    const { tokens, clock } = clocked();
    const { token, expiresAt } = tokens.mint(AGENT, BOARD, '');
    expect(expiresAt).toBe(clock.now + BOARD_AGENT_TOKEN_TTL_MS);
    clock.now = expiresAt - 1;
    expect(tokens.verify(token)?.agentId).toBe(AGENT);
    clock.now = expiresAt;
    expect(tokens.verify(token)).toBeNull();
  });

  it('renews a live token for the same record, and the new value outlives the old', () => {
    const { tokens, clock } = clocked();
    const { record, token, expiresAt } = tokens.mint(AGENT, BOARD, '');
    clock.now += BOARD_AGENT_TOKEN_TTL_MS - 1_000;
    const grant = tokens.verify(token);
    expect(grant).not.toBeNull();
    const fresh = grant ? tokens.refresh(grant) : null;
    expect(fresh?.expiresAt).toBeGreaterThan(expiresAt);
    clock.now = expiresAt;
    expect(tokens.verify(token)).toBeNull();
    expect(tokens.verify(fresh?.token ?? null)?.tokenId).toBe(record.id);
  });

  it('renews nothing once revoked', () => {
    const { tokens } = clocked();
    const { record, token } = tokens.mint(AGENT, BOARD, '');
    const grant = tokens.verify(token);
    tokens.revoke(record.id);
    expect(grant ? tokens.refresh(grant) : 'no grant').toBeNull();
  });

  it('still accepts a value minted before the expiry existed, while its record stands', () => {
    const { tokens } = clocked();
    const { record } = tokens.mint(AGENT, BOARD, '');
    const legacy = mintToken(
      boardAgentToken,
      { tokenId: record.id, agentId: AGENT, boardId: BOARD, expiresAt: null },
      boardAgentTokenKey(BASE_KEY),
    );
    expect(legacy.split('.')).toHaveLength(5);
    expect(tokens.verify(legacy)?.tokenId).toBe(record.id);
    tokens.revoke(record.id);
    expect(tokens.verify(legacy)).toBeNull();
  });
});

describe('the door', () => {
  const grant = { tokenId: 'abcdefghijklmnop', agentId: AGENT, boardId: BOARD };
  const workspacesOf = () => [];
  const j = (status: number, body: unknown) => Response.json(body, { status });
  const input = (over: Partial<Parameters<typeof admitBoardAgent>[0]> = {}) => ({
    req: new Request(`http://localhost/workspaces/${BOARD}`),
    pathname: `/workspaces/${BOARD}`,
    hostKind: 'local',
    bearer: 'at2.whatever',
    address: '127.0.0.1',
    proxiedVerifier: null,
    grantFor: () => grant,
    workspacesOf,
    j,
    ...over,
  });

  it('scopes to its own board and its own watch set', () => {
    expect(boardAgentScopeAllows(`/workspaces/${BOARD}`, 'GET', grant, workspacesOf)).toBe(true);
    expect(boardAgentScopeAllows(`/workspaces/${OTHER}`, 'GET', grant, workspacesOf)).toBe(false);
    expect(boardAgentScopeAllows(`/api/agents/${AGENT}/watches`, 'POST', grant, workspacesOf)).toBe(
      true,
    );
    expect(
      boardAgentScopeAllows('/api/agents/agent-saltmarsh/watches', 'GET', grant, workspacesOf),
    ).toBe(false);
    expect(boardAgentScopeAllows('/app', 'GET', grant, workspacesOf)).toBe(false);
  });

  it('admits a loopback caller and refuses one from off the machine', async () => {
    expect((await admitBoardAgent(input())).ok).toBe(true);
    const remote = await admitBoardAgent(input({ address: '100.64.0.9' }));
    expect(remote.ok).toBe(false);
  });

  it('refuses every host but the operator’s own, and a browser', async () => {
    for (const hostKind of ['collab', 'share-link', 'share', 'widget-door', 'recall-callback']) {
      const v = await admitBoardAgent(input({ hostKind }));
      expect(v.ok, hostKind).toBe(false);
    }
    const page = await admitBoardAgent(
      input({ req: new Request('http://localhost/', { headers: { origin: 'http://localhost' } }) }),
    );
    expect(page.ok).toBe(false);
  });

  it('needs the Access verifier through the tunnel, and its verdict to be ok', async () => {
    const none = await admitBoardAgent(input({ hostKind: 'proxied-local' }));
    expect(none.ok === false && none.response.status).toBe(503);
    const failed = await admitBoardAgent(
      input({
        hostKind: 'proxied-local',
        proxiedVerifier: async () => ({ ok: false, status: 401, error: 'missing token' }),
      }),
    );
    expect(failed.ok === false && failed.response.status).toBe(401);
    const passed = await admitBoardAgent(
      input({
        hostKind: 'proxied-local',
        address: undefined,
        proxiedVerifier: async () => ({ ok: true, email: undefined }),
      }),
    );
    expect(passed.ok).toBe(true);
  });

  it('answers one 401 for any token that does not stand', async () => {
    const v = await admitBoardAgent(input({ grantFor: () => null }));
    expect(v.ok === false && v.response.status).toBe(401);
  });
});
