/**
 * The relay renews its board tokens before they expire
 * (`org-relay/relay-bearers.ts`), keeps the renewed values in its own state
 * directory, and prefers them over the config's after a restart unless the
 * config now holds a different token.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySavedBearers,
  bearerExpiresAt,
  bearersPath,
  createBearerKeeper,
  refreshDue,
} from '../src/org-relay/relay-bearers.ts';
import type { RelayFetch } from '../src/org-relay/relay-client.ts';
import { type RelayConfig, parseRelayConfig } from '../src/org-relay/relay-config.ts';

const TTL = 7 * 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const at2 = (exp: number | null) =>
  `at2.abcdefghijklmnop.agent-relay.w-harbor${exp === null ? '' : `.${exp}`}.bWFj`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function config(token: string): RelayConfig {
  const parsed = parseRelayConfig(
    JSON.stringify({
      servers: {
        harborlight: {
          organization: 'org-a',
          baseUrl: 'http://127.0.0.1:9',
          bearers: { 'w-harbor': token },
        },
      },
      seats: {},
    }),
  );
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

/** A server that renews whatever it is shown, and records what it was asked. */
function renewer(answer: (token: string) => string | null): {
  fetch: RelayFetch;
  asked: string[];
} {
  const asked: string[] = [];
  const fetch: RelayFetch = async (url, init) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    asked.push(`${url} ${auth}`);
    const token = answer(auth.replace(/^Bearer /, ''));
    return token === null
      ? Response.json({ error: 'board_token_invalid' }, { status: 401 })
      : Response.json({ ok: true, token, expiresAt: bearerExpiresAt(token) });
  };
  return { fetch, asked };
}

describe('when a token is due', () => {
  it('reads the expiry the token carries, and none from a legacy value', () => {
    expect(bearerExpiresAt(at2(NOW + 5))).toBe(NOW + 5);
    expect(bearerExpiresAt(at2(null))).toBeNull();
  });

  it('is due with under half its life left, or with no expiry at all', () => {
    expect(refreshDue(at2(NOW + TTL), TTL, NOW)).toBe(false);
    expect(refreshDue(at2(NOW + TTL / 2 + 1), TTL, NOW)).toBe(false);
    expect(refreshDue(at2(NOW + TTL / 2 - 1), TTL, NOW)).toBe(true);
    expect(refreshDue(at2(null), TTL, NOW)).toBe(true);
  });
});

describe('the keeper', () => {
  it('renews a due token, uses the new value, and saves it mode 600', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'relay-bearers-'));
    dirs.push(stateDir);
    const cfg = config(at2(NOW + 1000));
    const server = renewer(() => at2(NOW + TTL));
    const keeper = createBearerKeeper({
      fetch: server.fetch,
      config: cfg,
      stateDir,
      ttlMs: TTL,
      now: () => NOW,
      log: () => {},
    });
    expect(await keeper.run()).toBe(1);
    expect(server.asked[0]).toBe(
      `http://127.0.0.1:9/api/board-tokens/refresh Bearer ${at2(NOW + 1000)}`,
    );
    expect(cfg.servers.get('harborlight')?.bearers.get('w-harbor')).toBe(at2(NOW + TTL));
    expect(statSync(bearersPath(stateDir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(bearersPath(stateDir), 'utf8')).toContain(at2(NOW + TTL));
    // Fresh now, so the next pass asks nothing.
    expect(await keeper.run()).toBe(0);
    expect(server.asked).toHaveLength(1);
  });

  it('keeps the old value when the server refuses, logs once, and waits before asking again', async () => {
    const cfg = config(at2(null));
    const server = renewer(() => null);
    const lines: string[] = [];
    let now = NOW;
    const keeper = createBearerKeeper({
      fetch: server.fetch,
      config: cfg,
      stateDir: null,
      ttlMs: TTL,
      now: () => now,
      log: (l) => lines.push(l),
    });
    expect(await keeper.run()).toBe(0);
    expect(await keeper.run()).toBe(0);
    expect(server.asked).toHaveLength(1);
    now += 60_001;
    await keeper.run();
    expect(server.asked).toHaveLength(2);
    expect(lines).toHaveLength(1);
    expect(cfg.servers.get('harborlight')?.bearers.get('w-harbor')).toBe(at2(null));
  });

  it('after a restart, prefers the saved value that expires later', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'relay-bearers-'));
    dirs.push(stateDir);
    const first = config(at2(NOW + 1000));
    const keeper = createBearerKeeper({
      fetch: renewer(() => at2(NOW + TTL)).fetch,
      config: first,
      stateDir,
      ttlMs: TTL,
      now: () => NOW,
      log: () => {},
    });
    await keeper.run();
    // The process restarts on the same, unedited config.
    const restarted = config(at2(NOW + 1000));
    applySavedBearers(restarted, stateDir);
    expect(restarted.servers.get('harborlight')?.bearers.get('w-harbor')).toBe(at2(NOW + TTL));
    // A config edited to a newer value than the saved one keeps the config's.
    const edited = config(at2(NOW + 2 * TTL));
    applySavedBearers(edited, stateDir);
    expect(edited.servers.get('harborlight')?.bearers.get('w-harbor')).toBe(at2(NOW + 2 * TTL));
  });

  it('after a restart, a token rotated in the config wins over a saved one that expires later', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'relay-bearers-'));
    dirs.push(stateDir);
    // The old token, renewed half an hour before the restart.
    const old = config(at2(NOW + 1000));
    await createBearerKeeper({
      fetch: renewer(() => at2(NOW + TTL + 30 * 60_000)).fetch,
      config: old,
      stateDir,
      ttlMs: TTL,
      now: () => NOW,
      log: () => {},
    }).run();
    // A person put a newly minted token in the config, expiring sooner than
    // the renewed old one. Theirs is the one the relay must use.
    const rotated = config(at2(NOW + TTL));
    applySavedBearers(rotated, stateDir);
    expect(rotated.servers.get('harborlight')?.bearers.get('w-harbor')).toBe(at2(NOW + TTL));
    // Control, same file: the unrotated config still takes the renewal.
    const unrotated = config(at2(NOW + 1000));
    applySavedBearers(unrotated, stateDir);
    expect(unrotated.servers.get('harborlight')?.bearers.get('w-harbor')).toBe(
      at2(NOW + TTL + 30 * 60_000),
    );
  });

  it('reads a file saved before the config hash existed, by the later expiry', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'relay-bearers-'));
    dirs.push(stateDir);
    writeFileSync(
      bearersPath(stateDir),
      JSON.stringify({ harborlight: { 'w-harbor': at2(NOW + TTL) } }),
    );
    const cfg = config(at2(NOW + 1000));
    applySavedBearers(cfg, stateDir);
    expect(cfg.servers.get('harborlight')?.bearers.get('w-harbor')).toBe(at2(NOW + TTL));
  });
});
