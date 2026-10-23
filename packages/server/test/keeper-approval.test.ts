/**
 * The keeper end to end: a real listener on loopback, the real `fly`
 * executor running a stand-in `fly` script, a stand-in Cloudflare, and a
 * software passkey registered through the enrollment link.
 *
 * What it shows, each against its control:
 * - a restart of a machine the keeper created runs with no passkey;
 * - creating a project and moving a token are held, run nothing, and run
 *   once the passkey answers on the approval page, and only then;
 * - an assertion for one request approves no other, and a passkey that was
 *   never registered approves nothing;
 * - the clients the deploy scripts and the board server use wait through a
 *   hold and get the approved call's own answer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keeperFetch, keeperFly } from '../src/keeper/keeper-client.ts';
import { keeperExecutors } from '../src/keeper/keeper-exec.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { type KeeperStore, hashToken, openKeeperStore } from '../src/keeper/keeper-store.ts';
import { CfApi } from '../src/share/cf-api.ts';
import { TestPasskey } from './keeper-authenticator.ts';
import { waitFor } from './wait-for.ts';

const FLY_TOKEN = `test-fly-${crypto.randomUUID()}`;
const CF_TOKEN = `test-cf-${crypto.randomUUID()}`;
const tmp = mkdtempSync(join(tmpdir(), 'keeper-approval-'));
const home = join(tmp, 'home');
const calls = join(home, 'fly-calls.log');

/** What the stand-in Cloudflare was asked, and with which token. */
const cfSeen: Array<{ method: string; path: string; auth: string | null }> = [];
const cfFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const path = url.pathname.replace('/client/v4', '');
  cfSeen.push({ method, path, auth: new Headers(init?.headers).get('authorization') });
  if (method === 'POST' && /\/access\/apps$/.test(path)) {
    return Response.json({
      success: true,
      result: { id: 'app-riverbend', aud: 'aud-1', name: 'n', domain: 'd' },
    });
  }
  if (method === 'POST' && /\/policies$/.test(path)) {
    return Response.json({ success: true, result: { id: 'pol-1', name: 'n', decision: 'allow' } });
  }
  return Response.json({ success: true, result: [] });
}) as typeof fetch;

let store: KeeperStore;
let keeper: RunningKeeper;
let base: string;
const key = new TestPasskey();

const flyLines = (): string[] =>
  existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-cw-keeper': '1', ...(init.headers ?? {}) },
  });

const page = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: keeper.origin, ...headers },
    body: JSON.stringify(body),
  });

const askFly = async (args: string[], input?: string) => {
  const res = await api('/v1/fly', { method: 'POST', body: JSON.stringify({ args, input }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** Load the approval page and tap: `verb` the request with `challengeFor`'s challenge. */
async function tap(
  verb: 'approve' | 'deny',
  id: string,
  passkey: TestPasskey,
  challengeFor = id,
): Promise<Response> {
  const html = await (await fetch(`${base}/approve/${challengeFor}`)).text();
  const pageToken = /const pageToken = "([^"]+)"/.exec(html)?.[1] ?? '';
  const c = (await (
    await page(`/v1/requests/${challengeFor}/challenge`, { page: pageToken })
  ).json()) as { challenge: string };
  const assertion = passkey.assert({
    challenge: c.challenge,
    origin: keeper.origin,
    rpId: 'localhost',
  });
  return page(`/v1/requests/${id}/${verb}`, { page: pageToken, ...assertion });
}

const approve = (id: string, passkey: TestPasskey, challengeFor = id) =>
  tap('approve', id, passkey, challengeFor);

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  const flyBin = join(tmp, 'fly');
  writeFileSync(
    flyBin,
    [
      '#!/bin/bash',
      'in=$(cat)',
      '{ printf "ARGS %s\\n" "$*"',
      `  [ "$FLY_API_TOKEN" = "${FLY_TOKEN}" ] && echo "TOKEN ok"`,
      '  printf "STDIN %s\\n" "${#in}"; } >> "$HOME/fly-calls.log"',
      'echo "ran $1 $2"',
    ].join('\n'),
  );
  chmodSync(flyBin, 0o755);
  const dir = join(tmp, 'store');
  mkdirSync(dir, { mode: 0o700 });
  const opened = openKeeperStore(dir);
  if ('error' in opened) throw new Error(opened.error);
  store = opened;
  store.setCredential('fly-org-token', FLY_TOKEN);
  store.setCredential('cloudflare-api-token', CF_TOKEN);
  store.addApp('cw-harborlight');
  keeper = serveKeeper({
    store,
    exec: keeperExecutors({ store, flyBin, home, fetch: cfFetch }),
    port: 0,
  });
  base = `http://127.0.0.1:${keeper.port}`;

  // Register the test passkey through the enrollment link, as Bryan would.
  const token = 'enroll-test-token';
  store.saveEnroll({
    tokenHash: hashToken(token),
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
  });
  const o = (await (await page('/v1/enroll/options', { token })).json()) as {
    challenge: string;
    session: string;
  };
  const reg = key.register({ challenge: o.challenge, origin: keeper.origin, rpId: 'localhost' });
  const done = await page('/v1/enroll', { session: o.session, ...reg });
  expect(done.status).toBe(200);
});

