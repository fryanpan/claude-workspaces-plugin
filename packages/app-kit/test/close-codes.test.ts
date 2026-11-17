/**
 * How a page's doc handle answers a room closing its socket, in a real
 * workerd: a code from 4400 to 4499 (the doc is gone) stops it for good and
 * it reports the code, any other code reconnects unless `onClose` returns
 * false. Each case has a second page that does reconnect, so "did not
 * reconnect" is read after a reconnect that took as long has been seen.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DocClose, type DocSync, connectDoc } from '../src/client/sync.ts';
import { createDurableRoom } from '../src/do/index.ts';
import { until } from './poll.ts';
import { type LocalWorker, startWorker } from './workerd-harness.ts';

let worker: LocalWorker;
const open: DocSync[] = [];

function connect(
  doc: string,
  user: string,
  onClose?: (e: DocClose) => boolean | undefined,
): DocSync {
  const sync = connectDoc(`${worker.ws}/docs/${doc}/ws?user=${user}&role=edit`, {
    retryMs: 20,
    maxRetryMs: 20,
    ...(onClose ? { onClose } : {}),
  });
  open.push(sync);
  return sync;
}

const get = async (path: string): Promise<string> => (await fetch(`${worker.http}${path}`)).text();
const accepts = async (doc: string, user: string): Promise<number> =>
  Number(await get(`/docs/${doc}/accepts?user=${user}`));
const closeRoom = (doc: string, code: number, reason: string): Promise<string> =>
  get(`/docs/${doc}/close?code=${code}&reason=${encodeURIComponent(reason)}`);

/** Wait for `user` to have connected `n` times and be synced again. */
async function reconnected(doc: string, user: string, sync: DocSync, n: number): Promise<void> {
  await until(`${user} to connect ${n} times`, async () => (await accepts(doc, user)) === n);
  await until(`${user} to be synced again`, () => sync.status() === 'synced');
}

beforeAll(async () => {
  worker = await startWorker('doc-worker.ts', { DOC: 'DocRoom' });
}, 60_000);

afterAll(async () => {
  for (const s of open) s.close();
  await worker?.dispose();
});

describe('a room closing a page’s socket', { timeout: 20_000 }, () => {
  it('with 4410 stops the page for good and reports the code and reason', async () => {
    const doc = 'harborlight-gone';
    const seen: DocClose[] = [];
    const a = connect(doc, 'alice', (e) => void seen.push(e));
    await a.synced;
    a.doc.getText('body').insert(0, 'tide tables');
    await until(
      'the server to hold the edit',
      async () => (await get(`/docs/${doc}/text`)) === 'tide tables',
    );

    expect(await closeRoom(doc, 4410, 'file deleted')).toBe('1');
    await until('alice’s handle to stop', () => a.status() === 'closed');
    expect(a.closedBy()).toEqual({ code: 4410, reason: 'file deleted' });
    expect(seen).toEqual([{ code: 4410, reason: 'file deleted' }]);

    // The control: bob joins later and is closed with an ordinary code, on
    // the same 20ms retry. Once his reconnect is in, alice has had longer.
    const b = connect(doc, 'bob');
    await b.synced;
    expect(await closeRoom(doc, 4000, 'restarting')).toBe('1');
    await reconnected(doc, 'bob', b, 2);
    expect(await accepts(doc, 'alice')).toBe(1);
    expect(a.status()).toBe('closed');
  });

  it('with any other code stops the page when onClose returns false', async () => {
    const doc = 'riverbend-stop';
    const seen: DocClose[] = [];
    const a = connect(doc, 'alice', (e) => {
      seen.push(e);
      return false;
    });
    const b = connect(doc, 'bob', () => true);
    await Promise.all([a.synced, b.synced]);

    expect(await closeRoom(doc, 4000, 'restarting')).toBe('2');
    await reconnected(doc, 'bob', b, 2);
    expect(await accepts(doc, 'alice')).toBe(1);
    expect(a.status()).toBe('closed');
    expect(a.closedBy()).toEqual({ code: 4000, reason: 'restarting' });
    expect(seen).toEqual([{ code: 4000, reason: 'restarting' }]);
    expect(b.closedBy()).toBeNull();
  });
});

describe('closeRoom', () => {
  it('refuses a code a WebSocket cannot send, and a reason over 123 bytes', () => {
    const room = createDurableRoom({
      ctx: { acceptWebSocket: () => {}, getWebSockets: () => [] },
      storage: { read: () => null, write: () => {} },
    });
    expect(() => room.closeRoom('saltmarsh', 1006)).toThrow(RangeError);
    expect(() => room.closeRoom('saltmarsh', 4410, 'x'.repeat(124))).toThrow(RangeError);
    expect(room.closeRoom('saltmarsh', 4410, 'file deleted')).toBe(0);
  });
});
