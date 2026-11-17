/**
 * A real keeper listener on port 0 with stand-in executors and an enrolled
 * test passkey, for tests that submit a request, read its approval page, tap
 * and poll. Nothing here reaches Cloudflare, GitHub or Fly.
 */
import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintCallerToken } from '../src/keeper/keeper-callers.ts';
import type { Executors } from '../src/keeper/keeper-requests.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { type KeeperStore, hashToken, openKeeperStore } from '../src/keeper/keeper-store.ts';
import { TestPasskey } from './keeper-authenticator.ts';

export interface LiveKeeper {
  keeper: RunningKeeper;
  store: KeeperStore;
  base: string;
  caller: string;
  /** POST (or GET) one agent-API call. */
  submit: (
    path: string,
    body?: unknown,
    method?: string,
  ) => Promise<{ status: number; held: boolean; body: Record<string, unknown>; text: string }>;
  page: (id: string) => Promise<string>;
  /** Tap Approve with the enrolled passkey; the approval page's own answer. */
  approve: (id: string) => Promise<{ status: number; text: string }>;
  poll: (
    id: string,
    pollToken: string,
  ) => Promise<{ status: string; result?: { status: number; body?: string; stdout?: string } }>;
  stop: () => Promise<void>;
}

export async function startLiveKeeper(exec: Executors, name: string): Promise<LiveKeeper> {
  const tmp = mkdtempSync(join(tmpdir(), `${name}-`));
  const dir = join(tmp, 'store');
  mkdirSync(dir, { mode: 0o700 });
  const s = openKeeperStore(dir);
  if ('error' in s) throw new Error(s.error);
  const store = s;
  const caller = mintCallerToken(store);
  const keeper = serveKeeper({ store, exec, port: 0, keeperUid: 4_000_000 });
  const base = `http://127.0.0.1:${keeper.port}`;
  const owner = new TestPasskey();
  const post = (path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: keeper.origin },
      body: JSON.stringify(body),
    });
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

  const api = { 'x-cw-keeper': '1', 'x-cw-keeper-caller': caller };
  return {
    keeper,
    store,
    base,
    caller,
    async submit(path, body = {}, method = 'POST') {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...api },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
      });
      const text = await r.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text);
      } catch {}
      return { status: r.status, held: r.headers.has('x-cw-keeper-held'), body: parsed, text };
    },
    page: async (id) => (await fetch(`${base}/approve/${id}`)).text(),
    async approve(id) {
      const html = await (await fetch(`${base}/approve/${id}`)).text();
      const page = /const pageToken = "([^"]+)"/.exec(html)?.[1] ?? '';
      const c = (await (await post(`/v1/requests/${id}/challenge`, { page })).json()) as {
        challenge: string;
      };
      const signed = owner.assert({
        challenge: c.challenge,
        origin: keeper.origin,
        rpId: 'localhost',
      });
      const r = await post(`/v1/requests/${id}/approve`, { page, ...signed });
      return { status: r.status, text: await r.text() };
    },
    poll: async (id, pollToken) =>
      (await (
        await fetch(`${base}/v1/requests/${id}`, {
          headers: { ...api, 'x-cw-keeper-poll': pollToken },
        })
      ).json()) as never,
    async stop() {
      await keeper.stop();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
