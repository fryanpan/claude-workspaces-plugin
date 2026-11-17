/**
 * The `at3` agent grant (`auth/agent-grant-token.ts`): one agent, one app,
 * one board, never above its person's role, expiring, revocable, and
 * recording its last use without a write per request.
 *
 * Hermetic: a temp file, an injected clock, injected roster answers.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_GRANT_TOKEN_TTL_MS,
  AgentGrantTokens,
  agentGrantToken,
  agentGrantTokenKey,
  agentGrantTokensPath,
} from '../src/auth/agent-grant-token.ts';
import {
  BoardAgentTokens,
  boardAgentBearerOf,
  boardAgentMemberKey,
  boardAgentTokenKey,
} from '../src/auth/board-agent-token.ts';
import { mintToken } from '../src/auth/signed-token.ts';
import type { BoardRole } from '../src/share/board-role.ts';

const BASE_KEY = 'b'.repeat(64);
const A1 = 'agent-harborlight-a1';
const B1 = 'agent-riverbend-b1';
const BOARD = 'w-harbor';
const ALICE = 'user-alice';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface World {
  tokens: AgentGrantTokens;
  path: string;
  clock: { t: number };
  roles: Map<string, BoardRole>;
  archived: Set<string>;
}

function world(appId = 'workspaces', dir?: string): World {
  const d = dir ?? mkdtempSync(join(tmpdir(), 'at3-'));
  if (!dir) dirs.push(d);
  const clock = { t: 1_000_000 };
  const roles = new Map<string, BoardRole>([[`${BOARD}:${ALICE}`, 'member']]);
  const archived = new Set<string>();
  const path = agentGrantTokensPath(d);
  const tokens = new AgentGrantTokens(path, () => agentGrantTokenKey(BASE_KEY), {
    appId,
    personOfAgent: (agentId) => (agentId === A1 ? ALICE : null),
    roleOf: (boardId, personId) => roles.get(`${boardId}:${personId}`) ?? null,
    personActive: (personId) => !archived.has(personId),
    now: () => clock.t,
  });
  return { tokens, path, clock, roles, archived };
}

function minted(w: World) {
  const m = w.tokens.mint(A1, BOARD, 'Harborlight relay');
  if (!m.ok) throw new Error(`mint refused: ${m.error}`);
  return m;
}

describe('minting an at3', () => {
  it('names the agent, the app, the board, the person and the role, and is offered to the board door', () => {
    const w = world();
    const m = minted(w);
    expect(m.token.startsWith('at3.')).toBe(true);
    expect(m.record).toMatchObject({
      agentId: A1,
      appId: 'workspaces',
      boardId: BOARD,
      personId: ALICE,
      role: 'member',
    });
    expect(m.expiresAt).toBe(w.clock.t + AGENT_GRANT_TOKEN_TTL_MS);
    const headers = new Headers({ authorization: `Bearer ${m.token}` });
    expect(boardAgentBearerOf(headers)).toBe(m.token);
    expect(w.tokens.verify(m.token)).toMatchObject({
      version: 'at3',
      tokenId: m.record.id,
      agentId: A1,
      boardId: BOARD,
      appId: 'workspaces',
      role: 'member',
      personId: ALICE,
    });
  });

  it('refuses an agent with no person, a person with no role on the board, and a role above the person', () => {
    const w = world();
    expect(w.tokens.mint(B1, BOARD, '')).toEqual({ ok: false, error: 'agent_has_no_person' });
    expect(w.tokens.mint(A1, 'w-salt', '')).toEqual({ ok: false, error: 'person_not_on_board' });
    expect(w.tokens.mint(A1, BOARD, '', 'owner')).toEqual({
      ok: false,
      error: 'owner_not_grantable',
    });
    expect(w.tokens.list()).toEqual([]);
  });

  it("refuses the owner role even to an owner's own agent", () => {
    const w = world();
    w.roles.set(`${BOARD}:${ALICE}`, 'owner');
    expect(w.tokens.mint(A1, BOARD, '', 'owner')).toEqual({
      ok: false,
      error: 'owner_not_grantable',
    });
    expect(w.tokens.list()).toEqual([]);
    // Positive control: the same agent gets a member grant.
    expect(minted(w).record.role).toBe('member');
  });
});

describe('verifying an at3', () => {
  it("does not verify on a server whose app id is another's", () => {
    const dir = mkdtempSync(join(tmpdir(), 'at3-app-'));
    dirs.push(dir);
    const here = world('workspaces', dir);
    const m = minted(here);
    const elsewhere = world('harborlight-app', dir);
    expect(elsewhere.tokens.verify(m.token)).toBeNull();
    expect(here.tokens.verify(m.token)).not.toBeNull();
  });

  it('stops verifying at its expiry', () => {
    const w = world();
    const m = minted(w);
    w.clock.t += AGENT_GRANT_TOKEN_TTL_MS - 1;
    expect(w.tokens.verify(m.token)).not.toBeNull();
    w.clock.t += 2;
    expect(w.tokens.verify(m.token)).toBeNull();
  });

  it('stops verifying once revoked, and names the member key its connections carry', () => {
    const w = world();
    const m = minted(w);
    const revoked = w.tokens.revoke(m.record.id);
    expect(revoked?.revokedAt).toBe(w.clock.t);
    expect(w.tokens.verify(m.token)).toBeNull();
    expect(boardAgentMemberKey(BOARD, m.record.id)).toContain(m.record.id);
  });

  it('stops verifying when its person leaves the board or is archived, and the sweep names it', () => {
    const w = world();
    const m = minted(w);
    expect(w.tokens.lapsedMemberKeys()).toEqual([]);
    w.roles.delete(`${BOARD}:${ALICE}`);
    expect(w.tokens.verify(m.token)).toBeNull();
    expect(w.tokens.lapsedMemberKeys()).toEqual([boardAgentMemberKey(BOARD, m.record.id)]);
    w.roles.set(`${BOARD}:${ALICE}`, 'member');
    expect(w.tokens.verify(m.token)).not.toBeNull();
    w.archived.add(ALICE);
    expect(w.tokens.verify(m.token)).toBeNull();
  });

  it('does not verify a value signed under the at2 key, nor an at2 under its own', () => {
    const w = world();
    const m = minted(w);
    const claims = agentGrantToken.decode(m.token.slice(0, m.token.lastIndexOf('.')));
    expect(claims).not.toBeNull();
    if (!claims) return;
    const forged = mintToken(agentGrantToken, claims, boardAgentTokenKey(BASE_KEY));
    expect(w.tokens.verify(forged)).toBeNull();
    const at2 = new BoardAgentTokens(join(dirs[0] ?? tmpdir(), 'at2.json'), () =>
      boardAgentTokenKey(BASE_KEY),
    ).mint(A1, BOARD, 'x');
    expect(w.tokens.verify(at2.token)).toBeNull();
  });
});

describe('last use', () => {
  it('is recorded on verify, written at most once a minute, and listed', () => {
    const w = world();
    const m = minted(w);
    const onDisk = () =>
      (
        JSON.parse(readFileSync(w.path, 'utf8')) as {
          tokens: Array<{ lastUsedAt?: number; lastUsedVia?: string }>;
        }
      ).tokens[0];
    const t1 = w.clock.t;
    w.tokens.verify(m.token, 'edge');
    expect(onDisk()).toMatchObject({ lastUsedAt: t1, lastUsedVia: 'edge' });
    w.clock.t += 10_000;
    w.tokens.verify(m.token, 'loopback');
    expect(onDisk()).toMatchObject({ lastUsedAt: t1, lastUsedVia: 'edge' });
    expect(w.tokens.list()[0]).toMatchObject({ lastUsedAt: t1 + 10_000, lastUsedVia: 'loopback' });
    w.clock.t += 60_000;
    w.tokens.verify(m.token, 'loopback');
    expect(onDisk()).toMatchObject({ lastUsedAt: t1 + 70_000, lastUsedVia: 'loopback' });
  });

  it('refreshes to a new value for the same record, and re-checks the ceiling', () => {
    const w = world();
    const m = minted(w);
    const grant = w.tokens.verify(m.token);
    expect(grant).not.toBeNull();
    if (!grant) return;
    w.clock.t += 1000;
    const fresh = w.tokens.refresh(grant);
    expect(fresh?.token).not.toBe(m.token);
    expect(fresh && w.tokens.verify(fresh.token)).toMatchObject({ tokenId: m.record.id });
    w.roles.delete(`${BOARD}:${ALICE}`);
    expect(w.tokens.refresh(grant)).toBeNull();
  });
});