afterAll(async () => {
  await keeper?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('enrollment', () => {
  it('stored the passkey, and the link works only once', async () => {
    expect(store.passkeys().map((p) => p.id)).toEqual([key.credentialId]);
    const again = await page('/v1/enroll/options', { token: 'enroll-test-token' });
    expect(again.status).toBe(403);
  });
});

describe('routine calls', () => {
  it('restarts a machine the keeper created with no passkey, the token only in its environment', async () => {
    const before = flyLines().length;
    const r = await askFly(['machine', 'restart', 'm1', '--app', 'cw-harborlight']);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 0, stdout: 'ran machine restart\n' });
    const lines = flyLines().slice(before);
    expect(lines).toContain('ARGS machine restart m1 --app cw-harborlight');
    expect(lines).toContain('TOKEN ok');
    expect(lines.join('\n')).not.toContain(FLY_TOKEN);
  });

  it('holds the same restart on an app the keeper did not create', async () => {
    const before = flyLines().length;
    const r = await askFly(['machine', 'restart', 'm1', '--app', 'cw-riverbend']);
    expect(r.status).toBe(202);
    expect(flyLines().length).toBe(before);
  });

  it('refuses a call that would print the token, and never runs it', async () => {
    const before = flyLines().length;
    const r = await askFly(['auth', 'token']);
    expect(r.status).toBe(403);
    expect(flyLines().length).toBe(before);
  });
});

