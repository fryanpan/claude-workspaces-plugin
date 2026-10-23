/**
 * What another local process cannot do to the keeper's pages: hold the
 * keeper's origin, use an enrollment link it read, replace a stored passkey,
 * spoil the owner's tap, or deny a request without the owner's passkey.
 *
 * Every case here runs against a real listener. An agent can send any
 * header, so these requests carry the page's own `Origin` throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { type KeeperStore, hashToken, openKeeperStore } from '../src/keeper/keeper-store.ts';
import { TestPasskey } from './keeper-authenticator.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-hardening-'));
const ran: string[][] = [];
const exec: Executors = {
  fly: async (args) => {
    ran.push(args);
    return { status: 0, stdout: 'ok\n', stderr: '' };
  },
  cloudflare: async () => ({ status: 200, body: '{"success":true,"result":[]}' }),
};

let store: KeeperStore;
let keeper: RunningKeeper;
let base: string;
const owner = new TestPasskey();

const openStore = (name: string): KeeperStore => {
  const dir = join(tmp, name);
  mkdirSync(dir, { mode: 0o700 });
  const s = openKeeperStore(dir);
  if ('error' in s) throw new Error(s.error);
  return s;
};

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: keeper.origin },
    body: JSON.stringify(body),
  });

const hold = async (args: string[]): Promise<string> => {
  const r = await fetch(`${base}/v1/fly`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cw-keeper': '1' },
    body: JSON.stringify({ args }),
  });
  expect(r.status).toBe(202);
  return String(((await r.json()) as { id: string }).id);
};

/** The page token an approval page carries, as its own script reads it. */
const pageTokenOf = async (id: string): Promise<string> => {
  const html = await (await fetch(`${base}/approve/${id}`)).text();
  return /const pageToken = "([^"]+)"/.exec(html)?.[1] ?? '';
};

const challengeFor = async (id: string, pageToken: string) => {
  const r = await post(`/v1/requests/${id}/challenge`, { page: pageToken });
  return { status: r.status, challenge: ((await r.json()) as { challenge?: string }).challenge };
};

const signed = (passkey: TestPasskey, challenge: string) =>
  passkey.assert({ challenge, origin: keeper.origin, rpId: 'localhost' });

/** Open a fresh enrollment link, as `keeper enroll` does. */
const openEnroll = (token: string, createdAt = Date.now()) =>
  store.saveEnroll({ tokenHash: hashToken(token), expiresAt: Date.now() + 60_000, createdAt });

const enrollOptions = async (token: string) => {
  const r = await post('/v1/enroll/options', { token });
  return {
    status: r.status,
    body: (await r.json()) as { challenge?: string; session?: string },
  };
};

beforeAll(async () => {
  store = openStore('store');
  store.addApp('cw-harborlight');
  keeper = serveKeeper({ store, exec, port: 0 });
  base = `http://127.0.0.1:${keeper.port}`;
  openEnroll('owner-link');
  const o = await enrollOptions('owner-link');
  const reg = owner.register({
    challenge: o.body.challenge ?? '',
    origin: keeper.origin,
    rpId: 'localhost',
  });
  const done = await post('/v1/enroll', { token: 'owner-link', session: o.body.session, ...reg });
  expect(done.status).toBe(200);
});

