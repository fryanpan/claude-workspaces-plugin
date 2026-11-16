/**
 * The collab core inside a hibernating Durable Object, in a real workerd:
 * two sockets on one doc converge, the doc survives an eviction that keeps
 * the sockets open, a revoke closes a person's sockets, and a view socket's
 * edits change nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DocSync, connectDoc } from '../src/client/sync.ts';
import { until } from './poll.ts';
import { type LocalWorker, hibernate, startWorker } from './workerd-harness.ts';

let worker: LocalWorker;
const open: DocSync[] = [];

const docUrl = (doc: string, user: string, role: string): string =>
  `${worker.ws}/docs/${doc}/ws?user=${user}&role=${role}`;

function connect(doc: string, user: string, role = 'edit'): DocSync {
  const sync = connectDoc(docUrl(doc, user, role), { retryMs: 50, maxRetryMs: 200 });
  open.push(sync);
  return sync;
}

const text = (s: DocSync): string => s.doc.getText('body').toString();
const get = async (path: string): Promise<string> => (await fetch(`${worker.http}${path}`)).text();

beforeAll(async () => {
  worker = await startWorker('doc-worker.ts', { DOC: 'DocRoom' });
}, 60_000);

afterAll(async () => {
  for (const s of open) s.close();
  await worker?.dispose();
});

describe('the kit’s Durable Object adapter in workerd', { timeout: 20_000 }, () => {
  it('syncs one doc between two sockets', async () => {
    const a = connect('harborlight', 'alice');
    const b = connect('harborlight', 'bob');
    await Promise.all([a.synced, b.synced]);
    a.doc.getText('body').insert(0, 'hello');
    await until('bob to see alice’s edit', () => text(b) === 'hello');
    b.doc.getText('body').insert(5, ' world');
    await until('alice to see bob’s edit', () => text(a) === 'hello world');
    expect(await get('/docs/harborlight/text')).toBe('hello world');
  });

  it('keeps both sockets live across a hibernation, on a new instance', async () => {
    const a = connect('riverbend', 'alice');
    const b = connect('riverbend', 'bob');
    await Promise.all([a.synced, b.synced]);
    a.doc.getText('body').insert(0, 'before');
    await until('bob to see the first edit', () => text(b) === 'before');
    const first = await get('/docs/riverbend/instance');

    await hibernate(worker, 'DocRoom', 'riverbend');

    // Neither socket closed: the runtime kept them while the object slept.
    expect(a.status()).toBe('synced');
    expect(b.status()).toBe('synced');
    b.doc.getText('body').insert(6, ' and after');
    await until(
      'alice to see an edit sent to the woken object',
      () => text(a) === 'before and after',
    );
    expect(await get('/docs/riverbend/instance')).not.toBe(first);
    expect(await get('/docs/riverbend/text')).toBe('before and after');
  });

  it('keeps the doc when every socket has gone and the object is evicted', async () => {
    const a = connect('saltmarsh', 'alice');
    await a.synced;
    a.doc.getText('body').insert(0, 'kept');
    await until(
      'the server to hold the edit',
      async () => (await get('/docs/saltmarsh/text')) === 'kept',
    );
    a.close();
    await hibernate(worker, 'DocRoom', 'saltmarsh');
    const b = connect('saltmarsh', 'bob');
    await b.synced;
    expect(text(b)).toBe('kept');
  });

  it('closes a revoked person’s sockets and leaves the others', async () => {
    const a = connect('harborlight-revoke', 'alice');
    const b = connect('harborlight-revoke', 'bob');
    await Promise.all([a.synced, b.synced]);
    let aliceClosed = false;
    a.onStatus((s) => {
      if (s === 'offline') aliceClosed = true;
    });
    expect(await get('/docs/harborlight-revoke/revoke?user=alice')).toBe('1');
    await until('alice’s socket to close', () => aliceClosed);
    a.close();
    b.doc.getText('body').insert(0, 'still here');
    await until(
      'the server to keep bob’s edit',
      async () => (await get('/docs/harborlight-revoke/text')) === 'still here',
    );
  });

  it('drops a view socket’s edits', async () => {
    const editor = connect('riverbend-view', 'alice');
    const viewer = connect('riverbend-view', 'bob', 'view');
    await Promise.all([editor.synced, viewer.synced]);
    viewer.doc.getText('body').insert(0, 'ignored');
    editor.doc.getText('body').insert(0, 'real');
    await until('the viewer to receive the editor’s edit', () => text(viewer).includes('real'));
    expect(await get('/docs/riverbend-view/text')).toBe('real');
  });
});
