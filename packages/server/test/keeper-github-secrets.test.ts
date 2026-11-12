/**
 * The keeper writes Cloudflare CI's credentials as GitHub Actions secrets
 * (`keeper/keeper-github.ts`), sealed to each target's public key
 * (`keeper-sealed-box.ts`), on one passkey tap whose page lists names only.
 *
 * GitHub is a stand-in holding a real X25519 key pair per target, so the test
 * opens each sealed value the way libsodium's `crypto_box_seal_open` does and
 * checks it is the value sent, and that no request carried the value itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import nacl from 'tweetnacl';
import {
  CI_REPO,
  type GithubScopedApi,
  type SecretWrite,
  checkSecretWrites,
  classifyGithubSecrets,
  githubStatus,
  writeGithubSecrets,
} from '../src/keeper/keeper-github.ts';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { sealNonce, sealedBox } from '../src/keeper/keeper-sealed-box.ts';
import { type LiveKeeper, startLiveKeeper } from './keeper-live-harness.ts';

const APPLY = 'fixture-apply-token-Harborlight-000001';
const R2_ID = 'fixture-r2-id-Riverbend-0001';
const R2_SECRET = 'fixture-r2-secret-Saltmarsh-0001';

/** libsodium's `crypto_box_seal_open`, for checking what the keeper sealed. */
function sealOpen(b64: string, pair: nacl.BoxKeyPair): string | null {
  const all = new Uint8Array(Buffer.from(b64, 'base64'));
  const eph = all.slice(0, 32);
  const opened = nacl.box.open(all.slice(32), sealNonce(eph, pair.publicKey), eph, pair.secretKey);
  return opened ? new TextDecoder().decode(opened) : null;
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function fakeGithub(opts: { scopes?: string | null; failPut?: string } = {}) {
  const pairs = { repository: nacl.box.keyPair(), 'cloudflare-prod': nacl.box.keyPair() };
  const calls: Call[] = [];
  const stored: Record<string, string> = {};
  const scopes = opts.scopes === undefined ? 'repo, workflow' : opts.scopes;
  const api: GithubScopedApi = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const target = path.includes('/environments/cloudflare-prod/')
      ? 'cloudflare-prod'
      : 'repository';
    const ok = (status: number, b: unknown = {}) => ({ status, body: JSON.stringify(b), scopes });
    if (path === `/repos/${CI_REPO}`) return ok(200, { full_name: CI_REPO });
    if (path.endsWith('/public-key')) {
      return ok(200, {
        key_id: `kid-${target}`,
        key: Buffer.from(pairs[target].publicKey).toString('base64'),
      });
    }
    if (method === 'GET' && path.includes('/secrets?')) {
      return ok(200, {
        secrets: Object.keys(stored)
          .filter((k) => k.startsWith(`${target}/`))
          .map((k) => ({ name: k.split('/')[1] })),
      });
    }
    if (method === 'PUT') {
      const name = path.split('/').pop() ?? '';
      if (name === opts.failPut) return ok(422, { message: 'nope' });
      const b = body as { encrypted_value: string; key_id: string };
      expect(b.key_id).toBe(`kid-${target}`);
      stored[`${target}/${name}`] = sealOpen(b.encrypted_value, pairs[target]) ?? '<unopenable>';
      return ok(201);
    }
    if (method === 'POST' && path.endsWith('/dispatches')) return ok(204);
    return ok(404);
  };
  return { api, calls, stored };
}

const WRITES: SecretWrite[] = [
  { target: 'cloudflare-prod', name: 'CLOUDFLARE_API_TOKEN', value: APPLY },
  { target: 'cloudflare-prod', name: 'R2_ACCESS_KEY_ID', value: R2_ID },
  { target: 'repository', name: 'R2_SECRET_ACCESS_KEY', value: R2_SECRET },
];

describe('sealedBox', () => {
  it('opens with the recipient key as libsodium would, and never twice the same', () => {
    const pair = nacl.box.keyPair();
    const pk = Buffer.from(pair.publicKey).toString('base64');
    const a = sealedBox(APPLY, pk);
    expect(sealOpen(a, pair)).toBe(APPLY);
    expect(sealedBox(APPLY, pk)).not.toBe(a);
    expect(sealOpen(a, nacl.box.keyPair())).toBeNull();
    expect(() => sealedBox(APPLY, 'c2hvcnQ=')).toThrow('32 bytes');
  });
});