describe('held calls', () => {
  it('creating a project runs nothing until the passkey answers, then opens setup on it', async () => {
    const before = flyLines().length;
    const r = await askFly(['apps', 'create', 'cw-saltmarsh', '--org', 'test-org']);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({
      hold: 'project.create',
      approveUrl: `${keeper.origin}/approve/${r.body.id}`,
    });
    expect(flyLines().length).toBe(before);

    const shown = await (await fetch(`${base}/approve/${r.body.id}`)).text();
    expect(shown).toContain('fly apps create cw-saltmarsh --org test-org');
    expect(store.apps()).not.toContain('cw-saltmarsh');

    const ok = await approve(String(r.body.id), key);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 0 });
    expect(flyLines().slice(before)).toContain('ARGS apps create cw-saltmarsh --org test-org');
    expect(store.apps()).toContain('cw-saltmarsh');

    // The setup grant: the new project's secrets go on without another tap,
    // and its machines are routine from now on.
    const secrets = await askFly(
      ['secrets', 'import', '--app', 'cw-saltmarsh'],
      'TUNNEL_TOKEN=test-value',
    );
    expect(secrets.status).toBe(200);
    expect((await askFly(['machine', 'start', 'm2', '--app', 'cw-saltmarsh'])).status).toBe(200);
  });

  it('moving a token to an older app is held, and the page names the secret but not its value', async () => {
    const r = await askFly(
      ['secrets', 'import', '--app', 'cw-harborlight'],
      'RELAY_AT2=test-secret-value',
    );
    expect(r.status).toBe(202);
    expect(r.body.hold).toBe('token.move');
    const shown = await (await fetch(`${base}/approve/${r.body.id}`)).text();
    expect(shown).toContain('RELAY_AT2');
    expect(shown).not.toContain('test-secret-value');
    const ok = await approve(String(r.body.id), key);
    expect(ok.status).toBe(200);
  });

  it("an assertion for one request does not approve another, nor does a stranger's passkey", async () => {
    const a = await askFly(['secrets', 'import', '--app', 'cw-harborlight'], 'A=1');
    const b = await askFly(['secrets', 'import', '--app', 'cw-harborlight'], 'B=2');
    const before = flyLines().length;
    const crossed = await approve(String(a.body.id), key, String(b.body.id));
    expect(crossed.status).toBe(403);
    const stranger = await approve(String(a.body.id), new TestPasskey());
    expect(stranger.status).toBe(403);
    expect(flyLines().length).toBe(before);
    expect(keeper.requests.get(String(a.body.id))?.status).toBe('pending');
    // CONTROL: the right passkey on the right challenge still approves it.
    expect((await approve(String(a.body.id), key)).status).toBe(200);
  });

  it('refuses page posts without the page origin and API calls without the header', async () => {
    const r = await askFly(['volumes', 'create', 'v', '--app', 'cw-riverbend']);
    const id = String(r.body.id);
    expect(
      (await page(`/v1/requests/${id}/challenge`, {}, { origin: 'http://evil.test' })).status,
    ).toBe(403);
    const bare = await fetch(`${base}/v1/fly`, {
      method: 'POST',
      body: '{"args":["apps","list"]}',
    });
    expect(bare.status).toBe(403);
    const tunneled = await api('/v1/fly', {
      method: 'POST',
      body: '{"args":["apps","list"]}',
      headers: { 'cf-ray': 'x' },
    });
    expect(tunneled.status).toBe(403);
    const rebound = await api('/v1/fly', {
      method: 'POST',
      body: '{"args":["apps","list"]}',
      headers: { host: `keeper.evil.test:${keeper.port}` },
    });
    expect(rebound.status).toBe(403);
    expect((await tap('deny', id, key)).status).toBe(200);
  });
});

describe('clients', () => {
  it('keeperFly waits through a hold and returns the approved command', async () => {
    let approveUrl = '';
    const pending = keeperFly(base, ['ssh', 'console', '--app', 'cw-harborlight'], undefined, {
      pollMs: 20,
      onHeld: (h) => {
        approveUrl = h.approveUrl;
      },
    });
    await waitFor(() => approveUrl !== '');
    const res = await approve(approveUrl.split('/').at(-1) as string, key);
    expect(res.status).toBe(200);
    expect(await pending).toMatchObject({ status: 0, stdout: 'ran ssh console\n' });
  });

  it("the share module's CfApi through the keeper: one tap makes the application and its policy", async () => {
    const ids: string[] = [];
    const cf = new CfApi({
      accountId: 'acct1',
      token: '',
      apiBase: `${base}/v1/cloudflare`,
      fetchImpl: keeperFetch(base, { pollMs: 20, onHeld: (h) => ids.push(h.id) }),
    });
    const making = cf.createApp({
      name: 'share',
      domain: 'share-riverbend.example.test',
      sessionDuration: '24h',
    });
    await waitFor(() => ids.length === 1);
    expect(cfSeen.some((c) => c.method === 'POST')).toBe(false);
    expect((await approve(ids[0] as string, key)).status).toBe(200);
    const app = await making;
    expect(app.id).toBe('app-riverbend');
    const policy = await cf.createPolicy(app.id, {
      name: 'allow',
      decision: 'allow',
      include: [{ email: { email: 'alice@example.test' } }],
    });
    expect(policy.id).toBe('pol-1');
    expect(ids.length).toBe(1);
    const posts = cfSeen.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual([
      '/accounts/acct1/access/apps',
      '/accounts/acct1/access/apps/app-riverbend/policies',
    ]);
    expect(posts.every((c) => c.auth === `Bearer ${CF_TOKEN}`)).toBe(true);
  });
});
