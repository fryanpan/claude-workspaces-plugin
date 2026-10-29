/**
 * A held request from the owner's side and the requester's: the owner can
 * reload the approval page as often as they like, a requester that stops
 * waiting withdraws its request, a path the keeper's user cannot read is
 * refused before anything is held, and a long command is not cut off by the
 * server's idle timeout.
 *
 * Every case runs against a real listener with stand-in executors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { type KeeperStore, hashToken, openKeeperStore } from '../src/keeper/keeper-store.ts';
import { TestPasskey } from './keeper-authenticator.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-lifecycle-'));
/** A user id nobody on this machine has, standing in for the keeper's. */
const KEEPER_UID = 4_000_000;
const ran: string[][] = [];
/** Whether the stand-in Cloudflare takes long to answer. */
let slowCloudflare = false;
const exec: Executors = {
  fly: async (args) => {
    ran.push(args);
    return { status: 0, stdout: 'ok\n', stderr: '' };
  },
  cloudflare: async () => {
    if (slowCloudflare) {
      // timed: past Bun's idle close, which fires on a 4s tick after the 1s idle.
      await new Promise((r) => setTimeout(r, 5000));
    }
    return { status: 200, body: '{"success":true,"result":[]}' };
  },
};

let store: KeeperStore;
let keeper: RunningKeeper;
let base: string;
const owner = new TestPasskey();

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: keeper.origin },
    body: JSON.stringify(body),
  });

const submit = async (args: string[]) => {
  const r = await fetch(`${base}/v1/fly`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cw-keeper': '1' },
    body: JSON.stringify({ args }),
  });
  return {
    status: r.status,
    body: (await r.json()) as { id?: string; pollToken?: string; error?: string },
  };
};

const hold = async (args: string[]) => {
  const r = await submit(args);
  expect(r.status).toBe(202);
  return { id: r.body.id ?? '', pollToken: r.body.pollToken ?? '' };
};

const pageTokenOf = async (id: string): Promise<string> => {
  const html = await (await fetch(`${base}/approve/${id}`)).text();
  return /const pageToken = "([^"]+)"/.exec(html)?.[1] ?? '';
};

const challengeFor = async (id: string, page: string) => {
  const r = await post(`/v1/requests/${id}/challenge`, { page });
  return { status: r.status, challenge: ((await r.json()) as { challenge?: string }).challenge };
};

const approveOn = async (id: string, page: string) => {
  const c = await challengeFor(id, page);
  if (!c.challenge) return c.status;
  const signed = owner.assert({ challenge: c.challenge, origin: keeper.origin, rpId: 'localhost' });
  return (await post(`/v1/requests/${id}/approve`, { page, ...signed })).status;
};

const withdraw = (id: string, pollToken: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/requests/${id}`, {
    method: 'DELETE',
    headers: { 'x-cw-keeper': '1', 'x-cw-keeper-poll': pollToken, ...headers },
  });

beforeAll(async () => {
  const dir = join(tmp, 'store');
  mkdirSync(dir, { mode: 0o700 });
  const s = openKeeperStore(dir);
  if ('error' in s) throw new Error(s.error);
  store = s;
  keeper = serveKeeper({ store, exec, port: 0, keeperUid: KEEPER_UID, idleTimeout: 1 });
  base = `http://127.0.0.1:${keeper.port}`;
  store.saveEnroll({
    tokenHash: hashToken('owner-link'),
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
  });
  const o = (await (await post('/v1/enroll/options', { token: 'owner-link' })).json()) as {
    challenge: string;
    session: string;
  };
  const reg = owner.register({ challenge: o.challenge, origin: keeper.origin, rpId: 'localhost' });
  expect((await post('/v1/enroll', { session: o.session, ...reg })).status).toBe(200);
});

