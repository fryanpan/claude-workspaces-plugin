import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_AGENT_TOKEN_TTL_MS } from '../src/auth/board-agent-token.ts';
import { createHomeRemoteTokens } from '../src/home-remote-tokens.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;
/** A token shaped like an at2 that says it expires at `expiresAt`. */
const token = (id: string, expiresAt: number) =>
  `at2.${id}.agent-home.w-riverbend.${expiresAt}.mac`;

describe('home remote tokens', () => {
  const dirs: string[] = [];
  const stateFile = () => {
    const d = mkdtempSync(join(tmpdir(), 'home-remote-tokens-'));
    dirs.push(d);
    return join(d, 'home-remote-tokens.json');
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('does not renew a token with more than half its life left', async () => {
    const first = token('a', T0 + BOARD_AGENT_TOKEN_TTL_MS);
    const tokens = createHomeRemoteTokens({
      tokens: new Map([['w-riverbend', first]]),
      now: () => T0 + DAY,
    });
    let asked = 0;
    const got = await tokens.fresh('w-riverbend', async () => {
      asked += 1;
      return null;
    });
    expect(got).toBe(first);
    expect(asked).toBe(0);
  });

  it('renews a due token once, saves it mode 600, and a restart keeps it', async () => {
    const first = token('a', T0 + BOARD_AGENT_TOKEN_TTL_MS);
    const second = token('b', T0 + 6 * DAY + BOARD_AGENT_TOKEN_TTL_MS);
    const file = stateFile();
    const config = new Map([['w-riverbend', first]]);
    const tokens = createHomeRemoteTokens({
      tokens: config,
      stateFile: file,
      now: () => T0 + 6 * DAY,
    });
    let asked = 0;
    const renew = async (_board: string, presented: string) => {
      asked += 1;
      expect(presented).toBe(first);
      return second;
    };
    // The stream and a read ask at once: one renewal.
    const [a, b] = await Promise.all([
      tokens.fresh('w-riverbend', renew),
      tokens.fresh('w-riverbend', renew),
    ]);
    expect([a, b]).toEqual([second, second]);
    expect(asked).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))['w-riverbend'].value).toBe(second);
    const restarted = createHomeRemoteTokens({ tokens: config, stateFile: file });
    expect(restarted.get('w-riverbend')).toBe(second);
  });

  it('a new value in the config wins over a value saved from the old one', () => {
    const file = stateFile();
    const old = token('a', T0);
    writeFileSync(
      file,
      JSON.stringify({ 'w-riverbend': { value: token('b', T0 + 9 * DAY), from: 'not-a-hash' } }),
      { mode: 0o600 },
    );
    const fresh = token('c', T0 + BOARD_AGENT_TOKEN_TTL_MS);
    const tokens = createHomeRemoteTokens({
      tokens: new Map([['w-riverbend', fresh]]),
      stateFile: file,
    });
    expect(tokens.get('w-riverbend')).toBe(fresh);
    expect(old).not.toBe(fresh);
  });

  it('keeps the old value when the server refuses or answers something else', async () => {
    const first = token('a', T0);
    const tokens = createHomeRemoteTokens({
      tokens: new Map([['w-riverbend', first]]),
      now: () => T0,
    });
    expect(await tokens.fresh('w-riverbend', async () => null)).toBe(first);
    expect(await tokens.fresh('w-riverbend', async () => 'not a token')).toBe(first);
    expect(
      await tokens.fresh('w-riverbend', async () => {
        throw new Error('unreachable');
      }),
    ).toBe(first);
  });
});