describe('writeGithubSecrets', () => {
  it('seals each value to its target and puts it there; no request carries a value', async () => {
    const gh = fakeGithub();
    const r = await writeGithubSecrets(gh.api, WRITES);
    expect(r.status).toBe(200);
    expect(gh.stored).toEqual({
      'cloudflare-prod/CLOUDFLARE_API_TOKEN': APPLY,
      'cloudflare-prod/R2_ACCESS_KEY_ID': R2_ID,
      'repository/R2_SECRET_ACCESS_KEY': R2_SECRET,
    });
    const sent = JSON.stringify(gh.calls);
    for (const v of [APPLY, R2_ID, R2_SECRET]) {
      expect(sent).not.toContain(v);
      expect(r.body).not.toContain(v);
    }
    expect(gh.calls.filter((c) => c.method === 'PUT').map((c) => c.path)).toEqual([
      `/repos/${CI_REPO}/environments/cloudflare-prod/secrets/CLOUDFLARE_API_TOKEN`,
      `/repos/${CI_REPO}/environments/cloudflare-prod/secrets/R2_ACCESS_KEY_ID`,
      `/repos/${CI_REPO}/actions/secrets/R2_SECRET_ACCESS_KEY`,
    ]);
  });

  it('refuses before any write when the token lacks the classic repo scope', async () => {
    for (const scopes of ['workflow, read:org', null]) {
      const gh = fakeGithub({ scopes });
      const r = await writeGithubSecrets(gh.api, WRITES);
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).error).toContain('does not have the classic repo scope');
      expect(gh.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    }
  });

  it('stops at a refused write and names what it wrote before it', async () => {
    const gh = fakeGithub({ failPut: 'R2_ACCESS_KEY_ID' });
    const r = await writeGithubSecrets(gh.api, WRITES);
    expect(r.status).toBe(502);
    expect(JSON.parse(r.body)).toMatchObject({
      written: ['environment cloudflare-prod/CLOUDFLARE_API_TOKEN'],
    });
    expect(Object.keys(gh.stored)).toEqual(['cloudflare-prod/CLOUDFLARE_API_TOKEN']);
  });

  it('githubStatus reports scope and secret names, never a value', async () => {
    const gh = fakeGithub();
    await writeGithubSecrets(gh.api, WRITES);
    const r = JSON.parse((await githubStatus(gh.api)).body);
    expect(r).toEqual({
      scopes: ['repo', 'workflow'],
      names: {
        repository: ['R2_SECRET_ACCESS_KEY'],
        'cloudflare-prod': ['CLOUDFLARE_API_TOKEN', 'R2_ACCESS_KEY_ID'],
      },
    });
  });
});

describe('classifyGithubSecrets', () => {
  it('holds the credential names, and refuses configs, other targets and bad values', () => {
    expect(classifyGithubSecrets(WRITES)).toMatchObject({ kind: 'held', hold: 'github.secrets' });
    const one = (w: Partial<SecretWrite>) => [{ ...WRITES[0], ...w }];
    expect(classifyGithubSecrets(one({ name: 'CF_ACCESS_CONFIG' })).kind).toBe('refused');
    expect(classifyGithubSecrets(one({ target: 'production' as never })).kind).toBe('refused');
    expect(classifyGithubSecrets(one({ value: '' })).kind).toBe('refused');
    expect(classifyGithubSecrets(one({ value: 'a\0b' })).kind).toBe('refused');
    expect(classifyGithubSecrets([...WRITES, WRITES[0]]).kind).toBe('refused');
    expect(classifyGithubSecrets([]).kind).toBe('refused');
    expect(checkSecretWrites(WRITES, ['CLOUDFLARE_API_TOKEN'])).toHaveProperty('error');
  });
});

describe('github-secrets through the keeper', () => {
  const gh = fakeGithub();
  const exec: Executors = {
    fly: async () => ({ status: 0, stdout: '', stderr: '' }),
    cloudflare: async () => ({ status: 200, body: '{}' }),
    github: gh.api,
  };
  let k: LiveKeeper;
  beforeAll(async () => {
    k = await startLiveKeeper(exec, 'keeper-github-secrets');
  });
  afterAll(async () => k?.stop());

  it('is held; its page lists every name and target and no value; the tap writes them', async () => {
    const r = await k.submit('/v1/github-secrets', { secrets: WRITES });
    expect(r.status).toBe(202);
    expect(r.held).toBe(true);
    expect(gh.calls).toEqual([]);
    const id = r.body.id as string;
    const page = await k.page(id);
    const list = /<ul id="secrets">([\s\S]*?)<\/ul>/.exec(page)?.[1] ?? '';
    expect(list).toContain(
      'environment cloudflare-prod: <code>CLOUDFLARE_API_TOKEN, R2_ACCESS_KEY_ID</code>',
    );
    expect(list).toContain('the repository: <code>R2_SECRET_ACCESS_KEY</code>');
    for (const v of [APPLY, R2_ID, R2_SECRET]) {
      expect(page).not.toContain(v);
      expect(JSON.stringify(r.body)).not.toContain(v);
    }
    const approved = await k.approve(id);
    expect(approved.status).toBe(200);
    expect(Object.keys(gh.stored).sort()).toEqual([
      'cloudflare-prod/CLOUDFLARE_API_TOKEN',
      'cloudflare-prod/R2_ACCESS_KEY_ID',
      'repository/R2_SECRET_ACCESS_KEY',
    ]);
    const done = await k.poll(id, r.body.pollToken as string);
    expect(done.status).toBe('done');
    for (const v of [APPLY, R2_ID, R2_SECRET]) expect(JSON.stringify(done)).not.toContain(v);
    // The values are dropped once it ran; the page still lists the names.
    const call = k.keeper.requests.get(id)?.call;
    expect(call?.type === 'github-secrets' && call.secrets.map((s) => s.value)).toEqual([
      '',
      '',
      '',
    ]);
  });

  it('refuses a config name, which only a config sync may write', async () => {
    const r = await k.submit('/v1/github-secrets', {
      secrets: [{ target: 'repository', name: 'CF_ACCESS_CONFIG', value: '{}' }],
    });
    expect(r.status).toBe(403);
  });

  it('github-status runs at once and needs the caller token', async () => {
    const r = await k.submit('/v1/github-status', undefined, 'GET');
    expect(r.status).toBe(200);
    expect(r.body.scopes).toEqual(['repo', 'workflow']);
    const bare = await fetch(`${k.base}/v1/github-status`, { headers: { 'x-cw-keeper': '1' } });
    expect(bare.status).toBe(401);
  });
});
