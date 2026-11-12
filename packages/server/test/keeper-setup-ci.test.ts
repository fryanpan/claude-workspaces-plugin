/**
 * The `CI credentials` step of keeper setup (`keeper/keeper-setup-ci.ts`):
 * four Cloudflare tokens made, written to GitHub on one passkey tap through a
 * real keeper, each R2 key derived from its token (id, SHA-256 of the
 * value), nothing printed, and every token deleted again when the write
 * fails. Cloudflare and GitHub are stand-ins; GitHub holds a real X25519 key
 * pair per target, so the test opens each sealed value and checks it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import { CI_REPO, type GithubScopedApi } from '../src/keeper/keeper-github.ts';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { sealNonce } from '../src/keeper/keeper-sealed-box.ts';
import {
  CF_APPLY_PERMISSIONS,
  CF_PLAN_PERMISSIONS,
  type CiStepIo,
  ciCredentials,
} from '../src/keeper/keeper-setup-ci.ts';
import { type LiveKeeper, startLiveKeeper } from './keeper-live-harness.ts';
import { waitFor } from './wait-for.ts';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const CURRENT = 'fixture-cf-current-Harborlight';
const PASTED = 'fixture-cf-pasted-Riverbend';
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

const gh = {
  scopes: 'repo' as string | null,
  failPut: false,
  stored: {} as Record<string, string>,
  pairs: { repository: nacl.box.keyPair(), 'cloudflare-prod': nacl.box.keyPair() },
};
const github: GithubScopedApi = async (method, path, body) => {
  const target = path.includes('/environments/cloudflare-prod/') ? 'cloudflare-prod' : 'repository';
  const ok = (status: number, b: unknown = {}) => ({
    status,
    body: JSON.stringify(b),
    scopes: gh.scopes,
  });
  if (path === `/repos/${CI_REPO}`) return ok(200);
  if (path.endsWith('/public-key')) {
    const key = Buffer.from(gh.pairs[target].publicKey).toString('base64');
    return ok(200, { key_id: `k-${target}`, key });
  }
  if (method === 'GET') {
    const names = Object.keys(gh.stored)
      .filter((k) => k.startsWith(`${target}/`))
      .map((k) => ({ name: k.split('/')[1] }));
    return ok(200, { secrets: names });
  }
  if (method === 'PUT') {
    if (gh.failPut) return ok(500, { message: 'down' });
    const all = new Uint8Array(
      Buffer.from((body as { encrypted_value: string }).encrypted_value, 'base64'),
    );
    const eph = all.slice(0, 32);
    const pair = gh.pairs[target];
    const open = nacl.box.open(all.slice(32), sealNonce(eph, pair.publicKey), eph, pair.secretKey);
    gh.stored[`${target}/${path.split('/').pop()}`] = new TextDecoder().decode(open ?? undefined);
    return ok(201);
  }
  return ok(404);
};

const cf = {
  canMint: true,
  made: [] as Array<{ name: string; policies: unknown[] }>,
  deleted: [] as string[],
  calls: 0,
};
const names = [
  ...CF_APPLY_PERMISSIONS,
  ...CF_PLAN_PERMISSIONS,
  { api: 'Workers R2 Storage Bucket Item Write' },
  { api: 'Workers R2 Storage Bucket Item Read' },
].map((p) => p.api);

function fakeFetch(): typeof fetch {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== 'api.cloudflare.com') return fetch(input, init);
    cf.calls++;
    const auth = new Headers(init?.headers).get('authorization');
    const path = url.pathname.replace('/client/v4', '');
    const method = init?.method ?? 'GET';
    if (path === '/accounts') return json({ success: true, result: [{ id: ACCOUNT, name: 'H' }] });
    if (auth === `Bearer ${CURRENT}` && !cf.canMint)
      return json({ success: false, errors: [{ message: 'forbidden' }] }, 403);
    if (path === '/user/tokens/permission_groups')
      return json({ success: true, result: names.map((name, i) => ({ id: `pg${i}`, name })) });
    if (path === '/user/tokens' && method === 'POST') {
      cf.made.push(JSON.parse(String(init?.body)));
      const n = cf.made.length;
      return json({ success: true, result: { id: `tok-${n}`, value: `val-${n}-Saltmarsh` } });
    }
    if (method === 'DELETE') {
      cf.deleted.push(path.split('/').pop() ?? '');
      return json({ success: true, result: {} });
    }
    return json({ success: false }, 404);
  }) as typeof fetch;
}

let k: LiveKeeper;
beforeAll(async () => {
  const exec: Executors = {
    fly: async () => ({ status: 0, stdout: '', stderr: '' }),
    cloudflare: async () => ({ status: 200, body: '{}' }),
    github,
  };
  k = await startLiveKeeper(exec, 'keeper-setup-ci');
});
afterAll(async () => k?.stop());

function setup(over: Partial<CiStepIo> = {}) {
  const printed: string[] = [];
  const io: CiStepIo = {
    keeperUrl: k.base,
    callerToken: k.caller,
    dryRun: false,
    fetch: fakeFetch(),
    account: null,
    current: () => CURRENT,
    readSecret: async () => PASTED,
    readLine: async () => 'y',
    print: (l) => printed.push(l),
    pollMs: 20,
    ...over,
  };
  return { io, printed };
}

/** Run the step, tapping Approve once the keeper holds the write. */
async function runAndTap(io: CiStepIo, printed: string[]) {
  const running = ciCredentials(io);
  const id = await waitFor(() => printed.join('\n').match(/approve\/([A-Za-z0-9_-]+)/)?.[1], {
    describe: 'the held github-secrets write',
  });
  expect((await k.approve(id)).status).toBe(200);
  return running;
}

