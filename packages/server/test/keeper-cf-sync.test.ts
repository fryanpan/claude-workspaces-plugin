/**
 * `cf-sync` through the keeper (`keeper/keeper-cf-sync.ts`): the gitignored
 * configs are planned first, so the approval page shows who each project's
 * sign-in list gains or loses and which service tokens the tap makes; the tap
 * makes them, writes the config secrets and dispatches `cloudflare.yml`; a
 * new token's secret reaches only the requester's poll. A stand-in Terraform
 * runner and GitHub; nothing runs terraform or reaches either service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { GithubScopedApi } from '../src/keeper/keeper-github.ts';
import type { Executors, FlyResult } from '../src/keeper/keeper-requests.ts';
import { type LiveKeeper, startLiveKeeper } from './keeper-live-harness.ts';

const STATE = { accessKeyId: 'fixture-r2-id-Saltmarsh', secretAccessKey: 'fixture-r2-secret-0001' };
const ROUTER = '{"zone":"harborlight.test","marker":"router-config-text"}';
const ACCESS = '{"projects":{"riverbend":{"serviceTokens":["agent moi"]}}}';
const INPUT = JSON.stringify({ configs: { router: ROUTER, access: ACCESS }, state: STATE });
const SECRET = 'feedface'.repeat(8);
const ALICE = 'alice@harborlight.test';
const BOB = 'bob@harborlight.test';

interface Run {
  mode: string;
  stdin: Record<string, unknown>;
}
const runs: Run[] = [];
const gh: Array<{ method: string; path: string }> = [];
let next: { missing: Record<string, string>; access?: unknown; tokensFail?: boolean } = {
  missing: {},
};
let failPut = false;

const report = (r: Record<string, unknown>): FlyResult => ({
  status: r.ok === false ? 1 : 0,
  stdout: `${JSON.stringify(r)}\n`,
  stderr: '',
});

const github: GithubScopedApi = async (method, path) => {
  gh.push({ method, path });
  const ok = (status: number, b: unknown = {}) => ({
    status,
    body: JSON.stringify(b),
    scopes: 'repo',
  });
  if (path.endsWith('/public-key')) {
    return ok(200, { key_id: 'k1', key: Buffer.alloc(32, 7).toString('base64') });
  }
  if (method === 'PUT') return failPut ? ok(500, { message: 'down' }) : ok(201);
  if (method === 'POST') return ok(204);
  return ok(200);
};

const exec: Executors = {
  fly: async () => ({ status: 0, stdout: '', stderr: '' }),
  cloudflare: async () => ({ status: 200, body: '{}' }),
  github,
  terraform: async (mode, _env, stdin) => {
    const parsed = JSON.parse(stdin);
    runs.push({ mode, stdin: parsed });
    if (mode === 'plan') {
      return report({
        ok: true,
        mode: 'plan',
        text: 'plan text',
        summary: 'Cloudflare plan for prod: 1 to change.',
        changes: 1,
        missing: next.missing,
        ...(parsed.access === true ? { access: next.access ?? [] } : {}),
      });
    }
    if (next.tokensFail) return report({ ok: false, error: 'the missing service tokens changed' });
    return report({
      ok: true,
      mode: 'tokens',
      minted: [{ name: 'agent moi', id: 'token-1', clientId: 'c0ffee.access', secret: SECRET }],
    });
  },
};

let k: LiveKeeper;
beforeAll(async () => {
  k = await startLiveKeeper(exec, 'keeper-cf-sync');
});
afterAll(async () => k?.stop());

const reset = (n: typeof next) => {
  runs.length = 0;
  gh.length = 0;
  next = n;
  failPut = false;
};

describe('cf-sync', () => {
  it('plans first and holds; the page names the config secrets, the tokens and who signs in', async () => {
    reset({
      missing: { 'agent moi': 'agent moi' },
      access: [{ project: 'riverbend', added: [ALICE], removed: [BOB] }],
    });
    const r = await k.submit('/v1/cf-sync', { input: INPUT });
    expect(r.status).toBe(202);
    expect(runs.map((x) => x.mode)).toEqual(['plan']);
    expect(runs[0]?.stdin).toEqual({
      configs: { router: ROUTER, access: ACCESS },
      state: STATE,
      access: true,
    });
    expect(gh).toEqual([]);
    const page = await k.page(r.body.id as string);
    expect(/<dd id="secrets">([^<]*)<\/dd>/.exec(page)?.[1]).toBe(
      'CF_ROUTER_CONFIG, CF_ACCESS_CONFIG',
    );
    expect(page).toContain('<ol id="tokens"><li><code>agent moi</code></li></ol>');
    const signIn = /<dd id="sign-in">([\s\S]*?)<\/dd>/.exec(page)?.[1] ?? '';
    expect(signIn).toContain(`<li>adds <code>${ALICE}</code></li>`);
    expect(signIn).toContain(`<li>removes <code>${BOB}</code></li>`);
    expect(page).not.toContain('router-config-text');
    // The requester's answers never carry who signs in.
    expect(r.text).not.toContain(ALICE);
  });

  it('a tap makes the token, writes the secrets, starts CI, and hands the secret to the requester alone', async () => {
    reset({ missing: { 'agent moi': 'agent moi' } });
    const r = await k.submit('/v1/cf-sync', { input: INPUT });
    const id = r.body.id as string;
    const approved = await k.approve(id);
    expect(approved.status).toBe(200);
    expect(approved.text).not.toContain(SECRET);
    expect(runs.map((x) => x.mode)).toEqual(['plan', 'tokens']);
    expect(runs[1]?.stdin.expect).toEqual({ 'agent moi': 'agent moi' });
    const writes = gh.filter((c) => c.method === 'PUT').map((c) => c.path.split('/').pop());
    expect(writes).toEqual(['CF_ROUTER_CONFIG', 'CF_ACCESS_CONFIG']);
    expect(gh.at(-1)).toEqual({
      method: 'POST',
      path: '/repos/fryanpan/claude-workspaces-plugin/actions/workflows/cloudflare.yml/dispatches',
    });
    const done = await k.poll(id, r.body.pollToken as string);
    const body = JSON.parse(done.result?.body ?? '{}');
    expect(body.minted).toEqual([
      { name: 'agent moi', id: 'token-1', clientId: 'c0ffee.access', secret: SECRET },
    ]);
    expect(body.dispatched).toBe('cloudflare.yml@main');
    const call = k.keeper.requests.get(id)?.call;
    expect(call?.type === 'cf-sync' && call.input).toBe('');
  });

  it('writes nothing when the tokens cannot be made', async () => {
    reset({ missing: { 'agent moi': 'agent moi' }, tokensFail: true });
    const r = await k.submit('/v1/cf-sync', { input: INPUT });
    await k.approve(r.body.id as string);
    expect(gh.filter((c) => c.method !== 'GET')).toEqual([]);
    const done = await k.poll(r.body.id as string, r.body.pollToken as string);
    expect(done.result?.status).toBe(502);
  });

  it('still hands back a made token when GitHub then refuses the write', async () => {
    reset({ missing: { 'agent moi': 'agent moi' } });
    failPut = true;
    const r = await k.submit('/v1/cf-sync', { input: INPUT });
    await k.approve(r.body.id as string);
    const done = await k.poll(r.body.id as string, r.body.pollToken as string);
    expect(done.result?.status).toBe(502);
    expect(JSON.parse(done.result?.body ?? '{}').minted[0].secret).toBe(SECRET);
    expect(gh.some((c) => c.path.endsWith('/dispatches'))).toBe(false);
  });

  it('is refused with no config, and not held when the plan says nothing about sign-in', async () => {
    reset({ missing: {} });
    const none = await k.submit('/v1/cf-sync', {
      input: JSON.stringify({ configs: {}, state: STATE }),
    });
    expect(none.status).toBe(403);
    reset({ missing: {}, access: [{ project: 'riverbend', added: 'x' }] });
    const r = await k.submit('/v1/cf-sync', { input: INPUT });
    expect(r.held).toBe(false);
    expect(r.text).toContain('did not say who it lets sign in');
  });
});

describe('terraform through the keeper', () => {
  it('a plan runs at once without the sign-in list; an apply is refused with a pointer to CI', async () => {
    reset({ missing: {}, access: [{ project: 'riverbend', added: [ALICE], removed: [] }] });
    const plan = await k.submit('/v1/terraform', { command: 'plan', env: 'prod', input: INPUT });
    expect(plan.status).toBe(200);
    expect(runs[0]?.stdin.access).toBe(false);
    expect(plan.text).not.toContain(ALICE);
    const apply = await k.submit('/v1/terraform', { command: 'apply', env: 'prod', input: INPUT });
    expect(apply.status).toBe(403);
    expect(String(apply.body.error)).toContain('applies run in CI now');
    expect(runs).toHaveLength(1);
  });
});
