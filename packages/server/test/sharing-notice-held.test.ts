/**
 * The owner's sharing notice reaches the owner even when the review gate
 * holds it.
 *
 * On 23 September the real judge held the fixed notice card three times in
 * three prod flips, so the owner never saw that outside access was off. The
 * lead's decision since: the notice is announced whatever the gate says, and
 * a hold is recorded as passed with the gate's words kept beside it, because
 * a held item is off the owner's queue. This suite runs a judge that holds
 * everything and checks both halves: the log still says it was held, and the
 * item is on the owner's queue and was pushed to an enrolled device.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64urlEncode } from '../src/push-crypto.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const AGENT = {
  id: 'agent-harborlight',
  name: 'Harborlight Agent',
  kind: 'known',
  color: '#888888',
};

describe('the owner notice when the gate holds it', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  const judged: string[] = [];
  const sent: string[] = [];
  const lines: string[] = [];
  let spy: ReturnType<typeof spyOn> | undefined;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'sharing-notice-held-'));
    handle = createServer({
      port: 0,
      dataDir,
      publicBaseUrl: 'https://reviews.example.com',
      shareLinkHosts: ['share.harborlight.test'],
      shareLinkAudience: 'aud-share-app',
      // Holds every item it is shown.
      reviewJudge: async (input) => {
        judged.push(input.item.headline ?? '');
        return { ok: false, reason: 'the stub judge holds everything' };
      },
      pushFetch: async (url) => {
        sent.push(url);
        return new Response(null, { status: 201 });
      },
    });
    base = `http://127.0.0.1:${handle.port}`;
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ]);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const enrolled = await post('/api/push/subscriptions', {
      author: AGENT,
      subscription: {
        endpoint: 'https://push.example.com/s/device-1',
        keys: {
          p256dh: b64urlEncode(raw),
          auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
        },
      },
    });
    expect(enrolled.ok).toBe(true);
  });

  afterAll(async () => {
    spy?.mockRestore();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('logs the hold, and still puts the notice on the queue and pushes it', async () => {
    spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    const off = await post('/api/share/enabled', { enabled: false, reason: 'a precaution' });
    expect(off.status).toBe(200);

    await waitFor(() =>
      lines.some((l) => l.includes('[sharing] owner notice held by the review gate')),
    );
    expect(judged).toContain('External sharing was turned off');
    await waitFor(() => sent.length > 0, { describe: 'a push to the enrolled device' });

    const boards = (await (await fetch(`${base}/workspaces?format=json`)).json()) as {
      boardWorkspaces: Array<{ id: string; name: string }>;
    };
    const unfiled = boards.boardWorkspaces.find((w) => w.name === 'Unfiled');
    expect(unfiled).toBeDefined();
    const queue = (await (
      await fetch(`${base}/workspaces/${unfiled?.id}/review-items`)
    ).json()) as {
      items: Array<{ askedBy: string; review: { headline: string } }>;
    };
    const notices = queue.items.filter((i) => i.askedBy === 'Sharing switch');
    expect(notices.map((n) => n.review.headline)).toEqual(['External sharing was turned off']);
  });
});
