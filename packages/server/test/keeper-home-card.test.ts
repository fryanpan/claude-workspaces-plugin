/**
 * A keeper request that waits for Bryan's passkey shows on his Home, and the
 * card's link is the page that lets the waiting command continue.
 *
 * A real keeper on loopback with a stand-in `fly` and a software passkey, and
 * a real board server pointed at it. The keeper client announces each held
 * request to the board server; the server asks the keeper before it files.
 *
 * What it shows, each against its control:
 * - a held `fly` call puts one owner-only card on the cross-board queue,
 *   linking to the keeper's own approval page for that request;
 * - approving on that page lets the waiting `keeperFly` return the command's
 *   output, and the card goes away;
 * - a request the requester withdraws loses its card too;
 * - a post naming a request the keeper does not have files nothing, and one
 *   through the edge, from a browser or with a bad id is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrossReviewQueue } from '../src/cross-review-queue.ts';
import { announceToBoard } from '../src/keeper/keeper-announce.ts';
import { mintCallerToken } from '../src/keeper/keeper-callers.ts';
import { keeperFly } from '../src/keeper/keeper-client.ts';
import { keeperExecutors } from '../src/keeper/keeper-exec.ts';
import { KEEPER_CARDS_FILENAME } from '../src/keeper/keeper-home-card.ts';
import { type RunningKeeper, serveKeeper } from '../src/keeper/keeper-serve.ts';
import { type KeeperStore, hashToken, openKeeperStore } from '../src/keeper/keeper-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { TestPasskey } from './keeper-authenticator.ts';
import { waitFor } from './wait-for.ts';

const tmp = mkdtempSync(join(tmpdir(), 'keeper-home-card-'));
const home = join(tmp, 'home');
const dataDir = join(tmp, 'data');
const key = new TestPasskey();
let store: KeeperStore;
let CALLER = '';
let keeper: RunningKeeper;
let keeperBase: string;
let board: ServerHandle;
let boardBase: string;
const said: string[] = [];

type QueueRow = CrossReviewQueue['items'][number] & {
  askedBy?: string;
  review: { headline?: string; detail?: string; ownerOnly?: boolean };
};

const keeperCards = async (): Promise<QueueRow[]> => {
  const q = (await (await fetch(`${boardBase}/api/review-queue`)).json()) as {
    items: QueueRow[];
  };
  return q.items.filter((i) => i.askedBy === 'Keeper');
};

const page = (path: string, body: unknown) =>
  fetch(`${keeperBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: keeper.origin },
    body: JSON.stringify(body),
  });

/** Open the approval page at `url`, as Bryan's browser on the Mac would, and tap. */
async function approveAt(url: string): Promise<Response> {
  const id = new URL(url).pathname.split('/').at(-1) ?? '';
  const html = await (await fetch(`${keeperBase}/approve/${id}`)).text();
  const pageToken = /const pageToken = "([^"]+)"/.exec(html)?.[1] ?? '';
  const c = (await (await page(`/v1/requests/${id}/challenge`, { page: pageToken })).json()) as {
    challenge: string;
  };
  const assertion = key.assert({
    challenge: c.challenge,
    origin: keeper.origin,
    rpId: 'localhost',
  });
  return page(`/v1/requests/${id}/approve`, { page: pageToken, ...assertion });
}

const linkIn = (detail: string | undefined): string =>
  /\]\((http:\/\/localhost:\d+\/approve\/[A-Za-z0-9_-]+)\)/.exec(detail ?? '')?.[1] ?? '';

const postHold = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${boardBase}/api/keeper/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const flyBin = join(tmp, 'fly');
  writeFileSync(flyBin, '#!/bin/bash\ncat >/dev/null\necho "ran $1 $2"\n');
  chmodSync(flyBin, 0o755);
  const dir = join(tmp, 'store');
  mkdirSync(dir, { mode: 0o700 });
  const opened = openKeeperStore(dir);
  if ('error' in opened) throw new Error(opened.error);
  store = opened;
  CALLER = mintCallerToken(store);
  store.setCredential('fly-org-token', `test-fly-${crypto.randomUUID()}`);
  store.addApp('cw-harborlight');
  keeper = serveKeeper({ store, exec: keeperExecutors({ store, flyBin, home }), port: 0 });
  keeperBase = `http://127.0.0.1:${keeper.port}`;

  const token = 'enroll-home-card-token';
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
  expect((await page('/v1/enroll', { session: o.session, ...reg })).status).toBe(200);

  board = createServer({
    port: 0,
    dataDir,
    keeperHolds: { origin: keeperBase, callerToken: () => CALLER, pollMs: 20 },
  });
  boardBase = `http://127.0.0.1:${board.port}`;
});