afterAll(async () => {
  await keeper?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('the keeper holds its origin on both loopback addresses', () => {
  it('serves the page on [::1] as well as 127.0.0.1', async () => {
    const r = await fetch(`http://[::1]:${keeper.port}/`, {
      headers: { host: `localhost:${keeper.port}` },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Waiting for your passkey');
  });

  it('while it runs, no other listener can take either address', () => {
    for (const hostname of ['127.0.0.1', '::1']) {
      let squatter: ReturnType<typeof Bun.serve> | undefined;
      try {
        squatter = Bun.serve({ hostname, port: keeper.port, fetch: () => new Response('x') });
      } catch {
        // refused, as it should be
      }
      const took = squatter !== undefined;
      squatter?.stop(true);
      expect({ hostname, took }).toEqual({ hostname, took: false });
    }
  });

  it('refuses to start when another process already listens on [::1] at its port', async () => {
    const squatter = Bun.serve({ hostname: '::1', port: 0, fetch: () => new Response('impostor') });
    let started: RunningKeeper | undefined;
    let error: unknown;
    try {
      started = serveKeeper({ store: openStore('squatted'), exec, port: squatter.port as number });
    } catch (err) {
      error = err;
    }
    await started?.stop();
    squatter.stop(true);
    expect(started).toBeUndefined();
    expect(String(error)).toContain('::1');
  });
});

describe('enrollment links', () => {
  it('a link made before this keeper started opens nothing', async () => {
    // An impostor that read the link while no keeper ran would otherwise
    // hold it until the real keeper came back up.
    openEnroll('stale-link', Date.now() - 60 * 60_000);
    expect((await enrollOptions('stale-link')).status).toBe(403);
    store.saveEnroll(null);
  });

  it('the first options call spends the link, and only that caller can finish', async () => {
    openEnroll('raced-link');
    const first = await enrollOptions('raced-link');
    expect(first.status).toBe(200);
    // A second caller with the same link (an agent that read it) gets nothing.
    expect((await enrollOptions('raced-link')).status).toBe(403);
    const second = new TestPasskey();
    const reg = second.register({
      challenge: first.body.challenge ?? '',
      origin: keeper.origin,
      rpId: 'localhost',
    });
    // CONTROL: the caller that asked first still finishes.
    const done = await post('/v1/enroll', {
      token: 'raced-link',
      session: first.body.session,
      ...reg,
    });
    expect(done.status).toBe(200);
    expect(store.passkeys().map((p) => p.id)).toContain(second.credentialId);
  });

  it('refuses a credential id that is already stored, and leaves the stored key alone', async () => {
    const before = store.passkeys().find((p) => p.id === owner.credentialId);
    openEnroll('replace-link');
    const o = await enrollOptions('replace-link');
    const reg = owner.register({
      challenge: o.body.challenge ?? '',
      origin: keeper.origin,
      rpId: 'localhost',
    });
    const r = await post('/v1/enroll', { token: 'replace-link', session: o.body.session, ...reg });
    expect(r.status).toBe(409);
    expect(store.passkeys().find((p) => p.id === owner.credentialId)).toEqual(before);
  });
});

describe('the approval page', () => {
  it("another caller asking for a challenge does not spoil the owner's tap", async () => {
    const id = await hold(['apps', 'create', 'cw-saltmarsh']);
    const ownerPage = await pageTokenOf(id);
    const c = await challengeFor(id, ownerPage);
    expect(c.status).toBe(200);
    // An agent loads the same page and asks for a challenge of its own.
    const agentPage = await pageTokenOf(id);
    expect((await challengeFor(id, agentPage)).status).toBe(200);
    const ok = await post(`/v1/requests/${id}/approve`, {
      page: ownerPage,
      ...signed(owner, c.challenge ?? ''),
    });
    expect(ok.status).toBe(200);
    expect(ran).toContainEqual(['apps', 'create', 'cw-saltmarsh']);
  });

  it('gives no challenge without a page token the keeper served', async () => {
    const id = await hold(['apps', 'create', 'cw-riverbend']);
    expect((await challengeFor(id, '')).status).toBe(403);
    expect((await challengeFor(id, 'a-token-nobody-served')).status).toBe(403);
    // CONTROL: a served page's token gets one.
    expect((await challengeFor(id, await pageTokenOf(id))).status).toBe(200);
  });

  it('denies a request only with the passkey', async () => {
    const id = await hold(['apps', 'create', 'cw-harborlight-two']);
    const pageToken = await pageTokenOf(id);
    const bare = await post(`/v1/requests/${id}/deny`, { page: pageToken });
    expect(bare.status).toBe(403);
    expect(keeper.requests.get(id)?.status).toBe('pending');
    // CONTROL: the owner's passkey denies it.
    const c = await challengeFor(id, pageToken);
    const r = await post(`/v1/requests/${id}/deny`, {
      page: pageToken,
      ...signed(owner, c.challenge ?? ''),
    });
    expect(r.status).toBe(200);
    expect(keeper.requests.get(id)?.status).toBe('denied');
  });
});