afterAll(async () => {
  await keeper?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

describe('reloading the approval page', () => {
  it('the owner can reload it any number of times, and the newest page approves', async () => {
    const { id } = await hold(['apps', 'create', 'cw-harbor-reload']);
    let page = '';
    for (let i = 0; i < 12; i++) {
      page = await pageTokenOf(id);
      expect(page).not.toBe('');
    }
    expect(await approveOn(id, page)).toBe(200);
    expect(ran).toContainEqual(['apps', 'create', 'cw-harbor-reload']);
  });

  it("pages another process opens do not push out an owner's page that is mid-tap", async () => {
    const { id } = await hold(['apps', 'create', 'cw-riverbend-midtap']);
    const ownerPage = await pageTokenOf(id);
    const c = await challengeFor(id, ownerPage);
    expect(c.status).toBe(200);
    for (let i = 0; i < 12; i++) await pageTokenOf(id);
    const signed = owner.assert({
      challenge: c.challenge ?? '',
      origin: keeper.origin,
      rpId: 'localhost',
    });
    const ok = await post(`/v1/requests/${id}/approve`, { page: ownerPage, ...signed });
    expect(ok.status).toBe(200);
  });

  it('a page pushed out says to load it again, and approves nothing', async () => {
    const { id } = await hold(['apps', 'create', 'cw-saltmarsh-stale']);
    const first = await pageTokenOf(id);
    for (let i = 0; i < 8; i++) await pageTokenOf(id);
    expect((await challengeFor(id, first)).status).toBe(403);
    expect(keeper.requests.get(id)?.status).toBe('pending');
  });
});

describe('a requester that stops waiting', () => {
  it('withdraws its request with its poll token, and the request can no longer be approved', async () => {
    const { id, pollToken } = await hold(['apps', 'create', 'cw-harbor-gone']);
    const page = await pageTokenOf(id);
    const res = await withdraw(id, pollToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('withdrawn');
    expect(keeper.requests.pending().some((r) => r.id === id)).toBe(false);
    expect(await approveOn(id, page)).not.toBe(200);
    expect(ran).not.toContainEqual(['apps', 'create', 'cw-harbor-gone']);
  });

  it('only with the poll token and the API header', async () => {
    const { id, pollToken } = await hold(['apps', 'create', 'cw-riverbend-kept']);
    expect((await withdraw(id, 'not-the-token')).status).toBe(404);
    const bare = await fetch(`${base}/v1/requests/${id}`, {
      method: 'DELETE',
      headers: { 'x-cw-keeper-poll': pollToken },
    });
    expect(bare.status).toBe(403);
    expect(keeper.requests.get(id)?.status).toBe('pending');
    // CONTROL: the owner can still approve it.
    expect(await approveOn(id, await pageTokenOf(id))).toBe(200);
    // And an approved request cannot be withdrawn after the fact.
    expect((await withdraw(id, pollToken)).status).toBe(409);
  });
});

describe('local paths the keeper cannot read', () => {
  it('are refused when the request arrives, before any tap', async () => {
    const tgz = join(tmp, 'data.tgz');
    writeFileSync(tgz, 'not really a tarball');
    chmodSync(tgz, 0o000);
    const args = ['ssh', 'sftp', 'put', tgz, '/data/cw.restored.tgz', '--app', 'cw-harbor'];
    const r = await submit(args);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain('cannot read');
    expect(keeper.requests.pending().some((p) => p.summary.includes(tgz))).toBe(false);
    // CONTROL: the same file, readable, is held for a tap.
    chmodSync(tgz, 0o600);
    expect((await submit(args)).status).toBe(202);
  });
});

describe('a long call', () => {
  // Bun 1.3.10 cuts an idle GET off and leaves a POST alone, so this is a GET.
  it('is answered after the idle timeout has passed', async () => {
    slowCloudflare = true;
    try {
      const r = await fetch(`${base}/v1/cloudflare/zones?name=example.com`, {
        headers: { 'x-cw-keeper': '1' },
      });
      expect(r.status).toBe(200);
    } finally {
      slowCloudflare = false;
    }
  }, 20_000);
});