afterAll(async () => {
  await board?.stop();
  await keeper?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const announce = () =>
  announceToBoard(boardBase, 'Harborlight Agent', { say: (l) => said.push(l) });

describe('a held keeper request on Home', () => {
  it('shows as an owner-only card whose link approves it, and the command continues', async () => {
    // An already-open Home: its one live stream, read before anything is held.
    const controller = new AbortController();
    const stream = await fetch(`${boardBase}/landing/events:stream`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    let frames = '';
    const reader = stream.body?.getReader();
    void (async () => {
      for (;;) {
        const chunk = await reader?.read().catch(() => undefined);
        if (!chunk || chunk.done) return;
        frames += new TextDecoder().decode(chunk.value);
      }
    })();
    let approveUrl = '';
    const waiting = keeperFly(keeperBase, ['ssh', 'console', '--app', 'cw-harborlight'], 'x', {
      callerToken: CALLER,
      pollMs: 20,
      requester: 'Harborlight Agent',
      onHeld: (h) => {
        approveUrl = h.approveUrl;
      },
      announce: announce(),
    });
    // The open page is told within 1s, and its refetch finds the card.
    await waitFor(() => frames.includes('landing.changed'), {
      timeout: 1000,
      describe: 'landing.changed on the open Home page',
    });
    controller.abort();
    await waitFor(async () => (await keeperCards()).length === 1, {
      describe: 'the keeper card on the cross-board queue',
    });
    const [card] = await keeperCards();
    expect(card?.review.ownerOnly).toBe(true);
    expect(card?.review.headline).toBe('The keeper waits for your passkey to move a credential');
    expect(card?.review.detail).toContain('Harborlight Agent');
    expect(card?.review.detail).toContain('ssh console');
    // The card's link is the keeper's own page for this request.
    const link = linkIn(card?.review.detail);
    expect(link).toBe(approveUrl);
    expect(link.startsWith(`${keeper.origin}/approve/`)).toBe(true);

    const tapped = await approveAt(link);
    expect(tapped.status).toBe(200);
    expect(await waiting).toMatchObject({ status: 0, stdout: 'ran ssh console\n' });
    await waitFor(async () => (await keeperCards()).length === 0, {
      describe: 'the card withdrawn once the request ran',
    });
    expect(said).toEqual([]);
  });

  it('withdraws the card when the requester stops waiting', async () => {
    const waiting = keeperFly(keeperBase, ['ssh', 'console', '--app', 'cw-harborlight'], 'x', {
      callerToken: CALLER,
      pollMs: 20,
      waitMs: 1500,
      announce: announce(),
    });
    await waitFor(async () => (await keeperCards()).length === 1, {
      describe: 'the card for the second request',
    });
    const r = await waiting;
    expect(r.stderr).toContain('withdrawn');
    await waitFor(async () => (await keeperCards()).length === 0, {
      describe: 'the card withdrawn with the request',
    });
  });

  it('keeps each open card’s poll token in a file only this user reads', async () => {
    const mode = statSync(join(dataDir, KEEPER_CARDS_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('a post the keeper does not back', () => {
  const fake = { id: 'a'.repeat(32), pollToken: 'b'.repeat(32), requester: 'Riverbend' };

  it('files nothing for a request the keeper does not have', async () => {
    const res = await postHold(fake);
    expect(res.status).toBe(404);
    expect(await keeperCards()).toEqual([]);
  });

  it('refuses a post through the edge, from a browser, or with a bad id', async () => {
    expect((await postHold(fake, { 'cf-ray': 'x' })).status).toBe(403);
    // A browser is refused by the sign-in write gate before this route, or by it.
    expect([401, 403]).toContain(
      (await postHold(fake, { 'sec-fetch-site': 'same-origin' })).status,
    );
    expect((await postHold({ ...fake, id: '../etc' })).status).toBe(400);
    expect((await postHold({ ...fake, pollToken: 7 })).status).toBe(400);
    expect(await keeperCards()).toEqual([]);
  });
});
