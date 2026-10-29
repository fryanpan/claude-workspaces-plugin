/**
 * The board token a board socket session carries (`connector/board-token-lease.ts`),
 * against the real token store in a temp folder and an injected clock.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOARD_AGENT_TOKEN_TTL_MS,
  BoardAgentTokens,
  boardTokensPath,
} from '../src/auth/board-agent-token.ts';
import { BOARD_SOCKET_SESSION_LABEL, boardTokenLease } from '../src/connector/board-token-lease.ts';

const dir = mkdtempSync(join(tmpdir(), 'board-lease-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function setup(name: string) {
  let t = 1_000_000;
  const now = () => t;
  const tokens = new BoardAgentTokens(boardTokensPath(join(dir, name)), () => 'k'.repeat(64), now);
  const lines: string[] = [];
  const lease = boardTokenLease(tokens, 'agent-alice', 'w-harbor', (l) => lines.push(l), now);
  return { tokens, lease, lines, advance: (ms: number) => (t += ms) };
}

describe('boardTokenLease', () => {
  it('mints one token for the agent and board at first use, and reuses it', () => {
    const { tokens, lease } = setup('reuse');
    expect(tokens.list()).toHaveLength(0);
    const first = lease.token();
    expect(lease.token()).toBe(first);
    const records = tokens.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      agentId: 'agent-alice',
      boardId: 'w-harbor',
      label: BOARD_SOCKET_SESSION_LABEL,
    });
    expect(tokens.verify(first)).toMatchObject({ agentId: 'agent-alice', boardId: 'w-harbor' });
  });

  it('renews the same record past half its life', () => {
    const { tokens, lease, advance } = setup('renew');
    const first = lease.token();
    advance(BOARD_AGENT_TOKEN_TTL_MS / 2 + 1);
    const second = lease.token();
    expect(second).not.toBe(first);
    expect(tokens.list()).toHaveLength(1);
    expect(tokens.verify(second)).not.toBeNull();
  });

  it('revokes its token on release, and keeps no record of it', () => {
    const { tokens, lease } = setup('release');
    const value = lease.token();
    expect(tokens.list()).toHaveLength(1);
    lease.release();
    expect(tokens.verify(value)).toBeNull();
    expect(tokens.list()).toHaveLength(0);
  });

  it('never writes its token to the token file', () => {
    const { tokens, lease, advance } = setup('unwritten');
    // The control: an ordinary mint in the same store does write the file.
    tokens.mint('agent-bob', 'w-harbor', 'operator');
    const path = boardTokensPath(join(dir, 'unwritten'));
    const before = readFileSync(path, 'utf8');
    const value = lease.token();
    expect(tokens.isHeld(tokens.verify(value)?.tokenId ?? '')).toBe(true);
    advance(BOARD_AGENT_TOKEN_TTL_MS / 2 + 1);
    expect(lease.token()).not.toBeNull();
    lease.release();
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(before).not.toContain(BOARD_SOCKET_SESSION_LABEL);
  });

  it('a held token is gone when the process is: a fresh store does not verify it', () => {
    const { lease } = setup('restart');
    const value = lease.token();
    const fresh = new BoardAgentTokens(
      boardTokensPath(join(dir, 'restart')),
      () => 'k'.repeat(64),
      () => 1_000_000,
    );
    expect(fresh.verify(value)).toBeNull();
  });

  it('does not replace a token revoked from outside', () => {
    const { tokens, lease, advance } = setup('revoked');
    lease.token();
    const id = tokens.list()[0]?.id ?? '';
    tokens.revoke(id);
    advance(BOARD_AGENT_TOKEN_TTL_MS / 2 + 1);
    expect(lease.token()).toBeNull();
    expect(tokens.list()).toHaveLength(0);
  });

  it('answers null, and says why, when the store cannot mint', () => {
    const lines: string[] = [];
    const broken = {
      mintHeld: () => {
        throw new Error('bad agentId');
      },
      refresh: () => null,
      revoke: () => null,
    };
    const lease = boardTokenLease(broken, 'agent-alice', 'w-harbor', (l) => lines.push(l));
    expect(lease.token()).toBeNull();
    expect(lines.join('\n')).toContain('bad agentId');
  });
});

describe('the token file a 0.1.327 server left', () => {
  it('drops every board socket session record it wrote, and keeps the rest', () => {
    const folder = join(dir, 'left');
    mkdirSync(folder, { recursive: true });
    const path = boardTokensPath(folder);
    const record = (id: string, label: string, revokedAt?: number) => ({
      id,
      agentId: 'agent-alice',
      boardId: 'w-harbor',
      label,
      createdAt: 1,
      ...(revokedAt !== undefined ? { revokedAt } : {}),
    });
    writeFileSync(
      path,
      JSON.stringify({
        tokens: [
          record('a'.repeat(24), BOARD_SOCKET_SESSION_LABEL, 5),
          record('b'.repeat(24), BOARD_SOCKET_SESSION_LABEL),
          record('c'.repeat(24), 'operator', 5),
          record('d'.repeat(24), 'operator'),
        ],
      }),
    );
    const tokens = new BoardAgentTokens(
      path,
      () => 'k'.repeat(64),
      () => 10,
    );
    expect(tokens.list().map((r) => r.id)).toEqual(['c'.repeat(24), 'd'.repeat(24)]);
    // Written back without them on the next save.
    tokens.mint('agent-bob', 'w-harbor', 'operator');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).not.toContain(BOARD_SOCKET_SESSION_LABEL);
  });
});