const reset = () => {
  gh.scopes = 'repo';
  gh.failPut = false;
  gh.stored = {};
  cf.canMint = true;
  cf.made = [];
  cf.deleted = [];
  cf.calls = 0;
};

describe('the CI credentials step', () => {
  it('makes four tokens and writes each where CI reads it, the R2 keys derived from their tokens', async () => {
    reset();
    const { io, printed } = setup();
    expect(await runAndTap(io, printed)).toEqual({ ok: true });
    expect(cf.made.map((t) => t.name.replace(/ \d{4}-.*$/, ''))).toEqual([
      'claude-workspaces CI apply',
      'claude-workspaces CI plan',
      'claude-workspaces CI state read-write',
      'claude-workspaces CI state read-only',
    ]);
    expect(JSON.stringify(cf.made[2]?.policies)).toContain(
      `com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_claude-workspaces-tfstate`,
    );
    expect(gh.stored).toEqual({
      'cloudflare-prod/CLOUDFLARE_API_TOKEN': 'val-1-Saltmarsh',
      'cloudflare-prod/R2_ACCESS_KEY_ID': 'tok-3',
      'cloudflare-prod/R2_SECRET_ACCESS_KEY': sha('val-3-Saltmarsh'),
      'repository/CLOUDFLARE_API_TOKEN': 'val-2-Saltmarsh',
      'repository/R2_ACCESS_KEY_ID': 'tok-4',
      'repository/R2_SECRET_ACCESS_KEY': sha('val-4-Saltmarsh'),
    });
    expect(printed.join('\n')).not.toContain('Saltmarsh');
    expect(cf.deleted).toEqual([]);
  });

  it('the plan token holds only Read permissions', () => {
    expect(CF_PLAN_PERMISSIONS.every((p) => p.api.endsWith(' Read'))).toBe(true);
    expect(CF_PLAN_PERMISSIONS).toHaveLength(CF_APPLY_PERMISSIONS.length);
  });

  it('skips, making nothing, when GitHub holds all six names', async () => {
    reset();
    const { io, printed } = setup();
    await runAndTap(io, printed);
    cf.made = [];
    cf.calls = 0;
    const again = setup();
    expect(await ciCredentials(again.io)).toEqual({ ok: true });
    expect(cf.calls).toBe(0);
    expect(again.printed.join('\n')).toContain('holds the CI credentials already');
  });

  it('refuses before making anything when the GitHub token lacks the repo scope', async () => {
    reset();
    gh.scopes = 'workflow';
    const { io } = setup();
    const r = await ciCredentials(io);
    expect('stop' in r && r.stop).toContain('classic repo scope');
    expect(cf.calls).toBe(0);
  });

  it('skips with a line saying why, making nothing, when the keeper cannot read GitHub', async () => {
    reset();
    const k2 = await startLiveKeeper(
      {
        fly: async () => ({ status: 0, stdout: '', stderr: '' }),
        cloudflare: async () => ({ status: 200, body: '{}' }),
      },
      'keeper-setup-ci-nogh',
    );
    try {
      const { io, printed } = setup({ keeperUrl: k2.base, callerToken: k2.caller });
      expect(await ciCredentials(io)).toEqual({ ok: true });
      expect(printed.join('\n')).toContain('skipped: the keeper could not read GitHub');
      expect(cf.calls).toBe(0);
    } finally {
      await k2.stop();
    }
  });

  it('asks for a pasted token when the current one cannot make tokens, and keeps it nowhere', async () => {
    reset();
    cf.canMint = false;
    const { io, printed } = setup();
    expect(await runAndTap(io, printed)).toEqual({ ok: true });
    expect(cf.made).toHaveLength(4);
    expect(printed.join('\n')).toContain('Delete the token you pasted');
    expect(printed.join('\n')).not.toContain(PASTED);
  });

  it('deletes every token it made when GitHub refuses the write', async () => {
    reset();
    gh.failPut = true;
    const { io, printed } = setup();
    const r = await runAndTap(io, printed);
    expect('stop' in r && r.stop).toContain('Every token this step made was deleted again');
    expect(cf.deleted).toEqual(['tok-1', 'tok-2', 'tok-3', 'tok-4']);
  });

  it('makes nothing when the person does not confirm, or in a dry run', async () => {
    reset();
    const no = setup({ readLine: async () => 'n' });
    expect(await ciCredentials(no.io)).toEqual({ stop: 'you did not confirm; nothing was made' });
    expect(cf.made).toEqual([]);
    cf.calls = 0;
    const dry = setup({ dryRun: true });
    expect(await ciCredentials(dry.io)).toEqual({ ok: true });
    expect(cf.calls).toBe(0);
    expect(cf.made).toEqual([]);
    expect(dry.printed.join('\n')).toContain('would make an apply token');
  });
});
