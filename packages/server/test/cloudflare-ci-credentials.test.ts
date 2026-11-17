/**
 * CI's credentials from one Cloudflare token (infra/cloudflare/ci-credentials.ts):
 * the state bucket's key derived the way Cloudflare documents it, the account
 * read from the token, each made value masked before the command runs, and
 * the explicit R2 secrets still winning when they are set. A fake API and a
 * fake token; nothing calls Cloudflare.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  type MainIo,
  USAGE,
  accountIdOf,
  ciCredentials,
  main,
  r2KeyFromToken,
  tokenIdOf,
} from '../../../infra/cloudflare/ci-credentials.ts';
import type { CloudflareApi } from '../../../infra/project-machine/cloudflare.ts';

const TOKEN = 'fixture-token-Riverbend-0000000000';
const TOKEN_ID = 'a'.repeat(32);
const ACCOUNT = 'b'.repeat(32);

interface FakeAccount {
  /** Which verify endpoint answers: a user token's, or an account token's. */
  kind: 'user' | 'account';
  status?: string;
  accounts?: string[];
}

function fakeApi(f: FakeAccount): { api: CloudflareApi; calls: string[] } {
  const calls: string[] = [];
  const verified = { id: TOKEN_ID, status: f.status ?? 'active' };
  const api = (async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (path === '/user/tokens/verify' && f.kind === 'user') return verified;
    if (path === `/accounts/${ACCOUNT}/tokens/verify` && f.kind === 'account') return verified;
    throw new Error(`${method} ${path} failed (401): 1000 Invalid API Token`);
  }) as CloudflareApi;
  api.all = async <T>(path: string) => {
    calls.push(`GET ${path}`);
    return (f.accounts ?? [ACCOUNT]).map((id) => ({ id })) as T[];
  };
  return { api, calls };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('r2KeyFromToken', () => {
  it("is the token's id and the hex SHA-256 of its value", () => {
    expect(r2KeyFromToken(TOKEN_ID, TOKEN)).toEqual({
      accessKeyId: TOKEN_ID,
      secretAccessKey: sha256(TOKEN),
    });
    // A known vector, so the hash is the one Cloudflare documents, not just
    // the same call twice.
    expect(r2KeyFromToken(TOKEN_ID, 'abc').secretAccessKey).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('tokenIdOf', () => {
  it('reads a user token from /user/tokens/verify without asking for the account', async () => {
    const { api, calls } = fakeApi({ kind: 'user' });
    let asked = false;
    const id = await tokenIdOf(api, async () => {
      asked = true;
      return ACCOUNT;
    });
    expect(id).toBe(TOKEN_ID);
    expect(asked).toBe(false);
    expect(calls).toEqual(['GET /user/tokens/verify']);
  });

  it("falls back to the account's verify endpoint for an account token", async () => {
    const { api, calls } = fakeApi({ kind: 'account' });
    expect(await tokenIdOf(api, async () => ACCOUNT)).toBe(TOKEN_ID);
    expect(calls).toEqual(['GET /user/tokens/verify', `GET /accounts/${ACCOUNT}/tokens/verify`]);
  });

  it('refuses a token that is not active, naming both reads', async () => {
    const { api } = fakeApi({ kind: 'user', status: 'disabled' });
    await expect(tokenIdOf(api, async () => ACCOUNT)).rejects.toThrow(
      /user token \(CLOUDFLARE_API_TOKEN is not active\)/,
    );
  });
});

describe('accountIdOf', () => {
  it('takes CLOUDFLARE_ACCOUNT_ID when set, and reads nothing', async () => {
    const { api, calls } = fakeApi({ kind: 'user', accounts: [] });
    const other = 'c'.repeat(32);
    expect(await accountIdOf(api, { CLOUDFLARE_ACCOUNT_ID: other })).toBe(other);
    expect(calls).toEqual([]);
  });

  it('takes the only account the token reaches, and refuses two', async () => {
    expect(await accountIdOf(fakeApi({ kind: 'user' }).api, {})).toBe(ACCOUNT);
    const two = fakeApi({ kind: 'user', accounts: [ACCOUNT, 'c'.repeat(32)] }).api;
    await expect(accountIdOf(two, {})).rejects.toThrow(
      'reaches 2 accounts; set the repository variable CLOUDFLARE_ACCOUNT_ID',
    );
  });
});

describe('ciCredentials', () => {
  it('derives the state key from the token alone, masking both halves first', async () => {
    const lines: string[] = [];
    const added = await ciCredentials(
      {
        env: { CLOUDFLARE_API_TOKEN: TOKEN },
        api: fakeApi({ kind: 'user' }).api,
        out: (s) => lines.push(s),
      },
      { accountId: false },
    );
    expect(added).toEqual({ AWS_ACCESS_KEY_ID: TOKEN_ID, AWS_SECRET_ACCESS_KEY: sha256(TOKEN) });
    expect(lines).toEqual([`::add-mask::${TOKEN_ID}\n`, `::add-mask::${sha256(TOKEN)}\n`]);
    // The token itself is a GitHub secret, already masked, and is never printed.
    expect(lines.join('')).not.toContain(TOKEN);
  });

  it('adds the account id, masked, with --account-id', async () => {
    const lines: string[] = [];
    const added = await ciCredentials(
      {
        env: { CLOUDFLARE_API_TOKEN: TOKEN },
        api: fakeApi({ kind: 'account' }).api,
        out: (s) => lines.push(s),
      },
      { accountId: true },
    );
    expect(added.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT);
    expect(lines).toContain(`::add-mask::${ACCOUNT}\n`);
  });

  it('uses the explicit R2 secrets when both are set, and derives nothing', async () => {
    const { api, calls } = fakeApi({ kind: 'user' });
    const lines: string[] = [];
    const added = await ciCredentials(
      {
        env: {
          CLOUDFLARE_API_TOKEN: TOKEN,
          R2_ACCESS_KEY_ID: 'fixture-r2-id',
          R2_SECRET_ACCESS_KEY: 'fixture-r2-secret-Riverbend',
        },
        api,
        out: (s) => lines.push(s),
      },
      { accountId: false },
    );
    expect(added).toEqual({
      AWS_ACCESS_KEY_ID: 'fixture-r2-id',
      AWS_SECRET_ACCESS_KEY: 'fixture-r2-secret-Riverbend',
    });
    expect(calls).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('refuses half an explicit pair, and a missing token', async () => {
    const api = fakeApi({ kind: 'user' }).api;
    await expect(
      ciCredentials(
        {
          env: { CLOUDFLARE_API_TOKEN: TOKEN, R2_ACCESS_KEY_ID: 'fixture-r2-id' },
          api,
          out: () => {},
        },
        { accountId: false },
      ),
    ).rejects.toThrow('only one of R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY is set');
    await expect(
      ciCredentials({ env: {}, api, out: () => {} }, { accountId: false }),
    ).rejects.toThrow('CLOUDFLARE_API_TOKEN is not set');
  });
});

describe('main', () => {
  const io = (env: Record<string, string | undefined>, kind: FakeAccount['kind'] = 'user') => {
    const events: string[] = [];
    const runs: { cmd: string[]; env: Record<string, string | undefined> }[] = [];
    const m: MainIo = {
      env,
      api: fakeApi({ kind }).api,
      out: (s) => events.push(`out ${s.trim()}`),
      err: (s) => events.push(`err ${s.trim()}`),
      spawn: (cmd, childEnv) => {
        events.push('spawn');
        runs.push({ cmd, env: childEnv });
        return 7;
      },
    };
    return { m, events, runs };
  };

  it('runs the command with the key in its environment, after the masks, and returns its code', async () => {
    const { m, events, runs } = io({ CLOUDFLARE_API_TOKEN: TOKEN, CF_ROUTER_CONFIG: '{}' });
    const code = await main(['--', 'bun', 'infra/cloudflare/run.ts', 'apply', 'prod', '--ci'], m);
    expect(code).toBe(7);
    expect(events.indexOf('spawn')).toBe(events.length - 1);
    expect(events.filter((e) => e.startsWith('out ::add-mask::'))).toHaveLength(2);
    expect(runs[0]?.cmd).toEqual(['bun', 'infra/cloudflare/run.ts', 'apply', 'prod', '--ci']);
    expect(runs[0]?.env).toMatchObject({
      CLOUDFLARE_API_TOKEN: TOKEN,
      CF_ROUTER_CONFIG: '{}',
      AWS_ACCESS_KEY_ID: TOKEN_ID,
      AWS_SECRET_ACCESS_KEY: sha256(TOKEN),
    });
  });

  it('hands the explicit pair on only under the names terraform reads', async () => {
    const { m, runs } = io({
      CLOUDFLARE_API_TOKEN: TOKEN,
      R2_ACCESS_KEY_ID: 'fixture-r2-id',
      R2_SECRET_ACCESS_KEY: 'fixture-r2-secret-Riverbend',
    });
    await main(['--', 'true'], m);
    expect(runs[0]?.env.AWS_ACCESS_KEY_ID).toBe('fixture-r2-id');
    expect(Object.keys(runs[0]?.env ?? {})).not.toContain('R2_SECRET_ACCESS_KEY');
  });

  it('takes the command without the separator, which is how bun hands it over', async () => {
    const plain = io({ CLOUDFLARE_API_TOKEN: TOKEN });
    expect(await main(['bun', 'infra/cloudflare/run.ts', 'apply', 'prod', '--ci'], plain.m)).toBe(
      7,
    );
    expect(plain.runs[0]?.cmd).toEqual(['bun', 'infra/cloudflare/run.ts', 'apply', 'prod', '--ci']);
    const flagged = io({ CLOUDFLARE_API_TOKEN: TOKEN });
    expect(await main(['--account-id', 'true'], flagged.m)).toBe(7);
    expect(flagged.runs[0]?.cmd).toEqual(['true']);
  });

  it('as the workflows call it, `bun ci-credentials.ts -- <cmd>` reaches the credentials step, not usage', () => {
    // bun eats the first `--`, so this is the shape CI's script sees. With no
    // token the run stops at the credentials (1), never at usage (2).
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    const r = spawnSync(
      process.execPath,
      [join(import.meta.dir, '../../../infra/cloudflare/ci-credentials.ts'), '--', 'true'],
      { env, encoding: 'utf8' },
    );
    expect(r.stderr).not.toContain('usage:');
    expect(r.status).toBe(1);
  });

  it('runs nothing when the credentials cannot be made, or the usage is wrong', async () => {
    const missing = io({});
    expect(await main(['--', 'true'], missing.m)).toBe(1);
    expect(missing.runs).toEqual([]);
    for (const argv of [[], ['--'], ['--account', '--', 'true'], ['--account', 'true']]) {
      const bad = io({ CLOUDFLARE_API_TOKEN: TOKEN });
      expect(await main(argv, bad.m)).toBe(2);
      expect(bad.events).toEqual([`err ${USAGE.trim()}`]);
    }
  });
});
